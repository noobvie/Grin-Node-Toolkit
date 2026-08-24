# Script 06 — Global Grin Health (design notes)

Only sections that need durable prose live here; the menu/wiring lives in
`scripts/06_global_grin_health.sh`. Options A (network stats), B (GrinScan),
C (grincoin clone) are documented in git history + their own libs.

## Option D — Tiny Explorer (`scripts/lib/06d_tiny_explorer.sh`)

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

---

## Option D addendum — Slate Inspector (`/slate`)

**Built 2026-07-23 (branch `add-ons`). NOT VPS-tested.** Verified locally: 83 assertions
green (37 decoder + 13 BIP-173 bech32 vectors + 33 end-to-end page tests in jsdom).

### What it is
A **read-only, keyless** slatepack reader on `scan.grin.money/slate`. Paste or drop a
slatepack → see amount, fee, which transaction step it is on, and mainnet-vs-testnet.
Purpose is education + **verification**: confirm a slatepack says what the sender promised
*before* acting on it.

It does **not** send, receive, sign, finalize, broadcast, or hold keys. That is phase 2 and
needs a real wallet backend (051 owner-API, or building 055 for real).

### Why it lives in 06d and not elsewhere
Same mental model as the existing `/block`, `/kernel`, `/output` deep links — paste an
opaque Grin artefact, get a human-readable readout. Reuses `sendEntityPage()` + `_pageMeta`.

**But unlike every other page here it makes NO node call.** A slatepack is a *pre-broadcast*
artefact, so it is decoded entirely in the browser; the pasted slate never reaches the
server. Consequence: it works identically for mainnet and testnet slatepacks with **zero
extra infrastructure** — no testnet node, no second explorer instance.

### Wire format (verified against grin-wallet source, not assumed)
| Layer | Detail |
|---|---|
| Armor | `BEGINSLATEPACK.` + payload + `. ENDSLATEPACK.`; SimpleBase58Check = first 4 bytes of `SHA256(SHA256(bin))` prepended, then standard bs58. Space every 15 chars, newline every 200 words. **No compression at any layer** (no deflate/zlib). |
| Envelope | version 2 B (major,minor) → mode 1 B → opt flags 2 B (`0x01` = sender present) → `bytes_to_payload` u32 4 B → optional sender (u8 len + **bech32 STRING**) → payload (`write_bytes` = u64 len + bytes) |
| Payload | **SlateV4 BINARY** (`VersionedBinSlate`), never JSON in practice |
| SlateV4Bin | `ver` 4 B (two u16) → `id` 16 B UUID → `sta` **1 B u8 0–6** → `off` 32 B → opt-status byte (`0x01` num_parts, `0x02` amt, `0x04` fee, `0x08` feat, `0x10` ttl) → sigs → opt-structs → feat_args |

Two facts that shape the whole design:

1. **Mode 1 (encrypted) is opaque by design.** The wallet *moves* the sender out of the
   header into the age-encrypted metadata. A keyless reader recovers **only** version +
   mode — no sender, no network, no amount. The default `grin-wallet send -d <addr>`
   produces mode 1, so the inspector is fully useful only for the **manual (no `-d`)
   plaintext flow**. This is a privacy property, not a gap.
2. **SlateV4 carries NO chain/network/genesis field.** Confirmed in source. This is the
   structural reason a testnet slate can be signed by a mainnet wallet and only fails at
   broadcast. The single network signal is the **bech32 HRP of the sender address**
   (`grin` = mainnet, `tgrin` = testnet) — and it survives into the bytes only because
   `SlatepackAddress` serialises as the bech32 *string*, not the raw 32-byte key.

### Implementation notes
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

### Theme
`/slate` is deliberately **self-contained cyberpunk** (`css/slate.css`, dark-only) and does
**not** import `tiny-explorer.css`. Index/block/kernel/output keep their existing look, so
this page carries zero regression risk. `injectGlobals()` now strips the shell's own
`theme-color` and injects a per-page one (`_pageMeta[key].theme`) — otherwise a duplicate
tag would win by document order and repaint the dark page orange.

### Wiring
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

### Known gaps / next
- **Not yet tested against a slatepack produced by a real `grin-wallet`.** All fixtures are
  built from the spec by our own encoder, so a shared misreading of the spec would not be
  caught. First VPS action: decode a real testnet slatepack and confirm the readout.
- Optional phase-1b: take the kernel excess from a finalized (S3/I3) slate and reuse the
  existing `/kernel/<excess>` lookup to answer "did it actually confirm?" — **mainnet-only**,
  must show "unavailable for testnet" rather than a misleading not-found.
- Phase 2 (wallet-backed guided send/receive/finalize + age decryption) remains blocked on a
  wallet decision: 051 owner-API, or actually building 055 (currently a COMING-SOON stub).

---

## Option D addendum — Tools hub + Emission page + mempool + sparklines (2026-07-24, `add-ons`)

**NOT VPS-tested.** Verified locally: 18 jsdom assertions green (Tools dropdown open/close/aria,
mempool render+hide, both sparklines, emission live figures + calc). `node --check` clean on
server + frontend; CSS braces 201/201.

**Why:** the Slate Inspector proved out the "utility beside the explorer" idea; a single CTA
banner + lone header button doesn't scale to two+ tools. This consolidates all tool discovery
into one **Tools hub** and adds the second tool (Emission).

### Homepage reorg (operator-directed order)
`header → "Why Grin stands out" + "What can you check here?" (education, moved ABOVE the stat
grid) → 9-card stat grid → Tools card-grid section → Latest Blocks`. The old `.tx-cta` banner is
gone; its content is now the first `.tx-tool-card`.

### Tools hub
- **Header `🧰 Tools ▾` dropdown** replaces the per-page `.tx-toolbtn` Slate link on **all five**
  shells (index/block/kernel/output/404) + emission. Self-contained CSS menu; `initTools()` (run
  from `initChrome`, every page) toggles `hidden` + `aria-expanded` + `.open`; closes on
  outside-click / Escape. Two items: Slate Inspector, Emission & Supply.
- **Home `.tx-tools-section`** = responsive `.tx-tool-card` grid (cyan→magenta left edge, reused
  from the retired CTA). Scales to N tools via `repeat(auto-fit, minmax(260px,1fr))`.
- Theme: hub + section use `tiny-explorer.css` (light/dark toggle) — **not** slate.css. The
  cyberpunk look stays sandboxed to `/slate`.

### Emission & Supply page (`/emission`)
Second tool. **Node-light, no DB**: a static explainer served via `sendEntityPage('emission.html',
'emission')` (added to `_pageMeta` + self-canonical list); `initEmission()` makes **one**
`/api/stats` call for live supply (`height×60`), tip height, and annual inflation
(`60×1440×365 / supply`, trends toward 0). Includes a "verify it yourself" `height × 60` calculator
(prefilled to tip), a Grin-vs-BTC-vs-gold-vs-fiat comparison table, and a "why constant emission"
explainer. `data-page="emission"` dispatches in the DOMContentLoaded init.

### Mempool card
New 9th stat card. Server `/api/stats` gains `mempool` from Foreign `get_pool_size` (`poolCache`
30 s TTL, fails soft to `null`). Frontend renders `N tx(s)`; card hides when `null` (same pattern
as the peers card).

### Sparklines (stat enhancement, not a tool)
Inline SVG trend lines inside the Hashrate + Difficulty cards. **Zero new endpoint / zero stored
history** — `renderSparklines()` derives per-block Δdifficulty and hashrate
(`Δtd×42/Δt/16384`) from the `/api/latest` series already fetched for the block table, and paints
a normalised `<polyline>` (colour from CSS). Needs ≥3 blocks; degrades to empty otherwise.

---

## Peer map — location grouping + node id (`web/06_stats_map/stats/index.html`, 2026-08-15)

### The problem
Geo comes from ip-api.com at **city level** (`06_collector.py` `GEO_URL`), which returns the
**city centroid**, not the host. So every peer in one city carries **byte-identical** lat/lng.
Drawing one `circleMarker` per record stacked them exactly: only the last one drawn was
hoverable, the nodes underneath were unreachable, and the panel's peer total silently
disagreed with the number of visible dots. `flyTo` could never separate them — `maxZoom` is 10
on purpose (GeoIP is city-accurate; zooming further would imply precision the data lacks).
Grin peers concentrate on a few hosting providers, so the densest locations were the hidden
ones, and **every dual-stack host was a guaranteed 2-stack** (its v4 and v6 records are
different IPs at the same centroid, so the existing `dual` collapse never applied).

### The fix — one dot per point
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

### `node_id` — why a masked IP needs one
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

### Adjacent fix
`markersLayer` is now `L.featureGroup()`. `applyTheme()` calls `markersLayer.bringToFront()`
after swapping tiles, and `bringToFront` is defined on **FeatureGroup, not LayerGroup**
(verified in leaflet 1.9.4 source) — on the old `L.layerGroup()` that call was a TypeError.
Harmless today because nothing runs after it, but it would silently swallow whatever got added
there next. `FeatureGroup.bringToFront()` delegates via `invoke()`, which skips layers lacking
the method, so the mixed canvas/DOM marker set is safe.
