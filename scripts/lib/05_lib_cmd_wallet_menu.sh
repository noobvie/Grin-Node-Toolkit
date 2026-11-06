# =============================================================================
# 05_lib_cmd_wallet_menu.sh — CMD wallet screens and the network check
# =============================================================================
#
#  Sourced by 05_grin_wallet_service.sh, which owns the primitives these screens
#  call (_cmd_dir, _cmd_retire_wallet, _cmd_start_listener, the setup flow, ...).
#
#  The flow is network first, then action: the overview picks a network, and that
#  network's screen holds every action. No action has to ask "which network?".
#
#  One wallet per network: ports, the tmux name, the 089 registry key and the
#  Transporter's wallet scan are all keyed on the network. So Add fills an empty
#  network, Renew replaces its wallet and Wipe empties it. Keys are fixed: a row
#  that does not apply prints dimmed with the reason and its key explains itself.
#
#  This lib runs without errexit (every caller is `fn || true`), so each step that
#  changes the disk carries its own failure branch.
# =============================================================================

# ─── Wallet ↔ network check ─────────────────────────────────────────────────
# grin-wallet takes its chain from `chain_type` in the toml whenever a toml exists
# (src/bin/grin-wallet.rs → init_global_chain_type); --testnet only decides what a
# NEW toml gets. So a testnet toml in the mainnet dir runs as testnet with no flag
# at all, and the port setup pins from the dir name makes it look like mainnet.
# The toml is the only place this can be read without a passphrase.
_cmd_expected_chain() { [[ "${1:-}" == "testnet" ]] && echo "Testnet" || echo "Mainnet"; }

_cmd_toml_get() {
    sed -nE "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*\"?([^\"]*)\"?[[:space:]]*$/\1/p" \
        "$1" 2>/dev/null | head -1 || true
}

# host[:port] of a node URL, without scheme or path.
_cmd_addr_authority() { local a="${1#*://}"; echo "${a%%/*}"; }

# A node address on this box. A remote node is the operator's choice, and its port
# says nothing about its network, so only a local address is checked or rewritten.
# It also must never receive a local secret: grin-wallet sends that secret as Basic
# Auth to whatever node the toml names. The host is compared exactly, because a
# substring match would call localhost.example.com local.
_cmd_addr_is_local() {
    local a; a=$(_cmd_addr_authority "$1")
    case "${a%:*}" in
        127.0.0.1|localhost|0.0.0.0|"[::1]") return 0 ;;
        *) return 1 ;;
    esac
}

_cmd_addr_port() {
    local a; a=$(_cmd_addr_authority "$1")
    if [[ "$a" == *:* ]]; then echo "${a##*:}"; fi
}

# The configured data dir when it is outside this wallet's own dir. The wallet then
# runs on someone else's data, and Renew and Wipe would not touch what is in use.
_cmd_foreign_data_dir() {
    local d; d=$(_cmd_toml_get "$(_cmd_toml "$1")" data_file_dir)
    if [[ -n "$d" && "$d" != "$(_cmd_dir "$1")"/* ]]; then echo "$d"; fi
}

# One line per thing wrong with this network's toml; no output = it matches. No
# toml means no wallet, which is not a mismatch.
_cmd_net_problems() {
    local net="$1" toml chain want addr port data
    toml=$(_cmd_toml "$net")
    [[ -f "$toml" ]] || return 0
    want=$(_cmd_expected_chain "$net"); port=$(_cmd_node_port "$net")
    chain=$(_cmd_toml_get "$toml" chain_type)
    if [[ "$chain" != "$want" ]]; then
        echo "chain_type is '${chain:-missing}', needs '$want'"
    fi
    addr=$(_cmd_toml_get "$toml" check_node_api_http_addr)
    if [[ -n "$addr" ]] && _cmd_addr_is_local "$addr" && [[ "$(_cmd_addr_port "$addr")" != "$port" ]]; then
        echo "node address $addr is not on port $port"
    fi
    data=$(_cmd_foreign_data_dir "$net")
    if [[ -n "$data" ]]; then echo "wallet data is in $data, outside this wallet's folder"; fi
    return 0
}

_cmd_net_ok() { [[ -z "$(_cmd_net_problems "$1")" ]]; }

# Only the prefix is compared. It comes from chain_type, so this is the same fact
# as _cmd_net_problems, seen from what grin-wallet actually printed.
_cmd_addr_matches_net() {
    if [[ "$1" == "testnet" ]]; then [[ "$2" == tgrin1* ]]; else [[ "$2" == grin1* ]]; fi
}

# Every value that must agree with the network, written to <file>. The node secret
# goes only with a local node. rc 1 = a key could not be written.
_cmd_apply_network() {
    local net="$1" file="$2" port addr secret
    port=$(_cmd_node_port "$net")
    _cmd_set_toml_key "$file" "chain_type" "\"$(_cmd_expected_chain "$net")\"" || return 1
    _cmd_set_toml_key "$file" "api_listen_port" "$(_cmd_foreign_port "$net")" || return 1
    _cmd_set_toml_key "$file" "owner_api_listen_port" "$(_cmd_owner_port "$net")" || return 1
    addr=$(_cmd_toml_get "$file" check_node_api_http_addr)
    if [[ -n "$addr" ]] && ! _cmd_addr_is_local "$addr"; then
        info "Remote node $addr kept — no local secret was given to it."
        return 0
    fi
    _cmd_set_toml_key "$file" "check_node_api_http_addr" "\"http://127.0.0.1:$port\"" || return 1
    secret=$(grin_node_secret_path "$net" foreign 2>/dev/null || true)
    if [[ -n "$secret" && -f "$secret" ]]; then
        _cmd_set_toml_key "$file" "node_api_secret_path" "\"$secret\"" || return 1
    else
        warn "No $net node secret found — node_api_secret_path left as it was."
        warn "  Run 2) Configure once the $net node is up."
    fi
}

# Repairs the toml: same seed, same keys, nothing moved on chain. The edits go to a
# copy that replaces the toml only when all of them took, so a failure leaves it
# untouched. Outputs and transactions recorded against the other chain stay until a
# `scan -d`, so the listener is left stopped for the operator to run it.
_cmd_fix_network() {
    local net="$1" toml dir want backup problems tmp data _line
    toml=$(_cmd_toml "$net"); dir=$(_cmd_dir "$net")
    want=$(_cmd_expected_chain "$net")

    clear
    echo -e "${BOLD}${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${YELLOW} CMD Wallet — Fix network · $(_cmd_net_label "$net")${RESET}"
    echo -e "${BOLD}${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    problems=$(_cmd_net_problems "$net")
    if [[ -z "$problems" ]]; then
        success "This wallet already matches $net — nothing to fix."
        return 0
    fi
    while IFS= read -r _line; do warn "$_line"; done <<<"$problems"
    echo ""
    data=$(_cmd_foreign_data_dir "$net")
    if [[ -n "$data" ]]; then
        error "Not repaired: this toml runs on the wallet data in $data."
        error "  Correcting the network here would not change which wallet is in use."
        error "  Set data_file_dir in $toml by hand, or Renew to start clean."
        return 0
    fi
    echo -e "  ${DIM}Stops this wallet's listener, keeps a copy of the toml, then sets:${RESET}"
    echo -e "  ${DIM}  chain_type   = \"$want\"${RESET}"
    echo -e "  ${DIM}  listen ports = the $net ports${RESET}"
    echo -e "  ${DIM}  node address and secret = the local $net node${RESET}"
    echo -e "  ${DIM}    (a remote node is left alone and gets no local secret)${RESET}"
    echo -e "  ${DIM}The seed and keys do not change. The address keeps its key and takes${RESET}"
    echo -e "  ${DIM}the prefix of the right network.${RESET}"
    echo ""
    _cmd_warn_transporter_bound "$net"
    echo -ne "  ${BOLD}Fix the $net wallet?${RESET} [y/N/0 cancel]: "
    local go; read -r go || true
    if [[ "${go,,}" != "y" ]]; then info "Cancelled — nothing was changed."; return 0; fi
    echo ""

    _cmd_stop_wallet "$net" || return 0
    backup="$toml.before-network-fix-$(date +%Y%m%d_%H%M%S)"
    cp -p "$toml" "$backup" || { error "Could not copy the toml to $backup — nothing was changed."; return 0; }
    tmp="$toml.fix-$$"
    cp -p "$toml" "$tmp" || { error "Could not write $tmp — nothing was changed."; return 0; }
    if ! _cmd_apply_network "$net" "$tmp"; then
        rm -f "$tmp" || true
        error "Could not edit the toml — it was not changed."
        return 0
    fi
    mv -f "$tmp" "$toml" || { rm -f "$tmp" || true; error "Could not replace $toml — it was not changed."; return 0; }

    if ! _cmd_net_ok "$net"; then
        error "The toml still does not match $net. The original is in $backup."
        return 0
    fi
    success "Wallet now runs on $want."
    echo -e "         ${DIM}Original toml: $backup${RESET}"
    echo ""
    info "The listener is stopped. Clear what was recorded on the other chain first:"
    echo -e "         ${DIM}cd $dir && ./grin-wallet scan -d${RESET}"
    echo -e "         ${DIM}It asks for the passphrase. Then start it from 1) Listener.${RESET}"
    return 0
}

# ─── Wipe — stop and remove one network's wallet ────────────────────────────
# Every answer is collected before anything is touched. Testnet is deleted; mainnet
# is moved to /opt/grin/cmdwallet/.retired/ (see _cmd_retire_wallet). Only this
# wallet's OWN processes are stopped: a foreign holder of 3415/3420 is never killed.
_cmd_wipe_menu() {
    local net="$1" dir
    dir=$(_cmd_dir "$net")

    clear
    echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${RED} CMD Wallet — Wipe · $(_cmd_net_label "$net")${RESET}"
    echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  ${DIM}Stops the listener and removes the wallet: toml, wallet_data/, tor/,${RESET}"
    echo -e "  ${DIM}saved passphrase + seed, logs. Testnet is DELETED; mainnet is MOVED to${RESET}"
    echo -e "  ${DIM}/opt/grin/cmdwallet/.retired/ so real GRIN can never be lost by a mis-key.${RESET}"
    echo ""
    if [[ "$(_cmd_wallet_state "$net")" == "no-wallet" ]]; then
        info "No $net CMD wallet at $dir — nothing to remove."
        return 0
    fi

    echo -e "  Wallet dir   : $dir"
    if _cmd_has_seed "$net"; then
        echo -e "  Wallet       : ${BOLD}initialized${RESET}"
    else
        echo -e "  Wallet       : ${DIM}no wallet_data/wallet.seed${RESET}"
    fi
    if _cmd_listener_running "$net"; then
        echo -e "  Listener     : ${YELLOW}running${RESET} ${DIM}— will be stopped${RESET}"
    else
        echo -e "  Listener     : ${DIM}not running${RESET}"
    fi
    if [[ -f "$(_cmd_seed_file "$net")" ]]; then
        echo -e "  Saved seed   : ${DIM}$(_cmd_seed_file "$net")${RESET}"
    elif [[ "$net" == "mainnet" ]] && _cmd_has_seed "$net"; then
        echo -e "  Saved seed   : ${YELLOW}none on this box — make sure you hold the phrase${RESET}"
    fi
    echo ""
    _cmd_warn_transporter_bound "$net"

    local keep_bin="y"
    if [[ -x "$(_cmd_wallet_bin "$net")" ]]; then
        echo -ne "  Keep the grin-wallet binary, so Add skips the download? [Y/n/0 cancel]: "
        read -r keep_bin || true
        if [[ "$keep_bin" == "0" ]]; then info "Cancelled — nothing was changed."; return 0; fi
    fi
    local scope="wipe"
    [[ "${keep_bin,,}" == "n" ]] && scope="all"

    echo ""
    echo -ne "  ${BOLD}${RED}Wipe the $net CMD wallet?${RESET} [y/N/0 cancel]: "
    local go; read -r go || true
    if [[ "${go,,}" != "y" ]]; then info "Cancelled — nothing was changed."; return 0; fi
    _cmd_confirm_mainnet "$net" || return 0
    echo ""

    _cmd_retire_wallet "$net" "$scope" || return 0
    # The registry entry points 089 at the dir. Add re-registers on its next run.
    _cmd_unregister_wallet_dir "$net" \
        || warn "Could not remove the backup registry entry — edit /opt/grin/conf/grin_wallets_location.conf."

    if [[ -n "$CMD_RETIRED_TO" ]]; then
        success "Mainnet CMD wallet moved → ${BOLD}$CMD_RETIRED_TO${RESET}"
        echo -e "         ${DIM}Restore: stop the listener, then move its contents back into $dir${RESET}"
        echo -e "         ${DIM}Purge  : rm -rf $CMD_RETIRED_TO   (only once you are sure it holds nothing)${RESET}"
    else
        success "Testnet CMD wallet removed."
    fi
    if [[ "$scope" == "wipe" && -x "$(_cmd_wallet_bin "$net")" ]]; then
        echo -e "         ${DIM}grin-wallet binary kept in $dir${RESET}"
    fi
    echo -e "         ${DIM}3) Add creates a fresh one.${RESET}"
    return 0
}

# ─── Status ─────────────────────────────────────────────────────────────────
# no-wallet | half | ready. A toml with no seed is an init that failed after
# create_config. A seed with no toml cannot run here either: grin-wallet would fall
# back to ~/.grin and open a different wallet. Add clears both, behind Renew's gates
# when a seed is present.
_cmd_wallet_state() {
    local toml=0 seed=0
    if [[ -f "$(_cmd_toml "$1")" ]]; then toml=1; fi
    if _cmd_has_seed "$1"; then seed=1; fi
    if [[ $toml -eq 1 && $seed -eq 1 ]]; then echo "ready"
    elif [[ $toml -eq 1 || $seed -eq 1 ]]; then echo "half"
    else echo "no-wallet"
    fi
}

# Overview row. The mode is shown, not just up/down: "listening" alone cannot tell
# an operator whether the Transporter agent can drive this wallet.
_cmd_overview_row() {
    local net="$1" label
    label=$(printf '%-8s' "$(_cmd_net_label "$net")")
    case "$(_cmd_wallet_state "$net")" in
        no-wallet) echo -e "  ${BOLD}$label${RESET}${DIM}○ no wallet${RESET}"; return 0 ;;
        half)      echo -e "  ${BOLD}$label${RESET}${YELLOW}▲ half-initialized${RESET}  ${DIM}— Add clears it${RESET}"; return 0 ;;
    esac
    if ! _cmd_net_ok "$net"; then
        echo -e "  ${BOLD}$label${RESET}${RED}▲ wrong network${RESET}  ${DIM}— open it and press F${RESET}"
        return 0
    fi
    echo -e "  ${BOLD}$label${RESET}$(_cmd_listener_state "$net")  ${DIM}mode $(_cmd_mode "$net")${RESET}"
}

# ─── One network's screen ───────────────────────────────────────────────────
_cmd_pause() { echo -ne "\n  Press Enter to continue..."; read -r || true; }

# Cancel from a setup prompt. Before init nothing has changed, so the menu simply
# returns. After init the wallet exists but its toml is unpatched and no listener
# runs; the pause also keeps a printed seed on screen past the menu's `clear`.
_cmd_setup_cancelled() {
    [[ "$1" != "no" ]] || return 0
    echo ""
    warn "The wallet was created, so it stays. Setup stopped before patching its config,"
    warn "  and backups do not include it yet. Write the seed down if you have not,"
    warn "  then run 2) Configure to finish."
    _cmd_pause
}

# Row for an action that does not apply right now: key kept, reason shown.
_cmd_row_off() { echo -e "  ${DIM}$1) $2  — $3${RESET}"; }

_cmd_net_menu() {
    local net="$1" label sel state problems _line _hint
    label=$(_cmd_net_label "$net")

    # .init_capture holds a mnemonic. Only a killed setup leaves one behind, and no
    # setup is running here, so whatever is there has no owner.
    rm -f "$(_cmd_dir "$net")/.init_capture" 2>/dev/null \
        || warn "Could not remove a leftover .init_capture from $(_cmd_dir "$net") — delete it by hand."

    while true; do
        state=$(_cmd_wallet_state "$net")
        problems=""
        if [[ "$state" == "ready" ]]; then problems=$(_cmd_net_problems "$net"); fi
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN} CMD Wallet · $label${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        if [[ "$net" == "mainnet" ]]; then
            echo -e "  ${BOLD}${YELLOW}⚠  Real GRIN (monetary value)${RESET}"
            echo ""
        fi
        case "$state" in
            ready) echo -e "  Wallet     : ${GREEN}initialized${RESET}" ;;
            half)  echo -e "  Wallet     : ${YELLOW}half-initialized${RESET}  ${DIM}— an earlier init did not finish${RESET}" ;;
            *)     echo -e "  Wallet     : ${DIM}none yet${RESET}" ;;
        esac
        if [[ "$state" != "no-wallet" ]]; then
            echo -e "  Listener   : $(_cmd_listener_state "$net")"
            echo -e "  Mode       : ${DIM}$(_cmd_mode_label "$net")${RESET}"
            if [[ -f "$(_cmd_pass_file "$net")" ]]; then
                echo -e "  Passphrase : ${DIM}saved — starts unattended${RESET}"
            else
                echo -e "  Passphrase : ${YELLOW}not saved${RESET}  ${DIM}— asked at every start${RESET}"
            fi
        fi
        echo -e "  Folder     : ${DIM}$(_cmd_dir "$net")${RESET}"
        echo ""

        if [[ -n "$problems" ]]; then
            echo -e "  ${BOLD}${RED}▲ This wallet is on the wrong network${RESET}"
            while IFS= read -r _line; do echo -e "    ${RED}$_line${RESET}"; done <<<"$problems"
            echo -e "  ${YELLOW}F${RESET}) ${BOLD}Fix network${RESET}  ${DIM}correct the toml — seed and keys unchanged${RESET}"
            echo ""
        fi

        echo -e "  ${DIM}─── Run ──────────────────────────────────────────────${RESET}"
        if [[ "$state" == "ready" ]]; then
            echo -e "  ${GREEN}1${RESET}) Listener   ${DIM}start · stop · restart · recent output${RESET}"
            echo -e "  ${GREEN}2${RESET}) Configure  ${DIM}listener mode, node secret, ports, logging — wallet untouched${RESET}"
        else
            _cmd_row_off 1 "Listener " "needs a wallet"
            _cmd_row_off 2 "Configure" "needs a wallet"
        fi
        echo ""
        echo -e "  ${DIM}─── Wallet ───────────────────────────────────────────${RESET}"
        if [[ "$state" == "ready" ]]; then
            _cmd_row_off 3 "Add      " "this network already has one; Renew replaces it"
            echo -e "  ${GREEN}4${RESET}) Renew      ${DIM}replace it: new seed, or recover from a phrase${RESET}"
        else
            echo -e "  ${GREEN}3${RESET}) Add        ${DIM}new seed, or recover from a phrase${RESET}"
            _cmd_row_off 4 "Renew    " "nothing to replace yet"
        fi
        if [[ "$state" == "no-wallet" ]]; then
            _cmd_row_off 5 "Wipe     " "nothing to remove"
        elif [[ "$net" == "mainnet" ]]; then
            echo -e "  ${RED}5${RESET}) Wipe       ${DIM}stop and archive to .retired/${RESET}"
        else
            echo -e "  ${RED}5${RESET}) Wipe       ${DIM}stop and delete${RESET}"
        fi
        echo ""
        echo -e "  ${GREEN}B${RESET}) grin-wallet binary  ${DIM}install · update · roll back · verify${RESET}"
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        _hint="1-5/B/0"
        [[ -n "$problems" ]] && _hint="F/1-5/B/0"
        echo -ne "${BOLD}Select [$_hint]: ${RESET}"
        read -r sel || true
        echo ""

        case "$sel" in
            1)  if [[ "$state" != "ready" ]]; then info "No wallet yet — 3) Add creates one."; sleep 2
                else _cmd_listener_menu "$net" || true
                fi ;;
            2)  if [[ "$state" != "ready" ]]; then info "No wallet yet — 3) Add creates one."; sleep 2
                elif [[ -n "$problems" ]]; then warn "Fix the network first — F)."; sleep 2
                else _cmd_wallet_setup_for_net "$net" configure || true
                fi ;;
            3)  if [[ "$state" == "ready" ]]; then info "This network already has a wallet — 4) Renew replaces it."; sleep 2
                else _cmd_wallet_setup_for_net "$net" add || true
                fi ;;
            4)  if [[ "$state" != "ready" ]]; then info "Nothing to replace — 3) Add creates a wallet."; sleep 2
                else _cmd_wallet_setup_for_net "$net" renew || true
                fi ;;
            5)  _cmd_wipe_menu "$net" || true; _cmd_pause ;;
            f|F) if [[ -z "$problems" ]]; then info "Nothing to fix on this screen."; sleep 2
                 else _cmd_fix_network "$net" || true; _cmd_pause
                 fi ;;
            b|B) _cmd_binary_menu "$net" || true ;;
            0|"") return 0 ;;
            *)  echo -e "  ${RED}Invalid option.${RESET}"; sleep 1 ;;
        esac
    done
}

# ─── Overview ───────────────────────────────────────────────────────────────
cmd_wallet_run() {
    local sel _net _ok
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN} 05C) GRIN WALLET QUICK SETUP${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  ${DIM}A grin-wallet for direct CLI use, testing, or behind the Transporter agent.${RESET}"
        echo -e "  ${DIM}One wallet per network, in /opt/grin/cmdwallet/<net>/, independent of other${RESET}"
        echo -e "  ${DIM}services. The passphrase goes in on stdin, so it never appears in ps.${RESET}"
        echo ""
        _cmd_overview_row mainnet
        _cmd_overview_row testnet
        echo ""
        echo -e "  ${GREEN}1${RESET}) Mainnet  ${DIM}(real GRIN)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Testnet  ${DIM}(tGRIN — no monetary value)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Both     ${DIM}(add a wallet to each network that has none)${RESET}"
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-3/0]: ${RESET}"

        read -r sel || true
        case "$sel" in
            1) _cmd_net_menu mainnet || true ;;
            2) _cmd_net_menu testnet || true ;;
            3)
                _ok=0
                for _net in mainnet testnet; do
                    if [[ "$(_cmd_wallet_state "$_net")" == "ready" ]]; then continue; fi
                    _ok=1
                    # rc 1 = cancelled: the operator stopped, so do not open the next one.
                    _cmd_wallet_setup_for_net "$_net" add || break
                done
                if [[ $_ok -eq 0 ]]; then
                    echo ""
                    info "Both networks already have a wallet."
                    sleep 2
                fi
                ;;
            0|"") return 0 ;;
            *) echo -e "\n  ${RED}Invalid option.${RESET}"; sleep 1 ;;
        esac
    done
}
