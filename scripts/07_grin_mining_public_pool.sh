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
#   5) Set up wallet         (combined coinbase + payout listener, Owner+Foreign 3420)
#   6) Service control       (start / stop / restart)
#   7) Create admin account  (first admin user — needs service running)
#   8) Pool status           (service state, DB size, recent logs)
#   9) Deploy new code       (refresh backend+frontend from checkout, then restart)
#   B) Backup                (DB + config → /opt/grin/backups/)
#   C) Cron schedules        (daily backup, weekly VACUUM)
#   L) View logs             (tail -50 | less)
#   S) Edit config           (manual JSON config edit)
#   DEL) Reset database      (⚠ permanently wipes all data)
#   0) Exit
# Mode-selector menu (before the above): Z) Cleanup public mining pool —
#   removes pool/hub/gateway infra (+ any legacy satellite) for fast rebuild tests;
#   keeps node, wallet seed and backups (mirrors solo cleanup in 07_grin_mining_solo.sh).
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
# ─── Network mode (mainnet | testnet) ───────────────────────────────────────────
# Testnet finds blocks fast, so it's the way to exercise the whole block → maturity
# (100 blocks) → reward → payout pipeline. It is a FULLY INDEPENDENT install — its own
# config file, service, dirs, web root, nginx vhost, and ports — so it runs standalone OR
# alongside a mainnet pool on the same box (matching the toolkit's "testnet and mainnet run
# independently on separate ports/dirs" rule). Trigger with the `testnet` launch arg
# (any position), mirroring solo's `lan` arg: `bash 07_grin_mining_public_pool.sh testnet`.
POOL_NET="mainnet"
for _a in "$@"; do [[ "$_a" == "testnet" ]] && POOL_NET="testnet"; done

# "pubpool" family — product-prefixed like solo's /opt/grin/solowallet, so an
# operator can tell at a glance which product owns a dir (renamed 2026-06 from
# the generic grin_pool.json + /opt/grin/pool + /opt/grin/wallet; legacy paths
# are still recognised by Z) Cleanup). Testnet gets the `_testnet`/`-testnet` suffixed
# siblings + Central API port 8090 (vs mainnet 8080) so the two never collide.
if [[ "$POOL_NET" == "testnet" ]]; then
    POOL_CONF="/opt/grin/conf/grin_pubpool_testnet.json"
    POOL_APP_DIR="/opt/grin/pubpool/testnet"
    POOL_WALLET_DIR="/opt/grin/pubpoolwallet/testnet"
    POOL_WEB_DIR="/var/www/grin-pool-testnet"
    POOL_PORT=8090
    POOL_SERVICE="grin-pool-manager-testnet"
    POOL_NGINX_CONF="/etc/nginx/sites-available/grin-public-pool-testnet"
    # Legacy vhost basename (pre-2026-06 rename) — cleaned up on Setup nginx / Cleanup.
    POOL_NGINX_CONF_LEGACY="/etc/nginx/sites-available/grin-pool-testnet"
    POOL_LOG="/opt/grin/logs/grin-pool-testnet.log"
else
    POOL_CONF="/opt/grin/conf/grin_pubpool.json"
    POOL_APP_DIR="/opt/grin/pubpool/mainnet"
    POOL_WALLET_DIR="/opt/grin/pubpoolwallet/mainnet"
    POOL_WEB_DIR="/var/www/grin-pool"
    POOL_PORT=8080
    POOL_SERVICE="grin-pool-manager"
    POOL_NGINX_CONF="/etc/nginx/sites-available/grin-public-pool-mainnet"
    # Legacy vhost basename (pre-2026-06 rename, was the unsuffixed "grin-pool") —
    # cleaned up on Setup nginx / Cleanup so a re-run migrates the old install.
    POOL_NGINX_CONF_LEGACY="/etc/nginx/sites-available/grin-pool"
    POOL_LOG="/opt/grin/logs/grin-pool.log"
fi

# Human-readable network label for menu titles / headers / generated-file comments.
# The dirs/ports/config/service above are ALL network-keyed already — this is purely
# the display string so a testnet run never mislabels itself "Mainnet".
if [[ "$POOL_NET" == "testnet" ]]; then POOL_NET_LABEL="Testnet"; else POOL_NET_LABEL="Mainnet"; fi

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
# Shared node-secret resolver + self-heal (keeps the pool wallet's
# node_api_secret_path in sync with the live node after a node rebuild).
# shellcheck source=lib/grin_node_secrets.sh
source "$SCRIPT_DIR/lib/grin_node_secrets.sh"

# ─── Source pool wallet lib (combined coinbase + payout, Owner+Foreign 3420) ───
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
    # Per-network node + stratum defaults. Testnet uses the 13xxx ports (node API 13413,
    # built-in stratum 13416) and a distinct public stratum port (13333) so a testnet pool
    # never clashes with a mainnet one on the same box. node_api_url is written explicitly
    # (the app reads node_api_url, NOT node_api_port) so the pool talks to the right node.
    # node_stratum is Grin's NATIVE default stratum_server_addr port (mainnet 3416 / testnet
    # 13416) — Script 01 enables the node's built-in stratum but leaves the addr at this default,
    # so the pool must dial the same port (the node is not patched).
    local d_network="$POOL_NET" d_node_api d_node_strat d_pub_strat d_node_url
    if [[ "$POOL_NET" == "testnet" ]]; then
        d_node_api="13413"; d_node_strat="13416"; d_pub_strat="13333"; d_node_url="http://127.0.0.1:13413"
    else
        d_node_api="3413";  d_node_strat="3416";  d_pub_strat="3333";  d_node_url="http://127.0.0.1:3413"
    fi
    local -A defaults=(
        ["pool_name"]="My Grin Pool"
        ["subdomain"]=""
        ["network"]="$d_network"
        ["stratum_port"]="$d_pub_strat"
        ["node_api_port"]="$d_node_api"
        ["node_api_url"]="$d_node_url"
        ["node_stratum_port"]="$d_node_strat"
        ["node_stratum_host"]="127.0.0.1"
        ["pool_address"]=""
        # The pool server's own region label. It serves local miners under this
        # region; on startup the app self-registers one pool_locations row for it
        # (→ subdomain:stratum_port) so the central box shows as a real region and
        # auto-joins the connect grid the moment a gateway for another zone forwards
        # shares in — no rebuild. Rename it in admin → Regions.
        ["region"]="main"
        # Human-facing location of this pool server's own region, shown on the public
        # connect card (label + country flag). Most operators sit behind Cloudflare so
        # geo-IP can't infer it — it's captured in 2) Configure and editable in admin →
        # Regions. Empty country/country_code → the card just shows the label, no flag.
        ["region_label"]=""
        ["region_country"]=""
        ["region_country_code"]=""
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
        # Admin panel access control: comma/space-separated IPs/CIDRs allowed to reach
        # /admin and /api/admin at the nginx layer. Empty = OPEN to all (testing default —
        # app-layer JWT + captcha + lockout + auto-ban + TOTP still apply). Set IPs/CIDRs
        # here to harden once you have adoption, then re-run 4) Setup nginx.
        ["admin_allowlist"]=""
    )
    for k in "${!defaults[@]}"; do
        local existing; existing=$(pool_read_conf "$k" "__MISSING__")
        [[ "$existing" == "__MISSING__" ]] && pool_write_conf_key "$k" "${defaults[$k]}"
    done
}

# Scalar SELECT against the pool DB via node:sqlite — the pool's own engine, so
# it is always present (Node 24+ is an install prerequisite). Do NOT use the
# sqlite3 CLI for probes: it is optional (RHEL names the package `sqlite`, and
# a failed install is masked by the `| tail` pipe), and a missing CLI must not
# make status checks lie. Prints the first column of the first row; empty on error.
_pool_db_scalar() { # <sql> [db_path]
    local db="${2:-$POOL_APP_DIR/pool.db}"
    [[ -f "$db" ]] || return 1
    node -e "
try {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(process.argv[1]);
  const row = d.prepare(process.argv[2]).get();
  process.stdout.write(String(row ? Object.values(row)[0] : ''));
} catch (e) { process.exit(1); }
" "$db" "$1" 2>/dev/null
}

# ─── Per-step completion probes ────────────────────────────────────────────────
# Used by the menus (✓ markers next to setup steps 1–7) and by the guided flow,
# which offers to skip already-completed steps — so re-running G) after a
# mid-flow abort resumes instead of redoing everything. Probes check the
# artifacts each step leaves behind, not a recorded state, so they stay correct
# even after manual runs or a partial cleanup.
_pool_step_done() {
    case "$1" in
        1) [[ -f "/etc/systemd/system/$POOL_SERVICE.service" \
              && -f "$POOL_APP_DIR/index.js" && -d "$POOL_APP_DIR/node_modules" ]] ;;
        2) [[ -n "$(pool_read_conf "subdomain" "")" ]] ;;
        3) [[ -f "$POOL_WEB_DIR/index.html" && -f "$POOL_WEB_DIR/js/pool-config.js" ]] ;;
        4) # listen 443 distinguishes the finished SSL vhost from the HTTP-only
           # certbot bootstrap (operator declined/failed certbot mid-step).
           [[ -f "$POOL_NGINX_CONF" ]] && grep -q "listen 443" "$POOL_NGINX_CONF" 2>/dev/null ;;
        5) [[ -x "$(pw_bin)" && -f "$(pw_toml)" && -f "$(pw_pass_file)" ]] ;;
        6) systemctl is-active --quiet "$POOL_SERVICE" 2>/dev/null ;;
        7) [[ "$(_pool_db_scalar "SELECT COUNT(*) FROM users WHERE is_admin=1" || echo 0)" == [1-9]* ]] ;;
        *) return 1 ;;
    esac
}

_pool_step_mark() {
    if _pool_step_done "$1"; then echo -e "${GREEN}✓${RESET}"; else echo -e "${DIM}·${RESET}"; fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# 7) STATUS
# ═══════════════════════════════════════════════════════════════════════════════

pool_show_status() {
    echo -e "\n${BOLD}Pool Manager — ${POOL_NET_LABEL}${RESET}"
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
# NodeSource when the box has no node or one that is too old. Used by the pool
# (singlebox/hub) install — regional gateways run no Node and don't call this.
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
    echo -e "\n${BOLD}Installing Pool Manager (${POOL_NET_LABEL})...${RESET}\n"

    # rc 1 on a guard block (not 0): the guided flow must treat a refused install
    # as a failure and abort, not continue to Configure on a blocked box.
    pool_check_exclusivity || return 1
    # Defense-in-depth: refuse if a gateway (or legacy satellite) already occupies this
    # box (in case the selector guard was bypassed via a direct/non-interactive entry).
    pool_mode_conflict_check "${POOL_MODE:-singlebox}" || return 1

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
        # RHEL-family names the CLI package `sqlite` (it ships /usr/bin/sqlite3);
        # `dnf install sqlite3` fails — and the pipe to tail masks the failure.
        dnf install -y logrotate sqlite 2>&1 | tail -5
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
Description=Grin Pool Manager (GRINIUM — ${POOL_NET_LABEL})
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
    echo -e "\n${BOLD}Configure Pool Manager — ${POOL_NET_LABEL}${RESET}"
    echo -e "${DIM}Only the pool domain is set here — everything else defaults and is${RESET}"
    echo -e "${DIM}edited in the web admin panel after login.${RESET}\n"

    # The config read/write helpers run on node (installed by step 1). Without
    # it every write fails silently, so make the missing prerequisite explicit.
    if ! command -v node &>/dev/null; then
        error "Node.js not found — run 1) Install first."
        return 1
    fi
    pool_ensure_defaults

    # The domain is the ONLY install-time setting asked here. Everything else
    # (pool name, fee %, min withdrawal, reward model, payout options, …) is
    # seeded with sane defaults during 1) Install and is edited in the web admin
    # panel after first login — so the installer stays minimal. The domain is the
    # exception: it's REQUIRED for nginx + certbot (the public site + admin HTTPS) and
    # is NOT editable in the admin panel, so it must be captured up front.
    # node_stratum_port stays at its default (3416 / testnet 13416 — Grin's native
    # stratum_server_addr port); advanced operators running the node's built-in stratum
    # on another port edit grin_pubpool.json directly.
    local val

    # Enter keeps an existing value; with none set we loop until a valid domain
    # is given (0 to cancel out of Configure).
    echo -e "  ${DIM}(Full domain or subdomain for the pool site, e.g. pool.example.com or example.com)${RESET}"
    local cur_domain; cur_domain=$(pool_read_conf "subdomain" "")
    while true; do
        echo -ne "Domain/subdomain [${cur_domain}]: "
        read -r val
        if [[ -z "$val" ]]; then
            # Enter with an existing value keeps it; with none, the field is
            # mandatory — re-prompt instead of writing an empty domain.
            [[ -n "$cur_domain" ]] && break
            warn "A domain is required for a public pool (HTTPS for the site + admin). Enter 0 to cancel Configure."
            continue
        fi
        [[ "$val" == "0" ]] && { info "Configure cancelled."; return 1; }
        if nginx_validate_domain "$val"; then
            pool_write_conf_key "subdomain" "$val"; cur_domain="$val"; break
        fi
        warn "Invalid domain name '$val' — try again (e.g. pool.example.com), or 0 to cancel."
    done

    # ── This server's region location (public connect card) ──────────────────
    # Optional but recommended: most pools sit behind Cloudflare, so the public site
    # can't geo-locate the box — the operator tells us where it is. Shown as the
    # region's label + country flag on the homepage connect card. All editable later
    # in admin → Regions. Enter keeps the current value; blank country = no flag.
    echo
    echo -e "  ${DIM}(Where is THIS pool server? Shown on the public connect card. Optional — Enter to skip.)${RESET}"
    local cur_rlabel; cur_rlabel=$(pool_read_conf "region_label" "")
    echo -ne "Region display name (e.g. Saigon, New York) [${cur_rlabel}]: "
    read -r val
    [[ -n "$val" ]] && pool_write_conf_key "region_label" "$val"
    local cur_rcountry; cur_rcountry=$(pool_read_conf "region_country" "")
    echo -ne "Country name (e.g. Vietnam, United States) [${cur_rcountry}]: "
    read -r val
    [[ -n "$val" ]] && pool_write_conf_key "region_country" "$val"
    local cur_rcc; cur_rcc=$(pool_read_conf "region_country_code" "")
    echo -e "  ${DIM}(2-letter ISO country code for the flag, e.g. VN, DE, US. Blank = no flag.)${RESET}"
    echo -ne "Country code [${cur_rcc}]: "
    read -r val
    if [[ -n "$val" ]]; then
        # Normalise to uppercase A–Z; reject anything that isn't a 2-letter code.
        val=$(printf '%s' "$val" | tr '[:lower:]' '[:upper:]')
        if [[ "$val" =~ ^[A-Z]{2}$ ]]; then
            pool_write_conf_key "region_country_code" "$val"
        else
            warn "Ignoring '$val' — country code must be exactly two letters (e.g. VN)."
        fi
    fi

    info "All other settings (name, fee, min withdrawal, payouts) default now and"
    info "  are editable in the web admin panel after you create the admin account."

    # Wallet dir, pool Grin address + wallet password are NOT asked here — the
    # wallet doesn't exist yet at this point. All three are captured by
    # 5) Set up wallet (pw_setup), which asks for the dir, creates the wallet,
    # saves the passphrase and records the address.
    info "Wallet dir, pool Grin address + wallet password are set during 5) Set up wallet."

    # Keep the already-deployed frontend in sync with a changed pool name
    # (no-op before 3) Deploy has run).
    pool_write_web_config_js

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

    info "Deploying web files (${POOL_NET_LABEL}) to $POOL_WEB_DIR..."
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

    pool_write_web_config_js

    # Ownership + perms: the docroot is rsync'd as root, leaving files root:root.
    # nginx (www-data) must be able to traverse + read every file it serves, so
    # normalise the WHOLE tree (incl. /admin and the just-written pool-config.js)
    # to www-data:www-data with dirs 755 / files 644. Idempotent; cheap.
    pool_fix_web_perms

    success "Web files deployed to $POOL_WEB_DIR"
}

# Normalise the deployed docroot to the nginx web user with sane perms. Called by
# every web-deploy path (3) Deploy web files, 9) Deploy new code → pool_deploy_web,
# and the guided setup) so a redeploy never leaves root:root or over-tight modes
# that nginx (www-data) can't read.
pool_fix_web_perms() {
    [[ -d "$POOL_WEB_DIR" ]] || return 0
    chown -R www-data:www-data "$POOL_WEB_DIR" 2>/dev/null || true
    find "$POOL_WEB_DIR" -type d -exec chmod 755 {} + 2>/dev/null || true
    find "$POOL_WEB_DIR" -type f -exec chmod 644 {} + 2>/dev/null || true
}

# (Re)generate the static frontend config. Called by 3) Deploy and by
# 2) Configure (after a pool-name change) so the deployed site never serves a
# stale pool name. No-op until the web files have been deployed.
pool_write_web_config_js() {
    [[ -d "$POOL_WEB_DIR/js" ]] || return 0
    local pool_name escaped_name
    pool_name=$(pool_read_conf "pool_name" "My Grin Pool")
    escaped_name=$(node -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$pool_name" 2>/dev/null \
        || printf '"%s"' "${pool_name//\"/\\\"}")
    cat > "$POOL_WEB_DIR/js/pool-config.js" << EOF
// Auto-generated by GRINIUM pool_deploy.sh
window.POOL_NETWORK = "$(pool_read_conf network "$POOL_NET")";
window.POOL_NAME = ${escaped_name};
EOF
}

# ───────────────────────────────────────────────────────────────────────────────
# 9) DEPLOY NEW CODE — refresh runtime copies from the checkout, then restart
# ───────────────────────────────────────────────────────────────────────────────
# A lightweight update path for an ordinary code pull (js/html/media only): it
# refreshes BOTH trees the pool runs from —
#   · backend  $POOL_APP_SRC  → $POOL_APP_DIR   (index.js, lib/*.js, admin-panel/…)
#   · frontend $POOL_WEB_SRC  → $POOL_WEB_DIR   (via pool_deploy_web)
# — and restarts the service so the new code is actually live. This fills the gap
# between 3) Deploy web files (frontend ONLY — never touches the backend) and
# 1) Install (heavy: re-runs npm/apt/fail2ban AND does not restart the service).
#
# The backend rsync uses --delete to mirror the checkout (so a file deleted from
# source is removed on the server too) but EXCLUDES the four runtime artefacts the
# app owns, never the repo: the SQLite DB (pool.db + WAL/SHM sidecars), the wallet
# password file, node_modules (deps — refreshed only when package.json changes),
# and custom_assets (operator-uploaded white-label media). rsync protects excluded
# paths from --delete, so miner balances / secrets / deps survive untouched.
pool_deploy_code() {
    echo ""
    echo -e "  ${BOLD}Deploy new code — ${POOL_NET_LABEL}${RESET} — refresh backend + frontend from the checkout, then restart."
    echo -e "  ${DIM}Source: $TOOLKIT_ROOT${RESET}"
    echo -e "  ${YELLOW}Pull the latest first${RESET} (git pull) so the checkout holds the new code."
    echo ""

    if [[ ! -d "$POOL_APP_SRC" ]]; then
        error "Pool app source not found: $POOL_APP_SRC"
        return 1
    fi
    if [[ ! -d "$POOL_APP_DIR" ]]; then
        error "Pool not installed yet ($POOL_APP_DIR missing) — run 1) Install first."
        return 1
    fi

    # Did package.json change? Capture the OLD (deployed) hash before the rsync
    # overwrites it, compare against the source. Only then do we re-run npm —
    # an ordinary js/html refresh skips the (slow) dependency install entirely.
    local old_pkg_hash new_pkg_hash
    old_pkg_hash=$(sha1sum "$POOL_APP_DIR/package.json" 2>/dev/null | awk '{print $1}')
    new_pkg_hash=$(sha1sum "$POOL_APP_SRC/package.json" 2>/dev/null | awk '{print $1}')

    info "Refreshing backend code → $POOL_APP_DIR ..."
    rsync -a --delete \
        --exclude='pool.db' --exclude='pool.db-wal' --exclude='pool.db-shm' \
        --exclude='.wallet_pass' --exclude='node_modules' --exclude='custom_assets' \
        "$POOL_APP_SRC/" "$POOL_APP_DIR/" \
        || { error "Backend rsync failed — server code unchanged."; return 1; }
    success "Backend code refreshed."

    if [[ "$old_pkg_hash" != "$new_pkg_hash" ]]; then
        local npm_cmd="install"
        [[ -f "$POOL_APP_DIR/package-lock.json" ]] && npm_cmd="ci"
        warn "package.json changed — running npm $npm_cmd ..."
        (cd "$POOL_APP_DIR" && npm "$npm_cmd" --omit=dev 2>&1 | tail -20) \
            || { error "npm $npm_cmd failed — see /root/.npm/_logs/ (latest *-debug-0.log)."; return 1; }
        success "Dependencies updated."
    else
        info "package.json unchanged — skipping npm (deps untouched)."
    fi

    # Frontend (public_html → /var/www/grin-pool) + admin panel + pool-config.js.
    # No-op-safe if the web files were never deployed (it recreates the dir).
    pool_deploy_web || warn "Frontend deploy reported a problem — backend is still refreshed."

    # Make the new backend live. Only restart if it's already running; a stopped
    # service is left stopped (the operator starts it via 6) Service control).
    if systemctl is-active --quiet "$POOL_SERVICE" 2>/dev/null; then
        info "Restarting $POOL_SERVICE to load the new code..."
        if systemctl restart "$POOL_SERVICE"; then
            success "$POOL_SERVICE restarted — new code is live."
        else
            error "Restart failed — check: journalctl -u $POOL_SERVICE -n 50"
            return 1
        fi
    else
        info "$POOL_SERVICE is not running — start it via 6) Service control to load the new code."
    fi

    echo ""
    success "Deploy new code complete."
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

    # Migrate a pre-rename install: the vhost was renamed to grin-public-pool-<net>
    # (was the unsuffixed "grin-pool" on mainnet / "grin-pool-testnet" on testnet).
    # Drop the legacy conf + its sites-enabled symlink so this run regenerates under
    # the new name instead of leaving two vhosts bound to the same server_name.
    if [[ -n "${POOL_NGINX_CONF_LEGACY:-}" && "$POOL_NGINX_CONF_LEGACY" != "$POOL_NGINX_CONF" ]]; then
        if [[ -f "$POOL_NGINX_CONF_LEGACY" || -L "/etc/nginx/sites-enabled/$(basename "$POOL_NGINX_CONF_LEGACY")" ]]; then
            info "Migrating legacy vhost $(basename "$POOL_NGINX_CONF_LEGACY") → $(basename "$POOL_NGINX_CONF")"
            rm -f "/etc/nginx/sites-enabled/$(basename "$POOL_NGINX_CONF_LEGACY")" "$POOL_NGINX_CONF_LEGACY"
        fi
    fi

    # Disable the stock Debian/Ubuntu "default" site if it's still enabled. Its
    # `listen 80 default_server` + `server_name _` catch-all serves the generic
    # "Welcome to nginx!" page for ANY request whose Host doesn't match the pool
    # (e.g. the raw server IP, or http before DNS resolves) — which looks like the
    # pool homepage is broken. We drop only the sites-enabled SYMLINK (the
    # sites-available/default file is kept, so it's fully reversible) and only when
    # it's the catch-all default_server, never a real operator vhost. The vhost
    # write + reload later in this function picks up the change.
    local _default_site="/etc/nginx/sites-enabled/default"
    if [[ -L "$_default_site" || -f "$_default_site" ]] && grep -qs 'default_server' "$_default_site"; then
        info "Disabling stock nginx default site (catch-all 'Welcome to nginx' page)..."
        rm -f "$_default_site"
    fi

    # Uploaded white-label assets (logos/icons/OG image) are written here by the app
    # (assets_dir in pool.json) and served by nginx at /custom/. Ensure the directory
    # exists and that nginx can traverse into it (o+rX on the dir and its parents).
    mkdir -p "$POOL_APP_DIR/custom_assets"
    chmod o+rx /opt/grin "$POOL_APP_DIR" "$POOL_APP_DIR/custom_assets" 2>/dev/null || true

    # CMS media uploads (admin blog/pages editor) live here, served by nginx at /uploads/.
    # The app also creates this at boot, but pre-create + o+rx so nginx can traverse/read it
    # on a fresh install before the service has written its first file.
    mkdir -p "$POOL_APP_DIR/uploads"
    chmod o+rx "$POOL_APP_DIR/uploads" 2>/dev/null || true

    # nginx_ensure_rate_limit_zones is a no-op while its conf file exists (so operators can
    # hand-tune rates). That means a NEW zone added to the list below would never be written
    # on an existing install — yet the vhost references it, so `nginx -t` would then fail with
    # "zero size shared memory zone". Self-heal: if the managed conf is missing the captcha
    # zone (added 2026-06 to stop the login captcha being starved by static-asset traffic),
    # delete it so the full current list regenerates. Idempotent — once present, this is skipped.
    # Also regenerate if it still carries any earlier-generation rate. All zone rates
    # were multiplied ×20 in 2026-06 ("loosen now, tighten later" testing posture) so
    # rate-limiting never breaks normal browsing/admin polling — the real controls are
    # JWT + login captcha + per-account lockout + IP auto-ban, not these throttles.
    # Triggers below catch both the original generation (auth 3r/m, static 60r/m) and
    # the immediately-prior one (auth 10r/m, static 300r/m); regenerating rewrites the
    # full current list (also self-heals an install missing the _captcha/_admin zones).
    # A genuinely hand-tuned conf with other rates is left untouched.
    local _zone_conf="/etc/nginx/conf.d/script07-${POOL_SERVICE}.conf"
    if [[ -f "$_zone_conf" ]] \
        && { ! grep -q "zone=${POOL_SERVICE}_captcha[: ]" "$_zone_conf" \
             || ! grep -q "zone=${POOL_SERVICE}_admin[: ]" "$_zone_conf" \
             || grep -qE "zone=${POOL_SERVICE}_auth:[^ ]* rate=(3|10)r/m" "$_zone_conf" \
             || grep -qE "zone=${POOL_SERVICE}_static:[^ ]* rate=(60|300)r/m" "$_zone_conf"; }; then
        rm -f "$_zone_conf"
    fi

    if declare -F nginx_ensure_rate_limit_zones &>/dev/null; then
        nginx_ensure_rate_limit_zones "script07-${POOL_SERVICE}" \
            "${POOL_SERVICE}_auth:200r/m"     \
            "${POOL_SERVICE}_api:600r/m"      \
            "${POOL_SERVICE}_static:6000r/m"  \
            "${POOL_SERVICE}_captcha:600r/m"  \
            "${POOL_SERVICE}_admin:2400r/m"
    fi

    # ── Cloudflare proxy (orange cloud) support ───────────────────────────────
    # If the hub sits behind Cloudflare's proxy, the origin sees Cloudflare edge IPs,
    # which collapses every per-IP defence (rate-limit zones, fail2ban, app req.ip)
    # onto one shared bucket → "Too many requests" for everyone. Restoring the real
    # client IP from CF-Connecting-IP fixes all of them. Stored in $POOL_CONF so it
    # sticks across re-runs and Guided setup.
    local cf_proxy; cf_proxy=$(pool_read_conf "cloudflare_proxy" "")
    if [[ -z "$cf_proxy" ]]; then
        echo ""
        echo -e "  ${DIM}Is this hub behind Cloudflare's proxy (orange cloud)? If yes, the toolkit${RESET}"
        echo -e "  ${DIM}restores the real visitor IP so rate-limiting & fail2ban work per-user.${RESET}"
        echo -ne "  Behind Cloudflare proxy? [Y/n]: "
        local _cf_ans; read -r _cf_ans
        # Default YES — most public pools front the origin with Cloudflare's proxy. Only an
        # explicit "n" opts out (if you later go direct, re-run 4) Setup nginx and answer n).
        if [[ "${_cf_ans,,}" == "n" ]]; then cf_proxy="false"; else cf_proxy="true"; fi
        pool_write_conf_key "cloudflare_proxy" "$cf_proxy"
    fi

    local cf_realip_include=""
    if [[ "$cf_proxy" == "true" ]]; then
        if nginx_ensure_cloudflare_realip; then
            cf_realip_include="    include ${NGINX_CLOUDFLARE_REALIP_SNIPPET};"
        else
            warn "Cloudflare real-IP setup failed — vhost will be written WITHOUT it."
            warn "  Rate-limiting would throttle all visitors as one until this is fixed."
        fi
    fi

    # Build nginx allow/deny rules for the admin surfaces (/admin + /api/admin).
    #
    # DEFAULT = OPEN (bootstrap/testing posture). An empty admin_allowlist means the panel
    # is reachable from any IP, so a fresh install is never locked out while there is no
    # adoption yet for anyone to attack. The app-layer defenses (JWT sessions, login
    # captcha, per-account lockout, IP auto-ban, optional TOTP 2FA, fail2ban) are ALWAYS
    # in force regardless of this network gate — this is only the outer perimeter.
    #
    # HARDEN LATER: set admin_allowlist (comma/space-separated IPs/CIDRs) in $POOL_CONF and
    # re-run 4) Setup nginx. Once it is non-empty the panel locks to localhost + those
    # entries only (everything else is denied). localhost is always kept so an SSH tunnel
    # and the app's own server-side calls keep working as a break-glass path.
    local admin_allow_raw; admin_allow_raw=$(pool_read_conf "admin_allowlist" "")

    local admin_rules="" _entry
    if [[ -n "$admin_allow_raw" ]]; then
        admin_rules+="        allow 127.0.0.1;"$'\n'
        admin_rules+="        allow ::1;"$'\n'
        for _entry in ${admin_allow_raw//,/ }; do
            [[ -n "$_entry" ]] && admin_rules+="        allow ${_entry};"$'\n'
        done
        admin_rules+="        deny all;"
        info "Admin panel (/admin, /api/admin) restricted to: localhost + $admin_allow_raw"
    else
        admin_rules+="        allow all;"
        warn "Admin panel (/admin, /api/admin) is OPEN to all IPs — admin_allowlist is empty (testing default)."
        warn "  Harden once you have adoption: set \"admin_allowlist\" in $POOL_CONF and re-run 4) Setup nginx."
    fi

    local sites_enabled="/etc/nginx/sites-enabled/$(basename "$POOL_NGINX_CONF")"
    local cert_dir="/etc/letsencrypt/live/$subdomain"
    # The canonical host is the bare domain; www.<domain> 301-redirects to it. The cert
    # must carry www.<domain> as a SAN or the TLS handshake on www fails BEFORE the
    # redirect can run, so every certbot call below requests both names.
    local www_alias="www.$subdomain"

    # Does an existing cert already cover the www alias? (a pre-www install won't —
    # we then certbot --expand below so the www→apex HTTPS block has a valid cert).
    local cert_has_www="no"
    if [[ -f "$cert_dir/fullchain.pem" ]] && command -v openssl &>/dev/null; then
        if openssl x509 -in "$cert_dir/fullchain.pem" -noout -text 2>/dev/null \
             | grep -qi "DNS:$www_alias"; then
            cert_has_www="yes"
        fi
    fi

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
    server_name $subdomain $www_alias;
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
        # Email is auto-defaulted (no prompt) — it's only used for cert-expiry
        # notices and certbot auto-renews via its systemd timer anyway. Change it
        # later with `certbot update_account -m <email>` if you want notices.
        local le_email="admin@$subdomain"
        info "Using Let's Encrypt account email: $le_email"
        if ! certbot --nginx -d "$subdomain" -d "$www_alias" --non-interactive --agree-tos \
                -m "$le_email" 2>&1 | tail -5; then
            warn "certbot failed — check that DNS for $subdomain AND $www_alias point to this server and port 80 is open."
            warn "Pool stays HTTP-only; fix the cause and re-run 4) Setup nginx."
            return 0
        fi
        cert_has_www="yes"
        success "SSL certificate issued (covers $subdomain + $www_alias)."
    elif [[ "$cert_has_www" == "no" ]]; then
        # Cert exists but predates the www alias — expand it so the www→apex redirect
        # presents a valid cert. Best-effort: if DNS for www isn't set yet this fails,
        # and we fall back to an apex-only vhost (no www block) further down.
        info "Existing cert for $subdomain doesn't cover $www_alias — expanding..."
        if certbot --nginx --expand -d "$subdomain" -d "$www_alias" \
                --non-interactive --agree-tos -m "admin@$subdomain" 2>&1 | tail -5; then
            cert_has_www="yes"
            success "Certificate expanded to cover $www_alias."
        else
            warn "Could not expand cert to $www_alias (is its DNS pointed here?)."
            warn "  Skipping the www→apex HTTPS redirect for now — re-run 4) Setup nginx once www DNS resolves."
        fi
    fi

    # certbot --nginx creates options-ssl-nginx.conf; include it only when present
    # (a bare `include` of a missing file is a hard nginx -t error).
    local ssl_extra=""
    [[ -f /etc/letsencrypt/options-ssl-nginx.conf ]] \
        && ssl_extra="include /etc/letsencrypt/options-ssl-nginx.conf;"

    # www → apex redirect on HTTPS. Only emitted when the cert covers www.<domain>
    # (otherwise serving www on :443 presents a name-mismatched cert). The :80 block
    # below normalises http://www regardless.
    local www_https_block=""
    if [[ "$cert_has_www" == "yes" ]]; then
        www_https_block="server {
    listen 443 ssl http2;
    server_name $www_alias;
    ssl_certificate     /etc/letsencrypt/live/$subdomain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$subdomain/privkey.pem;
    $ssl_extra
    return 301 https://$subdomain\$request_uri;
}
"
    fi

    info "Writing nginx vhost (${POOL_NET_LABEL}): $POOL_NGINX_CONF"
    cat > "$POOL_NGINX_CONF" << EOF
# GRINIUM Grin Pool — ${POOL_NET_LABEL} — generated by Script 07 (pool_setup_nginx)
# Rate-limit zones live in /etc/nginx/conf.d/script07-${POOL_SERVICE}.conf

# HTTP → HTTPS, and www → apex (canonical host is the bare domain)
server {
    listen 80;
    server_name $subdomain $www_alias;
    return 301 https://$subdomain\$request_uri;
}

${www_https_block}server {
    listen 443 ssl http2;
    server_name $subdomain;
$cf_realip_include

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

    # ── Admin panel + admin API. Network gate is OPEN by default (empty admin_allowlist
    # → allow all) for the testing phase; app-layer JWT + captcha + lockout + auto-ban +
    # optional TOTP still apply. Harden by setting admin_allowlist in $POOL_CONF (locks to
    # localhost + listed IPs/CIDRs), then re-run 4) Setup nginx. See $admin_rules above.
    location = /admin { return 301 https://\$host/admin/; }
    location /admin/ {
$admin_rules
        # Dedicated _admin zone (120r/m): the admin panel is a polling dashboard that pulls
        # several assets + API calls per page, so it must NOT share the public _static/_api
        # budgets (a few fast clicks there used to 503 admin-shell.js → blank sidebar).
        limit_req zone=${POOL_SERVICE}_admin burst=40 nodelay;
        # SERVER-SIDE auth gate (kills the "flash of admin page → redirect" UX bug):
        # subrequest the backend before serving ANY admin file. The static HTML is an
        # empty shell (data comes from authenticated /api/admin/* calls), but rendering
        # it for a logged-out visitor looked broken. auth_request makes nginx withhold
        # the page entirely until /api/admin/_authcheck returns 2xx; a 401/403 is caught
        # by error_page → @admin_login → redirect to /login.html, so the browser never
        # receives admin markup unauthenticated. The client-side API.guardAdminPage()
        # remains as a fallback for installs whose nginx predates this block.
        auth_request /admin/_authcheck;
        error_page 401 403 = @admin_login;
        # No content hashing on these static pages, so tell browsers to revalidate
        # every load (304 when unchanged). Without this, browsers heuristically cache
        # the HTML and keep showing the OLD admin panel after a redeploy.
        add_header Cache-Control "no-cache" always;
        try_files \$uri \$uri/ \$uri.html =404;
    }
    # Internal target for the auth_request above — never reachable directly (internal).
    # No network gate / rate limit here: the parent /admin/ already applied \$admin_rules,
    # and the backend handler deliberately skips the admin brute-force budget so per-asset
    # subrequests stay cheap. Strip the body (we only care about the status code).
    location = /admin/_authcheck {
        internal;
        proxy_pass              http://127.0.0.1:$POOL_PORT/api/admin/_authcheck;
        proxy_pass_request_body off;
        proxy_set_header        Content-Length "";
        proxy_set_header        Host \$host;
        proxy_set_header        X-Real-IP \$remote_addr;
        proxy_set_header        X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
    # Unauthenticated visitors to /admin/* land on the public login door, not a 401 page.
    location @admin_login { return 302 https://\$host/login.html; }
    location /api/admin/ {
$admin_rules
        limit_req zone=${POOL_SERVICE}_admin burst=40 nodelay;
        # CMS media upload (POST /api/admin/media) accepts images up to 5 MB; nginx's 1 MB
        # default would 413 them before they reach the app. 6m leaves multipart overhead.
        client_max_body_size 6m;
        proxy_pass         http://127.0.0.1:$POOL_PORT;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }

    # The CAPTCHA challenge is a read-only GET the login page fetches on load, on
    # form-toggle, and after every failed attempt — it gets its OWN dedicated zone.
    # It must NOT share the strict _auth brute-force budget (retry can't recover),
    # AND must NOT share _static either: that zone is keyed per-IP and consumed by every
    # CSS/JS/font/image on every page (a dozen+ per load), so a few page reloads during
    # testing starve the captcha → "Verification unavailable" and "↻ new" does nothing →
    # captcha_id stays null → the login POST is rejected at the captcha gate and you can
    # never log in. Its own zone keeps it lit regardless of asset traffic. This is NOT the
    # brute-force vector (the login POST stays on _auth 10r/m + per-account lockout + IP
    # auto-ban); issuing a fresh arithmetic challenge is a cheap in-memory op, so a
    # generous, isolated rate is safe. Exact-match wins over the /api/auth/ prefix.
    location = /api/auth/captcha {
        limit_req zone=${POOL_SERVICE}_captcha burst=20 nodelay;
        proxy_pass         http://127.0.0.1:$POOL_PORT;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
    }

    location /api/auth/ {
        limit_req zone=${POOL_SERVICE}_auth burst=5 nodelay;
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
    # Blog RSS is generated by the app (not a static file).
    location = /blog/rss.xml  { proxy_pass http://127.0.0.1:$POOL_PORT; proxy_set_header Host \$host; }

    # CMS media (cover images + in-body images uploaded via the admin editor). Stored in a
    # persistent dir OUTSIDE public_html so a code redeploy (rsync --delete of the docroot)
    # never wipes them. Same SVG hardening as /custom/: nosniff + sandbox CSP neutralises any
    # script in a directly-opened SVG; correct image MIME types are kept for <img> rendering.
    location /uploads/ {
        alias $POOL_APP_DIR/uploads/;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Content-Security-Policy "default-src 'none'; style-src 'unsafe-inline'; sandbox" always;
        add_header Cache-Control "public, max-age=604800, immutable" always;
        try_files \$uri =404;
    }

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

    # Clean blog-post permalinks: /blog/<slug> serves the static post.html shell,
    # which reads the slug from its own path (falling back to ?slug= for legacy links).
    # The exact-match "location = /blog/rss.xml" above wins over this regex, and the blog
    # index /blog.html doesn't match (no slash after "blog"). Slug charset mirrors slugify()
    # in lib/posts.js (lowercase alnum + hyphen); underscores allowed for safety.
    location ~ ^/blog/([A-Za-z0-9_-]+)/?\$ {
        limit_req zone=${POOL_SERVICE}_static burst=100 nodelay;
        add_header Cache-Control "no-cache" always;
        try_files /post.html =404;
    }

    location / {
        # Generous burst: a single page load pulls the HTML + ~a dozen assets (CSS, JS
        # incl. public-shell.js which injects the header/nav, fonts, images), and with
        # Cache-Control:no-cache each navigation revalidates them — so fast multi-page
        # browsing legitimately fires many requests in a few seconds. Throttling here
        # only broke the page (plain HTML, no CSS, lost nav); it is not a DoS surface.
        limit_req zone=${POOL_SERVICE}_static burst=100 nodelay;
        # Pages/assets carry no content hash, so a far-future cache would serve stale
        # HTML/JS after a redeploy (the classic "/ and /index.html differ", "old nav",
        # "old admin" confusion — really browser cache). no-cache = store but always
        # revalidate, so a deploy is picked up immediately while unchanged files 304.
        add_header Cache-Control "no-cache" always;
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

    if [[ "$cf_proxy" == "true" ]]; then
        echo ""
        info "Cloudflare proxy mode is ON — real visitor IPs are restored from CF-Connecting-IP."
        echo -e "  ${DIM}In Cloudflare DNS, set this record to ${RESET}Proxied (orange cloud)${DIM}.${RESET}"
        echo -e "  ${YELLOW}Harden (recommended):${RESET} so attackers can't bypass Cloudflare by hitting"
        echo -e "  the origin IP directly, allow 80/443 ONLY from Cloudflare ranges. Example (ufw):"
        echo -e "    ${DIM}for ip in \$(curl -s https://www.cloudflare.com/ips-v4) \$(curl -s https://www.cloudflare.com/ips-v6); do${RESET}"
        echo -e "    ${DIM}  ufw allow from \"\$ip\" to any port 443 proto tcp; ufw allow from \"\$ip\" to any port 80 proto tcp; done${RESET}"
        echo -e "  ${DIM}Keep your SSH port open separately, then 'ufw deny 80,443' from everywhere else.${RESET}"
        echo -e "  ${DIM}Also turn OFF any Cloudflare 'Cache Everything' page rule for HTML (the origin${RESET}"
        echo -e "  ${DIM}sends Cache-Control: no-cache so deploys show up immediately).${RESET}"
    fi
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
    echo -e "\n${BOLD}Create Admin Account — ${POOL_NET_LABEL}${RESET}\n"

    # The service may still be binding the port — the FIRST start runs DB
    # init/migrations, so it isn't instant. Wait briefly instead of bailing
    # immediately (this is the common case right after 6) Start service and in
    # the guided flow, where a 2s gap isn't enough).
    if ! ss -tlnp 2>/dev/null | grep -q ":$port "; then
        info "Waiting for the pool manager to listen on port $port..."
        if declare -F gnc_wait_for_port >/dev/null 2>&1; then
            gnc_wait_for_port "$port" 20 2 >/dev/null 2>&1 || true
        fi
    fi
    if ! ss -tlnp 2>/dev/null | grep -q ":$port "; then
        warn "Pool manager is not running on port $port."
        warn "Start the service (option 6) first, then run this again."
        warn "If it won't start, check: journalctl -u $POOL_SERVICE -n 50 --no-pager"
        return 1
    fi

    # Re-prompt on validation failure instead of bailing — a single typo shouldn't
    # send the operator back to the menu. Empty input at any prompt cancels cleanly.
    echo -e "  ${DIM}(Username: at least 3 characters — blank to cancel)${RESET}"
    while true; do
        echo -ne "Admin username: "
        read -r admin_user
        [[ -z "$admin_user" ]] && { info "Cancelled — no admin account created."; return; }
        if [[ ${#admin_user} -lt 3 ]]; then
            error "Username must be at least 3 characters. Try again."
            continue
        fi
        break
    done

    # Password + confirmation share one loop: a mismatch or a too-short password
    # re-asks both fields (typos are silent under read -rs and would otherwise lock
    # the operator out of an account whose password they can't reproduce).
    echo -e "  ${DIM}(Password: at least 8 characters — blank to cancel)${RESET}"
    while true; do
        echo -ne "Admin password: "
        read -rs admin_pass; echo ""
        [[ -z "$admin_pass" ]] && { info "Cancelled — no admin account created."; return; }
        if [[ ${#admin_pass} -lt 8 ]]; then
            error "Password must be at least 8 characters. Try again."
            continue
        fi

        echo -ne "Confirm admin password: "
        read -rs admin_pass2; echo ""
        [[ -z "$admin_pass2" ]] && { info "Cancelled — no admin account created."; return; }
        if [[ "$admin_pass" != "$admin_pass2" ]]; then
            error "Passwords do not match. Try again."
            continue
        fi
        break
    done

    echo -ne "Admin email (optional): "
    read -r admin_email

    # No captcha here: /api/auth/register skips the anti-robot gate for direct on-box
    # (loopback) calls — see isLocalRequest() in back-end-pool/index.js. This guided
    # flow always POSTs to 127.0.0.1, and the captcha only exists to slow REMOTE brute
    # force on the public login form, not the trusted root operator doing first-admin setup.
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
        # No separate "promote" step needed: registerAdmin() inserts the first
        # user with is_admin=1 (registration closes once an admin exists).
        # Verify it landed so the step-7 ✓ marker and the operator agree.
        if _pool_step_done 7; then
            success "Admin '$admin_user' registered (is_admin confirmed in pool.db)."
        else
            success "Admin '$admin_user' registered."
            warn "Could not confirm the admin row in pool.db — check 8) Pool status."
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
# 5) POOL WALLET (combined coinbase + payout listener, Owner+Foreign 3420)
# ═══════════════════════════════════════════════════════════════════════════════
# Thin menu over the pw_* functions in lib/07_lib_pool_wallet.sh. The pool needs
# BOTH wallet APIs running: Foreign (the node's stratum builds coinbase here →
# block rewards) and Owner (the backend sends Tor payouts here). Setup installs
# the binary, inits/recovers the wallet, patches the node's wallet_listener_url,
# and starts both listeners; the rest is ongoing listener control.

pool_wallet_menu() {
    while true; do
        echo -e "\n${BOLD}Pool Wallet — ${POOL_NET_LABEL} — combined coinbase + payouts (Owner+Foreign ${PW_OWNER_PORT})${RESET}"
        pw_listener_status
        local wd_tag
        if [[ -f "$PW_WATCHDOG_CRON" ]]; then wd_tag="${GREEN}[OK] watchdog${RESET}"; else wd_tag="${DIM}[--] watchdog${RESET}"; fi
        echo -e "  $(pw_autostart_status)    $wd_tag"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Set up wallet        ${DIM}(install + init/recover + save pass/address + start)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Start listener       ${DIM}(owner_api + include_foreign, Owner+Foreign ${PW_OWNER_PORT}, auto-unlock)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Stop listener"
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
    if [[ ! -f "/etc/systemd/system/$POOL_SERVICE.service" ]]; then
        error "Service unit not found — run 1) Install first."
        return 1
    fi
    echo -e "\n${BOLD}Service Control — ${POOL_NET_LABEL} ($POOL_SERVICE)${RESET}"
    if systemctl is-active --quiet "$POOL_SERVICE" 2>/dev/null; then
        echo -e "  Status: ${GREEN}● running${RESET}"
        echo -e "  ${GREEN}1${RESET}) Stop    ${RED}2${RESET}) Restart    ${DIM}0) Back${RESET}"
        echo -ne "Choice: "
        read -r sc
        case "$sc" in
            1) pool_service_control stop;    _pool_pause ;;
            2) pool_service_control restart; _pool_pause ;;
        esac
    else
        echo -e "  Status: ${RED}● stopped${RESET}"
        echo -e "  ${GREEN}1${RESET}) Start    ${DIM}0) Back${RESET}"
        echo -ne "Choice: "
        read -r sc
        # if-form: a trailing `[[ ]] &&` would make "0/back" return 1 → set -e kills the caller
        if [[ "$sc" == "1" ]]; then pool_service_control start; _pool_pause; fi
    fi
}

pool_start_service() {
    if [[ ! -f "/etc/systemd/system/$POOL_SERVICE.service" ]]; then
        error "Service unit not found — run 1) Install first."
        return 1
    fi
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
    info "Backing up the ${POOL_NET_LABEL} pool (DB + config)..."
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

# Pause helper for one-shot submenus that perform an action: keeps their success
# output on screen. Submenus call this only after a real action (never on Back),
# so the main loop excludes them from its own pause — no double prompt.
_pool_pause() { echo ""; echo "Press Enter to continue..."; read -r; }

# ═══════════════════════════════════════════════════════════════════════════════
# C) CRON SCHEDULES
# ═══════════════════════════════════════════════════════════════════════════════

pool_cron_schedules() {
    echo -e "\n${BOLD}Cron Schedules — ${POOL_NET_LABEL} ($POOL_SERVICE)${RESET}\n"
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

    local backup_wrapper="/usr/local/bin/grin-pool-backup-${POOL_NET}"

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
    echo "[grin-pool-backup-${POOL_NET}] Nothing to back up."
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
            _pool_pause
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
            _pool_pause
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

    echo -e "\n${RED}${BOLD}━━━ DANGER ZONE — Reset Pool Database (${POOL_NET_LABEL}) ━━━${RESET}"
    echo ""

    if [[ ! -f "$db_path" ]]; then
        warn "Database not found: $db_path"
        return
    fi

    local db_size; db_size=$(du -sh "$db_path" 2>/dev/null | cut -f1 || echo "?")
    local user_count
    user_count=$(_pool_db_scalar "SELECT COUNT(*) FROM users" "$db_path" || true)
    [[ -n "$user_count" ]] || user_count="?"

    echo -e "  Database : $db_path  ($db_size)"
    echo -e "  Users    : $user_count accounts"
    echo -e "  Network  : ${POOL_NET_LABEL}"
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

# Pause between guided steps. Enter continues; 0 (or q) aborts the guided flow
# (rc 1) so the caller can return to the menu. <label of the next step>

# Run guided step <n> "<label>" <fn> — when the step already looks complete
# (per _pool_step_done), offer to skip it. This makes re-running G) after a
# mid-flow abort resume where it left off instead of redoing everything.
_pool_guided_step() {
    local n="$1" label="$2" fn="$3"
    if _pool_step_done "$n"; then
        echo -ne "  Step $n) $label looks ${GREEN}already done${RESET} — re-run it? [y/N]: "
        local re; read -r re
        [[ "${re,,}" == "y" ]] || { info "Skipped: $label (already done)."; return 0; }
    fi
    "$fn"
}

pool_guided_setup() {
    echo -e "\n${BOLD}${CYAN}═══ Guided Full Setup — GRINIUM Pool (${POOL_NET_LABEL}) ═══${RESET}\n"
    pool_check_exclusivity || return 0
    echo -e "  Runs steps 1 → 7 straight through (no pause between steps)."
    echo -e "  You're only asked for real inputs: the pool domain, SSL/certbot,"
    echo -e "  the wallet passphrase, and the admin username/password."
    echo -e "  Steps already completed (✓) can be skipped when prompted:"
    local _step_names=("Install" "Configure" "Deploy web files" "Setup nginx" \
                       "Set up wallet" "Service running" "Admin account")
    local _i
    for _i in 1 2 3 4 5 6 7; do
        echo -e "    $(_pool_step_mark "$_i") ${_step_names[$((_i-1))]}"
    done
    echo ""
    echo -ne "  Continue? [Y/n]: "
    read -r go; [[ "${go,,}" == "n" ]] && return

    # Run straight through — no "press Enter" gate between steps. Steps that need
    # no input just print their banner and proceed; the only stops are real inputs
    # (the pool domain, certbot, the wallet passphrase, the admin credentials).
    # Every step is ||-guarded: under set -e an unguarded failure would kill the
    # whole script instead of returning to the menu. Abort the guided flow with a
    # message on the first hard failure; the operator fixes it and re-runs.
    echo -e "\n${BOLD}${CYAN}── Step 1/7: Install ──${RESET}"
    _pool_guided_step 1 "Install" pool_install \
        || { error "Install failed — fix the cause and re-run G) Guided setup."; return 0; }

    echo -e "\n${BOLD}${CYAN}── Step 2/7: Configure (pool domain) ──${RESET}"
    _pool_guided_step 2 "Configure" pool_configure \
        || { error "Configure failed — aborting guided setup."; return 0; }

    echo -e "\n${BOLD}${CYAN}── Step 3/7: Deploy web files ──${RESET}"
    _pool_guided_step 3 "Deploy web files" pool_deploy_web \
        || { error "Web deploy failed — aborting guided setup."; return 0; }

    echo -e "\n${BOLD}${CYAN}── Step 4/7: Setup nginx + SSL ──${RESET}"
    _pool_guided_step 4 "Setup nginx" pool_setup_nginx \
        || { error "Nginx setup failed — aborting guided setup."; return 0; }

    # Wallet setup must end with the combined listener up AND unlocked (pw_setup
    # returns non-zero otherwise, or on a deliberate cancel). Don't roll on to the
    # service + admin steps with a wallet that can't listen/open — coinbase + payouts
    # would silently fail. Default to stopping; only continue if the operator opts in.
    echo -e "\n${BOLD}${CYAN}── Step 5/7: Set up wallet (combined coinbase + payout listener) ──${RESET}"
    if ! _pool_guided_step 5 "Set up wallet" pw_setup; then
        warn "Wallet not fully set up (listeners down or setup cancelled) — finish via 5) Set up wallet."
        echo -ne "  Continue with the remaining steps anyway (service + admin)? [y/N]: "
        local go2; read -r go2
        [[ "${go2,,}" == "y" ]] || { info "Guided setup stopped — completed steps are kept."; return 0; }
    fi

    echo -e "\n${BOLD}${CYAN}── Step 6/7: Start service ──${RESET}"
    pool_start_service || true
    # Wait for the service to actually bind its port before creating the admin —
    # the first start runs DB init/migrations, so it isn't instant. Without this
    # the next step's port check can fail and skip admin creation.
    local _svc_port; _svc_port=$(pool_read_conf "service_port" "$POOL_PORT")
    info "Waiting for $POOL_SERVICE to listen on port $_svc_port..."
    gnc_wait_for_port "$_svc_port" 30 2 >/dev/null 2>&1 \
        || warn "Service not listening yet — 7) admin creation will wait/retry."

    echo -e "\n${BOLD}${CYAN}── Step 7/7: Create admin account ──${RESET}"
    _pool_guided_step 7 "Create admin account" pool_setup_admin \
        || warn "Admin account not created — run 7) Create admin account once the service is up."

    local _domain; _domain=$(pool_read_conf "subdomain" "your-domain")
    local _allow;  _allow=$(pool_read_conf "admin_allowlist" "")
    echo ""
    success "Guided setup complete."
    echo ""
    echo -e "  ${BOLD}Public pool:${RESET}   https://$_domain"
    echo -e "  ${BOLD}Admin login:${RESET}   https://$_domain/login.html   (redirects to /admin/ after sign-in)"
    echo ""
    if [[ -n "$_allow" ]]; then
        echo -e "  ${BOLD}${YELLOW}The admin panel is IP-restricted${RESET} — only the listed IPs can reach /admin/."
        echo -e "  Currently allowed:  ${GREEN}localhost + $_allow${RESET}"
        echo ""
        echo -e "  ${YELLOW}Getting 403 on /admin/?${RESET} The IP you browse from isn't on the list above"
        echo -e "  (it can differ from your SSH IP). Add your browsing IP, then re-run ${BOLD}4) Setup nginx${RESET}:"
        echo ""
        echo -e "    ${CYAN}# 1) On the machine you browse from, open https://api.ipify.org to get its IP${RESET}"
        echo -e "    ${CYAN}# 2) Add it (replace 1.2.3.4 — existing entries are kept):${RESET}"
        echo -e "    ${CYAN}node -e 'const f=\"$POOL_CONF\",ip=process.argv[1];const d=JSON.parse(require(\"fs\").readFileSync(f,\"utf8\"));const s=new Set((d.admin_allowlist||\"\").split(/[,\\\\s]+/).filter(Boolean));s.add(ip);d.admin_allowlist=[...s].join(\",\");require(\"fs\").writeFileSync(f,JSON.stringify(d,null,2));require(\"fs\").chmodSync(f,0o600);console.log(\"admin_allowlist =\",d.admin_allowlist)' 1.2.3.4${RESET}"
        echo -e "    ${CYAN}# 3) Re-run menu option 4) Setup nginx  (rewrites the vhost + reloads)${RESET}"
    else
        echo -e "  ${BOLD}${YELLOW}The admin panel is OPEN to all IPs${RESET} (testing default) — anyone who knows the"
        echo -e "  URL can reach /admin/, gated only by login (JWT + captcha + lockout + auto-ban)."
        echo -e "  ${BOLD}Harden once you have adoption:${RESET} set ${BOLD}admin_allowlist${RESET} in $POOL_CONF to your"
        echo -e "  browsing/VPN IP(s), then re-run ${BOLD}4) Setup nginx${RESET} to lock it down."
    fi
    echo ""
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

# ═══════════════════════════════════════════════════════════════════════════════
# W) MULTI-REGION — central WireGuard server + gateway peers (Model C)
# ═══════════════════════════════════════════════════════════════════════════════
# The central box accepts regional GATEWAYS (07_lib_gateway.sh) over a WireGuard
# tunnel. Each gateway forwards miner stratum (with a PROXY-v2 header carrying the
# real miner IP) to a per-region INTERNAL port here, bound to the tunnel interface
# only (never public). This menu sets up the wg server and adds gateway peers,
# assigning each a tunnel IP + a region listener port (written into region_ports).
# See flowcharts/script07_mining_public_planning.txt (Model C, Phase 3).
# Per-network so a testnet pool's tunnel never collides with a mainnet one on the same box
# (iface kept ≤15 chars for Linux IFNAMSIZ — "wg-grinpool-tn").
if [[ "$POOL_NET" == "testnet" ]]; then
    WG_IFACE="wg-grinpool-tn"
    WG_DIR_CONF="/opt/grin/conf/wg-testnet"
    WG_TUNNEL_NET="10.66.67"        # /24; server = .1, gateways = .2, .3, ...
    WG_LISTEN_PORT=51821
    REGION_PORT_BASE=13391          # first per-region internal stratum port (testnet)
else
    WG_IFACE="wg-grinpool"
    WG_DIR_CONF="/opt/grin/conf/wg"
    WG_TUNNEL_NET="10.66.66"        # /24; server = .1, gateways = .2, .3, ...
    WG_LISTEN_PORT=51820
    REGION_PORT_BASE=3391           # first per-region internal stratum port
fi
WG_CONF="/etc/wireguard/${WG_IFACE}.conf"

pool_wg_setup_server() {
    info "Setting up the central WireGuard server..."
    if command -v apt-get &>/dev/null; then
        apt-get install -y wireguard-tools 2>&1 | tail -5
    elif command -v dnf &>/dev/null; then
        dnf install -y wireguard-tools 2>&1 | tail -5
    fi
    command -v wg &>/dev/null || { error "wireguard-tools (wg) not installed."; return 1; }

    mkdir -p "$WG_DIR_CONF"; chmod 700 "$WG_DIR_CONF"
    if [[ ! -f "$WG_DIR_CONF/server_private.key" ]]; then
        ( umask 077; wg genkey > "$WG_DIR_CONF/server_private.key" )
        wg pubkey < "$WG_DIR_CONF/server_private.key" > "$WG_DIR_CONF/server_public.key"
        success "Generated central WireGuard keypair."
    fi

    if [[ ! -f "$WG_CONF" ]]; then
        local priv; priv=$(cat "$WG_DIR_CONF/server_private.key")
        mkdir -p "$(dirname "$WG_CONF")"
        ( umask 077; cat > "$WG_CONF" << EOF
# Grin pool central WireGuard server — auto-generated. Add gateways via the pool menu (W).
[Interface]
Address = ${WG_TUNNEL_NET}.1/24
ListenPort = ${WG_LISTEN_PORT}
PrivateKey = ${priv}
EOF
        )
        chmod 600 "$WG_CONF"
        success "Wrote $WG_CONF (${WG_TUNNEL_NET}.1/24, UDP ${WG_LISTEN_PORT})."
    else
        info "$WG_CONF already exists — keeping it (add peers with option 2)."
    fi

    # Open the WireGuard UDP port. Region listener ports are NOT opened — they bind the
    # tunnel interface only, so only authenticated wg peers can reach them.
    if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q active; then
        ufw allow "${WG_LISTEN_PORT}/udp" >/dev/null 2>&1 || true; info "ufw: opened ${WG_LISTEN_PORT}/udp."
    elif command -v firewall-cmd &>/dev/null && firewall-cmd --state &>/dev/null; then
        firewall-cmd --permanent --add-port="${WG_LISTEN_PORT}/udp" >/dev/null 2>&1 || true
        firewall-cmd --reload >/dev/null 2>&1 || true; info "firewalld: opened ${WG_LISTEN_PORT}/udp."
    fi

    wg-quick down "$WG_IFACE" 2>/dev/null || true
    if wg-quick up "$WG_IFACE"; then
        systemctl enable "wg-quick@${WG_IFACE}" 2>/dev/null || true
        # Bind the central per-region stratum listeners to the tunnel IP (never public).
        pool_write_conf_key "region_listen_host" "${WG_TUNNEL_NET}.1"
        success "Central tunnel up (${WG_TUNNEL_NET}.1)."
        echo ""
        echo -e "  ${BOLD}Give each gateway operator these:${RESET}"
        echo -e "    central wg public key : ${GREEN}$(cat "$WG_DIR_CONF/server_public.key")${RESET}"
        echo -e "    central wg endpoint   : ${GREEN}$(curl -s --max-time 4 https://api.ipify.org 2>/dev/null || echo '<server-public-ip>'):${WG_LISTEN_PORT}${RESET}"
        echo -e "    central tunnel IP     : ${GREEN}${WG_TUNNEL_NET}.1${RESET}"
    else
        error "wg-quick up failed — check $WG_CONF."
        return 1
    fi
}

pool_wg_add_peer() {
    [[ -f "$WG_CONF" ]] || { error "Run 1) Setup WireGuard server first."; return 1; }
    local region gwpub
    echo -ne "Region key for this gateway (airport-style code, e.g. nyc, sgn, ams): "; read -r region
    [[ -n "$region" ]] || { warn "Region key required."; return 1; }
    echo -ne "Gateway's WireGuard public key: "; read -r gwpub
    [[ -n "$gwpub" ]] || { warn "Gateway public key required."; return 1; }

    # Assign the next free tunnel IP (max existing AllowedIPs octet + 1) and region port
    # (max existing region_ports value + 1, else the base). Both computed in one node call.
    local assign nextip nextport
    assign=$(node -e '
const fs = require("fs");
const [wgConf, poolConf, net, base] = process.argv.slice(1);
let octs = [1];
try {
  const t = fs.readFileSync(wgConf, "utf8");
  const re = new RegExp("AllowedIPs\\s*=\\s*" + net.replace(/\./g,"\\.") + "\\.(\\d+)", "g");
  let m; while ((m = re.exec(t))) octs.push(parseInt(m[1], 10));
} catch (e) {}
let ports = [];
try {
  const d = JSON.parse(fs.readFileSync(poolConf, "utf8"));
  if (d.region_ports) ports = Object.values(d.region_ports).map(Number).filter(Boolean);
} catch (e) {}
const nextIp   = Math.max.apply(null, octs) + 1;
const nextPort = ports.length ? Math.max.apply(null, ports) + 1 : parseInt(base, 10);
process.stdout.write(nextIp + " " + nextPort);
' "$WG_CONF" "$POOL_CONF" "$WG_TUNNEL_NET" "$REGION_PORT_BASE" 2>/dev/null) || true
    nextip=$(echo "$assign" | awk '{print $1}')
    nextport=$(echo "$assign" | awk '{print $2}')
    if [[ -z "$nextip" || -z "$nextport" ]]; then
        error "Could not compute peer IP/port — is node installed and $POOL_CONF valid?"
        return 1
    fi
    local peer_ip="${WG_TUNNEL_NET}.${nextip}"

    # Append the peer to the wg config and apply live without dropping existing tunnels.
    cat >> "$WG_CONF" << EOF

[Peer]
# region: ${region}
PublicKey = ${gwpub}
AllowedIPs = ${peer_ip}/32
EOF
    if wg syncconf "$WG_IFACE" <(wg-quick strip "$WG_IFACE") 2>/dev/null; then
        info "Applied peer to live tunnel."
    else
        warn "wg syncconf failed — run 3) restart, or wg-quick down/up ${WG_IFACE}."
    fi

    # Record the region → internal port mapping in pool.json (nested object; the scalar
    # pool_write_conf_key can't express it). region_listen_host stays the tunnel IP.
    node -e '
const fs = require("fs");
const [p, region, port, host] = process.argv.slice(1);
let d = {}; try { d = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) {}
d.region_ports = d.region_ports || {};
d.region_ports[region] = parseInt(port, 10);
d.region_listen_host = host;
fs.writeFileSync(p, JSON.stringify(d, null, 2)); fs.chmodSync(p, 0o600);
' "$POOL_CONF" "$region" "$nextport" "${WG_TUNNEL_NET}.1"

    # Restart the pool so the new per-region listener binds on the tunnel IP.
    if systemctl is-active --quiet "$POOL_SERVICE" 2>/dev/null; then
        systemctl restart "$POOL_SERVICE" && info "Restarted $POOL_SERVICE (new region listener binding)."
    fi

    echo ""
    success "Added gateway peer for region '${region}'."
    local hub_pub pub_ep
    hub_pub=$(cat "$WG_DIR_CONF/server_public.key" 2>/dev/null)
    pub_ep="$(curl -s --max-time 4 https://api.ipify.org 2>/dev/null || echo '<server-public-ip>'):${WG_LISTEN_PORT}"
    echo -e "  ${BOLD}Give this gateway operator:${RESET}"
    echo -e "    region key            : ${GREEN}${region}${RESET}"
    echo -e "    central wg public key : ${GREEN}${hub_pub}${RESET}"
    echo -e "    central wg endpoint   : ${GREEN}${pub_ep}${RESET}"
    echo -e "    central tunnel IP     : ${GREEN}${WG_TUNNEL_NET}.1${RESET}"
    echo -e "    this gateway tunnel IP: ${GREEN}${peer_ip}/32${RESET}"
    echo -e "    central region port   : ${GREEN}${nextport}${RESET}  ${DIM}(hub_endpoint = ${WG_TUNNEL_NET}.1:${nextport})${RESET}"
    echo ""
    echo -e "  ${BOLD}Or hand over this ONE-LINE pairing string${RESET} ${DIM}(paste it at the gateway's 2) Configure${RESET}"
    echo -e "  ${DIM}to fill every tunnel field at once; re-printable via 3) List gateways):${RESET}"
    echo -e "    ${GREEN}GRINGW1|${region}|${hub_pub}|${pub_ep}|${WG_TUNNEL_NET}.1|${peer_ip}/32|${nextport}${RESET}"
    echo ""
    echo -e "  ${DIM}Also declare region '${region}' in admin → Regions so it shows on the connect grid.${RESET}"
}

pool_wg_list() {
    echo -e "\n${BOLD}Multi-region — gateways & tunnel${RESET}"
    echo -e "${DIM}────────────────────────────────────────────────${RESET}"
    if [[ ! -f "$WG_CONF" ]]; then
        echo -e "  ${DIM}WireGuard server not set up (run option 1).${RESET}"
        return 0
    fi
    echo -e "  ${BOLD}Region → internal port:${RESET}"
    node -e '
const fs = require("fs");
let d = {}; try { d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) {}
const rp = d.region_ports || {};
const keys = Object.keys(rp);
if (!keys.length) { console.log("    (none yet)"); }
else keys.forEach(k => console.log("    " + k + "  ->  " + rp[k]));
console.log("  listen host: " + (d.region_listen_host || "(unset)"));
' "$POOL_CONF" 2>/dev/null || echo "    (could not read $POOL_CONF)"

    # Re-print each peer's one-line pairing string (same format as add-peer prints),
    # so an operator who lost the add-peer output can still hand it to the gateway.
    local _hub_pub _pub_ep
    _hub_pub=$(cat "$WG_DIR_CONF/server_public.key" 2>/dev/null)
    _pub_ep="$(curl -s --max-time 4 https://api.ipify.org 2>/dev/null || echo '<server-public-ip>'):${WG_LISTEN_PORT}"
    echo ""
    echo -e "  ${BOLD}Pairing strings${RESET} ${DIM}(paste into the matching gateway's 2) Configure):${RESET}"
    node -e '
const fs = require("fs");
const [wgConf, poolConf, hubPub, pubEp, hubIp] = process.argv.slice(1);
let txt = ""; try { txt = fs.readFileSync(wgConf, "utf8"); } catch (e) {}
let d = {};  try { d = JSON.parse(fs.readFileSync(poolConf, "utf8")); } catch (e) {}
const ports = d.region_ports || {};
const re = /# region: (\S+)[^[]*?AllowedIPs\s*=\s*(\S+)/g;
let m, n = 0;
while ((m = re.exec(txt))) {
  console.log("    GRINGW1|" + m[1] + "|" + hubPub + "|" + pubEp + "|" + hubIp + "|" + m[2] + "|" + (ports[m[1]] || "?"));
  n++;
}
if (!n) console.log("    (no gateway peers yet — add one with option 2)");
' "$WG_CONF" "$POOL_CONF" "$_hub_pub" "$_pub_ep" "${WG_TUNNEL_NET}.1" 2>/dev/null || true

    # UX guard: a region wired here (region_ports) but NOT declared in admin → Regions
    # (pool_locations) still mines + credits fine — but shows on the public connect grid
    # only as an unlabelled card derived from live shares. Warn so the operator can add
    # the label/country. Uses node:sqlite (always present); stays SILENT when the DB is
    # absent/unreadable (can't verify → don't cry wolf), matching _pool_db_scalar.
    local _wg_unmatched
    _wg_unmatched=$(node -e '
const fs = require("fs");
let d = {}; try { d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) { process.exit(0); }
const regions = Object.keys(d.region_ports || {});
if (!regions.length) process.exit(0);
const have = new Set();
try {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[2]);
  for (const r of db.prepare("SELECT region FROM pool_locations").all()) have.add(r.region);
} catch (e) { process.exit(0); }   // DB missing / table not created yet → cannot verify
const missing = regions.filter(r => !have.has(r));
if (missing.length) process.stdout.write(missing.join(" "));
' "$POOL_CONF" "$POOL_APP_DIR/pool.db" 2>/dev/null || true)
    if [[ -n "$_wg_unmatched" ]]; then
        warn "Region(s) wired but not declared in admin → Regions: ${_wg_unmatched}"
        echo -e "  ${DIM}They mine + credit fine, but show as unlabelled cards on the public${RESET}"
        echo -e "  ${DIM}connect grid until you add them in the admin panel → Regions.${RESET}"
    fi
    echo ""
    if wg show "$WG_IFACE" &>/dev/null; then
        echo -e "  ${BOLD}Live tunnel (${WG_IFACE}):${RESET}"
        wg show "$WG_IFACE" 2>/dev/null | sed 's/^/    /'
    else
        echo -e "  ${DIM}Tunnel ${WG_IFACE} not up.${RESET}"
    fi
}

pool_wireguard_menu() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Multi-region — WireGuard + gateways${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "  ${YELLOW}${BOLD}OPTIONAL — you do NOT need this for a normal pool.${RESET}"
        echo -e "  ${DIM}Your pool already serves all your miners on :$(pool_read_conf stratum_port 3333) as region \"main\".${RESET}"
        echo -e "  ${DIM}Use this ONLY when you add a regional gateway server in ANOTHER zone/${RESET}"
        echo -e "  ${DIM}continent (a separate box near distant miners, to cut their latency).${RESET}"
        echo -e "  ${DIM}One server = skip this menu entirely. Steps: 1) here, 2) add each peer${RESET}"
        echo -e "  ${DIM}here, then install \"2) Regional gateway\" on the OTHER box.${RESET}"
        echo ""
        echo -e "${DIM}  Central accepts thin regional gateways over a wg tunnel.${RESET}"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Setup WireGuard server   ${DIM}(install, keys, tunnel, firewall)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Add a gateway peer       ${DIM}(assign tunnel IP + region port)${RESET}"
        echo -e "  ${GREEN}3${RESET}) List gateways / regions"
        echo ""
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select: ${RESET}"
        read -r wgc
        case "${wgc,,}" in
            "")       continue ;;
            1)        pool_wg_setup_server || true; _pool_pause ;;
            2)        pool_wg_add_peer || true; _pool_pause ;;
            3)        pool_wg_list || true; _pool_pause ;;
            0|q|exit) break ;;
            *)        warn "Invalid option."; sleep 1 ;;
        esac
    done
}

show_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  GRINIUM — Grin Public Mining Pool ($([[ "$POOL_NET" == testnet ]] && echo TESTNET || echo Mainnet))${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Service: $(_pool_menu_status_line)"
    echo ""
    echo -e "${DIM}  ─── First-Time Setup ────────────────────────────${RESET}"
    echo -e "  ${GREEN}G${RESET}) Guided Full Setup    ${DIM}(runs all setup steps 1→7)${RESET}"
    echo ""
    echo -e "${DIM}  ─── Manual Setup Steps ───────────────────────────${RESET}"
    echo -e "  ${GREEN}1${RESET}) $(_pool_step_mark 1) Install             ${DIM}(nodejs ≥24, npm, sqlite3, systemd, fail2ban)${RESET}"
    echo -e "  ${GREEN}2${RESET}) $(_pool_step_mark 2) Configure           ${DIM}(pool name, domain, fee, stratum port)${RESET}"
    echo -e "  ${GREEN}3${RESET}) $(_pool_step_mark 3) Deploy web files    ${DIM}(frontend → $POOL_WEB_DIR)${RESET}"
    echo -e "  ${GREEN}4${RESET}) $(_pool_step_mark 4) Setup nginx         ${DIM}(vhost + SSL + rate limits)${RESET}"
    echo -e "  ${GREEN}5${RESET}) $(_pool_step_mark 5) Set up wallet       ${DIM}(combined coinbase + payout, Owner+Foreign ${PW_OWNER_PORT})${RESET}"
    echo -e "  ${GREEN}6${RESET}) $(_pool_step_mark 6) Service control     ${DIM}(start / stop — start before creating admin)${RESET}"
    echo -e "  ${GREEN}7${RESET}) $(_pool_step_mark 7) Create admin account ${DIM}(first admin user — needs service running)${RESET}"
    echo ""
    echo -e "${DIM}  ─── Administration ───────────────────────────────${RESET}"
    echo -e "  ${GREEN}8${RESET}) Pool status           ${DIM}(service, port, DB, recent logs)${RESET}"
    echo -e "  ${GREEN}9${RESET}) Deploy new code       ${DIM}(refresh js/html/media from checkout + restart)${RESET}"
    echo -e "  ${GREEN}W${RESET}) Multi-region          ${DIM}(WireGuard server + add regional gateways)${RESET}"
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
            9)     pool_deploy_code || true ;;
            w)     pool_wireguard_menu || true ;;
            b)     pool_backup || true ;;
            c)     pool_cron_schedules || true ;;
            l)     pool_view_logs || true ;;
            s)     ${EDITOR:-nano} "$POOL_CONF" || true ;;
            del)   pool_reset_db || true ;;
            0|q|exit) break ;;
            *)     warn "Invalid option." ; sleep 1 ; continue ;;
        esac

        # Pause so action output stays readable before the menu redraws.
        # Skipped for: l (pager) / s (editor) — they hold their own screen — and
        # the submenus 5/6/c, which self-manage feedback and return on their own
        # 0) Back. Without this, picking 0 inside a submenu would trigger a second,
        # redundant "Press Enter" here even though nothing new was shown.
        case "${choice,,}" in
            l|s|5|6|c|w) ;;
            *) echo ""; echo "Press Enter to continue..."; read -r ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# Z) CLEANUP — remove the public-pool footprint (any mode) for fast rebuild tests
# ═══════════════════════════════════════════════════════════════════════════════
# Mirrors solo_cleanup (07_grin_mining_solo.sh): preview with present/absent
# marks, a master confirm, then per-group confirms — nothing runs until the
# master Y. Removes whatever GRINIUM roles are on this box — brain (single-server
# / Central Hub), regional gateway, and/or any legacy satellite — WITHOUT touching
# anything the node or wallet needs, so an operator can rebuild from scratch quickly.
#
# REMOVED (per-group confirm):  systemd services + units, pool app dir (incl.
#   pool.db + .wallet_pass), gateway app + WireGuard tunnel (+ legacy satellite dir),
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
    # Gateway paths (GW_*) live in the gateway lib — sourcing here is safe and idempotent
    # (constants + function definitions only).
    # shellcheck source=lib/07_lib_gateway.sh
    source "$SCRIPT_DIR/lib/07_lib_gateway.sh"

    # Legacy SATELLITE footprint (role removed in the Model C refactor; its lib is gone).
    # Hardcoded so a box that ran the old satellite can still be cleaned up here.
    local SAT_SERVICE="grin-satellite"
    local SAT_CONF="/opt/grin/conf/grin_satellite.json"
    local SAT_APP_DIR="/opt/grin/satellite"
    local SAT_LOG="/opt/grin/logs/grin-satellite.log"

    local pool_unit="/etc/systemd/system/${POOL_SERVICE}.service"
    local sat_unit="/etc/systemd/system/${SAT_SERVICE}.service"
    local gw_unit="/etc/systemd/system/${GW_SERVICE}.service"
    local cron_backup="/etc/cron.d/${POOL_SERVICE}-backup"
    local cron_vacuum="/etc/cron.d/${POOL_SERVICE}-vacuum"
    local backup_wrapper="/usr/local/bin/grin-pool-backup-${POOL_NET}"
    local logrotate_conf="/etc/logrotate.d/${POOL_SERVICE}"
    local zones_conf="/etc/nginx/conf.d/script07-${POOL_SERVICE}.conf"
    local backup_dir="/opt/grin/backups/${POOL_SERVICE}"
    local f2b_filter="/etc/fail2ban/filter.d/grin-pool-login.conf"
    local f2b_jail="/etc/fail2ban/jail.d/grin-pool.conf"

    echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${RED}  Clean Up Public Mining Pool${RESET}  ${DIM}(rebuild from scratch quickly)${RESET}"
    echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Removes the GRINIUM footprint on this box — brain (single-server / Central"
    echo -e "  Hub), regional gateway, and/or any legacy satellite. The node, your wallet"
    echo -e "  seed, and your backups are ${BOLD}kept${RESET} — confirm each group below."
    echo ""
    echo -e "  ${BOLD}Will be removed${RESET} ${DIM}(if you confirm the group):${RESET}"
    echo -e "    Pool service unit           $(_pool_cleanup_mark "$pool_unit")"
    echo -e "    Gateway service unit        $(_pool_cleanup_mark "$gw_unit")"
    echo -e "    Legacy satellite unit       $(_pool_cleanup_mark "$sat_unit")"
    echo -e "    Pool app + DB               $(_pool_cleanup_mark "$POOL_APP_DIR")"
    echo -e "    Gateway app + wg tunnel     $(_pool_cleanup_mark "$GW_DIR")"
    echo -e "    Legacy satellite app dir    $(_pool_cleanup_mark "$SAT_APP_DIR")"
    echo -e "    Web root + nginx vhost      $(_pool_cleanup_mark "$POOL_NGINX_CONF")"
    echo -e "    Cron / logrotate / wrapper  $(_pool_cleanup_mark "$cron_backup")"
    echo -e "    Pool config (JSON)          $(_pool_cleanup_mark "$POOL_CONF")"
    echo -e "    Gateway config (JSON)       $(_pool_cleanup_mark "$GW_CONF")"
    echo -e "    Legacy satellite config     $(_pool_cleanup_mark "$SAT_CONF")"
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
    echo -ne "${BOLD}1)${RESET} Stop + remove services ($POOL_SERVICE, $SAT_SERVICE, $GW_SERVICE)? [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        for svc in "$POOL_SERVICE" "$SAT_SERVICE" "$GW_SERVICE"; do
            systemctl stop "$svc" 2>/dev/null || true
            systemctl disable "$svc" 2>/dev/null || true
        done
        rm -f "$pool_unit" "$sat_unit" "$gw_unit"
        systemctl daemon-reload 2>/dev/null || true
        success "Services stopped, disabled, units removed."
        log "Cleanup: removed $POOL_SERVICE + $SAT_SERVICE + $GW_SERVICE services"
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

    # 3) Legacy satellite app dir (removed role) — staging + relay failover SQLite
    if [[ -d "$SAT_APP_DIR" ]]; then
        echo -ne "${BOLD}3)${RESET} Remove legacy satellite app + staging DB ($SAT_APP_DIR)? [Y/n]: "
        read -r a || true
        if [[ "${a,,}" != "n" ]]; then
            rm -rf "${SAT_APP_DIR:?}"
            success "Legacy satellite app + staging DB removed."
            log "Cleanup: removed $SAT_APP_DIR"
        fi
        echo ""
    fi

    # 3b) Gateway app dir (edge box) AND/OR the central WireGuard server for THIS network.
    #     Edge: GW_DIR + GW_WG_CONF (wg-grinpool). Central: this script's WG_* (network-aware:
    #     wg-grinpool / wg-grinpool-tn). Bring down + remove whichever is present.
    if [[ -d "$GW_DIR" || -f "$GW_WG_CONF" || -f "$WG_CONF" || -d "$WG_DIR_CONF" ]]; then
        echo -ne "${BOLD}3b)${RESET} Remove gateway app + WireGuard tunnels (edge $GW_WG_IFACE / central $WG_IFACE)? [Y/n]: "
        read -r a || true
        if [[ "${a,,}" != "n" ]]; then
            local ifc
            for ifc in "$GW_WG_IFACE" "$WG_IFACE"; do
                wg-quick down "$ifc" 2>/dev/null || true
                systemctl disable "wg-quick@${ifc}" 2>/dev/null || true
            done
            rm -f "$GW_WG_CONF" "$WG_CONF"
            rm -rf "${GW_DIR:?}" "$WG_DIR_CONF"
            success "Gateway app + WireGuard tunnels removed."
            log "Cleanup: removed $GW_DIR + $GW_WG_CONF + $WG_CONF + $WG_DIR_CONF"
        fi
        echo ""
    fi

    # 4) Web root + nginx vhost + rate-limit zones conf
    echo -ne "${BOLD}4)${RESET} Remove web files + nginx vhost ($(basename "$POOL_NGINX_CONF"))? [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        local conf_name; conf_name=$(basename "$POOL_NGINX_CONF")
        # Also drop the pre-rename legacy vhost (grin-pool / grin-pool-testnet) if present.
        local legacy_name=""; [[ -n "${POOL_NGINX_CONF_LEGACY:-}" ]] && legacy_name=$(basename "$POOL_NGINX_CONF_LEGACY")
        if command -v nginx &>/dev/null && [[ -e "/etc/nginx/sites-enabled/$conf_name" || -f "$POOL_NGINX_CONF" ]]; then
            nginx_disable_site "$conf_name" || true
            [[ -n "$legacy_name" ]] && nginx_disable_site "$legacy_name" || true
            rm -f "$POOL_NGINX_CONF" "$POOL_NGINX_CONF_LEGACY" "$zones_conf"
            nginx_test_reload "after removing $conf_name vhost" || true
        else
            # nginx absent (or only a dangling symlink left) — remove files directly
            rm -f "/etc/nginx/sites-enabled/$conf_name" "$POOL_NGINX_CONF" "$zones_conf"
            [[ -n "$legacy_name" ]] && rm -f "/etc/nginx/sites-enabled/$legacy_name" "$POOL_NGINX_CONF_LEGACY" || true
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

    # 6) JSON configs (pool + satellite + gateway + pre-rename legacy grin_pool.json)
    echo -ne "${BOLD}6)${RESET} Remove configs ($POOL_CONF, $SAT_CONF, $GW_CONF)? [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        rm -f "$POOL_CONF" "$SAT_CONF" "$GW_CONF" "/opt/grin/conf/grin_pool.json"
        success "Configs removed."
        log "Cleanup: removed $POOL_CONF + $SAT_CONF + $GW_CONF (+ legacy grin_pool.json)"
    fi
    echo ""

    # 7) Service logs (pool, satellite, nginx access/error)
    echo -ne "${BOLD}7)${RESET} Remove service logs? [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        rm -f "$POOL_LOG" "$POOL_LOG".* "$SAT_LOG" "$SAT_LOG".* "$GW_LOG" "$GW_LOG".* 2>/dev/null || true
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
# Two deployment directions (Model C) — see docs/generated/script07_design.md §3:
#   singlebox — the pool: brain (API/DB/web/admin/wallet) + a co-located local stratum.
#               Already a full hub, so it accepts regional gateways later with no rebuild.
#   hub       — Central Hub only (brain, no local stratum); all mining is via gateways.
# Regional GATEWAYS are NOT a pool-app role — they run no Node process (HAProxy + WireGuard,
# see lib/07_lib_gateway.sh) and are launched via the `gateway` arg / menu option 2.
# Mode may be passed as $1 (singlebox|hub|gateway) for non-interactive launches.
POOL_MODE=""

# ─── Install-footprint detectors (collision guard) ──────────────────────────────
# Single-server pool and Central Hub share the same "brain" footprint
# ($POOL_CONF + $POOL_SERVICE); a Gateway has its own (grin_gateway.json + grin-gateway).
# Co-locating a brain and a gateway on one box collides on stratum 3333, so we refuse at
# selection time and point the operator at cleanup. pool_satellite_installed detects a
# LEGACY satellite install (role removed in the Model C refactor) so cleanup can still find it.
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
pool_gateway_installed() {
    [[ -f "/opt/grin/conf/grin_gateway.json" ]] && return 0
    systemctl list-unit-files 2>/dev/null | grep -q "^grin-gateway\.service" && return 0
    return 1
}

# Returns 0 if the chosen mode is safe to install on this box; 1 (with guidance)
# if it would collide with an existing install of another kind. The brain
# (singlebox/hub) and a gateway collide on stratum :3333 — one mining role per box.
# (A legacy satellite, if present, also collides and is detected the same way.)
pool_mode_conflict_check() {
    case "$1" in
        singlebox|hub)
            if pool_gateway_installed; then
                echo ""
                warn "A Regional Gateway install was detected on this server:"
                echo -e "    config:  /opt/grin/conf/grin_gateway.json"
                echo -e "    service: grin-gateway"
                echo -e "  ${DIM}Single-server / Central Hub bind stratum :3333, which the Gateway uses.${RESET}"
                echo -e "  ${BOLD}Clean up the Gateway first${RESET} (mode menu → Z) Cleanup), then re-run."
                return 1
            fi
            if pool_satellite_installed; then
                echo ""
                warn "A legacy Satellite install was detected on this server:"
                echo -e "    config:  /opt/grin/conf/grin_satellite.json"
                echo -e "    service: grin-satellite"
                echo -e "  ${DIM}The satellite role was replaced by Regional Gateways (Model C).${RESET}"
                echo -e "  ${BOLD}Clean up the legacy Satellite first${RESET} (mode menu → Z) Cleanup), then re-run."
                return 1
            fi
            ;;
        gateway)
            if pool_brain_installed; then
                echo ""
                warn "An existing pool / Central Hub install was detected on this server:"
                echo -e "    config:  $POOL_CONF"
                echo -e "    service: $POOL_SERVICE"
                echo -e "  ${DIM}A gateway binds stratum :3333, which this install already uses${RESET}"
                echo -e "  ${DIM}(plus node upstream 3416 / Central API 8080) — both on one box collides.${RESET}"
                echo -e "  ${BOLD}Clean up the public pool config first${RESET} (mode menu → Z) Cleanup), then re-run."
                return 1
            fi
            # A legacy satellite would also collide (both bind :3333).
            if pool_satellite_installed; then
                echo ""
                warn "A legacy Satellite install already occupies this box (both bind :3333)."
                echo -e "  ${BOLD}Clean it up first${RESET} (mode menu → Z) Cleanup), then re-run."
                return 1
            fi
            ;;
    esac
    return 0
}

pool_select_mode() {
    local arg="${1:-}"
    case "$arg" in
        singlebox|hub|gateway)
            POOL_MODE="$arg"
            pool_mode_conflict_check "$arg" || POOL_MODE=""
            return
            ;;
    esac

    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Public Mining Pool Deployment Mode — ${POOL_NET_LABEL}${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        if [[ "$POOL_NET" == "testnet" ]]; then
            echo -e "  ${YELLOW}● TESTNET${RESET} ${DIM}— independent install (8090 / tgrin wallet / testnet node).${RESET}"
            echo -e "  ${DIM}  Fast blocks for testing the full pipeline. Needs a testnet grin node.${RESET}"
        else
            echo -e "  ${GREEN}● MAINNET${RESET} ${DIM}— real GRIN (8080 / grin1 wallet / mainnet node). Live funds.${RESET}"
        fi
        echo ""
        echo -e "  ${BOLD}What are you installing?${RESET}"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Pool server      ${DIM}The pool itself — runs everything.${RESET} ${BOLD}Start here.${RESET}"
        echo -e "                     ${DIM}Serves local miners as region \"main\"; accepts${RESET}"
        echo -e "                     ${DIM}regional gateways from other zones later — no rebuild.${RESET}"
        echo ""
        echo -e "  ${GREEN}2${RESET}) Regional gateway ${DIM}A thin stratum forwarder on ANOTHER box: no node,${RESET}"
        echo -e "                     ${DIM}no wallet — tunnels miners to your pool server (Model C).${RESET}"
        echo ""
        echo -e "  ${RED}Z${RESET}) Cleanup public pool  ${DIM}(remove pool/hub/gateway infra · keeps node + wallet + backups)${RESET}"
        echo -e "  ${RED}0${RESET}) Back to mining hub"
        echo ""
        echo -e "  ${DIM}Run a Gateway on a DIFFERENT box from the pool server (they share${RESET}"
        echo -e "  ${DIM}port 3333). Advanced — a mining-less central hub:${RESET}"
        echo -e "  ${DIM}\`bash 07_grin_mining_public_pool.sh hub\`.${RESET}"
        echo ""
        echo -ne "${BOLD}Select: ${RESET}"
        read -r m

        local chosen=""
        case "$m" in
            1) chosen="singlebox" ;;
            2) chosen="gateway" ;;
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
    # Launch args may carry a NETWORK selector (`testnet`, handled globally via POOL_NET)
    # and/or a real deployment-MODE arg (singlebox|hub|gateway). Only a true mode arg means
    # "non-interactive: run that one mode and exit". `testnet` ALONE is NOT a mode — it still
    # shows the interactive mode selector, so 0) Back from a mode menu must return to that
    # selector (one level up), NOT skip it and exit to the mining hub. So derive `arg` from a
    # real mode token only; `testnet`/other tokens leave it empty → interactive + loop-back.
    local arg="" _a
    for _a in "$@"; do
        case "$_a" in
            singlebox|hub|gateway) arg="$_a" ;;
        esac
    done
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
            gateway)
                # shellcheck source=lib/07_lib_gateway.sh
                source "$SCRIPT_DIR/lib/07_lib_gateway.sh"
                pool_gateway_loop
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
