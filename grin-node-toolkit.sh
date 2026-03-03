#!/bin/bash
# =============================================================================
# Grin Node Toolkit - Main Menu
# =============================================================================
# A unified toolkit for managing Grin cryptocurrency nodes and infrastructure.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$SCRIPT_DIR/scripts"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

check_os() {
    # Must be Linux
    if [[ "$(uname -s)" != "Linux" ]]; then
        echo -e "${RED}${BOLD}[ERROR]${RESET} This toolkit only runs on Linux."
        exit 1
    fi

    if [[ ! -f /etc/os-release ]]; then
        echo -e "${YELLOW}[WARN]${RESET}  Cannot detect OS (/etc/os-release not found). Proceeding with caution."
        sleep 2
        return
    fi

    local os_id os_id_like os_version_id os_name
    os_id="$(grep '^ID=' /etc/os-release | cut -d= -f2 | tr -d '"')"
    os_id_like="$(grep '^ID_LIKE=' /etc/os-release | cut -d= -f2- | tr -d '"' || true)"
    os_version_id="$(grep '^VERSION_ID=' /etc/os-release | cut -d= -f2 | tr -d '"' || true)"
    os_name="$(grep '^PRETTY_NAME=' /etc/os-release | cut -d= -f2- | tr -d '"' || true)"
    os_name="${os_name:-$os_id}"

    # Hard-stop for known non-Debian families (RHEL, Fedora, Arch, etc.)
    local non_debian_ids="rhel fedora centos almalinux rocky ol amzn sles opensuse arch manjaro gentoo void slackware"
    local blocked=0
    local matched_id=""
    for non_deb_id in $non_debian_ids; do
        if [[ "$os_id" == "$non_deb_id" ]]; then
            blocked=1
            matched_id="$os_id"
            break
        fi
        # ID_LIKE contains a non-Debian family AND does NOT claim Debian heritage
        if [[ "$os_id_like" == *"$non_deb_id"* ]] && [[ "$os_id_like" != *"debian"* ]]; then
            blocked=1
            matched_id="$non_deb_id (via ID_LIKE)"
            break
        fi
    done

    if [[ $blocked -eq 1 ]]; then
        echo ""
        echo -e "${RED}${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}"
        echo -e "${RED}${BOLD}║   UNSUPPORTED OPERATING SYSTEM — CANNOT CONTINUE        ║${RESET}"
        echo -e "${RED}${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}"
        echo ""
        echo -e "  Detected OS  : ${BOLD}${os_name}${RESET}"
        echo -e "  Detected ID  : ${os_id}  (ID_LIKE: ${os_id_like:-none})"
        echo -e "  Matched rule : ${matched_id}"
        echo ""
        echo -e "  ${RED}This toolkit requires a Debian-based Linux distribution.${RESET}"
        echo -e "  Non-Debian systems (RHEL, Fedora, AlmaLinux, Arch, etc.)"
        echo -e "  are NOT supported and this toolkit will not run on them."
        echo ""
        echo -e "  ${GREEN}Supported systems:${RESET}"
        echo -e "    ${GREEN}✓${RESET}  Ubuntu 22.04 LTS or later  ${DIM}(fully tested)${RESET}"
        echo -e "    ${YELLOW}~${RESET}  Other Debian-based distros  ${DIM}(best effort, not guaranteed)${RESET}"
        echo ""
        exit 1
    fi

    # Ubuntu — version check
    if [[ "$os_id" == "ubuntu" ]]; then
        local major_version
        major_version="$(echo "$os_version_id" | cut -d. -f1)"
        if (( major_version >= 22 )); then
            echo -e "${GREEN}[OK]${RESET}    OS detected: ${BOLD}${os_name}${RESET} — fully supported."
        else
            echo ""
            echo -e "${YELLOW}[WARN]${RESET}  OS detected: ${BOLD}${os_name}${RESET}"
            echo -e "         Ubuntu 22.04 LTS or later is recommended."
            echo -e "         This older version may work but is not fully tested."
            echo ""
            sleep 3
        fi
        return
    fi

    # Other Debian-based distros (Debian, Mint, Pop!_OS, Kali, etc.)
    if [[ "$os_id" == "debian" ]] || [[ "$os_id_like" == *"debian"* ]]; then
        echo ""
        echo -e "${YELLOW}[WARN]${RESET}  OS detected: ${BOLD}${os_name}${RESET}"
        echo -e "         This toolkit is fully tested on Ubuntu 22.04 LTS or later."
        echo -e "         Your Debian-based distro may work but is not fully guaranteed."
        echo ""
        sleep 3
        return
    fi

    # Unknown / unrecognised distro — warn and continue
    echo ""
    echo -e "${YELLOW}[WARN]${RESET}  OS detected: ${BOLD}${os_name}${RESET} — unrecognised distribution."
    echo -e "         This toolkit targets Debian-based Linux only."
    echo -e "         Proceeding anyway — errors are expected."
    echo ""
    sleep 3
}

check_scripts() {
    local missing=0
    local required_scripts=(
        "01_build_new_grin_node.sh"
        "02_nginx_fileserver_manager.sh"
        "03_grin_share_chain_data.sh"
        "04_grin_node_foreign_api.sh"
        "05_grin_wallet_service.sh"
        "06_global_grin_health.sh"
        "07_coming_soon.sh"
        "08_grin_node_admin.sh"
    )
    for script in "${required_scripts[@]}"; do
        if [[ ! -f "$SCRIPTS_DIR/$script" ]]; then
            echo -e "${RED}[MISSING]${RESET} $SCRIPTS_DIR/$script"
            missing=1
        fi
    done
    if [[ $missing -eq 1 ]]; then
        echo -e "${YELLOW}Warning: Some scripts are missing. Corresponding menu options will be disabled.${RESET}"
        sleep 2
    fi
}

run_script() {
    local script_name="$1"
    local script_path="$SCRIPTS_DIR/$script_name"
    if [[ ! -f "$script_path" ]]; then
        echo -e "${RED}Error: Script not found: $script_path${RESET}"
        echo "Press Enter to return to main menu..."
        read -r
        return 0
    fi
    bash "$script_path" || true
}

show_header() {
    clear
    echo -e "${YELLOW}${BOLD}"
    echo "     ╭─────────────────────────╮"
    echo "    ╱ /\/\ /\/\   \/\/  \/\/    ╲"
    echo "   │   M     W      M    W        │"
    echo "   │                              │"
    echo "   │        ╰────────╯            │"
    echo "    ╲                            ╱"
    echo "     ╰─────────────────────────╯"
    echo -e "${RESET}${CYAN}${BOLD}"
    echo "  ██████╗ ██████╗ ██╗███╗   ██╗"
    echo " ██╔════╝ ██╔══██╗██║████╗  ██║"
    echo " ██║  ███╗██████╔╝██║██╔██╗ ██║"
    echo " ██║   ██║██╔══██╗██║██║╚██╗██║"
    echo " ╚██████╔╝██║  ██║██║██║ ╚████║"
    echo "  ╚═════╝ ╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝"
    echo -e "${RESET}"
    echo -e "${BOLD} Grin Node Toolkit v1.0${RESET}"
    echo -e "${YELLOW}   Keep your Grin alive${RESET}"
    echo ""
    echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
}

show_main_menu() {
    show_header
    echo -e "${BOLD}  Core Features${RESET}"
    echo ""
    echo -e "  ${GREEN}1${RESET}) Setup Grin New Node"
    echo -e "  ${GREEN}2${RESET}) Manage Nginx Server"
    echo -e "  ${GREEN}3${RESET}) Share Grin Chain Data / Schedule"
    echo -e "  ${GREEN}4${RESET}) Publish Grin Node Services"
    echo ""
    echo -e "${DIM}  ─────────────────────────────────────────${RESET}"
    echo -e "${BOLD}  Addons${RESET} (Being developed)"
    echo ""
    echo -e "  ${GREEN}5${RESET}) Grin Wallet Service"
    echo -e "  ${GREEN}6${RESET}) Global Grin Health"
    echo -e "  ${YELLOW}7${RESET}) Coming Soon"
    echo -e "  ${GREEN}8${RESET}) Admin & Maintenance"
    echo ""
    echo -e "${DIM}  ─────────────────────────────────────────${RESET}"
    echo -e "  ${RED}0${RESET}) Exit"
    echo ""
    echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
}

main() {
    check_os
    check_scripts

    while true; do
        show_main_menu
        echo -ne "${BOLD}Select an option [0-8]: ${RESET}"
        read -r choice

        case "$choice" in
            1)
                echo -e "\n${CYAN}Starting: Setup Grin New Node...${RESET}\n"
                run_script "01_build_new_grin_node.sh"
                ;;
            2)
                echo -e "\n${CYAN}Starting: Nginx Server Manager...${RESET}\n"
                run_script "02_nginx_fileserver_manager.sh"
                ;;
            3)
                echo -e "\n${CYAN}Starting: Share Grin Chain Data...${RESET}\n"
                run_script "03_grin_share_chain_data.sh"
                ;;
            4)
                echo -e "\n${CYAN}Starting: Publish Grin Node Services...${RESET}\n"
                run_script "04_grin_node_foreign_api.sh"
                ;;
            5)
                echo -e "\n${CYAN}Starting: Grin Wallet Service...${RESET}\n"
                run_script "05_grin_wallet_service.sh"
                ;;
            6)
                echo -e "\n${CYAN}Starting: Global Grin Health...${RESET}\n"
                run_script "06_global_grin_health.sh"
                ;;
            7)
                echo -e "\n${CYAN}Starting: Coming Soon...${RESET}\n"
                run_script "07_coming_soon.sh"
                ;;
            8)
                echo -e "\n${CYAN}Starting: Admin & Maintenance...${RESET}\n"
                run_script "08_grin_node_admin.sh"
                ;;
            0)
                echo -e "\n${GREEN}Goodbye!${RESET}\n"
                exit 0
                ;;
            *)
                echo -e "\n${RED}Invalid option. Please enter a number between 0 and 8.${RESET}"
                sleep 1
                ;;
        esac
    done
}

main "$@"
