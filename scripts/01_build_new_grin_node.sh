#!/bin/bash
################################################################################
# Script 01 — Build a New Grin Node
# Part of: Grin Node Toolkit  (https://github.com/noobvie/grin-node-toolkit)
################################################################################
#
# PURPOSE
#   Fully automated, end-to-end setup of a new Grin cryptocurrency node.
#   Installs the latest official Grin binary, generates and patches the node
#   config, downloads pre-synced chain data from a trusted source, verifies its
#   integrity, checks disk space, extracts the archive, and starts the node
#   inside a tmux session — all in a single run.
#
# PREREQUISITES
#   • Must be run as root  (sudo)
#   • OS version check is handled by the master script (grin-node-toolkit.sh)
#   • Internet access  (GitHub API + chain data hosts)
#   • Required packages (auto-installed if missing):
#       Debian/Ubuntu : tar  openssl  libncurses5 (or libncurses6)  tmux  jq  tor  curl  wget  sqlite3  rsync  cron
#       Rocky / Alma  : tar  openssl  ncurses-compat-libs  tmux  jq  tor  curl  wget  sqlite  rsync  cronie
#       (sqlite3 CLI — used by backup/restore for consistent online DB snapshots;
#        rsync + cron/cronie — used by Script 03 SSH share and schedules)
#
# MENU  (lib/01_lib_menu.sh — one screen in every state, status first)
#   The script opens on the node status block (what is installed, running, in
#   which tmux session, which version, and whether the instances conf matches
#   disk), then fixed keys, in three groups:
#     A Super Auto (wipe all, rebuild both pruned)
#     1 Start a node    2 Stop a node     3 Update Grin binary (mainnet / testnet / both)
#     4 Rebuild a node  (chain_data only, or full reinstall of that network)
#     5 Install a node  (a network with no node yet)
#     G Compile Grin binary from source / roll back old Grin version
#     0 Back
#   A key that cannot act now is shown dim with its reason. Every action touches
#   only the network it names, then returns to the menu with a fresh scan. The
#   setup pipeline below is what keys 5, 4 (full reinstall) and A run.
#
# NETWORK & ARCHIVE MODES
#   Networks  : Mainnet  |  Testnet  |  Both (mainnet first, then testnet)
#   Archives  : Pruned (default, smaller)  |  Full (mainnet only, full UTXO history)
#   Note: Full archive mode is NOT available for testnet.
#
# NODE DIRECTORIES  (standardised — there is no custom-path prompt)
#   /opt/grin/node/mainnet-prune  — pruned,       mainnet
#   /opt/grin/node/mainnet-full   — full archive, mainnet
#   /opt/grin/node/testnet-prune  — pruned,       testnet
#   The resolved path is saved to:
#     /opt/grin/conf/grin_instances_location.conf  (used by other toolkit scripts)
#
# SETUP PIPELINE  (up to 14 steps; Steps 10–12 replaced by a single stream step
#                  when on-the-fly extraction is chosen at Step 9)
#   Step  1 — Process & Port Check  (the menu's node scan, lib/01_lib_node_table.sh)
#              Finds the installed nodes, which of them run (a grin process of
#              the node dir, including one still booting), their tmux session
#              (grin's gtmux socket or root's), and any non-grin process holding
#              the P2P ports 3414 / 13414. Read-only; nothing is killed here.
#              Key 5 and Super Auto first check for a legacy $HOME/.grin
#              directory — offers D) Delete (recommended) or Enter to keep
#              (may cause config conflicts).
#
#   Step  2 — System Update & Dependency Check
#              Runs apt-get update && upgrade (Debian/Ubuntu) or dnf update
#              (Rocky Linux / AlmaLinux 10+) automatically — no prompt.
#              Then installs any missing required packages. OS version check
#              is handled upstream by the master script.
#
#   Step  3 — Network Selection
#              User chooses: 1) Mainnet  2) Testnet  3) Both — only networks with
#              no node yet are offered (one free network: that one alone).
#              When "Both" is selected, steps 4–14 run for mainnet, then repeat
#              for testnet automatically. Each network gets its own node
#              directory (/opt/grin/node/mainnet-prune, /opt/grin/node/testnet-prune) with its own binary.
#
#   Step  4 — Archive Mode Selection  (once per network)
#              User chooses: 1) Pruned  2) Full archive (mainnet only)
#
#   Step  5 — Prepare Node Directory
#              No path prompt: GRIN_DIR is the standardised location for the
#              chosen network+mode (see NODE DIRECTORIES above). Switching
#              mainnet full↔pruned removes the other variant's directory so no
#              orphan is left behind. A disk-space check runs on a fresh install
#              and is skipped for a chain_data rebuild and Super Auto
#              (GRIN_SKIP_DISK_CHECK=1). Any existing files in GRIN_DIR
#              are then cleared automatically — no confirmation prompt — so the
#              directory is clean for the binary and chain data that follow.
#
#   Step  6 — Download Grin Binary
#              Queries the GitHub API for the latest release and downloads the
#              linux-x86_64 tar.gz asset, then installs the 'grin' binary into
#              the node directory. When building both networks, the binary is
#              downloaded from GitHub once and copied into each node directory
#              separately — no second download needed.
#              A binary compiled from source (menu key G, option 3) is
#              reused here instead of the release download.
#
#   Step  7 — Generate grin-server.toml
#              Mainnet: './grin server config'
#              Testnet: './grin --testnet server config'
#              The --testnet flag produces the correct chain_type and testnet
#              ports (13413/13414/13415/13416) automatically — no port patching
#              needed. HOME is overridden to the node directory so grin writes
#              its output under our custom path instead of /root.
#              Any pre-existing config is backed up with a timestamp suffix.
#              No fallback minimal config — only the grin-generated file is used.
#
#   Step  8 — Patch grin-server.toml
#              Applies user choices and enforces absolute paths:
#                archive_mode         → true (full) or false (pruned)
#                db_root              → <node_dir>/chain_data
#                log_file_path        → <node_dir>/grin-server.log
#                api_secret_path      → <node_dir>/.api_secret
#                foreign_api_secret_path → <node_dir>/.foreign_api_secret
#              Also sets peer limits (stratum is left to Script 07).
#
#   Step  8b — API Secret Files (persistent key vault)
#              Ensures .api_secret and .foreign_api_secret exist in the node
#              directory, sourced from /opt/grin/keys/<network>/ so they
#              SURVIVE a rebuild (a rotating secret silently 401s every
#              consumer — Script 04's nginx header, GrinScan, the collector).
#              Vault hit → restore; miss → adopt the existing file, else mint
#              a 20-char random alphanumeric key and seed the vault with it.
#              New files get permissions 600 and ownership grin:grin; an
#              existing file is rewritten in place so a product's own
#              ownership (e.g. Script 04's root:www-data 640) survives.
#              Deliberate rotation: grin-secret-sync --rotate <net>
#
#   Step  8c — Create grin Service User
#              Creates the 'grin' system user (no login shell, no home dir
#              created) if it does not already exist, then sets grin:grin
#              ownership recursively on /opt/grin so the node runs as the
#              service account and can initialise ~/.grin/ on first start.
#              Idempotent — safe on already-provisioned systems.
#
#   Step  9 — Chain Data Source & Transfer Mode
#              First the user chooses a transfer mode:
#                1) On-the-fly — pipes remote tar.gz straight into tar; no
#                   .tar.gz stored locally; auto-switches source on failure;
#                   skips Steps 10 & 11.  cmd: wget -O - <url> | tar -xzf -
#                2) Full download — saves .tar.gz to disk (wget -c, resumable),
#                   auto-switches source on failure; continues to Steps 10–12.
#                3) Slow sync — no archive at all; the node is started with an
#                   empty chain_data/ and syncs from genesis via its P2P peers
#                   (grin default). Returns immediately — skips zone/host
#                   discovery AND Steps 10–12 entirely. Useful when no archive
#                   source is fresh/reachable. Slowest (hours to days).
#              For modes 1 & 2 only: user then selects a download zone
#              (America / Asia / Europe / Africa). Host list is loaded from
#              extensions/grinmasternodes.json. Each host is checked by
#              _check_and_add_host — chaindata.json manifest first, else the
#              legacy probes (directory freshness, sync-status file, listing,
#              tar type, tar Last-Modified). The age limit is per artefact,
#              not one constant: 5 days for a pruned snapshot, 70 for the full
#              archive (see _max_age_for_site_key).
#              Hosts passing all checks are added as fallback sources.
#              If selected zone has no fresh hosts, auto-falls back to America.
#              If America also fails, prompts for a custom base URL or 0 to return.
#
#   Step 10 — SHA256 Checksum Verification  [full-download mode only]
#              Runs 'sha256sum -c' against the downloaded .sha256 file.
#              Exits immediately on mismatch — never extracts a corrupt archive.
#              [In on-the-fly mode this step is replaced by the stream step.]
#
#   Step 11 — Disk Space Check  [full-download mode only]
#              Requires at least  tar_size × 1.2  free on / before extracting.
#              Shows archive size, required space, and available space.
#
#   Step 12 — Extract Chain Data  [full-download mode only]
#              Extracts the tar.gz into the node directory. Prompts to remove
#              an existing chain_data directory before extraction if found.
#              Deletes .tar.gz and .sha256 after successful extraction to
#              reclaim disk space.
#
#   Step 13 — Start Node in Tmux
#              Creates a named tmux session (e.g. grin_pruned_mainnet) and runs
#              './grin server run' inside it — grin-owned, on the grin user's
#              tmux socket (view via gtmux). Kills any pre-existing session with
#              the same name on BOTH tmux servers first, and sweeps leftover
#              grin processes for the dir (lock-file protection). The window
#              stays open after grin exits so the user can read any output.
#                Attach : gtmux attach -t <session>   (plain 'tmux' won't see it)
#                Detach : Ctrl+B, then D
#
#   Step 14 — Summary
#              Prints network, mode, directory, tmux session name, total time
#              taken, and log file path.
#
#   Step 14b — Re-sync API secrets to installed services
#              Re-points every installed consumer (collector, GrinScan, Tiny
#              Explorer, wallets, Script 04 nginx, pool stratum) at the node
#              just built, and installs the grin-secret-sync 5-min self-heal
#              timer. The vault (Step 8b) keeps the secret VALUES stable; this
#              fixes the secret PATH, which moves on a prune↔full rebuild.
#
#   Step 14c — Reboot autostart (custom wizard; Super Auto applies it unasked)
#              Offers the network's tagged @reboot crontab line, default yes.
#              Accepting replaces any existing line, so it also re-points one
#              a prune↔full rebuild left on the old dir.
#
#   Step 14d — Node event recorder (custom wizard, once per run, default yes)
#
# LOG FILE
#   Each run creates a timestamped log file:
#     /opt/grin/logs/01_build_new_grin_node_YYYYMMDD_HHMMSS.log
#   (one file per run; log-line timestamps are UTC — the filename uses the
#    server's local time)
#
################################################################################

set -euo pipefail

# --- Script metadata ---
SCRIPT_START_TIME=$(date +%s)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="/opt/grin/logs"
LOG_FILE="$LOG_DIR/01_build_new_grin_node_$(date +%Y%m%d_%H%M%S).log"
CONF_DIR="/opt/grin/conf"
INSTANCES_CONF="$CONF_DIR/grin_instances_location.conf"
GRIN_GITHUB_API="https://api.github.com/repos/mimblewimble/grin/releases/latest"
# Gap between starting one node and the next when both networks live on the same
# box. grin v5.5 boot is heavy (chain/MMR load pegs CPU+disk for minutes), so two
# nodes booting together starve each other on a small VPS. Same value the reboot
# autostart uses for testnet (gnk_autostart_enable: mainnet 5 s, testnet 1000 s).
# Override for one run with: GRIN_STAGGER_SECS=120 ./01_build_new_grin_node.sh
# (0 = no gap). Sanitised HERE, not just at the point of use: a non-numeric value
# would blow up the `$(( … / 60 ))` estimate below under `set -u` and kill the
# script — and a typo'd override must not silently mean "no gap at all".
GRIN_STAGGER_SECS="${GRIN_STAGGER_SECS:-1000}"
[[ "$GRIN_STAGGER_SECS" =~ ^[0-9]+$ ]] || GRIN_STAGGER_SECS=1000
# Shared node primitives (canonical _grin_session_name, etc.). Source-guarded,
# no side effects; defines info/warn/error fallbacks only if absent.
source "$SCRIPT_DIR/lib/grin_node_control.sh"
# Keepalive/watchdog policy layer (reboot autostart + node-sync watchdog).
# Source-guarded, no side effects; provides gnk_autostart_enable / gnk_watchdog_install
# used by Super Auto's post-build hardening.
source "$SCRIPT_DIR/lib/grin_node_keepalive.sh"
# Node event recorder (script086_design.md §8): read-only down/up ledger + evidence at
# the moment of failure. Source-guarded, no side effects; provides gne_install,
# used by Super Auto's hardening and the post-build offer (_offer_event_recorder).
source "$SCRIPT_DIR/lib/grin_node_events.sh"
# Persistent API-secret vault (/opt/grin/keys) + consumer self-heal. Provides
# grin_secret_vault_ensure (Step 8b) and grin_secrets_sync_all (post-build), so a
# rebuild keeps the node's api/foreign secrets instead of rotating them and
# silently 401-ing every consumer. Source-guarded, no side effects.
source "$SCRIPT_DIR/lib/grin_node_secrets.sh"
# Source-build path (menu key G): compile the node binary from a git
# branch/tag when upstream has a fix on 'staging' but no release tarball yet.
# Provides gsb_menu. Source-guarded, no side effects.
source "$SCRIPT_DIR/lib/01_lib_source_build.sh"
# Script libs (menu, wizard, node ops, node table, chain data, launch). Order matters only
# in that every lib is sourced before main() runs.
source "$SCRIPT_DIR/lib/01_lib_node_ops.sh"
source "$SCRIPT_DIR/lib/01_lib_super_auto.sh"
source "$SCRIPT_DIR/lib/01_lib_menu.sh"
source "$SCRIPT_DIR/lib/01_lib_wizard.sh"
source "$SCRIPT_DIR/lib/01_lib_node_config.sh"
source "$SCRIPT_DIR/lib/01_lib_chain_data.sh"
source "$SCRIPT_DIR/lib/01_lib_node_launch.sh"
source "$SCRIPT_DIR/lib/01_lib_node_table.sh"

# --- Session state ---
# The wizard globals (NETWORK_TYPE, GRIN_DIR, STREAM_MODE, SUPER_AUTO, GRIN_BIN_TMP, …) are initialised and re-initialised
# by s01_reset_state (lib/01_lib_menu.sh): here once, then before every menu pass.
s01_reset_state

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# =============================================================================
# Logging
# =============================================================================
mkdir -p "$LOG_DIR"
log()     { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE"; }
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; log "[INFO] $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; log "[OK] $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; log "[WARN] $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; log "[ERROR] $*"; }
die() {
    echo ""
    echo -e "${RED}${BOLD}╔══════════════════════════════════════════════════╗${RESET}"
    echo -e "${RED}${BOLD}║  SCRIPT ERROR — Action required                  ║${RESET}"
    echo -e "${RED}${BOLD}╚══════════════════════════════════════════════════╝${RESET}"
    echo -e "${RED}[ERROR]${RESET} $*"
    echo ""
    echo -e "${YELLOW}▶ Fix the issue above, then choose:${RESET}"
    echo -e "  ${GREEN}Enter${RESET} — retry from the beginning"
    echo -e "  ${RED}0${RESET}     — return to the main menu"
    echo -e "  ${DIM}Log: $LOG_FILE${RESET}"
    echo ""
    log "[FATAL] $*"
    local _die_choice
    echo -ne "${DIM}[Enter = retry  /  0 = main menu]: ${RESET}"
    read -r _die_choice || true
    if [[ "${_die_choice:-}" == "0" ]]; then
        exit 0
    else
        exec "$0"
    fi
}

step_header() { echo ""; echo -e "${BOLD}${DIM}━━━ $* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"; }

# =============================================================================
# Main
# =============================================================================
main() {
    log "=== Grin Node Build Started ==="

    # Early root check — the node scan (ss -tlnp) needs root to read PIDs.
    # Without root, port scans silently return empty and every node reads as stopped.
    if [[ $EUID -ne 0 ]]; then die "This script must be run as root (sudo)."; fi

    # Concurrent-run guard — two parallel script-01 instances can corrupt
    # $INSTANCES_CONF or partially overwrite a node directory.
    # fd 9 stays open for the life of the process; flock releases on exit.
    #
    # IMPORTANT: never write `exec 9>FILE 2>/dev/null` here. A bare `exec` with no
    # command applies its redirections to the shell PERMANENTLY — the `2>/dev/null`
    # would silence the whole script's stderr for the rest of the run, swallowing the
    # wget download progress bar (and every other stderr message) in later steps.
    # Instead, pick a writable lock path first (stderr suppression scoped to a subshell
    # so it cannot leak), then open fd 9 with stderr left intact.
    LOCK_FILE=/var/run/grin-toolkit-01.lock
    ( : >>"$LOCK_FILE" ) 2>/dev/null || LOCK_FILE=/tmp/grin-toolkit-01.lock
    exec 9>"$LOCK_FILE"
    if ! flock -n 9; then
        die "Another instance of script 01 is already running. Wait for it to finish, or remove the lock file if you are sure no other instance exists."
    fi

    # The menu (lib/01_lib_menu.sh) is the whole script: it returns only on key 0.
    s01_menu_loop || true
    return 0
}

# _grin_session_name() is defined in lib/grin_node_control.sh (sourced near top).

main "$@"
