#!/bin/bash
# =============================================================================
# 086_grin_diagnostics.sh - Diagnostics & Support Bundle
# =============================================================================
# Answers "is this our code, this host, or upstream grin?" from evidence, and
# packs that evidence into one file you can hand to whoever is helping you.
#
#   1  Quick health check     ~30 s, on screen — findings, each tagged with the
#                             LIKELY origin (host / toolkit / upstream / client …)
#   2  Build support bundle   ~3 min — everything below into one .tar.gz
#   3  Node API performance   cold vs warm get_block, 20-way burst, and the
#                             IncompleteMessage experiments
#   4  Node log triage        known grin error signatures + an hourly timeline
#   5  Consumer load test     pauses the read-only explorers ~1 min to measure
#                             how much of the node's load is theirs
#   6  Saved reports          list · delete old
#
# ⚠ READ-ONLY, with two deliberate, announced exceptions:
#   · Option 5 stops and restarts explorer services, behind a typed "yes".
#     It restarts ONLY units it stopped, and does so from an EXIT trap too, so
#     Ctrl+C mid-test does not leave an explorer down.
#   · Option 3's IncompleteMessage experiments add one or two lines to the node
#     log. They are off unless the operator says yes.
#
# WHY "likely origin" and not a verdict: every origin is a pattern match (a log
# signature, a threshold). It tells you where to look FIRST. The repo rule is to
# confirm a root cause with evidence before changing code — this tool collects
# that evidence, it does not replace the confirmation.
#
# PRIVACY: no secret value is ever printed or put on a command line; peer and
# visitor IPs are masked; long token-like strings are redacted. Hostnames and
# domains stay — the screen says so wherever a file is produced.
# Set GRIN_DIAG_OFFLINE=1 to skip the three calls that leave the box (public
# reference tip, upstream latest-release lookup).
#
# Menu key 6 in hub 08 (numbered sub-script → its last digit).
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLKIT_ROOT="$(realpath "$SCRIPT_DIR/.." 2>/dev/null || echo "$SCRIPT_DIR/..")"

# ─── Paths ────────────────────────────────────────────────────────────────────
LOG_DIR="/opt/grin/logs"
LOG_FILE="$LOG_DIR/grin_diagnostics_$(date +%Y%m%d_%H%M%S).log"
REPORT_DIR="/opt/grin/reports/diag"
mkdir -p "$LOG_DIR" 2>/dev/null || true

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

# ─── Logging ──────────────────────────────────────────────────────────────────
log()     { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; log "[INFO]  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; log "[OK]    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; log "[WARN]  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; log "[ERROR] $*"; }
pause()   { echo ""; echo "Press Enter to return to menu..."; read -r; }

# ─── Root guard ───────────────────────────────────────────────────────────────
# /proc/<pid>/io, the secret files, journalctl and `ss -p` all return nothing
# useful to a normal user, which would render a sick node as a clean report.
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
    error "This tool must run as root (its probes read root-only state)."
    exit 1
fi

# ─── Shared libs ──────────────────────────────────────────────────────────────
source "$SCRIPT_DIR/lib/grin_node_control.sh"
source "$SCRIPT_DIR/lib/ui_shared_helpers.sh"
source "$SCRIPT_DIR/lib/086_lib_diag.sh"

# ─── Scratch + restart-on-exit ────────────────────────────────────────────────
DG_TMP=$(mktemp -d /tmp/grin-diag.XXXXXX) || { error "mktemp failed"; exit 1; }
chmod 700 "$DG_TMP" 2>/dev/null || true
STOPPED_UNITS=()
_cleanup() {
    local u
    for u in "${STOPPED_UNITS[@]}"; do
        echo "  restarting $u"
        systemctl start "$u" 2>/dev/null || echo "  !! could not restart $u — run: systemctl start $u"
    done
    [[ -n "${DG_TMP:-}" && "$DG_TMP" == /tmp/grin-diag.* ]] && rm -rf "$DG_TMP"
}
trap _cleanup EXIT
trap 'exit 130' INT TERM

# =============================================================================
# Rendering
# =============================================================================
_banner() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 086)  Diagnostics & Support Bundle${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
}

_sev_badge() {
    case "$1" in
        CRIT) echo -e "${RED}${BOLD}[CRIT]${RESET}" ;;
        WARN) echo -e "${YELLOW}[WARN]${RESET}" ;;
        INFO) echo -e "${CYAN}[INFO]${RESET}" ;;
        OK)   echo -e "${GREEN}[ OK ]${RESET}" ;;
        *)    echo "[????]" ;;
    esac
}

# COLUMNS is unset in a non-interactive child — ask the terminal (see 083).
_wrap() {
    local width
    width=$(tput cols 2>/dev/null || true)
    [[ "$width" =~ ^[0-9]+$ ]] || width="${COLUMNS:-100}"
    width=$(( width - 10 )); (( width < 50 )) && width=50
    echo "$1" | fold -s -w "$width" | while IFS= read -r l; do echo -e "        ${DIM}${l}${RESET}"; done
}

_origin_label() {
    case "$1" in
        host)     echo "this VPS — disk, RAM, CPU steal, clock" ;;
        toolkit)  echo "toolkit setup — launch contract, secrets, services" ;;
        upstream) echo "grin itself — check upstream issues" ;;
        client)   echo "programs calling the node API" ;;
        chain)    echo "chain data on disk" ;;
        network)  echo "P2P / sync" ;;
        config)   echo "grin-server.toml settings" ;;
        consumer) echo "a toolkit service that uses the node" ;;
        *)        echo "$1" ;;
    esac
}

# Findings grouped by area, in the order areas first appeared. <plain>=1 drops
# colour for files.
_render_findings() {
    local plain=${1:-0} i a
    local -a areas=(); local -A seen=()
    # Area names contain spaces ("Node mainnet"), so dedupe with a set, not a
    # substring test on the joined list.
    for a in "${DG_AREA[@]}"; do [[ -n "${seen[$a]:-}" ]] || { seen[$a]=1; areas+=("$a"); }; done
    for a in "${areas[@]}"; do
        echo ""
        if (( plain )); then echo "── $a"; else echo -e "${BOLD}${CYAN}── $a ─────────────────────────────────────${RESET}"; fi
        for i in "${!DG_SEV[@]}"; do
            [[ "${DG_AREA[$i]}" == "$a" ]] || continue
            if (( plain )); then
                printf '[%-4s] %s   (likely: %s)\n' "${DG_SEV[$i]}" "${DG_TITLE[$i]}" "${DG_ORIGIN[$i]}"
                printf '       observed: %s\n' "${DG_OBS[$i]}"
                [[ -n "${DG_HINT[$i]}" ]] && printf '       look at : %s\n' "${DG_HINT[$i]}"
            else
                echo -e "  $(_sev_badge "${DG_SEV[$i]}")  ${BOLD}${DG_TITLE[$i]}${RESET}  ${DIM}(likely: ${DG_ORIGIN[$i]})${RESET}"
                echo -e "        ${DG_OBS[$i]}"
                [[ -n "${DG_HINT[$i]}" ]] && _wrap "${DG_HINT[$i]}"
            fi
        done
    done
}

# The question the operator actually asked: where do I look first?
_render_origin_tally() {
    local plain=${1:-0} i o c w n=0
    local -A crit=() warns=()
    for i in "${!DG_SEV[@]}"; do
        o=${DG_ORIGIN[$i]}
        case "${DG_SEV[$i]}" in
            CRIT) crit[$o]=$(( ${crit[$o]:-0} + 1 )) ;;
            WARN) warns[$o]=$(( ${warns[$o]:-0} + 1 )) ;;
        esac
    done
    echo ""
    if (( plain )); then echo "WHERE TO LOOK FIRST (critical / warning findings by likely origin)"
    else echo -e "${BOLD}  Where to look first${RESET} ${DIM}(critical / warning findings by likely origin)${RESET}"; fi
    for o in host toolkit upstream client chain network config consumer; do
        c=${crit[$o]:-0}; w=${warns[$o]:-0}
        (( c + w > 0 )) || continue
        n=$((n + 1))
        printf '    %-9s %2d crit  %2d warn   %s\n' "$o" "$c" "$w" "$(_origin_label "$o")"
    done
    (( n == 0 )) && echo "    nothing critical or warning"
    echo "    Origins are pattern-based leans to decide where to look first — not a diagnosis."
}

_render_summary_line() {
    local c w i o
    c=$(dg_count_sev CRIT); w=$(dg_count_sev WARN); i=$(dg_count_sev INFO); o=$(dg_count_sev OK)
    echo ""
    echo -e "  ${RED}${BOLD}${c} critical${RESET}   ${YELLOW}${w} warning${RESET}   ${CYAN}${i} info${RESET}   ${GREEN}${o} ok${RESET}"
    # Zero findings means the probes did not run — never a clean bill of health.
    if (( ${#DG_SEV[@]} == 0 )); then
        echo -e "  ${YELLOW}No checks produced a result — the diagnostics did not run correctly.${RESET}"
        echo -e "  ${DIM}This is not a pass. Check $LOG_FILE.${RESET}"
    fi
    log "[086] findings crit=$c warn=$w info=$i ok=$o"
}

# Page long output with the house `less -FRX`; sets UI_PAGED so the exit
# prompt names the right key (see 083 for the full rationale).
UI_PAGED=0
_page() {
    local content rows lines
    content=$(cat)
    lines=$(printf '%s\n' "$content" | wc -l)
    rows=$(tput lines 2>/dev/null || true); [[ "$rows" =~ ^[0-9]+$ ]] || rows=24
    if [[ -t 1 ]] && command -v less >/dev/null 2>&1 && (( lines > rows - 2 )); then
        UI_PAGED=1; printf '%s\n' "$content" | less -FRX
    else
        UI_PAGED=0; printf '%s\n' "$content"
    fi
}
_end_pause() {
    echo ""
    (( UI_PAGED == 1 )) && echo -e "  ${DIM}You were in the pager — press ${RESET}${BOLD}q${RESET}${DIM} to leave it if you have not already.${RESET}"
    echo -e "  ${BOLD}Press Enter${RESET} to return to the Diagnostics menu..."
    read -r
}

_ensure_report_dir() {
    mkdir -p "$REPORT_DIR" 2>/dev/null || { error "Cannot create $REPORT_DIR"; return 1; }
    chmod 700 "$REPORT_DIR" 2>/dev/null || true
}

# Picks one running node. Sets PICK (index into DG_NODES). rc 1 = none/cancel.
PICK=0
_pick_node() {
    dg_discover_nodes
    if (( ${#DG_NODES[@]} == 0 )); then
        error "No running grin node found (no 'grin server' process)."
        return 1
    fi
    if (( ${#DG_NODES[@]} == 1 )); then PICK=0; return 0; fi
    local i n choice
    echo ""
    for i in "${!DG_NODES[@]}"; do
        IFS='|' read -r _ n _ _ _ <<< "${DG_NODES[$i]}"
        echo -e "  ${GREEN}$((i + 1))${RESET}) $(cut -d'|' -f3 <<< "${DG_NODES[$i]}")  ${DIM}$n${RESET}"
    done
    ui_ask choice "Which node" "1" || return 1
    [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#DG_NODES[@]} )) || { warn "Invalid choice."; return 1; }
    PICK=$((choice - 1))
}

_since_str() { date -d "@$1" '+%Y%m%d %H:%M:%S'; }

# =============================================================================
# 1  Quick health check
# =============================================================================
quick_check() {
    _banner
    echo -e "${DIM}  Read-only. About 30 seconds.${RESET}"
    echo ""
    info "Checking host, nodes, last hour of node logs and toolkit services..."
    dg_reset
    dg_discover_nodes
    DG_MAIN_TIP=""
    local n pid dir net host port lf since_e
    since_e=$(( $(date +%s) - 3600 ))
    {
        dg_check_host
        if (( ${#DG_NODES[@]} == 0 )); then
            dg_add CRIT Nodes toolkit "No running grin node" "no 'grin server' process on this host" \
                "Start the node from Script 01, or read why it exited: gtmux ls, then the node log."
        fi
        for n in "${DG_NODES[@]}"; do
            IFS='|' read -r pid dir net host port <<< "$n"
            dg_check_node "$pid" "$dir" "$net" "$host" "$port"
            lf=$(dg_node_logfile "$dir")
            dg_log_window "$lf" "$(_since_str "$since_e")" "$since_e" \
                | dg_log_filter "$(_since_str "$since_e")" > "$DG_TMP/win" 2>/dev/null || true
            echo "  log (last hour): $lf"
            dg_triage "$DG_TMP/win" "$net" 1
        done
        dg_check_registered_not_running
        dg_check_consumers
    } > "$DG_TMP/quick.out" 2>&1

    _banner
    local report
    report=$(
        echo -e "  ${DIM}Host: $(hostname 2>/dev/null)  ·  $(date -u '+%Y-%m-%d %H:%M UTC')  ·  $(dg_toolkit_version "$TOOLKIT_ROOT")${RESET}"
        echo ""
        echo -e "${BOLD}  Probe output${RESET}"
        sed 's/^/  /' "$DG_TMP/quick.out"
        _render_findings 0
        _render_origin_tally 0
        _render_summary_line
        echo ""
        echo -e "  ${DIM}Nothing was changed. For everything in one file to share, use option 2.${RESET}"
        ui_end "$(dg_count_sev CRIT) critical · $(dg_count_sev WARN) warning · nothing was changed"
    )
    _page <<< "$report"
    _end_pause
}

# =============================================================================
# 2  Support bundle
# =============================================================================
build_bundle() {
    _banner
    echo ""
    echo -e "  Collects host, node, log, service, network and history data into one"
    echo -e "  .tar.gz under ${BOLD}$REPORT_DIR${RESET}. About 3 minutes; read-only."
    echo -e "  ${DIM}Secret values are never included; IPs are masked; hostnames and domains are NOT.${RESET}"
    echo ""
    _ensure_report_dir || { pause; return 1; }

    local ts name dir n pid dir_n net host port lf since_e
    ts=$(date +%Y%m%d_%H%M%S)
    name="grin_diag_$(hostname -s 2>/dev/null || echo host)_$ts"
    dir="$REPORT_DIR/$name"
    mkdir -m 700 "$dir" 2>/dev/null || { error "Cannot create $dir"; pause; return 1; }
    log "[086] bundle start $dir"

    dg_reset; dg_discover_nodes; DG_MAIN_TIP=""
    since_e=$(( $(date +%s) - 86400 ))

    info "Host..."
    { dg_dump_host; dg_check_host; } > "$dir/01_host.txt" 2>&1
    (( ${#DG_NODES[@]} == 0 )) && dg_add CRIT Nodes toolkit "No running grin node" "no 'grin server' process" ""
    for n in "${DG_NODES[@]}"; do
        IFS='|' read -r pid dir_n net host port <<< "$n"
        info "Node $net — config, versions, peers, default-config diff..."
        dg_dump_node "$pid" "$dir_n" "$net" "$host" "$port" > "$dir/02_node_$net.txt" 2>&1
        info "Node $net — log triage (24 h)..."
        lf=$(dg_node_logfile "$dir_n")
        dg_log_window "$lf" "$(_since_str "$since_e")" "$since_e" \
            | dg_log_filter "$(_since_str "$since_e")" > "$DG_TMP/win" 2>/dev/null || true
        {
            dg_sec "NODE LOG $net  ($lf)"
            ls -lh "$lf"* 2>/dev/null
            dg_sub "known signatures, last 24 h"; dg_triage "$DG_TMP/win" "$net" 24
            dg_sub "per hour"; dg_log_hourly "$DG_TMP/win"
            dg_sub "last 300 ERROR/WARN lines (IPs masked)"
            grep -aE '^[0-9]{8} [0-9:.]+ (ERROR|WARN) ' "$DG_TMP/win" | tail -300 | dg_maskip | cut -c1-260
            dg_sub "last 150 lines of any level (IPs masked)"
            tail -150 "$lf" 2>/dev/null | dg_maskip | cut -c1-260
        } > "$dir/03_log_$net.txt" 2>&1
        info "Node $net — tmux pane (panics print here)..."
        dg_tmux_capture "$dir_n" 500 > "$dir/04_tmux_$net.txt" 2>&1
        info "Node $net — API timings (get_block cold/warm, 20-way burst)..."
        dg_api_perf "$dir_n" "$net" "$host" "$port" 0 > "$dir/05_perf_$net.txt" 2>&1
    done
    dg_check_registered_not_running

    info "Toolkit services, cron, timers..."
    { dg_check_consumers; dg_dump_services; } > "$dir/06_services.txt" 2>&1
    info "Network, firewall, nginx traffic..."
    dg_dump_network > "$dir/07_network.txt" 2>&1
    info "sar history..."
    dg_dump_history > "$dir/08_history.txt" 2>&1

    info "Sampling per-process CPU and disk for 30 s..."
    local -a procs=(); local u mp
    for n in "${DG_NODES[@]}"; do IFS='|' read -r pid _ net _ _ <<< "$n"; procs+=("grin-$net:$pid"); done
    for u in $(dg_toolkit_units); do
        [[ "$u" == *.service ]] || continue
        mp=$(systemctl show "$u" -p MainPID --value 2>/dev/null)
        [[ "$mp" =~ ^[1-9][0-9]*$ ]] && procs+=("${u%.service}:$mp")
    done
    { dg_sec "CPU + DISK PER PROCESS (30 s)"; (( ${#procs[@]} )) && dg_sample_procs 30 "${procs[@]}"; } \
        > "$dir/09_proc_sample.txt" 2>&1

    {
        echo "Grin Node Toolkit — diagnostics support bundle"
        echo "host     : $(hostname -f 2>/dev/null || hostname)"
        echo "created  : $(date -u '+%Y-%m-%d %H:%M:%S UTC')   (host local: $(date '+%F %T %Z'))"
        echo "toolkit  : $(dg_toolkit_version "$TOOLKIT_ROOT")"
        for n in "${DG_NODES[@]}"; do
            IFS='|' read -r pid dir_n net _ _ <<< "$n"
            echo "grin $net: $("$dir_n/grin" --version 2>/dev/null || echo ?)  dir=$dir_n  archive_mode=$(dg_tv "$dir_n/grin-server.toml" archive_mode)"
        done
        echo "upstream : latest release $(dg_upstream_latest || echo '(offline / unreachable)')"
        echo "NOTE     : read-only collection. No secret values. IPs masked. Hostnames/domains NOT masked."
        echo ""
        echo "SUMMARY: $(dg_count_sev CRIT) critical, $(dg_count_sev WARN) warning, $(dg_count_sev INFO) info, $(dg_count_sev OK) ok"
        (( ${#DG_SEV[@]} == 0 )) && echo "!! No checks produced a result — this collection did not run correctly."
        _render_origin_tally 1
        _render_findings 1
        echo ""
        echo "FILES"
        echo "  01_host.txt          CPU/RAM/disk/pressure, kernel OOM + IO errors, clock"
        echo "  02_node_<net>.txt    versions + timeline, config, toml vs upstream default, peers by version"
        echo "  03_log_<net>.txt     24 h signature triage, per-hour counts, last errors"
        echo "  04_tmux_<net>.txt    node console (panics and backtraces land here)"
        echo "  05_perf_<net>.txt    get_block cold/warm timings, 20-way parallel burst"
        echo "  06_services.txt      toolkit units, journal errors, cron, timers"
        echo "  07_network.txt       listeners, P2P, firewall, nginx vhosts + traffic"
        echo "  08_history.txt       sar history (yesterday + today)"
        echo "  09_proc_sample.txt   30 s CPU/disk per node and toolkit service"
    } > "$dir/00_summary.txt" 2>&1

    tar -czf "$REPORT_DIR/$name.tar.gz" -C "$REPORT_DIR" "$name" 2>/dev/null \
        || { error "tar failed — the raw files are still in $dir"; pause; return 1; }
    chmod 600 "$REPORT_DIR/$name.tar.gz" 2>/dev/null || true
    cp "$dir/00_summary.txt" "$REPORT_DIR/$name.summary.txt" 2>/dev/null \
        || warn "Could not copy the summary next to the archive."
    chmod 600 "$REPORT_DIR/$name.summary.txt" 2>/dev/null || true
    [[ "$dir" == "$REPORT_DIR"/grin_diag_* ]] && rm -rf "$dir"
    log "[086] bundle done $REPORT_DIR/$name.tar.gz"

    _banner
    local report
    report=$(
        _render_findings 0
        _render_origin_tally 0
        _render_summary_line
        echo ""
        echo -e "  ${GREEN}Bundle:${RESET}  $REPORT_DIR/$name.tar.gz  ${DIM}($(du -h "$REPORT_DIR/$name.tar.gz" 2>/dev/null | cut -f1), mode 600)${RESET}"
        echo -e "  ${GREEN}Summary:${RESET} $REPORT_DIR/$name.summary.txt"
        echo ""
        echo -e "  ${DIM}Copy it off the box, from your own machine:${RESET}"
        echo -e "    scp root@$(hostname -f 2>/dev/null || hostname):$REPORT_DIR/$name.tar.gz ."
        echo -e "  ${YELLOW}It names this host and its domains. Read it before posting it anywhere public.${RESET}"
        ui_end "bundle written · nothing was changed"
    )
    _page <<< "$report"
    _end_pause
}

# =============================================================================
# 3  Node API performance
# =============================================================================
api_perf() {
    _banner
    _pick_node || { pause; return 1; }
    local pid dir net host port ans with_im=0 out
    IFS='|' read -r pid dir net host port <<< "${DG_NODES[$PICK]}"
    echo ""
    echo -e "  Times get_block from the tip back to genesis (archive) — each twice, cold"
    echo -e "  then warm — and a 20-request parallel burst. 1-3 minutes on an archive node."
    echo ""
    echo -e "  ${BOLD}IncompleteMessage experiments${RESET} ${DIM}(optional)${RESET}: send one half-finished request"
    echo -e "  and one that gives up after 1 s, to show what that log line means on this"
    echo -e "  build. ${YELLOW}This adds one or two IncompleteMessage lines to the node log.${RESET}"
    if ui_ask ans "Include the experiments? [y/N]" "n"; then
        [[ "${ans,,}" == "y" || "${ans,,}" == "yes" ]] && with_im=1
    else
        info "Cancelled."; pause; return 0
    fi
    _ensure_report_dir || { pause; return 1; }
    out="$REPORT_DIR/api_perf_${net}_$(date +%Y%m%d_%H%M%S).txt"
    dg_reset
    info "Running — please wait..."
    dg_api_perf "$dir" "$net" "$host" "$port" "$with_im" > "$out" 2>&1
    chmod 600 "$out" 2>/dev/null || true
    _banner
    local report
    report=$(
        cat "$out"
        _render_findings 0
        echo ""
        echo -e "  ${DIM}Saved: $out${RESET}"
        echo -e "  ${DIM}Read it: pass 2 much faster than pass 1 on old heights = cold disk reads (RAM/disk bound).${RESET}"
        echo -e "  ${DIM}Slow near the tip too = the node itself is starved. Parallel max >> avg = requests queue.${RESET}"
        ui_end "API performance · $net"
    )
    _page <<< "$report"
    _end_pause
}

# =============================================================================
# 4  Node log triage
# =============================================================================
log_triage() {
    _banner
    _pick_node || { pause; return 1; }
    local pid dir net host port w hours since_e lf up
    IFS='|' read -r pid dir net host port <<< "${DG_NODES[$PICK]}"
    echo ""
    echo -e "  ${GREEN}1${RESET}) last hour   ${GREEN}2${RESET}) last 6 h   ${GREEN}3${RESET}) last 24 h   ${GREEN}4${RESET}) since this node started"
    ui_ask w "Window" "1" || { info "Cancelled."; pause; return 0; }
    case "$w" in
        1) hours=1 ;; 2) hours=6 ;; 3) hours=24 ;;
        4) up=$(_dg_num "$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')")
           hours=$(( up / 3600 + 1 )) ;;
        *) warn "Invalid choice."; pause; return 0 ;;
    esac
    since_e=$(( $(date +%s) - hours * 3600 ))
    lf=$(dg_node_logfile "$dir")
    [[ -f "$lf" ]] || { error "Log file not found: $lf"; pause; return 1; }
    info "Reading $lf ..."
    dg_log_window "$lf" "$(_since_str "$since_e")" "$since_e" \
        | dg_log_filter "$(_since_str "$since_e")" > "$DG_TMP/win" 2>/dev/null || true
    dg_reset
    dg_triage "$DG_TMP/win" "$net" "$hours" > "$DG_TMP/triage.out" 2>&1
    _banner
    local report
    report=$(
        echo -e "  ${DIM}$lf · since $(_since_str "$since_e") (host local time, as in the log)${RESET}"
        echo ""
        cat "$DG_TMP/triage.out"
        echo ""
        echo -e "${BOLD}  Per hour${RESET}"
        dg_log_hourly "$DG_TMP/win"
        _render_findings 0
        _render_origin_tally 0
        echo ""
        echo -e "${BOLD}  Last 20 ERROR lines${RESET} ${DIM}(IPs masked)${RESET}"
        grep -aE '^[0-9]{8} [0-9:.]+ ERROR ' "$DG_TMP/win" | tail -20 | dg_maskip | cut -c1-200
        ui_end "log triage · $net · ${hours} h"
    )
    _page <<< "$report"
    _end_pause
}

# =============================================================================
# 5  Consumer load test
# =============================================================================
consumer_load_test() {
    _banner
    local -a cands=(); local u main_pid="" n pid net ans out
    for u in "${DG_READONLY_CONSUMERS[@]}"; do
        systemctl is-active --quiet "$u" 2>/dev/null && cands+=("$u")
    done
    dg_discover_nodes
    for n in "${DG_NODES[@]}"; do IFS='|' read -r pid _ net _ _ <<< "$n"; [[ "$net" == mainnet ]] && main_pid=$pid; done
    echo ""
    if [[ -z "$main_pid" ]]; then error "No running mainnet node."; pause; return 1; fi
    if (( ${#cands[@]} == 0 )); then
        info "None of the read-only explorers is running (${DG_READONLY_CONSUMERS[*]})."
        pause; return 0
    fi
    echo -e "  Measures the mainnet node's CPU and disk with these services ${BOLD}running${RESET},"
    echo -e "  ${BOLD}stopped${RESET}, then ${BOLD}restarted${RESET} — 45 s each, about 3 minutes in total:"
    echo ""
    for u in "${cands[@]}"; do echo -e "    ${CYAN}$u${RESET}"; done
    echo ""
    echo -e "  ${YELLOW}They will be DOWN for about 1 minute. Visitors see errors meanwhile.${RESET}"
    echo -e "  ${DIM}Only these units are touched, only those it stopped are restarted, and a${RESET}"
    echo -e "  ${DIM}Ctrl+C still restarts them. The pool, wallets and nodes are never stopped.${RESET}"
    echo ""
    ui_ask ans "Type yes to proceed" || { info "Cancelled — nothing was stopped."; pause; return 0; }
    [[ "${ans,,}" == "yes" ]] || { info "Cancelled — nothing was stopped."; pause; return 0; }

    _ensure_report_dir || { pause; return 1; }
    out="$REPORT_DIR/consumer_load_$(date +%Y%m%d_%H%M%S).txt"
    log "[086] consumer load test: ${cands[*]}"
    {
        dg_sec "CONSUMER LOAD TEST  node pid $main_pid  units: ${cands[*]}"
        echo "phase 1: explorers RUNNING (45 s)"; dg_sample_procs 45 "grin-mainnet:$main_pid"
        for u in "${cands[@]}"; do
            if systemctl stop "$u" 2>/dev/null; then STOPPED_UNITS+=("$u"); echo "  stopped $u"
            else echo "  !! could not stop $u"; fi
        done
        sleep 10
        echo "phase 2: explorers STOPPED (45 s)"; dg_sample_procs 45 "grin-mainnet:$main_pid"
        for u in "${STOPPED_UNITS[@]}"; do
            systemctl start "$u" 2>/dev/null && echo "  restarted $u" || echo "  !! could not restart $u"
        done
        STOPPED_UNITS=()
        sleep 15
        echo "phase 3: explorers RESTARTED (45 s)"; dg_sample_procs 45 "grin-mainnet:$main_pid"
        echo ""
        for u in "${cands[@]}"; do printf '  %-24s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null)"; done
        echo ""
        echo "Read it: if the node's CPU/read MB/s drop sharply in phase 2 and return in phase 3,"
        echo "the explorers are driving the load. If phase 2 stays as busy, look elsewhere"
        echo "(peers/sync, another API client, the host itself)."
    } > >(tee "$out") 2>&1
    # NOT `{ …; } | tee`: a pipeline runs the block in a SUBSHELL, so the units
    # it stopped would be recorded in a copy of STOPPED_UNITS the EXIT trap
    # never sees — a Ctrl+C in phase 2 would then leave the explorers down.
    # Redirecting into a process substitution keeps the block in this shell.
    sleep 1
    chmod 600 "$out" 2>/dev/null || true
    # Belt and braces: anything still down is started again.
    for u in "${cands[@]}"; do
        systemctl is-active --quiet "$u" 2>/dev/null || { warn "$u is not active — starting it"; systemctl start "$u" 2>/dev/null || true; }
    done
    echo ""
    success "Saved: $out"
    pause
}

# =============================================================================
# 6  Saved reports
# =============================================================================
saved_reports() {
    _banner
    echo ""
    if [[ ! -d "$REPORT_DIR" ]] || [[ -z "$(ls -A "$REPORT_DIR" 2>/dev/null)" ]]; then
        info "No saved reports in $REPORT_DIR."; pause; return 0
    fi
    ls -lht "$REPORT_DIR" 2>/dev/null | tail -n +2 | awk '{printf "  %6s  %s %s %s  %s\n", $5, $6, $7, $8, $9}'
    echo ""
    echo -e "  ${DIM}Total: $(du -sh "$REPORT_DIR" 2>/dev/null | cut -f1)${RESET}"
    echo ""
    local days
    ui_ask days "Delete reports older than how many days? (q = keep all)" || { info "Kept everything."; pause; return 0; }
    [[ "$days" =~ ^[0-9]+$ ]] || { warn "Not a number — nothing deleted."; pause; return 0; }
    local cnt
    cnt=$(find "$REPORT_DIR" -maxdepth 1 -type f -mtime +"$days" \
          \( -name 'grin_diag_*' -o -name 'api_perf_*' -o -name 'consumer_load_*' \) 2>/dev/null | wc -l)
    find "$REPORT_DIR" -maxdepth 1 -type f -mtime +"$days" \
        \( -name 'grin_diag_*' -o -name 'api_perf_*' -o -name 'consumer_load_*' \) -delete 2>/dev/null \
        || { error "Delete failed."; pause; return 1; }
    success "Deleted $cnt file(s) older than $days day(s)."
    log "[086] deleted $cnt reports older than $days days"
    pause
}

# =============================================================================
# Menu
# =============================================================================
show_menu() {
    _banner
    echo ""
    echo -e "  ${DIM}Is it our code, this host, or upstream grin? Collect the evidence first.${RESET}"
    echo ""
    echo -e "${BOLD}  Check${RESET}"
    echo -e "  ${GREEN}1${RESET})   Quick health check        ${DIM}~30 s · findings + likely origin${RESET}"
    echo -e "  ${GREEN}2${RESET})   Build support bundle      ${DIM}~3 min · one .tar.gz to share${RESET}"
    echo ""
    echo -e "${BOLD}  Dig deeper${RESET}"
    echo -e "  ${CYAN}3${RESET})   Node API performance      ${DIM}get_block cold/warm · parallel burst${RESET}"
    echo -e "  ${CYAN}4${RESET})   Node log triage           ${DIM}known error signatures · hourly timeline${RESET}"
    echo -e "  ${YELLOW}5${RESET})   Consumer load test        ${DIM}pauses explorers ~1 min (asks first)${RESET}"
    echo ""
    echo -e "  ${DIM}6${RESET})   Saved reports             ${DIM}list · delete old${RESET}"
    echo -e "  ${DIM}0${RESET})   Return to admin centre"
    echo ""
    echo -e "  ${DIM}Read-only except option 5. Reports: $REPORT_DIR${RESET}"
    echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -ne "${BOLD}Select [0-6]: ${RESET}"
}

main() {
    log "[086] started"
    while true; do
        show_menu
        read -r choice
        # Every arm is ||-guarded: under `set -e` an unguarded non-zero return
        # would kill this script instead of returning here. `0)` is exempt.
        case "${choice,,}" in
            "1") quick_check        || true ;;
            "2") build_bundle       || true ;;
            "3") api_perf           || true ;;
            "4") log_triage         || true ;;
            "5") consumer_load_test || true ;;
            "6") saved_reports      || true ;;
            "0") break ;;
            *)   warn "Invalid option." ; sleep 1 ;;
        esac
    done
    log "[086] exited"
}

main "$@"
