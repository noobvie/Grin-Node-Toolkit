#!/bin/bash
# =============================================================================
# 05_grin_wallet_service.sh — Grin Wallet Services Hub
# =============================================================================
#
#  Central launcher for all Grin wallet service scripts (051–055).
#  Each sub-script is fully self-contained — it manages its own wallet,
#  binary, nginx config, and systemd services independently.
#
#  Both mainnet and testnet can run on the same server simultaneously.
#  Each service is best run on its own dedicated server to avoid port
#  conflicts and security mixing between services.
#
#  ─── Sub-scripts ──────────────────────────────────────────────────────────
#   051  051_grin_private_web_wallet.sh   Personal browser wallet UI
#   052  052_grin_drop.sh                 Giveaway + donation portal
#   053  053_grin_woocommerce.sh          WooCommerce payment gateway
#   054  054_grin_payment_pro.sh          Payment Pro (coming soon)
#   055  055_grin_public_web_wallet.sh    Public WASM wallet (coming soon)
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

# 051 — installed if config.conf written by the script exists for either network
_051_installed() {
    [[ -f /opt/grin/webwallet/mainnet/config.conf ]] \
        || [[ -f /opt/grin/webwallet/testnet/config.conf ]]
}

# 051 — running if nginx sites-enabled symlink exists for either network
_051_status() {
    local mn="" tn=""
    [[ -L /etc/nginx/sites-enabled/web-wallet-main ]] && mn="mainnet"
    [[ -L /etc/nginx/sites-enabled/web-wallet-test ]] && tn="testnet"
    if [[ -n "$mn" && -n "$tn" ]]; then echo "mainnet + testnet"
    elif [[ -n "$mn" ]];           then echo "mainnet"
    elif [[ -n "$tn" ]];           then echo "testnet"
    else echo ""
    fi
}

# 052 — installed if app dir exists for either network
_052_installed() {
    [[ -d /opt/grin/drop-main ]] || [[ -d /opt/grin/drop-test ]]
}

# 052 — running networks (systemd active)
_052_status() {
    local mn="" tn=""
    systemctl is-active --quiet grin-drop-main 2>/dev/null && mn="mainnet"
    systemctl is-active --quiet grin-drop-test 2>/dev/null && tn="testnet"
    if [[ -n "$mn" && -n "$tn" ]]; then echo "mainnet + testnet"
    elif [[ -n "$mn" ]];           then echo "mainnet"
    elif [[ -n "$tn" ]];           then echo "testnet"
    else echo ""
    fi
}

# 053 — installed if bridge service file exists for either network
_053_installed() {
    [[ -f /etc/systemd/system/grin-wallet-bridge-main.service ]] \
        || [[ -f /etc/systemd/system/grin-wallet-bridge-test.service ]]
}

# 053 — running networks
_053_status() {
    local mn="" tn=""
    systemctl is-active --quiet grin-wallet-bridge-main 2>/dev/null && mn="mainnet"
    systemctl is-active --quiet grin-wallet-bridge-test 2>/dev/null && tn="testnet"
    if [[ -n "$mn" && -n "$tn" ]]; then echo "mainnet + testnet"
    elif [[ -n "$mn" ]];           then echo "mainnet"
    elif [[ -n "$tn" ]];           then echo "testnet"
    else echo ""
    fi
}

# =============================================================================
# MAIN MENU
# =============================================================================

show_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 05) GRIN WALLET SERVICES${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  ${YELLOW}Tip:${RESET} ${DIM}Install each service on its own dedicated server.${RESET}"
    echo -e "  ${DIM}     Mixing services on one machine risks port conflicts,${RESET}"
    echo -e "  ${DIM}     config collisions, and harder security isolation.${RESET}"
    echo -e "  ${DIM}     Each server can run both mainnet and testnet together.${RESET}"
    echo ""

    # ── running / installed status ────────────────────────────────────────────
    local any_shown=0

    local s051_run; s051_run=$(_051_status)
    local s052_run; s052_run=$(_052_status)
    local s053_run; s053_run=$(_053_status)

    local s051_inst=0 s052_inst=0 s053_inst=0
    _051_installed && s051_inst=1 || true
    _052_installed && s052_inst=1 || true
    _053_installed && s053_inst=1 || true

    # Show only running or installed services — hide untouched ones
    if [[ -n "$s051_run" || $s051_inst -eq 1 ]]; then
        any_shown=1
        if [[ -n "$s051_run" ]]; then
            echo -e "  ${GREEN}●${RESET} ${BOLD}Private Web Wallet${RESET}  ${GREEN}running${RESET}  ${DIM}($s051_run)${RESET}"
        else
            echo -e "  ${DIM}○ Private Web Wallet  installed · not running${RESET}"
        fi
    fi

    if [[ -n "$s052_run" || $s052_inst -eq 1 ]]; then
        any_shown=1
        if [[ -n "$s052_run" ]]; then
            echo -e "  ${GREEN}●${RESET} ${BOLD}Grin Drop${RESET}           ${GREEN}running${RESET}  ${DIM}($s052_run)${RESET}"
        else
            echo -e "  ${DIM}○ Grin Drop           installed · not running${RESET}"
        fi
    fi

    if [[ -n "$s053_run" || $s053_inst -eq 1 ]]; then
        any_shown=1
        if [[ -n "$s053_run" ]]; then
            echo -e "  ${GREEN}●${RESET} ${BOLD}WooCommerce${RESET}         ${GREEN}running${RESET}  ${DIM}($s053_run)${RESET}"
        else
            echo -e "  ${DIM}○ WooCommerce         installed · not running${RESET}"
        fi
    fi

    if [[ $any_shown -eq 0 ]]; then
        echo -e "  ${DIM}No wallet services installed yet.${RESET}"
    fi

    echo ""
    echo -e "${DIM}  ─── Launch ────────────────────────────────────────${RESET}"
    echo ""
    echo -e "  ${GREEN}1${RESET}) Private Web Wallet"
    echo -e "     ${DIM}Personal browser UI — nginx + PHP + Basic Auth${RESET}"
    echo ""
    echo -e "  ${GREEN}2${RESET}) Grin Drop"
    echo -e "     ${DIM}Giveaway + donation portal — Flask + systemd${RESET}"
    echo ""
    echo -e "  ${GREEN}3${RESET}) WooCommerce Payment Gateway"
    echo -e "     ${DIM}Flask bridge + WordPress/WooCommerce plugin${RESET}"
    echo ""
    echo -e "  ${DIM}4) Payment Pro              (coming soon)${RESET}"
    echo -e "     ${DIM}   Shopify / custom API payment processor${RESET}"
    echo ""
    echo -e "  ${DIM}5) Public Web Wallet        (coming soon)${RESET}"
    echo -e "     ${DIM}   Client-side WASM wallet — no server keys${RESET}"
    echo ""
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -ne "${BOLD}Select [1-5 / 0]: ${RESET}"
}

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

main() {
    while true; do
        show_menu
        read -r choice || true
        case "$choice" in
            1) run_sub "051_grin_private_web_wallet.sh" ;;
            2) run_sub "052_grin_drop.sh"               ;;
            3) run_sub "053_grin_woocommerce.sh"        ;;
            4) run_sub "054_grin_payment_pro.sh"        ;;
            5) run_sub "055_grin_public_web_wallet.sh"  ;;
            0) break ;;
            "") continue ;;
            *) echo -e "\n${RED}Invalid option.${RESET}"; sleep 1 ;;
        esac
    done
}

main "$@"
