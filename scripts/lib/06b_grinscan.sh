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

    # ── Archive node pre-flight check ────────────────────────────────────────
    # GrinScan works on both pruned and archive nodes, but a pruned node can
    # only serve blocks within the pruning horizon (~last few weeks).
    # An archive node serves every block since genesis — including block 0.
    local instances_conf="/opt/grin/conf/grin_instances_location.conf"
    local mainnet_full_dir=""
    local mainnet_toml=""
    local has_full_dir=0
    local has_archive_flag=0

    # Primary check: FULLMAIN_GRIN_DIR written by script 01 into instances conf
    if [[ -f "$instances_conf" ]]; then
        mainnet_full_dir=$(bash -c "source '$instances_conf' 2>/dev/null; echo \"\${FULLMAIN_GRIN_DIR:-}\"")
    fi
    if [[ -n "$mainnet_full_dir" && -d "$mainnet_full_dir" ]]; then
        has_full_dir=1
        mainnet_toml="${mainnet_full_dir}/grin-server.toml"
        grep -qs "^archive_mode *= *true" "$mainnet_toml" 2>/dev/null && has_archive_flag=1
    fi

    if [[ $has_full_dir -eq 1 && $has_archive_flag -eq 1 ]]; then
        success "Archive node detected at ${mainnet_full_dir} ✓"
        echo -e "  ${DIM}GrinScan will be able to serve full block history since genesis.${RESET}"
    else
        echo -e "  ${YELLOW}${BOLD}⚠  Archive node not detected${RESET}"
        if [[ $has_full_dir -eq 0 ]]; then
            echo -e "  ${DIM}FULLMAIN_GRIN_DIR not set in ${instances_conf}${RESET}"
        fi
        if [[ $has_archive_flag -eq 0 && -n "$mainnet_toml" ]]; then
            echo -e "  ${DIM}archive_mode = true not set in ${mainnet_toml}${RESET}"
        fi
        echo ""
        echo -e "  ${DIM}GrinScan will still work, but on a ${BOLD}pruned node${RESET}${DIM} only blocks within the${RESET}"
        echo -e "  ${DIM}pruning horizon (~last few weeks) will be available. Old blocks —${RESET}"
        echo -e "  ${DIM}including the genesis block — will return \"not found\".${RESET}"
        echo ""
        echo -e "  ${DIM}To serve full history since genesis, exit and run:${RESET}"
        echo -e "    ${BOLD}Script 01 → Setup Grin New Node → choose Archive mode${RESET}"
        echo -e "  ${DIM}Then re-run GrinScan Install after the node has fully synced.${RESET}"
        echo ""
        echo -ne "  Continue installing on pruned node? [y/N]: "
        read -r cont
        [[ "${cont,,}" != "y" ]] && { info "Install cancelled."; pause; return; }
    fi
    echo ""

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

        # Sibling URL — the OTHER network's public URL for the network switcher
        local sib_label; sib_label=$( [[ "$net" == "testnet" ]] && echo "mainnet" || echo "testnet" )
        local sib_example; sib_example=$( [[ "$net" == "testnet" ]] && echo "https://grinscan.example.com" || echo "https://testgrinscan.example.com" )
        echo -ne "  ${sib_label^} sibling URL for network switcher (blank to skip, e.g. ${sib_example}): "
        read -r sib_input
        local sibling_url=""
        if [[ -n "$sib_input" ]]; then
            if [[ "$sib_input" =~ ^https?:// ]]; then
                sibling_url="${sib_input%/}"   # strip trailing slash
            else
                warn "Sibling URL must start with http:// or https:// — skipped."
            fi
        fi

        # Detect archive mode — primary: FULLMAIN_GRIN_DIR in instances conf,
        # secondary: archive_mode = true in grin-server.toml inside that dir.
        local archive_mode="false"
        local _inst_conf="/opt/grin/conf/grin_instances_location.conf"
        if [[ "$net" == "mainnet" && -f "$_inst_conf" ]]; then
            local _fulldir
            _fulldir=$(bash -c "source '$_inst_conf' 2>/dev/null; echo \"\${FULLMAIN_GRIN_DIR:-}\"")
            if [[ -n "$_fulldir" && -d "$_fulldir" ]] && \
               grep -qs "^archive_mode *= *true" "${_fulldir}/grin-server.toml" 2>/dev/null; then
                archive_mode="true"
                info "Archive node confirmed (${_fulldir}/grin-server.toml)"
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
  "history_days":        50,
  "backfill_history":    false,
  "web_dir":             "${GRINSCAN_APP}/public",
  "node_data_dir":       "${node_dir}/chain_data",
  "ga4_measurement_id":  "${ga4_id}",
  "sibling_url":         "${sibling_url}",
  "archive_mode":        ${archive_mode}
}
JSON

        chown www-data:www-data "$config_path"
        # Ensure the entire data dir is www-data-owned — a node rebuild (Script 01)
        # may have done chown -R grin:grin /opt/grin/ and overwritten our ownership.
        chown -R www-data:www-data "${GRINSCAN_DIR}/${net_short}"
        success "Config written: ${config_path}"

        # Create sample banners.json if it doesn't exist yet (active:false = no banner shown until edited)
        local banners_path="${GRINSCAN_DIR}/${net_short}/banners.json"
        if [[ ! -f "$banners_path" ]]; then
            cat > "$banners_path" <<'BANNERS'
[
  {
    "_comment": "Partner/sponsor banner config. Served at /api/partners — loaded by media.js. Fields: active (bool, omit = true), type ('image' or 'code'), src (image URL), href (link), alt (img alt text), weight (relative pick chance, default 1), html (raw embed for type:code). Place images in /opt/grin/grinscan/public/img/partners/. Restart not needed — file is re-read on each request (300s cache).",
    "active": false,
    "type":   "image",
    "src":    "/img/partners/example-728x90.png",
    "href":   "https://example.com",
    "alt":    "Example sponsor",
    "weight": 1
  }
]
BANNERS
            chown www-data:www-data "$banners_path"
            echo ""
            echo -e "  ${CYAN}Partner banner config created:${RESET}"
            echo -e "    ${BOLD}${banners_path}${RESET}"
            echo -e "  ${DIM}Banners are injected directly into page HTML — no public API endpoint.${RESET}"
            echo -e "  ${DIM}Set ${BOLD}\"active\": true${RESET}${DIM} and fill in the fields to show a banner:${RESET}"
            echo -e "  ${DIM}  type    → \"image\"  requires: src, href, alt${RESET}"
            echo -e "  ${DIM}           \"code\"   requires: html (raw embed / ad-network script)${RESET}"
            echo -e "  ${DIM}  weight  → relative pick chance (2 = twice as likely as 1)${RESET}"
            echo -e "  ${DIM}  Images  → upload to ${GRINSCAN_APP}/public/img/partners/${RESET}"
            echo -e "  ${DIM}  No restart needed — server re-reads every 300 s automatically.${RESET}"
            echo -e "  To edit:  ${BOLD}nano ${banners_path}${RESET}"
            echo ""
        fi
        echo -e "  ${DIM}Note: SQLite DB is created automatically on first Start — no import step needed.${RESET}"
        echo -e "  ${DIM}Lazy mode (default): GrinScan does NOT bulk-crawl the chain. It caches recent${RESET}"
        echo -e "  ${DIM}blocks + fills forward from the tip; old blocks are read live from an archive${RESET}"
        echo -e "  ${DIM}node on demand. This avoids the heavy genesis backfill / get_block timeouts.${RESET}"
        echo -e "  ${DIM}To pre-warm charts with history, set ${BOLD}\"backfill_history\": true${RESET}${DIM} in ${config_path} and restart.${RESET}"
        log "grinscan_configure: ${net} → ${config_path}"
    done

    # Install the shared secret self-heal timer so the copied secrets are
    # auto-refreshed after a future node rebuild (grin_grinscan_sync re-copies +
    # restarts grinscan-{main,test} when the node's secret changes). Falls back to
    # the manual Configure re-run if the helper is unavailable.
    if declare -F grin_install_secret_sync >/dev/null 2>&1; then
        grin_install_secret_sync || true
    fi

    echo ""
    echo -e "  Next: run ${BOLD}Service Control (3)${RESET} to launch the service."
    echo ""
    if declare -F grin_install_secret_sync >/dev/null 2>&1; then
        echo -e "  ${DIM}Node secrets are auto-refreshed by grin-secret-sync.timer after a rebuild.${RESET}"
    else
        echo -e "  ${YELLOW}⚠  If you rebuild the node or reset its API secrets (Script 01),${RESET}"
        echo -e "  ${YELLOW}   re-run Configure (2) to refresh the secret copies in this dir.${RESET}"
    fi
    pause
}

# ── Service Control (Start / Stop / Remove) ───────────────────────────────────

grinscan_service_control() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── GrinScan: Service Control ──${RESET}\n"

    local net_choice; net_choice=$(_grinscan_pick_net) || return
    local nets; IFS=',' read -ra nets <<< "$net_choice"

    echo ""
    echo -e "  ${GREEN}S${RESET}) Start"
    echo -e "  ${GREEN}T${RESET}) Stop"
    echo -e "  ${RED}R${RESET}) Remove service"
    echo -e "  ${DIM}0) Cancel${RESET}"
    echo ""
    echo -ne "${BOLD}Action [S/T/R/0]: ${RESET}"
    read -r action

    case "${action^^}" in
        S)
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
                log "grinscan_service_control: start ${svc}"
            done
            ;;
        T)
            for net in "${nets[@]}"; do
                local net_short; net_short=$( [[ "$net" == "testnet" ]] && echo "test" || echo "main" )
                local svc="grinscan-${net_short}"
                systemctl stop "$svc" 2>/dev/null \
                    && success "${svc} stopped." \
                    || warn "${svc} was not running."
                log "grinscan_service_control: stop ${svc}"
            done
            ;;
        R)
            for net in "${nets[@]}"; do
                local net_short; net_short=$( [[ "$net" == "testnet" ]] && echo "test" || echo "main" )
                local svc="grinscan-${net_short}"
                local unit_file="/etc/systemd/system/${svc}.service"
                systemctl stop "$svc" 2>/dev/null || true
                systemctl disable "$svc" 2>/dev/null || true
                [[ -f "$unit_file" ]] && rm -f "$unit_file"
                systemctl daemon-reload
                success "${svc} removed."
                echo -ne "  Also delete DB and config for ${net}? [y/N]: "
                read -r del_data
                if [[ "${del_data,,}" == "y" ]]; then
                    rm -rf "${GRINSCAN_DIR}/${net_short}"
                    success "Data deleted for ${net}."
                fi
                log "grinscan_service_control: remove ${svc}"
            done
            ;;
        0|"") return ;;
        *) warn "Invalid action."; sleep 1 ;;
    esac
    pause
}

# ── Start (kept for internal use) ─────────────────────────────────────────────

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

_grinscan_show_log() {
    local log_file="$1"
    if [[ ! -f "$log_file" ]]; then warn "No log found: ${log_file}"; pause; return; fi
    echo -e "  ${DIM}Log: ${log_file}${RESET}"
    echo -e "  ${DIM}To tail manually: tail -f ${log_file}${RESET}\n"
    tail -n 50 "$log_file"
    echo ""
    echo -e "  ${GREEN}F${RESET}) Follow live   ${DIM}0) Back${RESET}"
    echo -ne "  ${BOLD}Select [F/0]: ${RESET}"
    read -r fol
    if [[ "${fol^^}" == "F" ]]; then
        echo -e "  ${DIM}Ctrl+C or close terminal to stop following.${RESET}"
        tail -f "$log_file" || true
    fi
}

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

    case "$choice" in
        1) _grinscan_show_log "$log_test" ;;
        2) _grinscan_show_log "$log_main" ;;
        3)
            echo -e "  ${DIM}Showing last 50 lines from each log.${RESET}\n"
            if [[ -f "$log_test" ]]; then
                echo -e "  ${BOLD}${CYAN}── Testnet ──${RESET}"
                echo -e "  ${DIM}${log_test}${RESET}\n"
                tail -n 50 "$log_test"
                echo ""
            fi
            if [[ -f "$log_main" ]]; then
                echo -e "  ${BOLD}${CYAN}── Mainnet ──${RESET}"
                echo -e "  ${DIM}${log_main}${RESET}\n"
                tail -n 50 "$log_main"
                echo ""
            fi
            if [[ ! -f "$log_test" ]] && [[ ! -f "$log_main" ]]; then
                warn "No log files found."; pause; return
            fi
            echo -e "  ${DIM}To follow live, select 1 or 2 individually.${RESET}"
            pause
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

    info "Redeploying app files from toolkit…"
    cp -r "${GRINSCAN_WEB}/." "${GRINSCAN_APP}/"
    chown -R www-data:www-data "${GRINSCAN_DIR}"
    success "App files redeployed."

    info "Updating npm dependencies…"
    npm install --prefix "${GRINSCAN_APP}" --omit=dev --silent \
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

    local ver; ver=$(node -e "console.log(require('${GRINSCAN_APP}/package.json').version)" 2>/dev/null || echo "unknown")
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
    echo -e "  ${GREEN}3${RESET}) Both"
    echo -e "  ${DIM}0) Cancel${RESET}"
    echo ""
    echo -ne "${BOLD}Select [1/2/3/0]: ${RESET}"
    read -r net_sel

    local selected_nets=()
    case "$net_sel" in
        1) selected_nets=("testnet") ;;
        2) selected_nets=("mainnet") ;;
        3) selected_nets=("testnet" "mainnet") ;;
        0|"") return ;;
        *) warn "Invalid choice."; sleep 1; return ;;
    esac

    # Determine SSL email once (skip if certbot account already exists)
    local ssl_email=""
    if ! certbot accounts list 2>/dev/null | grep -q "Account ID"; then
        echo -ne "  Email for SSL certificate (Let's Encrypt): "
        read -r ssl_email
        [[ -z "$ssl_email" ]] && { warn "Email required for first certbot run."; pause; return; }
    fi

    for net in "${selected_nets[@]}"; do
        local net_short svc_port nginx_conf
        case "$net" in
            testnet) net_short="test"; svc_port=$GRINSCAN_TEST_PORT; nginx_conf="$NGINX_GRINSCAN_TEST_CONF" ;;
            mainnet) net_short="main"; svc_port=$GRINSCAN_MAIN_PORT; nginx_conf="$NGINX_GRINSCAN_MAIN_CONF" ;;
        esac

    local domain_eg; [[ "$net" == "testnet" ]] && domain_eg="test.yourdomain.com" || domain_eg="scan.yourdomain.com"
    echo -ne "  Domain for ${net} (e.g. ${domain_eg}): "
    read -r domain
    [[ -z "$domain" ]] && { warn "Domain required for ${net}, skipping."; continue; }
    if [[ ! "$domain" =~ ^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$ ]]; then
        warn "Invalid domain '${domain}' — only letters, digits, dots, and hyphens allowed."; continue
    fi

    # Ensure rate-limit zone exists — via shared helper, with inline fallback
    # GrinScan uses its OWN proxy snippet (grinscan-proxy.conf), NOT the shared
    # grin-api.conf owned by Script 06 — keeping the two services decoupled so
    # neither install order nor teardown can clobber the other's nginx config.
    local proxy_snippet="/etc/nginx/snippets/grinscan-proxy.conf"
    if declare -F nginx_ensure_rate_limit_zone &>/dev/null; then
        nginx_ensure_rate_limit_zone "grinscan_api" "30r/m" "10m" "grinscan-rate-limit"
    else
        local rate_conf="/etc/nginx/conf.d/grinscan-rate-limit.conf"
        if [[ ! -f "$rate_conf" ]]; then
            mkdir -p /etc/nginx/conf.d
            cat > "$rate_conf" <<'RATELIMIT'
limit_req_zone $binary_remote_addr zone=grinscan_api:10m rate=30r/m;
RATELIMIT
        fi
    fi
    if [[ ! -f "$proxy_snippet" ]]; then
        mkdir -p /etc/nginx/snippets
        cat > "$proxy_snippet" <<'SNIPPET'
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
        include snippets/grinscan-proxy.conf;
        limit_req zone=grinscan_api burst=20 nodelay;
        proxy_pass http://127.0.0.1:${svc_port};
    }

    # SSE — must use HTTP/1.1, no buffering, long timeout; QUIC/HTTP3 incompatible
    location /events {
        proxy_pass http://127.0.0.1:${svc_port};
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        add_header X-Accel-Buffering no;
        add_header Cache-Control "no-store";
    }

    location / {
        include snippets/grinscan-proxy.conf;
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
    local certbot_email_args=()
    [[ -n "$ssl_email" ]] && certbot_email_args=(--email "$ssl_email")
    certbot --nginx -d "$domain" \
        --non-interactive --agree-tos "${certbot_email_args[@]}" \
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
    done
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

# ── Nuke ──────────────────────────────────────────────────────────────────────

grinscan_nuke() {
    require_root
    clear
    echo -e "\n${BOLD}${RED}── GrinScan: Nuke ──${RESET}\n"
    echo -e "  ${YELLOW}Destroys all GrinScan state for the selected network(s):${RESET}"
    echo -e "  ${DIM}  • Stops + disables systemd service(s)${RESET}"
    echo -e "  ${DIM}  • Deletes data dir (config, DB, logs, secrets)${RESET}"
    echo -e "  ${DIM}  • Removes systemd unit file(s)${RESET}"
    echo -e "  ${DIM}  • Removes Nginx vhost config(s) + enabled symlink(s)${RESET}"
    echo -e "  ${DIM}  • Does NOT touch Node.js or the Grin node itself${RESET}"
    echo ""
    echo -e "  ${BOLD}Which network?${RESET}"
    echo -e "  ${GREEN}1${RESET}) Testnet"
    echo -e "  ${GREEN}2${RESET}) Mainnet"
    echo -e "  ${GREEN}3${RESET}) Both (also removes shared nginx snippets + offers app dir removal)"
    echo -e "  ${DIM}0) Cancel${RESET}"
    echo ""
    echo -ne "${BOLD}Select [1/2/3/0]: ${RESET}"
    read -r net_choice

    local net_shorts=()
    local nuke_shared=0
    case "$net_choice" in
        1) net_shorts=("test") ;;
        2) net_shorts=("main") ;;
        3) net_shorts=("test" "main"); nuke_shared=1 ;;
        0|"") info "Cancelled."; return ;;
        *) warn "Invalid choice."; sleep 1; return ;;
    esac

    echo ""
    echo -ne "  ${BOLD}${RED}Type 'nuke' to confirm: ${RESET}"
    read -r confirm
    [[ "$confirm" != "nuke" ]] && { info "Cancelled — nothing removed."; sleep 1; return; }
    echo ""

    for net_short in "${net_shorts[@]}"; do
        local svc="grinscan-${net_short}"
        local net_dir="${GRINSCAN_DIR}/${net_short}"
        local unit="/etc/systemd/system/${svc}.service"
        local nginx_conf; nginx_conf=$( [[ "$net_short" == "test" ]] && echo "$NGINX_GRINSCAN_TEST_CONF" || echo "$NGINX_GRINSCAN_MAIN_CONF" )
        local nginx_link="/etc/nginx/sites-enabled/$(basename "$nginx_conf")"

        info "Nuking ${net_short}…"

        # Stop + disable service
        systemctl is-active  "$svc" &>/dev/null && systemctl stop    "$svc" 2>/dev/null && success "  Stopped ${svc}"
        systemctl is-enabled "$svc" &>/dev/null && systemctl disable  "$svc" 2>/dev/null || true

        # Systemd unit
        if [[ -f "$unit" ]]; then rm -f "$unit"; success "  Removed ${unit}"; fi

        # Data directory (config, DB, logs, secrets)
        if [[ -d "$net_dir" ]]; then rm -rf "${net_dir:?}"; success "  Removed ${net_dir}"; fi

        # Nginx vhost + symlink
        if [[ -f "$nginx_conf" ]]; then rm -f "$nginx_conf"; success "  Removed ${nginx_conf}"; fi
        if [[ -L "$nginx_link" ]]; then rm -f "$nginx_link"; success "  Removed ${nginx_link}"; fi
    done

    systemctl daemon-reload

    # Shared files — only when nuking both networks
    if [[ $nuke_shared -eq 1 ]]; then
        # Remove GrinScan's OWN nginx files only: the grinscan_api rate-limit zone
        # conf and the grinscan-proxy.conf snippet.
        # Do NOT touch /etc/nginx/snippets/grin-api.conf — that snippet is created
        # and OWNED by Script 06 (the world.grin.money stats vhost includes it).
        # Deleting it here used to break Script 06's vhost (nginx [emerg] open()
        # grin-api.conf failed → nginx won't start → site down).
        local rate_conf="/etc/nginx/conf.d/grinscan-rate-limit.conf"
        local proxy_snippet="/etc/nginx/snippets/grinscan-proxy.conf"
        [[ -f "$rate_conf"     ]] && rm -f "$rate_conf"     && success "Removed ${rate_conf}"
        [[ -f "$proxy_snippet" ]] && rm -f "$proxy_snippet" && success "Removed ${proxy_snippet}"

        # Offer to remove the deployed app dir (node_modules etc.)
        if [[ -d "${GRINSCAN_APP}" ]]; then
            echo ""
            echo -ne "  Also remove deployed app dir (${GRINSCAN_APP})? [y/N]: "
            read -r rm_app
            if [[ "${rm_app,,}" == "y" ]]; then
                rm -rf "${GRINSCAN_APP:?}"
                success "Removed ${GRINSCAN_APP}"
                # Clean up parent dir if now empty
                rmdir "${GRINSCAN_DIR}" 2>/dev/null || true
            fi
        fi
    fi

    # Reload nginx if running and config is still valid
    if command -v nginx &>/dev/null && systemctl is-active nginx &>/dev/null; then
        nginx -t &>/dev/null && systemctl reload nginx && success "Nginx reloaded." || \
            warn "Nginx config test failed after nuke — reload manually."
    fi

    echo ""
    success "Nuke complete. Run Install (1) → Configure (2) to rebuild."
    log "grinscan_nuke: nets=${net_shorts[*]}"
    pause
}

# ── Backup / Restore DB ───────────────────────────────────────────────────────
# The SQLite DB (blocks + prices history) is the only piece of GrinScan state
# that is expensive to recreate — the server rebuilds it by crawling the node
# from genesis/horizon, which is slow and node-heavy. Backing it up lets an
# operator move GrinScan to a new server WITHOUT re-crawling: install +
# configure on the new box, copy the backup over, restore, start.

GRINSCAN_BACKUP_DIR="${GRINSCAN_DIR}/backups"

# Ensure the sqlite3 CLI exists (used for consistent online snapshots).
_grinscan_ensure_sqlite3() {
    command -v sqlite3 &>/dev/null && return 0
    info "Installing sqlite3 CLI…"
    if command -v apt-get &>/dev/null; then
        apt-get install -y sqlite3 -qq 2>/dev/null || true
    elif command -v dnf &>/dev/null; then
        dnf install -y sqlite3 2>/dev/null || true
    fi
    command -v sqlite3 &>/dev/null
}

grinscan_backup() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── GrinScan: Backup DB ──${RESET}\n"
    echo -e "  ${DIM}Creates a consistent, compressed snapshot of the SQLite DB so a new${RESET}"
    echo -e "  ${DIM}server never has to re-crawl the chain. Safe to run while running.${RESET}\n"

    _grinscan_ensure_sqlite3 || { die "sqlite3 CLI not available — cannot snapshot."; pause; return; }

    local net_choice; net_choice=$(_grinscan_pick_net) || return
    local nets; IFS=',' read -ra nets <<< "$net_choice"

    mkdir -p "$GRINSCAN_BACKUP_DIR"
    local stamp; stamp=$(date +%Y%m%d_%H%M%S)
    local made_any=0

    for net in "${nets[@]}"; do
        local net_short; net_short=$( [[ "$net" == "testnet" ]] && echo "test" || echo "main" )
        local db_path="${GRINSCAN_DIR}/${net_short}/grinscan.db"

        echo ""
        echo -e "  ${BOLD}${CYAN}${net^^}${RESET}"
        if [[ ! -f "$db_path" ]]; then
            warn "  No DB found at ${db_path} — has the service run yet? Skipping."
            continue
        fi

        local out="${GRINSCAN_BACKUP_DIR}/grinscan-${net_short}-${stamp}.db"
        info "  Snapshotting ${db_path}…"
        if ! timeout 120 sqlite3 "$db_path" ".backup '${out}'" 2>/dev/null || [[ ! -s "$out" ]]; then
            # Fallback: checkpoint WAL into the main file, then plain copy
            timeout 15 sqlite3 "$db_path" "PRAGMA wal_checkpoint(FULL);" &>/dev/null || true
            cp -a "$db_path" "$out" 2>/dev/null || { error "  Snapshot failed for ${net}."; rm -f "$out"; continue; }
            warn "  Used live copy (sqlite .backup unavailable)."
        fi

        # Integrity check before we trust it
        local integ; integ=$(sqlite3 "$out" "PRAGMA integrity_check;" 2>/dev/null | head -1)
        if [[ "$integ" != "ok" ]]; then
            error "  Integrity check FAILED (${integ:-no output}) — discarding snapshot."
            rm -f "$out"
            continue
        fi

        local blocks max_h
        blocks=$(sqlite3 "$out" "SELECT COUNT(*) FROM blocks;"   2>/dev/null || echo "?")
        max_h=$( sqlite3 "$out" "SELECT MAX(height) FROM blocks;" 2>/dev/null || echo "?")

        gzip -f "$out"
        local gz="${out}.gz"
        chown www-data:www-data "$gz" 2>/dev/null || true
        local size; size=$(du -h "$gz" 2>/dev/null | cut -f1)

        success "  Backup OK → ${gz}"
        echo -e "    ${DIM}blocks: ${blocks}   tip height: ${max_h}   size: ${size}${RESET}"
        made_any=1
        log "grinscan_backup: ${net} → ${gz} (blocks=${blocks}, tip=${max_h})"
    done

    if [[ $made_any -eq 1 ]]; then
        echo ""
        echo -e "  ${BOLD}To copy a backup off this server (run on your LOCAL machine):${RESET}"
        echo -e "    ${CYAN}scp root@$(hostname -I 2>/dev/null | awk '{print $1}'):${GRINSCAN_BACKUP_DIR}/grinscan-*.db.gz .${RESET}"
        echo ""
        echo -e "  ${DIM}Backups kept in: ${GRINSCAN_BACKUP_DIR}${RESET}"
    fi
    pause
}

grinscan_restore() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── GrinScan: Restore DB ──${RESET}\n"
    echo -e "  ${BOLD}Move GrinScan to a new server in 4 steps (no re-crawl):${RESET}"
    echo -e "    ${GREEN}1.${RESET} On the NEW server: run ${BOLD}Install (1)${RESET} then ${BOLD}Configure (2)${RESET}."
    echo -e "    ${GREEN}2.${RESET} Copy the backup over. From your LOCAL machine:"
    echo -e "       ${CYAN}scp grinscan-main-YYYYMMDD_HHMMSS.db.gz root@NEW_SERVER_IP:${GRINSCAN_BACKUP_DIR}/${RESET}"
    echo -e "       ${DIM}(mkdir -p ${GRINSCAN_BACKUP_DIR} on the new server first if scp says no such dir)${RESET}"
    echo -e "    ${GREEN}3.${RESET} Run this Restore — pick the file below."
    echo -e "    ${GREEN}4.${RESET} Start the service: ${BOLD}Service Control (3) → Start${RESET}."
    echo -e "  ${DIM}Restore overwrites the current DB (a safety copy is kept first).${RESET}\n"

    _grinscan_ensure_sqlite3 || { die "sqlite3 CLI not available — cannot verify restore."; pause; return; }

    local net_choice; net_choice=$(_grinscan_pick_net) || return
    [[ "$net_choice" == *,* ]] && { warn "Restore one network at a time. Pick a single network."; pause; return; }
    local net="$net_choice"
    local net_short; net_short=$( [[ "$net" == "testnet" ]] && echo "test" || echo "main" )
    local db_path="${GRINSCAN_DIR}/${net_short}/grinscan.db"
    local svc="grinscan-${net_short}"

    # Build a list of candidate backups for this network
    local -a backups=()
    if [[ -d "$GRINSCAN_BACKUP_DIR" ]]; then
        local f
        while IFS= read -r f; do [[ -n "$f" ]] && backups+=("$f"); done < <(
            ls -1t "${GRINSCAN_BACKUP_DIR}"/grinscan-${net_short}-*.db.gz 2>/dev/null
        )
    fi

    echo ""
    local src=""
    if [[ ${#backups[@]} -gt 0 ]]; then
        echo -e "  ${BOLD}Available ${net} backups:${RESET}"
        local i=1
        for f in "${backups[@]}"; do
            local sz; sz=$(du -h "$f" 2>/dev/null | cut -f1)
            echo -e "    ${GREEN}${i}${RESET}) $(basename "$f")  ${DIM}(${sz})${RESET}"
            i=$((i+1))
        done
        echo -e "    ${GREEN}P${RESET}) Enter a custom file path"
        echo -e "    ${DIM}0) Cancel${RESET}"
        echo ""
        echo -ne "  ${BOLD}Select [1-$((i-1))/P/0]: ${RESET}"
        read -r sel
        case "${sel^^}" in
            0|"") info "Cancelled."; return ;;
            P) echo -ne "  Full path to backup (.db.gz or .db): "; read -r src ;;
            *)
                if [[ "$sel" =~ ^[0-9]+$ ]] && (( sel >= 1 && sel <= ${#backups[@]} )); then
                    src="${backups[$((sel-1))]}"
                else
                    warn "Invalid selection."; pause; return
                fi
                ;;
        esac
    else
        warn "No ${net} backups found in ${GRINSCAN_BACKUP_DIR}."
        echo -ne "  Full path to backup (.db.gz or .db): "
        read -r src
    fi

    [[ -z "$src" ]] && { info "Cancelled."; return; }
    [[ ! -f "$src" ]] && { die "File not found: ${src}"; pause; return; }

    # Decompress (if needed) to a temp file we can verify before swapping in
    local tmp; tmp=$(mktemp "${GRINSCAN_DIR}/${net_short}/.restore.XXXXXX.db" 2>/dev/null || mktemp)
    if [[ "$src" == *.gz ]]; then
        info "Decompressing…"
        gunzip -c "$src" > "$tmp" 2>/dev/null || { die "Decompression failed."; rm -f "$tmp"; pause; return; }
    else
        cp -f "$src" "$tmp" || { die "Copy failed."; rm -f "$tmp"; pause; return; }
    fi

    # Verify the restored DB BEFORE swapping it in
    local integ; integ=$(sqlite3 "$tmp" "PRAGMA integrity_check;" 2>/dev/null | head -1)
    if [[ "$integ" != "ok" ]]; then
        die "Restore aborted — backup failed integrity check (${integ:-unreadable}). DB unchanged."
        rm -f "$tmp"; pause; return
    fi
    local blocks max_h
    blocks=$(sqlite3 "$tmp" "SELECT COUNT(*) FROM blocks;"   2>/dev/null || echo "?")
    max_h=$( sqlite3 "$tmp" "SELECT MAX(height) FROM blocks;" 2>/dev/null || echo "?")
    echo ""
    success "Backup verified: ${blocks} blocks, tip height ${max_h}."
    echo ""
    echo -ne "  ${BOLD}${YELLOW}Overwrite ${db_path}? [y/N]: ${RESET}"
    read -r ok
    [[ "${ok,,}" != "y" ]] && { info "Cancelled — DB unchanged."; rm -f "$tmp"; return; }

    # Stop the service so it isn't writing while we swap files
    local was_active=0
    if systemctl is-active "$svc" &>/dev/null; then
        was_active=1
        info "Stopping ${svc}…"
        systemctl stop "$svc" 2>/dev/null || true
        sleep 1
    fi

    # Safety copy of the existing DB (+ drop stale WAL/SHM from the old DB)
    if [[ -f "$db_path" ]]; then
        local safety="${db_path}.pre-restore.$(date +%Y%m%d_%H%M%S)"
        cp -a "$db_path" "$safety" 2>/dev/null && info "Previous DB saved → ${safety}"
    fi
    rm -f "${db_path}-wal" "${db_path}-shm" 2>/dev/null || true

    mv -f "$tmp" "$db_path"
    chown www-data:www-data "$db_path" 2>/dev/null || true
    chmod 644 "$db_path" 2>/dev/null || true
    success "DB restored → ${db_path}"

    if [[ $was_active -eq 1 ]]; then
        info "Restarting ${svc}…"
        systemctl start "$svc" 2>/dev/null && success "${svc} started." || warn "Failed to start ${svc} — check logs."
    else
        echo -e "  ${DIM}Service was not running — start it via Service Control (3).${RESET}"
    fi
    log "grinscan_restore: ${net} ← ${src} (blocks=${blocks}, tip=${max_h})"
    pause
}

grinscan_backup_restore() {
    clear
    echo -e "\n${BOLD}${CYAN}── GrinScan: Backup / Restore DB ──${RESET}\n"
    echo -e "  ${DIM}The SQLite DB holds the crawled block + price history. Backing it up${RESET}"
    echo -e "  ${DIM}lets you migrate to a new server without re-crawling the chain.${RESET}\n"

    # ── Reminder box: how to migrate to a new server, correctly ──────────────
    echo -e "  ${BOLD}${YELLOW}┌──────────────────────────────────────────────────────────────────┐${RESET}"
    echo -e "  ${BOLD}${YELLOW}│${RESET}  ${BOLD}Migrate GrinScan to a new server — no re-crawl needed${RESET}             ${BOLD}${YELLOW}│${RESET}"
    echo -e "  ${BOLD}${YELLOW}├──────────────────────────────────────────────────────────────────┤${RESET}"
    echo -e "  ${BOLD}${YELLOW}│${RESET}  ${GREEN}1.${RESET} OLD server:  run ${BOLD}B) Backup DB${RESET}  → writes a .db.gz file       ${BOLD}${YELLOW}│${RESET}"
    echo -e "  ${BOLD}${YELLOW}│${RESET}  ${GREEN}2.${RESET} Copy it down, then up to the NEW server (use ${BOLD}scp${RESET})          ${BOLD}${YELLOW}│${RESET}"
    echo -e "  ${BOLD}${YELLOW}│${RESET}  ${GREEN}3.${RESET} NEW server:  run ${BOLD}Install (1)${RESET} → ${BOLD}Configure (2)${RESET} first      ${BOLD}${YELLOW}│${RESET}"
    echo -e "  ${BOLD}${YELLOW}│${RESET}  ${GREEN}4.${RESET} NEW server:  run ${BOLD}R) Restore DB${RESET}  → pick the file          ${BOLD}${YELLOW}│${RESET}"
    echo -e "  ${BOLD}${YELLOW}│${RESET}  ${GREEN}5.${RESET} NEW server:  ${BOLD}Service Control (3) → Start${RESET}                ${BOLD}${YELLOW}│${RESET}"
    echo -e "  ${BOLD}${YELLOW}│${RESET}  ${DIM}Backups live in: ${GRINSCAN_BACKUP_DIR}${RESET}            ${BOLD}${YELLOW}│${RESET}"
    echo -e "  ${BOLD}${YELLOW}│${RESET}  ${DIM}Backup is safe to run live · Restore keeps a pre-restore copy${RESET}    ${BOLD}${YELLOW}│${RESET}"
    echo -e "  ${BOLD}${YELLOW}└──────────────────────────────────────────────────────────────────┘${RESET}"
    echo ""

    echo -e "  ${GREEN}B${RESET}) Backup DB   ${DIM}consistent snapshot → ${GRINSCAN_BACKUP_DIR}${RESET}"
    echo -e "  ${GREEN}R${RESET}) Restore DB  ${DIM}from a backup file (incl. migration steps)${RESET}"
    echo -e "  ${DIM}0) Back${RESET}"
    echo ""
    echo -ne "${BOLD}Select [B/R/0]: ${RESET}"
    read -r choice
    case "${choice^^}" in
        B) grinscan_backup  || true ;;
        R) grinscan_restore || true ;;
        0|"") return ;;
        *) warn "Invalid choice."; sleep 1 ;;
    esac
}

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
