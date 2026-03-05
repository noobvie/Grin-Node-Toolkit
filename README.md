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

## Requirements

- **Linux — Debian-based only**
  - Ubuntu 22.04 LTS or later — **fully tested and recommended**
  - Other Debian-based distros (Debian, Mint, Pop!\_OS, Kali, etc.) — best effort, not guaranteed
  - Non-Debian systems (RHEL, Fedora, AlmaLinux, Arch, etc.) — **not supported, script will exit**
- `bash` 4.0+
- `curl`, `wget`, `jq`, `tar`, `tmux` (installed automatically where possible)
- Root / `sudo` access for system-level operations
- **Free disk space: 10 GB minimum** (pruned mode) — more recommended for full archive or hosting snapshots

> The main script checks your OS at startup and will immediately exit with a clear error if a non-Debian distribution is detected.

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
> Some scripts perform system-level operations (installing packages, modifying firewall rules, writing to `/etc/nginx`, etc.) that **could affect or delete existing data** on your server.
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
│   ├── 3) Share Grin Chain Data / Schedule → 03_grin_share_chain_data.sh
│   │   ├── A) Create Nginx config
│   │   ├── B) Share chain data via Nginx
│   │   ├── C) Create SSH config          (optional)
│   │   ├── D) Share chain data via SSH   (optional)
│   │   ├── E) Schedule Nginx jobs
│   │   ├── F) Disable Nginx jobs
│   │   ├── G) Auto startup Grin node
│   │   ├── H) Disable auto startup Grin node
│   │   └── 0) Back
│   └── 4) Publish Grin Node Services    → 04_grin_node_foreign_api.sh
│       ├── 1) Enable Node API via nginx  (mainnet port 3413, /v2/foreign, HTTPS)
│       ├── 2) Remove nginx proxy         (mainnet)
│       ├── 3) Enable Node API via nginx  (testnet port 13413, /v2/foreign, HTTPS)
│       ├── 4) Remove nginx proxy         (testnet)
│       ├── 5) Expose stratum             (mainnet port 3416, patch .toml + restart)
│       ├── 6) Restrict stratum           (mainnet, revert to localhost)
│       ├── 7) Expose stratum             (testnet port 13416, patch .toml + restart)
│       ├── 8) Restrict stratum           (testnet, revert to localhost)
│       └── 0) Back
│
├── Addons
│   ├── 5) Grin Wallet Service           → 05_grin_wallet_service.sh
│   │   ├── 1) Download & install grin-wallet  (choose mainnet → /grinwalletmain | testnet → /grinwallettest)
│   │   ├── 2) Initialize wallet               (grin-wallet init — runs in tmux for password prompt)
│   │   ├── 3) Start wallet listener           (grin-wallet listen, tmux)
│   │   ├── 4) Enable Wallet Foreign API       (port 3415)
│   │   ├── 5) Disable Wallet Foreign API
│   │   ├── 6) Configure nginx proxy           (wallet)
│   │   ├── 7) Configure firewall rules        (port 3415)
│   │   └── 0) Back
│   ├── 6) Global Grin Health            → 06_global_grin_health.sh
│   │   ├── A) Network Stats + Peer Map
│   │   │   ├── A1) Install (Python collector, Chart.js, Globe.GL)
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
│   ├── 7) Coming Soon
│   └── 8) Admin & Maintenance           → 08_grin_node_admin.sh
│       ├── 1) Remote Node Monitor       (081_host_monitor_port.sh — also cron-ready)
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
- Downloads a community chain snapshot (3 sources, random order), verifies checksum, checks disk space, extracts
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

### 4. Publish Grin Node Services — `04_grin_node_foreign_api.sh`

**Node Public API (port 3413 / 13413)**
- Exposes `/v2/foreign` only via nginx HTTPS reverse proxy; blocks `/v2/owner` (returns 403)
- Enables light wallets, block explorers, and tools to query your node

**Stratum Mining (port 3416 / 13416)**
- Patches `stratum_server_addr` in `grin-server.toml` from `127.0.0.1` → `0.0.0.0`
- Configures firewall rules; performs graceful node stop + restart

### 5. Grin Wallet Service — `05_grin_wallet_service.sh`

- **Download & init** — installs `grin-wallet` binary to `/grinwalletmain` or `/grinwallettest`; runs `grin-wallet init` in tmux (proper TTY for password prompt); auto-patches `check_node_api_http_addr` in `grin-wallet.toml`
- **Listen** — starts `grin-wallet listen` in a named tmux session; auto-detects running node
- **Publish** — toggles `owner_api_include_foreign`, configures firewall (port 3415), optional nginx reverse proxy with SSL

### 6. Global Grin Health — `06_global_grin_health.sh`

A self-hosted network monitoring dashboard with two components that share a single install, Python collector, SQLite database, and nginx virtual host.

**A) Network Stats + Peer Map** — served at `stats.yourdomain.com`

*Network Stats page (`index.html`)*
- Live stats bar: block height, hashrate (GPS), difficulty, avg block time, peer count
- Chart.js line charts (24h / 30d / All time) for: Hashrate, Difficulty, Transactions/block, Fees/block
- Node version distribution donut chart
- Data collected by a Python cron job every 5 minutes; JSON files served statically
- Smart sampling: every block for last 24 h, hourly for last 30 d, daily for full chain history → SQLite DB under 3 MB
- Fully responsive — works on mobile browsers

*Peer Map page (`map.html`)*
- Globe.GL 3D interactive world globe, night-side Earth texture, auto-rotate
- Queries **owner API `get_peers`** for all known peers (100–500+) vs only direct connections
- Mainnet (orange) and testnet (teal) peers shown simultaneously
- Filterable peer list panel: filter by country or node version; click a row to fly the globe to that peer
- **IP privacy**: last IPv4 octet masked (`1.2.3.x`); last IPv6 group masked
- **Last seen**: peers are persisted in `known_peers` SQLite table for 30 days; JSON includes up to 7 days of history with `last_seen` timestamps
- Country flag emojis via Unicode regional indicator symbols
- Non-standard port shown in tooltip; testnet peers labelled `· testnet`
- Fully responsive — bottom action bar on mobile to toggle peer list / network snapshot

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
- Checks all configured hosts via `nc` (TCP); detects state changes; logs every run
- Emails on change (or always with `--force`); cron-ready standalone script

**2 · Service & Port Dashboard**
- All 8 Grin ports (open/closed/PID), tmux sessions, running processes, and binary versions extracted from live process paths (not PATH)

**3 · Chain Sync Status**
- Queries `get_tip` JSON-RPC on both mainnet (3413) and testnet (13413); no jq required

**4 · nginx Config & SSL Audit**
- Lists `*grin*` nginx configs (enabled, proxy vs fileserver), SSL certificate expiry with color-coded days remaining

**5 · Firewall Rules Audit**
- UFW / iptables review for all 8 Grin ports; flags wallet ports (3415/13415) as dangerous if exposed

**6 · Top 20 Bandwidth Consumers**
- Parses nginx access logs; shows top IPs by bytes served; block (UFW) or rate-limit (iptables hashlimit) from the results

**7 · Disk Cleanup** — single merged screen:
- Chain data tar archives: delete all / keep newest N / delete older than N days
- Nginx web directories (scanned from nginx config): delete one or all
- OS & logs: `/tmp`, txhashset zips, Grin node logs, system journal, toolkit logs

**8 · Self-Update**
- Repo hardcoded to `noobvie/Grin-Node-Toolkit`; override for forks by saving a slug to `conf/github_repo.conf`
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
├── conf/                                 # Runtime config (auto-created)
│   ├── host_monitor_port.conf            # Hosts for option 1 (node monitor)
│   ├── host_monitor_last_state.conf      # Last-known port status (change detection)
│   └── github_repo.conf                  # GitHub repo slug for self-update (option 8)
├── log/                                  # Per-action logs (auto-created)
│   ├── nginx-<action>-<datetime>.log
│   ├── grin_nodes_status_<datetime>.log  # Node monitor results
│   └── grin_full_cleanup_<datetime>.log  # Full cleanup audit trail
├── scripts/
│   ├── 01_build_new_grin_node.sh         # Feature 1 : node installation
│   ├── 02_nginx_fileserver_manager.sh    # Feature 2 : nginx management
│   ├── 03_grin_share_chain_data.sh       # Feature 3 : chain data sharing + schedule
│   ├── 04_grin_node_foreign_api.sh       # Feature 4 : node services (API + stratum)
│   ├── 05_grin_wallet_service.sh         # Feature 5 : wallet service
│   ├── 06_global_grin_health.sh          # Feature 6 : Global Grin Health menu
│   ├── 06_collector.py                   # Feature 6 : Python stats + peer collector
│   ├── 07_coming_soon.sh                 # Placeholder
│   ├── 08_grin_node_admin.sh             # Addon  8 : admin & maintenance menu
│   ├── 081_host_monitor_port.sh          # Remote node port monitor (standalone / cron)
│   └── 08del_clean_all_grin_things.sh    # Full Grin removal (nuclear cleanup)
└── web/
    └── 06/
        └── stats/                        # Feature 6 static web assets
            ├── index.html                # Network Stats dashboard (Chart.js)
            ├── map.html                  # Peer Map (Globe.GL 3D globe)
            ├── chart.min.js              # Chart.js bundle (copy before deploy)
            └── globe.min.js              # Globe.GL bundle (copy before deploy)
```

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

| Port  | Protocol | Purpose                                           |
|-------|----------|---------------------------------------------------|
| 3413  | HTTP     | Grin mainnet API V2 (`/v2/foreign` via nginx)     |
| 3414  | P2P      | Grin mainnet peer connections                     |
| 3415  | HTTP     | Grin wallet Foreign API                           |
| 3416  | TCP      | Grin mainnet stratum mining server                |
| 13413 | HTTP     | Grin testnet API V2 (`/v2/foreign` via nginx)     |
| 13414 | P2P      | Grin testnet peer connections                     |
| 13416 | TCP      | Grin testnet stratum mining server                |
| 80    | HTTP     | nginx (redirects to HTTPS)                        |
| 443   | HTTPS    | nginx file server / proxy                         |

---

## Grin Node Directories

The setup script creates a dedicated directory per node based on its type:

| Network | Mode   | Directory        |
|---------|--------|------------------|
| Mainnet | Full   | `/grinfullmain`  |
| Mainnet | Pruned | `/grinprunemain` |
| Testnet | Pruned | `/grinprunetest` |

> Full archive mode on testnet is blocked — testnet chain data is too large for a practical full archive setup.

The wallet service uses separate directories per network:

| Network | Directory          | Wallet config                           |
|---------|--------------------|-----------------------------------------|
| Mainnet | `/grinwalletmain`  | `/grinwalletmain/grin-wallet.toml`      |
| Testnet | `/grinwallettest`  | `/grinwallettest/grin-wallet.toml`      |

---

## Credits

This toolkit was built with the help of **[Claude Code](https://claude.ai/claude-code)** by Anthropic — an AI coding assistant that helped design, write, and refine the scripts throughout development.

If you find bugs or want to contribute, open an issue or pull request on GitHub.

---

## License

MIT
