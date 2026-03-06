#!/bin/bash
# =============================================================================
# 04_grin_node_foreign_api.sh - Grin Node Services Manager
# =============================================================================
# Manages Grin node-facing services:
#   · Node Public API  (port 3413 / 13413) — nginx HTTPS reverse proxy, /v2/foreign only
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
# MENU
# ═══════════════════════════════════════════════════════════════════════════════

show_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  04) Grin Node Services Manager${RESET}"
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
    echo -e "  ${DIM}↩  Press Enter to refresh status${RESET}"
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -ne "${BOLD}Select [0-4]: ${RESET}"
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
            0) break ;;
            *) warn "Invalid option." ; sleep 1 ;;
        esac

        echo ""
        echo "Press Enter to continue..."
        read -r
    done
}

main "$@"
