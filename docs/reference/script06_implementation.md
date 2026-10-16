# Script 06 — Global Grin Health: implementation

> **Covers code as of:** 2026-09-26 · **Last verified:** 2026-09-26, PARTIAL — *Peer counts* only,
> written against `scripts/lib/06_collector.py` the day of the fix, repair + fetch filter run in a
> scratch SQLite test, the bug's numbers read from a live `get_peers` on the NY node; 2026-09-25, PARTIAL — *When the node
> stops answering* only, written against `tiny-explorer-server.js` + `public/js/tiny-explorer.js`
> the day it landed, behaviour run in a scratch e2e (20 checks); 2026-09-18, PARTIAL — the slatepack
> "two facts" item 1 was re-read against grin-wallet v5.4.1 `controller/src/command.rs` and
> confirmed by a live plaintext-S1 / sealed-S2 test the same day; 2026-09-10, PARTIAL — three sections
> only: *Tool 3 — Node Reachability Checker* was rewritten against `lib/node-check.js`,
> `tiny-explorer-server.js`, `public/js/node-check.js` and `public/node-check.html` on the day
> the second leg landed; *Peer map — self-hosted basemap* was read (2026-09-09) against
> `web/06_stats_map/stats/index.html` **and against the committed `assets/countries-*.json`
> themselves** (the three dateline seams below are measured from the data, not inferred);
> *Tool 2 — Wallet Checker* was read (2026-09-10) against `lib/wallet-tor.js`,
> `tiny-explorer-server.js`, `public/wallet-check.html`, `public/js/wallet-check.js`,
> `public/js/tiny-explorer.js`, `test/test-probe-copy.js` and
> `scripts/lib/06d_tiny_explorer.sh`, when the probe default was flipped;
> *Tool 4 — Mining Calculator* was read (2026-09-10) against `public/mining.html`,
> `public/css/tiny-explorer.css`, `public/js/tiny-explorer.js` and `test/test-mining.js`
> when payback and the two-column form landed — that section only, not the rest of Tool 4's
> history;
> *Option D addendum — the crawl surface* was written (2026-09-10) against
> `tiny-explorer-server.js`, `public/robots.txt`, all eleven `public/*.html` shells,
> `public/css/tiny-explorer.css`, `test/test-seo.js` and the nginx vhost in
> `scripts/lib/06d_tiny_explorer.sh` — the sitemap, robots and JSON-LD output in it were
> read from the handlers ACTUALLY RUN, not from the source.
> The rest of this doc is still never systematically verified.
> **Product code last changed:** 2026-09-26 — `scripts/lib/06_collector.py` (**peer counts windowed by `last_connected`**: the collector read a nonexistent `last_seen` and stamped every stored Healthy peer "now", inflating every week/month/year node count; one-off stamp repair); 2026-09-25 — `web/06d_tiny_explorer/` (**node circuit breaker + serve-stale** for archive-node compaction stalls; busy node → 503 not 404; `getLatest` no longer caches `[]`); 2026-09-18 — `web/06d_tiny_explorer/public/` (Slate Inspector: per-role next-move guides with wallet commands, encryption rule corrected — every grin-wallet reply is sealed; Proof Verifier: proof is automatic with `send -d`, standard flow only, "not on chain" no longer reads as "never confirmed"); 2026-09-10 — `web/06d_tiny_explorer/` (**crawl surface**: generated `/sitemap.xml` + `/robots.txt` routes, `noindex, follow` on block/kernel/output and the 404, `WebApplication` JSON-LD for the six tools, homepage `<h1>`, duplicate `<h1>` removed from the three entity shells, analytics on the 404, `/mining` description updated for payback); 2026-09-10 — `web/06d_tiny_explorer/` (mining calculator: **capital payback card + hardware-cost input**, setup form rebuilt as two columns, break-even sub-label explains its scale invariance); 2026-09-10 — `scripts/lib/06d_tiny_explorer.sh` + `web/06d_tiny_explorer/` (**Wallet Checker Tor liveness probe now ON by default for a new install**: two-sided config read-back, `(installs tor)` prompt warning, config-neutral baseline page copy; **prompt catch-all now keeps the default instead of naming `false`, and `read` at EOF declines** — both latent until the flip); 2026-09-10 — `web/06d_tiny_explorer/` (node-check second leg: P2P 3414/13414 TCP probe, composed two-leg verdict, network picker; **assumed API endpoint flipped from 3413 to https/443 for host names**, retry inverted); 2026-09-09 — `web/06d_tiny_explorer/` (mining calculator: number-of-units multiplier, `/api/price` fallback, blocker copy, first test suite for the money maths); 2026-09-09 — `web/06_stats_map/stats/index.html` (antimeridian seam repair, land+mesh basemap, city-label cull, trimmed maxBounds, Vietnam flag fill + East Sea islands + Saigon relabel); 2026-09-09 — `scripts/lib/06d_tiny_explorer.sh` (tor install + probe status row) and `web/06d_tiny_explorer/` (probe-aware page copy); 2026-09-09 — `web/06d_tiny_explorer/` (node-check assumed-port retry); 2026-09-08 — `web/06d_tiny_explorer/public/` (mining calculator presets); 2026-09-07 — `scripts/lib/06d_tiny_explorer.sh` (deploy/restart lifecycle); 2026-09-06 — `scripts/06_global_grin_health.sh`, `scripts/lib/06*`, `web/06_stats_map/`, `web/06d_tiny_explorer/`
> 06d has a test suite (`web/06d_tiny_explorer/test/`, 232 assertions across 6 suites — count read from `node test/run-all.js` on 2026-09-10), but it tests the code, not this doc.
> **Scope:** what the running code does — the Tiny Explorer (06d) and its tools, the peer map and collector fixes, the self-hosted basemap as built — plus the Build notes. The plans and rationale are `script06_design.md`. Headings are by subject, not by date; the dated detail inside each section is evidence (what was measured, when).

**Status:** the work below is **built and verified locally** (jsdom, vm harnesses, scratch end-to-end); **nothing in the six-tool expansion has been served by the real server behind the real nginx vhost** (see *Open items*).

## What shipped

### Option D — Tiny Explorer (`scripts/lib/06d_tiny_explorer.sh`)

A **stateless, mainnet-only** single-block explorer that owns the pool deep-link
surface (2miner links `https://<domain>/block/<height>`, e.g. `scan.grin.money`).
Additive to option C (the grincoin clone stays a pristine upstream clone).

**Why it exists / why "tiny":** GrinScan's weight is its SQLite store + crawler +
price/rollup/SSE machinery. Tiny Explorer drops all of it — a thin Express proxy in
front of an **archive** node with small in-memory TTL caches. No DB, no daemon, no
migration on server moves, survives a node rebuild. A couple of cached outbound
fetches (Gate.io, nonlogs.io, world.grin.money) each fail soft.

**Naming (renamed from the original "mini_explorer" plan for clearer file mgmt):**
- Web app: `web/06d_tiny_explorer/` (`tiny-explorer-server.js`, `package.json`, `public/…`;
  frontend `public/js/tiny-explorer.js` + `public/css/tiny-explorer.css` — all product-prefixed.
  `package.json` keeps its npm-mandated name; the generated VPS `config.json` is namespaced by
  its dir `/opt/grin/tiny-explorer/` + the `TINY_EXPLORER_CONFIG` env var)
- Deploy lib: `scripts/lib/06d_tiny_explorer.sh`, functions prefixed `tinyx_`
- Server app dir (VPS): `/opt/grin/tiny-explorer/` (`app/` + `config.json` + secrets)
- systemd service: `grin-tiny-explorer` (mainnet only, env `TINY_EXPLORER_CONFIG`)
- nginx vhost: `/etc/nginx/sites-available/tiny-explorer`; rate zone **`tinyx_api`**
  in `/etc/nginx/conf.d/script06d-rate-limit.conf` (unique — never reuse `grinscan_api`)
- Localhost port **8471** (127.0.0.1 only; nginx is the public edge)

**Routes:** `/` (index — 8-stat strip + latest 20), `/block/:ref` (the deep-link
target; SEO injected server-side), `/api/tip`, `/api/latest?n`, `/api/block/:ref`,
`/api/stats`, `/healthz`, `/js/analytics.js` (GA4), static, then a catch-all **404**
(keeps HTTP 404 for pool/bots) serving the custom `404.html` with operator-configurable
`fallback_explorers` cards (default Grincoin.org + GrinScan).

**Correctness pins (verified E2E against a live mainnet node on this box, 2026-07-07):**
- nginx `location /` proxies ALL paths incl `/block/<height>` — nothing intercepts it.
- **u64 nonce carried as a string.** The RAW JSON-RPC text is regex-quoted BEFORE
  `JSON.parse` (which rounds past 2^53). **Must use a regex LITERAL** (`BIGINT_FIELD_RE`)
  — the `new RegExp(\`…\\s…\`)` template form silently drops the `\` in `\s`/`\d`,
  leaving the nonce unquoted and rounded. This bit during build; unit-proven fixed.
- Result unwrap always via `unwrapResult()`; Basic-Auth `grin:<secret>`.
- Runs as `www-data`; node secrets copied www-data-owned chmod 600 (GrinScan model).

**Node-peers card fallback (operator request):** primary = distinct nodes over 30d
from `world.grin.money/api/countries` → `timeframes.month.mainnet.sampled_from`
(cached ~1h), labelled "Node peers · 30d". If that host is unreachable/empty, falls
back to THIS node's live `get_connected_peers` count, relabelled **"Local node peers ·
now"** (`peers_source` = `world30d` | `local`). Both fail soft (card hides on none).

**Secret self-heal:** `grin_sync_tiny_explorer` added to `scripts/lib/grin_node_secrets.sh`
and registered in `grin_secrets_sync_all` — a node rebuild re-copies the mainnet
secrets into `/opt/grin/tiny-explorer/` and restarts `grin-tiny-explorer`. `tinyx_configure`
calls `grin_install_secret_sync`.

**Config extras:** `domain`/`base_url` (prompted, never hardcoded), `slogan` (blank →
baked default), `peers_stats_url` (default `https://world.grin.money`), `ga4_measurement_id`
(sample shown in the prompt: `G-05D6ERFRVW`), `fallback_explorers`.

**Frontend:** single token-driven CSS (`css/tiny-explorer.css`) — light = warm paper +
gold; dark = deep blue-black "cyberworld" cyan-grid + neon glow; sun/moon toggle stamps
`data-theme` on `<html>`, persists to localStorage, respects `prefers-color-scheme` +
`prefers-reduced-motion`. Logo/favicon = `grin_orange.svg`. Stat-card labels use a
dedicated high-contrast `--label` token (bright/glow on dark, heavy/dark on light) so
headlines read clearly on either ground. Footer carries the Saigon ❤ + yellow-flag SVG.
Full kernel/input/output detail on the block page (kernel excess framed as the txid
equivalent) + collapsible raw `get_block` JSON.


### When the node stops answering — circuit breaker + serve-stale

**Why:** an archive node on a small box can hold its API shut for **hours** while grin runs
chain compaction. Compaction holds the txhashset write lock, and on archive it used to walk every
header since genesis. That walk is the upstream bug `scripts/patches/grin/0001` fixes (see
`scripts/patches/grin/README.md`). Diagnosed on scan.grin.money 2026-09-25: 8–10 h episodes,
roughly daily. Before this change every page view opened fresh node connections that each waited
out the full 10 s timeout, ~90 sockets piled up in CLOSE-WAIT on :3413, and visitors got 502s the
whole time. The explorer can't fix the stall. It can stop making it worse and stay readable.

**Circuit breaker** (one choke point: `nodeRpc`, under `foreignApi`/`ownerApi`):
- The first **transport** failure (timeout, refused, reset, hang-up) opens it. For
  `node_busy_backoff_ms` (default 30 s) every node call fails fast with code `NODE_BUSY` and
  opens no connection.
- After the backoff exactly **one** real request goes through as a probe. Success closes the
  breaker, failure re-opens it. So a stalled node sees at most one connection per ~40 s from us.
- An RPC-level answer (`Err`, JSON-RPC error, unparseable body) is still an answer and never
  trips it. A `NotFound` must keep meaning "not found".
- Identical calls already in flight share one connection (key = url + method + params).

**Serve-stale** (bounded by `stale_max_ms`, default 24 h):
- `/api/stats` replays its last good body with `stale: true`, `as_of`, `busy_since`. The price
  is refreshed (it needs no node), and `mempool` is nulled because it is live-only.
- `/api/latest` returns the last good table with an `X-Tinyx-Stale: <iso>` header. The body
  stays a plain array because every client reads it as one.
- `/api/tip` returns the last tip with `stale`/`as_of`. The block page **does not compute
  confirmations from a stale tip**, since a frozen tip under-counts them. Kernel and output
  confirmations come from a fresh `getTip()` only and are omitted while the node is busy.
- `/api/sync` compares the stale tip. That is honest: a node stuck in compaction applies no
  blocks, so its frozen height is its height.
- `/api/block|kernel|output` answer **503 `{error:'node busy'}` + `Retry-After`**. A busy node
  used to make `fetchBlockLive` return null → **404**, which sent valid pool permalinks to the
  404 page. The body is what separates this 503 from nginx's `tinyx_api` limiter 503.
- `getLatest` no longer caches `[]` when every block fetch failed. That wiped the table
  serve-stale needs.

**Page:** Tip-height sub-line reads `node busy · as of HH:MM` (tooltip has `busy_since`). The
table footer reads `Node busy · blocks as of HH:MM`. Block/kernel/output pages say the node is
busy instead of "Server error 503".

**Known edge:** the first response after recovery is the probe's, so its `mempool` is blank for
one poll (`get_pool_size` failed fast while the probe was in flight).

**Verified 2026-09-25** by a scratch e2e (not committed — it opens sockets, which
`test/run-all.js` promises not to): the real server against a fake node switched to "stalled".
20 checks: 0 node requests during an open-breaker burst of 19 API calls answered in ~115 ms; one
probe per backoff; 503 not 404 for a block; recovery; 8 identical block requests → one
`get_block` + one `get_header`. **NOT VPS-tested.**

### Option D addendum — Slate Inspector (`/slate`)

**Built 2026-07-23 (branch `add-ons`). NOT VPS-tested.** Verified locally: 83 assertions
green (37 decoder + 13 BIP-173 bech32 vectors + 33 end-to-end page tests in jsdom).

#### What it is
A **read-only, keyless** slatepack reader on `scan.grin.money/slate`. Paste or drop a
slatepack → see amount, fee, which transaction step it is on, and mainnet-vs-testnet.
Purpose is education + **verification**: confirm a slatepack says what the sender promised
*before* acting on it.

It does **not** send, receive, sign, finalize, broadcast, or hold keys. That is phase 2 and
needs a real wallet backend (051 owner-API, or building 055 for real).

#### Why it lives in 06d and not elsewhere
Same mental model as the existing `/block`, `/kernel`, `/output` deep links — paste an
opaque Grin artefact, get a human-readable readout. Reuses `sendEntityPage()` + `_pageMeta`.

**But unlike every other page here it makes NO node call.** A slatepack is a *pre-broadcast*
artefact, so it is decoded entirely in the browser; the pasted slate never reaches the
server. Consequence: it works identically for mainnet and testnet slatepacks with **zero
extra infrastructure** — no testnet node, no second explorer instance.

#### Wire format (verified against grin-wallet source, not assumed)
| Layer | Detail |
|---|---|
| Armor | `BEGINSLATEPACK.` + payload + `. ENDSLATEPACK.`; SimpleBase58Check = first 4 bytes of `SHA256(SHA256(bin))` prepended, then standard bs58. Space every 15 chars, newline every 200 words. **No compression at any layer** (no deflate/zlib). |
| Envelope | version 2 B (major,minor) → mode 1 B → opt flags 2 B (`0x01` = sender present) → `bytes_to_payload` u32 4 B → optional sender (u8 len + **bech32 STRING**) → payload (`write_bytes` = u64 len + bytes) |
| Payload | **SlateV4 BINARY** (`VersionedBinSlate`), never JSON in practice |
| SlateV4Bin | `ver` 4 B (two u16) → `id` 16 B UUID → `sta` **1 B u8 0–6** → `off` 32 B → opt-status byte (`0x01` num_parts, `0x02` amt, `0x04` fee, `0x08` feat, `0x10` ttl) → sigs → opt-structs → feat_args |

Two facts that shape the whole design:

1. **Mode 1 (encrypted) is opaque by design.** The wallet *moves* the sender out of the
   header into the age-encrypted metadata. A keyless reader recovers **only** version +
   mode — no sender, no network, no amount, **not even the step**. The default
   `grin-wallet send -d <addr>` produces mode 1, so the inspector is fully useful only for
   the **manual (no `-d`) plaintext flow** — and only for its FIRST slatepack: `send` /
   `invoice` always put the author's address in the header (sender index `Some(0)`), and
   `receive` / `pay` always seal the reply to that header address
   (`controller/src/command.rs`, `ret_address = slatepack.sender`, verified v5.4.1). So an
   S2/I2 from grin-wallet is mode 1 regardless of how S1/I1 was made; a plaintext reply can
   only come from a wallet that omits its own address. Confirmed by a live test 2026-09-18
   (plaintext S1 read fine, its S2 came back sealed). The sender reads a sealed reply with
   `grin-wallet unpack`. This is a privacy property, not a gap.
2. **SlateV4 carries NO chain/network/genesis field.** Confirmed in source. This is the
   structural reason a testnet slate can be signed by a mainnet wallet and only fails at
   broadcast. The single network signal is the **bech32 HRP of the sender address**
   (`grin` = mainnet, `tgrin` = testnet) — and it survives into the bytes only because
   `SlatepackAddress` serialises as the bech32 *string*, not the raw 32-byte key.

#### Implementation notes
- `public/js/slatepack-decode.js` — zero-dependency decoder. Works in browser and Node
  (test harness) via `globalThis.crypto.subtle`. Exports `decodeSlatepack()`.
- **u64 → BigInt everywhere.** `amt`/`fee` are u64 nanogrin; a JS Number silently rounds
  past 2^53 — the same class of bug as the PoW `nonce` in `tiny-explorer-server.js`.
- Only the slate **head** is parsed (through the optional-field block). `sigs`/`coms`/
  `proof` are deliberately **not** walked — they add no readable value and their variable
  shapes are the likeliest parse failure. Envelope facts stay trustworthy even if the slate
  body fails (→ "partially readable" render).
- Fee is masked as grin `FeeFields` (low 40 bits = fee, bits 40–43 = fee_shift). Safe for
  the older plain-u64 form too, since real fees are far below 2^40.
- bech32 validation is a port of `web/093_transporter/server.js` (`bech32Decode`), which is
  the repo's existing proven implementation. Passes all 13 official BIP-173 vectors.
- **`WebCrypto` needs a secure context.** On plain HTTP `crypto.subtle` is absent → the
  checksum is reported "not verified" rather than failing the decode.

#### Theme
**Superseded 2026-09-05 (review R2).** `/slate` originally shipped as a self-contained
dark-only cyberpunk page that did **not** import `tiny-explorer.css`. That was defensible
while it was the only tool; with six tools it made `/slate` the one page with no Tools
dropdown, no search, no theme toggle, and no light rendering — a dead end that stayed dark
for a light-theme visitor.

It is now on the shared chrome: `slate.html` carries the same `tx-header` / `tx-footer` /
6-item dropdown as every other tool page and loads `tiny-explorer.css` **first**, with
`css/slate.css` reduced to an overlay for the `sp-*` widgets alone (drop zone, the two
buttons, and everything `js/slate-ui.js` writes into `#out`). Those class names are a
contract with that script, which was not touched — the page decodes exactly what it did.
Every colour in the overlay resolves through a shared token, plus four `--sp-*` verdict
colours declared per theme; `slate-ui.js` inlines `var(--sp-green)` for a valid checksum,
so that token name must keep existing.

`_pageMeta.slate` no longer sets `theme: '#06070d'` — with the page following the light/dark
toggle, a pinned dark `theme-color` would paint the browser chrome dark around a light page.
`injectGlobals()` still strips the shell's own `title`/`description`/`theme-color` so the
injected block is the single source of truth, and `meta.theme` remains available for any
page that genuinely needs its own colour (none currently do).

#### Wiring
- `app.get('/slate')` → `sendEntityPage(res, 'slate.html', 'slate')` (express.static would
  only answer `/slate.html`). Self-canonical `/slate`.
- `searchTarget()` routes any input containing `BEGINSLATEPACK` to `/slate?s=…`
  (query-carried when ≤3000 chars, else just the page).
- **Discoverability** (three entry points — the tool has no node data behind it, so it gets
  no natural slot in the stat grid or block table and must be signposted deliberately):
  1. `.tx-toolbtn` header link on **every** page (index/block/kernel/output/404) — label
     collapses to the icon under 700px so it never crowds the search box.
  2. `.tx-cta` banner on the home page, directly under the stat grid.
  3. The "What can you check here?" bullet (collapsed `<details>` — supporting, not primary).
- No nginx change needed — the vhost already proxies all paths. No new rate-limit zone.

#### Known gaps / next
- **Not yet tested against a slatepack produced by a real `grin-wallet`.** All fixtures are
  built from the spec by our own encoder, so a shared misreading of the spec would not be
  caught. First VPS action: decode a real testnet slatepack and confirm the readout.
- Optional phase-1b: take the kernel excess from a finalized (S3/I3) slate and reuse the
  existing `/kernel/<excess>` lookup to answer "did it actually confirm?" — **mainnet-only**,
  must show "unavailable for testnet" rather than a misleading not-found.
- Phase 2 (wallet-backed guided send/receive/finalize + age decryption) remains blocked on a
  wallet decision: 051 owner-API, or actually building 055 (currently a COMING-SOON stub).

### Option D addendum — Tools hub + Emission page + mempool + sparklines

**NOT VPS-tested.** Verified locally: 18 jsdom assertions green (Tools dropdown open/close/aria,
mempool render+hide, both sparklines, emission live figures + calc). `node --check` clean on
server + frontend; CSS braces 201/201.

**Why:** the Slate Inspector proved out the "utility beside the explorer" idea; a single CTA
banner + lone header button doesn't scale to two+ tools. This consolidates all tool discovery
into one **Tools hub** and adds the second tool (Emission).

#### Homepage reorg (operator-directed order)
`header → "Why Grin stands out" + "What can you check here?" (education, moved ABOVE the stat
grid) → 9-card stat grid → Tools card-grid section → Latest Blocks`. The old `.tx-cta` banner is
gone; its content is now the first `.tx-tool-card`.

#### Tools hub
- **Header `🧰 Tools ▾` dropdown** replaces the per-page `.tx-toolbtn` Slate link on **all five**
  shells (index/block/kernel/output/404) + emission. Self-contained CSS menu; `initTools()` (run
  from `initChrome`, every page) toggles `hidden` + `aria-expanded` + `.open`; closes on
  outside-click / Escape. Two items: Slate Inspector, Emission & Supply.
- **Home `.tx-tools-section`** = responsive `.tx-tool-card` grid (cyan→magenta left edge, reused
  from the retired CTA). Scales to N tools via `repeat(auto-fit, minmax(260px,1fr))`.
- Theme: hub + section use `tiny-explorer.css` (light/dark toggle). Since review R2 `/slate`
  does too — see *Theme* above; `slate.css` is now an `sp-*` overlay, not a separate scene.

#### Emission & Supply page (`/emission`)
Second tool. **Node-light, no DB**: a static explainer served via `sendEntityPage('emission.html',
'emission')` (added to `_pageMeta` + self-canonical list); `initEmission()` makes **one**
`/api/stats` call for live supply (`height×60`), tip height, and annual inflation
(`60×1440×365 / supply`, trends toward 0). Includes a "verify it yourself" `height × 60` calculator
(prefilled to tip), a Grin-vs-BTC-vs-gold-vs-fiat comparison table, and a "why constant emission"
explainer. `data-page="emission"` dispatches in the DOMContentLoaded init.

#### Mempool card
New 9th stat card. Server `/api/stats` gains `mempool` from Foreign `get_pool_size` (`poolCache`
30 s TTL, fails soft to `null`). Frontend renders `N tx(s)`; card hides when `null` (same pattern
as the peers card).

#### Sparklines (stat enhancement, not a tool)
Inline SVG trend lines inside the Hashrate + Difficulty cards. **Zero new endpoint / zero stored
history** — `renderSparklines()` derives per-block Δdifficulty and hashrate
(`Δtd×42/Δt/16384`) from the `/api/latest` series already fetched for the block table, and paints
a normalised `<polyline>` (colour from CSS). Needs ≥3 blocks; degrades to empty otherwise.

### Tool 1 — Mining Calculator (`/mining`, phase 1)

`GPS_yours / GPS_network × 86400` per day. The homepage already ships this: `/api/stats`
computes `g1_per_day` for a fixed 1.2 G/s IPOLLO G1 mini
(`tiny-explorer-server.js`, `getDailyAvgHashrate()` basis). The calculator is that same
line with the `1.2` replaced by an input, plus the `price_usd` already in the payload.

- **One server change:** expose the day-average basis. `/api/stats` currently returns only
  the *derived* `g1_per_day`, not `dailyHr`, so the client would have to invert
  `1.2 / g1_per_day × 86400` to recover it. Add `hashrate_gps_24h` to the response instead.
- **Inputs:** your hashrate (G/s), pool fee %, power draw (W), electricity cost. **Outputs:**
  per day/week/month, USD at the live price, and a **break-even GRIN price** for the power cost.
- Does *not* recompute hashrate — it consumes the server's figure, so the
  `difficulty / 60` trap (see *Grin Hashrate Formula*, CLAUDE.md) cannot be reintroduced here.
- Label every figure an **estimate at the current difficulty**. Difficulty moves; a
  calculator that reads as a promise is the failure mode.

**Hardware and electricity presets (2026-09-08).** Two `<select>`s were added — a rig picker
(iPollo G1 Mini / G1, 11 NVIDIA and 7 AMD GPUs) and an electricity-rate
picker grouped by region — North America (US ≈ $0.17/kWh, US industrial ≈ $0.08, Canada ≈ $0.13,
Quebec/Manitoba hydro ≈ $0.06), Europe (Germany ≈ $0.40, EU average ≈ $0.30, Norway/Sweden ≈ $0.12),
Asia-Pacific (China ≈ $0.08, Australia ≈ $0.25) and a low-cost hosting band (Iceland / Paraguay /
Kazakhstan hydro ≈ $0.05, or free). Three rules hold them honest:

- **A preset writes into the number field; it is never a second input.** `miningEstimate()`
  still reads only the visible boxes, so there is no path where the dropdown and the figure
  below it disagree and the money number follows the invisible one. Typing over a filled-in
  figure snaps its select back to `Custom`, so the dropdown can never name a rig whose numbers
  have left the screen.
- **Every row names where its numbers came from, and a row with no source does not ship.**
  ASIC rows are the manufacturer's published spec — **G1 Mini 1.2 G/s / 120 W, G1 36 G/s /
  2800 W** (both confirmed by their own efficiency ratings, 100 and 77.8 J/GPS). They shipped
  wrong on 2026-09-08 as `G1 1.2 / 970` and `G1 Mini 0.3 / 240`: the Mini's hashrate had been
  put on the G1 and both wattages invented. **The repo already contained the correction** —
  `tiny-explorer-server.js`'s `g1_per_day` comment and the homepage tooltip both say *IPOLLO
  G1 mini (1.2 G/s)*, so an in-repo `grep` would have caught it before any web source did.
  Check the product's own strings first. The picker therefore defaults to the **G1 Mini**, which
  keeps the form's opening figures identical to the homepage's `g1_per_day` basis; defaulting
  to the G1 would open the page on a 2.8 kW farm box. GPU rows are whattomine's Cuckatoo32 table
  (`whattomine.com/coins/324-grin-cuckatoo32/gpus`), cited in the hint line under the form —
  they started as guesses and were replaced wholesale on 2026-09-08, which moved the RTX 4090
  from an invented 2.2 G/s to a sourced **1.40**, a 57% error that would have overstated a
  miner's income by the same margin. Cross-checked against minerstat the same day: the two
  disagree by **up to ~25%** on some cards (RTX 3080 0.90 vs 1.16, RTX 2080 Ti 0.68 vs 0.85)
  and whattomine sits at the **conservative** end of the spread — the right bias for an income
  estimate, and the reason to keep one source rather than average two. Do not "improve" a row
  by splitting the difference; that produces a number no source stands behind. Two Innosilicon G32 rows were dropped the same day for
  having no defensible figure at all; `Custom` covers the gap without putting an invented
  number in front of a miner. **A claim that the cited source contradicts goes too** — the
  optgroup said Cuckatoo32 needs ≥ 11 GB VRAM, and whattomine lists 6 GB cards, so the claim
  came out rather than being argued for. The electricity rows are rough regional averages converted
  to USD, not quotes, and are rounded hard for that reason — the three cheapest hosting
  countries share **one** `$0.05` row rather than three, because country-level precision is not
  something this page has. All of them live as
  `data-gps` / `data-watts` / `data-kwh` attributes on the `<option>`s in `mining.html` — one
  place to correct, visible in view-source, no JS table to keep in step.
- **Defaults are now a real setup, not zeros.** The page opens on a G1 at the US average rather
  than 970 W at $0.00/kWh — a $0 power cost renders as pure profit, which is the one answer a
  mining calculator must not give by default.

Layout: one field per line (`.tx-mine-row`, a 190px label column) rather than the old
four-across grid, because the rows now carry a note line each.

**Power draw is a rate, and it was read as a daily total.** Nothing on screen converted it: the
*Power cost / day* card shows the money, never the energy. The field is now labelled
`(W, continuous)` and carries a live line — *"120 W running 24/7 is 2.9 kWh a day"* — recomputed
in `render()`. A unit that only appears in a formula caption (`watts ÷ 1000 × 24 × per kWh`) is a
unit the reader has to reverse-engineer; state it next to the input instead. The wattage goes
through its own `fmtWatts`, not `fmtGrinAmt`: that formatter picks decimals by magnitude for a
GRIN *balance*, which rendered the same sentence as "120.00 W" on one preset and "2,800 W" on
the next. The one line whose whole job is to make a unit unambiguous cannot be inconsistent
about the number in it.

**The two basis cards are the page's error surface.** `/api/stats` was fetched as
`r.ok ? r.json() : null` and then `if (!s) return`, so any failure left *Network hashrate* on
`loading…` and *GRIN price* on `—` for ever — indistinguishable from a slow network, and silent
about which half broke. Since 2026-09-08 the rejection path names it (`live stats did not load ·
HTTP 503`), which separates the three real causes at a glance: **503** is nginx's `tinyx_api`
limiter (30r/m, `burst=20`), **502** is the handler's own catch-all — `getTip()` is the one
un-`.catch()`ed call in the `Promise.all`, so an unreachable node fails the entire payload
including the price — and a bare network error is the browser. `hashrate_gps_24h` and
`price_usd` are independently soft-null in the payload, so **both cards blank at once is
evidence about the request, not about the data.** The identical swallow is still in
`initEmission()`.

**But naming the failure is not the same as reporting it honestly (2026-09-09).** A 502 made
the page say *GRIN price — unavailable*, and that was simply false: the price comes from
gate.io/CoinGecko, is already `.catch()`-guarded and cached for two minutes, and needs the node
for nothing. It only ever shipped *inside* the node-backed payload, so `getTip()` took it down
with it. `GET /api/price` is now that node-free half — same `getPrice()`, its own route — and
the `/api/stats` rejection path falls back to it. An outage now costs the estimates and says so
(*live, USD · network hashrate is the missing figure*); it no longer misreports a feed that is
working. `/api/stats` itself is unchanged and still 502s as a whole: the homepage treats it as
the node-liveness signal, and a 200 full of nulls would trade a loud failure for a quiet one.

**The dash has to blame the right input.** Every unknown fell back to `'enter your hashrate'`
or `'price unavailable'`, so a dead `/api/stats` told a miner to enter a hashrate that was
already on screen — the missing figure was the *network* one, which no field on the page can
supply. `render()` now resolves a single `blocker` in the order the reader can act on:
network basis → own hashrate → price. The order is the whole fix, and it is asserted in
`test/test-mining.js` §5, not left to prose. One field further in, `miningEstimate()` now also
requires `gps > 0`: `posNum()` flattens an empty box and a rig running at 0 G/s into the same
`0`, and the page was answering a rig nobody had described with a confident **0 ツ/day** and a
**-$0.49** daily loss — the same "a missing basis is not an idle miner" rule that already
governed the network figure, applied to the operator's own.

**Number of units multiplies the PRESET, not the maths (2026-09-09).** Operators run fleets,
and the form made them do the arithmetic themselves — the hashrate note simply said "Running
several rigs? Enter their total." A count field could have been wired straight into
`miningEstimate()`, and that is the wrong place: the page's rule is that the visible boxes are
the *only* input the estimate reads, so no figure on screen can disagree with the money below
it. The count instead multiplies a **per-unit basis** into those boxes, which stay totals.

Keeping a basis rather than only a total is what makes the field survive contact with real use.
An operator who picks a preset, sets 4 units, then corrects the wattage to what the wall meter
actually reads has *4 × measured*, not 4 × spec — and moving 4 → 8 has to double the measured
figure, not snap back to the manufacturer's. So a manual edit re-derives the basis (`total ÷
count`) and flips the picker to Custom; a preset change overwrites the basis and re-multiplies;
the count re-multiplies whatever basis is current. That also makes the field work for hardware
that is not in the list at all. Three details are load-bearing and all three are asserted:
a blank, `0`, negative or half-typed count is **one** unit (`0` would zero the rig, `NaN` would
poison every figure below it); writes go through a 12-significant-digit trim, because `1.15 × 3`
is `3.4499999999999997` and that must never land in a box the reader retypes; and the basis is
seeded from **what is on screen**, not from the selected preset, so a browser that restores a
form across a reload (Firefox) does not silently undo the restored count.

**Break-even cannot move with the count, and that reads as a dead field (2026-09-10).**
The first bug report after the count shipped was "when I put a new number in units, the values
are not updated correctly". Driving the shipped `initMining()` through every entry sequence —
pasted, spinner, digit-by-digit, cleared, reduced, hardware changed mid-way, a figure corrected
by hand and then re-counted — reproduced nothing: the multiply was correct in all of them. What
is correct and *looks* broken is **break-even**, which is `powerDay / grinDay`; the count
multiplies both sides and cancels exactly. A reader who raises the count and watches every other
card move while that one holds still has no way to tell a cancelling ratio from a field that
stopped updating. The fix was copy, not arithmetic: above one unit the sub-label reads *"per ツ,
to cover electricity — unchanged by unit count, it scales both sides."* (The other live
explanation for that report was simply that the node was still 502ing, in which case only the
two boxes and the power cost move and every income card stays a dash — correct outage behaviour
that is indistinguishable from a broken multiplier.)

**Capital payback — "Pays for itself in" (2026-09-10).** The calculator answered *is this worth
running* and not *was this worth buying*, and the closing note said hardware cost was excluded.
One input (**Hardware cost**, USD) and one card now close that. Four decisions:

- **A duration, not an ROI percentage.** ROI needs a horizon supplied before the page will say
  anything; payback needs nothing and answers the question people actually ask. `fmtPayback()`
  gives one unit at a time — days under three months, months under three years, years beyond,
  and *over 100 years* past the point the figure carries information. "1 yr 8 mo 3 d" is
  precision this estimate does not have and never can.
- **The cost box holds the FLEET total, like the hashrate and wattage boxes.** `unit.cost` joins
  the per-unit basis, so a price typed at count 1 multiplies from then on and a price corrected
  by hand survives the next count change. This keeps the rule that `miningEstimate()` reads only
  what is on screen — asserted by the same test that forbids a unit count inside the maths.
  One asymmetry with the other two boxes: an **empty** cost box stays empty when the count
  changes. `trimFloat(0)` there would answer "what did it cost?" with `0` on the reader's
  behalf, and `0` is the one value that makes the card print a confident *under a day*.
- **A losing rig has an answer, and it is a word.** `paybackDays` is `null` for all three
  no-number cases; `render()` tells them apart from `hwCost` and `profitDay` and prints *never*,
  *enter what the hardware cost*, or the same blocker chain every other card uses. Returning
  `Infinity` would have put a non-finite value into the one struct on this page whose fields are
  printed as money (memory `reference_money_number_boundary_traps`). At the shipped defaults the
  card says **never** — that is the honest answer for most hardware at most electricity rates,
  and it is the most useful thing this page can say to someone about to spend $500.
- **Payback is scale-invariant too**, for the identical reason break-even is: the count
  multiplies capex and profit by the same factor. Knowing that in advance is the only reason it
  did not ship as a second bug report — it carries the same sub-label sentence from day one.

The honesty caveat is structural, not decorative. Grin pays a flat **86,400 ツ a day forever**,
so a miner's share shrinks continuously as hashrate joins — there are no halvings to schedule
around, just monotonic dilution. A straight-line payback at today's difficulty is an *upper
bound on optimism*. Difficulty growth is deliberately **not** modelled: there is no defensible
forecast basis here, and it would be the least trustworthy number on a page whose whole
credibility is that every figure is derived from something visible. The card says *at today's
price and difficulty* and the closing note says both will move.

**The setup form went to two columns (2026-09-10).** Eight fields in eight full-width rows meant
scrolling past the form to reach the cards it feeds. The rows are now paired — picker beside its
value, hashrate beside power draw, electricity rate beside the rate itself, pool fee beside
hardware cost — which fits the whole setup on one screen. The label moved from *beside* the
control to *above* it: the old 190px label column inside a half-width cell left about 140px for
the input, too narrow to read a wattage in. `align-items: start` makes every cell in a grid row
share a top edge, so the rules line up across each pair even though the notes below them are
wildly different lengths. Two traps: `:first-child` no longer suffices to drop the top border
(the first row is *two* cells, so it is `:nth-child(-n+2)`, undone again in the single-column
media query), and the breakpoint is **820px** rather than something tighter because of the two
selects — the widest option reads *"United States · industrial or hosted — ≈ $0.08 / kWh"*, and
a half-width cell below ~360px truncates it to something that names a country and hides the
rate. Reordering the fields also falsified four notes that said "below"; they now say "for you"
or name nothing.

**The money maths had no test until 2026-09-09.** `test/test-mining.js` (34 assertions at
creation; **47** as of 2026-09-10) lifts
the pure helpers out of the shipped `tiny-explorer.js` by brace-matching — so it tests the file
that deploys, not a copy — and covers the share formula, the fee clamp, every missing-input
path resolving to `null` rather than a number, the formatter dash/precision rules, the blocker
order, and the client↔server↔markup id contract. §7 and §8 are the exception to the suite's
no-DOM rule: "number of units" and the cost box are pure interaction — a count, a preset and
three boxes that rewrite each other — and nothing read off the source would prove it, so they
drive the real `initMining()` through a ~40-line listener-capturing shim. Still no jsdom and no
devDependency, which is the constraint that actually binds.

#### The assumed-port false negative

`api.grin.money` — a node this toolkit itself publishes — reported **"Not reachable — nothing
answered before the timeout."** Verified from outside on 2026-09-09: `POST get_tip` to
`https://api.grin.money/v2/foreign` returns **HTTP 200** with `{"Ok":{"height":4011570,…}}`,
while `http://api.grin.money:3413/v2/foreign` times out with no answer at all.

The verdict was *true about the address it dialled and false about the question asked*.
`parseTarget()` defaults a bare host to `http` + **3413**, but Script 04's whole design binds the
node API to localhost and fronts it with nginx on **443** — CLAUDE.md lists
`https://api.grin.money` as *the* Node API (nginx) endpoint. So for a node deployed the way this
toolkit deploys them, the default port is the wrong one, and a firewalled 3413 is the expected
state rather than a fault.

**Not fixed by dialling both.** Rule 3 of the route ("one attempt per question") exists so a
failing check cannot cost two outbound requests — the failing path is the one an abuser drives.
A fallback would double exactly that path. Instead `parseTarget()` now returns **`assumed`**
(true only when neither scheme nor port was given), the route attaches a `suggest` object, and
the client renders a one-click **"Check https://host instead"** button under the failed verdict.
A retry is a new question from the visitor, so the count per question stays at one.

Three things this shape depends on:

- **The suggestion is rendering, not diagnosis.** `busy` (503, nothing dialled), `blocked` and
  `bad_input` (400s) and `dns_failed` all carry the full result shape including `suggest`, so
  they are named in a `NO_SUGGEST` deny-set. Ending a queue-is-full banner with "try https://"
  invents a finding for a request that never left the box.
- **`assumed` is false the moment either half is explicit.** `host:13413` and `https://host` both
  suppress it — offering the alternative to someone who typed a port second-guesses a deliberate
  choice, and the tests assert the flag on all ten accepted forms for that reason.
- **The retry rewrites the input box first**, so what is on screen always matches what was
  dialled. A result whose "Checked" row disagrees with the field above it is how this class of
  confusion started. The rewrite sits *below* the `busy` guard, though: the suggestion button
  stays clickable while a check is in flight (the output is not cleared until the answer lands),
  and a rewrite above the guard would put a host in the box that was never dialled and then
  bail — recreating the exact confusion, from the control built to end it.
- **Names only — a bare IP is `assumed` but gets no suggestion.** The obvious reading of the
  flag ("we picked the port, so offer the other one") sends anyone who typed an IP into a
  certificate failure: the route verifies certificates and deliberately omits SNI for an IP
  literal, so `https://203.0.113.9` returns `tls_error` whatever is running there. A second dead
  end dressed as a fix is worse than no suggestion — the visitor now has two verdicts to
  disbelieve. The thing being suggested, a node fronted by nginx with a real certificate, has a
  name. `test-node-check.js` §4 asserts the gate against the server source rather than
  re-implementing it, because a copy of the expression would agree with itself for ever.

The reverse case — an explicit `https://host` failing while the node is really on 3413 — is
deliberately left alone: `assumed` is false there, and a suggestion would be a guess.


### Tool 2 — Wallet Checker (`/wallet-check`, phase 1 + phase 3)

"Is this `grin1…` wallet listening right now?" A Slatepack address *is* a 32-byte ed25519
pubkey in bech32, and the wallet's v3 onion is a deterministic function of that same key.

**Tier 1 — client-side, no infra (phase 1).** Validate the bech32 checksum, report
mainnet vs testnet from the HRP, show the derived `.onion`. This alone catches the most
common real failure (a truncated or mistyped address), and it is useful on its own — the
`/slate` page already carries a ported bech32 to lift from.

**Tier 2 — server probe (phase 3). SHIPPED** as `lib/wallet-tor.js` + `lib/socks5.js` +
`POST /api/wallet-check` + the `probeSection()` half of `public/js/wallet-check.js`. It is
**on by default for a new install** since 2026-09-10 (`wallet_check_probe`); it needs a local
tor SOCKS proxy, and Configure installs one to back the default. ⚠ The *code* default is still
`false` — see *The probe default has two halves* below. See *As built* below. Both halves it was ported from already existed in this repo, both dependency-free:

- `web/07_mining_pool_public/back-end-pool/lib/wallet-tor.js` — `bech32Decode`,
  `onionV3FromPubkey`, `deriveOnionAddress`, `probeToronlineStatus`. The derivation was
  validated against an independent Python reference (memory `project_pool_tor_preflight_gate`).
- `web/052_accio/gateway/socks5.js` — SOCKS5 CONNECT, RFC 1928/1929, zero npm deps, with
  per-request circuit isolation. 06d has exactly one dependency (express); keep it that way.

Carried forward from the pool's gate, do not re-derive:

- **Virtual port 80, not 3415.** grin-wallet publishes the wallet foreign-API hidden service
  at `HiddenServicePort 80 <listener>` (`impls/src/tor/config.rs`). Source-verified 2026-07-19.
- **Tri-state, never a green/red binary.** online / confidently-offline / *could not check*.
  The split hinges on the error string: a SOCKS-level "rejected connection" means the tor
  daemon is up and the hidden service is not (→ offline); a raw `ECONNREFUSED` to
  127.0.0.1:9050 means our own tor is down (→ indeterminate). Rendering our outage as the
  user's wallet being offline is the same class of lie as reporting a healthy remote node's
  peer count as `0`.

The open question — **does the wallet foreign API over Tor require basic auth?** — was
*decided* rather than settled: the shipped probe sends a real `check_version` JSON-RPC (never
a bare TCP connect, per CLAUDE.md's *reachability needs a parsed result*) and treats an HTTP
401 as **online**, since a 401 still proves a grin-wallet is answering. That rule has never
been exercised against a live listener, so it stays the one unverified assumption in tier 2.

**As built — operator enablement.** The probe's failure mode is silent from the outside: the
flag can be on with no tor, and every visitor then gets *"could not check"* while the service,
port, config and nginx status rows all read green. Two guards close that:

- **Configure offers the tor install.** Answering *yes* with nothing on `127.0.0.1:9050` calls
  `_tinyx_ensure_tor` (client only, no hidden service — ported from `_acg_ensure_tor` in
  `052_lib_gateway.sh`), then re-checks that the SOCKS port is actually **listening** rather
  than trusting `systemctl is-active`: a tor with `SocksPort 0` is active and proxies nothing.
  If it still does not come up, the operator is told what they are choosing and the flag
  defaults back to off. Before this, *yes* wrote the flag and printed "(apt install tor)",
  which made a probe that always answers "could not check" the single likeliest outcome of
  enabling it.
- **Status reports it.** `tinyx_status` prints a `Probe:` row — off / on-with-SOCKS-up /
  on-but-no-SOCKS — because nothing else on that screen looks at tor.
- **The listener test has to be wider than one literal string.** `_tinyx_tor_socks_up` is what
  that red row and the enable prompt both rest on, so a false negative there talks an operator
  out of a probe that works. It matches `127.0.0.1:<port>` **or** `[::1]:<port>` (a torrc saying
  `SocksPort [::1]:9050` is up and usable), anchors on trailing whitespace so `:9050` never
  matches `:90501` or tor's control port `:9051`, and falls back to a real connect over bash's
  `/dev/tcp` where the box has no `ss` at all — reporting "no SOCKS" about a proxy nobody
  looked for is the same lie in the other direction.

**As built — the copy has two states, and the static HTML is the OFF one.** The page described
itself as tier-1-only long after tier 2 shipped, and hedged the difference (*"where this server
offers the optional Tor liveness check…"*), which makes the visitor resolve a conditional the
page already knows the answer to — `window.TINYEXP_WALLET_PROBE` is injected per request.
Both states are now definite:

- The **static HTML carries the baseline wording**, deliberately — but the reason changed when
  the default flipped on 2026-09-10. It is no longer "what ships"; it is that **the probe button
  is built by `wallet-check.js`**, so a visitor whose browser never runs that file has no control
  on the page whatever `config.json` says. Static copy promising a liveness check would
  over-promise in exactly the state that cannot deliver one.
  The mirror of that is now banned too, and it is the change the flipped default forced: the
  baseline may no longer **deny** the capability. It used to read *"this server does not offer
  the optional Tor liveness check"* — a claim about the **server**, false wherever the flag is
  on, i.e. on most boxes, and read by exactly the visitor whose script failed and who cannot
  tell. The copy is config-neutral instead: it describes what the **page** has done (*"nothing
  here has asked"*), never what the box can do, so it is true in all four combinations of flag
  and script. `test/test-probe-copy.js` enforces both directions.
- `applyProbeCopy()` in `public/js/wallet-check.js` replaces three elements (`#wc-lede`,
  `#wc-scope-note`, `#wc-detail-live`) when the probe is on, and `applyWalletProbeLabels()` in
  `tiny-explorer.js` relabels the tools-menu row and homepage card on every shell — *"can I see
  whether this wallet is online before I send to it"* is why most people open the tool, and a
  label that never says so hides it behind a page nobody had a reason to click.
- The **`<meta name="description">` branches server-side** in `_pageMeta.walletcheck` — the only
  per-deployment line in `_pageMeta`. A fixed string is wrong on one of the two boxes: either a
  search result promising a liveness check the visitor will not find, or one denying a
  capability sitting on the page. The `title` stays fixed so the tool keeps one name.
- `/proof` claimed the Wallet Checker "never transmits what you paste". With the probe on it
  does, on request. Reworded to stay true in both states without needing the flag.

The whole arrangement has one silent failure — a renamed id makes the swap a no-op and the page
then denies a capability whose button is directly below the sentence. Flipping the default made
that **more** likely, not less: the swap now has to fire on most boxes, and the operators best
placed to notice it silently not firing are the ones with the probe off, whose page reads
correctly either way. `test/test-probe-copy.js` (13 assertions) asserts that contract across
five files rather than the prose.

#### The probe default has two halves

`wallet_check_probe` has **two** defaults, they disagree on purpose, and aligning them would be
a bug either way round:

| | Value | Set in | Answers |
|---|---|---|---|
| **Installer default** | `true` | `tinyx_configure` in `scripts/lib/06d_tiny_explorer.sh` | *What should a fresh box do?* |
| **Code default** | `false` | `config.wallet_check_probe === true` in `tiny-explorer-server.js` | *What does a config that does not say mean?* |

- **Why the installer flipped.** *"Is this wallet answering right now?"* is the reason most
  visitors open the Wallet Checker, and off-by-default shipped a tile that answered every
  question except that one. The original default was written when the prompt could only
  **detect** a missing tor daemon; `_tinyx_ensure_tor` now installs one, starts it and **polls
  until SOCKS is actually bound** (a tor with `SocksPort 0` reads as "active" and proxies
  nothing), so the box no longer has to arrive qualified — it can be made so.
- **Why the code default did not.** A `config.json` that lost the key — hand-edited,
  half-restored, written by an older toolkit — must fail **closed**. A box does not start
  dialling Tor for visitors because a line went missing.
- **The read-back is now two-sided.** `tinyx_configure` rewrites `config.json` wholesale, so it
  reads the current value back before prompting. It used to detect only `true`, which was
  correct when the default was `false`: it stopped an operator who had turned the probe **on**
  from losing it by re-running Configure for a new domain. With the default flipped, a one-sided
  read-back does that same damage in the other direction — to an operator who deliberately
  turned it **off**. An explicit value in the config is a decision and outranks the default in
  both directions; only an install whose config does not already record a choice gets the
  default. That is very nearly "a new install" but not exactly — a `config.json` written before
  the key existed (pre-`99087d9`) matches neither grep and takes the default too. The operator
  still sees the prompt, so it is a proposal, never a silent migration.
- **A deployed box keeps what it chose.** Any `config.json` this toolkit has written since the
  key existed carries a literal `"wallet_check_probe"`, and nothing in an update path rewrites
  it — so a box already in service is unaffected by the flip in either direction. This changes
  what Configure *proposes*; an existing deployment turns the probe on by re-running **Script
  06 → `D` → `2` Configure**, where the prompt now defaults to yes.
- **Consent for the daemon is still explicit.** Where the default is yes and no tor is
  listening, the prompt names the consequence inline — `(installs tor)` — and the install itself
  asks separately inside `_tinyx_ensure_tor`. Installing a daemon is a side effect beyond what
  "set up an explorer" implies; an operator pressing Enter through the prompts should not
  discover it afterwards. If the install fails, the existing fallback asks whether to leave the
  probe on and **defaults to no**, so a failed install cannot leave a box answering "could not
  check" to every visitor.
- **The prompt's catch-all keeps the default, and the EOF branch declines.** Both were latent
  while the default was `false` and became live the moment it flipped. `*) wallet_probe="false"`
  under a printed `[Y/n]` meant every input but a bare `y`/`yes` — `Y ` with the space a paste
  leaves behind, `ye`, `1` — silently answered **no**, with nothing echoed to say so; the
  catch-all now keeps whatever the default is and warns. And `read` at EOF (stdin closed,
  Configure driven from a pipe) returns non-zero leaving the variable empty, which is
  indistinguishable from a pressed Enter — with the default now yes that reached `apt-get
  install tor` with nobody at the keyboard, so the read falls back to `n`. **Rule: a catch-all
  may never name a value, and a printed default is an offer to a human.**

**What flipping the default does not change.** The probe is still press-to-run — nothing leaves
the browser until the visitor clicks — the tri-state is unchanged, and `/api/wallet-check` still
logs no address. It does widen one surface by default: any valid `grin1…` string maps to an
arbitrary v3 onion, so a visitor chooses who the server dials. That is fenced by the nginx
`tinyx_probe` zone (10r/m, burst 5), `WALLET_PROBE_MAX_INFLIGHT` 4, a ~120-byte POST, a 16 KB
response cap and an 8 s timeout — but it is now on unless an operator turns it off.


### Tool 3 — Node Reachability Checker (`/node-check`, phase 2)

"Can the world reach my node?" — the question every operator who opened 3413 has. Input a
host (optional `:port`, default 3413); the server checks **two ports** and reports them
separately.

#### The two legs

| Leg | Port | Probe | What a pass proves |
|---|---|---|---|
| **Wallet API** | typed; assumed **443 for a name**, **3413 for an IP** | POST `get_tip` to `/v2/foreign` | A Grin node is there — an unwrapped `{"Ok":{height}}` came back |
| **P2P** | 3414 / 13414 only | bare TCP connect, **no bytes sent** | Only that *something accepted a connection* |

**Why the second leg exists at all.** The API is what a *wallet* dials; 3414 is what the
*network* dials. A node that peers correctly and deliberately keeps its API off the internet
is a correct configuration, and the single-leg checker drew it as a red ✕. That is not a
missing feature — it was a **wrong verdict**, and it is the reason this leg was added.

**The asymmetry is the whole design constraint.** This page's own copy says an HTTP 200
proves nothing; a bare TCP accept is *weaker* evidence than an HTTP 200. So the P2P leg is
labelled **"port open"** and never "node reachable", in the leg table, the banner and the
`<details>` copy alike. `test-node-check.js` §6 asserts the probe never calls `.write()` —
adding one would change what the leg proves without changing a word of the copy.

**Tier B was declined, not overlooked.** A real `Hand`/`Shake` handshake would prove a Grin
node *and* identify the network from the magic bytes, removing the guess below. It needs
genesis hashes, capability flags and a protocol version that moves with every grin release —
a standing maintenance debt in a tool whose value is being stateless. Revisit only if
"port open" turns out to mislead in practice.

**Which P2P port.** `p2pPortFor()` in `lib/node-check.js`, and the port is **never visitor
input** — only ever 3414 or 13414. A connect-only probe on an operator-chosen port is a port
scanner with a Grin logo on it. The page ships a three-way picker (`Auto` / `Mainnet` /
`Testnet`) and the returned `source` field says where the choice came from, because the
client words a *defaulted* port more cautiously than a chosen one:

| `source` | When | Client behaviour on a closed port |
|---|---|---|
| `chosen` | operator picked Mainnet/Testnet | states it plainly |
| `derived` | they typed `:13413` / `:13414` | states it plainly |
| `default` | bare host, picker on Auto | adds the "3414 was assumed — switch to Testnet if that is wrong" hedge |

On `Auto` the **only** signal used is a port the visitor typed themselves; the network is
never guessed from a host name.

#### The assumed API endpoint — why a bare name goes to 443, not 3413

Until 2026-09-10 a bare host defaulted to `http://host:3413`, and the route's own comment called
that **"the single commonest wrong verdict this tool can give"** — a *correct* answer about a port
the operator never published. Script 04 fronts a node with nginx + certbot and publishes it at
`https://api.grin.money/v2/foreign`; 3413 is bound to localhost and firewalled. The tool was
therefore defaulting to the one endpoint its own toolkit does **not** expose.

The default now splits on **what kind of host it is**, and the split is load-bearing in both
directions:

| Input | Assumed endpoint | Why |
|---|---|---|
| bare **name** (`node.example.com`) | `https://name:443` | Owning a name means DNS and, nearly always, a certificate. This is the shape Script 04 deploys. |
| bare **IP** (`203.0.113.9`, `2001:db8::1`) | `http://ip:3413` | The checker verifies certificates and deliberately sends **no SNI** for an IP literal, so https on a bare address lands on `tls_error` *whatever* is running there. Defaulting an IP to 443 would trade a sometimes-wrong answer for an always-wrong one. |
| anything explicit (`:3413`, `https://…`) | as typed | `assumed` is false; no suggestion is offered. |

**The default and the retry are two ends of one mechanism.** The one-click suggestion now points
at `http://name:3413` — *away* from the assumption. Flipping one end without the other yields a
button that re-runs the check that just failed, and nothing else in the codebase would notice, so
`test-node-check.js` §9 asserts the direction explicitly.

**The retry allowlist grew with the flip.** It held `refused` + `timeout` only, because the old
assumption was a bare *port* and those are the only two ways a port dead-ends. The assumption is
now a port **and** a protocol **and** a certificate, so `tls_error`, `http_status` and
`not_json_rpc` joined the list — each means "something owns 443 but it is not publishing a node
there". `tls_error` is now the likeliest failure on the page for a name with no front.
`node_error` stays out: a real Grin node answered, and sending the operator elsewhere would
contradict the banner above it.

**Three failure sentences, not one.** `composeVerdict()` separates *did not answer* (nothing came
back) from *answered as something else* (`API_ANSWERED`: a 403, a parked page) from *accepted the
connection and then failed the TLS handshake*. Collapsing them into "did not answer" sends an
operator into `ufw` when the real problem is a missing certificate or a web server squatting 443.

#### The composed verdict — two of four combinations are configurations, not failures

| API | P2P | Banner |
|---|---|---|
| ✓ | open | **✓ is-ok** — reachable both ways |
| ✓ | closed | **ⓘ is-warn** — wallets can reach it, no inbound peers. *Not a failure* |
| ✗ | open | **ⓘ is-warn** — peering fine, API not published. *Not a failure, and the safer half to leave closed* |
| ✗ | closed | **✕ is-bad** — the genuine failure |

`composeVerdict()` also splits "did not answer" from "answered as something else"
(`API_ANSWERED` = `http_status` / `not_json_rpc` / `node_error`): conflating them sends the
operator to the firewall when the real problem is a web server on the port.

**One hedge the ✕ needs.** When the API was reached over TLS on 443 — an nginx front, which
is exactly what Script 04 deploys — a filtered 3414 may describe a proxy rather than the
node's box. The client says so next to the ✕, not in a collapsed section.

The honest-output rules are already written down and apply directly (CLAUDE.md, *Node API
method split*):

- A 200 proves nothing — any parked domain or CDN error page answers 200, and a bare `GET`
  on `/v2/foreign` proves nothing either because it is POST-only JSON-RPC.
- Script 04 publishes `/v2/foreign` and **403s `/v2/owner`**, so from outside, peer count and
  sync state are *unknowable*. Report them **unavailable — never `0` or `unknown`**, which
  renders a healthy node as idle.
- Useful output that *is* knowable: reachable yes/no, node version, its tip height, and its
  drift against our own tip ("in sync" / "behind by N blocks").

**This one is the only tool here with a genuine abuse surface, so it carries real controls.**
The concern is not internet port-scanning; it is **SSRF into the operator's own box and LAN**:

- Resolve DNS first, then block the *resolved* IP against loopback, RFC1918, link-local
  (169.254/16), CGNAT (100.64/10), `::1` and `fc00::/7`. Checking the hostname is not enough —
  DNS rebinding defeats it.
- Do not follow redirects. Cap the response body. Short timeout (5 s API / 4 s connect), one
  attempt per leg, no retry.
- **Both legs dial the SAME cleared address.** The gate runs once, on every address DNS
  returned; neither leg re-resolves. The P2P leg adds no new destination — only a second port
  on a host already cleared, and that port is a constant.
- Its own rate-limit zone, tighter than `tinyx_api`.
- **Outbound cost, restated for two legs:** 2 requests on a failing check, 3 on a fully
  successful one (API `get_tip`, the best-effort `get_version` on success only, and one TCP
  connect). The connect is skipped entirely when the API was aimed at the P2P port itself —
  `same_port`, derived from the API outcome rather than dialled twice.
- **The in-flight cap counts CHECKS, not sockets**, and a check now holds two. Eight in flight
  is up to sixteen outbound sockets; that is the number to weigh against the process's file
  descriptors. Counted per check deliberately: the legs share a deadline and are released
  together, so a socket-counted cap could admit half a check.


### Tool 4 — Payment Proof Verifier (`/proof`, phase 2)

Grin's answer to "prove you paid me". The receiver signs over the amount and kernel excess;
verifying that signature plus finding the kernel on-chain is a complete proof.

**Take the exported proof JSON as the primary input, not the binary slate.** `grin-wallet
export_proof` writes a JSON file with sender/recipient addresses, amount, excess and
signature — that is what a user actually holds when they need to prove a payment, and it is
trivially parseable. Binary-slate proof extraction can follow later as a convenience.

That choice keeps the risky part off the critical path: `slatepack-decode.js` deliberately
stops at the optional-field block and does **not** walk `sigs`/`coms`/`proof` (see the Slate
Inspector addendum above — that tail is the likeliest parse failure). Phase 2 does not have
to change that.

- **ed25519 verify with no dependency.** Node 18's `crypto.verify(null, msg, key, sig)`
  handles ed25519; wrap the raw 32-byte pubkey in the fixed SPKI DER prefix
  (`302a300506032b6570032100`) to build the `KeyObject`.
- **Then cross-check the chain.** Feed the excess to the existing `/api/kernel/<excess>`
  route: a valid signature over a kernel that never confirmed is not a settled payment. This
  is the reuse that makes this tool cheap here and expensive anywhere else.
- **Verify the signed-message serialisation against grin-wallet source before implementing**
  (`verify_payment_proof`). Guessing the byte layout produces a verifier that says "invalid"
  for every genuine proof, which is worse than no tool.

#### Payment proof — verified wire facts (read from grin-wallet source, not assumed)

Read 2026-09-05 from `mimblewimble/grin-wallet` at tag **v5.4.1** — the toolkit's pin (memory
`project_grinwallet_binary_store`). Every layout fact below was re-checked field-by-field at
**v5.5.0 and at `master`** and is byte-identical in all three, so a pin bump cannot silently
move it. `grin-wallet` is the only implementation consulted; whether any other wallet writes a
compatible file is **UNCONFIRMED**.

**The file.** `grin-wallet export_proof` is `proof_export()`
(`controller/src/command.rs:1385`), which calls `owner::retrieve_payment_proof`
(`libwallet/src/api_impl/owner.rs:385`, returns at `:470`) and writes
`serde_json::to_string_pretty(&PaymentProof)` straight to the output file
(`command.rs:1400-1402`). So the file *is* the serde form of one struct — no wrapper, no
envelope, no armor. `proof_verify` (`command.rs:1420`) reads it back with `json::from_str`.

| JSON key | JSON type on the wire | Decoded | Serde source |
|---|---|---|---|
| `amount` | **decimal STRING** of nanogrin (`"1234567890"`) | u64 | `string_or_u64` serialises with `collect_str` → grin `core/src/libtx/secp_ser.rs:266-272`; it *deserialises* from a string **or** a bare number (`:275-299`), so a hand-edited file may carry either — accept both. u64 nanogrin exceeds 2^53 above ~9 M GRIN, so **BigInt**, per the `/slate` decoder's rule |
| `excess` | hex string, **66 chars / 33 bytes** | `pedersen::Commitment` | `as_hex` (`secp_ser.rs:246-252`) / `commitment_from_hex` (`:235-243`) |
| `recipient_address` | **bech32 string** (`grin1…` / `tgrin1…`) | 32-byte ed25519 pubkey | `impl Serialize for SlatepackAddress`, `libwallet/src/slatepack/address.rs:158`, via `TryFrom<&SlatepackAddress> for String` at `:101` |
| `recipient_sig` | hex string, **128 chars / 64 bytes** | ed25519 signature | `dalek_sig_serde`, `libwallet/src/slate_versions/ser.rs:365-394` |
| `sender_address` | bech32 string | 32-byte ed25519 pubkey | as `recipient_address` |
| `sender_sig` | hex string, 128 chars | ed25519 signature | as `recipient_sig` |

Struct and field order: `libwallet/src/api_impl/types.rs:310-331`. There are exactly these six
keys — no version field, no timestamp, no tx UUID, no fee.

**The signed message — 73 bytes, one concatenation, no hashing and no domain separator.**
`payment_proof_message()`, `libwallet/src/internal/tx.rs:453-463`:

```
msg = amount        as u64 BIG-ENDIAN      8 bytes   (msg.write_u64::<BigEndian>)
    ‖ excess        raw commitment bytes  33 bytes   (kernel_commitment.0.to_vec())
    ‖ sender_pubkey raw ed25519 bytes     32 bytes   (sender_address.to_bytes())
```

The 33 and the 32 are not inferred — `_decode_payment_proof_message` (`tx.rs:465-484`) reads
exactly `[0u8; 33]` then `[0u8; 32]` back out. The 33 bytes are the commitment **as stored**,
i.e. the same compressed form the chain carries and the same hex our `/api/kernel/:excess`
route already accepts (`isCommitLike` = 64–66 hex, `tiny-explorer-server.js:193`) — so
`proof.excess` feeds that route verbatim, no re-encoding.

ed25519 signs this message directly (`create_payment_proof_signature`, `tx.rs:487-506`,
`keypair.sign(&msg)`) — ed25519 does its own SHA-512 internally, so **do not pre-hash**.

**Which key signs what.** Both signatures are over **the same 73-byte message**:

| | Signed by | Verified with | Source |
|---|---|---|---|
| `recipient_sig` | recipient's key at derivation index **0** | `recipient_address` | `libwallet/src/api_impl/foreign.rs:116-124` (recipient signs at `receive_tx`, S1→S2) |
| `sender_sig` | sender's key at `context.payment_proof_derivation_index`, hard-coded `0` today | `sender_address` | `tx.rs:423-443` (signed at finalize); index set at `owner.rs:566`, with a `TODO` beside it |

**`verify_payment_proof` order** (`owner.rs:1191-1257`), exactly as written:

1. Build `msg` from `proof.amount`, `proof.excess`, `proof.sender_address.pub_key`.
2. **Chain first:** `client.get_kernel(&proof.excess, None, None)` — a transport error and an
   `Ok(None)` are two distinct errors, and both abort before any signature is looked at.
3. `recipient_address.pub_key.verify(msg, recipient_sig)` → "Invalid recipient signature".
4. `sender_address.pub_key.verify(msg, sender_sig)` → "Invalid sender signature".
5. Derive this wallet's own index-0 address and return `(sender_mine, recipient_mine)` — a
   convenience for the CLI's three-way message, not part of validity. Our tool has no wallet
   and simply omits step 5.

The HRP is never consulted, and neither is a tx UUID (there isn't one).

**Q: does the recipient signature cover the sender address? YES** — `sender_pubkey` is the
last 32 bytes of the message both parties sign. Re-pointing a proof at a different payer
changes the message, so `recipient_sig` fails. The tool *can* detect that. What is **not** in
the message is the recipient address (it is the verifying key instead, so it is equally
unswappable) and the HRP (below).

**Q: does anything identify the network? Only weakly, and not authentically.** The bech32 HRP
is the single signal — `grin` vs `tgrin` — and it comes from the **exporting wallet's** chain
type at export time (`SlatepackAddress::new`, `address.rs:46-55`), not from anything inside
the transaction. It is **not covered by either signature** (the message uses the raw 32-byte
key), and `TryFrom<&str>` (`address.rs:86`) accepts whatever HRP it is handed. So editing
`tgrin1…` → `grin1…` in the file leaves both signatures valid. This is the **same limitation
as SlateV4** (memory `project_slate_inspector_06d`, and the Slate Inspector addendum above):
the artefact does not commit to a chain. Consequence for the tool: render the HRP as a
*claim*, and let the kernel lookup — mainnet-only here — be the actual network evidence,
exactly as `/slate`'s phase-1b note already says.

**What a valid result does NOT prove.** All of these are properties of the format, not gaps in
our implementation, and belong on the page as prose:

- **The amount is attested, never verified.** Grin amounts are confidential; the kernel proves
  a transaction happened, not its value. `amount` is true only insofar as both parties signed
  it. Never render it as chain-derived.
- **It is a mutual attestation.** Either signature alone is self-serving — a recipient can
  sign any `(amount, excess, sender)` triple it likes, and a sender can sign over any kernel
  already on the chain. The pair is what carries weight, because neither party can produce the
  other's half.
- **`sender_address == recipient_address` is self-attested and passes.** Both checks use the
  same message, so one key signing twice satisfies both. Surface it, don't hide it.
- **Nothing binds `sender_address` to the transaction's inputs.** The proof says "this key
  claims this kernel", not "this key funded it".

#### The payment-proof layout is confirmed against real grin-wallet output

The standing #1 risk of this expansion — *"every fact was read from source, no real proof file
has ever been checked, so a shared misreading is uncatchable"* — **is settled, and it did not
need a VPS.**

**What was found.** grin-wallet's Owner API rustdoc carries a worked
`retrieve_payment_proof` example whose response is a **complete, real `PaymentProof`**
(`api/src/owner_rpc.rs:1802-1836`). It is not illustrative prose: the surrounding
`doctest_helper_json_rpc_owner_assert_response!` macro **runs the call and asserts the
response byte-for-byte in CI**, so that JSON is the output of the very `serde` impls tabulated
above, produced by a real wallet doing a real transaction on the test chain.

**Why it settles the question rather than restating it.** The concern was that fixtures built
from our own reading cannot catch a misreading shared with the implementation. This fixture is
immune to that, because the check is **cryptographic, not textual**: the 73-byte message is an
*input to signature verification*. If any field were at the wrong offset, the wrong width, or
the wrong endianness, the message would differ and both ed25519 signatures would fail. They do
not fail. A hand-copied or hand-edited sample could not produce signatures that verify.

Running the fixture through `lib/payment-proof.js` unmodified:

```
amount_nano  : 60000000000          amount_grin : 60
excess       : 09eac5…fe0af (33 bytes)
message      : 73 bytes
recipient_sig: {ok:true}            sender_sig  : {ok:true}
```

**Negative controls** (a test that cannot fail proves nothing — each mutation is one field of
the fixture, everything else untouched):

| # | Mutation | Result | What it proves |
|---|---|---|---|
| 1 | none (baseline) | `R:ok S:ok` | — |
| 2 | `amount` 60000000000→60000000001 | `R:FAIL S:FAIL` | amount is in the message, at that width |
| 3 | `excess` last byte flipped | `R:FAIL S:FAIL` | all 33 commitment bytes are covered |
| 4 | sender ↔ recipient address | `R:FAIL S:FAIL` | the message pins the **sender** key; roles are not interchangeable |
| 5 | `sender_sig` last byte flipped | `R:ok S:FAIL` | the two checks are independent, and each uses its own key |
| 6 | HRP `tgrin1…` → `slatepack1…` | `R:ok S:ok` | **the HRP is not signed** (below) |
| 7 | `amount` as a bare JSON number | `R:ok S:ok` | the `string_or_u64` number path works, without 2^53 rounding |
| 8 | same message, amount little-endian | `S:FAIL` | the u64 is **BIG**-endian — the one field most likely to be misread |

Row 6 is a second, independent confirmation of the HRP finding above, and it comes from
grin-wallet itself: its **`verify_payment_proof` doctest** (`owner_rpc.rs:1848-1884`) feeds the
*same 32-byte keys under a `slatepack1` HRP* and returns `Ok`. So upstream's own CI demonstrates
that re-labelling the network leaves both signatures valid. Rendering the HRP as a *claim*, with
the kernel lookup as the only network evidence, is now evidence-backed rather than inferred.

**Version stability.** The fixture and `payment_proof_message()` are **byte-identical at
v5.4.1, v5.5.0 and `master`** (diffed, not eyeballed), so the same proof verifies at all three
and a pin bump cannot silently move the layout.

**Every row of the wire-facts table above is therefore confirmed** — key names and count,
`amount` as a decimal string *and* as a bare number, 33-byte `excess`, bech32 addresses
carrying raw 32-byte ed25519 keys, 128-hex signatures, the 73-byte concatenation, big-endian
`u64`, no hashing, no domain separator, and both signatures over the same message.

**Regression fixture** — commit this with the tool; it is the only real-wallet proof we have:

```json
{
  "amount": "60000000000",
  "excess": "09eac5f5872fa5e08e0c29fd900f1b8f77ff3ad1d0d1c46aeb202cbf92363fe0af",
  "recipient_address": "tgrin10qlk22rxjap2ny8qltc2tl996kenxr3hhwuu6hrzs6tdq08yaqgqq6t83r",
  "recipient_sig": "02868f2d2b983981f8f98043701687a8531ed2de564ea3df48e9e7e0229ccbe8359efe506896df2efbe3528e977252c50e4a41ca3cc9896e7c5a30bbb1d33604",
  "sender_address": "tgrin1xtxavwfgs48ckf3gk8wwgcndmn0nt4tvkl8a7ltyejjcy2mc6nfs9gm2lp",
  "sender_sig": "c511764f3f61ed3d1cbca9514df8bc6811fad5662b1cb0e0587b9c9e49db9f33183cce71af6cb24b507fabf525a2bc405c6e84e63a60334edff0b451ae5e6102"
}
```

Its `excess` is a **testnet** kernel from a throwaway test chain, so the chain half of `/proof`
will correctly report *kernel not found* against our mainnet node. That is the right answer,
and it makes the fixture a good end-to-end check of the two-verdict split: signatures valid,
kernel absent — exactly the case the page must not collapse into a single "invalid".

**Recommendation: `/proof` SHIPS.** The reason to hold it was a possible shared misreading of
the byte layout, and that reason is gone. The caveats that remain are properties of the format,
not doubts about the implementation, and they already have prose on the page: the amount is
attested and not chain-derived, the HRP is a claim, and a valid pair is a mutual attestation.

**STILL UNCONFIRMED (bounded, and no longer ship-blocking):**

- grin-wallet calls ed25519-dalek's non-strict `verify` (not `verify_strict`); the pin is
  `ed25519-dalek = "1.0.0-pre.4"` (`libwallet/Cargo.toml:26`). Whether that and Node's
  OpenSSL-backed `crypto.verify(null, …)` agree on adversarial edge cases is still
  unconfirmed — settling it needs a Rust toolchain, not a VPS. **The direction is now known,
  though:** Node was fed the four canonical small-order / non-canonical public-key encodings
  and returned a clean `ok:false` for each — no throw, no 500 — whereas dalek's non-strict
  path is the more permissive of the two. So a disagreement can only make our tool **stricter**
  than grin-wallet, on a *crafted* file, and it fails **closed**. No honest proof is affected;
  the honest case is exactly what the fixture above now proves.
- Whether any **non-grin-wallet** implementation writes a compatible file remains unconfirmed;
  `grin-wallet` is still the only implementation consulted.
- ~~A proof exported from an operator's *own* wallet has still never been read.~~ **Done
  2026-09-19** on a live mainnet solo wallet (grin-wallet v5.4.1): a `send -d <slatepack
  address>` → `receive` → `finalize` → `export_proof` round-trip pasted cleanly and both
  signatures verified. It surfaced two things the fixture could not:
  - **Operator trap:** the first attempt was `export_proof --id` on a coinbase entry, which fails
    with *"Transaction does not contain a payment proof"*. A proof exists only for a `send -d …`
    (no `-n`) that has been finalized — never for coinbase, received, invoice or manual-file
    entries. The textarea placeholder now says so; the collapsed "How to produce one" block
    already did, but nobody reads it before their first failure.
  - **Real bug, fixed:** grin's `get_kernel` answers a missing kernel with `{"Err":"NotFound"}`
    (`api/src/handlers/chain_api.rs`, `kernel.ok_or(Error::NotFound)`), **not** `Ok(None)` as
    `getKernel()`'s comment claimed. `unwrapResult` throws on every `Err`, so a finalized-but-
    unmined proof — the normal state for the first minute after `finalize` — rendered as *"The
    node could not be reached"* on `/proof`, and `/api/kernel/<excess>` answered 502 instead of
    404. `getKernel()` now maps that one error to `null`; every other throw (timeout, 401, 5xx)
    still means the node. The `not_found` copy that was written for this case is now reachable.

### Peer map — location grouping + node id (`web/06_stats_map/stats/index.html`)

#### The problem
Geo comes from ip-api.com at **city level** (`06_collector.py` `GEO_URL`), which returns the
**city centroid**, not the host. So every peer in one city carries **byte-identical** lat/lng.
Drawing one `circleMarker` per record stacked them exactly: only the last one drawn was
hoverable, the nodes underneath were unreachable, and the panel's peer total silently
disagreed with the number of visible dots. `flyTo` could never separate them — `maxZoom` is 10
on purpose (GeoIP is city-accurate; zooming further would imply precision the data lacks).
Grin peers concentrate on a few hosting providers, so the densest locations were the hidden
ones, and **every dual-stack host was a guaranteed 2-stack** (its v4 and v6 records are
different IPs at the same centroid, so the existing `dual` collapse never applied).

#### The fix — one dot per point
- **Group key = rounded coordinate** (`COORD_DP = 2`, ~1.1 km), not the city name: `city` can
  be blank and two providers sometimes label one centroid differently. Zoom-stable by
  construction, unlike pixel-distance clustering (leaflet.markercluster would fuse Frankfurt
  with Amsterdam at zoom 2 — hiding a real distinction instead of revealing a hidden one).
- **Dedup inside a group is DUAL-ONLY.** `dual` is computed by the collector on the *real* IP;
  two unrelated hosts in one /24 share the masked string and must both be counted. Deduping on
  the published IP would delete real nodes from the map.
- **Radius `min(16, 5 + 3·√(n−1))`** — area-proportional, same as the pool's network map.
  `n = 1` keeps the original canvas `circleMarker` (unchanged look, unchanged `flyTo` click).
- **`n ≥ 2` is a DOM `divIcon`**, not a canvas circle: a canvas circle can't carry the count
  label, and the "mixed networks" ring must follow the theme — CSS vars do that, a hex baked
  into a marker option does not (markers are built once at boot, never rebuilt on theme change).
- **Fill = largest kind present** (ties keep mainnet via stable sort); a group holding more than
  one kind also gets the `.grp-mixed` ring, so the fill is never read as the whole story. The
  split is in the hover tooltip.
- **Stacking is not insertion order.** Leaflet puts canvas circles in the `overlayPane` (z 400)
  and DivIcon markers in the `markerPane` (z 600), and stacks DivIcons by `pos.y +
  zIndexOffset` — verified in the leaflet 1.9.4 source/CSS the script pulls. So adding markers
  "largest first" would achieve nothing: group-vs-group ordering has to be a
  `zIndexOffset: -d`, which puts the bigger dot underneath wherever two overlap (the small one
  is the easy one to lose). **Residual, and accepted:** a lone dot within about a dot's width of
  a big group is covered at low zoom, because the pane order can't be beaten from marker
  options. Unlike the stacking this replaces, zooming in separates them — group members share
  one coordinate, whereas two *groups* are ≥1.1 km apart by construction and anything
  overlapping at zoom 2 is tens of km apart.
- **Click = drill-down, not zoom.** It sets a `LOC_FILTER` (keyed on the same coordinate string)
  and opens the existing left panel, reusing its rows, filters and click-to-fly rather than
  duplicating the list inside a popup. It arrives from the map, so it gets a dismissable chip
  instead of a `.lp-filters` dropdown, and it composes with the other filters.
- Panel gains **Nodes on map / Map locations / No location data**, all derived from the groups
  actually drawn, so they cannot drift from the map. Invariant:
  `Total peers − Both (same IP) − No location data = Nodes on map`. That is exact only because
  `known_peers` is `PRIMARY KEY (ip, network)` — a dual IP is *exactly* two rows, so the count of
  distinct dual IPs equals the number of rows the dedup drops. A schema that let one IP hold two
  rows on the same network (e.g. a port change) would break the reconciliation, not the map.

#### `node_id` — why a masked IP needs one
peers.json publishes `_mask_ip()` output (`95.216.1.x`), so two hosts in one /24 render as the
same string and, since nearly everyone runs the standard port, their rows were byte-identical —
which made "click the dot to see the IPs" undeliverable exactly where it mattered. The collector
now emits `node_id`: `sha256(salt|real_ip)[:4]`.
- **Salted, and the salt never leaves the box** (`meta.node_id_salt`, 128-bit, minted on first
  use). Unsalted, the id would hand back the octet `_mask_ip()` just removed — the /24 is
  public, so there are only 256 candidates to hash.
- **4 hex** — enough to separate the handful of nodes that ever share a /24, deliberately too
  few to enumerate or correlate across installs.
- Same real IP → same id on both networks, so a dual node's two records are recognisable as one
  host. The IP search box matches the id too (`#a1b2` or `a1b2`).
- **Forward/backward compatible**, same pattern as `dual`: `HAS_NODE_ID` is probed from the data;
  an older peers.json renders no id and the search placeholder downgrades to "Search IP
  address…" rather than promising a search the data can't answer.

#### Adjacent fix
`markersLayer` is now `L.featureGroup()`. `applyTheme()` calls `markersLayer.bringToFront()`
after swapping tiles, and `bringToFront` is defined on **FeatureGroup, not LayerGroup**
(verified in leaflet 1.9.4 source) — on the old `L.layerGroup()` that call was a TypeError.
Harmless today because nothing runs after it, but it would silently swallow whatever got added
there next. `FeatureGroup.bringToFront()` delegates via `invoke()`, which skips layers lacking
the method, so the mixed canvas/DOM marker set is safe.

### Peer counts — windowed by the node's own handshake time (`scripts/lib/06_collector.py`)

#### The bug
The collector read `last_seen` from each `get_peers` row. grin's `PeerData` has **no such
field** — the handshake time is `last_connected` — so it was always 0, and the "0 → `ts − 60`"
fallback stamped **every Healthy peer in the node's store as seen a minute ago, on every run**.
grin never expires Healthy rows (only Defunct ones), so a long-lived node's store holds every
node it has reached since it was built. Every windowed figure counted all of them as current:
week/month node counts and Top-10 countries, the map, `peer_count_history`, the version mix, and
(via the MAX-upsert into `seen_peers`) the Year ranking. Only *All Time* was right, because it
ignores `last_seen` and every Healthy row did handshake at least once.

Measured on the NY box (2026-09-26, `get_peers` read directly): **1,085** Healthy+UA rows (what
"month" showed) against **183** with `last_connected` in the last 30 d (28 in 1 d, 99 in 7 d,
302 in 90 d). Same node, same store — the gap is the counting rule, not server capacity. It
surfaced because the pool's network map (N-04), which already used `last_connected`, read about
a sixth of world.grin.money.

#### The fix
- `_fetch_all_peers_from_node` carries `last_connected` as `last_seen` and skips rows with none.
- `_update_peers` windows the store to `PEER_HISTORY_DAYS` **before** anything consumes it — map
  upsert and the version snapshot alike (`stat_all` = whole store, `stat_peers` = windowed).
  The version snapshot also unions in every **connected** peer: `last_connected` is set once, at
  the handshake, so a weeks-long session has an old stamp and the windowed store alone would
  drop exactly the most stable nodes (caught by an old-vs-new end-to-end run, 2026-09-26).
- **One-off repair** `_repair_inflated_peer_stamps` (per network, meta flag
  `peer_stamp_repair_v1_<net>`): clamps `known_peers` / `seen_peers` `last_seen` down to the
  store's `last_connected`, because MAX-upserts can never lower an inflated stamp — without it
  week/month would stay wrong for 30 days and Year for a year. Runs before the connected-peer
  upsert, so a peer connected now is re-raised in the same run. Skipped (retried next run) for a
  network whose store read returned nothing. Accepted costs: a peer that was continuously
  connected earlier and has since dropped is clamped to its older handshake time — an undercount
  on a few rows, never an inflation; and a row whose IP is no longer Healthy in the store has
  nothing to repair against, so it keeps its old stamp and ages out (≤30 d for week/month,
  ≤365 d for Year). Month may therefore read slightly high for its first 30 days.

#### What the operator sees
Week/month counts drop to (about) the real figure on the first run after deploy; Year settles as the
repaired rows age out. `peer_count_history` keeps its inflated past samples (not rewritten), so
the history chart shows a one-time cliff at the deploy. 06d's "Node peers · 30d" card reads
`timeframes.month` from world.grin.money and drops with it. The version chart now reflects nodes
reached in the last 30 d, not every version the node ever met.

### As built — the dateline seams the raster used to hide

First live deployment showed two full-width horizontal bands across the map, one at ~65 °N
and one at ~16 °S. They are not a bug in the swap: **Natural Earth stores Russia, Fiji and
Antarctica with a ring that steps straight from `+180` to `-180`**, which in lon/lat is
valid shorthand for *continues on the other side* and on a flat canvas is a straight line
across the whole world. The ring returns at a slightly different latitude, so the pair
fills as a band. Measured, not guessed — exactly three offending features per tier:

| Country | Crossings per ring | Band at |
|---|---|---|
| Russia | 2 | ~65 °N (110m); ~65 °N and ~71.5 °N (50m) |
| Fiji | 2 | ~16 °S |
| Antarctica | 1 | ~84.7 °S (110m); ~90 °S and ~84.3 °S (50m) |

⚠ **This is the hidden cost of owning the geometry, and it was not in rev 2's risk list.**
A tile server cuts geometry at the dateline before it ever reaches a browser; that cut was
part of what CARTO was doing for us, and nothing in the swap plan replaced it.

`amRepair()` in `index.html` now does it, once per tier on the cached decode (0.4 ms 110m,
1.8 ms 50m; +22 / +29 vertices). The two ring shapes need **opposite** repairs, which is
why it is not a one-line "drop the long segment":

- **Even crossings** — the ring genuinely straddles the dateline. Cut it at each crossing,
  rejoin the head and tail pieces (a closed ring's last point is its first), and close each
  piece along the dateline edge it starts and ends on. Fiji becomes its real lobes, Russia
  its mainland plus Chukotka.
- **Odd crossings** — the segment *is* the ring's closing seam and the polar cap edge is
  simply absent from the data (Antarctica). Closing the two ends directly would recreate the
  band, so they are closed over the pole instead, walked in 90° steps so the output still
  satisfies "no segment spans more than half the world". Leaflet clamps to ±85.0511 on
  projection, so it renders as the fill-to-the-bottom-edge every web map shows.

**The repair belongs in the renderer, not in the assets.** Pre-cutting the committed files
would be silently undone by the `curl` in `assets/README.md`'s *Regenerating* recipe — the
files are correct as published. That README now carries the seam table and a verification
step: *more than three wrapping features means the repair has cases it was never measured
against*.

Local harness (`amRepair` extracted from the page, run over both committed tiers) asserts
feature count unchanged, every ring closed, no ring under 4 points, planar area unchanged
for all 174/238 untouched features, and no segment spanning more than 90° — plus a mutation
run without the repair, which reports 360° and proves the check can fail.

### As built — three follow-ups from the first live look

All three came out of the same screenshot that showed the dateline bands, and all three
are in `index.html` only — no asset changed, no deploy step changed.

**1. Land fill + border mesh, not 177/241 country polygons.** `buildBasemapFC()` now takes
fill from the file's `land` object and internal borders from
`topojson.mesh(topo, objects.countries, (a, b) => a !== b)`.

| Tier | Was (per country) | Now (land + mesh) |
|---|---|---|
| 110m | 177 paths, 10,587 verts | 2 paths, 7,956 verts |
| 50m | 241 paths, 99,539 verts | 2 paths, 80,303 verts |

The vertex saving is real but secondary. The visible reason is **ink**: drawn per country
every shared border is stroked twice, once by each neighbour, and the second country's
`fillOpacity: 1` then paints over part of the first one's stroke — that is the uneven
border weight across Europe. A border belongs to two countries but is one line.

Two things this costs, both accepted and neither measured in a browser:

- ⚠ **No country is a Leaflet layer any more.** Nothing hit-tests or highlights per
  country today (`interactive: false`, the dots own the pointer), but a future "click a
  country" feature has to undo this rather than extend it.
- ⚠ **Pan loses the per-layer `_pxBounds` early-out.** With 241 layers an off-screen
  country skipped `clipPolygon` entirely; with one world-spanning layer it does not, so a
  pan now runs one clip pass over all ~80k vertices (~1400 rings) instead of only the 2-10
  countries on screen. Bounded and small — clipping is 4 ops per vertex against a
  rectangle — but it is a real trade of the *cheap* number (pan was 0.1-2.1 ms) for the
  *expensive* one (`zoomend`, 11 ms at 50m, and the reason the tier system exists).

Also: `basemapStyleFor()` now takes the feature and returns different options per role.
`fill: false` on the border feature is not cosmetic — without it Leaflet closes and fills
the line mesh, painting a lake-shaped blob over half of Eurasia. And `applyTheme` must
hand `setStyle` a **function**, not an object, or every layer gets the land style.

**2. City labels: offset off the point, then culled.** The labels were centred on their
point (`translate(-50%, -50%)`). Peer geo is city-centroid and so is `cities.json`, so the
two sets **share coordinates by construction** — a centred label sat underneath the very
dot it was naming, and did so hardest in exactly the cities that had peers. The name is
now 4 px below the point with a 3 px tick left on the point itself.

The old rule was "overlaps are ACCEPTED, the lever is `CITY_LABEL_RANK_OFFSET`, never a
placement solver". ⚠ **That rule is withdrawn.** One rank threshold has to serve both a
crowded Europe and an empty Pacific, so every setting is wrong for half the map. The cull
is ~15 lines: sort candidates by scalerank, keep one only if its measured box clears
everything already kept — with the list **seeded from the peer dots first**, so a city
name can never be the thing covering the data. Text is measured on one reused canvas
(`measureText`), not in the DOM, so a pan costs no forced layout. `CITY_LABEL_RANK_OFFSET`
dropped 2 → 1: with a cull, a generous candidate list is strictly better.

Measured against the committed `cities.json` at 1068×566: **z2 50 labels, z3 101, z4 90,
z6 32, z8 4 — zero overlapping pairs at any of them**, where the same z4 view uncalled has
139 candidates and 38 overlapping pairs.

**3. maxBounds trimmed to `[-60, 84]`** from `±85.05`. North is 84 because the
northernmost vertex in the data is Greenland at 83.65 °N, so no land is lost; south is -60
because nothing below it has ever held a peer. ⚠ maxBounds limits **panning, not
rendering** — the box is 694 px tall at z2, so on a taller map the view is centred and the
polar geometry still draws; you simply cannot pan into it. The old ±85.05 box degraded the
same way above 1024 px. Raising `minZoom` so the box always fills would cost the
whole-world view, which is the view this map is for.

**Verification.** Two local vm harnesses, both extracting the real functions out of
`index.html` (no copy, so they cannot drift): the basemap one asserts the repaired
land+mesh has no segment over 90° of longitude, every ring closed, no ring under 4 points,
land area never *lost*, exactly one border feature and that it is a line, and land filled /
border unfilled in all four themes — plus a synthetic wrapping line, because the
`LineString` branch is dead against today's data. The label one asserts zero overlaps at
five zooms, that a dot beats the label sharing its coordinate, that rank decides a
collision and that the result is stable under input reordering, and that the CSS
`translate` Y and `CITY_LABEL_DY` agree — a mismatch there would mean every box the cull
computes is in the wrong place. Both carry a mutation run that fails without the change.
**None of this is a browser.** Nothing here has been rendered on the VPS.

### As built — Vietnam

Three operator requests, one theme: the map was the last surface that did not agree with
the rest of the page about Vietnam.

**Saigon, everywhere or nowhere.** `CITY_RELABEL` ("Ho Chi Minh City" → "Saigon") and the
`FLAG_SVG.VN` override have been in this page for a long time, used by the peer tooltip,
the peer list and the footer byline. The **basemap labels never went through them** — they
printed `cities.json` raw — so the map said *Ho Chi Minh City* while every readout pointing
at it said *Saigon*. `rebuildCityLabels` now calls `displayCity()`. ⚠ It must relabel
**before** measuring: the cull reserves a box from `measureText`, so measuring the raw name
would reserve space for text nobody sees.

**The flag is geometry, not a pattern.** Vietnam is filled yellow and then the same
polygons, clipped to three latitude bands, are filled red.

- Fitted in **projected space**, not degrees — a flag has equal stripes on screen, and 5°
  of latitude at 23 °N is not the same number of pixels as 5° at 9 °N. `clipRingHalf`
  interpolates the cut in Mercator y for the same reason: that is the space Leaflet draws
  the edge in.
- ⚠ **Not a `CanvasPattern`.** Leaflet will accept one as `fillColor`, but a pattern tiles
  in *screen* space — it would repeat across the country and slide under it on every pan.
- `stroke: false` on the stripes, or every band edge draws as a red line across the
  country; and `vn-base` re-draws its own outline, because the merged land fill is painted
  before it and would otherwise swallow Vietnam's coastline.
- The flag colours are **fixed**, not theme tokens. A flag does not restyle; these three
  roles are the deliberate exception to everything else on the basemap following the theme.

⚠ This is only possible because the flag needs Vietnam as its **own** geometry — which the
land+mesh change above had just taken away. `vnFlagFeatures()` reads `objects.countries`
again for that one country. Paths go 2 → 25; vertices 7,956 → 8,047 (110m) and 80,303 →
81,096 (50m), still well under the 10,587 / 99,539 of the per-country version.

⚠ **The flag had three definitions and two of them disagreed.** `FLAG_SVG.VN`'s
hand-written rects put the three stripes 7.5% of the flag height **below centre**; the
footer's inline `<svg>` had them centred, and used a different yellow (`#FFCD00` against
`#f9d616`). There is now one `VN_FLAG` constant — stripe 1/9 tall, gap 1/9, centred — and
`FLAG_SVG.VN` is generated from it. The footer is static HTML and out of reach from there;
it is still the odd one out.

**The East Sea islands were never in the data.** Neither mounted tier holds any land
between 110 °E and 118 °E, so this was not a regression. They are in the un-mounted 10m
file only, where Natural Earth files the Spratlys as their own entity and the Paracels
under China — and all 19 islets are 0.4–2.4 km across, which is sub-pixel below ~z7 and a
few pixels at `maxZoom` 10. Mounting 3.5 MB would not have made them visible. The 19
centroids are inline in `VN_ISLANDS` and drawn as **fixed-pixel dots** (`pointToLayer` →
`circleMarker`, radius 2), plus two labels via a new `MAP_EXTRA_PLACES` list that goes
through the same rank filter and the same cull as any city.

⚠ **Drawing them as Vietnamese is the site operator's editorial choice, not the data's
attribution.** It is marked as such at `VN_ISLANDS`, in `assets/README.md` and here, in all
three cases with the instruction not to "correct" it without asking. Recorded so a later
reader does not mistake it for a data error.

**Verification.** The two harnesses grew with it: the basemap one asserts one base, exactly
three stripes and 19 island Points, that each stripe lands on its `VN_FLAG` fraction of
Vietnam's bbox **measured in Mercator space** (matches to 1e-6 in both tiers), that no
stripe clipped away to zero area, that draw order is land → flag → border, and that the
flag colours are fixed while land and border stay themed in all four themes — plus that
`VN_FLAG`'s own stripes are equal, evenly gapped and centred on 0.5, which is the check the
old hand-written rects would have failed. The label one asserts the basemap renders
"Saigon" and never the raw name (reading `CITY_RELABEL` out of the page rather than copying
it), that both archipelago labels are hidden at z3 and shown at z4 and z8, and that an
extra place is culled by a peer dot exactly like a city. Still no browser, still nothing
rendered on the VPS.

### Option D addendum — the deploy is the copy AND the restart

**Found on a live box:** the six tool pages 404'd for every visitor while the homepage
already showed their cards. Not nginx — the vhost has no `root` and no `try_files`, and
its catch-all `location /` proxies every path to `127.0.0.1:8471`, so it cannot 404
`/proof`. The app did.

**Why it splits that way, and why it is invisible:** the two halves of a page have
different lifetimes in this server. Page *shells* are `readFileSync` per request
(`sendEntityPage`), so a redeployed `index.html` serves its new tool cards on the next
hit. *Routes* live in `server.js`, read into memory once at exec. `tinyx_install`
redeployed both and then ran only `systemctl daemon-reload` — which re-reads unit files,
never the process. Result: new pages, old router, every new link 404 out of the catch-all
handler. It reads as a broken build rather than a stale one, which is what made it cost a
debugging session instead of a restart.

`config.json` has the same lifetime as `server.js` — `JSON.parse` once at startup, never
re-read — so `tinyx_configure` had the identical hole. The sharp edge there is the Wallet
Checker Tor probe: the page decides whether to offer the button from
`window.TINYEXP_WALLET_PROBE`, injected at render from the value the *process* holds, so
turning it on without a restart looks like a toggle that does nothing.

**Fixed, in one helper rather than three copies** — `tinyx_restart_if_running <what>`
(no-op when the service is down, since the caller's own Start step will pick the new state
up; rc 1 only when a restart was attempted and failed):

| Path | Before | Now |
|---|---|---|
| `1) Install` on a running box | copied files, `daemon-reload`, stopped | restarts, and says *"updated"* rather than *"installed"* |
| `2) Configure` on a running box | wrote `config.json`, pointed at `Start` | restarts, then points at `Setup Nginx` |
| `4) Setup Nginx` with a new domain | vhost moved, `config.json` left behind | offers to sync `domain`/`base_url`, then restarts |
| `6) Status` | could not see the state at all | warns when app files or config are **newer than the running process** |

The Status check is the durable half: it compares the service's `ActiveEnterTimestamp`
against the newest file under `app/` (excluding `node_modules`) and against `config.json`'s
mtime. `tar` preserves mtimes on deploy, so a file's mtime is its checkout time — newer
than the start time means it arrived after the process did. That makes this whole class of
bug self-announcing for **any** future code change, not just this one.

**Not changed, deliberately:** `4) Setup Nginx` needed no new `location` block for the six
tools. Every tool route is a page or an `/api/` path, and both are already covered — the
catch-all and the `/api/` prefix — with the two probe routes carrying their own exact-match
blocks from the phase-2 work. A tool that needs a *new* nginx rule would be the exception,
not the rule.

**Same shape, still open elsewhere:** `grinscan_install` in `scripts/lib/06b_grinscan.sh`
deploys with `cp -r` and ends at `daemon-reload` with no restart, exactly as this did;
`grinscan_update` restarts. Not touched here — it is a separate product's lifecycle.

### Option D addendum — the crawl surface

Six tools had shipped since 2026-09-05 and nobody had asked what a search engine
made of them. The answer turned out to be *mostly good, with three holes* — and one
of the holes was large enough to affect how the whole domain is assessed.

#### What was already right

Every tool page carried a unique keyword-led `<title>`, a long specific
`description`, OG + Twitter tags, a self-canonical and an `<h1>` matching its
title, all injected server-side by `injectGlobals()`. Discovery was never the
problem either: each tool is linked from `/` three separate times — the header
Tools dropdown, the prose intro, and the tool cards — all plain `<a href>` in
server-rendered HTML. **A sitemap was never going to make this site get found
faster.** That is worth writing down, because it is the reason the sitemap here
is justified on a different basis (below) rather than on the usual one.

GA4 was already universal rather than homepage-only: every page loads
`/js/analytics.js`, which is a *route*, not a file — it generates the gtag
snippet from `config.ga4_measurement_id` and returns a comment when that is
blank. That indirection is why coverage is uniform and why disabling analytics
is one config key. The 404 was the only page missing the tag; it has it now,
which is worth having, since a mistyped block hash landing on 404 is one of the
more useful things this site can measure.

#### Hole 1 — the homepage had no `<h1>`

The most important page on the site opened straight into `<h2>Tools</h2>`. The
header brand is a `<span>` inside a link — it repeats on every page, so it is
navigation, not a heading. Fixed with `.tx-index-h1`, deliberately restrained
(18px, one line) because this page's job is the stats and the block table; the
descriptive half drops to its own line under 560px and sheds its em-dash via
`::before`, so the dash lives in CSS rather than in the markup.

Three *more* H1 bugs fell out of the test written to cover that one:
`block.html`, `kernel.html` and `output.html` each carried **two** — one in the
loading skeleton and one in the real content. Only ever one is visible
(`#block-content` starts `display:none`), but both are in the DOM. The skeletons
are placeholders, not headings, so they became `<p class="tx-block-h">` sharing
the same style rule.

#### Hole 2 — `/block/:ref` was a crawl trap (the big one)

Roughly four million heights, every one marked `index, follow`, every one
carrying the **identical** title and description, none with a canonical, each
rendering `Loading block…` until JS resolves. Mass near-duplicate thin content,
competing for crawl budget with the seven pages that can actually rank. On a
**pruned** node it is worse than duplicate: `get_block` fails below the pruning
horizon, so most historical heights cannot render a body at all.

Entity pages and the 404 are now `noindex` — and, deliberately, still **follow**.
Three decisions are worth preserving:

- **`noindex`, not `nofollow`.** The pool deep-links into `/block/<height>` from
  outside. Those are real inbound links; `follow` lets them reach the rest of the
  site through the header nav instead of dead-ending.
- **`noindex`, not `Disallow: /block/` in robots.txt.** This is the trap. A
  disallowed URL can still be indexed as a bare listing when something links to
  it, and a crawler forbidden from fetching the page **can never read the
  noindex**. Never block a path you want de-indexed. `test-seo.js` asserts the
  absence of that Disallow, because adding it would look like a tightening.
- Entity pages already carried **no canonical** (they are per-ref), which pairs
  correctly with noindex and needed no change.

#### Hole 3 — no structured data on the tools

Only `/` had JSON-LD (a `WebSite` block). The six tools are now each a
`WebApplication` — which is what they are: free, browser-run utilities with one
job apiece — via a `TOOL_SCHEMA` map keyed by page key. Pages absent from that
map get none, which is the right answer for the noindex shells.

The markup obeys two rules carried over from the pool's audit §J15-3, both
asserted by tests: it may assert **no identity the operator does not own** (no
`sameAs`, no `SearchAction` pointing at an endpoint nobody serves, no invented
`aggregateRating`), and `url` is emitted **only when `base_url` is configured** —
it is the one field here that can name the wrong host.

#### The sitemap, and why it is justified on reporting rather than discovery

`/sitemap.xml` and `/robots.txt` are both **generated routes, never static
files**, sitting above `express.static` (below it, the plain file answers first
and the annotation never ships). Neither could be checked in: a committed
`sitemap.xml` would be either invalid (relative URLs) or an advertisement for the
toolkit author's domain from an operator's box. With no `base_url` the sitemap
**404s** and robots.txt simply omits its `Sitemap:` line — there is no honest
absolute URL to publish, so it publishes none.

Its value is Search Console per-URL coverage reporting (*"Crawled – currently not
indexed"* vs *"Discovered"*), not discovery. It lists only the seven stable
pages; `block`/`kernel`/`output` are absent, because a sitemap is a list of pages
you want indexed, not an inventory of a chain.

`robots.txt` keeps its **rules** in `public/robots.txt` — one source of truth for
what is disallowed — and the route appends only the line that needs the host.
`lastmod` is read from each shell's own **mtime**, never a hand-kept date: a date
typed into the source goes stale the first time someone edits a page and forgets
it, and a sitemap that misreports freshness is worse than one omitting the field.
An unreadable shell omits `lastmod` rather than inventing one.

**Deploy note:** both are routes in `server.js`, so a redeploy that does not
restart the service serves the old router — exactly the failure documented in the
*deploy is the copy AND the restart* addendum above. nginx needs no new
`location`: it proxies **all** paths to the app.

#### `test-seo.js` (22 assertions)

A new suite, because every claim in this section is **invisible in a browser**.
A wrong robots directive, a sitemap naming the wrong host, a JSON-LD block
asserting an account nobody owns — none change a pixel, none throw, and the
feedback loop is a Search Console graph weeks later.

It **executes** the sitemap and robots handlers rather than pattern-matching them,
lifting both out of the server source and running them against a stub `app`, with
and without a configured `base_url`. No socket, no express — 06d still has exactly
one npm dependency. The H1 count assertion deliberately collects **all** offenders
before failing: a per-file assert would have reported `block.html` alone and
turned one bug into three rounds of fixing.

#### Still open

The `/mining` description was updated to mention payback, which the page has
computed since earlier the same day — a reminder that `_pageMeta` is prose about
a feature set and goes stale silently when the feature set moves.

### Review pass — closed except the VPS run

Parts 1-8 were run on 2026-09-05. The review over that working tree — four confirmed defects plus
per-session review prompts R1-R8 — is **kept outside the repo** alongside the build plan
(`D:/tmp/grin-toolkit-plans/`, see `docs/reference/README.md`). What follows is its durable
outcome; the blow-by-blow stays in the plan file.

**R1-R5 and R8 are run and landed. R7 was superseded and absorbed into R8, so it never ran as its
own session. R6 — VPS acceptance, Part 9 — is the only thing left in the entire six-tool
expansion, and it has still never run.** Nothing in this expansion has been served by the real
server behind the real nginx vhost.

Six confirmed defects were found and all six are fixed: `/node-check` rendering a rejected input
as an unreachable node; `/slate` being the one tool off the shared chrome; the homepage grid order
contradicting `TOOLS_MENU_GROUPS`; `--green`/`--red` never re-declared for dark; `--accent`
illegible on light (found by rendering, after R1 had "fixed" contrast without measuring it); and
hidden tooltips giving `/` and `/emission` a permanent horizontal scrollbar at exactly the width
the page is normally viewed at.

Three things worth carrying forward, because each is a trap rather than a fact:

- **Resolve a colour per ground, per theme, and read it from the rendered pixel.** The palette now
  carries three inks — `--green-ink` / `--red-ink` (R1), `--accent` (R3) and `--gold-ink` (R8) —
  beside the fill tokens they were split out of. `--gold` is fill only; `--link` is an *alias* of
  `--gold-ink`, not a second value. The one exemption is `.tx-title .tx-accent`, the wordmark.
  Every text site measures >= 6.03:1 on both themes, and coverage is checked mechanically (sweep
  all 11 pages in both themes for a computed `rgb(255, 140, 0)`; exactly one element matches, and
  it is the wordmark) because the failure mode of this class is a site nobody thought to look at.
- **R4 settled the payment-proof byte layout without a VPS**, against a real `PaymentProof` that
  grin-wallet's own CI asserts byte-for-byte. `/proof` ships. What remains open is bounded and
  stated in `lib/payment-proof.js`'s header: dalek's non-strict `verify` vs Node's OpenSSL, which
  needs a Rust toolchain and can only make this tool *stricter*, on a crafted file, failing closed.
- **An aria-live region must be unhidden BEFORE its content changes.** A `display:none` subtree is
  not in the accessibility tree, so a mutation made while hidden is one several screen readers
  never announce. `renderProbeResult()` was the one region appending first; it now unhides first,
  and the comment says why so the next edit cannot tidy it back.

**The checks are re-runnable now** — `web/06d_tiny_explorer/test/`, 98 assertions over
`node test/run-all.js` (or `npm test`), still with express as the only npm dependency. It pins
R4's real-wallet fixture and its eight negative controls, the SSRF blocklist and `parseTarget`,
and the browser Keccak against node's sha3-256 **at the 135/136/137 rate boundary**. Before R8
every one of those results was a claim in a document, because each had run in a harness that was
then deleted. `test/` is excluded from the VPS deploy by `tinyx_deploy_files()`, which also
replaced two unguarded `cp -r` calls.

`/api/node-check` gained the total in-flight cap R5 specified (`node_check_max_inflight`, default
8, a 503 carrying the `base` shape with `code: 'busy'`). It is a different control from the nginx
zone: the limiter counts requests per IP, the cap counts outbound sockets in total, and Node's
default agent is `keepAlive:true` / `maxSockets:Infinity`. Its client verdict carries `rows:false`
— a 503 that never dialled must not draw `Checked:` plus two `unavailable` rows.

## Runbook

- **Tests:** `cd web/06d_tiny_explorer && npm test` (`node test/run-all.js`; express is the only npm dependency; `test/` is excluded from the VPS deploy by `tinyx_deploy_files()`). Each suite lifts the real functions out of the shipped files rather than testing a copy.
- **A deploy is the copy AND the restart.** Routes and `config.json` are read once at process start; page shells are read per request. After any redeploy or Configure, confirm the service restarted — `tinyx_status` (Script 06 → `D` → Status) warns when app files or config are newer than the running process. Details: *Option D addendum — the deploy is the copy AND the restart*, above.
- **Turn the Wallet Checker Tor probe on for an existing box:** Script 06 → `D` → `2` Configure (the prompt now defaults to yes and installs tor on consent).
- **After deploying a collector fix that changes counting:** expect a one-time cliff in `peer_count_history` (past samples are not rewritten).
- **Syntax:** `bash -n scripts/06_global_grin_health.sh scripts/lib/06*_*.sh`; `node --check web/06d_tiny_explorer/tiny-explorer-server.js`; `python3 -m py_compile scripts/lib/06_collector.py`.

## Build notes — obstacles & lessons

Most of this product was found on live boxes or by rendering, not on paper; the long records above are the evidence. Bulk commits carry the changes (`git log -S<symbol>` finds the exact line); the pre-G7 text of this doc, with its plan and as-built sections interleaved: `git log -- docs/reference/script06_design.md`, the commit before the G7 re-org (2026-10-13). Memory sources: `project_tiny_explorer_06d`, `project_slate_inspector_06d`, `project_peer_map_location_grouping`, `project_selfhosted_basemap_06`, `project_payment_proof_fixture`, `project_stats_top10_timeframe_toggle`, `reference_grin_peer_store_last_connected`.

### Tiny Explorer server

#### A u64 nonce rounded past 2^53
**Symptom:** a block's PoW nonce displayed wrong. **Cause:** `JSON.parse` rounds integers past 2^53. **Fix:** the raw JSON-RPC text is regex-quoted *before* parsing, with a regex **literal** (`BIGINT_FIELD_RE`) — the `new RegExp(\`…\\s…\`)` template form silently drops the backslash in `\s`/`\d`, leaving the nonce unquoted and rounded. **Lesson:** a regex built from a template string loses its escapes without an error; the same u64 → BigInt rule applies in the slate decoder.

#### A stalled archive node held every visitor's page hostage
**Symptom:** during chain compaction an archive node's API stayed shut for 8–10 h; ~90 sockets piled up in CLOSE-WAIT on :3413 and visitors got 502s the whole time. **Cause:** every page view opened a fresh node connection that waited out the full 10 s timeout. **Fix:** a circuit breaker at the one choke point (`nodeRpc`) that opens on the first transport failure, fails fast with `NODE_BUSY`, and lets exactly one probe through per backoff; identical in-flight calls share one connection; routes serve stale bodies (bounded by `stale_max_ms`) with `stale: true`/`as_of`. The explorer cannot fix the stall; it can stop making it worse and stay readable. **Lesson:** an RPC-level answer (`Err`, unparseable body) is still an answer and must never trip the breaker — a `NotFound` must keep meaning "not found".

#### A busy node turned valid pool permalinks into 404s
**Cause:** a busy node made `fetchBlockLive` return null, which the route read as "no such block". **Fix:** `/api/block|kernel|output` answer **503 `{error:'node busy'}` + `Retry-After`**; the body is what separates it from nginx's `tinyx_api` limiter 503. `getLatest` stopped caching `[]` when every fetch failed (that wiped the table serve-stale needs), and confirmations are never computed from a stale tip (a frozen tip under-counts them).

### Slate Inspector

#### It shipped as the one dead-end page
**Symptom:** `/slate` was a self-contained dark-only page with no Tools dropdown, no search, no theme toggle and no light rendering. **Cause:** it was written when it was the only tool. **Fix:** moved onto the shared chrome; `slate.css` is an `sp-*` overlay for the widgets alone (those class names are a contract with `slate-ui.js`, and `var(--sp-green)` is inlined by it, so that token must keep existing); `_pageMeta.slate` no longer pins a dark `theme-color`. **Lesson:** a page that predates the hub needs a pass when the hub arrives.

#### Facts that shape the decoder (verified, not assumed)
Mode 1 (encrypted) is opaque by design — a keyless reader recovers only version and mode, not even the step, and an S2/I2 from grin-wallet is mode 1 regardless of how S1/I1 was made (`ret_address = slatepack.sender`, confirmed by a live plaintext-S1 / sealed-S2 test); SlateV4 carries no network field, so the only network signal is the sender address's bech32 HRP; amounts are u64 → BigInt; `WebCrypto` needs a secure context.

### Peer map

#### Co-located peers drew as one dot
**Symptom:** only the last of N stacked circles was hoverable and the panel total disagreed with the visible dots. **Cause:** geo is city-centroid, so every peer in a city carries byte-identical coordinates; every dual-stack host was a guaranteed 2-stack. **Fix:** one dot per rounded coordinate (`COORD_DP = 2`, ~1.1 km), sized `min(16, 5 + 3·√(n−1))`; dedup inside a group is dual-only (two unrelated hosts in one /24 share the masked string and must both count); click drills down through a `LOC_FILTER` rather than zooming. **Lesson:** group on the coordinate, not the city name (it can be blank or labelled differently by two providers), and not on pixel distance (zoom-unstable).

#### Marker stacking is by pane, not insertion order
Leaflet puts canvas circles in `overlayPane` (z 400) and `DivIcon`s in `markerPane` (z 600), and stacks DivIcons by `pos.y + zIndexOffset` — so "largest first" achieves nothing; group-vs-group ordering is a `zIndexOffset: -d`. A lone dot within a dot's width of a big group stays covered at low zoom (accepted; zooming separates them).

#### A masked IP needs a salted `node_id`
Two hosts in one /24 render as the same masked string and, on the standard port, byte-identical rows. The collector emits `node_id = sha256(salt|real_ip)[:4]`: the salt (`meta.node_id_salt`, 128-bit) never leaves the box — unsalted, the id would hand back the octet `_mask_ip()` removed, as the /24 is public and there are only 256 candidates. The front end probes `HAS_NODE_ID` so an older `peers.json` degrades the search placeholder instead of promising a search the data cannot answer.

#### `bringToFront` is a FeatureGroup method
`applyTheme()` called `markersLayer.bringToFront()` on an `L.layerGroup()`, a TypeError that was harmless only because nothing ran after it. `markersLayer` is now `L.featureGroup()`.

### Collector

#### Peer counts read a field that does not exist
**Symptom:** week/month node counts, Top-10 countries, the map, `peer_count_history` and the Year ranking all counted every node the store had ever reached; the pool's network map (which used `last_connected`) read about a sixth of world.grin.money. **Cause:** the collector read `last_seen` from each `get_peers` row, but grin's `PeerData` has no such field (the handshake time is `last_connected`), so it was 0 and the "0 → `ts − 60`" fallback stamped every Healthy peer "a minute ago" on every run; grin never expires Healthy rows. Measured: 1,085 Healthy rows vs 183 with `last_connected` in 30 d. **Fix:** carry `last_connected` as `last_seen`, window the store to `PEER_HISTORY_DAYS` before anything consumes it (the version snapshot also unions every *connected* peer — a weeks-long session has an old stamp), and run a one-off `_repair_inflated_peer_stamps` (MAX-upserts can never lower an inflated stamp). **Lesson:** a fallback that invents a timestamp turns a missing field into plausible data; verify a field exists in the source struct.

### Basemap

#### A keyless tile provider failed by watermarking with HTTP 200
**Symptom:** the map showed watermarked tiles; nothing 404'd, nothing reached the logs, no JS error fired. **Cause:** CARTO now requires a key on that host and serves keyless requests watermarked instead of blocked; vector basemaps are next, and the free key still leaks every visitor's IP to a third party. **Fix:** draw the basemap as a vector overlay from Natural Earth data committed to the repo (no tiles, no server, no runtime dependency). **Lesson:** the watermark is the error message — undebuggable from our side; own the geometry or accept silent policy changes. Owning it has a hidden cost (dateline seams, below).

#### "No vhost change" was wrong
**Cause:** nginx's built-in `gzip_types` default is `text/html` only (Debian ships the wider list commented out, the nginx.org package ships `#gzip on;`), so the 4.5 MB of JSON would not have been compressed. **Fix:** declare gzip at server level in the stats vhost (not in `nginx.conf`, which a package upgrade resets); `location /assets/` with a 30-day `Cache-Control`; the asset copy is guarded (`|| { die …; return 1; }`) and presence-checked because `install_stats()` runs with errexit disabled; `topojson-client` is vendored, not downloaded.

#### The 10m tier was never wired — the prediction aimed at the wrong event
**Measured (Ryzen 5 PRO 3400GE):** 10m mounts in 300 ms and costs 87 ms on **every `zoomend`**, because `Renderer._onZoomEnd` re-projects every layer with no culling (546,001 points); pan at z8–10 is cheap (`Path._clipPoints` early-outs on `_pxBounds`). So bands ship as 110m for z2–4 and 50m for z5–10. Unlocking 10m means culling by viewport *before* projection (a z10 view over Europe intersects ~18% of the vertices). **Lesson:** measure the event you actually pay for before committing to a tier.

#### The dateline seams the raster used to hide
**Symptom:** two full-width horizontal bands at ~65 °N and ~16 °S. **Cause:** Natural Earth stores Russia, Fiji and Antarctica with a ring that steps straight from +180 to −180 — valid in lon/lat, a straight line across the world on a flat canvas. A tile server cut geometry at the dateline before it reached a browser; nothing in the swap replaced that. **Fix:** `amRepair()` in the renderer (even crossings: cut and close each piece along the dateline; odd crossings, Antarctica: close over the pole in 90° steps). The repair belongs in the renderer, not the assets — pre-cutting the committed files would be undone by the regeneration recipe. `assets/README.md` carries the seam table: more than three wrapping features means the repair meets cases it was never measured against.

#### Per-country polygons stroked shared borders twice
Land fill now comes from the file's `land` object and internal borders from `topojson.mesh(…, (a, b) => a !== b)` (177/241 paths → 2). The visible reason is ink: the second country's `fillOpacity: 1` painted over half of the first one's stroke (uneven border weight across Europe). `fill: false` on the border feature is not cosmetic (otherwise Leaflet fills the line mesh into a lake-shaped blob), and `applyTheme` must hand `setStyle` a function, not an object. Costs accepted: no country is a Leaflet layer any more, and pan loses the per-layer `_pxBounds` early-out.

#### City labels sat under the dot they named
**Cause:** peer geo and `cities.json` are both city-centroid, so they share coordinates by construction. **Fix:** the name is offset 4 px below the point, then culled — candidates sorted by scalerank, kept only if the measured box clears everything already kept, with the list seeded from the peer dots first so a name can never cover data; text is measured on one reused canvas (`measureText`), not in the DOM. The earlier rule "overlaps are accepted, never a placement solver" was withdrawn: one rank threshold cannot serve both a crowded Europe and an empty Pacific. Labels relabel (`displayCity()`, "Saigon") *before* measuring.

#### The Vietnam flag has to be geometry, and was defined three times
A `CanvasPattern` fill tiles in screen space and would slide under the country on every pan, so the flag is Vietnam's own polygons clipped to three bands, fitted in projected (Mercator) space. `FLAG_SVG.VN`'s hand-written rects sat 7.5% of the flag height below centre and the footer used a different yellow; there is now one `VN_FLAG` constant. The East Sea islands were never in the mounted tiers (all 19 are sub-pixel below ~z7), so they are fixed-pixel dots from an inline `VN_ISLANDS` list — an editorial choice by the site operator, marked as such in three places with the instruction not to "correct" it without asking.

### Tools

#### Mining Calculator numbers shipped invented, then wrong
**Symptom:** preset rows `G1 1.2 / 970` and `G1 Mini 0.3 / 240` — the Mini's hashrate put on the G1 and both wattages made up; GPU rows started as guesses (the RTX 4090 at an invented 2.2 G/s against a sourced 1.40, a 57% overstatement). **Fix:** every row names its source and a row with no source does not ship (manufacturer spec for ASICs; whattomine's Cuckatoo32 table for GPUs, kept to one source rather than averaged — two sources disagree by up to ~25% and splitting the difference produces a number no source stands behind); a claim the cited source contradicts (≥ 11 GB VRAM) came out. **Lesson:** the repo already held the correction — grep the product's own strings before any web source.

#### Break-even does not move with the unit count, and that reads as a dead field
The count multiplies both sides of `powerDay / grinDay` and cancels exactly (payback is scale-invariant for the same reason). Driving the shipped `initMining()` through every entry sequence reproduced no bug; the fix was copy ("unchanged by unit count, it scales both sides"). The count multiplies a per-unit *basis* into the visible boxes rather than entering the maths, so no figure on screen can disagree with the money below it.

#### Power draw is a rate, and the failure card blamed the wrong input
Power draw was read as a daily total (now labelled `(W, continuous)` with a live "2.9 kWh a day" line). `/api/stats` failures left cards on `loading…` indistinguishable from a slow network; the rejection now names the cause (503 = nginx limiter, 502 = the handler's catch-all, bare error = the browser). The price card said "unavailable" during a node outage although the price comes from gate.io/CoinGecko and needs no node — it shipped inside the node-backed payload; `GET /api/price` is now the node-free half. `render()` blames one blocker in the order the reader can act on (network basis → own hashrate → price), and `miningEstimate()` requires `gps > 0` so a rig nobody described does not answer a confident 0 ツ/day.

#### A reachability check was right about the address it dialled and wrong about the question
**Symptom:** `api.grin.money` — a node this toolkit publishes — reported "Not reachable". **Cause:** `parseTarget()` defaulted a bare host to `http` + 3413, but Script 04 binds the node to localhost and fronts it with nginx on 443. **Fix:** a bare **name** now assumes `https://name:443`; a bare **IP** assumes `http://ip:3413` (an IP literal gets no SNI, so https lands on `tls_error` whatever runs there); `parseTarget()` returns `assumed`, the route attaches a `suggest`, and the client shows a one-click retry pointing *away* from the assumption — the default and the retry are two ends of one mechanism. Dialling both was rejected: one attempt per question keeps the failing path from costing two outbound requests. `busy`/`blocked`/`bad_input`/`dns_failed` get no suggestion (a queue-is-full banner ending "try https://" invents a finding for a request that never left the box).

#### One leg of a check drew a correct configuration as a red cross
A node that peers correctly and deliberately keeps its API off the internet is a correct configuration. The checker now reports two legs separately — Wallet API (a parsed `{"Ok":{height}}`) and P2P (a bare TCP connect, labelled "port open", never "node reachable", and asserted never to `.write()`) — and `composeVerdict()` makes two of four combinations warnings. The P2P port is never visitor input (a connect-only probe on an operator-chosen port is a port scanner with a Grin logo on it). Controls: DNS-resolve then block the *resolved* address (loopback, RFC1918, link-local, CGNAT, `::1`, `fc00::/7` — DNS rebinding defeats a hostname check); no redirects; both legs dial the same cleared address; the in-flight cap counts checks, not sockets (a check holds two).

#### The Wallet Checker probe has two defaults on purpose
Installer default `true` (a fresh box should answer the question most visitors open the tool for; `_tinyx_ensure_tor` can now install tor and polls until SOCKS is bound — a tor with `SocksPort 0` is "active" and proxies nothing), code default `false` (a `config.json` that lost the key must fail closed). The read-back before prompting is two-sided: an explicit value in the config outranks the default in both directions. The prompt's catch-all must keep the default (it used to answer *no* to `Y ` with a trailing space), and `read` at EOF must decline — with the default yes it reached `apt-get install tor` with nobody at the keyboard. **Rule: a catch-all may never name a value, and a printed default is an offer to a human.** Static page copy is config-neutral and describes what the *page* has done, never what the box can do; `test-probe-copy.js` asserts the id contract across five files because a renamed id makes the swap a silent no-op.

#### The payment-proof layout was settled without a VPS
The standing risk — every layout fact read from source, no real proof ever checked — was closed by grin-wallet's own Owner API rustdoc: a worked `retrieve_payment_proof` response that CI asserts byte-for-byte. The check is cryptographic, not textual (the 73-byte message — u64 **big-endian** amount ‖ 33-byte excess ‖ 32-byte sender key, no hashing, no domain separator — is an input to signature verification), eight negative controls each flip one field, and the layout is byte-identical at v5.4.1, v5.5.0 and master. The HRP is not signed (upstream's own `verify_payment_proof` doctest returns `Ok` under a `slatepack1` HRP), so the tool renders it as a claim and the mainnet-only kernel lookup is the only network evidence. The fixture is committed.

#### A missing kernel is `{"Err":"NotFound"}`, not `Ok(None)`
**Symptom:** a finalized-but-unmined proof — the normal state for the first minute after `finalize` — rendered "The node could not be reached", and `/api/kernel/<excess>` answered 502 instead of 404. **Cause:** `getKernel()`'s comment claimed `Ok(None)`; grin answers `kernel.ok_or(Error::NotFound)` and `unwrapResult` throws on every `Err`. **Fix:** map that one error to `null`; every other throw still means the node. Found by round-tripping a live mainnet `send -d` → `receive` → `finalize` → `export_proof`, which also surfaced the operator trap that `export_proof` fails with "Transaction does not contain a payment proof" on coinbase, received, invoice and manual-file entries. **Lesson:** the fixture could not have found either; a round-trip on a real wallet did.

### Review, deploy and crawl

#### Contrast and live regions found by rendering, not reading
A "contrast fix" shipped without measuring (`--accent` stayed illegible on light), `--green`/`--red` were never re-declared for dark, and hidden tooltips gave `/` and `/emission` a permanent horizontal scrollbar at the width the page is normally viewed. **Fix:** resolve a colour per ground, per theme, and read it from the rendered pixel — three inks (`--green-ink`/`--red-ink`, `--accent`, `--gold-ink`) beside the fill tokens, `--link` an alias of `--gold-ink`; every text site measures ≥ 6.03:1, and coverage is checked mechanically (sweep all 11 pages in both themes for a computed `rgb(255, 140, 0)`; exactly one element, the wordmark, matches). An `aria-live` region must be unhidden *before* its content changes — a `display:none` subtree is not in the accessibility tree.

#### The deploy copied the files and left the old router running
**Symptom:** the six tool pages 404'd for every visitor while the homepage already showed their cards. **Cause:** page shells are `readFileSync` per request, but routes live in `server.js` and `config.json` is `JSON.parse`d once at startup; `tinyx_install` redeployed both and ran only `daemon-reload`. It reads as a broken build rather than a stale one. **Fix:** one helper, `tinyx_restart_if_running`, used by Install, Configure and the domain sync, and a Status row that compares `ActiveEnterTimestamp` with the newest file under `app/` and `config.json` — `tar` preserves mtimes, so a newer mtime means the file arrived after the process. **Lesson:** make a whole bug class self-announcing. `grinscan_install` has the same shape and is not yet fixed.

#### A de-indexed page must stay fetchable
Roughly four million `/block/:ref` heights, every one `index, follow`, with an identical title and description and no canonical, were a crawl trap. They are now `noindex, follow` — **not** `nofollow` (the pool deep-links in from outside) and **not** `Disallow: /block/` in robots.txt: a crawler forbidden from fetching the page can never read the noindex, and a disallowed URL can still be indexed as a bare listing. `test-seo.js` asserts the absence of that Disallow because adding it would look like a tightening. Other holes: the homepage had no `<h1>` and three entity shells carried two (a skeleton and the real content); tools now emit `WebApplication` JSON-LD that asserts no identity the operator does not own (no `sameAs`, no invented rating) and `url` only when `base_url` is configured.

#### Sitemap and robots are generated routes
Both sit above `express.static` (below it the plain file answers first), because a committed `sitemap.xml` would be either invalid (relative URLs) or an advertisement for the author's domain from an operator's box. With no `base_url` the sitemap 404s and robots omits its `Sitemap:` line; `lastmod` is each shell's mtime, never a hand-kept date. Its value is Search Console per-URL coverage reporting, not discovery. `test-seo.js` executes the handlers against a stub `app` rather than pattern-matching them.

## Open items

- **Nothing in the six-tool expansion has been served by the real server behind the real nginx vhost** — the VPS acceptance run has never run. Everything above is verified in jsdom, vm harnesses and scratch end-to-end only.
- **Slate Inspector:** never tested against a slatepack produced by a real `grin-wallet` (all fixtures come from our own encoder, so a shared misreading would not be caught). First VPS action: decode a real testnet slatepack. Optional: read the kernel excess of a finalized slate and reuse `/kernel/<excess>` (mainnet only; must say "unavailable for testnet"). Wallet-backed send/receive/finalize remains blocked on a wallet decision.
- **Payment proof:** ed25519-dalek's non-strict `verify` vs Node's OpenSSL on adversarial encodings is unconfirmed (needs a Rust toolchain, not a VPS; the direction is known — it can only make this tool stricter, on a crafted file, failing closed). Whether any non-grin-wallet implementation writes a compatible file is unconfirmed.
- **Wallet Checker tier 2:** the rule that an HTTP 401 over Tor counts as *online* has never been exercised against a live listener.
- **Basemap:** the 10m tier needs viewport culling before projection; no browser or VPS has rendered the dateline repair, the land+mesh, the city-label cull or the Vietnam flag. The footer's inline flag SVG is still the odd one out of the three flag definitions.
- **Error handling:** `initEmission()` still swallows an `/api/stats` failure the way the Mining Calculator used to.
- **`_pageMeta` goes stale silently** when a feature set moves (the `/mining` description was found out of date once).
- **`grinscan_install`** (06b) deploys with `cp -r` and ends at `daemon-reload` with no restart, the same hole this product had.
- **Deferred:** a fee & weight calculator (the weight constants have moved across grin versions; read `core/src/consensus.rs` first), a seventh tool (the grid stays even — the next addition comes in a pair), PMTiles/Protomaps if the map ever needs roads, sharing the basemap data with the pool's network map.
