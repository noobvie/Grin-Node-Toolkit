#!/bin/bash
# =============================================================================
# 07_grin_mining_solo.sh — Grin Solo Mining Setup
# =============================================================================
# Configure and manage solo mining on a Grin node.
# Enables the node's built-in stratum server, sets your wallet reward address,
# and publishes the port so miners can connect directly.
#
# ─── Menu ─────────────────────────────────────────────────────────────────────
#   A) Node & Mining Status   (node sync, tmux, stratum config + miner count)
#
#   ─── MAINNET ──────────────────────────────────────────────────────────────
#   B) Setup Stratum          (enable stratum_server in grin-server.toml)
#   C) Configure Stratum      (wallet address, burn_reward, timeout)
#   D) Publish Stratum        (open :3416 to miners via ufw/iptables)
#   E) Restrict Stratum       (revert to localhost only)
#
#   ─── TESTNET ──────────────────────────────────────────────────────────────
#   F) Setup Stratum
#   G) Configure Stratum
#   I) Publish Stratum
#   J) Restrict Stratum
#
#   ─── TOOLS ────────────────────────────────────────────────────────────────
#   L) Live stats             (terminal dashboard, updates every 10s)
#   S) Stats web page         (deploy static nginx mining stats page)
#   W) Watchdog cron          (alert if stratum drops after node restart)
#
#   0) Back to main menu
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

STATS_WEB_SRC="$TOOLKIT_ROOT/web/07_mining_pool_solo/stats.html"
STATS_WEB_DIR="/var/www/grin-stats"
STATS_NGINX_CONF="/etc/nginx/sites-available/grin-stats"
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

# ─── Source shared nginx helpers ──────────────────────────────────────────────
# shellcheck source=lib/nginx_shared_helpers.sh
source "$SCRIPT_DIR/lib/nginx_shared_helpers.sh"

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

_grin_session_name() {
    case "$(basename "${1:-}")" in
        mainnet-full)  echo "grin_full_mainnet"   ;;
        mainnet-prune) echo "grin_pruned_mainnet" ;;
        testnet-prune) echo "grin_pruned_testnet" ;;
        *)             echo "grin_$(basename "${1:-}")" ;;
    esac
}

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
                iptables -I INPUT -p tcp --dport "$stratum_port" -j ACCEPT
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
                    iptables -I INPUT -s "$allowed_ip" -p tcp --dport "$stratum_port" -j ACCEPT
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
        if command -v ufw &>/dev/null; then
            ufw delete allow "$stratum_port/tcp" 2>/dev/null || true
            ufw delete allow from any to any port "$stratum_port" proto tcp 2>/dev/null || true
            success "UFW: port $stratum_port closed."
        elif command -v iptables &>/dev/null; then
            iptables -D INPUT -p tcp --dport "$stratum_port" -j ACCEPT 2>/dev/null || true
            success "iptables: port $stratum_port closed."
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

        # Cuckatoo32 hashrate: diff_delta × 42 / dt / 16384
        local hashrate_str="calculating..."
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
# Deploys a static HTML page via nginx that polls the node Owner API every 10s.
# nginx injects the Basic Auth header so the secret never reaches the browser.

solo_deploy_stats_page() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  S) Deploy Mining Stats Page${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Deploys a static mining stats page via nginx."
    echo -e "  nginx proxies /api/status → node Owner API with Basic Auth."
    echo -e "  No Node.js, no database, no systemd service needed."
    echo ""

    if [[ ! -f "$STATS_WEB_SRC" ]]; then
        error "Stats page not found: $STATS_WEB_SRC"
        return 1
    fi

    local subdomain
    echo -ne "Subdomain for stats page (e.g. mining.example.com): "
    read -r subdomain
    [[ -z "$subdomain" ]] && { warn "No subdomain — cancelled."; return 1; }

    if ! nginx_validate_domain "$subdomain"; then
        error "Invalid domain name: $subdomain"
        return 1
    fi

    local secret_path="/opt/grin/node/mainnet-prune/.api_secret"
    if [[ ! -f "$secret_path" ]]; then
        echo -ne "Path to node .api_secret [/opt/grin/node/mainnet-prune/.api_secret]: "
        read -r alt_path
        [[ -n "$alt_path" ]] && secret_path="$alt_path"
    fi
    if [[ ! -f "$secret_path" ]]; then
        error "Secret file not found: $secret_path"
        return 1
    fi

    local secret; secret=$(cat "$secret_path")
    local b64_auth; b64_auth=$(printf 'grin:%s' "$secret" | base64 -w 0)

    info "Deploying stats page to $STATS_WEB_DIR..."
    mkdir -p "$STATS_WEB_DIR"
    cp "$STATS_WEB_SRC" "$STATS_WEB_DIR/index.html"
    chmod 644 "$STATS_WEB_DIR/index.html"
    success "stats.html deployed."

    nginx_ensure_grin_api_zone

    info "Writing nginx vhost: $STATS_NGINX_CONF"
    mkdir -p "$(dirname "$STATS_NGINX_CONF")"
    cat > "$STATS_NGINX_CONF" << EOF
# Grin Solo Mining Stats — generated by 07_grin_mining_solo.sh
# Rate-limit zone lives in /etc/nginx/conf.d/grin-rate-limit.conf

server {
    listen 80;
    server_name $subdomain;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name $subdomain;

    root $STATS_WEB_DIR;
    index index.html;

    # SSL — managed by certbot
    ssl_certificate     /etc/letsencrypt/live/$subdomain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$subdomain/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf 2>/dev/null;

    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;

    # Proxy to node Owner API — Auth injected here, never exposed to browser
    location /api/status {
        limit_req zone=grin_api burst=5 nodelay;
        proxy_pass         http://127.0.0.1:$NODE_API_PORT_MAINNET/v2/owner;
        proxy_method       POST;
        proxy_set_header   Content-Type "application/json";
        proxy_set_header   Authorization "Basic $b64_auth";
        proxy_set_body     '{"jsonrpc":"2.0","method":"get_status","params":[],"id":1}';
        proxy_read_timeout 10s;
    }

    location / {
        try_files \$uri \$uri/ =404;
    }

    access_log /var/log/nginx/grin-stats-access.log;
    error_log  /var/log/nginx/grin-stats-error.log;
}
EOF

    chmod 600 "$STATS_NGINX_CONF"

    nginx_ensure_sites_enabled_include
    local sites_enabled="/etc/nginx/sites-enabled/$(basename "$STATS_NGINX_CONF")"
    ln -sf "$STATS_NGINX_CONF" "$sites_enabled" 2>/dev/null || true

    nginx -t 2>&1 && systemctl reload nginx \
        && success "nginx configured for $subdomain" \
        || { error "nginx config test failed. Check $STATS_NGINX_CONF"; return 1; }

    echo ""
    echo -ne "Run certbot for SSL on $subdomain? [Y/n/0]: "
    read -r do_ssl
    if [[ "${do_ssl,,}" != "n" && "$do_ssl" != "0" ]]; then
        certbot --nginx -d "$subdomain" --non-interactive --agree-tos \
            --email "admin@$subdomain" 2>&1 | tail -5 || warn "certbot failed — configure SSL manually."
    fi

    echo ""
    success "Stats page deployed: https://$subdomain"
    echo -e "  Page polls ${BOLD}/api/status${RESET} every 10s via nginx proxy."
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
# Grin stratum watchdog — checks stratum is still enabled in grin-server.toml
set -euo pipefail

LOG="$WATCHDOG_LOG"
TS=\$(date -u '+%Y-%m-%d %H:%M:%S UTC')
WARNED=false

for TOML_PATH in $toml_paths; do
    [[ -f "\$TOML_PATH" ]] || continue
    ENABLED=\$(grep -E '^[[:space:]]*enable_stratum_server[[:space:]]*=' "\$TOML_PATH" 2>/dev/null \
        | head -1 | sed 's/.*=[[:space:]]*//' | tr -d ' ' || echo "")
    if [[ "\$ENABLED" != "true" ]]; then
        echo "[\$TS] WARN: enable_stratum_server not true in \$TOML_PATH (found: '\${ENABLED:-not set}')" >> "\$LOG"
        WARNED=true
    fi
done

if [[ "\$WARNED" == "false" ]]; then
    echo "[\$TS] OK: stratum enabled in all detected grin-server.toml files" >> "\$LOG"
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

show_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  07) Grin Mining Services — Solo${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    show_compact_status

    echo -e "${DIM}  ─── Status ──────────────────────────────────────${RESET}"
    echo -e "  ${GREEN}A${RESET}) Node & Mining Status  ${DIM}(node sync, tmux, stratum config + miners)${RESET}"
    echo ""
    echo -e "${DIM}  ─── MAINNET ─────────────────────────────────────${RESET}"
    echo -e "  ${GREEN}B${RESET}) Setup Stratum         ${DIM}(enable stratum in grin-server.toml)${RESET}"
    echo -e "  ${GREEN}C${RESET}) Configure Stratum     ${DIM}(wallet URL, burn_reward)${RESET}"
    echo -e "  ${GREEN}D${RESET}) Publish Stratum       ${DIM}(open :$STRATUM_PORT_MAINNET to miners)${RESET}"
    echo -e "  ${RED}E${RESET}) Restrict Stratum      ${DIM}(revert to localhost)${RESET}"
    echo ""
    echo -e "${DIM}  ─── TESTNET ─────────────────────────────────────${RESET}"
    echo -e "  ${GREEN}F${RESET}) Setup Stratum"
    echo -e "  ${GREEN}G${RESET}) Configure Stratum"
    echo -e "  ${GREEN}I${RESET}) Publish Stratum       ${DIM}(open :$STRATUM_PORT_TESTNET for local lab)${RESET}"
    echo -e "  ${RED}J${RESET}) Restrict Stratum"
    echo ""
    echo -e "${DIM}  ─── TOOLS ───────────────────────────────────────${RESET}"
    echo -e "  ${GREEN}L${RESET}) Live stats            ${DIM}(terminal dashboard, updates every 10s)${RESET}"
    echo -e "  ${GREEN}S${RESET}) Stats web page        ${DIM}(deploy static mining stats page via nginx)${RESET}"
    echo -e "  ${GREEN}W${RESET}) Watchdog cron         ${DIM}(auto-alert if stratum drops)${RESET}"
    echo ""
    echo -e "  ${DIM}↩  Press Enter to refresh${RESET}"
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -ne "${BOLD}Select [A/B-E/F-J/L/S/W/0]: ${RESET}"
}

main() {
    while true; do
        show_menu
        read -r choice

        case "${choice,,}" in
            "")  continue ;;
            a)   show_node_status ;;
            b)   setup_stratum_mainnet ;;
            c)   configure_stratum_mainnet ;;
            d)   publish_mainnet_stratum ;;
            e)   restrict_mainnet_stratum ;;
            f)   setup_stratum_testnet ;;
            g)   configure_stratum_testnet ;;
            i)   publish_testnet_stratum ;;
            j)   restrict_testnet_stratum ;;
            l)   solo_live_stats ;;
            s)   solo_deploy_stats_page ;;
            w)   solo_watchdog_setup ;;
            0)   break ;;
            *)   warn "Invalid option." ; sleep 1 ; continue ;;
        esac

        [[ "${choice,,}" != "l" ]] && {
            echo ""
            echo "Press Enter to continue..."
            read -r
        }
    done
}

main "$@"
