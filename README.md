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

GrinScan block explorer mainnet: https://grinscan.org

GrinScan block explorer testnet: https://test.grinscan.org

Publish API mainnet: https://api.grin.money

Publish API testnet: https://testapi.grin.money

Grin Global Health mainnet: https://world.grin.money

Free Grin Coin Portal: https://drop.grin.money/

Solo Grin Mining Pool: https://solo.grin.money (user/pass disabled for easy viewing)
...

---

## Requirements

- **Linux — supported distributions:**
  - Ubuntu 22.04 LTS or later — **fully tested and recommended**
  - Other Debian-based distros (Debian, Mint, Pop!\_OS, Kali, etc.) — best effort, **not fully tested**
  - Rocky Linux / AlmaLinux 10+ (RHEL clones) — **experimental, may not work** (not fully tested; use at your own risk)
  - Rocky Linux / AlmaLinux 9 or older — **not supported** (glibc too old); upgrade instructions shown at startup
  - Other systems (Fedora, Arch, etc.) — **not supported, script will exit**
- `bash` 4.0+
- `curl`, `wget`, `jq`, `tar`, `tmux` (installed automatically where possible)
- Root / `sudo` access for system-level operations
- **Free disk space: 10 GB minimum** (pruned mode) — more recommended for full archive or hosting snapshots

> **Ubuntu is the only fully tested platform.** The main script checks your OS at startup. Unsupported distros exit immediately with a clear error. Rocky/AlmaLinux 10+ may run but are experimental and not fully tested; older Rocky/Alma versions receive upgrade instructions instead of a hard stop.

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
│   │   ├── N) Install Nginx + Certbot + Whois
│   │   ├── A) Network Stats + Peer Map   (stats.yourdomain.com — Python collector → Chart.js + Leaflet)
│   │   │   ├── 1) Install (collector, Chart.js, Leaflet)
│   │   │   ├── 2) Import data (backfill 180d / 90d / full history)
│   │   │   ├── 3) Start periodic updates (cron every 5 min)
│   │   │   ├── 4) Stop updates / 5) Setup nginx / 6) Status
│   │   │   └── Collector tasks a–k (init DB, backfill, incremental,
│   │   │       peers geolocation, inflation data: USD M2 + Gold)
│   │   ├── B) GrinScan — Lightweight Block Explorer  (Node.js, ports 3010/3011)
│   │   │   ├── 1) Install        (Node.js + systemd grinscan-{test,main})
│   │   │   ├── 2) Configure      (config.json per net, copies node secrets)
│   │   │   ├── 3) Service control (start / stop / restart)
│   │   │   ├── 5) Setup nginx    (grinscan.yourdomain.com + SSL)
│   │   │   └── Logs / Status
│   │   └── 0) Back
│   ├── 7) Grin Mining Services          → 07_grin_mining_hub_services.sh  (pick ONE per server)
│   │   ├── 1) Solo PRIVATE — Internet   → 07_grin_mining_solo.sh        (stats page on a domain + SSL)
│   │   ├── 2) Solo PRIVATE — LAN        → 07_grin_mining_solo.sh lan    (plain HTTP on a LAN IP, no domain/SSL)
│   │   │   └── Solo menu (both modes):  A) Node check · 1/2) Configure Mainnet/Testnet
│   │   │       │   └── per-net branch:  1) Wallet · 2) Stratum (setup/configure/publish/restrict) · 3) Terminal stats
│   │   │       3) Deploy stats web page · 4) Status · 5) Watchdogs · 6) Maintenance (backup)
│   │   │       7) Payouts & settlement  · C) Clean up · 0) Back
│   │   │       (stratum: 3416 mainnet / 13416 testnet; publish = 0.0.0.0:PORT + firewall)
│   │   └── 3) Public mining pool        → 07_grin_mining_public_pool.sh  (GRINIUM — PPLNS, Tor pay)
│   │       ├── G) Guided full setup     (1→2→3→4→5→6→7 in sequence)
│   │       ├── 1) Install · 2) Configure · 3) Deploy web · 4) Nginx+SSL · 5) Wallet listeners
│   │       ├── 6) Service control · 7) Create admin · 8) Pool status
│   │       ├── B) Backup · C) Cron · L) Logs · S) Edit config · DEL) Reset DB
│   │       └── Z) Cleanup (mode-selector) · 0) Exit   (modes: singlebox / hub / satellite)
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

### 7. Grin Mining Services — `07_grin_mining_hub_services.sh` (hub) + solo / public pool

A hub that deploys **one** mining setup per server — solo private *or* a public pool, never both (they collide on the stratum port, nginx zones, and the `/opt/grin` layout, so the hub hard-blocks a second type). Three options:

#### 1) Solo PRIVATE — Internet · 2) Solo PRIVATE — LAN — `07_grin_mining_solo.sh`

Both run the **same solo product** on the node's built-in stratum; they differ only in how the stats dashboard is served. The LAN variant launches as `07_grin_mining_solo.sh lan` (`SOLO_NET_MODE=lan`):

| | Stats dashboard | Best for |
|---|---|---|
| **Internet** | Public domain + Let's Encrypt SSL (certbot); optional HTTP Basic-Auth lock; off-box reachability pills | A pool reachable over the internet |
| **LAN** | Plain HTTP bound to a chosen private IP:port — no domain, no certbot, no auth | A trusted internal / home network |

> **Solo mining pays block rewards directly to your listening wallet** (via `wallet_listener_url`) — no Tor, no pool, no third party. You keep the full coinbase of every block you find.

The solo menu is **network-as-parent** (pick a network once, no repeated prompts):
- **A) Node check** · **1/2) Configure Mainnet/Testnet** → per-net branch: **Wallet** (setup/recover, listener, address), **Stratum** (setup, configure wallet address / `burn_reward` / timeout, publish, restrict), **Terminal stats** (live dashboard, 10s refresh)
- **3) Deploy stats web page** (both networks side by side; Internet or LAN per launch mode) · **4) Node, Wallet & Mining Status** · **5) Watchdogs** (node-sync, boot autostart, wallet, stratum) · **6) Maintenance** (encrypted backup / restore / schedule / seed) · **7) Payouts & settlement** · **C) Clean up**
- Stratum binds **3416** (mainnet) / **13416** (testnet); *publish* patches `grin-server.toml` to `0.0.0.0:PORT` + opens the firewall, *restrict* reverts to `127.0.0.1:PORT`. The toml is auto-detected via the running process (`/proc/$pid/exe`) or known toolkit directories.

#### 3) Public mining pool (GRINIUM) — `07_grin_mining_public_pool.sh`

A full self-hosted **PPLNS** pool: **address-as-identity** (miners submit `grin_address.worker` as the stratum user — no accounts), **Tor-only auto-payouts**, Node.js/Express + SQLite backend, a static dashboard, and a JWT-protected admin panel. **G) Guided Full Setup** runs install → configure → deploy web → nginx+SSL → wallet listeners → service → create admin in sequence; individual steps and Backup/Cron/Logs/Reset are also available. Deploys as a **singlebox**, or split into a central **hub** + regional **satellites**. Ports: public stratum **3333**, node built-in stratum upstream **127.0.0.1:3334**, central API **8080** (nginx-proxied). App code in `web/07_mining_pool_public/`.

### 5. Grin Wallet Services — `05_grin_wallet_service.sh` (hub) + `051`–`055`

`05_grin_wallet_service.sh` is a **hub launcher** — it shows the live status of all installed wallet services and dispatches to each sub-script. Each sub-script is fully self-contained with its own wallet binary, config, and systemd service.

> **Tip:** Install each service on its own dedicated server to avoid port conflicts and config collisions. Each server can run both mainnet and testnet simultaneously.

**051 — Private Web Wallet** (`051_grin_private_web_wallet.sh`)
- Personal browser UI for your own wallet — **Node.js** (ported from GrinSuite) + nginx + Basic Auth (owner-only, not public)
- **One Node.js process serves many wallets across both networks** — app at `/opt/grin/webwallet/app/`, single shared `grin-wallet` binary, per-wallet dirs `/opt/grin/webwallet/wallet_<net>_<name>/`, registry `wallets_info.json`
- nginx reverse-proxies `127.0.0.1:7420`; Tor + qrencode supported
- Setup: install deps (nodejs, nginx, certbot, htpasswd, tor, qrencode) → deploy files + systemd → nginx → SSL → Basic Auth → firewall

**052 — Grin Drop** (`052_grin_drop.sh`)
- Configurable GRIN giveaway + donation portal — **Node.js/Express + SQLite (`node:sqlite`)** + systemd
- **Giveaway mode**: interactive 3-step slatepack claim, rate-limited per address per 24h
- **Donation mode**: shows wallet address + QR code for receiving GRIN
- Both modes are independently toggleable; works on testnet (default) or mainnet
- Testnet service: `grin-drop-test` (port 3004, `/opt/grin/drop-test/`); mainnet: `grin-drop-main` (port 3005, `/opt/grin/drop-main/`)

**053 — WooCommerce Payment Gateway** (`053_grin_woocommerce.sh`)
- Grin payment plugin for WordPress / WooCommerce — **PHP plugin** + **Node.js/Express bridge** (`server.js`)
- Bridge proxies the PHP plugin to the local grin-wallet **Owner API** (3420 mainnet / 13420 testnet); listens on `127.0.0.1:3006` (mainnet) / `3007` (testnet), config in `/opt/grin/woocommerce/{mainnet,testnet}/`
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

*Collector (`scripts/lib/06_collector.py`)*
- Backfills and incrementally updates blocks, peers, and inflation-comparison data into SQLite; geo-locates peers via ip-api.com
- Queries mainnet (3413) and testnet (13413) owner APIs independently
- Companion collectors in `scripts/lib/`: `06_price_collector.py`, `06_ecosystem_checker.py`, `06_node_submit_server.py`

**B) GrinScan — Lightweight Block Explorer** (Node.js) — served at `grinscan.yourdomain.com`
- Self-hosted Express block explorer (`web/06b_grinscan/`) — powers [grinscan.org](https://grinscan.org) / [test.grinscan.org](https://test.grinscan.org)
- Testnet on port `3010`, mainnet on `3011`; systemd `grinscan-{test,main}`
- Configure writes `config.json` per network and copies node API secrets into `/opt/grin/grinscan/{test,main}/`

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
│   ├── 07_grin_mining_hub_services.sh    # Feature 7 : mining hub (solo XOR public pool)
│   ├── 07_grin_mining_solo.sh            #   solo private mining (Internet + LAN modes)
│   ├── 07_grin_mining_public_pool.sh     #   GRINIUM public PPLNS pool (singlebox/hub/satellite)
│   ├── 08_grin_node_admin.sh             # Addon  8 : admin & maintenance menu
│   ├── 081_host_monitor_port.sh          # Remote node port monitor (standalone / cron)
│   ├── 08del_clean_all_grin_things.sh    # Full Grin removal (nuclear cleanup)
│   └── lib/                              # Sourced libs + collectors + data files
│       ├── 06_collector.py               # Stats + peer collector (Python)
│       ├── 06_price_collector.py         # GRIN price collector
│       ├── 06_ecosystem_checker.py       # Ecosystem site checker
│       ├── 06_node_submit_server.py      # Community node submission server
│       ├── 06b_grinscan.sh               # GrinScan install/configure helpers
│       ├── 052_lib_*.sh                  # Grin Drop libs (app, wallet, nginx, admin)
│       ├── 07_lib_hub.sh / 07_lib_satellite.sh   # Public pool hub + satellite libs
│       ├── 07_solo_*.sh                  # Solo mining libs (wallet, backup)
│       ├── 07_mining_block_collector.py  # Solo mining stats collector (log → JSON)
│       └── nginx_shared_helpers.sh       # Shared nginx rate-limit zone helpers
└── web/
    ├── 04_node_api/                      # Feature 4 : Node API status page + collectors
    ├── 051_wallet/                       # Feature 5a: Private Web Wallet (Node.js)
    │   ├── server.js · package.json      #   → deployed to /opt/grin/webwallet/app/
    │   └── client/                       #   browser UI (index.html, app.js, css, svg)
    ├── 052_drop/                         # Feature 5b: Grin Drop (Node.js/Express)
    │   ├── server/                       #   app.js · db.js · wallet.js · config.js (→ /opt/grin/drop-{main,test}/)
    │   └── public_html/                  #   static frontend (claim + donation)
    ├── 053_woocommerce/                  # Feature 5c: WooCommerce gateway
    │   ├── bridge/                       #   server.js Node/Express bridge (→ /opt/grin/woocommerce/{mainnet,testnet}/)
    │   └── plugin/                       #   PHP WordPress/WooCommerce plugin
    ├── 06_stats_map/stats/               # Feature 6 : Network stats + peer map (index.html, stats.html)
    ├── 06b_grinscan/                     # Feature 6 : GrinScan explorer (server.js + public/)
    ├── 07_mining_pool_solo/              # Feature 7 : solo stats page (index.html, setup page)
    └── 07_mining_pool_public/            # Feature 7 : GRINIUM pool (back-end-pool/ + public_html/)
```

> Scripts 054 (Payment Pro) and 055 (Public WASM Wallet) are placeholders — no web files yet.

**Runtime config created on first run** (stored outside the toolkit, under `/opt/grin/conf/`):

| File | Purpose |
|------|---------|
| `/opt/grin/conf/grin_instances_location.conf` | Node install paths (written by `01`, read by `03`/`04`/`08`) |
| `/opt/grin/conf/grin_share_nginx.conf` | Nginx share settings (written/read by `03`) |
| `/opt/grin/conf/grin_share_ssh.conf` | SSH share settings (written/read by `03`) |
| `/opt/grin/conf/host_monitor_port.conf` | Custom hosts for node monitor (`081`) |
| `/opt/grin/conf/host_monitor_last_state.conf` | Last-known port state for change detection (`081`) |
| `/opt/grin/conf/mass_deploy.conf` | Fleet server list for mass deployment (`081`) |
| `/opt/grin/conf/github_repo.conf` | GitHub repo slug override for self-update (optional) |
| `/opt/grin/webwallet/config.conf` + `wallets_info.json` | Private web wallet settings + wallet registry (`051`) |
| `/opt/grin/drop-{main,test}/grin_drop.conf` | Grin Drop config — domain, modes, claim amount (written/read by `052`) |

**Runtime paths created by option 6 install:**

| Path | Purpose |
|------|---------|
| `/var/lib/grin-stats/stats.db` | SQLite database (blocks, peers, versions) |
| `/var/lib/grin-stats/config.env` | Collector config (node URLs, API secret paths) |
| `/var/www/grin-stats/` | Nginx web root (HTML + JSON data files) |
| `/usr/local/bin/grin-stats-collector` | Installed collector script |
| `/opt/grin/grinscan/{test,main}/` | GrinScan config + copied node API secrets (option B) |

---

## Port Reference

| Port  | Protocol | Purpose                                                     |
|-------|----------|-------------------------------------------------------------|
| 3413  | HTTP     | Grin mainnet node API V2 (`/v2/foreign` via nginx)          |
| 3414  | P2P      | Grin mainnet peer connections                               |
| 3415  | HTTP     | Grin mainnet wallet Foreign API                             |
| 3416  | TCP      | Grin mainnet stratum mining server (solo private)           |
| 13413 | HTTP     | Grin testnet node API V2 (`/v2/foreign` via nginx)          |
| 13414 | P2P      | Grin testnet peer connections                               |
| 13415 | HTTP     | Grin testnet wallet Foreign API                             |
| 13416 | TCP      | Grin testnet stratum mining server (solo private)           |
| 3004  | HTTP     | Grin Drop — testnet (Node.js, proxied by nginx)             |
| 3005  | HTTP     | Grin Drop — mainnet (Node.js, proxied by nginx)             |
| 3006  | HTTP     | WooCommerce bridge — mainnet (Node.js, localhost only)      |
| 3007  | HTTP     | WooCommerce bridge — testnet (Node.js, localhost only)      |
| 3010  | HTTP     | GrinScan explorer — testnet (Node.js, proxied by nginx)     |
| 3011  | HTTP     | GrinScan explorer — mainnet (Node.js, proxied by nginx)     |
| 3333  | TCP      | Public pool (GRINIUM) stratum — miners connect here         |
| 3334  | TCP      | Public pool node built-in stratum upstream (localhost only) |
| 8080  | HTTP     | Public pool central API (localhost, nginx-proxied)          |
| 7420  | HTTP     | Private Web Wallet — Node.js (localhost, proxied by nginx)  |
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
| 051 — Private Web Wallet | Both    | `/opt/grin/webwallet/wallet_<net>_<name>/` (per-wallet) |
| 052 — Grin Drop          | Mainnet | `/opt/grin/drop-main/wallet/`  |
| 052 — Grin Drop          | Testnet | `/opt/grin/drop-test/wallet/`  |
| 053 — WooCommerce bridge | Mainnet | uses existing node wallet Owner API (port 3420)  |
| 053 — WooCommerce bridge | Testnet | uses existing node wallet Owner API (port 13420) |

---

## Credits

This toolkit was built with the help of **[Claude Code](https://claude.ai/claude-code)** by Anthropic — an AI coding assistant that helped design, write, and refine the scripts throughout development.

If you find bugs or want to contribute, open an issue or pull request on GitHub.

---

## License

MIT
