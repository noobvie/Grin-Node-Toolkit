# Peer map basemap assets

Vector basemap data for the peer map at `web/06_stats_map/stats/index.html`.
Self-hosted so no visitor's browser contacts a third-party tile CDN.
Rationale and sizing: `docs/generated/script06_design.md` — *"Peer map — self-hosted
basemap, no third-party tiles"*.

These are **static committed data files**. They are copied to the VPS by the existing
assets step in `scripts/06_global_grin_health.sh` — there is no build step, no download
at deploy time, and nothing to install on the server.

## Files

| File | Raw (bytes) | Gzipped (bytes) | Vertices (arcs) | Countries | Used at zoom |
|---|---|---|---|---|---|
| `countries-110m.json` | 107,761 | 38,495 | 8,246 | 177 | 2–4 |
| `countries-50m.json` | 756,420 | 229,996 | 80,617 | 241 | 5–10 |
| `countries-10m.json` | 3,665,491 | 918,737 | 478,373 | 258 | *(not mounted — see below)* |
| `cities.json` | 36,357 | 17,158 | — | 1,251 places | labels |
| **Total** | **4,566,029** | **1,204,386** | | | |

Exact byte counts, because the design doc quotes raw sizes in KiB (105 KB, 739 KB,
3.63 MB) but gzip sizes in decimal KB (38.6 KB, 237.1 KB, 910 KB) — comparing across the
two conventions makes a correct file look wrong. Gzip figures are `gzip -9`; nginx uses a
lower level by default, so served sizes will be slightly larger.

Total working tree ~4.35 MiB (4.57 MB); ~1.15 MiB over the wire if all three tiers load.
Only one country file is in the map at a time — see the design doc's zoom-swap table.

⚠ **`countries-10m.json` is committed but not currently used by the page.** `BASEMAP_TIERS`
in `index.html` lists 110m and 50m only. Measured with Leaflet 1.9.4's own project/clip/
simplify code on an AMD Ryzen 5 PRO 3400GE:

| Tier | Mount (parse + decode + project) | Every `zoomend` | Pan (`moveend`) |
|---|---|---|---|
| `countries-50m` | 58 ms | 11 ms | 0.1–2.1 ms |
| `countries-10m` | 300 ms | 87 ms | 0.8–2.5 ms |

Panning is not the problem: `Path._clipPoints` early-outs on `_pxBounds`, so only the 2–10
countries on screen cost anything. `Renderer._onZoomEnd` is — it re-projects **every** layer
with no culling, so all 546,001 vertices are re-projected on every zoom step, in the one band
whose purpose is zooming. Re-enabling 10m is one row in `BASEMAP_TIERS`, but it needs
viewport culling first: a z10 view needs only ~96k of those vertices.

Because it is not mounted, the 3.5 MB file is dead weight in the working tree and in the
`cp -r assets/.` deploy. Keep it for the culling work, or drop it and re-fetch per
*Regenerating* below — but do not leave it listed as a live tier.

Plus the one library needed to read them:

| File | Raw (bytes) | Gzipped (bytes) | Purpose |
|---|---|---|---|
| `topojson-client.min.js` | 7,169 | ~2,500 | decodes TopoJSON to GeoJSON for `L.geoJSON` |

It is vendored here rather than downloaded by `scripts/06_global_grin_health.sh`
(as Leaflet and Chart.js are) for the same reason the data files are: the point of
this directory is that the peer map makes **zero third-party requests**, and the
existing `cp -r assets/.` deploy step already carries it with no script change.

Every `countries-*.json` is a TopoJSON `Topology` carrying **both** a `countries` object
and a `land` object, so one file gives land fill and borders together.

**The page reads both objects, and not in the obvious way.** `buildBasemapFC()` in
`index.html` draws:

- **fill** from `objects.land` — one merged shape, so no internal border is ever a fill
  edge;
- **borders** from `topojson.mesh(topo, objects.countries, (a, b) => a !== b)` — one
  unfilled line mesh of the internal borders only.

It does **not** draw the 177/241 per-country features. Drawn that way every shared border
is stroked twice, once by each neighbour, and the second country's opaque fill then paints
over part of the first one's stroke — visibly uneven border weight anywhere countries are
small. Land + mesh is also **~20% fewer vertices in 2 Leaflet paths instead of 241**, which
matters because `Renderer._onZoomEnd` re-projects every layer with no culling.

⚠ The trade is that **no country is a Leaflet layer of its own**, so there is nothing to
hit-test, highlight or label per country. Nothing needs it today (the layer is
`interactive: false`; the peer dots own every interaction). A future "click a country"
feature would have to undo this, not extend it.

**Property names differ between sources and this is deliberate:**

- `countries-110m.json`, `countries-50m.json` — world-atlas upstream, property `name`
- `countries-10m.json` — built here, properties `n` (name) and `c` (ISO 3166-1 alpha-2)

The 10m set is stripped to two short keys because Natural Earth ships **168 properties
per feature**; keeping them would roughly double the file for data the map never reads.
The peer map currently reads **no** country property at all — land and the border mesh
carry none — but keep them: a country name is the first thing anything else built on this
data will want, and re-vendoring to add it back is not free.

`cities.json` is a flat array, **not** GeoJSON:

```json
[["Bombo", 10, 32.533, 0.583], ...]   // [name, scalerank, lon, lat]
```

Coordinates are rounded to 3 decimal places (~110 m). The map's `maxZoom` is 10, where one
pixel is ~153 m, so this is already finer than anything that can be displayed.
`scalerank` runs 0 (most prominent) to 10 — filter on it to thin labels at low zoom.

## What the mounted tiers do NOT contain

Measured, because "the map is missing an island" is otherwise unanswerable:

**`countries-110m.json` and `countries-50m.json` hold no land at all between 110 °E and
118 °E.** The Paracel (Hoàng Sa) and Spratly (Trường Sa) groups are absent from both, so
they cannot be missing "because of a bug" — the geometry was never in the file.

They exist only in `countries-10m.json`, which is **not mounted**, and there Natural Earth
files the Spratlys as their own entity (`Spratly Is.`) and the Paracels under **China**.
19 islets in total, and every one of them is **0.4–2.4 km across** — at the map's `maxZoom`
of 10 one pixel is ~153 m, so a true-size polygon is a couple of pixels at the deepest zoom
this map allows and nothing at all below about z7. Mounting the 3.5 MB tier would therefore
still not make them appear.

So `index.html` carries the 19 centroids inline (`VN_ISLANDS`) and draws them as
**fixed-pixel dots**, the way an atlas symbolises an archipelago. No asset changed.

⚠ **They are drawn in Vietnamese flag colours. That is the site operator's editorial
choice, not what the data says** — see the note beside `VN_ISLANDS`. Do not "correct" it
to match Natural Earth's attribution without asking.

## Dateline seams — repaired at runtime, do NOT "fix" the data

Every one of these files stores **Russia, Fiji and Antarctica** with a ring that steps
straight from `+180` to `-180` (or back). That is normal, valid Natural Earth: in lon/lat
the edge just means *continues on the other side*. Projected onto a flat canvas it is a
straight line across the **entire** map, and because the ring returns at a slightly
different latitude the pair fills as a full-width horizontal band:

| Country | Crossings per ring | Band appears at |
|---|---|---|
| Russia | 2 | ~65 °N (110m); ~65 °N and ~71.5 °N (50m) |
| Fiji | 2 | ~16 °S |
| Antarctica | 1 | ~84.7 °S (110m); ~90 °S and ~84.3 °S (50m) |

The CARTO raster never showed this because a tile renderer cuts geometry at the dateline
before it reaches the browser. Drawing our own geometry means owning that cut, so
`index.html` does it — `amRepair()`, once per tier, on the cached decode (0.4 ms for
110m, 1.8 ms for 50m). Rings with an **even** number of crossings are split into real
lobes and closed along the dateline; the **odd** one is Antarctica's closing seam, whose
polar cap edge is simply absent from the data, and is closed over the pole instead.

⚠ **The files are correct as published — do not edit them and do not re-export them to
remove the seams.** A pre-cut asset would be silently undone by the `curl` in
*Regenerating* below, which is exactly the kind of fix that comes back. The repair belongs
in the one place that projects the geometry.

## Licences

| Source | Licence |
|---|---|
| [Natural Earth](https://www.naturalearthdata.com/) (`countries-10m.json`, `cities.json`) | **Public domain** — no attribution required |
| [world-atlas](https://github.com/topojson/world-atlas) v2 (`countries-110m.json`, `countries-50m.json`) | **ISC** |
| [topojson-client](https://github.com/topojson/topojson-client) v3.1.0 (`topojson-client.min.js`) | **ISC** |

world-atlas is itself derived from Natural Earth. Crediting Natural Earth on the map is
courtesy, not a licence obligation — there is no ODbL/OSM share-alike or attribution
requirement anywhere in this set. That is one of the reasons this data was chosen.

## Regenerating

Only needed when Natural Earth publishes a new release — country borders do not move
often. Do this on a workstation, never on the VPS. Requires Node.js.

### 1. `countries-110m.json` and `countries-50m.json` — copied verbatim, not built

```sh
curl -sSL -o countries-110m.json https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json
curl -sSL -o countries-50m.json  https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json
```

### 2. `countries-10m.json`

Source: `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson`

Strip each feature's 168 properties down to `n` = `NAME` and `c` = `ISO_A2`, then:

```sh
# NOTE: the -p flag is required. `npx -y topojson-server@3 geo2topo ...` treats geo2topo
# as a filename and fails with ENOENT.
npx -y -p topojson-server@3 geo2topo -q 1e5 countries=ne10m-stripped.geojson -o ne10m-topo.json

# Add the `land` object, exactly as world-atlas does for its own files. This references
# the existing arcs, so it costs ~36 KB (1%), not a second copy of the geometry.
npx -y -p topojson-client@3 topomerge land=countries ne10m-topo.json -o countries-10m.json
```

### 3. `topojson-client.min.js`

```sh
curl -sSL -o topojson-client.min.js https://cdn.jsdelivr.net/npm/topojson-client@3/dist/topojson-client.min.js
```

Only `feature()` is used, but the whole 7 KB build is vendored unmodified so the
banner comment keeps stating its version and origin.

### 4. `cities.json`

Source: `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_populated_places_simple.geojson`

Emit `[name, scalerank, lon, lat]` per feature, lon/lat rounded to 3 decimals.

### Verifying a regenerated set

- all four parse as JSON
- each `countries-*.json` has objects `countries` **and** `land`
- arc vertices are 8,246 / 80,617 / 478,373 and `cities.json` has 1,251 rows
- exactly three features per tier contain a segment spanning more than 180° of
  longitude — Russia, Fiji, Antarctica. **More than three, or a different set, means
  the runtime repair now has cases it was never measured against**; re-read *Dateline
  seams* above before shipping the file.

⚠ The design doc quotes **548,471** for the 10m tier. That is the coordinate count of the
**source GeoJSON**, measured before conversion — not a property of the file in this
directory. `geo2topo -q 1e5` quantises and stores each shared border once, which is what
takes it to 478,373 arc vertices (546,001 points once decoded by `topojson-client`).
The two numbers describe different things; a regenerated file should match **478,373**.
If the source GeoJSON no longer counts 548,471, Natural Earth has published a new
release — check its changelog rather than silently accepting the new geometry.
