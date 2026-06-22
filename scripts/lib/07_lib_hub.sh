# =============================================================================
# 07_lib_hub.sh — CENTRAL HUB deployment (sourced by 07_grin_mining_public_pool.sh)
# =============================================================================
# Multi-region mining pool — CENTRAL HUB role (the "brain") under Model C.
# Deploys: Central API + admin, SQLite/WAL + schema + retention job, web dashboard,
# Grin wallet (Tor payouts), nginx + SSL, backups. Regional GATEWAYS (thin HAProxy +
# WireGuard forwarders, scripts/lib/07_lib_gateway.sh) tunnel miner stratum to this box's
# per-region internal ports — there is NO satellite share/block ingestion API anymore.
# See docs/generated/script07_design.md §3–6.
#
# The hub brain REUSES the shared pool_* setup functions from the parent script
# (install/configure/deploy web/nginx/admin/status/backup) AND the parent's WireGuard
# multi-region menu (pool_wireguard_menu) — a bare hub is just a singlebox with no local
# stratum, so it manages gateways exactly the same way.
#
# Sourced, not executed — inherits colors/log/config helpers + pool_* from parent.
# =============================================================================

# ─── T) Retention settings ──────────────────────────────────────────────────────
hub_retention_settings() {
    echo -e "\n${BOLD}Retention / Cleanup${RESET}\n"
    info "Database retention is configured in the web admin panel:"
    echo -e "    ${BOLD}Settings → Database${RESET} (enable cleanup, PPLNS safety margin, keep-days)"
    echo -e "  Backed by the ${BOLD}database${RESET} settings section + lib/retention.js (runs in-process)."
    echo -e "  File space is reclaimed by the weekly ${BOLD}VACUUM${RESET} cron — see option ${BOLD}C${RESET}."
}

# ─── Menu / loop ────────────────────────────────────────────────────────────────
hub_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  GRINIUM — Central Hub (brain) [$([[ "$POOL_NET" == testnet ]] && echo TESTNET || echo Mainnet)]${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "  Service: $(_pool_menu_status_line)"
    echo -e "${DIM}  Regional gateways tunnel miner stratum in over WireGuard (option W).${RESET}"
    echo ""
    echo -e "${DIM}  ─── Brain setup (shared with single-box) ─────────${RESET}"
    echo -e "  ${GREEN}1${RESET}) $(_pool_step_mark 1) Install             ${DIM}(nodejs, sqlite3, systemd, fail2ban)${RESET}"
    echo -e "  ${GREEN}2${RESET}) $(_pool_step_mark 2) Configure           ${DIM}(pool name, domain, fee, stratum port)${RESET}"
    echo -e "  ${GREEN}3${RESET}) $(_pool_step_mark 3) Deploy web files"
    echo -e "  ${GREEN}4${RESET}) $(_pool_step_mark 4) Setup nginx         ${DIM}(vhost + SSL)${RESET}"
    echo -e "  ${GREEN}5${RESET}) $(_pool_step_mark 5) Set up wallet       ${DIM}(coinbase Foreign 3415 + payout Owner 3420)${RESET}"
    echo -e "  ${GREEN}6${RESET}) $(_pool_step_mark 6) Service control     ${DIM}(start before creating admin)${RESET}"
    echo -e "  ${GREEN}7${RESET}) $(_pool_step_mark 7) Create admin account ${DIM}(needs service running)${RESET}"
    echo -e "  ${GREEN}8${RESET}) Status"
    echo -e "  ${GREEN}9${RESET}) Deploy new code     ${DIM}(refresh js/html/media from checkout + restart)${RESET}"
    echo ""
    echo -e "${DIM}  ─── Multi-region ─────────────────────────────────${RESET}"
    echo -e "  ${GREEN}W${RESET}) Multi-region          ${DIM}(WireGuard server + add regional gateways)${RESET}"
    echo -e "  ${GREEN}T${RESET}) Retention settings    ${DIM}(prune / cleanup)${RESET}"
    echo ""
    echo -e "  ${GREEN}B${RESET}) Backup     ${GREEN}C${RESET}) Cron tasks     ${GREEN}L${RESET}) View logs"
    echo -e "  ${RED}0${RESET}) Back"
    echo ""
    echo -ne "${BOLD}Select: ${RESET}"
}

pool_hub_loop() {
    while true; do
        hub_menu
        read -r choice
        # ||-guarded dispatch: a failing step must return to this menu, not kill
        # the whole script via set -e.
        case "${choice,,}" in
            "")       continue ;;
            1)        pool_install || true ;;
            2)        pool_configure || true ;;
            3)        pool_deploy_web || true ;;
            4)        pool_setup_nginx || true ;;
            5)        pool_wallet_menu || true ;;
            6)        pool_service_menu || true ;;
            7)        pool_setup_admin || true ;;
            8)        pool_show_status || true ;;
            9)        pool_deploy_code || true ;;
            w)        pool_wireguard_menu || true ;;
            t)        hub_retention_settings || true ;;
            b)        pool_backup || true ;;
            c)        pool_cron_schedules || true ;;
            l)        pool_view_logs || true ;;
            0|q|exit) break ;;
            *)        warn "Invalid option."; sleep 1; continue ;;
        esac
        # Skip the pause for the pager (l) and for submenus that self-manage their own
        # feedback and return on their own 0) Back (5/6/c/w) — otherwise picking 0 inside
        # one of them would trigger a second, redundant prompt here.
        case "${choice,,}" in
            l|5|6|c|w) ;;
            *) echo ""; echo "Press Enter to continue..."; read -r ;;
        esac
    done
}
