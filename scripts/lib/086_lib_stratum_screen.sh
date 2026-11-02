# =============================================================================
# lib/086_lib_stratum_screen.sh — key 8 screens and 086 integration (design §10.8, §10.10)
# =============================================================================
# Sourced by 086_grin_diagnostics.sh after 086_lib_stratum.sh, _stack.sh and
# _baseline.sh (fixed order), which it depends on. It also uses 086's own
# screen helpers (_banner, _pick_node, _page, _sev_badge, pause) and
# 086_lib_diag.sh (the findings registry). Sourced, not executed — no shebang,
# no `set -e`. Every function here is reached through a `fn || true` menu arm,
# so errexit is OFF for the whole body.
#
#   stratum_latency        key 8: pick a node, gate, probe, report, sub-menu
#   _dgss_flow             that run for one node; sub-menu key R repeats it
#   dgss_*                 the report and the sub-menu views
#   dgs_quick_finding      key 1's finding, from the newest saved baseline
#   dgs_bundle_file        key 2's 11_stratum_<net>.txt
#
# The report is rendered into a variable, paged, then saved from that variable
# (no `| tee`, which would run the render in a subshell). Nothing here changes
# the node: the only writes are the report files under REPORT_DIR.
# =============================================================================

[[ -n "${_DGSS_LIB_LOADED:-}" ]] && return 0
_DGSS_LIB_LOADED=1

# How the last key 8 run ended: ran | prep (probe could not start) | refused |
# declined. DGSS_END overrides the closing note of the report.
DGSS_RUN=""; DGSS_END=""
DGSS_WIN_H=6                  # hours of log the report reads
DGSS_WF=""                    # the log window file of the last run

# ─── Small helpers ────────────────────────────────────────────────────────────
_dgss_fmt() {   # <number> [decimals] → "8.4", or "-" when empty
    [[ -n "${1:-}" ]] || { printf '%s' '-'; return 0; }
    awk -v v="$1" -v d="${2:-1}" 'BEGIN { printf "%s", sprintf("%." d "f", v) }'
}

_dgss_thou() {   # 3105 → "3 105"
    awk -v v="${1:-0}" 'BEGIN {
        s = sprintf("%d", v); o = ""
        while (length(s) > 3) { o = " " substr(s, length(s) - 2) o; s = substr(s, 1, length(s) - 3) }
        printf "%s", s o }'
}

_dgss_gt() { awk -v a="${1:-0}" -v b="${2:-0}" 'BEGIN { exit !(a + 0 > b + 0) }'; }

# tsv rows with empty fields filled by "-": `read` with a tab IFS collapses
# consecutive tabs and would shift every column after an empty one.
_dgss_tsv() { awk -F'	' '{ o = ""; for (i = 1; i <= NF; i++) o = o (i > 1 ? "	" : "") ($i == "" ? "-" : $i); print o }' "$1"; }

# Prose hint, wrapped to stay inside 79 columns (8 spaces + 71). ASCII only, so
# fold's column count is exact in every locale.
_dgss_hint() {
    local l
    printf '%s\n' "$1" | fold -s -w 71 | sed 's/[[:space:]]*$//' | while IFS= read -r l; do
        printf '        %b%s%b\n' "${DIM:-}" "$l" "${RESET:-}"
    done
}

# One finding in the §10.10 form: badge, bold title, lean, observed lines
# (split at "\n"), dim hint.
_dgss_find() {   # <sev> <title> <origin> <observed> <hint>
    local sev=$1 title=$2 origin=$3 obs=$4 hint=$5 l lk=""
    [[ -n "$origin" ]] && lk="  ${DIM:-}(likely: $origin)${RESET:-}"
    echo -e "  $(_sev_badge "$sev")  ${BOLD:-}${title}${RESET:-}${lk}"
    if [[ -n "$obs" ]]; then
        while IFS= read -r l; do printf '        %s\n' "$l"; done <<< "$obs"
    fi
    [[ -n "$hint" ]] && _dgss_hint "$hint"
    return 0
}

_dgss_sec() {   # <title> — "── title ───", 62 columns
    local t=$1 pad
    pad=$(( 62 - ${#t} - 4 )); (( pad < 3 )) && pad=3
    local fill; printf -v fill '%*s' "$pad" ''; fill=${fill// /─}
    printf '%b── %s %s%b\n' "${BOLD:-}${CYAN:-}" "$t" "$fill" "${RESET:-}"
}

# The node a screen is about, always the exe-matched pid the probe resolved.
# Not shown when the stratum config already ruled the run out.
_dgss_node_lines() {
    local ua prov up="" s
    [[ -n "$DGS_DIR" ]] || return 0
    case "$DGS_PREP" in disabled|addr_missing|addr_bad|addr_nonlocal) return 0 ;; esac
    s=$(_dg_num "$(ps -o etimes= -p "$DGS_PID" 2>/dev/null | tr -d ' ')")
    if (( s >= 86400 )); then up=", up $(( s / 86400 )) d"
    elif (( s >= 3600 )); then up=", up $(( s / 3600 )) h"
    elif (( s >= 60 )); then up=", up $(( s / 60 )) min"; fi
    printf '  %-8s %s · pid %s%s%s\n' node "$DGS_DIR" "$DGS_PID" \
        "$([[ "$DGS_PREP" == pid_mismatch ]] || echo ' (exe match)')" "$up"
    if [[ -n "${DGS_BIN[sha12]:-}" || -n "${DGS_P[user_agent]:-}" ]]; then
        ua=${DGS_P[user_agent]:-}
        prov=$(_dgss_prov_text "${DGS_BIN[provenance]:-}" "${DGS_BIN[source_ref]:-}" "${DGS_BIN[commit]:-}")
        printf '  %-8s %s\n' binary "${ua:+$ua · }sha ${DGS_BIN[sha12]:-?}${prov:+ · $prov}"
    fi
    if [[ "$DGS_CFG" == ok ]]; then
        local oth="${DGS_GATE_OTHERS:-unknown}" lvl=${DGS_LOG_LEVEL:-"not set"}
        if [[ "$oth" == unknown ]]; then oth="other connections unknown"
        else oth="$oth other connection$([[ "$oth" == 1 ]] || echo s)"; fi
        printf '  %-8s %s:%s · refresh %s s · log %s · %s\n' stratum "$DGS_HOST" "$DGS_PORT" \
            "$DGS_ATTEMPT" "$lvl" "$oth"
    fi
    return 0
}

# Install-record wording. `no_record` is the normal state of a Script 01
# release install, so it is never worded as "not a release build".
_dgss_prov_text() {   # <provenance> <source_ref> <commit>
    case "$1" in
        source_build)     if [[ -n "$2" ]]; then printf 'source build %s' "$2"
                          elif [[ -n "$3" ]]; then printf 'source build %s' "${3:0:7}"
                          else printf 'source build'; fi ;;
        archived_release) printf 'archived release' ;;
        release)          printf 'official release' ;;
        no_record)        printf 'no install record' ;;
        swapped)          printf 'replaced since install' ;;
    esac
}

# The likely-origin lean: a CPU-bound build slows down on a starved host
# whatever the binary; otherwise the template is grin's own stratum loop.
# Prints "<origin>|<why>".
_dgss_lean() {   # <steal %> <psi cpu avg60>
    if _dgss_gt "${1:-0}" 5; then
        printf 'host|The host showed CPU steal %s %%: a CPU-bound build slows down on a starved host whatever the binary.' "$(_dgss_fmt "$1")"
    elif _dgss_gt "${2:-0}" 10; then
        printf 'host|The host showed CPU pressure (avg60 %s): a CPU-bound build slows down on a starved host whatever the binary.' "$(_dgss_fmt "$2")"
    else
        printf 'upstream|The build runs in grin'"'"'s own stratum loop; the host showed no CPU pressure.'
    fi
}

_dgss_pause() {
    echo ""
    (( ${UI_PAGED:-0} == 1 )) && echo -e "  ${DIM:-}You were in the pager - press ${RESET:-}${BOLD:-}q${RESET:-}${DIM:-} to leave it if you have not already.${RESET:-}"
    echo -e "  ${BOLD:-}Press Enter${RESET:-} to return to the stratum menu..."
    read -r || true
}

# ─── The gate screens (mock E) ───────────────────────────────────────────────
# Plain paragraph, 2-space indent, wrapped inside 79 columns. ASCII only.
_dgss_para() {
    printf '%s\n' "$1" | fold -s -w 75 | sed 's/[[:space:]]*$//; s/^/  /'
}

# Prints the gate's explanation. rc 0 = go on (run, or the operator said y);
# rc 1 = not run, DGSS_RUN says why.
dgss_gate_screen() {
    local url=${DGS_WALLET_URL:-"(no wallet_listener_url)"} t
    if [[ "$DGS_GATE" == run ]]; then return 0; fi
    echo ""
    echo "  No miner or pool is connected to this node's stratum port ($DGS_HOST:$DGS_PORT)."
    echo ""
    if [[ "$DGS_GATE" == refuse ]]; then
        local how="refused the connection"; [[ "$DGS_WALLET_STATE" == timeout ]] && how="did not answer within 3 s"
        _dgss_find WARN "Wallet listener not reachable" consumer "$url $how" ""
        _dgss_para "Not run. With no other client, the probe's connection would make the node start building templates, and every build calls this wallet. With the wallet down, the build retries every 5 s with an ERROR line in the node log, and that does not stop when the probe leaves. Start the wallet listener first, or measure while a miner is connected."
        DGSS_RUN=refused; DGSS_END="not run · nothing was changed"
        return 1
    fi
    t="While the probe is connected, the node builds a block template about every $DGS_ATTEMPT s and at every new block, and asks the wallet listener at $url for a coinbase each time. It stops when the probe disconnects."
    case "$DGS_WALLET_STATE" in
        burn)     t+=" burn_reward is true on this node, so no wallet is called." ;;
        unset)    t="While the probe is connected, the node builds a block template about every $DGS_ATTEMPT s and at every new block, and asks the wallet listener for a coinbase each time. It stops when the probe disconnects. No wallet_listener_url is set, so the listener could not be checked." ;;
        nonlocal) t+=" It is not on this box, so it was not checked." ;;
        *)        t+=" The listener accepted a connection, but that does not prove it answers coinbase requests: if the probe sees no job, stop it with Ctrl+C and check the node log for \"Can't connect to wallet listener\"." ;;
    esac
    t+=" Nothing else on the node changes."
    _dgss_para "$t"
    echo ""
    if _dgs_no "  Run the probe anyway?"; then return 0; fi
    DGSS_RUN=declined; DGSS_END="not run · nothing was changed"
    return 1
}

# ─── Verdict: the findings of one key 8 run ──────────────────────────────────
# Fills the 086 findings registry; the render prints it. Sets DGSS_END.
dgss_verdict() {
    local area="Stratum $DGS_NET" st=${DGS_PROBE_STATUS:-} n p95 lean origin why
    local steal psi
    dg_reset; DGSS_END=""
    [[ -n "$DGS_PORT_WARN" ]] && dg_add WARN "$area" config "Stratum address looks wrong" \
        "$DGS_PORT_WARN" "This node's stratum_server_addr names the other network's port. Check grin-server.toml."

    if [[ "$DGSS_RUN" == prep ]]; then
        case "$DGS_PREP" in
            pid_mismatch)
                dg_add WARN "$area" toolkit "Cannot tell which grin process is this node" \
                    "pid $DGS_PID; grin processes for this dir: ${DGS_PID_LIST:-none}" \
                    "A second grin or a wrapper holds this node dir. Run key 1 (it flags duplicate grin processes), stop the node through the toolkit, start it once, then run key 8."
                DGSS_END="nothing was measured" ;;
            disabled)
                dg_add INFO "$area" config "The stratum server is OFF on this node" \
                    "$DGS_TOML"$'\n'"enable_stratum_server = ${DGS_ENABLED:-not set}" ""
                DGSS_END="stratum disabled · nothing was changed" ;;
            addr_missing)
                dg_add WARN "$area" config "stratum_server_addr is not set" "$DGS_TOML" ""
                DGSS_END="no stratum address · nothing was changed" ;;
            addr_bad)
                dg_add WARN "$area" config "stratum_server_addr is not host:port" "$DGS_ADDR" ""
                DGSS_END="bad stratum address · nothing was changed" ;;
            addr_nonlocal)
                dg_add INFO "$area" config "The stratum address is not on this box" "$DGS_ADDR" \
                    "Key 8 connects only to this host, never to another."
                DGSS_END="not run · nothing was changed" ;;
            not_listening)
                dg_add WARN "$area" config "Stratum is enabled but nothing listens on $DGS_HOST:$DGS_PORT" \
                    "$DGS_TOML says enable_stratum_server = true" ""
                DGSS_END="stratum not listening · nothing was measured" ;;
            no_python)
                dg_add INFO "$area" host "python3 not found: the probe cannot run" \
                    "Log view, rejects and threads below still ran." \
                    "Install python3 (apt-get install python3 / dnf install python3), then run key 8."
                ;;
            no_curl)
                dg_add INFO "$area" host "curl not found: the probe cannot run" \
                    "Log view, rejects and threads below still ran." \
                    "Install curl (apt-get install curl / dnf install curl), then run key 8."
                ;;
        esac
        return 0
    fi
    if [[ "$DGSS_RUN" != ran ]]; then return 0; fi

    # The probe ran: failures first, each with the next step.
    case "$st" in
        node_down)
            dg_add CRIT "$area" host "Node API did not answer" \
                "$DGS_API_HOST:$DGS_API_PORT get_status: ${DGS_P[api_err]:-no reply}" ""
            dg_add CRIT "$area" config "Stratum did not answer" \
                "$DGS_HOST:$DGS_PORT ${DGS_P[stratum_err]:-no reply}" ""
            DGSS_END="node not answering · nothing was measured" ;;
        api_auth)
            dg_add WARN "$area" toolkit "The owner API rejected the secret" \
                "secret file: ${DGS_SECRET_PATH:-not found}" \
                "Run grin-secret-sync, or check api_secret_path in grin-server.toml, then run key 8 again."
            DGSS_END="no access to the node API · nothing was measured" ;;
        syncing)
            if [[ -s "$DG_TMP/dgs_probe.rows" ]]; then
                # The node left no_sync mid-run; the rows before that are kept.
                dg_add INFO "$area" network "Node started syncing: the probe stopped" \
                    "${DGS_P[reason]:-}" \
                    "The rows below were measured before the sync began. Run key 8 again once Script 01 status shows the node synced."
            else
                dg_add INFO "$area" network "Node is syncing: the probe did not start" \
                    "${DGS_P[reason]:-}" \
                    "The probe measures only a synced node. Run key 8 again once Script 01 status shows the node synced."
                DGSS_END="node syncing · nothing was measured"
            fi ;;
        wrong_node)
            dg_add WARN "$area" config "The stratum port and the API are not the same node" \
                "${DGS_P[reason]:-}" \
                "Check stratum_server_addr and api_http_addr in grin-server.toml: one of them points at the other network's node."
            DGSS_END="wrong node on the port · nothing was measured" ;;
        stratum_lost|api_lost|protocol|error)
            dg_add WARN "$area" network "The probe stopped early" "${DGS_P[reason]:-${DGS_PROBE_ERR:-unknown}}" \
                "Run key 8 again. If it repeats, read the node log with key 4, and key 7 for what the node did recently."
            ;;
        no_job)
            # The row-level finding below carries the advice.
            ;;
        interrupted)
            dg_add INFO "$area" "" "Stopped with Ctrl+C" "${DGS_P[n]:-0} block(s) measured so far" "" ;;
        time)
            dg_add INFO "$area" network "Time limit reached" \
                "${DGS_P[n]:-0} of the wanted blocks arrived in ${DGS_P[duration_s]:-?} s" \
                "Blocks arrive about a minute apart on average. Run key 8 again for a longer sample." ;;
    esac

    n=$(_dg_num "${DGS_P[n]:-0}")
    steal=${DGS_CT[steal_pct]:-}; psi=${DGS_PSI_CPU60:-}
    p95=${DGS_P[p95_s]:-}
    if (( n >= 3 )) && [[ -n "$p95" ]]; then
        local sev=OK ttl obs
        IFS='|' read -r origin why <<< "$(_dgss_lean "$steal" "$psi")"
        if _dgss_gt "$p95" 2; then sev=WARN; elif _dgss_gt "$p95" 0.5; then sev=INFO; fi
        ttl="Template latency p95 $(_dgss_fmt "$p95") s"
        obs="p50 $(_dgss_fmt "${DGS_P[p50_s]:-}") s · $n blocks · healthy is under 0.5 s"
        [[ -n "${DGS_P[loss_pct]:-}" ]] && obs+=$'\n'"loss ≈ ${DGS_P[loss_pct]} % of hashrate (node part only)"
        if [[ "$sev" == WARN ]]; then
            dg_add WARN "$area" "$origin" "$ttl" "$obs" "Origins are pattern-based leans, not a diagnosis. $why"
        elif [[ "$sev" == INFO ]]; then
            dg_add INFO "$area" "" "$ttl" "$obs" "Slower than a healthy node, below the 2 s warning line."
        else
            dg_add OK "$area" "" "$ttl" "$obs" ""
        fi
    elif (( n >= 1 )); then
        dg_add INFO "$area" "" "Template latency: only $n block$([[ $n == 1 ]] || echo s) measured" \
            "Percentiles need 3 blocks; the rows are listed below." \
            "Run key 8 again and choose 5 or 10 blocks."
    elif [[ "$st" == ok || "$st" == time || "$st" == interrupted ]]; then
        dg_add INFO "$area" network "No new block arrived during the run" \
            "nothing to time" \
            "Blocks arrive about a minute apart on average. Run key 8 again and give it a few minutes."
    fi
    if (( $(_dg_num "${DGS_P[no_job]:-0}") > 0 )); then
        dg_add WARN "$area" consumer "No job for a new tip in 120 s" \
            "wallet listener: ${DGS_WALLET_URL:-not set}" \
            "Look for \"Can't connect to wallet listener\" in the node log: a build that cannot get a coinbase never finishes."
    fi
    return 0
}

# ─── Report pieces ───────────────────────────────────────────────────────────
_dgss_render_findings() {
    local i
    for i in "${!DG_SEV[@]}"; do
        _dgss_find "${DG_SEV[$i]}" "${DG_TITLE[$i]}" "${DG_ORIGIN[$i]}" "${DG_OBS[$i]}" "${DG_HINT[$i]}"
    done
}

# Plain-text "what to do next" paragraphs that follow the findings.
_dgss_next_text() {
    case "${DGSS_RUN:-}:${DGS_PREP:-}:${DGS_PROBE_STATUS:-}" in
        prep:disabled:*)
            echo "  There is nothing to measure. To mine on this node, set"
            echo "    enable_stratum_server = true"
            echo "  under [server.stratum_mining_config] and restart the node through the"
            echo "  toolkit, or run the solo or pool setup, which does both." ;;
        prep:addr_missing:*)
            echo "  grin needs stratum_server_addr when stratum is on. Set it under"
            echo "  [server.stratum_mining_config], for example"
            echo "    stratum_server_addr = \"127.0.0.1:$([[ $DGS_NET == testnet ]] && echo 13416 || echo 3416)\""
            echo "  and restart the node through the toolkit, then run key 8 again." ;;
        prep:addr_bad:*)
            echo "  Write it as host:port under [server.stratum_mining_config], restart the"
            echo "  node through the toolkit, then run key 8 again." ;;
        prep:addr_nonlocal:*)
            echo "  Run key 8 on the machine that owns $DGS_ADDR." ;;
        prep:not_listening:*)
            echo "  The node has not restarted since the toml changed, or the bind failed."
            echo "  Restart the node through the toolkit, then run key 8 again." ;;
        prep:pid_mismatch:*) : ;;
        ran:*:node_down)
            echo "  A pruned node can freeze for about 100 s while it compacts. Wait two"
            echo "  minutes and run key 8 again. If it still fails, read the node log with"
            echo "  key 4, and key 7 for what the node did recently." ;;
    esac
}

_dgss_rows_table() {
    local rows="$DG_TMP/dgs_probe.rows" tip seen job lat w fl lc fc
    [[ -s "$rows" ]] || return 1
    printf '  %-9s %-13s %-13s %9s   %s\n' "tip" "seen (UTC)" "first job" "latency" "flags"
    while IFS=$'\t' read -r tip seen job lat w fl; do
        seen=${seen:0:10}; job=${job:0:10}
        [[ "$fl" == "-" ]] && fl=""
        [[ "$job" == "-" ]] && job=""; [[ "$lat" == "-" ]] && lat=""
        fc=${fl//,/ }; fc=${fc//below-res/}
        fc=${fc#"${fc%%[![:space:]]*}"}
        if [[ -z "$job" || -z "$lat" ]]; then
            # Only a no-job row waited the full 120 s; superseded and
            # unfinished rows ended for another reason.
            [[ ",$fl," == *,no-job,* ]] && fc+=" (120 s)"
            # "—" is 3 bytes and printf pads bytes: widths 15/11 print as 13/9.
            printf '  %-9s %-13s %-15s %11s   %s\n' "$tip" "$seen" "—" "—" "${fc:-no job}"
            continue
        fi
        if [[ ",$fl," == *,below-res,* ]]; then lc="< $(_dgss_fmt "$w" 2) s"
        else lc="$(_dgss_fmt "$lat" 2) s"; fi
        printf '  %-9s %-13s %-13s %9s   %s\n' "$tip" "$seen" "$job" "$lc" "$fc"
    done < <(_dgss_tsv "$rows")
    return 0
}

_dgss_probe_section() {
    local n bl
    n=$(_dg_num "${DGS_P[n]:-0}")
    [[ -s "$DG_TMP/dgs_probe.rows" ]] || return 0
    echo ""
    _dgss_sec "Template latency (probe, $n block$([[ $n == 1 ]] || echo s), poll ${DGS_P[poll_ms]:-200} ms)"
    _dgss_rows_table | sed 's/[[:space:]]*$//'
    if (( n >= 3 )) && [[ -n "${DGS_P[p95_s]:-}" ]]; then
        printf '  p50 %s s · p95 %s s · max %s s   (true value up to +%s s)\n' \
            "$(_dgss_fmt "${DGS_P[p50_s]:-}" 2)" "$(_dgss_fmt "${DGS_P[p95_s]:-}" 2)" \
            "$(_dgss_fmt "${DGS_P[max_s]:-}" 2)" "$(_dgss_fmt "${DGS_P[bound_s]:-}" 2)"
    else
        echo "  n too small for percentiles (they need 3 blocks)."
    fi
    if (( $(_dg_num "${DGS_P[refresh_n]:-0}") > 0 )) && [[ -n "${DGS_P[deadline_build_s]:-}" ]]; then
        printf '  refresh interval p50 %s s → deadline build %s–%s s\n' \
            "$(_dgss_fmt "${DGS_P[refresh_p50_s]:-}")" "$(_dgss_fmt "${DGS_P[deadline_build_s]:-}")" \
            "$(_dgss_fmt "${DGS_P[deadline_build_hi_s]:-}")"
    fi
    if [[ -n "${DGS_P[loss_pct]:-}" ]]; then
        printf '  loss ≈ %s s / %s s ≈ %s %%   (miner link and pool relay not included)\n' \
            "$(_dgss_fmt "${DGS_P[mean_s]:-}")" "$(_dgss_fmt "${DGS_P[block_interval_s]:-}")" "${DGS_P[loss_pct]}"
    fi
    bl=$(_dg_num "${DGS_P[queued]:-0}")
    (( bl > 0 )) && echo "  queued = a new block arrived while a refresh build was running."
    return 0
}

_dgss_rej_pattern() {
    local ht=${DGS_R[hours_total]:-0} hs=${DGS_R[hours_with_stale]:-0}
    case "${DGS_R[pattern]:-none}" in
        none)      echo "no stale shares in the window" ;;
        steady)    echo "pattern: steady ($hs of $ht hours), the signature of slow template builds" ;;
        burst)     echo "pattern: burst (${DGS_R[burst_max]:-?} within 10 minutes from ${DGS_R[burst_start]:-?} log time), quick blocks or a reorg" ;;
        *)
            if (( $(_dg_num "${DGS_R[stale]:-0}") < 10 )); then
                echo "pattern: scattered ($hs of $ht hours), under 10 stale shares, too few to call"
            else
                echo "pattern: scattered ($hs of $ht hours), no clear cause from the log alone"
            fi ;;
    esac
}

_dgss_rej_section() {   # <hours>
    local inv pct
    [[ -n "${DGS_R[stale]:-}" ]] || return 0
    inv=$(( $(_dg_num "${DGS_R[invalid]:-0}") + $(_dg_num "${DGS_R[invalid_share]:-0}") ))
    echo ""
    _dgss_sec "Node rejects (log, $1 h)"
    pct=""
    [[ -n "${DGS_R[stale_pct]:-}" ]] && pct=" → stale ${DGS_R[stale_pct]} %"
    printf '  stale %s · accepted %s · low-diff %s · invalid %s%s\n' \
        "$(_dgss_thou "${DGS_R[stale]}")" "$(_dgss_thou "${DGS_R[accepted]:-0}")" \
        "$(_dgss_thou "${DGS_R[low_diff]:-0}")" "$(_dgss_thou "$inv")" "$pct"
    if [[ -z "${DGS_R[stale_pct]:-}" ]]; then
        echo "  accepted shares are not in this log (they are logged at Info), so no stale %."
    fi
    echo "  $(_dgss_rej_pattern)"
    return 0
}

# Top threads of a thread sample (prefix of dgs_thread_diff files), one line.
_dgss_top_line() {   # <prefix> [count]
    local f="$DG_TMP/dgs_cpu_$1.tsv" n=${2:-3} tid comm pct nw st out="" sep="" i=0
    [[ -s "$f" ]] || return 1
    while IFS=$'\t' read -r tid comm pct nw st; do
        out+="$sep$(printf '%s %5s %%' "$comm" "$pct")"; sep="    "
        i=$(( i + 1 )); (( i >= n )) && break
    done < "$f"
    printf '  %s\n' "$out"
}

_dgss_thread_section() {   # uses DGS_CT (tip-aligned) or DGS_C (standalone)
    local -n T=$1; local label=$2 sp ip
    [[ -n "${T[secs]:-}" ]] || return 0
    echo ""
    _dgss_sec "Threads ($label)"
    _dgss_top_line "$3" 3 || echo "  no thread data"
    printf '  host steal %s %% · iowait %s %%\n' "${T[steal_pct]:-?}" "${T[iowait_pct]:-?}"
    sp=${T[stratum_pct]:-}
    if [[ -z "$sp" ]]; then
        echo "  no thread named stratum_server was found in this process."
    elif [[ "$3" == tip && -n "${DGS_CI[stratum_pct]:-}" ]]; then
        ip=${DGS_CI[stratum_pct]}
        printf '  stratum_server: %s %% across a new block, %s %% between blocks\n' "$sp" "$ip"
        if _dgss_gt "$sp" 70 && ! _dgss_gt "$ip" 20; then
            echo "  busy only while a block is built: CPU work in the node, not waiting."
        fi
    fi
    return 0
}

# The p50 of one build-log stat row, or "-".
_dgss_stat() {   # <trigger> <metric> <col: 4=p50 5=p95 6=max>
    awk -F'\t' -v t="$1" -v m="$2" -v c="$3" '$1 == t && $2 == m { v = $c } END { print (v == "" ? "-" : v) }' \
        "$DG_TMP/dgs_build.stat" 2>/dev/null
}

_dgss_build_section() {   # <hours>
    local nn rn tr lbl a b c tp tq s1 s2 tot seg best bn
    [[ -n "${DGS_B[state]:-}" ]] || return 0
    echo ""
    if [[ "${DGS_B[state]}" != debug ]]; then
        _dgss_sec "Build log"
        echo "  Build lines are DEBUG; this node logs at ${DGS_LOG_LEVEL:-an unknown level}. To see where the time"
        echo "  goes, set  file_log_level = \"Debug\"  under [logging] in"
        echo "  ${DGS_TOML:-grin-server.toml}, then restart the node"
        echo "  through the toolkit. Debug writes several times more log; set it back"
        echo "  afterwards. 086 does not change it."
        return 0
    fi
    nn=$(_dg_num "${DGS_B[new_n]:-0}"); rn=$(_dg_num "${DGS_B[refresh_n]:-0}")
    _dgss_sec "Build log (DEBUG, $1 h, $nn new-block / $rn refresh builds)"
    printf '  %-11s %-17s %-12s %-12s %s\n' trigger "total p50/p95" "A coinbase" "B assemble" "C roots+state"
    for tr in new refresh; do
        [[ "$(_dgss_stat "$tr" total 4)" != "-" ]] || continue
        lbl="new block"; [[ "$tr" == refresh ]] && lbl=refresh
        tp=$(_dgss_fmt "$(_dgss_stat "$tr" total 4)" 2); tq=$(_dgss_fmt "$(_dgss_stat "$tr" total 5)" 2)
        a=$(_dgss_fmt "$(_dgss_stat "$tr" A 4)" 3); b=$(_dgss_fmt "$(_dgss_stat "$tr" B 4)" 3)
        c=$(_dgss_fmt "$(_dgss_stat "$tr" C 4)" 2)
        printf '  %-11s %-17s %-12s %-12s %s\n' "$lbl" "$tp / $tq s" "$a s" "$b s" "$c s"
    done
    if [[ -s "$DG_TMP/dgs_build.slow" ]]; then
        IFS=$'\t' read -r s1 s2 tot a b c seg _ < <(head -1 "$DG_TMP/dgs_build.slow")
        best=A; bn=$a
        _dgss_gt "$b" "$bn" && { best=B; bn=$b; }
        _dgss_gt "$c" "$bn" && { best=C; bn=$c; }
        _dgss_gt "$seg" "$bn" && { best=D; bn=$seg; }
        printf '  slowest (log time): %s → %s  %s s  (%s %s s)\n' "${s1:9:12}" "${s2:9:12}" "$(_dgss_fmt "$tot" 2)" "$best" "$(_dgss_fmt "$bn" 2)"
    fi
    echo "  C = set_txhashset_roots + state update (v5.5.2 path; see design §10.3)"
    if (( $(_dg_num "${DGS_B[stale_debug]:-0}") > 0 )); then
        printf '  stale lines: %s, of which %s inside or just after a new-block build\n' \
            "${DGS_B[stale_debug]}" "${DGS_B[stale_in_new_build]:-0}"
    fi
    return 0
}

_dgss_next_step() {
    if [[ "$DGSS_RUN" == ran && "${DGS_P[n]:-0}" != 0 && -n "${DGS_P[p95_s]:-}" ]] && _dgss_gt "${DGS_P[p95_s]}" 2; then
        echo ""
        echo "  Next: measure another binary on this node. Roll back (Script 01 → key G,"
        echo "  option 4), run key 8 again, then key 8 → C to compare the two."
    elif [[ "$DGSS_RUN" == ran && -n "${DGS_BL_FILE:-}" && "${DGS_P[n]:-0}" != 0 ]]; then
        echo ""
        echo "  Next: key 8 → C compares this run with a run of another binary."
    fi
}

# ─── Gather everything the report shows ──────────────────────────────────────
# After the probe (or without it): the log window, rejects, build timing, the
# binary and, when the probe took no tip-aligned pair, one standalone sample.
dgss_gather() {
    local lf
    DGS_B=(); DGS_R=(); DGS_C=()
    dgs_binary_fingerprint "$DGS_PID" "$DGS_DIR" || true
    lf=$(dg_node_logfile "$DGS_DIR")
    DGSS_WF="$DG_TMP/dgss_win"
    if [[ -f "$lf" ]] && dgs_log_window_file "$DGS_DIR" "$DGSS_WIN_H" "$DGSS_WF"; then
        dgs_build_log "$DGSS_WF" "$DGS_TOML" || true
        dgs_rejects "$DGSS_WF" "$DGSS_WIN_H" || true
    fi
    DGS_B[window_h]=$DGSS_WIN_H
    if [[ -z "${DGS_CT[secs]:-}" && -n "$DGS_PID" && "$DGS_PREP" != pid_mismatch ]]; then
        info "Sampling threads for 10 s..."
        dgs_threads "$DGS_PID" "$DGS_DIR" 10 now || true
    fi
    return 0
}

dgss_render() {
    local stamp="${1:-}"
    echo -e "  ${DIM:-}Mining / stratum latency · $DGS_NET · $(date -u '+%Y-%m-%d %H:%M') UTC${RESET:-}"
    echo ""
    _dgss_render_findings
    echo ""
    _dgss_node_lines
    _dgss_next_text
    if [[ "$DGSS_RUN" == ran || "$DGS_PREP" == no_python || "$DGS_PREP" == no_curl ]]; then
        [[ "$DGSS_RUN" == ran ]] && _dgss_probe_section
        _dgss_rej_section "$DGSS_WIN_H"
        if [[ -n "${DGS_CT[secs]:-}" ]]; then _dgss_thread_section DGS_CT "10 s across a new block" tip
        else _dgss_thread_section DGS_C "10 s, not aligned to a block" now; fi
        _dgss_build_section "$DGSS_WIN_H"
    fi
    _dgss_next_step
    if [[ -n "$stamp" ]]; then
        [[ -n "${DGS_BL_FILE:-}" ]] && echo "  Saved  $DGS_BL_FILE"
        echo "  Saved  $REPORT_DIR/stratum_${DGS_NET}_${stamp}.txt"
        if [[ -n "${DGS_P[duration_s]:-}" ]]; then
            local d=${DGS_P[duration_s]%.*}
            echo "  One probe connection was open for $(( d / 60 )) min $(( d % 60 )) s. Nothing on the node changed."
        fi
    fi
    local c w note
    c=$(dg_count_sev CRIT); w=$(dg_count_sev WARN)
    if [[ -n "$DGSS_END" ]]; then note=$DGSS_END
    else
        note=""
        (( c > 0 )) && note="$c critical · "
        if (( w > 0 )); then note+="$w warning$([[ $w == 1 ]] || echo s) · "; fi
        (( c + w == 0 )) && note="no warnings · "
        note+="nothing was changed"
    fi
    ui_end "$note"
}

# ─── Key 8 ───────────────────────────────────────────────────────────────────
stratum_latency() {
    _dgss_flow first
}

# The whole key-8 run for one node: gate, blocks prompt, probe, auto-save,
# report. "first" picks the node and ends in the sub-menu. "rerun" (sub-menu
# key R) reuses the node the sub-menu is already on and returns to its loop.
_dgss_flow() {   # first | rerun
    local mode=$1 pid dir net host port blocks="" report cap stamp
    _banner
    if [[ "$mode" == rerun ]]; then
        pid=$DGS_PID; dir=$DGS_DIR; net=$DGS_NET
        host=$DGS_API_HOST; port=$DGS_API_PORT
    else
        _pick_node || { pause; return 1; }
        IFS='|' read -r pid dir net host port <<< "${DG_NODES[$PICK]}"
    fi
    DGSS_RUN=""; DGSS_END=""; DGS_P=(); DGS_CT=(); DGS_CI=(); DGS_BIN=(); DGS_BL_FILE=""; DGS_SCREEN_FILE=""
    DGS_PROBE_STATUS=""; DGS_PSI_CPU60=""; DGS_STAMP=""
    echo ""
    echo -e "  ${DIM:-}Mining / stratum latency · $net · read-only · this host only${RESET:-}"
    dgs_probe_prepare "$pid" "$dir" "$net" "$host" "$port" || true

    if [[ "$DGS_PREP" != ok ]]; then
        DGSS_RUN=prep
    elif dgss_gate_screen; then
        ui_ask blocks "Blocks to measure (3, 5 or 10)" "5" || { info "Cancelled."; pause; return 0; }
        [[ "$blocks" == 3 || "$blocks" == 5 || "$blocks" == 10 ]] || blocks=5
        echo ""
        echo "  One extra stratum connection for about $blocks minutes (one block a minute on"
        echo "  average). Ctrl+C stops it and keeps the rows. It never submits a share."
        echo ""
        dgs_probe_run "$blocks" 200 1 600 1 || error "The probe did not finish (${DGS_PROBE_STATUS:-unknown}). ${DGS_PROBE_ERR:-}"
        DGSS_RUN=ran
    elif [[ "$DGSS_RUN" == refused || "$DGSS_RUN" == declined ]]; then
        echo ""
        ui_end "$DGSS_END"
        # dgss_menu clears the screen; the refusal must be read first.
        _dgss_pause
        [[ "$mode" == rerun ]] || dgss_menu
        return 0
    fi

    if [[ "$DGSS_RUN" == ran || "$DGS_PREP" == no_python || "$DGS_PREP" == no_curl ]]; then
        dgss_gather
    fi
    if [[ "$DGSS_RUN" == ran ]]; then
        dgs_report_stamp; stamp=$DGS_STAMP
        _ensure_report_dir || true
        dgs_baseline_save || true
    fi
    dgss_verdict
    _banner
    report=$(dgss_render "$stamp")
    _page <<< "$report"
    if [[ "$DGSS_RUN" == ran ]]; then
        cap="$DG_TMP/dgss_screen.cap"
        printf '%s\n' "$report" > "$cap" || error "Cannot write $cap"
        dgs_save_screen "$cap" || true
        _dgs_rm "$cap" || true
        case "${DGS_BL_STATUS:-}" in
            no_python|no_blocks|error) warn "No baseline was saved (${DGS_BL_STATUS}). Compare needs at least one measured block and python3." ;;
        esac
    fi
    _dgss_pause
    [[ "$mode" == rerun ]] || dgss_menu
    return 0
}

# ─── Sub-menu and its views ──────────────────────────────────────────────────
dgss_menu() {
    local c
    while true; do
        _banner
        echo ""
        echo -e "  ${DIM:-}Mining / stratum latency · $DGS_NET · pid $DGS_PID · nothing here changes the node${RESET:-}"
        echo ""
        echo -e "  ${GREEN}1${RESET})  Build log               ${DIM}where a template build spends its time (DEBUG)${RESET}"
        echo -e "  ${GREEN}2${RESET})  Rejects per hour        ${DIM}stale · low difficulty · invalid (node log)${RESET}"
        echo -e "  ${GREEN}3${RESET})  Thread CPU              ${DIM}10 s sample of every node thread${RESET}"
        echo -e "  ${YELLOW}4${RESET})  Stack capture           ${DIM}pauses the node briefly (asks first)${RESET}"
        echo -e "  ${CYAN}5${RESET})  Save baseline           ${DIM}keep this run for a before/after compare${RESET}"
        echo -e "  ${CYAN}R${RESET})  Run the probe again     ${DIM}same node, gate and blocks prompt, auto-saves${RESET}"
        echo -e "  ${CYAN}C${RESET})  Compare baselines       ${DIM}two saved runs, side by side${RESET}"
        echo ""
        echo -e "  ${DIM}0${RESET})  Back to Diagnostics"
        echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -ne "${BOLD}Select [1-5 R C / 0]: ${RESET}"
        read -r c || return 0
        case "${c,,}" in
            1) dgss_view_log      || true ;;
            2) dgss_view_rejects  || true ;;
            3) dgss_view_threads  || true ;;
            4) dgss_view_stack    || true ;;
            5) dgss_save_baseline || true ;;
            r) _dgss_flow rerun   || true ;;
            c) dgss_compare       || true ;;
            0) return 0 ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# Window choice shared by views 1 and 2. Sets DGSS_WIN_H and the window file.
_dgss_window() {
    local w lf
    [[ -n "$DGS_DIR" ]] || { error "No node was resolved."; return 1; }
    echo ""
    echo -e "  ${GREEN}1${RESET}) last hour   ${GREEN}2${RESET}) last 6 h   ${GREEN}3${RESET}) last 24 h"
    ui_ask w "Window" "2" || { info "Cancelled."; return 1; }
    case "$w" in 1) DGSS_WIN_H=1 ;; 2) DGSS_WIN_H=6 ;; 3) DGSS_WIN_H=24 ;; *) warn "Invalid choice."; return 1 ;; esac
    lf=$(dg_node_logfile "$DGS_DIR")
    [[ -f "$lf" ]] || { error "Log file not found: $lf"; return 1; }
    DGSS_WF="$DG_TMP/dgss_win"
    info "Reading $lf ..."
    dgs_log_window_file "$DGS_DIR" "$DGSS_WIN_H" "$DGSS_WF" || return 1
    return 0
}

dgss_view_log() {
    local report
    _dgss_window || { _dgss_pause; return 1; }
    [[ -n "$DGS_TOML" ]] || DGS_TOML="$DGS_DIR/grin-server.toml"
    [[ -n "$DGS_LOG_LEVEL" ]] || DGS_LOG_LEVEL=$(dg_tv "$DGS_TOML" file_log_level)
    dgs_build_log "$DGSS_WF" "$DGS_TOML" || { _dgss_pause; return 1; }
    _banner
    report=$(
        echo -e "  ${DIM:-}Build log · $DGS_NET · times are host local time, as in the log${RESET:-}"
        _dgss_build_section "$DGSS_WIN_H"
        ui_end "build log · $DGS_NET · ${DGSS_WIN_H} h"
    )
    _page <<< "$report"
    _dgss_pause
}

dgss_view_rejects() {
    local report i
    _dgss_window || { _dgss_pause; return 1; }
    dgs_rejects "$DGSS_WF" "$DGSS_WIN_H" || { _dgss_pause; return 1; }
    _banner
    report=$(
        echo -e "  ${DIM:-}Node rejects · $DGS_NET · hours are host local time, as in the log${RESET:-}"
        _dgss_rej_section "$DGSS_WIN_H"
        if [[ -s "$DG_TMP/dgs_rej.hourly" ]]; then
            echo ""
            printf '  %-17s %7s %9s %8s %9s\n' hour stale low-diff invalid accepted
            while IFS=$'\t' read -r h s l v vs a; do
                printf '  %-17s %7s %9s %8s %9s\n' "$h" "$s" "$l" "$(( v + vs ))" "$a"
            done < "$DG_TMP/dgs_rej.hourly"
        fi
        echo ""
        echo -e "  ${BOLD:-}Last 5 reject lines${RESET:-} ${DIM:-}(IPs masked, long tokens removed)${RESET:-}"
        # Milliseconds, level, module path, "(Server ID: 0)", edge_bits and
        # nonce are dropped first: cut at 76 columns, they would leave no room
        # for the reject reason itself.
        grep -aiE 'submitted too late|rejected due to low difficulty|failed to validate (solution|share)' \
            "$DGSS_WF" 2>/dev/null | tail -5 \
            | sed -E 's/^([0-9]{8} [0-9:]+)[.0-9]* [A-Z]+ [^ ]+ - (\(Server ID: [0-9]+\) )?/\1 /;
                      s/, edge_bits [0-9]+, nonce [0-9]+//' \
            | dg_maskip | dg_redact | cut -c1-76 | sed 's/^/  /'
        ui_end "rejects · $DGS_NET · ${DGSS_WIN_H} h"
    )
    _page <<< "$report"
    _dgss_pause
}

dgss_view_threads() {
    local report tid comm pct nw st
    if [[ -z "$DGS_PID" ]]; then error "No node was resolved."; _dgss_pause; return 1; fi
    info "Sampling /proc for 10 s..."
    if ! dgs_threads "$DGS_PID" "$DGS_DIR" 10 now; then
        error "Thread sample failed (${DGS_C[status]:-error})."; _dgss_pause; return 1
    fi
    _banner
    report=$(
        echo -e "  ${DIM:-}Thread CPU · $DGS_NET · pid $DGS_PID · 10 s, not aligned to a new block${RESET:-}"
        echo ""
        printf '  %-8s %-17s %8s  %s\n' tid thread "CPU %" ""
        while IFS=$'\t' read -r tid comm pct nw st; do
            printf '  %-8s %-17s %8s  %s\n' "$tid" "$comm" "$pct" "$([[ "$nw" == - ]] || echo "$nw")"
        done < <(_dgss_tsv "$DG_TMP/dgs_cpu_now.top")
        printf '  host steal %s %% · iowait %s %% · process total %s %%\n' \
            "${DGS_C[steal_pct]:-?}" "${DGS_C[iowait_pct]:-?}" "${DGS_C[proc_pct]:-?}"
        echo ""
        _dgss_hint "The stratum_server thread should sit near idle between blocks and run hot only while a template is built. The probe (run key 8 again) samples across a new block, which is the comparison that matters."
        ui_end "thread CPU · nothing was changed"
    )
    _page <<< "$report"
    _dgss_pause
}

dgss_view_stack() {
    local report i f ok=0 st
    if [[ -z "$DGS_PID" ]]; then error "No node was resolved."; _dgss_pause; return 1; fi
    echo ""
    dgs_stack_capture "$DGS_PID" "$DGS_DIR" "$DGS_NET" "$DGS_API_HOST" "$DGS_API_PORT" || true
    st=${DGS_K[status]:-error}
    _banner
    report=$(
        echo -e "  ${DIM:-}Stack capture · $DGS_NET · pid $DGS_PID${RESET:-}"
        echo ""
        case "$st" in
            ok|no_symbols)
                if [[ "$st" == ok ]]; then
                    _dgss_find OK "Captured ${DGS_K[captures_ok]:-0} of ${DGS_K[captures_planned]:-?} with ${DGS_K[tool]:-?}" "" \
                        "trigger: ${DGS_K[trigger]:-?} at ${DGS_K[trigger_at]:-?}" ""
                else
                    _dgss_find WARN "Captured, but no symbols" upstream \
                        "every frame is an address: this binary was stripped" \
                        "A capture of unnamed frames is not a result. Build from source with symbols kept (Script 01 key G), or install the debug symbols, then capture again."
                fi
                for (( i = 1; i <= 3; i++ )); do
                    f="$DG_TMP/dgs_stack.$i.thread"
                    [[ -s "$f" ]] || continue
                    echo ""
                    echo "  capture $i · ${DGS_K[at_$i]:-?} UTC · ${DGS_K[ms_$i]:-?} ms · stratum_server frames"
                    head -8 "$f" | cut -c1-76 | sed 's/^/    /'
                done ;;
            declined)
                echo "  Not captured. Nothing was changed." ;;
            no_clients)
                _dgss_find INFO "No stratum client is connected" "" "the stratum thread is idle, so a capture would show nothing" \
                    "Connect a miner, or run the probe (key 8) and capture while it is connected." ;;
            no_tool)
                _dgss_find INFO "No stack tool is installed" host "eu-stack, gdb and perf are all missing" \
                    "Install elfutils and gdb (apt-get install elfutils gdb, or dnf), then capture again." ;;
            no_stratum_thread)
                _dgss_find WARN "No thread named stratum_server" config "pid $DGS_PID has no stratum thread" \
                    "Stratum is probably off, or the node has not restarted since it was turned on." ;;
            pre_stopped)
                _dgss_find WARN "The node is already stopped or traced" host "tracer pid: ${DGS_K[post_tracers]:-none}" \
                    "Not captured and no signal sent. Check: grep State /proc/$DGS_PID/status" ;;
            attach_failed)
                _dgss_find WARN "The debugger could not attach" host \
                    "kernel.yama.ptrace_scope = ${DGS_K[ptrace_scope]:-?} · container: ${DGS_K[container]:-?}" \
                    "ptrace_scope 3 blocks every attach until reboot; inside a container the CAP_SYS_PTRACE capability is missing. ${DGS_K[err_tail]:-}" ;;
            interrupted)
                echo "  Stopped with Ctrl+C before a capture finished." ;;
            no_trigger)
                _dgss_find INFO "No new block arrived in 3 minutes" network "nothing to trigger a capture on" \
                    "Run it again; blocks arrive about a minute apart on average." ;;
            pid_mismatch)
                _dgss_find WARN "Cannot tell which grin process is this node" toolkit "pid $DGS_PID is not the only grin for $DGS_DIR" "" ;;
            *)
                _dgss_find WARN "The capture failed ($st)" host "${DGS_K[err_tail]:-see the messages above}" \
                    "The tool's own error text is above; nothing was left running." ;;
        esac
        if [[ "${DGS_K[cont]:-0}" == 1 ]]; then
            echo ""
            echo "  A capture left the node stopped, so one SIGCONT was sent (post: ${DGS_K[post]:-?})."
        fi
        if [[ -n "${DGS_K[file]:-}" ]]; then
            echo ""
            echo "  Saved  ${DGS_K[file]}"
            _dgss_hint "The file holds binary paths and memory addresses, and plain backtraces with no variable values. Read it before sharing it."
        fi
        ui_end "stack capture · $st"
    )
    _page <<< "$report"
    _dgss_pause
}

dgss_save_baseline() {
    if [[ -n "${DGS_BL_FILE:-}" ]]; then
        info "This run is already saved: $DGS_BL_FILE"
        _dgss_pause; return 0
    fi
    [[ -n "$DGS_STAMP" ]] || dgs_report_stamp
    DGS_B[window_h]=${DGSS_WIN_H}
    if dgs_baseline_save; then
        success "Saved $DGS_BL_FILE"
    else
        case "${DGS_BL_STATUS:-}" in
            no_python) warn "python3 is needed to write a baseline." ;;
            no_probe)  warn "No probe ran in this session. Run key 8 first." ;;
            no_blocks) warn "That run measured no block, so there is nothing to keep." ;;
            *)         warn "The baseline was not saved." ;;
        esac
    fi
    _dgss_pause
}

dgss_compare() {
    local sel_a sel_b fa fb report ln k v i=0
    local -a files=()
    if [[ "$DGS_NET" != mainnet && "$DGS_NET" != testnet ]]; then error "No node was resolved."; _dgss_pause; return 1; fi
    dgs_baseline_list "$DGS_NET" "${DGS_BIN[sha256]:-}" || { _dgss_pause; return 1; }
    if (( DGS_BL_COUNT < 2 )); then
        echo ""
        info "$DGS_BL_COUNT saved baseline(s) for $DGS_NET; a compare needs two."
        echo -e "  ${DIM:-}Run key 8 on each binary you want to compare; every run saves one.${RESET:-}"
        _dgss_pause; return 0
    fi
    echo ""
    printf '  %-3s %-17s %-24s %-13s %8s %3s\n' "#" "measured (UTC)" "binary" "sha" "p95" "n"
    while IFS=$'\t' read -r f at ua sha p95 n prov pm at2 full; do
        i=$(( i + 1 )); files+=("$f")
        printf '  %-3s %-17s %-24s %-13s %8s %3s\n' "$i" "${at:0:10} ${at:11:5}" "${ua:0:24}" "$sha" \
            "$([[ "$p95" == - ]] && echo - || _dgss_fmt "$p95" 2)" "$n"
    done < <(_dgss_tsv "$DG_TMP/dgs_bl.tsv")
    echo ""
    local da=1 db=2 j=0
    for f in "${files[@]}"; do
        j=$(( j + 1 ))
        [[ "$f" == "$DGS_BL_DEFAULT_A" ]] && da=$j
        [[ -n "$DGS_BL_DEFAULT_B" && "$f" == "$DGS_BL_DEFAULT_B" ]] && db=$j
    done
    [[ "$da" == "$db" ]] && db=$(( da == 1 ? 2 : 1 ))
    # The list is newest first, so the lower number is the later run. The
    # default pair is ordered in time (older = A = before), so Δ = B − A
    # reads as "what the later binary changed", as in the A/B runbook.
    if (( da < db )); then j=$da; da=$db; db=$j; fi
    echo -e "  ${DIM:-}A = before, B = after. Default: this binary vs another, in time order.${RESET:-}"
    ui_ask sel_a "A (before)" "$da" || { info "Cancelled."; _dgss_pause; return 0; }
    ui_ask sel_b "B (after)" "$db" || { info "Cancelled."; _dgss_pause; return 0; }
    [[ "$sel_a" =~ ^[0-9]+$ && "$sel_b" =~ ^[0-9]+$ ]] && (( sel_a >= 1 && sel_a <= ${#files[@]} && sel_b >= 1 && sel_b <= ${#files[@]} )) \
        || { warn "Invalid choice."; _dgss_pause; return 0; }
    fa=${files[$((sel_a - 1))]}; fb=${files[$((sel_b - 1))]}
    dgs_baseline_compare "$fa" "$fb" || { _dgss_pause; return 1; }
    _banner
    report=$(
        echo -e "  ${DIM:-}Compare · $DGS_NET · Δ = B − A${RESET:-}"
        echo ""
        for k in a b; do
            printf '  %s  %s · %s · sha %s · n %s\n' "${k^^}" "$(printf "%s" "${DGS_CMP[${k}_at]:0:16}" | tr T " ") UTC" "${DGS_CMP[${k}_user_agent]:-?}" \
                "${DGS_CMP[${k}_sha12]:-?}" "${DGS_CMP[${k}_n]:-?}"
            printf '     %s\n' "$(_dgss_prov_text "${DGS_CMP[${k}_provenance]:-}" "${DGS_CMP[${k}_source_ref]:-}" "")"
        done
        echo ""
        printf '  %-18s %10s %10s %10s\n' metric A B Δ
        while IFS=$'\t' read -r k a b d mark; do
            printf '  %-18s %10s %10s %10s  %s\n' "$k" "$a" "$b" "$d" "${mark:+(config differs)}"
        done < "$DG_TMP/dgs_cmp.tsv"
        echo ""
        if [[ "${DGS_CMP[same_sha]:-0}" == 1 && "${DGS_CMP[noise]:-0}" == 1 ]]; then
            _dgss_find WARN "Same binary, very different numbers" host "A and B ran the same sha" \
                "Host noise likely: repeat both runs before drawing a conclusion."
        elif [[ "${DGS_CMP[same_sha]:-0}" == 1 ]]; then
            echo "  Both runs are the same binary."
        fi
        if [[ -n "${DGS_CMP[config_diff]:-}" ]]; then
            _dgss_hint "Marked rows are not comparable: ${DGS_CMP[config_diff]} differs between the two runs."
        fi
        ui_end "compare · nothing was changed"
    )
    _page <<< "$report"
    _dgss_pause
}

# ─── Quick check (key 1) ─────────────────────────────────────────────────────
# Reads the newest saved baseline of the RUNNING binary. It never runs a probe:
# one block takes about a minute and key 1 is a 30 s check.
dgs_quick_finding() {   # <pid> <dir> <net>
    local pid=$1 dir=$2 net=$3 area="Node $3" n p95 when origin why prov obs
    [[ "$(dg_tv "$dir/grin-server.toml" enable_stratum_server)" == true ]] || return 0
    dgs_quick_baseline "$net" "$pid" || return 0
    case "${DGS_QB[status]:-}" in
        no_python)
            dg_add INFO "$area" host "python3 missing: template latency not checked" \
                "the saved key 8 runs are JSON, read with python3" \
                "Install python3 (apt-get install python3 / dnf install python3)." ;;
        none)
            dg_add INFO "$area" toolkit "Template latency not measured for this binary" \
                "no saved Mining / stratum latency run matches the running node binary" \
                "Run Diagnostics key 8 (Mining / stratum latency)." ;;
        found)
            n=$(_dg_num "${DGS_QB[n]:-0}"); p95=${DGS_QB[p95_s]:-}
            when=${DGS_QB[at]:-}; when="${when:0:10} ${when:11:5} UTC"
            prov=$(_dgss_prov_text "${DGS_QB[provenance]:-}" "${DGS_QB[source_ref]:-}" "")
            obs="$n blocks, measured $when, binary ${DGS_QB[user_agent]:-?}${prov:+ ($prov)}"
            if (( n < 3 )) || [[ -z "$p95" ]]; then
                dg_add INFO "$area" toolkit "Template latency: only $n blocks measured; run key 8 again" "$obs" ""
            elif _dgss_gt "$p95" 2; then
                IFS='|' read -r origin why <<< "$(_dgss_lean "${DGS_QB[steal_pct]:-}" "${DGS_QB[psi_cpu_avg60]:-}")"
                dg_add WARN "$area" "$origin" "Stratum template latency p95 $(_dgss_fmt "$p95") s" "$obs" \
                    "Origins are pattern-based leans, not a diagnosis. $why Run Diagnostics key 8 for the per-block list, thread CPU and a before/after compare."
            else
                dg_add OK "$area" upstream "Stratum template latency p95 $(_dgss_fmt "$p95") s" "$obs" ""
            fi ;;
    esac
    return 0
}

# ─── Support bundle (key 2) ──────────────────────────────────────────────────
# 11_stratum_<net>.txt for one node. No live probe (it would add minutes). The
# caller pipes this through dg_redact, which removes any 20+ character token:
# labels are prose, not identifiers, and the file prints the 12-hex short sha.
dgs_bundle_file() {   # <pid> <dir> <net>
    local pid=$1 dir=$2 net=$3 lf ua prov
    dg_sec "STRATUM LATENCY $net (086 design §10)"
    DGS_DIR=$dir; DGS_PID=$pid; DGS_NET=$net
    dg_sub "stratum settings"
    dgs_stratum_config "$dir" "$net" || true
    echo "enabled              : ${DGS_ENABLED:-not set}"
    echo "address              : ${DGS_ADDR:-not set}  (config: $DGS_CFG)"
    echo "attempt time (s)     : $DGS_ATTEMPT"
    echo "log level            : ${DGS_LOG_LEVEL:-not set}"
    echo "wallet listener      : ${DGS_WALLET_URL:-not set}   burn reward: ${DGS_BURN:-not set}"
    if [[ "$DGS_CFG" != ok ]]; then
        echo "stratum is not usable on this node ($DGS_CFG): nothing more to report."
        return 0
    fi
    dg_sub "binary"
    dgs_binary_fingerprint "$pid" "$dir" || true
    dgs_quick_baseline "$net" "$pid" || true
    ua=${DGS_QB[user_agent]:-"(not known: no saved run for this binary)"}
    prov=$(_dgss_prov_text "${DGS_BIN[provenance]:-}" "${DGS_BIN[source_ref]:-}" "${DGS_BIN[commit]:-}")
    echo "sha (12 hex)         : ${DGS_BIN[sha12]:-?}"
    echo "user agent           : $ua"
    echo "install record       : ${prov:-unknown} (artifact check: ${DGS_BIN[artifact_check]:-?})"
    lf=$(dg_node_logfile "$dir")
    DGS_B=(); DGS_R=(); DGS_C=(); DGS_CT=(); DGS_CI=()
    if [[ -f "$lf" ]] && dgs_log_window_file "$dir" 24 "$DG_TMP/dgs_bwin"; then
        dg_sub "build log, 24 h"
        dgs_build_log "$DG_TMP/dgs_bwin" "$DGS_TOML" || true
        _dgss_build_section 24 | sed -e 's/\x1b\[[0-9;]*m//g'
        dg_sub "node rejects, 24 h"
        dgs_rejects "$DG_TMP/dgs_bwin" 24 || true
        _dgss_rej_section 24 | sed -e 's/\x1b\[[0-9;]*m//g'
    else
        echo "node log not found: $lf"
    fi
    dg_sub "threads (one 10 s sample, not aligned to a block)"
    if dgs_threads "$pid" "$dir" 10 now; then
        _dgss_thread_section DGS_C "10 s, not aligned to a block" now | sed -e 's/\x1b\[[0-9;]*m//g'
    else
        echo "thread sample failed (${DGS_C[status]:-error})"
    fi
    dg_sub "newest saved probe"
    if dgs_baseline_list "$net" "${DGS_BIN[sha256]:-}" && (( DGS_BL_COUNT > 0 )); then
        awk -F'\t' 'NR == 1 { printf "measured %s %s UTC · %s · sha %s · p95 %s s · %s blocks · %s\n", \
            substr($2, 1, 10), substr($2, 12, 5), $3, $4, ($5 == "" ? "-" : $5), $6, $7 }' "$DG_TMP/dgs_bl.tsv"
        echo "(the full record stays in the local .json baseline, not in this bundle)"
    else
        echo "no saved probe: run Diagnostics key 8"
    fi
    return 0
}
