#!/bin/bash
# =============================================================================
# 051x_grin_xp_wallet.sh — Grin XP Wallet  (Experimental / Fun)
# =============================================================================
#
#  Deploys the private web wallet inside a Windows XP desktop simulator.
#  MAINNET ONLY. The WinXP chrome is purely cosmetic.
#
#  ─── Deploy layout ───────────────────────────────────────────────────────────
#   /var/www/web-wallet-xp/index.html     ← WinXP desktop shell
#   /var/www/web-wallet-xp/wallet/        ← PHP wallet app (iframe src)
#
#  ─── Menu keys ───────────────────────────────────────────────────────────────
#   a) Install dependencies   b) Deploy web files   c) Configure nginx
#   d) Setup SSL              e) Setup Basic Auth    f) Configure firewall
#   i) Status & info          j) Edit saved settings
#   0) Back
#
#  Config:   /opt/grin/webwallet/xp-mainnet/config.conf
#  Deploy:   /var/www/web-wallet-xp/
#  nginx:    /etc/nginx/sites-available/web-wallet-xp
#  htpasswd: /etc/nginx/web-wallet-xp.htpasswd
#
#  ─── Security hardening — already implemented ────────────────────────────────
#   nginx : server_tokens off, client_max_body_size 64k
#   nginx : HSTS + CSP + X-Content-Type-Options + Referrer-Policy
#   nginx : X-Frame-Options: SAMEORIGIN (allows XP shell iframe, same origin only)
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
#   [ ] CSP 'unsafe-inline' — current XP shell uses inline <script> and onclick=
#                   attributes which require 'unsafe-inline' in script-src.
#                   Future: move xp_shell/index.html inline JS to xp-shell.js and
#                   replace onclick= with addEventListener() calls — then CSP can
#                   drop 'unsafe-inline' and use script-src 'self' like 051 does.
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

# ─── Logging ──────────────────────────────────────────────────────────────────
LOG_DIR="/opt/grin/logs"
LOG_FILE="$LOG_DIR/grin_xp_wallet_$(date +%Y%m%d_%H%M%S).log"
mkdir -p "$LOG_DIR" 2>/dev/null || true
log()     { echo -e "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; log "[INFO] $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; log "[OK] $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; log "[WARN] $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; log "[ERROR] $*"; }
die()     { error "$*"; return 1; }
pause()   { echo ""; echo -e "${DIM}Press Enter to continue...${RESET}"; read -r || true; }

# ─── Constants (mainnet only) ─────────────────────────────────────────────────
XP_WALLET_API_PORT=3415
XP_DEPLOY_DIR="/var/www/web-wallet-xp"
XP_CONF_DIR="/opt/grin/webwallet/xp-mainnet"
XP_CONF_FILE="/opt/grin/webwallet/xp-mainnet/config.conf"
XP_NGINX_CONF="/etc/nginx/sites-available/web-wallet-xp"
XP_NGINX_LINK="/etc/nginx/sites-enabled/web-wallet-xp"
XP_HTPASSWD="/etc/nginx/web-wallet-xp.htpasswd"
XP_RATELIMIT_ZONE="grin_ww_xp"
XP_SRC_DIR="$TOOLKIT_ROOT/web/051_xp_wallet/public_html"
XP_SHELL_DIR="$TOOLKIT_ROOT/web/051_xp_wallet/xp_shell"

# ─── Per-instance settings ────────────────────────────────────────────────────
XP_DOMAIN=""
XP_EMAIL=""
XP_AUTH_USER="grin"
XP_PHP_FPM_SOCK=""

# =============================================================================
# CONFIG HELPERS
# =============================================================================

xp_load_config() {
    XP_DOMAIN=""
    XP_EMAIL=""
    XP_AUTH_USER="grin"
    XP_PHP_FPM_SOCK=""
    if [[ -f "$XP_CONF_FILE" ]]; then
        # shellcheck disable=SC1090
        source "$XP_CONF_FILE" 2>/dev/null || true
    fi
}

xp_save_config() {
    mkdir -p "$XP_CONF_DIR"
    cat > "$XP_CONF_FILE" << CONF
XP_DOMAIN="${XP_DOMAIN:-}"
XP_EMAIL="${XP_EMAIL:-}"
XP_AUTH_USER="${XP_AUTH_USER:-grin}"
XP_PHP_FPM_SOCK="${XP_PHP_FPM_SOCK:-}"
CONF
    chmod 600 "$XP_CONF_FILE"
}

# =============================================================================
# STATUS (menu header)
# =============================================================================

xp_menu_status() {
    xp_load_config
    echo ""

    local deps_ok=1
    for cmd in nginx php certbot htpasswd; do
        command -v "$cmd" &>/dev/null || { deps_ok=0; break; }
    done
    [[ $deps_ok -eq 1 ]] \
        && echo -e "  ${BOLD}a Dependencies${RESET} : ${GREEN}OK${RESET}" \
        || echo -e "  ${BOLD}a Dependencies${RESET} : ${RED}missing${RESET}  ${DIM}→ step a${RESET}"

    [[ -d "$XP_DEPLOY_DIR" ]] \
        && echo -e "  ${BOLD}b Files${RESET}        : ${GREEN}deployed${RESET}  ${DIM}($XP_DEPLOY_DIR)${RESET}" \
        || echo -e "  ${BOLD}b Files${RESET}        : ${DIM}not deployed${RESET}  ${DIM}→ step b${RESET}"

    [[ -f "$XP_NGINX_CONF" ]] \
        && echo -e "  ${BOLD}c nginx vhost${RESET}  : ${GREEN}configured${RESET}  ${DIM}($XP_NGINX_CONF)${RESET}" \
        || echo -e "  ${BOLD}c nginx vhost${RESET}  : ${DIM}not configured${RESET}  ${DIM}→ step c${RESET}"

    if [[ -n "$XP_DOMAIN" && -f "/etc/letsencrypt/live/$XP_DOMAIN/fullchain.pem" ]]; then
        echo -e "  ${BOLD}d SSL${RESET}          : ${GREEN}Let's Encrypt${RESET}  ${DIM}($XP_DOMAIN)${RESET}"
    elif [[ -n "$XP_DOMAIN" && -f "/etc/ssl/cloudflare-origin/$XP_DOMAIN.pem" ]]; then
        echo -e "  ${BOLD}d SSL${RESET}          : ${GREEN}Cloudflare Origin${RESET}  ${DIM}($XP_DOMAIN)${RESET}"
    else
        echo -e "  ${BOLD}d SSL${RESET}          : ${DIM}not configured${RESET}  ${DIM}→ step d${RESET}"
    fi

    [[ -f "$XP_HTPASSWD" ]] \
        && echo -e "  ${BOLD}e Basic Auth${RESET}   : ${GREEN}configured${RESET}  ${DIM}(user: ${XP_AUTH_USER:-grin})${RESET}" \
        || echo -e "  ${BOLD}e Basic Auth${RESET}   : ${DIM}not configured${RESET}  ${DIM}→ step e${RESET}"

    if [[ -L "$XP_NGINX_LINK" ]]; then
        echo -e "  ${BOLD}Web UI${RESET}         : ${GREEN}LIVE${RESET}  ${DIM}→ https://${XP_DOMAIN:-<domain>}${RESET}"
    else
        echo -e "  ${BOLD}Web UI${RESET}         : ${DIM}not live${RESET}"
    fi

    local wallet_session="grin_wallet_mainnet"
    if tmux has-session -t "$wallet_session" 2>/dev/null; then
        echo -e "  ${BOLD}Wallet${RESET}         : ${GREEN}listening${RESET}  ${DIM}(tmux: $wallet_session)${RESET}"
    else
        echo -e "  ${BOLD}Wallet${RESET}         : ${RED}not listening${RESET}  ${YELLOW}⚠ start via script 05 option c${RESET}"
    fi
    echo ""
}

# =============================================================================
# STEP a — Install dependencies
# =============================================================================

xp_install_deps() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin XP Wallet [MAINNET] — a) Install Dependencies ──${RESET}\n"

    local all_ok=1
    for pkg_cmd in "nginx:nginx" "php:php" "certbot:certbot" "htpasswd:apache2-utils" "qrencode:qrencode"; do
        local cmd="${pkg_cmd%%:*}"
        command -v "$cmd" &>/dev/null && success "$cmd already installed." || { warn "$cmd not found"; all_ok=0; }
    done

    if [[ $all_ok -eq 1 ]]; then
        echo ""; success "All dependencies are present."; pause; return
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

    echo ""; info "Verification:"
    for pkg_cmd in "nginx:nginx" "php:php" "certbot:certbot" "htpasswd:apache2-utils" "qrencode:qrencode"; do
        local cmd="${pkg_cmd%%:*}"
        command -v "$cmd" &>/dev/null && success "$cmd  OK" || warn "$cmd  MISSING — install manually"
    done
    log "[xp_install_deps]"
    pause
}

# =============================================================================
# STEP b — Deploy files
# =============================================================================

xp_deploy_files() {
    xp_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Grin XP Wallet [MAINNET] — b) Deploy Files ──${RESET}\n"

    if [[ ! -d "$XP_SRC_DIR" ]]; then
        die "Wallet source not found: $XP_SRC_DIR"
        warn "Ensure web/051_xp_wallet/public_html/ exists in the toolkit."; pause; return
    fi
    if [[ ! -d "$XP_SHELL_DIR" ]]; then
        die "XP shell source not found: $XP_SHELL_DIR"
        warn "Ensure web/051_xp_wallet/xp_shell/ exists in the toolkit."; pause; return
    fi

    if [[ -d "$XP_DEPLOY_DIR" ]]; then
        warn "Directory already exists: $XP_DEPLOY_DIR"
        echo -ne "Update files? [Y/n/0]: "
        read -r ow || true
        [[ "$ow" == "0" ]] && return
        [[ "${ow,,}" == "n" ]] && info "Cancelled." && return
    fi

    info "Deploying XP shell → $XP_DEPLOY_DIR ..."
    mkdir -p "$XP_DEPLOY_DIR"
    cp -r "$XP_SHELL_DIR"/. "$XP_DEPLOY_DIR/"

    info "Deploying wallet app → $XP_DEPLOY_DIR/wallet/ ..."
    mkdir -p "$XP_DEPLOY_DIR/wallet"
    cp -r "$XP_SRC_DIR"/. "$XP_DEPLOY_DIR/wallet/"
    rm -f "$XP_DEPLOY_DIR/wallet/api/config.json" 2>/dev/null || true

    # Write config.php (network-specific)
    cat > "$XP_DEPLOY_DIR/wallet/api/config.php" << PHP
<?php
// Generated by 051x_grin_xp_wallet.sh — do not edit manually
define('WALLET_API_PORT', $XP_WALLET_API_PORT);
define('NETWORK_LABEL',   'Mainnet');
define('XP_MODE',         true);
PHP
    chmod 644 "$XP_DEPLOY_DIR/wallet/api/config.php"
    info "config.php written: port=$XP_WALLET_API_PORT  network=Mainnet  XP_MODE=true"

    chown -R www-data:www-data "$XP_DEPLOY_DIR" 2>/dev/null \
        || warn "Could not chown to www-data — set permissions manually."
    chmod -R 755 "$XP_DEPLOY_DIR"

    # API credential config (outside webroot, chmod 640)
    local api_conf="$XP_CONF_DIR/grin_web_wallet_api.json"
    local owner_secret=""
    local wallets_conf="/opt/grin/conf/grin_wallets_location.conf"
    local wallet_dir=""
    if [[ -f "$wallets_conf" ]]; then
        wallet_dir=$( (source "$wallets_conf" 2>/dev/null; echo "${MAINNET_WALLET_DIR:-}") 2>/dev/null || true)
    fi
    local secret_file="${wallet_dir:-/opt/grin/wallet/mainnet}/wallet_data/.owner_api_secret"
    if [[ -f "$secret_file" ]]; then
        owner_secret=$(tr -d '[:space:]' < "$secret_file" 2>/dev/null || true)
        info "Owner API secret loaded from $secret_file"
    else
        warn "Owner API secret not found at $secret_file"
        warn "Start the wallet listener (script 05 option c) first, then re-run Deploy."
    fi

    mkdir -p "$XP_CONF_DIR"
    cat > "$api_conf" << JSON
{
    "walletHost": "127.0.0.1",
    "walletPort": $XP_WALLET_API_PORT,
    "ownerApiSecret": "$owner_secret"
}
JSON
    chown root:www-data "$api_conf" 2>/dev/null || chown root "$api_conf" 2>/dev/null || true
    chmod 640 "$api_conf"
    info "API config → $api_conf (chmod 640)"

    xp_save_config
    success "Files deployed to $XP_DEPLOY_DIR"
    log "[xp_deploy_files] deploy_dir=$XP_DEPLOY_DIR"
    pause
}

# =============================================================================
# STEP c — Configure nginx
# =============================================================================

xp_configure_nginx() {
    xp_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Grin XP Wallet [MAINNET] — c) Configure nginx ──${RESET}\n"

    if ! command -v nginx &>/dev/null; then
        die "nginx not installed — run step a first."; pause; return
    fi
    if [[ ! -d "$XP_DEPLOY_DIR" ]]; then
        die "Files not deployed yet — run step b first."; pause; return
    fi

    while true; do
        echo -ne "Domain (e.g. xp.mynode.example.com) [${XP_DOMAIN:-}]: "
        read -r input || true
        [[ -n "$input" ]] && XP_DOMAIN="$input"
        [[ -z "$XP_DOMAIN" ]] && warn "No domain entered." && continue
        break
    done

    if [[ -z "$XP_PHP_FPM_SOCK" ]]; then
        local php_ver
        php_ver=$(php --version 2>/dev/null | grep -oP '^\S+ \K\d+\.\d+' | head -1 || echo "")
        if [[ -n "$php_ver" && -S "/run/php/php${php_ver}-fpm.sock" ]]; then
            XP_PHP_FPM_SOCK="unix:/run/php/php${php_ver}-fpm.sock"
        elif [[ -S "/run/php/php-fpm.sock" ]]; then
            XP_PHP_FPM_SOCK="unix:/run/php/php-fpm.sock"
        fi
    fi
    echo -ne "PHP-FPM socket [${XP_PHP_FPM_SOCK:-unix:/run/php/php-fpm.sock}]: "
    read -r input || true
    [[ -n "$input" ]] && XP_PHP_FPM_SOCK="$input"
    XP_PHP_FPM_SOCK="${XP_PHP_FPM_SOCK:-unix:/run/php/php-fpm.sock}"

    echo ""
    info "Domain    : $XP_DOMAIN"
    info "Deploy dir: $XP_DEPLOY_DIR"
    info "PHP-FPM   : $XP_PHP_FPM_SOCK"
    echo ""
    echo -ne "${BOLD}Write nginx config? [Y/n/0]: ${RESET}"
    read -r confirm || true
    [[ "$confirm" == "0" ]] && return
    [[ "${confirm,,}" == "n" ]] && info "Cancelled." && return

    mkdir -p /etc/nginx/conf.d
    cat > "/etc/nginx/conf.d/grin-xp-wallet-ratelimit.conf" << RATELIMIT
# Grin XP Wallet rate limits
limit_req_zone \$binary_remote_addr zone=${XP_RATELIMIT_ZONE}_tx:10m   rate=3r/m;
limit_req_zone \$binary_remote_addr zone=${XP_RATELIMIT_ZONE}_api:10m  rate=10r/m;
limit_req_zone \$binary_remote_addr zone=${XP_RATELIMIT_ZONE}_http:10m rate=20r/m;
RATELIMIT

    info "Writing HTTP vhost → $XP_NGINX_CONF ..."
    cat > "$XP_NGINX_CONF" << NGINX_HTTP
# Grin XP Wallet [MAINNET] — generated by 051x_grin_xp_wallet.sh (HTTP — run step d for HTTPS)
server {
    listen 80;
    listen [::]:80;
    server_name $XP_DOMAIN;
    location / { return 301 https://\$host\$request_uri; }
}
NGINX_HTTP

    ln -sf "$XP_NGINX_CONF" "$XP_NGINX_LINK" 2>/dev/null || true
    nginx -t && systemctl reload nginx && success "nginx vhost configured and reloaded." \
        || { warn "nginx config test failed — check $XP_NGINX_CONF"; pause; return; }

    xp_save_config
    log "[xp_configure_nginx] domain=$XP_DOMAIN"
    pause
}

# =============================================================================
# STEP d — Setup SSL
# =============================================================================

xp_setup_ssl() {
    xp_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Grin XP Wallet [MAINNET] — d) Setup SSL ──${RESET}\n"

    if ! command -v certbot &>/dev/null; then
        die "certbot not installed — run step a first."; pause; return
    fi
    if [[ -z "$XP_DOMAIN" ]]; then
        die "Domain not configured — run step c first."; pause; return
    fi
    if [[ ! -f "$XP_NGINX_CONF" ]]; then
        die "nginx vhost not configured — run step c first."; pause; return
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
        echo -ne "Let's Encrypt email [${XP_EMAIL:-}]: "
        read -r input || true
        [[ -n "$input" ]] && XP_EMAIL="$input"
        if [[ -z "$XP_EMAIL" ]]; then
            warn "Email required for Let's Encrypt."; pause; return
        fi

        echo -ne "  Press Enter to request certificate for $XP_DOMAIN, or 0 to cancel: "
        read -r _confirm || true
        [[ "$_confirm" == "0" ]] && return

        certbot --nginx -d "$XP_DOMAIN" --non-interactive --agree-tos -m "$XP_EMAIL" \
            && success "SSL certificate issued for $XP_DOMAIN" \
            || {
                warn "certbot failed — ensure DNS points to this server and port 80 is open."
                warn "Using Cloudflare? Switch DNS to 'DNS only' (grey cloud), then retry."
                warn "Or choose option 2) Cloudflare Origin Certificate."
                pause; return
            }

        info "Writing HTTPS nginx config → $XP_NGINX_CONF ..."
        cat > "$XP_NGINX_CONF" << NGINX_HTTPS
# Grin XP Wallet [MAINNET] — generated by 051x_grin_xp_wallet.sh (Let's Encrypt)
server {
    listen 80;
    listen [::]:80;
    server_name $XP_DOMAIN;
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $XP_DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$XP_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$XP_DOMAIN/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    server_tokens off;
    client_max_body_size 64k;

    root  $XP_DEPLOY_DIR;
    index index.html;

    auth_basic           "Grin XP Wallet";
    auth_basic_user_file $XP_HTPASSWD;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options    "nosniff"    always;
    add_header X-Frame-Options           "SAMEORIGIN" always;
    add_header Referrer-Policy           "no-referrer" always;
    add_header Content-Security-Policy   "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self';" always;
    add_header Permissions-Policy        "geolocation=(), microphone=(), camera=()" always;
    add_header X-XSS-Protection          "0" always;

    access_log /var/log/nginx/web-wallet-xp-access.log;
    error_log  /var/log/nginx/web-wallet-xp-error.log;

    # Wallet PHP app under /wallet/api/
    location = /wallet/api/proxy.php {
        limit_req zone=${XP_RATELIMIT_ZONE}_tx burst=2 nodelay;
        try_files \$uri =404;
        fastcgi_pass            $XP_PHP_FPM_SOCK;
        fastcgi_param           SCRIPT_FILENAME \$document_root\$fastcgi_script_name;
        fastcgi_hide_header     X-Powered-By;
        include                 fastcgi_params;
    }

    location ~ ^/wallet/api/.*\\.php\$ {
        limit_req zone=${XP_RATELIMIT_ZONE}_api burst=5 nodelay;
        try_files \$uri =404;
        fastcgi_pass            $XP_PHP_FPM_SOCK;
        fastcgi_param           SCRIPT_FILENAME \$document_root\$fastcgi_script_name;
        fastcgi_hide_header     X-Powered-By;
        include                 fastcgi_params;
    }

    location ~* \\.(css|js|ico|png|svg)\$ {
        expires 1h;
        add_header Cache-Control             "public";
        add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
        add_header X-Content-Type-Options    "nosniff" always;
    }

    location / {
        limit_req zone=${XP_RATELIMIT_ZONE}_http burst=10 nodelay;
        try_files \$uri \$uri/ /index.html;
    }

    location ~ /\\.  { deny all; }
    location ~ ~\$   { deny all; }
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
        printf '%s' "$cf_cert" > "$cf_dir/$XP_DOMAIN.pem"
        printf '%s' "$cf_key"  > "$cf_dir/$XP_DOMAIN.key"
        chmod 644 "$cf_dir/$XP_DOMAIN.pem"
        chmod 600 "$cf_dir/$XP_DOMAIN.key"
        success "Cloudflare Origin Certificate saved → $cf_dir/$XP_DOMAIN.pem"

        info "Writing HTTPS nginx config → $XP_NGINX_CONF ..."
        cat > "$XP_NGINX_CONF" << NGINX_CF
# Grin XP Wallet [MAINNET] — generated by 051x_grin_xp_wallet.sh (Cloudflare Origin Cert)
server {
    listen 80;
    listen [::]:80;
    server_name $XP_DOMAIN;
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $XP_DOMAIN;

    ssl_certificate     $cf_dir/$XP_DOMAIN.pem;
    ssl_certificate_key $cf_dir/$XP_DOMAIN.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;

    server_tokens off;
    client_max_body_size 64k;

    root  $XP_DEPLOY_DIR;
    index index.html;

    auth_basic           "Grin XP Wallet";
    auth_basic_user_file $XP_HTPASSWD;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options    "nosniff"    always;
    add_header X-Frame-Options           "SAMEORIGIN" always;
    add_header Referrer-Policy           "no-referrer" always;
    add_header Content-Security-Policy   "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self';" always;
    add_header Permissions-Policy        "geolocation=(), microphone=(), camera=()" always;
    add_header X-XSS-Protection          "0" always;

    access_log /var/log/nginx/web-wallet-xp-access.log;
    error_log  /var/log/nginx/web-wallet-xp-error.log;

    location = /wallet/api/proxy.php {
        limit_req zone=${XP_RATELIMIT_ZONE}_tx burst=2 nodelay;
        try_files \$uri =404;
        fastcgi_pass            $XP_PHP_FPM_SOCK;
        fastcgi_param           SCRIPT_FILENAME \$document_root\$fastcgi_script_name;
        fastcgi_hide_header     X-Powered-By;
        include                 fastcgi_params;
    }

    location ~ ^/wallet/api/.*\\.php\$ {
        limit_req zone=${XP_RATELIMIT_ZONE}_api burst=5 nodelay;
        try_files \$uri =404;
        fastcgi_pass            $XP_PHP_FPM_SOCK;
        fastcgi_param           SCRIPT_FILENAME \$document_root\$fastcgi_script_name;
        fastcgi_hide_header     X-Powered-By;
        include                 fastcgi_params;
    }

    location ~* \\.(css|js|ico|png|svg)\$ {
        expires 1h;
        add_header Cache-Control             "public";
        add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
        add_header X-Content-Type-Options    "nosniff" always;
    }

    location / {
        limit_req zone=${XP_RATELIMIT_ZONE}_http burst=10 nodelay;
        try_files \$uri \$uri/ /index.html;
    }

    location ~ /\\.  { deny all; }
    location ~ ~\$   { deny all; }
}
NGINX_CF
        ln -sf "$XP_NGINX_CONF" "$XP_NGINX_LINK" 2>/dev/null || true
    fi

    nginx -t && systemctl reload nginx && success "nginx HTTPS config loaded." \
        || { warn "nginx config test failed — check $XP_NGINX_CONF"; pause; return; }

    xp_save_config
    log "[xp_setup_ssl] domain=$XP_DOMAIN ssl=$ssl_choice"
    pause
}

# =============================================================================
# STEP e — Setup Basic Auth
# =============================================================================

xp_setup_auth() {
    xp_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Grin XP Wallet [MAINNET] — e) Setup Basic Auth ──${RESET}\n"

    if ! command -v htpasswd &>/dev/null; then
        die "htpasswd not installed — run step a first."; pause; return
    fi

    echo -e "  ${DIM}Basic Auth protects the wallet UI with a username + password.${RESET}"
    echo -e "  ${DIM}Run this step again to change the password.${RESET}"
    echo ""
    echo -ne "Auth username [${XP_AUTH_USER:-grin}]: "
    read -r input || true
    [[ -n "$input" ]] && XP_AUTH_USER="$input"
    XP_AUTH_USER="${XP_AUTH_USER:-grin}"

    local flag="-c"
    if [[ -f "$XP_HTPASSWD" ]]; then
        warn "Password file already exists: $XP_HTPASSWD"
        echo -e "  ${GREEN}1${RESET}) Add / update user '${XP_AUTH_USER}'  ${DIM}(keeps other users)${RESET}"
        echo -e "  ${RED}2${RESET}) Recreate file                    ${DIM}(removes all existing users)${RESET}"
        echo -e "  ${DIM}0) Cancel${RESET}"
        echo -ne "Choice [1]: "
        read -r recreate || true
        [[ "$recreate" == "0" ]] && return
        [[ "${recreate:-1}" != "2" ]] && flag=""
    fi

    echo ""
    info "Setting password for user '${XP_AUTH_USER}':"
    # shellcheck disable=SC2086
    htpasswd $flag "$XP_HTPASSWD" "$XP_AUTH_USER" \
        && success "Basic Auth configured for user '$XP_AUTH_USER'." \
        || { die "htpasswd failed."; pause; return; }

    nginx -t 2>/dev/null && systemctl reload nginx 2>/dev/null || true
    xp_save_config
    log "[xp_setup_auth] user=$XP_AUTH_USER"
    pause
}

# =============================================================================
# STEP f — Configure firewall
# =============================================================================

xp_configure_firewall() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin XP Wallet [MAINNET] — f) Configure Firewall ──${RESET}\n"
    echo -e "  ${DIM}Opens ports 80 and 443. Wallet API port stays localhost-only.${RESET}"
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
    log "[xp_configure_firewall]"
    pause
}

# =============================================================================
# STEP i — Status & info
# =============================================================================

xp_show_info() {
    xp_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Grin XP Wallet [MAINNET] — i) Status & Info ──${RESET}\n"

    local deps_ok=1
    for cmd in nginx php certbot htpasswd; do
        command -v "$cmd" &>/dev/null || { deps_ok=0; break; }
    done
    [[ $deps_ok -eq 1 ]] && echo -e "  ${BOLD}Dependencies${RESET}  : ${GREEN}all present${RESET}" \
                         || echo -e "  ${BOLD}Dependencies${RESET}  : ${RED}some missing${RESET}  ${DIM}(step a)${RESET}"

    command -v qrencode &>/dev/null \
        && echo -e "  ${BOLD}qrencode${RESET}      : ${GREEN}installed${RESET}" \
        || echo -e "  ${BOLD}qrencode${RESET}      : ${YELLOW}not installed${RESET}  ${DIM}QR codes may be hidden${RESET}"

    [[ -d "$XP_DEPLOY_DIR" ]] \
        && echo -e "  ${BOLD}Files${RESET}         : ${GREEN}deployed${RESET}  ${DIM}($XP_DEPLOY_DIR)${RESET}" \
        || echo -e "  ${BOLD}Files${RESET}         : ${RED}not deployed${RESET}  ${DIM}(step b)${RESET}"

    [[ -f "$XP_NGINX_CONF" ]] \
        && echo -e "  ${BOLD}nginx vhost${RESET}   : ${GREEN}configured${RESET}  ${DIM}($XP_NGINX_CONF)${RESET}" \
        || echo -e "  ${BOLD}nginx vhost${RESET}   : ${RED}not configured${RESET}  ${DIM}(step c)${RESET}"

    if [[ -n "$XP_DOMAIN" && -f "/etc/letsencrypt/live/$XP_DOMAIN/fullchain.pem" ]]; then
        local cert_expiry
        cert_expiry=$(openssl x509 -enddate -noout \
            -in "/etc/letsencrypt/live/$XP_DOMAIN/fullchain.pem" 2>/dev/null \
            | sed 's/notAfter=//' || echo "unknown")
        echo -e "  ${BOLD}SSL cert${RESET}      : ${GREEN}Let's Encrypt${RESET}  ${DIM}(expires: $cert_expiry)${RESET}"
    elif [[ -n "$XP_DOMAIN" && -f "/etc/ssl/cloudflare-origin/$XP_DOMAIN.pem" ]]; then
        echo -e "  ${BOLD}SSL cert${RESET}      : ${GREEN}Cloudflare Origin${RESET}  ${DIM}($XP_DOMAIN)${RESET}"
    else
        echo -e "  ${BOLD}SSL cert${RESET}      : ${RED}not issued${RESET}  ${DIM}(step d)${RESET}"
    fi

    [[ -f "$XP_HTPASSWD" ]] \
        && echo -e "  ${BOLD}Basic Auth${RESET}    : ${GREEN}configured${RESET}  ${DIM}(user: ${XP_AUTH_USER:-grin})${RESET}" \
        || echo -e "  ${BOLD}Basic Auth${RESET}    : ${RED}not configured${RESET}  ${DIM}(step e)${RESET}"

    if [[ -L "$XP_NGINX_LINK" ]]; then
        echo -e "  ${BOLD}Web UI${RESET}        : ${GREEN}LIVE${RESET}  ${DIM}→ https://${XP_DOMAIN:-<domain>}${RESET}"
    else
        echo -e "  ${BOLD}Web UI${RESET}        : ${RED}not live${RESET}  ${DIM}(complete steps c–e)${RESET}"
    fi

    local wallet_session="grin_wallet_mainnet"
    if tmux has-session -t "$wallet_session" 2>/dev/null; then
        echo -e "  ${BOLD}Wallet listener${RESET}: ${GREEN}running${RESET}  ${DIM}(tmux: $wallet_session)${RESET}"
    else
        echo -e "  ${BOLD}Wallet listener${RESET}: ${RED}not running${RESET}  ${YELLOW}⚠ start via script 05 option c${RESET}"
    fi

    echo ""
    [[ -n "$XP_DOMAIN" ]] && echo -e "  URL: ${BOLD}${GREEN}https://$XP_DOMAIN${RESET}"
    echo -e "  Network     : MAINNET  (wallet API port $XP_WALLET_API_PORT)"
    echo -e "  Deploy dir  : $XP_DEPLOY_DIR"
    echo -e "  Config dir  : $XP_CONF_DIR"
    echo ""
    pause
}

# =============================================================================
# STEP j — Edit saved settings
# =============================================================================

xp_edit_settings() {
    xp_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Grin XP Wallet [MAINNET] — j) Edit Saved Settings ──${RESET}\n"
    echo -e "  ${DIM}Press Enter to keep the current value.${RESET}"
    echo ""

    echo -ne "Domain           [${XP_DOMAIN:-}]: "
    read -r v || true; [[ -n "$v" ]] && XP_DOMAIN="$v"

    echo -ne "PHP-FPM socket   [${XP_PHP_FPM_SOCK:-}]: "
    read -r v || true; [[ -n "$v" ]] && XP_PHP_FPM_SOCK="$v"

    echo -ne "Auth username    [${XP_AUTH_USER:-grin}]: "
    read -r v || true; [[ -n "$v" ]] && XP_AUTH_USER="$v"

    echo -ne "Let's Encrypt email [${XP_EMAIL:-}]: "
    read -r v || true; [[ -n "$v" ]] && XP_EMAIL="$v"

    xp_save_config
    success "Settings saved to $XP_CONF_FILE"
    pause
}

# =============================================================================
# XP MENU
# =============================================================================

xp_menu() {
    while true; do
        clear
        echo -e "${BOLD}${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${YELLOW} 051x) GRIN XP WALLET  [MAINNET]${RESET}"
        echo -e "${BOLD}${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "  ${DIM}⚡ Experimental — WinXP nostalgia shell, mainnet only${RESET}"
        xp_menu_status

        echo -e "${DIM}  ─── First-time setup (run in order) ─────────────${RESET}"
        echo -e "  ${GREEN}a${RESET}) Install dependencies    ${DIM}(nginx, php, certbot, htpasswd, qrencode)${RESET}"
        echo -e "  ${GREEN}b${RESET}) Deploy web files        ${DIM}(web/051_xp_wallet/ → $XP_DEPLOY_DIR)${RESET}"
        echo -e "  ${GREEN}c${RESET}) Configure nginx         ${DIM}(HTTP vhost — step d adds HTTPS)${RESET}"
        echo -e "  ${GREEN}d${RESET}) Setup SSL               ${DIM}(Let's Encrypt or Cloudflare Origin Cert)${RESET}"
        echo -e "  ${GREEN}e${RESET}) Setup Basic Auth        ${DIM}(set / change password)${RESET}"
        echo -e "  ${GREEN}f${RESET}) Configure firewall      ${DIM}(open ports 80 and 443)${RESET}"
        echo ""
        echo -e "${DIM}  ─── Info ─────────────────────────────────────────${RESET}"
        echo -e "  ${CYAN}i${RESET}) Status & info"
        echo -e "  ${CYAN}j${RESET}) Edit saved settings     ${DIM}(domain, email, auth user)${RESET}"
        echo ""
        echo -e "  ${DIM}↩  Press Enter to refresh${RESET}"
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [a-f / i / j / 0]: ${RESET}"
        read -r choice || true

        case "$choice" in
            a) xp_install_deps       || true ;;
            b) xp_deploy_files       || true ;;
            c) xp_configure_nginx    || true ;;
            d) xp_setup_ssl          || true ;;
            e) xp_setup_auth         || true ;;
            f) xp_configure_firewall || true ;;
            i) xp_show_info          || true ;;
            j) xp_edit_settings      || true ;;
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
    clear
    echo -e "${BOLD}${RED}╔══════════════════════════════════════════════════════════╗${RESET}"
    echo -e "${BOLD}${RED}║  ⚡  GRIN XP WALLET  —  FOR FUN & NOSTALGIA ONLY  ⚡    ║${RESET}"
    echo -e "${BOLD}${RED}║                                                          ║${RESET}"
    echo -e "${BOLD}${RED}║  Deploys real MAINNET wallet inside a WinXP simulator.  ║${RESET}"
    echo -e "${BOLD}${RED}║  Real GRIN. The WinXP theme is purely cosmetic.         ║${RESET}"
    echo -e "${BOLD}${RED}╚══════════════════════════════════════════════════════════╝${RESET}"
    echo ""
    echo -ne "${BOLD}Press Enter to continue, or 0 to cancel: ${RESET}"
    read -r _ack || true
    [[ "$_ack" == "0" ]] && exit 0
    xp_menu
}

main "$@"
