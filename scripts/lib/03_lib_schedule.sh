# 03_lib_schedule.sh — cron schedules of Script 03 (menus E F G H I and the --cron-clean run): nginx share, txhashset clean, node autostart.
# Sourced by 03_grin_share_chain_data.sh; shares its globals and log/info/warn/error.
# Moved as-is; this script sets no errexit and file operations are not individually guarded.

################################################################################
# I) Auto-delete txhashset snapshot zips
################################################################################

# Default directories to scan (chain_data inside each toolkit node dir)
CLEAN_TXHASHSET_DIRS=(
    "/opt/grin/node/mainnet-prune/chain_data"
    "/opt/grin/node/mainnet-full/chain_data"
    "/opt/grin/node/testnet-prune/chain_data"
)

# Entry point for --cron-clean
run_txhashset_cleanup() {
    local ts; ts="[$(date -u '+%Y-%m-%d %H:%M:%S UTC')]"
    echo "$ts Starting txhashset snapshot cleanup..."
    local total=0
    for d in "${CLEAN_TXHASHSET_DIRS[@]}"; do
        if [[ ! -d "$d" ]]; then
            echo "$ts   Skip: $d (not found)"
            continue
        fi
        local count; count=$(find "$d" -maxdepth 1 -name "txhashset_snapshot_*.zip" 2>/dev/null | wc -l)
        if [[ "$count" -gt 0 ]]; then
            find "$d" -maxdepth 1 -name "txhashset_snapshot_*.zip" -delete
            echo "$ts   Removed $count zip file(s) from $d"
            total=$((total + count))
        else
            echo "$ts   No txhashset_snapshot_*.zip in $d"
        fi
        local zip_dirs; zip_dirs=$(find "$d" -maxdepth 1 -type d -name "txhashset_zip*" 2>/dev/null)
        if [[ -n "$zip_dirs" ]]; then
            find "$d" -maxdepth 1 -type d -name "txhashset_zip*" -exec rm -rf {} +
            echo "$ts   Removed txhashset_zip* director(ies) from $d"
        fi
    done
    echo "$ts Done. Total zip files removed: $total"
}

################################################################################
# Schedule management for the NGINX share cron (menu E/F). The remote-copy cron
# has its own tagged entries (CRON_COMMENT_REMOTE, one per site_key) written from
# the option-C setup in 03_lib_remote_menu.sh — it is not managed here.
################################################################################

show_current_schedule() {
    echo -e "${BOLD}Current Grin share schedule(s) in crontab:${RESET}"
    echo ""
    local found=0
    while IFS= read -r line; do
        echo "$line" | grep -q "grin-" && { echo -e "  ${GREEN}▶${RESET} $line"; found=1; }
    done < <(crontab -l 2>/dev/null || true)
    [ $found -eq 0 ] && echo -e "  ${DIM}No Grin share cron jobs found.${RESET}"
    echo ""
}

list_presets() {
    local default_expr="$1" default_label="$2" ntype="${3:-pruned}"
    local now_h now_m
    now_h=$(date +%-H)
    now_m=$(date +%-M)
    _R_MIN=$(( (RANDOM + now_m) % 60 ))
    _R_HOUR=$(( (RANDOM + now_h) % 24 ))

    # Partial Fisher-Yates: shuffle 4 unique days out of 0-6
    local -a _dow=(0 1 2 3 4 5 6)
    local _i _j _t
    for _i in 0 1 2 3; do
        _j=$(( _i + RANDOM % (7 - _i) ))
        _t="${_dow[$_i]}"; _dow[$_i]="${_dow[$_j]}"; _dow[$_j]="$_t"
    done

    # Sort first 3 days (opt2: 3x/week)
    local a=${_dow[0]} b=${_dow[1]} c=${_dow[2]} t
    [ "$a" -gt "$b" ] && t=$a && a=$b && b=$t
    [ "$b" -gt "$c" ] && t=$b && b=$c && c=$t
    [ "$a" -gt "$b" ] && t=$a && a=$b && b=$t

    # Sort first 2 days (opt4: 2x/week)
    local p=${_dow[0]} q=${_dow[1]}
    [ "$p" -gt "$q" ] && t=$p && p=$q && q=$t

    local -a _DN=("Sun" "Mon" "Tue" "Wed" "Thu" "Fri" "Sat")
    local _HM; printf -v _HM '%02d:%02d' "$_R_HOUR" "$_R_MIN"

    echo -e "${BOLD}Schedule presets (UTC):${RESET}"
    echo ""
    echo -e "  ${GREEN}1${RESET}) ${default_label}  ${DIM}(${default_expr})${RESET}  [Default — fixed]"

    if [ "$ntype" = "full" ]; then
        # A full archive is ~20 GB and costs a 20-40 min stop-the-node compress,
        # for an audience of a few archive-node operators who tolerate a stale
        # snapshot (an archive node syncs forward from whatever head it has).
        # So every preset here is biweekly or rarer. 2x/week stays reachable as
        # an escape hatch, marked heavy — it is not offered as a middle option.
        #
        # Biweekly is expressed as day-of-month 1,15 rather than a step: cron's
        # `*/14` restarts the count each month (1,15,29 then 1 again — a 3-day
        # gap at the boundary), which is not fortnightly at all.
        #
        # Max normal gap: 17 days (15th -> 1st across a 31-day month); 31 with one
        # missed run. The monthly preset is the binding case at 62 days missed
        # (Jul 1 -> Sep 1), which is why Script 01's _max_age_for_site_key allows
        # 70 for fullmain — sized to the RAREST option offered here, so nothing
        # an operator can pick silently ages a mirror out of client tolerance.
        # Adding a rarer preset below means re-checking that constant first.
        _PRESET2="$_R_MIN $_R_HOUR 1,15 * *"
        _PRESET3="$_R_MIN $_R_HOUR 1 * *"
        _PRESET4="$_R_MIN $_R_HOUR * * $p,$q"
        echo -e "  ${GREEN}2${RESET}) Biweekly — 1st & 15th at ${_HM}  ${DIM}(${_PRESET2})${RESET}  ${DIM}[random time]${RESET}"
        echo -e "  ${GREEN}3${RESET}) Monthly — 1st at ${_HM}  ${DIM}(${_PRESET3})${RESET}  ${DIM}[random time]${RESET}"
        echo -e "  ${YELLOW}4${RESET}) 2x/week — ${_DN[$p]}, ${_DN[$q]} at ${_HM}  ${DIM}(${_PRESET4})${RESET}  ${YELLOW}[heavy]${RESET}"
    else
        # Pruned snapshots stay frequent. Beyond the cut-through horizon (~1 week)
        # a pruned node falls back to txhashset state sync and discards the
        # snapshot it just downloaded, so staleness here wastes the whole
        # transfer rather than merely aging it. Script 01 holds these to 5 days.
        _PRESET2="$_R_MIN $_R_HOUR * * $a,$b,$c"
        _PRESET3="$_R_MIN $_R_HOUR * * *"
        _PRESET4="$_R_MIN $_R_HOUR * * $p,$q"
        echo -e "  ${GREEN}2${RESET}) 3x/week — ${_DN[$a]}, ${_DN[$b]}, ${_DN[$c]} at ${_HM}  ${DIM}(${_PRESET2})${RESET}  ${DIM}[random]${RESET}"
        echo -e "  ${GREEN}3${RESET}) Daily at ${_HM}  ${DIM}(${_PRESET3})${RESET}  ${DIM}[random]${RESET}"
        echo -e "  ${GREEN}4${RESET}) 2x/week — ${_DN[$p]}, ${_DN[$q]} at ${_HM}  ${DIM}(${_PRESET4})${RESET}  ${DIM}[random]${RESET}"
    fi
    echo ""
}

# _node_type_for_network <network>  ->  full | pruned
#   Reads DETECTED_NODE_TYPES from the saved nginx config ("mainnet:pruned
#   testnet:pruned"). The share pipeline is keyed by PORT, so a given box's
#   mainnet port hosts either a full node or a pruned one, never both — which is
#   what makes a per-artefact cadence possible from a per-network schedule loop.
#   Defaults to pruned: the frequent, tighter schedule is the safe guess when the
#   config predates this field.
_node_type_for_network() {
    local net="$1" combo
    for combo in $DETECTED_NODE_TYPES; do
        [ "${combo%%:*}" = "$net" ] && { echo "${combo##*:}"; return 0; }
    done
    echo "pruned"
}

# get_cron_expression <network> [node_type]
#   Sets CRON_EXPR. Presets 2-4 are re-randomised on every call, so scheduling
#   each network in turn naturally staggers their times. Preset 1 (fixed default)
#   is network-specific so mainnet/testnet don't collide even on the default.
#
#   The preset SET also depends on node type: a full archive costs ~20 GB and
#   a long stop-the-node compress, so it is offered biweekly-or-rarer while
#   pruned keeps its frequent schedule. See list_presets for the full reasoning.
get_cron_expression() {
    local net="${1:-mainnet}" ntype="${2:-pruned}" default_expr default_label
    if [ "$ntype" = "full" ]; then
        # Biweekly, inside Script 01's 70-day fullmain freshness tolerance.
        default_expr="0 0 1,15 * *"; default_label="1st & 15th at 00:00"
    elif [ "$net" = "testnet" ]; then
        default_expr="0 6 * * 2,5"; default_label="Tue & Fri at 06:00"
    else
        default_expr="0 0 * * 1,4"; default_label="Mon & Thu at 00:00"
    fi
    list_presets "$default_expr" "$default_label" "$ntype"
    echo -e "  ${DIM}0) Cancel / skip this network${RESET}"
    echo -ne "${BOLD}Select [0-4, default=1]: ${RESET}"
    read -r preset
    [[ "$preset" == "0" ]] && return 1
    case "${preset:-1}" in
        2) CRON_EXPR="$_PRESET2" ;;
        3) CRON_EXPR="$_PRESET3" ;;
        4) CRON_EXPR="$_PRESET4" ;;
        *) CRON_EXPR="$default_expr" ;;
    esac
}

# Add or replace the nginx cron entries — ONE schedule per configured network so
# mainnet and testnet compression never run at the same time.
add_nginx_schedule() {
    echo -e "\n${BOLD}${CYAN}── Schedule Nginx Jobs ──${RESET}\n"
    ensure_crontab || { sched_error "crontab unavailable — install cronie/cron and retry."; return; }
    if [[ ! -f "$CONF_NGINX" ]]; then
        show_error_pause "Nginx config not found." "Run option A (Create Nginx config) first."
        return
    fi
    load_nginx_config
    local this_script; this_script="$(realpath "${BASH_SOURCE[0]}")"

    # Which networks does the saved config share?
    local -a nets=()
    case "$SYNC_CHOICE" in
        mainnet) nets=(mainnet) ;;
        testnet) nets=(testnet) ;;
        *)       nets=(mainnet testnet) ;;
    esac

    echo -e "${DIM}Each network gets its OWN schedule + cron line so mainnet and testnet${RESET}"
    echo -e "${DIM}never stop-and-compress at the same time. Presets 2-4 pick a random${RESET}"
    echo -e "${DIM}time per network (set once now) to spread disk/CPU load.${RESET}"
    echo ""

    local log_path="$LOG_DIR/cron_nginx.log"
    echo -ne "Cron log path [${log_path}] or 0 to cancel: "
    read -r tmp; [[ "$tmp" == "0" ]] && return
    log_path="${tmp:-$log_path}"

    local existing; existing=$(crontab -l 2>/dev/null || true)

    # Drop any legacy combined (both-network) line — superseded by per-network lines.
    # The legacy marker ends in 'grin_share_nginx'; the per-network ones end in
    # '..._main' / '..._test', so anchor to end-of-line to match only the legacy one.
    if echo "$existing" | grep -qE 'grin_share_nginx[[:space:]]*$'; then
        sched_info "Replacing legacy combined nginx schedule with per-network schedules."
        existing=$(echo "$existing" | grep -vE 'grin_share_nginx[[:space:]]*$' || true)
    fi

    local net flag marker label cron_line any_set=false
    for net in "${nets[@]}"; do
        if [ "$net" = "testnet" ]; then
            flag="--cron-nginx-test"; marker="$CRON_COMMENT_NGINX_TEST"; label="TESTNET"
        else
            flag="--cron-nginx-main"; marker="$CRON_COMMENT_NGINX_MAIN"; label="MAINNET"
        fi

        local ntype; ntype=$(_node_type_for_network "$net")
        echo -e "${BOLD}${CYAN}── Schedule for ${label}${ntype:+ (${ntype})} ──${RESET}"
        if ! get_cron_expression "$net" "$ntype"; then
            sched_info "${label}: skipped — existing schedule (if any) left unchanged."
            echo ""
            continue
        fi

        # Replace this network's existing line (exact marker), then append the new one.
        existing=$(echo "$existing" | grep -vF "$marker" || true)
        cron_line="$CRON_EXPR bash $this_script $flag >> $log_path 2>&1 $marker"
        existing="$(printf '%s\n%s' "$existing" "$cron_line")"
        sched_success "${label} schedule set: ${CYAN}$CRON_EXPR${RESET}"
        sched_log "Added nginx cron ($net): $cron_line"
        any_set=true
        echo ""
    done

    if [ "$any_set" != true ]; then
        sched_info "No schedules changed."
        echo ""; echo "Press Enter to continue..."; read -r; return
    fi

    echo "$existing" | grep -v '^$' | crontab -

    # Remote copy advisory
    echo ""
    echo -e "${DIM}────────────────────────────────────────────────────────────────────${RESET}"
    echo -e "${DIM}Mirroring this archive to other servers? Schedule the copy from option C,${RESET}"
    echo -e "${DIM}not by hand. It derives the time from the schedule you just set, tags the${RESET}"
    echo -e "${DIM}cron entry so it can be changed or removed later, and skips any mirror${RESET}"
    echo -e "${DIM}that already holds the build. A --cron-ssh line added by hand still runs,${RESET}"
    echo -e "${DIM}but produces an untagged job that option C cannot manage.${RESET}"
    echo -e "${DIM}────────────────────────────────────────────────────────────────────${RESET}"
    echo ""
    echo "Press Enter to continue..."
    read -r
}

# Remove nginx share cron entries managed by this script (all, or one network)
remove_nginx_schedule() {
    echo -e "\n${BOLD}${CYAN}── Disable Nginx Jobs ──${RESET}\n"
    show_current_schedule
    echo -e "  ${GREEN}1${RESET}) Remove ${BOLD}all${RESET} chain_data sharing jobs  ${DIM}[default]${RESET}"
    echo -e "  ${GREEN}2${RESET}) Remove ${BOLD}mainnet${RESET} schedule only"
    echo -e "  ${GREEN}3${RESET}) Remove ${BOLD}testnet${RESET} schedule only"
    echo -e "  ${DIM}0${RESET}) Cancel"
    echo -ne "${YELLOW}Select [0-3, default=1]: ${RESET}"
    read -r confirm
    [[ "$confirm" == "0" ]] && return

    local tmp_cron
    case "${confirm:-1}" in
        2)
            # Match the mainnet marker only (per-network lines end in _main)
            tmp_cron=$(crontab -l 2>/dev/null | grep -vF "$CRON_COMMENT_NGINX_MAIN" || true)
            echo "$tmp_cron" | grep -v '^$' | crontab -
            sched_success "Mainnet sharing cron removed."
            sched_log "Removed mainnet nginx cron"
            ;;
        3)
            tmp_cron=$(crontab -l 2>/dev/null | grep -vF "$CRON_COMMENT_NGINX_TEST" || true)
            echo "$tmp_cron" | grep -v '^$' | crontab -
            sched_success "Testnet sharing cron removed."
            sched_log "Removed testnet nginx cron"
            ;;
        *)
            # 'grin_share_nginx' is a substring of every variant (legacy/_main/_test)
            tmp_cron=$(crontab -l 2>/dev/null | grep -v "grin_share_nginx" || true)
            echo "$tmp_cron" | grep -v '^$' | crontab -
            sched_success "All nginx sharing cron jobs removed."
            sched_log "Removed all nginx cron jobs"
            ;;
    esac
    echo ""
    echo "Press Enter to continue..."
    read -r
}

################################################################################
# I) Schedule auto-delete of txhashset snapshot zips
################################################################################

add_clean_schedule() {
    echo -e "\n${BOLD}${CYAN}── Auto-Delete txhashset Snapshots ──${RESET}\n"
    ensure_crontab || { sched_error "crontab unavailable — install cronie/cron and retry."; return; }
    echo -e "  Deletes ${BOLD}txhashset_snapshot_*.zip${RESET} files from chain_data directories:"
    for d in "${CLEAN_TXHASHSET_DIRS[@]}"; do
        echo -e "    ${DIM}$d${RESET}"
    done
    echo ""
    echo -e "  ${BOLD}Schedule:${RESET}"
    echo -e "  ${GREEN}1${RESET}) Every  4 hours  ${DIM}(0 */4  * * *)${RESET}  [Default]"
    echo -e "  ${GREEN}2${RESET}) Every 12 hours  ${DIM}(0 */12 * * *)${RESET}"
    echo -e "  ${GREEN}3${RESET}) Every 24 hours  ${DIM}(0 0    * * *)${RESET}"
    echo -e "  ${DIM}0${RESET}) Cancel"
    echo ""
    echo -ne "${BOLD}Select [0-3, default=1]: ${RESET}"
    local sel; read -r sel
    [[ "$sel" == "0" ]] && return

    local clean_expr
    case "${sel:-1}" in
        2) clean_expr="0 */12 * * *" ;;
        3) clean_expr="0 0    * * *" ;;
        *) clean_expr="0 */4  * * *" ;;
    esac

    local this_script; this_script="$(realpath "${BASH_SOURCE[0]}")"
    local clean_log="$LOG_DIR/cron_clean_txhashset.log"
    local cron_line="$clean_expr bash $this_script --cron-clean >> $clean_log 2>&1 $CRON_COMMENT_CLEAN"
    local existing; existing=$(crontab -l 2>/dev/null || true)

    if echo "$existing" | grep -qF "grin_clean_txhashset"; then
        sched_warn "A cleanup cron job already exists."
        echo -ne "Replace it? [Y/n/0]: "
        local rep; read -r rep
        [[ "$rep" == "0" ]] && return
        if [[ "${rep,,}" == "n" ]]; then
            sched_info "Keeping existing schedule."; echo ""; echo "Press Enter to continue..."; read -r; return
        else
            existing=$(echo "$existing" | grep -v "grin_clean_txhashset" || true)
        fi
    fi

    (echo "$existing"; echo "$cron_line") | grep -v '^$' | crontab -
    sched_success "Cleanup schedule set: ${CYAN}$clean_expr${RESET}"
    sched_log "Added txhashset cleanup cron: $cron_line"
    echo ""
    echo "Press Enter to continue..."
    read -r
}

################################################################################
# G) Auto startup Grin node — add @reboot crontab entries
################################################################################

add_grin_autostart() {
    echo -e "\n${BOLD}${CYAN}── Auto Startup Grin Node ──${RESET}\n"
    ensure_crontab || { sched_error "crontab unavailable — install cronie/cron and retry."; return; }

    # Install the gtmux viewer helper so the operator can see the grin-owned
    # session(s) this option schedules (a plain root `tmux ls` cannot). Shared
    # primitive from lib/grin_node_control.sh — same install used by Script 01
    # and the keepalive autostart, so the helper exists regardless of path.
    gnc_install_gtmux_helper

    echo -e "  Which network to autostart?"
    echo -e "  ${GREEN}1${RESET}) Mainnet"
    echo -e "  ${GREEN}2${RESET}) Testnet"
    echo -e "  ${GREEN}3${RESET}) Both"
    echo -e "  ${DIM}0${RESET}) Cancel"
    echo ""
    local net_choice networks=()
    while true; do
        echo -ne "${BOLD}Select [1/2/3/0]: ${RESET}"
        read -r net_choice
        [[ "$net_choice" == "0" ]] && return
        [[ -z "$net_choice" ]] && continue
        case "$net_choice" in
            1) networks=("mainnet");              break ;;
            2) networks=("testnet");              break ;;
            3) networks=("mainnet" "testnet");    break ;;
            *) sched_warn "Invalid selection."; sleep 1 ;;
        esac
    done

    local existing_cron
    existing_cron=$(crontab -l 2>/dev/null || true)
    local new_lines=""

    for net in "${networks[@]}"; do
        local port="" label="" default_delay="" cron_marker=""
        if [[ "$net" == "mainnet" ]]; then
            port=$GRIN_PORT_MAINNET
            label="Mainnet"
            # grin v5.5 chain_data is heavier on CPU/IO during sync — bring mainnet
            # up fast, and hold testnet well clear of the mainnet sync surge.
            default_delay=5
            cron_marker="$CRON_COMMENT_AUTOSTART_MAIN"
        else
            port=$GRIN_PORT_TESTNET
            label="Testnet"
            # ~17 min after boot — well clear of the whole mainnet startup
            # surge (grin v5.5 is heavy; a slow VPS can't boot two nodes at
            # once). Same default as gnk_autostart_enable (Script 01 Super Auto).
            default_delay=1000
            cron_marker="$CRON_COMMENT_AUTOSTART_TEST"
        fi

        echo ""
        echo -e "  ${BOLD}── $label ──${RESET}"

        # Use the same detection pipeline as restart_grin_node
        reset_detection_vars
        if detect_active_port "$port" >/dev/null 2>&1; then
            # Binary: same technique as detect_grin_binary but graceful (no error_exit)
            local pid=""
            pid=$(get_pid_on_port "$GRIN_PORT" | head -1) || true
            GRIN_BINARY=$(readlink -f "/proc/$pid/exe" 2>/dev/null) || true
            if [[ -n "$GRIN_BINARY" && -f "$GRIN_BINARY" ]]; then
                GRIN_DIR=$(dirname "$GRIN_BINARY")
                detect_config_file  >/dev/null 2>&1
                detect_network_type >/dev/null 2>&1
                detect_node_type    >/dev/null 2>&1
                # Underscore convention (grin_pruned_mainnet) — matches the shared
                # lib (_grin_session_name) and grin_node_keepalive's autostart so
                # 03 and 07 write the SAME tagged @reboot entry, not two rivals.
                TMUX_SESSION="$(_grin_session_name "$GRIN_DIR")"
                sched_info "Detected binary : $GRIN_BINARY"
                sched_info "tmux session    : $TMUX_SESSION"
            else
                GRIN_BINARY=""
            fi
        fi

        # Not running — resolve an INSTALLED node without needing a live process,
        # so autostart can be scheduled for a stopped node. Prefer the instances
        # conf (respects mainnet full-over-prune), then fall back to a filesystem
        # check of the standard toolkit dirs under /opt/grin/node/<net>.
        if [[ -z "$GRIN_BINARY" ]]; then
            local _dir=""
            _dir=$(gnc_resolve_node_dir "$net" 2>/dev/null) || true
            if [[ -z "$_dir" || ! -x "$_dir/grin" ]]; then
                local _cands=() _c=""
                if [[ "$net" == "mainnet" ]]; then
                    _cands=(/opt/grin/node/mainnet-full /opt/grin/node/mainnet-prune)
                else
                    _cands=(/opt/grin/node/testnet-prune)
                fi
                _dir=""
                for _c in "${_cands[@]}"; do
                    [[ -x "$_c/grin" ]] && { _dir="$_c"; break; }
                done
            fi
            if [[ -n "$_dir" && -x "$_dir/grin" ]]; then
                GRIN_DIR="$_dir"
                GRIN_BINARY="$_dir/grin"
                TMUX_SESSION="$(_grin_session_name "$GRIN_DIR")"
                sched_info "$label not running — using installed binary at $GRIN_BINARY"
                sched_info "tmux session    : $TMUX_SESSION"
            fi
        fi

        if [[ -z "$GRIN_BINARY" ]]; then
            sched_warn "No $label grin process running, and no installed binary under /opt/grin/node."
            echo -ne "  Enter binary path manually (or 0 to skip): "
            local manual_bin=""
            read -r manual_bin
            [[ "$manual_bin" == "0" || -z "$manual_bin" ]] && sched_info "Skipping $label." && continue
            GRIN_BINARY="$manual_bin"
            GRIN_DIR=$(dirname "$GRIN_BINARY")
            TMUX_SESSION="$(_grin_session_name "$GRIN_DIR")"
        fi

        echo -ne "  Boot delay in seconds [$default_delay]: "
        local delay_input="" delay=""
        read -r delay_input
        delay="${delay_input:-$default_delay}"
        if ! [[ "$delay" =~ ^[0-9]+$ ]]; then
            sched_warn "Invalid delay — using default ($default_delay s)."
            delay=$default_delay
        fi

        # Grin Node Launch Contract (CLAUDE.md): run as the grin user with
        # HOME=$GRIN_DIR, after chown -R grin:grin. A root-run node leaves
        # root:root files in the node dir → next grin-user start hits EACCES.
        # Mirrors gnk_autostart_enable in lib/grin_node_keepalive.sh, including
        # the launcher's pane command (_gnc_node_run_cmd, cron-escaped): exit-code
        # capture + a `read` tail, so a crash after a reboot keeps its panic text.
        local run_cmd
        run_cmd=$(_gnc_node_run_cmd "$GRIN_DIR" "$GRIN_BINARY" cron)
        local cron_line="@reboot sleep $delay && chown -R grin:grin '$GRIN_DIR' 2>/dev/null; su -s /bin/bash grin -c \"cd '$GRIN_DIR' && env HOME='$GRIN_DIR' SHELL=/bin/bash tmux new-session -d -s $TMUX_SESSION '$run_cmd'\" $cron_marker"

        # Check for existing entry
        if echo "$existing_cron" | grep -qF "$cron_marker"; then
            sched_warn "An autostart entry for $label already exists."
            echo -ne "  Replace it? [Y/n/0]: "
            local rep=""
            read -r rep
            [[ "$rep" == "0" ]] && return
            if [[ "${rep,,}" != "n" ]]; then
                existing_cron=$(echo "$existing_cron" | grep -vF "$cron_marker" || true)
                new_lines+=$'\n'"$cron_line"
                sched_success "$label autostart replaced."
            else
                sched_info "Keeping existing $label entry."
            fi
        else
            new_lines+=$'\n'"$cron_line"
            sched_success "$label autostart added."
        fi

        sched_info "  Delay  : ${delay}s after boot"
        # The node runs as the 'grin' user, so its tmux server is on grin's
        # socket — a plain `tmux attach` from a root shell will NOT find it.
        # Use the gtmux helper (installed above) instead.
        sched_info "  Attach : gtmux attach -t $TMUX_SESSION   ${DIM}(plain 'tmux attach' won't find it — grin-owned)${RESET}"
    done

    if [[ -n "$new_lines" ]]; then
        (echo "$existing_cron"; echo "$new_lines") | grep -v '^$' | crontab -
        echo ""
        sched_success "Crontab updated. Run 'crontab -l' to verify."
    fi
    echo ""
    sched_info "Viewer installed: ${BOLD}gtmux${RESET}  — the node runs as the 'grin' user, so use:"
    sched_info "    ${DIM}gtmux ls${RESET}                       list grin node session(s)"
    sched_info "    ${DIM}gtmux attach -t <session>${RESET}      attach  (Ctrl+B then D to detach)"
    echo ""
    echo "Press Enter to continue..."
    read -r
}

################################################################################
# H) Disable auto startup Grin node — remove @reboot entries
################################################################################

remove_grin_autostart() {
    echo -e "\n${BOLD}${CYAN}── Disable Auto Startup Grin Node ──${RESET}\n"

    local existing_cron
    existing_cron=$(crontab -l 2>/dev/null || true)

    local has_main has_test
    has_main=$(echo "$existing_cron" | grep -cF "$CRON_COMMENT_AUTOSTART_MAIN" || true)
    has_test=$(echo "$existing_cron" | grep -cF "$CRON_COMMENT_AUTOSTART_TEST" || true)

    if [[ "$has_main" -eq 0 && "$has_test" -eq 0 ]]; then
        sched_info "No Grin autostart entries found in crontab."
        echo ""
        echo "Press Enter to continue..."
        read -r
        return
    fi

    echo -e "  ${BOLD}Current autostart entries:${RESET}"
    [[ "$has_main" -gt 0 ]] && echo -e "    ${GREEN}●${RESET} Mainnet autostart present"
    [[ "$has_test" -gt 0 ]] && echo -e "    ${GREEN}●${RESET} Testnet autostart present"
    echo ""
    echo -e "  Remove which?"
    [[ "$has_main" -gt 0 ]] && echo -e "  ${GREEN}1${RESET}) Mainnet"
    [[ "$has_test" -gt 0 ]] && echo -e "  ${GREEN}2${RESET}) Testnet"
    [[ "$has_main" -gt 0 && "$has_test" -gt 0 ]] && echo -e "  ${GREEN}3${RESET}) Both"
    echo -e "  ${DIM}0${RESET}) Cancel"
    echo ""
    local choice tmp_cron="$existing_cron"
    while true; do
        echo -ne "${BOLD}Select: ${RESET}"
        read -r choice
        [[ "$choice" == "0" ]] && return
        [[ -z "$choice" ]] && continue
        case "$choice" in
            1) tmp_cron=$(echo "$tmp_cron" | grep -vF "$CRON_COMMENT_AUTOSTART_MAIN" || true)
               sched_success "Mainnet autostart removed."; break ;;
            2) tmp_cron=$(echo "$tmp_cron" | grep -vF "$CRON_COMMENT_AUTOSTART_TEST" || true)
               sched_success "Testnet autostart removed."; break ;;
            3) tmp_cron=$(echo "$tmp_cron" | grep -vF "$CRON_COMMENT_AUTOSTART_MAIN" | grep -vF "$CRON_COMMENT_AUTOSTART_TEST" || true)
               sched_success "Mainnet and Testnet autostart removed."; break ;;
            *) sched_warn "Invalid selection."; sleep 1 ;;
        esac
    done

    echo "$tmp_cron" | crontab -
    sched_log "Removed grin autostart cron entries (choice: $choice)"
    echo ""
    echo "Press Enter to continue..."
    read -r
}
