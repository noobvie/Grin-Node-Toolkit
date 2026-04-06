#!/bin/bash
# =============================================================================
# 052_grin_drop.sh — Grin Drop
# =============================================================================
#
#  A configurable GRIN portal with two independently toggleable modes:
#    • Giveaway  — interactive slatepack claim flow, rate-limited
#    • Donation  — 3-tab donation flow (Direct / Slatepack Receive / Invoice)
#
#  Backend: Node.js/Express + grin-wallet HTTP API (Owner v3 ECDH + Foreign)
#  Database: SQLite (better-sqlite3)
#
#  ─── Network Selection ───────────────────────────────────────────────────────
#   1) Testnet  (tGRIN — no monetary value, safe for testing)
#   2) Mainnet  ⚠ sends/receives real GRIN — explicit confirmation required
#   3) Unified Homepage  (aggregated stats for both networks)
#
#  ─── Submenu options (testnet/mainnet) ───────────────────────────────────────
#   1) Setup wallet        (download binary + 5-step init flow)
#   2) Wallet listening    (two tmux sessions: Foreign API + Owner API)
#   3) Install             (Node.js/npm + systemd service)
#   4) Configure           (domain, modes, claim amount, wallet API ports/secrets)
#   5) Deploy web files    (web/052_drop/ → web dir, npm install)
#   6) Setup nginx         (vhost + SSL + path routing /<network>/)
#   7) Start / Stop        (systemd service)
#   8) Drop status         (health, balance, claims)
#   9) Wallet address      (show + update)
#   L) View logs
#   B) Backup              (encrypted archive: DB + config + seed)
#   R) Restore             (decrypt + restore archive)
#   0) Back to network select
#
#  Testnet:  service=grin-drop-test  port=3004  /opt/grin/drop-test/  /var/www/grin-drop-test/
#  Mainnet:  service=grin-drop-main  port=3005  /opt/grin/drop-main/  /var/www/grin-drop-main/
#
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLKIT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GRIN_WALLET_GITHUB_API="https://api.github.com/repos/mimblewimble/grin-wallet/releases/latest"

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# ─── Logging ──────────────────────────────────────────────────────────────────
LOG_DIR="/opt/grin/logs"
LOG_FILE="$LOG_DIR/grin_drop_$(date +%Y%m%d_%H%M%S).log"
mkdir -p "$LOG_DIR" 2>/dev/null || true
log()     { echo -e "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; log "[INFO] $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; log "[OK] $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; log "[WARN] $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; log "[ERROR] $*"; }
die()     { error "$*"; return 1; }
pause()   { echo ""; echo -e "${DIM}Press Enter to continue...${RESET}"; read -r || true; }

# ─── Network-specific variables (set by _set_network) ─────────────────────────
DROP_NETWORK=""
DROP_NET_FLAG=""
DROP_NET_LABEL=""
DROP_WALLET_DIR=""
DROP_WALLET_BIN=""
DROP_PASS=""
DROP_WORD=""
DROP_APP_DIR=""
DROP_WEB_DIR=""
DROP_CONF=""
DROP_DB=""
DROP_SERVICE=""
DROP_PORT=""
DROP_LOG=""
DROP_NGINX_CONF=""
DROP_NGINX_LINK=""
DROP_TMUX_TOR=""    # tmux: wallet listen  (Foreign API)
DROP_TMUX_OWNER=""  # tmux: wallet owner_api (Owner API v3)

# Source dirs (single copy, both networks)
DROP_APP_SRC="$TOOLKIT_ROOT/web/052_drop/server"
DROP_WEB_SRC="$TOOLKIT_ROOT/web/052_drop/public_html"

# ─── Source lib files ─────────────────────────────────────────────────────────
# shellcheck source=lib/052_lib_wallet.sh
source "$SCRIPT_DIR/lib/052_lib_wallet.sh"
# shellcheck source=lib/052_lib_app.sh
source "$SCRIPT_DIR/lib/052_lib_app.sh"
# shellcheck source=lib/052_lib_nginx.sh
source "$SCRIPT_DIR/lib/052_lib_nginx.sh"
# shellcheck source=lib/052_lib_admin.sh
source "$SCRIPT_DIR/lib/052_lib_admin.sh"

# =============================================================================
# NETWORK SELECTION
# =============================================================================

select_network() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 052) GRIN DROP${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    local test_st main_st
    systemctl is-active --quiet "grin-drop-test" 2>/dev/null \
        && test_st="${GREEN}running${RESET}" || test_st="${DIM}not running${RESET}"
    systemctl is-active --quiet "grin-drop-main" 2>/dev/null \
        && main_st="${GREEN}running${RESET}" || main_st="${DIM}not running${RESET}"

    echo -e "  ${GREEN}1${RESET}) Testnet  ${DIM}(tGRIN — no monetary value)  drop: $test_st${RESET}"
    echo -e "  ${YELLOW}2${RESET}) Mainnet  ${RED}⚠ sends/receives real GRIN${RESET}  drop: $main_st${RESET}"
    echo -e "  ${CYAN}3${RESET}) Unified Homepage  ${DIM}(aggregated stats for both networks)${RESET}"
    echo ""
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -ne "${BOLD}Select [1/2/3/0]: ${RESET}"
    local sel
    read -r sel || true
    case "$sel" in
        1) _set_network testnet ;;
        2) _confirm_mainnet || return 1 ;;
        3) _unified_homepage_menu; return 1 ;;
        0) return 1 ;;
        *) warn "Invalid option."; return 1 ;;
    esac
    return 0
}

_confirm_mainnet() {
    clear
    echo -e "\n${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${RED} ⚠  MAINNET — REAL GRIN${RESET}"
    echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Mainnet Grin Drop uses ${BOLD}real GRIN with real monetary value${RESET}."
    echo -e "  ${RED}Mistakes cannot be reversed.${RESET}"
    echo ""
    echo -ne "  Type ${BOLD}MAINNET${RESET} to confirm, or press Enter to cancel: "
    local confirm
    read -r confirm || true
    if [[ "$confirm" != "MAINNET" ]]; then
        info "Cancelled."; return 1
    fi
    _set_network mainnet
    return 0
}

_set_network() {
    DROP_NETWORK="$1"
    if [[ "$DROP_NETWORK" == "mainnet" ]]; then
        DROP_NET_FLAG=""
        DROP_NET_LABEL="MAINNET"
        DROP_WALLET_DIR="/opt/grin/drop-main"
        DROP_WALLET_BIN="/opt/grin/drop-main/grin-wallet"
        DROP_PASS="/opt/grin/drop-main/.temp_main"
        DROP_WORD="/opt/grin/drop-main/.word_main"
        DROP_APP_DIR="/opt/grin/drop-main"
        DROP_WEB_DIR="/var/www/grin-drop-main"
        DROP_CONF="/opt/grin/drop-main/grin_drop_main.conf"
        DROP_DB="/opt/grin/drop-main/drop-main.db"
        DROP_SERVICE="grin-drop-main"
        DROP_PORT="3005"
        DROP_LOG="/opt/grin/drop-main/grin_drop_main.log"
        DROP_NGINX_CONF="/etc/nginx/sites-available/grin-drop-main"
        DROP_NGINX_LINK="/etc/nginx/sites-enabled/grin-drop-main"
        DROP_TMUX_TOR="drop-main-tor"
        DROP_TMUX_OWNER="drop-main-ownerapi"
    else
        DROP_NET_FLAG="--testnet"
        DROP_NET_LABEL="TESTNET"
        DROP_WALLET_DIR="/opt/grin/drop-test"
        DROP_WALLET_BIN="/opt/grin/drop-test/grin-wallet"
        DROP_PASS="/opt/grin/drop-test/.temp_test"
        DROP_WORD="/opt/grin/drop-test/.word_test"
        DROP_APP_DIR="/opt/grin/drop-test"
        DROP_WEB_DIR="/var/www/grin-drop-test"
        DROP_CONF="/opt/grin/drop-test/grin_drop_test.conf"
        DROP_DB="/opt/grin/drop-test/drop-test.db"
        DROP_SERVICE="grin-drop-test"
        DROP_PORT="3004"
        DROP_LOG="/opt/grin/drop-test/grin_drop_test.log"
        DROP_NGINX_CONF="/etc/nginx/sites-available/grin-drop-test"
        DROP_NGINX_LINK="/etc/nginx/sites-enabled/grin-drop-test"
        DROP_TMUX_TOR="drop-test-tor"
        DROP_TMUX_OWNER="drop-test-ownerapi"
    fi
}

_unified_homepage_menu() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN} 052) GRIN DROP — Unified Homepage${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  ${DIM}Serves / → unified homepage, /testnet/ → :3004, /mainnet/ → :3005${RESET}"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Setup nginx  ${DIM}(unified vhost + SSL)${RESET}"
        echo -e "  ${DIM}0) Back${RESET}"
        echo ""
        echo -ne "${BOLD}Select [1/0]: ${RESET}"
        local choice; read -r choice || true
        case "$choice" in
            1) drop_setup_unified_nginx || true ;;
            0) break ;;
            "") continue ;;
        esac
    done
}

# =============================================================================
# CONFIG HELPERS
# =============================================================================

drop_read_conf() {
    local key="$1" default="${2:-}"
    [[ -f "$DROP_CONF" ]] || { echo "$default"; return; }
    python3 - "$DROP_CONF" "$key" "$default" << 'PYEOF' 2>/dev/null || echo "$default"
import json, sys
path, key, default = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    d = json.load(open(path))
    v = d.get(key, default)
    print(str(v).lower() if isinstance(v, bool) else v)
except Exception:
    print(default)
PYEOF
}

drop_write_conf_key() {
    local key="$1" val="$2"
    mkdir -p "$(dirname "$DROP_CONF")"
    python3 - "$key" "$val" "$DROP_CONF" << 'PYEOF'
import json, sys, os
key, val, path = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    d = json.load(open(path)) if os.path.isfile(path) else {}
except Exception:
    d = {}
NUMS  = {"claim_amount_grin","claim_window_hours","service_port","finalize_timeout_min",
          "wallet_foreign_api_port","wallet_owner_api_port","donation_invoice_timeout"}
BOOLS = {"giveaway_enabled","donation_enabled","show_public_stats","maintenance_mode"}
if key in NUMS:
    d[key] = float(val)
elif key in BOOLS:
    d[key] = (val.lower() in ("true","1","yes"))
else:
    d[key] = val
with open(path, "w") as f:
    json.dump(d, f, indent=2)
os.chmod(path, 0o600)
PYEOF
}

drop_ensure_defaults() {
    local defaults=(
        "drop_name:Grin Drop"
        "subdomain:"
        "claim_amount_grin:2.0"
        "claim_window_hours:24"
        "finalize_timeout_min:5"
        "service_port:$DROP_PORT"
        "wallet_address:"
        "wallet_foreign_api_port:$( [[ $DROP_NETWORK == mainnet ]] && echo 3415 || echo 13415)"
        "wallet_owner_api_port:$( [[ $DROP_NETWORK == mainnet ]]  && echo 3420 || echo 13420)"
        "wallet_foreign_secret:${DROP_WALLET_DIR}/wallet_data/.api_secret"
        "wallet_owner_secret:${DROP_WALLET_DIR}/.owner_api_secret"
        "wallet_pass_file:$DROP_PASS"
        "donation_invoice_timeout:30"
        "giveaway_enabled:true"
        "donation_enabled:true"
        "show_public_stats:true"
        "site_description:Claim free GRIN or donate to keep the drop running."
        "og_image_url:"
        "admin_secret_path:"
        "maintenance_mode:false"
        "maintenance_message:We'll be back soon."
        "theme_default:matrix"
        "log_path:$DROP_LOG"
    )
    for pair in "${defaults[@]}"; do
        local k="${pair%%:*}" v="${pair#*:}"
        local existing
        existing=$(drop_read_conf "$k" "__MISSING__")
        [[ "$existing" == "__MISSING__" ]] && drop_write_conf_key "$k" "$v"
    done
}

_patch_toml() {
    local toml="$1" key="$2" val="$3"
    if grep -q "^${key}\s*=" "$toml" 2>/dev/null; then
        sed -i "s|^${key}\s*=.*|${key} = ${val}|" "$toml"
    else
        echo "${key} = ${val}" >> "$toml"
    fi
}

# =============================================================================
# MENU STATUS HEADER
# =============================================================================

drop_menu_status() {
    echo ""
    local giveaway_on; giveaway_on=$(drop_read_conf "giveaway_enabled" "true")
    local donation_on;  donation_on=$(drop_read_conf "donation_enabled" "true")
    local g_lbl d_lbl
    [[ "$giveaway_on" == "true" ]] && g_lbl="${GREEN}● ON${RESET}" || g_lbl="${DIM}○ off${RESET}"
    [[ "$donation_on"  == "true" ]] && d_lbl="${GREEN}● ON${RESET}" || d_lbl="${DIM}○ off${RESET}"
    echo -e "  Mode: giveaway $g_lbl  |  donation $d_lbl"
    echo ""

    # Grin node
    local node_port=13413
    [[ "$DROP_NETWORK" == "mainnet" ]] && node_port=3413
    if ss -tlnp 2>/dev/null | grep -q ":${node_port} "; then
        echo -e "  ${BOLD}Grin node${RESET}  : ${GREEN}● running${RESET}  ${DIM}(port $node_port)${RESET}"
    else
        echo -e "  ${BOLD}Grin node${RESET}  : ${RED}✗ not running${RESET}  ${YELLOW}⚠ run Script 01${RESET}"
    fi

    # Wallet sessions
    local tor_st owner_st
    tmux has-session -t "$DROP_TMUX_TOR"   2>/dev/null && tor_st="${GREEN}● listening${RESET}"   || tor_st="${YELLOW}stopped${RESET}"
    tmux has-session -t "$DROP_TMUX_OWNER" 2>/dev/null && owner_st="${GREEN}● listening${RESET}" || owner_st="${YELLOW}stopped${RESET}"
    if [[ ! -x "$DROP_WALLET_BIN" ]]; then
        echo -e "  ${BOLD}Wallet${RESET}     : ${RED}✗ not installed${RESET}  ${DIM}run option 1${RESET}"
    elif [[ ! -f "$DROP_WALLET_DIR/grin-wallet.toml" ]]; then
        echo -e "  ${BOLD}Wallet${RESET}     : ${RED}✗ not initialized${RESET}  ${DIM}run option 1${RESET}"
    else
        echo -e "  ${BOLD}Wallet TOR${RESET} : $tor_st  ${DIM}($DROP_TMUX_TOR)${RESET}"
        echo -e "  ${BOLD}Wallet OWN${RESET} : $owner_st  ${DIM}($DROP_TMUX_OWNER)${RESET}"
    fi

    # Steps 3–7
    [[ -f "/etc/systemd/system/${DROP_SERVICE}.service" ]] \
        && echo -e "  ${BOLD}3 Install${RESET}  : ${GREEN}OK${RESET}" \
        || echo -e "  ${BOLD}3 Install${RESET}  : ${DIM}pending${RESET}"

    local addr; addr=$(drop_read_conf "wallet_address" "")
    local domain; domain=$(drop_read_conf "subdomain" "")
    if [[ -n "$addr" && -n "$domain" ]]; then
        echo -e "  ${BOLD}4 Configure${RESET}: ${GREEN}OK${RESET}  ${DIM}($domain)${RESET}"
    else
        echo -e "  ${BOLD}4 Configure${RESET}: ${DIM}pending${RESET}"
    fi

    [[ -d "$DROP_WEB_DIR" ]] \
        && echo -e "  ${BOLD}5 Web files${RESET}: ${GREEN}deployed${RESET}  ${DIM}($DROP_WEB_DIR)${RESET}" \
        || echo -e "  ${BOLD}5 Web files${RESET}: ${DIM}not deployed${RESET}"

    [[ -f "$DROP_NGINX_CONF" ]] \
        && echo -e "  ${BOLD}6 nginx${RESET}    : ${GREEN}configured${RESET}" \
        || echo -e "  ${BOLD}6 nginx${RESET}    : ${DIM}not configured${RESET}"

    if systemctl is-active --quiet "$DROP_SERVICE" 2>/dev/null; then
        echo -e "  ${BOLD}7 Service${RESET}  : ${GREEN}● running${RESET}  ${DIM}(https://${domain:-<domain>}/${DROP_NETWORK}/)${RESET}"
    elif systemctl is-enabled --quiet "$DROP_SERVICE" 2>/dev/null; then
        echo -e "  ${BOLD}7 Service${RESET}  : ${YELLOW}stopped${RESET}"
    else
        echo -e "  ${BOLD}7 Service${RESET}  : ${DIM}not running${RESET}"
    fi
    echo ""
}

# =============================================================================
# DROP MENU
# =============================================================================

drop_menu() {
    while true; do
        clear
        if [[ "$DROP_NETWORK" == "mainnet" ]]; then
            echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
            echo -e "${BOLD}${RED} 052) GRIN DROP  [MAINNET — REAL GRIN]${RESET}"
            echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        else
            echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
            echo -e "${BOLD}${CYAN} 052) GRIN DROP  [TESTNET]${RESET}"
            echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        fi
        drop_menu_status

        echo -e "${DIM}  ─── First-time setup (run in order) ─────────────${RESET}"
        echo -e "  ${GREEN}1${RESET}) Setup wallet          ${DIM}(download + 5-step init flow)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Wallet listening      ${DIM}(TOR: $DROP_TMUX_TOR + Owner: $DROP_TMUX_OWNER)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Install               ${DIM}(Node.js + npm + systemd service)${RESET}"
        echo -e "  ${GREEN}4${RESET}) Configure             ${DIM}(domain, modes, wallet API ports/secrets)${RESET}"
        echo -e "  ${GREEN}5${RESET}) Deploy web files      ${DIM}(copy to $DROP_WEB_DIR)${RESET}"
        echo -e "  ${GREEN}6${RESET}) Setup nginx           ${DIM}(vhost + SSL + /${DROP_NETWORK}/ path routing)${RESET}"
        echo -e "  ${GREEN}7${RESET}) Start / Stop service  ${DIM}(systemd $DROP_SERVICE)${RESET}"
        echo ""
        echo -e "${DIM}  ─── Info & maintenance ───────────────────────────${RESET}"
        echo -e "  ${CYAN}8${RESET}) Drop status           ${DIM}(health, balance, claims)${RESET}"
        echo -e "  ${CYAN}9${RESET}) Wallet address        ${DIM}(show + update)${RESET}"
        echo -e "  ${CYAN}L${RESET}) View logs             ${DIM}(activity / journal / nginx)${RESET}"
        echo ""
        echo -e "${DIM}  ─── Admin tasks ──────────────────────────────────${RESET}"
        echo -e "  ${YELLOW}B${RESET}) Backup                ${DIM}(encrypted: DB + config + seed)${RESET}"
        echo -e "  ${YELLOW}R${RESET}) Restore               ${DIM}(decrypt + restore backup)${RESET}"
        echo ""
        echo -e "  ${DIM}↩  Press Enter to refresh${RESET}"
        echo -e "  ${RED}0${RESET}) Back to network select"
        echo ""
        echo -ne "${BOLD}Select [1-9 / L / B / R / 0]: ${RESET}"
        read -r choice || true

        case "${choice,,}" in
            1) drop_setup_wallet    || true ;;
            2) drop_wallet_listener || true ;;
            3) drop_install         || true ;;
            4) drop_configure       || true ;;
            5) drop_deploy_web      || true ;;
            6) drop_setup_nginx     || true ;;
            7) drop_service_control || true ;;
            8) drop_status_screen   || true ;;
            9) drop_wallet_address  || true ;;
            l) drop_view_logs       || true ;;
            b) drop_backup          || true ;;
            r) drop_restore         || true ;;
            0) break ;;
            "") continue ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# =============================================================================
# MAIN
# =============================================================================

main() {
    while true; do
        if select_network; then
            drop_menu
        else
            break
        fi
    done
}

main "$@"
