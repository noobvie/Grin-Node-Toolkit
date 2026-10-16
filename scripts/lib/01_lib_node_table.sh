# =============================================================================
# lib/01_lib_node_table.sh — the node table for Script 01: ONE scan of what is installed / running, and per-node start / stop.
# =============================================================================
# Sourced by 01_build_new_grin_node.sh after 01_lib_node_launch.sh; shares its globals and log/info/warn/error helpers.
# Contract: s01_scan_nodes fills the NT_* arrays (read-only, mutates nothing); every stop/start below acts on ONE network
# from that scan and never reaches the other network or a wallet session. "Running" = a grin process whose BINARY is
# <dir>/grin (gnc_grin_pids_for_dir) — not "port bound", so a node still booting counts. Ports 3415/13415 are wallet ports
# and are never checked here.
# Trap: runs with errexit off (the caller guards every call with `|| true`), so guard each file op with `|| { error ...; return 1; }`.

# Where toolkit-built nodes live (overridable so the test harness can point at a scratch tree).
NT_NODE_ROOT="${NT_NODE_ROOT:-/opt/grin/node}"

declare -gA NT_DIR=() NT_MODE=() NT_IN_CONF=() NT_CONF_DIR=() NT_ON_DISK=() NT_RUNNING=()
declare -gA NT_SESSION=() NT_VERSION=() NT_FOREIGN=() NT_EXTRA=() NT_AUTOSTART=() NT_AUTOSTART_DIR=()

# S01_LAST_START after s01_start_node: launched | running (already up) | failed.
S01_LAST_START=""

# _nt_load_conf — read the *_GRIN_DIR values of the instances conf into _NT_CONF[FULLMAIN|PRUNEMAIN|PRUNETEST]
# (last assignment wins). Parsed line by line, never sourced: sourcing leaks PRUNEMAIN_/FULLMAIN_ values into the
# caller and a stale one resurrects a deleted node.
declare -gA _NT_CONF=()
_nt_load_conf() {
    local conf="${INSTANCES_CONF:-${GNC_INSTANCES_CONF:-}}" line re='^(FULLMAIN|PRUNEMAIN|PRUNETEST)_GRIN_DIR="([^"]*)"'
    _NT_CONF=([FULLMAIN]="" [PRUNEMAIN]="" [PRUNETEST]="")
    [[ -f "$conf" ]] || return 0
    while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ "$line" =~ $re ]]; then _NT_CONF[${BASH_REMATCH[1]}]="${BASH_REMATCH[2]}"; fi
    done < "$conf"
    return 0
}

# _nt_installed <dir> — rc 0 when both grin-server.toml and an executable grin binary exist.
_nt_installed() {
    [[ -n "${1:-}" && -f "$1/grin-server.toml" && -x "$1/grin" ]]
}

# _nt_p2p_port <mainnet|testnet> — 3414 | 13414
_nt_p2p_port() {
    if [[ "${1:-}" == "testnet" ]]; then echo 13414; else echo 3414; fi
}

# _nt_valid_net <net> — rc 0 for mainnet|testnet, else an error line and rc 1.
_nt_valid_net() {
    case "${1:-}" in
        mainnet|testnet) return 0 ;;
        *) error "Unknown network '${1:-}' (expected mainnet or testnet)."; return 1 ;;
    esac
}

# _nt_mode_of_dir <dir> — sets NT_MODE_OUT to "full" or "pruned": the directory name first, else archive_mode in its toml.
_nt_mode_of_dir() {
    case "${1:-}" in
        *-full)  NT_MODE_OUT=full;   return 0 ;;
        *-prune) NT_MODE_OUT=pruned; return 0 ;;
    esac
    if grep -qiE 'archive_mode[[:space:]]*=[[:space:]]*true' "${1:-}/grin-server.toml" 2>/dev/null; then
        NT_MODE_OUT=full
    else
        NT_MODE_OUT=pruned
    fi
    return 0
}

# _nt_port_foreign <port> — "pid name" when the P2P port is held by a process whose binary is not named grin;
# nothing otherwise (also nothing when ss cannot show the pid).
_nt_port_foreign() {
    local port="$1" pid exe name out re='pid=([0-9]+)'
    out=$(ss -tlnp "sport = :$port" 2>/dev/null || true)
    [[ "$out" =~ $re ]] || return 0
    pid="${BASH_REMATCH[1]}"
    if exe=$(_gnc_exe_path "$pid"); then
        name="${exe##*/}"
    else
        name=$(ps -p "$pid" -o comm= 2>/dev/null | head -1 || true)
    fi
    [[ "$name" == "grin" ]] && return 0
    echo "$pid ${name:-?}"
    return 0
}

# _nt_autostart_dir <net> <crontab text> — the dir the network's tagged @reboot line starts (its `cd '<dir>'`), or
# nothing when there is no such line. The tag is the one Script 03 → G and gnk_autostart_enable both write.
_nt_autostart_dir() {
    local net="$1" cron="$2" tag line re="cd '([^']*)'"
    if [[ "$net" == "testnet" ]]; then
        tag="${GNK_AUTOSTART_TAG_TEST:-# grin-node-toolkit: grin_autostart_testnet}"
    else
        tag="${GNK_AUTOSTART_TAG_MAIN:-# grin-node-toolkit: grin_autostart_mainnet}"
    fi
    line=$(printf '%s\n' "$cron" | grep -F "$tag" | grep -v '^[[:space:]]*#' | tail -1 || true)
    [[ -n "$line" ]] || return 0
    if [[ "$line" =~ $re ]]; then echo "${BASH_REMATCH[1]%/}"; else echo "?"; fi
    return 0
}

# -----------------------------------------------------------------------------
# s01_scan_nodes — fill the NT_* arrays (keys: mainnet, testnet). Read-only.
#   NT_DIR       node dir the network resolves to: a dir with a live grin process, else the conf-registered
#                dir, else the first installed one (full before pruned), else a conf dir that is gone, else ""
#   NT_MODE      full | pruned ("" when no dir)
#   NT_ON_DISK   1 when NT_DIR holds grin-server.toml + an executable grin
#   NT_CONF_DIR  the dir the instances conf registers for the network ("" when none)
#   NT_IN_CONF   1 when NT_CONF_DIR is exactly NT_DIR
#   NT_RUNNING   1 when a grin process of NT_DIR exists
#   NT_SESSION   grin | root | none — which tmux server holds the node's session (gnc_has_grin_session)
#   NT_VERSION   output of `grin --version` ("" when not on disk)
#   NT_FOREIGN   "pid name" when the P2P port is held by a non-grin process, else ""
#   NT_EXTRA     a second installed dir for the same network (e.g. prune AND full), else ""
#   NT_AUTOSTART on | stale | off — the network's @reboot line starts NT_DIR / starts another dir (NT_AUTOSTART_DIR,
#                left behind by a pruned↔full rebuild) / does not exist
# -----------------------------------------------------------------------------
s01_scan_nodes() {
    local net dir c port line cron
    local -a cands installed uniq
    local -A running=()
    _nt_load_conf
    cron=$(crontab -l 2>/dev/null || true)
    for net in mainnet testnet; do
        NT_DIR[$net]=""; NT_MODE[$net]=""; NT_IN_CONF[$net]=0; NT_CONF_DIR[$net]=""; NT_ON_DISK[$net]=0
        NT_RUNNING[$net]=0; NT_SESSION[$net]=none; NT_VERSION[$net]=""; NT_FOREIGN[$net]=""; NT_EXTRA[$net]=""
        NT_AUTOSTART[$net]=off; NT_AUTOSTART_DIR[$net]=""

        if [[ "$net" == "mainnet" ]]; then
            NT_CONF_DIR[$net]="${_NT_CONF[FULLMAIN]:-${_NT_CONF[PRUNEMAIN]}}"
            cands=("${_NT_CONF[FULLMAIN]}" "${_NT_CONF[PRUNEMAIN]}" "$NT_NODE_ROOT/mainnet-full" "$NT_NODE_ROOT/mainnet-prune")
        else
            NT_CONF_DIR[$net]="${_NT_CONF[PRUNETEST]}"
            cands=("${_NT_CONF[PRUNETEST]}" "$NT_NODE_ROOT/testnet-prune")
        fi

        # De-duplicate the candidate list (order kept); remember which are installed and which have a live process.
        uniq=(); installed=(); running=()
        for c in "${cands[@]}"; do
            [[ -n "$c" ]] || continue
            c="${c%/}"
            [[ " ${uniq[*]:-} " == *" $c "* ]] && continue
            uniq+=("$c")
            if [[ -d "$c" ]] && _grin_proc_for_dir "$c"; then running[$c]=1; fi
            if _nt_installed "$c"; then installed+=("$c"); fi
        done

        # NT_DIR: running > conf-registered (if installed) > first installed > conf dir that still exists.
        dir=""
        for c in "${installed[@]:-}"; do
            if [[ -n "$c" && -n "${running[$c]:-}" ]]; then dir="$c"; break; fi
        done
        if [[ -z "$dir" && -n "${NT_CONF_DIR[$net]}" ]] && _nt_installed "${NT_CONF_DIR[$net]%/}"; then
            dir="${NT_CONF_DIR[$net]%/}"
        fi
        if [[ -z "$dir" && ${#installed[@]} -gt 0 ]]; then dir="${installed[0]}"; fi
        if [[ -z "$dir" && -n "${NT_CONF_DIR[$net]}" && -d "${NT_CONF_DIR[$net]}" ]]; then
            dir="${NT_CONF_DIR[$net]%/}"
        fi
        NT_DIR[$net]="$dir"
        for c in "${installed[@]:-}"; do
            if [[ -n "$c" && "$c" != "$dir" ]]; then NT_EXTRA[$net]="$c"; break; fi
        done

        if [[ -n "$dir" ]]; then
            _nt_mode_of_dir "$dir"; NT_MODE[$net]="$NT_MODE_OUT"
            if _nt_installed "$dir"; then
                NT_ON_DISK[$net]=1
                line=$("$dir/grin" --version 2>/dev/null || true)
                NT_VERSION[$net]="${line##* }"
            fi
            if [[ "${NT_CONF_DIR[$net]%/}" == "$dir" ]]; then NT_IN_CONF[$net]=1; fi
            if [[ -n "${running[$dir]:-}" ]]; then NT_RUNNING[$net]=1; fi
            if gnc_has_grin_session "$(_grin_session_name "$dir")"; then
                NT_SESSION[$net]="${GNC_SESSION_SOCKET:-none}"
            fi
        fi
        port="$(_nt_p2p_port "$net")"
        NT_FOREIGN[$net]="$(_nt_port_foreign "$port")"

        NT_AUTOSTART_DIR[$net]="$(_nt_autostart_dir "$net" "$cron")"
        if [[ -n "${NT_AUTOSTART_DIR[$net]}" ]]; then
            if [[ "${NT_AUTOSTART_DIR[$net]}" == "$dir" ]]; then NT_AUTOSTART[$net]=on; else NT_AUTOSTART[$net]=stale; fi
        fi
    done
    return 0
}

# -----------------------------------------------------------------------------
# s01_render_status — the status block: one line per network, then the conf/disk verdict and any foreign listener.
# Reads the arrays of the last s01_scan_nodes; prints only.
# -----------------------------------------------------------------------------
s01_render_status() {
    local net label state sess line mism=0
    for net in mainnet testnet; do
        label="${net^^}"
        if [[ -z "${NT_DIR[$net]}" ]]; then
            echo -e "  ${BOLD}${label}${RESET}  ${DIM}not installed${RESET}"
            if [[ "${NT_AUTOSTART[$net]}" == "stale" ]]; then
                echo -e "    ${YELLOW}autostart still points at ${NT_AUTOSTART_DIR[$net]} — remove it in Script 03 → G${RESET}"
            fi
            continue
        fi
        if [[ "${NT_RUNNING[$net]}" == "1" ]]; then
            state="${GREEN}RUNNING${RESET}"
        else
            state="${YELLOW}STOPPED${RESET}"
        fi
        case "${NT_SESSION[$net]}" in
            grin) sess="gtmux" ;;
            root) sess="${YELLOW}root tmux${RESET}" ;;
            *)    sess="${DIM}no session${RESET}" ;;
        esac
        line="  ${BOLD}${label}${RESET}  ${NT_MODE[$net]}  ${NT_DIR[$net]}  ${state}"
        if [[ -n "${NT_VERSION[$net]}" ]]; then line+="  v${NT_VERSION[$net]}"; fi
        line+="  ${sess}"
        case "${NT_AUTOSTART[$net]}" in
            on)    line+="  ${GREEN}autostart ✓${RESET}" ;;
            stale) line+="  ${YELLOW}autostart ✗${RESET}" ;;
            *)     line+="  ${DIM}autostart —${RESET}" ;;
        esac
        if [[ "${NT_ON_DISK[$net]}" != "1" ]]; then line+="  ${RED}(binary or config missing)${RESET}"; fi
        echo -e "$line"
        if [[ "${NT_ON_DISK[$net]}" != "1" && "${NT_RUNNING[$net]}" != "1" ]]; then
            echo -e "    ${YELLOW}cannot start — repair with 4) Rebuild a node → ${net} (full reinstall)${RESET}"
        fi
        if [[ "${NT_AUTOSTART[$net]}" == "stale" ]]; then
            echo -e "    ${YELLOW}autostart starts ${NT_AUTOSTART_DIR[$net]}, not this node — re-point it in Script 03 → G${RESET}"
        fi
        if [[ -n "${NT_EXTRA[$net]}" ]]; then
            echo -e "    ${YELLOW}also on disk: ${NT_EXTRA[$net]} (a second ${net} dir — only one can use the port)${RESET}"
        fi
    done

    for net in mainnet testnet; do
        if [[ -n "${NT_DIR[$net]}" && "${NT_IN_CONF[$net]}" != "1" ]]; then
            mism=1
            if [[ -z "${NT_CONF_DIR[$net]}" ]]; then
                echo -e "  ${YELLOW}conf: ${net} is on disk (${NT_DIR[$net]}) but the instances conf does not list it${RESET}"
            else
                echo -e "  ${YELLOW}conf: ${net} is registered as ${NT_CONF_DIR[$net]} but the node found is ${NT_DIR[$net]}${RESET}"
            fi
        elif [[ -z "${NT_DIR[$net]}" && -n "${NT_CONF_DIR[$net]}" ]]; then
            mism=1
            echo -e "  ${YELLOW}conf: ${net} is registered as ${NT_CONF_DIR[$net]} but that directory is gone${RESET}"
        fi
    done
    if (( mism == 0 )); then echo -e "  ${GREEN}conf ✓ matches disk${RESET}"; fi

    local fp
    for net in mainnet testnet; do
        fp="${NT_FOREIGN[$net]}"
        if [[ -n "$fp" ]]; then
            echo -e "  ${RED}P2P port $(_nt_p2p_port "$net") (${net}) is held by a non-grin process: pid ${fp%% *} (${fp#* })${RESET}"
        fi
    done
    return 0
}

# -----------------------------------------------------------------------------
# s01_stop_node <mainnet|testnet> — stop that network's node(s) only. Info line + rc 0 when nothing of it runs.
# Every grin dir of the network that has a live process gets: planned-stop marker → SIGTERM (stop_grin_one) → its own
# session killed on both tmux servers → leftover processes of THAT dir swept. Other network and wallet sessions are
# never named (exact session names, binary-matched processes).
# -----------------------------------------------------------------------------
s01_stop_node() {
    local net="${1:-}" d stopped=0
    _nt_valid_net "$net" || return 1
    s01_scan_nodes
    local -a dirs=()
    [[ -n "${NT_DIR[$net]}" ]]   && dirs+=("${NT_DIR[$net]}")
    [[ -n "${NT_EXTRA[$net]}" ]] && dirs+=("${NT_EXTRA[$net]}")
    for d in "${dirs[@]:-}"; do
        [[ -n "$d" ]] || continue
        _grin_proc_for_dir "$d" || continue
        info "Stopping the $net node ($d)..."
        stop_grin_one "$(_nt_p2p_port "$net")" "$d" || true
        gnc_kill_grin_session "$(_grin_session_name "$d")" "stop node"
        gnc_kill_grin_procs "$d" 10
        stopped=$(( stopped + 1 ))
    done
    if (( stopped == 0 )); then
        info "The $net node is not running — nothing to stop."
    fi
    return 0
}

# -----------------------------------------------------------------------------
# s01_stop_all — s01_stop_node for every network that is running (the body of stop_grin_gracefully). A loop over the
# node table, never a pattern sweep: a wallet session or an unregistered process is not this script's to stop.
# -----------------------------------------------------------------------------
s01_stop_all() {
    local net any=0
    s01_scan_nodes
    for net in mainnet testnet; do
        if [[ "${NT_RUNNING[$net]}" == "1" ]]; then
            any=1
            s01_stop_node "$net" || true
        fi
    done
    if (( any == 1 )); then
        success "All running Grin nodes stopped."
    else
        info "No Grin node is running."
    fi
    return 0
}

# -----------------------------------------------------------------------------
# s01_start_node <mainnet|testnet> — start the network's node from NT_DIR through gnc_launch_node_session (the launch
# contract: grin user, HOME=dir, chown, both-socket pre-kill, gtmux). Sets S01_LAST_START; rc 0 for launched and for
# already-running, 1 otherwise. A launch failure is reported and returned, never `die`d: callers loop over nodes.
# A grin process of the dir with no session on either tmux server is an orphan and is cleared first.
# -----------------------------------------------------------------------------
s01_start_node() {
    local net="${1:-}" dir session _toml _stale
    S01_LAST_START="failed"
    _nt_valid_net "$net" || return 1
    s01_scan_nodes
    dir="${NT_DIR[$net]}"
    if [[ -z "$dir" || "${NT_ON_DISK[$net]}" != "1" ]]; then
        error "No installed $net node found — nothing to start."
        return 1
    fi
    session="$(_grin_session_name "$dir")"
    if [[ "${NT_RUNNING[$net]}" == "1" ]]; then
        if [[ "${NT_SESSION[$net]}" != "none" ]]; then
            info "The $net node is already running (${dir})."
            S01_LAST_START="running"
            return 0
        fi
        warn "Orphaned Grin process in $dir (no tmux session) — clearing it before the start."
        gnc_mark_planned_stop "$session" "orphan cleared before start"
        while IFS= read -r _stale; do
            if [[ -n "$_stale" ]]; then kill -KILL "$_stale" 2>/dev/null || true; fi
        done < <(gnc_grin_pids_for_dir "$dir")
        sleep 1
    fi

    # Patch stale absolute paths in the toml (a migrated dir still points at the old location).
    _toml="$dir/grin-server.toml"
    sed -i "s|log_file_path\s*=\s*\".*\"|log_file_path = \"$dir/grin-server.log\"|" "$_toml" 2>/dev/null || true
    sed -i "s|api_secret_path\s*=\s*\".*\"|api_secret_path = \"$dir/.api_secret\"|" "$_toml" 2>/dev/null || true
    sed -i "s|foreign_api_secret_path\s*=\s*\".*\"|foreign_api_secret_path = \"$dir/.foreign_api_secret\"|" "$_toml" 2>/dev/null || true

    info "Starting $net node: $dir"
    if ! gnc_launch_node_session "$dir" "$dir/grin" "$session"; then
        error "Failed to create tmux session '$session'. Is tmux installed and working?"
        return 1
    fi
    success "Grin node will start shortly within 30 seconds in tmux session: $session."
    info "  Attach  : gtmux attach -t $session   ${DIM}(grin-owned — plain 'tmux attach' won't find it; detach: Ctrl+B, then D)${RESET}"
    log "[START] $net tmux session=$session started."
    S01_LAST_START="launched"
    return 0
}

# -----------------------------------------------------------------------------
# s01_full_reinstall <mainnet|testnet> — stop that network's node, delete its directories, then run the wizard for
# that network only (select_network is skipped; setup_one_node asks pruned/full through select_archive_mode).
# DESTRUCTIVE and unprompted: the caller owns the typed confirmation. Secrets and the .onion identity survive through
# the key vault and the Tor key dir. Only dirs under $NT_NODE_ROOT are ever removed.
# -----------------------------------------------------------------------------
s01_full_reinstall() {
    local net="${1:-}" d conf="${INSTANCES_CONF:-}"
    _nt_valid_net "$net" || return 1
    s01_stop_node "$net" || true

    _remove_instance_dirs "$net" || true
    # Registry-driven removal misses a dir the conf no longer lists: take what the scan still sees.
    s01_scan_nodes
    for d in "${NT_DIR[$net]}" "${NT_EXTRA[$net]}"; do
        [[ -n "$d" && -d "$d" ]] || continue
        if [[ "$d" != "$NT_NODE_ROOT"/* ]]; then
            warn "Leaving $d in place — it is outside $NT_NODE_ROOT."
            continue
        fi
        warn "Removing node directory: $d"
        rm -rf "${d:?}" || { error "Could not remove $d — reinstall aborted."; return 1; }
    done
    if [[ -n "$conf" && -f "$conf" ]]; then
        if [[ "$net" == "mainnet" ]]; then
            sed -i '/^PRUNEMAIN_\|^FULLMAIN_/d' "$conf" || warn "Could not clear the mainnet conf entries."
        else
            sed -i '/^PRUNETEST_/d' "$conf" || warn "Could not clear the testnet conf entries."
        fi
    fi

    NETWORK_TYPE="$net"
    RESTRICTED_NETWORK=""
    setup_one_node "$net"
    NETWORK_TYPE=""
    log "[FULL-REINSTALL] $net — completed"
    return 0
}
