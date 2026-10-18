# =============================================================================
# 07_lib_pool_cleanup.sh — Full cleanup of the public pool script (menu Z): destructive, kept apart from the other sections.
# =============================================================================
# Sourced by 07_grin_mining_public_pool.sh after the POOL_* constants; shares its globals and log/info/warn/error.
# Trap: moved as-is; runs with errexit off (callers guard with `|| true`), so its file operations are not individually guarded.

# ═══════════════════════════════════════════════════════════════════════════════
# Z) CLEANUP — remove the public-pool footprint (any mode) for fast rebuild tests
# ═══════════════════════════════════════════════════════════════════════════════
# Mirrors solo_cleanup (07_grin_mining_solo.sh): preview with present/absent
# marks, a master confirm, then per-group confirms — nothing runs until the
# master Y. Removes whatever GRINIUM roles are on this box — brain (single-server
# / Central Hub), regional gateway, and/or any legacy satellite — WITHOUT touching
# anything the node or wallet needs, so an operator can rebuild from scratch quickly.
#
# REMOVED (per-group confirm):  systemd services + units, pool app dir (incl.
#   pool.db + .wallet_pass), gateway app + WireGuard tunnel (+ legacy satellite dir),
#   web root + nginx vhost + rate-limit zones conf, cron jobs + logrotate +
#   backup wrapper, JSON configs, service logs.
# PRESERVED (never touched):    the Grin node + chain data + grin-server.toml
#   (stratum config left as-is — the next install reuses it), the wallet dir +
#   SEED, and the backups in /opt/grin/backups/. To wipe those, use Script 08del.

# Present/absent marker for the cleanup preview list.
_pool_cleanup_mark() {
    if [[ -e "$1" ]]; then echo -e "${YELLOW}present${RESET}"; else echo -e "${DIM}absent${RESET}"; fi
}

pool_cleanup() {
    clear
    # Gateway paths (GW_*) live in the gateway lib — sourcing here is safe and idempotent
    # (constants + function definitions only).
    # shellcheck source=lib/07_lib_gateway.sh
    source "$SCRIPT_DIR/lib/07_lib_gateway.sh"

    # Legacy SATELLITE footprint (role removed in the Model C refactor; its lib is gone).
    # Hardcoded so a box that ran the old satellite can still be cleaned up here.
    local SAT_SERVICE="grin-satellite"
    local SAT_CONF="/opt/grin/conf/grin_satellite.json"
    local SAT_APP_DIR="/opt/grin/satellite"
    local SAT_LOG="/opt/grin/logs/grin-satellite.log"

    local pool_unit="/etc/systemd/system/${POOL_SERVICE}.service"
    local sat_unit="/etc/systemd/system/${SAT_SERVICE}.service"
    local gw_unit="/etc/systemd/system/${GW_SERVICE}.service"
    local cron_backup="/etc/cron.d/${POOL_SERVICE}-backup"
    local cron_vacuum="/etc/cron.d/${POOL_SERVICE}-vacuum"
    local backup_wrapper="/usr/local/bin/grin-pool-backup-${POOL_NET}"
    local logrotate_conf="/etc/logrotate.d/${POOL_SERVICE}"
    local zones_conf="/etc/nginx/conf.d/script07-${POOL_SERVICE}.conf"
    # Security-header snippets written by pool_setup_nginx (audit §I1 (script07_security_audit_archive.md)/§I2 (script07_security_audit_archive.md)). They live in
    # /etc/nginx/snippets/, which nothing else on the box sweeps — 08del only walks
    # sites-available/sites-enabled — so cleanup has to name them explicitly or they outlive
    # the pool. Removed in the same rm as the vhost that includes them, never before it:
    # a snippet deleted while a live vhost still has "include" for it fails nginx -t.
    local hdr_common="/etc/nginx/snippets/script07-${POOL_SERVICE}-headers.conf"
    local hdr_page="/etc/nginx/snippets/script07-${POOL_SERVICE}-page-headers.conf"
    local hdr_admin="/etc/nginx/snippets/script07-${POOL_SERVICE}-admin-headers.conf"
    local backup_dir="/opt/grin/backups/${POOL_SERVICE}"
    local f2b_filter="/etc/fail2ban/filter.d/grin-pool-login.conf"
    local f2b_jail="/etc/fail2ban/jail.d/grin-pool.conf"
    local f2b_purge="/etc/fail2ban/fail2ban.d/grin-pool-dbpurgeage.conf"

    echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${RED}  Clean Up Public Mining Pool${RESET}  ${DIM}(rebuild from scratch quickly)${RESET}"
    echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Removes the GRINIUM footprint on this box — brain (single-server / Central"
    echo -e "  Hub), regional gateway, and/or any legacy satellite. The node, your wallet"
    echo -e "  seed, and your backups are ${BOLD}kept${RESET} — confirm each group below."
    echo ""
    echo -e "  ${BOLD}Will be removed${RESET} ${DIM}(if you confirm the group):${RESET}"
    echo -e "    Pool service unit           $(_pool_cleanup_mark "$pool_unit")"
    echo -e "    Gateway service unit        $(_pool_cleanup_mark "$gw_unit")"
    echo -e "    Legacy satellite unit       $(_pool_cleanup_mark "$sat_unit")"
    pgs_cleanup_marks
    echo -e "    Pool app + DB               $(_pool_cleanup_mark "$POOL_APP_DIR")"
    echo -e "    Gateway app + wg tunnel     $(_pool_cleanup_mark "$GW_DIR")"
    echo -e "    Legacy satellite app dir    $(_pool_cleanup_mark "$SAT_APP_DIR")"
    echo -e "    Web root + nginx vhost      $(_pool_cleanup_mark "$POOL_NGINX_CONF")"
    echo -e "    Nginx header snippets       $(_pool_cleanup_mark "$hdr_common")"
    echo -e "    Cron / logrotate / wrapper  $(_pool_cleanup_mark "$cron_backup")"
    echo -e "    Pool config (JSON)          $(_pool_cleanup_mark "$POOL_CONF")"
    echo -e "    Gateway config (JSON)       $(_pool_cleanup_mark "$GW_CONF")"
    echo -e "    Legacy satellite config     $(_pool_cleanup_mark "$SAT_CONF")"
    echo -e "    Service logs                $(_pool_cleanup_mark "$POOL_LOG")"
    echo -e "    Fail2ban jail + filter      $(_pool_cleanup_mark "$f2b_jail")"
    echo ""
    echo -e "  ${BOLD}${GREEN}Kept — never touched:${RESET}"
    echo -e "    ${DIM}Grin node + chain data · grin-server.toml (stratum config as-is)${RESET}"
    echo -e "    ${DIM}Wallet dir + seed · pool backups ($backup_dir)${RESET}"
    echo -e "    ${DIM}(use Script 08del for a full wipe including those)${RESET}"
    echo ""
    echo -ne "${BOLD}Proceed with public-pool cleanup? [Y/n]: ${RESET}"
    local go; read -r go || true
    [[ "${go,,}" != "n" ]] || { info "Cancelled — nothing changed."; return; }
    echo ""

    local a svc
    # 1) systemd services + unit files
    echo -ne "${BOLD}1)${RESET} Stop + remove services ($POOL_SERVICE, $SAT_SERVICE, $GW_SERVICE)? [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        for svc in "$POOL_SERVICE" "$SAT_SERVICE" "$GW_SERVICE"; do
            systemctl stop "$svc" 2>/dev/null || true
            systemctl disable "$svc" 2>/dev/null || true
        done
        rm -f "$pool_unit" "$sat_unit" "$gw_unit"
        systemctl daemon-reload 2>/dev/null || true
        success "Services stopped, disabled, units removed."
        log "Cleanup: removed $POOL_SERVICE + $SAT_SERVICE + $GW_SERVICE services"
    fi
    echo ""

    # 1b) /play/ games service (07_lib_pool_games.sh): service, unit, nginx snippet + zones,
    #     web + code dirs, logrotate, VACUUM cron, link secret. Its database sits behind its
    #     own [y/N] (1c), default KEEP — it is player history, not rebuildable state.
    #     Runs before 4) so its nginx test still sees the pool vhost it was included from.
    pgs_cleanup_group "1b" "1c" || true

    # 2) Pool app dir — includes pool.db (miner balances!) and .wallet_pass.
    # legacy_app: pre-rename installs used /opt/grin/pool — sweep it too.
    local legacy_app="/opt/grin/pool"
    if [[ -d "$POOL_APP_DIR" || -d "$legacy_app" ]]; then
        echo -e "   ${YELLOW}⚠ $POOL_APP_DIR includes pool.db (miner balances) + .wallet_pass.${RESET}"
        echo -e "   ${DIM}Backups in $backup_dir are kept — run B) Backup first if unsure.${RESET}"
        echo -ne "${BOLD}2)${RESET} Remove pool app + database ($POOL_APP_DIR)? [Y/n]: "
        read -r a || true
        if [[ "${a,,}" != "n" ]]; then
            rm -rf "${POOL_APP_DIR:?}"
            rm -f "$POOL_RESTART_MARK" "$POOL_DEPS_STAMP" 2>/dev/null || true   # deploy state beside it
            [[ -d "$legacy_app" ]] && { rm -rf "${legacy_app:?}"; info "Legacy app dir removed ($legacy_app)."; }
            success "Pool app + database removed."
            log "Cleanup: removed $POOL_APP_DIR (+ legacy $legacy_app if present)"
        fi
        echo ""
    fi

    # 3) Legacy satellite app dir (removed role) — staging + relay failover SQLite
    if [[ -d "$SAT_APP_DIR" ]]; then
        echo -ne "${BOLD}3)${RESET} Remove legacy satellite app + staging DB ($SAT_APP_DIR)? [Y/n]: "
        read -r a || true
        if [[ "${a,,}" != "n" ]]; then
            rm -rf "${SAT_APP_DIR:?}"
            success "Legacy satellite app + staging DB removed."
            log "Cleanup: removed $SAT_APP_DIR"
        fi
        echo ""
    fi

    # 3b) Gateway app dir (edge box) AND/OR the central WireGuard server for THIS network.
    #     Edge: GW_DIR + GW_WG_CONF (wg-grinpool). Central: this script's WG_* (network-aware:
    #     wg-grinpool / wg-grinpool-tn). Bring down + remove whichever is present.
    if [[ -d "$GW_DIR" || -f "$GW_WG_CONF" || -f "$WG_CONF" || -d "$WG_DIR_CONF" ]]; then
        echo -ne "${BOLD}3b)${RESET} Remove gateway app + WireGuard tunnels (edge $GW_WG_IFACE / central $WG_IFACE)? [Y/n]: "
        read -r a || true
        if [[ "${a,,}" != "n" ]]; then
            local ifc
            for ifc in "$GW_WG_IFACE" "$WG_IFACE"; do
                wg-quick down "$ifc" 2>/dev/null || true
                systemctl disable "wg-quick@${ifc}" 2>/dev/null || true
            done
            # The gateway's re-resolve timer would otherwise keep firing every 60 s
            # against a conf that no longer exists.
            if declare -F gw_remove_reresolve >/dev/null 2>&1; then gw_remove_reresolve || true; fi
            # Same for the latency probe: its unit, certbot hook and certificate live outside
            # GW_DIR, and certbot would keep binding :80 to renew the cert every ~60 days.
            if declare -F gw_probe_remove >/dev/null 2>&1; then gw_probe_remove || true; fi
            rm -f "$GW_WG_CONF" "$WG_CONF"
            rm -rf "${GW_DIR:?}" "$WG_DIR_CONF"
            success "Gateway app + WireGuard tunnels removed."
            log "Cleanup: removed $GW_DIR + $GW_WG_CONF + $WG_CONF + $WG_DIR_CONF"
        fi
        echo ""
    fi

    # 4) Web root + nginx vhost + rate-limit zones conf
    echo -ne "${BOLD}4)${RESET} Remove web files + nginx vhost ($(basename "$POOL_NGINX_CONF"))? [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        local conf_name; conf_name=$(basename "$POOL_NGINX_CONF")
        # Also drop the pre-rename legacy vhost (grin-pool / grin-pool-testnet) if present.
        local legacy_name=""; [[ -n "${POOL_NGINX_CONF_LEGACY:-}" ]] && legacy_name=$(basename "$POOL_NGINX_CONF_LEGACY")
        if command -v nginx &>/dev/null && [[ -e "/etc/nginx/sites-enabled/$conf_name" || -f "$POOL_NGINX_CONF" ]]; then
            nginx_disable_site "$conf_name" || true
            [[ -n "$legacy_name" ]] && nginx_disable_site "$legacy_name" || true
            rm -f "$POOL_NGINX_CONF" "$POOL_NGINX_CONF_LEGACY" "$zones_conf" "$hdr_common" "$hdr_page" "$hdr_admin"
            nginx_test_reload "after removing $conf_name vhost" || true
        else
            # nginx absent (or only a dangling symlink left) — remove files directly
            rm -f "/etc/nginx/sites-enabled/$conf_name" "$POOL_NGINX_CONF" "$zones_conf" "$hdr_common" "$hdr_page" "$hdr_admin"
            [[ -n "$legacy_name" ]] && rm -f "/etc/nginx/sites-enabled/$legacy_name" "$POOL_NGINX_CONF_LEGACY" || true
        fi
        rm -rf "${POOL_WEB_DIR:?}"
        success "Web files + vhost + rate-limit zones + header snippets removed."
        info "Any TLS cert under /etc/letsencrypt is left in place (harmless) — 'certbot delete' to drop it."
        log "Cleanup: removed $POOL_WEB_DIR, $POOL_NGINX_CONF, $zones_conf, $hdr_common, $hdr_page, $hdr_admin"
    fi
    echo ""

    # 5) Cron jobs + logrotate + backup wrapper + wallet listeners/watchdog/autostart.
    #    The wallet SEED dir is kept (it holds coinbase funds) — we only stop the
    #    runtime listeners and remove their watchdog + @reboot autostart.
    echo -ne "${BOLD}5)${RESET} Remove cron + logrotate + wrapper + stop wallet listeners? [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        rm -f "$cron_backup" "$cron_vacuum" "$backup_wrapper" "$logrotate_conf" "$POOL_ADMIN_RESET_BIN"
        # De-root artifacts (§13.9): scoped sudoers + pairing helper — but ONLY
        # when the other network's pool isn't still installed on this box (both
        # nets share the helper + sudoers). The grinpool user itself is kept.
        local other_conf="/opt/grin/conf/grin_pubpool.json"
        [[ "$POOL_NET" == "mainnet" ]] && other_conf="/opt/grin/conf/grin_pubpool_testnet.json"
        if [[ ! -f "$other_conf" ]]; then
            rm -f /etc/sudoers.d/grin-pool-gwctl "$GWCTL_BIN" 2>/dev/null || true
        fi
        pw_listener_stop   2>/dev/null || true
        pw_watchdog_remove 2>/dev/null || true
        pw_autostart_disable 2>/dev/null || true
        success "Cron + logrotate + wrapper + gwctl helper/sudoers removed; wallet listeners stopped, watchdog + autostart removed."
        info "Wallet seed dir ($(pw_wallet_dir)) kept — it holds the coinbase funds."
        log "Cleanup: removed $cron_backup, $cron_vacuum, $backup_wrapper, $logrotate_conf, $POOL_ADMIN_RESET_BIN, gwctl helper/sudoers + wallet listeners/watchdog/autostart"
    fi
    echo ""

    # 6) JSON configs (pool + satellite + gateway + pre-rename legacy grin_pool.json)
    echo -ne "${BOLD}6)${RESET} Remove configs ($POOL_CONF, $SAT_CONF, $GW_CONF)? [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        rm -f "$POOL_CONF" "$SAT_CONF" "$GW_CONF" "/opt/grin/conf/grin_pool.json"
        success "Configs removed."
        log "Cleanup: removed $POOL_CONF + $SAT_CONF + $GW_CONF (+ legacy grin_pool.json)"
    fi
    echo ""

    # 7) Service logs (pool, satellite, nginx access/error)
    echo -ne "${BOLD}7)${RESET} Remove service logs? [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        rm -f "$POOL_LOG" "$POOL_LOG".* "$SAT_LOG" "$SAT_LOG".* "$GW_LOG" "$GW_LOG".* 2>/dev/null || true
        rm -f "/var/log/nginx/${POOL_SERVICE}-access.log"* "/var/log/nginx/${POOL_SERVICE}-error.log"* 2>/dev/null || true
        success "Service logs removed."
        log "Cleanup: removed pool/satellite/nginx logs"
    fi
    echo ""

    # 8) Fail2ban login-guard jail + filter (written by 1) Install). Must go when the
    #    pool does: step 7 deletes the watched access log, and a jail with a missing
    #    logpath stops fail2ban from starting — taking every other jail down with it.
    #    fail2ban itself stays installed (other services may have their own jails).
    if [[ -f "$f2b_jail" || -f "$f2b_filter" || -f "$f2b_purge" ]]; then
        echo -ne "${BOLD}8)${RESET} Remove fail2ban login-guard jail + filter? [Y/n]: "
        read -r a || true
        if [[ "${a,,}" != "n" ]]; then
            # Also drops the dbpurgeage override — it only exists to serve this jail's
            # long bantime, and leaving it behind silently changes ban retention for
            # every OTHER jail on the box.
            rm -f "$f2b_jail" "$f2b_filter" "$f2b_purge"
            if systemctl is-active --quiet fail2ban 2>/dev/null; then
                systemctl restart fail2ban 2>/dev/null \
                    && success "fail2ban restarted without the pool jail." \
                    || warn "fail2ban restart failed — inspect: journalctl -u fail2ban -n 30"
            fi
            success "Fail2ban jail + filter removed."
            log "Cleanup: removed $f2b_jail + $f2b_filter + $f2b_purge"
        fi
        echo ""
    fi

    success "Public-pool cleanup complete."
    echo -e "  ${BOLD}${GREEN}Kept:${RESET} node + chain data · grin-server.toml (stratum config as-is)"
    echo -e "        wallet dir + seed · pool backups ($backup_dir)"
    echo -e "  ${DIM}Ready for a fresh install — pick a mode and run Install again.${RESET}"
}
