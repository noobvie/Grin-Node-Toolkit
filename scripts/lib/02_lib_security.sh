# 02_lib_security.sh — security sections of Script 02: firewall detection, hardening, IP filtering and fail2ban management.
# Sourced by 02_nginx_fileserver_manager.sh; shares its globals and log/info/warn/error.
# Moved as-is; callers reach these via `fn || …`, so errexit is off and file operations are not individually guarded.

# 1.7 - Detect available firewall (firewalld, ufw or iptables)
# firewalld first: it is the default on RHEL/Rocky/Alma, where iptables may be
# absent entirely (removed in RHEL 10) or conflict with firewalld if used directly.
detect_firewall() {
    if command -v firewall-cmd &>/dev/null && firewall-cmd --state &>/dev/null; then
        FIREWALL="firewalld"
    elif command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
        FIREWALL="ufw"
    elif command -v iptables &>/dev/null; then
        FIREWALL="iptables"
    else
        FIREWALL="none"
        print_warn "No supported firewall found (firewalld, ufw or iptables). IP blocking will not work."
    fi
    print_info "Firewall detected: $FIREWALL"
}

# 1.8 - Initialise directories for security data
init_security_dirs() {
    mkdir -p /etc/grin-toolkit
    touch "$BLOCKED_LIST_FILE" 2>/dev/null || true
}

# 27.0 - Enhance security with fail2ban and nginx rate limiting (menu item 8)
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
            # fail2ban lives in EPEL — ensure the repo is enabled first
            rpm -q epel-release &>/dev/null || yum install -y epel-release
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
    # The zone goes through nginx_ensure_rate_limit_zone, never an inline heredoc
    # (CLAUDE.md nginx rule 1). nginx loads every conf.d/*.conf into ONE http context,
    # so two scripts defining zone=grin_req with different rates is a fatal config
    # error at reload — the helper is the only thing that grep-guards against that.
    local legacy_zone_conf="/etc/nginx/conf.d/grin_limit_req.conf"
    # Migration on boxes that still carry the pre-helper file: strip limit_req_status,
    # which belongs at the location level, not http. Leave the file itself in place —
    # it still defines grin_req, and the helper below sees that and stays a no-op, so
    # nothing ends up defining the zone twice. Renaming it here would be the bug.
    if [[ -f "$legacy_zone_conf" ]] && grep -q "limit_req_status" "$legacy_zone_conf" 2>/dev/null; then
        sed -i '/limit_req_status/d' "$legacy_zone_conf"
        print_info "Removed limit_req_status from legacy zone file (moved to location blocks)"
    fi
    local zone_ok=true
    if nginx_ensure_rate_limit_zone "grin_req" "20r/s" "10m" "script02-fileserver"; then
        print_info "Request rate limit zone ensured: grin_req (20r/s)"
    else
        zone_ok=false
        # Skip ONLY the injection, and carry on with the remaining security steps. A vhost
        # carrying `limit_req zone=grin_req` with no matching zone in the http context is a
        # FATAL nginx config error — the box fails to reload and every site on it goes down.
        # Better to leave rate limiting off than to take nginx with it.
        print_error "Could not ensure the grin_req rate-limit zone — skipping limit_req injection."
    fi

    # Inject limit_req into site location blocks that don't have it yet
    local injected_req=0
    for conf_file in "$NGINX_AVAILABLE"/*; do
        [[ "$zone_ok" == true ]] || break
        [[ -f "$conf_file" ]] || continue
        local domain
        domain="$(basename "$conf_file")"
        [[ "$domain" == "default" || "$domain" == "default-ssl" ]] && continue

        if ! grep -q "limit_req zone=grin_req" "$conf_file" 2>/dev/null; then
            if grep -q "autoindex_format html;" "$conf_file" 2>/dev/null; then
                sed -i 's/autoindex_format html;/autoindex_format html;\n        limit_req zone=grin_req burst=30 nodelay;\n        limit_req_status 429;/' "$conf_file"
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
# Managed by 02_nginx_fileserver_manager.sh

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
        firewalld)
            firewall-cmd --permanent --add-rich-rule="rule family='ipv4' source address='${target_ip}' drop" &>/dev/null \
                && firewall-cmd --reload &>/dev/null \
                || { print_warn "firewalld: failed to add drop rule for $target_ip"; return; }
            print_info "firewalld: blocked $target_ip"
            ;;
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
        firewalld)
            firewall-cmd --permanent --remove-rich-rule="rule family='ipv4' source address='${target_ip}' drop" &>/dev/null \
                && firewall-cmd --reload &>/dev/null \
                || print_warn "firewalld rule not found for $target_ip"
            print_info "firewalld: unblocked $target_ip"
            ;;
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
    if [[ "$FIREWALL" == "firewalld" ]]; then
        echo "Active firewalld drop rich-rules:"
        firewall-cmd --list-rich-rules 2>/dev/null | grep "drop" | sed 's/^/  /' \
            || echo "  (none)"
    else
        echo "Active iptables DROP rules (INPUT chain):"
        if command -v iptables &>/dev/null; then
            iptables -L INPUT -n --line-numbers 2>/dev/null | grep "DROP" | sed 's/^/  /' \
                || echo "  (none)"
        else
            echo "  (iptables not available)"
        fi
    fi
    echo ""
}

# 28.0 - IP Filtering workflow (menu item 10)
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
