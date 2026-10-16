# Script 06b — GrinScan: implementation

> **Covers code as of:** 2026-05-10 · **Last verified:** never systematically verified
> **Product code last changed:** 2026-07-27 — `scripts/lib/06b_grinscan.sh`, `web/06b_grinscan/`
> **Scope:** the contracts the running code holds, the runtime behaviour by node mode, and the obstacles hit while building it. The plan is `script06b_design.md`.

**Status:** built; no VPS acceptance run is recorded in this doc. Reference this before touching `server.js`, `info.js`, `app.js` or the CSS theme system.

## What shipped

### Hashrate calculation — the formula that is 366× too high if wrong

WRONG (common mistake):
  hashrate = difficulty / 60

CORRECT formula (Cuckatoo32):
  GPS = diff_delta × 42 / block_time_seconds / 16384

  diff_delta         = total_difficulty[n] - total_difficulty[n-1]
  42                 = Cuckatoo32 cycle length (proof size)
  block_time_seconds = actual elapsed seconds (use real timestamps, NOT fixed 60)
  16384              = 32 × 2^(32-23) = 32 × 512  (C32 solution rate)

In server.js:
  Live:    hashrateGps = perBlockDiff * 42 / dt / 16384;    // dt = actual seconds
  History: hashrate_gps = row.difficulty * 42 / 60 / 16384; // 60s target (no real ts in batch)

Display units: G/s (< 1000), kG/s (>= 1000), MG/s (>= 1000000)
Matches: world.grin.money, 06_collector.py, aglkm/grin-explorer
### Block lookup order — cache miss on a pruned node

Block lookup order in /api/block/:id:
  1. Check SQLite cache  →  fast, works for recent blocks
  2. If not cached AND node_mode === 'archive'  →  live fetch from Grin node
  3. Otherwise  →  404 { error: "Block not found", hint: "cache_miss" }

Problem: genesis block (#0) and very old blocks are NOT in the SQLite cache window.
  - Pruned node: these blocks are gone from chain data — 404 is correct and permanent.
  - Archive node: server fetches them live from the node — works.

If a user reports "genesis block not loading":
  → Check whether the node is archive or pruned (visible in Network tab / node-type-badge).
  → Only archive nodes can serve blocks outside the cache window.

The string hint: 'cache_miss' is checked by the frontend (app.js showCacheMiss()).
Do NOT rename it without updating the frontend handler.
### Node API method split — `get_status`, not `get_tip`, on the Owner API

On the Node OWNER API (/v2/owner), get_tip does not exist in practice.
It returns {"error": {"code": -32601, "message": "Method not found"}}.

WRONG:  POST /v2/owner  {"method": "get_tip", ...}
RIGHT:  POST /v2/owner  {"method": "get_status", ...}

get_status returns: tip height, total difficulty, number of peers, sync status.
That is everything you need for polling. Use it exclusively for node status checks.

get_tip DOES exist on the Foreign API (/v2/foreign) — that is a different endpoint.
Node Owner vs Foreign API method split:
  Owner API:   get_status, get_connected_peers, validate_chain, compact_chain
  Foreign API: get_block, get_header, get_outputs, get_pool_size, push_transaction
### Result unwrapping — the node wraps results in `{"Ok": T}`

The Grin node serialises Rust Result<T, E> inside the JSON-RPC result field:
  Success: { "result": { "Ok": <actual data> } }
  Error:   { "result": { "Err": <error> } }

WRONG:  const data = response.result;
RIGHT:  const data = unwrapResult(response.result);  // strips the Ok/Err wrapper

GrinScan's ownerApi() and foreignApi() helpers call unwrapResult() automatically.
Always use these helpers — never access .result directly for node API calls.
### `_prev_timestamp` — injected by `/api/block/:id`, nowhere else

The Grin node API does not return the previous block's timestamp alongside a block.
GrinScan injects block._prev_timestamp by doing a second SQLite lookup for height - 1.

This field is REQUIRED for the live hashrate formula:
  const dt = block.header.timestamp - block._prev_timestamp;  // actual seconds
  const hashrateGps = perBlockDiff * 42 / dt / 16384;

Without _prev_timestamp, dt is unknown and the calculation falls back to the 60s estimate,
which gives inaccurate results for blocks with non-standard block times.

If you add or replace the block-fetch endpoint, make sure _prev_timestamp is injected.
The /api/search endpoint (now removed) was missing this field — that was one reason it
was removed.
### `/api/*` vs `/rest/*` — the CORS split

Prefix      CORS        Intended callers
/api/*      NONE        GrinScan frontend (same-origin only)
/rest/*     ENABLED     External apps, other browser origins
/events     NONE        GrinScan frontend SSE only

Rule: if an external browser app needs to call an endpoint, it belongs in /rest/ with
Access-Control-Allow-Origin: * — same pattern as /rest/stats.json and /rest/supply.json.
Do NOT add CORS headers to /api/* routes.

/events has no CORS. External server-side scripts (Python, Node) can use it fine since
CORS is a browser restriction only. Cross-origin browser apps cannot subscribe to it.
### SSE `/events` — push fires height only, not block data

broadcastNewBlock() sends: { type: "block", height: N }
That's it — no block content, no hash, no tx count.

The frontend reacts by calling pollStats() and fetchPage(1) to pull fresh data.
SSE is a trigger, not a data pipe.

If a new feature needs to react to new blocks, hook into broadcastNewBlock() in server.js
and add a new event type — do not embed block JSON in the stream payload.
### Runtime behaviour by node mode

Source: project memory `project_grinscan_archive_lazy`; verify against `web/06b_grinscan/server.js` before asserting.

- **Node mode probe:** `get_block(1)` success or failure is the archive-vs-pruned discriminator (`node_mode`).
- **Pruned node:** GrinScan degrades gracefully — it keeps a rolling `history_days` window in its own SQLite and serves recent blocks; genesis and old lookups beyond the cache return "not found". The aglkm grin-explorer (06b option C) requires an archive node and refuses to install on a pruned one. The peer-map collector (`06_collector.py`) is unaffected: it owns a full genesis→tip import in its own `stats.db`.
- **Lazy block import (default):** only the recent `blocks_cache` window is cached (`startupBackfill` ≈ tip−500, sequential); the poller fills forward; old blocks are served live on a cache miss in `/api/block` (`fetchBlockLive`, archive only, no insert). The eager `historicalBackfill` is opt-in (`config.backfill_history`, default `false`; absent in old configs → lazy) and, when on, runs at concurrency 3 with a 150 ms pause between batches. `jsonRpc` timeout is a hardcoded 10 s.
- **`daily_stats` rollup:** derived by aggregating the per-block `blocks` table per UTC day (exact Σtx / Σfees, cumulative-difficulty deltas → `hashrate_gps = work×42/sec/16384`), recomputed incrementally from the last finalised day; a day is `final=1` once a later day exists. `/api/history` serves ≤ 7 d from per-block (`source:"blocks"`, hourly) and > 7 d from `daily_stats` (`source:"daily"`, ≤ 800 points).
- **Kernel and output lookup:** pages `/kernel.html?ex=<excess>` and `/output.html?c=<commit>` (query-param routing, the GrinScan convention) over `/api/kernel/:excess` and `/api/output/:commit`. Foreign API `get_kernel` (immutable, 300 s cache) and `get_outputs` (spent status mutable, 60 s cache); no archive gate — kernels always resolve on a pruned node, a spent and pruned output 404s. Smart search `searchTarget()`: digits or 64-hex → block, 66-hex → kernel or output (indistinguishable; a miss probes the other kind). Block-page kernel excesses and output commits link into these pages; inputs deliberately do not (spent → would 404).

## Runbook

- **Genesis or an old block will not load:** check whether the node is archive or pruned (the node-type badge, or the Network tab). Only an archive node serves blocks outside the cache window; on a pruned node the 404 is correct and permanent.
- **Blocks and stats stop loading with 401 after a Script 01 rebuild:** the secret copies under `/opt/grin/grinscan/{test,main}/` are stale. Re-run GrinScan Configure (step 2), or rely on the box-wide `grin-secret-sync` timer.
- **A cron-started session misbehaves:** every `tmux new-session` in a cron wrapper needs the inline `SHELL=/bin/bash` prefix (see Build notes).
- **Syntax check before shipping:** `node --check web/06b_grinscan/server.js`, and `bash -n scripts/lib/06b_grinscan.sh`.

## Build notes — obstacles & lessons

The full pre-G7 text of this doc (the original numbered "gotchas" list, with its code samples): `git log -- docs/reference/script06b_implementation.md`, the commit before the G7 re-org (2026-10-13).

### Node API

#### `get_tip` answers "Method not found" on the Owner API
**Symptom:** status polling returns `{"error":{"code":-32601,"message":"Method not found"}}`. **Cause:** `get_tip` lives on the Foreign API; the Owner API has `get_status`. **Fix:** poll `get_status` (height, total difficulty, peers, sync). **Lesson:** the Owner/Foreign method split in *What shipped* is the contract; check it before blaming the node.

#### Block list silently blank: block methods on the wrong endpoint
**Symptom:** an empty block list with no visible error. **Cause:** two mistakes that compound — `get_block`/`get_header`/`get_outputs`/`get_pool_size` called through `ownerApi()` (method not found), and `response.result` read without `unwrapResult()`, which on the right endpoint yields `{Ok: …}` instead of the block. **Fix:** block data only through `foreignApi()`; both helpers unwrap. **Lesson:** an error that never reaches the UI is the same as no error — make the helper own the unwrap so callers cannot skip it.

#### A convenience alias that dropped a required field
**Symptom:** `/api/search?q=` had zero callers and omitted `_prev_timestamp`, so any block fetched through it fell back to the 60 s hashrate estimate. **Fix:** removed from `server.js` and the API page listing. **Lesson:** before adding an alias for an endpoint, verify something calls it and that it keeps every injected field callers depend on.

### Credentials

#### `www-data` cannot read the node's secret files
**Symptom:** node API calls fail silently; blocks and stats never load. **Cause:** Script 01 creates both secrets `grin:grin` mode 600, and the GrinScan service runs as `www-data`, which is not in the `grin` group — `EACCES`. **Fix:** Configure (step 2) copies both secrets into `/opt/grin/grinscan/{test,main}/`, chowns the copies `www-data`, and points `foreign_secret_path` / `owner_secret_path` in `config.json` at them; the node's own files are never touched. **Lesson:** a copied secret goes stale when the original is regenerated — that is what the secret self-heal exists for.

### Service launch

#### tmux started from cron uses `/bin/sh`
**Symptom:** bash-only syntax inside the session silently fails. **Cause:** cron sets `SHELL=/bin/sh`; a `#!/bin/bash` shebang sets only the script's own interpreter, not the variable tmux children inherit, and `export SHELL=` at the top of the wrapper does not help once a tmux server already exists. **Fix:** prefix the command inline: `SHELL=/bin/bash tmux new-session -d -s … -c "$DIR" "…"`. **Lesson:** the inline prefix is the only reliable form (now a toolkit-wide rule in CLAUDE.md).

### Front end

#### Mainnet page loaded the testnet theme on refresh
**Symptom:** refreshing the mainnet page showed the matrix (testnet) theme instead of neon. **Cause:** the early theme code ran before `window.GRINSCAN_NETWORK` was set — the globals script was injected near the end of `<head>`, and every default path falls back with `|| 'testnet'`. A second variant: the localStorage key carried a network suffix computed at parse time, so with the global undefined it became `grinscan-theme-undefined`, missed the saved preference and fell to the testnet default. **Fix, three parts together:** inject the globals immediately after `<head>`; patch the initial `<link id="theme-css">` href server-side (`dark.css` → `neon.css` mainnet / `matrix.css` testnet) so the right CSS is in the DOM before any JS; drop the key suffix (`grinscan-theme`) — the networks are different origins, so localStorage is already partitioned. **Lesson:** never lean on `|| 'testnet'` as a safe fallback; it silently applies the wrong theme in production.

#### `var(--glow)` makes hover invisible in the dark theme
**Symptom:** a card hover effect that does nothing in dark. **Cause:** `--glow` is `none` in dark (a faint shadow in light, cyan in neon, green in matrix). **Fix:** hover states use an explicit `rgba` `box-shadow` in `grinscan.css` (orange accent), overridden in `neon.css` (cyan) and `matrix.css` (green). **Lesson:** `var(--glow)` is for resting shadows where invisible is acceptable, never for interactive state.

#### `h3` section headings merged into the text
**Symptom:** users could not tell sections apart in the dark and matrix themes. **Cause:** `.gs-info-section h3` used `color: var(--muted)`. **Fix:** `var(--text)`, a 2 px accent left border, 10 px left padding, 14 px size; neon and matrix use the full accent colour with a matching `text-shadow`. **Lesson:** do not separate sections by weight or size alone; the left accent border is the cue for new tab content.

## Open items

- Deep history goes back only as far as accumulated blocks: `daily_stats` is derived from the per-block table and is not reconstructed to genesis.
- Pre-warming the cache or a heavy genesis crawl wants an 8 GB+ box; lazy mode (single on-demand reads) is light enough for a ~4 GB archive box.
- No VPS acceptance run is recorded in this doc.
