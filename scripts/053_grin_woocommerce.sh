#!/bin/bash
# =============================================================================
# 053_grin_woocommerce.sh — Grin WooCommerce Payment Gateway
# =============================================================================
#
#  Installs and manages a Grin payment gateway for WordPress + WooCommerce.
#
#  Components:
#    • grin-wallet-bridge.py  — stateless Flask bridge that proxies calls from
#      the PHP WooCommerce plugin to the local grin-wallet CLI.
#      Listens on 127.0.0.1 only — nginx is NOT used (internal only).
#    • WooCommerce plugin     — PHP plugin in web/053_woocommerce/plugin/
#      Handles the slatepack invoice flow inside the WP checkout.
#
#  Mainnet bridge port : 3006  (/opt/grin/woocommerce/mainnet/)
#  Testnet bridge port : 3007  (/opt/grin/woocommerce/testnet/)
#
#  ─── Network Selection ───────────────────────────────────────────────────────
#   1) Mainnet  (real GRIN — confirmation required)
#   2) Testnet  (tGRIN — for testing)
#
#  ─── Menu ────────────────────────────────────────────────────────────────────
#   1) Install bridge      (Python venv + Flask + systemd)
#   2) Install WP plugin   (copy plugin to WordPress plugins directory)
#   3) Configure           (wallet path, bridge port, expiry, WP dir)
#   4) Start / Stop bridge (systemd grin-woo-bridge-{main,test})
#   5) Status
#   0) Back to network select
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
LOG_FILE="$LOG_DIR/grin_woocommerce_$(date +%Y%m%d_%H%M%S).log"
mkdir -p "$LOG_DIR" 2>/dev/null || true
log()     { echo -e "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; log "[INFO] $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; log "[OK] $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; log "[WARN] $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; log "[ERROR] $*"; }
die()     { error "$*"; return 1; }
pause()   { echo ""; echo -e "${DIM}Press Enter to continue...${RESET}"; read -r || true; }

# ─── Network-specific constants ───────────────────────────────────────────────
WOO_NETWORK=""
WOO_NET_FLAG=""
WOO_NET_LABEL=""
WOO_APP_DIR=""
WOO_CONF=""
WOO_BRIDGE_PORT=""
WOO_SERVICE=""
WOO_LOG=""

WOO_PLUGIN_SRC="$TOOLKIT_ROOT/web/053_woocommerce/plugin"

# =============================================================================
# NETWORK SELECTION
# =============================================================================

select_network() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 053) GRIN WOOCOMMERCE${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    local main_st test_st
    systemctl is-active --quiet "grin-woo-bridge-main" 2>/dev/null \
        && main_st="${GREEN}running${RESET}" || main_st="${DIM}not running${RESET}"
    systemctl is-active --quiet "grin-woo-bridge-test" 2>/dev/null \
        && test_st="${GREEN}running${RESET}" || test_st="${DIM}not running${RESET}"

    echo -e "  ${GREEN}1${RESET}) Mainnet  ${RED}⚠ real GRIN${RESET}  bridge: $main_st  ${DIM}(port 3006)${RESET}"
    echo -e "  ${YELLOW}2${RESET}) Testnet  ${DIM}tGRIN — for testing  bridge: $test_st  (port 3007)${RESET}"
    echo ""
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -ne "${BOLD}Select [1/2/0]: ${RESET}"
    local sel
    read -r sel || true
    case "$sel" in
        1) _confirm_mainnet || return 1 ;;
        2) _set_network testnet ;;
        0) return 1 ;;
        *) warn "Invalid option."; return 1 ;;
    esac
    return 0
}

_confirm_mainnet() {
    clear
    echo -e "\n${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${RED} ⚠  MAINNET — REAL GRIN${RESET}"
    echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Mainnet WooCommerce processes ${BOLD}real GRIN payments${RESET}."
    echo -e "  ${RED}Mistakes cannot be reversed.${RESET}"
    echo ""
    echo -ne "  Type ${BOLD}MAINNET${RESET} to confirm, or press Enter to cancel: "
    local confirm
    read -r confirm || true
    if [[ "$confirm" != "MAINNET" ]]; then
        info "Cancelled."; return 1
    fi
    _set_network mainnet
    return 0
}

_set_network() {
    WOO_NETWORK="$1"
    if [[ "$WOO_NETWORK" == "mainnet" ]]; then
        WOO_NET_FLAG=""
        WOO_NET_LABEL="MAINNET"
        WOO_APP_DIR="/opt/grin/woocommerce/mainnet"
        WOO_CONF="/opt/grin/woocommerce/mainnet/bridge.conf"
        WOO_BRIDGE_PORT="3006"
        WOO_SERVICE="grin-woo-bridge-main"
        WOO_LOG="/opt/grin/woocommerce/mainnet/bridge.log"
    else
        WOO_NET_FLAG="--testnet"
        WOO_NET_LABEL="TESTNET"
        WOO_APP_DIR="/opt/grin/woocommerce/testnet"
        WOO_CONF="/opt/grin/woocommerce/testnet/bridge.conf"
        WOO_BRIDGE_PORT="3007"
        WOO_SERVICE="grin-woo-bridge-test"
        WOO_LOG="/opt/grin/woocommerce/testnet/bridge.log"
    fi
}

# =============================================================================
# CONFIG HELPERS
# =============================================================================

woo_load_conf() {
    WOO_WALLET_DIR=""
    WOO_WALLET_PASS=""
    WOO_EXPIRY_MIN="30"
    WOO_WP_DIR="/var/www/html"
    if [[ -f "$WOO_CONF" ]]; then
        # shellcheck disable=SC1090
        source "$WOO_CONF" 2>/dev/null || true
    fi
}

woo_save_conf() {
    mkdir -p "$(dirname "$WOO_CONF")"
    cat > "$WOO_CONF" << CONF
WOO_WALLET_DIR="${WOO_WALLET_DIR:-}"
WOO_EXPIRY_MIN="${WOO_EXPIRY_MIN:-30}"
WOO_WP_DIR="${WOO_WP_DIR:-/var/www/html}"
CONF
    chmod 600 "$WOO_CONF"
}

# =============================================================================
# MENU STATUS
# =============================================================================

woo_menu_status() {
    woo_load_conf
    echo ""

    [[ -d "$WOO_APP_DIR/venv" ]] \
        && echo -e "  ${BOLD}1 Bridge venv${RESET}: ${GREEN}installed${RESET}  ${DIM}($WOO_APP_DIR)${RESET}" \
        || echo -e "  ${BOLD}1 Bridge venv${RESET}: ${DIM}not installed${RESET}  ${DIM}→ step 1${RESET}"

    if [[ -n "$WOO_WP_DIR" && -d "$WOO_WP_DIR/wp-content/plugins/grin-payment" ]]; then
        echo -e "  ${BOLD}2 WP plugin${RESET}  : ${GREEN}installed${RESET}  ${DIM}($WOO_WP_DIR/wp-content/plugins/grin-payment)${RESET}"
    else
        echo -e "  ${BOLD}2 WP plugin${RESET}  : ${DIM}not installed${RESET}  ${DIM}→ step 2${RESET}"
    fi

    [[ -f "$WOO_CONF" ]] \
        && echo -e "  ${BOLD}3 Config${RESET}     : ${GREEN}saved${RESET}  ${DIM}($WOO_CONF)${RESET}" \
        || echo -e "  ${BOLD}3 Config${RESET}     : ${DIM}not configured${RESET}  ${DIM}→ step 3${RESET}"

    if systemctl is-active --quiet "$WOO_SERVICE" 2>/dev/null; then
        echo -e "  ${BOLD}4 Bridge${RESET}     : ${GREEN}● running${RESET}  ${DIM}(port $WOO_BRIDGE_PORT, localhost only)${RESET}"
    elif systemctl is-enabled --quiet "$WOO_SERVICE" 2>/dev/null; then
        echo -e "  ${BOLD}4 Bridge${RESET}     : ${YELLOW}stopped (enabled)${RESET}"
    else
        echo -e "  ${BOLD}4 Bridge${RESET}     : ${DIM}not running${RESET}"
    fi
    echo ""
}

# =============================================================================
# OPTION 1 — Install bridge
# =============================================================================

woo_install_bridge() {
    clear
    echo -e "\n${BOLD}${CYAN}── WooCommerce [$WOO_NET_LABEL] — 1) Install Bridge ──${RESET}\n"
    echo -e "  ${DIM}Installs Python venv + Flask + creates the grin-wallet bridge service.${RESET}\n"

    local bridge_src="$TOOLKIT_ROOT/web/053_woocommerce/bridge"

    if ! command -v python3 &>/dev/null; then
        info "python3 not found. Installing..."
        apt-get install -y python3 python3-pip python3-venv \
            || { die "apt-get failed. Run as root."; pause; return; }
    fi
    success "python3 $(python3 --version 2>&1 | awk '{print $2}') found."

    mkdir -p "$WOO_APP_DIR"

    if [[ -d "$bridge_src" ]]; then
        info "Copying bridge files from $bridge_src ..."
        cp -r "$bridge_src"/. "$WOO_APP_DIR/"
    else
        warn "Bridge source not found at $bridge_src"
        warn "Creating a placeholder bridge — replace with the real bridge script."
        cat > "$WOO_APP_DIR/grin_wallet_bridge.py" << 'BRIDGE'
"""
grin_wallet_bridge.py — Grin Wallet Bridge for WooCommerce
===========================================================
Stateless Flask bridge: proxies WooCommerce plugin calls to local grin-wallet CLI.
Listens on 127.0.0.1 only (not publicly exposed).

Endpoints:
  GET  /api/status          wallet balance + info
  POST /api/init_send       {recipient, amount} → {slatepack, tx_id}
  POST /api/finalize        {response_slate} → {tx_id}
  GET  /api/address         wallet slatepack address

Config read from environment:
  BRIDGE_CONF   — path to bridge.conf (sourced as shell vars)
"""
import os, subprocess, re, json
from flask import Flask, jsonify, request

app = Flask(__name__)

def _cfg():
    conf = os.environ.get("BRIDGE_CONF", "")
    d = {"wallet_dir": "", "expiry_min": "30", "net_flag": ""}
    if conf and os.path.isfile(conf):
        for line in open(conf):
            if "=" in line:
                k, _, v = line.strip().partition("=")
                d[k.strip().lower().replace("woo_", "")] = v.strip().strip('"')
    return d

def _bin(cfg):
    return os.path.join(cfg.get("wallet_dir", ""), "grin-wallet")

def _pass(cfg):
    pp = os.path.join(cfg.get("wallet_dir", ""), ".wallet_pass")
    return open(pp).read().strip() if os.path.isfile(pp) else ""

def _run(cmd, cwd, timeout=90):
    return subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, timeout=timeout)

@app.get("/api/status")
def api_status():
    cfg = _cfg()
    cmd = [_bin(cfg)] + (["--testnet"] if cfg.get("net_flag") else []) + ["-p", _pass(cfg), "info", "--output-format", "json"]
    r = _run(cmd, cfg.get("wallet_dir", "/tmp"))
    if r.returncode != 0:
        return jsonify({"error": r.stderr.strip()}), 500
    try:
        data = json.loads(r.stdout)
        nano = int(data.get("amount_currently_spendable", 0))
        return jsonify({"balance": nano / 1_000_000_000, "network": cfg.get("net_flag", "mainnet")})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.post("/api/init_send")
def api_init_send():
    cfg = _cfg()
    body = request.get_json(silent=True) or {}
    recipient = body.get("recipient", "")
    amount = str(body.get("amount", ""))
    if not recipient or not amount:
        return jsonify({"error": "recipient and amount required"}), 400
    cmd = [_bin(cfg)] + (["--testnet"] if cfg.get("net_flag") else []) + \
          ["-p", _pass(cfg), "send", "-d", recipient, "-a", amount]
    r = _run(cmd, cfg.get("wallet_dir", "/tmp"), timeout=120)
    if r.returncode != 0:
        return jsonify({"error": r.stderr.strip()}), 500
    out = r.stdout
    start = out.find("BEGINSLATEPACK")
    end = out.find("ENDSLATEPACK")
    if start == -1 or end == -1:
        return jsonify({"error": "No slatepack in output"}), 500
    slatepack = out[start:end + len("ENDSLATEPACK")].strip()
    tx_id = ""
    m = re.search(r"[Tt]x [Ss]late [Ii][Dd]:\s*([0-9a-f-]{36})", out)
    if m:
        tx_id = m.group(1)
    return jsonify({"slatepack": slatepack, "tx_id": tx_id})

@app.post("/api/finalize")
def api_finalize():
    cfg = _cfg()
    body = request.get_json(silent=True) or {}
    response_slate = (body.get("response_slate") or "").strip()
    if not response_slate:
        return jsonify({"error": "response_slate required"}), 400
    cmd = [_bin(cfg)] + (["--testnet"] if cfg.get("net_flag") else []) + \
          ["-p", _pass(cfg), "finalize", "-m", response_slate]
    r = _run(cmd, cfg.get("wallet_dir", "/tmp"), timeout=120)
    if r.returncode != 0:
        return jsonify({"error": r.stderr.strip()}), 500
    tx_id = ""
    m = re.search(r"[Tt]x [Ss]late [Ii][Dd]:\s*([0-9a-f-]{36})", r.stdout)
    if m:
        tx_id = m.group(1)
    return jsonify({"status": "confirmed", "tx_id": tx_id})

@app.get("/api/address")
def api_address():
    cfg = _cfg()
    cmd = [_bin(cfg)] + (["--testnet"] if cfg.get("net_flag") else []) + \
          ["-p", _pass(cfg), "address"]
    r = _run(cmd, cfg.get("wallet_dir", "/tmp"))
    if r.returncode != 0:
        return jsonify({"error": r.stderr.strip()}), 500
    for line in r.stdout.splitlines():
        line = line.strip()
        if re.match(r"^(grin1|tgrin1)[a-z0-9]+$", line):
            return jsonify({"address": line})
    return jsonify({"error": "Could not parse wallet address"}), 500

if __name__ == "__main__":
    port = int(os.environ.get("BRIDGE_PORT", "3006"))
    app.run(host="127.0.0.1", port=port, debug=False)
BRIDGE
        cat > "$WOO_APP_DIR/requirements.txt" << 'REQS'
flask>=3.0
gunicorn>=21.0
REQS
    fi

    info "Creating Python virtualenv at $WOO_APP_DIR/venv ..."
    if ! python3 -m venv "$WOO_APP_DIR/venv" 2>/dev/null; then
        local _pyver; _pyver=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
        apt-get install -y "python${_pyver}-venv" python3-pip \
            || { die "Failed to install python venv."; pause; return; }
        python3 -m venv "$WOO_APP_DIR/venv" \
            || { die "venv creation failed."; pause; return; }
    fi

    info "Installing Python requirements ..."
    "$WOO_APP_DIR/venv/bin/pip" install --quiet \
        -r "$WOO_APP_DIR/requirements.txt" \
        || { die "pip install failed."; pause; return; }

    # Create systemd service
    local run_user="www-data"
    id www-data &>/dev/null || run_user="root"

    cat > "/etc/systemd/system/${WOO_SERVICE}.service" << SYSTEMD
[Unit]
Description=Grin Wallet Bridge for WooCommerce [$WOO_NET_LABEL]
After=network.target

[Service]
Type=simple
User=$run_user
WorkingDirectory=$WOO_APP_DIR
Environment="BRIDGE_CONF=$WOO_CONF"
Environment="BRIDGE_PORT=$WOO_BRIDGE_PORT"
ExecStart=$WOO_APP_DIR/venv/bin/python $WOO_APP_DIR/grin_wallet_bridge.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SYSTEMD

    systemctl daemon-reload
    touch "$WOO_LOG"
    success "Bridge installed: $WOO_SERVICE  (port $WOO_BRIDGE_PORT, localhost only)"
    log "[woo_install_bridge] network=$WOO_NETWORK"
    pause
}

# =============================================================================
# OPTION 2 — Install WP plugin
# =============================================================================

woo_install_plugin() {
    woo_load_conf
    clear
    echo -e "\n${BOLD}${CYAN}── WooCommerce [$WOO_NET_LABEL] — 2) Install WP Plugin ──${RESET}\n"

    if [[ ! -d "$WOO_PLUGIN_SRC" ]]; then
        warn "Plugin source not found: $WOO_PLUGIN_SRC"
        warn "The plugin files should be in web/053_woocommerce/plugin/"
        pause; return
    fi

    echo -ne "WordPress root directory [${WOO_WP_DIR:-/var/www/html}]: "
    read -r input || true
    [[ -n "$input" ]] && WOO_WP_DIR="$input"
    WOO_WP_DIR="${WOO_WP_DIR:-/var/www/html}"

    local plugin_dir="$WOO_WP_DIR/wp-content/plugins/grin-payment"

    if [[ ! -d "$WOO_WP_DIR/wp-content" ]]; then
        die "WordPress not found at $WOO_WP_DIR — check the path."; pause; return
    fi

    if [[ -d "$plugin_dir" ]]; then
        warn "Plugin already installed at $plugin_dir"
        echo -ne "Update plugin files? [Y/n/0]: "
        read -r ow || true
        [[ "$ow" == "0" ]] && return
        [[ "${ow,,}" == "n" ]] && info "Cancelled." && return
    fi

    info "Copying plugin to $plugin_dir ..."
    mkdir -p "$plugin_dir"
    cp -r "$WOO_PLUGIN_SRC"/. "$plugin_dir/"

    # Write bridge URL config into plugin
    local bridge_url="http://127.0.0.1:$WOO_BRIDGE_PORT"
    local plugin_conf="$plugin_dir/bridge-config.php"
    cat > "$plugin_conf" << PHP
<?php
// Generated by 053_grin_woocommerce.sh — do not edit manually
define('GRIN_BRIDGE_URL', '$bridge_url');
define('GRIN_NETWORK',    '$WOO_NET_LABEL');
define('GRIN_EXPIRY_MIN', ${WOO_EXPIRY_MIN:-30});
PHP

    chown -R www-data:www-data "$plugin_dir" 2>/dev/null || true
    woo_save_conf

    success "Plugin installed at $plugin_dir"
    info "Activate it in WordPress Admin → Plugins → Grin Payment Gateway"
    log "[woo_install_plugin] wp_dir=$WOO_WP_DIR network=$WOO_NETWORK"
    pause
}

# =============================================================================
# OPTION 3 — Configure
# =============================================================================

woo_configure() {
    woo_load_conf
    clear
    echo -e "\n${BOLD}${CYAN}── WooCommerce [$WOO_NET_LABEL] — 3) Configure ──${RESET}\n"
    echo -e "  ${DIM}Press Enter to keep current value.${RESET}\n"

    echo -ne "Wallet directory   [${WOO_WALLET_DIR:-}]: "
    read -r v || true; [[ -n "$v" ]] && WOO_WALLET_DIR="$v"

    echo -ne "Invoice expiry     [${WOO_EXPIRY_MIN:-30} min]: "
    read -r v || true; [[ -n "$v" ]] && WOO_EXPIRY_MIN="$v"

    echo -ne "WordPress root dir [${WOO_WP_DIR:-/var/www/html}]: "
    read -r v || true; [[ -n "$v" ]] && WOO_WP_DIR="$v"

    woo_save_conf
    success "Configuration saved to $WOO_CONF"

    # Restart bridge if running
    if systemctl is-active --quiet "$WOO_SERVICE" 2>/dev/null; then
        info "Restarting $WOO_SERVICE ..."
        systemctl restart "$WOO_SERVICE"
        success "Bridge restarted."
    fi
    log "[woo_configure] network=$WOO_NETWORK"
    pause
}

# =============================================================================
# OPTION 4 — Start / Stop bridge
# =============================================================================

woo_service_control() {
    clear
    echo -e "\n${BOLD}${CYAN}── WooCommerce [$WOO_NET_LABEL] — 4) Start / Stop Bridge ──${RESET}\n"

    if [[ ! -f "/etc/systemd/system/${WOO_SERVICE}.service" ]]; then
        die "Bridge not installed — run option 1 (Install bridge) first."; pause; return
    fi

    local state="stopped"
    if systemctl is-active --quiet "$WOO_SERVICE" 2>/dev/null; then
        state="running"
        echo -e "  Bridge is ${GREEN}running${RESET}  ${DIM}(port $WOO_BRIDGE_PORT, localhost only)${RESET}"
        echo ""
        echo -e "  ${RED}1${RESET}) Stop bridge"
        echo -e "  ${YELLOW}2${RESET}) Restart bridge"
        echo -e "  ${DIM}0) Back${RESET}"
    else
        echo -e "  Bridge is ${YELLOW}stopped${RESET}"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Start bridge"
        echo -e "  ${GREEN}2${RESET}) Enable + Start  ${DIM}(auto-start on boot)${RESET}"
        echo -e "  ${DIM}0) Back${RESET}"
    fi
    echo ""
    echo -ne "${BOLD}Select [1/2/0]: ${RESET}"
    read -r sc || true

    case "$sc" in
        1)
            if [[ "$state" == "running" ]]; then
                systemctl stop "$WOO_SERVICE" && success "Bridge stopped."
            else
                systemctl start "$WOO_SERVICE" && success "Bridge started."
            fi
            ;;
        2)
            if [[ "$state" == "running" ]]; then
                systemctl restart "$WOO_SERVICE" && success "Bridge restarted."
            else
                systemctl enable "$WOO_SERVICE" 2>/dev/null || true
                systemctl start "$WOO_SERVICE" && success "Bridge enabled and started."
            fi
            ;;
        0) return ;;
    esac
    pause
}

# =============================================================================
# OPTION 5 — Status
# =============================================================================

woo_status() {
    woo_load_conf
    clear
    echo -e "\n${BOLD}${CYAN}── WooCommerce [$WOO_NET_LABEL] — 5) Status ──${RESET}\n"

    if systemctl is-active --quiet "$WOO_SERVICE" 2>/dev/null; then
        local pid
        pid=$(systemctl show "$WOO_SERVICE" --property=MainPID --value 2>/dev/null || echo "?")
        echo -e "  ${BOLD}Bridge${RESET}     : ${GREEN}● running${RESET}  pid $pid  port $WOO_BRIDGE_PORT (localhost only)"
    elif systemctl is-enabled --quiet "$WOO_SERVICE" 2>/dev/null; then
        echo -e "  ${BOLD}Bridge${RESET}     : ${YELLOW}stopped (enabled)${RESET}"
    else
        echo -e "  ${BOLD}Bridge${RESET}     : ${RED}not installed${RESET}  ${DIM}(step 1)${RESET}"
    fi

    echo -e "  ${BOLD}Network${RESET}    : $WOO_NET_LABEL"
    echo -e "  ${BOLD}App dir${RESET}    : $WOO_APP_DIR"
    echo -e "  ${BOLD}Config${RESET}     : $WOO_CONF"
    echo -e "  ${BOLD}Wallet dir${RESET} : ${WOO_WALLET_DIR:-not set}"
    echo -e "  ${BOLD}WP root${RESET}    : ${WOO_WP_DIR:-/var/www/html}"

    if [[ -n "$WOO_WP_DIR" && -d "$WOO_WP_DIR/wp-content/plugins/grin-payment" ]]; then
        echo -e "  ${BOLD}WP plugin${RESET}  : ${GREEN}installed${RESET}  ${DIM}($WOO_WP_DIR/wp-content/plugins/grin-payment)${RESET}"
    else
        echo -e "  ${BOLD}WP plugin${RESET}  : ${DIM}not installed  (step 2)${RESET}"
    fi

    # Quick bridge health check
    if systemctl is-active --quiet "$WOO_SERVICE" 2>/dev/null; then
        echo ""
        info "Bridge health check..."
        if curl -sf "http://127.0.0.1:$WOO_BRIDGE_PORT/api/status" > /dev/null 2>&1; then
            success "Bridge responded on port $WOO_BRIDGE_PORT"
        else
            warn "Bridge not responding — check logs: journalctl -u $WOO_SERVICE"
        fi
    fi
    echo ""
    pause
}

# =============================================================================
# OPTION 6 — Package plugin as distributable zip
# =============================================================================

woo_package_plugin() {
    clear
    echo -e "\n${BOLD}${CYAN}── WooCommerce — 6) Package Plugin ──${RESET}\n"
    echo -e "  ${DIM}Creates a distributable zip (excludes server-specific bridge-config.php).${RESET}\n"

    if [[ ! -d "$WOO_PLUGIN_SRC" ]]; then
        die "Plugin source not found: $WOO_PLUGIN_SRC"; pause; return
    fi

    local plugin_main="$WOO_PLUGIN_SRC/grin-payment.php"
    if [[ ! -f "$plugin_main" ]]; then
        warn "grin-payment.php not found in $WOO_PLUGIN_SRC"
        warn "Cannot read version — using 0.0.0"
        local version="0.0.0"
    else
        local version
        version=$(grep -i "^\s*\*\s*Version:" "$plugin_main" 2>/dev/null \
            | head -1 | awk -F: '{print $2}' | tr -d ' ')
        version="${version:-0.0.0}"
    fi

    local releases_dir="$TOOLKIT_ROOT/web/053_woocommerce/releases"
    mkdir -p "$releases_dir"

    local zip_name="grin-payment-v${version}.zip"
    local zip_path="$releases_dir/$zip_name"

    if [[ -f "$zip_path" ]]; then
        warn "File already exists: $zip_path"
        echo -ne "  Overwrite? [y/N]: "
        read -r ow || true
        [[ "${ow,,}" != "y" ]] && info "Cancelled." && pause && return
        rm -f "$zip_path"
    fi

    info "Packaging version ${BOLD}$version${RESET} ..."

    # Build zip with correct internal folder name grin-payment/
    local tmp_dir
    tmp_dir=$(mktemp -d)
    cp -r "$WOO_PLUGIN_SRC" "$tmp_dir/grin-payment"

    # Remove server-specific and development files
    rm -f  "$tmp_dir/grin-payment/bridge-config.php"
    find   "$tmp_dir/grin-payment" -name ".DS_Store" -delete 2>/dev/null || true
    find   "$tmp_dir/grin-payment" -name "*.log"     -delete 2>/dev/null || true

    ( cd "$tmp_dir" && zip -qr "$zip_path" "grin-payment/" )
    rm -rf "$tmp_dir"

    if [[ -f "$zip_path" ]]; then
        local size
        size=$(du -sh "$zip_path" | awk '{print $1}')
        success "Plugin packaged: ${BOLD}$zip_path${RESET}  ($size)"
        echo ""
        echo -e "  ${DIM}Install via: WordPress Admin → Plugins → Add New → Upload Plugin${RESET}"
    else
        die "zip failed — is the zip command installed?"
    fi

    log "[woo_package_plugin] version=$version path=$zip_path"
    pause
}

# =============================================================================
# OPTION 7 — Pull latest from GitHub and exit
# =============================================================================

woo_pull_update() {
    clear
    echo -e "\n${BOLD}${CYAN}── WooCommerce — 7) Pull Latest from GitHub ──${RESET}\n"
    echo -e "  ${DIM}Runs git pull in toolkit root, then exits so changes take effect.${RESET}\n"
    echo -e "  ${BOLD}Toolkit root:${RESET} $TOOLKIT_ROOT"
    echo ""

    if ! command -v git &>/dev/null; then
        die "git not found."; pause; return
    fi

    if [[ ! -d "$TOOLKIT_ROOT/.git" ]]; then
        die "$TOOLKIT_ROOT is not a git repository."; pause; return
    fi

    # Show current branch
    local branch
    branch=$(git -C "$TOOLKIT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
    echo -e "  Current branch: ${BOLD}$branch${RESET}"
    echo ""

    echo -ne "  Pull from origin/${branch}? [Y/n]: "
    read -r confirm || true
    [[ "${confirm,,}" == "n" ]] && info "Cancelled." && pause && return

    echo ""
    info "Running git pull ..."
    echo ""

    if git -C "$TOOLKIT_ROOT" pull origin "$branch"; then
        echo ""
        success "Pull complete. Exiting script so new version takes effect."
        log "[woo_pull_update] branch=$branch pulled OK — exiting"
        exit 0
    else
        echo ""
        die "git pull failed — check output above for conflicts or errors."
        pause
    fi
}

# =============================================================================
# MENU
# =============================================================================

woo_menu() {
    while true; do
        clear
        if [[ "$WOO_NETWORK" == "mainnet" ]]; then
            echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
            echo -e "${BOLD}${RED} 053) GRIN WOOCOMMERCE  [MAINNET — REAL GRIN]${RESET}"
            echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        else
            echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
            echo -e "${BOLD}${CYAN} 053) GRIN WOOCOMMERCE  [TESTNET]${RESET}"
            echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        fi
        woo_menu_status

        echo -e "${DIM}  ─── Setup ────────────────────────────────────────${RESET}"
        echo -e "  ${GREEN}1${RESET}) Install bridge        ${DIM}(Python venv + Flask + systemd)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Install WP plugin     ${DIM}(copy plugin to WordPress)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Configure             ${DIM}(wallet path, expiry, WP dir)${RESET}"
        echo -e "  ${GREEN}4${RESET}) Start / Stop bridge   ${DIM}(systemd $WOO_SERVICE)${RESET}"
        echo ""
        echo -e "${DIM}  ─── Info ─────────────────────────────────────────${RESET}"
        echo -e "  ${CYAN}5${RESET}) Status"
        echo ""
        echo -e "${DIM}  ─── Distribution ─────────────────────────────────${RESET}"
        echo -e "  ${YELLOW}6${RESET}) Package plugin        ${DIM}(create distributable .zip)${RESET}"
        echo -e "  ${YELLOW}7${RESET}) Pull latest & exit    ${DIM}(git pull origin, then exit)${RESET}"
        echo ""
        echo -e "  ${DIM}↩  Press Enter to refresh${RESET}"
        echo -e "  ${RED}0${RESET}) Back to network select"
        echo ""
        echo -ne "${BOLD}Select [1-7 / 0]: ${RESET}"
        read -r choice || true

        case "$choice" in
            1) woo_install_bridge  || true ;;
            2) woo_install_plugin  || true ;;
            3) woo_configure       || true ;;
            4) woo_service_control || true ;;
            5) woo_status          || true ;;
            6) woo_package_plugin  || true ;;
            7) woo_pull_update     || true ;;
            0) break ;;
            "") continue ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# =============================================================================
# MAIN
# =============================================================================

main() {
    while true; do
        if select_network; then
            woo_menu
        else
            break
        fi
    done
}

main "$@"
