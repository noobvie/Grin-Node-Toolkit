# 092_lib_client.sh — Grin Transporter poll agent: install, cron, actions
# Sourced by 092_grin_transporter.sh — inherits colors/log/TRP_* variables and
# 092_lib_server.sh helpers (_trp_conf_get/_trp_conf_set, _trp_ensure_node,
# _trp_json_get).
#
#  The agent runs NEXT TO a grin-wallet (its Owner API v3 + Foreign API) and
#  does all slate crypto at the edge; the Transporter server stays walletless.
#
#  Functions exported:
#    trp_agent_install      — copy agent.js + build agent.json (Drop auto-detect)
#    trp_agent_cron_toggle  — poll every N minutes via /etc/cron.d + logrotate
#    trp_agent_menu         — address / status / send / poll now / cron
#

# Run the agent as the grin user when it exists (wallet secrets are grin-owned).
_trp_agent_run() {
    local cmd=("$@")
    if id grin &>/dev/null; then
        su -s /bin/bash grin -c "TRANSPORTER_AGENT_CONF='$TRP_AGENT_CONF' $(command -v node) '$TRP_AGENT_DIR/agent.js' ${cmd[*]}"
    else
        TRANSPORTER_AGENT_CONF="$TRP_AGENT_CONF" node "$TRP_AGENT_DIR/agent.js" "${cmd[@]}"
    fi
}

# =============================================================================
# 7) INSTALL / UPDATE POLL AGENT
# =============================================================================
trp_agent_install() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Transporter [$TRP_NET_LABEL] — 7) Install poll agent ──${RESET}\n"
    echo -e "  ${DIM}Wires a local grin-wallet to a Transporter queue. The wallet must run${RESET}"
    echo -e "  ${DIM}a combined owner_api listener (the 052/07 model, port $TRP_OWNER_PORT).${RESET}\n"

    _trp_ensure_node || { pause; return; }

    if [[ ! -f "$TRP_AGENT_SRC" ]]; then
        error "Agent source not found: $TRP_AGENT_SRC (ensure the toolkit repo is complete)."
        pause; return
    fi

    # ── Transporter URL ────────────────────────────────────────────────────────
    local def_url cur_url url
    cur_url=$(_trp_conf_get "agent_url_${TRP_NETWORK}" "")
    def_url="${cur_url:-http://127.0.0.1:$TRP_PORT}"
    echo -e "  ${DIM}Local server on this box: http://127.0.0.1:$TRP_PORT — or a remote${RESET}"
    echo -e "  ${DIM}operator's https://domain from their option 3.${RESET}"
    echo -ne "  Transporter URL [$def_url]: "
    read -r url || true
    url="${url:-$def_url}"

    # ── Wallet wiring — auto-detect an existing Grin Drop wallet first ─────────
    local drop_conf="/opt/grin/drop-${TRP_NET_SHORT}/grin_drop_${TRP_NET_SHORT}.conf"
    local owner_secret="" pass_file="" owner_port="$TRP_OWNER_PORT"
    if [[ -f "$drop_conf" ]]; then
        echo ""
        info "Found Grin Drop config: $drop_conf"
        echo -ne "  Use the Drop wallet for this agent? [Y/n]: "
        local use_drop; read -r use_drop || true
        if [[ "${use_drop,,}" != "n" ]]; then
            owner_secret=$(_trp_json_get "$drop_conf" "wallet_owner_secret" "")
            pass_file=$(_trp_json_get    "$drop_conf" "wallet_pass_file" "")
            owner_port=$(_trp_json_get   "$drop_conf" "wallet_owner_api_port" "$TRP_OWNER_PORT")
        fi
    fi
    if [[ -z "$owner_secret" ]]; then
        echo ""
        echo -e "  ${DIM}Manual wallet wiring (paths on THIS box):${RESET}"
        local wdir
        echo -ne "  Wallet dir [/opt/grin/drop-${TRP_NET_SHORT}]: "
        read -r wdir || true
        wdir="${wdir:-/opt/grin/drop-${TRP_NET_SHORT}}"
        echo -ne "  Owner API port [$TRP_OWNER_PORT]: "
        read -r owner_port || true
        owner_port="${owner_port:-$TRP_OWNER_PORT}"
        owner_secret="$wdir/.owner_api_secret"
        echo -ne "  Wallet passphrase file [$wdir/.wallet_pass]: "
        read -r pass_file || true
        pass_file="${pass_file:-$wdir/.wallet_pass}"
    fi
    if [[ ! -f "$owner_secret" ]]; then
        warn "Owner secret not found at $owner_secret — the agent will fail until it exists."
    fi
    if [[ ! -f "$pass_file" ]]; then
        warn "Pass file not found at $pass_file — the agent will fail until it exists."
    fi

    # ── Deploy agent ───────────────────────────────────────────────────────────
    mkdir -p "$TRP_AGENT_DIR"
    cp "$TRP_AGENT_SRC" "$TRP_AGENT_DIR/agent.js"

    # Foreign API rides the combined owner_api port (owner_api_include_foreign);
    # foreign on that port needs no auth, so wallet_foreign_secret stays empty.
    cat > "$TRP_AGENT_CONF" << AGENTCONF
{
  "network": "$TRP_NETWORK",
  "transporter_url": "$url",
  "wallet_owner_url": "http://127.0.0.1:$owner_port/v3/owner",
  "wallet_foreign_url": "http://127.0.0.1:$owner_port/v2/foreign",
  "wallet_owner_secret": "$owner_secret",
  "wallet_foreign_secret": "",
  "wallet_pass_file": "$pass_file",
  "min_confirmations": 10
}
AGENTCONF
    if id grin &>/dev/null; then
        chown -R grin:grin "$TRP_AGENT_DIR" 2>/dev/null || true
    fi
    chmod 600 "$TRP_AGENT_CONF"
    _trp_conf_set "agent_url_${TRP_NETWORK}" "$url"
    success "Agent installed: $TRP_AGENT_DIR (config: agent.json)"

    echo ""
    echo -ne "  Test the agent now (status)? [Y/n]: "
    local t; read -r t || true
    if [[ "${t,,}" != "n" ]]; then
        _trp_agent_run status || warn "Test failed — check wallet owner_api session + Transporter URL."
    fi
    log "[trp_agent_install] net=$TRP_NETWORK url=$url owner_port=$owner_port"
    pause
}

# =============================================================================
# CRON POLL TOGGLE (fixed-name log → logrotate, per toolkit conventions)
# =============================================================================
trp_agent_cron_toggle() {
    local cron_file="/etc/cron.d/grin-transporter-agent-${TRP_NETWORK}"
    local agent_log="/opt/grin/logs/transporter_agent_${TRP_NETWORK}.log"

    if [[ -f "$cron_file" ]]; then
        echo -ne "  Poll cron is ENABLED — disable it? [y/N]: "
        local c; read -r c || true
        if [[ "${c,,}" == "y" ]]; then
            rm -f "$cron_file" "/etc/logrotate.d/grin-transporter-agent-${TRP_NETWORK}"
            success "Poll cron disabled."
        fi
        return 0
    fi

    if [[ ! -f "$TRP_AGENT_CONF" ]]; then
        error "Agent not installed — run option 7 first."
        return 0
    fi

    local mins
    echo -ne "  Poll every how many minutes? [10]: "
    read -r mins || true
    mins="${mins:-10}"
    if ! [[ "$mins" =~ ^[0-9]+$ && "$mins" -ge 1 && "$mins" -le 59 ]]; then
        error "Enter 1-59."
        return 0
    fi

    local cron_user="grin"
    id grin &>/dev/null || cron_user="root"
    local node_bin; node_bin=$(command -v node)

    mkdir -p /opt/grin/logs
    touch "$agent_log"
    chown "$cron_user:$cron_user" "$agent_log" 2>/dev/null || true

    cat > "$cron_file" << CRON
# Grin Transporter poll agent [$TRP_NET_LABEL] — generated by 092_grin_transporter.sh
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/$mins * * * * $cron_user $node_bin $TRP_AGENT_DIR/agent.js poll --config $TRP_AGENT_CONF >> $agent_log 2>&1
CRON
    chmod 644 "$cron_file"

    cat > "/etc/logrotate.d/grin-transporter-agent-${TRP_NETWORK}" << LOGROTATE
$agent_log {
    weekly
    rotate 8
    size 10M
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
LOGROTATE
    success "Poll cron enabled: every $mins min as $cron_user (log: $agent_log)"
}

# =============================================================================
# 8) AGENT ACTIONS SUBMENU
# =============================================================================
trp_agent_menu() {
    if [[ ! -f "$TRP_AGENT_CONF" ]]; then
        error "Agent not installed — run option 7 first."
        pause; return
    fi
    while true; do
        clear
        echo -e "\n${BOLD}${CYAN}── Grin Transporter [$TRP_NET_LABEL] — 8) Agent actions ──${RESET}\n"
        local cron_state="${DIM}disabled${RESET}"
        [[ -f "/etc/cron.d/grin-transporter-agent-${TRP_NETWORK}" ]] && cron_state="${GREEN}enabled${RESET}"
        echo -e "  ${GREEN}1${RESET}) Show wallet slatepack address"
        echo -e "  ${GREEN}2${RESET}) Status (transporter + own queue)"
        echo -e "  ${GREEN}3${RESET}) Send GRIN via Transporter"
        echo -e "  ${GREEN}4${RESET}) Poll now (receive / finalize pending slates)"
        echo -e "  ${GREEN}5${RESET}) Cancel an unanswered send (unlock outputs)"
        echo -e "  ${GREEN}6${RESET}) Poll cron: $cron_state"
        echo -e "  ${RED}0${RESET}) Back"
        echo -ne "\n${BOLD}Select: ${RESET}"
        local ch; read -r ch || true
        case "$ch" in
            1) echo ""; _trp_agent_run address || true; pause ;;
            2) echo ""; _trp_agent_run status  || true; pause ;;
            3)
                local dest amt
                echo -ne "\n  Recipient slatepack address (${TRP_NETWORK} ${TRP_ADDR_HRP}1…): "
                read -r dest || true
                echo -ne "  Amount in GRIN: "
                read -r amt || true
                if [[ -n "$dest" && -n "$amt" ]]; then
                    echo ""
                    _trp_agent_run send "$dest" "$amt" || true
                else
                    warn "Address and amount required."
                fi
                pause ;;
            4) echo ""; _trp_agent_run poll || true; pause ;;
            5)
                local txid
                echo -ne "\n  tx_slate_id to cancel: "
                read -r txid || true
                if [[ -n "$txid" ]]; then
                    echo ""
                    _trp_agent_run cancel "$txid" || true
                fi
                pause ;;
            6) echo ""; trp_agent_cron_toggle || true; pause ;;
            0) break ;;
            *) ;;
        esac
    done
}
