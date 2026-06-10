# =============================================================================
# 07_lib_hub.sh — CENTRAL HUB deployment (sourced by 07_grin_mining_public_pool.sh)
# =============================================================================
# Multi-region mining pool — CENTRAL HUB role (the "brain").
# Deploys: Central API (sole DB writer), SQLite/WAL + schema + retention job,
# web dashboard + admin panel, Grin wallet (Tor payouts), nginx + SSL, backups.
# Remote satellites relay shares/blocks in via HTTPS POST (IP allowlist + secret).
# See docs/generated/script07_design.md §3–6 + script07_implementation.md (retention, runbook).
#
# The hub brain REUSES the shared pool_* setup functions from the parent script
# (install/configure/deploy web/nginx/admin/status/backup). Hub-specific
# multi-region functions (satellite registry, ingestion auth) are implemented here
# and write to the same $POOL_CONF (grin_pool.json) the Central API reads at startup.
#
# Sourced, not executed — inherits colors/log/config helpers + pool_* from parent.
# Central API ingestion (/api/shares, /api/blocks) lives on $POOL_PORT (8080).
# =============================================================================

HUB_CENTRAL_API_PORT="$POOL_PORT"   # satellites POST shares/blocks here (IP-allowlisted)

# ─── Allowlist helper (JSON array in $POOL_CONF) ────────────────────────────────
hub_allowlist_show() {
    node -e "
try {
  const d = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
  const a = Array.isArray(d.satellite_ip_allowlist) ? d.satellite_ip_allowlist : [];
  process.stdout.write(a.length ? a.join(', ') : '(empty — any IP with the secret is accepted)');
} catch(e) { process.stdout.write('(none)'); }
" "$POOL_CONF" 2>/dev/null || echo "(none)"
}

hub_allowlist_modify() {
    local action="$1" ip="${2:-}"
    node -e "
const fs = require('fs');
const [path, action, ip] = process.argv.slice(1);
let d = {}; try { d = JSON.parse(fs.readFileSync(path,'utf8')); } catch(e) {}
let a = Array.isArray(d.satellite_ip_allowlist) ? d.satellite_ip_allowlist : [];
if (action === 'add')    { if (ip && !a.includes(ip)) a.push(ip); }
else if (action === 'remove') { a = a.filter(x => x !== ip); }
else if (action === 'clear')  { a = []; }
d.satellite_ip_allowlist = a;
fs.writeFileSync(path, JSON.stringify(d, null, 2));
try { fs.chmodSync(path, 0o600); } catch(e) {}
" "$POOL_CONF" "$action" "$ip"
}

# ─── R) Satellite registry (IP allowlist) ───────────────────────────────────────
hub_satellite_registry() {
    echo -e "\n${BOLD}Satellite Registry — IP allowlist${RESET}\n"
    echo -e "  Allowed source IPs: $(hub_allowlist_show)"
    echo -e "  ${DIM}(Satellites also need the shared secret — see Ingestion auth.)${RESET}"
    echo ""
    echo -e "  ${GREEN}1${RESET}) Add satellite IP"
    echo -e "  ${GREEN}2${RESET}) Remove satellite IP"
    echo -e "  ${GREEN}3${RESET}) Clear allowlist (accept any IP with the secret)"
    echo -e "  ${DIM}0) Back${RESET}"
    echo -ne "Choice: "
    read -r c
    case "$c" in
        1) echo -ne "Satellite IP to allow: "; read -r ip
           [[ -n "$ip" ]] && { hub_allowlist_modify add "$ip"; success "Added $ip."; } ;;
        2) echo -ne "Satellite IP to remove: "; read -r ip
           [[ -n "$ip" ]] && { hub_allowlist_modify remove "$ip"; success "Removed $ip."; } ;;
        3) hub_allowlist_modify clear; success "Allowlist cleared." ;;
        *) return ;;
    esac
    warn "Restart the hub ($POOL_SERVICE) to apply: option 6 → Restart."
}

# ─── A) Ingestion auth (shared secret) ──────────────────────────────────────────
hub_ingestion_auth() {
    echo -e "\n${BOLD}Ingestion Auth — shared secret${RESET}\n"
    local cur; cur=$(pool_read_conf "hub_shared_secret" "")
    if [[ -n "$cur" ]]; then
        echo -e "  Current secret: ${GREEN}set${RESET} ${DIM}(****${cur: -4})${RESET}"
    else
        echo -e "  Current secret: ${YELLOW}not set${RESET} — ingestion is disabled until configured"
    fi
    echo ""
    echo -e "  ${GREEN}1${RESET}) Generate a new random secret"
    echo -e "  ${GREEN}2${RESET}) Enter a secret manually"
    echo -e "  ${DIM}0) Back${RESET}"
    echo -ne "Choice: "
    read -r c
    local secret=""
    case "$c" in
        1) secret=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" 2>/dev/null || openssl rand -hex 32) ;;
        2) echo -ne "Secret: "; read -r secret ;;
        *) return ;;
    esac
    [[ -z "$secret" ]] && { warn "No secret set."; return; }
    pool_write_conf_key "hub_shared_secret" "$secret"
    success "Shared secret saved to $POOL_CONF."
    # The Central API binds 127.0.0.1:$HUB_CENTRAL_API_PORT (systemd HOST env) —
    # satellites cannot reach it directly; they relay through the nginx HTTPS
    # vhost, which routes /api/shares + /api/blocks with a dedicated rate zone.
    local hub_domain; hub_domain=$(pool_read_conf "subdomain" "<your-pool-domain>")
    echo -e "\n  ${BOLD}Configure each satellite with:${RESET}"
    echo -e "    hub_url           = https://${hub_domain}"
    echo -e "    hub_shared_secret = ${secret}"
    echo -e "  ${DIM}(the nginx vhost proxies /api/shares + /api/blocks to the Central API)${RESET}"
    warn "Restart the hub ($POOL_SERVICE) to apply: option 6 → Restart."
}

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
    echo -e "${BOLD}${CYAN}  GRINIUM — Central Hub (brain)${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "  Service: $(_pool_menu_status_line)"
    echo -e "${DIM}  Central API ingestion :$HUB_CENTRAL_API_PORT (satellites relay in)${RESET}"
    echo ""
    echo -e "${DIM}  ─── Brain setup (shared with single-box) ─────────${RESET}"
    echo -e "  ${GREEN}1${RESET}) Install               ${DIM}(nodejs, sqlite3, systemd, fail2ban)${RESET}"
    echo -e "  ${GREEN}2${RESET}) Configure             ${DIM}(pool name, domain, fee, wallet)${RESET}"
    echo -e "  ${GREEN}3${RESET}) Deploy web files"
    echo -e "  ${GREEN}4${RESET}) Setup nginx           ${DIM}(vhost + SSL)${RESET}"
    echo -e "  ${GREEN}5${RESET}) Create admin account"
    echo -e "  ${GREEN}6${RESET}) Service control"
    echo -e "  ${GREEN}7${RESET}) Status"
    echo ""
    echo -e "${DIM}  ─── Multi-region (hub-specific) ──────────────────${RESET}"
    echo -e "  ${GREEN}R${RESET}) Satellite registry    ${DIM}(IP allowlist)${RESET}"
    echo -e "  ${GREEN}A${RESET}) Ingestion auth        ${DIM}(shared secret)${RESET}"
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
            5)        pool_setup_admin || true ;;
            6)        pool_service_menu || true ;;
            7)        pool_show_status || true ;;
            r)        hub_satellite_registry || true ;;
            a)        hub_ingestion_auth || true ;;
            t)        hub_retention_settings || true ;;
            b)        pool_backup || true ;;
            c)        pool_cron_schedules || true ;;
            l)        pool_view_logs || true ;;
            0|q|exit) break ;;
            *)        warn "Invalid option."; sleep 1; continue ;;
        esac
        [[ "${choice,,}" != "l" ]] && { echo ""; echo "Press Enter to continue..."; read -r; }
    done
}
