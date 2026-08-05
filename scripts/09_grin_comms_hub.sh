#!/bin/bash
# =============================================================================
# 09_grin_comms_hub.sh — Grin Connectivity Hub
# =============================================================================
#
#  Deploys services that let Grin participants reach each other — transport,
#  relays, messaging, identity. NOT the node's own p2p (01/04) and NOT
#  value-holding wallets (05).
#
#  ─── Members ───────────────────────────────────────────────────────────────
#   091  091_grin_floonet_relay.sh    Floonet (floonet-rs) relay deployer
#   092  (reserved)                   mwixnet CoinSwap mixer node — NOT BUILT YET
#   093  093_grin_transporter.sh      Store-and-forward slate relay (Phase 1 built 2026-07-11)
#   094+ (reserved)                   NIP-05 identity, notifications, …
#
#  (Numbers swapped 2026-07-10: Floonet relay ships first — it serves the
#   existing Goblin/Floonet user base; the Transporter is an internal rail.)
#
#  (Renumbered 2026-08-04 by operator decision: the Transporter moved 092 → 093
#   and 092 was reserved for the mwixnet CoinSwap MIXER — the mixer is the more
#   actionable build (upstream is community-tested on testnet and a live route
#   operator can add us), while the Transporter's Phase 2 stays gated on wallet
#   relay-receive support. NOTE this breaks the toolkit's usual "assign a number
#   when a build STARTS" rule: 092 is a deliberate reservation for an UNBUILT
#   product, and this is the second renumber the Transporter has taken
#   (056 → 091 → 092 → 093). Rationale + mixer design → script09_design.md PART D.)
#
#  Design: docs/generated/script09_design.md
#  Memory: project_comms_hub_09
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

# =============================================================================
# INSTALLATION DETECTION
# =============================================================================

# 091 — installed if the floonet-rs service unit exists (ours lands in
# /etc/systemd/system; upstream's install.sh may use /usr/lib) or the binary does
_091_installed() {
    [[ -f /etc/systemd/system/floonet-rs.service ]] \
        || [[ -f /usr/lib/systemd/system/floonet-rs.service ]] \
        || [[ -x /usr/local/bin/floonet-rs ]]
}

# 091 — running status from systemd
_091_status() {
    if systemctl is-active --quiet floonet-rs 2>/dev/null; then echo "active"; else echo ""; fi
}

# 093 — installed if a Transporter instance dir exists for either network
_093_installed() {
    [[ -d /opt/grin/transporter-main ]] || [[ -d /opt/grin/transporter-test ]]
}

# 093 — running status from systemd
_093_status() {
    local mn="" tn=""
    systemctl is-active --quiet grin-transporter-main 2>/dev/null && mn="mainnet"
    systemctl is-active --quiet grin-transporter-test 2>/dev/null && tn="testnet"
    if [[ -n "$mn" && -n "$tn" ]]; then echo "mainnet + testnet"
    elif [[ -n "$mn" ]];           then echo "mainnet"
    elif [[ -n "$tn" ]];           then echo "testnet"
    else                                echo ""
    fi
}

# =============================================================================
# HUB MENU
# =============================================================================

run_sub() {
    local script="$SCRIPT_DIR/$1"
    if [[ ! -f "$script" ]]; then
        echo -e "\n${RED}[ERROR]${RESET}  Script not found: $script"
        echo -e "${DIM}Press Enter to return...${RESET}"
        read -r || true
        return
    fi
    bash "$script"
}

_badge() {
    # $1 = installed(0/1 via function name), $2 = status string
    if "$1"; then
        local st; st="$($2)"
        if [[ -n "$st" ]]; then echo -e "${GREEN}● $st${RESET}"; else echo -e "${YELLOW}installed (stopped)${RESET}"; fi
    else
        echo -e "${DIM}not installed${RESET}"
    fi
}

show_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 09) GRIN CONNECTIVITY HUB${RESET} ${YELLOW}(IN DEVELOPMENT)${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  ${DIM}How Grin participants reach each other — transport, relays, messaging.${RESET}"
    echo ""
    echo -e "  ${GREEN}1${RESET}) Floonet Relay           $(_badge _091_installed _091_status)"
    echo -e "     ${DIM}Deploy floonet-rs — join the P2P privacy relay network${RESET}"
    echo ""
    echo -e "  ${GREEN}2${RESET}) Grin Transporter        $(_badge _093_installed _093_status)"
    echo -e "     ${DIM}Store-and-forward slate relay — offline auto-payouts (HTTP, not SMTP)${RESET}"
    echo ""
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -ne "${BOLD}Select [1-2 / 0]: ${RESET}"
}

main() {
    while true; do
        show_menu
        read -r choice || true
        case "$choice" in
            1) run_sub "091_grin_floonet_relay.sh"  || true ;;
            2) run_sub "093_grin_transporter.sh"    || true ;;
            0) break ;;
            "") continue ;;
            *) echo -e "\n${RED}Invalid option.${RESET}"; sleep 1 ;;
        esac
    done
}

main
