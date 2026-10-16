# =============================================================================
# lib/01_lib_super_auto.sh — Super Auto for Script 01: one-hit wipe and rebuild of both nodes plus post-build hardening.
# =============================================================================
# Sourced by 01_build_new_grin_node.sh; shares its globals and log/info/warn/error helpers.
# Trap: runs with errexit off (the caller guards every call with `|| true`), so guard each file op with `|| { error ...; return 1; }`.

# =============================================================================
# [SUPER AUTO] One-hit: wipe & rebuild BOTH nodes (pruned) + full hardening
# -----------------------------------------------------------------------------
# Opinionated, minimal-interaction path behind menu key A:
#   • both networks, PRUNED only     • on-the-fly streamed chain data
#   • kills every running node and deletes existing binaries + chain_data first
#   • after each build: @reboot autostart + node-sync watchdog + node event
#     recorder + log rotation
# The ONLY interaction is a soft 20 GB free-space gate (warn + FORCE override)
# and a single state-aware confirmation. Reuses the existing K-path helpers
# (stop_grin_gracefully / _remove_instance_dirs) — no duplicated kill/wipe logic.
# =============================================================================

# Free GiB on the filesystem that holds (or will hold) /opt/grin/node.
_super_auto_free_gb() {
    local p="/opt/grin/node"
    while [[ ! -d "$p" && "$p" != "/" ]]; do p=$(dirname "$p"); done
    local kb; kb=$(df -Pk "$p" 2>/dev/null | awk 'NR==2{print $4}') || kb=0
    echo $(( kb / 1024 / 1024 ))
}

# Install logrotate for one node's grin-server.log.
# grin holds the log open for the life of the process and does NOT reopen it on
# SIGHUP, so rotation MUST use copytruncate (copy then zero in place) — a
# rename/create cycle would leave grin writing to the old inode and rotation
# would silently stop after the first cycle. Idempotent (overwrites its own file).
_install_grin_logrotate() {
    local network="$1" node_dir="$2"
    local conf="/etc/logrotate.d/grin-node-${network}"
    local logpath="${node_dir}/grin-server.log"

    if [[ ! -d /etc/logrotate.d ]]; then
        warn "logrotate not present (/etc/logrotate.d missing) — skipping log rotation for ${network}."
        return 0
    fi

    cat > "$conf" <<EOF
# grin-node-toolkit: Super Auto log rotation for the ${network} node.
# copytruncate is required — grin keeps the log open and never reopens on SIGHUP.
${logpath} {
    daily
    rotate 7
    size 50M
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
}
EOF
    chmod 644 "$conf"
    success "Log rotation installed: ${conf} (daily, 50M cap, keep 7, compressed)."
    log "[SUPER AUTO] logrotate → $conf for $logpath"
}

# Post-build hardening bundle for one network (autostart + watchdog + event
# recorder + logrotate). Runs from setup_one_node AFTER save_instance_location so
# gnk_autostart_enable can resolve the node dir from INSTANCES_CONF. Every step
# is idempotent; the recorder is one install for both nets, so the second call
# only refreshes it (its check creates the second net's dir on its own).
# The watchdog goes BEFORE the recorder: the recorder install is what makes the
# watchdog's capture hook live, and both are regenerated from this checkout.
_super_auto_harden() {
    local network="$1" node_dir="$2"
    step_header "Super Auto: Post-build hardening (${network})"
    gnk_autostart_enable "$network" || warn "Autostart enable failed for ${network} — set it up later via Script 03 → G."
    gnk_watchdog_install            || warn "Watchdog install failed — set it up later via Script 07 health menu."
    gne_install                     || warn "Event recorder install failed — set it up later via hub 08 → Diagnostics → Node event recorder."
    _install_grin_logrotate "$network" "$node_dir" || warn "Log rotation setup failed for ${network}."
}

# _offer_autostart <network> <node_dir> — the custom wizard's post-build offer of the @reboot
# line (default YES), once per node. gnk_autostart_enable REPLACES the network's
# tagged line, so accepting also re-points a line a pruned↔full rebuild left on the
# old dir. Declining leaves the crontab untouched. Runs after save_instance_location:
# gnk_autostart_enable resolves the node dir from the instances conf only.
_offer_autostart() {
    local network="$1" node_dir="$2" cur _ans=""
    declare -F gnk_autostart_enable >/dev/null 2>&1 || return 0
    cur="$(_nt_autostart_dir "$network" "$(crontab -l 2>/dev/null || true)")"

    step_header "Step 14c: Reboot autostart (${network})"
    echo -e "  Adds an @reboot crontab line that starts this node as the grin user after"
    echo -e "  the server restarts. ${DIM}Delay: mainnet 5 s, testnet 1000 s (two nodes booting together overload a small VPS).${RESET}"
    echo -e "  ${DIM}Change it later in Script 03 → G.${RESET}"
    echo ""
    if [[ -n "$cur" && "$cur" == "${node_dir%/}" ]]; then
        echo -ne "  ${BOLD}Autostart is already on for ${node_dir} — rewrite it with this toolkit version? [Y/n]: ${RESET}"
    elif [[ -n "$cur" ]]; then
        warn "The ${network} autostart line starts ${cur}, not this node."
        echo -ne "  ${BOLD}Point autostart at ${node_dir}? [Y/n]: ${RESET}"
    else
        echo -ne "  ${BOLD}Start this node automatically after a reboot? [Y/n]: ${RESET}"
    fi
    # EOF declines; only an explicit n is no.
    read -r _ans || _ans="n"
    if [[ "${_ans,,}" == "n" || "${_ans,,}" == "no" ]]; then
        info "Skipped — crontab not changed. Set it up later in Script 03 → G."
        log "[STEP 14c] autostart declined for ${network}"
        return 0
    fi
    if gnk_autostart_enable "$network"; then
        log "[STEP 14c] autostart enabled for ${network} (${node_dir})"
    else
        warn "Autostart setup failed for ${network} — set it up later in Script 03 → G."
    fi
    return 0
}

# _offer_event_recorder — the custom wizard's post-build offer (default YES),
# once per run. Super Auto installs it without asking (_super_auto_harden).
# The recorder is READ-ONLY: it never restarts a node, so it does not compete
# with the sync watchdog — it records what happened and keeps the evidence.
_offer_event_recorder() {
    [[ "$RECORDER_OFFERED" == "true" ]] && return 0
    RECORDER_OFFERED=true
    declare -F gne_install >/dev/null 2>&1 || return 0
    local _ans=""
    step_header "Step 14d: Node event recorder"
    echo -e "  Records every down/up of this node (crash, hang, failed start, chain_data"
    echo -e "  corruption), keeps planned stops out of the count, and saves the node's"
    echo -e "  console and logs at the moment of failure. ${DIM}Read-only — it never restarts a node.${RESET}"
    echo -e "  ${DIM}Timer every 30 s · view it in hub 08 → Diagnostics → Node event recorder.${RESET}"
    echo ""
    if [[ -x "$GNE_BIN" ]]; then
        echo -ne "  ${BOLD}The recorder is installed — refresh it to this toolkit version? [Y/n]: ${RESET}"
    else
        echo -ne "  ${BOLD}Install the node event recorder? [Y/n]: ${RESET}"
    fi
    # EOF declines (project_prompt_default_catchall); only an explicit n is no.
    read -r _ans || _ans="n"
    if [[ "${_ans,,}" == "n" || "${_ans,,}" == "no" ]]; then
        info "Skipped — install it later from hub 08 → Diagnostics → Node event recorder."
        log "[STEP 14d] event recorder declined"
        return 0
    fi
    if gne_install; then
        log "[STEP 14d] event recorder installed/refreshed"
    else
        warn "Event recorder install failed — retry from hub 08 → Diagnostics → Node event recorder."
    fi
    return 0
}

# run_super_auto — the one-hit handler. Returns 0 on completion (caller exits 0),
# 1 on cancel (caller re-shows its menu / falls through).
run_super_auto() {
    step_header "Super Auto — Wipe & Rebuild Both Nodes (pruned)"

    # ── 1. Soft 20 GB disk gate (warn + FORCE override) ─────────────────────────
    local _min_gb=20 _free_gb
    _free_gb=$(_super_auto_free_gb)
    echo ""
    echo -e "  Free space (fs holding /opt/grin/node): ${BOLD}${_free_gb} GiB${RESET}  (required: ${_min_gb} GiB)"
    if (( _free_gb < _min_gb )); then
        echo ""
        warn "Low disk space: ${_free_gb} GiB free — Super Auto recommends ≥ ${_min_gb} GiB"
        warn "for two pruned nodes (streamed chain data + headroom)."
        echo ""
        echo -ne "  Type ${BOLD}FORCE${RESET} to proceed anyway, or Enter to cancel: "
        local _fc; read -r _fc || true
        if [[ "$_fc" != "FORCE" ]]; then
            info "Super Auto cancelled — free up space and retry."
            return 1
        fi
        warn "Overriding disk gate on user request."
    else
        success "Disk space OK for Super Auto."
    fi

    # ── 2. State-aware confirmation ─────────────────────────────────────────────
    # NOTE: under `set -e`, a bare `cmd && var=true` aborts the script when cmd is
    # false, so every detection below uses the if-form.
    local _running=false _installed=false
    if ss -tlnp "sport = :3414"  2>/dev/null | grep -q ":3414 ";  then _running=true; fi
    if ss -tlnp "sport = :13414" 2>/dev/null | grep -q ":13414 "; then _running=true; fi
    detect_installed_nodes
    if [[ ${#INSTALLED_NETS[@]} -gt 0 ]]; then _installed=true; fi
    # Flag a FULL archive specifically. It is the expensive-to-rebuild asset
    # (~18-25 GB, hours-to-days to re-sync) and is unrecoverable once deleted.
    # Super Auto only ever builds PRUNED nodes, so an existing full archive is
    # not just wiped — it is silently downgraded to pruned. That asymmetry (a
    # cheap prune wipe vs. losing a costly archive) warrants a louder, distinct
    # confirmation token so it cannot be muscle-memoried through.
    local _has_full=false _full_dir="" _fi
    for _fi in "${!INSTALLED_MODES[@]}"; do
        if [[ "${INSTALLED_MODES[$_fi]}" == "full" ]]; then
            _has_full=true
            _full_dir="${INSTALLED_DIRS[$_fi]}"
        fi
    done

    echo ""
    echo -e "${BOLD}  Super Auto will:${RESET}"
    echo -e "    • Build ${BOLD}mainnet-prune${RESET} + ${BOLD}testnet-prune${RESET}  ${DIM}(on-the-fly streamed chain data)${RESET}"
    echo -e "    • Enable ${GREEN}@reboot autostart${RESET}, ${GREEN}sync watchdog${RESET}, ${GREEN}event recorder${RESET}, and ${GREEN}log rotation${RESET}"
    echo -e "    • Set up a ${GREEN}Tor .onion${RESET} mirror per node"

    if $_running || $_installed; then
        echo ""
        warn "  ⚠  DESTRUCTIVE — existing Grin data will be removed:"
        if $_installed; then
            local _i
            for _i in "${!INSTALLED_NETS[@]}"; do
                echo -e "       ${RED}✗${RESET} ${INSTALLED_NETS[$_i]} (${INSTALLED_MODES[$_i]}) — ${DIM}${INSTALLED_DIRS[$_i]}${RESET}"
                echo -e "           ${DIM}$(_describe_installed_node "${INSTALLED_DIRS[$_i]}")${RESET}"
            done
        fi
        if $_running; then echo -e "       ${RED}✗${RESET} all running Grin processes will be ${BOLD}killed${RESET}"; fi
        echo -e "       ${RED}✗${RESET} binaries + chain_data for BOTH networks will be ${BOLD}deleted${RESET}"

        # Escalate when a FULL archive is on the chopping block: it is the one
        # asset here that costs hours-to-days to rebuild and cannot be recovered
        # without a full re-sync. Loud, cost-explicit block + a distinct token.
        local _token="REBUILD"
        if $_has_full; then
            echo ""
            echo -e "  ${RED}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
            echo -e "  ${RED}${BOLD}⚠  FULL ARCHIVE NODE DETECTED — READ BEFORE YOU PROCEED${RESET}"
            echo -e "  ${RED}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
            echo -e "     ${DIM}${_full_dir}${RESET}"
            echo -e "     You have a ${BOLD}full archive${RESET} mainnet node ${DIM}(~18-25 GB, typically${RESET}"
            echo -e "     ${DIM}hours to days to sync)${RESET}. Super Auto builds ${BOLD}pruned only${RESET} — it will"
            echo -e "     ${RED}${BOLD}DELETE this archive${RESET} and replace it with a pruned node."
            echo -e "     ${YELLOW}This is unrecoverable without a full re-sync.${RESET}"
            echo ""
            echo -e "     ${DIM}To keep the archive, cancel now and either:${RESET}"
            echo -e "       ${DIM}• back it up first  (Script 089 — Backup / Restore)${RESET}"
            echo -e "       ${DIM}• stream it out     (Script 03 — Share Chain Data)${RESET}"
            echo -e "       ${DIM}• or use the custom wizard to rebuild only what you need${RESET}"
            _token="DELETE-ARCHIVE"
        fi

        echo ""
        echo -ne "  Type ${RED}${BOLD}${_token}${RESET} to proceed, or Enter to cancel: "
        local _cf; read -r _cf || true
        if [[ "$_cf" != "$_token" ]]; then
            if $_has_full; then
                info "Super Auto cancelled — full archive preserved, no changes made."
            else
                info "Super Auto cancelled — no changes made."
            fi
            return 1
        fi
    else
        echo ""
        echo -ne "  ${BOLD}Proceed? [Y/n]: ${RESET}"
        local _cf; read -r _cf || true
        if [[ "${_cf,,}" == "n" ]]; then info "Super Auto cancelled."; return 1; fi
    fi

    # ── 3. Kill + wipe everything (reuse existing K-path) ────────────────────────
    stop_grin_gracefully
    _remove_instance_dirs all
    if [[ -f "$INSTANCES_CONF" ]]; then : > "$INSTANCES_CONF"; log "Conf cleared (super-auto rebuild)."; fi

    # ── 4. Deps, then build both (pruned, streamed) with per-node hardening ──────
    check_os_and_deps
    check_legacy_grin_dir
    SUPER_AUTO=true
    # The 20 GB gate above IS the disk check; stream mode also skips the per-node
    # disk check, and create_node_dir must not re-die on space after a wipe.
    GRIN_SKIP_DISK_CHECK=1

    info "Super Auto: building MAINNET (pruned)..."
    setup_one_node "mainnet"
    echo ""
    info "Super Auto: building TESTNET (pruned)..."
    setup_one_node "testnet"

    echo ""
    success "Super Auto complete — both nodes built; autostart + watchdog + event recorder + log rotation enabled."
    log "[SUPER AUTO] Completed both networks."
    return 0
}
