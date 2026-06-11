#!/bin/bash
# =============================================================================
# 07_grin_mining_public_pool.sh — Grin Public Mining Pool (GRINIUM)
# =============================================================================
# Part of: Grin Node Toolkit — launched from the mining hub
# (07_grin_mining_hub_services.sh). Deploys GRINIUM, the public PPLNS Grin
# mining pool, on a Debian/Ubuntu/Rocky/Alma VPS. Run as root.
#
# IMPORTANT: A server runs EITHER solo private mining (07_grin_mining_solo.sh)
# OR this public pool — never both. They collide on nginx rate-limit zones and
# the /opt/grin layout. pool_check_exclusivity
# hard-blocks installation if a solo private setup is detected.
#
# Requirements:
#   · A running Grin node (mainnet) with stratum enabled
#   · Nginx + certbot for HTTPS
#   · Tor for anonymous payouts
#   · A grin-wallet with Foreign and Owner API running
#
# ─── Menu ────────────────────────────────────────────────────────────────────
#   G) Guided Full Setup     (1→2→3→4→5→6→7 in sequence)
#   1) Install               (nodejs ≥18, npm, sqlite3, systemd, logrotate, fail2ban)
#   2) Configure             (pool name, domain, fee, wallet dir, stratum port)
#   3) Deploy web files      (frontend → /var/www/grin-pool)
#   4) Setup nginx           (vhost + rate limits + SSL via certbot)
#   5) Set up wallet         (coinbase Foreign 3415 + payout Owner 3420 listeners)
#   6) Service control       (start / stop / restart)
#   7) Create admin account  (first admin user — needs service running)
#   8) Pool status           (service state, DB size, recent logs)
#   B) Backup                (DB + config → /opt/grin/backups/)
#   C) Cron schedules        (daily backup, weekly VACUUM)
#   L) View logs             (tail -50 | less)
#   S) Edit config           (manual JSON config edit)
#   DEL) Reset database      (⚠ permanently wipes all data)
#   0) Exit
# Mode-selector menu (before the above): Z) Cleanup public mining pool —
#   removes pool/hub/satellite infra for fast rebuild tests; keeps node,
#   wallet seed and backups (mirrors the solo cleanup in 07_grin_mining_solo.sh).
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLKIT_ROOT="$(dirname "$SCRIPT_DIR")"

# Everything below writes /opt/grin, /etc/nginx and systemd units — require root
# up front so the first failure isn't a cryptic mkdir/permission error.
[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "ERROR: this script must be run as root (sudo)." >&2; exit 1; }

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# ─── Constants ────────────────────────────────────────────────────────────────
LOG_DIR="/opt/grin/logs"
LOG_FILE="$LOG_DIR/grinium_$(date +%Y%m%d_%H%M%S).log"

POOL_APP_SRC="$TOOLKIT_ROOT/web/07_mining_pool_public/back-end-pool"
POOL_WEB_SRC="$TOOLKIT_ROOT/web/07_mining_pool_public/public_html"
# "pubpool" family — product-prefixed like solo's /opt/grin/solowallet, so an
# operator can tell at a glance which product owns a dir (renamed 2026-06 from
# the generic grin_pool.json + /opt/grin/pool + /opt/grin/wallet; legacy paths
# are still recognised by Z) Cleanup).
POOL_CONF="/opt/grin/conf/grin_pubpool.json"
POOL_APP_DIR="/opt/grin/pubpool/mainnet"
POOL_WALLET_DIR="/opt/grin/pubpoolwallet/mainnet"
POOL_WEB_DIR="/var/www/grin-pool"
POOL_PORT=8080
POOL_SERVICE="grin-pool-manager"
POOL_NGINX_CONF="/etc/nginx/sites-available/grin-pool"
POOL_LOG="/opt/grin/logs/grin-pool.log"

# ─── Logging ──────────────────────────────────────────────────────────────────
mkdir -p "$LOG_DIR"
log()     { echo -e "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; log "[INFO] $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; log "[OK] $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; log "[WARN] $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; log "[ERROR] $*"; }

# ─── Source nginx helpers ──────────────────────────────────────────────────────
# Uses the toolkit's shared helper (scripts/lib) — same zones/wrappers as every
# other toolkit script, so rate-limit/conn zones never collide.
# shellcheck source=lib/nginx_shared_helpers.sh
source "$SCRIPT_DIR/lib/nginx_shared_helpers.sh"

# ─── Source pool wallet lib (coinbase Foreign 3415 + payout Owner 3420) ────────
# pw_* functions: install/init the pool wallet, run BOTH listeners, autostart +
# watchdog. Same technique as lib/07_solo_wallet.sh, pool naming/dirs. Resolvers
# read live pool config (grin_wallet_dir / wallet_pass_file) at call time, so
# sourcing here — before pool_read_conf is defined — is safe.
# shellcheck source=lib/07_lib_pool_wallet.sh
source "$SCRIPT_DIR/lib/07_lib_pool_wallet.sh"

# ═══════════════════════════════════════════════════════════════════════════════
# EXCLUSIVITY GUARD — one mining type per server (public XOR solo private)
# ═══════════════════════════════════════════════════════════════════════════════
# Solo private mining (07_grin_mining_solo.sh) and this public pool cannot
# coexist: both write nginx rate-limit zones and both own the /opt/grin layout.
# Detect solo artifacts and hard-block.
pool_check_exclusivity() {
    local solo_markers=(
        "/opt/grin/conf/grin_solo_payment.json"
        "/etc/cron.d/grin-solo-mining-collector"
        "/opt/grin/solo-stats"
        "/etc/nginx/grin-solo-stats.htpasswd"
    )
    local found=() m
    for m in "${solo_markers[@]}"; do
        [[ -e "$m" ]] && found+=("$m")
    done
    if systemctl list-units --type=service --all 2>/dev/null | grep -q 'grin-solo'; then
        found+=("systemd: grin-solo-* service")
    fi

    if [[ ${#found[@]} -gt 0 ]]; then
        echo ""
        error "Solo PRIVATE mining is already set up on this server:"
        local f
        for f in "${found[@]}"; do echo -e "    ${DIM}· $f${RESET}"; done
        echo ""
        warn "Run only ONE mining type per server: solo private OR public — not both."
        warn "They collide on nginx rate-limit zones and the /opt/grin layout."
        warn "Remove the solo private setup first (toolkit"
        warn "Script 7 → Solo private → Danger Zone → C) Clean up solo mining),"
        warn "or deploy this public pool on a separate VPS."
        echo ""
        return 1
    fi
    return 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# CONFIG HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

pool_read_conf() {
    local key="$1" default="${2:-}"
    [[ -f "$POOL_CONF" ]] || { echo "$default"; return; }
    node -e "
try {
  const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  const v = d[process.argv[2]];
  process.stdout.write(v !== undefined ? String(v) : process.argv[3]);
} catch(e) { process.stdout.write(process.argv[3]); }
" "$POOL_CONF" "$key" "$default" 2>/dev/null || echo "$default"
}

pool_write_conf_key() {
    local key="$1" val="$2"
    mkdir -p "$(dirname "$POOL_CONF")"
    node -e "
const fs = require('fs');
const path = process.argv[1];
const key  = process.argv[2];
const val  = process.argv[3];
const NUMS = new Set(['stratum_port','node_api_port','pool_fee_percent','min_withdrawal','withdrawal_fee','service_port','node_stratum_port','fail2ban_maxretry','fail2ban_findtime','fail2ban_bantime']);
let d = {};
try { d = JSON.parse(fs.readFileSync(path, 'utf8')); } catch(e) {}
d[key] = NUMS.has(key) ? parseFloat(val) : val;
fs.writeFileSync(path, JSON.stringify(d, null, 2));
fs.chmodSync(path, 0o600);
" "$POOL_CONF" "$key" "$val"
}

pool_ensure_defaults() {
    local -A defaults=(
        ["pool_name"]="My Grin Pool"
        ["subdomain"]=""
        ["network"]="mainnet"
        ["stratum_port"]="3333"
        ["node_api_port"]="3413"
        ["node_stratum_port"]="3334"
        ["node_stratum_host"]="127.0.0.1"
        ["pool_address"]=""
        ["pool_fee_percent"]="1.0"
        ["min_withdrawal"]="5.0"
        ["withdrawal_fee"]="0.0"
        ["grin_wallet_dir"]="$POOL_WALLET_DIR"
        ["log_path"]="$POOL_LOG"
        ["service_port"]="$POOL_PORT"
        ["db_path"]="$POOL_APP_DIR/pool.db"
        ["wallet_pass_file"]="$POOL_APP_DIR/.wallet_pass"
        ["assets_dir"]="$POOL_APP_DIR/custom_assets"
        ["fail2ban_maxretry"]="5"
        ["fail2ban_findtime"]="600"
        ["fail2ban_bantime"]="3600"
    )
    for k in "${!defaults[@]}"; do
        local existing; existing=$(pool_read_conf "$k" "__MISSING__")
        [[ "$existing" == "__MISSING__" ]] && pool_write_conf_key "$k" "${defaults[$k]}"
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# 7) STATUS
# ═══════════════════════════════════════════════════════════════════════════════

pool_show_status() {
    echo -e "\n${BOLD}Pool Manager — Mainnet${RESET}"
    echo -e "${DIM}────────────────────────────────────────────────${RESET}"

    if systemctl is-active --quiet "$POOL_SERVICE" 2>/dev/null; then
        local pid; pid=$(systemctl show "$POOL_SERVICE" --property=MainPID --value 2>/dev/null || echo "?")
        echo -e "  ${BOLD}Service${RESET}  : ${GREEN}● active${RESET}  (pid $pid)"
    elif systemctl is-enabled --quiet "$POOL_SERVICE" 2>/dev/null; then
        echo -e "  ${BOLD}Service${RESET}  : ${YELLOW}installed, stopped${RESET}"
    else
        echo -e "  ${BOLD}Service${RESET}  : ${DIM}not installed${RESET}"
    fi

    local port; port=$(pool_read_conf "service_port" "$POOL_PORT")
    if ss -tlnp 2>/dev/null | grep -q ":$port "; then
        echo -e "  ${BOLD}Port${RESET}     : ${GREEN}$port listening${RESET}"
    else
        echo -e "  ${BOLD}Port${RESET}     : ${DIM}$port — not listening${RESET}"
    fi

    [[ -f "$POOL_APP_DIR/pool.db" ]] && {
        local dbsz; dbsz=$(du -sh "$POOL_APP_DIR/pool.db" 2>/dev/null | cut -f1 || echo "?")
        echo -e "  ${BOLD}Database${RESET} : $POOL_APP_DIR/pool.db  ($dbsz)"
    }

    local subdomain; subdomain=$(pool_read_conf "subdomain" "")
    [[ -n "$subdomain" ]] && echo -e "  ${BOLD}URL${RESET}      : https://$subdomain"

    if [[ -f "$POOL_LOG" ]]; then
        echo -e "\n${DIM}── Recent activity (last 15 lines) ──${RESET}"
        tail -n 15 "$POOL_LOG" 2>/dev/null | sed 's/^/  /'
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# 1) INSTALL
# ═══════════════════════════════════════════════════════════════════════════════

# Ensure Node.js 24+ (node:sqlite needs >= 24). Installs or upgrades via
# NodeSource when the box has no node or one that is too old. Shared by the
# pool install and the satellite install (lib is sourced from this script).
pool_ensure_node24() {
    local node_ver=0
    command -v node &>/dev/null && \
        node_ver=$(node -e 'process.stdout.write(process.version.slice(1).split(".")[0])' 2>/dev/null || echo 0)
    if [[ "$node_ver" -ge 24 ]]; then
        success "Node.js $(node --version 2>/dev/null) found."
        return 0
    fi
    if [[ "$node_ver" -gt 0 ]]; then
        warn "Node.js v${node_ver} found — the pool requires v24+ (node:sqlite). Upgrading via NodeSource..."
    else
        info "Node.js not found — installing v24 LTS via NodeSource..."
    fi
    if command -v apt-get &>/dev/null; then
        # Distro nodejs/npm packages conflict with NodeSource — remove them first.
        apt-get remove -y nodejs npm 2>/dev/null || true
        apt-get autoremove -y 2>/dev/null || true
        curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
            || { error "NodeSource setup failed."; return 1; }
        apt-get install -y nodejs 2>&1 | tail -3 \
            || { error "Node.js install failed."; return 1; }
    elif command -v dnf &>/dev/null; then
        dnf remove -y nodejs npm 2>/dev/null || true
        curl -fsSL https://rpm.nodesource.com/setup_24.x | bash - \
            || { error "NodeSource setup failed."; return 1; }
        dnf install -y nodejs 2>&1 | tail -3 \
            || { error "Node.js install failed."; return 1; }
    else
        error "No apt/dnf found — install Node.js 24+ manually from https://nodejs.org/."
        return 1
    fi
    success "Node.js installed: $(node --version)"
}

pool_install() {
    echo -e "\n${BOLD}Installing Pool Manager (Mainnet)...${RESET}\n"

    pool_check_exclusivity || return 0
    # Defense-in-depth: refuse if a Satellite already occupies this box (in case
    # the selector guard was bypassed via a direct/non-interactive entry).
    pool_mode_conflict_check "${POOL_MODE:-singlebox}" || return 0

    if [[ ! -d "$POOL_APP_SRC" ]]; then
        error "Pool app source not found: $POOL_APP_SRC"
        error "Run this script from within the GRINIUM repository."
        return 1
    fi
    if [[ ! -f "$POOL_APP_SRC/package.json" ]]; then
        error "package.json not found in $POOL_APP_SRC"
        return 1
    fi

    info "Checking system packages..."
    # No build-essential/gcc-c++: the pool has no native npm modules since the
    # better-sqlite3 → node:sqlite migration (everything else is pure JS).
    if command -v apt-get &>/dev/null; then
        apt-get install -y logrotate sqlite3 2>&1 | tail -5
    elif command -v dnf &>/dev/null; then
        dnf install -y logrotate sqlite3 2>&1 | tail -5
    fi

    pool_ensure_node24 || return 1

    mkdir -p "$POOL_APP_DIR"
    chmod 700 "$POOL_APP_DIR"
    info "Copying pool manager to $POOL_APP_DIR..."
    rsync -a --delete "$POOL_APP_SRC/" "$POOL_APP_DIR/" \
        2>/dev/null || cp -r "$POOL_APP_SRC/"* "$POOL_APP_DIR/"

    local npm_cmd="install"
    [[ -f "$POOL_APP_DIR/package-lock.json" ]] && npm_cmd="ci"
    info "Installing Node.js dependencies (npm $npm_cmd)..."
    (cd "$POOL_APP_DIR" && npm "$npm_cmd" --omit=dev 2>&1 | tail -20) \
        || { error "npm $npm_cmd failed in $POOL_APP_DIR — see /root/.npm/_logs/ (latest *-debug-0.log)."; return 1; }
    success "Node.js dependencies installed."

    # No separate DB-init step: lib/db.js initDb() creates/migrates the schema
    # at db_path on every service start.
    info "Database schema is created automatically on first service start."

    local jwt_secret; jwt_secret=$(pool_read_conf "jwt_secret" "")
    if [[ -z "$jwt_secret" ]]; then
        jwt_secret=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" \
            2>/dev/null || openssl rand -hex 32)
        pool_write_conf_key "jwt_secret" "$jwt_secret"
        success "JWT secret generated."
    fi

    pool_ensure_defaults

    local node_bin; node_bin=$(command -v node 2>/dev/null || echo /usr/bin/node)
    cat > "/etc/systemd/system/$POOL_SERVICE.service" << EOF
[Unit]
Description=Grin Pool Manager (GRINIUM — Mainnet)
After=network.target
Wants=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$POOL_APP_DIR
Environment="GRIN_POOL_CONF=$POOL_CONF"
Environment="NODE_ENV=production"
Environment="HOST=127.0.0.1"
Environment="PORT=$POOL_PORT"
ExecStart=$node_bin $POOL_APP_DIR/index.js
Restart=on-failure
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "$POOL_SERVICE" 2>/dev/null || true
    success "Systemd service $POOL_SERVICE installed."

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
        systemctl kill -s USR2 $POOL_SERVICE 2>/dev/null || true
    endscript
}
EOF
    success "Logrotate configured."

    # Fail2ban login guard is part of the base install; non-fatal so a missing
    # EPEL repo doesn't abort the whole install — fix the cause and re-run Install.
    pool_setup_fail2ban || warn "fail2ban setup failed — fix the cause (e.g. enable EPEL) and re-run 1) Install."

    echo ""
    success "Pool manager installed."
    echo -e "  Next: ${BOLD}2) Configure${RESET} → ${BOLD}3) Deploy${RESET} → ${BOLD}4) Nginx${RESET} → ${BOLD}5) Set up wallet${RESET} → ${BOLD}6) Start service${RESET} → ${BOLD}7) Admin account${RESET}"
}

# ═══════════════════════════════════════════════════════════════════════════════
# 2) CONFIGURE
# ═══════════════════════════════════════════════════════════════════════════════

pool_configure() {
    echo -e "\n${BOLD}Configure Pool Manager — Mainnet${RESET}\n"
    pool_ensure_defaults

    local val

    echo -ne "Pool title       [$(pool_read_conf "pool_name" "My Grin Pool")]: "
    read -r val; [[ -n "$val" ]] && pool_write_conf_key "pool_name" "$val"

    echo -e "  ${DIM}(Full domain or subdomain for the pool site, e.g. pool.example.com or example.com)${RESET}"
    echo -ne "Domain/subdomain [$(pool_read_conf "subdomain" "")]: "
    read -r val; [[ -n "$val" ]] && pool_write_conf_key "subdomain" "$val"

    echo -ne "Pool fee %        [$(pool_read_conf "pool_fee_percent" "1.0")]: "
    read -r val; [[ -n "$val" ]] && pool_write_conf_key "pool_fee_percent" "$val"

    echo -ne "Min withdrawal   [$(pool_read_conf "min_withdrawal" "5.0")] GRIN: "
    read -r val; [[ -n "$val" ]] && pool_write_conf_key "min_withdrawal" "$val"

    echo -ne "Wallet dir       [$(pool_read_conf "grin_wallet_dir" "$POOL_WALLET_DIR")]: "
    read -r val; [[ -n "$val" ]] && pool_write_conf_key "grin_wallet_dir" "$val"

    local default_nsp; default_nsp=$(pool_read_conf "node_stratum_port" "3334")
    echo -e "  ${DIM}(Node stratum port — set stratum_server_addr in grin-server.toml to match)${RESET}"
    echo -ne "Node stratum port [${default_nsp}]: "
    read -r val; [[ -n "$val" ]] && pool_write_conf_key "node_stratum_port" "$val"

    local current_addr; current_addr=$(pool_read_conf "pool_address" "")
    echo -e "  ${DIM}(Pool's own Grin address — used to login to node stratum upstream)${RESET}"
    echo -ne "Pool Grin address [${current_addr:-none}]: "
    read -r val; [[ -n "$val" ]] && pool_write_conf_key "pool_address" "$val"

    local pass_file="$POOL_APP_DIR/.wallet_pass"
    echo -ne "Wallet password  (leave blank to keep existing): "
    read -rs val; echo ""
    if [[ -n "$val" ]]; then
        install -m 600 /dev/null "$pass_file"
        echo -n "$val" > "$pass_file"
        pool_write_conf_key "wallet_pass_file" "$pass_file"
        success "Wallet password saved to $pass_file"
    fi

    if systemctl is-active --quiet "$POOL_SERVICE" 2>/dev/null; then
        info "Restarting $POOL_SERVICE to apply config..."
        systemctl restart "$POOL_SERVICE"
    fi
    success "Pool manager configured."
}

# ═══════════════════════════════════════════════════════════════════════════════
# 3) DEPLOY WEB FILES
# ═══════════════════════════════════════════════════════════════════════════════

pool_deploy_web() {
    if [[ ! -d "$POOL_WEB_SRC" ]]; then
        error "Web source not found: $POOL_WEB_SRC"
        return 1
    fi

    info "Deploying web files to $POOL_WEB_DIR..."
    mkdir -p "$POOL_WEB_DIR"
    rsync -a --delete "$POOL_WEB_SRC/" "$POOL_WEB_DIR/" \
        2>/dev/null || cp -r "$POOL_WEB_SRC/"* "$POOL_WEB_DIR/"

    # Serve the full web admin (dashboard/settings/users/payments/incentives/health) at /admin/.
    # It ships in the app source under admin-panel/; copy it into the web root so nginx's
    # `try_files $uri $uri/ $uri.html` resolves /admin/ → /admin/index.html. The admin pages
    # self-guard (redirect to /login.html without a session) and every /api/admin/* call they
    # make is IP-allowlist + JWT protected, so the static HTML itself carries no secrets.
    # NOTE: must run AFTER the --delete rsync above, which would otherwise prune /admin/.
    if [[ -d "$POOL_APP_SRC/admin-panel" ]]; then
        info "Deploying web admin panel to $POOL_WEB_DIR/admin..."
        mkdir -p "$POOL_WEB_DIR/admin"
        rsync -a --delete "$POOL_APP_SRC/admin-panel/" "$POOL_WEB_DIR/admin/" \
            2>/dev/null || cp -r "$POOL_APP_SRC/admin-panel/"* "$POOL_WEB_DIR/admin/"
    fi

    local pool_name; pool_name=$(pool_read_conf "pool_name" "My Grin Pool")
    local escaped_name
    escaped_name=$(node -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$pool_name" 2>/dev/null \
        || printf '"%s"' "${pool_name//\"/\\\"}")
    cat > "$POOL_WEB_DIR/js/pool-config.js" << EOF
// Auto-generated by GRINIUM pool_deploy.sh
window.POOL_NETWORK = "mainnet";
window.POOL_NAME = ${escaped_name};
EOF

    success "Web files deployed to $POOL_WEB_DIR"
}

# ═══════════════════════════════════════════════════════════════════════════════
# 4) SETUP NGINX
# ═══════════════════════════════════════════════════════════════════════════════

pool_setup_nginx() {
    local subdomain; subdomain=$(pool_read_conf "subdomain" "")
    if [[ -z "$subdomain" ]]; then
        echo -ne "Pool subdomain (e.g. pool.example.com): "
        read -r subdomain
        [[ -z "$subdomain" ]] && { warn "No subdomain — nginx not configured."; return 1; }
        pool_write_conf_key "subdomain" "$subdomain"
    fi

    if ! nginx_validate_domain "$subdomain"; then
        error "Invalid domain name: $subdomain"
        return 1
    fi

    mkdir -p "$(dirname "$POOL_NGINX_CONF")"

    # Uploaded white-label assets (logos/icons/OG image) are written here by the app
    # (assets_dir in pool.json) and served by nginx at /custom/. Ensure the directory
    # exists and that nginx can traverse into it (o+rX on the dir and its parents).
    mkdir -p "$POOL_APP_DIR/custom_assets"
    chmod o+rx /opt/grin "$POOL_APP_DIR" "$POOL_APP_DIR/custom_assets" 2>/dev/null || true

    if declare -F nginx_ensure_rate_limit_zones &>/dev/null; then
        nginx_ensure_rate_limit_zones "script07-${POOL_SERVICE}" \
            "${POOL_SERVICE}_auth:3r/m"     \
            "${POOL_SERVICE}_api:30r/m"     \
            "${POOL_SERVICE}_static:60r/m"  \
            "${POOL_SERVICE}_ingest:120r/m"
    fi

    local sites_enabled="/etc/nginx/sites-enabled/$(basename "$POOL_NGINX_CONF")"
    local cert_dir="/etc/letsencrypt/live/$subdomain"

    # ── Certbot bootstrap (same pattern as 052_lib_nginx) ─────────────────────
    # The HTTPS vhost references the Let's Encrypt cert files, so writing it
    # before the cert exists makes `nginx -t` fail and blocks this whole step.
    # On a fresh box: HTTP-only vhost first → certbot → full SSL vhost below.
    if [[ ! -f "$cert_dir/fullchain.pem" ]]; then
        info "No SSL certificate for $subdomain yet — writing HTTP-only vhost first..."
        cat > "$POOL_NGINX_CONF" << EOF
# GRINIUM Grin Pool — HTTP bootstrap (pre-certbot) — generated by Script 07
server {
    listen 80;
    server_name $subdomain;
    root $POOL_WEB_DIR;
    index index.html;

    location /api/ {
        proxy_pass         http://127.0.0.1:$POOL_PORT;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
    location / { try_files \$uri \$uri/ \$uri.html =404; }
}
EOF
        nginx_ensure_sites_enabled_include
        ln -sf "$POOL_NGINX_CONF" "$sites_enabled" 2>/dev/null || true
        nginx -t 2>&1 && systemctl reload nginx \
            || { error "nginx config test failed. Check $POOL_NGINX_CONF"; return 1; }

        echo ""
        echo -ne "Issue the SSL certificate with certbot now? [Y/n]: "
        local do_ssl; read -r do_ssl
        if [[ "${do_ssl,,}" == "n" ]]; then
            warn "Pool stays HTTP-only until a cert exists — re-run 4) Setup nginx after certbot."
            return 0
        fi
        local le_email
        echo -ne "Let's Encrypt email [admin@$subdomain]: "
        read -r le_email; [[ -z "$le_email" ]] && le_email="admin@$subdomain"
        if ! certbot --nginx -d "$subdomain" --non-interactive --agree-tos \
                -m "$le_email" 2>&1 | tail -5; then
            warn "certbot failed — check that DNS for $subdomain points to this server and port 80 is open."
            warn "Pool stays HTTP-only; fix the cause and re-run 4) Setup nginx."
            return 0
        fi
        success "SSL certificate issued."
    fi

    # certbot --nginx creates options-ssl-nginx.conf; include it only when present
    # (a bare `include` of a missing file is a hard nginx -t error).
    local ssl_extra=""
    [[ -f /etc/letsencrypt/options-ssl-nginx.conf ]] \
        && ssl_extra="include /etc/letsencrypt/options-ssl-nginx.conf;"

    info "Writing nginx vhost: $POOL_NGINX_CONF"
    cat > "$POOL_NGINX_CONF" << EOF
# GRINIUM Grin Pool — Mainnet — generated by Script 07 (pool_setup_nginx)
# Rate-limit zones live in /etc/nginx/conf.d/script07-${POOL_SERVICE}.conf

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
    $ssl_extra

    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    # CSP must permit: inline scripts (page bootstraps + branding.js analytics init),
    # the managed analytics providers' script + beacon hosts, and Google Fonts.
    # Self-hosted Plausible/Umami/Matomo on a custom domain require adding that
    # domain to script-src and connect-src below.
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://www.googletagmanager.com https://plausible.io https://cloud.umami.is; connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com https://plausible.io https://cloud.umami.is; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://*.google-analytics.com https://*.googletagmanager.com;" always;

    location /api/auth/ {
        limit_req zone=${POOL_SERVICE}_auth burst=5 nodelay;
        proxy_pass         http://127.0.0.1:$POOL_PORT;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
    }

    # Satellite share/block ingestion (Central API). The app authenticates these
    # (IP allowlist + shared secret); they get their own zone because a satellite
    # batching every ~2 s ≈ 30 r/m would sit exactly at the public API ceiling.
    location = /api/shares {
        limit_req zone=${POOL_SERVICE}_ingest burst=30 nodelay;
        proxy_pass         http://127.0.0.1:$POOL_PORT;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
    location = /api/blocks {
        limit_req zone=${POOL_SERVICE}_ingest burst=30 nodelay;
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

    # SEO / PWA files generated dynamically from admin settings (proxied to the app).
    # Exact-match so they take priority over any static file of the same name.
    location = /robots.txt    { proxy_pass http://127.0.0.1:$POOL_PORT; proxy_set_header Host \$host; }
    location = /sitemap.xml   { proxy_pass http://127.0.0.1:$POOL_PORT; proxy_set_header Host \$host; }
    location = /manifest.json { proxy_pass http://127.0.0.1:$POOL_PORT; proxy_set_header Host \$host; }

    # Operator-uploaded white-label assets (served from assets_dir in pool.json).
    # Uploads are magic-byte validated and given server-controlled names, but we still
    # harden the serving side: nosniff stops a mislabelled file being reinterpreted, and
    # the sandbox CSP neutralises any script inside an SVG opened directly. Correct image
    # MIME types are kept (via the default mime.types) so logos/icons still render.
    location /custom/ {
        alias $POOL_APP_DIR/custom_assets/;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Content-Security-Policy "default-src 'none'; style-src 'unsafe-inline'; sandbox" always;
        add_header Cache-Control "public, max-age=604800" always;
        try_files \$uri =404;
    }

    location / {
        limit_req zone=${POOL_SERVICE}_static burst=20 nodelay;
        try_files \$uri \$uri/ \$uri.html =404;
    }

    access_log /var/log/nginx/${POOL_SERVICE}-access.log;
    error_log  /var/log/nginx/${POOL_SERVICE}-error.log;
}
EOF

    nginx_ensure_sites_enabled_include
    ln -sf "$POOL_NGINX_CONF" "$sites_enabled" 2>/dev/null || true

    nginx -t 2>&1 && systemctl reload nginx \
        && success "nginx configured for https://$subdomain" \
        || { error "nginx config test failed. Check $POOL_NGINX_CONF"; return 1; }
}

# ═══════════════════════════════════════════════════════════════════════════════
# 1b) FAIL2BAN — brute-force protection for the admin login endpoint (run by Install)
# ═══════════════════════════════════════════════════════════════════════════════
#
# A wrong password makes the pool return HTTP 401 on POST /api/auth/login, which nginx
# records in its combined-format access log with the real client IP first. This jail bans
# an IP after repeated 401s on that path. It is defence-in-depth ON TOP of the app's own
# rate limiter (rateLimiter('auth')) and the nginx ${POOL_SERVICE}_auth limit_req zone —
# fail2ban adds a firewall-level ban so a brute-forcer can't keep probing at all.

pool_setup_fail2ban() {
    echo -e "\n${BOLD}Fail2ban — Admin Login Brute-Force Protection${RESET}\n"

    local access_log="/var/log/nginx/${POOL_SERVICE}-access.log"
    local filter="/etc/fail2ban/filter.d/grin-pool-login.conf"
    local jail="/etc/fail2ban/jail.d/grin-pool.conf"

    # Thresholds are operator-tunable in grin_pubpool.json (seeded by pool_ensure_defaults).
    # Read them here and guard against non-numeric / blank edits so a typo can't produce a
    # broken jail file — fall back to the safe 5 / 10 min / 1 h defaults.
    local maxretry findtime bantime
    maxretry=$(pool_read_conf "fail2ban_maxretry" "5")
    findtime=$(pool_read_conf "fail2ban_findtime" "600")
    bantime=$(pool_read_conf  "fail2ban_bantime"  "3600")
    [[ "$maxretry" =~ ^[0-9]+$ ]] || maxretry=5
    [[ "$findtime" =~ ^[0-9]+$ ]] || findtime=600
    [[ "$bantime"  =~ ^[0-9]+$ ]] || bantime=3600

    # 1) Ensure fail2ban is present.
    if ! command -v fail2ban-client &>/dev/null; then
        info "Installing fail2ban..."
        if command -v apt-get &>/dev/null; then
            apt-get install -y fail2ban 2>&1 | tail -5
        elif command -v dnf &>/dev/null; then
            # RHEL-family ships fail2ban via EPEL.
            dnf install -y epel-release 2>&1 | tail -3 || true
            dnf install -y fail2ban 2>&1 | tail -5
        fi
    fi
    if ! command -v fail2ban-client &>/dev/null; then
        error "fail2ban not installed (enable EPEL on RHEL-family, then re-run this step)."
        return 1
    fi

    # 2) Filter — matches ONLY a failed login. Successful logins are 200 and never match;
    #    the real attacker IP is the <HOST> token at the start of each combined-log line.
    cat > "$filter" << 'EOF'
# Fail2ban filter — Grin pool admin login (auto-generated by Script 07; safe to edit).
# Line shape: <ip> - - [time] "POST /api/auth/login HTTP/x.x" 401 ...
[Definition]
failregex = ^<HOST> -[^"]*"POST /api/auth/login(?:\?\S*)? HTTP/[^"]+" 401\b
ignoreregex =
EOF
    success "Filter written: $filter"

    # 3) Jail — 5 failed logins within 10 min → 1 h ban. Lives under jail.d/ so it never
    #    clobbers an operator jail.local; banaction is inherited from the distro [DEFAULT]
    #    (iptables/nftables/firewalld) for portability. Loopback is never banned so the
    #    local nginx proxy hop and on-box health checks stay unaffected.
    cat > "$jail" << EOF
[grin-pool-login]
enabled  = true
filter   = grin-pool-login
port     = http,https
logpath  = $access_log
backend  = auto
maxretry = $maxretry
findtime = $findtime
bantime  = $bantime
ignoreip = 127.0.0.1/8 ::1
EOF
    success "Jail written: $jail"

    # 4) The log must exist or the jail won't start. nginx creates it on first request;
    #    pre-create it (root-owned, like nginx) so the jail starts cleanly right now.
    [[ -f "$access_log" ]] || { mkdir -p /var/log/nginx; : > "$access_log"; }

    # 5) Enable + (re)start and confirm the jail came up.
    systemctl enable fail2ban 2>/dev/null || true
    if systemctl restart fail2ban; then
        success "fail2ban restarted."
    else
        error "fail2ban failed to restart. Inspect: journalctl -u fail2ban -n 30"
        return 1
    fi

    sleep 1
    if fail2ban-client status grin-pool-login &>/dev/null; then
        success "Jail 'grin-pool-login' is active."
        echo ""
        echo -e "  ${DIM}Rule:   ${maxretry} failed logins / ${findtime}s  →  ${bantime}s ban  (edit fail2ban_* in grin_pubpool.json, then re-run 1) Install)${RESET}"
        echo -e "  ${DIM}Status: fail2ban-client status grin-pool-login${RESET}"
        echo -e "  ${DIM}Unban:  fail2ban-client set grin-pool-login unbanip <IP>${RESET}"
        echo -e "  ${DIM}Test:   fail2ban-regex $access_log $filter${RESET}"
    else
        warn "Jail not reporting active yet. Verify: fail2ban-client status grin-pool-login"
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# 5) CREATE ADMIN ACCOUNT
# ═══════════════════════════════════════════════════════════════════════════════

pool_setup_admin() {
    local port; port=$(pool_read_conf "service_port" "$POOL_PORT")
    echo -e "\n${BOLD}Create Admin Account — Mainnet${RESET}\n"

    if ! ss -tlnp 2>/dev/null | grep -q ":$port "; then
        warn "Pool manager is not running on port $port."
        warn "Start the service (option 6) first, then run this again."
        return 1
    fi

    echo -e "  ${DIM}(Username: at least 3 characters)${RESET}"
    echo -ne "Admin username: "
    read -r admin_user
    [[ -z "$admin_user" ]] && return
    if [[ ${#admin_user} -lt 3 ]]; then
        error "Username must be at least 3 characters."
        return 1
    fi

    echo -e "  ${DIM}(Password: at least 8 characters)${RESET}"
    echo -ne "Admin password: "
    read -rs admin_pass; echo ""
    [[ -z "$admin_pass" ]] && return
    if [[ ${#admin_pass} -lt 8 ]]; then
        error "Password must be at least 8 characters."
        return 1
    fi

    echo -ne "Admin email (optional): "
    read -r admin_email

    local payload
    payload=$(node -e "
process.stdout.write(JSON.stringify({
  username: process.argv[1],
  password: process.argv[2],
  email:    process.argv[3]
}))
" "$admin_user" "$admin_pass" "${admin_email:-}" 2>/dev/null)
    if [[ -z "$payload" ]]; then
        error "Failed to build JSON payload (node not available?)."
        return 1
    fi

    # Do NOT use curl -f here: on HTTP 4xx the -f flag discards the JSON body and
    # curl only prints "curl: (22) ... error: 400", hiding the real reason. Capture
    # the body + status code separately so the operator sees the actual error
    # (e.g. "Password must be at least 8 characters" / "Admin registration closed").
    local resp http_code body
    resp=$(curl -sS -X POST "http://127.0.0.1:$port/api/auth/register" \
        -H "Content-Type: application/json" -d "$payload" \
        -w $'\n%{http_code}' 2>&1)
    http_code="${resp##*$'\n'}"
    body="${resp%$'\n'*}"

    if [[ "$http_code" == "200" ]] && echo "$body" | grep -q '"success"[[:space:]]*:[[:space:]]*true'; then
        success "User '$admin_user' registered."
        local safe_user="${admin_user//"'"/"''"}"
        if command -v sqlite3 &>/dev/null; then
            sqlite3 "$POOL_APP_DIR/pool.db" \
                "UPDATE users SET is_admin=1 WHERE username='${safe_user}';" \
                && info "User '$admin_user' promoted to admin."
        else
            node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.prepare('UPDATE users SET is_admin=1 WHERE username=?').run(process.argv[2]);
" "$POOL_APP_DIR/pool.db" "$admin_user" \
                && info "User '$admin_user' promoted to admin."
        fi
    else
        # Pull the human-readable message out of the JSON {"error":"..."} body.
        local msg
        msg=$(printf '%s' "$body" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{const j=JSON.parse(s);process.stdout.write(j.error||j.message||s);}catch{process.stdout.write(s);}
});" 2>/dev/null)
        [[ -z "$msg" ]] && msg="$body"
        error "Registration failed (HTTP ${http_code:-?}): $msg"
        case "$http_code" in
            400) warn "Requirements: username ≥ 3 characters, password ≥ 8 characters." ;;
            403) warn "An admin already exists — registration is closed. Reset via Z) Cleanup or remove the admin row from pool.db to re-register." ;;
            000|"") warn "No response — is the service running? Check 6) Service control and 8) Pool status." ;;
        esac
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# 5) POOL WALLET (coinbase Foreign 3415 + payout Owner 3420)
# ═══════════════════════════════════════════════════════════════════════════════
# Thin menu over the pw_* functions in lib/07_lib_pool_wallet.sh. The pool needs
# BOTH wallet APIs running: Foreign (the node's stratum builds coinbase here →
# block rewards) and Owner (the backend sends Tor payouts here). Setup installs
# the binary, inits/recovers the wallet, patches the node's wallet_listener_url,
# and starts both listeners; the rest is ongoing listener control.

pool_wallet_menu() {
    while true; do
        echo -e "\n${BOLD}Pool Wallet — coinbase (Foreign 3415) + payouts (Owner 3420)${RESET}"
        pw_listener_status
        local wd_tag
        if [[ -f "$PW_WATCHDOG_CRON" ]]; then wd_tag="${GREEN}[OK] watchdog${RESET}"; else wd_tag="${DIM}[--] watchdog${RESET}"; fi
        echo -e "  $(pw_autostart_status)    $wd_tag"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Set up wallet        ${DIM}(install + init/recover + patch node + start)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Start listeners      ${DIM}(Foreign 3415 + Owner 3420)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Stop listeners"
        echo -e "  ${GREEN}4${RESET}) Show pool address"
        echo -e "  ${GREEN}5${RESET}) Patch node wallet_listener_url"
        echo -e "  ${GREEN}6${RESET}) Auto-restart on boot ${DIM}(enable / disable)${RESET}"
        echo -e "  ${GREEN}7${RESET}) Watchdog */5        ${DIM}(install / remove)${RESET}"
        echo -e "  ${DIM}0) Back${RESET}"
        echo -ne "${BOLD}Select: ${RESET}"
        local c; read -r c
        case "$c" in
            1) pw_setup || true ;;
            2) pw_listener_start || true ;;
            3) pw_listener_stop || true ;;
            4) pw_show_address || true ;;
            5) pw_patch_node_toml || true ;;
            6) echo -ne "  Enable or disable? [e/d]: "; local a; read -r a
               case "${a,,}" in
                   e) pw_autostart_enable || true ;;
                   d) pw_autostart_disable || true ;;
                   *) warn "Cancelled." ;;
               esac ;;
            7) echo -ne "  Install or remove? [i/r]: "; local w; read -r w
               case "${w,,}" in
                   i) pw_watchdog_install || true ;;
                   r) pw_watchdog_remove || true ;;
                   *) warn "Cancelled." ;;
               esac ;;
            0|"") return 0 ;;
            *) warn "Invalid option." ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# 6) SERVICE CONTROL
# ═══════════════════════════════════════════════════════════════════════════════

pool_service_control() {
    local action="$1"
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
    echo -e "\n${BOLD}Service Control — $POOL_SERVICE${RESET}"
    if systemctl is-active --quiet "$POOL_SERVICE" 2>/dev/null; then
        echo -e "  Status: ${GREEN}● running${RESET}"
        echo -e "  ${GREEN}1${RESET}) Stop    ${RED}2${RESET}) Restart    ${DIM}0) Back${RESET}"
        echo -ne "Choice: "
        read -r sc
        case "$sc" in
            1) pool_service_control stop ;;
            2) pool_service_control restart ;;
        esac
    else
        echo -e "  Status: ${RED}● stopped${RESET}"
        echo -e "  ${GREEN}1${RESET}) Start    ${DIM}0) Back${RESET}"
        echo -ne "Choice: "
        read -r sc
        # if-form: a trailing `[[ ]] &&` would make "0/back" return 1 → set -e kills the caller
        if [[ "$sc" == "1" ]]; then pool_service_control start; fi
    fi
}

pool_start_service() {
    if ! systemctl is-active --quiet "$POOL_SERVICE" 2>/dev/null; then
        pool_service_control start
    else
        info "$POOL_SERVICE is already running."
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# B) BACKUP
# ═══════════════════════════════════════════════════════════════════════════════

pool_backup() {
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

    ls -t "$backup_dir"/pool_backup_*.tar.gz 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null || true
}

# ═══════════════════════════════════════════════════════════════════════════════
# C) CRON SCHEDULES
# ═══════════════════════════════════════════════════════════════════════════════

pool_cron_schedules() {
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

    local backup_wrapper="/usr/local/bin/grin-pool-backup-mainnet"

    case "$cc" in
        1)
            if [[ -f "$cron_backup" ]]; then
                rm -f "$cron_backup" "$backup_wrapper"
                success "Daily backup cron disabled."
            else
                cat > "$backup_wrapper" << SCRIPT
#!/bin/bash
set -euo pipefail
BACKUP_DIR="/opt/grin/backups/${POOL_SERVICE}"
mkdir -p "\$BACKUP_DIR"
TS=\$(date +%Y%m%d_%H%M%S)
FILES=()
[[ -f "$POOL_APP_DIR/pool.db" ]] && FILES+=("$POOL_APP_DIR/pool.db")
[[ -f "$POOL_CONF" ]]            && FILES+=("$POOL_CONF")
if [[ \${#FILES[@]} -eq 0 ]]; then
    echo "[grin-pool-backup-mainnet] Nothing to back up."
    exit 0
fi
tar -czf "\$BACKUP_DIR/pool_backup_\${TS}.tar.gz" "\${FILES[@]}"
ls -t "\$BACKUP_DIR"/pool_backup_*.tar.gz 2>/dev/null | tail -n +31 | xargs -r rm -f
SCRIPT
                chmod 750 "$backup_wrapper"
                cat > "$cron_backup" << EOF
0 2 * * * root $backup_wrapper >> $POOL_LOG 2>&1
EOF
                success "Daily backup cron enabled ($cron_backup → $backup_wrapper)."
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

# ═══════════════════════════════════════════════════════════════════════════════
# L) VIEW LOGS
# ═══════════════════════════════════════════════════════════════════════════════

pool_view_logs() {
    if [[ ! -f "$POOL_LOG" ]]; then
        warn "Log file not found: $POOL_LOG"
        return
    fi
    tail -n 50 "$POOL_LOG" | less -FRX
}

# ═══════════════════════════════════════════════════════════════════════════════
# DEL) RESET DATABASE
# ═══════════════════════════════════════════════════════════════════════════════

pool_reset_db() {
    local db_path="$POOL_APP_DIR/pool.db"

    echo -e "\n${RED}${BOLD}━━━ DANGER ZONE — Reset Pool Database ━━━${RESET}"
    echo ""

    if [[ ! -f "$db_path" ]]; then
        warn "Database not found: $db_path"
        return
    fi

    local db_size; db_size=$(du -sh "$db_path" 2>/dev/null | cut -f1 || echo "?")
    local user_count
    if command -v sqlite3 &>/dev/null; then
        user_count=$(sqlite3 "$db_path" "SELECT COUNT(*) FROM users;" 2>/dev/null || echo "?")
    else
        user_count="?"
    fi

    echo -e "  Database : $db_path  ($db_size)"
    echo -e "  Users    : $user_count accounts"
    echo -e "  Network  : Mainnet"
    echo ""
    warn "This will permanently DELETE all users, balances, shares, blocks, and withdrawals."
    echo ""
    echo -ne "Type ${RED}RESET POOL DATABASE${RESET} to confirm: "
    read -r confirm1
    [[ "$confirm1" != "RESET POOL DATABASE" ]] && { info "Aborted."; return; }

    echo -ne "Type ${RED}YES${RESET} to proceed: "
    read -r confirm2
    [[ "$confirm2" != "YES" ]] && { info "Aborted."; return; }

    pool_service_control stop 2>/dev/null || true
    sleep 1

    rm -f "${db_path:?refusing to rm — db_path is empty}"
    success "Database deleted."
    info "A fresh schema is created automatically when the service starts (lib/db.js)."

    pool_service_control start 2>/dev/null || true
}

# ═══════════════════════════════════════════════════════════════════════════════
# G) GUIDED FULL SETUP
# ═══════════════════════════════════════════════════════════════════════════════

pool_guided_setup() {
    echo -e "\n${BOLD}${CYAN}═══ Guided Full Setup — GRINIUM Pool (Mainnet) ═══${RESET}\n"
    pool_check_exclusivity || return 0
    echo -e "  This will run steps 1 → 2 → 3 → 4 → 5 → 6 → 7 in sequence."
    echo -ne "  Continue? [Y/n]: "
    read -r go; [[ "${go,,}" == "n" ]] && return

    # Every step is ||-guarded: under set -e an unguarded failure would kill the
    # whole script instead of returning to the menu. Abort the guided flow with a
    # message on the first hard failure; the operator fixes it and re-runs.
    pool_install     || { error "Install failed — fix the cause and re-run G) Guided setup."; return 0; }
    echo ""; echo "Press Enter to continue to Configure..."; read -r
    pool_configure   || { error "Configure failed — aborting guided setup."; return 0; }
    echo ""; echo "Press Enter to continue to Deploy web files..."; read -r
    pool_deploy_web  || { error "Web deploy failed — aborting guided setup."; return 0; }
    echo ""; echo "Press Enter to continue to Setup nginx..."; read -r
    pool_setup_nginx || { error "Nginx setup failed — aborting guided setup."; return 0; }
    echo ""; echo "Press Enter to set up the pool wallet (coinbase + payout listeners)..."; read -r
    # Wallet setup is best-effort in guided mode: a missing/unsynced node shouldn't
    # block the rest of setup. The operator can finish it later via 5) Set up wallet.
    pw_setup || warn "Wallet not fully set up — finish via 5) Set up wallet (needed for coinbase + payouts)."
    echo ""; echo "Press Enter to start the service and create admin account..."; read -r
    pool_start_service || true
    sleep 2
    pool_setup_admin || warn "Admin account not created — run 7) Create admin account once the service is up."

    echo ""
    success "Guided setup complete. Open https://$(pool_read_conf "subdomain" "your-domain") to access the pool."
    return 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# STATUS LINE helper
# ═══════════════════════════════════════════════════════════════════════════════

_pool_menu_status_line() {
    if systemctl is-active --quiet "$POOL_SERVICE" 2>/dev/null; then
        echo -e "${GREEN}● running${RESET}"
    elif [[ -f "$POOL_CONF" ]]; then
        echo -e "${YELLOW}installed, stopped${RESET}"
    else
        echo -e "${DIM}not installed${RESET}"
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# MAIN MENU
# ═══════════════════════════════════════════════════════════════════════════════

show_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  GRINIUM — Grin Public Mining Pool (Mainnet)${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Service: $(_pool_menu_status_line)"
    echo ""
    echo -e "${DIM}  ─── First-Time Setup ────────────────────────────${RESET}"
    echo -e "  ${GREEN}G${RESET}) Guided Full Setup    ${DIM}(runs all setup steps 1→7)${RESET}"
    echo ""
    echo -e "${DIM}  ─── Manual Setup Steps ───────────────────────────${RESET}"
    echo -e "  ${GREEN}1${RESET}) Install               ${DIM}(nodejs ≥18, npm, sqlite3, systemd, fail2ban)${RESET}"
    echo -e "  ${GREEN}2${RESET}) Configure             ${DIM}(pool name, domain, fee, wallet dir)${RESET}"
    echo -e "  ${GREEN}3${RESET}) Deploy web files      ${DIM}(frontend → $POOL_WEB_DIR)${RESET}"
    echo -e "  ${GREEN}4${RESET}) Setup nginx           ${DIM}(vhost + SSL + rate limits)${RESET}"
    echo -e "  ${GREEN}5${RESET}) Set up wallet         ${DIM}(coinbase Foreign 3415 + payout Owner 3420)${RESET}"
    echo -e "  ${GREEN}6${RESET}) Service control       ${DIM}(start / stop — start before creating admin)${RESET}"
    echo -e "  ${GREEN}7${RESET}) Create admin account  ${DIM}(first admin user — needs service running)${RESET}"
    echo ""
    echo -e "${DIM}  ─── Administration ───────────────────────────────${RESET}"
    echo -e "  ${GREEN}8${RESET}) Pool status           ${DIM}(service, port, DB, recent logs)${RESET}"
    echo -e "  ${GREEN}B${RESET}) Backup pool           ${DIM}(DB + config → /opt/grin/backups/)${RESET}"
    echo -e "  ${GREEN}C${RESET}) Cron tasks            ${DIM}(backup schedule, VACUUM)${RESET}"
    echo -e "  ${GREEN}L${RESET}) View logs             ${DIM}(tail -50 | less)${RESET}"
    echo -e "  ${GREEN}S${RESET}) Edit config           ${DIM}(${POOL_CONF})${RESET}"
    echo ""
    echo -e "${DIM}  ─── Danger Zone ──────────────────────────────────${RESET}"
    echo -e "  ${RED}DEL${RESET}) Reset database    ${DIM}(⚠ permanently wipes all data)${RESET}"
    echo ""
    echo -e "  ${RED}0${RESET}) Back to deployment mode menu"
    echo ""
    echo -ne "${BOLD}Select: ${RESET}"
}

pool_singlebox_loop() {
    while true; do
        show_menu
        read -r choice

        # Every dispatch is ||-guarded: a step that returns non-zero must bring
        # the operator back to this menu, not kill the script via set -e.
        case "${choice,,}" in
            "")    continue ;;
            g)     pool_guided_setup || true ;;
            1)     pool_install || true ;;
            2)     pool_configure || true ;;
            3)     pool_deploy_web || true ;;
            4)     pool_setup_nginx || true ;;
            5)     pool_wallet_menu || true ;;
            6)     pool_service_menu || true ;;
            7)     pool_setup_admin || true ;;
            8)     pool_show_status || true ;;
            b)     pool_backup || true ;;
            c)     pool_cron_schedules || true ;;
            l)     pool_view_logs || true ;;
            s)     ${EDITOR:-nano} "$POOL_CONF" || true ;;
            del)   pool_reset_db || true ;;
            0|q|exit) break ;;
            *)     warn "Invalid option." ; sleep 1 ; continue ;;
        esac

        [[ "${choice,,}" != "l" && "${choice,,}" != "s" ]] && {
            echo ""
            echo "Press Enter to continue..."
            read -r
        }
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# Z) CLEANUP — remove the public-pool footprint (any mode) for fast rebuild tests
# ═══════════════════════════════════════════════════════════════════════════════
# Mirrors solo_cleanup (07_grin_mining_solo.sh): preview with present/absent
# marks, a master confirm, then per-group confirms — nothing runs until the
# master Y. Removes whatever GRINIUM roles are on this box — brain (single-server
# / Central Hub) and/or Satellite — WITHOUT touching anything the node or wallet
# needs, so an operator can rebuild binary/source/services from scratch quickly.
#
# REMOVED (per-group confirm):  systemd services + units, pool app dir (incl.
#   pool.db + .wallet_pass), satellite app dir (incl. staging/failover DBs),
#   web root + nginx vhost + rate-limit zones conf, cron jobs + logrotate +
#   backup wrapper, JSON configs, service logs.
# PRESERVED (never touched):    the Grin node + chain data + grin-server.toml
#   (stratum config left as-is — the next install reuses it), the wallet dir +
#   SEED, and the backups in /opt/grin/backups/. To wipe those, use Script 08del.

# Present/absent marker for the cleanup preview list.
_pool_cleanup_mark() {
    if [[ -e "$1" ]]; then echo -e "${YELLOW}present${RESET}"; else echo -e "${DIM}absent${RESET}"; fi
}

pool_cleanup() {
    clear
    # Satellite paths (SAT_*) live in the satellite lib — sourcing here is safe
    # and idempotent (constants + sat_* function definitions only).
    # shellcheck source=lib/07_lib_satellite.sh
    source "$SCRIPT_DIR/lib/07_lib_satellite.sh"

    local pool_unit="/etc/systemd/system/${POOL_SERVICE}.service"
    local sat_unit="/etc/systemd/system/${SAT_SERVICE}.service"
    local cron_backup="/etc/cron.d/${POOL_SERVICE}-backup"
    local cron_vacuum="/etc/cron.d/${POOL_SERVICE}-vacuum"
    local backup_wrapper="/usr/local/bin/grin-pool-backup-mainnet"
    local logrotate_conf="/etc/logrotate.d/${POOL_SERVICE}"
    local zones_conf="/etc/nginx/conf.d/script07-${POOL_SERVICE}.conf"
    local backup_dir="/opt/grin/backups/${POOL_SERVICE}"
    local f2b_filter="/etc/fail2ban/filter.d/grin-pool-login.conf"
    local f2b_jail="/etc/fail2ban/jail.d/grin-pool.conf"

    echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${RED}  Clean Up Public Mining Pool${RESET}  ${DIM}(rebuild from scratch quickly)${RESET}"
    echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Removes the GRINIUM footprint on this box — brain (single-server /"
    echo -e "  Central Hub) and/or Satellite. The node, your wallet seed, and your"
    echo -e "  backups are ${BOLD}kept${RESET} — confirm each group below."
    echo ""
    echo -e "  ${BOLD}Will be removed${RESET} ${DIM}(if you confirm the group):${RESET}"
    echo -e "    Pool service unit           $(_pool_cleanup_mark "$pool_unit")"
    echo -e "    Satellite service unit      $(_pool_cleanup_mark "$sat_unit")"
    echo -e "    Pool app + DB               $(_pool_cleanup_mark "$POOL_APP_DIR")"
    echo -e "    Satellite app + staging DB  $(_pool_cleanup_mark "$SAT_APP_DIR")"
    echo -e "    Web root + nginx vhost      $(_pool_cleanup_mark "$POOL_NGINX_CONF")"
    echo -e "    Cron / logrotate / wrapper  $(_pool_cleanup_mark "$cron_backup")"
    echo -e "    Pool config (JSON)          $(_pool_cleanup_mark "$POOL_CONF")"
    echo -e "    Satellite config (JSON)     $(_pool_cleanup_mark "$SAT_CONF")"
    echo -e "    Service logs                $(_pool_cleanup_mark "$POOL_LOG")"
    echo -e "    Fail2ban jail + filter      $(_pool_cleanup_mark "$f2b_jail")"
    echo ""
    echo -e "  ${BOLD}${GREEN}Kept — never touched:${RESET}"
    echo -e "    ${DIM}Grin node + chain data · grin-server.toml (stratum config as-is)${RESET}"
    echo -e "    ${DIM}Wallet dir + seed · pool backups ($backup_dir)${RESET}"
    echo -e "    ${DIM}(use Script 08del for a full wipe including those)${RESET}"
    echo ""
    echo -ne "${BOLD}Proceed with public-pool cleanup? [Y/n]: ${RESET}"
    local go; read -r go || true
    [[ "${go,,}" != "n" ]] || { info "Cancelled — nothing changed."; return; }
    echo ""

    local a svc
    # 1) systemd services + unit files
    echo -ne "${BOLD}1)${RESET} Stop + remove services ($POOL_SERVICE, $SAT_SERVICE)? [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        for svc in "$POOL_SERVICE" "$SAT_SERVICE"; do
            systemctl stop "$svc" 2>/dev/null || true
            systemctl disable "$svc" 2>/dev/null || true
        done
        rm -f "$pool_unit" "$sat_unit"
        systemctl daemon-reload 2>/dev/null || true
        success "Services stopped, disabled, units removed."
        log "Cleanup: removed $POOL_SERVICE + $SAT_SERVICE services"
    fi
    echo ""

    # 2) Pool app dir — includes pool.db (miner balances!) and .wallet_pass.
    # legacy_app: pre-rename installs used /opt/grin/pool — sweep it too.
    local legacy_app="/opt/grin/pool"
    if [[ -d "$POOL_APP_DIR" || -d "$legacy_app" ]]; then
        echo -e "   ${YELLOW}⚠ $POOL_APP_DIR includes pool.db (miner balances) + .wallet_pass.${RESET}"
        echo -e "   ${DIM}Backups in $backup_dir are kept — run B) Backup first if unsure.${RESET}"
        echo -ne "${BOLD}2)${RESET} Remove pool app + database ($POOL_APP_DIR)? [Y/n]: "
        read -r a || true
        if [[ "${a,,}" != "n" ]]; then
            rm -rf "${POOL_APP_DIR:?}"
            [[ -d "$legacy_app" ]] && { rm -rf "${legacy_app:?}"; info "Legacy app dir removed ($legacy_app)."; }
            success "Pool app + database removed."
            log "Cleanup: removed $POOL_APP_DIR (+ legacy $legacy_app if present)"
        fi
        echo ""
    fi

    # 3) Satellite app dir — includes staging + relay failover SQLite
    if [[ -d "$SAT_APP_DIR" ]]; then
        echo -ne "${BOLD}3)${RESET} Remove satellite app + staging DB ($SAT_APP_DIR)? [Y/n]: "
        read -r a || true
        if [[ "${a,,}" != "n" ]]; then
            rm -rf "${SAT_APP_DIR:?}"
            success "Satellite app + staging DB removed."
            log "Cleanup: removed $SAT_APP_DIR"
        fi
        echo ""
    fi

    # 4) Web root + nginx vhost + rate-limit zones conf
    echo -ne "${BOLD}4)${RESET} Remove web files + nginx vhost ($(basename "$POOL_NGINX_CONF"))? [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        local conf_name; conf_name=$(basename "$POOL_NGINX_CONF")
        if command -v nginx &>/dev/null && [[ -e "/etc/nginx/sites-enabled/$conf_name" || -f "$POOL_NGINX_CONF" ]]; then
            nginx_disable_site "$conf_name" || true
            rm -f "$POOL_NGINX_CONF" "$zones_conf"
            nginx_test_reload "after removing $conf_name vhost" || true
        else
            # nginx absent (or only a dangling symlink left) — remove files directly
            rm -f "/etc/nginx/sites-enabled/$conf_name" "$POOL_NGINX_CONF" "$zones_conf"
        fi
        rm -rf "${POOL_WEB_DIR:?}"
        success "Web files + vhost + rate-limit zones removed."
        info "Any TLS cert under /etc/letsencrypt is left in place (harmless) — 'certbot delete' to drop it."
        log "Cleanup: removed $POOL_WEB_DIR, $POOL_NGINX_CONF, $zones_conf"
    fi
    echo ""

    # 5) Cron jobs + logrotate + backup wrapper + wallet listeners/watchdog/autostart.
    #    The wallet SEED dir is kept (it holds coinbase funds) — we only stop the
    #    runtime listeners and remove their watchdog + @reboot autostart.
    echo -ne "${BOLD}5)${RESET} Remove cron + logrotate + wrapper + stop wallet listeners? [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        rm -f "$cron_backup" "$cron_vacuum" "$backup_wrapper" "$logrotate_conf"
        pw_listener_stop   2>/dev/null || true
        pw_watchdog_remove 2>/dev/null || true
        pw_autostart_disable 2>/dev/null || true
        success "Cron + logrotate + wrapper removed; wallet listeners stopped, watchdog + autostart removed."
        info "Wallet seed dir ($(pw_wallet_dir)) kept — it holds the coinbase funds."
        log "Cleanup: removed $cron_backup, $cron_vacuum, $backup_wrapper, $logrotate_conf + wallet listeners/watchdog/autostart"
    fi
    echo ""

    # 6) JSON configs (pool + satellite + pre-rename legacy grin_pool.json)
    echo -ne "${BOLD}6)${RESET} Remove configs ($POOL_CONF, $SAT_CONF)? [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        rm -f "$POOL_CONF" "$SAT_CONF" "/opt/grin/conf/grin_pool.json"
        success "Configs removed."
        log "Cleanup: removed $POOL_CONF + $SAT_CONF (+ legacy grin_pool.json)"
    fi
    echo ""

    # 7) Service logs (pool, satellite, nginx access/error)
    echo -ne "${BOLD}7)${RESET} Remove service logs? [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        rm -f "$POOL_LOG" "$POOL_LOG".* "$SAT_LOG" "$SAT_LOG".* 2>/dev/null || true
        rm -f "/var/log/nginx/${POOL_SERVICE}-access.log"* "/var/log/nginx/${POOL_SERVICE}-error.log"* 2>/dev/null || true
        success "Service logs removed."
        log "Cleanup: removed pool/satellite/nginx logs"
    fi
    echo ""

    # 8) Fail2ban login-guard jail + filter (written by 1) Install). Must go when the
    #    pool does: step 7 deletes the watched access log, and a jail with a missing
    #    logpath stops fail2ban from starting — taking every other jail down with it.
    #    fail2ban itself stays installed (other services may have their own jails).
    if [[ -f "$f2b_jail" || -f "$f2b_filter" ]]; then
        echo -ne "${BOLD}8)${RESET} Remove fail2ban login-guard jail + filter? [Y/n]: "
        read -r a || true
        if [[ "${a,,}" != "n" ]]; then
            rm -f "$f2b_jail" "$f2b_filter"
            if systemctl is-active --quiet fail2ban 2>/dev/null; then
                systemctl restart fail2ban 2>/dev/null \
                    && success "fail2ban restarted without the pool jail." \
                    || warn "fail2ban restart failed — inspect: journalctl -u fail2ban -n 30"
            fi
            success "Fail2ban jail + filter removed."
            log "Cleanup: removed $f2b_jail + $f2b_filter"
        fi
        echo ""
    fi

    success "Public-pool cleanup complete."
    echo -e "  ${BOLD}${GREEN}Kept:${RESET} node + chain data · grin-server.toml (stratum config as-is)"
    echo -e "        wallet dir + seed · pool backups ($backup_dir)"
    echo -e "  ${DIM}Ready for a fresh install — pick a mode and run Install again.${RESET}"
}

# ═══════════════════════════════════════════════════════════════════════════════
# DEPLOYMENT MODE SELECTOR (multi-region split)
# ═══════════════════════════════════════════════════════════════════════════════
# Three deployment directions — see docs/generated/script07_design.md §3:
#   singlebox — Hub + co-located Satellite on one server (original behaviour)
#   hub       — Central Hub only (brain: API/DB/web/admin/wallet); satellites relay in
#   satellite — Regional node + stratum proxy + share relay → points at a Hub
# Mode may be passed as $1 (singlebox|hub|satellite) for non-interactive launches
# (e.g. from the mining hub); otherwise it is chosen interactively.
POOL_MODE=""

# ─── Install-footprint detectors (collision guard) ──────────────────────────────
# Single-server pool and Central Hub share the same "brain" footprint
# ($POOL_CONF + $POOL_SERVICE); a Satellite has its own (grin_satellite.json +
# grin-satellite). Co-locating a brain and a satellite on one box collides on
# stratum 3333 / node upstream 3334 (and Central API 8080), so we refuse at
# selection time and point the operator at cleanup.
pool_brain_installed() {
    [[ -f "$POOL_CONF" ]] && return 0
    systemctl list-unit-files 2>/dev/null | grep -q "^${POOL_SERVICE}\.service" && return 0
    return 1
}
pool_satellite_installed() {
    [[ -f "/opt/grin/conf/grin_satellite.json" ]] && return 0
    systemctl list-unit-files 2>/dev/null | grep -q "^grin-satellite\.service" && return 0
    return 1
}

# Returns 0 if the chosen mode is safe to install on this box; 1 (with guidance)
# if it would collide with an existing install of the other kind.
pool_mode_conflict_check() {
    case "$1" in
        singlebox|hub)
            pool_satellite_installed || return 0
            echo ""
            warn "A Satellite install was detected on this server:"
            echo -e "    config:  /opt/grin/conf/grin_satellite.json"
            echo -e "    service: grin-satellite"
            echo -e "  ${DIM}Single-server / Central Hub bind the same stratum (3333) and node${RESET}"
            echo -e "  ${DIM}upstream (3334) ports the Satellite uses — both on one box collides.${RESET}"
            echo -e "  ${BOLD}Clean up the Satellite first${RESET} (mode menu → Z) Cleanup), then re-run."
            return 1
            ;;
        satellite)
            pool_brain_installed || return 0
            echo ""
            warn "An existing pool / Central Hub install was detected on this server:"
            echo -e "    config:  $POOL_CONF"
            echo -e "    service: $POOL_SERVICE"
            echo -e "  ${DIM}A Satellite binds stratum 3333 + node upstream 3334, which this install${RESET}"
            echo -e "  ${DIM}already uses (plus Central API 8080) — both on one box collides.${RESET}"
            echo -e "  ${BOLD}Clean up the public pool config first${RESET} (mode menu → Z) Cleanup), then re-run."
            return 1
            ;;
    esac
    return 0
}

pool_select_mode() {
    local arg="${1:-}"
    case "$arg" in
        singlebox|hub|satellite)
            POOL_MODE="$arg"
            pool_mode_conflict_check "$arg" || POOL_MODE=""
            return
            ;;
    esac

    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Public Mining Pool Deployment Mode${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  ${DIM}Tip: don't install a brain (1/2) and a Satellite (3) on the same box —${RESET}"
        echo -e "  ${DIM}they collide on ports 3333/3334/8080. Use Single-server for one machine.${RESET}"
        echo ""
        echo -e "  ${BOLD}Single-server${RESET} ${DIM}(everything on one box)${RESET}"
        echo -e "  ${DIM}─────────────────────────────────────────────${RESET}"
        echo -e "  ${GREEN}1${RESET}) Single-server pool   ${DIM}(Hub + local Satellite, all-in-one)${RESET}"
        echo ""
        echo -e "  ${BOLD}Distributed / multi-region${RESET} ${DIM}(each role on a SEPARATE server)${RESET}"
        echo -e "  ${CYAN}═════════════════════════════════════════════${RESET}"
        echo -e "  ${GREEN}2${RESET}) Central Hub          ${DIM}(the brain — one per pool)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Satellite            ${DIM}(a region — node + proxy → points at your Hub)${RESET}"
        echo ""
        echo -e "  ${BOLD}${RED}Danger zone${RESET}"
        echo -e "  ${RED}═════════════════════════════════════════════${RESET}"
        echo -e "  ${RED}Z${RESET}) Cleanup public pool  ${DIM}(remove pool/hub/satellite infra · keeps node + wallet + backups)${RESET}"
        echo ""
        echo -e "  ${RED}0${RESET}) Back to mining hub"
        echo ""
        echo -ne "${BOLD}Select mode: ${RESET}"
        read -r m

        local chosen=""
        case "$m" in
            1) chosen="singlebox" ;;
            2) chosen="hub" ;;
            3) chosen="satellite" ;;
            z|Z) pool_cleanup || true
                 echo ""
                 echo "Press Enter to return to the menu..."
                 read -r
                 continue ;;
            0|q|exit) POOL_MODE=""; return ;;
            *) warn "Invalid option."; sleep 1; continue ;;
        esac

        if pool_mode_conflict_check "$chosen"; then
            POOL_MODE="$chosen"
            return
        fi
        echo ""
        echo "Press Enter to return to the menu..."
        read -r
    done
}

main() {
    local arg="${1:-}"
    # Loop so leaving a mode menu (0) returns here, to the deployment-mode
    # selector — only the selector's own 0 exits the script back to the mining
    # hub. A direct mode arg (non-interactive entry) runs that mode once and exits.
    while true; do
        POOL_MODE=""
        pool_select_mode "$arg"
        case "$POOL_MODE" in
            singlebox)
                pool_singlebox_loop
                ;;
            hub)
                # shellcheck source=lib/07_lib_hub.sh
                source "$SCRIPT_DIR/lib/07_lib_hub.sh"
                pool_hub_loop
                ;;
            satellite)
                # shellcheck source=lib/07_lib_satellite.sh
                source "$SCRIPT_DIR/lib/07_lib_satellite.sh"
                pool_satellite_loop
                ;;
            *)
                info "No mode selected — returning to mining hub."
                return 0
                ;;
        esac
        [[ -n "$arg" ]] && return 0
    done
}

main "$@"
