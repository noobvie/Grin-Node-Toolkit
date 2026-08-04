# 092_lib_server.sh — Grin Transporter server: deploy, nginx, tor, admin
# Sourced by 092_grin_transporter.sh — inherits colors/log/network variables
# (TRP_* set by trp_set_network) and lib/nginx_shared_helpers.sh functions.
#
#  Functions exported:
#    trp_install_server   — Node.js + app files + config.json + systemd unit
#    trp_configure        — TTL / size cap / queue-depth cap prompts
#    trp_setup_domain     — nginx vhost + Let's Encrypt (HTTP-first bootstrap)
#    trp_setup_tor        — optional .onion front (HiddenServicePort → local port)
#    trp_service_ctl      — start/stop/restart the systemd service
#    trp_status           — service, port, /health, nginx, tor summary
#    trp_logs             — journalctl tail
#    trp_uninstall        — remove service/app/nginx (DB removal is opt-in)
#

# ─── Deployer conf (key=value, shared across networks) ────────────────────────
TRP_DEPLOY_CONF="/opt/grin/conf/grin_transporter.conf"

_trp_conf_get() {
    local key="$1" def="${2:-}"
    if [[ -f "$TRP_DEPLOY_CONF" ]]; then
        local val
        val=$(grep -E "^${key}=" "$TRP_DEPLOY_CONF" 2>/dev/null | tail -n1 | cut -d= -f2-)
        if [[ -n "$val" ]]; then echo "$val"; return 0; fi
    fi
    echo "$def"
}

_trp_conf_set() {
    local key="$1" val="$2"
    mkdir -p "$(dirname "$TRP_DEPLOY_CONF")"
    touch "$TRP_DEPLOY_CONF"
    if grep -qE "^${key}=" "$TRP_DEPLOY_CONF" 2>/dev/null; then
        sed -i "s|^${key}=.*|${key}=${val}|" "$TRP_DEPLOY_CONF"
    else
        echo "${key}=${val}" >> "$TRP_DEPLOY_CONF"
    fi
}

# ─── Node.js (v24+ needed for node:sqlite DatabaseSync — same bar as 059) ─────
_trp_ensure_node() {
    if command -v node &>/dev/null; then
        local major
        major=$(node --version 2>/dev/null | tr -d 'v' | cut -d. -f1)
        if [[ "${major:-0}" -ge 24 ]]; then
            success "Node.js $(node --version) present."
            return 0
        fi
        warn "Node.js $(node --version) is too old (need v24+ for node:sqlite)."
        echo -ne "  Remove it and install v24 LTS now? [y/N]: "
        local ok; read -r ok || true
        if [[ "${ok,,}" != "y" ]]; then info "Cancelled."; return 1; fi
        if command -v apt-get &>/dev/null; then
            apt-get remove -y nodejs npm 2>/dev/null || true
            apt-get autoremove -y 2>/dev/null || true
        fi
    fi
    info "Installing Node.js v24 LTS via NodeSource..."
    command -v curl &>/dev/null || { apt-get install -y curl 2>/dev/null || yum install -y curl; }
    if [[ -f /etc/debian_version ]]; then
        curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
            || { error "NodeSource setup failed."; return 1; }
        apt-get install -y nodejs || { error "apt-get install nodejs failed."; return 1; }
    elif [[ -f /etc/redhat-release ]]; then
        curl -fsSL https://rpm.nodesource.com/setup_24.x | bash - \
            || { error "NodeSource setup failed."; return 1; }
        yum install -y nodejs || { error "yum install nodejs failed."; return 1; }
    else
        error "Unsupported OS — install Node.js v24+ manually."
        return 1
    fi
    success "Node.js $(node --version) installed."
}

# ─── JSON config editor (node is guaranteed present after install) ────────────
# _trp_json_set <file> <key> <value> [numeric]
_trp_json_set() {
    local file="$1" key="$2" val="$3" numeric="${4:-}"
    node -e '
        const fs = require("fs");
        const [file, key, val, numeric] = process.argv.slice(1);
        let d = {};
        try { d = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
        d[key] = numeric ? parseInt(val, 10) : val;
        fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
    ' "$file" "$key" "$val" "$numeric"
}

_trp_json_get() {
    local file="$1" key="$2" def="${3:-}"
    if [[ ! -f "$file" ]]; then echo "$def"; return 0; fi
    node -e '
        const [file, key, def] = process.argv.slice(1);
        let d = {};
        try { d = JSON.parse(require("fs").readFileSync(file, "utf8")); } catch {}
        console.log(d[key] !== undefined ? String(d[key]) : def);
    ' "$file" "$key" "$def"
}

# =============================================================================
# 1) INSTALL SERVER
# =============================================================================
trp_install_server() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Transporter [$TRP_NET_LABEL] — 1) Install server ──${RESET}\n"
    echo -e "  ${DIM}Node.js v24, app files → $TRP_APP_DIR, systemd unit $TRP_SERVICE.${RESET}\n"

    _trp_ensure_node || { pause; return; }

    if [[ ! -d "$TRP_APP_SRC" ]]; then
        error "App source not found: $TRP_APP_SRC (ensure the toolkit repo is complete)."
        pause; return
    fi

    info "Copying $TRP_APP_SRC → $TRP_APP_DIR ..."
    mkdir -p "$TRP_APP_DIR"
    cp "$TRP_APP_SRC/server.js" "$TRP_APP_SRC/package.json" "$TRP_APP_DIR/"
    success "Server files copied."

    info "Running npm install --omit=dev ..."
    (cd "$TRP_APP_DIR" && npm install --omit=dev --no-audit --no-fund) \
        || { error "npm install failed."; pause; return; }
    success "Dependencies installed."

    # ── config.json (create only if missing — Configure edits it later) ───────
    if [[ ! -f "$TRP_CONF_JSON" ]]; then
        cat > "$TRP_CONF_JSON" << CONF
{
  "network": "$TRP_NETWORK",
  "port": $TRP_PORT,
  "ttl_hours": 336,
  "max_slate_bytes": 16384,
  "max_queue_per_addr": 100
}
CONF
        success "Default config written: $TRP_CONF_JSON"
    else
        info "Keeping existing config: $TRP_CONF_JSON"
    fi

    # ── Ownership: run as grin when the user exists (launch-contract spirit) ──
    local run_user="grin"
    id grin &>/dev/null || run_user="root"
    chown -R "$run_user:$run_user" "$TRP_DIR" 2>/dev/null || true
    chmod -R go-w "$TRP_APP_DIR"

    # ── systemd unit ───────────────────────────────────────────────────────────
    local node_bin; node_bin=$(command -v node)
    cat > "/etc/systemd/system/${TRP_SERVICE}.service" << SYSTEMD
[Unit]
Description=Grin Transporter [$TRP_NET_LABEL] — store-and-forward slate queue
After=network.target

[Service]
Type=simple
User=$run_user
WorkingDirectory=$TRP_APP_DIR
Environment="TRANSPORTER_CONF=$TRP_CONF_JSON"
Environment="TRANSPORTER_DB=$TRP_DB"
ExecStart=$node_bin $TRP_APP_DIR/server.js
Restart=always
RestartSec=15
StartLimitIntervalSec=0
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ReadWritePaths=$TRP_DIR
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SYSTEMD
    systemctl daemon-reload
    success "systemd unit: /etc/systemd/system/${TRP_SERVICE}.service"
    echo ""

    echo -ne "  Enable autostart on boot? [Y/n]: "
    local en; read -r en || true
    if [[ "${en,,}" != "n" ]]; then
        systemctl enable "$TRP_SERVICE" 2>/dev/null && success "Autostart enabled."
    fi
    echo -ne "  Start service now? [Y/n]: "
    local st; read -r st || true
    if [[ "${st,,}" != "n" ]]; then
        if systemctl restart "$TRP_SERVICE"; then
            success "Service started on 127.0.0.1:$TRP_PORT"
        else
            warn "Service failed — check: journalctl -u $TRP_SERVICE -n 30"
        fi
    fi

    log "[trp_install_server] net=$TRP_NETWORK node=$(node --version 2>/dev/null)"
    pause
}

# =============================================================================
# 2) CONFIGURE
# =============================================================================
trp_configure() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Transporter [$TRP_NET_LABEL] — 2) Configure ──${RESET}\n"
    if [[ ! -f "$TRP_CONF_JSON" ]]; then
        error "Not installed yet — run option 1 first."
        pause; return
    fi

    local cur_ttl cur_size cur_depth v
    cur_ttl=$(_trp_json_get   "$TRP_CONF_JSON" ttl_hours 336)
    cur_size=$(_trp_json_get  "$TRP_CONF_JSON" max_slate_bytes 16384)
    cur_depth=$(_trp_json_get "$TRP_CONF_JSON" max_queue_per_addr 100)

    echo -ne "  Slate TTL in hours [current: $cur_ttl]: "
    read -r v || true
    if [[ "$v" =~ ^[0-9]+$ && "$v" -ge 1 ]]; then _trp_json_set "$TRP_CONF_JSON" ttl_hours "$v" 1; fi

    echo -ne "  Max slate size in bytes [current: $cur_size]: "
    read -r v || true
    if [[ "$v" =~ ^[0-9]+$ && "$v" -ge 1024 ]]; then _trp_json_set "$TRP_CONF_JSON" max_slate_bytes "$v" 1; fi

    echo -ne "  Max queued slates per recipient [current: $cur_depth]: "
    read -r v || true
    if [[ "$v" =~ ^[0-9]+$ && "$v" -ge 1 ]]; then _trp_json_set "$TRP_CONF_JSON" max_queue_per_addr "$v" 1; fi

    success "Config saved: $TRP_CONF_JSON"
    if systemctl is-active --quiet "$TRP_SERVICE" 2>/dev/null; then
        echo -ne "  Restart service to apply now? [Y/n]: "
        read -r v || true
        if [[ "${v,,}" != "n" ]]; then
            systemctl restart "$TRP_SERVICE" && success "Restarted."
        fi
    fi
    pause
}

# =============================================================================
# 3) DOMAIN & SSL (nginx + certbot, HTTP-first bootstrap per CLAUDE.md)
# =============================================================================
trp_setup_domain() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Transporter [$TRP_NET_LABEL] — 3) Domain & SSL ──${RESET}\n"
    echo -e "  ${DIM}Public HTTPS front for the queue (agents on other boxes need this;${RESET}"
    echo -e "  ${DIM}a same-box round trip can use http://127.0.0.1:$TRP_PORT directly).${RESET}\n"

    local cur_domain domain
    cur_domain=$(_trp_conf_get "domain_${TRP_NETWORK}" "")
    echo -ne "  Domain for this instance${cur_domain:+ [current: $cur_domain]}: "
    read -r domain || true
    domain="${domain:-$cur_domain}"
    if ! nginx_validate_domain "$domain"; then pause; return; fi

    nginx_install_with_certbot || { pause; return; }

    # Script-specific rate-limit zone (script09- prefixed conf, per CLAUDE.md).
    nginx_ensure_rate_limit_zone "transporter_${TRP_NETWORK}" "60r/m" "10m" "script09-transporter-${TRP_NETWORK}"

    local nginx_conf="/etc/nginx/sites-available/grin-transporter-${TRP_NETWORK}"
    local nginx_link="/etc/nginx/sites-enabled/grin-transporter-${TRP_NETWORK}"

    # HTTP-only vhost first — never reference LE paths before the cert exists.
    cat > "$nginx_conf" << HTTP_CONF
server {
    listen 80;
    listen [::]:80;
    server_name $domain;
    location / { return 301 https://\$host\$request_uri; }
}
HTTP_CONF
    ln -sf "$nginx_conf" "$nginx_link"
    nginx -t && systemctl reload nginx || { error "nginx test failed on HTTP vhost."; pause; return; }

    local email
    email=$(_trp_conf_get "le_email" "")
    echo -ne "  Let's Encrypt email${email:+ [current: $email]}: "
    local em; read -r em || true
    email="${em:-$email}"
    if [[ -z "$email" ]]; then error "Email required for certbot."; pause; return; fi
    _trp_conf_set "le_email" "$email"

    if ! certbot --nginx -d "$domain" --non-interactive --agree-tos -m "$email"; then
        warn "certbot failed — check DNS points here and port 80 is open."
        warn "Using Cloudflare? Set the record to 'DNS only' (grey cloud), then retry."
        pause; return
    fi
    success "SSL certificate issued."

    # Full vhost — cert exists now; include LE snippets only when present.
    local ssl_extra=""
    [[ -f /etc/letsencrypt/options-ssl-nginx.conf ]] && ssl_extra="    include /etc/letsencrypt/options-ssl-nginx.conf;"
    if [[ -f /etc/letsencrypt/ssl-dhparams.pem ]]; then
        ssl_extra+=$'\n'"    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"
    fi

    cat > "$nginx_conf" << NGINX
# Grin Transporter [$TRP_NET_LABEL] — generated by 092_grin_transporter.sh
# Rate-limit zone in /etc/nginx/conf.d/script09-transporter-${TRP_NETWORK}.conf
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
$ssl_extra

    add_header Strict-Transport-Security "max-age=63072000" always;
    add_header X-Content-Type-Options    "nosniff" always;
    add_header X-Robots-Tag              "noindex, nofollow" always;

    client_max_body_size 64k;

    access_log /var/log/nginx/grin-transporter-${TRP_NETWORK}-access.log;
    error_log  /var/log/nginx/grin-transporter-${TRP_NETWORK}-error.log;

    location / {
        limit_req zone=transporter_${TRP_NETWORK} burst=20 nodelay;
        proxy_pass         http://127.0.0.1:${TRP_PORT};
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }
}
NGINX

    if nginx -t; then
        systemctl reload nginx
        _trp_conf_set "domain_${TRP_NETWORK}" "$domain"
        success "Transporter live at https://$domain  (health: https://$domain/health)"
    else
        error "nginx test failed on SSL vhost — inspect $nginx_conf"
    fi
    pause
}

# =============================================================================
# 4) TOR HIDDEN SERVICE (optional front)
# =============================================================================
trp_setup_tor() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Transporter [$TRP_NET_LABEL] — 4) Tor hidden service ──${RESET}\n"

    if ! command -v tor &>/dev/null; then
        echo -ne "  tor is not installed — install now? [Y/n]: "
        local yn; read -r yn || true
        if [[ "${yn,,}" == "n" ]]; then info "Cancelled."; pause; return; fi
        if command -v apt-get &>/dev/null; then
            apt-get install -y tor || { error "apt-get install tor failed."; pause; return; }
        else
            yum install -y tor || { error "yum install tor failed."; pause; return; }
        fi
    fi

    local hs_dir="/var/lib/tor/grin-transporter-${TRP_NETWORK}"
    local marker="# grin-transporter-${TRP_NETWORK} (script 092)"
    if ! grep -qF "$marker" /etc/tor/torrc 2>/dev/null; then
        cat >> /etc/tor/torrc << TORRC

$marker
HiddenServiceDir $hs_dir/
HiddenServicePort 80 127.0.0.1:$TRP_PORT
TORRC
        success "Hidden service block added to /etc/tor/torrc"
    else
        info "Hidden service block already present in torrc."
    fi

    systemctl restart tor@default 2>/dev/null || systemctl restart tor \
        || { error "tor restart failed."; pause; return; }
    sleep 3
    if [[ -f "$hs_dir/hostname" ]]; then
        local onion; onion=$(cat "$hs_dir/hostname")
        _trp_conf_set "onion_${TRP_NETWORK}" "$onion"
        success "Onion address: ${BOLD}$onion${RESET}"
        echo -e "  ${DIM}Agents can use transporter_url=http://$onion via a Tor SOCKS proxy.${RESET}"
    else
        warn "hostname not published yet — check again shortly: cat $hs_dir/hostname"
    fi
    pause
}

# =============================================================================
# 5) SERVICE CONTROL / STATUS / LOGS
# =============================================================================
trp_service_ctl() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Transporter [$TRP_NET_LABEL] — 5) Start / Stop ──${RESET}\n"
    if systemctl is-active --quiet "$TRP_SERVICE" 2>/dev/null; then
        echo -e "  Service is ${GREEN}running${RESET}."
        echo -ne "  [R]estart / [S]top / Enter to keep running: "
        local c; read -r c || true
        case "${c,,}" in
            r) systemctl restart "$TRP_SERVICE" && success "Restarted." ;;
            s) systemctl stop "$TRP_SERVICE" && success "Stopped." ;;
        esac
    else
        echo -e "  Service is ${YELLOW}stopped${RESET}."
        echo -ne "  Start it now? [Y/n]: "
        local c; read -r c || true
        if [[ "${c,,}" != "n" ]]; then
            systemctl start "$TRP_SERVICE" && success "Started." \
                || warn "Failed — journalctl -u $TRP_SERVICE -n 30"
        fi
    fi
    pause
}

trp_status() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Transporter [$TRP_NET_LABEL] — 6) Status ──${RESET}\n"

    local svc="stopped"
    systemctl is-active --quiet "$TRP_SERVICE" 2>/dev/null && svc="running"
    echo -e "  Service      : $( [[ $svc == running ]] && echo -e "${GREEN}running${RESET}" || echo -e "${YELLOW}stopped${RESET}" )  ($TRP_SERVICE)"
    echo -e "  Local port   : 127.0.0.1:$TRP_PORT"

    if command -v curl &>/dev/null && [[ "$svc" == "running" ]]; then
        local health
        health=$(curl -s --max-time 5 "http://127.0.0.1:$TRP_PORT/health" 2>/dev/null || true)
        if [[ -n "$health" ]]; then
            echo -e "  /health      : ${GREEN}$health${RESET}"
        else
            echo -e "  /health      : ${RED}no response${RESET}"
        fi
    fi

    local domain onion
    domain=$(_trp_conf_get "domain_${TRP_NETWORK}" "")
    onion=$(_trp_conf_get "onion_${TRP_NETWORK}" "")
    echo -e "  Domain       : ${domain:-${DIM}not configured${RESET}}"
    echo -e "  Onion        : ${onion:-${DIM}not configured${RESET}}"
    [[ -f "$TRP_DB" ]] && echo -e "  DB           : $TRP_DB ($(du -h "$TRP_DB" 2>/dev/null | cut -f1))"

    if [[ -f "$TRP_AGENT_CONF" ]]; then
        echo -e "  Poll agent   : ${GREEN}installed${RESET} ($TRP_AGENT_DIR)"
        local cron_file="/etc/cron.d/grin-transporter-agent-${TRP_NETWORK}"
        if [[ -f "$cron_file" ]]; then
            echo -e "  Agent cron   : ${GREEN}enabled${RESET} ($(grep -v '^#' "$cron_file" | head -n1 | awk '{print $1}'))"
        else
            echo -e "  Agent cron   : ${DIM}disabled${RESET}"
        fi
    else
        echo -e "  Poll agent   : ${DIM}not installed${RESET}"
    fi
    pause
}

trp_logs() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Transporter [$TRP_NET_LABEL] — Logs ──${RESET}\n"
    journalctl -u "$TRP_SERVICE" -n 40 --no-pager 2>/dev/null || warn "No journal entries."
    local agent_log="/opt/grin/logs/transporter_agent_${TRP_NETWORK}.log"
    if [[ -f "$agent_log" ]]; then
        echo -e "\n${BOLD}Agent log (last 20):${RESET}"
        tail -n 20 "$agent_log"
    fi
    pause
}

# =============================================================================
# D) UNINSTALL
# =============================================================================
trp_uninstall() {
    clear
    echo -e "\n${BOLD}${RED}── Grin Transporter [$TRP_NET_LABEL] — Delete instance ──${RESET}\n"
    echo -e "  Removes: service, app files, nginx vhost, agent cron."
    echo -e "  The queue DB is only deleted if you confirm separately."
    echo -ne "\n  Type DELETE to proceed: "
    local c; read -r c || true
    if [[ "$c" != "DELETE" ]]; then info "Cancelled."; pause; return; fi

    systemctl stop "$TRP_SERVICE" 2>/dev/null || true
    systemctl disable "$TRP_SERVICE" 2>/dev/null || true
    rm -f "/etc/systemd/system/${TRP_SERVICE}.service"
    systemctl daemon-reload
    success "Service removed."

    rm -f "/etc/nginx/sites-enabled/grin-transporter-${TRP_NETWORK}" \
          "/etc/nginx/sites-available/grin-transporter-${TRP_NETWORK}" \
          "/etc/nginx/conf.d/script09-transporter-${TRP_NETWORK}.conf"
    nginx -t 2>/dev/null && systemctl reload nginx 2>/dev/null || true
    success "nginx vhost removed."

    rm -f "/etc/cron.d/grin-transporter-agent-${TRP_NETWORK}" \
          "/etc/logrotate.d/grin-transporter-agent-${TRP_NETWORK}"
    rm -rf "$TRP_APP_DIR" "$TRP_AGENT_DIR"
    success "App + agent files removed."

    if [[ -f "$TRP_DB" ]]; then
        echo -ne "  Also delete the queue DB ($TRP_DB)? [y/N]: "
        read -r c || true
        if [[ "${c,,}" == "y" ]]; then
            rm -rf "$TRP_DIR"
            success "Data dir removed."
        else
            info "Queue DB kept at $TRP_DB"
        fi
    else
        rmdir "$TRP_DIR" 2>/dev/null || true
    fi
    warn "Tor hidden-service block (if configured) was left in /etc/tor/torrc — remove manually."
    pause
}
