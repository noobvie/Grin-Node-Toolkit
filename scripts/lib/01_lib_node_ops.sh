# =============================================================================
# lib/01_lib_node_ops.sh — Node lifecycle operations for Script 01: stop, remove, binary update, chain_data-only rebuild.
# =============================================================================
# Sourced by 01_build_new_grin_node.sh; shares its globals and log/info/warn/error helpers.
# Trap: runs with errexit off (the caller guards every call with `|| true`), so guard each file op with `|| { error ...; return 1; }`.

# =============================================================================
# HELPER: GRACEFUL GRIN SHUTDOWN
# -----------------------------------------------------------------------------
# Stops every node in the node table (s01_stop_all → s01_stop_node per running
# network): planned-stop marker, SIGTERM by pid and wait (up to 300 s — grin
# v5.5 may be mid LMDB migration or an MMR flush on shutdown, and a short kill
# window forces that work to re-run), SIGKILL for a survivor, then the node's
# own tmux session on BOTH tmux servers and a sweep of that dir's leftover
# processes. Wallet sessions share the grin_ prefix and are never touched.
# =============================================================================
stop_grin_gracefully() {
    s01_stop_all
}

# =============================================================================
# HELPER: REMOVE NODE DIRECTORIES FROM CONF
# -----------------------------------------------------------------------------
# Reads INSTANCES_CONF, finds the stored directory paths for the given
# networks, and deletes them from disk before a rebuild.
#   Usage: _remove_instance_dirs mainnet|testnet|all
# =============================================================================
_remove_instance_dirs() {
    [[ ! -f "$INSTANCES_CONF" ]] && return 0
    local _scope="${1:-all}"
    local _conf_content
    _conf_content=$(cat "$INSTANCES_CONF" 2>/dev/null) || return 0

    local _dirs=()
    local _d

    if [[ "$_scope" == "mainnet" || "$_scope" == "all" ]]; then
        for _var in PRUNEMAIN_GRIN_DIR FULLMAIN_GRIN_DIR; do
            _d=$(echo "$_conf_content" | grep "^${_var}=" 2>/dev/null | cut -d'"' -f2 || true)
            [[ -n "$_d" && -d "$_d" ]] && _dirs+=("$_d")
        done
    fi
    if [[ "$_scope" == "testnet" || "$_scope" == "all" ]]; then
        _d=$(echo "$_conf_content" | grep "^PRUNETEST_GRIN_DIR=" 2>/dev/null | cut -d'"' -f2 || true)
        [[ -n "$_d" && -d "$_d" ]] && _dirs+=("$_d")
    fi

    [[ ${#_dirs[@]} -eq 0 ]] && return 0
    for _d in "${_dirs[@]}"; do
        warn "Removing node directory: $_d"
        rm -rf "$_d" && success "Removed: $_d" || warn "Failed to remove: $_d"
    done

    # Clear conf entries only after directories are deleted
    if [[ -f "$INSTANCES_CONF" ]]; then
        [[ "$_scope" == "mainnet" || "$_scope" == "all" ]] && \
            sed -i '/^PRUNEMAIN_\|^FULLMAIN_/d' "$INSTANCES_CONF"
        [[ "$_scope" == "testnet" || "$_scope" == "all" ]] && \
            sed -i '/^PRUNETEST_/d' "$INSTANCES_CONF"
        log "Conf entries cleared for scope: $_scope"
    fi
}

# =============================================================================
# HELPER: STOP A SINGLE GRIN INSTANCE
# -----------------------------------------------------------------------------
# Stops only the instance on the given P2P port (SIGTERM → wait → SIGKILL) and
# kills its tmux session on both tmux servers, then sweeps leftover processes of
# that node dir.
#   Usage: stop_grin_one <port> [node_dir]   e.g. stop_grin_one 3414
# The node dir comes from the caller, else the instances conf, else the port
# holder's own binary, else the standard path. The port holder is signalled
# only when it is a grin process of THAT dir: a foreign listener, or the other
# network's node, is left alone. With nothing on the port the session and
# process sweep still run (a node that is still booting holds the lock file
# before it binds the port). Conf entries are left intact so _remove_instance_dirs
# can still read the directory after this returns.
# =============================================================================
stop_grin_one() {
    local target_port="$1" grin_dir="${2:-}"
    local stop_timeout=300 net pid exe

    if [[ "$target_port" == "3414" ]]; then net="mainnet"; else net="testnet"; fi
    pid=$(ss -tlnp "sport = :$target_port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)

    if [[ -z "$grin_dir" ]]; then
        grin_dir=$(gnc_resolve_node_dir "$net" 2>/dev/null || true)
    fi
    if [[ -z "$grin_dir" && -n "$pid" ]] && exe=$(_gnc_exe_path "$pid") && [[ "$(basename "$exe")" == "grin" ]]; then
        grin_dir="$(dirname "$exe")"
    fi
    if [[ -z "$grin_dir" ]]; then
        if [[ "$net" == "mainnet" && -d /opt/grin/node/mainnet-full ]]; then grin_dir=/opt/grin/node/mainnet-full
        elif [[ "$net" == "mainnet" ]]; then grin_dir=/opt/grin/node/mainnet-prune
        else grin_dir=/opt/grin/node/testnet-prune
        fi
    fi

    if [[ -n "$pid" ]] && ! gnc_grin_pids_for_dir "$grin_dir" | grep -qx "$pid"; then
        warn "Port $target_port is held by PID $pid, which is not a grin node of $grin_dir — leaving it alone."
        pid=""
    fi

    if [[ -z "$pid" ]]; then
        warn "No node process found on port $target_port."
    else
        # Planned-stop marker BEFORE the signal (this SIGTERM bypasses gnc_kill_*).
        local _sess
        if _sess=$(gnc_session_of_pid "$pid"); then gnc_mark_planned_stop "$_sess" "stop node"; fi

        info "PID $pid on port $target_port — sending SIGTERM..."
        kill -TERM "$pid" 2>/dev/null || true
        local count=0
        while ps -p "$pid" >/dev/null 2>&1 && [[ $count -lt $stop_timeout ]]; do
            sleep 2; count=$(( count + 2 ))
            if [[ $(( count % 10 )) -eq 0 ]]; then info "Waiting for Grin to stop... (${count}s)"; fi
        done
        if ps -p "$pid" >/dev/null 2>&1; then
            warn "Grin (PID $pid) still running — sending SIGKILL..."
            kill -KILL "$pid" 2>/dev/null || true; sleep 2
        fi
    fi

    # Session on BOTH tmux servers (root socket + gtmux socket), then any leftover
    # grin process for THIS node dir (duplicate on the other server, orphan) —
    # lock-file protection.
    local sess; sess="$(_grin_session_name "$grin_dir")"
    gnc_kill_grin_session "$sess" "stop node"
    info "Tmux session '$sess' cleared (both tmux servers)."
    gnc_kill_grin_procs "$grin_dir" 10

    success "Grin on port $target_port stopped."
    return 0
}

# =============================================================================
# HELPER: STAGGER GAP BETWEEN TWO NODE STARTS
# -----------------------------------------------------------------------------
#   Usage: _stagger_node_wait <seconds> <what-starts-next>
#
# Counts down, printing on one redrawn line, and returns early if the operator
# presses a key. Purely a pacing device: the node that already started keeps
# booting in its own tmux session while this waits, so skipping is never unsafe
# — it only puts the two boots back on top of each other.
#
# ⚠ The keypress poll is `read -t 1`, which is a 1-second SLEEP only while stdin
# is a terminal. With stdin closed/redirected (piped run, cron) read returns
# instantly at EOF and the countdown would spin through in milliseconds — i.e.
# no wait at all, exactly on the unattended runs that need it most. So the
# non-TTY case takes a plain `sleep` instead.
# =============================================================================
# -----------------------------------------------------------------------------
# _stagger_watchdog_note <network> — warn if the node-sync watchdog will cut the
# gap short. That watchdog (lib/grin_node_keepalive.sh, cron.d every 5 min)
# restarts any node it finds DOWN, and the gap deliberately leaves the next node
# down for up to GRIN_STAGGER_SECS — so with that network enabled the wait
# silently shrinks to ≤5 min and both nodes boot together after all.
# Advisory only: reaching into another product's cron from a binary update would
# be a worse surprise than the early start. Testnet ships DISABLED in the default
# watchdog config, so this normally prints nothing.
# -----------------------------------------------------------------------------
_stagger_watchdog_note() {
    local net="${1:-}"
    local wd_cron="/etc/cron.d/grin-node-sync-watchdog"
    local wd_conf="/opt/grin/conf/grin_node_watchdog.json"
    [[ -n "$net" && -f "$wd_cron" && -f "$wd_conf" ]] || return 0
    local en
    # python3 is the watchdog's own config reader; if it is absent here, skip the
    # note rather than guess from a grep (the key appears in the _comment too).
    en=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("enabled",{}).get(sys.argv[2],False))' \
            "$wd_conf" "$net" 2>/dev/null) || return 0
    [[ "$en" == "True" || "$en" == "true" ]] || return 0
    warn "Node-sync watchdog is ENABLED for $net and runs every 5 min — it may start"
    warn "  $net before this gap elapses. Disable it first if the gap must be exact."
    return 0
}

_stagger_node_wait() {
    local secs="${1:-0}" what="${2:-the next node}"
    [[ "$secs" =~ ^[0-9]+$ ]] || secs=0
    (( secs == 0 )) && return 0

    echo ""
    info "Letting the node settle before starting ${what} — grin 5.5 boot is CPU/disk heavy."
    if [[ ! -t 0 ]]; then
        info "Waiting ${secs}s (no terminal attached — cannot skip)..."
        sleep "$secs"
        return 0
    fi

    info "Waiting ${secs}s. Press ${BOLD}any key${RESET} to start ${what} immediately."
    local left="$secs" _k
    while (( left > 0 )); do
        printf '\r    starting %s in %5ds ...   ' "$what" "$left"
        if read -r -s -n 1 -t 1 _k; then
            printf '\r%-70s\r' ' '
            warn "Wait skipped — starting ${what} now."
            return 0
        fi
        left=$(( left - 1 ))
    done
    printf '\r%-70s\r' ' '
    return 0
}

# =============================================================================
# BINARY-ONLY UPDATE — one or both networks
# -----------------------------------------------------------------------------
#   Usage: update_binary_only [both|mainnet|testnet]      (default: both)
# Downloads the latest Grin release from GitHub ONCE, then walks the selected
# networks (mainnet first): stop that node → swap its binary → start it again if
# it was running. A node that was stopped gets the new binary and stays stopped;
# the network that was not selected is never touched. With two nodes the second
# waits GRIN_STAGGER_SECS (the boot is CPU/disk heavy) before it is stopped, so
# it keeps serving through the gap. Chain data is never touched. Returns 0 when
# every selected node was updated, 1 otherwise — it never exits the script.
#
# The replaced binary is kept twice, exactly as the source-build install does:
# <node_dir>/grin.prev (fast rollback, menu G option 4) and an archived copy in
# /opt/grin/bin (survives a node-dir wipe). See gsb_archive_replaced in
# lib/01_lib_source_build.sh for why those are two different jobs.
# =============================================================================
update_binary_only() {
    local which="${1:-both}" net rc=0
    step_header "Binary Update: ${which}"

    case "$which" in
        both|mainnet|testnet) ;;
        *) error "Unknown selection '$which' (expected both, mainnet or testnet)."; return 1 ;;
    esac

    s01_scan_nodes
    local -a sel_nets=() sel_dirs=()
    for net in mainnet testnet; do
        if [[ "$which" != "both" && "$which" != "$net" ]]; then continue; fi
        if [[ "${NT_ON_DISK[$net]}" == "1" ]]; then
            sel_nets+=("$net"); sel_dirs+=("${NT_DIR[$net]}")
        elif [[ "$which" != "both" ]]; then
            error "No installed $net node found."
            return 1
        fi
    done
    if (( ${#sel_nets[@]} == 0 )); then
        error "No installed Grin node found — nothing to update."
        return 1
    fi

    info "Updating ${#sel_nets[@]} node(s):"
    local i
    for i in "${!sel_nets[@]}"; do
        info "  → ${sel_dirs[$i]}  (${sel_nets[$i]})"
    done
    if (( ${#sel_nets[@]} > 1 && GRIN_STAGGER_SECS > 0 )); then
        warn "The nodes are updated ONE AT A TIME (mainnet first, then ${GRIN_STAGGER_SECS}s, then testnet)."
        warn "Keep this session open until the last node has started — ~$(( GRIN_STAGGER_SECS / 60 )) min of waiting."
    fi
    echo ""

    # Download latest binary once
    info "Querying GitHub for latest Grin release..."
    local release_json version download_url
    release_json=$(curl -fsSL --max-time 30 "$GRIN_GITHUB_API") \
        || { error "Failed to reach GitHub API. Check internet connection."; return 1; }
    version=$(echo "$release_json" | jq -r '.tag_name') \
        || { error "Could not read the release version from the GitHub reply."; return 1; }
    download_url=$(echo "$release_json" \
        | jq -r '.assets[] | select(.name | test("linux-x86_64\\.tar\\.gz$"; "i")) | .browser_download_url' \
        | head -1)
    if [[ -z "$download_url" || "$download_url" == "null" ]]; then
        error "No linux-x86_64 asset found for release '$version'."
        return 1
    fi

    info "Latest version : $version"
    info "Download URL   : $download_url"
    local tmp_tar="/tmp/grin_bin_$$.tar.gz"
    local tmp_dir="/tmp/grin_extract_$$"
    mkdir -p "$tmp_dir" || { error "Could not create $tmp_dir."; return 1; }
    wget -e background=off --progress=bar:force -O "$tmp_tar" "$download_url" \
        || { error "Binary download failed."; rm -rf "$tmp_tar" "$tmp_dir"; return 1; }
    tar -xzf "$tmp_tar" -C "$tmp_dir" \
        || { error "Failed to extract binary archive."; rm -rf "$tmp_tar" "$tmp_dir"; return 1; }
    rm -f "$tmp_tar"
    local grin_bin
    grin_bin=$(find "$tmp_dir" -type f -name "grin" | grep -v "grin-wallet" | head -1)
    if [[ -z "$grin_bin" ]]; then
        error "Could not locate 'grin' binary in the downloaded archive."
        rm -rf "$tmp_dir"
        return 1
    fi

    # Per node: stop → swap → start. Mainnet leads because it is the money/API
    # node every other product on the box points at.
    local started=0 dir was_running=0 prev_launched=0 prev_ok=0
    for i in "${!sel_nets[@]}"; do
        net="${sel_nets[$i]}"; dir="${sel_dirs[$i]}"
        if (( prev_launched == 1 && GRIN_STAGGER_SECS > 0 )); then
            _stagger_watchdog_note "$net"
            _stagger_node_wait "$GRIN_STAGGER_SECS" "the $net node"
        fi
        prev_launched=0
        s01_scan_nodes
        was_running="${NT_RUNNING[$net]}"
        echo ""
        s01_stop_node "$net" || true

        # Same backup contract as the source-build install (menu key G), so a bad
        # release can be rolled back too — and so a node that WAS running a source
        # build stops advertising itself as one. Without the .grin_binary_info
        # removal the G menu would keep labelling this node "(source build: …)"
        # while it now runs the official release, and its grin.prev would point
        # two steps back instead of at the binary this update just replaced.
        prev_ok=0
        if [[ -x "$dir/grin" ]]; then
            gsb_archive_replaced "$dir"
            if cp -a "$dir/grin" "$dir/grin.prev"; then
                prev_ok=1
            else
                warn "Could not write $dir/grin.prev — update continues without a rollback copy."
            fi
        fi
        rm -f "$dir/.grin_binary_info"

        info "Installing $version to $dir/grin ..."
        if ! install -m 755 "$grin_bin" "$dir/grin"; then
            error "Failed to install the new binary to $dir/grin."
            if [[ "$prev_ok" == "1" && ! -x "$dir/grin" ]]; then
                cp -a "$dir/grin.prev" "$dir/grin" \
                    || error "Could not restore the previous binary — it is at $dir/grin.prev."
            fi
            rc=1
        else
            success "Binary updated: $dir/grin"
        fi

        if [[ "$was_running" == "1" ]]; then
            if s01_start_node "$net"; then
                started=$(( started + 1 ))
                if [[ "$S01_LAST_START" == "launched" ]]; then prev_launched=1; fi
            else
                rc=1
            fi
        else
            info "The $net node was stopped before the update — leaving it stopped."
        fi
    done

    rm -rf "$tmp_dir"
    echo ""
    if (( rc == 0 )); then
        success "Grin $version installed on ${#sel_nets[@]} node(s); ${started} restarted."
    else
        warn "Update finished with errors — see the lines above."
    fi
    info    "Previous binary kept as <node_dir>/grin.prev — roll back from the"
    info    "menu key G (compile from source / roll back) → option 4."
    log "[BINARY UPDATE] version=$version nets=${sel_nets[*]} stagger=${GRIN_STAGGER_SECS}s rc=$rc"
    return "$rc"
}

# -----------------------------------------------------------------------------
# detect_installed_nodes — scan standard /opt/grin/node/* paths for already-built
# nodes (regardless of running state). Sets three parallel global arrays:
#   INSTALLED_NETS  = ("mainnet" "testnet" ...)
#   INSTALLED_DIRS  = ("/opt/grin/node/mainnet-prune" ...)
#   INSTALLED_MODES = ("prune" "prune" ...)
# A node is considered "installed" only when BOTH grin-server.toml and the grin
# binary exist in the directory — guards against half-removed leftovers.
# -----------------------------------------------------------------------------
detect_installed_nodes() {
    INSTALLED_NETS=()
    INSTALLED_DIRS=()
    INSTALLED_MODES=()
    local -a _check_dirs=(
        /opt/grin/node/mainnet-full
        /opt/grin/node/mainnet-prune
        /opt/grin/node/testnet-prune
    )
    local -a _check_nets=( mainnet mainnet testnet )
    local -a _check_modes=( full   prune   prune   )
    local i
    for i in "${!_check_dirs[@]}"; do
        local _d="${_check_dirs[$i]}"
        if [[ -f "$_d/grin-server.toml" && -x "$_d/grin" ]]; then
            INSTALLED_NETS+=("${_check_nets[$i]}")
            INSTALLED_DIRS+=("$_d")
            INSTALLED_MODES+=("${_check_modes[$i]}")
        fi
    done
}

# -----------------------------------------------------------------------------
# rebuild_chain_data_only — surgical recovery for a node whose chain_data is
# corrupted but everything else (config, secrets, .onion identity) is intact.
# Removes ONLY $GRIN_DIR/chain_data, then re-downloads + extracts + starts.
# Preserves: grin-server.toml, .api_secret, .foreign_api_secret, Tor HiddenService
#            keys in /var/lib/tor/grin-<network>-raw-tcp/, INSTANCES_CONF entries.
# Usage: rebuild_chain_data_only <network> <node_dir>
# -----------------------------------------------------------------------------
rebuild_chain_data_only() {
    local network="$1" node_dir="$2"

    # Defensive prefix guard: only ever operate inside $NT_NODE_ROOT/<network>-<mode>.
    # Prevents any future caller from passing an unexpected path that would cause
    # rm -rf to act outside the node tree (where sibling services live).
    if [[ "$node_dir" != "$NT_NODE_ROOT"/* ]]; then
        error "Refusing to rebuild — node_dir '$node_dir' is not under $NT_NODE_ROOT/."
        return 1
    fi

    local archive_mode
    case "$node_dir" in
        *-full)  archive_mode="full"  ;;
        *-prune) archive_mode="prune" ;;
        *) error "Cannot derive archive_mode from $node_dir"; return 1 ;;
    esac

    step_header "Rebuild chain_data only: $network ($archive_mode mode)"

    if [[ ! -f "$node_dir/grin-server.toml" ]]; then
        error "Missing $node_dir/grin-server.toml — not a valid install."
        return 1
    fi
    if [[ ! -x "$node_dir/grin" ]]; then
        error "Missing $node_dir/grin binary — use Rebuild a node → full reinstall instead."
        return 1
    fi

    echo ""
    warn  "This action will:"
    warn  "  • DELETE   $node_dir/chain_data  (forces full re-sync — hours to days)"
    info  "  • PRESERVE grin-server.toml + .api_secret + .foreign_api_secret"
    info  "  • PRESERVE Tor HiddenService keys (.onion identity stays the same)"
    info  "  • PRESERVE instance registry, wallet dirs, nginx config"
    echo ""
    echo -ne "${BOLD}Type ${RED}REBUILD${RESET}${BOLD} to confirm, or Enter to cancel: ${RESET}"
    local _confirm
    read -r _confirm || true
    if [[ "$_confirm" != "REBUILD" ]]; then
        info "Cancelled — no changes made."
        return "${S01_RC_BACK:-1}"
    fi

    # Stop this network's node, including one still booting (lock held, P2P port not yet bound), and refuse
    # to delete anything under a grin process that survives.
    s01_stop_node "$network" || true
    if _grin_proc_for_dir "$node_dir"; then
        error "A grin process of $node_dir is still alive — chain_data left untouched."
        return 1
    fi

    # Set globals so the reused step functions resolve to the right paths
    GRIN_DIR="$node_dir"
    NETWORK_TYPE="$network"
    ARCHIVE_MODE="$archive_mode"

    # Delete corrupted chain_data (the only destructive step).
    # ${node_dir:?} guards against an empty variable accidentally resolving
    # the path to "/chain_data" — never delete anything if node_dir is unset.
    if [[ -d "${node_dir:?}/chain_data" ]]; then
        info "Removing ${node_dir}/chain_data ..."
        rm -rf "${node_dir:?}/chain_data" || { error "Could not remove ${node_dir}/chain_data."; return 1; }
        success "Old chain_data removed."
    fi

    # Re-run the chain-data acquisition steps from setup_one_node, no other changes.
    # GRIN_SKIP_DISK_CHECK=1: the node dir already exists, so the fresh-install footprint
    # check does not apply.
    GRIN_SKIP_DISK_CHECK=1
    download_chain_data "$network" "$archive_mode"
    if [[ "$SLOW_SYNC_MODE" == "true" ]]; then
        info "Slow sync selected — no archive downloaded. The node will re-sync from peers."
        log  "[REBUILD-CHAIN-ONLY] Slow sync — skipping download/verify/extract."
    elif [[ "$STREAM_MODE" == "true" ]]; then
        stream_extract_chain_data
    else
        verify_checksum
        check_disk_space
        extract_chain_data
    fi

    start_grin_tmux

    # Idempotently re-assert the Tor HiddenService marker block (no-op if unchanged).
    # The key dir was never touched, so the .onion address survives.
    local _rb_api_port
    if _rb_api_port=$(_grin_api_port "$network"); then
        _grin_torrc_install "$network" "$_rb_api_port" || true
    fi

    show_summary "$network" "$archive_mode"
    # Refresh INSTANCES_CONF so ONION_HOSTNAME stays current (handles operators
    # who built the node before this field existed).
    save_instance_location "$network" "$archive_mode"

    # This path never touched the secrets (chain_data only), but the sync also
    # seeds the vault from the live node and installs the self-heal timer — so
    # an operator who only ever uses R still ends up vault-protected.
    _sync_secret_consumers "$network"

    # Reset per-node state for any subsequent action in the same script invocation
    GRIN_DIR=""
    TAR_FILE=""
    SHA_FILE=""
    ARCHIVE_MODE=""
    STREAM_MODE=false
    SLOW_SYNC_MODE=false
    READY_SOURCES=()
    log "[REBUILD-CHAIN-ONLY] $network ($archive_mode) — completed"
    return 0
}

# -----------------------------------------------------------------------------
# _describe_installed_node — emit a one-line summary of an installed node
# directory: binary version, chain_data size, chain_data last-modified date.
# Information only — no health check. Used by the Super Auto confirmation so the user
# can see what is about to be deleted.
#   Usage: _describe_installed_node /opt/grin/node/mainnet-prune
# Prints "(not installed)" if the binary is missing.
# -----------------------------------------------------------------------------
_describe_installed_node() {
    local d="$1"
    if [[ -z "$d" || ! -x "$d/grin" ]]; then
        echo "(not installed)"
        return
    fi
    local ver size mtime
    ver=$("$d/grin" --version 2>/dev/null | awk '{print $NF}')
    [[ -z "$ver" ]] && ver="?"
    if [[ -d "$d/chain_data" ]]; then
        size=$(du -sh "$d/chain_data" 2>/dev/null | cut -f1)
        mtime=$(stat -c '%y' "$d/chain_data" 2>/dev/null | cut -d' ' -f1)
        [[ -z "$size"  ]] && size="?"
        [[ -z "$mtime" ]] && mtime="?"
    else
        size="-"
        mtime="never"
    fi
    echo "version=${ver}  chain_data=${size}  modified=${mtime}"
}

