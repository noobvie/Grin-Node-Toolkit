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
#      ● Pruned node (/opt/grin/node/mainnet-prune)  → sufficient for option A (Stats + Map)
#      ● Full archive (/opt/grin/node/mainnet-full)  → required for option B (Explorer)
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
WEB_SRC="$TOOLKIT_ROOT/web/06_stats_map/stats"
LOG_DIR="/opt/grin/logs"
LOG_FILE="$LOG_DIR/global_grin_health_$(date +%Y%m%d_%H%M%S).log"

# ─── Runtime paths (created on install) ──────────────────────────────────────
DATA_DIR="/opt/grin/grin-stats"
WWW_DIR="/var/www/grin-stats"
COLLECTOR_BIN="/usr/local/bin/grin-stats-collector"
DB_PATH="$DATA_DIR/stats.db"
PRICE_COLLECTOR_BIN="/usr/local/bin/grin-price-collector"
PRICE_DIR="/opt/grin/grin-price"
PRICE_DB_PATH="$PRICE_DIR/grin-price.db"
EXPLORER_DIR="/opt/grin/grin-explorer"
EXPLORER_BIN="$EXPLORER_DIR/target/release/grin-explorer"
EXPLORER_TOML="$EXPLORER_DIR/Explorer.toml"

# ─── Nginx config paths ───────────────────────────────────────────────────────
NGINX_STATS_CONF="/etc/nginx/sites-available/grin-stats"
NGINX_EXPLORER_CONF="/etc/nginx/sites-available/grin-explorer"

# ─── Cron markers ─────────────────────────────────────────────────────────────
CRON_MARKER_STATS="# grin-node-toolkit: grin_stats_update"
CRON_MARKER_PRICE="# grin-node-toolkit: grin_price_update"
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

# ─── Resolve secret path from grin-server.toml ───────────────────────────────
# Reads api_secret_path or foreign_api_secret_path from a grin-server.toml,
# expands ~ to the grin user's home (/opt/grin), and returns the absolute path.
# Falls back to $default if the field is absent or the resolved file doesn't exist.
_resolve_secret_from_toml() {
    local toml="$1" field="$2" default="$3"
    local raw resolved
    raw=$(grep -E "^[[:space:]]*${field}[[:space:]]*=" "$toml" 2>/dev/null \
          | head -1 | sed 's/.*=[[:space:]]*//' | tr -d '"' | xargs || true)
    [[ -z "$raw" ]] && { echo "$default"; return; }
    # Expand ~ to the grin user home (/opt/grin) — grin runs as the grin user
    resolved="${raw/#\~//opt/grin}"
    [[ -f "$resolved" ]] && echo "$resolved" || echo "$default"
}

# ─── Detect running Grin node ─────────────────────────────────────────────────
# Sets: NODE_PORT  NODE_URL  NODE_DIR  NODE_TYPE  API_SECRET_PATH  FOREIGN_SECRET_PATH
#
# NODE_TYPE is "full" (archive — mainnet-full) or "prune" (pruned — mainnet-prune
# or testnet-prune).  Script 06 features that require full block history (explorer,
# incremental stats) should check NODE_TYPE and warn when only a pruned node is found.
#
# Detection order for mainnet (both directories may co-exist):
#   1. tmux session grin_full_mainnet   is active  → mainnet-full  (preferred)
#   2. tmux session grin_pruned_mainnet is active  → mainnet-prune
#   3. No session found                           → prefer mainnet-full if the
#                                                    directory exists, else prune
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
        # Script 01 names tmux sessions grin_<nodetype>_<networktype>, so the active
        # session name reliably identifies which node is running on port 3413.
        # mainnet-full (archive) is always preferred: it provides complete block
        # history required by the explorer and the stats incremental updater.
        if tmux has-session -t "grin_full_mainnet" 2>/dev/null; then
            NODE_DIR="/opt/grin/node/mainnet-full"
            NODE_TYPE="full"
        elif tmux has-session -t "grin_pruned_mainnet" 2>/dev/null; then
            NODE_DIR="/opt/grin/node/mainnet-prune"
            NODE_TYPE="prune"
        elif [[ -d /opt/grin/node/mainnet-full ]]; then
            # No active tmux session — prefer full archive if the directory exists.
            NODE_DIR="/opt/grin/node/mainnet-full"
            NODE_TYPE="full"
        else
            NODE_DIR="/opt/grin/node/mainnet-prune"
            NODE_TYPE="prune"
        fi
    else
        NODE_DIR="/opt/grin/node/testnet-prune"
        NODE_TYPE="prune"
    fi

    local toml="$NODE_DIR/grin-server.toml"
    API_SECRET_PATH=$(_resolve_secret_from_toml "$toml" "api_secret_path"         "$NODE_DIR/.api_secret")
    FOREIGN_SECRET_PATH=$(_resolve_secret_from_toml "$toml" "foreign_api_secret_path" "$NODE_DIR/.foreign_api_secret")
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
    id grin &>/dev/null && chown -R grin:grin "$DATA_DIR" || true

    # Deploy collector script
    info "Installing collector script..."
    cp "$SCRIPT_DIR/06_collector.py" "$COLLECTOR_BIN"
    chmod +x "$COLLECTOR_BIN"

    # Deploy HTML pages
    if [[ ! -d "$WEB_SRC" ]]; then
        die "Web source not found: $WEB_SRC. Ensure the toolkit is complete."
    fi
    info "Deploying web pages..."
    cp "$WEB_SRC/index.html"  "$WWW_DIR/index.html"
    cp "$WEB_SRC/stats.html"  "$WWW_DIR/stats.html"

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

    # Download Grin logo (SVG) for the page header
    if [[ ! -f "$WWW_DIR/grin-logo.svg" ]]; then
        info "Downloading Grin logo..."
        curl -fsSL "https://canada1.discourse-cdn.com/flex036/uploads/grin/original/1X/f96e1cdce64456785297c317e6cb84f3fab2edcb.svg" \
            -o "$WWW_DIR/grin-logo.svg" \
            || warn "Could not download Grin logo — header logo will be hidden (non-fatal)."
    else
        info "Grin logo already present — skipping download."
    fi

    # Write collector config
    detect_node
    if [[ "$NODE_TYPE" == "full" ]]; then
        info "Detected node type: ${GREEN}full archive${RESET} (${NODE_DIR})  — complete block history available."
    else
        info "Detected node type: ${YELLOW}pruned${RESET} (${NODE_DIR})."
        warn "A full archive node (mainnet-full) is recommended for complete stats history."
        warn "Option B (Explorer) requires a full archive node — install one via Script 01."
    fi
    info "Writing collector config..."
    # Read secret paths from grin-server.toml so we always match what the running
    # node actually uses — regardless of whether secrets are in the node dir or the
    # grin user home (/opt/grin/.grin/main/).
    # detect_node() already resolved API_SECRET_PATH and FOREIGN_SECRET_PATH.
    local mainnet_secret="$API_SECRET_PATH"
    local foreign_secret="$FOREIGN_SECRET_PATH"
    local testnet_toml="/opt/grin/node/testnet-prune/grin-server.toml"
    local testnet_secret
    testnet_secret=$(_resolve_secret_from_toml "$testnet_toml" "api_secret_path" \
                     "/opt/grin/node/testnet-prune/.api_secret")
    [[ -f "$foreign_secret" ]] \
        || warn "Foreign API secret not found: $foreign_secret — foreign API calls may fail."
    [[ -f "$mainnet_secret" ]] \
        || warn "Mainnet secret not found: $mainnet_secret — owner API calls may fail."
    [[ -f "$testnet_secret" ]] \
        || warn "Testnet secret not found: $testnet_secret — testnet peers will be skipped."
    cat > "$DATA_DIR/config.env" <<EOF
GRIN_NODE_URL=${NODE_URL}
GRIN_FOREIGN_SECRET_PATH=${foreign_secret}
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
    info "Initialising stats database..."
    python3 "$COLLECTOR_BIN" --init-db

    # ── Install price collector ───────────────────────────────────────────────
    info "Installing price collector..."
    if [[ ! -f "$SCRIPT_DIR/06_price_collector.py" ]]; then
        warn "06_price_collector.py not found in $SCRIPT_DIR — price charts will be unavailable."
    else
        cp "$SCRIPT_DIR/06_price_collector.py" "$PRICE_COLLECTOR_BIN"
        chmod +x "$PRICE_COLLECTOR_BIN"

        mkdir -p "$PRICE_DIR"
        cat > "$PRICE_DIR/config.env" <<EOF
PRICE_WWW_DATA=${WWW_DIR}/data
PRICE_DB_PATH=${PRICE_DB_PATH}
EOF
        chmod 600 "$PRICE_DIR/config.env"

        # Initialise price DB schema
        python3 "$PRICE_COLLECTOR_BIN" --init-db

        # Backfill Gate.io GRIN/USDT history (paginated — takes ~30 s for 6 years)
        info "Backfilling GRIN/USDT price history from Gate.io (this may take ~30s)..."
        python3 "$PRICE_COLLECTOR_BIN" --init-history \
            || warn "Price history backfill failed — will complete on first --update run."

        success "Price collector installed."
    fi

    # Generate inflation.json immediately — pure math + World Bank M2, no blockchain DB needed.
    # This makes the Inflation Rate Comparison chart visible right after install,
    # without waiting for the first Import Data / --update run.
    info "Generating inflation.json (pure math — no import needed)..."
    env $(cat "$DATA_DIR/config.env" | tr '\n' ' ') python3 "$COLLECTOR_BIN" --export-inflation \
        || warn "inflation.json generation skipped — will be created on first --update run."

    # Fix ownership so Nginx (www-data) can serve all web files
    info "Setting file ownership to www-data..."
    chown -R www-data:www-data "$WWW_DIR"

    log "Stats installed: DATA_DIR=$DATA_DIR WWW_DIR=$WWW_DIR PRICE_DIR=$PRICE_DIR"
    success "Network Stats installed."
    echo ""
    echo -e "  ${DIM}Next steps:${RESET}"
    echo -e "  ${GREEN}2${RESET}) Import Data      — backfill 180 days (recommended) or full history"
    echo -e "  ${GREEN}3${RESET}) Start Updates    — enable live 5-min refresh"
    echo -e "  ${GREEN}5${RESET}) Setup Nginx      — expose on a subdomain"
    pause
}

# ── A-2: Import Data (sub-menu) ───────────────────────────────────────────────
import_data() {
    [[ ! -f "$COLLECTOR_BIN" ]] && { die "Not installed. Run Install (1) first."; return; }
    clear
    echo -e "\n${BOLD}${CYAN}── Import / Update Data ──${RESET}\n"
    detect_node
    echo -e "  ${DIM}Node : ${NODE_URL}${RESET}"
    echo ""
    echo -e "  ${BOLD}── Stats Collector  (node data: hashrate, TX, fees, active peers) ──${RESET}"
    echo -e "  ${DIM}  Options b-g also fetch inflation comparison data (USD M2 + Gold → stored in DB)${RESET}"
    echo ""
    echo -e "  ${GREEN}a${RESET}) Init DB schema only          ${DIM}(RUN ONCE! Creates tables — no data fetched)${RESET}"
    echo -e "  ${GREEN}b${RESET}) Full history import          ${DIM}(RUN ONCE! Import headers + TX/fees — 6+ hours)${RESET}"
    echo -e "  ${DIM}  ─── Optional ───────────────────────────────────────────${RESET}"
    echo -e "  ${GREEN}c${RESET}) Backfill last 180 days       ${DIM}(TX + fees — ~30 min, recommended first run)${RESET}"
    echo -e "  ${GREEN}d${RESET}) Backfill last 90 days        ${DIM}(TX + fees — lighter on memory)${RESET}"
    echo -e "  ${GREEN}e${RESET}) Backfill entire chain        ${DIM}(TX + fees from block 0 — several hours)${RESET}"
    echo -e "  ${GREEN}f${RESET}) Incremental update only      ${DIM}(new blocks since last run)${RESET}"
    echo -e "  ${GREEN}g${RESET}) Peers geolocation only       ${DIM}(refresh peer map + active peers chart, no blockchain data)${RESET}"
    echo ""
    echo -e "  ${BOLD}── Inflation Comparison  (USD M2 + Gold supply inflation → SQLite) ──${RESET}"
    echo ""
    echo -e "  ${GREEN}k${RESET}) Fetch inflation data only    ${DIM}(USD M2 from World Bank + Gold from WGC — no node needed)${RESET}"
    echo -e "  ${DIM}  Use after init-DB (a) or if World Bank was unreachable during a previous run.${RESET}"
    echo ""
    echo -e "  ${BOLD}── Price Collector  (GRIN/USDT from Gate.io) ──${RESET}"
    echo ""
    if [[ ! -f "$PRICE_COLLECTOR_BIN" ]]; then
        echo -e "  ${YELLOW}  Price collector not installed — run Install (1) first.${RESET}"
        echo ""
    else
        echo -e "  ${GREEN}h${RESET}) Init price DB + backfill USDT ${DIM}(RUN ONCE! Creates DB + imports Gate.io history ~30s)${RESET}"
        echo -e "  ${GREEN}i${RESET}) Price incremental update      ${DIM}(fetch latest price + export price.json)${RESET}"
        echo -e "  ${GREEN}j${RESET}) Re-export price JSON only     ${DIM}(no fetch — regenerate price.json from existing DB)${RESET}"
        echo ""
    fi
    echo -e "  ${DIM}0) Cancel${RESET}"
    echo ""
    echo -ne "${BOLD}Select [a-k / 0]: ${RESET}"
    read -r imp_choice
    [[ "$imp_choice" == "0" || -z "$imp_choice" ]] && return

    local cmd="" desc="" bin=""
    case "$imp_choice" in
        # ── Stats collector ──────────────────────────────────────────────────
        a) bin="$COLLECTOR_BIN"; cmd="--init-db";            desc="Stats: Init DB schema only" ;;
        b)
            warn "Full history import takes 6+ hours and should be run only ONCE."
            warn "Run this step inside tmux session to avoid connection interruption."
            echo -ne "Continue? [Y/n/0]: "
            read -r ok || true
            [[ "$ok" == "0" ]] && info "Cancelled." && return
            [[ "${ok,,}" == "n" ]] && info "Cancelled." && return
            bin="$COLLECTOR_BIN"; cmd="--init-history"; desc="Stats: Full history import"
            ;;
        c) bin="$COLLECTOR_BIN"; cmd="--backfill-stats";     desc="Stats: Backfill last 180 days" ;;
        d) bin="$COLLECTOR_BIN"; cmd="--backfill-stats 90";  desc="Stats: Backfill last 90 days" ;;
        e) bin="$COLLECTOR_BIN"; cmd="--backfill-stats all"; desc="Stats: Backfill entire chain TX/fees" ;;
        f) bin="$COLLECTOR_BIN"; cmd="--update";             desc="Stats: Incremental update" ;;
        g) bin="$COLLECTOR_BIN"; cmd="--peers-only";          desc="Stats: Peers geolocation + active peers chart update" ;;
        # ── Inflation comparison ─────────────────────────────────────────────
        k) bin="$COLLECTOR_BIN"; cmd="--export-inflation";   desc="Inflation: Fetch USD M2 (World Bank FM.LBL.BMNY.ZG) + Gold (WGC) → store in DB + write inflation.json" ;;
        # ── Price collector ──────────────────────────────────────────────────
        h)
            [[ ! -f "$PRICE_COLLECTOR_BIN" ]] && { warn "Price collector not installed."; sleep 1; return; }
            bin="$PRICE_COLLECTOR_BIN"; cmd="--init-history"; desc="Price: Init DB + backfill Gate.io USDT history"
            ;;
        i)
            [[ ! -f "$PRICE_COLLECTOR_BIN" ]] && { warn "Price collector not installed."; sleep 1; return; }
            bin="$PRICE_COLLECTOR_BIN"; cmd="--update"; desc="Price: Incremental update"
            ;;
        j)
            [[ ! -f "$PRICE_COLLECTOR_BIN" ]] && { warn "Price collector not installed."; sleep 1; return; }
            bin="$PRICE_COLLECTOR_BIN"; cmd="--export"; desc="Price: Re-export price.json only"
            ;;
        *) warn "Invalid choice."; sleep 1; return ;;
    esac

    echo ""
    info "Running: $desc"
    echo -e "  ${DIM}Progress will appear below — do not close this window.${RESET}"
    echo ""
    local rc=0
    if [[ "$bin" == "$COLLECTOR_BIN" ]]; then
        # shellcheck disable=SC2046
        env $(cat "$DATA_DIR/config.env" | tr '\n' ' ') \
            python3 "$bin" $cmd || rc=$?
    else
        python3 "$bin" $cmd || rc=$?
    fi
    echo ""
    if [[ $rc -eq 0 ]]; then
        success "$desc completed."
        chown -R www-data:www-data "$WWW_DIR" 2>/dev/null || true
        log "$desc completed successfully."
    else
        error "$desc failed (exit $rc)."
        log "$desc failed: exit $rc"
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
        echo -ne "Replace it? [Y/n/0]: "
        read -r rep; [[ "$rep" == "0" ]] && return
        if [[ "${rep,,}" == "n" ]]; then
            info "Keeping existing schedule."; pause; return
        else
            existing=$(echo "$existing" | grep -v "grin_stats_update" || true)
        fi
    fi

    local cron_line="*/5 * * * * env \$(cat $DATA_DIR/config.env | tr '\\n' ' ') python3 $COLLECTOR_BIN --update >> $LOG_DIR/grin_stats_cron.log 2>&1 && chown -R www-data:www-data $WWW_DIR/data >> /dev/null 2>&1 $CRON_MARKER_STATS"

    # Remove any stale price cron before re-adding
    existing=$(echo "$existing" | grep -v "grin_price_update" || true)
    local price_cron=""
    if [[ -f "$PRICE_COLLECTOR_BIN" ]]; then
        price_cron="*/5 * * * * python3 $PRICE_COLLECTOR_BIN --update >> $LOG_DIR/price_cron.log 2>&1 $CRON_MARKER_PRICE"
    fi

    (echo "$existing"; echo "$cron_line"; [[ -n "$price_cron" ]] && echo "$price_cron") \
        | grep -v '^$' | crontab -
    success "Live updates enabled — stats + price collectors run every 5 minutes."
    [[ -z "$price_cron" ]] && warn "Price collector not installed — price cron skipped."
    log "Stats cron added. Price cron: ${price_cron:-(skipped)}"
    pause
}

# ── A-4: Stop Live Updates ────────────────────────────────────────────────────
stop_updates() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── Stop Live Updates ──${RESET}\n"
    local existing; existing=$(crontab -l 2>/dev/null || true)
    local found=false
    echo "$existing" | grep -qF "grin_stats_update" && found=true
    echo "$existing" | grep -qF "grin_price_update"  && found=true
    if [[ "$found" == false ]]; then
        info "No stats or price cron jobs found."
        pause; return
    fi
    echo "$existing" | grep -v "grin_stats_update" | grep -v "grin_price_update" \
        | grep -v '^$' | crontab -
    success "Live updates disabled (stats + price)."
    log "Stats and price crons removed."
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

    while true; do
        echo -ne "${BOLD}Stats subdomain (e.g. stats.yourdomain.com): ${RESET}"
        read -r stats_domain
        [[ -z "$stats_domain" || "$stats_domain" == "0" ]] && return
        local _lbl="${stats_domain%%.*}"
        if [[ "$_lbl" == "fullmain" || "$_lbl" == "prunemain" || "$_lbl" == "prunetest" ]]; then
            warn "'$_lbl' is reserved by script 02 (Grin chain data server). Choose a different subdomain."
            continue
        fi
        break
    done

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
        # Block direct URL access — only allow requests originating from this site
        valid_referers server_names;
        if (\$invalid_referer) {
            return 403;
        }
        add_header Cache-Control "public, max-age=300";
        try_files \$uri =404;
    }

    # ── Public JSON API — whitelisted endpoints only ───────────────────────────
    # Only the files below are intentionally public.
    # /data/ stays blocked; these exact locations are the only way in from outside.
    # Rate limiting (30 req/min/IP, burst 10) is applied via the shared snippet.
    # See /etc/nginx/snippets/grin-api.conf and /etc/nginx/conf.d/grin-rate-limit.conf
    #
    # Endpoints:
    #   /api/summary      → tip height, hashrate, difficulty, supply  (06_collector.py)
    #   /api/hashrate     → GPS history daily/hourly/recent           (06_collector.py)
    #   /api/difficulty   → difficulty history                        (06_collector.py)
    #   /api/transactions → tx-per-block history                      (06_collector.py)
    #   /api/fees         → fees-per-block history                    (06_collector.py)
    #   /api/active_peers → mainnet+testnet peer count history        (06_collector.py)
    #   /api/versions     → node version distribution                 (06_collector.py)
    #   /api/price        → GRIN/USDT price, OHLCV history            (06_price_collector.py)
    #   /api/inflation    → annual supply inflation: grin/usd_m2/gold  (06_collector.py)
    #   /api/peers        → disabled (privacy mode — peer data is internal only)
    #
    location = /api/summary      { include /etc/nginx/snippets/grin-api.conf; alias ${WWW_DIR}/data/summary.json;      }
    location = /api/hashrate     { include /etc/nginx/snippets/grin-api.conf; alias ${WWW_DIR}/data/hashrate.json;     }
    location = /api/difficulty   { include /etc/nginx/snippets/grin-api.conf; alias ${WWW_DIR}/data/difficulty.json;   }
    location = /api/transactions { include /etc/nginx/snippets/grin-api.conf; alias ${WWW_DIR}/data/transactions.json; }
    location = /api/fees         { include /etc/nginx/snippets/grin-api.conf; alias ${WWW_DIR}/data/fees.json;         }
    location = /api/active_peers { include /etc/nginx/snippets/grin-api.conf; alias ${WWW_DIR}/data/active_peers.json; }
    location = /api/versions     { include /etc/nginx/snippets/grin-api.conf; alias ${WWW_DIR}/data/versions.json;     }
    location = /api/price        { include /etc/nginx/snippets/grin-api.conf; alias ${WWW_DIR}/data/price.json;        }
    location = /api/inflation    { include /etc/nginx/snippets/grin-api.conf; alias ${WWW_DIR}/data/inflation.json;    }
    location = /api/peers        { return 404; }

    # Block everything else under /api/ — no directory listing, no other files
    location /api/ { return 404; }

    access_log /var/log/nginx/grin-stats-access.log;
    error_log  /var/log/nginx/grin-stats-error.log;
}
NGINX

    # Rate-limit zone (must live in http context, not server context)
    mkdir -p /etc/nginx/conf.d
    cat > /etc/nginx/conf.d/grin-rate-limit.conf <<'RATELIMIT'
# Grin Node Toolkit — API rate limiting
# 30 requests/min per IP, 10m shared memory zone (~160k IPs)
limit_req_zone $binary_remote_addr zone=grin_api:10m rate=30r/m;
RATELIMIT

    # Shared snippet included by every /api/ location block
    mkdir -p /etc/nginx/snippets
    cat > /etc/nginx/snippets/grin-api.conf <<'SNIPPET'
default_type  application/json;
limit_req     zone=grin_api burst=10 nodelay;
limit_req_status 429;

add_header 'Access-Control-Allow-Origin'  '*'            always;
add_header 'Access-Control-Allow-Methods' 'GET, OPTIONS' always;
add_header 'Access-Control-Allow-Headers' 'Accept'       always;
add_header  Cache-Control "public, max-age=300";

if ($request_method = 'OPTIONS') {
    add_header 'Access-Control-Allow-Origin'  '*';
    add_header 'Access-Control-Allow-Methods' 'GET, OPTIONS';
    add_header 'Content-Length' 0;
    return 204;
}
SNIPPET

    # Logrotate: rotate at 10 MB or after 10 days
    cat > /etc/logrotate.d/grin-stats <<'LOGROTATE'
/var/log/nginx/grin-stats-access.log /var/log/nginx/grin-stats-error.log {
    daily
    rotate 10
    maxsize 10M
    compress
    delaycompress
    missingok
    notifempty
    sharedscripts
    postrotate
        nginx -s reopen 2>/dev/null || true
    endscript
}
LOGROTATE

    ln -sf "$NGINX_STATS_CONF" "/etc/nginx/sites-enabled/grin-stats"
    nginx -t || { die "nginx config test failed. Check $NGINX_STATS_CONF."; return; }
    nginx -s reload

    info "Obtaining SSL certificate for ${stats_domain}..."
    info "Certbot will add HTTPS and redirect to the nginx config automatically."
    certbot --nginx -d "$stats_domain" --non-interactive --agree-tos \
        --email "$ssl_email" --redirect \
        || { warn "Certbot failed — verify DNS A-record resolves to this server (step 4)."; pause; return; }

    nginx -s reload
    success "Site live:       https://${stats_domain}              (peer map — index.html)"
    success "Stats page:      https://${stats_domain}/stats.html"
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

    [[ -f "$PRICE_COLLECTOR_BIN" ]] \
        && echo -e "  Price coll.  ${GREEN}✓ installed${RESET}  ${DIM}($PRICE_COLLECTOR_BIN)${RESET}" \
        || echo -e "  Price coll.  ${YELLOW}✗ not installed${RESET}  ${DIM}(run Install → step 1)${RESET}"

    # Databases
    if [[ -f "$DB_PATH" ]]; then
        local db_size; db_size=$(du -sh "$DB_PATH" 2>/dev/null | awk '{print $1}')
        echo -e "  Stats DB     ${GREEN}✓ exists${RESET}  ${DIM}($db_size)${RESET}"
    else
        echo -e "  Stats DB     ${RED}✗ not found${RESET}  ${DIM}($DB_PATH)${RESET}"
    fi

    if [[ -f "$PRICE_DB_PATH" ]]; then
        local pdb_size; pdb_size=$(du -sh "$PRICE_DB_PATH" 2>/dev/null | awk '{print $1}')
        echo -e "  Price DB     ${GREEN}✓ exists${RESET}  ${DIM}($pdb_size)${RESET}"
    else
        echo -e "  Price DB     ${YELLOW}✗ not found${RESET}  ${DIM}($PRICE_DB_PATH)${RESET}"
    fi

    # JSON data files
    echo -e "  JSON exports"
    for f in summary hashrate difficulty transactions fees active_peers versions peers price inflation; do
        local jf="$WWW_DIR/data/${f}.json"
        if [[ -f "$jf" ]]; then
            local age; age=$(( ($(date +%s) - $(stat -c %Y "$jf" 2>/dev/null || echo 0)) / 60 ))
            echo -e "    ${GREEN}✓${RESET}  ${f}.json  ${DIM}(${age}m ago)${RESET}"
        else
            echo -e "    ${RED}✗${RESET}  ${f}.json  ${DIM}(not yet generated)${RESET}"
        fi
    done

    # Cron jobs
    echo ""
    if crontab -l 2>/dev/null | grep -q "grin_stats_update"; then
        echo -e "  Stats cron   ${GREEN}✓ active${RESET}  ${DIM}(every 5 min)${RESET}"
    else
        echo -e "  Stats cron   ${YELLOW}✗ inactive${RESET}"
    fi
    if crontab -l 2>/dev/null | grep -q "grin_price_update"; then
        echo -e "  Price cron   ${GREEN}✓ active${RESET}  ${DIM}(every 5 min)${RESET}"
    else
        echo -e "  Price cron   ${YELLOW}✗ inactive${RESET}"
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
    apt-get update
    apt-get install -y build-essential pkg-config libssl-dev libsqlite3-dev git curl

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

    # Patch hardcoded /main/ segment in chain_data path.
    # Upstream code uses: format!("{}/main/chain_data", CONFIG.grin_dir)
    # Toolkit stores chain_data at /opt/grin/node/mainnet-full/chain_data (no /main/ subdirectory).
    local requests_rs="$EXPLORER_DIR/src/requests.rs"
    if [[ -f "$requests_rs" ]] && grep -q '/main/chain_data' "$requests_rs"; then
        info "Patching src/requests.rs: removing hardcoded /main/ from chain_data path..."
        sed -i 's|{}/main/chain_data|{}/chain_data|g' "$requests_rs"
        success "Patched: chain_dir now resolves to grin_dir/chain_data directly."
    fi

    # Build
    local build_log="$LOG_DIR/grin_explorer_build_$(date +%Y%m%d_%H%M%S).log"
    info "Building release binary — this may take 10-30 minutes..."
    echo -e "  ${DIM}Log: $build_log${RESET}"
    echo ""
    cargo build --release --manifest-path "$EXPLORER_DIR/Cargo.toml" \
        > "$build_log" 2>&1 &
    local cargo_pid=$!
    # Stream log output so user can see progress
    tail -f "$build_log" --pid="$cargo_pid" 2>/dev/null
    wait "$cargo_pid"
    local rc=$?
    echo ""
    if [[ $rc -eq 0 ]]; then
        success "Build complete: $EXPLORER_BIN"
        log "Explorer built successfully. Log: $build_log"
    else
        error "Build failed. See: $build_log"
        log "Explorer build failed: exit $rc. Log: $build_log"
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
    echo -e "  ${GREEN}1${RESET}) Use local node   ${DIM}(${NODE_URL})${RESET}"
    echo -e "  ${GREEN}2${RESET}) Use remote node  ${DIM}(e.g. scan.grin.money or grincoin.org)${RESET}"
    echo -e "  ${DIM}0) Cancel${RESET}"
    echo -ne "${BOLD}Select [1]: ${RESET}"
    read -r node_choice
    [[ "$node_choice" == "0" ]] && return

    local cfg_host cfg_port cfg_proto cfg_secret cfg_grin_dir api_secret_path foreign_secret_path
    cfg_grin_dir=""
    foreign_secret_path=""

    case "${node_choice:-1}" in
        2)
            echo -ne "Remote host (e.g. scan.grin.money): "; read -r cfg_host
            echo -ne "Port [3413]: "; read -r cfg_port; cfg_port="${cfg_port:-3413}"
            echo -ne "Protocol [https]: "; read -r cfg_proto; cfg_proto="${cfg_proto:-https}"
            cfg_secret=""
            ;;
        *)
            # Verify archive node exists before proceeding
            if [[ ! -d "/opt/grin/node/mainnet-full" ]]; then
                echo ""
                warn "Full archive node not found at /opt/grin/node/mainnet-full"
                echo -e "  ${DIM}The Grin Explorer requires a mainnet archive node to read block data.${RESET}"
                echo -e "  ${DIM}Run ${BOLD}Script 01${RESET}${DIM} and install a mainnet archive node, then return here.${RESET}"
                echo ""
                echo -ne "Press ${BOLD}0${RESET} and Enter to return: "
                while read -r _back; do
                    [[ "$_back" == "0" ]] && break
                    echo -ne "Press ${BOLD}0${RESET} and Enter to return: "
                done
                return
            fi
            cfg_host="127.0.0.1"
            cfg_port="$NODE_PORT"
            cfg_proto="http"
            # Always read secrets from mainnet-full's grin-server.toml directly.
            # detect_node() may resolve NODE_DIR to mainnet-prune when both
            # exist, so we bypass it here and read each field 1:1 from the
            # node config that the explorer actually connects to.
            local _full_toml="/opt/grin/node/mainnet-full/grin-server.toml"
            if [[ -f "$_full_toml" ]]; then
                api_secret_path=$(_resolve_secret_from_toml "$_full_toml" \
                    "api_secret_path" \
                    "/opt/grin/node/mainnet-full/.api_secret")
                foreign_secret_path=$(_resolve_secret_from_toml "$_full_toml" \
                    "foreign_api_secret_path" \
                    "/opt/grin/node/mainnet-full/.foreign_api_secret")
            else
                api_secret_path="$API_SECRET_PATH"
                foreign_secret_path="$FOREIGN_SECRET_PATH"
            fi
            if [[ -f "$foreign_secret_path" ]]; then
                cfg_secret=$(cat "$foreign_secret_path")
                info "Foreign API secret loaded from ${foreign_secret_path}"
            else
                cfg_secret=""
                warn "Foreign API secret not found at ${foreign_secret_path} — proceeding without auth."
            fi
            # Detect grin_dir (parent directory of chain_data, written to Explorer.toml)
            echo ""
            info "Detecting chain_data path for grin_dir..."
            if [[ -d "/opt/grin/node/mainnet-full/chain_data" ]]; then
                cfg_grin_dir="/opt/grin/node/mainnet-full"
                success "Found: /opt/grin/node/mainnet-full/chain_data  ${DIM}(toolkit default for full archive)${RESET}"
            elif [[ -d "$HOME/.grin/main/chain_data" ]]; then
                cfg_grin_dir="$HOME/.grin/main"
                success "Found: $HOME/.grin/main/chain_data"
            else
                warn "chain_data not found in /opt/grin/node/mainnet-full or $HOME/.grin/main"
                echo -e "  ${DIM}The explorer needs a full archive node — pruned nodes are not supported.${RESET}"
                echo -ne "Enter grin_dir path (parent directory of chain_data, or 0 to skip): "
                read -r cfg_grin_dir
                [[ "$cfg_grin_dir" == "0" ]] && cfg_grin_dir=""
            fi
            ;;
    esac

    local toml="$EXPLORER_TOML"
    [[ ! -f "$toml" ]] && { die "Explorer.toml not found: $toml"; return; }

    echo ""
    info "Patching Explorer.toml: $toml"

    # Patch node connection settings
    sed -i "s|^host\s*=.*|host = \"${cfg_host}\"|"          "$toml"
    sed -i "s|^port\s*=.*|port = ${cfg_port}|"               "$toml"
    sed -i "s|^protocol\s*=.*|protocol = \"${cfg_proto}\"|" "$toml"

    if [[ -n "$cfg_secret" ]]; then
        sed -i "s|^api_secret_path\s*=.*|api_secret_path = \"${api_secret_path}\"|"                     "$toml"
        sed -i "s|^foreign_api_secret_path\s*=.*|foreign_api_secret_path = \"${foreign_secret_path}\"|" "$toml"
    fi

    # Patch grin_dir (only for local node; remote nodes connect via API only)
    if [[ -n "$cfg_grin_dir" ]]; then
        sed -i "s|^grin_dir\s*=.*|grin_dir = \"${cfg_grin_dir}\"|" "$toml"
    fi

    # Summary of patched values
    echo ""
    echo -e "${BOLD}  Patched in Explorer.toml:${RESET}"
    echo -e "    host             = ${CYAN}${cfg_host}${RESET}"
    echo -e "    port             = ${CYAN}${cfg_port}${RESET}"
    echo -e "    protocol         = ${CYAN}${cfg_proto}${RESET}"
    [[ -n "$cfg_grin_dir" ]] && \
        echo -e "    grin_dir         = ${CYAN}${cfg_grin_dir}${RESET}  ${DIM}(parent of chain_data)${RESET}"
    [[ -n "$cfg_secret" ]] && \
        echo -e "    api_secret_path          = ${CYAN}${api_secret_path}${RESET}" && \
        echo -e "    foreign_api_secret_path  = ${CYAN}${foreign_secret_path}${RESET}"
    echo ""

    if [[ "$node_choice" != "2" ]] && [[ ! -d /opt/grin/node/mainnet-full ]]; then
        warn "A full archive node (/opt/grin/node/mainnet-full) is recommended for the explorer."
        warn "Pruned nodes lack older block data. Use a remote archival node instead."
    fi

    success "Explorer.toml patched."
    log "Explorer configured: host=$cfg_host port=$cfg_port proto=$cfg_proto grin_dir=${cfg_grin_dir:-skipped}"
    pause
}

# ── B-3: Start ────────────────────────────────────────────────────────────────
start_explorer() {
    [[ ! -f "$EXPLORER_BIN" ]] && { die "Not installed. Run Install (1) first."; return; }
    clear
    echo -e "\n${BOLD}${CYAN}── Start Grin Explorer ──${RESET}\n"

    # Pre-start: verify chain_data path if Explorer.toml is present
    if [[ -f "$EXPLORER_TOML" ]]; then
        local grin_dir_val
        grin_dir_val=$(grep -E '^[[:space:]]*grin_dir[[:space:]]*=' "$EXPLORER_TOML" 2>/dev/null \
                      | sed 's/.*=[[:space:]]*//' | tr -d '"' | xargs || true)
        if [[ -n "$grin_dir_val" && ! -d "$grin_dir_val/chain_data" ]]; then
            warn "chain_data not found at: ${grin_dir_val}/chain_data"
            echo -e "  ${DIM}The explorer reads block data directly from chain_data on disk.${RESET}"
            echo -e "  ${DIM}Toolkit default for full archive: /opt/grin/node/mainnet-full/chain_data${RESET}"
            echo -e "  ${DIM}Run Configure (B→2) to update grin_dir to the correct path.${RESET}"
            echo ""
            echo -ne "Continue anyway? [Y/n/0]: "
            read -r cont_anyway
            [[ "$cont_anyway" == "0" ]] && return
            [[ "${cont_anyway,,}" == "n" ]] && return
            echo ""
        fi
    fi

    if tmux has-session -t "$EXPLORER_SESSION" 2>/dev/null; then
        warn "Explorer session '${EXPLORER_SESSION}' is already running."
        echo -ne "Restart it? [Y/n/0]: "
        read -r rep; [[ "$rep" == "0" ]] && return
        if [[ "${rep,,}" != "n" ]]; then
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
        echo -e "  ${DIM}If it exits immediately, run Configure (B→2) to fix grin_dir / chain_data path.${RESET}"
    fi
    log "Explorer session started: $EXPLORER_SESSION"
    pause
}

# ── B-7: Schedule Explorer auto-start (@reboot via cron) ──────────────────────
schedule_explorer_autostart() {
    [[ ! -f "$EXPLORER_BIN" ]] && { die "Not installed. Run Install (1) first."; return; }
    clear
    echo -e "\n${BOLD}${CYAN}── B-7) Auto-Start Explorer on Boot ──${RESET}\n"
    echo -e "  Adds a ${BOLD}@reboot${RESET} cron entry that sleeps N minutes, then launches"
    echo -e "  grin-explorer in a tmux session (mirrors option 3 — Start)."
    echo ""

    # ── Show all toolkit cron entries so user can assess timing ───────────────
    echo -e "  ${BOLD}Current toolkit cron jobs:${RESET}"
    local all_cron; all_cron=$(crontab -l 2>/dev/null || true)
    local found_any=0
    while IFS= read -r line; do
        echo "$line" | grep -q "grin-node-toolkit" && {
            echo -e "    ${GREEN}▶${RESET} $line"
            found_any=1
        }
    done <<< "$all_cron"
    [[ $found_any -eq 0 ]] && echo -e "    ${DIM}None found.${RESET}"
    echo ""

    # ── Warn if no script-03 nginx cron for full mainnet ──────────────────────
    if ! echo "$all_cron" | grep -q "grin_share_nginx"; then
        echo -e "  ${YELLOW}[NOTICE]${RESET} No script-03 nginx cron detected."
        echo -e "  The explorer reads chain_data from the ${BOLD}full archive mainnet${RESET} node."
        echo -e "  Script 03 (E → Schedule Nginx jobs) refreshes chain_data and restarts"
        echo -e "  the Grin node. Without it the explorer may serve stale or missing data."
        echo -e "  ${DIM}→ Run script 03 → option E to schedule chain_data refresh first.${RESET}"
        echo ""
    fi

    # ── Default sleep: 100 seconds ────────────────────────────────────────────
    local delay=100
    echo -ne "  Boot delay in seconds [${delay}] (default = 100 sec) or 0 to cancel: "
    local inp; read -r inp
    [[ "$inp" == "0" ]] && return
    [[ -n "$inp" && "$inp" =~ ^[0-9]+$ ]] && delay=$inp

    # ── Build cron line ───────────────────────────────────────────────────────
    local cron_log="$LOG_DIR/cron_explorer.log"
    local cron_line="@reboot sleep $delay && env SHELL=/bin/bash tmux new-session -d -s $EXPLORER_SESSION -c $EXPLORER_DIR \"RUST_LOG=rocket=warn,grin_explorer=info $EXPLORER_BIN >> $cron_log 2>&1\" $CRON_MARKER_EXPLORER"

    # ── Check for existing entry ───────────────────────────────────────────────
    if echo "$all_cron" | grep -qF "grin_explorer"; then
        warn "An explorer auto-start cron entry already exists."
        echo -ne "  Replace it? [Y/n/0]: "
        local rep; read -r rep
        [[ "$rep" == "0" ]] && return
        if [[ "${rep,,}" != "n" ]]; then
            all_cron=$(echo "$all_cron" | grep -v "grin_explorer" || true)
        else
            info "Keeping existing entry."; echo ""; pause; return
        fi
    fi

    (echo "$all_cron"; echo "$cron_line") | grep -v '^$' | crontab -
    success "Explorer auto-start scheduled (sleep ${delay}s after boot)."
    log "Explorer @reboot cron added: $cron_line"
    echo ""
    echo -e "  ${DIM}Log: $cron_log${RESET}"
    echo -e "  ${DIM}Run 'crontab -l' to verify. Remove with: crontab -e${RESET}"
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
    echo -e "  Creates an nginx HTTPS reverse proxy for the explorer (port 8000)."
    echo -e "  Obtains a free SSL certificate via Let's Encrypt (certbot)."
    echo ""
    echo -e "  ${YELLOW}Before continuing:${RESET}"
    echo -e "  · DNS A-record must point to this server. If using Cloudflare, change from"
    echo -e "    ${BOLD}Proxied${RESET} to ${BOLD}DNS only${RESET} — enables DNSSeed and avoids Let's Encrypt issues."
    echo -e "  · The explorer (option 3) must be running before visitors can browse it"
    echo ""
    echo -e "  ${DIM}Press 0 at any prompt to cancel and return.${RESET}"
    echo ""

    command -v nginx &>/dev/null || { die "nginx not installed. Run option N first."; return; }
    command -v certbot &>/dev/null || apt-get install -y certbot python3-certbot-nginx -qq

    while true; do
        echo -ne "${BOLD}Enter domain or sub-domain for the explorer (e.g. explorer.yourdomain.com) [0 = cancel]: ${RESET}"
        read -r expl_domain
        [[ -z "$expl_domain" || "$expl_domain" == "0" ]] && return
        local _lbl="${expl_domain%%.*}"
        if [[ "$_lbl" == "fullmain" || "$_lbl" == "prunemain" || "$_lbl" == "prunetest" ]]; then
            warn "'$_lbl' is reserved by script 02 (Grin chain data server). Choose a different subdomain."
            continue
        fi
        break
    done

    echo -ne "${BOLD}Email address for Let's Encrypt SSL certificate [0 = cancel]: ${RESET}"
    read -r ssl_email
    [[ "$ssl_email" == "0" ]] && return
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

    # Logrotate: rotate at 10 MB or after 10 days
    cat > /etc/logrotate.d/grin-explorer <<'LOGROTATE'
/var/log/nginx/grin-explorer-access.log /var/log/nginx/grin-explorer-error.log {
    daily
    rotate 10
    maxsize 10M
    compress
    delaycompress
    missingok
    notifempty
    sharedscripts
    postrotate
        nginx -s reopen 2>/dev/null || true
    endscript
}
LOGROTATE

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

    # Crontab
    echo ""
    local cron_entry; cron_entry=$(crontab -l 2>/dev/null | grep "grin_explorer" | head -1)
    if [[ -n "$cron_entry" ]]; then
        echo -e "  Auto-start   ${GREEN}✓ scheduled${RESET}"
        echo -e "  ${DIM}$cron_entry${RESET}"
    else
        echo -e "  Auto-start   ${YELLOW}✗ not scheduled${RESET}  ${DIM}(use option 6 to set up)${RESET}"
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
    echo -e "  ${BOLD}Using Cloudflare?${RESET} Change your A record from ${BOLD}Proxied${RESET} to ${BOLD}DNS only${RESET}."
    echo -e "  ${DIM}This makes your Grin node reachable as a DNSSeed and avoids certbot / Let's Encrypt issues.${RESET}"
    echo ""
    echo -ne "${BOLD}Have you set (or confirmed) your DNS A-record? [Y/n/0]: ${RESET}"
    read -r _dns_confirm
    [[ "$_dns_confirm" == "0" ]] && return
    echo ""
    if [[ "${_dns_confirm,,}" != "n" ]]; then
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
    echo -e "  ${DIM}Pages served:  /            (index.html) → Grin peer world map${RESET}"
    echo -e "  ${DIM}               /stats.html              → hashrate, difficulty, tx, fees, versions${RESET}"
    echo ""
    local inst="${RED}✗ not installed${RESET}"
    local cron="${YELLOW}inactive${RESET}"
    local ngnx="${YELLOW}not configured${RESET}"
    [[ -f "$COLLECTOR_BIN" ]]                                      && inst="${GREEN}✓ installed${RESET}"
    crontab -l 2>/dev/null | grep -q "grin_stats_update"           && cron="${GREEN}active${RESET}"
    [[ -f "$NGINX_STATS_CONF" ]]                                   && ngnx="${GREEN}✓ configured${RESET}"

    echo -e "  ${GREEN}1${RESET})   Install          ${DIM}collector + Chart.js + Leaflet${RESET}   [$inst]"
    echo -e "  ${GREEN}2${RESET})   Import Data      ${DIM}stats: init / backfill / update  |  price: init / update${RESET}"
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
    local _xcron="${YELLOW}inactive${RESET}"
    crontab -l 2>/dev/null | grep -q "grin_explorer" && _xcron="${GREEN}active${RESET}"
    echo -e "  ${GREEN}6${RESET})   Auto-Start on Boot  ${DIM}@reboot cron via tmux${RESET}  [$_xcron]"
    echo -e "  ${GREEN}7${RESET})   Status"
    echo -e "  ${YELLOW}Z${RESET})   Stop             ${DIM}kill tmux session${RESET}"
    echo ""
    echo -e "  ${DIM}0) Back${RESET}"
    echo -e "  ${DIM}[Enter] Refresh menu${RESET}"
    echo ""
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -ne "${BOLD}Select [0-7, Z]: ${RESET}"
}

show_main_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  06) Global Grin Health${RESET}"
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
    echo -e "  ${_node_st}  Grin mainnet archive node running ${DIM}(both options A and B require archive_mode=true)${RESET}"
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
    echo -e "      ${DIM}Hashrate · Difficulty · Transactions · Fees · Versions · 2D Peer Map${RESET}"
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
            2) import_data                || true ;;
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
            6) schedule_explorer_autostart     || true ;;
            7) status_explorer                 || true ;;
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
