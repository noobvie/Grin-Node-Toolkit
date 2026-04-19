# 052_lib_nginx.sh — Grin Drop nginx configuration
# Sourced by 052_grin_drop.sh — inherits all color/log/network variables.
# =============================================================================
#
#  Functions exported:
#    drop_create_domain   — option 1 (top-level): unified domain + nginx submenu
#    drop_remove_domain   — option 5 (top-level): remove domain + nginx config
#
#  Internal helpers:
#    _drop_write_unified_conf   — write unified nginx vhost (one domain, both networks)
#    _drop_nginx_ensure_installed
#    _drop_nginx_letsencrypt
#    _drop_nginx_cloudflare
#    _drop_nginx_logrotate
#

# =============================================================================
# OPTION 1 (top-level) — Create / Update Domain & nginx
# =============================================================================

drop_create_domain() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN} 052) GRIN DROP — 1) Domain & nginx${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""

        local cur_dom; cur_dom=$(_shared_read "subdomain" "")
        local cur_name; cur_name=$(_shared_read "drop_name" "Grin Drop")
        local cur_ssl; cur_ssl=$(_shared_read "ssl_type" "")
        local nginx_conf=""
        [[ -n "$cur_dom" ]] && nginx_conf="/etc/nginx/sites-available/$cur_dom"

        echo -e "  ${BOLD}Current status:${RESET}"
        if [[ -n "$cur_dom" ]]; then
            echo -e "  Site name  : ${GREEN}$cur_name${RESET}"
            echo -e "  Domain     : ${GREEN}$cur_dom${RESET}"
            if [[ -n "$nginx_conf" && -f "$nginx_conf" ]]; then
                echo -e "  Nginx conf : ${GREEN}$nginx_conf${RESET}  ${DIM}(exists)${RESET}"
            else
                echo -e "  Nginx conf : ${YELLOW}$nginx_conf${RESET}  ${DIM}(not yet created)${RESET}"
            fi
            [[ -n "$cur_ssl" ]] \
                && echo -e "  SSL type   : ${GREEN}$cur_ssl${RESET}" \
                || echo -e "  SSL type   : ${DIM}not configured${RESET}"
        else
            echo -e "  ${YELLOW}No domain configured yet.${RESET}"
        fi
        echo ""

        echo -e "${DIM}  ─── Options ──────────────────────────────────────${RESET}"
        echo -e "  ${GREEN}1${RESET}) Set / Update site name & domain"
        echo -e "  ${GREEN}2${RESET}) Renew / Re-run SSL only"
        echo -e "  ${GREEN}3${RESET}) Re-apply nginx config  ${DIM}(rewrite vhost without changing domain)${RESET}"
        echo ""
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1/2/3/0]: ${RESET}"
        local choice; read -r choice || true

        case "$choice" in
            1) _drop_set_domain ;;
            2) _drop_renew_ssl ;;
            3) _drop_reapply_nginx ;;
            0) break ;;
            "") continue ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

_drop_set_domain() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop — Set / Update Site Name & Domain ──${RESET}\n"
    echo -e "  ${DIM}One domain serves both networks:${RESET}"
    echo -e "  ${DIM}  https://<domain>/testnet/  →  testnet portal (port 3004)${RESET}"
    echo -e "  ${DIM}  https://<domain>/mainnet/  →  mainnet portal (port 3005)${RESET}"
    echo -e "  ${DIM}  https://<domain>/          →  unified homepage${RESET}"
    echo -e "  ${DIM}Type 0 to cancel.${RESET}"
    echo ""

    local cur_name; cur_name=$(_shared_read "drop_name" "Grin Drop")
    echo -ne "Site name  [${cur_name}]: "
    local val; read -r val || true
    [[ "$val" == "0" ]] && { info "Cancelled."; return; }
    local new_name="${val:-$cur_name}"

    local cur_dom; cur_dom=$(_shared_read "subdomain" "")
    local new_dom=""
    while true; do
        echo -ne "Domain     [${cur_dom:-e.g. drop.example.com}]: "
        read -r val || true
        [[ "$val" == "0" ]] && { info "Cancelled."; return; }
        new_dom="${val:-$cur_dom}"
        [[ -z "$new_dom" ]] && { warn "Domain cannot be empty."; continue; }
        # Validate: hostname characters only
        if [[ ! "$new_dom" =~ ^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$ ]]; then
            warn "Invalid domain — use only letters, numbers, hyphens, underscores, and dots."
            continue
        fi
        # Validate: reserved prefixes (script 02)
        local _prefix="${new_dom%%.*}"
        if [[ "$_prefix" == "fullmain" || "$_prefix" == "prunemain" || "$_prefix" == "prunetest" ]]; then
            warn "Domain prefix '$_prefix' is reserved by script 02 (Grin chain data server). Choose a different domain."
            continue
        fi
        break
    done

    _shared_write "drop_name" "$new_name"
    _shared_write "subdomain" "$new_dom"
    success "Saved: site='$new_name'  domain='$new_dom'"
    echo ""

    _drop_reapply_nginx
}

_drop_renew_ssl() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop — Renew / Re-run SSL ──${RESET}\n"

    local domain; domain=$(_shared_read "subdomain" "")
    if [[ -z "$domain" ]]; then
        warn "No domain configured — run option 1 → 1 first."; pause; return
    fi
    info "Domain: $domain"

    local ssl_type; ssl_type=$(_shared_read "ssl_type" "")
    local nginx_conf="/etc/nginx/sites-available/$domain"

    if [[ "$ssl_type" == "letsencrypt" ]]; then
        info "Re-issuing Let's Encrypt certificate for $domain ..."
        certbot certonly --nginx -d "$domain" --non-interactive \
            && success "Certificate renewed." \
            || { warn "certbot failed — check DNS and port 80."; pause; return; }
        nginx -t && systemctl reload nginx && success "nginx reloaded."
    elif [[ "$ssl_type" == "cloudflare" ]]; then
        _drop_nginx_cloudflare "$domain" || { pause; return; }
        local cf_dir="/etc/ssl/cloudflare-origin"
        local ssl_cert="$cf_dir/$domain.pem"
        local ssl_key="$cf_dir/$domain.key"
        local ssl_params="ssl_protocols TLSv1.2 TLSv1.3;\n    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;\n    ssl_prefer_server_ciphers off;\n    ssl_session_cache shared:SSL:10m;\n    ssl_session_timeout 1d;"
        _drop_write_unified_conf "$domain" "$ssl_cert" "$ssl_key" "$ssl_params" "$nginx_conf"
        nginx -t && systemctl reload nginx && success "nginx reloaded with updated cert."
    else
        warn "No SSL type saved — run option 1 → 3 (Re-apply nginx config) to configure SSL."
    fi
    pause
}

_drop_reapply_nginx() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop — Re-apply nginx config ──${RESET}\n"

    _drop_nginx_ensure_installed || { pause; return; }

    local domain; domain=$(_shared_read "subdomain" "")
    if [[ -z "$domain" ]]; then
        warn "No domain configured — run option 1 → 1 first."; pause; return
    fi
    info "Domain: $domain"
    echo ""

    local nginx_conf="/etc/nginx/sites-available/$domain"
    local nginx_link="/etc/nginx/sites-enabled/$domain"

    echo -e "  ${BOLD}SSL Certificate:${RESET}"
    echo -e "  ${GREEN}1${RESET}) Let's Encrypt  ${DIM}(set DNS-only in Cloudflare if issuance fails)${RESET}"
    echo -e "  ${GREEN}2${RESET}) Cloudflare Origin Certificate  ${DIM}(domain can stay Proxied)${RESET}"
    echo -ne "  Choice [1/2/0 to cancel]: "
    local ssl_choice; read -r ssl_choice || true
    [[ "$ssl_choice" == "0" ]] && return
    [[ "$ssl_choice" != "2" ]] && ssl_choice="1"
    echo ""

    local ssl_cert ssl_key ssl_params="" ssl_type_label
    if [[ "$ssl_choice" == "1" ]]; then
        _drop_nginx_letsencrypt "$domain" "$nginx_conf" "$nginx_link" || { pause; return; }
        ssl_cert="/etc/letsencrypt/live/$domain/fullchain.pem"
        ssl_key="/etc/letsencrypt/live/$domain/privkey.pem"
        ssl_params="include /etc/letsencrypt/options-ssl-nginx.conf;\n    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"
        ssl_type_label="letsencrypt"
    else
        _drop_nginx_cloudflare "$domain" || { pause; return; }
        local cf_dir="/etc/ssl/cloudflare-origin"
        ssl_cert="$cf_dir/$domain.pem"
        ssl_key="$cf_dir/$domain.key"
        ssl_params="ssl_protocols TLSv1.2 TLSv1.3;\n    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;\n    ssl_prefer_server_ciphers off;\n    ssl_session_cache shared:SSL:10m;\n    ssl_session_timeout 1d;"
        ssl_type_label="cloudflare"
    fi

    _drop_write_unified_conf "$domain" "$ssl_cert" "$ssl_key" "$ssl_params" "$nginx_conf"
    ln -sf "$nginx_conf" "$nginx_link" 2>/dev/null || true
    nginx -t && systemctl reload nginx && success "nginx config loaded." \
        || { warn "nginx test failed — check $nginx_conf"; pause; return; }

    _shared_write "ssl_type" "$ssl_type_label"
    _drop_nginx_logrotate "$domain"

    echo ""
    info "Unified homepage : https://$domain/"
    info "Testnet portal   : https://$domain/testnet/"
    info "Mainnet portal   : https://$domain/mainnet/"
    log "[drop_create_domain] domain=$domain ssl=$ssl_type_label"
    pause
}

# =============================================================================
# OPTION 5 (top-level) — Remove Current Domain
# =============================================================================

drop_remove_domain() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop — 5) Remove Current Domain ──${RESET}\n"

    local domain; domain=$(_shared_read "subdomain" "")
    if [[ -z "$domain" ]]; then
        warn "No domain configured."; pause; return
    fi

    local nginx_conf="/etc/nginx/sites-available/$domain"
    local nginx_link="/etc/nginx/sites-enabled/$domain"

    echo -e "  ${BOLD}Domain     :${RESET} ${GREEN}$domain${RESET}"
    echo -e "  ${BOLD}Nginx conf :${RESET} $nginx_conf"
    echo -e "  ${BOLD}Nginx link :${RESET} $nginx_link"
    echo ""
    echo -e "  ${RED}This will remove the nginx vhost and clear the stored domain.${RESET}"
    echo -ne "  Type the domain name to confirm: "
    local confirm; read -r confirm || true
    if [[ "$confirm" != "$domain" ]]; then
        info "Domain does not match — cancelled."; pause; return
    fi

    rm -f "$nginx_link" && info "Symlink removed."
    rm -f "$nginx_conf" && info "nginx config removed."

    if command -v nginx &>/dev/null && systemctl is-active --quiet nginx 2>/dev/null; then
        nginx -t 2>/dev/null && systemctl reload nginx && success "nginx reloaded."
    fi

    local ssl_type; ssl_type=$(_shared_read "ssl_type" "")
    if [[ "$ssl_type" == "letsencrypt" ]] && command -v certbot &>/dev/null; then
        echo -ne "  Also delete Let's Encrypt certificate for $domain? [y/N]: "
        local del_ssl; read -r del_ssl || true
        if [[ "${del_ssl,,}" == "y" ]]; then
            certbot delete --cert-name "$domain" --non-interactive 2>/dev/null \
                && success "SSL certificate deleted." \
                || warn "certbot delete failed — certificate may need manual removal."
        fi
    fi

    _shared_write "subdomain" ""
    _shared_write "ssl_type"  ""
    echo ""
    success "Domain $domain removed."
    log "[drop_remove_domain] domain=$domain"
    pause
}

# =============================================================================
# INTERNAL: write unified nginx vhost
# =============================================================================

_drop_write_unified_conf() {
    local domain="$1" ssl_cert="$2" ssl_key="$3" ssl_params="$4" nginx_conf="$5"

    local test_port=3004 main_port=3005
    local home_web_dir="/var/www/grin-drop-home"
    local home_src="$TOOLKIT_ROOT/web/052_drop/home"

    # Deploy unified homepage static files if source exists
    if [[ -d "$home_src" ]]; then
        mkdir -p "$home_web_dir"
        cp -r "$home_src"/. "$home_web_dir/"
        find "$home_web_dir" -type f \( -name "*.html" -o -name "*.css" \) -exec chmod 644 {} \;
        chown -R www-data:www-data "$home_web_dir"
        info "Unified homepage files deployed to $home_web_dir"
    fi

    cat > "$nginx_conf" << NGINX_UNIFIED
# Grin Drop — Unified Domain — generated by 052_grin_drop.sh
# Route: / → homepage  /testnet/ → :${test_port}  /mainnet/ → :${main_port}
limit_req_zone \$binary_remote_addr zone=drop_home:10m   rate=30r/m;
limit_req_zone \$binary_remote_addr zone=drop_api:10m    rate=10r/m;
limit_req_zone \$binary_remote_addr zone=drop_test:10m   rate=5r/m;
limit_req_zone \$binary_remote_addr zone=drop_main:10m   rate=5r/m;

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

    ssl_certificate     $ssl_cert;
    ssl_certificate_key $ssl_key;
    $(echo -e "$ssl_params")

    root  $home_web_dir;
    index index.html;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options    "nosniff"   always;
    add_header X-Frame-Options           "SAMEORIGIN" always;
    add_header Referrer-Policy           "strict-origin" always;
    add_header Content-Security-Policy   "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;" always;

    client_max_body_size 8k;

    access_log /var/log/nginx/grin-drop-${domain}-access.log;
    error_log  /var/log/nginx/grin-drop-${domain}-error.log;

    # ── Unified homepage ─────────────────────────────────────────────────────
    location / {
        limit_req zone=drop_home burst=10 nodelay;
        try_files \$uri \$uri/ =404;
    }

    location ~* \.(css|js|ico|png|svg|woff2?)\$ {
        expires 1h;
        add_header Cache-Control "public";
    }

    # ── Testnet API (:${test_port}) — ^~ beats regex, longer prefix beats /testnet/ ──
    location ^~ /testnet/api/ {
        limit_req zone=drop_test burst=10 nodelay;
        proxy_pass         http://127.0.0.1:${test_port}/api/;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Prefix /testnet;
        proxy_read_timeout 90s;
        add_header X-Robots-Tag "noindex, nofollow" always;
    }

    # ── Testnet portal (:${test_port}) — ^~ prevents CSS/JS regex from intercepting ──
    location ^~ /testnet/ {
        limit_req zone=drop_test burst=5 nodelay;
        proxy_pass         http://127.0.0.1:${test_port}/;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Prefix /testnet;
        proxy_set_header   Accept-Encoding "";
        proxy_read_timeout 90s;
        sub_filter '<head>' '<head><script>window.APP_BASE="/testnet";window.DROP_NETWORK="testnet";</script>';
        sub_filter '__SITE_URL__' 'https://$domain';
        sub_filter_once on;
    }

    # ── Mainnet API (:${main_port}) — ^~ beats regex, longer prefix beats /mainnet/ ──
    location ^~ /mainnet/api/ {
        limit_req zone=drop_main burst=10 nodelay;
        proxy_pass         http://127.0.0.1:${main_port}/api/;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Prefix /mainnet;
        proxy_read_timeout 90s;
        add_header X-Robots-Tag "noindex, nofollow" always;
    }

    # ── Mainnet portal (:${main_port}) — ^~ prevents CSS/JS regex from intercepting ──
    location ^~ /mainnet/ {
        limit_req zone=drop_main burst=5 nodelay;
        proxy_pass         http://127.0.0.1:${main_port}/;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Prefix /mainnet;
        proxy_set_header   Accept-Encoding "";
        proxy_read_timeout 90s;
        sub_filter '<head>' '<head><script>window.APP_BASE="/mainnet";window.DROP_NETWORK="mainnet";</script>';
        sub_filter '__SITE_URL__' 'https://$domain';
        sub_filter_once on;
    }

    location ~ /\.  { deny all; }
    location ~ ~\$  { deny all; }
}
NGINX_UNIFIED

    success "nginx config written: $nginx_conf"
}

# =============================================================================
# Shared nginx helpers
# =============================================================================

_drop_evict_apache2() {
    if systemctl is-active --quiet apache2 2>/dev/null; then
        warn "apache2 is running and occupies port 80 — nginx cannot start."
        echo -ne "  Stop and disable apache2 now? [Y/n]: "
        local yn; read -r yn || true
        if [[ "${yn,,}" != "n" ]]; then
            systemctl stop    apache2 2>/dev/null || true
            systemctl disable apache2 2>/dev/null || true
            success "apache2 stopped and disabled."
        else
            warn "Skipping — nginx may fail to bind port 80/443."
        fi
    elif systemctl is-enabled --quiet apache2 2>/dev/null; then
        warn "apache2 is enabled at boot (not running now) — disabling to avoid port conflict on reboot."
        systemctl disable apache2 2>/dev/null || true
        success "apache2 boot-start disabled."
    fi
}

_drop_nginx_ensure_installed() {
    local need_nginx=false need_certbot=false
    command -v nginx   &>/dev/null || need_nginx=true
    command -v certbot &>/dev/null || need_certbot=true
    local pkg=""
    $need_nginx   && pkg="$pkg nginx"
    $need_certbot && pkg="$pkg certbot python3-certbot-nginx"
    if [[ -n "$pkg" ]]; then
        $need_nginx && _drop_evict_apache2
        info "Installing:$pkg ..."
        apt-get install -y $pkg || { die "apt-get failed — run as root."; return 1; }
    fi
}

_drop_nginx_letsencrypt() {
    local domain="$1" nginx_conf="$2" nginx_link="$3"
    local email=""
    while [[ -z "$email" ]]; do
        echo -ne "Let's Encrypt email: "
        read -r email || true
        [[ "$email" == "0" ]] && return 1
        [[ -z "$email" ]] && warn "Email required."
    done

    # Temp HTTP config for domain validation
    cat > "$nginx_conf" << HTTP_CONF
server { listen 80; server_name $domain; location / { return 301 https://\$host\$request_uri; } }
HTTP_CONF
    ln -sf "$nginx_conf" "$nginx_link" 2>/dev/null || true
    nginx -t && systemctl reload nginx || true

    certbot --nginx -d "$domain" --non-interactive --agree-tos -m "$email" \
        && success "SSL certificate issued." \
        || {
            warn "certbot failed — check DNS points to this server and port 80 is open."
            warn "Using Cloudflare? Go to Cloudflare DNS records, set this domain to 'DNS only' (grey cloud icon), then retry."
            return 1
        }
}

_drop_nginx_cloudflare() {
    local domain="$1"
    echo -e "\n  ${BOLD}Cloudflare Origin Certificate${RESET}"
    echo -e "  ${DIM}Cloudflare Dashboard → SSL/TLS → Origin Server → Create Certificate${RESET}\n"
    echo -ne "  Ready? [Enter to continue / 0 to cancel]: "
    local ok; read -r ok || true
    [[ "$ok" == "0" ]] && return 1

    echo ""
    echo -e "  ${BOLD}Paste Origin Certificate${RESET} (-----BEGIN CERTIFICATE----- ... -----END CERTIFICATE-----):"
    local cf_cert="" cf_line
    while IFS= read -r cf_line; do
        cf_cert+="$cf_line"$'\n'
        [[ "$cf_line" == *"-----END"* ]] && break
    done
    [[ "$cf_cert" != *"-----BEGIN"* ]] && { warn "Invalid certificate."; return 1; }

    echo ""
    echo -e "  ${BOLD}Paste Private Key${RESET} (-----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----):"
    local cf_key="" cf_key_line
    while IFS= read -r cf_key_line; do
        cf_key+="$cf_key_line"$'\n'
        [[ "$cf_key_line" == *"-----END"* ]] && break
    done
    [[ "$cf_key" != *"-----BEGIN"* ]] && { warn "Invalid private key."; return 1; }

    local cf_dir="/etc/ssl/cloudflare-origin"
    mkdir -p "$cf_dir"
    printf '%s' "$cf_cert" > "$cf_dir/$domain.pem"
    printf '%s' "$cf_key"  > "$cf_dir/$domain.key"
    chmod 644 "$cf_dir/$domain.pem"
    chmod 600 "$cf_dir/$domain.key"
    success "Cloudflare Origin Certificate saved → $cf_dir/$domain.pem"
}

_drop_nginx_logrotate() {
    local domain="$1"
    cat > "/etc/logrotate.d/nginx-grin-drop" << LOGROTATE
/var/log/nginx/grin-drop-${domain}-access.log
/var/log/nginx/grin-drop-${domain}-error.log {
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
    success "nginx logrotate: /etc/logrotate.d/nginx-grin-drop"
}
