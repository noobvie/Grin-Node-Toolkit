#!/bin/bash
################################################################################
# Script 02 — Nginx File Server Manager
# Part of: Grin Node Toolkit  (https://github.com/noobvie/grin-node-toolkit)
################################################################################
#
# PURPOSE
#   Manages nginx virtual hosts that serve Grin chain-data archives over HTTPS
#   for download by other nodes, and supports custom domains for any static
#   file directory.
#
# MENU OPTIONS
#   1) Build Grin Master Nodes — Mainnet
#         Configure a domain for a mainnet Grin node.
#         Allowed prefixes: fullmain / prunemain
#         Auto-maps: fullmain.* → /var/www/fullmain
#                    prunemain.* → /var/www/prunemain
#         If already configured: shows existing domain; use Remove Domain first.
#
#   2) Build Grin Master Nodes — Testnet
#         Configure a domain for a testnet Grin node.
#         Allowed prefix: prunetest
#         Auto-maps: prunetest.* → /var/www/prunetest
#         If already configured: shows existing domain; use Remove Domain first.
#
#   3) Add Custom Domain
#         Configure any non-Grin domain pointing to any directory.
#         Blocked: fullmain / prunemain / prunetest prefixes and their
#                  corresponding /var/www/* directories are reserved for
#                  options 1 & 2 and cannot be used here.
#
#   4) Remove Domain      — Remove a managed nginx virtual host (optionally delete files).
#   5) List Domains       — Show all configured nginx virtual hosts.
#   6) Limit Rate         — Set per-IP download speed cap (anti-DDoS / abuse).
#   7) Lift Rate          — Remove or reset per-IP speed cap.
#   8) Install fail2ban   — Install & configure fail2ban for nginx.
#   9) Fail2ban Mgmt      — Status, unban IPs, list bans.
#  10) IP Filtering       — Block / Unblock IPs via ufw or iptables.
#
# GRIN SUBDOMAIN CONVENTIONS
#   fullmain.*   — Mainnet full archive node  (archive_mode = true,  ~25 GiB)
#   prunemain.*  — Mainnet pruned node        (archive_mode = false, ~10 GiB)
#   prunetest.*  — Testnet pruned node        (archive_mode = false, ~10 GiB)
#   DNS record must be set to "DNS only" (not Proxied) for certbot and DNSSeed.
#
# FEATURES
#   · SSL via Let's Encrypt (certbot); HSTS enforced
#   · Optional per-IP bandwidth quota and speed limiting
#   · IP rate limiting and fail2ban integration
#   · Directory listing (nginx autoindex)
#   · Firewall rules (ufw / iptables / firewalld) opened automatically
#
# PREREQUISITES
#   · Must be run as root
#   · nginx and certbot (auto-installed if missing)
#   · DNS A record pointing to this server's IP before running
#   · Ports 80 and 443 open and reachable from the internet
#
# NON-INTERACTIVE MODE
#   Set ACTION and the variables below before running to skip the interactive
#   menu. Valid ACTION values:
#     grin_mainnet | grin_testnet | custom | remove | list |
#     limit_rate | lift_rate | enhance_security | fail2ban_management | ip_filtering
#
# LOG FILE
#   <toolkit_root>/log/02_nginx_<action>_YYYYMMDD_HHMMSS.log
#
################################################################################

set -e  # Exit on any error

# ── Non-interactive configuration ────────────────────────────────────────────
# Set ACTION here, or leave empty for interactive menu
# Options: "grin_mainnet" | "grin_testnet" | "custom" | "remove" | "list" |
#          "limit_rate" | "lift_rate" | "enhance_security" | "fail2ban_management" | "ip_filtering"
ACTION=""

# Domain configuration (for setup/add operations)
DOMAIN=""                    # e.g., "files.example.com"
EMAIL=""                     # e.g., "admin@example.com"
FILES_DIR=""                 # e.g., "/var/www/myfiles" (leave empty for default)

# Bandwidth limiting settings (optional — leave empty to disable)
ENABLE_BANDWIDTH_LIMIT=""    # Set to "yes" to enable, empty to disable
DOWNLOAD_QUOTA_GB="40"       # Download quota per IP in GB (default: 40 GB)
SPEED_LIMIT_AFTER_QUOTA="1m" # Speed after quota hit (e.g. 1m = 1 MB/s)
NORMAL_SPEED_LIMIT="10m"     # Normal speed cap per connection (empty = unlimited)

# Domain removal configuration
DOMAIN_TO_REMOVE=""          # Domain to remove
DELETE_FILES=""              # "yes" to delete files, "no" to keep

#############################################################################
# System Variables - DO NOT EDIT
#############################################################################

# Script location (used for relative log path)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="/opt/grin/logs"
LOG_FILE=""   # Set dynamically in main() once the action is known

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;36m'
NC='\033[0m' # No Color

# Default values
DEFAULT_FILES_DIR="/var/www/fileserver"
NGINX_AVAILABLE="/etc/nginx/sites-available"
NGINX_ENABLED="/etc/nginx/sites-enabled"
BANDWIDTH_TRACKING_DIR="/var/log/nginx/bandwidth"
BANDWIDTH_SCRIPT="/usr/local/bin/nginx-bandwidth-limiter.sh"
IP_LIMITS_CONF="/etc/nginx/conf.d/grin_ip_limits.conf"
FAIL2BAN_JAIL_CONF="/etc/fail2ban/jail.d/nginx-grin.conf"
BLOCKED_LIST_FILE="/etc/grin-toolkit/blocked_ips.list"
FIREWALL=""   # Populated by detect_firewall()

# Detect a running Grin instance on the given port and return the recommended
# web dir path matching script 03's naming convention (fullmain/prunemain/prunetest).
# Returns 1 (no output) if no Grin is found on that port.
suggest_grin_web_dir() {
    local port=$1 pid binary dir cfg chain_line net ntype

    if command -v lsof &>/dev/null; then
        pid=$(lsof -ti :"$port" 2>/dev/null)
    elif command -v ss &>/dev/null; then
        pid=$(ss -tlnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' | head -1)
    elif command -v netstat &>/dev/null; then
        pid=$(netstat -tlnp 2>/dev/null | grep ":$port " | grep -oP '[0-9]+/.*' | cut -d'/' -f1 | head -1)
    fi
    [ -z "$pid" ] && return 1

    binary=$(readlink -f "/proc/$pid/exe" 2>/dev/null)
    { [ -z "$binary" ] || [ ! -f "$binary" ]; } && return 1
    dir=$(dirname "$binary")

    local proc_cwd
    proc_cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null) || proc_cwd=""
    cfg=""
    for loc in "$dir/grin-server.toml" "$proc_cwd/grin-server.toml"; do
        [ -f "$loc" ] && { cfg="$loc"; break; }
    done

    # Read chain_type line only — broad grep would match comments
    chain_line=""
    [ -f "$cfg" ] && chain_line=$(grep -E '^\s*chain_type\s*=' "$cfg" 2>/dev/null | head -1)

    if echo "$chain_line" | grep -qi "Testnet"; then
        net="testnet"; ntype="pruned"
    elif [[ -z "$chain_line" && "$port" == "13414" ]]; then
        # Config not readable — port 13414 is exclusively Grin testnet
        net="testnet"; ntype="pruned"
    else
        net="mainnet"
        ntype="pruned"
        [ -f "$cfg" ] && grep -qiE 'archive_mode\s*=\s*true' "$cfg" 2>/dev/null && ntype="full"
    fi

    case "${net}:${ntype}" in
        mainnet:full)   echo "/var/www/fullmain"  ;;
        mainnet:pruned) echo "/var/www/prunemain" ;;
        testnet:pruned) echo "/var/www/prunetest"  ;;
        *)              return 1 ;;
    esac
}

#############################################################################
# Helper Functions
#############################################################################

# 0.1 - Print colored info message
print_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

# 0.2 - Print colored warning message
print_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

# 0.3 - Print colored error message
print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 0.4 - Print section header
print_section() {
    echo ""
    echo "========================================="
    echo "$1"
    echo "========================================="
}

# 0.5 - Print blue info message
print_blue() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

# 1.0 - Function to validate domain name
validate_domain() {
    local domain=$1
    # Basic domain validation regex
    if [[ $domain =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$ ]]; then
        return 0
    else
        return 1
    fi
}

# 1.1 - Function to validate email
validate_email() {
    local email=$1
    if [[ $email =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; then
        return 0
    else
        return 1
    fi
}

# 1.2 - Validate IPv4 address
validate_ip() {
    local ip="$1"
    local IFS='.'
    read -r -a octets <<< "$ip"
    if [[ ${#octets[@]} -ne 4 ]]; then return 1; fi
    for octet in "${octets[@]}"; do
        [[ "$octet" =~ ^[0-9]+$ ]] || return 1
        (( octet >= 0 && octet <= 255 )) || return 1
    done
    return 0
}

# 1.3 - Convert a rate string (e.g. "1m", "500k") to bytes/s for nginx geo block
convert_rate_to_bytes() {
    local rate="${1,,}"
    if [[ "$rate" =~ ^([0-9]+)m$ ]]; then
        echo $(( ${BASH_REMATCH[1]} * 1048576 ))
    elif [[ "$rate" =~ ^([0-9]+)k$ ]]; then
        echo $(( ${BASH_REMATCH[1]} * 1024 ))
    elif [[ "$rate" =~ ^[0-9]+$ ]]; then
        echo "$rate"
    else
        return 1
    fi
}

# 1.4 - Ensure the geo conf file exists with a valid header
ensure_geo_conf() {
    if [[ ! -f "$IP_LIMITS_CONF" ]]; then
        mkdir -p "$(dirname "$IP_LIMITS_CONF")"
        cat > "$IP_LIMITS_CONF" << 'EOF'
# Grin File Server - Per-IP rate limits (bytes/s, 0 = unlimited)
# Managed by 02_nginx-fileserver-manager.sh
geo $remote_addr $grin_rate_limit {
    default 0;
}
EOF
        print_info "Created IP rate limit config: $IP_LIMITS_CONF"
    fi
}

# 1.5 - Display currently rate-limited IPs from the geo conf
_bytes_to_human() {
    local b="${1:-0}"
    if (( b == 0 ));         then echo "Unlimited"
    elif (( b >= 1048576 )); then echo "$((b / 1048576))MB/s"
    elif (( b >= 1024 ));    then echo "$((b / 1024))KB/s"
    else                          echo "${b}B/s"
    fi
}

show_current_restrictions() {
    echo ""
    print_section "Current Rate Limiting Status"

    # ── Default (global) rate ──
    local default_bytes=0
    if [[ -f "$IP_LIMITS_CONF" ]]; then
        default_bytes=$(grep -E '^\s+default\s+[0-9]+;' "$IP_LIMITS_CONF" \
            | grep -oP '[0-9]+' | head -1 || echo "0")
        default_bytes="${default_bytes:-0}"
    fi
    printf "  %-22s %s\n" "Default (all IPs):" "$(_bytes_to_human "$default_bytes")"

    # ── Per-IP overrides ──
    echo ""
    echo "  Per-IP overrides:"
    if [[ ! -f "$IP_LIMITS_CONF" ]]; then
        echo "    (none)"
    else
        local count=0
        while IFS= read -r line; do
            if [[ "$line" =~ ^[[:space:]]+([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})[[:space:]]+([0-9]+)\; ]]; then
                local ip="${BASH_REMATCH[1]}"
                local bytes="${BASH_REMATCH[2]}"
                printf "    %-20s %s\n" "$ip" "$(_bytes_to_human "$bytes")"
                count=$(( count + 1 ))
            fi
        done < "$IP_LIMITS_CONF"
        [[ $count -eq 0 ]] && echo "    (none)"
    fi

    # ── Domains with rate limiting injected ──
    echo ""
    echo "  Domains with rate limiting active:"
    local found=0
    for conf in "$NGINX_AVAILABLE"/*; do
        [[ -f "$conf" ]] || continue
        local dname; dname="$(basename "$conf")"
        [[ "$dname" == "default" || "$dname" == "default-ssl" ]] && continue
        if grep -q 'limit_rate \$grin_rate_limit' "$conf" 2>/dev/null; then
            echo "    ✓ $dname"
            found=$(( found + 1 ))
        fi
    done
    [[ $found -eq 0 ]] && echo "    (none — rate limit directive not injected into any site)"

    echo ""
}

# 1.6 - Inject limit_rate directive into all managed nginx site configs
inject_rate_limit_to_sites() {
    local injected=0
    for conf_file in "$NGINX_AVAILABLE"/*; do
        [[ -f "$conf_file" ]] || continue
        local domain
        domain="$(basename "$conf_file")"
        [[ "$domain" == "default" || "$domain" == "default-ssl" ]] && continue

        if ! grep -q 'limit_rate \$grin_rate_limit' "$conf_file" 2>/dev/null; then
            if grep -q "autoindex_format html;" "$conf_file" 2>/dev/null; then
                sed -i 's/autoindex_format html;/autoindex_format html;\n        limit_rate $grin_rate_limit;/' "$conf_file"
                injected=$(( injected + 1 ))
                print_info "Injected rate limit directive into: $domain"
            fi
        fi
    done

    if [[ $injected -gt 0 ]]; then
        if nginx -t &>/dev/null; then
            systemctl reload nginx
            print_info "Nginx reloaded with rate limit directives"
        else
            print_error "Nginx config test failed after rate limit injection"
            nginx -t
        fi
    fi
}

# 1.7 - Detect available firewall (ufw or iptables)
detect_firewall() {
    if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
        FIREWALL="ufw"
    elif command -v iptables &>/dev/null; then
        FIREWALL="iptables"
    else
        FIREWALL="none"
        print_warn "No supported firewall found (ufw or iptables). IP blocking will not work."
    fi
    print_info "Firewall detected: $FIREWALL"
}

# 1.8 - Initialise directories for security data
init_security_dirs() {
    mkdir -p /etc/grin-toolkit
    touch "$BLOCKED_LIST_FILE" 2>/dev/null || true
}

# 1.9 - Function to check if running as root
check_root() {
    if [[ $EUID -ne 0 ]]; then
        print_error "This script must be run as root (use sudo)"
        exit 1
    fi
}

#############################################################################
# Menu Functions
#############################################################################

# 2.0 - Display main menu
show_main_menu() {
    clear
    cat << "EOF"
╔════════════════════════════════════════════════════════════════╗
║                                                                ║
║     02)   Nginx Server Management Script                       ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
EOF

    echo ""
    echo "Select an action:"
    echo ""
    echo "  1) Setup 1st Grin Master Node domain  - Mainnet  (fullmain / prunemain)"
    echo "  2) Setup 2nd Grin Master Node domain  - Testnet  (prunetest)"
    echo "  3) Add Custom Domain                  - Any non-Grin domain"
    echo "  4) Remove Domain                      - Remove domain and its configuration"
    echo "  5) List Domains                       - Show all configured domains"
    echo ""
    echo "  6) Limit Rate / Bandwidth     - Set per-IP speed cap (anti-DDoS / abuse)"
    echo "  7) Lift Rate / Bandwidth      - Remove or reset per-IP speed cap"
    echo "  8) Install fail2ban           - Install & configure fail2ban for nginx"
    echo "  9) Fail2ban Management        - Status, unban IPs, list bans"
    echo " 10) IP Filtering               - Block / Unblock IPs via ufw or iptables"
    echo ""
    echo "  0) Exit"
    echo ""
}

# 2.1 - Get action from menu or parameter
get_action() {
    if [[ -n "$ACTION" ]]; then
        case "$ACTION" in
            grin_mainnet|grin_testnet|custom|remove|list|limit_rate|lift_rate|enhance_security|fail2ban_management|ip_filtering)
                return 0
                ;;
            *)
                print_error "Invalid ACTION: $ACTION"
                print_info "Valid options: grin_mainnet, grin_testnet, custom, remove, list, limit_rate, lift_rate, enhance_security, fail2ban_management, ip_filtering"
                exit 1
                ;;
        esac
    fi

    while true; do
        show_main_menu
        read -p "Enter choice [0-10]: " choice

        case $choice in
            1)  ACTION="grin_mainnet"       ; break ;;
            2)  ACTION="grin_testnet"       ; break ;;
            3)  ACTION="custom"             ; break ;;
            4)  ACTION="remove"             ; break ;;
            5)  ACTION="list"               ; break ;;
            6)  ACTION="limit_rate"         ; break ;;
            7)  ACTION="lift_rate"          ; break ;;
            8)  ACTION="enhance_security"   ; break ;;
            9)  ACTION="fail2ban_management"; break ;;
            10) ACTION="ip_filtering"       ; break ;;
            0)
                print_info "Exiting..."
                exit 0
                ;;
            "")  ;;  # Enter with no input — refresh menu
            *)
                print_error "Invalid choice. Please select 0-10."
                sleep 2
                ;;
        esac
    done
}

#############################################################################
# Common Functions (Used by Setup and Add)
#############################################################################

# Ensure nginx + certbot are installed. Single prompt if either (or both) are missing.
# Returns 1 if the user cancels or declines.
ensure_nginx_certbot() {
    local need_nginx=false need_certbot=false label
    command -v nginx   &>/dev/null || need_nginx=true
    command -v certbot &>/dev/null || need_certbot=true

    $need_nginx || $need_certbot || return 0   # both present — nothing to do

    $need_nginx && $need_certbot && label="Nginx and Certbot are" \
        || { $need_nginx && label="Nginx is" || label="Certbot is"; }

    local _choice
    read -r -p "${label} not installed. Install now? (Y/n/0) [default: Y, 0 = cancel]: " _choice
    [[ "$_choice" == "0" ]]        && return 1
    [[ "${_choice,,}" =~ ^n ]]     && print_error "${label} required. Exiting." && return 1

    if $need_nginx; then
        print_section "Installing Nginx"
        if [[ -f /etc/debian_version ]]; then
            apt-get update && apt-get install -y nginx
        elif [[ -f /etc/redhat-release ]]; then
            yum install -y epel-release nginx
        else
            print_error "Unsupported OS"; return 1
        fi
        systemctl enable nginx && systemctl start nginx
        print_info "Nginx installed and started successfully"
    fi

    if $need_certbot; then
        print_section "Installing Certbot"
        if [[ -f /etc/debian_version ]]; then
            apt-get update && apt-get install -y certbot python3-certbot-nginx
        elif [[ -f /etc/redhat-release ]]; then
            yum install -y certbot python3-certbot-nginx
        fi
        print_info "Certbot installed successfully"
    fi
}

# 4.0 - Function to show help
show_help() {
    cat << EOF
Usage: $0 [OPTIONS]

Nginx File Server Manager — Part of Grin Node Toolkit

ACTIONS (choose one):
    --action grin_mainnet        Configure a mainnet Grin domain (fullmain / prunemain prefix)
    --action grin_testnet        Configure a testnet Grin domain (prunetest prefix)
    --action custom              Add a custom (non-Grin) domain
    --action remove              Remove an existing domain
    --action list                List all configured domains
    --action limit_rate          Set per-IP download speed cap
    --action lift_rate           Remove / reset per-IP speed cap
    --action enhance_security    Apply nginx security hardening
    --action fail2ban_management Install / manage fail2ban for nginx
    --action ip_filtering        Block / unblock IPs via ufw or iptables

CONFIGURATION OPTIONS (for grin_mainnet / grin_testnet / custom):
    --domain DOMAIN         Domain name (e.g., prunemain.example.com)
    --email EMAIL           Email for Let's Encrypt notifications
    --dir DIRECTORY         Files directory (default: /var/www/fileserver)

BANDWIDTH OPTIONS (optional):
    --enable-bandwidth      Enable bandwidth limiting
    --quota GB              Download quota in GB (default: 40)
    --speed-after SPEED     Speed after quota (default: 1m)
    --normal-speed SPEED    Normal speed limit (default: 10m, empty = unlimited)

REMOVAL OPTIONS (for remove action):
    --domain DOMAIN         Domain to remove
    --delete-files          Also delete files directory

GENERAL OPTIONS:
    -h, --help              Show this help message

EXAMPLES:
    # Interactive menu mode:
    sudo $0

    # Configure a mainnet Grin domain:
    sudo $0 --action grin_mainnet --domain prunemain.example.com --email admin@example.com

    # Configure a testnet Grin domain:
    sudo $0 --action grin_testnet --domain prunetest.example.com --email admin@example.com

    # Add custom (non-Grin) domain:
    sudo $0 --action custom --domain files.example.com --email admin@example.com

    # Add custom domain with bandwidth limiting:
    sudo $0 --action custom --domain files.example.com --email admin@example.com \\
            --enable-bandwidth --quota 50 --speed-after 2m

    # Remove domain (keep files):
    sudo $0 --action remove --domain old.example.com

    # Remove domain and delete files:
    sudo $0 --action remove --domain old.example.com --delete-files

    # List all domains:
    sudo $0 --action list

CONFIGURATION FILE:
    You can also edit variables at the top of this script:
    - ACTION="grin_mainnet|grin_testnet|custom|remove|list|limit_rate|lift_rate|enhance_security|fail2ban_management|ip_filtering"
    - DOMAIN="files.example.com"
    - EMAIL="admin@example.com"
    - And more...

EOF
}

# 4.1 - Function to parse command line arguments
parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --action)
                ACTION="$2"
                shift 2
                ;;
            --domain)
                DOMAIN="$2"
                DOMAIN_TO_REMOVE="$2"
                shift 2
                ;;
            --email)
                EMAIL="$2"
                shift 2
                ;;
            --dir)
                FILES_DIR="$2"
                shift 2
                ;;
            --enable-bandwidth)
                ENABLE_BANDWIDTH_LIMIT="yes"
                shift
                ;;
            --quota)
                DOWNLOAD_QUOTA_GB="$2"
                shift 2
                ;;
            --speed-after)
                SPEED_LIMIT_AFTER_QUOTA="$2"
                shift 2
                ;;
            --normal-speed)
                NORMAL_SPEED_LIMIT="$2"
                shift 2
                ;;
            --delete-files)
                DELETE_FILES="yes"
                shift
                ;;
            -h|--help)
                show_help
                exit 0
                ;;
            *)
                print_error "Unknown option: $1"
                show_help
                exit 1
                ;;
        esac
    done
}

# 5.0 - Function to get domain input
get_domain() {
    local mode="${1:-custom}"   # mainnet | testnet | custom

    # Detect running mainnet node type once — used for both hint and validation
    local _mn_detected=""
    [[ "$mode" == "mainnet" ]] && _mn_detected=$(suggest_grin_web_dir 3414 2>/dev/null) || true

    echo ""
    echo -e "${YELLOW}[DNS]${NC} Point your A record to this server. If using Cloudflare, change"
    echo -e "      from ${RED}Proxied${NC} to ${GREEN}DNS only${NC} — makes your node become a DNSSeed and avoids"
    echo -e "      certbot / Let's Encrypt issues."
    echo ""
    case "$mode" in
        mainnet)
            echo -e "  ${YELLOW}Required subdomain prefix for mainnet:${NC}"
            case "$_mn_detected" in
                */fullmain)  echo -e "    fullmain.yourdomain.com   — full archive node" ;;
                */prunemain) echo -e "    prunemain.yourdomain.com  — pruned node" ;;
                *)           echo -e "    fullmain.yourdomain.com   — full archive node"
                             echo -e "    prunemain.yourdomain.com  — pruned node" ;;
            esac
            ;;
        testnet)
            echo -e "  ${YELLOW}Required subdomain prefix for testnet:${NC}"
            echo -e "    prunetest.yourdomain.com  — pruned node"
            ;;
        *)
            echo -e "  Enter any valid domain or subdomain (e.g., files.yourdomain.com)"
            echo -e "  ${YELLOW}Note:${NC} fullmain / prunemain / prunetest prefixes are reserved for Grin options 1 & 2."
            ;;
    esac
    echo ""
    while true; do
        if [[ -z "$DOMAIN" ]]; then
            read -p "Enter domain name or 0 to cancel: " DOMAIN
            [[ "$DOMAIN" == "0" ]] && return 1
        fi

        if validate_domain "$DOMAIN"; then
            local _prefix
            _prefix=$(echo "$DOMAIN" | cut -d'.' -f1)
            case "$mode" in
                mainnet)
                    # Derive the single required prefix from the detected node type
                    local _required_prefix=""
                    case "$_mn_detected" in
                        */fullmain)  _required_prefix="fullmain"  ;;
                        */prunemain) _required_prefix="prunemain" ;;
                    esac
                    if [[ -n "$_required_prefix" && "$_prefix" != "$_required_prefix" ]]; then
                        echo ""
                        print_error "Prefix '${_prefix}' is not valid for your mainnet node."
                        echo -e "  Must start with: ${YELLOW}${_required_prefix}${NC}"
                        echo ""
                        DOMAIN=""; continue
                    elif [[ -z "$_required_prefix" && "$_prefix" != "fullmain" && "$_prefix" != "prunemain" ]]; then
                        echo ""
                        print_error "Prefix '${_prefix}' is not valid for mainnet."
                        echo -e "  Must start with: ${YELLOW}fullmain${NC} or ${YELLOW}prunemain${NC}"
                        echo ""
                        DOMAIN=""; continue
                    fi
                    ;;
                testnet)
                    if [[ "$_prefix" != "prunetest" ]]; then
                        echo ""
                        print_error "Prefix '${_prefix}' is not valid for testnet."
                        echo -e "  Must start with: ${YELLOW}prunetest${NC}"
                        echo ""
                        DOMAIN=""; continue
                    fi
                    ;;
                *)
                    if [[ "$_prefix" == "fullmain" || "$_prefix" == "prunemain" || "$_prefix" == "prunetest" ]]; then
                        echo ""
                        print_error "Prefix '${_prefix}' is reserved for Grin Master Nodes (options 1 & 2)."
                        echo -e "  Use options 1 or 2 to configure Grin domains."
                        echo ""
                        DOMAIN=""; continue
                    fi
                    ;;
            esac
            print_info "Domain validated: $DOMAIN"
            break
        else
            print_error "Invalid domain name format"
            DOMAIN=""
        fi
    done
}

# 5.1 - Validate that the domain prefix matches at least one currently running Grin node.
# Supports dual-node setups (e.g. prunemain + prunetest running simultaneously).
# Must be called after get_domain() sets $DOMAIN in Grin (strict) mode.
# On mismatch: shows alert, offers press-0 to exit to master script.
# Returns 0 on success, 1 on mismatch/cancel.
validate_grin_domain_match() {
    local prefix required_dir port _bk d
    prefix=$(echo "$DOMAIN" | cut -d'.' -f1)
    required_dir="/var/www/${prefix}"

    # Collect ALL running Grin instances (both ports — dual-node setup supported)
    local detected_dirs=()
    for port in 3414 13414; do
        d=$(suggest_grin_web_dir "$port" 2>/dev/null) && detected_dirs+=("$d")
    done

    # Check if required_dir matches any detected instance
    local matched=false
    for d in "${detected_dirs[@]}"; do
        [[ "$d" == "$required_dir" ]] && matched=true && break
    done

    if [[ "$matched" == "true" ]]; then
        print_info "Node type validated: running node matches domain prefix '${prefix}'."
        return 0
    fi

    # ── Alert ────────────────────────────────────────────────────────────────
    echo ""
    print_error "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    print_error "  ⚠  DOMAIN / NODE TYPE MISMATCH"
    print_error "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo -e "  You entered domain prefix : ${YELLOW}${prefix}${NC}"
    if [[ ${#detected_dirs[@]} -eq 0 ]]; then
        echo -e "  Running Grin nodes        : ${RED}None detected${NC}"
    else
        local first=true
        for d in "${detected_dirs[@]}"; do
            local dp; dp=$(basename "$d")
            if [[ "$first" == "true" ]]; then
                printf "  Running Grin node(s)      : ${YELLOW}%s${NC}\n" "$dp"
                first=false
            else
                printf "                              ${YELLOW}%s${NC}\n" "$dp"
            fi
        done
    fi
    echo ""
    case "$prefix" in
        fullmain)  echo -e "  ${YELLOW}fullmain${NC}  requires: Mainnet + archive_mode = true  (full chain)" ;;
        prunemain) echo -e "  ${YELLOW}prunemain${NC} requires: Mainnet + archive_mode = false (pruned)" ;;
        prunetest) echo -e "  ${YELLOW}prunetest${NC} requires: Testnet + archive_mode = false (pruned)" ;;
    esac
    echo ""
    if [[ ${#detected_dirs[@]} -eq 0 ]]; then
        echo -e "  No active Grin node found on this server."
        echo -e "  Run ${YELLOW}Script 01${NC} to build and start the correct node type first."
    else
        echo -e "  None of the running nodes match ${YELLOW}${prefix}${NC}."
        echo -e "  Run ${YELLOW}Script 01${NC} to add or rebuild the correct node type."
    fi
    echo ""
    read -p "  Press 0 to return to master script, or Enter to cancel: " _bk
    [[ "$_bk" == "0" ]] && exit 0
    DOMAIN=""
    return 1
}

# 5.2 - Get and validate email
get_email() {
    while true; do
        if [[ -z "$EMAIL" ]]; then
            read -p "Enter email for Let's Encrypt notifications or 0 to cancel: " EMAIL
            [[ "$EMAIL" == "0" ]] && return 1
        fi

        if validate_email "$EMAIL"; then
            print_info "Email validated: $EMAIL"
            break
        else
            print_error "Invalid email format"
            EMAIL=""
        fi
    done
}

# 5.3 - Given a Grin domain prefix (fullmain/prunemain/prunetest), return the
# chain_data path of the matching running Grin instance via stdout.
# Returns 1 if no matching instance is found.
_chain_data_for_prefix() {
    local prefix="$1"
    local required_web="/var/www/${prefix}"
    local port web_dir pid binary dir
    for port in 3414 13414; do
        web_dir=$(suggest_grin_web_dir "$port" 2>/dev/null) || continue
        [[ "$web_dir" != "$required_web" ]] && continue
        # Found the matching node — resolve its binary dir and chain_data path
        if command -v lsof &>/dev/null; then
            pid=$(lsof -ti :"$port" 2>/dev/null)
        elif command -v ss &>/dev/null; then
            pid=$(ss -tlnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' | head -1)
        elif command -v netstat &>/dev/null; then
            pid=$(netstat -tlnp 2>/dev/null | grep ":$port " | grep -oP '[0-9]+/.*' | cut -d'/' -f1 | head -1)
        fi
        [ -z "$pid" ] && continue
        binary=$(readlink -f "/proc/$pid/exe" 2>/dev/null)
        { [ -z "$binary" ] || [ ! -f "$binary" ]; } && continue
        dir=$(dirname "$binary")
        [ -d "$dir/chain_data" ] && echo "$dir/chain_data" && return 0
    done
    return 1
}

# 5.4 - Get files directory
# Non-strict (custom domain): shows detected Grin instances + manual entry option.
# Strict (Grin mode): auto-sets FILES_DIR from the validated domain prefix,
#   shows chain_data size vs available /var/www space, and offers to clean up
#   the target directory if space is insufficient.
get_files_directory() {
    local strict_mode="${1:-false}"

    if [[ -n "$FILES_DIR" ]]; then
        print_info "Files directory: $FILES_DIR"
        return
    fi

    # ── Strict (Grin) mode — auto-set from domain prefix ─────────────────────
    if [[ "$strict_mode" == "strict" ]]; then
        local prefix
        prefix=$(echo "$DOMAIN" | cut -d'.' -f1)
        FILES_DIR="/var/www/${prefix}"

        echo ""
        print_info "Files directory (auto-selected): $FILES_DIR"

        # Warn if already bound to another nginx site
        if [[ -d "$NGINX_AVAILABLE" ]] && grep -rl "root ${FILES_DIR}" "$NGINX_AVAILABLE" &>/dev/null; then
            local _existing_site
            _existing_site=$(grep -rl "root ${FILES_DIR}" "$NGINX_AVAILABLE" | head -1 | xargs basename 2>/dev/null)
            print_warn "This directory is already configured for: ${_existing_site}"
        fi

        # Disk space check: chain_data size vs free space on /var/www partition
        local _chain_data_dir _chain_data_kb _chain_data_gb _free_kb _free_gb
        _chain_data_dir=$(_chain_data_for_prefix "$prefix" 2>/dev/null)

        if [[ -n "$_chain_data_dir" ]]; then
            _chain_data_kb=$(du -sk "$_chain_data_dir" 2>/dev/null | cut -f1) || _chain_data_kb=0
            mkdir -p "$FILES_DIR" 2>/dev/null || true
            _free_kb=$(df -k "$FILES_DIR" 2>/dev/null | awk 'NR==2{print $4}') || _free_kb=0
            _chain_data_gb=$(awk "BEGIN{printf \"%.1f\", ${_chain_data_kb}/1048576}")
            _free_gb=$(awk "BEGIN{printf \"%.1f\", ${_free_kb}/1048576}")

            echo ""
            echo -e "  chain_data size  : ${YELLOW}~${_chain_data_gb} GiB${NC}  (${_chain_data_dir})"
            echo -e "  Free space       : ${YELLOW}${_free_gb} GiB${NC}  ($(df -h "$FILES_DIR" 2>/dev/null | awk 'NR==2{print $1}'))"
            echo ""

            if (( _chain_data_kb > 0 && _free_kb < _chain_data_kb )); then
                print_warn "Insufficient free space — chain_data (~${_chain_data_gb} GiB) exceeds available (${_free_gb} GiB)."

                local _dir_kb=0
                [ -d "$FILES_DIR" ] && _dir_kb=$(du -sk "$FILES_DIR" 2>/dev/null | cut -f1) || true

                if (( _dir_kb > 0 )); then
                    local _dir_gb
                    _dir_gb=$(awk "BEGIN{printf \"%.1f\", ${_dir_kb}/1048576}")
                    echo -e "  ${FILES_DIR} currently holds ${YELLOW}${_dir_gb} GiB${NC} — cleaning it may free enough space."
                    echo ""
                    local _clean
                    read -r -p "  Clean up ${FILES_DIR} now? (Y/n/0) [default: Y, 0 = cancel]: " _clean
                    [[ "$_clean" == "0" ]] && return 1
                    if [[ ! "${_clean,,}" =~ ^n ]]; then
                        find "$FILES_DIR" -mindepth 1 -delete 2>/dev/null || true
                        print_info "Cleaned up ${FILES_DIR}"
                        _free_kb=$(df -k "$FILES_DIR" 2>/dev/null | awk 'NR==2{print $4}') || _free_kb=0
                        _free_gb=$(awk "BEGIN{printf \"%.1f\", ${_free_kb}/1048576}")
                        if (( _free_kb >= _chain_data_kb )); then
                            print_info "Space OK after cleanup: ${_free_gb} GiB free."
                        else
                            print_warn "Still low after cleanup (${_free_gb} GiB free). Script 03 may fail if space runs out."
                        fi
                    fi
                else
                    print_warn "No existing files in ${FILES_DIR} to clean. Free up space on the partition and retry."
                fi
            else
                print_info "Disk space OK — ${_free_gb} GiB free, chain_data ~${_chain_data_gb} GiB."
            fi
        else
            print_warn "Could not determine chain_data size — skipping disk space check."
        fi

        print_info "Files directory: $FILES_DIR"
        return 0
    fi

    # ── Non-strict mode — show detected Grin instances + manual entry ─────────
    # In "custom" mode, Grin-reserved directories are excluded from suggestions
    # and blocked from manual entry.
    local _grin_reserved=("/var/www/fullmain" "/var/www/prunemain" "/var/www/prunetest")

    local suggestions=() labels=() suggested
    for port in 3414 13414; do
        suggested=$(suggest_grin_web_dir "$port" 2>/dev/null) || continue
        # Skip reserved dirs in custom mode
        if [[ "$strict_mode" == "custom" ]]; then
            local _skip=false
            local _r; for _r in "${_grin_reserved[@]}"; do [[ "$suggested" == "$_r" ]] && _skip=true && break; done
            [[ "$_skip" == "true" ]] && continue
        fi
        case "$suggested" in
            */fullmain)   labels+=("Mainnet Full (archive)")   ;;
            */prunemain)  labels+=("Mainnet Pruned")           ;;
            */prunetest)  labels+=("Testnet Pruned")           ;;
            *)            labels+=("Grin node on port $port")  ;;
        esac
        suggestions+=("$suggested")
    done

    if [ ${#suggestions[@]} -gt 0 ]; then
        echo ""
        print_info "Detected running Grin instance(s) — suggested directories:"
        local i
        for i in "${!suggestions[@]}"; do
            local _tag=""
            if [[ -d "$NGINX_AVAILABLE" ]] && grep -rl "root ${suggestions[$i]}" "$NGINX_AVAILABLE" &>/dev/null; then
                local _domain; _domain=$(grep -rl "root ${suggestions[$i]}" "$NGINX_AVAILABLE" | head -1 | xargs basename 2>/dev/null)
                _tag=" ⚠  already configured (${_domain})"
            fi
            echo "  $((i+1))) ${labels[$i]}  →  ${suggestions[$i]}${_tag}"
        done
        local manual_opt=$(( ${#suggestions[@]} + 1 ))
        echo "  ${manual_opt}) Enter path manually  [default: $DEFAULT_FILES_DIR]"
        echo "  0) Cancel — return to main menu"
        echo ""
        while true; do
            read -p "Select [0-${manual_opt}]: " sel
            [[ "$sel" == "0" ]] && return 1
            if [[ "$sel" =~ ^[0-9]+$ ]] && [ "$sel" -ge 1 ] && [ "$sel" -le "${#suggestions[@]}" ]; then
                FILES_DIR="${suggestions[$((sel-1))]}"
                break
            elif [[ "$sel" == "$manual_opt" ]]; then
                read -p "Enter directory path [$DEFAULT_FILES_DIR] or 0 to cancel: " FILES_DIR
                [[ "$FILES_DIR" == "0" ]] && return 1
                FILES_DIR="${FILES_DIR:-$DEFAULT_FILES_DIR}"
                break
            else
                print_error "Invalid selection. Please choose from the options above."
            fi
        done
    else
        read -p "Enter directory for storing files [default: $DEFAULT_FILES_DIR] or 0 to cancel: " FILES_DIR
        [[ "$FILES_DIR" == "0" ]] && return 1
        FILES_DIR="${FILES_DIR:-$DEFAULT_FILES_DIR}"
    fi

    # In custom mode: reject reserved Grin directories
    if [[ "$strict_mode" == "custom" ]]; then
        local _r; for _r in "${_grin_reserved[@]}"; do
            if [[ "$FILES_DIR" == "$_r" ]]; then
                echo ""
                print_error "Directory '${FILES_DIR}' is reserved for Grin Master Nodes (options 1 & 2)."
                echo -e "  Use options 1 or 2 to configure Grin directories."
                FILES_DIR=""
                return 1
            fi
        done
    fi

    print_info "Files directory: $FILES_DIR"
}

# 5.5 - Get bandwidth limiting preferences
get_bandwidth_settings() {
    if [[ -z "$ENABLE_BANDWIDTH_LIMIT" ]]; then
        echo ""
        read -r -p "Enable bandwidth limiting? (Y/n/0) [default: Y, 0 = cancel]: " bw_choice
        [[ "$bw_choice" == "0" ]] && return 1
        if [[ ! "${bw_choice,,}" =~ ^n ]]; then
            ENABLE_BANDWIDTH_LIMIT="yes"

            read -p "Download quota per IP in GB [default: 40, 0 = cancel]: " quota_input
            [[ "$quota_input" == "0" ]] && return 1
            DOWNLOAD_QUOTA_GB=${quota_input:-40}

            read -p "Speed limit after quota (e.g., 1m for 1MB/s) [default: 1m, 0 = cancel]: " speed_input
            [[ "$speed_input" == "0" ]] && return 1
            SPEED_LIMIT_AFTER_QUOTA=${speed_input:-1m}

            read -p "Normal speed limit per connection (e.g., 10m, or press Enter for unlimited, 0 = cancel): " normal_speed_input
            [[ "$normal_speed_input" == "0" ]] && return 1
            NORMAL_SPEED_LIMIT=${normal_speed_input:-""}
            
            print_info "Bandwidth limiting enabled:"
            print_info "  - Quota: ${DOWNLOAD_QUOTA_GB}GB per IP"
            print_info "  - Speed after quota: $SPEED_LIMIT_AFTER_QUOTA"
            if [[ -n "$NORMAL_SPEED_LIMIT" ]]; then
                print_info "  - Normal speed limit: $NORMAL_SPEED_LIMIT"
            else
                print_info "  - Normal speed limit: Unlimited"
            fi
        else
            ENABLE_BANDWIDTH_LIMIT="no"
            print_info "Bandwidth limiting disabled"
        fi
    fi
}

# 6.0 - Function to create files directory
create_files_directory() {
    print_section "Setting up files directory"
    
    if [[ ! -d "$FILES_DIR" ]]; then
        mkdir -p "$FILES_DIR"
        print_info "Created directory: $FILES_DIR"
    else
        print_info "Directory already exists: $FILES_DIR"
    fi
    
    # Set appropriate permissions
    chown -R www-data:www-data "$FILES_DIR"
    chmod 755 "$FILES_DIR"

}

# 7.0 - Function to create initial nginx config (without SSL)
create_initial_nginx_config() {
    print_section "Creating initial Nginx configuration"
    
    NGINX_CONF="$NGINX_AVAILABLE/$DOMAIN"
    
    cat > "$NGINX_CONF" << EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    root $FILES_DIR;

    location / {
        autoindex on;
        autoindex_exact_size off;
        autoindex_localtime on;
    }

    # Allow large file uploads
    client_max_body_size 1G;

    # Security headers (will be enhanced after SSL setup)
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
}
EOF
    
    # Enable the site
    if [[ ! -L "$NGINX_ENABLED/$DOMAIN" ]]; then
        ln -s "$NGINX_CONF" "$NGINX_ENABLED/$DOMAIN"
        print_info "Enabled Nginx site: $DOMAIN"
    fi
    
    # Test nginx config
    if nginx -t &> /dev/null; then
        print_info "Nginx configuration is valid"
        systemctl reload nginx
    else
        print_error "Nginx configuration test failed"
        nginx -t
        exit 1
    fi
}

# 8.0 - Function to obtain SSL certificate
obtain_ssl_certificate() {
    print_section "Obtaining Let's Encrypt SSL Certificate"
    
    print_info "Requesting SSL certificate for $DOMAIN — this may take a moment..."
    echo ""
    # Run certbot
    if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "$EMAIL" --redirect; then
        print_info "SSL certificate obtained successfully"
    else
        print_error "Failed to obtain SSL certificate"
        print_error "Please check that:"
        print_error "  1. Domain $DOMAIN points to this server"
        print_error "  2. Ports 80 and 443 are accessible"
        print_error "  3. No firewall is blocking the connection"
        print_error "  4. If using Cloudflare: Proxy is DISABLED (gray cloud icon)"
        exit 1
    fi
}

# 9.0 - Function to enhance nginx config with HSTS and security headers
enhance_nginx_config() {
    print_section "Enhancing Nginx configuration with HSTS"
    
    NGINX_CONF="$NGINX_AVAILABLE/$DOMAIN"
    
    # Backup the certbot-modified config
    cp "$NGINX_CONF" "$NGINX_CONF.backup"
    
    # Determine bandwidth limiting configuration
    local bandwidth_config=""
    local limit_rate_config=""
    
    if [[ "$ENABLE_BANDWIDTH_LIMIT" == "yes" ]]; then
        bandwidth_config="
    # Bandwidth limiting - track downloads per IP
    access_log /var/log/nginx/${DOMAIN}-bandwidth.log combined;
    
    # Map to determine rate limit based on download quota
    map \$remote_addr \$limit_rate_value {
        default ${NORMAL_SPEED_LIMIT:-0};
    }
"
        if [[ -n "$NORMAL_SPEED_LIMIT" ]]; then
            limit_rate_config="
        # Apply speed limit
        limit_rate \$limit_rate_value;"
        fi
    fi
    
    # Create enhanced config with HSTS
    cat > "$NGINX_CONF" << EOF
# HTTP - Redirect all traffic to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    # Redirect all HTTP requests to HTTPS
    return 301 https://\$server_name\$request_uri;
}

# HTTPS - Main file server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN;

    # SSL certificate (managed by Certbot)
    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # HSTS (HTTP Strict Transport Security)
    # Tells browsers to always use HTTPS for this domain (1 year)
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;

    # Additional security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    root $FILES_DIR;
$bandwidth_config
    location / {
        # Enable directory listing
        autoindex on;
        autoindex_exact_size off;  # Show human-readable file sizes
        autoindex_localtime on;     # Show local time instead of UTC
        
        # Custom styling for directory listing (optional)
        autoindex_format html;$limit_rate_config
    }

    # Allow large file uploads (adjust as needed)
    client_max_body_size 1G;

    # Optimize file serving
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;

    # Logging
    access_log /var/log/nginx/$DOMAIN-access.log;
    error_log /var/log/nginx/$DOMAIN-error.log;
}
EOF
    
    # Test nginx config
    if nginx -t &> /dev/null; then
        print_info "Enhanced Nginx configuration is valid"
        systemctl reload nginx
        print_info "Nginx reloaded with new configuration"
    else
        print_error "Enhanced Nginx configuration test failed, restoring backup"
        mv "$NGINX_CONF.backup" "$NGINX_CONF"
        nginx -t
        exit 1
    fi
    
    rm -f "$NGINX_CONF.backup"
}

# 9.5 - Function to setup bandwidth limiting tracking
setup_bandwidth_limiting() {
    if [[ "$ENABLE_BANDWIDTH_LIMIT" != "yes" ]]; then
        return 0
    fi
    
    print_section "Setting up Bandwidth Limiting"
    
    # Install bc if not present (needed for calculations)
    if ! command -v bc &> /dev/null; then
        print_info "Installing bc for bandwidth calculations..."
        if [[ -f /etc/debian_version ]]; then
            apt-get install -y bc
        elif [[ -f /etc/redhat-release ]]; then
            yum install -y bc
        fi
    fi
    
    # Create bandwidth tracking directory
    mkdir -p "$BANDWIDTH_TRACKING_DIR"
    
    # Create the bandwidth monitoring and limiting script
    cat > "$BANDWIDTH_SCRIPT" << 'SCRIPT_EOF'
#!/bin/bash

#############################################################################
# Nginx Bandwidth Limiter
# Monitors download usage per IP and applies speed limits after quota
#############################################################################

BANDWIDTH_DIR="/var/log/nginx/bandwidth"
QUOTA_GB="__QUOTA_GB__"
SLOW_SPEED="__SLOW_SPEED__"
NGINX_CONF="__NGINX_CONF__"
DOMAIN="__DOMAIN__"

# Convert GB to bytes
QUOTA_BYTES=$((QUOTA_GB * 1024 * 1024 * 1024))

# Create bandwidth tracking directory if not exists
mkdir -p "$BANDWIDTH_DIR"

# Parse access log and track bandwidth per IP
parse_bandwidth_log() {
    local log_file="/var/log/nginx/${DOMAIN}-bandwidth.log"
    
    if [[ ! -f "$log_file" ]]; then
        return
    fi
    
    # Extract IP and bytes sent from log
    # Nginx log format: $remote_addr ... $bytes_sent
    awk '{print $1, $10}' "$log_file" | grep -v '^-' | \
    while read ip bytes; do
        if [[ "$bytes" =~ ^[0-9]+$ ]]; then
            ip_file="$BANDWIDTH_DIR/$(echo $ip | tr . _).txt"
            
            # Initialize or update IP's total bytes
            if [[ -f "$ip_file" ]]; then
                current=$(cat "$ip_file")
                new_total=$((current + bytes))
            else
                new_total=$bytes
            fi
            
            echo "$new_total" > "$ip_file"
            
            # Check if IP exceeded quota
            if [[ $new_total -gt $QUOTA_BYTES ]]; then
                echo "$ip exceeded quota: $(($new_total / 1024 / 1024 / 1024))GB"
            fi
        fi
    done
}

# Generate nginx map for rate limiting
generate_nginx_map() {
    local map_file="/etc/nginx/conf.d/${DOMAIN}-bandwidth-map.conf"
    
    cat > "$map_file" << 'MAP_HEADER'
# Bandwidth limiting map - auto-generated
map $remote_addr $limit_rate_value {
    default __NORMAL_SPEED__;
MAP_HEADER
    
    # Add IPs that exceeded quota
    for ip_file in "$BANDWIDTH_DIR"/*.txt; do
        if [[ -f "$ip_file" ]]; then
            bytes=$(cat "$ip_file")
            if [[ $bytes -gt $QUOTA_BYTES ]]; then
                ip=$(basename "$ip_file" .txt | tr _ .)
                echo "    $ip $SLOW_SPEED;" >> "$map_file"
            fi
        fi
    done
    
    echo "}" >> "$map_file"
}

# Reset bandwidth counters (run monthly)
reset_counters() {
    rm -f "$BANDWIDTH_DIR"/*.txt
    echo "Bandwidth counters reset"
}

# Main execution
case "${1:-monitor}" in
    monitor)
        parse_bandwidth_log
        generate_nginx_map
        nginx -t &> /dev/null && systemctl reload nginx
        ;;
    reset)
        reset_counters
        generate_nginx_map
        nginx -t &> /dev/null && systemctl reload nginx
        ;;
    status)
        echo "=== Bandwidth Usage per IP ==="
        for ip_file in "$BANDWIDTH_DIR"/*.txt; do
            if [[ -f "$ip_file" ]]; then
                ip=$(basename "$ip_file" .txt | tr _ .)
                bytes=$(cat "$ip_file")
                gb=$(echo "scale=2; $bytes / 1024 / 1024 / 1024" | bc)
                status="OK"
                if [[ $bytes -gt $QUOTA_BYTES ]]; then
                    status="LIMITED"
                fi
                printf "%-15s %8.2f GB / %s GB [%s]\n" "$ip" "$gb" "$QUOTA_GB" "$status"
            fi
        done
        ;;
    *)
        echo "Usage: $0 {monitor|reset|status}"
        exit 1
        ;;
esac
SCRIPT_EOF
    
    # Replace placeholders in the script
    sed -i "s|__QUOTA_GB__|$DOWNLOAD_QUOTA_GB|g" "$BANDWIDTH_SCRIPT"
    sed -i "s|__SLOW_SPEED__|$SPEED_LIMIT_AFTER_QUOTA|g" "$BANDWIDTH_SCRIPT"
    sed -i "s|__NGINX_CONF__|$NGINX_AVAILABLE/$DOMAIN|g" "$BANDWIDTH_SCRIPT"
    sed -i "s|__DOMAIN__|$DOMAIN|g" "$BANDWIDTH_SCRIPT"
    sed -i "s|__NORMAL_SPEED__|${NORMAL_SPEED_LIMIT:-0}|g" "$BANDWIDTH_SCRIPT"
    
    chmod +x "$BANDWIDTH_SCRIPT"
    
    # Create cron job to run every 5 minutes
    if [[ ! -f /etc/cron.d/nginx-bandwidth-limiter ]]; then
        cat > /etc/cron.d/nginx-bandwidth-limiter << EOF
# Nginx bandwidth limiter - runs every 5 minutes
*/5 * * * * root $BANDWIDTH_SCRIPT monitor >> /var/log/nginx/bandwidth-limiter.log 2>&1

# Reset counters monthly (1st of each month at 00:00)
0 0 1 * * root $BANDWIDTH_SCRIPT reset >> /var/log/nginx/bandwidth-limiter.log 2>&1
EOF
        print_info "Created bandwidth limiter cron job"
    fi
    
    print_info "Bandwidth limiting configured:"
    print_info "  - Quota: ${DOWNLOAD_QUOTA_GB}GB per IP per month"
    print_info "  - Speed after quota: $SPEED_LIMIT_AFTER_QUOTA"
    print_info "  - Monitoring script: $BANDWIDTH_SCRIPT"
    print_info "  - Check status: $BANDWIDTH_SCRIPT status"
    
    # Run initial setup
    "$BANDWIDTH_SCRIPT" monitor
    
    print_info "Bandwidth limiting is now active"
}

# 10.0 - Function to setup auto-renewal
setup_auto_renewal() {
    print_section "Configuring SSL auto-renewal"
    
    # Certbot should have already set up auto-renewal via systemd timer or cron
    if systemctl list-timers | grep -q certbot; then
        print_info "Certbot auto-renewal timer is active"
        systemctl status certbot.timer --no-pager | head -n 5
    elif [[ -f /etc/cron.d/certbot ]]; then
        print_info "Certbot auto-renewal cron job is configured"
    else
        print_warn "Auto-renewal may not be configured. Setting up cron job..."
        echo "0 0,12 * * * root python3 -c 'import random; import time; time.sleep(random.random() * 3600)' && certbot renew -q" | tee /etc/cron.d/certbot > /dev/null
        print_info "Cron job added for certificate renewal"
    fi
    
    # Test renewal
    print_info "Testing certificate renewal process..."
    if certbot renew --dry-run &> /dev/null; then
        print_info "Certificate renewal test passed"
    else
        print_warn "Certificate renewal test failed, but this might be expected for new certificates"
    fi
}

#############################################################################
# Domain Listing Functions
#############################################################################

# 11.0 - Function to list all configured domains
list_domains() {
    print_section "Currently Configured Domains"
    
    if [[ ! -d "$NGINX_AVAILABLE" ]]; then
        print_error "Nginx sites-available directory not found"
        echo ""
        echo "Press Enter to return to menu..."
        read -r
        return
    fi
    
    local domains=()
    local count=0
    
    for conf_file in "$NGINX_AVAILABLE"/*; do
        if [[ -f "$conf_file" ]]; then
            local domain=$(basename "$conf_file")
            # Skip default files
            if [[ "$domain" != "default" && "$domain" != "default-ssl" ]]; then
                count=$((count + 1))
                domains+=("$domain")
                
                # Check if enabled
                local status="disabled"
                if [[ -L "$NGINX_ENABLED/$domain" ]]; then
                    status="enabled"
                fi
                
                # Check if has SSL
                local ssl_status="no SSL"
                if grep -q "ssl_certificate" "$conf_file" 2>/dev/null; then
                    ssl_status="has SSL"
                fi
                
                # Get root directory if exists
                local root_dir=$(grep -oP '(?<=root\s).*?(?=;)' "$conf_file" 2>/dev/null | head -1 | xargs)
                
                printf "${GREEN}%2d.${NC} %-30s [%-8s] [%-7s] %s\n" "$count" "$domain" "$status" "$ssl_status" "$root_dir"
                printf "    ${NC}%-30s  Config: %s\n" "" "$NGINX_AVAILABLE/$domain"
            fi
        fi
    done
    
    if [[ ${#domains[@]} -eq 0 ]]; then
        print_warn "No domains configured"
        return 1
    fi
    
    echo ""
    echo "Total domains: ${#domains[@]}"
    echo ""
    return 0
}

#############################################################################
# Domain Removal Functions
#############################################################################

# 12.0 - Function to get domain to remove
get_domain_to_remove() {
    if [[ -z "$DOMAIN_TO_REMOVE" ]]; then
        while true; do
            read -p "Enter domain name to remove (e.g., files.example.com) or 0 to cancel: " DOMAIN_TO_REMOVE
            [[ "$DOMAIN_TO_REMOVE" == "0" ]] && return 1
            [[ -z "$DOMAIN_TO_REMOVE" ]] && continue
            break
        done
    fi

    # Validate domain exists
    if [[ ! -f "$NGINX_AVAILABLE/$DOMAIN_TO_REMOVE" ]]; then
        print_error "Domain '$DOMAIN_TO_REMOVE' not found in nginx configuration"
        print_info "Available domains:"
        list_domains
        DOMAIN_TO_REMOVE=""
        return
    fi
    
    print_info "Domain to remove: $DOMAIN_TO_REMOVE"
}

# 13.0 - Function to gather domain information for removal
gather_domain_info() {
    print_section "Gathering Domain Information"
    
    local conf_file="$NGINX_AVAILABLE/$DOMAIN_TO_REMOVE"
    
    # Get root directory
    FILES_DIR=$(grep -oP '(?<=root\s).*?(?=;)' "$conf_file" 2>/dev/null | head -1 | xargs)
    
    # Check if SSL certificate exists
    if grep -q "ssl_certificate" "$conf_file" 2>/dev/null; then
        HAS_SSL="yes"
        SSL_CERT_PATH="/etc/letsencrypt/live/$DOMAIN_TO_REMOVE"
    else
        HAS_SSL="no"
    fi
    
    # Check if bandwidth limiting is configured
    if [[ -f "/usr/local/bin/nginx-bandwidth-limiter.sh" ]] && \
       [[ -f "/etc/nginx/conf.d/${DOMAIN_TO_REMOVE}-bandwidth-map.conf" ]]; then
        HAS_BANDWIDTH_LIMIT="yes"
    else
        HAS_BANDWIDTH_LIMIT="no"
    fi
    
    # Display findings
    echo ""
    print_blue "Domain: $DOMAIN_TO_REMOVE"
    print_blue "Nginx config: $conf_file"
    
    if [[ -n "$FILES_DIR" ]]; then
        print_blue "Files directory: $FILES_DIR"
        if [[ -d "$FILES_DIR" ]]; then
            local dir_size=$(du -sh "$FILES_DIR" 2>/dev/null | cut -f1)
            print_blue "Directory size: $dir_size"
        fi
    else
        print_blue "Files directory: Not found"
    fi
    
    if [[ "$HAS_SSL" == "yes" ]]; then
        print_blue "SSL certificate: Yes (at $SSL_CERT_PATH)"
    else
        print_blue "SSL certificate: No"
    fi
    
    if [[ "$HAS_BANDWIDTH_LIMIT" == "yes" ]]; then
        print_blue "Bandwidth limiting: Yes"
    else
        print_blue "Bandwidth limiting: No"
    fi
    
    echo ""
}

# 14.0 - Function to confirm removal
confirm_removal() {
    print_section "Confirmation Required"
    
    print_warn "The following will be removed:"
    echo "  ✗ Nginx configuration: $NGINX_AVAILABLE/$DOMAIN_TO_REMOVE"
    echo "  ✗ Nginx enabled symlink: $NGINX_ENABLED/$DOMAIN_TO_REMOVE"
    
    if [[ "$HAS_SSL" == "yes" ]]; then
        echo "  ✗ SSL certificate: $SSL_CERT_PATH"
    fi
    
    if [[ "$HAS_BANDWIDTH_LIMIT" == "yes" ]]; then
        echo "  ✗ Bandwidth limiting config"
        echo "  ✗ Bandwidth tracking data"
    fi
    
    echo "  ✗ Nginx log files for this domain"
    
    echo ""
    if [[ -n "$FILES_DIR" ]] && [[ -d "$FILES_DIR" ]]; then
        print_warn "Files directory: $FILES_DIR"
        
        if [[ "$DELETE_FILES" == "yes" ]]; then
            echo -e "  ${RED}✗ FILES WILL BE DELETED${NC} (DELETE_FILES=yes)"
        else
            if [[ -z "$DELETE_FILES" ]]; then
                read -p "Do you want to DELETE the files directory? (yes/no/0) [default: no, 0 = cancel]: " delete_choice
                [[ "$delete_choice" == "0" ]] && return 1
                if [[ "$delete_choice" == "yes" ]]; then
                    DELETE_FILES="yes"
                    echo -e "  ${RED}✗ FILES WILL BE DELETED${NC}"
                else
                    DELETE_FILES="no"
                    echo -e "  ${GREEN}✓ FILES WILL BE KEPT${NC}"
                fi
            else
                echo -e "  ${GREEN}✓ FILES WILL BE KEPT${NC} (DELETE_FILES=no)"
            fi
        fi
    fi
    
    echo ""
    print_warn "This action CANNOT be undone!"
    echo ""
    
    read -p "Type the domain name '$DOMAIN_TO_REMOVE' to confirm removal (or 0 to cancel): " confirmation
    [[ "$confirmation" == "0" ]] && print_info "Removal cancelled." && return 1

    if [[ "$confirmation" != "$DOMAIN_TO_REMOVE" ]]; then
        print_error "Confirmation failed. Domain name doesn't match."
        print_info "Removal cancelled."
        return 1
    fi
    
    print_info "Confirmation received. Proceeding with removal..."
}

# 15.0 - Function to remove nginx configuration
remove_nginx_config() {
    print_section "Removing Nginx Configuration"
    
    # Disable site first (remove symlink)
    if [[ -L "$NGINX_ENABLED/$DOMAIN_TO_REMOVE" ]]; then
        rm "$NGINX_ENABLED/$DOMAIN_TO_REMOVE"
        print_info "Removed nginx enabled symlink"
    fi
    
    # Remove configuration file
    if [[ -f "$NGINX_AVAILABLE/$DOMAIN_TO_REMOVE" ]]; then
        rm "$NGINX_AVAILABLE/$DOMAIN_TO_REMOVE"
        print_info "Removed nginx configuration file"
    fi
    
    # Test nginx configuration
    if nginx -t &> /dev/null; then
        systemctl reload nginx
        print_info "Nginx configuration reloaded successfully"
    else
        print_warn "Nginx configuration test failed, but continuing..."
    fi
}

# 16.0 - Function to remove SSL certificate
remove_ssl_certificate() {
    if [[ "$HAS_SSL" != "yes" ]]; then
        return 0
    fi
    
    print_section "Removing SSL Certificate"
    
    if command -v certbot &> /dev/null; then
        # Try to revoke and delete certificate
        if certbot delete --cert-name "$DOMAIN_TO_REMOVE" --non-interactive 2>/dev/null; then
            print_info "SSL certificate removed via certbot"
        else
            print_warn "Could not remove certificate via certbot, trying manual removal..."
            
            if [[ -d "$SSL_CERT_PATH" ]]; then
                rm -rf "/etc/letsencrypt/live/$DOMAIN_TO_REMOVE"
                rm -rf "/etc/letsencrypt/archive/$DOMAIN_TO_REMOVE"
                rm -f "/etc/letsencrypt/renewal/${DOMAIN_TO_REMOVE}.conf"
                print_info "SSL certificate files removed manually"
            fi
        fi
    else
        print_warn "Certbot not found, skipping SSL removal"
    fi
}

# 17.0 - Function to remove bandwidth limiting
remove_bandwidth_limiting() {
    if [[ "$HAS_BANDWIDTH_LIMIT" != "yes" ]]; then
        return 0
    fi
    
    print_section "Removing Bandwidth Limiting"
    
    # Remove bandwidth map config
    if [[ -f "/etc/nginx/conf.d/${DOMAIN_TO_REMOVE}-bandwidth-map.conf" ]]; then
        rm "/etc/nginx/conf.d/${DOMAIN_TO_REMOVE}-bandwidth-map.conf"
        print_info "Removed bandwidth map configuration"
    fi
    
    # Remove domain-specific bandwidth log
    if [[ -f "/var/log/nginx/${DOMAIN_TO_REMOVE}-bandwidth.log" ]]; then
        rm "/var/log/nginx/${DOMAIN_TO_REMOVE}-bandwidth.log"
        print_info "Removed bandwidth access log"
    fi
    
    # Check if this is the last domain with bandwidth limiting
    local other_bandwidth_configs=$(find /etc/nginx/conf.d -name "*-bandwidth-map.conf" 2>/dev/null | wc -l)
    if [[ $other_bandwidth_configs -eq 0 ]]; then
        print_warn "This was the last domain with bandwidth limiting"
        read -r -p "Remove bandwidth limiter script and cron job? (Y/n/0) [default: Y, 0 = cancel]: " bw_remove_choice
        [[ "$bw_remove_choice" == "0" ]] && return
        if [[ ! "${bw_remove_choice,,}" =~ ^n ]]; then
            rm -f /usr/local/bin/nginx-bandwidth-limiter.sh
            rm -f /etc/cron.d/nginx-bandwidth-limiter
            rm -rf /var/log/nginx/bandwidth
            print_info "Removed bandwidth limiter infrastructure"
        fi
    fi
}

# 18.0 - Function to remove log files
remove_log_files() {
    print_section "Removing Log Files"
    
    local logs_removed=0
    
    # Remove access log
    if [[ -f "/var/log/nginx/${DOMAIN_TO_REMOVE}-access.log" ]]; then
        rm "/var/log/nginx/${DOMAIN_TO_REMOVE}-access.log"*
        logs_removed=$((logs_removed + 1))
    fi
    
    # Remove error log
    if [[ -f "/var/log/nginx/${DOMAIN_TO_REMOVE}-error.log" ]]; then
        rm "/var/log/nginx/${DOMAIN_TO_REMOVE}-error.log"*
        logs_removed=$((logs_removed + 1))
    fi
    
    if [[ $logs_removed -gt 0 ]]; then
        print_info "Removed $logs_removed log file(s)"
    else
        print_info "No log files found"
    fi
}

# 19.0 - Function to remove files directory
remove_files_directory() {
    if [[ "$DELETE_FILES" != "yes" ]]; then
        if [[ -n "$FILES_DIR" ]] && [[ -d "$FILES_DIR" ]]; then
            print_section "Files Directory Preserved"
            print_info "Files directory kept at: $FILES_DIR"
            print_info "You can manually delete it later with: rm -rf $FILES_DIR"
        fi
        return 0
    fi
    
    print_section "Removing Files Directory"
    
    if [[ -z "$FILES_DIR" ]]; then
        print_warn "No files directory to remove"
        return 0
    fi
    
    if [[ ! -d "$FILES_DIR" ]]; then
        print_warn "Files directory does not exist: $FILES_DIR"
        return 0
    fi
    
    # Final safety check
    print_warn "About to DELETE: $FILES_DIR"
    read -p "Type 'DELETE' to confirm file deletion (or 0 to cancel): " final_confirm
    [[ "$final_confirm" == "0" ]] && print_info "File deletion cancelled. Files preserved at: $FILES_DIR" && return 0

    if [[ "$final_confirm" != "DELETE" ]]; then
        print_info "File deletion cancelled. Files preserved at: $FILES_DIR"
        return 0
    fi
    
    rm -rf "$FILES_DIR"
    print_info "Files directory removed: $FILES_DIR"
}

#############################################################################
# Summary Functions
#############################################################################

# 20.0 - Function to display setup/add summary
display_setup_summary() {
    print_section "Setup Complete!"
    
    local bandwidth_info=""
    if [[ "$ENABLE_BANDWIDTH_LIMIT" == "yes" ]]; then
        bandwidth_info="
Bandwidth Limiting:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${GREEN}✓${NC} Bandwidth limiting enabled
  - Quota per IP: ${DOWNLOAD_QUOTA_GB}GB per month
  - Speed after quota: $SPEED_LIMIT_AFTER_QUOTA
  - Normal speed: ${NORMAL_SPEED_LIMIT:-Unlimited}
  
  Management commands:
    Check status:     $BANDWIDTH_SCRIPT status
    Reset counters:   $BANDWIDTH_SCRIPT reset
    View log:         tail -f /var/log/nginx/bandwidth-limiter.log
"
    fi
    
    cat << EOF

${GREEN}✓${NC} Nginx file server is now running with SSL!

Configuration Summary:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Domain:           $DOMAIN
Files Directory:  $FILES_DIR
Email:            $EMAIL
Nginx Config:     $NGINX_AVAILABLE/$DOMAIN
Setup Log:        $LOG_FILE

Features Enabled:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${GREEN}✓${NC} SSL/TLS with Let's Encrypt
${GREEN}✓${NC} HTTP to HTTPS auto-redirect
${GREEN}✓${NC} HSTS (HTTP Strict Transport Security)
${GREEN}✓${NC} Auto-renewal (certificate renews automatically)
${GREEN}✓${NC} Directory listing enabled
${GREEN}✓${NC} Security headers configured$bandwidth_info
Next Steps:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Upload files to: $FILES_DIR
2. Visit your site: https://$DOMAIN
3. Files will be automatically listed for download

File Management:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Upload files:     cp yourfile.zip $FILES_DIR/
  Set permissions:  chown www-data:www-data $FILES_DIR/*
  List files:       ls -lh $FILES_DIR/

Logs:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Setup log:   $(pwd)/$LOG_FILE
  Access log:  /var/log/nginx/$DOMAIN-access.log
  Error log:   /var/log/nginx/$DOMAIN-error.log

Certificate Renewal:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Auto-renewal is configured and will run automatically.
  Test renewal: certbot renew --dry-run
  Force renewal: certbot renew --force-renewal

EOF
}

# 21.0 - Function to display removal summary
display_removal_summary() {
    print_section "Removal Complete"
    
    cat << EOF

${GREEN}✓${NC} Domain '$DOMAIN_TO_REMOVE' has been removed!

What was removed:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${GREEN}✓${NC} Nginx configuration files
${GREEN}✓${NC} Nginx enabled symlink
EOF

    if [[ "$HAS_SSL" == "yes" ]]; then
        echo -e "${GREEN}✓${NC} SSL certificate"
    fi
    
    if [[ "$HAS_BANDWIDTH_LIMIT" == "yes" ]]; then
        echo -e "${GREEN}✓${NC} Bandwidth limiting configuration"
    fi
    
    echo -e "${GREEN}✓${NC} Log files"
    
    if [[ "$DELETE_FILES" == "yes" ]]; then
        echo -e "${GREEN}✓${NC} Files directory: $FILES_DIR"
    else
        if [[ -n "$FILES_DIR" ]] && [[ -d "$FILES_DIR" ]]; then
            echo -e "${YELLOW}⊙${NC} Files directory preserved: $FILES_DIR"
        fi
    fi
    
    cat << EOF

Log File:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Removal log: $LOG_FILE

Next Steps:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  - Nginx has been reloaded with the updated configuration
  - Domain is no longer accessible
EOF

    if [[ "$DELETE_FILES" != "yes" ]] && [[ -n "$FILES_DIR" ]] && [[ -d "$FILES_DIR" ]]; then
        cat << EOF
  - Files still exist at: $FILES_DIR
    To remove them: sudo rm -rf $FILES_DIR
EOF
    fi

    cat << EOF

  - To add a new domain, run this script again with --action add

EOF
}

#############################################################################
# Logging Functions
#############################################################################

# 22.0 - Function to finalize logging
finalize_log() {
    echo ""
    echo "========================================="
    echo "Script completed at: $(date)"
    echo "========================================="
    echo ""
    print_info "Complete execution log saved to: $LOG_FILE"
}

#############################################################################
# Main Workflows
#############################################################################

# 23.0 - Setup Grin master node domain workflow
# Shared setup flow for Grin Master Nodes (mainnet or testnet).
# $1 = "mainnet" | "testnet"
run_setup_grin_network() {
    local network="$1"
    local section_title reserved_dirs=()

    if [[ "$network" == "mainnet" ]]; then
        section_title="Nginx File Server Setup — Grin Mainnet"
        reserved_dirs=("/var/www/fullmain" "/var/www/prunemain")
    else
        section_title="Nginx File Server Setup — Grin Testnet"
        reserved_dirs=("/var/www/prunetest")
    fi

    print_section "$section_title"
    DOMAIN=""; EMAIL=""; FILES_DIR=""

    # Ensure nginx + certbot are installed (single combined prompt if either is missing)
    ensure_nginx_certbot || return 0

    # Check if the Grin node for this network is running
    local _node_port; [[ "$network" == "mainnet" ]] && _node_port=3414 || _node_port=13414
    local _node_detected
    _node_detected=$(suggest_grin_web_dir "$_node_port" 2>/dev/null) || true
    if [[ -z "$_node_detected" ]]; then
        echo ""
        print_warn "No ${network} Grin node detected on port ${_node_port}."
        echo -e "  Start the node or build it via ${YELLOW}Script 01${NC} first, then return here."
        echo ""
        read -r -p "  Press 0 to return to main menu: "
        return 0
    fi

    # Check if already configured for this network
    local _already_domain="" _already_dir=""
    local _d
    for _d in "${reserved_dirs[@]}"; do
        local _conf
        _conf=$(grep -rl "root ${_d}" "$NGINX_AVAILABLE" 2>/dev/null | head -1)
        if [[ -n "$_conf" ]]; then
            _already_domain=$(basename "$_conf")
            _already_dir="$_d"
            break
        fi
    done

    if [[ -n "$_already_domain" ]]; then
        echo ""
        print_info "A Grin ${network} domain is already configured:"
        echo "  Domain    : ${_already_domain}"
        echo "  Directory : ${_already_dir}"
        echo ""
        print_warn "To reconfigure, use option 4) Remove Domain first, then run this option again."
        echo ""
        read -rp "Press Enter to return to the main menu..."
        return 0
    fi

    # Get required information
    print_section "Configuration"
    get_domain "$network"         || { print_info "Setup cancelled."; return 0; }
    get_email                     || { print_info "Setup cancelled."; return 0; }
    get_files_directory "strict"  || { print_info "Setup cancelled."; return 0; }

    # Confirm before proceeding
    echo ""
    print_warn "About to configure:"
    echo "  Domain: $DOMAIN"
    echo "  Email: $EMAIL"
    echo "  Files Directory: $FILES_DIR"
    echo ""
    local proceed_choice
    while true; do
        read -r -p "Proceed with setup? (Y/n/0) [default: Y, 0 = cancel]: " proceed_choice
        [[ "$proceed_choice" == "0" ]] && print_info "Setup cancelled." && return 0
        [[ "${proceed_choice,,}" =~ ^n ]] && print_info "Setup cancelled." && return 0
        break
    done

    # Execute setup steps
    create_files_directory
    create_initial_nginx_config
    obtain_ssl_certificate
    enhance_nginx_config
    setup_auto_renewal

    # Display summary
    display_setup_summary
    echo ""
    print_info "Full log saved to: $LOG_FILE"
    echo ""
    read -rp "Press Enter to return to the main menu..."
}

run_setup_grin_mainnet() { run_setup_grin_network "mainnet"; }
run_setup_grin_testnet()  { run_setup_grin_network "testnet"; }

# 23.1 - Add custom (non-Grin) domain workflow
run_setup_custom() {
    print_section "Add Custom Domain"

    # Ensure nginx + certbot are installed (single combined prompt if either is missing)
    ensure_nginx_certbot || return 0

    # Get required information
    print_section "Configuration"
    get_domain "custom"          || { print_info "Setup cancelled."; return 0; }
    get_email                    || { print_info "Setup cancelled."; return 0; }
    get_files_directory "custom" || { print_info "Setup cancelled."; return 0; }
    get_bandwidth_settings       || { print_info "Setup cancelled."; return 0; }

    # Confirm before proceeding
    echo ""
    print_warn "About to configure:"
    echo "  Domain: $DOMAIN"
    echo "  Email: $EMAIL"
    echo "  Files Directory: $FILES_DIR"
    if [[ "$ENABLE_BANDWIDTH_LIMIT" == "yes" ]]; then
        echo "  Bandwidth Limit: ${DOWNLOAD_QUOTA_GB}GB per IP"
        echo "  Speed after quota: $SPEED_LIMIT_AFTER_QUOTA"
    fi
    echo ""
    local proceed_choice
    while true; do
        read -r -p "Proceed with setup? (Y/n/0) [default: Y, 0 = cancel]: " proceed_choice
        [[ "$proceed_choice" == "0" ]] && print_info "Setup cancelled." && return 0
        [[ "${proceed_choice,,}" =~ ^n ]] && print_info "Setup cancelled." && return 0
        break
    done

    # Execute setup steps
    create_files_directory
    create_initial_nginx_config
    obtain_ssl_certificate
    enhance_nginx_config
    setup_bandwidth_limiting
    setup_auto_renewal

    # Display summary
    display_setup_summary
    echo ""
    print_info "Full log saved to: $LOG_FILE"
    echo ""
    read -rp "Press Enter to return to the main menu..."
}

# 24.0 - Remove domain workflow
run_remove() {
    print_section "Domain Removal"
    
    # List available domains
    if ! list_domains; then
        print_error "No domains to remove"
        echo ""
        read -rp "Press Enter to return to the main menu..."
        return 0
    fi

    # Get domain to remove
    get_domain_to_remove || { print_info "Removal cancelled."; return 0; }
    
    # Gather information about the domain
    gather_domain_info
    
    # Confirm removal with user
    confirm_removal || { return 0; }

    # Execute removal steps
    remove_nginx_config
    remove_ssl_certificate
    remove_bandwidth_limiting
    remove_log_files
    remove_files_directory
    
    # Display summary
    display_removal_summary
    echo ""
    print_info "Full log saved to: $LOG_FILE"
    echo ""
    read -rp "Press Enter to return to the main menu..."
}

# 25.0 - List domains workflow
run_list() {
    if list_domains; then
        echo ""
        print_info "To add a domain: $0 --action add"
        print_info "To remove a domain: $0 --action remove"
    fi
    echo ""
    read -rp "Press Enter to return to the main menu..."
}

# 25.5a - Set per-IP speed cap
_limit_rate_set_ip() {
    ensure_geo_conf

    local ip
    while true; do
        read -p "Enter IP address to rate-limit (or 0 to cancel): " ip
        [[ "$ip" == "0" ]] && return
        if validate_ip "$ip"; then
            break
        else
            print_error "Invalid IPv4 address. Example: 1.2.3.4"
        fi
    done

    local rate_input
    while true; do
        echo ""
        echo "  Rate examples:  500k = 500 KB/s  |  1m = 1 MB/s  |  5m = 5 MB/s"
        echo ""
        read -p "Enter rate limit for $ip (e.g., 1m, 500k) or 0 to cancel: " rate_input
        [[ "$rate_input" == "0" ]] && return
        rate_input="${rate_input,,}"
        if convert_rate_to_bytes "$rate_input" &>/dev/null; then
            break
        else
            print_error "Invalid rate format. Use a number followed by 'k' or 'm' (e.g., 1m, 500k)."
        fi
    done

    local bytes
    bytes="$(convert_rate_to_bytes "$rate_input")"

    local tmp; tmp="$(mktemp)"
    grep -v "^[[:space:]]*${ip}[[:space:]]" "$IP_LIMITS_CONF" | grep -v "^}" > "$tmp"
    echo "    $ip  $bytes;" >> "$tmp"
    echo "}" >> "$tmp"
    mv "$tmp" "$IP_LIMITS_CONF"

    print_info "Rate limit set: $ip  →  $rate_input  (${bytes} bytes/s)"
    inject_rate_limit_to_sites

    if nginx -t &>/dev/null; then
        systemctl reload nginx
        print_info "Nginx reloaded. Rate limit active for $ip."
    else
        print_error "Nginx config test failed. Please check $IP_LIMITS_CONF"
        nginx -t
    fi
}

# 25.5b - Set default rate for ALL IPs (global cap)
_limit_rate_set_default() {
    ensure_geo_conf

    local current_bytes=0
    current_bytes=$(grep -E '^\s+default\s+[0-9]+;' "$IP_LIMITS_CONF" \
        | grep -oP '[0-9]+' | head -1 || echo "0")
    current_bytes="${current_bytes:-0}"
    print_info "Current default rate: $(_bytes_to_human "$current_bytes")"
    echo ""
    echo "  Rate examples:  500k = 500 KB/s  |  1m = 1 MB/s  |  5m = 5 MB/s"
    echo "  Press Enter (empty) to set unlimited.  0 = cancel."
    echo ""

    local rate_input
    while true; do
        read -p "Enter default rate for ALL IPs (e.g., 5m, 500k, or Enter = unlimited): " rate_input
        [[ "$rate_input" == "0" ]] && return
        rate_input="${rate_input,,}"
        if [[ -z "$rate_input" ]]; then
            break
        elif convert_rate_to_bytes "$rate_input" &>/dev/null; then
            break
        else
            print_error "Invalid rate format. Use a number followed by 'k' or 'm' (e.g., 1m, 500k)."
        fi
    done

    local new_bytes=0
    [[ -n "$rate_input" ]] && new_bytes="$(convert_rate_to_bytes "$rate_input")"

    sed -i "s/^[[:space:]]*default[[:space:]]*[0-9]*;/    default ${new_bytes};/" "$IP_LIMITS_CONF"

    print_info "Default rate set to: $(_bytes_to_human "$new_bytes")"
    inject_rate_limit_to_sites

    if nginx -t &>/dev/null; then
        systemctl reload nginx
        print_info "Nginx reloaded. Default rate is now active."
    else
        print_error "Nginx config test failed. Please check $IP_LIMITS_CONF"
        nginx -t
    fi
}

# 25.5c - Enable rate limiting for a specific domain (inject limit_rate directive)
_limit_rate_enable_for_domain() {
    ensure_geo_conf

    local domains=() statuses=()
    for conf in "$NGINX_AVAILABLE"/*; do
        [[ -f "$conf" ]] || continue
        local dname; dname="$(basename "$conf")"
        [[ "$dname" == "default" || "$dname" == "default-ssl" ]] && continue
        domains+=("$dname")
        if grep -q 'limit_rate \$grin_rate_limit' "$conf" 2>/dev/null; then
            statuses+=("already enabled")
        elif grep -q "autoindex_format html;" "$conf" 2>/dev/null; then
            statuses+=("can enable")
        else
            statuses+=("not compatible")
        fi
    done

    if [[ ${#domains[@]} -eq 0 ]]; then
        print_warn "No domains configured."
        return
    fi

    echo ""
    echo "  Domains:"
    local i
    for i in "${!domains[@]}"; do
        printf "  %2d) %-35s [%s]\n" "$((i+1))" "${domains[$i]}" "${statuses[$i]}"
    done
    echo "   0) Cancel"
    echo ""

    local sel
    read -p "Select domain [0-${#domains[@]}]: " sel
    [[ "$sel" == "0" ]] && return
    if ! [[ "$sel" =~ ^[0-9]+$ ]] || (( sel < 1 || sel > ${#domains[@]} )); then
        print_error "Invalid selection."
        return
    fi

    local chosen_domain="${domains[$((sel-1))]}"
    local chosen_status="${statuses[$((sel-1))]}"
    local conf_file="$NGINX_AVAILABLE/$chosen_domain"

    if [[ "$chosen_status" == "already enabled" ]]; then
        print_info "Rate limiting is already enabled for $chosen_domain."
        return
    fi

    if [[ "$chosen_status" == "not compatible" ]]; then
        print_warn "Cannot inject rate limit into $chosen_domain — autoindex_format directive not found."
        print_info "Edit $conf_file manually to add: limit_rate \$grin_rate_limit;"
        return
    fi

    sed -i 's/autoindex_format html;/autoindex_format html;\n        limit_rate $grin_rate_limit;/' "$conf_file"
    print_info "Rate limiting enabled for: $chosen_domain"

    if nginx -t &>/dev/null; then
        systemctl reload nginx
        print_info "Nginx reloaded."
    else
        print_error "Nginx config test failed. Reverting..."
        sed -i '/limit_rate \$grin_rate_limit;/d' "$conf_file"
        nginx -t
    fi
}

# 25.5 - Limit rate/bandwidth submenu (menu item 5)
run_limit_rate() {
    while true; do
        clear
        print_section "Limit Rate / Bandwidth"
        show_current_restrictions

        echo "  1) Set per-IP speed cap          - cap a specific IP address"
        echo "  2) Set default rate for all IPs  - apply a global cap to all visitors"
        echo "  3) Enable for a domain           - inject rate limit into a site config"
        echo "  0) Back to main menu"
        echo ""
        read -p "Choice [0-3]: " lr_choice

        case "$lr_choice" in
            0) return ;;
            1) _limit_rate_set_ip ;;
            2) _limit_rate_set_default ;;
            3) _limit_rate_enable_for_domain ;;
            *) print_error "Invalid choice." ; sleep 1 ; continue ;;
        esac

        echo ""
        echo "Press Enter to continue..."
        read -r
    done
}

# 26.0 - Lift rate/bandwidth limit for specific IPs (menu item 6)
run_lift_rate() {
    print_section "Lift Rate / Bandwidth"

    show_current_restrictions

    if [[ ! -f "$IP_LIMITS_CONF" ]]; then
        print_warn "No rate limits configured. Nothing to lift."
        echo ""
        echo "Press Enter to return to the menu..."
        read -r
        return
    fi

    echo "Options:"
    echo "  1) Lift limit for a specific IP"
    echo "  2) Lift limits for ALL IPs"
    echo "  3) Remove rate limit from a domain config"
    echo "  0) Cancel — return to main menu"
    echo ""
    read -p "Enter choice [0-3]: " lift_choice

    case "$lift_choice" in
        0) return ;;
        3)
            local domains=() statuses=()
            for conf in "$NGINX_AVAILABLE"/*; do
                [[ -f "$conf" ]] || continue
                local dname; dname="$(basename "$conf")"
                [[ "$dname" == "default" || "$dname" == "default-ssl" ]] && continue
                if grep -q 'limit_rate \$grin_rate_limit' "$conf" 2>/dev/null; then
                    domains+=("$dname")
                    statuses+=("rate limited")
                fi
            done
            if [[ ${#domains[@]} -eq 0 ]]; then
                print_info "No domains currently have a rate limit directive injected."
                echo ""; echo "Press Enter to continue..."; read -r
                return
            fi
            echo ""
            echo "  Domains with rate limit enabled:"
            local i
            for i in "${!domains[@]}"; do
                printf "  %2d) %-35s [%s]\n" "$((i+1))" "${domains[$i]}" "${statuses[$i]}"
            done
            echo "   0) Cancel"
            echo ""
            local sel
            read -p "Select domain to remove rate limit [0-${#domains[@]}]: " sel
            [[ "$sel" == "0" ]] && return
            if ! [[ "$sel" =~ ^[0-9]+$ ]] || (( sel < 1 || sel > ${#domains[@]} )); then
                print_error "Invalid selection."
                return
            fi
            local chosen="${domains[$((sel-1))]}"
            local chosen_conf="$NGINX_AVAILABLE/$chosen"
            sed -i '/limit_rate \$grin_rate_limit;/d' "$chosen_conf"
            print_info "Rate limit directive removed from: $chosen"
            if nginx -t &>/dev/null; then
                systemctl reload nginx
                print_info "Nginx reloaded."
            else
                print_error "Nginx config test failed."
                nginx -t
            fi
            echo ""; echo "Press Enter to continue..."; read -r
            return
            ;;
        1)
            local ip
            while true; do
                read -p "Enter IP address to remove restriction (or 0 to cancel): " ip
                [[ "$ip" == "0" ]] && return
                if validate_ip "$ip"; then
                    break
                else
                    print_error "Invalid IPv4 address. Example: 1.2.3.4"
                fi
            done

            if ! grep -q "^[[:space:]]*${ip}[[:space:]]" "$IP_LIMITS_CONF" 2>/dev/null; then
                print_warn "IP $ip has no rate limit configured."
            else
                local tmp
                tmp="$(mktemp)"
                grep -v "^[[:space:]]*${ip}[[:space:]]" "$IP_LIMITS_CONF" > "$tmp"
                mv "$tmp" "$IP_LIMITS_CONF"
                print_info "Rate limit removed for: $ip (now unlimited)"
            fi
            ;;
        2)
            read -r -p "Remove rate limits for ALL IPs? (Y/n/0) [default: Y, 0 = cancel]: " all_choice
            [[ "$all_choice" == "0" ]] && return
            if [[ ! "${all_choice,,}" =~ ^n ]]; then
                cat > "$IP_LIMITS_CONF" << 'EOF'
# Grin File Server - Per-IP rate limits (bytes/s, 0 = unlimited)
# Managed by 02_nginx-fileserver-manager.sh
geo $remote_addr $grin_rate_limit {
    default 0;
}
EOF
                print_info "All IP rate limits cleared."
            else
                print_info "Cancelled."
            fi
            ;;
        *)
            print_error "Invalid choice."
            ;;
    esac

    # Reload nginx
    if nginx -t &>/dev/null; then
        systemctl reload nginx
        print_info "Nginx reloaded."
    else
        print_error "Nginx config test failed."
        nginx -t
    fi

    echo ""
    echo "Press Enter to return to the menu..."
    read -r
}

# 27.0 - Enhance security with fail2ban and nginx rate limiting (menu item 7)
run_enhance_security() {
    print_section "Enhance security by fail2ban"

    echo "This will run following steps:"
    echo "  1. Install fail2ban (if not already installed)"
    echo "  2. Configure nginx request rate limiting (limit_req)"
    echo "  3. Create fail2ban jails for nginx (auto-ban abusive IPs)"
    echo " NOTICE! You may remove/lift the rate limiting later in option 6"
    echo ""
    local sec_choice
    while true; do
        read -r -p "Proceed? (Y/n/0) [default: Y, 0 = cancel]: " sec_choice
        [[ "$sec_choice" == "0" ]] && print_info "Cancelled." && return
        [[ "${sec_choice,,}" =~ ^n ]] && print_info "Cancelled." && return
        break
        # empty or unrecognised — proceed
    done

    # ----- Step 1: Install fail2ban -----
    print_section "Step 1: Installing fail2ban"
    if command -v fail2ban-server &>/dev/null; then
        print_info "fail2ban is already installed"
    else
        print_info "Installing fail2ban..."
        if [[ -f /etc/debian_version ]]; then
            apt-get update -q
            apt-get install -y fail2ban
        elif [[ -f /etc/redhat-release ]]; then
            yum install -y fail2ban
        else
            print_error "Unsupported OS. Please install fail2ban manually and re-run."
            echo ""
            echo "Press Enter to return to the menu..."
            read -r
            return
        fi
        print_info "fail2ban installed successfully"
    fi

    # ----- Step 2: Nginx request rate limiting (limit_req_zone) -----
    print_section "Step 2: Nginx Request Rate Limiting"
    local req_zone_conf="/etc/nginx/conf.d/grin_limit_req.conf"
    if [[ ! -f "$req_zone_conf" ]]; then
        cat > "$req_zone_conf" << 'EOF'
# Grin File Server - Request rate limiting zone
# Managed by 02_nginx-fileserver-manager.sh
limit_req_zone $binary_remote_addr zone=grin_req:10m rate=20r/s;
limit_req_status 429;
EOF
        print_info "Created request rate limit zone: $req_zone_conf"
    else
        print_info "Request rate limit zone already exists: $req_zone_conf"
    fi

    # Inject limit_req into site location blocks that don't have it yet
    local injected_req=0
    for conf_file in "$NGINX_AVAILABLE"/*; do
        [[ -f "$conf_file" ]] || continue
        local domain
        domain="$(basename "$conf_file")"
        [[ "$domain" == "default" || "$domain" == "default-ssl" ]] && continue

        if ! grep -q "limit_req zone=grin_req" "$conf_file" 2>/dev/null; then
            if grep -q "autoindex_format html;" "$conf_file" 2>/dev/null; then
                sed -i 's/autoindex_format html;/autoindex_format html;\n        limit_req zone=grin_req burst=30 nodelay;/' "$conf_file"
                injected_req=$(( injected_req + 1 ))
                print_info "Injected request limit into: $domain"
            fi
        fi
    done
    [[ $injected_req -gt 0 ]] && print_info "Injected limit_req into $injected_req site config(s)"

    # ----- Step 3: fail2ban nginx jails -----
    print_section "Step 3: Configuring fail2ban Nginx Jails"
    mkdir -p "$(dirname "$FAIL2BAN_JAIL_CONF")"
    cat > "$FAIL2BAN_JAIL_CONF" << 'EOF'
# Grin File Server - fail2ban nginx jails
# Managed by 02_nginx-fileserver-manager.sh

[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5

[nginx-http-auth]
enabled  = true
port     = http,https
logpath  = /var/log/nginx/*error.log
maxretry = 3

[nginx-limit-req]
enabled  = true
port     = http,https
logpath  = /var/log/nginx/*error.log
maxretry = 10
findtime = 60
bantime  = 600

[nginx-botsearch]
enabled  = true
port     = http,https
filter   = nginx-botsearch
logpath  = /var/log/nginx/*access.log
maxretry = 2
EOF
    print_info "Created fail2ban jail config: $FAIL2BAN_JAIL_CONF"

    # ----- Step 4: Enable and restart fail2ban -----
    print_section "Step 4: Starting fail2ban"
    systemctl enable fail2ban
    systemctl restart fail2ban
    sleep 2

    # Reload nginx
    if nginx -t &>/dev/null; then
        systemctl reload nginx
        print_info "Nginx reloaded"
    else
        print_error "Nginx config test failed after security changes"
        nginx -t
        echo ""
        echo "Press Enter to return to the menu..."
        read -r
        return
    fi

    # ----- Summary -----
    print_section "Security Enhancement Complete"
    echo ""
    print_info "fail2ban active jails:"
    fail2ban-client status 2>/dev/null | grep -A1 "Jail list" || print_warn "fail2ban not fully running yet"
    echo ""
    echo "  Useful commands:"
    echo "    Overall status:        fail2ban-client status"
    echo "    Check a jail:          fail2ban-client status nginx-http-auth"
    echo "    Unban an IP:           fail2ban-client set nginx-http-auth unbanip 1.2.3.4"
    echo "    List banned IPs:       fail2ban-client get nginx-http-auth banned"
    echo "    Live fail2ban log:     tail -f /var/log/fail2ban.log"
    echo ""

    echo "Press Enter to return to the menu..."
    read -r
}

# 28.1 - Block a single IP or CIDR via the detected firewall
_ip_block() {
    read -p "Enter IP / CIDR to block (e.g. 1.2.3.4 or 1.2.3.0/24) or 0 to cancel: " target_ip
    [[ -z "$target_ip" || "$target_ip" == "0" ]] && return
    read -p "Reason / note (optional, 0 to cancel): " reason
    [[ "$reason" == "0" ]] && return

    case "$FIREWALL" in
        ufw)
            ufw deny from "$target_ip" to any
            print_info "UFW: blocked $target_ip"
            ;;
        iptables)
            iptables -I INPUT   -s "$target_ip" -j DROP
            iptables -I OUTPUT  -d "$target_ip" -j DROP
            iptables -I FORWARD -s "$target_ip" -j DROP
            print_info "iptables: blocked $target_ip (INPUT / OUTPUT / FORWARD)"
            ;;
        none)
            print_warn "No firewall available. Cannot block IP."
            return
            ;;
    esac

    echo "$target_ip | $(date -u '+%Y-%m-%d %H:%M UTC') | ${reason:-no reason}" >> "$BLOCKED_LIST_FILE"
    print_info "Logged to: $BLOCKED_LIST_FILE"
}

# 28.2 - Unblock a single IP via the detected firewall
_ip_unblock() {
    echo ""
    echo "Currently blocked IPs:"
    if [[ ! -s "$BLOCKED_LIST_FILE" ]]; then
        print_info "(none recorded)"
        echo ""
        echo "Press Enter to continue..."
        read -r
        return
    fi

    nl -ba "$BLOCKED_LIST_FILE"
    echo ""
    read -p "Enter IP address to unblock (or 0 to cancel): " target_ip
    [[ -z "$target_ip" || "$target_ip" == "0" ]] && return

    case "$FIREWALL" in
        ufw)
            ufw delete deny from "$target_ip" to any 2>/dev/null \
                || print_warn "UFW rule not found for $target_ip"
            print_info "UFW: unblocked $target_ip"
            ;;
        iptables)
            iptables -D INPUT   -s "$target_ip" -j DROP 2>/dev/null || true
            iptables -D OUTPUT  -d "$target_ip" -j DROP 2>/dev/null || true
            iptables -D FORWARD -s "$target_ip" -j DROP 2>/dev/null || true
            print_info "iptables: unblocked $target_ip"
            ;;
        none)
            print_warn "No firewall available."
            ;;
    esac

    sed -i "/^${target_ip//\//\\/}/d" "$BLOCKED_LIST_FILE" 2>/dev/null || true
    print_info "Removed $target_ip from block list"
}

# 28.3 - List all blocked IPs from the recorded list and active iptables rules
_ip_list() {
    echo ""
    echo "Blocked IPs (grin-toolkit record):"
    if [[ -s "$BLOCKED_LIST_FILE" ]]; then
        while IFS= read -r line; do
            echo -e "  ${RED}✖${NC} $line"
        done < "$BLOCKED_LIST_FILE"
    else
        print_info "(none recorded)"
    fi

    echo ""
    echo "Active iptables DROP rules (INPUT chain):"
    if command -v iptables &>/dev/null; then
        iptables -L INPUT -n --line-numbers 2>/dev/null | grep "DROP" | sed 's/^/  /' \
            || echo "  (none)"
    else
        echo "  (iptables not available)"
    fi
    echo ""
}

# 28.0 - IP Filtering workflow (menu item 8)
run_fail2ban_management() {
    print_section "Fail2ban Management"

    if ! command -v fail2ban-client &>/dev/null; then
        print_error "fail2ban is not installed. Run option 7 (Install fail2ban) first."
        echo ""; echo "Press Enter to continue..."; read -r
        return
    fi

    local ts
    while true; do
        echo ""
        echo "  A) Overall status          - All jails (nginx-botsearch / nginx-http-auth / nginx-limit-req / sshd)"
        echo "  B) Check nginx-http-auth   - Detailed status of nginx-http-auth jail"
        echo "  C) Unban an IP             - Remove a ban from nginx-http-auth"
        echo "  D) List banned IPs         - Top 50 IPs banned in nginx-http-auth"
        echo "  0) Back to main menu"
        echo ""
        read -p "Select [A-D / 0]: " fb_choice

        case "${fb_choice^^}" in
            A)
                ts=$(date '+%Y%m%d_%H%M%S')
                local log_a="$LOG_DIR/fail2ban_overall_status_${ts}.log"
                mkdir -p "$LOG_DIR"
                {
                    echo "=== fail2ban overall status — $(date) ==="
                    echo ""
                    for jail in nginx-botsearch nginx-http-auth nginx-limit-req sshd; do
                        echo "--- Jail: $jail ---"
                        fail2ban-client status "$jail" 2>&1 || echo "(jail not active)"
                        echo ""
                    done
                } | tee "$log_a"
                echo ""
                print_info "Log saved to: $log_a"
                echo "Press Enter to continue..."; read -r
                ;;
            B)
                ts=$(date '+%Y%m%d_%H%M%S')
                local log_b="$LOG_DIR/fail2ban_nginx-http-auth_status_${ts}.log"
                mkdir -p "$LOG_DIR"
                {
                    echo "=== fail2ban nginx-http-auth status — $(date) ==="
                    echo ""
                    fail2ban-client status nginx-http-auth 2>&1
                } | tee "$log_b"
                echo ""
                print_info "Log saved to: $log_b"
                echo "Press Enter to continue..."; read -r
                ;;
            C)
                local unban_ip
                read -p "  Enter IP to unban (or 0 to cancel): " unban_ip
                [[ "$unban_ip" == "0" || -z "$unban_ip" ]] && continue
                ts=$(date '+%Y%m%d_%H%M%S')
                local log_c="$LOG_DIR/fail2ban_unban_status_${ts}.log"
                mkdir -p "$LOG_DIR"
                {
                    echo "=== fail2ban unban $unban_ip — $(date) ==="
                    echo ""
                    fail2ban-client set nginx-http-auth unbanip "$unban_ip" 2>&1
                } | tee "$log_c"
                echo ""
                print_info "Log saved to: $log_c"
                echo "Press Enter to continue..."; read -r
                ;;
            D)
                ts=$(date '+%Y%m%d_%H%M%S')
                local log_d="$LOG_DIR/fail2ban_banned_IPs_${ts}.log"
                mkdir -p "$LOG_DIR"
                {
                    echo "=== fail2ban banned IPs (nginx-http-auth, top 50) — $(date) ==="
                    echo ""
                    fail2ban-client get nginx-http-auth banned 2>&1 | head -50
                } | tee "$log_d"
                echo ""
                print_info "Log saved to: $log_d"
                echo "Press Enter to continue..."; read -r
                ;;
            0) break ;;
            *) print_error "Invalid choice." ; sleep 1 ;;
        esac
    done
}

run_ip_filtering() {
    print_section "IP Filtering"

    init_security_dirs
    detect_firewall

    while true; do
        echo ""
        echo "  1) Block IP / CIDR"
        echo "  2) Unblock IP"
        echo "  3) List blocked IPs"
        echo "  0) Back to main menu"
        echo ""
        read -p "Select [0-3]: " ip_choice

        case "$ip_choice" in
            1) _ip_block ;;
            2) _ip_unblock ;;
            3) _ip_list ; echo "Press Enter to continue..."; read -r ;;
            0) break ;;
            *) print_error "Invalid choice." ; sleep 1 ;;
        esac
    done
}

#############################################################################
# Main Script
#############################################################################

# 29.0 - Dispatch a single action
_dispatch_action() {
    case "$ACTION" in
        grin_mainnet)        run_setup_grin_mainnet ;;
        grin_testnet)        run_setup_grin_testnet ;;
        custom)              run_setup_custom ;;
        remove)              run_remove ;;
        list)                run_list ;;
        limit_rate)          run_limit_rate ;;
        lift_rate)           run_lift_rate ;;
        enhance_security)    run_enhance_security ;;
        fail2ban_management) run_fail2ban_management ;;
        ip_filtering)        run_ip_filtering ;;
        *)
            print_error "Invalid action: $ACTION"
            exit 1
            ;;
    esac
}

# 29.1 - Main execution function
main() {
    check_root
    parse_arguments "$@"

    mkdir -p "$LOG_DIR"

    # Command-line single-action mode (ACTION set via --action flag)
    if [[ -n "$ACTION" ]]; then
        LOG_FILE="$LOG_DIR/nginx-${ACTION}-$(date '+%Y%m%d_%H%M%S').log"
        exec > >(tee -a "$LOG_FILE") 2>&1
        echo "=========================================";echo "Script started at: $(date)";echo "Action: $ACTION";echo "========================================="
        _dispatch_action
        finalize_log
        return
    fi

    # Interactive loop — returns to main menu after each action; "0" exits
    LOG_FILE="$LOG_DIR/nginx-session-$(date '+%Y%m%d_%H%M%S').log"
    exec > >(tee -a "$LOG_FILE") 2>&1
    echo "=========================================";echo "Session started at: $(date)";echo "========================================="

    while true; do
        get_action   # shows menu; "0" calls exit 0 directly
        echo "--- Action: $ACTION at $(date) ---"
        _dispatch_action
        ACTION=""    # reset so get_action() shows menu again next iteration
    done
}

# Run main function
main "$@"
