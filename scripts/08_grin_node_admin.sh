#!/bin/bash
# =============================================================================
# 08_grin_node_admin.sh - Grin Node Administration Centre
# =============================================================================
# Menu:
#   8.1  Remote Node Monitor       — check peer ports via nc, log & email
#   8.2  Service & Port Dashboard  — local PIDs, ports, tmux, binary versions
#   8.3  Chain Sync Status         — query local node API for current tip
#   8.4  nginx Config & SSL Audit  — list configs, test, check cert expiry
#   8.5  Firewall Rules Audit      — UFW/iptables review for Grin ports
#   8.6  Top 20 Bandwidth Consumers— parse nginx logs, block/limit from menu
#   8.7  Disk Cleanup              — tar archives + OS temp/logs + nginx web dirs
#   8.8  Self-Update               — download latest from GitHub
#   8.9  Full Grin Cleanup         — 08del_clean_all_grin_things.sh
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_DIR="$SCRIPT_DIR/../conf"

# ─── GitHub self-update ───────────────────────────────────────────────────────
# Official public repository. A fork slug saved in conf/github_repo.conf
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

# =============================================================================
# 8.1  Remote Node Monitor
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
# 8.4  nginx Config & SSL Audit
# =============================================================================
show_nginx_audit() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  4  nginx Config & SSL Audit${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    if ! command -v nginx &>/dev/null; then
        warn "nginx not installed. Skipping."
        pause; return
    fi

    # ── Config test ──────────────────────────────────────────────────────────
    echo -e "${BOLD}nginx configuration test:${RESET}"
    if nginx -t 2>&1 | grep -q "test is successful"; then
        success "nginx -t passed — configuration is valid."
    else
        echo ""
        nginx -t 2>&1 | while IFS= read -r line; do
            echo -e "  ${RED}▶${RESET} $line"
        done
        echo ""
        warn "nginx configuration has errors. Review before proceeding."
    fi

    # ── Grin-related configs ─────────────────────────────────────────────────
    echo ""
    echo -e "${BOLD}Grin nginx config files:${RESET}"
    local -a grin_confs=()
    while IFS= read -r conf; do
        grin_confs+=("$conf")
    done < <(find /etc/nginx/sites-available -name '*grin*' -type f 2>/dev/null | sort || true)

    if [[ ${#grin_confs[@]} -eq 0 ]]; then
        echo -e "  ${DIM}No Grin-related nginx configs found.${RESET}"
    else
        printf "  ${BOLD}%-42s %-10s %-10s %s${RESET}\n" "Config" "Enabled" "Type" "Domain / Root"
        printf "  %-42s %-10s %-10s %s\n" \
            "──────────────────────────────────────────" "──────────" "──────────" "─────────────────────"
        for conf in "${grin_confs[@]}"; do
            local name enabled_str type_str detail
            name="$(basename "$conf")"
            local symlink="/etc/nginx/sites-enabled/$name"
            if [[ -L "$symlink" ]]; then
                enabled_str="${GREEN}yes${RESET}      "
            else
                enabled_str="${RED}no${RESET}       "
            fi

            if grep -q "proxy_pass" "$conf" 2>/dev/null; then
                type_str="proxy    "
                detail=$(grep -oP '(?<=proxy_pass\s)http[^;]+' "$conf" 2>/dev/null | head -1 || echo "-")
            else
                type_str="filesvr  "
                detail=$(grep -oP '(?<=root\s)[^;]+' "$conf" 2>/dev/null | head -1 | xargs || echo "-")
            fi

            printf "  %-42s " "$name"
            echo -ne "$enabled_str "
            printf "%-10s %s\n" "$type_str" "$detail"
        done
    fi

    # ── SSL certificate expiry ────────────────────────────────────────────────
    echo ""
    echo -e "${BOLD}SSL Certificate Expiry:${RESET}"

    if ! command -v openssl &>/dev/null; then
        warn "openssl not found — cannot check certificate expiry."
    else
        local found_ssl=false
        for conf in "${grin_confs[@]}"; do
            # Extract domain from server_name or ssl_certificate path
            local domain
            domain=$(grep -oP '(?<=server_name\s)[^\s;]+' "$conf" 2>/dev/null | head -1 || true)
            [[ -z "$domain" || "$domain" == "_" ]] && continue

            local cert_info expiry_date days_left
            cert_info=$(echo "" | timeout 5 openssl s_client \
                -connect "$domain:443" -servername "$domain" 2>/dev/null \
                | openssl x509 -noout -enddate 2>/dev/null || true)

            if [[ -z "$cert_info" ]]; then
                echo -e "  ${DIM}▶ $domain — could not connect or no SSL${RESET}"
                continue
            fi

            found_ssl=true
            expiry_date=$(echo "$cert_info" | grep -oP '(?<=notAfter=).*' || echo "unknown")
            days_left=$(( ( $(date -d "$expiry_date" +%s 2>/dev/null || echo 0) - $(date +%s) ) / 86400 ))

            if [[ $days_left -le 0 ]]; then
                echo -e "  ${RED}▶${RESET} $domain — ${RED}EXPIRED${RESET} ($expiry_date)"
            elif [[ $days_left -le 14 ]]; then
                echo -e "  ${RED}▶${RESET} $domain — expires in ${RED}$days_left days${RESET} ($expiry_date)"
            elif [[ $days_left -le 30 ]]; then
                echo -e "  ${YELLOW}▶${RESET} $domain — expires in ${YELLOW}$days_left days${RESET} ($expiry_date)"
            else
                echo -e "  ${GREEN}▶${RESET} $domain — expires in ${GREEN}$days_left days${RESET} ($expiry_date)"
            fi
            log "[8.4] SSL $domain — $days_left days left"
        done
        $found_ssl || echo -e "  ${DIM}No SSL-enabled Grin domains found.${RESET}"
    fi

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
    # conf/github_repo.conf overrides the default (useful for forks)
    local repo="$GITHUB_REPO"
    local repo_conf="$CONF_DIR/github_repo.conf"
    if [[ -f "$repo_conf" ]]; then
        local saved_repo
        saved_repo=$(tr -d '[:space:]' < "$repo_conf" 2>/dev/null || true)
        [[ -n "$saved_repo" ]] && repo="$saved_repo"
    fi

    echo -e "  ${BOLD}Repository${RESET} : https://github.com/$repo"
    echo -e "  ${DIM}(to use a fork, save a slug to conf/github_repo.conf)${RESET}"
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
    echo -ne "${YELLOW}Pull and install from branch '${branch}'? [y/N]: ${RESET}"
    read -r confirm
    if [[ "${confirm,,}" != "y" ]]; then
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

    pause
}

# =============================================================================
# 8.9  Full Grin Cleanup — delegate to 088
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
# Main menu
# =============================================================================
show_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Grin Node Administration Centre${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "${BOLD}  Monitoring${RESET}"
    echo -e "  ${GREEN}1${RESET})   Remote Node Monitor       ${DIM}check peer ports, log & email${RESET}"
    echo -e "  ${GREEN}2${RESET})   Service & Port Dashboard  ${DIM}local PIDs, ports, tmux sessions${RESET}"
    echo -e "  ${GREEN}3${RESET})   Chain Sync Status         ${DIM}query local node API for current tip${RESET}"
    echo ""
    echo -e "${BOLD}  Security & Network${RESET}"
    echo -e "  ${CYAN}4${RESET})   nginx Config & SSL Audit  ${DIM}configs, cert expiry, enabled check${RESET}"
    echo -e "  ${CYAN}5${RESET})   Firewall Rules Audit      ${DIM}UFW / iptables review for Grin ports${RESET}"
    echo -e "  ${CYAN}6${RESET})   Top 20 Bandwidth Consumers${DIM} parse nginx logs, block/limit IP${RESET}"
    echo ""
    echo -e "${BOLD}  Maintenance${RESET}"
    echo -e "  ${YELLOW}7${RESET})   Disk Cleanup              ${DIM}tar archives + OS temp/logs + nginx dirs${RESET}"
    echo -e "  ${YELLOW}8${RESET})   Self-Update               ${DIM}pull latest changes from GitHub${RESET}"
    echo ""
    echo -e "${BOLD}  Danger Zone${RESET}"
    echo -e "  ${RED}DEL${RESET}) Full Grin Cleanup         ${DIM}remove EVERYTHING about Grin now!${RESET}"
    echo ""
    echo -e "  ${DIM}0${RESET})   Return to main menu"
    echo ""
    echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -ne "${BOLD}Select [0-8, DEL]: ${RESET}"
}

main() {
    while true; do
        show_menu
        read -r choice

        case "${choice,,}" in
            "1")   menu_node_monitor        ;;
            "2")   show_service_dashboard   ;;
            "3")   show_chain_sync          ;;
            "4")   show_nginx_audit         ;;
            "5")   show_firewall_audit      ;;
            "6")   show_bandwidth_consumers ;;
            "7")   clean_maintenance        ;;
            "8")   self_update              ;;
            "del") menu_full_cleanup        ;;
            "0")   break                    ;;
            *)     warn "Invalid option." ; sleep 1 ;;
        esac
    done
}

main "$@"
