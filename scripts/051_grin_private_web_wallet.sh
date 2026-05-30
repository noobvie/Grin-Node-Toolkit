#!/bin/bash
# =============================================================================
# 051_grin_private_web_wallet.sh — Grin Private Web Wallet (Node.js)
# =============================================================================
#
#  Personal, single-owner browser wallet UI for your own Grin node server.
#  Protected by Basic Auth — intended for the server owner only, not public.
#
#  Ports the GrinSuite Node.js wallet (noobvie/GrinSuite:web/03_web_wallet)
#  onto the toolkit. See docs/generated/script051_design_node_port_2026-05-24.md
#  for the full architecture and decisions.
#
#  ─── Architecture ────────────────────────────────────────────────────────────
#   ONE Node.js process serves MANY wallets across BOTH networks:
#     systemd : grin-web-wallet.service     bound 127.0.0.1:7420
#     nginx   : reverse proxy → 127.0.0.1:7420 + Basic Auth + SSL
#     wallets : /opt/grin/webwallet/wallet_<net>_<name>/  per-wallet dirs
#     binary  : /opt/grin/webwallet/grin-wallet           single shared binary
#     registry: /opt/grin/webwallet/wallets_info.json     wallet list
#
#  ─── Menu ────────────────────────────────────────────────────────────────────
#   1) Install grin-wallet binary
#   2) Install dependencies        (nodejs, nginx, certbot, htpasswd, tor, qrencode)
#   3) Deploy files + systemd      (web/051_wallet/ → /opt/grin/webwallet/app/)
#   4) Configure nginx             (HTTP vhost — step 5 adds HTTPS)
#   5) Setup SSL                   (Let's Encrypt or Cloudflare Origin Cert)
#   6) Setup Basic Auth            (htpasswd)
#   7) Configure firewall          (ports 80 + 443)
#   8) Status & info
#   9) Edit saved settings         (domain, email, auth user)
#   x) Launch XP Wallet            (mainnet only — separate experience)
#   0) Back to main menu
#
#  ─── Security ────────────────────────────────────────────────────────────────
#   nginx : auth_basic, server_tokens off, client_max_body_size 1m
#           HSTS, CSP (script-src 'self' 'unsafe-inline' for inline theme boot),
#           X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
#           Permissions-Policy, X-XSS-Protection: 0
#   nginx : rate-limit zones _send(3r/m) _api(10r/m) _http(20r/m)
#   nginx : proxy_set_header Host $http_host → matches Node's WW_PUBLIC_HOST guard
#   Node  : ECDH Owner API v3, AES-256-GCM, passphrase via stdin (not argv)
#   Node  : Host/Origin guard, /connect rate limit, slatepack 16 KB cap
#   Node  : NETWORK_MISMATCH hard-block on Tor send (mainnet↔testnet)
#   Node  : show-seed passphrase-gated + rate-limited
#   systemd: ProtectSystem=full, ProtectHome=true, PrivateTmp=true,
#            NoNewPrivileges=true, ReadWritePaths=/opt/grin/webwallet
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

# ─── Source shared nginx helpers (guarded — script falls back to inline if missing) ─
_NGINX_LIB="$SCRIPT_DIR/lib/nginx_shared_helpers.sh"
if [[ -f "$_NGINX_LIB" ]]; then
    # shellcheck source=lib/nginx_shared_helpers.sh
    source "$_NGINX_LIB"
fi

# ─── Global constants (single deploy serves both networks) ────────────────────
WW_ROOT="/opt/grin/webwallet"
WW_APP_DIR="$WW_ROOT/app"
WW_BIN="$WW_ROOT/grin-wallet"
WW_REGISTRY="$WW_ROOT/wallets_info.json"
WW_CONF_FILE="$WW_ROOT/config.conf"
WW_ENV_FILE="$WW_ROOT/wallet.env"
WW_SRC_DIR="$TOOLKIT_ROOT/web/051_wallet"
WW_NODE_PORT=7420
WW_SYSTEMD_UNIT="/etc/systemd/system/grin-web-wallet.service"
WW_NGINX_CONF="/etc/nginx/sites-available/grin-web-wallet"
WW_NGINX_LINK="/etc/nginx/sites-enabled/grin-web-wallet"
WW_HTPASSWD="/etc/nginx/grin-web-wallet.htpasswd"
WW_RATELIMIT_CONF="/etc/nginx/conf.d/grin-web-wallet-ratelimit.conf"
WW_RATELIMIT_ZONE="grin_ww"

# ─── Per-instance settings (loaded from WW_CONF_FILE) ─────────────────────────
WW_DOMAIN=""
WW_EMAIL=""
WW_AUTH_USER="grin"

# =============================================================================
# INPUT VALIDATION HELPERS
# =============================================================================
# These guard against typos & metacharacters flowing into nginx config,
# certbot CLI, file paths, and the systemd EnvironmentFile.
# Return 0 if valid, 1 if not (with a warn message).

_ww_validate_domain() {
    # RFC-1123 hostname: letters, digits, dot, hyphen; no leading/trailing dot/hyphen.
    local d="${1:-}"
    if [[ -z "$d" ]]; then
        warn "Domain cannot be empty."; return 1
    fi
    if (( ${#d} > 253 )); then
        warn "Domain too long (max 253 chars)."; return 1
    fi
    if [[ ! "$d" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]]; then
        warn "Invalid domain: '$d'. Use only letters, digits, dot, hyphen."; return 1
    fi
    if [[ "$d" =~ \.\. ]]; then
        warn "Invalid domain: '$d' (consecutive dots)."; return 1
    fi
    return 0
}

_ww_validate_email() {
    local e="${1:-}"
    if [[ -z "$e" ]]; then
        warn "Email cannot be empty."; return 1
    fi
    # Lightweight check: <local>@<domain> with safe chars only.
    if [[ ! "$e" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
        warn "Invalid email: '$e'."; return 1
    fi
    return 0
}

_ww_validate_auth_user() {
    local u="${1:-}"
    if [[ -z "$u" ]]; then
        warn "Username cannot be empty."; return 1
    fi
    if (( ${#u} > 64 )); then
        warn "Username too long (max 64 chars)."; return 1
    fi
    # htpasswd accepts almost anything but we restrict to a safe alnum + ._- set
    # to avoid surprises in shell, env, and logs.
    if [[ ! "$u" =~ ^[A-Za-z0-9._-]+$ ]]; then
        warn "Invalid username: '$u'. Use only letters, digits, dot, underscore, hyphen."; return 1
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
    if [[ -f "$WW_CONF_FILE" ]]; then
        # shellcheck disable=SC1090
        source "$WW_CONF_FILE" 2>/dev/null || true
    fi
}

ww_save_config() {
    mkdir -p "$WW_ROOT"
    cat > "$WW_CONF_FILE" << CONF
WW_DOMAIN="${WW_DOMAIN:-}"
WW_EMAIL="${WW_EMAIL:-}"
WW_AUTH_USER="${WW_AUTH_USER:-grin}"
CONF
    chmod 600 "$WW_CONF_FILE"
}

# wallet.env — sourced by the systemd unit's EnvironmentFile=
# Holds WW_PUBLIC_HOST / WW_PUBLIC_ORIGIN so server.js's Host/Origin guard
# accepts traffic coming through the nginx reverse proxy.
ww_save_env() {
    mkdir -p "$WW_ROOT"
    local host="${WW_DOMAIN:-}"
    local origin=""
    [[ -n "$host" ]] && origin="https://$host"
    cat > "$WW_ENV_FILE" << ENV
# Generated by 051_grin_private_web_wallet.sh — do not edit manually
WW_ROOT=$WW_ROOT
GRIN_WEB_PORT=$WW_NODE_PORT
WW_PUBLIC_HOST=$host
WW_PUBLIC_ORIGIN=$origin
ENV
    chmod 600 "$WW_ENV_FILE"
    # Reload systemd if the unit is already installed — picks up the new env.
    if [[ -f "$WW_SYSTEMD_UNIT" ]] && systemctl is-active --quiet grin-web-wallet 2>/dev/null; then
        systemctl restart grin-web-wallet 2>/dev/null && info "grin-web-wallet restarted to apply env changes." || true
    fi
}

# =============================================================================
# STATUS (menu header)
# =============================================================================

ww_menu_status() {
    ww_load_config
    echo ""

    # 1) Binary
    if [[ -x "$WW_BIN" ]]; then
        local ver; ver=$("$WW_BIN" --version 2>/dev/null | head -1 || echo "?")
        echo -e "  ${BOLD}1 grin-wallet binary${RESET} : ${GREEN}installed${RESET}  ${DIM}($ver)${RESET}"
    else
        echo -e "  ${BOLD}1 grin-wallet binary${RESET} : ${RED}not installed${RESET}  ${DIM}→ step 1${RESET}"
    fi

    # 2) Dependencies
    local deps_ok=1
    for cmd in node nginx certbot htpasswd; do
        command -v "$cmd" &>/dev/null || { deps_ok=0; break; }
    done
    [[ $deps_ok -eq 1 ]] \
        && echo -e "  ${BOLD}2 Dependencies${RESET}       : ${GREEN}OK${RESET}" \
        || echo -e "  ${BOLD}2 Dependencies${RESET}       : ${RED}missing${RESET}  ${DIM}→ step 2${RESET}"

    # 3) App deploy + systemd
    if [[ -f "$WW_APP_DIR/server.js" && -d "$WW_APP_DIR/node_modules" && -f "$WW_SYSTEMD_UNIT" ]]; then
        if systemctl is-active --quiet grin-web-wallet 2>/dev/null; then
            echo -e "  ${BOLD}3 App + systemd${RESET}      : ${GREEN}deployed, running${RESET}  ${DIM}(127.0.0.1:$WW_NODE_PORT)${RESET}"
        else
            echo -e "  ${BOLD}3 App + systemd${RESET}      : ${YELLOW}deployed, stopped${RESET}  ${DIM}(systemctl start grin-web-wallet)${RESET}"
        fi
    elif [[ -f "$WW_APP_DIR/server.js" ]]; then
        echo -e "  ${BOLD}3 App + systemd${RESET}      : ${YELLOW}files deployed, no systemd${RESET}  ${DIM}→ step 3${RESET}"
    else
        echo -e "  ${BOLD}3 App + systemd${RESET}      : ${DIM}not deployed${RESET}  ${DIM}→ step 3${RESET}"
    fi

    # 4) nginx
    [[ -f "$WW_NGINX_CONF" ]] \
        && echo -e "  ${BOLD}4 nginx vhost${RESET}        : ${GREEN}configured${RESET}  ${DIM}($WW_NGINX_CONF)${RESET}" \
        || echo -e "  ${BOLD}4 nginx vhost${RESET}        : ${DIM}not configured${RESET}  ${DIM}→ step 4${RESET}"

    # 5) SSL
    if [[ -n "$WW_DOMAIN" && -f "/etc/letsencrypt/live/$WW_DOMAIN/fullchain.pem" ]]; then
        echo -e "  ${BOLD}5 SSL${RESET}                : ${GREEN}Let's Encrypt${RESET}  ${DIM}($WW_DOMAIN)${RESET}"
    elif [[ -n "$WW_DOMAIN" && -f "/etc/ssl/cloudflare-origin/$WW_DOMAIN.pem" ]]; then
        echo -e "  ${BOLD}5 SSL${RESET}                : ${GREEN}Cloudflare Origin${RESET}  ${DIM}($WW_DOMAIN)${RESET}"
    else
        echo -e "  ${BOLD}5 SSL${RESET}                : ${DIM}not configured${RESET}  ${DIM}→ step 5${RESET}"
    fi

    # 6) Basic Auth
    [[ -f "$WW_HTPASSWD" ]] \
        && echo -e "  ${BOLD}6 Basic Auth${RESET}         : ${GREEN}configured${RESET}  ${DIM}(user: ${WW_AUTH_USER:-grin})${RESET}" \
        || echo -e "  ${BOLD}6 Basic Auth${RESET}         : ${DIM}not configured${RESET}  ${DIM}→ step 6${RESET}"

    # Live URL
    if [[ -L "$WW_NGINX_LINK" ]]; then
        echo -e "  ${BOLD}Web UI${RESET}               : ${GREEN}LIVE${RESET}  ${DIM}→ https://${WW_DOMAIN:-<domain>}${RESET}"
    else
        echo -e "  ${BOLD}Web UI${RESET}               : ${DIM}not live${RESET}"
    fi

    # Registered wallets count
    local count=0
    if [[ -f "$WW_REGISTRY" ]] && command -v jq &>/dev/null; then
        count=$(jq '.wallets | length' "$WW_REGISTRY" 2>/dev/null || echo 0)
    fi
    echo -e "  ${BOLD}Wallets registered${RESET}   : ${DIM}$count${RESET}"
    echo ""
}

# =============================================================================
# STEP 1 — Install grin-wallet binary
# =============================================================================

ww_install_binary() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 051) Web Wallet — 1) Install grin-wallet Binary${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Target  : ${DIM}$WW_BIN${RESET}"
    echo -e "  Source  : ${DIM}$_WW_GITHUB_API${RESET}"
    echo ""

    local needs_download=1
    if [[ -x "$WW_BIN" ]]; then
        local ver; ver=$("$WW_BIN" --version 2>/dev/null | head -1 || echo "?")
        success "Binary already installed  ${DIM}($ver)${RESET}"
        echo -ne "  Re-download latest? [y/N/0 cancel]: "
        local redown; read -r redown || true
        [[ "$redown" == "0" ]] && return
        [[ "${redown,,}" == "y" ]] || needs_download=0
    fi

    if [[ $needs_download -eq 1 ]]; then
        if ! command -v jq &>/dev/null; then
            warn "jq not installed — run step 2 first (or 'apt install jq')."
            pause; return
        fi
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

        mkdir -p "$WW_ROOT"
        local tmp_tar="/tmp/grin_wwallet_$$.tar.gz"
        local tmp_dir="/tmp/grin_wwallet_extract_$$"
        mkdir -p "$tmp_dir"

        info "Version : $version"
        info "Target  : $WW_BIN"
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

        install -m 755 "$bin_src" "$WW_BIN"
        rm -rf "$tmp_dir"
        success "grin-wallet $version installed → $WW_BIN"
    fi

    echo ""
    pause
}

# =============================================================================
# STEP 2 — Install dependencies (nodejs, nginx, certbot, htpasswd, tor, qrencode, jq)
# =============================================================================

ww_install_deps() {
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet — 2) Install Dependencies ──${RESET}\n"
    echo -e "  ${DIM}Required: nodejs >= 18, nginx, certbot, htpasswd${RESET}"
    echo -e "  ${DIM}Optional: tor (for Tor sends), qrencode (QR codes), jq (status)${RESET}"
    echo ""

    local all_ok=1
    for pkg_cmd in "node:nodejs" "nginx:nginx" "certbot:certbot" "htpasswd:apache2-utils" "tor:tor" "qrencode:qrencode" "jq:jq"; do
        local cmd="${pkg_cmd%%:*}"
        command -v "$cmd" &>/dev/null && success "$cmd present" || { warn "$cmd missing"; all_ok=0; }
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

    # Evict apache2 before installing/starting nginx — apache2 occupies port 80
    if ! command -v nginx &>/dev/null; then
        if systemctl is-active --quiet apache2 2>/dev/null; then
            warn "apache2 is running and occupies port 80 — nginx cannot start."
            echo -ne "  Stop and disable apache2 now? [Y/n]: "
            local _yn; read -r _yn || true
            if [[ "${_yn,,}" != "n" ]]; then
                systemctl stop    apache2 2>/dev/null || true
                systemctl disable apache2 2>/dev/null || true
                success "apache2 stopped and disabled."
            else
                warn "Skipping — nginx may fail to bind port 80/443."
            fi
        elif systemctl is-enabled --quiet apache2 2>/dev/null; then
            warn "apache2 enabled at boot (not running) — disabling to avoid port conflict on reboot."
            systemctl disable apache2 2>/dev/null || true
            success "apache2 boot-start disabled."
        fi
    fi

    info "Updating package lists..."
    apt-get update -qq || warn "apt-get update failed — see above. Continuing anyway."

    # Special handling for nodejs: prefer NodeSource 20.x if the distro nodejs is < 18.
    if ! command -v node &>/dev/null; then
        info "Installing nodejs (distro package)..."
        apt-get install -y -qq nodejs npm || warn "Distro nodejs install failed — see above. Will try NodeSource."
        local node_major
        node_major=$(node --version 2>/dev/null | sed 's/^v//; s/\..*//')
        if [[ -z "$node_major" || $node_major -lt 18 ]]; then
            warn "Distro node too old (got: ${node_major:-none}). Installing NodeSource 20.x..."
            if curl -fsSL https://deb.nodesource.com/setup_20.x | bash -; then
                apt-get install -y -qq nodejs || error "NodeSource nodejs install failed — see above."
            else
                error "NodeSource setup script failed — install nodejs manually and re-run."
            fi
        fi
    fi

    for pkg_cmd in "nginx:nginx" "certbot:certbot" "htpasswd:apache2-utils" "tor:tor" "qrencode:qrencode" "jq:jq"; do
        local cmd="${pkg_cmd%%:*}" pkg="${pkg_cmd##*:}"
        if ! command -v "$cmd" &>/dev/null; then
            info "Installing $pkg..."
            if [[ "$cmd" == "certbot" ]]; then
                apt-get install -y -qq certbot python3-certbot-nginx \
                    || warn "Failed to install certbot — see above."
            else
                apt-get install -y -qq "$pkg" \
                    || warn "Failed to install $pkg — see above."
            fi
        fi
    done

    # Enable tor at boot if it was just installed (used for Tor sends from wallet)
    if command -v tor &>/dev/null; then
        systemctl enable --now tor 2>/dev/null \
            || systemctl enable --now tor@default 2>/dev/null || true
    fi

    echo ""
    info "Verification:"
    for pkg_cmd in "node:nodejs" "nginx:nginx" "certbot:certbot" "htpasswd:apache2-utils" "tor:tor" "qrencode:qrencode" "jq:jq"; do
        local cmd="${pkg_cmd%%:*}"
        command -v "$cmd" &>/dev/null && success "$cmd  OK" || warn "$cmd  MISSING — install manually"
    done
    log "[ww_install_deps]"
    pause
}

# =============================================================================
# STEP 3 — Deploy app + write systemd unit
# =============================================================================

ww_deploy_app() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet — 3) Deploy App + systemd ──${RESET}\n"

    if [[ ! -d "$WW_SRC_DIR" || ! -f "$WW_SRC_DIR/server.js" || ! -f "$WW_SRC_DIR/package.json" ]]; then
        die "Source not found: $WW_SRC_DIR"
        warn "Ensure $WW_SRC_DIR/server.js + package.json + client/ exist."
        pause; return
    fi
    if ! command -v node &>/dev/null; then
        die "node not installed — run step 2 first."; pause; return
    fi
    if ! command -v npm &>/dev/null; then
        die "npm not installed — run step 2 first (NodeSource install bundles npm)."; pause; return
    fi

    echo -e "  ${DIM}Will:${RESET}"
    echo -e "    1. Copy $WW_SRC_DIR → $WW_APP_DIR"
    echo -e "    2. Run npm install --omit=dev (in $WW_APP_DIR)"
    echo -e "    3. Write wallet.env (port, public host)"
    echo -e "    4. Write systemd unit $WW_SYSTEMD_UNIT"
    echo -e "    5. systemctl enable --now grin-web-wallet"
    echo ""
    echo -ne "${BOLD}Proceed? [Y/n/0]: ${RESET}"
    read -r confirm || true
    [[ "$confirm" == "0" ]] && return
    [[ "${confirm,,}" == "n" ]] && info "Cancelled." && return

    # ── 1. Copy source ────────────────────────────────────────────────────────
    info "Copying source files..."
    mkdir -p "$WW_APP_DIR"
    cp -r "$WW_SRC_DIR/server.js" "$WW_SRC_DIR/package.json" "$WW_SRC_DIR/client" "$WW_APP_DIR/"
    success "Source copied → $WW_APP_DIR"

    # ── 2. npm install ────────────────────────────────────────────────────────
    info "Running npm install --omit=dev ..."
    if (cd "$WW_APP_DIR" && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -20); then
        success "npm install completed."
    else
        warn "npm install reported errors — check above. Continuing anyway."
    fi

    # ── 3. Write wallet.env (uses current domain if set; empty otherwise) ────
    ww_save_env
    info "wallet.env written → $WW_ENV_FILE"

    # ── 4. Write systemd unit ─────────────────────────────────────────────────
    info "Writing systemd unit → $WW_SYSTEMD_UNIT ..."
    cat > "$WW_SYSTEMD_UNIT" << UNIT
[Unit]
Description=Grin Web Wallet (toolkit 051 — Node.js)
Documentation=https://github.com/Noobvie/Grin-Node-Toolkit
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=$WW_APP_DIR
EnvironmentFile=$WW_ENV_FILE
ExecStart=/usr/bin/env node $WW_APP_DIR/server.js
Restart=on-failure
RestartSec=5s
StandardOutput=append:/var/log/grin-web-wallet.log
StandardError=append:/var/log/grin-web-wallet.log

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$WW_ROOT /var/log
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=true
RestrictSUIDSGID=true
RestrictRealtime=true
# NOTE: do NOT add MemoryDenyWriteExecute=true here — V8's JIT needs W+X
# memory pages. The directive prevents Node.js from starting (or silently
# falls back to interpreter, ~10x slower).

[Install]
WantedBy=multi-user.target
UNIT
    chmod 644 "$WW_SYSTEMD_UNIT"
    success "systemd unit written."

    # ── 5. Enable + start ─────────────────────────────────────────────────────
    info "Reloading systemd + starting grin-web-wallet ..."
    systemctl daemon-reload
    if systemctl enable --now grin-web-wallet 2>&1 | tail -5; then
        sleep 2
        if systemctl is-active --quiet grin-web-wallet; then
            success "grin-web-wallet is RUNNING on 127.0.0.1:$WW_NODE_PORT"
        else
            warn "grin-web-wallet enabled but not active — check: journalctl -u grin-web-wallet -n 50"
        fi
    else
        warn "systemctl enable/start reported issues — check: journalctl -u grin-web-wallet"
    fi

    echo ""
    echo -e "  ${BOLD}Status${RESET}    : systemctl status grin-web-wallet"
    echo -e "  ${BOLD}Logs${RESET}      : journalctl -u grin-web-wallet -f"
    echo -e "  ${BOLD}Local${RESET}     : curl -i http://127.0.0.1:$WW_NODE_PORT/api/wallets"
    echo ""
    log "[ww_deploy_app] deployed=$WW_APP_DIR active=$(systemctl is-active grin-web-wallet 2>/dev/null || echo unknown)"
    pause
}

# =============================================================================
# STEP 4 — Configure nginx (reverse proxy to 127.0.0.1:7420)
# =============================================================================

ww_configure_nginx() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet — 4) Configure nginx ──${RESET}\n"

    if ! command -v nginx &>/dev/null; then
        die "nginx not installed — run step 2 first."; pause; return
    fi
    if [[ ! -f "$WW_APP_DIR/server.js" ]]; then
        die "App not deployed yet — run step 3 first."; pause; return
    fi

    while true; do
        echo -ne "Domain (e.g. wallet.mynode.example.com) [${WW_DOMAIN:-}]: "
        read -r input || true
        [[ -n "$input" ]] && WW_DOMAIN="$input"
        _ww_validate_domain "$WW_DOMAIN" || { WW_DOMAIN=""; continue; }
        break
    done

    echo ""
    info "Domain    : $WW_DOMAIN"
    info "Reverse proxy → http://127.0.0.1:$WW_NODE_PORT"
    echo ""
    echo -ne "${BOLD}Write HTTP vhost (step 5 adds HTTPS)? [Y/n/0]: ${RESET}"
    read -r confirm || true
    [[ "$confirm" == "0" ]] && return
    [[ "${confirm,,}" == "n" ]] && info "Cancelled." && return

    # ── Rate-limit zones ──────────────────────────────────────────────────────
    if declare -F nginx_ensure_rate_limit_zones &>/dev/null; then
        nginx_ensure_rate_limit_zones "grin-web-wallet-ratelimit" \
            "${WW_RATELIMIT_ZONE}_send:3r/m"   \
            "${WW_RATELIMIT_ZONE}_api:10r/m"   \
            "${WW_RATELIMIT_ZONE}_http:20r/m"
    else
        mkdir -p /etc/nginx/conf.d
        cat > "$WW_RATELIMIT_CONF" << RATELIMIT
# Grin Web Wallet rate limits
limit_req_zone \$binary_remote_addr zone=${WW_RATELIMIT_ZONE}_send:10m  rate=3r/m;
limit_req_zone \$binary_remote_addr zone=${WW_RATELIMIT_ZONE}_api:10m   rate=10r/m;
limit_req_zone \$binary_remote_addr zone=${WW_RATELIMIT_ZONE}_http:10m  rate=20r/m;
RATELIMIT
    fi

    # HTTP-only vhost — certbot --nginx (step 5) adds HTTPS automatically
    info "Writing HTTP vhost → $WW_NGINX_CONF ..."
    cat > "$WW_NGINX_CONF" << NGINX_HTTP
# Grin Web Wallet — generated by 051_grin_private_web_wallet.sh (HTTP only — step 5 adds HTTPS)
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

    # Refresh wallet.env so Node accepts requests for the new public host
    ww_save_config
    ww_save_env
    log "[ww_configure_nginx] domain=$WW_DOMAIN"
    pause
}

# =============================================================================
# STEP 5 — Setup SSL (Let's Encrypt OR Cloudflare Origin Cert)
# =============================================================================

_ww_write_https_vhost() {
    # $1 = kind label (for header comment)
    # $2 = cert path
    # $3 = key path
    # $4 = extra ssl block lines (e.g. include /etc/letsencrypt/options-ssl-nginx.conf;)
    local kind="$1" cert="$2" key="$3" extra="${4:-}"
    cat > "$WW_NGINX_CONF" << NGINX_HTTPS
# Grin Web Wallet — generated by 051_grin_private_web_wallet.sh ($kind)
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

    ssl_certificate     $cert;
    ssl_certificate_key $key;
$extra

    server_tokens off;
    client_max_body_size 1m;

    auth_basic           "Grin Wallet";
    auth_basic_user_file $WW_HTPASSWD;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options    "nosniff"     always;
    add_header X-Frame-Options           "DENY"        always;
    add_header Referrer-Policy           "no-referrer" always;
    # 'unsafe-inline' permits the small <head> theme-bootstrap script in index.html.
    # If that script is ever moved to a .js file, tighten back to 'self' only.
    add_header Content-Security-Policy   "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self';" always;
    add_header Permissions-Policy        "geolocation=(), microphone=(), camera=()" always;
    add_header X-XSS-Protection          "0" always;

    access_log /var/log/nginx/grin-web-wallet-access.log;
    error_log  /var/log/nginx/grin-web-wallet-error.log;

    # ── Reverse proxy to Node ─────────────────────────────────────────────────
    # Wallet send endpoint — tight rate limit (also enforced server-side).
    location ~ ^/api/wallet/[^/]+/send$ {
        limit_req zone=${WW_RATELIMIT_ZONE}_send burst=2 nodelay;
        proxy_pass         http://127.0.0.1:$WW_NODE_PORT;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$http_host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 180s;
        proxy_send_timeout 180s;
    }

    # All other API endpoints
    location /api/ {
        limit_req zone=${WW_RATELIMIT_ZONE}_api burst=5 nodelay;
        proxy_pass         http://127.0.0.1:$WW_NODE_PORT;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$http_host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
        # SSE endpoints (/api/setup/nodes, /api/setup/install-binary) need buffering off
        proxy_buffering off;
        proxy_cache off;
    }

    # Static client + everything else
    location / {
        limit_req zone=${WW_RATELIMIT_ZONE}_http burst=10 nodelay;
        proxy_pass         http://127.0.0.1:$WW_NODE_PORT;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$http_host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
    }

    # Hide dotfiles, editor backups
    location ~ /\.        { deny all; }
    location ~ ~\$        { deny all; }
}
NGINX_HTTPS
}

ww_setup_ssl() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet — 5) Setup SSL ──${RESET}\n"

    if ! command -v certbot &>/dev/null; then
        die "certbot not installed — run step 2 first."; pause; return
    fi
    if [[ -z "$WW_DOMAIN" ]]; then
        die "Domain not configured — run step 4 first."; pause; return
    fi
    if [[ ! -f "$WW_NGINX_CONF" ]]; then
        die "nginx vhost not configured — run step 4 first."; pause; return
    fi

    # ── Gate: refuse to expose the wallet on HTTPS without Basic Auth ─────────
    # Without htpasswd, nginx would either 500 every request (file referenced
    # but missing) OR — worse, if the directive were removed — leave the wallet
    # UI wide open on the public domain.
    if [[ ! -f "$WW_HTPASSWD" ]]; then
        warn "Basic Auth (step 6) is required BEFORE enabling SSL."
        warn "Without it the wallet UI would be exposed on $WW_DOMAIN to anyone."
        echo ""
        echo -ne "  Run step 6 (Basic Auth) now? [Y/n/0]: "
        read -r _gate; _gate="${_gate:-y}"
        [[ "$_gate" == "0" || "${_gate,,}" == "n" ]] && { info "SSL setup cancelled."; pause; return; }
        ww_setup_auth || true
        if [[ ! -f "$WW_HTPASSWD" ]]; then
            die "Basic Auth setup did not complete — refusing to enable SSL."
            pause; return
        fi
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
        while true; do
            echo -ne "Let's Encrypt email [${WW_EMAIL:-}]: "
            read -r input || true
            [[ -n "$input" ]] && WW_EMAIL="$input"
            _ww_validate_email "$WW_EMAIL" || { WW_EMAIL=""; continue; }
            break
        done

        echo -ne "  Press Enter to request certificate for $WW_DOMAIN, or 0 to cancel: "
        read -r _confirm || true
        [[ "$_confirm" == "0" ]] && return

        if ! certbot certonly --nginx -d "$WW_DOMAIN" --non-interactive --agree-tos -m "$WW_EMAIL"; then
            warn "certbot failed — ensure DNS points to this server and port 80 is open."
            warn "Using Cloudflare? Switch DNS from 'Proxied' to 'DNS only' (grey cloud),"
            warn "then re-run this step. After cert is issued you can switch back to Proxied."
            warn "Or choose option 2) Cloudflare Origin Certificate."
            pause; return
        fi
        success "SSL certificate issued for $WW_DOMAIN"

        _ww_write_https_vhost "Let's Encrypt" \
            "/etc/letsencrypt/live/$WW_DOMAIN/fullchain.pem" \
            "/etc/letsencrypt/live/$WW_DOMAIN/privkey.pem" \
            "    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"

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

        _ww_write_https_vhost "Cloudflare Origin Cert" \
            "$cf_dir/$WW_DOMAIN.pem" \
            "$cf_dir/$WW_DOMAIN.key" \
            "    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;"
    fi

    ln -sf "$WW_NGINX_CONF" "$WW_NGINX_LINK" 2>/dev/null || true

    if nginx -t 2>&1 | tail -5 && systemctl reload nginx; then
        success "nginx HTTPS config loaded."
    else
        warn "nginx config test failed — check $WW_NGINX_CONF"; pause; return
    fi

    ww_save_config
    ww_save_env       # writes WW_PUBLIC_ORIGIN so Node accepts the public domain
    log "[ww_setup_ssl] domain=$WW_DOMAIN ssl=$ssl_choice"
    pause
}

# =============================================================================
# STEP 6 — Setup Basic Auth
# =============================================================================

ww_setup_auth() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet — 6) Setup Basic Auth ──${RESET}\n"

    if ! command -v htpasswd &>/dev/null; then
        die "htpasswd not installed — run step 2 first."; pause; return
    fi

    echo -e "  ${DIM}Basic Auth is layer 1 — protects the wallet UI with a username + password.${RESET}"
    echo -e "  ${DIM}Layer 2 is the per-wallet passphrase managed by the Node app.${RESET}"
    echo ""
    while true; do
        echo -ne "Auth username [${WW_AUTH_USER:-grin}]: "
        read -r input || true
        [[ -n "$input" ]] && WW_AUTH_USER="$input"
        WW_AUTH_USER="${WW_AUTH_USER:-grin}"
        _ww_validate_auth_user "$WW_AUTH_USER" || { WW_AUTH_USER=""; continue; }
        break
    done

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
    log "[ww_setup_auth] user=$WW_AUTH_USER"
    pause
}

# =============================================================================
# STEP 7 — Configure firewall
# =============================================================================

ww_configure_firewall() {
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet — 7) Configure Firewall ──${RESET}\n"
    echo -e "  ${DIM}Opens ports 80 and 443. Node + wallet API ports stay localhost-only.${RESET}"
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
    log "[ww_configure_firewall]"
    pause
}

# =============================================================================
# STEP 8 — Status & info
# =============================================================================

ww_show_info() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet — 8) Status & Info ──${RESET}\n"

    # Dependencies
    local deps_ok=1
    for cmd in node nginx certbot htpasswd; do
        command -v "$cmd" &>/dev/null || { deps_ok=0; break; }
    done
    [[ $deps_ok -eq 1 ]] && echo -e "  ${BOLD}Dependencies${RESET}  : ${GREEN}all present${RESET}" \
                         || echo -e "  ${BOLD}Dependencies${RESET}  : ${RED}some missing${RESET}  ${DIM}(step 2)${RESET}"

    command -v qrencode &>/dev/null \
        && echo -e "  ${BOLD}qrencode${RESET}      : ${GREEN}installed${RESET}" \
        || echo -e "  ${BOLD}qrencode${RESET}      : ${YELLOW}not installed${RESET}  ${DIM}(QR codes may be hidden)${RESET}"

    if [[ -x "$WW_BIN" ]]; then
        local ver; ver=$("$WW_BIN" --version 2>/dev/null | head -1 || echo "?")
        echo -e "  ${BOLD}grin-wallet${RESET}   : ${GREEN}$ver${RESET}"
    else
        echo -e "  ${BOLD}grin-wallet${RESET}   : ${RED}not installed${RESET}  ${DIM}(step 1)${RESET}"
    fi

    if [[ -f "$WW_APP_DIR/server.js" ]]; then
        echo -e "  ${BOLD}App files${RESET}     : ${GREEN}deployed${RESET}  ${DIM}($WW_APP_DIR)${RESET}"
    else
        echo -e "  ${BOLD}App files${RESET}     : ${RED}not deployed${RESET}  ${DIM}(step 3)${RESET}"
    fi

    if [[ -f "$WW_SYSTEMD_UNIT" ]]; then
        if systemctl is-active --quiet grin-web-wallet 2>/dev/null; then
            echo -e "  ${BOLD}systemd${RESET}       : ${GREEN}running${RESET}  ${DIM}(127.0.0.1:$WW_NODE_PORT)${RESET}"
        else
            echo -e "  ${BOLD}systemd${RESET}       : ${YELLOW}stopped${RESET}  ${DIM}(systemctl start grin-web-wallet)${RESET}"
        fi
    else
        echo -e "  ${BOLD}systemd${RESET}       : ${RED}not installed${RESET}  ${DIM}(step 3)${RESET}"
    fi

    [[ -f "$WW_NGINX_CONF" ]] \
        && echo -e "  ${BOLD}nginx vhost${RESET}   : ${GREEN}configured${RESET}  ${DIM}($WW_NGINX_CONF)${RESET}" \
        || echo -e "  ${BOLD}nginx vhost${RESET}   : ${RED}not configured${RESET}  ${DIM}(step 4)${RESET}"

    if [[ -n "$WW_DOMAIN" && -f "/etc/letsencrypt/live/$WW_DOMAIN/fullchain.pem" ]]; then
        local cert_expiry
        cert_expiry=$(openssl x509 -enddate -noout \
            -in "/etc/letsencrypt/live/$WW_DOMAIN/fullchain.pem" 2>/dev/null \
            | sed 's/notAfter=//' || echo "unknown")
        echo -e "  ${BOLD}SSL cert${RESET}      : ${GREEN}Let's Encrypt${RESET}  ${DIM}(expires: $cert_expiry)${RESET}"
    elif [[ -n "$WW_DOMAIN" && -f "/etc/ssl/cloudflare-origin/$WW_DOMAIN.pem" ]]; then
        echo -e "  ${BOLD}SSL cert${RESET}      : ${GREEN}Cloudflare Origin${RESET}  ${DIM}($WW_DOMAIN)${RESET}"
    else
        echo -e "  ${BOLD}SSL cert${RESET}      : ${RED}not issued${RESET}  ${DIM}(step 5)${RESET}"
    fi

    [[ -f "$WW_HTPASSWD" ]] \
        && echo -e "  ${BOLD}Basic Auth${RESET}    : ${GREEN}configured${RESET}  ${DIM}(user: ${WW_AUTH_USER:-grin})${RESET}" \
        || echo -e "  ${BOLD}Basic Auth${RESET}    : ${RED}not configured${RESET}  ${DIM}(step 6)${RESET}"

    if [[ -L "$WW_NGINX_LINK" ]]; then
        echo -e "  ${BOLD}Web UI${RESET}        : ${GREEN}LIVE${RESET}  ${DIM}→ https://${WW_DOMAIN:-<domain>}${RESET}"
    else
        echo -e "  ${BOLD}Web UI${RESET}        : ${RED}not live${RESET}  ${DIM}(complete steps 3-6)${RESET}"
    fi

    # Tor (used for grin-wallet Tor sends)
    if systemctl is-active --quiet tor 2>/dev/null || systemctl is-active --quiet tor@default 2>/dev/null; then
        if ss -tln 2>/dev/null | grep -q ":9050 "; then
            echo -e "  ${BOLD}Tor${RESET}           : ${GREEN}running${RESET}  ${DIM}(SOCKS5 on 9050)${RESET}"
        else
            echo -e "  ${BOLD}Tor${RESET}           : ${YELLOW}service active, port 9050 not yet listening${RESET}"
        fi
    else
        echo -e "  ${BOLD}Tor${RESET}           : ${YELLOW}not running${RESET}  ${DIM}(Tor sends will fail)${RESET}"
    fi

    # Wallets registered
    if [[ -f "$WW_REGISTRY" ]] && command -v jq &>/dev/null; then
        echo ""
        echo -e "  ${BOLD}Wallets registered${RESET}:"
        jq -r '.wallets[]? | "    \(.network)  \(.name)  → owner :\(.ownerPort)  foreign :\(.foreignPort)"' "$WW_REGISTRY" 2>/dev/null \
            || echo "    (none)"
    fi

    echo ""
    [[ -n "$WW_DOMAIN" ]] && echo -e "  URL: ${BOLD}${GREEN}https://$WW_DOMAIN${RESET}"
    echo -e "  Node port      : 127.0.0.1:$WW_NODE_PORT  (Node app, behind nginx)"
    echo -e "  App dir        : $WW_APP_DIR"
    echo -e "  Wallets root   : $WW_ROOT"
    echo -e "  Registry       : $WW_REGISTRY"
    echo ""
    pause
}

# =============================================================================
# STEP 9 — Edit saved settings
# =============================================================================

ww_edit_settings() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet — 9) Edit Saved Settings ──${RESET}\n"
    echo -e "  ${DIM}Press Enter to keep the current value.${RESET}"
    echo ""

    echo -ne "Domain              [${WW_DOMAIN:-}]: "
    read -r v || true
    if [[ -n "$v" ]]; then
        _ww_validate_domain "$v" && WW_DOMAIN="$v" || info "Domain unchanged."
    fi

    echo -ne "Auth username       [${WW_AUTH_USER:-grin}]: "
    read -r v || true
    if [[ -n "$v" ]]; then
        _ww_validate_auth_user "$v" && WW_AUTH_USER="$v" || info "Username unchanged."
    fi

    echo -ne "Let's Encrypt email [${WW_EMAIL:-}]: "
    read -r v || true
    if [[ -n "$v" ]]; then
        _ww_validate_email "$v" && WW_EMAIL="$v" || info "Email unchanged."
    fi

    ww_save_config
    ww_save_env
    success "Settings saved → $WW_CONF_FILE  + env → $WW_ENV_FILE"
    info "If grin-web-wallet is running it was restarted to pick up env changes."
    pause
}

# =============================================================================
# XP WALLET LAUNCHER (optional — separate fun/nostalgia variant)
# =============================================================================

_launch_xp_wallet() {
    local xp_script="$SCRIPT_DIR/051x_grin_xp_wallet.sh"
    if [[ ! -f "$xp_script" ]]; then
        error "051x_grin_xp_wallet.sh not found in $SCRIPT_DIR"
        pause
        return 1
    fi
    bash "$xp_script"
}

# =============================================================================
# WALLET MENU
# =============================================================================

wallet_menu() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN} 051) GRIN PRIVATE WEB WALLET  (Node.js)${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        ww_menu_status

        echo -e "${DIM}  ─── First-time setup (run in order) ─────────────${RESET}"
        echo -e "  ${GREEN}1${RESET}) Install grin-wallet binary"
        echo -e "  ${GREEN}2${RESET}) Install dependencies      ${DIM}(nodejs, nginx, certbot, htpasswd, tor, qrencode, jq)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Deploy app + systemd      ${DIM}(web/051_wallet/ → $WW_APP_DIR)${RESET}"
        echo -e "  ${GREEN}4${RESET}) Configure nginx           ${DIM}(reverse proxy → 127.0.0.1:$WW_NODE_PORT)${RESET}"
        echo -e "  ${GREEN}5${RESET}) Setup SSL                 ${DIM}(Let's Encrypt or Cloudflare Origin)${RESET}"
        echo -e "  ${GREEN}6${RESET}) Setup Basic Auth          ${DIM}(set / change password)${RESET}"
        echo -e "  ${GREEN}7${RESET}) Configure firewall        ${DIM}(open ports 80 + 443)${RESET}"
        echo ""
        echo -e "${DIM}  ─── Info / maintenance ──────────────────────────${RESET}"
        echo -e "  ${CYAN}8${RESET}) Status & info"
        echo -e "  ${CYAN}9${RESET}) Edit saved settings       ${DIM}(domain, email, auth user)${RESET}"
        echo ""
        echo -e "  ${BOLD}${YELLOW}xp${RESET}${DIM}) Launch XP Wallet (separate script — mainnet only, real GRIN)${RESET}"
        echo ""
        echo -e "  ${DIM}↩  Press Enter to refresh${RESET}"
        echo -e "  ${RED}0${RESET}) Back to main menu"
        echo ""
        echo -ne "${BOLD}Select [1-9 / xp / 0]: ${RESET}"
        read -r choice || true

        case "$choice" in
            1)     ww_install_binary    || true ;;
            2)     ww_install_deps      || true ;;
            3)     ww_deploy_app        || true ;;
            4)     ww_configure_nginx   || true ;;
            5)     ww_setup_ssl         || true ;;
            6)     ww_setup_auth        || true ;;
            7)     ww_configure_firewall|| true ;;
            8)     ww_show_info         || true ;;
            9)     ww_edit_settings     || true ;;
            xp|XP) _launch_xp_wallet    || true ;;
            0)     break ;;
            "")    continue ;;
            *)     warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# =============================================================================
# MAIN
# =============================================================================

main() {
    wallet_menu
}

main "$@"
