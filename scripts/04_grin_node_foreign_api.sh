#!/bin/bash
# =============================================================================
# 04_grin_node_foreign_api.sh — Grin Node API Services Manager
# =============================================================================
# Manages all public-facing services for a Grin node:
#
#   1 / 3)  nginx HTTPS reverse proxy  (/v2/foreign, JSON-RPC)
#             · Exposes only the read-only foreign API — owner API stays private
#             · CORS enabled so any website can query the endpoint from a browser
#             · Rate-limited (10 r/s, burst 20) to protect the node
#
#   5 / 7)  Live status page  (https://domain/)
#             · HTML dashboard showing height, difficulty, supply, hash, versions
#             · Auto-refreshes every 60 s; dark/light theme; mobile-friendly
#             · Served as static files — zero extra server load per visitor
#             · Includes Developer section: CORS test, fetch snippets, remote checker
#
#   9 / 11) REST API  (https://domain/rest/)
#             · Simple GET endpoints returning clean JSON — no JSON-RPC knowledge needed
#             · Ideal for: CoinGecko, Google Sheets, no-code tools, website widgets
#             · Static JSON files refreshed every 60 s by a cron job (www-data)
#             · Endpoints: /rest/stats.json  /rest/supply.json  /rest/height.json
#                          /rest/difficulty.json  /rest/emission.json
#             · CORS enabled; Cache-Control: public, max-age=60
#             · Requires: status page deployed (option 5 / 7) first
#
# Networks:  mainnet (port 3413)  ·  testnet (port 13413)
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

# Status page source (repo) and deploy (live web root) paths
STATUS_PAGE_SRC="$(cd "$SCRIPT_DIR/.." && pwd)/web/04/public_html"
STATUS_PAGE_DEPLOY_MAINNET="/var/www/grin-node-api"
STATUS_PAGE_DEPLOY_TESTNET="/var/www/grin-node-api-testnet"

# REST API — static JSON files written by cron, served by nginx under /rest/
REST_API_DIR_MAINNET="$STATUS_PAGE_DEPLOY_MAINNET/rest"
REST_API_DIR_TESTNET="$STATUS_PAGE_DEPLOY_TESTNET/rest"
REST_COLLECTOR_SRC="$(cd "$SCRIPT_DIR/.." && pwd)/web/04/rest-collector.py"
REST_COLLECTOR_DEST="/usr/local/lib/grin-node-toolkit/rest-collector.py"
REST_CRON_MAINNET="/etc/cron.d/grin-node-api-rest"
REST_CRON_TESTNET="/etc/cron.d/grin-node-api-rest-testnet"

# node-collector.py runs as the grin OS user to access privileged data:
#   · owner API (.api_secret) for connected peer count
#   · du on chain_data/ for chain size
#   · grin-server.toml for archive_mode
# Writes node.json to the REST dir (grin user has group-write via www-data group).
NODE_COLLECTOR_SRC="$(cd "$SCRIPT_DIR/.." && pwd)/web/04/node-collector.py"
NODE_COLLECTOR_DEST="/usr/local/lib/grin-node-toolkit/node-collector.py"
NODE_CRON_MAINNET="/etc/cron.d/grin-node-api-node"
NODE_CRON_TESTNET="/etc/cron.d/grin-node-api-node-testnet"

# Grin instance conf — written by script 01, read here to find actual data dirs.
CONF_DIR="$SCRIPT_DIR/../conf"
INSTANCES_CONF="$CONF_DIR/grin_instances_location.conf"

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
# STATUS PAGE HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

# Read server_name from an nginx site config
_nginx_domain() {
    grep -m1 'server_name' "$1" 2>/dev/null | awk '{print $2}' | tr -d ';'
}

# Add limit_req_zone for grin_api into the http {} block of nginx.conf.
# Idempotent — only adds if our marker comment is absent.
_nginx_add_limit_req_zone() {
    local nginx_conf="/etc/nginx/nginx.conf"
    grep -q "zone=grin_api" "$nginx_conf" 2>/dev/null && return 0
    python3 - "$nginx_conf" << 'PYEOF'
import sys, re
conf_file = sys.argv[1]
with open(conf_file) as fh:
    txt = fh.read()
if 'zone=grin_api' in txt:
    sys.exit(0)
insert = (
    '\n    # Grin Node Toolkit — rate-limit zone for /v2/foreign\n'
    '    limit_req_zone $binary_remote_addr zone=grin_api:10m rate=10r/s;\n'
)
idx = txt.find('http {')
if idx == -1:
    idx = txt.find('http{')
if idx == -1:
    print('ERROR: http { block not found in ' + conf_file, file=sys.stderr)
    sys.exit(1)
nl = txt.find('\n', idx)
txt = txt[:nl] + insert + txt[nl:]
with open(conf_file, 'w') as fh:
    fh.write(txt)
PYEOF
}

# Remove the limit_req_zone added by this script (marker-guarded).
_nginx_remove_limit_req_zone() {
    local nginx_conf="/etc/nginx/nginx.conf"
    grep -q "Grin Node Toolkit.*rate-limit zone" "$nginx_conf" 2>/dev/null || return 0
    python3 - "$nginx_conf" << 'PYEOF'
import sys, re
conf_file = sys.argv[1]
with open(conf_file) as fh:
    txt = fh.read()
txt = re.sub(
    r'\n    # Grin Node Toolkit[^\n]*rate-limit zone[^\n]*\n    limit_req_zone[^\n]*zone=grin_api[^\n]*\n',
    '\n', txt)
with open(conf_file, 'w') as fh:
    fh.write(txt)
PYEOF
}

# Patch (or unpatch) an nginx site config for the status page.
#   action=enable  — replace the 403 location / with static serve + security headers + rate limit
#   action=disable — reverse the above
_nginx_patch_status() {
    local nginx_conf="$1" deploy_dir="$2" action="$3"
    python3 - "$nginx_conf" "$deploy_dir" "$action" << 'PYEOF'
import sys
conf_file, deploy_dir, action = sys.argv[1], sys.argv[2], sys.argv[3]
with open(conf_file) as fh:
    txt = fh.read()

# ── Exact strings written by _enable_node_api_nginx ───────────────────────────
OLD_LOC = (
    '    # Block all other paths — owner/admin API stays private\n'
    '    location / {\n'
    '        return 403 "Access denied. Only /v2/foreign is exposed.";\n'
    '    }')

NEW_LOC = (
    '    # Security headers — added by Grin Node Toolkit status page\n'
    '    add_header X-Content-Type-Options  "nosniff"     always;\n'
    '    add_header X-Frame-Options         "DENY"        always;\n'
    '    add_header Referrer-Policy         "no-referrer" always;\n'
    '    add_header Content-Security-Policy'
    ' "default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'self\'" always;\n'
    '\n'
    '    # Static web root — Grin Node Toolkit status page\n'
    '    root ' + deploy_dir + ';\n'
    '    autoindex off;\n'
    '\n'
    '    # Block hidden files and directories (.git, .env, etc.)\n'
    '    location ~ /\\. {\n'
    '        deny all;\n'
    '    }\n'
    '\n'
    '    # Serve only known static asset types\n'
    '    location ~* \\.(html|css|js|svg|ico|png)$ {\n'
    '        try_files $uri =404;\n'
    '        add_header Cache-Control "public, max-age=3600";\n'
    '    }\n'
    '\n'
    '    # Root path — serve index.html only\n'
    '    location = / {\n'
    '        try_files /index.html =404;\n'
    '    }\n'
    '\n'
    '    # Block everything else\n'
    '    location / {\n'
    '        return 403;\n'
    '    }')

OLD_PROXY_TAIL = '        proxy_read_timeout 60;\n    }'
NEW_PROXY_TAIL = '        proxy_read_timeout 60;\n        limit_req          zone=grin_api burst=20 nodelay;\n    }'

if action == 'enable':
    if OLD_LOC in txt:
        txt = txt.replace(OLD_LOC, NEW_LOC)
    if OLD_PROXY_TAIL in txt and NEW_PROXY_TAIL not in txt:
        txt = txt.replace(OLD_PROXY_TAIL, NEW_PROXY_TAIL)
elif action == 'disable':
    if NEW_LOC in txt:
        txt = txt.replace(NEW_LOC, OLD_LOC)
    if NEW_PROXY_TAIL in txt:
        txt = txt.replace(NEW_PROXY_TAIL, OLD_PROXY_TAIL)

with open(conf_file, 'w') as fh:
    fh.write(txt)
PYEOF
}

# Patch (or unpatch) an nginx site config to add /rest/ GET endpoints.
# Inserts two location blocks immediately before the final "location / { return 403; }"
# catch-all that is written by _nginx_patch_status (status page must exist first).
#   action=enable  — insert REST location blocks
#   action=disable — remove REST location blocks
_nginx_patch_rest() {
    local nginx_conf="$1" action="$2"
    python3 - "$nginx_conf" "$action" << 'PYEOF'
import sys
conf_file, action = sys.argv[1], sys.argv[2]
with open(conf_file) as fh:
    txt = fh.read()

# Anchor: the final catch-all written by _nginx_patch_status (status page block)
CATCH_ALL = (
    '    # Block everything else\n'
    '    location / {\n'
    '        return 403;\n'
    '    }')

# REST location blocks to insert before the catch-all
REST_BLOCK = (
    '    # ── REST API — static JSON files, refreshed every 60 s by cron ──────────\n'
    '    #   GET /rest/stats.json       height, supply, difficulty, hash, versions\n'
    '    #   GET /rest/supply.json      circulating supply (height × 60)\n'
    '    #   GET /rest/height.json      block height\n'
    '    #   GET /rest/difficulty.json  total network difficulty\n'
    '    #   GET /rest/emission.json    emission schedule (static)\n'
    '    location ~* ^/rest/[^/]+\\.json$ {\n'
    '        add_header Content-Type         "application/json; charset=utf-8" always;\n'
    '        add_header Access-Control-Allow-Origin  "*" always;\n'
    '        add_header Access-Control-Allow-Methods "GET, OPTIONS" always;\n'
    '        add_header Cache-Control        "public, max-age=60" always;\n'
    '        try_files $uri =404;\n'
    '    }\n'
    '\n'
    '    location /rest/ { return 403; }  # block directory listing\n'
    '\n')

if action == 'enable':
    if REST_BLOCK not in txt and CATCH_ALL in txt:
        txt = txt.replace(CATCH_ALL, REST_BLOCK + CATCH_ALL)
elif action == 'disable':
    if REST_BLOCK in txt:
        txt = txt.replace(REST_BLOCK, '')

with open(conf_file, 'w') as fh:
    fh.write(txt)
PYEOF
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
    if [[ -f "$STATUS_PAGE_DEPLOY_MAINNET/index.html" ]]; then
        local _mn_dom; _mn_dom=$(_nginx_domain "$NODE_API_NGINX_CONF_MAINNET")
        echo -e "    status page: ${GREEN}ENABLED${RESET}  ${DIM}https://$_mn_dom/${RESET}"
    else
        echo -e "    status page: ${DIM}not deployed${RESET}"
    fi
    if [[ -f "$REST_API_DIR_MAINNET/stats.json" ]]; then
        local _mn_dom2; _mn_dom2=$(_nginx_domain "$NODE_API_NGINX_CONF_MAINNET")
        echo -e "    REST API   : ${GREEN}ENABLED${RESET}  ${DIM}https://$_mn_dom2/rest/${RESET}"
        if [[ -f "$REST_CRON_MAINNET" ]]; then
            echo -e "    REST cron  : ${GREEN}ACTIVE${RESET}   ${DIM}every 60 s  (${REST_CRON_MAINNET})${RESET}"
            echo -e "                 ${DIM}note: /etc/cron.d/ jobs are not shown by 'crontab -l'${RESET}"
        else
            echo -e "    REST cron  : ${YELLOW}MISSING${RESET}  ${DIM}(re-run option 9 to reinstall)${RESET}"
        fi
    else
        echo -e "    REST API   : ${DIM}not deployed${RESET}"
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
    if [[ -f "$STATUS_PAGE_DEPLOY_TESTNET/index.html" ]]; then
        local _tn_dom; _tn_dom=$(_nginx_domain "$NODE_API_NGINX_CONF_TESTNET")
        echo -e "    status page: ${GREEN}ENABLED${RESET}  ${DIM}https://$_tn_dom/${RESET}"
    else
        echo -e "    status page: ${DIM}not deployed${RESET}"
    fi
    if [[ -f "$REST_API_DIR_TESTNET/stats.json" ]]; then
        local _tn_dom2; _tn_dom2=$(_nginx_domain "$NODE_API_NGINX_CONF_TESTNET")
        echo -e "    REST API   : ${GREEN}ENABLED${RESET}  ${DIM}https://$_tn_dom2/rest/${RESET}"
        if [[ -f "$REST_CRON_TESTNET" ]]; then
            echo -e "    REST cron  : ${GREEN}ACTIVE${RESET}   ${DIM}every 60 s  (${REST_CRON_TESTNET})${RESET}"
            echo -e "                 ${DIM}note: /etc/cron.d/ jobs are not shown by 'crontab -l'${RESET}"
        else
            echo -e "    REST cron  : ${YELLOW}MISSING${RESET}  ${DIM}(re-run option 11 to reinstall)${RESET}"
        fi
    else
        echo -e "    REST API   : ${DIM}not deployed${RESET}"
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

    local _eg_domain; [[ "$network" == "mainnet" ]] && _eg_domain="api.example.com" || _eg_domain="testapi.example.com"
    echo -ne "Domain for the $network Node API (e.g. $_eg_domain) or 0 to cancel: "
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

    # Public V2 Foreign API — JSON-RPC (no auth required):
    #   get_tip, get_version, get_block, get_header, get_kernel,
    #   get_outputs, push_transaction
    location /v2/foreign {
        # CORS — allow any origin to query this public read-only endpoint
        if (\$request_method = OPTIONS) {
            add_header Access-Control-Allow-Origin  "*";
            add_header Access-Control-Allow-Methods "POST, OPTIONS";
            add_header Access-Control-Allow-Headers "Content-Type";
            add_header Access-Control-Max-Age       86400;
            return 204;
        }
        add_header Access-Control-Allow-Origin  "*" always;
        add_header Access-Control-Allow-Methods "POST, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Content-Type" always;

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
    echo ""
    local _status_opt; [[ "$network" == "mainnet" ]] && _status_opt=5 || _status_opt=7
    info "Next step   : run option $_status_opt to deploy the live status page at https://$domain/"
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

    # Cascade: also remove status page deploy if present (proxy gone = page unreachable anyway)
    local deploy_dir
    deploy_dir="$( [[ "$network" == "mainnet" ]] && echo "$STATUS_PAGE_DEPLOY_MAINNET" || echo "$STATUS_PAGE_DEPLOY_TESTNET" )"
    if [[ -f "$deploy_dir/index.html" ]]; then
        info "Also removing deployed status page files at $deploy_dir"
        _nginx_remove_limit_req_zone
        rm -rf "$deploy_dir"
        log "Status page files removed (cascade from proxy removal): $deploy_dir"
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
# STATUS PAGE — deploy web/04/public_html, patch nginx, add rate-limiting
# ═══════════════════════════════════════════════════════════════════════════════

_enable_status_page() {
    local network="$1" nginx_conf="$2" deploy_dir="$3"

    # Detect update vs first-time deploy
    local mode="Enable"
    [[ -f "$deploy_dir/index.html" ]] && mode="Update"

    echo -e "\n${BOLD}${CYAN}── $mode Live Status Page ($network) ──${RESET}\n"

    if [[ ! -f "$nginx_conf" ]]; then
        warn "nginx proxy not set up for $network yet."
        warn "Run 'Enable via nginx' (option 1 or 3) first, then come back here."
        return
    fi

    if [[ ! -d "$STATUS_PAGE_SRC" ]]; then
        error "Source files not found: $STATUS_PAGE_SRC"
        error "Ensure web/04/public_html/ exists in the toolkit directory."
        return
    fi

    local domain
    domain=$(_nginx_domain "$nginx_conf")

    echo -e "  Source : ${DIM}$STATUS_PAGE_SRC${RESET}"
    echo -e "  Deploy : ${DIM}$deploy_dir${RESET}"
    echo -e "  URL    : ${BOLD}https://$domain/${RESET}"
    echo ""

    log "Status page $mode started: network=$network domain=$domain"

    # Deploy static files (cp is safe to re-run — overwrites with latest)
    mkdir -p "$deploy_dir"
    cp -r "$STATUS_PAGE_SRC"/. "$deploy_dir/"

    # Write network identifier — read by node-status.js at runtime
    printf 'const GRIN_NETWORK = "%s";\n' "$network" > "$deploy_dir/config.js"

    # Set ownership and permissions for nginx (www-data)
    chown -R www-data:www-data "$deploy_dir"   2>/dev/null || true
    find "$deploy_dir" -type d -exec chmod 755 {} \; 2>/dev/null || true
    find "$deploy_dir" -type f -exec chmod 644 {} \; 2>/dev/null || true

    if [[ "$mode" == "Update" ]]; then
        # Files already live — nginx config unchanged, just reload to pick up new files
        systemctl reload nginx 2>/dev/null || true
        success "Status page updated!"
        info "URL : https://$domain/"
        log  "Status page updated: network=$network domain=$domain"
        return
    fi

    # First-time: patch nginx site config + inject rate-limit zone
    _nginx_patch_status "$nginx_conf" "$deploy_dir" enable
    _nginx_add_limit_req_zone

    if nginx -t 2>/dev/null; then
        systemctl reload nginx
        success "Status page enabled!"
        echo ""
        info "Open in browser : https://$domain/"
        info "Shows           : height, difficulty, latest block, peers, versions"
        info "Auto-refresh    : every 10 seconds"
        info "To update files : run this option again"
        log  "Status page enabled: network=$network domain=$domain deploy_dir=$deploy_dir"
    else
        error "nginx config test failed — reverting status page changes."
        _nginx_patch_status "$nginx_conf" "$deploy_dir" disable
        _nginx_remove_limit_req_zone
        rm -rf "$deploy_dir"
        nginx -t 2>/dev/null && systemctl reload nginx || true
        log  "Status page enable FAILED (nginx -t): network=$network"
    fi
}

_disable_status_page() {
    local network="$1" nginx_conf="$2" deploy_dir="$3"

    echo -e "\n${BOLD}${CYAN}── Remove Status Page ($network) ──${RESET}\n"

    if [[ ! -f "$nginx_conf" ]]; then
        warn "No nginx config found for $network. Nothing to revert."
        return
    fi

    _nginx_patch_status "$nginx_conf" "$deploy_dir" disable
    _nginx_remove_limit_req_zone
    rm -rf "$deploy_dir"

    if nginx -t 2>/dev/null; then
        systemctl reload nginx
        success "Status page removed for $network."
        log "Status page removed: network=$network"
    else
        warn "nginx config test failed after removal. Check $nginx_conf manually."
        log "Status page remove: nginx -t failed after removal, network=$network"
    fi
}

enable_mainnet_status_page()  { _enable_status_page  mainnet "$NODE_API_NGINX_CONF_MAINNET"  "$STATUS_PAGE_DEPLOY_MAINNET"; }
disable_mainnet_status_page() { _disable_status_page mainnet "$NODE_API_NGINX_CONF_MAINNET"  "$STATUS_PAGE_DEPLOY_MAINNET"; }
enable_testnet_status_page()  { _enable_status_page  testnet "$NODE_API_NGINX_CONF_TESTNET"  "$STATUS_PAGE_DEPLOY_TESTNET"; }
disable_testnet_status_page() { _disable_status_page testnet "$NODE_API_NGINX_CONF_TESTNET"  "$STATUS_PAGE_DEPLOY_TESTNET"; }

# ═══════════════════════════════════════════════════════════════════════════════
# REST API — static JSON files served under /rest/, refreshed by cron every 60 s
# ═══════════════════════════════════════════════════════════════════════════════
# How it works:
#   1. The Python collector (rest-collector.py) is installed to /usr/local/lib/grin-node-toolkit/
#   2. A cron job (/etc/cron.d/grin-node-api-rest*) calls it every 60 s as www-data.
#   3. The collector queries the Grin foreign API locally (no auth) and writes five
#      atomic JSON files into {deploy_dir}/rest/:
#        stats.json        full snapshot: height, supply, difficulty, hash, versions
#        supply.json       circulating supply (height × 60)
#        height.json       block height only
#        difficulty.json   total network difficulty only
#        emission.json     static emission schedule (no node call needed)
#   4. nginx serves these files under /rest/ with CORS * and Cache-Control 60 s.
#
# Requires: status page deployed (option 5 / 7) — the nginx config needs the
#           static root already set by _nginx_patch_status before REST blocks can be added.
# ═══════════════════════════════════════════════════════════════════════════════

# Resolve the Grin node data directory from the instance conf written by script 01.
# Returns GRIN_DIR (e.g. /grinprunemain) which contains .api_secret, grin-server.toml,
# and chain_data/.  Falls back to /home/grin/.grin/{main,floo} if conf not present.
_lookup_grin_dir() {
    local network="$1"
    if [[ -f "$INSTANCES_CONF" ]]; then
        local candidates=()
        [[ "$network" == "mainnet" ]] && candidates=(PRUNEMAIN FULLMAIN) || candidates=(PRUNETEST)
        # shellcheck source=/dev/null
        source "$INSTANCES_CONF" 2>/dev/null
        for key in "${candidates[@]}"; do
            local varname="${key}_GRIN_DIR"
            local grin_dir="${!varname}"
            [[ -n "$grin_dir" && -d "$grin_dir" ]] && echo "$grin_dir" && return 0
        done
    fi
    # Fallback — standard Grin defaults
    [[ "$network" == "mainnet" ]] && echo "/home/grin/.grin/main" || echo "/home/grin/.grin/floo"
}

_enable_rest_api() {
    local network="$1" port="$2" nginx_conf="$3" rest_dir="$4" cron_file="$5" grin_data_dir="$6"

    echo -e "\n${BOLD}${CYAN}── Enable REST API ($network) ──${RESET}\n"
    echo -e "  Simple GET endpoints — no JSON-RPC knowledge required."
    echo -e "  Ideal for: CoinGecko, Google Sheets, no-code tools, website widgets."
    echo ""

    # Prerequisite: status page (and thus nginx static root) must already be deployed.
    # The _nginx_patch_rest function inserts REST location blocks before the catch-all
    # written by _nginx_patch_status — so the status page config must exist first.
    local deploy_dir
    deploy_dir="$( [[ "$network" == "mainnet" ]] && echo "$STATUS_PAGE_DEPLOY_MAINNET" \
                                                  || echo "$STATUS_PAGE_DEPLOY_TESTNET" )"
    if [[ ! -f "$deploy_dir/index.html" ]]; then
        local _opt; [[ "$network" == "mainnet" ]] && _opt=5 || _opt=7
        warn "Status page not deployed for $network."
        warn "Run option $_opt first to set up the nginx static root, then come back here."
        return
    fi

    echo -e "  REST dir  : ${DIM}$rest_dir${RESET}"
    echo -e "  Collector : ${DIM}$REST_COLLECTOR_DEST${RESET}"
    echo -e "  Cron      : ${DIM}$cron_file${RESET}"
    echo ""

    # 1. Install the Python collector to a system lib path so cron can call it directly.
    if [[ ! -f "$REST_COLLECTOR_SRC" ]]; then
        error "Collector script not found: $REST_COLLECTOR_SRC"
        error "Ensure web/04/rest-collector.py exists in the toolkit directory."
        return
    fi
    mkdir -p "$(dirname "$REST_COLLECTOR_DEST")"
    cp "$REST_COLLECTOR_SRC" "$REST_COLLECTOR_DEST"
    chmod 755 "$REST_COLLECTOR_DEST"
    info "Collector installed: $REST_COLLECTOR_DEST"

    # 2. Detect the OS user who owns the grin data directory for the node-collector cron.
    local grin_user
    grin_user=$(stat -c '%U' "$grin_data_dir" 2>/dev/null || echo "grin")
    info "Grin data dir owner (node-collector will run as): $grin_user"

    # 3. Create the REST directory — www-data owns it (nginx reads), grin_user gets
    #    group-write via the www-data group so node-collector can write node.json.
    mkdir -p "$rest_dir"
    chown www-data:www-data "$rest_dir"
    chmod 775 "$rest_dir"
    info "REST directory ready: $rest_dir"

    # 4. Write the main cron job — www-data queries the foreign API (no auth).
    #    /etc/cron.d/ files are root-owned 644 and must declare SHELL/PATH.
    cat > "$cron_file" << EOF
# Grin Node Toolkit — REST API updater ($network)
# Queries the Grin $network node foreign API (port $port) every 60 s.
# Writes static JSON files to $rest_dir for nginx to serve.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin

* * * * * www-data python3 $REST_COLLECTOR_DEST $port $rest_dir 2>/dev/null || true
EOF
    chmod 644 "$cron_file"
    chown root:root "$cron_file"
    info "REST cron installed: $cron_file"

    # 5. Install the node-collector (runs as root — reads .api_secret,
    #    chain_data/, grin-server.toml; writes 0644 files nginx can serve).
    if [[ ! -f "$NODE_COLLECTOR_SRC" ]]; then
        warn "node-collector.py not found: $NODE_COLLECTOR_SRC — skipping node stats."
    else
        cp "$NODE_COLLECTOR_SRC" "$NODE_COLLECTOR_DEST"
        chmod 755 "$NODE_COLLECTOR_DEST"
        info "Node-collector installed: $NODE_COLLECTOR_DEST"

        local node_cron_file
        [[ "$network" == "mainnet" ]] && node_cron_file="$NODE_CRON_MAINNET" \
                                      || node_cron_file="$NODE_CRON_TESTNET"

        cat > "$node_cron_file" << EOF
# Grin Node Toolkit — node stats updater ($network)
# Runs as root to read .api_secret, chain_data/, grin-server.toml.
# Writes node.json (peers, chain_size_mb, archive_mode) to $rest_dir.
# node-collector.py chmod()s each file to 0644 so nginx (www-data) can serve it.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin

* * * * * root python3 $NODE_COLLECTOR_DEST $port $rest_dir $grin_data_dir 2>/dev/null || true
EOF
        chmod 644 "$node_cron_file"
        chown root:root "$node_cron_file"
        info "Node cron installed: $node_cron_file (runs as root, detected data owner: $grin_user)"

        info "Running initial node stats collection..."
        if python3 "$NODE_COLLECTOR_DEST" "$port" "$rest_dir" "$grin_data_dir" 2>/dev/null; then
            success "Initial node stats collected."
        else
            warn "Initial node stats failed (node may not be running yet)."
            warn "Node cron will retry automatically every minute."
        fi
    fi

    # 6. Run initial REST collection now so JSON files exist before nginx reload.
    info "Running initial REST collection..."
    if sudo -u www-data python3 "$REST_COLLECTOR_DEST" "$port" "$rest_dir" 2>/dev/null; then
        success "Initial REST data collected."
    else
        warn "Initial REST collection failed (node may not be running yet)."
        warn "Cron will retry automatically every minute."
    fi

    # 7. Patch nginx to serve /rest/*.json (location block before the catch-all).
    _nginx_patch_rest "$nginx_conf" enable

    if nginx -t 2>/dev/null; then
        systemctl reload nginx
        local domain; domain=$(_nginx_domain "$nginx_conf")
        success "REST API enabled for $network!"
        echo ""
        info "Endpoints (GET, CORS enabled, refreshed every 60 s):"
        echo ""
        echo "    https://$domain/rest/stats.json"
        echo "    https://$domain/rest/supply.json"
        echo "    https://$domain/rest/height.json"
        echo "    https://$domain/rest/difficulty.json"
        echo "    https://$domain/rest/emission.json"
        echo ""
        info "Quick test:"
        echo ""
        echo "    curl -s https://$domain/rest/supply.json"
        echo ""
        info "Cron job : $cron_file"
        info "Log file : $LOG_FILE"
        log "REST API enabled: network=$network domain=$domain port=$port rest_dir=$rest_dir cron=$cron_file"
    else
        error "nginx config test failed — reverting REST changes."
        _nginx_patch_rest "$nginx_conf" disable
        rm -f "$cron_file"
        nginx -t 2>/dev/null && systemctl reload nginx || true
        log "REST API enable FAILED (nginx -t): network=$network"
    fi
}

_disable_rest_api() {
    local network="$1" nginx_conf="$2" rest_dir="$3" cron_file="$4"

    echo -e "\n${BOLD}${CYAN}── Disable REST API ($network) ──${RESET}\n"

    # Remove both cron jobs (main REST collector + node-collector).
    local node_cron_file
    [[ "$network" == "mainnet" ]] && node_cron_file="$NODE_CRON_MAINNET" \
                                  || node_cron_file="$NODE_CRON_TESTNET"

    for _cron in "$cron_file" "$node_cron_file"; do
        if [[ -f "$_cron" ]]; then
            rm -f "$_cron"
            info "Cron job removed: $_cron"
        fi
    done

    # Remove REST data directory and all JSON files under it.
    if [[ -d "$rest_dir" ]]; then
        rm -rf "$rest_dir"
        info "REST directory removed: $rest_dir"
    else
        info "No REST directory found at $rest_dir (already removed)."
    fi

    # Remove /rest/ nginx location blocks (only if the nginx config still exists).
    if [[ -f "$nginx_conf" ]]; then
        _nginx_patch_rest "$nginx_conf" disable
        if nginx -t 2>/dev/null; then
            systemctl reload nginx
        else
            warn "nginx config test failed after REST removal. Check $nginx_conf manually."
        fi
    fi

    success "REST API disabled for $network."
    log "REST API disabled: network=$network"
}

enable_mainnet_rest_api()  { _enable_rest_api  mainnet "$NODE_API_PORT_MAINNET" \
                                "$NODE_API_NGINX_CONF_MAINNET" "$REST_API_DIR_MAINNET" "$REST_CRON_MAINNET" \
                                "$(_lookup_grin_dir mainnet)"; }
disable_mainnet_rest_api() { _disable_rest_api mainnet \
                                "$NODE_API_NGINX_CONF_MAINNET" "$REST_API_DIR_MAINNET" "$REST_CRON_MAINNET"; }
enable_testnet_rest_api()  { _enable_rest_api  testnet "$NODE_API_PORT_TESTNET" \
                                "$NODE_API_NGINX_CONF_TESTNET" "$REST_API_DIR_TESTNET" "$REST_CRON_TESTNET" \
                                "$(_lookup_grin_dir testnet)"; }
disable_testnet_rest_api() { _disable_rest_api testnet \
                                "$NODE_API_NGINX_CONF_TESTNET" "$REST_API_DIR_TESTNET" "$REST_CRON_TESTNET"; }

# ═══════════════════════════════════════════════════════════════════════════════
# MENU
# ═══════════════════════════════════════════════════════════════════════════════

show_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  04) Grin Node API Services Manager${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    show_all_status

    # ── Build dynamic option labels based on current state ────────────────────
    local mn_domain="" tn_domain=""
    local mn_label_1 tn_label_3 mn_label_5 tn_label_7 mn_label_9 tn_label_11

    if [[ -f "/etc/nginx/sites-enabled/grin-node-api" ]]; then
        mn_domain=$(_nginx_domain "$NODE_API_NGINX_CONF_MAINNET")
        mn_label_1="${GREEN}[CONFIGURED]${RESET} ${BOLD}$mn_domain${RESET}  ${DIM}(use 2) to change domain)${RESET}"
    else
        mn_label_1="${DIM}(/v2/foreign, HTTPS)${RESET}"
    fi

    if [[ -f "/etc/nginx/sites-enabled/grin-node-api-testnet" ]]; then
        tn_domain=$(_nginx_domain "$NODE_API_NGINX_CONF_TESTNET")
        tn_label_3="${GREEN}[CONFIGURED]${RESET} ${BOLD}$tn_domain${RESET}  ${DIM}(use 4) to change domain)${RESET}"
    else
        tn_label_3="${DIM}(/v2/foreign, HTTPS)${RESET}"
    fi

    if [[ -f "$STATUS_PAGE_DEPLOY_MAINNET/index.html" && -n "$mn_domain" ]]; then
        mn_label_5="${GREEN}[DEPLOYED]${RESET}   ${BOLD}https://$mn_domain/${RESET}  ${DIM}(re-run to push updates)${RESET}"
    else
        mn_label_5="${DIM}(mainnet — deploy after option 1)${RESET}"
    fi

    if [[ -f "$STATUS_PAGE_DEPLOY_TESTNET/index.html" && -n "$tn_domain" ]]; then
        tn_label_7="${GREEN}[DEPLOYED]${RESET}   ${BOLD}https://$tn_domain/${RESET}  ${DIM}(re-run to push updates)${RESET}"
    else
        tn_label_7="${DIM}(testnet — deploy after option 3)${RESET}"
    fi

    # REST option labels — show live URL if enabled, or prerequisite hint if not
    if [[ -f "$REST_API_DIR_MAINNET/stats.json" && -n "$mn_domain" ]]; then
        mn_label_9="${GREEN}[ENABLED]${RESET}    ${BOLD}https://$mn_domain/rest/${RESET}  ${DIM}(re-run to reinstall collector)${RESET}"
    elif [[ -f "$STATUS_PAGE_DEPLOY_MAINNET/index.html" ]]; then
        mn_label_9="${DIM}(mainnet — requires option 5 first: done ✓ — ready to enable)${RESET}"
    else
        mn_label_9="${DIM}(mainnet — requires option 5 first)${RESET}"
    fi

    if [[ -f "$REST_API_DIR_TESTNET/stats.json" && -n "$tn_domain" ]]; then
        tn_label_11="${GREEN}[ENABLED]${RESET}    ${BOLD}https://$tn_domain/rest/${RESET}  ${DIM}(re-run to reinstall collector)${RESET}"
    elif [[ -f "$STATUS_PAGE_DEPLOY_TESTNET/index.html" ]]; then
        tn_label_11="${DIM}(testnet — requires option 7 first: done ✓ — ready to enable)${RESET}"
    else
        tn_label_11="${DIM}(testnet — requires option 7 first)${RESET}"
    fi

    echo -e "${DIM}  ─── Node Public API — Mainnet (port $NODE_API_PORT_MAINNET) ─────────────${RESET}"
    echo -e "  ${GREEN}1${RESET}) Enable via nginx     $mn_label_1"
    echo -e "  ${RED}2${RESET}) Remove nginx proxy"
    echo ""
    echo -e "${DIM}  ─── Node Public API — Testnet (port $NODE_API_PORT_TESTNET) ────────────${RESET}"
    echo -e "  ${GREEN}3${RESET}) Enable via nginx     $tn_label_3"
    echo -e "  ${RED}4${RESET}) Remove nginx proxy"
    echo ""
    echo -e "${DIM}  ─── Live Status Page (requires nginx proxy above) ────────────────${RESET}"
    echo -e "  ${GREEN}5${RESET}) Deploy / Update page  $mn_label_5"
    echo -e "  ${RED}6${RESET}) Remove status page    ${DIM}(mainnet)${RESET}"
    echo -e "  ${GREEN}7${RESET}) Deploy / Update page  $tn_label_7"
    echo -e "  ${RED}8${RESET}) Remove status page    ${DIM}(testnet)${RESET}"
    echo ""
    echo -e "${DIM}  ─── REST API  /rest/*.json  (requires status page above) ────────${RESET}"
    echo -e "  ${GREEN}9${RESET}) Enable REST API       $mn_label_9"
    echo -e "  ${RED}10${RESET}) Disable REST API      ${DIM}(mainnet — removes cron + JSON files)${RESET}"
    echo -e "  ${GREEN}11${RESET}) Enable REST API      $tn_label_11"
    echo -e "  ${RED}12${RESET}) Disable REST API      ${DIM}(testnet — removes cron + JSON files)${RESET}"
    echo ""
    echo -e "  ${DIM}↩  Press Enter to refresh status${RESET}"
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -ne "${BOLD}Select [0-12]: ${RESET}"
}

main() {
    while true; do
        show_menu
        read -r choice

        case "$choice" in
            "") continue ;;  # bare Enter = refresh status display
            1)  enable_mainnet_node_api    || true ;;
            2)  disable_mainnet_node_api   || true ;;
            3)  enable_testnet_node_api    || true ;;
            4)  disable_testnet_node_api   || true ;;
            5)  enable_mainnet_status_page || true ;;
            6)  disable_mainnet_status_page || true ;;
            7)  enable_testnet_status_page || true ;;
            8)  disable_testnet_status_page || true ;;
            9)  enable_mainnet_rest_api    || true ;;
            10) disable_mainnet_rest_api   || true ;;
            11) enable_testnet_rest_api    || true ;;
            12) disable_testnet_rest_api   || true ;;
            0)  break ;;
            *)  warn "Invalid option." ; sleep 1 ;;
        esac

        echo ""
        echo "Press Enter to continue..."
        read -r
    done
}

main "$@"
