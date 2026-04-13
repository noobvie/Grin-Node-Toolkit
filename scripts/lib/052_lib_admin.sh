# 052_lib_admin.sh — Grin Drop admin operations
# Sourced by 052_grin_drop.sh — inherits all color/log/network variables.
# =============================================================================
#
#  Functions exported:
#    drop_deploy_web       — step 5: copy web files + npm install
#    drop_service_control  — step 6: start/stop/enable systemd service
#    drop_status_screen    — step 7: detailed health + stats
#    drop_wallet_address   — step 8: show + update wallet address
#    drop_view_logs        — L) tail activity log
#    drop_backup           — B) encrypt both networks → single archive
#    drop_restore          — R) decrypt + restore archive (both networks)
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

    # Deploy public_html — app.js resolves PUBLIC_DIR as $DROP_APP_DIR/public_html/
    local pub_dir="$DROP_APP_DIR/public_html"
    info "Copying $DROP_WEB_SRC → $pub_dir ..."
    mkdir -p "$pub_dir"
    cp -r "$DROP_WEB_SRC"/. "$pub_dir/"
    find "$pub_dir" -type f \( -name "*.html" -o -name "*.css" -o -name "*.js" \) \
        -exec chmod 644 {} \;
    success "Web files deployed to $pub_dir"

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
    local domain_val; domain_val=$(_shared_read "subdomain" "")
    cat > "$pub_dir/robots.txt" << ROBOTS_EOF
User-agent: *
Disallow: /api/
Allow: /

Sitemap: https://${domain_val}/sitemap.xml
ROBOTS_EOF
    success "robots.txt generated."

    # ── Permissions — entire app directory ────────────────────────────────────
    if id grin &>/dev/null; then
        info "Fixing ownership: chown -R grin:grin $DROP_APP_DIR ..."
        chown -R grin:grin "$DROP_APP_DIR"

        # public_html served by nginx (needs traverse): dirs 755, files 644
        find "$DROP_APP_DIR/public_html" -type d -exec chmod 755 {} \; 2>/dev/null || true
        find "$DROP_APP_DIR/public_html" -type f -exec chmod 644 {} \; 2>/dev/null || true

        # Sensitive files — owner-only (grin:grin 600/640)
        chmod 600 "$DROP_CONF"                                       2>/dev/null || true
        chmod 600 "$DROP_DB"                                         2>/dev/null || true
        chmod 640 "$DROP_LOG"                                        2>/dev/null || true
        chmod 600 "$DROP_WALLET_DIR/.foreign_api_secret"              2>/dev/null || true
        chmod 600 "$DROP_WALLET_DIR/.owner_api_secret"               2>/dev/null || true

        success "Ownership/permissions applied to $DROP_APP_DIR"
    else
        warn "User 'grin' not found — skipping chown (running as $USER)"
    fi

    # Unified homepage — served directly by nginx (www-data), not by Node.js
    # /var/www/grin-drop-home/ → https://domain/  (nginx root)
    # /opt/grin/drop-test/public_html/ → https://domain/testnet/  (Node.js proxy)
    local _home_dir="/var/www/grin-drop-home"
    if [[ -d "$_home_dir" ]]; then
        chown -R www-data:www-data "$_home_dir" 2>/dev/null || true
        find "$_home_dir" -type d -exec chmod 755 {} \;
        find "$_home_dir" -type f -exec chmod 644 {} \;
        success "Unified homepage permissions fixed: $_home_dir"
    fi

    if systemctl is-active --quiet "$DROP_SERVICE" 2>/dev/null; then
        info "Restarting $DROP_SERVICE to pick up new files..."
        systemctl restart "$DROP_SERVICE" && success "Service restarted."
    fi

    log "[drop_deploy_web] network=$DROP_NETWORK"
    pause
}

# =============================================================================
# OPTION 6 — Start / Stop service
# =============================================================================

drop_service_control() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — 6) Start / Stop Service ──${RESET}\n"

    if [[ ! -f "/etc/systemd/system/${DROP_SERVICE}.service" ]]; then
        die "Service not installed — run option 3 (Install) first."; pause; return
    fi

    local state="stopped"
    systemctl is-active  --quiet "$DROP_SERVICE" 2>/dev/null && state="running"

    local boot_enabled="no"
    systemctl is-enabled --quiet "$DROP_SERVICE" 2>/dev/null && boot_enabled="yes"

    local boot_label
    [[ "$boot_enabled" == "yes" ]] \
        && boot_label="${GREEN}enabled${RESET}" \
        || boot_label="${YELLOW}disabled${RESET}"

    if [[ "$state" == "running" ]]; then
        echo -e "  Service   : ${GREEN}● running${RESET}"
    else
        echo -e "  Service   : ${YELLOW}stopped${RESET}"
    fi
    echo -e "  Boot start: $boot_label"
    echo ""

    if [[ "$state" == "running" ]]; then
        echo -e "  ${RED}1${RESET}) Stop service"
        echo -e "  ${YELLOW}2${RESET}) Restart service"
    else
        echo -e "  ${GREEN}1${RESET}) Start service"
    fi

    if [[ "$boot_enabled" == "yes" ]]; then
        echo -e "  ${YELLOW}e${RESET}) Disable auto-start on boot"
    else
        echo -e "  ${GREEN}e${RESET}) Enable auto-start on boot"
    fi
    echo -e "  ${DIM}0) Back${RESET}"
    echo ""
    echo -ne "${BOLD}Select [1/2/e/0]: ${RESET}"
    read -r sc || true

    case "$sc" in
        1)
            if [[ "$state" == "running" ]]; then
                systemctl stop "$DROP_SERVICE" && success "Service stopped."
            else
                systemctl start "$DROP_SERVICE" && success "Service started." \
                    || warn "Start failed — check: journalctl -u $DROP_SERVICE -n 30"
            fi
            ;;
        2)
            if [[ "$state" == "running" ]]; then
                systemctl restart "$DROP_SERVICE" && success "Service restarted."
            fi
            ;;
        e|E)
            if [[ "$boot_enabled" == "yes" ]]; then
                systemctl disable "$DROP_SERVICE" 2>/dev/null && success "Auto-start on boot disabled."
            else
                systemctl enable  "$DROP_SERVICE" 2>/dev/null && success "Auto-start on boot enabled."
            fi
            ;;
        0) return ;;
    esac
    pause
}

# =============================================================================
# OPTION 7 — Drop status
# =============================================================================

drop_status_screen() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} Grin Drop [$DROP_NET_LABEL] — 7) Status${RESET}"
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
    local subdomain; subdomain=$(_shared_read "subdomain" "")
    echo -e "  ${BOLD}Port${RESET}       : $port"
    [[ -n "$subdomain" ]] && echo -e "  ${BOLD}URL${RESET}        : ${GREEN}https://$subdomain/${DROP_NETWORK}/${RESET}"

    local admin_path; admin_path=$(drop_read_conf "admin_secret_path" "")
    if [[ -n "$admin_path" && -n "$subdomain" ]]; then
        echo -e "  ${BOLD}Admin URL${RESET}  : ${YELLOW}https://$subdomain/${DROP_NETWORK}/$admin_path/admin/${RESET}"
    fi

    # Wallet tmux sessions
    echo ""
    tmux has-session -t "$DROP_TMUX_TOR" 2>/dev/null \
        && echo -e "  ${BOLD}TOR session${RESET}  : ${GREEN}● running${RESET}  (tmux: $DROP_TMUX_TOR)" \
        || echo -e "  ${BOLD}TOR session${RESET}  : ${RED}not running${RESET}  ${DIM}(run option 2)${RESET}"
    tmux has-session -t "$DROP_TMUX_OWNER" 2>/dev/null \
        && echo -e "  ${BOLD}Owner session${RESET}: ${GREEN}● running${RESET}  (tmux: $DROP_TMUX_OWNER)" \
        || echo -e "  ${BOLD}Owner session${RESET}: ${RED}not running${RESET}  ${DIM}(run option 2)${RESET}"

    ss -tlnp 2>/dev/null | grep -q ":${DROP_TOR_PORT} " \
        && echo -e "  ${BOLD}Port :${DROP_TOR_PORT}${RESET}   : ${GREEN}listening${RESET}" \
        || echo -e "  ${BOLD}Port :${DROP_TOR_PORT}${RESET}   : ${DIM}not listening${RESET}"
    ss -tlnp 2>/dev/null | grep -q ":${DROP_OWNER_PORT} " \
        && echo -e "  ${BOLD}Port :${DROP_OWNER_PORT}${RESET}  : ${GREEN}listening${RESET}" \
        || echo -e "  ${BOLD}Port :${DROP_OWNER_PORT}${RESET}  : ${DIM}not listening${RESET}"

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
# OPTION 8 — Wallet address
# =============================================================================

drop_wallet_address() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — 8) Wallet Address ──${RESET}\n"

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
            local _d; _d=$(_shared_read "subdomain" "")
            local f="/var/log/nginx/grin-drop-${_d:-unknown}-access.log"
            [[ -f "$f" ]] && tail -n 100 "$f" | less -FRX || { warn "Not found: $f"; pause; }
            ;;
        4)
            local _d; _d=$(_shared_read "subdomain" "")
            local f="/var/log/nginx/grin-drop-${_d:-unknown}-error.log"
            [[ -f "$f" ]] && tail -n 100 "$f" | less -FRX || { warn "Not found: $f"; pause; }
            ;;
        0) return ;;
    esac
}

# =============================================================================
# OPTION B (top-level) — Backup both networks
# =============================================================================

drop_backup() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop — B) Backup (Testnet + Mainnet) ──${RESET}\n"
    echo -e "  ${DIM}Creates a single AES-256-CBC encrypted archive containing:${RESET}"
    echo -e "  ${DIM}  Testnet : DB, config, wallet passphrase, seed words${RESET}"
    echo -e "  ${DIM}  Mainnet : DB, config, wallet passphrase, seed words${RESET}"
    echo -e "  ${DIM}  Shared  : drop_shared.conf (domain settings)${RESET}"
    echo ""

    mkdir -p "$BACKUP_DIR"

    local ts; ts=$(date +%Y%m%d_%H%M%S)
    local archive_name="grin_drop_all_backup_${ts}.tar.gz.enc"
    local archive_path="$BACKUP_DIR/$archive_name"
    local tmp_dir="/tmp/grin_drop_backup_$$"
    mkdir -p "$tmp_dir/testnet" "$tmp_dir/mainnet" "$tmp_dir/shared"

    # Testnet files
    [[ -f "/opt/grin/drop-test/drop-test.db" ]]          && cp "/opt/grin/drop-test/drop-test.db"          "$tmp_dir/testnet/drop.db"
    [[ -f "/opt/grin/drop-test/grin_drop_test.conf" ]]   && cp "/opt/grin/drop-test/grin_drop_test.conf"   "$tmp_dir/testnet/grin_drop.conf"
    [[ -f "/opt/grin/drop-test/.temp_test" ]]            && cp "/opt/grin/drop-test/.temp_test"            "$tmp_dir/testnet/wallet_pass"
    [[ -f "/opt/grin/drop-test/.word_test" ]]            && cp "/opt/grin/drop-test/.word_test"            "$tmp_dir/testnet/seed-words"

    # Mainnet files
    [[ -f "/opt/grin/drop-main/drop-main.db" ]]          && cp "/opt/grin/drop-main/drop-main.db"          "$tmp_dir/mainnet/drop.db"
    [[ -f "/opt/grin/drop-main/grin_drop_main.conf" ]]   && cp "/opt/grin/drop-main/grin_drop_main.conf"   "$tmp_dir/mainnet/grin_drop.conf"
    [[ -f "/opt/grin/drop-main/.temp_main" ]]            && cp "/opt/grin/drop-main/.temp_main"            "$tmp_dir/mainnet/wallet_pass"
    [[ -f "/opt/grin/drop-main/.word_main" ]]            && cp "/opt/grin/drop-main/.word_main"            "$tmp_dir/mainnet/seed-words"

    # Shared config
    [[ -f "$DROP_SHARED_CONF" ]] && cp "$DROP_SHARED_CONF" "$tmp_dir/shared/drop_shared.conf"

    local has_files=0
    find "$tmp_dir" -type f | grep -q . && has_files=1
    if [[ "$has_files" -eq 0 ]]; then
        warn "No files found to backup — run setup for at least one network first."
        rm -rf "$tmp_dir"; pause; return
    fi

    echo -e "  ${DIM}Files staged:${RESET}"
    find "$tmp_dir" -type f | sort | while read -r f; do
        echo -e "    ${DIM}${f#$tmp_dir/}${RESET}"
    done
    echo ""

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
    local count; count=$(ls "$BACKUP_DIR/grin_drop_all_backup_"*.enc 2>/dev/null | wc -l)
    if [[ "$count" -gt "$BACKUP_KEEP" ]]; then
        ls -t "$BACKUP_DIR/grin_drop_all_backup_"*.enc \
            | tail -n +"$((BACKUP_KEEP + 1))" \
            | xargs rm -f 2>/dev/null || true
        info "Old backups pruned (kept last $BACKUP_KEEP)."
    fi

    log "[drop_backup] archive=$archive_name"
    pause
}

# =============================================================================
# OPTION R (top-level) — Restore both networks
# =============================================================================

drop_restore() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop — R) Restore (Testnet + Mainnet) ──${RESET}\n"

    local -a bak_files
    mapfile -t bak_files < <(ls -t "$BACKUP_DIR/grin_drop_all_backup_"*.enc 2>/dev/null || true)

    if [[ "${#bak_files[@]}" -eq 0 ]]; then
        warn "No backups found in $BACKUP_DIR."
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

    # Decrypt + validate
    echo -ne "  Backup password: "
    local bak_pass; read -rs bak_pass; echo ""
    local tmp_test="/tmp/grin_drop_restore_test_$$"
    if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
        -pass "pass:${bak_pass}" -in "$chosen" -out "$tmp_test" 2>/dev/null; then
        rm -f "$tmp_test"; error "Wrong password or corrupt backup."; unset bak_pass; pause; return
    fi
    if ! tar -tzf "$tmp_test" &>/dev/null; then
        rm -f "$tmp_test"; error "Decrypted archive is not a valid tar.gz."; unset bak_pass; pause; return
    fi
    success "Password verified — archive is valid."
    echo ""

    # Show what will be restored
    echo -e "  ${RED}${BOLD}⚠ This will overwrite existing data for any networks found in the backup:${RESET}"
    tar -tzf "$tmp_test" 2>/dev/null | grep -v '/$' | while read -r f; do
        echo -e "  ${RED}  → $f${RESET}"
    done
    echo ""
    echo -ne "  Type ${BOLD}RESTORE${RESET} to confirm: "
    local confirm; read -r confirm || true
    if [[ "$confirm" != "RESTORE" ]]; then
        rm -f "$tmp_test"; unset bak_pass; info "Cancelled."; pause; return
    fi

    # Stop both services
    for svc in "grin-drop-test" "grin-drop-main"; do
        systemctl is-active --quiet "$svc" 2>/dev/null && {
            info "Stopping $svc ..."; systemctl stop "$svc"
        }
    done

    local tmp_dir="/tmp/grin_drop_restore_$$"
    mkdir -p "$tmp_dir"
    tar -xzf "$tmp_test" -C "$tmp_dir" 2>/dev/null
    rm -f "$tmp_test"
    unset bak_pass

    # Restore testnet
    if [[ -d "$tmp_dir/testnet" ]]; then
        info "Restoring testnet ..."
        [[ -f "$tmp_dir/testnet/drop.db" ]]       && { cp "$tmp_dir/testnet/drop.db"       "/opt/grin/drop-test/drop-test.db";         chmod 600 "/opt/grin/drop-test/drop-test.db";         id grin &>/dev/null && chown grin:grin "/opt/grin/drop-test/drop-test.db" 2>/dev/null || true; success "Testnet DB restored."; }
        [[ -f "$tmp_dir/testnet/grin_drop.conf" ]] && { cp "$tmp_dir/testnet/grin_drop.conf" "/opt/grin/drop-test/grin_drop_test.conf"; chmod 600 "/opt/grin/drop-test/grin_drop_test.conf"; id grin &>/dev/null && chown grin:grin "/opt/grin/drop-test/grin_drop_test.conf" 2>/dev/null || true; success "Testnet config restored."; }
        [[ -f "$tmp_dir/testnet/wallet_pass" ]]   && { cp "$tmp_dir/testnet/wallet_pass"   "/opt/grin/drop-test/.temp_test";           chmod 600 "/opt/grin/drop-test/.temp_test";           id grin &>/dev/null && chown grin:grin "/opt/grin/drop-test/.temp_test" 2>/dev/null || true; success "Testnet wallet pass restored."; }
        [[ -f "$tmp_dir/testnet/seed-words" ]]    && { cp "$tmp_dir/testnet/seed-words"    "/opt/grin/drop-test/.word_test";           chmod 600 "/opt/grin/drop-test/.word_test";           chown root:root "/opt/grin/drop-test/.word_test" 2>/dev/null || true; success "Testnet seed words restored."; }
    fi

    # Restore mainnet
    if [[ -d "$tmp_dir/mainnet" ]]; then
        info "Restoring mainnet ..."
        [[ -f "$tmp_dir/mainnet/drop.db" ]]       && { cp "$tmp_dir/mainnet/drop.db"       "/opt/grin/drop-main/drop-main.db";         chmod 600 "/opt/grin/drop-main/drop-main.db";         id grin &>/dev/null && chown grin:grin "/opt/grin/drop-main/drop-main.db" 2>/dev/null || true; success "Mainnet DB restored."; }
        [[ -f "$tmp_dir/mainnet/grin_drop.conf" ]] && { cp "$tmp_dir/mainnet/grin_drop.conf" "/opt/grin/drop-main/grin_drop_main.conf"; chmod 600 "/opt/grin/drop-main/grin_drop_main.conf"; id grin &>/dev/null && chown grin:grin "/opt/grin/drop-main/grin_drop_main.conf" 2>/dev/null || true; success "Mainnet config restored."; }
        [[ -f "$tmp_dir/mainnet/wallet_pass" ]]   && { cp "$tmp_dir/mainnet/wallet_pass"   "/opt/grin/drop-main/.temp_main";           chmod 600 "/opt/grin/drop-main/.temp_main";           id grin &>/dev/null && chown grin:grin "/opt/grin/drop-main/.temp_main" 2>/dev/null || true; success "Mainnet wallet pass restored."; }
        [[ -f "$tmp_dir/mainnet/seed-words" ]]    && { cp "$tmp_dir/mainnet/seed-words"    "/opt/grin/drop-main/.word_main";           chmod 600 "/opt/grin/drop-main/.word_main";           chown root:root "/opt/grin/drop-main/.word_main" 2>/dev/null || true; success "Mainnet seed words restored."; }
    fi

    # Restore shared config
    [[ -f "$tmp_dir/shared/drop_shared.conf" ]] && {
        cp "$tmp_dir/shared/drop_shared.conf" "$DROP_SHARED_CONF"
        chmod 600 "$DROP_SHARED_CONF"
        success "Shared config (domain settings) restored."
    }

    rm -rf "$tmp_dir"

    # Restart services that have a service file
    for svc in "grin-drop-test" "grin-drop-main"; do
        [[ -f "/etc/systemd/system/${svc}.service" ]] && {
            systemctl start "$svc" && success "$svc restarted." \
                || warn "$svc failed to start — check logs."
        }
    done

    echo ""
    warn "Note: wallet listener sessions are NOT restored — run option 2) Wallet Listening for each network."
    log "[drop_restore] backup=$(basename "$chosen")"
    pause
}
