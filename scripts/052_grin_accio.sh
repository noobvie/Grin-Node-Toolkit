#!/bin/bash
# =============================================================================
# 052_grin_accio.sh — Accio, the Grin public web wallet
# =============================================================================
#
#  Member of the Wallet Services hub (Script 05), fixed slot key `2`.
#
#  ⚠ SKELETON — created 2026-08-09 by build packet S0 ("Vendor & pin"). Every
#    action below is a STUB that prints what it will do and changes nothing.
#    The file exists because creating it is what ASSIGNS the number 052, per
#    the toolkit rule "a product gets its number the day its first file is
#    created". Hub 05 key `2` still dispatches `_slot_notice` until S7.
#
#  Accio is the NON-CUSTODIAL sibling of Fidelius (051):
#    • 051 Fidelius — a web UI over the `grin-wallet` binary. The SERVER runs
#      the wallet and holds the keys. Built, deployed.
#    • 052 Accio   — a self-custodial browser wallet. The seed lives in the
#      TAB (IndexedDB, WASM crypto); this box never sees a key and no
#      `grin-wallet` binary is involved. Custody is zero.
#
#  It is NOT a static site. A browser tab cannot open a listening socket, so
#  sending and receiving both need a small server-side gateway (below).
#
#  ─── What is vendored, and what we write ────────────────────────────────────
#  The browser wallet is vendored, not written: `web/052_accio/vendor/
#  upstream-wallet/` is NicolasFlamel1/mwcwallet.com at commit adef11da (MIT,
#  v2.8.2), which already supports Grin as a first-class wallet type — its
#  stock node list even ships this toolkit's own api.grin.money. There is no
#  cryptography to port and no WASM to compile. See web/052_accio/PROVENANCE.md.
#
#  We write exactly three things:
#    1. the BUILD (052_lib_build.sh)   — replaces upstream's unpinned `wget`
#       build.sh; reads only from vendor/, prerenders the PHP at build time so
#       no php-fpm ever reaches the VPS.
#    2. the GATEWAY (Node, grin-accio-gateway) — one service carrying four
#       jobs: the /tor/ forwarder (replaces the SOCKS-Proxy nginx module), the
#       SSRF destination allowlist (Block-Access), the response-header
#       allowlist (Allow-Headers), and the /listen + /wallet/<id>/v2/foreign
#       inbound rail (replaces the UNLICENSED WebSocket-Listener daemon, which
#       we may not ship). Result: STOCK nginx, no custom modules, no apt-hold —
#       a module ABI break makes nginx refuse to start AT ALL, which would take
#       every other vhost on the box down with it.
#    3. the DEPLOY (052_lib_nginx.sh)  — stock nginx vhost, certbot, onion.
#
#  ─── Build packets (docs/generated/script052_design.md §"Build plan") ───────
#    S0  vendor & pin ...................................... DONE 2026-08-09
#    S1  052_lib_build.sh (own the build)
#    S2  static deploy on testnet, stock nginx        [first VPS work]
#    S3  gateway I  — /tor/ forwarder
#    S4a listen protocol spec (read listener.js)
#    S4b gateway II — /listen + /wallet/<id>/v2/foreign
#    S5  Grin-default overlay, branding, About credit
#    S6  052_lib_vendor.sh (integrity + upstream update check)
#    S7  mainnet, SSL, onion service, hub 05 wiring
#    S8  security audit  →  docs/generated/script052_security_audit.md
#    S9+ deletion passes, one subsystem per session
#
#  Design:  docs/generated/script052_design.md
#  Log:     docs/generated/script052_implementation.md
#
#  ─── Network submenu ────────────────────────────────────────────────────────
#   1) Install / deploy          5) Check upstream        (052_lib_vendor.sh)
#   2) Rebuild site              6) Build standalone HTML (052_lib_build.sh)
#   3) Gateway service           7) Status
#   4) Nginx, SSL & onion        8) Uninstall           0) Back
#
#  Ports (127.0.0.1, fronted only):   gateway  mainnet 7480 / testnet 7490
#  Onion front (separate port, only when Tor is enabled):      7580 / 7590
#  Dirs:  /opt/grin/accio-{main,test}/  (site/, gateway/, grin_accio.conf)
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
LOG_FILE="$LOG_DIR/grin_accio_$(date +%Y%m%d_%H%M%S).log"
mkdir -p "$LOG_DIR" 2>/dev/null || true
log()     { echo -e "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; log "[INFO] $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; log "[OK] $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; log "[WARN] $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; log "[ERROR] $*"; }
pause()   { echo ""; echo -e "${DIM}Press Enter to continue...${RESET}"; read -r || true; }

# ─── Source paths (single copy, both networks) ────────────────────────────────
# Never edit anything under vendor/ — changes are an overlay in patches/,
# applied by file replacement at build time. vendor/SHA256SUMS is the pin and
# `git log <PINNED_SHA>..upstream/master` is the upstream-fix review; editing
# in place breaks both.
ACC_PRODUCT_SRC="$TOOLKIT_ROOT/web/052_accio"
ACC_VENDOR_SRC="$ACC_PRODUCT_SRC/vendor/upstream-wallet"
ACC_PATCHES_SRC="$ACC_PRODUCT_SRC/patches"
ACC_GATEWAY_SRC="$ACC_PRODUCT_SRC/gateway"
ACC_PINNED_SHA="$ACC_PRODUCT_SRC/PINNED_SHA"

# ─── Network-specific variables (set by acc_set_network) ──────────────────────
ACC_NETWORK=""      # testnet | mainnet
ACC_NET_SHORT=""    # test | main       (matches drop-test / transporter-test dirs)
ACC_NET_LABEL=""
ACC_ADDR_HRP=""     # tgrin | grin
ACC_PORT=""         # 7490 | 7480       (gateway, 127.0.0.1, nginx front)
ACC_TOR_PORT=""     # 7590 | 7580       (gateway, 127.0.0.1, onion front)
ACC_NODE_URL=""     # default public node the browser polls (Script 04 vhost)
ACC_DIR=""
ACC_SITE_DIR=""     # built static tree nginx serves
ACC_GATEWAY_DIR=""
ACC_CONF=""
ACC_SERVICE=""

# Why the onion gets its OWN local port: nginx and Tor both arrive on
# 127.0.0.1, so the gateway cannot tell them apart by peer address — yet a Tor
# client controls its own HTTP headers and could forge X-Forwarded-For to mint
# a fresh identity per request, voiding every per-client limit. Separate ports
# let the gateway classify by socket.localPort and honour forwarding headers on
# the nginx port only. Learned the hard way on 093; do not point the hidden
# service at ACC_PORT.
acc_set_network() {
    case "$1" in
        mainnet)
            ACC_NETWORK="mainnet";   ACC_NET_SHORT="main"
            ACC_NET_LABEL="MAINNET"; ACC_ADDR_HRP="grin"
            ACC_PORT="7480";         ACC_TOR_PORT="7580"
            ACC_NODE_URL="https://api.grin.money"
            ;;
        testnet)
            ACC_NETWORK="testnet";   ACC_NET_SHORT="test"
            ACC_NET_LABEL="TESTNET"; ACC_ADDR_HRP="tgrin"
            ACC_PORT="7490";         ACC_TOR_PORT="7590"
            ACC_NODE_URL="https://testapi.grin.money"
            ;;
        *) error "acc_set_network: unknown network '$1'"; return 1 ;;
    esac
    ACC_DIR="/opt/grin/accio-${ACC_NET_SHORT}"
    ACC_SITE_DIR="$ACC_DIR/site"
    ACC_GATEWAY_DIR="$ACC_DIR/gateway"
    ACC_CONF="$ACC_DIR/grin_accio.conf"
    ACC_SERVICE="grin-accio-${ACC_NET_SHORT}"
}

# ─── Config (S1+) ─────────────────────────────────────────────────────────────
# Every action re-reads $ACC_CONF (domain, network, node URL, gateway port,
# onion address) so a rebuild never re-prompts, and every action is idempotent:
# unlike upstream's build.sh, ours run against a live box with other vhosts,
# live certs and a running gateway that must all survive.
_acc_conf_get() {
    local key="$1" default="${2:-}"
    [[ -f "$ACC_CONF" ]] || { echo "$default"; return 0; }
    local v
    v=$(grep -E "^${key}=" "$ACC_CONF" 2>/dev/null | tail -1 | cut -d= -f2-) || true
    if [[ -n "$v" ]]; then echo "$v"; else echo "$default"; fi
}

# =============================================================================
# ACTIONS — all stubs until their packet lands (see the packet map in the header)
# =============================================================================

# Prints what the action WILL do, states plainly that nothing changed, returns 0
# so the menu loop under `set -e` survives. Not the deleted "coming soon"
# placeholder script — this is a real product's real menu, ahead of its build.
_acc_stub() {
    local packet="$1" title="$2"; shift 2
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 052) ACCIO — $title${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  ${YELLOW}Not built yet — lands in packet ${BOLD}$packet${RESET}${YELLOW}.${RESET}"
    echo ""
    local line
    for line in "$@"; do echo -e "  ${DIM}$line${RESET}"; done
    echo ""
    echo -e "  ${DIM}Nothing was installed, changed or removed.${RESET}"
    echo -e "  ${DIM}Plan: docs/generated/script052_design.md §\"Build plan\"${RESET}"
    pause
    return 0
}

acc_install() {
    _acc_stub "S2 (testnet) / S7 (mainnet)" "INSTALL / DEPLOY [$ACC_NET_LABEL]" \
        "Builds the site from vendor/ and deploys it behind STOCK nginx." \
        "Installs the gateway service ($ACC_SERVICE) and writes" \
        "$ACC_CONF." \
        "Browser polls the chain via $ACC_NODE_URL (Script 04)."
}

acc_rebuild() {
    _acc_stub "S1" "REBUILD SITE [$ACC_NET_LABEL]" \
        "052_lib_build.sh — accio_build <net> <domain> <outdir>." \
        "Reads ONLY from vendor/ + patches/; asserts zero network access," \
        "which is what kills upstream's unpinned \`wget master.zip\`." \
        "Prerenders the 11 PHP files per language at BUILD time, so no" \
        "php-fpm reaches the VPS. Emits a SHA256SUMS of the built tree."
}

acc_gateway_ctl() {
    _acc_stub "S3 (/tor/) then S4b (/listen)" "GATEWAY SERVICE [$ACC_NET_LABEL]" \
        "status / start / stop / logs for $ACC_SERVICE." \
        "One Node service on 127.0.0.1:$ACC_PORT (onion front: $ACC_TOR_PORT)" \
        "replacing three nginx C modules and one unlicensed C++ daemon." \
        "It never holds a key — the seed stays in the browser tab."
}

acc_nginx() {
    _acc_stub "S2 (HTTP) / S7 (SSL + onion)" "NGINX, SSL & ONION [$ACC_NET_LABEL]" \
        "052_lib_nginx.sh — stock nginx vhost, static root + proxy_pass." \
        "HTTP-only vhost first, reload, certbot, THEN the SSL vhost —" \
        "never reference a cert path before the cert exists." \
        "Optional Tor hidden service for Accio itself (S7)."
}

acc_check_upstream() {
    local sha="unknown" ver="unknown"
    if [[ -f "$ACC_PINNED_SHA" ]]; then
        sha=$(grep -E '^UPSTREAM_SHA=' "$ACC_PINNED_SHA" | cut -d'"' -f2) || true
        ver=$(grep -E '^UPSTREAM_VERSION=' "$ACC_PINNED_SHA" | cut -d'"' -f2) || true
    fi
    _acc_stub "S6" "CHECK UPSTREAM" \
        "052_lib_vendor.sh — two jobs:" \
        "  1. verify vendor/ against vendor/SHA256SUMS (270 files) and fail" \
        "     the build on one changed byte;" \
        "  2. report \`git log <PINNED_SHA>..upstream/master\` for review." \
        "" \
        "Pinned at: ${sha:-unknown}  (v${ver:-unknown})" \
        "We never DEPEND on upstream to build — we retain the OPTION to take" \
        "a security fix. Taking one is a deliberate re-vendor + re-pin."
}

acc_standalone() {
    _acc_stub "S7" "BUILD STANDALONE HTML" \
        "The offline/airgapped artefact: one self-contained index.html with" \
        "every image, font, WASM blob and script inlined (upstream build.sh" \
        "lines 39-311, as a loop rather than 273 transcribed commands)." \
        "" \
        "⚠ It can SEND but CANNOT RECEIVE — the inbound rail is the gateway," \
        "  so a standalone user must run their own."
}

acc_status() {
    _acc_stub "S2" "STATUS [$ACC_NET_LABEL]" \
        "Vendored tree integrity, built-site presence, gateway health," \
        "nginx vhost + cert expiry, onion address, configured node URL."
}

acc_uninstall() {
    _acc_stub "S2" "UNINSTALL [$ACC_NET_LABEL]" \
        "Removes $ACC_DIR, the $ACC_SERVICE unit and the vhost." \
        "Leaves every other product on the box untouched." \
        "" \
        "No custody risk either way: nothing here ever held a seed."
}

# =============================================================================
# MENUS
# =============================================================================

_acc_net_badge() {
    local svc="grin-accio-$1"
    if systemctl is-active --quiet "$svc" 2>/dev/null; then
        echo -e "${GREEN}● running${RESET}"
    elif [[ -d "/opt/grin/accio-$1" ]]; then
        echo -e "${YELLOW}installed (stopped)${RESET}"
    else
        echo -e "${DIM}not installed${RESET}"
    fi
}

network_menu() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN} 052) ACCIO — PUBLIC WEB WALLET — [$ACC_NET_LABEL]${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  ${DIM}Self-custodial: the seed lives in the visitor's browser,${RESET}"
        echo -e "  ${DIM}never on this box. Gateway: 127.0.0.1:$ACC_PORT  ($ACC_SERVICE)${RESET}"
        echo ""
        echo -e "  ${YELLOW}⚠ SKELETON — every action is a stub until its packet lands.${RESET}"
        echo ""
        echo -e "  ${BOLD}Deploy${RESET}"
        echo -e "  ${GREEN}1${RESET}) Install / deploy      ${DIM}(site + gateway + nginx)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Rebuild site          ${DIM}(from vendor/ + patches/, offline)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Gateway service       ${DIM}(status / start / stop / logs)${RESET}"
        echo -e "  ${GREEN}4${RESET}) Nginx, SSL & onion    ${DIM}(stock nginx + Let's Encrypt)${RESET}"
        echo ""
        echo -e "  ${BOLD}Source${RESET}"
        echo -e "  ${GREEN}5${RESET}) Check upstream        ${DIM}(pin integrity + fixes to review)${RESET}"
        echo -e "  ${GREEN}6${RESET}) Build standalone HTML ${DIM}(offline artefact, send-only)${RESET}"
        echo ""
        echo -e "  ${GREEN}7${RESET}) Status"
        echo -e "  ${RED}8${RESET}) Uninstall"
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-8 / 0]: ${RESET}"
        local choice; read -r choice || true
        case "$choice" in
            1) acc_install        || true ;;
            2) acc_rebuild        || true ;;
            3) acc_gateway_ctl    || true ;;
            4) acc_nginx          || true ;;
            5) acc_check_upstream || true ;;
            6) acc_standalone     || true ;;
            7) acc_status         || true ;;
            8) acc_uninstall      || true ;;
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
        echo -e "${BOLD}${CYAN} 052) ACCIO — PUBLIC WEB WALLET${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  ${DIM}A self-custodial Grin wallet that runs in the visitor's tab.${RESET}"
        echo -e "  ${DIM}Keys are generated and kept in the browser; this server holds${RESET}"
        echo -e "  ${DIM}no seed and runs no grin-wallet binary. Custody is zero.${RESET}"
        echo ""
        echo -e "  ${DIM}Sibling of Fidelius (051), which is the opposite design:${RESET}"
        echo -e "  ${DIM}there the server runs the wallet and holds the keys.${RESET}"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Testnet   $(_acc_net_badge test)"
        echo -e "     ${DIM}tGRIN — no monetary value, prove send + receive here first${RESET}"
        echo ""
        echo -e "  ${GREEN}2${RESET}) Mainnet   $(_acc_net_badge main)"
        echo -e "     ${DIM}⚠ real GRIN — deploy only after a verified testnet round trip${RESET}"
        echo ""
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-2 / 0]: ${RESET}"
        local choice; read -r choice || true
        case "$choice" in
            1) acc_set_network testnet && network_menu || true ;;
            2) acc_set_network mainnet && network_menu || true ;;
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
