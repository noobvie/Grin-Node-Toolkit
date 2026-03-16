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
#   SSH   — rsync the finished archive from the local nginx web dir to one or
#           more remote servers. Does not stop the node; runs independently
#           after the Nginx pipeline has produced the archive.
#
# USAGE
#   Interactive : bash 03_grin_share_chain_data.sh
#   Cron        : bash 03_grin_share_chain_data.sh --cron-nginx
#                 bash 03_grin_share_chain_data.sh --cron-ssh
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
#   · Required packages: tar, openssl, rsync (SSH mode), tmux
#
# BECOME A MASTER NODE
#   If you have a spare VPS and domain, point subdomains to this server and
#   run Scripts 01 → 02 → 03. Your node will share chain data publicly,
#   helping new Grin users sync in minutes instead of days.
#
# LOG FILE
#   <toolkit_root>/log/03_grin_share_YYYYMMDD_HHMMSS.log
#
################################################################################
# ============================================================================
# PATHS & CONSTANTS
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_DIR="$SCRIPT_DIR/../conf"
CONF_NGINX="$CONF_DIR/grin_share_nginx.conf"
CONF_SSH="$CONF_DIR/grin_share_ssh.conf"
INSTANCES_CONF="$CONF_DIR/grin_instances_location.conf"
LOG_DIR="$SCRIPT_DIR/../log"
SCHED_LOG_FILE="$LOG_DIR/schedule.log"
CRON_COMMENT_NGINX="# grin-node-toolkit: grin_share_nginx"
CRON_COMMENT_AUTOSTART_MAIN="# grin-node-toolkit: grin_autostart_mainnet"
CRON_COMMENT_AUTOSTART_TEST="# grin-node-toolkit: grin_autostart_testnet"
CRON_COMMENT_CLEAN="# grin-node-toolkit: grin_clean_txhashset"

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
FILE_OWNER="www-data:www-data"
GRIN_STOP_TIMEOUT=120
FORCE_KILL_IF_STUCK=true
DETECTED_NODE_TYPES=""   # populated by run_nginx_setup, e.g. "mainnet:pruned testnet:pruned"

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

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S UTC' -u)] $1" | tee -a "$LOG_FILE"; }
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

# Write current SSH config variables to CONF_SSH
save_ssh_config() {
    mkdir -p "$CONF_DIR"
    cat > "$CONF_SSH" << __EOF__
# Grin Share — SSH Config
# Generated: $(date -u '+%Y-%m-%d %H:%M:%S UTC')
# Each node type can target a different remote host.
# SSH upload reads from the local nginx web dir — run nginx share first.

FILE_OWNER_SSH="$FILE_OWNER_SSH"

SSH_ENABLE_MAINNET_FULL=$SSH_ENABLE_MAINNET_FULL
SSH_SOURCE_DIR_MAINNET_FULL="$SSH_SOURCE_DIR_MAINNET_FULL"
REMOTE_HOST_MAINNET_FULL="$REMOTE_HOST_MAINNET_FULL"
REMOTE_PORT_MAINNET_FULL="$REMOTE_PORT_MAINNET_FULL"
REMOTE_SSH_KEY_MAINNET_FULL="$REMOTE_SSH_KEY_MAINNET_FULL"
REMOTE_WEB_DIR_MAINNET_FULL="$REMOTE_WEB_DIR_MAINNET_FULL"

SSH_ENABLE_MAINNET_PRUNED=$SSH_ENABLE_MAINNET_PRUNED
SSH_SOURCE_DIR_MAINNET_PRUNED="$SSH_SOURCE_DIR_MAINNET_PRUNED"
REMOTE_HOST_MAINNET_PRUNED="$REMOTE_HOST_MAINNET_PRUNED"
REMOTE_PORT_MAINNET_PRUNED="$REMOTE_PORT_MAINNET_PRUNED"
REMOTE_SSH_KEY_MAINNET_PRUNED="$REMOTE_SSH_KEY_MAINNET_PRUNED"
REMOTE_WEB_DIR_MAINNET_PRUNED="$REMOTE_WEB_DIR_MAINNET_PRUNED"

SSH_ENABLE_TESTNET_PRUNED=$SSH_ENABLE_TESTNET_PRUNED
SSH_SOURCE_DIR_TESTNET_PRUNED="$SSH_SOURCE_DIR_TESTNET_PRUNED"
REMOTE_HOST_TESTNET_PRUNED="$REMOTE_HOST_TESTNET_PRUNED"
REMOTE_PORT_TESTNET_PRUNED="$REMOTE_PORT_TESTNET_PRUNED"
REMOTE_SSH_KEY_TESTNET_PRUNED="$REMOTE_SSH_KEY_TESTNET_PRUNED"
REMOTE_WEB_DIR_TESTNET_PRUNED="$REMOTE_WEB_DIR_TESTNET_PRUNED"
__EOF__
    chmod 600 "$CONF_SSH"
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
    echo -e "  Answers saved to: ${DIM}$CONF_NGINX${RESET}"
    echo -e "  ${DIM}Press Enter to accept the value shown in [brackets].${RESET}"
    echo ""

    # ── Ports ─────────────────────────────────────────────────────────────────
    local tmp
    echo -e "${BOLD}Grin P2P ports${RESET}  ${DIM}(press Enter to keep current, 0 to cancel):${RESET}"
    echo -ne "  Mainnet port [${GRIN_PORT_MAINNET}]: "
    read -r tmp; [[ "$tmp" == "0" ]] && return
    GRIN_PORT_MAINNET="${tmp:-$GRIN_PORT_MAINNET}"
    echo -ne "  Testnet port [${GRIN_PORT_TESTNET}]: "
    read -r tmp; [[ "$tmp" == "0" ]] && return
    GRIN_PORT_TESTNET="${tmp:-$GRIN_PORT_TESTNET}"
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

            scan_cfg=""
            for loc in "$scan_dir/grin-server.toml" "$HOME/.grin/main/grin-server.toml" "/root/.grin/main/grin-server.toml"; do
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

    # ── SYNC_CHOICE — only prompt when both node types are present ────────────
    if [ ${#detected_combos[@]} -ge 2 ]; then
        echo -e "${BOLD}Which networks to share?${RESET}"
        echo -e "  ${GREEN}1${RESET}) both     (mainnet + testnet) !will consume more diskspace!"
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
    else
        # Single node detected — derive automatically, no user prompt needed
        local auto_net="${detected_combos[0]%%:*}"
        SYNC_CHOICE="$auto_net"
        echo -e "  ${DIM}Network: ${auto_net} (auto-selected — only one node detected)${RESET}"
        echo ""
    fi

    # ── Web directories ───────────────────────────────────────────────────────
    local nginx_domains=() nginx_dirs=() ni conf_file sn rd

    if [ -d "/etc/nginx/sites-enabled" ]; then
        for conf_file in /etc/nginx/sites-enabled/*; do
            [ -f "$conf_file" ] || continue
            sn=$(grep -m1 'server_name' "$conf_file" 2>/dev/null | \
                 awk '{for(i=2;i<=NF;i++) if($i!=";" && $i!="_" && $i~/[.]/) {print $i; exit}}' | tr -d ';')
            rd=$(grep -m1 '^\s*root\s' "$conf_file" 2>/dev/null | awk '{print $2}' | tr -d ';')
            [ -n "$sn" ] && [ -n "$rd" ] && { nginx_domains+=("$sn"); nginx_dirs+=("$rd"); }
        done
    fi

    local combo var_name current_val sel manual_opt
    echo -e "${BOLD}Web directory for each detected node:${RESET}"
    echo ""

    if [ ${#nginx_domains[@]} -eq 0 ]; then
        echo -e "  ${DIM}No nginx domains found — enter paths manually.${RESET}"
        echo -e "  ${DIM}Run script 02 first to set up a domain.${RESET}"
        echo ""
    fi

    for combo in "${detected_combos[@]}"; do
        scan_net="${combo%%:*}"
        scan_ntype="${combo##*:}"
        var_name="LOCAL_WEB_DIR_${scan_net^^}_${scan_ntype^^}"
        current_val="${!var_name}"

        echo -e "  ${BOLD}${scan_net^} / ${scan_ntype^}${RESET}"

        # Try auto-match: if a scanned nginx root dir equals the current default, assign silently
        local auto_matched=0
        if [ ${#nginx_dirs[@]} -gt 0 ]; then
            for ni in "${!nginx_dirs[@]}"; do
                if [[ "${nginx_dirs[$ni]}" == "$current_val" ]]; then
                    echo -e "  ${GREEN}✓${RESET} Auto-matched: ${nginx_domains[$ni]}  →  ${nginx_dirs[$ni]}"
                    auto_matched=1
                    break
                fi
            done
        fi

        if [ "$auto_matched" -eq 0 ]; then
            # No auto-match — fall back to interactive selection
            if [ ${#nginx_domains[@]} -gt 0 ]; then
                for ni in "${!nginx_domains[@]}"; do
                    echo -e "    ${GREEN}$((ni+1))${RESET}) ${nginx_domains[$ni]}  →  ${nginx_dirs[$ni]}"
                done
                manual_opt=$((${#nginx_domains[@]}+1))
                echo -e "    ${GREEN}${manual_opt}${RESET}) Enter path manually  ${DIM}[current: ${current_val}]${RESET}"
                echo -e "    ${DIM}0${RESET}) Cancel — return to main menu"
                echo -ne "  Select [0-${manual_opt}]: "
                read -r sel
                [[ "$sel" == "0" ]] && return
                if [[ "$sel" =~ ^[0-9]+$ ]] && \
                   [ "$sel" -ge 1 ] && [ "$sel" -le "${#nginx_domains[@]}" ]; then
                    printf -v "$var_name" '%s' "${nginx_dirs[$((sel-1))]}"
                    echo -e "  ${GREEN}✓${RESET} Set to: ${!var_name}"
                else
                    echo -ne "  Path [${current_val}] or 0 to cancel: "
                    read -r tmp; [[ "$tmp" == "0" ]] && return
                    printf -v "$var_name" '%s' "${tmp:-$current_val}"
                fi
            else
                echo -ne "  Path [${current_val}] or 0 to cancel: "
                read -r tmp; [[ "$tmp" == "0" ]] && return
                printf -v "$var_name" '%s' "${tmp:-$current_val}"
            fi
        fi
        echo ""
    done

    # ── File ownership ────────────────────────────────────────────────────────
    echo -e "${BOLD}File ownership after sync (chown):${RESET}"
    echo -e "  ${DIM}Typical: www-data:www-data  — leave empty to skip, 0 to cancel.${RESET}"
    echo -ne "  owner:group [${FILE_OWNER}]: "
    read -r tmp; [[ "$tmp" == "0" ]] && return
    FILE_OWNER="${tmp:-$FILE_OWNER}"
    echo ""

    # ── Stop timeout ──────────────────────────────────────────────────────────
    echo -e "${BOLD}Grin node graceful-stop timeout (seconds):${RESET}"
    echo -ne "  [${GRIN_STOP_TIMEOUT}] or 0 to cancel: "
    read -r tmp; [[ "$tmp" == "0" ]] && return
    GRIN_STOP_TIMEOUT="${tmp:-$GRIN_STOP_TIMEOUT}"
    echo ""

    # ── Save ──────────────────────────────────────────────────────────────────
    DETECTED_NODE_TYPES="${detected_combos[*]}"
    mkdir -p "$LOG_DIR"
    save_nginx_config
    sched_success "Nginx config saved to: ${CYAN}$CONF_NGINX${RESET}"
    sched_log "Nginx config updated: SYNC_CHOICE=$SYNC_CHOICE DETECTED_NODE_TYPES=$DETECTED_NODE_TYPES"
    echo ""
    echo "Press Enter to continue..."
    read -r
}

################################################################################
# Setup Wizard C — SSH config  (reads node types from nginx conf)
################################################################################

run_ssh_setup() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Grin Share — SSH Configuration Setup${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    if [[ ! -f "$CONF_NGINX" ]]; then
        show_error_pause "Nginx config not found." "Run option A (Create Nginx config) first."
        return
    fi

    load_nginx_config
    load_ssh_config

    if [[ -z "$DETECTED_NODE_TYPES" ]]; then
        show_error_pause "No node types detected in nginx config." "Re-run option A to update the nginx config."
        return
    fi

    echo -e "  Answers saved to: ${DIM}$CONF_SSH${RESET}"
    echo -e "  ${DIM}SSH upload reads from local nginx web dirs — no Grin node interaction.${RESET}"
    echo ""

    # ── Global defaults ───────────────────────────────────────────────────────
    echo -e "${BOLD}Global SSH defaults (applied as starting point for each node type):${RESET}"
    local default_port="22" default_key="/root/.ssh/id_rsa" tmp

    echo -ne "  SSH port [${default_port}] or 0 to cancel: "
    read -r tmp; [[ "$tmp" == "0" ]] && return
    default_port="${tmp:-$default_port}"
    echo -ne "  SSH key  [${default_key}] or 0 to cancel: "
    read -r tmp; [[ "$tmp" == "0" ]] && return
    default_key="${tmp:-$default_key}"
    echo ""

    # ── Per node type ─────────────────────────────────────────────────────────
    local combo net ntype var_enable var_source var_host var_port var_key var_rdir
    local nginx_source cur_enable cur_host cur_port cur_key cur_rdir answer

    for combo in $DETECTED_NODE_TYPES; do
        net="${combo%%:*}"
        ntype="${combo##*:}"
        var_enable="SSH_ENABLE_${net^^}_${ntype^^}"
        var_source="SSH_SOURCE_DIR_${net^^}_${ntype^^}"
        var_host="REMOTE_HOST_${net^^}_${ntype^^}"
        var_port="REMOTE_PORT_${net^^}_${ntype^^}"
        var_key="REMOTE_SSH_KEY_${net^^}_${ntype^^}"
        var_rdir="REMOTE_WEB_DIR_${net^^}_${ntype^^}"

        echo -e "${BOLD}── ${net^} / ${ntype^} ──${RESET}"

        # Pre-fill source from nginx conf
        nginx_source_var="LOCAL_WEB_DIR_${net^^}_${ntype^^}"
        nginx_source="${!nginx_source_var}"

        cur_enable="${!var_enable:-false}"
        cur_host="${!var_host:-user@your-server}"
        cur_port="${!var_port:-$default_port}"
        cur_key="${!var_key:-$default_key}"
        cur_rdir="${!var_rdir:-/var/www/${ntype}${net:0:4}}"

        echo -ne "  Enable SSH upload for this node type? [Y/n/0]: "
        read -r answer
        [[ "$answer" == "0" ]] && return
        if [[ "${answer,,}" == "n" ]]; then
            printf -v "$var_enable" '%s' "false"
            echo -e "  ${DIM}Skipped.${RESET}"
            echo ""
            continue
        fi
        printf -v "$var_enable" '%s' "true"

        echo -ne "  Source dir (local nginx web dir) [${nginx_source}] or 0 to cancel: "
        read -r tmp; [[ "$tmp" == "0" ]] && return; printf -v "$var_source" '%s' "${tmp:-$nginx_source}"

        echo -ne "  Remote host (user@ip)            [${cur_host}] or 0 to cancel: "
        read -r tmp; [[ "$tmp" == "0" ]] && return; printf -v "$var_host" '%s' "${tmp:-$cur_host}"

        echo -ne "  Remote SSH port                  [${cur_port}] or 0 to cancel: "
        read -r tmp; [[ "$tmp" == "0" ]] && return; printf -v "$var_port" '%s' "${tmp:-$cur_port}"

        echo -ne "  SSH key path                     [${cur_key}] or 0 to cancel: "
        read -r tmp; [[ "$tmp" == "0" ]] && return; printf -v "$var_key" '%s' "${tmp:-$cur_key}"

        echo -ne "  Remote web dir                   [${cur_rdir}] or 0 to cancel: "
        read -r tmp; [[ "$tmp" == "0" ]] && return; printf -v "$var_rdir" '%s' "${tmp:-$cur_rdir}"

        # Test SSH connection
        local h="${!var_host}" p="${!var_port}" k="${!var_key}"
        echo -e "  ${DIM}Testing SSH connection to ${h}...${RESET}"
        if ssh -i "$k" -p "$p" -o BatchMode=yes -o ConnectTimeout=8 "$h" "exit" 2>/dev/null; then
            echo -e "  ${GREEN}✓${RESET} SSH connection OK"
        else
            echo -e "  ${YELLOW}⚠${RESET} SSH connection failed."
            echo -e "  ${DIM}If the key is new, copy it manually:${RESET}"
            echo -e "  ${DIM}  ssh-copy-id -i ${k}.pub -p ${p} ${h}${RESET}"
            echo -e "  ${DIM}Config saved — fix SSH access before running option D.${RESET}"
        fi
        echo ""
    done

    # ── File ownership ────────────────────────────────────────────────────────
    echo -e "${BOLD}Remote file ownership after upload (chown):${RESET}"
    echo -ne "  owner:group [${FILE_OWNER_SSH}] or 0 to cancel: "
    read -r tmp; [[ "$tmp" == "0" ]] && return
    FILE_OWNER_SSH="${tmp:-$FILE_OWNER_SSH}"
    echo ""

    # ── Cron timing advisory ──────────────────────────────────────────────────
    local nginx_cron_entry
    nginx_cron_entry=$(crontab -l 2>/dev/null | grep "grin_share_nginx" | head -1)
    if [ -n "$nginx_cron_entry" ]; then
        echo -e "${YELLOW}[NOTICE]${RESET} Nginx is currently scheduled:"
        echo -e "  ${DIM}$nginx_cron_entry${RESET}"
        echo -e "  Schedule your SSH cron job at least 1-2 hours after nginx finishes."
        echo -e "  Add manually to crontab:"
        echo -e "  ${DIM}bash $(realpath "${BASH_SOURCE[0]}") --cron-ssh >> $LOG_DIR/cron_ssh.log 2>&1${RESET}"
        echo ""
    else
        echo -e "${DIM}SSH cron is managed manually. Once nginx is scheduled, add:${RESET}"
        echo -e "  ${DIM}bash $(realpath "${BASH_SOURCE[0]}") --cron-ssh >> $LOG_DIR/cron_ssh.log 2>&1${RESET}"
        echo ""
    fi

    save_ssh_config
    sched_success "SSH config saved to: ${CYAN}$CONF_SSH${RESET}"
    sched_log "SSH config updated"
    echo ""
    echo "Press Enter to continue..."
    read -r
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
    for path in "$GRIN_DIR/grin-server.toml" "$HOME/.grin/main/grin-server.toml" "/root/.grin/main/grin-server.toml"; do
        if [ -f "$path" ]; then
            GRIN_CONFIG_FILE="$path"
            echo "[$(date '+%Y-%m-%d %H:%M:%S UTC' -u)] Config: $GRIN_CONFIG_FILE"
            return 0
        fi
    done
    echo "[$(date '+%Y-%m-%d %H:%M:%S UTC' -u)] WARNING: grin-server.toml not found — falling back to port-based detection"
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
    # Session name matches script 01 convention: grin_<basename of GRIN_DIR>
    # e.g. /opt/grin/node/mainnet-prune → grin_mainnet-prune
    TMUX_SESSION="grin_$(basename "$GRIN_DIR")"

    local web_dir_var="LOCAL_WEB_DIR_${NETWORK_TYPE^^}_${NODE_TYPE^^}"
    OUTPUT_DIR="${!web_dir_var}"
    FINAL_DEST="local: $OUTPUT_DIR"
    STATUS_FILE="$OUTPUT_DIR/check_status_before_download.txt"

    touch "$LOG_FILE" 2>/dev/null || true
}

reset_detection_vars() {
    GRIN_PORT="" NETWORK_TYPE="" ARCHIVE_NODE="" NODE_TYPE=""
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

# Dual-verification: Grin Owner API v2 + grin client — at least one must confirm no_sync
check_grin_sync_status() {
    log "=========================================="
    log "SYNC STATUS CHECK"
    log "=========================================="

    local api_port
    [ "$NETWORK_TYPE" = "testnet" ] && api_port=13413 || api_port=3413

    local api_secret=""
    for location in "$GRIN_DIR/.api_secret" "$GRIN_DATA_DIR/../.api_secret" \
                    "$HOME/.grin/main/.api_secret" "/root/.grin/main/.api_secret"; do
        if [ -f "$location" ]; then
            api_secret=$(tr -d '\n\r' < "$location" 2>/dev/null)
            log "API secret: $location"
            break
        fi
    done
    [ -z "$api_secret" ] && log "WARNING: .api_secret not found"

    # ── API check ──────────────────────────────────────────────────────────────
    log ""
    log "Check 1/2: Owner API v2..."
    local api_response="" api_sync_status="" api_connections="" api_height=""
    local api_check_passed=false

    if [ -n "$api_secret" ]; then
        api_response=$(curl -s -X POST --connect-timeout 5 \
            -u "grin:$api_secret" "http://127.0.0.1:$api_port/v2/owner" \
            -H "Content-Type: application/json" \
            -d '{"jsonrpc":"2.0","method":"get_status","params":[],"id":1}' 2>/dev/null)
    else
        api_response=$(curl -s -X POST --connect-timeout 5 \
            "http://127.0.0.1:$api_port/v2/owner" \
            -H "Content-Type: application/json" \
            -d '{"jsonrpc":"2.0","method":"get_status","params":[],"id":1}' 2>/dev/null)
    fi

    if [ -z "$api_response" ]; then
        log "  ✗ Cannot connect to Owner API on port $api_port"
    elif echo "$api_response" | grep -q '"error"'; then
        local emsg; emsg=$(echo "$api_response" | grep -o '"message"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4)
        log "  ✗ API error: ${emsg:-unknown}"
    else
        if command -v jq &>/dev/null; then
            api_sync_status=$(echo "$api_response" | jq -r '.result.Ok.sync_status // empty' 2>/dev/null)
            api_connections=$(echo "$api_response" | jq -r '.result.Ok.connections // empty' 2>/dev/null)
            api_height=$(echo "$api_response" | jq -r '.result.Ok.tip.height // empty' 2>/dev/null)
        else
            api_sync_status=$(echo "$api_response" | grep -o '"sync_status"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4)
            api_connections=$(echo "$api_response" | grep -o '"connections"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$')
            api_height=$(echo "$api_response" | grep -o '"height"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$')
        fi
        log "  sync_status: ${api_sync_status:-unknown}  connections: ${api_connections:-?}  height: ${api_height:-?}"
        [ "$api_sync_status" = "no_sync" ] && api_check_passed=true \
            && log "  ✓ API: fully synced" || log "  ✗ API: not synced (${api_sync_status:-unknown})"
    fi

    # ── Client check ───────────────────────────────────────────────────────────
    log ""
    log "Check 2/2: Grin client..."
    local client_output="" client_exit_code=1 client_sync_status="" client_check_passed=false
    local attempt=1

    if [ ! -f "$GRIN_BINARY" ]; then
        log "  ✗ Binary not found: $GRIN_BINARY"
    else
        while [ $attempt -le 3 ]; do
            log "  Attempt $attempt/3..."
            client_output=$(cd "$GRIN_DIR" && timeout 30 "$GRIN_BINARY" client status 2>&1)
            client_exit_code=$?
            [ $client_exit_code -eq 0 ] && [ -n "$client_output" ] && { log "  Command succeeded"; break; }
            [ $attempt -lt 3 ] && sleep 5
            attempt=$((attempt+1))
        done

        if [ $client_exit_code -ne 0 ]; then
            log "  ✗ Client failed after 3 attempts"
        else
            client_sync_status=$(echo "$client_output" | tr -d '\r' | grep -i "sync status" | tail -1 | sed 's/.*:[[:space:]]*//' | tr -d '[:space:]')
            log "  Parsed sync status: '${client_sync_status:-not found}'"
            [ "$client_sync_status" = "no_sync" ] && client_check_passed=true \
                && log "  ✓ Client: no_sync" || log "  ✗ Client: '${client_sync_status:-unknown}'"
        fi
    fi

    # ── Result ────────────────────────────────────────────────────────────────
    log ""
    log "  API check:    $([ "$api_check_passed"    = true ] && echo "✓ PASSED" || echo "✗ FAILED (${api_sync_status:-unknown})")"
    log "  Client check: $([ "$client_check_passed" = true ] && echo "✓ PASSED" || echo "✗ FAILED (${client_sync_status:-unknown})")"
    log ""

    if [ "$api_check_passed" = true ] || [ "$client_check_passed" = true ]; then
        [ -n "$api_connections" ] && [ "$api_connections" -ge 1 ] 2>/dev/null \
            && log "  Peer connections: $api_connections" \
            || log "  ⚠ Peer connections unknown or none"
        log "✓ Node verified as fully synced — proceeding"
        return 0
    fi

    log "✗ SYNC CHECK FAILED — BACKUP ABORTED"
    log "Both checks failed. Wait for node to finish syncing, then retry."
    return 1
}

# Validate that the output directory and binary are accessible before starting
validate_nginx_config() {
    local errors=0
    [ ! -d "$GRIN_DATA_DIR" ] && { log "ERROR: chain_data not found: $GRIN_DATA_DIR"; errors=$((errors+1)); }
    [ ! -f "$GRIN_BINARY" ]   && { log "ERROR: binary not found: $GRIN_BINARY";        errors=$((errors+1)); }
    [ $errors -gt 0 ] && exit 1
    log "✓ Configuration validated"
    check_grin_sync_status || exit 1
}

################################################################################
# Nginx pipeline steps
################################################################################

# Step 0: wipe output dir (keep .htaccess)
clean_output_directory() {
    log "Step 0: Cleaning output directory: $OUTPUT_DIR"
    mkdir -p "$OUTPUT_DIR"
    cd "$OUTPUT_DIR" || error_exit "Cannot access $OUTPUT_DIR"
    find . -type f ! -name '.htaccess' -delete
    log "Output directory ready"
}

# Step 1: graceful SIGTERM → SIGKILL if needed
stop_grin_node() {
    log "Step 1: Stopping Grin node..."
    local pid; pid=$(get_pid_on_port "$GRIN_PORT")
    [ -z "$pid" ] && { log "Grin not running on port $GRIN_PORT — skipping"; return 0; }

    log "PID $pid on port $GRIN_PORT — sending SIGTERM..."
    kill -TERM "$pid" 2>/dev/null
    local count=0
    while ps -p "$pid" >/dev/null 2>&1 && [ $count -lt "$GRIN_STOP_TIMEOUT" ]; do
        sleep 2; count=$((count+2))
        [ $((count % 30)) -eq 0 ] && log "Waiting for stop... (${count}s)"
    done

    if ps -p "$pid" >/dev/null 2>&1; then
        [ "$FORCE_KILL_IF_STUCK" = true ] && { log "Timeout — sending SIGKILL..."; kill -KILL "$pid" 2>/dev/null; sleep 3; } \
            || error_exit "Grin failed to stop after ${GRIN_STOP_TIMEOUT}s"
    fi

    is_grin_running && error_exit "Failed to stop Grin after multiple attempts"
    log "Grin stopped (port $GRIN_PORT free)"
}

# Step 2: remove large txhashset zip files before compressing
remove_old_txhashset() {
    log "Step 2: Removing txhashset_snapshot*.zip files..."
    cd "$GRIN_DATA_DIR" || error_exit "Cannot access $GRIN_DATA_DIR"
    local count; count=$(find . -name "txhashset_snapshot*.zip" 2>/dev/null | wc -l)
    [ "$count" -gt 0 ] && find . -name "txhashset_snapshot*.zip" -delete && log "Removed $count file(s)" \
        || log "None found"
}

# Step 3: remove peer list so downloaders start fresh
remove_peer_directory() {
    log "Step 3: Removing peer directory..."
    local d="$GRIN_DATA_DIR/peer"
    [ -d "$d" ] && { rm -rf "$d" && log "Peer directory removed"; } || log "Not found — skipping"
}

# Step 4: write status file to signal download is not yet ready
create_status_in_progress() {
    log "Step 4: Setting status: in progress..."
    mkdir -p "$OUTPUT_DIR"
    echo "Sync is in progress. DO NOT download. Check back in 30 minutes. Last updated $(get_utc_timestamp)" \
        > "$STATUS_FILE"
}

# Step 5: tar.gz chain_data + sha256 checksum
compress_chain_data() {
    log "Step 5: Compressing chain_data..."
    cd "$GRIN_DATA_DIR/.." || error_exit "Cannot access parent of chain_data"
    local dir_name; dir_name=$(basename "$GRIN_DATA_DIR")
    local base="grin_${NODE_TYPE}_${NETWORK_TYPE}_$(date +%Y%m%d)"
    local out="$OUTPUT_DIR/${base}.tar.gz"

    tar -czf "$out" "$dir_name"
    [ $? -ne 0 ] && error_exit "Compression failed"
    cd "$OUTPUT_DIR" && sha256sum "${base}.tar.gz" > "${base}.sha256"
    log "Archive size: $(du -h "$out" | cut -f1)"

    create_readme "$base"
    log "Compression complete"
}

# Step 6: write README.txt with download and setup instructions
create_readme() {
    local base=$1
    local arc_setting chain_setting net_label port_info toml_block

    [ "$ARCHIVE_NODE" = true ] && arc_setting="archive_mode = true" || arc_setting="archive_mode = false"
    if [ "$NETWORK_TYPE" = "testnet" ]; then
        chain_setting='chain_type = "Testnet"'; net_label="TESTNET"; port_info="P2P Port : $GRIN_PORT_TESTNET"
    else
        chain_setting='chain_type = "Mainnet"'; net_label="MAINNET"; port_info="P2P Port : $GRIN_PORT_MAINNET"
    fi
    toml_block="   ${arc_setting}
   ${chain_setting}"

    cat > "$OUTPUT_DIR/README.txt" << EOF
Grin ${NODE_TYPE^} Node Backup - ${net_label}
Created      : $(get_utc_timestamp)
Network      : ${net_label}
Node type    : ${NODE_TYPE^^}
${port_info}
Next chain_data refresh: Undefined as the server owner will decide the cron job.
However, default config will refresh the chain_data At 00:00 on Monday and Thursday.
This Grin master node is configured automatically by the Grin Node Toolkit https://github.com/noobvie/grin-node-toolkit

===Instructions to run your grin node/wallet locally below===
Download Grin binary: https://github.com/mimblewimble/grin/releases

================================================================================
LINUX
================================================================================
1. Download  ${base}.tar.gz  and  ${base}.sha256
2. Verify    sha256sum -c ${base}.sha256
3. Extract   tar -xzf ${base}.tar.gz
4. Stop your Grin node
5. Remove old chain_data, move extracted folder in its place
6. Set in grin-server.toml:
${toml_block}
7. Start Grin node

--- Alternative: on-the-fly extraction (no .tar.gz saved locally) -------------
  Use this if disk space is tight or you want to skip the verification step.
  Streams the archive directly into tar — nothing is stored temporarily.
  SHA256 checksum verification is skipped.

  1. Stop your Grin node
  2. Remove old chain_data:  rm -rf /path/to/grin_dir/chain_data
  3. Run from your Grin node directory:
       cd /path/to/grin_dir
       wget -O - https://<this-server-url>/${base}.tar.gz | tar -xzvf -
  4. Set in grin-server.toml and start Grin node (steps 6 and 7 above)
--------------------------------------------------------------------------------

================================================================================
WINDOWS (PowerShell - tar is built-in)
================================================================================
1. Download all files to a folder
2. Verify    Get-FileHash -Algorithm SHA256 ${base}.tar.gz
             Compare with value in ${base}.sha256
3. Extract   tar -xzf ${base}.tar.gz
4. Stop Grin, replace chain_data folder
5. Edit grin-server.toml (in %USERPROFILE%\.grin\main\):
${toml_block}
6. Start Grin node

--- Alternative: on-the-fly extraction (no .tar.gz saved locally) -------------
  Use this if disk space is tight or you want to skip the verification step.
  Requires curl.exe and tar — both built into Windows 10 / 11 by default.
  Streams the archive directly into tar — nothing is stored temporarily.
  SHA256 checksum verification is skipped.

  1. Stop your Grin node
  2. Delete the old chain_data folder in Explorer or with:
       Remove-Item -Recurse -Force "$env:USERPROFILE\.grin\main\chain_data"
  3. Navigate to your Grin node directory in PowerShell, then run:
       cd "$env:USERPROFILE\.grin\main"
       curl.exe -L "https://<this-server-url>/${base}.tar.gz" | tar -xzf -
  4. Edit grin-server.toml and start Grin node (steps 5 and 6 above)
--------------------------------------------------------------------------------

================================================================================
GRIM WALLET  (https://gri.mw)
================================================================================
1. Download and verify (see Linux or Windows section above)
2. Stop Grim wallet
3. Replace chain_data in:
   Windows : %USERPROFILE%\.grim\main\
   Linux   : ~/.grim/main/
   macOS   : ~/Library/Application Support/grim/main/
4. Edit grin-server.toml in that folder:
${toml_block}
5. Start Grim - first run may take a few minutes to verify the chain

================================================================================
Notes:
  archive_mode = true  -> full node (all history, ~20 GB+)
  archive_mode = false -> pruned node (recent data, ~6 GB+)
  chain_type = "Mainnet" uses port $GRIN_PORT_MAINNET
  chain_type = "Testnet" uses port $GRIN_PORT_TESTNET
  chain_data location set by db_root in grin-server.toml

Support: https://forum.grin.mw/
EOF
    log "README.txt generated"
}

# Step 7: write status file to signal download is ready
update_status_completed() {
    echo "Sync completed. You may download the ${NODE_TYPE} ${NETWORK_TYPE} archive. Verify the checksum first. Last updated: $(get_utc_timestamp)" \
        > "$STATUS_FILE"
    log "Status set: completed"
}

# Step 8: chown output dir to web server user
change_file_ownership() {
    [ -z "$FILE_OWNER" ] && return 0
    log "Step 8: Setting file ownership to $FILE_OWNER..."
    chown -R "$FILE_OWNER" "$OUTPUT_DIR" \
        && log "✓ Ownership set" \
        || log "WARNING: chown failed — run manually: chown -R $FILE_OWNER $OUTPUT_DIR"
}

# Step 9: start Grin in a tmux session
restart_grin_node() {
    log "Step 9: Restarting Grin node..."
    is_grin_running && { log "Already running — skipping"; return 0; }
    [ ! -f "$GRIN_BINARY" ] && { log "WARNING: binary not found at $GRIN_BINARY — start manually"; return 1; }

    cd "$GRIN_DIR" || error_exit "Cannot access $GRIN_DIR"
    command -v tmux &>/dev/null || { apt-get update -qq && apt-get install -y tmux -qq; }

    # Kill any stale session with this name (e.g. left over after stop_grin_node
    # killed the process but not the tmux session)
    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true

    log "Starting in tmux session '$TMUX_SESSION'..."
    tmux new-session -d -s "$TMUX_SESSION" -c "$GRIN_DIR" \
        "echo 'Starting Grin node...'; cd $GRIN_DIR && $GRIN_BINARY server run; echo ''; echo 'Grin process exited. Press Enter to close.'; read"
    sleep 5

    if is_grin_running; then
        log "✓ Grin started (PID: $(get_pid_on_port "$GRIN_PORT"))"
        log "  Attach: tmux attach -t $TMUX_SESSION  |  Detach: Ctrl+B D"
    else
        log "WARNING: Grin did not start within 5s — start manually:"
        log "  tmux new-session -s $TMUX_SESSION '$GRIN_BINARY'"
        return 1
    fi
}

################################################################################
# Nginx pipeline orchestration
################################################################################

# Run the full nginx share pipeline for one port (one node instance)
run_nginx_share_for_port() {
    local port=$1
    check_timezone_utc
    reset_detection_vars

    if detect_active_port "$port"; then
        detect_grin_binary
        detect_config_file
        detect_network_type
        detect_node_type
        detect_chain_data
        setup_derived_variables
        save_instance_detection          # keep conf fresh after live run
    elif ! load_instance_from_conf "$port"; then
        return 0                         # no process, no conf entry — skip silently
    else
        setup_derived_variables          # conf loaded — still need OUTPUT_DIR etc.
    fi

    # Skip if SYNC_CHOICE excludes this network
    [ "$SYNC_CHOICE" = "mainnet" ] && [ "$NETWORK_TYPE" = "testnet" ] && \
        { echo "[$(date '+%Y-%m-%d %H:%M:%S UTC' -u)] Skipping testnet (SYNC_CHOICE=mainnet)"; return 0; }
    [ "$SYNC_CHOICE" = "testnet" ] && [ "$NETWORK_TYPE" = "mainnet" ] && \
        { echo "[$(date '+%Y-%m-%d %H:%M:%S UTC' -u)] Skipping mainnet (SYNC_CHOICE=testnet)"; return 0; }

    log "=========================================="
    log "Starting nginx share: $NETWORK_TYPE / $NODE_TYPE"
    log "=========================================="

    display_configuration
    validate_nginx_config
    clean_output_directory
    stop_grin_node
    remove_old_txhashset
    remove_peer_directory
    create_status_in_progress
    compress_chain_data
    update_status_completed
    change_file_ownership
    restart_grin_node

    log "=========================================="
    log "Nginx share complete: $NETWORK_TYPE / $NODE_TYPE  →  $FINAL_DEST"
    log "=========================================="
}

# Try to start Grin from known directories when not found on expected port.
# Priority: (1) conf file entry, (2) toolkit default directories.
# Session name uses script 01 convention: grin_<basename of dir>
try_start_from_known_dir() {
    local network=$1   # mainnet or testnet
    local port=$2

    local found_binary="" found_dir=""

    # 1) Check conf file first (respects custom install paths)
    if [[ -f "$INSTANCES_CONF" ]]; then
        # shellcheck source=/dev/null
        source "$INSTANCES_CONF" 2>/dev/null || true
        local conf_dir=""
        if [[ "$network" == "testnet" ]]; then
            conf_dir="${PRUNETEST_GRIN_DIR:-}"
        else
            conf_dir="${FULLMAIN_GRIN_DIR:-${PRUNEMAIN_GRIN_DIR:-}}"
        fi
        if [[ -n "$conf_dir" && -x "$conf_dir/grin" ]]; then
            found_dir="$conf_dir"
            found_binary="$conf_dir/grin"
            echo "  → Binary from conf: $found_binary"
        fi
    fi

    # 2) Fall back to toolkit default directories if conf had no entry
    if [[ -z "$found_binary" ]]; then
        local fallback_dirs=()
        if [[ "$network" == "testnet" ]]; then
            fallback_dirs=("/opt/grin/node/testnet-prune")
        else
            fallback_dirs=("/opt/grin/node/mainnet-full" "/opt/grin/node/mainnet-prune")
        fi
        for d in "${fallback_dirs[@]}"; do
            if [[ -x "$d/grin" ]]; then
                found_dir="$d"
                found_binary="$d/grin"
                echo "  → Binary from default path: $found_binary"
                break
            fi
        done
    fi

    if [[ -z "$found_binary" ]]; then
        echo "  ✗ No grin binary found in conf or default directories."
        echo "    Start grin manually and re-run, or verify chain_data exists first."
        return 1
    fi

    command -v tmux &>/dev/null || apt-get install -y tmux -qq
    # Session name matches script 01: grin_<basename of dir>
    local sess="grin_$(basename "$found_dir")"

    # Kill any stale session with this name before starting fresh
    tmux kill-session -t "$sess" 2>/dev/null || true

    tmux new-session -d -s "$sess" -c "$found_dir" \
        "echo 'Starting Grin node...'; cd $found_dir && ./grin server run; echo ''; echo 'Grin process exited. Press Enter to close.'; read" \
        2>/dev/null || true
    echo "  → Started in tmux session '$sess' — waiting for port $port (up to 120s)..."

    local elapsed=0
    while [ $elapsed -lt 120 ]; do
        sleep 5; elapsed=$((elapsed + 5))
        if [ -n "$(get_pid_on_port "$port")" ]; then
            echo "  ✓ Grin $network is up after ${elapsed}s"
            return 0
        fi
        [ $((elapsed % 30)) -eq 0 ] && echo "    ... still waiting (${elapsed}s)"
    done

    echo "  ✗ Grin $network did not start within 120s"
    echo "    Start manually:  cd $found_dir && tmux attach -t $sess"
    return 1
}

# Entry point for --cron-nginx  (loads nginx conf, runs both ports)
run_cron_nginx() {
    if [[ ! -f "$CONF_NGINX" ]]; then
        echo "ERROR: Nginx config not found: $CONF_NGINX"
        echo "Run the script interactively and select option A first."
        exit 1
    fi
    load_nginx_config

    echo "=========================================="
    echo " Grin Share — Nginx pipeline"
    echo "=========================================="
    echo " SYNC_CHOICE: $SYNC_CHOICE"
    echo ""

    local has_main=false has_test=false
    [ -n "$(get_pid_on_port "$GRIN_PORT_MAINNET")" ] && has_main=true
    [ -n "$(get_pid_on_port "$GRIN_PORT_TESTNET")" ] && has_test=true

    # If not running, attempt auto-start from toolkit default directories
    if [ "$has_main" = false ] && [ "$SYNC_CHOICE" != "testnet" ]; then
        echo "  - Mainnet not running — attempting auto-start..."
        try_start_from_known_dir "mainnet" "$GRIN_PORT_MAINNET" && has_main=true
    fi
    if [ "$has_test" = false ] && [ "$SYNC_CHOICE" != "mainnet" ]; then
        echo "  - Testnet not running — attempting auto-start..."
        try_start_from_known_dir "testnet" "$GRIN_PORT_TESTNET" && has_test=true
    fi

    [ "$has_main" = false ] && [ "$has_test" = false ] && {
        echo "ERROR: No Grin node running or started on port $GRIN_PORT_MAINNET or $GRIN_PORT_TESTNET"
        echo "Start grin manually, let it sync, then retry."
        exit 1
    }

    [ "$has_main" = true ] && echo "  ✓ Mainnet ready" || echo "  - Mainnet skipped (not running / SYNC_CHOICE=$SYNC_CHOICE)"
    [ "$has_test" = true ] && echo "  ✓ Testnet ready" || echo "  - Testnet skipped (not running / SYNC_CHOICE=$SYNC_CHOICE)"
    echo ""

    run_nginx_share_for_port "$GRIN_PORT_MAINNET"
    run_nginx_share_for_port "$GRIN_PORT_TESTNET"

    echo ""
    echo "=========================================="
    echo " Nginx share jobs finished"
    echo "=========================================="
}

################################################################################
# SSH pipeline
################################################################################

# Rsync one node type from local nginx web dir to remote server
run_ssh_share_for_combo() {
    local net=$1 ntype=$2

    local var_en="SSH_ENABLE_${net^^}_${ntype^^}"
    local var_src="SSH_SOURCE_DIR_${net^^}_${ntype^^}"
    local var_host="REMOTE_HOST_${net^^}_${ntype^^}"
    local var_port="REMOTE_PORT_${net^^}_${ntype^^}"
    local var_key="REMOTE_SSH_KEY_${net^^}_${ntype^^}"
    local var_rdir="REMOTE_WEB_DIR_${net^^}_${ntype^^}"

    [ "${!var_en}" != "true" ] && return 0   # disabled — skip silently

    local src="${!var_src}" host="${!var_host}" port="${!var_port}"
    local key="${!var_key}" rdir="${!var_rdir}"

    local ssh_log="$LOG_DIR/share_ssh_${net}_${ntype}_$(date -u '+%Y%m%d_%H%M%S').log"
    mkdir -p "$LOG_DIR"; touch "$ssh_log"
    local lf="$ssh_log"   # shorthand so we can use the log() helper below

    # Temporarily redirect log() to the ssh log file
    LOG_FILE="$lf"

    log "=========================================="
    log "SSH share: $net / $ntype"
    log "=========================================="
    log "  Source : $src"
    log "  Target : $host:$rdir"

    # Validate source dir
    if [ ! -d "$src" ]; then
        log "ERROR: Source dir not found: $src"
        log "Run option B (Share via Nginx) first to produce the archive."
        return 1
    fi

    # Check source has archive files
    local archive_count; archive_count=$(find "$src" -maxdepth 1 -name "*.tar.gz*" 2>/dev/null | wc -l)
    if [ "$archive_count" -eq 0 ]; then
        log "ERROR: No .tar.gz files found in $src"
        log "Run option B (Share via Nginx) first to produce the archive."
        return 1
    fi
    log "  Found $archive_count archive file(s) in source"

    # Test SSH connection
    if ! ssh -i "$key" -p "$port" -o BatchMode=yes -o ConnectTimeout=10 "$host" "exit" 2>/dev/null; then
        log "ERROR: SSH connection failed to $host:$port"
        log "Check your SSH key: $key"
        log "Copy key if needed: ssh-copy-id -i ${key}.pub -p $port $host"
        return 1
    fi
    log "✓ SSH connection OK"

    # Ensure remote dir exists
    ssh -i "$key" -p "$port" "$host" "mkdir -p '$rdir'" 2>/dev/null \
        || { log "ERROR: Cannot create remote dir $rdir"; return 1; }

    # Write in-progress status to remote
    local msg_in="SSH upload in progress. DO NOT download. Check back in 1 hour. $(get_utc_timestamp)"
    ssh -i "$key" -p "$port" "$host" "echo '$msg_in' > '$rdir/check_status_before_download.txt'" 2>/dev/null \
        && log "Remote status: upload in progress" \
        || log "WARNING: Could not write remote status file"

    # Rsync source → remote
    log "Uploading via rsync..."
    rsync -az --progress --delete \
        --exclude='.htaccess' --exclude='.*' \
        -e "ssh -i $key -p $port" \
        "$src/" "$host:$rdir/"

    local rc=$?
    if [ $rc -eq 0 ]; then
        log "✓ Upload complete"
        # Write completed status
        local msg_ok="Sync completed. Download the ${ntype} ${net} archive and verify the checksum. $(get_utc_timestamp)"
        ssh -i "$key" -p "$port" "$host" "echo '$msg_ok' > '$rdir/check_status_before_download.txt'" 2>/dev/null
        # Set remote ownership
        [ -n "$FILE_OWNER_SSH" ] && \
            ssh -i "$key" -p "$port" "$host" "chown -R $FILE_OWNER_SSH '$rdir'" 2>/dev/null \
            && log "✓ Remote ownership set to $FILE_OWNER_SSH" \
            || log "WARNING: Could not set remote ownership"
        log "SSH share done: $net / $ntype → $host:$rdir"
    else
        log "ERROR: rsync failed (exit $rc)"
        return 1
    fi
}

# Entry point for --cron-ssh  (loads ssh conf, iterates all enabled combos)
run_cron_ssh() {
    if [[ ! -f "$CONF_SSH" ]]; then
        echo "ERROR: SSH config not found: $CONF_SSH"
        echo "Run the script interactively and select option C first."
        exit 1
    fi
    load_ssh_config

    echo "=========================================="
    echo " Grin Share — SSH pipeline"
    echo "=========================================="
    echo ""

    local any=false
    for combo in mainnet:full mainnet:pruned testnet:pruned; do
        local net="${combo%%:*}" ntype="${combo##*:}"
        local var_en="SSH_ENABLE_${net^^}_${ntype^^}"
        if [ "${!var_en}" = "true" ]; then
            any=true
            echo "  ▶ Uploading $net / $ntype..."
            run_ssh_share_for_combo "$net" "$ntype" || \
                echo "  ${RED}[ERROR]${RESET} SSH share failed for $net/$ntype — check log in $LOG_DIR"
        fi
    done

    [ "$any" = false ] && echo "  No SSH targets enabled. Run option C to configure." && exit 1

    echo ""
    echo "=========================================="
    echo " SSH share jobs finished"
    echo "=========================================="
}

################################################################################
# I) Auto-delete txhashset snapshot zips
################################################################################

# Default directories to scan (chain_data inside each toolkit node dir)
CLEAN_TXHASHSET_DIRS=(
    "/opt/grin/node/mainnet-prune/chain_data"
    "/opt/grin/node/mainnet-full/chain_data"
    "/opt/grin/node/testnet-prune/chain_data"
)

# Entry point for --cron-clean
run_txhashset_cleanup() {
    local ts; ts="[$(date -u '+%Y-%m-%d %H:%M:%S UTC')]"
    echo "$ts Starting txhashset_snapshot_*.zip cleanup..."
    local total=0
    for d in "${CLEAN_TXHASHSET_DIRS[@]}"; do
        if [[ ! -d "$d" ]]; then
            echo "$ts   Skip: $d (not found)"
            continue
        fi
        local count; count=$(find "$d" -maxdepth 1 -name "txhashset_snapshot_*.zip" 2>/dev/null | wc -l)
        if [[ "$count" -gt 0 ]]; then
            find "$d" -maxdepth 1 -name "txhashset_snapshot_*.zip" -delete
            echo "$ts   Removed $count file(s) from $d"
            total=$((total + count))
        else
            echo "$ts   None found in $d"
        fi
    done
    echo "$ts Done. Total removed: $total file(s)"
}

################################################################################
# Schedule management  (nginx cron only — SSH cron is managed manually)
################################################################################

show_current_schedule() {
    echo -e "${BOLD}Current Grin share schedule(s) in crontab:${RESET}"
    echo ""
    local found=0
    while IFS= read -r line; do
        echo "$line" | grep -q "grin-" && { echo -e "  ${GREEN}▶${RESET} $line"; found=1; }
    done < <(crontab -l 2>/dev/null || true)
    [ $found -eq 0 ] && echo -e "  ${DIM}No Grin share cron jobs found.${RESET}"
    echo ""
}

list_presets() {
    local now_h now_m
    now_h=$(date +%-H)
    now_m=$(date +%-M)
    _R_MIN=$(( (RANDOM + now_m) % 60 ))
    _R_HOUR=$(( (RANDOM + now_h) % 24 ))

    # Partial Fisher-Yates: shuffle 4 unique days out of 0-6
    local -a _dow=(0 1 2 3 4 5 6)
    local _i _j _t
    for _i in 0 1 2 3; do
        _j=$(( _i + RANDOM % (7 - _i) ))
        _t="${_dow[$_i]}"; _dow[$_i]="${_dow[$_j]}"; _dow[$_j]="$_t"
    done

    # Sort first 3 days (opt2: 3x/week)
    local a=${_dow[0]} b=${_dow[1]} c=${_dow[2]} t
    [ "$a" -gt "$b" ] && t=$a && a=$b && b=$t
    [ "$b" -gt "$c" ] && t=$b && b=$c && c=$t
    [ "$a" -gt "$b" ] && t=$a && a=$b && b=$t

    # Sort first 2 days (opt4: 2x/week)
    local p=${_dow[0]} q=${_dow[1]}
    [ "$p" -gt "$q" ] && t=$p && p=$q && q=$t

    local -a _DN=("Sun" "Mon" "Tue" "Wed" "Thu" "Fri" "Sat")
    local _HM; printf -v _HM '%02d:%02d' "$_R_HOUR" "$_R_MIN"

    _PRESET2="$_R_MIN $_R_HOUR * * $a,$b,$c"
    _PRESET3="$_R_MIN $_R_HOUR * * *"
    _PRESET4="$_R_MIN $_R_HOUR * * $p,$q"

    echo -e "${BOLD}Schedule presets (UTC):${RESET}"
    echo ""
    echo -e "  ${GREEN}1${RESET}) Mon & Thu at 00:00  ${DIM}(0 0 * * 1,4)${RESET}  [Default]"
    echo -e "  ${GREEN}2${RESET}) 3x/week — ${_DN[$a]}, ${_DN[$b]}, ${_DN[$c]} at ${_HM}  ${DIM}(${_PRESET2})${RESET}"
    echo -e "  ${GREEN}3${RESET}) Daily at ${_HM}  ${DIM}(${_PRESET3})${RESET}"
    echo -e "  ${GREEN}4${RESET}) 2x/week — ${_DN[$p]}, ${_DN[$q]} at ${_HM}  ${DIM}(${_PRESET4})${RESET}"
    echo ""
}

get_cron_expression() {
    list_presets
    echo -e "  ${DIM}0) Cancel${RESET}"
    echo -ne "${BOLD}Select [0-4, default=1]: ${RESET}"
    read -r preset
    [[ "$preset" == "0" ]] && return 1
    case "${preset:-1}" in
        2) CRON_EXPR="$_PRESET2" ;;
        3) CRON_EXPR="$_PRESET3" ;;
        4) CRON_EXPR="$_PRESET4" ;;
        *) CRON_EXPR="0 0 * * 1,4" ;;
    esac
}

# Add or replace the nginx cron entry
add_nginx_schedule() {
    echo -e "\n${BOLD}${CYAN}── Schedule Nginx Jobs ──${RESET}\n"
    local this_script; this_script="$(realpath "${BASH_SOURCE[0]}")"

    get_cron_expression || return

    local log_path="$LOG_DIR/cron_nginx.log"
    echo -ne "Cron log path [${log_path}] or 0 to cancel: "
    read -r tmp; [[ "$tmp" == "0" ]] && return
    log_path="${tmp:-$log_path}"

    local cron_line="$CRON_EXPR bash $this_script --cron-nginx >> $log_path 2>&1 $CRON_COMMENT_NGINX"
    local existing; existing=$(crontab -l 2>/dev/null || true)

    if echo "$existing" | grep -qF "grin_share_nginx"; then
        sched_warn "A nginx cron job already exists."
        echo -ne "Replace it? [Y/n/0]: "
        read -r rep
        [[ "$rep" == "0" ]] && return
        if [[ "${rep,,}" == "n" ]]; then
            sched_info "Keeping existing schedule."; echo ""; echo "Press Enter to continue..."; read -r; return
        else
            existing=$(echo "$existing" | grep -v "grin_share_nginx" || true)
        fi
    fi

    (echo "$existing"; echo "$cron_line") | grep -v '^$' | crontab -
    sched_success "Nginx schedule set: ${CYAN}$CRON_EXPR${RESET}"
    sched_log "Added nginx cron: $cron_line"

    # Show SSH cron advisory
    echo ""
    echo -e "${DIM}── SSH cron advisory ────────────────────────────────────────────────${RESET}"
    echo -e "${DIM}SSH upload is managed manually. Schedule it at least 1-2 hours after${RESET}"
    echo -e "${DIM}the nginx job so compression finishes before the upload starts.${RESET}"
    echo -e "${DIM}Add to crontab:  bash $this_script --cron-ssh >> $LOG_DIR/cron_ssh.log 2>&1${RESET}"
    echo -e "${DIM}────────────────────────────────────────────────────────────────────${RESET}"
    echo ""
    echo "Press Enter to continue..."
    read -r
}

# Remove all nginx cron entries managed by this script
remove_nginx_schedule() {
    echo -e "\n${BOLD}${CYAN}── Disable Nginx Jobs ──${RESET}\n"
    show_current_schedule
    echo -ne "${YELLOW}Remove chain_data sharing cron job only? [Y/n/0]: ${RESET}"
    read -r confirm
    [[ "$confirm" == "0" ]] && return
    if [[ "${confirm,,}" != "n" ]]; then
        local tmp_cron; tmp_cron=$(crontab -l 2>/dev/null | grep -v "grin_share_nginx" || true)
        echo "$tmp_cron" | crontab -
        sched_success "Nginx cron jobs removed."
        sched_log "Removed nginx cron jobs"
    else
        sched_info "No changes made."
    fi
    echo ""
    echo "Press Enter to continue..."
    read -r
}

################################################################################
# I) Schedule auto-delete of txhashset snapshot zips
################################################################################

add_clean_schedule() {
    echo -e "\n${BOLD}${CYAN}── Auto-Delete txhashset Snapshots ──${RESET}\n"
    echo -e "  Deletes ${BOLD}txhashset_snapshot_*.zip${RESET} files from chain_data directories:"
    for d in "${CLEAN_TXHASHSET_DIRS[@]}"; do
        echo -e "    ${DIM}$d${RESET}"
    done
    echo ""
    echo -e "  ${BOLD}Schedule:${RESET}"
    echo -e "  ${GREEN}1${RESET}) Every  4 hours  ${DIM}(0 */4  * * *)${RESET}  [Default]"
    echo -e "  ${GREEN}2${RESET}) Every 12 hours  ${DIM}(0 */12 * * *)${RESET}"
    echo -e "  ${GREEN}3${RESET}) Every 24 hours  ${DIM}(0 0    * * *)${RESET}"
    echo -e "  ${DIM}0${RESET}) Cancel"
    echo ""
    echo -ne "${BOLD}Select [0-3, default=1]: ${RESET}"
    local sel; read -r sel
    [[ "$sel" == "0" ]] && return

    local clean_expr
    case "${sel:-1}" in
        2) clean_expr="0 */12 * * *" ;;
        3) clean_expr="0 0    * * *" ;;
        *) clean_expr="0 */4  * * *" ;;
    esac

    local this_script; this_script="$(realpath "${BASH_SOURCE[0]}")"
    local clean_log="$LOG_DIR/cron_clean_txhashset.log"
    local cron_line="$clean_expr bash $this_script --cron-clean >> $clean_log 2>&1 $CRON_COMMENT_CLEAN"
    local existing; existing=$(crontab -l 2>/dev/null || true)

    if echo "$existing" | grep -qF "grin_clean_txhashset"; then
        sched_warn "A cleanup cron job already exists."
        echo -ne "Replace it? [Y/n/0]: "
        local rep; read -r rep
        [[ "$rep" == "0" ]] && return
        if [[ "${rep,,}" == "n" ]]; then
            sched_info "Keeping existing schedule."; echo ""; echo "Press Enter to continue..."; read -r; return
        else
            existing=$(echo "$existing" | grep -v "grin_clean_txhashset" || true)
        fi
    fi

    (echo "$existing"; echo "$cron_line") | grep -v '^$' | crontab -
    sched_success "Cleanup schedule set: ${CYAN}$clean_expr${RESET}"
    sched_log "Added txhashset cleanup cron: $cron_line"
    echo ""
    echo "Press Enter to continue..."
    read -r
}

################################################################################
# G) Auto startup Grin node — add @reboot crontab entries
################################################################################

add_grin_autostart() {
    echo -e "\n${BOLD}${CYAN}── Auto Startup Grin Node ──${RESET}\n"

    echo -e "  Which network to autostart?"
    echo -e "  ${GREEN}1${RESET}) Mainnet"
    echo -e "  ${GREEN}2${RESET}) Testnet"
    echo -e "  ${GREEN}3${RESET}) Both"
    echo -e "  ${DIM}0${RESET}) Cancel"
    echo ""
    local net_choice networks=()
    while true; do
        echo -ne "${BOLD}Select [1/2/3/0]: ${RESET}"
        read -r net_choice
        [[ "$net_choice" == "0" ]] && return
        [[ -z "$net_choice" ]] && continue
        case "$net_choice" in
            1) networks=("mainnet");              break ;;
            2) networks=("testnet");              break ;;
            3) networks=("mainnet" "testnet");    break ;;
            *) sched_warn "Invalid selection."; sleep 1 ;;
        esac
    done

    local existing_cron
    existing_cron=$(crontab -l 2>/dev/null || true)
    local new_lines=""

    for net in "${networks[@]}"; do
        local port="" label="" default_delay="" cron_marker=""
        if [[ "$net" == "mainnet" ]]; then
            port=$GRIN_PORT_MAINNET
            label="Mainnet"
            default_delay=60
            cron_marker="$CRON_COMMENT_AUTOSTART_MAIN"
        else
            port=$GRIN_PORT_TESTNET
            label="Testnet"
            default_delay=120
            cron_marker="$CRON_COMMENT_AUTOSTART_TEST"
        fi

        echo ""
        echo -e "  ${BOLD}── $label ──${RESET}"

        # Use the same detection pipeline as restart_grin_node
        reset_detection_vars
        if detect_active_port "$port" >/dev/null 2>&1; then
            # Binary: same technique as detect_grin_binary but graceful (no error_exit)
            local pid=""
            pid=$(get_pid_on_port "$GRIN_PORT" | head -1) || true
            GRIN_BINARY=$(readlink -f "/proc/$pid/exe" 2>/dev/null) || true
            if [[ -n "$GRIN_BINARY" && -f "$GRIN_BINARY" ]]; then
                GRIN_DIR=$(dirname "$GRIN_BINARY")
                detect_config_file  >/dev/null 2>&1
                detect_network_type >/dev/null 2>&1
                detect_node_type    >/dev/null 2>&1
                TMUX_SESSION="grin-${NODE_TYPE}-${NETWORK_TYPE}"
                sched_info "Detected binary : $GRIN_BINARY"
                sched_info "tmux session    : $TMUX_SESSION"
            else
                GRIN_BINARY=""
            fi
        fi

        if [[ -z "$GRIN_BINARY" ]]; then
            sched_warn "No $label grin process found on port $port."
            echo -ne "  Enter binary path manually (or 0 to skip): "
            local manual_bin=""
            read -r manual_bin
            [[ "$manual_bin" == "0" || -z "$manual_bin" ]] && sched_info "Skipping $label." && continue
            GRIN_BINARY="$manual_bin"
            GRIN_DIR=$(dirname "$GRIN_BINARY")
            TMUX_SESSION="grin-$net"
        fi

        echo -ne "  Boot delay in seconds [$default_delay]: "
        local delay_input="" delay=""
        read -r delay_input
        delay="${delay_input:-$default_delay}"
        if ! [[ "$delay" =~ ^[0-9]+$ ]]; then
            sched_warn "Invalid delay — using default ($default_delay s)."
            delay=$default_delay
        fi

        local cron_line="@reboot sleep $delay && cd $GRIN_DIR && env SHELL=/bin/bash tmux new-session -d -s $TMUX_SESSION $GRIN_BINARY $cron_marker"

        # Check for existing entry
        if echo "$existing_cron" | grep -qF "$cron_marker"; then
            sched_warn "An autostart entry for $label already exists."
            echo -ne "  Replace it? [Y/n/0]: "
            local rep=""
            read -r rep
            [[ "$rep" == "0" ]] && return
            if [[ "${rep,,}" != "n" ]]; then
                existing_cron=$(echo "$existing_cron" | grep -vF "$cron_marker" || true)
                new_lines+=$'\n'"$cron_line"
                sched_success "$label autostart replaced."
            else
                sched_info "Keeping existing $label entry."
            fi
        else
            new_lines+=$'\n'"$cron_line"
            sched_success "$label autostart added."
        fi

        sched_info "  Delay  : ${delay}s after boot"
        sched_info "  Attach : tmux attach -t $TMUX_SESSION"
    done

    if [[ -n "$new_lines" ]]; then
        (echo "$existing_cron"; echo "$new_lines") | grep -v '^$' | crontab -
        echo ""
        sched_success "Crontab updated. Run 'crontab -l' to verify."
    fi
    echo ""
    echo "Press Enter to continue..."
    read -r
}

################################################################################
# H) Disable auto startup Grin node — remove @reboot entries
################################################################################

remove_grin_autostart() {
    echo -e "\n${BOLD}${CYAN}── Disable Auto Startup Grin Node ──${RESET}\n"

    local existing_cron
    existing_cron=$(crontab -l 2>/dev/null || true)

    local has_main has_test
    has_main=$(echo "$existing_cron" | grep -cF "$CRON_COMMENT_AUTOSTART_MAIN" || true)
    has_test=$(echo "$existing_cron" | grep -cF "$CRON_COMMENT_AUTOSTART_TEST" || true)

    if [[ "$has_main" -eq 0 && "$has_test" -eq 0 ]]; then
        sched_info "No Grin autostart entries found in crontab."
        echo ""
        echo "Press Enter to continue..."
        read -r
        return
    fi

    echo -e "  ${BOLD}Current autostart entries:${RESET}"
    [[ "$has_main" -gt 0 ]] && echo -e "    ${GREEN}●${RESET} Mainnet autostart present"
    [[ "$has_test" -gt 0 ]] && echo -e "    ${GREEN}●${RESET} Testnet autostart present"
    echo ""
    echo -e "  Remove which?"
    [[ "$has_main" -gt 0 ]] && echo -e "  ${GREEN}1${RESET}) Mainnet"
    [[ "$has_test" -gt 0 ]] && echo -e "  ${GREEN}2${RESET}) Testnet"
    [[ "$has_main" -gt 0 && "$has_test" -gt 0 ]] && echo -e "  ${GREEN}3${RESET}) Both"
    echo -e "  ${DIM}0${RESET}) Cancel"
    echo ""
    local choice tmp_cron="$existing_cron"
    while true; do
        echo -ne "${BOLD}Select: ${RESET}"
        read -r choice
        [[ "$choice" == "0" ]] && return
        [[ -z "$choice" ]] && continue
        case "$choice" in
            1) tmp_cron=$(echo "$tmp_cron" | grep -vF "$CRON_COMMENT_AUTOSTART_MAIN" || true)
               sched_success "Mainnet autostart removed."; break ;;
            2) tmp_cron=$(echo "$tmp_cron" | grep -vF "$CRON_COMMENT_AUTOSTART_TEST" || true)
               sched_success "Testnet autostart removed."; break ;;
            3) tmp_cron=$(echo "$tmp_cron" | grep -vF "$CRON_COMMENT_AUTOSTART_MAIN" | grep -vF "$CRON_COMMENT_AUTOSTART_TEST" || true)
               sched_success "Mainnet and Testnet autostart removed."; break ;;
            *) sched_warn "Invalid selection."; sleep 1 ;;
        esac
    done

    echo "$tmp_cron" | crontab -
    sched_log "Removed grin autostart cron entries (choice: $choice)"
    echo ""
    echo "Press Enter to continue..."
    read -r
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
    echo -e "  ${CYAN}C${RESET}) Create SSH config          $(get_conf_status "$CONF_SSH")  ${DIM}(optional)${RESET}"
    echo -e "  ${CYAN}D${RESET}) Share chain data via SSH   ${DIM}[depends on A + C]${RESET}  ${DIM}(optional)${RESET}"
    echo ""
    echo -e "  ${DIM}E${RESET}) Schedule to share chain data"
    echo -e "  ${DIM}F${RESET}) Disable to share chain data"
    echo ""
    echo -e "  ${DIM}G${RESET}) Auto startup Grin node"
    echo -e "  ${DIM}H${RESET}) Disable auto startup Grin node"
    echo ""
    echo -e "  ${DIM}I${RESET}) Auto-delete txhashset snapshots  ${DIM}(schedule cleanup cron)${RESET}"
    echo ""
    echo -e "  ${DIM}→ Want to become Grin Master Node? Contribute your sub.domain to the registry:${RESET}"
    echo -e "  ${DIM}  extensions/grinmasternodes.json  (see README.md for details)${RESET}"
    echo ""
    echo -e "  ${RED}0${RESET}) Back to master script"
    echo ""
    echo -ne "${BOLD}Select [A-I / 0]: ${RESET}"
}

# Menu action for B — interactive nginx share
menu_share_nginx() {
    if [[ ! -f "$CONF_NGINX" ]]; then
        show_error_pause "Nginx not configured." "Run option A first."
        return
    fi
    load_nginx_config

    echo -e "\n${YELLOW}[WARN]${RESET}  Grin will be stopped, chain_data compressed, then restarted."
    echo -ne "Continue? [Y/n/0]: "
    read -r confirm
    [[ "$confirm" == "0" ]] && echo -e "${DIM}Cancelled.${RESET}" && return
    [[ "${confirm,,}" == "n" ]] && echo -e "${DIM}Cancelled.${RESET}" && return

    echo ""
    ( run_cron_nginx )
    local rc=$?
    [ $rc -ne 0 ] && sched_error "Nginx share pipeline failed (exit $rc). Check logs in: $LOG_DIR"
    echo ""
    echo "Press Enter to continue..."
    read -r
}

# Menu action for D — interactive SSH share
menu_share_ssh() {
    if [[ ! -f "$CONF_NGINX" ]]; then
        show_error_pause "Nginx config not found." "Run option A first — SSH reads from local nginx web dirs."
        return
    fi
    if [[ ! -f "$CONF_SSH" ]]; then
        show_error_pause "SSH config not found." "Run option C first."
        return
    fi

    load_nginx_config
    load_ssh_config

    echo -e "\n${CYAN}[INFO]${RESET}  SSH share reads from local nginx web dirs and rsyncs to remote."
    echo -e "  ${DIM}Ensure nginx share (B) has run recently before uploading.${RESET}"
    echo ""

    ( run_cron_ssh )
    local rc=$?
    [ $rc -ne 0 ] && sched_error "SSH share pipeline failed (exit $rc). Check logs in: $LOG_DIR"
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
            C) run_ssh_setup ;;
            D) menu_share_ssh ;;
            E) add_nginx_schedule ;;
            F) remove_nginx_schedule ;;
            G) add_grin_autostart ;;
            H) remove_grin_autostart ;;
            I) add_clean_schedule ;;
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
        --cron-nginx)  run_cron_nginx        ;;
        --cron-ssh)    run_cron_ssh          ;;
        --cron-clean)  run_txhashset_cleanup ;;
        *)             run_interactive       ;;
    esac
}

main "$@"
