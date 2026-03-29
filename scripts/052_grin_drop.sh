#!/bin/bash
# =============================================================================
# 052_grin_drop.sh — Grin Drop
# =============================================================================
#
#  A configurable GRIN portal with two independently toggleable modes:
#    • Giveaway  — slatepack claim flow, rate-limited (give out GRIN)
#    • Donation  — show wallet address + QR so visitors can send GRIN
#
#  Works on testnet (tGRIN, safe default) or mainnet (real GRIN — explicit
#  confirmation required).
#
#  ─── Network Selection ───────────────────────────────────────────────────────
#   1) Testnet  (tGRIN — no monetary value, safe for testing)
#   2) Mainnet  ⚠ sends/receives real GRIN — confirmation required
#
#  ─── Menu ────────────────────────────────────────────────────────────────────
#   1) Setup wallet        (download binary + init + patch toml)
#   2) Wallet listening    (start tmux session for wallet listener)
#   3) Install             (Python + Flask venv + systemd service)
#   4) Configure           (domain, wallet address, modes, claim amount)
#   5) Deploy web files    (web/052_drop/ → web dir)
#   6) Setup nginx         (vhost + SSL: Let's Encrypt or Cloudflare Origin Cert)
#   7) Start / Stop        (systemd service)
#   8) Drop status         (balance, claims today/total, donations)
#   9) Wallet address      (show + update)
#   L) View logs
#   DEL) Reset database    (triple-confirm wipe)
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

# ─── Network-specific constants (set by select_network) ───────────────────────
DROP_NETWORK=""
DROP_NET_FLAG=""
DROP_NET_LABEL=""
DROP_WALLET_DIR=""
DROP_WALLET_BIN=""
DROP_PASS=""
DROP_APP_DIR=""
DROP_WEB_DIR=""
DROP_CONF=""
DROP_DB=""
DROP_SERVICE=""
DROP_PORT=""
DROP_LOG=""
DROP_NGINX_CONF=""
DROP_NGINX_LINK=""
DROP_TMUX=""

# Source dirs (single copy, both networks)
DROP_APP_SRC="$TOOLKIT_ROOT/web/052_drop/app"
DROP_WEB_SRC="$TOOLKIT_ROOT/web/052_drop/public_html"

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
    echo ""
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -ne "${BOLD}Select [1/2/0]: ${RESET}"
    local sel
    read -r sel || true
    case "$sel" in
        1) _set_network testnet ;;
        2) _confirm_mainnet || return 1 ;;
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
        DROP_WALLET_DIR="/opt/grin/drop-main/wallet"
        DROP_WALLET_BIN="/opt/grin/drop-main/wallet/grin-wallet-drop-bin"
        DROP_PASS="/opt/grin/drop-main/.wallet_pass"
        DROP_APP_DIR="/opt/grin/drop-main"
        DROP_WEB_DIR="/var/www/grin-drop-main"
        DROP_CONF="/opt/grin/drop-main/grin_drop.conf"
        DROP_DB="/opt/grin/drop-main/drop.db"
        DROP_SERVICE="grin-drop-main"
        DROP_PORT="3005"
        DROP_LOG="/opt/grin/drop-main/drop-activity.log"
        DROP_NGINX_CONF="/etc/nginx/sites-available/grin-drop-main"
        DROP_NGINX_LINK="/etc/nginx/sites-enabled/grin-drop-main"
        DROP_TMUX="grin-drop-mainnet"
    else
        DROP_NET_FLAG="--testnet"
        DROP_NET_LABEL="TESTNET"
        DROP_WALLET_DIR="/opt/grin/drop-test/wallet"
        DROP_WALLET_BIN="/opt/grin/drop-test/wallet/grin-wallet-drop-bin"
        DROP_PASS="/opt/grin/drop-test/.wallet_pass"
        DROP_APP_DIR="/opt/grin/drop-test"
        DROP_WEB_DIR="/var/www/grin-drop-test"
        DROP_CONF="/opt/grin/drop-test/grin_drop.conf"
        DROP_DB="/opt/grin/drop-test/drop.db"
        DROP_SERVICE="grin-drop-test"
        DROP_PORT="3004"
        DROP_LOG="/opt/grin/drop-test/drop-activity.log"
        DROP_NGINX_CONF="/etc/nginx/sites-available/grin-drop-test"
        DROP_NGINX_LINK="/etc/nginx/sites-enabled/grin-drop-test"
        DROP_TMUX="grin-drop-testnet"
    fi
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
    print(d.get(key, default))
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
NUMS = {"claim_amount_grin","claim_window_hours","wallet_port","service_port","finalize_timeout_min"}
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
        "wallet_dir:$DROP_WALLET_DIR"
        "wallet_port:$DROP_PORT"
        "service_port:$DROP_PORT"
        "finalize_timeout_min:5"
        "wallet_address:"
        "giveaway_enabled:true"
        "donation_enabled:true"
        "show_public_stats:true"
        "site_description:Claim free GRIN or donate to keep the drop running."
        "og_image_url:"
        "admin_secret_path:"
        "admin_htuser:admin"
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
    if grep -q "^${key}\s*=" "$toml"; then
        sed -i "s|^${key}\s*=.*|${key} = ${val}|" "$toml"
    else
        echo "${key} = ${val}" >> "$toml"
    fi
}

# =============================================================================
# STATUS (menu header)
# =============================================================================

drop_menu_status() {
    echo ""
    # Mode indicators
    local giveaway_on donation_on
    giveaway_on=$(drop_read_conf "giveaway_enabled" "true")
    donation_on=$(drop_read_conf "donation_enabled" "true")
    local g_lbl d_lbl
    [[ "$giveaway_on" == "True" || "$giveaway_on" == "true" ]] \
        && g_lbl="${GREEN}● ON${RESET}" || g_lbl="${DIM}○ off${RESET}"
    [[ "$donation_on" == "True" || "$donation_on" == "true" ]] \
        && d_lbl="${GREEN}● ON${RESET}" || d_lbl="${DIM}○ off${RESET}"
    echo -e "  Mode: giveaway $g_lbl  |  donation $d_lbl"
    echo ""

    # Testnet node
    local node_port=13413
    [[ "$DROP_NETWORK" == "mainnet" ]] && node_port=3413
    if ss -tlnp 2>/dev/null | grep -q ":${node_port} "; then
        echo -e "  ${BOLD}Grin node${RESET}  : ${GREEN}● running${RESET}  ${DIM}(port $node_port)${RESET}"
    else
        echo -e "  ${BOLD}Grin node${RESET}  : ${RED}✗ not running${RESET}  ${YELLOW}⚠ run Script 01${RESET}"
    fi

    # Wallet listener
    if [[ ! -x "$DROP_WALLET_BIN" ]]; then
        echo -e "  ${BOLD}Wallet${RESET}     : ${RED}✗ not installed${RESET}  ${DIM}⚠ run option 1${RESET}"
    elif [[ ! -f "$DROP_WALLET_DIR/grin-wallet.toml" ]]; then
        echo -e "  ${BOLD}Wallet${RESET}     : ${RED}✗ not initialized${RESET}  ${DIM}⚠ run option 1${RESET}"
    elif tmux has-session -t "$DROP_TMUX" 2>/dev/null; then
        echo -e "  ${BOLD}Wallet${RESET}     : ${GREEN}● listening${RESET}  ${DIM}(tmux: $DROP_TMUX)${RESET}"
    else
        echo -e "  ${BOLD}Wallet${RESET}     : ${YELLOW}not listening${RESET}  ${DIM}⚠ run option 2${RESET}"
    fi

    # 3 Install
    [[ -f "/etc/systemd/system/${DROP_SERVICE}.service" ]] \
        && echo -e "  ${BOLD}3 Install${RESET}  : ${GREEN}OK${RESET}" \
        || echo -e "  ${BOLD}3 Install${RESET}  : ${DIM}pending${RESET}"

    # 4 Configure
    local addr; addr=$(drop_read_conf "wallet_address" "")
    local domain; domain=$(drop_read_conf "subdomain" "")
    if [[ -n "$addr" && -n "$domain" ]]; then
        echo -e "  ${BOLD}4 Configure${RESET}: ${GREEN}OK${RESET}  ${DIM}($domain)${RESET}"
    else
        echo -e "  ${BOLD}4 Configure${RESET}: ${DIM}pending${RESET}"
    fi

    # 5 Web files
    [[ -d "$DROP_WEB_DIR" ]] \
        && echo -e "  ${BOLD}5 Web files${RESET}: ${GREEN}deployed${RESET}  ${DIM}($DROP_WEB_DIR)${RESET}" \
        || echo -e "  ${BOLD}5 Web files${RESET}: ${DIM}not deployed${RESET}"

    # 6 nginx
    [[ -f "$DROP_NGINX_CONF" ]] \
        && echo -e "  ${BOLD}6 nginx${RESET}    : ${GREEN}configured${RESET}" \
        || echo -e "  ${BOLD}6 nginx${RESET}    : ${DIM}not configured${RESET}"

    # 7 Service
    if systemctl is-active --quiet "$DROP_SERVICE" 2>/dev/null; then
        echo -e "  ${BOLD}7 Service${RESET}  : ${GREEN}● running${RESET}  ${DIM}(https://${domain:-<domain>})${RESET}"
    elif systemctl is-enabled --quiet "$DROP_SERVICE" 2>/dev/null; then
        echo -e "  ${BOLD}7 Service${RESET}  : ${YELLOW}stopped${RESET}"
    else
        echo -e "  ${BOLD}7 Service${RESET}  : ${DIM}not running${RESET}"
    fi
    echo ""
}

# =============================================================================
# OPTION 1 — Setup wallet (download + init)
# =============================================================================

drop_setup_wallet() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — 1) Setup Wallet ──${RESET}\n"
    echo -e "  ${DIM}Downloads grin-wallet binary, initializes wallet, patches node API secret.${RESET}\n"

    info "Querying GitHub for latest grin-wallet release..."
    local release_json
    release_json=$(curl -fsSL --max-time 30 "$GRIN_WALLET_GITHUB_API") \
        || { die "Failed to reach GitHub API. Check internet connection."; pause; return; }

    local version download_url
    version=$(echo "$release_json" | jq -r '.tag_name')
    download_url=$(echo "$release_json" \
        | jq -r '.assets[] | select(.name | test("linux-x86_64\\.tar\\.gz$"; "i")) | .browser_download_url' \
        | head -1)

    if [[ -z "$download_url" || "$download_url" == "null" ]]; then
        die "No linux-x86_64 tar.gz asset found in release '$version'."; pause; return
    fi

    info "Version       : $version"
    info "Install target: $DROP_WALLET_BIN"
    echo ""

    local tmp_tar="/tmp/grin_drop_wallet_$$.tar.gz"
    local tmp_dir="/tmp/grin_drop_wallet_extract_$$"
    mkdir -p "$tmp_dir" "$DROP_WALLET_DIR"

    info "Downloading..."
    wget -c --progress=bar:force -O "$tmp_tar" "$download_url" \
        || { die "Download failed."; rm -rf "$tmp_tar" "$tmp_dir"; pause; return; }

    info "Extracting..."
    tar -xzf "$tmp_tar" -C "$tmp_dir" \
        || { die "Failed to extract."; rm -rf "$tmp_tar" "$tmp_dir"; pause; return; }
    rm -f "$tmp_tar"

    local wallet_bin_src
    wallet_bin_src=$(find "$tmp_dir" -type f -name "grin-wallet" | head -1)
    if [[ -z "$wallet_bin_src" ]]; then
        die "Could not locate 'grin-wallet' binary in archive."; rm -rf "$tmp_dir"; pause; return
    fi

    install -m 755 "$wallet_bin_src" "$DROP_WALLET_BIN"
    rm -rf "$tmp_dir"
    success "grin-wallet $version installed to $DROP_WALLET_BIN"

    # ── Init ──────────────────────────────────────────────────────────────────
    if [[ -f "$DROP_WALLET_DIR/grin-wallet.toml" ]]; then
        warn "Wallet already initialized at: $DROP_WALLET_DIR/grin-wallet.toml"
        echo -ne "Re-initialize? This will overwrite existing wallet data! [y/N/0]: "
        read -r reinit || true
        [[ "$reinit" == "0" ]] && return
        [[ "${reinit,,}" != "y" ]] && info "Cancelled." && return
    fi

    echo ""
    local wallet_pass wallet_pass2
    while true; do
        read -rs -p "  Enter wallet password (min 1 char): " wallet_pass; echo ""
        if [[ -z "$wallet_pass" ]]; then
            warn "Password cannot be empty. Try again."; continue
        fi
        read -rs -p "  Confirm wallet password: " wallet_pass2; echo ""
        if [[ "$wallet_pass" != "$wallet_pass2" ]]; then
            error "Passwords do not match. Try again."; unset wallet_pass2; continue
        fi
        break
    done
    echo ""

    local seed_file="$DROP_APP_DIR/seed-drop.txt"
    info "Initializing drop wallet ($DROP_NET_FLAG) — write down the seed phrase!"
    echo -e "  ${DIM}Seed phrase will be saved to $seed_file${RESET}\n"

    local tmp_init="/tmp/grin_drop_init_$$"
    mkdir -p "$DROP_APP_DIR"
    cd "$DROP_WALLET_DIR" && "$DROP_WALLET_BIN" \
        $DROP_NET_FLAG -p "$wallet_pass" init -h \
        2>&1 | tee "$tmp_init"
    local rc=${PIPESTATUS[0]}
    echo ""

    if [[ $rc -ne 0 || ! -f "$DROP_WALLET_DIR/grin-wallet.toml" ]]; then
        warn "Init may have failed (exit code $rc). Check output above."
        rm -f "$tmp_init"; unset wallet_pass wallet_pass2; pause; return
    fi

    tail -6 "$tmp_init" > "$seed_file"
    rm -f "$tmp_init"
    chmod 600 "$seed_file"
    success "Seed phrase saved to $seed_file (mode 600)"

    # ── Save password ─────────────────────────────────────────────────────────
    mkdir -p "$(dirname "$DROP_PASS")"
    echo "$wallet_pass" > "$DROP_PASS"
    chmod 600 "$DROP_PASS"
    id grin &>/dev/null && chown grin:grin "$DROP_PASS" 2>/dev/null || true
    unset wallet_pass wallet_pass2
    success "Wallet password saved to $DROP_PASS"

    # ── Patch grin-wallet.toml ────────────────────────────────────────────────
    local _toml="$DROP_WALLET_DIR/grin-wallet.toml"
    local _node_dir="" _instances_conf="/opt/grin/conf/grin_instances_location.conf"
    if [[ -f "$_instances_conf" ]]; then
        # shellcheck source=/dev/null
        source "$_instances_conf" 2>/dev/null
        if [[ "$DROP_NETWORK" == "testnet" ]]; then
            _node_dir="${PRUNETEST_GRIN_DIR:-}"
        else
            _node_dir="${PRUNEMAIN_GRIN_DIR:-${FULLMAIN_GRIN_DIR:-}}"
        fi
    fi
    if [[ -z "$_node_dir" || ! -d "$_node_dir" ]]; then
        _node_dir="/opt/grin/node/$( [[ "$DROP_NETWORK" == "testnet" ]] && echo testnet-prune || echo mainnet-prune )"
    fi
    if [[ -f "$_node_dir/.foreign_api_secret" ]]; then
        _patch_toml "$_toml" "node_api_secret_path" "\"$_node_dir/.foreign_api_secret\""
        info "node_api_secret_path → $_node_dir/.foreign_api_secret"
    else
        warn "No .foreign_api_secret at $_node_dir — add node_api_secret_path manually if needed."
    fi

    # Disable Tor listener — drop uses HTTP only (localhost)
    _patch_toml "$_toml" "use_tor_listener" "false"
    info "use_tor_listener → false  (drop uses HTTP only)"

    # ── Harden permissions ────────────────────────────────────────────────────
    chown -R grin:grin "$DROP_WALLET_DIR" 2>/dev/null || true
    chmod 700 "$DROP_WALLET_DIR"

    drop_ensure_defaults
    success "Drop wallet setup complete."
    log "[drop_setup_wallet] network=$DROP_NETWORK version=$version"
    pause
}

# =============================================================================
# OPTION 2 — Wallet listener
# =============================================================================

drop_start_listener() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — 2) Wallet Listener ──${RESET}\n"

    if [[ ! -x "$DROP_WALLET_BIN" ]]; then
        warn "Wallet binary not found — run option 1 first."; pause; return
    fi
    if [[ ! -f "$DROP_WALLET_DIR/grin-wallet.toml" ]]; then
        warn "Wallet not initialized — run option 1 first."; pause; return
    fi
    if ! command -v tmux &>/dev/null; then
        warn "tmux not installed. Run: apt-get install tmux"; pause; return
    fi

    if tmux has-session -t "$DROP_TMUX" 2>/dev/null; then
        warn "Existing tmux session '$DROP_TMUX' found."
        echo -ne "Kill it and restart? [Y/n/0]: "
        read -r rc || true
        [[ "$rc" == "0" ]] && info "Keeping existing session. Attach: tmux attach -t $DROP_TMUX" && return
        if [[ "${rc,,}" != "n" ]]; then
            tmux kill-session -t "$DROP_TMUX"
            success "Existing session stopped."
        else
            info "Keeping existing session. Attach: tmux attach -t $DROP_TMUX"
            return
        fi
    fi

    local wallet_pass=""
    if [[ -f "$DROP_PASS" ]]; then
        wallet_pass=$(cat "$DROP_PASS")
        info "Using saved wallet password from $DROP_PASS"
    else
        read -rs -p "  Enter wallet password: " wallet_pass; echo ""
        if [[ -z "$wallet_pass" ]]; then
            warn "No password entered. Cancelled."; return
        fi
    fi

    info "Starting wallet listener in tmux: $DROP_TMUX"
    if id grin &>/dev/null; then
        tmux new-session -d -s "$DROP_TMUX" -c "$DROP_WALLET_DIR" \
            "su -s /bin/bash -c \"'$DROP_WALLET_BIN' $DROP_NET_FLAG --top_level_dir '$DROP_WALLET_DIR' -p '$wallet_pass' listen\" grin; echo ''; echo 'Listener exited. Press Enter to close.'; read"
    else
        warn "User 'grin' not found — running as current user."
        tmux new-session -d -s "$DROP_TMUX" -c "$DROP_WALLET_DIR" \
            "bash -c \"'$DROP_WALLET_BIN' $DROP_NET_FLAG --top_level_dir '$DROP_WALLET_DIR' -p '$wallet_pass' listen; echo ''; echo 'Listener exited. Press Enter to close.'; read\""
    fi
    unset wallet_pass

    sleep 2
    if tmux has-session -t "$DROP_TMUX" 2>/dev/null; then
        success "Wallet listener started: $DROP_TMUX"
        info "View  : tmux attach -t $DROP_TMUX"
        info "Detach: Ctrl+B then D"
    else
        warn "tmux session did not persist — wallet may have exited immediately."
    fi
    log "[drop_start_listener] network=$DROP_NETWORK session=$DROP_TMUX"
    pause
}

# =============================================================================
# OPTION 3 — Install (Python venv + systemd)
# =============================================================================

drop_install() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — 3) Install ──${RESET}\n"
    echo -e "  ${DIM}Installs python3, Flask venv, copies app files, creates systemd service.${RESET}\n"

    if ! command -v python3 &>/dev/null; then
        info "python3 not found. Installing..."
        apt-get install -y python3 python3-pip python3-venv \
            || { die "apt-get failed. Run as root."; pause; return; }
    fi
    success "python3 $(python3 --version 2>&1 | awk '{print $2}') found."

    mkdir -p "$DROP_APP_DIR"

    if [[ -d "$DROP_APP_SRC" ]]; then
        info "Copying app files from $DROP_APP_SRC ..."
        cp -r "$DROP_APP_SRC"/. "$DROP_APP_DIR/"
    else
        warn "Source dir not found: $DROP_APP_SRC"
        warn "Ensure the Grin Node Toolkit is complete (web/052_drop/app/)."; pause; return
    fi

    info "Creating Python virtualenv at $DROP_APP_DIR/venv ..."
    if ! python3 -m venv "$DROP_APP_DIR/venv" 2>/dev/null; then
        local _pyver; _pyver=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
        local _venv_pkg="python${_pyver}-venv"
        info "venv failed — installing: $_venv_pkg"
        apt-get install -y "$_venv_pkg" python3-pip \
            || { die "Failed to install $_venv_pkg."; pause; return; }
        python3 -m venv "$DROP_APP_DIR/venv" \
            || { die "venv creation failed."; pause; return; }
    fi

    info "Installing Python requirements ..."
    "$DROP_APP_DIR/venv/bin/pip" install --quiet \
        -r "$DROP_APP_DIR/requirements.txt" \
        || { die "pip install failed."; pause; return; }

    id grin &>/dev/null && chown -R grin:grin "$DROP_APP_DIR" 2>/dev/null || true
    chmod 750 "$DROP_APP_DIR"

    drop_ensure_defaults

    # Create log file
    touch "$DROP_LOG"
    id grin &>/dev/null && chown grin:grin "$DROP_LOG" 2>/dev/null || true

    # Install logrotate
    cat > "/etc/logrotate.d/${DROP_SERVICE}" << LOGROTATE
$DROP_LOG {
    daily
    rotate 10
    size 20M
    compress
    delaycompress
    missingok
    notifempty
    postrotate
        systemctl reload $DROP_SERVICE 2>/dev/null || true
    endscript
}
LOGROTATE
    success "logrotate config written: /etc/logrotate.d/${DROP_SERVICE}"

    # Create systemd service
    local run_user="grin"
    id grin &>/dev/null || run_user="root"

    cat > "/etc/systemd/system/${DROP_SERVICE}.service" << SYSTEMD
[Unit]
Description=Grin Drop [$DROP_NET_LABEL]
After=network.target

[Service]
Type=simple
User=$run_user
WorkingDirectory=$DROP_APP_DIR
Environment="DROP_CONF=$DROP_CONF"
Environment="DROP_DB=$DROP_DB"
Environment="DROP_WALLET_PASS=$DROP_PASS"
ExecStart=$DROP_APP_DIR/venv/bin/python $DROP_APP_DIR/app_drop.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SYSTEMD

    systemctl daemon-reload
    success "systemd service created: $DROP_SERVICE"
    success "Installation complete."
    log "[drop_install] network=$DROP_NETWORK"
    pause
}

# =============================================================================
# OPTION 4 — Configure
# =============================================================================

drop_configure() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — 4) Configure ──${RESET}\n"
    echo -e "  ${DIM}Press Enter to keep current value.${RESET}\n"

    drop_ensure_defaults

    local val

    echo -ne "Drop name        [$(drop_read_conf drop_name 'Grin Drop')]: "
    read -r val || true
    [[ -n "$val" ]] && drop_write_conf_key "drop_name" "$val"

    echo -ne "Subdomain        [$(drop_read_conf subdomain '')]: "
    read -r val || true
    [[ -n "$val" ]] && drop_write_conf_key "subdomain" "$val"

    # ── Mode toggles ──────────────────────────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}Mode toggles:${RESET}"
    local giveaway_cur; giveaway_cur=$(drop_read_conf "giveaway_enabled" "true")
    local donation_cur;  donation_cur=$(drop_read_conf "donation_enabled" "true")
    echo -e "  Giveaway (give GRIN via slatepack claim flow):"
    echo -e "    Current: $giveaway_cur"
    echo -ne "  Enable giveaway? [true/false/Enter to keep]: "
    read -r val || true
    [[ "$val" == "true" || "$val" == "false" ]] && drop_write_conf_key "giveaway_enabled" "$val"

    echo -e "  Donation (show wallet address + QR for receiving GRIN):"
    echo -e "    Current: $donation_cur"
    echo -ne "  Enable donation? [true/false/Enter to keep]: "
    read -r val || true
    [[ "$val" == "true" || "$val" == "false" ]] && drop_write_conf_key "donation_enabled" "$val"

    # ── Giveaway settings ─────────────────────────────────────────────────────
    echo ""
    echo -ne "Claim amount     [$(drop_read_conf claim_amount_grin '2.0') GRIN]: "
    read -r val || true
    [[ -n "$val" ]] && drop_write_conf_key "claim_amount_grin" "$val"

    echo -ne "Claim window     [$(drop_read_conf claim_window_hours '24') hours]: "
    read -r val || true
    [[ -n "$val" ]] && drop_write_conf_key "claim_window_hours" "$val"

    # ── Wallet address ────────────────────────────────────────────────────────
    local current_addr; current_addr=$(drop_read_conf "wallet_address" "")
    echo ""
    local auto_addr=""
    local addr_prefix="grin1"
    [[ "$DROP_NETWORK" == "testnet" ]] && addr_prefix="tgrin1"

    if [[ -x "$DROP_WALLET_BIN" && -f "$DROP_WALLET_DIR/grin-wallet.toml" ]]; then
        info "Fetching wallet address from $DROP_WALLET_BIN ..."
        local _pass=""
        [[ -f "$DROP_PASS" ]] && _pass=$(cat "$DROP_PASS")
        if [[ -n "$_pass" ]]; then
            local _addr_out
            _addr_out=$("$DROP_WALLET_BIN" $DROP_NET_FLAG --top_level_dir "$DROP_WALLET_DIR" \
                -p "$_pass" address 2>&1) || true
            auto_addr=$(echo "$_addr_out" | grep -oP "${addr_prefix}[a-z0-9]+" | head -1)
        fi
        unset _pass
    fi

    if [[ -n "$auto_addr" ]]; then
        success "Address detected: $auto_addr"
        echo -ne "Wallet address   [${auto_addr}] (Enter to accept): "
        read -r val || true
        drop_write_conf_key "wallet_address" "${val:-$auto_addr}"
        success "Wallet address saved: ${val:-$auto_addr}"
    else
        warn "Could not fetch wallet address automatically."
        echo -e "  ${YELLOW}Make sure wallet listener is running (option 2), then re-run Configure.${RESET}"
        echo -ne "Wallet address   [${current_addr:-not set}]: "
        read -r val || true
        if [[ "$val" == "0" ]]; then
            return
        elif [[ -n "$val" ]]; then
            drop_write_conf_key "wallet_address" "$val"
            success "Wallet address saved."
        fi
    fi

    # ── Wallet password ───────────────────────────────────────────────────────
    echo ""
    echo -e "  ${DIM}Wallet password is stored in $DROP_PASS (mode 600).${RESET}"
    echo -ne "Wallet password  [Enter to skip/keep]: "
    read -rs val || true
    echo ""
    if [[ -n "$val" ]]; then
        mkdir -p "$(dirname "$DROP_PASS")"
        echo "$val" > "$DROP_PASS"
        chmod 600 "$DROP_PASS"
        id grin &>/dev/null && chown grin:grin "$DROP_PASS" 2>/dev/null || true
        success "Wallet password saved to $DROP_PASS"
    fi

    # ── Admin panel ───────────────────────────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}Admin panel:${RESET}"

    # Read/generate admin_secret_path
    local cur_ap; cur_ap=$(drop_read_conf "admin_secret_path" "")
    local _rnd; _rnd=$(tr -dc 'a-z0-9' < /dev/urandom | head -c 10)

    if [[ -z "$cur_ap" ]]; then
        echo -e "  ${DIM}Admin URL path — choose your own or generate a random one.${RESET}"
        echo -e "  ${DIM}Example: mywallet2025  →  https://domain/mywallet2025/${RESET}"
        echo -ne "  Admin path [Enter for random ${BOLD}$_rnd${RESET}]: "
        read -r val || true
        if [[ -n "$val" ]]; then
            # Sanitise: lowercase alphanumeric + hyphens only
            cur_ap=$(echo "$val" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')
            [[ -z "$cur_ap" ]] && cur_ap="$_rnd"
        else
            cur_ap="$_rnd"
        fi
        drop_write_conf_key "admin_secret_path" "$cur_ap"
        success "Admin path set: /$cur_ap/"
    else
        info "Current admin path: /$cur_ap/"
        echo -e "  ${DIM}1) Keep current   2) Enter new   3) Generate random${RESET}"
        echo -ne "  Choice [1/2/3]: "
        read -r val || true
        case "$val" in
            2)
                echo -ne "  New admin path: "
                read -r val || true
                local new_ap; new_ap=$(echo "$val" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')
                if [[ -n "$new_ap" ]]; then
                    cur_ap="$new_ap"
                    drop_write_conf_key "admin_secret_path" "$cur_ap"
                    success "Admin path updated: /$cur_ap/"
                    warn "Re-run option 6 (nginx) to apply the new path."
                else
                    warn "Invalid input — keeping current path."
                fi
                ;;
            3)
                cur_ap="$_rnd"
                drop_write_conf_key "admin_secret_path" "$cur_ap"
                success "Admin path regenerated: /$cur_ap/"
                warn "Re-run option 6 (nginx) to apply the new path."
                ;;
            *) info "Admin path unchanged: /$cur_ap/" ;;
        esac
    fi

    # Admin htpasswd
    local htpasswd_file="/etc/nginx/.htpasswd-grin-drop-${DROP_NETWORK}"
    echo -ne "Admin username  [$(drop_read_conf admin_htuser 'admin')]: "
    read -r val || true
    [[ -n "$val" ]] && drop_write_conf_key "admin_htuser" "$val"
    local admin_user; admin_user=$(drop_read_conf "admin_htuser" "admin")

    echo -ne "Admin password  (Enter to skip if already set): "
    read -rs val || true
    echo ""
    if [[ -n "$val" ]]; then
        local hashed; hashed=$(openssl passwd -apr1 "$val" 2>/dev/null) \
            || hashed=$(python3 -c "import crypt; print(crypt.crypt('$val', crypt.mksalt(crypt.METHOD_MD5)))" 2>/dev/null) \
            || { warn "Could not hash password (need openssl or python3)."; hashed=""; }
        if [[ -n "$hashed" ]]; then
            echo "${admin_user}:${hashed}" > "$htpasswd_file"
            chmod 600 "$htpasswd_file"
            id www-data &>/dev/null && chown www-data:www-data "$htpasswd_file" 2>/dev/null || true
            success "htpasswd saved: $htpasswd_file"
        fi
    fi

    # ── Site / SEO ────────────────────────────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}Site / SEO:${RESET}"
    echo -ne "Site description [$(drop_read_conf site_description 'Claim free GRIN...')]: "
    read -r val || true
    [[ -n "$val" ]] && drop_write_conf_key "site_description" "$val"

    echo -ne "OG image URL     [$(drop_read_conf og_image_url '')]: "
    read -r val || true
    [[ -n "$val" ]] && drop_write_conf_key "og_image_url" "$val"

    # ── Maintenance ───────────────────────────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}Maintenance:${RESET}"
    echo -ne "Maintenance message [$(drop_read_conf maintenance_message 'We will be back soon.')]: "
    read -r val || true
    [[ -n "$val" ]] && drop_write_conf_key "maintenance_message" "$val"

    echo ""
    success "Configuration saved to $DROP_CONF"

    if systemctl is-active --quiet "$DROP_SERVICE" 2>/dev/null; then
        info "Restarting $DROP_SERVICE to apply new config..."
        systemctl restart "$DROP_SERVICE"
        success "Service restarted."
    fi

    log "[drop_configure] network=$DROP_NETWORK"
    pause
}

# =============================================================================
# OPTION 5 — Deploy web files
# =============================================================================

drop_deploy_web() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — 5) Deploy Web Files ──${RESET}\n"

    if [[ ! -d "$DROP_WEB_SRC" ]]; then
        die "Web source not found: $DROP_WEB_SRC  (clone the toolkit repo first)"
        pause; return
    fi

    info "Copying $DROP_WEB_SRC → $DROP_WEB_DIR ..."
    mkdir -p "$DROP_WEB_DIR"
    cp -r "$DROP_WEB_SRC"/. "$DROP_WEB_DIR/"
    find "$DROP_WEB_DIR" -type f \( -name "*.html" -o -name "*.css" -o -name "*.js" \) -exec chmod 644 {} \;

    success "Files deployed to $DROP_WEB_DIR"

    # Generate robots.txt (never expose admin path)
    local domain_val; domain_val=$(drop_read_conf "subdomain" "")
    cat > "$DROP_WEB_DIR/robots.txt" << ROBOTS_EOF
User-agent: *
Disallow: /api/
Allow: /

Sitemap: https://${domain_val}/sitemap.xml
ROBOTS_EOF
    success "robots.txt generated at $DROP_WEB_DIR/robots.txt"

    log "[drop_deploy_web] network=$DROP_NETWORK"
    pause
}

# =============================================================================
# OPTION 6 — Setup nginx
# =============================================================================

drop_setup_nginx() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — 6) Setup nginx ──${RESET}\n"

    # Install nginx + certbot if missing
    local _need_nginx=false _need_certbot=false _lbl=""
    command -v nginx   &>/dev/null || _need_nginx=true
    command -v certbot &>/dev/null || _need_certbot=true
    if $_need_nginx && $_need_certbot; then _lbl="nginx and certbot"
    elif $_need_nginx;   then _lbl="nginx"
    elif $_need_certbot; then _lbl="certbot"
    fi
    if [[ -n "$_lbl" ]]; then
        info "$_lbl not found — installing..."
        apt-get install -y nginx certbot python3-certbot-nginx \
            || { die "Installation failed — run as root."; pause; return; }
        success "$_lbl installed."
    fi

    if [[ ! -d "$DROP_WEB_DIR" ]]; then
        die "Web files not deployed — run option 5 first."; pause; return
    fi

    local domain; domain=$(drop_read_conf "subdomain" "")
    echo ""
    if [[ -z "$domain" ]]; then
        warn "No domain configured — go back and set it in option 4) Configure."
        echo -ne "  Press 0 to return, or Enter to continue anyway: "
        read -r _confirm || true
        [[ "$_confirm" == "0" ]] && return
    else
        echo -e "  ${BOLD}Domain:${RESET} ${GREEN}$domain${RESET}"
        echo -e "  ${DIM}To change it, press 0 and update it in option 4) Configure.${RESET}"
        echo -ne "  Press Enter to confirm, or 0 to return: "
        read -r _confirm || true
        [[ "$_confirm" == "0" ]] && return
    fi
    echo ""

    local port; port=$(drop_read_conf "service_port" "$DROP_PORT")
    local zone="drop_${DROP_NETWORK}"
    local admin_path; admin_path=$(drop_read_conf "admin_secret_path" "")
    local htpasswd_file="/etc/nginx/.htpasswd-grin-drop-${DROP_NETWORK}"

    # ── SSL method ────────────────────────────────────────────────────────────
    echo -e "  ${BOLD}SSL Certificate method:${RESET}"
    echo -e "  ${GREEN}1${RESET}) Let's Encrypt  ${DIM}(Cloudflare DNS must be 'DNS only' / grey cloud)${RESET}"
    echo -e "  ${GREEN}2${RESET}) Cloudflare Origin Certificate  ${DIM}(domain can stay Proxied / orange cloud)${RESET}"
    echo -ne "  Choice [1/2/0 to cancel]: "
    local ssl_choice
    read -r ssl_choice || true
    [[ "$ssl_choice" == "0" ]] && return
    [[ "$ssl_choice" != "2" ]] && ssl_choice="1"
    echo ""

    if [[ "$ssl_choice" == "1" ]]; then
        # ── Let's Encrypt ─────────────────────────────────────────────────────
        local email=""
        while [[ -z "$email" ]]; do
            echo -ne "Let's Encrypt email (required): "
            read -r email || true
            [[ -z "$email" ]] && warn "Email is required. Enter 0 to abort."
            [[ "$email" == "0" ]] && return
        done

        info "Writing temporary HTTP nginx config → $DROP_NGINX_CONF"
        cat > "$DROP_NGINX_CONF" << NGINX_HTTP
# Grin Drop [$DROP_NET_LABEL] — temporary HTTP config (run step 6 again after SSL)
server {
    listen 80;
    listen [::]:80;
    server_name $domain;
    location / { return 301 https://\$host\$request_uri; }
}
NGINX_HTTP

        ln -sf "$DROP_NGINX_CONF" "$DROP_NGINX_LINK" 2>/dev/null || true
        nginx -t && systemctl reload nginx \
            || { warn "nginx config test failed — check $DROP_NGINX_CONF"; pause; return; }

        info "Requesting SSL certificate for $domain ..."
        certbot --nginx -d "$domain" --non-interactive --agree-tos -m "$email" \
            && success "SSL certificate issued." \
            || {
                warn "certbot failed — ensure DNS is pointing to this server and port 80 is open."
                warn "Using Cloudflare? Switch DNS from 'Proxied' to 'DNS only' (grey cloud),"
                warn "then re-run this step. After cert is issued you can switch back to Proxied."
                warn "Or choose option 2) Cloudflare Origin Certificate on the next run."
                pause; return
            }

        info "Writing HTTPS nginx config → $DROP_NGINX_CONF"
        cat > "$DROP_NGINX_CONF" << NGINX
# Grin Drop [$DROP_NET_LABEL] — generated by 052_grin_drop.sh (Let's Encrypt)
limit_req_zone \$binary_remote_addr zone=${zone}_api:10m rate=10r/m;
limit_req_zone \$binary_remote_addr zone=${zone}_admin:5m rate=6r/m;

server {
    listen 80;
    listen [::]:80;
    server_name $domain;
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $domain;

    ssl_certificate     /etc/letsencrypt/live/$domain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$domain/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    root  $DROP_WEB_DIR;
    index index.html;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options    "nosniff"  always;
    add_header X-Frame-Options           "DENY"     always;
    add_header Referrer-Policy           "strict-origin" always;
    add_header Content-Security-Policy   "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" always;

    access_log /var/log/nginx/grin-drop-${DROP_NETWORK}-access.log;
    error_log  /var/log/nginx/grin-drop-${DROP_NETWORK}-error.log;

    location /api/ {
        limit_req zone=${zone}_api burst=5 nodelay;
        proxy_pass         http://127.0.0.1:$port;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 90s;
    }

    location ~* \.(css|js|ico|png|svg|woff2?)\$ {
        expires 1h;
        add_header Cache-Control "public";
    }

$(if [[ -n "$admin_path" ]]; then
cat << ADMIN_BLOCK
    location /${admin_path}/ {
        limit_req zone=${zone}_admin burst=3 nodelay;
        auth_basic "Restricted";
        auth_basic_user_file $htpasswd_file;
        add_header X-Robots-Tag "noindex, nofollow" always;
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
        proxy_pass         http://127.0.0.1:$port;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }
ADMIN_BLOCK
fi)

    location / { try_files \$uri \$uri/ /index.html; }

    location ~ /\.  { deny all; }
    location ~ ~\$  { deny all; }
}
NGINX

    else
        # ── Cloudflare Origin Certificate ─────────────────────────────────────
        echo -e "  ${BOLD}Cloudflare Origin Certificate${RESET}  ${DIM}(Proxied stays on — no certbot needed)${RESET}"
        echo ""
        echo -e "  ${YELLOW}Steps in Cloudflare Dashboard:${RESET}"
        echo -e "    1. Your domain → SSL/TLS → Origin Server → Create Certificate"
        echo -e "    2. Leave defaults (RSA, 15 years) → click Create"
        echo -e "    3. Copy the ${BOLD}Origin Certificate${RESET} and ${BOLD}Private Key${RESET} below"
        echo ""
        echo -ne "  Ready to paste? Press Enter to continue, 0 to cancel: "
        read -r _cf_ok || true
        [[ "$_cf_ok" == "0" ]] && return

        echo ""
        echo -e "  ${BOLD}Paste Origin Certificate${RESET} (-----BEGIN CERTIFICATE----- ... -----END CERTIFICATE-----):"
        local cf_cert="" cf_line
        while IFS= read -r cf_line; do
            cf_cert+="$cf_line"$'\n'
            [[ "$cf_line" == *"-----END"* ]] && break
        done
        if [[ "$cf_cert" != *"-----BEGIN"* ]]; then
            warn "Invalid certificate — no PEM header found."; pause; return
        fi

        echo ""
        echo -e "  ${BOLD}Paste Private Key${RESET} (-----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----):"
        local cf_key="" cf_key_line
        while IFS= read -r cf_key_line; do
            cf_key+="$cf_key_line"$'\n'
            [[ "$cf_key_line" == *"-----END"* ]] && break
        done
        if [[ "$cf_key" != *"-----BEGIN"* ]]; then
            warn "Invalid private key — no PEM header found."; pause; return
        fi

        local cf_dir="/etc/ssl/cloudflare-origin"
        mkdir -p "$cf_dir"
        printf '%s' "$cf_cert" > "$cf_dir/$domain.pem"
        printf '%s' "$cf_key"  > "$cf_dir/$domain.key"
        chmod 644 "$cf_dir/$domain.pem"
        chmod 600 "$cf_dir/$domain.key"
        success "Cloudflare Origin Certificate saved → $cf_dir/$domain.pem"

        info "Writing HTTPS nginx config → $DROP_NGINX_CONF"
        cat > "$DROP_NGINX_CONF" << NGINX_CF
# Grin Drop [$DROP_NET_LABEL] — generated by 052_grin_drop.sh (Cloudflare Origin Cert)
limit_req_zone \$binary_remote_addr zone=${zone}_api:10m rate=10r/m;
limit_req_zone \$binary_remote_addr zone=${zone}_admin:5m rate=6r/m;

server {
    listen 80;
    listen [::]:80;
    server_name $domain;
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $domain;

    ssl_certificate     $cf_dir/$domain.pem;
    ssl_certificate_key $cf_dir/$domain.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;

    root  $DROP_WEB_DIR;
    index index.html;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options    "nosniff"  always;
    add_header X-Frame-Options           "DENY"     always;
    add_header Referrer-Policy           "strict-origin" always;
    add_header Content-Security-Policy   "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" always;

    access_log /var/log/nginx/grin-drop-${DROP_NETWORK}-access.log;
    error_log  /var/log/nginx/grin-drop-${DROP_NETWORK}-error.log;

    location /api/ {
        limit_req zone=${zone}_api burst=5 nodelay;
        proxy_pass         http://127.0.0.1:$port;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 90s;
    }

    location ~* \.(css|js|ico|png|svg|woff2?)\$ {
        expires 1h;
        add_header Cache-Control "public";
    }

$(if [[ -n "$admin_path" ]]; then
cat << ADMIN_BLOCK_CF
    location /${admin_path}/ {
        limit_req zone=${zone}_admin burst=3 nodelay;
        auth_basic "Restricted";
        auth_basic_user_file $htpasswd_file;
        add_header X-Robots-Tag "noindex, nofollow" always;
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
        proxy_pass         http://127.0.0.1:$port;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }
ADMIN_BLOCK_CF
fi)

    location / { try_files \$uri \$uri/ /index.html; }

    location ~ /\.  { deny all; }
    location ~ ~\$  { deny all; }
}
NGINX_CF

        ln -sf "$DROP_NGINX_CONF" "$DROP_NGINX_LINK" 2>/dev/null || true
    fi

    nginx -t && systemctl reload nginx && success "nginx HTTPS config loaded." \
        || { warn "nginx config test failed — check $DROP_NGINX_CONF"; pause; return; }

    # ── nginx log rotation ─────────────────────────────────────────────────────
    cat > "/etc/logrotate.d/nginx-grin-drop-${DROP_NETWORK}" << LOGROTATE
/var/log/nginx/grin-drop-${DROP_NETWORK}-access.log
/var/log/nginx/grin-drop-${DROP_NETWORK}-error.log {
    daily
    rotate 5
    size 5M
    compress
    delaycompress
    missingok
    notifempty
    sharedscripts
    postrotate
        [ -f /var/run/nginx.pid ] && kill -USR1 \$(cat /var/run/nginx.pid) 2>/dev/null || true
    endscript
}
LOGROTATE
    success "nginx logrotate config written (5 days / 5 MB)"

    log "[drop_setup_nginx] network=$DROP_NETWORK domain=$domain ssl=$ssl_choice"
    pause
}

# =============================================================================
# OPTION 7 — Start / Stop service
# =============================================================================

drop_service_control() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — 7) Start / Stop Service ──${RESET}\n"

    if [[ ! -f "/etc/systemd/system/${DROP_SERVICE}.service" ]]; then
        die "Service not installed — run option 3 (Install) first."; pause; return
    fi

    local state="stopped"
    if systemctl is-active --quiet "$DROP_SERVICE" 2>/dev/null; then
        state="running"
        echo -e "  Service is ${GREEN}running${RESET}."
        echo ""
        echo -e "  ${RED}1${RESET}) Stop service"
        echo -e "  ${YELLOW}2${RESET}) Restart service"
        echo -e "  ${DIM}0) Back${RESET}"
    else
        echo -e "  Service is ${YELLOW}stopped${RESET}."
        echo ""
        echo -e "  ${GREEN}1${RESET}) Start service"
        echo -e "  ${GREEN}2${RESET}) Enable + Start  ${DIM}(auto-start on boot)${RESET}"
        echo -e "  ${DIM}0) Back${RESET}"
    fi
    echo ""
    echo -ne "${BOLD}Select [1/2/0]: ${RESET}"
    read -r sc || true

    case "$sc" in
        1)
            if [[ "$state" == "running" ]]; then
                systemctl stop "$DROP_SERVICE" && success "Service stopped."
            else
                systemctl start "$DROP_SERVICE" && success "Service started."
            fi
            ;;
        2)
            if [[ "$state" == "running" ]]; then
                systemctl restart "$DROP_SERVICE" && success "Service restarted."
            else
                systemctl enable "$DROP_SERVICE" 2>/dev/null || true
                systemctl start "$DROP_SERVICE" && success "Service enabled and started."
            fi
            ;;
        0) return ;;
    esac
    pause
}

# =============================================================================
# OPTION 8 — Drop status
# =============================================================================

drop_status_screen() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} Grin Drop [$DROP_NET_LABEL] — Status${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    # Service
    if systemctl is-active --quiet "$DROP_SERVICE" 2>/dev/null; then
        local pid
        pid=$(systemctl show "$DROP_SERVICE" --property=MainPID --value 2>/dev/null || echo "?")
        echo -e "  ${BOLD}Service${RESET}    : ${GREEN}● active (running)${RESET}  pid $pid"
    elif systemctl is-enabled --quiet "$DROP_SERVICE" 2>/dev/null; then
        echo -e "  ${BOLD}Service${RESET}    : ${YELLOW}stopped (enabled)${RESET}"
    else
        echo -e "  ${BOLD}Service${RESET}    : ${RED}not installed${RESET}"
    fi

    local port; port=$(drop_read_conf "service_port" "$DROP_PORT")
    local subdomain; subdomain=$(drop_read_conf "subdomain" "")
    echo -e "  ${BOLD}Port${RESET}       : $port"
    [[ -n "$subdomain" ]] && echo -e "  ${BOLD}URL${RESET}        : ${GREEN}https://$subdomain${RESET}"
    local admin_path; admin_path=$(drop_read_conf "admin_secret_path" "")
    if [[ -n "$admin_path" && -n "$subdomain" ]]; then
        echo -e "  ${BOLD}Admin URL${RESET}  : ${YELLOW}https://$subdomain/$admin_path/${RESET}  ${DIM}(keep secret)${RESET}"
    fi

    # DB
    if [[ -f "$DROP_DB" ]]; then
        local db_size
        db_size=$(du -sh "$DROP_DB" 2>/dev/null | cut -f1 || echo "?")
        echo -e "  ${BOLD}Database${RESET}   : ${GREEN}$DROP_DB${RESET}  ($db_size)"
    else
        echo -e "  ${BOLD}Database${RESET}   : ${DIM}not created${RESET}"
    fi

    # Wallet balance
    if [[ -x "$DROP_WALLET_BIN" ]]; then
        local balance
        balance=$("$DROP_WALLET_BIN" $DROP_NET_FLAG info 2>/dev/null \
            | grep -i "spendable" | grep -oP '[\d.]+' | head -1 || echo "?")
        local net_label
        [[ "$DROP_NETWORK" == "testnet" ]] && net_label="testnet GRIN" || net_label="GRIN"
        echo -e "  ${BOLD}Balance${RESET}    : ${GREEN}${balance:-?} $net_label${RESET}"
    else
        echo -e "  ${BOLD}Balance${RESET}    : ${DIM}wallet binary not found${RESET}"
    fi

    # Claims (giveaway mode stats)
    if command -v sqlite3 &>/dev/null && [[ -f "$DROP_DB" ]]; then
        local today; today=$(date -u +"%Y-%m-%d")
        local claims_today pending
        claims_today=$(sqlite3 "$DROP_DB" \
            "SELECT COUNT(*) FROM claims WHERE created_at LIKE '${today}%' AND status='confirmed';" \
            2>/dev/null || echo "?")
        pending=$(sqlite3 "$DROP_DB" \
            "SELECT COUNT(*) FROM claims WHERE status='waiting_finalize';" \
            2>/dev/null || echo "?")
        echo -e "  ${BOLD}Claims${RESET}     : today: $claims_today  pending: $pending"
    fi

    # Mode status
    local giveaway_on donation_on
    giveaway_on=$(drop_read_conf "giveaway_enabled" "true")
    donation_on=$(drop_read_conf "donation_enabled" "true")
    echo ""
    echo -e "  ${BOLD}Giveaway mode${RESET}: $giveaway_on  |  ${BOLD}Donation mode${RESET}: $donation_on"

    # Recent log
    if [[ -f "$DROP_LOG" ]]; then
        echo ""
        echo -e "  ${DIM}── Recent activity (last 10 lines) ──${RESET}"
        tail -n 10 "$DROP_LOG" 2>/dev/null | while IFS= read -r line; do
            echo -e "  ${DIM}$line${RESET}"
        done
    fi
    echo ""
    pause
}

# =============================================================================
# OPTION 9 — Wallet address
# =============================================================================

drop_wallet_address() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — 9) Wallet Address ──${RESET}\n"

    drop_ensure_defaults
    local addr; addr=$(drop_read_conf "wallet_address" "")

    echo -e "  ${BOLD}Stored address:${RESET}"
    echo -e "  ──────────────────────────────────────────────────────────────"
    if [[ -n "$addr" ]]; then
        echo -e "  ${GREEN}$addr${RESET}"
    else
        echo -e "  ${YELLOW}(not set — run option 4 to configure)${RESET}"
    fi
    echo -e "  ──────────────────────────────────────────────────────────────"
    echo -e "  ${DIM}This address is shown for donations and on the homepage.${RESET}"
    echo ""

    if [[ -x "$DROP_WALLET_BIN" ]]; then
        local balance
        balance=$("$DROP_WALLET_BIN" $DROP_NET_FLAG info 2>/dev/null \
            | grep -i "spendable" | grep -oP '[\d.]+' | head -1 || echo "?")
        local net_label
        [[ "$DROP_NETWORK" == "testnet" ]] && net_label="testnet GRIN" || net_label="GRIN"
        echo -e "  ${BOLD}Current balance:${RESET}  ${GREEN}${balance:-?} $net_label${RESET}"
    fi

    echo ""
    echo -e "  ${CYAN}U${RESET}) Update stored address"
    echo -e "  ${DIM}0) Back${RESET}"
    echo ""
    echo -ne "${BOLD}Select [U/0]: ${RESET}"
    read -r choice || true

    if [[ "${choice,,}" == "u" ]]; then
        echo ""
        echo -ne "New wallet address: "
        read -r new_addr || true
        if [[ -n "$new_addr" ]]; then
            drop_write_conf_key "wallet_address" "$new_addr"
            success "Address updated."
            if systemctl is-active --quiet "$DROP_SERVICE" 2>/dev/null; then
                systemctl restart "$DROP_SERVICE"
                success "Service restarted."
            fi
        else
            info "No change made."
        fi
    fi
    pause
}

# =============================================================================
# OPTION L — View logs
# =============================================================================

drop_view_logs() {
    if [[ ! -f "$DROP_LOG" ]]; then
        warn "Log file not found: $DROP_LOG"
        warn "The drop service may not have been started yet."
        pause; return
    fi
    clear
    echo -e "${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — Activity Log ──${RESET}"
    echo -e "${DIM}  $DROP_LOG${RESET}"
    echo -e "${DIM}  (press q to exit)${RESET}\n"
    tail -n 50 "$DROP_LOG" | less -FRX
}

# =============================================================================
# OPTION DEL — Reset database
# =============================================================================

drop_reset_db() {
    clear
    echo -e "\n${BOLD}${RED}── Grin Drop [$DROP_NET_LABEL] — DEL) Reset Database ──${RESET}\n"

    if [[ ! -f "$DROP_DB" ]]; then
        warn "Database not found: $DROP_DB"
        pause; return
    fi

    local db_size claim_count="(sqlite3 not available)"
    db_size=$(du -sh "$DROP_DB" 2>/dev/null | cut -f1 || echo "?")
    command -v sqlite3 &>/dev/null && \
        claim_count=$(sqlite3 "$DROP_DB" "SELECT COUNT(*) FROM claims;" 2>/dev/null || echo "?")

    echo -e "  ${RED}This will permanently destroy:${RESET}"
    echo -e "  • Database: $DROP_DB  (${db_size})"
    echo -e "  • All claim records: $claim_count rows"
    echo ""

    echo -ne "${BOLD}Type ${RED}RESET DROP DATABASE${RESET}${BOLD} to confirm: ${RESET}"
    read -r confirm1 || true
    if [[ "$confirm1" != "RESET DROP DATABASE" ]]; then
        info "Reset cancelled."; pause; return
    fi

    echo -ne "${BOLD}Type ${RED}YES${RESET}${BOLD} to proceed: ${RESET}"
    read -r confirm2 || true
    if [[ "$confirm2" != "YES" ]]; then
        info "Reset cancelled."; pause; return
    fi

    systemctl stop "$DROP_SERVICE" 2>/dev/null || true
    rm -f "$DROP_DB"
    success "Database deleted."
    systemctl start "$DROP_SERVICE" 2>/dev/null || true
    success "Service restarted — empty database created."
    log "[drop_reset_db] network=$DROP_NETWORK db=$DROP_DB"
    pause
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
        echo -e "  ${GREEN}1${RESET}) Setup wallet          ${DIM}(download + init drop wallet)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Wallet listening      ${DIM}(start tmux: $DROP_TMUX)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Install               ${DIM}(Python + Flask deps, systemd service)${RESET}"
        echo -e "  ${GREEN}4${RESET}) Configure             ${DIM}(domain, modes, claim amount, wallet address)${RESET}"
        echo -e "  ${GREEN}5${RESET}) Deploy web files      ${DIM}(copy to $DROP_WEB_DIR)${RESET}"
        echo -e "  ${GREEN}6${RESET}) Setup nginx           ${DIM}(vhost + SSL + rate limits)${RESET}"
        echo -e "  ${GREEN}7${RESET}) Start / Stop service  ${DIM}(systemd $DROP_SERVICE)${RESET}"
        echo ""
        echo -e "${DIM}  ─── Info & maintenance ───────────────────────────${RESET}"
        echo -e "  ${CYAN}8${RESET}) Drop status           ${DIM}(health, balance, claims, logs)${RESET}"
        echo -e "  ${CYAN}9${RESET}) Wallet address        ${DIM}(show + update address)${RESET}"
        echo -e "  ${CYAN}L${RESET}) View logs             ${DIM}(tail activity log)${RESET}"
        echo ""
        echo -e "${DIM}  ─── Danger zone ──────────────────────────────────${RESET}"
        echo -e "  ${RED}DEL${RESET}) Reset database      ${DIM}(wipe all claim history — triple-confirm)${RESET}"
        echo ""
        echo -e "  ${DIM}↩  Press Enter to refresh${RESET}"
        echo -e "  ${RED}0${RESET}) Back to network select"
        echo ""
        echo -ne "${BOLD}Select [1-9 / L / DEL / 0]: ${RESET}"
        read -r choice || true

        case "${choice,,}" in
            1) drop_setup_wallet    || true ;;
            2) drop_start_listener  || true ;;
            3) drop_install         || true ;;
            4) drop_configure       || true ;;
            5) drop_deploy_web      || true ;;
            6) drop_setup_nginx     || true ;;
            7) drop_service_control || true ;;
            8) drop_status_screen   || true ;;
            9) drop_wallet_address  || true ;;
            l) drop_view_logs       || true ;;
            del) drop_reset_db      || true ;;
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
