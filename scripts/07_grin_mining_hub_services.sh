#!/bin/bash
# =============================================================================
# 07_grin_mining_hub_services.sh — Grin Mining Services Hub
# =============================================================================
# Part of: Grin Node Toolkit. Entry point for Script 7 (mining). Lets the
# operator pick ONE mining type for this server and dispatches to it:
#
#   1) Solo PRIVATE mining — Internet → 07_grin_mining_solo.sh
#        Your node's built-in stratum; rewards go to ONE wallet. No miner
#        accounts, no payouts engine. Stats dashboard on a public domain + SSL.
#        Best for a single owner / trusted group reachable over the internet.
#
#   2) Solo PRIVATE mining — LAN      → 07_grin_mining_solo.sh lan
#        Same solo product, but the stats dashboard is served over plain HTTP on
#        a chosen LAN IP:port — no domain, no certbot, no auth. For an internal
#        network. Same exclusivity bucket as (1): it IS solo, just a LAN front-end.
#
#   3) PUBLIC mining pool             → 07_grin_mining_public_pool.sh  (GRINIUM)
#        Full PPLNS pool: many miners, address-as-identity, Tor auto-payouts,
#        web dashboard + admin panel. Best for a public-facing pool operator.
#
# ─── ONE SETUP PER SERVER ─────────────────────────────────────────────────────
# A single server runs ONE of the above — NEVER two. They collide on:
#   · the stratum port (3416, shared default)
#   · nginx rate-limit / connection zones
#   · the /opt/grin layout and conf files
# This hub hard-blocks launching one type while the other is already set up.
# Run the second type on a separate VPS instead.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLKIT_ROOT="$(dirname "$SCRIPT_DIR")"

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

SOLO_SCRIPT="$SCRIPT_DIR/07_grin_mining_solo.sh"
PUBLIC_SCRIPT="$SCRIPT_DIR/07_grin_mining_public_pool.sh"

# ─── Logging ──────────────────────────────────────────────────────────────────
info()  { echo -e "${CYAN}[INFO]${RESET}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error() { echo -e "${RED}[ERROR]${RESET} $*"; }

# ═══════════════════════════════════════════════════════════════════════════════
# DETECTION — is solo private / public pool already set up on this server?
# ═══════════════════════════════════════════════════════════════════════════════
# Echoes the first detected marker, or nothing (rc 1) if not set up.

hub_detect_solo() {
    local m
    for m in \
        "/opt/grin/conf/grin_solo_payment.json" \
        "/etc/cron.d/grin-solo-mining-collector" \
        "/opt/grin/solo-stats" \
        "/etc/nginx/grin-solo-stats.htpasswd"
    do
        [[ -e "$m" ]] && { echo "$m"; return 0; }
    done
    if systemctl list-units --type=service --all 2>/dev/null | grep -q 'grin-solo'; then
        echo "systemd: grin-solo-* service"; return 0
    fi
    return 1
}

hub_detect_public() {
    local m
    for m in \
        "/opt/grin/conf/grin_pubpool.json" \
        "/opt/grin/pubpool/mainnet" \
        "/opt/grin/conf/grin_pool.json" \
        "/opt/grin/pool/mainnet"
    do
        [[ -e "$m" ]] && { echo "$m"; return 0; }
    done
    if systemctl list-units --type=service --all 2>/dev/null | grep -q 'grin-pool-manager'; then
        echo "systemd: grin-pool-manager service"; return 0
    fi
    return 1
}

# ═══════════════════════════════════════════════════════════════════════════════
# DISPATCH — launch a child after enforcing one-type-per-server
# ═══════════════════════════════════════════════════════════════════════════════

# $1 = type to launch ("solo"|"solo-lan"|"public")
# solo and solo-lan are the SAME product (same ports/dirs/exclusivity) — solo-lan
# just launches the solo script in LAN stats-page mode (plain HTTP, no domain/SSL).
hub_launch() {
    local want="$1" other_name other_marker want_script want_arg=""

    case "$want" in
        solo)
            want_script="$SOLO_SCRIPT"
            other_name="Public mining pool"
            other_marker=$(hub_detect_public || true)
            ;;
        solo-lan)
            want_script="$SOLO_SCRIPT"
            want_arg="lan"
            other_name="Public mining pool"
            other_marker=$(hub_detect_public || true)
            ;;
        public)
            want_script="$PUBLIC_SCRIPT"
            other_name="Solo PRIVATE mining"
            other_marker=$(hub_detect_solo || true)
            ;;
        *) return 1 ;;
    esac

    if [[ -n "$other_marker" ]]; then
        echo ""
        error "Cannot start that — ${other_name} is already set up on this server:"
        echo -e "    ${DIM}· $other_marker${RESET}"
        echo ""
        warn "Run only ONE mining type per server (solo private OR public)."
        warn "They collide on the stratum port (3416), nginx zones, and the"
        warn "/opt/grin layout. Remove the existing setup first, or deploy the"
        warn "other type on a separate VPS."
        echo ""
        echo "Press Enter to return to the mining hub..."
        read -r
        return 0
    fi

    if [[ ! -f "$want_script" ]]; then
        error "Script not found: $want_script"
        echo "Press Enter to return to the mining hub..."
        read -r
        return 0
    fi

    bash "$want_script" $want_arg
    return 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# MENU
# ═══════════════════════════════════════════════════════════════════════════════

hub_status_line() {
    local solo public
    solo=$(hub_detect_solo || true)
    public=$(hub_detect_public || true)
    if [[ -n "$solo" ]]; then
        echo -e "  Active type: ${GREEN}Solo PRIVATE mining${RESET}  ${DIM}($solo)${RESET}"
    elif [[ -n "$public" ]]; then
        echo -e "  Active type: ${GREEN}Public mining pool${RESET}  ${DIM}($public)${RESET}"
    else
        echo -e "  Active type: ${DIM}none yet — pick one below${RESET}"
    fi
}

show_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Grin Mining Services${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    hub_status_line
    echo ""
    echo -e "${YELLOW}  Pick ONE option only — a server runs a single mining setup.${RESET}"
    echo -e "${DIM}  All three clash on the stratum port, nginx zones, and /opt/grin, so only${RESET}"
    echo -e "${DIM}  one can be installed per server (the others are blocked once one is set up).${RESET}"
    echo ""
    echo -e "${DIM}  ─── Solo Mining Pool ${DIM}(private — yourself + friends)─────────${RESET}"
    echo -e "  ${GREEN}1${RESET}) Solo PRIVATE mining — Internet  ${DIM}(public domain + Let's Encrypt SSL · reachable anywhere)${RESET}"
    echo -e "  ${GREEN}2${RESET}) Solo PRIVATE mining — LAN       ${DIM}(internal network · plain HTTP stats page · no domain/SSL)${RESET}"
    echo ""
    echo -e "${DIM}  ─── Public Mining Pool ${DIM}(open to anyone)──────────────────${RESET}"
    echo -e "  ${GREEN}3${RESET}) Public mining pool           ${DIM}(PPLNS rewards, miners join by address, Tor payouts, web dashboard)${RESET}"
    echo ""
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
}

main() {
    while true; do
        show_menu
        echo -ne "${BOLD}Select [0-3]: ${RESET}"
        read -r choice
        case "$choice" in
            1) hub_launch solo ;;
            2) hub_launch solo-lan ;;
            3) hub_launch public ;;
            0|q|exit) break ;;
            "") continue ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

main "$@"
