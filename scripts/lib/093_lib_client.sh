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

# =============================================================================
# WALLET DISCOVERY
# =============================================================================
# The agent's send path calls init_send_tx / tx_lock_outputs / finalize_tx — all
# Owner API v3 — and its receive path calls receive_tx on the Foreign API. So a
# wallet is usable here ONLY if it runs the COMBINED listener: `grin-wallet
# owner_api` with owner_api_include_foreign = true. A wallet running plain
# `grin-wallet listen` exposes no Owner API at all and can never send.
#
# This scans for that property by reading each wallet's OWN grin-wallet.toml
# rather than re-deriving four products' directory conventions — those move
# (Drop 052→059, Fidelius rename), and a hardcoded path list silently reports
# "no wallet" the day one of them does.

# Read a scalar key out of a grin-wallet.toml. Strips quotes and whitespace.
# `grep | head -1` needs the `|| true`: under `set -o pipefail` a no-match grep
# (rc 1) or a SIGPIPE'd grep (rc 141, when head closes early) fails the whole
# assignment, which is how a dead guard elsewhere in this toolkit went unnoticed.
_trp_toml_get() {
    local file="$1" key="$2" v
    [[ -f "$file" ]] || return 1
    v=$(grep -aE "^[[:space:]]*${key}[[:space:]]*=" "$file" 2>/dev/null | head -1 || true)
    [[ -n "$v" ]] || return 1
    v="${v#*=}"; v="${v%%#*}"; v="${v//\"/}"; v="${v//\'/}"; v="${v//[[:space:]]/}"
    [[ -n "$v" ]] || return 1
    printf '%s\n' "$v"
}

# First existing pass file among the names the toolkit's products actually use.
# Each product picked its own: Drop/pool use `.wallet_pass`, the CMD wallet uses
# `<net>_pass_wallet.txt`. Guessing one name is why option 7's old default
# pointed at a Drop path that did not exist on a Transporter-only box.
_trp_find_pass_file() {
    local dir="$1" n
    for n in ".wallet_pass" "${TRP_NETWORK}_pass_wallet.txt" "wallet_pass.txt" ".pass"; do
        [[ -f "$dir/$n" ]] && { printf '%s\n' "$dir/$n"; return 0; }
    done
    return 1
}

_trp_wallet_label() {
    case "$1" in
        */drop-*)     echo "Grin Drop wallet" ;;
        */cmdwallet/*) echo "CMD wallet (hub 05)" ;;
        */pubpool/*)  echo "Public pool wallet" ;;
        */solo*)      echo "Solo mining wallet" ;;
        */fidelius/*) echo "Fidelius wallet" ;;
        *)            echo "grin-wallet" ;;
    esac
}

# Populates the global TRP_WALLETS array with "dir|port|owner_secret|pass_file|label".
# A global, not stdout: the caller iterates it to build a numbered pick-list, and
# reading a function's output through a pipe would run that loop in a subshell
# where the operator's choice could not escape.
TRP_WALLETS=()
_trp_scan_wallets() {
    TRP_WALLETS=()
    local want_port other_net toml dir port inc secret pass
    want_port="$TRP_OWNER_PORT"
    [[ "$TRP_NETWORK" == "mainnet" ]] && other_net="test" || other_net="main"

    # Depth 1 and 2 under /opt/grin cover every layout the toolkit ships
    # (/opt/grin/drop-main, /opt/grin/cmdwallet/mainnet, /opt/grin/pubpool/mainnet).
    # Root is a variable ONLY so the scan can be exercised against a fixture tree
    # off-box; on a real VPS it is always /opt/grin.
    local root="${TRP_WALLET_SCAN_ROOT:-/opt/grin}"
    shopt -s nullglob
    local -a tomls=( "$root"/*/grin-wallet.toml "$root"/*/*/grin-wallet.toml )
    shopt -u nullglob
    # Expanding an empty array is an unbound-variable error under `set -u` on
    # bash < 4.4 — cheap to guard, and this lib runs on whatever the VPS ships.
    (( ${#tomls[@]} > 0 )) || return 0

    for toml in "${tomls[@]}"; do
        dir="${toml%/grin-wallet.toml}"

        # A wallet dir whose path names the OTHER network is skipped even if the
        # port matches. grin-wallet init writes the MAINNET default 3420 into a
        # testnet wallet's toml, so an unpinned testnet wallet looks like a
        # mainnet one on port alone — and wiring a mainnet agent to it would send
        # real GRIN through a testnet queue. The cost is that such a wallet is
        # INVISIBLE to its own network's scan too (its port reads as the other
        # net's); manual entry covers that. Invisible is the safe failure here.
        [[ "$dir" == *"$other_net"* ]] && continue

        inc=$(_trp_toml_get "$toml" "owner_api_include_foreign" || echo "false")
        [[ "${inc,,}" == "true" ]] || continue
        port=$(_trp_toml_get "$toml" "owner_api_listen_port" || echo "")
        [[ "$port" == "$want_port" ]] || continue
        secret="$dir/.owner_api_secret"
        [[ -f "$secret" ]] || continue
        pass=$(_trp_find_pass_file "$dir" || echo "")

        TRP_WALLETS+=( "$dir|$port|$secret|$pass|$(_trp_wallet_label "$dir")" )
    done
}

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

    # ── Wallet wiring ─────────────────────────────────────────────────────────
    local owner_secret="" pass_file="" owner_port="$TRP_OWNER_PORT" pick="" _wdir=""
    # 093 never defines a Foreign port of its own (the agent only ever talks to the
    # combined Owner port) — derive it here purely to name the mode we CANNOT use.
    local _foreign_port=3415
    [[ "$TRP_NETWORK" == "testnet" ]] && _foreign_port=13415
    _trp_scan_wallets

    echo ""
    if (( ${#TRP_WALLETS[@]} > 0 )); then
        echo -e "  ${DIM}─── Combined-listener wallets found on this box ──────${RESET}"
        echo ""
        local i=1 row _d _p _s _pf _lbl
        for row in "${TRP_WALLETS[@]}"; do
            IFS='|' read -r _d _p _s _pf _lbl <<< "$row"
            echo -e "  ${GREEN}$i${RESET}) ${BOLD}$_lbl${RESET}  ${DIM}$_d  (owner port $_p)${RESET}"
            if [[ -z "$_pf" ]]; then
                echo -e "     ${YELLOW}no passphrase file found in that dir — you will be asked for it${RESET}"
            fi
            i=$((i + 1))
        done
        echo -e "  ${GREEN}M${RESET}) Enter paths manually"
        echo ""
        echo -ne "  Select [1-$(( i - 1 ))/M]: "
        read -r pick || true
    else
        # The old code defaulted to /opt/grin/drop-<net> whether or not Drop was
        # installed, so a Transporter-only box got a config pointing at nothing
        # and only found out at the first send. Say what is missing instead.
        warn "No wallet on this box runs the combined listener the agent needs."
        echo ""
        echo -e "  ${DIM}The agent drives a wallet over HTTP: Owner API v3 for sending${RESET}"
        echo -e "  ${DIM}(init_send_tx / tx_lock_outputs / finalize_tx) and the Foreign API${RESET}"
        echo -e "  ${DIM}for receiving. That needs ONE listener serving both:${RESET}"
        echo ""
        echo -e "    ${BOLD}grin-wallet owner_api${RESET}  ${DIM}with owner_api_include_foreign = true${RESET}"
        echo -e "    ${DIM}on port $TRP_OWNER_PORT, plus a .owner_api_secret in the wallet dir.${RESET}"
        echo ""
        echo -e "  ${DIM}A wallet running plain \`grin-wallet listen\` (Foreign $_foreign_port only)${RESET}"
        echo -e "  ${DIM}cannot be used — it exposes no Owner API, so it can never send.${RESET}"
        echo ""
        echo -e "  ${BOLD}To create one:${RESET} hub ${BOLD}05${RESET} → CMD Wallet Quick Setup → pick your"
        echo -e "  network → at ${BOLD}Listener mode${RESET} choose ${BOLD}owner_api${RESET}. Then re-run this option."
        echo -e "  ${DIM}A Grin Drop, public-pool or solo-mining wallet also qualifies.${RESET}"
        echo ""
        echo -ne "  Enter paths manually anyway? [y/N]: "
        local go; read -r go || true
        if [[ "${go,,}" != "y" ]]; then info "Nothing was installed or changed."; pause; return; fi
        pick="M"
    fi

    if [[ "${pick^^}" == "M" ]]; then
        echo ""
        echo -e "  ${DIM}Manual wallet wiring (paths on THIS box):${RESET}"
        local wdir
        echo -ne "  Wallet dir: "
        read -r wdir || true
        wdir="${wdir%/}"
        if [[ -z "$wdir" ]]; then error "A wallet dir is required."; pause; return; fi
        echo -ne "  Owner API port [$TRP_OWNER_PORT]: "
        read -r owner_port || true
        owner_port="${owner_port:-$TRP_OWNER_PORT}"
        if ! [[ "$owner_port" =~ ^[0-9]+$ ]] || (( owner_port < 1 || owner_port > 65535 )); then
            warn "'$owner_port' is not a port number — using $TRP_OWNER_PORT."
            owner_port="$TRP_OWNER_PORT"
        fi
        owner_secret="$wdir/.owner_api_secret"
        pass_file=$(_trp_find_pass_file "$wdir" || echo "")
        echo -ne "  Wallet passphrase file [${pass_file:-none found}]: "
        local pf_in; read -r pf_in || true
        pass_file="${pf_in:-$pass_file}"
    else
        if ! [[ "$pick" =~ ^[0-9]+$ ]] || (( pick < 1 || pick > ${#TRP_WALLETS[@]} )); then
            error "'$pick' is not one of the listed wallets."
            pause; return
        fi
        local _lbl2
        IFS='|' read -r _wdir owner_port owner_secret pass_file _lbl2 <<< "${TRP_WALLETS[$(( pick - 1 ))]}"
        info "Using: $_lbl2 — $_wdir"
        # Drop records its pass file in its own conf, which may point OUTSIDE the
        # wallet dir — so the in-dir name scan legitimately finds nothing there.
        if [[ -z "$pass_file" ]]; then
            local drop_conf="/opt/grin/drop-${TRP_NET_SHORT}/grin_drop_${TRP_NET_SHORT}.conf"
            if [[ "$_wdir" == *"/drop-${TRP_NET_SHORT}" && -f "$drop_conf" ]]; then
                pass_file=$(_trp_json_get "$drop_conf" "wallet_pass_file" "")
                [[ -n "$pass_file" ]] && info "Passphrase file from the Drop config: $pass_file"
            fi
        fi
        if [[ -z "$pass_file" ]]; then
            echo -ne "  Wallet passphrase file: "
            read -r pass_file || true
        fi
    fi

    if [[ ! -f "$owner_secret" ]]; then
        warn "Owner secret not found at $owner_secret — the agent will fail until it exists."
    fi
    if [[ -z "$pass_file" || ! -f "$pass_file" ]]; then
        warn "Pass file not found at ${pass_file:-<empty>} — the agent will fail until it exists."
        warn "  The agent needs it to call open_wallet; it never prompts."
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
