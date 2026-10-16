# =============================================================================
# lib/01_lib_menu.sh — The one menu of Script 01: node status first, fixed keys, every action returns to a fresh scan.
# =============================================================================
# Sourced by 01_build_new_grin_node.sh; shares its globals and log/info/warn/error helpers.
# Contract: s01_menu_loop is the only way the script ends (key 0, or end of input). Each pass resets the session state
# (s01_reset_state), scans (s01_scan_nodes), renders the status block and the keys, then runs ONE action on the nodes
# it names. All node work goes through the node table (lib/01_lib_node_table.sh); nothing here stops, starts or scans.
# Trap: runs with errexit off (the caller guards every call with `|| true`), so guard each file op with `|| { error ...; return 1; }`.

# S01_PICK is the network chosen by s01_pick_net (mainnet|testnet|both); S01_KEY / S01_ARG the resolved menu key.
S01_PICK=""
S01_KEY=""
S01_ARG=""

# -----------------------------------------------------------------------------
# s01_reset_state — the per-run wizard globals back to their starting values. Called once at startup and before
# every menu pass, so nothing one action left behind (a Super Auto flag, a stream choice, a downloaded binary, the
# disk-check skip) leaks into the next. GRIN_BIN_TMP is re-seeded from GRIN_PREBUILT_BIN, which the source build
# (key G) exports: a binary compiled there survives the reset and is used by the next install.
# -----------------------------------------------------------------------------
s01_reset_state() {
    NETWORK_TYPE=""
    ARCHIVE_MODE=""
    GRIN_DIR=""
    TAR_FILE=""
    SHA_FILE=""
    GRIN_BIN_TMP="${GRIN_PREBUILT_BIN:-}"
    RESTRICTED_NETWORK=""   # set by key 5 when only one network is free
    STREAM_MODE=false       # true = on-the-fly pipe extraction (no local .tar.gz saved)
    SLOW_SYNC_MODE=false    # true = no archive; the node syncs from peers
    SUPER_AUTO=false        # true = key A: wipe & rebuild BOTH nodes (pruned, streamed) with hardening, no per-step prompts
    RECORDER_OFFERED=false  # the wizard offers the event recorder once per action, not per node
    READY_SOURCES=()        # ordered base URLs that passed the sync-status check
    SELECTED_ZONE=""        # zone chosen at Step 9 (america|asia|europe|africa|all)
    S01_PICK=""; S01_KEY=""; S01_ARG=""
    unset GRIN_SKIP_DISK_CHECK
    return 0
}

# s01_pause — hold the output on screen: the next pass clears it.
s01_pause() {
    echo ""
    read -rp "  Press Enter to return to the menu..." _ || true
    return 0
}

# _s01_nets_for <start|stop|update|rebuild|install> — the networks the action can apply to, mainnet first.
#   start    installed and not running      stop     a grin process of the dir exists
#   update   installed                      rebuild  a node dir exists (even without its binary)
#   install  no node dir at all
_s01_nets_for() {
    local action="$1" net hit
    for net in mainnet testnet; do
        hit=0
        case "$action" in
            start)   if [[ "${NT_ON_DISK[$net]}" == "1" && "${NT_RUNNING[$net]}" != "1" ]]; then hit=1; fi ;;
            stop)    if [[ "${NT_RUNNING[$net]}" == "1" ]]; then hit=1; fi ;;
            update)  if [[ "${NT_ON_DISK[$net]}" == "1" ]]; then hit=1; fi ;;
            rebuild) if [[ -n "${NT_DIR[$net]}" ]]; then hit=1; fi ;;
            install) if [[ -z "${NT_DIR[$net]}" ]]; then hit=1; fi ;;
        esac
        if (( hit == 1 )); then echo "$net"; fi
    done
    return 0
}

# _s01_broken_nets — networks with a node dir that cannot start (binary or config missing, nothing running), one
# per line. Only key 4's full reinstall repairs them.
_s01_broken_nets() {
    local net
    for net in mainnet testnet; do
        if [[ -n "${NT_DIR[$net]}" && "${NT_ON_DISK[$net]}" != "1" && "${NT_RUNNING[$net]}" != "1" ]]; then echo "$net"; fi
    done
    return 0
}

# _s01_reason <action> [net] — why the action cannot act now; prints nothing when it can. With a net (the m / t aliases)
# the check is for that network alone.
_s01_reason() {
    local action="$1" net="${2:-}" broken
    if [[ -n "$net" ]]; then
        if [[ " $(_s01_nets_for "$action" | tr '\n' ' ')" != *" $net "* ]]; then echo "no $net node to rebuild"; fi
        return 0
    fi
    if [[ -n "$(_s01_nets_for "$action")" ]]; then return 0; fi
    case "$action" in
        start)
            # A dir whose binary or config is missing cannot start; name it, so "already running" never hides it.
            broken="$(_s01_broken_nets | paste -sd '/' - | sed 's#/# / #g')"
            if [[ -n "$broken" ]]; then echo "${broken} broken — repair with 4"
            elif [[ -n "$(_s01_nets_for update)" ]]; then echo "every installed node is already running"
            else echo "no node installed"; fi ;;
        stop)    echo "nothing is running" ;;
        update)  echo "no node installed" ;;
        rebuild) echo "no node installed" ;;
        install) echo "no free network" ;;
    esac
    return 0
}

# _s01_hint <action> — what the key would act on now, e.g. "testnet" or "both / mainnet / testnet". Mirrors the
# choices s01_pick_net and s01_act_install would offer, so the row never promises a network the picker leaves out.
_s01_hint() {
    local action="$1" nets
    nets="$(_s01_nets_for "$action" | paste -sd '/' - | sed 's#/# / #g')"
    if [[ -z "$nets" ]]; then return 0; fi
    case "$action" in
        update|install)
            if [[ "$nets" == *" / "* ]]; then nets="both / $nets"; fi ;;
        rebuild)
            # A broken dir offers only the full reinstall (s01_act_rebuild skips the chain_data choice for it).
            if [[ -z "$(_s01_broken_nets)" ]]; then nets+=" · chain_data or full"
            elif [[ "$(_s01_broken_nets | wc -l)" -eq "$(_s01_nets_for rebuild | wc -l)" ]]; then nets+=" · full reinstall"
            else nets+=" · $(_s01_broken_nets | paste -sd '/' - | sed 's#/# / #g'): full only"; fi ;;
    esac
    echo "→ $nets"
    return 0
}

# _s01_key_line <key> <label> <reason> [hint] — one menu row; DIM with its reason when the key cannot act now,
# otherwise the label followed by the dimmed hint in the same column.
_s01_key_line() {
    local key="$1" label="$2" reason="$3" hint="${4:-}"
    if [[ -n "$reason" ]]; then
        echo -e "${DIM}  ${key}) $(printf '%-34s' "$label")  ${reason}${RESET}"
    elif [[ -n "$hint" ]]; then
        echo -e "  ${GREEN}${key}${RESET}) $(printf '%-34s' "$label")  ${DIM}${hint}${RESET}"
    else
        echo -e "  ${GREEN}${key}${RESET}) ${label}"
    fi
    return 0
}

# s01_render_keys — the key list, grouped the way hub 05 draws its menu. Reads the arrays of the last s01_scan_nodes.
s01_render_keys() {
    echo -e "${DIM}  ── One-shot setup ─── wipe the box, rebuild both nodes${RESET}"
    echo ""
    echo -e "  ${GREEN}A${RESET}) Super Auto — ${BOLD}wipe all${RESET}, rebuild both pruned  ${DIM}(type REBUILD)${RESET}"
    echo ""
    echo -e "${DIM}  ── Nodes ──────────── start, stop, update, rebuild, install${RESET}"
    echo ""
    _s01_key_line 1 "Start a node"      "$(_s01_reason start)"   "$(_s01_hint start)"
    _s01_key_line 2 "Stop a node"       "$(_s01_reason stop)"    "$(_s01_hint stop)"
    _s01_key_line 3 "Update Grin binary" "$(_s01_reason update)"  "$(_s01_hint update)"
    _s01_key_line 4 "Rebuild a node"    "$(_s01_reason rebuild)" "$(_s01_hint rebuild)"
    _s01_key_line 5 "Install a node"    "$(_s01_reason install)" "$(_s01_hint install)"
    echo ""
    echo -e "${DIM}  ── Source build ───── your own Grin binary${RESET}"
    echo ""
    _s01_key_line G "Compile Grin binary from source / roll back old Grin version" ""
    echo ""
    echo -e "  ${RED}0${RESET}) Back to main menu"
    return 0
}

# _s01_resolve <typed> — map a key (or hidden alias: s→1, b→3, m→4 mainnet, t→4 testnet) to S01_KEY / S01_ARG.
# rc 1 for anything else; k, c, n, r are deliberately not keys.
_s01_resolve() {
    S01_KEY=""; S01_ARG=""
    case "$1" in
        1|s) S01_KEY=start ;;
        2)   S01_KEY=stop ;;
        3|b) S01_KEY=update ;;
        4)   S01_KEY=rebuild ;;
        m)   S01_KEY=rebuild; S01_ARG=mainnet ;;
        t)   S01_KEY=rebuild; S01_ARG=testnet ;;
        5)   S01_KEY=install ;;
        g)   S01_KEY=source ;;
        a)   S01_KEY=auto ;;
        *)   return 1 ;;
    esac
    return 0
}

# -----------------------------------------------------------------------------
# s01_pick_net <start|stop|update|rebuild> — ask which network; sets S01_PICK. Offers only the networks the action can
# apply to and picks silently when exactly one does. Update also offers "both", the default. rc 1 = cancelled.
# -----------------------------------------------------------------------------
s01_pick_net() {
    local action="$1" choice def="" hint net i
    local -a nets=()
    while IFS= read -r net; do
        if [[ -n "$net" ]]; then nets+=("$net"); fi
    done < <(_s01_nets_for "$action")
    S01_PICK=""
    if (( ${#nets[@]} == 0 )); then
        warn "$(_s01_reason "$action")"
        return 1
    fi
    if (( ${#nets[@]} == 1 )); then
        S01_PICK="${nets[0]}"
        info "Only ${S01_PICK} applies — selected."
        return 0
    fi
    echo ""
    for i in "${!nets[@]}"; do
        net="${nets[$i]}"
        echo -e "  ${GREEN}$((i + 1))${RESET}) ${net}  ${NT_MODE[$net]}  ${DIM}${NT_DIR[$net]}${RESET}"
    done
    hint="1-2"
    if [[ "$action" == "update" ]]; then
        echo -e "  ${GREEN}3${RESET}) both  ${DIM}(default — one download, then one node at a time)${RESET}"
        hint="1-3 / Enter = 3"; def=3
    fi
    echo -e "  ${DIM}0${RESET}) Cancel"
    while true; do
        echo -ne "${BOLD}Network [${hint} / 0]: ${RESET}"
        read -r choice || return 1
        choice="${choice:-$def}"
        case "$choice" in
            0) info "Cancelled."; return 1 ;;
            1) S01_PICK="${nets[0]}"; return 0 ;;
            2) S01_PICK="${nets[1]}"; return 0 ;;
            3) if [[ "$action" == "update" ]]; then S01_PICK="both"; return 0; fi
               warn "Invalid choice '${choice}'." ;;
            *) warn "Invalid choice '${choice}'." ;;
        esac
    done
}

# ── Actions ────────────────────────────────────────────────────────────────────────────────────────────────
s01_act_start() {
    local other
    s01_pick_net start || return 0
    s01_start_node "$S01_PICK" || true
    if [[ "$S01_PICK" == "mainnet" ]]; then other=testnet; else other=mainnet; fi
    if [[ "$S01_LAST_START" == "launched" && "${NT_ON_DISK[$other]}" == "1" && "${NT_RUNNING[$other]}" != "1" ]]; then
        warn "Let the $S01_PICK node finish booting (the boot is CPU/disk heavy) before starting the $other node."
    fi
    return 0
}

s01_act_stop() {
    s01_pick_net stop || return 0
    s01_stop_node "$S01_PICK" || true
    return 0
}

s01_act_update() {
    s01_pick_net update || return 0
    update_binary_only "$S01_PICK" || true
    return 0
}

# s01_act_rebuild [net] — chain_data only (rebuild_chain_data_only has its own typed REBUILD) or a full reinstall of
# that one network. The full reinstall deletes the node dir(s) of the network, so it needs a typed token: REBUILD, or
# DELETE-ARCHIVE when a full archive is among them (hours to days to re-sync).
s01_act_rebuild() {
    local net="${1:-}" dir extra tok="REBUILD" sub confirm
    if [[ -z "$net" ]]; then
        s01_pick_net rebuild || return 0
        net="$S01_PICK"
    fi
    dir="${NT_DIR[$net]}"; extra="${NT_EXTRA[$net]}"
    echo ""
    info "${net^^}: ${NT_MODE[$net]}  $dir"
    if [[ "${NT_ON_DISK[$net]}" == "1" ]]; then
        echo -e "  ${GREEN}1${RESET}) chain_data only  ${DIM}— keeps config, secrets and .onion; re-syncs the chain${RESET}"
        echo -e "  ${YELLOW}2${RESET}) full reinstall   ${DIM}— deletes the ${net} node directory and runs the wizard for it${RESET}"
        echo -e "  ${DIM}0${RESET}) Cancel"
        while true; do
            echo -ne "${BOLD}Rebuild ${net} [1-2 / 0]: ${RESET}"
            read -r sub || return 0
            case "$sub" in
                1) rebuild_chain_data_only "$net" "$dir" || true; return 0 ;;
                2) break ;;
                0) info "Cancelled."; return 0 ;;
                *) warn "Invalid choice '${sub}'." ;;
            esac
        done
    else
        warn "The binary or config of $dir is missing — only a full reinstall can repair it."
    fi

    echo ""
    warn "A full reinstall of the ${net} node DELETES:"
    echo -e "    ${RED}✗${RESET} $dir"
    if [[ -n "$extra" ]]; then echo -e "    ${RED}✗${RESET} $extra"; fi
    info "Kept: API secrets (key vault) and the .onion identity. The other network is not touched."
    if [[ "$dir" == *-full || "$extra" == *-full ]]; then
        tok="DELETE-ARCHIVE"
        warn "A FULL ARCHIVE is among them — unrecoverable without a full re-sync (~18-25 GB, hours to days)."
    fi
    echo -ne "  Type ${RED}${BOLD}${tok}${RESET} to proceed, or Enter to cancel: "
    read -r confirm || confirm=""
    if [[ "$confirm" != "$tok" ]]; then
        info "Cancelled — no changes made."
        return 0
    fi
    s01_full_reinstall "$net" || true
    return 0
}

# s01_act_install — the wizard for a FREE network only (no node dir): one free → that one; both free → mainnet /
# testnet / both.
s01_act_install() {
    local -a free=()
    local net
    while IFS= read -r net; do
        if [[ -n "$net" ]]; then free+=("$net"); fi
    done < <(_s01_nets_for install)
    check_legacy_grin_dir
    check_os_and_deps
    if (( ${#free[@]} == 1 )); then RESTRICTED_NETWORK="${free[0]}"; fi
    if ! select_network; then
        info "Cancelled — no changes made."
        return 0
    fi
    case "$NETWORK_TYPE" in
        mainnet|testnet)
            setup_one_node "$NETWORK_TYPE"
            ;;
        both)
            info "Setting up MAINNET node first..."
            setup_one_node "mainnet"
            echo ""
            echo -e "${BOLD}${CYAN}Mainnet done. Proceeding to TESTNET setup...${RESET}"
            sleep 2
            setup_one_node "testnet"
            ;;
    esac
    return 0
}

s01_run_action() {
    case "$S01_KEY" in
        start)   s01_act_start ;;
        stop)    s01_act_stop ;;
        update)  s01_act_update ;;
        rebuild) s01_act_rebuild "$S01_ARG" ;;
        install) s01_act_install ;;
        source)  gsb_menu || true ;;
        auto)    run_super_auto || true ;;
    esac
    return 0
}

# -----------------------------------------------------------------------------
# s01_menu_loop — the menu. A typo or a key that cannot act re-prompts without redrawing; any real action runs, waits for
# Enter, then the loop restarts from a reset state and a fresh scan. Only 0 (or end of input) returns.
# -----------------------------------------------------------------------------
s01_menu_loop() {
    local choice reason
    while true; do
        s01_reset_state
        clear 2>/dev/null || true
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN} 01) GRIN NODES${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        s01_scan_nodes
        s01_render_status
        echo -e "${DIM}  ──────────────────────────────────────────────────────────────${RESET}"
        echo ""
        s01_render_keys
        echo ""
        while true; do
            echo -ne "${BOLD}Select [A / 1-5 / G / 0]: ${RESET}"
            if ! read -r choice; then echo ""; return 0; fi
            choice="${choice//[[:space:]]/}"; choice="${choice,,}"
            if [[ "$choice" == "0" ]]; then return 0; fi
            if [[ -z "$choice" ]]; then continue; fi
            if ! _s01_resolve "$choice"; then
                warn "Unknown choice '${choice}' — use A, 1-5, G or 0."
                continue
            fi
            reason=""
            case "$S01_KEY" in
                start|stop|update|rebuild|install) reason="$(_s01_reason "$S01_KEY" "$S01_ARG")" ;;
            esac
            if [[ -n "$reason" ]]; then
                warn "Not available now: ${reason}."
                continue
            fi
            break
        done
        log "[MENU] action=$S01_KEY${S01_ARG:+ ($S01_ARG)}"
        s01_run_action
        # The source-build menu is its own screen; every other action leaves output the next pass would clear.
        if [[ "$S01_KEY" != "source" ]]; then s01_pause; fi
    done
}
