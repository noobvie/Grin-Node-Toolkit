#!/bin/bash
# =============================================================================
# 06_global_grin_health.sh — Global Grin Health
# =============================================================================
#   A) Network Stats + Peer Map   (Python collector → Chart.js + Leaflet)
#      stats.yourdomain.com       nginx serves /var/www/grin-stats/ (static)
#
#   B) Grin Explorer              (aglkm/grin-explorer — Rust + Rocket)
#      explorer.yourdomain.com    nginx proxy → 127.0.0.1:8000
# =============================================================================
#
# PREREQUISITES — Complete these steps before using this script:
#
#   1. Grin Node  (Script 01)
#      ● Mainnet node is required — testnet peer data is very limited
#      ● Pruned node (/grinprunemain)  → sufficient for option A (Stats + Map)
#      ● Full archive (/grinfullmain)  → required for option B (Explorer)
#        The explorer can also use a remote archival node instead (B→2)
#      ● Node must be running and listening on port 3413 (mainnet)
#
#   2. Nginx + Certbot
#      ● Use option N) in this script's main menu to install nginx + certbot
#      ● This script creates its own nginx site configs (option A→5 and B→5)
#
#   3. DNS records  (external — must be done BEFORE running nginx setup)
#      ● Create an A-record: stats.yourdomain.com    → this server's public IP
#      ● Create an A-record: explorer.yourdomain.com → this server's public IP
#      ● SSL certificates are issued by Certbot automatically at nginx setup time
#
# RECOMMENDED SETUP ORDER (first time):
#   [Script 01]  Install + sync a Grin mainnet node (pruned is fine for stats)
#   [Script 06]  N) Install Nginx + Certbot
#   [DNS panel]  Point your subdomains to this server's IP address
#   [Script 06]  A: 1 Install → 2 Import History → 3 Start Updates → 5 Nginx
#                B: 1 Install & Build → 2 Configure → 3 Start → 5 Nginx
# =============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLKIT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_SRC="$TOOLKIT_ROOT/web/06/stats"
LOG_DIR="$TOOLKIT_ROOT/log"
LOG_FILE="$LOG_DIR/global_grin_health_$(date +%Y%m%d_%H%M%S).log"

# ─── Runtime paths (created on install) ──────────────────────────────────────
DATA_DIR="/var/lib/grin-stats"
WWW_DIR="/var/www/grin-stats"
COLLECTOR_BIN="/usr/local/bin/grin-stats-collector"
DB_PATH="$DATA_DIR/stats.db"
EXPLORER_DIR="/opt/grin-explorer"
EXPLORER_BIN="$EXPLORER_DIR/target/release/grin-explorer"
EXPLORER_TOML="$EXPLORER_DIR/Explorer.toml"

# ─── Nginx config paths ───────────────────────────────────────────────────────
NGINX_STATS_CONF="/etc/nginx/sites-available/grin-stats"
NGINX_EXPLORER_CONF="/etc/nginx/sites-available/grin-explorer"

# ─── Cron markers ─────────────────────────────────────────────────────────────
CRON_MARKER_STATS="# grin-node-toolkit: grin_stats_update"
CRON_MARKER_EXPLORER="# grin-node-toolkit: grin_explorer"

# ─── Grin node ports ─────────────────────────────────────────────────────────
MAINNET_PORT=3413
TESTNET_PORT=13413

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# ─── Logging ──────────────────────────────────────────────────────────────────
mkdir -p "$LOG_DIR"
log()     { echo -e "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }
info()    { echo -e "${CYAN}[INFO]${RESET}  $*";  log "[INFO]  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*";  log "[OK]    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; log "[WARN]  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; log "[ERROR] $*"; }
die()     { error "$*"; echo ""; echo "Press Enter to continue..."; read -r || true; return 1; }
pause()   { echo ""; echo -e "${DIM}Press Enter to continue...${RESET}"; read -r || true; }

# ─── Privilege check ──────────────────────────────────────────────────────────
require_root() {
    [[ $EUID -eq 0 ]] || die "This action requires root / sudo."
}

# ─── Install nginx + certbot ──────────────────────────────────────────────────
install_nginx_certbot() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── Install Nginx + Certbot ──${RESET}\n"

    local nginx_ok=0 certbot_ok=0
    command -v nginx   &>/dev/null && nginx_ok=1
    command -v certbot &>/dev/null && certbot_ok=1

    if [[ $nginx_ok -eq 1 ]]; then
        success "Nginx already installed:   $(nginx -v 2>&1)"
    fi
    if [[ $certbot_ok -eq 1 ]]; then
        success "Certbot already installed: $(certbot --version 2>&1)"
    fi
    if [[ $nginx_ok -eq 1 && $certbot_ok -eq 1 ]]; then
        pause; return
    fi

    echo -ne "${BOLD}Install nginx + certbot now? [Y/n/0]: ${RESET}"
    read -r confirm
    [[ "$confirm" == "0" ]] && return
    [[ "${confirm,,}" == "n" ]] && return

    info "Updating package lists..."
    apt-get update -qq

    if [[ $nginx_ok -eq 0 ]]; then
        info "Installing nginx..."
        apt-get install -y nginx -qq
        systemctl enable nginx --quiet
        systemctl start  nginx  || true
        success "Nginx installed."
    fi

    if [[ $certbot_ok -eq 0 ]]; then
        info "Installing certbot + nginx plugin..."
        apt-get install -y certbot python3-certbot-nginx -qq
        success "Certbot installed."
    fi

    success "Nginx + Certbot are ready."
    log "nginx + certbot installed"
    pause
}

# ─── Detect running Grin node ─────────────────────────────────────────────────
# Sets: NODE_PORT  NODE_URL  API_SECRET_PATH  NODE_DIR
detect_node() {
    local mainnet_up=0 testnet_up=0
    ss -tlnp 2>/dev/null | grep -q ":${MAINNET_PORT} " && mainnet_up=1
    ss -tlnp 2>/dev/null | grep -q ":${TESTNET_PORT} " && testnet_up=1

    if [[ $mainnet_up -eq 1 && $testnet_up -eq 0 ]]; then
        NODE_PORT=$MAINNET_PORT
    elif [[ $mainnet_up -eq 0 && $testnet_up -eq 1 ]]; then
        NODE_PORT=$TESTNET_PORT
    elif [[ $mainnet_up -eq 1 && $testnet_up -eq 1 ]]; then
        NODE_PORT=$MAINNET_PORT
        warn "Both mainnet and testnet running — using mainnet (port $MAINNET_PORT)."
    else
        warn "No Grin node detected. Stats will fail until a node is running."
        NODE_PORT=$MAINNET_PORT
    fi

    NODE_URL="http://127.0.0.1:${NODE_PORT}/v2/foreign"

    if [[ $NODE_PORT -eq $MAINNET_PORT ]]; then
        API_SECRET_PATH="$HOME/.grin/main/.api_secret"
        NODE_DIR="/grinfullmain"
        [[ -d /grinprunemain ]] && NODE_DIR="/grinprunemain"
    else
        API_SECRET_PATH="$HOME/.grin/test/.api_secret"
        NODE_DIR="/grinprunetest"
    fi
}

# ─── Check Python 3 ───────────────────────────────────────────────────────────
check_python() {
    if ! command -v python3 &>/dev/null; then
        info "Installing Python 3..."
        apt-get update -qq && apt-get install -y python3 -qq
    fi
    python3 -c "import sqlite3, urllib.request, json, concurrent.futures" 2>/dev/null \
        || die "Python 3 stdlib modules missing. Please install python3."
}

################################################################################
# OPTION A — Network Stats + Peer Map
################################################################################

# ── A-1: Install ──────────────────────────────────────────────────────────────
install_stats() {
    require_root
    check_python
    clear
    echo -e "\n${BOLD}${CYAN}── Install Network Stats + Peer Map ──${RESET}\n"

    # Create runtime directories
    info "Creating directories..."
    mkdir -p "$DATA_DIR" "$WWW_DIR/data"
    chmod 755 "$DATA_DIR" "$WWW_DIR"

    # Deploy collector script
    info "Installing collector script..."
    cp "$SCRIPT_DIR/06_collector.py" "$COLLECTOR_BIN"
    chmod +x "$COLLECTOR_BIN"

    # Deploy HTML pages
    if [[ ! -d "$WEB_SRC" ]]; then
        die "Web source not found: $WEB_SRC. Ensure the toolkit is complete."
    fi
    info "Deploying web pages..."
    cp "$WEB_SRC/index.html" "$WWW_DIR/index.html"
    cp "$WEB_SRC/map.html"   "$WWW_DIR/map.html"

    # Download Chart.js
    if [[ ! -f "$WWW_DIR/chart.min.js" ]]; then
        info "Downloading Chart.js..."
        curl -fsSL "https://cdn.jsdelivr.net/npm/chart.js/dist/chart.umd.min.js" \
            -o "$WWW_DIR/chart.min.js" \
            || die "Failed to download Chart.js. Check internet connection."
    else
        info "Chart.js already present — skipping download."
    fi

    # Download Chart.js date adapter (required for time-axis charts)
    if [[ ! -f "$WWW_DIR/chartjs-adapter-date-fns.bundle.min.js" ]]; then
        info "Downloading Chart.js date adapter..."
        curl -fsSL "https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3/dist/chartjs-adapter-date-fns.bundle.min.js" \
            -o "$WWW_DIR/chartjs-adapter-date-fns.bundle.min.js" \
            || die "Failed to download Chart.js date adapter. Check internet connection."
    else
        info "Chart.js date adapter already present — skipping download."
    fi

    # Download Leaflet
    if [[ ! -f "$WWW_DIR/leaflet.min.js" ]]; then
        info "Downloading Leaflet.js..."
        curl -fsSL "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.js" \
            -o "$WWW_DIR/leaflet.min.js" \
            || die "Failed to download Leaflet.js. Check internet connection."
    else
        info "Leaflet.js already present — skipping download."
    fi
    if [[ ! -f "$WWW_DIR/leaflet.min.css" ]]; then
        info "Downloading Leaflet.css..."
        curl -fsSL "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.css" \
            -o "$WWW_DIR/leaflet.min.css" \
            || die "Failed to download Leaflet.css. Check internet connection."
    else
        info "Leaflet.css already present — skipping download."
    fi

    # Write collector config
    detect_node
    info "Writing collector config..."
    # Always use the standard Grin config-dir paths for API secrets.
    # detect_node() sets API_SECRET_PATH based on whichever node was detected,
    # but we need BOTH secrets explicitly so the collector can authenticate
    # against both the mainnet and testnet owner APIs independently.
    local mainnet_secret="$HOME/.grin/main/.api_secret"
    local testnet_secret="$HOME/.grin/test/.api_secret"
    [[ -f "$mainnet_secret" ]] \
        || warn "Mainnet secret not found: $mainnet_secret — owner API calls may fail."
    [[ -f "$testnet_secret" ]] \
        || warn "Testnet secret not found: $testnet_secret — testnet peers will be skipped."
    cat > "$DATA_DIR/config.env" <<EOF
GRIN_NODE_URL=${NODE_URL}
GRIN_API_SECRET_PATH=${mainnet_secret}
GRIN_MAINNET_OWNER_URL=http://127.0.0.1:3413/v2/owner
GRIN_TESTNET_OWNER_URL=http://127.0.0.1:13413/v2/owner
GRIN_TESTNET_SECRET_PATH=${testnet_secret}
GRIN_WWW_DATA=${WWW_DIR}/data
GRIN_DB_PATH=${DB_PATH}
EOF
    chmod 600 "$DATA_DIR/config.env"
    info "Config written to $DATA_DIR/config.env"
    info "If your secret files are in a different location, edit that file manually."

    # Initialise empty DB (schema only)
    info "Initialising database..."
    python3 "$COLLECTOR_BIN" --init-db

    # Fix ownership so Nginx (www-data) can serve all web files
    info "Setting file ownership to www-data..."
    chown -R www-data:www-data "$WWW_DIR"

    log "Stats installed: DATA_DIR=$DATA_DIR WWW_DIR=$WWW_DIR"
    success "Network Stats installed."
    echo ""
    echo -e "  ${DIM}Next steps:${RESET}"
    echo -e "  ${GREEN}2${RESET}) Import History   — backfill historical data"
    echo -e "  ${GREEN}3${RESET}) Start Updates    — enable live 5-min refresh"
    echo -e "  ${GREEN}5${RESET}) Setup Nginx      — expose on a subdomain"
    pause
}

# ── A-2: Import History ───────────────────────────────────────────────────────
import_history() {
    [[ ! -f "$COLLECTOR_BIN" ]] && { die "Not installed. Run Install (1) first."; return; }
    clear
    echo -e "\n${BOLD}${CYAN}── Import Historical Data ──${RESET}\n"
    detect_node
    echo -e "  ${DIM}Node   : ${NODE_URL}${RESET}"
    echo -e "  ${DIM}This fetches sampled blocks to build historical charts.${RESET}"
    echo -e "  ${DIM}Typically completes in 2-5 minutes.${RESET}"
    echo ""
    echo -ne "${BOLD}Start import? [Y/n/0]: ${RESET}"
    read -r confirm
    [[ "$confirm" == "0" ]] && return
    [[ "${confirm,,}" == "n" ]] && return

    info "Starting historical import (this may take 2-5 minutes)..."
    echo -e "  ${DIM}Progress will appear below — do not close this window.${RESET}"
    echo ""
    local rc=0
    # shellcheck disable=SC2046
    env $(cat "$DATA_DIR/config.env" | tr '\n' ' ') \
        python3 "$COLLECTOR_BIN" --init-history || rc=$?
    echo ""
    if [[ $rc -eq 0 ]]; then
        success "Historical import complete."
        log "Historical import completed successfully."
    else
        error "Import failed (exit $rc). Check node is running and config.env is valid."
        log "Historical import failed: exit $rc"
    fi
    pause
}

# ── A-3: Start Live Updates ───────────────────────────────────────────────────
start_updates() {
    require_root
    [[ ! -f "$COLLECTOR_BIN" ]] && { die "Not installed. Run Install (1) first."; return; }
    clear
    echo -e "\n${BOLD}${CYAN}── Start Live Updates ──${RESET}\n"

    local existing; existing=$(crontab -l 2>/dev/null || true)
    if echo "$existing" | grep -qF "grin_stats_update"; then
        warn "Stats cron job already active."
        echo -ne "Replace it? [y/N/0]: "
        read -r rep; [[ "$rep" == "0" ]] && return
        if [[ "${rep,,}" == "y" ]]; then
            existing=$(echo "$existing" | grep -v "grin_stats_update" || true)
        else
            info "Keeping existing schedule."; pause; return
        fi
    fi

    local cron_line="*/5 * * * * env \$(cat $DATA_DIR/config.env | tr '\\n' ' ') python3 $COLLECTOR_BIN --update >> $LOG_DIR/grin_stats_cron.log 2>&1 $CRON_MARKER_STATS"
    (echo "$existing"; echo "$cron_line") | grep -v '^$' | crontab -
    success "Live updates enabled — collector runs every 5 minutes."
    log "Stats cron added: $cron_line"
    pause
}

# ── A-4: Stop Live Updates ────────────────────────────────────────────────────
stop_updates() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── Stop Live Updates ──${RESET}\n"
    local existing; existing=$(crontab -l 2>/dev/null || true)
    if ! echo "$existing" | grep -qF "grin_stats_update"; then
        info "No stats cron job found."
        pause; return
    fi
    echo "$existing" | grep -v "grin_stats_update" | grep -v '^$' | crontab -
    success "Live updates disabled."
    log "Stats cron removed."
    pause
}

# ── A-5: Setup Nginx ──────────────────────────────────────────────────────────
setup_nginx_stats() {
    require_root
    [[ ! -d "$WWW_DIR" ]] && { die "Not installed. Run Install (1) first."; return; }
    clear
    echo -e "\n${BOLD}${CYAN}── Setup Nginx — Network Stats ──${RESET}\n"

    command -v nginx &>/dev/null || { die "nginx not installed. Run option N first."; return; }
    command -v certbot &>/dev/null || apt-get install -y certbot python3-certbot-nginx -qq

    echo -ne "${BOLD}Stats subdomain (e.g. stats.yourdomain.com): ${RESET}"
    read -r stats_domain
    [[ -z "$stats_domain" || "$stats_domain" == "0" ]] && return

    echo -ne "${BOLD}Email address for SSL certificate (Let's Encrypt): ${RESET}"
    read -r ssl_email
    if [[ -z "$ssl_email" ]]; then
        warn "Email is required for Let's Encrypt SSL certificate."; pause; return
    fi

    # Write HTTP-only config first — certbot needs nginx to serve the ACME challenge
    info "Creating nginx config for ${stats_domain}..."
    cat > "$NGINX_STATS_CONF" <<NGINX
server {
    listen 80;
    server_name ${stats_domain};

    root  ${WWW_DIR};
    index index.html;

    location / {
        try_files \$uri \$uri/ =404;
    }

    location /data/ {
        add_header Access-Control-Allow-Origin *;
        add_header Cache-Control "public, max-age=300";
        try_files \$uri =404;
    }

    access_log /var/log/nginx/grin-stats-access.log;
    error_log  /var/log/nginx/grin-stats-error.log;
}
NGINX

    ln -sf "$NGINX_STATS_CONF" "/etc/nginx/sites-enabled/grin-stats"
    nginx -t || { die "nginx config test failed. Check $NGINX_STATS_CONF."; return; }
    nginx -s reload

    info "Obtaining SSL certificate for ${stats_domain}..."
    info "Certbot will add HTTPS and redirect to the nginx config automatically."
    certbot --nginx -d "$stats_domain" --non-interactive --agree-tos \
        --email "$ssl_email" --redirect \
        || { warn "Certbot failed — verify DNS A-record resolves to this server (step 4)."; pause; return; }

    nginx -s reload
    success "Stats site live: https://${stats_domain}"
    success "Peer map live:   https://${stats_domain}/map.html"
    log "Nginx stats config created for ${stats_domain}"
    pause
}

# ── A-6: Status ───────────────────────────────────────────────────────────────
status_stats() {
    clear
    echo -e "\n${BOLD}${CYAN}── Network Stats Status ──${RESET}\n"

    # Collector installed?
    [[ -f "$COLLECTOR_BIN" ]] \
        && echo -e "  Collector    ${GREEN}✓ installed${RESET}  ${DIM}($COLLECTOR_BIN)${RESET}" \
        || echo -e "  Collector    ${RED}✗ not installed${RESET}"

    # Database
    if [[ -f "$DB_PATH" ]]; then
        local db_size; db_size=$(du -sh "$DB_PATH" 2>/dev/null | awk '{print $1}')
        echo -e "  Database     ${GREEN}✓ exists${RESET}  ${DIM}($db_size)${RESET}"
    else
        echo -e "  Database     ${RED}✗ not found${RESET}  ${DIM}($DB_PATH)${RESET}"
    fi

    # JSON data files
    echo -e "  JSON exports"
    for f in hashrate difficulty transactions fees versions peers; do
        local jf="$WWW_DIR/data/${f}.json"
        if [[ -f "$jf" ]]; then
            local age; age=$(( ($(date +%s) - $(stat -c %Y "$jf" 2>/dev/null || echo 0)) / 60 ))
            echo -e "    ${GREEN}✓${RESET}  ${f}.json  ${DIM}(${age}m ago)${RESET}"
        else
            echo -e "    ${RED}✗${RESET}  ${f}.json  ${DIM}(not yet generated)${RESET}"
        fi
    done

    # Cron job
    echo ""
    if crontab -l 2>/dev/null | grep -q "grin_stats_update"; then
        echo -e "  Live updates ${GREEN}✓ active${RESET}  ${DIM}(every 5 min)${RESET}"
    else
        echo -e "  Live updates ${YELLOW}✗ inactive${RESET}"
    fi

    # Nginx
    echo ""
    if [[ -f "$NGINX_STATS_CONF" ]]; then
        local domain; domain=$(grep "server_name" "$NGINX_STATS_CONF" | grep -v "80;" | awk '{print $2}' | tr -d ';' | head -1)
        echo -e "  Nginx        ${GREEN}✓ configured${RESET}  ${DIM}(${domain})${RESET}"
    else
        echo -e "  Nginx        ${YELLOW}✗ not configured${RESET}"
    fi

    # Node
    echo ""
    detect_node 2>/dev/null || true
    if ss -tlnp 2>/dev/null | grep -q ":${NODE_PORT} "; then
        echo -e "  Grin node    ${GREEN}✓ running${RESET}  ${DIM}(port ${NODE_PORT})${RESET}"
    else
        echo -e "  Grin node    ${RED}✗ not detected${RESET}"
    fi
    echo ""
    pause
}

################################################################################
# OPTION B — Grin Explorer (aglkm/grin-explorer)
################################################################################

EXPLORER_REPO="https://github.com/aglkm/grin-explorer.git"
EXPLORER_SESSION="grin-explorer"

# ── B-1: Install & Build ──────────────────────────────────────────────────────
install_explorer() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── Install Grin Explorer ──${RESET}\n"
    echo -e "  ${DIM}Repo   : ${EXPLORER_REPO}${RESET}"
    echo -e "  ${DIM}Target : ${EXPLORER_DIR}${RESET}"
    echo ""
    echo -e "  ${YELLOW}Note:${RESET} Compiling Rust takes ${BOLD}10-30 minutes${RESET} on a modest VPS."
    echo -e "  ${DIM}Disk: ~2 GB for Rust toolchain + build artifacts.${RESET}"
    echo ""
    echo -ne "${BOLD}Proceed? [Y/n/0]: ${RESET}"
    read -r confirm
    [[ "$confirm" == "0" ]] && return
    [[ "${confirm,,}" == "n" ]] && return

    # Dependencies
    info "Installing build dependencies..."
    apt-get update -qq
    apt-get install -y build-essential pkg-config libssl-dev libsqlite3-dev \
        git curl -qq

    # Rust toolchain
    if ! command -v cargo &>/dev/null; then
        info "Installing Rust toolchain (rustup)..."
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
            | sh -s -- -y --no-modify-path
        # shellcheck source=/dev/null
        source "$HOME/.cargo/env"
    else
        info "Rust already installed: $(rustc --version)"
        source "$HOME/.cargo/env" 2>/dev/null || true
    fi

    export PATH="$HOME/.cargo/bin:$PATH"

    # Clone or update
    if [[ -d "$EXPLORER_DIR/.git" ]]; then
        info "Updating existing clone..."
        git -C "$EXPLORER_DIR" pull --ff-only
    else
        info "Cloning grin-explorer..."
        git clone "$EXPLORER_REPO" "$EXPLORER_DIR"
    fi

    # Build
    info "Building release binary — this may take 10-30 minutes..."
    echo -e "  ${DIM}Watch build log: tail -f $LOG_DIR/grin_explorer_build.log${RESET}"
    echo ""
    cargo build --release --manifest-path "$EXPLORER_DIR/Cargo.toml" \
        > "$LOG_DIR/grin_explorer_build.log" 2>&1
    local rc=$?
    if [[ $rc -eq 0 ]]; then
        success "Build complete: $EXPLORER_BIN"
        log "Explorer built successfully."
    else
        error "Build failed. See: $LOG_DIR/grin_explorer_build.log"
        log "Explorer build failed: exit $rc"
        pause; return
    fi
    pause
}

# ── B-2: Configure ────────────────────────────────────────────────────────────
configure_explorer() {
    [[ ! -f "$EXPLORER_BIN" ]] && { die "Not installed. Run Install (1) first."; return; }
    clear
    echo -e "\n${BOLD}${CYAN}── Configure Grin Explorer ──${RESET}\n"
    detect_node

    echo -e "  ${DIM}Detected node: ${NODE_URL}${RESET}"
    echo ""
    echo -e "  ${GREEN}1${RESET}) Use local node  ${DIM}(${NODE_URL})${RESET}"
    echo -e "  ${GREEN}2${RESET}) Use remote node  ${DIM}(e.g. grinnode.live)${RESET}"
    echo -e "  ${DIM}0) Cancel${RESET}"
    echo -ne "${BOLD}Select [1]: ${RESET}"
    read -r node_choice

    local cfg_host cfg_port cfg_proto cfg_secret
    case "${node_choice:-1}" in
        2)
            echo -ne "Remote host (e.g. grinnode.live): "; read -r cfg_host
            echo -ne "Port [3413]: "; read -r cfg_port; cfg_port="${cfg_port:-3413}"
            echo -ne "Protocol [https]: "; read -r cfg_proto; cfg_proto="${cfg_proto:-https}"
            cfg_secret=""
            ;;
        *)
            cfg_host="127.0.0.1"
            cfg_port="$NODE_PORT"
            cfg_proto="http"
            # Auto-detect API secret
            if [[ -f "$API_SECRET_PATH" ]]; then
                cfg_secret=$(cat "$API_SECRET_PATH")
                info "API secret loaded from ${API_SECRET_PATH}"
            else
                cfg_secret=""
                warn "API secret not found at ${API_SECRET_PATH} — proceeding without auth."
            fi
            ;;
    esac

    info "Patching Explorer.toml..."
    local toml="$EXPLORER_TOML"
    [[ ! -f "$toml" ]] && { die "Explorer.toml not found: $toml"; return; }

    # Patch node connection settings (preserve other config)
    sed -i "s|^host\s*=.*|host = \"${cfg_host}\"|"             "$toml"
    sed -i "s|^port\s*=.*|port = ${cfg_port}|"                  "$toml"
    sed -i "s|^protocol\s*=.*|protocol = \"${cfg_proto}\"|"    "$toml"

    if [[ -n "$cfg_secret" ]]; then
        sed -i "s|^api_secret_path\s*=.*|api_secret_path = \"${API_SECRET_PATH}\"|" "$toml"
    fi

    # Detect archival vs pruned node and warn
    if [[ "$cfg_host" == "127.0.0.1" ]] && [[ ! -d /grinfullmain ]]; then
        warn "Local node appears to be in pruned mode."
        warn "The explorer works best with a full archival node (/grinfullmain)."
        warn "For full history, consider pointing to a remote archival node."
        echo ""
    fi

    success "Explorer.toml patched."
    log "Explorer configured: host=$cfg_host port=$cfg_port proto=$cfg_proto"
    pause
}

# ── B-3: Start ────────────────────────────────────────────────────────────────
start_explorer() {
    [[ ! -f "$EXPLORER_BIN" ]] && { die "Not installed. Run Install (1) first."; return; }
    clear
    echo -e "\n${BOLD}${CYAN}── Start Grin Explorer ──${RESET}\n"

    if tmux has-session -t "$EXPLORER_SESSION" 2>/dev/null; then
        warn "Explorer session '${EXPLORER_SESSION}' is already running."
        echo -ne "Restart it? [y/N/0]: "
        read -r rep; [[ "$rep" == "0" ]] && return
        if [[ "${rep,,}" == "y" ]]; then
            tmux kill-session -t "$EXPLORER_SESSION" 2>/dev/null || true
            sleep 1
        else
            pause; return
        fi
    fi

    tmux new-session -d -s "$EXPLORER_SESSION" -c "$EXPLORER_DIR" \
        "RUST_LOG=rocket=warn,grin_explorer=info $EXPLORER_BIN; echo ''; echo 'Explorer exited. Press Enter to close.'; read"

    sleep 2
    if ss -tlnp 2>/dev/null | grep -q ":8000 "; then
        success "Explorer running on http://127.0.0.1:8000"
        echo -e "  ${DIM}Attach: tmux attach -t ${EXPLORER_SESSION}  |  Detach: Ctrl+B D${RESET}"
    else
        warn "Explorer may still be starting — check port 8000 in a moment."
        echo -e "  ${DIM}Attach: tmux attach -t ${EXPLORER_SESSION}${RESET}"
    fi
    log "Explorer session started: $EXPLORER_SESSION"
    pause
}

# ── B-4: Stop ─────────────────────────────────────────────────────────────────
stop_explorer() {
    clear
    echo -e "\n${BOLD}${CYAN}── Stop Grin Explorer ──${RESET}\n"
    if tmux has-session -t "$EXPLORER_SESSION" 2>/dev/null; then
        tmux kill-session -t "$EXPLORER_SESSION"
        success "Explorer stopped."
        log "Explorer session killed."
    else
        info "Explorer session not running."
    fi
    pause
}

# ── B-5: Setup Nginx ──────────────────────────────────────────────────────────
setup_nginx_explorer() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── Setup Nginx — Grin Explorer ──${RESET}\n"

    command -v nginx &>/dev/null || { die "nginx not installed. Run option N first."; return; }
    command -v certbot &>/dev/null || apt-get install -y certbot python3-certbot-nginx -qq

    echo -ne "${BOLD}Explorer subdomain (e.g. explorer.yourdomain.com): ${RESET}"
    read -r expl_domain
    [[ -z "$expl_domain" || "$expl_domain" == "0" ]] && return

    echo -ne "${BOLD}Email address for SSL certificate (Let's Encrypt): ${RESET}"
    read -r ssl_email
    if [[ -z "$ssl_email" ]]; then
        warn "Email is required for Let's Encrypt SSL certificate."; pause; return
    fi

    # Write HTTP-only config first — certbot needs nginx to serve the ACME challenge
    info "Creating nginx config for ${expl_domain}..."
    cat > "$NGINX_EXPLORER_CONF" <<NGINX
server {
    listen 80;
    server_name ${expl_domain};

    location / {
        proxy_pass         http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }

    access_log /var/log/nginx/grin-explorer-access.log;
    error_log  /var/log/nginx/grin-explorer-error.log;
}
NGINX

    ln -sf "$NGINX_EXPLORER_CONF" "/etc/nginx/sites-enabled/grin-explorer"
    nginx -t || { die "nginx config test failed. Check $NGINX_EXPLORER_CONF."; return; }
    nginx -s reload

    info "Obtaining SSL certificate for ${expl_domain}..."
    info "Certbot will add HTTPS and redirect to the nginx config automatically."
    certbot --nginx -d "$expl_domain" --non-interactive --agree-tos \
        --email "$ssl_email" --redirect \
        || { warn "Certbot failed — verify DNS A-record resolves to this server (step 4)."; pause; return; }

    nginx -s reload
    success "Explorer live: https://${expl_domain}"
    warn "Ensure the explorer is started (option 3) before visiting the URL."
    log "Nginx explorer config created for ${expl_domain}"
    pause
}

# ── B-6: Status ───────────────────────────────────────────────────────────────
status_explorer() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Explorer Status ──${RESET}\n"

    # Binary
    [[ -f "$EXPLORER_BIN" ]] \
        && echo -e "  Binary       ${GREEN}✓ built${RESET}  ${DIM}($EXPLORER_BIN)${RESET}" \
        || echo -e "  Binary       ${RED}✗ not built${RESET}"

    # Config
    [[ -f "$EXPLORER_TOML" ]] \
        && echo -e "  Config       ${GREEN}✓ present${RESET}  ${DIM}($EXPLORER_TOML)${RESET}" \
        || echo -e "  Config       ${RED}✗ not found${RESET}"

    # tmux session
    echo ""
    if tmux has-session -t "$EXPLORER_SESSION" 2>/dev/null; then
        echo -e "  tmux         ${GREEN}✓ running${RESET}  ${DIM}(session: $EXPLORER_SESSION)${RESET}"
    else
        echo -e "  tmux         ${RED}✗ not running${RESET}"
    fi

    # Port 8000
    if ss -tlnp 2>/dev/null | grep -q ":8000 "; then
        echo -e "  Port 8000    ${GREEN}✓ listening${RESET}"
    else
        echo -e "  Port 8000    ${RED}✗ not listening${RESET}"
    fi

    # Nginx
    echo ""
    if [[ -f "$NGINX_EXPLORER_CONF" ]]; then
        local domain; domain=$(grep "server_name" "$NGINX_EXPLORER_CONF" | grep -v "80;" | awk '{print $2}' | tr -d ';' | head -1)
        echo -e "  Nginx        ${GREEN}✓ configured${RESET}  ${DIM}(${domain})${RESET}"
    else
        echo -e "  Nginx        ${YELLOW}✗ not configured${RESET}"
    fi

    # Node connectivity
    echo ""
    detect_node 2>/dev/null || true
    if ss -tlnp 2>/dev/null | grep -q ":${NODE_PORT} "; then
        echo -e "  Grin node    ${GREEN}✓ running${RESET}  ${DIM}(port ${NODE_PORT})${RESET}"
    else
        echo -e "  Grin node    ${RED}✗ not detected${RESET}"
    fi
    echo ""
    pause
}

################################################################################
# DNS CHECK (shared)
################################################################################

# ─── DNS A-record confirmation ────────────────────────────────────────────────
# $1 = "stats" | "explorer"
check_dns_record() {
    local service="${1:-stats}"
    local example_sub="stats"
    [[ "$service" == "explorer" ]] && example_sub="explorer"
    clear
    echo -e "\n${BOLD}${CYAN}── Check DNS A-Record — ${service^} ──${RESET}\n"
    echo -e "  This step is ${BOLD}required${RESET} before running Setup Nginx (step 5)."
    echo -e "  Certbot will fail to issue an SSL certificate if your subdomain"
    echo -e "  does not already resolve to this server's IP address."
    echo ""
    echo -e "  ${BOLD}This server's IP addresses:${RESET}"
    ip -4 address show scope global 2>/dev/null \
        | grep -oP '(?<=inet )\d+\.\d+\.\d+\.\d+' \
        | while read -r _ip; do echo -e "    ${CYAN}${_ip}${RESET}"; done
    echo ""
    echo -e "  ${DIM}In your DNS provider's dashboard, create an A-record:${RESET}"
    echo -e "  ${DIM}  ${example_sub}.yourdomain.com  →  <one of the IPs above>${RESET}"
    echo -e "  ${DIM}DNS changes can take up to 24 h to propagate (usually < 5 min).${RESET}"
    echo ""
    echo -ne "${BOLD}Have you set (or confirmed) your DNS A-record? [y/N/0]: ${RESET}"
    read -r _dns_confirm
    [[ "$_dns_confirm" == "0" ]] && return
    echo ""
    if [[ "${_dns_confirm,,}" == "y" ]]; then
        success "DNS confirmed. Proceed to Setup Nginx (step 5)."
    else
        warn "Please set your DNS A-record before running Setup Nginx (step 5)."
        warn "Certbot SSL certificate issuance will fail without a valid DNS entry."
    fi
    pause
}

################################################################################
# MENUS
################################################################################

show_menu_a() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  6A) Network Stats + Peer Map${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  ${DIM}Pages served:  /index.html          → hashrate, difficulty, tx, fees, versions${RESET}"
    echo -e "  ${DIM}               /map.html  → Grin peer world map${RESET}"
    echo ""
    local inst="${RED}✗ not installed${RESET}"
    local cron="${YELLOW}inactive${RESET}"
    local ngnx="${YELLOW}not configured${RESET}"
    [[ -f "$COLLECTOR_BIN" ]]                                      && inst="${GREEN}✓ installed${RESET}"
    crontab -l 2>/dev/null | grep -q "grin_stats_update"           && cron="${GREEN}active${RESET}"
    [[ -f "$NGINX_STATS_CONF" ]]                                   && ngnx="${GREEN}✓ configured${RESET}"

    echo -e "  ${GREEN}1${RESET})   Install          ${DIM}collector + Chart.js + Leaflet${RESET}   [$inst]"
    echo -e "  ${GREEN}2${RESET})   Import History   ${DIM}backfill all historical data${RESET}"
    echo -e "  ${GREEN}3${RESET})   Start Updates    ${DIM}cron every 5 min${RESET}  [$cron]"
    echo -e "  ${GREEN}4${RESET})   Check DNS        ${DIM}confirm A-record before nginx setup${RESET}"
    echo -e "  ${GREEN}5${RESET})   Setup Nginx      ${DIM}HTTPS subdomain${RESET}  [$ngnx]"
    echo -e "  ${GREEN}6${RESET})   Status"
    echo -e "  ${YELLOW}Z${RESET})   Stop Updates     ${DIM}disable cron${RESET}"
    echo ""
    echo -e "  ${DIM}0) Back${RESET}"
    echo -e "  ${DIM}[Enter] Refresh menu${RESET}"
    echo ""
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -ne "${BOLD}Select [0-6, Z]: ${RESET}"
}

show_menu_b() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  B) Grin Explorer${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  ${DIM}Repo: github.com/aglkm/grin-explorer  (Rust + Rocket + SQLite)${RESET}"
    echo -e "  ${DIM}Requires: full archival node or remote node URL${RESET}"
    echo ""
    local built="${RED}✗ not built${RESET}"
    local running="${YELLOW}stopped${RESET}"
    local ngnx="${YELLOW}not configured${RESET}"
    [[ -f "$EXPLORER_BIN" ]]                                       && built="${GREEN}✓ built${RESET}"
    tmux has-session -t "$EXPLORER_SESSION" 2>/dev/null            && running="${GREEN}running${RESET}"
    [[ -f "$NGINX_EXPLORER_CONF" ]]                                && ngnx="${GREEN}✓ configured${RESET}"

    echo -e "  ${GREEN}1${RESET})   Install & Build  ${DIM}clone + cargo build --release${RESET}  [$built]"
    echo -e "  ${GREEN}2${RESET})   Configure        ${DIM}patch Explorer.toml${RESET}"
    echo -e "  ${GREEN}3${RESET})   Start            ${DIM}launch in tmux${RESET}  [$running]"
    echo -e "  ${GREEN}4${RESET})   Check DNS        ${DIM}confirm A-record before nginx setup${RESET}"
    echo -e "  ${GREEN}5${RESET})   Setup Nginx      ${DIM}HTTPS subdomain → proxy :8000${RESET}  [$ngnx]"
    echo -e "  ${GREEN}6${RESET})   Status"
    echo -e "  ${YELLOW}Z${RESET})   Stop             ${DIM}kill tmux session${RESET}"
    echo ""
    echo -e "  ${DIM}0) Back${RESET}"
    echo -e "  ${DIM}[Enter] Refresh menu${RESET}"
    echo ""
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -ne "${BOLD}Select [0-6, Z]: ${RESET}"
}

show_main_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  6) Global Grin Health${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    local _node_st _nginx_st
    ss -tlnp 2>/dev/null | grep -q ":3413 " \
        && _node_st="${GREEN}[OK]${RESET} " \
        || _node_st="${RED}[NOK]${RESET}"
    command -v nginx &>/dev/null \
        && _nginx_st="${GREEN}[OK]${RESET} " \
        || _nginx_st="${RED}[NOK]${RESET}"
    echo -e "  ${BOLD}Requirements:${RESET}"
    echo -e "  ${_node_st}  Grin mainnet node running        ${DIM}(pruned is fine for A)${RESET}"
    echo -e "  ${_nginx_st}  Nginx installed                  ${DIM}(use option N to install)${RESET}"
    echo -e "  ${YELLOW}[--]${RESET}  DNS A-records — confirm via A→4 or B→4 before nginx setup"
    echo ""
    echo -e "${DIM}  ─────────────────────────────────────────────${RESET}"
    echo ""
    echo -e "  ${GREEN}N${RESET})   Install Nginx + Certbot  ${DIM}install nginx + certbot on this machine${RESET}"
    echo ""
    echo -e "${DIM}  ─────────────────────────────────────────────${RESET}"
    echo ""
    echo -e "  ${GREEN}A${RESET})   Network Stats + Peer Map"
    echo -e "      ${DIM}Hashrate · Difficulty · Transactions · Fees · Versions · 3D Peer Map${RESET}"
    echo ""
    echo -e "  ${GREEN}B${RESET})   Grin Explorer"
    echo -e "      ${DIM}Browse blocks · Kernels · Search by height or hash${RESET}"
    echo ""
    echo -e "  ${DIM}0) Back to main menu${RESET}"
    echo ""
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -ne "${BOLD}Select [N/A/B/0]: ${RESET}"
}

run_menu_a() {
    while true; do
        show_menu_a
        read -r choice
        case "${choice^^}" in
            1) install_stats              || true ;;
            2) import_history             || true ;;
            3) start_updates              || true ;;
            4) check_dns_record "stats"   || true ;;
            5) setup_nginx_stats          || true ;;
            6) status_stats               || true ;;
            Z) stop_updates               || true ;;
            0) break                               ;;
            "") ;;  # Enter = refresh menu
            *) warn "Invalid option."; sleep 1    ;;
        esac
    done
}

run_menu_b() {
    while true; do
        show_menu_b
        read -r choice
        case "${choice^^}" in
            1) install_explorer                || true ;;
            2) configure_explorer              || true ;;
            3) start_explorer                  || true ;;
            4) check_dns_record "explorer"     || true ;;
            5) setup_nginx_explorer            || true ;;
            6) status_explorer                 || true ;;
            Z) stop_explorer                   || true ;;
            0) break                                    ;;
            "") ;;  # Enter = refresh menu
            *) warn "Invalid option."; sleep 1         ;;
        esac
    done
}

run_interactive() {
    while true; do
        show_main_menu
        read -r choice
        case "${choice^^}" in
            N) install_nginx_certbot ;;
            A) run_menu_a            ;;
            B) run_menu_b            ;;
            0) break                 ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

run_interactive
