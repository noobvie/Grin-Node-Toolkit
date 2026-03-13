# Grin Node Toolkit — Claude Context

Unified bash toolkit for managing Grin cryptocurrency nodes.
Automates setup, chain sharing, monitoring, wallet, mining, and admin.
Entry point: `grin-node-toolkit.sh` → launches sub-scripts from `scripts/`.

## Scripts

| #   | File                            | Role |
|-----|---------------------------------|------|
| 01  | `01_build_new_grin_node.sh`     | Download binary, verify SHA256, extract chain snapshot, launch in tmux |
| 02  | `02_nginx_fileserver_manager.sh`| Nginx file server for chain data; SSL via Let's Encrypt |
| 03  | `03_grin_share_chain_data.sh`   | Backup/share chain data; cron scheduling; nginx + SSH modes |
| 04  | `04_grin_node_foreign_api.sh`   | Publish node Foreign API via nginx reverse proxy |
| 05  | `05_grin_wallet_service.sh`     | Download, init, and manage grin-wallet; nginx proxy for web wallet |
| 06  | `06_global_grin_health.sh`      | Network health dashboard (peer map, stats) |
| 06b | `06_collector.py`               | SQLite stats collector (Python 3); peer/block data for dashboard |
| 07  | `07_grin_mining_services.sh`    | Stratum mining server setup and monitoring |
| 08  | `08_grin_node_admin.sh`         | Admin menu: SSL audit, disk cleanup, sync check, self-update |
| 081 | `081_host_monitor_port.sh`      | Remote node TCP monitor; standalone or cron; registry freshness check |

## OS Support

| Distro | Support |
|--------|---------|
| Ubuntu 22.04+ | ✓ Fully supported |
| Rocky Linux 10+ | ✓ Fully supported |
| AlmaLinux 10+ | ✓ Fully supported |
| Other Debian-based | ~ Best effort |
| Rocky/AlmaLinux ≤9 | ✗ glibc < 2.38; shows upgrade instructions, returns to menu |
| RHEL, Fedora, Arch, etc. | ✗ Hard exit |

- Package managers: `apt-get` (Debian/Ubuntu) and `dnf` (Rocky/AlmaLinux 10+)
- `tor` on RHEL-family requires EPEL: install `epel-release` before `tor`

## Bash Conventions

- All scripts use `set -euo pipefail`
- **Critical:** `grep` returns exit 1 on no match. Any `var=$(... | grep ...)` must end
  with `|| true`, or the script exits silently with no error message.
- Colors defined per-script, auto-stripped when not a tty:
  `RED GREEN YELLOW CYAN BOLD DIM RESET`
- Standard helpers: `info()` `success()` `warn()` `error()` `die()`
- Runtime configs go in `conf/` (auto-created); logs go in `log/` (timestamped filenames)
- Scripts are standalone — they do not source each other; shared state is via `conf/` files

## Port Reference

| Port  | Network | Service |
|-------|---------|---------|
| 3413  | mainnet | Node Foreign API |
| 3414  | mainnet | P2P |
| 3415  | all     | Wallet Foreign API (localhost only) |
| 3416  | mainnet | Stratum mining |
| 13413 | testnet | Node Foreign API |
| 13414 | testnet | P2P |
| 13416 | testnet | Stratum mining |
| 80/443| all     | nginx (HTTP → HTTPS) |

## Node Directories (on target server)

`/grinfullmain` · `/grinprunemain` · `/grinprunetest`

## Git Branches

`main` (stable) · `addons` · `corefeatures`
