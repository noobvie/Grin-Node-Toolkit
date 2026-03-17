#!/bin/bash
# =============================================================================
# 084_nginx_extended_features.sh — Nginx Extended Features
# Part of: Grin Node Toolkit  (called from 08_grin_node_admin.sh → option 4)
# =============================================================================
#
# PURPOSE
#   Central hub for nginx management tasks beyond basic file serving.
#   Consolidates audit, reverse proxy, security hardening, and log rotation
#   into one sub-script, following the 08x companion-script pattern.
#
# MENU OPTIONS
#   1) Config & SSL Audit       — nginx -t, cert expiry, enabled/disabled check
#   2) Reverse Proxy Manager    — add · remove · list reverse proxy vhosts
#   3) Enhance Security         — harden SSL settings and HTTP security headers
#   4) Log Rotation Setup       — configure logrotate (10 MB or 10 days, whichever first)
#   0) Return to admin menu
#
# GRIN RESERVED NAMES (protected — cannot be used as reverse proxy domains)
#   Subdomain prefixes : fullmain  prunemain  prunetest
#   Web roots          : /var/www/fullmain  /var/www/prunemain  /var/www/prunetest
#   These are owned by 02_nginx_fileserver_manager.sh.
#
# REVERSE PROXY FEATURES
#   • HTTP upstream support  (e.g. http://127.0.0.1:3000)
#   • WebSocket support      (Upgrade / Connection headers)
#   • Standard proxy headers (X-Real-IP, X-Forwarded-For, X-Forwarded-Proto, Host)
#   • Let's Encrypt SSL via certbot  (same flow as script 02)
#   • HTTPS redirect + HSTS
#
# PREREQUISITES
#   • Must be run as root  (invoked from 08_grin_node_admin.sh which checks root)
#   • nginx, certbot  (auto-installed if missing when needed)
#   • logrotate  (standard on all supported distros)
#
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="/opt/grin/logs"
LOG_FILE="$LOG_DIR/084_nginx_extended_$(date +%Y%m%d_%H%M%S).log"
mkdir -p "$LOG_DIR"

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

# ─── Logging helpers ──────────────────────────────────────────────────────────
log()     { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; log "[INFO]  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; log "[OK]    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; log "[WARN]  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; log "[ERROR] $*"; }
die()     { error "$*"; exit 1; }
pause()   { echo ""; echo "Press Enter to continue..."; read -r; }

# ─── Reserved Grin names (owned by script 02) ─────────────────────────────────
RESERVED_PREFIXES=("fullmain" "prunemain" "prunetest")

_assert_not_reserved() {
    local domain="$1"
    local first_label="${domain%%.*}"
    for r in "${RESERVED_PREFIXES[@]}"; do
        if [[ "$first_label" == "$r" ]]; then
            die "Domain '$domain' uses reserved prefix '$r' — owned by script 02 (nginx fileserver). Choose a different subdomain."
        fi
    done
}

# =============================================================================
# Shared nginx/certbot helpers
# =============================================================================
_check_nginx() {
    command -v nginx &>/dev/null
}

_install_nginx() {
    info "Installing nginx..."
    if command -v dnf &>/dev/null; then
        dnf install -y nginx || die "Failed to install nginx."
    else
        apt-get update -qq && apt-get install -y nginx || die "Failed to install nginx."
    fi
    systemctl enable nginx
    systemctl start nginx
    success "nginx installed."
}

_check_certbot() {
    command -v certbot &>/dev/null
}

_install_certbot() {
    info "Installing certbot..."
    if command -v dnf &>/dev/null; then
        dnf install -y certbot python3-certbot-nginx || die "Failed to install certbot."
    else
        apt-get update -qq && apt-get install -y certbot python3-certbot-nginx || die "Failed to install certbot."
    fi
    success "certbot installed."
}

_nginx_reload() {
    nginx -t 2>&1 || die "nginx config test failed — review errors above."
    systemctl reload nginx
    success "nginx reloaded."
}

_setup_certbot_renewal() {
    # Add certbot renew cron if not already present
    if ! crontab -l 2>/dev/null | grep -q "certbot renew"; then
        ( crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet --post-hook 'systemctl reload nginx'" ) | crontab -
        success "Certbot auto-renewal cron added (daily at 03:00)."
    else
        info "Certbot auto-renewal cron already present."
    fi
}

# =============================================================================
# 1 — Config & SSL Audit  (moved from 08_grin_node_admin.sh show_nginx_audit)
# =============================================================================
show_nginx_audit() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  1  Config & SSL Audit${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    if ! _check_nginx; then
        warn "nginx not installed. Skipping."
        pause; return
    fi

    # ── Config test ──────────────────────────────────────────────────────────
    echo -e "${BOLD}nginx configuration test:${RESET}"
    if nginx -t 2>&1 | grep -q "test is successful"; then
        success "nginx -t passed — configuration is valid."
    else
        echo ""
        nginx -t 2>&1 | while IFS= read -r line; do
            echo -e "  ${RED}▶${RESET} $line"
        done
        echo ""
        warn "nginx configuration has errors. Review before proceeding."
    fi

    # ── All nginx configs (Grin + proxy) ─────────────────────────────────────
    echo ""
    echo -e "${BOLD}nginx config files (sites-available):${RESET}"
    local -a all_confs=()
    while IFS= read -r conf; do
        all_confs+=("$conf")
    done < <(find /etc/nginx/sites-available -maxdepth 1 -type f 2>/dev/null | sort || true)

    if [[ ${#all_confs[@]} -eq 0 ]]; then
        echo -e "  ${DIM}No nginx configs found in sites-available.${RESET}"
    else
        printf "  ${BOLD}%-42s %-10s %-10s %s${RESET}\n" "Config" "Enabled" "Type" "Domain / Target"
        printf "  %-42s %-10s %-10s %s\n" \
            "──────────────────────────────────────────" "──────────" "──────────" "─────────────────────"
        for conf in "${all_confs[@]}"; do
            local name enabled_str type_str detail
            name="$(basename "$conf")"
            local symlink="/etc/nginx/sites-enabled/$name"
            if [[ -L "$symlink" ]]; then
                enabled_str="${GREEN}yes${RESET}      "
            else
                enabled_str="${RED}no${RESET}       "
            fi

            if grep -q "proxy_pass" "$conf" 2>/dev/null; then
                type_str="proxy    "
                detail=$(grep -oP '(?<=proxy_pass\s)http[^;]+' "$conf" 2>/dev/null | head -1 || echo "-")
            else
                type_str="filesvr  "
                detail=$(grep -oP '(?<=root\s)[^;]+' "$conf" 2>/dev/null | head -1 | xargs || echo "-")
            fi

            printf "  %-42s " "$name"
            echo -ne "$enabled_str "
            printf "%-10s %s\n" "$type_str" "$detail"
        done
    fi

    # ── SSL certificate expiry ────────────────────────────────────────────────
    echo ""
    echo -e "${BOLD}SSL Certificate Expiry:${RESET}"

    if ! command -v openssl &>/dev/null; then
        warn "openssl not found — cannot check certificate expiry."
    else
        local found_ssl=false
        for conf in "${all_confs[@]}"; do
            local domain
            domain=$(grep -oP '(?<=server_name\s)[^\s;]+' "$conf" 2>/dev/null | head -1 || true)
            [[ -z "$domain" || "$domain" == "_" ]] && continue

            local cert_info expiry_date days_left
            cert_info=$(echo "" | timeout 5 openssl s_client \
                -connect "$domain:443" -servername "$domain" 2>/dev/null \
                | openssl x509 -noout -enddate 2>/dev/null || true)

            if [[ -z "$cert_info" ]]; then
                echo -e "  ${DIM}▶ $domain — could not connect or no SSL${RESET}"
                continue
            fi

            found_ssl=true
            expiry_date=$(echo "$cert_info" | grep -oP '(?<=notAfter=).*' || echo "unknown")
            days_left=$(( ( $(date -d "$expiry_date" +%s 2>/dev/null || echo 0) - $(date +%s) ) / 86400 ))

            if [[ $days_left -le 0 ]]; then
                echo -e "  ${RED}▶${RESET} $domain — ${RED}EXPIRED${RESET} ($expiry_date)"
            elif [[ $days_left -le 14 ]]; then
                echo -e "  ${RED}▶${RESET} $domain — expires in ${RED}$days_left days${RESET} ($expiry_date)"
            elif [[ $days_left -le 30 ]]; then
                echo -e "  ${YELLOW}▶${RESET} $domain — expires in ${YELLOW}$days_left days${RESET} ($expiry_date)"
            else
                echo -e "  ${GREEN}▶${RESET} $domain — expires in ${GREEN}$days_left days${RESET} ($expiry_date)"
            fi
            log "[audit] SSL $domain — $days_left days left"
        done
        $found_ssl || echo -e "  ${DIM}No SSL-enabled domains found.${RESET}"
    fi

    pause
}

# =============================================================================
# 2 — Reverse Proxy Manager
# =============================================================================

# ── Add reverse proxy ─────────────────────────────────────────────────────────
_proxy_add() {
    echo ""
    echo -e "${BOLD}Add Reverse Proxy${RESET}"
    echo ""

    if ! _check_nginx; then
        warn "nginx is not installed."
        echo -ne "Install nginx now? [Y/n]: "; read -r _yn
        [[ "${_yn,,}" == "n" ]] && return
        _install_nginx
    fi

    if ! _check_certbot; then
        warn "certbot is not installed."
        echo -ne "Install certbot now? [Y/n]: "; read -r _yn
        [[ "${_yn,,}" == "n" ]] && return
        _install_certbot
    fi

    # Collect inputs
    local domain=""
    while true; do
        echo -ne "  Domain (e.g. app.example.com): "; read -r domain
        [[ -z "$domain" ]] && { warn "Domain cannot be empty."; continue; }
        # Basic format check
        if [[ ! "$domain" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$ ]]; then
            warn "Invalid domain format."; continue
        fi
        _assert_not_reserved "$domain"   # exits if reserved
        break
    done

    local email=""
    while true; do
        echo -ne "  Email for Let's Encrypt: "; read -r email
        [[ "$email" =~ ^[^@]+@[^@]+\.[^@]+$ ]] && break
        warn "Invalid email format."
    done

    local upstream=""
    while true; do
        echo -ne "  Upstream URL (e.g. http://127.0.0.1:3000): "; read -r upstream
        [[ -z "$upstream" ]] && { warn "Upstream URL cannot be empty."; continue; }
        [[ "$upstream" =~ ^https?:// ]] && break
        warn "Upstream must start with http:// or https://"
    done

    echo ""
    echo -e "  ${BOLD}Summary:${RESET}"
    echo -e "    Domain   : $domain"
    echo -e "    Email    : $email"
    echo -e "    Upstream : $upstream"
    echo ""
    echo -ne "Proceed? [Y/n]: "; read -r _confirm
    [[ "${_confirm,,}" == "n" ]] && { info "Cancelled."; return; }

    local conf_file="/etc/nginx/sites-available/$domain"
    local conf_link="/etc/nginx/sites-enabled/$domain"

    # ── Step 1: initial HTTP vhost ────────────────────────────────────────────
    info "Creating initial HTTP vhost..."
    cat > "$conf_file" <<NGINXEOF
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    location / {
        proxy_pass ${upstream};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout    60s;
        proxy_read_timeout    60s;
    }

    access_log /var/log/nginx/${domain}-access.log;
    error_log  /var/log/nginx/${domain}-error.log;
}
NGINXEOF

    ln -sf "$conf_file" "$conf_link"
    _nginx_reload

    # ── Step 2: obtain SSL certificate ───────────────────────────────────────
    info "Obtaining Let's Encrypt certificate for $domain..."
    certbot --nginx -d "$domain" --non-interactive --agree-tos -m "$email" \
        || die "certbot failed — check DNS is pointing to this server and port 80 is open."
    success "SSL certificate obtained."

    # ── Step 3: rewrite vhost with full HTTPS config ──────────────────────────
    info "Writing enhanced HTTPS vhost..."
    cat > "$conf_file" <<NGINXEOF
# HTTP — redirect to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};
    return 301 https://\$server_name\$request_uri;
}

# HTTPS — reverse proxy
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${domain};

    ssl_certificate     /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location / {
        proxy_pass ${upstream};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout    60s;
        proxy_read_timeout    60s;
    }

    access_log /var/log/nginx/${domain}-access.log;
    error_log  /var/log/nginx/${domain}-error.log;
}
NGINXEOF

    _nginx_reload
    _setup_certbot_renewal

    log "[proxy_add] domain=$domain upstream=$upstream"
    echo ""
    success "Reverse proxy live: https://$domain → $upstream"
    pause
}

# ── Remove reverse proxy ──────────────────────────────────────────────────────
_proxy_remove() {
    echo ""
    echo -e "${BOLD}Remove Reverse Proxy${RESET}"
    echo ""

    # List proxy configs
    local -a proxy_files=()
    while IFS= read -r f; do
        grep -q "proxy_pass" "$f" 2>/dev/null && proxy_files+=("$f")
    done < <(find /etc/nginx/sites-available -maxdepth 1 -type f 2>/dev/null | sort || true)

    if [[ ${#proxy_files[@]} -eq 0 ]]; then
        info "No reverse proxy configs found."
        pause; return
    fi

    echo -e "  ${BOLD}Configured reverse proxies:${RESET}"
    local i=1
    for f in "${proxy_files[@]}"; do
        local dom; dom="$(basename "$f")"
        local upstream; upstream=$(grep -oP '(?<=proxy_pass\s)http[^;]+' "$f" 2>/dev/null | head -1 || echo "-")
        local enabled_str
        [[ -L "/etc/nginx/sites-enabled/$dom" ]] && enabled_str="${GREEN}enabled${RESET}" || enabled_str="${RED}disabled${RESET}"
        echo -e "  $i) $dom  ${DIM}→ $upstream${RESET}  ($enabled_str)"
        (( i++ ))
    done

    echo ""
    echo -ne "  Select number to remove (0 to cancel): "; read -r _sel
    [[ "$_sel" == "0" || -z "$_sel" ]] && return
    if ! [[ "$_sel" =~ ^[0-9]+$ ]] || (( _sel < 1 || _sel > ${#proxy_files[@]} )); then
        warn "Invalid selection."; pause; return
    fi

    local target="${proxy_files[$(( _sel - 1 ))]}"
    local target_dom; target_dom="$(basename "$target")"
    echo ""
    echo -ne "  ${RED}Remove '$target_dom' and its nginx config? [y/N]: ${RESET}"; read -r _confirm
    [[ "${_confirm,,}" != "y" ]] && { info "Cancelled."; return; }

    # Remove symlink and config
    rm -f "/etc/nginx/sites-enabled/$target_dom"
    rm -f "$target"
    _nginx_reload
    log "[proxy_remove] domain=$target_dom"
    success "Removed: $target_dom"

    # Offer to delete Let's Encrypt cert
    if [[ -d "/etc/letsencrypt/live/$target_dom" ]]; then
        echo -ne "  Also delete Let's Encrypt certificate for '$target_dom'? [y/N]: "; read -r _cert
        if [[ "${_cert,,}" == "y" ]]; then
            certbot delete --cert-name "$target_dom" --non-interactive 2>/dev/null \
                && success "Certificate deleted." \
                || warn "Could not delete certificate — remove manually with: certbot delete --cert-name $target_dom"
        fi
    fi
    pause
}

# ── List proxy configs ────────────────────────────────────────────────────────
_proxy_list() {
    echo ""
    echo -e "${BOLD}Configured Reverse Proxies:${RESET}"
    echo ""

    local found=0
    printf "  ${BOLD}%-35s %-10s %s${RESET}\n" "Domain" "Status" "Upstream"
    printf "  %-35s %-10s %s\n" "─────────────────────────────────" "──────────" "────────────────────────"

    for f in $(find /etc/nginx/sites-available -maxdepth 1 -type f 2>/dev/null | sort); do
        grep -q "proxy_pass" "$f" 2>/dev/null || continue
        local dom; dom="$(basename "$f")"
        local upstream; upstream=$(grep -oP '(?<=proxy_pass\s)http[^;]+' "$f" 2>/dev/null | head -1 || echo "-")
        local status
        [[ -L "/etc/nginx/sites-enabled/$dom" ]] \
            && status="${GREEN}enabled${RESET} " \
            || status="${RED}disabled${RESET}"
        printf "  %-35s " "$dom"
        echo -ne "$status "
        echo "$upstream"
        (( found++ ))
    done

    [[ $found -eq 0 ]] && echo -e "  ${DIM}No reverse proxy configs found.${RESET}"
    echo ""
    pause
}

# ── Reverse proxy sub-menu ────────────────────────────────────────────────────
menu_reverse_proxy() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  2  Reverse Proxy Manager${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  ${GREEN}A${RESET}) Add Reverse Proxy"
        echo -e "  ${RED}R${RESET}) Remove Reverse Proxy"
        echo -e "  ${CYAN}L${RESET}) List Proxy Configs"
        echo -e "  ${DIM}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Choose [A/R/L/0]: ${RESET}"
        read -r _proxy_choice
        case "${_proxy_choice,,}" in
            a) _proxy_add    ;;
            r) _proxy_remove ;;
            l) _proxy_list   ;;
            0) break         ;;
            *) warn "Invalid option — choose A, R, L, or 0."; sleep 1 ;;
        esac
    done
}

# =============================================================================
# 3 — Enhance Security
# =============================================================================
enhance_security() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  3  Enhance Security${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    if ! _check_nginx; then
        warn "nginx not installed — nothing to harden."
        pause; return
    fi

    local nginx_conf="/etc/nginx/nginx.conf"
    local sec_snippet="/etc/nginx/conf.d/security-headers.conf"

    # ── 1. server_tokens off ──────────────────────────────────────────────────
    info "Disabling server version disclosure (server_tokens off)..."
    if grep -q "server_tokens" "$nginx_conf" 2>/dev/null; then
        sed -i 's/^\s*server_tokens\s.*/    server_tokens off;/' "$nginx_conf"
    else
        # Insert inside the http {} block
        sed -i '/http\s*{/a\    server_tokens off;' "$nginx_conf"
    fi
    success "server_tokens off set."

    # ── 2. Modern TLS only ────────────────────────────────────────────────────
    info "Enforcing TLS 1.2/1.3 and modern cipher suite..."
    if grep -q "ssl_protocols" "$nginx_conf" 2>/dev/null; then
        sed -i 's/^\s*ssl_protocols\s.*/    ssl_protocols TLSv1.2 TLSv1.3;/' "$nginx_conf"
    else
        sed -i '/http\s*{/a\    ssl_protocols TLSv1.2 TLSv1.3;' "$nginx_conf"
    fi
    if grep -q "ssl_ciphers" "$nginx_conf" 2>/dev/null; then
        sed -i "s|^\s*ssl_ciphers\s.*|    ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384';|" "$nginx_conf"
    else
        sed -i "/ssl_protocols/a\\    ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384';" "$nginx_conf"
    fi
    success "TLS settings updated."

    # ── 3. Global security headers snippet ───────────────────────────────────
    info "Writing global security headers to $sec_snippet..."
    cat > "$sec_snippet" <<'SNIPEOF'
# Global security headers — managed by 084_nginx_extended_features.sh
# Applied to all virtual hosts. Per-vhost headers take precedence.
add_header X-Frame-Options        "SAMEORIGIN"                        always;
add_header X-Content-Type-Options "nosniff"                           always;
add_header X-XSS-Protection       "1; mode=block"                     always;
add_header Referrer-Policy        "strict-origin-when-cross-origin"   always;
SNIPEOF
    success "Security headers snippet written."

    # ── 4. Test & reload ──────────────────────────────────────────────────────
    _nginx_reload
    log "[enhance_security] server_tokens, TLS, security-headers applied"
    echo ""
    success "Security hardening complete."
    pause
}

# =============================================================================
# 4 — Log Rotation Setup
# =============================================================================
setup_log_rotation() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  4  Log Rotation Setup${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Policy: rotate when a log reaches ${BOLD}10 MB${RESET} or is ${BOLD}10 days${RESET} old, whichever comes first."
    echo -e "  Rotated files are compressed; files older than 10 days are deleted."
    echo ""

    local rotate_conf="/etc/logrotate.d/nginx-grin"

    if [[ -f "$rotate_conf" ]]; then
        warn "A logrotate config already exists at $rotate_conf"
        echo -ne "  Overwrite with new policy? [Y/n]: "; read -r _ow
        [[ "${_ow,,}" == "n" ]] && { info "Cancelled — existing config unchanged."; pause; return; }
    fi

    info "Writing logrotate config to $rotate_conf..."
    cat > "$rotate_conf" <<'ROTEOF'
/var/log/nginx/*.log {
    daily
    size 10M
    rotate 10
    maxage 10
    compress
    delaycompress
    missingok
    notifempty
    sharedscripts
    postrotate
        [ -f /var/run/nginx.pid ] && kill -USR1 $(cat /var/run/nginx.pid)
    endscript
}
ROTEOF

    success "Logrotate config written."

    # Dry-run to verify syntax
    info "Running logrotate dry-run to verify config..."
    echo ""
    if logrotate -d "$rotate_conf" 2>&1 | grep -v "^$"; then
        echo ""
        success "logrotate dry-run passed — config is valid."
    else
        warn "logrotate dry-run produced no output — verify manually with: logrotate -d $rotate_conf"
    fi

    log "[log_rotation] config written to $rotate_conf (10MB or 10 days)"
    pause
}

# =============================================================================
# Main menu
# =============================================================================
show_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 084  Nginx Extended Features${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  ${GREEN}1${RESET})  Config & SSL Audit       ${DIM}nginx -t, cert expiry, enabled/disabled check${RESET}"
    echo -e "  ${CYAN}2${RESET})  Reverse Proxy Manager    ${DIM}add · remove · list reverse proxy vhosts${RESET}"
    echo -e "  ${YELLOW}3${RESET})  Enhance Security         ${DIM}harden SSL settings and HTTP security headers${RESET}"
    echo -e "  ${YELLOW}4${RESET})  Log Rotation Setup       ${DIM}configure logrotate (10 MB or 10 days)${RESET}"
    echo ""
    echo -e "  ${DIM}0${RESET})  Return to admin menu"
    echo ""
    echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -ne "${BOLD}Select [0-4]: ${RESET}"
}

main() {
    while true; do
        show_menu
        read -r choice
        case "${choice}" in
            1) show_nginx_audit    ;;
            2) menu_reverse_proxy  ;;
            3) enhance_security    ;;
            4) setup_log_rotation  ;;
            0) break               ;;
            *) warn "Invalid option — choose 1-4 or 0."; sleep 1 ;;
        esac
    done
}

main "$@"
