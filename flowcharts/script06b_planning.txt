================================================================================
  SCRIPT 06B — GRINSCAN LIGHTWEIGHT BLOCK EXPLORER
  Planning Document
  Created: 2026-04-25
================================================================================

────────────────────────────────────────────────────────────────────────────────
1. OVERVIEW
────────────────────────────────────────────────────────────────────────────────

Name:         GrinScan
Tagline:      "Even a noob can scan the chain."
Purpose:      Lightweight, visually impressive Grin block explorer.
              Built with Node.js/Express — consistent with scripts 052–055.
              Works with a pruned node (recent blocks only).
              Supports both Testnet and Mainnet.

Goal:
  Provide a fast, beautiful, mobile-responsive Grin block explorer that users
  can deploy without a 30-minute Rust build or a full archive node.
  The "WOW" first impression is the top design priority — clean animations,
  live updates, and a theme system that delights both developers and newcomers.

Why not just use aglkm/grin-explorer?
  - Requires Rust + Cargo (10–30 min build on a modest VPS)
  - Requires a full archive node (mainnet-full, ~50+ GB)
  - No mobile layout, no theme switching, no live updates
  - GrinScan complements it — different audience, different goal

Relation to Script 06:
  Script 06 currently has:
    A)  Network Stats + Peer Map
    B)  Grin Explorer (aglkm/grin-explorer — Rust + Rocket)

  After this change:
    A)  Network Stats + Peer Map           (unchanged)
    B)  GrinScan                           (NEW — this script)
    C)  Grin Explorer by Grincoin.org      (old B — label rename only, no code change)

Scope (Phase 1):
  - Mainnet + Testnet (both, separate service instances)
  - Latest N blocks list with live refresh
  - Block detail page (header + kernels + output count)
  - Search by block height or hash
  - Stats bar (tip height, hashrate, difficulty, peer count)
  - Dark / Light / Neon / Matrix themes with system preference detection
  - Mobile responsive (375px → desktop)
  - Nginx + certbot SSL setup via toolkit menu
  - Systemd service (survive reboots)

Out of scope for Phase 1:
  - Full chain history (pruned node = recent blocks only, ~2 weeks)
  - Input/output spend-link tracing (requires chain_data file access)
  - Transaction graph or wallet address tracking
  - WebSocket (uses polling instead — simpler, no extra deps)
  - Mempool (Grin has no mempool — transactions are sent directly)


────────────────────────────────────────────────────────────────────────────────
2. ARCHITECTURE OVERVIEW
────────────────────────────────────────────────────────────────────────────────

  ┌───────────────────────────────────────────────────────────────────────────┐
  │  BROWSER (Visitor)                                                        │
  │                                                                           │
  │   index.html — Home page                                                  │
  │   ┌─────────────────────────────────────────────────────────┐            │
  │   │  Stats bar: Tip · Hashrate · Difficulty · Peers         │            │
  │   │  Search bar: [enter height or hash]                     │            │
  │   │  Block list: latest 20 blocks (auto-refresh every 30s)  │            │
  │   └─────────────────────────────────────────────────────────┘            │
  │                                                                           │
  │   block.html — Block detail page                                          │
  │   ┌─────────────────────────────────────────────────────────┐            │
  │   │  Header: height · hash · prev_hash · time · difficulty  │            │
  │   │  Kernels list: type badge · fee · excess                │            │
  │   │  Counts: outputs · inputs                               │            │
  │   │  Nav: [← Prev Block]  [Next Block →]                    │            │
  │   └─────────────────────────────────────────────────────────┘            │
  └───────────────────────────────────────────────────────────────────────────┘
                          │  REST  GET /api/*
                          ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │  GRINSCAN  (Node.js / Express)    127.0.0.1:3010 (test) / :3011 (main)   │
  │                                                                           │
  │   server.js                                                               │
  │   ├── Express REST API  (/api/tip, /api/blocks, /api/block/:ref, …)      │
  │   ├── SQLite block cache  (node:sqlite, DatabaseSync)                     │
  │   │     /opt/grin/grinscan/test/grinscan.db                              │
  │   │     /opt/grin/grinscan/main/grinscan.db                              │
  │   └── Background poller  (every 30s → get_tip + fetch new blocks)        │
  └───────────────────────────────────────────────────────────────────────────┘
                          │  Foreign API v2  (HTTP Basic Auth)
                          │  http://127.0.0.1:13413/v2/foreign  (testnet)
                          │  http://127.0.0.1:3413/v2/foreign   (mainnet)
                          ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │  GRIN NODE  (pruned or full)                                              │
  │   get_tip()               → chain tip height + last block hash            │
  │   get_block(height,…)     → full block data (header, kernels, outputs)    │
  │   get_connected_peers()   → live peer count (owner API)                   │
  └───────────────────────────────────────────────────────────────────────────┘
                          │  Nginx reverse proxy (HTTPS)
                          ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │  NGINX  (public HTTPS)                                                    │
  │   scan.yourdomain.com  →  proxy 127.0.0.1:3010 or :3011                  │
  │   SSL: Let's Encrypt via certbot                                          │
  └───────────────────────────────────────────────────────────────────────────┘


────────────────────────────────────────────────────────────────────────────────
3. FILE STRUCTURE
────────────────────────────────────────────────────────────────────────────────

  Grin-Node-Toolkit/
  ├── scripts/
  │   ├── 06_global_grin_health.sh          ← MODIFIED (add B=GrinScan, rename old B→C)
  │   └── lib/
  │       └── 06b_grinscan.sh               ← NEW bash lib (sourced by 06_*.sh)
  │
  └── web/
      └── 06b_grinscan/                     ← NEW
          ├── package.json
          ├── server.js
          └── public/
              ├── index.html                 ← home: stats + block list + search
              ├── block.html                 ← block detail page
              ├── info.html                  ← info page: About / Emission / Stats / Network
              ├── favicon.svg                ← ツ glyph icon, theme-coloured
              ├── robots.txt                 ← allow pages, disallow /api/ /rest/ /js/ /css/
              ├── css/
              │   ├── grinscan.css           ← base CSS variables + layout
              │   └── themes/
              │       ├── dark.css           ← dark theme
              │       ├── light.css
              │       ├── neon.css           ← default (mainnet)
              │       └── matrix.css         ← default (testnet)
              └── js/
                  ├── app.js                 ← fetch API, rendering, live updates
                  ├── info.js                ← info page: tabs, charts, emission curve
                  └── theme.js               ← theme switcher + localStorage
              NOTE: analytics.js is NOT a static file — it is served
                    dynamically by server.js from the ga4_measurement_id
                    config field. Do not create a file at public/js/analytics.js.


────────────────────────────────────────────────────────────────────────────────
4. RUNTIME DIRECTORIES  (on target VPS, not local)
────────────────────────────────────────────────────────────────────────────────

  /opt/grin/grinscan/
    test/
      config.json          ← GrinScan config for testnet instance
      grinscan.db          ← SQLite block cache (testnet)
      grinscan-test.log    ← service log
    main/
      config.json          ← GrinScan config for mainnet instance
      grinscan.db          ← SQLite block cache (mainnet)
      grinscan-main.log    ← service log

  Systemd units:
    /etc/systemd/system/grinscan-test.service
    /etc/systemd/system/grinscan-main.service

  Nginx:
    /etc/nginx/sites-available/grinscan-test
    /etc/nginx/sites-available/grinscan-main


────────────────────────────────────────────────────────────────────────────────
5. PORTS
────────────────────────────────────────────────────────────────────────────────

  Service       Testnet   Mainnet   Notes
  ────────────  ───────   ───────   ──────────────────────────────────────────
  Grin Drop     3004      3005      Script 052
  WooCommerce   3007      3006      Script 053
  GrinScan      3010      3011      Script 06B (this)

  All services bind to 127.0.0.1 only — nginx acts as public reverse proxy.


────────────────────────────────────────────────────────────────────────────────
6. CONFIG FILE  (/opt/grin/grinscan/{test|main}/config.json)
────────────────────────────────────────────────────────────────────────────────

  {
    "network":              "testnet",
    "node_url":             "http://127.0.0.1:13413/v2/foreign",
    "node_owner_url":       "http://127.0.0.1:13413/v2/owner",
    "foreign_secret_path":  "/opt/grin/node/testnet-prune/.foreign_api_secret",
    "owner_secret_path":    "/opt/grin/node/testnet-prune/.api_secret",
    "port":                 3010,
    "db_path":              "/opt/grin/grinscan/test/grinscan.db",
    "log_path":             "/opt/grin/grinscan/test/grinscan-test.log",
    "poll_interval_ms":     30000,
    "blocks_cache":         500,
    "web_dir":              "/opt/grin/toolkit/web/06b_grinscan/public",
    "ga4_measurement_id":   ""
  }

  Notes:
  - blocks_cache: how many recent blocks to keep in SQLite (rolling window)
  - poll_interval_ms: how often the background job fetches new blocks
  - web_dir: path to the static frontend files
  - ga4_measurement_id: Google Analytics 4 ID (e.g. "G-XXXXXXXXXX").
                        Empty string = analytics disabled. Always empty on
                        testnet instances — set only in mainnet config.json.


────────────────────────────────────────────────────────────────────────────────
7. SQLITE SCHEMA
────────────────────────────────────────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS blocks (
    height        INTEGER PRIMARY KEY,
    hash          TEXT    NOT NULL,
    prev_hash     TEXT    NOT NULL DEFAULT '',
    timestamp     INTEGER NOT NULL,           -- unix seconds
    difficulty    INTEGER NOT NULL DEFAULT 0,
    kernel_count  INTEGER NOT NULL DEFAULT 0, -- total kernels
    tx_count      INTEGER NOT NULL DEFAULT 0, -- non-coinbase kernels only
    fee_total     INTEGER NOT NULL DEFAULT 0, -- nanogrin sum
    raw_json      TEXT    NOT NULL DEFAULT '' -- full block JSON for detail view
  );

  CREATE INDEX IF NOT EXISTS idx_blocks_timestamp ON blocks(timestamp DESC);

  CREATE TABLE IF NOT EXISTS prices (
    timestamp   INTEGER PRIMARY KEY,  -- unix seconds (rounded to 10-min boundary)
    price_btc   REAL    NOT NULL DEFAULT 0,
    price_usd   REAL    NOT NULL DEFAULT 0,
    source      TEXT    NOT NULL DEFAULT ''  -- "gate.io", "nonlogs.io", "both", "stale"
  );

  CREATE INDEX IF NOT EXISTS idx_prices_timestamp ON prices(timestamp DESC);

  Notes:
  - raw_json stores the full get_block() response so /api/block/:ref
    can serve detail without a fresh node API call
  - tx_count = kernels where features != 'Coinbase'
  - fee_total = sum of kernel.fee for non-coinbase kernels
  - Rows older than blocks_cache are pruned after each poll
  - prices table retains 90 days of history; pruned each collection cycle
  - prices.timestamp is rounded to the nearest 10-minute boundary so rows
    are idempotent (INSERT OR REPLACE is safe on repeated runs)


────────────────────────────────────────────────────────────────────────────────
8. BACKEND API ENDPOINTS
────────────────────────────────────────────────────────────────────────────────

  Method  Path                      Returns
  ──────  ────────────────────────  ──────────────────────────────────────────
  GET     /health                  200 OK  {"status":"ok","network":"testnet"}
  GET     /api/network              {"network":"testnet"|"mainnet"}
  GET     /api/tip                  {"height":N,"hash":"0x…","network":"…"}
  GET     /api/stats                {"tip_height":N, "hashrate_gps":N,
                                     "difficulty":N, "peer_count":N,
                                     "network":"testnet", "cached_blocks":N}
  GET     /api/blocks?              [{"height":N,"hash":"…","timestamp":N,
            limit=20&offset=0        "tx_count":N,"fee_total":N,
                                     "kernel_count":N,"difficulty":N}]
  GET     /api/block/:ref           full block detail from raw_json
                                    :ref = height (integer) or hash (hex string)
  GET     /api/search?q=<val>       same as /api/block/:val (height or hash)
  GET     /                         serve public/index.html
  GET     /block.html               serve public/block.html
  GET     /info.html                serve public/info.html
  GET     /js/analytics.js         GA4 snippet (dynamic) — see section 28.
                                   Returns real gtag snippet on mainnet when
                                   ga4_measurement_id is set; returns an empty
                                   comment on testnet or when ID is blank.
  GET     /css/*  /js/*             static files (analytics.js served before
                                   this catch-all so the route takes priority)

  See section 26 for /api/history, /api/price, /api/peers  (Info page endpoints).
  See section 28 for GA4 analytics details.
  See section 29 for /rest/*.json public REST endpoints  (API tab).

  Hashrate formula (same as 06_collector.py):
    hashrate_gps = difficulty / 60
    (Grin targets 60-second block time — 1 block per minute)

  Error responses:
    404  {"error":"Block not found"}
    400  {"error":"Invalid search query"}
    503  {"error":"Node unreachable"}


────────────────────────────────────────────────────────────────────────────────
9. BACKGROUND POLLER  (server.js)
────────────────────────────────────────────────────────────────────────────────

  Runs every poll_interval_ms (default 30s):

  1.  Call get_tip() on Grin Foreign API
        → get current tip_height
  2.  SELECT MAX(height) FROM blocks
        → get highest cached block
  3.  If tip_height > max_cached:
        Loop from (max_cached + 1) to tip_height:
          Call get_block(height, null, null)
          Parse: timestamp, difficulty, kernels[], outputs[]
          Calculate: kernel_count, tx_count (non-coinbase), fee_total
          INSERT OR REPLACE INTO blocks (…)
  4.  Prune old rows:
        DELETE FROM blocks WHERE height < (tip_height - blocks_cache)
  5.  Update in-memory tip state (for /api/tip fast response)

  Peer count:
    Call get_connected_peers() on Owner API every poll cycle
    Store result in memory only (not in DB)
    Used for /api/stats peer_count field

  Error handling:
    - Node unreachable → log warning, skip cycle, retry next interval
    - Single block fetch failure → log error, skip that block, continue
    - Never crash the server on node downtime


────────────────────────────────────────────────────────────────────────────────
10. FRONTEND — HOME PAGE (index.html)
────────────────────────────────────────────────────────────────────────────────

  Layout (desktop → mobile collapses gracefully):

  ┌──────────────────────────────────────────────────────────────────────────┐
  │  🔍 GrinScan   [Explorer] [Info]   [testnet ●]   [🌙 Dark ▼]            │
  └──────────────────────────────────────────────────────────────────────────┘
  ┌──────────────────────────────────────────────────────────────────────────┐
  │                  ┌─────────────────────────────┐                        │
  │                  │  [ search by height or hash ]│                        │
  │                  └─────────────────────────────┘                        │
  └──────────────────────────────────────────────────────────────────────────┘
  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
  │  TIP HEIGHT  │ │   HASHRATE   │ │  DIFFICULTY  │ │    PEERS     │
  │  ● 2,345,678 │ │  42.3 GPS   │ │   1.23 M    │ │      24      │
  │  [▁▂▃▄▅ ]   │ │             │ │             │ │             │
  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘

  ┌──────────────────────────────────────────────────────────────────────────┐
  │  Latest Blocks                                    🟢 Live (30s refresh) │
  ├─────────┬────────────────┬──────────────┬───────┬───────────────────────┤
  │  Height │  Hash          │  Time        │  TXs  │  Fees                 │
  ├─────────┼────────────────┼──────────────┼───────┼───────────────────────┤
  │ 2345678 │  0xabcd…ef12  │  2m 14s ago  │   3   │  0.006 ツ             │
  │ 2345677 │  0x9871…cc44  │  3m 18s ago  │   1   │  0.001 ツ             │
  │ 2345676 │  0x1234…ab78  │  4m 22s ago  │   0   │  —                    │
  │  …                                                                       │
  └─────────┴────────────────┴──────────────┴───────┴───────────────────────┘
                                                       [ Load 20 more ]

  Mobile (≤ 480px):
  - Stats cards: 2-column grid → 1-column if very narrow
  - Block table: Height + Time + TXs only (hash hidden, visible on tap)
  - Search bar: full width
  - Theme picker: icon only (no label text)


────────────────────────────────────────────────────────────────────────────────
11. FRONTEND — BLOCK DETAIL PAGE (block.html)
────────────────────────────────────────────────────────────────────────────────

  ┌──────────────────────────────────────────────────────────────────────────┐
  │  🔍 GrinScan  /  Block #2,345,678                          [copy hash]  │
  └──────────────────────────────────────────────────────────────────────────┘
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  Block #2,345,678                                                        │
  │  ─────────────────────────────────────────────────────────────────────  │
  │  Hash          0xabcdef1234567890…abcdef  [📋 copy]                     │
  │  Prev Hash     0x987654321098765…fedcba  [📋 copy]                     │
  │  Timestamp     2024-01-15  14:23:01 UTC  (2m 14s ago)                   │
  │  Difficulty    1,234,567                                                 │
  │  Kernel Count  4  (3 transactions + 1 coinbase)                          │
  │  Output Count  7                                                         │
  └──────────────────────────────────────────────────────────────────────────┘
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  Kernels                                                                 │
  │  ─────────────────────────────────────────────────────────────────────  │
  │  [COINBASE]  fee: —        (miner reward)                                │
  │  [PLAIN   ]  fee: 0.006 ツ                                               │
  │  [PLAIN   ]  fee: 0.001 ツ                                               │
  │  [PLAIN   ]  fee: 0.002 ツ                                               │
  └──────────────────────────────────────────────────────────────────────────┘
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  [← Block #2345677]                       [Block #2345679 →]            │
  └──────────────────────────────────────────────────────────────────────────┘

  Kernel type badges (CSS pill labels):
    COINBASE       → yellow  (miner block reward)
    PLAIN          → blue    (standard transaction)
    HEIGHT_LOCKED  → purple  (time-locked transaction)

  Fee display:
    nanogrin → grin conversion: fee_nanogrin / 1_000_000_000
    Display as "0.006 ツ"  (ツ = Grin's unicode symbol)
    If fee is 0 or null: display "—"


────────────────────────────────────────────────────────────────────────────────
12. WOW FEATURES (UX — first-impression moments)
────────────────────────────────────────────────────────────────────────────────

  a) Animated Tip Counter
     - When a new block is detected (polled every 30s), the tip height number
       smoothly increments (CSS counter animation or JS digit roll)
     - The "●" pulse dot next to TIP turns bright green on update

  b) New Block Toast Notification
     - A slide-in card appears top-right: "🎉 New block #2345679"
     - Auto-dismisses after 5 seconds
     - No page reload — pure DOM update via fetch + setInterval

  c) Live Block Age Countdown
     - Every row in the block list shows "2m 14s ago"
     - A setInterval ticks every second and updates all age displays
     - Age colour shifts: green (<5m) → yellow (<30m) → grey (older)

  d) Hashrate Sparkline
     - Small inline SVG bar chart (10 bars) in the TIP HEIGHT stats card
     - Renders the last 10 blocks' implied hashrate (difficulty / 60)
     - Updates on each poll cycle without redrawing the whole page

  e) Skeleton Loaders
     - On first page load, grey shimmer placeholder bars are shown
     - Replace instantly with real data — no blank white flash

  f) Keyboard Shortcuts
     - "/" → focus search bar
     - "←" / "→" → navigate prev/next block (on block.html)
     - "Escape" → dismiss toast / blur search

  g) Copy Hash Button
     - On block.html: clipboard icon next to each hash
     - On click: icon turns green + "Copied!" tooltip for 2s

  h) System Theme Detection
     - On first visit: reads prefers-color-scheme media query
     - Sets dark or light automatically before any paint
     - User can override; choice saved in localStorage

  i) Network Indicator Badge
     - Header shows [TESTNET ●] in orange or [MAINNET ●] in green
     - Cannot be confused — always visible


────────────────────────────────────────────────────────────────────────────────
13. THEME SYSTEM
────────────────────────────────────────────────────────────────────────────────

  Pattern: mirrors 052_drop theme system exactly.
  - Base CSS variables in grinscan.css :root {}
  - Theme CSS files override only the variables they change
  - Theme stored in localStorage key: "grinscan-theme-{testnet|mainnet}"
  - Inline <script> before </head> applies theme before first paint (no flash)

  Theme         Vibe                        Default for
  ────────────  ──────────────────────────  ───────────
  dark          GitHub-dark, Grin orange    —
  light         Clean white, green accents  —
  neon          Cyberpunk: deep purple,     Mainnet
                electric cyan + magenta
  matrix        Black bg, green mono rain   Testnet

  Core CSS variables (grinscan.css — dark theme values):
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  :root {                                                                │
  │    --bg:           #0d1117;    /* page background */                   │
  │    --surface:      #161b22;    /* cards, panels */                     │
  │    --surface2:     #21262d;    /* table rows, nested surfaces */       │
  │    --border:       #30363d;                                            │
  │    --text:         #e6edf3;                                            │
  │    --muted:        #8b949e;    /* secondary text, timestamps */        │
  │    --accent:       #ff9900;    /* Grin orange — primary highlight */   │
  │    --accent2:      #f2c94c;    /* Grin yellow — secondary */           │
  │    --green:        #3fb950;    /* success, live indicator */           │
  │    --red:          #f85149;    /* error, offline */                    │
  │    --badge-coin:   #b8860b;    /* COINBASE kernel badge */             │
  │    --badge-plain:  #1f6feb;    /* PLAIN kernel badge */                │
  │    --badge-lock:   #8957e5;    /* HEIGHT_LOCKED kernel badge */        │
  │    --radius:       8px;                                                │
  │    --font-mono:    'JetBrains Mono', 'Courier New', monospace;        │
  │    --font-sans:    system-ui, -apple-system, sans-serif;               │
  │    --shadow:       0 4px 24px rgba(0,0,0,0.4);                        │
  │    --transition:   0.25s ease;                                         │
  │  }                                                                     │
  └─────────────────────────────────────────────────────────────────────────┘

  Neon theme (--accent: #00f0ff; --bg: #0a0014; --surface: #13002a):
    Deep purple background, electric cyan accents, magenta secondary.
    All stats cards get a subtle glow box-shadow matching --accent.
    Font switches to monospace for extra terminal feel.
    This is the mainnet default — it is the "WOW first impression" theme.


────────────────────────────────────────────────────────────────────────────────
14. BASH LIB — scripts/lib/06b_grinscan.sh
────────────────────────────────────────────────────────────────────────────────

  # 06b_grinscan.sh — GrinScan lightweight block explorer (Node.js)
  # Sourced by 06_global_grin_health.sh — inherits all color/log/network vars.
  #
  #  Functions exported:
  #    grinscan_install        — Node.js deps + systemd units + deploy web files
  #    grinscan_configure      — write config.json (node URL, network, port)
  #    grinscan_start          — systemctl start (testnet / mainnet / both)
  #    grinscan_stop           — systemctl stop
  #    grinscan_status         — status: service, port, nginx, db row count
  #    grinscan_setup_nginx    — nginx vhost + certbot SSL
  #    grinscan_autostart      — systemctl enable (survive reboots)

  Key variables (set at top of lib):
    GRINSCAN_DIR="/opt/grin/grinscan"
    GRINSCAN_WEB="$TOOLKIT_ROOT/web/06b_grinscan"
    NGINX_GRINSCAN_TEST_CONF="/etc/nginx/sites-available/grinscan-test"
    NGINX_GRINSCAN_MAIN_CONF="/etc/nginx/sites-available/grinscan-main"

  grinscan_install():
    1. Check Node.js >= 18 (install via NodeSource if missing)
    2. npm install --prefix "$GRINSCAN_WEB"  (express only)
    3. mkdir -p /opt/grin/grinscan/{test,main}
    4. Write systemd unit files for both networks
    5. systemctl daemon-reload
    6. chown -R www-data:www-data "$GRINSCAN_WEB/public"

  grinscan_configure():
    1. Prompt: which network? (1=testnet / 2=mainnet / 3=both)
    2. For each chosen network:
       - Auto-detect node URL using detect_node() from parent script
       - Read foreign_secret_path from grin-server.toml
       - Prompt to confirm or override node URL
       - Connectivity pre-check:
           Read foreign_secret from foreign_secret_path
           curl -s --max-time 5 -u ":$secret" -X POST "$node_url" \
             -d '{"jsonrpc":"2.0","method":"get_tip","params":[],"id":1}'
           If HTTP 200 + valid JSON: print "✓ Node reachable"
           If unreachable: print "⚠ Node not reachable — continue anyway? [Y/n]"
           Abort on N; proceed on Y (node may not be running yet)
       - Write /opt/grin/grinscan/{test|main}/config.json
    3. Prompt for GA4 Measurement ID (mainnet only — see section 28)
    4. Confirm written paths

  grinscan_start():
    1. Prompt: testnet / mainnet / both
    2. Check config.json exists for chosen network
    3. systemctl start grinscan-{test|main}
    4. Wait 2s, check port with ss -tlnp
    5. Show URL: http://127.0.0.1:3010 or :3011

  grinscan_status():
    Show for each network (test + main):
    - systemctl is-active grinscan-{test|main}
    - Port :3010 / :3011 listening?
    - config.json present?
    - DB row count (SELECT COUNT(*) FROM blocks)
    - Price history rows (SELECT COUNT(*) FROM prices)
    - Nginx configured? + domain name if found in nginx config
    - SSL active? (check certbot certificate expiry)
    - Last block cached height (SELECT MAX(height) FROM blocks)
    - Last price recorded (SELECT timestamp, price_usd FROM prices ORDER BY timestamp DESC LIMIT 1)

  grinscan_logs():
    1. Prompt: 1=testnet / 2=mainnet / 3=both
    2. tail -f the appropriate log file(s):
         /opt/grin/grinscan/test/grinscan-test.log
         /opt/grin/grinscan/main/grinscan-main.log
       For "both": tail -f file1 file2  (tail prefixes each line with filename)
    3. trap SIGINT — exit cleanly on Ctrl+C

  grinscan_update():
    1. Prompt: 1=testnet / 2=mainnet / 3=both
    2. npm install --prefix "$GRINSCAN_WEB"   (picks up any new deps)
    3. systemctl restart grinscan-{test|main}
    4. Wait 3s, check port with ss -tlnp
    5. Print new version from $GRINSCAN_WEB/package.json
    6. Call grinscan_status() to confirm running

  grinscan_setup_nginx():
    - Prompt: which network + domain + email
    - Write /etc/nginx/sites-available/grinscan-{test|main}:

        server {
            listen 80;
            server_name <domain>;

            # /rest/ public API — rate-limited, CORS handled by Express
            location /rest/ {
                include snippets/grin-api.conf;      # proxy headers
                limit_req zone=grin_api burst=20 nodelay;
                proxy_pass http://127.0.0.1:<port>;
            }

            # everything else — block list, block detail, info page, assets
            location / {
                include snippets/grin-api.conf;      # proxy headers
                proxy_pass http://127.0.0.1:<port>;
            }
        }

    - Reuse existing grin-rate-limit.conf and snippets/grin-api.conf
    - certbot --nginx -d <domain> --non-interactive --agree-tos …
    - Add logrotate entry

  Systemd unit template:
    [Unit]
    Description=GrinScan Block Explorer (testnet)
    After=network.target

    [Service]
    Type=simple
    User=www-data
    WorkingDirectory=<GRINSCAN_WEB>
    ExecStart=/usr/bin/node server.js
    Environment=GRINSCAN_CONFIG=/opt/grin/grinscan/test/config.json
    Restart=on-failure
    RestartSec=10
    StandardOutput=append:/opt/grin/grinscan/test/grinscan-test.log
    StandardError=append:/opt/grin/grinscan/test/grinscan-test.log

    [Install]
    WantedBy=multi-user.target


────────────────────────────────────────────────────────────────────────────────
15. CHANGES TO 06_global_grin_health.sh
────────────────────────────────────────────────────────────────────────────────

  a) Add source line near top (after variable declarations):
       source "$SCRIPT_DIR/lib/06b_grinscan.sh"

  b) Rename existing B functions:
       show_menu_b()   →  show_menu_c()   (relabel header to "C) Grin Explorer by Grincoin.org")
       run_menu_b()    →  run_menu_c()    (no body changes)

  c) Add new show_menu_b() for GrinScan:
       Mirrors show_menu_c() structure but calls grinscan_* functions.
       Options:
         1) Install
         2) Configure
         3) Start
         4) Check DNS
         5) Setup Nginx
         6) Auto-Start on Boot
         7) Status
         8) View Logs
         U) Update
         Z) Stop
         0) Back

  d) Add new run_menu_b() for GrinScan:
       case 1 → grinscan_install
       case 2 → grinscan_configure
       case 3 → grinscan_start
       case 4 → check_dns_record "grinscan"   (reuse existing function)
       case 5 → grinscan_setup_nginx
       case 6 → grinscan_autostart
       case 7 → grinscan_status
       case 8 → grinscan_logs
       case U → grinscan_update
       case Z → grinscan_stop

  e) Update show_main_menu():
       A)  Network Stats + Peer Map       (unchanged)
       B)  GrinScan                       (new)
           "Lightweight block explorer — testnet + mainnet, mobile friendly"
       C)  Grin Explorer by Grincoin.org  (was B)
           "Rust+Rocket — archive node required"
       Change prompt from [N/A/B/0] → [N/A/B/C/0]

  f) Update run_interactive():
       Add:  C) run_menu_c ;;


────────────────────────────────────────────────────────────────────────────────
16. NPM DEPENDENCIES
────────────────────────────────────────────────────────────────────────────────

  package.json:
    {
      "name": "grinscan",
      "version": "1.0.0",
      "engines": { "node": ">=18.0.0" },
      "dependencies": {
        "express": "^4.18.2"
      }
    }

  Built-in Node.js modules used (no install needed):
    node:sqlite   (DatabaseSync — requires Node >= 22.5 for stable API)
    crypto        (Basic Auth header construction)
    fs            (read config.json, read secret files)
    path          (file path helpers)
    http          (Foreign API calls — native fetch or http.request)

  Note: If Node < 22.5 is installed, use better-sqlite3 package instead.
  grinscan_install() should detect Node version and adjust accordingly.


────────────────────────────────────────────────────────────────────────────────
17. GRIN API CALLS USED
────────────────────────────────────────────────────────────────────────────────

  Foreign API v2  (Basic Auth: user="", password=<foreign_api_secret>)
  Base URL: http://127.0.0.1:{3413|13413}/v2/foreign

    get_tip()
      Request:  {"id":1,"jsonrpc":"2.0","method":"get_tip","params":[]}
      Returns:  {"height":N,"last_block_h":"hex","prev_block_h":"hex",
                  "total_difficulty":N}

    get_block(height, include_proof, include_merkle)
      Request:  {"method":"get_block","params":[height, null, null]}
      Returns:  {
                  "header": { "height":N, "hash":"hex", "previous":"hex",
                              "timestamp":"ISO8601", "total_difficulty":N },
                  "kernels": [{ "features":"Coinbase"|"Plain"|"HeightLocked",
                                "fee":N, "lock_height":N, "excess":"hex" }],
                  "outputs": [{ "features":"Coinbase"|"Plain", … }],
                  "inputs":  []
                }

  Owner API v2  (Basic Auth: user="", password=<api_secret>)
  Base URL: http://127.0.0.1:{3413|13413}/v2/owner

    get_connected_peers()
      Request:  {"method":"get_connected_peers","params":[]}
      Returns:  [{ "addr":"…", "user_agent":"…", "direction":"Inbound|Outbound" }]
      Usage:    peer_count = response.length


────────────────────────────────────────────────────────────────────────────────
18. SUGGESTED FUTURE EXTENSIONS (Phase 2+)
────────────────────────────────────────────────────────────────────────────────

  a) Full chain history
     - Connect to a mainnet-full (archive) node
     - Increase blocks_cache to unlimited (store all blocks)
     - Add "Jump to block" by date picker

  b) Kernel excess search
     - Index kernel excess hex in SQLite
     - Allow search by excess → find which block contained a kernel

  c) Unconfirmed transaction feed
     - Grin has no public mempool, but connected peers can be queried
     - Could show "pending kernel broadcasts" from connected peers

  d) Hashrate chart page
     - Dedicated chart page pulling from 06_collector.py's stats DB
     - Reuse existing hashrate.json from option A (Network Stats)
     - Avoids duplicating data collection

  e) Multi-language / i18n
     - Simple JSON string map loaded by theme.js
     - Start with EN + one other

  f) WebSocket live feed
     - Replace 30s polling with WebSocket push for instant new-block display
     - Requires ws npm package

  g) Public API mode
     - Expose /api/* publicly with nginx rate limiting
     - Other community tools can consume GrinScan as a data source
     - Reuse existing grin-api.conf snippet from option A nginx setup

  h) Explorer widget embed
     - Small iframe-embeddable "latest block" widget
     - Other Grin sites (forums, wallets) can embed it


────────────────────────────────────────────────────────────────────────────────
19. VERIFICATION CHECKLIST
────────────────────────────────────────────────────────────────────────────────

  Shell scripts:
    [ ] bash -n scripts/06_global_grin_health.sh
    [ ] bash -n scripts/lib/06b_grinscan.sh

  Menu flow:
    [ ] Main menu shows N / A / B / C / 0 correctly
    [ ] B → GrinScan submenu with 7 options + Z + 0
    [ ] C → old Grin Explorer submenu (unchanged behaviour)
    [ ] 0 navigates back at every level

  Server:
    [ ] GRINSCAN_CONFIG=<config> node server.js starts without error
    [ ] GET /health returns 200 {"status":"ok"}
    [ ] GET /api/tip returns {height, hash, network}
    [ ] GET /api/blocks?limit=5 returns array of 5 objects
    [ ] GET /api/block/1 returns block detail (from node or cache)
    [ ] GET /api/search?q=1 returns same as /api/block/1
    [ ] GET /api/stats returns hashrate_gps, difficulty, peer_count

  Frontend:
    [ ] index.html loads without console errors
    [ ] Stats cards populate within 2s of page load
    [ ] Block list shows at least 5 rows
    [ ] Clicking a row navigates to block.html?h=<height>
    [ ] block.html shows header details + kernels list
    [ ] Prev/Next block buttons navigate correctly
    [ ] Copy hash button writes to clipboard + shows "Copied!" feedback

  Themes:
    [ ] Neon theme is default on mainnet; matrix on testnet
    [ ] Dark theme applies correctly (GitHub-dark, orange accent)
    [ ] Light theme applies correctly (white bg, dark text)
    [ ] Theme persists across page reload (localStorage)
    [ ] No flash before theme applies (inline script check)
    [ ] System prefers-color-scheme does NOT override explicit network default

  WOW features:
    [ ] Block age updates every second without page reload
    [ ] New block toast appears when tip height increases
    [ ] Animated tip counter increments smoothly on new block
    [ ] Skeleton loaders visible during first fetch

  Mobile (375px viewport):
    [ ] Stats cards stack to 2-column or 1-column layout
    [ ] Block table is horizontally scrollable
    [ ] Search bar is full width
    [ ] No horizontal page overflow

  Nginx + SSL:
    [ ] grinscan_setup_nginx creates valid nginx config
    [ ] nginx -t passes
    [ ] certbot issues certificate successfully
    [ ] HTTPS redirects from HTTP

────────────────────────────────────────────────────────────────────────────────
20. INFO PAGE OVERVIEW  (info.html)
────────────────────────────────────────────────────────────────────────────────

  A companion page served at /info.html covering static and live information
  about the Grin network — scope mirrors:

    grincoin.org/           → About tab
    grincoin.org/stats      → Stats tab
    grincoin.org/emission   → Emission tab
    grincoin.org/network    → Network tab

  Delivered as a single HTML file with four tab sub-sections.
  Shares the same theme system, header, and Express server as index.html.
  No additional npm packages — SVG charts rendered inline by info.js.

  Header nav (added to all three pages — index.html, block.html, info.html):
    [Explorer]  →  /              (block list + stats)
    [Info]      →  /info.html     (this page)

  Default tab on load: About.
  Tab choice is NOT persisted to localStorage (always resets to About).

  Data mix per tab:
    About     — fully static, no API calls
    Emission  — one call to /api/tip; all math done client-side
    Stats     — /api/price  +  /api/history?days=14
    Network   — /api/peers  (live on each tab activation)
    API       — fully static; documents the public /rest/*.json endpoints


────────────────────────────────────────────────────────────────────────────────
21. INFO PAGE — ABOUT TAB
────────────────────────────────────────────────────────────────────────────────

  Content: static text only — no API calls needed.

  ┌──────────────────────────────────────────────────────────────────────────┐
  │  [About]  [Emission]  [Stats]  [Network]  [API]                          │
  ├──────────────────────────────────────────────────────────────────────────┤
  │                                                                          │
  │  What is Grin?                                                           │
  │  ─────────────────────────────────────────────────────────────────────  │
  │  Grin is a privacy-preserving cryptocurrency implementing the            │
  │  MimbleWimble protocol. It has no addresses, no visible amounts,         │
  │  and uses Confidential Transactions so only sender and receiver          │
  │  can see what was transferred.                                           │
  │                                                                          │
  │  Key Properties                                                          │
  │  ─────────────────────────────────────────────────────────────────────  │
  │  ┌────────────────────┬────────────────────────────────────────────┐    │
  │  │  Privacy           │  CT + CoinJoin; no amounts on-chain        │    │
  │  │  No Addresses      │  Transactions via interactive Slatepack    │    │
  │  │  Emission          │  1 GRIN/sec forever — no halving           │    │
  │  │  PoW Algorithm     │  Cuckatoo32+ (ASIC-friendly, GPU-capable)  │    │
  │  │  Block Time        │  60 seconds                                │    │
  │  │  Block Reward      │  60 GRIN (1 GRIN/sec × 60s)               │    │
  │  │  Launch            │  January 15, 2019 (no premine, no ICO)    │    │
  │  │  Founder Reward    │  None                                      │    │
  │  │  Max Supply        │  None (infinite linear emission)           │    │
  │  └────────────────────┴────────────────────────────────────────────┘    │
  │                                                                          │
  │  Resources                                                               │
  │  ─────────────────────────────────────────────────────────────────────  │
  │  [Grin Forum]  [GitHub]  [Docs]  [Grincoin.org]  [Wallet Tutorial]      │
  │                                                                          │
  └──────────────────────────────────────────────────────────────────────────┘

  Resource link targets (hardcoded in info.html):
    Grin Forum       https://forum.grin.mw
    GitHub (node)    https://github.com/mimblewimble/grin
    GitHub (wallet)  https://github.com/mimblewimble/grin-wallet
    Docs             https://docs.grin.mw
    Grincoin.org     https://grincoin.org
    Wallet Tutorial  https://github.com/grincc/grin-wallet-api-tutorial


────────────────────────────────────────────────────────────────────────────────
22. INFO PAGE — EMISSION TAB
────────────────────────────────────────────────────────────────────────────────

  Emission model:
    Block reward   60 GRIN per block  (1 GRIN/sec × 60s block time)
    No halving     reward is constant forever
    Supply formula supply(H) = H × 60   [GRIN]
    Inflation rate (60 / supply(H)) × 100  →  decreases as 1/H, never zero

  Data required:
    /api/tip  →  current height H
    Supply and inflation are derived entirely client-side from H.
    No extra endpoint needed for this tab.

  Supply milestones (precomputed constants in info.js):
    Year  Blocks (approx)   Supply        Ann. Inflation
    ────  ────────────────  ────────────  ──────────────
      1       525,960        31.56 M       100%
      2     1,051,920        63.11 M        50%
      5     2,629,800       157.79 M        20%
     10     5,259,600       315.58 M        10%
     20    10,519,200       631.15 M         5%
     50    26,298,000     1,577.88 M         2%
    100    52,596,000     3,155.76 M         1%

  Note: "Annual inflation" = 31.56 M new coins / total supply at start of year.

  Layout:
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  [About]  [Emission]  [Stats]  [Network]  [API]                          │
  ├──────────────────────────────────────────────────────────────────────────┤
  │                                                                          │
  │  Circulating Supply                                                      │
  │  ─────────────────────────────────────────────────────────────────────  │
  │  ┌─────────────────────┐  ┌─────────────────────┐                       │
  │  │  140,740,680 GRIN   │  │  ~7.4 years since   │                       │
  │  │  at block 2,345,678 │  │  genesis (est.)      │                       │
  │  └─────────────────────┘  └─────────────────────┘                       │
  │  ┌─────────────────────┐  ┌─────────────────────┐                       │
  │  │  60 GRIN / block    │  │  ~13.5% annual       │                       │
  │  │  (1 GRIN / sec)     │  │  inflation (yr 7)    │                       │
  │  └─────────────────────┘  └─────────────────────┘                       │
  │                                                                          │
  │  Supply Curve  (0 → 20 years)                                            │
  │  ─────────────────────────────────────────────────────────────────────  │
  │  700M ┤                                                        ·        │
  │  600M ┤                                                   ·             │
  │  500M ┤                                              ·                  │
  │  400M ┤                                         ·                       │
  │  300M ┤                               ·    ← year 10 (315M)            │
  │  200M ┤                   ●───────·   ← current                        │
  │  100M ┤            ·                                                    │
  │    0M ┤·                                                                │
  │       └────────────────────────────────────────────────────────────    │
  │        0   2   4   6   8  10  12  14  16  18  20  years                │
  │                                                                          │
  │  Annual Inflation Rate  (% of total supply at start of each year)        │
  │  ─────────────────────────────────────────────────────────────────────  │
  │  100% ┤·                                                                │
  │   50% ┤  ·                                                              │
  │   20% ┤       ·                                                         │
  │   14% ┤──────────● ← current                                           │
  │   10% ┤              ·                                                  │
  │    5% ┤                     ·                                           │
  │    2% ┤                               ·                                 │
  │    0% ┤                                             ·  ·  ·             │
  │       └────────────────────────────────────────────────────────────    │
  │        1   2   3   4   5   6   7   8  10  15  20  50 years             │
  │                                                                          │
  │  ℹ  Grin has no halving. Supply grows at a constant 31.56 M GRIN/year.  │
  │     Monetary inflation (%) decreases perpetually as supply grows.        │
  │     Compare: Bitcoin cuts its block reward in half every ~4 years,       │
  │     creating supply shocks. Grin's emission is smooth and predictable.  │
  │                                                                          │
  └──────────────────────────────────────────────────────────────────────────┘

  SVG chart implementation (info.js):
    Supply curve:
      <polyline> from precomputed year→supply points.
      Points array: [[0,0],[1,31.56],[2,63.11],[5,157.79],[10,315.58],[20,631.15]]
      Intermediate years interpolated linearly (straight line through origin).
      Current position: fetch /api/tip → supply = height × 60, plot as ● dot.

    Inflation curve:
      <polyline> from precomputed year→inflation% points.
      Points: [[1,100],[2,50],[3,33],[5,20],[7,14.3],[10,10],[20,5],[50,2]]
      Current position: dot at (elapsed_years, 60/supply×100).

    Both charts:
      Responsive SVG with viewBox, no fixed width/height on the element.
      Labelled X and Y axes using <text> elements.
      Current-position dot: r=5, fill=var(--accent), stroke=var(--bg).
      No canvas, no chart library — pure inline SVG.

  elapsed_years calculation (client-side):
    GENESIS_UNIX = 1547520000  (2019-01-15 00:00:00 UTC — Grin mainnet launch)
    elapsed_years = (Date.now()/1000 - GENESIS_UNIX) / (365.25 × 86400)
    Use this for the inflation-rate current-position dot on the chart.
    Use height × 60 for the supply current-position dot.


────────────────────────────────────────────────────────────────────────────────
23. INFO PAGE — STATS TAB
────────────────────────────────────────────────────────────────────────────────

  Data sources:
    Hashrate / Difficulty history  derived from blocks table (existing SQLite)
                                   SELECT height, difficulty, timestamp FROM blocks
                                   ORDER BY height DESC  →  sample hourly
    Price (BTC + USD)              /api/price  (server-side proxy to nonlogs.io)
    Market cap                     supply(tip_height) × price_usd  (client-side)
    Circulating supply             tip_height × 60  (client-side, from /api/tip)

  Layout:
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  [About]  [Emission]  [Stats]  [Network]  [API]                          │
  ├──────────────────────────────────────────────────────────────────────────┤
  │                                                                          │
  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐   │
  │  │  PRICE (BTC) │ │  PRICE (USD) │ │  MARKET CAP  │ │  SUPPLY      │   │
  │  │  0.0000042 ₿ │ │    $0.31     │ │   $44.1 M    │ │  140.7 M ツ  │   │
  │  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘   │
  │                                                                          │
  │  Hashrate — last 14 days  (GPS = Graph solutions / sec)                 │
  │  ─────────────────────────────────────────────────────────────────────  │
  │  50 ┤          ╭────╮    ╭──╮                                           │
  │  45 ┤────╮  ╭──╯    ╰────╯  ╰──────────────────                        │
  │  40 ┤    ╰──╯                                                           │
  │  35 ┤                                                                    │
  │     └──────────────────────────────────────────────────────────────    │
  │      Apr 21                                                    May 5    │
  │                                                                          │
  │  Difficulty — last 14 days                                               │
  │  ─────────────────────────────────────────────────────────────────────  │
  │  [similar SVG line chart, Y axis in millions]                            │
  │                                                                          │
  └──────────────────────────────────────────────────────────────────────────┘

  Chart implementation (info.js):
    Line charts: SVG <polyline> with data points normalised to chart viewport.
    X axis: date labels every 2 days, formatted as "Apr 21", "Apr 23", …
    Y axis: value labels auto-scaled to min/max of the data window.
    Hover tooltip: invisible <rect> overlay tracks mousemove, shows
                   a <line> crosshair + date/value in a small box.
    Responsive: viewBox scales with container; axis labels hidden at ≤ 480px.

  Hourly sampling logic (server-side, /api/history):
    For each hour boundary in the requested window:
      SELECT height, difficulty, timestamp FROM blocks
      WHERE timestamp BETWEEN (hour - 1800) AND (hour + 1800)
      ORDER BY ABS(timestamp - hour) LIMIT 1
    If no block near an hour: skip that slot (gaps are acceptable).
    hashrate_gps = difficulty / 60  (same formula as elsewhere in the toolkit).

  Price stale warning:
    If /api/price returns "stale":true, show a yellow ⚠ badge next to the
    price cards: "Price data may be outdated".


────────────────────────────────────────────────────────────────────────────────
24. INFO PAGE — NETWORK TAB
────────────────────────────────────────────────────────────────────────────────

  Data source:
    /api/peers  (new endpoint — see section 26)
    Calls Owner API get_connected_peers() on each tab activation — live data.

  Layout:
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  [About]  [Emission]  [Stats]  [Network]  [API]                          │
  ├──────────────────────────────────────────────────────────────────────────┤
  │                                                                          │
  │  ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐ │
  │  │  TOTAL PEERS       │  │  OUTBOUND          │  │  INBOUND           │ │
  │  │        24          │  │        16          │  │         8          │ │
  │  └────────────────────┘  └────────────────────┘  └────────────────────┘ │
  │                                                                          │
  │  Client Version Distribution                                             │
  │  ─────────────────────────────────────────────────────────────────────  │
  │  MW/Grin 5.3.x  ████████████████████  18  (75%)                        │
  │  MW/Grin 5.2.x  ████████               4  (17%)                        │
  │  MW/Grin 5.1.x  ██                     2   (8%)                        │
  │                                                                          │
  │  Connected Peers                                                         │
  │  ─────────────────────────────────────────────────────────────────────  │
  │  Address                   Direction    User Agent                       │
  │  ─────────────────────────────────────────────────────────────────────  │
  │  203.0.113.42:3414         [Outbound]   MW/Grin 5.3.0/linux             │
  │  198.51.100.7:3414         [Inbound]    MW/Grin 5.2.1/windows          │
  │  …                                                                       │
  │                                                                          │
  └──────────────────────────────────────────────────────────────────────────┘

  Version parsing:
    user_agent strings follow the pattern "MW/Grin X.Y.Z/os".
    Parse major.minor from the string for distribution chart buckets.
    Group by "X.Y" (e.g. "5.3") to keep bucket count manageable.
    Unknown / non-standard agents grouped as "Other".

  Direction badge colours:
    Outbound  →  var(--accent)   (orange in dark; cyan in neon)
    Inbound   →  var(--green)

  Version distribution bar chart:
    Horizontal bars — width proportional to count / total peers.
    Each bar is a plain <div> with inline width% set by info.js.
    Label shows "MW/Grin X.Y.x  [bar]  count  (pct%)".

  Empty / error state:
    If /api/peers returns [] or fails, show:
      "Owner API unreachable — peer data unavailable."
    Never show a broken table; never throw an uncaught error.

  Refresh:
    A [↻ Refresh] button re-fetches /api/peers without reloading the page.


────────────────────────────────────────────────────────────────────────────────
25. INFO PAGE — NAVIGATION CHANGES TO EXISTING PAGES
────────────────────────────────────────────────────────────────────────────────

  All three pages get a shared nav row in the header between logo and controls.

  Updated header layout (all pages):
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  🔍 GrinScan   [Explorer] [Info]   [MAINNET ●]   [🌙 Dark ▼]            │
  └──────────────────────────────────────────────────────────────────────────┘

  Active page tab gets a 2px var(--accent) underline; inactive is var(--muted).

  HTML snippet (shared across pages):
    <nav class="gs-nav">
      <a href="/"          class="nav-link" data-page="explorer">Explorer</a>
      <a href="/info.html" class="nav-link" data-page="info">Info</a>
    </nav>
  Active state set by matching window.location.pathname in an inline <script>
  before </head> (same pattern as theme application — avoids flash).

  Mobile (≤ 480px):
    Nav labels collapse to icon only when horizontal space is tight:
      Explorer  →  🔍
      Info      →  ℹ️
    Label text hidden via CSS; aria-label preserved for screen readers.

  CSS additions to grinscan.css:
    .gs-nav { display: flex; gap: 4px; }
    .nav-link {
      padding: 4px 12px; border-radius: var(--radius);
      font-size: 13px; font-family: var(--font-mono);
      color: var(--muted); transition: color var(--transition);
      border-bottom: 2px solid transparent;
    }
    .nav-link:hover { color: var(--text); }
    .nav-link.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }


────────────────────────────────────────────────────────────────────────────────
26. INFO PAGE — NEW API ENDPOINTS
────────────────────────────────────────────────────────────────────────────────

  These endpoints are additions to section 8.

  Method  Path                      Returns
  ──────  ────────────────────────  ──────────────────────────────────────────
  GET     /api/history?days=N       Hourly-sampled block data for charting.
                                    Default: days=14.  Max: days=30.
                                    [{"timestamp":N,"height":N,
                                      "difficulty":N,"hashrate_gps":N}]
                                    Derived from the existing blocks table —
                                    no new DB schema required.
                                    One entry per calendar hour; gaps allowed.

  GET     /api/price                Server-side proxy to nonlogs.io.
                                    Cached in memory for 5 minutes.
                                    {"price_btc":N,"price_usd":N,
                                     "volume_24h_usd":N,"fetched_at":N,
                                     "stale":false}
                                    On upstream failure: last cached value
                                    with "stale":true.
                                    503 only if never fetched and upstream down.

  GET     /api/peers                Live peer list from Owner API.
                                    Calls get_connected_peers() per request.
                                    [{"addr":"ip:port","user_agent":"…",
                                      "direction":"Inbound"|"Outbound"}]
                                    Returns [] if Owner API unreachable
                                    (never 503 — empty array is valid state).

  Price collection (background poller — separate from block poller, every 10 min):
    Sources (same pattern as 06_price_collector.py — both tried each cycle):

      gate.io (primary — gives USD directly):
        GET https://api.gateio.ws/api/v4/spot/tickers?currency_pair=GRIN_USDT
        → extract "last" field = price_usd
        GET https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT
        → extract "last" field = btc_usd_rate
        Derive price_btc = price_usd / btc_usd_rate

      nonlogs.io (secondary — gives BTC price):
        GET https://api.nonlogs.io/api/markets/GRIN-BTC
        → extract "last" field = price_btc
        Derive price_usd = price_btc × btc_usd_rate  (from gate.io, or skip)

    Resolution when both available:
      price_usd  = gate.io value  (preferred — direct USD pair)
      price_btc  = nonlogs.io value  (preferred — direct BTC pair)
      source     = "both"

    Fallback:
      gate.io only  → source = "gate.io"; price_btc derived
      nonlogs.io only → source = "nonlogs.io"; price_usd derived (approx)
      Neither       → mark last DB row as stale; source = "stale"

    Storage: INSERT OR REPLACE INTO prices (timestamp, price_btc, price_usd, source)
      timestamp = floor(now / 600) × 600  (round to 10-min boundary)
    Retention: DELETE FROM prices WHERE timestamp < (now - 90×86400)  (90 days)

    change_24h_pct calculation:
      SELECT price_usd FROM prices
      WHERE timestamp <= (now - 86400) ORDER BY timestamp DESC LIMIT 1
      change_24h_pct = (current_usd - usd_24h_ago) / usd_24h_ago × 100

  /api/price response (updated):
    {
      "price_btc":      0.0000042,
      "price_usd":      0.31,
      "change_24h_pct": -2.3,
      "fetched_at":     1746403200,
      "sources":        ["gate.io", "nonlogs.io"],
      "stale":          false,
      "network":        "mainnet"
    }


────────────────────────────────────────────────────────────────────────────────
27. INFO PAGE — VERIFICATION CHECKLIST
────────────────────────────────────────────────────────────────────────────────

  Navigation (all pages):
    [ ] Header shows [Explorer] [Info] nav on index.html, block.html, info.html
    [ ] Active page tab has --accent underline; inactive is --muted
    [ ] Nav collapses to icon-only on ≤ 480px without overflow
    [ ] Clicking Explorer from info.html loads block list correctly

  About tab:
    [ ] Static content renders in all 4 themes without layout breakage
    [ ] Key properties table is readable on 375px mobile
    [ ] All resource links open correct external URLs
    [ ] No API calls made when About tab is active

  Emission tab:
    [ ] /api/tip called on tab activation; supply card updates correctly
    [ ] Supply card value = height × 60 GRIN
    [ ] Annual inflation card value = (60 / supply) × 100, rounded to 1 dp
    [ ] "Years since genesis" card uses GENESIS_UNIX = 1547520000
    [ ] Supply curve SVG renders as a straight line through origin
    [ ] Current-position dot plotted at correct (year, supply) coordinate
    [ ] Inflation curve SVG renders as a decreasing curve
    [ ] Current-position dot plotted at correct (year, inflation%) coordinate
    [ ] Both charts are responsive; axis labels do not overflow at 375px
    [ ] Comparison note text is visible below the charts

  Stats tab:
    [ ] GET /api/history?days=14 returns ≥ 1 data point (not empty)
    [ ] GET /api/price returns price_btc and price_usd fields
    [ ] Price cards populate within 3s of tab activation
    [ ] Market cap formula: supply × price_usd (correct)
    [ ] Hashrate chart renders with data and labelled axes
    [ ] Difficulty chart renders with data and labelled axes
    [ ] Hover tooltip shows date + value when mousing over charts
    [ ] Stale price warning badge appears when "stale":true in /api/price
    [ ] Charts degrade gracefully if /api/history returns fewer points

  Network tab:
    [ ] GET /api/peers returns live array from Owner API
    [ ] Peer count cards (total / outbound / inbound) are arithmetically correct
    [ ] Version distribution bar chart widths are proportional to counts
    [ ] Peer table shows addr, direction badge, user_agent
    [ ] Outbound badge uses --accent colour; Inbound badge uses --green
    [ ] "Other" bucket catches non-standard user_agent strings
    [ ] Empty state message shown gracefully if /api/peers returns []
    [ ] [↻ Refresh] button re-fetches without reloading the page

  API tab:
    [ ] All six /rest/*.json endpoints return valid JSON with correct fields
    [ ] /rest/emission.json is purely static (no node API call)
    [ ] Each endpoint returns correct Content-Type: application/json
    [ ] Each endpoint includes Cache-Control header appropriate to data freshness
    [ ] CORS header Access-Control-Allow-Origin: * present on all /rest/ routes
    [ ] "network" field present in every response
    [ ] API tab documents all six endpoints with descriptions and example responses
    [ ] "Try it" button fetches the live endpoint and renders the JSON in the page
    [ ] Copy URL button copies the full endpoint URL to clipboard
    [ ] Tab is fully static — no API calls on load, only on user "Try it" action

────────────────────────────────────────────────────────────────────────────────
28. GA4 ANALYTICS
────────────────────────────────────────────────────────────────────────────────

  Goal:
    Allow the node operator to see page-view traffic on their public GrinScan
    instance without duplicating any tracking code across HTML files.
    Testnet instances must never send data to GA4 — they are dev/test only.

  Approach — single dynamic route, no static file:
    server.js registers GET /js/analytics.js BEFORE the express.static()
    middleware so this route takes priority over the public/ folder.

    Logic in server.js:
      const GA4_ID = config.ga4_measurement_id || '';

      app.get('/js/analytics.js', (req, res) => {
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        if (!GA4_ID || config.network !== 'mainnet') {
          return res.send('/* GrinScan analytics disabled */');
        }
        res.send(`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${GA4_ID}');
        `);
      });

    The GA4 loader script (gtag.js from Google's CDN) is included in HTML
    only when the ID is set — see HTML snippet below.

  HTML snippet (identical on index.html, block.html, info.html):
    Place immediately before </head>:

      <!-- Analytics — served as a no-op on testnet or when ID is unset -->
      <script async src="https://www.googletagmanager.com/gtag/js?id=__GA4_ID__"></script>
      <script src="/js/analytics.js"></script>

    Problem: __GA4_ID__ above must be real even for the loader URL.
    Solution: server.js also exposes GET /js/analytics-loader.html snippet,
    OR — simpler — inject a tiny inline script block that conditionally adds
    the gtag.js <script> element:

      <script src="/js/analytics.js"></script>

    analytics.js (when enabled) appends the gtag.js loader dynamically:

      (function() {
        var id = '__GA4_MEASUREMENT_ID__';   // replaced by server.js
        if (!id) return;
        var s = document.createElement('script');
        s.async = true;
        s.src = 'https://www.googletagmanager.com/gtag/js?id=' + id;
        document.head.appendChild(s);
        window.dataLayer = window.dataLayer || [];
        function gtag(){dataLayer.push(arguments);}
        window.gtag = gtag;
        gtag('js', new Date());
        gtag('config', id);
      })();

    This keeps every HTML page to a single identical line:
      <script src="/js/analytics.js"></script>
    No measurement ID appears in any HTML file. No duplication.

  server.js full route (revised):
    app.get('/js/analytics.js', (req, res) => {
      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      const id = (config.network === 'mainnet') ? (config.ga4_measurement_id || '') : '';
      if (!id) return res.send('/* GrinScan analytics disabled */');
      res.send(`(function(){
        var id='${id}';
        var s=document.createElement('script');
        s.async=true;
        s.src='https://www.googletagmanager.com/gtag/js?id='+id;
        document.head.appendChild(s);
        window.dataLayer=window.dataLayer||[];
        function gtag(){dataLayer.push(arguments);}
        window.gtag=gtag;
        gtag('js',new Date());
        gtag('config',id);
      })();`);
    });

  config.json (mainnet example):
    "ga4_measurement_id": "G-XXXXXXXXXX"   ← operator fills in their real ID

  config.json (testnet — always leave blank):
    "ga4_measurement_id": ""

  grinscan_configure() bash function:
    After writing config.json, prompt:
      "Enter GA4 Measurement ID for mainnet (leave blank to disable analytics): "
    Only prompt when configuring mainnet. Testnet config always writes "".
    Validate format: must start with "G-" or be empty.

  Privacy notes:
    - GA4 uses cookies. If the operator is in the EU or serves EU users,
      they are responsible for their own cookie consent banner.
    - GrinScan does not implement a consent banner — out of scope for Phase 1.
    - The measurement ID is operator-supplied and never hardcoded in the toolkit.

  Verification:
    [ ] GET /js/analytics.js on testnet returns "/* GrinScan analytics disabled */"
    [ ] GET /js/analytics.js on mainnet with empty ID also returns disabled comment
    [ ] GET /js/analytics.js on mainnet with valid ID returns gtag IIFE
    [ ] Route registered before express.static() so it takes priority
    [ ] All three HTML pages include exactly one <script src="/js/analytics.js">
    [ ] No measurement ID appears in any HTML file
    [ ] grinscan_configure() prompts for GA4 ID only on mainnet
    [ ] ID validation rejects strings not starting with "G-"
    [ ] Cache-Control: max-age=3600 header present on all analytics.js responses

────────────────────────────────────────────────────────────────────────────────
29. PUBLIC REST API  (/rest/*.json)  +  INFO PAGE — API TAB
────────────────────────────────────────────────────────────────────────────────

  Purpose:
    Expose a small set of machine-readable JSON endpoints under /rest/ so that
    other sites (wallets, dashboards, exchanges, community tools) can pull live
    Grin chain data from a GrinScan instance — mirroring what api.grin.money
    already provides at its /rest/ paths.

    The API tab on info.html documents these endpoints with descriptions,
    example responses, and a live "Try it" button for each.

  CORS:
    All /rest/* routes must include:
      Access-Control-Allow-Origin: *
    This is required for browser-based consumers on other domains.
    Add as a targeted middleware in server.js:
      app.use('/rest', (req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        next();
      });

  ────────────────────────────────────────────────────────────────────────────
  ENDPOINT SPECIFICATIONS
  ────────────────────────────────────────────────────────────────────────────

  GET /rest/stats.json
    Description:  Core chain stats in one call — the most commonly consumed
                  endpoint. Covers what most external tools need.
    Cache-Control: public, max-age=30
    Data sources: in-memory tip state + /api/stats + peer version map
    Response:
      {
        "height":       2345678,
        "hash":         "0abcdef1234567890…",
        "supply":       140740680,          // height × 60  (GRIN, integer)
        "difficulty":   2535180,
        "hashrate_gps": 42.3,               // difficulty / 60
        "peer_count":   24,
        "versions": {                       // user_agent major.minor distribution
          "5.3": 18,
          "5.2": 4,
          "5.1": 2
        },
        "network":      "mainnet"
      }
    Note: "versions" derived from the last /api/peers call cached in memory.
          If peers not yet fetched, omit the field rather than error.

  GET /rest/supply.json
    Description:  Circulating supply only — for CMC, CoinGecko, or any tool
                  that polls a single-field supply endpoint.
    Cache-Control: public, max-age=30
    Data sources: in-memory tip height
    Response:
      {
        "supply":   140740680,    // height × 60  (GRIN, integer)
        "height":   2345678,
        "network":  "mainnet"
      }

  GET /rest/height.json
    Description:  Block height only — minimal payload for lightweight pollers.
    Cache-Control: public, max-age=30
    Data sources: in-memory tip height
    Response:
      {
        "height":   2345678,
        "network":  "mainnet"
      }

  GET /rest/difficulty.json
    Description:  Current network difficulty and derived hashrate.
    Cache-Control: public, max-age=30
    Data sources: in-memory tip state (difficulty stored alongside height)
    Response:
      {
        "difficulty":   2535180,
        "hashrate_gps": 42.3,     // difficulty / 60
        "network":      "mainnet"
      }

  GET /rest/emission.json
    Description:  Static Grin emission schedule — precomputed milestones.
                  Never changes; no node API call needed at request time.
    Cache-Control: public, max-age=86400  (24 hours — data is static)
    Data sources: hardcoded constants in server.js
    Response:
      {
        "block_reward":      60,
        "block_time_sec":    60,
        "genesis_timestamp": 1547520000,
        "genesis_date":      "2019-01-15",
        "supply_formula":    "height * 60",
        "schedule": [
          {"year": 1,  "blocks": 525960,   "supply": 31557600,   "inflation_pct": 100.0},
          {"year": 2,  "blocks": 1051920,  "supply": 63115200,   "inflation_pct": 50.0},
          {"year": 3,  "blocks": 1577880,  "supply": 94672800,   "inflation_pct": 33.3},
          {"year": 5,  "blocks": 2629800,  "supply": 157788000,  "inflation_pct": 20.0},
          {"year": 10, "blocks": 5259600,  "supply": 315576000,  "inflation_pct": 10.0},
          {"year": 20, "blocks": 10519200, "supply": 631152000,  "inflation_pct": 5.0},
          {"year": 50, "blocks": 26298000, "supply": 1577880000, "inflation_pct": 2.0}
        ],
        "network": "mainnet"
      }
    Note: inflation_pct = annual new supply (31,557,600) / supply at start of
          that year × 100. Rounded to one decimal place.

  GET /rest/node.json
    Description:  Connected peer list with version breakdown — equivalent to
                  what the Network tab shows, in machine-readable form.
    Cache-Control: public, max-age=30
    Data sources: Owner API get_connected_peers() — called per request.
                  Returns [] with no error if Owner API is unreachable.
    Response:
      {
        "peer_count":  24,
        "outbound":    16,
        "inbound":     8,
        "versions": {
          "5.3": 18,
          "5.2": 4,
          "5.1": 2
        },
        "peers": [
          {
            "addr":       "203.0.113.42:3414",
            "user_agent": "MW/Grin 5.3.0/linux",
            "direction":  "Outbound"
          }
        ],
        "network": "mainnet"
      }

  GET /rest/price.json
    Description:  Current GRIN price with 24h change and historical data.
                  Sourced from gate.io (GRIN_USDT) + nonlogs.io (GRIN-BTC).
                  History drawn from the prices SQLite table (up to 90 days).
    Cache-Control: public, max-age=120  (2 minutes — price changes slowly)
    Query params: ?days=N  (default 1, max 90 — controls history depth)
    Data sources: prices table in SQLite + in-memory latest price state
    Response:
      {
        "price_btc":      0.0000042,
        "price_usd":      0.31,
        "change_24h_pct": -2.3,
        "fetched_at":     1746403200,
        "stale":          false,
        "sources":        ["gate.io", "nonlogs.io"],
        "history": [
          {"timestamp": 1746399600, "price_btc": 0.0000041, "price_usd": 0.305},
          {"timestamp": 1746396000, "price_btc": 0.0000043, "price_usd": 0.318}
        ],
        "network": "mainnet"
      }
    history: ordered oldest → newest; one entry per 10-min collection tick.
             ?days=1  → up to 144 points;  ?days=7  → up to 1,008 points.
    Returns 503 only if price has never been collected AND collection failed.

  ────────────────────────────────────────────────────────────────────────────
  SERVER.JS IMPLEMENTATION NOTES
  ────────────────────────────────────────────────────────────────────────────

  Route registration order in server.js:
    1. app.use('/rest', corsMiddleware)       ← CORS for all /rest routes
    2. app.get('/rest/stats.json', …)
    3. app.get('/rest/supply.json', …)
    4. app.get('/rest/height.json', …)
    5. app.get('/rest/difficulty.json', …)
    6. app.get('/rest/emission.json', …)
    7. app.get('/rest/node.json', …)
    8. app.get('/rest/price.json', …)
    9. app.get('/js/analytics.js', …)        ← GA4 dynamic route
   10. app.use(express.static(config.web_dir))  ← catch-all static

  Shared in-memory state (already maintained by background poller):
    tipState = { height, hash, difficulty, hashrate_gps, peer_count }
  The /rest/ endpoints read from tipState — no extra DB queries needed
  for height, supply, difficulty, hashrate, and peer_count fields.

  Peer version map:
    Maintained in memory alongside tipState.
    Updated each poll cycle when get_connected_peers() is called.
    Parsed from user_agent: match /(\d+\.\d+)\.\d+/ → "major.minor" bucket.

  ────────────────────────────────────────────────────────────────────────────
  INFO PAGE — API TAB LAYOUT
  ────────────────────────────────────────────────────────────────────────────

  ┌──────────────────────────────────────────────────────────────────────────┐
  │  [About]  [Emission]  [Stats]  [Network]  [API]                          │
  ├──────────────────────────────────────────────────────────────────────────┤
  │                                                                          │
  │  Public REST API                                                         │
  │  ─────────────────────────────────────────────────────────────────────  │
  │  These endpoints are publicly accessible with no authentication.         │
  │  All responses include Access-Control-Allow-Origin: * for browser use.  │
  │  Base URL:  https://scan.yourdomain.com/rest/                            │
  │                                                                          │
  │  ┌──────────────────────────────────────────────────────────────────┐   │
  │  │  GET /rest/stats.json                              [📋] [Try it] │   │
  │  │  Core chain stats: height, supply, difficulty, hashrate, peers   │   │
  │  │  Cache: 30s                                                       │   │
  │  │  ──────────────────────────────────────────────────────────────  │   │
  │  │  { "height": 2345678, "supply": 140740680, … }    [JSON output] │   │
  │  └──────────────────────────────────────────────────────────────────┘   │
  │                                                                          │
  │  ┌──────────────────────────────────────────────────────────────────┐   │
  │  │  GET /rest/supply.json                             [📋] [Try it] │   │
  │  │  Circulating supply (height × 60 GRIN)                           │   │
  │  │  Cache: 30s                                                       │   │
  │  └──────────────────────────────────────────────────────────────────┘   │
  │                                                                          │
  │  ┌──────────────────────────────────────────────────────────────────┐   │
  │  │  GET /rest/height.json                             [📋] [Try it] │   │
  │  │  Block height only                                                │   │
  │  │  Cache: 30s                                                       │   │
  │  └──────────────────────────────────────────────────────────────────┘   │
  │                                                                          │
  │  ┌──────────────────────────────────────────────────────────────────┐   │
  │  │  GET /rest/difficulty.json                         [📋] [Try it] │   │
  │  │  Network difficulty + hashrate (GPS)                              │   │
  │  │  Cache: 30s                                                       │   │
  │  └──────────────────────────────────────────────────────────────────┘   │
  │                                                                          │
  │  ┌──────────────────────────────────────────────────────────────────┐   │
  │  │  GET /rest/emission.json                           [📋] [Try it] │   │
  │  │  Static emission schedule — yearly milestones, no halving        │   │
  │  │  Cache: 24h                                                       │   │
  │  └──────────────────────────────────────────────────────────────────┘   │
  │                                                                          │
  │  ┌──────────────────────────────────────────────────────────────────┐   │
  │  │  GET /rest/node.json                               [📋] [Try it] │   │
  │  │  Connected peers, version distribution                            │   │
  │  │  Cache: 30s                                                       │   │
  │  └──────────────────────────────────────────────────────────────────┘   │
  │                                                                          │
  │  ┌──────────────────────────────────────────────────────────────────┐   │
  │  │  GET /rest/price.json                              [📋] [Try it] │   │
  │  │  Current price (gate.io + nonlogs.io) + 24h change + history     │   │
  │  │  Cache: 2 min  ·  ?days=N for history depth (max 90)             │   │
  │  └──────────────────────────────────────────────────────────────────┘   │
  │                                                                          │
  └──────────────────────────────────────────────────────────────────────────┘

  "Try it" button behaviour (info.js):
    On click: fetch the endpoint URL, pretty-print the JSON into a <pre>
    block below the endpoint card. Second click collapses it.
    Show a spinner while fetching; show an error message if fetch fails.
    No page reload — pure DOM update.

  [📋] copy button:
    Copies the full endpoint URL (e.g. https://scan.yourdomain.com/rest/stats.json)
    to clipboard. Same copy-button pattern as block.html hash copy.
    Base URL injected by server.js as window.GRINSCAN_BASE_URL in a small
    inline <script> block before </head> in info.html:
      <script>window.GRINSCAN_BASE_URL = 'https://scan.yourdomain.com';</script>
    info.js builds full URLs from this constant at runtime.

  Nginx rate limiting:
    /rest/* routes should reuse the existing grin-rate-limit.conf snippet
    applied in grinscan_setup_nginx() — same as the node API nginx config.
    This protects against scraping abuse from external consumers.

────────────────────────────────────────────────────────────────────────────────
30. OPERATIONAL GAPS — BASH LIB + SERVER ADDITIONS
────────────────────────────────────────────────────────────────────────────────

  ──────────────────────────────────────────────────────────────────────────
  A) STARTUP BACKFILL  (server.js — cold start behaviour)
  ──────────────────────────────────────────────────────────────────────────

  On first run the blocks table is empty. The poller must backfill before
  the block list is useful, but the HTTP server should start immediately
  (so /health and /api/stats respond during backfill).

  Algorithm (runs once at startup, before the regular poll loop begins):
    1. tip_height  = get_tip()
    2. max_cached  = SELECT MAX(height) FROM blocks  (NULL if empty)
    3. If max_cached IS NULL:
         backfill_from = tip_height - blocks_cache   (e.g. tip - 500)
         If backfill_from < 1: backfill_from = 1
    4. Else if tip_height > max_cached + 1:
         backfill_from = max_cached + 1    (resume interrupted backfill)
    5. Else: no backfill needed — start regular poll loop immediately
    6. Set in-memory flag: tipState.syncing = true
    7. For height = backfill_from to tip_height:
         Fetch + insert block (same logic as regular poller)
         Add 100ms delay between requests (avoid hammering node)
         Log every 50 blocks: "Backfilling block N / tip_height"
    8. tipState.syncing = false
    9. Start regular setInterval poll loop

  /health response during backfill:
    {"status":"ok","syncing":true,"network":"mainnet"}
  /health response after backfill:
    {"status":"ok","syncing":false,"network":"mainnet"}

  Price poller startup:
    Price collection starts independently after backfill completes.
    First collection runs immediately (no 10-min wait on cold start).

  ──────────────────────────────────────────────────────────────────────────
  B) /api/stats — new fields added
  ──────────────────────────────────────────────────────────────────────────

  Two new fields to support footer and sync banner (see section 31):

    "node_version":  "5.3.0"   — parsed from own user_agent in get_tip()
                                  response headers, or "unknown" if absent
    "stalled":       false      — true when tip_height has not changed for
                                  ≥ 5 consecutive poll cycles (2.5 min)

  stall tracking in background poller:
    let stallCount = 0, lastTipHeight = 0;
    On each cycle:
      if (tipHeight === lastTipHeight) stallCount++;
      else { stallCount = 0; lastTipHeight = tipHeight; }
    tipState.stalled = stallCount >= 5;

  ──────────────────────────────────────────────────────────────────────────
  C) robots.txt  (public/robots.txt — committed static file)
  ──────────────────────────────────────────────────────────────────────────

    User-agent: *
    Allow: /
    Allow: /block.html
    Allow: /info.html
    Disallow: /api/
    Disallow: /rest/
    Disallow: /js/
    Disallow: /css/

  Served automatically by express.static() — no special route needed.
  Rationale: allow crawlers to index the human-readable explorer pages;
  block API and asset paths to avoid unnecessary crawl budget waste.

  ──────────────────────────────────────────────────────────────────────────
  D) Section 29 verification additions — price endpoint
  ──────────────────────────────────────────────────────────────────────────

    [ ] GET /rest/price.json returns price_btc, price_usd, change_24h_pct
    [ ] "history" array is ordered oldest → newest
    [ ] ?days=1 returns ≤ 144 points; ?days=7 returns ≤ 1,008 points
    [ ] "stale":true returned when both sources unreachable
    [ ] "sources" field lists which APIs contributed to the reading
    [ ] Price collected from gate.io GRIN_USDT and nonlogs.io GRIN-BTC
    [ ] prices table pruned to 90 days after each collection cycle
    [ ] /api/price also returns change_24h_pct and sources fields


────────────────────────────────────────────────────────────────────────────────
31. UX GAPS — FRONTEND ADDITIONS
────────────────────────────────────────────────────────────────────────────────

  ──────────────────────────────────────────────────────────────────────────
  A) FAVICON + DYNAMIC PAGE TITLES
  ──────────────────────────────────────────────────────────────────────────

  Favicon:
    File: public/favicon.svg  (committed to repo — served as static file)
    Design: ツ glyph centred on a rounded square; fill = --accent colour
            (Grin orange for dark/light, cyan for neon, green for matrix).
            Single SVG with a neutral fallback colour that looks fine before
            the theme loads — use #ff9900 (Grin orange) as the base value.
    In all HTML <head>:
      <link rel="icon" href="/favicon.svg" type="image/svg+xml">

  Page titles — server.js injects into HTML at startup via a template
  substitution on the static files (or via a small inline script block):
    window.GRINSCAN_NETWORK  = 'mainnet' | 'testnet';
    window.GRINSCAN_VERSION  = '1.0.0';               (from package.json)
    window.GRINSCAN_BASE_URL = 'https://scan.example.com';

  index.html:   "GrinScan — Mainnet Block Explorer"  /  "GrinScan — Testnet"
  block.html:   Set dynamically by app.js: "Block #2,345,678 — GrinScan"
                Before data loads: "GrinScan" (fallback)
  info.html:    Updated by info.js on each tab switch:
                "About — GrinScan" / "Emission — GrinScan" / etc.

  OpenGraph + meta description (static defaults in all <head>):
    <meta name="description"      content="Lightweight Grin block explorer">
    <meta property="og:site_name" content="GrinScan">
    <meta property="og:title"     content="GrinScan — Grin Block Explorer">
    <meta property="og:description" content="Lightweight Grin block explorer">
    Note: og:title on block.html will be the static default — dynamic OG
    requires SSR and is out of scope for Phase 1.

  ──────────────────────────────────────────────────────────────────────────
  B) BLOCK NOT IN CACHE — SEARCH MESSAGE
  ──────────────────────────────────────────────────────────────────────────

  When /api/block/:ref returns 404, the response body includes a hint:
    {"error":"Block not found","hint":"cache_miss"}

  block.html / app.js renders:
    ┌──────────────────────────────────────────────────────────────────┐
    │  Block not found                                                 │
    │  ──────────────────────────────────────────────────────────────  │
    │  This node caches the last ~500 blocks (~2 weeks of data).       │
    │  Older blocks are not available on this instance.                │
    │                                                                  │
    │  Try an archive explorer:  grincoin.org/blocks                   │
    └──────────────────────────────────────────────────────────────────┘

  The blocks_cache value in the message ("~500 blocks") should be read
  from window.GRINSCAN_BLOCKS_CACHE (injected by server.js from config)
  so it stays accurate if the operator changes blocks_cache in config.json.

  ──────────────────────────────────────────────────────────────────────
  C) FOOTER
  ──────────────────────────────────────────────────────────────────────

  Appears at the bottom of index.html, block.html, and info.html.

    ┌──────────────────────────────────────────────────────────────────┐
    │  GrinScan v1.0.0  ·  Grin node v5.3.0  ·  MAINNET               │
    │  Powered by Grin Node Toolkit                                    │
    └──────────────────────────────────────────────────────────────────┘

  Data injected by server.js as window globals:
    GRINSCAN_VERSION  — from package.json (read once at startup)
    GRINSCAN_NETWORK  — from config.json
  Grin node version shown in /api/stats as "node_version" (see section 30B).
  Footer JS reads these globals; no extra API call needed.

  CSS:
    .gs-footer {
      border-top: 1px solid var(--border);
      padding: 20px 16px;
      text-align: center;
      font-size: 11px;
      color: var(--muted);
      font-family: var(--font-mono);
      margin-top: 40px;
    }

  ──────────────────────────────────────────────────────────────────────
  D) NODE SYNC / STALL WARNING BANNER
  ──────────────────────────────────────────────────────────────────────

  Trigger: /api/stats returns "stalled":true  (see section 30B for
           how the backend tracks this).

  Frontend (app.js):
    After each /api/stats poll, if response.stalled:
      Show sticky yellow banner at top of page content area (below header):
        "⚠  No new blocks for 2+ minutes — node may be syncing or offline"
    When response.stalled becomes false: remove banner automatically.
    Banner never blocks interaction — it is purely informational.

  CSS:
    .gs-stall-banner {
      background: rgba(242,201,76,0.10);
      border-bottom: 1px solid var(--accent2);
      color: var(--accent2);
      padding: 8px 16px;
      font-size: 12px;
      font-family: var(--font-mono);
      text-align: center;
      position: sticky;
      top: 0;
      z-index: 100;
    }

  ──────────────────────────────────────────────────────────────────────
  E) VERIFICATION CHECKLIST — UX + OPERATIONAL
  ──────────────────────────────────────────────────────────────────────

  Startup backfill:
    [ ] Empty DB on first start triggers backfill from (tip - blocks_cache)
    [ ] /health returns "syncing":true during backfill
    [ ] /health returns "syncing":false after backfill completes
    [ ] 100ms delay between block fetches during backfill
    [ ] Interrupted backfill resumes from max(height) on next start

  Bash lib:
    [ ] grinscan_update() restarts service and shows new version
    [ ] grinscan_logs() tails log file and exits cleanly on Ctrl+C
    [ ] grinscan_configure() tests node connectivity before writing config
    [ ] grinscan_status() shows domain, SSL status, and last price recorded
    [ ] Menu shows options 8 (View Logs) and U (Update)

  Favicon + titles:
    [ ] favicon.svg loads and displays ツ in browser tab
    [ ] index.html tab shows "GrinScan — Mainnet Block Explorer"
    [ ] block.html tab updates to "Block #N — GrinScan" after data loads
    [ ] info.html tab updates per active tab (e.g. "Emission — GrinScan")

  Cache miss:
    [ ] Searching a non-cached block height returns 404 with "hint":"cache_miss"
    [ ] block.html shows the "not found" panel with archive explorer link
    [ ] blocks_cache value in message matches config.json blocks_cache

  Footer:
    [ ] Footer visible on all three pages
    [ ] GrinScan version matches package.json
    [ ] Grin node version populated from /api/stats node_version field
    [ ] Network label correct (MAINNET / TESTNET)

  Sync warning:
    [ ] Banner appears when /api/stats returns "stalled":true
    [ ] Banner disappears automatically when stalled becomes false
    [ ] Banner does not block any page interaction
    [ ] stalled is true only after ≥ 5 consecutive missed polls (2.5 min)

  robots.txt:
    [ ] GET /robots.txt returns 200 with correct content
    [ ] Disallow lines cover /api/, /rest/, /js/, /css/
    [ ] Allow lines cover /, /block.html, /info.html

================================================================================
  END OF PLANNING DOCUMENT
================================================================================
