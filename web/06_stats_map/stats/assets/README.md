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
| `countries-50m.json` | 756,420 | 229,996 | 80,617 | 241 | 5–7 |
| `countries-10m.json` | 3,665,491 | 918,737 | 478,373 | 258 | 8–10 |
| `cities.json` | 36,357 | 17,158 | — | 1,251 places | labels |
| **Total** | **4,566,029** | **1,204,386** | | | |

Exact byte counts, because the design doc quotes raw sizes in KiB (105 KB, 739 KB,
3.63 MB) but gzip sizes in decimal KB (38.6 KB, 237.1 KB, 910 KB) — comparing across the
two conventions makes a correct file look wrong. Gzip figures are `gzip -9`; nginx uses a
lower level by default, so served sizes will be slightly larger.

Total working tree ~4.35 MiB (4.57 MB); ~1.15 MiB over the wire if all three tiers load.
Only one country file is in the map at a time — see the design doc's zoom-swap table.

Every `countries-*.json` is a TopoJSON `Topology` carrying **both** a `countries` object
and a `land` object, so one file gives land fill, borders and names together.

**Property names differ between sources and this is deliberate:**

- `countries-110m.json`, `countries-50m.json` — world-atlas upstream, property `name`
- `countries-10m.json` — built here, properties `n` (name) and `c` (ISO 3166-1 alpha-2)

The 10m set is stripped to two short keys because Natural Earth ships **168 properties
per feature**; keeping them would roughly double the file for data the map never reads.
Consumers must read `name` on the two world-atlas files and `n` on the 10m file.

`cities.json` is a flat array, **not** GeoJSON:

```json
[["Bombo", 10, 32.533, 0.583], ...]   // [name, scalerank, lon, lat]
```

Coordinates are rounded to 3 decimal places (~110 m). The map's `maxZoom` is 10, where one
pixel is ~153 m, so this is already finer than anything that can be displayed.
`scalerank` runs 0 (most prominent) to 10 — filter on it to thin labels at low zoom.

## Licences

| Source | Licence |
|---|---|
| [Natural Earth](https://www.naturalearthdata.com/) (`countries-10m.json`, `cities.json`) | **Public domain** — no attribution required |
| [world-atlas](https://github.com/topojson/world-atlas) v2 (`countries-110m.json`, `countries-50m.json`) | **ISC** |

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

### 3. `cities.json`

Source: `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_populated_places_simple.geojson`

Emit `[name, scalerank, lon, lat]` per feature, lon/lat rounded to 3 decimals.

### Verifying a regenerated set

- all four parse as JSON
- each `countries-*.json` has objects `countries` **and** `land`
- arc vertices are 8,246 / 80,617 / 478,373 and `cities.json` has 1,251 rows

⚠ The design doc quotes **548,471** for the 10m tier. That is the coordinate count of the
**source GeoJSON**, measured before conversion — not a property of the file in this
directory. `geo2topo -q 1e5` quantises and stores each shared border once, which is what
takes it to 478,373 arc vertices (546,001 points once decoded by `topojson-client`).
The two numbers describe different things; a regenerated file should match **478,373**.
If the source GeoJSON no longer counts 548,471, Natural Earth has published a new
release — check its changelog rather than silently accepting the new geometry.
