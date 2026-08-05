#!/bin/bash
# =============================================================================
# 093_grin_transporter.sh — Grin Transporter (store-and-forward slate relay)
# =============================================================================
#
#  Member of the Grin Connectivity Hub (Script 09). Renumbered from the earlier
#  "Script 056" plan on 2026-07-04; swapped 091→093 with the Floonet relay on
#  2026-07-10 (Floonet shipped first). Phase 1 implemented 2026-07-11.
#
#  Self-hosted store-and-forward relay for Grin transaction slates.
#  Fills the gap Slatepack and Tor don't: automated AND offline-tolerant sends.
#  A payer drops an encrypted slate into a queue; the receiver collects it on
#  next poll — neither party needs to be online at the same instant.
#
#  NOT email/SMTP — it is a small HTTP(S) service (Node + Express + SQLite)
#  behind nginx, holding encrypted slates keyed by slatepack address. The
#  server is WALLETLESS (pure ciphertext queue); the poll AGENT runs next to
#  a grin-wallet (combined owner_api listener, the 059/07 model) and does all
#  crypto at the edge.
#
#  Phase 1 scope (standalone — no Drop/pool wiring, per 2026-07-11 decision):
#    server (queue + R8 challenge auth) + CLI agent (send/poll/finalize) +
#    nginx/certbot + optional Tor front + cron poll. Product integration
#    (pool payout rail #3, Drop claims) stays gated on design doc B.9 #6.
#
#  Design: docs/generated/script09_design.md  (PART B — 093)
#
#  ─── Network submenu ────────────────────────────────────────────────────────
#   1) Install server       (Node.js v24 + app + systemd)
#   2) Configure server     (TTL / size cap / queue-depth cap)
#   3) Domain & SSL         (nginx vhost + Let's Encrypt)
#   4) Tor hidden service   (optional .onion front)
#   5) Start / Stop         (systemd service)
#   6) Status
#   7) Install poll agent   (wire a local wallet to a Transporter)
#   8) Agent actions        (address / status / send / poll / cancel / cron)
#   L) Logs   D) Delete instance   0) Back
#
#  Ports (127.0.0.1, nginx-fronted only):  mainnet 7456 / testnet 7466
#  Dirs:  /opt/grin/transporter-{main,test}/  (app/, config.json, transporter.db)
#         /opt/grin/transporter-agent-{mainnet,testnet}/  (agent.js, agent.json)
#
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLKIT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# ─── Logging ──────────────────────────────────────────────────────────────────
LOG_DIR="/opt/grin/logs"
LOG_FILE="$LOG_DIR/grin_transporter_$(date +%Y%m%d_%H%M%S).log"
mkdir -p "$LOG_DIR" 2>/dev/null || true
log()     { echo -e "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; log "[INFO] $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; log "[OK] $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; log "[WARN] $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; log "[ERROR] $*"; }
pause()   { echo ""; echo -e "${DIM}Press Enter to continue...${RESET}"; read -r || true; }

# ─── Source paths (single copy, both networks) ────────────────────────────────
TRP_APP_SRC="$TOOLKIT_ROOT/web/093_transporter"
TRP_AGENT_SRC="$TOOLKIT_ROOT/web/093_transporter/client/agent.js"

# ─── Network-specific variables (set by trp_set_network) ──────────────────────
TRP_NETWORK=""      # testnet | mainnet
TRP_NET_SHORT=""    # test | main       (matches drop-test / drop-main dirs)
TRP_NET_LABEL=""
TRP_ADDR_HRP=""     # tgrin | grin
TRP_PORT=""         # 7466 | 7456       (127.0.0.1, nginx-fronted)
TRP_OWNER_PORT=""   # 13420 | 3420      (combined owner_api listener default)
TRP_DIR=""
TRP_APP_DIR=""
TRP_CONF_JSON=""
TRP_DB=""
TRP_SERVICE=""
TRP_AGENT_DIR=""
TRP_AGENT_CONF=""

trp_set_network() {
    case "$1" in
        mainnet)
            TRP_NETWORK="mainnet";  TRP_NET_SHORT="main"
            TRP_NET_LABEL="MAINNET"; TRP_ADDR_HRP="grin"
            TRP_PORT="7456";        TRP_OWNER_PORT="3420"
            ;;
        testnet)
            TRP_NETWORK="testnet";  TRP_NET_SHORT="test"
            TRP_NET_LABEL="TESTNET"; TRP_ADDR_HRP="tgrin"
            TRP_PORT="7466";        TRP_OWNER_PORT="13420"
            ;;
        *) error "trp_set_network: unknown network '$1'"; return 1 ;;
    esac
    TRP_DIR="/opt/grin/transporter-${TRP_NET_SHORT}"
    TRP_APP_DIR="$TRP_DIR/app"
    TRP_CONF_JSON="$TRP_DIR/config.json"
    TRP_DB="$TRP_DIR/transporter.db"
    TRP_SERVICE="grin-transporter-${TRP_NET_SHORT}"
    TRP_AGENT_DIR="/opt/grin/transporter-agent-${TRP_NETWORK}"
    TRP_AGENT_CONF="$TRP_AGENT_DIR/agent.json"
}

# ─── Source lib files ─────────────────────────────────────────────────────────
# shellcheck source=lib/nginx_shared_helpers.sh
source "$SCRIPT_DIR/lib/nginx_shared_helpers.sh"
# shellcheck source=lib/093_lib_server.sh
source "$SCRIPT_DIR/lib/093_lib_server.sh"
# shellcheck source=lib/093_lib_client.sh
source "$SCRIPT_DIR/lib/093_lib_client.sh"

# =============================================================================
# MENUS
# =============================================================================

_trp_net_badge() {
    local svc="grin-transporter-$1"
    if systemctl is-active --quiet "$svc" 2>/dev/null; then
        echo -e "${GREEN}● running${RESET}"
    elif [[ -d "/opt/grin/transporter-$1" ]]; then
        echo -e "${YELLOW}installed (stopped)${RESET}"
    else
        echo -e "${DIM}not installed${RESET}"
    fi
}

network_menu() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN} 093) GRIN TRANSPORTER — [$TRP_NET_LABEL]${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  ${DIM}Store-and-forward slate queue — automated + offline-tolerant sends.${RESET}"
        echo -e "  ${DIM}Server: 127.0.0.1:$TRP_PORT   Service: $TRP_SERVICE${RESET}"
        echo ""
        echo -e "  ${BOLD}Server${RESET}"
        echo -e "  ${GREEN}1${RESET}) Install server        ${DIM}(Node.js + app + systemd)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Configure server      ${DIM}(TTL / size / queue caps)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Domain & SSL          ${DIM}(nginx + Let's Encrypt)${RESET}"
        echo -e "  ${GREEN}4${RESET}) Tor hidden service    ${DIM}(optional .onion front)${RESET}"
        echo -e "  ${GREEN}5${RESET}) Start / Stop"
        echo -e "  ${GREEN}6${RESET}) Status"
        echo ""
        echo -e "  ${BOLD}Agent (wallet side)${RESET}"
        echo -e "  ${GREEN}7${RESET}) Install poll agent    ${DIM}(wire a local wallet)${RESET}"
        echo -e "  ${GREEN}8${RESET}) Agent actions         ${DIM}(address / send / poll / cron)${RESET}"
        echo ""
        echo -e "  ${YELLOW}L${RESET}) Logs"
        echo -e "  ${RED}D${RESET}) Delete instance"
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-8 / L / D / 0]: ${RESET}"
        local choice; read -r choice || true
        case "$choice" in
            1) trp_install_server   || true ;;
            2) trp_configure        || true ;;
            3) trp_setup_domain     || true ;;
            4) trp_setup_tor        || true ;;
            5) trp_service_ctl      || true ;;
            6) trp_status           || true ;;
            7) trp_agent_install    || true ;;
            8) trp_agent_menu       || true ;;
            [lL]) trp_logs          || true ;;
            [dD]) trp_uninstall     || true ;;
            0) break ;;
            "") continue ;;
            *) echo -e "\n${RED}Invalid option.${RESET}"; sleep 1 ;;
        esac
    done
}

select_network() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN} 093) GRIN TRANSPORTER${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  ${DIM}Self-hosted encrypted slate queue (HTTP, not email/SMTP).${RESET}"
        echo -e "  ${DIM}The only transport that is automated AND offline-tolerant:${RESET}"
        echo -e "  ${DIM}sender enqueues, receiver polls — never online together.${RESET}"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Testnet   $(_trp_net_badge test)"
        echo -e "     ${DIM}tGRIN — no monetary value, prove the round trip here first${RESET}"
        echo ""
        echo -e "  ${GREEN}2${RESET}) Mainnet   $(_trp_net_badge main)"
        echo -e "     ${DIM}⚠ real GRIN — deploy only after a verified testnet round trip${RESET}"
        echo ""
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-2 / 0]: ${RESET}"
        local choice; read -r choice || true
        case "$choice" in
            1) trp_set_network testnet  && network_menu || true ;;
            2) trp_set_network mainnet  && network_menu || true ;;
            0) break ;;
            "") continue ;;
            *) echo -e "\n${RED}Invalid option.${RESET}"; sleep 1 ;;
        esac
    done
}

# =============================================================================
# ENTRY
# =============================================================================

if [[ $EUID -ne 0 ]]; then
    error "Run as root (sudo) — this script manages systemd/nginx on the VPS."
    exit 1
fi

select_network
