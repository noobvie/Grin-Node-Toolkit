# =============================================================================
# 081_lib_host_updates.sh — automatic OS security updates across the fleet
# =============================================================================
# Sourced by 081_host_monitor_port.sh (Mass Deployment key 5). No shebang, no
# `set -e`: the menu dispatches `_mdh_menu || true`, which disables errexit for
# the whole call tree, so every remote step and temp file carries its own guard.
#
# The work itself is lib/08_lib_host_updates.sh: its snippets (hu_script) and
# its detached-run launcher and poll scripts (hu_launch_script,
# hu_poll_script), generated HERE on the controller and sent through
# `ssh … bash -s` — the remote box needs no toolkit files. Contract
# (script083_implementation.md, "Snippet interface"): plain text, last line
# `__OK__` on success, `ERROR:` + non-zero on failure. A host counts as OK only
# with ssh exit 0 AND `__OK__` as the last line, so a run cut off halfway can
# never read as success.
#
#   1 status   read-only, one table row per server + its notes
#   2 enable   NodeSource asked once for the batch (apt only), fails closed
#   3 disable  prints each server's real resulting auto_updates= line
#   4 run-now  DETACHED on each server, then watched by polling
#   5 last run result + log tail of the newest detached run, read-only
#
# Run-now is never streamed over SSH: a dropped connection would close the pipe
# under dpkg. The launcher (08_lib, "Detached patch runs") starts it under
# systemd-run or setsid, logging on the server; this file only polls, so Ctrl-C
# stops the WATCH, never the run.
#
# Every ssh call runs under `timeout` (MDH_T_* below) and a timeout is reported
# as TIMEOUT: the remote side may still finish (enable/disable ignore HUP), so
# the operator re-reads Status rather than assuming either outcome.
#
# HU_TEST / HU_ROOT point the snippets at a scratch tree. hu_script emits them
# blank unless HU_TEST=1 is set locally, and every action here refuses to run
# while either is set in this shell, so a test value can never reach a server.
#
# Remote commands: the ssh command line is a fixed string (`bash -s`, or
# `sudo -n bash -s` for a non-root ssh user) after `--` and a validated
# user@host; every value travels inside the script on stdin, as printf %q
# assignments. Remote text is passed through _hu_clean and printed only as a
# printf %s argument.
#
# Borrowed from 081 at call time: _md_select_servers (+ _md_labels/_md_hosts/
# _md_ports/_md_users/_md_keys/_md_selected_idx), $MD_SSH_OPTS, log/info/warn/
# error/success and the colour variables. From 08_lib_host_updates.sh:
# hu_script, hu_launch_script, hu_poll_script, _hu_clean, _hu_val, HU_LOG_DIR
# and _hu_restart_note.
# =============================================================================

# shellcheck disable=SC2154  # 081's _md_* server arrays, borrowed at call time
[[ -n "${_GRIN_081_HOST_UPDATES_LOADED:-}" ]] && return 0
_GRIN_081_HOST_UPDATES_LOADED=1

# Watch limits for run-now (seconds). Override in the environment.
MDH_WATCH_MAX="${MDH_WATCH_MAX:-1800}"
MDH_WATCH_EVERY="${MDH_WATCH_EVERY:-10}"
# Per-host caps on one ssh call (seconds). Enable's slowest step is a package
# download, itself capped at 900 s inside the snippet.
MDH_T_STATUS=300
MDH_T_APPLY=1200
MDH_T_LAUNCH=120
MDH_T_POLL=60

# Current host (set by _mdh_load_host) and the last call's result (_mdh_call).
_MDH_L=""; _MDH_H=""; _MDH_P=""; _MDH_U=""; _MDH_K=""
_MDH_OUT=""; _MDH_RC=0

# ─── Local helpers ────────────────────────────────────────────────────────────

_mdh_pause() { echo ""; echo "Press Enter to continue..."; read -r || true; }

_mdh_confirm() {   # <question> — rc 0 only on an explicit y
    local a
    echo -ne "  ${BOLD}$1 [y/N]: ${RESET}"
    read -r a || return 1
    [[ "${a,,}" == y || "${a,,}" == yes ]]
}

# _mdh_lines <prefix> <colour> — print stdin line by line as data.
_mdh_lines() { local l; while IFS= read -r l; do printf '%s%b%s%b\n' "$1" "$2" "$l" "$RESET"; done; }

_mdh_load_host() {
    local i="$1"
    _MDH_L="${_md_labels[$i]}"; _MDH_H="${_md_hosts[$i]}"; _MDH_P="${_md_ports[$i]}"
    _MDH_U="${_md_users[$i]}"; _MDH_K="${_md_keys[$i]}"
}

# _mdh_rexec <timeout s> <stderr: a file path, or "merge"> — run the script on
# stdin as root on the current host. Returns ssh's exit code (255 = ssh itself
# failed), 124 on timeout, 2 for an entry that is unsafe to pass to ssh.
_mdh_rexec() {
    local t="$1" errf="${2:-/dev/null}" rcmd="bash -s" re='^[A-Za-z0-9._@:%-]+$'
    local -a o=()
    if [[ ! "$_MDH_U" =~ $re || "$_MDH_U" == -* || ! "$_MDH_H" =~ $re || "$_MDH_H" == -* || ! "$_MDH_P" =~ ^[0-9]+$ ]]; then
        echo "ERROR: refusing an unsafe ssh user, host or port in mass_deploy.conf (letters, digits and ._@:%- only, no leading -)"
        return 2
    fi
    read -ra o <<< "$MD_SSH_OPTS"
    o+=(-o ServerAliveInterval=15 -o ServerAliveCountMax=4)
    if [[ -n "$_MDH_K" && -f "$_MDH_K" ]]; then o+=(-i "$_MDH_K"); fi
    if [[ "$_MDH_U" != root ]]; then rcmd="sudo -n bash -s"; fi
    if [[ "$errf" == merge ]]; then
        timeout "$t" ssh "${o[@]}" -p "$_MDH_P" -- "$_MDH_U@$_MDH_H" "$rcmd" 2>&1
    else
        timeout "$t" ssh "${o[@]}" -p "$_MDH_P" -- "$_MDH_U@$_MDH_H" "$rcmd" 2>"$errf"
    fi
}

# _mdh_call <timeout s> <stderr file|merge> <script> — run it, leave the cleaned
# output in _MDH_OUT and the exit code in _MDH_RC.
_mdh_call() {
    _MDH_RC=0
    _MDH_OUT=$(_mdh_rexec "$1" "$2" <<< "$3") || _MDH_RC=$?
    _MDH_OUT=$(_hu_clean <<< "$_MDH_OUT")
}

# _mdh_env_ok — refuse while test variables are set in this shell, and when the
# shared lib is missing.
_mdh_env_ok() {
    if [[ -n "${HU_TEST:-}" || -n "${HU_ROOT:-}" ]]; then
        error "HU_TEST/HU_ROOT are set in this shell (test values) — refusing to touch remote servers."
        echo "  Run: unset HU_TEST HU_ROOT HU_FAMILY HU_DNF_VERSION, then try again."
        return 1
    fi
    if ! declare -F hu_script >/dev/null || ! declare -F hu_launch_script >/dev/null; then
        error "lib/08_lib_host_updates.sh is missing or old on this server — update it: Admin centre (08) → 8) Self-Update."
        return 1
    fi
    return 0
}

# _mdh_build <action> [nodesource=yes|no] — the snippet, with the blank test
# header checked once more before it can leave this box. Called as $(…), so
# its message goes to stderr.
_mdh_build() {
    local s
    s=$(hu_script "$@") || return 2
    if ! grep -qx "HU_TEST=''" <<< "$s" || ! grep -qx "HU_ROOT=''" <<< "$s" || grep -q '^HU_TEST=1$' <<< "$s"; then
        error "generated script carries test settings — refusing to send it." >&2
        return 1
    fi
    printf '%s\n' "$s"
}

_mdh_kv()   { printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -1; }
_mdh_last() { printf '%s\n' "$1" | grep -v '^[[:space:]]*$' | tail -1; }

# Output to the 081 session log, indented under a header line.
_mdh_log_out() {   # <header> <output>
    log "[HOST UPDATES] $1"
    printf '%s\n' "$2" | sed 's/^/        /' >> "${LOG_FILE:-/dev/null}" 2>/dev/null || true
}

# _mdh_first_err <stdout> <stderr> — the most telling line of a failure.
_mdh_first_err() {
    local l
    l=$(printf '%s\n' "$1" | grep -m1 '^ERROR:' || true)
    [[ -z "$l" ]] && l=$(printf '%s\n' "$2" | grep -v '^[[:space:]]*$' | head -1 || true)
    [[ -z "$l" ]] && l=$(printf '%s\n' "$1" | grep -v '^[[:space:]]*$' | tail -1 || true)
    echo "${l:-no output}"
}

# _mdh_rc_word <rc> <out> — OK | TIMEOUT | UNREACHABLE | FAILED for one call.
_mdh_rc_word() {
    if [[ "$1" -eq 0 && "$(_mdh_last "$2")" == __OK__ ]]; then echo OK
    elif [[ "$1" -eq 124 ]]; then echo TIMEOUT
    elif [[ "$1" -eq 255 ]]; then echo UNREACHABLE
    else echo FAILED; fi
}

# ─── Status table ─────────────────────────────────────────────────────────────

# Per-server results of the last status read, parallel to _md_selected_idx:
# res = ok | unreachable | timeout | failed, out = stdout, err = stderr / reason.
declare -a _MDH_S_LABEL=() _MDH_S_RES=() _MDH_S_OUT=() _MDH_S_ERR=()

# _mdh_cell <width> <value> <good-values regex> — padded, coloured cell.
_mdh_cell() {
    local w="$1" v="$2" c="$YELLOW" cell
    [[ "$v" =~ ^($3)$ ]] && c="$GREEN"
    [[ "$v" == "?" ]] && c="$DIM"
    printf -v cell "%-${w}.${w}s" "$v"
    printf '%b%s%b  ' "$c" "$cell" "$RESET"
}

_mdh_q() { if [[ -z "$1" || "$1" == unknown ]]; then echo "?"; else echo "$1"; fi; }

# _mdh_status_table — render _MDH_S_* as one row per server, then the notes.
_mdh_status_table() {
    local i out v svc n word
    echo ""
    printf "  ${BOLD}%-16s  %-6s  %-4s  %-14s  %-7s  %-6s  %-7s  %-4s${RESET}\n" \
        "Server" "Family" "Auto" "Security-only" "Pending" "Reboot" "Restart" "Lock"
    printf "  %-16s  %-6s  %-4s  %-14s  %-7s  %-6s  %-7s  %-4s\n" \
        "────────────────" "──────" "────" "──────────────" "───────" "──────" "───────" "────"
    for i in "${!_MDH_S_LABEL[@]}"; do
        printf "  %-16.16s  " "${_MDH_S_LABEL[$i]}"
        case "${_MDH_S_RES[$i]}" in
            unreachable|timeout|failed)
                word="${_MDH_S_RES[$i]^^}"
                printf '%b%-11s%b  %b%s%b\n' "$RED" "$word" "$RESET" "$DIM" \
                    "$(printf '%s\n' "${_MDH_S_ERR[$i]}" | head -1 | cut -c1-60)" "$RESET"
                continue ;;
        esac
        out="${_MDH_S_OUT[$i]}"
        svc=$(_mdh_q "$(_mdh_kv "$out" services_restart)")
        if [[ "$svc" != none && "$svc" != "?" ]]; then svc=$(tr ',' '\n' <<< "$svc" | grep -c .); fi
        _mdh_cell 6  "$(_mdh_q "$(_mdh_kv "$out" family)")"          'apt|dnf'
        _mdh_cell 4  "$(_mdh_q "$(_mdh_kv "$out" auto_updates)")"    'on'
        _mdh_cell 14 "$(_mdh_q "$(_mdh_kv "$out" security_only)")"   'yes'
        _mdh_cell 7  "$(_mdh_q "$(_mdh_kv "$out" pending_security)")" '0'
        _mdh_cell 6  "$(_mdh_q "$(_mdh_kv "$out" reboot_required)")" 'no'
        _mdh_cell 7  "$svc"                                          'none'
        _mdh_cell 4  "$(_mdh_q "$(_mdh_kv "$out" lock_busy)")"       'no'
        echo ""
    done
    echo -e "  ${DIM}Restart = number of services still running old libraries (names below).${RESET}"

    local hdr_done=0 head dist
    for i in "${!_MDH_S_LABEL[@]}"; do
        local -a lines=()
        out="${_MDH_S_OUT[$i]}"; dist=""
        case "${_MDH_S_RES[$i]}" in
            unreachable|timeout|failed)
                while IFS= read -r v; do [[ -n "$v" ]] && lines+=("$v"); done \
                    <<< "$(printf '%s\n' "${_MDH_S_ERR[$i]}" | head -3)" ;;
            *)
                svc=$(_mdh_kv "$out" services_restart)
                if [[ -n "$svc" && "$svc" != none && "$svc" != unknown ]]; then lines+=("services to restart: ${svc//,/, }"); fi
                v=$(_mdh_kv "$out" toolkit_policy)
                if [[ "$(_mdh_kv "$out" auto_updates)" == on && "$v" == absent ]]; then
                    lines+=("automatic updates are on through a policy the toolkit did not write")
                fi
                while IFS= read -r v; do [[ -n "$v" ]] && lines+=("$v"); done \
                    <<< "$(printf '%s\n' "$out" | sed -n 's/^note=//p')"
                dist=$(_mdh_kv "$out" distro) ;;
        esac
        head="${_MDH_S_LABEL[$i]}"
        (( ${#lines[@]} )) || continue
        if (( ! hdr_done )); then echo ""; echo -e "  ${BOLD}Notes${RESET}"; hdr_done=1; fi
        printf '  %b%s%b' "$CYAN" "$head" "$RESET"
        if [[ -n "$dist" ]]; then printf '  %b%s%b' "$DIM" "$dist" "$RESET"; fi
        echo ""
        for n in "${lines[@]}"; do
            fold -s -w 84 <<< "$n" | sed '1!s/^/  /' | {
                IFS= read -r v; printf '    %b·%b %s\n' "$YELLOW" "$RESET" "$v"
                while IFS= read -r v; do printf '    %s\n' "$v"; done
            }
        done
    done
    return 0
}

# _mdh_status_collect — read status from every selected server into _MDH_S_*.
_mdh_status_collect() {
    local script="$1" idx k=0 n=${#_md_selected_idx[@]} errf err word
    _MDH_S_LABEL=(); _MDH_S_RES=(); _MDH_S_OUT=(); _MDH_S_ERR=()
    errf=$(mktemp) || { error "mktemp failed"; return 1; }
    for idx in "${_md_selected_idx[@]}"; do
        k=$((k+1)); _mdh_load_host "$idx"
        printf "\r  Reading %d/%d: %-30.30s" "$k" "$n" "$_MDH_L"
        : > "$errf"
        _mdh_call "$MDH_T_STATUS" "$errf" "$script"
        err=$(_hu_clean < "$errf" 2>/dev/null || true)
        word=$(_mdh_rc_word "$_MDH_RC" "$_MDH_OUT")
        _MDH_S_LABEL+=("$_MDH_L"); _MDH_S_OUT+=("$_MDH_OUT")
        case "$word" in
            OK)
                _MDH_S_RES+=(ok); _MDH_S_ERR+=("")
                log "[HOST UPDATES] status $_MDH_L ($_MDH_H): $(printf '%s\n' "$_MDH_OUT" | grep -E '^(auto_updates|security_only|pending_security|reboot_required)=' | paste -sd' ' -)" ;;
            UNREACHABLE)
                _MDH_S_RES+=(unreachable); _MDH_S_ERR+=("${err:-ssh exit 255}")
                log "[HOST UPDATES] status $_MDH_L ($_MDH_H): unreachable: $(head -1 <<< "$err")" ;;
            TIMEOUT)
                _MDH_S_RES+=(timeout); _MDH_S_ERR+=("no reply within ${MDH_T_STATUS}s")
                _mdh_log_out "status $_MDH_L ($_MDH_H): TIMEOUT after ${MDH_T_STATUS}s" "$_MDH_OUT" ;;
            *)
                _MDH_S_RES+=(failed)
                _MDH_S_ERR+=("$( { printf '%s\n' "$_MDH_OUT" | grep '^ERROR:'; printf '%s\n' "$err"; } | grep -v '^[[:space:]]*$' \
                    || echo "status did not finish (exit $_MDH_RC, no __OK__)")")
                _mdh_log_out "status $_MDH_L ($_MDH_H): FAILED rc=$_MDH_RC" "$_MDH_OUT"$'\n'"$err" ;;
        esac
    done
    rm -f "$errf" 2>/dev/null || true
    printf "\r%60s\r" ""
    return 0
}

_mdh_status() {
    _mdh_env_ok || { _mdh_pause; return 0; }
    _md_select_servers || { _mdh_pause; return 0; }
    local script
    script=$(_mdh_build status) || { _mdh_pause; return 0; }
    echo ""
    info "Reading update status from ${#_md_selected_idx[@]} server(s) (read-only)..."
    _mdh_status_collect "$script" || { _mdh_pause; return 0; }
    _mdh_status_table
    _mdh_pause
    return 0
}

# ─── Enable / disable ─────────────────────────────────────────────────────────

# _mdh_apply <action label> <script> — run a state-changing snippet on every
# selected server, show its output indented, count OK only on exit 0 + __OK__.
# hu_script already opens enable/disable with `trap '' HUP PIPE`, so a dropped
# or timed-out session does not stop the script between two writes.
# Fills _MDH_A_* for the caller's summary.
declare -a _MDH_A_LABEL=() _MDH_A_RES=() _MDH_A_OUT=()
_mdh_apply() {
    local what="$1" script="$2" idx k=0 n=${#_md_selected_idx[@]} res
    _MDH_A_LABEL=(); _MDH_A_RES=(); _MDH_A_OUT=()
    for idx in "${_md_selected_idx[@]}"; do
        k=$((k+1)); _mdh_load_host "$idx"
        echo ""
        printf '  %b[%d/%d] %s%b  %s@%s:%s\n' "$BOLD" "$k" "$n" "$_MDH_L" "$RESET" "$_MDH_U" "$_MDH_H" "$_MDH_P"
        _mdh_call "$MDH_T_APPLY" merge "$script"
        printf '%s\n' "$_MDH_OUT" | grep -v '^__OK__$' | _mdh_lines "    " "$DIM"
        res=$(_mdh_rc_word "$_MDH_RC" "$_MDH_OUT")
        case "$res" in
            OK)          success "$_MDH_L: $what OK" ;;
            UNREACHABLE) error "$_MDH_L: unreachable (ssh exit 255)" ;;
            TIMEOUT)     error "$_MDH_L: no reply within ${MDH_T_APPLY}s — the result is unknown; re-read Status" ;;
            *)           error "$_MDH_L: $what FAILED (exit $_MDH_RC$( [[ "$(_mdh_last "$_MDH_OUT")" == __OK__ ]] || echo ', no __OK__'))" ;;
        esac
        _MDH_A_LABEL+=("$_MDH_L"); _MDH_A_RES+=("$res"); _MDH_A_OUT+=("$_MDH_OUT")
        _mdh_log_out "$what $_MDH_L ($_MDH_H): $res rc=$_MDH_RC" "$_MDH_OUT"
    done
    return 0
}

# _mdh_apply_summary [show auto_updates=] — one line per server + totals.
_mdh_apply_summary() {
    local show_state="${1:-}" i ok=0 bad=0 st c
    echo ""
    echo -e "  ${BOLD}Summary${RESET}"
    for i in "${!_MDH_A_LABEL[@]}"; do
        c="$RED"; [[ "${_MDH_A_RES[$i]}" == OK ]] && c="$GREEN"
        st=""
        if [[ -n "$show_state" ]]; then
            st=$(printf '%s\n' "${_MDH_A_OUT[$i]}" | grep -E '^auto_updates=' | tail -1)
            st="  ${st:-auto_updates=(not reported)}"
        fi
        printf "  %-16.16s  %b%-11s%b%s\n" "${_MDH_A_LABEL[$i]}" "$c" "${_MDH_A_RES[$i]}" "$RESET" "$st"
        if [[ "${_MDH_A_RES[$i]}" == OK ]]; then ok=$((ok+1)); else bad=$((bad+1)); fi
    done
    echo ""
    echo -e "  Totals: ${GREEN}${ok} OK${RESET}  ${RED}${bad} FAILED / UNREACHABLE / TIMEOUT${RESET}"
    log "[HOST UPDATES] summary: $ok OK, $bad not OK"
    return 0
}

_mdh_enable() {
    _mdh_env_ok || { _mdh_pause; return 0; }
    _md_select_servers || { _mdh_pause; return 0; }
    local ns=no script
    echo ""
    echo -e "  Installs each server's OS security-update service and limits it to the"
    echo -e "  distro's ${BOLD}security channel${RESET}. Disable removes what this writes."
    if declare -F _hu_restart_note >/dev/null; then _hu_restart_note; fi
    echo ""
    echo -e "  ${BOLD}NodeSource (Node.js) updates — asked once for every selected server${RESET}"
    echo -e "  ${DIM}apt servers only (dnf servers ignore it). NodeSource ships every Node.js${RESET}"
    echo -e "  ${DIM}24.x release — features and fixes, not security fixes only — so allowing it${RESET}"
    echo -e "  ${DIM}lets an unattended run move the Node.js runtime under the pool and web apps.${RESET}"
    if _mdh_confirm "Also apply NodeSource updates automatically?"; then ns=yes; fi
    echo ""
    _mdh_confirm "Enable automatic security updates on ${#_md_selected_idx[@]} server(s) (NodeSource: $ns)?" \
        || { info "Cancelled — nothing was changed."; _mdh_pause; return 0; }
    script=$(_mdh_build enable "nodesource=$ns") || { _mdh_pause; return 0; }
    log "[HOST UPDATES] enable start nodesource=$ns servers=${#_md_selected_idx[@]}"
    _mdh_apply enable "$script"
    _mdh_apply_summary
    _mdh_pause
    return 0
}

_mdh_disable() {
    _mdh_env_ok || { _mdh_pause; return 0; }
    _md_select_servers || { _mdh_pause; return 0; }
    local script
    echo ""
    echo -e "  Turns automatic updates OFF and removes the toolkit's policy files on each"
    echo -e "  server. Packages stay installed; files edited by hand since are left alone."
    echo ""
    _mdh_confirm "Disable automatic security updates on ${#_md_selected_idx[@]} server(s)?" \
        || { info "Cancelled — nothing was changed."; _mdh_pause; return 0; }
    script=$(_mdh_build disable) || { _mdh_pause; return 0; }
    log "[HOST UPDATES] disable start servers=${#_md_selected_idx[@]}"
    _mdh_apply disable "$script"
    _mdh_apply_summary state
    _mdh_pause
    return 0
}

# ─── Run security patch now (detached) ────────────────────────────────────────

# Per-server state for one run, parallel arrays: label, host index, run id,
# remote log path, state (started | busy | unreachable | timeout | failed |
# running | done | vanished | other | none), rc, final poll output, and the
# reason shown when no run is being watched.
declare -a _MDH_R_LABEL=() _MDH_R_IDX=() _MDH_R_ID=() _MDH_R_LOG=() _MDH_R_ST=() _MDH_R_RC=() _MDH_R_OUT=() _MDH_R_WHY=()

_mdh_runs_reset() {
    _MDH_R_LABEL=(); _MDH_R_IDX=(); _MDH_R_ID=(); _MDH_R_LOG=(); _MDH_R_ST=(); _MDH_R_RC=(); _MDH_R_OUT=(); _MDH_R_WHY=()
}

# _mdh_launch_all <run-now script> — start the detached run on every server.
_mdh_launch_all() {
    local launch idx id log how st why word
    launch=$(hu_launch_script "$1") || { error "could not build the launcher"; return 1; }
    _mdh_runs_reset
    for idx in "${_md_selected_idx[@]}"; do
        _mdh_load_host "$idx"
        printf "  ${BOLD}%-16.16s${RESET}  " "$_MDH_L"
        _mdh_call "$MDH_T_LAUNCH" merge "$launch"
        id=""; log=""; how=""; st=failed; why=""
        word=$(_mdh_rc_word "$_MDH_RC" "$_MDH_OUT")
        if [[ "$word" == OK ]]; then
            IFS='|' read -r id log how <<< "$(_hu_val "$_MDH_OUT" started)"
            if [[ "$id" =~ ^[0-9]{8}_[0-9]{6}$ ]]; then
                st=started; printf '%bstarted%b %b(%s) %s%b\n' "$GREEN" "$RESET" "$DIM" "$how" "$log" "$RESET"
            else
                id=""; log=""; why="launch reply unreadable"; printf '%bFAILED%b  %s\n' "$RED" "$RESET" "$why"
            fi
        elif [[ -n "$(_hu_val "$_MDH_OUT" busy)" ]]; then
            st=busy; IFS='|' read -r id log <<< "$(_hu_val "$_MDH_OUT" busy)"
            if [[ ! "$id" =~ ^[0-9]{8}_[0-9]{6}$ ]]; then id=""; log=""; why="another start is in progress on this server"
            else why="the previous run ($id UTC) is still going — nothing new was started"; fi
            printf '%bNOT STARTED%b %b%s%b\n' "$YELLOW" "$RESET" "$DIM" "$why" "$RESET"
        elif [[ "$word" == TIMEOUT ]]; then
            st=timeout; why="no reply within ${MDH_T_LAUNCH}s — it may have started; check Last patch run"
            printf '%bTIMEOUT%b  %b%s%b\n' "$RED" "$RESET" "$DIM" "$why" "$RESET"
        elif [[ "$word" == UNREACHABLE ]]; then
            st=unreachable; why=$(_mdh_first_err "" "$_MDH_OUT")
            printf '%bUNREACHABLE%b  %b%s%b\n' "$RED" "$RESET" "$DIM" "$why" "$RESET"
        else
            why=$(_mdh_first_err "$_MDH_OUT" ""); printf '%bFAILED%b  %b%s%b\n' "$RED" "$RESET" "$DIM" "$why" "$RESET"
        fi
        printf '%s\n' "$_MDH_OUT" | grep '^WARN:' | _mdh_lines "    " "$DIM"
        _MDH_R_LABEL+=("$_MDH_L"); _MDH_R_IDX+=("$idx"); _MDH_R_ID+=("$id"); _MDH_R_LOG+=("$log")
        _MDH_R_ST+=("$st"); _MDH_R_RC+=(""); _MDH_R_OUT+=(""); _MDH_R_WHY+=("$why")
        _mdh_log_out "run-now launch $_MDH_L ($_MDH_H): $st id=${id:-none} rc=$_MDH_RC" "$_MDH_OUT"
    done
    return 0
}

# _mdh_poll_one <i> <tail> — refresh row i. A failed poll (ssh down for a
# moment) leaves the state as it was; the run itself does not depend on us.
_mdh_poll_one() {
    local i="$1" tail="$2" st
    _mdh_load_host "${_MDH_R_IDX[$i]}"
    _mdh_call "$MDH_T_POLL" /dev/null "$(hu_poll_script "${_MDH_R_ID[$i]}" "$tail")"
    if [[ "$(_mdh_rc_word "$_MDH_RC" "$_MDH_OUT")" != OK ]]; then return 1; fi
    st=$(_hu_val "$_MDH_OUT" state)
    case "$st" in
        done)     _MDH_R_RC[i]=$(_hu_val "$_MDH_OUT" rc) ;;
        running|vanished|other|none) ;;
        *) return 1 ;;
    esac
    _MDH_R_ST[i]="$st"; _MDH_R_OUT[i]="$_MDH_OUT"; _MDH_R_WHY[i]=""
    [[ -z "${_MDH_R_LOG[$i]}" ]] && _MDH_R_LOG[i]=$(_hu_val "$_MDH_OUT" log)
    [[ -z "${_MDH_R_ID[$i]}" ]] && _MDH_R_ID[i]=$(_hu_val "$_MDH_OUT" id)
    return 0
}

# _mdh_row_result <i> — OK | FAILED | STILL RUNNING | … for the summary.
_mdh_row_result() {
    local i="$1"
    case "${_MDH_R_ST[$i]}" in
        done)
            if [[ "${_MDH_R_RC[$i]}" == 0 && "$(_hu_val "${_MDH_R_OUT[$i]}" last)" == __OK__ ]]; then echo OK
            else echo FAILED; fi ;;
        running|started) echo "STILL RUNNING" ;;
        vanished) echo "FAILED" ;;
        busy) echo "NOT STARTED" ;;
        unreachable) echo UNREACHABLE ;;
        timeout) echo TIMEOUT ;;
        none) echo "NO RECORD" ;;
        other) echo "NEWER RUN" ;;
        *) echo FAILED ;;
    esac
}

# _mdh_watch — poll every MDH_WATCH_EVERY s until every started run has ended
# or MDH_WATCH_MAX s pass. Ctrl-C ends the watch only. rc 1 when interrupted.
_mdh_watch() {
    local max="$MDH_WATCH_MAX" every="$MDH_WATCH_EVERY" t0 el i left running_l
    [[ "$max" =~ ^[0-9]+$ ]] || max=1800
    [[ "$every" =~ ^[1-9][0-9]*$ ]] || every=10
    _MDH_STOP=0
    trap '_MDH_STOP=1' INT
    t0=$SECONDS
    echo ""
    info "Watching every ${every}s, for up to ${max}s. Ctrl-C stops WATCHING only — the runs continue on the servers."
    while :; do
        left=0; running_l=""
        for i in "${!_MDH_R_LABEL[@]}"; do
            case "${_MDH_R_ST[$i]}" in started|running) ;; *) continue ;; esac
            (( _MDH_STOP )) && break
            _mdh_poll_one "$i" 0 || true
            case "${_MDH_R_ST[$i]}" in
                started|running) left=$((left+1)); running_l+="${running_l:+, }${_MDH_R_LABEL[$i]}" ;;
            esac
        done
        el=$((SECONDS - t0))
        (( _MDH_STOP )) && break
        (( left == 0 )) && break
        printf "  [%02d:%02d] still running on %d: %s\n" $((el/60)) $((el%60)) "$left" "$(cut -c1-60 <<< "$running_l")"
        (( el >= max )) && break
        sleep "$every"
        (( _MDH_STOP )) && break
    done
    trap - INT
    if (( _MDH_STOP )); then echo ""; warn "Stopped watching. The patch runs continue on the servers."; return 1; fi
    return 0
}

# _mdh_report_runs — final per-server block (result, reboot/services lines,
# log tail) and the summary.
_mdh_report_runs() {
    local i res c ok=0 bad=0 run=0 other=0
    for i in "${!_MDH_R_LABEL[@]}"; do
        res=$(_mdh_row_result "$i")
        c="$RED"; [[ "$res" == OK ]] && c="$GREEN"; [[ "$res" == "STILL RUNNING" || "$res" == "NOT STARTED" ]] && c="$YELLOW"
        echo ""
        printf '  %b%s%b  %b%s%b' "$BOLD" "${_MDH_R_LABEL[$i]}" "$RESET" "$c" "$res" "$RESET"
        if [[ -n "${_MDH_R_ID[$i]}" ]]; then printf '  %brun %s UTC%b' "$DIM" "${_MDH_R_ID[$i]}" "$RESET"; fi
        echo ""
        if [[ -n "${_MDH_R_LOG[$i]}" ]]; then printf '    %blog: %s%b\n' "$DIM" "${_MDH_R_LOG[$i]}" "$RESET"; fi
        case "${_MDH_R_ST[$i]}" in
            vanished) echo -e "    ${RED}the run ended without an exit code (killed, or the server rebooted under it)${RESET}" ;;
            none)     echo -e "    ${DIM}no detached patch run has been started on this server${RESET}" ;;
            other)    echo -e "    ${YELLOW}a newer run replaced the one being watched — use Last patch run${RESET}" ;;
            *) if [[ -n "${_MDH_R_WHY[$i]:-}" ]]; then printf '    %b%s%b\n' "$DIM" "${_MDH_R_WHY[$i]}" "$RESET"; fi ;;
        esac
        if [[ "${_MDH_R_ST[$i]}" == "done" && "${_MDH_R_RC[$i]}" != 0 ]]; then printf '    %bexit code %s%b\n' "$RED" "${_MDH_R_RC[$i]}" "$RESET"; fi
        printf '%s\n' "${_MDH_R_OUT[$i]}" | sed -n 's/^HUR|kv|//p' | _mdh_lines "    " "$BOLD"
        printf '%s\n' "${_MDH_R_OUT[$i]}" | sed -n 's/^HUR|tail|//p' | _mdh_lines "    | " "$DIM"
        case "$res" in
            OK) ok=$((ok+1)) ;; "STILL RUNNING") run=$((run+1)) ;;
            "NOT STARTED"|"NO RECORD"|"NEWER RUN") other=$((other+1)) ;; *) bad=$((bad+1)) ;;
        esac
        log "[HOST UPDATES] run-now ${_MDH_R_LABEL[$i]}: $res id=${_MDH_R_ID[$i]:-none} rc=${_MDH_R_RC[$i]:-} $(printf '%s\n' "${_MDH_R_OUT[$i]}" | sed -n 's/^HUR|kv|//p' | paste -sd' ' -)"
    done
    echo ""
    echo -e "  Summary: ${GREEN}${ok} OK${RESET}  ${RED}${bad} FAILED / UNREACHABLE / TIMEOUT${RESET}  ${YELLOW}${run} still running  ${other} not started / no record${RESET}"
    if (( run > 0 )); then echo -e "  ${DIM}Check them later with Host security updates → Last patch run.${RESET}"; fi
    echo ""
    echo -e "  ${BOLD}Nothing was rebooted.${RESET} Where reboot_required=yes, reboot from"
    echo -e "  Remote node control → Reboot servers (key e) when it suits you."
    return 0
}

_mdh_run_now() {
    _mdh_env_ok || { _mdh_pause; return 0; }
    _md_select_servers || { _mdh_pause; return 0; }
    local script i
    echo ""
    echo -e "  Applies pending SECURITY updates once on each server. The run starts"
    echo -e "  ${BOLD}detached${RESET} on the server (so a dropped SSH connection cannot interrupt dpkg)"
    echo -e "  and logs to $HU_LOG_DIR/run-now_<UTC time>.log there."
    echo -e "  apt servers: refuses unless Enable installed the security-only policy."
    echo -e "  dnf servers: runs dnf upgrade --security."
    if declare -F _hu_restart_note >/dev/null; then _hu_restart_note; fi
    echo -e "  ${BOLD}Nothing reboots.${RESET} Reboots are done from Remote node control → Reboot servers (key e)."
    echo ""
    _mdh_confirm "Start a security patch run on ${#_md_selected_idx[@]} server(s)?" \
        || { info "Cancelled — nothing was changed."; _mdh_pause; return 0; }
    script=$(_mdh_build run-now) || { _mdh_pause; return 0; }
    log "[HOST UPDATES] run-now start servers=${#_md_selected_idx[@]}"
    echo ""
    # A Ctrl-C mid-launch would leave a server not knowing whether it started.
    trap '' INT
    _mdh_launch_all "$script"
    trap - INT
    local started=0
    for i in "${!_MDH_R_ST[@]}"; do [[ "${_MDH_R_ST[$i]}" == started ]] && started=$((started+1)); done
    if (( started > 0 )); then
        if _mdh_watch; then
            info "Fetching results..."
            for i in "${!_MDH_R_LABEL[@]}"; do
                case "${_MDH_R_ST[$i]}" in started|running|done|vanished) _mdh_poll_one "$i" 20 || true ;; esac
            done
        else
            echo -e "  ${DIM}See the results later with Host security updates → Last patch run.${RESET}"
        fi
    fi
    _mdh_report_runs
    _mdh_pause
    return 0
}

# Last patch run — read-only look at each server's newest detached run.
_mdh_last_run() {
    _mdh_env_ok || { _mdh_pause; return 0; }
    _md_select_servers || { _mdh_pause; return 0; }
    local idx i=0
    _mdh_runs_reset
    echo ""
    info "Reading the last patch run on ${#_md_selected_idx[@]} server(s) (read-only)..."
    for idx in "${_md_selected_idx[@]}"; do
        _MDH_R_LABEL+=("${_md_labels[$idx]}"); _MDH_R_IDX+=("$idx"); _MDH_R_ID+=(""); _MDH_R_LOG+=("")
        _MDH_R_ST+=(unreachable); _MDH_R_RC+=(""); _MDH_R_OUT+=("")
        _MDH_R_WHY+=("could not read the run record (ssh failed or timed out, or the reply had no __OK__)")
        _mdh_poll_one "$i" 20 || true
        i=$((i+1))
    done
    _mdh_report_runs
    _mdh_pause
    return 0
}

# ─── Menu ─────────────────────────────────────────────────────────────────────

_mdh_menu() {
    local choice
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Mass Deployment — Host Security Updates${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  ${DIM}OS security-channel patches only · never reboots · grin node and pool untouched.${RESET}"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Status                   ${DIM}read-only, one row per server${RESET}"
        echo -e "  ${YELLOW}2${RESET}) Enable                   ${DIM}asks first; NodeSource is opt-in${RESET}"
        echo -e "  ${YELLOW}3${RESET}) Disable                  ${DIM}asks first; removes toolkit files only${RESET}"
        echo -e "  ${YELLOW}4${RESET}) Run security patch now   ${DIM}asks first; detached, never reboots${RESET}"
        echo -e "  ${GREEN}5${RESET}) Last patch run           ${DIM}read-only; result and log tail${RESET}"
        echo -e "  ${DIM}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [0-5]: ${RESET}"
        read -r choice || return 0
        case "$choice" in
            1) _mdh_status   || true ;;
            2) _mdh_enable   || true ;;
            3) _mdh_disable  || true ;;
            4) _mdh_run_now  || true ;;
            5) _mdh_last_run || true ;;
            0) return 0 ;;
            *) warn "Invalid selection."; sleep 1 ;;
        esac
    done
}
