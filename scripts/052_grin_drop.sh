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
#  Database: SQLite (node:sqlite — built-in, no native compilation)
#
#  ─── Top-level menu ──────────────────────────────────────────────────────────
#   1) Create / Update domain  (nginx vhost + SSL — shared by both networks)
#   2) Testnet                 (tGRIN — no monetary value, safe for testing)
#   3) Mainnet                 (⚠ sends/receives real GRIN — explicit confirmation)
#   4) Unified Homepage        (aggregated stats view for both networks)
#   5) Remove current domain   (delete nginx config + SSL)
#   6) Google Analytics        (GA4 tracking — optional)
#   7) Turnstile               (Cloudflare bot protection — optional)
#   B) Backup                  (encrypted archive: testnet + mainnet)
#   R) Restore                 (decrypt + restore backup)
#   D) Delete                  (wipe everything: services, wallets, config, nginx — testing)
#   0) Back to main menu
#
#  ─── Network submenu (testnet/mainnet) ───────────────────────────────────────
#   1) Setup wallet        (download binary + 5-step init flow)
#   2) Wallet listening    (two tmux sessions: Foreign API + Owner API)
#   3) Install             (Node.js/npm + systemd service)
#   4) Configure           (modes, claim amount, wallet API ports/secrets)
#   5) Deploy web files    (web/052_drop/ → /opt/grin/<net>/public_html/)
#   6) Start / Stop        (systemd service)
#   7) Drop status         (health, balance, claims)
#   8) Wallet address      (show + update)
#   L) View logs
#   0) Back to network select
#
#  Testnet:  service=grin-drop-test  port=3004  /opt/grin/drop-test/  public_html/ inside
#  Mainnet:  service=grin-drop-main  port=3005  /opt/grin/drop-main/  public_html/ inside
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
# NOTE: die uses return 1 — with set -euo pipefail this aborts the script when
# unchecked; in OR-chains (cmd || die "…") it exits the current function only.
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
DROP_CONF=""
DROP_DB=""
DROP_SERVICE=""
DROP_PORT=""
DROP_LOG=""
DROP_TMUX_TOR=""    # tmux: wallet listen  (Foreign API)
DROP_TMUX_OWNER=""  # tmux: wallet owner_api (Owner API v3)
DROP_NODE_PORT=""   # Grin node Foreign API port (3413 mainnet / 13413 testnet)
DROP_TOR_PORT=""    # wallet Foreign API port  (3415 mainnet / 13415 testnet)
DROP_OWNER_PORT=""  # wallet Owner API port    (3420 mainnet / 13420 testnet)

# Shared (cross-network) config — stores unified domain + ssl_type
DROP_SHARED_CONF="/opt/grin/conf/drop_shared.conf"
mkdir -p "/opt/grin/conf"

# Source dirs (single copy, both networks)
DROP_APP_SRC="$TOOLKIT_ROOT/web/052_drop/server"
DROP_WEB_SRC="$TOOLKIT_ROOT/web/052_drop/public_html"

# ─── Source lib files ─────────────────────────────────────────────────────────
# Shared nginx helpers — sourced FIRST so 052_lib_nginx.sh can use them.
# Required: 052_lib_nginx.sh calls nginx_ensure_rate_limit_zones to write the
# drop_home/drop_api/drop_test/drop_main zones. Without it, the vhost references
# undefined zones and nginx fails with "zero size shared memory zone".
# shellcheck source=lib/nginx_shared_helpers.sh
source "$SCRIPT_DIR/lib/nginx_shared_helpers.sh"
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

    local _dom; _dom=$(_shared_read "subdomain" "")
    if [[ -n "$_dom" ]]; then
        echo -e "  ${DIM}Domain: ${GREEN}$_dom${RESET}"
    else
        echo -e "  ${DIM}Domain: ${YELLOW}not configured${RESET}  ${DIM}(run option 1)${RESET}"
    fi
    local _ga4; _ga4=$(_shared_read "ga4_id" "")
    if [[ -n "$_ga4" ]]; then
        echo -e "  ${DIM}GA4   : ${GREEN}$_ga4${RESET}"
    else
        echo -e "  ${DIM}GA4   : ${DIM}not configured${RESET}"
    fi
    echo ""

    local test_st main_st
    systemctl is-active --quiet "grin-drop-test" 2>/dev/null \
        && test_st="${GREEN}running${RESET}" || test_st="${DIM}not running${RESET}"
    systemctl is-active --quiet "grin-drop-main" 2>/dev/null \
        && main_st="${GREEN}running${RESET}" || main_st="${DIM}not running${RESET}"

    echo -e "${DIM}  ─── Domain & nginx ───────────────────────────────${RESET}"
    echo -e "  ${GREEN}1${RESET}) Create / Update domain  ${DIM}(nginx + SSL for unified drop)${RESET}"
    echo -e "  ${GREEN}5${RESET}) Remove current domain   ${DIM}(delete nginx config + SSL)${RESET}"
    echo ""
    echo -e "${DIM}  ─── Networks ─────────────────────────────────────${RESET}"
    echo -e "  ${GREEN}2${RESET}) Testnet  ${DIM}(tGRIN — no monetary value)  drop: $test_st${RESET}"
    echo -e "  ${YELLOW}3${RESET}) Mainnet  ${RED}⚠ sends/receives real GRIN${RESET}  drop: $main_st${RESET}"
    echo -e "  ${CYAN}4${RESET}) Unified Homepage  ${DIM}(aggregated stats for both networks)${RESET}"
    echo -e "  ${CYAN}7${RESET}) Turnstile          ${DIM}(Cloudflare bot protection — optional)${RESET}"
    echo -e "  ${CYAN}6${RESET}) Google Analytics  ${DIM}(GA4 tracking — optional)${RESET}"
    echo ""
    echo -e "${DIM}  ─── Admin (both networks) ────────────────────────${RESET}"
    echo -e "  ${YELLOW}B${RESET}) Backup   ${DIM}(encrypted archive: testnet + mainnet)${RESET}"
    echo -e "  ${YELLOW}R${RESET}) Restore  ${DIM}(decrypt + restore backup)${RESET}"
    echo -e "  ${RED}D${RESET}) Delete   ${DIM}(wipe all drop data — services, wallets, config, nginx)${RESET}"
    echo ""
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -ne "${BOLD}Select [1-7 / B / R / D / 0]: ${RESET}"
    local sel
    read -r sel || true
    case "${sel,,}" in
        1) drop_create_domain; return 1 ;;
        2) _set_network testnet ;;
        3) _set_network mainnet ;;
        4) _unified_homepage_menu; return 1 ;;
        5) drop_remove_domain; return 1 ;;
        6) drop_ga4_menu; return 1 ;;
        7) drop_turnstile_menu; return 1 ;;
        b) drop_backup; return 1 ;;
        r) drop_restore; return 1 ;;
        d) drop_nuke; return 1 ;;
        0) return 2 ;;
        *) warn "Invalid option."; return 1 ;;
    esac
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
        DROP_CONF="/opt/grin/drop-main/grin_drop_main.conf"
        DROP_DB="/opt/grin/drop-main/drop-main.db"
        DROP_SERVICE="grin-drop-main"
        DROP_PORT="3005"
        DROP_LOG="/opt/grin/drop-main/grin_drop_main.log"
        DROP_TMUX_TOR="drop-main-tor"
        DROP_TMUX_OWNER="drop-main-ownerapi"
        DROP_NODE_PORT="3413"
        DROP_TOR_PORT="3415"
        DROP_OWNER_PORT="3420"
    else
        DROP_NET_FLAG="--testnet"
        DROP_NET_LABEL="TESTNET"
        DROP_WALLET_DIR="/opt/grin/drop-test"
        DROP_WALLET_BIN="/opt/grin/drop-test/grin-wallet"
        DROP_PASS="/opt/grin/drop-test/.temp_test"
        DROP_WORD="/opt/grin/drop-test/.word_test"
        DROP_APP_DIR="/opt/grin/drop-test"
        DROP_CONF="/opt/grin/drop-test/grin_drop_test.conf"
        DROP_DB="/opt/grin/drop-test/drop-test.db"
        DROP_SERVICE="grin-drop-test"
        DROP_PORT="3004"
        DROP_LOG="/opt/grin/drop-test/grin_drop_test.log"
        DROP_TMUX_TOR="drop-test-tor"
        DROP_TMUX_OWNER="drop-test-ownerapi"
        DROP_NODE_PORT="13413"
        DROP_TOR_PORT="13415"
        DROP_OWNER_PORT="13420"
    fi
}

_unified_homepage_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 052) GRIN DROP — Unified Homepage${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    local _dom; _dom=$(_shared_read "subdomain" "")
    if [[ -n "$_dom" ]]; then
        echo -e "  ${DIM}Homepage : ${GREEN}https://$_dom/${RESET}"
        echo -e "  ${DIM}Testnet  : https://$_dom/testnet/${RESET}"
        echo -e "  ${DIM}Mainnet  : https://$_dom/mainnet/${RESET}"
    else
        echo -e "  ${YELLOW}No domain configured.${RESET}"
        echo -e "  ${DIM}Run option 1 (Create / Update domain) to set up nginx + SSL.${RESET}"
    fi
    echo ""
    echo -ne "${BOLD}Press Enter to return...${RESET}"
    read -r || true
}

drop_ga4_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 052) GRIN DROP — Google Analytics (GA4)${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    local cur_id; cur_id=$(_shared_read "ga4_id" "")
    if [[ -n "$cur_id" ]]; then
        echo -e "  Current GA4 ID : ${GREEN}$cur_id${RESET}"
    else
        echo -e "  Current GA4 ID : ${DIM}not configured${RESET}"
    fi
    echo ""
    echo -e "  ${DIM}Get your ID from: analytics.google.com → Admin → Data Streams → Measurement ID${RESET}"
    echo -e "  ${DIM}Format: G-XXXXXXXXXX${RESET}"
    echo -e "  ${DIM}Leave blank to disable. Type 0 to cancel.${RESET}"
    echo ""
    echo -ne "${BOLD}Enter GA4 Measurement ID: ${RESET}"
    local new_id; read -r new_id || true
    new_id="${new_id:-}"

    [[ "$new_id" == "0" ]] && { info "Cancelled."; pause; return; }

    if [[ -z "$new_id" ]]; then
        _shared_write "ga4_id" ""
        success "GA4 tracking disabled."
    elif [[ "$new_id" =~ ^G-[A-Z0-9]+$ ]]; then
        _shared_write "ga4_id" "$new_id"
        success "GA4 ID saved: $new_id"
    else
        warn "Invalid format — must be G-XXXXXXXXXX (uppercase letters and digits after G-)"
        pause; return
    fi

    local dom; dom=$(_shared_read "subdomain" "")
    if [[ -n "$dom" ]]; then
        echo ""
        info "Re-applying nginx config to activate change..."
        _drop_nginx_refresh
    else
        echo ""
        info "No domain configured yet — nginx will pick up this setting when you run option 1."
    fi
    pause
}

drop_turnstile_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 052) GRIN DROP — Cloudflare Turnstile${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    # ── Gate: domain + at least one network must be deployed ──────────────────
    local dom; dom=$(_shared_read "subdomain" "")
    local ssl; ssl=$(_shared_read "ssl_type"  "")
    local test_conf="/opt/grin/drop-test/grin_drop_test.conf"
    local main_conf="/opt/grin/drop-main/grin_drop_main.conf"
    local has_network=false
    [[ -f "$test_conf" || -f "$main_conf" ]] && has_network=true

    if [[ -z "$dom" || -z "$ssl" ]]; then
        echo -e "  ${YELLOW}⚠  No domain configured yet — run option 1 (Create / Update domain) first${RESET}"
        echo -e "  ${DIM}   Keys will be saved now and applied when you set up the domain.${RESET}"
        echo ""
    fi
    if ! $has_network; then
        echo -e "  ${YELLOW}⚠  No network deployed yet — run option 2 (Testnet) or 3 (Mainnet) first${RESET}"
        echo -e "  ${DIM}   Keys will be saved now and applied when you deploy a network.${RESET}"
        echo ""
    fi

    # ── Current status ────────────────────────────────────────────────────────
    local cur_site; cur_site=$(_shared_read "turnstile_site_key" "")
    local cur_sec;  cur_sec=$(_shared_read  "turnstile_secret"   "")
    if [[ -n "$cur_site" ]]; then
        echo -e "  Site Key : ${GREEN}$cur_site${RESET}"
        echo -e "  Secret   : ${GREEN}configured${RESET}"
    else
        echo -e "  Site Key : ${DIM}not configured${RESET}"
        echo -e "  Secret   : ${DIM}not configured${RESET}"
    fi
    echo ""
    echo -e "  ${DIM}Get your keys: Cloudflare Dashboard → Turnstile → Add Site${RESET}"
    echo -e "  ${DIM}Leave blank to disable. Type 0 to cancel.${RESET}"
    echo ""

    echo -ne "${BOLD}Site Key (public — starts with 0x): ${RESET}"
    local new_site; read -r new_site || true
    [[ "$new_site" == "0" ]] && { info "Cancelled."; pause; return; }

    if [[ -z "$new_site" ]]; then
        # Disable Turnstile
        _shared_write "turnstile_site_key" ""
        _shared_write "turnstile_secret"   ""
        [[ -f "$test_conf" ]] && DROP_CONF="$test_conf" drop_write_conf_key "turnstile_secret" ""
        [[ -f "$main_conf" ]] && DROP_CONF="$main_conf" drop_write_conf_key "turnstile_secret" ""
        success "Turnstile disabled."
    else
        if [[ "$new_site" != 0x* ]]; then
            warn "Invalid Site Key — Cloudflare Turnstile site keys start with 0x"
            pause; return
        fi
        echo -ne "${BOLD}Secret Key (private — keep this safe): ${RESET}"
        local new_sec; read -r -s new_sec || true; echo ""
        [[ "$new_sec" == "0" ]] && { info "Cancelled."; pause; return; }
        if [[ -z "$new_sec" ]]; then
            warn "Secret Key cannot be empty when enabling Turnstile."
            pause; return
        fi
        _shared_write "turnstile_site_key" "$new_site"
        _shared_write "turnstile_secret"   "$new_sec"
        [[ -f "$test_conf" ]] && DROP_CONF="$test_conf" drop_write_conf_key "turnstile_secret" "$new_sec"
        [[ -f "$main_conf" ]] && DROP_CONF="$main_conf" drop_write_conf_key "turnstile_secret" "$new_sec"
        success "Turnstile configured."
    fi

    # Reload nginx so sub_filter picks up the new site key (only if domain is set up)
    if [[ -n "$dom" && -n "$ssl" ]]; then
        echo ""
        info "Re-applying nginx config..."
        _drop_nginx_refresh
    else
        info "Keys saved — nginx will pick them up when you run option 1 (Create / Update domain)."
    fi

    # Restart running services so Node.js reloads config with new secret
    local restarted=false
    if systemctl is-active --quiet "grin-drop-test" 2>/dev/null; then
        systemctl restart "grin-drop-test" && info "grin-drop-test restarted." || true
        restarted=true
    fi
    if systemctl is-active --quiet "grin-drop-main" 2>/dev/null; then
        systemctl restart "grin-drop-main" && info "grin-drop-main restarted." || true
        restarted=true
    fi
    $restarted || info "No running services to restart."

    pause
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
    if isinstance(v, bool):
        print(str(v).lower())
    elif isinstance(v, float) and v == int(v):
        print(int(v))
    else:
        print(v)
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
FLOATS = {"claim_grin_per_tx"}
INTS   = {"claim_cooldown_hours","service_port","slatepack_expire_min",
          "wallet_foreign_api_port","wallet_owner_api_port","donation_invoice_timeout",
          "global_daily_claims_cap","global_hourly_claims_cap","low_balance_alert_grin","wallet_cleanup_hours"}
BOOLS  = {"giveaway_enabled","donation_enabled","show_public_stats","maintenance_mode"}
if key in FLOATS:
    d[key] = float(val)
elif key in INTS:
    d[key] = int(float(val))
elif key in BOOLS:
    d[key] = (val.lower() in ("true","1","yes"))
else:
    d[key] = val
with open(path, "w") as f:
    json.dump(d, f, indent=2)
os.chmod(path, 0o600)
PYEOF
    # Ensure the grin service user can always read the conf file
    id grin &>/dev/null && chown grin:grin "$DROP_CONF" 2>/dev/null || true
}

drop_ensure_defaults() {
    # Network-specific defaults
    local net_label drop_name_default global_daily_cap_default global_hourly_cap_default claim_grin_default theme_default
    if [[ "$DROP_NETWORK" == "mainnet" ]]; then
        net_label="mainnet"
        drop_name_default="Grin Drop"
        global_daily_cap_default="2000"   # site-wide ceiling; mainnet wallet balance is the real constraint
        global_hourly_cap_default="100"
        claim_grin_default="0.008"         # max claim amount on mainnet
        theme_default="win98"
    else
        net_label="testnet"
        drop_name_default="Grin Drop [TESTNET]"
        global_daily_cap_default="2000"
        global_hourly_cap_default="100"
        claim_grin_default="1.0"          # max claim amount on testnet
        theme_default="matrix"
    fi

    local defaults=(
        "network:$net_label"
        "drop_name:$drop_name_default"
        "theme_default:$theme_default"
        # Giveaway
        "giveaway_enabled:true"
        "claim_grin_per_tx:$claim_grin_default"
        "claim_cooldown_hours:24"
        "slatepack_expire_min:30"
        "global_daily_claims_cap:$global_daily_cap_default"
        "global_hourly_claims_cap:$global_hourly_cap_default"
        # Donation
        "donation_enabled:true"
        "donation_invoice_timeout:30"
        # Wallet
        "wallet_address:"
        "wallet_foreign_api_port:$DROP_TOR_PORT"
        "wallet_owner_api_port:$DROP_OWNER_PORT"
        "wallet_foreign_secret:${DROP_WALLET_DIR}/.foreign_api_secret"
        "wallet_owner_secret:${DROP_WALLET_DIR}/.owner_api_secret"
        "wallet_pass_file:$DROP_PASS"
        # Service
        "service_port:$DROP_PORT"
        # Public stats
        "show_public_stats:true"
        # Maintenance
        "maintenance_mode:false"
        "maintenance_message:We'll be back soon."
        # Alerts
        "low_balance_alert_grin:-1"
        # Wallet cleanup
        "wallet_cleanup_hours:1"
        # Anonymous claim IP hashing — unique per installation, generated once
        "ip_salt:$(openssl rand -hex 32)"
        # Logging
        "log_path:$DROP_LOG"
    )
    for pair in "${defaults[@]}"; do
        [[ "$pair" =~ ^# ]] && continue
        local k="${pair%%:*}" v="${pair#*:}"
        local existing
        existing=$(drop_read_conf "$k" "__MISSING__")
        [[ "$existing" == "__MISSING__" ]] && drop_write_conf_key "$k" "$v"
    done
}

# =============================================================================
# SHARED CONFIG HELPERS (cross-network: domain, ssl_type)
# =============================================================================

_shared_read() {
    local key="$1" default="${2:-}"
    [[ -f "$DROP_SHARED_CONF" ]] || { echo "$default"; return; }
    python3 - "$DROP_SHARED_CONF" "$key" "$default" << 'PYEOF' 2>/dev/null || echo "$default"
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

_shared_write() {
    local key="$1" val="$2"
    mkdir -p "$(dirname "$DROP_SHARED_CONF")"
    python3 - "$key" "$val" "$DROP_SHARED_CONF" << 'PYEOF'
import json, sys, os
key, val, path = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    d = json.load(open(path)) if os.path.isfile(path) else {}
except Exception:
    d = {}
d[key] = val
with open(path, "w") as f:
    json.dump(d, f, indent=2)
os.chmod(path, 0o600)
PYEOF
}

_patch_toml() {
    # Patch a key in a TOML file.
    # Handles three cases:
    #   1. Key exists uncommented       → sed replace in-place
    #   2. Key is commented out (# key) → uncomment + set value in-place
    #                                     (preserves position inside correct [section])
    #   3. Key absent entirely          → append to end of file
    local toml="$1" key="$2" val="$3"
    if grep -q "^${key}\s*=" "$toml" 2>/dev/null; then
        sed -i "s|^${key}\s*=.*|${key} = ${val}|" "$toml"
    elif grep -q "^#\s*${key}\s*=" "$toml" 2>/dev/null; then
        sed -i "s|^#\s*${key}\s*=.*|${key} = ${val}|" "$toml"
    else
        echo "${key} = ${val}" >> "$toml"
    fi
}

_patch_toml_in_section() {
    # Like _patch_toml but guarantees the key lands inside [section].
    # Removes ALL occurrences (commented or not), then inserts the key
    # immediately after the [section] header — safe even when a previous
    # run placed the key in the wrong section (e.g. [tor] instead of [wallet]).
    local toml="$1" section="$2" key="$3" val="$4"
    sed -i "/^#\?\s*${key}\s*=/d" "$toml"
    sed -i "/^\[${section}\]/a ${key} = ${val}" "$toml"
}

# =============================================================================
# MENU STATUS HEADER
# =============================================================================

drop_menu_status() {
    echo ""
    local _dom; _dom=$(_shared_read "subdomain" "")
    if [[ -n "$_dom" ]]; then
        echo -e "  ${DIM}Domain: ${GREEN}$_dom${RESET}  ${DIM}(https://$_dom/${DROP_NETWORK}/)${RESET}"
    else
        echo -e "  ${DIM}Domain: ${YELLOW}not configured${RESET}  ${DIM}(set from main menu → option 1)${RESET}"
    fi

    local giveaway_on; giveaway_on=$(drop_read_conf "giveaway_enabled" "true")
    local donation_on;  donation_on=$(drop_read_conf "donation_enabled" "true")
    local g_lbl d_lbl
    [[ "$giveaway_on" == "true" ]] && g_lbl="${GREEN}● ON${RESET}" || g_lbl="${DIM}○ off${RESET}"
    [[ "$donation_on"  == "true" ]] && d_lbl="${GREEN}● ON${RESET}" || d_lbl="${DIM}○ off${RESET}"
    echo -e "  Mode: giveaway $g_lbl  |  donation $d_lbl"
    echo ""

    # Grin node
    if ss -tlnp 2>/dev/null | grep -q ":${DROP_NODE_PORT} "; then
        echo -e "  ${BOLD}Grin node${RESET}  : ${GREEN}● running${RESET}  ${DIM}(port $DROP_NODE_PORT)${RESET}"
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

    # Steps 3–6
    [[ -f "/etc/systemd/system/${DROP_SERVICE}.service" ]] \
        && echo -e "  ${BOLD}3 Install${RESET}  : ${GREEN}OK${RESET}" \
        || echo -e "  ${BOLD}3 Install${RESET}  : ${DIM}pending${RESET}"

    local addr; addr=$(drop_read_conf "wallet_address" "")
    [[ -n "$addr" ]] \
        && echo -e "  ${BOLD}4 Configure${RESET}: ${GREEN}OK${RESET}" \
        || echo -e "  ${BOLD}4 Configure${RESET}: ${DIM}pending${RESET}"

    local pub_dir="$DROP_APP_DIR/public_html"
    [[ -d "$pub_dir" ]] \
        && echo -e "  ${BOLD}5 Web files${RESET}: ${GREEN}deployed${RESET}  ${DIM}($pub_dir)${RESET}" \
        || echo -e "  ${BOLD}5 Web files${RESET}: ${DIM}not deployed${RESET}"

    if systemctl is-active --quiet "$DROP_SERVICE" 2>/dev/null; then
        echo -e "  ${BOLD}6 Service${RESET}  : ${GREEN}● running${RESET}  ${DIM}(https://${_dom:-<domain>}/${DROP_NETWORK}/)${RESET}"
    elif systemctl is-enabled --quiet "$DROP_SERVICE" 2>/dev/null; then
        echo -e "  ${BOLD}6 Service${RESET}  : ${YELLOW}stopped${RESET}"
    else
        echo -e "  ${BOLD}6 Service${RESET}  : ${DIM}not running${RESET}"
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
        echo -e "  ${GREEN}4${RESET}) Configure             ${DIM}(modes, wallet API ports/secrets)${RESET}"
        echo -e "  ${GREEN}5${RESET}) Deploy web files      ${DIM}(copy to $DROP_APP_DIR/public_html/)${RESET}"
        echo -e "  ${GREEN}6${RESET}) Start / Stop service  ${DIM}(systemd $DROP_SERVICE)${RESET}"
        echo ""
        echo -e "${DIM}  ─── Info & maintenance ───────────────────────────${RESET}"
        echo -e "  ${CYAN}7${RESET}) Drop status           ${DIM}(health, balance, claims)${RESET}"
        echo -e "  ${CYAN}8${RESET}) Wallet address        ${DIM}(show + update)${RESET}"
        echo -e "  ${CYAN}L${RESET}) View logs             ${DIM}(activity / journal / nginx)${RESET}"
        echo ""
        echo -e "  ${DIM}↩  Press Enter to refresh${RESET}"
        echo -e "  ${RED}0${RESET}) Back to network select"
        echo ""
        echo -ne "${BOLD}Select [1-8 / L / 0]: ${RESET}"
        read -r choice || true

        case "${choice,,}" in
            1) drop_setup_wallet    || true ;;
            2) drop_wallet_listener || true ;;
            3) drop_install         || true ;;
            4) drop_configure       || true ;;
            5) drop_deploy_web      || true ;;
            6) drop_service_control || true ;;
            7) drop_status_screen   || true ;;
            8) drop_wallet_address  || true ;;
            l) drop_view_logs       || true ;;
            0) break ;;
            "") continue ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# =============================================================================
# DELETE — wipe all drop data (option D)
# =============================================================================

drop_nuke() {
    clear
    echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${RED} 052) GRIN DROP — D) Delete Everything${RESET}"
    echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  ${RED}This will permanently remove:${RESET}"
    echo ""

    local domain; domain=$(_shared_read "subdomain" "")

    # ── Systemd services ──
    echo -e "  ${DIM}● Systemd services${RESET}"
    echo -e "    grin-drop-test   grin-drop-main"

    # ── Tmux sessions ──
    echo -e "  ${DIM}● Tmux sessions${RESET}"
    echo -e "    drop-test-tor   drop-test-ownerapi   drop-test-scan"
    echo -e "    drop-main-tor   drop-main-ownerapi   drop-main-scan"

    # ── Cron entries ──
    echo -e "  ${DIM}● Cron entries (reboot auto-start + watchdog)${RESET}"
    local _cron_test _cron_main
    crontab -l 2>/dev/null | grep -q "grin-drop-test-reboot\|052_watchdog_test" \
        && _cron_test="${GREEN}set${RESET}" || _cron_test="${DIM}none${RESET}"
    crontab -l 2>/dev/null | grep -q "grin-drop-main-reboot\|052_watchdog_main" \
        && _cron_main="${GREEN}set${RESET}" || _cron_main="${DIM}none${RESET}"
    echo -e "    testnet: $_cron_test   mainnet: $_cron_main"

    # ── Filesystem ──
    echo -e "  ${DIM}● App directories (wallets, DB, config, logs)${RESET}"
    echo -e "    /opt/grin/drop-test/"
    echo -e "    /opt/grin/drop-main/"
    echo -e "    /opt/grin/conf/drop_shared.conf"
    echo -e "    /opt/grin/logs/grin_drop_*.log"

    # ── Nginx ──
    if [[ -n "$domain" ]]; then
        echo -e "  ${DIM}● Nginx vhost + logrotate${RESET}"
        echo -e "    /etc/nginx/sites-available/$domain"
        echo -e "    /etc/nginx/sites-enabled/$domain"
        echo -e "    /etc/logrotate.d/nginx-grin-drop"
        echo -e "    /var/www/grin-drop-home/"
    fi

    echo ""
    echo -e "  ${RED}Wallets and all GRIN inside them will be lost forever.${RESET}"
    echo -e "  ${DIM}Tip: run option B) Backup first if you need to keep wallet seeds.${RESET}"
    echo ""
    echo -ne "  Type ${BOLD}DELETE ALL${RESET} to confirm, or press Enter to cancel: "
    local confirm; read -r confirm || true
    if [[ "$confirm" != "DELETE ALL" ]]; then
        info "Cancelled — nothing was removed."; pause; return
    fi
    echo ""

    # ── Stop + disable systemd services ──────────────────────────────────────
    for svc in grin-drop-test grin-drop-main; do
        if systemctl is-active --quiet "$svc" 2>/dev/null; then
            info "Stopping $svc ..."
            systemctl stop "$svc" 2>/dev/null || true
        fi
        if systemctl is-enabled --quiet "$svc" 2>/dev/null; then
            systemctl disable "$svc" 2>/dev/null || true
        fi
        local unit="/etc/systemd/system/${svc}.service"
        if [[ -f "$unit" ]]; then
            rm -f "$unit"
            info "Removed $unit"
        fi
    done
    systemctl daemon-reload 2>/dev/null || true

    # ── Kill tmux sessions (wallet + scan) ───────────────────────────────────
    for sess in drop-test-tor drop-test-ownerapi drop-test-scan \
                drop-main-tor drop-main-ownerapi drop-main-scan; do
        if tmux has-session -t "$sess" 2>/dev/null; then
            tmux kill-session -t "$sess" 2>/dev/null || true
            info "Killed tmux session: $sess"
        fi
    done

    # ── Kill remaining wallet processes (scan, orphaned — PPID=1 survivors) ───
    for _wallet_bin in "/opt/grin/drop-test/grin-wallet" "/opt/grin/drop-main/grin-wallet"; do
        pkill -9 -f "$_wallet_bin" 2>/dev/null \
            && info "Killed remaining processes: $_wallet_bin" || true
    done

    # ── Remove cron entries (@reboot auto-start + watchdog) ───────────────────
    local cur_cron; cur_cron=$(crontab -l 2>/dev/null || true)
    if [[ -n "$cur_cron" ]]; then
        local new_cron
        new_cron=$(echo "$cur_cron" \
            | grep -v "# grin-drop-test-reboot" \
            | grep -v "# grin-drop-main-reboot" \
            | grep -v "052_watchdog_test" \
            | grep -v "052_watchdog_main" \
            || true)
        if [[ "$new_cron" != "$cur_cron" ]]; then
            echo "$new_cron" | crontab - 2>/dev/null || true
            info "Removed drop cron entries (reboot + watchdog)."
        fi
    fi

    # ── Remove nginx vhost ────────────────────────────────────────────────────
    if [[ -n "$domain" ]]; then
        rm -f "/etc/nginx/sites-enabled/$domain"  && info "Removed nginx symlink: $domain"
        rm -f "/etc/nginx/sites-available/$domain" && info "Removed nginx config:  $domain"
        rm -f "/etc/logrotate.d/nginx-grin-drop"   && info "Removed logrotate config"
        if command -v nginx &>/dev/null && systemctl is-active --quiet nginx 2>/dev/null; then
            nginx -t 2>/dev/null && systemctl reload nginx && info "nginx reloaded."
        fi
    fi

    # ── Remove /var/www drop files (always, regardless of domain) ────────────
    for _d in /var/www/grin-drop*; do
        [[ -d "$_d" ]] && rm -rf "$_d" && info "Removed $_d"
    done

    # ── Remove app + wallet directories ──────────────────────────────────────
    for dir in /opt/grin/drop-test /opt/grin/drop-main; do
        if [[ -d "$dir" ]]; then
            rm -rf "$dir" && info "Removed $dir/"
        fi
    done

    # ── Remove shared config + drop logs ─────────────────────────────────────
    rm -f "$DROP_SHARED_CONF" && info "Removed $DROP_SHARED_CONF"
    rm -f "$LOG_DIR"/grin_drop_*.log 2>/dev/null || true
    info "Removed drop log files from $LOG_DIR/"

    echo ""
    success "All Grin Drop data removed."
    log "[drop_nuke] full teardown completed domain=${domain:-none}"
    pause
}

# =============================================================================
# MAIN
# =============================================================================

main() {
    while true; do
        local rc=0
        select_network || rc=$?
        case $rc in
            0) drop_menu || true ;;  # network selected → enter submenu
            2) break ;;              # user pressed 0   → exit script
        esac
        # rc=1 (admin op completed) → loop back to select_network
    done
}

main "$@"
