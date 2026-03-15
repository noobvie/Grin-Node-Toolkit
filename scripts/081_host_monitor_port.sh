#!/bin/bash
# =============================================================================
# 081_host_monitor_port.sh — Grin Remote Node Manager
# =============================================================================
# Checks TCP reachability of configured Grin node endpoints (standalone or
# cron), and provides mass deployment: push toolkit updates, start/stop/restart
# remote grin nodes, run ad-hoc commands, and manage SSH keys across a fleet.
#
# Server fleet is configured in conf/mass_deploy.conf (pipe-delimited).
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
REGISTRY="$SCRIPT_DIR/../extensions/grinmasternodes.json"
MASTER_LOG_FILE="$LOG_DIR/grin_master_nodes_status_$(date +%Y%m%d_%H%M%S).log"
MASS_DEPLOY_CONF="$CONF_DIR/mass_deploy.conf"
GITHUB_REPO_DEFAULT="noobvie/Grin-Node-Toolkit"

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
mlog()    { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$MASTER_LOG_FILE"; }
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
        pid=$(lsof -tni :"$port" -sTCP:LISTEN 2>/dev/null | head -1) || true
        [[ -n "$pid" ]] && echo "$pid" && return 0
    fi
    if command -v ss &>/dev/null; then
        pid=$(ss -tlnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' | head -1) || true
        [[ -n "$pid" ]] && echo "$pid" && return 0
    fi
    if command -v netstat &>/dev/null; then
        pid=$(netstat -tlnp 2>/dev/null | grep ":$port " | grep -oP '[0-9]+/.*' | cut -d'/' -f1 | head -1) || true
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
# Registry Master Nodes — Freshness, Availability & Sync Check
# Reads extensions/grinmasternodes.json. For every registered host checks:
#   1. HTTP 200 reachability
#   2. .tar.gz file age via Last-Modified (> 5 days = stale)
#   3. Sync status via check_status_before_download.txt
# Stale / down hosts show the owner contact from _contacts (keyed by base domain).
# Results are written to MASTER_LOG_FILE.
# =============================================================================
check_master_nodes() {
    echo ""
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Registry Master Nodes — Freshness & Sync Check${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    if ! command -v jq &>/dev/null; then
        warn "jq is required for the registry check — skipping."
        return 0
    fi
    if [[ ! -f "$REGISTRY" ]]; then
        warn "grinmasternodes.json not found at: $REGISTRY — skipping."
        return 0
    fi

    local max_age=5
    local now; now=$(date +%s)
    mlog "=== Registry Master Nodes Check ==="
    mlog "Registry: $REGISTRY  |  Threshold: ${max_age} days"

    local zones; zones=$(jq -r 'keys[] | select(startswith("_") | not)' "$REGISTRY" 2>/dev/null) || true
    local total=0 ok=0 stale=0 unsynced=0 down=0

    for zone in $zones; do
        local site_keys; site_keys=$(jq -r --arg z "$zone" '.[$z] | keys[]' "$REGISTRY" 2>/dev/null) || true
        local zone_printed=false
        for sk in $site_keys; do
            local hosts; hosts=$(jq -r --arg z "$zone" --arg s "$sk" \
                '(.[$z][$s] // [])[]' "$REGISTRY" 2>/dev/null) || true
            [[ -z "$hosts" ]] && continue
            if [[ "$zone_printed" == false ]]; then
                echo -e "  ${BOLD}Zone: ${zone^}${RESET}"
                zone_printed=true
            fi
            echo -e "    ${DIM}${sk}${RESET}"
            while IFS= read -r host; do
                total=$((total + 1))
                local base="https://$host"

                # Contact lookup by base domain (last two labels)
                local domain; domain=$(echo "$host" | rev | cut -d'.' -f1-2 | rev)
                local contact; contact=$(jq -r --arg d "$domain" \
                    '._contacts[$d].contact // ""' "$REGISTRY" 2>/dev/null)
                local contact_hint=""
                [[ -n "$contact" ]] && contact_hint="  ${DIM}→ contact: ${contact}${RESET}"

                # Gate 1: HTTP 200 reachability
                local http_code
                http_code=$(curl -o /dev/null -fsSI -w "%{http_code}" \
                    --max-time 8 "$base/" 2>/dev/null) || http_code="000"
                if [[ "$http_code" != "200" ]]; then
                    printf "      %-40s  ${RED}✗ HTTP %s — unreachable${RESET}%b\n" \
                        "$host" "$http_code" "$contact_hint"
                    mlog "  DOWN     $host  HTTP $http_code"
                    down=$((down + 1))
                    continue
                fi

                # Gate 2: directory listing → find .tar.gz filename
                local idx tname
                idx=$(curl -fsSL --max-time 10 "$base/" 2>/dev/null) || idx=""
                tname=$(echo "$idx" | grep -oP 'href="\K[^"]*\.tar\.gz' \
                    | grep -v '^\.\.' | head -1) || true
                if [[ -z "$tname" ]]; then
                    printf "      %-40s  ${RED}✗ no .tar.gz in listing${RESET}%b\n" \
                        "$host" "$contact_hint"
                    mlog "  DOWN     $host  no .tar.gz found in directory listing"
                    down=$((down + 1))
                    continue
                fi

                # Gate 3: file age via HEAD Last-Modified
                local lm age_days=0 age_known=false
                lm=$(curl -fsSI --max-time 8 "$base/$tname" 2>/dev/null \
                    | grep -i '^last-modified:' | cut -d' ' -f2- | tr -d '\r') || true
                if [[ -n "$lm" ]]; then
                    local fts; fts=$(date -d "$lm" +%s 2>/dev/null) || true
                    if [[ -n "$fts" ]]; then
                        age_days=$(( (now - fts) / 86400 ))
                        age_known=true
                    fi
                fi
                if [[ "$age_known" == true && $age_days -gt $max_age ]]; then
                    printf "      %-40s  ${RED}⚠ %d day(s) old — stale${RESET}%b\n" \
                        "$host" "$age_days" "$contact_hint"
                    mlog "  STALE    $host  ${age_days} day(s) old (threshold: ${max_age})"
                    stale=$((stale + 1))
                    continue
                fi

                # Gate 4: sync status
                local sync_txt
                sync_txt=$(curl -fsSL --max-time 10 \
                    "$base/check_status_before_download.txt" 2>/dev/null) || sync_txt=""
                if ! echo "$sync_txt" | grep -q "Sync completed."; then
                    local sync_state; sync_state=$(echo "$sync_txt" | head -1 | tr -d '\r')
                    [[ -z "$sync_state" ]] && sync_state="status file unreachable"
                    printf "      %-40s  ${YELLOW}⟳ sync in progress: %s${RESET}%b\n" \
                        "$host" "$sync_state" "$contact_hint"
                    mlog "  SYNCING  $host  status: ${sync_state}"
                    unsynced=$((unsynced + 1))
                    continue
                fi

                # All gates passed
                if [[ "$age_known" == true ]]; then
                    printf "      %-40s  ${GREEN}✓ %d day(s) old — OK${RESET}\n" "$host" "$age_days"
                    mlog "  OK       $host  ${age_days} day(s) old"
                else
                    printf "      %-40s  ${GREEN}✓ OK${RESET} ${DIM}(age unknown)${RESET}\n" "$host"
                    mlog "  OK       $host  age unknown"
                fi
                ok=$((ok + 1))
            done <<< "$hosts"
        done
        [[ "$zone_printed" == true ]] && echo ""
    done

    echo -e "  ${DIM}Threshold: > ${max_age} days flagged stale${RESET}"
    echo -e "  ${DIM}Summary: ${GREEN}${ok} OK${RESET}  ${RED}${stale} stale  ${down} down${RESET}  ${YELLOW}${unsynced} syncing${RESET}  (total: ${total})${RESET}"
    echo -e "  ${DIM}Log: $MASTER_LOG_FILE${RESET}"
    echo ""
    mlog "Summary: OK=$ok stale=$stale syncing=$unsynced down=$down total=$total"
    mlog "=== End of Registry Check ==="
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
    echo -e "  ${DIM}              $LOG_DIR/grin_master_nodes_status_<datetime>.log${RESET}"
    echo ""
}

# =============================================================================
# Mass Deployment — global arrays (populated by _md_load_conf)
# =============================================================================
_md_labels=()
_md_hosts=()
_md_ports=()
_md_users=()
_md_keys=()
_md_paths=()
_md_selected_idx=()

# -----------------------------------------------------------------------------
# _md_load_conf — parse $MASS_DEPLOY_CONF into the 6 global plain arrays
# Format: label|host|ssh_port|ssh_user|ssh_key|toolkit_path
# -----------------------------------------------------------------------------
_md_load_conf() {
    _md_labels=(); _md_hosts=(); _md_ports=(); _md_users=(); _md_keys=(); _md_paths=()
    if [[ ! -f "$MASS_DEPLOY_CONF" ]]; then
        warn "No servers in mass_deploy.conf. Use Manage Servers to add."
        return 1
    fi
    local _line
    while IFS= read -r _line; do
        [[ -z "$_line" || "$_line" == \#* ]] && continue
        local _lbl _host _port _user _key _path
        IFS='|' read -r _lbl _host _port _user _key _path <<< "$_line"
        [[ -z "$_lbl" || -z "$_host" ]] && continue
        _md_labels+=("$_lbl")
        _md_hosts+=("$_host")
        _md_ports+=("${_port:-22}")
        _md_users+=("${_user:-root}")
        _md_keys+=("${_key:-}")
        _md_paths+=("${_path:-/opt/grin-node-toolkit}")
    done < "$MASS_DEPLOY_CONF"
    if [[ ${#_md_labels[@]} -eq 0 ]]; then
        warn "No servers in mass_deploy.conf. Use Manage Servers to add."
        return 1
    fi
    return 0
}

# -----------------------------------------------------------------------------
# _md_ssh — run a remote command via SSH with standard options
# Usage: _md_ssh label host port user key [cmd...]
# -----------------------------------------------------------------------------
_md_ssh() {
    local _label="$1" _host="$2" _port="$3" _user="$4" _key="$5"
    shift 5
    local _ssh_opts="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes -o LogLevel=ERROR"
    [[ -n "$_key" && -f "$_key" ]] && _ssh_opts="$_ssh_opts -i $_key"
    ssh $_ssh_opts -p "$_port" "$_user@$_host" "$@" 2>&1
}

# -----------------------------------------------------------------------------
# _md_select_servers — show numbered list, ask "all" or comma-separated nums
# Sets global _md_selected_idx with 0-based indices
# -----------------------------------------------------------------------------
_md_select_servers() {
    _md_selected_idx=()
    if ! _md_load_conf; then
        return 1
    fi
    echo ""
    echo -e "  ${BOLD}Available servers:${RESET}"
    local _i
    for (( _i=0; _i<${#_md_labels[@]}; _i++ )); do
        printf "    ${CYAN}%2d${RESET}) %-20s  %s\n" \
            "$((_i+1))" "${_md_labels[$_i]}" "${_md_users[$_i]}@${_md_hosts[$_i]}:${_md_ports[$_i]}"
    done
    echo ""
    echo -ne "  ${BOLD}Select servers (all / comma-separated numbers): ${RESET}"
    local _sel
    read -r _sel
    if [[ -z "$_sel" || "$_sel" == "all" ]]; then
        for (( _i=0; _i<${#_md_labels[@]}; _i++ )); do
            _md_selected_idx+=("$_i")
        done
    else
        IFS=',' read -ra _nums <<< "$_sel"
        local _n
        for _n in "${_nums[@]}"; do
            _n="${_n// /}"
            if [[ "$_n" =~ ^[0-9]+$ ]] && (( _n >= 1 && _n <= ${#_md_labels[@]} )); then
                _md_selected_idx+="$((_n-1))"
            else
                warn "  Ignoring invalid selection: $_n"
            fi
        done
    fi
    if [[ ${#_md_selected_idx[@]} -eq 0 ]]; then
        warn "No servers selected."
        return 1
    fi
    return 0
}

# -----------------------------------------------------------------------------
# _md_run_on_servers — execute a script on all selected servers via bash -s
# Usage: _md_run_on_servers "action_name" "script_content"
# Script must print __OK__ on success as the last line.
# -----------------------------------------------------------------------------
_md_run_on_servers() {
    local _action="$1"
    local _remote_script="$2"
    local _ok=0 _fail=0 _idx _label _host _port _user _key
    echo ""
    echo -e "  ${BOLD}Running: $_action${RESET}"
    echo ""
    for _idx in "${_md_selected_idx[@]}"; do
        _label="${_md_labels[$_idx]}"
        _host="${_md_hosts[$_idx]}"
        _port="${_md_ports[$_idx]}"
        _user="${_md_users[$_idx]}"
        _key="${_md_keys[$_idx]}"
        printf "  ${BOLD}[%-16s]${RESET}  %s@%s  ... " "$_label" "$_user" "$_host"
        local _ssh_opts="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes -o LogLevel=ERROR"
        [[ -n "$_key" && -f "$_key" ]] && _ssh_opts="$_ssh_opts -i $_key"
        local _out
        _out=$(echo "$_remote_script" | ssh $_ssh_opts -p "$_port" "$_user@$_host" "bash -s" 2>&1) || true
        if echo "$_out" | grep -q "__OK__"; then
            echo -e "${GREEN}OK${RESET}"
            _ok=$((_ok+1))
        else
            echo -e "${RED}FAILED${RESET}"
            _fail=$((_fail+1))
            echo "$_out" | while IFS= read -r _line; do
                echo -e "    ${DIM}$_line${RESET}"
            done
        fi
    done
    echo ""
    echo -e "  Summary: ${GREEN}${_ok} OK${RESET}  ${RED}${_fail} FAILED${RESET}"
    echo ""
    echo "Press Enter to continue..."; read -r
}

# -----------------------------------------------------------------------------
# _md_list_servers — print a formatted table of all configured servers
# -----------------------------------------------------------------------------
_md_list_servers() {
    if ! _md_load_conf; then
        echo "Press Enter to continue..."; read -r
        return
    fi
    echo ""
    echo -e "  ${BOLD}Configured servers:${RESET}"
    echo ""
    printf "  ${BOLD}%-18s %-22s %-6s %-10s %-30s %s${RESET}\n" \
        "Label" "Host" "Port" "User" "SSH Key" "Toolkit Path"
    printf "  %-18s %-22s %-6s %-10s %-30s %s\n" \
        "──────────────────" "──────────────────────" "──────" "──────────" \
        "──────────────────────────────" "──────────────────────"
    local _i
    for (( _i=0; _i<${#_md_labels[@]}; _i++ )); do
        local _key_disp="${_md_keys[$_i]}"
        [[ -z "$_key_disp" ]] && _key_disp="${DIM}(default)${RESET}"
        printf "  %-18s %-22s %-6s %-10s %-30s %s\n" \
            "${_md_labels[$_i]}" "${_md_hosts[$_i]}" "${_md_ports[$_i]}" \
            "${_md_users[$_i]}" "${_md_keys[$_i]:-default}" "${_md_paths[$_i]}"
    done
    echo ""
    echo "Press Enter to continue..."; read -r
}

# -----------------------------------------------------------------------------
# _md_add_server — interactively add a new server to mass_deploy.conf
# -----------------------------------------------------------------------------
_md_add_server() {
    echo ""
    echo -e "  ${BOLD}Add Server${RESET}"
    echo ""
    local _lbl _host _port _user _key _path
    echo -ne "  Label (short name): "; read -r _lbl
    [[ -z "$_lbl" ]] && { warn "Label cannot be empty."; return 1; }
    echo -ne "  Host (IP or domain): "; read -r _host
    [[ -z "$_host" ]] && { warn "Host cannot be empty."; return 1; }
    echo -ne "  SSH port [22]: "; read -r _port
    [[ -z "$_port" ]] && _port="22"
    echo -ne "  SSH user [root]: "; read -r _user
    [[ -z "$_user" ]] && _user="root"
    local _key_default
    if [[ -f "/root/.ssh/grin_deploy" ]]; then
        _key_default="/root/.ssh/grin_deploy"
    else
        _key_default="/root/.ssh/id_rsa"
    fi
    echo -ne "  SSH key [$_key_default]: "; read -r _key
    [[ -z "$_key" ]] && _key="$_key_default"
    echo -ne "  Toolkit path [/opt/grin-node-toolkit]: "; read -r _path
    [[ -z "$_path" ]] && _path="/opt/grin-node-toolkit"

    echo ""
    info "Testing connection to $_user@$_host:$_port ..."
    local _conn_out
    _conn_out=$(_md_ssh "$_lbl" "$_host" "$_port" "$_user" "$_key" "echo __CONN_OK__" 2>&1) || true
    if echo "$_conn_out" | grep -q "__CONN_OK__"; then
        success "Connection OK."
    else
        warn "Connection test failed (saving anyway): $_conn_out"
    fi

    # Create conf with header if new
    if [[ ! -f "$MASS_DEPLOY_CONF" ]]; then
        mkdir -p "$CONF_DIR"
        {
            echo "# mass_deploy.conf — Grin Node Toolkit fleet configuration"
            echo "# Format: label|host|ssh_port|ssh_user|ssh_key|toolkit_path"
            echo "# Generated: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
            echo ""
        } > "$MASS_DEPLOY_CONF"
    fi
    echo "${_lbl}|${_host}|${_port}|${_user}|${_key}|${_path}" >> "$MASS_DEPLOY_CONF"
    success "Server '$_lbl' added to $MASS_DEPLOY_CONF"
    echo ""
    echo "Press Enter to continue..."; read -r
}

# -----------------------------------------------------------------------------
# _md_remove_server — remove a server entry from mass_deploy.conf
# -----------------------------------------------------------------------------
_md_remove_server() {
    if ! _md_load_conf; then
        echo "Press Enter to continue..."; read -r
        return
    fi
    echo ""
    echo -e "  ${BOLD}Remove Server${RESET}"
    echo ""
    local _i
    for (( _i=0; _i<${#_md_labels[@]}; _i++ )); do
        printf "    ${CYAN}%2d${RESET}) %-20s  %s@%s\n" \
            "$((_i+1))" "${_md_labels[$_i]}" "${_md_users[$_i]}" "${_md_hosts[$_i]}"
    done
    echo ""
    echo -ne "  ${BOLD}Remove server number (or Enter to cancel): ${RESET}"
    local _sel
    read -r _sel
    [[ -z "$_sel" ]] && return
    if [[ "$_sel" =~ ^[0-9]+$ ]] && (( _sel >= 1 && _sel <= ${#_md_labels[@]} )); then
        local _idx=$((_sel-1))
        local _label="${_md_labels[$_idx]}"
        sed -i "/^${_label}|/d" "$MASS_DEPLOY_CONF"
        success "Removed server '$_label'."
    else
        warn "Invalid selection."
    fi
    echo ""
    echo "Press Enter to continue..."; read -r
}

# -----------------------------------------------------------------------------
# _md_test_all — test SSH connectivity to ALL configured servers
# -----------------------------------------------------------------------------
_md_test_all() {
    if ! _md_load_conf; then
        echo "Press Enter to continue..."; read -r
        return
    fi
    echo ""
    echo -e "  ${BOLD}Testing connections to all servers...${RESET}"
    echo ""
    local _i _ok=0 _fail=0
    for (( _i=0; _i<${#_md_labels[@]}; _i++ )); do
        local _label="${_md_labels[$_i]}"
        local _host="${_md_hosts[$_i]}"
        local _port="${_md_ports[$_i]}"
        local _user="${_md_users[$_i]}"
        local _key="${_md_keys[$_i]}"
        printf "  ${BOLD}[%-16s]${RESET}  %s@%s:%s  ... " "$_label" "$_user" "$_host" "$_port"
        local _out
        _out=$(_md_ssh "$_label" "$_host" "$_port" "$_user" "$_key" "echo __CONN_OK__" 2>&1) || true
        if echo "$_out" | grep -q "__CONN_OK__"; then
            echo -e "${GREEN}OK${RESET}"
            _ok=$((_ok+1))
        else
            echo -e "${RED}FAILED${RESET}  ${DIM}$_out${RESET}"
            _fail=$((_fail+1))
        fi
    done
    echo ""
    echo -e "  Summary: ${GREEN}${_ok} OK${RESET}  ${RED}${_fail} FAILED${RESET}"
    echo ""
    echo "Press Enter to continue..."; read -r
}

# -----------------------------------------------------------------------------
# _md_bootstrap_keys — generate grin_deploy key and push to all servers
# -----------------------------------------------------------------------------
_md_bootstrap_keys() {
    echo ""
    echo -e "  ${BOLD}Bootstrap SSH Deploy Keys${RESET}"
    echo ""

    # Generate key if missing
    if [[ ! -f "/root/.ssh/grin_deploy" ]]; then
        info "Generating ed25519 deploy key at /root/.ssh/grin_deploy ..."
        mkdir -p /root/.ssh
        ssh-keygen -t ed25519 -f /root/.ssh/grin_deploy -N "" -C "grin-node-toolkit" || true
    else
        info "Deploy key already exists: /root/.ssh/grin_deploy"
    fi

    echo ""
    echo -e "  ${BOLD}Public key:${RESET}"
    if [[ -f "/root/.ssh/grin_deploy.pub" ]]; then
        echo -e "  ${DIM}$(cat /root/.ssh/grin_deploy.pub)${RESET}"
    else
        warn "Public key not found at /root/.ssh/grin_deploy.pub"
        echo "Press Enter to continue..."; read -r
        return 1
    fi
    echo ""

    if ! _md_load_conf; then
        echo "Press Enter to continue..."; read -r
        return
    fi

    local _i _ok=0 _fail=0
    for (( _i=0; _i<${#_md_labels[@]}; _i++ )); do
        local _label="${_md_labels[$_i]}"
        local _host="${_md_hosts[$_i]}"
        local _port="${_md_ports[$_i]}"
        local _user="${_md_users[$_i]}"
        echo ""
        info "Copying key to $_user@$_host:$_port (you may be prompted for password)..."
        ssh-copy-id -i /root/.ssh/grin_deploy.pub -p "$_port" "$_user@$_host" || true
        echo ""
        info "Verifying key auth for $_label ..."
        local _out
        _out=$(_md_ssh "$_label" "$_host" "$_port" "$_user" "/root/.ssh/grin_deploy" "echo __CONN_OK__" 2>&1) || true
        if echo "$_out" | grep -q "__CONN_OK__"; then
            success "Key auth OK for $_label — updating conf."
            _ok=$((_ok+1))
            awk -F'|' -v lbl="$_label" -v k="/root/.ssh/grin_deploy" \
                'BEGIN{OFS="|"} $1==lbl{$5=k} {print}' \
                "$MASS_DEPLOY_CONF" > "/tmp/md_tmp_$$" && \
                mv "/tmp/md_tmp_$$" "$MASS_DEPLOY_CONF" || true
        else
            warn "Key auth failed for $_label: $_out"
            _fail=$((_fail+1))
        fi
    done
    echo ""
    echo -e "  Summary: ${GREEN}${_ok} key(s) installed OK${RESET}  ${RED}${_fail} failed${RESET}"
    echo ""
    echo "Press Enter to continue..."; read -r
}

# -----------------------------------------------------------------------------
# mass_deploy_manage — sub-menu: manage the server list
# -----------------------------------------------------------------------------
mass_deploy_manage() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Mass Deployment — Manage Servers${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  ${CYAN}1${RESET}) List servers"
        echo -e "  ${CYAN}2${RESET}) Add server"
        echo -e "  ${CYAN}3${RESET}) Remove server"
        echo -e "  ${CYAN}4${RESET}) Test connections"
        echo -e "  ${CYAN}5${RESET}) Bootstrap SSH keys"
        echo -e "  ${DIM}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [0-5]: ${RESET}"
        local _choice
        read -r _choice
        case "$_choice" in
            1) _md_list_servers ;;
            2) _md_add_server ;;
            3) _md_remove_server ;;
            4) _md_test_all ;;
            5) _md_bootstrap_keys ;;
            0) break ;;
            *) warn "Invalid selection."; sleep 1 ;;
        esac
    done
}

# -----------------------------------------------------------------------------
# mass_deploy_update — push toolkit update from GitHub to selected servers
# -----------------------------------------------------------------------------
mass_deploy_update() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Mass Deployment — Push Toolkit Update${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    # Determine repo (allow fork override)
    local _repo="$GITHUB_REPO_DEFAULT"
    if [[ -f "$CONF_DIR/github_repo.conf" ]]; then
        local _repo_override
        _repo_override=$(grep -v '^#' "$CONF_DIR/github_repo.conf" | head -1 | tr -d '[:space:]') || true
        [[ -n "$_repo_override" ]] && _repo="$_repo_override"
    fi
    echo -e "  Repository: ${CYAN}$_repo${RESET}"
    echo ""

    # Branch selection
    echo -e "  ${BOLD}Select branch:${RESET}"
    echo -e "  ${CYAN}1${RESET}) main          ${DIM}(stable)${RESET}"
    echo -e "  ${CYAN}2${RESET}) addons"
    echo -e "  ${CYAN}3${RESET}) corefeatures"
    echo -e "  ${CYAN}4${RESET}) Custom branch"
    echo -e "  ${DIM}0${RESET}) Cancel"
    echo ""
    echo -ne "${BOLD}Select [0-4] (default 1): ${RESET}"
    local _bchoice
    read -r _bchoice
    [[ -z "$_bchoice" ]] && _bchoice="1"

    local _branch
    case "$_bchoice" in
        1) _branch="main" ;;
        2) _branch="addons" ;;
        3) _branch="corefeatures" ;;
        4) echo -ne "  Branch name: "; read -r _branch; [[ -z "$_branch" ]] && { warn "Cancelled."; return; } ;;
        0) return ;;
        *) warn "Invalid selection."; return ;;
    esac

    local _tarball_url="https://github.com/$_repo/archive/refs/heads/$_branch.tar.gz"
    echo ""
    info "Will download: $_tarball_url"
    echo ""

    if ! _md_select_servers; then
        echo "Press Enter to continue..."; read -r
        return
    fi

    local _i _ok=0 _fail=0
    for _i in "${_md_selected_idx[@]}"; do
        local _label="${_md_labels[$_i]}"
        local _host="${_md_hosts[$_i]}"
        local _port="${_md_ports[$_i]}"
        local _user="${_md_users[$_i]}"
        local _key="${_md_keys[$_i]}"
        local _tpath="${_md_paths[$_i]}"
        printf "\n  ${BOLD}[%-16s]${RESET}  %s@%s\n" "$_label" "$_user" "$_host"
        local _remote_script
        _remote_script="mkdir -p /tmp/gnt-update && \
curl -fsSL '${_tarball_url}' -o /tmp/gnt-update/update.tar.gz && \
tar -xzf /tmp/gnt-update/update.tar.gz -C /tmp/gnt-update && \
extracted=\$(ls /tmp/gnt-update/ | grep -v update.tar.gz | head -1) && \
cp -rf /tmp/gnt-update/\$extracted/. '${_tpath}'/ && \
chmod +x '${_tpath}'/grin-node-toolkit.sh '${_tpath}'/scripts/*.sh 2>/dev/null || true && \
rm -rf /tmp/gnt-update && \
echo __OK__"
        local _ssh_opts="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes -o LogLevel=ERROR"
        [[ -n "$_key" && -f "$_key" ]] && _ssh_opts="$_ssh_opts -i $_key"
        local _out
        _out=$(echo "$_remote_script" | ssh $_ssh_opts -p "$_port" "$_user@$_host" "bash -s" 2>&1) || true
        if echo "$_out" | grep -q "__OK__"; then
            echo -e "    ${GREEN}OK${RESET}"
            _ok=$((_ok+1))
        else
            echo -e "    ${RED}FAILED${RESET}"
            _fail=$((_fail+1))
            echo "$_out" | while IFS= read -r _line; do
                echo -e "    ${DIM}$_line${RESET}"
            done
        fi
    done
    echo ""
    echo -e "  Summary: ${GREEN}${_ok} updated OK${RESET}  ${RED}${_fail} FAILED${RESET}"
    echo ""
    echo "Press Enter to continue..."; read -r
}

# -----------------------------------------------------------------------------
# mass_deploy_run — run an ad-hoc command on selected servers
# -----------------------------------------------------------------------------
mass_deploy_run() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Mass Deployment — Run Command${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    if ! _md_select_servers; then
        echo "Press Enter to continue..."; read -r
        return
    fi

    echo ""
    echo -ne "  ${BOLD}Command to run: ${RESET}"
    local _cmd
    read -r _cmd
    [[ -z "$_cmd" ]] && { warn "No command entered."; return; }

    local _n="${#_md_selected_idx[@]}"
    echo ""
    echo -ne "  Run '${CYAN}${_cmd}${RESET}' on ${_n} server(s)? [Y/n]: "
    local _confirm
    read -r _confirm
    [[ "$_confirm" =~ ^[Nn] ]] && { info "Cancelled."; return; }

    echo ""
    local _i _ok=0 _fail=0
    for _i in "${_md_selected_idx[@]}"; do
        local _label="${_md_labels[$_i]}"
        local _host="${_md_hosts[$_i]}"
        local _port="${_md_ports[$_i]}"
        local _user="${_md_users[$_i]}"
        local _key="${_md_keys[$_i]}"
        printf "  ${BOLD}[%-16s]${RESET}  %s@%s\n" "$_label" "$_user" "$_host"
        local _rc=0
        local _out
        _out=$(_md_ssh "$_label" "$_host" "$_port" "$_user" "$_key" "$_cmd" 2>&1) || _rc=$?
        echo "$_out" | while IFS= read -r _line; do
            echo -e "    ${DIM}$_line${RESET}"
        done
        if [[ $_rc -eq 0 ]]; then
            echo -e "    ${GREEN}[exit 0]${RESET}"
            _ok=$((_ok+1))
        else
            echo -e "    ${RED}[exit $_rc]${RESET}"
            _fail=$((_fail+1))
        fi
        echo ""
    done
    echo -e "  Summary: ${GREEN}${_ok} OK${RESET}  ${RED}${_fail} FAILED${RESET}"
    echo ""
    echo "Press Enter to continue..."; read -r
}

# -----------------------------------------------------------------------------
# _md_ctrl_start — start grin nodes on selected servers
# -----------------------------------------------------------------------------
_md_ctrl_start() {
    if ! _md_select_servers; then
        echo "Press Enter to continue..."; read -r
        return
    fi
    local _script='
started=0
for dir in /opt/grin/node/mainnet-prune /opt/grin/node/mainnet-full /opt/grin/node/testnet-prune; do
    [[ -x "$dir/grin" ]] || continue
    sess="grin_$(basename $dir)"
    if tmux has-session -t "$sess" 2>/dev/null; then
        echo "  already running: $sess"
        continue
    fi
    if id grin &>/dev/null; then
        chown -R grin:grin "$dir" 2>/dev/null || true
        tmux new-session -d -s "$sess" -c "$dir" \
            "su -s /bin/bash -c '"'"'cd '"'"'$dir'"'"' && ./grin server run'"'"' grin; echo; read" 2>/dev/null && \
            echo "  started: $sess" || echo "  tmux failed: $sess"
    else
        tmux new-session -d -s "$sess" -c "$dir" \
            "cd $dir && ./grin server run; echo; read" 2>/dev/null && \
            echo "  started: $sess" || echo "  tmux failed: $sess"
    fi
    started=$((started+1))
done
[[ $started -eq 0 ]] && echo "  no grin binaries found in standard locations"
echo __OK__
'
    _md_run_on_servers "Start grin nodes" "$_script"
}

# -----------------------------------------------------------------------------
# _md_ctrl_stop — stop grin nodes on selected servers
# -----------------------------------------------------------------------------
_md_ctrl_stop() {
    if ! _md_select_servers; then
        echo "Press Enter to continue..."; read -r
        return
    fi
    local _script='
for port in 3414 13414; do
    pid=$(ss -tlnp 2>/dev/null | grep ":${port} " | grep -oE '"'"'pid=[0-9]+'"'"' | head -1 | cut -d= -f2 || true)
    [[ -z "$pid" ]] && continue
    kill -TERM "$pid" 2>/dev/null && echo "  SIGTERM pid $pid (port $port)" || true
done
while IFS= read -r sess; do
    [[ -z "$sess" ]] && continue
    tmux kill-session -t "$sess" 2>/dev/null && echo "  closed tmux: $sess" || true
done < <(tmux ls -F '"'"'#{session_name}'"'"' 2>/dev/null | grep '"'"'^grin_'"'"' || true)
echo __OK__
'
    _md_run_on_servers "Stop grin nodes" "$_script"
}

# -----------------------------------------------------------------------------
# _md_ctrl_restart — stop then start grin nodes on selected servers
# -----------------------------------------------------------------------------
_md_ctrl_restart() {
    if ! _md_select_servers; then
        echo "Press Enter to continue..."; read -r
        return
    fi
    local _stop_script='
for port in 3414 13414; do
    pid=$(ss -tlnp 2>/dev/null | grep ":${port} " | grep -oE '"'"'pid=[0-9]+'"'"' | head -1 | cut -d= -f2 || true)
    [[ -z "$pid" ]] && continue
    kill -TERM "$pid" 2>/dev/null && echo "  SIGTERM pid $pid (port $port)" || true
done
while IFS= read -r sess; do
    [[ -z "$sess" ]] && continue
    tmux kill-session -t "$sess" 2>/dev/null && echo "  closed tmux: $sess" || true
done < <(tmux ls -F '"'"'#{session_name}'"'"' 2>/dev/null | grep '"'"'^grin_'"'"' || true)
sleep 3
echo __OK__
'
    local _start_script='
started=0
for dir in /opt/grin/node/mainnet-prune /opt/grin/node/mainnet-full /opt/grin/node/testnet-prune; do
    [[ -x "$dir/grin" ]] || continue
    sess="grin_$(basename $dir)"
    if tmux has-session -t "$sess" 2>/dev/null; then
        echo "  already running: $sess"
        continue
    fi
    if id grin &>/dev/null; then
        chown -R grin:grin "$dir" 2>/dev/null || true
        tmux new-session -d -s "$sess" -c "$dir" \
            "su -s /bin/bash -c '"'"'cd '"'"'$dir'"'"' && ./grin server run'"'"' grin; echo; read" 2>/dev/null && \
            echo "  started: $sess" || echo "  tmux failed: $sess"
    else
        tmux new-session -d -s "$sess" -c "$dir" \
            "cd $dir && ./grin server run; echo; read" 2>/dev/null && \
            echo "  started: $sess" || echo "  tmux failed: $sess"
    fi
    started=$((started+1))
done
[[ $started -eq 0 ]] && echo "  no grin binaries found in standard locations"
echo __OK__
'
    echo ""
    info "Stopping nodes on selected servers..."
    _md_run_on_servers "Stop grin nodes (restart)" "$_stop_script"
    info "Starting nodes on selected servers..."
    _md_run_on_servers "Start grin nodes (restart)" "$_start_script"
}

# -----------------------------------------------------------------------------
# _md_ctrl_upgrade — download latest grin release and restart on selected servers
# -----------------------------------------------------------------------------
_md_ctrl_upgrade() {
    if ! _md_select_servers; then
        echo "Press Enter to continue..."; read -r
        return
    fi
    local _script='
set -e
GRIN_API="https://api.github.com/repos/mimblewimble/grin/releases/latest"
LATEST_URL=$(curl -fsSL "$GRIN_API" | grep browser_download_url | grep linux-amd64 | cut -d'"'"'"'"'"'"'"'"'"'"'"'"'"'"'"'"'"'"'"'"' -f4)
[[ -z "$LATEST_URL" ]] && { echo "ERROR: could not get latest release URL"; exit 1; }
TMP=$(mktemp -d)
echo "  downloading: $LATEST_URL"
curl -fsSL "$LATEST_URL" | tar -xz -C "$TMP"
upgraded=0
for dir in /opt/grin/node/mainnet-prune /opt/grin/node/mainnet-full /opt/grin/node/testnet-prune; do
    [[ -d "$dir" ]] || continue
    cp "$TMP/grin" "$dir/grin" && chmod +x "$dir/grin"
    id grin &>/dev/null && chown grin:grin "$dir/grin" || true
    echo "  upgraded: $dir"
    upgraded=$((upgraded+1))
done
rm -rf "$TMP"
[[ $upgraded -eq 0 ]] && { echo "  no node dirs found"; exit 0; }
for port in 3414 13414; do
    pid=$(ss -tlnp 2>/dev/null | grep ":${port} " | grep -oE '"'"'pid=[0-9]+'"'"' | head -1 | cut -d= -f2 || true)
    [[ -z "$pid" ]] && continue
    kill -TERM "$pid" 2>/dev/null || true
done
sleep 5
for dir in /opt/grin/node/mainnet-prune /opt/grin/node/mainnet-full /opt/grin/node/testnet-prune; do
    [[ -x "$dir/grin" ]] || continue
    sess="grin_$(basename $dir)"
    tmux has-session -t "$sess" 2>/dev/null && tmux kill-session -t "$sess" 2>/dev/null || true
    if id grin &>/dev/null; then
        tmux new-session -d -s "$sess" -c "$dir" \
            "su -s /bin/bash -c '"'"'cd '"'"'$dir'"'"' && ./grin server run'"'"' grin; echo; read" 2>/dev/null || true
    else
        tmux new-session -d -s "$sess" -c "$dir" "cd $dir && ./grin server run; echo; read" 2>/dev/null || true
    fi
    echo "  restarted: $sess"
done
echo __OK__
'
    _md_run_on_servers "Upgrade grin binary" "$_script"
}

# -----------------------------------------------------------------------------
# _md_ctrl_reboot — schedule a reboot on selected servers (1-minute delay)
# -----------------------------------------------------------------------------
_md_ctrl_reboot() {
    if ! _md_select_servers; then
        echo "Press Enter to continue..."; read -r
        return
    fi
    echo ""
    warn "This will reboot ${#_md_selected_idx[@]} server(s) in 1 minute."
    echo -ne "  ${RED}${BOLD}Are you sure? [y/N]: ${RESET}"
    local _confirm
    read -r _confirm
    [[ ! "$_confirm" =~ ^[Yy]$ ]] && { info "Cancelled."; return; }
    echo ""
    local _i _ok=0 _fail=0
    for _i in "${_md_selected_idx[@]}"; do
        local _label="${_md_labels[$_i]}"
        local _host="${_md_hosts[$_i]}"
        local _port="${_md_ports[$_i]}"
        local _user="${_md_users[$_i]}"
        local _key="${_md_keys[$_i]}"
        printf "  ${BOLD}[%-16s]${RESET}  %s@%s  ... " "$_label" "$_user" "$_host"
        local _out
        _out=$(_md_ssh "$_label" "$_host" "$_port" "$_user" "$_key" \
            "shutdown -r +1 'Rebooting via grin-node-toolkit' && echo __OK__" 2>&1) || true
        if echo "$_out" | grep -q "__OK__"; then
            echo -e "${GREEN}Reboot scheduled (+1 min)${RESET}"
            _ok=$((_ok+1))
        else
            echo -e "${RED}FAILED${RESET}  ${DIM}$_out${RESET}"
            _fail=$((_fail+1))
        fi
    done
    echo ""
    echo -e "  Summary: ${GREEN}${_ok} rebooting${RESET}  ${RED}${_fail} FAILED${RESET}"
    echo ""
    echo "Press Enter to continue..."; read -r
}

# -----------------------------------------------------------------------------
# mass_deploy_control — sub-menu: remote node control
# -----------------------------------------------------------------------------
mass_deploy_control() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Mass Deployment — Remote Node Control${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  ${CYAN}a${RESET}) Start nodes"
        echo -e "  ${CYAN}b${RESET}) Stop nodes"
        echo -e "  ${CYAN}c${RESET}) Restart nodes"
        echo -e "  ${CYAN}d${RESET}) Upgrade grin binary"
        echo -e "  ${RED}e${RESET}) Reboot servers"
        echo -e "  ${DIM}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [0/a-e]: ${RESET}"
        local _choice
        read -r _choice
        case "$_choice" in
            a) _md_ctrl_start ;;
            b) _md_ctrl_stop ;;
            c) _md_ctrl_restart ;;
            d) _md_ctrl_upgrade ;;
            e) _md_ctrl_reboot ;;
            0) break ;;
            *) warn "Invalid selection."; sleep 1 ;;
        esac
    done
}

# -----------------------------------------------------------------------------
# mass_deploy — top-level mass deployment dispatcher menu
# -----------------------------------------------------------------------------
mass_deploy() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Mass Deployment${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  ${CYAN}1${RESET}) Manage server list"
        echo -e "  ${CYAN}2${RESET}) Push toolkit update"
        echo -e "  ${CYAN}3${RESET}) Run command"
        echo -e "  ${CYAN}4${RESET}) Remote node control"
        echo -e "  ${DIM}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [0-4]: ${RESET}"
        local _choice
        read -r _choice
        case "$_choice" in
            1) mass_deploy_manage ;;
            2) mass_deploy_update ;;
            3) mass_deploy_run ;;
            4) mass_deploy_control ;;
            0) break ;;
            *) warn "Invalid selection."; sleep 1 ;;
        esac
    done
}

# =============================================================================
# Main
# =============================================================================
main() {
    parse_args "$@"

    # ── Non-interactive / cron / email mode ───────────────────────────────────
    if [[ ! -t 0 || -n "$EMAIL" ]]; then
        setup_conf || return 0
        check_master_nodes
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
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  8.1  Remote Node Manager${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        if [[ -f "$CONF_FILE" ]]; then
            echo -e "  Config: ${DIM}$CONF_FILE${RESET}"
        else
            echo -e "  ${YELLOW}No config — use option 2 to configure.${RESET}"
        fi
        echo ""
        if [[ -f "$CONF_FILE" ]]; then
            echo -e "  ${GREEN}1${RESET}) Run check now"
        else
            echo -e "  ${GREEN}1${RESET}) Run check now ${DIM}(grinmasternodes.json only)${RESET}"
        fi
        echo -e "  ${YELLOW}2${RESET}) Reconfigure host list"
        echo -e "  ${CYAN}3${RESET}) Show crontab / email setup"
        echo -e "  ${CYAN}4${RESET}) Mass Deployment         ${DIM}update, control and run commands on remote nodes${RESET}"
        echo -e "  ${DIM}0${RESET}) Return to main menu"
        echo ""
        echo -ne "${BOLD}Select [0-4]: ${RESET}"
        local choice
        read -r choice

        case "$choice" in
            1)
                check_master_nodes
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
            4) mass_deploy ;;
            0) break ;;
            *) warn "Invalid selection."; sleep 1 ;;
        esac
    done
}

main "$@"
