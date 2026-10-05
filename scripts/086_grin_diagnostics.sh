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
#   7  Node event recorder    timeline · availability % · evidence · export for
#                             an upstream issue · alert settings · install
#                             (086 design §8; the recorder is lib/grin_node_events.sh)
#
# ⚠ READ-ONLY, with two deliberate, announced exceptions:
#   · Option 5 stops and restarts explorer services, behind a typed "yes".
#     It restarts ONLY units it stopped, and does so from an EXIT trap too, so
#     Ctrl+C mid-test does not leave an explorer down.
#   · Option 3's IncompleteMessage experiments add one or two lines to the node
#     log. They are off unless the operator says yes.
#   Option 7 installs/removes the recorder and edits ITS config when asked to;
#   the recorder itself never signals a node.
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
# Node event recorder (option 7): its read side (sources grin_node_events.sh)
# and the watchdog lib, only to offer regenerating a watchdog that predates the
# recorder's capture hook.
source "$SCRIPT_DIR/lib/086_lib_recorder.sh"
source "$SCRIPT_DIR/lib/grin_node_keepalive.sh"

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
    info "Node event recorder state..."
    dgr_support_section > "$dir/10_recorder.txt" 2>&1

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
        echo "  10_recorder.txt      node event recorder: status + last 20 ledger events per net"
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
# 7  Node event recorder (086 design §8.12; the recorder is lib/grin_node_events.sh,
#    its read side lib/086_lib_recorder.sh)
# =============================================================================
# Everything here READS the recorder's files, except: Install/Remove, Alert
# settings (recorder.conf only) and "Capture evidence now" (a new bundle, no
# ledger line). Data goes out with printf '%s', never echo -e: a ledger reason
# or a log line holding "\c" would cut the rest of the screen off
# (reference_echo_e_backslash_c_truncation).

_rec_banner() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 086)  Diagnostics — Node event recorder${1:+  ·  $1}${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
}

# [Y/n]: only an explicit n declines; EOF declines too (project_prompt_default_catchall).
_rec_yes() {
    local a=""
    echo -ne "${BOLD}$1 [Y/n]: ${RESET}"
    if ! read -r a; then echo ""; return 1; fi
    [[ "${a,,}" != "n" && "${a,,}" != "no" ]]
}
# [y/N]: only an explicit y accepts.
_rec_no() {
    local a=""
    echo -ne "${BOLD}$1 [y/N]: ${RESET}"
    if ! read -r a; then echo ""; return 1; fi
    [[ "${a,,}" == "y" || "${a,,}" == "yes" ]]
}

# _rec_ask_secret <var> <prompt> — ui_ask without echo, for a token, the Nostr
# key or an ntfy topic URL (a topic URL IS the credential). q / Enter / EOF
# cancel. The value only ever lives in a variable: no argv, no log.
_rec_ask_secret() {
    local _rqs_var="${1:-}" _rqs_v=""
    _ui_name_ok "$_rqs_var" "_rqs_" || return 1
    printf '%b' "${2:-Value} ${DIM}[input hidden · off = turn the channel off · q or Enter = cancel]${RESET}: " >&2
    if ! IFS= read -rs _rqs_v; then printf '\n' >&2; printf -v "$_rqs_var" '%s' ''; return 1; fi
    printf '\n' >&2
    _rqs_v="${_rqs_v#"${_rqs_v%%[![:space:]]*}"}"; _rqs_v="${_rqs_v%"${_rqs_v##*[![:space:]]}"}"
    case "$_rqs_v" in ""|q|Q) printf -v "$_rqs_var" '%s' ''; return 1 ;; esac
    printf -v "$_rqs_var" '%s' "$_rqs_v"
    return 0
}

_rec_class_col() {
    case "${1:-}" in
        corrupted)                    printf '%b' "${RED}${BOLD}" ;;
        crashed|killed|failed_start)  printf '%b' "$RED" ;;
        hung|wedged|unexplained_stop) printf '%b' "$YELLOW" ;;
        *)                            printf '' ;;
    esac
}

_rec_kb() {
    local kb; kb=$(_dg_num "${1:-0}")
    if (( kb < 1024 )); then printf '%d KB' "$kb"; else printf '%d.%d MB' $(( kb / 1024 )) $(( kb % 1024 * 10 / 1024 )); fi
}

# _rec_pct <up_s> <down_s> → "99.82 %" (floored, so a real outage never reads 100.00).
_rec_pct() {
    local up=$(_dg_num "$1") dn=$(_dg_num "$2") p
    if (( up + dn == 0 )); then printf 'n/a'; return 0; fi
    p=$(( up * 10000 / (up + dn) ))
    if (( dn > 0 && p >= 10000 )); then p=9999; fi
    printf '%d.%02d %%' $(( p / 100 )) $(( p % 100 ))
}

_rec_watchdog_hook_state() { # → none | hooked | old
    if [[ ! -x "$GNK_WATCHDOG_BIN" ]]; then echo none
    elif grep -q 'grin-node-events capture' "$GNK_WATCHDOG_BIN" 2>/dev/null; then echo hooked
    else echo old; fi
}

# One status line per net, from status.json.
_rec_net_status() {
    local net="$1" now="$2" s st cls sub upd us os sn gv col txt
    s=$(dgr_status_line "$net")
    if [[ -z "$s" ]]; then printf '  %-9s %b%s%b\n' "$net" "$DIM" "no status yet" "$RESET"; return 0; fi
    st=$(_gne_jget "$s" state); cls=$(_gne_jget "$s" class); sub=$(_gne_jget "$s" sub)
    upd=$(_dg_num "$(_gne_jget "$s" updated)"); gv=$(_gne_jget "$s" grin_version)
    sn=$(_dg_num "$(_gne_jget "$s" since)")
    case "$st" in
        up)
            us=$(_dg_num "$(_gne_jget "$s" up_since)"); (( us > 0 )) || us=$sn
            col="$GREEN"; txt="up for $(dgr_dur $(( now - us )))  (since $(dgr_utc_min "$us") UTC)" ;;
        down)
            os=$(_dg_num "$(_gne_jget "$s" outage_started_at)"); (( os > 0 )) || os=$sn
            col=$(_rec_class_col "$cls"); [[ -n "$col" ]] || col="$RED"
            txt="DOWN — ${cls:-?}${sub:+/$sub} for $(dgr_dur $(( now - os )))"
            if [[ "$(_gne_jget "$s" sub_state)" == restarting ]]; then txt+="  (restarting)"; fi ;;
        starting)     col="$CYAN";   txt="starting since $(dgr_utc_min "$sn") UTC" ;;
        stopped)      col="$CYAN";   txt="stopped (planned) since $(dgr_utc_min "$sn") UTC" ;;
        auth_fail)    col="$YELLOW"; txt="API rejects the owner secret (401/403) — the node answers; a secret is wrong" ;;
        unregistered) col="$DIM";    txt="not in the instances conf — not observed" ;;
        *)            col="$DIM";    txt="unknown — the recorder cannot judge yet" ;;
    esac
    printf '  %-9s %b%s%b' "$net" "$col" "$txt" "$RESET"
    if [[ -n "$gv" ]]; then printf '%b  · grin %s%b' "$DIM" "$gv" "$RESET"; fi
    printf '\n'
    if (( upd > 0 && now - upd > DGR_STALE_S )); then
        printf '            %b%s%b\n' "$YELLOW" "status is STALE: last check $(dgr_dur $(( now - upd ))) ago — is the timer running? (S = status)" "$RESET"
    fi
}

# ── 7.1 Timeline ─────────────────────────────────────────────────────────────
_rec_timeline_net() { # <net> <n> <now>
    local net="$1" n="$2" now="$3" sid ts ev st cl ci sb oid sa du by rs evn gp id cs pid rc gv x col lab txt
    sid=$(dgr_status_get "$net" outage_id)
    while IFS="$DGR_SEP" read -r ts ev st cl ci sb oid sa du by rs evn gp id cs pid rc gv x; do
        col=""; txt=""
        case "$ev" in
            down)
                col=$(_rec_class_col "$cl"); lab="DOWN"
                txt="${cl:-?}${sb:+/$sb}"
                if [[ -n "$ci" && "$ci" != "$cl" ]]; then txt+=" (first seen as $ci)"; fi
                if [[ "$x" == open && "$id" == "$sid" ]]; then txt+=" · ongoing, $(dgr_dur $(( now - $(_dg_num "${sa:-$ts}") )))"
                elif [[ "$x" == open ]]; then txt+=" · never closed (the recorder stopped observing)"
                elif [[ -n "$x" ]]; then txt+=" · lasted $(dgr_dur "$x")"; fi
                if [[ -n "$evn" ]]; then txt+=" · evidence $evn"; fi ;;
            up)
                col="$GREEN"; lab="UP"
                if [[ -n "$oid" && -n "$du" ]]; then txt="recovered — the outage lasted $(dgr_dur "$du")"; else txt="answering"; fi ;;
            start)
                col="$CYAN"; lab="start"; txt="node (re)started · by ${by:-unknown}"
                if [[ "$st" == down ]]; then txt+=" · still inside the outage"; fi ;;
            stop)
                col="$CYAN"; lab="stop"; txt="planned stop · by ${by:-?}${rs:+ · $rs}"
                if [[ -n "$du" ]]; then txt+=" · ended an outage of $(dgr_dur "$du")"; fi ;;
            boot)
                lab="boot"; col="$CYAN"
                case "$cs" in
                    true)  txt="host rebooted · previous shutdown clean" ;;
                    false) txt="host rebooted · previous shutdown UNCLEAN"; col="$YELLOW" ;;
                    *)     txt="host rebooted · previous shutdown unknown" ;;
                esac
                if [[ -n "$du" ]]; then txt+=" · ended an outage of $(dgr_dur "$du")"; fi ;;
            reclass)
                col=$(_rec_class_col "$cl"); lab="reclass"; txt="${ci:-?} → ${cl:-?}${sb:+/$sb}${evn:+ · evidence $evn}" ;;
            restart_by_watchdog)
                col="$YELLOW"; lab="watchdog"; txt="restart by the sync watchdog${rs:+ · $rs}${evn:+ · evidence $evn}" ;;
            auth_fail)
                col="$YELLOW"; lab="auth"; txt="API rejects the owner secret — node up, secret wrong"
                if [[ -n "$du" ]]; then txt+=" · ended an outage of $(dgr_dur "$du")"; fi ;;
            auth_ok)        col="$GREEN"; lab="auth"; txt="secret accepted again" ;;
            probe_error)    col="$YELLOW"; lab="probe"; txt="cannot read the node's owner secret — not judged" ;;
            gap)            col="$DIM"; lab="gap"; txt="not observed for $(dgr_dur "$gp") (recorder not running, or the clock jumped)" ;;
            stale_marker)   col="$DIM"; lab="marker"; txt="planned-stop marker expired unused${by:+ (by $by)} — that stop never happened" ;;
            unregistered)   col="$DIM"; lab="unreg"; txt="not in the instances conf — no longer observed" ;;
            recorder_start) col="$DIM"; lab="recorder"; txt="recording started" ;;
            *)              col="$DIM"; lab="$ev"; txt="state $st" ;;
        esac
        printf '  %s  %b%-9s %s%b\n' "$(dgr_utc "$ts")" "$col" "$lab" "$txt" "$RESET"
    done < <(dgr_timeline_rows "$net" "$n")
}

rec_timeline() {
    _rec_banner "Timeline"
    local -a nets=(); local n net now report
    mapfile -t nets < <(dgr_nets)
    echo ""
    if (( ${#nets[@]} == 0 )); then info "No ledger yet — install the recorder (I) and give it a minute."; pause; return 0; fi
    ui_ask_num n "Events per network" "25" 1 500 || { info "Cancelled."; pause; return 0; }
    now=$(date +%s)
    report=$(
        for net in "${nets[@]}"; do
            echo ""
            echo -e "${BOLD}${CYAN}── $net ─────────────────────────────────────${RESET}"
            _rec_net_status "$net" "$now"
            echo ""
            _rec_timeline_net "$net" "$n" "$now"
        done
        echo ""
        echo -e "  ${DIM}All times UTC. A class is a lean, not a verdict. Planned stops, starts and boots are${RESET}"
        echo -e "  ${DIM}recorded but never counted as outages. Evidence: 3) Show evidence.${RESET}"
        ui_end "timeline · nothing was changed"
    )
    _page <<< "$report"
    _end_pause
}

# ── 7.2 Availability ─────────────────────────────────────────────────────────
_rec_row() { local l="$1" v; shift; printf '  %-26s' "$l"; for v in "$@"; do printf '%18s' "$v"; done; printf '\n'; }

_rec_avail_net() { # <net> <now>
    local net="$1" now="$2" line kv w ts by rs cl
    local -A A=()
    local -a kvs=() wins=() plist=() blist=() cav=() cdn=() coc=() cmtbf=() cmttr=() clg=() clc=() cpl=() cau=() cun=() crs=() cst=() cbt=()
    while IFS= read -r line; do
        case "$line" in
            win=*)
                w="${line#win=}"; w="${w%% *}"; wins+=("$w")
                read -ra kvs <<< "$line"
                for kv in "${kvs[@]}"; do A["$w.${kv%%=*}"]="${kv#*=}"; done ;;
            "P|"*) plist+=("$line") ;;
            "B|"*) blist+=("$line") ;;
        esac
    done < <(dgr_availability "$net" "$now")
    echo -e "${BOLD}${CYAN}── $net ─────────────────────────────────────${RESET}"
    _rec_net_status "$net" "$now"
    echo ""
    if (( ${#wins[@]} == 0 )); then echo "  (no ledger data)"; return 0; fi
    local up dn pl au un oc sti
    for w in "${wins[@]}"; do
        up=$(_dg_num "${A[$w.up]:-}"); dn=$(_dg_num "${A[$w.down]:-}"); pl=$(_dg_num "${A[$w.planned]:-}")
        au=$(_dg_num "${A[$w.auth]:-}"); un=$(_dg_num "${A[$w.unobs]:-}")
        oc=$(_dg_num "${A[$w.outages]:-}"); sti=$(_dg_num "${A[$w.started]:-}")
        cav+=("$(_rec_pct "$up" "$dn")")
        cdn+=("$(dgr_dur "$dn")")
        coc+=("$oc")
        if (( sti > 0 )); then cmtbf+=("$(dgr_dur $(( up / sti )))"); else cmtbf+=("no failure"); fi
        if (( oc > 0 )); then cmttr+=("$(dgr_dur $(( dn / oc )))"); else cmttr+=("-"); fi
        if [[ -n "${A[$w.longest]:-}" ]]; then
            if [[ "${A[$w.longest_open]:-0}" == 1 ]]; then clg+=("$(dgr_dur "${A[$w.longest]}")+ open"); else clg+=("$(dgr_dur "${A[$w.longest]}")"); fi
            clc+=("${A[$w.longest_class]:-?}")
        else
            clg+=("-"); clc+=("-")
        fi
        cpl+=("$(dgr_dur "$pl")"); cau+=("$(dgr_dur "$au")"); cun+=("$(dgr_dur "$un")")
        crs+=("${A[$w.r_watchdog]:-0} / ${A[$w.r_toolkit]:-0} / ${A[$w.r_unknown]:-0}")
        cst+=("${A[$w.stops]:-0}")
        if (( $(_dg_num "${A[$w.unclean]:-}") > 0 )); then cbt+=("${A[$w.boots]:-0} (${A[$w.unclean]} unclean)"); else cbt+=("${A[$w.boots]:-0}"); fi
    done
    printf '  %b%-26s' "$BOLD" ""; for w in "${wins[@]}"; do printf '%18s' "last $w d"; done; printf '%b\n' "$RESET"
    _rec_row "Availability"             "${cav[@]}"
    _rec_row "Counted down time"        "${cdn[@]}"
    _rec_row "Outages"                  "${coc[@]}"
    _rec_row "MTBF (up ÷ new outages)"  "${cmtbf[@]}"
    _rec_row "Mean time to recover"     "${cmttr[@]}"
    _rec_row "Longest outage"           "${clg[@]}"
    _rec_row "  its class"              "${clc[@]}"
    _rec_row "Planned / starting"       "${cpl[@]}"
    _rec_row "Auth fault (not judged)"  "${cau[@]}"
    _rec_row "Not observed"             "${cun[@]}"
    _rec_row "Restarts wd/toolkit/?"    "${crs[@]}"
    _rec_row "Planned stops"            "${cst[@]}"
    _rec_row "Host boots"               "${cbt[@]}"
    echo ""
    echo -e "  ${BOLD}Outages by class${RESET} ${DIM}(leans, not verdicts)${RESET}"
    for w in "${wins[@]}"; do
        cl="${A[$w.classes]:-}"; cl="${cl//,/ · }"; cl="${cl//:/ }"
        printf '    last %-4s %s\n' "$w d" "${cl:-none}"
    done
    echo ""
    echo -e "  ${BOLD}Planned stops${RESET} ${DIM}(last ${wins[-1]} d, newest first — recorded, never counted)${RESET}"
    if (( ${#plist[@]} == 0 )); then echo "    none"; fi
    for line in "${plist[@]}"; do
        IFS='|' read -r _ ts by rs <<< "$line"
        printf '    %s UTC  by %s%s\n' "$(dgr_utc_min "$ts")" "${by:-?}" "${rs:+ · $rs}"
    done
    echo ""
    echo -e "  ${BOLD}Host boots${RESET} ${DIM}(last ${wins[-1]} d, newest first)${RESET}"
    if (( ${#blist[@]} == 0 )); then echo "    none"; fi
    for line in "${blist[@]}"; do
        IFS='|' read -r _ ts cl <<< "$line"
        case "$cl" in true) cl="clean" ;; false) cl="UNCLEAN — a precursor of chain_data corruption" ;; *) cl="unknown" ;; esac
        printf '    %s UTC  previous shutdown %s\n' "$(dgr_utc_min "$ts")" "$cl"
    done
}

rec_availability() {
    _rec_banner "Availability"
    local -a nets=(); local net now report
    mapfile -t nets < <(dgr_nets)
    echo ""
    if (( ${#nets[@]} == 0 )); then info "No ledger yet — install the recorder (I) and give it a minute."; pause; return 0; fi
    info "Reading the ledger..."
    now=$(date +%s)
    report=$(
        for net in "${nets[@]}"; do echo ""; _rec_avail_net "$net" "$now"; done
        echo ""
        echo -e "  ${DIM}Availability = up ÷ (up + counted down). Planned stops, start and boot windows, auth${RESET}"
        echo -e "  ${DIM}faults and unobserved time (recorder not running, a gap) count as neither. A window${RESET}"
        echo -e "  ${DIM}the recorder only partly observed says so in 'Not observed'. Times UTC.${RESET}"
        ui_end "availability · nothing was changed"
    )
    _page <<< "$report"
    _end_pause
}

# ── 7.3 / 7.4 Evidence ───────────────────────────────────────────────────────
REC_BUNDLES=()
# Numbered list of bundles, newest first; fills REC_BUNDLES. rc 1 = none.
_rec_list_bundles() {
    local i name net path kb cls stamp
    mapfile -t REC_BUNDLES < <(dgr_bundles)
    if (( ${#REC_BUNDLES[@]} == 0 )); then info "No evidence bundles yet ($GNE_EVENTS_DIR/<net>/evidence/)."; return 1; fi
    for i in "${!REC_BUNDLES[@]}"; do
        IFS='|' read -r name net path kb cls <<< "${REC_BUNDLES[$i]}"
        stamp="${name:0:4}-${name:4:2}-${name:6:2} ${name:9:2}:${name:11:2} UTC"
        printf '  %b%3d%b)  %s  %-8s %b%-17s%b %9s\n' "$GREEN" $(( i + 1 )) "$RESET" "$stamp" "$net" \
            "$(_rec_class_col "$cls")" "$cls" "$RESET" "$(_rec_kb "$kb")"
    done
    return 0
}

rec_show_evidence() {
    _rec_banner "Show evidence"
    echo ""
    _rec_list_bundles || { pause; return 0; }
    echo ""
    local pick name net path kb cls report
    ui_ask pick "Bundle number" "1" || { info "Cancelled."; pause; return 0; }
    if [[ ! "$pick" =~ ^[0-9]+$ ]] || (( pick < 1 || pick > ${#REC_BUNDLES[@]} )); then warn "Invalid choice."; pause; return 0; fi
    IFS='|' read -r name net path kb cls <<< "${REC_BUNDLES[$(( pick - 1 ))]}"
    report=$(
        printf '  %b%s · %s%b  %b(%s)%b\n\n' "$BOLD" "$net" "$name" "$RESET" "$DIM" "$path" "$RESET"
        if [[ -f "$path/summary.txt" ]]; then sed 's/^/  /' "$path/summary.txt"; else echo "  (no summary.txt — the capture was cut short)"; fi
        echo ""
        echo -e "${BOLD}  Matched line${RESET}"
        if [[ -s "$path/match.txt" ]]; then cut -c1-300 "$path/match.txt" | sed 's/^/    /'; else echo "    none"; fi
        echo ""
        echo -e "${BOLD}  Lines a class rule keys on${RESET} ${DIM}(notable.txt, last 40)${RESET}"
        if [[ -s "$path/notable.txt" ]]; then tail -n 40 "$path/notable.txt" | cut -c1-300 | sed 's/^/    /'; else echo "    none"; fi
        echo ""
        echo -e "${BOLD}  Files${RESET} ${DIM}(read them with: less $path/<file>)${RESET}"
        if [[ -f "$path/manifest.txt" ]]; then sed 's/^/    /' "$path/manifest.txt"; else ls -l "$path" 2>/dev/null | sed 's/^/    /'; fi
        echo ""
        echo -e "  ${YELLOW}RAW: IP addresses and hostnames are NOT masked here. To share it, use 4) Export.${RESET}"
        ui_end "evidence bundle · nothing was changed"
    )
    _page <<< "$report"
    _end_pause
}

rec_export() {
    _rec_banner "Export for an upstream issue"
    echo ""
    echo -e "  Packs the bundles you pick into one .tar.gz for a GitHub issue. IP addresses"
    echo -e "  are masked fully, this host's name is replaced, and secrets and every token of"
    echo -e "  20+ characters (block hashes too) are redacted. The raw bundles stay as they are."
    echo ""
    _rec_list_bundles || { pause; return 0; }
    echo ""
    local sel tok i out
    local -a toks=() paths=()
    local -A seen=()
    ui_ask sel "Bundles to export (numbers separated by spaces, or all)" "1" || { info "Cancelled — nothing written."; pause; return 0; }
    if [[ "${sel,,}" == all ]]; then
        for i in "${!REC_BUNDLES[@]}"; do paths+=("$(cut -d'|' -f3 <<< "${REC_BUNDLES[$i]}")"); done
    else
        read -ra toks <<< "${sel//,/ }"
        for tok in "${toks[@]}"; do
            if [[ "$tok" =~ ^[0-9]+$ ]] && (( tok >= 1 && tok <= ${#REC_BUNDLES[@]} )); then
                [[ -z "${seen[$tok]:-}" ]] || continue
                seen[$tok]=1
                paths+=("$(cut -d'|' -f3 <<< "${REC_BUNDLES[$(( tok - 1 ))]}")")
            else
                warn "Ignored '$tok' — not a bundle number."
            fi
        done
    fi
    (( ${#paths[@]} )) || { warn "Nothing selected — nothing written."; pause; return 0; }
    mkdir -p "$LOG_DIR" 2>/dev/null || { error "Cannot create $LOG_DIR."; pause; return 1; }
    out="$LOG_DIR/grin_node_events_export_$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
    info "Masking and packing ${#paths[@]} bundle(s)..."
    dgr_export "$out" "${paths[@]}" || { pause; return 1; }
    log "[086] recorder export $out (${#paths[@]} bundles)"
    success "Written: $out  ($(du -h "$out" 2>/dev/null | cut -f1), mode 600)"
    echo ""
    echo -e "  ${DIM}Copy it off the box, from your own machine:${RESET}"
    echo -e "    scp root@$(hostname -f 2>/dev/null || hostname):$out ."
    echo -e "  ${YELLOW}Read it before posting it: hostnames and domains other than this box's are NOT masked.${RESET}"
    echo -e "  ${DIM}$LOG_DIR is aged out by hub 08's Disk Cleanup (key 7) — copy the file off soon.${RESET}"
    pause
}

rec_capture_now() {
    _rec_banner "Capture evidence now"
    echo ""
    dgr_installed || { warn "The recorder is not installed — use I) first."; pause; return 0; }
    local -a nets=(); local n net out
    for n in "${GNE_NETS[@]}"; do
        if gnc_resolve_node_dir "$n" >/dev/null 2>&1; then nets+=("$n"); fi
    done
    (( ${#nets[@]} )) || { warn "No network is registered in the instances conf."; pause; return 0; }
    net="${nets[0]}"
    if (( ${#nets[@]} > 1 )); then
        echo -e "  ${GREEN}1${RESET}) mainnet   ${GREEN}2${RESET}) testnet"
        ui_ask n "Network" "1" || { info "Cancelled."; pause; return 0; }
        case "${n,,}" in 1|mainnet) net=mainnet ;; 2|testnet) net=testnet ;; *) warn "Invalid choice."; pause; return 0 ;; esac
    fi
    echo ""
    echo -e "  Saves the node's tmux pane, its log window, kernel lines and host state for"
    echo -e "  ${BOLD}$net${RESET} into a new bundle. No event is recorded and the node is not touched."
    info "Capturing (up to 90 s)..."
    out=$(timeout 90 "$GNE_BIN" capture "$net" manual "requested from 086" 2>&1) || true
    if [[ "$out" == "$GNE_EVENTS_DIR"/* ]]; then
        success "Bundle: ${out%%$'\n'*}"
        if [[ "$out" == *$'\n'* ]]; then printf '  %s\n' "${out#*$'\n'}"; fi
        log "[086] recorder manual capture $net"
    else
        warn "No bundle was written for $net."
        if [[ -n "$out" ]]; then printf '  %s\n' "$out"; fi
        echo -e "  ${DIM}A busy lock (a check or a watchdog capture running) is the usual cause — try again.${RESET}"
    fi
    pause
}

# ── 7.5 Alert settings (recorder.conf) ───────────────────────────────────────
_rec_key_desc() {
    case "$1" in
        DOWN_STRIKES)          echo "failed 30 s checks in a row before DOWN" ;;
        START_TIMEOUT_MIN)     echo "minutes a start may take before failed_start" ;;
        MARKER_TTL_MIN)        echo "minutes a planned-stop marker stays valid" ;;
        GAP_FACTOR)            echo "x 30 s without a check = an unobserved gap" ;;
        EVIDENCE_BUNDLE_MB)    echo "size cap per evidence bundle (MB)" ;;
        EVIDENCE_TOTAL_MB)     echo "size cap for all bundles (MB)" ;;
        EVIDENCE_DAYS)         echo "bundles older than this are pruned (days)" ;;
        ALERT_DOWN_AFTER_MIN)  echo "outage minutes before the DOWN alert" ;;
        ALERT_LOOP_COUNT)      echo "watchdog restarts that make a restart loop" ;;
        ALERT_LOOP_WINDOW_MIN) echo "... within this many minutes" ;;
        ALERT_UNCLEAN_BOOT)    echo "1 = alert on an unclean host reboot" ;;
        *)                     echo "" ;;
    esac
}

# "set" / "off" / "half set" for a channel — names only, never values.
_rec_chan_state() { # <a> [b]
    local a="${1:-}" b="${2-x}"
    if [[ -n "$a" && -n "$b" ]]; then printf '%bset%b' "$GREEN" "$RESET"
    elif [[ -n "$a" || ( "$#" -gt 1 && -n "$b" ) ]]; then printf '%bhalf set — needs both%b' "$YELLOW" "$RESET"
    else printf '%boff%b' "$DIM" "$RESET"; fi
}

_rec_set_ntfy() {
    local v
    echo -e "  ${DIM}e.g. https://ntfy.sh/<a long random topic>. The topic URL is the credential.${RESET}"
    _rec_ask_secret v "ntfy topic URL" || { info "Cancelled — nothing changed."; return 0; }
    [[ "${v,,}" == off ]] && v=""
    gne_set_channel NTFY_URL "$v" && success "ntfy: $([[ -n "$v" ]] && echo set || echo off)."
    return 0
}
_rec_set_telegram() {
    local tok cid
    echo -e "  ${DIM}Bot token from @BotFather (<digits>:<token>), then the chat id (a number or @channel).${RESET}"
    _rec_ask_secret tok "Telegram bot token" || { info "Cancelled — nothing changed."; return 0; }
    if [[ "${tok,,}" == off ]]; then
        gne_set_channel TG_BOT_TOKEN "" && gne_set_channel TG_CHAT_ID "" && success "Telegram: off."
        return 0
    fi
    gne_chan_valid TG_BOT_TOKEN "$tok" || { error "That is not a bot token (<digits>:<token>) — nothing changed."; return 0; }
    ui_ask cid "Telegram chat id" || { info "Cancelled — nothing changed."; return 0; }
    gne_chan_valid TG_CHAT_ID "$cid" || { error "A chat id is a number or @name — nothing changed."; return 0; }
    gne_set_channel TG_BOT_TOKEN "$tok" && gne_set_channel TG_CHAT_ID "$cid" && success "Telegram: set."
    return 0
}
_rec_set_email() {
    local v
    if ! command -v sendmail >/dev/null 2>&1 && ! command -v mail >/dev/null 2>&1 && ! command -v msmtp >/dev/null 2>&1; then
        warn "No sendmail, mail or msmtp on this box — email alerts cannot be delivered until one is installed."
    fi
    ui_ask v "Email address (off = turn email off)" || { info "Cancelled — nothing changed."; return 0; }
    [[ "${v,,}" == off ]] && v=""
    gne_set_channel MAIL_TO "$v" && success "Email: $([[ -n "$v" ]] && echo set || echo off)."
    return 0
}
_rec_set_nostr() {
    local sk relay
    if ! command -v nak >/dev/null 2>&1 && ! { command -v nostril >/dev/null 2>&1 && command -v websocat >/dev/null 2>&1; }; then
        warn "Neither nak nor nostril + websocat is installed — Nostr alerts cannot be signed until one is."
    fi
    echo -e "  ${DIM}A key used ONLY for alerts (nsec1… or 64 hex). It is in argv for the length of one send.${RESET}"
    _rec_ask_secret sk "Nostr secret key" || { info "Cancelled — nothing changed."; return 0; }
    if [[ "${sk,,}" == off ]]; then
        gne_set_channel NOSTR_SK "" && gne_set_channel NOSTR_RELAY "" && success "Nostr: off."
        return 0
    fi
    gne_chan_valid NOSTR_SK "$sk" || { error "Not an nsec1… or 64-hex key — nothing changed."; return 0; }
    ui_ask relay "Relay URL" "wss://relay.damus.io" || { info "Cancelled — nothing changed."; return 0; }
    gne_chan_valid NOSTR_RELAY "$relay" || { error "A relay URL starts with wss:// or ws:// — nothing changed."; return 0; }
    gne_set_channel NOSTR_SK "$sk" && gne_set_channel NOSTR_RELAY "$relay" && success "Nostr: set."
    return 0
}

_rec_test_alert() {
    echo ""
    if dgr_installed; then
        timeout 90 "$GNE_BIN" test-alert || warn "No channel accepted the test alert (see the lines above)."
    else
        info "The recorder is not installed — testing from this toolkit checkout instead."
        gne_worker_test_alert || warn "No channel accepted the test alert (see the lines above)."
    fi
    log "[086] recorder test alert sent"
    return 0
}

_rec_thresholds() {
    local -a specs=(); local i key def min max cur pick val vn nets_now
    while true; do
        _rec_banner "Thresholds"
        gne_conf_load
        mapfile -t specs < <(gne_num_specs)
        echo ""
        for i in "${!specs[@]}"; do
            read -r key def min max <<< "${specs[$i]}"
            vn="GNE_C_$key"; cur="${!vn:-$def}"
            printf '  %b%2d%b) %-22s %6s  %b(default %s, %s–%s) %s%b\n' "$GREEN" $(( i + 1 )) "$RESET" "$key" "$cur" \
                "$DIM" "$def" "$min" "$max" "$(_rec_key_desc "$key")" "$RESET"
        done
        printf '  %b N%b) %-22s %6s\n' "$GREEN" "$RESET" "ENABLED_NETS" "${GNE_C_ENABLED_NETS:-}"
        echo -e "   ${DIM}0) Back${RESET}"
        echo ""
        echo -e "  ${DIM}The worker re-reads recorder.conf on every check — no restart needed.${RESET}"
        ui_ask pick "Setting to change" || return 0
        case "${pick,,}" in
            0) return 0 ;;
            n)
                echo -e "  ${GREEN}1${RESET}) mainnet + testnet   ${GREEN}2${RESET}) mainnet only   ${GREEN}3${RESET}) testnet only"
                ui_ask val "Networks to watch" "1" || continue
                case "$val" in 1) nets_now="mainnet testnet" ;; 2) nets_now="mainnet" ;; 3) nets_now="testnet" ;; *) warn "Invalid choice."; sleep 1; continue ;; esac
                gne_conf_set ENABLED_NETS "$nets_now" && success "ENABLED_NETS=$nets_now" && log "[086] recorder ENABLED_NETS=$nets_now"
                sleep 1 ;;
            *)
                if [[ ! "$pick" =~ ^[0-9]+$ ]] || (( pick < 1 || pick > ${#specs[@]} )); then warn "Invalid choice."; sleep 1; continue; fi
                read -r key def min max <<< "${specs[$(( pick - 1 ))]}"
                vn="GNE_C_$key"; cur="${!vn:-$def}"
                ui_ask_num val "$key" "$cur" "$min" "$max" || continue
                gne_set_num "$key" "$val" && success "$key=$val" && log "[086] recorder $key=$val"
                sleep 1 ;;
        esac
    done
}

rec_alert_settings() {
    local c w ch
    while true; do
        _rec_banner "Alert settings"
        gne_conf_load
        echo ""
        echo -e "  ${DIM}$GNE_CONF (0600). Values are never shown.${RESET}"
        echo ""
        printf '  ntfy      %s\n' "$(_rec_chan_state "${GNE_C_NTFY_URL:-}")"
        printf '  Telegram  %s\n' "$(_rec_chan_state "${GNE_C_TG_BOT_TOKEN:-}" "${GNE_C_TG_CHAT_ID:-}")"
        printf '  Email     %s\n' "$(_rec_chan_state "${GNE_C_MAIL_TO:-}")"
        printf '  Nostr     %s\n' "$(_rec_chan_state "${GNE_C_NOSTR_SK:-}" "${GNE_C_NOSTR_RELAY:-}")"
        ch=$(_gne_alert_channels)
        if [[ -n "$ch" ]]; then echo -e "  ${GREEN}Active:${RESET} $ch"; else echo -e "  ${YELLOW}No channel active — alerts are off; recording is unaffected.${RESET}"; fi
        if [[ -n "${GNE_CONF_WARNINGS:-}" ]]; then
            while IFS= read -r w; do [[ -n "$w" ]] && printf '  %b!%b %s\n' "$YELLOW" "$RESET" "$w"; done <<< "$GNE_CONF_WARNINGS"
        fi
        echo ""
        echo -e "  ${DIM}Sent: DOWN after ${GNE_C_ALERT_DOWN_AFTER_MIN} min · CORRUPTED at once · restart loop (${GNE_C_ALERT_LOOP_COUNT} in ${GNE_C_ALERT_LOOP_WINDOW_MIN} min)${RESET}"
        echo -e "  ${DIM}· recovery after a DOWN · unclean host reboot ($([[ "$GNE_C_ALERT_UNCLEAN_BOOT" == 1 ]] && echo on || echo off)). One outage = one DOWN + one recovery.${RESET}"
        echo ""
        echo -e "  ${GREEN}1${RESET}) ntfy topic URL"
        echo -e "  ${GREEN}2${RESET}) Telegram bot token + chat id"
        echo -e "  ${GREEN}3${RESET}) Email address"
        echo -e "  ${GREEN}4${RESET}) Nostr key + relay"
        echo -e "  ${CYAN}5${RESET}) Import channels from Provider Access Watch  ${DIM}(hub 08 → 2; copies, never links)${RESET}"
        echo -e "  ${CYAN}6${RESET}) Send a test alert"
        echo -e "  ${CYAN}7${RESET}) Thresholds & networks"
        echo -e "  ${DIM}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [0-7]: ${RESET}"
        read -r c || return 0
        case "$c" in
            1) echo ""; _rec_set_ntfy     || true; sleep 1 ;;
            2) echo ""; _rec_set_telegram || true; sleep 1 ;;
            3) echo ""; _rec_set_email    || true; sleep 1 ;;
            4) echo ""; _rec_set_nostr    || true; sleep 1 ;;
            5) echo ""; gne_import_alert_channels || true; log "[086] recorder alert channels imported"; pause ;;
            6) _rec_test_alert || true; pause ;;
            7) _rec_thresholds || true ;;
            0) return 0 ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# ── 7.I / 7.R / 7.S ──────────────────────────────────────────────────────────
rec_install() {
    _rec_banner "Install / refresh"
    echo ""
    echo -e "  Installs, or refreshes to this toolkit version:"
    echo -e "    ${CYAN}$GNE_BIN${RESET}   the worker ${DIM}(read-only: never starts, stops or signals a node)${RESET}"
    echo -e "    ${CYAN}grin-node-events.timer${RESET}          every 30 s"
    echo -e "    ${CYAN}$GNE_CONF${RESET}   ${DIM}only if absent — your settings are kept${RESET}"
    echo -e "    ${CYAN}$GNE_LIB_INSTALL_DIR/${RESET}   ${DIM}copies of the libs the worker runs from${RESET}"
    echo -e "  It records to ${CYAN}$GNE_EVENTS_DIR/<net>/${RESET} (ledger, status, evidence)."
    echo ""
    _rec_yes "Install / refresh the node event recorder now?" || { info "Cancelled — nothing changed."; pause; return 0; }
    gne_install || { error "The install did not complete — see the messages above."; pause; return 1; }
    log "[086] recorder installed/refreshed"
    case "$(_rec_watchdog_hook_state)" in
        old)
            echo ""
            warn "The node-sync watchdog here predates the recorder's capture hook: its next"
            warn "restart would destroy the node's tmux pane (the panic text) before it is saved."
            if _rec_yes "Regenerate the watchdog worker now (its config and state are kept)?"; then
                if gnk_watchdog_install; then log "[086] watchdog regenerated for the capture hook"; else warn "Watchdog regeneration failed — run this option again later."; fi
            else
                info "Kept the old watchdog worker — its restarts will not be captured."
            fi ;;
        none)
            info "No node-sync watchdog on this box: nothing restarts a failed node (Script 01 Super Auto installs one)." ;;
    esac
    pause
}

rec_remove() {
    _rec_banner "Remove"
    echo ""
    if ! dgr_installed && [[ ! -f "$GNE_TIMER" ]]; then info "The recorder is not installed."; pause; return 0; fi
    echo -e "  Stops the timer and removes the worker, its units, the logrotate stanza and the"
    echo -e "  lib copies. ${BOLD}Kept:${RESET} the ledger, status and evidence ($GNE_EVENTS_DIR) and"
    echo -e "  the config ($GNE_CONF). Full Grin Cleanup (hub 08 → DEL) removes those, and asks"
    echo -e "  about the evidence first."
    echo ""
    _rec_no "Remove the node event recorder?" || { info "Cancelled — nothing changed."; pause; return 0; }
    gne_remove || { pause; return 1; }
    log "[086] recorder removed"
    pause
}

rec_status() {
    _rec_banner "Status"
    echo ""
    gne_status
    case "$(_rec_watchdog_hook_state)" in
        hooked) success "Sync watchdog: captures evidence before each restart." ;;
        old)    warn "Sync watchdog: predates the capture hook — I) Install / refresh offers to regenerate it." ;;
        none)   info "Sync watchdog: not installed." ;;
    esac
    echo ""
    echo -e "  ${DIM}Raw view: $GNE_BIN show   ·   timer: systemctl list-timers grin-node-events.timer${RESET}"
    pause
}

rec_menu() {
    local c now net
    while true; do
        _rec_banner
        now=$(date +%s)
        echo ""
        echo -e "  ${DIM}Records each down/up of the node, keeps planned stops out of the count and saves${RESET}"
        echo -e "  ${DIM}evidence at the moment of failure. Read-only: it never restarts a node.${RESET}"
        echo ""
        if dgr_installed && dgr_timer_active; then
            printf '  %-9s %b%s%b\n' "recorder" "$GREEN" "installed · timer active" "$RESET"
        elif dgr_installed; then
            printf '  %-9s %b%s%b\n' "recorder" "$YELLOW" "installed · timer NOT active (S = status)" "$RESET"
        else
            printf '  %-9s %b%s%b\n' "recorder" "$YELLOW" "NOT installed — I) installs it" "$RESET"
        fi
        for net in $(dgr_nets); do _rec_net_status "$net" "$now"; done
        echo ""
        echo -e "${BOLD}  View${RESET}"
        echo -e "  ${GREEN}1${RESET})  Timeline                  ${DIM}last events per network${RESET}"
        echo -e "  ${GREEN}2${RESET})  Availability              ${DIM}uptime % · outages by class · MTBF · 7 / 30 / 90 d${RESET}"
        echo -e "  ${GREEN}3${RESET})  Show evidence             ${DIM}pick a bundle · summary + matched lines${RESET}"
        echo -e "  ${GREEN}4${RESET})  Export for upstream       ${DIM}masked .tar.gz for a GitHub issue${RESET}"
        echo -e "  ${CYAN}C${RESET})  Capture evidence now      ${DIM}a bundle on demand · no event recorded${RESET}"
        echo ""
        echo -e "${BOLD}  Set up${RESET}"
        echo -e "  ${CYAN}5${RESET})  Alert settings            ${DIM}channels · import · test · thresholds${RESET}"
        echo -e "  ${CYAN}I${RESET})  Install / refresh"
        echo -e "  ${YELLOW}R${RESET})  Remove                    ${DIM}keeps the ledger, evidence and config${RESET}"
        echo -e "  ${CYAN}S${RESET})  Status"
        echo -e "  ${DIM}0${RESET})  Back to Diagnostics"
        echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -ne "${BOLD}Select [1-5 / C I R S / 0]: ${RESET}"
        read -r c || return 0
        # Every arm ||-guarded, as in main().
        case "${c,,}" in
            1) rec_timeline       || true ;;
            2) rec_availability   || true ;;
            3) rec_show_evidence  || true ;;
            4) rec_export         || true ;;
            c) rec_capture_now    || true ;;
            5) rec_alert_settings || true ;;
            i) rec_install        || true ;;
            r) rec_remove         || true ;;
            s) rec_status         || true ;;
            0) return 0 ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
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
    echo -e "${BOLD}  Over time${RESET}"
    echo -e "  ${CYAN}7${RESET})   Node event recorder       ${DIM}timeline · availability % · evidence · alerts${RESET}"
    echo ""
    echo -e "  ${DIM}6${RESET})   Saved reports             ${DIM}list · delete old${RESET}"
    echo -e "  ${DIM}0${RESET})   Return to admin centre"
    echo ""
    echo -e "  ${DIM}Read-only except option 5 (and 7's install/settings). Reports: $REPORT_DIR${RESET}"
    echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -ne "${BOLD}Select [0-7]: ${RESET}"
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
            "7") rec_menu           || true ;;
            "0") break ;;
            *)   warn "Invalid option." ; sleep 1 ;;
        esac
    done
    log "[086] exited"
}

main "$@"
