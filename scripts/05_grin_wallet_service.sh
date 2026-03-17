#!/bin/bash
# =============================================================================
# 05_grin_wallet_service.sh — Grin Wallet Service
# =============================================================================
#
#  ─── Network Selection ───────────────────────────────────────────────────────
#   1) Mainnet wallet
#   2) Testnet wallet
#
#  ─── Wallet Menu (per network) ───────────────────────────────────────────────
#   a) Download & install grin-wallet
#   b) Initialize wallet                (grin-wallet init)
#   c) Start wallet listener            (grin-wallet listen, in tmux)
#
#  ─── Foreign API ─────────────────────────────────────────────────────────────
#   d) Enable Wallet Foreign API        (3415 mainnet / 13415 testnet — localhost only)
#   e) Disable Wallet Foreign API
#
#  ─── Web Interface ───────────────────────────────────────────────────────────
#   w) Web Wallet Interface             (submenu — 05 W)
#      1) Install dependencies          (nginx, php, certbot, htpasswd, qrencode)
#      2) Deploy files                  (copy web/05_wallet/ → deploy directory)
#      3) Configure nginx               (vhost + rate-limit + security headers)
#      4) Setup SSL                     (Let's Encrypt / certbot)
#      5) Setup Basic Auth              (set / change password)
#      6) Configure firewall            (open port 443)
#      7) Status & info
#      s) Edit saved settings           (domain, directory, email, user)
#
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLKIT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONF_DIR="/opt/grin/conf"
WALLETS_CONF="$CONF_DIR/grin_wallets_location.conf"

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# ─── Constants ────────────────────────────────────────────────────────────────
GRIN_WALLET_GITHUB_API="https://api.github.com/repos/mimblewimble/grin-wallet/releases/latest"

WALLET_BIN_DIR_MAINNET="/opt/grin/wallet/mainnet"
WALLET_BIN_DIR_TESTNET="/opt/grin/wallet/testnet"
WALLET_BIN_MAINNET="$WALLET_BIN_DIR_MAINNET/grin-wallet"
WALLET_BIN_TESTNET="$WALLET_BIN_DIR_TESTNET/grin-wallet"
GRIN_WALLET_TOML_MAINNET="$WALLET_BIN_DIR_MAINNET/grin-wallet.toml"
GRIN_WALLET_TOML_TESTNET="$WALLET_BIN_DIR_TESTNET/grin-wallet.toml"

LOG_DIR="$TOOLKIT_ROOT/log"
LOG_FILE="$LOG_DIR/grin_wallet_service_$(date +%Y%m%d_%H%M%S).log"

WALLET_NGINX_CONF_MAINNET="/etc/nginx/sites-available/grin-wallet-mainnet"
WALLET_NGINX_CONF_TESTNET="/etc/nginx/sites-available/grin-wallet-testnet"

# Web wallet
WEB_WALLET_SRC_DIR="$TOOLKIT_ROOT/web/05_wallet/public_html"
WEB_WALLET_NGINX_CONF="/etc/nginx/sites-available/grin-wallet-web"
WEB_WALLET_DEPLOY_DIR_DEFAULT="/var/www/grin-wallet"
WW_CONF_FILE="/opt/grin/conf/grin_web_wallet.conf"

# ─── Runtime state (set by detect_and_select_network) ─────────────────────────
NETWORK=""
NODE_PORT=""
WALLET_BIN=""
WALLET_DIR=""
GRIN_WALLET_TOML=""
WALLET_NGINX_CONF=""

# ─── Logging ──────────────────────────────────────────────────────────────────
mkdir -p "$LOG_DIR"
log()     { echo -e "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; log "[INFO] $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; log "[OK] $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; log "[WARN] $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; log "[ERROR] $*"; }
die()     { error "$*"; echo ""; echo "Press Enter to continue..."; read -r || true; return 1; }

# -----------------------------------------------------------------------------
# Save wallet location to /opt/grin/conf/grin_wallets_location.conf
# Requires: NETWORK and WALLET_DIR set (by detect_and_select_network)
# -----------------------------------------------------------------------------
save_wallet_location() {
    local key
    [[ "$NETWORK" == "mainnet" ]] && key="MAINNET" || key="TESTNET"
    mkdir -p "$CONF_DIR"
    touch "$WALLETS_CONF"
    sed -i "/^${key}_WALLET_/d" "$WALLETS_CONF" 2>/dev/null || true
    cat >> "$WALLETS_CONF" << __EOF__

${key}_WALLET_DIR="$WALLET_DIR"
${key}_WALLET_BIN="$WALLET_DIR/grin-wallet"
${key}_WALLET_TOML="$WALLET_DIR/grin-wallet.toml"
${key}_WALLET_DATA="$WALLET_DIR/wallet_data"
__EOF__
    chmod 600 "$WALLETS_CONF"
    log "Wallet location saved: $key → $WALLET_DIR"
}
pause()   { echo ""; echo -e "${DIM}Press Enter to continue...${RESET}"; read -r || true; }

# Harden wallet directory and API secret file permissions.
# Call after init (locks the dir) and after start (locks secrets written by grin-wallet).
# Security model:
#   /opt/grin/wallet/mainnet/              700  — only wallet owner can enter
#   /opt/grin/wallet/mainnet/wallet_data/  700  — only wallet owner can enter
#   wallet_data/.api_secret       600  — Foreign API token (read by wallet process only)
#   wallet_data/.owner_api_secret 600  — Owner API token  (read by wallet process only)
# When web UI is added: grant www-data read on .owner_api_secret only via group (640 + chown :www-data).
_harden_wallet_dir() {
    local dir="$WALLET_DIR"
    local data_dir="$dir/wallet_data"

    if id grin &>/dev/null; then
        chown -R grin:grin "$dir" 2>/dev/null || true
    else
        warn "User 'grin' not found — skipping chown. Run Script 08 → option 10 to create it."
    fi
    chmod 700 "$dir" 2>/dev/null || true
    [[ -d "$data_dir" ]] && chmod 700 "$data_dir" 2>/dev/null || true

    local changed=0
    for secret_file in "$data_dir/.api_secret" "$data_dir/.owner_api_secret"; do
        if [[ -f "$secret_file" ]]; then
            chmod 600 "$secret_file" 2>/dev/null || true
            changed=1
        fi
    done

    if [[ $changed -eq 1 ]]; then
        info "Permissions hardened: $dir → 700, secret files → 600"
    else
        info "Permissions hardened: $dir → 700  (secret files not yet created — re-run after first wallet start)"
    fi
}

# Patch or append a key=value in a TOML file.
# Usage: _patch_toml <file> <key> <value>  (value should include quotes if needed)
_patch_toml() {
    local toml="$1" key="$2" val="$3"
    if grep -q "^${key}\s*=" "$toml"; then
        sed -i "s|^${key}\s*=.*|${key} = ${val}|" "$toml"
    else
        echo "${key} = ${val}" >> "$toml"
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# NETWORK DETECTION
# ═══════════════════════════════════════════════════════════════════════════════

detect_and_select_network() {
    local mainnet_up=0 testnet_up=0
    ss -tlnp 2>/dev/null | grep -q ":3413 "  && mainnet_up=1
    ss -tlnp 2>/dev/null | grep -q ":13413 " && testnet_up=1

    if [[ $mainnet_up -eq 1 && $testnet_up -eq 0 ]]; then
        NETWORK="mainnet"; NODE_PORT=3413
    elif [[ $mainnet_up -eq 0 && $testnet_up -eq 1 ]]; then
        NETWORK="testnet"; NODE_PORT=13413
    else
        if [[ $mainnet_up -eq 1 && $testnet_up -eq 1 ]]; then
            echo -e "\n  ${BOLD}Both mainnet and testnet nodes are running:${RESET}"
        else
            warn "No Grin node detected on ports 3413 or 13413."
        fi
        echo -e "  ${GREEN}1${RESET}) Mainnet  ${DIM}(port 3413)${RESET}  [default]"
        echo -e "  ${YELLOW}2${RESET}) Testnet  ${DIM}(port 13413)${RESET}"
        echo -e "  ${DIM}0) Cancel${RESET}"
        echo -ne "Select network [1]: "
        read -r net_sel || true
        [[ "$net_sel" == "0" ]] && return 1
        if [[ "${net_sel:-1}" == "2" ]]; then
            NETWORK="testnet"; NODE_PORT=13413
        else
            NETWORK="mainnet"; NODE_PORT=3413
        fi
    fi

    if [[ "$NETWORK" == "mainnet" ]]; then
        WALLET_BIN="$WALLET_BIN_MAINNET"
        WALLET_DIR="$WALLET_BIN_DIR_MAINNET"
        GRIN_WALLET_TOML="$GRIN_WALLET_TOML_MAINNET"
        WALLET_NGINX_CONF="$WALLET_NGINX_CONF_MAINNET"
    else
        WALLET_BIN="$WALLET_BIN_TESTNET"
        WALLET_DIR="$WALLET_BIN_DIR_TESTNET"
        GRIN_WALLET_TOML="$GRIN_WALLET_TOML_TESTNET"
        WALLET_NGINX_CONF="$WALLET_NGINX_CONF_TESTNET"
    fi

    # Override defaults with saved path from conf if available (e.g. after migration)
    if [[ -f "$WALLETS_CONF" ]]; then
        local _saved_dir
        if [[ "$NETWORK" == "mainnet" ]]; then
            _saved_dir=$( (source "$WALLETS_CONF" 2>/dev/null; echo "${MAINNET_WALLET_DIR:-}") 2>/dev/null || true)
        else
            _saved_dir=$( (source "$WALLETS_CONF" 2>/dev/null; echo "${TESTNET_WALLET_DIR:-}") 2>/dev/null || true)
        fi
        if [[ -n "$_saved_dir" && -d "$_saved_dir" ]]; then
            WALLET_DIR="$_saved_dir"
            WALLET_BIN="$WALLET_DIR/grin-wallet"
            GRIN_WALLET_TOML="$WALLET_DIR/grin-wallet.toml"
            log "Wallet dir loaded from conf: $WALLET_DIR"
        fi
    fi

    info "Network: ${BOLD}$NETWORK${RESET}  (node port $NODE_PORT)"
    return 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# STATUS DISPLAY
# ═══════════════════════════════════════════════════════════════════════════════

get_foreign_api_status() {
    local toml="$1"
    [[ ! -f "$toml" ]] && echo "unknown" && return
    local val
    val="$(grep -E '^\s*owner_api_include_foreign\s*=' "$toml" 2>/dev/null \
        | tail -1 | awk -F= '{print $2}' | tr -d ' \t\r\n' || echo "false")"
    echo "$val"
}

show_status() {
    echo -e "\n${BOLD}Status:${RESET}\n"

    local tmux_session
    tmux_session="grin_wallet_${NETWORK}"

    # ── Grin node ──
    if ss -tlnp 2>/dev/null | grep -q ":${NODE_PORT} "; then
        echo -e "  ${BOLD}Grin node${RESET}       : ${GREEN}RUNNING${RESET}  ${DIM}(port $NODE_PORT)${RESET}"
    else
        echo -e "  ${BOLD}Grin node${RESET}       : ${RED}NOT RUNNING${RESET}  ${YELLOW}⚠ run Script 01${RESET}"
    fi

    # ── Binary ──
    if [[ -x "$WALLET_BIN" ]]; then
        local ver
        ver=$("$WALLET_BIN" --version 2>/dev/null | head -1 || echo "unknown")
        echo -e "  ${BOLD}grin-wallet${RESET}     : ${GREEN}INSTALLED${RESET}  ${DIM}($ver)${RESET}"
    else
        echo -e "  ${BOLD}grin-wallet${RESET}     : ${RED}NOT FOUND${RESET}  ${DIM}($WALLET_BIN)${RESET}"
    fi

    # ── Config ──
    if [[ -f "$GRIN_WALLET_TOML" ]]; then
        echo -e "  ${BOLD}Wallet config${RESET}   : ${GREEN}INITIALIZED${RESET}  ${DIM}($GRIN_WALLET_TOML)${RESET}"
    else
        echo -e "  ${BOLD}Wallet config${RESET}   : ${DIM}not initialized${RESET}"
    fi

    # ── Listener ──
    if tmux has-session -t "$tmux_session" 2>/dev/null; then
        echo -e "  ${BOLD}Wallet listener${RESET} : ${GREEN}RUNNING${RESET}  ${DIM}(tmux: $tmux_session)${RESET}"
    else
        echo -e "  ${BOLD}Wallet listener${RESET} : ${DIM}not running${RESET}"
    fi

    # ── Foreign API ──
    local fa_status
    fa_status="$(get_foreign_api_status "$GRIN_WALLET_TOML")"
    if [[ "$fa_status" == "true" ]]; then
        echo -e "  ${BOLD}Foreign API${RESET}     : ${GREEN}ENABLED${RESET}  in grin-wallet.toml"
    else
        echo -e "  ${BOLD}Foreign API${RESET}     : ${DIM}disabled / unknown${RESET}"
    fi

    # ── Web wallet ──
    if [[ -f "/etc/nginx/sites-enabled/grin-wallet-web" ]]; then
        echo -e "  ${BOLD}Web Wallet UI${RESET}   : ${GREEN}DEPLOYED${RESET}  ${DIM}(nginx: grin-wallet-web)${RESET}"
    elif [[ -d "$WEB_WALLET_DEPLOY_DIR_DEFAULT" ]]; then
        echo -e "  ${BOLD}Web Wallet UI${RESET}   : ${YELLOW}FILES PRESENT${RESET}  ${DIM}(nginx not configured — option w)${RESET}"
    else
        echo -e "  ${BOLD}Web Wallet UI${RESET}   : ${DIM}not deployed${RESET}  ${DIM}(option w)${RESET}"
    fi
    echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
# a) DOWNLOAD & INSTALL GRIN-WALLET
# ═══════════════════════════════════════════════════════════════════════════════

download_wallet() {
    echo -e "\n${BOLD}${CYAN}── Download & Install grin-wallet ──${RESET}\n"

    info "Network: ${BOLD}$NETWORK${RESET}  →  install to ${BOLD}$WALLET_DIR${RESET}"
    echo ""
    local target_dir="$WALLET_DIR" target_bin="$WALLET_BIN" target_net="$NETWORK"

    info "Querying GitHub for latest grin-wallet release..."
    local release_json
    release_json=$(curl -fsSL --max-time 30 "$GRIN_WALLET_GITHUB_API") \
        || { die "Failed to reach GitHub API. Check internet connection."; return; }

    local version download_url
    version=$(echo "$release_json" | jq -r '.tag_name')
    download_url=$(echo "$release_json" \
        | jq -r '.assets[] | select(.name | test("linux-x86_64\\.tar\\.gz$"; "i")) | .browser_download_url' \
        | head -1)

    if [[ -z "$download_url" || "$download_url" == "null" ]]; then
        die "No linux-x86_64 tar.gz asset found in release '$version'."; return
    fi

    info "Version       : $version"
    info "Install target: $target_bin"
    echo ""

    local tmp_tar="/tmp/grin_wallet_$$.tar.gz"
    local tmp_dir="/tmp/grin_wallet_extract_$$"
    mkdir -p "$tmp_dir"

    info "Downloading..."
    wget -c --progress=bar:force -O "$tmp_tar" "$download_url" \
        || { die "Download failed."; rm -rf "$tmp_tar" "$tmp_dir"; return; }

    info "Extracting..."
    tar -xzf "$tmp_tar" -C "$tmp_dir" \
        || { die "Failed to extract."; rm -rf "$tmp_tar" "$tmp_dir"; return; }
    rm -f "$tmp_tar"

    local wallet_bin_src
    wallet_bin_src=$(find "$tmp_dir" -type f -name "grin-wallet" | head -1)
    if [[ -z "$wallet_bin_src" ]]; then
        die "Could not locate 'grin-wallet' binary in archive."; rm -rf "$tmp_dir"; return
    fi

    mkdir -p "$target_dir"
    install -m 755 "$wallet_bin_src" "$target_bin"
    rm -rf "$tmp_dir"

    success "grin-wallet $version installed to $target_bin"
    log "[download_wallet] version=$version network=$target_net binary=$target_bin"
    save_wallet_location
}

# ═══════════════════════════════════════════════════════════════════════════════
# b) INITIALIZE WALLET
# ═══════════════════════════════════════════════════════════════════════════════

init_wallet() {
    echo -e "\n${BOLD}${CYAN}── Initialize Wallet ──${RESET}\n"

    if [[ ! -x "$WALLET_BIN" ]]; then
        warn "grin-wallet binary not found at $WALLET_BIN"
        warn "Run option (a) first to download and install grin-wallet."
        return
    fi

    if [[ -f "$GRIN_WALLET_TOML" ]]; then
        warn "Wallet already initialized at: $GRIN_WALLET_TOML"
        echo -ne "Re-initialize? This will overwrite existing wallet data! [y/N/0]: "
        read -r reinit || true
        [[ "$reinit" == "0" ]] && return
        [[ "${reinit,,}" != "y" ]] && info "Cancelled." && return
    fi

    info "Binary : $WALLET_BIN"
    info "Dir    : $WALLET_DIR"
    echo ""

    local wallet_pass wallet_pass2
    read -rs -p "  Enter wallet password: " wallet_pass; echo ""
    read -rs -p "  Confirm wallet password: " wallet_pass2; echo ""
    echo ""

    if [[ "$wallet_pass" != "$wallet_pass2" ]]; then
        error "Passwords do not match."; unset wallet_pass wallet_pass2; return
    fi
    if [[ -z "$wallet_pass" ]]; then
        warn "Password cannot be empty."; unset wallet_pass wallet_pass2; return
    fi

    info "Initializing wallet — write down the seed phrase that appears below!"
    echo ""
    # --testnet generates correct chain_type, api_listen_port, and
    # check_node_api_http_addr automatically; no need to patch those fields.
    if [[ "$NETWORK" == "testnet" ]]; then
        cd "$WALLET_DIR" && "$WALLET_BIN" --testnet --top_level_dir "$WALLET_DIR" -p "$wallet_pass" init
    else
        cd "$WALLET_DIR" && "$WALLET_BIN" --top_level_dir "$WALLET_DIR" -p "$wallet_pass" init
    fi
    local rc=$?
    unset wallet_pass wallet_pass2
    echo ""

    if [[ $rc -ne 0 || ! -f "$GRIN_WALLET_TOML" ]]; then
        warn "Init may have failed (exit code $rc). Check output above."
        return
    fi

    success "Wallet initialized: $GRIN_WALLET_TOML"
    info "Patching grin-wallet.toml for $NETWORK..."

    local owner_api_port socks_addr
    if [[ "$NETWORK" == "mainnet" ]]; then
        owner_api_port=3420; socks_addr="127.0.0.1:59050"
    else
        owner_api_port=13420; socks_addr="127.0.0.1:59060"
    fi

    _patch_toml "$GRIN_WALLET_TOML" "owner_api_listen_port" "$owner_api_port"
    _patch_toml "$GRIN_WALLET_TOML" "socks_proxy_addr"      "\"$socks_addr\""
    _patch_toml "$GRIN_WALLET_TOML" "log_max_files"         "3"

    success "grin-wallet.toml patched: owner=$owner_api_port, tor=$socks_addr, log_max_files=3"
    log "[init_wallet] network=$NETWORK toml=$GRIN_WALLET_TOML owner_api=$owner_api_port tor=$socks_addr"
    _harden_wallet_dir
    save_wallet_location
}

# ═══════════════════════════════════════════════════════════════════════════════
# c) START WALLET LISTENER
# ═══════════════════════════════════════════════════════════════════════════════

start_wallet() {
    echo -e "\n${BOLD}${CYAN}── Start Wallet Listener ──${RESET}\n"

    if [[ ! -x "$WALLET_BIN" ]]; then
        warn "grin-wallet binary not found — run option (a) first."; return
    fi
    if [[ ! -f "$GRIN_WALLET_TOML" ]]; then
        warn "Wallet not initialized. Run option (b) first."; return
    fi
    if ! command -v tmux &>/dev/null; then
        warn "tmux not installed. Run: apt-get install tmux"; return
    fi

    local session="grin_wallet_$NETWORK"

    if tmux has-session -t "$session" 2>/dev/null; then
        warn "Existing tmux session '$session' found."
        echo -ne "Kill it and restart? [Y/n/0]: "
        read -r restart_choice || true
        [[ "$restart_choice" == "0" ]] && info "Keeping existing session. Attach: tmux attach -t $session" && return
        if [[ "${restart_choice,,}" != "n" ]]; then
            tmux kill-session -t "$session"
            success "Existing session stopped."
        else
            info "Keeping existing session. Attach: tmux attach -t $session"
            return
        fi
    fi

    local wallet_pass
    read -rs -p "  Enter wallet password: " wallet_pass; echo ""
    echo ""
    if [[ -z "$wallet_pass" ]]; then
        warn "No password entered. Cancelled."; return
    fi

    info "Starting grin-wallet listener in tmux session: $session"
    if id grin &>/dev/null; then
        tmux new-session -d -s "$session" -c "$WALLET_DIR" \
            "su -s /bin/bash -c \"'$WALLET_BIN' --top_level_dir '$WALLET_DIR' -p '$wallet_pass' listen\" grin; echo ''; echo 'Listener exited. Press Enter to close.'; read"
    else
        warn "User 'grin' not found — running as current user. Run Script 08 → option 10."
        tmux new-session -d -s "$session" -c "$WALLET_DIR" \
            "bash -c \"'$WALLET_BIN' --top_level_dir '$WALLET_DIR' -p '$wallet_pass' listen; echo ''; echo 'Listener exited. Press Enter to close.'; read\""
    fi
    unset wallet_pass

    sleep 2
    if tmux has-session -t "$session" 2>/dev/null; then
        success "Wallet listener started: $session"
        info "View  : tmux attach -t $session"
        info "Detach: Ctrl+B then D"
    else
        warn "tmux session did not persist — wallet may have exited immediately."
    fi
    _harden_wallet_dir
    log "[start_wallet] session=$session network=$NETWORK"
}

# ═══════════════════════════════════════════════════════════════════════════════
# d) ENABLE WALLET FOREIGN API
# ═══════════════════════════════════════════════════════════════════════════════

enable_foreign_api() {
    echo -e "\n${BOLD}${CYAN}── Enable Wallet Foreign API ──${RESET}\n"

    local foreign_api_port
    [[ "$NETWORK" == "mainnet" ]] && foreign_api_port=3415 || foreign_api_port=13415

    echo -e "  ${DIM}The Foreign API (port $foreign_api_port) allows other wallets to send you Grin via HTTP.${RESET}"
    echo -e "  ${DIM}It runs on localhost only — the Web Wallet (option w) proxies to it internally.${RESET}"
    echo -e "  ${DIM}You do NOT need to open port $foreign_api_port publicly when using the Web Wallet.${RESET}"
    echo ""

    if [[ ! -f "$GRIN_WALLET_TOML" ]]; then
        warn "Wallet config not found at $GRIN_WALLET_TOML"
        warn "Initialize the wallet first (option b)."; return
    fi

    info "Updating $GRIN_WALLET_TOML ..."
    cp "$GRIN_WALLET_TOML" "${GRIN_WALLET_TOML}.bak.$(date +%s)"

    if grep -q "owner_api_include_foreign" "$GRIN_WALLET_TOML"; then
        sed -i 's/owner_api_include_foreign\s*=.*/owner_api_include_foreign = true/' "$GRIN_WALLET_TOML"
    else
        sed -i '/^\[wallet\]/a owner_api_include_foreign = true' "$GRIN_WALLET_TOML" || \
            echo 'owner_api_include_foreign = true' >> "$GRIN_WALLET_TOML"
    fi

    success "Wallet Foreign API enabled in grin-wallet.toml"
    warn "Restart the wallet listener (option c) for the change to take effect."
    log "[enable_foreign_api] network=$NETWORK"
}

# ═══════════════════════════════════════════════════════════════════════════════
# e) DISABLE WALLET FOREIGN API
# ═══════════════════════════════════════════════════════════════════════════════

disable_foreign_api() {
    echo -e "\n${BOLD}${CYAN}── Disable Wallet Foreign API ──${RESET}\n"

    if [[ ! -f "$GRIN_WALLET_TOML" ]]; then
        warn "Wallet config not found at $GRIN_WALLET_TOML"; return
    fi

    cp "$GRIN_WALLET_TOML" "${GRIN_WALLET_TOML}.bak.$(date +%s)"
    sed -i 's/owner_api_include_foreign\s*=.*/owner_api_include_foreign = false/' "$GRIN_WALLET_TOML"
    success "Wallet Foreign API disabled in grin-wallet.toml"
    warn "Restart the wallet listener (option c) for the change to take effect."
    log "[disable_foreign_api] network=$NETWORK"
}

# ═══════════════════════════════════════════════════════════════════════════════
# 05 W) WEB WALLET INTERFACE — Config helpers
# ═══════════════════════════════════════════════════════════════════════════════

ww_load_config() {
    WW_DOMAIN=""
    WW_DEPLOY_DIR="$WEB_WALLET_DEPLOY_DIR_DEFAULT"
    WW_PHP_FPM_SOCK=""
    WW_AUTH_USER="grin"
    WW_EMAIL=""
    if [[ -f "$WW_CONF_FILE" ]]; then
        # shellcheck disable=SC1090
        source "$WW_CONF_FILE" 2>/dev/null || true
    fi
}

ww_save_config() {
    mkdir -p "$(dirname "$WW_CONF_FILE")"
    cat > "$WW_CONF_FILE" << CONF
WW_DOMAIN="${WW_DOMAIN:-}"
WW_DEPLOY_DIR="${WW_DEPLOY_DIR:-$WEB_WALLET_DEPLOY_DIR_DEFAULT}"
WW_PHP_FPM_SOCK="${WW_PHP_FPM_SOCK:-}"
WW_AUTH_USER="${WW_AUTH_USER:-grin}"
WW_EMAIL="${WW_EMAIL:-}"
CONF
    chmod 600 "$WW_CONF_FILE"
}

# ═══════════════════════════════════════════════════════════════════════════════
# 05 M) STEP 1 — Install dependencies
# ═══════════════════════════════════════════════════════════════════════════════

ww_install_deps() {
    clear
    echo -e "\n${BOLD}${CYAN}── 05 M-1) Install Dependencies ──${RESET}\n"

    local all_ok=1
    for pkg_cmd in "nginx:nginx" "php:php" "certbot:certbot" "htpasswd:apache2-utils" "qrencode:qrencode"; do
        local cmd="${pkg_cmd%%:*}" pkg="${pkg_cmd##*:}"
        if command -v "$cmd" &>/dev/null; then
            success "$cmd already installed."
        else
            warn "$cmd not found (package: $pkg)"
            all_ok=0
        fi
    done

    if [[ $all_ok -eq 1 ]]; then
        echo ""
        success "All dependencies are present."
        pause; return
    fi

    echo ""
    echo -ne "${BOLD}Install missing packages now? (requires root / sudo) [Y/n/0]: ${RESET}"
    read -r confirm || true
    [[ "$confirm" == "0" ]] && return
    [[ "${confirm,,}" == "n" ]] && return

    info "Updating package lists..."
    apt-get update -qq 2>/dev/null || { warn "apt-get update failed — continuing anyway."; }

    for pkg_cmd in "nginx:nginx" "php:php" "certbot:certbot" "htpasswd:apache2-utils" "qrencode:qrencode"; do
        local cmd="${pkg_cmd%%:*}" pkg="${pkg_cmd##*:}"
        if ! command -v "$cmd" &>/dev/null; then
            info "Installing $pkg..."
            # php needs extra packages
            if [[ "$cmd" == "php" ]]; then
                apt-get install -y php php-fpm php-curl php-json -qq 2>/dev/null \
                    || warn "Failed to install php — install manually: apt-get install php php-fpm php-curl"
            elif [[ "$cmd" == "certbot" ]]; then
                apt-get install -y certbot python3-certbot-nginx -qq 2>/dev/null \
                    || warn "Failed to install certbot."
            else
                apt-get install -y "$pkg" -qq 2>/dev/null \
                    || warn "Failed to install $pkg."
            fi
        fi
    done

    echo ""
    info "Verification:"
    for pkg_cmd in "nginx:nginx" "php:php" "certbot:certbot" "htpasswd:apache2-utils" "qrencode:qrencode"; do
        local cmd="${pkg_cmd%%:*}"
        if command -v "$cmd" &>/dev/null; then
            success "$cmd  OK"
        else
            warn "$cmd  MISSING — install manually"
        fi
    done
    log "[ww_install_deps] completed"
    pause
}

# ═══════════════════════════════════════════════════════════════════════════════
# 05 M) STEP 2 — Deploy files
# ═══════════════════════════════════════════════════════════════════════════════

ww_deploy_files() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── 05 M-2) Deploy Files ──${RESET}\n"

    if [[ ! -d "$WEB_WALLET_SRC_DIR" ]]; then
        die "Source not found: $WEB_WALLET_SRC_DIR"
        warn "Ensure the Grin Node Toolkit is complete (web/05_wallet/public_html/)."; return
    fi

    echo -ne "Deploy directory [${WW_DEPLOY_DIR}]: "
    read -r input_dir || true
    [[ -n "$input_dir" ]] && WW_DEPLOY_DIR="$input_dir"
    echo ""

    if [[ -d "$WW_DEPLOY_DIR" ]]; then
        warn "Directory already exists: $WW_DEPLOY_DIR"
        echo -ne "Update files? (existing config.json will be preserved) [Y/n/0]: "
        read -r overwrite || true
        [[ "$overwrite" == "0" ]] && return
        [[ "${overwrite,,}" == "n" ]] && info "Cancelled." && return
    fi

    info "Deploying from $WEB_WALLET_SRC_DIR → $WW_DEPLOY_DIR ..."
    mkdir -p "$WW_DEPLOY_DIR"

    # Preserve existing config.json if present
    local tmp_config=""
    if [[ -f "$WW_DEPLOY_DIR/api/config.json" ]]; then
        tmp_config=$(cat "$WW_DEPLOY_DIR/api/config.json")
        info "Preserving existing api/config.json"
    fi

    cp -r "$WEB_WALLET_SRC_DIR"/. "$WW_DEPLOY_DIR/"

    if [[ -n "$tmp_config" ]]; then
        echo "$tmp_config" > "$WW_DEPLOY_DIR/api/config.json"
    else
        # Write default server-side config
        cat > "$WW_DEPLOY_DIR/api/config.json" << JSON
{
    "walletHost": "127.0.0.1",
    "walletPort": 3415
}
JSON
    fi

    chown -R www-data:www-data "$WW_DEPLOY_DIR" 2>/dev/null || \
        warn "Could not chown to www-data — set permissions manually if needed."
    chmod -R 755 "$WW_DEPLOY_DIR"
    chmod 600 "$WW_DEPLOY_DIR/api/config.json"

    ww_save_config
    success "Files deployed to $WW_DEPLOY_DIR"
    log "[ww_deploy_files] deploy_dir=$WW_DEPLOY_DIR"
    pause
}

# ═══════════════════════════════════════════════════════════════════════════════
# 05 M) STEP 3 — Configure nginx
# ═══════════════════════════════════════════════════════════════════════════════

ww_configure_nginx() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── 05 M-3) Configure nginx ──${RESET}\n"

    if ! command -v nginx &>/dev/null; then
        die "nginx not installed — run step 1 first."; return
    fi
    if [[ ! -d "$WW_DEPLOY_DIR" ]]; then
        die "Files not deployed yet — run step 2 first."; return
    fi

    echo -ne "Domain name (e.g. wallet.mynode.example.com) [${WW_DOMAIN:-}]: "
    read -r input_domain || true
    [[ -n "$input_domain" ]] && WW_DOMAIN="$input_domain"
    [[ -z "$WW_DOMAIN" ]] && warn "No domain entered." && return

    # Detect PHP-FPM socket
    if [[ -z "$WW_PHP_FPM_SOCK" ]]; then
        local php_version
        php_version=$(php --version 2>/dev/null | grep -oP '^\S+ \K\d+\.\d+' | head -1 || echo "")
        if [[ -n "$php_version" && -S "/run/php/php${php_version}-fpm.sock" ]]; then
            WW_PHP_FPM_SOCK="unix:/run/php/php${php_version}-fpm.sock"
        elif [[ -S "/run/php/php-fpm.sock" ]]; then
            WW_PHP_FPM_SOCK="unix:/run/php/php-fpm.sock"
        fi
    fi
    echo -ne "PHP-FPM socket [${WW_PHP_FPM_SOCK:-unix:/run/php/php-fpm.sock}]: "
    read -r input_sock || true
    [[ -n "$input_sock" ]] && WW_PHP_FPM_SOCK="$input_sock"
    WW_PHP_FPM_SOCK="${WW_PHP_FPM_SOCK:-unix:/run/php/php-fpm.sock}"

    echo ""
    info "Domain     : $WW_DOMAIN"
    info "Deploy dir : $WW_DEPLOY_DIR"
    info "PHP-FPM    : $WW_PHP_FPM_SOCK"
    echo ""
    echo -ne "${BOLD}Write nginx config? [Y/n/0]: ${RESET}"
    read -r confirm || true
    [[ "$confirm" == "0" ]] && return
    [[ "${confirm,,}" == "n" ]] && info "Cancelled." && return

    # Rate-limit snippet
    info "Writing rate-limit zone ..."
    mkdir -p /etc/nginx/conf.d
    cat > /etc/nginx/conf.d/grin-wallet-ratelimit.conf << 'RATELIMIT'
# Grin Web Wallet API rate limit — 10 req/min per IP
limit_req_zone $binary_remote_addr zone=grin_wallet_api:10m rate=10r/m;
RATELIMIT

    # vhost
    info "Writing vhost → $WEB_WALLET_NGINX_CONF ..."
    cat > "$WEB_WALLET_NGINX_CONF" << NGINX_CONF
# Grin Web Wallet — generated by 05_grin_wallet_service.sh
server {
    listen 80;
    listen [::]:80;
    server_name $WW_DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $WW_DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$WW_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$WW_DOMAIN/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    root  $WW_DEPLOY_DIR;
    index index.html;

    auth_basic           "Grin Wallet";
    auth_basic_user_file /etc/nginx/grin-wallet.htpasswd;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options    "nosniff"                                      always;
    add_header X-Frame-Options           "DENY"                                         always;
    add_header Referrer-Policy           "no-referrer"                                  always;
    add_header Content-Security-Policy   "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self';" always;

    access_log /var/log/nginx/grin-wallet-access.log;
    error_log  /var/log/nginx/grin-wallet-error.log;

    location ~ ^/api/.*\\.php\$ {
        limit_req zone=grin_wallet_api burst=5 nodelay;
        try_files \$uri =404;
        fastcgi_pass   $WW_PHP_FPM_SOCK;
        fastcgi_param  SCRIPT_FILENAME \$document_root\$fastcgi_script_name;
        include        fastcgi_params;
    }

    location ~* \\.(css|js|ico|png|svg)\$ {
        expires 1h;
        add_header Cache-Control "public";
    }

    location / { try_files \$uri \$uri/ /index.html; }

    location = /api/config.json { deny all; }
    location ~ /\\.              { deny all; }
    location ~ ~\$               { deny all; }
}
NGINX_CONF

    mkdir -p /var/www/letsencrypt
    ln -sf "$WEB_WALLET_NGINX_CONF" "/etc/nginx/sites-enabled/grin-wallet-web" 2>/dev/null || true

    if nginx -t 2>/dev/null; then
        systemctl reload nginx
        success "nginx vhost configured and reloaded."
    else
        warn "nginx config test failed — check $WEB_WALLET_NGINX_CONF"
        warn "Note: The 443 block will fail until SSL certs exist (run step 4 next)."
    fi

    ww_save_config
    log "[ww_configure_nginx] domain=$WW_DOMAIN deploy_dir=$WW_DEPLOY_DIR"
    pause
}

# ═══════════════════════════════════════════════════════════════════════════════
# 05 M) STEP 4 — Setup SSL (Let's Encrypt)
# ═══════════════════════════════════════════════════════════════════════════════

ww_setup_ssl() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── 05 M-4) Setup SSL (Let's Encrypt) ──${RESET}\n"

    if ! command -v certbot &>/dev/null; then
        die "certbot not installed — run step 1 first."; return
    fi
    if [[ -z "$WW_DOMAIN" ]]; then
        die "Domain not configured — run step 3 first."; return
    fi
    if [[ ! -f "$WEB_WALLET_NGINX_CONF" ]]; then
        die "nginx vhost not configured — run step 3 first."; return
    fi

    echo -e "  ${DIM}DNS must point ${BOLD}$WW_DOMAIN${RESET}${DIM} to this server's public IP before continuing.${RESET}"
    echo ""
    echo -ne "Let's Encrypt email [${WW_EMAIL:-}]: "
    read -r input_email || true
    [[ -n "$input_email" ]] && WW_EMAIL="$input_email"
    [[ -z "$WW_EMAIL" ]] && warn "No email entered." && return

    echo ""
    echo -ne "${BOLD}Request SSL certificate for $WW_DOMAIN? [Y/n/0]: ${RESET}"
    read -r confirm || true
    [[ "$confirm" == "0" ]] && return
    [[ "${confirm,,}" == "n" ]] && info "Cancelled." && return

    info "Requesting certificate for $WW_DOMAIN ..."
    certbot --nginx -d "$WW_DOMAIN" --non-interactive --agree-tos -m "$WW_EMAIL" \
        && success "SSL certificate issued for $WW_DOMAIN" \
        || warn "certbot failed — ensure DNS is pointing to this server and port 80 is open."

    systemctl reload nginx 2>/dev/null || true

    ww_save_config
    log "[ww_setup_ssl] domain=$WW_DOMAIN email=$WW_EMAIL"
    pause
}

# ═══════════════════════════════════════════════════════════════════════════════
# 05 M) STEP 5 — Setup Basic Auth
# ═══════════════════════════════════════════════════════════════════════════════

ww_setup_auth() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── 05 M-5) Setup Basic Auth ──${RESET}\n"

    if ! command -v htpasswd &>/dev/null; then
        die "htpasswd not installed — run step 1 first."; return
    fi

    echo -e "  ${DIM}Basic Auth protects the wallet UI with a username + password.${RESET}"
    echo -e "  ${DIM}Run this step again at any time to change the password.${RESET}"
    echo ""
    echo -ne "Auth username [${WW_AUTH_USER:-grin}]: "
    read -r input_user || true
    [[ -n "$input_user" ]] && WW_AUTH_USER="$input_user"
    WW_AUTH_USER="${WW_AUTH_USER:-grin}"

    local htpasswd_file="/etc/nginx/grin-wallet.htpasswd"
    local htpasswd_flag="-c"
    if [[ -f "$htpasswd_file" ]]; then
        warn "Password file already exists: $htpasswd_file"
        echo -e "  ${GREEN}1${RESET}) Add / update user '${WW_AUTH_USER}'  ${DIM}(keeps other users)${RESET}"
        echo -e "  ${RED}2${RESET}) Recreate file                    ${DIM}(removes all existing users)${RESET}"
        echo -e "  ${DIM}0) Cancel${RESET}"
        echo -ne "Choice [1]: "
        read -r recreate || true
        [[ "$recreate" == "0" ]] && return
        [[ "${recreate:-1}" == "2" ]] && htpasswd_flag="-c" || htpasswd_flag=""
    fi

    echo ""
    info "Setting password for user '${WW_AUTH_USER}' — enter password at the prompt:"
    # shellcheck disable=SC2086
    htpasswd $htpasswd_flag "$htpasswd_file" "$WW_AUTH_USER" \
        && success "Basic Auth configured for user '$WW_AUTH_USER'." \
        || { die "htpasswd failed."; return; }

    nginx -t 2>/dev/null && systemctl reload nginx 2>/dev/null || true

    ww_save_config
    log "[ww_setup_auth] user=$WW_AUTH_USER"
    pause
}

# ═══════════════════════════════════════════════════════════════════════════════
# 05 M) STEP 6 — Configure firewall
# ═══════════════════════════════════════════════════════════════════════════════

ww_configure_firewall() {
    clear
    echo -e "\n${BOLD}${CYAN}── 05 M-6) Configure Firewall ──${RESET}\n"
    echo -e "  ${DIM}Opens port 443 (HTTPS) and 80 (HTTP → redirect + certbot renewal).${RESET}"
    echo -e "  ${DIM}Wallet API ports (3415/13415) stay on localhost — NOT opened publicly.${RESET}"
    echo ""
    echo -ne "${BOLD}Open ports 80 and 443 in the firewall? [Y/n/0]: ${RESET}"
    read -r confirm || true
    [[ "$confirm" == "0" ]] && return
    [[ "${confirm,,}" == "n" ]] && info "Cancelled." && return

    if command -v ufw &>/dev/null; then
        ufw allow 443/tcp && success "UFW: port 443 opened."
        ufw allow 80/tcp  && success "UFW: port 80 opened."
    elif command -v iptables &>/dev/null; then
        iptables -I INPUT -p tcp --dport 443 -j ACCEPT
        iptables -I INPUT -p tcp --dport 80  -j ACCEPT
        success "iptables: ports 80 and 443 opened."
        warn "iptables rules are not persistent. Use iptables-persistent to save them."
    else
        warn "No firewall tool found (ufw / iptables). Open ports 80 and 443 manually."
    fi
    log "[ww_configure_firewall] completed"
    pause
}

# ═══════════════════════════════════════════════════════════════════════════════
# 05 M) STEP 7 — Status & info
# ═══════════════════════════════════════════════════════════════════════════════

ww_show_info() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── 05 M-7) Status & Info ──${RESET}\n"

    # Dependencies
    local deps_ok=1
    for cmd in nginx php certbot htpasswd; do
        command -v "$cmd" &>/dev/null || { deps_ok=0; break; }
    done
    [[ $deps_ok -eq 1 ]] && echo -e "  ${BOLD}Dependencies${RESET}  : ${GREEN}all present${RESET}" \
                         || echo -e "  ${BOLD}Dependencies${RESET}  : ${RED}some missing${RESET}  ${DIM}(step 1)${RESET}"

    command -v qrencode &>/dev/null \
        && echo -e "  ${BOLD}qrencode${RESET}      : ${GREEN}installed${RESET}" \
        || echo -e "  ${BOLD}qrencode${RESET}      : ${YELLOW}not installed${RESET}  ${DIM}QR codes will be hidden${RESET}"

    # Files
    [[ -d "$WW_DEPLOY_DIR" ]] \
        && echo -e "  ${BOLD}Files${RESET}         : ${GREEN}deployed${RESET}  ${DIM}($WW_DEPLOY_DIR)${RESET}" \
        || echo -e "  ${BOLD}Files${RESET}         : ${RED}not deployed${RESET}  ${DIM}(step 2)${RESET}"

    # nginx
    [[ -f "$WEB_WALLET_NGINX_CONF" ]] \
        && echo -e "  ${BOLD}nginx vhost${RESET}   : ${GREEN}configured${RESET}  ${DIM}($WEB_WALLET_NGINX_CONF)${RESET}" \
        || echo -e "  ${BOLD}nginx vhost${RESET}   : ${RED}not configured${RESET}  ${DIM}(step 3)${RESET}"

    # SSL
    if [[ -n "$WW_DOMAIN" && -f "/etc/letsencrypt/live/$WW_DOMAIN/fullchain.pem" ]]; then
        local cert_expiry
        cert_expiry=$(openssl x509 -enddate -noout \
            -in "/etc/letsencrypt/live/$WW_DOMAIN/fullchain.pem" 2>/dev/null \
            | sed 's/notAfter=//' || echo "unknown")
        echo -e "  ${BOLD}SSL cert${RESET}      : ${GREEN}issued${RESET}  ${DIM}(expires: $cert_expiry)${RESET}"
    else
        echo -e "  ${BOLD}SSL cert${RESET}      : ${RED}not issued${RESET}  ${DIM}(step 4)${RESET}"
    fi

    # Auth
    [[ -f "/etc/nginx/grin-wallet.htpasswd" ]] \
        && echo -e "  ${BOLD}Basic Auth${RESET}    : ${GREEN}configured${RESET}  ${DIM}(user: ${WW_AUTH_USER:-grin})${RESET}" \
        || echo -e "  ${BOLD}Basic Auth${RESET}    : ${RED}not configured${RESET}  ${DIM}(step 5)${RESET}"

    # Live
    if [[ -f "/etc/nginx/sites-enabled/grin-wallet-web" ]]; then
        echo -e "  ${BOLD}Web UI${RESET}        : ${GREEN}LIVE${RESET}  ${DIM}→ https://${WW_DOMAIN:-<domain>}${RESET}"
    else
        echo -e "  ${BOLD}Web UI${RESET}        : ${RED}not live${RESET}  ${DIM}(complete steps 3-5)${RESET}"
    fi

    # Wallet listener
    if tmux has-session -t "grin_wallet_mainnet" 2>/dev/null || \
       tmux has-session -t "grin_wallet_testnet" 2>/dev/null; then
        echo -e "  ${BOLD}Wallet listener${RESET}: ${GREEN}running${RESET}"
    else
        echo -e "  ${BOLD}Wallet listener${RESET}: ${RED}not running${RESET}  ${YELLOW}⚠ start via option (c)${RESET}"
    fi

    echo ""
    [[ -n "$WW_DOMAIN" ]] && echo -e "  URL: ${BOLD}${GREEN}https://$WW_DOMAIN${RESET}"
    echo ""
    pause
}

# ═══════════════════════════════════════════════════════════════════════════════
# 05 M) STEP s — Edit saved settings
# ═══════════════════════════════════════════════════════════════════════════════

ww_edit_settings() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── 05 M-s) Edit Saved Settings ──${RESET}\n"
    echo -e "  ${DIM}Press Enter to keep the current value.${RESET}"
    echo ""

    echo -ne "Domain           [${WW_DOMAIN:-}]: "
    read -r v || true; [[ -n "$v" ]] && WW_DOMAIN="$v"

    echo -ne "Deploy directory [${WW_DEPLOY_DIR}]: "
    read -r v || true; [[ -n "$v" ]] && WW_DEPLOY_DIR="$v"

    echo -ne "PHP-FPM socket   [${WW_PHP_FPM_SOCK:-}]: "
    read -r v || true; [[ -n "$v" ]] && WW_PHP_FPM_SOCK="$v"

    echo -ne "Auth username    [${WW_AUTH_USER}]: "
    read -r v || true; [[ -n "$v" ]] && WW_AUTH_USER="$v"

    echo -ne "Let's Encrypt email [${WW_EMAIL:-}]: "
    read -r v || true; [[ -n "$v" ]] && WW_EMAIL="$v"

    ww_save_config
    success "Settings saved to $WW_CONF_FILE"
    pause
}

# ═══════════════════════════════════════════════════════════════════════════════
# 05 M) WEB WALLET INTERFACE — Submenu
# ═══════════════════════════════════════════════════════════════════════════════

show_web_wallet_status() {
    ww_load_config
    echo -e "\n${BOLD}Status:${RESET}\n"

    # Dependencies
    local deps_ok=1
    for cmd in nginx php certbot htpasswd; do
        command -v "$cmd" &>/dev/null || { deps_ok=0; break; }
    done
    [[ $deps_ok -eq 1 ]] && echo -e "  ${BOLD}1 Dependencies${RESET}  : ${GREEN}OK${RESET}" \
                         || echo -e "  ${BOLD}1 Dependencies${RESET}  : ${RED}missing${RESET}  ${DIM}→ run step 1${RESET}"

    [[ -d "$WW_DEPLOY_DIR" ]] \
        && echo -e "  ${BOLD}2 Files${RESET}         : ${GREEN}deployed${RESET}  ${DIM}($WW_DEPLOY_DIR)${RESET}" \
        || echo -e "  ${BOLD}2 Files${RESET}         : ${DIM}not deployed${RESET}  ${DIM}→ run step 2${RESET}"

    [[ -f "$WEB_WALLET_NGINX_CONF" ]] \
        && echo -e "  ${BOLD}3 nginx vhost${RESET}   : ${GREEN}configured${RESET}" \
        || echo -e "  ${BOLD}3 nginx vhost${RESET}   : ${DIM}not configured${RESET}  ${DIM}→ run step 3${RESET}"

    if [[ -n "$WW_DOMAIN" && -f "/etc/letsencrypt/live/$WW_DOMAIN/fullchain.pem" ]]; then
        echo -e "  ${BOLD}4 SSL cert${RESET}      : ${GREEN}issued${RESET}  ${DIM}($WW_DOMAIN)${RESET}"
    else
        echo -e "  ${BOLD}4 SSL cert${RESET}      : ${DIM}not issued${RESET}  ${DIM}→ run step 4${RESET}"
    fi

    [[ -f "/etc/nginx/grin-wallet.htpasswd" ]] \
        && echo -e "  ${BOLD}5 Basic Auth${RESET}    : ${GREEN}configured${RESET}  ${DIM}(user: ${WW_AUTH_USER:-grin})${RESET}" \
        || echo -e "  ${BOLD}5 Basic Auth${RESET}    : ${DIM}not configured${RESET}  ${DIM}→ run step 5${RESET}"

    if [[ -f "/etc/nginx/sites-enabled/grin-wallet-web" ]]; then
        echo -e "  ${BOLD}Web UI${RESET}          : ${GREEN}LIVE${RESET}  ${DIM}https://${WW_DOMAIN:-<domain>}${RESET}"
    else
        echo -e "  ${BOLD}Web UI${RESET}          : ${DIM}not live${RESET}"
    fi
    echo ""
}

web_wallet_menu() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN} 05 W) WEB WALLET INTERFACE${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        show_web_wallet_status

        echo -e "${DIM}  ─── First-time setup (run in order) ─────────────${RESET}"
        echo -e "  ${GREEN}1${RESET}) Install dependencies    ${DIM}(nginx, php, certbot, htpasswd, qrencode)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Deploy files            ${DIM}(copy web/05_wallet/ → deploy directory)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Configure nginx         ${DIM}(vhost + rate-limit + security headers)${RESET}"
        echo -e "  ${GREEN}4${RESET}) Setup SSL               ${DIM}(Let's Encrypt — DNS must point here first)${RESET}"
        echo -e "  ${GREEN}5${RESET}) Setup Basic Auth        ${DIM}(set / change password)${RESET}"
        echo -e "  ${GREEN}6${RESET}) Configure firewall      ${DIM}(open ports 80 and 443)${RESET}"
        echo ""
        echo -e "${DIM}  ─── Info ─────────────────────────────────────────${RESET}"
        echo -e "  ${CYAN}7${RESET}) Status & info           ${DIM}(URLs, cert expiry, service health)${RESET}"
        echo -e "  ${CYAN}s${RESET}) Edit saved settings     ${DIM}(domain, directory, email, username)${RESET}"
        echo ""
        echo -e "  ${DIM}↩  Press Enter to refresh${RESET}"
        echo -e "  ${RED}0${RESET}) Back to wallet menu"
        echo ""
        echo -ne "${BOLD}Select [1-7 / s / 0]: ${RESET}"
        read -r ww_choice || true

        case "$ww_choice" in
            1) ww_install_deps ;;
            2) ww_deploy_files ;;
            3) ww_configure_nginx ;;
            4) ww_setup_ssl ;;
            5) ww_setup_auth ;;
            6) ww_configure_firewall ;;
            7) ww_show_info ;;
            s) ww_edit_settings ;;
            0) break ;;
            "") continue ;;
            *) warn "Invalid option." ; sleep 1 ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# MENUS
# ═══════════════════════════════════════════════════════════════════════════════

show_network_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 05) GRIN WALLET SERVICE${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    local mainnet_up=0 testnet_up=0
    ss -tlnp 2>/dev/null | grep -q ":3413 "  && mainnet_up=1
    ss -tlnp 2>/dev/null | grep -q ":13413 " && testnet_up=1
    local mn_node tn_node
    [[ $mainnet_up -eq 1 ]] && mn_node="${GREEN}node RUNNING${RESET}" || mn_node="${RED}node down${RESET}"
    [[ $testnet_up -eq 1 ]] && tn_node="${GREEN}node RUNNING${RESET}" || tn_node="${RED}node down${RESET}"

    echo -e "  ${GREEN}1${RESET}) Mainnet wallet  ${DIM}($mn_node${DIM})${RESET}"
    echo -e "  ${YELLOW}2${RESET}) Testnet wallet  ${DIM}($tn_node${DIM})${RESET}"
    echo ""
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -ne "${BOLD}Select network [1/2/0]: ${RESET}"
}

show_wallet_menu() {
    clear
    local net_label="${NETWORK^}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 05) GRIN WALLET SERVICE  [${net_label}]${RESET}"
    echo -e "${BOLD}${GREEN}  Disclaimer: Always store your seed phrase safely!${RESET}"
    echo -e "${BOLD}${YELLOW}  This tool is for testing and development purposes!${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    show_status

    local fa_port; [[ "$NETWORK" == "mainnet" ]] && fa_port=3415 || fa_port=13415

    echo -e "${DIM}  ─── Setup ────────────────────────────────────────${RESET}"
    echo -e "  ${GREEN}a${RESET}) Download & install grin-wallet"
    echo -e "  ${GREEN}b${RESET}) Initialize wallet               ${DIM}(grin-wallet init)${RESET}"
    echo -e "  ${GREEN}c${RESET}) Start wallet listener           ${DIM}(grin-wallet listen, tmux)${RESET}"
    echo ""
    echo -e "${DIM}  ─── Foreign API ──────────────────────────────────${RESET}"
    echo -e "  ${GREEN}d${RESET}) Enable Wallet Foreign API       ${DIM}(port $fa_port — localhost only)${RESET}"
    echo -e "  ${RED}e${RESET}) Disable Wallet Foreign API"
    echo ""
    echo -e "${DIM}  ─── Web Interface ────────────────────────────────${RESET}"
    echo -e "  ${CYAN}w${RESET}) Web Wallet Interface            ${DIM}(nginx + PHP + HTTPS + Basic Auth)${RESET}"
    echo ""
    echo -e "  ${DIM}↩  Press Enter to refresh status${RESET}"
    echo -e "  ${RED}0${RESET}) Back to network select"
    echo ""
    echo -ne "${BOLD}Select [a-e / w / 0]: ${RESET}"
}

main() {
    while true; do
        show_network_menu
        read -r net_choice || true

        case "$net_choice" in
            0) break ;;
            "") continue ;;
            1|2)
                if [[ "$net_choice" == "2" ]]; then
                    NETWORK="testnet"; NODE_PORT=13413
                    WALLET_BIN="$WALLET_BIN_TESTNET"
                    WALLET_DIR="$WALLET_BIN_DIR_TESTNET"
                    GRIN_WALLET_TOML="$GRIN_WALLET_TOML_TESTNET"
                    WALLET_NGINX_CONF="$WALLET_NGINX_CONF_TESTNET"
                else
                    NETWORK="mainnet"; NODE_PORT=3413
                    WALLET_BIN="$WALLET_BIN_MAINNET"
                    WALLET_DIR="$WALLET_BIN_DIR_MAINNET"
                    GRIN_WALLET_TOML="$GRIN_WALLET_TOML_MAINNET"
                    WALLET_NGINX_CONF="$WALLET_NGINX_CONF_MAINNET"
                fi

                while true; do
                    show_wallet_menu
                    read -r choice || true

                    case "$choice" in
                        a) download_wallet ;;
                        b) init_wallet ;;
                        c) start_wallet ;;
                        d) enable_foreign_api ;;
                        e) disable_foreign_api ;;
                        w) web_wallet_menu ;;
                        0) break ;;
                        "") continue ;;
                        *) warn "Invalid option." ; sleep 1 ;;
                    esac

                    echo ""
                    echo "Press Enter to continue..."
                    read -r || true
                done
                ;;
            *) warn "Invalid option." ; sleep 1 ;;
        esac
    done
}

main "$@"
