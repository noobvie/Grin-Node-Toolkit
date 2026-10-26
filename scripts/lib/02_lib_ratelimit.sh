# 02_lib_ratelimit.sh — bandwidth rate limiting of Script 02: limit and lift per-IP and default download rates.
# Sourced by 02_nginx_fileserver_manager.sh; shares its globals and log/info/warn/error.
# Moved as-is; callers reach these via `fn || …`, so errexit is off and file operations are not individually guarded.

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
# Managed by 02_nginx_fileserver_manager.sh
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

# 25.5 - Limit rate/bandwidth submenu (menu item 6)
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

# 26.0 - Lift rate/bandwidth limit for specific IPs (menu item 7)
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
# Managed by 02_nginx_fileserver_manager.sh
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
