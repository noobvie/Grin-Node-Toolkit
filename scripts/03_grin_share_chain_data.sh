#!/bin/bash

################################################################################
# Script 03 — Grin Chain Data Share & Schedule Manager
# Part of: Grin Node Toolkit  (https://github.com/noobvie/grin-node-toolkit)
################################################################################
#
# PURPOSE
#   Compresses a synced Grin node's chain_data into a .tar.gz archive and
#   distributes it via Nginx (local HTTP) and/or SSH (remote rsync). Designed
#   to run on public "master nodes" that share pre-synced archives so new
#   nodes can bootstrap without waiting days for peer sync.
#
# PIPELINES
#   Nginx — detect node → verify sync → stop node → compress chain_data →
#           write to nginx web dir → generate SHA256 → restart node.
#           Produces a .tar.gz + .sha256 pair consumed by Script 01.
#   Remote — (menu C/D, lib/03_lib_remote.sh) rsync the FINISHED archive from
#           the local nginx web dir to one or more mirrors. Never touches
#           chain_data and never stops the node; runs independently after the
#           Nginx pipeline has produced the archive. Config lives in
#           grin_share_targets.conf; --cron-ssh is the legacy flag alias.
#
# USAGE
#   Interactive : bash 03_grin_share_chain_data.sh
#   Cron        : bash 03_grin_share_chain_data.sh --cron-nginx       (both nets)
#                 bash 03_grin_share_chain_data.sh --cron-nginx-main  (mainnet only)
#                 bash 03_grin_share_chain_data.sh --cron-nginx-test  (testnet only)
#                 bash 03_grin_share_chain_data.sh --cron-remote [site_key]
#                 bash 03_grin_share_chain_data.sh --cron-ssh   (legacy alias)
#                 bash 03_grin_share_chain_data.sh --cron-clean
#
# NODE TYPES & WEB DIRECTORIES
#   mainnet-full  → /var/www/fullmain   (domain: fullmain.yourdomain.com)
#   mainnet-prune → /var/www/prunemain  (domain: prunemain.yourdomain.com)
#   testnet-prune → /var/www/prunetest  (domain: prunetest.yourdomain.com)
#
# PREREQUISITES
#   · Must be run as root
#   · A synced Grin node built by Script 01
#   · Script 02 nginx file server set up on the domain (for Nginx pipeline)
#   · Required packages: tar, openssl, rsync (remote copy), tmux
#   · Optional: pigz (parallel gzip), nocache — installed on demand, and a
#     failed install is remembered for PKG_RETRY_HOURS rather than retried
#
# BECOME A MASTER NODE
#   If you have a spare VPS and domain, point subdomains to this server and
#   run Scripts 01 → 02 → 03. Your node will share chain data publicly,
#   helping new Grin users sync in minutes instead of days.
#
# LOG FILE
#   /opt/grin/logs/03_grin_share_YYYYMMDD_HHMMSS.log
#
################################################################################
# ============================================================================
# PATHS & CONSTANTS
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Shared node primitives (canonical _grin_session_name, etc.). Source-guarded,
# no side effects; defines info/warn/error fallbacks only if absent.
source "$SCRIPT_DIR/lib/grin_node_control.sh"
source "$SCRIPT_DIR/lib/grin_alerts.sh"
source "$SCRIPT_DIR/lib/03_lib_remote.sh"
# Menu sections split out of this file (same globals and logging; see each lib's header).
# shellcheck source=lib/03_lib_share_pipeline.sh
source "$SCRIPT_DIR/lib/03_lib_share_pipeline.sh"
# shellcheck source=lib/03_lib_schedule.sh
source "$SCRIPT_DIR/lib/03_lib_schedule.sh"
# shellcheck source=lib/03_lib_remote_menu.sh
source "$SCRIPT_DIR/lib/03_lib_remote_menu.sh"
CONF_DIR="/opt/grin/conf"
CONF_NGINX="$CONF_DIR/grin_share_nginx.conf"
CONF_SSH="$CONF_DIR/grin_share_ssh.conf"
INSTANCES_CONF="$CONF_DIR/grin_instances_location.conf"
LOG_DIR="/opt/grin/logs"
SCHED_LOG_FILE="$LOG_DIR/schedule.log"
CRON_COMMENT_NGINX="# grin-node-toolkit: grin_share_nginx"            # legacy combined (both networks)
CRON_COMMENT_NGINX_MAIN="# grin-node-toolkit: grin_share_nginx_main"  # per-network: mainnet
CRON_COMMENT_NGINX_TEST="# grin-node-toolkit: grin_share_nginx_test"  # per-network: testnet
CRON_COMMENT_AUTOSTART_MAIN="# grin-node-toolkit: grin_autostart_mainnet"
CRON_COMMENT_AUTOSTART_TEST="# grin-node-toolkit: grin_autostart_testnet"
CRON_COMMENT_CLEAN="# grin-node-toolkit: grin_clean_txhashset"
CRON_COMMENT_REMOTE="# grin-node-toolkit: grin_share_remote"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

# ============================================================================
# DEFAULT NGINX CONFIG
# ============================================================================

SYNC_CHOICE="all"
GRIN_PORT_MAINNET=3414
GRIN_PORT_TESTNET=13414
LOCAL_WEB_DIR_MAINNET_FULL="/var/www/fullmain"
LOCAL_WEB_DIR_MAINNET_PRUNED="/var/www/prunemain"
LOCAL_WEB_DIR_TESTNET_PRUNED="/var/www/prunetest"
# Web user differs per distro — www-data (Debian/Ubuntu), nginx (RHEL/Rocky/Alma).
# Saved config (CONF_NGINX) overrides this default.
if id -u www-data &>/dev/null; then
    FILE_OWNER="www-data:www-data"
elif id -u nginx &>/dev/null; then
    FILE_OWNER="nginx:nginx"
else
    FILE_OWNER="www-data:www-data"
fi
GRIN_STOP_TIMEOUT=120
FORCE_KILL_IF_STUCK=true
DETECTED_NODE_TYPES=""   # populated by run_nginx_setup, e.g. "mainnet:pruned testnet:pruned"

# Compression level, per artefact. Level and parallelism are INDEPENDENT knobs:
# pigz gives the multi-core speedup at any level, so the level should follow what
# the artefact costs, not what compressor is in use.
#
#   full   — an archive node's bytes are dominated by rangeproofs (Bulletproofs),
#            Pedersen commitments and kernel signatures. That is cryptographic
#            output and very nearly incompressible, so a high level burns CPU for
#            almost nothing. Few downloads, so the slightly larger file is cheap.
#   pruned — downloaded far more often, where a larger file costs real egress on
#            every single transfer. Keep the ratio, take the parallel speedup.
#
# PROVISIONAL: 1 is chosen on the reasoning above, not on measurement. Confirm
# with the ratio test in docs/reference/script03_design.md section 4 (0a) and
# raise this if the gap between levels 1 and 6 turns out to be material.
# Both are env-overridable so a host can be tuned without editing this file.
COMPRESS_LEVEL_FULL="${COMPRESS_LEVEL_FULL:-1}"
COMPRESS_LEVEL_PRUNED="${COMPRESS_LEVEL_PRUNED:-6}"

# Estimated compressed size as a FRACTION of the on-disk chain_data size. Used
# only by the pre-flight space check, and deliberately pessimistic: guessing too
# high costs a skipped run that logs loudly and leaves the previous archive
# serving, while guessing too low fills the disk mid-compress on a box that is
# also running nginx, a wallet listener and possibly a mining pool. The two
# errors are nowhere near equal, so the estimate leans hard one way.
COMPRESS_RATIO_FULL="${COMPRESS_RATIO_FULL:-0.95}"
COMPRESS_RATIO_PRUNED="${COMPRESS_RATIO_PRUNED:-0.90}"
# Free space that must remain AFTER the archive is written, in MiB.
DISK_HEADROOM_MB="${DISK_HEADROOM_MB:-512}"

# Compression threads. Empty means "every core". Set this to leave cores for the
# services that keep running while the node is stopped — nginx, the wallet
# listener, a mining pool. Level and thread count are independent: dropping
# threads lowers the load without changing the output at all.
COMPRESS_THREADS="${COMPRESS_THREADS:-}"

# ============================================================================
# DEFAULT SSH CONFIG  (per node type — each can point to a different remote host)
# ============================================================================

FILE_OWNER_SSH="www-data:www-data"

SSH_ENABLE_MAINNET_FULL=false
SSH_SOURCE_DIR_MAINNET_FULL=""
REMOTE_HOST_MAINNET_FULL="user@your-server"
REMOTE_PORT_MAINNET_FULL="22"
REMOTE_SSH_KEY_MAINNET_FULL="/root/.ssh/id_rsa"
REMOTE_WEB_DIR_MAINNET_FULL="/var/www/fullmain"

SSH_ENABLE_MAINNET_PRUNED=false
SSH_SOURCE_DIR_MAINNET_PRUNED=""
REMOTE_HOST_MAINNET_PRUNED="user@your-server"
REMOTE_PORT_MAINNET_PRUNED="22"
REMOTE_SSH_KEY_MAINNET_PRUNED="/root/.ssh/id_rsa"
REMOTE_WEB_DIR_MAINNET_PRUNED="/var/www/prunemain"

SSH_ENABLE_TESTNET_PRUNED=false
SSH_SOURCE_DIR_TESTNET_PRUNED=""
REMOTE_HOST_TESTNET_PRUNED="user@your-server"
REMOTE_PORT_TESTNET_PRUNED="22"
REMOTE_SSH_KEY_TESTNET_PRUNED="/root/.ssh/id_rsa"
REMOTE_WEB_DIR_TESTNET_PRUNED="/var/www/prunetest"

# ============================================================================
# AUTO-DETECTION VARIABLES  (populated at runtime — do not edit)
# ============================================================================

GRIN_PORT=""
NETWORK_TYPE=""
ARCHIVE_NODE=""
NODE_TYPE=""
ARCHIVE_BASE=""     # basename of the archive produced this run (no extension)
RETAIN_PREVIOUS=false   # set by preflight_disk_space; read by clean_output_directory
_SWAP_LOCKED=false      # true while compress_chain_data holds the publish-swap lock
_SHARE_RC=0             # per-instance publish result; reset by reset_detection_vars
GRIN_BINARY=""
GRIN_DIR=""
GRIN_DATA_DIR=""
GRIN_CONFIG_FILE=""
LOG_FILE=""
OUTPUT_DIR=""
STATUS_FILE=""
FINAL_DEST=""
TMUX_SESSION=""

################################################################################
# Logging helpers
################################################################################

# _grin_session_name() is defined in lib/grin_node_control.sh (sourced above).

# LOG_FILE is empty until the build resolver or the remote-copy runner sets it,
# and the interactive mirror menus (rc_log -> log) run before either does. A
# bare tee on "" prints "tee: '': No such file or directory" beside every line.
log() {
    local line="[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $1"
    if [ -n "${LOG_FILE:-}" ]; then echo "$line" | tee -a "$LOG_FILE"; else echo "$line"; fi
}
error_exit() { log "ERROR: $1"; exit 1; }
get_utc_timestamp() { date -u '+%Y-%m-%d %H:%M:%S UTC'; }

sched_log()     { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$SCHED_LOG_FILE" 2>/dev/null || true; }
sched_info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
sched_success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
sched_warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
sched_error()   { echo -e "${RED}[ERROR]${RESET} $*"; }

# Silently enforce UTC timezone — required for accurate Last-Modified timestamps
# on compressed chain data files (used by script 081 staleness checks).
check_timezone_utc() {
    local current_tz
    current_tz=$(timedatectl show --property=Timezone --value 2>/dev/null \
        || cat /etc/timezone 2>/dev/null \
        || echo "unknown")
    if [[ "$current_tz" == "UTC" ]]; then
        log "Timezone: UTC — OK."
        return 0
    fi
    if command -v timedatectl &>/dev/null; then
        timedatectl set-timezone UTC \
            && log "Timezone set to UTC (was: ${current_tz})." \
            || log "WARN: Failed to set timezone to UTC (was: ${current_tz})."
    else
        ln -sf /usr/share/zoneinfo/UTC /etc/localtime \
            && echo "UTC" > /etc/timezone \
            && log "Timezone set to UTC via symlink (was: ${current_tz})." \
            || log "WARN: Failed to set timezone to UTC (was: ${current_tz})."
    fi
}

# Display an error and wait for the user to press Enter (interactive mode)
show_error_pause() {
    echo -e "\n${RED}[ERROR]${RESET} $1"
    [ -n "${2:-}" ] && echo -e "  ${DIM}$2${RESET}"
    echo ""
    echo "Press Enter to return to menu..."
    read -r
}

################################################################################
# Package helpers — distro-aware (apt on Debian/Ubuntu, dnf on Rocky/Alma)
################################################################################

# Install a package if the given command is missing.
# Usage: ensure_package <command> <package>
# Optional helpers (pigz, nocache, rsync) go through this, and the callers are
# on a cron schedule. When a package genuinely is not available - nocache is in
# no RHEL base repo, for instance - an uncached check would run a full
# `apt-get update` plus a failing install on EVERY run, for ever: minutes of
# network and disk on a box this design keeps quiet, to reach the same answer as
# last time. A failure is remembered and not retried for PKG_RETRY_HOURS.
#
# Only FAILURE is cached, and only for a while. A package that appears in a repo
# later still gets picked up; the operator just waits out the window instead of
# paying for the attempt on every single run.
PKG_FAIL_DIR="${PKG_FAIL_DIR:-/opt/grin/state/pkgfail}"
PKG_RETRY_HOURS="${PKG_RETRY_HOURS:-24}"

ensure_package() {
    local cmd="$1" pkg="$2" marker rc
    command -v "$cmd" &>/dev/null && return 0

    marker="$PKG_FAIL_DIR/$(printf '%s' "$pkg" | tr -c 'a-zA-Z0-9._-' '_')"
    if [ -f "$marker" ]; then
        local age_h
        age_h=$(( ( $(date +%s) - $(stat -c %Y "$marker" 2>/dev/null || echo 0) ) / 3600 ))
        if [ "$age_h" -lt "$PKG_RETRY_HOURS" ]; then
            log_or_echo "Skipping $pkg: install failed ${age_h}h ago, retrying after ${PKG_RETRY_HOURS}h"
            return 1
        fi
        rm -f "$marker" 2>/dev/null || true
    fi

    echo "Installing missing package: $pkg..."
    if command -v dnf &>/dev/null; then
        dnf install -y -q "$pkg"; rc=$?
    else
        apt-get update -qq && apt-get install -y -qq "$pkg"; rc=$?
    fi

    # An installer that exits 0 without producing the command is still a failure
    # for our purposes - what the caller needs is the binary, not the exit code.
    if [ $rc -eq 0 ] && command -v "$cmd" &>/dev/null; then
        rm -f "$marker" 2>/dev/null || true
        return 0
    fi
    mkdir -p "$PKG_FAIL_DIR" 2>/dev/null || true
    : > "$marker" 2>/dev/null || true
    log_or_echo "Could not install $pkg - not retrying for ${PKG_RETRY_HOURS}h"
    return 1
}

# ensure_package runs both before and after the logger has a log file, so it
# cannot assume either one.
log_or_echo() {
    if declare -F log >/dev/null 2>&1 && [ -n "${LOG_FILE:-}" ]; then log "$*"; else echo "$*"; fi
}

# Ensure the crontab command exists and the cron daemon runs. RHEL-family
# minimal images often ship without cronie — schedules would silently never run.
ensure_crontab() {
    if ! command -v crontab &>/dev/null; then
        if command -v dnf &>/dev/null; then
            ensure_package crontab cronie || return 1
        else
            ensure_package crontab cron || return 1
        fi
    fi
    # enable+start are no-ops when already active; service name differs per distro
    systemctl enable --now crond &>/dev/null \
        || systemctl enable --now cron &>/dev/null \
        || true
    return 0
}

################################################################################
# Config: load / save
################################################################################

load_nginx_config() {
    [[ -f "$CONF_NGINX" ]] && source "$CONF_NGINX"
}

# Write current nginx config variables to CONF_NGINX
save_nginx_config() {
    mkdir -p "$CONF_DIR"
    cat > "$CONF_NGINX" << __EOF__
# Grin Share — Nginx Config
# Generated: $(date -u '+%Y-%m-%d %H:%M:%S UTC')

SYNC_CHOICE="$SYNC_CHOICE"
GRIN_PORT_MAINNET=$GRIN_PORT_MAINNET
GRIN_PORT_TESTNET=$GRIN_PORT_TESTNET
LOCAL_WEB_DIR_MAINNET_FULL="$LOCAL_WEB_DIR_MAINNET_FULL"
LOCAL_WEB_DIR_MAINNET_PRUNED="$LOCAL_WEB_DIR_MAINNET_PRUNED"
LOCAL_WEB_DIR_TESTNET_PRUNED="$LOCAL_WEB_DIR_TESTNET_PRUNED"
FILE_OWNER="$FILE_OWNER"
GRIN_STOP_TIMEOUT=$GRIN_STOP_TIMEOUT
FORCE_KILL_IF_STUCK=$FORCE_KILL_IF_STUCK
DETECTED_NODE_TYPES="$DETECTED_NODE_TYPES"
__EOF__
    chmod 600 "$CONF_NGINX"
}

load_ssh_config() {
    [[ -f "$CONF_SSH" ]] && source "$CONF_SSH"
}


################################################################################
# Setup Wizard A — Nginx config
################################################################################

run_nginx_setup() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Grin Share — Nginx Configuration Setup${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Config saved to: ${DIM}$CONF_NGINX${RESET}"
    echo ""

    # ── Ports (standard — no prompt needed) ──────────────────────────────────
    local tmp
    echo -e "  ${DIM}Grin P2P ports: mainnet ${GRIN_PORT_MAINNET}, testnet ${GRIN_PORT_TESTNET}${RESET}"
    echo ""

    # ── Detect running nodes ──────────────────────────────────────────────────
    echo -e "${BOLD}Detecting running Grin nodes...${RESET}"
    local detected_combos=() scan_port scan_pid scan_binary scan_dir scan_cfg scan_net scan_ntype total_bytes=0

    while true; do
        detected_combos=()
        total_bytes=0
        for scan_port in $GRIN_PORT_MAINNET $GRIN_PORT_TESTNET; do
            scan_pid=$(get_pid_on_port "$scan_port" 2>/dev/null) || true
            [ -z "$scan_pid" ] && continue

            scan_binary=$(readlink -f "/proc/$scan_pid/exe" 2>/dev/null) || true
            { [ -z "$scan_binary" ] || [ ! -f "$scan_binary" ]; } && continue
            scan_dir=$(dirname "$scan_binary")

            local scan_cwd
            scan_cwd=$(readlink -f "/proc/$scan_pid/cwd" 2>/dev/null) || scan_cwd=""
            scan_cfg=""
            for loc in "$scan_dir/grin-server.toml" "$scan_cwd/grin-server.toml"; do
                [ -f "$loc" ] && { scan_cfg="$loc"; break; }
            done

            # Read chain_type line specifically — broad grep would match comments/docs
            local chain_line=""
            [ -f "$scan_cfg" ] && chain_line=$(grep -E '^\s*chain_type\s*=' "$scan_cfg" 2>/dev/null | head -1)

            if echo "$chain_line" | grep -qi "Testnet"; then
                scan_net="testnet"
            elif echo "$chain_line" | grep -qi "Mainnet"; then
                scan_net="mainnet"
            elif [ "$scan_port" = "$GRIN_PORT_TESTNET" ]; then
                scan_net="testnet"
            else
                scan_net="mainnet"
            fi

            scan_ntype="pruned"
            if [ "$scan_net" = "mainnet" ] && [ -f "$scan_cfg" ]; then
                grep -qiE 'archive_mode\s*=\s*true' "$scan_cfg" 2>/dev/null && scan_ntype="full"
            fi

            echo -e "  ${GREEN}✓${RESET} Found: ${BOLD}${scan_net} / ${scan_ntype}${RESET}  (port ${scan_port}, PID ${scan_pid})"
            local _cdata="$scan_dir/chain_data"
            [ -d "$_cdata" ] || _cdata="$scan_dir"
            local _dsize _dbytes
            _dsize=$(du -sh "$_cdata" 2>/dev/null | cut -f1) || _dsize="?"
            _dbytes=$(du -sb "$_cdata" 2>/dev/null | cut -f1) || _dbytes=0
            echo -e "       ${DIM}$_cdata${RESET}  ${BOLD}${_dsize}${RESET}"
            total_bytes=$(( total_bytes + ${_dbytes:-0} ))
            detected_combos+=("${scan_net}:${scan_ntype}")
        done

        if [ ${#detected_combos[@]} -eq 0 ]; then
            echo -e "  ${YELLOW}⚠${RESET} No Grin nodes detected on port $GRIN_PORT_MAINNET or $GRIN_PORT_TESTNET."
            echo -e "  Make sure your Grin node is running, then retry."
            echo -ne "  Press ${BOLD}Enter${RESET} to retry, or ${BOLD}0${RESET} to cancel: "
            read -r _retry
            [ "${_retry}" = "0" ] && return 0
            echo -e "${BOLD}Detecting running Grin nodes...${RESET}"
            continue
        fi
        break
    done
    if [ ${#detected_combos[@]} -ge 1 ]; then
        local _total_human
        _total_human=$(awk -v b="$total_bytes" 'BEGIN {
            if (b >= 2^30) printf "%.1f GiB", b/2^30
            else if (b >= 2^20) printf "%.1f MiB", b/2^20
            else printf "%.1f KiB", b/2^10
        }')
        local _free_root _free_www
        _free_root=$(df -h / 2>/dev/null | awk 'NR==2 {print $4}') || _free_root="?"
        _free_www=$(df -h /var/www 2>/dev/null | awk 'NR==2 {print $4}') || _free_www="?"
        echo -e "  ${DIM}─────────────────────────────────────────${RESET}"
        echo -e "  ${DIM}Total chain_data:${RESET}  ${BOLD}${_total_human}${RESET}"
        echo -e "  ${DIM}Free disk  /:${RESET}        ${BOLD}${_free_root}${RESET}"
        echo -e "  ${DIM}Free disk  /var/www:${RESET}  ${BOLD}${_free_www}${RESET}"
    fi
    echo ""

    # ── Scan nginx for configured Grin domains ────────────────────────────────
    local nginx_mainnet_domain="" nginx_mainnet_dir="" nginx_mainnet_type=""
    local nginx_prunetest_domain="" nginx_prunetest_dir=""
    local _conf _sn _rd _pfx
    if [ -d "/etc/nginx/sites-enabled" ]; then
        for _conf in /etc/nginx/sites-enabled/*; do
            [ -f "$_conf" ] || continue
            _sn=$(grep -m1 'server_name' "$_conf" 2>/dev/null | \
                 awk '{for(i=2;i<=NF;i++) if($i!=";" && $i!="_" && $i~/[.]/) {print $i; exit}}' | tr -d ';')
            _rd=$(grep -m1 '^\s*root\s' "$_conf" 2>/dev/null | awk '{print $2}' | tr -d ';')
            [ -n "$_sn" ] && [ -n "$_rd" ] || continue
            _pfx=$(basename "$_rd")
            case "$_pfx" in
                fullmain)
                    nginx_mainnet_domain="$_sn"; nginx_mainnet_dir="$_rd"; nginx_mainnet_type="full" ;;
                prunemain)
                    nginx_mainnet_domain="$_sn"; nginx_mainnet_dir="$_rd"; nginx_mainnet_type="pruned" ;;
                prunetest)
                    nginx_prunetest_domain="$_sn"; nginx_prunetest_dir="$_rd" ;;
            esac
        done
    fi

    # ── Cross-check: nginx-configured networks must have a running node ──────
    local _xcheck_ok=true
    if [[ -n "$nginx_mainnet_dir" ]]; then
        local _mn_running=false
        for _c in "${detected_combos[@]}"; do
            [[ "$_c" == mainnet:* ]] && _mn_running=true && break
        done
        if ! $_mn_running; then
            echo -e "  ${RED}✗${RESET}  Nginx has a ${BOLD}mainnet${RESET} domain configured but no mainnet node is running."
            _xcheck_ok=false
        fi
    fi
    if [[ -n "$nginx_prunetest_dir" ]]; then
        local _tn_running=false
        for _c in "${detected_combos[@]}"; do
            [[ "$_c" == testnet:* ]] && _tn_running=true && break
        done
        if ! $_tn_running; then
            echo -e "  ${RED}✗${RESET}  Nginx has a ${BOLD}testnet${RESET} domain configured but no testnet node is running."
            _xcheck_ok=false
        fi
    fi
    if ! $_xcheck_ok; then
        echo ""
        echo -e "  Start the required node(s) first, then re-run option ${BOLD}A${RESET}:"
        echo -e "    ${CYAN}·${RESET} Use ${BOLD}Script 01${RESET} to start an installed node"
        echo -e "    ${CYAN}·${RESET} Or manually: ${DIM}cd /opt/grin/node/<type> && ./grin server run${RESET}"
        echo ""
        read -rp "  Press Enter to return to main menu: " _
        return
    fi

    # ── Guard: at least one Grin domain must be configured ───────────────────
    if [[ -z "$nginx_mainnet_dir" && -z "$nginx_prunetest_dir" ]]; then
        echo ""
        echo -e "  ${YELLOW}⚠${RESET}  No Grin domains configured in nginx."
        echo -e "  Run ${BOLD}script 02 → option 1) Build Grin Master Nodes${RESET} first."
        echo ""
        echo -ne "  Press ${BOLD}0${RESET} to return to main menu: "
        read -r
        return
    fi

    # ── SYNC_CHOICE — based on configured nginx domains ───────────────────────
    if [[ -n "$nginx_mainnet_dir" && -n "$nginx_prunetest_dir" ]]; then
        echo -e "${BOLD}Which networks to share?${RESET}"
        echo -e "  ${GREEN}1${RESET}) both     (mainnet + testnet)  ${YELLOW}!will consume more diskspace!${RESET}"
        echo -e "  ${GREEN}2${RESET}) mainnet  only"
        echo -e "  ${GREEN}3${RESET}) testnet  only"
        echo -e "  ${DIM}0${RESET}) Cancel — return to main menu"
        echo -ne "Select [0-3, default=1]: "
        read -r sc_choice
        [[ "$sc_choice" == "0" ]] && return
        case "${sc_choice:-1}" in
            2) SYNC_CHOICE="mainnet" ;;
            3) SYNC_CHOICE="testnet" ;;
            *) SYNC_CHOICE="all"     ;;
        esac
        echo ""
    elif [[ -n "$nginx_mainnet_dir" ]]; then
        SYNC_CHOICE="mainnet"
        echo -e "  ${DIM}Network: mainnet (auto-selected — only mainnet domain configured)${RESET}"
        echo ""
    else
        SYNC_CHOICE="testnet"
        echo -e "  ${DIM}Network: testnet (auto-selected — only testnet domain configured)${RESET}"
        echo ""
    fi

    # ── Web directories — auto-assigned from nginx config ────────────────────
    echo -e "${BOLD}Web directory for each node:${RESET}"
    echo ""
    if [[ "$SYNC_CHOICE" == "all" || "$SYNC_CHOICE" == "mainnet" ]] && [[ -n "$nginx_mainnet_dir" ]]; then
        local _mvar="LOCAL_WEB_DIR_MAINNET_${nginx_mainnet_type^^}"
        printf -v "$_mvar" '%s' "$nginx_mainnet_dir"
        echo -e "  ${GREEN}✓${RESET} mainnet (${nginx_mainnet_type}) → ${nginx_mainnet_dir}  ${DIM}(from nginx: ${nginx_mainnet_domain})${RESET}"
    fi
    if [[ "$SYNC_CHOICE" == "all" || "$SYNC_CHOICE" == "testnet" ]] && [[ -n "$nginx_prunetest_dir" ]]; then
        LOCAL_WEB_DIR_TESTNET_PRUNED="$nginx_prunetest_dir"
        echo -e "  ${GREEN}✓${RESET} testnet (pruned) → ${nginx_prunetest_dir}  ${DIM}(from nginx: ${nginx_prunetest_domain})${RESET}"
    fi
    echo ""

    # ── File ownership & stop timeout (standard defaults) ────────────────────
    echo -e "  ${DIM}File ownership: ${FILE_OWNER}${RESET}"
    echo -e "  ${DIM}Graceful-stop timeout: ${GRIN_STOP_TIMEOUT}s${RESET}"
    echo ""

    # ── Save ──────────────────────────────────────────────────────────────────
    local _det_types=()
    if [[ "$SYNC_CHOICE" == "all" || "$SYNC_CHOICE" == "mainnet" ]] && [[ -n "$nginx_mainnet_dir" ]]; then
        _det_types+=("mainnet:${nginx_mainnet_type}")
    fi
    if [[ "$SYNC_CHOICE" == "all" || "$SYNC_CHOICE" == "testnet" ]] && [[ -n "$nginx_prunetest_dir" ]]; then
        _det_types+=("testnet:pruned")
    fi
    DETECTED_NODE_TYPES="${_det_types[*]}"
    mkdir -p "$LOG_DIR"
    save_nginx_config
    echo ""
    echo -e "${BOLD}${GREEN}Config saved:${RESET}"
    echo -e "  Networks     : ${SYNC_CHOICE}"
    [[ "$SYNC_CHOICE" == "all" || "$SYNC_CHOICE" == "mainnet" ]] && [[ -n "$nginx_mainnet_dir" ]] && \
        echo -e "  mainnet      : ${nginx_mainnet_dir}  ${DIM}(${nginx_mainnet_domain})${RESET}"
    [[ "$SYNC_CHOICE" == "all" || "$SYNC_CHOICE" == "testnet" ]] && [[ -n "$nginx_prunetest_dir" ]] && \
        echo -e "  testnet      : ${nginx_prunetest_dir}  ${DIM}(${nginx_prunetest_domain})${RESET}"
    echo -e "  Ownership    : ${FILE_OWNER}"
    echo -e "  Stop timeout : ${GRIN_STOP_TIMEOUT}s"
    echo -e "  Saved to     : ${DIM}$CONF_NGINX${RESET}"
    sched_log "Nginx config updated: SYNC_CHOICE=$SYNC_CHOICE DETECTED_NODE_TYPES=$DETECTED_NODE_TYPES"
    echo ""
    read -rp "  Press Enter to return to main menu: " _
}


################################################################################
# Port / process detection
################################################################################

# Try lsof → ss → netstat to find PID on a given port
get_pid_on_port() {
    local port=$1
    local pid

    if command -v lsof &>/dev/null; then
        pid=$(lsof -tni :"$port" -sTCP:LISTEN 2>/dev/null | head -1); [ -n "$pid" ] && echo "$pid" && return 0
    fi
    if command -v ss &>/dev/null; then
        pid=$(ss -tlnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' | head -1)
        [ -n "$pid" ] && echo "$pid" && return 0
    fi
    if command -v netstat &>/dev/null; then
        pid=$(netstat -tlnp 2>/dev/null | grep ":$port " | grep -oP '[0-9]+/.*' | cut -d'/' -f1 | head -1)
        [ -n "$pid" ] && echo "$pid" && return 0
    fi
    return 1
}

is_grin_running() {
    local pid; pid=$(get_pid_on_port "$GRIN_PORT")
    [ -n "$pid" ] && return 0 || return 1
}

################################################################################
# Auto-detection  (populates GRIN_PORT, GRIN_BINARY, NETWORK_TYPE, etc.)
################################################################################

detect_active_port() {
    local port=$1
    local pid; pid=$(get_pid_on_port "$port")
    [ -z "$pid" ] && return 1
    GRIN_PORT=$port
    echo "[$(date '+%Y-%m-%d %H:%M:%S UTC' -u)] Grin on port $port (PID $pid)"
}

detect_grin_binary() {
    local pid; pid=$(get_pid_on_port "$GRIN_PORT")
    GRIN_BINARY=$(readlink -f "/proc/$pid/exe" 2>/dev/null)
    { [ -z "$GRIN_BINARY" ] || [ ! -f "$GRIN_BINARY" ]; } && error_exit "Cannot determine binary for PID $pid"
    GRIN_DIR=$(dirname "$GRIN_BINARY")
    echo "[$(date '+%Y-%m-%d %H:%M:%S UTC' -u)] Binary: $GRIN_BINARY"
}

detect_config_file() {
    if [ -f "$GRIN_DIR/grin-server.toml" ]; then
        GRIN_CONFIG_FILE="$GRIN_DIR/grin-server.toml"
        echo "[$(date '+%Y-%m-%d %H:%M:%S UTC' -u)] Config: $GRIN_CONFIG_FILE"
        return 0
    fi
    echo "[$(date '+%Y-%m-%d %H:%M:%S UTC' -u)] WARNING: grin-server.toml not found at $GRIN_DIR — falling back to port-based detection"
}

detect_network_type() {
    if [ -f "$GRIN_CONFIG_FILE" ]; then
        local line; line=$(grep -E "^\s*chain_type\s*=" "$GRIN_CONFIG_FILE" | head -1)
        echo "$line" | grep -qi "Testnet" && { NETWORK_TYPE="testnet"; return; }
        echo "$line" | grep -qi "Mainnet" && { NETWORK_TYPE="mainnet"; return; }
    fi
    [ "$GRIN_PORT" = "$GRIN_PORT_TESTNET" ] && NETWORK_TYPE="testnet" || NETWORK_TYPE="mainnet"
    echo "[$(date '+%Y-%m-%d %H:%M:%S UTC' -u)] Network: $NETWORK_TYPE (inferred from port)"
}

detect_node_type() {
    if [ -f "$GRIN_CONFIG_FILE" ] && grep -qiE 'archive_mode\s*=\s*true' "$GRIN_CONFIG_FILE" 2>/dev/null; then
        ARCHIVE_NODE=true; NODE_TYPE="full"
    else
        ARCHIVE_NODE=false; NODE_TYPE="pruned"
    fi
    echo "[$(date '+%Y-%m-%d %H:%M:%S UTC' -u)] Node type: $NODE_TYPE"
}

detect_chain_data() {
    if [ -f "$GRIN_CONFIG_FILE" ]; then
        local db_root; db_root=$(grep -E "^\s*db_root\s*=" "$GRIN_CONFIG_FILE" | head -1 | sed 's/.*=\s*"\(.*\)".*/\1/')
        if [ -n "$db_root" ]; then
            db_root="${db_root/#\~/$HOME}"
            [ -d "$db_root/chain_data" ] && { GRIN_DATA_DIR="$db_root/chain_data"; return 0; }
        fi
    fi
    [ -d "$GRIN_DIR/chain_data" ] && { GRIN_DATA_DIR="$GRIN_DIR/chain_data"; return 0; }
    error_exit "chain_data not found in $GRIN_DIR. Expected location: /opt/grin/node/<type>/chain_data. Ensure Script 01 was used to build the node."
}

# Resolve OUTPUT_DIR, LOG_FILE, STATUS_FILE, TMUX_SESSION from detected vars
setup_derived_variables() {
    mkdir -p "$LOG_DIR"
    LOG_FILE="$LOG_DIR/share_nginx_${NETWORK_TYPE}_${NODE_TYPE}_$(date -u '+%Y%m%d_%H%M%S').log"
    # Session name convention: grin_<nodetype>_<networktype>
    # e.g. /opt/grin/node/mainnet-prune → grin_pruned_mainnet
    TMUX_SESSION="$(_grin_session_name "$GRIN_DIR")"

    local web_dir_var="LOCAL_WEB_DIR_${NETWORK_TYPE^^}_${NODE_TYPE^^}"
    OUTPUT_DIR="${!web_dir_var}"
    FINAL_DEST="local: $OUTPUT_DIR"
    STATUS_FILE="$OUTPUT_DIR/check_status_before_download.txt"

    touch "$LOG_FILE" 2>/dev/null || true
}

reset_detection_vars() {
    GRIN_PORT="" NETWORK_TYPE="" ARCHIVE_NODE="" NODE_TYPE="" ARCHIVE_BASE=""
    RETAIN_PREVIOUS=false; _SHARE_RC=0; _SWAP_LOCKED=false
    GRIN_BINARY="" GRIN_DIR="" GRIN_DATA_DIR="" GRIN_CONFIG_FILE=""
    LOG_FILE="" OUTPUT_DIR="" STATUS_FILE="" FINAL_DEST="" TMUX_SESSION=""
}

# Map (network_type, node_type) → conf key prefix (PRUNEMAIN / FULLMAIN / PRUNETEST)
_instance_key() {
    local net="$1" type="$2"
    [[ "$type" == "full" ]]                           && echo "FULLMAIN"  && return
    [[ "$type" == "pruned" && "$net" == "mainnet" ]]  && echo "PRUNEMAIN" && return
    [[ "$net" == "testnet" ]]                         && echo "PRUNETEST" && return
    echo ""
}

# Update instances conf after a successful live process detection
save_instance_detection() {
    [[ -z "$NETWORK_TYPE" || -z "$NODE_TYPE" ]] && return 0
    local key; key=$(_instance_key "$NETWORK_TYPE" "$NODE_TYPE")
    [[ -z "$key" ]] && return 0
    mkdir -p "$CONF_DIR"
    [[ -f "$INSTANCES_CONF" ]] && sed -i "/^${key}_/d" "$INSTANCES_CONF"
    cat >> "$INSTANCES_CONF" << __EOF__

${key}_GRIN_DIR="$GRIN_DIR"
${key}_BINARY="$GRIN_BINARY"
${key}_TOML="$GRIN_CONFIG_FILE"
${key}_CHAIN_DATA="$GRIN_DATA_DIR"
__EOF__
    chmod 600 "$INSTANCES_CONF"
    log "Instance location updated in conf: $key"
}

# Fallback: load instance vars from conf when grin process is not running.
# Two conditions required: (1) port matches expected network, (2) chain_data dir exists.
load_instance_from_conf() {
    local port="$1"
    [[ ! -f "$INSTANCES_CONF" ]] && return 1

    source "$INSTANCES_CONF" 2>/dev/null || return 1

    local expected_network candidates=()
    if [[ "$port" == "$GRIN_PORT_MAINNET" ]]; then
        expected_network="mainnet"
        candidates=(PRUNEMAIN FULLMAIN)
    elif [[ "$port" == "$GRIN_PORT_TESTNET" ]]; then
        expected_network="testnet"
        candidates=(PRUNETEST)
    else
        return 1
    fi

    for key in "${candidates[@]}"; do
        local chain_var="${key}_CHAIN_DATA"
        local chain_dir="${!chain_var}"
        [[ -z "$chain_dir" || ! -d "$chain_dir" ]] && continue

        local grin_dir_var="${key}_GRIN_DIR"
        local binary_var="${key}_BINARY"
        local toml_var="${key}_TOML"
        GRIN_DIR="${!grin_dir_var}"
        GRIN_BINARY="${!binary_var}"
        GRIN_CONFIG_FILE="${!toml_var}"
        GRIN_DATA_DIR="$chain_dir"
        NETWORK_TYPE="$expected_network"
        if [[ "$key" == "FULLMAIN" ]]; then
            NODE_TYPE="full";   ARCHIVE_NODE=true
        else
            NODE_TYPE="pruned"; ARCHIVE_NODE=false
        fi
        log "Conf fallback OK: port=$port key=$key network=$NETWORK_TYPE chain_data=$GRIN_DATA_DIR"
        return 0
    done

    log "Conf fallback: no valid entry for port=$port (expected network=$expected_network)"
    return 1
}

################################################################################
# Validation
################################################################################

display_configuration() {
    log "=========================================="
    log "Detected Configuration"
    log "=========================================="
    log "  Network   : $NETWORK_TYPE"
    log "  Node type : $NODE_TYPE  (archive: $ARCHIVE_NODE)"
    log "  Config    : $GRIN_CONFIG_FILE"
    log "  Binary    : $GRIN_BINARY"
    log "  Chain data: $GRIN_DATA_DIR"
    log "  Port      : $GRIN_PORT"
    log "  tmux      : $TMUX_SESSION"
    log "  Output    : $OUTPUT_DIR"
    log "  Ownership : ${FILE_OWNER:-unchanged}"
    log "=========================================="
}



################################################################################
# Interactive menu
################################################################################

# Return "[configured]" or "[not configured]" for a conf file path
get_conf_status() {
    [[ -f "$1" ]] && echo -e "${GREEN}[configured]${RESET}" || echo -e "${DIM}[not configured]${RESET}"
}

# Return detailed nginx config badge showing which networks are configured
get_nginx_conf_badge() {
    if [[ ! -f "$CONF_NGINX" ]]; then
        echo -e "${DIM}[not configured]${RESET}"
        return
    fi
    local _sync
    _sync=$(grep -E '^SYNC_CHOICE=' "$CONF_NGINX" | cut -d'"' -f2)
    case "$_sync" in
        all)     echo -e "${GREEN}[configured: mainnet + testnet]${RESET}" ;;
        mainnet) echo -e "${GREEN}[configured: mainnet only]${RESET}" ;;
        testnet) echo -e "${GREEN}[configured: testnet only]${RESET}" ;;
        *)       echo -e "${GREEN}[configured]${RESET}" ;;
    esac
}

# ---------------------------------------------------------------------------
# Compression benchmark — answers "which level, and is --sparse worth it?"
# ---------------------------------------------------------------------------
# COMPRESS_LEVEL_FULL=1 was chosen from how Bulletproof rangeproofs and Pedersen
# commitments behave in general, not from a measurement on this box. The honest
# way to settle it is to compress the same bytes at several levels and read the
# numbers - but a full run is ~30 min with the node stopped, so nobody does it
# twice and the question stays open.
#
# This samples instead: the largest files in chain_data are the PMMR data files,
# which dominate both the size and the ratio, so a few hundred MB of them
# predicts the whole archive closely enough to choose a level. The node keeps
# running - this only reads.
#
# It also prints du vs du --apparent-size, which is the other open question:
# apparent > allocated means the files are sparse, and only then is tar --sparse
# worth its compatibility risk (GNU sparse entries are not readable by the
# bsdtar that ships with Windows, so it would break exactly the clients this
# archive exists for).
menu_compress_benchmark() {
    local dir choice i
    load_nginx_config 2>/dev/null || true
    # The chain_data paths live in the INSTANCES conf, not the nginx one. The
    # nginx conf holds LOCAL_WEB_DIR_* — the OUTPUT directories — so sourcing
    # only that left every ${k}_CHAIN_DATA unset and the pick-list permanently
    # empty; the menu silently fell through to "type a path" every time, which
    # looks like a design choice rather than the bug it was.
    [ -f "$INSTANCES_CONF" ] && source "$INSTANCES_CONF" 2>/dev/null

    local -a dirs=() labels=()
    local k v
    for k in FULLMAIN PRUNEMAIN PRUNETEST; do
        v="${k}_CHAIN_DATA"; v="${!v:-}"
        if [ -n "$v" ] && [ -d "$v" ]; then dirs+=("$v"); labels+=("$k"); fi
    done

    echo ""
    echo -e "${BOLD}${CYAN}-- Compression benchmark --${RESET}"
    echo -e "  ${DIM}Reads a sample of chain_data and compresses it at several levels.${RESET}"
    echo -e "  ${DIM}The node keeps running; nothing is written to the web directory.${RESET}"
    echo ""
    # Which instance was picked, so the --rsyncable row below is timed at the
    # level THIS node type actually ships at. Reading $NODE_TYPE instead would
    # be wrong from the menu: detection has not run, so it is usually empty and
    # every benchmark silently reported the pruned level.
    local picked=""
    if [ ${#dirs[@]} -eq 0 ]; then
        echo -ne "  chain_data path: "; read -r dir
    else
        for i in "${!dirs[@]}"; do
            echo -e "    $((i+1))) ${labels[$i]}  ${DIM}${dirs[$i]}${RESET}"
        done
        echo -e "    m) type a path"
        echo -ne "  Select: "; read -r choice
        case "$choice" in
            m|M) echo -ne "  chain_data path: "; read -r dir ;;
            ''|*[!0-9]*) return 0 ;;
            *) if [ "$choice" -ge 1 ] && [ "$choice" -le ${#dirs[@]} ]; then
                   dir="${dirs[$((choice-1))]}"; picked="${labels[$((choice-1))]}"
               else
                   return 0
               fi ;;
        esac
    fi
    [ -d "$dir" ] || { sched_error "Not a directory: $dir"; sleep 2; return 0; }

    local sample_mb=400
    echo -ne "  Sample size in MB [${sample_mb}]: "; read -r i
    case "$i" in
        ''|*[!0-9]*) : ;;
        *) [ "$i" -ge 50 ] && sample_mb="$i" ;;
    esac

    echo ""
    echo -e "  ${BOLD}Sparseness${RESET} ${DIM}(has tar --sparse anything to save?)${RESET}"
    local real_kb app_kb
    real_kb=$(du -sk --exclude='txhashset_snapshot*.zip' --exclude='txhashset_zip*' "$dir" 2>/dev/null | awk '{print $1; exit}')
    app_kb=$(du -sk --apparent-size --exclude='txhashset_snapshot*.zip' --exclude='txhashset_zip*' "$dir" 2>/dev/null | awk '{print $1; exit}')
    # Tested SEPARATELY. Concatenating them hid the case that actually happens —
    # one du succeeding and the other not — because the surviving digits made
    # the pair look numeric, and the comparison below then printed a raw
    # "[: : integer expression expected" into the middle of the report.
    local _sparse_ok=true
    case "$real_kb" in ''|*[!0-9]*) _sparse_ok=false ;; esac
    case "$app_kb"  in ''|*[!0-9]*) _sparse_ok=false ;; esac
    case "$_sparse_ok" in
        false)
            echo -e "    ${DIM}could not measure${RESET}"; real_kb=0 ;;
        *)
            echo -e "    blocks allocated : $((real_kb/1024)) MiB"
            echo -e "    apparent size    : $((app_kb/1024)) MiB"
            if [ "$app_kb" -gt "$((real_kb + real_kb/100))" ]; then
                echo -e "    ${YELLOW}sparse by $(( (app_kb-real_kb)/1024 )) MiB${RESET} - tar --sparse could save that,"
                echo -e "    ${DIM}but only for clients whose tar understands GNU sparse entries.${RESET}"
            else
                echo -e "    ${GREEN}not sparse${RESET} - tar --sparse would save nothing here, so its"
                echo -e "    ${DIM}Windows-bsdtar incompatibility buys us nothing. Question closed.${RESET}"
            fi ;;
    esac

    # Biggest files first: on a Grin node these are the PMMR data/hash files, and
    # they are both the bulk of the archive and the least compressible part of it.
    local -a files=()
    while IFS= read -r i; do files+=("$i"); done < <(
        find "$dir" -type f ! -name 'txhashset_snapshot*.zip' -printf '%s %p\n' 2>/dev/null \
        | sort -rn | head -10 | cut -d' ' -f2- )
    if [ ${#files[@]} -eq 0 ]; then
        sched_error "No files found under $dir"; sleep 2; return 0
    fi

    local bytes=$((sample_mb * 1024 * 1024))
    local -a pre=()
    command -v nice   &>/dev/null && pre+=(nice -n 19)
    command -v ionice &>/dev/null && pre+=(ionice -c 3)

    local cores; cores=$(nproc 2>/dev/null || echo 1)
    case "$cores" in ''|*[!0-9]*) cores=1 ;; esac
    case "$COMPRESS_THREADS" in
        ''|*[!0-9]*) : ;;
        *) if [ "$COMPRESS_THREADS" -ge 1 ] && [ "$COMPRESS_THREADS" -lt "$cores" ]; then
               cores="$COMPRESS_THREADS"
           fi ;;
    esac

    local have_pigz=false
    command -v pigz &>/dev/null && have_pigz=true
    echo ""
    if [ "$have_pigz" = true ]; then
        echo -e "  ${BOLD}Levels${RESET} ${DIM}(pigz, ${cores} core(s), ${sample_mb} MB sample)${RESET}"
    else
        echo -e "  ${BOLD}Levels${RESET} ${DIM}(gzip, single-threaded - install pigz for the real numbers)${RESET}"
    fi

    # Warm-up pass. Without it the first level pays for the disk read and every
    # later one reads from page cache, which would show level 0 as the slowest.
    echo -e "    ${DIM}warming the cache...${RESET}"
    cat "${files[@]}" 2>/dev/null | head -c "$bytes" > /dev/null 2>&1

    local bench_in
    bench_in=$( cat "${files[@]}" 2>/dev/null | head -c "$bytes" | wc -c )
    case "$bench_in" in
        ''|0|*[!0-9]*) sched_error "Could not read a sample."; sleep 2; return 0 ;;
    esac

    printf "    %-16s %8s %9s %9s   %s\n" "LEVEL" "RATIO" "SECONDS" "MB/s" "PROJECTED"
    printf "    %-16s %8s %9s %9s   %s\n" "-----" "-----" "-------" "----" "---------"

    local lvl
    local -a levels
    if [ "$have_pigz" = true ]; then levels=(0 1 3 6 9); else levels=(1 3 6 9); fi

    _bench_one() {
        local label="$1"; shift
        local out t0 t1 secs
        t0=$(date +%s%N 2>/dev/null || echo 0)
        out=$( cat "${files[@]}" 2>/dev/null | head -c "$bytes" | "${pre[@]}" "$@" | wc -c )
        t1=$(date +%s%N 2>/dev/null || echo 0)
        secs=$(awk -v a="$t0" -v b="$t1" 'BEGIN { d=(b-a)/1000000000; if (d<0.001) d=0.001; printf "%.1f", d }')
        awk -v l="$label" -v i="$bench_in" -v o="$out" -v s="$secs" -v tot="$real_kb" \
            'BEGIN {
                 r = o/i;
                 mbps = (s > 0) ? (i/1048576)/s : 0;
                 if (tot > 0)
                     printf "    %-16s %8.3f %9s %9.1f   %.1f GiB\n", l, r, s, mbps, (tot*r)/1048576;
                 else
                     printf "    %-16s %8.3f %9s %9.1f   %s\n", l, r, s, mbps, "-";
             }'
    }

    for lvl in "${levels[@]}"; do
        if [ "$have_pigz" = true ]; then
            _bench_one "-$lvl" pigz "-$lvl" -p "$cores"
        else
            _bench_one "-$lvl" gzip "-$lvl"
        fi
    done

    # What --rsyncable costs, at the level actually shipped for this node type.
    local shiplvl="$COMPRESS_LEVEL_PRUNED" shipwhy="pruned"
    if [ "$picked" = "FULLMAIN" ] || { [ -z "$picked" ] && [ "$NODE_TYPE" = "full" ]; }; then
        shiplvl="$COMPRESS_LEVEL_FULL"; shipwhy="full"
    fi
    case "$shiplvl" in ''|*[!0-9]*) shiplvl=1 ;; esac
    if [ "$have_pigz" = true ] && pigz --help 2>&1 | grep -qi -- '--rsyncable'; then
        _bench_one "-${shiplvl} rsyncable" pigz "-$shiplvl" -p "$cores" --rsyncable
        echo -e "    ${DIM}(that row uses the ${shipwhy} level, ${shiplvl} — what this node ships at)${RESET}"
    fi

    unset -f _bench_one
    echo ""
    echo -e "  ${DIM}Ratio is compressed/original - lower is better. PROJECTED scales the sample${RESET}"
    echo -e "  ${DIM}ratio by the whole chain_data size, so it is an estimate, not a promise.${RESET}"
    echo -e "  ${DIM}If two levels are within a few points, take the faster one: the node is${RESET}"
    echo -e "  ${DIM}stopped for the whole compression, so seconds here are downtime there.${RESET}"
    echo -e "  ${DIM}The 'rsyncable' row is what mirrors pay for cheap incremental copies.${RESET}"
    echo ""
    echo -e "  ${DIM}Set the winner in COMPRESS_LEVEL_FULL / COMPRESS_LEVEL_PRUNED.${RESET}"
    echo ""
    echo "Press Enter to continue..."; read -r
}

show_main_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 03) Grin Node Share & Schedule Manager${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${YELLOW} Note that sharing script below will stop your Grin node ${RESET}"
    echo -e "${BOLD}${YELLOW} and interrupt addons services like Grin API/wallet/explorer/health/mining... ${RESET}"
    echo -e "${BOLD}${YELLOW} Grin process must be running to let the script schedule jobs for you. ${RESET}"
    show_current_schedule
    echo -e "${BOLD}Options:${RESET}"
    echo ""
    echo -e "  ${GREEN}A${RESET}) Create Nginx config        $(get_nginx_conf_badge)"
    echo -e "  ${GREEN}B${RESET}) Share chain data now! ${DIM}[depends on A]${RESET}"
    echo ""
    echo -e "  ${CYAN}C${RESET}) Remote copy setup          $(get_conf_status "$RC_TARGETS_CONF")  ${DIM}(mirrors, keys, schedule)${RESET}"
    echo -e "  ${CYAN}D${RESET}) Copy to mirrors now        ${DIM}[depends on A + C]${RESET}  ${DIM}(node keeps running)${RESET}"
    echo ""
    echo -e "  ${DIM}E${RESET}) Schedule to share chain data"
    echo -e "  ${DIM}F${RESET}) Disable to share chain data"
    echo ""
    echo -e "  ${DIM}G${RESET}) Auto startup Grin node"
    echo -e "  ${DIM}H${RESET}) Disable auto startup Grin node"
    echo ""
    echo -e "  ${DIM}I${RESET}) Auto-delete txhashset snapshots  ${DIM}(schedule cleanup cron)${RESET}"
    echo -e "  ${DIM}J${RESET}) Compression benchmark            ${DIM}(picks the level; node keeps running)${RESET}"
    echo ""
    echo -e "  ${DIM}→ Want to become Grin Master Node? Contribute your sub.domain to the registry:${RESET}"
    echo -e "  ${DIM}  extensions/grinmasternodes.json  (see README.md for details)${RESET}"
    echo ""
    echo -e "  ${RED}0${RESET}) Back to master script"
    echo ""
    echo -ne "${BOLD}Select [A-J / 0]: ${RESET}"
}

# Menu action for B — interactive nginx share
menu_share_nginx() {
    if [[ ! -f "$CONF_NGINX" ]]; then
        show_error_pause "Nginx not configured." "Run option A first."
        return
    fi
    load_nginx_config

    # Which networks MAY run is decided by option A (SYNC_CHOICE); which of them
    # runs THIS time is the operator's call. run_cron_nginx has always taken a
    # per-network filter — the --cron-nginx-main / --cron-nginx-test jobs pass
    # one — but the menu never offered it, so B silently meant "everything A
    # allows". That is the wrong default interactively: a mainnet archive is a
    # ~20 GB build that keeps the node stopped throughout, and there was no way
    # to ask for testnet alone short of editing the config by hand.
    local only_net="" only_label="mainnet + testnet"
    case "$SYNC_CHOICE" in
        mainnet) only_net="mainnet"; only_label="mainnet" ;;
        testnet) only_net="testnet"; only_label="testnet" ;;
        *)
            echo ""
            echo -e "${BOLD}Which network do you want to share now?${RESET}"
            echo ""
            echo -e "  ${GREEN}1${RESET}) Mainnet only"
            echo -e "  ${GREEN}2${RESET}) Testnet only"
            echo -e "  ${GREEN}3${RESET}) Both  ${DIM}(mainnet first, then testnet)${RESET}"
            echo -e "  ${RED}0${RESET}) Cancel"
            echo ""
            echo -ne "${BOLD}Select [1-3 / 0]: ${RESET}"
            local netsel; read -r netsel
            case "$netsel" in
                1) only_net="mainnet"; only_label="mainnet" ;;
                2) only_net="testnet"; only_label="testnet" ;;
                3) only_net="";        only_label="mainnet + testnet" ;;
                0|"") echo -e "${DIM}Cancelled.${RESET}"; return ;;
                *)    sched_warn "Invalid option."; sleep 1; return ;;
            esac
            ;;
    esac

    echo -e "\n${YELLOW}[WARN]${RESET}  Grin will be stopped, chain_data compressed, then restarted."
    echo -e "  ${DIM}Selected: ${only_label}${RESET}"
    echo -ne "Continue? [Y/n/0]: "
    read -r confirm
    [[ "$confirm" == "0" ]] && echo -e "${DIM}Cancelled.${RESET}" && return
    [[ "${confirm,,}" == "n" ]] && echo -e "${DIM}Cancelled.${RESET}" && return

    echo ""
    ( run_cron_nginx "$only_net" )
    local rc=$?
    [ $rc -ne 0 ] && sched_error "Nginx share pipeline failed (exit $rc). Check logs in: $LOG_DIR"
    echo ""
    echo "Press Enter to continue..."
    read -r
}


run_interactive() {
    while true; do
        show_main_menu
        read -r choice

        case "${choice^^}" in
            A) run_nginx_setup ;;
            B) menu_share_nginx ;;
            C) menu_remote_setup || true ;;
            D) menu_remote_copy_now || true ;;
            E) add_nginx_schedule ;;
            F) remove_nginx_schedule ;;
            G) add_grin_autostart ;;
            H) remove_grin_autostart ;;
            I) add_clean_schedule ;;
            J) menu_compress_benchmark || true ;;
            0) break ;;
            "") ;;  # Enter with no input — refresh menu
            *) sched_warn "Invalid option." ; sleep 1 ;;
        esac
    done
}

################################################################################
# Main
################################################################################

main() {
    case "${1:-}" in
        --cron-nginx)       run_cron_nginx            ;;
        --cron-nginx-main)  run_cron_nginx mainnet    ;;
        --cron-nginx-test)  run_cron_nginx testnet    ;;
        --cron-remote)      run_cron_remote "${2:-}"  ;;
        --cron-ssh)         run_cron_remote           ;;   # legacy flag: installed crontabs still use it (no filter = all)
        --cron-clean)       run_txhashset_cleanup     ;;
        *)                  run_interactive           ;;
    esac
}

main "$@"
