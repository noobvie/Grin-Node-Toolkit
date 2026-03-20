#!/bin/bash
# =============================================================================
# 07_grin_mining_services.sh - Grin Mining Services & Pool Web Interface
# =============================================================================
# v2: Menu reorganized — stratum split by network, pool web interface added.
#
# ─── Overview ─────────────────────────────────────────────────────────────────
#   · A) Node Status        (running nodes, tmux sessions, binary path)
#   · H) Mining Status      (ports, connected miners, toml values)
#
# ─── Mainnet Stratum (port 3416) ──────────────────────────────────────────────
#   · B) Setup Stratum      (enable_stratum_server, wallet_listener_url)
#   · C) Configure Stratum  (wallet URL, burn_reward, toggle enable)
#   · D) Publish Stratum    (0.0.0.0:3416 + firewall — open to miners)
#   · E) Restrict Stratum   (revert to 127.0.0.1:3416)
#
# ─── Testnet Stratum (port 13416) ─────────────────────────────────────────────
#   · F) Setup Stratum      (enable_stratum_server, wallet_listener_url)
#   · G) Configure Stratum  (wallet URL, burn_reward, toggle enable)
#   · I) Publish Stratum    (0.0.0.0:13416 + firewall — open to miners)
#   · J) Restrict Stratum   (revert to 127.0.0.1:13416)
#
# ─── Pool Web Interface ───────────────────────────────────────────────────────
#   · W) Pool Web Interface (FastAPI app — mainnet port 3002 / testnet 3003)
#        Submenu: 0) Guided setup  1) Install  2) Configure  3) Deploy web
#                 4) nginx  5) Admin account  6) Start/Stop  7) Status
#                 B) Backup  C) Cron schedules  U) Update  L) Logs  DEL) Reset
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
LOG_DIR="/opt/grin/logs"
LOG_FILE="$LOG_DIR/grin_mining_$(date +%Y%m%d_%H%M%S).log"

# ─── Pool Web Interface constants ─────────────────────────────────────────────
POOL_APP_SRC="$TOOLKIT_ROOT/web/07_pool/pool-manager"
POOL_WEB_SRC="$TOOLKIT_ROOT/web/07_pool/public_html"
POOL_CONF_MAINNET="/opt/grin/conf/grin_pool.json"
POOL_CONF_TESTNET="/opt/grin/conf/grin_pool_testnet.json"
POOL_APP_DIR_MAINNET="/opt/grin/pool/mainnet"
POOL_APP_DIR_TESTNET="/opt/grin/pool/testnet"
POOL_WEB_DIR_MAINNET="/var/www/grin-pool"
POOL_WEB_DIR_TESTNET="/var/www/grin-pool-testnet"
POOL_PORT_MAINNET=3002
POOL_PORT_TESTNET=3003
POOL_SERVICE_MAINNET="grin-pool-manager"
POOL_SERVICE_TESTNET="grin-pool-manager-testnet"
POOL_NGINX_MAINNET="/etc/nginx/sites-available/grin-pool"
POOL_NGINX_TESTNET="/etc/nginx/sites-available/grin-pool-testnet"
POOL_LOG_MAINNET="/opt/grin/logs/grin-pool.log"
POOL_LOG_TESTNET="/opt/grin/logs/grin-pool-testnet.log"

# ─── Global state ─────────────────────────────────────────────────────────────
FOUND_GRIN_TOML=""

# tmux session name convention: grin_<nodetype>_<networktype>
_grin_session_name() {
    case "$(basename "${1:-}")" in
        mainnet-full)  echo "grin_full_mainnet"   ;;
        mainnet-prune) echo "grin_pruned_mainnet" ;;
        testnet-prune) echo "grin_pruned_testnet" ;;
        *)             echo "grin_$(basename "${1:-}")" ;;
    esac
}

# ─── Logging ──────────────────────────────────────────────────────────────────
mkdir -p "$LOG_DIR"
log()     { echo -e "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; log "[INFO] $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; log "[OK] $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; log "[WARN] $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; log "[ERROR] $*"; }

# ═══════════════════════════════════════════════════════════════════════════════
# TOML DETECTION — locate grin-server.toml for the given network
# ═══════════════════════════════════════════════════════════════════════════════
# Primary: resolve via /proc/$pid/exe of the running grin process on api_port.
# Fallback: scan known toolkit dirs (/grin<mode><net>/) and ~/.grin/<net>/.
# Sets global FOUND_GRIN_TOML on success; returns 1 on failure.
# ═══════════════════════════════════════════════════════════════════════════════

_KNOWN_TOML_SEARCH_PATHS=(
    /opt/grin/node/mainnet-full   /opt/grin/node/mainnet-prune
    /opt/grin/node/testnet-prune
    "${HOME}/.grin/main"   "${HOME}/.grin/test"
    /root/.grin/main       /root/.grin/test
)

# Non-interactive: returns toml path via stdout. Used by status functions.
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

    local dir f
    for dir in "${_KNOWN_TOML_SEARCH_PATHS[@]}"; do
        f="$dir/grin-server.toml"
        [[ -f "$f" ]] || continue
        grep -qiE "chain_type\s*=\s*[\"']?$expected_chain_type" "$f" 2>/dev/null \
            && echo "$f" && return 0
    done

    return 1
}

# Interactive: resolves toml or prompts the user. Sets FOUND_GRIN_TOML.
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

# Walk up the process tree from child_pid looking for parent_pid.
# Returns 0 (match found within 6 levels) or 1 (not a descendant).
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

# Find which grin_ tmux session owns the process with the given PID.
# Prints the session name and returns 0, or returns 1 if not found.
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

# Gracefully stop the grin node on api_port and restart it in a fresh tmux session.
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

    # Capture binary path BEFORE killing (readable only while process is alive)
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

    # Use the original session name if found; otherwise derive from directory.
    local session_name="${target_session:-$(_grin_session_name "$grin_dir")}"

    # Kill the old session — it is sitting at the "Press Enter to close" read prompt.
    tmux kill-session -t "$session_name" 2>/dev/null || true
    sleep 1

    info "Starting grin in tmux session: $session_name"
    tmux new-session -d -s "$session_name" -c "$grin_dir" \
        "echo 'Starting Grin node...'; cd '$grin_dir' && '$grin_binary' server run; echo ''; echo 'Grin process exited. Press Enter to close.'; read" \
        || { warn "Failed to create tmux session. Start manually: cd $grin_dir && $grin_binary server run"; return 1; }

    sleep 3
    if ss -tlnp 2>/dev/null | grep -q ":$api_port "; then
        success "Grin ($network) node is back up on port $api_port."
    else
        warn "Grin may still be initializing. Check: tmux attach -t $session_name"
    fi
    info "View : tmux attach -t $session_name"
}

# ═══════════════════════════════════════════════════════════════════════════════
# STATUS HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

# One-line stratum bind description from a toml file
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

# Compact two-line status shown at the top of every menu refresh
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
# A) NODE STATUS
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
    else
        echo -e "    Stratum: ${DIM}not listening${RESET}  ${DIM}(port $stratum_port)${RESET}"
    fi
    echo ""
}

show_node_status() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  A) Node Status${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    _show_node_info mainnet "$NODE_API_PORT_MAINNET" "$STRATUM_PORT_MAINNET"
    _show_node_info testnet "$NODE_API_PORT_TESTNET" "$STRATUM_PORT_TESTNET"
}

# ═══════════════════════════════════════════════════════════════════════════════
# B / F) SETUP STRATUM  (per-network wrappers around shared _do_setup_stratum)
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
        if grep -qE '^#?[[:space:]]*wallet_listener_url[[:space:]]*=' "$grin_toml" 2>/dev/null; then
            sed -i -E \
                "s|^#?[[:space:]]*wallet_listener_url[[:space:]]*=.*|wallet_listener_url = \"$new_url\"|" \
                "$grin_toml"
        else
            echo "wallet_listener_url = \"$new_url\"" >> "$grin_toml"
        fi
        success "wallet_listener_url = \"$new_url\""
        log "Setup ($network): wallet_listener_url = $new_url in $grin_toml"
    fi

    echo ""
    echo -e "${BOLD}burn_reward${RESET} — set true to discard coinbase (useful for testing only)."
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
# C / G) CONFIGURE STRATUM  (per-network wrappers around _do_configure_stratum)
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
            if grep -qE '^#?[[:space:]]*enable_stratum_server[[:space:]]*=' "$grin_toml" 2>/dev/null; then
                sed -i -E "s|^#?[[:space:]]*enable_stratum_server[[:space:]]*=.*|enable_stratum_server = $new_val|" "$grin_toml"
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
            if grep -qE '^#?[[:space:]]*stratum_server_addr[[:space:]]*=' "$grin_toml" 2>/dev/null; then
                sed -i -E "s|^#?[[:space:]]*stratum_server_addr[[:space:]]*=.*|stratum_server_addr = \"$new_addr\"|" "$grin_toml"
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
            if grep -qE '^#?[[:space:]]*wallet_listener_url[[:space:]]*=' "$grin_toml" 2>/dev/null; then
                sed -i -E "s|^#?[[:space:]]*wallet_listener_url[[:space:]]*=.*|wallet_listener_url = \"$new_wallet\"|" "$grin_toml"
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
            if grep -qE '^#?[[:space:]]*burn_reward[[:space:]]*=' "$grin_toml" 2>/dev/null; then
                sed -i -E "s|^#?[[:space:]]*burn_reward[[:space:]]*=.*|burn_reward = $new_burn|" "$grin_toml"
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
# PORT GUIDE (stratum)
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
    echo -e "  ${CYAN}Who needs it${RESET} : Anyone running or supporting a mining pool."
    echo -e "  ${CYAN}Expose via${RESET}   : Direct bind — patches grin-server.toml so grin listens on"
    echo -e "               0.0.0.0:$port instead of 127.0.0.1:$port."
    echo -e "  ${YELLOW}Requires${RESET}     : Graceful node restart for the change to take effect."
    echo -e "  ${GREEN}Expose if${RESET}    : You want miners to point their hashrate at your node."
    echo -e "  ${YELLOW}Skip if${RESET}      : You are not involved in mining."
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
# D / E / F / G) PUBLISH / RESTRICT STRATUM
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
    sed -i -E \
        "s|^#?[[:space:]]*stratum_server_addr[[:space:]]*=.*|stratum_server_addr = \"0.0.0.0:${stratum_port}\"|" \
        "$grin_toml"
    success "stratum_server_addr = \"0.0.0.0:$stratum_port\" written to grin-server.toml"
    log "Stratum ($network) published: patched $grin_toml -> 0.0.0.0:$stratum_port"

    echo ""
    echo -e "${BOLD}Open firewall port $stratum_port for miners:${RESET}"
    echo -e "  ${GREEN}1${RESET}) Open to all IPs  ${DIM}(recommended)${RESET}"
    echo -e "  ${YELLOW}2${RESET}) Open to specific IP only"
    echo -e "  ${RED}3${RESET}) Skip firewall changes"
    echo -e "  ${DIM}0) Skip firewall changes${RESET}"
    echo -ne "Choice [1]: "
    read -r fw_choice
    [[ "$fw_choice" == "0" ]] && fw_choice="3"

    case "${fw_choice:-1}" in
        1)
            if command -v ufw &>/dev/null; then
                ufw allow "$stratum_port/tcp"
                success "UFW: port $stratum_port opened to all."
            elif command -v iptables &>/dev/null; then
                iptables -I INPUT -p tcp --dport "$stratum_port" -j ACCEPT
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
                    success "iptables: port $stratum_port opened for $allowed_ip."
                fi
            fi
            ;;
        3) info "Firewall not modified." ;;
    esac

    echo ""
    graceful_restart_grin "$api_port" "$network"
    echo ""
    info "Miners connect to: YOUR_SERVER_IP:$stratum_port"
    info "Log file         : $LOG_FILE"
}

_disable_stratum() {
    local network="$1" stratum_port="$2" api_port="$3"

    echo -e "\n${BOLD}${CYAN}── Restrict Stratum ($network, port $stratum_port) to Localhost ──${RESET}\n"

    find_grin_server_toml "$network" "$api_port" || return
    local grin_toml="$FOUND_GRIN_TOML"

    info "Patching $grin_toml ..."
    sed -i -E \
        "s|^#?[[:space:]]*stratum_server_addr[[:space:]]*=.*|stratum_server_addr = \"127.0.0.1:${stratum_port}\"|" \
        "$grin_toml"
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

# D / E — Mainnet publish / restrict
publish_mainnet_stratum()  { _enable_stratum  mainnet "$STRATUM_PORT_MAINNET" "$NODE_API_PORT_MAINNET"; }
restrict_mainnet_stratum() { _disable_stratum mainnet "$STRATUM_PORT_MAINNET" "$NODE_API_PORT_MAINNET"; }

# I / J — Testnet publish / restrict  (were F/G in v1)
publish_testnet_stratum()  { _enable_stratum  testnet "$STRATUM_PORT_TESTNET" "$NODE_API_PORT_TESTNET"; }
restrict_testnet_stratum() { _disable_stratum testnet "$STRATUM_PORT_TESTNET" "$NODE_API_PORT_TESTNET"; }

# ═══════════════════════════════════════════════════════════════════════════════
# H) MINING STATUS
# ═══════════════════════════════════════════════════════════════════════════════

_mining_status_for_network() {
    local network="$1" stratum_port="$2" api_port="$3"
    local label="Mainnet"
    [[ "$network" == "testnet" ]] && label="Testnet"

    echo -e "  ${BOLD}$label Stratum (port $stratum_port):${RESET}"

    if ss -tlnp 2>/dev/null | grep -q ":$stratum_port "; then
        echo -e "    Port     : ${GREEN}LISTENING${RESET}"
    else
        echo -e "    Port     : ${RED}NOT LISTENING${RESET}  ${DIM}(stratum off or node not running)${RESET}"
    fi

    local miner_count
    miner_count=$(ss -tnp 2>/dev/null | grep ":$stratum_port" | grep -c ESTAB || true)
    if [[ "$miner_count" -gt 0 ]]; then
        echo -e "    Miners   : ${GREEN}$miner_count connected${RESET}"
    else
        echo -e "    Miners   : ${DIM}0 connected${RESET}"
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
        echo -e "    toml     : $toml"
        echo -e "    enabled  : ${e:-${DIM}not set${RESET}}"
        echo -e "    bind     : ${addr:-${DIM}not set${RESET}}"
        echo -e "    wallet   : ${wallet:-${DIM}not set${RESET}}"
        echo -e "    burn     : ${burn:-${DIM}not set${RESET}}"
        if [[ "$addr" == "0.0.0.0:$stratum_port" ]]; then
            echo -e "    connect  : ${GREEN}YOUR_SERVER_IP:$stratum_port${RESET}  ${DIM}(public — miners can connect)${RESET}"
        else
            echo -e "    connect  : ${YELLOW}127.0.0.1:$stratum_port${RESET}  ${DIM}(localhost only — use D/F to publish)${RESET}"
        fi
    else
        echo -e "    toml     : ${DIM}not found${RESET}"
    fi
    echo ""
}

show_mining_status() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  H) Mining Status${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    _mining_status_for_network mainnet "$STRATUM_PORT_MAINNET" "$NODE_API_PORT_MAINNET"
    _mining_status_for_network testnet "$STRATUM_PORT_TESTNET" "$NODE_API_PORT_TESTNET"
}

# ═══════════════════════════════════════════════════════════════════════════════
# W) POOL WEB INTERFACE — helper functions
# ═══════════════════════════════════════════════════════════════════════════════

# Resolve per-network variables into local vars based on $1 (mainnet|testnet)
_pool_vars() {
    local net="$1"
    if [[ "$net" == "testnet" ]]; then
        POOL_CONF="$POOL_CONF_TESTNET"
        POOL_APP_DIR="$POOL_APP_DIR_TESTNET"
        POOL_WEB_DIR="$POOL_WEB_DIR_TESTNET"
        POOL_PORT="$POOL_PORT_TESTNET"
        POOL_SERVICE="$POOL_SERVICE_TESTNET"
        POOL_NGINX_CONF="$POOL_NGINX_TESTNET"
        POOL_LOG="$POOL_LOG_TESTNET"
    else
        POOL_CONF="$POOL_CONF_MAINNET"
        POOL_APP_DIR="$POOL_APP_DIR_MAINNET"
        POOL_WEB_DIR="$POOL_WEB_DIR_MAINNET"
        POOL_PORT="$POOL_PORT_MAINNET"
        POOL_SERVICE="$POOL_SERVICE_MAINNET"
        POOL_NGINX_CONF="$POOL_NGINX_MAINNET"
        POOL_LOG="$POOL_LOG_MAINNET"
    fi
}

pool_read_conf() {
    # pool_read_conf <network> <key> [default]
    local net="$1" key="$2" default="${3:-}"
    _pool_vars "$net"
    [[ -f "$POOL_CONF" ]] || { echo "$default"; return; }
    python3 - "$POOL_CONF" "$key" "$default" << 'PYEOF' 2>/dev/null || echo "$default"
import json, sys
path, key, default = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    d = json.load(open(path))
    print(d.get(key, default))
except Exception:
    print(default)
PYEOF
}

pool_write_conf_key() {
    # pool_write_conf_key <network> <key> <value>
    local net="$1" key="$2" val="$3"
    _pool_vars "$net"
    mkdir -p "$(dirname "$POOL_CONF")"
    python3 - "$key" "$val" "$POOL_CONF" << 'PYEOF'
import json, sys, os
key, val, path = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    d = json.load(open(path)) if os.path.isfile(path) else {}
except Exception:
    d = {}
NUMS = {"stratum_port","node_api_port","pool_fee_percent","min_withdrawal","withdrawal_fee","service_port"}
d[key] = float(val) if key in NUMS else val
with open(path, "w") as f:
    json.dump(d, f, indent=2)
os.chmod(path, 0o600)
PYEOF
}

pool_ensure_defaults() {
    local net="$1"
    _pool_vars "$net"
    local -A defaults=(
        ["pool_name"]="My Grin Pool"
        ["subdomain"]=""
        ["network"]="$net"
        ["stratum_port"]="$( [[ $net == testnet ]] && echo 13416 || echo 3416 )"
        ["node_api_port"]="$( [[ $net == testnet ]] && echo 13413 || echo 3413 )"
        ["pool_fee_percent"]="0"
        ["min_withdrawal"]="2.0"
        ["withdrawal_fee"]="0.0"
        ["grin_wallet_dir"]="$( [[ $net == testnet ]] && echo /opt/grin/wallet/testnet || echo /opt/grin/wallet/mainnet )"
        ["log_path"]="$POOL_LOG"
        ["service_port"]="$POOL_PORT"
        ["db_url"]="sqlite+aiosqlite:////$POOL_APP_DIR/pool.db"
        ["wallet_pass_file"]="$POOL_APP_DIR/wallet_pass"
    )
    for k in "${!defaults[@]}"; do
        local existing; existing=$(pool_read_conf "$net" "$k" "__MISSING__")
        [[ "$existing" == "__MISSING__" ]] && pool_write_conf_key "$net" "$k" "${defaults[$k]}"
    done
}

pool_show_status() {
    local net="$1"
    _pool_vars "$net"
    local label="Mainnet"; [[ "$net" == "testnet" ]] && label="Testnet"

    echo -e "\n${BOLD}Pool Manager — $label${RESET}"
    echo -e "${DIM}────────────────────────────────────────────────${RESET}"

    if systemctl is-active --quiet "$POOL_SERVICE" 2>/dev/null; then
        local pid; pid=$(systemctl show "$POOL_SERVICE" --property=MainPID --value 2>/dev/null || echo "?")
        echo -e "  ${BOLD}Service${RESET}  : ${GREEN}● active${RESET}  (pid $pid)"
    elif systemctl is-enabled --quiet "$POOL_SERVICE" 2>/dev/null; then
        echo -e "  ${BOLD}Service${RESET}  : ${YELLOW}installed, stopped${RESET}"
    else
        echo -e "  ${BOLD}Service${RESET}  : ${DIM}not installed${RESET}"
    fi

    local port; port=$(pool_read_conf "$net" "service_port" "$POOL_PORT")
    if ss -tlnp 2>/dev/null | grep -q ":$port "; then
        echo -e "  ${BOLD}Port${RESET}     : ${GREEN}$port listening${RESET}"
    else
        echo -e "  ${BOLD}Port${RESET}     : ${DIM}$port — not listening${RESET}"
    fi

    [[ -f "$POOL_APP_DIR/pool.db" ]] && {
        local dbsz; dbsz=$(du -sh "$POOL_APP_DIR/pool.db" 2>/dev/null | cut -f1 || echo "?")
        echo -e "  ${BOLD}Database${RESET} : $POOL_APP_DIR/pool.db  ($dbsz)"
    }

    local subdomain; subdomain=$(pool_read_conf "$net" "subdomain" "")
    [[ -n "$subdomain" ]] && echo -e "  ${BOLD}URL${RESET}      : https://$subdomain"

    if [[ -f "$POOL_LOG" ]]; then
        echo -e "\n${DIM}── Recent activity (last 15 lines) ──${RESET}"
        tail -n 15 "$POOL_LOG" 2>/dev/null | sed 's/^/  /'
    fi
}

pool_install() {
    local net="$1"
    _pool_vars "$net"
    local label="Mainnet"; [[ "$net" == "testnet" ]] && label="Testnet"

    echo -e "\n${BOLD}Installing Pool Manager ($label)...${RESET}\n"

    # Check source
    if [[ ! -d "$POOL_APP_SRC" ]]; then
        error "Pool app source not found: $POOL_APP_SRC"
        error "Ensure web/07_pool/pool-manager/ exists in the toolkit directory."
        return 1
    fi

    # System packages
    info "Checking system packages..."
    if command -v apt-get &>/dev/null; then
        apt-get install -y python3 python3-pip python3-venv python3-dev build-essential \
            logrotate 2>&1 | tail -5
    elif command -v dnf &>/dev/null; then
        dnf install -y python3 python3-pip python3-devel gcc logrotate 2>&1 | tail -5
    fi

    # App directory
    mkdir -p "$POOL_APP_DIR"
    info "Copying pool manager to $POOL_APP_DIR..."
    cp -r "$POOL_APP_SRC/"* "$POOL_APP_DIR/"

    # Virtual environment
    info "Creating Python virtual environment..."
    python3 -m venv "$POOL_APP_DIR/venv" \
        || { error "Failed to create venv."; return 1; }

    info "Installing Python dependencies..."
    "$POOL_APP_DIR/venv/bin/pip" install --upgrade pip -q
    "$POOL_APP_DIR/venv/bin/pip" install -r "$POOL_APP_DIR/requirements.txt" -q \
        || { error "pip install failed. Check $POOL_APP_DIR/requirements.txt."; return 1; }
    success "Python dependencies installed."

    # Generate JWT secret if not present
    local jwt_secret; jwt_secret=$(pool_read_conf "$net" "jwt_secret" "")
    if [[ -z "$jwt_secret" ]]; then
        jwt_secret=$(python3 -c "import secrets; print(secrets.token_hex(32))" 2>/dev/null || openssl rand -hex 32)
        pool_write_conf_key "$net" "jwt_secret" "$jwt_secret"
        success "JWT secret generated."
    fi

    pool_ensure_defaults "$net"

    # Systemd service
    local exec_start="$POOL_APP_DIR/venv/bin/uvicorn main:app --host 127.0.0.1 --port $POOL_PORT"
    cat > "/etc/systemd/system/$POOL_SERVICE.service" << EOF
[Unit]
Description=Grin Pool Manager ($label)
After=network.target
Wants=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$POOL_APP_DIR
Environment="GRIN_POOL_CONF=$POOL_CONF"
ExecStart=$exec_start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "$POOL_SERVICE" 2>/dev/null || true
    success "Systemd service $POOL_SERVICE installed."

    # Logrotate
    mkdir -p "$(dirname "$POOL_LOG")"
    cat > "/etc/logrotate.d/${POOL_SERVICE}" << EOF
$POOL_LOG {
    daily
    rotate 10
    size 20M
    compress
    delaycompress
    missingok
    notifempty
    postrotate
        systemctl reload $POOL_SERVICE 2>/dev/null || true
    endscript
}
EOF
    success "Logrotate configured."
    echo ""
    success "Pool manager ($label) installed."
    echo -e "  Next: ${BOLD}2) Configure${RESET} → ${BOLD}3) Deploy web files${RESET} → ${BOLD}4) Setup nginx${RESET} → ${BOLD}5) Admin account${RESET}"
}

pool_configure() {
    local net="$1"
    _pool_vars "$net"
    local label="Mainnet"; [[ "$net" == "testnet" ]] && label="Testnet"

    echo -e "\n${BOLD}Configure Pool Manager — $label${RESET}\n"
    pool_ensure_defaults "$net"

    local val

    echo -ne "Pool name        [$(pool_read_conf "$net" "pool_name" "My Grin Pool")]: "
    read -r val; [[ -n "$val" ]] && pool_write_conf_key "$net" "pool_name" "$val"

    echo -ne "Subdomain        [$(pool_read_conf "$net" "subdomain" "")]: "
    read -r val; [[ -n "$val" ]] && pool_write_conf_key "$net" "subdomain" "$val"

    echo -ne "Pool fee %%       [$(pool_read_conf "$net" "pool_fee_percent" "0")]: "
    read -r val; [[ -n "$val" ]] && pool_write_conf_key "$net" "pool_fee_percent" "$val"

    echo -ne "Min withdrawal   [$(pool_read_conf "$net" "min_withdrawal" "2.0")] GRIN: "
    read -r val; [[ -n "$val" ]] && pool_write_conf_key "$net" "min_withdrawal" "$val"

    echo -ne "Wallet dir       [$(pool_read_conf "$net" "grin_wallet_dir" "/opt/grin/wallet/$net")]: "
    read -r val; [[ -n "$val" ]] && pool_write_conf_key "$net" "grin_wallet_dir" "$val"

    # Wallet password
    local wallet_dir; wallet_dir=$(pool_read_conf "$net" "grin_wallet_dir" "/opt/grin/wallet/$net")
    local pass_file="$POOL_APP_DIR/wallet_pass"
    echo -ne "Wallet password  (leave blank to keep existing): "
    read -rs val; echo ""
    if [[ -n "$val" ]]; then
        install -m 600 /dev/null "$pass_file"
        echo -n "$val" > "$pass_file"
        pool_write_conf_key "$net" "wallet_pass_file" "$pass_file"
        success "Wallet password saved to $pass_file"
    fi

    if systemctl is-active --quiet "$POOL_SERVICE" 2>/dev/null; then
        info "Restarting $POOL_SERVICE to apply config..."
        systemctl restart "$POOL_SERVICE"
    fi
    success "Pool manager ($label) configured."
}

pool_deploy_web() {
    local net="$1"
    _pool_vars "$net"

    if [[ ! -d "$POOL_WEB_SRC" ]]; then
        error "Web source not found: $POOL_WEB_SRC"
        return 1
    fi

    info "Deploying web files to $POOL_WEB_DIR..."
    mkdir -p "$POOL_WEB_DIR"
    rsync -a --delete "$POOL_WEB_SRC/" "$POOL_WEB_DIR/" \
        2>/dev/null || cp -r "$POOL_WEB_SRC/"* "$POOL_WEB_DIR/"

    # Stamp network into a small config JS file for frontend detection
    local pool_name; pool_name=$(pool_read_conf "$net" "pool_name" "My Grin Pool")
    cat > "$POOL_WEB_DIR/js/pool-config.js" << EOF
// Auto-generated by 07_grin_mining_services.sh
window.POOL_NETWORK = "${net}";
window.POOL_NAME = $(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$pool_name" 2>/dev/null || echo '"'"$pool_name"'"');
EOF

    success "Web files deployed to $POOL_WEB_DIR"
}

pool_setup_nginx() {
    local net="$1"
    _pool_vars "$net"
    local label="Mainnet"; [[ "$net" == "testnet" ]] && label="Testnet"

    local subdomain; subdomain=$(pool_read_conf "$net" "subdomain" "")
    if [[ -z "$subdomain" ]]; then
        echo -ne "Pool subdomain (e.g. pool.example.com): "
        read -r subdomain
        [[ -z "$subdomain" ]] && { warn "No subdomain — nginx not configured."; return 1; }
        pool_write_conf_key "$net" "subdomain" "$subdomain"
    fi

    info "Writing nginx vhost: $POOL_NGINX_CONF"
    mkdir -p "$(dirname "$POOL_NGINX_CONF")"

    cat > "$POOL_NGINX_CONF" << EOF
# Grin Pool Manager — $label — generated by 07_grin_mining_services.sh
limit_req_zone \$binary_remote_addr zone=${POOL_SERVICE}_auth:10m   rate=3r/m;
limit_req_zone \$binary_remote_addr zone=${POOL_SERVICE}_api:10m    rate=30r/m;
limit_req_zone \$binary_remote_addr zone=${POOL_SERVICE}_static:10m rate=60r/m;

server {
    listen 80;
    server_name $subdomain;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name $subdomain;

    root $POOL_WEB_DIR;
    index index.html;

    # SSL — managed by certbot
    ssl_certificate     /etc/letsencrypt/live/$subdomain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$subdomain/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf 2>/dev/null;

    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data:;" always;

    location /api/auth/ {
        limit_req zone=${POOL_SERVICE}_auth burst=5 nodelay;
        proxy_pass         http://127.0.0.1:$POOL_PORT;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
    }

    location /api/ {
        limit_req zone=${POOL_SERVICE}_api burst=10 nodelay;
        proxy_pass         http://127.0.0.1:$POOL_PORT;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }

    location / {
        limit_req zone=${POOL_SERVICE}_static burst=20 nodelay;
        try_files \$uri \$uri/ \$uri.html =404;
    }

    access_log /var/log/nginx/${POOL_SERVICE}-access.log;
    error_log  /var/log/nginx/${POOL_SERVICE}-error.log;
}
EOF

    local sites_enabled="/etc/nginx/sites-enabled/$(basename "$POOL_NGINX_CONF")"
    ln -sf "$POOL_NGINX_CONF" "$sites_enabled" 2>/dev/null || true

    nginx -t 2>&1 && systemctl reload nginx \
        && success "nginx configured for $subdomain" \
        || { error "nginx config test failed. Check $POOL_NGINX_CONF"; return 1; }

    echo ""
    echo -ne "Run certbot for SSL on $subdomain? [Y/n/0]: "
    read -r do_ssl
    if [[ "${do_ssl,,}" != "n" && "$do_ssl" != "0" ]]; then
        certbot --nginx -d "$subdomain" --non-interactive --agree-tos \
            --email "admin@$subdomain" 2>&1 | tail -5 || warn "certbot failed — configure SSL manually."
    fi
}

pool_setup_admin() {
    local net="$1"
    _pool_vars "$net"
    local label="Mainnet"; [[ "$net" == "testnet" ]] && label="Testnet"
    local port; port=$(pool_read_conf "$net" "service_port" "$POOL_PORT")

    echo -e "\n${BOLD}Create Admin Account — $label${RESET}\n"

    if ! ss -tlnp 2>/dev/null | grep -q ":$port "; then
        warn "Pool manager is not running on port $port."
        warn "Start the service (option 6) first, then run this again."
        return 1
    fi

    echo -ne "Admin username: "
    read -r admin_user
    [[ -z "$admin_user" ]] && return

    echo -ne "Admin password: "
    read -rs admin_pass; echo ""
    [[ -z "$admin_pass" ]] && return

    echo -ne "Admin email (optional): "
    read -r admin_email

    local payload; payload=$(python3 -c "
import json, sys
d = {'username': sys.argv[1], 'password': sys.argv[2], 'email': sys.argv[3]}
print(json.dumps(d))
" "$admin_user" "$admin_pass" "${admin_email:-}")

    local resp; resp=$(curl -s -X POST "http://127.0.0.1:$port/api/auth/register" \
        -H "Content-Type: application/json" -d "$payload" 2>&1)

    if echo "$resp" | grep -q "access_token"; then
        success "User '$admin_user' registered."
        # Promote to admin directly via DB (simplest approach)
        python3 - "$POOL_APP_DIR/pool.db" "$admin_user" << 'PYEOF'
import sqlite3, sys
db_path, username = sys.argv[1], sys.argv[2]
con = sqlite3.connect(db_path)
con.execute("UPDATE users SET is_admin=1 WHERE username=?", (username,))
con.commit()
con.close()
print(f"User '{username}' promoted to admin.")
PYEOF
    else
        error "Registration failed: $resp"
    fi
}

pool_service_control() {
    local net="$1" action="$2"
    _pool_vars "$net"

    case "$action" in
        start)
            systemctl start "$POOL_SERVICE" \
                && success "$POOL_SERVICE started." \
                || error "Failed to start $POOL_SERVICE."
            ;;
        stop)
            systemctl stop "$POOL_SERVICE" \
                && success "$POOL_SERVICE stopped." \
                || error "Failed to stop $POOL_SERVICE."
            ;;
        restart)
            systemctl restart "$POOL_SERVICE" \
                && success "$POOL_SERVICE restarted." \
                || error "Failed to restart $POOL_SERVICE."
            ;;
    esac
}

pool_service_menu() {
    local net="$1"
    _pool_vars "$net"

    echo -e "\n${BOLD}Service Control — $POOL_SERVICE${RESET}"
    if systemctl is-active --quiet "$POOL_SERVICE" 2>/dev/null; then
        echo -e "  Status: ${GREEN}● running${RESET}"
        echo -e "  ${GREEN}1${RESET}) Stop    ${RED}2${RESET}) Restart    ${DIM}0) Back${RESET}"
        echo -ne "Choice: "
        read -r sc
        case "$sc" in
            1) pool_service_control "$net" stop ;;
            2) pool_service_control "$net" restart ;;
        esac
    else
        echo -e "  Status: ${RED}● stopped${RESET}"
        echo -e "  ${GREEN}1${RESET}) Start    ${DIM}0) Back${RESET}"
        echo -ne "Choice: "
        read -r sc
        [[ "$sc" == "1" ]] && pool_service_control "$net" start
    fi
}

pool_backup() {
    local net="$1"
    _pool_vars "$net"

    local backup_dir="/opt/grin/backups/${POOL_SERVICE}"
    mkdir -p "$backup_dir"
    local ts; ts=$(date +%Y%m%d_%H%M%S)
    local backup_file="$backup_dir/pool_backup_${ts}.tar.gz"

    local files=()
    [[ -f "$POOL_APP_DIR/pool.db" ]] && files+=("$POOL_APP_DIR/pool.db")
    [[ -f "$POOL_CONF" ]]            && files+=("$POOL_CONF")

    if [[ ${#files[@]} -eq 0 ]]; then
        warn "Nothing to back up — DB and config not found."
        return
    fi

    tar -czf "$backup_file" "${files[@]}" 2>/dev/null \
        && success "Backup: $backup_file" \
        || error "Backup failed."

    # Keep last 30
    ls -t "$backup_dir"/pool_backup_*.tar.gz 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null || true
}

pool_cron_schedules() {
    local net="$1"
    _pool_vars "$net"

    echo -e "\n${BOLD}Cron Schedules — $POOL_SERVICE${RESET}\n"
    local cron_backup="/etc/cron.d/${POOL_SERVICE}-backup"
    local cron_vacuum="/etc/cron.d/${POOL_SERVICE}-vacuum"

    [[ -f "$cron_backup" ]] \
        && echo -e "  Daily backup  : ${GREEN}enabled${RESET}  ($cron_backup)" \
        || echo -e "  Daily backup  : ${DIM}disabled${RESET}"

    [[ -f "$cron_vacuum" ]] \
        && echo -e "  Weekly VACUUM : ${GREEN}enabled${RESET}  ($cron_vacuum)" \
        || echo -e "  Weekly VACUUM : ${DIM}disabled${RESET}"

    echo ""
    echo -e "  ${GREEN}1${RESET}) Toggle daily backup (02:00 UTC)"
    echo -e "  ${GREEN}2${RESET}) Toggle weekly SQLite VACUUM (Sunday 03:00 UTC)"
    echo -e "  ${DIM}0) Back${RESET}"
    echo -ne "Choice: "
    read -r cc

    case "$cc" in
        1)
            if [[ -f "$cron_backup" ]]; then
                rm -f "$cron_backup"
                success "Daily backup cron disabled."
            else
                cat > "$cron_backup" << EOF
0 2 * * * root /usr/bin/bash -c "source $SCRIPT_DIR/07_grin_mining_services.sh 2>/dev/null; _pool_vars $net; pool_backup $net" >> $POOL_LOG 2>&1
EOF
                success "Daily backup cron enabled ($cron_backup)."
            fi
            ;;
        2)
            if [[ -f "$cron_vacuum" ]]; then
                rm -f "$cron_vacuum"
                success "Weekly VACUUM cron disabled."
            else
                cat > "$cron_vacuum" << EOF
0 3 * * 0 root /usr/bin/sqlite3 $POOL_APP_DIR/pool.db "VACUUM;" >> $POOL_LOG 2>&1
EOF
                success "Weekly VACUUM cron enabled ($cron_vacuum)."
            fi
            ;;
    esac
}

pool_view_logs() {
    local net="$1"
    _pool_vars "$net"

    if [[ ! -f "$POOL_LOG" ]]; then
        warn "Log file not found: $POOL_LOG"
        return
    fi
    tail -n 50 "$POOL_LOG" | less -FRX
}

pool_reset_db() {
    local net="$1"
    _pool_vars "$net"
    local label="Mainnet"; [[ "$net" == "testnet" ]] && label="Testnet"
    local db_path="$POOL_APP_DIR/pool.db"

    echo -e "\n${RED}${BOLD}━━━ DANGER ZONE — Reset Pool Database ━━━${RESET}"
    echo ""

    if [[ ! -f "$db_path" ]]; then
        warn "Database not found: $db_path"
        return
    fi

    local db_size; db_size=$(du -sh "$db_path" 2>/dev/null | cut -f1 || echo "?")
    local user_count; user_count=$(python3 -c "
import sqlite3, sys
try:
    con = sqlite3.connect(sys.argv[1])
    print(con.execute('SELECT COUNT(*) FROM users').fetchone()[0])
    con.close()
except: print('?')
" "$db_path" 2>/dev/null || echo "?")

    echo -e "  Database : $db_path  ($db_size)"
    echo -e "  Users    : $user_count accounts"
    echo -e "  Network  : $label"
    echo ""
    warn "This will permanently DELETE all users, balances, shares, blocks, and withdrawals."
    echo ""
    echo -ne "Type ${RED}RESET POOL DATABASE${RESET} to confirm: "
    read -r confirm1
    [[ "$confirm1" != "RESET POOL DATABASE" ]] && { info "Aborted."; return; }

    echo -ne "Type ${RED}YES${RESET} to proceed: "
    read -r confirm2
    [[ "$confirm2" != "YES" ]] && { info "Aborted."; return; }

    pool_service_control "$net" stop 2>/dev/null || true
    sleep 1

    rm -f "$db_path"
    success "Database deleted."

    # Recreate schema via Python
    if [[ -f "$POOL_APP_DIR/database.py" && -f "$POOL_APP_DIR/venv/bin/python3" ]]; then
        info "Recreating database schema..."
        GRIN_POOL_CONF="$POOL_CONF" "$POOL_APP_DIR/venv/bin/python3" \
            -c "import asyncio; from database import init_db; asyncio.run(init_db())" \
            2>&1 && success "Schema recreated." || warn "Schema recreation failed — restart service."
    fi

    pool_service_control "$net" start 2>/dev/null || true
}

pool_guided_setup() {
    local net="$1"
    local label="Mainnet"; [[ "$net" == "testnet" ]] && label="Testnet"

    echo -e "\n${BOLD}${CYAN}═══ Guided Full Setup — Pool Manager ($label) ═══${RESET}\n"
    echo -e "  This will run steps 1 → 2 → 3 → 4 → 5 → 6 in sequence."
    echo -ne "  Continue? [Y/n]: "
    read -r go; [[ "${go,,}" == "n" ]] && return

    pool_install   "$net" || return
    echo ""; echo "Press Enter to continue to Configure..."; read -r
    pool_configure "$net"
    echo ""; echo "Press Enter to continue to Deploy web files..."; read -r
    pool_deploy_web "$net"
    echo ""; echo "Press Enter to continue to Setup nginx..."; read -r
    pool_setup_nginx "$net"
    echo ""; echo "Press Enter to continue to Create admin account..."; read -r
    pool_start_service "$net"
    sleep 2
    pool_setup_admin "$net"

    echo ""
    success "Guided setup complete. Open https://$(pool_read_conf "$net" "subdomain" "your-domain") to access the pool."
}

pool_start_service() {
    local net="$1"
    _pool_vars "$net"
    if ! systemctl is-active --quiet "$POOL_SERVICE" 2>/dev/null; then
        pool_service_control "$net" start
    else
        info "$POOL_SERVICE is already running."
    fi
}

_pool_menu_status_line() {
    local net="$1"
    _pool_vars "$net"
    if systemctl is-active --quiet "$POOL_SERVICE" 2>/dev/null; then
        echo -e "${GREEN}● running${RESET}"
    elif [[ -f "$POOL_CONF" ]]; then
        echo -e "${YELLOW}installed, stopped${RESET}"
    else
        echo -e "${DIM}not installed${RESET}"
    fi
}

pool_menu() {
    local net="$1"
    _pool_vars "$net"
    local label="Mainnet"; [[ "$net" == "testnet" ]] && label="Testnet"

    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  W) Pool Web Interface — $label${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  Service: $(_pool_menu_status_line "$net")"
        echo ""
        echo -e "${DIM}  ─── First-Time Setup ────────────────────────────${RESET}"
        echo -e "  ${GREEN}0${RESET}) Guided Full Setup    ${DIM}(runs 1→2→3→4→5→6)${RESET}"
        echo ""
        echo -e "${DIM}  ─── Install & Configure ──────────────────────────${RESET}"
        echo -e "  ${GREEN}1${RESET}) Install dependencies ${DIM}(python3, pip, fastapi, uvicorn)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Configure pool       ${DIM}(name, domain, fee, wallet)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Deploy web files     ${DIM}(→ $POOL_WEB_DIR)${RESET}"
        echo -e "  ${GREEN}4${RESET}) Setup nginx          ${DIM}(vhost + SSL + rate limits)${RESET}"
        echo -e "  ${GREEN}5${RESET}) Setup admin account  ${DIM}(create first admin user)${RESET}"
        echo -e "  ${GREEN}6${RESET}) Start / Stop service ${DIM}($POOL_SERVICE)${RESET}"
        echo ""
        echo -e "${DIM}  ─── Maintenance ──────────────────────────────────${RESET}"
        echo -e "  ${GREEN}7${RESET}) Pool status          ${DIM}(service, port, DB, recent logs)${RESET}"
        echo -e "  ${GREEN}B${RESET}) Backup now           ${DIM}(DB + config → /opt/grin/backups/)${RESET}"
        echo -e "  ${GREEN}C${RESET}) Cron schedules       ${DIM}(toggle daily backup + weekly VACUUM)${RESET}"
        echo -e "  ${GREEN}L${RESET}) View logs            ${DIM}(tail -n 50 | less)${RESET}"
        echo ""
        echo -e "${DIM}  ─── Danger Zone ──────────────────────────────────${RESET}"
        echo -e "  ${RED}DEL${RESET}) Reset database   ${DIM}(triple-confirm wipe)${RESET}"
        echo ""
        echo -e "  ${DIM}s) Edit saved settings  ($POOL_CONF)${RESET}"
        echo -e "  ${RED}0) Back${RESET} to mining services menu"
        echo ""
        echo -ne "${BOLD}Select: ${RESET}"
        read -r choice

        case "${choice,,}" in
            "")    continue ;;
            0)     pool_guided_setup "$net" ;;
            1)     pool_install "$net" ;;
            2)     pool_configure "$net" ;;
            3)     pool_deploy_web "$net" ;;
            4)     pool_setup_nginx "$net" ;;
            5)     pool_setup_admin "$net" ;;
            6)     pool_service_menu "$net" ;;
            7)     pool_show_status "$net" ;;
            b)     pool_backup "$net" ;;
            c)     pool_cron_schedules "$net" ;;
            l)     pool_view_logs "$net" ;;
            del)   pool_reset_db "$net" ;;
            s)     ${EDITOR:-nano} "$POOL_CONF" ;;
            back|q) break ;;
            *)     warn "Invalid option." ; sleep 1 ; continue ;;
        esac

        [[ "${choice,,}" != "l" && "${choice,,}" != "s" ]] && {
            echo ""
            echo "Press Enter to continue..."
            read -r
        }
    done
}

pool_web_interface() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  W) Pool Web Interface${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    local mn_status tn_status
    mn_status=$(_pool_menu_status_line mainnet)
    tn_status=$(_pool_menu_status_line testnet)

    echo -e "  ${GREEN}1${RESET}) Mainnet pool  ${DIM}(port $POOL_PORT_MAINNET / $POOL_SERVICE_MAINNET)${RESET}  $mn_status"
    echo -e "  ${GREEN}2${RESET}) Testnet pool  ${DIM}(port $POOL_PORT_TESTNET / $POOL_SERVICE_TESTNET)${RESET}  $tn_status"
    echo -e "  ${DIM}0) Cancel${RESET}"
    echo ""
    echo -ne "Select network [1/2/0]: "
    read -r net_choice

    case "$net_choice" in
        1) pool_menu mainnet ;;
        2) pool_menu testnet ;;
        0|"") return ;;
        *) warn "Invalid choice." ;;
    esac
}

# ═══════════════════════════════════════════════════════════════════════════════
# MENU
# ═══════════════════════════════════════════════════════════════════════════════

show_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  07) Grin Mining Services${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    show_compact_status

    echo -e "${DIM}  ─── Overview ────────────────────────────────────${RESET}"
    echo -e "  ${GREEN}A${RESET}) Node Status          ${DIM}(running nodes, tmux, binary)${RESET}"
    echo -e "  ${GREEN}H${RESET}) Mining Status        ${DIM}(ports, miners connected, toml)${RESET}"
    echo ""
    echo -e "${DIM}  ─── Mainnet Stratum (port $STRATUM_PORT_MAINNET) ────────────────${RESET}"
    echo -e "  ${GREEN}B${RESET}) Setup Stratum        ${DIM}(enable server, set wallet URL)${RESET}"
    echo -e "  ${GREEN}C${RESET}) Configure Stratum    ${DIM}(wallet URL, burn_reward, toggle)${RESET}"
    echo -e "  ${GREEN}D${RESET}) Publish Stratum      ${DIM}(0.0.0.0:$STRATUM_PORT_MAINNET — open to miners)${RESET}"
    echo -e "  ${RED}E${RESET}) Restrict Stratum     ${DIM}(revert to 127.0.0.1:$STRATUM_PORT_MAINNET)${RESET}"
    echo ""
    echo -e "${DIM}  ─── Testnet Stratum (port $STRATUM_PORT_TESTNET) ───────────────${RESET}"
    echo -e "  ${GREEN}F${RESET}) Setup Stratum        ${DIM}(enable server, set wallet URL)${RESET}"
    echo -e "  ${GREEN}G${RESET}) Configure Stratum    ${DIM}(wallet URL, burn_reward, toggle)${RESET}"
    echo -e "  ${GREEN}I${RESET}) Publish Stratum      ${DIM}(0.0.0.0:$STRATUM_PORT_TESTNET — open to miners)${RESET}"
    echo -e "  ${RED}J${RESET}) Restrict Stratum     ${DIM}(revert to 127.0.0.1:$STRATUM_PORT_TESTNET)${RESET}"
    echo ""
    echo -e "${DIM}  ─── Pool Web Interface ──────────────────────────${RESET}"
    echo -e "  ${GREEN}W${RESET}) Pool Web Interface   ${DIM}(FastAPI — mainnet :3002 / testnet :3003)${RESET}"
    echo ""
    echo -e "  ${DIM}↩  Press Enter to refresh${RESET}"
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -ne "${BOLD}Select [A-J/W/0]: ${RESET}"
}

main() {
    while true; do
        show_menu
        read -r choice

        case "${choice,,}" in
            "")  continue ;;
            a)   show_node_status ;;
            # Mainnet stratum
            b)   setup_stratum_mainnet ;;
            c)   configure_stratum_mainnet ;;
            d)   publish_mainnet_stratum ;;
            e)   restrict_mainnet_stratum ;;
            # Testnet stratum
            f)   setup_stratum_testnet ;;
            g)   configure_stratum_testnet ;;
            i)   publish_testnet_stratum ;;
            j)   restrict_testnet_stratum ;;
            # Status
            h)   show_mining_status ;;
            # Pool
            w)   pool_web_interface ;;
            0)   break ;;
            *)   warn "Invalid option." ; sleep 1 ; continue ;;
        esac

        echo ""
        echo "Press Enter to continue..."
        read -r
    done
}

main "$@"
