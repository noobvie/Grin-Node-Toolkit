# Script 06 — self-hosted basemap: per-session build prompts

Companion to `docs/generated/script06_design.md`, section
**"Peer map — self-hosted basemap, no third-party tiles (plan, rev. 2026-09-02)"**.

Five build sessions plus one acceptance session. **Run them in order** — each states its
prerequisites. Parts 1-4 are the change; Part 5 is optional polish; Part 6 runs on the VPS.

Each prompt is written to be pasted into a **cold session**. `CLAUDE.md` and `MEMORY.md` load
automatically, and memory `project_selfhosted_basemap_06` points at the design doc — but each
prompt still names the file to read first, because a cold session should not have to infer it.

**Natural checkpoint: after Part 2 the watermark is gone and the map is shippable.** Parts 3-5
are improvements on a working map, not prerequisites for one.

| Part | Session | Touches | Ships? |
|---|---|---|---|
| 1 | Data prep + commit assets | `web/06_stats_map/stats/assets/` | no |
| 2 | Basemap core (110m, themes) | `index.html` | **yes — watermark gone** |
| 3 | Multi-resolution lazy tiers | `index.html` | yes |
| 4 | Deploy wiring | `06_global_grin_health.sh` | yes |
| 5 | Labels *(optional)* | `index.html` | yes |
| 6 | VPS acceptance | none | — |

---

## Part 1 — Data prep and commit the assets

**Prerequisites:** none. Purely local, no repo code changes beyond adding files.

```
Read docs/generated/script06_design.md, the section "Peer map — self-hosted basemap,
no third-party tiles (plan, rev. 2026-09-02)". You are doing Part 1 only: producing the
basemap data files and committing them. Do not touch any HTML or shell script this session.

Produce four files in web/06_stats_map/stats/assets/ :

1. countries-110m.json  — copy of world-atlas@2 countries-110m.json (ISC, ~105 KB)
2. countries-50m.json   — copy of world-atlas@2 countries-50m.json  (ISC, ~739 KB)
3. countries-10m.json   — built here (see below, ~3.63 MB)
4. cities.json          — built here (see below, ~37 KB)

For countries-10m.json:
  - source: https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson
  - strip properties to exactly two: n = NAME, c = ISO_A2  (the source carries 168 per
    feature; all but these two are dead weight)
  - convert with: npx -y -p topojson-server@3 geo2topo -q 1e5 countries=<in> -o <out>
    NOTE: the -p flag is required; `npx -y topojson-server@3 geo2topo` treats geo2topo as a
    filename and fails with ENOENT.

For cities.json:
  - source: https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_populated_places_simple.geojson
  - emit a flat array, NOT GeoJSON: [[name, scalerank, lon, lat], ...]
  - round lon/lat to 3 decimal places (~110 m; the map's maxZoom is 10 where one pixel is
    ~153 m, so this is already finer than the display)

Verify before committing, and report the actual numbers:
  - all four parse as JSON
  - countries-*.json each have objects "countries" AND "land", and a name property
  - vertex counts are 8,246 (110m) / 80,617 (50m) / 548,471 (10m) — if 10m differs by more
    than a few percent, Natural Earth has published a new release; say so, don't silently
    accept it
  - cities.json has ~1,251 rows
  - gzip sizes land near 38.6 KB / 237.1 KB / 910 KB / 17 KB
  - total working-tree size ~4.5 MB

Licences: Natural Earth is public domain, world-atlas is ISC. Record both in a short
assets/README.md alongside the files, with the source URLs and the exact geo2topo command,
so the set can be regenerated later.

Do all scratch work in the scratchpad dir, not in the repo. Clean it up before you finish.
```

---

## Part 2 — Basemap core: replace the tile layer

**Prerequisites:** Part 1 committed.
**This is the session that removes the CARTO dependency.** Single resolution only.

```
Read docs/generated/script06_design.md, section "Peer map — self-hosted basemap ... rev.
2026-09-02" — especially "Repo changes, file by file" and "Things easy to miss".

You are doing Part 2 only: replace the CARTO raster tile layer in
web/06_stats_map/stats/index.html with a vector basemap drawn from the committed
countries-110m.json. ONE resolution this session. Do not add the 50m/10m tiers, do not add
labels, do not touch scripts/.

What to change:
1. Delete the TILE_URLS object (currently ~line 1030) and TILE_ATTR's CARTO half.
2. Add topojson-client beside the existing local leaflet.min.js include (~line 47). Vendor
   it into the repo the way the flag webfont already is; do not hotlink a CDN at runtime.
3. Add a single makeBasemapLayer(theme) that returns an L.geoJSON layer built from the
   TopoJSON, decoded with topojson-client's feature().
4. Replace BOTH tile-layer construction sites with it.

CRITICAL — the two-site trap: the tile layer is built in initMap() (~line 1052) AND AGAIN in
applyTheme()'s theme swap (~line 1518), with a duplicated options object. Fixing only one
makes the basemap revert the moment a user switches theme. With vector geometry a theme change
should become setStyle() on the existing layer rather than a remove/re-add, which removes the
duplication at the root — prefer that.

Theme styling: four style objects (dark / light / matrix / hp) giving land fill, border
stroke, and stroke width. matrix and hp currently just re-point at CARTO's dark_all because
CARTO has no green or purple basemap; give them real colours from the existing CSS custom
properties for those themes.

Preserve exactly:
  - map options: center [20,10], zoom 2, minZoom 2, maxZoom 10, preferCanvas true,
    maxBounds [[-85.05,-180],[85.05,180]], maxBoundsViscosity 1.0, worldCopyJump false
  - the peer dots, tooltips, click-flyTo, grouped divIcon markers and markersLayer are OUT OF
    SCOPE — do not refactor them
  - markersLayer.bringToFront() in applyTheme() must survive: group markers are DOM divIcons
    in markerPane (z 600) and the basemap goes to overlayPane (z 400). A basemap layer added
    after the markers will cover them.

Watch for:
  - TopoJSON is NOT GeoJSON. L.geoJSON cannot read it directly; topojson.feature() must decode
    it first. Handing the raw file to Leaflet yields an empty map with NO error.
  - noWrap and bounds were tileLayer options and do not transfer. Reproduce the no-horizontal-
    repeat behaviour on the vector layer, or the world tiles sideways when panned.
  - Attribution: drop CARTO/OSM, credit Natural Earth. It is public domain so this is courtesy
    rather than a licence term, but do not simply delete the attribution control.

Definition of done:
  - zero requests to any third-party host when the page loads (this is the real success
    criterion — the watermark disappearing is also what a CARTO API key would buy)
  - all four themes render a correctly coloured basemap, and switching themes repeatedly keeps
    working (exercise the two-site trap deliberately)
  - peer dots, tooltips, click-flyTo and grouped markers all still work, and the dots are
    still ON TOP of the basemap
  - no horizontal world repeat at any zoom or pan

Verify without leaving a server running: the toolkit rule is that every local test process is
killed in the session that started it. Prefer a one-shot jsdom/node check over a live server;
if you must serve, bind 127.0.0.1, capture the PID, and kill the whole tree when done.
```

---

## Part 3 — Multi-resolution lazy tiers

**Prerequisites:** Part 2 merged and working.

```
Read docs/generated/script06_design.md, sections "The one real technical risk — vertex count,
not file size" and "Page-load cost — measured, and it gets FASTER".

You are doing Part 3 only: add the 50m and 10m resolution tiers to the Part 2 basemap in
web/06_stats_map/stats/index.html, with lazy loading. No labels, no script changes.

Zoom bands:
    z2-4  -> countries-110m.json    8,246 vertices    38.6 KB gz  (loaded with the page)
    z5-7  -> countries-50m.json    80,617 vertices   237.1 KB gz  (lazy)
    z8-10 -> countries-10m.json   548,471 vertices     910 KB gz  (lazy)

Why bands exist at all: Leaflet projects a polygon's FULL point list before clipping it to the
viewport, so drawing 548k vertices on every pan frame stutters. The constraint is per-frame
projection cost, not file size. Only one tier is in the map at a time.

Rules that keep this off the critical path:
1. Progressive refinement, never a stall. Keep drawing the tier already in hand until the finer
   one has downloaded AND decoded, then swap. A slow network must mean a briefly coarser map —
   never a blank one, never a frozen UI, never a spinner over the map.
2. Prefetch 50m on idle (requestIdleCallback) after first paint, so ordinary z5-7 exploration
   is already warm.
3. flyTo(maxZoom) on a dot click jumps STRAIGHT to z10, so it hits the 10m tier cold — this is
   a common interaction, not an edge case. Start that fetch at the START of the flight, not on
   arrival; the animation runs ~1-1.5 s and covers most of the download.
4. Fetch each tier at most once. Cache the decoded GeoJSON, not just the response.
5. Theme changes must restyle whichever tier is current without re-fetching anything.

MEASURE BEFORE YOU COMMIT TO 10m. Pan and zoom around z8-10 over a dense area (Europe, east
Asia) and check frame rate. If it stutters even with the band swap, say so and stop at 50m —
capping detail there costs coarser coastlines at deep zoom and nothing else. That is a real
possible outcome, not a failure; report it rather than shipping a janky map.

Definition of done:
  - initial page load fetches ONLY countries-110m.json (~38.6 KB gz), not the other two
  - DevTools shows 50m and 10m arriving lazily, and the map never blanks or freezes during a
    swap
  - clicking a peer dot flies to z10 with the fetch already in flight
  - z8-10 pan is smooth, or you have reported that it is not and recommended stopping at 50m
  - all four themes still work on every tier

Kill any local test process in this same session.
```

---

## Part 4 — Deploy wiring

**Prerequisites:** Parts 1-3 merged.

```
Read docs/generated/script06_design.md, section "Peer map — self-hosted basemap ... rev.
2026-09-02", subsection "Repo changes, file by file".

You are doing Part 4 only: make scripts/06_global_grin_health.sh deploy the new basemap
correctly. Do not change the map's behaviour or any HTML logic.

1. The assets copy at ~line 565 (cp -r "$WEB_SRC/assets/." "$WWW_DIR/assets/") already carries
   the four data files — verify that, do not duplicate it.
2. topojson-client: if Part 2 vendored it into the repo, confirm the deploy path picks it up.
   If it is fetched at install time instead, add a curl block in the existing
   `if [[ ! -f "$WWW_DIR/..." ]]` idiom used for leaflet/chart.js (~lines 603-618), with
   `|| die` on failure like its neighbours.
3. Confirm NO vhost change is needed. There is no tiles directory in this plan and no
   location block to add — the data files are ordinary static assets under assets/, already
   served by the existing location / try_files rule. Say so explicitly rather than silently
   skipping it.
4. robots.txt (~line 496): decide whether assets/ should be disallowed. The four JSON files are
   public-domain map data, not private — probably leave crawlable, but state the choice.
5. Confirm nginx actually gzips JSON. The entire size argument rests on it: uncompressed these
   files are ~4.5 MB instead of ~1.2 MB, which would be a real regression on mobile. Debian's
   default gzip_types does include application/json — verify rather than assume, and if the
   toolkit writes its own gzip config anywhere, make it explicit there.

Toolkit conventions that apply here:
  - bash -n the script before finishing; it MUST pass
  - _finalize_seo() re-copies pristine HTML from $WEB_SRC over $WWW_DIR (~lines 490-493) and
    _inject_analytics re-applies GA afterwards. Nothing you add may depend on an edit made
    directly to a deployed file.
  - if you add any new lib file, remember libs run with errexit DISABLED (every hub dispatch is
    ||-guarded), so guard every cp/mv/curl individually with || { error "..."; return 1; }

Definition of done: bash -n passes; a fresh install and a re-run of an existing install both
end with all four data files plus topojson-client present under $WWW_DIR; no vhost change was
needed, or the one that was needed is written and explained.
```

---

## Part 5 — Labels *(optional — decide whether you want them at all)*

**Prerequisites:** Parts 1-4 merged.
**Consider skipping.** Peer tooltips already show `city, country`, and the cleanest look for the
matrix/hp themes has no basemap labels. Do this only if the map feels empty in practice.

```
Read docs/generated/script06_design.md, section "Labels".

You are doing Part 5 only: add basemap labels to web/06_stats_map/stats/index.html using the
committed assets/cities.json. No other changes.

Context: Leaflet has NO collision-aware label placement — this is the one thing raster tiles
gave us for free, and the one place effort genuinely moved rather than disappeared. Overlaps
will not resolve themselves.

cities.json is a flat array of [name, scalerank, lon, lat], 1,251 rows, 17 KB gzipped. The
scalerank histogram is well shaped for zoom filtering:
    rank 0: 27 places   1: 41   2: 118   3: 336   4: 606   (then 6-10: 123 total)
So roughly `scalerank <= zoom - 2` gives a natural progression from ~27 labels at z2 to the
full set by z8.

Implement:
  - render as divIcon markers in a dedicated layer, filtered by the rule above AND by the
    current viewport bounds (do not create 1,251 DOM nodes)
  - rebuild the visible set on zoomend/moveend, not on every frame
  - label colour comes from the theme, like everything else added in Part 2
  - keep them BELOW the peer dots in stacking order — peer data is the content, labels are
    context

Accept that overlapping labels are not resolved; do not build a collision solver. If the result
looks cluttered, tighten the rank threshold rather than adding machinery.

Definition of done: labels appear and thin out sensibly across z2-10, they follow the theme,
they never obscure a peer dot, and the initial page load cost rises by no more than ~17 KB.
```

---

## Part 6 — VPS acceptance

**Prerequisites:** Parts 1-4 (and optionally 5) deployed to the server.
**Not a coding session** — this runs against the live host.

```
Read docs/generated/script06_design.md, section "Acceptance", and walk it on the live stats
host. Report actual output for each step; do not mark anything green from inference.

1. Load the page with DevTools open: ZERO requests to any third-party host. This is the real
   success criterion — the watermark disappearing is also what a CARTO API key would buy, and
   that outcome was explicitly rejected.
2. Confirm the JSON assets are served with content-encoding: gzip. Uncompressed they are
   ~4.5 MB instead of ~1.2 MB.
3. Confirm initial load fetches only countries-110m.json.
4. Cycle all four themes; the basemap must restyle each time.
5. Pan and zoom at z8-10 over a dense area; watch frame rate.
6. Click several peer dots: flyTo(z10) must not stall, and the dots/tooltips/grouped markers
   must all still work.
7. Check the antimeridian and the maxBounds edges — no horizontal world repeat.
8. Repeat on a phone, or at least at a narrow viewport.

If anything fails, capture the evidence before changing code. Per CLAUDE.md, confirm the root
cause from actual output before editing — a plausible suspect is not a confirmed cause.

Afterwards, update docs/generated/script06_design.md: change the section's status line from
PLANNED to built, with the date, and record anything that turned out differently from the plan
(especially the Part 3 frame-rate result and the final tier set).
```

---

## Notes for whoever runs these

- **Parts 2 and 3 are the only sessions with real design risk.** Part 1 is mechanical, Part 4
  is plumbing, Part 5 is optional, Part 6 is verification.
- **Part 3 is allowed to fail its own goal.** "10m stutters, stop at 50m" is a legitimate
  outcome and the prompt says so explicitly. A session that ships a janky map because the
  prompt said to wire three tiers has done the wrong thing.
- **Nothing here needs a VPS until Part 6.** Parts 1-5 are local edits to a static page.
- **Rollback at any point** is a `git revert` of the HTML plus a redeploy; the emergency
  keyless tile URL is in the design doc's "Rollback" section (⚠ Esri's path is `{z}/{y}/{x}` —
  y before x; copying the current `{z}/{x}/{y}` order silently mirrors the world).
