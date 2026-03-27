#!/bin/bash
# =============================================================================
# Script 04 — Grin Node API Services Manager
# Part of: Grin Node Toolkit  (https://github.com/noobvie/grin-node-toolkit)
# =============================================================================
#
# PURPOSE
#   Deploys and manages public-facing API access for a running Grin node.
#   Two exclusive modes are available — choose ONE, not both.
#
# ┌──────────────────────────────────────────────────────────────────────┐
# │  TWO MODES — PICK ONE, NOT BOTH                                      │
# │  Activating both modes will cause port conflicts.                    │
# │                                                                       │
# │  MODE A — Raw TCP Direct Access  (menu options 1/2)                  │
# │    Opens port 3413 directly on the firewall. No SSL.                 │
# │    Simplest setup — for nodes that serve external wallets directly.  │
# │    External wallets connect via plain HTTP:                          │
# │      check_node_api_http_addr = "http://prunemain.example.com:3413"  │
# │    Port 3413 bypasses nginx entirely — script 02 HTTP→HTTPS          │
# │    redirect does NOT interfere (it only applies to ports 80/443).    │
# │                                                                       │
# │  MODE B — nginx HTTPS Proxy  (menu options 3/4)                      │
# │    Exposes /v2/foreign behind HTTPS (Let's Encrypt). Rate limited.   │
# │    Includes optional live status page and REST API endpoints.        │
# │    Best for public-facing community nodes:                           │
# │      https://api.grin.money/   https://api.grinily.com/              │
# └──────────────────────────────────────────────────────────────────────┘
#
# SERVICES
#   1/2)  Raw TCP Direct Access  (MODE A)
#           · Patches grin-server.toml to bind Foreign API on 0.0.0.0:3413
#           · Opens ufw firewall rule for port 3413
#           · Restarts the Grin node in its tmux session to apply changes
#
#   3/5)  nginx HTTPS reverse proxy  (/v2/foreign, JSON-RPC)  (MODE B)
#           · Exposes the read-only Foreign API — Owner API stays private
#           · CORS enabled so any website can query from a browser
#           · Rate-limited (10 r/s, burst 20) and connection-limited (20 conn/IP)
#           · Returns HTTP 429 on excess; active from proxy setup, no status page required
#
#   5/7)  Live status page  (https://domain/)
#           · HTML dashboard: height, difficulty, supply, hash, versions
#           · Auto-refreshes every 60 s; dark/light theme; mobile-friendly
#           · Static files — zero extra server load per visitor
#           · Developer section: CORS test, fetch snippets, remote checker
#
#   7/9)  REST API  (https://domain/rest/)
#           · Simple GET endpoints returning clean JSON
#           · Ideal for: CoinGecko, Google Sheets, no-code tools, widgets
#           · Static JSON refreshed every 60 s by cron (www-data)
#           · Endpoints: /rest/stats.json  /rest/supply.json  /rest/height.json
#                        /rest/difficulty.json  /rest/emission.json
#           · CORS enabled; Cache-Control: public, max-age=60
#           · Requires status page deployed (option 6/7) first
#
# NETWORKS
#   mainnet (port 3413)  ·  testnet (port 13413)
#
# PREREQUISITES
#   · Must be run as root
#   · A running Grin node (Script 01) with Foreign API accessible on localhost
#   · MODE B only: nginx and certbot (auto-installed if missing)
#   · MODE B only: DNS A record pointing to this server; ports 80 and 443 open
#
# LOG FILE
#   <toolkit_root>/log/grin_node_services_YYYYMMDD_HHMMSS.log
#
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
LOG_DIR="/opt/grin/logs"
LOG_FILE="$LOG_DIR/grin_node_services_$(date +%Y%m%d_%H%M%S).log"

# Status page source (repo) and deploy (live web root) paths
STATUS_PAGE_SRC="$(cd "$SCRIPT_DIR/.." && pwd)/web/04_node_api/public_html"
STATUS_PAGE_DEPLOY_MAINNET="/var/www/grin-node-api"
STATUS_PAGE_DEPLOY_TESTNET="/var/www/grin-node-api-testnet"

# REST API — static JSON files written by cron, served by nginx under /rest/
REST_API_DIR_MAINNET="$STATUS_PAGE_DEPLOY_MAINNET/rest"
REST_API_DIR_TESTNET="$STATUS_PAGE_DEPLOY_TESTNET/rest"
REST_COLLECTOR_SRC="$(cd "$SCRIPT_DIR/.." && pwd)/web/04_node_api/rest-collector.py"
REST_COLLECTOR_DEST="/opt/grin/grin-api-collector/rest-collector.py"
REST_CRON_MAINNET="/etc/cron.d/grin-node-api-rest"
REST_CRON_TESTNET="/etc/cron.d/grin-node-api-rest-testnet"

# node-collector.py runs as the grin OS user to access privileged data:
#   · owner API (.api_secret) for connected peer count
#   · du on chain_data/ for chain size
#   · grin-server.toml for archive_mode
# Writes node.json to the REST dir (grin user has group-write via www-data group).
NODE_COLLECTOR_SRC="$(cd "$SCRIPT_DIR/.." && pwd)/web/04_node_api/node-collector.py"
NODE_COLLECTOR_DEST="/opt/grin/grin-api-collector/node-collector.py"
NODE_CRON_MAINNET="/etc/cron.d/grin-node-api-node"
NODE_CRON_TESTNET="/etc/cron.d/grin-node-api-node-testnet"

# Grin instance conf — written by script 01, read here to find actual data dirs.
CONF_DIR="/opt/grin/conf"
INSTANCES_CONF="$CONF_DIR/grin_instances_location.conf"

# ─── Runtime state (set by main when network is selected) ─────────────────────
NETWORK=""
NODE_PORT=""

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
    echo -ne "${BOLD}Press ${GREEN}y${RESET}${BOLD} to confirm you have read the above and want to proceed [y/N/0]: ${RESET}"
    read -r _guide_confirm || true
    if [[ "${_guide_confirm,,}" != "y" ]]; then
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

# Add rate-limit/connection-limit zones into the http {} block of nginx.conf.
# Idempotent — skips if grin_conn zone already present.
# Upgrades gracefully — removes any old single-zone block before inserting the new one.
_nginx_add_limit_req_zone() {
    local nginx_conf="/etc/nginx/nginx.conf"
    grep -q "zone=grin_conn" "$nginx_conf" 2>/dev/null && return 0
    python3 - "$nginx_conf" << 'PYEOF'
import sys, re
conf_file = sys.argv[1]
with open(conf_file) as fh:
    txt = fh.read()
if 'zone=grin_conn' in txt:
    sys.exit(0)
# Remove any old single-zone block left by a previous version of this script
txt = re.sub(
    r'\n    # Grin Node Toolkit[^\n]*\n(?:    [^\n]+\n){1,6}',
    '\n', txt)
insert = (
    '\n    # Grin Node Toolkit — rate/connection-limit zones for public API\n'
    '    limit_req_zone  $binary_remote_addr zone=grin_api:10m  rate=10r/s;\n'
    '    limit_conn_zone $binary_remote_addr zone=grin_conn:10m;\n'
    '    limit_req_status  429;\n'
    '    limit_req_log_level warn;\n'
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
    r'\n    # Grin Node Toolkit[^\n]*\n(?:    [^\n]+\n){1,6}',
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
    ' "default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'self\' https:" always;\n'
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

if action == 'enable':
    if OLD_LOC in txt:
        txt = txt.replace(OLD_LOC, NEW_LOC)
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
    '        limit_req  zone=grin_api burst=30 nodelay;\n'
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

show_network_status() {
    echo -e "\n${BOLD}Status:${RESET}\n"

    local nginx_conf nginx_symlink status_deploy rest_dir rest_cron
    if [[ "$NETWORK" == "mainnet" ]]; then
        nginx_conf="$NODE_API_NGINX_CONF_MAINNET"; nginx_symlink="grin-node-api"
        status_deploy="$STATUS_PAGE_DEPLOY_MAINNET"; rest_dir="$REST_API_DIR_MAINNET"
        rest_cron="$REST_CRON_MAINNET"
    else
        nginx_conf="$NODE_API_NGINX_CONF_TESTNET"; nginx_symlink="grin-node-api-testnet"
        status_deploy="$STATUS_PAGE_DEPLOY_TESTNET"; rest_dir="$REST_API_DIR_TESTNET"
        rest_cron="$REST_CRON_TESTNET"
    fi

    if ss -tlnp 2>/dev/null | grep -q ":$NODE_PORT "; then
        echo -e "  ${BOLD}Grin node${RESET}   : ${GREEN}RUNNING${RESET}  ${DIM}(port $NODE_PORT)${RESET}"
    else
        echo -e "  ${BOLD}Grin node${RESET}   : ${RED}NOT RUNNING${RESET}  ${YELLOW}⚠ run Script 01${RESET}"
    fi

    # MODE A — Raw TCP status
    if _raw_tcp_active "$NODE_PORT" 2>/dev/null; then
        local raw_domain; raw_domain=$(_detect_grin_domain)
        local raw_addr="${raw_domain:-YOUR_SERVER_IP}"
        echo -e "  ${BOLD}raw TCP     ${RESET} : ${GREEN}ACTIVE${RESET}  ${DIM}http://$raw_addr:$NODE_PORT${RESET}  ${YELLOW}(MODE A)${RESET}"
    else
        echo -e "  ${BOLD}raw TCP     ${RESET} : ${DIM}disabled${RESET}  ${DIM}(option 1)${RESET}"
    fi

    # MODE B — nginx proxy status
    if [[ -f "/etc/nginx/sites-enabled/$nginx_symlink" ]]; then
        local domain; domain=$(_nginx_domain "$nginx_conf")
        echo -e "  ${BOLD}nginx proxy${RESET} : ${GREEN}CONFIGURED${RESET}  ${DIM}https://$domain/v2/foreign${RESET}  ${YELLOW}(MODE B)${RESET}"
        if grep -q 'proxy_set_header.*Authorization' "$nginx_conf" 2>/dev/null; then
            echo -e "  ${BOLD}auth header${RESET} : ${GREEN}INJECTED${RESET}  ${DIM}(Basic Auth forwarded to node)${RESET}"
        else
            echo -e "  ${BOLD}auth header${RESET} : ${YELLOW}MISSING${RESET}  ${DIM}⚠ browser may show 401 prompt — re-run option 4${RESET}"
        fi
    else
        echo -e "  ${BOLD}nginx proxy${RESET} : ${DIM}not configured${RESET}  ${DIM}(option 4)${RESET}"
    fi

    if [[ -f "$status_deploy/index.html" ]]; then
        local domain2; domain2=$(_nginx_domain "$nginx_conf")
        echo -e "  ${BOLD}status page${RESET} : ${GREEN}DEPLOYED${RESET}  ${DIM}https://$domain2/${RESET}"
    else
        echo -e "  ${BOLD}status page${RESET} : ${DIM}not deployed${RESET}  ${DIM}(option 6)${RESET}"
    fi

    if [[ -f "$rest_dir/stats.json" ]]; then
        local domain3; domain3=$(_nginx_domain "$nginx_conf")
        echo -e "  ${BOLD}REST API${RESET}    : ${GREEN}ENABLED${RESET}  ${DIM}https://$domain3/rest/${RESET}"
        [[ -f "$rest_cron" ]] \
            && echo -e "  ${BOLD}REST cron${RESET}   : ${GREEN}ACTIVE${RESET}  ${DIM}every 60 s${RESET}" \
            || echo -e "  ${BOLD}REST cron${RESET}   : ${YELLOW}MISSING${RESET}  ${DIM}(re-run option 8)${RESET}"
    else
        echo -e "  ${BOLD}REST API${RESET}    : ${DIM}not deployed${RESET}  ${DIM}(option 8)${RESET}"
    fi
    echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
# NODE API — nginx HTTPS reverse proxy (/v2/foreign)
# ═══════════════════════════════════════════════════════════════════════════════

_enable_node_api_nginx() {
    local network="$1" port="$2" nginx_conf="$3" nginx_symlink="$4"

    # Conflict check — abort if MODE A raw TCP is active
    local _nginx_sym="$4"
    local _check_port="$port"
    if _raw_tcp_active "$_check_port" 2>/dev/null; then
        error "MODE A Raw TCP is currently active for $network (port $_check_port)."
        error "Activating both modes will cause port conflicts."
        error "Disable Raw TCP first (option 2), then enable nginx proxy (option 4)."
        return
    fi

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
        echo -ne "Continue anyway? [Y/n/0]: "
        read -r cont
        [[ "$cont" == "0" ]] && return
        [[ "${cont,,}" == "n" ]] && return
    fi

    local _eg_domain; [[ "$network" == "mainnet" ]] && _eg_domain="api.example.com" || _eg_domain="testapi.example.com"
    while true; do
        echo -ne "Domain for the $network Node API (e.g. $_eg_domain) or 0 to cancel: "
        read -r domain
        [[ "$domain" == "0" ]] && return
        [[ -z "$domain" ]] && warn "No domain entered." && continue
        local _lbl="${domain%%.*}"
        if [[ "$_lbl" == "fullmain" || "$_lbl" == "prunemain" || "$_lbl" == "prunetest" ]]; then
            warn "'$_lbl' is reserved by script 02 (Grin chain data server). Choose a different subdomain."
            continue
        fi
        break
    done

    echo -ne "Email for Let's Encrypt SSL certificate (or 0 to cancel): "
    read -r email
    [[ "$email" == "0" ]] && return
    [[ -z "$email" ]] && warn "No email entered. Aborting." && return

    log "Node API nginx setup started: network=$network port=$port domain=$domain"

    # If script 01 created a .foreign_api_secret, Grin requires HTTP Basic Auth on its
    # foreign API port — even for local connections.  Nginx must inject the credential
    # so the public caller never sees a 401 or a browser auth prompt.
    # We read the secret here and embed it as a Basic-Auth proxy header; it stays
    # localhost-only and is never exposed to external callers.
    local _proxy_auth_header=""
    local _grin_dir; _grin_dir=$(_lookup_grin_dir "$network")
    if [[ -z "$_grin_dir" ]]; then
        error "Cannot locate $network node directory. Install the node via Script 01 first."
        return
    fi
    local _foreign_secret_file="$_grin_dir/.foreign_api_secret"
    info "Grin data dir : $_grin_dir"
    if [[ -f "$_foreign_secret_file" ]]; then
        local _secret; _secret=$(tr -d '[:space:]' < "$_foreign_secret_file" 2>/dev/null || true)
        if [[ -n "$_secret" ]]; then
            local _b64; _b64=$(printf '%s' "grin:$_secret" | base64 -w 0 2>/dev/null || printf '%s' "grin:$_secret" | base64)
            _proxy_auth_header="        proxy_set_header   Authorization \"Basic $_b64\";"
            info "Foreign API secret found — injecting proxy auth header into nginx config."
        else
            warn "Foreign API secret file is empty: $_foreign_secret_file"
            warn "nginx config will be written WITHOUT an auth header — browser will show a 401 prompt."
        fi
    else
        warn "Foreign API secret not found at: $_foreign_secret_file"
        warn "nginx config will be written WITHOUT an auth header — browser will show a 401 prompt."
        warn "Fix: re-run Script 01 to rebuild the $network node (this re-creates the secret file),"
        warn "     OR verify the node data dir is registered in $INSTANCES_CONF"
    fi

    # Remove any legacy stream block left by old versions of this script.
    # If present, nginx -t would fail with "unknown directive stream".
    _remove_legacy_stream_config

    # Ensure rate/connection-limit zones are in nginx.conf before writing the site config.
    _nginx_add_limit_req_zone

    # Write HTTP-only config first — certbot will add the SSL block itself.
    # Writing SSL cert paths before certbot runs causes nginx -t to fail.
    cat > "$nginx_conf" << EOF
server {
    listen 80;
    server_name $domain;

    # Dedicated log files — rotated by /etc/logrotate.d/$nginx_symlink (5 days / 5 MB)
    access_log /var/log/nginx/$nginx_symlink.access.log;
    error_log  /var/log/nginx/$nginx_symlink.error.log warn;

    # Public V2 Foreign API — JSON-RPC (no auth required for callers):
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
        # Strip CORS headers the Grin node sends itself — nginx re-adds them below.
        # Without this, the header appears twice ("*, *") and browsers reject it.
        proxy_hide_header Access-Control-Allow-Origin;
        proxy_hide_header Access-Control-Allow-Methods;
        proxy_hide_header Access-Control-Allow-Headers;
        add_header Access-Control-Allow-Origin  "*" always;
        add_header Access-Control-Allow-Methods "POST, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Content-Type" always;

        proxy_pass         http://127.0.0.1:$port/v2/foreign;
${_proxy_auth_header}
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60;
        client_max_body_size 8k;
        limit_req  zone=grin_api  burst=20 nodelay;
        limit_conn grin_conn 20;
    }

    # Block all other paths — owner/admin API stays private
    location / {
        return 403 "Access denied. Only /v2/foreign is exposed.";
    }
}
EOF

    # Deploy logrotate config — 5-day / 5 MB rotation for dedicated API log files
    cat > "/etc/logrotate.d/$nginx_symlink" << 'LREOF'
/var/log/nginx/NGINX_SYMLINK.access.log /var/log/nginx/NGINX_SYMLINK.error.log {
    daily
    rotate 5
    size 5M
    compress
    delaycompress
    missingok
    notifempty
    sharedscripts
    postrotate
        nginx -s reopen 2>/dev/null || true
    endscript
}
LREOF
    sed -i "s/NGINX_SYMLINK/$nginx_symlink/g" "/etc/logrotate.d/$nginx_symlink"
    log "logrotate config deployed: /etc/logrotate.d/$nginx_symlink"

    ln -sf "$nginx_conf" "/etc/nginx/sites-enabled/$nginx_symlink" 2>/dev/null || true

    if ! nginx -t; then
        error "nginx config test failed. Check $nginx_conf"
        return
    fi
    systemctl reload nginx

    info "Requesting Let's Encrypt SSL certificate for $domain..."
    certbot --nginx -d "$domain" --non-interactive --agree-tos -m "$email" \
        || { warn "certbot failed — check /var/log/letsencrypt/letsencrypt.log"; return; }

    # Re-apply status page + REST patches if they were active before this rebuild.
    # Writing a fresh config above wipes those patches; restore them here so the
    # status page (/) and REST endpoints (/rest/) keep working after option 4 is re-run.
    local _deploy_dir _rest_dir _rest_cron
    if [[ "$network" == "mainnet" ]]; then
        _deploy_dir="$STATUS_PAGE_DEPLOY_MAINNET"
        _rest_dir="$REST_API_DIR_MAINNET"
        _rest_cron="$REST_CRON_MAINNET"
    else
        _deploy_dir="$STATUS_PAGE_DEPLOY_TESTNET"
        _rest_dir="$REST_API_DIR_TESTNET"
        _rest_cron="$REST_CRON_TESTNET"
    fi
    if [[ -f "$_deploy_dir/index.html" ]]; then
        info "Re-applying status page configuration (was active before rebuild)..."
        _nginx_patch_status "$nginx_conf" "$_deploy_dir" enable
        _nginx_add_limit_req_zone
    fi
    if [[ -f "$_rest_cron" || -f "$_rest_dir/stats.json" ]]; then
        info "Re-applying REST API configuration (was active before rebuild)..."
        _nginx_patch_rest "$nginx_conf" "enable"
    fi

    if nginx -t 2>/dev/null; then
        systemctl reload nginx
    else
        warn "nginx config test failed after re-applying patches — reload skipped. Check $nginx_conf manually."
        return
    fi

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
    info "Next step   : run option 6 to deploy the live status page at https://$domain/"
    [[ -n "$_proxy_auth_header" ]] && \
        warn "Note: if the node is rebuilt via Script 01, re-run option 4 here to refresh the proxy auth credential."
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

    _nginx_remove_limit_req_zone
    rm -f "/etc/nginx/sites-enabled/$nginx_symlink"
    rm -f "$nginx_conf"
    rm -f "/etc/logrotate.d/$nginx_symlink"

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
# STATUS PAGE — deploy web/04_node_api/public_html, patch nginx, add rate-limiting
# ═══════════════════════════════════════════════════════════════════════════════

_enable_status_page() {
    local network="$1" nginx_conf="$2" deploy_dir="$3"

    # Detect update vs first-time deploy
    local mode="Enable"
    [[ -f "$deploy_dir/index.html" ]] && mode="Update"

    echo -e "\n${BOLD}${CYAN}── $mode Live Status Page ($network) ──${RESET}\n"

    if [[ ! -f "$nginx_conf" ]]; then
        warn "nginx proxy not set up for $network yet."
        warn "Run 'Enable via nginx' (option 4) first, then come back here."
        return
    fi

    if [[ ! -d "$STATUS_PAGE_SRC" ]]; then
        error "Source files not found: $STATUS_PAGE_SRC"
        error "Ensure web/04_node_api/public_html/ exists in the toolkit directory."
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
        info "Auto-refresh    : every 60 seconds"
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
#   1. The Python collector (rest-collector.py) is installed to /opt/grin/grin-api-collector/
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
# Requires: status page deployed (option 6) — the nginx config needs the
#           static root already set by _nginx_patch_status before REST blocks can be added.
# ═══════════════════════════════════════════════════════════════════════════════

# Resolve the Grin node data directory from the instance conf written by script 01.
# Returns GRIN_DIR (e.g. /opt/grin/node/mainnet-prune) which contains .api_secret and grin-server.toml.
_lookup_grin_dir() {
    # NOTE: this function is called via $(...) substitution — all warn/echo messages
    # must go to stderr (&2) so they appear on the terminal and are NOT captured
    # as part of the returned path.
    local network="$1"

    # 1. Primary: instances conf written by Script 01
    if [[ -f "$INSTANCES_CONF" ]]; then
        local candidates=()
        [[ "$network" == "mainnet" ]] && candidates=(PRUNEMAIN FULLMAIN) || candidates=(PRUNETEST)
        # shellcheck source=/dev/null
        source "$INSTANCES_CONF" 2>/dev/null
        for key in "${candidates[@]}"; do
            local varname="${key}_GRIN_DIR"
            local grin_dir="${!varname:-}"
            [[ -n "$grin_dir" && -d "$grin_dir" ]] && echo "$grin_dir" && return 0
        done
        warn "_lookup_grin_dir: $INSTANCES_CONF exists but has no valid $network entry." >&2
    else
        warn "_lookup_grin_dir: $INSTANCES_CONF not found — run Script 01 to install the node." >&2
    fi

    # 2. Fallback: toolkit standard paths (Script 01 always creates one of these)
    local std_dirs=()
    if [[ "$network" == "mainnet" ]]; then
        std_dirs=("/opt/grin/node/mainnet-prune" "/opt/grin/node/mainnet-full")
    else
        std_dirs=("/opt/grin/node/testnet-prune")
    fi
    for dir in "${std_dirs[@]}"; do
        if [[ -d "$dir" ]]; then
            warn "_lookup_grin_dir: instances conf missing/stale — found standard toolkit path $dir" >&2
            echo "$dir"
            return 0
        fi
    done

    warn "_lookup_grin_dir: no $network node directory found — is the node installed via Script 01?" >&2
    echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
# MODE DETECTION HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

# Returns 0 (true) if Raw TCP mode is active for the given port:
#   · ufw has an ALLOW rule for the port, AND
#   · grin-server.toml has check_node_api_http_addr bound to 0.0.0.0
_raw_tcp_active() {
    local port="$1"
    local grin_dir; grin_dir=$(_lookup_grin_dir "$NETWORK" 2>/dev/null)
    [[ -z "$grin_dir" ]] && return 1
    local toml="$grin_dir/grin-server.toml"
    ufw status 2>/dev/null | grep -q "^${port}/tcp.*ALLOW" \
        && grep -q "check_node_api_http_addr.*0\.0\.0\.0" "$toml" 2>/dev/null
}

# Returns 0 (true) if MODE B nginx proxy is active for the given symlink name
_nginx_proxy_active() {
    local symlink="$1"
    [[ -L "/etc/nginx/sites-enabled/$symlink" ]]
}

# Returns the tmux session name for a given grin node directory
# Mirrors the naming convention in Script 01.
_grin_session_name_local() {
    case "$(basename "${1:-}")" in
        mainnet-full)  echo "grin_full_mainnet"   ;;
        mainnet-prune) echo "grin_pruned_mainnet" ;;
        testnet-prune) echo "grin_pruned_testnet" ;;
        *)             echo "grin_$(basename "${1:-}")" ;;
    esac
}

# Detect the domain from script 02 nginx configs (fullmain/prunemain/prunetest convention).
# Returns the first matching domain name or empty string if none found.
_detect_grin_domain() {
    local conf
    for conf in /etc/nginx/sites-available/*; do
        [[ -f "$conf" ]] || continue
        local base; base="$(basename "$conf")"
        case "$base" in fullmain.*|prunemain.*|prunetest.*|api.*|grin.*)
            local domain; domain=$(grep -m1 'server_name' "$conf" 2>/dev/null | awk '{print $2}' | tr -d ';')
            [[ -n "$domain" ]] && echo "$domain" && return 0
            ;;
        esac
    done
    # Fallback: try to get public IP
    hostname -I 2>/dev/null | awk '{print $1}' || true
}

# Ask user whether to restart the Grin node in tmux, then do it.
_offer_node_restart() {
    local network="$1"
    local grin_dir; grin_dir=$(_lookup_grin_dir "$network" 2>/dev/null)
    if [[ -z "$grin_dir" ]]; then
        warn "Cannot locate $network node directory — restart manually."
        return
    fi

    local session; session=$(_grin_session_name_local "$grin_dir")

    echo ""
    echo -ne "${BOLD}Restart Grin node in tmux session '${CYAN}${session}${RESET}${BOLD}' now? [Y/n]: ${RESET}"
    read -r _restart_confirm || true
    _restart_confirm="${_restart_confirm:-y}"

    if [[ "${_restart_confirm,,}" == "n" ]]; then
        warn "Node not restarted — restart manually for changes to take effect:"
        echo "    tmux kill-session -t $session"
        echo "    cd $grin_dir && tmux new-session -d -s $session './grin server run'"
        return
    fi

    info "Stopping Grin node tmux session '$session'..."
    tmux kill-session -t "$session" 2>/dev/null || true
    sleep 1

    info "Starting Grin node in tmux session '$session'..."
    if id grin &>/dev/null; then
        tmux new-session -d -s "$session" -c "$grin_dir" \
            "echo 'Starting Grin node...'; su -s /bin/bash -c 'cd \"$grin_dir\" && ./grin server run' grin; echo ''; echo 'Grin process exited. Press Enter to close.'; read" \
            2>/dev/null || true
    else
        tmux new-session -d -s "$session" -c "$grin_dir" \
            "echo 'Starting Grin node...'; cd \"$grin_dir\" && ./grin server run; echo ''; echo 'Grin process exited. Press Enter to close.'; read" \
            2>/dev/null || true
    fi

    sleep 1
    if tmux has-session -t "$session" 2>/dev/null; then
        success "Grin node restarted in tmux session '$session'."
        info "Attach with: tmux attach -t $session"
    else
        warn "tmux session '$session' not found after restart attempt."
        warn "Restart manually: cd $grin_dir && ./grin server run"
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# MODE A — Raw TCP Direct Access (options 1/2)
# ═══════════════════════════════════════════════════════════════════════════════

_enable_raw_tcp() {
    local network="$1" port="$2" nginx_symlink="$3"

    echo -e "\n${BOLD}${CYAN}── Enable Raw TCP Direct Access ($network, port $port) ──${RESET}\n"
    echo -e "  Opens port ${BOLD}$port${RESET} directly on the firewall."
    echo -e "  External wallets connect via plain HTTP — no SSL, no nginx."
    echo ""

    # Conflict check — abort if MODE B nginx proxy is active
    if _nginx_proxy_active "$nginx_symlink"; then
        error "MODE B nginx proxy is currently active for $network."
        error "Activating both modes will cause port conflicts."
        error "Remove the nginx proxy first (option 5), then enable Raw TCP."
        return
    fi

    # Locate grin node data directory and toml
    local grin_dir; grin_dir=$(_lookup_grin_dir "$network")
    if [[ -z "$grin_dir" ]]; then
        error "Cannot locate $network node directory. Install the node via Script 01 first."
        return
    fi
    local toml="$grin_dir/grin-server.toml"
    if [[ ! -f "$toml" ]]; then
        error "grin-server.toml not found at: $toml"
        return
    fi

    info "Grin data dir : $grin_dir"
    info "Config file   : $toml"
    echo ""

    # Patch check_node_api_http_addr to 0.0.0.0:<port>
    if grep -q "check_node_api_http_addr" "$toml" 2>/dev/null; then
        sed -i -E "s|check_node_api_http_addr[[:space:]]*=[[:space:]]*\"[^\"]*\"|check_node_api_http_addr = \"0.0.0.0:$port\"|g" "$toml"
        success "Patched grin-server.toml: check_node_api_http_addr = \"0.0.0.0:$port\""
    else
        # Field not present — append to [server] section
        echo "" >> "$toml"
        echo "check_node_api_http_addr = \"0.0.0.0:$port\"" >> "$toml"
        success "Added to grin-server.toml: check_node_api_http_addr = \"0.0.0.0:$port\""
    fi

    # Open ufw firewall port
    if command -v ufw &>/dev/null; then
        ufw allow "$port/tcp" comment "Grin Foreign API (raw TCP, $network)" 2>/dev/null || true
        success "ufw rule added: allow $port/tcp"
    else
        warn "ufw not found — open port $port manually in your firewall."
    fi

    log "Raw TCP enabled: network=$network port=$port toml=$toml"

    # Detect node domain from script 02 for wallet config example
    local node_domain; node_domain=$(_detect_grin_domain)
    local wallet_addr
    if [[ -n "$node_domain" ]]; then
        wallet_addr="http://$node_domain:$port"
    else
        wallet_addr="http://YOUR_SERVER_IP:$port"
    fi

    echo ""
    success "Raw TCP Direct Access enabled for $network!"
    echo ""
    info "External wallets can now connect using:"
    echo ""
    echo "    check_node_api_http_addr = \"$wallet_addr\""
    echo ""
    info "In grin-wallet.toml set this value and restart the wallet."
    echo ""

    _offer_node_restart "$network"
}

_disable_raw_tcp() {
    local network="$1" port="$2"

    echo -e "\n${BOLD}${CYAN}── Disable Raw TCP Direct Access ($network, port $port) ──${RESET}\n"

    # Locate grin node data directory and toml
    local grin_dir; grin_dir=$(_lookup_grin_dir "$network")
    if [[ -z "$grin_dir" ]]; then
        error "Cannot locate $network node directory."
        return
    fi
    local toml="$grin_dir/grin-server.toml"

    # Revert check_node_api_http_addr to 127.0.0.1:<port>
    if [[ -f "$toml" ]] && grep -q "check_node_api_http_addr" "$toml" 2>/dev/null; then
        sed -i -E "s|check_node_api_http_addr[[:space:]]*=[[:space:]]*\"[^\"]*\"|check_node_api_http_addr = \"127.0.0.1:$port\"|g" "$toml"
        success "Reverted grin-server.toml: check_node_api_http_addr = \"127.0.0.1:$port\""
    else
        warn "check_node_api_http_addr not found in $toml — no change made."
    fi

    # Remove ufw rule
    if command -v ufw &>/dev/null; then
        ufw delete allow "$port/tcp" 2>/dev/null || true
        success "ufw rule removed: $port/tcp"
    fi

    log "Raw TCP disabled: network=$network port=$port"

    _offer_node_restart "$network"
    success "Raw TCP Direct Access disabled for $network."
}

_status_raw_tcp() {
    local network="$1" port="$2"

    echo -e "\n${BOLD}${CYAN}── Raw TCP Status ($network, port $port) ──${RESET}\n"

    local grin_dir; grin_dir=$(_lookup_grin_dir "$network" 2>/dev/null)
    if [[ -z "$grin_dir" ]]; then
        warn "Cannot locate $network node directory. Install the node via Script 01 first."
        return
    fi
    local toml="$grin_dir/grin-server.toml"

    echo -e "  ${BOLD}Grin data dir${RESET} : $grin_dir"
    echo -e "  ${BOLD}Config file  ${RESET} : $toml"
    echo ""

    if [[ -f "$toml" ]]; then
        local current_bind
        current_bind=$(grep 'check_node_api_http_addr' "$toml" 2>/dev/null | head -1 | sed 's/.*= *//' | tr -d '"' || true)
        if [[ -n "$current_bind" ]]; then
            if echo "$current_bind" | grep -q "^0\.0\.0\.0"; then
                echo -e "  ${BOLD}Bind address ${RESET} : ${GREEN}$current_bind${RESET}  ${YELLOW}← MODE A (externally reachable)${RESET}"
            else
                echo -e "  ${BOLD}Bind address ${RESET} : ${DIM}$current_bind${RESET}  ${DIM}← localhost only (MODE A not active)${RESET}"
            fi
        else
            echo -e "  ${BOLD}Bind address ${RESET} : ${DIM}(field not set — using Grin default: 127.0.0.1:$port)${RESET}"
        fi
    else
        warn "grin-server.toml not found at: $toml"
    fi

    echo ""
    if command -v ufw &>/dev/null; then
        if ufw status 2>/dev/null | grep -q "^${port}/tcp.*ALLOW"; then
            echo -e "  ${BOLD}ufw rule     ${RESET} : ${GREEN}OPEN${RESET}  (port $port/tcp is allowed)"
        else
            echo -e "  ${BOLD}ufw rule     ${RESET} : ${DIM}no rule for port $port/tcp${RESET}"
        fi
    else
        echo -e "  ${BOLD}ufw         ${RESET} : ${DIM}ufw not installed — check firewall manually${RESET}"
    fi

    echo ""
    if ss -tlnp 2>/dev/null | grep -q ":$port "; then
        local bind_ip; bind_ip=$(ss -tlnp 2>/dev/null | grep ":$port " | awk '{print $4}' | head -1)
        if echo "$bind_ip" | grep -q "^0\.0\.0\.0\|^\*"; then
            echo -e "  ${BOLD}Socket       ${RESET} : ${GREEN}LISTENING${RESET} on $bind_ip  ${YELLOW}← MODE A active${RESET}"
        else
            echo -e "  ${BOLD}Socket       ${RESET} : ${CYAN}LISTENING${RESET} on $bind_ip  ${DIM}(localhost only)${RESET}"
        fi
    else
        echo -e "  ${BOLD}Socket       ${RESET} : ${RED}NOT LISTENING${RESET}  ${YELLOW}⚠ Grin node not running on port $port${RESET}"
    fi
    echo ""
}

enable_mainnet_raw_tcp()  { _enable_raw_tcp  mainnet "$NODE_API_PORT_MAINNET" "grin-node-api"; }
disable_mainnet_raw_tcp() { _disable_raw_tcp mainnet "$NODE_API_PORT_MAINNET"; }
status_mainnet_raw_tcp()  { _status_raw_tcp  mainnet "$NODE_API_PORT_MAINNET"; }
enable_testnet_raw_tcp()  { _enable_raw_tcp  testnet "$NODE_API_PORT_TESTNET" "grin-node-api-testnet"; }
disable_testnet_raw_tcp() { _disable_raw_tcp testnet "$NODE_API_PORT_TESTNET"; }
status_testnet_raw_tcp()  { _status_raw_tcp  testnet "$NODE_API_PORT_TESTNET"; }

_call_enable_raw_tcp()  { [[ "$NETWORK" == "mainnet" ]] && enable_mainnet_raw_tcp  || enable_testnet_raw_tcp; }
_call_disable_raw_tcp() { [[ "$NETWORK" == "mainnet" ]] && disable_mainnet_raw_tcp || disable_testnet_raw_tcp; }
_call_status_raw_tcp()  { [[ "$NETWORK" == "mainnet" ]] && status_mainnet_raw_tcp  || status_testnet_raw_tcp; }

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
    if [[ -z "$grin_data_dir" ]]; then
        error "Cannot locate $network node directory. Install the node via Script 01 first."
        return
    fi

    if [[ ! -f "$deploy_dir/index.html" ]]; then
        warn "Status page not deployed for $network."
        warn "Run option 6 first to set up the nginx static root, then come back here."
        return
    fi

    echo -e "  REST dir  : ${DIM}$rest_dir${RESET}"
    echo -e "  Collector : ${DIM}$REST_COLLECTOR_DEST${RESET}"
    echo -e "  Cron      : ${DIM}$cron_file${RESET}"
    echo -e "  Grin dir  : ${DIM}$grin_data_dir${RESET}"
    echo ""

    # 1. Install the Python collector to a system lib path so cron can call it directly.
    if [[ ! -f "$REST_COLLECTOR_SRC" ]]; then
        error "Collector script not found: $REST_COLLECTOR_SRC"
        error "Ensure web/04_node_api/rest-collector.py exists in the toolkit directory."
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

    # If a .foreign_api_secret exists, www-data must be able to read it so the
    # rest-collector can authenticate to the Grin foreign API (script 01 always
    # creates this file and enables Basic Auth on the foreign API port).
    local _foreign_secret_file="$grin_data_dir/.foreign_api_secret"
    if [[ -f "$_foreign_secret_file" ]]; then
        chown root:www-data "$_foreign_secret_file"
        chmod 640 "$_foreign_secret_file"
        info "Foreign API secret readable by www-data: $_foreign_secret_file"
    fi

    # 4. Write the main cron job — www-data queries the foreign API.
    #    Pass the secret path so rest-collector can inject Basic Auth when needed.
    #    /etc/cron.d/ files are root-owned 644 and must declare SHELL/PATH.
    cat > "$cron_file" << EOF
# Grin Node Toolkit — REST API updater ($network)
# Queries the Grin $network node foreign API (port $port) every 60 s.
# Writes static JSON files to $rest_dir for nginx to serve.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin

* * * * * www-data python3 $REST_COLLECTOR_DEST $port $rest_dir $_foreign_secret_file 2>/dev/null || true
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
    if sudo -u www-data python3 "$REST_COLLECTOR_DEST" "$port" "$rest_dir" "$_foreign_secret_file" 2>/dev/null; then
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
        info "Cron jobs:"
        info "  REST collector  (www-data) : $cron_file"
        local node_cron_file
        [[ "$network" == "mainnet" ]] && node_cron_file="$NODE_CRON_MAINNET" \
                                      || node_cron_file="$NODE_CRON_TESTNET"
        [[ -f "$node_cron_file" ]] && \
        info "  Node collector  (root)     : $node_cron_file"
        info "Log file : $LOG_FILE"
        log "REST API enabled: network=$network domain=$domain port=$port rest_dir=$rest_dir cron=$cron_file node_cron=$node_cron_file"
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
# MENUS
# ═══════════════════════════════════════════════════════════════════════════════

show_network_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  04) Grin Node API Services Manager${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    local mn_node tn_node
    ss -tlnp 2>/dev/null | grep -q ":$NODE_API_PORT_MAINNET " \
        && mn_node="${GREEN}node RUNNING${RESET}" || mn_node="${RED}node down${RESET}"
    ss -tlnp 2>/dev/null | grep -q ":$NODE_API_PORT_TESTNET " \
        && tn_node="${GREEN}node RUNNING${RESET}" || tn_node="${RED}node down${RESET}"

    echo -e "  ${GREEN}1${RESET}) Mainnet API  ${DIM}($mn_node${DIM}, port $NODE_API_PORT_MAINNET)${RESET}"
    echo -e "  ${YELLOW}2${RESET}) Testnet API  ${DIM}($tn_node${DIM}, port $NODE_API_PORT_TESTNET)${RESET}"
    echo ""
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -ne "${BOLD}Select network [1/2/0]: ${RESET}"
}

show_api_menu() {
    clear
    local net_label="${NETWORK^}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  04) Grin Node API Services  [${net_label}]${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    show_network_status

    local nginx_conf nginx_symlink status_deploy rest_dir rest_cron
    if [[ "$NETWORK" == "mainnet" ]]; then
        nginx_conf="$NODE_API_NGINX_CONF_MAINNET"; nginx_symlink="grin-node-api"
        status_deploy="$STATUS_PAGE_DEPLOY_MAINNET"; rest_dir="$REST_API_DIR_MAINNET"
        rest_cron="$REST_CRON_MAINNET"
    else
        nginx_conf="$NODE_API_NGINX_CONF_TESTNET"; nginx_symlink="grin-node-api-testnet"
        status_deploy="$STATUS_PAGE_DEPLOY_TESTNET"; rest_dir="$REST_API_DIR_TESTNET"
        rest_cron="$REST_CRON_TESTNET"
    fi

    # MODE A status labels
    local label_1a label_2a
    if _raw_tcp_active "$NODE_PORT" 2>/dev/null; then
        local _raw_dom; _raw_dom=$(_detect_grin_domain)
        local _raw_addr="${_raw_dom:-YOUR_SERVER_IP}"
        label_1a="${GREEN}[ACTIVE]${RESET}  ${BOLD}http://$_raw_addr:$NODE_PORT${RESET}  ${DIM}(re-run to re-apply)${RESET}"
        label_2a="${DIM}(close port + revert toml bind)${RESET}"
    else
        label_1a="${DIM}(opens port $NODE_PORT, patches grin-server.toml)${RESET}"
        label_2a="${DIM}(nothing active)${RESET}"
    fi

    # MODE B status labels
    local label_3 label_5 label_7
    if [[ -f "/etc/nginx/sites-enabled/$nginx_symlink" ]]; then
        local _d3; _d3=$(_nginx_domain "$nginx_conf")
        label_3="${GREEN}[CONFIGURED]${RESET} ${BOLD}$_d3${RESET}  ${DIM}(re-run to change domain)${RESET}"
    else
        label_3="${DIM}(/v2/foreign, HTTPS + Let's Encrypt)${RESET}"
    fi

    if [[ -f "$status_deploy/index.html" ]]; then
        local _d5; _d5=$(_nginx_domain "$nginx_conf")
        label_5="${GREEN}[DEPLOYED]${RESET}   ${BOLD}https://$_d5/${RESET}  ${DIM}(re-run to push updates)${RESET}"
    else
        label_5="${DIM}(requires option 4 first)${RESET}"
    fi

    if [[ -f "$rest_dir/stats.json" ]]; then
        local _d7; _d7=$(_nginx_domain "$nginx_conf")
        label_7="${GREEN}[ENABLED]${RESET}    ${BOLD}https://$_d7/rest/${RESET}  ${DIM}(re-run to reinstall collector)${RESET}"
    elif [[ -f "$status_deploy/index.html" ]]; then
        label_7="${DIM}(status page deployed ✓ — ready to enable)${RESET}"
    else
        label_7="${DIM}(requires option 6 first)${RESET}"
    fi

    echo -e "${BOLD}${YELLOW}  ╔══════════════════════════════════════════════════╗${RESET}"
    echo -e "${BOLD}${YELLOW}  ║  IMPORTANT — Choose ONE mode only.               ║${RESET}"
    echo -e "${BOLD}${YELLOW}  ║  Activating both modes will cause port conflicts. ║${RESET}"
    echo -e "${BOLD}${YELLOW}  ╚══════════════════════════════════════════════════╝${RESET}"
    echo ""
    echo -e "${DIM}  ─── MODE A: Raw TCP Direct Access ──────────────────${RESET}"
    echo -e "  ${GREEN}1${RESET}) Enable Raw TCP       $label_1a"
    echo -e "  ${RED}2${RESET}) Disable Raw TCP      $label_2a"
    echo -e "  ${CYAN}3${RESET}) Status Raw TCP       ${DIM}(show current bind address + firewall rule)${RESET}"
    echo ""
    echo -e "${DIM}  ─── MODE B: nginx HTTPS Proxy ───────────────────────${RESET}"
    echo -e "  ${GREEN}4${RESET}) Enable via nginx     $label_3"
    echo -e "  ${RED}5${RESET}) Remove nginx proxy"
    echo ""
    echo -e "${DIM}  ─── Live Status Page (requires option 4) ─────────────${RESET}"
    echo -e "  ${GREEN}6${RESET}) Deploy / Update page $label_5"
    echo -e "  ${RED}7${RESET}) Remove status page"
    echo ""
    echo -e "${DIM}  ─── REST API /rest/*.json (requires option 6) ────────${RESET}"
    echo -e "  ${GREEN}8${RESET}) Enable REST API      $label_7"
    echo -e "  ${RED}9${RESET}) Disable REST API      ${DIM}(removes cron + JSON files)${RESET}"
    echo ""
    echo -e "  ${DIM}↩  Press Enter to refresh status${RESET}"
    echo -e "  ${RED}0${RESET}) Back to network select"
    echo ""
    echo -ne "${BOLD}Select [1-9 / 0]: ${RESET}"
}

# ─── Network-aware dispatch ────────────────────────────────────────────────────
_call_enable_node_api()  { [[ "$NETWORK" == "mainnet" ]] && enable_mainnet_node_api    || enable_testnet_node_api; }
_call_disable_node_api() { [[ "$NETWORK" == "mainnet" ]] && disable_mainnet_node_api   || disable_testnet_node_api; }
_call_enable_status()    { [[ "$NETWORK" == "mainnet" ]] && enable_mainnet_status_page  || enable_testnet_status_page; }
_call_disable_status()   { [[ "$NETWORK" == "mainnet" ]] && disable_mainnet_status_page || disable_testnet_status_page; }
_call_enable_rest()      { [[ "$NETWORK" == "mainnet" ]] && enable_mainnet_rest_api    || enable_testnet_rest_api; }
_call_disable_rest()     { [[ "$NETWORK" == "mainnet" ]] && disable_mainnet_rest_api   || disable_testnet_rest_api; }

main() {
    while true; do
        show_network_menu
        read -r net_choice

        case "$net_choice" in
            0) break ;;
            "") continue ;;
            1|2)
                if [[ "$net_choice" == "2" ]]; then
                    NETWORK="testnet"; NODE_PORT="$NODE_API_PORT_TESTNET"
                else
                    NETWORK="mainnet"; NODE_PORT="$NODE_API_PORT_MAINNET"
                fi

                while true; do
                    show_api_menu
                    read -r choice

                    case "$choice" in
                        1) _call_enable_raw_tcp   || true ;;
                        2) _call_disable_raw_tcp  || true ;;
                        3) _call_status_raw_tcp   || true ;;
                        4) _call_enable_node_api  || true ;;
                        5) _call_disable_node_api || true ;;
                        6) _call_enable_status    || true ;;
                        7) _call_disable_status   || true ;;
                        8) _call_enable_rest      || true ;;
                        9) _call_disable_rest     || true ;;
                        0) break ;;
                        "") continue ;;
                        *) warn "Invalid option." ; sleep 1 ;;
                    esac

                    echo ""
                    echo "Press Enter to continue..."
                    read -r
                done
                ;;
            *) warn "Invalid option." ; sleep 1 ;;
        esac
    done
}

main "$@"
