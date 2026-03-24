#!/bin/bash
# =============================================================================
# 051_grin_private_web_wallet.sh — Grin Private Web Wallet
# =============================================================================
#
#  Personal, single-owner browser wallet UI for your own Grin node server.
#  Protected by Basic Auth — intended for the server owner only, not public.
#
#  Deploys a browser-based wallet UI backed by the local grin-wallet Owner
#  API.  Supports mainnet and testnet in separate deployments from the same
#  source (web/051_wallet/).
#
#  ─── Network Selection ───────────────────────────────────────────────────────
#   1) Mainnet  →  port 3415,  /var/www/web-wallet-main, /opt/grin/webwallet/mainnet
#   2) Testnet  →  port 13415, /var/www/web-wallet-test, /opt/grin/webwallet/testnet
#
#  ─── Menu ────────────────────────────────────────────────────────────────────
#   1) Install wallet binary   (download grin-wallet, init, start listener)
#   2) Install dependencies    (nginx, php, certbot, htpasswd, qrencode)
#   3) Deploy files            (web/051_wallet/ → deploy dir, write config.php)
#   4) Configure nginx         (HTTP vhost — certbot handles HTTPS in step 5)
#   5) Setup SSL               (Let's Encrypt or Cloudflare Origin Cert)
#   6) Setup Basic Auth        (htpasswd)
#   7) Configure firewall      (ports 80 + 443)
#   8) Status & info
#   9) Edit saved settings     (domain, email, auth user)
#   0) Back to network select
#
#  Binary:   /opt/grin/webwallet/{mainnet,testnet}/grin-wallet
#  Config:   /opt/grin/webwallet/{mainnet,testnet}/config.conf
#  Deploy:   /var/www/web-wallet-{main,test}/
#  nginx:    /etc/nginx/sites-available/web-wallet-{main,test}
#  htpasswd: /etc/nginx/web-wallet-{main,test}.htpasswd
#
#  ─── Security hardening — already implemented ────────────────────────────────
#   nginx : server_tokens off, client_max_body_size 64k
#   nginx : HSTS + CSP + X-Content-Type-Options + Referrer-Policy + X-Frame-Options
#   nginx : Permissions-Policy, X-XSS-Protection: 0
#   nginx : fastcgi_hide_header X-Powered-By (hides PHP version)
#   nginx : Security headers repeated in static-file location (inheritance fix)
#   nginx : rate-limit zones _tx(3r/m) _api(10r/m) _http(20r/m)
#   PHP   : CSRF token via hash_equals(), samesite=Strict session cookie
#   PHP   : session_regenerate_id() on new session (session fixation defense)
#   PHP   : WALLET_HOST asserted to loopback only (config-tampering defense)
#   PHP   : SSRF blocklist — private ranges, 0.0.0.0, fe80:, ::ffff: blocked
#   PHP   : method allowlist, POST-only, 60-min idle session timeout
#   Files : grin_web_wallet_api.json outside webroot, chmod 640 root:www-data
#
#  ─── TODO: security recommendations for future integration ───────────────────
#   [ ] fail2ban  — watch nginx access log for HTTP 401 responses and auto-ban
#                   offending IPs after N failures (recommended: 5 fails / 10 min).
#                   Rule: /etc/fail2ban/filter.d/nginx-auth.conf
#                         failregex = <HOST>.*" 401
#                         jail: nginx-auth, maxretry=5, findtime=600, bantime=3600
#
#   [ ] IP allowlist — add to nginx server block (strongest brute-force defense):
#                   allow <YOUR_IP>;
#                   deny  all;
#                   Place before auth_basic directives.
#
#   [ ] PHP expose_php — set in /etc/php/x.y/fpm/php.ini:
#                   expose_php = Off
#                   Redundant with fastcgi_hide_header but defense-in-depth.
#
#   [ ] CSP nonce/hash — current CSP uses script-src 'self' (no inline JS).
#                   If inline scripts are ever added, use nonces instead of
#                   'unsafe-inline'. Generate per-request nonce in PHP and
#                   pass to nginx via fastcgi_param.
#
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLKIT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# GitHub API for grin-wallet releases
_WW_GITHUB_API="https://api.github.com/repos/mimblewimble/grin-wallet/releases/latest"

# ─── Logging ──────────────────────────────────────────────────────────────────
LOG_DIR="/opt/grin/logs"
LOG_FILE="$LOG_DIR/grin_web_wallet_$(date +%Y%m%d_%H%M%S).log"
mkdir -p "$LOG_DIR" 2>/dev/null || true
log()     { echo -e "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; log "[INFO] $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; log "[OK] $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; log "[WARN] $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; log "[ERROR] $*"; }
die()     { error "$*"; return 1; }
pause()   { echo ""; echo -e "${DIM}Press Enter to continue...${RESET}"; read -r || true; }

# ─── Network-specific constants (set by select_network) ───────────────────────
WW_NETWORK=""
WW_WALLET_API_PORT=""
WW_DEPLOY_DIR=""
WW_CONF_DIR=""
WW_CONF_FILE=""
WW_NGINX_CONF=""
WW_NGINX_LINK=""
WW_HTPASSWD=""
WW_NET_FLAG=""
WW_NET_LABEL=""
WW_RATELIMIT_ZONE=""

# ─── Per-instance settings (loaded from WW_CONF_FILE) ─────────────────────────
WW_DOMAIN=""
WW_EMAIL=""
WW_AUTH_USER="grin"
WW_PHP_FPM_SOCK=""

# Source files live here (single copy, both networks)
WW_SRC_DIR="$TOOLKIT_ROOT/web/051_wallet/public_html"

# =============================================================================
# NETWORK SELECTION
# =============================================================================

select_network() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 051) GRIN WEB WALLET${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    local mn_up=0 tn_up=0
    ss -tlnp 2>/dev/null | grep -q ":3413 "  && mn_up=1
    ss -tlnp 2>/dev/null | grep -q ":13413 " && tn_up=1
    local mn_lbl tn_lbl
    [[ $mn_up -eq 1 ]] && mn_lbl="${GREEN}node RUNNING${RESET}" || mn_lbl="${RED}node down${RESET}"
    [[ $tn_up -eq 1 ]] && tn_lbl="${GREEN}node RUNNING${RESET}" || tn_lbl="${RED}node down${RESET}"

    echo -e "  ${GREEN}1${RESET}) Mainnet  ${DIM}(port 3415  — $mn_lbl${DIM})${RESET}"
    echo -e "  ${YELLOW}2${RESET}) Testnet  ${DIM}(port 13415 — $tn_lbl${DIM})${RESET}"
    echo ""
    echo -e "  ${BOLD}${YELLOW}xp${RESET}${DIM}) XP Wallet  ← fun/nostalgia, mainnet only${RESET}"
    echo -e "     ${DIM}${RED}⚠ runs real MAINNET wallet inside a WinXP simulator${RESET}"
    echo ""
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -ne "${BOLD}Select [1/2/xp/0]: ${RESET}"
    local sel
    read -r sel || true
    case "$sel" in
        1)     _set_network mainnet ;;
        2)     _set_network testnet ;;
        xp|XP) _launch_xp_wallet || true
               select_network
               return $? ;;
        0)     return 1 ;;
        *)     warn "Invalid option."; return 1 ;;
    esac
    return 0
}

_launch_xp_wallet() {
    local xp_script="$SCRIPT_DIR/051x_grin_xp_wallet.sh"
    if [[ ! -f "$xp_script" ]]; then
        error "051x_grin_xp_wallet.sh not found in $SCRIPT_DIR"
        pause
        return 1
    fi
    bash "$xp_script"
}

_set_network() {
    WW_NETWORK="$1"
    if [[ "$WW_NETWORK" == "mainnet" ]]; then
        WW_WALLET_API_PORT=3415
        WW_DEPLOY_DIR="/var/www/web-wallet-main"
        WW_CONF_DIR="/opt/grin/webwallet/mainnet"
        WW_CONF_FILE="/opt/grin/webwallet/mainnet/config.conf"
        WW_NGINX_CONF="/etc/nginx/sites-available/web-wallet-main"
        WW_NGINX_LINK="/etc/nginx/sites-enabled/web-wallet-main"
        WW_HTPASSWD="/etc/nginx/web-wallet-main.htpasswd"
        WW_NET_FLAG=""
        WW_NET_LABEL="MAINNET"
        WW_RATELIMIT_ZONE="grin_ww_main"
    else
        WW_WALLET_API_PORT=13415
        WW_DEPLOY_DIR="/var/www/web-wallet-test"
        WW_CONF_DIR="/opt/grin/webwallet/testnet"
        WW_CONF_FILE="/opt/grin/webwallet/testnet/config.conf"
        WW_NGINX_CONF="/etc/nginx/sites-available/web-wallet-test"
        WW_NGINX_LINK="/etc/nginx/sites-enabled/web-wallet-test"
        WW_HTPASSWD="/etc/nginx/web-wallet-test.htpasswd"
        WW_NET_FLAG="--testnet"
        WW_NET_LABEL="TESTNET"
        WW_RATELIMIT_ZONE="grin_ww_test"
    fi
}

# =============================================================================
# STEP 1 — Install grin-wallet binary
# =============================================================================

_ww_patch_toml() {
    local toml="$1" key="$2" val="$3"
    if grep -q "^${key}\s*=" "$toml" 2>/dev/null; then
        sed -i "s|^${key}\s*=.*|${key} = ${val}|" "$toml"
    else
        echo "${key} = ${val}" >> "$toml"
    fi
}

ww_install_wallet() {
    local wallet_bin="$WW_CONF_DIR/grin-wallet"
    local toml_file="$WW_CONF_DIR/grin-wallet.toml"
    local pass_file="$WW_CONF_DIR/${WW_NETWORK}_pass_wallet.txt"
    local seed_file="$WW_CONF_DIR/${WW_NETWORK}_seed.txt"
    local tmux_name="grin_wallet_${WW_NETWORK}"
    local _node_port; [[ "$WW_NETWORK" == "mainnet" ]] && _node_port="3413" || _node_port="13413"

    local _did_download="no" _did_init="no" _saved_pass="no" _saved_seed="no"
    local _did_patch="no" _patch_node_dir=""

    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 051) Web Wallet — 1) Install Wallet Binary [$WW_NET_LABEL]${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    [[ "$WW_NETWORK" == "mainnet" ]] && \
        echo -e "  ${BOLD}${YELLOW}⚠  MAINNET — operates with real GRIN (monetary value)${RESET}\n"
    echo -e "  ${DIM}─── Setup target ─────────────────────────────────────${RESET}"
    echo ""
    echo -e "  Network      : ${BOLD}$WW_NET_LABEL${RESET}"
    echo -e "  Node port    : ${DIM}$_node_port${RESET}"
    echo -e "  Wallet dir   : ${DIM}$WW_CONF_DIR${RESET}"
    echo -e "  Binary       : ${DIM}$wallet_bin${RESET}"
    echo -e "  Pass file    : ${DIM}$pass_file${RESET}"
    echo -e "  Seed file    : ${DIM}$seed_file${RESET}"
    echo -e "  tmux session : ${DIM}$tmux_name${RESET}"
    echo ""

    # ── Download ──────────────────────────────────────────────────────────────
    local needs_download=1
    if [[ -x "$wallet_bin" ]]; then
        local ver; ver=$("$wallet_bin" --version 2>/dev/null | head -1 || echo "?")
        success "Binary already installed  ${DIM}($ver)${RESET}"
        echo -ne "  Re-download latest? [y/N/0 cancel]: "
        local redown; read -r redown || true
        [[ "$redown" == "0" ]] && return
        [[ "${redown,,}" == "y" ]] || needs_download=0
    fi
    echo ""

    if [[ $needs_download -eq 1 ]]; then
        info "Fetching latest release from GitHub..."
        local release_json
        release_json=$(curl -fsSL --max-time 30 "$_WW_GITHUB_API") \
            || { error "Failed to reach GitHub API."; pause; return; }

        local version download_url
        version=$(echo "$release_json" | jq -r '.tag_name')
        download_url=$(echo "$release_json" \
            | jq -r '.assets[] | select(.name | test("linux-x86_64\\.tar\\.gz$"; "i")) | .browser_download_url' \
            | head -1)

        if [[ -z "$download_url" || "$download_url" == "null" ]]; then
            error "No linux-x86_64 asset found for $version."
            pause; return
        fi

        mkdir -p "$WW_CONF_DIR"
        local tmp_tar="/tmp/grin_wwallet_$$.tar.gz"
        local tmp_dir="/tmp/grin_wwallet_extract_$$"
        mkdir -p "$tmp_dir"

        info "Version : $version"
        info "Target  : $wallet_bin"
        echo ""
        wget -c --progress=bar:force -O "$tmp_tar" "$download_url" \
            || { error "Download failed."; rm -rf "$tmp_tar" "$tmp_dir"; pause; return; }

        tar -xzf "$tmp_tar" -C "$tmp_dir" \
            || { error "Extraction failed."; rm -rf "$tmp_tar" "$tmp_dir"; pause; return; }
        rm -f "$tmp_tar"

        local bin_src
        bin_src=$(find "$tmp_dir" -type f -name "grin-wallet" | head -1)
        if [[ -z "$bin_src" ]]; then
            error "grin-wallet binary not found in archive."
            rm -rf "$tmp_dir"; pause; return
        fi
        install -m 755 "$bin_src" "$wallet_bin"
        rm -rf "$tmp_dir"
        success "grin-wallet $version installed → $wallet_bin"
        _did_download="$version"
    fi
    echo ""

    # ── Init ──────────────────────────────────────────────────────────────────
    if [[ -f "$toml_file" ]]; then
        warn "Wallet already initialized at $WW_CONF_DIR"
        echo -ne "  Re-initialize? ${RED}(overwrites existing wallet!)${RESET} [y/N/0 cancel]: "
        local reinit; read -r reinit || true
        [[ "$reinit" == "0" ]] && return
        if [[ "${reinit,,}" != "y" ]]; then
            info "Skipping init — existing wallet kept."
            echo ""
            _ww_start_listener "$wallet_bin" "$tmux_name" "$pass_file" || return
            local _ls="no"
            tmux has-session -t "$tmux_name" 2>/dev/null && _ls="yes" || true
            echo ""
            echo -e "  ${BOLD}${GREEN}Summary — $WW_NET_LABEL${RESET}"
            echo ""
            echo -e "  ${DIM}─  Init       : skipped — existing wallet kept${RESET}"
            echo -e "  ${DIM}─  Wallet dir : $WW_CONF_DIR${RESET}"
            [[ "$_ls" == "yes" ]] \
                && echo -e "  ${GREEN}✔${RESET}  ${DIM}Listener   : running  (tmux: $tmux_name)${RESET}" \
                || echo -e "  ${DIM}─  Listener   : not started${RESET}"
            echo ""
            pause; return
        fi
    fi

    echo -e "  Enter wallet password for init  ${DIM}(0 at any prompt to cancel)${RESET}:"
    local wallet_pass=""
    while true; do
        echo -ne "    Password : "
        read -rs wallet_pass; echo ""
        [[ "$wallet_pass" == "0" ]] && unset wallet_pass && return
        [[ -z "$wallet_pass" ]] && warn "Password cannot be empty." && continue
        echo -ne "    Confirm  : "
        local wallet_pass2; read -rs wallet_pass2; echo ""
        [[ "$wallet_pass2" == "0" ]] && unset wallet_pass wallet_pass2 && return
        if [[ "$wallet_pass" != "$wallet_pass2" ]]; then
            error "Passwords do not match."; unset wallet_pass2; continue
        fi
        unset wallet_pass2; break
    done
    echo ""
    info "Running grin-wallet init -h  ${DIM}(write down your seed phrase!)${RESET}"
    echo ""

    local tmp_init="/tmp/grin_ww_init_${WW_NETWORK}_$$"
    mkdir -p "$WW_CONF_DIR"
    cd "$WW_CONF_DIR" && "$wallet_bin" $WW_NET_FLAG -p "$wallet_pass" init -h \
        2>&1 | tee "$tmp_init" || true
    echo ""

    if [[ ! -f "$toml_file" ]]; then
        warn "Init may have failed — grin-wallet.toml not found."
        warn "Check output above."
        rm -f "$tmp_init"; unset wallet_pass
        pause; return
    fi
    success "Wallet initialized."
    _did_init="yes"
    echo ""

    # ── Save passphrase ───────────────────────────────────────────────────────
    echo -ne "  Save passphrase to ${BOLD}$(basename "$pass_file")${RESET}? [y/N/0 cancel]: "
    local save_pass; read -r save_pass || true
    if [[ "$save_pass" == "0" ]]; then
        rm -f "$tmp_init"; unset wallet_pass; return
    fi
    if [[ "${save_pass,,}" == "y" ]]; then
        echo "$wallet_pass" > "$pass_file"
        chmod 600 "$pass_file"
        success "Saved → $pass_file  ${DIM}(mode 600)${RESET}"
        _saved_pass="yes"
    else
        info "Passphrase not saved."
    fi
    unset wallet_pass
    echo ""

    # ── Save seed ─────────────────────────────────────────────────────────────
    echo -ne "  Save seed phrase to ${BOLD}$(basename "$seed_file")${RESET}? [y/N/0 cancel]: "
    local save_seed; read -r save_seed || true
    if [[ "$save_seed" == "0" ]]; then
        rm -f "$tmp_init"; return
    fi
    if [[ "${save_seed,,}" == "y" ]]; then
        tail -6 "$tmp_init" > "$seed_file"
        chmod 600 "$seed_file"
        success "Saved → $seed_file  ${DIM}(mode 600)${RESET}"
        _saved_seed="yes"
    else
        info "Seed not saved."
    fi
    rm -f "$tmp_init"
    echo ""

    # ── Patch grin-wallet.toml ────────────────────────────────────────────────
    local instances_conf="/opt/grin/conf/grin_instances_location.conf"
    local node_dir=""
    if [[ -f "$instances_conf" ]]; then
        # shellcheck source=/dev/null
        source "$instances_conf" 2>/dev/null || true
        if [[ "$WW_NETWORK" == "testnet" ]]; then
            node_dir="${PRUNETEST_GRIN_DIR:-}"
        else
            node_dir="${PRUNEMAIN_GRIN_DIR:-${FULLMAIN_GRIN_DIR:-}}"
        fi
    fi
    if [[ -z "$node_dir" || ! -d "$node_dir" ]]; then
        node_dir="/opt/grin/node/$( [[ "$WW_NETWORK" == "testnet" ]] && echo testnet-prune || echo mainnet-prune )"
    fi
    _patch_node_dir="$node_dir"
    if [[ -f "$node_dir/.foreign_api_secret" ]]; then
        _ww_patch_toml "$toml_file" "node_api_secret_path" "\"$node_dir/.foreign_api_secret\""
        _did_patch="$node_dir"
    fi

    # ── Start listener ────────────────────────────────────────────────────────
    _ww_start_listener "$wallet_bin" "$tmux_name" "$pass_file" || true

    local _did_listen="no"
    tmux has-session -t "$tmux_name" 2>/dev/null && _did_listen="yes" || true

    local _tick="${GREEN}✔${RESET}" _skip="${DIM}─${RESET}"
    echo ""
    echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${GREEN} Summary — $WW_NET_LABEL${RESET}"
    echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  ${DIM}─── Steps ────────────────────────────────────────────${RESET}"
    echo ""
    if [[ "$_did_download" != "no" ]]; then
        echo -e "  $_tick  1. Binary downloaded    ${DIM}$wallet_bin  [$_did_download]${RESET}"
    else
        echo -e "  $_skip  1. Binary download       ${DIM}skipped — already installed${RESET}"
    fi
    if [[ "$_did_init" == "yes" ]]; then
        echo -e "  $_tick  2. Wallet initialized   ${DIM}$toml_file${RESET}"
    else
        echo -e "  $_skip  2. Init                  ${DIM}skipped — existing wallet kept${RESET}"
    fi
    if [[ "$_saved_pass" == "yes" ]]; then
        echo -e "  $_tick  3. Passphrase saved     ${DIM}$pass_file${RESET}"
    else
        echo -e "  $_skip  3. Passphrase            ${DIM}not saved${RESET}"
    fi
    if [[ "$_saved_seed" == "yes" ]]; then
        echo -e "  $_tick  4. Seed phrase saved    ${DIM}$seed_file${RESET}"
    else
        echo -e "  $_skip  4. Seed phrase           ${DIM}not saved${RESET}"
    fi
    if [[ "$_did_patch" != "no" ]]; then
        echo -e "  $_tick  5. TOML patched         ${DIM}node_api_secret_path → $_did_patch/.foreign_api_secret${RESET}"
    else
        echo -e "  ${YELLOW}!${RESET}  5. TOML patch            ${YELLOW}secret not found at $_patch_node_dir — edit $toml_file${RESET}"
    fi
    if [[ "$_did_listen" == "yes" ]]; then
        echo -e "  $_tick  6. Listener started     ${DIM}tmux: $tmux_name${RESET}"
    else
        echo -e "  $_skip  6. Listener              ${DIM}not started${RESET}"
    fi
    echo ""
    echo -e "  ${DIM}─── Quick reference ──────────────────────────────────${RESET}"
    echo ""
    echo -e "  ${DIM}  cd $WW_CONF_DIR && ./grin-wallet $WW_NET_FLAG info${RESET}"
    echo -e "  ${DIM}  tmux attach -t $tmux_name${RESET}"
    echo ""
    log "[ww_install_wallet] network=$WW_NETWORK download=$_did_download init=$_did_init"
    pause
}

_ww_start_listener() {
    local wallet_bin="$1" tmux_name="$2" pass_file="$3"

    local pass_arg=""
    if [[ -f "$pass_file" ]]; then
        pass_arg=$(<"$pass_file")
        info "Using saved passphrase."
    else
        echo -ne "  Enter wallet password to start listener  ${DIM}(0 to skip)${RESET}: "
        read -rs pass_arg; echo ""
        if [[ "$pass_arg" == "0" || -z "$pass_arg" ]]; then
            info "Listener not started."; return 0
        fi
    fi

    if tmux has-session -t "$tmux_name" 2>/dev/null; then
        warn "Session '$tmux_name' already running."
        echo -ne "  Kill and restart? [y/N/0 skip]: "
        local restart; read -r restart || true
        if [[ "$restart" == "0" ]]; then unset pass_arg; return 1; fi
        if [[ "${restart,,}" == "y" ]]; then
            tmux kill-session -t "$tmux_name" 2>/dev/null || true
            sleep 1
        else
            info "Listener not restarted."; unset pass_arg; return 0
        fi
    fi

    local launcher="$WW_CONF_DIR/.${WW_NETWORK}_listener.sh"
    local pass_tmp="$WW_CONF_DIR/.${WW_NETWORK}_pass_tmp_$$"
    mkdir -p "$WW_CONF_DIR"
    echo "$pass_arg" > "$pass_tmp"
    chmod 600 "$pass_tmp"
    unset pass_arg
    cat > "$launcher" << LAUNCHER_EOF
#!/bin/bash
cd "$WW_CONF_DIR"
_p=\$(cat "$pass_tmp" 2>/dev/null || echo "")
rm -f "$pass_tmp"
exec "$wallet_bin" $WW_NET_FLAG -p "\$_p" listen
LAUNCHER_EOF
    chmod 700 "$launcher"
    tmux new-session -d -s "$tmux_name" "$launcher"
    sleep 1

    if tmux has-session -t "$tmux_name" 2>/dev/null; then
        success "Listener started  ${DIM}(tmux: $tmux_name)${RESET}"
        info "Attach: tmux attach -t $tmux_name"
    else
        rm -f "$pass_tmp"
        warn "Session not found after start — may have exited immediately."
        warn "Try manually: tmux new -s $tmux_name"
    fi
    return 0
}

# =============================================================================
# CONFIG HELPERS
# =============================================================================

ww_load_config() {
    WW_DOMAIN=""
    WW_EMAIL=""
    WW_AUTH_USER="grin"
    WW_PHP_FPM_SOCK=""
    if [[ -f "$WW_CONF_FILE" ]]; then
        # shellcheck disable=SC1090
        source "$WW_CONF_FILE" 2>/dev/null || true
    fi
}

ww_save_config() {
    mkdir -p "$WW_CONF_DIR"
    cat > "$WW_CONF_FILE" << CONF
WW_DOMAIN="${WW_DOMAIN:-}"
WW_EMAIL="${WW_EMAIL:-}"
WW_AUTH_USER="${WW_AUTH_USER:-grin}"
WW_PHP_FPM_SOCK="${WW_PHP_FPM_SOCK:-}"
CONF
    chmod 600 "$WW_CONF_FILE"
}

# =============================================================================
# STATUS (menu header)
# =============================================================================

ww_menu_status() {
    ww_load_config
    echo ""

    # Step 1 — wallet binary
    local wallet_bin="$WW_CONF_DIR/grin-wallet"
    local toml_file="$WW_CONF_DIR/grin-wallet.toml"
    if [[ -x "$wallet_bin" && -f "$toml_file" ]]; then
        local ver; ver=$("$wallet_bin" --version 2>/dev/null | head -1 || echo "?")
        echo -e "  ${BOLD}1 Wallet binary${RESET}: ${GREEN}installed + initialized${RESET}  ${DIM}($ver)${RESET}"
    elif [[ -x "$wallet_bin" ]]; then
        echo -e "  ${BOLD}1 Wallet binary${RESET}: ${YELLOW}downloaded, not initialized${RESET}  ${DIM}→ step 1${RESET}"
    else
        echo -e "  ${BOLD}1 Wallet binary${RESET}: ${RED}not installed${RESET}  ${DIM}→ step 1${RESET}"
    fi

    # Dependencies
    local deps_ok=1
    for cmd in nginx php certbot htpasswd; do
        command -v "$cmd" &>/dev/null || { deps_ok=0; break; }
    done
    [[ $deps_ok -eq 1 ]] \
        && echo -e "  ${BOLD}2 Dependencies${RESET} : ${GREEN}OK${RESET}" \
        || echo -e "  ${BOLD}2 Dependencies${RESET} : ${RED}missing${RESET}  ${DIM}→ step 2${RESET}"

    [[ -d "$WW_DEPLOY_DIR" ]] \
        && echo -e "  ${BOLD}3 Files${RESET}        : ${GREEN}deployed${RESET}  ${DIM}($WW_DEPLOY_DIR)${RESET}" \
        || echo -e "  ${BOLD}3 Files${RESET}        : ${DIM}not deployed${RESET}  ${DIM}→ step 3${RESET}"

    [[ -f "$WW_NGINX_CONF" ]] \
        && echo -e "  ${BOLD}4 nginx vhost${RESET}  : ${GREEN}configured${RESET}  ${DIM}($WW_NGINX_CONF)${RESET}" \
        || echo -e "  ${BOLD}4 nginx vhost${RESET}  : ${DIM}not configured${RESET}  ${DIM}→ step 4${RESET}"

    if [[ -n "$WW_DOMAIN" && -f "/etc/letsencrypt/live/$WW_DOMAIN/fullchain.pem" ]]; then
        echo -e "  ${BOLD}5 SSL${RESET}          : ${GREEN}Let's Encrypt${RESET}  ${DIM}($WW_DOMAIN)${RESET}"
    elif [[ -n "$WW_DOMAIN" && -f "/etc/ssl/cloudflare-origin/$WW_DOMAIN.pem" ]]; then
        echo -e "  ${BOLD}5 SSL${RESET}          : ${GREEN}Cloudflare Origin${RESET}  ${DIM}($WW_DOMAIN)${RESET}"
    else
        echo -e "  ${BOLD}5 SSL${RESET}          : ${DIM}not configured${RESET}  ${DIM}→ step 5${RESET}"
    fi

    [[ -f "$WW_HTPASSWD" ]] \
        && echo -e "  ${BOLD}6 Basic Auth${RESET}   : ${GREEN}configured${RESET}  ${DIM}(user: ${WW_AUTH_USER:-grin})${RESET}" \
        || echo -e "  ${BOLD}6 Basic Auth${RESET}   : ${DIM}not configured${RESET}  ${DIM}→ step 6${RESET}"

    if [[ -L "$WW_NGINX_LINK" ]]; then
        echo -e "  ${BOLD}Web UI${RESET}         : ${GREEN}LIVE${RESET}  ${DIM}→ https://${WW_DOMAIN:-<domain>}${RESET}"
    else
        echo -e "  ${BOLD}Web UI${RESET}         : ${DIM}not live${RESET}"
    fi

    # Wallet listener
    local wallet_session="grin_wallet_${WW_NETWORK}"
    if tmux has-session -t "$wallet_session" 2>/dev/null; then
        echo -e "  ${BOLD}Wallet${RESET}         : ${GREEN}listening${RESET}  ${DIM}(tmux: $wallet_session)${RESET}"
    else
        echo -e "  ${BOLD}Wallet${RESET}         : ${RED}not listening${RESET}  ${YELLOW}⚠ run step 1 to install and start${RESET}"
    fi
    echo ""
}

# =============================================================================
# STEP 1 — Install dependencies
# =============================================================================

ww_install_deps() {
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet [$WW_NET_LABEL] — 2) Install Dependencies ──${RESET}\n"

    local all_ok=1
    for pkg_cmd in "nginx:nginx" "php:php" "certbot:certbot" "htpasswd:apache2-utils" "qrencode:qrencode"; do
        local cmd="${pkg_cmd%%:*}"
        command -v "$cmd" &>/dev/null && success "$cmd already installed." || { warn "$cmd not found"; all_ok=0; }
    done

    if [[ $all_ok -eq 1 ]]; then
        echo ""
        success "All dependencies are present."
        pause; return
    fi

    echo ""
    echo -ne "${BOLD}Install missing packages now? (requires root) [Y/n/0]: ${RESET}"
    read -r confirm || true
    [[ "$confirm" == "0" ]] && return
    [[ "${confirm,,}" == "n" ]] && return

    info "Updating package lists..."
    apt-get update -qq 2>/dev/null || warn "apt-get update failed — continuing anyway."

    for pkg_cmd in "nginx:nginx" "php:php" "certbot:certbot" "htpasswd:apache2-utils" "qrencode:qrencode"; do
        local cmd="${pkg_cmd%%:*}" pkg="${pkg_cmd##*:}"
        if ! command -v "$cmd" &>/dev/null; then
            info "Installing $pkg..."
            if [[ "$cmd" == "php" ]]; then
                apt-get install -y php php-fpm php-curl php-json -qq 2>/dev/null \
                    || warn "Failed to install php."
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
        command -v "$cmd" &>/dev/null && success "$cmd  OK" || warn "$cmd  MISSING — install manually"
    done
    log "[ww_install_deps] network=$WW_NETWORK"
    pause
}

# =============================================================================
# STEP 2 — Deploy files + write config.php
# =============================================================================

ww_deploy_files() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet [$WW_NET_LABEL] — 3) Deploy Files ──${RESET}\n"

    if [[ ! -d "$WW_SRC_DIR" ]]; then
        die "Source not found: $WW_SRC_DIR"
        warn "Ensure the Grin Node Toolkit is complete (web/051_wallet/public_html/)."; pause; return
    fi

    if [[ -d "$WW_DEPLOY_DIR" ]]; then
        warn "Directory already exists: $WW_DEPLOY_DIR"
        echo -ne "Update files? [Y/n/0]: "
        read -r ow || true
        [[ "$ow" == "0" ]] && return
        [[ "${ow,,}" == "n" ]] && info "Cancelled." && return
    fi

    info "Deploying $WW_SRC_DIR → $WW_DEPLOY_DIR ..."
    mkdir -p "$WW_DEPLOY_DIR"
    cp -r "$WW_SRC_DIR"/. "$WW_DEPLOY_DIR/"
    rm -f "$WW_DEPLOY_DIR/api/config.json" 2>/dev/null || true

    # ── Write config.php (network-specific, outside loop but inside webroot) ──
    # proxy.php and other API files read WALLET_API_PORT and NETWORK_LABEL from this.
    local net_label_php="Mainnet"
    [[ "$WW_NETWORK" == "testnet" ]] && net_label_php="Testnet"
    cat > "$WW_DEPLOY_DIR/api/config.php" << PHP
<?php
// Generated by 051_grin_private_web_wallet.sh — do not edit manually
define('WALLET_API_PORT', $WW_WALLET_API_PORT);
define('NETWORK_LABEL',   '$net_label_php');
PHP
    chmod 644 "$WW_DEPLOY_DIR/api/config.php"
    info "config.php written: port=$WW_WALLET_API_PORT  network=$net_label_php"

    chown -R www-data:www-data "$WW_DEPLOY_DIR" 2>/dev/null \
        || warn "Could not chown to www-data — set permissions manually."
    chmod -R 755 "$WW_DEPLOY_DIR"

    # ── API credential config outside webroot ──────────────────────────────────
    local api_conf="$WW_CONF_DIR/grin_web_wallet_api.json"
    local owner_secret=""
    local wallets_conf="/opt/grin/conf/grin_wallets_location.conf"
    local wallet_dir=""
    if [[ -f "$wallets_conf" ]]; then
        if [[ "$WW_NETWORK" == "mainnet" ]]; then
            wallet_dir=$( (source "$wallets_conf" 2>/dev/null; echo "${MAINNET_WALLET_DIR:-}") 2>/dev/null || true)
        else
            wallet_dir=$( (source "$wallets_conf" 2>/dev/null; echo "${TESTNET_WALLET_DIR:-}") 2>/dev/null || true)
        fi
    fi
    local secret_file="${wallet_dir:-/opt/grin/wallet/${WW_NETWORK}}/wallet_data/.owner_api_secret"
    if [[ -f "$secret_file" ]]; then
        owner_secret=$(tr -d '[:space:]' < "$secret_file" 2>/dev/null || true)
        info "Owner API secret loaded from $secret_file"
    else
        warn "Owner API secret not found at $secret_file"
        warn "Run step 1 to install and start the wallet first, then re-run Deploy."
    fi

    mkdir -p "$WW_CONF_DIR"
    cat > "$api_conf" << JSON
{
    "walletHost": "127.0.0.1",
    "walletPort": $WW_WALLET_API_PORT,
    "ownerApiSecret": "$owner_secret"
}
JSON
    chown root:www-data "$api_conf" 2>/dev/null || chown root "$api_conf" 2>/dev/null || true
    chmod 640 "$api_conf"
    info "API config → $api_conf (chmod 640)"

    ww_save_config
    success "Files deployed to $WW_DEPLOY_DIR"
    log "[ww_deploy_files] network=$WW_NETWORK deploy_dir=$WW_DEPLOY_DIR"
    pause
}

# =============================================================================
# STEP 3 — Configure nginx (HTTP only; certbot handles HTTPS in step 4)
# =============================================================================

ww_configure_nginx() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet [$WW_NET_LABEL] — 4) Configure nginx ──${RESET}\n"

    if ! command -v nginx &>/dev/null; then
        die "nginx not installed — run step 1 first."; pause; return
    fi
    if [[ ! -d "$WW_DEPLOY_DIR" ]]; then
        die "Files not deployed yet — run step 2 first."; pause; return
    fi

    while true; do
        echo -ne "Domain (e.g. wallet.mynode.example.com) [${WW_DOMAIN:-}]: "
        read -r input || true
        [[ -n "$input" ]] && WW_DOMAIN="$input"
        [[ -z "$WW_DOMAIN" ]] && warn "No domain entered." && continue
        break
    done

    # Auto-detect PHP-FPM socket
    if [[ -z "$WW_PHP_FPM_SOCK" ]]; then
        local php_ver
        php_ver=$(php --version 2>/dev/null | grep -oP '^\S+ \K\d+\.\d+' | head -1 || echo "")
        if [[ -n "$php_ver" && -S "/run/php/php${php_ver}-fpm.sock" ]]; then
            WW_PHP_FPM_SOCK="unix:/run/php/php${php_ver}-fpm.sock"
        elif [[ -S "/run/php/php-fpm.sock" ]]; then
            WW_PHP_FPM_SOCK="unix:/run/php/php-fpm.sock"
        fi
    fi
    echo -ne "PHP-FPM socket [${WW_PHP_FPM_SOCK:-unix:/run/php/php-fpm.sock}]: "
    read -r input || true
    [[ -n "$input" ]] && WW_PHP_FPM_SOCK="$input"
    WW_PHP_FPM_SOCK="${WW_PHP_FPM_SOCK:-unix:/run/php/php-fpm.sock}"

    echo ""
    info "Domain    : $WW_DOMAIN"
    info "Deploy dir: $WW_DEPLOY_DIR"
    info "PHP-FPM   : $WW_PHP_FPM_SOCK"
    echo ""
    echo -ne "${BOLD}Write nginx config? [Y/n/0]: ${RESET}"
    read -r confirm || true
    [[ "$confirm" == "0" ]] && return
    [[ "${confirm,,}" == "n" ]] && info "Cancelled." && return

    # Rate-limit snippet (network-scoped zone names avoid conflicts)
    mkdir -p /etc/nginx/conf.d
    cat > "/etc/nginx/conf.d/grin-web-wallet-${WW_NETWORK}-ratelimit.conf" << RATELIMIT
# Grin Web Wallet [$WW_NET_LABEL] rate limits
limit_req_zone \$binary_remote_addr zone=${WW_RATELIMIT_ZONE}_tx:10m   rate=3r/m;
limit_req_zone \$binary_remote_addr zone=${WW_RATELIMIT_ZONE}_api:10m  rate=10r/m;
limit_req_zone \$binary_remote_addr zone=${WW_RATELIMIT_ZONE}_http:10m rate=20r/m;
RATELIMIT

    # HTTP-only vhost — certbot --nginx (step 4) adds HTTPS automatically
    info "Writing HTTP vhost → $WW_NGINX_CONF ..."
    cat > "$WW_NGINX_CONF" << NGINX_HTTP
# Grin Web Wallet [$WW_NET_LABEL] — generated by 051_grin_private_web_wallet.sh (HTTP — run step 4 for HTTPS)
server {
    listen 80;
    listen [::]:80;
    server_name $WW_DOMAIN;
    location / { return 301 https://\$host\$request_uri; }
}
NGINX_HTTP

    ln -sf "$WW_NGINX_CONF" "$WW_NGINX_LINK" 2>/dev/null || true
    nginx -t && systemctl reload nginx && success "nginx vhost configured and reloaded." \
        || { warn "nginx config test failed — check $WW_NGINX_CONF"; pause; return; }

    ww_save_config
    log "[ww_configure_nginx] network=$WW_NETWORK domain=$WW_DOMAIN"
    pause
}

# =============================================================================
# STEP 5 — Setup SSL
# =============================================================================

ww_setup_ssl() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet [$WW_NET_LABEL] — 5) Setup SSL ──${RESET}\n"

    if ! command -v certbot &>/dev/null; then
        die "certbot not installed — run step 1 first."; pause; return
    fi
    if [[ -z "$WW_DOMAIN" ]]; then
        die "Domain not configured — run step 3 first."; pause; return
    fi
    if [[ ! -f "$WW_NGINX_CONF" ]]; then
        die "nginx vhost not configured — run step 3 first."; pause; return
    fi

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
        # ── Let's Encrypt / certbot ───────────────────────────────────────────
        echo -ne "Let's Encrypt email [${WW_EMAIL:-}]: "
        read -r input || true
        [[ -n "$input" ]] && WW_EMAIL="$input"
        if [[ -z "$WW_EMAIL" ]]; then
            warn "Email required for Let's Encrypt."; pause; return
        fi

        echo -ne "  Press Enter to request certificate for $WW_DOMAIN, or 0 to cancel: "
        read -r _confirm || true
        [[ "$_confirm" == "0" ]] && return

        certbot --nginx -d "$WW_DOMAIN" --non-interactive --agree-tos -m "$WW_EMAIL" \
            && success "SSL certificate issued for $WW_DOMAIN" \
            || {
                warn "certbot failed — ensure DNS points to this server and port 80 is open."
                warn "Using Cloudflare? Switch DNS from 'Proxied' to 'DNS only' (grey cloud),"
                warn "then re-run this step. After cert is issued you can switch back to Proxied."
                warn "Or choose option 2) Cloudflare Origin Certificate on the next run."
                pause; return
            }

        # Write full HTTPS config (certs now exist)
        info "Writing HTTPS nginx config → $WW_NGINX_CONF ..."
        cat > "$WW_NGINX_CONF" << NGINX_HTTPS
# Grin Web Wallet [$WW_NET_LABEL] — generated by 051_grin_private_web_wallet.sh (Let's Encrypt)
server {
    listen 80;
    listen [::]:80;
    server_name $WW_DOMAIN;
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

    server_tokens off;
    client_max_body_size 64k;

    root  $WW_DEPLOY_DIR;
    index index.html;

    auth_basic           "Grin Wallet";
    auth_basic_user_file $WW_HTPASSWD;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options    "nosniff"    always;
    add_header X-Frame-Options           "DENY"       always;
    add_header Referrer-Policy           "no-referrer" always;
    add_header Content-Security-Policy   "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self';" always;
    add_header Permissions-Policy        "geolocation=(), microphone=(), camera=()" always;
    add_header X-XSS-Protection          "0" always;

    access_log /var/log/nginx/web-wallet-${WW_NETWORK}-access.log;
    error_log  /var/log/nginx/web-wallet-${WW_NETWORK}-error.log;

    location = /api/proxy.php {
        limit_req zone=${WW_RATELIMIT_ZONE}_tx burst=2 nodelay;
        try_files \$uri =404;
        fastcgi_pass            $WW_PHP_FPM_SOCK;
        fastcgi_param           SCRIPT_FILENAME \$document_root\$fastcgi_script_name;
        fastcgi_hide_header     X-Powered-By;
        include                 fastcgi_params;
    }

    location ~ ^/api/.*\.php\$ {
        limit_req zone=${WW_RATELIMIT_ZONE}_api burst=5 nodelay;
        try_files \$uri =404;
        fastcgi_pass            $WW_PHP_FPM_SOCK;
        fastcgi_param           SCRIPT_FILENAME \$document_root\$fastcgi_script_name;
        fastcgi_hide_header     X-Powered-By;
        include                 fastcgi_params;
    }

    location ~* \.(css|js|ico|png|svg)\$ {
        expires 1h;
        add_header Cache-Control             "public";
        add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
        add_header X-Content-Type-Options    "nosniff" always;
    }

    location / {
        limit_req zone=${WW_RATELIMIT_ZONE}_http burst=10 nodelay;
        try_files \$uri \$uri/ /index.html;
    }

    location ~ /\.  { deny all; }
    location ~ ~\$  { deny all; }
}
NGINX_HTTPS

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
        printf '%s' "$cf_cert" > "$cf_dir/$WW_DOMAIN.pem"
        printf '%s' "$cf_key"  > "$cf_dir/$WW_DOMAIN.key"
        chmod 644 "$cf_dir/$WW_DOMAIN.pem"
        chmod 600 "$cf_dir/$WW_DOMAIN.key"
        success "Cloudflare Origin Certificate saved → $cf_dir/$WW_DOMAIN.pem"

        info "Writing HTTPS nginx config → $WW_NGINX_CONF ..."
        cat > "$WW_NGINX_CONF" << NGINX_CF
# Grin Web Wallet [$WW_NET_LABEL] — generated by 051_grin_private_web_wallet.sh (Cloudflare Origin Cert)
server {
    listen 80;
    listen [::]:80;
    server_name $WW_DOMAIN;
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $WW_DOMAIN;

    ssl_certificate     $cf_dir/$WW_DOMAIN.pem;
    ssl_certificate_key $cf_dir/$WW_DOMAIN.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;

    server_tokens off;
    client_max_body_size 64k;

    root  $WW_DEPLOY_DIR;
    index index.html;

    auth_basic           "Grin Wallet";
    auth_basic_user_file $WW_HTPASSWD;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options    "nosniff"    always;
    add_header X-Frame-Options           "DENY"       always;
    add_header Referrer-Policy           "no-referrer" always;
    add_header Content-Security-Policy   "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self';" always;
    add_header Permissions-Policy        "geolocation=(), microphone=(), camera=()" always;
    add_header X-XSS-Protection          "0" always;

    access_log /var/log/nginx/web-wallet-${WW_NETWORK}-access.log;
    error_log  /var/log/nginx/web-wallet-${WW_NETWORK}-error.log;

    location = /api/proxy.php {
        limit_req zone=${WW_RATELIMIT_ZONE}_tx burst=2 nodelay;
        try_files \$uri =404;
        fastcgi_pass            $WW_PHP_FPM_SOCK;
        fastcgi_param           SCRIPT_FILENAME \$document_root\$fastcgi_script_name;
        fastcgi_hide_header     X-Powered-By;
        include                 fastcgi_params;
    }

    location ~ ^/api/.*\.php\$ {
        limit_req zone=${WW_RATELIMIT_ZONE}_api burst=5 nodelay;
        try_files \$uri =404;
        fastcgi_pass            $WW_PHP_FPM_SOCK;
        fastcgi_param           SCRIPT_FILENAME \$document_root\$fastcgi_script_name;
        fastcgi_hide_header     X-Powered-By;
        include                 fastcgi_params;
    }

    location ~* \.(css|js|ico|png|svg)\$ {
        expires 1h;
        add_header Cache-Control             "public";
        add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
        add_header X-Content-Type-Options    "nosniff" always;
    }

    location / {
        limit_req zone=${WW_RATELIMIT_ZONE}_http burst=10 nodelay;
        try_files \$uri \$uri/ /index.html;
    }

    location ~ /\.  { deny all; }
    location ~ ~\$  { deny all; }
}
NGINX_CF

        ln -sf "$WW_NGINX_CONF" "$WW_NGINX_LINK" 2>/dev/null || true
    fi

    nginx -t && systemctl reload nginx && success "nginx HTTPS config loaded." \
        || { warn "nginx config test failed — check $WW_NGINX_CONF"; pause; return; }

    ww_save_config
    log "[ww_setup_ssl] network=$WW_NETWORK domain=$WW_DOMAIN ssl=$ssl_choice"
    pause
}

# =============================================================================
# STEP 6 — Setup Basic Auth
# =============================================================================

ww_setup_auth() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet [$WW_NET_LABEL] — 6) Setup Basic Auth ──${RESET}\n"

    if ! command -v htpasswd &>/dev/null; then
        die "htpasswd not installed — run step 1 first."; pause; return
    fi

    echo -e "  ${DIM}Basic Auth protects the wallet UI with a username + password.${RESET}"
    echo -e "  ${DIM}Run this step again to change the password.${RESET}"
    echo ""
    echo -ne "Auth username [${WW_AUTH_USER:-grin}]: "
    read -r input || true
    [[ -n "$input" ]] && WW_AUTH_USER="$input"
    WW_AUTH_USER="${WW_AUTH_USER:-grin}"

    local flag="-c"
    if [[ -f "$WW_HTPASSWD" ]]; then
        warn "Password file already exists: $WW_HTPASSWD"
        echo -e "  ${GREEN}1${RESET}) Add / update user '${WW_AUTH_USER}'  ${DIM}(keeps other users)${RESET}"
        echo -e "  ${RED}2${RESET}) Recreate file                    ${DIM}(removes all existing users)${RESET}"
        echo -e "  ${DIM}0) Cancel${RESET}"
        echo -ne "Choice [1]: "
        read -r recreate || true
        [[ "$recreate" == "0" ]] && return
        [[ "${recreate:-1}" != "2" ]] && flag=""
    fi

    echo ""
    info "Setting password for user '${WW_AUTH_USER}':"
    # shellcheck disable=SC2086
    htpasswd $flag "$WW_HTPASSWD" "$WW_AUTH_USER" \
        && success "Basic Auth configured for user '$WW_AUTH_USER'." \
        || { die "htpasswd failed."; pause; return; }

    nginx -t 2>/dev/null && systemctl reload nginx 2>/dev/null || true
    ww_save_config
    log "[ww_setup_auth] network=$WW_NETWORK user=$WW_AUTH_USER"
    pause
}

# =============================================================================
# STEP 7 — Configure firewall
# =============================================================================

ww_configure_firewall() {
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet [$WW_NET_LABEL] — 7) Configure Firewall ──${RESET}\n"
    echo -e "  ${DIM}Opens ports 80 and 443 (HTTPS). Wallet API ports stay localhost-only.${RESET}"
    echo ""
    echo -ne "${BOLD}Open ports 80 and 443? [Y/n/0]: ${RESET}"
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
    log "[ww_configure_firewall] network=$WW_NETWORK"
    pause
}

# =============================================================================
# STEP 8 — Status & info
# =============================================================================

ww_show_info() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet [$WW_NET_LABEL] — 8) Status & Info ──${RESET}\n"

    local deps_ok=1
    for cmd in nginx php certbot htpasswd; do
        command -v "$cmd" &>/dev/null || { deps_ok=0; break; }
    done
    [[ $deps_ok -eq 1 ]] && echo -e "  ${BOLD}Dependencies${RESET}  : ${GREEN}all present${RESET}" \
                         || echo -e "  ${BOLD}Dependencies${RESET}  : ${RED}some missing${RESET}  ${DIM}(step 1)${RESET}"

    command -v qrencode &>/dev/null \
        && echo -e "  ${BOLD}qrencode${RESET}      : ${GREEN}installed${RESET}" \
        || echo -e "  ${BOLD}qrencode${RESET}      : ${YELLOW}not installed${RESET}  ${DIM}QR codes may be hidden${RESET}"

    [[ -d "$WW_DEPLOY_DIR" ]] \
        && echo -e "  ${BOLD}Files${RESET}         : ${GREEN}deployed${RESET}  ${DIM}($WW_DEPLOY_DIR)${RESET}" \
        || echo -e "  ${BOLD}Files${RESET}         : ${RED}not deployed${RESET}  ${DIM}(step 2)${RESET}"

    [[ -f "$WW_NGINX_CONF" ]] \
        && echo -e "  ${BOLD}nginx vhost${RESET}   : ${GREEN}configured${RESET}  ${DIM}($WW_NGINX_CONF)${RESET}" \
        || echo -e "  ${BOLD}nginx vhost${RESET}   : ${RED}not configured${RESET}  ${DIM}(step 3)${RESET}"

    if [[ -n "$WW_DOMAIN" && -f "/etc/letsencrypt/live/$WW_DOMAIN/fullchain.pem" ]]; then
        local cert_expiry
        cert_expiry=$(openssl x509 -enddate -noout \
            -in "/etc/letsencrypt/live/$WW_DOMAIN/fullchain.pem" 2>/dev/null \
            | sed 's/notAfter=//' || echo "unknown")
        echo -e "  ${BOLD}SSL cert${RESET}      : ${GREEN}Let's Encrypt${RESET}  ${DIM}(expires: $cert_expiry)${RESET}"
    elif [[ -n "$WW_DOMAIN" && -f "/etc/ssl/cloudflare-origin/$WW_DOMAIN.pem" ]]; then
        echo -e "  ${BOLD}SSL cert${RESET}      : ${GREEN}Cloudflare Origin${RESET}  ${DIM}($WW_DOMAIN)${RESET}"
    else
        echo -e "  ${BOLD}SSL cert${RESET}      : ${RED}not issued${RESET}  ${DIM}(step 4)${RESET}"
    fi

    [[ -f "$WW_HTPASSWD" ]] \
        && echo -e "  ${BOLD}Basic Auth${RESET}    : ${GREEN}configured${RESET}  ${DIM}(user: ${WW_AUTH_USER:-grin})${RESET}" \
        || echo -e "  ${BOLD}Basic Auth${RESET}    : ${RED}not configured${RESET}  ${DIM}(step 5)${RESET}"

    if [[ -L "$WW_NGINX_LINK" ]]; then
        echo -e "  ${BOLD}Web UI${RESET}        : ${GREEN}LIVE${RESET}  ${DIM}→ https://${WW_DOMAIN:-<domain>}${RESET}"
    else
        echo -e "  ${BOLD}Web UI${RESET}        : ${RED}not live${RESET}  ${DIM}(complete steps 3-5)${RESET}"
    fi

    local wallet_session="grin_wallet_${WW_NETWORK}"
    if tmux has-session -t "$wallet_session" 2>/dev/null; then
        echo -e "  ${BOLD}Wallet listener${RESET}: ${GREEN}running${RESET}  ${DIM}(tmux: $wallet_session)${RESET}"
    else
        echo -e "  ${BOLD}Wallet listener${RESET}: ${RED}not running${RESET}  ${YELLOW}⚠ run step 1 to install and start${RESET}"
    fi

    echo ""
    [[ -n "$WW_DOMAIN" ]] && echo -e "  URL: ${BOLD}${GREEN}https://$WW_DOMAIN${RESET}"
    echo -e "  Network     : $WW_NET_LABEL  (wallet API port $WW_WALLET_API_PORT)"
    echo -e "  Deploy dir  : $WW_DEPLOY_DIR"
    echo -e "  Config dir  : $WW_CONF_DIR"
    echo ""
    pause
}

# =============================================================================
# EDIT SAVED SETTINGS
# =============================================================================

ww_edit_settings() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet [$WW_NET_LABEL] — 9) Edit Saved Settings ──${RESET}\n"
    echo -e "  ${DIM}Press Enter to keep the current value.${RESET}"
    echo ""

    echo -ne "Domain           [${WW_DOMAIN:-}]: "
    read -r v || true; [[ -n "$v" ]] && WW_DOMAIN="$v"

    echo -ne "PHP-FPM socket   [${WW_PHP_FPM_SOCK:-}]: "
    read -r v || true; [[ -n "$v" ]] && WW_PHP_FPM_SOCK="$v"

    echo -ne "Auth username    [${WW_AUTH_USER:-grin}]: "
    read -r v || true; [[ -n "$v" ]] && WW_AUTH_USER="$v"

    echo -ne "Let's Encrypt email [${WW_EMAIL:-}]: "
    read -r v || true; [[ -n "$v" ]] && WW_EMAIL="$v"

    ww_save_config
    success "Settings saved to $WW_CONF_FILE"
    pause
}

# =============================================================================
# WALLET MENU
# =============================================================================

wallet_menu() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN} 051) GRIN WEB WALLET  [$WW_NET_LABEL]${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        ww_menu_status

        echo -e "${DIM}  ─── First-time setup (run in order) ─────────────${RESET}"
        echo -e "  ${GREEN}1${RESET}) Install wallet binary   ${DIM}(download, init, start listener)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Install dependencies    ${DIM}(nginx, php, certbot, htpasswd, qrencode)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Deploy files            ${DIM}(web/051_wallet/ → $WW_DEPLOY_DIR)${RESET}"
        echo -e "  ${GREEN}4${RESET}) Configure nginx         ${DIM}(HTTP vhost — step 5 adds HTTPS)${RESET}"
        echo -e "  ${GREEN}5${RESET}) Setup SSL               ${DIM}(Let's Encrypt or Cloudflare Origin Cert)${RESET}"
        echo -e "  ${GREEN}6${RESET}) Setup Basic Auth        ${DIM}(set / change password)${RESET}"
        echo -e "  ${GREEN}7${RESET}) Configure firewall      ${DIM}(open ports 80 and 443)${RESET}"
        echo ""
        echo -e "${DIM}  ─── Info ─────────────────────────────────────────${RESET}"
        echo -e "  ${CYAN}8${RESET}) Status & info"
        echo -e "  ${CYAN}9${RESET}) Edit saved settings     ${DIM}(domain, email, auth user)${RESET}"
        echo ""
        echo -e "  ${DIM}↩  Press Enter to refresh${RESET}"
        echo -e "  ${RED}0${RESET}) Back to network select"
        echo ""
        echo -ne "${BOLD}Select [1-9 / 0]: ${RESET}"
        read -r choice || true

        case "$choice" in
            1) ww_install_wallet      || true ;;
            2) ww_install_deps        || true ;;
            3) ww_deploy_files        || true ;;
            4) ww_configure_nginx     || true ;;
            5) ww_setup_ssl           || true ;;
            6) ww_setup_auth          || true ;;
            7) ww_configure_firewall  || true ;;
            8) ww_show_info           || true ;;
            9) ww_edit_settings       || true ;;
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
            wallet_menu
        else
            break
        fi
    done
}

main "$@"
