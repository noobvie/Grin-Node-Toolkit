# =============================================================================
# lib/01_lib_node_launch.sh — Node start, summary and Tor onion setup for Script 01 (start goes through gnc_launch_node_session).
# =============================================================================
# Sourced by 01_build_new_grin_node.sh; shares its globals and log/info/warn/error helpers.
# Trap: runs with errexit off (the caller guards every call with `|| true`), so guard each file op with `|| { error ...; return 1; }`.

# =============================================================================
# HELPER: CHECK IF A GRIN PROCESS IS RUNNING FOR A SPECIFIC NODE DIRECTORY
# -----------------------------------------------------------------------------
# Matches the process BINARY (gnc_grin_pids_for_dir), so mainnet and testnet
# stay distinct even when both are installed. Never cwd: the tmux server both
# nodes share has the first node's dir as its cwd and `grin server run` in its
# argv, so a cwd match "found" a node that was not running (086 design F-7).
# Returns 0 (found) or 1 (not found).
# =============================================================================
_grin_proc_for_dir() {
    [[ -n "$(gnc_grin_pids_for_dir "$1")" ]]
}

# =============================================================================
# [13] START GRIN NODE IN A TMUX SESSION
# -----------------------------------------------------------------------------
# Creates a named tmux session: grin_<nodetype>_<networktype>
#   e.g. grin_full_mainnet, grin_pruned_mainnet, grin_pruned_testnet
# If a session with that name already exists, it is killed first.
# Runs './grin server run' inside the session so the node starts in TUI mode.
# The session stays open after grin exits so the user can read any output.
# The node runs grin-owned on the grin user's tmux socket, so a plain root
# `tmux attach` will NOT find it (lib/grin_node_control.sh, launch contract).
# Attach with: gtmux attach -t <session>   |   Detach: Ctrl+B then D
# =============================================================================
start_grin_tmux() {
    step_header "Step 13: Start Grin Node (tmux)"
    local session; session="$(_grin_session_name "$GRIN_DIR")"

    # ── Boot/duplication guard ────────────────────────────────────────────────
    # If a grin process already owns this node directory (booting or running but
    # port not yet bound), check whether it has a live tmux session — on EITHER
    # tmux server (grin's gtmux socket AND root's; the @reboot autostart runs
    # grin-owned, so a root-only check would miss it and start a duplicate
    # that died on "lock file is held by another grin process").
    #   • Live process  + live tmux session → truly running, skip to avoid grin.lock conflict.
    #   • Live process  + NO  tmux session  → orphaned/stale (tmux was killed while grin kept
    #     running, re-parented to PID 1).  Kill the stale process and proceed with a fresh start.
    if _grin_proc_for_dir "$GRIN_DIR"; then
        if gnc_has_grin_session "$session"; then
            warn "Grin is already starting or running in $GRIN_DIR — skipping duplicate launch."
            if [[ "$GNC_SESSION_SOCKET" == "grin" ]]; then
                info "View: ${BOLD}gtmux attach -t $session${RESET}  ${DIM}(grin-owned — plain 'tmux attach' won't find it)${RESET}"
            else
                info "View: tmux attach -t $session"
            fi
            info "Wait for the node to finish booting, then re-run if needed."
            return 0
        else
            warn "Orphaned Grin process detected in $GRIN_DIR (no tmux session). Killing stale process..."
            # Binary-matched (gnc_grin_pids_for_dir): a cwd match would SIGKILL the
            # tmux server that hosts the OTHER network's node. Marker first, so
            # the node event recorder logs this as a planned stop.
            gnc_mark_planned_stop "$session" "orphan cleared before start"
            while IFS= read -r _stale_pid; do
                [[ -n "$_stale_pid" ]] || continue
                info "  Killing PID $_stale_pid ($GRIN_DIR/grin)"
                kill -KILL "$_stale_pid" 2>/dev/null || true
            done < <(gnc_grin_pids_for_dir "$GRIN_DIR")
            sleep 1
            info "Stale process cleared — proceeding with fresh start."
        fi
    fi

    # Launch via the shared contract launcher (lib/grin_node_control.sh). It:
    #   · kills any stale '$session' on BOTH tmux servers,
    #   · sweeps leftover `grin server run` processes for THIS dir (lock-file
    #     protection against duplicates hidden on the other tmux server),
    #   · starts grin AS the grin user with HOME=$GRIN_DIR on grin's tmux
    #     socket (view via gtmux), chowning the dir first,
    #   · closes fd 9 (script-01 flock) so the tmux server never inherits it,
    #   · installs the gtmux viewer helper.
    gnc_launch_node_session "$GRIN_DIR" "$GRIN_DIR/grin" "$session" \
        || die "Failed to create tmux session '$session'. Is tmux installed and working?"

    success "Grin node will start shortly within 30 seconds in tmux session: $session."
    info "  Attach  : gtmux attach -t $session   ${DIM}(grin-owned — plain 'tmux attach' won't find it)${RESET}"
    info "  Detach  : Ctrl+B, then D"
    info "  List    : gtmux ls"
    log "[STEP 13] Tmux session=$session started."
}

# =============================================================================
# [14] SHOW RESULT SUMMARY AND LOG ELAPSED TIME
# -----------------------------------------------------------------------------
# Prints a summary of the completed setup: network, mode, directory, tmux
# session name, total time taken, and log file path.
# Full log is written to: /opt/grin/logs/01_build_new_grin_node_<timestamp>.log
# =============================================================================
show_summary() {
    local network="$1"
    local mode="$2"
    local elapsed=$(( $(date +%s) - SCRIPT_START_TIME ))
    local mins=$(( elapsed / 60 ))
    local secs=$(( elapsed % 60 ))
    local session; session="$(_grin_session_name "$GRIN_DIR")"

    echo ""
    echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${GREEN}  Grin Node Setup Complete!${RESET}"
    echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Network      : ${CYAN}$network${RESET}"
    echo -e "  Mode         : ${CYAN}$mode${RESET}"
    [[ "$SLOW_SYNC_MODE" == "true" ]] && \
        echo -e "  Chain data   : ${YELLOW}syncing from peers (slow sync — no archive)${RESET}"
    echo -e "  Directory    : ${CYAN}$GRIN_DIR${RESET}"
    echo -e "  Tmux session : ${CYAN}$session${RESET}"
    echo -e "  Time taken   : ${CYAN}${mins}m ${secs}s${RESET}"
    echo -e "  Log file     : ${CYAN}$LOG_FILE${RESET}"

    # Tor .onion address (if Step 13b set up a HiddenService and tor has published it).
    # Poll briefly — tor usually generates the keys within a few seconds of reload.
    local _onion_addr
    _onion_addr=$(_grin_read_onion "$network" 20 2>/dev/null || true)
    if [[ -n "$_onion_addr" ]]; then
        echo -e "  Onion mirror : ${CYAN}http://${_onion_addr}${RESET}  ${DIM}(Foreign API via Tor)${RESET}"
    else
        echo -e "  Onion mirror : ${YELLOW}(not yet published — tor may still be generating keys)${RESET}"
        echo -e "                 ${DIM}Check later: cat /var/lib/tor/grin-${network}-raw-tcp/hostname${RESET}"
    fi

    echo ""
    echo -e "${BOLD}  Quick commands:${RESET}"
    echo -e "  ${YELLOW}gtmux attach -t $session${RESET}   — view node output ${DIM}(grin-owned — plain 'tmux attach' won't find it)${RESET}"
    echo -e "  ${YELLOW}gtmux ls${RESET}                   — list node sessions"
    echo -e "  ${YELLOW}grep ONION $INSTANCES_CONF${RESET}   — recall onion URLs"
    echo ""
    echo -e "  ${YELLOW}⚠  Back up your .onion identity${RESET} — ${DIM}/var/lib/tor/grin-${network}-raw-tcp/${RESET}"
    echo -e "     contains the Ed25519 keypair that defines your .onion address."
    echo -e "     Use ${BOLD}Script 089 → Backup${RESET} to include it in your encrypted backup"
    echo -e "     so you can migrate this identity to another VPS later."
    echo -e "     ${DIM}To restore manually (e.g. after a VPS migration):${RESET}"
    echo -e "     ${DIM}  cp -r ~/backup/grin-${network}-raw-tcp/ /var/lib/tor/grin-${network}-raw-tcp/${RESET}"
    echo -e "     ${DIM}  # Debian/Ubuntu: debian-tor:debian-tor  |  Rocky/Alma: toranon:toranon${RESET}"
    echo -e "     ${DIM}  chown -R \$(stat -c '%U:%G' /var/lib/tor 2>/dev/null || echo 'debian-tor:debian-tor') /var/lib/tor/grin-${network}-raw-tcp/${RESET}"
    echo -e "     ${DIM}  chmod 700 /var/lib/tor/grin-${network}-raw-tcp/${RESET}"
    echo -e "     ${DIM}  systemctl restart tor   # full restart required to re-read keys${RESET}"
    echo ""
    if [[ "$SUPER_AUTO" == "true" ]]; then
        echo -e "  ${GREEN}✓  Auto-start, watchdog, event recorder & log rotation${RESET} are being configured automatically."
    else
        echo -e "  ${CYAN}→${RESET}  Auto-start on reboot is offered next (Step 14c). It can also be changed later in"
        echo -e "     ${BOLD}3) Share Grin Chain Data / Schedule${RESET} → option ${GREEN}G) Auto startup Grin node${RESET}"
    fi
    echo -e "${BOLD}${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

    log "[STEP 14] DONE. network=$network mode=$mode dir=$GRIN_DIR time=${mins}m${secs}s onion=${_onion_addr:-pending}"
}

# =============================================================================
# Save grin instance paths to shared conf file for use by other scripts (e.g. 03).
# Only the block for the current key is replaced — other instances are untouched.
# =============================================================================
save_instance_location() {
    local network="$1" mode="$2"
    local key
    if [[ "$mode" == "full" ]]; then
        key="FULLMAIN"
    elif [[ "$network" == "testnet" ]]; then
        key="PRUNETEST"
    else
        key="PRUNEMAIN"
    fi

    mkdir -p "$CONF_DIR"
    if [[ -f "$INSTANCES_CONF" ]]; then
        # Remove current key and, for mainnet, also remove the sibling mainnet key
        # (PRUNEMAIN and FULLMAIN are mutually exclusive — one server, one mainnet mode)
        sed -i "/^${key}_/d" "$INSTANCES_CONF"
        [[ "$key" == "FULLMAIN"  ]] && sed -i '/^PRUNEMAIN_/d' "$INSTANCES_CONF"
        [[ "$key" == "PRUNEMAIN" ]] && sed -i '/^FULLMAIN_/d'  "$INSTANCES_CONF"
    fi

    # Cache the .onion hostname so other toolkit scripts (and the operator) can
    # look it up without grepping /var/lib/tor. Short poll: tor usually has the
    # file ready by now since show_summary already polled before this call.
    # Empty string if tor hasn't published yet — refreshed on the next rebuild.
    local _onion=""
    _onion=$(_grin_read_onion "$network" 5 2>/dev/null || true)

    cat >> "$INSTANCES_CONF" << __EOF__

${key}_GRIN_DIR="$GRIN_DIR"
${key}_BINARY="$GRIN_DIR/grin"
${key}_TOML="$GRIN_DIR/grin-server.toml"
${key}_CHAIN_DATA="$GRIN_DIR/chain_data"
${key}_ONION_HOSTNAME="${_onion}"
__EOF__
    chmod 600 "$INSTANCES_CONF"
    log "Instance location saved: $key → $GRIN_DIR (onion=${_onion:-pending})"
}

# =============================================================================
# [TOR ONION] Hidden-service helpers
# -----------------------------------------------------------------------------
# Idempotently install a marker-bounded HiddenService stanza in /etc/tor/torrc
# pointing at the local grin Foreign API. Each network gets its own .onion
# address whose identity (Ed25519 keypair) lives in /var/lib/tor/grin-<net>-raw-tcp/.
# Those key dirs are preserved across rebuilds so the same .onion address
# survives a re-run of this script.
#
# torrc stanza written (per network):
#     # >>> grin-toolkit:<network>-raw-tcp >>>
#     HiddenServiceDir /var/lib/tor/grin-<network>-raw-tcp/
#     HiddenServicePort 80 127.0.0.1:<api_port>
#     # <<< grin-toolkit:<network>-raw-tcp <<<
#
# Anything the operator has placed outside these markers in torrc is untouched.
# =============================================================================

_grin_api_port() {
    case "$1" in
        mainnet) echo 3413  ;;
        testnet) echo 13413 ;;
        *) error "_grin_api_port: unknown network '$1' (expected mainnet|testnet)"; return 1 ;;
    esac
}

# Install or update the toolkit-marked Tor HiddenService stanza for one network.
# Compares the existing block against the expected block; if identical, no file
# write and no tor reload happens (so a chain_data rebuild does not republish the
# hidden service descriptor needlessly).
_grin_torrc_install() {
    local network="$1" api_port="$2"
    local torrc="/etc/tor/torrc"
    local begin="# >>> grin-toolkit:${network}-raw-tcp >>>"
    local end="# <<< grin-toolkit:${network}-raw-tcp <<<"
    local hs_dir="/var/lib/tor/grin-${network}-raw-tcp/"
    local expected
    expected=$(printf '%s\nHiddenServiceDir %s\nHiddenServicePort 80 127.0.0.1:%s\n%s' \
        "$begin" "$hs_dir" "$api_port" "$end")

    if [[ ! -f "$torrc" ]]; then
        warn "$torrc not found — tor may not be installed. Skipping HiddenService setup."
        return 1
    fi

    # Migrate old naming convention: grin-toolkit:<network> → grin-toolkit:<network>-raw-tcp
    # Strips the old stanza so the normal append path writes the correctly-named one.
    local _old_begin="# >>> grin-toolkit:${network} >>>"
    local _old_end="# <<< grin-toolkit:${network} <<<"
    if grep -qF "$_old_begin" "$torrc" 2>/dev/null; then
        info "Migrating torrc stanza: grin-toolkit:${network} → grin-toolkit:${network}-raw-tcp"
        local _tmp="${torrc}.toolkit.tmp"
        awk -v b="$_old_begin" -v e="$_old_end" '
            $0 == b { skip=1; next }
            $0 == e { skip=0; next }
            !skip
        ' "$torrc" > "$_tmp" && mv "$_tmp" "$torrc"
    fi
    # Migrate old directory name if it exists and the new name doesn't yet
    local _old_dir="/var/lib/tor/grin-${network}"
    if [[ -d "$_old_dir" && ! -d "${hs_dir%/}" ]]; then
        info "Renaming $_old_dir → ${hs_dir%/} (preserving .onion identity)"
        mv "$_old_dir" "${hs_dir%/}"
    fi

    # Extract existing marker-bounded block (literal string match, no regex escaping)
    local existing
    existing=$(awk -v b="$begin" -v e="$end" '
        $0 == b { in_block=1 }
        in_block { print }
        $0 == e { in_block=0 }
    ' "$torrc")

    if [[ "$existing" == "$expected" ]]; then
        info "Tor HiddenService for ${network}: already configured (no change)."
        log "[TOR] HiddenService ${network}: unchanged"
        return 0
    fi

    # Remove any previous toolkit block for this network (literal-match awk)
    if [[ -n "$existing" ]]; then
        local tmp="${torrc}.toolkit.tmp"
        awk -v b="$begin" -v e="$end" '
            $0 == b { in_block=1; next }
            $0 == e { in_block=0; next }
            !in_block
        ' "$torrc" > "$tmp" && mv "$tmp" "$torrc"
    fi

    # Append fresh block (leading blank line for readability)
    { echo ""; echo "$expected"; } >> "$torrc"

    if systemctl reload tor 2>/dev/null; then
        success "Tor HiddenService for ${network}: written, tor reloaded."
    elif systemctl restart tor 2>/dev/null; then
        success "Tor HiddenService for ${network}: written, tor restarted."
    else
        warn "Tor HiddenService for ${network}: written, but tor reload/restart failed — restart manually."
        return 1
    fi
    log "[TOR] HiddenService ${network}: port 80 → 127.0.0.1:${api_port}"
    return 0
}

# Poll /var/lib/tor/grin-<network>-raw-tcp/hostname until tor publishes it (or timeout).
# Returns the .onion URL on stdout (decorated with a human-readable subdomain
# prefix per network), or empty string on timeout.
#
# Tor ignores all labels left of the trailing <56-char>.onion hash, so we
# prepend a self-documenting prefix that makes the URL meaningful to users:
#     mainnet → main.grin.<hash>.onion
#     testnet → test.grin.<hash>.onion
# The cryptographic identity (the hash) is unchanged; this is pure labelling.
_grin_read_onion() {
    local network="$1"
    local hostname_file="/var/lib/tor/grin-${network}-raw-tcp/hostname"
    local max_wait="${2:-30}"
    local waited=0
    while [[ ! -f "$hostname_file" && $waited -lt $max_wait ]]; do
        sleep 1
        waited=$((waited + 1))
    done
    [[ -f "$hostname_file" ]] || return 0

    local prefix
    case "$network" in
        mainnet) prefix="main.grin." ;;
        testnet) prefix="test.grin." ;;
        *)       prefix=""           ;;
    esac
    printf '%s%s\n' "$prefix" "$(cat "$hostname_file")"
}
