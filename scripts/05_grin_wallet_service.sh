#!/bin/bash
# =============================================================================
# 05_grin_wallet_service.sh - Grin Wallet Service
# =============================================================================
# Manages the complete grin-wallet lifecycle:
#   1) Download & install grin-wallet  (mainnet → /grinwalletmain  |  testnet → /grinwallettest)
#   2) Initialize wallet               (grin-wallet init — runs inline in current terminal)
#   3) Start wallet listener           (grin-wallet listen, in tmux)
#   4) Enable Wallet Foreign API       (port 3415) — allow HTTP payments
#   5) Disable Wallet Foreign API
#   6) Configure nginx proxy           (wallet, HTTPS)
#   7) Configure firewall rules        (port 3415)
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
FOREIGN_API_PORT=3415
GRIN_WALLET_GITHUB_API="https://api.github.com/repos/mimblewimble/grin-wallet/releases/latest"

# Per-network binary directories (mirrors grin node dirs: /grinfullmain, /grinprunemain, …)
WALLET_BIN_DIR_MAINNET="/grinwalletmain"
WALLET_BIN_DIR_TESTNET="/grinwallettest"
WALLET_BIN_MAINNET="$WALLET_BIN_DIR_MAINNET/grin-wallet"
WALLET_BIN_TESTNET="$WALLET_BIN_DIR_TESTNET/grin-wallet"

# grin-wallet.toml lives inside the top-level-dir (same as the binary dir)
GRIN_WALLET_TOML_MAINNET="$WALLET_BIN_DIR_MAINNET/grin-wallet.toml"
GRIN_WALLET_TOML_TESTNET="$WALLET_BIN_DIR_TESTNET/grin-wallet.toml"

LOG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/log"
LOG_FILE="$LOG_DIR/grin_wallet_service_$(date +%Y%m%d_%H%M%S).log"
WALLET_NGINX_CONF_MAINNET="/etc/nginx/sites-available/grin-wallet-mainnet"
WALLET_NGINX_CONF_TESTNET="/etc/nginx/sites-available/grin-wallet-testnet"

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

# ─── Port guide popup ─────────────────────────────────────────────────────────
show_port_guide() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  PORT GUIDE — Read before continuing${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  ${BOLD}PORT 3415 — Wallet Foreign API (HTTP transaction listener)${RESET}"
    echo ""
    echo -e "  ${CYAN}What it does${RESET} : Allows other users to send you Grin transactions via HTTP."
    echo -e "  ${CYAN}Who needs it${RESET} : Users who want to receive Grin via the HTTP method."
    echo -e "  ${CYAN}Expose via${RESET}   : Direct or via nginx HTTPS reverse proxy with SSL."
    echo -e "  ${GREEN}Expose if${RESET}    : You want to receive Grin over HTTP (e.g. running a payment"
    echo -e "               service or accepting donations via the HTTP wallet method)."
    echo -e "  ${YELLOW}Skip if${RESET}      : You receive Grin via Tor or Slatepack (the modern methods),"
    echo -e "               or if you are running a node without a wallet service."
    echo -e "  ${DIM}Mining note${RESET}  : If you run a mining pool, port 3415 stays on localhost."
    echo -e "               Paying out miners is done by your pool software — port 3415"
    echo -e "               does not need to be public."
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

# ─── Node / network detection ─────────────────────────────────────────────────
# Sets: NETWORK  NODE_PORT  WALLET_BIN  WALLET_DIR  GRIN_WALLET_TOML  WALLET_NGINX_CONF
detect_and_select_network() {
    local mainnet_up=0 testnet_up=0
    ss -tlnp 2>/dev/null | grep -q ":3413 "  && mainnet_up=1
    ss -tlnp 2>/dev/null | grep -q ":13413 " && testnet_up=1

    echo -e "${BOLD}Detected Grin nodes:${RESET}"
    [[ $mainnet_up -eq 1 ]] && echo -e "  ${GREEN}✓${RESET} Mainnet node  (port 3413)" \
                             || echo -e "  ${DIM}✗ Mainnet node  (port 3413 — not listening)${RESET}"
    [[ $testnet_up -eq 1 ]] && echo -e "  ${GREEN}✓${RESET} Testnet node  (port 13413)" \
                             || echo -e "  ${DIM}✗ Testnet node  (port 13413 — not listening)${RESET}"
    echo ""

    if [[ $mainnet_up -eq 1 && $testnet_up -eq 0 ]]; then
        NETWORK="mainnet"
        NODE_PORT=3413
        echo -e "  ${DIM}Auto-selected: mainnet${RESET}"
    elif [[ $mainnet_up -eq 0 && $testnet_up -eq 1 ]]; then
        NETWORK="testnet"
        NODE_PORT=13413
        echo -e "  ${DIM}Auto-selected: testnet${RESET}"
    else
        [[ $mainnet_up -eq 0 && $testnet_up -eq 0 ]] && \
            warn "No Grin node detected. Wallet will not connect until a node is running."
        echo -e "  ${GREEN}1${RESET}) Mainnet  ${DIM}(port 3413)${RESET}  ${DIM}[default]${RESET}"
        echo -e "  ${YELLOW}2${RESET}) Testnet  ${DIM}(port 13413)${RESET}"
        echo -e "  ${DIM}0) Cancel${RESET}"
        echo -ne "Select network [1]: "
        read -r net_choice || true
        [[ "$net_choice" == "0" ]] && return 1
        case "${net_choice:-1}" in
            2) NETWORK="testnet";  NODE_PORT=13413 ;;
            *) NETWORK="mainnet";  NODE_PORT=3413   ;;
        esac
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
    echo ""
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

    # ── Binaries ──
    if [[ -x "$WALLET_BIN_MAINNET" ]]; then
        local ver_main
        ver_main=$("$WALLET_BIN_MAINNET" --version 2>/dev/null | head -1 || echo "unknown version")
        echo -e "  ${BOLD}grin-wallet (mainnet)${RESET} : ${GREEN}INSTALLED${RESET}  ${DIM}($ver_main — $WALLET_BIN_MAINNET)${RESET}"
    else
        echo -e "  ${BOLD}grin-wallet (mainnet)${RESET} : ${RED}NOT FOUND${RESET}  ${DIM}($WALLET_BIN_MAINNET)${RESET}"
    fi

    if [[ -x "$WALLET_BIN_TESTNET" ]]; then
        local ver_test
        ver_test=$("$WALLET_BIN_TESTNET" --version 2>/dev/null | head -1 || echo "unknown version")
        echo -e "  ${BOLD}grin-wallet (testnet)${RESET} : ${GREEN}INSTALLED${RESET}  ${DIM}($ver_test — $WALLET_BIN_TESTNET)${RESET}"
    else
        echo -e "  ${BOLD}grin-wallet (testnet)${RESET} : ${RED}NOT FOUND${RESET}  ${DIM}($WALLET_BIN_TESTNET)${RESET}"
    fi

    # ── Wallet configs ──
    if [[ -f "$GRIN_WALLET_TOML_MAINNET" ]]; then
        echo -e "  ${BOLD}Mainnet wallet config${RESET} : ${GREEN}INITIALIZED${RESET}  ${DIM}($GRIN_WALLET_TOML_MAINNET)${RESET}"
    else
        echo -e "  ${BOLD}Mainnet wallet config${RESET} : ${DIM}not initialized${RESET}"
    fi
    if [[ -f "$GRIN_WALLET_TOML_TESTNET" ]]; then
        echo -e "  ${BOLD}Testnet wallet config${RESET} : ${GREEN}INITIALIZED${RESET}  ${DIM}($GRIN_WALLET_TOML_TESTNET)${RESET}"
    else
        echo -e "  ${BOLD}Testnet wallet config${RESET} : ${DIM}not initialized${RESET}"
    fi

    # ── Listeners (tmux sessions) ──
    local mn_session="grin-wallet-mainnet"
    local tn_session="grin-wallet-testnet"
    if tmux has-session -t "$mn_session" 2>/dev/null; then
        echo -e "  ${BOLD}Wallet listener${RESET} (mainnet)  : ${GREEN}RUNNING${RESET}  ${DIM}(tmux: $mn_session)${RESET}"
    else
        echo -e "  ${BOLD}Wallet listener${RESET} (mainnet)  : ${DIM}not running${RESET}"
    fi
    if tmux has-session -t "$tn_session" 2>/dev/null; then
        echo -e "  ${BOLD}Wallet listener${RESET} (testnet)  : ${GREEN}RUNNING${RESET}  ${DIM}(tmux: $tn_session)${RESET}"
    else
        echo -e "  ${BOLD}Wallet listener${RESET} (testnet)  : ${DIM}not running${RESET}"
    fi

    # ── Foreign API ──
    local main_fa_status
    main_fa_status="$(get_foreign_api_status "$GRIN_WALLET_TOML_MAINNET")"
    if [[ "$main_fa_status" == "true" ]]; then
        echo -e "  ${BOLD}Foreign API${RESET} (mainnet)       : ${GREEN}ENABLED${RESET}  in grin-wallet.toml"
    else
        echo -e "  ${BOLD}Foreign API${RESET} (mainnet)       : ${DIM}disabled / unknown${RESET}"
    fi

    # ── nginx proxy ──
    if [[ -f "/etc/nginx/sites-enabled/grin-wallet-mainnet" ]]; then
        echo -e "  ${BOLD}nginx proxy${RESET} (mainnet)       : ${GREEN}CONFIGURED${RESET}"
    else
        echo -e "  ${BOLD}nginx proxy${RESET} (mainnet)       : ${DIM}not configured${RESET}"
    fi
    echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
# OPTION 1 — DOWNLOAD & INSTALL GRIN-WALLET
# ═══════════════════════════════════════════════════════════════════════════════

download_wallet() {
    echo -e "\n${BOLD}${CYAN}── Download & Install grin-wallet ──${RESET}\n"

    # Select target network
    echo -e "  ${GREEN}1${RESET}) Mainnet  → install to ${BOLD}$WALLET_BIN_DIR_MAINNET${RESET}  ${DIM}[default]${RESET}"
    echo -e "  ${YELLOW}2${RESET}) Testnet  → install to ${BOLD}$WALLET_BIN_DIR_TESTNET${RESET}"
    echo -e "  ${DIM}0) Cancel${RESET}"
    echo -ne "Select network [1]: "
    read -r net_choice || true
    [[ "$net_choice" == "0" ]] && return
    local target_dir target_bin target_net
    case "${net_choice:-1}" in
        2) target_dir="$WALLET_BIN_DIR_TESTNET"; target_bin="$WALLET_BIN_TESTNET"; target_net="testnet" ;;
        *) target_dir="$WALLET_BIN_DIR_MAINNET"; target_bin="$WALLET_BIN_MAINNET"; target_net="mainnet" ;;
    esac
    echo ""

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
        die "No linux-x86_64 tar.gz asset found in GitHub release '$version'."; return
    fi

    info "Latest version : $version"
    info "Download URL   : $download_url"
    info "Install target : $target_bin"
    echo ""

    local tmp_tar="/tmp/grin_wallet_$$.tar.gz"
    local tmp_dir="/tmp/grin_wallet_extract_$$"
    mkdir -p "$tmp_dir"

    info "Downloading grin-wallet..."
    wget -c --progress=bar:force -O "$tmp_tar" "$download_url" \
        || { die "Download failed."; rm -rf "$tmp_tar" "$tmp_dir"; return; }

    info "Extracting archive..."
    tar -xzf "$tmp_tar" -C "$tmp_dir" \
        || { die "Failed to extract archive."; rm -rf "$tmp_tar" "$tmp_dir"; return; }
    rm -f "$tmp_tar"

    local wallet_bin_src
    wallet_bin_src=$(find "$tmp_dir" -type f -name "grin-wallet" | head -1)
    if [[ -z "$wallet_bin_src" ]]; then
        die "Could not locate 'grin-wallet' binary in downloaded archive."
        rm -rf "$tmp_dir"; return
    fi

    mkdir -p "$target_dir"
    install -m 755 "$wallet_bin_src" "$target_bin"
    rm -rf "$tmp_dir"

    success "grin-wallet $version installed to $target_bin"
    log "[OPT 1] Version=$version Network=$target_net Binary=$target_bin"
}

# ═══════════════════════════════════════════════════════════════════════════════
# OPTION 2 — INITIALIZE WALLET  (runs inline in current terminal)
# ═══════════════════════════════════════════════════════════════════════════════

init_wallet() {
    echo -e "\n${BOLD}${CYAN}── Initialize Wallet ──${RESET}\n"

    detect_and_select_network || return

    if [[ ! -x "$WALLET_BIN" ]]; then
        warn "grin-wallet binary not found at $WALLET_BIN"
        warn "Run option 1 first to download and install grin-wallet for $NETWORK."
        return
    fi

    if [[ -f "$GRIN_WALLET_TOML" ]]; then
        warn "Wallet already initialized at: $GRIN_WALLET_TOML"
        echo -ne "Re-initialize? This will overwrite the existing wallet data! [y/N/0]: "
        read -r reinit || true
        [[ "$reinit" == "0" ]] && return
        [[ "${reinit,,}" != "y" ]] && info "Cancelled." && return
    fi

    info "Binary : $WALLET_BIN"
    info "Dir    : $WALLET_DIR"
    echo ""
    info "Running grin-wallet init inline — you will be prompted to enter and confirm a wallet password."
    echo ""

    cd "$WALLET_DIR" && "$WALLET_BIN" --top-level-dir "$WALLET_DIR" init
    local rc=$?
    echo ""

    if [[ $rc -ne 0 || ! -f "$GRIN_WALLET_TOML" ]]; then
        warn "Init may have failed (exit code $rc). Check output above."
        warn "Manual command: cd $WALLET_DIR && $WALLET_BIN --top-level-dir $WALLET_DIR init"
        return
    fi

    success "Wallet initialized. Config: $GRIN_WALLET_TOML"

    # Patch check_node_api_http_addr to point at the detected/selected node
    info "Patching grin-wallet.toml: check_node_api_http_addr → http://127.0.0.1:$NODE_PORT"
    if grep -q "check_node_api_http_addr" "$GRIN_WALLET_TOML"; then
        sed -i "s|check_node_api_http_addr\s*=.*|check_node_api_http_addr = \"http://127.0.0.1:$NODE_PORT\"|" \
            "$GRIN_WALLET_TOML"
    else
        echo "check_node_api_http_addr = \"http://127.0.0.1:$NODE_PORT\"" >> "$GRIN_WALLET_TOML"
    fi
    success "check_node_api_http_addr patched to 127.0.0.1:$NODE_PORT"
    log "[OPT 2] Wallet initialized for $NETWORK node=127.0.0.1:$NODE_PORT toml=$GRIN_WALLET_TOML"
}

# ═══════════════════════════════════════════════════════════════════════════════
# OPTION 3 — START WALLET LISTENER
# ═══════════════════════════════════════════════════════════════════════════════

start_wallet() {
    echo -e "\n${BOLD}${CYAN}── Start Wallet Listener ──${RESET}\n"

    detect_and_select_network || return

    if [[ ! -x "$WALLET_BIN" ]]; then
        warn "grin-wallet binary not found at $WALLET_BIN"
        warn "Run option 1 first to download and install grin-wallet for $NETWORK."
        return
    fi

    if [[ ! -f "$GRIN_WALLET_TOML" ]]; then
        warn "Wallet not initialized. Run option 2 first."
        return
    fi

    if ! command -v tmux &>/dev/null; then
        warn "tmux is not installed. Install it with: apt-get install tmux"
        return
    fi

    local session="grin-wallet-$NETWORK"

    if tmux has-session -t "$session" 2>/dev/null; then
        warn "Existing tmux session '$session' found."
        echo -ne "Kill it and restart? [y/N/0]: "
        read -r restart_choice || true
        [[ "$restart_choice" == "0" ]] && info "Keeping existing session. Attach with: tmux attach -t $session" && return
        if [[ "${restart_choice,,}" == "y" ]]; then
            tmux kill-session -t "$session"
            success "Existing session stopped."
        else
            info "Keeping existing session. Attach with: tmux attach -t $session"
            return
        fi
    fi

    info "Starting grin-wallet listen in tmux session: $session"
    tmux new-session -d -s "$session" -c "$WALLET_DIR" \
        "bash -c \"'$WALLET_BIN' --top-level-dir '$WALLET_DIR' listen; echo ''; echo 'Wallet listener exited. Press Enter to close.'; read\""

    sleep 1
    if tmux has-session -t "$session" 2>/dev/null; then
        success "Wallet listener started in tmux session: $session"
        info "View  : tmux attach -t $session"
        info "Detach: Ctrl+B then D"
    else
        warn "tmux session did not persist — wallet may have exited immediately."
        warn "Try running manually: $WALLET_BIN --top-level-dir $WALLET_DIR listen"
    fi

    log "[OPT 3] Wallet listener started: session=$session network=$NETWORK"
}

# ═══════════════════════════════════════════════════════════════════════════════
# OPTIONS 4-7 — WALLET FOREIGN API (PORT 3415)
# ═══════════════════════════════════════════════════════════════════════════════

enable_foreign_api() {
    show_port_guide || return
    echo -e "\n${BOLD}${CYAN}── Enable Wallet Foreign API ──${RESET}\n"

    detect_and_select_network || return

    if [[ ! -f "$GRIN_WALLET_TOML" ]]; then
        warn "Wallet config not found at $GRIN_WALLET_TOML"
        warn "Initialize the wallet first (option 2)."
        return
    fi

    info "Updating $GRIN_WALLET_TOML ..."
    cp "$GRIN_WALLET_TOML" "${GRIN_WALLET_TOML}.bak.$(date +%s)"

    if grep -q "owner_api_include_foreign" "$GRIN_WALLET_TOML"; then
        sed -i 's/owner_api_include_foreign\s*=.*/owner_api_include_foreign = true/' "$GRIN_WALLET_TOML"
    else
        sed -i '/^\[wallet\]/a owner_api_include_foreign = true' "$GRIN_WALLET_TOML" || \
            echo 'owner_api_include_foreign = true' >> "$GRIN_WALLET_TOML"
    fi

    echo -ne "Make Wallet Foreign API listen on all interfaces (0.0.0.0:$FOREIGN_API_PORT)? [y/N/0]: "
    read -r all_iface || true
    [[ "$all_iface" == "0" ]] && return
    if [[ "${all_iface,,}" == "y" ]]; then
        if grep -q "api_listen_interface" "$GRIN_WALLET_TOML"; then
            sed -i "s/api_listen_interface\s*=.*/api_listen_interface = \"0.0.0.0\"/" "$GRIN_WALLET_TOML"
        else
            sed -i '/^\[wallet\]/a api_listen_interface = "0.0.0.0"' "$GRIN_WALLET_TOML" || \
                echo 'api_listen_interface = "0.0.0.0"' >> "$GRIN_WALLET_TOML"
        fi
    fi

    success "Wallet Foreign API enabled in grin-wallet.toml"
    warn "Restart the wallet listener (option 3) for the change to take effect."
    log "Wallet Foreign API enabled for $NETWORK."

    configure_firewall_foreign
    offer_nginx_proxy
}

disable_foreign_api() {
    echo -e "\n${BOLD}${CYAN}── Disable Wallet Foreign API ──${RESET}\n"

    detect_and_select_network || return

    if [[ ! -f "$GRIN_WALLET_TOML" ]]; then
        warn "Wallet config not found at $GRIN_WALLET_TOML"
        return
    fi

    cp "$GRIN_WALLET_TOML" "${GRIN_WALLET_TOML}.bak.$(date +%s)"
    sed -i 's/owner_api_include_foreign\s*=.*/owner_api_include_foreign = false/' "$GRIN_WALLET_TOML"
    success "Wallet Foreign API disabled in grin-wallet.toml"
    warn "Restart the wallet listener (option 3) for the change to take effect."
    log "Wallet Foreign API disabled for $NETWORK."

    echo -ne "Remove firewall rules for port $FOREIGN_API_PORT? [y/N/0]: "
    read -r remove_fw || true
    [[ "$remove_fw" == "0" ]] && return
    if [[ "${remove_fw,,}" == "y" ]]; then
        if command -v ufw &>/dev/null; then
            ufw delete allow "$FOREIGN_API_PORT/tcp" 2>/dev/null || true
            success "UFW rule removed for port $FOREIGN_API_PORT"
        elif command -v iptables &>/dev/null; then
            iptables -D INPUT -p tcp --dport "$FOREIGN_API_PORT" -j ACCEPT 2>/dev/null || true
            success "iptables rule removed for port $FOREIGN_API_PORT"
        fi
    fi
}

offer_nginx_proxy() {
    echo ""
    echo -ne "${BOLD}Set up nginx reverse proxy for Wallet Foreign API (with SSL)? [y/N/0]: ${RESET}"
    read -r use_nginx || true
    [[ "${use_nginx,,}" != "y" ]] && return

    echo -ne "Domain name for the Wallet Foreign API (e.g. wallet.mynode.example.com) or 0 to cancel: "
    read -r domain || true
    [[ "$domain" == "0" ]] && return
    [[ -z "$domain" ]] && warn "No domain entered. Skipping nginx setup." && return

    echo -ne "Email for Let's Encrypt SSL certificate (or 0 to cancel): "
    read -r email || true
    [[ "$email" == "0" ]] && return
    [[ -z "$email" ]] && warn "No email entered. Skipping nginx setup." && return

    if ! command -v nginx &>/dev/null; then
        warn "nginx is not installed. Install it first via the 'Manage Nginx Server' menu option."
        return
    fi
    if ! command -v certbot &>/dev/null; then
        warn "certbot is not installed. Install it with: apt-get install certbot python3-certbot-nginx"
        return
    fi

    local nginx_symlink="/etc/nginx/sites-enabled/grin-wallet-$NETWORK"

    cat > "$WALLET_NGINX_CONF" << EOF
server {
    listen 80;
    server_name $domain;
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name $domain;

    ssl_certificate     /etc/letsencrypt/live/$domain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$domain/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;

    location / {
        proxy_pass         http://127.0.0.1:$FOREIGN_API_PORT;
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300;
    }
}
EOF

    ln -sf "$WALLET_NGINX_CONF" "$nginx_symlink" 2>/dev/null || true
    nginx -t && systemctl reload nginx
    certbot --nginx -d "$domain" --non-interactive --agree-tos -m "$email"
    systemctl reload nginx

    success "nginx reverse proxy for Wallet Foreign API configured!"
    info "Wallet Foreign API accessible at: https://$domain"
    log "nginx proxy configured for $domain -> 127.0.0.1:$FOREIGN_API_PORT ($NETWORK)"
}

configure_firewall_foreign() {
    echo ""
    echo -e "${BOLD}Firewall configuration for Wallet Foreign API (port $FOREIGN_API_PORT):${RESET}"
    echo -e "  ${GREEN}1${RESET}) Open port $FOREIGN_API_PORT to all IPs (public)"
    echo -e "  ${YELLOW}2${RESET}) Open port $FOREIGN_API_PORT to a specific IP only"
    echo -e "  ${RED}3${RESET}) Skip firewall changes"
    echo -e "  ${DIM}0) Back${RESET}"
    echo -ne "Choice [3]: "
    read -r fw_choice || true
    [[ "$fw_choice" == "0" ]] && return

    case "${fw_choice:-3}" in
        1)
            if command -v ufw &>/dev/null; then
                ufw allow "$FOREIGN_API_PORT/tcp"
                success "UFW: port $FOREIGN_API_PORT opened to all."
            elif command -v iptables &>/dev/null; then
                iptables -I INPUT -p tcp --dport "$FOREIGN_API_PORT" -j ACCEPT
                success "iptables: port $FOREIGN_API_PORT opened to all."
            else
                warn "No firewall tool found (ufw/iptables). Configure manually."
            fi
            ;;
        2)
            echo -ne "Enter allowed IP address (or 0 to skip): "
            read -r allowed_ip || true
            [[ "$allowed_ip" == "0" ]] && allowed_ip=""
            if [[ -n "$allowed_ip" ]]; then
                if command -v ufw &>/dev/null; then
                    ufw allow from "$allowed_ip" to any port "$FOREIGN_API_PORT" proto tcp
                    success "UFW: port $FOREIGN_API_PORT opened for $allowed_ip."
                elif command -v iptables &>/dev/null; then
                    iptables -I INPUT -s "$allowed_ip" -p tcp --dport "$FOREIGN_API_PORT" -j ACCEPT
                    success "iptables: port $FOREIGN_API_PORT opened for $allowed_ip."
                fi
            fi
            ;;
        3|*) info "Firewall not modified." ;;
    esac
}

# ═══════════════════════════════════════════════════════════════════════════════
# MENU
# ═══════════════════════════════════════════════════════════════════════════════

show_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Grin Wallet Service${RESET}"
    echo -e "${BOLD}${GREEN}  Disclaimer: Always store or write your seed key safe!${RESET}"
    echo -e "${BOLD}${YELLOW}  This tool is for testing and development purpose! ${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    show_status

    echo -e "${DIM}  ─── Setup ────────────────────────────────────────${RESET}"
    echo -e "  ${GREEN}1${RESET}) Download & install grin-wallet  ${DIM}(choose mainnet / testnet)${RESET}"
    echo -e "  ${GREEN}2${RESET}) Initialize wallet               ${DIM}(grin-wallet init — runs inline)${RESET}"
    echo ""
    echo -e "${DIM}  ─── Run ──────────────────────────────────────────${RESET}"
    echo -e "  ${GREEN}3${RESET}) Start wallet listener           ${DIM}(grin-wallet listen, tmux)${RESET}"
    echo ""
    echo -e "${DIM}  ─── Publish ──────────────────────────────────────${RESET}"
    echo -e "  ${GREEN}4${RESET}) Enable Wallet Foreign API       ${DIM}(port $FOREIGN_API_PORT)${RESET}"
    echo -e "  ${RED}5${RESET}) Disable Wallet Foreign API"
    echo -e "  ${CYAN}6${RESET}) Configure nginx proxy           ${DIM}(wallet)${RESET}"
    echo -e "  ${CYAN}7${RESET}) Configure firewall rules        ${DIM}(port $FOREIGN_API_PORT)${RESET}"
    echo ""
    echo -e "  ${DIM}↩  Press Enter to refresh status${RESET}"
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -ne "${BOLD}Select [0-7]: ${RESET}"
}

main() {
    while true; do
        show_menu
        read -r choice || true

        case "$choice" in
            1) download_wallet ;;
            2) init_wallet ;;
            3) start_wallet ;;
            4) enable_foreign_api ;;
            5) disable_foreign_api ;;
            6) offer_nginx_proxy ;;
            7) configure_firewall_foreign ;;
            0) break ;;
            "") continue ;;
            *) warn "Invalid option." ; sleep 1 ;;
        esac

        echo ""
        echo "Press Enter to continue..."
        read -r || true
    done
}

main "$@"
