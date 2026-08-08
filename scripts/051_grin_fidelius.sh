#!/bin/bash
# =============================================================================
# 051_grin_fidelius.sh — Fidelius · Grin Personal Web Wallet (Node.js)
# =============================================================================
#
#  Personal, single-owner browser wallet UI for your own Grin node server.
#  Protected by Basic Auth — intended for the server owner only, not public.
#
#  Ports the GrinSuite Node.js wallet (noobvie/GrinSuite:web/03_web_wallet)
#  onto the toolkit. See docs/generated/script051_design_node_port_2026-05-24.md
#  for the full architecture and decisions.
#
#  ─── Architecture ────────────────────────────────────────────────────────────
#   ONE Node.js process serves MANY wallets across BOTH networks:
#     systemd : grin-fidelius.service     bound 127.0.0.1:7420
#     nginx   : reverse proxy → 127.0.0.1:7420 + Basic Auth + SSL
#     wallets : /opt/grin/fidelius/wallet_<net>_<name>/  per-wallet dirs
#     binary  : /opt/grin/fidelius/grin-wallet           single shared binary
#     registry: /opt/grin/fidelius/wallets_info.json     wallet list
#
#  ─── Menu ────────────────────────────────────────────────────────────────────
#   1) Install grin-wallet binary
#   2) Install dependencies        (nodejs, nginx, certbot, htpasswd, tor, qrencode)
#   3) Deploy files + systemd      (web/051_fidelius/ → /opt/grin/fidelius/app/)
#   4) Configure nginx             (HTTP vhost — step 5 adds HTTPS)
#   5) Setup SSL                   (Let's Encrypt or Cloudflare Origin Cert)
#   6) Setup Basic Auth            (htpasswd)
#   7) Configure firewall          (ports 80 + 443)
#   8) Status & info
#   9) Edit saved settings         (domain, email, auth user)
#   V) Private access              (WireGuard tunnel + DNS-01 cert — optional)
#   x) Launch XP Wallet            (mainnet only — separate experience)
#   0) Back to main menu
#
#  ─── Optional: private access (menu V) ───────────────────────────────────────
#   Moves the wallet off the public internet WITHOUT giving up a real Let's
#   Encrypt certificate for the same domain:
#
#     phone ══ udp/51820 ══▶ wg0 (10.9.0.1) ══▶ nginx 10.9.0.1:443 ══▶ :7420
#
#   The cert stays valid because DNS-01 proves domain control with a TXT record
#   and never connects to this host — so the host needs no public port, at issue
#   time or at renewal. `A wallet.example → 10.9.0.1` is a public record holding
#   a private address; only tunnelled devices can route to it.
#
#   Binding to the WireGuard address (rather than an `allow/deny` ACL) is the
#   point: an ACL still lets strangers complete TLS and reach nginx's HTTP layer
#   before refusal, so pre-auth bugs stay reachable. An address nginx never
#   listens on cannot be probed at all.
#
#   Two hard gates guard against self-lockout — the switch refuses to run until
#   a device has actually handshaked, and refuses an HTTP-01 certificate, whose
#   renewal would silently fail ~60 days after public port 80 goes away.
#
#   Implementation: scripts/lib/grin_wg_access.sh (shared — the pool admin panel
#   has the same shape of problem; Fidelius is only its first caller).
#   Note WireGuard changes WHO can reach the app, not what happens once they do:
#   server.js still runs as root, and a stolen device is a full bypass.
#
#  ─── Security ────────────────────────────────────────────────────────────────
#   nginx : auth_basic, server_tokens off, client_max_body_size 1m
#           HSTS, CSP (script-src 'self' — NO 'unsafe-inline'; the client has no
#           inline script or on*= handler left), X-Content-Type-Options,
#           X-Frame-Options, Referrer-Policy, Permissions-Policy, X-XSS-Protection: 0
#   nginx : fail2ban jail on 401s (step 7) — Basic Auth is the whole auth boundary
#   nginx : rate-limit zones _send(3r/m) _api(10r/m) _http(20r/m)
#   nginx : proxy_set_header Host $http_host → matches Node's WW_PUBLIC_HOST guard
#   Node  : ECDH Owner API v3, AES-256-GCM, passphrase via stdin (not argv)
#   Node  : Host/Origin guard, /connect rate limit, slatepack 16 KB cap
#   Node  : NETWORK_MISMATCH hard-block on Tor send (mainnet↔testnet)
#   Node  : show-seed passphrase-gated + rate-limited
#   systemd: ProtectSystem=full, ProtectHome=true, PrivateTmp=true,
#            NoNewPrivileges=true, ReadWritePaths=/opt/grin/fidelius
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

# GitHub API for grin-wallet releases.
#
# PINNED, and the pin is load-bearing. Every passphrase in this product reaches
# grin-wallet over stdin, which works only because 5.4.x pins rpassword 4.x
# (reads stdin, with an explicit non-TTY branch). rpassword 7 reads /dev/tty
# instead — a release taking that bump breaks init, listen and owner_api at once,
# so every wallet stops unlocking with no local change to blame. Following
# `latest` let an upstream tag do that unattended.
#
# v5.4.1 is ALSO the current latest, so this changes nothing today; it just stops
# a future release landing without a human. Keep in sync with GRIN_WALLET_PIN in
# web/051_fidelius/server.js. To move it: confirm grin-wallet's Cargo.toml still
# has rpassword 4.x, bump both, test an unlock, commit.
_WW_PIN_TAG="v5.4.1"
_WW_GITHUB_API="https://api.github.com/repos/mimblewimble/grin-wallet/releases/tags/${_WW_PIN_TAG}"
_WW_GITHUB_API_LATEST="https://api.github.com/repos/mimblewimble/grin-wallet/releases/latest"

# ─── Logging ──────────────────────────────────────────────────────────────────
LOG_DIR="/opt/grin/logs"
LOG_FILE="$LOG_DIR/grin_fidelius_$(date +%Y%m%d_%H%M%S).log"
mkdir -p "$LOG_DIR" 2>/dev/null || true
log()     { echo -e "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; log "[INFO] $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; log "[OK] $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; log "[WARN] $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; log "[ERROR] $*"; }
die()     { error "$*"; return 1; }
pause()   { echo ""; echo -e "${DIM}Press Enter to continue...${RESET}"; read -r || true; }

# ─── Source shared nginx helpers (guarded — script falls back to inline if missing) ─
_NGINX_LIB="$SCRIPT_DIR/lib/nginx_shared_helpers.sh"
if [[ -f "$_NGINX_LIB" ]]; then
    # shellcheck source=lib/nginx_shared_helpers.sh
    source "$_NGINX_LIB"
fi

# ─── Node secret self-heal (guarded) ──────────────────────────────────────────
# Fidelius wallets each carry node_api_secret_path in their grin-wallet.toml. A
# node rebuild (prune ↔ full) MOVES the node dir, so that path goes stale and the
# wallet gets a 403 from the node — surfacing as "Cannot parse response" on
# balance refresh and every send. grin_sync_wallets finds our tomls
# (/opt/grin/fidelius/wallet_*/grin-wallet.toml is within its maxdepth 4), but
# only if the 5-min timer is installed — which is what Step 3 does below.
#
# Scope: this repairs wallets pointed at a LOCAL node only. A Fidelius wallet on
# one of the curated PUBLIC nodes is deliberately skipped — handing it a local
# secret would make grin-wallet send that secret to a third-party host — so for
# those wallets a node rebuild is a no-op anyway.
_SECRETS_LIB="$SCRIPT_DIR/lib/grin_node_secrets.sh"
if [[ -f "$_SECRETS_LIB" ]]; then
    # shellcheck source=lib/grin_node_secrets.sh
    source "$_SECRETS_LIB"
fi

# ─── Private access (WireGuard + DNS-01) ──────────────────────────────────────
# Optional hardening path, menu key V. Moves the wallet off the public internet
# onto a WireGuard address while KEEPING a real Let's Encrypt certificate for the
# same domain — DNS-01 proves control by TXT record, so it needs no inbound
# reachability at all. Shared lib rather than inline because the pool admin panel
# has the same shape of problem; Fidelius is just its first caller.
_WG_LIB="$SCRIPT_DIR/lib/grin_wg_access.sh"
if [[ -f "$_WG_LIB" ]]; then
    # shellcheck source=lib/grin_wg_access.sh
    source "$_WG_LIB"
fi

# ─── Global constants (single deploy serves both networks) ────────────────────
WW_ROOT="/opt/grin/fidelius"
WW_APP_DIR="$WW_ROOT/app"
WW_BIN="$WW_ROOT/grin-wallet"
WW_REGISTRY="$WW_ROOT/wallets_info.json"
WW_CONF_FILE="$WW_ROOT/config.conf"
WW_ENV_FILE="$WW_ROOT/wallet.env"
WW_SRC_DIR="$TOOLKIT_ROOT/web/051_fidelius"
WW_NODE_PORT=7420
WW_SYSTEMD_UNIT="/etc/systemd/system/grin-fidelius.service"
WW_NGINX_CONF="/etc/nginx/sites-available/grin-fidelius"
WW_NGINX_LINK="/etc/nginx/sites-enabled/grin-fidelius"
WW_HTPASSWD="/etc/nginx/grin-fidelius.htpasswd"
# CLAUDE.md convention: script-specific rate-limit conf files carry a script##-
# prefix. Safe to rename now only because Fidelius has never been VPS-deployed —
# renaming a live one would leave the OLD file defining the same zones, and two
# limit_req_zone lines with one name in the http context is a fatal nginx error.
# _WW_RATELIMIT_CONF_OLD is deleted before the new one is written for exactly
# that reason; drop it once no install predates this change.
WW_RATELIMIT_BASENAME="script051-fidelius-ratelimit"
WW_RATELIMIT_CONF="/etc/nginx/conf.d/${WW_RATELIMIT_BASENAME}.conf"
_WW_RATELIMIT_CONF_OLD="/etc/nginx/conf.d/grin-fidelius-ratelimit.conf"
WW_RATELIMIT_ZONE="grin_fidelius"
# Service log lives with every other toolkit daemon log, NOT in /var/log — that
# keeps one directory to back up, to clean and to look in, and lets the unit drop
# write access to /var/log entirely. Rotated by our OWN logrotate config (below),
# not by Script 08's toolkit list: 08 is opt-in (Automatic Disk Cleanup) and
# listing the same path in both files makes logrotate error "duplicate log entry".
WW_LOG_DIR="/opt/grin/logs"
WW_LOG="$WW_LOG_DIR/grin-fidelius.log"
WW_LOGROTATE_CONF="/etc/logrotate.d/grin-fidelius"
# Own jail file + own logpath, so it never collides with Script 02's
# /etc/fail2ban/jail.d/nginx-grin.conf (which globs /var/log/nginx/*error.log).
WW_F2B_JAIL="/etc/fail2ban/jail.d/grin-fidelius.conf"

# ─── Per-instance settings (loaded from WW_CONF_FILE) ─────────────────────────
WW_DOMAIN=""
WW_EMAIL=""
WW_AUTH_USER="grin"

# =============================================================================
# INPUT VALIDATION HELPERS
# =============================================================================
# These guard against typos & metacharacters flowing into nginx config,
# certbot CLI, file paths, and the systemd EnvironmentFile.
# Return 0 if valid, 1 if not (with a warn message).

_ww_validate_domain() {
    # RFC-1123 hostname: letters, digits, dot, hyphen; no leading/trailing dot/hyphen.
    local d="${1:-}"
    if [[ -z "$d" ]]; then
        warn "Domain cannot be empty."; return 1
    fi
    if (( ${#d} > 253 )); then
        warn "Domain too long (max 253 chars)."; return 1
    fi
    if [[ ! "$d" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]]; then
        warn "Invalid domain: '$d'. Use only letters, digits, dot, hyphen."; return 1
    fi
    if [[ "$d" =~ \.\. ]]; then
        warn "Invalid domain: '$d' (consecutive dots)."; return 1
    fi
    return 0
}

_ww_validate_email() {
    local e="${1:-}"
    if [[ -z "$e" ]]; then
        warn "Email cannot be empty."; return 1
    fi
    # Lightweight check: <local>@<domain> with safe chars only.
    if [[ ! "$e" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
        warn "Invalid email: '$e'."; return 1
    fi
    return 0
}

_ww_validate_auth_user() {
    local u="${1:-}"
    if [[ -z "$u" ]]; then
        warn "Username cannot be empty."; return 1
    fi
    if (( ${#u} > 64 )); then
        warn "Username too long (max 64 chars)."; return 1
    fi
    # htpasswd accepts almost anything but we restrict to a safe alnum + ._- set
    # to avoid surprises in shell, env, and logs.
    if [[ ! "$u" =~ ^[A-Za-z0-9._-]+$ ]]; then
        warn "Invalid username: '$u'. Use only letters, digits, dot, underscore, hyphen."; return 1
    fi
    return 0
}

# =============================================================================
# CONFIG HELPERS
# =============================================================================

ww_load_config() {
    WW_DOMAIN=""
    WW_EMAIL=""
    WW_AUTH_USER="grin"
    WW_IDLE_LOCK_MINUTES="60"
    # Empty = listen on every interface (the public default). Set to the
    # WireGuard address by menu V, and persisted here on purpose: without it a
    # later re-run of step 5 would rewrite the vhost with a public listener and
    # silently put the wallet back on the internet.
    WW_BIND_ADDR=""
    if [[ -f "$WW_CONF_FILE" ]]; then
        # shellcheck disable=SC1090
        source "$WW_CONF_FILE" 2>/dev/null || true
    fi
}

ww_save_config() {
    mkdir -p "$WW_ROOT"
    cat > "$WW_CONF_FILE" << CONF
WW_DOMAIN="${WW_DOMAIN:-}"
WW_EMAIL="${WW_EMAIL:-}"
WW_AUTH_USER="${WW_AUTH_USER:-grin}"
WW_IDLE_LOCK_MINUTES="${WW_IDLE_LOCK_MINUTES:-60}"
WW_BIND_ADDR="${WW_BIND_ADDR:-}"
CONF
    chmod 600 "$WW_CONF_FILE"
}

# wallet.env — sourced by the systemd unit's EnvironmentFile=
# Holds WW_PUBLIC_HOST / WW_PUBLIC_ORIGIN so server.js's Host/Origin guard
# accepts traffic coming through the nginx reverse proxy.
ww_save_env() {
    mkdir -p "$WW_ROOT"
    local host="${WW_DOMAIN:-}"
    local origin=""
    [[ -n "$host" ]] && origin="https://$host"
    cat > "$WW_ENV_FILE" << ENV
# Generated by 051_grin_fidelius.sh — do not edit manually
WW_ROOT=$WW_ROOT
GRIN_WEB_PORT=$WW_NODE_PORT
WW_PUBLIC_HOST=$host
WW_PUBLIC_ORIGIN=$origin
# Server-side idle backstop, in minutes (0 disables). The browser UI already
# auto-locks on real mouse/keyboard idle — this only catches the case where the
# tab was CLOSED, which leaves the passphrase in server.js memory with nothing
# left to expire it. Zeroes the passphrase only; listeners keep running so
# inbound receiving survives. Keep it longer than the in-app setting.
# Edit it via menu option 9, NOT here: this file is regenerated from
# config.conf by steps 4, 5 and 9, so a hand-edit here is silently reverted.
WW_IDLE_LOCK_MINUTES=${WW_IDLE_LOCK_MINUTES:-60}
ENV
    chmod 600 "$WW_ENV_FILE"
    # Reload systemd if the unit is already installed — picks up the new env.
    if [[ -f "$WW_SYSTEMD_UNIT" ]] && systemctl is-active --quiet grin-fidelius 2>/dev/null; then
        systemctl restart grin-fidelius 2>/dev/null && info "grin-fidelius restarted to apply env changes." || true
    fi
}

# =============================================================================
# STATUS (menu header)
# =============================================================================

ww_menu_status() {
    ww_load_config
    echo ""

    # 1) Binary
    if [[ -x "$WW_BIN" ]]; then
        local ver; ver=$("$WW_BIN" --version 2>/dev/null | head -1 || echo "?")
        echo -e "  ${BOLD}1 grin-wallet binary${RESET} : ${GREEN}installed${RESET}  ${DIM}($ver)${RESET}"
    else
        echo -e "  ${BOLD}1 grin-wallet binary${RESET} : ${RED}not installed${RESET}  ${DIM}→ step 1${RESET}"
    fi

    # 2) Dependencies
    local deps_ok=1
    for cmd in node nginx certbot htpasswd; do
        command -v "$cmd" &>/dev/null || { deps_ok=0; break; }
    done
    [[ $deps_ok -eq 1 ]] \
        && echo -e "  ${BOLD}2 Dependencies${RESET}       : ${GREEN}OK${RESET}" \
        || echo -e "  ${BOLD}2 Dependencies${RESET}       : ${RED}missing${RESET}  ${DIM}→ step 2${RESET}"

    # 3) App deploy + systemd
    if [[ -f "$WW_APP_DIR/server.js" && -d "$WW_APP_DIR/node_modules" && -f "$WW_SYSTEMD_UNIT" ]]; then
        if systemctl is-active --quiet grin-fidelius 2>/dev/null; then
            echo -e "  ${BOLD}3 App + systemd${RESET}      : ${GREEN}deployed, running${RESET}  ${DIM}(127.0.0.1:$WW_NODE_PORT)${RESET}"
        else
            echo -e "  ${BOLD}3 App + systemd${RESET}      : ${YELLOW}deployed, stopped${RESET}  ${DIM}(systemctl start grin-fidelius)${RESET}"
        fi
    elif [[ -f "$WW_APP_DIR/server.js" ]]; then
        echo -e "  ${BOLD}3 App + systemd${RESET}      : ${YELLOW}files deployed, no systemd${RESET}  ${DIM}→ step 3${RESET}"
    else
        echo -e "  ${BOLD}3 App + systemd${RESET}      : ${DIM}not deployed${RESET}  ${DIM}→ step 3${RESET}"
    fi

    # 4) nginx
    [[ -f "$WW_NGINX_CONF" ]] \
        && echo -e "  ${BOLD}4 nginx vhost${RESET}        : ${GREEN}configured${RESET}  ${DIM}($WW_NGINX_CONF)${RESET}" \
        || echo -e "  ${BOLD}4 nginx vhost${RESET}        : ${DIM}not configured${RESET}  ${DIM}→ step 4${RESET}"

    # 5) SSL
    if [[ -n "$WW_DOMAIN" && -f "/etc/letsencrypt/live/$WW_DOMAIN/fullchain.pem" ]]; then
        echo -e "  ${BOLD}5 SSL${RESET}                : ${GREEN}Let's Encrypt${RESET}  ${DIM}($WW_DOMAIN)${RESET}"
    elif [[ -n "$WW_DOMAIN" && -f "/etc/ssl/cloudflare-origin/$WW_DOMAIN.pem" ]]; then
        echo -e "  ${BOLD}5 SSL${RESET}                : ${GREEN}Cloudflare Origin${RESET}  ${DIM}($WW_DOMAIN)${RESET}"
    else
        echo -e "  ${BOLD}5 SSL${RESET}                : ${DIM}not configured${RESET}  ${DIM}→ step 5${RESET}"
    fi

    # 6) Basic Auth
    [[ -f "$WW_HTPASSWD" ]] \
        && echo -e "  ${BOLD}6 Basic Auth${RESET}         : ${GREEN}configured${RESET}  ${DIM}(user: ${WW_AUTH_USER:-grin})${RESET}" \
        || echo -e "  ${BOLD}6 Basic Auth${RESET}         : ${DIM}not configured${RESET}  ${DIM}→ step 6${RESET}"

    # V) Private access — only shown once WireGuard exists, so the normal
    #    public setup keeps a five-line status screen.
    if declare -F gwa_installed &>/dev/null && gwa_installed; then
        echo -e "  ${BOLD}V Private access${RESET}     : ${GREEN}$(gwa_status_lines)${RESET}"
    fi

    # Live URL
    if [[ -L "$WW_NGINX_LINK" ]]; then
        if [[ -n "${WW_BIND_ADDR:-}" ]]; then
            echo -e "  ${BOLD}Web UI${RESET}               : ${GREEN}LIVE${RESET} ${YELLOW}(VPN only)${RESET}  ${DIM}→ https://${WW_DOMAIN:-<domain>}${RESET}"
        else
            echo -e "  ${BOLD}Web UI${RESET}               : ${GREEN}LIVE${RESET}  ${DIM}→ https://${WW_DOMAIN:-<domain>}${RESET}"
        fi
    else
        echo -e "  ${BOLD}Web UI${RESET}               : ${DIM}not live${RESET}"
    fi

    # Registered wallets count
    local count=0
    if [[ -f "$WW_REGISTRY" ]] && command -v jq &>/dev/null; then
        count=$(jq '.wallets | length' "$WW_REGISTRY" 2>/dev/null || echo 0)
    fi
    echo -e "  ${BOLD}Wallets registered${RESET}   : ${DIM}$count${RESET}"
    echo ""
}

# =============================================================================
# STEP 1 — Install grin-wallet binary
# =============================================================================

ww_install_binary() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 051) Web Wallet — 1) Install grin-wallet Binary${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Target  : ${DIM}$WW_BIN${RESET}"
    echo -e "  Source  : ${DIM}$_WW_GITHUB_API${RESET}"
    echo ""

    local needs_download=1
    if [[ -x "$WW_BIN" ]]; then
        local ver; ver=$("$WW_BIN" --version 2>/dev/null | head -1 || echo "?")
        success "Binary already installed  ${DIM}($ver)${RESET}"
        echo -ne "  Re-download latest? [y/N/0 cancel]: "
        local redown; read -r redown || true
        [[ "$redown" == "0" ]] && return
        [[ "${redown,,}" == "y" ]] || needs_download=0
    fi

    if [[ $needs_download -eq 1 ]]; then
        if ! command -v jq &>/dev/null; then
            warn "jq not installed — run step 2 first (or 'apt install jq')."
            pause; return
        fi
        info "Fetching pinned release $_WW_PIN_TAG from GitHub..."
        local release_json
        release_json=$(curl -fsSL --max-time 30 "$_WW_GITHUB_API") \
            || { error "Failed to reach GitHub API."; pause; return; }

        # Tell the operator when upstream has moved on, without moving for them.
        local latest_tag=""
        latest_tag=$(curl -fsSL --max-time 15 "$_WW_GITHUB_API_LATEST" 2>/dev/null \
                     | jq -r '.tag_name // empty' 2>/dev/null || true)
        if [[ -n "$latest_tag" && "$latest_tag" != "$_WW_PIN_TAG" ]]; then
            warn "Upstream latest is $latest_tag; installing the pinned $_WW_PIN_TAG."
            warn "Fidelius feeds passphrases on stdin — verify a newer grin-wallet still"
            warn "uses rpassword 4.x before moving the pin, or every unlock will break."
        fi

        local version download_url
        version=$(echo "$release_json" | jq -r '.tag_name')
        download_url=$(echo "$release_json" \
            | jq -r '.assets[] | select(.name | test("linux-x86_64\\.tar\\.gz$"; "i")) | .browser_download_url' \
            | head -1)

        if [[ -z "$download_url" || "$download_url" == "null" ]]; then
            error "No linux-x86_64 asset found for $version."
            pause; return
        fi

        mkdir -p "$WW_ROOT"
        local tmp_tar="/tmp/grin_fidelius_$$.tar.gz"
        local tmp_dir="/tmp/grin_fidelius_extract_$$"
        mkdir -p "$tmp_dir"

        info "Version : $version"
        info "Target  : $WW_BIN"
        echo ""
        wget -c --progress=bar:force -O "$tmp_tar" "$download_url" \
            || { error "Download failed."; rm -rf "$tmp_tar" "$tmp_dir"; pause; return; }

        tar -xzf "$tmp_tar" -C "$tmp_dir" \
            || { error "Extraction failed."; rm -rf "$tmp_tar" "$tmp_dir"; pause; return; }
        rm -f "$tmp_tar"

        local bin_src
        bin_src=$(find "$tmp_dir" -type f -name "grin-wallet" | head -1)
        if [[ -z "$bin_src" ]]; then
            error "grin-wallet binary not found in archive."
            rm -rf "$tmp_dir"; pause; return
        fi

        install -m 755 "$bin_src" "$WW_BIN"
        rm -rf "$tmp_dir"
        success "grin-wallet $version installed → $WW_BIN"
    fi

    echo ""
    pause
}

# =============================================================================
# STEP 2 — Install dependencies (nodejs, nginx, certbot, htpasswd, tor, qrencode, jq)
# =============================================================================

ww_install_deps() {
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet — 2) Install Dependencies ──${RESET}\n"
    echo -e "  ${DIM}Required: nodejs >= 24, nginx, certbot, htpasswd${RESET}"
    echo -e "  ${DIM}Optional: tor (for Tor sends), qrencode (QR codes), jq (status)${RESET}"
    echo ""

    local all_ok=1
    for pkg_cmd in "node:nodejs" "nginx:nginx" "certbot:certbot" "htpasswd:apache2-utils" "tor:tor" "qrencode:qrencode" "jq:jq"; do
        local cmd="${pkg_cmd%%:*}"
        command -v "$cmd" &>/dev/null && success "$cmd present" || { warn "$cmd missing"; all_ok=0; }
    done

    if [[ $all_ok -eq 1 ]]; then
        echo ""
        success "All dependencies are present."
        pause; return
    fi

    echo ""
    echo -ne "${BOLD}Install missing packages now? (requires root) [Y/n/0]: ${RESET}"
    read -r confirm || true
    [[ "$confirm" == "0" ]] && return
    [[ "${confirm,,}" == "n" ]] && return

    # Evict apache2 before installing/starting nginx — apache2 occupies port 80
    if ! command -v nginx &>/dev/null; then
        if systemctl is-active --quiet apache2 2>/dev/null; then
            warn "apache2 is running and occupies port 80 — nginx cannot start."
            echo -ne "  Stop and disable apache2 now? [Y/n]: "
            local _yn; read -r _yn || true
            if [[ "${_yn,,}" != "n" ]]; then
                systemctl stop    apache2 2>/dev/null || true
                systemctl disable apache2 2>/dev/null || true
                success "apache2 stopped and disabled."
            else
                warn "Skipping — nginx may fail to bind port 80/443."
            fi
        elif systemctl is-enabled --quiet apache2 2>/dev/null; then
            warn "apache2 enabled at boot (not running) — disabling to avoid port conflict on reboot."
            systemctl disable apache2 2>/dev/null || true
            success "apache2 boot-start disabled."
        fi
    fi

    info "Updating package lists..."
    apt-get update -qq || warn "apt-get update failed — see above. Continuing anyway."

    # nodejs: ensure 24+ (toolkit standard — node:sqlite-based products need >= 24,
    # and we keep every toolkit product on the same floor). Upgrade via NodeSource
    # when missing or older; a node >= 24 (e.g. 26 from a co-installed product) is
    # left untouched so we never downgrade.
    local node_major=0
    command -v node &>/dev/null && node_major=$(node --version 2>/dev/null | sed 's/^v//; s/\..*//')
    [[ "$node_major" =~ ^[0-9]+$ ]] || node_major=0
    if [[ "$node_major" -lt 24 ]]; then
        if [[ "$node_major" -gt 0 ]]; then
            warn "Node.js v${node_major} found — toolkit standard is v24+. Upgrading via NodeSource 24.x..."
        else
            info "Installing Node.js 24.x via NodeSource..."
        fi
        apt-get remove -y -qq nodejs npm 2>/dev/null || true
        if curl -fsSL https://deb.nodesource.com/setup_24.x | bash -; then
            apt-get install -y -qq nodejs || error "NodeSource nodejs install failed — see above."
        else
            error "NodeSource setup script failed — install nodejs 24+ manually and re-run."
        fi
    fi

    for pkg_cmd in "nginx:nginx" "certbot:certbot" "htpasswd:apache2-utils" "tor:tor" "qrencode:qrencode" "jq:jq"; do
        local cmd="${pkg_cmd%%:*}" pkg="${pkg_cmd##*:}"
        if ! command -v "$cmd" &>/dev/null; then
            info "Installing $pkg..."
            if [[ "$cmd" == "certbot" ]]; then
                apt-get install -y -qq certbot python3-certbot-nginx \
                    || warn "Failed to install certbot — see above."
            else
                apt-get install -y -qq "$pkg" \
                    || warn "Failed to install $pkg — see above."
            fi
        fi
    done

    # Enable tor at boot if it was just installed (used for Tor sends from wallet)
    if command -v tor &>/dev/null; then
        systemctl enable --now tor 2>/dev/null \
            || systemctl enable --now tor@default 2>/dev/null || true
    fi

    echo ""
    info "Verification:"
    for pkg_cmd in "node:nodejs" "nginx:nginx" "certbot:certbot" "htpasswd:apache2-utils" "tor:tor" "qrencode:qrencode" "jq:jq"; do
        local cmd="${pkg_cmd%%:*}"
        command -v "$cmd" &>/dev/null && success "$cmd  OK" || warn "$cmd  MISSING — install manually"
    done

    # `script` (util-linux) is what gives "Recover from seed" a pty. grin-wallet
    # asks for a recovery phrase through linefeed, which opens /dev/tty rather
    # than reading stdin, so without a pty that flow cannot run at all. It ships
    # in an essential package on every supported distro (bsdutils on Debian and
    # Ubuntu, util-linux on Rocky and Alma), so this is a check, not an install —
    # if it is genuinely absent, something is unusual about the host.
    if command -v script &>/dev/null; then
        success "script  OK  (needed for wallet recovery)"
    else
        warn "script  MISSING — 'Recover from seed' will not work."
        warn "  Debian/Ubuntu: apt install bsdutils   ·   Rocky/Alma: dnf install util-linux"
    fi
    log "[ww_install_deps]"
    pause
}

# =============================================================================
# STEP 3 — Deploy app + write systemd unit
# =============================================================================

ww_deploy_app() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet — 3) Deploy App + systemd ──${RESET}\n"

    if [[ ! -d "$WW_SRC_DIR" || ! -f "$WW_SRC_DIR/server.js" || ! -f "$WW_SRC_DIR/package.json" ]]; then
        die "Source not found: $WW_SRC_DIR"
        warn "Ensure $WW_SRC_DIR/server.js + package.json + client/ exist."
        pause; return
    fi
    if ! command -v node &>/dev/null; then
        die "node not installed — run step 2 first."; pause; return
    fi
    if ! command -v npm &>/dev/null; then
        die "npm not installed — run step 2 first (NodeSource install bundles npm)."; pause; return
    fi

    echo -e "  ${DIM}Will:${RESET}"
    echo -e "    1. Copy $WW_SRC_DIR → $WW_APP_DIR"
    echo -e "    2. Run npm install --omit=dev (in $WW_APP_DIR)"
    echo -e "    3. Write wallet.env (port, public host)"
    echo -e "    4. Write systemd unit $WW_SYSTEMD_UNIT"
    echo -e "    5. systemctl enable --now grin-fidelius"
    echo -e "    6. Install the node-secret self-heal timer (grin-secret-sync)"
    echo ""
    echo -ne "${BOLD}Proceed? [Y/n/0]: ${RESET}"
    read -r confirm || true
    [[ "$confirm" == "0" ]] && return
    [[ "${confirm,,}" == "n" ]] && info "Cancelled." && return

    # ── 1. Copy source ────────────────────────────────────────────────────────
    info "Copying source files..."
    mkdir -p "$WW_APP_DIR"
    # Glob every top-level .js rather than naming server.js — the app is no
    # longer a single file (transporter.js), and an enumerated list silently
    # ships a broken deploy: the missing require only fails at service start,
    # on the VPS, as a bare MODULE_NOT_FOUND. The glob still excludes client/
    # and any node_modules, which are handled separately.
    cp -r "$WW_SRC_DIR"/*.js "$WW_SRC_DIR/package.json" "$WW_SRC_DIR/client" "$WW_APP_DIR/"
    success "Source copied → $WW_APP_DIR"

    # ── 2. npm install ────────────────────────────────────────────────────────
    info "Running npm install --omit=dev ..."
    if (cd "$WW_APP_DIR" && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -20); then
        success "npm install completed."
    else
        warn "npm install reported errors — check above. Continuing anyway."
    fi

    # ── 3. Write wallet.env (uses current domain if set; empty otherwise) ────
    ww_save_env
    info "wallet.env written → $WW_ENV_FILE"

    # ── 4. Write systemd unit ─────────────────────────────────────────────────
    # systemd's append: creates the FILE but never the directory — a missing
    # /opt/grin/logs makes the unit fail to start with a bare exit 238.
    mkdir -p "$WW_LOG_DIR"
    info "Writing systemd unit → $WW_SYSTEMD_UNIT ..."
    cat > "$WW_SYSTEMD_UNIT" << UNIT
[Unit]
Description=Grin Fidelius web wallet (toolkit 051 — Node.js)
Documentation=https://github.com/Noobvie/Grin-Node-Toolkit
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=$WW_APP_DIR
EnvironmentFile=$WW_ENV_FILE
ExecStart=/usr/bin/env node $WW_APP_DIR/server.js
Restart=on-failure
RestartSec=5s
StandardOutput=append:$WW_LOG
StandardError=append:$WW_LOG

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$WW_ROOT $WW_LOG_DIR
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=true
RestrictSUIDSGID=true
RestrictRealtime=true
# NOTE: do NOT add MemoryDenyWriteExecute=true here — V8's JIT needs W+X
# memory pages. The directive prevents Node.js from starting (or silently
# falls back to interpreter, ~10x slower).

[Install]
WantedBy=multi-user.target
UNIT
    chmod 644 "$WW_SYSTEMD_UNIT"
    success "systemd unit written."

    # ── 4b. Log rotation ──────────────────────────────────────────────────────
    # copytruncate is mandatory here, not a preference: StandardOutput=append:
    # means systemd holds an open fd on the file, so a rename-and-create rotation
    # would leave the daemon writing to the rotated inode forever and the fresh
    # log permanently empty. The pool solves the same problem with a USR2 reopen
    # signal; server.js has no such handler, so truncate-in-place it is.
    if [[ -d /etc/logrotate.d ]]; then
        cat > "$WW_LOGROTATE_CONF" << LROT
$WW_LOG {
    weekly
    rotate 4
    size 10M
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
}
LROT
        chmod 644 "$WW_LOGROTATE_CONF"
        success "Log rotation configured → $WW_LOGROTATE_CONF"
    else
        warn "logrotate not present — $WW_LOG will grow unbounded."
    fi

    # ── 5. Enable + start ─────────────────────────────────────────────────────
    info "Reloading systemd + starting grin-fidelius ..."
    systemctl daemon-reload
    if systemctl enable --now grin-fidelius 2>&1 | tail -5; then
        sleep 2
        if systemctl is-active --quiet grin-fidelius; then
            success "grin-fidelius is RUNNING on 127.0.0.1:$WW_NODE_PORT"
        else
            warn "grin-fidelius enabled but not active — a Node crash lands in $WW_LOG (tail -n 50), a unit-level failure in: journalctl -u grin-fidelius -n 50"
        fi
    else
        warn "systemctl enable/start reported issues — check: journalctl -u grin-fidelius (and $WW_LOG)"
    fi

    # ── 6. Node secret self-heal ──────────────────────────────────────────────
    # Installs /opt/grin/lib/grin_node_secrets.sh + the grin-secret-sync CLI and
    # its 5-min timer. Without this a node rebuild silently breaks every Fidelius
    # wallet's node link (403 → "Cannot parse response" on refresh and send) and
    # nothing repairs it. Idempotent, and a no-op for products that aren't here.
    if declare -F grin_install_secret_sync >/dev/null 2>&1; then
        info "Installing node-secret self-heal timer ..."
        grin_install_secret_sync || warn "Could not install grin-secret-sync timer (non-fatal)."
    else
        warn "lib/grin_node_secrets.sh not found — wallets will NOT self-heal after a node rebuild."
    fi

    echo ""
    echo -e "  ${BOLD}Status${RESET}    : systemctl status grin-fidelius"
    # App output goes to the file, NOT the journal — StandardOutput=append:
    # redirects it away, so journalctl only ever shows systemd's own start/stop
    # and crash lines. Both are worth knowing about; print both.
    echo -e "  ${BOLD}App log${RESET}   : tail -f $WW_LOG"
    echo -e "  ${BOLD}Unit log${RESET}  : journalctl -u grin-fidelius -f  ${DIM}(start/stop/crash only)${RESET}"
    echo -e "  ${BOLD}Local${RESET}     : curl -i http://127.0.0.1:$WW_NODE_PORT/api/wallets"
    echo ""
    log "[ww_deploy_app] deployed=$WW_APP_DIR active=$(systemctl is-active grin-fidelius 2>/dev/null || echo unknown)"
    pause
}

# =============================================================================
# STEP 4 — Configure nginx (reverse proxy to 127.0.0.1:7420)
# =============================================================================

ww_configure_nginx() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet — 4) Configure nginx ──${RESET}\n"

    if ! command -v nginx &>/dev/null; then
        die "nginx not installed — run step 2 first."; pause; return
    fi
    if [[ ! -f "$WW_APP_DIR/server.js" ]]; then
        die "App not deployed yet — run step 3 first."; pause; return
    fi

    # ── Private-mode guard ───────────────────────────────────────────────────
    # This step rewrites the vhost as HTTP-only, which throws away the whole
    # HTTPS server block. Under menu V that is not just "redo step 5": until
    # HTTPS is rebuilt the wallet is unreachable, and the status screen would
    # still read PRIVATE because the bind lives in config.conf, not the vhost.
    # The bind IS carried through below, so the two can't disagree — but the
    # operator has to know HTTPS is going away first.
    if [[ -n "${WW_BIND_ADDR:-}" ]]; then
        warn "The wallet is currently PRIVATE (bound to $WW_BIND_ADDR)."
        warn "This step rewrites the vhost as HTTP-only and removes HTTPS until"
        warn "you re-issue it. In private mode that means menu V option 4"
        warn "(DNS-01) — step 5 uses HTTP-01, which needs the public port 80"
        warn "this bind removes."
        echo ""
        echo -ne "${BOLD}Continue anyway? [y/N]: ${RESET}"
        local _pv; read -r _pv || true
        [[ "${_pv,,}" == "y" ]] || { info "Cancelled — vhost left untouched."; pause; return; }
        echo ""
    fi

    while true; do
        echo -ne "Domain (e.g. wallet.mynode.example.com) [${WW_DOMAIN:-}]: "
        read -r input || true
        [[ -n "$input" ]] && WW_DOMAIN="$input"
        _ww_validate_domain "$WW_DOMAIN" || { WW_DOMAIN=""; continue; }
        break
    done

    echo ""
    info "Domain    : $WW_DOMAIN"
    info "Reverse proxy → http://127.0.0.1:$WW_NODE_PORT"
    echo ""
    echo -ne "${BOLD}Write HTTP vhost (step 5 adds HTTPS)? [Y/n/0]: ${RESET}"
    read -r confirm || true
    [[ "$confirm" == "0" ]] && return
    [[ "${confirm,,}" == "n" ]] && info "Cancelled." && return

    # ── Rate-limit zones ──────────────────────────────────────────────────────
    # Remove the pre-rename file FIRST. The helper skips writing if any of these
    # zones is already defined anywhere under /etc/nginx, so leaving the old file
    # would silently pin the config to the old path forever.
    if [[ -f "$_WW_RATELIMIT_CONF_OLD" ]]; then
        rm -f "$_WW_RATELIMIT_CONF_OLD"
        info "Removed superseded $_WW_RATELIMIT_CONF_OLD (renamed to $WW_RATELIMIT_BASENAME.conf)."
    fi
    if declare -F nginx_ensure_rate_limit_zones &>/dev/null; then
        nginx_ensure_rate_limit_zones "$WW_RATELIMIT_BASENAME" \
            "${WW_RATELIMIT_ZONE}_send:3r/m"   \
            "${WW_RATELIMIT_ZONE}_api:10r/m"   \
            "${WW_RATELIMIT_ZONE}_http:20r/m"
    else
        mkdir -p /etc/nginx/conf.d
        cat > "$WW_RATELIMIT_CONF" << RATELIMIT
# Grin Web Wallet rate limits
limit_req_zone \$binary_remote_addr zone=${WW_RATELIMIT_ZONE}_send:10m  rate=3r/m;
limit_req_zone \$binary_remote_addr zone=${WW_RATELIMIT_ZONE}_api:10m   rate=10r/m;
limit_req_zone \$binary_remote_addr zone=${WW_RATELIMIT_ZONE}_http:10m  rate=20r/m;
RATELIMIT
    fi

    # HTTP-only vhost — certbot --nginx (step 5) adds HTTPS automatically.
    # Carries WW_BIND_ADDR so a re-run under menu V cannot silently drop the
    # wallet back onto a public listener; see the private-mode guard above.
    local _http_listen="listen 80;
    listen [::]:80;"
    if [[ -n "${WW_BIND_ADDR:-}" ]]; then
        _http_listen="listen ${WW_BIND_ADDR}:80;"   # no [::] — the WG subnet is IPv4-only
    fi
    info "Writing HTTP vhost → $WW_NGINX_CONF ..."
    cat > "$WW_NGINX_CONF" << NGINX_HTTP
# Grin Web Wallet — generated by 051_grin_fidelius.sh (HTTP only — step 5 adds HTTPS)
server {
    $_http_listen
    server_name $WW_DOMAIN;
    location / { return 301 https://\$host\$request_uri; }
}
NGINX_HTTP

    ln -sf "$WW_NGINX_CONF" "$WW_NGINX_LINK" 2>/dev/null || true
    nginx -t && systemctl reload nginx && success "nginx vhost configured and reloaded." \
        || { warn "nginx config test failed — check $WW_NGINX_CONF"; pause; return; }

    # Refresh wallet.env so Node accepts requests for the new public host
    ww_save_config
    ww_save_env
    log "[ww_configure_nginx] domain=$WW_DOMAIN"
    pause
}

# =============================================================================
# STEP 5 — Setup SSL (Let's Encrypt OR Cloudflare Origin Cert)
# =============================================================================

_ww_write_https_vhost() {
    # $1 = kind label (for header comment)
    # $2 = cert path
    # $3 = key path
    # $4 = extra ssl block lines (e.g. include /etc/letsencrypt/options-ssl-nginx.conf;)
    local kind="$1" cert="$2" key="$3" extra="${4:-}"

    # ── Bind address ─────────────────────────────────────────────────────────
    # WW_BIND_ADDR empty  → every interface (public). The normal setup.
    # WW_BIND_ADDR set    → that address only (the WireGuard IP, menu V).
    #
    # Binding beats an `allow/deny` ACL here. An ACL still lets a stranger
    # complete the TLS handshake and reach nginx's HTTP layer before being
    # refused — so any pre-auth bug is still reachable, and the wallet's
    # existence is still confirmable. An address nginx never listens on has no
    # pre-auth surface to have a bug in.
    local bind_pfx="" v6_ok=1 kind_note=""
    if [[ -n "${WW_BIND_ADDR:-}" ]]; then
        bind_pfx="${WW_BIND_ADDR}:"
        v6_ok=0     # the WG subnet is IPv4-only; a [::] listener would be public
        kind_note=" — PRIVATE, bound to ${WW_BIND_ADDR}"
    fi

    # `listen ... ssl http2` is deprecated from nginx 1.25.1 (warns on every
    # reload) and `http2 on;` does not exist before it (hard config error). So
    # pick the form this host's nginx actually understands rather than emitting
    # one that is wrong on half the fleet.
    local listen_443="listen ${bind_pfx}443 ssl http2;"
    (( v6_ok )) && listen_443+="
    listen [::]:443 ssl http2;"
    local nginx_ver
    nginx_ver=$(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
    if [[ -n "$nginx_ver" ]]; then
        local _maj _min _pat
        IFS=. read -r _maj _min _pat <<< "$nginx_ver"
        if (( _maj > 1 || (_maj == 1 && _min > 25) || (_maj == 1 && _min == 25 && _pat >= 1) )); then
            listen_443="listen ${bind_pfx}443 ssl;"
            (( v6_ok )) && listen_443+="
    listen [::]:443 ssl;"
            listen_443+="
    http2 on;"
        fi
    fi

    local listen_80="listen ${bind_pfx}80;"
    (( v6_ok )) && listen_80+="
    listen [::]:80;"

    cat > "$WW_NGINX_CONF" << NGINX_HTTPS
# Fidelius Grin wallet — generated by 051_grin_fidelius.sh ($kind$kind_note)
server {
    $listen_80
    server_name $WW_DOMAIN;
    location / { return 301 https://\$host\$request_uri; }
}

server {
    $listen_443
    server_name $WW_DOMAIN;

    ssl_certificate     $cert;
    ssl_certificate_key $key;
$extra

    server_tokens off;
    client_max_body_size 1m;

    auth_basic           "Grin Wallet";
    auth_basic_user_file $WW_HTPASSWD;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options    "nosniff"     always;
    add_header X-Frame-Options           "DENY"        always;
    add_header Referrer-Policy           "no-referrer" always;
    # script-src is 'self' ONLY — no 'unsafe-inline'. On a wallet UI that keyword is
    # what would turn any HTML-injection bug into seed theft, so the client has no
    # inline <script> and no on*= attributes left: the theme bootstrap lives in
    # client/theme-boot.js and the slatepack copy buttons use wireCopyButton().
    # Do NOT re-add it — check client/ for inline handlers instead.
    # style-src keeps 'unsafe-inline' (the UI uses style="" attributes); a CSS
    # injection cannot execute script, so the risk is not comparable.
    # No fonts.googleapis / fonts.gstatic allowance: the client no longer loads a
    # webfont CDN (it leaked "operator opened their wallet" to a third party on
    # every load), so this policy is now entirely first-party. If you re-add a
    # CDN font you must widen style-src AND font-src again — don't, self-host it.
    add_header Content-Security-Policy   "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self';" always;
    add_header Permissions-Policy        "geolocation=(), microphone=(), camera=()" always;
    add_header X-XSS-Protection          "0" always;

    access_log /var/log/nginx/grin-fidelius-access.log;
    error_log  /var/log/nginx/grin-fidelius-error.log;

    # ── Reverse proxy to Node ─────────────────────────────────────────────────
    # Wallet send endpoint — tight rate limit (also enforced server-side).
    location ~ ^/api/wallet/[^/]+/send$ {
        limit_req zone=${WW_RATELIMIT_ZONE}_send burst=2 nodelay;
        proxy_pass         http://127.0.0.1:$WW_NODE_PORT;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$http_host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 180s;
        proxy_send_timeout 180s;
    }

    # All other API endpoints
    location /api/ {
        limit_req zone=${WW_RATELIMIT_ZONE}_api burst=5 nodelay;
        proxy_pass         http://127.0.0.1:$WW_NODE_PORT;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$http_host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
        # SSE endpoints (/api/setup/nodes, /api/setup/install-binary) need buffering off
        proxy_buffering off;
        proxy_cache off;
    }

    # Static client + everything else
    location / {
        limit_req zone=${WW_RATELIMIT_ZONE}_http burst=10 nodelay;
        proxy_pass         http://127.0.0.1:$WW_NODE_PORT;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$http_host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
    }

    # Hide dotfiles, editor backups
    location ~ /\.        { deny all; }
    location ~ ~\$        { deny all; }
}
NGINX_HTTPS
}

ww_setup_ssl() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet — 5) Setup SSL ──${RESET}\n"

    if ! command -v certbot &>/dev/null; then
        die "certbot not installed — run step 2 first."; pause; return
    fi
    if [[ -z "$WW_DOMAIN" ]]; then
        die "Domain not configured — run step 4 first."; pause; return
    fi
    if [[ ! -f "$WW_NGINX_CONF" ]]; then
        die "nginx vhost not configured — run step 4 first."; pause; return
    fi

    # ── Gate: refuse to expose the wallet on HTTPS without Basic Auth ─────────
    # Without htpasswd, nginx would either 500 every request (file referenced
    # but missing) OR — worse, if the directive were removed — leave the wallet
    # UI wide open on the public domain.
    if [[ ! -f "$WW_HTPASSWD" ]]; then
        warn "Basic Auth (step 6) is required BEFORE enabling SSL."
        warn "Without it the wallet UI would be exposed on $WW_DOMAIN to anyone."
        echo ""
        echo -ne "  Run step 6 (Basic Auth) now? [Y/n/0]: "
        read -r _gate; _gate="${_gate:-y}"
        [[ "$_gate" == "0" || "${_gate,,}" == "n" ]] && { info "SSL setup cancelled."; pause; return; }
        ww_setup_auth || true
        if [[ ! -f "$WW_HTPASSWD" ]]; then
            die "Basic Auth setup did not complete — refusing to enable SSL."
            pause; return
        fi
    fi

    echo -e "  ${BOLD}SSL Certificate method:${RESET}"
    echo -e "  ${GREEN}1${RESET}) Let's Encrypt  ${DIM}(Cloudflare DNS must be 'DNS only' / grey cloud)${RESET}"
    echo -e "  ${GREEN}2${RESET}) Cloudflare Origin Certificate  ${DIM}(domain can stay Proxied / orange cloud)${RESET}"
    echo -ne "  Choice [1/2/0 to cancel]: "
    local ssl_choice
    read -r ssl_choice || true
    [[ "$ssl_choice" == "0" ]] && return
    [[ "$ssl_choice" != "2" ]] && ssl_choice="1"
    echo ""

    if [[ "$ssl_choice" == "1" ]]; then
        # ── Let's Encrypt / certbot ───────────────────────────────────────────
        while true; do
            echo -ne "Let's Encrypt email [${WW_EMAIL:-}]: "
            read -r input || true
            [[ -n "$input" ]] && WW_EMAIL="$input"
            _ww_validate_email "$WW_EMAIL" || { WW_EMAIL=""; continue; }
            break
        done

        echo -ne "  Press Enter to request certificate for $WW_DOMAIN, or 0 to cancel: "
        read -r _confirm || true
        [[ "$_confirm" == "0" ]] && return

        if ! certbot certonly --nginx -d "$WW_DOMAIN" --non-interactive --agree-tos -m "$WW_EMAIL"; then
            warn "certbot failed — ensure DNS points to this server and port 80 is open."
            warn "Using Cloudflare? Switch DNS from 'Proxied' to 'DNS only' (grey cloud),"
            warn "then re-run this step. After cert is issued you can switch back to Proxied."
            warn "Or choose option 2) Cloudflare Origin Certificate."
            pause; return
        fi
        success "SSL certificate issued for $WW_DOMAIN"

        # Includes are existence-guarded: certbot writes options-ssl-nginx.conf
        # and ssl-dhparams.pem from its NGINX plugin, and a DNS-01 issue never
        # loads that plugin. An include of a missing file fails `nginx -t`.
        _ww_write_https_vhost "Let's Encrypt" \
            "/etc/letsencrypt/live/$WW_DOMAIN/fullchain.pem" \
            "/etc/letsencrypt/live/$WW_DOMAIN/privkey.pem" \
            "$(_ww_le_ssl_extra)"

    else
        # ── Cloudflare Origin Certificate ─────────────────────────────────────
        echo -e "  ${BOLD}Cloudflare Origin Certificate${RESET}  ${DIM}(Proxied stays on — no certbot needed)${RESET}"
        echo ""
        echo -e "  ${YELLOW}Steps in Cloudflare Dashboard:${RESET}"
        echo -e "    1. Your domain → SSL/TLS → Origin Server → Create Certificate"
        echo -e "    2. Leave defaults (RSA, 15 years) → click Create"
        echo -e "    3. Copy the ${BOLD}Origin Certificate${RESET} and ${BOLD}Private Key${RESET} below"
        echo ""
        echo -ne "  Ready to paste? Press Enter to continue, 0 to cancel: "
        read -r _cf_ok || true
        [[ "$_cf_ok" == "0" ]] && return

        echo ""
        echo -e "  ${BOLD}Paste Origin Certificate${RESET} (-----BEGIN CERTIFICATE----- ... -----END CERTIFICATE-----):"
        local cf_cert="" cf_line
        while IFS= read -r cf_line; do
            cf_cert+="$cf_line"$'\n'
            [[ "$cf_line" == *"-----END"* ]] && break
        done
        if [[ "$cf_cert" != *"-----BEGIN"* ]]; then
            warn "Invalid certificate — no PEM header found."; pause; return
        fi

        echo ""
        echo -e "  ${BOLD}Paste Private Key${RESET} (-----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----):"
        local cf_key="" cf_key_line
        while IFS= read -r cf_key_line; do
            cf_key+="$cf_key_line"$'\n'
            [[ "$cf_key_line" == *"-----END"* ]] && break
        done
        if [[ "$cf_key" != *"-----BEGIN"* ]]; then
            warn "Invalid private key — no PEM header found."; pause; return
        fi

        local cf_dir="/etc/ssl/cloudflare-origin"
        mkdir -p "$cf_dir"
        printf '%s' "$cf_cert" > "$cf_dir/$WW_DOMAIN.pem"
        printf '%s' "$cf_key"  > "$cf_dir/$WW_DOMAIN.key"
        chmod 644 "$cf_dir/$WW_DOMAIN.pem"
        chmod 600 "$cf_dir/$WW_DOMAIN.key"
        success "Cloudflare Origin Certificate saved → $cf_dir/$WW_DOMAIN.pem"

        _ww_write_https_vhost "Cloudflare Origin Cert" \
            "$cf_dir/$WW_DOMAIN.pem" \
            "$cf_dir/$WW_DOMAIN.key" \
            "$(_ww_cf_ssl_extra)"
    fi

    ln -sf "$WW_NGINX_CONF" "$WW_NGINX_LINK" 2>/dev/null || true

    if nginx -t 2>&1 | tail -5 && systemctl reload nginx; then
        success "nginx HTTPS config loaded."
    else
        warn "nginx config test failed — check $WW_NGINX_CONF"; pause; return
    fi

    ww_save_config
    ww_save_env       # writes WW_PUBLIC_ORIGIN so Node accepts the public domain
    log "[ww_setup_ssl] domain=$WW_DOMAIN ssl=$ssl_choice"
    pause
}

# =============================================================================
# STEP 6 — Setup Basic Auth
# =============================================================================

ww_setup_auth() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet — 6) Setup Basic Auth ──${RESET}\n"

    if ! command -v htpasswd &>/dev/null; then
        die "htpasswd not installed — run step 2 first."; pause; return
    fi

    echo -e "  ${DIM}Basic Auth is layer 1 — protects the wallet UI with a username + password.${RESET}"
    echo -e "  ${DIM}Layer 2 is the per-wallet passphrase managed by the Node app.${RESET}"
    echo ""
    while true; do
        echo -ne "Auth username [${WW_AUTH_USER:-grin}]: "
        read -r input || true
        [[ -n "$input" ]] && WW_AUTH_USER="$input"
        WW_AUTH_USER="${WW_AUTH_USER:-grin}"
        _ww_validate_auth_user "$WW_AUTH_USER" || { WW_AUTH_USER=""; continue; }
        break
    done

    local flag="-c"
    if [[ -f "$WW_HTPASSWD" ]]; then
        warn "Password file already exists: $WW_HTPASSWD"
        echo -e "  ${GREEN}1${RESET}) Add / update user '${WW_AUTH_USER}'  ${DIM}(keeps other users)${RESET}"
        echo -e "  ${RED}2${RESET}) Recreate file                    ${DIM}(removes all existing users)${RESET}"
        echo -e "  ${DIM}0) Cancel${RESET}"
        echo -ne "Choice [1]: "
        read -r recreate || true
        [[ "$recreate" == "0" ]] && return
        [[ "${recreate:-1}" != "2" ]] && flag=""
    fi

    echo ""
    info "Setting password for user '${WW_AUTH_USER}':"
    # shellcheck disable=SC2086
    htpasswd $flag "$WW_HTPASSWD" "$WW_AUTH_USER" \
        && success "Basic Auth configured for user '$WW_AUTH_USER'." \
        || { die "htpasswd failed."; pause; return; }

    nginx -t 2>/dev/null && systemctl reload nginx 2>/dev/null || true
    ww_save_config
    log "[ww_setup_auth] user=$WW_AUTH_USER"
    pause
}

# =============================================================================
# STEP 7 — Configure firewall
# =============================================================================

ww_configure_firewall() {
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet — 7) Configure Firewall ──${RESET}\n"
    echo -e "  ${DIM}Opens ports 80 and 443. Node + wallet API ports stay localhost-only.${RESET}"
    echo ""
    echo -ne "${BOLD}Open ports 80 and 443? [Y/n/0]: ${RESET}"
    read -r confirm || true
    [[ "$confirm" == "0" ]] && return
    [[ "${confirm,,}" == "n" ]] && info "Cancelled." && return

    if command -v ufw &>/dev/null; then
        ufw allow 443/tcp && success "UFW: port 443 opened."
        ufw allow 80/tcp  && success "UFW: port 80 opened."
    elif command -v iptables &>/dev/null; then
        iptables -I INPUT -p tcp --dport 443 -j ACCEPT
        iptables -I INPUT -p tcp --dport 80  -j ACCEPT
        success "iptables: ports 80 and 443 opened."
        warn "iptables rules are not persistent. Use iptables-persistent to save them."
    else
        warn "No firewall tool found (ufw / iptables). Open ports 80 and 443 manually."
    fi

    ww_setup_fail2ban || true

    log "[ww_configure_firewall]"
    pause
}

# ─── fail2ban jail — Basic Auth brute force ──────────────────────────────────
# nginx Basic Auth is the ENTIRE auth boundary for Fidelius: whoever passes it
# controls every registered wallet. nginx itself never rate-limits 401s, so
# without this the credential is unlimited-guess from the internet.
#
# Own jail file + own logpath so this never collides with Script 02's
# /etc/fail2ban/jail.d/nginx-grin.conf, which globs /var/log/nginx/*error.log —
# both jails may match the same lines, which is harmless (two bans, same IP).
# Filters are fail2ban stock: nginx-http-auth matches the "user ... password
# mismatch" / "was not found in" lines auth_basic writes to the ERROR log.
ww_setup_fail2ban() {
    echo ""
    echo -ne "${BOLD}Install a fail2ban jail for Basic Auth brute force? [Y/n]: ${RESET}"
    read -r _f2b || true
    [[ "${_f2b,,}" == "n" ]] && { info "Skipped fail2ban."; return 0; }
    _ww_write_f2b_jail
}

# The non-interactive half. Split out because the private-access switch has to
# rewrite the jails (to add the WireGuard subnet to ignoreip) with no operator
# present: calling the prompting wrapper there — even with output redirected to
# /dev/null — leaves `read` blocking on a prompt nobody can see, so the script
# just appears to freeze after announcing success.
_ww_write_f2b_jail() {
    if ! command -v fail2ban-server &>/dev/null; then
        info "Installing fail2ban ..."
        if command -v apt-get &>/dev/null; then
            DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban >/dev/null 2>&1 \
                || { warn "fail2ban install failed — skipping jail."; return 0; }
        elif command -v dnf &>/dev/null; then
            dnf install -y fail2ban >/dev/null 2>&1 \
                || { warn "fail2ban install failed — skipping jail."; return 0; }
        else
            warn "No apt-get/dnf — install fail2ban manually, then re-run this step."
            return 0
        fi
    fi

    # ── ignoreip ─────────────────────────────────────────────────────────────
    # Once the wallet is behind WireGuard, $remote_addr in the nginx log is the
    # operator's own tunnel address. Five fat-fingered passwords from the phone
    # would ban the ONLY address that can still reach the wallet, and the unban
    # requires the SSH session this design exists to avoid needing. Exempting
    # the subnet costs nothing: entering it already required a private key, which
    # is a stronger gate than the password fail2ban is guarding.
    local _f2b_ignore="127.0.0.1/8 ::1"
    if declare -F gwa_installed &>/dev/null && gwa_installed; then
        _f2b_ignore+=" ${GWA_SUBNET}"
    fi

    mkdir -p /etc/fail2ban/jail.d
    cat > "$WW_F2B_JAIL" <<F2B
# Generated by 051_grin_fidelius.sh — Fidelius web wallet.
# Basic Auth is the whole auth boundary here; these jails make guessing it costly.
# Paths match the access_log/error_log in $WW_NGINX_CONF.

[grin-fidelius-auth]
enabled  = true
port     = http,https
filter   = nginx-http-auth
logpath  = /var/log/nginx/grin-fidelius-error.log
maxretry = 5
findtime = 600
bantime  = 3600
ignoreip = $_f2b_ignore

[grin-fidelius-limit-req]
enabled  = true
port     = http,https
filter   = nginx-limit-req
logpath  = /var/log/nginx/grin-fidelius-error.log
maxretry = 10
findtime = 600
bantime  = 600
ignoreip = $_f2b_ignore
F2B
    chmod 644 "$WW_F2B_JAIL"

    # fail2ban refuses to start if a jail's logpath does not exist yet — nginx
    # only creates these on the first request. Touch them so a fresh install
    # doesn't leave the service dead.
    touch /var/log/nginx/grin-fidelius-error.log /var/log/nginx/grin-fidelius-access.log 2>/dev/null || true

    systemctl enable fail2ban >/dev/null 2>&1 || true
    if systemctl restart fail2ban 2>/dev/null; then
        success "fail2ban jail installed: $WW_F2B_JAIL"
        echo -e "  ${DIM}Status : fail2ban-client status grin-fidelius-auth${RESET}"
        echo -e "  ${DIM}Unban  : fail2ban-client set grin-fidelius-auth unbanip <IP>${RESET}"
    else
        warn "fail2ban restart failed — check: journalctl -u fail2ban -n 30"
    fi
    return 0
}

# =============================================================================
# STEP V — Private access (WireGuard + DNS-01)
# =============================================================================
#
#  Optional. Moves the wallet off the public internet without giving up a real,
#  publicly-trusted certificate for its normal domain name.
#
#    phone ══ udp/51820 ══▶ wg0 (10.9.0.1) ══▶ nginx 10.9.0.1:443 ══▶ :7420
#
#  The cert stays valid because DNS-01 proves domain control by writing a TXT
#  record — it never connects to this host, so the host needs no public port.
#  The browser sees the same green padlock on the same name; only the route
#  changed.
#
#  What this does NOT fix: server.js still runs as root, and a stolen phone or
#  leaked WireGuard key is a full bypass. WireGuard changes WHO can reach the
#  app, not what happens once they do.
#
# =============================================================================

# Which certificate is currently installed, if any.
_ww_cert_kind() {
    if   [[ -n "$WW_DOMAIN" && -f "/etc/letsencrypt/live/$WW_DOMAIN/fullchain.pem" ]]; then echo "le"
    elif [[ -n "$WW_DOMAIN" && -f "/etc/ssl/cloudflare-origin/$WW_DOMAIN.pem" ]];    then echo "cf"
    else echo ""
    fi
}

# The optional Let's Encrypt ssl_* includes, guarded by existence.
#
# These files are created by certbot's NGINX INSTALLER plugin, not by certonly.
# A cert issued with `certonly --dns-cloudflare` never loads that plugin, so
# ssl-dhparams.pem in particular may not exist — and an nginx include pointing
# at a missing file is a hard `nginx -t` failure, i.e. nginx will not start.
_ww_le_ssl_extra() {
    local out=""
    [[ -f /etc/letsencrypt/options-ssl-nginx.conf ]] \
        && out+="    include /etc/letsencrypt/options-ssl-nginx.conf;"$'\n'
    [[ -f /etc/letsencrypt/ssl-dhparams.pem ]] \
        && out+="    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"$'\n'
    if [[ -z "$out" ]]; then
        out="    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;"
    fi
    printf '%s' "$out"
}

_ww_cf_ssl_extra() {
    printf '%s' "    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;"
}

# Re-emit the vhost with whatever cert is already installed, honouring the
# current WW_BIND_ADDR. Used by both the switch and the revert.
_ww_rewrite_vhost_keep_cert() {
    case "$(_ww_cert_kind)" in
        le) _ww_write_https_vhost "Let's Encrypt" \
                "/etc/letsencrypt/live/$WW_DOMAIN/fullchain.pem" \
                "/etc/letsencrypt/live/$WW_DOMAIN/privkey.pem" \
                "$(_ww_le_ssl_extra)" ;;
        cf) _ww_write_https_vhost "Cloudflare Origin Cert" \
                "/etc/ssl/cloudflare-origin/$WW_DOMAIN.pem" \
                "/etc/ssl/cloudflare-origin/$WW_DOMAIN.key" \
                "$(_ww_cf_ssl_extra)" ;;
        *)  return 1 ;;
    esac
}

_ww_pa_header() {
    clear
    echo -e "\n${BOLD}${CYAN}── Fidelius — V) Private access (WireGuard + DNS-01) ──${RESET}\n"
}

_ww_pa_status() {
    ww_load_config
    local exposure wgline certline

    if [[ -n "${WW_BIND_ADDR:-}" ]]; then
        exposure="${GREEN}PRIVATE${RESET}  ${DIM}(nginx listens on ${WW_BIND_ADDR} only)${RESET}"
    elif [[ -f "$WW_NGINX_CONF" ]]; then
        exposure="${YELLOW}PUBLIC${RESET}   ${DIM}(reachable from the internet)${RESET}"
    else
        exposure="${DIM}no vhost yet${RESET}"
    fi

    if declare -F gwa_status_lines &>/dev/null; then
        wgline=$(gwa_status_lines)
    else
        wgline="lib missing"
    fi

    local kind; kind=$(_ww_cert_kind)
    case "$kind" in
        le) local exp auth
            exp=$(gwa_dns01_cert_expiry "$WW_DOMAIN" 2>/dev/null || echo "")
            if gwa_dns01_renewal_uses_dns "$WW_DOMAIN" 2>/dev/null; then
                auth="${GREEN}DNS-01${RESET}"
            else
                auth="${YELLOW}HTTP-01${RESET}"
            fi
            certline="Let's Encrypt via $auth  ${DIM}${exp:+(expires $exp)}${RESET}" ;;
        cf) certline="Cloudflare Origin  ${DIM}(no ACME renewal needed)${RESET}" ;;
        *)  certline="${DIM}none${RESET}" ;;
    esac

    echo -e "  ${BOLD}Wallet exposure${RESET} : $exposure"
    echo -e "  ${BOLD}WireGuard${RESET}       : $wgline"
    echo -e "  ${BOLD}Certificate${RESET}     : $certline"
    echo -e "  ${BOLD}Domain${RESET}          : ${WW_DOMAIN:-${DIM}not set${RESET}}"
    echo ""
}

# ── V1) Install WireGuard ────────────────────────────────────────────────────
_ww_pa_install() {
    _ww_pa_header
    declare -F gwa_install_deps &>/dev/null || { die "lib/grin_wg_access.sh not found."; pause; return; }

    if gwa_installed; then
        info "WireGuard is already configured ($GWA_WG_CONF)."
        info "Re-running would invalidate every provisioned device, so it is skipped."
        pause; return
    fi

    echo -e "  ${DIM}Creates a WireGuard interface on ${GWA_SERVER_IP} listening on udp/${GWA_PORT}.${RESET}"
    echo -e "  ${DIM}Split tunnel: devices reach ONLY ${GWA_SUBNET}, not the wider internet.${RESET}"
    echo -e "  ${DIM}IP forwarding stays off — this is host access, not a VPN gateway.${RESET}"
    echo ""

    gwa_install_deps || { pause; return; }

    local detected endpoint
    detected=$(gwa_detect_public_ip)
    echo ""
    if [[ -n "$detected" ]]; then
        echo -ne "Public address devices will dial [${detected}]: "
    else
        warn "Could not detect a public IP (this host may be behind NAT)."
        echo -ne "Public address or hostname devices will dial: "
    fi
    read -r endpoint || true
    [[ -z "$endpoint" ]] && endpoint="$detected"
    if [[ -z "$endpoint" ]]; then
        die "An endpoint is required."; pause; return
    fi
    # A hostname is fine here, but it must not be the wallet domain: that name
    # points at the WireGuard IP, so a client would try to dial the tunnel
    # through itself.
    if [[ -n "$WW_DOMAIN" && "$endpoint" == "$WW_DOMAIN" ]]; then
        die "The endpoint cannot be $WW_DOMAIN — that name resolves inside the tunnel."
        pause; return
    fi

    echo ""
    gwa_server_init "$endpoint" || { pause; return; }
    gwa_firewall_open
    gwa_enable_nonlocal_bind

    echo ""
    success "WireGuard is up. Next: add a device (option 2), then scan its QR."
    pause
}

# ── V2) Add a device ─────────────────────────────────────────────────────────
_ww_pa_add_device() {
    _ww_pa_header
    gwa_installed || { die "Run option 1 first."; pause; return; }

    echo -ne "Device name (e.g. phone, laptop): "
    local name; read -r name || true
    gwa_valid_peer_name "$name" || { warn "Invalid name."; pause; return; }

    gwa_peer_add "$name" || { pause; return; }

    echo ""
    echo -e "  ${BOLD}Scan this with the WireGuard app${RESET} ${DIM}(Android / iOS → + → Scan from QR code)${RESET}"
    gwa_peer_qr "$name" || true
    echo -e "  ${DIM}Also saved at $(gwa_client_conf_path "$name") (mode 600).${RESET}"
    echo ""
    echo -e "  ${YELLOW}Now turn the tunnel ON on that device${RESET} — option 5 will refuse to"
    echo -e "  ${YELLOW}switch the wallet over until it sees a real handshake.${RESET}"
    echo ""
    echo -ne "  Delete the stored copy of this device's private key? [y/N]: "
    local _del; read -r _del || true
    if [[ "${_del,,}" == "y" ]]; then
        gwa_peer_forget_conf "$name"
        warn "The QR cannot be shown again — revoke and re-add if the device is lost."
    fi
    pause
}

# ── V3) Devices ──────────────────────────────────────────────────────────────
_ww_pa_devices() {
    while true; do
        _ww_pa_header
        gwa_installed || { die "Run option 1 first."; pause; return; }

        echo -e "  ${BOLD}Devices${RESET}\n"
        local rows; rows=$(gwa_peer_list)
        if [[ -z "$rows" ]]; then
            echo -e "  ${DIM}(none yet)${RESET}"
        else
            printf "  %-20s %-14s %s\n" "NAME" "ADDRESS" "LAST HANDSHAKE"
            while IFS=$'\t' read -r n i a; do
                printf "  %-20s %-14s %s\n" "$n" "$i" "$a"
            done <<< "$rows"
        fi
        echo ""
        echo -e "  ${GREEN}q${RESET}) Re-show a QR code"
        echo -e "  ${RED}r${RESET}) Revoke a device"
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [q/r/0]: ${RESET}"
        local c; read -r c || true
        case "$c" in
            q|Q) echo -ne "  Device name: "; local qn; read -r qn || true
                 gwa_peer_qr "$qn" || true; pause ;;
            r|R) echo -ne "  Device name to REVOKE: "; local rn; read -r rn || true
                 gwa_peer_exists "$rn" || { warn "No such device."; pause; continue; }
                 echo -ne "  ${YELLOW}Revoke '$rn'? It loses access immediately. [y/N]: ${RESET}"
                 local rc; read -r rc || true
                 # if-form, not `[[ ]] && cmd`: a false test would make this arm
                 # return 1, which under set -e kills the menu loop (CLAUDE.md).
                 if [[ "${rc,,}" == "y" ]]; then
                     gwa_peer_remove "$rn" || true
                 else
                     info "Not revoked."
                 fi
                 pause ;;
            0|"") return ;;
            *)   warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# ── V4) DNS-01 certificate ───────────────────────────────────────────────────
_ww_pa_dns01() {
    _ww_pa_header
    ww_load_config

    command -v certbot &>/dev/null || { die "certbot not installed — run step 2 first."; pause; return; }
    [[ -n "$WW_DOMAIN" ]] || { die "Domain not set — run step 4 first."; pause; return; }
    [[ -f "$WW_HTPASSWD" ]] || { die "Set up Basic Auth (step 6) before issuing a certificate."; pause; return; }

    echo -e "  ${DIM}DNS-01 proves you control $WW_DOMAIN by writing a TXT record.${RESET}"
    echo -e "  ${DIM}It never connects to this server, so the wallet needs no public port.${RESET}"
    echo -e "  ${DIM}Renewal is unattended on certbot's own timer and also needs no port.${RESET}"
    echo ""
    echo -e "  ${YELLOW}This puts a DNS API token on this machine.${RESET} Scope it to the one zone."
    echo ""
    echo -e "  ${BOLD}DNS provider:${RESET}"
    echo -e "  ${GREEN}1${RESET}) Cloudflare"
    echo -e "  ${GREEN}2${RESET}) DigitalOcean"
    echo -ne "  Choice [1/2/0 to cancel]: "
    local pc; read -r pc || true
    local provider
    case "$pc" in
        1) provider="cloudflare" ;;
        2) provider="digitalocean" ;;
        *) return ;;
    esac

    echo ""
    gwa_dns01_token_help "$provider"
    echo ""

    local credfile; credfile=$(gwa_dns01_credfile "$provider")
    if [[ -f "$credfile" ]]; then
        echo -ne "  Reuse the token already stored in $credfile? [Y/n]: "
        local reuse; read -r reuse || true
        if [[ "${reuse,,}" == "n" ]]; then
            echo -ne "  Paste API token (hidden): "
            local tok; read -rs tok || true; echo ""
            [[ -z "$tok" ]] && { warn "Empty token."; pause; return; }
            gwa_dns01_write_credentials "$provider" "$tok"
        fi
    else
        echo -ne "  Paste API token (hidden): "
        local tok; read -rs tok || true; echo ""
        [[ -z "$tok" ]] && { warn "Empty token."; pause; return; }
        gwa_dns01_write_credentials "$provider" "$tok"
    fi

    while true; do
        echo -ne "  Let's Encrypt email [${WW_EMAIL:-}]: "
        local input; read -r input || true
        [[ -n "$input" ]] && WW_EMAIL="$input"
        _ww_validate_email "$WW_EMAIL" || { WW_EMAIL=""; continue; }
        break
    done

    echo ""
    gwa_dns01_install_plugin "$provider" || { pause; return; }

    echo ""
    gwa_dns01_issue "$provider" "$WW_DOMAIN" "$WW_EMAIL" 30 || { pause; return; }

    # Re-emit the vhost against the new cert, keeping the current bind address.
    if _ww_rewrite_vhost_keep_cert; then
        ln -sf "$WW_NGINX_CONF" "$WW_NGINX_LINK" 2>/dev/null || true
        if nginx -t >/dev/null 2>&1 && systemctl reload nginx; then
            success "nginx reloaded with the DNS-01 certificate."
        else
            warn "nginx -t failed:"; nginx -t 2>&1 | tail -5
        fi
    fi

    ww_save_config
    ww_save_env
    log "[ww_private_access] dns01 provider=$provider domain=$WW_DOMAIN"
    echo ""
    success "Renewal is now unattended and portless. Verify with:"
    echo -e "  ${DIM}certbot renew --dry-run${RESET}"
    pause
}

# ── V5) Switch to VPN-only ───────────────────────────────────────────────────
_ww_pa_switch() {
    _ww_pa_header
    ww_load_config

    gwa_installed || { die "Run option 1 first."; pause; return; }
    [[ -f "$WW_NGINX_CONF" ]] || { die "No nginx vhost — run step 4 first."; pause; return; }

    local kind; kind=$(_ww_cert_kind)
    [[ -n "$kind" ]] || { die "No certificate installed — run step 5 or option 4 first."; pause; return; }

    if [[ -n "${WW_BIND_ADDR:-}" ]]; then
        info "Already private (bound to ${WW_BIND_ADDR})."
        pause; return
    fi

    # ── Gate 1: the tunnel must be proven, not merely configured ─────────────
    # This is the difference between a hardening step and locking yourself out
    # of your own wallet. A config file is not evidence; a handshake is.
    if ! gwa_handshake_seen; then
        error "No WireGuard device has completed a handshake yet."
        echo ""
        warn "Switching now would leave the wallet unreachable from everywhere."
        warn "Add a device (option 2), turn the tunnel ON, load any page, then retry."
        pause; return
    fi

    # ── Gate 2: renewal must not depend on the port we are about to abandon ──
    # An HTTP-01 cert renews by answering on public port 80. After this switch
    # that answer never arrives — and the failure surfaces ~60 days later as an
    # expired certificate, with nothing in the moment to connect it to.
    if [[ "$kind" == "le" ]] && ! gwa_dns01_renewal_uses_dns "$WW_DOMAIN"; then
        error "The certificate for $WW_DOMAIN renews via HTTP-01."
        echo ""
        warn "HTTP-01 needs public port 80, which private mode removes. The cert"
        warn "would renew fine today and then silently fail in ~60 days."
        warn "Run option 4 (DNS-01) first — it replaces the renewal method."
        pause; return
    fi

    echo -e "  ${BOLD}After this switch:${RESET}"
    echo -e "    • https://$WW_DOMAIN works ${GREEN}only${RESET} with the tunnel ON"
    echo -e "    • with the tunnel off the browser just times out — no error page"
    echo -e "    • the certificate and the padlock are unchanged"
    echo -e "    • SSH is untouched, and option 6 reverts this"
    echo ""
    echo -e "  ${YELLOW}You must also point DNS at the tunnel:${RESET}"
    echo -e "    ${BOLD}A   $WW_DOMAIN   →   ${GWA_SERVER_IP}${RESET}"
    echo -e "    ${DIM}On Cloudflare this record MUST be \"DNS only\" (grey cloud). A${RESET}"
    echo -e "    ${DIM}proxied record sends browsers to Cloudflare's edge, which has no${RESET}"
    echo -e "    ${DIM}route to a private address.${RESET}"
    echo ""
    echo -ne "${BOLD}Switch the wallet to VPN-only? [y/N]: ${RESET}"
    local c; read -r c || true
    [[ "${c,,}" != "y" ]] && { info "Cancelled."; pause; return; }

    gwa_enable_nonlocal_bind

    local previous="${WW_BIND_ADDR:-}"
    WW_BIND_ADDR="$GWA_SERVER_IP"
    _ww_rewrite_vhost_keep_cert || { die "Could not rewrite the vhost."; WW_BIND_ADDR="$previous"; pause; return; }

    # Automatic rollback: a vhost that fails nginx -t must never be left on
    # disk, because the next unrelated `systemctl reload nginx` — from any other
    # toolkit script — would fail on it and take the whole web stack down.
    if ! nginx -t >/dev/null 2>&1; then
        error "nginx -t failed — rolling back to the public listener."
        nginx -t 2>&1 | tail -5
        WW_BIND_ADDR="$previous"
        _ww_rewrite_vhost_keep_cert || true
        nginx -t >/dev/null 2>&1 && systemctl reload nginx 2>/dev/null || true
        ww_save_config
        pause; return
    fi

    systemctl reload nginx || true
    ww_save_config
    ww_save_env

    # Rewrite the jails so the WG subnet lands in ignoreip — but only if jails
    # already exist. Installing fail2ban here uninvited would be a surprising
    # side effect of a listener change, and _ww_write_f2b_jail would go off and
    # apt-get it with no prompt.
    if [[ -f "$WW_F2B_JAIL" ]]; then
        _ww_write_f2b_jail >/dev/null 2>&1 || true
        info "fail2ban jails rewritten — ${GWA_SUBNET} is now in ignoreip."
    fi

    # ── Verify, don't assume ─────────────────────────────────────────────────
    # `nginx -t` only parses; it never binds. A reload whose new listen socket
    # fails to bind leaves the master running on the OLD sockets and still
    # returns 0, so nginx would go on serving the wallet publicly while this
    # screen claimed it was private. Ask the kernel instead.
    local bound=1
    if command -v ss &>/dev/null; then
        ss -ltn 2>/dev/null | awk -v a="${GWA_SERVER_IP}:443" \
            '$4 == a { f = 1 } END { exit !f }' || bound=0
    fi
    if (( bound )); then
        success "Wallet is now private: nginx listens on ${GWA_SERVER_IP}:443 only."
    else
        error "nginx did NOT bind ${GWA_SERVER_IP}:443 — the wallet may still be public."
        warn "The config was written and accepted, but the socket did not move."
        warn "Check: journalctl -u nginx -n 20   and   option 7 (Diagnose)."
        warn "If ip_nonlocal_bind could not be set (common in LXC), bring wg0 up first."
    fi
    log "[ww_private_access] switched to bind=$WW_BIND_ADDR bound=$bound"
    echo ""
    echo -e "  ${DIM}Verify from a tunnelled device: https://$WW_DOMAIN${RESET}"
    echo -e "  ${DIM}Verify from here             : option 7 (Diagnose)${RESET}"
    pause
}

# ── V6) Revert to public ─────────────────────────────────────────────────────
_ww_pa_revert() {
    _ww_pa_header
    ww_load_config

    if [[ -z "${WW_BIND_ADDR:-}" ]]; then
        info "The wallet is already on the public listener."
        pause; return
    fi

    warn "This puts the Fidelius login back on the public internet."
    warn "Basic Auth + fail2ban become the entire perimeter again."
    echo ""
    echo -e "  ${DIM}Remember to point $WW_DOMAIN back at this server's public IP.${RESET}"
    echo -e "  ${DIM}A DNS-01 certificate keeps renewing either way — no cert change needed.${RESET}"
    echo ""
    echo -ne "${BOLD}Revert to public HTTPS? [y/N]: ${RESET}"
    local c; read -r c || true
    [[ "${c,,}" != "y" ]] && { info "Cancelled."; pause; return; }

    WW_BIND_ADDR=""
    _ww_rewrite_vhost_keep_cert || { die "Could not rewrite the vhost."; pause; return; }
    if nginx -t >/dev/null 2>&1 && systemctl reload nginx; then
        ww_save_config
        ww_save_env
        success "Public HTTPS restored."
        log "[ww_private_access] reverted to public listener"
    else
        warn "nginx -t failed:"; nginx -t 2>&1 | tail -5
    fi
    pause
}

# ── V7) Diagnose ─────────────────────────────────────────────────────────────
_ww_pa_diagnose() {
    _ww_pa_header
    ww_load_config
    echo -e "  ${BOLD}Access diagnosis${RESET}\n"

    # 1. Tunnel
    if ! gwa_installed; then
        echo -e "  ${DIM}WireGuard${RESET}      : not configured"
    else
        local st="down"; gwa_active && st="up"
        local en="disabled at boot"; gwa_enabled && en="enabled at boot"
        echo -e "  ${DIM}WireGuard${RESET}      : $st, $en"
        if gwa_handshake_seen; then
            echo -e "  ${DIM}Handshake${RESET}      : ${GREEN}seen${RESET}"
        else
            echo -e "  ${DIM}Handshake${RESET}      : ${YELLOW}never${RESET}  (no device has connected)"
        fi
        [[ "$en" == "disabled at boot" ]] && \
            warn "wg-quick@${GWA_IFACE} is not enabled — a reboot would cut off access."
    fi

    # 2. Listener
    #
    # In private mode match the EXACT address. Accepting a wildcard listener as
    # proof would be a false pass: another vhost on this box may well hold *:443,
    # and that tells us nothing about whether the wallet is bound where it thinks.
    # Matched with awk on ss's Local Address:Port column, exactly. A regex built
    # from the address would need its dots escaped, and `${v//./\.}` does NOT
    # escape in bash — it silently yields `10.9.0.1` with dots as wildcards.
    if command -v ss &>/dev/null; then
        local want listening=1
        if [[ -n "${WW_BIND_ADDR:-}" ]]; then
            want="$WW_BIND_ADDR"
            ss -ltn 2>/dev/null | awk -v a="${WW_BIND_ADDR}:443" \
                '$4 == a { f = 1 } END { exit !f }' || listening=0
        else
            want="all interfaces"
            ss -ltn 2>/dev/null | awk \
                '$4 == "*:443" || $4 == "0.0.0.0:443" || $4 == "[::]:443" { f = 1 } END { exit !f }' || listening=0
        fi
        if (( listening )); then
            echo -e "  ${DIM}nginx :443${RESET}     : listening on $want"
        else
            echo -e "  ${DIM}nginx :443${RESET}     : ${YELLOW}not listening on $want${RESET}"
        fi
    fi
    echo -e "  ${DIM}nonlocal_bind${RESET}  : $(cat /proc/sys/net/ipv4/ip_nonlocal_bind 2>/dev/null || echo '?')"

    # 3. DNS
    if [[ -n "$WW_DOMAIN" ]]; then
        local got; got=$(gwa_resolve "$WW_DOMAIN")
        if [[ -z "$got" ]]; then
            echo -e "  ${DIM}DNS${RESET}            : ${YELLOW}no A record resolved${RESET}"
            warn "If the record exists and points at ${GWA_SERVER_IP}, the resolver is"
            warn "stripping it — DNS rebinding protection drops private answers on some"
            warn "routers and ISPs. Workaround: set DNS = ${GWA_SERVER_IP} in the client"
            warn "config and run a resolver on wg0, or use a resolver that passes them."
        else
            echo -e "  ${DIM}DNS${RESET}            : $WW_DOMAIN → $got"
            if [[ -n "${WW_BIND_ADDR:-}" && "$got" != *"$WW_BIND_ADDR"* ]]; then
                warn "Expected $WW_BIND_ADDR. Tunnelled devices will not reach the wallet."
            fi
        fi
    fi

    # 4. Certificate
    local kind; kind=$(_ww_cert_kind)
    case "$kind" in
        le) local exp; exp=$(gwa_dns01_cert_expiry "$WW_DOMAIN")
            if gwa_dns01_renewal_uses_dns "$WW_DOMAIN"; then
                echo -e "  ${DIM}Certificate${RESET}    : Let's Encrypt, DNS-01, expires ${exp:-?}"
            else
                echo -e "  ${DIM}Certificate${RESET}    : Let's Encrypt, ${YELLOW}HTTP-01${RESET}, expires ${exp:-?}"
                [[ -n "${WW_BIND_ADDR:-}" ]] && \
                    error "HTTP-01 cannot renew in private mode — run option 4."
            fi ;;
        cf) echo -e "  ${DIM}Certificate${RESET}    : Cloudflare Origin (long-lived)" ;;
        *)  echo -e "  ${DIM}Certificate${RESET}    : ${YELLOW}none${RESET}" ;;
    esac

    # 5. End-to-end. A 401 is the healthy answer: it means TLS terminated and
    # Basic Auth challenged, i.e. the whole path works and is still guarded.
    if [[ -n "$WW_DOMAIN" && -n "$kind" ]] && command -v curl &>/dev/null; then
        local target="${WW_BIND_ADDR:-127.0.0.1}" code
        # A Cloudflare Origin cert is signed by Cloudflare's private origin CA,
        # which is deliberately NOT in any trust store — only CF's edge accepts
        # it. Verifying here would fail on a perfectly healthy setup and report
        # it as "no response". This probe tests reachability and auth, not trust.
        local -a _tls=()
        [[ "$kind" == "cf" ]] && _tls=( --insecure )
        code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "${_tls[@]}" \
               --resolve "${WW_DOMAIN}:443:${target}" "https://${WW_DOMAIN}/" 2>/dev/null || echo "000")
        case "$code" in
            401) echo -e "  ${DIM}End-to-end${RESET}     : ${GREEN}401${RESET} — TLS + Basic Auth are working" ;;
            000) echo -e "  ${DIM}End-to-end${RESET}     : ${RED}no response${RESET} from ${target}:443" ;;
            *)   echo -e "  ${DIM}End-to-end${RESET}     : HTTP $code from ${target}:443" ;;
        esac
    fi

    # 6. App
    if systemctl is-active --quiet grin-fidelius 2>/dev/null; then
        echo -e "  ${DIM}grin-fidelius${RESET}  : running on 127.0.0.1:$WW_NODE_PORT"
    else
        echo -e "  ${DIM}grin-fidelius${RESET}  : ${YELLOW}not running${RESET}"
    fi

    echo ""
    pause
}

ww_private_access() {
    if ! declare -F gwa_installed &>/dev/null; then
        _ww_pa_header
        die "scripts/lib/grin_wg_access.sh is missing — re-deploy the toolkit."
        pause; return
    fi
    while true; do
        _ww_pa_header
        _ww_pa_status
        echo -e "${DIM}  ─── Setup (in order) ────────────────────────────${RESET}"
        echo -e "  ${GREEN}1${RESET}) Install WireGuard        ${DIM}(interface ${GWA_SERVER_IP}, udp/${GWA_PORT})${RESET}"
        echo -e "  ${GREEN}2${RESET}) Add a device             ${DIM}(prints a QR code to scan)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Devices                  ${DIM}(list / revoke / re-show QR)${RESET}"
        echo -e "  ${GREEN}4${RESET}) Certificate via DNS-01   ${DIM}(portless issue + renewal)${RESET}"
        echo -e "  ${GREEN}5${RESET}) Switch wallet to VPN-only${DIM}  (needs a proven handshake)${RESET}"
        echo ""
        echo -e "${DIM}  ─── Maintenance ─────────────────────────────────${RESET}"
        echo -e "  ${CYAN}6${RESET}) Revert to public HTTPS"
        echo -e "  ${CYAN}7${RESET}) Diagnose access"
        echo ""
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-7 / 0]: ${RESET}"
        local choice; read -r choice || true
        case "$choice" in
            1)  _ww_pa_install    || true ;;
            2)  _ww_pa_add_device || true ;;
            3)  _ww_pa_devices    || true ;;
            4)  _ww_pa_dns01      || true ;;
            5)  _ww_pa_switch     || true ;;
            6)  _ww_pa_revert     || true ;;
            7)  _ww_pa_diagnose   || true ;;
            0)  break ;;
            "") continue ;;
            *)  warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# =============================================================================
# STEP 8 — Status & info
# =============================================================================

ww_show_info() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet — 8) Status & Info ──${RESET}\n"

    # Dependencies
    local deps_ok=1
    for cmd in node nginx certbot htpasswd; do
        command -v "$cmd" &>/dev/null || { deps_ok=0; break; }
    done
    [[ $deps_ok -eq 1 ]] && echo -e "  ${BOLD}Dependencies${RESET}  : ${GREEN}all present${RESET}" \
                         || echo -e "  ${BOLD}Dependencies${RESET}  : ${RED}some missing${RESET}  ${DIM}(step 2)${RESET}"

    command -v qrencode &>/dev/null \
        && echo -e "  ${BOLD}qrencode${RESET}      : ${GREEN}installed${RESET}" \
        || echo -e "  ${BOLD}qrencode${RESET}      : ${YELLOW}not installed${RESET}  ${DIM}(QR codes may be hidden)${RESET}"

    if [[ -x "$WW_BIN" ]]; then
        local ver; ver=$("$WW_BIN" --version 2>/dev/null | head -1 || echo "?")
        echo -e "  ${BOLD}grin-wallet${RESET}   : ${GREEN}$ver${RESET}"
    else
        echo -e "  ${BOLD}grin-wallet${RESET}   : ${RED}not installed${RESET}  ${DIM}(step 1)${RESET}"
    fi

    if [[ -f "$WW_APP_DIR/server.js" ]]; then
        echo -e "  ${BOLD}App files${RESET}     : ${GREEN}deployed${RESET}  ${DIM}($WW_APP_DIR)${RESET}"
    else
        echo -e "  ${BOLD}App files${RESET}     : ${RED}not deployed${RESET}  ${DIM}(step 3)${RESET}"
    fi

    if [[ -f "$WW_SYSTEMD_UNIT" ]]; then
        if systemctl is-active --quiet grin-fidelius 2>/dev/null; then
            echo -e "  ${BOLD}systemd${RESET}       : ${GREEN}running${RESET}  ${DIM}(127.0.0.1:$WW_NODE_PORT)${RESET}"
        else
            echo -e "  ${BOLD}systemd${RESET}       : ${YELLOW}stopped${RESET}  ${DIM}(systemctl start grin-fidelius)${RESET}"
        fi
    else
        echo -e "  ${BOLD}systemd${RESET}       : ${RED}not installed${RESET}  ${DIM}(step 3)${RESET}"
    fi

    [[ -f "$WW_NGINX_CONF" ]] \
        && echo -e "  ${BOLD}nginx vhost${RESET}   : ${GREEN}configured${RESET}  ${DIM}($WW_NGINX_CONF)${RESET}" \
        || echo -e "  ${BOLD}nginx vhost${RESET}   : ${RED}not configured${RESET}  ${DIM}(step 4)${RESET}"

    if [[ -n "$WW_DOMAIN" && -f "/etc/letsencrypt/live/$WW_DOMAIN/fullchain.pem" ]]; then
        local cert_expiry
        cert_expiry=$(openssl x509 -enddate -noout \
            -in "/etc/letsencrypt/live/$WW_DOMAIN/fullchain.pem" 2>/dev/null \
            | sed 's/notAfter=//' || echo "unknown")
        echo -e "  ${BOLD}SSL cert${RESET}      : ${GREEN}Let's Encrypt${RESET}  ${DIM}(expires: $cert_expiry)${RESET}"
    elif [[ -n "$WW_DOMAIN" && -f "/etc/ssl/cloudflare-origin/$WW_DOMAIN.pem" ]]; then
        echo -e "  ${BOLD}SSL cert${RESET}      : ${GREEN}Cloudflare Origin${RESET}  ${DIM}($WW_DOMAIN)${RESET}"
    else
        echo -e "  ${BOLD}SSL cert${RESET}      : ${RED}not issued${RESET}  ${DIM}(step 5)${RESET}"
    fi

    [[ -f "$WW_HTPASSWD" ]] \
        && echo -e "  ${BOLD}Basic Auth${RESET}    : ${GREEN}configured${RESET}  ${DIM}(user: ${WW_AUTH_USER:-grin})${RESET}" \
        || echo -e "  ${BOLD}Basic Auth${RESET}    : ${RED}not configured${RESET}  ${DIM}(step 6)${RESET}"

    if [[ -L "$WW_NGINX_LINK" ]]; then
        echo -e "  ${BOLD}Web UI${RESET}        : ${GREEN}LIVE${RESET}  ${DIM}→ https://${WW_DOMAIN:-<domain>}${RESET}"
    else
        echo -e "  ${BOLD}Web UI${RESET}        : ${RED}not live${RESET}  ${DIM}(complete steps 3-6)${RESET}"
    fi

    # Tor (used for grin-wallet Tor sends)
    if systemctl is-active --quiet tor 2>/dev/null || systemctl is-active --quiet tor@default 2>/dev/null; then
        if ss -tln 2>/dev/null | grep -q ":9050 "; then
            echo -e "  ${BOLD}Tor${RESET}           : ${GREEN}running${RESET}  ${DIM}(SOCKS5 on 9050)${RESET}"
        else
            echo -e "  ${BOLD}Tor${RESET}           : ${YELLOW}service active, port 9050 not yet listening${RESET}"
        fi
    else
        echo -e "  ${BOLD}Tor${RESET}           : ${YELLOW}not running${RESET}  ${DIM}(Tor sends will fail)${RESET}"
    fi

    # fail2ban jail (step 7) — Basic Auth is the whole auth boundary
    if [[ -f "$WW_F2B_JAIL" ]] && systemctl is-active --quiet fail2ban 2>/dev/null; then
        local _banned=""
        _banned=$(fail2ban-client status grin-fidelius-auth 2>/dev/null \
                  | grep -oP 'Currently banned:\s*\K[0-9]+' || true)
        echo -e "  ${BOLD}fail2ban${RESET}      : ${GREEN}active${RESET}  ${DIM}(grin-fidelius-auth, currently banned: ${_banned:-0})${RESET}"
    elif [[ -f "$WW_F2B_JAIL" ]]; then
        echo -e "  ${BOLD}fail2ban${RESET}      : ${YELLOW}jail written, service not running${RESET}  ${DIM}(systemctl start fail2ban)${RESET}"
    else
        echo -e "  ${BOLD}fail2ban${RESET}      : ${YELLOW}no jail${RESET}  ${DIM}(step 7 — Basic Auth is unlimited-guess without it)${RESET}"
    fi

    # Node-secret self-heal (step 3) — without it a node rebuild breaks every wallet
    if systemctl is-active --quiet grin-secret-sync.timer 2>/dev/null; then
        echo -e "  ${BOLD}Secret sync${RESET}   : ${GREEN}timer active${RESET}  ${DIM}(wallets self-heal after a node rebuild)${RESET}"
    else
        echo -e "  ${BOLD}Secret sync${RESET}   : ${YELLOW}not installed${RESET}  ${DIM}(re-run step 3)${RESET}"
    fi

    # Wallets registered
    if [[ -f "$WW_REGISTRY" ]] && command -v jq &>/dev/null; then
        echo ""
        echo -e "  ${BOLD}Wallets registered${RESET}:"
        jq -r '.wallets[]? | "    \(.network)  \(.name)  → owner :\(.ownerPort)  foreign :\(.foreignPort)"' "$WW_REGISTRY" 2>/dev/null \
            || echo "    (none)"
        # Names must be unique across BOTH networks — every route resolves by name
        # alone, so a duplicate means only the first entry is reachable and Delete
        # can destroy the wrong seed. Registration now blocks this; an older
        # registry may already carry one.
        local _dupes=""
        _dupes=$(jq -r '.wallets[]?.name' "$WW_REGISTRY" 2>/dev/null | sort | uniq -d | tr '\n' ' ' || true)
        if [[ -n "${_dupes// /}" ]]; then
            echo ""
            warn "DUPLICATE wallet names: ${_dupes}"
            warn "Only the FIRST entry for each is reachable, and Delete may hit the wrong wallet."
            warn "Rename one side in $WW_REGISTRY and its directory before using them."
        fi
    fi

    echo ""
    [[ -n "$WW_DOMAIN" ]] && echo -e "  URL: ${BOLD}${GREEN}https://$WW_DOMAIN${RESET}"
    echo -e "  Node port      : 127.0.0.1:$WW_NODE_PORT  (Node app, behind nginx)"
    echo -e "  App dir        : $WW_APP_DIR"
    echo -e "  Wallets root   : $WW_ROOT"
    echo -e "  Registry       : $WW_REGISTRY"
    echo ""
    pause
}

# =============================================================================
# STEP 9 — Edit saved settings
# =============================================================================

ww_edit_settings() {
    ww_load_config
    clear
    echo -e "\n${BOLD}${CYAN}── Web Wallet — 9) Edit Saved Settings ──${RESET}\n"
    echo -e "  ${DIM}Press Enter to keep the current value.${RESET}"
    echo ""

    echo -ne "Domain              [${WW_DOMAIN:-}]: "
    read -r v || true
    if [[ -n "$v" ]]; then
        _ww_validate_domain "$v" && WW_DOMAIN="$v" || info "Domain unchanged."
    fi

    echo -ne "Auth username       [${WW_AUTH_USER:-grin}]: "
    read -r v || true
    if [[ -n "$v" ]]; then
        _ww_validate_auth_user "$v" && WW_AUTH_USER="$v" || info "Username unchanged."
    fi

    echo -ne "Let's Encrypt email [${WW_EMAIL:-}]: "
    read -r v || true
    if [[ -n "$v" ]]; then
        _ww_validate_email "$v" && WW_EMAIL="$v" || info "Email unchanged."
    fi

    echo ""
    echo -e "  ${DIM}Server-side idle backstop: zeroes an unlocked wallet's passphrase in${RESET}"
    echo -e "  ${DIM}server.js memory after N minutes with no deliberate action. 0 disables.${RESET}"
    echo -ne "Idle lock (minutes) [${WW_IDLE_LOCK_MINUTES:-60}]: "
    read -r v || true
    if [[ -n "$v" ]]; then
        if [[ "$v" =~ ^[0-9]+$ ]] && (( v <= 10080 )); then
            WW_IDLE_LOCK_MINUTES="$v"
        else
            info "Idle lock unchanged (whole minutes, 0-10080)."
        fi
    fi

    ww_save_config
    ww_save_env
    success "Settings saved → $WW_CONF_FILE  + env → $WW_ENV_FILE"
    info "If grin-fidelius is running it was restarted to pick up env changes."
    pause
}

# =============================================================================
# XP WALLET LAUNCHER (optional — separate fun/nostalgia variant)
# =============================================================================

_launch_xp_wallet() {
    local xp_script="$SCRIPT_DIR/051x_grin_xp_wallet.sh"
    if [[ ! -f "$xp_script" ]]; then
        error "051x_grin_xp_wallet.sh not found in $SCRIPT_DIR"
        pause
        return 1
    fi
    bash "$xp_script"
}

# =============================================================================
# WALLET MENU
# =============================================================================

wallet_menu() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN} 051) FIDELIUS · PERSONAL WEB WALLET  (Node.js)${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        ww_menu_status

        echo -e "${DIM}  ─── First-time setup (run in order) ─────────────${RESET}"
        echo -e "  ${GREEN}1${RESET}) Install grin-wallet binary"
        echo -e "  ${GREEN}2${RESET}) Install dependencies      ${DIM}(nodejs, nginx, certbot, htpasswd, tor, qrencode, jq)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Deploy app + systemd      ${DIM}(web/051_fidelius/ → $WW_APP_DIR)${RESET}"
        echo -e "  ${GREEN}4${RESET}) Configure nginx           ${DIM}(reverse proxy → 127.0.0.1:$WW_NODE_PORT)${RESET}"
        echo -e "  ${GREEN}5${RESET}) Setup SSL                 ${DIM}(Let's Encrypt or Cloudflare Origin)${RESET}"
        echo -e "  ${GREEN}6${RESET}) Setup Basic Auth          ${DIM}(set / change password)${RESET}"
        echo -e "  ${GREEN}7${RESET}) Configure firewall        ${DIM}(open ports 80 + 443)${RESET}"
        echo ""
        echo -e "${DIM}  ─── Info / maintenance ──────────────────────────${RESET}"
        echo -e "  ${CYAN}8${RESET}) Status & info"
        echo -e "  ${CYAN}9${RESET}) Edit saved settings       ${DIM}(domain, email, auth user)${RESET}"
        echo ""
        echo -e "${DIM}  ─── Optional hardening ──────────────────────────${RESET}"
        echo -e "  ${BOLD}${YELLOW}V${RESET}) Private access            ${DIM}(WireGuard tunnel + DNS-01 cert)${RESET}"
        echo ""
        echo -e "  ${BOLD}${YELLOW}xp${RESET}${DIM}) Launch XP Wallet (separate script — mainnet only, real GRIN)${RESET}"
        echo ""
        echo -e "  ${DIM}↩  Press Enter to refresh${RESET}"
        echo -e "  ${RED}0${RESET}) Back to main menu"
        echo ""
        echo -ne "${BOLD}Select [1-9 / V / xp / 0]: ${RESET}"
        read -r choice || true

        case "$choice" in
            1)     ww_install_binary    || true ;;
            2)     ww_install_deps      || true ;;
            3)     ww_deploy_app        || true ;;
            4)     ww_configure_nginx   || true ;;
            5)     ww_setup_ssl         || true ;;
            6)     ww_setup_auth        || true ;;
            7)     ww_configure_firewall|| true ;;
            8)     ww_show_info         || true ;;
            9)     ww_edit_settings     || true ;;
            v|V)   ww_private_access    || true ;;
            xp|XP) _launch_xp_wallet    || true ;;
            0)     break ;;
            "")    continue ;;
            *)     warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# =============================================================================
# MAIN
# =============================================================================

main() {
    wallet_menu
}

main "$@"
