╔══════════════════════════════════════════════════════════════════════════╗
║           04_grin_node_foreign_api.sh  —  REFERENCE & FLOWCHART          ║
╚══════════════════════════════════════════════════════════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PORTS & SERVICES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Grin node Foreign API (local, never exposed directly):
    Mainnet  →  127.0.0.1:3413    (HTTP JSON-RPC /v2/foreign)
    Testnet  →  127.0.0.1:13413   (HTTP JSON-RPC /v2/foreign)

  nginx (public HTTPS proxy, MODE B only):
    → https://your-domain/v2/foreign     proxy → 127.0.0.1:3413
    → https://your-domain/               status page (static HTML)
    → https://your-domain/rest/*.json    REST API static JSON files
    → everything else                    return 403

  Tor nginx local listener (option T — MODE B add-on, separate from Script 01):
    Mainnet  →  127.0.0.1:8413    (HTTP, proxies to 3413 with auth header injected)
    Testnet  →  127.0.0.1:18413   (HTTP, proxies to 13413 with auth header injected)
    Tor maps port 80 of the .onion address to this local port.
    Wallets connect credential-free — nginx injects the Foreign API secret.

  REST collector cron:
    www-data  every 60 s  →  rest-collector.py  →  /var/www/grin-node-api/rest/
    root      every 60 s  →  node-collector.py  →  /var/www/grin-node-api/rest/node.json

  REST JSON endpoints (GET, CORS * allowed, Cache-Control 60 s):
    /rest/stats.json        height, supply, difficulty, hash, versions
    /rest/supply.json       circulating supply  (height × 60 grin)
    /rest/height.json       current block height
    /rest/difficulty.json   total network difficulty
    /rest/emission.json     emission schedule (static)
    /rest/node.json         peers, chain_size_mb, archive_mode

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  KEY PATHS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  nginx site configs:
    /etc/nginx/sites-available/grin-node-api             mainnet
    /etc/nginx/sites-available/grin-node-api-testnet     testnet
    /etc/nginx/nginx.conf                                rate-limit zones injected here

  nginx rate-limit zones (injected into nginx.conf http block by _nginx_add_limit_req_zone):
    limit_req_zone  $binary_remote_addr zone=grin_api:10m  rate=10r/s;
    limit_conn_zone $binary_remote_addr zone=grin_conn:10m;
    limit_req_status  429;
    limit_req_log_level warn;

  Static files served by nginx:
    /var/www/grin-node-api/           mainnet status page + REST dir
    /var/www/grin-node-api-testnet/   testnet status page + REST dir
    /var/www/grin-node-api/rest/      mainnet REST JSON files
    /var/www/grin-node-api-testnet/rest/  testnet REST JSON files

  Collector scripts (installed to system path for cron):
    /opt/grin/grin-api-collector/rest-collector.py    queries Foreign API → JSON
    /opt/grin/grin-api-collector/node-collector.py    reads node data → node.json

  Cron jobs:
    /etc/cron.d/grin-node-api-rest           mainnet REST cron (www-data)
    /etc/cron.d/grin-node-api-rest-testnet   testnet REST cron (www-data)
    /etc/cron.d/grin-node-api-node           mainnet node cron (root)
    /etc/cron.d/grin-node-api-node-testnet   testnet node cron (root)

  Tor hidden service — Script 04's own (option T):
    /var/lib/tor/grin-mainnet-nginx/hostname          mainnet .onion address file
    /var/lib/tor/grin-testnet-nginx/hostname        testnet .onion address file
    /var/lib/tor/grin-mainnet-nginx/hs_ed25519_*      Ed25519 key pair (identity)
    /etc/nginx/sites-available/grin-node-api-tor          mainnet Tor listener config
    /etc/nginx/sites-available/grin-node-api-tor-testnet  testnet Tor listener config
    torrc marker: # >>> grin-toolkit:04-<network> >>>

  Tor hidden service — Script 01's raw service (step 13b, separate identity):
    /var/lib/tor/grin-mainnet/hostname             mainnet .onion → raw port 3413 direct
    /var/lib/tor/grin-testnet/hostname             testnet .onion → raw port 13413 direct
    torrc marker: # >>> grin-toolkit:<network> >>>
    NOTE: Script 04's status page reads ONLY grin-<net>-nginx/hostname, not this one.
          Callers here need the Foreign API secret — no auth injection.

  Logs:
    /opt/grin/logs/grin_node_services_YYYYMMDD_HHMMSS.log
    /var/log/nginx/grin-node-api.access.log
    /var/log/nginx/grin-node-api.error.log

  Foreign API secret (Basic Auth for rest-collector):
    <grin-data-dir>/.foreign_api_secret    owned root:www-data, chmod 640

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  TWO MODES — MUTUALLY EXCLUSIVE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  MODE A — Raw TCP Direct Access
  ┌───────────────────────────────────────────────────────────────────────┐
  │  Caller  ──HTTP──►  YOUR_SERVER_IP:3413/v2/foreign                   │
  │                                                                       │
  │  • Opens firewall port 3413 (ufw / iptables)                         │
  │  • Patches grin-server.toml api_http_addr = "0.0.0.0:3413"           │
  │  • No SSL, no domain required — IP address access only               │
  │  • Use case: quick testing, trusted internal network                  │
  └───────────────────────────────────────────────────────────────────────┘

  MODE B — nginx HTTPS Proxy  ← recommended for production
  ┌───────────────────────────────────────────────────────────────────────┐
  │  Caller  ──HTTPS──►  domain/v2/foreign                               │
  │                           │                                           │
  │                      nginx (443)                                      │
  │                      rate limit: grin_api 10r/s burst=20             │
  │                      conn limit: grin_conn 20                        │
  │                           │                                           │
  │                      127.0.0.1:3413/v2/foreign                       │
  │                                                                       │
  │  • Requires domain + Let's Encrypt SSL (certbot)                     │
  │  • grin-server.toml api_http_addr stays 127.0.0.1 (safe)            │
  │  • CORS headers stripped from node response and re-added by nginx    │
  │  • Basic Auth forwarded to node if .foreign_api_secret exists        │
  └───────────────────────────────────────────────────────────────────────┘

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  MENU OVERVIEW  (options 1–9 inside each network)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Network select → 1) Mainnet   2) Testnet

  ── MODE A ──────────────────────────────────────────────────────────────
  1) Enable Raw TCP    _enable_raw_tcp()    opens port, patches toml
  2) Disable Raw TCP   _disable_raw_tcp()   closes port, reverts toml
  3) Status Raw TCP    _status_raw_tcp()    shows bind addr + firewall

  ── MODE B ──────────────────────────────────────────────────────────────
  4) Enable nginx      _enable_node_api_nginx()   writes nginx site config,
                                                   gets SSL cert, injects
                                                   rate-limit zones into
                                                   nginx.conf, reloads nginx
  5) Remove nginx      _disable_node_api_nginx()  removes site config + symlink

  ── STATUS PAGE (requires option 4 first) ───────────────────────────────
  6) Deploy/Update     _enable_status_page()   copies static HTML to web root,
                                               writes config.js with:
                                                 GRIN_NETWORK = "mainnet|testnet"
                                                 GRIN_ONION_URL = "http://[prefix]<hash>.onion"
                                                   (read from /var/lib/tor/grin-<net>-nginx/hostname
                                                    if option T was run; else "" → JS shows
                                                    "not configured" in Tor card)
                                               patches nginx catch-all from
                                               OLD_LOC → NEW_LOC (see below),
                                               reloads nginx
  7) Remove page       _disable_status_page()  reverts NEW_LOC → OLD_LOC,
                                               removes web root files

  ── TOR ONION (requires option 4 first) ─────────────────────────────────
  T) Enable Tor    _enable_tor_nginx()    writes 127.0.0.1:8413 nginx listener,
                                          installs torrc HiddenService stanza,
                                          waits up to 30 s for hostname file,
                                          updates config.js GRIN_ONION_URL if
                                          status page is already deployed
  U) Disable Tor   _disable_tor_nginx()   removes nginx listener + symlink,
                                          removes torrc stanza, reloads tor,
                                          clears GRIN_ONION_URL in config.js
                                          (Ed25519 keys in grin-<net>-nginx/ kept)

  ── REST API (requires option 6 first) ──────────────────────────────────
  8) Enable REST       _enable_rest_api()    installs collectors, writes cron,
                                             calls _nginx_add_limit_req_zone,
                                             patches nginx REST block,
                                             reloads nginx
  9) Disable REST      _disable_rest_api()   removes cron + JSON files,
                                             removes REST nginx block

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  NGINX PATCH CHAIN  (option 4 → 6 → 8)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Each option builds on the previous by transforming the nginx site config
  in-place using Python string replacement (no regex — exact string match).

  AFTER OPTION 4  (_deploy_node_api writes fresh config):
  ┌─────────────────────────────────────────────────────┐
  │  server {                                           │
  │    location /v2/foreign { ... limit_req grin_api }  │
  │                                                     │
  │    # Block all other paths — owner/admin API        │  ← OLD_LOC
  │    location / {                                     │
  │        return 403 "Access denied...";               │
  │    }                                                │
  │  }                                                  │
  └─────────────────────────────────────────────────────┘

  AFTER OPTION 6  (_nginx_patch_status replaces OLD_LOC with NEW_LOC):
  ┌─────────────────────────────────────────────────────┐
  │  server {                                           │
  │    location /v2/foreign { ... }                     │
  │                                                     │
  │    # Security headers (X-Content-Type etc.)         │  ← NEW_LOC start
  │    root /var/www/grin-node-api;                     │
  │    location ~ /\. { deny all; }                     │
  │    location ~* \.(html|css|js|svg|ico|png)$ { ... } │
  │    location = / { try_files /index.html =404; }     │
  │                                                     │
  │    # Block everything else                          │  ← CATCH_ALL anchor
  │    location / { return 403; }                       │  ← _nginx_patch_rest
  │  }                                                  │    inserts REST block
  └─────────────────────────────────────────────────────┘    BEFORE this line

  AFTER OPTION 8  (_nginx_patch_rest inserts REST_BLOCK before CATCH_ALL):
  ┌─────────────────────────────────────────────────────┐
  │  server {                                           │
  │    location /v2/foreign { ... }                     │
  │    root /var/www/grin-node-api;                     │
  │    location ~* \.(html|css|js|...)$ { ... }         │
  │    location = / { try_files /index.html =404; }     │
  │                                                     │
  │    # REST API static JSON — refreshed every 60s     │  ← REST_BLOCK
  │    location ~* ^/rest/[^/]+\.json$ {                │
  │        limit_req  zone=grin_api burst=30 nodelay;   │
  │        limit_req_status 429;                        │
  │        add_header Content-Type application/json;    │
  │        add_header Access-Control-Allow-Origin "*";  │
  │        add_header Cache-Control "public,max-age=60";│
  │        try_files $uri =404;                         │
  │    }                                                │
  │    location /rest/ { return 403; }                  │
  │                                                     │
  │    # Block everything else                          │  ← CATCH_ALL (kept)
  │    location / { return 403; }                       │
  │  }                                                  │
  └─────────────────────────────────────────────────────┘

  IMPORTANT: _nginx_patch_rest uses EXACT string matching.
  The CATCH_ALL anchor must read:
      "    # Block everything else\n    location / {\n        return 403;\n    }"
  This text only exists AFTER option 6 (status page) runs _nginx_patch_status.
  If option 8 is run before option 6, the anchor is not found → REST block
  is NOT inserted → nginx -t passes on the unchanged config → no error,
  but no REST endpoints either.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  OPTION 8 — ENABLE REST API  (detailed flow)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  _enable_rest_api()
       │
       ├─ Guard: status page index.html must exist → else warn + return
       │
       ├─ 1. Copy rest-collector.py → /opt/grin/grin-api-collector/
       │
       ├─ 2. Detect owner of grin data dir (for node-collector cron user)
       │
       ├─ 3. mkdir /var/www/grin-node-api/rest/
       │       chown www-data:www-data  chmod 775
       │       chmod .foreign_api_secret → root:www-data 640
       │
       ├─ 4. Write /etc/cron.d/grin-node-api-rest
       │       www-data runs rest-collector.py every 60s
       │
       ├─ 5. Copy node-collector.py → /opt/grin/grin-api-collector/
       │       Write /etc/cron.d/grin-node-api-node
       │       root runs node-collector.py every 60s
       │       Run initial node collection now
       │
       ├─ 6. Run initial REST collection now (sudo -u www-data)
       │       [OK] Initial REST data collected.        ← user sees this
       │       or WARN if node not running yet (cron retries)
       │
       ├─ 7. _nginx_add_limit_req_zone
       │       Check nginx.conf for "zone=grin_conn"
       │       → already present: skip (idempotent)
       │       → missing: inject zones block into nginx.conf http { block
       │         (limit_req_zone grin_api, limit_conn_zone grin_conn,
       │          limit_req_status 429, limit_req_log_level warn)
       │
       ├─ 8. _nginx_patch_rest  (enable)
       │       Python: look for CATCH_ALL anchor in site config
       │       → found:  insert REST_BLOCK before it  (writes file)
       │       → not found: no change (silent — means option 6 not done)
       │
       └─ 9. nginx -t  (output captured, shown on failure)
               → pass:  systemctl reload nginx  →  [OK] REST API enabled
               → fail:  print nginx error
                         _nginx_patch_rest disable  (revert)
                         rm cron file
                         nginx -t && reload

  Common failure reasons for step 9:
  ┌────────────────────────────────────────────────────────────────────┐
  │  "unknown zone 'grin_api'"   → zone not in nginx.conf             │
  │                                 (step 7 fix added — should not    │
  │                                  happen any more)                  │
  │  "duplicate location /rest/" → stale REST block from a previous   │
  │                                 partial run is still in the config │
  │                                 FIX: run option 9 first, then 8   │
  │                                 (disable now strips legacy blocks) │
  │  "duplicate directive"       → limit_req_status defined twice     │
  │                                 check: grep -rn limit_req_status   │
  │                                        /etc/nginx/                 │
  │  nginx -t passes but         → CATCH_ALL anchor not found         │
  │  REST endpoints 404           (run option 6 first, then option 8) │
  └────────────────────────────────────────────────────────────────────┘

  Idempotency guard (enable):
    Checks for "location /rest/" in the config — NOT the full block text.
    This prevents duplicate insertion even if the block was written by an
    older version of the script (different whitespace or comments).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  OPTION 4 REBUILD BEHAVIOUR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Re-running option 4 (Enable nginx) rewrites the nginx site config from
  scratch. It then automatically re-applies any patches that were active:

    if status page index.html exists → re-run _nginx_patch_status (enable)
                                        + _nginx_add_limit_req_zone
    if REST cron OR stats.json exist → re-run _nginx_patch_rest (enable)

  This ensures options 6 and 8 survive a domain change or cert renewal.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  CORRECT SETUP ORDER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  For MODE B with status page, Tor, and REST API, follow this order:

  [Script 01]  Install & run Grin node
       ↓           (creates /var/lib/tor/grin-<net>/ — raw Foreign API onion,
       ↓            separate from Script 04's onion)
  [Script 04]  Option 4 — Enable nginx HTTPS proxy
       ↓           (writes site config + SSL + injects rate-limit zones)
  [Script 04]  Option T — Enable Tor onion  (optional)
       ↓           (creates /var/lib/tor/grin-<net>-nginx/ — nginx-proxied onion,
       ↓            updates config.js GRIN_ONION_URL if page already deployed)
  [Script 04]  Option 6 — Deploy status page
       ↓           (patches OLD_LOC → NEW_LOC, CATCH_ALL anchor now present;
       ↓            reads /var/lib/tor/grin-<net>-nginx/hostname → GRIN_ONION_URL)
  [Script 04]  Option 8 — Enable REST API
                  (installs collectors + cron, inserts REST_BLOCK before
                   CATCH_ALL, reloads nginx)

  NOTE: Option T can be run before or after option 6 — both update config.js.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  TOR IDENTITY — BACKUP & RECOVERY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Two Tor hidden services may exist on the VPS — they have separate identities:

  ┌─────────────────────────────────────────────────────────────────────┐
  │  Script 01   /var/lib/tor/grin-<net>-raw-tcp/   raw Foreign API (direct) │
  │  Script 04   /var/lib/tor/grin-<net>-nginx/   nginx-proxied (no creds) │
  └─────────────────────────────────────────────────────────────────────┘

  Each dir contains:
    hostname             56-char .onion address (text file, written by tor)
    hs_ed25519_public_key    Ed25519 public key  (64 bytes)
    hs_ed25519_secret_key    Ed25519 secret key  (96 bytes)  ← THE IDENTITY
    authorized_clients/      empty dir (client auth not used)

  Owner: debian-tor:debian-tor   Dir: chmod 700   Key files: chmod 600

  ── BACKUP (run periodically, especially before server changes) ─────────

    # Script 04's nginx-proxied onion
    cp -rp /var/lib/tor/grin-mainnet-nginx/ /opt/grin/backup/tor-grin-mainnet-nginx-$(date +%Y%m%d)/

    # Script 01's raw onion
    cp -rp /var/lib/tor/grin-mainnet-raw-tcp/ /opt/grin/backup/tor-grin-mainnet-raw-tcp-$(date +%Y%m%d)/

  ── RECOVERY FROM BACKUP (same .onion address preserved) ────────────────

    systemctl stop tor
    rm -rf /var/lib/tor/grin-mainnet-nginx/
    cp -rp /opt/grin/backup/tor-grin-mainnet-nginx-YYYYMMDD/ /var/lib/tor/grin-mainnet-nginx/
    chown -R debian-tor:debian-tor /var/lib/tor/grin-mainnet-nginx/
    chmod 700 /var/lib/tor/grin-mainnet-nginx/
    chmod 600 /var/lib/tor/grin-mainnet-nginx/hs_ed25519_public_key \
              /var/lib/tor/grin-mainnet-nginx/hs_ed25519_secret_key
    systemctl start tor
    cat /var/lib/tor/grin-mainnet-nginx/hostname   # verify same address appears

    # Then re-run Script 04 option T (re-enable) or option 6 (Update page)
    # to refresh config.js with the restored address.

  ── RECOVERY WITHOUT BACKUP (new .onion address, old address lost) ──────

    # 1. Verify the torrc stanza still exists:
    grep -A3 "grin-mainnet-nginx" /etc/tor/torrc
    #    Should show:  HiddenServiceDir /var/lib/tor/grin-mainnet-nginx/
    #                  HiddenServicePort 80 127.0.0.1:8413

    # 2. Delete (or it is already gone) and reload:
    rm -rf /var/lib/tor/grin-mainnet-nginx/
    systemctl reload tor

    # 3. Wait ~30-60 seconds, then check the new address:
    cat /var/lib/tor/grin-mainnet-nginx/hostname

    # 4. Update config.js / status page:
    #    Re-run Script 04 option T (re-enable Tor) — it detects the
    #    existing nginx listener and updates config.js automatically.
    #    Or run option 6 (Update status page) to regenerate config.js.

    # If torrc stanza was also deleted, run Script 04 option T from scratch.

  ── TORRC MARKER REFERENCE ──────────────────────────────────────────────

    Script 01 (grin-<net>-raw-tcp):  # >>> grin-toolkit:01-<network> >>>
    Script 04 (grin-<net>-nginx):  # >>> grin-toolkit:04-<network> >>>

    Markers prevent torrc collision — each script only touches its own block.
