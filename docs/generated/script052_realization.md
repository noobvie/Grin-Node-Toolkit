╔══════════════════════════════════════════════════════════════════════════════╗
║         052_grin_drop.sh  —  REALIZATION  (As Built)                        ║
╚══════════════════════════════════════════════════════════════════════════════╝

  Date:     2026-05-04
  Scope:    Documents the architecture and flow of the code actually shipped
            in scripts/052_grin_drop.sh + scripts/lib/052_lib_*.sh
            Compare with: flowcharts/script052_planning.txt (planning v12)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  1. ARCHITECTURE OVERVIEW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  One domain, one nginx vhost, two independent Node.js services:

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  drop.example.com                                                       │
  │                                                                         │
  │   /              → Unified homepage  (static HTML, nginx root)          │
  │   /testnet/      → Testnet portal    (proxy → Node.js :3004)            │
  │   /testnet/api/  → Testnet API       (proxy → Node.js :3004/api/)       │
  │   /mainnet/      → Mainnet portal    (proxy → Node.js :3005)            │
  │   /mainnet/api/  → Mainnet API       (proxy → Node.js :3005/api/)       │
  └─────────────────────────────────────────────────────────────────────────┘

  The domain is owned once at the top level — both networks share it.
  The homepage is static files served by nginx directly (not proxied).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  2. FULL STACK DIAGRAM (as-built)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Internet
     │
     │  HTTPS :443
     ▼
  ┌──────────────────────────────────────────────────────┐
  │  nginx                                               │
  │  - SSL termination (Let's Encrypt or Cloudflare)     │
  │  - Rate limiting (drop_home / drop_api /             │
  │                   drop_test / drop_main zones)       │
  │  - Static files: unified homepage (nginx root)       │
  │  - sub_filter: inject APP_BASE, DROP_NETWORK,        │
  │    theme CSS, GA4 ID, Turnstile site key             │
  │  - Reverse proxy by path prefix (^~ /testnet/ etc.)  │
  │  - Security headers (HSTS, CSP, X-Frame-Options …)   │
  └──────┬─────────────────────────────┬─────────────────┘
         │ /testnet/                   │ /mainnet/
         │ HTTP :3004 (localhost)      │ HTTP :3005 (localhost)
         ▼                             ▼
  ┌─────────────────┐           ┌─────────────────┐
  │ Node.js/Express │           │ Node.js/Express │
  │ grin-drop-test  │           │ grin-drop-main  │
  │ server/app.js   │           │ server/app.js   │
  │ server/wallet.js│           │ server/wallet.js│
  │ server/db.js    │           │ server/db.js    │
  │ server/config.js│           │ server/config.js│
  └───────┬─────────┘           └───────┬─────────┘
          │ JSON-RPC (fetch)             │ JSON-RPC (fetch)
          ▼                              ▼
  ┌─────────────────┐           ┌─────────────────┐
  │ grin-wallet     │           │ grin-wallet     │
  │ tmux: TOR sess  │           │ tmux: TOR sess  │
  │ Foreign :13415  │           │ Foreign :3415   │
  │ tmux: OWN sess  │           │ tmux: OWN sess  │
  │ Owner  :13420   │           │ Owner  :3420    │
  └─────────────────┘           └─────────────────┘
          │                              │
          ▼                              ▼
  ┌─────────────────┐           ┌─────────────────┐
  │ node:sqlite     │           │ node:sqlite     │
  │ drop-test.db    │           │ drop-main.db    │
  └─────────────────┘           └─────────────────┘

  Shared config (cross-network):
  ┌────────────────────────────────────────────┐
  │  /opt/grin/conf/drop_shared.conf           │
  │  Keys: subdomain, ssl_type,                │
  │         drop_name, ga4_id,                 │
  │         turnstile_site_key,                │
  │         turnstile_secret                   │
  └────────────────────────────────────────────┘

  Unified homepage (static, nginx-served):
  ┌────────────────────────────────────────────┐
  │  /var/www/grin-drop-home/index.html        │
  │  fetch('/testnet/api/public-stats')        │
  │  fetch('/mainnet/api/public-stats')        │
  └────────────────────────────────────────────┘

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  3. SCRIPT STRUCTURE (as-built)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  scripts/
    052_grin_drop.sh              entry point (~840 lines)
                                    select_network()     — top-level menu
                                    _set_network()       — env var switch
                                    drop_menu()          — per-network submenu
                                    drop_nuke()          — D) delete all
                                    drop_ga4_menu()      — option 6 (GA4)
                                    drop_turnstile_menu()— option 7 (Turnstile)
                                    drop_read_conf()     — JSON read (python3)
                                    drop_write_conf_key()— JSON write (python3)
                                    drop_ensure_defaults()— init config keys
                                    _shared_read/write() — cross-network conf
                                    _patch_toml()        — TOML key update
                                    _patch_toml_in_section() — section-aware
                                    drop_menu_status()   — status header block
    lib/
      052_lib_wallet.sh           wallet setup + listener
                                    drop_setup_wallet()     — step 1 (submenu)
                                    drop_wallet_listener()  — step 2 (submenu)
                                    _drop_wallet_install_new()
                                    _drop_wallet_reinstall()
                                    _drop_wallet_scan()
                                    _drop_wallet_update_bin()
                                    _drop_wallet_switch_node()
                                    _drop_wallet_view_seed()
                                    _drop_download_wallet() — GitHub API
                                    _drop_select_node()     — node picker
                                    _drop_init_wallet()     — new or recover
                                    _drop_write_toml()      — patch wallet toml
                                    _drop_start/stop_session()
                                    _drop_toggle_reboot_cron()
                                    _drop_toggle_watchdog_cron()
                                    _drop_launch_session()  — su grin + tmux
                                    _drop_kill_wallet_processes()
                                    _drop_fix_ownership()
                                    _drop_save_pass/seed()
      052_lib_app.sh              install + configure
                                    drop_install()    — step 3
                                    drop_configure()  — step 4
      052_lib_nginx.sh            nginx + domain management
                                    drop_create_domain()      — top-level opt 1
                                    drop_remove_domain()      — top-level opt 5
                                    _drop_set_domain()
                                    _drop_renew_ssl()
                                    _drop_reapply_nginx()
                                    _drop_nginx_refresh()     — called by GA4/TS
                                    _drop_write_unified_conf()— nginx vhost gen
                                    _drop_nginx_letsencrypt()
                                    _drop_nginx_cloudflare()
                                    _drop_nginx_logrotate()
                                    _drop_evict_apache2()
      052_lib_admin.sh            deploy + service + status + backup
                                    drop_deploy_web()     — step 5
                                    drop_service_control()— step 6
                                    drop_status_screen()  — step 7
                                    drop_wallet_address() — step 8
                                    drop_view_logs()      — L)
                                    drop_backup()         — B)
                                    drop_restore()        — R)

  web/052_drop/
    server/                       Node.js/Express (single copy, both networks)
      app.js                      Express app
      wallet.js                   Foreign + Owner API helpers (ECDH)
      db.js                       node:sqlite schema + query helpers
      config.js                   JSON read/write (grin_drop_<net>.conf)
      package.json
    public_html/                  Portal HTML (single copy, both networks)
      index.html                  Faucet + donate page
      js/faucet.js                Claim + donate JS
      js/theme.js                 Theme switcher
      css/faucet.css
      css/themes/                 matrix.css  win98.css  dark.css
                                  cute.css   light.css  warcraft.css
      img/                        Grin SVG logos
    home/                         Unified homepage
      index.html
      css/home.css
      img/

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  4. FILE / PATH REFERENCE (as-built)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Services & ports:
  Service              Port    App dir
  ──────────────────── ──────  ───────────────────────────────
  grin-drop-test       3004    /opt/grin/drop-test/
  grin-drop-main       3005    /opt/grin/drop-main/
  wallet Foreign API   13415   testnet    3415   mainnet
  wallet Owner API     13420   testnet    3420   mainnet
  nginx                443     unified vhost (domain from drop_shared.conf)

  Full path reference — mainnet (testnet: swap -main→-test, ports accordingly):
  ────────────────────────────────────────────────────────────────────────────
  App / wallet dir    /opt/grin/drop-main/               ← same dir
  Database            /opt/grin/drop-main/drop-main.db
  Config              /opt/grin/drop-main/grin_drop_main.conf
  Activity log        /opt/grin/logs/grin_drop_<timestamp>.log
  Wallet binary       /opt/grin/drop-main/grin-wallet
  Wallet toml         /opt/grin/drop-main/grin-wallet.toml
  Wallet data         /opt/grin/drop-main/wallet_data/
  Foreign secret      /opt/grin/drop-main/.foreign_api_secret
  Owner secret        /opt/grin/drop-main/.owner_api_secret
  Wallet passphrase   /opt/grin/drop-main/.temp_main      (mode 600)
  Seed words          /opt/grin/drop-main/.word_main      (mode 600, root)
  Reboot wrapper      /opt/grin/drop-main/drop-main-start.sh
  Watchdog wrapper    /opt/grin/drop-main/drop-main-watchdog.sh
  Backups dir         /opt/grin/backups/
  Server files        /opt/grin/drop-main/server/
  Public html         /opt/grin/drop-main/public_html/
  systemd service     /etc/systemd/system/grin-drop-main.service
  nginx vhost         /etc/nginx/sites-available/<domain>
  Unified homepage    /var/www/grin-drop-home/
  Shared config       /opt/grin/conf/drop_shared.conf
  Node logs           /opt/grin/logs/grin_drop_<timestamp>.log
  logrotate           /etc/logrotate.d/grin-drop-main
  nginx logrotate     /etc/logrotate.d/nginx-grin-drop

  Backup archive contents (both networks in one file):
    grin_drop_all_backup_<timestamp>.tar.gz.enc
      testnet/drop.db
      testnet/grin_drop.conf
      testnet/wallet_pass
      testnet/seed-words
      mainnet/drop.db
      mainnet/grin_drop.conf
      mainnet/wallet_pass
      mainnet/seed-words
      shared/drop_shared.conf

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  5. MENU STRUCTURE (as-built)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ── Top-level menu ──────────────────────────────────────────────────────────

  ┌─────────────────────────────────────────────────────────────────────────┐
  │   052) GRIN DROP                                                        │
  │                                                                         │
  │   Domain: <domain>  |  GA4: <id or not configured>                      │
  │                                                                         │
  │   ─── Domain & nginx ──────────────────────────────                     │
  │   1) Create / Update domain  (nginx + SSL for unified drop)             │
  │   5) Remove current domain   (delete nginx config + SSL)                │
  │                                                                         │
  │   ─── Networks ────────────────────────────────────                     │
  │   2) Testnet  (tGRIN — no monetary value)  drop: [running/not running]  │
  │   3) Mainnet  ⚠ sends/receives real GRIN   drop: [running/not running]  │
  │   4) Unified Homepage  (aggregated stats for both networks)             │
  │   7) Turnstile          (Cloudflare bot protection — optional)          │
  │   6) Google Analytics   (GA4 tracking — optional)                       │
  │                                                                         │
  │   ─── Admin (both networks) ───────────────────────                     │
  │   B) Backup   (encrypted archive: testnet + mainnet)                    │
  │   R) Restore  (decrypt + restore backup)                                │
  │   D) Delete   (wipe all drop data — services, wallets, config, nginx)   │
  │                                                                         │
  │   0) Back to main menu                                                  │
  │                                                                         │
  │   Select [1-7 / B / R / D / 0]:                                         │
  └─────────────────────────────────────────────────────────────────────────┘

  ── Network submenu (testnet/mainnet — identical layout) ────────────────────

  ┌─────────────────────────────────────────────────────────────────────────┐
  │   052) GRIN DROP  [MAINNET — REAL GRIN]   (or [TESTNET])               │
  │                                                                         │
  │   Domain: <domain>  (https://<domain>/mainnet/)                         │
  │   Mode: giveaway ● ON  |  donation ● ON                                 │
  │                                                                         │
  │   Grin node  : ● running  (port 3413)                                   │
  │   Wallet TOR : ● listening  (drop-main-tor)                             │
  │   Wallet OWN : ● listening  (drop-main-ownerapi)                        │
  │   3 Install  : OK                                                       │
  │   4 Configure: OK                                                       │
  │   5 Web files: deployed  (/opt/grin/drop-main/public_html/)             │
  │   6 Service  : ● running  (https://<domain>/mainnet/)                   │
  │                                                                         │
  │   ─── First-time setup (run in order) ───────────────                   │
  │   1) Setup wallet     (download binary + 6-option submenu)              │
  │   2) Wallet listening (TOR + Owner API tmux, cron, watchdog)            │
  │   3) Install          (Node.js/npm + systemd service)                   │
  │   4) Configure        (modes, claim amount, wallet API ports/secrets)   │
  │   5) Deploy web files (copy to /opt/grin/drop-main/public_html/)        │
  │   6) Start / Stop     (systemd grin-drop-main)                          │
  │                                                                         │
  │   ─── Info & maintenance ────────────────────────────                   │
  │   7) Drop status    (health, balance, claims, logs)                     │
  │   8) Wallet address (show + update)                                     │
  │   L) View logs      (activity / journal / nginx)                        │
  │                                                                         │
  │   ↩  Press Enter to refresh                                             │
  │   0) Back to network select                                              │
  │                                                                         │
  │   Select [1-8 / L / 0]:                                                 │
  └─────────────────────────────────────────────────────────────────────────┘

  ── Option 1 (wallet) submenu ───────────────────────────────────────────────

  ┌─────────────────────────────────────────────────────────────────────────┐
  │   ── Grin Drop [MAINNET] — 1) Setup Wallet ──                           │
  │                                                                         │
  │   Binary      : installed / not installed                               │
  │   Wallet data : present  /  absent                                      │
  │   Current node: <url>                                                   │
  │                                                                         │
  │   1) Install new wallet   (first-time setup)                            │
  │   2) Re-install wallet    (clean + full reinstall)                      │
  │   3) Scan wallet          (recover balance / after node switch)         │
  │   4) Update binary        (download latest, keep wallet data)           │
  │   5) Switch Grin node     (change node without reinstalling)            │
  │   6) View / recover seed  (display seed phrase, optionally save)        │
  │   0) Back                                                               │
  └─────────────────────────────────────────────────────────────────────────┘

  ── Option 2 (wallet listener) submenu ─────────────────────────────────────

  ┌─────────────────────────────────────────────────────────────────────────┐
  │   ── Grin Drop [MAINNET] — 2) Wallet Listening ──                       │
  │                                                                         │
  │   TOR session  (drop-main-tor)   : ● running   port :3415 listening     │
  │   Owner session(drop-main-ownerapi): ○ stopped  port :3420 not listening│
  │   Auto-start @reboot : ● enabled   Watchdog : ● enabled                 │
  │   Passphrase file    : ✓ exists  (/opt/grin/drop-main/.temp_main)       │
  │                                                                         │
  │   1) Start / restart TOR session                                        │
  │   2) Start / restart Owner API session                                  │
  │   3) Start / restart Both                                               │
  │   ──────────────────────────────────────                                │
  │   4) Stop TOR session                                                   │
  │   5) Stop Owner API session                                             │
  │   6) Stop both                                                          │
  │   ──────────────────────────────────────                                │
  │   7) Auto-start TOR/API wallets @reboot  [toggle]                       │
  │   8) Watchdog: auto-restart wallet on crash  [toggle]                   │
  │   ──────────────────────────────────────                                │
  │   To view wallet output: Ctrl+B then S to switch tmux sessions          │
  │   ↩  Refresh status                                                     │
  │   0) Back                                                               │
  │                                                                         │
  │   Select [1-8/0]:                                                        │
  └─────────────────────────────────────────────────────────────────────────┘

  ── Option 1 (domain) submenu ───────────────────────────────────────────────

  ┌─────────────────────────────────────────────────────────────────────────┐
  │   052) GRIN DROP — 1) Domain & nginx                                    │
  │                                                                         │
  │   Current status:                                                       │
  │   Site name  : Grin Drop                                                │
  │   Domain     : drop.example.com                                         │
  │   Nginx conf : /etc/nginx/sites-available/drop.example.com  (exists)    │
  │   SSL type   : letsencrypt                                              │
  │                                                                         │
  │   1) Set / Update site name & domain                                    │
  │   2) Renew / Re-run SSL only                                            │
  │   3) Re-apply nginx config  (rewrite vhost without changing domain)     │
  │                                                                         │
  │   0) Back                                                               │
  │                                                                         │
  │   Select [1/2/3/0]:                                                     │
  └─────────────────────────────────────────────────────────────────────────┘

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  6. NGINX INJECTION MODEL (sub_filter)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  The same static HTML files serve both networks. nginx injects context:

  Location         Injected variables
  ───────────────  ─────────────────────────────────────────────────────────
  /testnet/ block  window.APP_BASE="/testnet"
                   window.DROP_NETWORK="testnet"
                   id="theme-css" href="css/themes/matrix.css"   (default)
                   __SITE_URL__  → https://<domain>
                   __GA4_ID__    → <GA4 measurement ID or empty>
                   __CF_TURNSTILE_KEY__ → <site key or empty>

  /mainnet/ block  window.APP_BASE="/mainnet"
                   window.DROP_NETWORK="mainnet"
                   id="theme-css" href="css/themes/win98.css"    (default)
                   __SITE_URL__  → https://<domain>
                   __GA4_ID__    → same
                   __CF_TURNSTILE_KEY__ → same

  / block (home)   __GA4_ID__  __CF_TURNSTILE_KEY__  only

  JavaScript reads window.APP_BASE to prefix all API calls.
  JS reads window.DROP_NETWORK to label the network (GRIN / tGRIN).
  CSP is dynamically extended in nginx to allow GA4/Turnstile domains.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  7. WALLET SETUP FLOW (as-built, option 1 → Install New)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Runs sequentially:
    1. _drop_ensure_system_user()   create grin:grin system user if absent
    2. _drop_download_wallet()      GitHub API → download linux-x86_64 binary
    3. _drop_init_menu()            prompt: 1=new wallet  2=recover from seed
       └─ _drop_init_wallet(mode)
             ├─ _drop_read_pass_new()         passphrase prompt (min 3 chars)
             ├─ grin-wallet init -h / -hr     runs with live TTY
             ├─ prompt: save passphrase?  → _drop_save_pass()  (.temp_<net>)
             └─ prompt: save seed words?  → _drop_save_seed()  (.word_<net>)
    4. _drop_select_and_patch()
       ├─ _drop_select_node()       check public nodes + local node (curl 5s)
       └─ _drop_write_toml()
             ├─ patch check_node_api_http_addr
             ├─ patch node_api_secret_path (for local node, from instances conf)
             ├─ patch api_listen_port / owner_api_listen_port (network-specific)
             ├─ patch_toml_in_section [wallet] owner_api_secret_path
             └─ patch log_max_files=3
    5. _drop_fix_ownership()        chown -R grin:grin, chmod 750, 600 secrets
    6. drop_ensure_defaults()       write all missing conf keys to JSON conf

  After owner_api session start (option 2 → 2):
    - Wait 5 seconds for wallet to initialize
    - Run `grin-wallet address` to auto-fetch address
    - Save fetched address to grin_drop_<net>.conf

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  8. CONFIG KEYS (grin_drop_<net>.conf — JSON)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Key                       Type    Default (mainnet)
  ────────────────────────  ──────  ────────────────────────────────────────
  network                   str     "mainnet"
  drop_name                 str     "Grin Drop"
  theme_default             str     "win98"   (testnet: "matrix")
  giveaway_enabled          bool    true
  claim_grin_per_tx         float   0.008     (testnet: 1.0)
  claim_cooldown_minutes    int     240       (minutes, not hours)
  slatepack_expire_min      int     30
  global_daily_claims_cap   int     2000
  global_hourly_claims_cap  int     100
  donation_enabled          bool    true
  donation_invoice_timeout  int     30
  wallet_address            str     ""
  wallet_foreign_api_port   int     3415      (testnet: 13415)
  wallet_owner_api_port     int     3420      (testnet: 13420)
  wallet_foreign_secret     str     /opt/grin/drop-main/.foreign_api_secret
  wallet_owner_secret       str     /opt/grin/drop-main/.owner_api_secret
  wallet_pass_file          str     /opt/grin/drop-main/.temp_main
  service_port              int     3005      (testnet: 3004)
  show_public_stats         bool    true
  maintenance_mode          bool    false
  maintenance_message       str     "We'll be back soon."
  low_balance_alert_grin    int     -1        (-1 = disabled)
  wallet_cleanup_hours      int     1
  ip_salt                   str     <random hex, generated once>
  log_path                  str     /opt/grin/logs/grin_drop_<ts>.log
  site_description          str     "Claim free GRIN…"
  og_image_url              str     ""

  Shared config (/opt/grin/conf/drop_shared.conf — JSON):
  Key                   Values
  ────────────────────  ─────────────────────────────────────────────────────
  subdomain             domain name (e.g. drop.example.com)
  ssl_type              "letsencrypt" | "cloudflare"
  drop_name             site title
  ga4_id                GA4 measurement ID (e.g. G-XXXXXXXXXX) or ""
  turnstile_site_key    Cloudflare Turnstile public key or ""
  turnstile_secret      Cloudflare Turnstile secret (also in per-net conf)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  9. DIFFERENCES FROM PLANNING (planning v12)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ── A. TOP-LEVEL MENU RESTRUCTURED ──────────────────────────────────────────

  Planning: top-level showed 1=Testnet / 2=Mainnet / 3=Unified Homepage
  Reality:  top-level separates domain management from network selection:
              1=Domain & nginx   (new — was per-network step 6)
              2=Testnet
              3=Mainnet
              4=Unified Homepage (renumbered from 3)
              5=Remove domain    (new)
              6=Google Analytics (new — not in plan)
              7=Turnstile        (new — not in plan)
              B/R/D at top level (moved up from per-network submenu)

  ── B. NGINX IS SHARED / TOP-LEVEL, NOT PER-NETWORK ─────────────────────────

  Planning: nginx setup was step 6 inside each network submenu (each network
            could have its own domain and nginx config).
  Reality:  nginx is one operation at the top level. A single vhost serves
            BOTH networks. Domain is configured once and stored in
            drop_shared.conf, shared by testnet and mainnet.

  ── C. NETWORK SUBMENU SIMPLIFIED ────────────────────────────────────────────

  Planning: 9 options + L + B + R (nginx was step 6, wallet address was step 9)
  Reality:  8 options + L (1-8), no per-network B/R/nginx:
              1=Setup wallet  2=Wallet listening  3=Install
              4=Configure     5=Deploy web files  6=Start/Stop
              7=Drop status   8=Wallet address    L=Logs

  ── D. WALLET SETUP IS NOW A SUBMENU, NOT A LINEAR FLOW ─────────────────────

  Planning: step 1 was a linear 5-step flow (system user → binary → init →
            node select → toml → ownership → summary).
  Reality:  step 1 is a loop submenu with 6 options, allowing the user to
            independently perform:
              1=Install new wallet  2=Re-install  3=Scan wallet
              4=Update binary only  5=Switch node 6=View/recover seed
            The scan option (3) is entirely new — runs `grin-wallet scan`
            in a dedicated tmux session (drop-<net>-scan).

  ── E. WALLET LISTENER MENU SIMPLIFIED ───────────────────────────────────────

  Planning: 9 options + A (attach) + W (watchdog) + P (re-save passphrase)
  Reality:  8 numeric options only:
              1-3=Start  4-6=Stop  7=@reboot cron  8=Watchdog
            - No separate "Attach" option — hint text shows Ctrl+B instead
            - No "P) Re-save passphrase" — prompted inline when starting
              owner session if the pass file is missing

  ── F. WATCHDOG LOGIC SIMPLIFIED ─────────────────────────────────────────────

  Planning: 5-step watchdog (check port → check session → check session age →
            stale detection → pkill + restart).
  Reality:  Simple port-check watchdog — runs every 5 min (not 30):
              ss -tlnp | grep -q ":PORT " || tmux new-session ...
            No stale session age detection. If port is up, nothing happens.
            If port is down, a new session is started unconditionally.

  ── G. WALLET BINARY / DATA PATHS FLATTENED ──────────────────────────────────

  Planning:
    Binary      /opt/grin/drop-main/wallet/grin-wallet
    Wallet data /opt/grin/drop-main/wallet/wallet_data/
    Secrets     /opt/grin/drop-main/wallet/wallet_data/.api_secret
                /opt/grin/drop-main/wallet/.owner_api_secret
  Reality:
    Binary      /opt/grin/drop-main/grin-wallet        ← no /wallet/ subdir
    Wallet data /opt/grin/drop-main/wallet_data/
    Secrets     /opt/grin/drop-main/.foreign_api_secret ← name changed
                /opt/grin/drop-main/.owner_api_secret
    App dir == wallet dir ($DROP_APP_DIR == $DROP_WALLET_DIR)

  ── H. FOREIGN API SECRET RENAMED ────────────────────────────────────────────

  Planning: .api_secret  (in wallet_data/)
  Reality:  .foreign_api_secret  (in DROP_WALLET_DIR root)
            grin-wallet's default api_secret_path is not overridden in toml —
            grin-wallet writes it where it wants; the script reads from there.

  ── I. FILE NAMING CHANGES ────────────────────────────────────────────────────

  Item              Planning                  Reality
  ────────────────  ────────────────────────  ─────────────────────────────
  Database          grin_drop_main.db         drop-main.db
                    grin_drop_test.db         drop-test.db
  Wallet passphrase .wallet_pass_main         .temp_main
                    .wallet_pass_test         .temp_test
  Seed words file   seed-drop.txt             .word_main  /  .word_test
  Activity log      grin_drop_main.log        grin_drop_<timestamp>.log
                    (in app dir)              (in /opt/grin/logs/, centralized)

  ── J. BACKUP SCOPE CHANGED ───────────────────────────────────────────────────

  Planning: B/R was per-network — one archive per network, kept last 10.
  Reality:  B/R is top-level — one archive contains BOTH networks + shared
            config. Stored at /opt/grin/backups/, kept last 10.
            Archive name: grin_drop_all_backup_<timestamp>.tar.gz.enc

  ── K. SQLite DRIVER CHANGED ─────────────────────────────────────────────────

  Planning: better-sqlite3  (native C++ module — requires node-gyp / build tools)
  Reality:  node:sqlite      (Node.js v24+ built-in — no native compilation)
            This eliminates the npm install --build-from-source requirement
            and avoids version compatibility issues with glibc.

  ── L. COOLDOWN UNIT CHANGED ─────────────────────────────────────────────────

  Planning: claim_cooldown_hours (integer hours)
  Reality:  claim_cooldown_minutes (integer minutes) — finer granularity
            Default: 240 minutes (= 4 hours)

  ── L2. CLAIM RATE LIMITING ──────────────────────────────────────────────────

  Planning: nginx rate-limit zones _claim (3r/m) _api (10r/m) _http (20r/m)
            + new donate zones (_donate_receive, _donate_invoice, _donate_finalize)
  Reality:  Unified zones: drop_home (30r/m) drop_api (10r/m)
                           drop_test (5r/m)  drop_main (5r/m)
            API and donate routes share the per-network zone (drop_test/drop_main).
            Nginx uses ^~ /testnet/api/ location (higher priority) with
            drop_test zone at burst=10, and ^~ /testnet/ location at burst=5.

  ── M. STEP 3 INSTALL ALSO DEPLOYS FILES ─────────────────────────────────────

  Planning: step 3=Install (Node.js only), step 5=Deploy web files (separate).
  Reality:  step 3 (drop_install) copies both server/ and public_html/ AND
            runs npm install. Step 5 (drop_deploy_web) does the same for updates.
            Both steps deploy all files — step 3 is first-time, step 5 is refresh.

  ── N. AUTO-FETCH WALLET ADDRESS ON SESSION START ─────────────────────────────

  Planning: no mention.
  Reality:  When starting the owner_api session (option 2→2 or 2→3), the script
            waits 5 seconds, then runs `grin-wallet address` and saves the result
            to grin_drop_<net>.conf (wallet_address key). This way the donate
            tab shows the correct address even if owner_api is temporarily down.

  ── O. NODE API SECRET AUTO-DETECTED FOR LOCAL NODE ──────────────────────────

  Planning: node_api_secret_path not mentioned.
  Reality:  _drop_write_toml() reads /opt/grin/conf/grin_instances_location.conf
            (written by script 01) to find the node's .foreign_api_secret path
            and patches node_api_secret_path in grin-wallet.toml. Required for
            local node connections — without it grin-wallet gets 403 from node.

  ── P. STEP 5 DEPLOY ALSO COVERS UNIFIED HOMEPAGE ────────────────────────────

  Planning: unified homepage deploy was a separate option in the Unified Homepage
            submenu (step 3 in that submenu).
  Reality:  The unified homepage is deployed automatically by _drop_write_unified_conf()
            (called by nginx setup). No separate homepage deploy step needed.
            The homepage files are copied from web/052_drop/home/ → /var/www/grin-drop-home/
            every time nginx config is (re-)applied.

  ── Q. UNIFIED HOMEPAGE SUBMENU SIMPLIFIED ────────────────────────────────────

  Planning: Unified Homepage submenu had 5 options (prereqs check, configure,
            deploy files, setup nginx, status).
  Reality:  The "Unified Homepage" option (4) in the top-level menu is a simple
            info screen — it shows the configured domain and portal URLs, then
            returns. All configuration happens via top-level option 1 (Domain).

  ── R. GA4 AND CLOUDFLARE TURNSTILE ADDED ────────────────────────────────────

  Planning: not mentioned.
  Reality:  Top-level options 6 and 7:
              6) Google Analytics — enter G-XXXXXXX GA4 measurement ID
              7) Turnstile — enter Cloudflare Turnstile site key + secret
            Both stored in drop_shared.conf. The Turnstile secret is also
            written into each network's grin_drop_<net>.conf so Node.js can
            verify Turnstile tokens server-side. GA4 and Turnstile keys are
            injected into HTML via nginx sub_filter on every request (no
            need to rebuild/redeploy HTML). The CSP header is extended
            automatically to allow the respective third-party domains.

  ── S. ip_salt ADDED FOR ANONYMOUS IP HASHING ────────────────────────────────

  Planning: not mentioned.
  Reality:  drop_ensure_defaults() generates a random 64-char hex ip_salt
            and writes it to conf on first run. Node.js uses it to hash
            IP addresses before storing them — avoids storing raw IPs while
            still enabling per-address rate limiting.

  ── T. PASSPHRASE SECURITY — -p EXPOSURE DOCUMENTED ─────────────────────────

  Planning: passphrase written to wrapper script (never in ps args).
  Reality:  The wrapper script for @reboot and watchdog cron does embed
            `$(cat '$DROP_PASS')` so the passphrase is NOT a literal in the
            wrapper file. However, during interactive start (_drop_start_session),
            the passphrase IS passed as -p literal in the tmux command, exposing
            it in `ps aux` for the lifetime of the grin-wallet process. This is
            documented with inline comments — no alternative exists since
            grin-wallet accepts passphrase only via -p flag.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  10. WHAT MATCHED THE PLAN (key decisions confirmed)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ✓  Four lib files: 052_lib_wallet / _app / _nginx / _admin
  ✓  Two tmux sessions per network (TOR + ownerapi), named drop-<net>-tor
     and drop-<net>-ownerapi — no collision between testnet and mainnet
  ✓  Passphrase read from file in wrapper script (never literal in cron ps)
  ✓  Single nginx vhost, /testnet/ and /mainnet/ path routing
  ✓  Owner API ECDH session pattern (wallet.js: ownerApiSession +
     encryptedOwnerCall), Foreign API plain JSON-RPC
  ✓  @reboot cron + watchdog cron toggles with configurable boot delay
  ✓  MAINNET confirmation guard ("type MAINNET to confirm")
  ✓  AES-256-CBC + PBKDF2 (600k iterations) backup encryption
  ✓  Rate limiting zones in nginx
  ✓  Shared grin system user (grin:grin) with 750 dir / 600 secret perms
  ✓  One entry point script, all functions in sourced lib files
  ✓  testnet and mainnet share the same binary source and web source,
     differentiated only by env vars set in _set_network()
  ✓  SHELL=/bin/bash prefixed on all tmux new-session calls for cron safety
  ✓  No shebang in lib files (sourced, not executed)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  END OF REALIZATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
