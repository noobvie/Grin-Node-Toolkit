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

Broken into six pasteable per-session prompts (five build + one VPS acceptance) in
docs/generated/script06_reference_basemap_prompts.md. Part 2 is the shippable checkpoint: after
it the watermark is gone and Parts 3-5 are improvements on a working map.

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
