GrinScan (06b) — Implementation Gotchas & Solutions
=====================================================
Compiled from real bugs and surprises hit during development.
Reference this before touching server.js, info.js, app.js, or the CSS theme system.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. HASHRATE CALCULATION — WRONG FORMULA GIVES 366× TOO HIGH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2. GENESIS / OLD BLOCK LOOKUP — CACHE MISS ON PRUNED NODE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
3. get_tip RETURNS "Method not found" — USE get_status INSTEAD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
4. RESULT UNWRAPPING — Grin node wraps results in {"Ok": T}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The Grin node serialises Rust Result<T, E> inside the JSON-RPC result field:
  Success: { "result": { "Ok": <actual data> } }
  Error:   { "result": { "Err": <error> } }

WRONG:  const data = response.result;
RIGHT:  const data = unwrapResult(response.result);  // strips the Ok/Err wrapper

GrinScan's ownerApi() and foreignApi() helpers call unwrapResult() automatically.
Always use these helpers — never access .result directly for node API calls.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
5. _prev_timestamp — INJECTED BY /api/block/:id, NOWHERE ELSE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
6. /api/* vs /rest/* — CORS SPLIT, DO NOT MIX THEM
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Prefix      CORS        Intended callers
/api/*      NONE        GrinScan frontend (same-origin only)
/rest/*     ENABLED     External apps, other browser origins
/events     NONE        GrinScan frontend SSE only

Rule: if an external browser app needs to call an endpoint, it belongs in /rest/ with
Access-Control-Allow-Origin: * — same pattern as /rest/stats.json and /rest/supply.json.
Do NOT add CORS headers to /api/* routes.

/events has no CORS. External server-side scripts (Python, Node) can use it fine since
CORS is a browser restriction only. Cross-origin browser apps cannot subscribe to it.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
7. SSE (/events) — PUSH FIRES HEIGHT ONLY, NOT BLOCK DATA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

broadcastNewBlock() sends: { type: "block", height: N }
That's it — no block content, no hash, no tx count.

The frontend reacts by calling pollStats() and fetchPage(1) to pull fresh data.
SSE is a trigger, not a data pipe.

If a new feature needs to react to new blocks, hook into broadcastNewBlock() in server.js
and add a new event type — do not embed block JSON in the stream payload.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
8. CSS GLOW — --glow: none IN DARK THEME, HOVER IS INVISIBLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Theme --glow values:
  dark:   none
  light:  0 2px 8px rgba(0,0,0,0.08)   (subtle drop shadow)
  neon:   0 0 18px rgba(0,240,255,0.22), ...  (cyan glow)
  matrix: 0 0 16px rgba(0,255,68,0.12), ...   (green glow)

WRONG (hover effect invisible in dark theme):
  .my-card:hover { box-shadow: var(--glow); }

RIGHT pattern used in GrinScan:
  1. grinscan.css — explicit rgba box-shadow (orange accent, works in dark + light):
       .my-card:hover { box-shadow: 0 0 14px rgba(255,153,0,0.22), 0 4px 16px rgba(0,0,0,0.3); }
  2. neon.css — override with cyan:
       .my-card:hover { box-shadow: 0 0 20px rgba(0,240,255,0.38), ...; }
  3. matrix.css — override with green:
       .my-card:hover { box-shadow: 0 0 18px rgba(0,255,68,0.32), ...; }

Only use var(--glow) for ambient/resting shadows where invisible is an acceptable fallback.
Never use it for interactive hover states.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
9. SECTION HEADINGS (h3) — var(--muted) IS TOO SUBTLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Default .gs-info-section h3 used color: var(--muted). In dark/matrix themes this makes
headings visually merge into surrounding text — users cannot distinguish sections.

Fix applied (grinscan.css):
  color: var(--text);               changed from var(--muted)
  border-left: 2px solid var(--accent);   left accent stripe as visual anchor
  padding-left: 10px;
  font-size: 14px;                  bumped from 13px

Theme overrides (neon.css, matrix.css):
  color: var(--accent);             full accent colour
  text-shadow: 0 0 8px ...;         glow matching theme accent

When adding new tab content, use the same pattern. Do not rely on weight or size alone
to separate sections — the left accent border is the primary visual cue.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
10. DEAD-CODE ENDPOINT — /api/search WAS REMOVED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/api/search?q= was a query-param wrapper around the same findBlock() lookup as
/api/block/:id. It had ZERO callers (the search box redirects to block.html?h=
which calls /api/block/:id directly) and intentionally omitted _prev_timestamp.

Removed from both server.js and the API page docs listing in app.js.

Rule going forward: before adding a convenience alias for an existing endpoint,
  - verify it will actually be called by something
  - verify it does not silently drop fields callers depend on (_prev_timestamp, etc.)


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
11. tmux IN CRON — SHELL=/bin/bash PREFIX IS MANDATORY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

cron sets SHELL=/bin/sh. A #!/bin/bash shebang only affects the script's own interpreter,
not the SHELL env var inherited by child processes. If tmux starts (or a new session is
created) while SHELL=/bin/sh, all sessions use sh — bash-only syntax will silently fail.

WRONG:
  tmux new-session -d -s "grinscan" -c "$DIR" "node server.js"

RIGHT:
  SHELL=/bin/bash tmux new-session -d -s "grinscan" -c "$DIR" "node server.js"

export SHELL=/bin/bash at the top of a cron wrapper is NOT sufficient when the tmux server
was already started by a different process with /bin/sh.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
12. MAINNET PAGE SHOWS TESTNET THEME ON REFRESH — GRINSCAN_NETWORK UNDEFINED TOO LATE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Symptom: refreshing the mainnet page loads the matrix (testnet) theme instead of neon.

Root cause: the early theme-selection code ran before window.GRINSCAN_NETWORK was set.
Every code path that picks a default theme has a fallback:
  var net = (window.GRINSCAN_NETWORK || 'testnet');   ← fallback is 'testnet'
  function _defaultTheme() { return GRINSCAN_NETWORK === 'mainnet' ? 'neon' : 'matrix'; }

If GRINSCAN_NETWORK is undefined when either runs, the result is 'matrix' regardless of
which instance is actually serving the page.

This happened when the globals script injection was positioned too late in <head> (e.g.
before </head> instead of right after <head>), so the inline FOUC-prevention scripts
ran first with GRINSCAN_NETWORK still undefined.

A secondary variant: the localStorage key previously included the network suffix
('grinscan-theme-mainnet'). The suffix was computed at module-parse time using
GRINSCAN_NETWORK — if undefined at that moment, the key became 'grinscan-theme-undefined',
missing the saved preference and falling through to the 'testnet' default.

Fix — three parts applied together:

  1. Inject globals at the TOP of <head> (immediately after the <head> tag), not the bottom:
       out = out.replace('<head>', '<head>\n' + seoBlock + '\n' + globals);
     This guarantees window.GRINSCAN_NETWORK is set before any inline script in <head> runs.

  2. Server-side patch the initial <link id="theme-css"> href in the served HTML:
       dark.css  →  neon.css   (mainnet)
       dark.css  →  matrix.css (testnet)
     The correct theme CSS is in the DOM before any JS executes — no flash even if JS fails.

  3. Drop the network suffix from the localStorage key. Mainnet and testnet run on different
     origins (different domains), so localStorage is already partitioned by the browser.
     The suffix was redundant AND created a GRINSCAN_NETWORK dependency at parse time.
     Current key: 'grinscan-theme'  (no suffix)

Rule: any code that reads GRINSCAN_NETWORK to pick a default must be able to trust it is
already set. If it runs from <head> inline scripts or from a script file's top-level code,
it MUST be placed after the globals injection in <head>. Never rely on || 'testnet' as a
safe fallback — it silently applies the wrong theme in production.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
14. WRONG API ENDPOINT FOR BLOCK METHODS — BLOCKS SILENTLY BLANK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Block methods (get_block, get_header, get_outputs, get_pool_size) live on the FOREIGN API.
If called on the Owner API they return {"error": {"code": -32601, "message": "Method not found"}}.
The UI gets no data and shows a blank block list — no visible error to trace.

Two mistakes that compound:
  1. Calling block methods on /v2/owner instead of /v2/foreign.
  2. Not calling unwrapResult() — even on the right endpoint, accessing .result directly
     gives {"Ok": <data>} instead of the actual block, so nothing renders.

WRONG:
  ownerApi('get_block', [hash])          // wrong endpoint — method not found
  const block = response.result;         // skips unwrapping — gets {Ok: ...} not block

RIGHT:
  foreignApi('get_block', [hash])        // correct endpoint
  // ownerApi() and foreignApi() helpers call unwrapResult() automatically

Endpoint / method split to memorise:
  Owner API  (/v2/owner,   .api_secret):         get_status, get_connected_peers,
                                                  validate_chain, compact_chain
  Foreign API (/v2/foreign, .foreign_api_secret): get_block, get_header, get_outputs,
                                                  get_unspent_outputs, get_pool_size,
                                                  push_transaction

Always use foreignApi() for block data. Never call block methods through ownerApi().


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
15. API SECRET PERMISSION DENIED — www-data CANNOT READ grin:grin FILES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Script 01 creates node secrets with:
  chown grin:grin .api_secret .foreign_api_secret
  chmod 600       .api_secret .foreign_api_secret

GrinScan's Node.js process runs as www-data (set in the systemd unit).
www-data is NOT in the grin group, so reading from the node directory fails with
EACCES — node API calls silently fail and blocks/stats never load.

Fix applied in GrinScan Configure (step 2):
  1. Both secrets are COPIED to /opt/grin/grinscan/{test,main}/
  2. Re-chowned to www-data:www-data with chmod 600
  3. config.json points foreign_secret_path and owner_secret_path at the copies

The node directory secrets are never touched — GrinScan reads only its own copies.

  Source (read-only, owned by grin):
    /opt/grin/node/{net}-prune/.api_secret
    /opt/grin/node/{net}-prune/.foreign_api_secret

  Copies (owned by www-data, readable by Node.js):
    /opt/grin/grinscan/{test,main}/.api_secret
    /opt/grin/grinscan/{test,main}/.foreign_api_secret

IMPORTANT: if Script 01 rebuilds the node, it regenerates both secrets.
The copies in /opt/grin/grinscan/ then become stale — node API calls start
failing again with 401 Unauthorized. Fix: re-run GrinScan Configure (2) to
refresh the copies.
