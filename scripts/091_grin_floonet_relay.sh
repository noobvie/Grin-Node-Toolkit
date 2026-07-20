#!/bin/bash
# =============================================================================
# 091_grin_floonet_relay.sh — Floonet relay deployer
# =============================================================================
#
#  Member of the Grin Connectivity Hub (Script 09).
#
#  Deploys the community Grin-native Nostr relay (floonet-rs, by github.com/2ro)
#  the toolkit way: service user + hardened systemd + nginx/certbot (replacing
#  his Caddy) + firewall + encrypted backups. We DEPLOY his software, we do NOT
#  fork it — gaps found in his installer/docs become upstream PRs.
#
#  ONE relay per operator: Floonet is network-agnostic transport (it carries
#  encrypted slatepacks as Nostr events and never touches chain state), so
#  there are no mainnet/testnet instances — upstream runs a single service too.
#
#  Design    : docs/generated/script09_design.md  (PART A — 091)
#  Helpers   : scripts/lib/091_lib_floonet.sh (flr_*)
#              scripts/lib/nostr_relay_deploy.sh (nrd_* — shared wss primitive)
#  Upstream  : https://github.com/2ro/floonet-rs  •  https://docs.floonet.dev
#
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

LOG_DIR="/opt/grin/logs"
LOG_FILE="${LOG_DIR}/floonet_session_$(date +%Y%m%d_%H%M%S).log"

log()     { echo "[$(date '+%F %T')] $*" >> "$LOG_FILE" 2>/dev/null || true; }
info()    { echo -e "${CYAN}[INFO]${RESET}  $*";  log "INFO  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; log "WARN  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*";   log "ERROR $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; log "OK    $*"; }
pause()   { echo ""; echo -ne "${DIM}Press Enter to continue...${RESET}"; read -r || true; }

require_root() {
    if [[ "$(id -u)" -ne 0 ]]; then
        error "This script must run as root (sudo) on the target VPS."
        exit 1
    fi
}

# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/091_lib_floonet.sh"

# =============================================================================
# GUIDED SETUP — the one path a newcomer needs
# =============================================================================

# Warn-only DNS pre-check: does the domain already point at this server?
_flr_dns_check() {
    local domain="$1" ip="" dns=""
    ip=$(curl -4fsS --max-time 8 https://api.ipify.org 2>/dev/null \
        || curl -4fsS --max-time 8 https://ifconfig.me 2>/dev/null || true)
    dns=$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1; exit}' || true)
    if [[ -z "$dns" ]]; then
        warn "'${domain}' does not resolve yet — SSL will fail until the DNS A record exists."
        return 1
    fi
    if [[ -n "$ip" && "$dns" != "$ip" ]]; then
        warn "'${domain}' resolves to ${dns}, but this server's public IP is ${ip}."
        return 1
    fi
    success "DNS looks good: ${domain} → ${dns}"
    return 0
}

flr_guided_setup() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Floonet Relay — Guided Setup${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  ${BOLD}What you'll get:${RESET} your own Grin-native Nostr relay — part of the"
    echo -e "  Floonet privacy network that carries encrypted slatepacks for"
    echo -e "  Goblin-style wallets. Reachable at ${BOLD}wss://your-domain${RESET}."
    echo ""
    echo -e "  ${BOLD}What you need before starting:${RESET}"
    echo -e "   • A domain or subdomain (e.g. relay.example.com) with a DNS ${BOLD}A record${RESET}"
    echo -e "     pointing at this server's IP"
    echo -e "   • Ports 80/443 reachable from the internet"
    echo -e "   • ~15 minutes (most of it is an automated Rust build)"
    echo ""
    echo -e "  ${BOLD}The 8 steps${RESET} ${DIM}(all automatic after a few questions):${RESET}"
    echo -e "  ${DIM}dependencies → Rust → fetch source → build → install service →${RESET}"
    echo -e "  ${DIM}configure → nginx + SSL + firewall → start & verify${RESET}"
    echo ""
    if flr_installed; then
        echo -e "  ${YELLOW}An existing install was detected — this re-run updates and${RESET}"
        echo -e "  ${YELLOW}reconfigures it. Your config.toml and data are preserved.${RESET}"
        echo ""
    fi
    echo -ne "${BOLD}Start the setup? [Y/n]: ${RESET}"
    local c; read -r c || true
    [[ "${c,,}" == "n" ]] && { info "Cancelled."; return 0; }

    flr_preflight || { pause; return 0; }
    flr_load_conf

    # ── Questions (all of them up-front, then hands-off) ─────────────────────
    echo ""
    echo -e "${BOLD}── Step 0: a few questions ──${RESET}"
    local domain="" email="" rname="" rdesc=""
    while true; do
        echo -ne "  Relay domain${FLR_DOMAIN:+ [${FLR_DOMAIN}]}: "
        read -r domain || true
        domain="${domain:-$FLR_DOMAIN}"
        if [[ -z "$domain" ]] || ! nginx_validate_domain "$domain"; then
            warn "Enter a valid domain, e.g. relay.example.com"
            continue
        fi
        break
    done
    if ! _flr_dns_check "$domain"; then
        echo -ne "  Continue anyway (SSL will be retried later)? [y/N]: "
        read -r c || true
        [[ "${c,,}" == "y" ]] || { info "Fix the DNS record, then re-run setup."; pause; return 0; }
    fi
    while true; do
        echo -ne "  Email for Let's Encrypt (cert expiry notices)${FLR_EMAIL:+ [${FLR_EMAIL}]}: "
        read -r email || true
        email="${email:-$FLR_EMAIL}"
        [[ "$email" == *"@"* ]] && break
        warn "Enter a valid email address."
    done
    echo -ne "  Relay name shown to clients [Floonet relay @ ${domain}]: "
    read -r rname || true
    rname="${rname:-Floonet relay @ ${domain}}"
    echo -ne "  Short description [Grin-native Nostr relay on the Floonet network]: "
    read -r rdesc || true
    rdesc="${rdesc:-Grin-native Nostr relay on the Floonet network}"

    # NIP-05 usernames — default on: the relay exists to serve wallet users, and
    # pay-by-username is core to that. Self-service, NIP-98-authenticated; can be
    # turned off later via menu 9. base_url is derived from the domain.
    echo -ne "  Offer name@${domain} usernames to your users (NIP-05)? [Y/n]: "
    read -r rnames || true
    [[ "${rnames,,}" == "n" ]] && want_names=0 || want_names=1

    echo ""
    echo -e "  ${BOLD}Summary${RESET}"
    echo -e "   Relay URL   : ${BOLD}wss://${domain}/${RESET}"
    echo -e "   SSL email   : ${email}"
    echo -e "   Relay name  : ${rname}"
    echo -e "   Description : ${rdesc}"
    echo -e "   Usernames   : $( [[ "$want_names" -eq 1 ]] && echo "name@${domain} (NIP-05)" || echo "off" )"
    echo -e "   ${DIM}Layout: /usr/local/bin/floonet-rs · /etc/floonet-rs/config.toml · /var/lib/floonet-rs${RESET}"
    echo ""
    echo -ne "${BOLD}Proceed? [Y/n]: ${RESET}"
    read -r c || true
    [[ "${c,,}" == "n" ]] && { info "Cancelled."; return 0; }

    FLR_DOMAIN="$domain"; FLR_EMAIL="$email"
    flr_save_conf
    log "guided setup start: domain=$domain"

    # ── Hands-off phase ───────────────────────────────────────────────────────
    echo ""
    echo -e "${BOLD}[1/8] Dependencies${RESET}"
    flr_install_deps || { _flr_setup_failed "dependency install"; return 0; }

    echo ""
    echo -e "${BOLD}[2/8] Rust toolchain${RESET}"
    flr_ensure_rust || { _flr_setup_failed "Rust install"; return 0; }

    echo ""
    echo -e "${BOLD}[3/8] Fetch floonet-rs source${RESET}"
    flr_fetch_source || { _flr_setup_failed "source fetch"; return 0; }

    echo ""
    echo -e "${BOLD}[4/8] Build${RESET}"
    flr_build || { _flr_setup_failed "build"; return 0; }

    echo ""
    echo -e "${BOLD}[5/8] Install service${RESET}"
    flr_install_binary || { _flr_setup_failed "service install"; return 0; }

    echo ""
    echo -e "${BOLD}[6/8] Configure relay identity${RESET}"
    flr_configure_identity "$domain" "$rname" "$rdesc" \
        || { _flr_setup_failed "configuration"; return 0; }
    if [[ "$want_names" -eq 1 ]]; then
        flr_enable_name_authority "$domain" \
            || warn "Could not enable NIP-05 name authority — set it later via menu 9."
    fi

    echo ""
    echo -e "${BOLD}[7/8] nginx + SSL certificate + firewall${RESET}"
    flr_nginx_setup "$domain" "$email" || { _flr_setup_failed "nginx setup"; return 0; }

    echo ""
    echo -e "${BOLD}[8/8] Start & verify${RESET}"
    flr_start_verify || { _flr_setup_failed "service start"; return 0; }

    # ── Done ──────────────────────────────────────────────────────────────────
    echo ""
    echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${GREEN}  🎉 Your Floonet relay is live${RESET}"
    echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    if [[ "${NRD_SSL_OK:-0}" -eq 1 ]] && nrd_ws_handshake_test "https://${domain}"; then
        echo -e "   Relay URL : ${BOLD}wss://${domain}${RESET}   ${GREEN}✓ verified end-to-end${RESET}"
    elif [[ "${NRD_SSL_OK:-0}" -eq 1 ]]; then
        echo -e "   Relay URL : ${BOLD}wss://${domain}${RESET}   ${YELLOW}(public handshake not confirmed yet — try menu 6 in a minute)${RESET}"
    else
        echo -e "   Relay URL : ${YELLOW}ws://${domain} — NO SSL yet.${RESET}"
        echo -e "   ${DIM}Fix the DNS A record, then run menu option 2 to retry the certificate.${RESET}"
    fi
    echo ""
    echo -e "   ${BOLD}Share it:${RESET} wallet users add ${BOLD}wss://${domain}${RESET} in their relay list"
    echo -e "   ${DIM}(Goblin wallet: Settings → Relays)${RESET}"
    # Offer the daily encrypted backup inline (was a passive "see menu B" hint).
    # It preserves the NIP-05 username registry + stored events — the data a fresh
    # relay on a new VPS would otherwise lose. On a same-domain migration the wss
    # CONNECTION survives via DNS+cert, but the name@domain registry lives only in
    # the relay DB, so without this backup every nickname resets. flr_backup_schedule
    # prompts once for the shared personal key (needed to decrypt on restore).
    echo ""
    echo -e "   ${BOLD}Protect your relay data${RESET}"
    echo -e "   ${DIM}A daily encrypted backup preserves your NIP-05 usernames + events so you can${RESET}"
    echo -e "   ${DIM}migrate to a new VPS with nicknames intact. Archives → ${GBE_BACKUP_DIR:-/opt/grin/backups}.${RESET}"
    echo -ne "   ${BOLD}Enable it now? [Y/n]: ${RESET}"
    local _bk; read -r _bk || true
    if [[ "${_bk,,}" != "n" ]]; then
        flr_backup_schedule || warn "Backup not scheduled — set it up later via menu B."
    else
        info "Skipped — enable later via menu B (also included in the toolkit-wide Script 089 backup)."
    fi
    echo ""
    echo -e "   ${BOLD}Recommended next steps:${RESET}"
    echo -e "    • Menu ${BOLD}3${RESET} — status dashboard (service, SSL, stored events)"
    if [[ "$want_names" -eq 1 ]]; then
        echo -e "    • ${GREEN}Usernames live${RESET} — users can register name@${domain} (manage via menu ${BOLD}9${RESET})"
    else
        echo -e "    • Menu ${BOLD}9${RESET} — offer name@${domain} usernames (NIP-05)"
    fi
    log "guided setup complete: wss://${domain} ssl_ok=${NRD_SSL_OK:-0}"
    pause
}

_flr_setup_failed() {
    echo ""
    error "Setup stopped at: $1."
    echo -e "  ${DIM}Every step is safe to re-run — fix the issue above and choose${RESET}"
    echo -e "  ${DIM}option 1 again; completed steps are skipped or refreshed quickly.${RESET}"
    echo -e "  ${DIM}Session log: ${LOG_FILE}${RESET}"
    log "guided setup FAILED at: $1"
    pause
}

# Re-run only the domain/SSL half (e.g. after fixing DNS, or a domain change).
flr_domain_ssl_setup() {
    clear
    echo -e "${BOLD}${CYAN}── Domain & SSL setup (nginx + certbot) ──${RESET}\n"
    flr_installed || { warn "Install the relay first (option 1)."; pause; return 0; }
    flr_load_conf
    local domain email c
    echo -ne "  Relay domain${FLR_DOMAIN:+ [${FLR_DOMAIN}]}: "
    read -r domain || true
    domain="${domain:-$FLR_DOMAIN}"
    if [[ -z "$domain" ]] || ! nginx_validate_domain "$domain"; then
        warn "Invalid domain."; pause; return 0
    fi
    _flr_dns_check "$domain" || true
    echo -ne "  Email for Let's Encrypt${FLR_EMAIL:+ [${FLR_EMAIL}]}: "
    read -r email || true
    email="${email:-$FLR_EMAIL}"
    [[ "$email" == *"@"* ]] || { warn "Invalid email."; pause; return 0; }
    FLR_DOMAIN="$domain"; FLR_EMAIL="$email"
    flr_save_conf
    flr_toml_set info relay_url "$(flr_toml_str "wss://${domain}/")" || true
    flr_nginx_setup "$domain" "$email" || { error "nginx setup failed."; pause; return 0; }
    echo -ne "  Restart the relay to pick up the new relay_url? [Y/n]: "
    read -r c || true
    [[ "${c,,}" != "n" ]] && systemctl restart "$FLR_SVC" 2>/dev/null || true
    [[ "${NRD_SSL_OK:-0}" -eq 1 ]] && success "wss://${domain} is set up." \
        || warn "SSL still pending — relay serves ws:// until certbot succeeds."
    pause
}

# Rebuild the public landing page and reload nginx — no cert/relay disruption.
flr_menu_refresh_landing() {
    clear
    echo -e "${BOLD}${CYAN}── Refresh landing page ──${RESET}\n"
    flr_installed || { warn "Install the relay first (option 1)."; pause; return 0; }
    flr_load_conf
    [[ -n "$FLR_DOMAIN" ]] || { warn "No domain configured yet — run guided setup (option 1) first."; pause; return 0; }
    echo -e "  Rebuilds the public homepage from config.toml and reloads nginx."
    echo -e "  ${DIM}The relay service and SSL certificate are left untouched.${RESET}\n"
    if flr_nginx_setup "$FLR_DOMAIN" "$FLR_EMAIL"; then
        success "Landing page live at https://${FLR_DOMAIN}/"
    else
        error "Refresh failed — see the message above."
    fi
    pause
}

# =============================================================================
# MENU
# =============================================================================

_flr_status_strip() {
    if ! flr_installed; then
        echo -e "  Status: ${DIM}not installed — start with option 1${RESET}"
        return 0
    fi
    flr_load_conf
    local state badge url
    state=$(flr_svc_state)
    case "$state" in
        active) badge="${GREEN}● active${RESET}" ;;
        failed) badge="${RED}● failed${RESET}" ;;
        *)      badge="${YELLOW}● ${state:-stopped}${RESET}" ;;
    esac
    url=$(flr_relay_url)
    local cert_note=""
    if [[ -n "$FLR_DOMAIN" && -f "/etc/letsencrypt/live/${FLR_DOMAIN}/cert.pem" ]]; then
        cert_note=" · ${DIM}SSL ✓${RESET}"
    elif [[ -n "$FLR_DOMAIN" ]]; then
        cert_note=" · ${YELLOW}no SSL${RESET}"
    fi
    echo -e "  Status: ${badge} · ${url}${cert_note}"
    return 0
}

show_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 091) FLOONET RELAY${RESET} ${DIM}— Grin-native Nostr relay (floonet-rs)${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    _flr_status_strip
    echo ""
    echo -e "  ${BOLD}Setup${RESET}"
    echo -e "  ${GREEN}1${RESET}) Guided setup ${DIM}(install / update / reconfigure — start here)${RESET}"
    echo -e "  ${GREEN}2${RESET}) Domain & SSL only ${DIM}(re-run nginx/certbot, e.g. after a DNS fix)${RESET}"
    echo ""
    echo -e "  ${BOLD}Monitor & control${RESET}"
    echo -e "  ${GREEN}3${RESET}) Status dashboard"
    echo -e "  ${GREEN}4${RESET}) Live logs"
    echo -e "  ${GREEN}5${RESET}) Start / stop / restart"
    echo -e "  ${GREEN}6${RESET}) Test relay ${DIM}(WebSocket handshake + NIP-11)${RESET}"
    echo ""
    echo -e "  ${BOLD}Configure${RESET}"
    echo -e "  ${GREEN}7${RESET}) Relay settings ${DIM}(name, description, size/kind limits)${RESET}"
    echo -e "  ${GREEN}8${RESET}) Access control ${DIM}(NIP-42 auth, pubkey whitelists)${RESET}"
    echo -e "  ${GREEN}9${RESET}) NIP-05 usernames ${DIM}(name authority)${RESET}"
    echo -e "  ${GREEN}10${RESET}) GoblinPay ${DIM}(charge GRIN for names / write access)${RESET}"
    echo -e "  ${GREEN}11${RESET}) Edit config.toml directly"
    echo -e "  ${GREEN}L${RESET})  Refresh landing page ${DIM}(rebuild the public homepage)${RESET}"
    echo ""
    echo -e "  ${BOLD}Maintenance${RESET}"
    echo -e "  ${GREEN}B${RESET}) Backup & restore    ${GREEN}U${RESET}) Update floonet-rs"
    echo -e "  ${GREEN}M${RESET}) Nym mixnet exit ${DIM}(optional add-on)${RESET}     ${RED}D${RESET}) Uninstall"
    echo ""
    echo -e "  ${RED}0${RESET}) Back"
    echo ""
    echo -ne "${BOLD}Select: ${RESET}"
}

_flr_need_install() {
    if ! flr_installed; then
        warn "Relay not installed yet — run the guided setup (option 1) first."
        pause
        return 1
    fi
    return 0
}

main() {
    require_root
    mkdir -p "$LOG_DIR" 2>/dev/null || true
    log "091 session start"
    local choice
    while true; do
        show_menu
        read -r choice || true
        case "$choice" in
            1)  flr_guided_setup       || true ;;
            2)  flr_domain_ssl_setup   || true ;;
            3)  _flr_need_install && flr_status_dashboard    || true ;;
            4)  _flr_need_install && flr_logs                || true ;;
            5)  _flr_need_install && flr_service_control     || true ;;
            6)  _flr_need_install && flr_test_relay          || true ;;
            7)  _flr_need_install && flr_menu_settings       || true ;;
            8)  _flr_need_install && flr_menu_access         || true ;;
            9)  _flr_need_install && flr_menu_name_authority || true ;;
            10) _flr_need_install && flr_menu_goblinpay      || true ;;
            11) _flr_need_install && flr_edit_config         || true ;;
            [lL]) flr_menu_refresh_landing || true ;;
            [bB]) flr_backup_menu      || true ;;
            [uU]) _flr_need_install && flr_update   || true ;;
            [mM]) _flr_need_install && flr_mixexit  || true ;;
            [dD]) _flr_need_install && flr_uninstall || true ;;
            0) break ;;
            "") continue ;;
            *) echo -e "\n${RED}Invalid option.${RESET}"; sleep 1 ;;
        esac
    done
}

main
