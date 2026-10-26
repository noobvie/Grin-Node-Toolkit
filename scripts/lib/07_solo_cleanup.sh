# 07_solo_cleanup.sh — full cleanup of the solo mining script (menu Z): destructive, kept apart from the other sections.
# Sourced by 07_grin_mining_solo.sh; shares its globals and log/info/warn/error.
# Moved as-is; callers reach these via `fn || …`, so errexit is off and file operations are not individually guarded.

# ═══════════════════════════════════════════════════════════════════════════════
# CLEANUP — REMOVE SOLO-MINING INFRA  (top menu ▸ Danger Zone ▸ C)
# ═══════════════════════════════════════════════════════════════════════════════
# Tears down everything Script 07 (solo) deploys so the server is a clean base for
# the public pool — WITHOUT touching anything the node or the public pool also
# needs. Each group is confirmed on its own; nothing runs until the master Y.
#
# REMOVED (per-group confirm):  stratum config (enable→false + firewall + restart),
#   stats collector + state dir, stats web page + nginx vhost, stratum/wallet
#   watchdogs, payout-split config, running wallet-listener tmux sessions.
# PRESERVED (never touched):    the Grin node + chain data (Script 01 / 08del own
#   that), the node-sync watchdog and boot autostart (the pool reuses them), the
#   wallet dir $SW_BASE (your SEED), and the encrypted backups in $SB_BACKUP_DIR
#   plus the backup key/schedule. To wipe those too, use Script 08del.

# Present/absent marker for the cleanup preview list.
_solo_cleanup_mark() {
    if [[ -e "$1" ]]; then echo -e "${YELLOW}present${RESET}"; else echo -e "${DIM}absent${RESET}"; fi
}

# Disable stratum in a net's grin-server.toml (silent resolve — no prompts) and
# close its firewall port. No-op when no toml is found for that net.
_solo_cleanup_stratum_net() {
    local net="$1" stratum_port="$2" api_port="$3" toml
    toml=$(_resolve_stratum_toml "$net" "$api_port" 2>/dev/null || true)
    if [[ -n "$toml" && -f "$toml" ]]; then
        if grep -qE '^#?[[:space:]]*enable_stratum_server[[:space:]]*=' "$toml" 2>/dev/null; then
            sed -i -E "s|^#?[[:space:]]*enable_stratum_server[[:space:]]*=.*|enable_stratum_server = false|" "$toml"
        fi
        success "$net: enable_stratum_server = false  ${DIM}($toml)${RESET}"
        log "Cleanup ($net): enable_stratum_server = false in $toml"
    else
        info "$net: no grin-server.toml found — stratum config left as-is."
    fi
    # Best-effort firewall close (mirrors Restrict). A per-IP allow added via the
    # "specific IP" path can't be matched here — remove it by hand if you want a
    # pristine ruleset (ufw status numbered / iptables -S).
    if command -v ufw &>/dev/null; then
        ufw delete allow "$stratum_port/tcp" 2>/dev/null \
            && success "$net: UFW allow for $stratum_port removed." || true
    elif command -v iptables &>/dev/null; then
        while iptables -D INPUT -p tcp --dport "$stratum_port" -j ACCEPT 2>/dev/null; do :; done
        if command -v netfilter-persistent &>/dev/null; then
            netfilter-persistent save 2>/dev/null || true
        elif [[ -d /etc/iptables ]]; then
            iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
        fi
        success "$net: iptables allow for $stratum_port removed."
    fi
}

solo_cleanup() {
    clear
    local conf_name="$STATS_BASENAME"
    local web_dir="/var/www/$STATS_BASENAME"
    local nginx_conf="/etc/nginx/sites-available/$STATS_BASENAME"

    echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${RED}  Clean Up Solo Mining${RESET}  ${DIM}(prep server for the public pool)${RESET}"
    echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Removes the solo-mining infrastructure. The node, your wallet seed,"
    echo -e "  and your backups are ${BOLD}kept${RESET} — confirm each group below."
    echo ""
    echo -e "  ${BOLD}Will be removed${RESET} ${DIM}(if you confirm the group):${RESET}"
    echo -e "    Stratum config (node toml)  ${DIM}enable→false + firewall${RESET}"
    echo -e "    Collector                   $(_solo_cleanup_mark "$BLOCK_COLLECTOR_WRAPPER")"
    echo -e "    Collector state dir         $(_solo_cleanup_mark "$BLOCK_COLLECTOR_STATE_DIR")"
    echo -e "    Stats web / nginx vhost     $(_solo_cleanup_mark "$nginx_conf")"
    echo -e "    Stratum watchdog            $(_solo_cleanup_mark "/etc/cron.d/grin-stratum-watchdog")"
    echo -e "    Wallet-listener watchdog    $(_solo_cleanup_mark "$SW_WATCHDOG_CRON")"
    echo -e "    Payout-split config         $(_solo_cleanup_mark "$PAYMENT_CONFIG")"
    echo ""
    echo -e "  ${BOLD}${GREEN}Kept — never touched:${RESET}"
    echo -e "    ${DIM}Grin node + chain data · node-sync watchdog · boot autostart${RESET}"
    echo -e "    ${DIM}Wallet seed ($SW_BASE) · backups ($SB_BACKUP_DIR) + key${RESET}"
    echo -e "    ${DIM}(use Script 08del for a full wipe including those)${RESET}"
    echo ""
    echo -ne "${BOLD}Proceed with solo-mining cleanup? [y/N]: ${RESET}"
    local go; read -r go || true
    [[ "${go,,}" == "y" ]] || { info "Cancelled — nothing changed."; return; }
    echo ""

    local a r
    # 1) Stratum config + firewall (+ optional node restart so it actually stops)
    echo -ne "${BOLD}1)${RESET} Disable stratum (both nets) + close ports $STRATUM_PORT_MAINNET/$STRATUM_PORT_TESTNET? [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        _solo_cleanup_stratum_net mainnet "$STRATUM_PORT_MAINNET" "$NODE_API_PORT_MAINNET" || true
        _solo_cleanup_stratum_net testnet "$STRATUM_PORT_TESTNET" "$NODE_API_PORT_TESTNET" || true
        echo -ne "   Restart running node(s) now so stratum actually stops? [y/N]: "
        read -r r || true
        if [[ "${r,,}" == "y" ]]; then
            graceful_restart_grin "$NODE_API_PORT_MAINNET" mainnet || true
            graceful_restart_grin "$NODE_API_PORT_TESTNET" testnet || true
        else
            info "Stratum stays up until the node next restarts."
        fi
    fi
    echo ""

    # 2) Stats collector + state
    echo -ne "${BOLD}2)${RESET} Remove stats collector + state dir ($BLOCK_COLLECTOR_STATE_DIR)? [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        rm -f "$BLOCK_COLLECTOR_BIN" "$BLOCK_COLLECTOR_WRAPPER" "$BLOCK_COLLECTOR_CRON"
        rm -rf "$BLOCK_COLLECTOR_STATE_DIR"
        # A node-sync watchdog deployed before the state-dir split still bakes
        # STATE_DIR=/opt/grin/solo-stats and would re-create this dir within
        # 5 min (cron), resurrecting the "solo is installed" detection. Re-run
        # the installer so the regenerated bin points at the node-scoped dir.
        if [[ -x "$GNK_WATCHDOG_BIN" ]] \
           && grep -q "STATE_DIR=\"$BLOCK_COLLECTOR_STATE_DIR\"" "$GNK_WATCHDOG_BIN" 2>/dev/null; then
            gnk_watchdog_install >/dev/null 2>&1 || true
            info "Node-sync watchdog re-pointed to $GNK_STATE_DIR (was re-creating $BLOCK_COLLECTOR_STATE_DIR)."
        fi
        success "Collector + state removed."
        log "Cleanup: removed collector bin/wrapper/cron + $BLOCK_COLLECTOR_STATE_DIR"
    fi
    echo ""

    # 3) Stats web page + nginx vhost
    echo -ne "${BOLD}3)${RESET} Remove stats web page + nginx vhost ($conf_name)? [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        if command -v nginx &>/dev/null && [[ -e "/etc/nginx/sites-enabled/$conf_name" || -f "$nginx_conf" ]]; then
            nginx_disable_site "$conf_name" || true
            rm -f "$nginx_conf"
            nginx_test_reload "after removing $conf_name vhost" || true
        fi
        rm -rf "$web_dir"
        rm -f "$STATS_HTPASSWD"
        success "Stats web page + vhost removed."
        info "Any TLS cert under /etc/letsencrypt is left in place (harmless) — 'certbot delete' to drop it."
        log "Cleanup: removed stats vhost $conf_name, $web_dir, $STATS_HTPASSWD"
    fi
    echo ""

    # 4) Watchdogs — stratum + wallet-listener ONLY (node-sync/autostart kept)
    echo -ne "${BOLD}4)${RESET} Remove stratum + wallet-listener watchdogs? [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        rm -f /etc/cron.d/grin-stratum-watchdog /usr/local/bin/grin-stratum-watchdog "$WATCHDOG_LOG"
        success "Stratum watchdog removed."
        sw_watchdog_remove || true
        rm -f "$SW_WATCHDOG_LOG" 2>/dev/null || true
        info "Node-sync watchdog + boot autostart left intact (the node/pool still need them)."
        log "Cleanup: removed stratum + wallet-listener watchdogs"
    fi
    echo ""

    # 4b) Quiet hours (energy saver) — cron + wrapper + conf; reopens the stratum
    #     port so cleanup never leaves miners locked out by a stale DROP rule.
    if [[ -f "$SQ_CRON" || -f "$SQ_WRAPPER" || -f "$SQ_CONF" ]]; then
        echo -ne "${BOLD}4b)${RESET} Remove quiet-hours schedule (energy saver) + reopen stratum? [Y/n]: "
        read -r a || true
        if [[ "${a,,}" != "n" ]]; then
            [[ -x "$SQ_WRAPPER" ]] && "$SQ_WRAPPER" resume >/dev/null 2>&1 || true
            rm -f "$SQ_CRON" "$SQ_WRAPPER" "$SQ_CONF" "$SQ_LOG"
            success "Quiet-hours schedule removed; stratum reopened."
            log "Cleanup: removed quiet-hours cron/wrapper/conf"
        fi
        echo ""
    fi

    # 5) Payout-split config
    if [[ -f "$PAYMENT_CONFIG" ]]; then
        echo -ne "${BOLD}5)${RESET} Remove payout-split config ($PAYMENT_CONFIG)? [Y/n]: "
        read -r a || true
        if [[ "${a,,}" != "n" ]]; then
            rm -f "$PAYMENT_CONFIG"
            success "Payout-split config removed."
            log "Cleanup: removed $PAYMENT_CONFIG"
        fi
        echo ""
    fi

    # 6) Running wallet-listener sessions — wallet dir + seed are KEPT
    echo -ne "${BOLD}6)${RESET} Stop running wallet-listener sessions? ${DIM}(seed/wallet kept)${RESET} [Y/n]: "
    read -r a || true
    if [[ "${a,,}" != "n" ]]; then
        sw_listener_stop mainnet || true
        sw_listener_stop testnet || true
    fi
    echo ""

    success "Solo-mining cleanup complete."
    echo -e "  ${BOLD}${GREEN}Kept:${RESET} node + chain data · node-sync watchdog · boot autostart"
    echo -e "        wallet seed ($SW_BASE) · encrypted backups ($SB_BACKUP_DIR) + key"
    echo -e "  ${DIM}The server is ready for the public pool.${RESET}"
}
