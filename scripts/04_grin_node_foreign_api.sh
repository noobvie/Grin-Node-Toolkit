#!/bin/bash
# =============================================================================
# 04_grin_node_foreign_api.sh - Grin Node Services Manager
# =============================================================================
# Manages Grin node-facing services:
#   · Node Public API  (port 3413 / 13413) — nginx HTTPS reverse proxy, /v2/foreign only
#   · Stratum Mining   (port 3416 / 13416) — direct bind (patches grin-server.toml)
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
NODE_API_PORT_MAINNET=3413
NODE_API_PORT_TESTNET=13413
STRATUM_PORT_MAINNET=3416
STRATUM_PORT_TESTNET=13416
NODE_API_NGINX_CONF_MAINNET="/etc/nginx/sites-available/grin-node-api"
NODE_API_NGINX_CONF_TESTNET="/etc/nginx/sites-available/grin-node-api-testnet"
LOG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/log"
LOG_FILE="$LOG_DIR/grin_node_services_$(date +%Y%m%d_%H%M%S).log"

# ─── Logging ──────────────────────────────────────────────────────────────────
mkdir -p "$LOG_DIR"
log()     { echo -e "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; log "[INFO] $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; log "[OK] $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; log "[WARN] $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; log "[ERROR] $*"; }

# ─── Port guide popup ─────────────────────────────────────────────────────────
show_port_guide() {
    local port="$1"
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  PORT GUIDE — Read before continuing${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    case "$port" in
        3413|13413)
            local label="Mainnet"
            [[ "$port" == "13413" ]] && label="Testnet"
            echo -e "  ${BOLD}PORT $port — Grin $label Node Public API (V2 JSON-RPC)${RESET}"
            echo ""
            echo -e "  ${CYAN}What it does${RESET} : Lets external tools query your node — block headers,"
            echo -e "               chain tip, transaction pool, kernel lookups,"
            echo -e "               and push transactions."
            echo -e "  ${CYAN}Who needs it${RESET} : Light wallets, block explorers, developers building on Grin."
            echo -e "  ${CYAN}Expose via${RESET}   : nginx HTTPS reverse proxy — only /v2/foreign path is"
            echo -e "               exposed. The admin endpoint (/v2/owner) is always blocked."
            echo -e "  ${GREEN}Expose if${RESET}    : You want to contribute a public API endpoint to the community."
            echo -e "  ${YELLOW}Skip if${RESET}      : You are running a private node for personal use only."
            ;;
        3416|13416)
            local label="Mainnet"
            [[ "$port" == "13416" ]] && label="Testnet"
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
            ;;
    esac
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
# TOML DETECTION — locate grin-server.toml for the given network
# ═══════════════════════════════════════════════════════════════════════════════
# Primary: resolve via /proc/$pid/exe of the running grin process on api_port.
# Fallback: scan known toolkit dirs (/grin<mode><net>/) and ~/.grin/<net>/.
# Sets global FOUND_GRIN_TOML on success; returns 1 on failure.
# Mirrors the detection logic used in script 03.
# ═══════════════════════════════════════════════════════════════════════════════

# Search paths used when the node is not currently running.
# Mirrors the directory names that script 01 creates.
_KNOWN_TOML_SEARCH_PATHS=(
    /grinfullmain    /grinprunemain
    /grinfulltest    /grinprunetest
    "${HOME}/.grin/main"   "${HOME}/.grin/test"
    /root/.grin/main       /root/.grin/test
)

# Returns the toml path via stdout; used by show_all_status (no interaction).
_resolve_stratum_toml() {
    local network="$1" api_port="$2"
    local expected_chain_type="Mainnet"
    [[ "$network" == "testnet" ]] && expected_chain_type="Testnet"

    # 1. Try via running process
    local pid exe dir
    pid=$(ss -tlnp 2>/dev/null | grep ":$api_port " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
    if [[ -n "$pid" ]]; then
        exe=$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)
        if [[ -n "$exe" ]]; then
            dir=$(dirname "$exe")
            [[ -f "$dir/grin-server.toml" ]] && echo "$dir/grin-server.toml" && return 0
        fi
    fi

    # 2. Scan known directories
    local dir f
    for dir in "${_KNOWN_TOML_SEARCH_PATHS[@]}"; do
        f="$dir/grin-server.toml"
        [[ -f "$f" ]] || continue
        grep -qiE "chain_type\s*=\s*[\"']?$expected_chain_type" "$f" 2>/dev/null \
            && echo "$f" && return 0
    done

    return 1
}

# Interactive version: resolves or prompts.  Sets FOUND_GRIN_TOML.
find_grin_server_toml() {
    local network="$1" api_port="$2"
    local expected_chain_type="Mainnet"
    [[ "$network" == "testnet" ]] && expected_chain_type="Testnet"

    FOUND_GRIN_TOML=""

    # 1. Try via running process
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

    # 2. Scan known directories
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

    # 3. Ask user
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
# LEGACY CLEANUP — remove nginx stream block added by old versions of this script
# ═══════════════════════════════════════════════════════════════════════════════
# Earlier versions used nginx stream module (TCP proxy) for stratum. That approach
# added a "stream { include /etc/nginx/stream.d/*.conf; }" block to nginx.conf and
# a file at /etc/nginx/stream.d/grin-stratum.conf.
# The new approach uses a direct grin-server.toml bind, so these must be removed
# before any nginx -t call — otherwise nginx fails with "unknown directive stream".
# ═══════════════════════════════════════════════════════════════════════════════

_remove_legacy_stream_config() {
    local nginx_conf="/etc/nginx/nginx.conf"
    local changed=0

    # Remove old stream conf files
    for f in /etc/nginx/stream.d/grin-stratum.conf \
              /etc/nginx/stream.d/grin-stratum-testnet.conf; do
        if [[ -f "$f" ]]; then
            rm -f "$f"
            info "Removed legacy stream config: $f"
            log  "Removed legacy stream config: $f"
            changed=1
        fi
    done

    # Remove the stream block from nginx.conf only if it carries our comment marker.
    # Pattern: "# Grin Node Toolkit — stream proxies (TCP)\nstream {\n...\n}"
    if grep -q "Grin Node Toolkit.*stream proxies" "$nginx_conf" 2>/dev/null; then
        local backup="${nginx_conf}.bak.$(date +%s)"
        cp "$nginx_conf" "$backup"
        python3 - << PYEOF
import re
with open('$nginx_conf') as fh:
    txt = fh.read()
# Remove the block: comment line + stream { ... }
txt = re.sub(
    r'\n?# Grin Node Toolkit[^\n]*stream proxies[^\n]*\nstream \{[^}]*\}',
    '', txt)
with open('$nginx_conf', 'w') as fh:
    fh.write(txt)
PYEOF
        info "Removed legacy stream block from $nginx_conf (backup: $backup)"
        log  "Removed legacy stream block from $nginx_conf (backup: $backup)"
        changed=1
    fi

    [[ "$changed" -eq 1 ]] && return 0
    return 0   # nothing to do — not an error
}

# ═══════════════════════════════════════════════════════════════════════════════
# STATUS DISPLAY
# ═══════════════════════════════════════════════════════════════════════════════

stratum_bind_status() {
    local toml="$1" port="$2"
    if [[ ! -f "$toml" ]]; then
        echo -e "    toml config: ${DIM}not found${RESET}"
        return
    fi
    local addr
    addr=$(grep -E '^[[:space:]]*stratum_server_addr[[:space:]]*=' "$toml" 2>/dev/null \
           | sed 's/.*=[[:space:]]*//' | tr -d '"' | xargs 2>/dev/null || true)
    if [[ "$addr" == "0.0.0.0:$port" ]]; then
        echo -e "    toml bind  : ${GREEN}PUBLIC${RESET}   ${DIM}(0.0.0.0:$port — miners can connect)${RESET}"
    elif [[ "$addr" == "127.0.0.1:$port" ]]; then
        echo -e "    toml bind  : ${YELLOW}LOCAL${RESET}    ${DIM}(127.0.0.1:$port — localhost only)${RESET}"
    else
        echo -e "    toml bind  : ${DIM}${addr:-not set}${RESET}"
    fi
}

show_all_status() {
    echo -e "\n${BOLD}Service Status:${RESET}\n"

    # ── Mainnet Node API (3413) ──
    echo -e "  ${BOLD}Node Public API — Mainnet (port $NODE_API_PORT_MAINNET):${RESET}"
    if ss -tlnp 2>/dev/null | grep -q ":$NODE_API_PORT_MAINNET "; then
        echo -e "    Grin port  : ${GREEN}LISTENING${RESET}"
    else
        echo -e "    Grin port  : ${RED}NOT LISTENING${RESET}  ${DIM}(mainnet node not running?)${RESET}"
    fi
    if [[ -f "/etc/nginx/sites-enabled/grin-node-api" ]]; then
        echo -e "    nginx proxy: ${GREEN}CONFIGURED${RESET}"
    else
        echo -e "    nginx proxy: ${DIM}not configured${RESET}"
    fi
    echo ""

    # ── Testnet Node API (13413) ──
    echo -e "  ${BOLD}Node Public API — Testnet (port $NODE_API_PORT_TESTNET):${RESET}"
    if ss -tlnp 2>/dev/null | grep -q ":$NODE_API_PORT_TESTNET "; then
        echo -e "    Grin port  : ${GREEN}LISTENING${RESET}"
    else
        echo -e "    Grin port  : ${RED}NOT LISTENING${RESET}  ${DIM}(testnet node not running?)${RESET}"
    fi
    if [[ -f "/etc/nginx/sites-enabled/grin-node-api-testnet" ]]; then
        echo -e "    nginx proxy: ${GREEN}CONFIGURED${RESET}"
    else
        echo -e "    nginx proxy: ${DIM}not configured${RESET}"
    fi
    echo ""

    # ── Mainnet Stratum (3416) ──
    echo -e "  ${BOLD}Stratum Mining — Mainnet (port $STRATUM_PORT_MAINNET):${RESET}"
    if ss -tlnp 2>/dev/null | grep -q ":$STRATUM_PORT_MAINNET "; then
        echo -e "    Grin port  : ${GREEN}LISTENING${RESET}"
    else
        echo -e "    Grin port  : ${RED}NOT LISTENING${RESET}  ${DIM}(stratum disabled or mainnet node not running)${RESET}"
    fi
    stratum_bind_status "$(_resolve_stratum_toml mainnet $NODE_API_PORT_MAINNET || true)" "$STRATUM_PORT_MAINNET"
    echo ""

    # ── Testnet Stratum (13416) ──
    echo -e "  ${BOLD}Stratum Mining — Testnet (port $STRATUM_PORT_TESTNET):${RESET}"
    if ss -tlnp 2>/dev/null | grep -q ":$STRATUM_PORT_TESTNET "; then
        echo -e "    Grin port  : ${GREEN}LISTENING${RESET}"
    else
        echo -e "    Grin port  : ${RED}NOT LISTENING${RESET}  ${DIM}(stratum disabled or testnet node not running)${RESET}"
    fi
    stratum_bind_status "$(_resolve_stratum_toml testnet $NODE_API_PORT_TESTNET || true)" "$STRATUM_PORT_TESTNET"
    echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
# NODE API — nginx HTTPS reverse proxy (/v2/foreign)
# ═══════════════════════════════════════════════════════════════════════════════

_enable_node_api_nginx() {
    local network="$1" port="$2" nginx_conf="$3" nginx_symlink="$4"

    show_port_guide "$port" || return
    echo -e "\n${BOLD}${CYAN}── Node Public API ($network, port $port) — nginx HTTPS Setup ──${RESET}\n"
    echo -e "  Exposes ${BOLD}/v2/foreign${RESET} (JSON-RPC: block queries + tx push)"
    echo -e "  Blocks  ${BOLD}/v2/owner${RESET}   (admin endpoints stay private)"
    echo ""

    if ! command -v nginx &>/dev/null; then
        warn "nginx is not installed. Install it first via 'Manage Nginx Server'."
        return
    fi

    if ! command -v certbot &>/dev/null; then
        warn "certbot is not installed: apt-get install certbot python3-certbot-nginx"
        return
    fi

    if ! ss -tlnp 2>/dev/null | grep -q ":$port "; then
        warn "Port $port is not listening. Make sure your Grin $network node is running."
        echo -ne "Continue anyway? [y/N/0]: "
        read -r cont
        [[ "${cont,,}" != "y" ]] && return
    fi

    echo -ne "Domain for the $network Node API (e.g. api.example.com) or 0 to cancel: "
    read -r domain
    [[ "$domain" == "0" ]] && return
    [[ -z "$domain" ]] && warn "No domain entered. Aborting." && return

    echo -ne "Email for Let's Encrypt SSL certificate (or 0 to cancel): "
    read -r email
    [[ "$email" == "0" ]] && return
    [[ -z "$email" ]] && warn "No email entered. Aborting." && return

    log "Node API nginx setup started: network=$network port=$port domain=$domain"

    # Remove any legacy stream block left by old versions of this script.
    # If present, nginx -t would fail with "unknown directive stream".
    _remove_legacy_stream_config

    # Write HTTP-only config first — certbot will add the SSL block itself.
    # Writing SSL cert paths before certbot runs causes nginx -t to fail.
    cat > "$nginx_conf" << EOF
server {
    listen 80;
    server_name $domain;

    # Public V2 Foreign API — JSON-RPC: get_tip, get_block, get_header,
    # get_kernel, push_transaction, get_peers_connected
    location /v2/foreign {
        proxy_pass         http://127.0.0.1:$port/v2/foreign;
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60;
    }

    # Block all other paths — owner/admin API stays private
    location / {
        return 403 "Access denied. Only /v2/foreign is exposed.";
    }
}
EOF

    ln -sf "$nginx_conf" "/etc/nginx/sites-enabled/$nginx_symlink" 2>/dev/null || true

    if ! nginx -t; then
        error "nginx config test failed. Check $nginx_conf"
        return
    fi
    systemctl reload nginx

    info "Requesting Let's Encrypt SSL certificate for $domain..."
    certbot --nginx -d "$domain" --non-interactive --agree-tos -m "$email" \
        || { warn "certbot failed — check /var/log/letsencrypt/letsencrypt.log"; return; }

    systemctl reload nginx

    success "Node Public API ($network) nginx proxy configured!"
    echo ""
    info "Endpoint    : https://$domain/v2/foreign"
    info "nginx config: $nginx_conf"
    echo ""
    echo -e "  ${BOLD}Test commands:${RESET}"
    echo ""
    echo "    # Get chain tip"
    echo "    curl -s -X POST https://$domain/v2/foreign \\"
    echo "         -H 'Content-Type: application/json' \\"
    echo "         -d '{\"jsonrpc\":\"2.0\",\"method\":\"get_tip\",\"params\":[],\"id\":1}'"
    echo ""
    echo "    # Get node version"
    echo "    curl -X POST https://$domain/v2/foreign \\"
    echo "         -H 'Content-Type: application/json' \\"
    echo "         -d '{\"jsonrpc\":\"2.0\",\"method\":\"get_version\",\"params\":{},\"id\":1}'"
    echo ""
    info "Log file    : $LOG_FILE"
    log "nginx $network node API proxy configured: domain=$domain config=$nginx_conf -> 127.0.0.1:$port/v2/foreign"
    log "Test: curl -s -X POST https://$domain/v2/foreign -H 'Content-Type: application/json' -d '{\"jsonrpc\":\"2.0\",\"method\":\"get_tip\",\"params\":[],\"id\":1}'"
    log "Test: curl -X POST https://$domain/v2/foreign -H 'Content-Type: application/json' -d '{\"jsonrpc\":\"2.0\",\"method\":\"get_version\",\"params\":{},\"id\":1}'"
}

enable_mainnet_node_api() {
    _enable_node_api_nginx mainnet "$NODE_API_PORT_MAINNET" \
        "$NODE_API_NGINX_CONF_MAINNET" "grin-node-api"
}

enable_testnet_node_api() {
    _enable_node_api_nginx testnet "$NODE_API_PORT_TESTNET" \
        "$NODE_API_NGINX_CONF_TESTNET" "grin-node-api-testnet"
}

_disable_node_api_nginx() {
    local network="$1" nginx_conf="$2" nginx_symlink="$3"
    echo -e "\n${BOLD}${CYAN}── Remove Node API nginx Proxy ($network) ──${RESET}\n"

    # Clean up legacy stream config first so nginx -t won't fail.
    _remove_legacy_stream_config

    if [[ ! -f "$nginx_conf" ]]; then
        warn "No nginx config found at $nginx_conf. Nothing to remove."
        return
    fi

    rm -f "/etc/nginx/sites-enabled/$nginx_symlink"
    rm -f "$nginx_conf"

    if nginx -t; then
        systemctl reload nginx
    else
        warn "nginx config test failed after removal — reload skipped. Check nginx manually."
    fi

    success "Node API ($network) nginx proxy removed."
    log "Node API ($network) nginx proxy removed."
}

disable_mainnet_node_api() {
    _disable_node_api_nginx mainnet "$NODE_API_NGINX_CONF_MAINNET" "grin-node-api"
}

disable_testnet_node_api() {
    _disable_node_api_nginx testnet "$NODE_API_NGINX_CONF_TESTNET" "grin-node-api-testnet"
}

# ═══════════════════════════════════════════════════════════════════════════════
# STRATUM MINING — Direct bind (patches grin-server.toml)
# ═══════════════════════════════════════════════════════════════════════════════
# Patches stratum_server_addr in grin-server.toml from 127.0.0.1:PORT to
# 0.0.0.0:PORT (expose) or back (restrict). Requires graceful node restart.
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
# Mirrors the detect_grin_binary() + restart_grin_node() pattern from script 03:
#   — binary path read from /proc/$pid/exe BEFORE the process is killed
#   — old tmux session killed, new session created with the same binary
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

    # ── Capture binary path BEFORE killing (readable only while process is alive) ──
    local grin_binary grin_dir
    grin_binary=$(readlink -f "/proc/$grin_pid/exe" 2>/dev/null || true)
    if [[ -z "$grin_binary" || ! -f "$grin_binary" ]]; then
        warn "Could not read binary path from /proc/$grin_pid/exe."
        info "grin-server.toml has been patched. Restart the node manually."
        return 0
    fi
    grin_dir=$(dirname "$grin_binary")

    # Best-effort: find the existing tmux session for session name reuse.
    local target_session=""
    target_session=$(_find_grin_session_for_pid "$grin_pid" 2>/dev/null || true)

    # ── Confirm restart ────────────────────────────────────────────────────────
    echo ""
    warn "Grin node restart required for the stratum config change to take effect."
    echo -ne "Restart grin $network node now? [Y/n/0]: "
    read -r do_restart
    if [[ "$do_restart" == "0" || "${do_restart,,}" == "n" ]]; then
        info "Restart manually when ready. grin-server.toml has already been patched."
        return 0
    fi

    # ── Stop ──────────────────────────────────────────────────────────────────
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

    # ── Restart in a fresh tmux session ───────────────────────────────────────
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

_enable_stratum() {
    local network="$1" stratum_port="$2" api_port="$3"

    show_port_guide "$stratum_port" || return
    echo -e "\n${BOLD}${CYAN}── Expose Stratum Mining ($network, port $stratum_port) ──${RESET}\n"
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
    log "Stratum ($network) enabled: patched $grin_toml -> 0.0.0.0:$stratum_port"

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

enable_mainnet_stratum()  { _enable_stratum  mainnet "$STRATUM_PORT_MAINNET" "$NODE_API_PORT_MAINNET"; }
enable_testnet_stratum()  { _enable_stratum  testnet "$STRATUM_PORT_TESTNET" "$NODE_API_PORT_TESTNET"; }
disable_mainnet_stratum() { _disable_stratum mainnet "$STRATUM_PORT_MAINNET" "$NODE_API_PORT_MAINNET"; }
disable_testnet_stratum() { _disable_stratum testnet "$STRATUM_PORT_TESTNET" "$NODE_API_PORT_TESTNET"; }

# ═══════════════════════════════════════════════════════════════════════════════
# MENU
# ═══════════════════════════════════════════════════════════════════════════════

show_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Grin Node Services Manager${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    show_all_status

    echo -e "${DIM}  ─── Node Public API — Mainnet (port $NODE_API_PORT_MAINNET) ─────────────${RESET}"
    echo -e "  ${GREEN}1${RESET}) Enable via nginx     ${DIM}(/v2/foreign, HTTPS)${RESET}"
    echo -e "  ${RED}2${RESET}) Remove nginx proxy"
    echo ""
    echo -e "${DIM}  ─── Node Public API — Testnet (port $NODE_API_PORT_TESTNET) ────────────${RESET}"
    echo -e "  ${GREEN}3${RESET}) Enable via nginx     ${DIM}(/v2/foreign, HTTPS)${RESET}"
    echo -e "  ${RED}4${RESET}) Remove nginx proxy"
    echo ""
    echo -e "${DIM}  ─── Stratum Mining — Mainnet (port $STRATUM_PORT_MAINNET) ─────────────${RESET}"
    echo -e "  ${GREEN}5${RESET}) Expose stratum       ${DIM}(patch .toml + restart)${RESET}"
    echo -e "  ${RED}6${RESET}) Restrict stratum     ${DIM}(revert to localhost)${RESET}"
    echo ""
    echo -e "${DIM}  ─── Stratum Mining — Testnet (port $STRATUM_PORT_TESTNET) ────────────${RESET}"
    echo -e "  ${GREEN}7${RESET}) Expose stratum       ${DIM}(patch .toml + restart)${RESET}"
    echo -e "  ${RED}8${RESET}) Restrict stratum     ${DIM}(revert to localhost)${RESET}"
    echo ""
    echo -e "  ${DIM}↩  Press Enter to refresh status${RESET}"
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -ne "${BOLD}Select [0-8]: ${RESET}"
}

main() {
    while true; do
        show_menu
        read -r choice

        case "$choice" in
            "") continue ;;  # bare Enter = refresh status display
            1) enable_mainnet_node_api ;;
            2) disable_mainnet_node_api ;;
            3) enable_testnet_node_api ;;
            4) disable_testnet_node_api ;;
            5) enable_mainnet_stratum ;;
            6) disable_mainnet_stratum ;;
            7) enable_testnet_stratum ;;
            8) disable_testnet_stratum ;;
            0) break ;;
            *) warn "Invalid option." ; sleep 1 ;;
        esac

        echo ""
        echo "Press Enter to continue..."
        read -r
    done
}

main "$@"
