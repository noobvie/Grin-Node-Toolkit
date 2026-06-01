#!/bin/bash
# =============================================================================
# 07_grin_mining_solo.sh — Grin Solo Mining Setup
# =============================================================================
# Configure and manage solo mining on a Grin node.
# Enables the node's built-in stratum server, sets your wallet reward address,
# and publishes the port so miners can connect directly.
#
# ─── Menu ─────────────────────────────────────────────────────────────────────
# Grouped sub-menus; each action prompts mainnet / testnet inside (reusing the
# "1) Mainnet 2) Testnet" pattern), so the old per-network letter duplication
# (B/C/D/E mainnet + F/G/I/J testnet) is gone. A) stays a letter as the always-
# visible overview alongside the compact stratum-status header.
#
#   A) Node & Mining Status   (node sync, tmux, stratum config + miner count)
#
#   1) Wallet               ▸ setup/recover · listener · auto-restart · address
#   2) Stratum              ▸ setup · configure · publish · restrict
#   3) Stats & Web          ▸ live dashboard · web page (payment prefixes + lock)
#   4) Health / Watchdogs   ▸ node-sync · boot autostart · wallet listener · stratum
#
#   0) Back to main menu
#
# Migration map (old letter → new home):
#   A  Status .............. A           (kept)
#   B/F Setup Stratum ...... 2 ▸ 1       D/I Publish Stratum .... 2 ▸ 3
#   C/G Configure Stratum .. 2 ▸ 2       E/J Restrict Stratum ... 2 ▸ 4
#   L  Live stats .......... 3 ▸ 1       S  Web page ............ 3 ▸ 2
#   W  Stratum watchdog .... 4 ▸ 4       K  Wallet .............. 1
#   H  Health/Watchdogs .... 4
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLKIT_ROOT="$(dirname "$SCRIPT_DIR")"

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# ─── Constants ────────────────────────────────────────────────────────────────
STRATUM_PORT_MAINNET=3416
STRATUM_PORT_TESTNET=13416
NODE_API_PORT_MAINNET=3413
NODE_API_PORT_TESTNET=13413

# Stats page resources are namespaced "grin-solo-mining-stat" (NOT "grin-stats" —
# Script 06 / Global health owns grin-stats for its ecosystem site). ONE unified
# vhost serves both networks side by side, so there is no per-network suffix.
STATS_WEB_SRC="$TOOLKIT_ROOT/web/07_mining_pool_solo/index.html"
STATS_SETUP_SRC="$TOOLKIT_ROOT/web/07_mining_pool_solo/setup-solo-mining.html"
STATS_LOGO_SRC="$TOOLKIT_ROOT/web/0z0_media/logo_favi/grin_gold.svg"
STATS_BASENAME="grin-solo-mining-stat"

# Mining stats collector (parses node log → rolling JSON: found blocks +
# per-miner hashrate + miningpoolstats-pollable poolstats).
BLOCK_COLLECTOR_SRC="$TOOLKIT_ROOT/scripts/lib/07_mining_block_collector.py"
BLOCK_COLLECTOR_BIN="/usr/local/bin/grin-solo-mining-collector.py"
BLOCK_COLLECTOR_WRAPPER="/usr/local/bin/grin-solo-mining-collector"
BLOCK_COLLECTOR_CRON="/etc/cron.d/grin-solo-mining-collector"
BLOCK_COLLECTOR_STATE_DIR="/opt/grin/solo-stats"
# Reward-split payment calc (mainnet): nickname PREFIXES only, never addresses.
# The collector reads this to emit split_main.json.
PAYMENT_CONFIG="/opt/grin/conf/grin_solo_payment.json"
# Optional stats-page access lock (HTTP Basic Auth over the certbot-managed HTTPS).
STATS_HTPASSWD="/etc/nginx/grin-solo-stats.htpasswd"
WATCHDOG_LOG="/opt/grin/logs/stratum-watchdog.log"
LOG_DIR="/opt/grin/logs"
LOG_FILE="$LOG_DIR/grin_mining_$(date +%Y%m%d_%H%M%S).log"

# ─── Global state ─────────────────────────────────────────────────────────────
FOUND_GRIN_TOML=""

# ─── Logging ──────────────────────────────────────────────────────────────────
mkdir -p "$LOG_DIR"
log()     { echo -e "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; log "[INFO] $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; log "[OK] $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; log "[WARN] $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; log "[ERROR] $*"; }

# ─── Source shared libs ─────────────────────────────────────────────────────
# shellcheck source=lib/nginx_shared_helpers.sh
source "$SCRIPT_DIR/lib/nginx_shared_helpers.sh"
# Node supervision: control primitives + keepalive (boot autostart + node-sync
# watchdog). Central wallet pulls in grin_wallet_install.sh + control (guarded).
# shellcheck source=lib/grin_node_control.sh
source "$SCRIPT_DIR/lib/grin_node_control.sh"
# shellcheck source=lib/grin_node_keepalive.sh
source "$SCRIPT_DIR/lib/grin_node_keepalive.sh"
# shellcheck source=lib/07_solo_wallet.sh
source "$SCRIPT_DIR/lib/07_solo_wallet.sh"

# ═══════════════════════════════════════════════════════════════════════════════
# TOML DETECTION
# ═══════════════════════════════════════════════════════════════════════════════

_KNOWN_TOML_SEARCH_PATHS=(
    /opt/grin/node/mainnet-full   /opt/grin/node/mainnet-prune
    /opt/grin/node/testnet-prune
    "${HOME}/.grin/main"   "${HOME}/.grin/test"
    /root/.grin/main       /root/.grin/test
)

_resolve_stratum_toml() {
    local network="$1" api_port="$2"
    local expected_chain_type="Mainnet"
    [[ "$network" == "testnet" ]] && expected_chain_type="Testnet"

    local pid exe dir
    pid=$(ss -tlnp 2>/dev/null | grep ":$api_port " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
    if [[ -n "$pid" ]]; then
        exe=$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)
        if [[ -n "$exe" ]]; then
            dir=$(dirname "$exe")
            [[ -f "$dir/grin-server.toml" ]] && echo "$dir/grin-server.toml" && return 0
        fi
    fi

    local f
    for dir in "${_KNOWN_TOML_SEARCH_PATHS[@]}"; do
        f="$dir/grin-server.toml"
        [[ -f "$f" ]] || continue
        grep -qiE "chain_type\s*=\s*[\"']?$expected_chain_type" "$f" 2>/dev/null \
            && echo "$f" && return 0
    done

    return 1
}

find_grin_server_toml() {
    local network="$1" api_port="$2"
    local expected_chain_type="Mainnet"
    [[ "$network" == "testnet" ]] && expected_chain_type="Testnet"

    FOUND_GRIN_TOML=""

    local pid exe grin_dir
    pid=$(ss -tlnp 2>/dev/null | grep ":$api_port " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
    if [[ -n "$pid" ]]; then
        exe=$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)
        if [[ -n "$exe" ]]; then
            grin_dir=$(dirname "$exe")
            if [[ -f "$grin_dir/grin-server.toml" ]]; then
                FOUND_GRIN_TOML="$grin_dir/grin-server.toml"
                info "Config detected (via running process): $FOUND_GRIN_TOML"
                return 0
            fi
        fi
    fi

    local candidates=() dir f
    for dir in "${_KNOWN_TOML_SEARCH_PATHS[@]}"; do
        f="$dir/grin-server.toml"
        [[ -f "$f" ]] || continue
        grep -qiE "chain_type\s*=\s*[\"']?$expected_chain_type" "$f" 2>/dev/null \
            && candidates+=("$f")
    done

    if [[ ${#candidates[@]} -eq 1 ]]; then
        FOUND_GRIN_TOML="${candidates[0]}"
        info "Config detected: $FOUND_GRIN_TOML"
        return 0
    elif [[ ${#candidates[@]} -gt 1 ]]; then
        echo -e "\n${BOLD}Multiple grin-server.toml files found for $network:${RESET}"
        local i=1
        for f in "${candidates[@]}"; do
            echo -e "  ${GREEN}$i${RESET}) $f"
            (( i++ ))
        done
        echo -e "  ${DIM}0) Cancel${RESET}"
        echo -ne "Select [0-${#candidates[@]}]: "
        read -r sel
        [[ "$sel" == "0" ]] && return 1
        local idx=$(( sel - 1 ))
        if [[ "$idx" -ge 0 && "$idx" -lt "${#candidates[@]}" ]]; then
            FOUND_GRIN_TOML="${candidates[$idx]}"
            return 0
        fi
        warn "Invalid selection."
        return 1
    fi

    warn "Could not auto-detect grin-server.toml for $network."
    echo -ne "Enter full path to grin-server.toml (or 0 to cancel): "
    read -r manual_path
    [[ "$manual_path" == "0" ]] && return 1
    if [[ -f "$manual_path" ]]; then
        FOUND_GRIN_TOML="$manual_path"
        return 0
    fi
    error "File not found: $manual_path"
    return 1
}

# ═══════════════════════════════════════════════════════════════════════════════
# PROCESS HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

# _grin_session_name() is provided by lib/grin_node_control.sh (sourced above) —
# the canonical copy. The previous local duplicate was removed (DRY).

_is_descendant_of() {
    local child_pid="$1" parent_pid="$2"
    local check="$child_pid"
    for _ in 1 2 3 4 5 6; do
        local ppid
        ppid=$(awk '/^PPid:/ {print $2}' "/proc/$check/status" 2>/dev/null || echo 0)
        [[ "$ppid" == "0" || "$ppid" == "1" ]] && return 1
        [[ "$ppid" == "$parent_pid" ]] && return 0
        check="$ppid"
    done
    return 1
}

_find_grin_session_for_pid() {
    local target_pid="$1"
    while IFS= read -r sess; do
        while IFS= read -r pane_pid; do
            if _is_descendant_of "$target_pid" "$pane_pid" 2>/dev/null; then
                echo "$sess"
                return 0
            fi
        done < <(tmux list-panes -t "$sess" -F '#{pane_pid}' 2>/dev/null || true)
    done < <(tmux ls -F '#{session_name}' 2>/dev/null | grep '^grin_' || true)
    return 1
}

graceful_restart_grin() {
    local api_port="$1" network="$2"

    info "Checking for running grin $network node on port $api_port..."
    local grin_pid
    grin_pid=$(ss -tlnp 2>/dev/null \
        | grep ":$api_port " \
        | grep -oP 'pid=\K[0-9]+' | head -1 || true)

    if [[ -z "$grin_pid" ]]; then
        info "Grin ($network) not running on port $api_port. Change will take effect on next node start."
        return 0
    fi

    local grin_binary grin_dir
    grin_binary=$(readlink -f "/proc/$grin_pid/exe" 2>/dev/null || true)
    if [[ -z "$grin_binary" || ! -f "$grin_binary" ]]; then
        warn "Could not read binary path from /proc/$grin_pid/exe."
        info "grin-server.toml has been patched. Restart the node manually."
        return 0
    fi
    grin_dir=$(dirname "$grin_binary")

    local target_session=""
    target_session=$(_find_grin_session_for_pid "$grin_pid" 2>/dev/null || true)

    echo ""
    warn "Grin node restart required for the stratum config change to take effect."
    echo -ne "Restart grin $network node now? [Y/n/0]: "
    read -r do_restart
    if [[ "$do_restart" == "0" || "${do_restart,,}" == "n" ]]; then
        info "Restart manually when ready. grin-server.toml has already been patched."
        return 0
    fi

    info "Sending SIGTERM to grin process (PID $grin_pid)..."
    kill -TERM "$grin_pid" 2>/dev/null || true

    local timeout=30
    while kill -0 "$grin_pid" 2>/dev/null && (( timeout-- > 0 )); do
        sleep 1
        echo -n "."
    done
    echo ""

    if kill -0 "$grin_pid" 2>/dev/null; then
        warn "Grin process did not stop within 30s. Forcing stop..."
        kill -KILL "$grin_pid" 2>/dev/null || true
        sleep 2
    fi

    success "Grin ($network) node stopped."

    local session_name="${target_session:-$(_grin_session_name "$grin_dir")}"
    tmux kill-session -t "$session_name" 2>/dev/null || true
    sleep 1

    info "Starting grin in tmux session: $session_name"
    SHELL=/bin/bash tmux new-session -d -s "$session_name" -c "$grin_dir" \
        "echo 'Starting Grin node...'; cd '$grin_dir' && '$grin_binary' server run; echo ''; echo 'Grin process exited. Press Enter to close.'; read" \
        || { warn "Failed to create tmux session. Start manually: cd $grin_dir && $grin_binary server run"; return 1; }

    sleep 3
    if ss -tlnp 2>/dev/null | grep -q ":$api_port "; then
        success "Grin ($network) node is back up on port $api_port."
    else
        warn "Grin may still be initializing. Check: tmux attach -t $session_name"
    fi
    info "View: tmux attach -t $session_name"
}

# ═══════════════════════════════════════════════════════════════════════════════
# STATUS HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

_sed_escape_rhs() { printf '%s' "$1" | sed 's/[\\&|]/\\&/g'; }

_stratum_bind_line() {
    local toml="$1" port="$2"
    if [[ ! -f "$toml" ]]; then
        echo -e "${DIM}toml not found${RESET}"
        return
    fi
    local addr
    addr=$(grep -E '^[[:space:]]*stratum_server_addr[[:space:]]*=' "$toml" 2>/dev/null \
           | sed 's/.*=[[:space:]]*//' | tr -d '"' | xargs 2>/dev/null || true)
    if [[ "$addr" == "0.0.0.0:$port" ]]; then
        echo -e "${GREEN}PUBLIC${RESET}  ${DIM}(0.0.0.0:$port)${RESET}"
    elif [[ "$addr" == "127.0.0.1:$port" ]]; then
        echo -e "${YELLOW}LOCAL${RESET}   ${DIM}(127.0.0.1:$port)${RESET}"
    else
        echo -e "${DIM}${addr:-not set}${RESET}"
    fi
}

show_compact_status() {
    local mn_toml tn_toml mn_bind tn_bind
    mn_toml=$(_resolve_stratum_toml mainnet "$NODE_API_PORT_MAINNET" 2>/dev/null || true)
    tn_toml=$(_resolve_stratum_toml testnet "$NODE_API_PORT_TESTNET" 2>/dev/null || true)
    mn_bind=$(_stratum_bind_line "${mn_toml:-}" "$STRATUM_PORT_MAINNET" 2>/dev/null || echo -e "${DIM}unknown${RESET}")
    tn_bind=$(_stratum_bind_line "${tn_toml:-}" "$STRATUM_PORT_TESTNET" 2>/dev/null || echo -e "${DIM}unknown${RESET}")

    echo -e "${BOLD}  Stratum Status:${RESET}"
    if ss -tlnp 2>/dev/null | grep -q ":$STRATUM_PORT_MAINNET "; then
        echo -ne "    Mainnet ($STRATUM_PORT_MAINNET): ${GREEN}LISTENING${RESET}  bind: "
    else
        echo -ne "    Mainnet ($STRATUM_PORT_MAINNET): ${RED}OFF${RESET}         bind: "
    fi
    echo -e "$mn_bind"
    if ss -tlnp 2>/dev/null | grep -q ":$STRATUM_PORT_TESTNET "; then
        echo -ne "    Testnet ($STRATUM_PORT_TESTNET): ${GREEN}LISTENING${RESET}  bind: "
    else
        echo -ne "    Testnet ($STRATUM_PORT_TESTNET): ${RED}OFF${RESET}         bind: "
    fi
    echo -e "$tn_bind"
    echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
# A) NODE & MINING STATUS
# ═══════════════════════════════════════════════════════════════════════════════

_show_node_info() {
    local network="$1" api_port="$2" stratum_port="$3"
    local label="Mainnet"
    [[ "$network" == "testnet" ]] && label="Testnet"

    echo -e "  ${BOLD}$label:${RESET}"

    local pid
    pid=$(ss -tlnp 2>/dev/null | grep ":$api_port " | grep -oP 'pid=\K[0-9]+' | head -1 || true)

    if [[ -n "$pid" ]]; then
        echo -e "    Node   : ${GREEN}RUNNING${RESET}  ${DIM}(PID $pid, port $api_port)${RESET}"
        local exe grin_dir
        exe=$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)
        if [[ -n "$exe" ]]; then
            grin_dir=$(dirname "$exe")
            echo -e "    Binary : $exe"
            echo -e "    Dir    : $grin_dir"
        fi
        local tmux_sess
        tmux_sess=$(_find_grin_session_for_pid "$pid" 2>/dev/null || true)
        if [[ -n "$tmux_sess" ]]; then
            echo -e "    tmux   : ${GREEN}$tmux_sess${RESET}  ${DIM}(attach: tmux attach -t $tmux_sess)${RESET}"
        else
            echo -e "    tmux   : ${DIM}no grin_ session found${RESET}"
        fi
    else
        echo -e "    Node   : ${RED}NOT RUNNING${RESET}  ${DIM}(port $api_port not listening)${RESET}"
    fi

    if ss -tlnp 2>/dev/null | grep -q ":$stratum_port "; then
        echo -e "    Stratum: ${GREEN}LISTENING${RESET}  ${DIM}(port $stratum_port)${RESET}"
        local miner_count
        miner_count=$(ss -tnp 2>/dev/null | grep ":$stratum_port" | grep -c ESTAB || true)
        echo -e "    Miners : ${miner_count:-0} connected"
    else
        echo -e "    Stratum: ${DIM}not listening${RESET}  ${DIM}(port $stratum_port)${RESET}"
    fi

    local toml
    toml=$(_resolve_stratum_toml "$network" "$api_port" 2>/dev/null || true)
    if [[ -n "$toml" && -f "$toml" ]]; then
        local e addr wallet burn
        e=$(grep -E '^[[:space:]]*enable_stratum_server[[:space:]]*=' "$toml" 2>/dev/null \
            | head -1 | sed 's/.*=[[:space:]]*//' | xargs || true)
        addr=$(grep -E '^[[:space:]]*stratum_server_addr[[:space:]]*=' "$toml" 2>/dev/null \
               | head -1 | sed 's/.*=[[:space:]]*//' | tr -d '"' | xargs || true)
        wallet=$(grep -E '^[[:space:]]*wallet_listener_url[[:space:]]*=' "$toml" 2>/dev/null \
                 | head -1 | sed 's/.*=[[:space:]]*//' | tr -d '"' | xargs || true)
        burn=$(grep -E '^[[:space:]]*burn_reward[[:space:]]*=' "$toml" 2>/dev/null \
               | head -1 | sed 's/.*=[[:space:]]*//' | xargs || true)
        echo -e "    toml   : $toml"
        echo -e "    enabled: ${e:-${DIM}not set${RESET}}"
        echo -e "    bind   : ${addr:-${DIM}not set${RESET}}"
        echo -e "    wallet : ${wallet:-${DIM}not set${RESET}}"
        echo -e "    burn   : ${burn:-${DIM}not set${RESET}}"
    fi
    echo ""
}

show_node_status() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  A) Node & Mining Status${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    _show_node_info mainnet "$NODE_API_PORT_MAINNET" "$STRATUM_PORT_MAINNET"
    _show_node_info testnet "$NODE_API_PORT_TESTNET" "$STRATUM_PORT_TESTNET"
}

# ═══════════════════════════════════════════════════════════════════════════════
# B / F) SETUP STRATUM
# ═══════════════════════════════════════════════════════════════════════════════

_do_setup_stratum() {
    local network="$1" stratum_port="$2" api_port="$3"
    local label="Mainnet"
    [[ "$network" == "testnet" ]] && label="Testnet"
    local publish_key="D"; [[ "$network" == "testnet" ]] && publish_key="I"

    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Setup Stratum Server — $label (port $stratum_port)${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Enables the stratum server in grin-server.toml and sets the"
    echo -e "  wallet listener URL for coinbase block rewards."
    echo -e "  Use ${BOLD}$publish_key${RESET} to publish (open to miners) after setup."
    echo ""

    find_grin_server_toml "$network" "$api_port" || return
    local grin_toml="$FOUND_GRIN_TOML"
    echo ""

    echo -e "${BOLD}Current stratum settings in:${RESET} $grin_toml"
    local cur_enable cur_wallet cur_burn
    cur_enable=$(grep -E '^[[:space:]]*enable_stratum_server[[:space:]]*=' "$grin_toml" 2>/dev/null | head -1 || true)
    cur_wallet=$(grep -E '^[[:space:]]*wallet_listener_url[[:space:]]*=' "$grin_toml" 2>/dev/null | head -1 || true)
    cur_burn=$(grep -E '^[[:space:]]*burn_reward[[:space:]]*=' "$grin_toml" 2>/dev/null | head -1 || true)
    echo -e "  enable_stratum_server : ${cur_enable:-${DIM}(not set)${RESET}}"
    echo -e "  wallet_listener_url   : ${cur_wallet:-${DIM}(not set)${RESET}}"
    echo -e "  burn_reward           : ${cur_burn:-${DIM}(not set)${RESET}}"
    echo ""

    echo -ne "Enable stratum server (enable_stratum_server = true)? [Y/n/0]: "
    read -r en_choice
    [[ "$en_choice" == "0" ]] && return
    if [[ "${en_choice,,}" != "n" ]]; then
        if grep -qE '^#?[[:space:]]*enable_stratum_server[[:space:]]*=' "$grin_toml" 2>/dev/null; then
            sed -i -E \
                "s|^#?[[:space:]]*enable_stratum_server[[:space:]]*=.*|enable_stratum_server = true|" \
                "$grin_toml"
        else
            echo "enable_stratum_server = true" >> "$grin_toml"
        fi
        success "enable_stratum_server = true"
        log "Setup ($network): enable_stratum_server = true in $grin_toml"
    fi

    local default_wallet_url="http://127.0.0.1:3415/v2/foreign"
    [[ "$network" == "testnet" ]] && default_wallet_url="http://127.0.0.1:13415/v2/foreign"
    echo ""
    echo -e "${BOLD}Wallet listener URL${RESET} — where coinbase block rewards are sent."
    echo -e "  Default for local wallet: ${DIM}$default_wallet_url${RESET}"
    echo -ne "Enter wallet_listener_url (Enter for default, 0 to skip): "
    read -r wallet_url
    [[ "$wallet_url" == "0" ]] && wallet_url=""

    if [[ -n "$wallet_url" || -z "$cur_wallet" ]]; then
        local new_url="${wallet_url:-$default_wallet_url}"
        local esc_url; esc_url=$(_sed_escape_rhs "$new_url")
        if grep -qE '^#?[[:space:]]*wallet_listener_url[[:space:]]*=' "$grin_toml" 2>/dev/null; then
            sed -i -E \
                "s|^#?[[:space:]]*wallet_listener_url[[:space:]]*=.*|wallet_listener_url = \"$esc_url\"|" \
                "$grin_toml"
        else
            echo "wallet_listener_url = \"$new_url\"" >> "$grin_toml"
        fi
        success "wallet_listener_url = \"$new_url\""
        log "Setup ($network): wallet_listener_url = $new_url in $grin_toml"
    fi

    echo ""
    echo -e "${BOLD}burn_reward${RESET} — set true to discard coinbase (testing only)."
    echo -ne "Set burn_reward = false (keep rewards)? [Y/n/0]: "
    read -r burn_choice
    [[ "$burn_choice" == "0" ]] && burn_choice="n"
    if [[ "${burn_choice,,}" != "n" ]]; then
        if grep -qE '^#?[[:space:]]*burn_reward[[:space:]]*=' "$grin_toml" 2>/dev/null; then
            sed -i -E \
                "s|^#?[[:space:]]*burn_reward[[:space:]]*=.*|burn_reward = false|" \
                "$grin_toml"
        else
            echo "burn_reward = false" >> "$grin_toml"
        fi
        success "burn_reward = false"
        log "Setup ($network): burn_reward = false in $grin_toml"
    fi

    echo ""
    success "Stratum setup complete for $network."
    echo ""
    info "Stratum is configured but bound to localhost by default."
    echo -e "  Use ${BOLD}$publish_key${RESET} to publish and open to miners."
    echo -e "  Restart the grin node to apply changes."
}

setup_stratum_mainnet() { _do_setup_stratum mainnet "$STRATUM_PORT_MAINNET" "$NODE_API_PORT_MAINNET"; }
setup_stratum_testnet() { _do_setup_stratum testnet "$STRATUM_PORT_TESTNET" "$NODE_API_PORT_TESTNET"; }

# ═══════════════════════════════════════════════════════════════════════════════
# C / G) CONFIGURE STRATUM
# ═══════════════════════════════════════════════════════════════════════════════

_do_configure_stratum() {
    local network="$1" stratum_port="$2" api_port="$3"
    local label="Mainnet"; [[ "$network" == "testnet" ]] && label="Testnet"

    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Configure Stratum — $label (port $stratum_port)${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    find_grin_server_toml "$network" "$api_port" || return
    local grin_toml="$FOUND_GRIN_TOML"
    echo ""

    echo -e "${BOLD}Current settings in:${RESET} $grin_toml"
    echo ""
    local cur_enable cur_addr cur_wallet cur_burn
    cur_enable=$(grep -E '^[[:space:]]*enable_stratum_server[[:space:]]*=' "$grin_toml" 2>/dev/null | head -1 | sed 's/.*=[[:space:]]*//' | xargs || true)
    cur_addr=$(grep -E '^[[:space:]]*stratum_server_addr[[:space:]]*=' "$grin_toml" 2>/dev/null | head -1 | sed 's/.*=[[:space:]]*//' | tr -d '"' | xargs || true)
    cur_wallet=$(grep -E '^[[:space:]]*wallet_listener_url[[:space:]]*=' "$grin_toml" 2>/dev/null | head -1 | sed 's/.*=[[:space:]]*//' | tr -d '"' | xargs || true)
    cur_burn=$(grep -E '^[[:space:]]*burn_reward[[:space:]]*=' "$grin_toml" 2>/dev/null | head -1 | sed 's/.*=[[:space:]]*//' | xargs || true)
    echo -e "  ${GREEN}1${RESET}) enable_stratum_server : ${cur_enable:-${DIM}not set${RESET}}"
    echo -e "  ${GREEN}2${RESET}) stratum_server_addr   : ${cur_addr:-${DIM}not set${RESET}}"
    echo -e "  ${GREEN}3${RESET}) wallet_listener_url   : ${cur_wallet:-${DIM}not set${RESET}}"
    echo -e "  ${GREEN}4${RESET}) burn_reward           : ${cur_burn:-${DIM}not set${RESET}}"
    echo -e "  ${DIM}0) Cancel${RESET}"
    echo ""
    echo -ne "Which setting to change [1-4/0]: "
    read -r cfg_choice
    [[ "$cfg_choice" == "0" || -z "$cfg_choice" ]] && return

    local changed=false
    case "$cfg_choice" in
        1)
            echo -ne "Set enable_stratum_server [true/false] (current: ${cur_enable:-not set}): "
            read -r new_val
            [[ -z "$new_val" ]] && return
            local esc_val; esc_val=$(_sed_escape_rhs "$new_val")
            if grep -qE '^#?[[:space:]]*enable_stratum_server[[:space:]]*=' "$grin_toml" 2>/dev/null; then
                sed -i -E "s|^#?[[:space:]]*enable_stratum_server[[:space:]]*=.*|enable_stratum_server = $esc_val|" "$grin_toml"
            else
                echo "enable_stratum_server = $new_val" >> "$grin_toml"
            fi
            success "enable_stratum_server = $new_val"
            log "Configure ($network): enable_stratum_server = $new_val"
            changed=true
            ;;
        2)
            echo -e "  Options: ${DIM}0.0.0.0:$stratum_port${RESET}  (public)  or  ${DIM}127.0.0.1:$stratum_port${RESET}  (localhost only)"
            echo -ne "New stratum_server_addr (current: ${cur_addr:-not set}): "
            read -r new_addr
            [[ -z "$new_addr" ]] && return
            local esc_addr; esc_addr=$(_sed_escape_rhs "$new_addr")
            if grep -qE '^#?[[:space:]]*stratum_server_addr[[:space:]]*=' "$grin_toml" 2>/dev/null; then
                sed -i -E "s|^#?[[:space:]]*stratum_server_addr[[:space:]]*=.*|stratum_server_addr = \"$esc_addr\"|" "$grin_toml"
            else
                echo "stratum_server_addr = \"$new_addr\"" >> "$grin_toml"
            fi
            success "stratum_server_addr = \"$new_addr\""
            log "Configure ($network): stratum_server_addr = $new_addr"
            changed=true
            ;;
        3)
            echo -ne "New wallet_listener_url (current: ${cur_wallet:-not set}): "
            read -r new_wallet
            [[ -z "$new_wallet" ]] && return
            local esc_wallet; esc_wallet=$(_sed_escape_rhs "$new_wallet")
            if grep -qE '^#?[[:space:]]*wallet_listener_url[[:space:]]*=' "$grin_toml" 2>/dev/null; then
                sed -i -E "s|^#?[[:space:]]*wallet_listener_url[[:space:]]*=.*|wallet_listener_url = \"$esc_wallet\"|" "$grin_toml"
            else
                echo "wallet_listener_url = \"$new_wallet\"" >> "$grin_toml"
            fi
            success "wallet_listener_url = \"$new_wallet\""
            log "Configure ($network): wallet_listener_url = $new_wallet"
            changed=true
            ;;
        4)
            echo -ne "Set burn_reward [true/false] (current: ${cur_burn:-not set}): "
            read -r new_burn
            [[ -z "$new_burn" ]] && return
            local esc_burn; esc_burn=$(_sed_escape_rhs "$new_burn")
            if grep -qE '^#?[[:space:]]*burn_reward[[:space:]]*=' "$grin_toml" 2>/dev/null; then
                sed -i -E "s|^#?[[:space:]]*burn_reward[[:space:]]*=.*|burn_reward = $esc_burn|" "$grin_toml"
            else
                echo "burn_reward = $new_burn" >> "$grin_toml"
            fi
            success "burn_reward = $new_burn"
            log "Configure ($network): burn_reward = $new_burn"
            changed=true
            ;;
        *)
            warn "Invalid choice."
            return
            ;;
    esac

    if [[ "$changed" == "true" ]]; then
        echo ""
        graceful_restart_grin "$api_port" "$network"
    fi
}

configure_stratum_mainnet() { _do_configure_stratum mainnet "$STRATUM_PORT_MAINNET" "$NODE_API_PORT_MAINNET"; }
configure_stratum_testnet() { _do_configure_stratum testnet "$STRATUM_PORT_TESTNET" "$NODE_API_PORT_TESTNET"; }

# ═══════════════════════════════════════════════════════════════════════════════
# PORT GUIDE
# ═══════════════════════════════════════════════════════════════════════════════

_show_stratum_port_guide() {
    local port="$1"
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  PORT GUIDE — Read before continuing${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    local label="Mainnet"
    [[ "$port" == "$STRATUM_PORT_TESTNET" ]] && label="Testnet"
    echo -e "  ${BOLD}PORT $port — Grin $label Stratum Mining Server (TCP)${RESET}"
    echo ""
    echo -e "  ${CYAN}What it does${RESET} : Allows miners to connect and submit proof-of-work to your node."
    echo -e "  ${CYAN}Who needs it${RESET} : Solo miners who want to mine directly on their own node."
    echo -e "  ${CYAN}Expose via${RESET}   : Direct bind — patches grin-server.toml so grin listens on"
    echo -e "               0.0.0.0:$port instead of 127.0.0.1:$port."
    echo -e "  ${YELLOW}Requires${RESET}     : Graceful node restart for the change to take effect."
    echo -e "  ${GREEN}Expose if${RESET}    : You want miners to point their hashrate at your node."
    echo -e "  ${YELLOW}Skip if${RESET}      : You are mining locally (same machine as the node)."
    echo -e "  ${DIM}Note${RESET}         : Coinbase rewards go to your local wallet — a localhost-only"
    echo -e "               connection that does NOT need to be public."
    echo ""
    echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -ne "${BOLD}Type ${GREEN}yes${RESET}${BOLD} to confirm you have read the above and want to proceed [yes/N/0]: ${RESET}"
    read -r _guide_confirm || true
    if [[ "${_guide_confirm,,}" != "yes" ]]; then
        info "Cancelled."
        return 1
    fi
    return 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# D / E / I / J) PUBLISH / RESTRICT STRATUM
# ═══════════════════════════════════════════════════════════════════════════════

_enable_stratum() {
    local network="$1" stratum_port="$2" api_port="$3"

    _show_stratum_port_guide "$stratum_port" || return
    echo -e "\n${BOLD}${CYAN}── Publish Stratum ($network, port $stratum_port) ──${RESET}\n"
    echo -e "  Patches grin-server.toml: ${BOLD}0.0.0.0:$stratum_port${RESET}  (miners can connect directly)"
    echo -e "  Requires graceful node restart."
    echo ""

    find_grin_server_toml "$network" "$api_port" || return
    local grin_toml="$FOUND_GRIN_TOML"

    info "Patching $grin_toml ..."
    if grep -qE '^#?[[:space:]]*stratum_server_addr[[:space:]]*=' "$grin_toml" 2>/dev/null; then
        sed -i -E \
            "s|^#?[[:space:]]*stratum_server_addr[[:space:]]*=.*|stratum_server_addr = \"0.0.0.0:${stratum_port}\"|" \
            "$grin_toml"
    else
        echo "stratum_server_addr = \"0.0.0.0:${stratum_port}\"" >> "$grin_toml"
    fi
    success "stratum_server_addr = \"0.0.0.0:$stratum_port\" written to grin-server.toml"
    log "Stratum ($network) published: patched $grin_toml -> 0.0.0.0:$stratum_port"

    echo ""
    echo -e "${BOLD}Open firewall port $stratum_port for miners:${RESET}"
    echo -e "  ${GREEN}1${RESET}) Open to all IPs  ${DIM}(recommended)${RESET}"
    echo -e "  ${YELLOW}2${RESET}) Open to specific IP only"
    echo -e "  ${RED}3${RESET}) Skip firewall changes"
    echo -ne "Choice [1]: "
    read -r fw_choice

    case "${fw_choice:-1}" in
        1)
            if command -v ufw &>/dev/null; then
                ufw allow "$stratum_port/tcp"
                success "UFW: port $stratum_port opened to all."
            elif command -v iptables &>/dev/null; then
                # -C guard so re-running Publish does not stack duplicate ACCEPT rules.
                if ! iptables -C INPUT -p tcp --dport "$stratum_port" -j ACCEPT 2>/dev/null; then
                    iptables -I INPUT -p tcp --dport "$stratum_port" -j ACCEPT
                fi
                if command -v netfilter-persistent &>/dev/null; then
                    netfilter-persistent save 2>/dev/null || true
                elif [[ -d /etc/iptables ]]; then
                    iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
                fi
                success "iptables: port $stratum_port opened to all."
            else
                warn "No firewall tool found. Configure manually."
            fi
            ;;
        2)
            echo -ne "Enter allowed IP (or 0 to skip): "
            read -r allowed_ip
            [[ "$allowed_ip" == "0" ]] && allowed_ip=""
            if [[ -n "$allowed_ip" ]]; then
                if command -v ufw &>/dev/null; then
                    ufw allow from "$allowed_ip" to any port "$stratum_port" proto tcp
                    success "UFW: port $stratum_port opened for $allowed_ip."
                elif command -v iptables &>/dev/null; then
                    if ! iptables -C INPUT -s "$allowed_ip" -p tcp --dport "$stratum_port" -j ACCEPT 2>/dev/null; then
                        iptables -I INPUT -s "$allowed_ip" -p tcp --dport "$stratum_port" -j ACCEPT
                    fi
                    if command -v netfilter-persistent &>/dev/null; then
                        netfilter-persistent save 2>/dev/null || true
                    elif [[ -d /etc/iptables ]]; then
                        iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
                    fi
                    success "iptables: port $stratum_port opened for $allowed_ip."
                fi
            fi
            ;;
        *) info "Firewall not modified." ;;
    esac

    echo ""
    graceful_restart_grin "$api_port" "$network"
    echo ""
    info "Miners connect to: YOUR_SERVER_IP:$stratum_port"
}

_disable_stratum() {
    local network="$1" stratum_port="$2" api_port="$3"

    echo -e "\n${BOLD}${CYAN}── Restrict Stratum ($network, port $stratum_port) to Localhost ──${RESET}\n"

    find_grin_server_toml "$network" "$api_port" || return
    local grin_toml="$FOUND_GRIN_TOML"

    info "Patching $grin_toml ..."
    if grep -qE '^#?[[:space:]]*stratum_server_addr[[:space:]]*=' "$grin_toml" 2>/dev/null; then
        sed -i -E \
            "s|^#?[[:space:]]*stratum_server_addr[[:space:]]*=.*|stratum_server_addr = \"127.0.0.1:${stratum_port}\"|" \
            "$grin_toml"
    else
        echo "stratum_server_addr = \"127.0.0.1:${stratum_port}\"" >> "$grin_toml"
    fi
    success "stratum_server_addr reverted to 127.0.0.1:$stratum_port"
    log "Stratum ($network) restricted: patched $grin_toml -> 127.0.0.1:$stratum_port"

    echo -ne "Close firewall port $stratum_port? [Y/n/0]: "
    read -r close_fw
    if [[ "${close_fw,,}" != "n" && "$close_fw" != "0" ]]; then
        # NOTE: the node now binds 127.0.0.1, so any leftover firewall ALLOW for
        # this port is moot (nothing external is listening). We remove the all-IPs
        # rule(s) best-effort; a per-IP allow added via "specific IP" can't be
        # matched without the original IP and is harmless — remove it manually if
        # you want a clean ruleset (ufw status numbered / iptables -S).
        if command -v ufw &>/dev/null; then
            ufw delete allow "$stratum_port/tcp" 2>/dev/null || true
            success "UFW: removed all-IPs allow for port $stratum_port."
        elif command -v iptables &>/dev/null; then
            # Drain duplicates that older (pre-guard) Publish runs may have stacked.
            while iptables -D INPUT -p tcp --dport "$stratum_port" -j ACCEPT 2>/dev/null; do :; done
            if command -v netfilter-persistent &>/dev/null; then
                netfilter-persistent save 2>/dev/null || true
            elif [[ -d /etc/iptables ]]; then
                iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
            fi
            success "iptables: removed all-IPs allow for port $stratum_port."
        fi
    fi

    echo ""
    graceful_restart_grin "$api_port" "$network"
}

publish_mainnet_stratum()  { _enable_stratum  mainnet "$STRATUM_PORT_MAINNET" "$NODE_API_PORT_MAINNET"; }
restrict_mainnet_stratum() { _disable_stratum mainnet "$STRATUM_PORT_MAINNET" "$NODE_API_PORT_MAINNET"; }
publish_testnet_stratum()  { _enable_stratum  testnet "$STRATUM_PORT_TESTNET" "$NODE_API_PORT_TESTNET"; }
restrict_testnet_stratum() { _disable_stratum testnet "$STRATUM_PORT_TESTNET" "$NODE_API_PORT_TESTNET"; }

# ═══════════════════════════════════════════════════════════════════════════════
# L) LIVE STATS DASHBOARD
# ═══════════════════════════════════════════════════════════════════════════════
# Polls node Owner API every 10s. Shows: height, difficulty, hashrate, peers,
# connected miners. Hashrate formula: diff_delta × 42 / dt / 16384 (Cuckatoo32)

solo_live_stats() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  L) Live Mining Stats${RESET}  ${DIM}(Ctrl+C to exit)${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    local net_choice
    echo -e "  ${GREEN}1${RESET}) Mainnet  ${GREEN}2${RESET}) Testnet"
    echo -ne "Select [1]: "
    read -r net_choice

    local api_port="$NODE_API_PORT_MAINNET"
    local stratum_port="$STRATUM_PORT_MAINNET"
    local secret_path="/opt/grin/node/mainnet-prune/.api_secret"
    local net_label="MAINNET"
    if [[ "${net_choice:-1}" == "2" ]]; then
        api_port="$NODE_API_PORT_TESTNET"
        stratum_port="$STRATUM_PORT_TESTNET"
        secret_path="/opt/grin/node/testnet-prune/.api_secret"
        net_label="TESTNET"
    fi

    local secret=""
    if [[ -f "$secret_path" ]]; then
        secret=$(cat "$secret_path")
    else
        warn "Secret file not found: $secret_path"
        echo -ne "Enter path to .api_secret (or 0 to skip auth): "
        read -r alt_secret_path
        [[ "$alt_secret_path" != "0" && -f "$alt_secret_path" ]] && secret=$(cat "$alt_secret_path")
    fi

    local prev_diff=0 prev_ts=0
    # Persist across iterations: blocks land ~every 60s, so most 10s polls see no
    # difficulty change. Hold the last computed value instead of flickering.
    local hashrate_str="calculating..."

    echo -e "\n${DIM}Connecting to node on port $api_port ...${RESET}\n"

    while true; do
        local resp
        resp=$(curl -sf --max-time 5 \
            -u "grin:${secret}" \
            -H 'Content-Type: application/json' \
            -d '{"jsonrpc":"2.0","method":"get_status","params":[],"id":1}' \
            "http://127.0.0.1:${api_port}/v2/owner" 2>/dev/null || true)

        if [[ -z "$resp" ]]; then
            clear
            echo -e "${RED}[ERROR]${RESET} Cannot reach node on port $api_port"
            echo -e "  Start the node and try again, or check the API secret."
            sleep 10
            continue
        fi

        local height total_diff peers
        height=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result']['Ok']['tip']['height'])" 2>/dev/null || echo "?")
        total_diff=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result']['Ok']['tip']['total_difficulty'])" 2>/dev/null || echo "0")
        peers=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result']['Ok']['connections'])" 2>/dev/null || echo "?")

        local now; now=$(date +%s)

        # Cuckatoo32 hashrate: diff_delta × 42 / dt / 16384.
        # hashrate_str carries over from the previous block; only recomputed when
        # a new block arrives (diff_delta > 0).
        if [[ "$prev_diff" -gt 0 && "$total_diff" -gt 0 && "$now" -gt "$prev_ts" ]]; then
            local diff_delta dt gps
            diff_delta=$(( total_diff - prev_diff ))
            dt=$(( now - prev_ts ))
            if [[ "$diff_delta" -gt 0 && "$dt" -gt 0 ]]; then
                gps=$(python3 -c "
d=$diff_delta; t=$dt
gps = d * 42 / t / 16384
if gps >= 1000000:
    print(f'{gps/1000000:.2f} MG/s')
elif gps >= 1000:
    print(f'{gps/1000:.2f} kG/s')
else:
    print(f'{gps:.2f} G/s')
" 2>/dev/null || echo "?")
                hashrate_str="$gps"
            fi
        fi
        prev_diff="$total_diff"
        prev_ts="$now"

        local miner_count
        miner_count=$(ss -tnp 2>/dev/null | grep ":$stratum_port" | grep -c ESTAB || true)

        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Grin Solo Mining — $net_label${RESET}  ${DIM}($(date -u '+%H:%M:%S UTC'))${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  ${BOLD}Height${RESET}     : $height"
        echo -e "  ${BOLD}Difficulty${RESET} : $total_diff"
        echo -e "  ${BOLD}Hashrate${RESET}   : ${GREEN}$hashrate_str${RESET}"
        echo -e "  ${BOLD}Peers${RESET}      : $peers"
        echo -e "  ${BOLD}Miners${RESET}     : ${miner_count:-0} connected  ${DIM}(port $stratum_port)${RESET}"
        echo ""
        echo -e "  ${DIM}Ctrl+C to exit  ·  refreshes every 10s${RESET}"

        sleep 10
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# S) STATS WEB PAGE
# ═══════════════════════════════════════════════════════════════════════════════
# Deploys ONE static HTML page via nginx that polls BOTH nodes' Owner API every
# 10s and shows mainnet + testnet side by side. nginx injects the Basic Auth
# header per network so the secret never reaches the browser.

# Emit one nginx proxy location for a network's /api/status/<net> endpoint.
#   $1 = net key (main|test)   $2 = node API port   $3 = base64 of "grin:<secret>"
# Exact-match location: a request to a network we did NOT deploy falls through to
# `location /` and 404s, which the page reads as "not deployed" and greys out.
_solo_stats_proxy_location() {
    cat << EOF
    # Proxy → $1 node Owner API (auth injected here, never exposed to the browser)
    location = /api/status/$1 {
        limit_req zone=grin_api burst=5 nodelay;
        proxy_pass         http://127.0.0.1:$2/v2/owner;
        proxy_method       POST;
        proxy_set_header   Content-Type "application/json";
        proxy_set_header   Authorization "Basic $3";
        proxy_set_body     '{"jsonrpc":"2.0","method":"get_status","params":[],"id":1}';
        proxy_read_timeout 10s;
    }
EOF
}

# Resolve the node's log file path so the block collector knows what to parse.
# Reads log_file_path from grin-server.toml (resolving a relative path against the
# node dir); falls back to <node_dir>/grin-server.log.
#   $1 = network (mainnet|testnet)  →  echoes an absolute log file path
_solo_node_log_path() {
    local net="$1" node_dir toml log=""
    node_dir="/opt/grin/node/${net}-prune"
    toml="$node_dir/grin-server.toml"
    if [[ -f "$toml" ]]; then
        log=$(grep -E '^[[:space:]]*log_file_path[[:space:]]*=' "$toml" 2>/dev/null \
              | head -1 | sed 's/.*=[[:space:]]*//' | tr -d '"' | xargs || true)
    fi
    log="${log:-grin-server.log}"
    [[ "$log" != /* ]] && log="$node_dir/$log"   # resolve relative paths
    echo "$log"
}

# Echo the stratum port a network's node binds (from stratum_server_addr in
# grin-server.toml), falling back to the toolkit default. Used by the setup page.
#   $1 = network (mainnet|testnet)  →  echoes a port number
_solo_stratum_port() {
    local net="$1" toml="/opt/grin/node/${1}-prune/grin-server.toml" def addr port=""
    def=$STRATUM_PORT_MAINNET; [[ "$net" == "testnet" ]] && def=$STRATUM_PORT_TESTNET
    if [[ -f "$toml" ]]; then
        addr=$(grep -E '^[[:space:]]*stratum_server_addr[[:space:]]*=' "$toml" 2>/dev/null \
               | head -1 | sed 's/.*=[[:space:]]*//' | tr -d '"' | xargs || true)
        port="${addr##*:}"
    fi
    [[ "$port" =~ ^[0-9]+$ ]] && echo "$port" || echo "$def"
}

# Echo the node's file_log_level (uppercased) so the deploy can warn when shares
# (logged at INFO) won't be captured. Empty if not found.
#   $1 = network (mainnet|testnet)
_solo_node_file_log_level() {
    local net="$1" toml="/opt/grin/node/${1}-prune/grin-server.toml" lvl=""
    if [[ -f "$toml" ]]; then
        lvl=$(grep -E '^[[:space:]]*file_log_level[[:space:]]*=' "$toml" 2>/dev/null \
              | head -1 | sed 's/.*=[[:space:]]*//' | tr -d '"' | xargs || true)
    fi
    echo "${lvl^^}"
}

# Resolve the wallet Foreign API URL the node is configured to mine to, so the
# stats page can show whether that listener is up. Reads wallet_listener_url from
# the network's grin-server.toml; falls back to the toolkit default foreign port.
#   $1 = network (mainnet|testnet)  →  echoes a full http URL ending in /v2/foreign
_solo_wallet_listener_url() {
    local net="$1" default_port=3415 toml url=""
    [[ "$net" == "testnet" ]] && default_port=13415
    toml="/opt/grin/node/${net}-prune/grin-server.toml"
    if [[ -f "$toml" ]]; then
        url=$(grep -E '^[[:space:]]*wallet_listener_url[[:space:]]*=' "$toml" 2>/dev/null \
              | head -1 | sed 's/.*=[[:space:]]*//' | tr -d '"' | xargs || true)
    fi
    echo "${url:-http://127.0.0.1:${default_port}/v2/foreign}"
}

# Emit one nginx proxy location for a network's /api/wallet/<net> liveness probe.
#   $1 = net key (main|test)   $2 = wallet Foreign API URL
# No secret is injected: a 200 or 401 both prove the listener is up; only a
# connection error / 5xx (which nginx maps to 502) means it is down.
_solo_stats_wallet_location() {
    cat << EOF
    # Liveness probe → $1 wallet Foreign API (the listener the node builds coinbase from)
    location = /api/wallet/$1 {
        limit_req zone=grin_api burst=5 nodelay;
        proxy_pass            $2;
        proxy_method          POST;
        proxy_set_header      Content-Type "application/json";
        proxy_set_body        '{"jsonrpc":"2.0","method":"check_version","params":[],"id":1}';
        proxy_connect_timeout 3s;
        proxy_read_timeout    5s;
        proxy_intercept_errors off;
    }
EOF
}

# Prompt for (or edit) the mainnet reward-split nickname prefixes and write
# $PAYMENT_CONFIG. Prefixes ONLY — never Grin addresses. Validates that no prefix
# is a prefix of another so the collector's longest-match grouping is unambiguous.
# Called from the S) deploy (mainnet detected); no separate menu option.
_solo_prompt_payment_prefixes() {
    local cur=""
    if [[ -f "$PAYMENT_CONFIG" ]]; then
        cur=$(python3 -c 'import json,sys
try: print(" ".join(json.load(open(sys.argv[1])).get("prefixes",[])))
except Exception: pass' "$PAYMENT_CONFIG" 2>/dev/null || true)
    fi

    echo ""
    echo -e "${BOLD}Reward-split payment calculation (mainnet)${RESET}"
    echo -e "  ${DIM}Splits matured coinbase across nicknames by work done, shown on the page.${RESET}"
    echo -e "  ${DIM}Stores nickname PREFIXES only — never Grin addresses. Miners log in to${RESET}"
    echo -e "  ${DIM}stratum as user <prefix><n> (e.g. alpha1, alpha2, bravo1).${RESET}"

    if [[ -n "$cur" ]]; then
        echo -e "  Current prefixes: ${BOLD}${cur}${RESET}"
        echo -ne "  [K]eep / [C]hange / [R]emove? [K]: "
        read -r pchoice
        case "${pchoice,,}" in
            r) rm -f "$PAYMENT_CONFIG"; success "Reward split disabled (config removed)."; return ;;
            c) ;;
            *) info "Keeping existing prefixes."; return ;;
        esac
    else
        echo -ne "  Enable reward-split calculation? [y/N]: "
        read -r pen
        [[ "${pen,,}" != "y" ]] && { info "Reward split not enabled."; return; }
    fi

    local raw json
    while true; do
        echo -ne "  Nickname prefixes (space-separated, e.g. alpha bravo): "
        read -r raw
        [[ -z "$raw" ]] && { warn "No prefixes entered — not enabling."; return; }
        # Validate + normalise in python: token charset, dedupe, no prefix-of-another.
        json=$(python3 -c '
import json, re, sys
toks = [t for t in re.split(r"[\s,]+", sys.argv[1].strip()) if t]
if not toks: sys.exit(1)
seen = []
for t in toks:
    if not re.match(r"^[A-Za-z0-9_-]+$", t): sys.exit(1)
    if t not in seen: seen.append(t)
for a in seen:
    for b in seen:
        if a != b and b.startswith(a): sys.exit(1)
print(json.dumps({"prefixes": seen}))
' "$raw" 2>/dev/null) && break
        warn "Invalid: use letters/digits/_/- only, and no prefix may start another (e.g. al/alpha)."
    done

    mkdir -p "$(dirname "$PAYMENT_CONFIG")"
    printf '%s\n' "$json" > "$PAYMENT_CONFIG"
    chmod 644 "$PAYMENT_CONFIG"
    success "Reward split enabled → $PAYMENT_CONFIG"
    echo -e "  ${DIM}The page shows nickname → % → GRIN owed (weekly/monthly are the settlement cadence).${RESET}"
}

# Prompt for the optional stats-page access lock (HTTP Basic Auth). Writes an
# apr1 htpasswd (no apache2-utils needed — nginx reads apr1 natively) and echoes,
# via the named globals below, the nginx snippets the vhost writer injects:
#   _ACCESS_AUTH_BLOCK       server-level auth_basic + auth_basic_user_file (or "")
#   _ACCESS_PUBLIC_CARVEOUTS poolstats_*.json `auth_basic off` carve-outs (or "")
# Basic Auth is safe here because S) always runs certbot + HTTP→HTTPS redirect, so
# credentials never travel over plain HTTP (the :80 block 301s before the prompt).
_ACCESS_AUTH_BLOCK=""
_ACCESS_PUBLIC_CARVEOUTS=""
_solo_prompt_access_lock() {
    _ACCESS_AUTH_BLOCK=""
    _ACCESS_PUBLIC_CARVEOUTS=""

    echo ""
    echo -e "${BOLD}Stats page access lock (optional)${RESET}"
    echo -e "  ${DIM}Username/password gate (HTTP Basic Auth) — also keeps crawlers out (401).${RESET}"

    local action="new"
    if [[ -f "$STATS_HTPASSWD" ]]; then
        echo -e "  Status: ${GREEN}currently protected${RESET}"
        echo -ne "  [K]eep / [C]hange / [R]emove? [K]: "
        read -r achoice
        case "${achoice,,}" in
            r) rm -f "$STATS_HTPASSWD"; success "Access lock removed (page is public again)."; return ;;
            c) action="change" ;;
            *) info "Keeping existing credentials."; action="keep" ;;
        esac
    else
        echo -ne "  Protect the stats page with a username/password? [y/N]: "
        read -r alk
        [[ "${alk,,}" != "y" ]] && { info "Access lock not enabled (page stays public)."; return; }
    fi

    if [[ "$action" != "keep" ]]; then
        local auser apass apass2
        echo -ne "  Username: "
        read -r auser
        [[ -z "$auser" ]] && { warn "No username — access lock not enabled."; return; }
        echo -ne "  Password: ";        read -rs apass;  echo
        echo -ne "  Confirm password: "; read -rs apass2; echo
        if [[ -z "$apass" || "$apass" != "$apass2" ]]; then
            warn "Passwords empty or did not match — access lock not enabled."
            return
        fi
        local ahash
        ahash=$(openssl passwd -apr1 "$apass") || { error "openssl passwd failed."; return; }
        ( umask 077; printf '%s:%s\n' "$auser" "$ahash" > "$STATS_HTPASSWD" )
        # nginx worker must read it; keep it non-world-readable.
        local nuser
        nuser=$(ps -eo user=,comm= 2>/dev/null | awk '$2 ~ /nginx/ && $1 != "root" {print $1; exit}')
        [[ -z "$nuser" ]] && { id www-data >/dev/null 2>&1 && nuser=www-data || nuser=nginx; }
        chmod 640 "$STATS_HTPASSWD"
        chown "root:$nuser" "$STATS_HTPASSWD" 2>/dev/null || true
        success "Credentials written → $STATS_HTPASSWD"
    fi

    # Server-level auth (every location inherits unless it opts out below).
    _ACCESS_AUTH_BLOCK=$'\n    auth_basic           "Grin Solo Mining";\n    auth_basic_user_file '"$STATS_HTPASSWD"$';'

    # miningpoolstats.com polls poolstats_<net>.json — keep it public so the
    # listing keeps working, unless the operator opts to hide it too.
    echo -ne "  Also hide the public miningpoolstats feed (poolstats_*.json)? [y/N]: "
    read -r hidemps
    if [[ "${hidemps,,}" != "y" ]]; then
        _ACCESS_PUBLIC_CARVEOUTS=$'    location = /data/poolstats_main.json { auth_basic off; }\n    location = /data/poolstats_test.json { auth_basic off; }\n\n'
        info "miningpoolstats feed left public; everything else (incl. split_main.json) is locked."
    else
        warn "Entire page locked — public miningpoolstats listing will stop updating."
    fi
}

solo_deploy_stats_page() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  S) Deploy Mining Stats Page${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Deploys ${BOLD}one unified stats page${RESET} showing mainnet + testnet side by side."
    echo -e "  nginx proxies /api/status/<net> → each node's Owner API with Basic Auth."
    echo -e "  Auto-detects which nodes exist; missing networks grey out on the page."
    echo -e "  No Node.js, no database, no systemd service needed."
    echo ""

    if [[ ! -f "$STATS_WEB_SRC" ]]; then
        error "Stats page not found: $STATS_WEB_SRC"
        return 1
    fi

    # ── Auto-detect available networks ──────────────────────────────────────────
    # ONE unified page/vhost serves both networks. We add a proxy location only for
    # each node whose .api_secret exists; the page greys out any missing network.
    local conf_name="$STATS_BASENAME"
    local web_dir="/var/www/$conf_name"
    local nginx_conf="/etc/nginx/sites-available/$conf_name"
    local mn_secret_path="/opt/grin/node/mainnet-prune/.api_secret"
    local tn_secret_path="/opt/grin/node/testnet-prune/.api_secret"

    local have_main=0 have_test=0
    [[ -f "$mn_secret_path" ]] && have_main=1
    [[ -f "$tn_secret_path" ]] && have_test=1

    if [[ $have_main -eq 0 && $have_test -eq 0 ]]; then
        error "No node .api_secret found for either network."
        echo -e "  Looked for: $mn_secret_path"
        echo -e "              $tn_secret_path"
        echo -e "  ${DIM}Build a node first (Script 01), then re-run S.${RESET}"
        return 1
    fi

    local detected=""
    [[ $have_main -eq 1 ]] && detected+=" Mainnet"
    [[ $have_test -eq 1 ]] && detected+=" Testnet"
    info "Detected node secret(s) for:${detected}  ·  vhost: $conf_name"
    echo ""

    local subdomain
    echo -ne "Subdomain for the stats page (e.g. mining.example.com): "
    read -r subdomain
    [[ -z "$subdomain" ]] && { warn "No subdomain — cancelled."; return 1; }

    if ! nginx_validate_domain "$subdomain"; then
        error "Invalid domain name: $subdomain"
        return 1
    fi

    # DNS pre-check — certbot's HTTP-01 challenge needs this name pointing here.
    if ! getent hosts "$subdomain" >/dev/null 2>&1; then
        warn "$subdomain does not currently resolve in DNS."
        echo -e "  ${DIM}certbot will fail unless an A/AAAA record points $subdomain at this server.${RESET}"
        echo -ne "Continue anyway (deploy HTTP now, retry SSL later)? [y/N/0]: "
        read -r dns_go
        [[ "${dns_go,,}" != "y" ]] && { info "Cancelled — set DNS first, then re-run S."; return 1; }
    fi

    # ── Build per-network proxy blocks for whichever nodes exist ────────────────
    # Each network contributes a node-status proxy (/api/status/<net>) and a wallet
    # liveness proxy (/api/wallet/<net>) so the page can flag a down wallet listener.
    local proxy_blocks=""
    if [[ $have_main -eq 1 ]]; then
        local mn_secret; mn_secret=$(cat "$mn_secret_path")
        local mn_b64;    mn_b64=$(printf 'grin:%s' "$mn_secret" | base64 -w 0)
        local mn_wallet; mn_wallet=$(_solo_wallet_listener_url "mainnet")
        proxy_blocks+=$(_solo_stats_proxy_location "main" "$NODE_API_PORT_MAINNET" "$mn_b64")
        proxy_blocks+=$'\n\n'
        proxy_blocks+=$(_solo_stats_wallet_location "main" "$mn_wallet")
        proxy_blocks+=$'\n\n'
    fi
    if [[ $have_test -eq 1 ]]; then
        local tn_secret; tn_secret=$(cat "$tn_secret_path")
        local tn_b64;    tn_b64=$(printf 'grin:%s' "$tn_secret" | base64 -w 0)
        local tn_wallet; tn_wallet=$(_solo_wallet_listener_url "testnet")
        proxy_blocks+=$(_solo_stats_proxy_location "test" "$NODE_API_PORT_TESTNET" "$tn_b64")
        proxy_blocks+=$'\n\n'
        proxy_blocks+=$(_solo_stats_wallet_location "test" "$tn_wallet")
        proxy_blocks+=$'\n\n'
    fi

    info "Deploying stats page to $web_dir..."
    mkdir -p "$web_dir"
    cp "$STATS_WEB_SRC" "$web_dir/index.html"
    chmod 644 "$web_dir/index.html"
    if [[ -f "$STATS_SETUP_SRC" ]]; then
        cp "$STATS_SETUP_SRC" "$web_dir/setup-solo-mining.html"
        chmod 644 "$web_dir/setup-solo-mining.html"
    else
        warn "Setup page not found ($STATS_SETUP_SRC) — Miner Setup link will 404."
    fi
    if [[ -f "$STATS_LOGO_SRC" ]]; then
        cp "$STATS_LOGO_SRC" "$web_dir/logo.svg"
        chmod 644 "$web_dir/logo.svg"
    else
        warn "Logo not found ($STATS_LOGO_SRC) — page will show a broken icon."
    fi
    success "index.html + setup page deployed."

    # ── Page config: stratum host/ports (setup page) + optional slogan ──────────
    # Always written to data/config.json so the setup page shows real connection
    # details. Editable any time without re-deploying.
    mkdir -p "$web_dir/data"
    echo -ne "Custom header slogan (Enter to keep default): "
    read -r solo_slogan
    local slogan_json=""
    if [[ -n "$solo_slogan" ]]; then
        local esc_slogan="${solo_slogan//\\/\\\\}"; esc_slogan="${esc_slogan//\"/\\\"}"
        slogan_json="\"slogan\":\"$esc_slogan\","
    fi
    local nets_json=""
    if [[ $have_main -eq 1 ]]; then
        nets_json+="\"main\":{\"stratum_port\":$(_solo_stratum_port mainnet)}"
    fi
    if [[ $have_test -eq 1 ]]; then
        [[ -n "$nets_json" ]] && nets_json+=","
        nets_json+="\"test\":{\"stratum_port\":$(_solo_stratum_port testnet)}"
    fi
    printf '{%s"host":"%s","networks":{%s}}\n' "$slogan_json" "$subdomain" "$nets_json" \
        > "$web_dir/data/config.json"
    chmod 644 "$web_dir/data/config.json"
    [[ -n "$solo_slogan" ]] && success "Slogan + connection config written (edit $web_dir/data/config.json to change)." \
        || success "Connection config written (edit $web_dir/data/config.json for slogan/ports)."

    # ── Reward-split prefixes (mainnet only) ────────────────────────────────────
    # Optional. Writes $PAYMENT_CONFIG (nickname prefixes). Done before the initial
    # collector run below so split_main.json appears immediately when enabled.
    if [[ $have_main -eq 1 ]]; then
        _solo_prompt_payment_prefixes
    fi

    # ── Mining stats collector ──────────────────────────────────────────────────
    # Parses each detected node's log for "Solution Found for block <h>" (found
    # blocks) and "Got share … submitted by <worker>" (per-miner hashrate), and
    # writes rolling JSON: blocks_<net>.json, miners_<net>.json, poolstats_<net>.json.
    # Runs every 5 min via cron.d (matches the watchdog pattern).
    local data_dir="$web_dir/data"
    mkdir -p "$data_dir" "$BLOCK_COLLECTOR_STATE_DIR"
    if [[ -f "$BLOCK_COLLECTOR_SRC" ]]; then
        info "Installing mining stats collector..."
        cp "$BLOCK_COLLECTOR_SRC" "$BLOCK_COLLECTOR_BIN"
        chmod 755 "$BLOCK_COLLECTOR_BIN"

        # Wrapper runs the collector once per detected network.
        {
            echo '#!/bin/bash'
            echo '# Generated by 07_grin_mining_solo.sh — solo mining stats collector.'
            echo 'set -uo pipefail'
            if [[ $have_main -eq 1 ]]; then
                printf '%q --net mainnet --log %q --state-dir %q --out-dir %q --payment-config %q || true\n' \
                    "$BLOCK_COLLECTOR_BIN" "$(_solo_node_log_path mainnet)" \
                    "$BLOCK_COLLECTOR_STATE_DIR" "$data_dir" "$PAYMENT_CONFIG"
            fi
            if [[ $have_test -eq 1 ]]; then
                printf '%q --net testnet --log %q --state-dir %q --out-dir %q || true\n' \
                    "$BLOCK_COLLECTOR_BIN" "$(_solo_node_log_path testnet)" \
                    "$BLOCK_COLLECTOR_STATE_DIR" "$data_dir"
            fi
        } > "$BLOCK_COLLECTOR_WRAPPER"
        chmod 755 "$BLOCK_COLLECTOR_WRAPPER"

        cat > "$BLOCK_COLLECTOR_CRON" << CRON
# Grin solo mining stats collector — every 5 min. Managed by 07_grin_mining_solo.sh
*/5 * * * * root $BLOCK_COLLECTOR_WRAPPER >/dev/null 2>&1
CRON
        chmod 644 "$BLOCK_COLLECTOR_CRON"

        # Initial run so the page has data immediately.
        "$BLOCK_COLLECTOR_WRAPPER" || warn "Initial collection errored (cron will retry)."

        # Feedback + log-level check per network. Per-miner hashrate needs INFO-level
        # logging (shares log at INFO); found blocks log at WARN so they always work.
        local net lvl
        for net in mainnet testnet; do
            [[ "$net" == "mainnet" && $have_main -ne 1 ]] && continue
            [[ "$net" == "testnet" && $have_test -ne 1 ]] && continue
            "$BLOCK_COLLECTOR_BIN" --net "$net" --log "$(_solo_node_log_path "$net")" \
                --dry-run 2>/dev/null | tail -1 | sed "s/^/  $net: /" || true
            lvl="$(_solo_node_file_log_level "$net")"
            if [[ -n "$lvl" && "$lvl" != "INFO" && "$lvl" != "DEBUG" && "$lvl" != "TRACE" ]]; then
                warn "  $net file_log_level=$lvl — per-miner hashrate needs INFO. Found blocks still work."
                echo -e "  ${DIM}Set file_log_level = \"INFO\" in $(_solo_node_log_path "$net" | xargs dirname)/grin-server.toml and restart the node.${RESET}"
            fi
        done

        success "Mining stats collector installed (cron every 5 min) → $data_dir"
        echo -e "  ${DIM}miningpoolstats endpoint(s): https://$subdomain/data/poolstats_<net>.json${RESET}"
        echo -e "  ${DIM}If a scan shows 0 block matches after finding a block, the log wording may${RESET}"
        echo -e "  ${DIM}differ on your node version — adjust FOUND_RE/SHARE_RE in $BLOCK_COLLECTOR_BIN.${RESET}"
    else
        warn "Collector not found ($BLOCK_COLLECTOR_SRC) — blocks + miner stats disabled."
    fi

    # ── Optional access lock (HTTP Basic Auth) ──────────────────────────────────
    # Sets $_ACCESS_AUTH_BLOCK + $_ACCESS_PUBLIC_CARVEOUTS, injected into the vhost
    # below. Safe over the certbot HTTPS redirect (creds never cross plain HTTP).
    _solo_prompt_access_lock

    nginx_ensure_grin_api_zone

    # Write an HTTP-only vhost FIRST. Referencing letsencrypt certs that do not
    # exist yet would make `nginx -t` fail. certbot --nginx injects the 443
    # server block + SSL directives afterward (and manages options-ssl-nginx.conf).
    # umask 077 so the conf (which holds the base64 auth token(s)) is never
    # group/world readable, even momentarily, before the explicit chmod below.
    info "Writing nginx vhost (HTTP): $nginx_conf"
    mkdir -p "$(dirname "$nginx_conf")"
    ( umask 077; cat > "$nginx_conf" << EOF
# Grin Solo Mining Stats (unified mainnet + testnet) — generated by 07_grin_mining_solo.sh
# Rate-limit zone lives in /etc/nginx/conf.d/grin-rate-limit.conf
# SSL is added in-place by certbot --nginx (do not hand-add a 443 block here).

server {
    listen 80;
    server_name $subdomain;

    root $web_dir;
    index index.html;

    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
$_ACCESS_AUTH_BLOCK

$proxy_blocks$_ACCESS_PUBLIC_CARVEOUTS    location / {
        try_files \$uri \$uri/ =404;
    }

    access_log /var/log/nginx/${conf_name}-access.log;
    error_log  /var/log/nginx/${conf_name}-error.log;
}
EOF
    )
    chmod 600 "$nginx_conf"

    # nginx_enable_site (shared lib): ensures the sites-enabled include, symlinks,
    # then runs nginx -t + reload. Returns non-zero on failure.
    if ! nginx_enable_site "$nginx_conf" "$conf_name"; then
        error "nginx rejected the config — check $nginx_conf"
        return 1
    fi
    success "nginx serving http://$subdomain"

    echo ""
    echo -ne "Run certbot for SSL on $subdomain (recommended)? [Y/n/0]: "
    read -r do_ssl
    local page_https=0
    if [[ "${do_ssl,,}" != "n" && "$do_ssl" != "0" ]]; then
        # nginx_run_certbot (shared lib) handles the certbot --nginx --redirect call.
        if nginx_run_certbot "$subdomain" "admin@$subdomain" --redirect; then
            # certbot rewrote the conf in place — re-tighten perms (token still inside).
            chmod 600 "$nginx_conf"
            nginx_test_reload "reload after certbot" || true
            page_https=1
            success "Stats page deployed: https://$subdomain"
        else
            warn "certbot failed — page is live over HTTP only."
            echo -e "  Fix DNS so $subdomain points here, then re-run S (or run certbot manually)."
            success "Stats page deployed: http://$subdomain"
        fi
    else
        info "Skipped SSL — page is live over HTTP only at http://$subdomain"
    fi

    # Guardrail: never serve Basic Auth over plain HTTP. If a lock was configured
    # but the page ended up HTTP-only (SSL skipped or certbot failed), strip the
    # auth_basic lines now. The htpasswd file is kept; re-run S once SSL is up.
    if [[ -n "$_ACCESS_AUTH_BLOCK" && $page_https -eq 0 ]]; then
        sed -i '/^[[:space:]]*auth_basic/d' "$nginx_conf"
        nginx_test_reload "reload after disabling HTTP-only auth lock" || true
        warn "Access lock NOT active: refusing to serve Basic Auth over plain HTTP."
        echo -e "  ${DIM}Credentials saved at $STATS_HTPASSWD — re-run S after SSL succeeds to enable the lock.${RESET}"
    fi

    echo -e "  Page polls ${BOLD}/api/status/<net>${RESET} + ${BOLD}/api/wallet/<net>${RESET} every 10s — both networks side by side."
    echo -e "  ${DIM}Wallet Listener row flags whether the coinbase listener is up.${RESET}"
    echo -e "  ${DIM}Only the network(s) detected at deploy time are wired; others grey out.${RESET}"
}

# ═══════════════════════════════════════════════════════════════════════════════
# W) WATCHDOG CRON
# ═══════════════════════════════════════════════════════════════════════════════
# Cron entry: every 5 minutes, verify stratum is enabled in grin-server.toml.
# Logs a warning if stratum config was lost (e.g. node restart reset the toml).

solo_watchdog_setup() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  W) Stratum Watchdog Cron${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    local cron_file="/etc/cron.d/grin-stratum-watchdog"
    local wrapper="/usr/local/bin/grin-stratum-watchdog"
    local toml_paths=""

    for dir in "${_KNOWN_TOML_SEARCH_PATHS[@]}"; do
        [[ -f "$dir/grin-server.toml" ]] && toml_paths+="$dir/grin-server.toml "
    done

    if [[ -f "$cron_file" ]]; then
        echo -e "  Status: ${GREEN}enabled${RESET}  ($cron_file)"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Disable watchdog"
        echo -e "  ${DIM}0) Back${RESET}"
        echo -ne "Choice: "
        read -r wc
        if [[ "$wc" == "1" ]]; then
            rm -f "$cron_file" "$wrapper"
            success "Watchdog disabled."
        fi
        return
    fi

    echo -e "  ${DIM}Checks every 5 minutes that stratum is enabled in grin-server.toml.${RESET}"
    echo -e "  ${DIM}Logs warnings to: $WATCHDOG_LOG${RESET}"
    echo ""
    echo -ne "Enable stratum watchdog cron? [Y/n/0]: "
    read -r wgo
    [[ "${wgo,,}" == "n" || "$wgo" == "0" ]] && return

    mkdir -p "$LOG_DIR"

    cat > "$wrapper" << WATCHDOG
#!/bin/bash
# Grin stratum watchdog — verifies stratum is enabled in grin-server.toml AND
# the configured stratum port is actually listening (catches a node restart that
# reset the toml, or a stratum that failed to bind).
set -euo pipefail

LOG="$WATCHDOG_LOG"
TS=\$(date -u '+%Y-%m-%d %H:%M:%S UTC')
WARNED=false

for TOML_PATH in $toml_paths; do
    [[ -f "\$TOML_PATH" ]] || continue
    ENABLED=\$(grep -E '^[[:space:]]*enable_stratum_server[[:space:]]*=' "\$TOML_PATH" 2>/dev/null \
        | head -1 | sed 's/.*=[[:space:]]*//' | tr -d ' ' || echo "")
    ADDR=\$(grep -E '^[[:space:]]*stratum_server_addr[[:space:]]*=' "\$TOML_PATH" 2>/dev/null \
        | head -1 | sed 's/.*=[[:space:]]*//' | tr -d '" ' || echo "")
    PORT="\${ADDR##*:}"

    if [[ "\$ENABLED" != "true" ]]; then
        echo "[\$TS] WARN: enable_stratum_server not true in \$TOML_PATH (found: '\${ENABLED:-not set}')" >> "\$LOG"
        WARNED=true
        continue
    fi

    # Config says enabled — confirm the port is live. Enabled but no listener
    # means the node is down or stratum failed to bind.
    if [[ -n "\$PORT" ]] && ! ss -tln 2>/dev/null | grep -q ":\$PORT "; then
        echo "[\$TS] WARN: stratum enabled in \$TOML_PATH but port \$PORT is NOT listening" >> "\$LOG"
        WARNED=true
    fi
done

if [[ "\$WARNED" == "false" ]]; then
    echo "[\$TS] OK: stratum enabled and listening for all detected grin-server.toml files" >> "\$LOG"
fi
WATCHDOG
    chmod 750 "$wrapper"

    cat > "$cron_file" << EOF
*/5 * * * * root $wrapper
EOF
    success "Watchdog cron enabled → $cron_file"
    echo -e "  Log: $WATCHDOG_LOG"
}

# ═══════════════════════════════════════════════════════════════════════════════
# MENU
# ═══════════════════════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════════════════════
# SUPERVISION SUBMENUS (Track B — central wallet + watchdogs)
# Each action prompts for the network, mirroring L) Live stats. Underlying logic
# lives in the shared libs (07_solo_wallet.sh, grin_node_keepalive.sh).
# ═══════════════════════════════════════════════════════════════════════════════

# _solo_pick_net <label> → echoes "mainnet"|"testnet" on stdout; rc 1 on cancel.
_solo_pick_net() {
    local label="${1:-this action}" n
    echo -e "  Network for ${BOLD}$label${RESET}:  ${GREEN}1${RESET}) Mainnet   ${GREEN}2${RESET}) Testnet   ${DIM}0) Cancel${RESET}" >&2
    echo -ne "  Select [1/2/0]: " >&2
    read -r n || true   # EOF → empty → cancel (never abort the menu under set -e)
    case "$n" in
        1) echo mainnet ;;
        2) echo testnet ;;
        *) return 1 ;;
    esac
}

_solo_pause() { echo ""; echo "Press Enter to continue..."; read -r || true; }

# K) Central Wallet — init/recover, listener, auto-restart, address.
wallet_menu() {
    local choice net
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Central Wallet — coinbase listener${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "${BOLD}  Listener:${RESET}"
        sw_listener_status mainnet | sed 's/^/    /'
        sw_listener_status testnet | sed 's/^/    /'
        echo ""
        echo -e "  ${GREEN}1${RESET}) Setup / Recover    ${DIM}(download + init|recover + save pass + start)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Start listener"
        echo -e "  ${RED}3${RESET}) Stop listener"
        echo -e "  ${GREEN}4${RESET}) Auto-restart       ${DIM}(@reboot + */5 listener watchdog)${RESET}"
        echo -e "  ${GREEN}5${RESET}) Show address"
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-5/0]: ${RESET}"
        read -r choice || choice=0          # EOF (Ctrl+D) → 0 → Back
        case "$choice" in
            "") continue ;;                 # Enter → refresh
            1) net=$(_solo_pick_net "wallet setup")   && { sw_setup "$net" || true; };         _solo_pause ;;
            2) net=$(_solo_pick_net "start listener") && { sw_listener_start "$net" || true; }; _solo_pause ;;
            3) net=$(_solo_pick_net "stop listener")  && { sw_listener_stop "$net" || true; };  _solo_pause ;;
            4) _wallet_autorestart_menu || true ;;
            5) net=$(_solo_pick_net "show address")    && { sw_show_address "$net" || true; };   _solo_pause ;;
            0) return ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

_wallet_autorestart_menu() {
    local choice net
    clear
    echo -e "${BOLD}${CYAN}  Wallet listener — auto-restart${RESET}\n"
    echo -e "${BOLD}  Boot autostart:${RESET}"; sw_autostart_status | sed 's/^/    /'
    echo -e "${BOLD}  Listener watchdog:${RESET}"; sw_watchdog_status 2>&1 | sed 's/^/    /' | head -1
    echo ""
    echo -e "  ${GREEN}1${RESET}) Enable boot autostart (per net)"
    echo -e "  ${RED}2${RESET}) Disable boot autostart (per net)"
    echo -e "  ${GREEN}3${RESET}) Install listener watchdog (*/5)"
    echo -e "  ${RED}4${RESET}) Remove listener watchdog"
    echo -e "  ${RED}0${RESET}) Back"
    echo ""
    echo -ne "${BOLD}Select [1-4/0]: ${RESET}"
    read -r choice || choice=0
    case "$choice" in
        1) net=$(_solo_pick_net "boot autostart") && { sw_autostart_enable "$net" || true; } ;;
        2) net=$(_solo_pick_net "boot autostart") && { sw_autostart_disable "$net" || true; } ;;
        3) sw_watchdog_install || true ;;
        4) sw_watchdog_remove || true ;;
        0) return ;;
        *) warn "Invalid option." ;;
    esac
    _solo_pause
}

# H) Health / Watchdogs — node-sync, node boot-autostart, wallet listener, stratum.
watchdog_menu() {
    local choice net
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Health / Watchdogs${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "${BOLD}  Node-sync watchdog:${RESET}";    gnk_watchdog_status 2>&1 | sed 's/^/    /' | head -2
        echo -e "${BOLD}  Node boot-autostart:${RESET}";   gnk_autostart_status | sed 's/^/    /'
        echo -e "${BOLD}  Wallet-listener watchdog:${RESET}"; sw_watchdog_status 2>&1 | sed 's/^/    /' | head -1
        echo ""
        echo -e "  ${GREEN}1${RESET}) Node-sync watchdog     ${DIM}install / remove (restarts a wedged node)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Node boot-autostart    ${DIM}enable / disable @reboot (per net)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Wallet-listener wd     ${DIM}install / remove${RESET}"
        echo -e "  ${GREEN}4${RESET}) Stratum watchdog       ${DIM}(existing W — alert if stratum drops)${RESET}"
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-4/0]: ${RESET}"
        read -r choice || choice=0
        case "$choice" in
            "") continue ;;
            1)  echo -ne "  ${GREEN}i${RESET}nstall / ${RED}r${RESET}emove / ${DIM}0 cancel${RESET}: "; read -r a || true
                case "$a" in i) gnk_watchdog_install || true ;; r) gnk_watchdog_remove || true ;; esac; _solo_pause ;;
            2)  net=$(_solo_pick_net "boot autostart") || { _solo_pause; continue; }
                echo -ne "  ${GREEN}e${RESET}nable / ${RED}d${RESET}isable: "; read -r a || true
                case "$a" in e) gnk_autostart_enable "$net" || true ;; d) gnk_autostart_disable "$net" || true ;; esac; _solo_pause ;;
            3)  echo -ne "  ${GREEN}i${RESET}nstall / ${RED}r${RESET}emove / ${DIM}0 cancel${RESET}: "; read -r a || true
                case "$a" in i) sw_watchdog_install || true ;; r) sw_watchdog_remove || true ;; esac; _solo_pause ;;
            4)  solo_watchdog_setup || true; _solo_pause ;;
            0)  return ;;
            *)  warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# 2) Stratum — Setup / Configure / Publish / Restrict, network chosen inside.
# Was B/C/D/E (mainnet) + F/G/I/J (testnet); the per-network letters collapsed
# into one set. Pure dispatch — each branch calls the SAME mainnet/testnet
# wrapper the old letters did, so behaviour is unchanged.
_stratum_dispatch() {
    local action="$1" net="$2"
    case "$action:$net" in
        setup:mainnet)     setup_stratum_mainnet ;;
        setup:testnet)     setup_stratum_testnet ;;
        configure:mainnet) configure_stratum_mainnet ;;
        configure:testnet) configure_stratum_testnet ;;
        publish:mainnet)   publish_mainnet_stratum ;;
        publish:testnet)   publish_testnet_stratum ;;
        restrict:mainnet)  restrict_mainnet_stratum ;;
        restrict:testnet)  restrict_testnet_stratum ;;
    esac
}

stratum_menu() {
    local choice net
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Stratum Server${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        show_compact_status
        echo -e "  ${GREEN}1${RESET}) Setup       ${DIM}(enable stratum in grin-server.toml · wallet URL · burn)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Configure   ${DIM}(enable / bind / wallet / burn — single field)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Publish     ${DIM}(open 0.0.0.0:<port> to miners + firewall)${RESET}"
        echo -e "  ${RED}4${RESET}) Restrict    ${DIM}(revert to 127.0.0.1)${RESET}"
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-4/0]: ${RESET}"
        read -r choice || choice=0          # EOF (Ctrl+D) → 0 → Back
        case "$choice" in
            "") continue ;;                 # Enter → refresh
            1) net=$(_solo_pick_net "setup stratum")     && { _stratum_dispatch setup "$net"     || true; }; _solo_pause ;;
            2) net=$(_solo_pick_net "configure stratum") && { _stratum_dispatch configure "$net" || true; }; _solo_pause ;;
            3) net=$(_solo_pick_net "publish stratum")   && { _stratum_dispatch publish "$net"   || true; }; _solo_pause ;;
            4) net=$(_solo_pick_net "restrict stratum")  && { _stratum_dispatch restrict "$net"  || true; }; _solo_pause ;;
            0) return ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# 3) Stats & Web — live terminal dashboard (was L) + nginx page deploy (was S).
# The deploy itself prompts for payment-split prefixes + the optional access
# lock, so those stay reachable through option 2 (no standalone quick-edit yet).
stats_menu() {
    local choice
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Stats & Web${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Live dashboard    ${DIM}(terminal stats, updates every 10s; Ctrl+C to exit)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Deploy / update   ${DIM}(nginx page; prompts payment prefixes + access lock)${RESET}"
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-2/0]: ${RESET}"
        read -r choice || choice=0          # EOF (Ctrl+D) → 0 → Back
        case "$choice" in
            "") continue ;;                 # Enter → refresh
            1) solo_live_stats || true ;;
            2) solo_deploy_stats_page || true; _solo_pause ;;
            0) return ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

show_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  07) Grin Mining Services — Solo${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    show_compact_status

    echo -e "  ${GREEN}A${RESET}) Node & Mining Status  ${DIM}(node sync, tmux, stratum config + miners)${RESET}"
    echo ""
    echo -e "  ${GREEN}1${RESET}) Wallet               ${DIM}▸ setup/recover · listener · auto-restart · address${RESET}"
    echo -e "  ${GREEN}2${RESET}) Stratum              ${DIM}▸ setup · configure · publish · restrict${RESET}"
    echo -e "  ${GREEN}3${RESET}) Stats & Web          ${DIM}▸ live dashboard · web page${RESET}"
    echo -e "  ${GREEN}4${RESET}) Health / Watchdogs   ${DIM}▸ node-sync · boot autostart · wallet listener · stratum${RESET}"
    echo ""
    echo -e "  ${DIM}↩  Press Enter to refresh${RESET}"
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -ne "${BOLD}Select [A/1-4/0]: ${RESET}"
}

main() {
    while true; do
        show_menu
        read -r choice || choice=0          # EOF (Ctrl+D) → 0 → Back to main menu

        # Every action is guarded with `|| true`: this is an interactive dispatch
        # loop, so a cancelled/failed action (e.g. "TOML not found" → `... || return`)
        # must drop back to the menu, never hard-exit the script under `set -e`.
        case "${choice,,}" in
            "")  continue ;;                # Enter → refresh status
            a)   show_node_status || true
                 echo ""; echo "Press Enter to continue..."; read -r || true ;;
            1)   wallet_menu   || true ;;
            2)   stratum_menu  || true ;;
            3)   stats_menu    || true ;;
            4)   watchdog_menu || true ;;
            0)   break ;;
            *)   warn "Invalid option."; sleep 1 ;;
        esac
        # Submenus (1-4) run their own loops + pauses; only the one-shot A) status
        # view needs a pause, handled inline above.
    done
}

main "$@"
