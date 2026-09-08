# Script 06 — Global Grin Health (design notes)

> **Covers code as of:** 2026-09-08 · **Last verified:** never systematically verified
> **Product code last changed:** 2026-09-08 — `web/06d_tiny_explorer/public/` (mining calculator presets); 2026-09-07 — `scripts/lib/06d_tiny_explorer.sh` (deploy/restart lifecycle); 2026-09-06 — `scripts/06_global_grin_health.sh`, `scripts/lib/06*`, `web/06_stats_map/`, `web/06d_tiny_explorer/`
> 06d has a test suite (`web/06d_tiny_explorer/test/`, 98 assertions), but it tests the code, not this doc.

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
- Theme: hub + section use `tiny-explorer.css` (light/dark toggle). Since review R2 `/slate`
  does too — see *Theme* above; `slate.css` is now an `sp-*` overlay, not a separate scene.

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

---

## Peer map — self-hosted basemap, no third-party tiles (plan, rev. 2026-09-02)

**Status: PART 2 BUILT (2026-09-05) — the CARTO dependency is GONE.** The peer map now
draws a vector basemap from the committed `countries-110m.json`, at one resolution, with
no labels: `assets/topojson-client.min.js` is vendored, `makeBasemapLayer()` is the single
construction site, and a theme change is `setStyle()` rather than a rebuild. Still PLANNED
below: the 50m/10m zoom-swap tiers (*The one real technical risk*) and labels. Scope is the
peer map at
`web/06_stats_map/stats/index.html` and its deploy path in `scripts/06_global_grin_health.sh`.

⚠ **Rev 2 replaces the 2026-09-01 PMTiles plan, which was wrong for this map.** That plan
budgeted ~1-4 GB of vector tiles. The correction, and why, is in *Sizing* below. PMTiles is
retained only as the fallback if the requirements ever change (see *Deferred*).

### Why

`TILE_URLS` (index.html:1030-1033) points at `{s}.basemaps.cartocdn.com`. CARTO now requires an
API key on that host and serves keyless requests **watermarked instead of blocked**. Verified
live 2026-09-01:

```
a.basemaps.cartocdn.com/dark_all/3/4/3.png  ->  200, image/png, 10861 bytes (Fastly HIT)
```

⚠ **HTTP 200 with a valid PNG body.** Nothing 404s, nothing appears in nginx logs, no JS error
fires. The watermark *is* the error message — undebuggable from our side, and it would recur
just as silently on any other keyless provider that changes policy. CARTO state that raster got
the key requirement first and **vector basemaps are next**, so restyling is not an escape route.

The free key (email + domain, no account, no card, 5M tiles/month) fixes the watermark and
nothing else: it is *"intended for non-commercial use"*, it sits in client-side HTML on a public
page, and every visitor's browser still connects to CARTO/Fastly directly. That last point is
the one that decides it — we hash miner IPs, mask audit IPs to /24 and publish country-only geo,
then hand a third party the raw IP of everyone who opens the peer map.

### Sizing — the error in rev 1, and the correction

Rev 1 reached for a **general-purpose street basemap** (Protomaps planet, z0-8 sub-pyramid,
~1 GB). That number is real, but it is the size of *everything OSM knows about the planet down
to zoom 8* — roads, buildings, landuse, waterways, POIs, sub-national boundaries. **This map
draws almost none of it.** It draws land, country borders, and a few labels, with peer dots on
top. Paying a gigabyte to throw away 98% of it is the wrong trade, and "a 2D world map should be
lightweight" is the correct instinct.

The right shape is a **thematic outline map**, not a basemap: ship the vector data itself and
draw it client-side. Measured 2026-09-02, not estimated:

| Asset | Vertices | Raw | Gzipped |
|---|---|---|---|
| `countries-110m` TopoJSON (world-atlas) | 8,246 | 108 KB | ~35 KB |
| `countries-50m` TopoJSON (world-atlas) | 80,617 | 756 KB | ~230 KB |
| Natural Earth 10m countries, TopoJSON `-q 1e5` | 548,471 | 3.63 MB | **0.91 MB** |
| City labels — 1,251 places as `[name, rank, lon, lat]` | — | 36.7 KB | **17 KB** |
| `topojson-client` (lib) | — | 7 KB | ~3 KB |

**Full three-resolution set: ~4.5 MB in the repo, under 1.2 MB over the wire.** Against
1-4 GB, that is roughly a **thousandfold** reduction — because it is our map, not the world's.

Both `countries-*.json` files carry `countries` *and* `land` objects plus a `name` property, so
one file gives land fill, borders and country names together (241 countries at 50m, 258 at 10m).

**Licensing improves too.** Natural Earth is **public domain**; world-atlas is **ISC**. The ODbL
/ OSM attribution obligation that came with the tile plan disappears entirely. Crediting Natural
Earth is courtesy, not a licence term.

### Decision

**Draw the basemap as a vector overlay from Natural Earth data committed to this repo.**

No tiles. No tile server, no PMTiles archive, no `pmtiles` CLI, no glyph fonts, no byte-range
requests, no `location /tiles/`, no VPS download step, no disk-space gate, no cache-busting
scheme, no build pipeline of any kind.

| Option | Verdict |
|---|---|
| CARTO free key | no — per-domain key in public HTML, non-commercial terms, privacy leak unchanged, vector gets keyed next |
| Swap to Esri / OSM / OpenFreeMap | no — same class of dependency. Keep only as the emergency one-liner (below) |
| Pre-render raster PNGs | no — z0-10 is 1,398,101 tiles, ~14 GB and ~1.4M inodes, **per theme** |
| Self-hosted PMTiles (rev 1) | no — ~1 GB of street data to render country outlines. Right tool, wrong map |
| **Natural Earth vector overlay** | **yes — ~4.5 MB in-repo, public domain, no tiles, no server, no runtime dependency at all** |

This also **fixes an existing defect**: `matrix` and `hp` are currently just `dark_all`
re-pointed, because CARTO has no green or purple basemap. Once the geometry is ours, a theme is
a fill colour and a stroke colour — all four themes get a real basemap, and adding a fifth is
free.

**The trade, stated plainly:** no roads, no districts, no buildings, no detailed coastline. At
z10 the map shows a clean country outline with city dots instead of the street map in the
current screenshot. For a page whose subject is *where Grin peers are*, the Vietnamese district
names and motorways are noise — but this is a visible change to the map's character and it is
an operator decision, not a technical one.

### Requirements

- **Nothing on the VPS.** No new package, process, port, systemd unit, or disk budget. The
  assets are static files, ~4.5 MB, next to `leaflet.min.js`.
- **Nothing at deploy time.** The files are **committed to the repo** and ride the existing
  assets copy at `06_global_grin_health.sh:565` — the same path that already ships
  `TwemojiCountryFlags.woff2`. No install-time download, so no network dependency and no
  version drift between servers.
- **Data prep is one-off and local**, not part of any build. `geo2topo -q 1e5` over the Natural
  Earth GeoJSON, property-stripped to `name` + `iso_a2`. Re-run only when Natural Earth
  publishes a new release — country borders do not move often.

**On building/hosting locally:** the local Windows box can be the *prep* machine — that is where
the one-off `geo2topo` run belongs. It cannot *serve* the data: the public page is served by the
VPS, so visitors' browsers fetch these files from the stats domain and the workstation is not in
that path. At 4.5 MB the distinction is academic anyway; the files live in git and are deployed
by `cp`, so there is no upload step to think about.

### Repo changes, file by file

1. **`web/06_stats_map/stats/assets/`** *(new files)* — `countries-110m.json`,
   `countries-50m.json`, `countries-10m.json`, `cities.json`.

2. **`web/06_stats_map/stats/index.html`**
   - Replace the four `TILE_URLS` entries with four **style objects** (dark / light / matrix /
     hp): land fill, border stroke, label colour. No URLs.
   - Replace the `L.tileLayer` construction with `L.geoJSON` over the TopoJSON, decoded by
     `topojson-client`.
   - ⚠ The layer is constructed in **two** places — `initMap()` (:1052) and again in
     `applyTheme()`'s theme swap (:1518), with a duplicated options object. Factor them into one
     `makeBasemapLayer()`. With vector, theme changes become `setStyle()` on the existing layer
     rather than a rebuild — which removes the duplication at the root.
   - Add `topojson-client` beside the existing local `leaflet.min.js` (:47).
   - Attribution: drop CARTO, credit Natural Earth (courtesy, not obligation).
   - Keep `maxZoom: 10`.

3. **`scripts/06_global_grin_health.sh`**
   - One vendor block for `topojson-client` in the existing `if [[ ! -f "$WWW_DIR/..." ]]` idiom
     (:603-618) — or commit it too, and skip the download entirely.
   - Nothing else. The `assets/` copy at :565 already carries the data files.
   - **No vhost change.** No `/tiles/` block, no MIME type, no cache rules beyond what static
     assets already get.

   **AS BUILT (2026-09-05) — "no vhost change" was wrong.** Two were needed, and the
   second contradicts the line above:
   - `topojson-client` is **vendored**, not downloaded: it lives in `assets/` and the
     existing `cp -r "$WEB_SRC/assets/."` carries it. No curl block was added — a
     download would reintroduce a build-time third-party fetch into the one directory
     whose whole purpose is that there are none.
   - That copy is now **guarded** (`|| { die …; return 1; }`) plus a presence check on
     the four load-bearing files. It was a bare `cp -r` carrying only a flag font;
     it now carries the map itself, and `install_stats()` is reached through an
     ||-guarded menu dispatch, so it runs with **errexit disabled** — an unguarded
     failure there is silent (CLAUDE.md, *Libs run WITHOUT errexit*).
   - **gzip had to be declared in the vhost.** nginx's built-in `gzip_types` default is
     `text/html` only; Debian ships the wider list **commented out** and the RHEL/nginx.org
     package ships `#gzip on;`. The design's "Debian's default `gzip_types` does include
     `application/json`" is false in the way that matters, and the entire size argument
     rested on it. Declared at server level in the stats vhost — not in `nginx.conf`,
     which a package upgrade resets.
   - **`location /assets/`** added with `Cache-Control: public, max-age=2592000` (30 days,
     not a year: a regenerated tier ships under the same filename). This is design rule 4
     under *Page-load cost*, which had no implementation.
   - **robots.txt: `assets/` stays crawlable.** It holds resources the page needs to
     render, and blocking those is what Google advises against. Cost is bounded —
     autoindex is off and nothing links `countries-10m.json`, so a renderer fetches only
     the ~890 KB the page references (~295 KB gzipped).

4. **`docs/generated/script06_design.md`** — this section, updated as built.

### The one real technical risk — vertex count, not file size

The 10m set is **548,471 vertices**. Leaflet projects a polygon's full point list before
clipping it to the viewport, so a single canvas redraw at that resolution will stutter on pan
and zoom. File size is not the constraint here; per-frame projection cost is.

**Mitigation — swap resolution by zoom**, which is why the table above lists three files:

| Zoom | File | Vertices |
|---|---|---|
| 2-4 | `countries-110m` | 8,246 |
| 5-7 | `countries-50m` | 80,617 |
| 8-10 | `countries-10m` | 548,471 |

Only one is in the map at a time, and the deep-zoom file is the one whose viewport is smallest.
Load the higher-detail files lazily on first cross into their band, so the initial page paint
costs 108 KB.

⚠ **Measure this before committing to 10m at all.** If z8-10 stutters even with the swap, cap
the detail at 50m and accept coarser coastlines at deep zoom — the peer dots are the content,
and 50m outlines at z10 are a cosmetic loss, not a functional one. Do not discover this after
wiring three files.

#### AS BUILT (2026-09-05): measured, and 10m was NOT wired

The bands shipped as **110m for z2-4 and 50m for z5-10**. `countries-10m.json` is committed
but absent from `BASEMAP_TIERS`. Measured against the committed data with Leaflet 1.9.4's own
`_project` / `PolyUtil.clipPolygon` / `LineUtil.simplify`, on an AMD Ryzen 5 PRO 3400GE —
mid-range, so a median visitor is that class or slower:

| Tier | Mount (parse + decode + project) | Every `zoomend` | Pan (`moveend`) at z8-10 |
|---|---|---|---|
| `countries-50m` | 58 ms | 11 ms | 0.1-2.1 ms |
| `countries-10m` | 300 ms | 87 ms | 0.8-2.5 ms |

**The prediction above was aimed at the wrong event.** Pan at z8-10 is cheap even at 10m:
`Path._clipPoints` early-outs on `_pxBounds`, so only the 2-10 countries actually on screen
are clipped and drawn. What is expensive is `Renderer._onZoomEnd`, which re-projects **every**
layer with no culling at all — all 546,001 vertices, on every single zoom step, inside the one
band whose entire purpose is zooming. 87 ms on this box is 200 ms+ on a low-end laptop, and the
300 ms first mount is a visible freeze. So the cap is real, and it is the outcome this section
told us to accept: coarser coastlines at deep zoom, nothing else.

**What would unlock 10m** is culling by viewport before projection rather than after: a z10 view
over Europe intersects only ~96k of the 546k vertices (~18%), and over east Asia ~50k (9%) —
i.e. no worse than the 50m tier costs today. That means re-filtering the mounted feature set on
pan, with the decoded LatLng arrays cached per feature so a re-filter is not a re-mount. That is
a separate piece of work; do not simply add the row back.

Note the vertex count in the table above (548,471) is the **source GeoJSON's** coordinate count.
The committed file quantises to 478,373 arc vertices, which decode to 546,001 points — that last
number is the one that gets projected, and the one measured here.

### Page-load cost — measured, and it gets FASTER

Repo space and page-load cost are different numbers, and conflating them is what makes "4.5 MB"
sound alarming. All figures measured 2026-09-02.

**Repo / disk:** 105 KB + 739 KB + 3.63 MB + 37 KB = **~4.5 MB** in the working tree, roughly
**1.2 MB** added to git objects after zlib. The repo's `.git` is already 70 MB, and country
borders do not change, so this is a one-time addition — not a recurring diff.

**What the page fetches TODAY at first paint** (map tab, z2 world view, 16 CARTO tiles):

| | Bytes |
|---|---|
| CARTO tiles @1x | 75.0 KB |
| **CARTO tiles @2x** (what `{r}` resolves to on any retina/HiDPI screen — most laptops and phones) | **192.4 KB** |

Plus a DNS lookup and TLS handshake to a third-party origin before the first tile can arrive.

**What it would fetch instead at first paint:**

| Asset | Gzipped |
|---|---|
| `countries-110m` | 38.6 KB |
| `topojson-client` | 2.5 KB |
| **Total** | **41.1 KB** |

Same origin — connection already warm, no extra DNS/TLS. **First paint gets ~150 KB lighter on
a retina screen** and drops a third-party round trip. The change makes the page faster, not
slower. (For scale, the page already ships `chart.js` at 69.7 KB gzipped and `leaflet.js` at
42.2 KB — the initial basemap is smaller than either.)

**The deeper tiers are lazy and never block:**

| Tier | Gzipped | Fetched when |
|---|---|---|
| `countries-110m` | 38.6 KB | at load, with the page |
| `countries-50m` | 237.1 KB | on first cross into z5, or on idle prefetch |
| ~~`countries-10m`~~ | ~~910 KB~~ | **never — not mounted, see AS BUILT above** |

Rules that keep this off the critical path:

1. **Progressive refinement, never a stall.** Keep drawing the resolution already in hand until
   the finer one arrives, then swap. A slow fetch means a briefly coarser map — never a blank
   one, never a frozen UI.
2. **Prefetch 50m on idle** after first paint (`requestIdleCallback`), so ordinary z5-7
   exploration is already warm.
3. ⚠ **`flyTo(maxZoom)` on a dot click jumps straight to z10**, which is the one common
   interaction that hits the 10m tier cold. Kick that fetch off at the *start* of the flight,
   not on arrival — the animation runs ~1-1.5 s and covers most of the download.
4. **Long cache headers.** These files are effectively immutable, so repeat visits and repeat
   zooms cost nothing.

**Net:** the median visitor who never leaves the world view pays **41 KB instead of 192 KB**.
A visitor who clicks through to z10 pays 910 KB once — and then panning is **free**, where tiles
keep billing on every pan for as long as they explore.

**If 910 KB is judged too much,** ship 110m + 50m only and cap the ceiling at 237 KB; z10 gets
coarser coastlines and nothing else changes. That decision can be made after seeing it, and
reversed by adding one file.

### Labels

Leaflet has **no collision-aware label placement** — this is the one thing tiles gave us for
free and the one place effort has genuinely moved rather than disappeared. Options, cheapest
first:

1. **No basemap labels.** Peer tooltips already show `city, country`. Zero work, and the
   cleanest look for the matrix/hp themes.
2. **Country names only**, one per country at low zoom, hidden past z6.
3. **City labels from `cities.json`** (1,251 places, 17 KB gzipped), filtered by `scalerank`
   per zoom. The rank histogram is well-shaped for this — rank 0: 27 places, 1: 41, 2: 118,
   3: 336, 4: 606 — so `scalerank <= zoom - 2` gives a natural progression from ~27 labels at
   z2 to the full set at z8. Render as `divIcon`, and accept that overlaps are not resolved.

Start at (1). It is reversible and it is very possibly the right answer.

**AS BUILT: (3), city labels.** `assets/cities.json`, filtered `scalerank <= zoom - 2` and by
the padded viewport bounds, rebuilt on `moveend` only (Leaflet fires `moveend` after `zoomend`
for the same zoom, so binding both rebuilds twice per step). Rendered as `divIcon` markers in a
`citylabelPane` at z-index **390**, which is also why the basemap moved to its own canvas in a
`basemapPane` at **380**: land is `fillOpacity: 1`, so a label under the basemap is invisible,
and a label in or above the default overlayPane canvas paints over the single-peer dots that
live in that canvas. With the split, 380 < 390 < 400 (dots) < 600 (group dots) — nothing below
400 can cover a dot. Colour is `--map-label` / `--map-label-halo` per theme. Overlaps are
**not** resolved and must not be: the lever is `CITY_LABEL_RANK_OFFSET`, not a placement solver.

### Acceptance

1. Load the page with DevTools open: **zero requests to any third-party host.** This is the
   success criterion — the watermark disappearing is also what a CARTO key buys, and that is
   the outcome being rejected.
2. Confirm the data files are served gzipped (`content-encoding: gzip`) — ~1.2 MB becomes the
   wire cost only if nginx compresses JSON. Check `gzip_types` includes `application/json`.
3. Cycle all four themes; confirm the basemap restyles each time (catches the two-site bug).
4. Pan and zoom at z8-10 over a dense area and watch frame rate — the risk above.
5. Confirm peer dots, tooltips, click-`flyTo` and the group markers still work. That code is
   untouched but now sits on a swapped base layer.
6. Confirm behaviour at the antimeridian and at `maxBounds` — the current map sets
   `noWrap: true` and `worldCopyJump: false` on the tile layer; the equivalent constraint has
   to be reproduced on a GeoJSON layer or the world repeats horizontally.

### Rollback

Keep the CARTO URLs in a commented block for one release; rollback is a `git revert` of the HTML
plus a redeploy.

**Emergency one-liner** if the map must render now: Esri World Dark Gray Base, keyless, verified
200 `image/jpeg` on 2026-09-01. ⚠ Its path is `{z}/{y}/{x}` — **y before x**; copying our current
`{z}/{x}/{y}` order silently mirrors the world. Drop `{r}`; `{s}` is unused.

### Things easy to miss

1. **Vertex count, not byte count, is the budget.** See the risk section above. A 3.6 MB file
   that projects half a million points per frame is a worse problem than a 30 MB file that
   projects ten thousand.
2. **`_finalize_seo()` re-copies pristine HTML** from `$WEB_SRC` over `$WWW_DIR` (:490-493), and
   `_inject_analytics` re-applies GA afterwards. Any edit made directly to the deployed file is
   erased by the next SEO/domain step. All HTML changes go in the repo source.
3. **TopoJSON is not GeoJSON.** `L.geoJSON` cannot read it directly; `topojson-client`'s
   `feature()` must decode it first. Handing the raw file to Leaflet yields an empty map with no
   error.
4. **Quantization is lossy and irreversible.** `-q 1e5` is ~0.4 km at the equator — fine at z10,
   but re-quantizing an already-quantized file compounds the error. Always regenerate from the
   Natural Earth source, never from the shipped file.
5. **`preferCanvas: true` stays.** The group markers are DOM `divIcon`s in `markerPane` (z 600)
   and the base geometry goes to `overlayPane` (z 400); that existing arrangement is what keeps
   the dots above the map. A GeoJSON layer added after the markers will cover them —
   `markersLayer.bringToFront()` already exists in `applyTheme()` for exactly this reason and
   must survive the rewrite.
6. **`noWrap` / `worldCopyJump` do not transfer.** They are tile-layer options. The world-repeat
   behaviour has to be re-established on the vector layer (acceptance step 6).
7. **Check nginx actually gzips JSON.** The whole size argument rests on it. Debian's default
   `gzip_types` does include `application/json`, but confirm rather than assume — uncompressed
   this is 4.5 MB, and that would be a real regression on a phone.
8. **Do not expect deletion to fix the vertex budget — simplification is the lever.** The
   intuition that Antarctica dominates is wrong: measured, it is **4.3%** of the 10m vertex
   count. The real weight is ordinary countries with crenellated coastlines — Canada **12.4%**,
   Russia 6.7%, USA 6.6%, Greenland 3.7%, Indonesia 3.6%. Dropping polar geometry buys almost
   nothing; `toposimplify` on the whole set buys a lot.
9. **The peer dots do not change.** Grouping, radius, `divIcon`, pane stacking and the
   `bringToFront` FeatureGroup fix (section above) are out of scope. Do not let a basemap swap
   become a marker refactor.
10. **Public domain still deserves a credit line.** Not a licence term for Natural Earth, but the
    attribution control should not simply be deleted along with the CARTO string.

### Build sessions

Was broken into six pasteable per-session prompts (five build + one VPS acceptance); Part 2 was
the shippable checkpoint, after which the watermark was gone and Parts 3-5 were improvements on a
working map. **All parts are run and committed**, so the prompt file has been deleted — session
plans are scaffolding, not reference (see the "Session plans" note in `docs/generated/README.md`).

### Deferred / not doing

- **PMTiles / Protomaps (rev 1's plan).** Correct engineering for a *street* basemap and the
  right answer if this map ever needs roads, districts or building footprints. The verified
  recipe is kept for that day: `pmtiles extract https://build.protomaps.com/YYYYMMDD.pmtiles
  out.pmtiles --maxzoom=8` range-reads the sub-pyramid out of the live 137.6 GB planet (verified
  2026-09-01: `200`, `Content-Length 137,665,515,426`, 17-byte range answered `206`), so it needs
  no Planetiler, no Java and no `planet.osm.pbf`. ~1 GB at z0-8, over-zoomed to z10 without blur.
  Client would be `protomaps-leaflet` (canvas, no WebGL, maintenance-mode upstream).
- **Offline / onion basemap.** Falls out for free here — with the geometry in-repo there are no
  external fetches at all, so the peer map works unchanged behind an onion front.
- **Sharing the data with the pool's network map** (memory `project_pool_network_map`). Same
  problem, same fix, different vhost — and at 4.5 MB of static assets, sharing is a copy. Do 06
  first, then lift.

---

## Option D addendum — Tools hub expansion to six (plan, rev. 2026-09-05)

Adds four tools to the Tiny Explorer hub — **Wallet Checker**, **Node Reachability
Checker**, **Mining Calculator**, **Payment Proof Verifier** — taking it from 2 to 6, and
compacts the homepage tool cards so six tiles cost *less* vertical space than the two
verbose cards do today.

### Why these four, and why 06d

All four are **keyless and read-only**: none holds a seed, signs anything, or moves funds.
That is the property that makes the hub safe to publish next to a block explorer, and it is
the line every future tool must also clear. Three of the four need no Grin node at all,
which suits a deliberately stateless explorer.

The audience argues for them too. `scan.grin.money` exists as the pool's deep-link surface
(`/block/<h>`, `/kernel/<excess>`), so arrivals are miners and people who have just been
handed a slatepack or a payout. Every tool below answers a question one of those two people
actually asks.

### The six, as three pairs

| | Verify what you were given | Operate your own side |
|---|---|---|
| **Transaction** | Slate Inspector · Payment Proof Verifier | — |
| **Reachability** | Wallet Checker | Node Reachability Checker |
| **Economics** | Emission & Supply | Mining Calculator |

Row order on the homepage grid follows that reading — row 1 *verify*, row 2 *operate*:

```
Slate Inspector    Payment Proof Verifier   Wallet Checker
Node Checker       Mining Calculator        Emission & Supply
```

### Phasing — every checkpoint lands on an even grid

The operator constraint is that the tool grid never shows an odd count. Phasing respects
it, and also happens to order the work cheapest-first:

- **Phase 1 → 4 tools.** Mining Calculator + Wallet Checker *Tier 1*. Both are pure
  page-and-client-JS on data already in the payload. Zero new dependencies, zero new
  infrastructure, no nginx work. Ship the homepage reorg here.
- **Phase 2 → 6 tools.** Payment Proof Verifier + Node Reachability Checker. Both need a
  server route, both stay dependency-free (Node stdlib `crypto` and `https`). This phase
  introduces the one new nginx rate-limit zone.
- **Phase 3 → still 6 tools.** Wallet Checker *Tier 2* (the Tor liveness probe). This is
  an **upgrade to a tile that already exists**, not a seventh card, so the tor-daemon
  dependency never gates the grid. Behind a config flag, default off.

---

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
(iPollo G1 / G1 Mini, 11 NVIDIA and 7 AMD GPUs) and an electricity-rate
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
  ASIC rows are the manufacturer's published spec. GPU rows are whattomine's Cuckatoo32 table
  (`whattomine.com/coins/324-grin-cuckatoo32/gpus`), cited in the hint line under the form —
  they started as guesses and were replaced wholesale on 2026-09-08, which moved the RTX 4090
  from an invented 2.2 G/s to a sourced **1.40**, a 57% error that would have overstated a
  miner's income by the same margin. Two Innosilicon G32 rows were dropped the same day for
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

### Tool 2 — Wallet Checker (`/wallet-check`, phase 1 + phase 3)

"Is this `grin1…` wallet listening right now?" A Slatepack address *is* a 32-byte ed25519
pubkey in bech32, and the wallet's v3 onion is a deterministic function of that same key.

**Tier 1 — client-side, no infra (phase 1).** Validate the bech32 checksum, report
mainnet vs testnet from the HRP, show the derived `.onion`. This alone catches the most
common real failure (a truncated or mistyped address), and it is useful on its own — the
`/slate` page already carries a ported bech32 to lift from.

**Tier 2 — server probe (phase 3).** Both halves already exist in this repo, both
dependency-free:

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

Open question to settle on a live testnet listener before Tier 2 ships: **does the wallet
foreign API over Tor require basic auth?** Probe with a real `check_version` JSON-RPC rather
than a bare TCP connect — CLAUDE.md's *reachability needs a parsed result* rule applies
verbatim. If it answers 401, that is still proof a grin-wallet is there, so treat 401 as
online; a bare TCP accept is not.

### Tool 3 — Node Reachability Checker (`/node-check`, phase 2)

"Can the world reach my node?" — the question every operator who opened 3413 has. Input a
host (optional `:port`, default 3413); the server POSTs `get_tip` to `/v2/foreign` and
requires an unwrapped `{"Ok":…}`.

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
- Do not follow redirects. Cap the response body. Short timeout (~5 s), one attempt.
- Its own rate-limit zone, tighter than `tinyx_api`.

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

#### R4 — RESOLVED 2026-09-06: the layout is confirmed against real grin-wallet output

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
- A proof exported from an operator's *own* wallet has still never been read. This is no longer
  a correctness risk — it is worth doing once as an ergonomics check (that `export_proof`
  output pastes into the page cleanly), not as a gate.
---

### Homepage reorg

The tool cards are the problem the operator flagged: each card today carries a three-line
`.tx-tool-desc`, so two cards already cost ~200 px of column height and six would cost
~600 px, pushing Latest Blocks off the screen entirely.

**Compact the tile, keep the prose where it belongs.**

- Drop `.tx-tool-desc` from the homepage card. Keep icon + name + **one** short line — the
  same one-liner the header dropdown already uses (`Read a slatepack — amount, fee, step`).
  The full explanation moves to each tool's own page, where someone who has arrived actually
  wants it.
- Result: roughly 90 px per tile instead of 200. Six compact tiles occupy *less* height than
  the two verbose ones do now.

**Pin the column count so a row is never ragged.** `.tx-tools-grid` is currently
`repeat(auto-fit, minmax(260px, 1fr))`, which with six cards yields a 4 + 2 desktop row —
the exact ragged-row look the operator wants to avoid. Make it explicit, mirroring
`.tx-stats`:

```css
.tx-tools-grid { grid-template-columns: repeat(3, 1fr); }
@media (max-width: 860px) { .tx-tools-grid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 460px) { .tx-tools-grid { grid-template-columns: 1fr; } }
```

3+3 on desktop, 2+2+2 on tablet, single column on phone — even at every breakpoint.

**Position stays.** Education `details` → stat grid → Tools → Latest Blocks is the
operator-directed order from 2026-07-24 and is not in question; the tools section only gets
shorter, not moved.

**Group the header dropdown.** Six flat rows in `#tx-tools-menu` is a list, not a menu. Add
the two group labels from the pair table (*Verify* / *Operate*) as non-interactive
`role="presentation"` headings. `initTools()` (outside-click, Escape, `aria-expanded`) is
unchanged.

**Update the "What can you check here?" details block.** It already promises "Estimate mining
income from the live hashrate" and "Prove a payment settled via its kernel excess" with no
tool behind either — phase 1 and phase 2 respectively make those two bullets true, so link
them the way the Emission and Slate bullets already link.

### Wiring — repo-convention notes

- **Routes:** four `sendEntityPage()` entries plus `_pageMeta` keys, exactly as `/slate`,
  `/emission`, `/kernel`, `/output` do. nginx already proxies **all** paths to :8471, so no
  vhost route work is needed for the pages.
- **⚠ The rate-limit zone will NOT reach an installed box if added to the existing file.**
  `nginx_ensure_rate_limit_zone` is a no-op when its conf file already exists, and
  `06d_tiny_explorer.sh:280` already wrote `script06d-rate-limit.conf` with `tinyx_api` alone
  (its non-helper fallback at :282-285 writes that single zone literally). So phase 2 must
  add a **second conf basename** — `nginx_ensure_rate_limit_zone "tinyx_probe" "10r/m" "10m"
  "script06d-probe-rate-limit"` — and mirror it in both the fallback branch and the uninstall
  path at :447. Do not reuse `tinyx_api`, and do not edit the existing file in place.
- **Config keys** (`06d_tiny_explorer.sh` + server `config.json`): `node_check_enabled`
  (default true), `node_check_timeout_ms`; and for phase 3 `wallet_check_probe` (default
  **false**), `tor_socks_port` 9050, `tor_onion_virtual_port` 80, `tor_check_timeout_ms`,
  `tor_check_retries`.
- **SEO:** per-page `_pageMeta` entries feed the existing server-injected canonical/OG/JSON-LD.
  Per memory `project_frontend_seo_standards`, no static tag may name a host the deploying
  operator does not own — build these from the configured domain, never a literal
  `scan.grin.money`.
- **Privacy:** do not log the queried address or host on either checker. A query log is a
  record of who is interested in which wallet.
- **Tests:** extend the existing jsdom assertion harness (18 green today) and keep
  `node --check` clean. Kill every local test process in the same session.

### Build sessions

Broken into nine pasteable per-session prompts (eight build + one VPS acceptance), one tool per
session. Part 3 is the first shippable checkpoint (4 tools) and Part 7 the second (6 tools) — both
even grids. The prompt file itself is **kept outside the repo** with the other in-flight session
plans; it is scaffolding, not reference (see `docs/generated/README.md`).

### Review pass — CLOSED 2026-09-06 except the VPS run

Parts 1-8 were run on 2026-09-05. The review over that working tree — four confirmed defects plus
per-session review prompts R1-R8 — is **kept outside the repo** alongside the build plan
(`D:/tmp/grin-toolkit-plans/`, see `docs/generated/README.md`). What follows is its durable
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

### Not doing

- **Fee & weight calculator.** Useful, but the input/output/kernel weight constants have
  moved across grin versions; it needs `core/src/consensus.rs` read first, and a fee
  calculator that is quietly one version stale is worse than none. Parked, not rejected.
- **A seventh tool.** The grid is even at 6; the next addition comes in a pair.

## Option D addendum — the deploy is the copy AND the restart (2026-09-07)

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
