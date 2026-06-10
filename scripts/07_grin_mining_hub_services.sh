#!/bin/bash
# =============================================================================
# 07_grin_mining_hub_services.sh — Grin Mining Services Hub
# =============================================================================
# Part of: Grin Node Toolkit. Entry point for Script 7 (mining). Lets the
# operator pick ONE mining type for this server and dispatches to it:
#
#   1) Solo PRIVATE mining   → 07_grin_mining_solo.sh
#        Your node's built-in stratum; rewards go to ONE wallet. No miner
#        accounts, no payouts engine. Best for a single owner / trusted group.
#
#   2) PUBLIC mining pool     → 07_grin_mining_public_pool.sh  (GRINIUM)
#        Full PPLNS pool: many miners, address-as-identity, Tor auto-payouts,
#        web dashboard + admin panel. Best for a public-facing pool operator.
#
# ─── ONE TYPE PER SERVER ──────────────────────────────────────────────────────
# A single server runs solo private OR public — NEVER both. They collide on:
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

# $1 = type to launch ("solo"|"public")
hub_launch() {
    local want="$1" other_name other_marker want_script

    case "$want" in
        solo)
            want_script="$SOLO_SCRIPT"
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

    bash "$want_script"
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
    echo -e "${YELLOW}  Run only ONE mining type per server (solo private OR public)${RESET}"
    echo -e "${DIM}  — they clash on the stratum port, nginx zones, and /opt/grin.${RESET}"
    echo ""
    echo -e "${DIM}  ─── Choose a mining type ─────────────────────────${RESET}"
    echo -e "  ${GREEN}1${RESET}) Solo PRIVATE mining   ${DIM}(private pool for yourself + friends, book keeping, web dashboard)${RESET}"
    echo -e "  ${GREEN}2${RESET}) Public mining pool    ${DIM}(PPLNS rewards, miners join by address, Tor payouts, web dashboard)${RESET}"
    echo ""
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
}

main() {
    while true; do
        show_menu
        echo -ne "${BOLD}Select [0-2]: ${RESET}"
        read -r choice
        case "$choice" in
            1) hub_launch solo ;;
            2) hub_launch public ;;
            0|q|exit) break ;;
            "") continue ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

main "$@"
