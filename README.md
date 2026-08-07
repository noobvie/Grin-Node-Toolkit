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

Clone Grin Explorer Rust integration from https://grincoin.org

Grin tiny explorer https://scan.grin.money

GrinScan block explorer mainnet: https://grinscan.org

GrinScan block explorer testnet: https://test.grinscan.org

Publish API mainnet: https://api.grin.money

Publish API testnet: https://testapi.grin.money

Grin Global Health mainnet: https://world.grin.money

Free Grin Coin Portal: https://drop.grin.money/

Solo Grin Mining Pool: https://solo.grin.money (user/pass disabled for easy viewing)

Public Grin Mining Pool: https://grinium.com/ (in development)

Grin Nostr Relay (Floonet) for Goblin wallet: https://relay.grin.money/

...

---

## Requirements

- **Linux — supported distributions:**
  - Ubuntu **22.04 / 24.04 / 26.04 LTS** — **tested and recommended**
  - Other Debian-based distros (Debian, Mint, Pop!\_OS, Kali, etc.) — best effort, **not fully tested**
  - Rocky Linux / AlmaLinux 10+ (RHEL clones) — runs, but **not fully tested** (use at your own risk)
  - Rocky Linux / AlmaLinux 9 or older — **not supported** (glibc too old); upgrade instructions shown at startup
  - Other systems (Fedora, Arch, etc.) — **not supported, script will exit**
- `bash` 4.0+
- `curl`, `wget`, `jq`, `tar`, `tmux` (installed automatically where possible)
- Root / `sudo` access for system-level operations
- **Free disk space: 10 GB minimum** (pruned mode) — more for full archive or hosting snapshots

> **Ubuntu (22.04–26.04) is the primary tested platform.** The main script checks your OS at startup: unsupported distros exit with a clear message, and older Rocky/Alma versions get upgrade instructions instead of a hard stop. Rocky/AlmaLinux 10+ run but are not fully tested.

---

## Quick Start

> **Need a cheap VPS?** A low-cost SSD/NVMe VPS works great for running a Grin node —
> around **$30/year** is plenty. Browse [LowEndTalk](https://lowendtalk.com) or
> [LowEndBox](https://lowendbox.com) for deals.

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
├── Core
│   ├── 1) Build / Control Grin Node  → 01_build_new_grin_node.sh
│   ├── 2) Manage Nginx Server        → 02_nginx_fileserver_manager.sh
│   └── 3) Share Grin Chain Data      → 03_grin_share_chain_data.sh
│
├── Add-ons
│   ├── 4) Publish Node Services      → 04_grin_node_foreign_api.sh
│   ├── 5) Grin Wallet Services       → 05  hub → 05C, 051, 051x, 053, 059
│   ├── 6) Global Grin Health         → 06  + 06b GrinScan, 06d Tiny Explorer
│   ├── 7) Grin Mining Services       → 07  hub → solo mining, public pool
│   ├── 8) Admin & Maintenance        → 08  hub → 081, 082, 084, 085, 089, 08del
│   └── 9) Grin Connectivity Hub      → 09  hub → 091, 093   (092 reserved)
│
└── 0) Exit
```

> Two levels on purpose. Each hub prints its own sub-menu with live status, and
> **the menu key is not the script number** — keys get reassigned as products are
> added, so a full key-by-key tree here would go stale the moment one moves. What
> the numbers mean is stable; see **Features** below and `docs/generated/`.

---

## Features

### 1. Build/Control Grin Node — `01_build_new_grin_node.sh`

Guided node setup: downloads the official binary (**SHA256-verified**), patches `grin-server.toml`, and bootstraps from a **pre-synced chain snapshot** so you're running in under an hour. Choose mainnet/testnet and full/pruned; pick a download zone (America/Asia/Europe/Africa) from the community registry with per-host freshness checks; stream-extract or full-download with automatic source fallback. Launches in a named `tmux` session.

### 2. Manage Nginx Server — `02_nginx_fileserver_manager.sh`

nginx file server for hosting and distributing chain snapshots. Domain management with Let's Encrypt SSL + HSTS + directory listing, per-IP download-rate caps, fail2ban install + management, and IP/CIDR filtering via ufw/iptables.

### 3. Share Grin Chain Data / Schedule — `03_grin_share_chain_data.sh`

Auto-detects node type/network, verifies sync, and shares snapshots over **nginx** or **SSH**. Per-network cron schedules are staggered so mainnet and testnet never compress at the same time; also `@reboot` node autostart and scheduled txhashset cleanup.

**Contribute your node to the community registry:** once you're sharing chain data over nginx, fork the repo and add your hostname(s) to `extensions/grinmasternodes.json` under the right zone/site-key (`fullmain.` / `prunemain.` / `prunetest.<yourdomain>`), add a `_contacts` entry, and open a PR — `081_host_monitor_port.sh` verifies freshness automatically.

### 4. Publish Grin Node Services — `04_grin_node_foreign_api.sh`

Exposes the node's `/v2/foreign` API (3413 / 13413) over an nginx HTTPS reverse proxy and blocks `/v2/owner` (returns 403) — lets light wallets, block explorers, and tools query your node.

### 5. Grin Wallet Services — `05_grin_wallet_service.sh` (hub) + `051`–`059`

A **hub launcher** showing live status of each self-contained wallet service:
- **051 Fidelius** — the personal web wallet: browser UI (**Node.js**); one process serves many wallets across both networks; nginx + Basic Auth (owner-only), Tor + QR supported.
- **051x Grin XP** — the same Fidelius wallet in an XP-themed shell; **mainnet only**, its own nginx vhost (`web-wallet-xp`). Reachable from hub key `3` or from inside 051.
- **053 WooCommerce Gateway** — WordPress/WooCommerce **PHP plugin** + Node bridge to the wallet Owner API; slatepack invoice flow (buyer pastes response → auto-confirmed).
- **059 Grin Drop** — GRIN giveaway + donation portal (**Node/Express + `node:sqlite`**); rate-limited 3-step slatepack claims and/or a donation address + QR, modes independently toggleable.
- **05C CMD Wallet Quick Setup** — built into the hub: downloads the `grin-wallet` binary, runs `init`/recover, patches the toml and starts a listener (CLI / testing).

> *Planned — each owns a menu key (which prints what the slot is for and installs nothing), but no script file yet.* **052 Accio** is the one product holding a **reserved number**: the public web wallet, client-side **WASM**, keys never leave the browser — freeing 052 for a wallet next to 051 is what the Grin Drop `052 → 059` migration bought, so nothing else may take it (design in [script05_design.md](docs/generated/script05_design.md)). **Payment Pro** (Shopify / custom-API processor) and **GoblinPay** (receive-only merchant till) have **no number** — they get the next free one from `054–058` on the day their build starts.

> **Tip:** run each service on its own server to avoid port/config collisions; each server can run mainnet and testnet at once.

### 6. Global Grin Health — `06_global_grin_health.sh`

A self-hosted network dashboard (Python collector + SQLite + nginx) with two parts:
- **Network Stats + Peer Map** (`stats.yourdomain.com`) — Leaflet world map of all known peers (mainnet/testnet, last IP octet masked), Chart.js history for hashrate/difficulty/tx/fees, and a version-distribution donut. A 5-min cron collector uses smart sampling (per-block 24 h, hourly 30 d, daily full history) to keep the DB under 3 MB.
- **GrinScan** (`grinscan.yourdomain.com`) — self-hosted Express block explorer (ports 3010/3011) that powers [grinscan.org](https://grinscan.org) / [test.grinscan.org](https://test.grinscan.org).

### 7. Grin Mining Services — `07_grin_mining_hub_services.sh` (hub) + solo / public pool

A hub that deploys **one** mining setup per server — solo private *or* a public pool, never both (they collide on stratum port, nginx zones, and the `/opt/grin` layout).

- **Solo PRIVATE (Internet / LAN)** — mines on the node's built-in stratum; block rewards go **straight to your listening wallet** (no pool, no Tor, full coinbase). Internet mode serves a public stats page + SSL; LAN mode is plain HTTP on a private IP. Menu is network-as-parent: wallet, stratum (publish/restrict), watchdogs, encrypted backup, payouts. Stratum **3416 / 13416**.
- **Public pool (GRINIUM)** — full self-hosted **PPLNS** pool: **address-as-identity** (no accounts), **Tor-only auto-payouts**, Node/Express + SQLite, static dashboard + JWT admin. Guided setup chains install → configure → web → nginx+SSL → wallet → service → admin. Deploys as **singlebox** or **hub + regional satellites**. Stratum **3333**. Code in `web/07_mining_pool_public/`.

### 8. Admin & Maintenance — `08_grin_node_admin.sh`

Operations toolbox: **remote node monitor** (registry + custom hosts, emails on state change, cron-ready), **provider access watch** (host-tamper detection + off-box alerts), **node status & sync** (ports, tmux, binary versions + chain tip on one screen), **nginx extended features** (SSL/cert audit, reverse proxy, security, log rotation), **SSH key hardening**, **top bandwidth consumers**, **disk cleanup**, **self-update** with a branch selector, and **backup & restore**. **DEL** runs the full nuclear cleanup (`08del_…`, requires typing `DESTROY`).

Menu keys mirror the sub-script numbers — 081→`1`, 082→`2`, 084→`4`, 085→`5`, 089→`9` — and the un-numbered inline features fill `3`, `6`, `7`, `8`.

### 9. Grin Connectivity Hub — `09_grin_comms_hub.sh` *(in development)*

Deploys the privacy / transport layer shared by wallets and the pool:
- **091 Floonet Relay** — deploys the community Grin-native Nostr relay (`floonet-rs` by [github.com/2ro](https://github.com/2ro)) the toolkit way: hardened systemd + nginx/certbot over `wss` + firewall + encrypted backups. Optional NIP-05 usernames, NIP-42 access control, and GoblinPay monetisation. We deploy upstream's software (not a fork).
- **092 mwixnet CoinSwap Mixer** *(reserved — not built yet)* — run one **mixer hop** in a Grin CoinSwap route ([`mimblewimble/mwixnet`](https://github.com/mimblewimble/mwixnet)). Tor hides *who sent* a transaction while it is in flight; a CoinSwap breaks the **permanent on-chain link** between the coin you spent and the coin that comes out — the one privacy gap Tor cannot close. Non-custodial: a mixer never holds anyone's funds. Only meaningful as an *independent* hop in someone else's route. Design → `docs/generated/script09_design.md` PART D.
- **093 Grin Transporter** — self-hosted **store-and-forward slate queue** (Node + SQLite): the sender enqueues an encrypted slate and the receiver polls later, so the two are never online together — the only transport that's automated *and* offline-tolerant. Optional Tor `.onion` front. Standalone (Phase 1); wallet wiring pending. *(Was 092 until 2026-08-04.)*

---

## File Structure

```
grin-node-toolkit/
├── grin-node-toolkit.sh        # Main menu entry point
├── README.md
├── log/                        # Per-action logs (auto-created)
├── extensions/
│   └── grinmasternodes.json    # Community host registry (zone → site_key → hosts)
├── scripts/                    # One script per feature — 01–04, 06,
│   │                           #   05 wallet hub + 051/051x/053/059,
│   │                           #   07 mining hub + solo/public pool,
│   │                           #   08 admin hub + 081/082/084/085/089/08del,
│   │                           #   09 comms hub + 091/093
│   └── lib/                    # Sourced libs, Python collectors, shared nginx helpers
└── web/                        # App code deployed to /opt/grin/* (Node / PHP / static)
    ├── 04_node_api/  051_fidelius/  053_woocommerce/  059_drop/
    ├── 06_stats_map/  06b_grinscan/  06d_tiny_explorer/
    └── 07_mining_pool_solo/  07_mining_pool_public/  093_transporter/
```

> A planned product gets its number when its build **starts**, not when the idea is written
> down — so there are no placeholder scripts. Two numbers are deliberately **reserved**:
> `052` for Accio (freeing it is what the Grin Drop `052 → 059` move bought) and `092` for the
> mwixnet CoinSwap mixer. `054–058` and `094+` are unallocated.

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
| `/opt/grin/fidelius/config.conf` + `wallets_info.json` | Fidelius settings + wallet registry (`051`) |
| `/opt/grin/drop-{main,test}/grin_drop.conf` | Grin Drop config — domain, modes, claim amount (written/read by `059`) |

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

> **Loopback vs public.** Ports marked *localhost* bind `127.0.0.1` only and are reached
> through the nginx HTTPS / `wss` front-end — they never need a firewall opening, and each can
> be remapped in that service's config if another app on the box already uses the port. (For
> example, the Floonet relay defaults to **8181** specifically to avoid the very common `8080`
> clash with pool/arcade/dev servers.) Only **80/443**, the **P2P** ports (3414 / 13414), and
> any **published** stratum port need to be reachable from the internet.

**Grin node & wallet** (per network)

| Port  | Protocol | Purpose                                                     |
|-------|----------|-------------------------------------------------------------|
| 3413  | HTTP     | Grin mainnet node API V2 (`/v2/foreign` via nginx)          |
| 3414  | P2P      | Grin mainnet peer connections *(public)*                    |
| 3415  | HTTP     | Grin mainnet wallet Foreign API (localhost)                 |
| 3420  | HTTP     | Grin mainnet wallet Owner API (localhost)                   |
| 3416  | TCP      | Grin mainnet stratum mining server (solo private)           |
| 13413 | HTTP     | Grin testnet node API V2 (`/v2/foreign` via nginx)          |
| 13414 | P2P      | Grin testnet peer connections *(public)*                    |
| 13415 | HTTP     | Grin testnet wallet Foreign API (localhost)                 |
| 13420 | HTTP     | Grin testnet wallet Owner API (localhost)                   |
| 13416 | TCP      | Grin testnet stratum mining server (solo private)           |

**Web & wallet services**

| Port  | Protocol | Purpose                                                     |
|-------|----------|-------------------------------------------------------------|
| 3004  | HTTP     | Grin Drop — testnet (Node.js, proxied by nginx)             |
| 3005  | HTTP     | Grin Drop — mainnet (Node.js, proxied by nginx)             |
| 3006  | HTTP     | WooCommerce bridge — mainnet (Node.js, localhost only)      |
| 3007  | HTTP     | WooCommerce bridge — testnet (Node.js, localhost only)      |
| 3010  | HTTP     | GrinScan explorer — testnet (Node.js, proxied by nginx)     |
| 3011  | HTTP     | GrinScan explorer — mainnet (Node.js, proxied by nginx)     |
| 7420  | HTTP     | Fidelius — Node.js (localhost, proxied by nginx)            |
| 8471  | HTTP     | Tiny Explorer (06d, mainnet, localhost, proxied by nginx)   |

**Connectivity Hub (Script 09)**

| Port  | Protocol | Purpose                                                     |
|-------|----------|-------------------------------------------------------------|
| 8181  | HTTP     | Floonet relay (091) — localhost, nginx `wss` front-end; configurable |
| 7456  | HTTP     | Grin Transporter (093) — mainnet (localhost, proxied by nginx) |
| 7466  | HTTP     | Grin Transporter (093) — testnet (localhost, proxied by nginx) |

**Public mining pool (GRINIUM)**

| Port  | Protocol | Purpose                                                     |
|-------|----------|-------------------------------------------------------------|
| 3333  | TCP      | Public pool stratum — miners connect here *(public)*        |
| 3334  | TCP      | Public pool node built-in stratum upstream — mainnet (localhost) |
| 13334 | TCP      | Public pool node built-in stratum upstream — testnet (localhost) |
| 8080  | HTTP     | Public pool central API (localhost, nginx-proxied)          |
| 51820 | UDP      | Public pool WireGuard — hub ↔ gateway federation            |
| 51821 | UDP      | Public pool WireGuard — secondary tunnel                    |

**nginx front-end**

| Port  | Protocol | Purpose                                                     |
|-------|----------|-------------------------------------------------------------|
| 80    | HTTP     | nginx (redirects to HTTPS) *(public)*                       |
| 443   | HTTPS    | nginx file server / proxy *(public)*                        |

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
| 051 — Fidelius           | Both    | `/opt/grin/fidelius/wallet_<net>_<name>/` (per-wallet) |
| 053 — WooCommerce bridge | Mainnet | uses existing node wallet Owner API (port 3420)  |
| 053 — WooCommerce bridge | Testnet | uses existing node wallet Owner API (port 13420) |
| 059 — Grin Drop          | Mainnet | `/opt/grin/drop-main/wallet/`  |
| 059 — Grin Drop          | Testnet | `/opt/grin/drop-test/wallet/`  |

---

## Credits

This toolkit was built with the help of **[Claude Code](https://claude.ai/claude-code)** by Anthropic — an AI coding assistant that helped design, write, and refine the scripts throughout development.

If you find bugs or want to contribute, open an issue or pull request on GitHub.

---

## License

MIT — see [LICENSE](LICENSE). Free to use, modify and redistribute, including
commercially. The software is provided **as is, without warranty of any kind**.

Bundled third-party libraries keep their own licenses: Chart.js and qrcodejs
(MIT), Quill (BSD-3-Clause), and the Twemoji country-flag webfont (font code
MIT, flag artwork [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) by
Twitter, Inc. and other contributors).
