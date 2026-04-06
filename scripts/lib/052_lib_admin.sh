# 052_lib_admin.sh — Grin Drop admin operations
# Sourced by 052_grin_drop.sh — inherits all color/log/network variables.
# =============================================================================
#
#  Functions exported:
#    drop_deploy_web       — step 5: copy web files + npm install
#    drop_service_control  — step 7: start/stop/enable systemd service
#    drop_status_screen    — step 8: detailed health + stats
#    drop_wallet_address   — step 9: show + update wallet address
#    drop_view_logs        — L) tail activity log
#    drop_backup           — B) encrypt DB + config + seed → archive
#    drop_restore          — R) decrypt + restore archive
#

BACKUP_DIR="/opt/grin/backups"
BACKUP_KEEP=10

# =============================================================================
# OPTION 5 — Deploy web files
# =============================================================================

drop_deploy_web() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — 5) Deploy Web Files ──${RESET}\n"

    if [[ ! -d "$DROP_WEB_SRC" ]]; then
        die "Web source not found: $DROP_WEB_SRC  (ensure toolkit repo is complete)."
        pause; return
    fi

    # Deploy public_html
    info "Copying $DROP_WEB_SRC → $DROP_WEB_DIR ..."
    mkdir -p "$DROP_WEB_DIR"
    cp -r "$DROP_WEB_SRC"/. "$DROP_WEB_DIR/"
    find "$DROP_WEB_DIR" -type f \( -name "*.html" -o -name "*.css" -o -name "*.js" \) \
        -exec chmod 644 {} \;
    success "Web files deployed to $DROP_WEB_DIR"

    # Deploy server files + npm install
    if [[ -d "$DROP_APP_SRC" ]]; then
        info "Copying server files $DROP_APP_SRC → $DROP_APP_DIR/server/ ..."
        mkdir -p "$DROP_APP_DIR/server"
        cp -r "$DROP_APP_SRC"/. "$DROP_APP_DIR/server/"
        info "Running npm install --omit=dev ..."
        (cd "$DROP_APP_DIR/server" && npm install --omit=dev --no-audit --no-fund 2>&1) \
            && success "npm install complete." \
            || warn "npm install had errors — check output above."
        id grin &>/dev/null && chown -R grin:grin "$DROP_APP_DIR/server" 2>/dev/null || true
    else
        warn "Server source not found: $DROP_APP_SRC  (skipping)"
    fi

    # robots.txt
    local domain_val; domain_val=$(drop_read_conf "subdomain" "")
    cat > "$DROP_WEB_DIR/robots.txt" << ROBOTS_EOF
User-agent: *
Disallow: /api/
Allow: /

Sitemap: https://${domain_val}/sitemap.xml
ROBOTS_EOF
    success "robots.txt generated."

    if systemctl is-active --quiet "$DROP_SERVICE" 2>/dev/null; then
        info "Restarting $DROP_SERVICE to pick up new files..."
        systemctl restart "$DROP_SERVICE" && success "Service restarted."
    fi

    log "[drop_deploy_web] network=$DROP_NETWORK"
    pause
}

# =============================================================================
# OPTION 7 — Start / Stop service
# =============================================================================

drop_service_control() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — 7) Start / Stop Service ──${RESET}\n"

    if [[ ! -f "/etc/systemd/system/${DROP_SERVICE}.service" ]]; then
        die "Service not installed — run option 3 (Install) first."; pause; return
    fi

    local state="stopped"
    if systemctl is-active --quiet "$DROP_SERVICE" 2>/dev/null; then
        state="running"
        echo -e "  Service: ${GREEN}running${RESET}"
        echo ""
        echo -e "  ${RED}1${RESET}) Stop service"
        echo -e "  ${YELLOW}2${RESET}) Restart service"
        echo -e "  ${DIM}0) Back${RESET}"
    else
        echo -e "  Service: ${YELLOW}stopped${RESET}"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Start service"
        echo -e "  ${GREEN}2${RESET}) Enable + Start  ${DIM}(auto-start on boot)${RESET}"
        echo -e "  ${DIM}0) Back${RESET}"
    fi
    echo ""
    echo -ne "${BOLD}Select [1/2/0]: ${RESET}"
    read -r sc || true

    case "$sc" in
        1)
            if [[ "$state" == "running" ]]; then
                systemctl stop "$DROP_SERVICE" && success "Service stopped."
            else
                systemctl start "$DROP_SERVICE" && success "Service started." \
                    || { warn "Start failed — check: journalctl -u $DROP_SERVICE -n 30"; }
            fi
            ;;
        2)
            if [[ "$state" == "running" ]]; then
                systemctl restart "$DROP_SERVICE" && success "Service restarted."
            else
                systemctl enable "$DROP_SERVICE" 2>/dev/null || true
                systemctl start  "$DROP_SERVICE" && success "Service enabled and started." \
                    || { warn "Start failed — check: journalctl -u $DROP_SERVICE -n 30"; }
            fi
            ;;
        0) return ;;
    esac
    pause
}

# =============================================================================
# OPTION 8 — Drop status
# =============================================================================

drop_status_screen() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} Grin Drop [$DROP_NET_LABEL] — Status${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    # Service
    if systemctl is-active --quiet "$DROP_SERVICE" 2>/dev/null; then
        local pid; pid=$(systemctl show "$DROP_SERVICE" --property=MainPID --value 2>/dev/null || echo "?")
        echo -e "  ${BOLD}Service${RESET}    : ${GREEN}● active${RESET}  pid $pid"
    elif systemctl is-enabled --quiet "$DROP_SERVICE" 2>/dev/null; then
        echo -e "  ${BOLD}Service${RESET}    : ${YELLOW}stopped (enabled)${RESET}"
    else
        echo -e "  ${BOLD}Service${RESET}    : ${RED}not installed${RESET}"
    fi

    local port; port=$(drop_read_conf "service_port" "$DROP_PORT")
    local subdomain; subdomain=$(drop_read_conf "subdomain" "")
    echo -e "  ${BOLD}Port${RESET}       : $port"
    [[ -n "$subdomain" ]] && echo -e "  ${BOLD}URL${RESET}        : ${GREEN}https://$subdomain/${DROP_NETWORK}/${RESET}"

    local admin_path; admin_path=$(drop_read_conf "admin_secret_path" "")
    if [[ -n "$admin_path" && -n "$subdomain" ]]; then
        echo -e "  ${BOLD}Admin URL${RESET}  : ${YELLOW}https://$subdomain/${DROP_NETWORK}/$admin_path/admin/${RESET}"
    fi

    # Wallet tmux sessions
    echo ""
    local tor_port owner_port
    [[ "$DROP_NETWORK" == "mainnet" ]] && { tor_port=3415; owner_port=3420; } \
                                       || { tor_port=13415; owner_port=13420; }
    tmux has-session -t "$DROP_TMUX_TOR" 2>/dev/null \
        && echo -e "  ${BOLD}TOR session${RESET}  : ${GREEN}● running${RESET}  (tmux: $DROP_TMUX_TOR)" \
        || echo -e "  ${BOLD}TOR session${RESET}  : ${RED}not running${RESET}  ${DIM}(run option 2)${RESET}"
    tmux has-session -t "$DROP_TMUX_OWNER" 2>/dev/null \
        && echo -e "  ${BOLD}Owner session${RESET}: ${GREEN}● running${RESET}  (tmux: $DROP_TMUX_OWNER)" \
        || echo -e "  ${BOLD}Owner session${RESET}: ${RED}not running${RESET}  ${DIM}(run option 2)${RESET}"

    ss -tlnp 2>/dev/null | grep -q ":${tor_port} " \
        && echo -e "  ${BOLD}Port :${tor_port}${RESET}   : ${GREEN}listening${RESET}" \
        || echo -e "  ${BOLD}Port :${tor_port}${RESET}   : ${DIM}not listening${RESET}"
    ss -tlnp 2>/dev/null | grep -q ":${owner_port} " \
        && echo -e "  ${BOLD}Port :${owner_port}${RESET}  : ${GREEN}listening${RESET}" \
        || echo -e "  ${BOLD}Port :${owner_port}${RESET}  : ${DIM}not listening${RESET}"

    # DB
    echo ""
    if [[ -f "$DROP_DB" ]]; then
        local db_size; db_size=$(du -sh "$DROP_DB" 2>/dev/null | cut -f1 || echo "?")
        echo -e "  ${BOLD}Database${RESET}   : ${GREEN}$DROP_DB${RESET}  ($db_size)"
    else
        echo -e "  ${BOLD}Database${RESET}   : ${DIM}not created yet${RESET}"
    fi

    # Stats via Node.js API (non-fatal)
    if systemctl is-active --quiet "$DROP_SERVICE" 2>/dev/null; then
        local api_data
        api_data=$(curl -sf --max-time 5 "http://127.0.0.1:${port}/api/status" 2>/dev/null || true)
        if [[ -n "$api_data" ]]; then
            local balance claims_today claims_total
            balance=$(echo "$api_data" | python3 -c "import json,sys; print(json.load(sys.stdin).get('wallet_balance','?'))" 2>/dev/null || echo "?")
            claims_today=$(echo "$api_data" | python3 -c "import json,sys; print(json.load(sys.stdin).get('claims_today','?'))" 2>/dev/null || echo "?")
            claims_total=$(echo "$api_data" | python3 -c "import json,sys; print(json.load(sys.stdin).get('claims_total','?'))" 2>/dev/null || echo "?")
            echo -e "  ${BOLD}Balance${RESET}    : ${GREEN}${balance} GRIN${RESET}"
            echo -e "  ${BOLD}Claims${RESET}     : today $claims_today  total $claims_total"
        fi
    else
        # Fallback: direct sqlite3 if available
        if command -v sqlite3 &>/dev/null && [[ -f "$DROP_DB" ]]; then
            local today; today=$(date -u +"%Y-%m-%d")
            local ct_today ct_total
            ct_today=$(sqlite3 "$DROP_DB" \
                "SELECT COUNT(*) FROM claims WHERE created_at LIKE '${today}%' AND status='confirmed';" 2>/dev/null || echo "?")
            ct_total=$(sqlite3 "$DROP_DB" \
                "SELECT COUNT(*) FROM claims WHERE status='confirmed';" 2>/dev/null || echo "?")
            echo -e "  ${BOLD}Claims${RESET}     : today $ct_today  total $ct_total  ${DIM}(from DB)${RESET}"
        fi
    fi

    # Mode status
    echo ""
    local giveaway_on; giveaway_on=$(drop_read_conf "giveaway_enabled" "true")
    local donation_on; donation_on=$(drop_read_conf "donation_enabled" "true")
    echo -e "  ${BOLD}Giveaway${RESET}: $giveaway_on  |  ${BOLD}Donation${RESET}: $donation_on"

    # Systemd journal (last 10 lines)
    echo ""
    echo -e "  ${DIM}── Recent service log (last 10 lines) ──${RESET}"
    journalctl -u "$DROP_SERVICE" -n 10 --no-pager 2>/dev/null | while IFS= read -r line; do
        echo -e "  ${DIM}$line${RESET}"
    done

    echo ""
    pause
}

# =============================================================================
# OPTION 9 — Wallet address
# =============================================================================

drop_wallet_address() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — 9) Wallet Address ──${RESET}\n"

    drop_ensure_defaults
    local addr; addr=$(drop_read_conf "wallet_address" "")

    echo -e "  ${BOLD}Stored address:${RESET}"
    echo -e "  ──────────────────────────────────────────────────────────────"
    if [[ -n "$addr" ]]; then
        echo -e "  ${GREEN}$addr${RESET}"
    else
        echo -e "  ${YELLOW}(not set — run option 4 to configure)${RESET}"
    fi
    echo -e "  ──────────────────────────────────────────────────────────────"
    echo ""

    # Live balance from Node.js API
    local port; port=$(drop_read_conf "service_port" "$DROP_PORT")
    if systemctl is-active --quiet "$DROP_SERVICE" 2>/dev/null; then
        local api_data
        api_data=$(curl -sf --max-time 5 "http://127.0.0.1:${port}/api/status" 2>/dev/null || true)
        if [[ -n "$api_data" ]]; then
            local live_addr balance
            live_addr=$(echo "$api_data" | python3 -c "import json,sys; print(json.load(sys.stdin).get('wallet_address',''))" 2>/dev/null || true)
            balance=$(echo "$api_data" | python3 -c "import json,sys; print(json.load(sys.stdin).get('wallet_balance','?'))" 2>/dev/null || echo "?")
            [[ -n "$live_addr" ]] && echo -e "  ${BOLD}Live address (from wallet API):${RESET} ${GREEN}$live_addr${RESET}"
            echo -e "  ${BOLD}Current balance:${RESET} ${GREEN}${balance} GRIN${RESET}"
        fi
    fi

    echo ""
    echo -e "  ${CYAN}U${RESET}) Update stored address"
    echo -e "  ${DIM}0) Back${RESET}"
    echo ""
    echo -ne "${BOLD}Select [U/0]: ${RESET}"
    read -r choice || true

    if [[ "${choice,,}" == "u" ]]; then
        echo ""
        echo -ne "New wallet address: "
        read -r new_addr || true
        if [[ -n "$new_addr" ]]; then
            drop_write_conf_key "wallet_address" "$new_addr"
            success "Address updated."
            if systemctl is-active --quiet "$DROP_SERVICE" 2>/dev/null; then
                systemctl restart "$DROP_SERVICE" && success "Service restarted."
            fi
        else
            info "No change."
        fi
    fi
    pause
}

# =============================================================================
# OPTION L — View logs
# =============================================================================

drop_view_logs() {
    clear
    echo -e "${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — Logs ──${RESET}"
    echo ""
    echo -e "  ${GREEN}1${RESET}) Activity log        ${DIM}($DROP_LOG)${RESET}"
    echo -e "  ${GREEN}2${RESET}) systemd journal     ${DIM}(journalctl -u $DROP_SERVICE)${RESET}"
    echo -e "  ${GREEN}3${RESET}) nginx access log"
    echo -e "  ${GREEN}4${RESET}) nginx error log"
    echo -e "  ${DIM}0) Back${RESET}"
    echo ""
    echo -ne "${BOLD}Select [1-4/0]: ${RESET}"
    read -r lc || true

    case "$lc" in
        1)
            if [[ -f "$DROP_LOG" ]]; then
                echo -e "${DIM}  $DROP_LOG  (press q to quit)${RESET}\n"
                tail -n 80 "$DROP_LOG" | less -FRX
            else
                warn "Activity log not found: $DROP_LOG"
                pause
            fi
            ;;
        2) journalctl -u "$DROP_SERVICE" -n 100 --no-pager | less -FRX ;;
        3)
            local f="/var/log/nginx/grin-drop-${DROP_NETWORK}-access.log"
            [[ -f "$f" ]] && tail -n 100 "$f" | less -FRX || { warn "Not found: $f"; pause; }
            ;;
        4)
            local f="/var/log/nginx/grin-drop-${DROP_NETWORK}-error.log"
            [[ -f "$f" ]] && tail -n 100 "$f" | less -FRX || { warn "Not found: $f"; pause; }
            ;;
        0) return ;;
    esac
}

# =============================================================================
# OPTION B — Backup
# =============================================================================

drop_backup() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — B) Backup ──${RESET}\n"
    echo -e "  ${DIM}Creates an AES-256-CBC encrypted archive of:${RESET}"
    echo -e "  ${DIM}  - SQLite database ($DROP_DB)${RESET}"
    echo -e "  ${DIM}  - Config file ($DROP_CONF)${RESET}"
    echo -e "  ${DIM}  - Seed words ($DROP_WORD)${RESET}"
    echo -e "  ${DIM}  - Wallet passphrase file ($DROP_PASS)${RESET}"
    echo ""

    mkdir -p "$BACKUP_DIR"

    local ts; ts=$(date +%Y%m%d_%H%M%S)
    local archive_name="grin_drop_${DROP_NETWORK}_backup_${ts}.tar.gz.enc"
    local archive_path="$BACKUP_DIR/$archive_name"

    # Gather files to include
    local tmp_dir="/tmp/grin_drop_backup_$$"
    mkdir -p "$tmp_dir"

    [[ -f "$DROP_DB"   ]] && cp "$DROP_DB"   "$tmp_dir/drop.db"        || warn "DB not found — skipping"
    [[ -f "$DROP_CONF" ]] && cp "$DROP_CONF" "$tmp_dir/grin_drop.conf" || warn "Config not found — skipping"
    [[ -f "$DROP_PASS" ]] && cp "$DROP_PASS" "$tmp_dir/wallet_pass"    || warn "Pass file not found — skipping"
    [[ -f "$DROP_WORD" ]] && cp "$DROP_WORD" "$tmp_dir/seed-words"     || info "No seed words file found."

    echo -ne "  Backup password: "
    local bak_pass bak_pass2
    read -rs bak_pass; echo ""
    if [[ -z "$bak_pass" ]]; then
        warn "Password cannot be empty."; rm -rf "$tmp_dir"; pause; return
    fi
    read -rs -p "  Confirm password: " bak_pass2; echo ""
    if [[ "$bak_pass" != "$bak_pass2" ]]; then
        error "Passwords do not match."; rm -rf "$tmp_dir"; unset bak_pass bak_pass2; pause; return
    fi

    local tmp_tar="/tmp/grin_drop_bak_$$.tar.gz"
    tar -czf "$tmp_tar" -C "$tmp_dir" . 2>/dev/null \
        || { die "tar failed."; rm -rf "$tmp_dir" "$tmp_tar"; unset bak_pass; pause; return; }
    rm -rf "$tmp_dir"

    openssl enc -aes-256-cbc -pbkdf2 -iter 600000 \
        -pass "pass:${bak_pass}" \
        -in  "$tmp_tar" \
        -out "$archive_path" 2>/dev/null \
        || { die "openssl encryption failed."; rm -f "$tmp_tar" "$archive_path"; unset bak_pass; pause; return; }
    rm -f "$tmp_tar"
    unset bak_pass bak_pass2

    chmod 600 "$archive_path"
    chown root:root "$archive_path" 2>/dev/null || true
    success "Backup created: $archive_path  (mode 600)"

    # Keep last N backups
    local count; count=$(ls "$BACKUP_DIR/grin_drop_${DROP_NETWORK}_backup_"*.enc 2>/dev/null | wc -l)
    if [[ "$count" -gt "$BACKUP_KEEP" ]]; then
        ls -t "$BACKUP_DIR/grin_drop_${DROP_NETWORK}_backup_"*.enc \
            | tail -n +"$((BACKUP_KEEP + 1))" \
            | xargs rm -f 2>/dev/null || true
        info "Old backups pruned (kept last $BACKUP_KEEP)."
    fi

    log "[drop_backup] network=$DROP_NETWORK archive=$archive_name"
    pause
}

# =============================================================================
# OPTION R — Restore
# =============================================================================

drop_restore() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — R) Restore ──${RESET}\n"

    # List available backups
    local -a bak_files
    mapfile -t bak_files < <(ls -t "$BACKUP_DIR/grin_drop_${DROP_NETWORK}_backup_"*.enc 2>/dev/null || true)

    if [[ "${#bak_files[@]}" -eq 0 ]]; then
        warn "No backups found in $BACKUP_DIR for $DROP_NET_LABEL."
        pause; return
    fi

    echo -e "  ${BOLD}Available backups:${RESET}"
    local i=1
    for f in "${bak_files[@]}"; do
        local sz; sz=$(du -sh "$f" 2>/dev/null | cut -f1 || echo "?")
        echo -e "  ${GREEN}$i${RESET}) $(basename "$f")  ${DIM}($sz)${RESET}"
        ((i++))
    done
    echo -e "  ${DIM}0) Cancel${RESET}"
    echo ""
    echo -ne "${BOLD}Select backup [1-${#bak_files[@]}/0]: ${RESET}"
    local sel; read -r sel || true
    [[ "$sel" == "0" ]] && return
    if ! [[ "$sel" =~ ^[0-9]+$ ]] || [[ "$sel" -lt 1 || "$sel" -gt "${#bak_files[@]}" ]]; then
        warn "Invalid selection."; pause; return
    fi

    local chosen="${bak_files[$((sel-1))]}"
    echo ""
    info "Selected: $(basename "$chosen")"

    # Decrypt test (validate password before stopping service)
    echo -ne "  Backup password: "
    local bak_pass; read -rs bak_pass; echo ""
    local tmp_test="/tmp/grin_drop_restore_test_$$"
    if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
        -pass "pass:${bak_pass}" -in "$chosen" -out "$tmp_test" 2>/dev/null; then
        rm -f "$tmp_test"
        error "Wrong password or corrupt backup."; unset bak_pass; pause; return
    fi

    # Verify it's a valid tar
    if ! tar -tzf "$tmp_test" &>/dev/null; then
        rm -f "$tmp_test"
        error "Decrypted archive is not a valid tar.gz."; unset bak_pass; pause; return
    fi
    success "Password verified — archive is valid."
    echo ""

    echo -e "  ${RED}${BOLD}⚠ This will overwrite:${RESET}"
    echo -e "  ${RED}  $DROP_DB${RESET}"
    echo -e "  ${RED}  $DROP_CONF${RESET}"
    [[ -f "$DROP_PASS" ]] && echo -e "  ${RED}  $DROP_PASS${RESET}"
    echo ""
    echo -ne "  Type ${BOLD}RESTORE${RESET} to confirm: "
    local confirm; read -r confirm || true
    if [[ "$confirm" != "RESTORE" ]]; then
        rm -f "$tmp_test"; unset bak_pass; info "Cancelled."; pause; return
    fi

    # Stop service
    if systemctl is-active --quiet "$DROP_SERVICE" 2>/dev/null; then
        info "Stopping $DROP_SERVICE ..."
        systemctl stop "$DROP_SERVICE"
    fi

    # Extract
    local tmp_dir="/tmp/grin_drop_restore_$$"
    mkdir -p "$tmp_dir"
    tar -xzf "$tmp_test" -C "$tmp_dir" 2>/dev/null
    rm -f "$tmp_test"
    unset bak_pass

    # Restore files
    [[ -f "$tmp_dir/drop.db" ]] && {
        cp "$tmp_dir/drop.db" "$DROP_DB"
        chmod 600 "$DROP_DB"
        id grin &>/dev/null && chown grin:grin "$DROP_DB" 2>/dev/null || true
        success "Database restored."
    }
    [[ -f "$tmp_dir/grin_drop.conf" ]] && {
        cp "$tmp_dir/grin_drop.conf" "$DROP_CONF"
        chmod 600 "$DROP_CONF"
        id grin &>/dev/null && chown grin:grin "$DROP_CONF" 2>/dev/null || true
        success "Config restored."
    }
    [[ -f "$tmp_dir/wallet_pass" ]] && {
        cp "$tmp_dir/wallet_pass" "$DROP_PASS"
        chmod 600 "$DROP_PASS"
        id grin &>/dev/null && chown grin:grin "$DROP_PASS" 2>/dev/null || true
        success "Wallet passphrase file restored."
    }
    [[ -f "$tmp_dir/seed-words" ]] && {
        cp "$tmp_dir/seed-words" "$DROP_WORD"
        chmod 600 "$DROP_WORD"
        chown root:root "$DROP_WORD" 2>/dev/null || true
        success "Seed words file restored."
    }

    rm -rf "$tmp_dir"

    # Restart service
    if [[ -f "/etc/systemd/system/${DROP_SERVICE}.service" ]]; then
        systemctl start "$DROP_SERVICE" && success "Service restarted." \
            || warn "Service failed to start — check logs."
    fi

    echo ""
    warn "Note: wallet listener sessions are NOT restored — run option 2) Wallet Listening."
    log "[drop_restore] network=$DROP_NETWORK backup=$(basename "$chosen")"
    pause
}
