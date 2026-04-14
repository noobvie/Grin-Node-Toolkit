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
    local _do_install=false
    if command -v node &>/dev/null; then
        local node_ver; node_ver=$(node --version 2>&1)
        local major; major=$(echo "$node_ver" | tr -d 'v' | cut -d. -f1)
        if [[ "$major" -lt 24 ]]; then
            warn "Node.js $node_ver is too old (need v24+)."
            echo -ne "  Remove it and install v24 LTS now? [y/N]: "
            read -r ok || true
            if [[ "${ok,,}" == "y" ]]; then
                info "Removing old Node.js..."
                apt-get remove -y nodejs npm 2>/dev/null || true
                apt-get autoremove -y 2>/dev/null || true
                success "Old Node.js removed."
                _do_install=true
            else
                info "Cancelled."; pause; return
            fi
        else
            success "Node.js $node_ver already installed."
        fi
    else
        _do_install=true
    fi

    if [[ "$_do_install" == true ]]; then
        info "Installing Node.js v24 LTS via NodeSource..."
        command -v curl &>/dev/null || apt-get install -y curl
        curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
            || { die "NodeSource setup failed."; pause; return; }
        apt-get install -y nodejs \
            || { die "apt-get install nodejs failed."; pause; return; }
        success "Node.js $(node --version) installed."
    fi

    info "Updating npm to latest..."
    npm install -g npm@latest --no-audit --no-fund \
        || { die "npm upgrade failed."; pause; return; }
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

    # ── Copy public_html ───────────────────────────────────────────────────────
    local pub_dir="$DROP_APP_DIR/public_html"
    info "Copying $DROP_WEB_SRC → $pub_dir ..."
    mkdir -p "$pub_dir"
    cp -r "$DROP_WEB_SRC"/. "$pub_dir/"
    find "$pub_dir" -type f \( -name "*.html" -o -name "*.css" -o -name "*.js" \) \
        -exec chmod 644 {} \;
    success "Web files deployed to $pub_dir"

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
RestartSec=15
StartLimitIntervalSec=0
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SYSTEMD

    systemctl daemon-reload
    success "systemd service created: /etc/systemd/system/${DROP_SERVICE}.service"
    echo ""

    echo -ne "  Enable autostart on boot? [Y/n]: "
    local en_choice; read -r en_choice || true
    if [[ "${en_choice,,}" != "n" ]]; then
        systemctl enable "$DROP_SERVICE" 2>/dev/null && success "Service enabled (autostart on boot)."
    fi

    echo -ne "  Start service now? [Y/n]: "
    local st_choice; read -r st_choice || true
    if [[ "${st_choice,,}" != "n" ]]; then
        systemctl start "$DROP_SERVICE" \
            && success "Service started — DB will be created on first startup." \
            || warn "Service failed to start — check: journalctl -u $DROP_SERVICE -n 30"
    else
        echo -e "  ${DIM}Start later: systemctl start $DROP_SERVICE${RESET}"
    fi

    log "[drop_install] network=$DROP_NETWORK node=$(node --version 2>/dev/null)"
    pause
}

# =============================================================================
# OPTION 4 — Configure
# =============================================================================

drop_configure() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — 4) Configure ──${RESET}\n"
    echo -e "  ${DIM}Press Enter to keep the current value shown in [brackets].${RESET}"
    echo -e "  ${DIM}Type ${BOLD}0${DIM} at any prompt to cancel and return to the menu.${RESET}"
    echo -e "  ${DIM}Domain is configured from the main 052 menu (option 1).${RESET}\n"

    drop_ensure_defaults

    local val

    # ── Domain info (read-only — managed from top-level menu option 1) ──────────
    local _dom; _dom=$(python3 -c \
        "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('subdomain','not set'))" \
        "$DROP_SHARED_CONF" 2>/dev/null || echo "not set")
    echo -e "  ${DIM}Domain: ${BOLD}$_dom${RESET}  ${DIM}(manage via 052 main menu → option 1)${RESET}"
    echo ""

    # ── Mode toggles ──────────────────────────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}Mode Toggles [$DROP_NET_LABEL]:${RESET}"
    _conf_bool_prompt "giveaway_enabled" "Giveaway enabled (give GRIN via slatepack claim flow)"
    _conf_bool_prompt "donation_enabled" "Donation enabled (Tab 1/2/3 receive flows)"
    _conf_bool_prompt "show_public_stats" "Show public stats (total given/received on homepage)"

    # ── Giveaway ──────────────────────────────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}Giveaway Settings [$DROP_NET_LABEL]:${RESET}"
    echo -ne "Max claim per tx [$(drop_read_conf claim_amount_grin '0.1') GRIN]  (max GRIN sent in one claim): "
    read -r val || true; [[ "$val" == "0" ]] && { info "Cancelled."; return; }
    [[ -n "$val" ]] && drop_write_conf_key "claim_amount_grin" "$val"

    echo -ne "Address cooldown [$(drop_read_conf claim_window_hours '24') hours] (wait per address before next claim): "
    read -r val || true; [[ "$val" == "0" ]] && { info "Cancelled."; return; }
    [[ -n "$val" ]] && drop_write_conf_key "claim_window_hours" "$val"

    echo -ne "Finalize window  [$(drop_read_conf finalize_timeout_min '30') min]   (time for user to paste response slatepack): "
    read -r val || true; [[ "$val" == "0" ]] && { info "Cancelled."; return; }
    [[ -n "$val" ]] && drop_write_conf_key "finalize_timeout_min" "$val"

    # ── Donation invoice ──────────────────────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}Donation Settings [$DROP_NET_LABEL]:${RESET}"
    echo -ne "Invoice expiry   [$(drop_read_conf donation_invoice_timeout '30') min]   (time before invoice expires): "
    read -r val || true; [[ "$val" == "0" ]] && { info "Cancelled."; return; }
    [[ -n "$val" ]] && drop_write_conf_key "donation_invoice_timeout" "$val"

    # ── Wallet address ────────────────────────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}Wallet Address [$DROP_NET_LABEL]:${RESET}"
    local current_addr; current_addr=$(drop_read_conf "wallet_address" "")
    local auto_addr=""
    local addr_prefix="grin1"; [[ "$DROP_NETWORK" == "testnet" ]] && addr_prefix="tgrin1"

    # Try HTTP API first (Node.js server must be running)
    local domain; domain=$(_shared_read "subdomain" "")
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
        [[ "$val" == "0" ]] && { info "Cancelled."; return; }
        drop_write_conf_key "wallet_address" "${val:-$auto_addr}"
    else
        warn "Could not auto-fetch wallet address."
        echo -e "  ${DIM}(Ensure wallet listener is running — option 2)${RESET}"
        echo -ne "Wallet address   [${current_addr:-not set}]: "
        read -r val || true
        [[ "$val" == "0" ]] && { info "Cancelled."; return; }
        if [[ -n "$val" ]]; then
            drop_write_conf_key "wallet_address" "$val"
            success "Wallet address saved."
        fi
    fi

    # ── Wallet API ports + secret paths (info only) ───────────────────────────
    echo ""
    echo -e "  ${BOLD}Wallet HTTP API [$DROP_NET_LABEL]:${RESET}"
    echo -e "  ${DIM}Foreign API port : $(drop_read_conf "wallet_foreign_api_port" "$DROP_TOR_PORT")${RESET}"
    echo -e "  ${DIM}Owner API port   : $(drop_read_conf "wallet_owner_api_port" "$DROP_OWNER_PORT")${RESET}"
    local fsec; fsec=$(drop_read_conf "wallet_foreign_secret" "${DROP_WALLET_DIR}/.foreign_api_secret")
    local osec; osec=$(drop_read_conf "wallet_owner_secret"   "${DROP_WALLET_DIR}/.owner_api_secret")
    local fsec_st osec_st
    [[ -s "$fsec" ]] && fsec_st="${GREEN}✓ exists${RESET}" || fsec_st="${RED}✗ missing${RESET}"
    [[ -s "$osec" ]] && osec_st="${GREEN}✓ exists${RESET}" || osec_st="${RED}✗ missing${RESET}"
    echo -e "  Foreign secret   : ${DIM}$fsec${RESET}  $fsec_st"
    echo -e "  Owner secret     : ${DIM}$osec${RESET}  $osec_st"
    if [[ ! -s "$osec" ]]; then
        warn "Owner API secret missing — run option 1 (Install) or fix ownership to regenerate it."
    fi

    # ── SEO / appearance ──────────────────────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}SEO / Appearance [$DROP_NET_LABEL]:${RESET}"
    echo -ne "Site description [$(drop_read_conf site_description 'Claim free GRIN…')]: "
    read -r val || true; [[ "$val" == "0" ]] && { info "Cancelled."; return; }
    [[ -n "$val" ]] && drop_write_conf_key "site_description" "$val"

    echo -ne "OG image URL     [$(drop_read_conf og_image_url '')]: "
    read -r val || true; [[ "$val" == "0" ]] && { info "Cancelled."; return; }
    [[ -n "$val" ]] && drop_write_conf_key "og_image_url" "$val"

    # ── Maintenance ───────────────────────────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}Maintenance [$DROP_NET_LABEL]:${RESET}"
    echo -ne "Maintenance message [$(drop_read_conf maintenance_message 'We will be back soon.')]: "
    read -r val || true; [[ "$val" == "0" ]] && { info "Cancelled."; return; }
    [[ -n "$val" ]] && drop_write_conf_key "maintenance_message" "$val"

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

