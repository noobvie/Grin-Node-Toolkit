# Script 06 — Global Grin Health (design notes)

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
> **Re-org note (2026-10-13):** the as-built sections named above as verified (Peer counts, When the node stops answering, Tools 2–4, the crawl surface, the basemap as-built records) moved to [`script06_implementation.md`](script06_implementation.md); the verification claims travel with them. Moving text is not a verification: nothing in this header was re-checked.

Only sections that need durable prose live here; the menu/wiring lives in
`scripts/06_global_grin_health.sh`. Options A (network stats), B (GrinScan),
C (grincoin clone) are documented in git history + their own libs.


## As built → [`script06_implementation.md`](script06_implementation.md)

The as-built record moved to the implementation doc, by subject. This document keeps the header, the self-hosted basemap plan, and the plans for the tools hub and its homepage. Where this doc and the implementation doc disagree about what runs, the implementation doc wins.

| Section that was here | Now in the implementation doc, under *What shipped* |
|---|---|
| Option D — Tiny Explorer, and *When the node stops answering* | Option D — Tiny Explorer · When the node stops answering |
| Option D addendum — Slate Inspector | the same heading |
| Option D addendum — Tools hub + Emission page + mempool + sparklines | the same heading |
| Tools 1–4 (Mining Calculator, Wallet Checker, Node Reachability Checker, Payment Proof Verifier) | Tool 1 … Tool 4, with their sub-sections |
| Peer map — location grouping + node id | the same heading |
| Peer counts — windowed by the node's own handshake time | the same heading |
| As built — dateline seams / three follow-ups / Vietnam | the same three headings |
| Option D addendum — the deploy is the copy AND the restart | the same heading |
| Option D addendum — the crawl surface | the same heading |
| Review pass (outcome of the six-tool expansion) | Review pass — closed except the VPS run |

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

4. **`docs/reference/script06_design.md`** — this section, updated as built.

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
plans are scaffolding, not reference (see the "Session plans" note in `docs/reference/README.md`).

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
  (default true), `node_check_timeout_ms`; and for phase 3 `wallet_check_probe` (installer
  default **true**, code default **false**), `tor_socks_port` 9050, `tor_onion_virtual_port` 80, `tor_check_timeout_ms`,
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
plans; it is scaffolding, not reference (see `docs/reference/README.md`).

### Not doing

- **Fee & weight calculator.** Useful, but the input/output/kernel weight constants have
  moved across grin versions; it needs `core/src/consensus.rs` read first, and a fee
  calculator that is quietly one version stale is worse than none. Parked, not rejected.
- **A seventh tool.** The grid is even at 6; the next addition comes in a pair.

