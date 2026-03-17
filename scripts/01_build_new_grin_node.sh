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
#       Debian/Ubuntu : tar  openssl  libncurses5 (or libncurses6)  tmux  jq  tor  curl  wget
#       Rocky / Alma  : tar  openssl  ncurses-compat-libs  tmux  jq  tor  curl  wget
#
# NETWORK & ARCHIVE MODES
#   Networks  : Mainnet  |  Testnet  |  Both (mainnet first, then testnet)
#   Archives  : Pruned (default, smaller)  |  Full (mainnet only, full UTXO history)
#   Note: Full archive mode is NOT available for testnet.
#
# NODE DIRECTORIES  (default paths — user may choose a custom location at Step 5)
#   /opt/grin/node/mainnet-prune  — pruned,       mainnet  (default)
#   /opt/grin/node/mainnet-full   — full archive, mainnet  (default)
#   /opt/grin/node/testnet-prune  — pruned,       testnet  (default)
#   The chosen path (default or custom) is saved to:
#     /opt/grin/conf/grin_instances_location.conf  (used by other toolkit scripts)
#
# SETUP PIPELINE  (up to 14 steps; Steps 10–12 replaced by a single stream step
#                  when on-the-fly extraction is chosen at Step 9)
#   Step  1 — Process & Port Check
#              Scans for running 'grin' processes (excluding the toolkit's own
#              scripts) and occupied ports (3413 API, 3414 P2P mainnet,
#              13414 P2P testnet, 3415 wallet).
#              Prompts to kill conflicts before continuing.
#              Also detects legacy $HOME/.grin directory — offers D) Delete
#              (recommended) or Enter to keep (may cause config conflicts).
#
#   Step  2 — System Update & Dependency Check
#              Runs apt-get update && upgrade (Debian/Ubuntu) or dnf update
#              (Rocky Linux / AlmaLinux 10+) automatically — no prompt.
#              Then installs any missing required packages. OS version check
#              is handled upstream by the master script.
#
#   Step  3 — Network Selection
#              User chooses: 1) Mainnet  2) Testnet  3) Both
#              When "Both" is selected, steps 4–14 run for mainnet, then repeat
#              for testnet automatically. Each network gets its own node
#              directory (/opt/grin/node/mainnet-prune, /opt/grin/node/testnet-prune) with its own binary.
#
#   Step  4 — Archive Mode Selection  (once per network)
#              User chooses: 1) Pruned  2) Full archive (mainnet only)
#
#   Step  5 — Create Node Directory
#              User enters a path (default or custom). After each entry, shows
#              disk space for the chosen location and, if the directory already
#              exists, lists its contents (up to 20 items). A bold red warning
#              is shown when files are present: all will be permanently removed
#              before downloading begins. User must confirm [Y/n/0] before the
#              path is accepted. On confirmation, all existing files are wiped
#              immediately so the directory is clean for the binary and chain
#              data that follow.
#
#   Step  6 — Download Grin Binary
#              Queries the GitHub API for the latest release and downloads the
#              linux-x86_64 tar.gz asset, then installs the 'grin' binary into
#              the node directory. When building both networks, the binary is
#              downloaded from GitHub once and copied into each node directory
#              separately — no second download needed.
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
#              Also sets peer limits and enables stratum server.
#
#   Step  8b — Generate API Secret Files
#              Creates .api_secret and .foreign_api_secret in the node
#              directory with a 20-character random alphanumeric key.
#              Sets permissions 600 and ownership grin:grin.
#
#   Step  8c — Create grin Service User
#              Creates the 'grin' system user (no login shell, no home dir
#              created) if it does not already exist, then sets grin:grin
#              ownership recursively on /opt/grin so the node runs as the
#              service account and can initialise ~/.grin/ on first start.
#              Idempotent — safe on already-provisioned systems.
#
#   Step  9 — Chain Data Source & Transfer Mode
#              User selects a download zone (America / Asia / Europe / Africa).
#              Host list is loaded from extensions/grinmasternodes.json.
#              Each host is checked in order:
#                1) sync-status via check_status_before_download.txt
#                2) directory listing fetched to discover tar/sha filenames
#                3) Last-Modified header checked — files older than 5 days skipped
#              Hosts passing all checks are added as fallback sources.
#              If selected zone has no fresh hosts, auto-falls back to America.
#              If America also fails, prompts for a custom base URL or 0 to return.
#              User then chooses transfer mode:
#                1) On-the-fly — pipes remote tar.gz straight into tar; no
#                   .tar.gz stored locally; auto-switches source on failure;
#                   skips Steps 10 & 11.  cmd: wget -O - <url> | tar -xzvf -
#                2) Full download — saves .tar.gz to disk (wget -c, resumable),
#                   auto-switches source on failure; continues to Steps 10–12.
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
#              './grin server run' inside it. Kills any pre-existing session with
#              the same name first. The window stays open after grin exits so
#              the user can read any output.
#                Attach : tmux attach -t <session>
#                Detach : Ctrl+B, then D
#
#   Step 14 — Summary
#              Prints network, mode, directory, tmux session name, total time
#              taken, and log file path.
#
# LOG FILE
#   Each run creates a timestamped log file:
#     <toolkit_root>/log/01_build_new_grin_node_YYYYMMDD_HHMMSS.log
#   (one file per run; timestamps are UTC throughout)
#
################################################################################

set -euo pipefail

# --- Script metadata ---
SCRIPT_START_TIME=$(date +%s)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/../log"
LOG_FILE="$LOG_DIR/01_build_new_grin_node_$(date +%Y%m%d_%H%M%S).log"
CONF_DIR="/opt/grin/conf"
INSTANCES_CONF="$CONF_DIR/grin_instances_location.conf"
GRIN_GITHUB_API="https://api.github.com/repos/mimblewimble/grin/releases/latest"

# --- Session state (reset per node) ---
NETWORK_TYPE=""
ARCHIVE_MODE=""
GRIN_DIR=""
TAR_FILE=""
SHA_FILE=""
GRIN_BIN_TMP=""        # cache binary between mainnet+testnet setups
RESTRICTED_NETWORK=""  # set by check_grin_running if one slot is already occupied
STREAM_MODE=false      # true = on-the-fly pipe extraction (no local .tar.gz saved)
READY_SOURCES=()       # ordered list of base URLs that passed sync-status check
SELECTED_ZONE=""       # zone chosen at Step 9 (america|asia|europe|africa|all)

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
# HELPER: GRACEFUL GRIN SHUTDOWN
# -----------------------------------------------------------------------------
# Stops all running Grin nodes cleanly (same strategy as script 03):
#   Step 1 — SIGTERM by PID (from P2P ports 3414 / 13414), wait up to 30 s.
#   Step 2 — SIGKILL any process that did not exit within the timeout.
#   Step 3 — Kill every tmux session whose name starts with 'grin_'.
# =============================================================================
stop_grin_gracefully() {
    local stop_timeout=30

    # Step 1+2: graceful stop for each running node, identified by P2P port
    for port in 3414 13414; do
        local pid
        pid=$(ss -tlnp "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)
        [[ -z "$pid" ]] && continue

        info "PID $pid on port $port — sending SIGTERM..."
        kill -TERM "$pid" 2>/dev/null || true

        local count=0
        while ps -p "$pid" >/dev/null 2>&1 && [[ $count -lt $stop_timeout ]]; do
            sleep 2
            count=$(( count + 2 ))
            [[ $(( count % 10 )) -eq 0 ]] && info "Waiting for Grin to stop... (${count}s)"
        done

        if ps -p "$pid" >/dev/null 2>&1; then
            warn "Grin (PID $pid) still running after ${stop_timeout}s — sending SIGKILL..."
            kill -KILL "$pid" 2>/dev/null || true
            sleep 2
        fi
    done

    # Step 3: close every tmux session named grin_*
    local sess
    while IFS= read -r sess; do
        tmux kill-session -t "$sess" 2>/dev/null && \
            info "Tmux session '$sess' closed." || true
    done < <(tmux ls -F '#{session_name}' 2>/dev/null | grep '^grin_' || true)

    success "All Grin nodes and tmux sessions stopped."
}

# =============================================================================
# HELPER: REMOVE NODE DIRECTORIES FROM CONF
# -----------------------------------------------------------------------------
# Reads INSTANCES_CONF, finds the stored directory paths for the given
# networks, and deletes them from disk before a rebuild.
#   Usage: _remove_instance_dirs mainnet|testnet|all
# =============================================================================
_remove_instance_dirs() {
    [[ ! -f "$INSTANCES_CONF" ]] && return 0
    local _scope="${1:-all}"
    local _conf_content
    _conf_content=$(cat "$INSTANCES_CONF" 2>/dev/null) || return 0

    local _dirs=()
    local _d

    if [[ "$_scope" == "mainnet" || "$_scope" == "all" ]]; then
        for _var in PRUNEMAIN_GRIN_DIR FULLMAIN_GRIN_DIR; do
            _d=$(echo "$_conf_content" | grep "^${_var}=" 2>/dev/null | cut -d'"' -f2 || true)
            [[ -n "$_d" && -d "$_d" ]] && _dirs+=("$_d")
        done
    fi
    if [[ "$_scope" == "testnet" || "$_scope" == "all" ]]; then
        _d=$(echo "$_conf_content" | grep "^PRUNETEST_GRIN_DIR=" 2>/dev/null | cut -d'"' -f2 || true)
        [[ -n "$_d" && -d "$_d" ]] && _dirs+=("$_d")
    fi

    [[ ${#_dirs[@]} -eq 0 ]] && return 0
    for _d in "${_dirs[@]}"; do
        warn "Removing node directory: $_d"
        rm -rf "$_d" && success "Removed: $_d" || warn "Failed to remove: $_d"
    done

    # Clear conf entries only after directories are deleted
    if [[ -f "$INSTANCES_CONF" ]]; then
        [[ "$_scope" == "mainnet" || "$_scope" == "all" ]] && \
            sed -i '/^PRUNEMAIN_\|^FULLMAIN_/d' "$INSTANCES_CONF"
        [[ "$_scope" == "testnet" || "$_scope" == "all" ]] && \
            sed -i '/^PRUNETEST_/d' "$INSTANCES_CONF"
        log "Conf entries cleared for scope: $_scope"
    fi
}

# =============================================================================
# HELPER: STOP A SINGLE GRIN INSTANCE
# -----------------------------------------------------------------------------
# Stops only the instance on the given P2P port (SIGTERM → wait → SIGKILL) and
# kills its associated tmux session by looking up INSTANCES_CONF.
#   Usage: stop_grin_one <port>   e.g. stop_grin_one 3414
# =============================================================================
stop_grin_one() {
    local target_port="$1"
    local stop_timeout=30

    local pid
    pid=$(ss -tlnp "sport = :$target_port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)
    if [[ -z "$pid" ]]; then
        warn "No process found on port $target_port."
        return
    fi

    info "PID $pid on port $target_port — sending SIGTERM..."
    kill -TERM "$pid" 2>/dev/null || true
    local count=0
    while ps -p "$pid" >/dev/null 2>&1 && [[ $count -lt $stop_timeout ]]; do
        sleep 2; count=$(( count + 2 ))
        [[ $(( count % 10 )) -eq 0 ]] && info "Waiting for Grin to stop... (${count}s)"
    done
    if ps -p "$pid" >/dev/null 2>&1; then
        warn "Grin (PID $pid) still running — sending SIGKILL..."
        kill -KILL "$pid" 2>/dev/null || true; sleep 2
    fi

    # Kill the tmux session — conf entries are left intact so _remove_instance_dirs
    # can read them to find the directory path after this function returns.
    if [[ -f "$INSTANCES_CONF" ]]; then
        local grin_dir=""
        # shellcheck source=/dev/null
        source "$INSTANCES_CONF" 2>/dev/null || true
        if [[ "$target_port" == "3414" ]]; then
            grin_dir="${PRUNEMAIN_GRIN_DIR:-${FULLMAIN_GRIN_DIR:-}}"
        else
            grin_dir="${PRUNETEST_GRIN_DIR:-}"
        fi
        if [[ -n "$grin_dir" ]]; then
            local sess; sess="$(_grin_session_name "$grin_dir")"
            tmux kill-session -t "$sess" 2>/dev/null && info "Tmux session '$sess' closed." || true
        fi
    fi

    success "Grin on port $target_port stopped."
}

# =============================================================================
# BINARY-ONLY UPDATE — all installed instances
# -----------------------------------------------------------------------------
# Reads all instance dirs from INSTANCES_CONF, downloads the latest Grin binary
# from GitHub once, stops all running nodes, replaces each binary, and restarts
# each node in its existing tmux session.  Chain data is never touched.
# =============================================================================
update_binary_only() {
    step_header "Binary Update: All Grin Instances"

    [[ ! -f "$INSTANCES_CONF" ]] && \
        die "No instances found in $INSTANCES_CONF. Run node setup first."

    # shellcheck source=/dev/null
    source "$INSTANCES_CONF" 2>/dev/null || true

    # Collect all installed instance dirs + network type
    local -a inst_dirs=() inst_nets=()
    for key in PRUNEMAIN FULLMAIN PRUNETEST; do
        local varname="${key}_GRIN_DIR"
        local dir="${!varname:-}"
        if [[ -n "$dir" && -d "$dir" && -f "$dir/grin" ]]; then
            inst_dirs+=("$dir")
            [[ "$key" == "PRUNETEST" ]] && inst_nets+=("testnet") || inst_nets+=("mainnet")
        fi
    done

    [[ ${#inst_dirs[@]} -eq 0 ]] && die "No installed Grin instances found."

    info "Found ${#inst_dirs[@]} instance(s):"
    for i in "${!inst_dirs[@]}"; do
        info "  → ${inst_dirs[$i]}  (${inst_nets[$i]})"
    done
    echo ""

    # Download latest binary once
    info "Querying GitHub for latest Grin release..."
    local release_json version download_url
    release_json=$(curl -fsSL --max-time 30 "$GRIN_GITHUB_API") \
        || die "Failed to reach GitHub API. Check internet connection."
    version=$(echo "$release_json" | jq -r '.tag_name')
    download_url=$(echo "$release_json" \
        | jq -r '.assets[] | select(.name | test("linux-x86_64\\.tar\\.gz$"; "i")) | .browser_download_url' \
        | head -1)
    [[ -z "$download_url" || "$download_url" == "null" ]] \
        && die "No linux-x86_64 asset found for release '$version'."

    info "Latest version : $version"
    info "Download URL   : $download_url"
    local tmp_tar="/tmp/grin_bin_$$.tar.gz"
    local tmp_dir="/tmp/grin_extract_$$"
    mkdir -p "$tmp_dir"
    wget --progress=bar:force -O "$tmp_tar" "$download_url" \
        || die "Binary download failed."
    tar -xzf "$tmp_tar" -C "$tmp_dir" \
        || die "Failed to extract binary archive."
    rm -f "$tmp_tar"
    local grin_bin
    grin_bin=$(find "$tmp_dir" -type f -name "grin" | grep -v "grin-wallet" | head -1)
    [[ -z "$grin_bin" ]] && die "Could not locate 'grin' binary in the downloaded archive."

    # Stop all running nodes before replacing binaries
    stop_grin_gracefully

    # Replace binary + restart each instance
    for i in "${!inst_dirs[@]}"; do
        local dir="${inst_dirs[$i]}"
        local net="${inst_nets[$i]}"
        info "Installing $version to $dir/grin ..."
        install -m 755 "$grin_bin" "$dir/grin"
        success "Binary updated: $dir/grin"
        # start_grin_tmux reads GRIN_DIR and NETWORK_TYPE globals
        GRIN_DIR="$dir"
        NETWORK_TYPE="$net"
        start_grin_tmux
    done

    rm -rf "$tmp_dir"
    echo ""
    success "All instances updated to Grin $version."
    log "[BINARY UPDATE] version=$version instances=${#inst_dirs[@]}"
    info "Press Enter to return to main menu."
    read -r || true
    exit 0
}

# =============================================================================
# [1] CHECK FOR RUNNING GRIN PROCESSES AND PORT CONFLICTS
# -----------------------------------------------------------------------------
# P2P ports 3414 (mainnet) and 13414 (testnet) are the authoritative indicators
# of a running node. One server can host at most two Grin instances — one per
# network. Archive mode on testnet is NOT supported.
#
# Scenarios:
#   Both 3414 + 13414 occupied → B = binary-only update (all instances, no rebuild)
#                                  M = kill mainnet & rebuild mainnet only
#                                  T = kill testnet  & rebuild testnet only
#                                  K = kill all & rebuild both; 0 = return to menu
#   Only 3414 occupied         → B = binary-only update
#                                  M = kill mainnet & rebuild mainnet
#                                  1 = install testnet alongside (default)
#   Only 13414 occupied        → B = binary-only update
#                                  T = kill testnet  & rebuild testnet
#                                  1 = install mainnet alongside (default)
#   Neither occupied           → check for stale/orphaned grin processes and ports,
#                                offer to kill them before continuing
# =============================================================================

# -----------------------------------------------------------------------------
# _start_installed_node — start already-installed Grin nodes from standard paths.
# Starts mainnet first, then waits 30 s before starting testnet (if both present).
# Returns 0 on success (caller should exit 0 after).
# Returns 1 if no installed nodes found (caller should fall through to build wizard).
# -----------------------------------------------------------------------------
_start_installed_node() {
    local _filter_net="${1:-}"   # optional: "mainnet" or "testnet" — start only that network
    local -a found_dirs=() found_nets=()
    local -a check_dirs=( "/opt/grin/node/mainnet-prune" "/opt/grin/node/mainnet-full" "/opt/grin/node/testnet-prune" )
    local -a check_nets=( "mainnet"                       "mainnet"                     "testnet"                      )

    for i in "${!check_dirs[@]}"; do
        [[ -n "$_filter_net" && "${check_nets[$i]}" != "$_filter_net" ]] && continue
        [[ -x "${check_dirs[$i]}/grin" ]] && {
            found_dirs+=("${check_dirs[$i]}")
            found_nets+=("${check_nets[$i]}")
        }
    done

    if [[ ${#found_dirs[@]} -eq 0 ]]; then
        return 1  # no installed nodes found — caller will fall through to build wizard
    fi

    # start each node; mainnet first, 30-second gap before testnet
    local started=0
    for i in "${!found_dirs[@]}"; do
        GRIN_DIR="${found_dirs[$i]}"
        NETWORK_TYPE="${found_nets[$i]}"
        # Patch stale absolute paths in toml (all may point to old location after migration).
        local _toml="$GRIN_DIR/grin-server.toml"
        if [[ -f "$_toml" ]]; then
            sed -i "s|log_file_path\s*=\s*\".*\"|log_file_path = \"$GRIN_DIR/grin-server.log\"|" "$_toml" 2>/dev/null || true
            sed -i "s|api_secret_path\s*=\s*\".*\"|api_secret_path = \"$GRIN_DIR/.api_secret\"|" "$_toml" 2>/dev/null || true
            sed -i "s|foreign_api_secret_path\s*=\s*\".*\"|foreign_api_secret_path = \"$GRIN_DIR/.foreign_api_secret\"|" "$_toml" 2>/dev/null || true
        fi
        info "Starting node: $GRIN_DIR ($NETWORK_TYPE)"
        start_grin_tmux
        started=$(( started + 1 ))
        if [[ $(( i + 1 )) -lt ${#found_dirs[@]} ]]; then
            info "Waiting 30 seconds before starting next instance..."
            sleep 30
        fi
    done
    success "$started node(s) started."
    return 0
}

check_grin_running() {
    step_header "Step 1: Process & Port Check"

    # Identify which P2P ports are occupied and by which PID
    local mainnet_pid testnet_pid
    mainnet_pid=$(ss -tlnp "sport = :3414"  2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)
    testnet_pid=$(ss -tlnp "sport = :13414" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)

    local mainnet_running=false testnet_running=false
    [[ -n "$mainnet_pid" ]] && mainnet_running=true
    [[ -n "$testnet_pid" ]] && testnet_running=true

    # ── Both slots occupied ────────────────────────────────────────────────────
    if $mainnet_running && $testnet_running; then
        echo ""
        warn "Mainnet node is running on port 3414  (PID: $mainnet_pid)"
        warn "Testnet node is running on port 13414 (PID: $testnet_pid)"
        echo ""
        warn  "Both mainnet and testnet are already running on this server."
        info  "A server can host at most two Grin instances (one per network)."
        echo ""
        local _both_choice
        while true; do
            echo -e "  ${CYAN}B${RESET} — update binary only  (no chain data rebuild)"
            echo -e "  ${YELLOW}M${RESET} — kill mainnet  & rebuild mainnet"
            echo -e "  ${YELLOW}T${RESET} — kill testnet  & rebuild testnet"
            echo -e "  ${RED}K${RESET} — kill all Grin processes & rebuild both networks"
            echo -e "  ${GREEN}0${RESET} — return to master script"
            echo ""
            echo -ne "${DIM}[B/M/T/K/0]: ${RESET}"
            read -r _both_choice || true
            case "${_both_choice:-}" in
                [Bb])
                    update_binary_only
                    ;;
                [Mm])
                    stop_grin_one 3414
                    _remove_instance_dirs mainnet
                    GRIN_SKIP_DISK_CHECK=1 exec "$0"
                    ;;
                [Tt])
                    stop_grin_one 13414
                    _remove_instance_dirs testnet
                    GRIN_SKIP_DISK_CHECK=1 exec "$0"
                    ;;
                [Kk])
                    stop_grin_gracefully
                    _remove_instance_dirs all
                    [[ -f "$INSTANCES_CONF" ]] && { : > "$INSTANCES_CONF"; log "Conf cleared (full rebuild)."; }
                    GRIN_SKIP_DISK_CHECK=1 exec "$0"
                    ;;
                0)
                    exit 0
                    ;;
                *)
                    warn "Invalid input — choose B, M, T, K, or 0."
                    echo ""
                    ;;
            esac
        done
    fi

    # ── Only mainnet running → can install testnet alongside, or rebuild mainnet ──
    if $mainnet_running; then
        echo ""
        info "Mainnet node is running on port 3414 (PID: $mainnet_pid)."
        info "This server has one free slot — testnet can be installed alongside it."
        warn "Note: full archive mode is NOT available on testnet."
        echo ""
        local _main_choice
        while true; do
            echo -e "  ${CYAN}B${RESET} — update binary only  (no rebuild)"
            echo -e "  ${RED}M${RESET} — kill mainnet  & rebuild mainnet"
            echo -e "  ${CYAN}S${RESET} — start installed testnet node  (no rebuild)"
            echo -e "  ${GREEN}1${RESET} — install testnet alongside mainnet  ${DIM}(default)${RESET}"
            echo -e "  ${DIM}0${RESET} — return to master script"
            echo ""
            echo -ne "${DIM}[B/M/S/1/0, Enter = 1]: ${RESET}"
            read -r _main_choice || true
            case "${_main_choice:-1}" in
                [Bb])
                    update_binary_only
                    ;;
                [Mm])
                    stop_grin_one 3414
                    _remove_instance_dirs mainnet
                    GRIN_SKIP_DISK_CHECK=1 exec "$0"
                    ;;
                [Ss])
                    if _start_installed_node testnet; then
                        exit 0
                    else
                        warn "No installed testnet node found — proceeding with new node setup."
                        break
                    fi ;;
                1|"")
                    RESTRICTED_NETWORK="testnet"
                    success "Continuing with testnet installation."
                    echo ""
                    log "[STEP 1] Mainnet running (PID $mainnet_pid). Restricted to testnet."
                    return
                    ;;
                0)
                    exit 0
                    ;;
                *)
                    warn "Invalid input — choose B, M, S, 1, or 0."
                    echo ""
                    ;;
            esac
        done
    fi

    # ── Only testnet running → can install mainnet alongside, or rebuild testnet ──
    if $testnet_running; then
        echo ""
        info "Testnet node is running on port 13414 (PID: $testnet_pid)."
        info "This server has one free slot — mainnet can be installed alongside it."
        echo ""
        local _test_choice
        while true; do
            echo -e "  ${CYAN}B${RESET} — update binary only  (no rebuild)"
            echo -e "  ${RED}T${RESET} — kill testnet  & rebuild testnet"
            echo -e "  ${CYAN}S${RESET} — start installed mainnet node  (no rebuild)"
            echo -e "  ${GREEN}1${RESET} — install mainnet alongside testnet  ${DIM}(default)${RESET}"
            echo -e "  ${DIM}0${RESET} — return to master script"
            echo ""
            echo -ne "${DIM}[B/T/S/1/0, Enter = 1]: ${RESET}"
            read -r _test_choice || true
            case "${_test_choice:-1}" in
                [Bb])
                    update_binary_only
                    ;;
                [Tt])
                    stop_grin_one 13414
                    _remove_instance_dirs testnet
                    GRIN_SKIP_DISK_CHECK=1 exec "$0"
                    ;;
                [Ss])
                    if _start_installed_node mainnet; then
                        exit 0
                    else
                        warn "No installed mainnet node found — proceeding with new node setup."
                        break
                    fi ;;
                1|"")
                    RESTRICTED_NETWORK="mainnet"
                    success "Continuing with mainnet installation."
                    echo ""
                    log "[STEP 1] Testnet running (PID $testnet_pid). Restricted to mainnet."
                    return
                    ;;
                0)
                    exit 0
                    ;;
                *)
                    warn "Invalid input — choose B, T, S, 1, or 0."
                    echo ""
                    ;;
            esac
        done
    fi

    # ── No legitimate node running → check for stale/orphaned processes ───────
    local -A PORT_NAMES=([3413]="API" [3414]="P2P mainnet" [13414]="P2P testnet" [3415]="Wallet Listener")
    while true; do
        local found=0

        local grin_procs
        grin_procs=$(pgrep -a -f '[g]rin server run' 2>/dev/null || true)
        if [[ -n "$grin_procs" ]]; then
            warn "Stale Grin processes detected:"
            while IFS= read -r line; do echo -e "  ${YELLOW}→${RESET} $line"; done <<< "$grin_procs"
            found=1
        fi

        for port in 3413 3414 13414 3415; do
            local result
            result=$(ss -tlnp "sport = :$port" 2>/dev/null | tail -n +2 || true)
            if [[ -n "$result" ]]; then
                warn "Port $port (${PORT_NAMES[$port]}) is occupied:"
                echo -e "  ${YELLOW}→${RESET} $result"
                found=1
            fi
        done

        # Check for an installed-but-not-running node (conf file or binary on disk)
        if [[ $found -eq 0 ]]; then
            local _inst_detected=false
            if [[ -s "$INSTANCES_CONF" ]]; then
                _inst_detected=true
            else
                for _chk in /opt/grin/node/mainnet-prune /opt/grin/node/mainnet-full /opt/grin/node/testnet-prune; do
                    [[ -x "$_chk/grin" ]] && { _inst_detected=true; break; }
                done
            fi
            if $_inst_detected; then
                info "Grin node installation found (not currently running)."
                found=1
            fi
        fi

        if [[ $found -eq 1 ]]; then
            echo ""
            echo -e "  ${GREEN}K${RESET}) Kill all conflicting processes and continue"
            echo -e "  ${YELLOW}C${RESET}) Continue anyway with warning only (if processes are unrelated to Grin)"
            echo -e "  ${CYAN}S${RESET}) Start installed node (no rebuild)"
            echo -e "  ${RED}N${RESET}) Abort  (resolve manually)"
            echo -e "  ${DIM}0${RESET}) Return to main menu"
            echo -e "  ${DIM}Enter${RESET}) Recheck"
            echo ""
            echo -ne "${BOLD}${RED}Choose [K/C/S/N/0]: ${RESET}"
            read -r confirm || true
            case "${confirm,,}" in
                k) stop_grin_gracefully
                   [[ -f "$INSTANCES_CONF" ]] && { : > "$INSTANCES_CONF"; log "Conf cleared (stale-process kill)."; }
                   break ;;
                c) warn "Continuing despite detected processes — ensure they are NOT Grin-related."; echo ""; break ;;
                s) if _start_installed_node; then
                       exit 0
                   else
                       warn "No installed nodes found — proceeding with new node setup."
                       break
                   fi ;;
                0) exit 0 ;;
                "") continue ;;
                *) die "Aborted. Resolve the conflicts manually and re-run." ;;
            esac
        else
            success "No Grin processes or port conflicts found."
            break
        fi
    done

    # ── Legacy directory check ─────────────────────────────────────────────────
    if [[ -d "$HOME/.grin" ]]; then
        echo ""
        warn "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        warn "  Legacy Grin directory detected: $HOME/.grin"
        warn "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        echo -e "  This is a non-standard path that can conflict with the new"
        echo -e "  standardized installation under ${BOLD}/opt/grin/${RESET}."
        local _legacy_size
        _legacy_size=$(du -sh "$HOME/.grin" 2>/dev/null | cut -f1) || _legacy_size="?"
        echo -e "  Size: ${YELLOW}${_legacy_size}${RESET}"
        echo ""
        echo -e "  ${RED}D${RESET}) Delete ${BOLD}$HOME/.grin${RESET}  ${DIM}(recommended)${RESET}"
        echo -e "  ${DIM}Enter${RESET}) Keep it and continue  ${DIM}(may cause config conflicts)${RESET}"
        echo -e "  ${DIM}0${RESET}) Return to master script"
        echo ""
        echo -ne "${BOLD}Choice [D/Enter/0]: ${RESET}"
        local _legacy_choice
        read -r _legacy_choice || true
        case "${_legacy_choice,,}" in
            d)
                rm -rf "$HOME/.grin"
                success "Deleted: $HOME/.grin"
                ;;
            0)
                exit 0
                ;;
            *)
                warn "Keeping $HOME/.grin — this may cause config conflicts."
                ;;
        esac
        echo ""
    fi

    log "[STEP 1] Complete. No restrictions."
}

# =============================================================================
# [2] INSTALL DEPENDENCIES
# -----------------------------------------------------------------------------
# Runs apt-get update && upgrade (or dnf update) to ensure the system is
# current, then installs any missing required packages:
# apt-get: tar, openssl, libncurses5 (or libncurses6 on Ubuntu 24.04+),
#          tmux, jq, tor, curl, wget.
# dnf (Rocky/Alma 10+): epel-release (auto), tar, openssl, ncurses-compat-libs, tmux, jq, tor, curl, wget.
# OS version check is handled upstream by the master script.
# =============================================================================
check_os_and_deps() {
    step_header "Step 2: System Update & Dependency Check"

    [[ $EUID -ne 0 ]] && die "This script must be run as root (sudo)."

    # ── System update ─────────────────────────────────────────────────────────
    info "Updating system packages..."
    if command -v dnf &>/dev/null; then
        dnf update -y || warn "dnf update encountered errors — continuing."
    else
        apt-get update \
            && apt-get upgrade -y \
            || warn "apt update/upgrade encountered errors — continuing."
    fi
    success "System up to date."
    echo ""

    local os_id
    os_id="$(grep '^ID=' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"' || true)"

    if [[ "$os_id" == "rocky" || "$os_id" == "almalinux" ]]; then
        # Rocky Linux / AlmaLinux 10+ — use dnf
        # ncurses-compat-libs fixes "no version information available" warnings
        # from the Grin binary at runtime. tar and tmux are not installed by default.
        # tor is only available via EPEL — install epel-release first if missing.
        if ! rpm -q epel-release &>/dev/null 2>&1; then
            info "Installing EPEL repository (required for tor)..."
            dnf install -y -q epel-release \
                || die "Failed to install epel-release. Check internet connection."
        fi

        local packages=(tar tmux curl wget jq tor openssl ncurses-compat-libs)
        local to_install=()
        for pkg in "${packages[@]}"; do
            rpm -q "$pkg" &>/dev/null 2>&1 || to_install+=("$pkg")
        done

        if [[ ${#to_install[@]} -gt 0 ]]; then
            info "Installing missing packages: ${to_install[*]}"
            dnf install -y -q "${to_install[@]}" \
                || die "Failed to install packages: ${to_install[*]}. See error above."
            success "Packages installed."
        else
            success "All required packages already present."
        fi
    else
        # Debian/Ubuntu — use apt-get
        # ncurses: libncurses5 was removed in Ubuntu 24.04 — use libncurses6 there.
        local ncurses_pkg
        if apt-cache show libncurses5 &>/dev/null 2>&1; then
            ncurses_pkg="libncurses5"
        else
            ncurses_pkg="libncurses6"
        fi

        local packages=(tar openssl "$ncurses_pkg" tmux jq tor curl wget)
        local to_install=()
        for pkg in "${packages[@]}"; do
            dpkg -s "$pkg" &>/dev/null 2>&1 || to_install+=("$pkg")
        done

        if [[ ${#to_install[@]} -gt 0 ]]; then
            info "Installing missing packages: ${to_install[*]}"
            apt-get update -qq \
                || die "apt-get update failed. Check your internet connection and package sources."
            apt-get install -y -qq "${to_install[@]}" \
                || die "Failed to install packages: ${to_install[*]}. See error above."
            success "Packages installed."
        else
            success "All required packages already present."
        fi
    fi

    log "[STEP 2] Deps OK."
}

# =============================================================================
# [3] SELECT NETWORK TYPE
# -----------------------------------------------------------------------------
# Asks the user to choose: Mainnet, Testnet, or Both (runs sequentially).
# Default is Mainnet. Exits on invalid input.
# When "Both" is selected, the full setup flow runs for mainnet first,
# then repeats for testnet automatically.
# =============================================================================
select_network() {
    step_header "Step 3: Network Selection"

    # If one network slot is already occupied, offer: install the other network,
    # or rebuild the running one with a different mode (mainnet only — testnet is always pruned).
    if [[ -n "$RESTRICTED_NETWORK" ]]; then
        local running_network running_port
        [[ "$RESTRICTED_NETWORK" == "testnet" ]] && running_network="mainnet" || running_network="testnet"
        [[ "$running_network"    == "mainnet" ]] && running_port=3414         || running_port=13414

        # Detect current mode of the running node via its config file
        local running_mode="unknown"
        local running_pid
        running_pid=$(ss -tlnp "sport = :$running_port" 2>/dev/null \
            | grep -oP 'pid=\K[0-9]+' | head -1 || true)
        if [[ -n "$running_pid" ]]; then
            local _bin _cfg
            _bin=$(readlink -f "/proc/$running_pid/exe" 2>/dev/null) || true
            _cfg="$(dirname "${_bin:-}")/grin-server.toml"
            if [[ -f "$_cfg" ]] && grep -qiE 'archive_mode\s*=\s*true' "$_cfg" 2>/dev/null; then
                running_mode="full archive"
            else
                running_mode="pruned"
            fi
        fi

        echo ""
        info "Running: ${BOLD}${running_network}${RESET}  port $running_port  mode: $running_mode"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Install ${BOLD}${RESTRICTED_NETWORK}${RESET} alongside it"
        if [[ "$running_network" == "mainnet" ]]; then
            local switch_to
            [[ "$running_mode" == "pruned" ]] && switch_to="full archive" || switch_to="pruned"
            echo -e "  ${YELLOW}2${RESET}) Rebuild ${BOLD}${running_network}${RESET} — switch to ${switch_to}"
        fi
        echo -e "  ${DIM}0${RESET}) Return to main menu"
        echo ""
        echo -ne "${BOLD}Choice [1]: ${RESET}"
        local slot_choice
        read -r slot_choice || true

        case "${slot_choice:-1}" in
            1)
                NETWORK_TYPE="$RESTRICTED_NETWORK"
                info "Network: ${BOLD}${NETWORK_TYPE}${RESET}"
                log "[STEP 3] Network=$NETWORK_TYPE (other slot occupied)"
                ;;
            2)
                if [[ "$running_network" == "mainnet" ]]; then
                    warn "Stopping ${running_network} to rebuild with different mode..."
                    stop_grin_gracefully
                    _remove_instance_dirs mainnet
                    GRIN_SKIP_DISK_CHECK=1
                    NETWORK_TYPE="mainnet"
                    RESTRICTED_NETWORK=""
                    info "Network: ${BOLD}${NETWORK_TYPE}${RESET} — select new mode at Step 4"
                    log "[STEP 3] Network=$NETWORK_TYPE (mode-switch rebuild)"
                else
                    warn "Mode switching is only available for mainnet (testnet is always pruned)."
                    NETWORK_TYPE="$RESTRICTED_NETWORK"
                    log "[STEP 3] Network=$NETWORK_TYPE (auto-restricted)"
                fi
                ;;
            0) exit 0 ;;
            *) die "Invalid choice." ;;
        esac
        return
    fi

    echo ""
    echo -e "  ${GREEN}1${RESET}) Mainnet  (default)"
    echo -e "  ${YELLOW}2${RESET}) Testnet"
    echo -e "  ${CYAN}3${RESET}) Both     (you can run both mainnet/testnet in parallel — install mainnet first, then testnet)"
    echo -e "  ${DIM}0${RESET}) Return to main menu"
    echo ""
    echo -ne "${BOLD}Choice [1]: ${RESET}"
    read -r net_choice || true

    case "${net_choice:-1}" in
        0) exit 0 ;;
        1) NETWORK_TYPE="mainnet" ;;
        2) NETWORK_TYPE="testnet" ;;
        3) NETWORK_TYPE="both"    ;;
        *) die "Invalid choice '${net_choice}'. Exiting." ;;
    esac
    info "Network: $NETWORK_TYPE"
    log "[STEP 3] Network=$NETWORK_TYPE"
}

# =============================================================================
# [4] SELECT ARCHIVE MODE (called once per network)
# -----------------------------------------------------------------------------
# Asks the user to choose between Pruned (default) or Full archive mode.
# IMPORTANT: Testnet does NOT support full archive mode.
# If the user selects full archive for testnet, shows an error and waits for user to exit.
# Default is Pruned for both networks.
# =============================================================================
select_archive_mode() {
    local network="$1"
    step_header "Step 4: Archive Mode (${network})"
    echo ""
    echo -e "  ${GREEN}1${RESET}) Pruned       (default, recommended — smaller storage, ~10 GiB)"
    echo -e "  ${YELLOW}2${RESET}) Full archive (mainnet only — full UTXO history, ~25 GiB)"
    echo -e "  ${DIM}0${RESET}) Return to main menu"
    echo ""

    if [[ "$network" == "testnet" ]]; then
        warn "Testnet does NOT support full archive mode."
    fi

    echo ""
    echo -ne "${BOLD}Choice [1]: ${RESET}"
    read -r arc_choice || true

    case "${arc_choice:-1}" in
        0) exit 0 ;;
        1) ARCHIVE_MODE="pruned" ;;
        2)
            if [[ "$network" == "testnet" ]]; then
                die "Full archive mode is not supported on testnet."
            fi
            ARCHIVE_MODE="full"
            ;;
        *) die "Invalid archive mode '${arc_choice}'." ;;
    esac

    # Disk space advisory — skipped on rebuild (target dir + instances conf already exist).
    # Derive the target dir for this network+mode to apply the same rebuild check as Step 5.
    local _s4_target_dir
    if   [[ "$ARCHIVE_MODE" == "full"    ]]; then _s4_target_dir="/opt/grin/node/mainnet-full"
    elif [[ "$network"      == "mainnet" ]]; then _s4_target_dir="/opt/grin/node/mainnet-prune"
    else                                          _s4_target_dir="/opt/grin/node/testnet-prune"
    fi

    if [[ -d "$_s4_target_dir" && -f "$INSTANCES_CONF" ]]; then
        info "Existing install detected — skipping disk space advisory (rebuild in place)."
    else
        local _free_kb _free_gb _min_gb
        _free_kb=$(df /opt/grin 2>/dev/null | awk 'NR==2{print $4}' \
                   || df / | awk 'NR==2{print $4}')
        _free_gb=$(awk "BEGIN {printf \"%.1f\", $_free_kb/1048576}")
        [[ "$ARCHIVE_MODE" == "full" ]] && _min_gb=25 || _min_gb=10
        echo ""
        echo -e "  ${DIM}Free disk (/opt/grin):${RESET}  ${BOLD}${_free_gb} GiB${RESET}"
        if awk "BEGIN {exit ($_free_gb >= $_min_gb) ? 0 : 1}"; then
            echo -e "  ${GREEN}✓${RESET}  Sufficient space for ${ARCHIVE_MODE} mode (min ~${_min_gb} GiB)."
        else
            echo ""
            echo -e "  ${RED}⚠  Low disk space:${RESET} ${_free_gb} GiB free, recommended minimum is ~${_min_gb} GiB"
            echo -e "     for ${ARCHIVE_MODE} mode (archive download + extraction)."
            echo ""
            echo -ne "  Continue anyway? [Y/n]: "
            read -r _space_ok || true
            [[ "${_space_ok,,}" == "n" ]] && exit 0
        fi
    fi

    info "Archive mode: $ARCHIVE_MODE"
    log "[STEP 4] ArchiveMode=$ARCHIVE_MODE"
}

# =============================================================================
# [5] PREPARE NODE DIRECTORY
# -----------------------------------------------------------------------------
# Sets GRIN_DIR to the standardized location for the chosen network+mode:
#   /opt/grin/node/mainnet-full   — full archive, mainnet
#   /opt/grin/node/mainnet-prune  — pruned,       mainnet
#   /opt/grin/node/testnet-prune  — pruned,       testnet
#
# No user prompt is shown for the path — the standardized location is always used.
#
# Disk space check:
#   Skipped when GRIN_SKIP_DISK_CHECK=1 (set by M/T/K rebuild paths, which
#   already removed the old directory before restarting). On a fresh install
#   the check is a hard stop if space is insufficient.
#
# Existing files in GRIN_DIR are cleared automatically (no confirmation prompt)
# before the binary and chain data download begins.
# =============================================================================
create_node_dir() {
    local network="$1"
    local mode="$2"

    # 1. Resolve standardized path → GRIN_DIR
    local default_dir
    if [[ "$mode" == "full" ]]; then
        default_dir="/opt/grin/node/mainnet-full"
    elif [[ "$network" == "mainnet" ]]; then
        default_dir="/opt/grin/node/mainnet-prune"
    else
        default_dir="/opt/grin/node/testnet-prune"
    fi
    GRIN_DIR="$default_dir"

    step_header "Step 5: Prepare Node Directory"
    info "Node directory: $GRIN_DIR"
    echo ""

    # 1b. Remove the OTHER mainnet variant dir so switching fullmain↔prunemain
    #     leaves no leftover /opt/grin/node/<old-type> directory behind.
    if [[ "$network" == "mainnet" ]]; then
        local _alt_dir
        if [[ "$mode" == "full" ]]; then
            _alt_dir="/opt/grin/node/mainnet-prune"
        else
            _alt_dir="/opt/grin/node/mainnet-full"
        fi
        if [[ -d "$_alt_dir" ]]; then
            warn "Removing old mainnet directory: $_alt_dir"
            rm -rf "$_alt_dir" && success "Removed: $_alt_dir" || warn "Failed to remove: $_alt_dir"
        fi
    fi

    # 2. Disk space check — skipped for rebuilds (M/T/K paths set GRIN_SKIP_DISK_CHECK=1)
    if [[ "${GRIN_SKIP_DISK_CHECK:-0}" == "1" ]]; then
        info "Rebuild mode — skipping disk space check."
    else
        local min_gb avail_kb avail_gb
        [[ "$mode" == "full" ]] && min_gb=25 || min_gb=10
        local min_kb=$(( min_gb * 1024 * 1024 ))
        local check_path="$GRIN_DIR"
        while [[ ! -d "$check_path" && "$check_path" != "/" ]]; do
            check_path=$(dirname "$check_path")
        done
        avail_kb=$(df -k "$check_path" 2>/dev/null | awk 'NR==2{print $4}') || avail_kb=0
        avail_gb=$(( avail_kb / 1024 / 1024 ))
        echo -e "  ${DIM}$(df -h "$check_path" 2>/dev/null | awk 'NR==1||NR==2' | column -t)${RESET}"
        echo -e "  Available: ${BOLD}${avail_gb} GiB${RESET}  (required: ${min_gb} GiB)"
        echo ""
        if (( avail_kb < min_kb )); then
            die "Insufficient disk space: ${avail_gb} GiB available, ${min_gb} GiB required for ${mode} mode. Free up space on $(df -h "$check_path" 2>/dev/null | awk 'NR==2{print $1}') and retry."
        fi
        success "Disk space OK."
    fi

    # 3. Auto-clean existing files (no confirmation — path is fixed and standardized)
    if [[ -d "$GRIN_DIR" ]]; then
        local _existing_count
        _existing_count=$(find "$GRIN_DIR" -mindepth 1 2>/dev/null | wc -l) || _existing_count=0
        if (( _existing_count > 0 )); then
            warn "Removing ${_existing_count} existing item(s) from $GRIN_DIR ..."
            rm -rf "${GRIN_DIR:?}"/*  2>/dev/null || true
            rm -rf "${GRIN_DIR:?}"/.[!.]* 2>/dev/null || true
            success "Directory cleaned: $GRIN_DIR"
        fi
    fi

    mkdir -p "$GRIN_DIR" \
        || die "Failed to create directory $GRIN_DIR. Check permissions (must run as root)."
    success "Node directory ready: $GRIN_DIR"
    log "[STEP 5] Dir=$GRIN_DIR"
}

# =============================================================================
# [6] DOWNLOAD GRIN BINARY (latest linux-x86_64 from GitHub)
# -----------------------------------------------------------------------------
# Queries the GitHub API for the latest Grin release and downloads the
# linux-x86_64 tar.gz asset. Extracts the 'grin' binary to $GRIN_DIR.
# When setting up "both" networks, the binary is cached from the first download
# and reused for the second network to avoid a redundant download.
# Exits if the GitHub API is unreachable or no matching asset is found.
# =============================================================================
download_grin_binary() {
    step_header "Step 6: Download Grin Binary"

    # Reuse already-downloaded binary when setting up both networks
    if [[ -n "$GRIN_BIN_TMP" && -f "$GRIN_BIN_TMP" ]]; then
        info "Reusing binary downloaded earlier in this session."
        install -m 755 "$GRIN_BIN_TMP" "$GRIN_DIR/grin"
        success "Binary copied to $GRIN_DIR/grin"
        return
    fi

    info "Querying GitHub for latest Grin release..."
    local release_json
    release_json=$(curl -fsSL --max-time 30 "$GRIN_GITHUB_API") \
        || die "Failed to reach GitHub API. Check internet connection."

    local version download_url
    version=$(echo "$release_json" | jq -r '.tag_name')
    download_url=$(echo "$release_json" \
        | jq -r '.assets[] | select(.name | test("linux-x86_64\\.tar\\.gz$"; "i")) | .browser_download_url' \
        | head -1)

    if [[ -z "$download_url" || "$download_url" == "null" ]]; then
        die "No linux-x86_64 tar.gz asset found in GitHub release '$version'."
    fi

    info "Latest version : $version"
    info "Download URL   : $download_url"

    local tmp_tar="/tmp/grin_bin_$$.tar.gz"
    local tmp_dir="/tmp/grin_extract_$$"
    mkdir -p "$tmp_dir"

    info "Downloading binary (showing progress)..."
    wget --progress=bar:force -O "$tmp_tar" "$download_url" \
        || die "Binary download failed."

    info "Extracting archive..."
    tar -xzf "$tmp_tar" -C "$tmp_dir" \
        || die "Failed to extract Grin binary archive from $tmp_tar."
    rm -f "$tmp_tar"

    local grin_bin
    grin_bin=$(find "$tmp_dir" -type f -name "grin" | grep -v "grin-wallet" | head -1)
    [[ -z "$grin_bin" ]] && die "Could not locate 'grin' binary in the downloaded archive."

    # Cache for reuse
    GRIN_BIN_TMP="$grin_bin"
    install -m 755 "$grin_bin" "$GRIN_DIR/grin"
    success "Grin $version binary installed to $GRIN_DIR/grin"
    log "[STEP 6] Version=$version Binary=$GRIN_DIR/grin"
}

# =============================================================================
# [7] GENERATE grin-server.toml VIA 'grin server config'
# -----------------------------------------------------------------------------
# Mainnet: './grin server config'
# Testnet: './grin --testnet server config'
# The --testnet flag produces the correct chain_type ("Testnet") and testnet
# ports (13413/13414/13415/13416) automatically — no manual patching needed.
# HOME is overridden to $GRIN_DIR so grin writes its output under our custom
# directory instead of /root.
# If the command fails the error is shown and the user must press Enter —
# there is no fallback minimal config; only the grin-generated file is used.
# =============================================================================
generate_config() {
    local network="$1"
    step_header "Step 7: Generate grin-server.toml"
    local target="$GRIN_DIR/grin-server.toml"

    # If a grin-server.toml already exists, back it up with a timestamp so the
    # newly generated file is always a clean slate.
    if [[ -f "$target" ]]; then
        local backup="${target}.bak.$(date +%s)"
        mv "$target" "$backup" \
            || die "Failed to back up existing config to $backup."
        warn "Existing config backed up: $(basename "$backup")"
    fi

    local cmd
    if [[ "$network" == "testnet" ]]; then
        cmd="./grin --testnet server config"
    else
        cmd="./grin server config"
    fi
    info "Running: $cmd  (HOME overridden to $GRIN_DIR)"

    # No || true — if the command fails, die() stops execution.
    (cd "$GRIN_DIR" && HOME="$GRIN_DIR" $cmd 2>&1 | tee -a "$LOG_FILE") \
        || die "'$cmd' failed. Cannot continue without a valid generated config. Exiting."

    # Locate the newly generated config (grin may write it into a subdirectory)
    local found_config
    found_config=$(find "$GRIN_DIR" -name "grin-server.toml" 2>/dev/null | head -1)

    if [[ -z "$found_config" ]]; then
        die "'$cmd' ran but grin-server.toml was not found in $GRIN_DIR. Check binary compatibility. Exiting."
    fi

    # Move to the root of GRIN_DIR if grin placed it in a subdirectory
    if [[ "$found_config" != "$target" ]]; then
        mv "$found_config" "$target" \
            || die "Failed to move config from $(dirname "$found_config") to $GRIN_DIR."
        info "Config moved from $(dirname "$found_config") → $GRIN_DIR"
    fi

    success "Config ready: $target"
    log "[STEP 7] network=$network cmd=$cmd config=$target"
}

# =============================================================================
# [8] PATCH grin-server.toml WITH USER CHOICES
# -----------------------------------------------------------------------------
# Modifies the generated config with user choices and enforces absolute paths:
#   archive_mode            → true (full) or false (pruned)
#   db_root                 → <node_dir>/chain_data
#   log_file_path           → <node_dir>/grin-server.log
#   api_secret_path         → <node_dir>/.api_secret
#   foreign_api_secret_path → <node_dir>/.foreign_api_secret
# chain_type and ports are already correct from 'grin [--testnet] server config'
# and do not need patching here.
# If any key is missing from the generated config, it is appended with a warning.
# =============================================================================
patch_config() {
    local network="$1"
    local mode="$2"
    local config="$GRIN_DIR/grin-server.toml"

    step_header "Step 8: Patch Config"

    local archive_val
    [[ "$mode" == "full" ]] && archive_val="true" || archive_val="false"

    # archive_mode
    if grep -q 'archive_mode' "$config"; then
        sed -i "s/^archive_mode = .*/archive_mode = $archive_val/" "$config"
    else
        echo "archive_mode = $archive_val" >> "$config"
        warn "archive_mode not found in config — appended."
    fi

    # db_root — point to our custom directory so grin stores chain data here
    local db_root="$GRIN_DIR/chain_data"
    if grep -q 'db_root' "$config"; then
        sed -i "s|^db_root = .*|db_root = \"$db_root\"|" "$config"
    else
        echo "db_root = \"$db_root\"" >> "$config"
        warn "db_root not found in config — appended."
    fi

    # log_file_path — keep log in the node directory, not in HOME
    if grep -qE '^#?[[:space:]]*log_file_path' "$config"; then
        sed -i -E "s|^#?[[:space:]]*log_file_path[[:space:]]*=.*|log_file_path = \"$GRIN_DIR/grin-server.log\"|" "$config"
    else
        echo "log_file_path = \"$GRIN_DIR/grin-server.log\"" >> "$config"
        warn "log_file_path not found in config — appended."
    fi

    # api_secret_path — absolute path so it works regardless of working directory
    if grep -qE '^#?[[:space:]]*api_secret_path' "$config"; then
        sed -i -E "s|^#?[[:space:]]*api_secret_path[[:space:]]*=.*|api_secret_path = \"$GRIN_DIR/.api_secret\"|" "$config"
    else
        echo "api_secret_path = \"$GRIN_DIR/.api_secret\"" >> "$config"
        warn "api_secret_path not found in config — appended."
    fi

    # foreign_api_secret_path — absolute path so it works regardless of working directory
    if grep -qE '^#?[[:space:]]*foreign_api_secret_path' "$config"; then
        sed -i -E "s|^#?[[:space:]]*foreign_api_secret_path[[:space:]]*=.*|foreign_api_secret_path = \"$GRIN_DIR/.foreign_api_secret\"|" "$config"
    else
        echo "foreign_api_secret_path = \"$GRIN_DIR/.foreign_api_secret\"" >> "$config"
        warn "foreign_api_secret_path not found in config — appended."
    fi

    # peer_max_inbound_count — allow more inbound peers for a community node
    if grep -qE '^#?[[:space:]]*peer_max_inbound_count' "$config"; then
        sed -i -E 's/^#?[[:space:]]*peer_max_inbound_count[[:space:]]*=.*/peer_max_inbound_count = 999/' "$config"
    else
        echo "peer_max_inbound_count = 999" >> "$config"
        warn "peer_max_inbound_count not found in config — appended."
    fi

    # peer_max_outbound_count — more outbound connections for faster propagation
    if grep -qE '^#?[[:space:]]*peer_max_outbound_count' "$config"; then
        sed -i -E 's/^#?[[:space:]]*peer_max_outbound_count[[:space:]]*=.*/peer_max_outbound_count = 199/' "$config"
    else
        echo "peer_max_outbound_count = 199" >> "$config"
        warn "peer_max_outbound_count not found in config — appended."
    fi

    # peer_min_preferred_outbound_count — aggressively maintain outbound connections
    if grep -qE '^#?[[:space:]]*peer_min_preferred_outbound_count' "$config"; then
        sed -i -E 's/^#?[[:space:]]*peer_min_preferred_outbound_count[[:space:]]*=.*/peer_min_preferred_outbound_count = 199/' "$config"
    else
        echo "peer_min_preferred_outbound_count = 199" >> "$config"
        warn "peer_min_preferred_outbound_count not found in config — appended."
    fi

    # log_max_files — keep only 3 rotated log files to save disk space
    if grep -qE '^#?[[:space:]]*log_max_files' "$config"; then
        sed -i -E 's/^#?[[:space:]]*log_max_files[[:space:]]*=.*/log_max_files = 3/' "$config"
    else
        echo "log_max_files = 3" >> "$config"
        warn "log_max_files not found in config — appended."
    fi

    # enable_stratum_server — enable the built-in stratum mining server
    if grep -qE '^#?[[:space:]]*enable_stratum_server' "$config"; then
        sed -i -E 's/^#?[[:space:]]*enable_stratum_server[[:space:]]*=.*/enable_stratum_server = true/' "$config"
    else
        echo "enable_stratum_server = true" >> "$config"
        warn "enable_stratum_server not found in config — appended."
    fi

    success "Config patched:"
    info "  archive_mode                      = $archive_val"
    info "  db_root                           = \"$db_root\""
    info "  log_file_path                     = \"$GRIN_DIR/grin-server.log\""
    info "  api_secret_path                   = \"$GRIN_DIR/.api_secret\""
    info "  foreign_api_secret_path           = \"$GRIN_DIR/.foreign_api_secret\""
    info "  peer_max_inbound_count            = 999"
    info "  peer_max_outbound_count           = 199"
    info "  peer_min_preferred_outbound_count = 199"
    info "  log_max_files                     = 3"
    info "  enable_stratum_server             = true"
    log "[STEP 8] archive_mode=$archive_val db_root=$db_root api_secret=$GRIN_DIR/.api_secret peer_limits=999in/199out/199min log_max_files=3 stratum=true"
}

# =============================================================================
# [8b] GENERATE API SECRET FILES
# -----------------------------------------------------------------------------
# Creates .api_secret and .foreign_api_secret in $GRIN_DIR with a 20-character
# random alphanumeric key (A-Z a-z 0-9). Any existing files are overwritten.
# Permissions set to 600; ownership set to grin:grin if the grin user exists.
# =============================================================================
generate_secrets() {
    step_header "Step 8b: Generate API Secret Files"

    local secret_file="$GRIN_DIR/.api_secret"
    local foreign_file="$GRIN_DIR/.foreign_api_secret"

    # Generate 20-char random alphanumeric string; || true handles tr SIGPIPE
    local api_secret foreign_secret
    api_secret=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20 || true)
    foreign_secret=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20 || true)

    [[ ${#api_secret}     -eq 20 ]] || die "Failed to generate api_secret — /dev/urandom unavailable?"
    [[ ${#foreign_secret} -eq 20 ]] || die "Failed to generate foreign_api_secret — /dev/urandom unavailable?"

    printf '%s' "$api_secret"     > "$secret_file"
    printf '%s' "$foreign_secret" > "$foreign_file"

    chmod 600 "$secret_file" "$foreign_file"

    if id grin &>/dev/null; then
        chown grin:grin "$secret_file" "$foreign_file"
        info "Ownership set to grin:grin"
    fi

    success "Secret files created:"
    info "  $secret_file"
    info "  $foreign_file"
    log "[STEP 8b] api_secret=$secret_file foreign_api_secret=$foreign_file"
}

# =============================================================================
# [8c] CREATE GRIN SERVICE USER
# -----------------------------------------------------------------------------
# Creates the 'grin' system user (no login shell, no home dir) if it does not
# already exist, then sets grin:grin ownership on GRIN_DIR so the node runs
# under the service account. Safe to call multiple times (idempotent).
# =============================================================================
ensure_grin_user() {
    step_header "Step 8c: Create grin Service User"

    if id grin &>/dev/null; then
        info "System user 'grin' already exists — skipping creation."
    else
        if useradd -r -s /usr/sbin/nologin -d /opt/grin -M grin 2>/dev/null; then
            success "System user grin:grin created."
        else
            warn "Could not create user 'grin' — node will run as current user."
            return
        fi
    fi

    if [[ -n "${GRIN_DIR:-}" && -d "$GRIN_DIR" ]]; then
        # Chown the entire base tree (/opt/grin) so grin user can create ~/.grin/main/
        # on startup and all node/wallet dirs are consistently owned.
        local _parent; _parent="$(dirname "$GRIN_DIR")"
        local _grandparent; _grandparent="$(dirname "$_parent")"
        local _base; _base="${_grandparent}"
        [[ -d "$_base" ]] && chown -R grin:grin "$_base" 2>/dev/null || true
        info "Ownership set: grin:grin → $_base"
    fi
}

# =============================================================================
# [9] DOWNLOAD CHAIN DATA FROM TRUSTED SOURCE
# -----------------------------------------------------------------------------
# Selects the correct chain data source based on network + archive mode.
# Server list is loaded from extensions/grinmasternodes.json (zone-aware registry).
# User selects a zone (America/Asia/Europe/Africa); zones without dedicated
# servers for the chosen site_key automatically fall back to America.
# Site keys (site_key prefix on each hostname):
#   fullmain  — full archive, mainnet
#   prunemain — pruned,       mainnet
#   prunetest — pruned,       testnet
# Each host is checked via check_status_before_download.txt — only used if it
# contains "Sync completed.".
# If all 3 known hosts fail, the user is prompted to enter a custom base URL
# (e.g. https://myserver.com) or press 0 to return to the master script.
# Custom sources are accepted if they contain a .tar.gz in their directory
# listing (status file check is skipped for custom URLs).
# Parses the directory index to find .tar.gz and .sha256 filenames dynamically.
# Downloads both files to $GRIN_DIR with visible progress for the large tar.
# =============================================================================
_get_site_key() {
    # Returns: fullmain | prunemain | prunetest
    local network="$1" mode="$2"
    local net_short mode_short
    [[ "$network" == "mainnet" ]] && net_short="main" || net_short="test"
    [[ "$mode"    == "full"    ]] && mode_short="full" || mode_short="prune"
    echo "${mode_short}${net_short}"
}

# Read host list for a given zone+sitekey from grinmasternodes.json.
# Returns space-separated hostnames, or empty string if none found.
# Args: zone sitekey registry_path
_get_zone_hosts() {
    local zone="$1" sk="$2" reg="$3"
    [[ ! -f "$reg" ]] && return
    local result=""
    if command -v jq &>/dev/null; then
        result=$(jq -r --arg z "$zone" --arg s "$sk" \
            '(.[$z][$s] // [])[]' "$reg" 2>/dev/null | tr '\n' ' ')
    elif command -v python3 &>/dev/null; then
        result=$(python3 - "$reg" "$zone" "$sk" <<'PYEOF' 2>/dev/null
import json, sys
try:
    reg, zone, sk = sys.argv[1], sys.argv[2], sys.argv[3]
    print(' '.join(json.load(open(reg)).get(zone, {}).get(sk, [])))
except: pass
PYEOF
)
    fi
    echo "${result}" | xargs
}

# Check one host in optimised order (fail fast, fewest bytes first):
#   1. HEAD /          → directory Last-Modified  (1 cheap request, skip stale early)
#   2. GET  status txt → "Sync completed."        (small file, confirm node is ready)
#   3. GET  /          → directory listing        (parse tar/sha filenames)
#   4. HEAD /$tar      → precise .tar.gz age      (exact file timestamp)
# On pass: appends "https://$host" to READY_SOURCES; sets _HOST_TAR_NAME/_HOST_SHA_NAME
# from the first passing host. Returns 0=pass, 1=skip.
# Args: host  max_age_days
_check_and_add_host() {
    local host="$1" max_age="$2" site_key="${3:-}"
    local base="https://$host"

    # 1. HEAD / — quick directory freshness check before downloading anything
    local dir_lm dir_age=0
    dir_lm=$(curl -fsSI --max-time 8 "$base/" 2>/dev/null \
        | grep -i '^last-modified:' | cut -d' ' -f2- | tr -d '\r') || true
    if [[ -n "$dir_lm" ]]; then
        local dir_ts; dir_ts=$(date -d "$dir_lm" +%s 2>/dev/null) || true
        [[ -n "$dir_ts" ]] && dir_age=$(( ( $(date +%s) - dir_ts ) / 86400 ))
        if (( dir_age > max_age )); then
            warn "$host: directory is ${dir_age} day(s) old — skipping."; return 1
        fi
    else
        # No Last-Modified on root — server may not be reachable at all
        curl -fsSI --max-time 8 "$base/" &>/dev/null \
            || { warn "$host: unreachable — skipping."; return 1; }
    fi

    # 2. GET check_status_before_download.txt — confirm node sync is complete
    local status_content
    status_content=$(curl -fsSL --max-time 15 \
        "$base/check_status_before_download.txt" 2>/dev/null) \
        || { warn "$host: status file unavailable — skipping."; return 1; }
    echo "$status_content" | grep -q "Sync completed." \
        || { warn "$host: not synced ($(echo "$status_content" | head -1)) — skipping."; return 1; }

    # 3. GET / — directory listing to discover tar/sha filenames
    local index
    index=$(curl -fsSL --max-time 15 "$base/" 2>/dev/null) \
        || { warn "$host: directory listing failed — skipping."; return 1; }
    local tname sname
    tname=$(echo "$index" | grep -oP 'href="\K[^"]*\.tar\.gz' | grep -v '^\.\.' | head -1)
    sname=$(echo "$index" | grep -oP 'href="\K[^"]*\.sha256'  | grep -v '^\.\.' | head -1)
    [[ -z "$tname" ]] && { warn "$host: no .tar.gz in directory listing — skipping."; return 1; }

    # 3b. Verify tar filename matches the expected site_key type
    if [[ -n "$site_key" ]]; then
        local _type_ok=true
        case "$site_key" in
            fullmain)  echo "$tname" | grep -qi "full"   && echo "$tname" | grep -qi "mainnet" || _type_ok=false ;;
            prunemain) echo "$tname" | grep -qi "pruned" && echo "$tname" | grep -qi "mainnet" || _type_ok=false ;;
            prunetest) echo "$tname" | grep -qi "pruned" && echo "$tname" | grep -qi "testnet" || _type_ok=false ;;
        esac
        if [[ "$_type_ok" == false ]]; then
            warn "$host: tar '$tname' does not match expected type (${site_key}) — skipping."
            return 1
        fi
    fi

    # 4. HEAD /$tname — precise file age on the actual .tar.gz
    local last_mod age_days=0
    last_mod=$(curl -fsSI --max-time 10 "$base/$tname" 2>/dev/null \
        | grep -i '^last-modified:' | cut -d' ' -f2- | tr -d '\r')
    if [[ -n "$last_mod" ]]; then
        local fts; fts=$(date -d "$last_mod" +%s 2>/dev/null) || true
        [[ -n "$fts" ]] && age_days=$(( ( $(date +%s) - fts ) / 86400 ))
        if (( age_days > max_age )); then
            warn "$host: chain data is ${age_days} day(s) old (limit: ${max_age}) — skipping."
            return 1
        fi
        success "$host: chain data is ${age_days} day(s) old — OK."
    else
        info "$host: Last-Modified unavailable — allowing."
    fi

    READY_SOURCES+=("$base")
    [[ -z "${_HOST_TAR_NAME:-}" ]] && _HOST_TAR_NAME="$tname"
    [[ -z "${_HOST_SHA_NAME:-}" ]] && _HOST_SHA_NAME="${sname:-}"
    return 0
}

download_chain_data() {
    local network="$1"
    local mode="$2"

    step_header "Step 9: Chain Data Source & Transfer Mode"

    # Check for an existing .tar.gz in the destination directory before downloading
    local existing_tar
    existing_tar=$(find "$GRIN_DIR" -maxdepth 1 -name "*.tar.gz" 2>/dev/null | head -1)
    if [[ -n "$existing_tar" ]]; then
        warn "Existing archive found: $(basename "$existing_tar")"
        echo -e "  ${GREEN}y${RESET}) Remove and download a fresh copy"
        echo -e "  ${RED}n${RESET}) Keep it and continue"
        echo -e "  ${DIM}0${RESET}) Return to main menu"
        echo ""
        echo -ne "${BOLD}Remove existing archive? [Y/n/0]: ${RESET}"
        read -r rm_choice || true
        case "${rm_choice,,}" in
            0) exit 0 ;;
            n) info "Keeping existing archive. Proceeding..." ;;
            *)
                rm -f "$existing_tar"
                # Also clean up any leftover .sha256 so checksums don't mismatch
                find "$GRIN_DIR" -maxdepth 1 -name "*.sha256" -delete 2>/dev/null || true
                success "Existing archive removed. Downloading fresh copy..."
                ;;
        esac
    fi

    local site_key
    site_key=$(_get_site_key "$network" "$mode")

    # ── Zone selection ─────────────────────────────────────────────────────────
    local REGISTRY
    REGISTRY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../extensions/grinmasternodes.json"

    local _zone_order=(america asia europe africa)

    if [[ ! -f "$REGISTRY" ]]; then
        warn "grinmasternodes.json not found — using built-in America servers."
        SELECTED_ZONE="america"
    else
        echo ""
        echo -e "${BOLD}  Select a download zone:${RESET}"
        echo ""
        local _zi=1
        for _z in "${_zone_order[@]}"; do
            local _zh _zcount=0
            _zh=$(_get_zone_hosts "$_z" "$site_key" "$REGISTRY")
            [[ -n "$_zh" ]] && read -r -a _tmp_arr <<< "$_zh" && _zcount=${#_tmp_arr[@]}
            if (( _zcount > 0 )); then
                printf "  ${GREEN}%d${RESET}) %-10s  ${DIM}[%d server(s)]${RESET}\n" \
                    "$_zi" "${_z^}" "$_zcount"
            else
                printf "  ${CYAN}%d${RESET}) %-10s  ${DIM}[using America servers]${RESET}\n" \
                    "$_zi" "${_z^}"
            fi
            _zi=$(( _zi + 1 ))
        done
        echo -e "  ${DIM}0${RESET}) Skip  ${DIM}(use all known servers, shuffled)${RESET}"
        echo ""
        echo -ne "${BOLD}Zone [1]: ${RESET}"
        local _zone_choice
        read -r _zone_choice || true
        _zone_choice="${_zone_choice:-1}"

        if [[ "$_zone_choice" == "0" ]]; then
            SELECTED_ZONE="all"
        elif [[ "$_zone_choice" =~ ^[1-4]$ ]]; then
            SELECTED_ZONE="${_zone_order[$(( _zone_choice - 1 ))]}"
        else
            warn "Invalid zone '${_zone_choice}' — defaulting to America."
            SELECTED_ZONE="america"
        fi
    fi

    # ── Resolve zone to host list ───────────────────────────────────────────────
    local _resolved_hosts=""
    if [[ "$SELECTED_ZONE" == "all" ]]; then
        for _z in "${_zone_order[@]}"; do
            local _zh; _zh=$(_get_zone_hosts "$_z" "$site_key" "$REGISTRY")
            [[ -n "$_zh" ]] && _resolved_hosts+=" $_zh"
        done
    else
        _resolved_hosts=$(_get_zone_hosts "$SELECTED_ZONE" "$site_key" "$REGISTRY")
        if [[ -z "$_resolved_hosts" ]]; then
            info "No ${SELECTED_ZONE^} servers for ${site_key} — using America servers."
            _resolved_hosts=$(_get_zone_hosts "america" "$site_key" "$REGISTRY")
            SELECTED_ZONE="america"
        fi
    fi

    # ── Build hosts array (deduplicate, then shuffle) ───────────────────────────
    local hosts=()
    mapfile -t hosts < <(tr ' ' '\n' <<< "$_resolved_hosts" | grep -v '^$' | sort -u | shuf)

    info "Checking zone hosts (sync status + file age ≤ 7 days)..."
    local h; for h in "${hosts[@]}"; do info "  → $h"; done

    # Combined check: sync-status + directory listing + file age per host
    local _MAX_AGE_DAYS=5
    local _HOST_TAR_NAME="" _HOST_SHA_NAME=""
    READY_SOURCES=()
    for host in "${hosts[@]}"; do
        _check_and_add_host "$host" "$_MAX_AGE_DAYS" "$site_key" || true
    done

    # Auto-fallback to America hardcoded hosts if selected zone yielded nothing
    if [[ ${#READY_SOURCES[@]} -eq 0 && "$SELECTED_ZONE" != "america" && "$SELECTED_ZONE" != "all" ]]; then
        info "No fresh hosts in ${SELECTED_ZONE^} — trying America fallback..."
        local _am_hosts=()
        mapfile -t _am_hosts < <(
            _get_zone_hosts "america" "$site_key" "$REGISTRY" | tr ' ' '\n' | grep -v '^$' | shuf
        )
        for host in "${_am_hosts[@]}"; do
            _check_and_add_host "$host" "$_MAX_AGE_DAYS" "$site_key" || true
        done
        [[ ${#READY_SOURCES[@]} -gt 0 ]] && SELECTED_ZONE="america"
    fi

    # All known hosts failed — prompt for custom URL or exit
    if [[ ${#READY_SOURCES[@]} -eq 0 ]]; then
        echo ""
        warn "All known sources are unavailable or have chain data older than ${_MAX_AGE_DAYS} days."
        echo ""
        while true; do
            echo -e "  Enter a ${BOLD}custom base URL${RESET}  ${DIM}(e.g. https://example.com)${RESET}"
            echo -e "  ${GREEN}0${RESET} — return to master script"
            echo ""
            echo -ne "${DIM}[Custom URL / 0 = main menu]: ${RESET}"
            local custom_url
            read -r custom_url || true
            case "${custom_url:-}" in
                0)
                    exit 0
                    ;;
                "")
                    warn "No URL entered — try again or press 0 to return."
                    echo ""
                    continue
                    ;;
                *)
                    custom_url="${custom_url%/}"   # strip trailing slash
                    info "Checking custom source: $custom_url"
                    local custom_status
                    custom_status=$(curl -fsSL --max-time 15 "${custom_url}/check_status_before_download.txt" 2>/dev/null) || true
                    if echo "$custom_status" | grep -q "Sync completed."; then
                        READY_SOURCES=("$custom_url")
                        success "Custom source ready: $custom_url"
                        break
                    fi
                    # Status file absent or not ready — check directory listing for files
                    local custom_index
                    custom_index=$(curl -fsSL --max-time 15 "${custom_url}/" 2>/dev/null) || true
                    if echo "$custom_index" | grep -q '\.tar\.gz'; then
                        READY_SOURCES=("$custom_url")
                        info "Custom source has chain data files — proceeding without status check."
                        break
                    fi
                    warn "No usable chain data found at $custom_url"
                    warn "Check the URL is reachable and contains .tar.gz files, then try again."
                    echo ""
                    ;;
            esac
        done
    fi

    # Filenames already discovered during per-host checks above
    local tar_name sha_name
    tar_name="$_HOST_TAR_NAME"
    sha_name="$_HOST_SHA_NAME"

    [[ -z "$tar_name" ]] && die "No .tar.gz filename found from any ready source."
    [[ -z "$sha_name" ]] && die "No .sha256 filename found from any ready source."

    TAR_FILE="$GRIN_DIR/$tar_name"
    SHA_FILE="$GRIN_DIR/$sha_name"

    # ── Ask user: on-the-fly stream or full download ───────────────────────────
    echo ""
    echo -e "${BOLD}  How do you want to get the chain data?${RESET}"
    echo ""
    echo -e "  ${GREEN}1${RESET}) ${BOLD}On-the-fly extraction${RESET} ${DIM}(default — stream directly, no full download)${RESET}"
    echo -e "     ${DIM}Pipes the remote archive straight into tar without saving locally.${RESET}"
    echo -e "     ${DIM}cmd: wget -O - <url> | tar -xzvf -${RESET}"
    echo -e "     ${DIM}Saves temporary disk space and reduces total setup time.${RESET}"
    echo -e "     ${DIM}Auto-switches to the next source if the stream fails mid-transfer.${RESET}"
    echo -e "     ${DIM}Note: SHA256 checksum verification is skipped in this mode.${RESET}"
    echo ""
    echo -e "  ${CYAN}2${RESET}) ${BOLD}Full download first${RESET} ${DIM}(more resilient on slow connections)${RESET}"
    echo -e "     ${DIM}Downloads .tar.gz to disk (wget -c, supports resume on interruption).${RESET}"
    echo -e "     ${DIM}Verifies SHA256 checksum before extracting.${RESET}"
    echo -e "     ${DIM}Auto-switches to the next source if download fails mid-transfer.${RESET}"
    echo ""
    echo -ne "${BOLD}Choose [1/2] (default: 1): ${RESET}"
    local dl_choice
    read -r dl_choice || true

    if [[ "${dl_choice:-1}" == "1" ]]; then
        STREAM_MODE=true
        info "On-the-fly extraction selected. Streaming will begin at Step 10."
        log "[STEP 9] On-the-fly mode. zone=$SELECTED_ZONE sources=(${READY_SOURCES[*]}) tar=$tar_name"
        return 0
    fi

    # ── Full download mode ─────────────────────────────────────────────────────
    STREAM_MODE=false

    info "Downloading checksum file: $sha_name"
    curl -fsSL "${READY_SOURCES[0]}/$sha_name" -o "$SHA_FILE" \
        || die "Failed to download checksum file."
    success "Checksum saved: $SHA_FILE"

    info "Downloading chain data: $tar_name"
    info "(Large file — progress shown below. Auto-switches source on failure.)"
    local dl_ok=false
    local src_num=0 total_src=${#READY_SOURCES[@]}
    for src_base in "${READY_SOURCES[@]}"; do
        src_num=$(( src_num + 1 ))
        info "Trying source $src_num/$total_src: $src_base"
        if wget -c --progress=bar:force -O "$TAR_FILE" "$src_base/$tar_name"; then
            dl_ok=true
            success "Chain data downloaded from $src_base"
            break
        else
            warn "Download failed from $src_base."
            rm -f "$TAR_FILE"
            if [[ $src_num -lt $total_src ]]; then
                warn "Switching to source $((src_num + 1))/$total_src..."
            fi
        fi
    done
    [[ "$dl_ok" == "true" ]] || die "Chain data download failed from all available sources."

    success "Chain data downloaded: $TAR_FILE"
    log "[STEP 9] Downloaded $tar_name (full download mode) zone=$SELECTED_ZONE"
}

# =============================================================================
# [10] VERIFY SHA256 CHECKSUM
# -----------------------------------------------------------------------------
# Runs 'sha256sum -c' against the downloaded .sha256 file to verify the
# integrity of the chain data archive. If verification fails, shows error with
# guidance and waits for user before exiting — tar must NOT be extracted on mismatch.
# =============================================================================
verify_checksum() {
    step_header "Step 10: SHA256 Verification"
    info "Running: sha256sum -c $(basename "$SHA_FILE")"

    (cd "$GRIN_DIR" && sha256sum -c "$(basename "$SHA_FILE")" 2>&1 | tee -a "$LOG_FILE") \
        || die "SHA256 checksum FAILED. The download may be corrupted. Exiting."

    success "Checksum verification passed."
    log "[STEP 10] Checksum OK."
}

# =============================================================================
# [11] VERIFY SUFFICIENT DISK SPACE ON /
# -----------------------------------------------------------------------------
# Reads the size of the downloaded .tar.gz file, then checks that the
# currently available free space on / is at least: tar_size + 20%.
# This ensures there is enough headroom to fully extract the archive.
# If space is insufficient, shows error with how much is needed and waits for user.
# =============================================================================
check_disk_space() {
    step_header "Step 11: Disk Space Check"

    local tar_size
    tar_size=$(stat -c%s "$TAR_FILE")

    # Required free = tar_size * 1.2  (bash integer: tar + tar/5)
    local required=$(( tar_size + tar_size / 5 ))

    # Available bytes on /
    local available
    available=$(df -B1 / | awk 'NR==2 {print $4}')

    # Human-readable
    local tar_hr req_hr avail_hr
    tar_hr=$(numfmt   --to=iec-i --suffix=B "$tar_size"  2>/dev/null || echo "${tar_size} B")
    req_hr=$(numfmt   --to=iec-i --suffix=B "$required"  2>/dev/null || echo "${required} B")
    avail_hr=$(numfmt --to=iec-i --suffix=B "$available" 2>/dev/null || echo "${available} B")

    info "Archive size        : $tar_hr"
    info "Required free (×1.2): $req_hr"
    info "Available on /      : $avail_hr"

    if [[ $available -lt $required ]]; then
        die "Insufficient disk space. Need $req_hr free, only $avail_hr available. Free up space and retry."
    fi
    success "Disk space check passed."
    log "[STEP 11] tar=$tar_size required=$required available=$available"
}

# =============================================================================
# [12] EXTRACT CHAIN DATA INTO NODE DIRECTORY
# -----------------------------------------------------------------------------
# First checks if $GRIN_DIR/chain_data already exists and asks the user:
#   Yes → remove the existing chain_data directory before extracting (clean slate)
#   No  → proceed with extraction without removing (existing files may be overwritten)
# After successful extraction, removes the .tar.gz and .sha256 to reclaim space.
# Shows error with guidance if extraction fails (e.g. corrupted archive or disk error).
# =============================================================================
extract_chain_data() {
    step_header "Step 12: Extract Chain Data"

    # Check for an existing chain_data directory before extracting
    if [[ -d "$GRIN_DIR/chain_data" ]]; then
        warn "Existing chain_data directory found: $GRIN_DIR/chain_data"
        echo -e "  ${GREEN}y${RESET}) Remove and extract fresh"
        echo -e "  ${RED}n${RESET}) Keep it (existing files may be overwritten)"
        echo -e "  ${DIM}0${RESET}) Return to main menu"
        echo ""
        echo -ne "${BOLD}Remove existing chain_data? [y/N/0]: ${RESET}"
        read -r rm_choice || true
        case "${rm_choice,,}" in
            y)
                info "Removing existing chain_data..."
                rm -rf "$GRIN_DIR/chain_data"
                success "Existing chain_data removed. Starting fresh extraction..."
                ;;
            0) exit 0 ;;
            *) info "Keeping existing chain_data. Starting extraction (existing files may be overwritten)..." ;;
        esac
    fi

    info "Extracting $(basename "$TAR_FILE") → $GRIN_DIR ..."

    tar -xzf "$TAR_FILE" -C "$GRIN_DIR" 2>&1 | tee -a "$LOG_FILE" \
        || die "Extraction failed. Check disk space and file integrity."

    success "Extraction complete."
    info "Removing downloaded archive to free disk space..."
    rm -f "$TAR_FILE" "$SHA_FILE"
    success "Archive files removed."
    log "[STEP 12] Extraction complete. Archives removed."
}

# =============================================================================
# [STREAM] EXTRACT CHAIN DATA ON-THE-FLY  (no local archive)
# -----------------------------------------------------------------------------
# Pipes the remote .tar.gz directly into tar without saving it locally:
#   wget -O - <url> | tar -xzvf - -C "$GRIN_DIR"
# All ready sources from READY_SOURCES are tried in order. On failure, any
# partially extracted chain_data directory is removed before retrying.
# Steps 10 (SHA256) and 11 (disk space) are skipped in this mode.
# =============================================================================
stream_extract_chain_data() {
    step_header "Step 10: Extract Chain Data (On-the-fly)"

    local tar_name="${TAR_FILE##*/}"

    # Handle existing chain_data directory (same prompt as full-download mode)
    if [[ -d "$GRIN_DIR/chain_data" ]]; then
        warn "Existing chain_data directory found: $GRIN_DIR/chain_data"
        echo -e "  ${GREEN}y${RESET}) Remove and extract fresh"
        echo -e "  ${RED}n${RESET}) Keep it (existing files may be overwritten)"
        echo -e "  ${DIM}0${RESET}) Return to main menu"
        echo ""
        echo -ne "${BOLD}Remove existing chain_data? [y/N/0]: ${RESET}"
        read -r rm_choice || true
        case "${rm_choice,,}" in
            y)
                info "Removing existing chain_data..."
                rm -rf "$GRIN_DIR/chain_data"
                success "Existing chain_data removed. Starting fresh extraction..."
                ;;
            0) exit 0 ;;
            *) info "Keeping existing chain_data. Continuing (existing files may be overwritten)..." ;;
        esac
    fi

    local stream_ok=false
    local src_num=0 total_src=${#READY_SOURCES[@]}
    for src_base in "${READY_SOURCES[@]}"; do
        src_num=$(( src_num + 1 ))
        local tar_url="$src_base/$tar_name"
        info "Source $src_num/$total_src: $tar_url"
        info "Running: wget -O - \"$tar_url\" | tar -xzvf - -C \"$GRIN_DIR\""
        [[ $total_src -gt 1 ]] && warn "If this stream fails mid-transfer, the next source will be tried automatically."
        echo ""
        log "[STEP 10] Streaming from $tar_url"
        if wget --progress=bar:force -O - "$tar_url" \
                | tar -xzvf - -C "$GRIN_DIR"; then
            stream_ok=true
            break
        else
            warn "Stream failed from $src_base."
            if [[ -d "$GRIN_DIR/chain_data" ]]; then
                warn "Removing partial extraction..."
                rm -rf "$GRIN_DIR/chain_data"
            fi
            if [[ $src_num -lt $total_src ]]; then
                warn "Switching to source $((src_num + 1))/$total_src..."
                echo ""
            fi
        fi
    done

    [[ "$stream_ok" == "true" ]] \
        || die "On-the-fly extraction failed from all available sources. Retry or choose full download mode."

    success "On-the-fly extraction complete."
    log "[STEP 10] On-the-fly extraction complete."
}

# tmux session name convention: grin_<nodetype>_<networktype>
_grin_session_name() {
    case "$(basename "${1:-}")" in
        mainnet-full)  echo "grin_full_mainnet"   ;;
        mainnet-prune) echo "grin_pruned_mainnet" ;;
        testnet-prune) echo "grin_pruned_testnet" ;;
        *)             echo "grin_$(basename "${1:-}")" ;;
    esac
}

# =============================================================================
# HELPER: CHECK IF A GRIN PROCESS IS RUNNING FOR A SPECIFIC NODE DIRECTORY
# -----------------------------------------------------------------------------
# Uses /proc/<pid>/cwd to match the process working directory so we distinguish
# mainnet vs testnet nodes even when both are installed.
# Returns 0 (found) or 1 (not found).
# =============================================================================
_grin_proc_for_dir() {
    local dir="$1"
    local pid
    while IFS= read -r pid; do
        local cwd
        cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) || continue
        [[ "$cwd" == "$dir" ]] && return 0
    done < <(pgrep -f 'grin server run' 2>/dev/null || true)
    return 1
}

# =============================================================================
# [13] START GRIN NODE IN A TMUX SESSION
# -----------------------------------------------------------------------------
# Creates a named tmux session: grin_<nodetype>_<networktype>
#   e.g. grin_full_mainnet, grin_pruned_mainnet, grin_pruned_testnet
# If a session with that name already exists, it is killed first.
# Runs './grin server run' inside the session so the node starts in TUI mode.
# The session stays open after grin exits so the user can read any output.
# Attach with: tmux attach -t <session>   |   Detach: Ctrl+B then D
# =============================================================================
start_grin_tmux() {
    step_header "Step 13: Start Grin Node (tmux)"
    local session; session="$(_grin_session_name "$GRIN_DIR")"

    # ── Boot/duplication guard ────────────────────────────────────────────────
    # If a grin process already owns this node directory (booting or running but
    # port not yet bound), check whether it has a live tmux session.
    #   • Live process  + live tmux session → truly running, skip to avoid grin.lock conflict.
    #   • Live process  + NO  tmux session  → orphaned/stale (tmux was killed while grin kept
    #     running, re-parented to PID 1).  Kill the stale process and proceed with a fresh start.
    if _grin_proc_for_dir "$GRIN_DIR"; then
        if tmux has-session -t "$session" 2>/dev/null; then
            warn "Grin is already starting or running in $GRIN_DIR — skipping duplicate launch."
            info "Wait for the node to finish booting, then re-run if needed."
            return 0
        else
            warn "Orphaned Grin process detected in $GRIN_DIR (no tmux session). Killing stale process..."
            while IFS= read -r _stale_pid; do
                local _stale_cwd
                _stale_cwd=$(readlink "/proc/$_stale_pid/cwd" 2>/dev/null) || continue
                if [[ "$_stale_cwd" == "$GRIN_DIR" ]]; then
                    info "  Killing PID $_stale_pid (cwd=$_stale_cwd)"
                    kill -KILL "$_stale_pid" 2>/dev/null || true
                fi
            done < <(pgrep -f 'grin server run' 2>/dev/null || true)
            sleep 1
            info "Stale process cleared — proceeding with fresh start."
        fi
    fi

    if tmux has-session -t "$session" 2>/dev/null; then
        warn "Tmux session '$session' already exists — killing it first."
        tmux kill-session -t "$session" 2>/dev/null || true
    fi

    # Own the directory and run process as grin service user if available
    if id grin &>/dev/null; then
        local _par; _par="$(dirname "$GRIN_DIR")"
        local _base; _base="$(dirname "$_par")"
        [[ -d "$_base" ]] && chown -R grin:grin "$_base" 2>/dev/null || true
        tmux new-session -d -s "$session" -c "$GRIN_DIR" \
            "echo 'Starting Grin node...'; su -s /bin/bash -c 'cd \"$GRIN_DIR\" && ./grin server run' grin; echo ''; echo 'Grin process exited. Press Enter to close.'; read" \
            || die "Failed to create tmux session '$session'. Is tmux installed and working?"
    else
        warn "User 'grin' not found — running as current user. Create it via Script 08 → option 10."
        tmux new-session -d -s "$session" -c "$GRIN_DIR" \
            "echo 'Starting Grin node...'; cd $GRIN_DIR && ./grin server run; echo ''; echo 'Grin process exited. Press Enter to close.'; read" \
            || die "Failed to create tmux session '$session'. Is tmux installed and working?"
    fi

    success "Grin node will start shortly within 30 seconds in tmux session: $session."
    info "  Attach  : tmux attach -t $session"
    info "  Detach  : Ctrl+B, then D"
    info "  List    : tmux ls"
    log "[STEP 13] Tmux session=$session started."
}

# =============================================================================
# [14] SHOW RESULT SUMMARY AND LOG ELAPSED TIME
# -----------------------------------------------------------------------------
# Prints a summary of the completed setup: network, mode, directory, tmux
# session name, total time taken, and log file path.
# Full log is written to: log/01_build_new_grin_node.log (relative to toolkit).
# =============================================================================
show_summary() {
    local network="$1"
    local mode="$2"
    local elapsed=$(( $(date +%s) - SCRIPT_START_TIME ))
    local mins=$(( elapsed / 60 ))
    local secs=$(( elapsed % 60 ))
    local session; session="$(_grin_session_name "$GRIN_DIR")"

    echo ""
    echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${GREEN}  Grin Node Setup Complete!${RESET}"
    echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Network      : ${CYAN}$network${RESET}"
    echo -e "  Mode         : ${CYAN}$mode${RESET}"
    echo -e "  Directory    : ${CYAN}$GRIN_DIR${RESET}"
    echo -e "  Tmux session : ${CYAN}$session${RESET}"
    echo -e "  Time taken   : ${CYAN}${mins}m ${secs}s${RESET}"
    echo -e "  Log file     : ${CYAN}$LOG_FILE${RESET}"
    echo ""
    echo -e "${BOLD}  Quick commands:${RESET}"
    echo -e "  ${YELLOW}tmux attach -t $session${RESET}   — view node output"
    echo -e "  ${YELLOW}tmux ls${RESET}                   — list sessions"
    echo ""
    echo -e "  ${YELLOW}⚠  Remember:${RESET} schedule auto-start on reboot via"
    echo -e "     ${BOLD}3) Share Grin Chain Data / Schedule${RESET} → option ${GREEN}G) Auto startup Grin node${RESET}"
    echo -e "${BOLD}${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

    log "[STEP 14] DONE. network=$network mode=$mode dir=$GRIN_DIR time=${mins}m${secs}s"
}

# =============================================================================
# Save grin instance paths to shared conf file for use by other scripts (e.g. 03).
# Only the block for the current key is replaced — other instances are untouched.
# =============================================================================
save_instance_location() {
    local network="$1" mode="$2"
    local key
    if [[ "$mode" == "full" ]]; then
        key="FULLMAIN"
    elif [[ "$network" == "testnet" ]]; then
        key="PRUNETEST"
    else
        key="PRUNEMAIN"
    fi

    mkdir -p "$CONF_DIR"
    if [[ -f "$INSTANCES_CONF" ]]; then
        # Remove current key and, for mainnet, also remove the sibling mainnet key
        # (PRUNEMAIN and FULLMAIN are mutually exclusive — one server, one mainnet mode)
        sed -i "/^${key}_/d" "$INSTANCES_CONF"
        [[ "$key" == "FULLMAIN"  ]] && sed -i '/^PRUNEMAIN_/d' "$INSTANCES_CONF"
        [[ "$key" == "PRUNEMAIN" ]] && sed -i '/^FULLMAIN_/d'  "$INSTANCES_CONF"
    fi
    cat >> "$INSTANCES_CONF" << __EOF__

${key}_GRIN_DIR="$GRIN_DIR"
${key}_BINARY="$GRIN_DIR/grin"
${key}_TOML="$GRIN_DIR/grin-server.toml"
${key}_CHAIN_DATA="$GRIN_DIR/chain_data"
__EOF__
    chmod 600 "$INSTANCES_CONF"
    log "Instance location saved: $key → $GRIN_DIR"
}

# =============================================================================
# [ORCHESTRATOR] FULL SETUP FLOW FOR ONE NETWORK
# -----------------------------------------------------------------------------
# Calls steps 4–14 in sequence for a single network (mainnet or testnet).
# Resets per-node state variables at the end so the flow can be repeated
# cleanly for the second network when "Both" is selected.
# =============================================================================
setup_one_node() {
    local network="$1"

    select_archive_mode "$network"
    create_node_dir     "$network" "$ARCHIVE_MODE"
    download_grin_binary
    generate_config     "$network"
    patch_config        "$network" "$ARCHIVE_MODE"
    generate_secrets
    download_chain_data "$network" "$ARCHIVE_MODE"
    if [[ "$STREAM_MODE" == "true" ]]; then
        stream_extract_chain_data
    else
        verify_checksum
        check_disk_space
        extract_chain_data
    fi
    ensure_grin_user
    start_grin_tmux
    show_summary        "$network" "$ARCHIVE_MODE"
    save_instance_location "$network" "$ARCHIVE_MODE"

    # Reset per-node state
    GRIN_DIR=""
    TAR_FILE=""
    SHA_FILE=""
    ARCHIVE_MODE=""
    STREAM_MODE=false
    READY_SOURCES=()
}

# =============================================================================
# Main
# =============================================================================
main() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 01) Grin Node Setup — Build New Node${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    log "=== Grin Node Build Started ==="

    check_grin_running
    check_os_and_deps
    select_network

    case "$NETWORK_TYPE" in
        mainnet|testnet)
            setup_one_node "$NETWORK_TYPE"
            ;;
        both)
            info "Setting up MAINNET node first..."
            setup_one_node "mainnet"
            echo ""
            echo -e "${BOLD}${CYAN}Mainnet done. Proceeding to TESTNET setup...${RESET}"
            sleep 2
            setup_one_node "testnet"
            ;;
    esac

    # Step 15: Return to main menu
    echo ""
    while true; do
        echo -ne "${BOLD}Enter ${GREEN}0${RESET}${BOLD} to return to the main menu: ${RESET}"
        read -r ret || true
        [[ "${ret:-}" == "0" ]] && break
    done
}

main "$@"
