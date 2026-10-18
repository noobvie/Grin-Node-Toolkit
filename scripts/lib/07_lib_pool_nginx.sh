# =============================================================================
# 07_lib_pool_nginx.sh — Nginx vhost, latency-probe helpers and fail2ban for the public pool script (menus 4 and 1b).
# =============================================================================
# Sourced by 07_grin_mining_public_pool.sh after the POOL_* constants; shares its globals and log/info/warn/error.
# Trap: runs with errexit off (callers guard with `|| true`), so each file-writing command carries its own `|| { error …; return 1; }`; a failed write never reaches `nginx -t`/reload.

# ═══════════════════════════════════════════════════════════════════════════════
# 4) SETUP NGINX
# ═══════════════════════════════════════════════════════════════════════════════

# ─── Latency probes for the connect page ────────────────────────────────────────
# The connect page times https://<gateway stratum host>/ping on each gateway (gateway menu
# 6) and a /ping on this hub, from the visitor's browser. Two optional pool.json keys steer
# it. lib/latency-probe.js applies the SAME two rules on the app side (it publishes them to
# the page on /api/public/branding → connection.latency), so change both or neither.
_POOL_HOST_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'

# latency_probe_domain: the domain whose subdomains the public page may fetch (page CSP
# connect-src https://*.<it>). Default: the pool's own subdomain, and never anything wider.
# Deriving a parent automatically needs the Public Suffix List. Without it, "pool.example.co.uk"
# would widen to "co.uk", and "mypool.duckdns.org" to "duckdns.org". Either would let script
# injected into the withdrawal page post to ANY host under a public suffix. That is the
# §J15-6 argument that removed jsdelivr. So widening is the operator's explicit call: set it
# to a PARENT of subdomain that they own (subdomain pool.example.com, gateways
# hkg.example.com → latency_probe_domain example.com). A value that is neither the subdomain
# nor a parent of it is ignored.
_pool_latency_probe_domain() {
    local sub ovr
    sub=$(pool_read_conf "subdomain" ""); sub="${sub,,}"; sub="${sub%.}"
    [[ "$sub" =~ $_POOL_HOST_RE ]] || return 0
    ovr=$(pool_read_conf "latency_probe_domain" ""); ovr="${ovr,,}"; ovr="${ovr%.}"
    if [[ -n "$ovr" && "$ovr" =~ $_POOL_HOST_RE && ( "$sub" == "$ovr" || "$sub" == *".$ovr" ) ]]; then
        echo "$ovr"
    else
        echo "$sub"
    fi
}

# latency_hub_url: where the page times THIS hub (the "direct" row). Unset means same-origin
# /ping. But behind a CDN proxy (cloudflare_proxy) the CDN's EDGE answers that request, a few
# ms from every visitor, so "direct" would win everywhere. So with the proxy on and this key
# unset, the app publishes NO hub URL and the page keeps its estimate for direct.
# Accepted form: https://<host>/ping (or https://<host>), where <host> is a DNS-only name
# for this box under latency_probe_domain, so the CSP allows it. That is normally the hub
# region's stratum host. For such a host, pool_setup_nginx issues a certificate and adds a
# server block that answers /ping and nothing else.
# Prints that host when it needs its own server block, else nothing: unset, invalid,
# outside the probe domain, or the site's own name or www alias, which the main vhost serves.
_pool_latency_hub_host() {
    local url host dom sub
    url=$(pool_read_conf "latency_hub_url" ""); url="${url,,}"
    [[ "$url" =~ ^https://([a-z0-9.-]+)(/ping)?/?$ ]] || return 0
    host="${BASH_REMATCH[1]}"; host="${host%.}"
    [[ "$host" =~ $_POOL_HOST_RE ]] || return 0
    sub=$(pool_read_conf "subdomain" ""); sub="${sub,,}"; sub="${sub%.}"
    dom=$(_pool_latency_probe_domain)
    [[ -n "$dom" && "$host" == *".$dom" ]] || return 0
    [[ "$host" != "$sub" && "$host" != "www.$sub" ]] || return 0
    echo "$host"
}

# The /ping locations, emitted into the main vhost and into the latency_hub_url block.
#   $1 = the header snippet the ANSWERING location must include (it adds headers of its own).
# Why a named location instead of a bare 'return 204': return runs in nginx's REWRITE phase,
# before the preaccess phase where limit_req lives, so the rate limit would be silently
# skipped. Measured with nginx 1.24: 40 rapid requests gave 40 × 204 with a bare return, and
# 20 × 204 + 20 × 429 this way. (limit_except is NOT affected: a non-GET request switches to
# the limit_except block's own config, which does not inherit the return, so its deny still
# answers 403 either way.) try_files runs in precontent, after both, then hands over to
# @pool_ping. = /ping itself adds no header, so its 403/429 inherit the server's full set.
_pool_nginx_ping_block() {
    local hdr="$1"
    cat << EOF
    # Latency probe for the connect page: an empty 204, never cached. The CORS and
    # Timing-Allow-Origin headers matter only when the page reaches this through
    # latency_hub_url on another name, and they are harmless same-origin. No access log: a
    # probe's visitor IPs are not worth keeping.
    location = /ping {
        limit_req zone=${POOL_SERVICE}_static burst=20 nodelay;
        limit_except GET { deny all; }
        access_log off;
        try_files /.pool-ping-no-such-file @pool_ping;
    }
    location @pool_ping {
        access_log off;
        include ${hdr};
        add_header Cache-Control "no-store" always;
        add_header Access-Control-Allow-Origin "*" always;
        add_header Timing-Allow-Origin "*" always;
        return 204;
    }
EOF
}

pool_setup_nginx() {
    local subdomain; subdomain=$(pool_read_conf "subdomain" "")
    if [[ -z "$subdomain" ]]; then
        echo -ne "Pool subdomain (e.g. pool.example.com): "
        read -r subdomain
        [[ -z "$subdomain" ]] && { warn "No subdomain — nginx not configured."; return 1; }
        pool_write_conf_key "subdomain" "$subdomain"
    fi

    if ! nginx_validate_domain "$subdomain"; then
        error "Invalid domain name: $subdomain"
        return 1
    fi

    # 1) Install does not install nginx or certbot, and Migrate IN's restore only drops files
    # into /etc/nginx — so on a fresh/migrated box this step would write the vhost and then
    # die on `nginx: command not found`. Install both here, as Scripts 04/06 do.
    if ! command -v nginx &>/dev/null || ! command -v certbot &>/dev/null; then
        command -v nginx   &>/dev/null || warn "nginx is not installed."
        command -v certbot &>/dev/null || warn "certbot is not installed."
        echo -ne "Install the missing package(s) now? [Y/n]: "
        local _yn; read -r _yn
        [[ "${_yn,,}" == "n" ]] && { warn "nginx not configured — install nginx + certbot, then re-run 4) Setup nginx."; return 1; }
        # A restored pool vhost still enabled from a Migrate IN archive would make the
        # package's first `nginx` start fail (its cert is not here yet). This step rewrites
        # and re-enables it below, so dropping the link first costs nothing.
        rm -f "/etc/nginx/sites-enabled/$(basename "$POOL_NGINX_CONF")" \
            || { error "Could not remove the restored vhost link from sites-enabled."; return 1; }
        nginx_install_with_certbot || { error "nginx/certbot install failed — resolve the errors above and retry."; return 1; }
    fi

    mkdir -p "$(dirname "$POOL_NGINX_CONF")" \
        || { error "Could not create $(dirname "$POOL_NGINX_CONF")."; return 1; }

    # Migrate a pre-rename install: the vhost is grin-public-pool-<net>; the legacy names are
    # the unsuffixed "grin-pool" (mainnet) and "grin-pool-testnet" (testnet).
    # Drop the legacy conf + its sites-enabled symlink so this run regenerates under
    # the new name instead of leaving two vhosts bound to the same server_name.
    if [[ -n "${POOL_NGINX_CONF_LEGACY:-}" && "$POOL_NGINX_CONF_LEGACY" != "$POOL_NGINX_CONF" ]]; then
        if [[ -f "$POOL_NGINX_CONF_LEGACY" || -L "/etc/nginx/sites-enabled/$(basename "$POOL_NGINX_CONF_LEGACY")" ]]; then
            info "Migrating legacy vhost $(basename "$POOL_NGINX_CONF_LEGACY") → $(basename "$POOL_NGINX_CONF")"
            rm -f "/etc/nginx/sites-enabled/$(basename "$POOL_NGINX_CONF_LEGACY")" "$POOL_NGINX_CONF_LEGACY" \
                || { error "Could not remove the legacy vhost $(basename "$POOL_NGINX_CONF_LEGACY")."; return 1; }
        fi
    fi

    # Disable the stock Debian/Ubuntu "default" site if it's still enabled. Its
    # `listen 80 default_server` + `server_name _` catch-all serves the generic
    # "Welcome to nginx!" page for ANY request whose Host doesn't match the pool
    # (e.g. the raw server IP, or http before DNS resolves) — which looks like the
    # pool homepage is broken. We drop only the sites-enabled SYMLINK (the
    # sites-available/default file is kept, so it's fully reversible) and only when
    # it's the catch-all default_server, never a real operator vhost. The vhost
    # write + reload later in this function picks up the change.
    local _default_site="/etc/nginx/sites-enabled/default"
    if [[ -L "$_default_site" || -f "$_default_site" ]] && grep -qs 'default_server' "$_default_site"; then
        info "Disabling stock nginx default site (catch-all 'Welcome to nginx' page)..."
        rm -f "$_default_site" \
            || { error "Could not disable the stock nginx default site ($_default_site)."; return 1; }
    fi

    # Re-assert the served-asset directory modes (pool_ensure_served_dirs is the single
    # definition; Install calls it too, so re-running Install must not take the app
    # directory back to 700 and 404s every logo until this step is re-run — audit §J8-7b).
    pool_ensure_served_dirs

    # nginx_ensure_rate_limit_zones is a no-op while its conf file exists (so operators can
    # hand-tune rates). That means a NEW zone added to the list below would never be written
    # on an existing install — yet the vhost references it, so `nginx -t` would then fail with
    # "zero size shared memory zone". Self-heal: if the managed conf is missing the captcha
    # zone (added 2026-06 to stop the login captcha being starved by static-asset traffic),
    # delete it so the full current list regenerates. Idempotent — once present, this is skipped.
    # Also regenerate if it still carries any earlier-generation rate. All zone rates
    # are deliberately loose ×20 ("loosen now, tighten later" testing posture) so
    # rate-limiting never breaks normal browsing/admin polling — the real controls are
    # JWT + login captcha + per-account lockout + IP auto-ban, not these throttles.
    # Triggers below catch both the original generation (auth 3r/m, static 60r/m) and
    # the immediately-prior one (auth 10r/m, static 300r/m); regenerating rewrites the
    # full current list (also self-heals an install missing the _captcha/_admin zones).
    # A genuinely hand-tuned conf with other rates is left untouched.
    local _zone_conf="/etc/nginx/conf.d/script07-${POOL_SERVICE}.conf"
    if [[ -f "$_zone_conf" ]] \
        && { ! grep -q "zone=${POOL_SERVICE}_captcha[: ]" "$_zone_conf" \
             || ! grep -q "zone=${POOL_SERVICE}_admin[: ]" "$_zone_conf" \
             || grep -qE "zone=${POOL_SERVICE}_auth:[^ ]* rate=(3|10)r/m" "$_zone_conf" \
             || grep -qE "zone=${POOL_SERVICE}_static:[^ ]* rate=(60|300)r/m" "$_zone_conf"; }; then
        rm -f "$_zone_conf" \
            || { error "Could not remove the outdated rate-limit zones conf $_zone_conf."; return 1; }
    fi

    if declare -F nginx_ensure_rate_limit_zones &>/dev/null; then
        nginx_ensure_rate_limit_zones "script07-${POOL_SERVICE}" \
            "${POOL_SERVICE}_auth:200r/m"     \
            "${POOL_SERVICE}_api:600r/m"      \
            "${POOL_SERVICE}_static:6000r/m"  \
            "${POOL_SERVICE}_captcha:600r/m"  \
            "${POOL_SERVICE}_admin:2400r/m"
    fi

    # ── Cloudflare proxy (orange cloud) support ───────────────────────────────
    # If the hub sits behind Cloudflare's proxy, the origin sees Cloudflare edge IPs,
    # which collapses every per-IP defence (rate-limit zones, fail2ban, app req.ip)
    # onto one shared bucket → "Too many requests" for everyone. Restoring the real
    # client IP from CF-Connecting-IP fixes all of them. Stored in $POOL_CONF so it
    # sticks across re-runs and Guided setup.
    local cf_proxy; cf_proxy=$(pool_read_conf "cloudflare_proxy" "")
    if [[ -z "$cf_proxy" ]]; then
        echo ""
        echo -e "  ${DIM}Is this hub behind Cloudflare's proxy (orange cloud)? If yes, the toolkit${RESET}"
        echo -e "  ${DIM}restores the real visitor IP so rate-limiting & fail2ban work per-user.${RESET}"
        echo -ne "  Behind Cloudflare proxy? [Y/n]: "
        local _cf_ans; read -r _cf_ans
        # Default YES — most public pools front the origin with Cloudflare's proxy. Only an
        # explicit "n" opts out (if you later go direct, re-run 4) Setup nginx and answer n).
        if [[ "${_cf_ans,,}" == "n" ]]; then cf_proxy="false"; else cf_proxy="true"; fi
        pool_write_conf_key "cloudflare_proxy" "$cf_proxy"
    fi

    local cf_realip_include=""
    if [[ "$cf_proxy" == "true" ]]; then
        if nginx_ensure_cloudflare_realip; then
            cf_realip_include="    include ${NGINX_CLOUDFLARE_REALIP_SNIPPET};"
        else
            warn "Cloudflare real-IP setup failed — vhost will be written WITHOUT it."
            warn "  Rate-limiting would throttle all visitors as one until this is fixed."
        fi
    fi

    # Build nginx allow/deny rules for the admin surfaces (/admin + /api/admin).
    #
    # DEFAULT = OPEN (bootstrap/testing posture). An empty admin_allowlist means the panel
    # is reachable from any IP, so a fresh install is never locked out while there is no
    # adoption yet for anyone to attack. The app-layer defenses (JWT sessions, login
    # captcha, per-account lockout, IP auto-ban, optional TOTP 2FA, fail2ban) are ALWAYS
    # in force regardless of this network gate — this is only the outer perimeter.
    #
    # HARDEN LATER: set admin_allowlist (comma/space-separated IPs/CIDRs) in $POOL_CONF and
    # re-run 4) Setup nginx. Once it is non-empty the panel locks to localhost + those
    # entries only (everything else is denied). localhost is always kept so an SSH tunnel
    # and the app's own server-side calls keep working as a break-glass path.
    local admin_allow_raw; admin_allow_raw=$(pool_read_conf "admin_allowlist" "")

    local admin_rules="" _entry
    if [[ -n "$admin_allow_raw" ]]; then
        admin_rules+="        allow 127.0.0.1;"$'\n'
        admin_rules+="        allow ::1;"$'\n'
        for _entry in ${admin_allow_raw//,/ }; do
            [[ -n "$_entry" ]] && admin_rules+="        allow ${_entry};"$'\n'
        done
        admin_rules+="        deny all;"
        info "Admin panel (/admin, /api/admin) restricted to: localhost + $admin_allow_raw"
    else
        admin_rules+="        allow all;"
        warn "Admin panel (/admin, /api/admin) is OPEN to all IPs — admin_allowlist is empty (testing default)."
        warn "  Harden once you have adoption: set \"admin_allowlist\" in $POOL_CONF and re-run 4) Setup nginx."
    fi

    local sites_enabled="/etc/nginx/sites-enabled/$(basename "$POOL_NGINX_CONF")"
    local cert_dir="/etc/letsencrypt/live/$subdomain"
    # The canonical host is the bare domain; www.<domain> 301-redirects to it. The cert
    # must carry www.<domain> as a SAN or the TLS handshake on www fails BEFORE the
    # redirect can run, so every certbot call below requests both names.
    local www_alias="www.$subdomain"

    # Does an existing cert already cover the www alias? (a pre-www install won't —
    # we then certbot --expand below so the www→apex HTTPS block has a valid cert).
    local cert_has_www="no"
    if [[ -f "$cert_dir/fullchain.pem" ]] && command -v openssl &>/dev/null; then
        if openssl x509 -in "$cert_dir/fullchain.pem" -noout -text 2>/dev/null \
             | grep -qi "DNS:$www_alias"; then
            cert_has_www="yes"
        fi
    fi

    # ── Certbot bootstrap (same pattern as 059_lib_nginx) ─────────────────────
    # The HTTPS vhost references the Let's Encrypt cert files, so writing it
    # before the cert exists makes `nginx -t` fail and blocks this whole step.
    # On a fresh box: HTTP-only vhost first → certbot → full SSL vhost below.
    if [[ ! -f "$cert_dir/fullchain.pem" ]]; then
        info "No SSL certificate for $subdomain yet — writing HTTP-only vhost first..."
        cat > "$POOL_NGINX_CONF" << EOF || { rm -f "$sites_enabled"; error "Could not write $POOL_NGINX_CONF"; return 1; }
# GRINIUM Grin Pool — HTTP bootstrap (pre-certbot) — generated by Script 07
server {
    listen 80;
    server_name $subdomain $www_alias;
    root $POOL_WEB_DIR;
    index index.html;

    location /api/ {
        proxy_pass         http://127.0.0.1:$POOL_PORT;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
    location / { try_files \$uri \$uri/ \$uri.html =404; }
}
EOF
        nginx_ensure_sites_enabled_include
        # Same rule as the SSL vhost below (audit §J16-5): never leave an untested
        # vhost enabled. This one is always a fresh enable — the cert does not exist
        # yet, so there was no working pool vhost to preserve.
        ln -sf "$POOL_NGINX_CONF" "$sites_enabled" \
            || { error "could not enable the vhost: $sites_enabled"; return 1; }
        if ! { nginx -t 2>&1 && systemctl reload nginx; }; then
            rm -f "$sites_enabled" \
                || { error "nginx config test failed AND $sites_enabled could not be removed — delete it by hand, a reboot would fail every site on this box."; return 1; }
            error "nginx config test failed. Check $POOL_NGINX_CONF"
            warn "Disabled it again so a reboot cannot take every site on this box down."
            return 1
        fi

        echo ""
        echo -ne "Issue the SSL certificate with certbot now? [Y/n]: "
        local do_ssl; read -r do_ssl
        if [[ "${do_ssl,,}" == "n" ]]; then
            warn "Pool stays HTTP-only until a cert exists — re-run 4) Setup nginx after certbot."
            return 0
        fi
        # Email is auto-defaulted (no prompt) — it's only used for cert-expiry
        # notices and certbot auto-renews via its systemd timer anyway. Change it
        # later with `certbot update_account -m <email>` if you want notices.
        local le_email="admin@$subdomain"
        info "Using Let's Encrypt account email: $le_email"
        if ! certbot --nginx -d "$subdomain" -d "$www_alias" --non-interactive --agree-tos \
                -m "$le_email" 2>&1 | tail -5; then
            warn "certbot failed — check that DNS for $subdomain AND $www_alias point to this server and port 80 is open."
            warn "Pool stays HTTP-only; fix the cause and re-run 4) Setup nginx."
            return 0
        fi
        cert_has_www="yes"
        success "SSL certificate issued (covers $subdomain + $www_alias)."
    elif [[ "$cert_has_www" == "no" ]]; then
        # Cert exists but predates the www alias — expand it so the www→apex redirect
        # presents a valid cert. Best-effort: if DNS for www isn't set yet this fails,
        # and we fall back to an apex-only vhost (no www block) further down.
        info "Existing cert for $subdomain doesn't cover $www_alias — expanding..."
        if certbot --nginx --expand -d "$subdomain" -d "$www_alias" \
                --non-interactive --agree-tos -m "admin@$subdomain" 2>&1 | tail -5; then
            cert_has_www="yes"
            success "Certificate expanded to cover $www_alias."
        else
            warn "Could not expand cert to $www_alias (is its DNS pointed here?)."
            warn "  Skipping the www→apex HTTPS redirect for now — re-run 4) Setup nginx once www DNS resolves."
        fi
    fi

    # Header-snippet paths. Declared HERE, above the first block that references one:
    # $www_https_block is assembled inside a double-quoted assignment, so a path declared
    # further down would expand to the empty string and emit a bare `include ;` (audit
    # §J16-9). The snippets themselves are written a few dozen lines below, next to the
    # comment that explains what goes in each of the three.
    local snippet_dir="/etc/nginx/snippets"
    local hdr_common="$snippet_dir/script07-${POOL_SERVICE}-headers.conf"
    local hdr_page="$snippet_dir/script07-${POOL_SERVICE}-page-headers.conf"
    local hdr_admin="$snippet_dir/script07-${POOL_SERVICE}-admin-headers.conf"

    # certbot --nginx creates options-ssl-nginx.conf; include it only when present
    # (a bare `include` of a missing file is a hard nginx -t error).
    local ssl_extra=""
    [[ -f /etc/letsencrypt/options-ssl-nginx.conf ]] \
        && ssl_extra="include /etc/letsencrypt/options-ssl-nginx.conf;"

    # ── Latency probes (connect page) — see _pool_latency_probe_domain / _pool_latency_hub_host.
    local probe_domain probe_hub_host probe_csp="" probe_hub_block=""
    probe_domain=$(_pool_latency_probe_domain)
    [[ -n "$probe_domain" ]] && probe_csp=" https://*.${probe_domain}"
    probe_hub_host=$(_pool_latency_hub_host)
    if [[ -n "$probe_hub_host" ]]; then
        # Its own certificate, never a SAN on the site's: this name is DNS-only and its cert
        # fails independently (DNS not moved yet during a migration, say) without touching
        # the main site's. Non-fatal on purpose: Migrate IN runs this step before DNS moves.
        if [[ ! -f "/etc/letsencrypt/live/$probe_hub_host/fullchain.pem" ]]; then
            info "latency_hub_url: requesting a certificate for $probe_hub_host..."
            certbot certonly --nginx -d "$probe_hub_host" --cert-name "$probe_hub_host" \
                --non-interactive --agree-tos -m "admin@$subdomain" 2>&1 | tail -3 || true
        fi
        if [[ -f "/etc/letsencrypt/live/$probe_hub_host/fullchain.pem" ]]; then
            probe_hub_block="# Hub latency probe on a DNS-only name (pool.json latency_hub_url): /ping and nothing else.
server {
    listen 443 ssl http2;
    server_name $probe_hub_host;
    server_tokens off;
    limit_req_status 429;
    ssl_certificate     /etc/letsencrypt/live/$probe_hub_host/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$probe_hub_host/privkey.pem;
    $ssl_extra
    access_log off;
    include $hdr_common;
$(_pool_nginx_ping_block "$hdr_common")
    location / { return 404; }
}

"
        else
            warn "No certificate for $probe_hub_host (latency_hub_url), so this hub's /ping is not served there yet."
            warn "  Point $probe_hub_host at this box (DNS-only, no CDN proxy) and re-run 4) Setup nginx."
        fi
    fi

    # www → apex redirect on HTTPS. Only emitted when the cert covers www.<domain>
    # (otherwise serving www on :443 presents a name-mismatched cert). The :80 block
    # below normalises http://www regardless.
    local www_https_block=""
    if [[ "$cert_has_www" == "yes" ]]; then
        www_https_block="server {
    listen 443 ssl http2;
    server_name $www_alias;
    server_tokens off;
    ssl_certificate     /etc/letsencrypt/live/$subdomain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$subdomain/privkey.pem;
    $ssl_extra
    # Audit §J16-9: this is a server block, so it inherits NOTHING from the apex block
    # below — it was the one response on the box with no HSTS, no nosniff and no
    # X-Frame-Options. HSTS is per-HOST, and www.<domain> is a different host to the
    # browser, so without this line the www name is never pinned no matter how long the
    # apex has been. The redirect body is empty; the headers are the point.
    include $hdr_common;
    return 301 https://$subdomain\$request_uri;
}
"
    fi

    # ── Security headers — ONE definition, included by every block that adds a header ──
    # nginx's add_header is NOT additive across configuration levels: "these directives are
    # inherited from the previous level if and only if there are no add_header directives
    # defined on the current level." Both `location /` and `location /admin/` add a
    # Cache-Control of their own, which silently discarded the server-level CSP,
    # X-Frame-Options, nosniff and Referrer-Policy from EVERY public HTML page and from the
    # entire admin panel — the only two surfaces a browser actually renders. The API blocks,
    # which add nothing, were the only ones still protected (audit §I1 (script07_security_audit_archive.md)).
    #
    # Putting the headers in an include makes "add a header here" safe: whoever adds one
    # brings the include along. Two files, because /uploads/ and /custom/ must NOT emit the
    # page CSP — they serve operator-uploaded files and need the restrictive sandbox CSP:
    #   …-headers.conf       common headers, correct on every HTTPS response (incl. HSTS)
    #   …-page-headers.conf  the above + the page Content-Security-Policy
    #
    # /etc/nginx/snippets/ is NOT auto-included by nginx.conf on Debian or Rocky/Alma (only
    # conf.d/ and sites-enabled/ are), so these files apply exactly where they are included
    # and never leak into another vhost. Putting add_header in conf.d/ would apply it to the
    # whole http context, i.e. to every site on the box.
    # (paths declared above, before $www_https_block referenced $hdr_common)
    mkdir -p "$snippet_dir" || { error "could not create $snippet_dir"; return 1; }

    cat > "$hdr_common" << 'HDREOF' || { error "could not write $hdr_common"; return 1; }
# Generated by Script 07 (pool_setup_nginx) — DO NOT EDIT, re-run "Setup nginx" instead.
# Common security headers. Include this from EVERY block that declares an add_header of its
# own, otherwise that block silently drops the whole inherited set. HSTS is safe here because
# this file is only ever included from the :443 server — never from the :80 redirect vhost.
#
# HSTS carries NO includeSubDomains and NO preload, deliberately. `subdomain` in pool.json is
# frequently the operator's APEX domain (the vhost derives www.<subdomain> from it and treats
# the bare domain as canonical), so includeSubDomains would pin EVERY sibling host on that
# domain — an api./testapi./status. box the pool does not own — to HTTPS for a year. Browsers
# cache that directive for the full max-age, so removing the header later does not undo it:
# an http-only or bad-cert sibling stays unreachable until max-age expires. The protection
# gained applies only to hosts this script never deploys; the blast radius is the operator's
# whole domain. Add it by hand only on a host you know is a dedicated subdomain.
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Strict-Transport-Security "max-age=31536000" always;
HDREOF

    cat > "$hdr_page" << HDREOF || { error "could not write $hdr_page"; return 1; }
# Generated by Script 07 (pool_setup_nginx) — DO NOT EDIT, re-run "Setup nginx" instead.
# Common headers + the page CSP. For blocks that serve HTML/JS/CSS. NOT for /uploads/ or
# /custom/, which need the restrictive sandbox CSP instead.
#
# CSP must permit: the managed analytics providers' script + beacon hosts, and Google Fonts.
# It does NOT permit inline script (script-src has no 'unsafe-inline' since 2026-10-12, refactor
# F7): every page script is an external file and branding.js runs GA's init as direct JS, so an
# injected <script> or on*= handler in operator HTML is blocked, not run. Self-hosted Plausible/Umami/
# Matomo on a custom domain require adding that domain to script-src and connect-src.
#
# https://cdn.jsdelivr.net was removed from script-src on 2026-09-03 (audit §J15-6). It was a
# leftover from before Chart.js was vendored: a sweep of all thirteen public pages and every
# file under public_html/js/ found ZERO references to it. This is the same argument §J14-4 made
# for the admin panel, and it applies here for a stronger reason — the public origin serves
# account-settings.html, the withdrawal form, and §B accepts that operator HTML can inject
# script into these pages. An unused third-party script origin in the CSP is a ready loader for
# exactly that. The four analytics origins stay: unlike jsdelivr they are reachable by design
# whenever an operator switches a provider on.
#
# frame-ancestors / base-uri / form-action / object-src added 2026-09-03 (audit §J16-11).
# §J14 and §J15 both left this open as "J16's call" because only the admin snippet carried
# them. The call is yes, and for a stronger reason than symmetry: §B accepts that operator
# HTML can inject script into these pages, and this origin serves account-settings.html —
# the withdrawal form and the rig-password box. Each directive shuts a sink that 'self' does
# not: base-uri stops an injected <base> re-pointing every relative script/API URL off-site;
# form-action stops the withdrawal form being re-targeted; object-src kills the plugin
# loader; frame-ancestors is the CSP form of the X-Frame-Options: DENY already in
# \$hdr_common, and unlike XFO it is honoured for nested frames. All four are verified
# compatible: no public page frames another, declares a <base>, posts a form cross-origin,
# or embeds an <object>/<embed> — the pages talk to same-origin /api/ over fetch only.
#
# connect-src also carries https://*.${probe_domain:-<none>} (added 2026-09-23): the connect page times
# https://<gateway>/ping on each regional gateway. It is the pool's OWN domain, derived from
# pool.json subdomain, or the parent in latency_probe_domain that the operator explicitly
# declared. It is never computed wider, because a wildcard over a public suffix would give
# injected script a destination on any host under it. HTTPS only, default port only.
include $hdr_common;
add_header Content-Security-Policy "default-src 'self'; script-src 'self' https://www.googletagmanager.com https://plausible.io https://cloud.umami.is; connect-src 'self'${probe_csp} https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com https://plausible.io https://cloud.umami.is; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://*.google-analytics.com https://*.googletagmanager.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none';" always;
HDREOF

    # Third snippet: the ADMIN panel CSP (audit §J14-4). /admin/ is served as STATIC files by
    # nginx, so the Express security-header middleware never runs for an admin HTML page —
    # whatever this vhost sends IS the admin panel's CSP. It must not send $hdr_page, the
    # PUBLIC one, which allowlists four third-party script origins and five connect-src
    # origins the panel does not use. Two layers now stand against XSS in this panel: script-src
    # has no 'unsafe-inline' (refactor F7 — every admin page script is an
    # external /admin/js/<page>.js, so an injected <script> or on*= handler does not run), and
    # connect-src 'self' leaves a script that does run no silent exfiltration destination for
    # the admin session, the miner ledger or an in-flight TOTP secret.
    #
    # Every asset all admin pages load is same-origin (chart.js and quill are vendored under
    # /js/vendor/), so nothing here needs widening. One directive is load-bearing:
    #   data: in img-src — the 2FA enrolment QR is generated client-side.
    # Deliberately NOT blob: — the Donors review queue (design §18.11 in script07_implementation.md, Donors review) loads banner
    # previews from a plain same-origin src, which keeps the image route's sandbox headers.
    cat > "$hdr_admin" << HDREOF || { error "could not write $hdr_admin"; return 1; }
# Generated by Script 07 (pool_setup_nginx) — DO NOT EDIT, re-run "Setup nginx" instead.
# Common headers + the ADMIN CSP. Include this from /admin/ ONLY. Do not use it for public
# pages (they legitimately need the analytics + Google Fonts hosts) and do not point /admin/
# at the page snippet instead — see audit §J14-4.
include $hdr_common;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none';" always;
HDREOF

    info "Writing nginx vhost (${POOL_NET_LABEL}): $POOL_NGINX_CONF"
    local ping_block; ping_block=$(_pool_nginx_ping_block "$hdr_page")
    # UNQUOTED heredoc (it needs the ${…} expansions), so a backtick anywhere in the next
    # ~270 lines — nginx comments included — is a command substitution: three comments here
    # once ran 'trust', 'public' and 'try_files' as shell commands on every 4) Setup nginx.
    # Quote a config keyword with '…', or escape the backtick as \` (see x-powered-by below).
    cat > "$POOL_NGINX_CONF" << EOF || { error "Could not write $POOL_NGINX_CONF — the file on disk may be incomplete; fix it before any nginx restart."; return 1; }
# GRINIUM Grin Pool — ${POOL_NET_LABEL} — generated by Script 07 (pool_setup_nginx)
# Rate-limit zones live in /etc/nginx/conf.d/script07-${POOL_SERVICE}.conf

# HTTP → HTTPS, and www → apex (canonical host is the bare domain)
server {
    listen 80;
    server_name $subdomain $www_alias;
    return 301 https://$subdomain\$request_uri;
}

${www_https_block}${probe_hub_block}server {
    listen 443 ssl http2;
    server_name $subdomain;
$cf_realip_include

    # Audit §J11-6 (nginx half): drop nginx's version from the Server: header and from
    # its own error pages. The Express half (\`x-powered-by\`) was closed in that pass;
    # this was the remaining banner, and the pool's was the only toolkit vhost without it.
    server_tokens off;
    # Audit §J16-10: nginx answers limit_req with 503 by default — the SAME status a dead
    # backend returns, so a throttled visitor and an outage are indistinguishable in the
    # access log and to the front end. 429 is what the app's own limiter returns and what
    # public-shell.js / Auth.read already understand (§J15-2). Script 02 already sets this.
    limit_req_status 429;

    root $POOL_WEB_DIR;
    index index.html;

    # SSL — managed by certbot
    ssl_certificate     /etc/letsencrypt/live/$subdomain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$subdomain/privkey.pem;
    $ssl_extra

    # Security headers + page CSP. Defined once in $hdr_page (see pool_setup_nginx).
    # ⚠ Any location below that declares an add_header of its own DISCARDS this whole set —
    # it MUST re-include the snippet. That is why /admin/, / , /uploads/ and /custom/ all
    # carry an include line. See audit §I1 before adding a header anywhere in this file.
    include $hdr_page;

    # ── Admin panel + admin API. Network gate is OPEN by default (empty admin_allowlist
    # → allow all) for the testing phase; app-layer JWT + captcha + lockout + auto-ban +
    # optional TOTP still apply. Harden by setting admin_allowlist in $POOL_CONF (locks to
    # localhost + listed IPs/CIDRs), then re-run 4) Setup nginx. See $admin_rules above.
    location = /admin { return 301 https://\$host/admin/; }
    location /admin/ {
$admin_rules
        # Dedicated _admin zone (120r/m): the admin panel is a polling dashboard that pulls
        # several assets + API calls per page, so it must NOT share the public _static/_api
        # budgets (a few fast clicks there used to 503 admin-shell.js → blank sidebar).
        limit_req zone=${POOL_SERVICE}_admin burst=40 nodelay;
        # SERVER-SIDE auth gate (kills the "flash of admin page → redirect" UX bug):
        # subrequest the backend before serving ANY admin file. The static HTML is an
        # empty shell (data comes from authenticated /api/admin/* calls), but rendering
        # it for a logged-out visitor looked broken. auth_request makes nginx withhold
        # the page entirely until /api/admin/_authcheck returns 2xx; a 401/403 is caught
        # by error_page → @admin_login → redirect to /login.html, so the browser never
        # receives admin markup unauthenticated. The client-side API.guardAdminPage()
        # remains as a fallback for installs whose nginx predates this block.
        auth_request /admin/_authcheck;
        error_page 401 403 = @admin_login;
        # No content hashing on these static pages, so tell browsers to revalidate
        # every load (304 when unchanged). Without this, browsers heuristically cache
        # the HTML and keep showing the OLD admin panel after a redeploy.
        # ⚠ This add_header resets header inheritance — the include is what keeps the
        # admin panel's CSP + X-Frame-Options alive. Never drop it (audit §I1), and keep it
        # pointed at $hdr_admin, NOT $hdr_page: this panel must not inherit the public
        # page's third-party script/connect allowlist (audit §J14-4).
        include $hdr_admin;
        add_header Cache-Control "no-cache" always;
        try_files \$uri \$uri/ \$uri.html =404;
    }
    # Internal target for the auth_request above — never reachable directly (internal).
    # No network gate / rate limit here: the parent /admin/ already applied \$admin_rules,
    # and the backend handler deliberately skips the admin brute-force budget so per-asset
    # subrequests stay cheap. Strip the body (we only care about the status code).
    location = /admin/_authcheck {
        internal;
        proxy_pass              http://127.0.0.1:$POOL_PORT/api/admin/_authcheck;
        proxy_pass_request_body off;
        proxy_set_header        Content-Length "";
        proxy_set_header        Host \$host;
        proxy_set_header        X-Real-IP \$remote_addr;
        proxy_set_header        X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
    # Unauthenticated visitors to /admin/* land on the public login door, not a 401 page.
    location @admin_login { return 302 https://\$host/login.html; }
    location /api/admin/ {
$admin_rules
        limit_req zone=${POOL_SERVICE}_admin burst=40 nodelay;
        # CMS media upload (POST /api/admin/media) accepts images up to 5 MB; nginx's 1 MB
        # default would 413 them before they reach the app. 6m leaves multipart overhead.
        client_max_body_size 6m;
        proxy_pass         http://127.0.0.1:$POOL_PORT;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        # Must cover the longest admin action: POST /api/admin/gateways/server gives
        # grin-gateway-ctl init-server a 180 s exec budget (design §13.12 — it may run
        # apt on a box that missed pool_ensure_wg_prereqs). At the old 30 s nginx 504'd
        # the browser while the helper kept running, so the panel said "Enable failed"
        # about a tunnel that came up seconds later. This block is IP-allowlisted and
        # authenticated, so a long-held connection here costs nothing on the public side.
        proxy_read_timeout 200s;
    }

    # The CAPTCHA challenge is a read-only GET the login page fetches on load, on
    # form-toggle, and after every failed attempt — it gets its OWN dedicated zone.
    # It must NOT share the strict _auth brute-force budget (retry can't recover),
    # AND must NOT share _static either: that zone is keyed per-IP and consumed by every
    # CSS/JS/font/image on every page (a dozen+ per load), so a few page reloads during
    # testing starve the captcha → "Verification unavailable" and "↻ new" does nothing →
    # captcha_id stays null → the login POST is rejected at the captcha gate and you can
    # never log in. Its own zone keeps it lit regardless of asset traffic. This is NOT the
    # brute-force vector (the login POST stays on _auth 10r/m + per-account lockout + IP
    # auto-ban); issuing a fresh arithmetic challenge is a cheap in-memory op, so a
    # generous, isolated rate is safe. Exact-match wins over the /api/auth/ prefix.
    location = /api/auth/captcha {
        limit_req zone=${POOL_SERVICE}_captcha burst=20 nodelay;
        proxy_pass         http://127.0.0.1:$POOL_PORT;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
    }

    location /api/auth/ {
        limit_req zone=${POOL_SERVICE}_auth burst=5 nodelay;
        proxy_pass         http://127.0.0.1:$POOL_PORT;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
    }


    # burst=40, was 10 (2026-09-25). The homepage fires ~13 /api/ reads on load and ~10 on
    # every 60 s refresh, all at once; burst 10 admits only 11, so the LAST reads of the batch
    # (payments, both trend charts) drew 429s from ordinary single visitors — confirmed in the
    # hub's error.log as 'excess: 11.000 by zone "…_api"', which lit "Payouts · feed down".
    # The sustained rate (the zone's 600r/m) is unchanged; only the instantaneous fan-out grows.
    #
    # burst=100 on the general /api/ block, was 40 (2026-09-26). The live hub was still on 10
    # (its vhost predated the bump above) and its access log showed the same cut from a single
    # iPhone: ~11 of ~19 homepage reads admitted per reload, effort/blocks/payments/both trend
    # reads 429'd, the cards sitting empty until the next 60 s refresh. 40 covers ~2 loads back
    # to back; a visitor pulling-to-refresh fires more than that. 100 is ~5 loads at once and
    # still drains in 10 s at the unchanged 600r/m, so it buys no SUSTAINED throughput — and
    # the app's own 'public' bucket (1200/min/IP) sits behind it either way. Per IP, so it is
    # not a pool-size knob: 1000 miners are 1000 buckets. The withdraw POST keeps 40 — one
    # money request per click has no fan-out to absorb.
    #
    # The withdraw POST alone gets 90 s (2026-09-26). A Tor payout request runs the pre-flight
    # probe of the miner's onion first, up to ~32 s at the defaults (two attempts, 8 s connect +
    # 8 s reply each). At the 30 s below nginx answered 504 while the gate was still deciding, and
    # the miner saw "Withdrawal failed" and had to retry (safe: the app creates nothing once the
    # client is gone). Same zone, upstream and headers as /api/ - and NO add_header, so the
    # server-level security headers still apply. Every other /api/ read keeps 30 s.
    location ~ ^/api/account/[^/]+/withdraw\$ {
        limit_req zone=${POOL_SERVICE}_api burst=40 nodelay;
        proxy_pass         http://127.0.0.1:$POOL_PORT;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 90s;
    }

    location /api/ {
        limit_req zone=${POOL_SERVICE}_api burst=100 nodelay;
        proxy_pass         http://127.0.0.1:$POOL_PORT;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }

    # SEO / PWA files generated dynamically from admin settings (proxied to the app).
    # Exact-match so they take priority over any static file of the same name.
    #
    # ⚠ These four MUST forward the client IP and MUST carry a zone. Audit §J12-3: they were
    # the only proxied locations with neither. Without X-Forwarded-For, 'trust proxy=loopback'
    # leaves req.ip as nginx's 127.0.0.1, so the app's per-IP 'public' bucket became ONE bucket
    # shared by every visitor on Earth — ~1200 requests from a single host put all four into a
    # rolling lockout for everyone, Googlebot included, and a sustained 429 on robots.txt reads
    # as "do not crawl this site". With no limit_req here, nothing slowed that down either.
    # /sitemap.xml also runs three DB queries per hit. Same treatment as = /page.html below,
    # which already documents the trap.
    location = /robots.txt {
        limit_req zone=${POOL_SERVICE}_static burst=20 nodelay;
        proxy_pass         http://127.0.0.1:$POOL_PORT;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
    location = /sitemap.xml {
        limit_req zone=${POOL_SERVICE}_static burst=20 nodelay;
        proxy_pass         http://127.0.0.1:$POOL_PORT;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
    location = /manifest.json {
        limit_req zone=${POOL_SERVICE}_static burst=20 nodelay;
        proxy_pass         http://127.0.0.1:$POOL_PORT;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
    # Blog RSS is generated by the app (not a static file).
    location = /blog/rss.xml {
        limit_req zone=${POOL_SERVICE}_static burst=20 nodelay;
        proxy_pass         http://127.0.0.1:$POOL_PORT;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
    }

    # CMS content pages (About / Terms / Privacy / FAQ). page.html IS a static file, but it
    # is a JS shell that fetches its content and sets the title client-side — so served
    # straight from disk it hands every social crawler a page titled "Loading…". The app
    # serves the SAME file with <title>/description/og:* already filled in for ?p=<key>.
    # Forwards the client IP, unlike the SEO-file proxies above: this one is a real page a
    # visitor loads, and the app rate-limits it per IP — without these headers every visitor
    # would share nginx's single 127.0.0.1 bucket.
    # CSP: the app sets its own CSP on every response, and a browser enforces EVERY CSP
    # header it receives - so passed through, the app's narrower policy (no analytics or
    # Google-font host) was intersected with the page policy on this page alone, silently
    # blocking both. It is hidden here, together with any Report-Only header (the app sent a
    # Report-Only twin until refactor F7; hiding it keeps an older backend behind this vhost
    # clean), and this block adds no header of its own, so it inherits the server-level
    # page snippet: the same headers the file gets when served from disk. Same for /blog/ below.
    location = /page.html {
        proxy_pass         http://127.0.0.1:$POOL_PORT;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_hide_header  Content-Security-Policy;
        proxy_hide_header  Content-Security-Policy-Report-Only;
    }

    # CMS media (cover images + in-body images uploaded via the admin editor). Stored in a
    # persistent dir OUTSIDE public_html so the DOCROOT redeploy (rsync --delete in
    # pool_deploy_web) never wipes them. That placement does NOT protect it from the
    # BACKEND rsync, which --deletes POOL_APP_DIR itself — it is safe only because
    # pool_deploy_code / pool_install exclude it by name.
    # Same SVG hardening as /custom/: nosniff + sandbox CSP neutralises any
    # script in a directly-opened SVG; correct image MIME types are kept for <img> rendering.
    location /uploads/ {
        alias $POOL_APP_DIR/uploads/;
        # Common headers from the shared snippet (it already carries nosniff), then the
        # RESTRICTIVE CSP that replaces the page one — this path serves operator-uploaded
        # files, so an SVG opened directly must not be able to run script.
        include $hdr_common;
        add_header Content-Security-Policy "default-src 'none'; style-src 'unsafe-inline'; sandbox" always;
        add_header Cache-Control "public, max-age=604800, immutable" always;
        try_files \$uri =404;
    }

    # Operator-uploaded white-label assets (served from assets_dir in pool.json).
    # Uploads are magic-byte validated and given server-controlled names, but we still
    # harden the serving side: nosniff stops a mislabelled file being reinterpreted, and
    # the sandbox CSP neutralises any script inside an SVG opened directly. Correct image
    # MIME types are kept (via the default mime.types) so logos/icons still render.
    location /custom/ {
        alias $POOL_APP_DIR/custom_assets/;
        # Same treatment as /uploads/ — shared common headers, then the sandbox CSP.
        include $hdr_common;
        add_header Content-Security-Policy "default-src 'none'; style-src 'unsafe-inline'; sandbox" always;
        add_header Cache-Control "public, max-age=604800" always;
        try_files \$uri =404;
    }

    # Clean blog-post permalinks: /blog/<slug>. This used to 'try_files /post.html', i.e.
    # serve the static JS shell, which meant a shared post link unfurled as "Loading…" on
    # every platform that doesn't run JavaScript (Twitter/Facebook/Discord/Telegram/Slack) —
    # and those URLs are all in sitemap.xml. Now proxied to the app, which serves the very
    # same post.html with <title>, description and og:* rendered in first; the page's own
    # script still runs and fills the body exactly as before.
    # The exact-match "location = /blog/rss.xml" above wins over this regex, and the blog
    # index /blog.html doesn't match (no slash after "blog"). Slug charset mirrors slugify()
    # in lib/posts.js (lowercase alnum + hyphen); underscores allowed for safety.
    # The app's own CSP pair is hidden for the reason given at page.html above; no add_header
    # here, so the server-level page snippet applies.
    location ~ ^/blog/([A-Za-z0-9_-]+)/?\$ {
        limit_req zone=${POOL_SERVICE}_static burst=100 nodelay;
        proxy_pass         http://127.0.0.1:$POOL_PORT;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_hide_header  Content-Security-Policy;
        proxy_hide_header  Content-Security-Policy-Report-Only;
    }

${ping_block}

    # ── /play/ games platform (design §19.12) ────────────────────────────────────
    # The pool's internal games routes (/internal/games/*, secret-guarded, loopback only)
    # are NEVER reachable through nginx: no location here proxies them, and this explicit
    # 404 is the second control (the app's own guard is the third).
    location ^~ /internal/ { return 404; }
    # The /play/ locations live in a snippet written by menu P → 3 (07_lib_pool_games.sh).
    # A GLOB include that matches no file is not an error in nginx, so this line is safe
    # on a box where the games were never installed — verified at VPS checkpoint A.
    include /etc/nginx/snippets/script07-${POOL_SERVICE}-games-*.conf;

    location / {
        # Generous burst: a single page load pulls the HTML + ~a dozen assets (CSS, JS
        # incl. public-shell.js which injects the header/nav, fonts, images), and with
        # Cache-Control:no-cache each navigation revalidates them — so fast multi-page
        # browsing legitimately fires many requests in a few seconds. Throttling here
        # only broke the page (plain HTML, no CSS, lost nav); it is not a DoS surface.
        limit_req zone=${POOL_SERVICE}_static burst=100 nodelay;
        # Pages/assets carry no content hash, so a far-future cache would serve stale
        # HTML/JS after a redeploy (the classic "/ and /index.html differ", "old nav",
        # "old admin" confusion — really browser cache). no-cache = store but always
        # revalidate, so a deploy is picked up immediately while unchanged files 304.
        # ⚠ This add_header resets header inheritance. The include is what keeps the CSP +
        # X-Frame-Options on EVERY public page (this block serves them all). See audit §I1.
        include $hdr_page;
        add_header Cache-Control "no-cache" always;
        try_files \$uri \$uri/ \$uri.html =404;
    }

    access_log /var/log/nginx/${POOL_SERVICE}-access.log;
    error_log  /var/log/nginx/${POOL_SERVICE}-error.log;
}
EOF

    nginx_ensure_sites_enabled_include
    # ⚠ Audit §J16-5. Enabling BEFORE the test, and leaving it enabled when the test
    # fails, makes a bad vhost outlive this function: `nginx -t` catches it, we print an
    # error and return — and the broken file stays symlinked into sites-enabled. The
    # running nginx is fine (the reload never happened), so nothing looks wrong until the
    # NEXT start, which is a reboot or a certbot renewal hook — and then nginx refuses to
    # start at all and EVERY vhost on the box goes down, not just the pool's. The most
    # likely trigger is not a generator bug: `admin_allowlist` is a hand-edited pool.json
    # string spliced straight into `allow <entry>;`, so one typo does this.
    # `ln -sf` failure is not swallowed — a failed symlink leaves `nginx -t`
    # passing (it was testing WITHOUT this vhost) and "nginx configured for …" printing
    # over a site that was never enabled.
    local _was_enabled=0
    [[ -L "$sites_enabled" || -f "$sites_enabled" ]] && _was_enabled=1
    ln -sf "$POOL_NGINX_CONF" "$sites_enabled" \
        || { error "could not enable the vhost: $sites_enabled"; return 1; }

    if nginx -t 2>&1 && systemctl reload nginx; then
        success "nginx configured for https://$subdomain"
    else
        error "nginx config test failed. Check $POOL_NGINX_CONF"
        if (( _was_enabled )); then
            warn "Leaving the previous symlink in place — the vhost was already enabled."
            warn "  It is INVALID on disk: fix it before any reboot or nginx restart."
        else
            rm -f "$sites_enabled" \
                || { error "Could not remove $sites_enabled — delete it by hand, a reboot would fail every site on this box."; return 1; }
            warn "Disabled the new vhost again ($sites_enabled removed) so a reboot"
            warn "  cannot take every site on this box down with it. Fix and re-run 4)."
        fi
        return 1
    fi

    # What the connect page may time (lib/latency-probe.js publishes the same answer).
    if [[ -n "$probe_domain" ]]; then
        info "Latency probes: the connect page may time https://*.${probe_domain}/ping (gateway menu 6)."
    fi
    if [[ -z "$probe_hub_host" && -n "$(pool_read_conf "latency_hub_url" "")" ]]; then
        warn "latency_hub_url is ignored: it must be https://<name under ${probe_domain:-the pool domain}>/ping,"
        warn "  and not the site's own name (that one is already served at /ping)."
    fi
    if [[ -n "$probe_hub_block" ]]; then
        info "  This hub (direct) is timed at https://${probe_hub_host}/ping."
    elif [[ "$cf_proxy" == "true" ]]; then
        echo -e "  ${DIM}This hub (direct) is not timed: behind the CDN proxy, /ping would time the CDN's edge.${RESET}"
        echo -e "  ${DIM}Set latency_hub_url in $POOL_CONF to https://<a DNS-only name for this box>/ping${RESET}"
        echo -e "  ${DIM}(e.g. this hub region's stratum host) and re-run 4). The page estimates direct until then.${RESET}"
    fi

    if [[ "$cf_proxy" == "true" ]]; then
        echo ""
        info "Cloudflare proxy mode is ON — real visitor IPs are restored from CF-Connecting-IP."
        echo -e "  ${DIM}In Cloudflare DNS, set this record to ${RESET}Proxied (orange cloud)${DIM}.${RESET}"
        echo -e "  ${YELLOW}Harden (recommended):${RESET} so attackers can't bypass Cloudflare by hitting"
        echo -e "  the origin IP directly, allow 80/443 ONLY from Cloudflare ranges. Example (ufw):"
        echo -e "    ${DIM}for ip in \$(curl -s https://www.cloudflare.com/ips-v4) \$(curl -s https://www.cloudflare.com/ips-v6); do${RESET}"
        echo -e "    ${DIM}  ufw allow from \"\$ip\" to any port 443 proto tcp; ufw allow from \"\$ip\" to any port 80 proto tcp; done${RESET}"
        echo -e "  ${DIM}Keep your SSH port open separately, then 'ufw deny 80,443' from everywhere else.${RESET}"
        echo -e "  ${DIM}Also turn OFF any Cloudflare 'Cache Everything' page rule for HTML (the origin${RESET}"
        echo -e "  ${DIM}sends Cache-Control: no-cache so deploys show up immediately).${RESET}"
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# 1b) FAIL2BAN — brute-force protection for the admin login endpoint (run by Install)
# ═══════════════════════════════════════════════════════════════════════════════
#
# A wrong password makes the pool return HTTP 401 on POST /api/auth/login, which nginx
# records in its combined-format access log with the real client IP first. This jail bans
# an IP after repeated 401s on that path. It is defence-in-depth ON TOP of the app's own
# rate limiter (rateLimiter('auth')) and the nginx ${POOL_SERVICE}_auth limit_req zone —
# fail2ban adds a firewall-level ban so a brute-forcer can't keep probing at all.

pool_setup_fail2ban() {
    echo -e "\n${BOLD}Fail2ban — Admin Login Brute-Force Protection${RESET}\n"

    local access_log="/var/log/nginx/${POOL_SERVICE}-access.log"
    local filter="/etc/fail2ban/filter.d/grin-pool-login.conf"
    local jail="/etc/fail2ban/jail.d/grin-pool.conf"

    # Thresholds are operator-tunable in grin_pubpool.json (seeded by pool_ensure_defaults).
    # Read them here and guard against non-numeric / blank edits so a typo can't produce a
    # broken jail file — falling back to the 10 / 15 min / 10 d defaults.
    #
    # ONE set of defaults, used for both "key absent from grin_pubpool.json" and "key present
    # but not a plain integer". The two sets must never differ (5 / 600 / 3600 vs 10 / 900 / 864000 once did):
    # pool_ensure_defaults only seeds keys from pool_install / pool_configure, so an operator
    # who upgraded the toolkit and ran ONLY this menu step got the old 5-in-10-min policy while
    # every comment and the settings screen claimed 10-in-15-min. Silent, and invisible on the
    # written jail file unless you knew the intended numbers.
    local maxretry findtime bantime
    maxretry=$(pool_read_conf "fail2ban_maxretry" "10")
    findtime=$(pool_read_conf "fail2ban_findtime" "900")
    bantime=$(pool_read_conf  "fail2ban_bantime"  "864000")
    [[ "$maxretry" =~ ^[0-9]+$ ]] && (( maxretry >= 1 )) || maxretry=10
    [[ "$findtime" =~ ^[0-9]+$ ]] && (( findtime >= 60 )) || findtime=900
    # Floor the ban at 60 s. `^[0-9]+$` accepts "0", and fail2ban reads bantime = 0 as a
    # PERMANENT ban — which the dbpurgeage arithmetic below would then set to 2 days, quietly
    # turning "forever" into 48 h. A permanent ban is not reachable through this conf anyway
    # (fail2ban spells it -1, which the regex rejects), so treat 0 as the typo it is.
    [[ "$bantime"  =~ ^[0-9]+$ ]] && (( bantime  >= 60 )) || bantime=864000

    # 1) Ensure fail2ban is present.
    if ! command -v fail2ban-client &>/dev/null; then
        info "Installing fail2ban..."
        if command -v apt-get &>/dev/null; then
            apt-get install -y fail2ban 2>&1 | tail -5
        elif command -v dnf &>/dev/null; then
            # RHEL-family ships fail2ban via EPEL.
            dnf install -y epel-release 2>&1 | tail -3 || true
            dnf install -y fail2ban 2>&1 | tail -5
        fi
    fi
    if ! command -v fail2ban-client &>/dev/null; then
        error "fail2ban not installed (enable EPEL on RHEL-family, then re-run this step)."
        return 1
    fi

    # 2) Filter — matches ONLY a failed login. Successful logins are 200 and never match;
    #    the real attacker IP is the <HOST> token at the start of each combined-log line.
    cat > "$filter" << 'EOF' || { error "Could not write $filter"; return 1; }
# Fail2ban filter — Grin pool admin login (auto-generated by Script 07; safe to edit).
# Line shape: <ip> - - [time] "POST /api/auth/login HTTP/x.x" 401 ...
[Definition]
failregex = ^<HOST> -[^"]*"POST /api/auth/login(?:\?\S*)? HTTP/[^"]+" 401\b
ignoreregex =
EOF
    success "Filter written: $filter"

    # 3) Jail — 10 failed logins within 15 min → 10-day ban (defaults). Lives under jail.d/ so it never
    #    clobbers an operator jail.local; banaction is inherited from the distro [DEFAULT]
    #    (iptables/nftables/firewalld) for portability. Loopback is never banned so the
    #    local nginx proxy hop and on-box health checks stay unaffected.
    cat > "$jail" << EOF || { error "Could not write $jail"; return 1; }
[grin-pool-login]
enabled  = true
filter   = grin-pool-login
port     = http,https
logpath  = $access_log
backend  = auto
maxretry = $maxretry
findtime = $findtime
bantime  = $bantime
ignoreip = 127.0.0.1/8 ::1
EOF
    success "Jail written: $jail"

    # 3b) Ban persistence. fail2ban forgets bans older than `dbpurgeage` (Debian default
    #     1 day) whenever the fail2ban service restarts — so with a multi-day bantime the
    #     ban silently evaporates on the next package upgrade or reboot. Raise it past the
    #     bantime (+2 days of slack) so a long ban is actually served.
    #     Written as a fail2ban.d/ drop-in, mirroring the jail.d/ pattern above: editing
    #     fail2ban.conf gets clobbered by package upgrades, and appending to a shared
    #     fail2ban.local risks landing the key in the wrong [section].
    local purge_conf="/etc/fail2ban/fail2ban.d/grin-pool-dbpurgeage.conf"
    local dbpurgeage=$(( bantime + 172800 ))
    mkdir -p /etc/fail2ban/fail2ban.d || { error "Could not create /etc/fail2ban/fail2ban.d"; return 1; }
    cat > "$purge_conf" << EOF || { error "Could not write $purge_conf"; return 1; }
# Auto-generated by Script 07. Keeps banned IPs in fail2ban's DB at least as long as the
# grin-pool-login bantime ($bantime s), so bans survive a fail2ban restart.
[Definition]
dbpurgeage = $dbpurgeage
EOF
    success "Ban persistence: dbpurgeage = ${dbpurgeage}s ($purge_conf)"

    # 4) The log must exist or the jail won't start. nginx creates it on first request;
    #    pre-create it (root-owned, like nginx) so the jail starts cleanly right now.
    [[ -f "$access_log" ]] || { mkdir -p /var/log/nginx && : > "$access_log"; } \
        || { error "Could not create $access_log — the fail2ban jail would not start."; return 1; }

    # 5) Enable + (re)start and confirm the jail came up.
    systemctl enable fail2ban 2>/dev/null || true
    if systemctl restart fail2ban; then
        success "fail2ban restarted."
    else
        error "fail2ban failed to restart. Inspect: journalctl -u fail2ban -n 30"
        return 1
    fi

    sleep 1
    if fail2ban-client status grin-pool-login &>/dev/null; then
        success "Jail 'grin-pool-login' is active."
        echo ""
        echo -e "  ${DIM}Rule:   ${maxretry} failed logins / ${findtime}s  →  ${bantime}s ban  (edit fail2ban_* in grin_pubpool.json, then re-run 1) Install)${RESET}"
        echo -e "  ${DIM}Status: fail2ban-client status grin-pool-login${RESET}"
        echo -e "  ${DIM}Unban:  fail2ban-client set grin-pool-login unbanip <IP>${RESET}"
        echo -e "  ${DIM}Test:   fail2ban-regex $access_log $filter${RESET}"
    else
        warn "Jail not reporting active yet. Verify: fail2ban-client status grin-pool-login"
    fi
}
