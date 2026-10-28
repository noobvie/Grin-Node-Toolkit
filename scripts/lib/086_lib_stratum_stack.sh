# =============================================================================
# lib/086_lib_stratum_stack.sh — stack capture of the node's stratum thread (§10.6)
# =============================================================================
# Sourced by 086_grin_diagnostics.sh after 086_lib_stratum.sh, which it
# depends on (dgs_* state, _dgs_rm, _dgs_report_dir, _dgs_install_private,
# the shared DGS_K array). Sourced, not executed — no shebang, no `set -e`.
# =============================================================================

[[ -n "${_DGS_STACK_LOADED:-}" ]] && return 0
_DGS_STACK_LOADED=1

if [[ -z "${_DGS_LIB_LOADED:-}" ]]; then
    # shellcheck source=086_lib_stratum.sh
    source "$(dirname "${BASH_SOURCE[0]}")/086_lib_stratum.sh"
fi

# The stratum thread's LWP(s): grin names it `stratum_server` (15-char comm).
dgs_stratum_lwp() {   # <pid>
    local t c
    for t in "$_DGS_PROC/$1/task"/[0-9]*; do
        { IFS= read -r c < "$t/comm"; } 2>/dev/null || continue
        [[ "$c" == stratum_server ]] && printf '%s\n' "${t##*/}"
    done
    return 0
}

# ─── §10.6  Stack capture ────────────────────────────────────────────────────
# ptrace stops every thread of the node while a tool is attached, so this asks
# first (default No) and says how many pauses it makes. Each tool runs under
# `timeout -s KILL 30` in its own session, out of reach of the terminal's
# Ctrl+C; a tracer killed between attach and detach can leave the node in
# state T, so every capture is followed by dgs_stack_postcheck, which sends at
# most ONE SIGCONT per capture run (operator decision, design §10.9).

# [y/N]: only an explicit y accepts; Enter and EOF decline.
_dgs_no() {   # <prompt>
    local a=""
    printf '%b' "${BOLD:-}$1 [y/N]: ${RESET:-}"
    if ! read -r a; then echo ""; return 1; fi
    [[ "${a,,}" == y || "${a,,}" == yes ]]
}

_dgs_ms() {   # epoch milliseconds (GNU date %N)
    local n
    n=$(date +%s%N 2>/dev/null)
    [[ "$n" =~ ^[0-9]+$ ]] || n="$(date +%s)000000000"
    printf '%s' $(( n / 1000000 ))
}

_dgs_sleep_until() {   # <epoch-ms>
    local d
    d=$(( $1 - $(_dgs_ms) ))
    (( d > 0 )) || return 0
    sleep "$(( d / 1000 )).$(printf '%03d' $(( d % 1000 )))"
}

# Thread states of <pid>: DGS_PS_THREADS, DGS_PS_STOPPED (untraced threads in
# T or t), DGS_PS_TRACED (threads with a TracerPid) and DGS_PS_TRACERS.
# rc 1 when the process is gone.
DGS_PS_THREADS=0; DGS_PS_STOPPED=0; DGS_PS_TRACED=0; DGS_PS_TRACERS=""
dgs_proc_state() {   # <pid>
    local pid=$1 t st rest tr
    [[ -d "$_DGS_PROC/$pid/task" ]] || return 1
    DGS_PS_THREADS=0; DGS_PS_STOPPED=0; DGS_PS_TRACED=0; DGS_PS_TRACERS=""
    for t in "$_DGS_PROC/$pid/task"/[0-9]*; do
        { IFS= read -r st < "$t/stat"; } 2>/dev/null || continue
        rest=${st##*) }
        tr=$(awk '$1 == "TracerPid:" { print $2; exit }' "$t/status" 2>/dev/null)
        tr=$(_dg_num "$tr")
        DGS_PS_THREADS=$(( DGS_PS_THREADS + 1 ))
        if (( tr != 0 )); then
            DGS_PS_TRACED=$(( DGS_PS_TRACED + 1 ))
            [[ " $DGS_PS_TRACERS " == *" $tr "* ]] || DGS_PS_TRACERS="${DGS_PS_TRACERS:+$DGS_PS_TRACERS }$tr"
        else
            case "${rest%% *}" in T|t) DGS_PS_STOPPED=$(( DGS_PS_STOPPED + 1 )) ;; esac
        fi
    done
    return 0
}

# Run after every capture. A node left stopped with no tracer gets exactly one
# SIGCONT per capture run, and only while <pid> is still the one exe-matched
# grin for <dir>. Sets DGS_K[post] running|resumed|stopped|traced|gone and
# DGS_K[cont]=1 when it sent the signal. rc 1 when the node is still stopped.
dgs_stack_postcheck() {   # <pid> <dir>
    local pid=$1 dir=$2 i
    # The kernel detaches a tracer that exits; give a killed one a moment.
    for (( i = 0; i < 5; i++ )); do
        dgs_proc_state "$pid" || { DGS_K[post]=gone; return 0; }
        (( DGS_PS_TRACED == 0 )) && break
        sleep 0.2
    done
    DGS_K[post_stopped]=$DGS_PS_STOPPED; DGS_K[post_tracers]=$DGS_PS_TRACERS
    if (( DGS_PS_TRACED > 0 )); then
        DGS_K[post]=traced
        warn "grin pid $pid is still traced by pid $DGS_PS_TRACERS. No signal sent."
        return 1
    fi
    if (( DGS_PS_STOPPED == 0 )); then
        DGS_K[post]=running
        return 0
    fi
    if (( _DGS_CONT_SENT == 1 )); then
        DGS_K[post]=stopped
        error "grin pid $pid is still stopped after one SIGCONT. Check: grep State /proc/$pid/status"
        return 1
    fi
    if ! dgs_check_pid "$pid" "$dir"; then
        DGS_K[post]=stopped
        error "pid $pid is stopped but is no longer the only grin for $dir. No signal sent."
        return 1
    fi
    if ! kill -CONT "$pid"; then
        DGS_K[post]=stopped
        error "Could not send SIGCONT to grin pid $pid. Run: kill -CONT $pid"
        return 1
    fi
    _DGS_CONT_SENT=1; DGS_K[cont]=1
    warn "The capture left grin pid $pid stopped ($DGS_PS_STOPPED threads in state T). Sent one SIGCONT."
    log "[086] stack capture left grin pid $pid stopped ($DGS_PS_STOPPED threads); sent one SIGCONT"
    sleep 0.2
    if dgs_proc_state "$pid" && (( DGS_PS_STOPPED > 0 )); then
        DGS_K[post]=stopped
        error "grin pid $pid is still stopped after the SIGCONT. Check: grep State /proc/$pid/status"
        return 1
    fi
    DGS_K[post]=resumed
    return 0
}

# For 086's EXIT path: re-checks the node only when a capture was in progress.
dgs_stack_cleanup() {
    (( _DGS_STACK_ACTIVE == 1 )) || return 0
    _DGS_STACK_ACTIVE=0
    dgs_stack_postcheck "${DGS_K[pid]:-0}" "${DGS_K[dir]:-}" || true
    return 0
}

_dgs_stack_tool() {   # eu-stack, then gdb, then perf
    if dg_have eu-stack; then echo eu-stack
    elif dg_have gdb; then echo gdb
    elif dg_have perf; then echo perf
    fi
    return 0
}

# Offers elfutils + gdb from the distro package manager, default No. The
# package manager's own output and errors go to the terminal.
dgs_stack_offer_install() {
    local -a cmd
    if dg_have apt-get; then cmd=(apt-get install -y elfutils gdb)
    elif dg_have dnf; then cmd=(dnf install -y elfutils gdb)
    else
        DGS_K[install]=no_pm
        warn "No stack tool, and neither apt-get nor dnf to install one."
        return 1
    fi
    echo ""
    echo "  No stack tool is installed (eu-stack from elfutils, or gdb)."
    echo "  Installing them runs:  ${cmd[*]}"
    if ! _dgs_no "  Install elfutils and gdb now?"; then
        DGS_K[install]=declined
        return 1
    fi
    log "[086] installing stack tools: ${cmd[*]}"
    if ! "${cmd[@]}"; then
        DGS_K[install]=failed
        error "Install failed (${cmd[*]}). On apt, an old package list is the usual cause: apt-get update."
        return 1
    fi
    DGS_K[install]=done
    return 0
}

# The ask-first prompt. It names the pid and the number of pauses.
dgs_stack_prompt() {   # <pid> <tool> <captures> <trigger log|tip>
    local pid=$1 tool=$2 n=$3 trig=$4 what
    what="a new block (the node's tip changes)"
    [[ "$trig" == log ]] && what="a fresh \"resend updated block\" log line"
    echo ""
    if [[ "$tool" == perf ]]; then
        echo "  perf samples the stratum thread of grin pid $pid for 3 s, about 1 s"
        echo "  after $what. perf does not stop the node."
    else
        echo "  A stack capture attaches $tool to grin pid $pid with ptrace. That STOPS"
        echo "  every thread of the node while it runs: a fraction of a second for"
        echo "  eu-stack, several seconds for gdb while it loads symbols. Mining, P2P"
        echo "  and the API all wait during each pause."
        echo "  This run makes $n pauses, 2 s apart, starting about 1 s after"
        echo "  $what."
    fi
    echo "  The saved file holds binary paths and memory addresses. Read it before"
    echo "  you share it."
    _dgs_no "  Capture now?"
}

# rc 0 = a fresh `resend updated block` line within <secs> · 1 none · 2 Ctrl+C.
# The grep runs as a background job so a Ctrl+C trap fires at once instead of
# after the timeout.
_dgs_wait_log_resend() {   # <logfile> <secs>
    local lf=$1 secs=$2 tp gp rc fd
    exec {fd}< <(exec tail -n 0 -F -- "$lf" 2>> "$DG_TMP/dgs_stack.tail.err") \
        || { error "Cannot follow $lf"; return 1; }
    tp=$!
    timeout "$secs" grep -m 1 -F 'resend updated block' <&"$fd" > /dev/null &
    gp=$!
    while :; do
        wait "$gp"; rc=$?
        kill -0 "$gp" 2>/dev/null || break
        if [[ -n "$_DGS_STACK_INT" ]]; then
            kill "$gp" 2>/dev/null; wait "$gp" 2>/dev/null
            break
        fi
    done
    exec {fd}<&-
    kill "$tp" 2>/dev/null || true
    [[ -n "$_DGS_STACK_INT" ]] && return 2
    (( rc == 0 )) && return 0
    return 1
}

# rc 0 = last_block_pushed changed within <secs> · 1 no change · 2 Ctrl+C.
# Owner get_status through dg_rpc, so the secret travels on curl's stdin.
_dgs_wait_tip() {   # <owner-url> <secret-file> <secs>
    local url=$1 sf=$2 secs=$3 secret base="" cur end
    secret=$(dg_read_secret "$sf")
    end=$(( SECONDS + secs ))
    while (( SECONDS < end )); do
        [[ -n "$_DGS_STACK_INT" ]] && return 2
        dg_rpc "$url" "$secret" get_status '[]' 2 > /dev/null
        cur=$(sed -n 's/.*"last_block_pushed"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F]*\)".*/\1/p' "$DG_TMP/body" 2>/dev/null | head -1)
        if [[ -n "$cur" ]]; then
            if [[ -z "$base" ]]; then
                base=$cur
            elif [[ "$cur" != "$base" ]]; then
                return 0
            fi
        fi
        sleep 0.5
    done
    [[ -n "$_DGS_STACK_INT" ]] && return 2
    return 1
}

# One tool run; returns the tool's rc (137 = killed at 30 s). stdout and
# stderr go to separate files, both kept. stdin is /dev/null so a tool never
# waits on the terminal.
_dgs_stack_run() {   # <tool> <pid> <lwp> <out> <err>
    local tool=$1 pid=$2 lwp=$3 out=$4 err=$5 rc pd="$DG_TMP/dgs_stack.perf.data"
    local -a pre=(timeout -s KILL 30)
    # Without --wait, setsid returns at once when its caller leads a group.
    if setsid --help 2>&1 | grep -q -- '--wait'; then pre=(setsid -w timeout -s KILL 30); fi
    case "$tool" in
        eu-stack) "${pre[@]}" eu-stack -p "$pid" < /dev/null > "$out" 2> "$err"; rc=$? ;;
        gdb)      "${pre[@]}" gdb -nx -p "$pid" -batch -ex 'thread apply all bt' < /dev/null > "$out" 2> "$err"; rc=$? ;;
        perf)
            "${pre[@]}" perf record -t "$lwp" -g -o "$pd" -- sleep 3 < /dev/null > "$out" 2> "$err"; rc=$?
            if (( rc == 0 )); then
                "${pre[@]}" perf report --stdio -i "$pd" < /dev/null > "$out" 2>> "$err"; rc=$?
            fi
            _dgs_rm "$pd" "$pd.old" || true
            ;;
        *) error "Unknown stack tool $tool"; return 1 ;;
    esac
    return "$rc"
}

# Keeps the stratum thread's frames. Header formats (UNVERIFIED on a real box,
# design §10.6):
#   eu-stack  "TID <lwp>:" then "#N  0x… name" lines, up to the next TID/PID
#   gdb       "Thread N (Thread 0x… (LWP <lwp>) "name"):" then "#N …" lines,
#             up to a blank line, the next Thread header or "[Inferior …"
#   perf      recorded with -t <lwp>, so the whole report is that thread;
#             comment and blank lines dropped, first 60 lines kept
dgs_stack_extract() {   # <tool> <lwp> <in> <out>
    local tool=$1 lwp=$2 in=$3 out=$4
    [[ -r "$in" ]] || { : > "$out" || { error "Cannot write $out"; return 1; }; return 0; }
    case "$tool" in
        eu-stack)
            awk -v lwp="$lwp" '
                /^TID [0-9]+:/ { split($2, a, ":"); on = (a[1] == lwp) }
                /^PID [0-9]+/  { on = 0 }
                on { print }' "$in" > "$out" || { error "Cannot write $out"; return 1; } ;;
        gdb)
            awk -v lwp="$lwp" '
                /^Thread [0-9]+ / { on = (index($0, "(LWP " lwp ")") > 0) }
                /^\[Inferior / || /^[[:space:]]*$/ { on = 0 }
                on { print }' "$in" > "$out" || { error "Cannot write $out"; return 1; } ;;
        perf)
            awk '!/^#/ && !/^[[:space:]]*$/ { print; if (++n >= 60) exit }' "$in" > "$out" \
                || { error "Cannot write $out"; return 1; } ;;
        *) error "Unknown stack tool $tool"; return 1 ;;
    esac
    return 0
}

# "<frames> <named>" for an extracted thread: a frame is named when a symbol
# follows its address. A capture of only unnamed frames means "no symbols".
_dgs_stack_syms() {   # <thread-file>
    awk '/^#[0-9]+ / { n++; s = $0
                       sub(/^#[0-9]+ +/, "", s); sub(/^0x[0-9a-fA-F]+ */, "", s)
                       sub(/^- 1 +/, "", s); sub(/^in +/, "", s)
                       if (s ~ /^[A-Za-z_<]/) k++ }
         END { printf "%d %d\n", n, k }' "$1" 2>/dev/null || echo "0 0"
}

_dgs_container() {
    local v=""
    if dg_have systemd-detect-virt; then v=$(systemd-detect-virt -c 2>/dev/null || true); fi
    if [[ -z "$v" || "$v" == none ]] && [[ -e /.dockerenv || -e /run/.containerenv ]]; then v=container; fi
    printf '%s' "${v:-none}"
}

# The whole capture: checks, ask, trigger, captures, post-checks, report.
#   [confirmed]  1 = the caller already asked (the prompt is skipped)
# Result: DGS_K and $DG_TMP/dgs_stack.<i>.thread (the stratum thread's frames
# of capture i, for the screen). DGS_K keys:
#   status   ok | no_symbols | attach_failed | failed | interrupted |
#            pid_mismatch | no_stratum_thread | no_clients | pre_stopped |
#            no_tool | declined | no_trigger | error
#   pid dir net lwp tool trigger(log|tip) trigger_at clients captures_planned
#   captures_ok, per capture i: at_i rc_i ms_i frames_i named_i
#   cont (1 = one SIGCONT sent) post (dgs_stack_postcheck) stop_after (the
#   capture after which the node was found stopped; no capture follows it)
#   timed_out
#   attach_failed ptrace_scope container err_tail install file
# The report file is $REPORT_DIR/stratum_stack_<net>_<UTC stamp>.txt, mode 600.
dgs_stack_capture() {   # <pid> <dir> <net> <api-host> <api-port> [confirmed]
    local pid=$1 dir=$2 net=$3 ahost=$4 aport=$5 confirmed=${6:-0}
    local toml="$2/grin-server.toml" lwp tool n=3 trig lf sp addr port others
    local i t0 ts rc frames named okc=0 failc=0 nosym=0 old_int old_term rep body lvl
    DGS_K=(); _DGS_CONT_SENT=0; _DGS_STACK_INT=""
    DGS_K[pid]=$pid; DGS_K[dir]=$dir; DGS_K[net]=$net; DGS_K[cont]=0
    _dgs_need_tmp || { DGS_K[status]=error; return 1; }
    if ! dgs_check_pid "$pid" "$dir"; then DGS_K[status]=pid_mismatch; return 1; fi
    lwp=$(dgs_stratum_lwp "$pid" | head -1)
    if [[ -z "$lwp" ]]; then DGS_K[status]=no_stratum_thread; return 1; fi
    DGS_K[lwp]=$lwp

    # Builds run only while a stratum client is connected (§10.2.4). With none,
    # the thread is idle and a capture would pause the node for nothing.
    addr=$(dg_tv "$toml" stratum_server_addr); port=${addr##*:}
    if [[ "$port" =~ ^[0-9]+$ ]] && dg_have ss; then
        others=$(ss -tn state established "( sport = :$port )" 2>/dev/null | tail -n +2 | wc -l)
        others=$(_dg_num "${others// /}")
        DGS_K[clients]=$others
        if (( others == 0 )); then DGS_K[status]=no_clients; return 1; fi
    fi

    tool=$(_dgs_stack_tool)
    if [[ "$tool" != eu-stack && "$tool" != gdb ]]; then
        if dgs_stack_offer_install; then tool=$(_dgs_stack_tool); fi
    fi
    if [[ -z "$tool" ]]; then DGS_K[status]=no_tool; return 1; fi
    DGS_K[tool]=$tool
    [[ "$tool" == perf ]] && n=1
    DGS_K[captures_planned]=$n

    # A node already stopped or traced is not ours to resume: no capture.
    if ! dgs_proc_state "$pid"; then DGS_K[status]=error; error "grin pid $pid is gone."; return 1; fi
    if (( DGS_PS_STOPPED > 0 || DGS_PS_TRACED > 0 )); then
        DGS_K[status]=pre_stopped; DGS_K[post_tracers]=$DGS_PS_TRACERS
        return 1
    fi

    lf=$(dg_node_logfile "$dir")
    lvl=$(dg_tv "$toml" file_log_level); lvl=${lvl,,}
    trig=tip
    if [[ ( "$lvl" == debug || "$lvl" == trace ) && -f "$lf" ]]; then trig=log; fi
    DGS_K[trigger]=$trig
    if [[ "$confirmed" != 1 ]] && ! dgs_stack_prompt "$pid" "$tool" "$n" "$trig"; then
        DGS_K[status]=declined; return 1
    fi
    _dgs_report_dir || { DGS_K[status]=error; return 1; }
    sp=$(dg_secret_path "$dir" api_secret_path .api_secret "$net" || true)
    rep="$REPORT_DIR/stratum_stack_${net}_$(date -u +%Y%m%d_%H%M%S).txt"
    for (( i = 1; i <= 3; i++ )); do
        _dgs_rm "$DG_TMP/dgs_stack.$i.out" "$DG_TMP/dgs_stack.$i.err" "$DG_TMP/dgs_stack.$i.thread" || return 1
    done
    _dgs_rm "$DG_TMP/dgs_stack.tail.err" "$DG_TMP/dgs_stack.report" || return 1

    # Ctrl+C from here on stops at the next step instead of leaving 086, so a
    # capture always reaches its post-check.
    old_int=$(trap -p INT); old_term=$(trap -p TERM)
    trap '_DGS_STACK_INT=1' INT TERM
    if [[ "$trig" == log ]]; then
        echo "  Waiting for a build line in $lf (up to 3 min, Ctrl+C cancels) ..."
        _dgs_wait_log_resend "$lf" 180; rc=$?
    else
        echo "  Waiting for a new block (up to 3 min, Ctrl+C cancels) ..."
        _dgs_wait_tip "http://$ahost:$aport/v2/owner" "$sp" 180; rc=$?
    fi
    if (( rc != 0 )); then
        _dgs_restore_trap "$old_int" INT; _dgs_restore_trap "$old_term" TERM
        _dgs_rm "$DG_TMP/dgs_stack.tail.err" || true
        if (( rc == 2 )); then DGS_K[status]=interrupted; else DGS_K[status]=no_trigger; fi
        return 1
    fi
    t0=$(_dgs_ms); DGS_K[trigger_at]=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

    _DGS_STACK_ACTIVE=1
    for (( i = 1; i <= n; i++ )); do
        _dgs_sleep_until $(( t0 + 1000 + (i - 1) * 2000 ))
        [[ -n "$_DGS_STACK_INT" ]] && break
        DGS_K[at_$i]=$(date -u '+%H:%M:%S'); ts=$(_dgs_ms)
        _dgs_stack_run "$tool" "$pid" "$lwp" "$DG_TMP/dgs_stack.$i.out" "$DG_TMP/dgs_stack.$i.err"; rc=$?
        DGS_K[rc_$i]=$rc; DGS_K[ms_$i]=$(( $(_dgs_ms) - ts ))
        (( rc == 137 )) && DGS_K[timed_out]=1
        dgs_stack_postcheck "$pid" "$dir" || true
        # A tool that left the node stopped once is not run again: the one
        # SIGCONT is spent, and a second stop could not be undone.
        case "${DGS_K[cont]}:${DGS_K[post]:-}" in 1:*|*:stopped|*:traced) DGS_K[stop_after]=$i ;; esac
        dgs_stack_extract "$tool" "$lwp" "$DG_TMP/dgs_stack.$i.out" "$DG_TMP/dgs_stack.$i.thread" || true
        read -r frames named < <(_dgs_stack_syms "$DG_TMP/dgs_stack.$i.thread")
        DGS_K[frames_$i]=$frames; DGS_K[named_$i]=$named
        if [[ "$tool" == perf ]]; then
            if (( rc == 0 )) && [[ -s "$DG_TMP/dgs_stack.$i.thread" ]]; then okc=$(( okc + 1 )); else failc=$(( failc + 1 )); fi
        elif (( rc == 0 && frames > 0 )); then
            okc=$(( okc + 1 ))
            (( named == 0 )) && nosym=$(( nosym + 1 ))
        else
            failc=$(( failc + 1 ))
            DGS_K[err_tail]=$(tail -n 3 "$DG_TMP/dgs_stack.$i.err" 2>/dev/null | tr '\n' ' ' | cut -c1-240)
        fi
        [[ -n "${DGS_K[stop_after]:-}" ]] && break
    done
    _DGS_STACK_ACTIVE=0
    _dgs_restore_trap "$old_int" INT; _dgs_restore_trap "$old_term" TERM
    DGS_K[captures_ok]=$okc

    if (( okc == 0 )); then
        DGS_K[ptrace_scope]=$(cat "$_DGS_PROC/sys/kernel/yama/ptrace_scope" 2>/dev/null || echo absent)
        DGS_K[container]=$(_dgs_container)
    fi
    if (( okc == 0 && failc == 0 )); then
        DGS_K[status]=interrupted
    elif (( okc == 0 )); then
        if grep -qiE 'ptrace|not permitted|attach' "$DG_TMP"/dgs_stack.[123].err 2>/dev/null; then
            DGS_K[status]=attach_failed; DGS_K[attach_failed]=1
        else
            DGS_K[status]=failed
        fi
    elif (( nosym == okc )); then
        DGS_K[status]=no_symbols
    else
        DGS_K[status]=ok
    fi
    [[ -n "$_DGS_STACK_INT" ]] && DGS_K[interrupted]=1

    body="$DG_TMP/dgs_stack.report"
    {
        echo "Grin Node Toolkit 086 · stack capture of the stratum thread"
        echo "net $net · pid $pid · stratum_server LWP $lwp · node dir $dir"
        echo "tool: $("$tool" --version 2>&1 | head -1)"
        echo "trigger: ${trig} at ${DGS_K[trigger_at]} · captures ok $okc of $n · status ${DGS_K[status]}"
        [[ -n "${DGS_K[ptrace_scope]:-}" ]] && echo "kernel.yama.ptrace_scope: ${DGS_K[ptrace_scope]} · container: ${DGS_K[container]}"
        [[ "${DGS_K[cont]}" == 1 ]] && echo "NOTE: a capture left the node stopped; one SIGCONT was sent."
        echo "Plain backtraces (bt, never bt full): no local variable values. This"
        echo "file holds binary paths and memory addresses. Read it before sharing."
        for (( i = 1; i <= n; i++ )); do
            [[ -n "${DGS_K[at_$i]:-}" ]] || continue
            echo ""
            echo "== capture $i at ${DGS_K[at_$i]} UTC · exit ${DGS_K[rc_$i]} · ${DGS_K[ms_$i]} ms"
            echo "-- stratum_server thread (LWP $lwp)"
            if [[ -s "$DG_TMP/dgs_stack.$i.thread" ]]; then cat "$DG_TMP/dgs_stack.$i.thread"; else echo "(not in the output)"; fi
            echo "-- all threads (stdout)"
            cat "$DG_TMP/dgs_stack.$i.out" 2>/dev/null
            echo "-- stderr"
            if [[ -s "$DG_TMP/dgs_stack.$i.err" ]]; then cat "$DG_TMP/dgs_stack.$i.err"; else echo "(empty)"; fi
        done
        if [[ -s "$DG_TMP/dgs_stack.tail.err" ]]; then echo ""; echo "-- tail -F stderr"; cat "$DG_TMP/dgs_stack.tail.err"; fi
    } > "$body" || { error "Cannot write $body"; DGS_K[status]=error; return 1; }
    _dgs_install_private "$body" "$rep" || { DGS_K[status]=error; return 1; }
    DGS_K[file]=$rep
    for (( i = 1; i <= 3; i++ )); do
        _dgs_rm "$DG_TMP/dgs_stack.$i.out" "$DG_TMP/dgs_stack.$i.err" || true
    done
    _dgs_rm "$body" "$DG_TMP/dgs_stack.tail.err" || true
    log "[086] stack capture $net pid $pid tool $tool status ${DGS_K[status]} ok $okc/$n cont ${DGS_K[cont]} file $rep"
    case "${DGS_K[status]}" in ok|no_symbols) return 0 ;; esac
    return 1
}

