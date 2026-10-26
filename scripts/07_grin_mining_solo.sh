#!/bin/bash
# =============================================================================
# 07_grin_mining_solo.sh — Grin Solo Private Mining Setup
# =============================================================================
# Configure and manage solo mining on a Grin node.
# Enables the node's built-in stratum server, sets your wallet reward address,
# and publishes the port so miners can connect directly.
#
# ─── Menu ─────────────────────────────────────────────────────────────────────
# Network-as-parent (mirrors 059 Grin Drop): the top screen picks a network ONCE,
# then every per-action prompt inside that branch is gone — SOLO_NETWORK is set
# and inherited. Cross-network tools (both-net status, the unified stats page,
# global watchdogs) live on the network-select screen, not inside a branch.
# All-numeric keys; letters are reserved for destructive/admin actions.
#
#   Network-select screen
#     A) Start here — node check       (is your node running & synced?)
#     1) Configure solo private pool Mainnet ┐ enter the per-net branch below
#     2) Configure solo private pool Testnet ┘
#     3) Deploy stats web page          (both networks; public domain+SSL, or plain
#                                        HTTP on a LAN IP if launched as `… solo.sh lan`)
#     4) Node, Wallet & Mining Status   (both networks)
#     5) Watchdogs (global)             (node-sync · boot autostart · wallet · stratum)
#     6) Maintenance                    (encrypted backup · restore · schedule · seed)
#     7) Payouts & settlement           (mainnet running balance · record payments)
#     8) Quiet hours (energy saver)     (auto-pause stratum in set hours so miners idle)
#     C) Clean up solo mining           (Danger Zone — remove solo infra · keeps node + seed + backups)
#     0) Back to main menu
#
#   Per-net branch (after 1/2 — SOLO_NETWORK set)
#     1) Wallet      ▸ setup/recover · listener · auto-restart · address
#     2) Stratum     ▸ setup & publish · manual config · restrict
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

# Stats-page presentation mode, set once from $1 in main():
#   "public" (default) — domain + Let's Encrypt SSL via certbot (the original flow).
#   "lan"              — plain HTTP on a chosen LAN IP:port; no domain, no certbot,
#                        no Basic Auth. For an internal/home network where the page
#                        is never internet-reachable. ONLY the stats-page deploy
#                        differs; all mining mechanics (node/wallet/stratum/watchdogs/
#                        backups/collector) are identical to public mode.
SOLO_NET_MODE="public"

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

# ─── Root guard ───────────────────────────────────────────────────────────────
# MUST stay above the mkdir below: /opt/grin is root-owned, so a non-root run
# died on `mkdir: cannot create directory '/opt/grin': Permission denied` with
# no banner and no hint — under `set -e` that is the entire output the operator
# sees. Everything this script does (node toml, firewall, nginx, cron, systemd)
# needs root anyway, so fail here with the command to re-run.
if [[ $EUID -ne 0 ]]; then
    echo -e "${RED}${BOLD}[ERROR]${RESET} Script 07 (solo mining) must be run as root."
    echo -e "  Re-run with sudo:  ${BOLD}sudo $0${*:+ $*}${RESET}"
    echo -e "  ${DIM}It edits the node's grin-server.toml, the firewall, nginx and cron —${RESET}"
    echo -e "  ${DIM}all of which need root. Nothing was changed.${RESET}"
    exit 1
fi

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
# Shared node-secret resolver + self-heal (keeps the solo wallet's
# node_api_secret_path in sync with the live node after a node rebuild).
# shellcheck source=lib/grin_node_secrets.sh
source "$SCRIPT_DIR/lib/grin_node_secrets.sh"
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
# Quiet hours (energy saver): scheduled firewall gate on the stratum port(s).
# Needs STRATUM_PORT_* (above) + colors/logging + _solo_pause — all defined here.
# shellcheck source=lib/07_solo_quiet.sh
source "$SCRIPT_DIR/lib/07_solo_quiet.sh"
# Menu sections split out of this file (same globals and logging; see each lib's header).
# shellcheck source=lib/07_solo_stratum.sh
source "$SCRIPT_DIR/lib/07_solo_stratum.sh"
# shellcheck source=lib/07_solo_stats_page.sh
source "$SCRIPT_DIR/lib/07_solo_stats_page.sh"
# shellcheck source=lib/07_solo_cleanup.sh
source "$SCRIPT_DIR/lib/07_solo_cleanup.sh"

# ═══════════════════════════════════════════════════════════════════════════════
# NODE DIRECTORY / SECRET RESOLUTION  (never hardcode "<net>-prune")
# ═══════════════════════════════════════════════════════════════════════════════
# A mainnet node can live in EITHER /opt/grin/node/mainnet-prune (pruned) or
# /opt/grin/node/mainnet-full (archive — what Script 01's archive build and
# GrinScan need). Assuming "-prune" broke everything on the stats side for an
# archive operator while the stratum side kept working (find_grin_server_toml
# already searched mainnet-full), so they got a mining rig with a permanently
# empty dashboard — and no error to point at. These two wrappers are the ONLY
# way this script may name a node dir or secret.
#
# grin_live_node_dir / grin_node_secret_path come from lib/grin_node_secrets.sh
# (sourced above): they resolve from the RUNNING node's tmux session first, then
# the instances-conf registry, then the standard path — and grin_node_secret_path
# additionally honours a custom api_secret_path set in the node's toml.

# _solo_node_dir <net> → node dir serving this network. Always echoes a usable
# path (falls back to the historic pruned path when nothing resolves) and always
# returns 0, so callers can use it inline; every caller still guards on the file
# it actually needs existing.
_solo_node_dir() {
    local net="$1" dir
    if dir=$(grin_live_node_dir "$net" 2>/dev/null) && [[ -n "$dir" ]]; then
        printf '%s\n' "$dir"
    else
        printf '/opt/grin/node/%s-prune\n' "$net"
    fi
}

# _solo_node_secret <net> <owner|foreign> → absolute secret path for that node.
# Same always-echo/always-0 contract as _solo_node_dir.
_solo_node_secret() {
    local net="$1" which="$2" p
    if p=$(grin_node_secret_path "$net" "$which" 2>/dev/null) && [[ -n "$p" ]]; then
        printf '%s\n' "$p"
    elif [[ "$which" == "owner" ]]; then
        printf '%s/.api_secret\n' "$(_solo_node_dir "$net")"
    else
        printf '%s/.foreign_api_secret\n' "$(_solo_node_dir "$net")"
    fi
}

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
# the canonical copy (no local duplicate — keep it that way).

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

# Searches BOTH tmux servers: grin's per-user socket first (nodes run
# grin-owned there — the gtmux socket), then root's default socket (legacy).
# Sets GRIN_SESSION_SOCKET to "grin"/"root" so callers print the right attach
# command (gtmux vs tmux).
_find_grin_session_for_pid() {
    local target_pid="$1" sock sess pane_pid v
    GRIN_SESSION_SOCKET=""
    local -a variants=()
    if sock=$(gnc_grin_tmux_socket 2>/dev/null); then
        variants+=("-S ${sock}")
    fi
    variants+=("")
    for v in "${variants[@]}"; do
        # $v intentionally unquoted: expands to "-S <socket>" (path has no
        # spaces) or to nothing for the default server.
        while IFS= read -r sess; do
            while IFS= read -r pane_pid; do
                if _is_descendant_of "$target_pid" "$pane_pid" 2>/dev/null; then
                    if [[ -n "$v" ]]; then GRIN_SESSION_SOCKET="grin"; else GRIN_SESSION_SOCKET="root"; fi
                    echo "$sess"
                    return 0
                fi
            done < <(tmux $v list-panes -t "$sess" -F '#{pane_pid}' 2>/dev/null || true)
        done < <(tmux $v ls -F '#{session_name}' 2>/dev/null | grep '^grin_' || true)
    done
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

    # Planned-stop marker BEFORE the signal (this SIGTERM bypasses gnc_kill_*),
    # keyed on the canonical session name so the recorder can map it to a net.
    local _mark_sess
    if _mark_sess=$(gnc_session_of_pid "$grin_pid"); then
        gnc_mark_planned_stop "$_mark_sess" "solo stratum config restart"
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

    # Relaunch via the shared contract launcher (lib/grin_node_control.sh):
    # kills the session on BOTH tmux servers, sweeps leftover grin processes
    # for this dir (lock-file protection), then starts the node AS the grin
    # user with HOME=$grin_dir on grin's tmux socket — never root-run.
    gnc_launch_node_session "$grin_dir" "$grin_binary" "$session_name" \
        || { warn "Failed to restart node. Start manually: cd $grin_dir && su -s /bin/bash -c 'HOME=$grin_dir ./grin server run' grin"; return 1; }

    sleep 3
    if ss -tlnp 2>/dev/null | grep -q ":$api_port "; then
        success "Grin ($network) node is back up on port $api_port."
    else
        warn "Grin may still be initializing. Check: gtmux attach -t $session_name"
    fi
    info "View: gtmux attach -t $session_name   ${DIM}(grin-owned — plain 'tmux attach' won't find it)${RESET}"
}

# ═══════════════════════════════════════════════════════════════════════════════
# STATUS HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

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

# Best-effort detection of this box's primary LAN (RFC-1918) IPv4. Used by the
# LAN stats-page flow as the prefill for the bind address. Prefers the source IP
# of the default route (the NIC the box actually reaches the LAN on), then falls
# back to the first private address in `hostname -I`. Echoes the IP (empty if none);
# the caller always lets the operator confirm/override, so a miss is non-fatal.
_detect_lan_ipv4() {
    local ip=""
    ip=$(ip -4 route get 1.1.1.1 2>/dev/null \
         | grep -oP 'src \K[0-9.]+' | head -n1 || true)
    if [[ -n "$ip" ]] && _is_private_ipv4 "$ip"; then
        printf '%s' "$ip"; return 0
    fi
    # Fall back to the first private address reported by hostname -I.
    local cand
    for cand in $(hostname -I 2>/dev/null); do
        if [[ "$cand" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] && _is_private_ipv4 "$cand"; then
            printf '%s' "$cand"; return 0
        fi
    done
    printf ''
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
        echo -e "${RED}NOT PUBLIC${RESET} ${DIM}(127.0.0.1:$port)${RESET}"
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
            # Re-resolve in THIS shell (the $() above ran in a subshell) to
            # learn which tmux server hosts it → right attach command.
            local _att="gtmux"
            if gnc_has_grin_session "$tmux_sess" && [[ "$GNC_SESSION_SOCKET" == "root" ]]; then _att="tmux"; fi
            echo -e "    tmux   : ${GREEN}$tmux_sess${RESET}  ${DIM}(attach: $_att attach -t $tmux_sess)${RESET}"
        else
            echo -e "    tmux   : ${DIM}no grin_ session found — try 'gtmux ls'${RESET}"
        fi
    else
        echo -e "    Node   : ${RED}NOT RUNNING${RESET}  ${DIM}(port $api_port not listening)${RESET}"
    fi

    # Coinbase wallet listener (combined Owner+Foreign on the Owner port) —
    # where the node sends block rewards. Shown before Stratum: a solo miner's
    # first question is "is my reward listener up?", so the screen reads
    # node → wallet → mining top to bottom.
    local wal_port wal_pid wal_toml wal_tmux
    wal_port=$(sw_listener_port "$network")
    wal_pid=$(ss -tlnp 2>/dev/null | grep ":$wal_port " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
    wal_toml=$(sw_toml "$network" 2>/dev/null || true)
    if [[ -n "$wal_pid" ]]; then
        echo -e "    Wallet : ${GREEN}LISTENING${RESET}  ${DIM}(PID $wal_pid, Owner+Foreign port $wal_port)${RESET}"
        wal_tmux=$(sw_tmux_name "$network" 2>/dev/null || true)
        if [[ -n "$wal_tmux" ]] && tmux has-session -t "$wal_tmux" 2>/dev/null; then
            echo -e "    Wtmux  : ${GREEN}$wal_tmux${RESET}  ${DIM}(attach: tmux attach -t $wal_tmux)${RESET}"
        fi
    elif [[ -n "$wal_toml" && -f "$wal_toml" ]]; then
        echo -e "    Wallet : ${RED}NOT RUNNING${RESET}  ${DIM}(configured, Owner+Foreign port $wal_port not listening)${RESET}"
    else
        echo -e "    Wallet : ${DIM}not configured${RESET}  ${DIM}(Owner+Foreign port $wal_port)${RESET}"
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
        echo -e "    · Stratum             ${DIM}Setup & Publish opens it to miners in one step${RESET}"
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
    local net_key="mainnet"
    local net_label="MAINNET"
    if [[ "${net_choice:-1}" == "2" ]]; then
        api_port="$NODE_API_PORT_TESTNET"
        stratum_port="$STRATUM_PORT_TESTNET"
        net_key="testnet"
        net_label="TESTNET"
    fi
    # Resolved, not assumed: a mainnet archive node lives in mainnet-full.
    local secret_path; secret_path=$(_solo_node_secret "$net_key" owner)

    local secret=""
    if [[ -f "$secret_path" ]]; then
        secret=$(cat "$secret_path")
    else
        warn "Secret file not found: $secret_path"
        echo -ne "Enter path to .api_secret (or 0 to skip auth): "
        read -r alt_secret_path
        [[ "$alt_secret_path" != "0" && -f "$alt_secret_path" ]] && secret=$(cat "$alt_secret_path")
    fi

    # Foreign API secret — used by get_header for the instant network-hashrate
    # calc below. Resolved in its OWN right, never derived from the owner path:
    # api_secret_path in the toml may point at a file NOT named ".api_secret", and
    # then `${secret_path%/.api_secret}` strips nothing and the derived sibling is
    # a path that cannot exist — auth silently drops and the hashrate line goes
    # blank with no error. The resolver reads foreign_api_secret_path properly.
    local fsecret=""
    local foreign_secret_path; foreign_secret_path=$(_solo_node_secret "$net_key" foreign)
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
        echo -e "${BOLD}${CYAN}  Solo Private Pool $(_solo_mode_word) · [$net_label] · Mining Stats${RESET}  ${DIM}($(date -u '+%H:%M:%S UTC'))${RESET}"
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
# menu still prompts for which net to act on. Mirrors 059 Grin Drop's _set_network.
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

# Mode word for solo submenu banners — "Internet" (default/public) or "LAN".
# Lets every solo screen show which front-end mode this server is running.
_solo_mode_word() { local m="Internet"; [[ "$SOLO_NET_MODE" == "lan" ]] && m="LAN"; echo "$m"; }

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
        echo -e "${BOLD}${CYAN}  07) Solo Private Pool $(_solo_mode_word) · [${SOLO_NETWORK^^}] · Central Wallet${RESET}${DIM}  (coinbase listener)${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "${BOLD}  Listener:${RESET}"
        sw_listener_status mainnet | sed 's/^/    /'
        sw_listener_status testnet | sed 's/^/    /'
        echo ""
        echo -e "${BOLD}  Auto-restart:${RESET} ${DIM}(@reboot + */5 listener watchdog)${RESET}"
        echo -e "    ${BOLD}Boot autostart:${RESET}";    sw_autostart_status | sed 's/^/      /'
        echo -e "    ${BOLD}Listener watchdog:${RESET}"; sw_watchdog_status 2>&1 | sed 's/^/      /' | head -1
        echo ""
        echo -e "  ${GREEN}1${RESET}) Setup / Recover    ${DIM}(download + init|recover + save pass + start)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Start listener"
        echo -e "  ${RED}3${RESET}) Stop listener"
        echo -e "  ${GREEN}4${RESET}) Show address"
        echo -e "  ${DIM}  ── Auto-restart ──────────────────────────${RESET}"
        echo -e "  ${GREEN}5${RESET}) Enable boot autostart   ${DIM}(per net)${RESET}"
        echo -e "  ${RED}6${RESET}) Disable boot autostart  ${DIM}(per net)${RESET}"
        echo -e "  ${GREEN}7${RESET}) Install listener watchdog ${DIM}(*/5)${RESET}"
        echo -e "  ${RED}8${RESET}) Remove listener watchdog"
        echo -e "  ${DIM}  ── Binary ────────────────────────────────${RESET}"
        echo -e "  ${GREEN}9${RESET}) grin-wallet binary      ${DIM}(update · roll back · verify)${RESET}"
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-9/0]: ${RESET}"
        read -r choice || choice=0          # EOF (Ctrl+D) → 0 → Back
        case "$choice" in
            "") continue ;;                 # Enter → refresh
            1) net=$(_solo_pick_net "wallet setup")   && { sw_setup "$net" || true; };         _solo_pause ;;
            2) net=$(_solo_pick_net "start listener") && { sw_listener_start "$net" || true; }; _solo_pause ;;
            3) net=$(_solo_pick_net "stop listener")  && { sw_listener_stop "$net" || true; };  _solo_pause ;;
            4) net=$(_solo_pick_net "show address")    && { sw_show_address "$net" || true; };   _solo_pause ;;
            5) net=$(_solo_pick_net "boot autostart") && { sw_autostart_enable "$net" || true; };  _solo_pause ;;
            6) net=$(_solo_pick_net "boot autostart") && { sw_autostart_disable "$net" || true; }; _solo_pause ;;
            7) sw_watchdog_install || true; _solo_pause ;;
            8) sw_watchdog_remove  || true; _solo_pause ;;
            9) net=$(_solo_pick_net "grin-wallet binary") && { sw_binary_menu "$net" || true; } ;;
            0) return ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# Watchdogs (global) (network-select ▸ 5) — node-sync, node boot-autostart, wallet listener, stratum.
watchdog_menu() {
    local choice net
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  07) Solo Private Pool $(_solo_mode_word) · Health / Watchdogs${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "${BOLD}  Node-sync watchdog:${RESET}";    gnk_watchdog_status 2>&1 | sed 's/^/    /' | head -2
        echo -e "${BOLD}  Node boot-autostart:${RESET}";   gnk_autostart_status | sed 's/^/    /'
        echo -e "${BOLD}  Wallet-listener watchdog:${RESET}"; sw_watchdog_status 2>&1 | sed 's/^/    /' | head -1
        echo -e "${BOLD}  Stratum watchdog:${RESET}"; solo_stratum_watchdog_status 2>&1 | sed 's/^/    /' | head -1
        echo ""
        echo -e "  ${GREEN}1${RESET}) Install node-sync watchdog    ${DIM}(restarts a wedged node)${RESET}"
        echo -e "  ${RED}2${RESET}) Remove  node-sync watchdog"
        echo -e "  ${GREEN}3${RESET}) Enable  node boot-autostart   ${DIM}(@reboot · per net / both)${RESET}"
        echo -e "  ${RED}4${RESET}) Disable node boot-autostart   ${DIM}(per net / both)${RESET}"
        echo -e "  ${GREEN}5${RESET}) Install wallet-listener watchdog"
        echo -e "  ${RED}6${RESET}) Remove  wallet-listener watchdog"
        echo -e "  ${GREEN}7${RESET}) Install stratum watchdog      ${DIM}(alert if stratum drops)${RESET}"
        echo -e "  ${RED}8${RESET}) Remove  stratum watchdog"
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-8/0]: ${RESET}"
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
            7)  solo_stratum_watchdog_install || true; _solo_pause ;;
            8)  solo_stratum_watchdog_remove  || true; _solo_pause ;;
            0)  return ;;
            *)  warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# Stratum (per-net branch ▸ 2) — Setup & Publish / Manual config / Restrict for
# the branch's network. Pure dispatch — maps action+net to the mainnet/testnet
# wrapper; the network comes from the parent branch (SOLO_NETWORK), not a prompt.
# (Publish is no longer a separate action — Setup flows into it.)
_stratum_dispatch() {
    local action="$1" net="$2"
    case "$action:$net" in
        setup:mainnet)     setup_stratum_mainnet ;;
        setup:testnet)     setup_stratum_testnet ;;
        configure:mainnet) configure_stratum_mainnet ;;
        configure:testnet) configure_stratum_testnet ;;
        restrict:mainnet)  restrict_mainnet_stratum ;;
        restrict:testnet)  restrict_testnet_stratum ;;
    esac
}

stratum_menu() {
    local choice net
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  07) Solo Private Pool $(_solo_mode_word) · [${SOLO_NETWORK^^}] · Stratum Server${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        show_compact_status
        echo -e "  ${GREEN}1${RESET}) Setup & Publish  ${DIM}(enable stratum + wallet URL → bind 0.0.0.0 + firewall + restart — all in one)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Manual config    ${DIM}(hand-edit one field: enable / bind / wallet)${RESET}"
        echo -e "  ${RED}3${RESET}) Restrict         ${DIM}(revert to 127.0.0.1)${RESET}"
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-3/0]: ${RESET}"
        read -r choice || choice=0          # EOF (Ctrl+D) → 0 → Back
        case "$choice" in
            "") continue ;;                 # Enter → refresh
            1) net=$(_solo_pick_net "setup & publish stratum") && { _stratum_dispatch setup "$net"     || true; }; _solo_pause ;;
            2) net=$(_solo_pick_net "manual stratum config")   && { _stratum_dispatch configure "$net" || true; }; _solo_pause ;;
            3) net=$(_solo_pick_net "restrict stratum")        && { _stratum_dispatch restrict "$net"  || true; }; _solo_pause ;;
            0) return ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# Per-network branch — entered from the network-select screen after a net is
# chosen (SOLO_NETWORK set). Holds only the genuinely per-net actions; cross-
# network tools (both-net status, the unified stats page, global watchdogs) stay
# on the network-select screen. Wallet/Stratum keep their own submenus — they
# inherit SOLO_NETWORK instead of prompting per action.
solo_net_menu() {
    local choice label mode_label
    label="Mainnet"; [[ "$SOLO_NETWORK" == "testnet" ]] && label="Testnet"
    mode_label="Internet"; [[ "$SOLO_NET_MODE" == "lan" ]] && mode_label="LAN"
    while true; do
        clear
        if [[ "$SOLO_NETWORK" == "mainnet" ]]; then
            echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
            echo -e "${BOLD}${RED}  07) Solo Private Pool ${mode_label} — [MAINNET — REAL GRIN]${RESET}"
            echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        else
            echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
            echo -e "${BOLD}${CYAN}  07) Solo Private Pool ${mode_label} — [TESTNET]${RESET}"
            echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        fi
        echo ""
        _show_node_info "$SOLO_NETWORK" "$SOLO_API_PORT" "$SOLO_STRATUM_PORT"
        echo -e "  ${GREEN}1${RESET}) Wallet          ${DIM}▸ setup/recover · listener · auto-restart · address${RESET}"
        echo -e "  ${GREEN}2${RESET}) Stratum         ${DIM}▸ setup & publish · manual config · restrict${RESET}"
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
# Returns 0 ONLY when it actually changed the file (so the caller logs + chmods).
_solo_backfill_portcheck_api() {
    local cfg="$1"
    [[ -f "$cfg" ]] || return 1
    python3 - "$cfg" "https://tools.grin.money/tools-api" "https://tools.grin.money/pay-api" <<'PY' || return 1
import json, sys
path, default, old_default = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(path) as f:
        cfg = json.load(f)
except Exception:
    sys.exit(1)                      # missing / corrupt — leave it for the full deploy
if not isinstance(cfg, dict):
    sys.exit(1)
if "portcheck_api" in cfg and cfg["portcheck_api"] != old_default:
    sys.exit(1)                      # custom or disabled — never override
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
    #    backfill the port-check default when the key is absent (or still the retired
    #    pay-api default) — never overwrite the operator's pool name / ports / a
    #    custom portcheck_api value.
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
                success "Port-check default set → $web_dir/data/config.json (portcheck_api=https://tools.grin.money/tools-api)"; did=1
            fi
        done < <(grep -oE -- '--out-dir [^ ]+' "$BLOCK_COLLECTOR_WRAPPER" | awk '{print $2}' | sort -u)
    fi

    # Kick one collection so a refreshed collector's new/changed fields (e.g. the
    # network difficulty_per_block seed the stats page reads) land in the feed NOW
    # instead of waiting up to 5 min for the next cron tick.
    if [[ $did -eq 1 && -x "$BLOCK_COLLECTOR_WRAPPER" ]]; then
        if "$BLOCK_COLLECTOR_WRAPPER" >/dev/null 2>&1; then
            success "Collector run once — stats feed refreshed now."
        else
            warn "Initial collection errored (cron will retry in ≤5 min)."
        fi
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
        echo -e "${BOLD}${RED}  07) Solo Private Pool $(_solo_mode_word) · [MAINNET] · Payouts & Settlement${RESET}"
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
# a cross-network tool (3-7). Numeric keys for main actions; letters per the
# toolkit menu convention: A = guided precheck, C = destructive cleanup
# (Danger Zone).
show_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    if [[ "$SOLO_NET_MODE" == "lan" ]]; then
        echo -e "${BOLD}${CYAN}  07) Grin Mining Service — Solo Private Pool ${DIM}(LAN mode)${RESET}"
    else
        echo -e "${BOLD}${CYAN}  07) Grin Mining Service — Solo Private Pool ${DIM}(Internet mode)${RESET}"
    fi
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    show_compact_status

    echo -e "  ${DIM}─── Set up your solo private pool — top to bottom ────────${RESET}"
    echo -e "  ${GREEN}A${RESET}) Start here — node check      ${DIM}(is your node running & synced?)${RESET}"
    echo -e "  ${GREEN}1${RESET}) Configure solo private pool Mainnet  ${DIM}(real GRIN)${RESET}"
    echo -e "  ${GREEN}2${RESET}) Configure solo private pool Testnet  ${DIM}(tGRIN — no monetary value)${RESET}"
    if [[ "$SOLO_NET_MODE" == "lan" ]]; then
        echo -e "  ${GREEN}3${RESET}) Deploy stats web page        ${DIM}(LAN dashboard · plain HTTP · no domain/SSL)${RESET}"
    else
        echo -e "  ${GREEN}3${RESET}) Deploy stats web page        ${DIM}(public dashboard, both nets)${RESET}"
    fi
    echo ""
    echo -e "  ${DIM}─── Overview & shared tools ──────────────────────${RESET}"
    echo -e "  ${GREEN}4${RESET}) Node, Wallet & Mining Status  ${DIM}(both networks)${RESET}"
    echo -e "  ${GREEN}5${RESET}) Watchdogs (global)            ${DIM}(node-sync · boot autostart · wallet · stratum)${RESET}"
    echo -e "  ${GREEN}6${RESET}) Maintenance                   ${DIM}(encrypted backup · restore · schedule · seed)${RESET}"
    echo -e "  ${GREEN}7${RESET}) Payouts & settlement          ${DIM}(mainnet running balance · record payments)${RESET}"
    echo -e "  ${GREEN}8${RESET}) Quiet hours (energy saver)    ${DIM}(auto-pause stratum in set hours · miners idle)${RESET}"
    echo ""
    echo -e "  ${DIM}─── Danger Zone ──────────────────────────────────${RESET}"
    echo -e "  ${RED}C${RESET}) Clean up solo mining  ${DIM}(remove solo infra · keeps node + seed + backups)${RESET}"
    echo ""
    echo -e "  ${DIM}↩  Press Enter to refresh${RESET}"
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -ne "${BOLD}Select [A/1-8/C/0]: ${RESET}"
}

# Detect the mode of an already-deployed solo stats page by inspecting its vhost.
# Echoes "Internet" or "LAN"; echoes nothing when no stats page is deployed (only
# the stratum is set up → no stats vhost to clash with). Mirrors the hub's
# hub_detect_solo_mode: a LAN deploy binds `listen <ipv4>:<port>`, Internet uses
# bare `listen 80`/`443` with an FQDN server_name.
_solo_detect_deployed_mode() {
    local vhost="/etc/nginx/sites-available/$STATS_BASENAME"
    [[ -f "$vhost" ]] || return 0
    if grep -qE 'listen[[:space:]]+[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]+' "$vhost" 2>/dev/null; then
        echo "LAN"
    else
        echo "Internet"
    fi
}

main() {
    # Optional launch mode (mirrors Script 07 pool's singlebox|hub arg):
    #   lan → serve the stats page over plain HTTP on a LAN IP:port (no domain/SSL).
    # Any other value (or none) keeps the default public domain + certbot flow.
    case "${1:-}" in
        lan) SOLO_NET_MODE="lan" ;;
    esac

    # Direct-launch mode guard. Skipped when launched via the mining hub (it sets
    # SOLO_LAUNCHED_VIA_HUB and runs its own Internet/LAN switch confirmation, so we
    # don't prompt twice). Internet and LAN are the same solo product — only the
    # stats page differs — so warn before a switch that would overwrite the
    # already-deployed stats vhost.
    if [[ -z "${SOLO_LAUNCHED_VIA_HUB:-}" ]]; then
        local _want_mode _cur_mode _ans
        _want_mode="Internet"; [[ "$SOLO_NET_MODE" == "lan" ]] && _want_mode="LAN"
        _cur_mode=$(_solo_detect_deployed_mode)
        if [[ -n "$_cur_mode" && "$_cur_mode" != "$_want_mode" ]]; then
            echo ""
            warn "Solo stats page is already deployed in ${_cur_mode} mode, but you launched ${_want_mode} mode."
            warn "Internet and LAN are the same solo setup — only the stats page differs."
            warn "Deploying the stats page in ${_want_mode} mode rewrites the ${_cur_mode} vhost (and its URL/SSL)."
            echo ""
            echo -ne "${BOLD}Continue in ${_want_mode} mode? [y/N]: ${RESET}"
            read -r _ans || _ans=""
            if [[ "${_ans,,}" != "y" ]]; then
                info "Cancelled — keeping ${_cur_mode} mode. Re-launch in ${_cur_mode} mode to manage it."
                return 0
            fi
        fi
    fi

    while true; do
        show_menu
        read -r choice || choice=0          # EOF (Ctrl+D) → 0 → Back to main menu

        # Every action is guarded with `|| true`: this is an interactive dispatch
        # loop, so a cancelled/failed action (e.g. "TOML not found" → `... || return`)
        # must drop back to the menu, never hard-exit the script under `set -e`.
        # 1/2 enter a per-net branch: SOLO_NETWORK is set for its duration and
        # cleared on return, so the global Watchdogs menu (5) still prompts for
        # which net to act on. A, 3-8 and C are cross-network and run at the top level.
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
            8)   quiet_hours_menu || true ;;
            c)   solo_cleanup || true; _solo_pause ;;
            0)   break ;;
            *)   warn "Invalid option."; sleep 1 ;;
        esac
        # Branches/submenus run their own loops + pauses; one-shot actions pause
        # via _solo_pause (3, C) or inline (status view 4). A pauses inside
        # solo_node_precheck itself.
    done
}

main "$@"
