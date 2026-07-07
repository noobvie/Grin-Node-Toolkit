# 06d_tiny_explorer.sh — Tiny Explorer: stateless, mainnet-only Grin block
# explorer for pool deep-links (e.g. scan.grin.money/block/<height>).
# Sourced by 06_global_grin_health.sh — inherits colors, log(), info(),
# success(), warn(), error(), die(), pause(), require_root().
#
# Model: web/06d_tiny_explorer/ (Node.js/Express, no DB). Single mainnet service
# grin-tiny-explorer. Secrets resolved live via grin_node_secrets.sh.

# ── Paths ─────────────────────────────────────────────────────────────────────

TINYX_DIR="/opt/grin/tiny-explorer"
TINYX_WEB="${TOOLKIT_ROOT}/web/06d_tiny_explorer"
TINYX_APP="${TINYX_DIR}/app"
TINYX_CONFIG="${TINYX_DIR}/config.json"
TINYX_LOG="${TINYX_DIR}/tiny-explorer.log"
TINYX_SVC="grin-tiny-explorer"
NGINX_TINYX_CONF="/etc/nginx/sites-available/tiny-explorer"
TINYX_PORT=8471

# ── Install ───────────────────────────────────────────────────────────────────

tinyx_install() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── Tiny Explorer: Install ──${RESET}\n"

    echo -e "  ${DIM}Stateless mainnet block explorer — no SQLite, no crawler.${RESET}"
    echo -e "  ${DIM}Best served by an ARCHIVE node so old permalinks resolve.${RESET}\n"

    # Archive pre-flight (informational — Tiny Explorer still runs on a pruned node,
    # but old /block/<height> links below the pruning horizon will 404).
    if [[ -d /opt/grin/node/mainnet-full ]] && \
       grep -qs "^archive_mode *= *true" /opt/grin/node/mainnet-full/grin-server.toml 2>/dev/null; then
        success "Archive node detected at /opt/grin/node/mainnet-full ✓"
    else
        warn "Archive node not confirmed — old block permalinks may return 404."
        echo -e "  ${DIM}For full history: Script 01 → Setup Grin New Node → Archive mode.${RESET}"
        echo -ne "  Continue anyway? [Y/n]: "; read -r c
        [[ "${c,,}" == "n" ]] && { info "Cancelled."; pause; return; }
    fi

    # Node.js (>= 18 is plenty — no node:sqlite needed here).
    local node_major=0
    if command -v node &>/dev/null; then
        node_major=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
    fi
    if [[ "${node_major:-0}" -ge 18 ]]; then
        success "Node.js $(node --version) ✓"
    else
        info "Installing Node.js 20.x via NodeSource…"
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash - || { die "NodeSource setup failed."; return; }
        apt-get install -y nodejs -qq || { die "Node.js install failed."; return; }
        success "Node.js installed: $(node --version)"
    fi

    info "Deploying app to ${TINYX_APP}…"
    mkdir -p "${TINYX_APP}"
    cp -r "${TINYX_WEB}/." "${TINYX_APP}/"

    info "Installing npm dependencies…"
    npm install --prefix "${TINYX_APP}" --omit=dev --silent || { die "npm install failed."; return; }
    success "npm packages installed."

    chown -R www-data:www-data "${TINYX_DIR}"

    cat > "/etc/systemd/system/${TINYX_SVC}.service" <<UNIT
[Unit]
Description=Grin Tiny Explorer (mainnet block explorer)
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=${TINYX_APP}
ExecStart=/usr/bin/node ${TINYX_APP}/tiny-explorer-server.js
Environment=TINY_EXPLORER_CONFIG=${TINYX_CONFIG}
Restart=on-failure
RestartSec=10
StandardOutput=append:${TINYX_LOG}
StandardError=append:${TINYX_LOG}

[Install]
WantedBy=multi-user.target
UNIT

    systemctl daemon-reload
    success "Tiny Explorer installed."
    echo -e "  Next: run ${BOLD}Configure (2)${RESET} to write config.json."
    log "tinyx_install complete"
    pause
}

# ── Configure ─────────────────────────────────────────────────────────────────

tinyx_configure() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── Tiny Explorer: Configure ──${RESET}\n"

    # Resolve the LIVE mainnet node dir + secrets via the shared helper.
    local node_dir foreign_secret_path owner_secret_path
    if declare -F grin_live_node_dir &>/dev/null; then
        node_dir=$(grin_live_node_dir mainnet 2>/dev/null || true)
        foreign_secret_path=$(grin_node_secret_path mainnet foreign 2>/dev/null || true)
        owner_secret_path=$(grin_node_secret_path mainnet owner 2>/dev/null || true)
    fi
    [[ -z "$node_dir" ]] && { node_dir="/opt/grin/node/mainnet-prune"; [[ -d /opt/grin/node/mainnet-full ]] && node_dir="/opt/grin/node/mainnet-full"; }
    [[ -z "$foreign_secret_path" ]] && foreign_secret_path="${node_dir}/.foreign_api_secret"
    [[ -z "$owner_secret_path"   ]] && owner_secret_path="${node_dir}/.api_secret"

    local node_url="http://127.0.0.1:3413/v2/foreign"
    local owner_url="http://127.0.0.1:3413/v2/owner"

    echo -e "  ${DIM}Live mainnet node: ${node_dir}${RESET}"
    echo -ne "  Node Foreign URL [${node_url}]: "; read -r u; [[ -n "$u" ]] && node_url="$u"

    # Connectivity pre-check
    info "Testing node connection…"
    if ! ss -tlnp 2>/dev/null | grep -q ":3413 "; then
        warn "Mainnet node API :3413 not listening — is the node running?"
        echo -ne "  Continue anyway? [Y/n]: "; read -r c; [[ "${c,,}" == "n" ]] && { info "Cancelled."; pause; return; }
    elif [[ -f "$owner_secret_path" ]]; then
        local secret resp
        secret=$(tr -d '[:space:]' < "$owner_secret_path" 2>/dev/null || true)
        resp=$(curl -s --max-time 5 -u "grin:${secret}" -H 'Content-Type: application/json' \
            -d '{"jsonrpc":"2.0","method":"get_status","params":[],"id":1}' "$owner_url" 2>/dev/null || true)
        echo "$resp" | grep -q '"sync_status"' && success "Node reachable ✓" || warn "Node not reachable at ${owner_url}"
    fi

    # Domain (prompted, never hardcoded; example only)
    echo ""
    echo -ne "  Public domain (e.g. scan.grin.money): "; read -r domain
    [[ -z "$domain" ]] && { warn "Domain required."; pause; return; }
    if [[ ! "$domain" =~ ^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$ ]]; then
        warn "Invalid domain '${domain}'."; pause; return
    fi
    local base_url="https://${domain}"

    # Optional custom slogan (a good default is baked into the pages)
    echo -ne "  Slogan under the logo (blank = keep default): "; read -r slogan

    # GA4 (optional). Sample id shown per operator request.
    local ga4_id=""
    echo -ne "  GA4 Measurement ID (blank to disable, e.g. G-05D6ERFRVW): "; read -r ga4_input
    if [[ -n "$ga4_input" ]]; then
        if [[ "$ga4_input" =~ ^G- ]]; then ga4_id="$ga4_input"; else warn "GA4 ID must start with 'G-' — analytics disabled."; fi
    fi

    # world.grin.money stats source for the "Node peers · 30d" card
    local peers_stats_url="https://world.grin.money"
    echo -ne "  Peers-stats source URL [${peers_stats_url}]: "; read -r p; [[ -n "$p" ]] && peers_stats_url="${p%/}"

    mkdir -p "${TINYX_DIR}"

    # Copy node secrets into the app data dir (www-data-owned, 600) — same model
    # as GrinScan so www-data need not join the grin group.
    local tx_foreign="${TINYX_DIR}/.foreign_api_secret"
    local tx_owner="${TINYX_DIR}/.api_secret"
    if [[ -f "$foreign_secret_path" ]]; then cp "$foreign_secret_path" "$tx_foreign"; chown www-data:www-data "$tx_foreign"; chmod 600 "$tx_foreign"; else warn "Foreign secret not found at ${foreign_secret_path}."; fi
    if [[ -f "$owner_secret_path"   ]]; then cp "$owner_secret_path"   "$tx_owner";   chown www-data:www-data "$tx_owner";   chmod 600 "$tx_owner";   else warn "Owner secret not found at ${owner_secret_path}.";   fi

    # Build the fallback_explorers array + optional slogan line via a heredoc.
    cat > "$TINYX_CONFIG" <<JSON
{
  "network":             "mainnet",
  "node_url":            "${node_url}",
  "node_owner_url":      "${owner_url}",
  "foreign_secret_path": "${tx_foreign}",
  "owner_secret_path":   "${tx_owner}",
  "port":                ${TINYX_PORT},
  "web_dir":             "${TINYX_APP}/public",
  "domain":              "${domain}",
  "base_url":            "${base_url}",
  "slogan":              "${slogan}",
  "block_cache_ms":      45000,
  "tip_cache_ms":        30000,
  "price_cache_ms":      120000,
  "peers_cache_ms":      3600000,
  "latest_count":        20,
  "peers_stats_url":     "${peers_stats_url}",
  "ga4_measurement_id":  "${ga4_id}",
  "fallback_explorers": [
    { "name": "Grincoin.org", "url": "https://grincoin.org", "blurb": "Full archive explorer — deep block bodies since genesis." },
    { "name": "GrinScan",     "url": "https://grinscan.net", "blurb": "Dual-network explorer with charts, peers, price, and a REST API." }
  ]
}
JSON

    # A blank slogan is left as "" in the config — the server treats it as falsy
    # and falls back to its baked default (no fragile post-edit needed).

    chown www-data:www-data "$TINYX_CONFIG"
    chown -R www-data:www-data "${TINYX_DIR}"
    success "Config written: ${TINYX_CONFIG}"

    # Register with the shared secret self-heal so a node rebuild re-copies secrets
    # and restarts grin-tiny-explorer (grin_sync_tiny_explorer in grin_node_secrets.sh).
    if declare -F grin_install_secret_sync &>/dev/null; then grin_install_secret_sync || true; fi

    echo ""
    echo -e "  Next: ${BOLD}Service Control (3) → Start${RESET}, then ${BOLD}Setup Nginx (4)${RESET}."
    log "tinyx_configure: ${domain} → ${TINYX_CONFIG}"
    pause
}

# ── Service Control ───────────────────────────────────────────────────────────

tinyx_service_control() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── Tiny Explorer: Service Control ──${RESET}\n"
    echo -e "  ${GREEN}S${RESET}) Start   ${GREEN}T${RESET}) Stop   ${RED}R${RESET}) Remove service   ${DIM}0) Cancel${RESET}"
    echo -ne "\n${BOLD}Action [S/T/R/0]: ${RESET}"; read -r action

    case "${action^^}" in
        S)
            [[ -f "$TINYX_CONFIG" ]] || { warn "Config not found. Run Configure (2) first."; pause; return; }
            systemctl start "$TINYX_SVC" 2>/dev/null && success "${TINYX_SVC} started." || { error "Failed to start ${TINYX_SVC}."; pause; return; }
            local waited=0
            while [[ $waited -lt 10 ]]; do
                sleep 2; waited=$((waited+2))
                if ss -tlnp 2>/dev/null | grep -q ":${TINYX_PORT} "; then
                    success "Port :${TINYX_PORT} is listening."
                    echo -e "  Local URL: ${CYAN}http://127.0.0.1:${TINYX_PORT}${RESET}"
                    break
                fi
            done
            ss -tlnp 2>/dev/null | grep -q ":${TINYX_PORT} " || warn "Port :${TINYX_PORT} not listening yet — check: journalctl -u ${TINYX_SVC} -n 20"
            ;;
        T)
            systemctl stop "$TINYX_SVC" 2>/dev/null && success "${TINYX_SVC} stopped." || warn "${TINYX_SVC} was not running."
            ;;
        R)
            systemctl stop "$TINYX_SVC" 2>/dev/null || true
            systemctl disable "$TINYX_SVC" 2>/dev/null || true
            rm -f "/etc/systemd/system/${TINYX_SVC}.service"
            systemctl daemon-reload
            success "${TINYX_SVC} removed."
            ;;
        0|"") return ;;
        *) warn "Invalid action."; sleep 1 ;;
    esac
    log "tinyx_service_control: ${action}"
    pause
}

# ── Setup Nginx ───────────────────────────────────────────────────────────────

tinyx_setup_nginx() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── Tiny Explorer: Setup Nginx ──${RESET}\n"

    command -v nginx   &>/dev/null || { die "Nginx not installed. Run option N first."; return; }
    command -v certbot &>/dev/null || apt-get install -y certbot python3-certbot-nginx -qq

    local domain=""
    [[ -f "$TINYX_CONFIG" ]] && domain=$(grep -oE '"domain":[[:space:]]*"[^"]*"' "$TINYX_CONFIG" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
    echo -ne "  Public domain (e.g. scan.grin.money)${domain:+ [${domain}]}: "; read -r d
    [[ -n "$d" ]] && domain="$d"
    [[ -z "$domain" ]] && { warn "Domain required."; pause; return; }
    if [[ ! "$domain" =~ ^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$ ]]; then warn "Invalid domain."; pause; return; fi

    echo -e "  ${YELLOW}Note:${RESET} pointing this domain here ${BOLD}repoints it from option C (grincoin clone) to D${RESET} if C used it."

    local ssl_email=""
    if ! certbot accounts list 2>/dev/null | grep -q "Account ID"; then
        echo -ne "  Email for SSL certificate (Let's Encrypt): "; read -r ssl_email
        [[ -z "$ssl_email" ]] && { warn "Email required for first certbot run."; pause; return; }
    fi

    # Unique rate-limit zone (never reuse grinscan_api) — via shared helper w/ fallback.
    if declare -F nginx_ensure_rate_limit_zone &>/dev/null; then
        nginx_ensure_rate_limit_zone "tinyx_api" "30r/m" "10m" "script06d-rate-limit"
    else
        local rate_conf="/etc/nginx/conf.d/script06d-rate-limit.conf"
        if [[ ! -f "$rate_conf" ]]; then
            mkdir -p /etc/nginx/conf.d
            echo 'limit_req_zone $binary_remote_addr zone=tinyx_api:10m rate=30r/m;' > "$rate_conf"
        fi
    fi

    info "Writing nginx config for ${domain}…"
    # proxy_pass ALL paths (crucially /block/<height>) to the Node app — no static
    # rule may intercept the pool deep-link path.
    cat > "$NGINX_TINYX_CONF" <<NGINX
server {
    listen 80;
    server_name ${domain};

    location /api/ {
        limit_req zone=tinyx_api burst=20 nodelay;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_pass http://127.0.0.1:${TINYX_PORT};
    }

    location / {
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_pass http://127.0.0.1:${TINYX_PORT};
    }
}
NGINX

    ln -sf "$NGINX_TINYX_CONF" "/etc/nginx/sites-enabled/$(basename "$NGINX_TINYX_CONF")" 2>/dev/null || true
    nginx -t 2>&1 | while IFS= read -r line; do echo "  $line"; done || { die "nginx config test failed."; return; }
    systemctl reload nginx || true
    success "Nginx config applied."

    info "Requesting SSL certificate from Let's Encrypt…"
    local certbot_email_args=(); [[ -n "$ssl_email" ]] && certbot_email_args=(--email "$ssl_email")
    certbot --nginx -d "$domain" --non-interactive --agree-tos "${certbot_email_args[@]}" --redirect \
        && success "SSL certificate issued for ${domain}." \
        || warn "Certbot failed — check DNS/connectivity."

    cat > "/etc/logrotate.d/tiny-explorer" <<LOGROTATE
${TINYX_LOG} {
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
    echo -e "  Deep-link test: ${CYAN}https://${domain}/block/<height>${RESET}"
    log "tinyx_setup_nginx: ${domain}"
    pause
}

# ── Auto-Start ────────────────────────────────────────────────────────────────

tinyx_autostart() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── Tiny Explorer: Auto-Start on Boot ──${RESET}\n"
    systemctl enable "$TINYX_SVC" 2>/dev/null && success "${TINYX_SVC} enabled for auto-start." || warn "Failed to enable ${TINYX_SVC}."
    log "tinyx_autostart"
    pause
}

# ── Status ────────────────────────────────────────────────────────────────────

tinyx_status() {
    clear
    echo -e "\n${BOLD}${CYAN}── Tiny Explorer: Status ──${RESET}\n"

    local active; active=$(systemctl is-active "$TINYX_SVC" 2>/dev/null || echo inactive)
    [[ "$active" == active ]] && echo -e "  Service:  ${GREEN}● running${RESET}" || echo -e "  Service:  ${RED}○ ${active}${RESET}"
    ss -tlnp 2>/dev/null | grep -q ":${TINYX_PORT} " && echo -e "  Port :${TINYX_PORT}: ${GREEN}listening${RESET}" || echo -e "  Port :${TINYX_PORT}: ${YELLOW}not listening${RESET}"
    [[ -f "$TINYX_CONFIG" ]] && echo -e "  Config:   ${GREEN}✓ ${TINYX_CONFIG}${RESET}" || echo -e "  Config:   ${RED}✗ not found${RESET}"

    if [[ -f "$NGINX_TINYX_CONF" ]]; then
        local domain; domain=$(grep -E "^\s+server_name " "$NGINX_TINYX_CONF" | awk '{print $2}' | tr -d ';' | head -1)
        echo -e "  Nginx:    ${GREEN}✓ configured${RESET}  ${DIM}${domain}${RESET}"
        if [[ -n "$domain" ]] && certbot certificates 2>/dev/null | grep -q "$domain"; then
            echo -e "  SSL:      ${GREEN}✓ active${RESET}"
        else
            echo -e "  SSL:      ${YELLOW}not issued${RESET}"
        fi
    else
        echo -e "  Nginx:    ${YELLOW}not configured${RESET}"
    fi

    if [[ "$active" == active ]]; then
        local tip; tip=$(curl -s --max-time 4 "http://127.0.0.1:${TINYX_PORT}/api/tip" 2>/dev/null || true)
        [[ -n "$tip" ]] && echo -e "  Tip:      ${CYAN}${tip}${RESET}"
    fi
    echo ""
    pause
}

# ── Logs ──────────────────────────────────────────────────────────────────────

tinyx_logs() {
    clear
    echo -e "\n${BOLD}${CYAN}── Tiny Explorer: Logs ──${RESET}\n"
    if [[ ! -f "$TINYX_LOG" ]]; then warn "No log found: ${TINYX_LOG}"; pause; return; fi
    echo -e "  ${DIM}Log: ${TINYX_LOG}${RESET}\n"
    tail -n 50 "$TINYX_LOG"
    echo ""
    echo -ne "  ${GREEN}F${RESET}) Follow live   ${DIM}0) Back${RESET}  [F/0]: "; read -r fol
    [[ "${fol^^}" == "F" ]] && { echo -e "  ${DIM}Ctrl+C to stop.${RESET}"; tail -f "$TINYX_LOG" || true; }
}

# ── Update ────────────────────────────────────────────────────────────────────

tinyx_update() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── Tiny Explorer: Update ──${RESET}\n"
    [[ -d "$TINYX_APP" ]] || { warn "Not installed. Run Install (1) first."; pause; return; }

    info "Redeploying app files from toolkit…"
    cp -r "${TINYX_WEB}/." "${TINYX_APP}/"
    chown -R www-data:www-data "${TINYX_DIR}"
    success "App files redeployed."

    info "Updating npm dependencies…"
    npm install --prefix "${TINYX_APP}" --omit=dev --silent && success "npm packages updated." || warn "npm install reported errors."

    systemctl restart "$TINYX_SVC" 2>/dev/null && success "${TINYX_SVC} restarted." || warn "Failed to restart ${TINYX_SVC}."
    sleep 3
    ss -tlnp 2>/dev/null | grep -q ":${TINYX_PORT} " && success "Port :${TINYX_PORT} listening." || warn "Port :${TINYX_PORT} not listening after restart."
    log "tinyx_update"
    pause
}

# ── Nuke ──────────────────────────────────────────────────────────────────────

tinyx_nuke() {
    require_root
    clear
    echo -e "\n${BOLD}${RED}── Tiny Explorer: Nuke ──${RESET}\n"
    echo -e "  ${YELLOW}Stops + disables the service, removes the app dir, and removes ONLY${RESET}"
    echo -e "  ${YELLOW}Tiny Explorer's nginx vhost + its script06d-rate-limit.conf zone.${RESET}"
    echo -e "  ${DIM}Does NOT touch Node.js or the Grin node.${RESET}\n"
    echo -ne "  ${BOLD}${RED}Type 'nuke' to confirm: ${RESET}"; read -r confirm
    [[ "$confirm" != "nuke" ]] && { info "Cancelled — nothing removed."; sleep 1; return; }

    systemctl is-active  "$TINYX_SVC" &>/dev/null && systemctl stop    "$TINYX_SVC" 2>/dev/null && success "Stopped ${TINYX_SVC}"
    systemctl is-enabled "$TINYX_SVC" &>/dev/null && systemctl disable "$TINYX_SVC" 2>/dev/null || true
    [[ -f "/etc/systemd/system/${TINYX_SVC}.service" ]] && { rm -f "/etc/systemd/system/${TINYX_SVC}.service"; success "Removed systemd unit"; }
    systemctl daemon-reload

    [[ -d "$TINYX_DIR" ]] && { rm -rf "${TINYX_DIR:?}"; success "Removed ${TINYX_DIR}"; }

    local nginx_link="/etc/nginx/sites-enabled/$(basename "$NGINX_TINYX_CONF")"
    [[ -f "$NGINX_TINYX_CONF" ]] && { rm -f "$NGINX_TINYX_CONF"; success "Removed ${NGINX_TINYX_CONF}"; }
    [[ -L "$nginx_link" ]] && { rm -f "$nginx_link"; success "Removed ${nginx_link}"; }
    [[ -f /etc/nginx/conf.d/script06d-rate-limit.conf ]] && { rm -f /etc/nginx/conf.d/script06d-rate-limit.conf; success "Removed script06d-rate-limit.conf"; }
    [[ -f /etc/logrotate.d/tiny-explorer ]] && rm -f /etc/logrotate.d/tiny-explorer

    if command -v nginx &>/dev/null && systemctl is-active nginx &>/dev/null; then
        nginx -t &>/dev/null && systemctl reload nginx && success "Nginx reloaded." || warn "Nginx config test failed after nuke — reload manually."
    fi

    echo ""
    success "Nuke complete. Run Install (1) → Configure (2) to rebuild."
    log "tinyx_nuke"
    pause
}
