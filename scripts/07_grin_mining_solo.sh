#!/bin/bash
# =============================================================================
# 07_grin_mining_solo.sh — Grin Solo Private Mining Setup
# =============================================================================
# Configure and manage solo mining on a Grin node.
# Enables the node's built-in stratum server, sets your wallet reward address,
# and publishes the port so miners can connect directly.
#
# ─── Menu ─────────────────────────────────────────────────────────────────────
# Network-as-parent (mirrors 052 Grin Drop): the top screen picks a network ONCE,
# then every per-action prompt inside that branch is gone — SOLO_NETWORK is set
# and inherited. Cross-network tools (both-net status, the unified stats page,
# global watchdogs) live on the network-select screen, not inside a branch.
# All-numeric keys; letters are reserved for destructive/admin actions.
#
#   Network-select screen
#     1) Configure solo private pool Mainnet ┐ enter the per-net branch below
#     2) Configure solo private pool Testnet ┘
#     3) Deploy stats web page          (public dashboard, both networks)
#     4) Node, Wallet & Mining Status   (both networks)
#     5) Watchdogs (global)             (node-sync · boot autostart · wallet · stratum)
#     6) Maintenance                    (encrypted backup · restore · schedule · seed · C=cleanup)
#     0) Back to main menu
#
#   Per-net branch (after 1/2 — SOLO_NETWORK set)
#     1) Wallet      ▸ setup/recover · listener · auto-restart · address
#     2) Stratum     ▸ setup · configure · publish · restrict
#     3) Terminal Stats  (live dashboard for the chosen net)
#     0) Back to network select
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
STATS_SHOT_SRC="$TOOLKIT_ROOT/web/07_mining_pool_solo/pool-config-example.png"
STATS_LOGO_SRC="$TOOLKIT_ROOT/web/0z0_media/logo_favi/grin_gold.svg"
STATS_BASENAME="grin-solo-mining-stat"

# Mining stats collector (parses node log → rolling JSON: found blocks +
# per-miner hashrate + miningpoolstats-pollable poolstats).
BLOCK_COLLECTOR_SRC="$TOOLKIT_ROOT/scripts/lib/07_mining_block_collector.py"
BLOCK_COLLECTOR_BIN="/usr/local/bin/grin-solo-mining-collector.py"
BLOCK_COLLECTOR_WRAPPER="/usr/local/bin/grin-solo-mining-collector"
BLOCK_COLLECTOR_CRON="/etc/cron.d/grin-solo-mining-collector"
BLOCK_COLLECTOR_STATE_DIR="/opt/grin/solo-stats"
# Payout-split payment calc (mainnet): nickname grouping (text before first dot)
# only, never addresses. The collector reads this to emit split_main.json.
PAYMENT_CONFIG="/opt/grin/conf/grin_solo_payment.json"
# Optional index & setup pages access lock (HTTP Basic Auth over the certbot-managed HTTPS).
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
# Encrypted backup/restore/schedule (depends on SW_BASE/SW_STATE_DIR from the
# wallet lib + PAYMENT_CONFIG above — sourced after them so those are set).
# shellcheck source=lib/07_solo_backup.sh
source "$SCRIPT_DIR/lib/07_solo_backup.sh"

# ═══════════════════════════════════════════════════════════════════════════════
# TOML DETECTION
# ═══════════════════════════════════════════════════════════════════════════════

_KNOWN_TOML_SEARCH_PATHS=(
    /opt/grin/node/mainnet-full   /opt/grin/node/mainnet-prune
    /opt/grin/node/testnet-prune
    "${HOME}/.grin/main"   "${HOME}/.grin/test"
    /root/.grin/main       /root/.grin/test
)

# Echo the grin-server.toml beside the RUNNING node's binary (via /proc/<pid>/exe),
# or rc 1 if the node isn't listening / has no toml next to its binary.
#   $1 = node API port
_toml_from_running_node() {
    local api_port="$1" pid exe dir
    pid=$(ss -tlnp 2>/dev/null | grep ":$api_port " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
    [[ -n "$pid" ]] || return 1
    exe=$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)
    [[ -n "$exe" ]] || return 1
    dir=$(dirname "$exe")
    [[ -f "$dir/grin-server.toml" ]] && { echo "$dir/grin-server.toml"; return 0; }
    return 1
}

# Echo every grin-server.toml under the known search dirs whose chain_type matches.
#   $1 = expected chain type (Mainnet|Testnet)   →   zero or more paths, one per line
_toml_search_candidates() {
    local expected_chain_type="$1" dir f
    for dir in "${_KNOWN_TOML_SEARCH_PATHS[@]}"; do
        f="$dir/grin-server.toml"
        [[ -f "$f" ]] || continue
        grep -qiE "chain_type\s*=\s*[\"']?$expected_chain_type" "$f" 2>/dev/null \
            && echo "$f"
    done
}

# Silent resolver (no prompts): running node wins, else the first matching search
# path. Echoes the toml path; rc 1 if none. Used by the status views.
_resolve_stratum_toml() {
    local network="$1" api_port="$2"
    local expected_chain_type="Mainnet"
    [[ "$network" == "testnet" ]] && expected_chain_type="Testnet"

    local f
    f=$(_toml_from_running_node "$api_port") && { echo "$f"; return 0; }
    # First matching candidate. Deterministic read loop instead of `| head -1`,
    # which under pipefail+set -e can abort on a SIGPIPE'd producer.
    while IFS= read -r f; do
        [[ -n "$f" ]] && { echo "$f"; return 0; }
    done < <(_toml_search_candidates "$expected_chain_type")
    return 1
}

# Interactive resolver: sets global FOUND_GRIN_TOML. Running node wins outright;
# otherwise 1 match auto-selects, >1 prompts, 0 asks for a manual path.
find_grin_server_toml() {
    local network="$1" api_port="$2"
    local expected_chain_type="Mainnet"
    [[ "$network" == "testnet" ]] && expected_chain_type="Testnet"

    FOUND_GRIN_TOML=""

    local f
    if f=$(_toml_from_running_node "$api_port"); then
        FOUND_GRIN_TOML="$f"
        info "Config detected (via running process): $FOUND_GRIN_TOML"
        return 0
    fi

    local candidates=() sel="" manual_path="" idx
    while IFS= read -r f; do
        [[ -n "$f" ]] && candidates+=("$f")
    done < <(_toml_search_candidates "$expected_chain_type")

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
        [[ "$sel" =~ ^[0-9]+$ ]] || { warn "Invalid selection."; return 1; }
        idx=$(( sel - 1 ))
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

# True if $1 is a private / non-internet-routable IPv4 (RFC1918, loopback,
# link-local, or CGNAT 100.64/10) — i.e. an address a remote miner can't dial.
_is_private_ipv4() {
    local ip="$1"
    [[ "$ip" =~ ^10\. ]]                                  && return 0
    [[ "$ip" =~ ^192\.168\. ]]                            && return 0
    [[ "$ip" =~ ^172\.(1[6-9]|2[0-9]|3[01])\. ]]          && return 0
    [[ "$ip" =~ ^127\. ]]                                 && return 0
    [[ "$ip" =~ ^169\.254\. ]]                            && return 0
    [[ "$ip" =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. ]] && return 0
    return 1
}

# First PUBLIC IPv4 bound locally (default-route source addr, then any other
# global-scope addr). rc 1 if the host has only private/NAT addresses.
_local_public_ipv4() {
    local ip; local candidates=()
    ip=$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[0-9.]+' | head -1 || true)
    [[ -n "$ip" ]] && candidates+=("$ip")
    while IFS= read -r ip; do
        [[ -n "$ip" ]] && candidates+=("$ip")
    done < <(ip -4 -o addr show scope global 2>/dev/null | grep -oP 'inet \K[0-9.]+' || true)
    # Guard empty-array expansion under `set -u` (bash < 4.4 errors otherwise).
    [[ ${#candidates[@]} -eq 0 ]] && return 1
    for ip in "${candidates[@]}"; do
        [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] && ! _is_private_ipv4 "$ip" \
            && { echo "$ip"; return 0; }
    done
    return 1
}

# External view: query up to 3 echo services and return the IP a MAJORITY agree
# on (first one if there's a tie), or rc 1 if none answered. The majority vote
# guards against a single service handing back a proxy/CDN address.
_external_public_ipv4() {
    local svc ip; local got=()
    for svc in "https://api.ipify.org" "https://ipv4.icanhazip.com" "https://ifconfig.me/ip"; do
        ip=$(curl -4 -sf --max-time 4 "$svc" 2>/dev/null | tr -d '[:space:]' || true)
        [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] && got+=("$ip")
    done
    [[ ${#got[@]} -eq 0 ]] && return 1
    printf '%s\n' "${got[@]}" | sort | uniq -c | sort -rn | awk 'NR==1{print $2}'
}

# Cross-checked PUBLIC IPv4 for the "point your miner here" message. Reconciles
# the locally-bound public IP against an external majority vote and reports BOTH
# results via globals (NOT stdout — the caller can't read a global set inside a
# `$(...)` subshell, so we set them directly here and the caller reads them):
#   $_DETECTED_PUBLIC_IP  the chosen IP ("" if none)
#   $_IP_DETECT_NOTE      a human confidence string:
#     · agree                 → verified (high confidence)
#     · only a private NIC    → behind NAT, trust the external value
#     · disagree (multi-homed / unusual SNAT) → prefer the NIC IP (it's what's
#       actually bound for inbound stratum) but surface BOTH so ops can confirm
#     · external only          → no public NIC addr but a service answered
# Returns 0 if an IP was determined, rc 1 otherwise. IPv6 added later.
_DETECTED_PUBLIC_IP=""
_IP_DETECT_NOTE=""
_detect_public_ipv4() {
    _DETECTED_PUBLIC_IP=""
    _IP_DETECT_NOTE=""
    local local_ip ext_ip
    local_ip=$(_local_public_ipv4 || true)
    ext_ip=$(_external_public_ipv4 || true)

    if [[ -n "$local_ip" && -n "$ext_ip" ]]; then
        if [[ "$local_ip" == "$ext_ip" ]]; then
            _IP_DETECT_NOTE="verified — local NIC and external check agree"
        else
            _IP_DETECT_NOTE="NIC=$local_ip differs from external=$ext_ip (multi-homed/NAT?) — using the NIC IP; confirm which one miners can actually reach"
        fi
        _DETECTED_PUBLIC_IP="$local_ip"; return 0
    elif [[ -n "$ext_ip" ]]; then
        _IP_DETECT_NOTE="behind NAT — external check reports this; the NIC only has a private address"
        _DETECTED_PUBLIC_IP="$ext_ip"; return 0
    elif [[ -n "$local_ip" ]]; then
        _IP_DETECT_NOTE="local NIC only — could not reach an external service to confirm"
        _DETECTED_PUBLIC_IP="$local_ip"; return 0
    fi
    return 1
}

# Interactive confirm/override of the public IPv4 advertised to miners on the setup
# page. Detection (_detect_public_ipv4) already cross-checks the local NIC against an
# external 3-service majority vote (ipify / icanhazip / ifconfig.me); this surfaces
# that result + its confidence note and lets the operator accept it, type a correction,
# or clear it (page then falls back to the domain). The chosen IP is echoed on STDOUT;
# all prompts/notes go to STDERR so `$(...)` capture stays clean. Empty = no IP.
_confirm_public_ipv4() {
    local fallback="$1"   # IP already in config.json, offered if live detection fails
    _detect_public_ipv4 || true
    local detected="${_DETECTED_PUBLIC_IP:-$fallback}"

    echo >&2
    if [[ -n "$_DETECTED_PUBLIC_IP" ]]; then
        echo -e "  ${BOLD}Public IP check${RESET} — detected ${BOLD}${_DETECTED_PUBLIC_IP}${RESET}" >&2
        echo -e "  ${DIM}${_IP_DETECT_NOTE}${RESET}" >&2
    elif [[ -n "$fallback" ]]; then
        echo -e "  ${BOLD}Public IP check${RESET} — ${YELLOW}auto-detect failed${RESET}; keeping saved value ${BOLD}${fallback}${RESET}" >&2
    else
        echo -e "  ${BOLD}Public IP check${RESET} — ${YELLOW}could not detect a public IPv4 and none is saved.${RESET}" >&2
    fi
    echo -e "  ${DIM}Miners connect to this IP + stratum port over raw TCP, so it must be the" >&2
    echo -e "  internet-reachable address — not a private/NAT one.${RESET}" >&2

    while true; do
        if [[ -n "$detected" ]]; then
            echo -ne "  Public IP for miners [${detected}] (Enter=accept · type to override · '-' to clear): " >&2
        else
            echo -ne "  Public IP for miners (type the IP, Enter to skip): " >&2
        fi
        local ans; read -r ans
        if [[ -z "$ans" ]]; then
            printf '%s' "$detected"; return 0
        elif [[ "$ans" == "-" ]]; then
            printf ''; return 0
        elif [[ "$ans" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
            if _is_private_ipv4 "$ans"; then
                echo -ne "  ${YELLOW}$ans is private/NAT — miners on the internet can't reach it. Use anyway? [y/N]: ${RESET}" >&2
                local c; read -r c
                [[ "$c" =~ ^[Yy]$ ]] && { printf '%s' "$ans"; return 0; }
            else
                printf '%s' "$ans"; return 0
            fi
        else
            echo -e "  ${RED}Not a valid IPv4 — try again.${RESET}" >&2
        fi
    done
}

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

    # Node line first — cheap ss-only RUNNING/OFF (no API calls, so the menu
    # never stalls on an unreachable node). Sync state is intentionally NOT here;
    # it needs an Owner-API call and lives behind menu A) Start here.
    echo -e "${BOLD}  Node Status:${RESET}"
    if ss -tlnp 2>/dev/null | grep -q ":$NODE_API_PORT_MAINNET "; then
        echo -e "    Mainnet ($NODE_API_PORT_MAINNET): ${GREEN}RUNNING${RESET}"
    else
        echo -e "    Mainnet ($NODE_API_PORT_MAINNET): ${RED}OFF${RESET}     ${DIM}(build/sync in Script 01)${RESET}"
    fi
    if ss -tlnp 2>/dev/null | grep -q ":$NODE_API_PORT_TESTNET "; then
        echo -e "    Testnet ($NODE_API_PORT_TESTNET): ${GREEN}RUNNING${RESET}"
    else
        echo -e "    Testnet ($NODE_API_PORT_TESTNET): ${RED}OFF${RESET}     ${DIM}(build/sync in Script 01)${RESET}"
    fi
    echo ""

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
# NODE, WALLET & MINING STATUS  (network-select ▸ 4)
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

    # Coinbase wallet Foreign listener — where the node sends block rewards.
    # Shown before Stratum: a solo miner's first question is "is my reward
    # listener up?", so the screen reads node → wallet → mining top to bottom.
    local wal_port wal_pid wal_toml wal_tmux
    wal_port=$(sw_foreign_port "$network")
    wal_pid=$(ss -tlnp 2>/dev/null | grep ":$wal_port " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
    wal_toml=$(sw_toml "$network" 2>/dev/null || true)
    if [[ -n "$wal_pid" ]]; then
        echo -e "    Wallet : ${GREEN}LISTENING${RESET}  ${DIM}(PID $wal_pid, Foreign port $wal_port)${RESET}"
        wal_tmux=$(sw_tmux_name "$network" 2>/dev/null || true)
        if [[ -n "$wal_tmux" ]] && tmux has-session -t "$wal_tmux" 2>/dev/null; then
            echo -e "    Wtmux  : ${GREEN}$wal_tmux${RESET}  ${DIM}(attach: tmux attach -t $wal_tmux)${RESET}"
        fi
    elif [[ -n "$wal_toml" && -f "$wal_toml" ]]; then
        echo -e "    Wallet : ${RED}NOT RUNNING${RESET}  ${DIM}(configured, Foreign port $wal_port not listening)${RESET}"
    else
        echo -e "    Wallet : ${DIM}not configured${RESET}  ${DIM}(Foreign port $wal_port)${RESET}"
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
    echo -e "${BOLD}${CYAN}  Node, Wallet & Mining Status${RESET}  ${DIM}(both networks)${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    _show_node_info mainnet "$NODE_API_PORT_MAINNET" "$STRATUM_PORT_MAINNET"
    _show_node_info testnet "$NODE_API_PORT_TESTNET" "$STRATUM_PORT_TESTNET"
}

# ═══════════════════════════════════════════════════════════════════════════════
# START HERE — NODE PRE-CHECK  (menu ▸ A)
# ═══════════════════════════════════════════════════════════════════════════════
# A beginner's "step 0": solo mining needs a fully synced node on THIS server.
# Read-only — reports node running + sync state per network and points at Script
# 01 when no node exists yet. Sync uses one Owner-API call per net; this only
# runs when the user opens A), so the 8s-timeout curl never blocks the top menu.

# Script 01 launches in-process (mirrors Script 05's run_sub) so the user can
# build/sync a node without backing out to the main menu. It lives in the scripts
# dir = SCRIPT_DIR.
_SOLO_SCRIPT01="01_build_new_grin_node.sh"

# _precheck_one_net <network> <api_port> <role: primary|optional>
# Mainnet is the primary node (real mining needs it); testnet is optional — a
# user can run one here to practice mining safely or help the test network, even
# without mining it (testnet GRIN has no monetary value).
_precheck_one_net() {
    local network="$1" api_port="$2" role="${3:-primary}"
    local label="Mainnet"; [[ "$network" == "testnet" ]] && label="Testnet"
    echo -e "  ${BOLD}$label:${RESET}"

    if ! ss -tlnp 2>/dev/null | grep -q ":$api_port "; then
        echo -e "    Node : ${RED}NOT RUNNING${RESET}  ${DIM}(API port $api_port not listening)${RESET}"
        if [[ "$role" == "primary" ]]; then
            echo -e "    ${YELLOW}→ Real mining needs this. Build & sync a mainnet node (Script 01) first.${RESET}"
        else
            echo -e "    ${CYAN}○ Spin one up here too!${RESET}  ${DIM}This server already has the resources —${RESET}"
            echo -e "    ${DIM}  a testnet node grows the test network and lets you practice mining${RESET}"
            echo -e "    ${DIM}  risk-free (testnet GRIN has no value) — Script 01 can build it.${RESET}"
        fi
        echo ""
        return
    fi
    echo -e "    Node : ${GREEN}RUNNING${RESET}  ${DIM}(API port $api_port)${RESET}"

    local json sync height peers
    json=$(gnc_owner_get_status "$network" 6 2>/dev/null || true)
    if [[ -z "$json" ]]; then
        echo -e "    Sync : ${YELLOW}unknown${RESET}  ${DIM}(node up but Owner API didn't answer — check .api_secret)${RESET}"
        echo ""
        return
    fi
    sync=$(gnc_status_field "$json" sync_status 2>/dev/null || true)
    height=$(gnc_status_field "$json" tip.height 2>/dev/null || true)
    peers=$(gnc_status_field "$json" connections 2>/dev/null || true)
    if [[ "$sync" == "no_sync" ]]; then
        echo -e "    Sync : ${GREEN}SYNCED${RESET}  ${DIM}(height ${height:-?}, peers ${peers:-?})${RESET}"
        if [[ "$role" == "primary" ]]; then
            echo -e "    ${GREEN}✓ Ready to mine.${RESET}"
        else
            echo -e "    ${GREEN}✓ Synced — thanks for strengthening the test network!${RESET}  ${DIM}Great for practice too.${RESET}"
        fi
    else
        echo -e "    Sync : ${YELLOW}${sync:-syncing}${RESET}  ${DIM}(height ${height:-?}, peers ${peers:-?})${RESET}"
        echo -e "    ${YELLOW}⏳ Still syncing — wait until SYNCED (coinbase from an unsynced node is invalid).${RESET}"
    fi
    echo ""
}

# _precheck_next_action → echoes the single most useful "Next" action as
# "<net>:<start|build>", or nothing when both nodes are already running.
# Mainnet has priority (real mining needs it); testnet is only offered once
# mainnet is up. "start" only when the node is INSTALLED (conf + binary) so
# gnc_start_node_tmux will actually work; otherwise "build" (route to Script 01).
# Cheap: ss + a conf-file read, no API calls.
_precheck_next_action() {
    local net api_port dir
    for net in mainnet testnet; do
        [[ "$net" == "mainnet" ]] && api_port="$NODE_API_PORT_MAINNET" || api_port="$NODE_API_PORT_TESTNET"
        ss -tlnp 2>/dev/null | grep -q ":$api_port " && continue   # running → skip
        if dir=$(gnc_resolve_node_dir "$net" 2>/dev/null) && gnc_node_binary "$dir" >/dev/null 2>&1; then
            echo "$net:start"
        else
            echo "$net:build"
        fi
        return 0
    done
    return 0   # both running → empty
}

solo_node_precheck() {
    local choice nextact net act s
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  A) Start Here — Node Check${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  Solo mining needs a ${BOLD}fully synced mainnet node on this server${RESET}."
        echo -e "  This screen only checks — it changes nothing."
        echo ""
        _precheck_one_net mainnet "$NODE_API_PORT_MAINNET" primary
        _precheck_one_net testnet "$NODE_API_PORT_TESTNET" optional

        echo -e "  ${BOLD}Once mainnet is SYNCED, set up mining in this order:${RESET}"
        echo -e "    · Pick the network    ${DIM}(1 Mainnet / 2 Testnet)${RESET}"
        echo -e "    · Wallet              ${DIM}set up the coinbase listener — back up your seed!${RESET}"
        echo -e "    · Stratum             ${DIM}Setup, then Publish to open it to miners${RESET}"
        echo -e "    · Point your miner    ${DIM}stratum+tcp://YOUR_SERVER_IP:<port>${RESET}"
        echo ""

        nextact=$(_precheck_next_action)
        net="${nextact%%:*}"; act="${nextact##*:}"
        if [[ -n "$nextact" ]]; then
            echo -e "  ${DIM}─── Next ─────────────────────────────────────────${RESET}"
            if [[ "$act" == "start" && "$net" == "mainnet" ]]; then
                echo -e "  ${GREEN}1${RESET}) Start your mainnet node now   ${DIM}(installed but stopped)${RESET}"
            elif [[ "$act" == "start" && "$net" == "testnet" ]]; then
                echo -e "  ${GREEN}1${RESET}) Start your testnet node now   ${DIM}(installed but stopped)${RESET}"
            elif [[ "$net" == "mainnet" ]]; then
                echo -e "  ${GREEN}1${RESET}) Build a Grin node now         ${DIM}(opens Script 01)${RESET}"
            else
                echo -e "  ${GREEN}1${RESET}) Build a testnet node          ${DIM}(opens Script 01 — run in parallel, no mining, to support the test network)${RESET}"
            fi
            echo -e "  ${DIM}↩  Enter to re-check · 0 to return${RESET}"
            echo ""
            echo -ne "${BOLD}Select [1/Enter/0]: ${RESET}"
        else
            echo -e "  ${GREEN}✓ Both nodes are running.${RESET}"
            echo -e "  ${DIM}↩  Enter to re-check · 0 to return${RESET}"
            echo ""
            echo -ne "${BOLD}Select [Enter/0]: ${RESET}"
        fi

        read -r choice || choice=0
        case "$choice" in
            1)  [[ -z "$nextact" ]] && continue          # both up → no action bound to 1
                if [[ "$act" == "start" ]]; then
                    gnc_start_node_tmux "$net" 60 || true
                    _solo_pause
                else
                    s="$SCRIPT_DIR/$_SOLO_SCRIPT01"
                    if [[ -f "$s" ]]; then
                        bash "$s" || true                # returns here when the user exits Script 01
                    else
                        error "Script 01 not found: $s"; _solo_pause
                    fi
                fi ;;
            0)  return ;;
            "") continue ;;                              # Enter → re-check (loop redraws fresh status)
            *)  : ;;                                     # ignore stray input → redraw
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# SETUP STRATUM  (per-net branch ▸ Stratum ▸ 1)
# ═══════════════════════════════════════════════════════════════════════════════

_do_setup_stratum() {
    local network="$1" stratum_port="$2" api_port="$3"
    local label="Mainnet"
    [[ "$network" == "testnet" ]] && label="Testnet"

    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Setup Stratum Server — $label (port $stratum_port)${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Enables the stratum server in grin-server.toml and sets the"
    echo -e "  wallet listener URL for coinbase block rewards."
    echo -e "  Use ${BOLD}Stratum ▸ 3) Publish${RESET} to open it to miners after setup."
    echo ""

    find_grin_server_toml "$network" "$api_port" || return
    local grin_toml="$FOUND_GRIN_TOML"
    echo ""

    echo -e "${BOLD}Current stratum settings in:${RESET} $grin_toml"
    local cur_enable cur_wallet
    cur_enable=$(grep -E '^[[:space:]]*enable_stratum_server[[:space:]]*=' "$grin_toml" 2>/dev/null | head -1 || true)
    cur_wallet=$(grep -E '^[[:space:]]*wallet_listener_url[[:space:]]*=' "$grin_toml" 2>/dev/null | head -1 || true)
    echo -e "  enable_stratum_server : ${cur_enable:-${DIM}(not set)${RESET}}"
    echo -e "  wallet_listener_url   : ${cur_wallet:-${DIM}(not set)${RESET}}"
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

    # burn_reward — always force the safe default (keep rewards). This is a
    # testing-only flag that discards coinbase; we never prompt for it so a
    # solo miner can't accidentally burn real block rewards. A tester who
    # genuinely wants to burn can set it by hand in grin-server.toml.
    if grep -qE '^#?[[:space:]]*burn_reward[[:space:]]*=' "$grin_toml" 2>/dev/null; then
        sed -i -E \
            "s|^#?[[:space:]]*burn_reward[[:space:]]*=.*|burn_reward = false|" \
            "$grin_toml"
    else
        echo "burn_reward = false" >> "$grin_toml"
    fi
    log "Setup ($network): burn_reward = false (forced) in $grin_toml"

    echo ""
    success "Stratum setup complete for $network."
    echo ""
    info "Stratum is configured but bound to localhost by default."
    echo -e "  Use ${BOLD}Stratum ▸ 3) Publish${RESET} to open it to miners."
    echo -e "  Restart the grin node to apply changes."
}

setup_stratum_mainnet() { _do_setup_stratum mainnet "$STRATUM_PORT_MAINNET" "$NODE_API_PORT_MAINNET"; }
setup_stratum_testnet() { _do_setup_stratum testnet "$STRATUM_PORT_TESTNET" "$NODE_API_PORT_TESTNET"; }

# ═══════════════════════════════════════════════════════════════════════════════
# CONFIGURE STRATUM  (per-net branch ▸ Stratum ▸ 2)
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
    local cur_enable cur_addr cur_wallet
    cur_enable=$(grep -E '^[[:space:]]*enable_stratum_server[[:space:]]*=' "$grin_toml" 2>/dev/null | head -1 | sed 's/.*=[[:space:]]*//' | xargs || true)
    cur_addr=$(grep -E '^[[:space:]]*stratum_server_addr[[:space:]]*=' "$grin_toml" 2>/dev/null | head -1 | sed 's/.*=[[:space:]]*//' | tr -d '"' | xargs || true)
    cur_wallet=$(grep -E '^[[:space:]]*wallet_listener_url[[:space:]]*=' "$grin_toml" 2>/dev/null | head -1 | sed 's/.*=[[:space:]]*//' | tr -d '"' | xargs || true)
    echo -e "  ${GREEN}1${RESET}) enable_stratum_server : ${cur_enable:-${DIM}not set${RESET}}"
    echo -e "  ${GREEN}2${RESET}) stratum_server_addr   : ${cur_addr:-${DIM}not set${RESET}}"
    echo -e "  ${GREEN}3${RESET}) wallet_listener_url   : ${cur_wallet:-${DIM}not set${RESET}}"
    echo -e "  ${DIM}0) Cancel${RESET}"
    echo ""
    echo -ne "Which setting to change [1-3/0]: "
    read -r cfg_choice
    [[ "$cfg_choice" == "0" || -z "$cfg_choice" ]] && return

    local changed=false
    case "$cfg_choice" in
        1)
            echo -ne "Set enable_stratum_server [true/false] (current: ${cur_enable:-not set}): "
            read -r new_val
            [[ -z "$new_val" ]] && return
            if [[ "$new_val" != "true" && "$new_val" != "false" ]]; then
                warn "Must be exactly 'true' or 'false' — not changed."; return
            fi
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
            if [[ ! "$new_addr" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]{1,5}$ ]]; then
                warn "Expected host:port like 0.0.0.0:$stratum_port — not changed."; return
            fi
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
    local label="Mainnet"
    [[ "$port" == "$STRATUM_PORT_TESTNET" ]] && label="Testnet"
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Publish Stratum — $label (port $port)${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Publishing binds grin to ${BOLD}0.0.0.0:$port${RESET} so your miners (or friends')"
    echo -e "  can reach this node. Point a miner (e.g. G1 mini) at your stratum"
    echo -e "  ${BOLD}domain${RESET} or ${BOLD}YOUR_SERVER_IP:$port${RESET}. Required for any remote mining."
    echo ""
    echo -ne "${BOLD}Proceed? [Y/n]: ${RESET}"
    read -r _guide_confirm || true
    [[ "${_guide_confirm,,}" == "n" ]] && { info "Cancelled."; return 1; }
    return 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# PUBLISH / RESTRICT STRATUM  (per-net branch ▸ Stratum ▸ 3 / 4)
# ═══════════════════════════════════════════════════════════════════════════════

# Post-publish connection watch. Manual-refresh (Enter = re-check · 0 = return) to
# match every other 07 screen — NOT a Ctrl-C trap. Reuses the same ss idiom as
# _show_node_info. A rig usually appears ~1 min after the pool config is saved and
# it reconnects, so this closes the loop at the moment the operator most wants to
# know "did it connect?".
#   $1 = stratum port   $2 = network label (Mainnet|Testnet)   $3 = miner URL
_solo_watch_for_miner() {
    local stratum_port="$1" label="$2" url="$3" n k
    while true; do
        n=$(ss -tnp 2>/dev/null | grep ":$stratum_port" | grep -c ESTAB || true)
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Waiting for a miner — $label (port $stratum_port)${RESET}  ${DIM}($(date -u '+%H:%M:%S UTC'))${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  ${BOLD}Miner Pool / Server:${RESET}  ${BOLD}${CYAN}$url${RESET}"
        echo ""
        if [[ "${n:-0}" -gt 0 ]]; then
            echo -e "  ${GREEN}✓ Miner connected!${RESET}  ${BOLD}$n${RESET} connection(s) on port $stratum_port"
            echo ""
            ss -tnp 2>/dev/null | grep ":$stratum_port" | grep ESTAB \
                | awk '{print $5}' | head -5 | sed 's/^/      from /' || true
        else
            echo -e "  ${YELLOW}No miner connected yet.${RESET}  ${DIM}(0 established on port $stratum_port)${RESET}"
            echo ""
            echo -e "  ${DIM}A rig usually appears ~1 min after you save the pool config above and${RESET}"
            echo -e "  ${DIM}it reconnects (the node must also have restarted after Publish). If${RESET}"
            echo -e "  ${DIM}nothing shows after a few minutes, double-check on the miner:${RESET}"
            echo -e "    ${DIM}· Pool/Server matches the URL above${RESET}"
            echo -e "    ${DIM}· that IP is internet-reachable (firewall open, not a private/NAT addr)${RESET}"
        fi
        echo ""
        echo -e "  ${DIM}↩  Enter to refresh status${RESET}"
        echo -e "  ${RED}0${RESET}) Return"
        echo ""
        echo -ne "${BOLD}Select [Enter/0]: ${RESET}"
        read -r k || k=0
        [[ "$k" == "0" ]] && return
    done
}

_enable_stratum() {
    local network="$1" stratum_port="$2" api_port="$3"

    _show_stratum_port_guide "$stratum_port" || return
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
            # Reject anything that is not a bare IPv4 or IPv4/CIDR before it
            # reaches ufw/iptables (a typo would otherwise write a broken rule).
            if [[ -n "$allowed_ip" && ! "$allowed_ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}(/[0-9]{1,2})?$ ]]; then
                warn "Not a valid IPv4 address or CIDR — skipping firewall rule."
                allowed_ip=""
            fi
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

    local label="Mainnet"; [[ "$network" == "testnet" ]] && label="Testnet"
    # Sets globals $_DETECTED_PUBLIC_IP + $_IP_DETECT_NOTE (can't return them via
    # $(...) — that subshell would discard the note global).
    _detect_public_ipv4 || true
    local pub_ip="$_DETECTED_PUBLIC_IP"
    local conn_host="${pub_ip:-YOUR_SERVER_IP}"
    local url="stratum+tcp://${conn_host}:${stratum_port}"

    echo ""
    echo -e "${BOLD}${GREEN}┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${RESET}"
    echo -e "${BOLD}${GREEN}┃${RESET}  ${BOLD}Put this in your miner's Pool / Server field ($label):${RESET}"
    echo -e "${BOLD}${GREEN}┃${RESET}"
    echo -e "${BOLD}${GREEN}┃${RESET}      ${BOLD}${CYAN}$url${RESET}"
    echo -e "${BOLD}${GREEN}┃${RESET}"
    echo -e "${BOLD}${GREEN}┃${RESET}  ${BOLD}Worker / Login:${RESET} any nickname you like — ${CYAN}e.g. myname.rig1${RESET}"
    echo -e "${BOLD}${GREEN}┃${RESET}  ${DIM}(text before the dot groups earnings if payout-split is on)${RESET}"
    echo -e "${BOLD}${GREEN}┃${RESET}"
    if [[ -n "$pub_ip" ]]; then
        echo -e "${BOLD}${GREEN}┃${RESET}  ${DIM}Detected public IPv4: $pub_ip · port $stratum_port ($label)${RESET}"
        [[ -n "$_IP_DETECT_NOTE" ]] && \
            echo -e "${BOLD}${GREEN}┃${RESET}  ${DIM}↳ $_IP_DETECT_NOTE${RESET}"
    else
        echo -e "${BOLD}${GREEN}┃${RESET}  ${YELLOW}Could not auto-detect public IP — replace YOUR_SERVER_IP above.${RESET}"
    fi
    echo -e "${BOLD}${GREEN}┃${RESET}  ${DIM}Using a domain instead? On Cloudflare the A record MUST be${RESET}"
    echo -e "${BOLD}${GREEN}┃${RESET}  ${DIM}\"DNS only\" (grey cloud), NOT proxied — miners can't reach a${RESET}"
    echo -e "${BOLD}${GREEN}┃${RESET}  ${DIM}proxied record; fall back to the raw IP above (e.g. iPollo G1).${RESET}"
    echo -e "${BOLD}${GREEN}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${RESET}"

    echo ""
    echo -ne "  ${BOLD}Watch for your first miner to connect?${RESET} ${DIM}[Y/n]${RESET}: "
    read -r _watch_choice || true
    [[ "${_watch_choice,,}" == "n" ]] || _solo_watch_for_miner "$stratum_port" "$label" "$url"
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
# TERMINAL STATS DASHBOARD  (per-net branch ▸ 3)
# ═══════════════════════════════════════════════════════════════════════════════
# Polls the node Owner API (get_status) on each manual refresh and shows height,
# difficulty, hashrate, peers, connected miners. Network hashrate is computed
# instantly from two block headers (Foreign API get_header) over a 60-block
# window: diff_delta × 42 / dt / 16384 (Cuckatoo32).

# Fetch a block header via the node Foreign API get_header. Echoes the raw JSON
# response (caller parses); empty on failure.
#   $1 = node API port  $2 = foreign secret  $3 = height
_solo_get_header() {
    curl -sf --max-time 5 -u "grin:$2" \
        -H 'Content-Type: application/json' \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"get_header\",\"params\":[$3,null,null],\"id\":1}" \
        "http://127.0.0.1:$1/v2/foreign" 2>/dev/null || true
}

# Network hashrate from two block headers, averaged over a window of blocks so a
# single odd block-time doesn't skew it. Echoes a formatted G/s string, or "n/a"
# if the headers can't be fetched (missing foreign secret, node down, genesis).
#   $1 = node API port  $2 = foreign secret  $3 = tip height  $4 = window blocks
_solo_network_hashrate() {
    local port="$1" fsecret="$2" tip="$3" window="${4:-60}"
    [[ -z "$fsecret" || ! "$tip" =~ ^[0-9]+$ ]] && { echo "n/a"; return; }
    local old=$(( tip - window ))
    (( old < 0 )) && old=0
    (( old == tip )) && { echo "n/a"; return; }

    local h_new h_old
    h_new=$(_solo_get_header "$port" "$fsecret" "$tip")
    h_old=$(_solo_get_header "$port" "$fsecret" "$old")
    [[ -z "$h_new" || -z "$h_old" ]] && { echo "n/a"; return; }

    python3 - "$h_new" "$h_old" << 'PY' 2>/dev/null || echo "n/a"
import sys, json
from datetime import datetime
def ep(s): return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
def hdr(j):
    d = json.loads(j)['result']['Ok']
    return int(d['total_difficulty']), ep(d['timestamp'])
try:
    td_n, ts_n = hdr(sys.argv[1])
    td_o, ts_o = hdr(sys.argv[2])
except Exception:
    print("n/a"); sys.exit()
dt = ts_n - ts_o
dd = td_n - td_o
if dt <= 0 or dd <= 0:
    print("n/a"); sys.exit()
gps = dd * 42 / dt / 16384
if gps >= 1_000_000:
    print(f"{gps/1_000_000:.2f} MG/s")
elif gps >= 1_000:
    print(f"{gps/1_000:.2f} kG/s")
else:
    print(f"{gps:.2f} G/s")
PY
}

solo_live_stats() {
    local preset_net="${1:-}"
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Terminal Mining Stats${RESET}  ${DIM}(Enter = refresh · 0 = return)${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    local net_choice
    if [[ -n "$preset_net" ]]; then
        # Network chosen by the parent branch — no prompt.
        net_choice=1; [[ "$preset_net" == "testnet" ]] && net_choice=2
    else
        echo -e "  ${GREEN}1${RESET}) Mainnet  ${GREEN}2${RESET}) Testnet"
        echo -ne "Select [1]: "
        read -r net_choice
    fi

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

    # Foreign API secret (same node dir) — used by get_header for the instant
    # network-hashrate calc below. Derived from the owner secret's dir, so a custom
    # owner path still finds its sibling foreign secret.
    local fsecret=""
    local foreign_secret_path="${secret_path%/.api_secret}/.foreign_api_secret"
    [[ -f "$foreign_secret_path" ]] && fsecret=$(cat "$foreign_secret_path")

    while true; do
        local resp
        resp=$(curl -sf --max-time 5 \
            -u "grin:${secret}" \
            -H 'Content-Type: application/json' \
            -d '{"jsonrpc":"2.0","method":"get_status","params":[],"id":1}' \
            "http://127.0.0.1:${api_port}/v2/owner" 2>/dev/null || true)

        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Grin Solo Mining — $net_label${RESET}  ${DIM}($(date -u '+%H:%M:%S UTC'))${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""

        if [[ -z "$resp" ]]; then
            echo -e "  ${RED}[ERROR]${RESET} Cannot reach node on port $api_port"
            echo -e "  ${DIM}Start the node and try again, or check the API secret.${RESET}"
        else
            local height total_diff peers
            height=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result']['Ok']['tip']['height'])" 2>/dev/null || echo "?")
            total_diff=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result']['Ok']['tip']['total_difficulty'])" 2>/dev/null || echo "0")
            peers=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result']['Ok']['connections'])" 2>/dev/null || echo "?")

            # Network hashrate — computed instantly from two block headers over a
            # 60-block window (Foreign API get_header), so it never sits on
            # "calculating...". Averaging the window smooths single odd block times.
            local hashrate_str
            hashrate_str=$(_solo_network_hashrate "$api_port" "$fsecret" "$height" 60)

            local miner_count
            miner_count=$(ss -tnp 2>/dev/null | grep ":$stratum_port" | grep -c ESTAB || true)

            echo -e "  ${BOLD}Height${RESET}     : $height"
            echo -e "  ${BOLD}Difficulty${RESET} : $total_diff"
            echo -e "  ${BOLD}Hashrate${RESET}   : ${GREEN}$hashrate_str${RESET}"
            echo -e "  ${BOLD}Peers${RESET}      : $peers"
            echo -e "  ${BOLD}Miners${RESET}     : ${miner_count:-0} connected  ${DIM}(port $stratum_port)${RESET}"
        fi

        echo ""
        echo -ne "  ${DIM}Press Enter to refresh · 0 to return: ${RESET}"
        local _k; read -r _k || _k=0
        [[ "$_k" == "0" ]] && break
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# STATS WEB PAGE  (network-select ▸ 3)
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
        limit_req zone=solo_stats_api burst=10 nodelay;
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
    # Normalise to the Foreign API endpoint. grin's native grin-server.toml stores
    # this as a BASE url (e.g. http://127.0.0.1:3415) with no path; an nginx
    # proxy_pass to a pathless url forwards the original request URI
    # (/api/wallet/<net>), which the wallet 404s → page shows "n/a". The Foreign
    # API the probe needs always lives at /v2/foreign, so append it when absent.
    url="${url:-http://127.0.0.1:${default_port}}"
    url="${url%/}"                                          # drop any trailing slash
    [[ "$url" != */v2/foreign ]] && url="$url/v2/foreign"
    echo "$url"
}

# Emit one nginx proxy location for a network's /api/wallet/<net> liveness probe.
#   $1 = net key (main|test)   $2 = wallet Foreign API URL
# No secret is injected: a 200 or 401 both prove the listener is up; only a
# connection error / 5xx (which nginx maps to 502) means it is down.
_solo_stats_wallet_location() {
    cat << EOF
    # Liveness probe → $1 wallet Foreign API (the listener the node builds coinbase from)
    location = /api/wallet/$1 {
        limit_req zone=solo_stats_api burst=10 nodelay;
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

# Toggle the mainnet payout-split calculation (on/off — no names to pre-define).
# When ON, the collector splits matured coinbase across miners grouped BY NICKNAME
# — the text before the first dot in nickname.NN, so all of one miner's rigs
# (alpha.01, alpha.02, …) settle as one payee. Writes $PAYMENT_CONFIG as
# {"enabled":true}. Display-only: solo mining always pays ONE coinbase wallet;
# this just shows who earned what for manual settling, and never stores a Grin
# address. Called from the Stats web page deploy (network-select ▸ 3, mainnet
# detected).
_solo_prompt_payout_split() {
    # Enabled = file present AND not explicitly disabled (mirrors payout_split_enabled).
    local enabled=0
    if [[ -f "$PAYMENT_CONFIG" ]] && python3 -c 'import json,sys
try: c=json.load(open(sys.argv[1]))
except Exception: sys.exit(1)
ok = isinstance(c,dict) and c.get("enabled") is not False
sys.exit(0 if ok else 1)' "$PAYMENT_CONFIG" 2>/dev/null; then
        enabled=1
    fi

    echo ""
    echo -e "${BOLD}Payout-split payment calculation (mainnet)${RESET}"
    echo -e "  ${DIM}Display-only split of matured coinbase across miners by work done,${RESET}"
    echo -e "  ${DIM}grouped automatically by nickname — the part of the worker name${RESET}"
    echo -e "  ${DIM}before the first dot (alpha.01, alpha.02 → alpha), nothing to${RESET}"
    echo -e "  ${DIM}pre-define. Solo mining always pays ONE coinbase wallet; this just${RESET}"
    echo -e "  ${DIM}shows who earned what so you can settle up manually, and stores no${RESET}"
    echo -e "  ${DIM}Grin addresses.${RESET}"

    local ans
    if [[ $enabled -eq 1 ]]; then
        echo -e "  Status: ${GREEN}currently ON${RESET}"
        echo -ne "  Keep payout split enabled? [Y/n]: "
        read -r ans
        if [[ "${ans,,}" == "n" ]]; then
            rm -f "$PAYMENT_CONFIG"
            success "Payout split disabled (config removed)."
        else
            info "Payout split stays enabled."
        fi
        return
    fi

    echo ""
    echo -e "  ${BOLD}${CYAN}┏━ WHEN IS THIS USEFUL? ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${RESET}"
    echo -e "  ${BOLD}${CYAN}┃${RESET}  Turn this ON if you ${BOLD}share this solo private pool with trusted${RESET}"
    echo -e "  ${BOLD}${CYAN}┃${RESET}  ${BOLD}friends${RESET}. The page tracks how much work each worker did,"
    echo -e "  ${BOLD}${CYAN}┃${RESET}  so you can reconcile and ${BOLD}pay them out weekly${RESET} (or on any"
    echo -e "  ${BOLD}${CYAN}┃${RESET}  cadence you like) by hand. If you mine alone, leave it OFF."
    echo -e "  ${BOLD}${CYAN}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${RESET}"
    echo ""
    echo -ne "  Enable payout-split calculation? [Y/n]: "
    read -r ans
    [[ "${ans,,}" == "n" ]] && { info "Payout split not enabled."; return; }

    mkdir -p "$(dirname "$PAYMENT_CONFIG")"
    printf '{"enabled":true}\n' > "$PAYMENT_CONFIG"
    chmod 644 "$PAYMENT_CONFIG"
    success "Payout split enabled → $PAYMENT_CONFIG"
    echo -e "  ${DIM}The page shows a per-nickname running balance (owed = matured-block${RESET}"
    echo -e "  ${DIM}earnings − payments). Record payouts in menu 7 so 'Owed' drops.${RESET}"
}

# Prompt for the optional index & setup pages access lock (HTTP Basic Auth over
# HTTPS). Writes an apr1 htpasswd (no apache2-utils needed — nginx reads apr1 natively) and echoes,
# via the named globals below, the nginx snippets the vhost writer injects:
#   _ACCESS_AUTH_BLOCK       server-level auth_basic + auth_basic_user_file (or "")
#   _ACCESS_PUBLIC_CARVEOUTS poolstats_*.json `auth_basic off` carve-outs (or "")
# Basic Auth is safe here because the Stats web page deploy always runs certbot + HTTP→HTTPS redirect, so
# credentials never travel over plain HTTP (the :80 block 301s before the prompt).
_ACCESS_AUTH_BLOCK=""
_ACCESS_PUBLIC_CARVEOUTS=""
_solo_prompt_access_lock() {
    _ACCESS_AUTH_BLOCK=""
    _ACCESS_PUBLIC_CARVEOUTS=""

    echo ""
    echo -e "${BOLD}Index & setup pages access lock (recommended for solo)${RESET}"
    echo -e "  ${DIM}Username/password gate (HTTP Basic Auth, served over HTTPS). With it ON, the${RESET}"
    echo -e "  ${DIM}index + setup pages go fully private: every visitor — search engines included${RESET}"
    echo -e "  ${DIM}— gets a 401 before any content, so the domain can't be crawled or indexed at${RESET}"
    echo -e "  ${DIM}all. A solo page shows your income (found blocks, hashrate, nicknames, owed),${RESET}"
    echo -e "  ${DIM}so locking it is the sensible default; the public miningpoolstats feed${RESET}"
    echo -e "  ${DIM}(poolstats_*.json) stays reachable. Without the lock, the pages are public${RESET}"
    echo -e "  ${DIM}(only a 'noindex' hint, which rogue bots ignore).${RESET}"

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
        echo -ne "  Protect the index & setup pages with a username/password? [Y/n]: "
        read -r alk
        [[ "${alk,,}" == "n" ]] && { info "Access lock not enabled (pages stay public)."; return; }
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

    # health.json is ALWAYS public (auth_basic off), independent of the poolstats
    # choice below. ONE file carries both networks: per-net booleans + counts only
    # (node/wallet/stratum up? + miners connected + blocks found 24h — no height/
    # difficulty/balance/hashrate), so an external uptime monitor can verify the
    # rig without the page password. An exact-match location beats the /data regex,
    # so it wins by location-priority.
    _ACCESS_PUBLIC_CARVEOUTS=$'    location = /data/health.json { auth_basic off; }\n'

    # poolstats_<net>.json is the machine-readable feed miningpoolstats.stream polls.
    # Default OFF: a freshly locked solo page keeps everything but health locked. Opt
    # in to expose just this one feed (auth_basic off carve-out) to list the pool.
    echo -e "  ${DIM}poolstats_*.json is the feed https://miningpoolstats.stream/grin polls to list a pool.${RESET}"
    echo -ne "  Publish it publicly so you can list this pool there (everything else stays locked)? [y/N]: "
    read -r pubmps
    if [[ "${pubmps,,}" == "y" ]]; then
        _ACCESS_PUBLIC_CARVEOUTS+=$'    location = /data/poolstats_main.json { auth_basic off; }\n    location = /data/poolstats_test.json { auth_basic off; }\n'
        info "poolstats feed published (public); everything but health + poolstats (incl. split_main.json) stays locked."
    else
        info "poolstats feed locked (no public miningpoolstats listing); only the sanitized health endpoint stays public."
    fi
    _ACCESS_PUBLIC_CARVEOUTS+=$'\n'   # blank line before the /data regex location
}

solo_deploy_stats_page() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Deploy Mining Stats Page${RESET}"
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

    # nginx + certbot must exist before we write the htpasswd, the vhost, or run
    # `nginx -t`. On a bare node /etc/nginx does not exist yet, which is why the
    # htpasswd write failed ("No such file or directory") and nginx_enable_site
    # reported "nginx: command not found". Install up front so both succeed.
    if ! command -v nginx >/dev/null 2>&1; then
        info "nginx not installed — installing nginx + certbot first..."
    fi
    nginx_install_with_certbot || { error "Could not install nginx/certbot — aborting deploy."; return 1; }

    echo ""
    echo -e "${BOLD}${YELLOW}┏━━ CLOUDFLARE / DNS NOTE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${RESET}"
    echo -e "${BOLD}${YELLOW}┃${RESET}  If this domain is on Cloudflare, set the A record to"
    echo -e "${BOLD}${YELLOW}┃${RESET}  ${BOLD}\"DNS only\" (grey cloud)${RESET} — ${BOLD}NOT proxied (orange cloud)${RESET}."
    echo -e "${BOLD}${YELLOW}┃${RESET}  ${DIM}A proxied record blocks miners from reaching the stratum${RESET}"
    echo -e "${BOLD}${YELLOW}┃${RESET}  ${DIM}port via the domain — they'd have to use the raw server IP${RESET}"
    echo -e "${BOLD}${YELLOW}┃${RESET}  ${DIM}(e.g. iPollo G1 mini: Pool name with real IP instead).${RESET}"
    echo -e "${BOLD}${YELLOW}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${RESET}"
    echo ""

    local subdomain
    echo -e "Subdomain for the stats page  ${DIM}(suggestion: solo.yourdomain.com)${RESET}"
    echo -ne "Enter subdomain ${DIM}(0 = return)${RESET}: "
    read -r subdomain
    [[ -z "$subdomain" || "$subdomain" == "0" ]] && { info "Cancelled — returning."; return 1; }

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
    if [[ -f "$STATS_SHOT_SRC" ]]; then
        cp "$STATS_SHOT_SRC" "$web_dir/pool-config-example.png"
        chmod 644 "$web_dir/pool-config-example.png"
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

    # Pool display name shown in the public poolstats feed (poolstats_<net>.json →
    # "pool":{"name"}). The stats collector reads it from this config.json, so it
    # can be changed any time by editing config.json — no redeploy needed (the next
    # 5-min collector run picks it up). Pre-fill from the existing config so a
    # redeploy keeps the operator's chosen name unless they type a new one.
    local existing_name=""
    if [[ -f "$web_dir/data/config.json" ]]; then
        existing_name=$(grep -oP '"pool_name"\s*:\s*"\K(\\.|[^"\\])*' \
            "$web_dir/data/config.json" 2>/dev/null || true)
    fi
    echo -ne "Pool display name for stats feed [${existing_name:-Grin Solo (Node Toolkit)}]: "
    read -r solo_pool_name
    [[ -z "$solo_pool_name" ]] && solo_pool_name="$existing_name"
    local pool_name_json=""
    if [[ -n "$solo_pool_name" ]]; then
        local esc_name="${solo_pool_name//\\/\\\\}"; esc_name="${esc_name//\"/\\\"}"
        pool_name_json="\"pool_name\":\"$esc_name\","
    fi
    local nets_json=""
    if [[ $have_main -eq 1 ]]; then
        nets_json+="\"main\":{\"stratum_port\":$(_solo_stratum_port mainnet)}"
    fi
    if [[ $have_test -eq 1 ]]; then
        [[ -n "$nets_json" ]] && nets_json+=","
        nets_json+="\"test\":{\"stratum_port\":$(_solo_stratum_port testnet)}"
    fi

    # Public IPv4 → the setup page shows it as the PRIMARY stratum target. Stratum is
    # raw TCP straight to the node (never proxied through nginx), so the IP always
    # reaches it, while the domain only works if its A record points straight at this
    # box — DNS-only; a Cloudflare-proxied (orange-cloud) record breaks raw-TCP
    # stratum. Prefer a freshly detected IP; fall back to one already in config.json
    # so a redeploy on a host where detection fails keeps the operator's value.
    local existing_ip=""
    if [[ -f "$web_dir/data/config.json" ]]; then
        existing_ip=$(grep -oP '"public_ip"\s*:\s*"\K[0-9.]+' \
            "$web_dir/data/config.json" 2>/dev/null || true)
    fi
    local pub_ip
    pub_ip=$(_confirm_public_ipv4 "$existing_ip")
    local public_ip_json=""
    [[ -n "$pub_ip" ]] && public_ip_json="\"public_ip\":\"$pub_ip\","

    # Off-box port-check service → the setup page turns each stratum URL into a live
    # "🟢 reachable / 🔴 unreachable" pill. MUST be a host OTHER than this node (e.g. the
    # public Office Tools checker), otherwise probing our own public IP can hairpin
    # through the local stack and report a false "open". The page calls
    # <base>/api/portcheckbatch?host=&ports= — a public CORS-open endpoint, so no
    # per-domain setup is needed on the checker. Defaults to the canonical public
    # Office Tools instance so the pills work out of the box; the operator can paste
    # a self-hosted Office Tools base URL instead, or type "-" to disable the live
    # pills (the static recommended/optional chips are kept). Existing config wins
    # as the prefill so a re-run does not silently revert a custom/disabled choice.
    local default_pcapi="https://tools.grin.money/pay-api"
    local existing_pcapi=""
    if [[ -f "$web_dir/data/config.json" ]]; then
        existing_pcapi=$(grep -oP '"portcheck_api"\s*:\s*"\K(\\.|[^"\\])*' \
            "$web_dir/data/config.json" 2>/dev/null || true)
    fi
    # Prefill: a value already in config (even when re-running) else the canonical default.
    local prefill_pcapi="${existing_pcapi:-$default_pcapi}"
    echo -ne "Off-box port-check API base URL for live reachability pills (Enter to accept, '-' to disable) [$prefill_pcapi]: "
    read -r solo_pcapi
    [[ -z "$solo_pcapi" ]] && solo_pcapi="$prefill_pcapi"
    [[ "$solo_pcapi" == "-" ]] && solo_pcapi=""   # explicit opt-out → omit the key, page falls back to chips
    local portcheck_api_json=""
    if [[ -n "$solo_pcapi" ]]; then
        local esc_pcapi="${solo_pcapi//\\/\\\\}"; esc_pcapi="${esc_pcapi//\"/\\\"}"
        portcheck_api_json="\"portcheck_api\":\"$esc_pcapi\","
    fi

    printf '{%s%s"host":"%s",%s%s"networks":{%s}}\n' "$slogan_json" "$pool_name_json" "$subdomain" "$public_ip_json" "$portcheck_api_json" "$nets_json" \
        > "$web_dir/data/config.json"
    chmod 644 "$web_dir/data/config.json"
    [[ -n "$solo_slogan" ]] && success "Slogan + connection config written (edit $web_dir/data/config.json to change)." \
        || success "Connection config written (edit $web_dir/data/config.json for slogan/ports)."

    # ── Payout split (mainnet only) ─────────────────────────────────────────────
    # Optional on/off toggle. Writes $PAYMENT_CONFIG ({"enabled":true}); the
    # collector then splits by worker name automatically. Done before the initial
    # collector run below so split_main.json appears immediately when enabled.
    if [[ $have_main -eq 1 ]]; then
        _solo_prompt_payout_split
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

    # Dedicated zone (NOT the shared grin_api 30r/m used by scripts 04/06): the
    # page polls up to 4 proxied endpoints every 10s, so one viewer alone draws
    # ~24 req/min. 90r/m gives a NAT'd / multi-tab audience real headroom.
    nginx_ensure_rate_limit_zone "solo_stats_api" "90r/m" "10m" "script07-solo-stats"

    # Abuse guards for the PUBLIC surface that had none. /api/* is already throttled
    # by solo_stats_api above; the static page + /data/*.json (polled 7×/10s/viewer,
    # ~42 req/min) and raw connections were unprotected. solo_static is sized well
    # above legit polling (180r/m ≈ 4× a single viewer, generous for NAT/multi-tab)
    # so it only bites a flood; solo_conn caps concurrent connections per IP to blunt
    # slowloris. Dedicated script07- zones — unique names, no collision with 04/05/06.
    nginx_ensure_rate_limit_zone "solo_static" "180r/m" "10m" "script07-solo-static"
    nginx_ensure_conn_limit_zone "solo_conn" "10m" "script07-solo-conn"

    # Write an HTTP-only vhost FIRST. Referencing letsencrypt certs that do not
    # exist yet would make `nginx -t` fail. certbot --nginx injects the 443
    # server block + SSL directives afterward (and manages options-ssl-nginx.conf).
    # ── Content-Security-Policy ─────────────────────────────────────────────────
    # Locks the pages to same-origin resources. BOTH pages use inline <style> and
    # <script> blocks (plus inline style="" attributes), so style-src/script-src
    # MUST allow 'unsafe-inline' — drop it and the layout + all live polling break.
    # connect-src needs 'self' (the same-origin /api/* and /data/*.json fetches)
    # PLUS the off-box port-check origin the setup page calls for its reachability
    # pills; we derive that origin (scheme://host[:port], path stripped) from the
    # operator-chosen portcheck_api so the pills keep working. Checker disabled →
    # only 'self'. No external fonts/CDN, logo is same-origin → img/font-src 'self'.
    # Applied at server level; it inherits into every location because none of them
    # set their own add_header (the /data location uses `expires`, not add_header,
    # precisely to keep this inheritance).
    local csp_connect="'self'"
    if [[ "${solo_pcapi:-}" =~ ^https?:// ]]; then
        local pc_origin; pc_origin=$(printf '%s' "$solo_pcapi" | sed -E 's#^(https?://[^/]+).*#\1#')
        [[ -n "$pc_origin" ]] && csp_connect="'self' $pc_origin"
    fi
    local csp_value="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src $csp_connect; font-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"

    # umask 077 so the conf (which holds the base64 auth token(s)) is never
    # group/world readable, even momentarily, before the explicit chmod below.
    info "Writing nginx vhost (HTTP): $nginx_conf"
    mkdir -p "$(dirname "$nginx_conf")"
    ( umask 077; cat > "$nginx_conf" << EOF
# Grin Solo Mining Stats (unified mainnet + testnet) — generated by 07_grin_mining_solo.sh
# Rate/conn zones live in /etc/nginx/conf.d/script07-solo-{stats,static,conn}.conf
# SSL is added in-place by certbot --nginx (do not hand-add a 443 block here).

server {
    listen 80;
    server_name $subdomain;

    root $web_dir;
    index index.html;

    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Content-Security-Policy "$csp_value" always;

    # Abuse guards (zones in script07-solo-static.conf / script07-solo-conn.conf).
    # Server-level so they are inherited by location / and the /data JSON location.
    # The /api/* locations define their own limit_req (solo_stats_api) so per nginx
    # inheritance rules they keep that and are NOT also bound to solo_static; they
    # do inherit limit_conn (they declare none of their own). limit_conn 50 leaves
    # ample headroom for NAT'd/multi-tab viewers (HTTP/2 multiplexes to ~1 conn per
    # tab) while stopping a single IP from holding the worker pool open. Raise it
    # here if a large shared-NAT audience hits spurious 503s.
    limit_req  zone=solo_static burst=20 nodelay;
    limit_conn solo_conn 50;
$_ACCESS_AUTH_BLOCK

$proxy_blocks$_ACCESS_PUBLIC_CARVEOUTS    location ~ ^/data/.+\.json\$ {
        # The page re-fetches these collector outputs every 10s. A short cache
        # lets browsers / any CDN absorb repeat + flood hits with no staleness.
        # Uses expires (NOT add_header) so the server-level security headers and
        # the inherited limit_req/limit_conn are preserved (add_header here would
        # reset header inheritance for this location). Exact-match carve-outs above
        # (= /data/poolstats_*.json) still win by location-priority.
        expires 10s;
        try_files \$uri =404;
    }

    location / {
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
    echo -e "  Uptime monitor: ${BOLD}/data/health.json${RESET} ${DIM}— both networks, sanitized node/wallet/stratum liveness${RESET}"
    echo -e "  ${DIM}(per-net booleans + miners-connected + blocks-found-24h; top-level ok = all nets; stays public${RESET}"
    echo -e "  ${DIM}even with the access lock on; refreshed every 5 min).${RESET}"
}

# ═══════════════════════════════════════════════════════════════════════════════
# STRATUM WATCHDOG CRON  (Watchdogs ▸ 4)
# ═══════════════════════════════════════════════════════════════════════════════
# Cron entry: every 5 minutes, verify stratum is enabled in grin-server.toml.
# Logs a warning if stratum config was lost (e.g. node restart reset the toml).

solo_watchdog_setup() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Stratum Watchdog Cron${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    local cron_file="/etc/cron.d/grin-stratum-watchdog"
    local wrapper="/usr/local/bin/grin-stratum-watchdog"

    # Bake the search DIRS (not a one-time snapshot of the tomls that happen to
    # exist now) so a node built AFTER the watchdog is installed is picked up on
    # the next run — the wrapper re-scans these dirs every time it fires.
    local search_dirs_literal="" dir
    for dir in "${_KNOWN_TOML_SEARCH_PATHS[@]}"; do
        search_dirs_literal+="    \"$dir\""$'\n'
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

SEARCH_DIRS=(
$search_dirs_literal)
for DIR in "\${SEARCH_DIRS[@]}"; do
    TOML_PATH="\$DIR/grin-server.toml"
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
# CLEANUP — REMOVE SOLO-MINING INFRA  (Maintenance ▸ C)
# ═══════════════════════════════════════════════════════════════════════════════
# Tears down everything Script 07 (solo) deploys so the server is a clean base for
# the public pool — WITHOUT touching anything the node or the public pool also
# needs. Each group is confirmed on its own; nothing runs until the master Y.
#
# REMOVED (per-group confirm):  stratum config (enable→false + firewall + restart),
#   stats collector + state dir, stats web page + nginx vhost, stratum/wallet
#   watchdogs, payout-split config, running wallet-listener tmux sessions.
# PRESERVED (never touched):    the Grin node + chain data (Script 01 / 08del own
#   that), the node-sync watchdog and boot autostart (the pool reuses them), the
#   wallet dir $SW_BASE (your SEED), and the encrypted backups in $SB_BACKUP_DIR
#   plus the backup key/schedule. To wipe those too, use Script 08del.

# Present/absent marker for the cleanup preview list.
_solo_cleanup_mark() {
    if [[ -e "$1" ]]; then echo -e "${YELLOW}present${RESET}"; else echo -e "${DIM}absent${RESET}"; fi
}

# Disable stratum in a net's grin-server.toml (silent resolve — no prompts) and
# close its firewall port. No-op when no toml is found for that net.
_solo_cleanup_stratum_net() {
    local net="$1" stratum_port="$2" api_port="$3" toml
    toml=$(_resolve_stratum_toml "$net" "$api_port" 2>/dev/null || true)
    if [[ -n "$toml" && -f "$toml" ]]; then
        if grep -qE '^#?[[:space:]]*enable_stratum_server[[:space:]]*=' "$toml" 2>/dev/null; then
            sed -i -E "s|^#?[[:space:]]*enable_stratum_server[[:space:]]*=.*|enable_stratum_server = false|" "$toml"
        fi
        success "$net: enable_stratum_server = false  ${DIM}($toml)${RESET}"
        log "Cleanup ($net): enable_stratum_server = false in $toml"
    else
        info "$net: no grin-server.toml found — stratum config left as-is."
    fi
    # Best-effort firewall close (mirrors Restrict). A per-IP allow added via the
    # "specific IP" path can't be matched here — remove it by hand if you want a
    # pristine ruleset (ufw status numbered / iptables -S).
    if command -v ufw &>/dev/null; then
        ufw delete allow "$stratum_port/tcp" 2>/dev/null \
            && success "$net: UFW allow for $stratum_port removed." || true
    elif command -v iptables &>/dev/null; then
        while iptables -D INPUT -p tcp --dport "$stratum_port" -j ACCEPT 2>/dev/null; do :; done
        if command -v netfilter-persistent &>/dev/null; then
            netfilter-persistent save 2>/dev/null || true
        elif [[ -d /etc/iptables ]]; then
            iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
        fi
        success "$net: iptables allow for $stratum_port removed."
    fi
}

solo_cleanup() {
    clear
    local conf_name="$STATS_BASENAME"
    local web_dir="/var/www/$STATS_BASENAME"
    local nginx_conf="/etc/nginx/sites-available/$STATS_BASENAME"

    echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${RED}  Clean Up Solo Mining${RESET}  ${DIM}(prep server for the public pool)${RESET}"
    echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Removes the solo-mining infrastructure. The node, your wallet seed,"
    echo -e "  and your backups are ${BOLD}kept${RESET} — confirm each group below."
    echo ""
    echo -e "  ${BOLD}Will be removed${RESET} ${DIM}(if you confirm the group):${RESET}"
    echo -e "    Stratum config (node toml)  ${DIM}enable→false + firewall${RESET}"
    echo -e "    Collector                   $(_solo_cleanup_mark "$BLOCK_COLLECTOR_WRAPPER")"
    echo -e "    Collector state dir         $(_solo_cleanup_mark "$BLOCK_COLLECTOR_STATE_DIR")"
    echo -e "    Stats web / nginx vhost     $(_solo_cleanup_mark "$nginx_conf")"
    echo -e "    Stratum watchdog            $(_solo_cleanup_mark "/etc/cron.d/grin-stratum-watchdog")"
    echo -e "    Wallet-listener watchdog    $(_solo_cleanup_mark "$SW_WATCHDOG_CRON")"
    echo -e "    Payout-split config         $(_solo_cleanup_mark "$PAYMENT_CONFIG")"
    echo ""
    echo -e "  ${BOLD}${GREEN}Kept — never touched:${RESET}"
    echo -e "    ${DIM}Grin node + chain data · node-sync watchdog · boot autostart${RESET}"
    echo -e "    ${DIM}Wallet seed ($SW_BASE) · backups ($SB_BACKUP_DIR) + key${RESET}"
    echo -e "    ${DIM}(use Script 08del for a full wipe including those)${RESET}"
    echo ""
    echo -ne "${BOLD}Proceed with solo-mining cleanup? [y/N]: ${RESET}"
    local go; read -r go || true
    [[ "${go,,}" == "y" ]] || { info "Cancelled — nothing changed."; return; }
    echo ""

    local a r
    # 1) Stratum config + firewall (+ optional node restart so it actually stops)
    echo -ne "${BOLD}1)${RESET} Disable stratum (both nets) + close ports $STRATUM_PORT_MAINNET/$STRATUM_PORT_TESTNET? [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        _solo_cleanup_stratum_net mainnet "$STRATUM_PORT_MAINNET" "$NODE_API_PORT_MAINNET" || true
        _solo_cleanup_stratum_net testnet "$STRATUM_PORT_TESTNET" "$NODE_API_PORT_TESTNET" || true
        echo -ne "   Restart running node(s) now so stratum actually stops? [y/N]: "
        read -r r || true
        if [[ "${r,,}" == "y" ]]; then
            graceful_restart_grin "$NODE_API_PORT_MAINNET" mainnet || true
            graceful_restart_grin "$NODE_API_PORT_TESTNET" testnet || true
        else
            info "Stratum stays up until the node next restarts."
        fi
    fi
    echo ""

    # 2) Stats collector + state
    echo -ne "${BOLD}2)${RESET} Remove stats collector + state dir ($BLOCK_COLLECTOR_STATE_DIR)? [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        rm -f "$BLOCK_COLLECTOR_BIN" "$BLOCK_COLLECTOR_WRAPPER" "$BLOCK_COLLECTOR_CRON"
        rm -rf "$BLOCK_COLLECTOR_STATE_DIR"
        success "Collector + state removed."
        log "Cleanup: removed collector bin/wrapper/cron + $BLOCK_COLLECTOR_STATE_DIR"
    fi
    echo ""

    # 3) Stats web page + nginx vhost
    echo -ne "${BOLD}3)${RESET} Remove stats web page + nginx vhost ($conf_name)? [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        if command -v nginx &>/dev/null && [[ -e "/etc/nginx/sites-enabled/$conf_name" || -f "$nginx_conf" ]]; then
            nginx_disable_site "$conf_name" || true
            rm -f "$nginx_conf"
            nginx_test_reload "after removing $conf_name vhost" || true
        fi
        rm -rf "$web_dir"
        rm -f "$STATS_HTPASSWD"
        success "Stats web page + vhost removed."
        info "Any TLS cert under /etc/letsencrypt is left in place (harmless) — 'certbot delete' to drop it."
        log "Cleanup: removed stats vhost $conf_name, $web_dir, $STATS_HTPASSWD"
    fi
    echo ""

    # 4) Watchdogs — stratum + wallet-listener ONLY (node-sync/autostart kept)
    echo -ne "${BOLD}4)${RESET} Remove stratum + wallet-listener watchdogs? [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        rm -f /etc/cron.d/grin-stratum-watchdog /usr/local/bin/grin-stratum-watchdog "$WATCHDOG_LOG"
        success "Stratum watchdog removed."
        sw_watchdog_remove || true
        rm -f "$SW_WATCHDOG_LOG" 2>/dev/null || true
        info "Node-sync watchdog + boot autostart left intact (the node/pool still need them)."
        log "Cleanup: removed stratum + wallet-listener watchdogs"
    fi
    echo ""

    # 5) Payout-split config
    if [[ -f "$PAYMENT_CONFIG" ]]; then
        echo -ne "${BOLD}5)${RESET} Remove payout-split config ($PAYMENT_CONFIG)? [Y/n]: "
        read -r a || true
        if [[ "${a,,}" != "n" ]]; then
            rm -f "$PAYMENT_CONFIG"
            success "Payout-split config removed."
            log "Cleanup: removed $PAYMENT_CONFIG"
        fi
        echo ""
    fi

    # 6) Running wallet-listener sessions — wallet dir + seed are KEPT
    echo -ne "${BOLD}6)${RESET} Stop running wallet-listener sessions? ${DIM}(seed/wallet kept)${RESET} [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        sw_listener_stop mainnet || true
        sw_listener_stop testnet || true
    fi
    echo ""

    success "Solo-mining cleanup complete."
    echo -e "  ${BOLD}${GREEN}Kept:${RESET} node + chain data · node-sync watchdog · boot autostart"
    echo -e "        wallet seed ($SW_BASE) · encrypted backups ($SB_BACKUP_DIR) + key"
    echo -e "  ${DIM}The server is ready for the public pool.${RESET}"
}

# ═══════════════════════════════════════════════════════════════════════════════
# MENU
# ═══════════════════════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════════════════════
# SUPERVISION SUBMENUS (Track B — central wallet + watchdogs)
# Inside a network branch each action inherits SOLO_NETWORK (no per-action
# prompt); the global Watchdogs menu still prompts which net to act on. Underlying
# logic lives in the shared libs (07_solo_wallet.sh, grin_node_keepalive.sh).
# ═══════════════════════════════════════════════════════════════════════════════

# ─── Active network (network-as-parent) ─────────────────────────────────────
# The top menu picks a network ONCE; inside that branch SOLO_NETWORK is set and
# every per-action call to _solo_pick_net returns it silently (no repeat prompt).
# Cleared on the way back to the network-select screen so the global Watchdogs
# menu still prompts for which net to act on. Mirrors 052 Grin Drop's _set_network.
SOLO_NETWORK=""
SOLO_API_PORT=""
SOLO_STRATUM_PORT=""

_set_solo_net() {
    SOLO_NETWORK="$1"
    if [[ "$1" == "mainnet" ]]; then
        SOLO_API_PORT="$NODE_API_PORT_MAINNET"
        SOLO_STRATUM_PORT="$STRATUM_PORT_MAINNET"
    else
        SOLO_API_PORT="$NODE_API_PORT_TESTNET"
        SOLO_STRATUM_PORT="$STRATUM_PORT_TESTNET"
    fi
}
_clear_solo_net() { SOLO_NETWORK=""; SOLO_API_PORT=""; SOLO_STRATUM_PORT=""; }

# _solo_pick_net <label> → echoes "mainnet"|"testnet" on stdout; rc 1 on cancel.
# Inside a network branch (SOLO_NETWORK set) it returns that net with NO prompt;
# at the top level (global menus) it falls back to the interactive 1/2/0 prompt.
_solo_pick_net() {
    if [[ -n "${SOLO_NETWORK:-}" ]]; then
        echo "$SOLO_NETWORK"
        return 0
    fi
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

# Wallet (per-net branch ▸ 1) — init/recover, listener, auto-restart, address.
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

# Watchdogs (global) (network-select ▸ 5) — node-sync, node boot-autostart, wallet listener, stratum.
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
        echo -e "  ${GREEN}1${RESET}) Install node-sync watchdog    ${DIM}(restarts a wedged node)${RESET}"
        echo -e "  ${RED}2${RESET}) Remove  node-sync watchdog"
        echo -e "  ${GREEN}3${RESET}) Enable  node boot-autostart   ${DIM}(@reboot · per net / both)${RESET}"
        echo -e "  ${RED}4${RESET}) Disable node boot-autostart   ${DIM}(per net / both)${RESET}"
        echo -e "  ${GREEN}5${RESET}) Install wallet-listener watchdog"
        echo -e "  ${RED}6${RESET}) Remove  wallet-listener watchdog"
        echo -e "  ${GREEN}7${RESET}) Stratum watchdog              ${DIM}(alert if stratum drops)${RESET}"
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-7/0]: ${RESET}"
        read -r choice || choice=0
        case "$choice" in
            "") continue ;;
            1)  gnk_watchdog_install || true; _solo_pause ;;
            2)  gnk_watchdog_remove  || true; _solo_pause ;;
            3|4) echo -e "  Network for ${BOLD}boot autostart${RESET}:  ${GREEN}1${RESET}) Both  ${GREEN}2${RESET}) Mainnet  ${GREEN}3${RESET}) Testnet  ${DIM}0) Cancel${RESET}"
                echo -ne "  Select [1/2/3/0]: "; read -r np || true
                local nets=()
                case "$np" in
                    1) nets=(mainnet testnet) ;;
                    2) nets=(mainnet) ;;
                    3) nets=(testnet) ;;
                    *) _solo_pause; continue ;;
                esac
                for net in "${nets[@]}"; do
                    if [[ "$choice" == "3" ]]; then
                        gnk_autostart_enable "$net" || true
                    else
                        gnk_autostart_disable "$net" || true
                    fi
                done
                _solo_pause ;;
            5)  sw_watchdog_install || true; _solo_pause ;;
            6)  sw_watchdog_remove  || true; _solo_pause ;;
            7)  solo_watchdog_setup || true; _solo_pause ;;
            0)  return ;;
            *)  warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# Stratum (per-net branch ▸ 2) — Setup / Configure / Publish / Restrict for the
# branch's network. Pure dispatch — maps action+net to the mainnet/testnet
# wrapper; the network comes from the parent branch (SOLO_NETWORK), not a prompt.
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
        echo -e "  ${GREEN}1${RESET}) Setup       ${DIM}(enable stratum in grin-server.toml · wallet URL)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Configure   ${DIM}(enable / bind / wallet — single field)${RESET}"
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

# Per-network branch — entered from the network-select screen after a net is
# chosen (SOLO_NETWORK set). Holds only the genuinely per-net actions; cross-
# network tools (both-net status, the unified stats page, global watchdogs) stay
# on the network-select screen. Wallet/Stratum keep their own submenus — they
# just inherit SOLO_NETWORK now instead of prompting per action.
solo_net_menu() {
    local choice label
    label="Mainnet"; [[ "$SOLO_NETWORK" == "testnet" ]] && label="Testnet"
    while true; do
        clear
        if [[ "$SOLO_NETWORK" == "mainnet" ]]; then
            echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
            echo -e "${BOLD}${RED}  07) Grin Solo — [MAINNET — REAL GRIN]${RESET}"
            echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        else
            echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
            echo -e "${BOLD}${CYAN}  07) Grin Solo — [TESTNET]${RESET}"
            echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        fi
        echo ""
        _show_node_info "$SOLO_NETWORK" "$SOLO_API_PORT" "$SOLO_STRATUM_PORT"
        echo -e "  ${GREEN}1${RESET}) Wallet          ${DIM}▸ setup/recover · listener · auto-restart · address${RESET}"
        echo -e "  ${GREEN}2${RESET}) Stratum         ${DIM}▸ setup · configure · publish · restrict${RESET}"
        echo -e "  ${GREEN}3${RESET}) Terminal Stats  ${DIM}(live dashboard for $label)${RESET}"
        echo ""
        echo -e "  ${DIM}↩  Press Enter to refresh${RESET}"
        echo -e "  ${RED}0${RESET}) Back to network select"
        echo ""
        echo -ne "${BOLD}Select [1-3/0]: ${RESET}"
        read -r choice || choice=0          # EOF (Ctrl+D) → 0 → Back
        case "$choice" in
            "") continue ;;                 # Enter → refresh
            1) wallet_menu  || true ;;
            2) stratum_menu || true ;;
            3) solo_live_stats "$SOLO_NETWORK" || true ;;
            0) return ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# ── Deploy new code (refresh runtime copies from the checkout) ──────────────
# The .sh menus + sourced libs run IN-PLACE from the checkout, so a `git pull`
# (Admin centre 08 → 8 Self-Update) already updates them. But two runtime files
# are SNAPSHOTS copied out by the full stats deploy (07 → 3): the collector .py
# (→ /usr/local/bin) and the stats web page (→ /var/www/<conf>). A pull does NOT
# refresh those. This re-copies just those two — no prompts, no wrapper/cron
# rewrite, no nginx reload — so a code-only update doesn't need the heavy deploy.
# Backfill the port-check API default into an EXISTING config.json when the key is
# missing, so a code-only "Deploy new code" makes the refreshed setup page's live
# reachability pills work without re-running the full deploy's prompt. Deliberately
# conservative:
#   · no-op if the file is absent or not valid JSON (the full deploy owns creation)
#   · no-op if "portcheck_api" is already present — a custom URL the operator set, OR
#     a deliberate disable (full deploy omits the key), are both preserved
#   · only adds the key + value, leaving every other field and the compact format intact
# Returns 0 ONLY when it actually added the key (so the caller logs + chmods).
_solo_backfill_portcheck_api() {
    local cfg="$1"
    [[ -f "$cfg" ]] || return 1
    python3 - "$cfg" "https://tools.grin.money/pay-api" <<'PY' || return 1
import json, sys
path, default = sys.argv[1], sys.argv[2]
try:
    with open(path) as f:
        cfg = json.load(f)
except Exception:
    sys.exit(1)                      # missing / corrupt — leave it for the full deploy
if not isinstance(cfg, dict) or "portcheck_api" in cfg:
    sys.exit(1)                      # already set (custom or disabled) — never override
cfg["portcheck_api"] = default
with open(path, "w") as f:
    json.dump(cfg, f, separators=(",", ":"))   # match the printf'd compact style
sys.exit(0)
PY
}

solo_deploy_code() {
    echo ""
    echo -e "  ${BOLD}Deploy new code${RESET} — refresh runtime copies from the checkout."
    echo -e "  ${DIM}Source: $TOOLKIT_ROOT${RESET}"
    echo -e "  ${YELLOW}Pull the latest first:${RESET} Admin centre ${BOLD}(08) → 8) Self-Update${RESET}."
    echo ""
    local did=0

    # 1) Mining stats collector (.py) — fixed dest path, only refresh if already deployed.
    if [[ ! -f "$BLOCK_COLLECTOR_SRC" ]]; then
        warn "Collector source missing: $BLOCK_COLLECTOR_SRC"
    elif [[ ! -f "$BLOCK_COLLECTOR_BIN" ]]; then
        info "Collector not deployed yet — run 'Deploy stats web page' (07 → 3) once first."
    elif cp "$BLOCK_COLLECTOR_SRC" "$BLOCK_COLLECTOR_BIN" && chmod 755 "$BLOCK_COLLECTOR_BIN"; then
        success "Collector refreshed → $BLOCK_COLLECTOR_BIN"; did=1
    else
        warn "Could not refresh collector."
    fi

    # 2) Web assets (index.html + setup page + logo) — dest is per-deployment.
    #    Discover the live web dir(s) from the collector wrapper's --out-dir
    #    (= <web_dir>/data), written at deploy time; refresh only dirs that already
    #    hold an index.html. ALL static assets the full deploy (07 → 3) lays down are
    #    refreshed here, not just index.html, so a code-only update never leaves a
    #    stale setup page. config.json is generated (not a static copy), so we only
    #    backfill the port-check default into it when the key is absent — never
    #    overwrite the operator's pool name / ports / a custom portcheck_api value.
    if [[ -f "$STATS_WEB_SRC" && -f "$BLOCK_COLLECTOR_WRAPPER" ]]; then
        local out_dir web_dir
        while IFS= read -r out_dir; do
            [[ -z "$out_dir" ]] && continue
            web_dir="$(dirname "$out_dir")"
            [[ -f "$web_dir/index.html" ]] || continue   # only a live stats deploy

            if cp "$STATS_WEB_SRC" "$web_dir/index.html" && chmod 644 "$web_dir/index.html"; then
                success "Stats page refreshed → $web_dir/index.html"; did=1
            fi
            if [[ -f "$STATS_SETUP_SRC" ]] \
               && cp "$STATS_SETUP_SRC" "$web_dir/setup-solo-mining.html" \
               && chmod 644 "$web_dir/setup-solo-mining.html"; then
                success "Setup page refreshed → $web_dir/setup-solo-mining.html"; did=1
            fi
            if [[ -f "$STATS_SHOT_SRC" ]] \
               && cp "$STATS_SHOT_SRC" "$web_dir/pool-config-example.png" \
               && chmod 644 "$web_dir/pool-config-example.png"; then
                did=1
            fi
            if [[ -f "$STATS_LOGO_SRC" ]] \
               && cp "$STATS_LOGO_SRC" "$web_dir/logo.svg" && chmod 644 "$web_dir/logo.svg"; then
                did=1
            fi
            if _solo_backfill_portcheck_api "$web_dir/data/config.json"; then
                chmod 644 "$web_dir/data/config.json" 2>/dev/null || true
                success "Port-check default added → $web_dir/data/config.json (portcheck_api=https://tools.grin.money/pay-api)"; did=1
            fi
        done < <(grep -oE -- '--out-dir [^ ]+' "$BLOCK_COLLECTOR_WRAPPER" | awk '{print $2}' | sort -u)
    fi

    [[ $did -eq 0 ]] && info "Nothing to refresh yet — deploy the stats page (07 → 3) first."
    echo ""
    echo -e "  ${DIM}Menu scripts (.sh) run in-place — the pull already updated them.${RESET}"
}

# ── Payouts & settlement (mainnet running balance) ──────────────────────────
# Records out-of-band payouts against the collector's per-nickname RUNNING BALANCE
#   owed(nick) = Σ matured-block earnings  −  Σ recorded payments
# so the GRIN-owed figure stops accumulating once you pay. Bookkeeping only — no
# Grin address is ever stored or moved; the operator still sends GRIN by hand. All
# state lives in the collector's SQLite DB and is reached ONLY through its
# --list-balances / --record-payment / --list-payments modes (the collector owns
# the schema; the menu never touches the DB directly).
SOLO_MAIN_DB="$BLOCK_COLLECTOR_STATE_DIR/solo_mining_stats_main.db"

_settlement_show_balances() {
    "$BLOCK_COLLECTOR_BIN" --net mainnet --state-dir "$BLOCK_COLLECTOR_STATE_DIR" \
        --list-balances 2>/dev/null | python3 -c '
import json, sys
try: d = json.load(sys.stdin)
except Exception: d = {}
rows = d.get("balances", []); t = d.get("totals", {})
if not rows:
    print("  No earnings recorded yet (no block has matured since the split was enabled).")
    sys.exit()
rows.sort(key=lambda r: (-r["owed"], r["nick"]))   # biggest To be Paid first; same sort the picker uses
print("  %-3s %-22s %13s %10s %12s" % ("#", "Nickname", "All time earn", "Paid", "To be Paid"))
print("  " + "-" * 64)
for i, r in enumerate(rows, 1):
    print("  %-3d %-22s %13.3f %10.3f %12.3f" % (i, r["nick"][:22], r["earned"], r["paid"], r["owed"]))
print("  " + "-" * 64)
print("  %-3s %-22s %13.3f %10.3f %12.3f GRIN" % ("", "TOTAL", t.get("earned",0), t.get("paid",0), t.get("owed",0)))
'
}

_settlement_record_payment() {
    local nick amt note confirm out bj pick owed_default
    # Fetch the balances JSON once: drives both the numbered picker below and the
    # index→nickname resolution. Sort here must match _settlement_show_balances so
    # the row numbers line up with what the operator just saw on the menu screen.
    bj="$("$BLOCK_COLLECTOR_BIN" --net mainnet --state-dir "$BLOCK_COLLECTOR_STATE_DIR" \
        --list-balances 2>/dev/null)"
    echo ""
    echo "$bj" | python3 -c '
import json, sys
try: d = json.load(sys.stdin)
except Exception: d = {}
rows = d.get("balances", [])
rows.sort(key=lambda r: (-r["owed"], r["nick"]))
if not rows:
    print("  No balances yet — nothing to pick from (type a nickname to record anyway).")
    sys.exit()
print("  %-3s %-22s %12s" % ("#", "Nickname", "To be Paid"))
print("  " + "-" * 39)
for i, r in enumerate(rows, 1):
    print("  %-3d %-22s %12.3f" % (i, r["nick"][:22], r["owed"]))
' 2>/dev/null || true
    echo ""
    echo -ne "  Pick # to credit, or type a nickname ${DIM}(0 = return)${RESET}: "
    read -r nick
    nick="$(echo "$nick" | tr -d '[:space:]')"
    [[ -z "$nick" || "$nick" == "0" ]] && { info "Cancelled — returning."; return; }
    # Pure number → resolve to a nickname (and its owed amount) from the same sorted list.
    if [[ "$nick" =~ ^[0-9]+$ ]]; then
        pick="$(echo "$bj" | python3 -c '
import json, sys
idx = int(sys.argv[1])
try: d = json.load(sys.stdin)
except Exception: d = {}
rows = d.get("balances", [])
rows.sort(key=lambda r: (-r["owed"], r["nick"]))
if 1 <= idx <= len(rows):
    r = rows[idx-1]; print("%s\t%.3f" % (r["nick"], r["owed"]))
' "$nick" 2>/dev/null)"
        [[ -z "$pick" ]] && { warn "No nickname at #$nick. Cancelled."; return; }
        nick="${pick%%$'\t'*}"
        owed_default="${pick##*$'\t'}"
        [[ "$owed_default" == "0.000" ]] && owed_default=""   # nothing owed → no default
        info "Selected: ${nick}${owed_default:+ (To be Paid ${owed_default} GRIN)}"
    fi
    echo -ne "  Amount paid in GRIN ${DIM}(e.g. 12.5${owed_default:+ · Enter = ${owed_default}} · 0 = return)${RESET}: "
    read -r amt
    [[ -z "$amt" && -n "$owed_default" ]] && amt="$owed_default"   # Enter = pay full owed
    [[ "$amt" == "0" ]] && { info "Cancelled — returning."; return; }
    # Positive decimal only.
    if [[ ! "$amt" =~ ^[0-9]+(\.[0-9]+)?$ ]] || [[ "$amt" == "0.0" ]]; then
        warn "Invalid amount '$amt' — must be a positive number. Cancelled."
        return
    fi
    echo -ne "  Note (optional, e.g. 'weekly settle 06-04'): "
    read -r note
    echo ""
    echo -e "  Record payment of ${BOLD}${amt} GRIN${RESET} to ${BOLD}${nick}${RESET}?"
    echo -ne "  This lowers their 'To be Paid' balance. [Y/n]: "
    read -r confirm
    [[ "${confirm,,}" == "n" || "${confirm,,}" == "no" ]] && { info "Cancelled — nothing recorded."; return; }

    out="$("$BLOCK_COLLECTOR_BIN" --net mainnet --state-dir "$BLOCK_COLLECTOR_STATE_DIR" \
        --record-payment --pay-nick "$nick" --pay-grin "$amt" --pay-note "$note" 2>&1)" || {
        error "Failed to record payment:"; echo "$out"; return; }
    success "Payment recorded."
    echo "$out" | python3 -c 'import json,sys
try: d=json.load(sys.stdin); print("  %s now To be Paid: %.3f GRIN" % (d["recorded"]["nick"], d["owed_now"]))
except Exception: pass' 2>/dev/null || true

    # Refresh split_main.json now so the web page reflects the payment immediately
    # (otherwise it waits for the next 5-min cron run).
    if [[ -x "$BLOCK_COLLECTOR_WRAPPER" ]]; then
        "$BLOCK_COLLECTOR_WRAPPER" >/dev/null 2>&1 || true
        info "Web page balances refreshed."
    fi
}

_settlement_show_history() {
    echo ""
    echo -e "  ${BOLD}Recorded payments (newest first)${RESET}"
    "$BLOCK_COLLECTOR_BIN" --net mainnet --state-dir "$BLOCK_COLLECTOR_STATE_DIR" \
        --list-payments 2>/dev/null | python3 -c '
import json, sys
LIMIT = 20   # show only the latest 20; collector still returns full history (backups/queries)
try: d = json.load(sys.stdin)
except Exception: d = {}
pays = d.get("payments", [])   # already newest-first (ORDER BY id DESC)
if not pays:
    print("  No payments recorded yet."); sys.exit()
print("  %-20s %12s  %-20s  %s" % ("When (UTC)", "GRIN", "Nickname", "Note"))
print("  " + "-" * 72)
for p in pays[:LIMIT]:
    print("  %-20s %12.3f  %-20s  %s" % (p["ts"][:19], p["grin"], p["nick"][:20], p.get("note","")))
if len(pays) > LIMIT:
    print("  " + "-" * 72)
    print("  …and %d older — showing the latest %d of %d." % (len(pays) - LIMIT, LIMIT, len(pays)))
'
}

solo_settlement_menu() {
    local choice
    while true; do
        clear
        echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${RED}  07) Payouts & Settlement — [MAINNET]${RESET}"
        echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        if [[ ! -f "$SOLO_MAIN_DB" ]]; then
            warn "No mainnet stats database yet ($SOLO_MAIN_DB)."
            echo -e "  ${DIM}Deploy the stats page (menu 3) with payout split enabled first.${RESET}"
            _solo_pause; return
        fi
        echo -e "  ${DIM}All time earn = matured-block rewards · Paid = payments you record · To be Paid = earn − paid.${RESET}"
        echo -e "  ${DIM}Pay each nickname out-of-band, then record it here so their 'To be Paid' drops.${RESET}"
        echo ""
        _settlement_show_balances || true   # display only — never abort the menu under set -e
        echo ""
        echo -e "  ${GREEN}1${RESET}) Record a payment"
        echo -e "  ${GREEN}2${RESET}) Payment history"
        echo ""
        echo -e "  ${DIM}↩  Press Enter to refresh${RESET}"
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-2/0]: ${RESET}"
        read -r choice || choice=0
        case "$choice" in
            "") continue ;;
            1) _settlement_record_payment || true; _solo_pause ;;
            2) _settlement_show_history   || true; _solo_pause ;;
            0) return ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# Network-select screen (network-as-parent). Pick a net to manage (1/2), or use
# a cross-network tool (3-7). All-numeric — letters are reserved for
# destructive/admin actions per the toolkit menu convention.
show_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  07) Grin Mining Service — Solo Private Pool${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    show_compact_status

    echo -e "  ${DIM}─── Set up your solo private pool — top to bottom ────────${RESET}"
    echo -e "  ${GREEN}A${RESET}) Start here — node check      ${DIM}(is your node running & synced?)${RESET}"
    echo -e "  ${GREEN}1${RESET}) Configure solo private pool Mainnet  ${DIM}(real GRIN)${RESET}"
    echo -e "  ${GREEN}2${RESET}) Configure solo private pool Testnet  ${DIM}(tGRIN — no monetary value)${RESET}"
    echo -e "  ${GREEN}3${RESET}) Deploy stats web page        ${DIM}(public dashboard, both nets)${RESET}"
    echo ""
    echo -e "  ${DIM}─── Overview & shared tools ──────────────────────${RESET}"
    echo -e "  ${GREEN}4${RESET}) Node, Wallet & Mining Status  ${DIM}(both networks)${RESET}"
    echo -e "  ${GREEN}5${RESET}) Watchdogs (global)            ${DIM}(node-sync · boot autostart · wallet · stratum)${RESET}"
    echo -e "  ${GREEN}6${RESET}) Maintenance                   ${DIM}(encrypted backup · restore · schedule · seed)${RESET}"
    echo -e "  ${GREEN}7${RESET}) Payouts & settlement          ${DIM}(mainnet running balance · record payments)${RESET}"
    echo ""
    echo -e "  ${DIM}↩  Press Enter to refresh${RESET}"
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -ne "${BOLD}Select [A/1-7/0]: ${RESET}"
}

main() {
    while true; do
        show_menu
        read -r choice || choice=0          # EOF (Ctrl+D) → 0 → Back to main menu

        # Every action is guarded with `|| true`: this is an interactive dispatch
        # loop, so a cancelled/failed action (e.g. "TOML not found" → `... || return`)
        # must drop back to the menu, never hard-exit the script under `set -e`.
        # 1/2 enter a per-net branch: SOLO_NETWORK is set for its duration and
        # cleared on return, so the global Watchdogs menu (5) still prompts for
        # which net to act on. 3-7 are cross-network and run at the top level.
        case "${choice,,}" in
            "")  continue ;;                # Enter → refresh status
            a)   solo_node_precheck || true ;;
            1)   _set_solo_net mainnet; solo_net_menu || true; _clear_solo_net ;;
            2)   _set_solo_net testnet; solo_net_menu || true; _clear_solo_net ;;
            3)   solo_deploy_stats_page || true; _solo_pause ;;
            4)   show_node_status || true
                 echo ""; echo "Press Enter to continue..."; read -r || true ;;
            5)   watchdog_menu || true ;;
            6)   maintenance_menu || true ;;
            7)   solo_settlement_menu || true ;;
            0)   break ;;
            *)   warn "Invalid option."; sleep 1 ;;
        esac
        # Branches/submenus run their own loops + pauses; only the one-shot status
        # view (3) needs a pause, handled inline above.
    done
}

main "$@"
