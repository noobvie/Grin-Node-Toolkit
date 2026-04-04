# 052_lib_app.sh — Grin Drop install (Node.js) + configure
# Sourced by 052_grin_drop.sh — inherits all color/log/network variables.
# =============================================================================
#
#  Functions exported:
#    drop_install    — step 3: Node.js/npm + systemd service
#    drop_configure  — step 4: all config prompts (incl. wallet API ports/secrets)
#

# =============================================================================
# OPTION 3 — Install (Node.js + npm + systemd)
# =============================================================================

drop_install() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — 3) Install ──${RESET}\n"
    echo -e "  ${DIM}Installs Node.js/npm, copies server files, creates systemd service.${RESET}\n"

    # ── Node.js ────────────────────────────────────────────────────────────────
    if command -v node &>/dev/null; then
        local node_ver; node_ver=$(node --version 2>&1)
        success "Node.js $node_ver already installed."
        local major; major=$(echo "$node_ver" | tr -d 'v' | cut -d. -f1)
        if [[ "$major" -lt 18 ]]; then
            warn "Node.js $node_ver is old (need v18+). Consider upgrading."
            echo -ne "  Continue anyway? [y/N]: "
            read -r ok || true
            [[ "${ok,,}" != "y" ]] && { info "Cancelled."; pause; return; }
        fi
    else
        info "Node.js not found — installing via NodeSource (LTS)..."
        if command -v curl &>/dev/null; then
            curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \
                || { die "NodeSource setup failed."; pause; return; }
        else
            apt-get install -y curl
            curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \
                || { die "NodeSource setup failed."; pause; return; }
        fi
        apt-get install -y nodejs \
            || { die "apt-get install nodejs failed."; pause; return; }
        success "Node.js $(node --version) installed."
    fi

    if ! command -v npm &>/dev/null; then
        apt-get install -y npm || { die "npm install failed."; pause; return; }
    fi
    success "npm $(npm --version) ready."
    echo ""

    # ── Copy server files ──────────────────────────────────────────────────────
    if [[ ! -d "$DROP_APP_SRC" ]]; then
        die "Server source not found: $DROP_APP_SRC  (ensure toolkit repo is complete)."
        pause; return
    fi

    info "Copying $DROP_APP_SRC → $DROP_APP_DIR/server/ ..."
    mkdir -p "$DROP_APP_DIR/server"
    cp -r "$DROP_APP_SRC"/. "$DROP_APP_DIR/server/"
    success "Server files copied."

    # ── npm install ────────────────────────────────────────────────────────────
    info "Running npm install --omit=dev ..."
    (cd "$DROP_APP_DIR/server" && npm install --omit=dev --no-audit --no-fund) \
        || { die "npm install failed."; pause; return; }
    success "Node.js dependencies installed."
    echo ""

    # ── Permissions ────────────────────────────────────────────────────────────
    id grin &>/dev/null && chown -R grin:grin "$DROP_APP_DIR/server" 2>/dev/null || true
    chmod -R go-w "$DROP_APP_DIR/server"

    # ── Log file + logrotate ───────────────────────────────────────────────────
    touch "$DROP_LOG"
    id grin &>/dev/null && chown grin:grin "$DROP_LOG" 2>/dev/null || true
    chmod 640 "$DROP_LOG"

    cat > "/etc/logrotate.d/${DROP_SERVICE}" << LOGROTATE
$DROP_LOG {
    daily
    rotate 10
    size 20M
    compress
    delaycompress
    missingok
    notifempty
    postrotate
        systemctl reload-or-restart ${DROP_SERVICE} 2>/dev/null || true
    endscript
}
LOGROTATE
    success "logrotate config: /etc/logrotate.d/${DROP_SERVICE}"

    # ── Systemd service ────────────────────────────────────────────────────────
    drop_ensure_defaults

    local run_user="grin"
    id grin &>/dev/null || run_user="root"
    local node_bin; node_bin=$(command -v node)

    cat > "/etc/systemd/system/${DROP_SERVICE}.service" << SYSTEMD
[Unit]
Description=Grin Drop [$DROP_NET_LABEL]
After=network.target

[Service]
Type=simple
User=$run_user
WorkingDirectory=$DROP_APP_DIR/server
Environment="DROP_CONF=$DROP_CONF"
Environment="DROP_DB=$DROP_DB"
ExecStart=$node_bin $DROP_APP_DIR/server/app.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SYSTEMD

    systemctl daemon-reload
    success "systemd service created: /etc/systemd/system/${DROP_SERVICE}.service"
    echo ""
    echo -e "  ${DIM}Start with: systemctl start $DROP_SERVICE${RESET}"
    echo -e "  ${DIM}Enable autostart: systemctl enable $DROP_SERVICE${RESET}"
    log "[drop_install] network=$DROP_NETWORK node=$(node --version 2>/dev/null)"
    pause
}

# =============================================================================
# OPTION 4 — Configure
# =============================================================================

drop_configure() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — 4) Configure ──${RESET}\n"
    echo -e "  ${DIM}Press Enter to keep the current value shown in [brackets].${RESET}\n"

    drop_ensure_defaults

    local val

    # ── Site identity ──────────────────────────────────────────────────────────
    echo -e "  ${BOLD}Site:${RESET}"
    echo -ne "Drop name        [$(drop_read_conf drop_name 'Grin Drop')]: "
    read -r val || true; [[ -n "$val" ]] && drop_write_conf_key "drop_name" "$val"

    echo -ne "Domain           [$(drop_read_conf subdomain '')]: "
    read -r val || true; [[ -n "$val" ]] && drop_write_conf_key "subdomain" "$val"

    # ── Mode toggles ──────────────────────────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}Mode toggles:${RESET}"
    _conf_bool_prompt "giveaway_enabled" "Giveaway enabled (give GRIN via slatepack claim flow)"
    _conf_bool_prompt "donation_enabled" "Donation enabled (Tab 1/2/3 receive flows)"
    _conf_bool_prompt "show_public_stats" "Show public stats (total given/received on homepage)"

    # ── Giveaway ──────────────────────────────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}Giveaway:${RESET}"
    echo -ne "Claim amount     [$(drop_read_conf claim_amount_grin '2.0') GRIN]: "
    read -r val || true; [[ -n "$val" ]] && drop_write_conf_key "claim_amount_grin" "$val"

    echo -ne "Claim window     [$(drop_read_conf claim_window_hours '24') hours]: "
    read -r val || true; [[ -n "$val" ]] && drop_write_conf_key "claim_window_hours" "$val"

    echo -ne "Finalize timeout [$(drop_read_conf finalize_timeout_min '5') min]: "
    read -r val || true; [[ -n "$val" ]] && drop_write_conf_key "finalize_timeout_min" "$val"

    # ── Donation invoice ──────────────────────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}Donation:${RESET}"
    echo -ne "Invoice timeout  [$(drop_read_conf donation_invoice_timeout '30') min]: "
    read -r val || true; [[ -n "$val" ]] && drop_write_conf_key "donation_invoice_timeout" "$val"

    # ── Wallet address ────────────────────────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}Wallet:${RESET}"
    local current_addr; current_addr=$(drop_read_conf "wallet_address" "")
    local auto_addr=""
    local addr_prefix="grin1"; [[ "$DROP_NETWORK" == "testnet" ]] && addr_prefix="tgrin1"

    # Try HTTP API first (Node.js server must be running)
    local domain; domain=$(drop_read_conf "subdomain" "")
    if [[ -n "$domain" ]]; then
        auto_addr=$(curl -sf --max-time 5 "http://127.0.0.1:${DROP_PORT}/api/status" \
            | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('wallet_address',''))" \
            2>/dev/null || true)
    fi

    if [[ -z "$auto_addr" && -x "$DROP_WALLET_BIN" ]]; then
        local _pass=""; [[ -f "$DROP_PASS" ]] && _pass=$(cat "$DROP_PASS")
        if [[ -n "$_pass" ]]; then
            local _addr_out
            _addr_out=$("$DROP_WALLET_BIN" $DROP_NET_FLAG --top_level_dir "$DROP_WALLET_DIR" \
                -p "$_pass" address 2>&1 || true)
            auto_addr=$(echo "$_addr_out" | grep -oP "${addr_prefix}[a-z0-9]+" | head -1)
        fi
        unset _pass
    fi

    if [[ -n "$auto_addr" ]]; then
        success "Address detected: $auto_addr"
        echo -ne "Wallet address   [${auto_addr}] (Enter to accept): "
        read -r val || true
        drop_write_conf_key "wallet_address" "${val:-$auto_addr}"
    else
        warn "Could not auto-fetch wallet address."
        echo -e "  ${DIM}(Ensure wallet listener is running — option 2)${RESET}"
        echo -ne "Wallet address   [${current_addr:-not set}]: "
        read -r val || true
        if [[ -n "$val" && "$val" != "0" ]]; then
            drop_write_conf_key "wallet_address" "$val"
            success "Wallet address saved."
        fi
    fi

    # ── Wallet API ports + secret paths ───────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}Wallet HTTP API:${RESET}"

    local def_foreign; def_foreign=$(drop_read_conf "wallet_foreign_api_port" "$([[ $DROP_NETWORK == mainnet ]] && echo 3415 || echo 13415)")
    echo -ne "Foreign API port [${def_foreign}]: "
    read -r val || true; [[ -n "$val" ]] && drop_write_conf_key "wallet_foreign_api_port" "$val"

    local def_owner; def_owner=$(drop_read_conf "wallet_owner_api_port" "$([[ $DROP_NETWORK == mainnet ]] && echo 3420 || echo 13420)")
    echo -ne "Owner API port   [${def_owner}]: "
    read -r val || true; [[ -n "$val" ]] && drop_write_conf_key "wallet_owner_api_port" "$val"

    local def_fsec; def_fsec=$(drop_read_conf "wallet_foreign_secret" "${DROP_WALLET_DIR}/wallet_data/.api_secret")
    echo -ne "Foreign secret   [${def_fsec}]: "
    read -r val || true; [[ -n "$val" ]] && drop_write_conf_key "wallet_foreign_secret" "$val"

    local def_osec; def_osec=$(drop_read_conf "wallet_owner_secret" "${DROP_WALLET_DIR}/.owner_api_secret")
    echo -ne "Owner secret     [${def_osec}]: "
    read -r val || true; [[ -n "$val" ]] && drop_write_conf_key "wallet_owner_secret" "$val"

    # ── Wallet passphrase ─────────────────────────────────────────────────────
    echo ""
    echo -e "  ${DIM}Wallet passphrase stored at $DROP_PASS (mode 600).${RESET}"
    echo -ne "Wallet passphrase [Enter to keep]: "
    read -rs val || true; echo ""
    if [[ -n "$val" ]]; then
        mkdir -p "$(dirname "$DROP_PASS")"
        echo "$val" > "$DROP_PASS"; chmod 600 "$DROP_PASS"
        id grin &>/dev/null && chown grin:grin "$DROP_PASS" 2>/dev/null || true
        success "Passphrase saved to $DROP_PASS"
    fi

    # ── Admin panel ───────────────────────────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}Admin panel:${RESET}"
    _configure_admin_path

    # ── SEO / appearance ──────────────────────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}SEO / appearance:${RESET}"
    echo -ne "Site description [$(drop_read_conf site_description 'Claim free GRIN…')]: "
    read -r val || true; [[ -n "$val" ]] && drop_write_conf_key "site_description" "$val"

    echo -ne "OG image URL     [$(drop_read_conf og_image_url '')]: "
    read -r val || true; [[ -n "$val" ]] && drop_write_conf_key "og_image_url" "$val"

    # ── Maintenance ───────────────────────────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}Maintenance:${RESET}"
    echo -ne "Maintenance message [$(drop_read_conf maintenance_message 'We will be back soon.')]: "
    read -r val || true; [[ -n "$val" ]] && drop_write_conf_key "maintenance_message" "$val"

    echo ""
    success "Configuration saved to $DROP_CONF"

    if systemctl is-active --quiet "$DROP_SERVICE" 2>/dev/null; then
        info "Restarting $DROP_SERVICE to apply new config..."
        systemctl restart "$DROP_SERVICE" && success "Service restarted."
    fi
    log "[drop_configure] network=$DROP_NETWORK"
    pause
}

# ── Helpers ───────────────────────────────────────────────────────────────────

_conf_bool_prompt() {
    local key="$1" label="$2"
    local cur; cur=$(drop_read_conf "$key" "true")
    echo -ne "  $label [${cur}] (true/false/Enter to keep): "
    local val; read -r val || true
    [[ "$val" == "true" || "$val" == "false" ]] && drop_write_conf_key "$key" "$val"
}

_configure_admin_path() {
    local cur_ap; cur_ap=$(drop_read_conf "admin_secret_path" "")
    local _rnd; _rnd=$(tr -dc 'a-z0-9' < /dev/urandom | head -c 10 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null | tr -d '-' | head -c 10)

    if [[ -z "$cur_ap" ]]; then
        echo -e "  ${DIM}Admin URL path — random or custom.  Example: mykey2025 → https://domain/mykey2025/${RESET}"
        echo -ne "  Admin path [Enter for random ${BOLD}$_rnd${RESET}]: "
        read -r val || true
        if [[ -n "$val" ]]; then
            cur_ap=$(echo "$val" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')
            [[ -z "$cur_ap" ]] && cur_ap="$_rnd"
        else
            cur_ap="$_rnd"
        fi
        drop_write_conf_key "admin_secret_path" "$cur_ap"
        success "Admin path set: /$cur_ap/"
    else
        info "Current admin path: /$cur_ap/"
        echo -e "  ${DIM}1) Keep   2) Enter new   3) Random${RESET}"
        echo -ne "  Choice [1/2/3]: "
        read -r val || true
        case "$val" in
            2)
                echo -ne "  New admin path: "
                read -r val || true
                local new_ap; new_ap=$(echo "$val" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')
                if [[ -n "$new_ap" ]]; then
                    drop_write_conf_key "admin_secret_path" "$new_ap"
                    success "Admin path updated: /$new_ap/"
                    warn "Re-run option 6 (nginx) to apply."
                else
                    warn "Invalid — keeping current."
                fi
                ;;
            3)
                drop_write_conf_key "admin_secret_path" "$_rnd"
                success "Admin path regenerated: /$_rnd/"
                warn "Re-run option 6 (nginx) to apply."
                ;;
            *) info "Admin path unchanged: /$cur_ap/" ;;
        esac
    fi
}
