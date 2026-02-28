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
#       tar  openssl  libncurses5  tmux  jq  tor  curl  wget
#
# NETWORK & ARCHIVE MODES
#   Networks  : Mainnet  |  Testnet  |  Both (mainnet first, then testnet)
#   Archives  : Pruned (default, smaller)  |  Full (mainnet only, full UTXO history)
#   Note: Full archive mode is NOT available for testnet.
#
# NODE DIRECTORIES  (created at filesystem root /)
#   /grinprunemain   — pruned,       mainnet
#   /grinfullmain    — full archive, mainnet
#   /grinprunetest   — pruned,       testnet
#
# SETUP PIPELINE  (14 steps, run automatically)
#   Step  1 — Process & Port Check
#              Scans for running 'grin' processes (excluding the toolkit's own
#              scripts) and occupied ports (3413 API, 3414 P2P mainnet,
#              13414 P2P testnet, 3415 wallet).
#              Prompts to kill conflicts before continuing.
#
#   Step  2 — Dependency Check
#              Installs any missing packages via apt-get. OS version check is
#              handled upstream by the master script.
#
#   Step  3 — Network Selection
#              User chooses: 1) Mainnet  2) Testnet  3) Both
#              When "Both" is selected, steps 4–14 run for mainnet, then repeat
#              for testnet automatically. Each network gets its own node
#              directory (/grinprunemain, /grinprunetest) with its own binary.
#
#   Step  4 — Archive Mode Selection  (once per network)
#              User chooses: 1) Pruned  2) Full archive (mainnet only)
#
#   Step  5 — Create Node Directory
#              Creates the target node directory (e.g. /grinprunemain).
#              Prompts before reusing if it already exists.
#
#   Step  6 — Download Grin Binary
#              Queries the GitHub API for the latest release and downloads the
#              linux-x86_64 tar.gz asset, then installs the 'grin' binary into
#              the node directory. When building both networks, the binary is
#              downloaded from GitHub once and copied into each node directory
#              separately — no second download needed.
#
#   Step  7 — Generate grin-server.toml
#              Runs './grin server config' (with HOME overridden to the node
#              directory) to produce a fresh default config. Any pre-existing
#              config is backed up with a timestamp suffix before generation.
#              No fallback minimal config — only the grin-generated file is used.
#
#   Step  8 — Patch grin-server.toml
#              Applies user choices to the generated config:
#                chain_type   → "Mainnet" or "Testnet"
#                archive_mode → true (full) or false (pruned)
#                db_root      → <node_dir>/chain_data
#              For testnet, also changes ports: 3413 → 13413, 3414 → 13414,
#                3415 → 13415, 3416 → 13416.
#
#   Step  9 — Download Chain Data
#              Downloads pre-synced chain data. Three known hosts tried in order:
#                *.grin.money    — primary
#                *.grinily.com   — backup 1
#                *.onlygrins.com — backup 2
#              Each host is checked via check_status_before_download.txt — only
#              used if status says "Sync completed."
#              If all 3 fail, prompts the user to enter a custom base URL or
#              press 0 to return to the master script.
#              Prompts to remove any existing .tar.gz before downloading fresh.
#
#   Step 10 — SHA256 Checksum Verification
#              Runs 'sha256sum -c' against the downloaded .sha256 file.
#              Exits immediately on mismatch — never extracts a corrupt archive.
#
#   Step 11 — Disk Space Check
#              Requires at least  tar_size × 1.2  free on / before extracting.
#              Shows archive size, required space, and available space.
#
#   Step 12 — Extract Chain Data
#              Extracts the tar.gz into the node directory. Prompts to remove
#              an existing chain_data directory before extraction if found.
#              Deletes .tar.gz and .sha256 after successful extraction to
#              reclaim disk space.
#
#   Step 13 — Start Node in Tmux
#              Creates a named tmux session (e.g. grin_grinprunemain) and runs
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
GRIN_GITHUB_API="https://api.github.com/repos/mimblewimble/grin/releases/latest"

# --- Session state (reset per node) ---
NETWORK_TYPE=""
ARCHIVE_MODE=""
GRIN_DIR=""
TAR_FILE=""
SHA_FILE=""
GRIN_BIN_TMP=""        # cache binary between mainnet+testnet setups
RESTRICTED_NETWORK=""  # set by check_grin_running if one slot is already occupied

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
# [1] CHECK FOR RUNNING GRIN PROCESSES AND PORT CONFLICTS
# -----------------------------------------------------------------------------
# P2P ports 3414 (mainnet) and 13414 (testnet) are the authoritative indicators
# of a running node. One server can host at most two Grin instances — one per
# network. Archive mode on testnet is NOT supported.
#
# Scenarios:
#   Both 3414 + 13414 occupied → offer K to kill all & rebuild, or 0 to return to menu
#   Only 3414 occupied         → restrict to testnet installation; set RESTRICTED_NETWORK
#   Only 13414 occupied        → restrict to mainnet installation; set RESTRICTED_NETWORK
#   Neither occupied           → check for stale/orphaned grin processes and ports,
#                                offer to kill them before continuing
# =============================================================================
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
        error "Both mainnet and testnet are already running on this server."
        info  "A server can host at most two Grin instances (one per network)."
        echo ""
        local _both_choice
        while true; do
            echo -e "  ${RED}K${RESET} — kill all Grin processes & rebuild nodes"
            echo -e "  ${GREEN}0${RESET} — return to master script"
            echo ""
            echo -ne "${DIM}[K = kill & rebuild  /  0 = main menu]: ${RESET}"
            read -r _both_choice || true
            case "${_both_choice:-}" in
                [Kk])
                    stop_grin_gracefully
                    exec "$0"
                    ;;
                0)
                    exit 0
                    ;;
                *)
                    warn "Invalid input — press K to kill & rebuild, or 0 to return."
                    echo ""
                    ;;
            esac
        done
    fi

    # ── Only mainnet running → can install testnet alongside it ───────────────
    if $mainnet_running; then
        echo ""
        info "Mainnet node is running on port 3414 (PID: $mainnet_pid)."
        info "This server has one free slot — testnet can be installed alongside it."
        warn "Note: full archive mode is NOT available on testnet."
        RESTRICTED_NETWORK="testnet"
        success "Continuing with testnet installation."
        echo ""
        log "[STEP 1] Mainnet running (PID $mainnet_pid). Restricted to testnet."
        return
    fi

    # ── Only testnet running → can install mainnet alongside it ───────────────
    if $testnet_running; then
        echo ""
        info "Testnet node is running on port 13414 (PID: $testnet_pid)."
        info "This server has one free slot — mainnet can be installed alongside it."
        RESTRICTED_NETWORK="mainnet"
        success "Continuing with mainnet installation."
        echo ""
        log "[STEP 1] Testnet running (PID $testnet_pid). Restricted to mainnet."
        return
    fi

    # ── No legitimate node running → check for stale/orphaned processes ───────
    local found=0

    local grin_procs
    grin_procs=$(pgrep -a -f '[g]rin' 2>/dev/null \
        | grep -v -E "(grin-node-toolkit|build_new_grin_node)" \
        || true)
    if [[ -n "$grin_procs" ]]; then
        warn "Stale Grin processes detected:"
        while IFS= read -r line; do echo -e "  ${YELLOW}→${RESET} $line"; done <<< "$grin_procs"
        found=1
    fi

    local -A PORT_NAMES=([3413]="API" [3414]="P2P mainnet" [13414]="P2P testnet" [3415]="Wallet Listener")
    for port in 3413 3414 13414 3415; do
        local result
        result=$(ss -tlnp "sport = :$port" 2>/dev/null | tail -n +2 || true)
        if [[ -n "$result" ]]; then
            warn "Port $port (${PORT_NAMES[$port]}) is occupied:"
            echo -e "  ${YELLOW}→${RESET} $result"
            found=1
        fi
    done

    if [[ $found -eq 1 ]]; then
        echo ""
        echo -e "  ${GREEN}y${RESET}) Kill all conflicting processes and continue"
        echo -e "  ${YELLOW}c${RESET}) Continue anyway with warning only (if processes are unrelated to Grin)"
        echo -e "  ${RED}n${RESET}) Abort  (resolve manually)"
        echo -e "  ${DIM}0${RESET}) Return to main menu"
        echo ""
        echo -ne "${BOLD}${RED}Kill all and continue? [y/c/N/0]: ${RESET}"
        read -r confirm || true
        case "${confirm,,}" in
            y) stop_grin_gracefully ;;
            c) warn "Continuing despite detected processes — ensure they are NOT Grin-related." ; echo "" ;;
            0) exit 0 ;;
            *) die "Aborted. Resolve the conflicts manually and re-run." ;;
        esac
    else
        success "No Grin processes or port conflicts found."
    fi
    log "[STEP 1] Complete. No restrictions."
}

# =============================================================================
# [2] INSTALL DEPENDENCIES
# -----------------------------------------------------------------------------
# Checks the script is run as root, then installs any missing packages via
# apt-get: tar, openssl, libncurses5 (or libncurses6 on Ubuntu 24.04+),
# tmux, jq, tor, curl, wget.
# OS version check is handled upstream by the master script.
# =============================================================================
check_os_and_deps() {
    step_header "Step 2: Dependency Check"

    [[ $EUID -ne 0 ]] && die "This script must be run as root (sudo)."

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

    # If one network slot is already occupied, auto-select the other one.
    # "Both" is not offered — the occupied slot is already running.
    if [[ -n "$RESTRICTED_NETWORK" ]]; then
        NETWORK_TYPE="$RESTRICTED_NETWORK"
        info "Network auto-selected: ${BOLD}${NETWORK_TYPE}${RESET} (the other slot is already running)"
        log "[STEP 3] Network=$NETWORK_TYPE (auto-restricted)"
        return
    fi

    echo ""
    echo -e "  ${GREEN}1${RESET}) Mainnet  (default)"
    echo -e "  ${YELLOW}2${RESET}) Testnet"
    echo -e "  ${CYAN}3${RESET}) Both     (mainnet first, then testnet)"
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
    echo -e "  ${GREEN}1${RESET}) Pruned       (default, recommended — smaller storage)"
    echo -e "  ${YELLOW}2${RESET}) Full archive (mainnet only — full UTXO history)"
    echo -e "  ${DIM}0${RESET}) Return to main menu"

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
    info "Archive mode: $ARCHIVE_MODE"
    log "[STEP 4] ArchiveMode=$ARCHIVE_MODE"
}

# =============================================================================
# [5] CREATE NODE DIRECTORY
# -----------------------------------------------------------------------------
# Creates the node directory at / (root, not /root) using naming convention:
#   /grinfullmain   — full archive, mainnet
#   /grinprunemain  — pruned,       mainnet
#   /grinprunetest  — pruned,       testnet
# If the directory already exists, prompts to clean it (remove all contents)
# before proceeding — ensuring a fresh rebuild with no stale files.
# Sets the global GRIN_DIR variable used by all subsequent steps.
# =============================================================================
create_node_dir() {
    local network="$1"
    local mode="$2"
    local net_short mode_short

    [[ "$network" == "mainnet" ]] && net_short="main" || net_short="test"
    [[ "$mode"    == "full"    ]] && mode_short="full" || mode_short="prune"
    GRIN_DIR="/grin${mode_short}${net_short}"

    step_header "Step 5: Create Node Directory"
    info "Target directory: $GRIN_DIR"

    if [[ -d "$GRIN_DIR" ]]; then
        warn "Directory $GRIN_DIR already exists."
        echo -e "  ${GREEN}y${RESET}) Clean up and continue"
        echo -e "  ${RED}n${RESET}) Abort"
        echo -e "  ${DIM}0${RESET}) Return to main menu"
        echo ""
        echo -ne "${BOLD}Clean up this directory? [y/N/0]: ${RESET}"
        read -r ow || true
        case "${ow,,}" in
            y)
                info "Cleaning $GRIN_DIR ..."
                rm -rf "${GRIN_DIR:?}"/*  2>/dev/null || true
                rm -rf "${GRIN_DIR:?}"/.[!.]* 2>/dev/null || true
                success "Directory cleaned: $GRIN_DIR"
                ;;
            0) exit 0 ;;
            *) die "Aborted. Clean the directory manually or choose a different configuration." ;;
        esac
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
# If a grin-server.toml already exists in $GRIN_DIR, it is backed up with a
# timestamp suffix before generating a new one (e.g. grin-server.toml.bak.1234).
# Runs './grin server config' with HOME overridden to $GRIN_DIR so that grin
# writes its output config under our custom directory instead of /root.
# If 'grin server config' fails for any reason, the error is shown with guidance
# and the user must press Enter before exiting — no fallback minimal config.
# Only the freshly generated file is used.
# =============================================================================
generate_config() {
    step_header "Step 7: Generate grin-server.toml"
    local target="$GRIN_DIR/grin-server.toml"

    # If a grin-server.toml already exists, back it up with a timestamp so the
    # newly generated file is always a clean slate from 'grin server config'.
    if [[ -f "$target" ]]; then
        local backup="${target}.bak.$(date +%s)"
        mv "$target" "$backup" \
            || die "Failed to back up existing config to $backup."
        warn "Existing config backed up: $(basename "$backup")"
    fi

    info "Running: ./grin server config  (HOME overridden to $GRIN_DIR)"

    # Run 'grin server config' — no || true here.
    # If the command fails, the error is shown with fix guidance and user must press Enter.
    # There is NO fallback minimal config — only the grin-generated file is used.
    (cd "$GRIN_DIR" && HOME="$GRIN_DIR" ./grin server config 2>&1 | tee -a "$LOG_FILE") \
        || die "'grin server config' failed. Cannot continue without a valid generated config. Exiting."

    # Locate the newly generated config (grin may write it into a subdirectory)
    local found_config
    found_config=$(find "$GRIN_DIR" -name "grin-server.toml" 2>/dev/null | head -1)

    if [[ -z "$found_config" ]]; then
        die "'grin server config' ran but grin-server.toml was not found in $GRIN_DIR. Check binary compatibility. Exiting."
    fi

    # Move to the root of GRIN_DIR if grin placed it in a subdirectory
    if [[ "$found_config" != "$target" ]]; then
        mv "$found_config" "$target" \
            || die "Failed to move config from $(dirname "$found_config") to $GRIN_DIR."
        info "Config moved from $(dirname "$found_config") → $GRIN_DIR"
    fi

    success "Config ready: $target"
    log "[STEP 7] Config=$target"
}

# =============================================================================
# [8] PATCH grin-server.toml WITH USER CHOICES
# -----------------------------------------------------------------------------
# Modifies the generated config file with three key values:
#   chain_type   — "Mainnet" or "Testnet" based on network selection
#   archive_mode — true (full) or false (pruned) based on mode selection
#   db_root      — set to $GRIN_DIR/chain_data so data stays in our directory
# For testnet, also changes ports: 3413 → 13413, 3414 → 13414, 3415 → 13415, 3416 → 13416.
# If any key is missing from the generated config, it is appended with a warning.
# =============================================================================
patch_config() {
    local network="$1"
    local mode="$2"
    local config="$GRIN_DIR/grin-server.toml"

    step_header "Step 8: Patch Config"

    local chain_type archive_val
    [[ "$network" == "mainnet" ]] && chain_type="Mainnet" || chain_type="Testnet"
    [[ "$mode"    == "full"    ]] && archive_val="true"   || archive_val="false"

    # chain_type
    if grep -q 'chain_type' "$config"; then
        sed -i "s/^chain_type = .*/chain_type = \"$chain_type\"/" "$config"
    else
        echo "chain_type = \"$chain_type\"" >> "$config"
        warn "chain_type not found in config — appended."
    fi

    # archive_mode
    if grep -q 'archive_mode' "$config"; then
        sed -i "s/^archive_mode = .*/archive_mode = $archive_val/" "$config"
    else
        echo "archive_mode = $archive_val" >> "$config"
        warn "archive_mode not found in config — appended."
    fi

    # db_root — point to our custom directory so grin stores data here
    local db_root="$GRIN_DIR/chain_data"
    if grep -q 'db_root' "$config"; then
        sed -i "s|^db_root = .*|db_root = \"$db_root\"|" "$config"
    else
        echo "db_root = \"$db_root\"" >> "$config"
        warn "db_root not found in config — appended."
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

    # For testnet: change all default ports from mainnet (341x) to testnet (1341x).
    # Uses word-boundary (\b) replacement so ports are matched wherever they appear
    # in the config — as standalone values (port = 3414), embedded in address strings
    # (api_http_addr = "127.0.0.1:3413"), or in any other key (api_listen_port = 3415).
    if [[ "$network" == "testnet" ]]; then
        sed -i \
            -e 's/\b3413\b/13413/g' \
            -e 's/\b3414\b/13414/g' \
            -e 's/\b3415\b/13415/g' \
            -e 's/\b3416\b/13416/g' \
            "$config"
        # Verify no original port numbers remain
        for mport in 3413 3414 3415 3416; do
            if grep -qP "\b${mport}\b" "$config"; then
                warn "Port $mport still present in config after patching — verify manually."
            fi
        done
    fi

    success "Config patched:"
    info "  chain_type                        = \"$chain_type\""
    info "  archive_mode                      = $archive_val"
    info "  db_root                           = \"$db_root\""
    info "  peer_max_inbound_count            = 999"
    info "  peer_max_outbound_count           = 199"
    info "  peer_min_preferred_outbound_count = 199"
    info "  log_max_files                     = 3"
    info "  enable_stratum_server             = true"
    [[ "$network" == "testnet" ]] && info "  Ports patched: 3413→13413, 3414→13414, 3415→13415, 3416→13416"
    log "[STEP 8] chain_type=$chain_type archive_mode=$archive_val db_root=$db_root peer_limits=999in/199out/199min log_max_files=3 stratum=true${network:+ (testnet: ports=13413/13414/13415/13416)}"
}

# =============================================================================
# [9] DOWNLOAD CHAIN DATA FROM TRUSTED SOURCE
# -----------------------------------------------------------------------------
# Selects the correct chain data source based on network + archive mode.
# Three known hosts are tried in order (primary → backup1 → backup2):
#   *.grin.money    — primary
#   *.grinily.com   — backup 1
#   *.onlygrins.com — backup 2
# Prefixes (site_key):
#   fullmain  — full archive, mainnet
#   prunemain — pruned,       mainnet
#   prunetest — pruned,       testnet
# Each host is checked via check_status_before_download.txt — only used if it
# contains "Sync completed.".
# If all 3 known hosts fail, the user is prompted to enter a custom base URL
# (e.g. http://myserver.com) or press 0 to return to the master script.
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

download_chain_data() {
    local network="$1"
    local mode="$2"

    step_header "Step 9: Download Chain Data"

    # Check for an existing .tar.gz in the destination directory before downloading
    local existing_tar
    existing_tar=$(find "$GRIN_DIR" -maxdepth 1 -name "*.tar.gz" 2>/dev/null | head -1)
    if [[ -n "$existing_tar" ]]; then
        warn "Existing archive found: $(basename "$existing_tar")"
        echo -e "  ${GREEN}y${RESET}) Remove and download a fresh copy"
        echo -e "  ${RED}n${RESET}) Keep it and continue"
        echo -e "  ${DIM}0${RESET}) Return to main menu"
        echo ""
        echo -ne "${BOLD}Remove existing archive? [y/N/0]: ${RESET}"
        read -r rm_choice || true
        case "${rm_choice,,}" in
            y)
                rm -f "$existing_tar"
                # Also clean up any leftover .sha256 so checksums don't mismatch
                find "$GRIN_DIR" -maxdepth 1 -name "*.sha256" -delete 2>/dev/null || true
                success "Existing archive removed. Downloading fresh copy..."
                ;;
            0) exit 0 ;;
            *) info "Keeping existing archive. Proceeding..." ;;
        esac
    fi

    local site_key
    site_key=$(_get_site_key "$network" "$mode")

    local hosts=(
        "${site_key}.grin.money"
        "${site_key}.grinily.com"
        "${site_key}.onlygrins.com"
    )

    # Shuffle for load distribution across sources
    mapfile -t hosts < <(printf '%s\n' "${hosts[@]}" | shuf)

    info "Known sources (random order):"
    local h; for h in "${hosts[@]}"; do info "  → $h"; done

    # Try each known host (shuffled order, fallback to next on failure)
    local base_url=""
    for host in "${hosts[@]}"; do
        local status_url="http://${host}/check_status_before_download.txt"
        info "Checking sync status at: $status_url"
        local status_content
        status_content=$(curl -fsSL --max-time 15 "$status_url" 2>/dev/null) || {
            warn "Cannot reach $host — trying next source..."
            continue
        }
        if echo "$status_content" | grep -q "Sync completed."; then
            base_url="http://$host"
            success "Source ready: $host"
            break
        else
            warn "$host is not ready: $(echo "$status_content" | head -1)"
            warn "Trying next source..."
        fi
    done

    # All known hosts failed — prompt for custom URL or exit
    if [[ -z "$base_url" ]]; then
        echo ""
        warn "All 3 known sources are unavailable or not fully synced."
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
                    # Check status file first (best-effort; not required for custom hosts)
                    local custom_status
                    custom_status=$(curl -fsSL --max-time 15 "${custom_url}/check_status_before_download.txt" 2>/dev/null) || true
                    if echo "$custom_status" | grep -q "Sync completed."; then
                        base_url="$custom_url"
                        success "Custom source ready: $custom_url"
                        break
                    fi
                    # Status file absent or not ready — check directory listing for files
                    local custom_index
                    custom_index=$(curl -fsSL --max-time 15 "${custom_url}/" 2>/dev/null) || true
                    if echo "$custom_index" | grep -q '\.tar\.gz'; then
                        base_url="$custom_url"
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

    # Parse the directory index to find the .tar.gz and .sha256 filenames
    info "Fetching file listing from $base_url ..."
    local index
    index=$(curl -fsSL --max-time 15 "$base_url/" 2>/dev/null) \
        || die "Failed to fetch directory listing from $base_url."

    local tar_name sha_name
    tar_name=$(echo "$index" | grep -oP 'href="\K[^"]*\.tar\.gz' | grep -v '^\.\.' | head -1)
    sha_name=$(echo "$index" | grep -oP 'href="\K[^"]*\.sha256'  | grep -v '^\.\.' | head -1)

    [[ -z "$tar_name" ]] && die "No .tar.gz file found in directory listing at $base_url"
    [[ -z "$sha_name" ]] && die "No .sha256 file found in directory listing at $base_url"

    TAR_FILE="$GRIN_DIR/$tar_name"
    SHA_FILE="$GRIN_DIR/$sha_name"

    info "Downloading checksum file: $sha_name"
    curl -fsSL "$base_url/$sha_name" -o "$SHA_FILE" \
        || die "Failed to download checksum file."
    success "Checksum saved: $SHA_FILE"

    info "Downloading chain data: $tar_name"
    info "(Large file — progress shown below)"
    wget -c --progress=bar:force -O "$TAR_FILE" "$base_url/$tar_name" \
        || die "Chain data download failed from $base_url."
    success "Chain data downloaded: $TAR_FILE"
    log "[STEP 9] Downloaded $tar_name from $base_url"
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
# [13] START GRIN NODE IN A TMUX SESSION
# -----------------------------------------------------------------------------
# Creates a named tmux session: grin_<dirname>  (e.g. grin_grinprunemain).
# If a session with that name already exists, it is killed first.
# Runs './grin server run' inside the session so the node starts in TUI mode.
# The session stays open after grin exits so the user can read any output.
# Attach with: tmux attach -t <session>   |   Detach: Ctrl+B then D
# =============================================================================
start_grin_tmux() {
    step_header "Step 13: Start Grin Node (tmux)"
    local session="grin_$(basename "$GRIN_DIR")"

    if tmux has-session -t "$session" 2>/dev/null; then
        warn "Tmux session '$session' already exists — killing it first."
        tmux kill-session -t "$session" 2>/dev/null || true
    fi

    # Start session; keep window open after grin exits so user can read output
    tmux new-session -d -s "$session" -c "$GRIN_DIR" \
        "echo 'Starting Grin node...'; cd $GRIN_DIR && ./grin server run; echo ''; echo 'Grin process exited. Press Enter to close.'; read" \
        || die "Failed to create tmux session '$session'. Is tmux installed and working?"

    success "Grin node started in tmux session: $session"
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
    local session="grin_$(basename "$GRIN_DIR")"

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
    echo -e "${BOLD}${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

    log "[STEP 14] DONE. network=$network mode=$mode dir=$GRIN_DIR time=${mins}m${secs}s"
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
    generate_config
    patch_config        "$network" "$ARCHIVE_MODE"
    download_chain_data "$network" "$ARCHIVE_MODE"
    verify_checksum
    check_disk_space
    extract_chain_data
    start_grin_tmux
    show_summary        "$network" "$ARCHIVE_MODE"

    # Reset per-node state
    GRIN_DIR=""
    TAR_FILE=""
    SHA_FILE=""
    ARCHIVE_MODE=""
}

# =============================================================================
# Main
# =============================================================================
main() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Grin Node Setup — Build New Node${RESET}"
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
