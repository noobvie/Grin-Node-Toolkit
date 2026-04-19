# Grin Node Toolkit

A unified bash toolkit for setting up and managing [Grin](https://grin.mw) cryptocurrency nodes and related infrastructure — all accessible from a single interactive menu.

---

## Why this toolkit exists

I love Grin. It is one of the purest implementations of the MimbleWimble protocol — private, lightweight, and designed to scale. But getting a node up and running has always had a painful bottleneck: **syncing the chain from scratch can take days or even weeks**, depending on your hardware and network.

Making it worse, Grin's current **PIBD (Parallel Initial Block Download)** mechanism has known issues that can cause the sync to stall, loop, or fail silently — leaving newcomers frustrated and giving up before they ever see the node fully running.

This toolkit exists to fix that experience. By downloading a **trusted pre-synced chain snapshot** directly into your node directory, **you can have a fully running Grin node in under one hour** — no waiting, no PIBD headaches. When PIBD is eventually fixed in a future release, the snapshot step becomes optional, but everything else in the toolkit stays useful for new Grinners to build and test Grin quickly without hassles.

This toolkit can turn your Grin node into a community 'master' node — sharing chain_data snapshots and public API.

My goal is simple: **make it easy for anyone to join the Grin network and keep their node alive.**

---
## Demo sites were created by this toolkit semi-automatically:
Archived full node mainnet: https://fullmain.grin.money 

Prune node mainnet: https://prunemain.grin.money

Prune node testnet: https://prunetest.grin.money

Grin explorer (clone of grincoin.org) https://scan.grin.money

Publish API mainnet: https://api.grin.money

Publish API testnet: https://testapi.grin.money

Grin Global Health mainnet: https://world.grin.money

Free Grin Coin Portal: https://drop.grin.money/
...

---

## Requirements

- **Linux — supported distributions:**
  - Ubuntu 22.04 LTS or later — **fully tested and recommended**
  - Rocky Linux 10 or later — **fully tested**
  - AlmaLinux 10 or later — **fully tested**
  - Other Debian-based distros (Debian, Mint, Pop!\_OS, Kali, etc.) — best effort, not guaranteed
  - Rocky Linux / AlmaLinux 9 or older — **not supported** (glibc too old); upgrade instructions shown at startup
  - Other non-Debian systems (RHEL, Fedora, Arch, etc.) — **not supported, script will exit**
- `bash` 4.0+
- `curl`, `wget`, `jq`, `tar`, `tmux` (installed automatically where possible)
- Root / `sudo` access for system-level operations
- **Free disk space: 10 GB minimum** (pruned mode) — more recommended for full archive or hosting snapshots

> The main script checks your OS at startup. Unsupported distros exit immediately with a clear error. Rocky/AlmaLinux older than version 10 receive upgrade instructions instead of a hard stop.

---

## Quick Start

> **Need a cheap VPS?** A low-cost SSD VPS works great for running a Grin node.
> Try searching Google for:
> - `racknerd vps sale` or `racknerd vps blackfriday`
> - `cloudcone vps sale` or `cloudcone vps blackfriday`
> - Browse [LowEndBox](https://lowendbox.com) for deals around **$2/month**

```bash
git clone https://github.com/noobvie/grin-node-toolkit.git
cd grin-node-toolkit
chmod +x grin-node-toolkit.sh scripts/*.sh
sudo ./grin-node-toolkit.sh
```

---

## Disclaimer

> **This toolkit is under active development.**
>
> I strongly recommend running it on a **clean / empty VPS only.**
> Some scripts perform system-level operations (installing packages, changing UTC time, modifying firewall rules, writing to `/etc/nginx`, etc.) that **could affect or delete existing data** on your server.
>
> **Use at your own risk. Do not run on a production server with existing data you cannot afford to lose.**

---

## Menu Structure

```
Grin Node Toolkit
│
├── Core Features
│   ├── 1) Setup Grin New Node           → 01_build_new_grin_node.sh
│   ├── 2) Manage Nginx Server           → 02_nginx_fileserver_manager.sh
│   │   ├── 1) Setup New File Server
│   │   ├── 2) Add Domain
│   │   ├── 3) Remove Domain
│   │   ├── 4) List Domains
│   │   ├── 5) Limit Rate / Bandwidth    (per-IP nginx speed cap)
│   │   ├── 6) Lift Rate / Bandwidth     (remove per-IP speed cap)
│   │   ├── 7) Install fail2ban          (fail2ban + nginx rate limiting)
│   │   ├── 8) Fail2ban Management       (status, unban, list bans)
│   │   ├── 9) IP Filtering              (block/unblock via ufw / iptables)
│   │   └── 0) Exit
│   └── 3) Share Grin Chain Data / Schedule → 03_grin_share_chain_data.sh
│       ├── A) Create Nginx config
│       ├── B) Share chain data via Nginx
│       ├── C) Create SSH config          (optional)
│       ├── D) Share chain data via SSH   (optional)
│       ├── E) Schedule Nginx jobs
│       ├── F) Disable Nginx jobs
│       ├── G) Auto startup Grin node
│       ├── H) Disable auto startup Grin node
│       ├── I) Auto-delete txhashset snapshots  (schedule cleanup cron)
│       └── 0) Back
│
├── Addons
│   ├── 4) Publish Grin Node Services    → 04_grin_node_foreign_api.sh
│   │   ├── 1) Enable Node API via nginx  (mainnet port 3413, /v2/foreign, HTTPS)
│   │   ├── 2) Remove nginx proxy         (mainnet)
│   │   ├── 3) Enable Node API via nginx  (testnet port 13413, /v2/foreign, HTTPS)
│   │   ├── 4) Remove nginx proxy         (testnet)
│   │   └── 0) Back
│   ├── 5) Grin Wallet Services          → 05_grin_wallet_service.sh (hub launcher)
│   │   ├── Status overview              (shows installed / running services per network)
│   │   ├── 1) Private Web Wallet        → 051_grin_private_web_wallet.sh
│   │   │   └── Network → install deps → deploy → nginx → SSL → Basic Auth → firewall → status
│   │   ├── 2) Grin Drop                 → 052_grin_drop.sh
│   │   │   └── Network → wallet setup → listener → install → configure → nginx → start/stop → status
│   │   ├── 3) WooCommerce Gateway       → 053_grin_woocommerce.sh
│   │   │   └── install bridge → install WP plugin → configure → start/stop → status
│   │   ├── 4) Payment Pro               → 054_grin_payment_pro.sh  (coming soon)
│   │   ├── 5) Public Web Wallet         → 055_grin_public_web_wallet.sh  (coming soon)
│   │   └── 0) Back to main menu
│   ├── 6) Global Grin Health            → 06_global_grin_health.sh
│   │   ├── A) Network Stats + Peer Map
│   │   │   ├── A1) Install (Python collector, Chart.js, Leaflet)
│   │   │   ├── A2) Import full history (backfill from genesis)
│   │   │   ├── A3) Start periodic updates (cron every 5 min)
│   │   │   ├── A4) Stop updates
│   │   │   ├── A5) Setup nginx (stats.yourdomain.com)
│   │   │   └── A6) Status
│   │   ├── B) Grin Explorer              (aglkm/grin-explorer — Rust + Rocket)
│   │   │   ├── B1) Install (cargo build --release)
│   │   │   ├── B2) Configure (Explorer.toml)
│   │   │   ├── B3) Start
│   │   │   ├── B4) Stop
│   │   │   ├── B5) Setup nginx (explorer.yourdomain.com)
│   │   │   └── B6) Status
│   │   └── 0) Back
│   ├── 7) Grin Mining Services          → 07_grin_mining_services.sh
│   │   ├── A) Node Status               (running nodes, tmux sessions, binary path)
│   │   ├── H) Mining Status             (ports, miners connected, toml values)
│   │   ├── Mainnet Stratum (port 3416)
│   │   │   ├── B) Setup Stratum         (enable_stratum_server, wallet_listener_url)
│   │   │   ├── C) Configure Stratum     (wallet URL, burn_reward, toggle enable)
│   │   │   ├── D) Publish Stratum       (0.0.0.0:3416 + firewall)
│   │   │   └── E) Restrict Stratum      (revert to 127.0.0.1:3416)
│   │   ├── Testnet Stratum (port 13416)
│   │   │   ├── F) Setup Stratum         (enable_stratum_server, wallet_listener_url)
│   │   │   ├── G) Configure Stratum     (wallet URL, burn_reward, toggle enable)
│   │   │   ├── I) Publish Stratum       (0.0.0.0:13416 + firewall)
│   │   │   └── J) Restrict Stratum      (revert to 127.0.0.1:13416)
│   │   ├── W) Pool Web Interface        → FastAPI pool manager (mainnet :3002 / testnet :3003)
│   │   │   ├── 0) Guided Full Setup     (runs 1→2→3→4→5→6)
│   │   │   ├── 1) Install               (python3, pip, fastapi, uvicorn, systemd)
│   │   │   ├── 2) Configure             (pool name, domain, fee, wallet)
│   │   │   ├── 3) Deploy web files      (→ /var/www/grin-pool/)
│   │   │   ├── 4) Setup nginx           (vhost + SSL + rate limits)
│   │   │   ├── 5) Setup admin account   (create first admin user)
│   │   │   ├── 6) Start / Stop          (systemd grin-pool-manager)
│   │   │   ├── 7) Pool status           (service, DB, recent logs)
│   │   │   ├── B) Backup                (DB + config → /opt/grin/backups/)
│   │   │   ├── C) Cron schedules        (daily backup + weekly VACUUM)
│   │   │   ├── L) View logs
│   │   │   └── DEL) Reset database      (triple-confirm wipe)
│   │   └── 0) Back
│   └── 8) Admin & Maintenance           → 08_grin_node_admin.sh
│       ├── 1) Remote Node Monitor       (081_host_monitor_port.sh — also cron-ready)
│       │   ├── 1) Run check now         (registry hosts first, then custom conf hosts)
│       │   ├── 2) Reconfigure host list
│       │   ├── 3) Show crontab / email setup
│       │   └── 0) Back
│       ├── 2) Service & Port Dashboard
│       ├── 3) Chain Sync Status
│       ├── 4) nginx Config & SSL Audit
│       ├── 5) Firewall Rules Audit
│       ├── 6) Top 20 Bandwidth Consumers
│       ├── 7) Disk Cleanup
│       ├── 8) Self-Update               (git pull from GitHub)
│       ├── DEL) Full Grin Cleanup       (08del_clean_all_grin_things.sh)
│       └── 0) Back
│
└── 0) Exit
```

---

## Features

### 1. Setup Grin New Node — `01_build_new_grin_node.sh`

A guided setup that downloads, verifies, configures, and launches a Grin node — including a pre-synced chain snapshot so your node is operational in under one hour.

- Choose mainnet or testnet, and full archive or pruned mode
- Downloads the official Grin binary, verifies its SHA256, patches `grin-server.toml`
- **Zone selection** — choose America, Asia, Europe, or Africa; hosts are loaded from `extensions/grinmasternodes.json` (a community-maintained registry); auto-falls back to America if the chosen zone has no fresh hosts
- **Per-host freshness filter** — each candidate host passes a 4-gate check: directory reachability → sync-complete status → directory listing (tar filename) → `Last-Modified` age on the `.tar.gz` file; hosts with data older than 5 days are silently skipped
- **Transfer mode choice at download time:**
  - **On-the-fly extraction** — streams the remote archive directly into tar with no local `.tar.gz` saved (`wget -O - <url> | tar -xzvf -`); saves temporary disk space and reduces total setup time; SHA256 verification is skipped
  - **Full download** — downloads `.tar.gz` to disk (supports `-c` resume on interruption), verifies SHA256 checksum, then extracts
- **Auto-fallback** — if a stream or download fails mid-transfer, the script automatically switches to the next available source without user intervention; applies to both transfer modes
- Launches the node in a named `tmux` session; displays elapsed time and session name

### 2. Manage Nginx Server — `02_nginx_fileserver_manager.sh`

Manages an nginx file server for hosting and distributing Grin chain snapshots. Per-action logs are written to `log/nginx-<action>-<datetime>.log`.

**Domain Management (1–4)**
- Setup, Add Domain, Remove Domain, List Domains — full SSL via Let's Encrypt, HSTS, directory listing

**Traffic Control (5–6)**
- **Limit Rate** — per-IP download speed cap via nginx `geo` + `limit_rate`; stored in `/etc/nginx/conf.d/grin_ip_limits.conf`
- **Lift Rate** — remove the cap for a specific IP, or clear all limits; includes option to remove injected `limit_rate` directives from domain configs

**Security (7–9)**
- **Install fail2ban** — installs fail2ban, configures `limit_req_zone` in nginx (20 req/s, burst 30), creates fail2ban jails for nginx auth, rate-limit, and bots
- **Fail2ban Management** — check jail status, unban IPs, list currently banned IPs; each action logged to a timestamped file
- **IP Filtering** — block or unblock IPs and CIDR ranges via ufw or iptables; maintains `/etc/grin-toolkit/blocked_ips.list`

### 3. Share Grin Chain Data / Schedule — `03_grin_share_chain_data.sh`

Automates Grin blockchain backup and sharing so others can bootstrap from your node.

- Auto-detects node type (full/pruned) and network (mainnet/testnet)
- Dual sync-status verification before snapshot; graceful node shutdown/restart
- **A/B) Nginx sharing** — set up nginx config and trigger share immediately
- **C/D) SSH sharing** — optional SSH remote upload
- **E/F) Nginx schedule** — add/remove cron jobs (preset Mon & Thu 00:00 UTC or custom expression)
- **G) Auto startup** — adds a crontab `@reboot sleep N && tmux new-session -d -s SESSION BINARY` entry; detects running binary via port → PID → `/proc/$pid/exe`; configurable boot delay (default 60s mainnet, 120s testnet)
- **H) Disable auto startup** — removes the `@reboot` crontab entries
- **I) Auto-delete txhashset snapshots** — schedules a cron job to purge old snapshot files from the nginx web root, keeping disk usage under control

**Contributing your node to the community registry**

Once your node is publicly sharing chain data via nginx (options A → B → E), you can add it to `extensions/grinmasternodes.json` so other users can download from your server when setting up a new node:

1. Fork the [Grin Node Toolkit repository](https://github.com/noobvie/grin-node-toolkit) on GitHub
2. Open `extensions/grinmasternodes.json` and add your hostname(s) under the correct zone and site key using the standard subdomain format `<site_key>.yourdomain.com`:
   - `fullmain.yourdomain.com` — full archive node, mainnet
   - `prunemain.yourdomain.com` — pruned node, mainnet
   - `prunetest.yourdomain.com` — pruned node, testnet
3. Add a `_contacts` entry keyed by your **base domain** (e.g. `yourdomain.com`) with your owner name and a contact URL
4. Submit a pull request — the toolkit's `081_host_monitor_port.sh` will verify freshness and sync status of your host automatically

### 4. Publish Grin Node Services — `04_grin_node_foreign_api.sh`

**Node Public API (port 3413 / 13413)**
- Exposes `/v2/foreign` only via nginx HTTPS reverse proxy; blocks `/v2/owner` (returns 403)
- Enables light wallets, block explorers, and tools to query your node

### 7. Grin Mining Services — `07_grin_mining_services.sh`

Manages Stratum Mining and the self-hosted Pool Web Interface — all from an alphabet menu (A–J, W).

**Stratum management (per-network — no shared prompts):**
- **A) Node Status** — running node info per network: PID, binary path, tmux session, stratum port state
- **B/F) Setup Stratum** — enables `enable_stratum_server = true`, sets `wallet_listener_url`; B = mainnet, F = testnet
- **C/G) Configure Stratum** — change any toml setting interactively; prompts graceful node restart
- **D/I) Publish Stratum** — patches `grin-server.toml` to `0.0.0.0:PORT`, opens firewall; D = mainnet (3416), I = testnet (13416)
- **E/J) Restrict Stratum** — reverts bind to `127.0.0.1:PORT`, closes firewall port
- **H) Mining Status** — per-network: port listening, connected miners (ESTAB TCP), full toml settings, miner connect URL
- Auto-detects `grin-server.toml` via running process (`/proc/$pid/exe`) or known toolkit directories

**W) Pool Web Interface — FastAPI mining pool manager:**
- Full self-hosted Grin mining pool with share accounting, user dashboards, slatepack withdrawals, and admin panel
- Mainnet (port 3002) and testnet (port 3003) deployed independently with separate DBs, services, and nginx vhosts
- **Share accounting** — monitors stratum log every 10s; maps `username.N` workers to registered users; distributes 60 GRIN per block proportionally
- **Auth** — JWT (1h access + 7d refresh), bcrypt passwords, 5-failed-login → 15min IP lockout
- **Withdrawals** — 3-step slatepack flow identical to the testnet faucet: init_send → user finalizes in wallet → confirmed; 5-min timeout with automatic balance restore
- **Admin panel** — KPI dashboard, live system health (30s refresh), user management, miner overview, manual payment triggers; testnet only: "Inject Balance" for UI testing
- **5 CSS themes** — Matrix (default, canvas rain), Dark (navy), Light (white), Naruto (orange), Japan (pink + CSS sakura petals)
- **Guided setup** — option 0 runs install → configure → deploy → nginx → admin in sequence
- Testnet UI: permanent yellow `⚠ TESTNET` banner, `[TESTNET]` in page title, "Inject Balance" button visible

### 5. Grin Wallet Services — `05_grin_wallet_service.sh` (hub) + `051`–`055`

`05_grin_wallet_service.sh` is a **hub launcher** — it shows the live status of all installed wallet services and dispatches to each sub-script. Each sub-script is fully self-contained with its own wallet binary, config, and systemd service.

> **Tip:** Install each service on its own dedicated server to avoid port conflicts and config collisions. Each server can run both mainnet and testnet simultaneously.

**051 — Private Web Wallet** (`051_grin_private_web_wallet.sh`)
- Personal browser UI for your own wallet — nginx + PHP + Basic Auth (owner-only, not public)
- Mainnet wallet at `/opt/grin/webwallet/mainnet/`, testnet at `/opt/grin/webwallet/testnet/`
- Setup: install deps → deploy web files → configure nginx → SSL → Basic Auth → firewall

**052 — Grin Drop** (`052_grin_drop.sh`)
- Configurable GRIN giveaway + donation portal — Flask + systemd
- **Giveaway mode**: interactive 3-step slatepack claim, rate-limited per address per 24h
- **Donation mode**: shows wallet address + QR code for receiving GRIN
- Both modes are independently toggleable; works on testnet (default) or mainnet
- Testnet service: `grin-drop-test` (port 3004); mainnet: `grin-drop-main` (port 3005)

**053 — WooCommerce Payment Gateway** (`053_grin_woocommerce.sh`)
- Grin payment plugin for WordPress / WooCommerce
- Stateless Flask bridge (`grin-wallet-bridge.py`) on `127.0.0.1:3006` (mainnet) / `3007` (testnet)
- Slatepack invoice flow: buyer copies invoice slate → pastes response → auto-confirmed

**054 — Payment Pro** (`054_grin_payment_pro.sh`) — *coming soon*
- Grin payment processor for Shopify, custom APIs, and other non-WooCommerce platforms

**055 — Public Web Wallet** (`055_grin_public_web_wallet.sh`) — *coming soon*
- Self-custodial, client-side wallet — all crypto runs in the browser via WebAssembly
- Private keys never leave the user's device; `wallet_data` stored in browser IndexedDB (AES-GCM / PBKDF2)
- Server role: nginx static file host only — no keys, no wallet processes, scales to any number of users
- Inspired by [mwcwallet.com](https://mwcwallet.com/) and [MWC-Wallet-Standalone](https://github.com/NicolasFlamel1/MWC-Wallet-Standalone)

### 6. Global Grin Health — `06_global_grin_health.sh`

A self-hosted network monitoring dashboard with two components that share a single install, Python collector, SQLite database, and nginx virtual host.

**A) Network Stats + Peer Map** — served at `stats.yourdomain.com`

*Peer Map page (`index.html` — served at `/`)*
- Leaflet 2D interactive world map with peer markers
- Queries **owner API `get_peers`** for all known peers (100–500+) vs only direct connections
- Mainnet (orange) and testnet (teal) peers shown simultaneously
- Filterable peer list panel: filter by country or node version; click a row to center the map on that peer
- **IP privacy**: last IPv4 octet masked (`1.2.3.x`); last IPv6 group masked
- **Last seen**: peers are persisted in `known_peers` SQLite table for 30 days; JSON includes up to 7 days of history with `last_seen` timestamps
- Country flag emojis via Unicode regional indicator symbols
- Non-standard port shown in tooltip; testnet peers labelled `· testnet`
- Fully responsive — works on mobile browsers

*Network Stats page (`stats.html`)*
- Live stats bar: block height, hashrate (GPS), difficulty, avg block time, peer count
- Chart.js line charts (24h / 30d / All time) for: Hashrate, Difficulty, Transactions/block, Fees/block
- Node version distribution donut chart
- Data collected by a Python cron job every 5 minutes; JSON files served statically
- Smart sampling: every block for last 24 h, hourly for last 30 d, daily for full chain history → SQLite DB under 3 MB
- Fully responsive — works on mobile browsers

*Collector (`06_collector.py`)*
- Modes: `--init-db`, `--init-history` (backfill all 2.1 M blocks), `--update`, `--peers-only`
- Geo-location via ip-api.com batch API (no key required, 100 IPs/request)
- Dual-network: queries mainnet (port 3413) and testnet (port 13413) owner APIs independently
- Atomic JSON writes (`os.replace`) — safe for concurrent browser reads

**B) Grin Explorer** — served at `explorer.yourdomain.com`
- Automates clone + `cargo build --release` of [aglkm/grin-explorer](https://github.com/aglkm/grin-explorer) (Rust + Rocket)
- Configures `Explorer.toml`, manages systemd-style start/stop via `nohup`
- nginx reverse proxy to `127.0.0.1:8000`
- Note: initial build takes 10–30 min and requires ~2 GB disk for Rust toolchain

### 8. Admin & Maintenance — `08_grin_node_admin.sh`

**1 · Remote Node Monitor** (`081_host_monitor_port.sh`)
- Persistent submenu: run check, reconfigure hosts, view crontab setup
- **"Run check now" always starts with the registry scan** — reads `extensions/grinmasternodes.json`, checks every registered host for: HTTP 200 reachability, `.tar.gz` age ≤ 5 days (via `Last-Modified`), and sync-complete status (`check_status_before_download.txt`); stale/down hosts show the owner contact
- Results logged to `grin_master_nodes_status_<datetime>.log`
- Then checks all custom hosts from `/opt/grin/conf/host_monitor_port.conf` via TCP (`nc`); detects state changes; logs to `grin_nodes_status_<datetime>.log`
- Emails on change (or always with `--force`); cron-ready standalone script

**2 · Service & Port Dashboard**
- All 8 Grin ports (open/closed/PID), tmux sessions, running processes, and binary versions extracted from live process paths (not PATH)

**3 · Chain Sync Status**
- Queries `get_tip` JSON-RPC on both mainnet (3413) and testnet (13413); no jq required

**4 · nginx Config & SSL Audit**
- Lists `*grin*` nginx configs (enabled, proxy vs fileserver), SSL certificate expiry with color-coded days remaining

**5 · Firewall Rules Audit**
- UFW / iptables review for all Grin ports; flags wallet ports (3415/13415) as dangerous if exposed; flags bridge ports (3006/3007) as localhost-only

**6 · Top 20 Bandwidth Consumers**
- Parses nginx access logs; shows top IPs by bytes served; block (UFW) or rate-limit (iptables hashlimit) from the results

**7 · Disk Cleanup** — single merged screen:
- Chain data tar archives: delete all / keep newest N / delete older than N days
- Nginx web directories (scanned from nginx config): delete one or all
- OS & logs: `/tmp`, txhashset zips, Grin node logs, system journal, toolkit logs

**8 · Self-Update**
- Repo hardcoded to `noobvie/Grin-Node-Toolkit`; override for forks by saving a slug to `/opt/grin/conf/github_repo.conf`
- **Branch selector**: choose `main` (stable), `addons` (addon development), `corefeatures` (core development), or type any custom branch name — useful for testing in-progress features before they merge to `main`
- Downloads tarball from `github.com/REPO/archive/refs/heads/BRANCH.tar.gz`, extracts, and overwrites toolkit files in-place
- Works whether installed via `git clone` or zip download

**DEL · Full Grin Cleanup** (`08del_clean_all_grin_things.sh`)
- Requires typing `DESTROY`; then confirms each of 6 steps individually:
  stop processes → delete nginx web roots → remove nginx configs → remove binaries → delete `$HOME/.grin/` → delete toolkit logs

---

## File Structure

```
grin-node-toolkit/
├── grin-node-toolkit.sh                  # Main menu entry point
├── README.md
├── log/                                  # Per-action logs (auto-created)
│   ├── nginx-<action>-<datetime>.log
│   ├── grin_nodes_status_<datetime>.log          # Node monitor results
│   ├── grin_full_cleanup_<datetime>.log          # Full cleanup audit trail
│   └── non_debian_upgrade_instructions.log       # Rocky/Alma upgrade steps (if applicable)
├── extensions/
│   └── grinmasternodes.json              # Community host registry (zone → site_key → hostnames)
├── scripts/
│   ├── 01_build_new_grin_node.sh         # Feature 1 : node installation
│   ├── 02_nginx_fileserver_manager.sh    # Feature 2 : nginx management
│   ├── 03_grin_share_chain_data.sh       # Feature 3 : chain data sharing + schedule
│   ├── 04_grin_node_foreign_api.sh       # Feature 4 : node services (Node API)
│   ├── 05_grin_wallet_service.sh         # Feature 5 : wallet services hub launcher
│   ├── 051_grin_private_web_wallet.sh    # Feature 5a: personal browser wallet UI
│   ├── 052_grin_drop.sh                  # Feature 5b: GRIN giveaway + donation portal
│   ├── 053_grin_woocommerce.sh           # Feature 5c: WooCommerce payment gateway
│   ├── 054_grin_payment_pro.sh           # Feature 5d: payment pro (coming soon)
│   ├── 055_grin_public_web_wallet.sh     # Feature 5e: public WASM wallet (coming soon)
│   ├── 06_global_grin_health.sh          # Feature 6 : Global Grin Health menu
│   ├── 06_collector.py                   # Feature 6 : Python stats + peer collector
│   ├── 07_grin_mining_services.sh        # Feature 7 : stratum mining services
│   ├── 08_grin_node_admin.sh             # Addon  8 : admin & maintenance menu
│   ├── 081_host_monitor_port.sh          # Remote node port monitor (standalone / cron)
│   └── 08del_clean_all_grin_things.sh    # Full Grin removal (nuclear cleanup)
└── web/
    ├── 04_node_api/
    │   ├── public_html/                  # Feature 4 : Node API status page assets
    │   ├── rest-collector.py             # REST API JSON collector
    │   └── node-collector.py             # Node data collector
    ├── 051_wallet/                       # Feature 5a: Private Web Wallet
    │   ├── public_html/                  # PHP proxy + JS + CSS (deployed to /var/www/web-wallet-{main,test}/)
    │   └── nginx.conf.template           # nginx vhost template
    ├── 052_drop/                         # Feature 5b: Grin Drop (giveaway + donation)
    │   ├── app/                          # Flask backend (deployed to /opt/grin/drop-{main,test}/)
    │   │   ├── app_drop.py               # Flask routes + activity logger
    │   │   ├── db_drop.py                # SQLite schema + helpers
    │   │   ├── wallet_drop.py            # grin-wallet CLI integration
    │   │   ├── config_drop.py            # Reads /opt/grin/drop-{net}/grin_drop.conf
    │   │   └── requirements.txt
    │   └── public_html/                  # Static frontend (deployed to /var/www/grin-drop-{main,test}/)
    │       ├── index.html                # 3-step claim form + donation section
    │       ├── css/                      # Base styles + CSS variables + themes
    │       └── js/                       # drop.js · theme.js · matrix.js
    ├── 053_woocommerce/                  # Feature 5c: WooCommerce payment gateway
    │   ├── bridge/                       # Flask bridge (deployed to /opt/grin/woo-{main,test}/)
    │   │   ├── grin-wallet-bridge.py     # Stateless Flask bridge (127.0.0.1:3006/3007)
    │   │   └── requirements.txt
    │   └── wp-plugin/                    # WordPress plugin (copy to wp-content/plugins/)
    ├── 054_payment_pro/                  # Feature 5d: Payment Pro (coming soon)
    └── 055_public_wallet/               # Feature 5e: Public WASM Wallet (coming soon)
        └── public_html/                  # Static HTML/JS/CSS/WASM (deployed to /var/www/grin-public-wallet/)
            ├── index.html
            ├── css/
            └── js/                       # grin-wallet-wasm.js · grin-wallet-wasm.wasm · wallet-ui.js
    ├── 06_stats_map/
    │   └── stats/                        # Feature 6 : Network stats + peer map assets
    │       ├── index.html                # Peer Map (Leaflet 2D map)
    │       ├── stats.html                # Network Stats dashboard (Chart.js)
    │       └── chart.min.js              # Chart.js bundle (copy before deploy)
    └── 07_pool/                          # Feature 7 : Pool Web Interface
        ├── pool-manager/                 # FastAPI backend (deployed to /opt/grin/pool/<net>/)
        │   ├── main.py                   # All API routes (public + auth + user + admin)
        │   ├── database.py               # SQLAlchemy models (aiosqlite)
        │   ├── auth.py                   # JWT + bcrypt + brute-force lockout
        │   ├── monitor.py                # Stratum log parser + share tracker
        │   ├── rewards.py                # Block reward distribution (60 GRIN proportional)
        │   ├── wallet.py                 # grin-wallet CLI slatepack send/finalize
        │   ├── scheduler.py              # APScheduler background jobs
        │   ├── config.py                 # Reads /opt/grin/conf/grin_pool[_testnet].json
        │   └── requirements.txt
        └── public_html/                  # Static frontend (deployed to /var/www/grin-pool/)
            ├── index.html                # Public homepage (stats + mining setup)
            ├── login.html                # Login + Register tabs
            ├── dashboard.html            # User stats + hashrate charts
            ├── withdraw.html             # 3-step slatepack withdrawal
            ├── admin/                    # Admin pages (index, health, users, miners, payments)
            ├── css/pool.css              # Base styles + CSS variables
            ├── css/themes/               # matrix · dark · light · naruto · japan
            └── js/                       # api.js · theme.js · charts.js · withdraw.js · matrix.js
```

**Runtime config created on first run** (stored outside the toolkit, under `/opt/grin/conf/`):

| File | Purpose |
|------|---------|
| `/opt/grin/conf/grin_instances_location.conf` | Node install paths (written by `01`, read by `03`/`04`/`08`) |
| `/opt/grin/conf/grin_share_nginx.conf` | Nginx share settings (written/read by `03`) |
| `/opt/grin/conf/grin_share_ssh.conf` | SSH share settings (written/read by `03`) |
| `/opt/grin/conf/grin_pool.json` | Pool manager mainnet config (written/read by `07` W menu) |
| `/opt/grin/conf/grin_pool_testnet.json` | Pool manager testnet config (written/read by `07` W menu) |
| `/opt/grin/conf/host_monitor_port.conf` | Custom hosts for node monitor (`081`) |
| `/opt/grin/conf/host_monitor_last_state.conf` | Last-known port state for change detection (`081`) |
| `/opt/grin/conf/mass_deploy.conf` | Fleet server list for mass deployment (`081`) |
| `/opt/grin/conf/github_repo.conf` | GitHub repo slug override for self-update (optional) |
| `/opt/grin/webwallet/{mainnet,testnet}/config.conf` | Private web wallet settings (written/read by `051`) |
| `/opt/grin/drop-{main,test}/grin_drop.conf` | Grin Drop config — domain, modes, claim amount (written/read by `052`) |

**Runtime paths created by option 6 install:**

| Path | Purpose |
|------|---------|
| `/var/lib/grin-stats/stats.db` | SQLite database (blocks, peers, versions) |
| `/var/lib/grin-stats/config.env` | Collector config (node URLs, API secret paths) |
| `/var/www/grin-stats/` | Nginx web root (HTML + JSON data files) |
| `/usr/local/bin/grin-stats-collector` | Installed collector script |
| `/opt/grin-explorer/` | Grin Explorer build directory (option B) |

---

## Port Reference

| Port  | Protocol | Purpose                                                     |
|-------|----------|-------------------------------------------------------------|
| 3413  | HTTP     | Grin mainnet node API V2 (`/v2/foreign` via nginx)          |
| 3414  | P2P      | Grin mainnet peer connections                               |
| 3415  | HTTP     | Grin mainnet wallet Foreign API                             |
| 3416  | TCP      | Grin mainnet stratum mining server                          |
| 13413 | HTTP     | Grin testnet node API V2 (`/v2/foreign` via nginx)          |
| 13414 | P2P      | Grin testnet peer connections                               |
| 13415 | HTTP     | Grin testnet wallet Foreign API                             |
| 13416 | TCP      | Grin testnet stratum mining server                          |
| 3002  | HTTP     | Pool manager — mainnet (FastAPI, proxied by nginx)          |
| 3003  | HTTP     | Pool manager — testnet (FastAPI, proxied by nginx)          |
| 3004  | HTTP     | Grin Drop — testnet (Flask, proxied by nginx)               |
| 3005  | HTTP     | Grin Drop — mainnet (Flask, proxied by nginx)               |
| 3006  | HTTP     | WooCommerce wallet bridge — mainnet (Flask, localhost only) |
| 3007  | HTTP     | WooCommerce wallet bridge — testnet (Flask, localhost only) |
| 80    | HTTP     | nginx (redirects to HTTPS)                                  |
| 443   | HTTPS    | nginx file server / proxy                                   |

---

## Grin Node Directories

The setup script creates a dedicated directory per node based on its type:

| Network | Mode   | Directory                          |
|---------|--------|------------------------------------|
| Mainnet | Full   | `/opt/grin/node/mainnet-full`      |
| Mainnet | Pruned | `/opt/grin/node/mainnet-prune`     |
| Testnet | Pruned | `/opt/grin/node/testnet-prune`     |

> Full archive mode on testnet is blocked — testnet chain data is too large for a practical full archive setup.

Each wallet service sub-script manages its own wallet in an isolated directory:

| Script | Network | Wallet directory                        |
|--------|---------|-----------------------------------------|
| 051 — Private Web Wallet | Mainnet | `/opt/grin/webwallet/mainnet/` |
| 051 — Private Web Wallet | Testnet | `/opt/grin/webwallet/testnet/` |
| 052 — Grin Drop          | Mainnet | `/opt/grin/drop-main/wallet/`  |
| 052 — Grin Drop          | Testnet | `/opt/grin/drop-test/wallet/`  |
| 053 — WooCommerce bridge | Mainnet | uses existing node wallet (port 3415)   |
| 053 — WooCommerce bridge | Testnet | uses existing node wallet (port 13415)  |

---

## Credits

This toolkit was built with the help of **[Claude Code](https://claude.ai/claude-code)** by Anthropic — an AI coding assistant that helped design, write, and refine the scripts throughout development.

If you find bugs or want to contribute, open an issue or pull request on GitHub.

---

## License

MIT
