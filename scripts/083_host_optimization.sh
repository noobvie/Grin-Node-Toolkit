#!/bin/bash
# =============================================================================
# 083_host_optimization.sh - Host Optimization & Hardening advisor
# =============================================================================
# Profiles the VPS (CPU, RAM, disk/IO, kernel, time, logging, firewall, SSH)
# and reports what a Grin node actually needs from this particular box —
# sized from measured facts rather than from a generic tuning table.
#
# ⚠ READ-ONLY BY DESIGN. This tool changes nothing. Every finding carries the
# exact command that would fix it, for the operator to run and review.
#
# WHY no apply button (yet): this is a remote VPS. A wrong sysctl is
# recoverable; `ufw enable` issued before an SSH allow-rule is a box you can
# only reach from the provider's console. The advisor gets to run against real
# nodes first — once the recommendations are shown to hold, guarded per-item
# apply paths can be added behind explicit consent, each recording the value it
# replaced. Suggest, verify, then automate.
#
# SSH is reported here but never edited here. 085_ssh_hardening.sh owns every
# SSH change — it stages them, validates with `sshd -t`, reloads instead of
# restarting, and offers a dead-man timer. A second path to the same change
# would be a worse path, so this screen only tells you whether to go there.
#
# Menu key 3 in hub 08. See docs/generated/script083_design.md.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Paths ────────────────────────────────────────────────────────────────────
LOG_DIR="/opt/grin/logs"
LOG_FILE="$LOG_DIR/grin_host_optimization_$(date +%Y%m%d_%H%M%S).log"
REPORT_DIR="/opt/grin/reports"
mkdir -p "$LOG_DIR" "$REPORT_DIR" 2>/dev/null || true

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
# Read-only, but several probes (sshd -T, ufw status, apt -s, iptables -S)
# return nothing useful as a non-root user, which would render a healthy box as
# a pile of "unknown" findings. Refuse rather than report something misleading.
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
    error "This tool must run as root (its probes read root-only system state)."
    exit 1
fi

# ─── Shared libs ──────────────────────────────────────────────────────────────
# grin_node_secrets.sh supplies grin_live_node_dir(), used to size the per-node
# peer limit against the node that is actually running.
source "$SCRIPT_DIR/lib/grin_node_secrets.sh"
source "$SCRIPT_DIR/lib/083_lib_profile.sh"
source "$SCRIPT_DIR/lib/083_lib_advice.sh"

# =============================================================================
# Rendering
# =============================================================================
_sev_badge() {
    case "$1" in
        CRIT) echo -e "${RED}${BOLD}[CRIT]${RESET}" ;;
        WARN) echo -e "${YELLOW}[WARN]${RESET}" ;;
        INFO) echo -e "${CYAN}[INFO]${RESET}" ;;
        OK)   echo -e "${GREEN}[ OK ]${RESET}" ;;
        NA)   echo -e "${DIM}[ NA ]${RESET}" ;;
        *)    echo "[????]" ;;
    esac
}

# Wraps recommendation prose to the terminal width, indented under its finding.
# COLUMNS is set by INTERACTIVE shells only, so it is unset in a `bash script.sh`
# child — ask the terminal directly and keep COLUMNS as the second choice.
_wrap() {
    local text="$1" indent="        " width
    width=$(tput cols 2>/dev/null || true)
    [[ "$width" =~ ^[0-9]+$ ]] || width="${COLUMNS:-100}"
    width=$(( width - 10 ))
    (( width < 50 )) && width=50
    echo "$text" | fold -s -w "$width" | while IFS= read -r l; do
        echo -e "${indent}${DIM}${l}${RESET}"
    done
}

# Prints every finding in one area, or nothing at all if that area is empty.
_render_area() {
    local want="$1" i printed=0
    for i in "${!ADV_SEV[@]}"; do
        [[ "${ADV_AREA[$i]}" == "$want" ]] || continue
        if (( printed == 0 )); then
            echo ""
            echo -e "${BOLD}${CYAN}── ${want} ────────────────────────────────────────────${RESET}"
            printed=1
        fi
        echo -e "  $(_sev_badge "${ADV_SEV[$i]}")  ${BOLD}${ADV_TITLE[$i]}${RESET}"
        echo -e "        ${ADV_OBS[$i]}"
        [[ -n "${ADV_REC[$i]}" ]] && _wrap "${ADV_REC[$i]}"
        if [[ -n "${ADV_FIX[$i]}" ]]; then
            echo -e "        ${GREEN}fix:${RESET} ${ADV_FIX[$i]}"
        fi
        echo ""
    done
}

_render_summary() {
    local c w i o n
    c=$(adv_count_sev CRIT); w=$(adv_count_sev WARN)
    i=$(adv_count_sev INFO); o=$(adv_count_sev OK); n=$(adv_count_sev NA)
    echo ""
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}  Summary${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "  ${RED}${BOLD}${c} critical${RESET}   ${YELLOW}${w} warning${RESET}   ${CYAN}${i} info${RESET}   ${GREEN}${o} ok${RESET}   ${DIM}${n} n/a${RESET}"
    echo ""
    # Zero findings is NOT a clean bill of health - it means no check produced a
    # result, which on this tool can only happen if the probes themselves failed.
    # Reporting that as "good shape" would be the worst possible lie for a
    # hardening advisor to tell, so it is called out as a broken run instead.
    if (( ${#ADV_SEV[@]} == 0 )); then
        echo -e "  ${YELLOW}No checks produced a result — the profile did not run correctly.${RESET}"
        echo -e "  ${DIM}This is not a pass. Check $LOG_FILE and confirm you are running as root.${RESET}"
    elif (( c > 0 )); then
        echo -e "  ${RED}${BOLD}Address the critical findings before exposing this node.${RESET}"
    elif (( w > 0 )); then
        echo -e "  ${YELLOW}No critical issues. The warnings above will bite under load or on reboot.${RESET}"
    else
        echo -e "  ${GREEN}No critical or warning findings — this box is in good shape for a Grin node.${RESET}"
    fi
    echo ""
    echo -e "  ${DIM}Nothing was changed. Every 'fix:' line is yours to run and review.${RESET}"
    log "[083] summary crit=$c warn=$w info=$i ok=$o na=$n"
}

# =============================================================================
# Screens
# =============================================================================
_banner() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 083)  Host Optimization & Hardening${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
}

# The full report runs to ~100 lines — longer than a terminal — and the CRIT
# findings sort to the top, so they are the first thing to scroll away unread.
# Page it, using the same `less -FRX` the rest of the toolkit uses: -F prints
# and exits when it already fits, -R keeps the colour, -X leaves the text in the
# terminal's own scrollback instead of wiping it on quit.
_page() {
    if [[ -t 1 ]] && command -v less >/dev/null 2>&1; then
        less -FRX
    else
        cat
    fi
}

show_full_report() {
    _banner
    echo -e "${DIM}  Profiling this host — read-only, nothing will be changed.${RESET}"
    echo ""
    info "Gathering system facts..."
    adv_run_all
    _banner
    {
        echo -e "  ${DIM}Host: $(hostname 2>/dev/null || echo unknown)   ·   virt: $(hp_virt)   ·   $(date -u '+%Y-%m-%d %H:%M UTC')${RESET}"
        local area
        for area in CPU Memory Kernel Disk Node Time Logs Security SSH; do
            _render_area "$area"
        done
        _render_summary
        echo -e "  ${DIM}Log: $LOG_FILE${RESET}"
    } | _page
    pause
}

# Plain-text copy of the same report, for pasting into an issue or keeping
# alongside a build. Colour codes are stripped rather than written to file.
export_report() {
    _banner
    echo ""
    info "Running the profile for export..."
    adv_run_all

    local out="$REPORT_DIR/host_optimization_$(date +%Y%m%d_%H%M%S).txt"
    {
        echo "Grin Node Toolkit — Host Optimization & Hardening report"
        echo "Host: $(hostname 2>/dev/null || echo unknown)"
        echo "Virt: $(hp_virt)"
        echo "Date: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
        echo "NOTE: advisory only — this tool changed nothing on this host."
        echo ""
        local i
        for i in "${!ADV_SEV[@]}"; do
            # %-4s inside the brackets so [OK]/[NA] line their area column up
            # with [CRIT]/[WARN]/[INFO] instead of shifting it two columns left.
            printf '[%-4s] %-8s %s\n' "${ADV_SEV[$i]}" "${ADV_AREA[$i]}" "${ADV_TITLE[$i]}"
            printf '           observed: %s\n' "${ADV_OBS[$i]}"
            [[ -n "${ADV_REC[$i]}" ]] && printf '           advice  : %s\n' "${ADV_REC[$i]}"
            [[ -n "${ADV_FIX[$i]}" ]] && printf '           fix     : %s\n' "${ADV_FIX[$i]}"
            echo ""
        done
        echo "Summary: $(adv_count_sev CRIT) critical, $(adv_count_sev WARN) warning, $(adv_count_sev INFO) info, $(adv_count_sev OK) ok, $(adv_count_sev NA) n/a"
    } > "$out" 2>/dev/null || { error "Could not write $out"; pause; return 1; }

    chmod 600 "$out" 2>/dev/null || true
    success "Report written: $out"
    echo -e "  ${DIM}Mode 600 — it lists open ports and firewall state, so treat it as sensitive.${RESET}"
    log "[083] exported $out"
    pause
}

# Focused re-run of one or more related areas, for iterating on a single fix
# without rescrolling the whole report.
#
# VARIADIC on purpose: two menu rows cover a pair of areas ("CPU & memory",
# "Kernel & node limits"). Calling this once per area would profile the whole
# host twice AND make the operator clear two separate Enter prompts for what
# the menu presented as one item.
show_single_area() {
    local areas=("$@") area
    _banner
    info "Checking: ${areas[*]}"
    adv_run_all
    _banner
    {
        for area in "${areas[@]}"; do
            _render_area "$area"
        done
        echo -e "  ${DIM}Nothing was changed.${RESET}"
    } | _page
    pause
}

# Hands off to 085 — the only place SSH is ever modified.
open_ssh_hardening() {
    local ssh_script="$SCRIPT_DIR/085_ssh_hardening.sh"
    if [[ ! -f "$ssh_script" ]]; then
        error "085_ssh_hardening.sh not found in $SCRIPT_DIR"
        pause; return 1
    fi
    # Invoked through `bash` explicitly, so the exec bit is irrelevant — and a
    # tool that advertises "changes nothing" should not be chmod'ing files.
    bash "$ssh_script" || true
}

# =============================================================================
# Menu
# =============================================================================
show_menu() {
    _banner
    echo ""
    echo -e "  ${DIM}Profiles this VPS and reports what a Grin node needs from it.${RESET}"
    echo -e "  ${DIM}Advisory only — nothing on this host is changed.${RESET}"
    echo ""
    echo -e "${BOLD}  Report${RESET}"
    echo -e "  ${GREEN}1${RESET})   Full report               ${DIM}every check, grouped by area${RESET}"
    echo -e "  ${GREEN}2${RESET})   Export report to file     ${DIM}plain text, for pasting or keeping${RESET}"
    echo ""
    echo -e "${BOLD}  Single area${RESET}"
    echo -e "  ${CYAN}3${RESET})   CPU & memory              ${DIM}cores, steal, RAM, swap sizing${RESET}"
    echo -e "  ${CYAN}4${RESET})   Disk & IO                 ${DIM}space, device type, scheduler, atime${RESET}"
    echo -e "  ${CYAN}5${RESET})   Kernel & node limits      ${DIM}sysctl, THP, fd limits, peer count${RESET}"
    echo -e "  ${CYAN}6${RESET})   Security & firewall       ${DIM}ufw, exposed node API, updates${RESET}"
    echo ""
    echo -e "${BOLD}  Hardening${RESET}"
    echo -e "  ${YELLOW}7${RESET})   SSH posture               ${DIM}read-only summary of SSH config${RESET}"
    echo -e "  ${YELLOW}8${RESET})   SSH Key Hardening →       ${DIM}open the SSH tool (makes changes)${RESET}"
    echo ""
    echo -e "  ${DIM}0${RESET})   Return to admin centre"
    echo ""
    echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -ne "${BOLD}Select [0-8]: ${RESET}"
}

main() {
    log "[083] started"
    while true; do
        show_menu
        read -r choice
        # Every arm is ||-guarded: under `set -e` an unguarded non-zero return
        # from a menu function would kill this script instead of returning here.
        # `0)` is exempt — break must not be guarded.
        case "${choice,,}" in
            "1") show_full_report            || true ;;
            "2") export_report               || true ;;
            "3") show_single_area CPU Memory || true ;;
            "4") show_single_area Disk       || true ;;
            "5") show_single_area Kernel Node || true ;;
            "6") show_single_area Security   || true ;;
            "7") show_single_area SSH        || true ;;
            "8") open_ssh_hardening          || true ;;
            "0") break ;;
            *)   warn "Invalid option." ; sleep 1 ;;
        esac
    done
    log "[083] exited"
}

main "$@"
