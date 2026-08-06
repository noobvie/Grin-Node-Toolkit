# 093_lib_client.sh — Grin Transporter poll agent: install, cron, actions
# Sourced by 093_grin_transporter.sh — inherits colors/log/TRP_* variables and
# 093_lib_server.sh helpers (_trp_conf_get/_trp_conf_set, _trp_ensure_node,
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
#
# `su -c` takes a STRING that the target shell re-parses, so every argument must
# be quoted for that second parse — `${cmd[*]}` flattens the array and hands the
# shell raw operator input. A pasted address with a stray space silently became
# two arguments, and an amount typed as `1; reboot` would have been executed.
# printf %q produces shell-safe tokens; the non-su branch never had the problem
# because it passes a real argv.
_trp_agent_run() {
    if id grin &>/dev/null; then
        local quoted="" a
        for a in "$@"; do quoted+=" $(printf '%q' "$a")"; done
        su -s /bin/bash grin -c \
            "TRANSPORTER_AGENT_CONF=$(printf '%q' "$TRP_AGENT_CONF") \
             $(printf '%q' "$(command -v node)") \
             $(printf '%q' "$TRP_AGENT_DIR/agent.js")$quoted"
    else
        TRANSPORTER_AGENT_CONF="$TRP_AGENT_CONF" node "$TRP_AGENT_DIR/agent.js" "$@"
    fi
}

# =============================================================================
# 7) INSTALL / UPDATE POLL AGENT
# =============================================================================
trp_agent_install() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Transporter [$TRP_NET_LABEL] — 7) Install poll agent ──${RESET}\n"
    echo -e "  ${DIM}Wires a local grin-wallet to a Transporter queue. The wallet must run${RESET}"
    echo -e "  ${DIM}a combined owner_api listener (the 059/07 model, port $TRP_OWNER_PORT).${RESET}\n"

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
    url="${url%/}"
    if ! [[ "$url" =~ ^https?://[^[:space:]\"]+$ ]]; then
        error "'$url' is not a valid http(s) URL — aborting so agent.json stays parseable."
        pause; return
    fi
    # Cleartext to a REMOTE host exposes the 15-minute bearer token that grants
    # read+delete on this wallet's queue. Loopback and .onion are fine (the onion
    # is end-to-end encrypted by Tor); anything else on http:// is not.
    if [[ "$url" == http://* ]] \
       && ! [[ "$url" =~ ^http://(127\.0\.0\.1|localhost|\[::1\])(:|/|$) ]] \
       && ! [[ "$url" =~ ^http://[a-z2-7]{56}\.onion(:|/|$) ]]; then
        warn "This URL is plain HTTP to a remote host."
        warn "The queue bearer token would cross the network in cleartext — anyone"
        warn "on the path could read and delete your slates. Use https:// or .onion."
        echo -ne "  Continue anyway? [y/N]: "
        local insecure; read -r insecure || true
        if [[ "${insecure,,}" != "y" ]]; then info "Cancelled."; pause; return; fi
    fi

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
        if ! [[ "$owner_port" =~ ^[0-9]+$ ]] || (( owner_port < 1 || owner_port > 65535 )); then
            warn "'$owner_port' is not a port number — using $TRP_OWNER_PORT."
            owner_port="$TRP_OWNER_PORT"
        fi
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
    #
    # Built by node rather than a heredoc: a wallet path containing a quote or
    # backslash would produce a file the agent cannot parse, and the failure
    # ("Cannot read config") points nowhere near the real cause.
    node -e '
        const fs = require("fs");
        const [out, network, url, port, ownerSecret, passFile] = process.argv.slice(1);
        fs.writeFileSync(out, JSON.stringify({
            network,
            transporter_url:       url,
            wallet_owner_url:      `http://127.0.0.1:${port}/v3/owner`,
            wallet_foreign_url:    `http://127.0.0.1:${port}/v2/foreign`,
            wallet_owner_secret:   ownerSecret,
            wallet_foreign_secret: "",
            wallet_pass_file:      passFile,
            min_confirmations:     10,
        }, null, 2) + "\n");
    ' "$TRP_AGENT_CONF" "$TRP_NETWORK" "$url" "$owner_port" "$owner_secret" "$pass_file" \
        || { error "Could not write $TRP_AGENT_CONF"; pause; return; }
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
# Grin Transporter poll agent [$TRP_NET_LABEL] — generated by 093_grin_transporter.sh
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
