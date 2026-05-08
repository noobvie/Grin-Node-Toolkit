# 06b_grinscan.sh — GrinScan lightweight block explorer (Node.js / Express)
# Sourced by 06_global_grin_health.sh — inherits colors, log(), info(), success(),
# warn(), error(), die(), pause(), require_root(), detect_node(), check_dns_record().

# ── Paths ─────────────────────────────────────────────────────────────────────

GRINSCAN_DIR="/opt/grin/grinscan"
GRINSCAN_WEB="${TOOLKIT_ROOT}/web/06b_grinscan"
GRINSCAN_APP="${GRINSCAN_DIR}/app"
NGINX_GRINSCAN_TEST_CONF="/etc/nginx/sites-available/grinscan-test"
NGINX_GRINSCAN_MAIN_CONF="/etc/nginx/sites-available/grinscan-main"
GRINSCAN_TEST_PORT=3010
GRINSCAN_MAIN_PORT=3011

# ── Install ───────────────────────────────────────────────────────────────────

grinscan_install() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── GrinScan: Install ──${RESET}\n"

    # Node.js version check (need >= 24 for node:sqlite DatabaseSync)
    local node_ver=""
    if command -v node &>/dev/null; then
        node_ver=$(node --version 2>/dev/null | sed 's/v//')
    fi

    local node_ok=0
    if [[ -n "$node_ver" ]]; then
        local major
        major=$(echo "$node_ver" | cut -d. -f1)
        if [[ $major -ge 24 ]]; then
            node_ok=1
            success "Node.js v${node_ver} ✓"
        else
            warn "Node.js v${node_ver} detected — GrinScan requires v24+."
            info "Removing old Node.js before upgrading…"
            apt-get remove -y nodejs npm 2>/dev/null || true
            apt-get autoremove -y 2>/dev/null || true
        fi
    fi

    if [[ $node_ok -eq 0 ]]; then
        info "Installing Node.js 24.x via NodeSource…"
        curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
            || { die "NodeSource setup failed."; return; }
        apt-get install -y nodejs -qq \
            || { die "Node.js install failed."; return; }
        success "Node.js installed: $(node --version)"
    fi

    # Deploy app to www-data-accessible location
    info "Deploying app to ${GRINSCAN_APP}…"
    mkdir -p "${GRINSCAN_APP}"
    cp -r "${GRINSCAN_WEB}/." "${GRINSCAN_APP}/"

    # npm install in deployed location (so www-data can read node_modules)
    info "Installing npm dependencies…"
    npm install --prefix "${GRINSCAN_APP}" --omit=dev --silent \
        || { die "npm install failed."; return; }
    success "npm packages installed."

    # Runtime directories + ownership (recursive — covers app/ test/ main/)
    mkdir -p "${GRINSCAN_DIR}/test" "${GRINSCAN_DIR}/main"
    chown -R www-data:www-data "${GRINSCAN_DIR}"

    # Systemd unit — testnet
    cat > /etc/systemd/system/grinscan-test.service <<UNIT
[Unit]
Description=GrinScan Block Explorer (testnet)
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=${GRINSCAN_APP}
ExecStart=/usr/bin/node ${GRINSCAN_APP}/server.js
Environment=GRINSCAN_CONFIG=${GRINSCAN_DIR}/test/config.json
Restart=on-failure
RestartSec=10
StandardOutput=append:${GRINSCAN_DIR}/test/grinscan-test.log
StandardError=append:${GRINSCAN_DIR}/test/grinscan-test.log

[Install]
WantedBy=multi-user.target
UNIT

    # Systemd unit — mainnet
    cat > /etc/systemd/system/grinscan-main.service <<UNIT
[Unit]
Description=GrinScan Block Explorer (mainnet)
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=${GRINSCAN_APP}
ExecStart=/usr/bin/node ${GRINSCAN_APP}/server.js
Environment=GRINSCAN_CONFIG=${GRINSCAN_DIR}/main/config.json
Restart=on-failure
RestartSec=10
StandardOutput=append:${GRINSCAN_DIR}/main/grinscan-main.log
StandardError=append:${GRINSCAN_DIR}/main/grinscan-main.log

[Install]
WantedBy=multi-user.target
UNIT

    systemctl daemon-reload

    success "GrinScan installed."
    echo ""
    echo -e "  Next: run ${BOLD}Configure (2)${RESET} to write config.json for each network."
    log "grinscan_install complete"
    pause
}

# ── Configure ─────────────────────────────────────────────────────────────────

grinscan_configure() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── GrinScan: Configure ──${RESET}\n"
    echo -e "  ${BOLD}Which network?${RESET}"
    echo -e "  ${GREEN}1${RESET}) Testnet"
    echo -e "  ${GREEN}2${RESET}) Mainnet"
    echo -e "  ${GREEN}3${RESET}) Both"
    echo -e "  ${DIM}0) Cancel${RESET}"
    echo ""
    echo -ne "${BOLD}Select [1/2/3/0]: ${RESET}"
    read -r net_choice

    local networks=()
    case "$net_choice" in
        1) networks=("testnet") ;;
        2) networks=("mainnet") ;;
        3) networks=("testnet" "mainnet") ;;
        0|"") return ;;
        *) warn "Invalid choice."; sleep 1; return ;;
    esac

    for net in "${networks[@]}"; do
        echo ""
        echo -e "  ${BOLD}Configuring ${CYAN}${net}${RESET}…"

        local node_port node_dir secret_dir
        if [[ "$net" == "testnet" ]]; then
            node_port=13413
            node_dir="/opt/grin/node/testnet-prune"
        else
            node_port=3413
            node_dir="/opt/grin/node/mainnet-prune"
            [[ -d /opt/grin/node/mainnet-full ]] && node_dir="/opt/grin/node/mainnet-full"
        fi

        local default_node_url="http://127.0.0.1:${node_port}/v2/foreign"
        local default_owner_url="http://127.0.0.1:${node_port}/v2/owner"
        local foreign_secret_path="${node_dir}/.foreign_api_secret"
        local owner_secret_path="${node_dir}/.api_secret"
        local svc_port; svc_port=$( [[ "$net" == "testnet" ]] && echo $GRINSCAN_TEST_PORT || echo $GRINSCAN_MAIN_PORT )
        local net_short; net_short=$( [[ "$net" == "testnet" ]] && echo "test" || echo "main" )
        local config_path="${GRINSCAN_DIR}/${net_short}/config.json"
        local db_path="${GRINSCAN_DIR}/${net_short}/grinscan.db"
        local log_path="${GRINSCAN_DIR}/${net_short}/grinscan-${net_short}.log"

        echo -ne "  Node URL [${default_node_url}]: "
        read -r user_node_url
        local node_url="${user_node_url:-$default_node_url}"
        local owner_url="${default_owner_url}"

        # Connectivity pre-check via Owner API
        info "Testing node connection…"
        if ! ss -tlnp 2>/dev/null | grep -q ":${node_port} "; then
            warn "Node API port :${node_port} not listening — is the node running?"
            echo -ne "  Continue anyway? [Y/n]: "
            read -r cont
            [[ "${cont,,}" == "n" ]] && { info "Skipping ${net}."; continue; }
        elif [[ -f "$owner_secret_path" ]]; then
            local secret; secret=$(tr -d '[:space:]' < "$owner_secret_path" 2>/dev/null || true)
            local resp; resp=$(curl -s --max-time 5 -u "grin:${secret}" \
                -H 'Content-Type: application/json' \
                -d '{"jsonrpc":"2.0","method":"get_status","params":[],"id":1}' \
                "$default_owner_url" 2>/dev/null || true)
            if echo "$resp" | grep -q '"sync_status"'; then
                success "Node reachable ✓"
            else
                warn "Node not reachable at ${default_owner_url}"
                [[ -n "$resp" ]] && warn "Response: ${resp:0:120}"
                echo -ne "  Continue anyway? [Y/n]: "
                read -r cont
                [[ "${cont,,}" == "n" ]] && { info "Skipping ${net}."; continue; }
            fi
        else
            warn "Owner secret not found at ${owner_secret_path} — skipping connectivity check."
        fi

        # GA4 (mainnet only)
        local ga4_id=""
        if [[ "$net" == "mainnet" ]]; then
            echo -ne "  GA4 Measurement ID (leave blank to disable, e.g. G-XXXXXXXXXX): "
            read -r ga4_input
            if [[ -n "$ga4_input" ]]; then
                if [[ "$ga4_input" =~ ^G- ]]; then
                    ga4_id="$ga4_input"
                else
                    warn "GA4 ID must start with 'G-' — analytics disabled."
                fi
            fi
        fi

        mkdir -p "${GRINSCAN_DIR}/${net_short}"

        # Copy node secrets into the grinscan data dir so www-data can read them
        # without needing membership in the grin group.
        local gs_foreign_secret="${GRINSCAN_DIR}/${net_short}/.foreign_api_secret"
        local gs_owner_secret="${GRINSCAN_DIR}/${net_short}/.api_secret"
        if [[ -f "$foreign_secret_path" ]]; then
            cp "$foreign_secret_path" "$gs_foreign_secret"
            chown www-data:www-data "$gs_foreign_secret"
            chmod 600 "$gs_foreign_secret"
        else
            warn "Foreign secret not found at ${foreign_secret_path} — node API calls may fail."
        fi
        if [[ -f "$owner_secret_path" ]]; then
            cp "$owner_secret_path" "$gs_owner_secret"
            chown www-data:www-data "$gs_owner_secret"
            chmod 600 "$gs_owner_secret"
        else
            warn "Owner secret not found at ${owner_secret_path} — node API calls may fail."
        fi

        cat > "$config_path" <<JSON
{
  "network":             "${net}",
  "node_url":            "${node_url}",
  "node_owner_url":      "${owner_url}",
  "foreign_secret_path": "${gs_foreign_secret}",
  "owner_secret_path":   "${gs_owner_secret}",
  "port":                ${svc_port},
  "db_path":             "${db_path}",
  "log_path":            "${log_path}",
  "poll_interval_ms":    30000,
  "blocks_cache":        500,
  "web_dir":             "${GRINSCAN_APP}/public",
  "ga4_measurement_id":  "${ga4_id}"
}
JSON

        success "Config written: ${config_path}"
        log "grinscan_configure: ${net} → ${config_path}"
    done

    echo ""
    echo -e "  Next: run ${BOLD}Start (3)${RESET} to launch the service."
    echo ""
    echo -e "  ${YELLOW}⚠  If you rebuild the node or reset its API secrets (Script 01),${RESET}"
    echo -e "  ${YELLOW}   re-run Configure (2) to refresh the secret copies in this dir.${RESET}"
    pause
}

# ── Start ─────────────────────────────────────────────────────────────────────

grinscan_start() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── GrinScan: Start ──${RESET}\n"

    local net_choice; net_choice=$(_grinscan_pick_net) || return
    local nets; IFS=',' read -ra nets <<< "$net_choice"

    for net in "${nets[@]}"; do
        local net_short; net_short=$( [[ "$net" == "testnet" ]] && echo "test" || echo "main" )
        local svc="grinscan-${net_short}"
        local config_path="${GRINSCAN_DIR}/${net_short}/config.json"
        local svc_port; svc_port=$( [[ "$net" == "testnet" ]] && echo $GRINSCAN_TEST_PORT || echo $GRINSCAN_MAIN_PORT )

        [[ ! -f "$config_path" ]] && { warn "Config not found for ${net}. Run Configure (2) first."; continue; }

        systemctl start "$svc" 2>/dev/null \
            && success "${svc} started." \
            || { error "Failed to start ${svc}. Check logs."; continue; }

        local waited=0
        while [[ $waited -lt 10 ]]; do
            sleep 2; waited=$((waited+2))
            if ss -tlnp 2>/dev/null | grep -q ":${svc_port} "; then
                success "Port :${svc_port} is listening."
                echo -e "  URL: ${CYAN}http://127.0.0.1:${svc_port}${RESET}"
                break
            fi
        done
        if ! ss -tlnp 2>/dev/null | grep -q ":${svc_port} "; then
            warn "Port :${svc_port} not yet listening after ${waited}s — check: journalctl -u ${svc} -n 20"
        fi
        log "grinscan_start: ${svc}"
    done
    pause
}

# ── Stop ──────────────────────────────────────────────────────────────────────

grinscan_stop() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── GrinScan: Stop ──${RESET}\n"

    local net_choice; net_choice=$(_grinscan_pick_net) || return
    local nets; IFS=',' read -ra nets <<< "$net_choice"

    for net in "${nets[@]}"; do
        local net_short; net_short=$( [[ "$net" == "testnet" ]] && echo "test" || echo "main" )
        local svc="grinscan-${net_short}"
        systemctl stop "$svc" 2>/dev/null \
            && success "${svc} stopped." \
            || warn "${svc} was not running."
        log "grinscan_stop: ${svc}"
    done
    pause
}

# ── Status ────────────────────────────────────────────────────────────────────

grinscan_status() {
    clear
    echo -e "\n${BOLD}${CYAN}── GrinScan: Status ──${RESET}\n"

    for net_short in test main; do
        local net; net=$( [[ "$net_short" == "test" ]] && echo "testnet" || echo "mainnet" )
        local svc="grinscan-${net_short}"
        local svc_port; svc_port=$( [[ "$net_short" == "test" ]] && echo $GRINSCAN_TEST_PORT || echo $GRINSCAN_MAIN_PORT )
        local config_path="${GRINSCAN_DIR}/${net_short}/config.json"
        local db_path="${GRINSCAN_DIR}/${net_short}/grinscan.db"
        local nginx_conf; nginx_conf=$( [[ "$net_short" == "test" ]] && echo "$NGINX_GRINSCAN_TEST_CONF" || echo "$NGINX_GRINSCAN_MAIN_CONF" )

        echo -e "  ${BOLD}${CYAN}${net^^}${RESET}"

        # Service state
        local active; active=$(systemctl is-active "$svc" 2>/dev/null || echo "inactive")
        if [[ "$active" == "active" ]]; then
            echo -e "    Service:    ${GREEN}● running${RESET}"
        else
            echo -e "    Service:    ${RED}○ ${active}${RESET}"
        fi

        # Port
        if ss -tlnp 2>/dev/null | grep -q ":${svc_port} "; then
            echo -e "    Port :${svc_port}: ${GREEN}listening${RESET}"
        else
            echo -e "    Port :${svc_port}: ${YELLOW}not listening${RESET}"
        fi

        # Config
        if [[ -f "$config_path" ]]; then
            echo -e "    Config:     ${GREEN}✓ ${config_path}${RESET}"
        else
            echo -e "    Config:     ${RED}✗ not found${RESET}"
        fi

        # DB stats
        if [[ -f "$db_path" ]]; then
            local block_count max_height last_price
            block_count=$(sqlite3 "$db_path" "SELECT COUNT(*) FROM blocks;" 2>/dev/null || echo "—")
            max_height=$(sqlite3   "$db_path" "SELECT MAX(height) FROM blocks;" 2>/dev/null || echo "—")
            last_price=$(sqlite3   "$db_path" \
                "SELECT datetime(timestamp,'unixepoch')||' / $'||ROUND(price_usd,4) FROM prices ORDER BY timestamp DESC LIMIT 1;" \
                2>/dev/null || echo "—")
            echo -e "    Blocks:     ${CYAN}${block_count}${RESET}  (tip height: ${max_height})"
            echo -e "    Last price: ${CYAN}${last_price}${RESET}"
        else
            echo -e "    DB:         ${YELLOW}not created yet${RESET}"
        fi

        # Nginx
        if [[ -f "$nginx_conf" ]]; then
            local domain; domain=$(grep -E "^\s+server_name " "$nginx_conf" | awk '{print $2}' | tr -d ';' | head -1)
            echo -e "    Nginx:      ${GREEN}✓ configured${RESET}  ${DIM}${domain}${RESET}"
            # SSL
            if [[ -n "$domain" ]] && certbot certificates 2>/dev/null | grep -q "$domain"; then
                echo -e "    SSL:        ${GREEN}✓ active${RESET}"
            else
                echo -e "    SSL:        ${YELLOW}not issued${RESET}"
            fi
        else
            echo -e "    Nginx:      ${YELLOW}not configured${RESET}"
        fi

        echo ""
    done
    pause
}

# ── Logs ──────────────────────────────────────────────────────────────────────

grinscan_logs() {
    clear
    echo -e "\n${BOLD}${CYAN}── GrinScan: View Logs ──${RESET}\n"
    echo -e "  ${GREEN}1${RESET}) Testnet"
    echo -e "  ${GREEN}2${RESET}) Mainnet"
    echo -e "  ${GREEN}3${RESET}) Both"
    echo -e "  ${DIM}0) Back${RESET}"
    echo ""
    echo -ne "${BOLD}Select [1/2/3/0]: ${RESET}"
    read -r choice

    local log_test="${GRINSCAN_DIR}/test/grinscan-test.log"
    local log_main="${GRINSCAN_DIR}/main/grinscan-main.log"

    echo -e "\n  ${DIM}Press Ctrl+C to exit log view${RESET}\n"
    case "$choice" in
        1) [[ -f "$log_test" ]] && tail -f "$log_test" || { warn "No testnet log found."; pause; } ;;
        2) [[ -f "$log_main" ]] && tail -f "$log_main" || { warn "No mainnet log found."; pause; } ;;
        3)
            local files=()
            [[ -f "$log_test" ]] && files+=("$log_test")
            [[ -f "$log_main" ]] && files+=("$log_main")
            if [[ ${#files[@]} -eq 0 ]]; then warn "No log files found."; pause; return; fi
            tail -f "${files[@]}"
            ;;
        0|"") return ;;
        *) warn "Invalid choice."; sleep 1 ;;
    esac
}

# ── Update ────────────────────────────────────────────────────────────────────

grinscan_update() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── GrinScan: Update ──${RESET}\n"

    local net_choice; net_choice=$(_grinscan_pick_net) || return
    local nets; IFS=',' read -ra nets <<< "$net_choice"

    info "Updating npm packages…"
    npm install --prefix "$GRINSCAN_WEB" --omit=dev --silent \
        && success "npm packages updated." \
        || warn "npm install reported errors."

    for net in "${nets[@]}"; do
        local net_short; net_short=$( [[ "$net" == "testnet" ]] && echo "test" || echo "main" )
        local svc="grinscan-${net_short}"
        local svc_port; svc_port=$( [[ "$net" == "testnet" ]] && echo $GRINSCAN_TEST_PORT || echo $GRINSCAN_MAIN_PORT )

        systemctl restart "$svc" 2>/dev/null \
            && success "${svc} restarted." \
            || warn "Failed to restart ${svc}."

        sleep 3
        if ss -tlnp 2>/dev/null | grep -q ":${svc_port} "; then
            success "Port :${svc_port} is listening."
        else
            warn "Port :${svc_port} not listening after restart."
        fi
    done

    local ver; ver=$(node -e "console.log(require('${GRINSCAN_WEB}/package.json').version)" 2>/dev/null || echo "unknown")
    success "GrinScan v${ver}"
    grinscan_status
}

# ── Setup Nginx ───────────────────────────────────────────────────────────────

grinscan_setup_nginx() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── GrinScan: Setup Nginx ──${RESET}\n"

    command -v nginx   &>/dev/null || { die "Nginx not installed. Run option N first."; return; }
    command -v certbot &>/dev/null || apt-get install -y certbot python3-certbot-nginx -qq

    echo -e "  ${GREEN}1${RESET}) Testnet  (port ${GRINSCAN_TEST_PORT})"
    echo -e "  ${GREEN}2${RESET}) Mainnet  (port ${GRINSCAN_MAIN_PORT})"
    echo -e "  ${DIM}0) Cancel${RESET}"
    echo ""
    echo -ne "${BOLD}Select [1/2/0]: ${RESET}"
    read -r net_sel

    local net net_short svc_port nginx_conf
    case "$net_sel" in
        1) net="testnet"; net_short="test"; svc_port=$GRINSCAN_TEST_PORT; nginx_conf="$NGINX_GRINSCAN_TEST_CONF" ;;
        2) net="mainnet"; net_short="main"; svc_port=$GRINSCAN_MAIN_PORT; nginx_conf="$NGINX_GRINSCAN_MAIN_CONF" ;;
        0|"") return ;;
        *) warn "Invalid choice."; sleep 1; return ;;
    esac

    local domain_eg; [[ "$net" == "testnet" ]] && domain_eg="test.yourdomain.com" || domain_eg="scan.yourdomain.com"
    echo -ne "  Domain (e.g. ${domain_eg}): "
    read -r domain
    [[ -z "$domain" ]] && { warn "Domain required."; pause; return; }

    echo -ne "  Email for SSL certificate (Let's Encrypt): "
    read -r ssl_email
    [[ -z "$ssl_email" ]] && { warn "Email required."; pause; return; }

    # Ensure rate-limit snippet exists — skip if zone already defined (e.g. by script 04)
    local rate_conf="/etc/nginx/conf.d/grinscan-rate-limit.conf"
    local api_snippet="/etc/nginx/snippets/grin-api.conf"
    if [[ ! -f "$rate_conf" ]]; then
        mkdir -p /etc/nginx/conf.d
        cat > "$rate_conf" <<'RATELIMIT'
limit_req_zone $binary_remote_addr zone=grinscan_api:10m rate=30r/m;
RATELIMIT
    fi
    if [[ ! -f "$api_snippet" ]]; then
        mkdir -p /etc/nginx/snippets
        cat > "$api_snippet" <<'SNIPPET'
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
add_header Cache-Control "no-store";
SNIPPET
    fi

    info "Writing nginx config for ${domain}…"
    cat > "$nginx_conf" <<NGINX
server {
    listen 80;
    server_name ${domain};

    location /rest/ {
        include snippets/grin-api.conf;
        limit_req zone=grinscan_api burst=20 nodelay;
        proxy_pass http://127.0.0.1:${svc_port};
    }

    location / {
        include snippets/grin-api.conf;
        proxy_pass http://127.0.0.1:${svc_port};
    }
}
NGINX

    ln -sf "$nginx_conf" /etc/nginx/sites-enabled/$(basename "$nginx_conf") 2>/dev/null || true
    nginx -t 2>&1 | while IFS= read -r line; do echo "  $line"; done \
        || { die "nginx config test failed."; return; }

    systemctl reload nginx || true
    success "Nginx config applied."

    info "Requesting SSL certificate from Let's Encrypt…"
    certbot --nginx -d "$domain" \
        --non-interactive --agree-tos --email "$ssl_email" \
        --redirect \
        && success "SSL certificate issued for ${domain}." \
        || warn "Certbot failed — check connectivity and DNS."

    # Logrotate
    cat > "/etc/logrotate.d/grinscan-${net_short}" <<LOGROTATE
${GRINSCAN_DIR}/${net_short}/grinscan-${net_short}.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
    copytruncate
}
LOGROTATE

    success "Nginx + SSL setup complete."
    echo -e "  URL: ${CYAN}https://${domain}${RESET}"
    log "grinscan_setup_nginx: ${net} → ${domain}"
    pause
}

# ── Auto-Start on Boot ────────────────────────────────────────────────────────

grinscan_autostart() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── GrinScan: Auto-Start on Boot ──${RESET}\n"

    local net_choice; net_choice=$(_grinscan_pick_net) || return
    local nets; IFS=',' read -ra nets <<< "$net_choice"

    for net in "${nets[@]}"; do
        local net_short; net_short=$( [[ "$net" == "testnet" ]] && echo "test" || echo "main" )
        local svc="grinscan-${net_short}"
        systemctl enable "$svc" 2>/dev/null \
            && success "${svc} enabled for auto-start." \
            || warn "Failed to enable ${svc}."
        log "grinscan_autostart: ${svc}"
    done
    pause
}

# ── Internal helper: pick network ─────────────────────────────────────────────

_grinscan_pick_net() {
    echo -e "  ${GREEN}1${RESET}) Testnet"  >/dev/tty
    echo -e "  ${GREEN}2${RESET}) Mainnet"  >/dev/tty
    echo -e "  ${GREEN}3${RESET}) Both"     >/dev/tty
    echo -e "  ${DIM}0) Cancel${RESET}"     >/dev/tty
    echo ""                                 >/dev/tty
    echo -ne "${BOLD}Select [1/2/3/0]: ${RESET}" >/dev/tty
    local c; read -r c </dev/tty
    case "$c" in
        1) echo "testnet"          ;;
        2) echo "mainnet"          ;;
        3) echo "testnet,mainnet"  ;;
        0|"") return 1             ;;
        *) warn "Invalid choice."; sleep 1; return 1 ;;
    esac
}
