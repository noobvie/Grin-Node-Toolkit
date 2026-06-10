# =============================================================================
# 07_lib_satellite.sh — SATELLITE deployment (sourced by 07_grin_mining_public_pool.sh)
# =============================================================================
# Multi-region mining pool — SATELLITE role.
# Deploys mining ingress + relay ONLY: no web, no admin, no pool DB, no wallet.
# Runs the lean satellite entrypoint (back-end-pool/satellite.js), which starts
# the stratum proxy + node upstream client + share relay to the Central Hub.
# See docs/generated/script07_design.md §3–4 (deployment modes, share capture).
#
# Sourced, not executed — inherits colors/log helpers from the parent script
# (info/warn/success/error, $TOOLKIT_ROOT, $POOL_APP_SRC).
# Ports per §9 (public 3333 / node upstream 3334).
# =============================================================================

SAT_CONF="/opt/grin/conf/grin_satellite.json"
SAT_APP_DIR="/opt/grin/satellite"
SAT_APP_CODE="$SAT_APP_DIR/app"          # back-end-pool code (satellite.js + lib/)
SAT_DB="$SAT_APP_DIR/satellite.sqlite"   # lean local staging/failover DB
SAT_SERVICE="grin-satellite"
SAT_LOG="/opt/grin/logs/grin-satellite.log"

# ─── Config helpers (mirror the parent, targeting SAT_CONF) ─────────────────────
sat_read_conf() {
    local key="$1" default="${2:-}"
    [[ -f "$SAT_CONF" ]] || { echo "$default"; return; }
    node -e "
try {
  const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  const v = d[process.argv[2]];
  process.stdout.write(v !== undefined ? String(v) : process.argv[3]);
} catch(e) { process.stdout.write(process.argv[3]); }
" "$SAT_CONF" "$key" "$default" 2>/dev/null || echo "$default"
}

sat_write_conf_key() {
    local key="$1" val="$2"
    mkdir -p "$(dirname "$SAT_CONF")"
    node -e "
const fs = require('fs');
const [path, key, val] = process.argv.slice(1);
const NUMS = new Set(['stratum_port','node_stratum_port','node_api_port','relay_batch_interval_ms','pool_fee_percent','min_withdrawal']);
let d = {};
try { d = JSON.parse(fs.readFileSync(path, 'utf8')); } catch(e) {}
d[key] = NUMS.has(key) ? parseFloat(val) : val;
fs.writeFileSync(path, JSON.stringify(d, null, 2));
fs.chmodSync(path, 0o600);
" "$SAT_CONF" "$key" "$val"
}

sat_ensure_defaults() {
    local -A defaults=(
        ["role"]="satellite"
        ["network"]="mainnet"
        ["region"]=""
        ["hub_url"]=""
        ["hub_shared_secret"]=""
        ["stratum_port"]="3333"
        ["node_stratum_port"]="3334"
        ["node_stratum_host"]="127.0.0.1"
        ["node_api_url"]="http://127.0.0.1:3413"
        ["pool_address"]=""
        ["db_path"]="$SAT_DB"
        ["relay_batch_interval_ms"]="2000"
        ["pool_fee_percent"]="1.0"
        ["min_withdrawal"]="5.0"
        ["wallet_dir"]="$SAT_APP_DIR/no-wallet"  # placeholder — satellites have no wallet
    )
    local k
    for k in "${!defaults[@]}"; do
        local existing; existing=$(sat_read_conf "$k" "__MISSING__")
        [[ "$existing" == "__MISSING__" ]] && sat_write_conf_key "$k" "${defaults[$k]}"
    done
    # jwt_secret is required by loadConfig() even though satellites never use it.
    local jwt; jwt=$(sat_read_conf "jwt_secret" "")
    if [[ -z "$jwt" ]]; then
        jwt=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" 2>/dev/null || openssl rand -hex 32)
        sat_write_conf_key "jwt_secret" "$jwt"
    fi
}

# ─── 1) Install ─────────────────────────────────────────────────────────────────
sat_install() {
    echo -e "\n${BOLD}Installing Satellite (stratum proxy + relay)...${RESET}\n"

    # Defense-in-depth: refuse if a pool/Central Hub brain already occupies this
    # box (in case the selector guard was bypassed via a direct/non-interactive
    # entry). pool_mode_conflict_check is defined in the parent script.
    pool_mode_conflict_check "satellite" || return 0

    if [[ ! -f "$POOL_APP_SRC/satellite.js" ]]; then
        error "satellite.js not found in $POOL_APP_SRC — run from the GRINIUM repository."
        return 1
    fi

    info "Checking system packages..."
    # No build-essential/gcc-c++: the relay has no native npm modules since the
    # better-sqlite3 → node:sqlite migration (failover buffer uses node:sqlite).
    if command -v apt-get &>/dev/null; then
        apt-get install -y sqlite3 2>&1 | tail -5
    elif command -v dnf &>/dev/null; then
        dnf install -y sqlite3 2>&1 | tail -5
    fi

    # pool_ensure_node24 is defined in the parent script (07_grin_mining_public_pool.sh).
    pool_ensure_node24 || return 1

    mkdir -p "$SAT_APP_CODE"
    chmod 700 "$SAT_APP_DIR"
    info "Copying satellite app to $SAT_APP_CODE..."
    rsync -a --delete "$POOL_APP_SRC/" "$SAT_APP_CODE/" 2>/dev/null || cp -r "$POOL_APP_SRC/"* "$SAT_APP_CODE/"

    local npm_cmd="install"
    [[ -f "$SAT_APP_CODE/package-lock.json" ]] && npm_cmd="ci"
    info "Installing Node.js dependencies (npm $npm_cmd)..."
    (cd "$SAT_APP_CODE" && npm "$npm_cmd" --omit=dev 2>&1 | tail -20) \
        || { error "npm $npm_cmd failed in $SAT_APP_CODE — see /root/.npm/_logs/ (latest *-debug-0.log)."; return 1; }
    success "Dependencies installed."

    sat_ensure_defaults
    mkdir -p "$(dirname "$SAT_LOG")"

    local node_bin; node_bin=$(command -v node 2>/dev/null || echo /usr/bin/node)
    cat > "/etc/systemd/system/$SAT_SERVICE.service" << EOF
[Unit]
Description=Grin Pool Satellite (GRINIUM)
After=network.target
Wants=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$SAT_APP_CODE
Environment="GRIN_POOL_CONF=$SAT_CONF"
Environment="NODE_ENV=production"
ExecStart=$node_bin $SAT_APP_CODE/satellite.js
Restart=on-failure
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "$SAT_SERVICE" 2>/dev/null || true
    success "Systemd service $SAT_SERVICE installed."
    echo -e "  Next: ${BOLD}2) Configure${RESET} → ${BOLD}3) Enable node stratum${RESET} → ${BOLD}4) Service control${RESET}"
}

# ─── 2) Configure ───────────────────────────────────────────────────────────────
sat_configure() {
    echo -e "\n${BOLD}Configure Satellite${RESET}\n"
    sat_ensure_defaults
    local val

    echo -ne "Region name (e.g. asia, us-east)   [$(sat_read_conf region "")]: "
    read -r val; [[ -n "$val" ]] && sat_write_conf_key "region" "$val"

    echo -ne "Central Hub URL (https://hub:8080) [$(sat_read_conf hub_url "")]: "
    read -r val; [[ -n "$val" ]] && sat_write_conf_key "hub_url" "${val%/}"

    echo -ne "Hub shared secret                  [$( [[ -n "$(sat_read_conf hub_shared_secret '')" ]] && echo '*** keep ***' || echo none)]: "
    read -r val; [[ -n "$val" ]] && sat_write_conf_key "hub_shared_secret" "$val"

    echo -e "  ${DIM}(Pool's own Grin address — used to login to the node stratum upstream)${RESET}"
    echo -ne "Pool Grin address                  [$(sat_read_conf pool_address "")]: "
    read -r val; [[ -n "$val" ]] && sat_write_conf_key "pool_address" "$val"

    echo -ne "Public stratum port                [$(sat_read_conf stratum_port "3333")]: "
    read -r val; [[ -n "$val" ]] && sat_write_conf_key "stratum_port" "$val"

    echo -ne "Node upstream stratum port         [$(sat_read_conf node_stratum_port "3334")]: "
    read -r val; [[ -n "$val" ]] && sat_write_conf_key "node_stratum_port" "$val"

    if systemctl is-active --quiet "$SAT_SERVICE" 2>/dev/null; then
        info "Restarting $SAT_SERVICE to apply config..."
        systemctl restart "$SAT_SERVICE"
    fi
    success "Satellite configured ($SAT_CONF)."
}

# ─── 3) Enable node built-in stratum (localhost upstream) ───────────────────────
_sat_set_toml_key() {
    # Replace an existing key line (commented or not) in a grin-server.toml.
    # Returns non-zero if the key is absent (so the caller can warn).
    local file="$1" key="$2" val="$3"
    if grep -Eq "^[[:space:]]*#?[[:space:]]*${key}[[:space:]]*=" "$file"; then
        sed -i -E "s|^[[:space:]]*#?[[:space:]]*${key}[[:space:]]*=.*|${key} = ${val}|" "$file"
        return 0
    fi
    return 1
}

sat_enable_node_stratum() {
    echo -e "\n${BOLD}Enable node built-in stratum (localhost upstream)${RESET}\n"
    local nsp; nsp=$(sat_read_conf node_stratum_port "3334")

    local default_toml="/opt/grin/node/mainnet-prune/grin-server.toml"
    echo -ne "Path to grin-server.toml [$default_toml]: "
    local toml; read -r toml; [[ -z "$toml" ]] && toml="$default_toml"
    if [[ ! -f "$toml" ]]; then
        error "Not found: $toml"
        return 1
    fi

    cp -a "$toml" "${toml}.bak.$(date +%s)" && info "Backed up $toml"

    _sat_set_toml_key "$toml" "enable_stratum_server" "true" \
        || warn "enable_stratum_server not present — add it under [server.stratum_mining_config]"
    _sat_set_toml_key "$toml" "stratum_server_addr" "\"127.0.0.1:${nsp}\"" \
        || warn "stratum_server_addr not present — add it under [server.stratum_mining_config]"

    echo ""
    warn "The node's stratum builds block templates whose COINBASE goes to its"
    warn "wallet_listener_url. For a pool, that MUST be the POOL wallet (the hub's"
    warn "wallet foreign API for multi-region), or block rewards go to the wrong place."
    echo -ne "Set wallet_listener_url now? (blank = leave unchanged): "
    local wlu; read -r wlu
    if [[ -n "$wlu" ]]; then
        _sat_set_toml_key "$toml" "wallet_listener_url" "\"${wlu}\"" \
            || warn "wallet_listener_url not present — add it manually."
    fi

    echo ""
    success "Patched $toml — stratum on 127.0.0.1:${nsp}."
    warn "Restart the Grin node for changes to take effect."
}

# ─── 4) Service control ─────────────────────────────────────────────────────────
sat_service_control() {
    echo -e "\n${BOLD}Service Control — $SAT_SERVICE${RESET}"
    if systemctl is-active --quiet "$SAT_SERVICE" 2>/dev/null; then
        echo -e "  Status: ${GREEN}● running${RESET}"
        echo -e "  ${GREEN}1${RESET}) Stop    ${GREEN}2${RESET}) Restart    ${DIM}0) Back${RESET}"
        echo -ne "Choice: "; read -r sc
        case "$sc" in
            1) systemctl stop "$SAT_SERVICE" && success "Stopped." || error "Stop failed." ;;
            2) systemctl restart "$SAT_SERVICE" && success "Restarted." || error "Restart failed." ;;
        esac
    else
        echo -e "  Status: ${RED}● stopped${RESET}"
        echo -e "  ${GREEN}1${RESET}) Start    ${DIM}0) Back${RESET}"
        echo -ne "Choice: "; read -r sc
        # if-form: a trailing `[[ ]] &&` would make "0/back" return 1 → set -e kills the caller
        if [[ "$sc" == "1" ]]; then
            systemctl start "$SAT_SERVICE" && success "Started." || error "Start failed."
        fi
    fi
}

# ─── 5) Status ──────────────────────────────────────────────────────────────────
sat_status() {
    echo -e "\n${BOLD}Satellite Status${RESET}"
    echo -e "${DIM}────────────────────────────────────────────────${RESET}"

    if systemctl is-active --quiet "$SAT_SERVICE" 2>/dev/null; then
        echo -e "  ${BOLD}Service${RESET} : ${GREEN}● active${RESET}"
    elif systemctl is-enabled --quiet "$SAT_SERVICE" 2>/dev/null; then
        echo -e "  ${BOLD}Service${RESET} : ${YELLOW}installed, stopped${RESET}"
    else
        echo -e "  ${BOLD}Service${RESET} : ${DIM}not installed${RESET}"
    fi

    local sp; sp=$(sat_read_conf stratum_port "3333")
    if ss -tlnp 2>/dev/null | grep -q ":$sp "; then
        echo -e "  ${BOLD}Stratum${RESET} : ${GREEN}:$sp listening${RESET}"
    else
        echo -e "  ${BOLD}Stratum${RESET} : ${DIM}:$sp not listening${RESET}"
    fi

    echo -e "  ${BOLD}Region${RESET}  : $(sat_read_conf region '(unset)')"
    echo -e "  ${BOLD}Hub${RESET}     : $(sat_read_conf hub_url '(unset)')"
    echo -e "  ${BOLD}Upstream${RESET}: 127.0.0.1:$(sat_read_conf node_stratum_port '3334')"

    # Relay failover backlog (shares/blocks waiting to reach the hub).
    local fdb="$SAT_APP_DIR/relay_failover.sqlite"
    if [[ -f "$fdb" ]] && command -v sqlite3 &>/dev/null; then
        local sh bl
        sh=$(sqlite3 "$fdb" "SELECT COUNT(*) FROM relay_shares;" 2>/dev/null || echo "?")
        bl=$(sqlite3 "$fdb" "SELECT COUNT(*) FROM relay_blocks;" 2>/dev/null || echo "?")
        echo -e "  ${BOLD}Backlog${RESET} : shares=$sh blocks=$bl  ${DIM}(unsent → hub)${RESET}"
    fi

    if [[ -f "$SAT_LOG" ]]; then
        echo -e "\n${DIM}── Recent log (last 12 lines) ──${RESET}"
        tail -n 12 "$SAT_LOG" 2>/dev/null | sed 's/^/  /'
    fi
}

# ─── Menu / loop ────────────────────────────────────────────────────────────────
sat_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  GRINIUM — Satellite (regional node)${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${DIM}  Public stratum :$(sat_read_conf stratum_port 3333)  ->  node upstream 127.0.0.1:$(sat_read_conf node_stratum_port 3334)${RESET}"
    echo ""
    echo -e "  ${GREEN}1${RESET}) Install              ${DIM}(app + systemd)${RESET}"
    echo -e "  ${GREEN}2${RESET}) Configure            ${DIM}(hub URL, secret, region, address)${RESET}"
    echo -e "  ${GREEN}3${RESET}) Enable node stratum  ${DIM}(patch grin-server.toml)${RESET}"
    echo -e "  ${GREEN}4${RESET}) Service control      ${DIM}(start / stop / restart)${RESET}"
    echo -e "  ${GREEN}5${RESET}) Status"
    echo ""
    echo -e "  ${RED}0${RESET}) Back"
    echo ""
    echo -ne "${BOLD}Select: ${RESET}"
}

pool_satellite_loop() {
    while true; do
        sat_menu
        read -r choice
        # ||-guarded dispatch: a failing step must return to this menu, not kill
        # the whole script via set -e.
        case "${choice,,}" in
            "")       continue ;;
            1)        sat_install || true ;;
            2)        sat_configure || true ;;
            3)        sat_enable_node_stratum || true ;;
            4)        sat_service_control || true ;;
            5)        sat_status || true ;;
            0|q|exit) break ;;
            *)        warn "Invalid option."; sleep 1; continue ;;
        esac
        echo ""; echo "Press Enter to continue..."; read -r
    done
}
