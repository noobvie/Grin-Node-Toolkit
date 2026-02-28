#!/bin/bash
# =============================================================================
# 081_host_monitor_port.sh - Grin Remote Node Port Monitor
# =============================================================================
# Checks TCP reachability of configured Grin node endpoints.
# Can run standalone (interactive) or be scheduled via cron.
#
# Usage:
#   ./081_host_monitor_port.sh                         interactive check
#   ./081_host_monitor_port.sh --email addr@host.com   email on state change
#   ./081_host_monitor_port.sh --email addr --force    always email
#   ./081_host_monitor_port.sh --reconfigure           rebuild host list
#
# Cron example (every 5 minutes, email on change):
#   */5 * * * * /path/to/scripts/081_host_monitor_port.sh --email admin@example.com
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_DIR="$SCRIPT_DIR/../conf"
LOG_DIR="$SCRIPT_DIR/../log"
CONF_FILE="$CONF_DIR/host_monitor_port.conf"
STATE_FILE="$CONF_DIR/host_monitor_last_state.conf"
LOG_FILE="$LOG_DIR/grin_nodes_status_$(date +%Y%m%d_%H%M%S).log"

# ─── Colors (disabled when not a terminal) ────────────────────────────────────
if [[ -t 1 ]]; then
    RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
    CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; DIM=''; RESET=''
fi

# ─── Logging ──────────────────────────────────────────────────────────────────
mkdir -p "$LOG_DIR" "$CONF_DIR"

log()     { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE"; }
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; }

# ─── Runtime state (global associative arrays) ────────────────────────────────
declare -A RESULTS      # key="host:port"  → "UP" or "DOWN"
declare -A LABELS       # key="host:port"  → human label
declare -A LAST_STATE   # key="host:port"  → last known status
declare -a CHANGES=()   # list of human-readable change strings

# ─── Arguments ────────────────────────────────────────────────────────────────
EMAIL=""
FORCE_EMAIL=false
RECONFIGURE=false

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --email)       EMAIL="$2"; shift 2 ;;
            --force)       FORCE_EMAIL=true;  shift ;;
            --reconfigure) RECONFIGURE=true;  shift ;;
            *) shift ;;
        esac
    done
}

# =============================================================================
# Helper: find PID listening on a given TCP port (lsof / ss / netstat fallback)
# =============================================================================
_get_pid_on_port() {
    local port="$1"
    local pid
    if command -v lsof &>/dev/null; then
        pid=$(lsof -tni :"$port" -sTCP:LISTEN 2>/dev/null | head -1)
        [[ -n "$pid" ]] && echo "$pid" && return 0
    fi
    if command -v ss &>/dev/null; then
        pid=$(ss -tlnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' | head -1)
        [[ -n "$pid" ]] && echo "$pid" && return 0
    fi
    if command -v netstat &>/dev/null; then
        pid=$(netstat -tlnp 2>/dev/null | grep ":$port " | grep -oP '[0-9]+/.*' | cut -d'/' -f1 | head -1)
        [[ -n "$pid" ]] && echo "$pid" && return 0
    fi
    return 1
}

# =============================================================================
# Show locally running Grin instances (reference info during setup)
# =============================================================================
show_local_grin_instances() {
    echo -e "  ${BOLD}Local Grin instances detected (for reference):${RESET}"
    local found=0
    for port_info in "3414:Mainnet" "13414:Testnet"; do
        local port label pid binary
        port="${port_info%%:*}"
        label="${port_info##*:}"
        pid=$(_get_pid_on_port "$port" 2>/dev/null) || true
        if [[ -n "$pid" ]]; then
            binary=$(readlink -f "/proc/$pid/exe" 2>/dev/null) || binary="(could not resolve)"
            echo -e "    ${GREEN}●${RESET} $label  port $port  —  $binary"
            found=$((found + 1))
        fi
    done
    [[ $found -eq 0 ]] && echo -e "    ${DIM}(no local grin process detected)${RESET}"
    echo ""
}

# =============================================================================
# Setup — prompt user to build conf file if missing or --reconfigure requested
# =============================================================================
setup_conf() {
    if [[ -f "$CONF_FILE" && "$RECONFIGURE" == false ]]; then
        return 0
    fi

    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Configure Grin Node Monitor${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    show_local_grin_instances
    echo -e "  Enter the Grin nodes you want to monitor."
    echo -e "  Format: ${BOLD}ip_or_domain  port  [optional label]${RESET}"
    echo ""
    echo -e "  ${DIM}Examples:${RESET}"
    echo -e "  ${DIM}  1.2.3.4 3414 FriendNode${RESET}"
    echo -e "  ${DIM}  grinmain.example.com 3414 MainnetPublic${RESET}"
    echo -e "  ${DIM}  grintest.example.com 13414 TestnetPublic${RESET}"
    echo ""
    echo -e "  ${BOLD}Input mode:${RESET}"
    echo -e "  ${GREEN}1${RESET}) One by one (interactive)"
    echo -e "  ${GREEN}2${RESET}) Paste all at once (end with an empty line)"
    echo ""
    echo -ne "${BOLD}Select [1/2]: ${RESET}"
    local mode
    read -r mode
    [[ "$mode" != "2" ]] && mode="1"
    echo ""

    local tmp_file
    tmp_file="$(mktemp)"
    {
        echo "# Grin node hosts to monitor"
        echo "# Format: ip_or_domain  port  [optional label]"
        echo "# Generated: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
        echo ""
    } > "$tmp_file"

    local count=0

    if [[ "$mode" == "2" ]]; then
        echo -e "  ${CYAN}Paste your entries below, then press Enter on an empty line:${RESET}"
        echo ""
        while IFS= read -r entry; do
            [[ -z "$entry" ]] && break
            local h p
            h=$(awk '{print $1}' <<< "$entry")
            p=$(awk '{print $2}' <<< "$entry")
            if [[ -z "$p" ]]; then
                warn "  Skipped (missing port): $entry"
                continue
            fi
            if ! [[ "$p" =~ ^[0-9]+$ ]]; then
                warn "  Skipped (port not numeric): $entry"
                continue
            fi
            echo "$entry" >> "$tmp_file"
            count=$((count + 1))
            success "  Added: $h:$p"
        done
    else
        while true; do
            echo -ne "  Host $((count + 1)) (or Enter to finish): "
            read -r entry
            [[ -z "$entry" ]] && break
            local h p
            h=$(awk '{print $1}' <<< "$entry")
            p=$(awk '{print $2}' <<< "$entry")
            if [[ -z "$p" ]]; then
                warn "  Format must be: ip_or_domain port [label]"
                continue
            fi
            if ! [[ "$p" =~ ^[0-9]+$ ]]; then
                warn "  Port must be numeric."
                continue
            fi
            echo "$entry" >> "$tmp_file"
            count=$((count + 1))
            success "  Added: $h:$p"
        done
    fi

    if [[ $count -eq 0 ]]; then
        warn "No hosts entered. Config not saved."
        rm -f "$tmp_file"
        return 1
    fi

    mv "$tmp_file" "$CONF_FILE"
    success "Saved $count host(s) to $CONF_FILE"
    echo ""
    return 0
}

# =============================================================================
# Port check — nc preferred, telnet fallback
# =============================================================================
check_port() {
    local host="$1" port="$2"
    if command -v nc &>/dev/null; then
        nc -z -w 3 "$host" "$port" 2>/dev/null && echo "UP" || echo "DOWN"
    elif command -v timeout &>/dev/null && command -v bash &>/dev/null; then
        # Pure bash TCP test via /dev/tcp
        if timeout 3 bash -c "echo >/dev/tcp/$host/$port" 2>/dev/null; then
            echo "UP"
        else
            echo "DOWN"
        fi
    else
        echo "UNKNOWN"
    fi
}

# =============================================================================
# Load last known state from state file
# =============================================================================
load_last_state() {
    [[ -f "$STATE_FILE" ]] || return 0
    while IFS='=' read -r key val; do
        [[ "$key" =~ ^# || -z "$key" ]] && continue
        LAST_STATE["$key"]="$val"
    done < "$STATE_FILE"
}

# =============================================================================
# Save current results as new state
# =============================================================================
save_state() {
    {
        echo "# Grin node monitor state — $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
        for key in "${!RESULTS[@]}"; do
            echo "$key=${RESULTS[$key]}"
        done
    } > "$STATE_FILE"
}

# =============================================================================
# Run port checks for all configured hosts
# =============================================================================
run_checks() {
    if [[ ! -f "$CONF_FILE" ]]; then
        error "Config file not found: $CONF_FILE"
        return 1
    fi

    local line_count=0
    while IFS= read -r line; do
        [[ "$line" =~ ^# || -z "${line// }" ]] && continue
        line_count=$((line_count + 1))

        local host port label
        host=$(awk '{print $1}' <<< "$line")
        port=$(awk '{print $2}' <<< "$line")
        label=$(awk '{print $3}' <<< "$line")
        [[ -z "$label" ]] && label="$host:$port"

        local key="$host:$port"
        local status
        status=$(check_port "$host" "$port")

        RESULTS["$key"]="$status"
        LABELS["$key"]="$label"

        local prev="${LAST_STATE[$key]:-UNKNOWN}"
        if [[ "$prev" != "UNKNOWN" && "$prev" != "$status" ]]; then
            CHANGES+=("$label ($host:$port): $prev → $status")
        fi

        log "CHECK $label ($key): $status  [prev: $prev]"
    done < "$CONF_FILE"

    if [[ $line_count -eq 0 ]]; then
        warn "No hosts configured. Run with --reconfigure."
        return 1
    fi
    return 0
}

# =============================================================================
# Display results in terminal
# =============================================================================
display_results() {
    echo ""
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Grin Node Monitor — $(date -u '+%Y-%m-%d %H:%M UTC')${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    printf "  ${BOLD}%-28s %-22s %-8s  %s${RESET}\n" "Label" "Host:Port" "Status" "Change"
    printf "  %-28s %-22s %-8s  %s\n" \
        "────────────────────────────" "──────────────────────" "────────" "──────────────"

    while IFS= read -r line; do
        [[ "$line" =~ ^# || -z "${line// }" ]] && continue

        local host port label
        host=$(awk '{print $1}' <<< "$line")
        port=$(awk '{print $2}' <<< "$line")
        label=$(awk '{print $3}' <<< "$line")
        [[ -z "$label" ]] && label="$host:$port"

        local key="$host:$port"
        local status="${RESULTS[$key]:-?}"
        local prev="${LAST_STATE[$key]:-UNKNOWN}"

        local status_col change_col=""
        if [[ "$status" == "UP" ]]; then
            status_col="${GREEN}UP      ${RESET}"
        elif [[ "$status" == "DOWN" ]]; then
            status_col="${RED}DOWN    ${RESET}"
        else
            status_col="${YELLOW}UNKNOWN ${RESET}"
        fi

        if [[ "$prev" != "UNKNOWN" && "$prev" != "$status" ]]; then
            change_col="${YELLOW}← was $prev${RESET}"
        fi

        printf "  %-28s %-22s " "$label" "$host:$port"
        echo -ne "$status_col  $change_col"
        echo ""
    done < "$CONF_FILE"

    echo ""

    if [[ ${#CHANGES[@]} -gt 0 ]]; then
        warn "State changes since last run:"
        for ch in "${CHANGES[@]}"; do
            echo -e "  ${YELLOW}▶${RESET} $ch"
        done
    else
        success "No state changes since last check."
    fi

    echo ""
    echo -e "  ${DIM}Config : $CONF_FILE${RESET}"
    echo -e "  ${DIM}Log    : $LOG_FILE${RESET}"
    echo ""
}

# =============================================================================
# Log full results to file
# =============================================================================
log_results() {
    log "=== Grin Node Monitor Report ==="
    while IFS= read -r line; do
        [[ "$line" =~ ^# || -z "${line// }" ]] && continue
        local host port label
        host=$(awk '{print $1}' <<< "$line")
        port=$(awk '{print $2}' <<< "$line")
        label=$(awk '{print $3}' <<< "$line")
        [[ -z "$label" ]] && label="$host:$port"
        local key="$host:$port"
        log "  STATUS  $label ($key) → ${RESULTS[$key]:-?}"
    done < "$CONF_FILE"

    if [[ ${#CHANGES[@]} -gt 0 ]]; then
        log "STATE CHANGES DETECTED:"
        for ch in "${CHANGES[@]}"; do
            log "  CHANGE: $ch"
        done
    else
        log "No state changes."
    fi
    log "=== End of Report ==="
}

# =============================================================================
# Send email report (mail command)
# =============================================================================
send_email() {
    local recipient="$1"

    if ! command -v mail &>/dev/null; then
        warn "mail command not found — cannot send email."
        warn "Install with: apt install mailutils"
        return
    fi

    local subject
    if [[ ${#CHANGES[@]} -gt 0 ]]; then
        subject="[Grin Monitor] ⚠ State Changes — $(date -u '+%Y-%m-%d %H:%M UTC')"
    else
        subject="[Grin Monitor] All Clear — $(date -u '+%Y-%m-%d %H:%M UTC')"
    fi

    local body
    body="Grin Node Monitor Report\n"
    body+="========================\n"
    body+="Time : $(date -u '+%Y-%m-%d %H:%M:%S UTC')\n"
    body+="Host : $(hostname -f 2>/dev/null || hostname)\n\n"
    body+="Results:\n"

    while IFS= read -r line; do
        [[ "$line" =~ ^# || -z "${line// }" ]] && continue
        local host port label
        host=$(awk '{print $1}' <<< "$line")
        port=$(awk '{print $2}' <<< "$line")
        label=$(awk '{print $3}' <<< "$line")
        [[ -z "$label" ]] && label="$host:$port"
        local key="$host:$port"
        body+="  ${RESULTS[$key]:-?}  $label ($key)\n"
    done < "$CONF_FILE"

    if [[ ${#CHANGES[@]} -gt 0 ]]; then
        body+="\nState Changes:\n"
        for ch in "${CHANGES[@]}"; do
            body+="  >> $ch\n"
        done
    fi

    body+="\nLog file: $LOG_FILE\n"

    if echo -e "$body" | mail -s "$subject" "$recipient" 2>/dev/null; then
        success "Report emailed to $recipient"
        log "EMAIL SENT to $recipient (subject: $subject)"
    else
        warn "Failed to send email to $recipient"
        log "EMAIL FAILED to $recipient"
    fi
}

# =============================================================================
# Show crontab setup instructions
# =============================================================================
show_cron_help() {
    local script_abs
    script_abs="$(realpath "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"

    echo ""
    echo -e "${BOLD}${CYAN}── Crontab Setup ──────────────────────────────────────────────────${RESET}"
    echo ""
    echo -e "  Run ${BOLD}crontab -e${RESET} and add one of the following lines:"
    echo ""
    echo -e "  ${DIM}# Check every 5 minutes, email on state change:${RESET}"
    echo -e "  ${YELLOW}*/5 * * * * $script_abs --email your@email.com${RESET}"
    echo ""
    echo -e "  ${DIM}# Check every 5 minutes, always email:${RESET}"
    echo -e "  ${YELLOW}*/5 * * * * $script_abs --email your@email.com --force${RESET}"
    echo ""
    echo -e "  ${DIM}# Check once per hour, email on change:${RESET}"
    echo -e "  ${YELLOW}0 * * * * $script_abs --email your@email.com${RESET}"
    echo ""
    echo -e "  ${DIM}Config file : $CONF_FILE${RESET}"
    echo -e "  ${DIM}State file  : $STATE_FILE${RESET}"
    echo -e "  ${DIM}Logs stored : $LOG_DIR/grin_nodes_status_<datetime>.log${RESET}"
    echo ""
}

# =============================================================================
# Main
# =============================================================================
main() {
    parse_args "$@"

    # ── Non-interactive / cron / email mode ───────────────────────────────────
    if [[ ! -t 0 || -n "$EMAIL" ]]; then
        setup_conf || return 0
        LAST_STATE=(); RESULTS=(); LABELS=(); CHANGES=()
        load_last_state
        run_checks || return 0
        log_results
        if [[ -n "$EMAIL" ]]; then
            if [[ "$FORCE_EMAIL" == true || ${#CHANGES[@]} -gt 0 ]]; then
                send_email "$EMAIL"
            else
                info "No state changes — email skipped. Use --force to always send."
            fi
        fi
        return 0
    fi

    # ── --reconfigure flag only (non-menu) ────────────────────────────────────
    if [[ "$RECONFIGURE" == true ]]; then
        setup_conf || return 0
        return 0
    fi

    # ── Interactive mode — persistent menu ────────────────────────────────────
    if [[ ! -f "$CONF_FILE" ]]; then
        setup_conf || return 0
    fi

    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  8.1  Remote Node Monitor${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        if [[ -f "$CONF_FILE" ]]; then
            echo -e "  Config: ${DIM}$CONF_FILE${RESET}"
        else
            echo -e "  ${YELLOW}No config — use option 2 to configure.${RESET}"
        fi
        echo ""
        echo -e "  ${GREEN}1${RESET}) Run check now"
        echo -e "  ${YELLOW}2${RESET}) Reconfigure host list"
        echo -e "  ${CYAN}3${RESET}) Show crontab / email setup"
        echo -e "  ${DIM}0${RESET}) Return to main menu"
        echo ""
        echo -ne "${BOLD}Select [0-3]: ${RESET}"
        local choice
        read -r choice

        case "$choice" in
            1)
                if [[ ! -f "$CONF_FILE" ]]; then
                    warn "No config file. Use option 2 to configure first."
                    sleep 2; continue
                fi
                LAST_STATE=(); RESULTS=(); LABELS=(); CHANGES=()
                load_last_state
                run_checks || { echo "Press Enter to continue..."; read -r; continue; }
                log_results
                display_results
                save_state
                echo "Press Enter to return to menu..."
                read -r
                ;;
            2)
                RECONFIGURE=true
                setup_conf || true
                RECONFIGURE=false
                ;;
            3)
                show_cron_help
                echo "Press Enter to return to menu..."
                read -r
                ;;
            0) break ;;
            *) warn "Invalid selection."; sleep 1 ;;
        esac
    done
}

main "$@"
