# 052_lib_nginx.sh — Grin Drop nginx configuration
# Sourced by 052_grin_drop.sh — inherits all color/log/network variables.
# =============================================================================
#
#  Functions exported:
#    drop_setup_nginx          — step 6: per-network vhost (path routing)
#    drop_setup_unified_nginx  — step 6U: unified homepage vhost
#

# =============================================================================
# OPTION 6 — Setup nginx (per-network: /testnet/ or /mainnet/ path routing)
# =============================================================================

drop_setup_nginx() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — 6) Setup nginx ──${RESET}\n"
    echo -e "  ${DIM}Configures nginx vhost with /${DROP_NETWORK}/ path prefix routing.${RESET}\n"

    # Install dependencies
    _drop_nginx_ensure_installed || { pause; return; }

    if [[ ! -d "$DROP_WEB_DIR" ]]; then
        die "Web files not deployed — run option 5 first."; pause; return
    fi

    local domain; domain=$(drop_read_conf "subdomain" "")
    if [[ -z "$domain" ]]; then
        warn "No domain set — configure it in option 4 first."
        echo -ne "  Domain (or Enter to abort): "
        read -r domain || true
        [[ -z "$domain" ]] && { info "Aborted."; pause; return; }
        drop_write_conf_key "subdomain" "$domain"
    fi

    info "Domain: $domain"
    echo ""

    local port; port=$(drop_read_conf "service_port" "$DROP_PORT")
    local net="${DROP_NETWORK}"
    local zone="drop_${net}"
    local admin_path; admin_path=$(drop_read_conf "admin_secret_path" "")

    # ── SSL method ────────────────────────────────────────────────────────────
    echo -e "  ${BOLD}SSL Certificate:${RESET}"
    echo -e "  ${GREEN}1${RESET}) Let's Encrypt  ${DIM}(DNS must be grey-cloud / DNS-only during issuance)${RESET}"
    echo -e "  ${GREEN}2${RESET}) Cloudflare Origin Certificate  ${DIM}(domain can stay Proxied)${RESET}"
    echo -ne "  Choice [1/2/0 to cancel]: "
    local ssl_choice
    read -r ssl_choice || true
    [[ "$ssl_choice" == "0" ]] && return
    [[ "$ssl_choice" != "2" ]] && ssl_choice="1"
    echo ""

    local ssl_cert ssl_key ssl_params=""
    if [[ "$ssl_choice" == "1" ]]; then
        _drop_nginx_letsencrypt "$domain" || { pause; return; }
        ssl_cert="/etc/letsencrypt/live/$domain/fullchain.pem"
        ssl_key="/etc/letsencrypt/live/$domain/privkey.pem"
        ssl_params="include /etc/letsencrypt/options-ssl-nginx.conf;\n    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"
    else
        _drop_nginx_cloudflare "$domain" || { pause; return; }
        local cf_dir="/etc/ssl/cloudflare-origin"
        ssl_cert="$cf_dir/$domain.pem"
        ssl_key="$cf_dir/$domain.key"
        ssl_params="ssl_protocols TLSv1.2 TLSv1.3;\n    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;\n    ssl_prefer_server_ciphers off;\n    ssl_session_cache shared:SSL:10m;\n    ssl_session_timeout 1d;"
    fi

    _drop_write_nginx_conf "$domain" "$port" "$net" "$zone" "$admin_path" \
                           "$ssl_cert" "$ssl_key" "$ssl_params" \
                           "$DROP_NGINX_CONF" "$DROP_NGINX_LINK"

    nginx -t && systemctl reload nginx && success "nginx config loaded for $DROP_NET_LABEL." \
        || { warn "nginx test failed — check $DROP_NGINX_CONF"; pause; return; }

    _drop_nginx_logrotate "$net"

    info "URL: https://$domain/${net}/"
    local secret; secret=$(drop_read_conf "admin_secret_path" "")
    [[ -n "$secret" ]] && info "Admin: https://$domain/${net}/$secret/admin/"
    log "[drop_setup_nginx] network=$NET domain=$domain ssl=$ssl_choice"
    pause
}

# =============================================================================
# OPTION 6U — Unified Homepage nginx
# =============================================================================

drop_setup_unified_nginx() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop — 6U) Unified Homepage nginx ──${RESET}\n"
    echo -e "  ${DIM}Configures a vhost that serves the unified homepage at / and proxies${RESET}"
    echo -e "  ${DIM}/testnet/ → :3004  and  /mainnet/ → :3005${RESET}\n"

    _drop_nginx_ensure_installed || { pause; return; }

    local home_src="$TOOLKIT_ROOT/web/052_drop/home"
    if [[ ! -d "$home_src" ]]; then
        die "Unified homepage source not found: $home_src"; pause; return
    fi

    echo -ne "Unified homepage domain [e.g. drop.example.com]: "
    local domain; read -r domain || true
    [[ -z "$domain" ]] && { info "Cancelled."; pause; return; }

    local home_web_dir="/var/www/grin-drop-home"
    info "Deploying unified homepage to $home_web_dir ..."
    mkdir -p "$home_web_dir"
    cp -r "$home_src"/. "$home_web_dir/"
    find "$home_web_dir" -type f \( -name "*.html" -o -name "*.css" \) -exec chmod 644 {} \;
    success "Unified homepage deployed."
    echo ""

    # SSL
    echo -e "  ${BOLD}SSL Certificate:${RESET}"
    echo -e "  ${GREEN}1${RESET}) Let's Encrypt"
    echo -e "  ${GREEN}2${RESET}) Cloudflare Origin Certificate"
    echo -ne "  Choice [1/2/0 to cancel]: "
    local ssl_choice; read -r ssl_choice || true
    [[ "$ssl_choice" == "0" ]] && return
    [[ "$ssl_choice" != "2" ]] && ssl_choice="1"

    local ssl_cert ssl_key ssl_params=""
    if [[ "$ssl_choice" == "1" ]]; then
        _drop_nginx_letsencrypt "$domain" || { pause; return; }
        ssl_cert="/etc/letsencrypt/live/$domain/fullchain.pem"
        ssl_key="/etc/letsencrypt/live/$domain/privkey.pem"
        ssl_params="include /etc/letsencrypt/options-ssl-nginx.conf;\n    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"
    else
        _drop_nginx_cloudflare "$domain" || { pause; return; }
        local cf_dir="/etc/ssl/cloudflare-origin"
        ssl_cert="$cf_dir/$domain.pem"
        ssl_key="$cf_dir/$domain.key"
        ssl_params="ssl_protocols TLSv1.2 TLSv1.3;\n    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;\n    ssl_prefer_server_ciphers off;"
    fi

    local nginx_conf="/etc/nginx/sites-available/grin-drop-home"
    local nginx_link="/etc/nginx/sites-enabled/grin-drop-home"

    # Read testnet/mainnet admin secrets for nginx admin location blocks
    local test_port=3004 main_port=3005
    local test_admin="" main_admin=""
    local test_conf="/opt/grin/drop-test/grin_drop_test.conf"
    local main_conf="/opt/grin/drop-main/grin_drop_main.conf"
    [[ -f "$test_conf" ]] && test_admin=$(python3 -c "import json; d=json.load(open('$test_conf')); print(d.get('admin_secret_path',''))" 2>/dev/null || true)
    [[ -f "$main_conf" ]] && main_admin=$(python3 -c "import json; d=json.load(open('$main_conf')); print(d.get('admin_secret_path',''))" 2>/dev/null || true)

    cat > "$nginx_conf" << NGINX_HOME
# Grin Drop — Unified Homepage — generated by 052_grin_drop.sh
limit_req_zone \$binary_remote_addr zone=drop_home:10m rate=30r/m;
limit_req_zone \$binary_remote_addr zone=drop_api:10m  rate=10r/m;

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
    add_header X-Content-Type-Options    "nosniff"  always;
    add_header X-Frame-Options           "SAMEORIGIN" always;
    add_header Referrer-Policy           "strict-origin" always;
    add_header Content-Security-Policy   "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;" always;

    client_max_body_size 8k;

    access_log /var/log/nginx/grin-drop-home-access.log;
    error_log  /var/log/nginx/grin-drop-home-error.log;

    # ── Static homepage ──────────────────────────────────────────────────────
    location / {
        limit_req zone=drop_home burst=10 nodelay;
        try_files \$uri \$uri/ /index.html;
    }

    location ~* \.(css|js|ico|png|svg|woff2?)\$ {
        expires 1h;
        add_header Cache-Control "public";
    }

    # ── Testnet portal (:$test_port) ─────────────────────────────────────────
    location /testnet/ {
        limit_req zone=drop_api burst=5 nodelay;
        proxy_pass         http://127.0.0.1:${test_port}/;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Prefix /testnet;
        proxy_read_timeout 90s;
    }

$([ -n "$test_admin" ] && cat << TESTADMIN
    location /testnet/$test_admin/ {
        limit_req zone=drop_api burst=3 nodelay;
        proxy_pass         http://127.0.0.1:${test_port}/;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
        add_header X-Robots-Tag "noindex, nofollow" always;
    }
TESTADMIN
)

    # ── Mainnet portal (:$main_port) ─────────────────────────────────────────
    location /mainnet/ {
        limit_req zone=drop_api burst=5 nodelay;
        proxy_pass         http://127.0.0.1:${main_port}/;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Prefix /mainnet;
        proxy_read_timeout 90s;
    }

$([ -n "$main_admin" ] && cat << MAINADMIN
    location /mainnet/$main_admin/ {
        limit_req zone=drop_api burst=3 nodelay;
        proxy_pass         http://127.0.0.1:${main_port}/;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
        add_header X-Robots-Tag "noindex, nofollow" always;
    }
MAINADMIN
)

    location ~ /\.  { deny all; }
    location ~ ~\$  { deny all; }
}
NGINX_HOME

    ln -sf "$nginx_conf" "$nginx_link" 2>/dev/null || true
    nginx -t && systemctl reload nginx && success "Unified homepage nginx config loaded." \
        || { warn "nginx test failed — check $nginx_conf"; pause; return; }

    _drop_nginx_logrotate "home"
    info "Unified homepage: https://$domain/"
    info "Testnet portal  : https://$domain/testnet/"
    info "Mainnet portal  : https://$domain/mainnet/"
    log "[drop_setup_unified_nginx] domain=$domain"
    pause
}

# =============================================================================
# Shared nginx helpers
# =============================================================================

_drop_nginx_ensure_installed() {
    local need_nginx=false need_certbot=false
    command -v nginx   &>/dev/null || need_nginx=true
    command -v certbot &>/dev/null || need_certbot=true
    local pkg=""
    $need_nginx   && pkg="$pkg nginx"
    $need_certbot && pkg="$pkg certbot python3-certbot-nginx"
    if [[ -n "$pkg" ]]; then
        info "Installing:$pkg ..."
        apt-get install -y $pkg || { die "apt-get failed — run as root."; return 1; }
    fi
}

_drop_nginx_letsencrypt() {
    local domain="$1"
    local email=""
    while [[ -z "$email" ]]; do
        echo -ne "Let's Encrypt email: "
        read -r email || true
        [[ "$email" == "0" ]] && return 1
        [[ -z "$email" ]] && warn "Email required."
    done

    # Temp HTTP config for domain validation
    local tmp_conf="/tmp/nginx_le_tmp_$$.conf"
    cat > "$tmp_conf" << HTTP_CONF
server { listen 80; server_name $domain; location / { return 301 https://\$host\$request_uri; } }
HTTP_CONF
    cp "$tmp_conf" "$DROP_NGINX_CONF" 2>/dev/null || cp "$tmp_conf" "/etc/nginx/sites-available/grin-drop-tmp"
    rm "$tmp_conf"
    ln -sf "$DROP_NGINX_CONF" "$DROP_NGINX_LINK" 2>/dev/null || true
    nginx -t && systemctl reload nginx || true

    certbot --nginx -d "$domain" --non-interactive --agree-tos -m "$email" \
        && success "SSL certificate issued." \
        || {
            warn "certbot failed — check DNS is pointing to this server, port 80 open."
            warn "Using Cloudflare? Set DNS to 'DNS only' (grey cloud) for cert issuance."
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

_drop_write_nginx_conf() {
    local domain="$1" port="$2" net="$3" zone="$4" admin_path="$5"
    local ssl_cert="$6" ssl_key="$7" ssl_params="$8"
    local nginx_conf="$9" nginx_link="${10}"

    cat > "$nginx_conf" << NGINX
# Grin Drop [$DROP_NET_LABEL] — generated by 052_grin_drop.sh
# Path routing: /${net}/ → Node.js :${port}
limit_req_zone \$binary_remote_addr zone=${zone}_claim:10m rate=3r/m;
limit_req_zone \$binary_remote_addr zone=${zone}_api:10m   rate=10r/m;
limit_req_zone \$binary_remote_addr zone=${zone}_donate:5m rate=5r/m;
limit_req_zone \$binary_remote_addr zone=${zone}_admin:5m  rate=6r/m;

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

    root  $DROP_WEB_DIR;
    index index.html;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options    "nosniff"  always;
    add_header X-Frame-Options           "DENY"     always;
    add_header Referrer-Policy           "strict-origin" always;
    add_header Content-Security-Policy   "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;" always;

    client_max_body_size 8k;

    access_log /var/log/nginx/grin-drop-${net}-access.log;
    error_log  /var/log/nginx/grin-drop-${net}-error.log;

    # ── Public API ───────────────────────────────────────────────────────────
    location /${net}/api/claim {
        limit_req zone=${zone}_claim burst=2 nodelay;
        proxy_pass         http://127.0.0.1:${port};
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 90s;
    }

    location /${net}/api/donate/ {
        limit_req zone=${zone}_donate burst=3 nodelay;
        proxy_pass         http://127.0.0.1:${port};
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 90s;
    }

    location /${net}/api/ {
        limit_req zone=${zone}_api burst=5 nodelay;
        proxy_pass         http://127.0.0.1:${port};
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 90s;
    }

$(if [[ -n "$admin_path" ]]; then
cat << ADMIN_BLOCK
    # ── Admin (secret URL path) ──────────────────────────────────────────────
    location /${net}/${admin_path}/ {
        limit_req zone=${zone}_admin burst=3 nodelay;
        add_header X-Robots-Tag "noindex, nofollow" always;
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
        proxy_pass         http://127.0.0.1:${port};
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }
ADMIN_BLOCK
fi)

    # ── Static files ─────────────────────────────────────────────────────────
    location /${net}/ {
        proxy_pass         http://127.0.0.1:${port}/;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }

    location ~* \.(css|js|ico|png|svg|woff2?)\$ {
        expires 1h;
        add_header Cache-Control "public";
    }

    location ~ /\.  { deny all; }
    location ~ ~\$  { deny all; }
}
NGINX

    ln -sf "$nginx_conf" "$nginx_link" 2>/dev/null || true
    success "nginx config written: $nginx_conf"
}

_drop_nginx_logrotate() {
    local net="$1"
    cat > "/etc/logrotate.d/nginx-grin-drop-${net}" << LOGROTATE
/var/log/nginx/grin-drop-${net}-access.log
/var/log/nginx/grin-drop-${net}-error.log {
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
    success "nginx logrotate: /etc/logrotate.d/nginx-grin-drop-${net}"
}
