#!/bin/bash
# =============================================================================
# 07_grin_mining_public_pool.sh — Grin Public Mining Pool (GRINIUM)
# =============================================================================
# Part of: Grin Node Toolkit — launched from the mining hub
# (07_grin_mining_hub_services.sh). Deploys GRINIUM, the public PPLNS Grin
# mining pool, on a Debian/Ubuntu/Rocky/Alma VPS. Run as root.
#
# IMPORTANT: A server runs EITHER solo private mining (07_grin_mining_solo.sh)
# OR this public pool — never both. They collide on nginx rate-limit zones and
# the /opt/grin layout. pool_check_exclusivity
# hard-blocks installation if a solo private setup is detected.
#
# Requirements:
#   · A running Grin node (mainnet) with stratum enabled
#   · Nginx + certbot for HTTPS
#   · Tor for anonymous payouts
#   · A grin-wallet running the COMBINED listener (owner_api with
#     owner_api_include_foreign, so Owner+Foreign share port 3420/13420)
#
# ─── Menu ────────────────────────────────────────────────────────────────────
#   G) Guided Full Setup     (1→2→3→4→5→6→7 in sequence)
#   1) Install               (nodejs ≥24 — node:sqlite — npm, sqlite3, systemd,
#                             logrotate, fail2ban)
#   2) Configure             (pool name, domain, fee, wallet dir, stratum port)
#   3) Deploy web files      (frontend → /var/www/grin-pool)
#   4) Setup nginx           (vhost + rate limits + SSL via certbot)
#   5) Set up wallet         (combined coinbase + payout listener, Owner+Foreign 3420)
#   6) Service control       (start / stop / restart)
#   7) Create admin account  (first admin user — needs service running)
#   8) Pool status           (service state, DB size, recent logs)
#   9) Deploy new code       (refresh backend+frontend from checkout; restarts only
#                             the service whose runtime code changed)
#   A) Admin recovery        (locked out: clear 2FA / reset password — break-glass)
#   W) Multi-region          (WireGuard server + add regional gateways)
#   P) Play & chat (games)   (/play/ games service — lib/07_lib_pool_games.sh; never
#                             restarts the pool; design §19 (script07_design_games.md))
#   B) Backup & Restore      (encrypted: DB + wallet + WG identity · offsite push)
#   C) Cron schedules        (daily backup, weekly VACUUM, run VACUUM now)
#   L) View logs             (tail -50 | less)
#   S) Edit config           (manual JSON config edit)
#   DEL) Reset database      (⚠ permanently wipes all data)
#   0) Exit
# Mode-selector menu (before the above): Z) Cleanup public mining pool —
#   removes pool/hub/gateway infra (+ any legacy satellite) for fast rebuild tests;
#   keeps node, wallet seed and backups (mirrors solo cleanup in 07_grin_mining_solo.sh).
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLKIT_ROOT="$(dirname "$SCRIPT_DIR")"

# Everything below writes /opt/grin, /etc/nginx and systemd units — require root
# up front so the first failure isn't a cryptic mkdir/permission error.
[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "ERROR: this script must be run as root (sudo)." >&2; exit 1; }

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# ─── Constants ────────────────────────────────────────────────────────────────
LOG_DIR="/opt/grin/logs"
LOG_FILE="$LOG_DIR/grinium_$(date +%Y%m%d_%H%M%S).log"

POOL_APP_SRC="$TOOLKIT_ROOT/web/07_mining_pool_public/back-end-pool"
POOL_WEB_SRC="$TOOLKIT_ROOT/web/07_mining_pool_public/public_html"
# ─── Network mode (mainnet | testnet) ───────────────────────────────────────────
# Testnet finds blocks fast, so it's the way to exercise the whole block → maturity
# (100 blocks) → reward → payout pipeline. It is a FULLY INDEPENDENT install — its own
# config file, service, dirs, web root, nginx vhost, and ports — so it runs standalone OR
# alongside a mainnet pool on the same box (matching the toolkit's "testnet and mainnet run
# independently on separate ports/dirs" rule). Trigger with the `testnet` launch arg
# (any position), mirroring solo's `lan` arg: `bash 07_grin_mining_public_pool.sh testnet`.
POOL_NET="mainnet"
for _a in "$@"; do [[ "$_a" == "testnet" ]] && POOL_NET="testnet"; done

# "pubpool" family — product-prefixed like solo's /opt/grin/solowallet, so an
# operator can tell at a glance which product owns a dir (renamed 2026-06 from
# the generic grin_pool.json + /opt/grin/pool + /opt/grin/wallet; legacy paths
# are still recognised by Z) Cleanup). Testnet gets the `_testnet`/`-testnet` suffixed
# siblings + Central API port 8090 (vs mainnet 8080) so the two never collide.
if [[ "$POOL_NET" == "testnet" ]]; then
    POOL_CONF="/opt/grin/conf/grin_pubpool_testnet.json"
    POOL_APP_DIR="/opt/grin/pubpool/testnet"
    POOL_WALLET_DIR="/opt/grin/pubpoolwallet/testnet"
    POOL_WEB_DIR="/var/www/grin-pool-testnet"
    POOL_PORT=8090
    POOL_SERVICE="grin-pool-manager-testnet"
    POOL_NGINX_CONF="/etc/nginx/sites-available/grin-public-pool-testnet"
    # Legacy vhost basename (pre-2026-06 rename) — cleaned up on Setup nginx / Cleanup.
    POOL_NGINX_CONF_LEGACY="/etc/nginx/sites-available/grin-pool-testnet"
    POOL_LOG="/opt/grin/logs/grin-pool-testnet.log"
else
    POOL_CONF="/opt/grin/conf/grin_pubpool.json"
    POOL_APP_DIR="/opt/grin/pubpool/mainnet"
    POOL_WALLET_DIR="/opt/grin/pubpoolwallet/mainnet"
    POOL_WEB_DIR="/var/www/grin-pool"
    POOL_PORT=8080
    POOL_SERVICE="grin-pool-manager"
    POOL_NGINX_CONF="/etc/nginx/sites-available/grin-public-pool-mainnet"
    # Legacy vhost basename (pre-2026-06 rename, was the unsuffixed "grin-pool") —
    # cleaned up on Setup nginx / Cleanup so a re-run migrates the old install.
    POOL_NGINX_CONF_LEGACY="/etc/nginx/sites-available/grin-pool"
    POOL_LOG="/opt/grin/logs/grin-pool.log"
fi

# Break-glass admin recovery CLI. Network-suffixed like grin-pool-backup-<net>, because the
# two networks have separate DBs and a single unsuffixed name would silently act on whichever
# config happened to be found.
POOL_ADMIN_RESET_BIN="/usr/local/bin/grin-pool-admin-reset-${POOL_NET}"

# Human-readable network label for menu titles / headers / generated-file comments.
# The dirs/ports/config/service above are ALL network-keyed already — this is purely
# the display string so a testnet run never mislabels itself "Mainnet".
if [[ "$POOL_NET" == "testnet" ]]; then POOL_NET_LABEL="Testnet"; else POOL_NET_LABEL="Mainnet"; fi

# ─── Logging ──────────────────────────────────────────────────────────────────
mkdir -p "$LOG_DIR"
log()     { echo -e "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; log "[INFO] $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; log "[OK] $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; log "[WARN] $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; log "[ERROR] $*"; }

# ─── Source nginx helpers ──────────────────────────────────────────────────────
# Uses the toolkit's shared helper (scripts/lib) — same zones/wrappers as every
# other toolkit script, so rate-limit/conn zones never collide.
# shellcheck source=lib/nginx_shared_helpers.sh
source "$SCRIPT_DIR/lib/nginx_shared_helpers.sh"
# Shared node-secret resolver + self-heal (keeps the pool wallet's
# node_api_secret_path in sync with the live node after a node rebuild).
# shellcheck source=lib/grin_node_secrets.sh
source "$SCRIPT_DIR/lib/grin_node_secrets.sh"

# ─── Source pool wallet lib (combined coinbase + payout, Owner+Foreign 3420) ───
# pw_* functions: install/init the pool wallet, run BOTH listeners, autostart +
# watchdog. Same technique as lib/07_solo_wallet.sh, pool naming/dirs. Resolvers
# read live pool config (grin_wallet_dir / wallet_pass_file) at call time, so
# sourcing here — before pool_read_conf is defined — is safe.
# shellcheck source=lib/07_lib_pool_wallet.sh
source "$SCRIPT_DIR/lib/07_lib_pool_wallet.sh"
# grin-gateway-ctl installer — the single WireGuard mutation path shared by the
# CLI (menu W) and the admin panel (design §13.2).
# shellcheck source=lib/07_lib_gwctl.sh
source "$SCRIPT_DIR/lib/07_lib_gwctl.sh"
# Hub backup/restore on the shared engine (pool.db + config + wallet + WG identity).
# shellcheck source=lib/07_lib_pool_backup.sh
source "$SCRIPT_DIR/lib/07_lib_pool_backup.sh"
# /play/ games service (menu P, design §19 (script07_design_games.md)): its own unit, user and DB beside the pool.
# The backup lib above calls its pgs_* hooks at call time (games DB snapshot + restore).
# shellcheck source=lib/07_lib_pool_games.sh
source "$SCRIPT_DIR/lib/07_lib_pool_games.sh"
# Pool script sections moved out of the entry file (install, nginx, ops, regions, cleanup); each lib needs only the globals above this line.
# shellcheck source=lib/07_lib_pool_install.sh
source "$SCRIPT_DIR/lib/07_lib_pool_install.sh"
# shellcheck source=lib/07_lib_pool_nginx.sh
source "$SCRIPT_DIR/lib/07_lib_pool_nginx.sh"
# shellcheck source=lib/07_lib_pool_ops.sh
source "$SCRIPT_DIR/lib/07_lib_pool_ops.sh"
# shellcheck source=lib/07_lib_pool_regions.sh
source "$SCRIPT_DIR/lib/07_lib_pool_regions.sh"
# shellcheck source=lib/07_lib_pool_cleanup.sh
source "$SCRIPT_DIR/lib/07_lib_pool_cleanup.sh"

# ═══════════════════════════════════════════════════════════════════════════════
# EXCLUSIVITY GUARD — one mining type per server (public XOR solo private)
# ═══════════════════════════════════════════════════════════════════════════════
# Solo private mining (07_grin_mining_solo.sh) and this public pool cannot
# coexist: both write nginx rate-limit zones and both own the /opt/grin layout.
# Detect solo artifacts and hard-block.
pool_check_exclusivity() {
    local solo_markers=(
        "/opt/grin/conf/grin_solo_payment.json"
        "/etc/cron.d/grin-solo-mining-collector"
        "/etc/nginx/grin-solo-stats.htpasswd"
    )
    local found=() m
    for m in "${solo_markers[@]}"; do
        [[ -e "$m" ]] && found+=("$m")
    done
    # /opt/grin/solo-stats counts ONLY when it holds solo collector data — the
    # node-sync watchdog (installed with EVERY node build) kept its
    # node_watchdog_*.json state here (GNK_LEGACY_STATE_DIR in grin_node_keepalive.sh;
    # an un-migrated box may still hold them), which must not hard-block the pool on
    # every plain node box.
    for m in /opt/grin/solo-stats/*; do
        [[ -e "$m" ]] || continue                      # unmatched glob stays literal
        case "$(basename "$m")" in node_watchdog_*.json) continue ;; esac
        found+=("$m")
        break
    done
    if systemctl list-units --type=service --all 2>/dev/null | grep -q 'grin-solo'; then
        found+=("systemd: grin-solo-* service")
    fi

    if [[ ${#found[@]} -gt 0 ]]; then
        echo ""
        error "Solo PRIVATE mining is already set up on this server:"
        local f
        for f in "${found[@]}"; do echo -e "    ${DIM}· $f${RESET}"; done
        echo ""
        warn "Run only ONE mining type per server: solo private OR public — not both."
        warn "They collide on nginx rate-limit zones and the /opt/grin layout."
        warn "Remove the solo private setup first (toolkit"
        warn "Script 7 → Solo private → Danger Zone → C) Clean up solo mining),"
        warn "or deploy this public pool on a separate VPS."
        echo ""
        return 1
    fi
    return 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# CONFIG HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

pool_read_conf() {
    local key="$1" default="${2:-}"
    [[ -f "$POOL_CONF" ]] || { echo "$default"; return; }
    node -e "
try {
  const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  const v = d[process.argv[2]];
  process.stdout.write(v !== undefined ? String(v) : process.argv[3]);
} catch(e) { process.stdout.write(process.argv[3]); }
" "$POOL_CONF" "$key" "$default" 2>/dev/null || echo "$default"
}

pool_write_conf_key() {
    local key="$1" val="$2"
    mkdir -p "$(dirname "$POOL_CONF")"
    node -e "
const fs = require('fs');
const path = process.argv[1];
const key  = process.argv[2];
const val  = process.argv[3];
const NUMS = new Set(['stratum_port','node_api_port','pool_fee_percent','min_withdrawal','withdrawal_fee','service_port','node_stratum_port','fail2ban_maxretry','fail2ban_findtime','fail2ban_bantime','games_port']);
let d = {};
try { d = JSON.parse(fs.readFileSync(path, 'utf8')); } catch(e) {}
d[key] = NUMS.has(key) ? parseFloat(val) : val;
fs.writeFileSync(path, JSON.stringify(d, null, 2));
fs.chmodSync(path, 0o600);
" "$POOL_CONF" "$key" "$val"
}

# ─── The two directories nginx serves straight off disk ───────────────────────
# custom_assets/ (white-label logos, /custom/) and uploads/ (CMS media, /uploads/) are
# served by nginx directly, not through the app, so the nginx user must be able to
# traverse down to them and read the files inside.
#
# ⚠ o+x on the PARENTS, not o+rx (audit §J8-1's shell half). nginx needs *traverse* on
# /opt/grin and on the app directory; it never lists them. `o+rx` also granted `read`,
# which is what let every local account enumerate the app directory — and pool.db sits
# in it. lib/db.js now chmods pool.db/-wal/-shm to 0600 on every start, so the disclosure
# is closed either way; this removes the second half of the pair rather than relying on
# one of them. The two SERVED directories keep o+rx: nginx reads files there by name via
# `alias` + `try_files`, and autoindex is off, so listing is not exposed.
#
# ⚠ Called from BOTH pool_install and pool_setup_nginx (audit §J8-7b). It must not live
# only in the nginx step: Install does `chmod 700 "$POOL_APP_DIR"` — so re-running
# Install (the documented fix for a changed systemd unit) silently took the directory
# back to 700, nginx could no longer traverse it, and every white-label logo and CMS
# image 404'd until an operator happened to re-run 4) Setup nginx. Nothing warned.
#
# ⚠ Do NOT "fix" this by adding UMask=0077 to the service unit — see §J16-12.
pool_ensure_served_dirs() {
    mkdir -p "$POOL_APP_DIR/custom_assets" "$POOL_APP_DIR/uploads" 2>/dev/null \
        || { warn "could not create the served asset directories under $POOL_APP_DIR"; return 1; }
    chmod o+x  /opt/grin "$POOL_APP_DIR" 2>/dev/null || true
    chmod o+rx "$POOL_APP_DIR/custom_assets" "$POOL_APP_DIR/uploads" 2>/dev/null || true
    if id grinpool >/dev/null 2>&1; then
        chown grinpool:grinpool "$POOL_APP_DIR/custom_assets" "$POOL_APP_DIR/uploads" 2>/dev/null || true
    fi
}

# ─── WireGuard prerequisites for the multi-region path (§13.12p) ──────────────
# Two things that MUST exist before the hardened unit starts, both because of the
# service's mount namespace (ProtectSystem=strict):
#   · wireguard-tools — apt cannot run inside the namespace at all (/usr, /var are
#     read-only there), so the package can never be installed from the panel. It is
#     installed here instead, once, at pool install time.
#   · /etc/wireguard — ReadWritePaths is bound when the service STARTS. A directory
#     created afterwards is not writable inside the running service's namespace, so
#     creating it lazily in init-server would work from the CLI and fail from the
#     panel until the next restart.
# Both are cheap no-ops on a box that already has them, and harmless on a
# single-box pool that never goes multi-region (a few hundred KB and an empty dir).
pool_ensure_wg_prereqs() {
    mkdir -p /etc/wireguard 2>/dev/null || warn "Could not create /etc/wireguard — panel gateway pairing will fail."
    chmod 700 /etc/wireguard 2>/dev/null || true
    if command -v wg &>/dev/null && command -v wg-quick &>/dev/null; then
        return 0
    fi
    info "Installing wireguard-tools (needed before the panel can set up multi-region)..."
    if command -v apt-get &>/dev/null; then
        DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=60 install -y wireguard-tools >/dev/null 2>&1 || true
        if ! command -v wg &>/dev/null; then
            apt-get -o DPkg::Lock::Timeout=60 update >/dev/null 2>&1 || true
            DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=60 install -y wireguard-tools >/dev/null 2>&1 || true
        fi
    elif command -v dnf &>/dev/null; then
        dnf install -y wireguard-tools >/dev/null 2>&1 || true
    fi
    if command -v wg &>/dev/null; then
        success "wireguard-tools installed."
    else
        # Not fatal: a single-box pool never needs it, and the CLI can install it
        # later. Only the PANEL's Enable button is lost, so say exactly that.
        warn "Could not install wireguard-tools. Multi-region setup from the admin panel"
        echo -e "  ${DIM}will not work until it is installed; the pool menu W → 1 still can.${RESET}"
    fi
}

pool_ensure_defaults() {
    # Per-network node + stratum defaults. Testnet uses the 13xxx ports (node API 13413,
    # built-in stratum 13416) and a distinct public stratum port (13333) so a testnet pool
    # never clashes with a mainnet one on the same box. node_api_url is written explicitly
    # (the app reads node_api_url, NOT node_api_port) so the pool talks to the right node.
    # node_stratum is Grin's NATIVE default stratum_server_addr port (mainnet 3416 / testnet
    # 13416) — Script 01 enables the node's built-in stratum but leaves the addr at this default,
    # so the pool must dial the same port (the node is not patched).
    local d_network="$POOL_NET" d_node_api d_node_strat d_pub_strat d_node_url
    if [[ "$POOL_NET" == "testnet" ]]; then
        d_node_api="13413"; d_node_strat="13416"; d_pub_strat="13333"; d_node_url="http://127.0.0.1:13413"
    else
        d_node_api="3413";  d_node_strat="3416";  d_pub_strat="3333";  d_node_url="http://127.0.0.1:3413"
    fi
    local -A defaults=(
        ["pool_name"]="My Grin Pool"
        ["subdomain"]=""
        ["network"]="$d_network"
        ["stratum_port"]="$d_pub_strat"
        ["node_api_port"]="$d_node_api"
        ["node_api_url"]="$d_node_url"
        ["node_stratum_port"]="$d_node_strat"
        ["node_stratum_host"]="127.0.0.1"
        ["pool_address"]=""
        # The pool server's own region label. It serves local miners under this
        # region; on startup the app self-registers one pool_locations row for it
        # (→ subdomain:stratum_port) so the central box shows as a real region and
        # auto-joins the connect grid the moment a gateway for another zone forwards
        # shares in — no rebuild. Rename it in admin → Regions.
        ["region"]="main"
        # Human-facing location of this pool server's own region, shown on the public
        # connect card (label + country flag). Most operators sit behind Cloudflare so
        # geo-IP can't infer it — it's captured in 2) Configure and editable in admin →
        # Regions. Empty country/country_code → the card just shows the label, no flag.
        ["region_label"]=""
        ["region_country"]=""
        ["region_country_code"]=""
        ["pool_fee_percent"]="1.0"
        ["min_withdrawal"]="25.0"
        ["withdrawal_fee"]="0.04"
        ["grin_wallet_dir"]="$POOL_WALLET_DIR"
        ["log_path"]="$POOL_LOG"
        ["service_port"]="$POOL_PORT"
        ["db_path"]="$POOL_APP_DIR/pool.db"
        ["wallet_pass_file"]="$POOL_APP_DIR/.wallet_pass"
        ["assets_dir"]="$POOL_APP_DIR/custom_assets"
        # nginx docroot. The app reads post.html / page.html from here to render the
        # <head> of blog + CMS permalinks server-side (social crawlers don't run JS).
        # config.js falls back to the per-network default if this key is absent, so an
        # existing pool.json keeps working; setting it explicitly is the reliable path.
        ["web_dir"]="$POOL_WEB_DIR"
        # fail2ban jail thresholds. 10 failed admin logins within 15 min → 10-day firewall
        # ban. Values are SECONDS, not fail2ban's "10d" shorthand: pool_setup_fail2ban
        # validates them with ^[0-9]+$ and silently falls back to the safe defaults on
        # anything else, so a suffixed value would quietly become 1 hour.
        # maxretry/findtime deliberately MATCH the app-layer auto-ban (index.js
        # ADMIN_LOGIN_FAIL_THRESHOLD / _WINDOW_MS) so the two layers state one rule instead
        # of the firewall firing at 5 while the app claims 10. Only the DURATION differs:
        # this ban persists in the firewall, the app's is a 1 h in-memory cooldown.
        ["fail2ban_maxretry"]="10"
        ["fail2ban_findtime"]="900"
        ["fail2ban_bantime"]="864000"
        # Admin panel access control: comma/space-separated IPs/CIDRs allowed to reach
        # /admin and /api/admin at the nginx layer. Empty = OPEN to all (testing default —
        # app-layer JWT + captcha + lockout + auto-ban + TOTP still apply). Set IPs/CIDRs
        # here to harden once you have adoption, then re-run 4) Setup nginx.
        ["admin_allowlist"]=""
    )
    for k in "${!defaults[@]}"; do
        local existing; existing=$(pool_read_conf "$k" "__MISSING__")
        # if-form, NOT `[[ … ]] && cmd`: this is the loop's last command and the loop is
        # the function's last statement, so a false test would make the whole function
        # return 1. Under `set -euo pipefail` both callers (pool_install, pool_configure)
        # invoke it unguarded, so that killed the script on every re-run — the very case
        # where all keys already exist and the final test is false.
        if [[ "$existing" == "__MISSING__" ]]; then
            pool_write_conf_key "$k" "${defaults[$k]}"
        fi
    done
}

# Scalar SELECT against the pool DB via node:sqlite — the pool's own engine, so
# it is always present (Node 24+ is an install prerequisite). Do NOT use the
# sqlite3 CLI for probes: it is optional (RHEL names the package `sqlite`, and
# a failed install is masked by the `| tail` pipe), and a missing CLI must not
# make status checks lie. Prints the first column of the first row; empty on error.
_pool_db_scalar() { # <sql> [db_path]
    local db="${2:-$POOL_APP_DIR/pool.db}"
    [[ -f "$db" ]] || return 1
    # readOnly (audit §J16-8): this runs as ROOT, on every menu render (_pool_step_mark 7),
    # against a database the de-rooted service owns. DatabaseSync opens read-write by
    # default, and a read-write open of a WAL database CREATES pool.db-wal / -shm when they
    # are absent — root-owned, 0644 — which is how a stopped service comes back to "attempt
    # to write a readonly database" after nothing but a menu being drawn. Its sibling at the
    # region-card INSERT chowns them back afterwards; this one, which fires far more often,
    # never did. A read-only open has no business creating either file, so the repair is to
    # stop asking for write access rather than to add another chown.
    node -e "
try {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(process.argv[1], { readOnly: true });
  const row = d.prepare(process.argv[2]).get();
  process.stdout.write(String(row ? Object.values(row)[0] : ''));
} catch (e) { process.exit(1); }
" "$db" "$1" 2>/dev/null
}

# ─── Per-step completion probes ────────────────────────────────────────────────
# Used by the menus (✓ markers next to setup steps 1–7) and by the guided flow,
# which offers to skip already-completed steps — so re-running G) after a
# mid-flow abort resumes instead of redoing everything. Probes check the
# artifacts each step leaves behind, not a recorded state, so they stay correct
# even after manual runs or a partial cleanup.
_pool_step_done() {
    case "$1" in
        1) [[ -f "/etc/systemd/system/$POOL_SERVICE.service" \
              && -f "$POOL_APP_DIR/index.js" && -d "$POOL_APP_DIR/node_modules" ]] ;;
        2) [[ -n "$(pool_read_conf "subdomain" "")" ]] ;;
        3) [[ -f "$POOL_WEB_DIR/index.html" && -f "$POOL_WEB_DIR/js/pool-config.js" ]] ;;
        4) # listen 443 distinguishes the finished SSL vhost from the HTTP-only
           # certbot bootstrap (operator declined/failed certbot mid-step).
           [[ -f "$POOL_NGINX_CONF" ]] && grep -q "listen 443" "$POOL_NGINX_CONF" 2>/dev/null ;;
        5) [[ -x "$(pw_bin)" && -f "$(pw_toml)" && -f "$(pw_pass_file)" ]] ;;
        6) systemctl is-active --quiet "$POOL_SERVICE" 2>/dev/null ;;
        7) [[ "$(_pool_db_scalar "SELECT COUNT(*) FROM users WHERE is_admin=1" || echo 0)" == [1-9]* ]] ;;
        *) return 1 ;;
    esac
}

_pool_step_mark() {
    if _pool_step_done "$1"; then echo -e "${GREEN}✓${RESET}"; else echo -e "${DIM}·${RESET}"; fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# 8) POOL STATUS
# ═══════════════════════════════════════════════════════════════════════════════

pool_show_status() {
    echo -e "\n${BOLD}Pool Manager — ${POOL_NET_LABEL}${RESET}"
    echo -e "${DIM}────────────────────────────────────────────────${RESET}"

    if systemctl is-active --quiet "$POOL_SERVICE" 2>/dev/null; then
        local pid; pid=$(systemctl show "$POOL_SERVICE" --property=MainPID --value 2>/dev/null || echo "?")
        echo -e "  ${BOLD}Service${RESET}  : ${GREEN}● active${RESET}  (pid $pid)"
    elif systemctl is-enabled --quiet "$POOL_SERVICE" 2>/dev/null; then
        echo -e "  ${BOLD}Service${RESET}  : ${YELLOW}installed, stopped${RESET}"
    else
        echo -e "  ${BOLD}Service${RESET}  : ${DIM}not installed${RESET}"
    fi

    local port; port=$(pool_read_conf "service_port" "$POOL_PORT")
    if ss -tlnp 2>/dev/null | grep -q ":$port "; then
        echo -e "  ${BOLD}Port${RESET}     : ${GREEN}$port listening${RESET}"
    else
        echo -e "  ${BOLD}Port${RESET}     : ${DIM}$port — not listening${RESET}"
    fi

    [[ -f "$POOL_APP_DIR/pool.db" ]] && {
        local dbsz; dbsz=$(du -sh "$POOL_APP_DIR/pool.db" 2>/dev/null | cut -f1 || echo "?")
        echo -e "  ${BOLD}Database${RESET} : $POOL_APP_DIR/pool.db  ($dbsz)"
    }

    local subdomain; subdomain=$(pool_read_conf "subdomain" "")
    [[ -n "$subdomain" ]] && echo -e "  ${BOLD}URL${RESET}      : https://$subdomain"

    if [[ -f "$POOL_LOG" ]]; then
        echo -e "\n${DIM}── Recent activity (last 15 lines) ──${RESET}"
        tail -n 15 "$POOL_LOG" 2>/dev/null | sed 's/^/  /'
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# B) BACKUP & RESTORE — lib/07_lib_pool_backup.sh (shared gbe_*/gbp_* engine)
# ═══════════════════════════════════════════════════════════════════════════════
# The hub holds money-grade state (pool.db balances, wallet seed, WG identity) —
# it uses the same encrypted-archive engine as solo/drop (design §13.10c).
# pbk_* functions come from the sourced lib; the old plain pool_backup tar
# (pool_backup_YYYYMMDD_*.tar.gz, DB+conf only, unencrypted) is superseded.

# Pause helper for one-shot submenus that perform an action: keeps their success
# output on screen. Submenus call this only after a real action (never on Back),
# so the main loop excludes them from its own pause — no double prompt.
_pool_pause() { echo ""; echo "Press Enter to continue..."; read -r; }

# ═══════════════════════════════════════════════════════════════════════════════
# STATUS LINE helper
# ═══════════════════════════════════════════════════════════════════════════════

_pool_menu_status_line() {
    if systemctl is-active --quiet "$POOL_SERVICE" 2>/dev/null; then
        echo -e "${GREEN}● running${RESET}"
    elif [[ -f "$POOL_CONF" ]]; then
        echo -e "${YELLOW}installed, stopped${RESET}"
    else
        echo -e "${DIM}not installed${RESET}"
    fi
}

show_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  GRINIUM — Grin Public Mining Pool ($([[ "$POOL_NET" == testnet ]] && echo TESTNET || echo Mainnet))${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Service: $(_pool_menu_status_line)"
    echo ""
    echo -e "${DIM}  ─── First-Time Setup ────────────────────────────${RESET}"
    echo -e "  ${GREEN}G${RESET}) Guided Full Setup    ${DIM}(runs all setup steps 1→7)${RESET}"
    echo ""
    echo -e "${DIM}  ─── Manual Setup Steps ───────────────────────────${RESET}"
    echo -e "  ${GREEN}1${RESET}) $(_pool_step_mark 1) Install             ${DIM}(nodejs ≥24, npm, sqlite3, systemd, fail2ban)${RESET}"
    echo -e "  ${GREEN}2${RESET}) $(_pool_step_mark 2) Configure           ${DIM}(pool name, domain, fee, stratum port)${RESET}"
    echo -e "  ${GREEN}3${RESET}) $(_pool_step_mark 3) Deploy web files    ${DIM}(frontend → $POOL_WEB_DIR)${RESET}"
    echo -e "  ${GREEN}4${RESET}) $(_pool_step_mark 4) Setup nginx         ${DIM}(vhost + SSL + rate limits)${RESET}"
    echo -e "  ${GREEN}5${RESET}) $(_pool_step_mark 5) Set up wallet       ${DIM}(combined coinbase + payout, Owner+Foreign ${PW_OWNER_PORT})${RESET}"
    echo -e "  ${GREEN}6${RESET}) $(_pool_step_mark 6) Service control     ${DIM}(start / stop — start before creating admin)${RESET}"
    echo -e "  ${GREEN}7${RESET}) $(_pool_step_mark 7) Create admin account ${DIM}(first admin user — needs service running)${RESET}"
    echo ""
    echo -e "${DIM}  ─── Administration ───────────────────────────────${RESET}"
    echo -e "  ${GREEN}8${RESET}) Pool status           ${DIM}(service, port, DB, recent logs)${RESET}"
    echo -e "  ${GREEN}9${RESET}) Deploy new code       ${DIM}(refresh from checkout · restarts only what changed)${RESET}"
    echo -e "  ${GREEN}A${RESET}) Admin recovery        ${DIM}(locked out: clear 2FA / reset password — break-glass)${RESET}"
    echo -e "  ${GREEN}W${RESET}) Multi-region          ${DIM}(WireGuard server + add regional gateways)${RESET}"
    echo -e "  ${GREEN}P${RESET}) Play & chat (games)   ${DIM}(/play/ service: $(_pgs_menu_state)${DIM} · never restarts the pool)${RESET}"
    echo -e "  ${GREEN}B${RESET}) Backup & Restore      ${DIM}(encrypted: DB + wallet + WG identity · offsite push)${RESET}"
    echo -e "  ${GREEN}C${RESET}) Cron tasks            ${DIM}(backup schedule, VACUUM)${RESET}"
    echo -e "  ${GREEN}L${RESET}) View logs             ${DIM}(tail -50 | less)${RESET}"
    echo -e "  ${GREEN}S${RESET}) Edit config           ${DIM}(${POOL_CONF})${RESET}"
    echo ""
    echo -e "${DIM}  ─── Danger Zone ──────────────────────────────────${RESET}"
    echo -e "  ${RED}DEL${RESET}) Reset database    ${DIM}(⚠ permanently wipes all data)${RESET}"
    echo ""
    echo -e "  ${RED}0${RESET}) Back to deployment mode menu"
    echo ""
    echo -ne "${BOLD}Select: ${RESET}"
}

pool_singlebox_loop() {
    while true; do
        show_menu
        read -r choice

        # Every dispatch is ||-guarded: a step that returns non-zero must bring
        # the operator back to this menu, not kill the script via set -e.
        case "${choice,,}" in
            "")    continue ;;
            g)     pool_guided_setup || true ;;
            1)     pool_install || true ;;
            2)     pool_configure || true ;;
            3)     pool_deploy_web || true ;;
            4)     pool_setup_nginx || true ;;
            5)     pool_wallet_menu || true ;;
            6)     pool_service_menu || true ;;
            7)     pool_setup_admin || true ;;
            8)     pool_show_status || true ;;
            9)     pool_deploy_code || true ;;
            a)     pool_admin_recovery_menu || true ;;
            w)     pool_wireguard_menu || true ;;
            p)     pool_games_menu || true ;;
            b)     pool_backup_menu || true ;;
            c)     pool_cron_schedules || true ;;
            l)     pool_view_logs || true ;;
            s)     ${EDITOR:-nano} "$POOL_CONF" || true ;;
            del)   pool_reset_db || true ;;
            0|q|exit) break ;;
            *)     warn "Invalid option." ; sleep 1 ; continue ;;
        esac

        # Pause so action output stays readable before the menu redraws.
        # Skipped for: l (pager) / s (editor) — they hold their own screen — and
        # the submenus 5/6/b/c/p/w, which self-manage feedback and return on their own
        # 0) Back. Without this, picking 0 inside a submenu would trigger a second,
        # redundant "Press Enter" here even though nothing new was shown.
        case "${choice,,}" in
            l|s|5|6|a|b|c|p|w) ;;
            *) echo ""; echo "Press Enter to continue..."; read -r ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# DEPLOYMENT MODE SELECTOR (multi-region split)
# ═══════════════════════════════════════════════════════════════════════════════
# Two deployment directions (Model C) — see docs/reference/script07_design.md §3:
#   singlebox — the pool: brain (API/DB/web/admin/wallet) + a co-located local stratum.
#               Already a full hub, so it accepts regional gateways later with no rebuild.
#   hub       — Central Hub only (brain, no local stratum); all mining is via gateways.
# Regional GATEWAYS are NOT a pool-app role — they run no Node process (HAProxy + WireGuard,
# see lib/07_lib_gateway.sh) and are launched via the `gateway` arg / menu option 2.
# Mode may be passed as $1 (singlebox|hub|gateway) for non-interactive launches.
POOL_MODE=""

# ─── Install-footprint detectors (collision guard) ──────────────────────────────
# Single-server pool and Central Hub share the same "brain" footprint
# ($POOL_CONF + $POOL_SERVICE); a Gateway has its own (grin_gateway.json + grin-gateway).
# Co-locating a brain and a gateway on one box collides on stratum 3333, so we refuse at
# selection time and point the operator at cleanup. pool_satellite_installed detects a
# LEGACY satellite install (role removed in the Model C refactor) so cleanup can still find it.
pool_brain_installed() {
    [[ -f "$POOL_CONF" ]] && return 0
    systemctl list-unit-files 2>/dev/null | grep -q "^${POOL_SERVICE}\.service" && return 0
    return 1
}
pool_satellite_installed() {
    [[ -f "/opt/grin/conf/grin_satellite.json" ]] && return 0
    systemctl list-unit-files 2>/dev/null | grep -q "^grin-satellite\.service" && return 0
    return 1
}
pool_gateway_installed() {
    [[ -f "/opt/grin/conf/grin_gateway.json" ]] && return 0
    systemctl list-unit-files 2>/dev/null | grep -q "^grin-gateway\.service" && return 0
    return 1
}

# Returns 0 if the chosen mode is safe to install on this box; 1 (with guidance)
# if it would collide with an existing install of another kind. The brain
# (singlebox/hub) and a gateway collide on stratum :3333 — one mining role per box.
# (A legacy satellite, if present, also collides and is detected the same way.)
pool_mode_conflict_check() {
    case "$1" in
        singlebox|hub)
            if pool_gateway_installed; then
                echo ""
                warn "A Regional Gateway install was detected on this server:"
                echo -e "    config:  /opt/grin/conf/grin_gateway.json"
                echo -e "    service: grin-gateway"
                echo -e "  ${DIM}Single-server / Central Hub bind stratum :3333, which the Gateway uses.${RESET}"
                echo -e "  ${BOLD}Clean up the Gateway first${RESET} (mode menu → Z) Cleanup), then re-run."
                return 1
            fi
            if pool_satellite_installed; then
                echo ""
                warn "A legacy Satellite install was detected on this server:"
                echo -e "    config:  /opt/grin/conf/grin_satellite.json"
                echo -e "    service: grin-satellite"
                echo -e "  ${DIM}The satellite role was replaced by Regional Gateways (Model C).${RESET}"
                echo -e "  ${BOLD}Clean up the legacy Satellite first${RESET} (mode menu → Z) Cleanup), then re-run."
                return 1
            fi
            ;;
        gateway)
            if pool_brain_installed; then
                echo ""
                warn "An existing pool / Central Hub install was detected on this server:"
                echo -e "    config:  $POOL_CONF"
                echo -e "    service: $POOL_SERVICE"
                echo -e "  ${DIM}A gateway binds stratum :3333, which this install already uses${RESET}"
                echo -e "  ${DIM}(plus node upstream 3416 / Central API 8080) — both on one box collides.${RESET}"
                echo -e "  ${BOLD}Clean up the public pool config first${RESET} (mode menu → Z) Cleanup), then re-run."
                return 1
            fi
            # A legacy satellite would also collide (both bind :3333).
            if pool_satellite_installed; then
                echo ""
                warn "A legacy Satellite install already occupies this box (both bind :3333)."
                echo -e "  ${BOLD}Clean it up first${RESET} (mode menu → Z) Cleanup), then re-run."
                return 1
            fi
            ;;
    esac
    return 0
}

pool_select_mode() {
    local arg="${1:-}"
    case "$arg" in
        singlebox|hub|gateway)
            POOL_MODE="$arg"
            pool_mode_conflict_check "$arg" || POOL_MODE=""
            return
            ;;
    esac

    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Public Mining Pool Deployment Mode — ${POOL_NET_LABEL}${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        if [[ "$POOL_NET" == "testnet" ]]; then
            echo -e "  ${YELLOW}● TESTNET${RESET} ${DIM}— independent install (8090 / tgrin wallet / testnet node).${RESET}"
            echo -e "  ${DIM}  Fast blocks for testing the full pipeline. Needs a testnet grin node.${RESET}"
        else
            echo -e "  ${GREEN}● MAINNET${RESET} ${DIM}— real GRIN (8080 / grin1 wallet / mainnet node). Live funds.${RESET}"
        fi
        echo ""
        echo -e "  ${BOLD}What are you installing?${RESET}"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Pool server      ${DIM}The pool itself — runs everything.${RESET} ${BOLD}Start here.${RESET}"
        echo -e "                     ${DIM}Serves local miners as region \"main\"; accepts${RESET}"
        echo -e "                     ${DIM}regional gateways from other zones later — no rebuild.${RESET}"
        echo ""
        echo -e "  ${GREEN}2${RESET}) Regional gateway ${DIM}A thin stratum forwarder on ANOTHER box: no node,${RESET}"
        echo -e "                     ${DIM}no wallet — tunnels miners to your pool server (Model C).${RESET}"
        echo ""
        echo -e "  ${RED}Z${RESET}) Cleanup public pool  ${DIM}(remove pool/hub/gateway infra · keeps node + wallet + backups)${RESET}"
        echo -e "  ${RED}0${RESET}) Back to mining hub"
        echo ""
        echo -e "  ${DIM}Run a Gateway on a DIFFERENT box from the pool server (they share${RESET}"
        echo -e "  ${DIM}port 3333). Advanced — a mining-less central hub:${RESET}"
        echo -e "  ${DIM}\`bash 07_grin_mining_public_pool.sh hub\`.${RESET}"
        echo ""
        echo -ne "${BOLD}Select: ${RESET}"
        read -r m

        local chosen=""
        case "$m" in
            1) chosen="singlebox" ;;
            2) chosen="gateway" ;;
            z|Z) pool_cleanup || true
                 echo ""
                 echo "Press Enter to return to the menu..."
                 read -r
                 continue ;;
            0|q|exit) POOL_MODE=""; return ;;
            *) warn "Invalid option."; sleep 1; continue ;;
        esac

        if pool_mode_conflict_check "$chosen"; then
            POOL_MODE="$chosen"
            return
        fi
        echo ""
        echo "Press Enter to return to the menu..."
        read -r
    done
}

main() {
    # Launch args may carry a NETWORK selector (`testnet`, handled globally via POOL_NET)
    # and/or a real deployment-MODE arg (singlebox|hub|gateway). Only a true mode arg means
    # "non-interactive: run that one mode and exit". `testnet` ALONE is NOT a mode — it still
    # shows the interactive mode selector, so 0) Back from a mode menu must return to that
    # selector (one level up), NOT skip it and exit to the mining hub. So derive `arg` from a
    # real mode token only; `testnet`/other tokens leave it empty → interactive + loop-back.
    local arg="" _a
    for _a in "$@"; do
        case "$_a" in
            singlebox|hub|gateway) arg="$_a" ;;
        esac
    done
    # Loop so leaving a mode menu (0) returns here, to the deployment-mode
    # selector — only the selector's own 0 exits the script back to the mining
    # hub. A direct mode arg (non-interactive entry) runs that mode once and exits.
    while true; do
        POOL_MODE=""
        pool_select_mode "$arg"
        case "$POOL_MODE" in
            singlebox)
                pool_singlebox_loop
                ;;
            hub)
                # shellcheck source=lib/07_lib_hub.sh
                source "$SCRIPT_DIR/lib/07_lib_hub.sh"
                pool_hub_loop
                ;;
            gateway)
                # shellcheck source=lib/07_lib_gateway.sh
                source "$SCRIPT_DIR/lib/07_lib_gateway.sh"
                pool_gateway_loop
                ;;
            *)
                info "No mode selected — returning to mining hub."
                return 0
                ;;
        esac
        [[ -n "$arg" ]] && return 0
    done
}

main "$@"
