#!/bin/bash
# =============================================================================
# 052_grin_accio.sh — Accio, the Grin public web wallet
# =============================================================================
#
#  Member of the Wallet Services hub (Script 05), fixed slot key `2`.
#
#  Created 2026-08-09 by build packet S0 ("Vendor & pin"), which is what
#  ASSIGNS the number 052 — a product gets its number the day its first file is
#  created. Every menu key is LIVE as of 2026-08-10 (packet S7), and hub 05
#  key `2` now dispatches here instead of to `_slot_notice`.
#
#  ⚠ NOTHING IN THIS PRODUCT HAS EVER RUN ON A VPS. Every packet from S1 to S7
#    was authored against the vendored tree and verified offline — `bash -n`,
#    `node --check`, unit assertions and end-to-end assertions against the real
#    server.js. What has NOT happened is a single build, deploy, send or
#    receive on a real box. The acceptance runs are all still owed, in the order
#    the design gives them: testnet build → deploy → send → receive, and only
#    then mainnet. A menu with no stubs is not the same thing as a tested one.
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
#  We write exactly four things:
#    1. the BUILD (052_lib_build.sh)   — replaces upstream's unpinned `wget`
#       build.sh; reads only from vendor/, prerenders the PHP at build time so
#       no php-fpm ever reaches the VPS.
#    2. the GATEWAY (Node, grin-accio-gateway) — one service carrying four
#       jobs: the /tor/ forwarder (replaces the SOCKS-Proxy nginx module), the
#       SSRF destination allowlist (Block-Access), the response-header
#       allowlist (Allow-Headers), and the /listen + /wallet/<suffix>/v2/foreign
#       inbound rail (replaces the UNLICENSED WebSocket-Listener daemon, which
#       we may not ship). Result: STOCK nginx, no custom modules, no apt-hold —
#       a module ABI break makes nginx refuse to start AT ALL, which would take
#       every other vhost on the box down with it.
#       ⚠ Upstream uses a FOURTH module its own README omits: headers-more
#       (more_set_headers x29) carries the entire security-header stack — CSP,
#       HSTS, COOP/COEP, Permissions-Policy, Onion-Location. Stock `add_header
#       ... always` replaces it, but `add_header` in a child block DISCARDS
#       every header inherited from its parent, which is how a CSP goes missing
#       from exactly the routes that matter. See PROVENANCE.md.
#    3. the DEPLOY (052_lib_nginx.sh)  — stock nginx vhost, certbot, onion.
#    4. the PIN KEEPER (052_lib_vendor.sh) — verifies vendor/ against
#       vendor/SHA256SUMS before every build, and reports (never takes) what
#       upstream changed since the pin. A pin nothing checks is a comment.
#
#  ─── Build packets (docs/generated/script052_design.md §"Build plan") ───────
#    S0  vendor & pin ...................................... DONE 2026-08-09
#    S1  052_lib_build.sh (own the build) ................... DONE 2026-08-09
#    S2  static deploy on testnet, stock nginx        [first VPS work]
#        └─ step 1 IS S1's acceptance test: run "Rebuild site" twice on the
#           VPS and diff site.SHA256SUMS.prev against site.SHA256SUMS.
#           Needs php-cli + php-mbstring + php-intl (build time only).
#    S3  gateway I  — /tor/ forwarder ....................... DONE 2026-08-09
#        └─ web/052_accio/gateway/ (Node, ZERO npm deps) + 052_lib_gateway.sh.
#           Self-test = 8 offline probes of the SSRF guard; the end-to-end
#           send to a Fidelius onion still needs a VPS and a browser.
#    S4a listen protocol spec (read listener.js) ........... DONE 2026-08-10
#        └─ script052_design.md §"Listen protocol" — the SOLE input to S4b.
#    S4b gateway II — /listen + /wallet/<suffix> ............ DONE 2026-08-10
#        └─ 4 more modules (ws/store/listen_route/wallet_route), still ZERO
#           npm deps. Adds the ONE thing this service writes to disk: the
#           suffix<->session table at /opt/grin/accio-<net>/gateway-state/.
#           Lose it and every wallet's RECEIVING ADDRESS changes. Self-test is
#           now 16 probes; the real receive still needs a VPS and a browser.
#    S5  Grin-default overlay, branding, About credit ...... DONE 2026-08-10
#        └─ web/052_accio/patches/public_html/, 16 files here — 17 today, S9
#           pass 1 added mqs.js. Every deviation is marked `ACCIO PATCH` —
#           grep for that, do not diff against vendor/.
#    S6  052_lib_vendor.sh (integrity + update check) ...... DONE 2026-08-10
#        └─ Verify is OFFLINE and now GATES the build: one changed byte under
#           vendor/, or one file added there that the manifest never listed,
#           and nothing is staged. Check upstream is the ONLY network action
#           in 052, is menu-only (never a timer), clones BARE so upstream code
#           is never checked out, and changes nothing.
#    S7  mainnet, SSL, onion, hub 05 wiring ................ DONE 2026-08-10
#        └─ 052_lib_nginx.sh (vhost + certbot + hidden service), the standalone
#           artefact in 052_lib_build.sh, the install/status/uninstall actions,
#           and hub 05 key `2` pointed at this script. S2's authorable half —
#           the nginx lib — is paid here too, because an SSL vhost cannot be
#           added to a vhost that was never written.
#    S8  security audit .................................... DONE 2026-08-11
#        └─ docs/generated/script052_security_audit.md — 8 fixed, 6 open.
#    S9+ deletion passes, one subsystem per session
#        └─ pass 1 (MQS) DONE 2026-08-11. Pass 2 waits for a box: it is the
#           pass that deletes files rather than reducing one.
#    R1–R8 review arc — the whole authored surface read once before S2 spends
#        VPS time on it. Plan + findings: script052_implementation.md.
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
#  ─── Ports (all 127.0.0.1, never reachable from outside) ────────────────────
#  THREE listeners on the onion path, not two — tor does not talk to the
#  gateway directly. It talks to a second nginx server block, which serves the
#  ~7 MB of static wallet itself and proxies only /tor/, /listen and /wallet/
#  through. So each hop needs its own port:
#
#     tor ──→ ACC_TOR_FRONT_PORT ──→ nginx onion block ──→ ACC_TOR_PORT ──→ gw
#             7581 main / 7591 test                        7580 / 7590
#     browser ─→ :443 ─→ nginx clearnet block ─→ ACC_PORT (7480 / 7490) ─→ gw
#
#  ⚠ ACC_TOR_PORT and ACC_TOR_FRONT_PORT ARE NOT INTERCHANGEABLE. Giving the
#    nginx onion block the gateway's own port is not a tidier arrangement, it
#    is a collision: whichever binds first wins, and when nginx wins the
#    gateway's listen() gets EADDRINUSE and server.js exits(1) — killing the
#    CLEARNET rails too, so enabling the onion breaks the working site. It also
#    makes the onion snippet proxy_pass to the block it is included by.
#
#  Dirs:  /opt/grin/accio-{main,test}/  (site/, gateway/, gateway-state/,
#                                        gateway.json, grin_accio.conf)
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
# Upstream's own build script, pinned separately. It is a SPEC, never executed:
# it wgets an unpinned master.zip, chmod 777 -R's the tree and rm -rf's itself.
ACC_STANDALONE_SRC="$ACC_PRODUCT_SRC/vendor/upstream-standalone-build"
ACC_PATCHES_SRC="$ACC_PRODUCT_SRC/patches"
ACC_GATEWAY_SRC="$ACC_PRODUCT_SRC/gateway"
ACC_PINNED_SHA="$ACC_PRODUCT_SRC/PINNED_SHA"

# ─── Network-specific variables (set by acc_set_network) ──────────────────────
ACC_NETWORK=""      # testnet | mainnet
ACC_NET_SHORT=""    # test | main       (matches drop-test / transporter-test dirs)
ACC_NET_LABEL=""
ACC_ADDR_HRP=""     # tgrin | grin
ACC_PORT=""         # 7490 | 7480       (gateway listener, fed by nginx :443)
ACC_TOR_PORT=""     # 7590 | 7580       (gateway listener, fed by the onion block)
ACC_TOR_FRONT_PORT="" # 7591 | 7581     (NGINX onion block, fed by tor itself)
ACC_NODE_URL=""     # default public node the browser polls (Script 04 vhost)
ACC_DIR=""
ACC_SITE_DIR=""     # built static tree nginx serves
ACC_GATEWAY_DIR=""
ACC_CONF=""
ACC_SERVICE=""

# Why the onion gets its OWN gateway port: nginx and Tor both arrive on
# 127.0.0.1, so the gateway cannot tell them apart by peer address — yet a Tor
# client controls its own HTTP headers and could forge X-Forwarded-For to mint
# a fresh identity per request, voiding every per-client limit. Separate ports
# let the gateway classify by socket.localPort and honour forwarding headers on
# the nginx port only. Learned the hard way on 093; do not point the hidden
# service at ACC_PORT.
#
# And why there is a THIRD port: the hidden service is fed to nginx, not to the
# gateway, so the chain is tor → ACC_TOR_FRONT_PORT (nginx) → ACC_TOR_PORT
# (gateway). Two numbers for three listeners is a bind collision, not a saving
# — see the port map in this file's header.
acc_set_network() {
    case "$1" in
        mainnet)
            ACC_NETWORK="mainnet";   ACC_NET_SHORT="main"
            ACC_NET_LABEL="MAINNET"; ACC_ADDR_HRP="grin"
            ACC_PORT="7480";         ACC_TOR_PORT="7580"
            ACC_TOR_FRONT_PORT="7581"
            ACC_NODE_URL="https://api.grin.money"
            ;;
        testnet)
            ACC_NETWORK="testnet";   ACC_NET_SHORT="test"
            ACC_NET_LABEL="TESTNET"; ACC_ADDR_HRP="tgrin"
            ACC_PORT="7490";         ACC_TOR_PORT="7590"
            ACC_TOR_FRONT_PORT="7591"
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

# The value is NEVER fed to `sed` as a replacement. It used to be, and every
# value that reaches here is operator- or Tor-supplied: a `&` silently expands
# to the whole match (a corrupt conf line nothing would explain), and a `|`
# closes the s/// and turns the rest into sed FLAGS — `w /some/file` writes, as
# root. Filter-and-append cannot misread its own input. The rewrite goes
# through a temp file and is copied back with `cat >`, not `mv`, so the conf
# keeps its inode, owner and mode (same idiom as _acn_torrc_strip).
# Nothing ever `source`s this file — it is read key-by-key by _acc_conf_get —
# so re-ordering a key to the end is free, and the duplicate-key drift the old
# `sed` path could leave behind is collapsed on every write.
_acc_conf_set() {
    local key="$1" val="$2" tmp
    mkdir -p "$(dirname "$ACC_CONF")"
    touch "$ACC_CONF"
    tmp="$(mktemp "${ACC_CONF}.XXXXXX")" || { error "_acc_conf_set: mktemp failed"; return 1; }
    grep -vE "^${key}=" "$ACC_CONF" > "$tmp" 2>/dev/null || true
    printf '%s=%s\n' "$key" "$val" >> "$tmp"
    cat "$tmp" > "$ACC_CONF"
    rm -f "$tmp"
}

# Libs are sourced on demand so a menu still renders when one is absent.
# Both failure modes have to be LOUD: every caller writes
# `_acc_load_lib x || { pause; return 0; }`, so a silent non-zero return here
# shows the operator a cleared screen and a bare "Press Enter" — a menu action
# that did nothing and said nothing.
_acc_load_lib() {
    local lib="$SCRIPT_DIR/lib/$1"
    if [[ ! -f "$lib" ]]; then
        error "Missing library: $lib"
        return 1
    fi
    # shellcheck disable=SC1090
    if ! source "$lib"; then
        error "Library failed to load: $lib"
        return 1
    fi
}

# =============================================================================
# ACTIONS
# =============================================================================
# Every action is idempotent and returns 0. This menu loop runs under `set -e`,
# where an unguarded non-zero return kills the script instead of returning to
# the menu — the `|| true` on each dispatch below is the other half of that rule.
#
# There is no longer a stub screen in this file. Every key does the thing it
# names; the last two placeholders went with the mainnet/SSL/onion packet.

# The guided end-to-end deploy. It installs nothing itself — it runs the four
# actions that do, in the ONE order that lets a failure be read:
#
#   build → web front → gateway → gateway nginx glue → self-test
#
# That order is the packet plan's own advice, and it is about diagnosis, not
# tidiness: a build that does not render is not a branding bug, and a send that
# does not go out is not a gateway bug. Each step is separately re-runnable from
# the main menu, so a failure here is resumed, never restarted.
acc_install() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 052) ACCIO — INSTALL / DEPLOY [$ACC_NET_LABEL]${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  ${DIM}Five steps, each also available on its own from the main menu:${RESET}"
    echo ""
    echo -e "   ${BOLD}1${RESET} Build the site      ${DIM}vendor/ + patches/, offline, no network${RESET}"
    echo -e "   ${BOLD}2${RESET} Web front           ${DIM}stock nginx vhost + Let's Encrypt${RESET}"
    echo -e "   ${BOLD}3${RESET} Gateway service     ${DIM}$ACC_SERVICE on 127.0.0.1:$ACC_PORT${RESET}"
    echo -e "   ${BOLD}4${RESET} Gateway nginx glue  ${DIM}/tor/ out, /listen + /wallet/ in${RESET}"
    echo -e "   ${BOLD}5${RESET} Self-test           ${DIM}16 offline probes${RESET}"
    echo ""
    echo -e "  ${DIM}The onion is deliberately NOT here — it is optional, and it forces${RESET}"
    echo -e "  ${DIM}a second build. Add it afterwards from \"4) Nginx, SSL & onion\".${RESET}"
    echo ""
    echo -e "  ${DIM}Chain data comes from $ACC_NODE_URL (Script 04);${RESET}"
    echo -e "  ${DIM}this box holds no seed and runs no grin-wallet binary.${RESET}"
    echo ""
    echo -ne "${BOLD}Run all five now? [y/N]: ${RESET}"
    local go; read -r go || true
    if [[ "${go,,}" != "y" ]]; then info "Cancelled — nothing was changed."; pause; return 0; fi

    # Step 2 is what prompts for and records the domain, but step 1 needs it
    # first, so the web front runs before the build when there is no domain yet.
    # Doing it the other way round means acc_rebuild's bootstrap prompt asks for
    # a domain that acn_deploy_web then asks for again.
    _acc_load_lib "052_lib_nginx.sh" || { pause; return 0; }
    _acc_load_lib "052_lib_gateway.sh" || { pause; return 0; }

    local domain; domain="$(_acc_conf_get ACCIO_DOMAIN "")"
    if [[ -z "$domain" ]]; then
        info "No domain recorded yet — running the web front first so it is asked once."
        sleep 1
        acn_deploy_web || true
        acc_rebuild    || true
    else
        acc_rebuild    || true
        acn_deploy_web || true
    fi

    acg_install_gateway || true
    acg_nginx_glue      || true

    # The glue APPENDS its include to the end of the server block when the vhost
    # did not already carry one — which is the state a first deploy leaves,
    # because the web front is written before the gateway exists. That puts the
    # gateway locations after the static-asset regex, which is the one order
    # 052_lib_nginx.sh says must not happen. Regenerating the vhost from config
    # puts the include back where the writer places it.
    acn_refresh_vhost   || true

    acg_selftest        || true

    clear
    echo -e "\n${BOLD}${CYAN}── Accio [$ACC_NET_LABEL] — deploy finished ──${RESET}\n"
    domain="$(_acc_conf_get ACCIO_DOMAIN "")"
    # Scheme from the config, not from optimism: certbot may have been declined
    # or may have failed, and printing an https:// URL that answers nothing is
    # read as "the deploy broke" rather than "TLS was never issued".
    local scheme="http"
    if [[ "$(_acc_conf_get ACCIO_HTTPS off)" == "on" ]]; then scheme="https"; fi
    if [[ -z "$domain" ]]; then
        echo -e "  Site       ${YELLOW}no domain recorded — the web front did not complete${RESET}"
    else
        echo -e "  Site       ${BOLD}${scheme}://${domain}${RESET}"
        if [[ "$scheme" == "http" ]]; then
            echo -e "             ${YELLOW}no certificate yet — \"4) Nginx, SSL & onion\"${RESET}"
        fi
    fi
    echo -e "  Gateway    ${DIM}$ACC_SERVICE — 127.0.0.1:$ACC_PORT${RESET}"
    echo -e "  Node       ${DIM}$(_acc_conf_get ACCIO_NODE_URL "$ACC_NODE_URL")${RESET}"
    echo ""
    echo -e "  ${BOLD}What is NOT proved by any of the above${RESET}"
    echo -e "  ${DIM}Open the page in a browser and, in this order:${RESET}"
    echo -e "  ${DIM}  1. create a wallet and watch the balance sync   (the node rail)${RESET}"
    echo -e "  ${DIM}  2. send to a Fidelius onion address             (the /tor/ rail)${RESET}"
    echo -e "  ${DIM}  3. receive a payment on the address it shows    (the /listen rail)${RESET}"
    echo -e "  ${DIM}Three different rails. Do not debug two of them at once.${RESET}"
    log "[acc_install] net=$ACC_NETWORK domain=$domain"
    pause
    return 0
}

# The build is pure file work — it installs nothing and starts nothing, so it
# is safe to run on a box with no vhost, no gateway and no certificate.
acc_rebuild() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 052) ACCIO — REBUILD SITE [$ACC_NET_LABEL]${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  ${DIM}Renders the vendored wallet into static files. PHP runs HERE,${RESET}"
    echo -e "  ${DIM}once, at build time — no php-fpm is installed or reachable.${RESET}"
    echo -e "  ${DIM}Reads only vendor/ + patches/. Makes no network request.${RESET}"
    echo ""

    _acc_load_lib "052_lib_build.sh" || { pause; return 0; }

    # SERVER_NAME is baked into the output (canonical URL, hreflang, manifest),
    # so a build needs the domain. Asked ONCE, then persisted: every later
    # rebuild reads $ACC_CONF and never prompts. "Nginx, SSL & onion" records
    # the same key — this is only the bootstrap for building before it has run.
    local domain
    domain="$(_acc_conf_get ACCIO_DOMAIN "")"
    if [[ -z "$domain" ]]; then
        echo -e "  ${YELLOW}No domain recorded in $ACC_CONF yet.${RESET}"
        echo -e "  ${DIM}Example: wallet.grin.money  (testnet: testwallet.grin.money)${RESET}"
        echo ""
        echo -ne "${BOLD}Domain for this deployment: ${RESET}"
        read -r domain || true
        domain="${domain// /}"
        if [[ -z "$domain" ]]; then
            warn "No domain given — nothing was built."
            pause; return 0
        fi
        # Same test as nginx_validate_domain() in lib/nginx_shared_helpers.sh,
        # inlined because this path deliberately does not source the nginx lib.
        # It has to be applied HERE, not only at deploy time: the name is baked
        # into canonical URLs, hreflang and the web manifest, so an unusable one
        # accepted here is discovered by acn_deploy_web AFTER a full build has
        # already shipped it.
        if [[ ! "$domain" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$ ]]; then
            error "Not a usable domain name: $domain"
            warn "Nothing was built and nothing was recorded."
            pause; return 0
        fi
        _acc_conf_set ACCIO_DOMAIN "$domain"
        _acc_conf_set ACCIO_NETWORK "$ACC_NETWORK"
        _acc_conf_set ACCIO_NODE_URL "$(_acc_conf_get ACCIO_NODE_URL "$ACC_NODE_URL")"
        _acc_conf_set ACCIO_GATEWAY_PORT "$(_acc_conf_get ACCIO_GATEWAY_PORT "$ACC_PORT")"
        _acc_conf_set ACCIO_TOR_PORT "$(_acc_conf_get ACCIO_TOR_PORT "$ACC_TOR_PORT")"
        _acc_conf_set ACCIO_TOR_FRONT_PORT "$(_acc_conf_get ACCIO_TOR_FRONT_PORT "$ACC_TOR_FRONT_PORT")"
        # HTTPS/ONION stay off until a cert is issued and an onion is minted;
        # both of those actions flip the key AND offer the rebuild it forces.
        _acc_conf_set ACCIO_HTTPS "$(_acc_conf_get ACCIO_HTTPS off)"
        _acc_conf_set ACCIO_ONION "$(_acc_conf_get ACCIO_ONION '')"
        success "Recorded in $ACC_CONF — future rebuilds will not ask again."
        echo ""
    fi

    accio_build "$ACC_NETWORK" "$domain" "$ACC_SITE_DIR" || error "Build failed — $ACC_SITE_DIR was left untouched."
    pause
    return 0
}

# LIVE since S3, for the /tor/ route only. The service it installs is the SAME
# one S4b extends with /listen + /wallet/<id>/v2/foreign — one unit per network,
# not one per route.
acc_gateway_ctl() {
    _acc_load_lib "052_lib_gateway.sh" || { pause; return 0; }
    acg_gateway_menu
    return 0
}

acc_nginx() {
    _acc_load_lib "052_lib_nginx.sh" || { pause; return 0; }
    acn_nginx_menu
    return 0
}

# LIVE since S6. Network-agnostic — vendor/ is one copy shared by both
# networks, so this screen is identical whichever one you entered through.
acc_check_upstream() {
    _acc_load_lib "052_lib_vendor.sh" || { pause; return 0; }
    acv_vendor_menu
    return 0
}

acc_standalone() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 052) ACCIO — STANDALONE HTML [$ACC_NET_LABEL]${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  ${DIM}One self-contained index.html — every image, font, shader, WASM${RESET}"
    echo -e "  ${DIM}blob, stylesheet, worker and script folded in as data: URIs or${RESET}"
    echo -e "  ${DIM}inline tags. Copy it to a USB stick and it works with no server${RESET}"
    echo -e "  ${DIM}and no network. Built from the same vendored, verified tree.${RESET}"
    echo ""
    echo -e "  ${YELLOW}⚠ It can SEND but it cannot RECEIVE.${RESET}"
    echo -e "  ${DIM}Receiving needs a listening socket and a browser tab has none;${RESET}"
    echo -e "  ${DIM}what lends it one is a gateway, and a gateway is a server.${RESET}"
    echo ""
    echo -e "  ${DIM}Served afterwards at /standalone.html — as a DOWNLOAD, because this${RESET}"
    echo -e "  ${DIM}site's own CSP forbids the data: URIs the file is made of.${RESET}"
    echo ""

    _acc_load_lib "052_lib_build.sh" || { pause; return 0; }
    accio_build_standalone "$ACC_NETWORK" || error "Standalone build failed — nothing was published."
    pause
    return 0
}

# One screen for the whole product on this network. Deliberately composed here
# rather than chaining the three per-subsystem status screens: those each end in
# a pause, and the question this answers — "is any part of it missing?" — is one
# an operator should be able to answer without pressing Enter three times.
acc_status() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 052) ACCIO — STATUS [$ACC_NET_LABEL]${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    local domain onion node
    domain="$(_acc_conf_get ACCIO_DOMAIN "")"
    onion="$(_acc_conf_get ACCIO_ONION "")"
    node="$(_acc_conf_get ACCIO_NODE_URL "$ACC_NODE_URL")"

    echo -e "  ${BOLD}Configuration${RESET}  ${DIM}$ACC_CONF${RESET}"
    echo -e "    Domain      ${domain:-${DIM}not set${RESET}}"
    echo -e "    Onion       ${onion:-${DIM}none${RESET}}"
    echo -e "    Node        $node"
    echo -e "    HTTPS       $(_acc_conf_get ACCIO_HTTPS off)"

    echo ""
    echo -e "  ${BOLD}Source${RESET}"
    if [[ -f "$ACC_PINNED_SHA" ]]; then
        local sha; sha=$(grep -E '^UPSTREAM_SHA=' "$ACC_PINNED_SHA" | cut -d'"' -f2 || echo "?")
        echo -e "    Pin         ${DIM}${sha:0:12} (web/052_accio/PINNED_SHA)${RESET}"
    else
        echo -e "    Pin         ${RED}PINNED_SHA missing${RESET}"
    fi
    if [[ -d "$ACC_VENDOR_SRC/public_html" ]]; then
        echo -e "    Vendored    ${GREEN}present${RESET} ${DIM}(integrity: menu 5)${RESET}"
    else
        echo -e "    Vendored    ${RED}MISSING — the repo is incomplete${RESET}"
    fi

    echo ""
    echo -e "  ${BOLD}Built site${RESET}"
    if [[ -s "$ACC_SITE_DIR/index.html" ]]; then
        local nfiles; nfiles=$(find "$ACC_SITE_DIR" -type f 2>/dev/null | wc -l)
        echo -e "    Files       ${GREEN}$nfiles${RESET} ${DIM}in $ACC_SITE_DIR${RESET}"
        if [[ -f "${ACC_SITE_DIR}.BUILD_INFO" ]]; then
            echo -e "    Built       ${DIM}$(grep -E '^built_utc=' "${ACC_SITE_DIR}.BUILD_INFO" | cut -d= -f2-)${RESET}"
            # Both of these are baked in at BUILD time, so a config change that
            # is not followed by a rebuild ships the OLD value to every visitor.
            # The onion is the dangerous one — an un-rebuilt site hands a
            # clearnet host to the user who deliberately picked "Onion Service"
            # — but a stale domain quietly breaks canonical URLs, hreflang and
            # the web manifest, and nothing else on this screen would show it.
            local b_onion b_domain
            b_onion=$(grep -E '^onion=' "${ACC_SITE_DIR}.BUILD_INFO" | cut -d= -f2-)
            b_domain=$(grep -E '^domain=' "${ACC_SITE_DIR}.BUILD_INFO" | cut -d= -f2-)
            if [[ "${b_onion:-}" != "$onion" ]]; then
                echo -e "    ${YELLOW}⚠ built with onion='${b_onion:-}' but configured '${onion:-}'${RESET}"
                echo -e "      ${DIM}rebuild, or \"Onion Service\" hands out the wrong host${RESET}"
            fi
            if [[ -n "$domain" && "${b_domain:-}" != "$domain" ]]; then
                echo -e "    ${YELLOW}⚠ built for '${b_domain:-}' but configured '$domain'${RESET}"
                echo -e "      ${DIM}rebuild — the old name is baked into every canonical URL${RESET}"
            fi
        fi
    else
        echo -e "    Files       ${YELLOW}not built yet (menu 2)${RESET}"
    fi
    if [[ -f "$ACC_DIR/standalone/current.html" ]]; then
        echo -e "    Standalone  ${GREEN}$(du -h "$ACC_DIR/standalone/current.html" 2>/dev/null | cut -f1)${RESET} ${DIM}→ /standalone.html${RESET}"
    else
        echo -e "    Standalone  ${DIM}not built (menu 6)${RESET}"
    fi

    echo ""
    echo -e "  ${BOLD}Gateway${RESET} ${DIM}— the only moving part; holds no key, holds the addresses${RESET}"
    if systemctl is-active --quiet "$ACC_SERVICE" 2>/dev/null; then
        echo -e "    Service     ${GREEN}● running${RESET} ${DIM}($ACC_SERVICE)${RESET}"
    elif [[ -f "/etc/systemd/system/${ACC_SERVICE}.service" ]]; then
        echo -e "    Service     ${YELLOW}installed, stopped${RESET}"
    else
        echo -e "    Service     ${DIM}not installed (menu 3)${RESET}"
    fi
    local state="$ACC_DIR/gateway-state/listen-state.json"
    if [[ -f "$state" ]]; then
        echo -e "    Addresses   ${GREEN}$state${RESET}"
        echo -e "                ${DIM}⚠ back this up — losing it changes every wallet's address${RESET}"
    else
        echo -e "    Addresses   ${DIM}no table yet (no wallet has connected)${RESET}"
    fi
    if command -v ss &>/dev/null; then
        if ss -ltn 2>/dev/null | grep -q '127.0.0.1:9050'; then
            echo -e "    Tor SOCKS   ${GREEN}127.0.0.1:9050${RESET}"
        else
            echo -e "    Tor SOCKS   ${RED}absent — every send to an onion answers 502${RESET}"
        fi
    fi

    echo ""
    echo -e "  ${BOLD}Web front${RESET}"
    local vhost="/etc/nginx/sites-available/accio-${ACC_NET_SHORT}"
    if [[ -f "$vhost" ]]; then
        if grep -q 'listen 443' "$vhost" 2>/dev/null; then
            echo -e "    Vhost       ${GREEN}TLS${RESET} ${DIM}$vhost${RESET}"
        else
            echo -e "    Vhost       ${YELLOW}HTTP bootstrap only — certbot has not run${RESET}"
        fi
    else
        echo -e "    Vhost       ${DIM}not deployed (menu 4)${RESET}"
    fi
    if [[ -n "$domain" && -f "/etc/letsencrypt/live/$domain/fullchain.pem" ]]; then
        echo -e "    Certificate ${GREEN}expires $(openssl x509 -enddate -noout -in "/etc/letsencrypt/live/$domain/fullchain.pem" 2>/dev/null | cut -d= -f2)${RESET}"
    else
        echo -e "    Certificate ${DIM}none${RESET}"
    fi
    if grep -rqsF "accio-${ACC_NET_SHORT}-gateway.conf" "$vhost" 2>/dev/null; then
        echo -e "    Routes      ${GREEN}/tor/, /listen, /wallet/ are proxied${RESET}"
    else
        echo -e "    Routes      ${YELLOW}gateway not included — the page loads, but it${RESET}"
        echo -e "                ${YELLOW}cannot send to an onion or receive a payment${RESET}"
    fi
    if [[ -f "/etc/nginx/snippets/accio-${ACC_NET_SHORT}-headers.conf" ]]; then
        echo -e "    Headers     ${GREEN}CSP + friends present${RESET}"
    else
        echo -e "    Headers     ${YELLOW}snippet missing — no CSP on a wallet page${RESET}"
    fi

    pause
    return 0
}

acc_uninstall() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 052) ACCIO — UNINSTALL [$ACC_NET_LABEL]${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  ${DIM}Removes, for THIS network only:${RESET}"
    echo -e "    ${DIM}• the gateway service $ACC_SERVICE and its unit${RESET}"
    echo -e "    ${DIM}• both nginx vhosts, the header and gateway snippets${RESET}"
    echo -e "    ${DIM}• the torrc hidden-service block${RESET}"
    echo ""
    echo -e "  ${DIM}KEPT unless you say otherwise below:${RESET}"
    echo -e "    ${DIM}• $ACC_DIR — the built site AND the address table${RESET}"
    echo -e "    ${DIM}• the TLS certificate (certbot delete removes it)${RESET}"
    echo -e "    ${DIM}• the onion secret key at /var/lib/tor/grin-accio-${ACC_NET_SHORT}${RESET}"
    echo ""
    echo -e "  ${DIM}The other network's Accio, and every other product on this box,${RESET}"
    echo -e "  ${DIM}are untouched. No custody risk either way — nothing here ever${RESET}"
    echo -e "  ${DIM}held a seed.${RESET}"
    echo ""
    echo -ne "  Type ${BOLD}REMOVE${RESET} to confirm: "
    local c; read -r c || true
    if [[ "$c" != "REMOVE" ]]; then info "Cancelled."; pause; return 0; fi

    systemctl disable --now "$ACC_SERVICE" 2>/dev/null || true
    rm -f "/etc/systemd/system/${ACC_SERVICE}.service"
    systemctl daemon-reload 2>/dev/null || true
    rm -rf "${ACC_GATEWAY_DIR:?}"
    rm -f "/etc/nginx/sites-enabled/accio-${ACC_NET_SHORT}" \
          "/etc/nginx/sites-available/accio-${ACC_NET_SHORT}" \
          "/etc/nginx/sites-enabled/accio-${ACC_NET_SHORT}-onion" \
          "/etc/nginx/sites-available/accio-${ACC_NET_SHORT}-onion" \
          "/etc/nginx/snippets/accio-${ACC_NET_SHORT}-headers.conf" \
          "/etc/nginx/snippets/accio-${ACC_NET_SHORT}-tls-headers.conf" \
          "/etc/nginx/snippets/accio-${ACC_NET_SHORT}-gateway.conf" \
          "/etc/nginx/snippets/accio-${ACC_NET_SHORT}-gateway-onion.conf"

    # A gateway include can be living in a vhost we did NOT name. acg_nginx_glue
    # targets _acg_find_vhost, which will happily pick sites-available/<domain>
    # or any vhost whose root is the site dir — so deleting only accio-<net>
    # can leave an `include` pointing at a snippet that no longer exists. nginx
    # refuses to START on a missing include: that is not a broken wallet, it is
    # every other vhost on this box down at the next reload or reboot. The
    # gateway lib sweeps for exactly this; the sweep has to happen here too,
    # because this action does the removal itself instead of calling it.
    if [[ -d /etc/nginx/sites-available ]]; then
        local v
        while IFS= read -r v; do
            [[ -n "$v" && -f "$v" ]] || continue
            warn "Removing a now-dangling Accio include from $v"
            # `%` as the address delimiter, NOT the `\|…|d` the gateway lib
            # uses: that form works there only because its pattern carries no
            # alternation. Here the `|` in (gateway…|headers) would close the
            # address early — "sed: unmatched (" on a live uninstall.
            #
            # `(tls-)?headers` and not a bare `headers`: the alternation has to
            # match from `accio-<net>-` onwards, so a pattern ending `headers\.
            # conf` does NOT match `accio-<net>-tls-headers.conf` — the two
            # snippets look alike and are swept by different branches.
            sed -i -E "\%accio-${ACC_NET_SHORT}-(gateway(-onion)?|(tls-)?headers)\.conf%d" "$v"
        done < <(grep -rlsE "accio-${ACC_NET_SHORT}-(gateway(-onion)?|(tls-)?headers)\.conf" \
                     /etc/nginx/sites-available 2>/dev/null || true)
    fi

    # The torrc block would otherwise keep publishing a hidden service pointed
    # at a port nothing listens on any more.
    if _acc_load_lib "052_lib_nginx.sh"; then
        _acn_torrc_strip || true
        systemctl restart tor@default 2>/dev/null || systemctl restart tor 2>/dev/null || true
    else
        warn "The torrc hidden-service block was NOT removed (nginx lib unavailable)."
        warn "Strip it by hand: the marker is '# grin-accio-${ACC_NET_SHORT} (script 052)'."
    fi

    if command -v nginx &>/dev/null; then
        if nginx -t 2>/dev/null; then
            systemctl reload nginx 2>/dev/null && success "nginx reloaded."
        else
            error "nginx -t fails AFTER the removal — this must be fixed now:"
            nginx -t 2>&1 | sed 's/^/    /' || true
        fi
    fi
    success "Service, units, vhosts and snippets removed."

    # ── the one genuinely destructive choice, asked separately ───────────────
    echo ""
    echo -e "  ${BOLD}$ACC_DIR still exists.${RESET}"
    echo -e "  ${DIM}It holds the built site and — the part that matters —${RESET}"
    echo -e "  ${YELLOW}gateway-state/listen-state.json, the suffix ↔ session table.${RESET}"
    echo -e "  ${DIM}That table IS every wallet's receiving address. Delete it and every${RESET}"
    echo -e "  ${DIM}address this deployment ever handed out stops working: a payment${RESET}"
    echo -e "  ${DIM}sent to an old one is answered 404 with nothing to explain it.${RESET}"
    echo ""
    echo -ne "  Type ${BOLD}DELETE-ADDRESSES${RESET} to remove it too, or Enter to keep: "
    local d; read -r d || true
    if [[ "$d" == "DELETE-ADDRESSES" ]]; then
        rm -rf "${ACC_DIR:?}"
        warn "$ACC_DIR removed — every previously issued address is now dead."
    else
        info "Kept: $ACC_DIR (a reinstall gives every wallet its address back)."
    fi

    echo ""
    echo -e "  ${DIM}Also left in place, on purpose: the grinaccio system user and the${RESET}"
    echo -e "  ${DIM}accio_* rate zones (shared with the other network), the TLS cert${RESET}"
    echo -e "  ${DIM}and the onion key. Remove those by hand if you mean to.${RESET}"
    log "[acc_uninstall] net=$ACC_NETWORK purged_dir=${d:-no}"
    pause
    return 0
}

# =============================================================================
# MENUS
# =============================================================================

# The directory is NOT the installation test. /opt/grin/accio-<net> is created
# by the first _acc_conf_set — i.e. by typing a domain at the rebuild prompt —
# and it is deliberately KEPT by an uninstall that removed the unit, the vhosts
# and the snippets. Keying the badge to the dir advertises a product with no
# service, no vhost and no site as "installed (stopped)". The unit file is the
# thing an install writes and an uninstall removes.
_acc_net_badge() {
    local svc="grin-accio-$1"
    if systemctl is-active --quiet "$svc" 2>/dev/null; then
        echo -e "${GREEN}● running${RESET}"
    elif [[ -f "/etc/systemd/system/${svc}.service" ]]; then
        echo -e "${YELLOW}installed (stopped)${RESET}"
    elif [[ -s "/opt/grin/accio-$1/site/index.html" ]]; then
        echo -e "${YELLOW}site built, no gateway${RESET}"
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
        echo -e "  ${DIM}The gateway carries both rails: sends out via Tor, payments in.${RESET}"
        echo ""
        echo -e "  ${YELLOW}⚠ NOT YET PROVEN ON A LIVE BOX — no build, send or receive has run${RESET}"
        echo -e "  ${YELLOW}  on a VPS. Do testnet first, and watch each rail work.${RESET}"
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
