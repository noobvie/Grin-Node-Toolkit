#!/bin/bash
# =============================================================================
# 08_grin_node_admin.sh - Grin Node Administration Centre
# =============================================================================
# Menu:
#   8.1  Remote Node Manager        — port monitor, mass deployment & remote node control
#   8.2  Service & Port Dashboard  — local PIDs, ports, tmux, binary versions
#   8.3  Chain Sync Status         — query local node API for current tip
#   8.4  Nginx Extended Features   — audit · reverse proxy · security · log rotation
#   8.5  Firewall Rules Audit      — UFW/iptables review for Grin ports
#   8.6  Top 20 Bandwidth Consumers— parse nginx logs, block/limit from menu
#   8.7  Disk Cleanup              — tar archives + OS temp/logs + nginx web dirs
#   8.8  Self-Update               — download latest from GitHub
#   8.9  Backup                    — coming soon
#   8.10 Filesystem Standardization Wizard — relocate dirs, create grin user, patch configs
#   DEL  Full Grin Cleanup         — 08del_clean_all_grin_things.sh
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_DIR="/opt/grin/conf"
WALLETS_CONF="$CONF_DIR/grin_wallets_location.conf"

# ─── GitHub self-update ───────────────────────────────────────────────────────
# Official public repository. A fork slug saved in /opt/grin/conf/github_repo.conf
# overrides this (useful if you maintain your own fork).
GITHUB_REPO="noobvie/Grin-Node-Toolkit"
GITHUB_BRANCH="main"   # fallback default; branch is chosen interactively

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

# ─── Logging ──────────────────────────────────────────────────────────────────
LOG_DIR="$SCRIPT_DIR/../log"
LOG_FILE="$LOG_DIR/grin_admin_$(date +%Y%m%d_%H%M%S).log"
mkdir -p "$LOG_DIR"

log()     { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; log "[INFO]  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; log "[OK]    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; log "[WARN]  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; log "[ERROR] $*"; }

# ─── Cleanup paths (used by 8.7 / 8.8) ───────────────────────────────────────
CHAIN_SHARE_DIR="${GRIN_SHARE_DIR:-/var/www/html/grin}"
GRIN_DATA_DIR="${GRIN_DATA_PATH:-$HOME/.grin}"
GRIN_LOG_DIR="${GRIN_LOG_PATH:-$HOME/.grin/main/log}"

# ─── Press-enter helper ───────────────────────────────────────────────────────
pause() { echo ""; echo "Press Enter to return to menu..."; read -r; }

# tmux session name convention: grin_<nodetype>_<networktype>
_grin_session_name() {
    case "$(basename "${1:-}")" in
        mainnet-full)  echo "grin_full_mainnet"   ;;
        mainnet-prune) echo "grin_pruned_mainnet" ;;
        testnet-prune) echo "grin_pruned_testnet" ;;
        *)             echo "grin_$(basename "${1:-}")" ;;
    esac
}

# =============================================================================
# 8.1  Remote Node Manager
# =============================================================================
menu_node_monitor() {
    local monitor_script="$SCRIPT_DIR/081_host_monitor_port.sh"
    if [[ ! -f "$monitor_script" ]]; then
        error "081_host_monitor_port.sh not found in $SCRIPT_DIR"
        pause; return
    fi
    bash "$monitor_script"
}

# =============================================================================
# 8.4  Nginx Extended Features  (084_nginx_extended_features.sh)
# =============================================================================
menu_nginx_extended() {
    local ext_script="$SCRIPT_DIR/084_nginx_extended_features.sh"
    if [[ ! -f "$ext_script" ]]; then
        error "084_nginx_extended_features.sh not found in $SCRIPT_DIR"
        pause; return
    fi
    bash "$ext_script"
}

# =============================================================================
# 8.2  Service & Port Dashboard
# =============================================================================
show_service_dashboard() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  2  Service & Port Dashboard${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    # ── Ports ─────────────────────────────────────────────────────────────────
    echo ""
    echo -e "${BOLD}Port Status:${RESET}"
    printf "  ${BOLD}%-8s %-28s %-10s %s${RESET}\n" "Port" "Service" "Status" "PID"
    printf "  %-8s %-28s %-10s %s\n" "────────" "────────────────────────────" "──────────" "───────"

    declare -A PORT_LABELS=(
        [3413]="Node API       (mainnet)"
        [3414]="P2P            (mainnet)"
        [3415]="Wallet Listen  (mainnet)"
        [3416]="Stratum Mining (mainnet)"
        [13413]="Node API       (testnet)"
        [13414]="P2P            (testnet)"
        [13415]="Wallet Listen  (testnet)"
        [13416]="Stratum Mining (testnet)"
    )

    for port in 3413 3414 3415 3416 13413 13414 13415 13416; do
        local result pid_str status_col
        result=$(ss -tlnp "sport = :$port" 2>/dev/null | tail -n +2 || true)
        if [[ -n "$result" ]]; then
            pid_str=$(echo "$result" | grep -oP 'pid=\K[0-9]+' | head -1 || echo "-")
            status_col="${GREEN}OPEN${RESET}     "
            # Highlight wallet ports that should never be public
            if [[ "$port" == "3415" || "$port" == "13415" ]]; then
                status_col="${YELLOW}OPEN${RESET}  ${YELLOW}⚠${RESET}  "
            fi
        else
            pid_str="-"
            status_col="${DIM}closed${RESET}   "
        fi
        printf "  %-8s %-28s " "$port" "${PORT_LABELS[$port]}"
        echo -ne "$status_col $pid_str"
        echo ""
    done

    # Wallet port warning
    local w_open=false
    for wp in 3415 13415; do
        ss -tlnp "sport = :$wp" 2>/dev/null | tail -n +2 | grep -q . && w_open=true || true
    done
    if $w_open; then
        echo ""
        warn "Wallet listener port (3415/13415) is open — only expose to the internet if you know what you're doing!."
    fi

    # ── tmux sessions ─────────────────────────────────────────────────────────
    echo ""
    echo -e "${BOLD}tmux Sessions (grin*):${RESET}"
    local sessions
    sessions=$(tmux ls -F '#{session_name}  #{session_windows} window(s)  [#{session_created_string}]' \
        2>/dev/null | grep '^grin' || true)
    if [[ -n "$sessions" ]]; then
        while IFS= read -r s; do
            echo -e "  ${GREEN}▶${RESET} $s"
        done <<< "$sessions"
    else
        echo -e "  ${DIM}No grin* tmux sessions found.${RESET}"
    fi

    # ── Running grin processes + binary versions ─────────────────────────────
    echo ""
    echo -e "${BOLD}Running Grin Processes:${RESET}"
    local procs
    procs=$(pgrep -a -f '[g]rin' 2>/dev/null \
        | grep -v -E "(grin-node-toolkit|grin_node_admin|081_|088_)" || true)
    if [[ -n "$procs" ]]; then
        while IFS= read -r line; do
            echo -e "  ${CYAN}▶${RESET} $line"
        done <<< "$procs"
        # Extract unique binary paths and show their versions
        echo ""
        echo -e "${BOLD}Grin Binary Versions:${RESET}"
        local -A _seen_bins=()
        while IFS= read -r line; do
            local _bin
            _bin=$(awk '{print $2}' <<< "$line")
            _bin=$(readlink -f "$_bin" 2>/dev/null || echo "$_bin")
            if [[ -f "$_bin" && -z "${_seen_bins[$_bin]+x}" ]]; then
                _seen_bins["$_bin"]=1
                local _ver
                _ver=$("$_bin" --version 2>/dev/null | head -1 || echo "unknown")
                echo -e "  ${GREEN}✓${RESET}  $_bin  ${DIM}($_ver)${RESET}"
            fi
        done <<< "$procs"
    else
        echo -e "  ${DIM}No Grin processes detected.${RESET}"
    fi

    echo ""
    echo -e "  ${DIM}Log: $LOG_FILE${RESET}"
    pause
}

# =============================================================================
# 8.3  Chain Sync Status
# =============================================================================
show_chain_sync() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  3  Chain Sync Status${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    if ! command -v curl &>/dev/null; then
        error "curl is required for this feature. Install with: apt install curl"
        pause; return
    fi

    _query_node_tip() {
        local port="$1" secret_file="$2" label="$3"
        local secret=""
        [[ -f "$secret_file" ]] && secret=$(cat "$secret_file" 2>/dev/null || true)

        local response
        response=$(curl -s --max-time 5 \
            --user "grin:$secret" \
            -X POST "http://localhost:$port/v2/foreign" \
            -H "Content-Type: application/json" \
            -d '{"jsonrpc":"2.0","method":"get_tip","id":1,"params":[]}' \
            2>/dev/null || true)

        if [[ -z "$response" ]]; then
            echo -e "  ${RED}[OFFLINE]${RESET} $label on port $port — no response"
            return
        fi

        # Extract fields without jq dependency
        local height last_block difficulty sync_status
        height=$(echo "$response"     | grep -oP '"height":\K[0-9]+'            || echo "?")
        last_block=$(echo "$response" | grep -oP '"last_block_pushed":"\K[^"]+' || echo "?")
        difficulty=$(echo "$response" | grep -oP '"total_difficulty":\K[0-9]+'  || echo "?")

        echo -e "  ${GREEN}[ONLINE]${RESET}  $label — port $port"
        echo -e "  ${BOLD}  Height     :${RESET} $height"
        echo -e "  ${BOLD}  Last block :${RESET} ${last_block:0:16}..."
        echo -e "  ${BOLD}  Difficulty :${RESET} $difficulty"
        echo ""
        log "[8.3] $label port $port — height=$height"
    }

    echo -e "${BOLD}Mainnet node (port 3413):${RESET}"
    _query_node_tip 3413 "$HOME/.grin/main/api_secret" "Mainnet"

    echo -e "${BOLD}Testnet node (port 13413):${RESET}"
    _query_node_tip 13413 "$HOME/.grin/test/api_secret" "Testnet"

    echo -e "  ${DIM}Note: Compare height against a public explorer to estimate sync progress.${RESET}"
    echo -e "  ${DIM}  Mainnet: grin.blockscan.com  |  Testnet: testnet.grin.blockscan.com${RESET}"
    pause
}

# =============================================================================
# 8.5  Firewall Rules Audit
# =============================================================================
show_firewall_audit() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  5  Firewall Rules Audit${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    declare -A GRIN_PORTS=(
        [3413]="Node API mainnet  — expose if public API"
        [3414]="P2P mainnet       — should be open"
        [3415]="Wallet mainnet    — ONLY expose publicly if you uderstand"
        [3416]="Stratum mainnet   — open if mining pool"
        [13413]="Node API testnet  — expose if public API"
        [13414]="P2P testnet       — should be open"
        [13415]="Wallet testnet    — ONLY expose publicly if you uderstand"
        [13416]="Stratum testnet   — open if mining pool"
    )

    # ── UFW ───────────────────────────────────────────────────────────────────
    if command -v ufw &>/dev/null; then
        local ufw_status
        ufw_status=$(ufw status 2>/dev/null | head -1 || echo "unknown")
        echo -e "${BOLD}UFW Status:${RESET}  $ufw_status"
        echo ""

        echo -e "${BOLD}Grin Port Rules:${RESET}"
        printf "  ${BOLD}%-8s %-35s %-12s %s${RESET}\n" "Port" "Purpose" "UFW Rule" "Notes"
        printf "  %-8s %-35s %-12s %s\n" "────────" "───────────────────────────────────" "────────────" "────────────"

        for port in 3413 3414 3415 3416 13413 13414 13415 13416; do
            local label="${GRIN_PORTS[$port]}"
            local rule
            rule=$(ufw status numbered 2>/dev/null \
                | grep " $port" | head -1 \
                | grep -oP '(ALLOW|DENY|LIMIT|REJECT)\s+(IN|OUT|FWD)?' \
                | head -1 || true)
            rule="${rule:-none}"

            # Colour rule
            local rule_col="${DIM}none${RESET}    "
            [[ "$rule" == "ALLOW"* ]] && rule_col="${GREEN}ALLOW${RESET}   "
            [[ "$rule" == "DENY"*  ]] && rule_col="${RED}DENY${RESET}    "
            [[ "$rule" == "LIMIT"* ]] && rule_col="${YELLOW}LIMIT${RESET}   "

            # Flag dangerous: wallet ports open
            local note=""
            if [[ ( "$port" == "3415" || "$port" == "13415" ) && "$rule" == "ALLOW"* ]]; then
                note="${RED}⚠ DANGER: wallet owner port exposed${RESET}"
            fi

            printf "  %-8s %-35s " "$port" "$label"
            echo -ne "$rule_col  $note"
            echo ""
        done

        echo ""
        echo -e "${BOLD}Full UFW ruleset (Grin ports only):${RESET}"
        ufw status numbered 2>/dev/null \
            | grep -E "(3413|3414|3415|3416|13413|13414|13415|13416)" \
            | while IFS= read -r line; do
                echo -e "  ${DIM}$line${RESET}"
            done || echo -e "  ${DIM}No Grin ports in UFW rules.${RESET}"

    # ── iptables fallback ─────────────────────────────────────────────────────
    elif command -v iptables &>/dev/null; then
        echo -e "${BOLD}UFW not found — showing iptables INPUT rules:${RESET}"
        echo ""
        iptables -L INPUT -n -v 2>/dev/null \
            | grep -E "(34[0-9]{2}|134[0-9]{2}|ACCEPT|DROP|REJECT)" \
            | while IFS= read -r line; do
                echo -e "  $line"
            done || echo -e "  ${DIM}No matching iptables rules.${RESET}"
    else
        warn "Neither ufw nor iptables found. Cannot audit firewall."
    fi

    echo ""
    echo -e "  ${DIM}Recommendation: Ports 3414/13414 (P2P) should be open.${RESET}"
    echo -e "  ${DIM}                Ports 3415/13415 (Wallet) must NEVER be public.${RESET}"
    echo -e "  ${DIM}                Ports 3413/13413 (API) — open only if running public node.${RESET}"
    pause
}

# =============================================================================
# 8.6  Top 20 Bandwidth Consumers
# =============================================================================
show_bandwidth_consumers() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  6  Top 20 Bandwidth Consumers${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    # Collect nginx access logs
    local -a log_paths=()
    [[ -f /var/log/nginx/access.log ]] && log_paths+=("/var/log/nginx/access.log")
    while IFS= read -r f; do
        [[ "$f" != "/var/log/nginx/access.log" ]] && log_paths+=("$f")
    done < <(find /var/log/nginx -name '*.log' 2>/dev/null | grep -i access | head -10 || true)

    if [[ ${#log_paths[@]} -eq 0 ]]; then
        warn "No nginx access logs found in /var/log/nginx/."
        echo -e "  ${DIM}Ensure nginx is installed and access logging is enabled.${RESET}"
        pause; return
    fi

    info "Parsing ${#log_paths[@]} log file(s)..."
    echo ""

    local tmp
    tmp=$(mktemp)

    # Parse nginx combined log format using " as field separator.
    # With FS='"':  $1="IP - - [date time] "  $2="METHOD /path HTTP/x"  $3=" status bytes "
    # This is robust against URL paths containing spaces (which shift $10-based parsing).
    awk -F'"' '{
        split($1, a, " "); ip = a[1]
        split($3, b, " "); bytes = b[3]
        if (ip != "" && bytes ~ /^[0-9]+$/) tot[ip] += bytes
    }
    END { for (ip in tot) printf "%012d %s\n", tot[ip], ip }' \
        "${log_paths[@]}" 2>/dev/null \
        | sort -rn \
        | head -20 \
        | awk '{print $2, $1+0}' > "$tmp"

    if [[ ! -s "$tmp" ]]; then
        warn "No parseable data found in nginx access logs."
        echo ""
        info "Sample log lines (check format matches nginx combined):"
        head -3 "${log_paths[0]}" 2>/dev/null \
            | while IFS= read -r line; do echo -e "  ${DIM}$line${RESET}"; done \
            || true
        echo ""
        echo -e "  ${DIM}Expected format: \$remote_addr - \$remote_user [\$time_local] \"\$request\" \$status \$body_bytes_sent \"...\" \"...\"${RESET}"
        rm -f "$tmp"
        pause; return
    fi

    printf "  ${BOLD}%-6s  %-18s  %15s${RESET}\n" "Rank" "IP Address" "Data Served"
    printf "  %-6s  %-18s  %15s\n" "──────" "──────────────────" "───────────────"

    local rank=1
    local -a ip_list=()
    while IFS=' ' read -r ip bytes; do
        local human
        if   (( bytes >= 1073741824 )); then
            human=$(awk "BEGIN{printf \"%.2f GB\", $bytes/1073741824}")
        elif (( bytes >= 1048576 ));    then
            human=$(awk "BEGIN{printf \"%.2f MB\", $bytes/1048576}")
        elif (( bytes >= 1024 ));       then
            human=$(awk "BEGIN{printf \"%.2f KB\", $bytes/1024}")
        else
            human="${bytes} B"
        fi
        printf "  %-6s  %-18s  %15s\n" "$rank" "$ip" "$human"
        ip_list+=("$ip")
        rank=$((rank + 1))
    done < "$tmp"
    rm -f "$tmp"

    echo ""
    echo -e "  ${YELLOW}1${RESET}) Block or rate-limit a specific IP"
    echo -e "  ${DIM}0${RESET}) Return"
    echo ""
    echo -ne "${BOLD}Select [0-1]: ${RESET}"
    read -r choice

    if [[ "$choice" == "1" ]]; then
        echo ""
        echo -ne "Enter IP address to act on: "
        read -r target_ip

        if [[ -z "$target_ip" ]]; then
            warn "No IP entered."; pause; return
        fi

        echo ""
        echo -e "  ${RED}1${RESET}) Block all traffic from $target_ip"
        echo -e "  ${YELLOW}2${RESET}) Rate-limit with iptables hashlimit (25 conn/min)"
        echo -e "  ${DIM}0${RESET}) Cancel"
        echo ""
        echo -ne "${BOLD}Select [0-2]: ${RESET}"
        read -r action

        case "$action" in
            1)
                if command -v ufw &>/dev/null; then
                    echo -ne "${RED}Block ALL traffic from $target_ip? [y/N]: ${RESET}"
                    read -r c
                    if [[ "${c,,}" == "y" ]]; then
                        ufw deny from "$target_ip" to any \
                            && success "UFW rule added: deny from $target_ip" \
                            && log "[8.6] UFW BLOCKED: $target_ip"
                    else
                        info "Cancelled."
                    fi
                else
                    warn "ufw not available."
                    info "Equivalent iptables command:"
                    echo -e "  ${YELLOW}iptables -I INPUT -s $target_ip -j DROP${RESET}"
                fi
                ;;
            2)
                if ! command -v iptables &>/dev/null; then
                    warn "iptables not available."
                else
                    echo -ne "${YELLOW}Add hashlimit rate-limit for $target_ip? [y/N]: ${RESET}"
                    read -r c
                    if [[ "${c,,}" == "y" ]]; then
                        # Allow up to 25 connections/min, burst 100
                        iptables -I INPUT -s "$target_ip" \
                            -m hashlimit \
                            --hashlimit-name "rl_${target_ip//\./_}" \
                            --hashlimit-above 25/min \
                            --hashlimit-burst 100 \
                            --hashlimit-mode srcip \
                            -j DROP \
                            && success "Rate-limit rule added for $target_ip (>25 conn/min → DROP)" \
                            && log "[8.6] RATE-LIMITED via iptables hashlimit: $target_ip"
                    else
                        info "Cancelled."
                    fi
                fi
                ;;
            0|*) info "Cancelled." ;;
        esac
    fi

    pause
}

# =============================================================================
# 8.7  Disk Cleanup — merged single screen
# =============================================================================
_find_tar_files() {
    find "$1" -maxdepth 3 \
        \( -name "*.tar.gz" -o -name "*.tar" -o -name "*.tar.aa" -o -name "*.tar.ab" \) \
        2>/dev/null | sort
}

# Return unique nginx root directories from enabled site configs
_scan_nginx_web_dirs() {
    local conf_dir="/etc/nginx/sites-enabled"
    [[ -d "$conf_dir" ]] || return 0
    grep -h 'root ' "$conf_dir"/* 2>/dev/null \
        | grep -oP '(?<=root\s)[^;]+' \
        | awk '{$1=$1; print}' \
        | sort -u \
        | while IFS= read -r d; do
            [[ -d "$d" ]] && echo "$d"
        done
}

_clean_tmp()          { info "Cleaning /tmp (files >1 day)..."; find /tmp -mindepth 1 -mtime +1 -delete 2>/dev/null || true; success "/tmp cleaned."; log "CLEANED /tmp"; }
_clean_grin_logs()    {
    if [[ ! -d "$GRIN_LOG_DIR" ]]; then warn "Grin log dir not found: $GRIN_LOG_DIR"; return; fi
    echo -ne "Keep logs from last N days [default 7]: "; read -r kd; kd="${kd:-7}"
    find "$GRIN_LOG_DIR" -type f -name "*.log" -mtime +"$kd" -delete 2>/dev/null || true
    success "Grin logs older than $kd days removed."; log "CLEANED grin logs >$kd days"; }
_clean_syslog()       {
    info "Cleaning system journal..."
    if command -v journalctl &>/dev/null; then
        echo -ne "Vacuum journal to last N days [default 7]: "; read -r vd; vd="${vd:-7}"
        journalctl --vacuum-time="${vd}d"; success "journald vacuumed to last $vd days."; log "CLEANED journald --vacuum-time=${vd}d"
    else
        find /var/log -name "*.gz" -mtime +7 -delete 2>/dev/null || true
        find /var/log -name "*.1"  -mtime +7 -delete 2>/dev/null || true
        success "Rotated logs in /var/log cleaned."; log "CLEANED /var/log rotated files"
    fi; }
_clean_toolkit_logs() { info "Cleaning toolkit logs in /var/log..."; find /var/log -maxdepth 1 \( -name "grin*.log" -o -name "grin_*.log" \) -mtime +30 -delete 2>/dev/null || true; success "Toolkit logs >30 days removed."; log "CLEANED toolkit logs >30 days"; }
_clean_txhashset()    {
    local file_list="$1"
    if [[ -z "$file_list" ]]; then info "No txhashset files to remove."; return; fi
    local count=0
    while IFS= read -r f; do
        [[ -f "$f" ]] || continue; rm -f "$f"; log "DELETED txhashset: $f"; count=$((count+1))
    done <<< "$file_list"
    success "Removed $count txhashset file(s)."; }

clean_maintenance() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  7  Disk Cleanup${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "${DIM}Scanning...${RESET}"

        # ── Tar archives ──────────────────────────────────────────────────────
        local tar_dir="$CHAIN_SHARE_DIR"
        local tar_list tar_count=0 tar_size=0
        tar_list="$(_find_tar_files "$tar_dir" 2>/dev/null || true)"
        if [[ -n "$tar_list" ]]; then
            while IFS= read -r f; do
                local sz; sz="$(du -sk "$f" 2>/dev/null | awk '{print $1}' || echo 0)"
                tar_size=$((tar_size + sz)); tar_count=$((tar_count + 1))
            done <<< "$tar_list"
        fi

        # ── Nginx web dirs ────────────────────────────────────────────────────
        local -a nginx_dirs=()
        while IFS= read -r d; do [[ -n "$d" ]] && nginx_dirs+=("$d"); done \
            < <(_scan_nginx_web_dirs 2>/dev/null || true)

        # ── OS/log sizes ──────────────────────────────────────────────────────
        local txhashset_files
        txhashset_files="$(find /tmp "$GRIN_DATA_DIR" \( -name "txhashset*.zip" -o -name "*.txhashset" \) 2>/dev/null | sort || true)"
        local tmp_size txhashset_size grin_log_size syslog_size toolkit_log_size
        tmp_size="$(du -sh /tmp 2>/dev/null | awk '{print $1}' || echo '?')"
        txhashset_size="$( [[ -n "$txhashset_files" ]] && echo "$txhashset_files" | xargs du -shc 2>/dev/null | tail -1 | awk '{print $1}' || echo '0' )"
        grin_log_size="$(du -sh "$GRIN_LOG_DIR" 2>/dev/null | awk '{print $1}' || echo '0')"
        syslog_size="$(journalctl --disk-usage 2>/dev/null | awk '{print $NF}' || du -sh /var/log 2>/dev/null | awk '{print $1}' || echo '?')"
        toolkit_log_size="$(du -shc /var/log/grin*.log /var/log/grin_*.log 2>/dev/null | tail -1 | awk '{print $1}' || echo '0')"

        echo ""
        # ── Display tar section ───────────────────────────────────────────────
        echo -e "${BOLD}Chain Data Tar Archives  ${DIM}($tar_dir)${RESET}"
        if [[ $tar_count -eq 0 ]]; then
            echo -e "  ${DIM}No tar archives found.${RESET}"
        else
            while IFS= read -r f; do
                local fh; fh="$(du -sh "$f" 2>/dev/null | awk '{print $1}' || echo '?')"
                echo -e "  ${YELLOW}▶${RESET} $(basename "$f")  ${DIM}($fh)${RESET}"
            done <<< "$tar_list"
            echo -e "  Total: $tar_count file(s), ~$((tar_size / 1024)) MB"
        fi

        echo ""
        # ── Display nginx web dirs ────────────────────────────────────────────
        echo -e "${BOLD}Nginx Web Directories  ${DIM}(from nginx config)${RESET}"
        if [[ ${#nginx_dirs[@]} -eq 0 ]]; then
            echo -e "  ${DIM}No nginx web directories found.${RESET}"
        else
            local _idx=0
            for d in "${nginx_dirs[@]}"; do
                local dh; dh="$(du -sh "$d" 2>/dev/null | awk '{print $1}' || echo '?')"
                echo -e "  ${CYAN}$((_idx + 1))${RESET}) $d  ${DIM}($dh)${RESET}"
                _idx=$((_idx + 1))
            done
        fi

        echo ""
        # ── Display OS/logs section ───────────────────────────────────────────
        echo -e "${BOLD}OS & Log Files${RESET}"
        echo -e "  ${CYAN}A${RESET}) /tmp directory          : ${YELLOW}$tmp_size${RESET}"
        echo -e "  ${CYAN}B${RESET}) txhashset zip files     : ${YELLOW}$txhashset_size${RESET}"
        echo -e "  ${CYAN}C${RESET}) Grin node logs          : ${YELLOW}$grin_log_size${RESET}  ${DIM}($GRIN_LOG_DIR)${RESET}"
        echo -e "  ${CYAN}D${RESET}) System journal/syslog   : ${YELLOW}$syslog_size${RESET}"
        echo -e "  ${CYAN}E${RESET}) Grin-toolkit logs       : ${YELLOW}$toolkit_log_size${RESET}"

        echo ""
        echo -e "${BOLD}Actions:${RESET}"
        echo -e "  ${YELLOW}1${RESET}) Delete ALL tar archives"
        echo -e "  ${YELLOW}2${RESET}) Keep newest N tar archives, delete rest"
        echo -e "  ${YELLOW}3${RESET}) Delete tar archives older than N days"
        echo -e "  ${CYAN}4${RESET}) Clean selected OS/Log items  ${DIM}(enter letters, e.g. A C E)${RESET}"
        echo -e "  ${CYAN}5${RESET}) Clean ALL OS/Log items"
        if [[ ${#nginx_dirs[@]} -gt 0 ]]; then
            echo -e "  ${GREEN}6${RESET}) Delete nginx web dir contents  ${DIM}(choose directory)${RESET}"
        fi
        echo -e "  ${DIM}0${RESET}) Return to main menu"
        echo ""
        echo -ne "${BOLD}Select: ${RESET}"
        local choice
        read -r choice

        case "$choice" in
            1)
                if [[ $tar_count -eq 0 ]]; then warn "No tar archives found."; sleep 1; continue; fi
                echo -ne "${RED}Delete ALL $tar_count archive(s)? [y/N]: ${RESET}"; read -r confirm
                if [[ "${confirm,,}" == "y" ]]; then
                    while IFS= read -r f; do rm -f "$f"; log "DELETED: $f"; done <<< "$tar_list"
                    success "Deleted $tar_count archive(s). Freed ~$((tar_size / 1024)) MB."
                else
                    info "Cancelled."
                fi
                sleep 2
                ;;
            2)
                if [[ $tar_count -eq 0 ]]; then warn "No tar archives found."; sleep 1; continue; fi
                echo -ne "Keep newest N archives [default 2]: "; read -r keep_n; keep_n="${keep_n:-2}"
                local delete_list
                delete_list="$(_find_tar_files "$tar_dir" | head -n -"$keep_n" || true)"
                if [[ -z "$delete_list" ]]; then
                    info "Nothing to delete (only $tar_count archive(s), keeping $keep_n)."
                else
                    local del_count=0
                    while IFS= read -r f; do
                        echo -e "  ${RED}Removing:${RESET} $f"; rm -f "$f"
                        log "DELETED (keep-newest): $f"; del_count=$((del_count + 1))
                    done <<< "$delete_list"
                    success "Deleted $del_count archive(s)."
                fi
                sleep 2
                ;;
            3)
                if [[ $tar_count -eq 0 ]]; then warn "No tar archives found."; sleep 1; continue; fi
                echo -ne "Delete archives older than N days [default 14]: "; read -r days; days="${days:-14}"
                local del_count=0
                while IFS= read -r f; do
                    if find "$f" -mtime +"$days" -print 2>/dev/null | grep -q .; then
                        echo -e "  ${RED}Removing:${RESET} $f"; rm -f "$f"
                        log "DELETED (older than ${days}d): $f"; del_count=$((del_count + 1))
                    fi
                done <<< "$tar_list"
                success "Deleted $del_count archive(s) older than $days days."
                sleep 2
                ;;
            4)
                echo -ne "Letters to clean (e.g. A B D): "; read -r items; items="${items^^}"
                [[ "$items" == *"A"* ]] && _clean_tmp
                [[ "$items" == *"B"* ]] && _clean_txhashset "$txhashset_files"
                [[ "$items" == *"C"* ]] && _clean_grin_logs
                [[ "$items" == *"D"* ]] && _clean_syslog
                [[ "$items" == *"E"* ]] && _clean_toolkit_logs
                success "Selected cleanup complete."
                sleep 2
                ;;
            5)
                echo -ne "${RED}Clean ALL OS/Log items (A-E)? [y/N]: ${RESET}"; read -r confirm
                if [[ "${confirm,,}" == "y" ]]; then
                    _clean_tmp; _clean_txhashset "$txhashset_files"
                    _clean_grin_logs; _clean_syslog; _clean_toolkit_logs
                    success "All OS/Log cleanup complete."
                else
                    info "Cancelled."
                fi
                sleep 2
                ;;
            6)
                if [[ ${#nginx_dirs[@]} -eq 0 ]]; then warn "No nginx web dirs found."; sleep 1; continue; fi
                echo ""
                echo -e "${BOLD}Select nginx web directory to clean:${RESET}"
                local _idx=0
                for d in "${nginx_dirs[@]}"; do
                    local dh; dh="$(du -sh "$d" 2>/dev/null | awk '{print $1}' || echo '?')"
                    echo -e "  ${YELLOW}$((_idx + 1))${RESET}) $d  ${DIM}($dh)${RESET}"
                    _idx=$((_idx + 1))
                done
                echo -e "  ${RED}A${RESET}) Delete ALL web dir contents"
                echo -e "  ${DIM}0${RESET}) Cancel"
                echo ""
                echo -ne "Select: "; read -r wchoice
                if [[ "${wchoice,,}" == "a" ]]; then
                    echo -ne "${RED}Delete ALL contents of ${#nginx_dirs[@]} nginx web dir(s)? [y/N]: ${RESET}"
                    read -r confirm
                    if [[ "${confirm,,}" == "y" ]]; then
                        for d in "${nginx_dirs[@]}"; do
                            echo -ne "  Cleaning $d ... "
                            find "$d" -mindepth 1 -delete 2>/dev/null && echo "done" || echo "partial"
                            log "CLEANED nginx web dir: $d"
                        done
                        success "All nginx web dirs cleaned."
                    else
                        info "Cancelled."
                    fi
                elif [[ "$wchoice" =~ ^[0-9]+$ && $wchoice -ge 1 && $wchoice -le ${#nginx_dirs[@]} ]]; then
                    local chosen_dir="${nginx_dirs[$((wchoice - 1))]}"
                    local dh; dh="$(du -sh "$chosen_dir" 2>/dev/null | awk '{print $1}' || echo '?')"
                    echo -ne "${RED}Delete ALL contents of $chosen_dir ($dh)? [y/N]: ${RESET}"
                    read -r confirm
                    if [[ "${confirm,,}" == "y" ]]; then
                        find "$chosen_dir" -mindepth 1 -delete 2>/dev/null || true
                        log "CLEANED nginx web dir: $chosen_dir"
                        success "Cleaned: $chosen_dir"
                    else
                        info "Cancelled."
                    fi
                else
                    [[ "$wchoice" != "0" ]] && warn "Invalid selection."
                fi
                sleep 2
                ;;
            0) break ;;
            *) warn "Invalid selection."; sleep 1 ;;
        esac
    done
}

# =============================================================================
# 8.8  Self-Update — download latest from GitHub
# =============================================================================
self_update() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  8  Self-Update Grin-Node-Toolkit${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    if ! command -v curl &>/dev/null; then
        error "curl is not installed. Install with: apt install curl"
        pause; return
    fi

    # ── Resolve GitHub repo ───────────────────────────────────────────────────
    # /opt/grin/conf/github_repo.conf overrides the default (useful for forks)
    local repo="$GITHUB_REPO"
    local repo_conf="$CONF_DIR/github_repo.conf"
    if [[ -f "$repo_conf" ]]; then
        local saved_repo
        saved_repo=$(tr -d '[:space:]' < "$repo_conf" 2>/dev/null || true)
        [[ -n "$saved_repo" ]] && repo="$saved_repo"
    fi

    echo -e "  ${BOLD}Repository${RESET} : https://github.com/$repo"
    echo -e "  ${DIM}(to use a fork, save a slug to /opt/grin/conf/github_repo.conf)${RESET}"
    echo ""

    # ── Branch selection ──────────────────────────────────────────────────────
    echo -e "${BOLD}  Select branch to pull:${RESET}"
    echo ""
    echo -e "  ${GREEN}1${RESET})  main          ${DIM}— stable releases${RESET}"
    echo -e "  ${CYAN}2${RESET})  add-ons       ${DIM}— addon features in development${RESET}"
    echo -e "  ${CYAN}3${RESET})  corefeatures  ${DIM}— core features in development${RESET}"
    echo -e "  ${YELLOW}4${RESET})  Custom branch ${DIM}— enter branch name manually${RESET}"
    echo ""
    echo -ne "${BOLD}  Choose [1-4, default 1]: ${RESET}"
    read -r branch_choice

    local branch
    case "$branch_choice" in
        2) branch="add-ons" ;;
        3) branch="corefeatures" ;;
        4)
            echo -ne "  Branch name: "
            read -r branch
            branch=$(echo "$branch" | tr -d '[:space:]')
            if [[ -z "$branch" ]]; then
                warn "No branch entered. Defaulting to 'main'."
                branch="main"
            fi
            ;;
        *) branch="main" ;;
    esac

    local tarball_url="https://github.com/$repo/archive/refs/heads/$branch.tar.gz"
    echo ""
    info "Branch   : $branch"
    info "Download : $tarball_url"
    echo ""

    # ── Confirm ───────────────────────────────────────────────────────────────
    echo -ne "${YELLOW}Pull and install from branch '${branch}'? [Y/n]: ${RESET}"
    read -r confirm
    if [[ "${confirm,,}" == "n" ]]; then
        info "Update cancelled."
        pause; return
    fi

    # ── Download ──────────────────────────────────────────────────────────────
    local tmp_dir
    tmp_dir=$(mktemp -d /tmp/grin-toolkit-update-XXXXXX)

    echo ""
    info "Downloading from GitHub..."
    if ! curl -fsSL "$tarball_url" -o "$tmp_dir/update.tar.gz"; then
        error "Download failed. Check your internet connection or branch name."
        rm -rf "$tmp_dir"
        pause; return
    fi

    # ── Extract ───────────────────────────────────────────────────────────────
    info "Extracting..."
    if ! tar -xz -C "$tmp_dir" -f "$tmp_dir/update.tar.gz"; then
        error "Extraction failed. The downloaded file may be invalid."
        rm -rf "$tmp_dir"
        pause; return
    fi

    local extracted_dir
    extracted_dir=$(find "$tmp_dir" -mindepth 1 -maxdepth 1 -type d | head -1 || true)
    if [[ -z "$extracted_dir" ]]; then
        error "Could not find extracted directory."
        rm -rf "$tmp_dir"
        pause; return
    fi

    # ── Install ───────────────────────────────────────────────────────────────
    local toolkit_root
    toolkit_root="$(realpath "$SCRIPT_DIR/.." 2>/dev/null || echo "$SCRIPT_DIR/..")"
    info "Installing to $toolkit_root ..."
    cp -rf "$extracted_dir/." "$toolkit_root/"
    chmod +x "$toolkit_root/grin-node-toolkit.sh" "$toolkit_root/scripts/"*.sh 2>/dev/null || true

    rm -rf "$tmp_dir"
    echo ""
    success "Update complete — branch '${branch}' installed."
    success "Restart the toolkit to apply changes."
    log "[8.8] Installed from $tarball_url"

    echo ""
    echo -e "  ${DIM}Press Enter to exit the script completely${RESET}"
    echo -e "  ${DIM}Press 0 to return to the previous menu${RESET}"
    echo ""
    echo -ne "${BOLD}  [Enter / 0]: ${RESET}"
    read -r _exit_choice
    if [[ "$_exit_choice" == "0" ]]; then
        return
    else
        exit 100  # signals grin-node-toolkit.sh to exit completely
    fi
}

# =============================================================================
# 8.9  Backup  — placeholder for future implementation
# =============================================================================
backup() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  9  Backup${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  ${DIM}Coming soon — backup functionality not yet implemented.${RESET}"
    echo ""
    pause
}

# =============================================================================
# Full Grin Cleanup — delegate to 088
# =============================================================================
menu_full_cleanup() {
    local cleanup_script="$SCRIPT_DIR/08del_clean_all_grin_things.sh"
    if [[ ! -f "$cleanup_script" ]]; then
        error "08del_clean_all_grin_things.sh not found in $SCRIPT_DIR"
        pause; return
    fi
    bash "$cleanup_script"
}

# =============================================================================
# 8.10  Filesystem Standardization Wizard
# -----------------------------------------------------------------------------
# Interactive wizard that:
#   1. Asks where each Grin component currently lives (pre-fills from conf)
#   2. Asks where the new base directory should be (default: /opt/grin)
#   3. Creates the grin:grin system user
#   4. Stops running node/wallet tmux sessions
#   5. mv's each directory (no extra disk space needed — same filesystem)
#   6. Patches grin_instances_location.conf, grin-server.toml (db_root, log_file_path), crontab
#   7. Sets chown grin:grin + chmod 700 on wallet dirs
#
# New layout under <base>:
#   node/mainnet-full    node/mainnet-prune    node/testnet-prune
#   wallet/mainnet       wallet/testnet
# =============================================================================

# -----------------------------------------------------------------------------
# _migrate_stop_grin — gracefully stop all running Grin nodes before migration.
# Sends SIGTERM, waits up to 30 s for each process to exit, then SIGKILL if needed.
# Kills all grin_* tmux sessions (nodes + wallets), then does a final pgrep check.
# -----------------------------------------------------------------------------
_migrate_stop_grin() {
    local stop_timeout=30
    info "Gracefully stopping Grin nodes..."

    for port in 3414 13414; do
        local pid
        pid=$(ss -tlnp "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)
        [[ -z "$pid" ]] && continue
        info "PID $pid on port $port — sending SIGTERM..."
        kill -TERM "$pid" 2>/dev/null || true
        local count=0
        while ps -p "$pid" >/dev/null 2>&1 && [[ $count -lt $stop_timeout ]]; do
            sleep 2; count=$(( count + 2 ))
            [[ $(( count % 10 )) -eq 0 ]] && info "Waiting for Grin to stop... (${count}s)"
        done
        if ps -p "$pid" >/dev/null 2>&1; then
            warn "PID $pid still running after ${stop_timeout}s — sending SIGKILL..."
            kill -KILL "$pid" 2>/dev/null || true
            sleep 2
        fi
        success "Port $port process stopped."
    done

    # Kill all grin tmux sessions (nodes + wallets)
    local _sess
    while IFS= read -r _sess; do
        tmux kill-session -t "$_sess" 2>/dev/null && info "Tmux session '$_sess' closed." || true
    done < <(tmux ls -F '#{session_name}' 2>/dev/null | grep -E '^grin_' || true)

    # Final process verification
    local _still
    _still=$(pgrep -a -f '[g]rin server run' 2>/dev/null || true)
    if [[ -n "$_still" ]]; then
        warn "Some Grin processes still detected after stop — proceeding anyway:"
        while IFS= read -r _line; do echo -e "  ${YELLOW}→${RESET} $_line"; done <<< "$_still"
    else
        success "All Grin processes confirmed stopped."
    fi
}

migrate_filesystem() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  10  Filesystem Standardization Wizard${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Moves Grin node and wallet directories to a standard location,"
    echo -e "  creates the ${BOLD}grin${RESET} service user, and patches all configs."
    echo ""
    echo -e "  ${YELLOW}Requirements:${RESET}"
    echo -e "    • Run as root"
    echo -e "    • Source and destination must be on the ${BOLD}same filesystem${RESET}  (uses mv)"
    echo -e "    • All Grin processes will be stopped during migration"
    echo -e "    • Type ${BOLD}-${RESET} to skip a pre-detected component"
    echo ""

    if [[ $EUID -ne 0 ]]; then
        error "Must be run as root."; pause; return
    fi

    # ── Step 1: Destination base ───────────────────────────────────────────────
    echo -e "${BOLD}── Step 1/3: Destination ──────────────────────────────────────────${RESET}"
    echo -e "  New layout:"
    echo -e "    ${DIM}<base>/node/mainnet-full   mainnet-prune   testnet-prune${RESET}"
    echo -e "    ${DIM}<base>/wallet/mainnet   testnet${RESET}"
    echo ""
    echo -ne "  Base directory [/opt/grin]: "
    read -r dest_base || true
    dest_base="${dest_base:-/opt/grin}"
    dest_base="${dest_base%/}"
    local dest_node="$dest_base/node"
    local dest_wallet="$dest_base/wallet"
    echo ""

    # ── Step 2: Source locations ───────────────────────────────────────────────
    echo -e "${BOLD}── Step 2/3: Current Locations ────────────────────────────────────${RESET}"
    echo -e "  ${DIM}Press Enter to accept default. Type - to skip a component.${RESET}"
    echo ""

    # Pre-fill nodes from grin_instances_location.conf
    # Source in a subshell so variables are extracted reliably without polluting current env
    local inst_conf="$CONF_DIR/grin_instances_location.conf"
    local pre_fullmain="" pre_prunemain="" pre_prunetest=""
    if [[ -f "$inst_conf" ]]; then
        info "Reading instances conf: $inst_conf"
        pre_fullmain=$(  (source "$inst_conf" 2>/dev/null; echo "${FULLMAIN_GRIN_DIR:-}")  2>/dev/null || true)
        pre_prunemain=$( (source "$inst_conf" 2>/dev/null; echo "${PRUNEMAIN_GRIN_DIR:-}") 2>/dev/null || true)
        pre_prunetest=$(  (source "$inst_conf" 2>/dev/null; echo "${PRUNETEST_GRIN_DIR:-}") 2>/dev/null || true)
    else
        warn "Instances conf not found: $inst_conf"
        warn "Node paths not pre-filled — enter them manually below."
    fi

    # Pre-fill wallets from known legacy defaults (not in instances conf)
    local pre_walletmain="" pre_wallettest=""
    [[ -d "/opt/grin/wallet/mainnet" ]] && pre_walletmain="/opt/grin/wallet/mainnet"
    [[ -d "/opt/grin/wallet/testnet" ]] && pre_wallettest="/opt/grin/wallet/testnet"

    local src_fullmain="" src_prunemain="" src_prunetest="" src_walletmain="" src_wallettest=""
    local _shown

    _shown="${pre_fullmain:-(not detected)}";   echo -ne "  Mainnet full node  [$_shown]: "; read -r src_fullmain  || true
    [[ -z "$src_fullmain"  ]] && src_fullmain="$pre_fullmain";   [[ "$src_fullmain"  == "-" ]] && src_fullmain=""
    _shown="${pre_prunemain:-(not detected)}";  echo -ne "  Mainnet prune node [$_shown]: "; read -r src_prunemain || true
    [[ -z "$src_prunemain" ]] && src_prunemain="$pre_prunemain"; [[ "$src_prunemain" == "-" ]] && src_prunemain=""
    _shown="${pre_prunetest:-(not detected)}";  echo -ne "  Testnet prune node [$_shown]: "; read -r src_prunetest || true
    [[ -z "$src_prunetest" ]] && src_prunetest="$pre_prunetest"; [[ "$src_prunetest" == "-" ]] && src_prunetest=""
    _shown="${pre_walletmain:-(not detected)}"; echo -ne "  Mainnet wallet     [$_shown]: "; read -r src_walletmain || true
    [[ -z "$src_walletmain" ]] && src_walletmain="$pre_walletmain"; [[ "$src_walletmain" == "-" ]] && src_walletmain=""
    _shown="${pre_wallettest:-(not detected)}"; echo -ne "  Testnet wallet     [$_shown]: "; read -r src_wallettest || true
    [[ -z "$src_wallettest" ]] && src_wallettest="$pre_wallettest"; [[ "$src_wallettest" == "-" ]] && src_wallettest=""
    echo ""

    # ── Build move plan (parallel indexed arrays) ──────────────────────────────
    local -a move_srcs=() move_dsts=() move_types=()
    local -a _all_srcs=("$src_fullmain"  "$src_prunemain"  "$src_prunetest"  "$src_walletmain"  "$src_wallettest")
    local -a _all_dsts=("$dest_node/mainnet-full" "$dest_node/mainnet-prune" "$dest_node/testnet-prune" "$dest_wallet/mainnet" "$dest_wallet/testnet")
    local -a _all_types=("node" "node" "node" "wallet" "wallet")
    local _i
    for _i in "${!_all_srcs[@]}"; do
        local _s="${_all_srcs[$_i]}" _d="${_all_dsts[$_i]}" _t="${_all_types[$_i]}"
        [[ -z "$_s" ]] && continue
        if [[ ! -d "$_s" ]]; then
            warn "Source not found, skipping: $_s"; continue
        fi
        if [[ "$_s" == "$_d" ]]; then
            info "Already at target, skipping: $_s"; continue
        fi
        move_srcs+=("$_s"); move_dsts+=("$_d"); move_types+=("$_t")
    done

    if [[ ${#move_srcs[@]} -eq 0 ]]; then
        if [[ ! -s "$inst_conf" ]]; then
            # Directories already in place but conf is empty — scan dest and rebuild.
            warn "Nothing to migrate — conf is empty. Scanning $dest_base for installed nodes..."
            echo ""
            local -a _scan_dirs=( "$dest_base/node/mainnet-prune" "$dest_base/node/mainnet-full" "$dest_base/node/testnet-prune" )
            declare -A _scan_keys=( [mainnet-prune]="PRUNEMAIN" [mainnet-full]="FULLMAIN" [testnet-prune]="PRUNETEST" )
            local _scan_found=0
            mkdir -p "$CONF_DIR"
            touch "$inst_conf"
            for _sd in "${_scan_dirs[@]}"; do
                [[ -x "$_sd/grin" ]] || continue
                local _sk="${_scan_keys[$(basename "$_sd")]:-}"
                [[ -z "$_sk" ]] && continue
                cat >> "$inst_conf" << __EOF__

${_sk}_GRIN_DIR="$_sd"
${_sk}_BINARY="$_sd/grin"
${_sk}_TOML="$_sd/grin-server.toml"
${_sk}_CHAIN_DATA="$_sd/chain_data"
__EOF__
                success "Conf entry: $_sk → $_sd"
                _scan_found=$(( _scan_found + 1 ))
            done
            chmod 600 "$inst_conf" 2>/dev/null || true
            echo ""
            if [[ $_scan_found -gt 0 ]]; then
                success "grin_instances_location.conf rebuilt with $_scan_found node(s)."
            else
                warn "No grin binaries found in $dest_base — nothing rebuilt."
                info  "Run Script 01 to install a node, or re-run option 10 with the correct source path."
            fi

            # Also scan wallet dirs
            local -a _wscan_dirs=( "$dest_base/wallet/mainnet" "$dest_base/wallet/testnet" )
            declare -A _wscan_keys=( [mainnet]="MAINNET" [testnet]="TESTNET" )
            touch "$WALLETS_CONF"
            for _wd in "${_wscan_dirs[@]}"; do
                [[ -x "$_wd/grin-wallet" ]] || continue
                local _wk="${_wscan_keys[$(basename "$_wd")]:-}"
                [[ -z "$_wk" ]] && continue
                sed -i "/^${_wk}_WALLET_/d" "$WALLETS_CONF" 2>/dev/null || true
                cat >> "$WALLETS_CONF" << __EOF__

${_wk}_WALLET_DIR="$_wd"
${_wk}_WALLET_BIN="$_wd/grin-wallet"
${_wk}_WALLET_TOML="$_wd/grin-wallet.toml"
${_wk}_WALLET_DATA="$_wd/wallet_data"
__EOF__
                success "Wallet conf entry: $_wk → $_wd"
            done
            chmod 600 "$WALLETS_CONF" 2>/dev/null || true
        else
            info "All directories already at target — nothing to migrate."
        fi

        # Even when nothing moves, ensure grin user exists and owns the tree.
        echo ""
        if id grin &>/dev/null; then
            info "System user 'grin' already exists."
        else
            useradd -r -s /usr/sbin/nologin -d "$dest_base" -M grin \
                && success "System user grin:grin created." \
                || warn "Failed to create user 'grin' — manual creation may be needed."
        fi
        if [[ -d "$dest_base" ]]; then
            info "Setting ownership: chown -R grin:grin $dest_base"
            chown -R grin:grin "$dest_base" 2>/dev/null || true
            for _wdir in "$dest_base/wallet/mainnet" "$dest_base/wallet/testnet"; do
                [[ -d "$_wdir" ]] || continue
                chmod 700 "$_wdir" 2>/dev/null || true
                [[ -d "$_wdir/wallet_data" ]] && chmod 700 "$_wdir/wallet_data" || true
            done
            success "Permissions set."
        fi
        pause; return
    fi

    # ── Same-filesystem guard ──────────────────────────────────────────────────
    local _dest_parent; _dest_parent="$(dirname "$dest_base")"
    [[ ! -d "$_dest_parent" ]] && _dest_parent="/"
    local _dest_dev; _dest_dev="$(stat -c '%d' "$_dest_parent" 2>/dev/null || echo "0")"
    for _i in "${!move_srcs[@]}"; do
        local _src_dev; _src_dev="$(stat -c '%d' "${move_srcs[$_i]}" 2>/dev/null || echo "1")"
        if [[ "$_src_dev" != "$_dest_dev" ]]; then
            error "Cross-filesystem move detected: ${move_srcs[$_i]} → ${move_dsts[$_i]}"
            error "Source and destination are on different filesystems."
            warn  "Mount the destination on the same filesystem as the source, then retry."
            pause; return
        fi
    done

    # ── Step 3: Plan + confirm ─────────────────────────────────────────────────
    echo -e "${BOLD}── Step 3/3: Migration Plan ───────────────────────────────────────${RESET}"
    echo ""
    echo -e "  ${BOLD}Service user  :${RESET}  grin:grin  (system user, no login shell)"
    echo ""
    echo -e "  ${BOLD}Moves:${RESET}"
    for _i in "${!move_srcs[@]}"; do
        printf "    ${CYAN}%-38s${RESET} → ${GREEN}%s${RESET}\n" "${move_srcs[$_i]}" "${move_dsts[$_i]}"
    done
    echo ""
    echo -e "  ${BOLD}Patches:${RESET}  grin_instances_location.conf · grin_wallets_location.conf · grin-server.toml · grin-wallet.toml · crontab"
    echo -e "  ${BOLD}Perms:${RESET}    chown -R grin:grin $dest_base · chmod 700 wallet dirs"
    echo ""
    echo -ne "  Proceed? [y/N]: "
    read -r _confirm || true
    [[ "${_confirm,,}" != "y" ]] && { info "Migration cancelled."; pause; return; }
    echo ""

    # ── Phase 1: Create grin:grin system user ─────────────────────────────────
    if id grin &>/dev/null; then
        info "System user 'grin' already exists — skipping."
    else
        useradd -r -s /usr/sbin/nologin -d "$dest_base" -M grin \
            && success "System user grin:grin created." \
            || { error "Failed to create user grin."; pause; return; }
    fi

    # ── Phase 2: Create destination structure ─────────────────────────────────
    mkdir -p "$dest_node" "$dest_wallet"

    # ── Phase 3: Stop all Grin processes (graceful) ───────────────────────────
    _migrate_stop_grin

    # ── Phase 4: Move directories ──────────────────────────────────────────────
    local moved=0
    for _i in "${!move_srcs[@]}"; do
        local _src="${move_srcs[$_i]}" _dst="${move_dsts[$_i]}"
        mkdir -p "$(dirname "$_dst")"
        info "Moving: $_src → $_dst"
        if mv "$_src" "$_dst"; then
            success "Moved: $_dst"
            moved=$((moved + 1))
        else
            error "Failed to move $_src → $_dst — stopping migration."
            warn  "Components moved so far: $moved. Manual cleanup may be required."
            pause; return
        fi
    done

    # ── Phase 5: Rebuild grin_instances_location.conf ─────────────────────────
    # Always write fresh entries — sed-based patching silently fails when the file
    # was empty (cleared by a prior kill) or entries were missing.
    info "Updating grin_instances_location.conf..."
    mkdir -p "$CONF_DIR"
    touch "$inst_conf"
    for _i in "${!move_srcs[@]}"; do
        [[ "${move_types[$_i]}" == "node" ]] || continue
        local _bname; _bname=$(basename "${move_dsts[$_i]}")
        local _key
        case "$_bname" in
            mainnet-prune) _key="PRUNEMAIN" ;;
            mainnet-full)  _key="FULLMAIN"  ;;
            testnet-prune) _key="PRUNETEST" ;;
            *) warn "Unknown node dir name '$_bname' — skipping conf entry."; continue ;;
        esac
        # Remove stale entries; also remove sibling mainnet key if applicable
        sed -i "/^${_key}_/d" "$inst_conf" 2>/dev/null || true
        [[ "$_key" == "FULLMAIN"  ]] && { sed -i '/^PRUNEMAIN_/d' "$inst_conf" 2>/dev/null || true; }
        [[ "$_key" == "PRUNEMAIN" ]] && { sed -i '/^FULLMAIN_/d'  "$inst_conf" 2>/dev/null || true; }
        local _ndst="${move_dsts[$_i]}"
        cat >> "$inst_conf" << __EOF__

${_key}_GRIN_DIR="$_ndst"
${_key}_BINARY="$_ndst/grin"
${_key}_TOML="$_ndst/grin-server.toml"
${_key}_CHAIN_DATA="$_ndst/chain_data"
__EOF__
        info "Conf entry: $_key → $_ndst"
    done
    chmod 600 "$inst_conf" 2>/dev/null || true
    success "grin_instances_location.conf updated."

    # ── Phase 5b: Update grin_wallets_location.conf ────────────────────────────
    touch "$WALLETS_CONF"
    for _i in "${!move_srcs[@]}"; do
        [[ "${move_types[$_i]}" == "wallet" ]] || continue
        local _wbname; _wbname=$(basename "${move_dsts[$_i]}")
        local _wkey
        case "$_wbname" in
            mainnet) _wkey="MAINNET" ;;
            testnet) _wkey="TESTNET" ;;
            *) warn "Unknown wallet dir name '$_wbname' — skipping wallet conf entry."; continue ;;
        esac
        sed -i "/^${_wkey}_WALLET_/d" "$WALLETS_CONF" 2>/dev/null || true
        local _wdst="${move_dsts[$_i]}"
        cat >> "$WALLETS_CONF" << __EOF__

${_wkey}_WALLET_DIR="$_wdst"
${_wkey}_WALLET_BIN="$_wdst/grin-wallet"
${_wkey}_WALLET_TOML="$_wdst/grin-wallet.toml"
${_wkey}_WALLET_DATA="$_wdst/wallet_data"
__EOF__
        info "Wallet conf entry: $_wkey → $_wdst"
    done
    chmod 600 "$WALLETS_CONF" 2>/dev/null || true

    # Double-check: if the conf is still empty (e.g. no nodes were in move_srcs),
    # scan the standard locations and write any entries we can find.
    if [[ ! -s "$inst_conf" ]]; then
        warn "Conf file is empty — scanning standard locations as fallback..."
        local -a _scan_dirs=( "/opt/grin/node/mainnet-prune" "/opt/grin/node/mainnet-full" "/opt/grin/node/testnet-prune" )
        declare -A _scan_keys=( [mainnet-prune]="PRUNEMAIN" [mainnet-full]="FULLMAIN" [testnet-prune]="PRUNETEST" )
        for _sd in "${_scan_dirs[@]}"; do
            [[ -x "$_sd/grin" ]] || continue
            local _sk="${_scan_keys[$(basename "$_sd")]:-}"
            [[ -z "$_sk" ]] && continue
            cat >> "$inst_conf" << __EOF__

${_sk}_GRIN_DIR="$_sd"
${_sk}_BINARY="$_sd/grin"
${_sk}_TOML="$_sd/grin-server.toml"
${_sk}_CHAIN_DATA="$_sd/chain_data"
__EOF__
            info "Conf entry (scan fallback): $_sk → $_sd"
        done
        chmod 600 "$inst_conf" 2>/dev/null || true
    fi

    # Also scan wallet dirs if wallets_conf is empty
    if [[ ! -s "$WALLETS_CONF" ]]; then
        local -a _wfb_dirs=( "$dest_base/wallet/mainnet" "$dest_base/wallet/testnet" )
        declare -A _wfb_keys=( [mainnet]="MAINNET" [testnet]="TESTNET" )
        touch "$WALLETS_CONF"
        for _wd in "${_wfb_dirs[@]}"; do
            [[ -x "$_wd/grin-wallet" ]] || continue
            local _wk="${_wfb_keys[$(basename "$_wd")]:-}"
            [[ -z "$_wk" ]] && continue
            cat >> "$WALLETS_CONF" << __EOF__

${_wk}_WALLET_DIR="$_wd"
${_wk}_WALLET_BIN="$_wd/grin-wallet"
${_wk}_WALLET_TOML="$_wd/grin-wallet.toml"
${_wk}_WALLET_DATA="$_wd/wallet_data"
__EOF__
            info "Wallet conf entry (scan fallback): $_wk → $_wd"
        done
        chmod 600 "$WALLETS_CONF" 2>/dev/null || true
    fi

    # ── Phase 6: Patch grin-server.toml ───────────────────────────────────────
    for _i in "${!move_srcs[@]}"; do
        [[ "${move_types[$_i]}" == "node" ]] || continue
        local _toml="${move_dsts[$_i]}/grin-server.toml"
        if [[ -f "$_toml" ]]; then
            info "Patching grin-server.toml in $(basename "${move_dsts[$_i]}")..."
            sed -i "s|db_root\s*=\s*\".*\"|db_root = \"${move_dsts[$_i]}/chain_data\"|" "$_toml" 2>/dev/null || true
            sed -i "s|log_file_path\s*=\s*\".*\"|log_file_path = \"${move_dsts[$_i]}/grin-server.log\"|" "$_toml" 2>/dev/null || true
            sed -i "s|api_secret_path\s*=\s*\".*\"|api_secret_path = \"${move_dsts[$_i]}/.api_secret\"|" "$_toml" 2>/dev/null || true
            sed -i "s|foreign_api_secret_path\s*=\s*\".*\"|foreign_api_secret_path = \"${move_dsts[$_i]}/.foreign_api_secret\"|" "$_toml" 2>/dev/null || true
            success "grin-server.toml patched."
        fi
    done

    # ── Phase 6b: Patch grin-wallet.toml ──────────────────────────────────────
    for _i in "${!move_srcs[@]}"; do
        [[ "${move_types[$_i]}" == "wallet" ]] || continue
        local _wtoml="${move_dsts[$_i]}/grin-wallet.toml"
        if [[ -f "$_wtoml" ]]; then
            info "Patching grin-wallet.toml in $(basename "${move_dsts[$_i]}")..."
            sed -i "s|log_file_path\s*=\s*\".*\"|log_file_path = \"${move_dsts[$_i]}/grin-wallet.log\"|" "$_wtoml" 2>/dev/null || true
            sed -i "s|api_secret_path\s*=\s*\".*\"|api_secret_path = \"${move_dsts[$_i]}/.api_secret\"|" "$_wtoml" 2>/dev/null || true
            sed -i "s|owner_api_secret_path\s*=\s*\".*\"|owner_api_secret_path = \"${move_dsts[$_i]}/.owner_api_secret\"|" "$_wtoml" 2>/dev/null || true
            success "grin-wallet.toml patched."
        fi
    done

    # ── Phase 7: Update crontab ────────────────────────────────────────────────
    local _cron_orig; _cron_orig="$(crontab -l 2>/dev/null || true)"
    if [[ -n "$_cron_orig" ]]; then
        local _cron_new="$_cron_orig" _cron_changed=0
        for _i in "${!move_srcs[@]}"; do
            if echo "$_cron_new" | grep -qF "${move_srcs[$_i]}" 2>/dev/null; then
                _cron_new="${_cron_new//${move_srcs[$_i]}/${move_dsts[$_i]}}"
                _cron_changed=1
            fi
        done
        if [[ $_cron_changed -eq 1 ]]; then
            echo "$_cron_new" | crontab -
            success "Crontab updated."
        else
            info "No cron entries reference old paths — nothing to update."
        fi
    fi

    # ── Phase 8: chown + chmod ─────────────────────────────────────────────────
    info "Setting ownership: chown -R grin:grin $dest_base"
    chown -R grin:grin "$dest_base"
    for _i in "${!move_srcs[@]}"; do
        [[ "${move_types[$_i]}" == "wallet" ]] || continue
        local _wdir="${move_dsts[$_i]}"
        chmod 700 "$_wdir" 2>/dev/null || true
        [[ -d "$_wdir/wallet_data" ]] && chmod 700 "$_wdir/wallet_data" || true
        for _secret in "$_wdir/wallet_data/.api_secret" "$_wdir/wallet_data/.owner_api_secret"; do
            [[ -f "$_secret" ]] && chmod 600 "$_secret" || true
        done
    done
    success "Permissions set."

    # ── Phase 9: Restart nodes in new location ─────────────────────────────────
    local -a _node_dsts=()
    for _i in "${!move_types[@]}"; do
        [[ "${move_types[$_i]}" == "node" ]] && _node_dsts+=("${move_dsts[$_i]}")
    done

    if [[ ${#_node_dsts[@]} -gt 0 ]]; then
        info "Restarting Grin node(s) in new location..."
        local _nstarted=0
        for _ndst in "${_node_dsts[@]}"; do
            if [[ ! -x "$_ndst/grin" ]]; then
                warn "No grin binary at $_ndst — skipping auto-start."; continue
            fi

            # Tolerant re-patch: Phase 6 sed may have silently failed on whitespace variants.
            local _toml="$_ndst/grin-server.toml"
            if [[ -f "$_toml" ]]; then
                sed -i "s|db_root\s*=\s*\".*\"|db_root = \"$_ndst/chain_data\"|" "$_toml" 2>/dev/null || true
                sed -i "s|log_file_path\s*=\s*\".*\"|log_file_path = \"$_ndst/grin-server.log\"|" "$_toml" 2>/dev/null || true
                sed -i "s|api_secret_path\s*=\s*\".*\"|api_secret_path = \"$_ndst/.api_secret\"|" "$_toml" 2>/dev/null || true
                sed -i "s|foreign_api_secret_path\s*=\s*\".*\"|foreign_api_secret_path = \"$_ndst/.foreign_api_secret\"|" "$_toml" 2>/dev/null || true
                info "grin-server.toml paths verified for $_ndst"
            fi

            # Remove stale LMDB lock file left by SIGKILL — prevents grin from starting.
            find "$_ndst/chain_data" -maxdepth 3 -name "lock.mdb" -delete 2>/dev/null || true

            # Kill any lingering session with the same name before creating a new one.
            local _nsess; _nsess="$(_grin_session_name "$_ndst")"
            if tmux has-session -t "$_nsess" 2>/dev/null; then
                tmux kill-session -t "$_nsess" 2>/dev/null || true
            fi

            chown -R grin:grin "$_ndst" 2>/dev/null || true
            if id grin &>/dev/null; then
                tmux new-session -d -s "$_nsess" -c "$_ndst" \
                    "echo 'Starting Grin node...'; su -s /bin/bash -c 'cd \"$_ndst\" && ./grin server run' grin; echo ''; echo 'Grin process exited. Press Enter to close.'; read" \
                    || warn "Failed to start tmux session $_nsess."
            else
                tmux new-session -d -s "$_nsess" -c "$_ndst" \
                    "echo 'Starting Grin node...'; cd \"$_ndst\" && ./grin server run; echo ''; echo 'Grin process exited. Press Enter to close.'; read" \
                    || warn "Failed to start tmux session $_nsess."
            fi
            success "Node started in tmux session: $_nsess"
            info "  Attach : tmux attach -t $_nsess"
            _nstarted=$(( _nstarted + 1 ))
            if [[ $_nstarted -lt ${#_node_dsts[@]} ]]; then
                info "Waiting 30 seconds before starting next node..."
                sleep 30
            fi
        done
    fi

    # ── Summary ────────────────────────────────────────────────────────────────
    echo ""
    echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${GREEN}  Done — $moved component(s) moved to $dest_base${RESET}"
    echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  ${BOLD}Next steps:${RESET}"
    echo -e "  ${GREEN}1${RESET})  Update toolkit default path constants to use $dest_base"
    echo -e "       Pull the latest toolkit version after the code update is released."
    echo -e "  ${GREEN}2${RESET})  Restart wallet (if applicable): Script 05 → Start wallet listener"
    echo ""
    log "[migrate_filesystem] moved=$moved dest=$dest_base"
    pause
}

# =============================================================================
# Main menu
# =============================================================================
show_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 08)  Grin Node Administration Centre${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "${BOLD}  Monitoring${RESET}"
    echo -e "  ${GREEN}1${RESET})   Remote Node Manager       ${DIM}monitor · mass deploy · remote control${RESET}"
    echo -e "  ${GREEN}2${RESET})   Service & Port Dashboard  ${DIM}local PIDs, ports, tmux sessions${RESET}"
    echo -e "  ${GREEN}3${RESET})   Chain Sync Status         ${DIM}query local node API for current tip${RESET}"
    echo ""
    echo -e "${BOLD}  Security & Network${RESET}"
    echo -e "  ${CYAN}4${RESET})   Nginx Extended Features   ${DIM}audit · reverse proxy · security · logs${RESET}"
    echo -e "  ${CYAN}5${RESET})   Firewall Rules Audit      ${DIM}UFW / iptables review for Grin ports${RESET}"
    echo -e "  ${CYAN}6${RESET})   Top 20 Bandwidth Consumers${DIM} parse nginx logs, block/limit IP${RESET}"
    echo ""
    echo -e "${BOLD}  Maintenance${RESET}"
    echo -e "  ${YELLOW}7${RESET})   Disk Cleanup              ${DIM}tar archives + OS temp/logs + nginx dirs${RESET}"
    echo -e "  ${YELLOW}8${RESET})   Self-Update               ${DIM}pull latest changes from GitHub${RESET}"
    echo -e "  ${YELLOW}9${RESET})   Backup                    ${DIM}coming soon${RESET}"
    echo -e "  ${YELLOW}10${RESET})  Filesystem Standardization ${DIM}relocate dirs, create grin user, patch configs${RESET}"
    echo ""
    echo -e "${BOLD}  Danger Zone${RESET}"
    echo -e "  ${RED}DEL${RESET}) Full Grin Cleanup         ${DIM}remove EVERYTHING about Grin now!${RESET}"
    echo ""
    echo -e "  ${DIM}0${RESET})   Return to main menu"
    echo ""
    echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -ne "${BOLD}Select [0-10, DEL]: ${RESET}"
}

main() {
    while true; do
        show_menu
        read -r choice

        case "${choice,,}" in
            "1")   menu_node_monitor        ;;
            "2")   show_service_dashboard   ;;
            "3")   show_chain_sync          ;;
            "4")   menu_nginx_extended         ;;
            "5")   show_firewall_audit      ;;
            "6")   show_bandwidth_consumers ;;
            "7")   clean_maintenance        ;;
            "8")   self_update              ;;
            "9")   backup                   ;;
            "10")  migrate_filesystem       ;;
            "del") menu_full_cleanup        ;;
            "0")   break                    ;;
            *)     warn "Invalid option." ; sleep 1 ;;
        esac
    done
}

main "$@"
