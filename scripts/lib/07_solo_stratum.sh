# 07_solo_stratum.sh — stratum menu and stratum watchdog menu of the solo mining script: enable, configure, restrict, watchdog cron.
# Sourced by 07_grin_mining_solo.sh; shares its globals and log/info/warn/error.
# Moved as-is; callers reach these via `fn || …`, so errexit is off and file operations are not individually guarded.

_sed_escape_rhs() { printf '%s' "$1" | sed 's/[\\&|]/\\&/g'; }

# ═══════════════════════════════════════════════════════════════════════════════
# SETUP & PUBLISH STRATUM  (per-net branch ▸ Stratum ▸ 1)
# ═══════════════════════════════════════════════════════════════════════════════
# One command: enable stratum + wallet listener URL in grin-server.toml, then
# flow straight into Publish (bind 0.0.0.0 + firewall + node restart). The old
# separate Publish step is gone from the menu — _enable_stratum is called here.

_do_setup_stratum() {
    local network="$1" stratum_port="$2" api_port="$3"
    local label="Mainnet"
    [[ "$network" == "testnet" ]] && label="Testnet"

    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Setup & Publish Stratum — $label (port $stratum_port)${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Enables the stratum server in grin-server.toml, sets the wallet"
    echo -e "  listener URL for coinbase block rewards, then publishes the port"
    echo -e "  so miners can connect (bind 0.0.0.0 + firewall + node restart)."
    echo ""

    find_grin_server_toml "$network" "$api_port" || return
    local grin_toml="$FOUND_GRIN_TOML"
    echo ""

    echo -e "${BOLD}Current stratum settings in:${RESET} $grin_toml"
    local cur_enable cur_wallet
    cur_enable=$(grep -E '^[[:space:]]*enable_stratum_server[[:space:]]*=' "$grin_toml" 2>/dev/null | head -1 || true)
    cur_wallet=$(grep -E '^[[:space:]]*wallet_listener_url[[:space:]]*=' "$grin_toml" 2>/dev/null | head -1 || true)
    echo -e "  enable_stratum_server : ${cur_enable:-${DIM}(not set)${RESET}}"
    echo -e "  wallet_listener_url   : ${cur_wallet:-${DIM}(not set)${RESET}}"
    echo ""

    echo -ne "Enable stratum server (enable_stratum_server = true)? [Y/n/0]: "
    read -r en_choice
    [[ "$en_choice" == "0" ]] && return
    if [[ "${en_choice,,}" != "n" ]]; then
        if grep -qE '^#?[[:space:]]*enable_stratum_server[[:space:]]*=' "$grin_toml" 2>/dev/null; then
            sed -i -E \
                "s|^#?[[:space:]]*enable_stratum_server[[:space:]]*=.*|enable_stratum_server = true|" \
                "$grin_toml"
        else
            echo "enable_stratum_server = true" >> "$grin_toml"
        fi
        success "enable_stratum_server = true"
        log "Setup ($network): enable_stratum_server = true in $grin_toml"
    fi

    # BASE URL only — the node appends /v2/foreign itself when calling
    # build_coinbase; a stored ".../v2/foreign" doubles the path and 404s.
    # Owner port: the solo wallet is a combined Owner+Foreign listener, so the
    # coinbase Foreign API lives on 3420/13420 (owner_api_include_foreign).
    local default_wallet_url="http://127.0.0.1:3420"
    [[ "$network" == "testnet" ]] && default_wallet_url="http://127.0.0.1:13420"
    echo ""
    echo -e "${BOLD}Wallet listener URL${RESET} — where coinbase block rewards are sent."
    echo -e "  Default for local wallet: ${DIM}$default_wallet_url${RESET}  ${DIM}(base URL — the node adds /v2/foreign itself)${RESET}"
    echo -ne "Enter wallet_listener_url (Enter for default, 0 to skip): "
    read -r wallet_url
    [[ "$wallet_url" == "0" ]] && wallet_url=""

    # A stored value is "legacy" and must be normalised if it carries the
    # /v2/foreign suffix (older setups wrote it → doubles the path) OR still
    # points at the old Foreign port 3415/13415 (pre-combined-listener; grin's
    # stock toml ships this uncommented). The solo wallet now serves the Foreign
    # build_coinbase on the Owner port (3420/13420, owner_api_include_foreign),
    # so a surviving 3415 leaves the node calling a dead port → no coinbase.
    local legacy_wallet=0
    if [[ "$cur_wallet" == *"/v2/foreign\""* || "$cur_wallet" == *":3415\""* || "$cur_wallet" == *":13415\""* ]]; then
        legacy_wallet=1
    fi
    # Rewrite when: the operator typed a URL, none is set yet, OR the stored one
    # is legacy (stale path or old Foreign port).
    if [[ -n "$wallet_url" || -z "$cur_wallet" || $legacy_wallet -eq 1 ]]; then
        local new_url="${wallet_url:-$default_wallet_url}"
        # Legacy value normalised with Enter → snap to the network's Owner-port
        # default (solo wallet is always local, so 127.0.0.1:<owner_port>).
        [[ -z "$wallet_url" && $legacy_wallet -eq 1 ]] && new_url="$default_wallet_url"
        new_url="${new_url%/}"; new_url="${new_url%/v2/foreign}"
        local esc_url; esc_url=$(_sed_escape_rhs "$new_url")
        if grep -qE '^#?[[:space:]]*wallet_listener_url[[:space:]]*=' "$grin_toml" 2>/dev/null; then
            sed -i -E \
                "s|^#?[[:space:]]*wallet_listener_url[[:space:]]*=.*|wallet_listener_url = \"$esc_url\"|" \
                "$grin_toml"
        else
            echo "wallet_listener_url = \"$new_url\"" >> "$grin_toml"
        fi
        success "wallet_listener_url = \"$new_url\""
        log "Setup ($network): wallet_listener_url = $new_url in $grin_toml"
    fi

    # burn_reward — always force the safe default (keep rewards). This is a
    # testing-only flag that discards coinbase; we never prompt for it so a
    # solo miner can't accidentally burn real block rewards. A tester who
    # genuinely wants to burn can set it by hand in grin-server.toml.
    if grep -qE '^#?[[:space:]]*burn_reward[[:space:]]*=' "$grin_toml" 2>/dev/null; then
        sed -i -E \
            "s|^#?[[:space:]]*burn_reward[[:space:]]*=.*|burn_reward = false|" \
            "$grin_toml"
    else
        echo "burn_reward = false" >> "$grin_toml"
    fi
    log "Setup ($network): burn_reward = false (forced) in $grin_toml"

    echo ""
    success "Stratum setup complete for $network — continuing to Publish..."
    echo ""
    if ! _enable_stratum "$network" "$stratum_port" "$api_port"; then
        info "Publish skipped — stratum stays bound to 127.0.0.1."
        echo -e "  Re-run ${BOLD}Stratum ▸ 1) Setup & Publish${RESET} when ready to open it to miners."
        echo -e "  Restart the grin node to apply the setup changes made above."
    fi
}

setup_stratum_mainnet() { _do_setup_stratum mainnet "$STRATUM_PORT_MAINNET" "$NODE_API_PORT_MAINNET"; }

setup_stratum_testnet() { _do_setup_stratum testnet "$STRATUM_PORT_TESTNET" "$NODE_API_PORT_TESTNET"; }

# ═══════════════════════════════════════════════════════════════════════════════
# MANUAL STRATUM CONFIG  (per-net branch ▸ Stratum ▸ 2)
# ═══════════════════════════════════════════════════════════════════════════════
# Single-field editor for operators who want to hand-tune one value; the normal
# path is 1) Setup & Publish, which sets everything automatically.

_do_configure_stratum() {
    local network="$1" stratum_port="$2" api_port="$3"
    local label="Mainnet"; [[ "$network" == "testnet" ]] && label="Testnet"

    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Manual Stratum Config — $label (port $stratum_port)${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    find_grin_server_toml "$network" "$api_port" || return
    local grin_toml="$FOUND_GRIN_TOML"
    echo ""

    echo -e "${BOLD}Current settings in:${RESET} $grin_toml"
    echo ""
    local cur_enable cur_addr cur_wallet
    cur_enable=$(grep -E '^[[:space:]]*enable_stratum_server[[:space:]]*=' "$grin_toml" 2>/dev/null | head -1 | sed 's/.*=[[:space:]]*//' | xargs || true)
    cur_addr=$(grep -E '^[[:space:]]*stratum_server_addr[[:space:]]*=' "$grin_toml" 2>/dev/null | head -1 | sed 's/.*=[[:space:]]*//' | tr -d '"' | xargs || true)
    cur_wallet=$(grep -E '^[[:space:]]*wallet_listener_url[[:space:]]*=' "$grin_toml" 2>/dev/null | head -1 | sed 's/.*=[[:space:]]*//' | tr -d '"' | xargs || true)
    echo -e "  ${GREEN}1${RESET}) enable_stratum_server : ${cur_enable:-${DIM}not set${RESET}}"
    echo -e "  ${GREEN}2${RESET}) stratum_server_addr   : ${cur_addr:-${DIM}not set${RESET}}"
    echo -e "  ${GREEN}3${RESET}) wallet_listener_url   : ${cur_wallet:-${DIM}not set${RESET}}"
    echo -e "  ${DIM}0) Cancel${RESET}"
    echo ""
    echo -ne "Which setting to change [1-3/0]: "
    read -r cfg_choice
    [[ "$cfg_choice" == "0" || -z "$cfg_choice" ]] && return

    local changed=false
    case "$cfg_choice" in
        1)
            echo -ne "Set enable_stratum_server [true/false] (current: ${cur_enable:-not set}): "
            read -r new_val
            [[ -z "$new_val" ]] && return
            if [[ "$new_val" != "true" && "$new_val" != "false" ]]; then
                warn "Must be exactly 'true' or 'false' — not changed."; return
            fi
            local esc_val; esc_val=$(_sed_escape_rhs "$new_val")
            if grep -qE '^#?[[:space:]]*enable_stratum_server[[:space:]]*=' "$grin_toml" 2>/dev/null; then
                sed -i -E "s|^#?[[:space:]]*enable_stratum_server[[:space:]]*=.*|enable_stratum_server = $esc_val|" "$grin_toml"
            else
                echo "enable_stratum_server = $new_val" >> "$grin_toml"
            fi
            success "enable_stratum_server = $new_val"
            log "Configure ($network): enable_stratum_server = $new_val"
            changed=true
            ;;
        2)
            echo -e "  Options: ${DIM}0.0.0.0:$stratum_port${RESET}  (public)  or  ${DIM}127.0.0.1:$stratum_port${RESET}  (localhost only)"
            echo -ne "New stratum_server_addr (current: ${cur_addr:-not set}): "
            read -r new_addr
            [[ -z "$new_addr" ]] && return
            if [[ ! "$new_addr" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]{1,5}$ ]]; then
                warn "Expected host:port like 0.0.0.0:$stratum_port — not changed."; return
            fi
            local esc_addr; esc_addr=$(_sed_escape_rhs "$new_addr")
            if grep -qE '^#?[[:space:]]*stratum_server_addr[[:space:]]*=' "$grin_toml" 2>/dev/null; then
                sed -i -E "s|^#?[[:space:]]*stratum_server_addr[[:space:]]*=.*|stratum_server_addr = \"$esc_addr\"|" "$grin_toml"
            else
                echo "stratum_server_addr = \"$new_addr\"" >> "$grin_toml"
            fi
            success "stratum_server_addr = \"$new_addr\""
            log "Configure ($network): stratum_server_addr = $new_addr"
            changed=true
            ;;
        3)
            echo -ne "New wallet_listener_url (current: ${cur_wallet:-not set}): "
            read -r new_wallet
            [[ -z "$new_wallet" ]] && return
            local esc_wallet; esc_wallet=$(_sed_escape_rhs "$new_wallet")
            if grep -qE '^#?[[:space:]]*wallet_listener_url[[:space:]]*=' "$grin_toml" 2>/dev/null; then
                sed -i -E "s|^#?[[:space:]]*wallet_listener_url[[:space:]]*=.*|wallet_listener_url = \"$esc_wallet\"|" "$grin_toml"
            else
                echo "wallet_listener_url = \"$new_wallet\"" >> "$grin_toml"
            fi
            success "wallet_listener_url = \"$new_wallet\""
            log "Configure ($network): wallet_listener_url = $new_wallet"
            changed=true
            ;;
        *)
            warn "Invalid choice."
            return
            ;;
    esac

    if [[ "$changed" == "true" ]]; then
        echo ""
        graceful_restart_grin "$api_port" "$network"
    fi
}

configure_stratum_mainnet() { _do_configure_stratum mainnet "$STRATUM_PORT_MAINNET" "$NODE_API_PORT_MAINNET"; }

configure_stratum_testnet() { _do_configure_stratum testnet "$STRATUM_PORT_TESTNET" "$NODE_API_PORT_TESTNET"; }

# ═══════════════════════════════════════════════════════════════════════════════
# PORT GUIDE
# ═══════════════════════════════════════════════════════════════════════════════

_show_stratum_port_guide() {
    local port="$1"
    local label="Mainnet"
    [[ "$port" == "$STRATUM_PORT_TESTNET" ]] && label="Testnet"
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Publish Stratum — $label (port $port)${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    if [[ "${SOLO_NET_MODE:-public}" == "lan" ]]; then
        echo -e "  Publishing binds grin to ${BOLD}0.0.0.0:$port${RESET} so miners on your LAN can"
        echo -e "  reach this node. Point a miner (e.g. G1 mini) at this server's"
        echo -e "  ${BOLD}LAN IP:$port${RESET} — no domain or public IP needed."
    else
        echo -e "  Publishing binds grin to ${BOLD}0.0.0.0:$port${RESET} so your miners (or friends')"
        echo -e "  can reach this node. Point a miner (e.g. G1 mini) at your stratum"
        echo -e "  ${BOLD}domain${RESET} or ${BOLD}YOUR_SERVER_IP:$port${RESET}. Required for any remote mining."
    fi
    echo ""
    echo -ne "${BOLD}Proceed? [Y/n]: ${RESET}"
    read -r _guide_confirm || true
    [[ "${_guide_confirm,,}" == "n" ]] && { info "Cancelled."; return 1; }
    return 0
}

# ═══════════════════════════════════════════════════════════════════════════════
# PUBLISH / RESTRICT STRATUM  (publish runs inside Setup & Publish ▸ 1; restrict ▸ 3)
# ═══════════════════════════════════════════════════════════════════════════════

# Post-publish connection watch. Manual-refresh (Enter = re-check · 0 = return) to
# match every other 07 screen — NOT a Ctrl-C trap. Reuses the same ss idiom as
# _show_node_info. A rig usually appears ~1 min after the pool config is saved and
# it reconnects, so this closes the loop at the moment the operator most wants to
# know "did it connect?".
#   $1 = stratum port   $2 = network label (Mainnet|Testnet)   $3 = miner URL
_solo_watch_for_miner() {
    local stratum_port="$1" label="$2" url="$3" n k
    while true; do
        n=$(ss -tnp 2>/dev/null | grep ":$stratum_port" | grep -c ESTAB || true)
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Waiting for a miner — $label (port $stratum_port)${RESET}  ${DIM}($(date -u '+%H:%M:%S UTC'))${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  ${BOLD}Miner Pool / Server:${RESET}  ${BOLD}${CYAN}$url${RESET}"
        echo ""
        if [[ "${n:-0}" -gt 0 ]]; then
            echo -e "  ${GREEN}✓ Miner connected!${RESET}  ${BOLD}$n${RESET} connection(s) on port $stratum_port"
            echo ""
            ss -tnp 2>/dev/null | grep ":$stratum_port" | grep ESTAB \
                | awk '{print $5}' | head -5 | sed 's/^/      from /' || true
        else
            echo -e "  ${YELLOW}No miner connected yet.${RESET}  ${DIM}(0 established on port $stratum_port)${RESET}"
            echo ""
            echo -e "  ${DIM}A rig usually appears ~1 min after you save the pool config above and${RESET}"
            echo -e "  ${DIM}it reconnects (the node must also have restarted after Publish). If${RESET}"
            echo -e "  ${DIM}nothing shows after a few minutes, double-check on the miner:${RESET}"
            echo -e "    ${DIM}· Pool/Server matches the URL above${RESET}"
            echo -e "    ${DIM}· that IP is internet-reachable (firewall open, not a private/NAT addr)${RESET}"
        fi
        echo ""
        echo -e "  ${DIM}↩  Enter to refresh status${RESET}"
        echo -e "  ${RED}0${RESET}) Return"
        echo ""
        echo -ne "${BOLD}Select [Enter/0]: ${RESET}"
        read -r k || k=0
        [[ "$k" == "0" ]] && return
    done
}

_enable_stratum() {
    local network="$1" stratum_port="$2" api_port="$3"

    _show_stratum_port_guide "$stratum_port" || return
    echo ""

    find_grin_server_toml "$network" "$api_port" || return
    local grin_toml="$FOUND_GRIN_TOML"

    info "Patching $grin_toml ..."
    if grep -qE '^#?[[:space:]]*stratum_server_addr[[:space:]]*=' "$grin_toml" 2>/dev/null; then
        sed -i -E \
            "s|^#?[[:space:]]*stratum_server_addr[[:space:]]*=.*|stratum_server_addr = \"0.0.0.0:${stratum_port}\"|" \
            "$grin_toml"
    else
        echo "stratum_server_addr = \"0.0.0.0:${stratum_port}\"" >> "$grin_toml"
    fi
    success "stratum_server_addr = \"0.0.0.0:$stratum_port\" written to grin-server.toml"
    log "Stratum ($network) published: patched $grin_toml -> 0.0.0.0:$stratum_port"

    echo ""
    echo -e "${BOLD}Open firewall port $stratum_port for miners:${RESET}"
    echo -e "  ${GREEN}1${RESET}) Open to all IPs  ${DIM}(recommended)${RESET}"
    echo -e "  ${YELLOW}2${RESET}) Open to specific IP only"
    echo -e "  ${RED}3${RESET}) Skip firewall changes"
    echo -ne "Choice [1]: "
    read -r fw_choice

    case "${fw_choice:-1}" in
        1)
            if command -v ufw &>/dev/null; then
                ufw allow "$stratum_port/tcp"
                success "UFW: port $stratum_port opened to all."
            elif command -v iptables &>/dev/null; then
                # -C guard so re-running Publish does not stack duplicate ACCEPT rules.
                if ! iptables -C INPUT -p tcp --dport "$stratum_port" -j ACCEPT 2>/dev/null; then
                    iptables -I INPUT -p tcp --dport "$stratum_port" -j ACCEPT
                fi
                if command -v netfilter-persistent &>/dev/null; then
                    netfilter-persistent save 2>/dev/null || true
                elif [[ -d /etc/iptables ]]; then
                    iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
                fi
                success "iptables: port $stratum_port opened to all."
            else
                warn "No firewall tool found. Configure manually."
            fi
            ;;
        2)
            echo -ne "Enter allowed IP (or 0 to skip): "
            read -r allowed_ip
            [[ "$allowed_ip" == "0" ]] && allowed_ip=""
            # Reject anything that is not a bare IPv4 or IPv4/CIDR before it
            # reaches ufw/iptables (a typo would otherwise write a broken rule).
            if [[ -n "$allowed_ip" && ! "$allowed_ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}(/[0-9]{1,2})?$ ]]; then
                warn "Not a valid IPv4 address or CIDR — skipping firewall rule."
                allowed_ip=""
            fi
            if [[ -n "$allowed_ip" ]]; then
                if command -v ufw &>/dev/null; then
                    ufw allow from "$allowed_ip" to any port "$stratum_port" proto tcp
                    success "UFW: port $stratum_port opened for $allowed_ip."
                elif command -v iptables &>/dev/null; then
                    if ! iptables -C INPUT -s "$allowed_ip" -p tcp --dport "$stratum_port" -j ACCEPT 2>/dev/null; then
                        iptables -I INPUT -s "$allowed_ip" -p tcp --dport "$stratum_port" -j ACCEPT
                    fi
                    if command -v netfilter-persistent &>/dev/null; then
                        netfilter-persistent save 2>/dev/null || true
                    elif [[ -d /etc/iptables ]]; then
                        iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
                    fi
                    success "iptables: port $stratum_port opened for $allowed_ip."
                fi
            fi
            ;;
        *) info "Firewall not modified." ;;
    esac

    echo ""
    graceful_restart_grin "$api_port" "$network"

    local label="Mainnet"; [[ "$network" == "testnet" ]] && label="Testnet"
    # LAN mode advertises the server's LAN IP (miners are on the same network) so the
    # stratum target matches the LAN stats page; Internet mode advertises the public IP.
    local lan_mode=0
    [[ "${SOLO_NET_MODE:-public}" == "lan" ]] && lan_mode=1
    local pub_ip conn_host
    if [[ $lan_mode -eq 1 ]]; then
        pub_ip=$(_detect_lan_ipv4)
        conn_host="${pub_ip:-YOUR_LAN_IP}"
    else
        # Sets globals $_DETECTED_PUBLIC_IP + $_IP_DETECT_NOTE (can't return them via
        # $(...) — that subshell would discard the note global).
        _detect_public_ipv4 || true
        pub_ip="$_DETECTED_PUBLIC_IP"
        conn_host="${pub_ip:-YOUR_SERVER_IP}"
    fi
    local url="stratum+tcp://${conn_host}:${stratum_port}"

    echo ""
    echo -e "${BOLD}${GREEN}┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${RESET}"
    echo -e "${BOLD}${GREEN}┃${RESET}  ${BOLD}Put this in your miner's Pool / Server field ($label):${RESET}"
    echo -e "${BOLD}${GREEN}┃${RESET}"
    echo -e "${BOLD}${GREEN}┃${RESET}      ${BOLD}${CYAN}$url${RESET}"
    echo -e "${BOLD}${GREEN}┃${RESET}"
    echo -e "${BOLD}${GREEN}┃${RESET}  ${BOLD}Worker / Login:${RESET} any nickname you like — ${CYAN}e.g. myname.rig1${RESET}"
    echo -e "${BOLD}${GREEN}┃${RESET}  ${DIM}(text before the dot groups earnings if payout-split is on)${RESET}"
    echo -e "${BOLD}${GREEN}┃${RESET}"
    if [[ $lan_mode -eq 1 ]]; then
        if [[ -n "$pub_ip" ]]; then
            echo -e "${BOLD}${GREEN}┃${RESET}  ${DIM}Detected LAN IPv4: $pub_ip · port $stratum_port ($label)${RESET}"
        else
            echo -e "${BOLD}${GREEN}┃${RESET}  ${YELLOW}Could not auto-detect a LAN IP — replace YOUR_LAN_IP above.${RESET}"
        fi
        echo -e "${BOLD}${GREEN}┃${RESET}  ${DIM}LAN miners connect to this private IP directly — no domain/DNS needed.${RESET}"
    else
        if [[ -n "$pub_ip" ]]; then
            echo -e "${BOLD}${GREEN}┃${RESET}  ${DIM}Detected public IPv4: $pub_ip · port $stratum_port ($label)${RESET}"
            [[ -n "$_IP_DETECT_NOTE" ]] && \
                echo -e "${BOLD}${GREEN}┃${RESET}  ${DIM}↳ $_IP_DETECT_NOTE${RESET}"
        else
            echo -e "${BOLD}${GREEN}┃${RESET}  ${YELLOW}Could not auto-detect public IP — replace YOUR_SERVER_IP above.${RESET}"
        fi
        echo -e "${BOLD}${GREEN}┃${RESET}  ${DIM}Using a domain instead? On Cloudflare the A record MUST be${RESET}"
        echo -e "${BOLD}${GREEN}┃${RESET}  ${DIM}\"DNS only\" (grey cloud), NOT proxied — miners can't reach a${RESET}"
        echo -e "${BOLD}${GREEN}┃${RESET}  ${DIM}proxied record; fall back to the raw IP above (e.g. iPollo G1).${RESET}"
    fi
    echo -e "${BOLD}${GREEN}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${RESET}"

    echo ""
    echo -ne "  ${BOLD}Watch for your first miner to connect?${RESET} ${DIM}[Y/n]${RESET}: "
    read -r _watch_choice || true
    [[ "${_watch_choice,,}" == "n" ]] || _solo_watch_for_miner "$stratum_port" "$label" "$url"
}

_disable_stratum() {
    local network="$1" stratum_port="$2" api_port="$3"

    echo -e "\n${BOLD}${CYAN}── Restrict Stratum ($network, port $stratum_port) to Localhost ──${RESET}\n"

    find_grin_server_toml "$network" "$api_port" || return
    local grin_toml="$FOUND_GRIN_TOML"

    info "Patching $grin_toml ..."
    if grep -qE '^#?[[:space:]]*stratum_server_addr[[:space:]]*=' "$grin_toml" 2>/dev/null; then
        sed -i -E \
            "s|^#?[[:space:]]*stratum_server_addr[[:space:]]*=.*|stratum_server_addr = \"127.0.0.1:${stratum_port}\"|" \
            "$grin_toml"
    else
        echo "stratum_server_addr = \"127.0.0.1:${stratum_port}\"" >> "$grin_toml"
    fi
    success "stratum_server_addr reverted to 127.0.0.1:$stratum_port"
    log "Stratum ($network) restricted: patched $grin_toml -> 127.0.0.1:$stratum_port"

    echo -ne "Close firewall port $stratum_port? [Y/n/0]: "
    read -r close_fw
    if [[ "${close_fw,,}" != "n" && "$close_fw" != "0" ]]; then
        # NOTE: the node now binds 127.0.0.1, so any leftover firewall ALLOW for
        # this port is moot (nothing external is listening). We remove the all-IPs
        # rule(s) best-effort; a per-IP allow added via "specific IP" can't be
        # matched without the original IP and is harmless — remove it manually if
        # you want a clean ruleset (ufw status numbered / iptables -S).
        if command -v ufw &>/dev/null; then
            ufw delete allow "$stratum_port/tcp" 2>/dev/null || true
            success "UFW: removed all-IPs allow for port $stratum_port."
        elif command -v iptables &>/dev/null; then
            # Drain duplicates that older (pre-guard) Publish runs may have stacked.
            while iptables -D INPUT -p tcp --dport "$stratum_port" -j ACCEPT 2>/dev/null; do :; done
            if command -v netfilter-persistent &>/dev/null; then
                netfilter-persistent save 2>/dev/null || true
            elif [[ -d /etc/iptables ]]; then
                iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
            fi
            success "iptables: removed all-IPs allow for port $stratum_port."
        fi
    fi

    echo ""
    graceful_restart_grin "$api_port" "$network"
}

restrict_mainnet_stratum() { _disable_stratum mainnet "$STRATUM_PORT_MAINNET" "$NODE_API_PORT_MAINNET"; }

restrict_testnet_stratum() { _disable_stratum testnet "$STRATUM_PORT_TESTNET" "$NODE_API_PORT_TESTNET"; }

# ═══════════════════════════════════════════════════════════════════════════════
# STRATUM WATCHDOG CRON  (Health / Watchdogs ▸ 7 install · 8 remove)
# ═══════════════════════════════════════════════════════════════════════════════
# Cron entry: every 5 minutes, verify stratum is enabled in grin-server.toml.
# Logs a warning if stratum config was lost (e.g. node restart reset the toml).

# Fixed paths shared by the stratum-watchdog install/remove/status trio.
STRATUM_WATCHDOG_CRON="/etc/cron.d/grin-stratum-watchdog"

STRATUM_WATCHDOG_BIN="/usr/local/bin/grin-stratum-watchdog"

# solo_stratum_watchdog_status — cron presence + recent log tail (mirrors
# sw_watchdog_status / gnk_watchdog_status so the Health menu reads uniformly).
solo_stratum_watchdog_status() {
    if [[ -f "$STRATUM_WATCHDOG_CRON" && -x "$STRATUM_WATCHDOG_BIN" ]]; then
        success "Stratum watchdog: INSTALLED ($STRATUM_WATCHDOG_CRON)"
    else
        warn "Stratum watchdog: NOT installed."
    fi
    [[ -f "$WATCHDOG_LOG" ]] && { info "Recent log:"; tail -n 6 "$WATCHDOG_LOG" 2>/dev/null || true; }
}

# solo_stratum_watchdog_remove — drop cron.d entry + wrapper (idempotent).
solo_stratum_watchdog_remove() {
    rm -f "$STRATUM_WATCHDOG_CRON" "$STRATUM_WATCHDOG_BIN"
    success "Stratum watchdog removed."
}

# solo_stratum_watchdog_install — write wrapper + cron.d entry (every 5 min).
# Non-interactive and idempotent, matching the other watchdog installers; the
# menu owns presentation.
solo_stratum_watchdog_install() {
    local cron_file="$STRATUM_WATCHDOG_CRON"
    local wrapper="$STRATUM_WATCHDOG_BIN"

    # Bake the search DIRS (not a one-time snapshot of the tomls that happen to
    # exist now) so a node built AFTER the watchdog is installed is picked up on
    # the next run — the wrapper re-scans these dirs every time it fires.
    local search_dirs_literal="" dir
    for dir in "${_KNOWN_TOML_SEARCH_PATHS[@]}"; do
        search_dirs_literal+="    \"$dir\""$'\n'
    done

    mkdir -p "$LOG_DIR"

    cat > "$wrapper" << WATCHDOG
#!/bin/bash
# Grin stratum watchdog — verifies stratum is enabled in grin-server.toml AND
# the configured stratum port is actually listening (catches a node restart that
# reset the toml, or a stratum that failed to bind).
set -euo pipefail

LOG="$WATCHDOG_LOG"
TS=\$(date -u '+%Y-%m-%d %H:%M:%S UTC')
WARNED=false

SEARCH_DIRS=(
$search_dirs_literal)
for DIR in "\${SEARCH_DIRS[@]}"; do
    TOML_PATH="\$DIR/grin-server.toml"
    [[ -f "\$TOML_PATH" ]] || continue
    ENABLED=\$(grep -E '^[[:space:]]*enable_stratum_server[[:space:]]*=' "\$TOML_PATH" 2>/dev/null \
        | head -1 | sed 's/.*=[[:space:]]*//' | tr -d ' ' || echo "")
    ADDR=\$(grep -E '^[[:space:]]*stratum_server_addr[[:space:]]*=' "\$TOML_PATH" 2>/dev/null \
        | head -1 | sed 's/.*=[[:space:]]*//' | tr -d '" ' || echo "")
    PORT="\${ADDR##*:}"

    if [[ "\$ENABLED" != "true" ]]; then
        echo "[\$TS] WARN: enable_stratum_server not true in \$TOML_PATH (found: '\${ENABLED:-not set}')" >> "\$LOG"
        WARNED=true
        continue
    fi

    # Config says enabled — confirm the port is live. Enabled but no listener
    # means the node is down or stratum failed to bind.
    if [[ -n "\$PORT" ]] && ! ss -tln 2>/dev/null | grep -q ":\$PORT "; then
        echo "[\$TS] WARN: stratum enabled in \$TOML_PATH but port \$PORT is NOT listening" >> "\$LOG"
        WARNED=true
    fi
done

if [[ "\$WARNED" == "false" ]]; then
    echo "[\$TS] OK: stratum enabled and listening for all detected grin-server.toml files" >> "\$LOG"
fi
WATCHDOG
    chmod 750 "$wrapper"

    cat > "$cron_file" << EOF
*/5 * * * * root $wrapper
EOF
    success "Stratum watchdog installed (*/5) → $cron_file"
    info "Log: $WATCHDOG_LOG"
}
