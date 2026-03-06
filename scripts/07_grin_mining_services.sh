#!/bin/bash
# =============================================================================
# 07_grin_mining_services.sh - Grin Mining Services
# =============================================================================
# Manages the Stratum Mining server for Grin nodes:
#   · A) Node Status      (running nodes, tmux sessions, binary path)
#   · B) Setup Stratum    (enable_stratum_server, wallet_listener_url)
#   · C) Configure Stratum (wallet URL, burn_reward, toggle enable)
#   · D) Publish Stratum  — Mainnet (patch toml → 0.0.0.0:3416 + firewall)
#   · E) Restrict Stratum — Mainnet (revert to 127.0.0.1:3416)
#   · F) Publish Stratum  — Testnet (patch toml → 0.0.0.0:13416 + firewall)
#   · G) Restrict Stratum — Testnet (revert to 127.0.0.1:13416)
#   · H) Mining Status    (ports, connected miners, toml values)
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
LOG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/log"
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

# ═══════════════════════════════════════════════════════════════════════════════
# TOML DETECTION — locate grin-server.toml for the given network
# ═══════════════════════════════════════════════════════════════════════════════
# Primary: resolve via /proc/$pid/exe of the running grin process on api_port.
# Fallback: scan known toolkit dirs (/grin<mode><net>/) and ~/.grin/<net>/.
# Sets global FOUND_GRIN_TOML on success; returns 1 on failure.
# ═══════════════════════════════════════════════════════════════════════════════

_KNOWN_TOML_SEARCH_PATHS=(
    /grinfullmain    /grinprunemain
    /grinfulltest    /grinprunetest
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

    # Use the original session name if found; otherwise use script 01's convention.
    local session_name="${target_session:-grin_$(basename "$grin_dir")}"

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
# B) SETUP STRATUM
# ═══════════════════════════════════════════════════════════════════════════════

setup_stratum() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  B) Setup Stratum Server${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Enables the stratum server in grin-server.toml and sets the"
    echo -e "  wallet listener URL for coinbase block rewards."
    echo -e "  Use ${BOLD}D${RESET} / ${BOLD}F${RESET} to publish (open to miners) after setup."
    echo ""

    echo -e "  ${BOLD}Choose network:${RESET}"
    echo -e "  ${GREEN}1${RESET}) Mainnet"
    echo -e "  ${GREEN}2${RESET}) Testnet"
    echo -e "  ${DIM}0) Cancel${RESET}"
    echo -ne "Network [1]: "
    read -r net_choice
    [[ "$net_choice" == "0" ]] && return

    local network stratum_port api_port
    case "${net_choice:-1}" in
        2) network=testnet; stratum_port=$STRATUM_PORT_TESTNET; api_port=$NODE_API_PORT_TESTNET ;;
        *) network=mainnet; stratum_port=$STRATUM_PORT_MAINNET; api_port=$NODE_API_PORT_MAINNET ;;
    esac

    find_grin_server_toml "$network" "$api_port" || return
    local grin_toml="$FOUND_GRIN_TOML"
    echo ""

    # Show current stratum settings
    echo -e "${BOLD}Current stratum settings in:${RESET} $grin_toml"
    local cur_enable cur_wallet cur_burn
    cur_enable=$(grep -E '^[[:space:]]*enable_stratum_server[[:space:]]*=' "$grin_toml" 2>/dev/null | head -1 || true)
    cur_wallet=$(grep -E '^[[:space:]]*wallet_listener_url[[:space:]]*=' "$grin_toml" 2>/dev/null | head -1 || true)
    cur_burn=$(grep -E '^[[:space:]]*burn_reward[[:space:]]*=' "$grin_toml" 2>/dev/null | head -1 || true)
    echo -e "  enable_stratum_server : ${cur_enable:-${DIM}(not set)${RESET}}"
    echo -e "  wallet_listener_url   : ${cur_wallet:-${DIM}(not set)${RESET}}"
    echo -e "  burn_reward           : ${cur_burn:-${DIM}(not set)${RESET}}"
    echo ""

    # Enable stratum
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
        log "Setup: enable_stratum_server = true in $grin_toml"
    fi

    # Wallet listener URL
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
        log "Setup: wallet_listener_url = $new_url in $grin_toml"
    fi

    # burn_reward
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
        log "Setup: burn_reward = false in $grin_toml"
    fi

    echo ""
    success "Stratum setup complete for $network."
    echo ""
    info "Stratum is configured but bound to localhost by default."
    echo -e "  Use ${BOLD}D${RESET} (Mainnet) or ${BOLD}F${RESET} (Testnet) to publish and open to miners."
    echo -e "  Restart the grin node to apply changes."
    info "Log file: $LOG_FILE"
}

# ═══════════════════════════════════════════════════════════════════════════════
# C) CONFIGURE STRATUM
# ═══════════════════════════════════════════════════════════════════════════════

configure_stratum() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  C) Configure Stratum${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    echo -e "  ${BOLD}Choose network:${RESET}"
    echo -e "  ${GREEN}1${RESET}) Mainnet"
    echo -e "  ${GREEN}2${RESET}) Testnet"
    echo -e "  ${DIM}0) Cancel${RESET}"
    echo -ne "Network [1]: "
    read -r net_choice
    [[ "$net_choice" == "0" ]] && return

    local network stratum_port api_port
    case "${net_choice:-1}" in
        2) network=testnet; stratum_port=$STRATUM_PORT_TESTNET; api_port=$NODE_API_PORT_TESTNET ;;
        *) network=mainnet; stratum_port=$STRATUM_PORT_MAINNET; api_port=$NODE_API_PORT_MAINNET ;;
    esac

    find_grin_server_toml "$network" "$api_port" || return
    local grin_toml="$FOUND_GRIN_TOML"
    echo ""

    # Show current settings
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
            log "Configure: enable_stratum_server = $new_val in $grin_toml"
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
            log "Configure: stratum_server_addr = $new_addr in $grin_toml"
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
            log "Configure: wallet_listener_url = $new_wallet in $grin_toml"
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
            log "Configure: burn_reward = $new_burn in $grin_toml"
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

publish_mainnet_stratum()  { _enable_stratum  mainnet "$STRATUM_PORT_MAINNET" "$NODE_API_PORT_MAINNET"; }
restrict_mainnet_stratum() { _disable_stratum mainnet "$STRATUM_PORT_MAINNET" "$NODE_API_PORT_MAINNET"; }
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
# MENU
# ═══════════════════════════════════════════════════════════════════════════════

show_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  07) Grin Mining Services${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    show_compact_status

    echo -e "${DIM}  ─── Status ──────────────────────────────────────${RESET}"
    echo -e "  ${GREEN}A${RESET}) Node Status          ${DIM}(running nodes, tmux, binary)${RESET}"
    echo ""
    echo -e "${DIM}  ─── Setup & Config ──────────────────────────────${RESET}"
    echo -e "  ${GREEN}B${RESET}) Setup Stratum        ${DIM}(enable server, set wallet URL)${RESET}"
    echo -e "  ${GREEN}C${RESET}) Configure Stratum    ${DIM}(wallet URL, burn_reward, toggle)${RESET}"
    echo ""
    echo -e "${DIM}  ─── Mainnet (port $STRATUM_PORT_MAINNET) ─────────────────────────${RESET}"
    echo -e "  ${GREEN}D${RESET}) Publish Stratum      ${DIM}(0.0.0.0:$STRATUM_PORT_MAINNET — open to miners)${RESET}"
    echo -e "  ${RED}E${RESET}) Restrict Stratum     ${DIM}(revert to localhost)${RESET}"
    echo ""
    echo -e "${DIM}  ─── Testnet (port $STRATUM_PORT_TESTNET) ────────────────────────${RESET}"
    echo -e "  ${GREEN}F${RESET}) Publish Stratum      ${DIM}(0.0.0.0:$STRATUM_PORT_TESTNET — open to miners)${RESET}"
    echo -e "  ${RED}G${RESET}) Restrict Stratum     ${DIM}(revert to localhost)${RESET}"
    echo ""
    echo -e "${DIM}  ─── Mining Status ───────────────────────────────${RESET}"
    echo -e "  ${GREEN}H${RESET}) Mining Status        ${DIM}(ports, miners connected, toml values)${RESET}"
    echo ""
    echo -e "  ${DIM}↩  Press Enter to refresh${RESET}"
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -ne "${BOLD}Select [A-H/0]: ${RESET}"
}

main() {
    while true; do
        show_menu
        read -r choice

        case "${choice,,}" in
            "")  continue ;;
            a)   show_node_status ;;
            b)   setup_stratum ;;
            c)   configure_stratum ;;
            d)   publish_mainnet_stratum ;;
            e)   restrict_mainnet_stratum ;;
            f)   publish_testnet_stratum ;;
            g)   restrict_testnet_stratum ;;
            h)   show_mining_status ;;
            0)   break ;;
            *)   warn "Invalid option." ; sleep 1 ; continue ;;
        esac

        echo ""
        echo "Press Enter to continue..."
        read -r
    done
}

main "$@"
