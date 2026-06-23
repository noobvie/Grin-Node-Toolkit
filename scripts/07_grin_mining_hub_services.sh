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
#   3) PUBLIC mining pool — Mainnet  → 07_grin_mining_public_pool.sh  (GRINIUM)
#        Full PPLNS pool: many miners, address-as-identity, Tor auto-payouts,
#        web dashboard + admin panel. Real GRIN. Best for a public pool operator.
#
#   4) PUBLIC mining pool — TESTNET  → 07_grin_mining_public_pool.sh testnet
#        The SAME pool, but a fully independent test install (own config/service/
#        dirs/ports — Central API 8090, stratum 13333, grin-pool-manager-testnet).
#        Test the whole block→maturity(100)→payout pipeline on fast tGRIN blocks,
#        then replicate on (3) Mainnet. Can coexist with a mainnet pool on one box;
#        only collides with SOLO. Needs a testnet grin node (Script 01 testnet-prune).
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

# Deployed solo stats-page vhost — the source of truth for Internet-vs-LAN mode
# (must match STATS_BASENAME in 07_grin_mining_solo.sh).
SOLO_STATS_VHOST="/etc/nginx/sites-available/grin-solo-mining-stat"

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

# Distinguish Internet vs LAN solo by inspecting the DEPLOYED stats vhost — the
# live source of truth (a re-deploy in the other mode rewrites it, so this can't
# go stale the way a stored flag would). Reads nothing if no stats page exists.
# Echoes a short human label (always rc 0). The two modes write structurally
# different vhosts: LAN binds `listen <ip>:<port>;`, Internet uses `listen 80;`
# with an FQDN server_name (+ a certbot-managed letsencrypt cert once SSL is up).
hub_detect_solo_mode() {
    local vhost="$SOLO_STATS_VHOST"
    if [[ ! -f "$vhost" ]]; then
        echo "stratum only — no stats page deployed"
        return 0
    fi
    # A `listen` directive carrying an IPv4 → LAN bind (Internet never does: its
    # server_name is a validated domain and it listens on bare :80 / :443).
    local lan_bind
    lan_bind=$(grep -m1 -oE 'listen[[:space:]]+[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]+' "$vhost" 2>/dev/null \
               | grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]+' || true)
    if [[ -n "$lan_bind" ]]; then
        # Hide the implied :80 so a bare-IP bind reads as a clean URL.
        echo "LAN · http://${lan_bind%:80}/"
        return 0
    fi
    # Internet: pull the domain from server_name; SSL state from the letsencrypt
    # cert / 443 listener that certbot --nginx injects in-place.
    local domain
    domain=$(grep -m1 -E '^[[:space:]]*server_name' "$vhost" 2>/dev/null \
             | sed -E 's/^[[:space:]]*server_name[[:space:]]+//; s/[[:space:];].*$//' || true)
    if grep -qE 'ssl_certificate[[:space:]]+/etc/letsencrypt/' "$vhost" 2>/dev/null \
       || grep -qE 'listen[^;]*443' "$vhost" 2>/dev/null; then
        echo "Internet · https://${domain:-?} (SSL)"
    else
        echo "Internet · http://${domain:-?} (SSL pending)"
    fi
    return 0
}

hub_detect_public() {
    local m
    # Detect EITHER network — mainnet (grin_pubpool.json / pubpool/mainnet, + pre-rename
    # legacy grin_pool.json / pool/mainnet) OR testnet (the _testnet/testnet siblings).
    # File checks come first so a pool that's been Configured but not yet Installed (config
    # written, no systemd unit yet) is still detected; the systemd grep is the backstop.
    for m in \
        "/opt/grin/conf/grin_pubpool.json" \
        "/opt/grin/pubpool/mainnet" \
        "/opt/grin/conf/grin_pubpool_testnet.json" \
        "/opt/grin/pubpool/testnet" \
        "/opt/grin/conf/grin_pool.json" \
        "/opt/grin/pool/mainnet"
    do
        [[ -e "$m" ]] && { echo "$m"; return 0; }
    done
    # Substring match catches both grin-pool-manager AND grin-pool-manager-testnet.
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
            # No arg → the pool script defaults to mainnet (real GRIN). Kept explicitly
            # bare so testnet config can never leak into the mainnet flow.
            want_script="$PUBLIC_SCRIPT"
            other_name="Solo PRIVATE mining"
            other_marker=$(hub_detect_solo || true)
            ;;
        public-testnet)
            # `testnet` launch arg → fully independent test install (8090 / 13333 /
            # grin-pool-manager-testnet). Same SOLO-only collision as mainnet public;
            # it can coexist with a mainnet public pool on the same box.
            want_script="$PUBLIC_SCRIPT"
            want_arg="testnet"
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

    # Within solo: Internet and LAN are the SAME product (shared wallet/stratum/
    # ports/dirs) — only the stats-page vhost differs. If solo is already deployed
    # in the OTHER stats-page mode, warn and confirm before switching, because a
    # re-deploy in the new mode rewrites that vhost (and its URL/SSL). Re-entering
    # the same mode, or solo with no stats page yet, passes through silently.
    if [[ "$want" == "solo" || "$want" == "solo-lan" ]] && hub_detect_solo >/dev/null 2>&1; then
        local want_mode cur_label cur_word ans
        want_mode="Internet"; [[ "$want" == "solo-lan" ]] && want_mode="LAN"
        cur_label=$(hub_detect_solo_mode || true)
        cur_word=${cur_label%% *}                       # "Internet" | "LAN" | "stratum"
        if { [[ "$cur_word" == "Internet" ]] || [[ "$cur_word" == "LAN" ]]; } \
           && [[ "$cur_word" != "$want_mode" ]]; then
            echo ""
            warn "Solo is already deployed in ${cur_word} mode:"
            echo -e "    ${DIM}· ${cur_label}${RESET}"
            warn "Internet and LAN are the same solo setup — only the stats page differs."
            warn "Continuing in ${want_mode} mode re-deploys the stats page and OVERWRITES"
            warn "the ${cur_word} vhost (and its URL/SSL)."
            echo ""
            echo -ne "${BOLD}Continue and switch to ${want_mode} mode? [y/N]: ${RESET}"
            read -r ans || ans=""
            if [[ "${ans,,}" != "y" ]]; then
                info "Cancelled — keeping ${cur_word} mode."
                echo "Press Enter to return to the mining hub..."
                read -r
                return 0
            fi
        fi
    fi

    if [[ ! -f "$want_script" ]]; then
        error "Script not found: $want_script"
        echo "Press Enter to return to the mining hub..."
        read -r
        return 0
    fi

    if [[ "$want" == "solo" || "$want" == "solo-lan" ]]; then
        # Tell the solo script it arrived via the hub so it skips its own
        # Internet/LAN mode-switch prompt — already handled above.
        SOLO_LAUNCHED_VIA_HUB=1 bash "$want_script" $want_arg
    else
        bash "$want_script" $want_arg
    fi
    return 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# MENU
# ═══════════════════════════════════════════════════════════════════════════════

hub_status_line() {
    local solo public mode
    solo=$(hub_detect_solo || true)
    public=$(hub_detect_public || true)
    if [[ -n "$solo" ]]; then
        mode=$(hub_detect_solo_mode || true)
        echo -e "  Active type: ${GREEN}Solo PRIVATE mining${RESET}  ${DIM}— ${mode}${RESET}"
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
    echo -e "  ${GREEN}3${RESET}) Public mining pool — Mainnet   ${DIM}(real GRIN · PPLNS, Tor payouts, web dashboard)${RESET}"
    echo -e "  ${GREEN}4${RESET}) Public mining pool — TESTNET   ${DIM}(independent test install · fast blocks · tGRIN, no real value)${RESET}"
    echo ""
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
}

main() {
    while true; do
        show_menu
        echo -ne "${BOLD}Select [0-4]: ${RESET}"
        read -r choice
        case "$choice" in
            1) hub_launch solo ;;
            2) hub_launch solo-lan ;;
            3) hub_launch public ;;
            4) hub_launch public-testnet ;;
            0|q|exit) break ;;
            "") continue ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

main "$@"
