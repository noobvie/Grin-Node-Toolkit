# =============================================================================
# Shared Nginx Library — Grin Node Toolkit
# Part of: https://github.com/noobvie/grin-node-toolkit
# =============================================================================
#
# PURPOSE
#   Central nginx helpers used by scripts that manage nginx vhosts/sites:
#     · Script 02 — Nginx File Server Manager
#     · Script 04 — Grin Node Foreign API
#     · Script 06 — Global Grin Health
#     · Script 07 — Mining Services / Pool
#     · Script 052 — Grin Drop
#
#   Lib files are sourced, not executed — no shebang. Functions are prefixed
#   `nginx_` to avoid collisions with script-specific helpers. The historical
#   name `_ensure_sites_enabled_include` is kept as a wrapper so existing
#   call sites don't need to change.
#
# CONVENTIONS
#   · Logging functions (info, warn, error, success) are expected to be defined
#     by the caller BEFORE sourcing this file. Fallbacks are provided below in
#     case the caller hasn't defined them yet.
#   · No `set -e` here — caller controls error semantics. Each function
#     returns 0 on success, non-zero on failure.
# =============================================================================

# Guard against double-sourcing
[[ -n "${_NGINX_SHARED_HELPERS_LOADED:-}" ]] && return 0
_NGINX_SHARED_HELPERS_LOADED=1

# ─── Fallback logging (only defined if caller hasn't already) ────────────────
type info    >/dev/null 2>&1 || info()    { echo "[INFO]  $*"; }
type warn    >/dev/null 2>&1 || warn()    { echo "[WARN]  $*" >&2; }
type error   >/dev/null 2>&1 || error()   { echo "[ERROR] $*" >&2; }
type success >/dev/null 2>&1 || success() { echo "[OK]    $*"; }

# ═════════════════════════════════════════════════════════════════════════════
# CORE: ensure include /etc/nginx/sites-enabled/*; is inside the http {} block
# ═════════════════════════════════════════════════════════════════════════════
# Required on:
#   · RHEL/Rocky/Alma — their default nginx.conf has no sites-enabled at all
#   · After any nginx package upgrade that resets /etc/nginx/nginx.conf
# Idempotent — safe to call on every setup. If the include is already correctly
# placed inside http {}, this is a no-op.
nginx_ensure_sites_enabled_include() {
    local nginx_conf="/etc/nginx/nginx.conf"
    mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled

    # Skip silently if nginx isn't installed yet — caller may be running us
    # before the install step (e.g. Script 02 calls this in ensure_nginx_certbot
    # before installing nginx). Once nginx is installed, a later call will fix it.
    [[ -f "$nginx_conf" ]] || return 0

    if grep -q "sites-enabled" "$nginx_conf" 2>/dev/null; then
        # Include exists somewhere — verify it's inside http {}, not at top level
        python3 - "$nginx_conf" << 'PYEOF'
import sys, re
with open(sys.argv[1]) as fh:
    txt = fh.read()
m = re.search(r'\bhttp\s*\{', txt)
if not m:
    sys.exit(0)  # malformed — let nginx -t catch it
http_start = m.end()
depth = 1; i = http_start
while i < len(txt) and depth > 0:
    if txt[i] == '{': depth += 1
    elif txt[i] == '}': depth -= 1
    i += 1
if 'sites-enabled' in txt[http_start:i-1]:
    sys.exit(0)  # already correctly inside http {}
# Include exists but OUTSIDE http {} — strip it and re-insert inside
txt2 = re.sub(r'[ \t]*include[^;]*sites-enabled[^;]*;\n?', '', txt)
nl = txt2.find('\n', txt2.find('http {') if 'http {' in txt2 else txt2.find('http{'))
if nl != -1:
    txt2 = txt2[:nl] + '\n    include /etc/nginx/sites-enabled/*;\n' + txt2[nl:]
    with open(sys.argv[1], 'w') as fh:
        fh.write(txt2)
    print('[INFO]  Moved sites-enabled include inside http {} in nginx.conf')
PYEOF
        return 0
    fi

    # Include missing entirely — insert it inside http {}
    python3 - "$nginx_conf" << 'PYEOF'
import sys
conf_file = sys.argv[1]
with open(conf_file) as fh:
    txt = fh.read()
if 'sites-enabled' in txt:
    sys.exit(0)
idx = txt.find('http {')
if idx == -1: idx = txt.find('http{')
if idx == -1:
    print('ERROR: http { block not found in ' + conf_file, file=sys.stderr); sys.exit(1)
nl = txt.find('\n', idx)
txt = txt[:nl] + '\n    include /etc/nginx/sites-enabled/*;\n' + txt[nl:]
with open(conf_file, 'w') as fh:
    fh.write(txt)
print('[INFO]  Added include /etc/nginx/sites-enabled/*; inside http {} in nginx.conf')
PYEOF
}

# Backward-compatible alias — scripts 02/04/06 historically call this name
_ensure_sites_enabled_include() { nginx_ensure_sites_enabled_include "$@"; }

# ═════════════════════════════════════════════════════════════════════════════
# TEST + RELOAD nginx
# ═════════════════════════════════════════════════════════════════════════════
# Usage: nginx_test_reload "context message (optional)"
# Returns 0 if nginx -t passes and reload succeeds; 1 otherwise.
# Shows last few lines of nginx -t output on failure so the caller can diagnose.
nginx_test_reload() {
    local ctx="${1:-nginx config change}"
    if nginx -t >/dev/null 2>&1; then
        systemctl reload nginx 2>/dev/null || nginx -s reload 2>/dev/null || true
        return 0
    fi
    error "$ctx — nginx -t failed:"
    nginx -t 2>&1 | tail -5 >&2
    return 1
}

# ═════════════════════════════════════════════════════════════════════════════
# ENABLE / DISABLE a site
# ═════════════════════════════════════════════════════════════════════════════
# Usage: nginx_enable_site <conf_path> <symlink_name>
# Ensures sites-enabled include, creates symlink, tests + reloads.
nginx_enable_site() {
    local conf="$1" name="$2"
    if [[ -z "$conf" || -z "$name" ]]; then
        error "nginx_enable_site: usage: <conf_path> <symlink_name>"; return 1
    fi
    if [[ ! -f "$conf" ]]; then
        error "nginx_enable_site: config not found: $conf"; return 1
    fi
    nginx_ensure_sites_enabled_include
    ln -sf "$conf" "/etc/nginx/sites-enabled/$name"
    nginx_test_reload "enabling site $name"
}

# Usage: nginx_disable_site <symlink_name>
# Removes the symlink and reloads. Does NOT delete the underlying conf file.
nginx_disable_site() {
    local name="$1"
    [[ -z "$name" ]] && { error "nginx_disable_site: name required"; return 1; }
    rm -f "/etc/nginx/sites-enabled/$name"
    nginx_test_reload "disabling site $name" \
        || warn "nginx reload skipped after disabling $name — fix config manually."
}

# ═════════════════════════════════════════════════════════════════════════════
# INSTALL nginx + certbot (distro-aware)
# ═════════════════════════════════════════════════════════════════════════════
# Installs whatever is missing. Safe to call every time — no-op if both present.
# Calls nginx_evict_apache2 first to avoid port-80 conflicts.
# Always calls nginx_ensure_sites_enabled_include at the end.
nginx_install_with_certbot() {
    local need_nginx=false need_certbot=false
    command -v nginx   >/dev/null 2>&1 || need_nginx=true
    command -v certbot >/dev/null 2>&1 || need_certbot=true

    if ! $need_nginx && ! $need_certbot; then
        nginx_ensure_sites_enabled_include
        return 0
    fi

    nginx_evict_apache2

    if [[ -f /etc/debian_version ]]; then
        local pkgs=""
        $need_nginx   && pkgs+=" nginx"
        $need_certbot && pkgs+=" certbot python3-certbot-nginx"
        info "Installing:$pkgs"
        apt-get update && apt-get install -y $pkgs || { error "apt install failed"; return 1; }
    elif [[ -f /etc/redhat-release ]]; then
        local pkgs="epel-release"
        $need_nginx   && pkgs+=" nginx"
        $need_certbot && pkgs+=" certbot python3-certbot-nginx"
        info "Installing:$pkgs"
        yum install -y $pkgs || { error "yum install failed"; return 1; }
    else
        error "Unsupported OS — install nginx and certbot manually."; return 1
    fi

    if $need_nginx; then
        systemctl enable nginx 2>/dev/null || true
        systemctl start nginx 2>/dev/null || true
        success "Nginx installed and started."
    fi
    $need_certbot && success "Certbot installed."

    nginx_ensure_sites_enabled_include
}

# ═════════════════════════════════════════════════════════════════════════════
# EVICT apache2 if it's blocking ports 80/443
# ═════════════════════════════════════════════════════════════════════════════
# Apache and nginx can't both bind port 80. Non-interactive — just stops it.
nginx_evict_apache2() {
    if systemctl is-active --quiet apache2 2>/dev/null; then
        warn "apache2 is running — stopping it to free port 80 for nginx"
        systemctl stop    apache2 2>/dev/null || true
        systemctl disable apache2 2>/dev/null || true
    elif systemctl is-enabled --quiet apache2 2>/dev/null; then
        systemctl disable apache2 2>/dev/null || true
    fi
}

# ═════════════════════════════════════════════════════════════════════════════
# WRITE a standard logrotate config for a service
# ═════════════════════════════════════════════════════════════════════════════
# Usage: nginx_write_logrotate <service_name> [rotate_count=5] [size=5M]
# Writes /etc/logrotate.d/<service_name>. Expects logs at:
#   /var/log/nginx/<service_name>.access.log
#   /var/log/nginx/<service_name>.error.log
nginx_write_logrotate() {
    local svc="$1" days="${2:-5}" size="${3:-5M}"
    [[ -z "$svc" ]] && { error "nginx_write_logrotate: service name required"; return 1; }
    cat > "/etc/logrotate.d/$svc" << LROEOF
/var/log/nginx/${svc}.access.log /var/log/nginx/${svc}.error.log {
    daily
    rotate $days
    size $size
    compress
    delaycompress
    missingok
    notifempty
    sharedscripts
    postrotate
        nginx -s reopen 2>/dev/null || true
    endscript
}
LROEOF
}

# ═════════════════════════════════════════════════════════════════════════════
# CERTBOT helpers (Let's Encrypt)
# ═════════════════════════════════════════════════════════════════════════════
# Usage: nginx_run_certbot <domain> <email> [--redirect|--no-redirect]
# Default: --redirect (force HTTPS). Pass --no-redirect to keep HTTP working.
nginx_run_certbot() {
    local domain="$1" email="$2" redirect_flag="${3:---redirect}"
    if [[ -z "$domain" || -z "$email" ]]; then
        error "nginx_run_certbot: usage: <domain> <email> [--redirect|--no-redirect]"
        return 1
    fi
    if ! command -v certbot >/dev/null 2>&1; then
        warn "certbot not installed — skipping SSL for $domain"; return 1
    fi
    local extra=""
    [[ "$redirect_flag" == "--redirect" ]] && extra="--redirect"
    info "Requesting Let's Encrypt cert for $domain..."
    certbot --nginx -d "$domain" --non-interactive --agree-tos -m "$email" $extra \
        || { warn "certbot failed for $domain — verify DNS and port 80"; return 1; }
}

# Usage: nginx_delete_certbot_cert <domain>
nginx_delete_certbot_cert() {
    local domain="$1"
    [[ -z "$domain" ]] && return 0
    command -v certbot >/dev/null 2>&1 || return 0
    certbot delete --cert-name "$domain" --non-interactive 2>/dev/null \
        || warn "certbot delete failed for $domain — may need manual cleanup at /etc/letsencrypt/"
}

# ═════════════════════════════════════════════════════════════════════════════
# INSPECTION helpers
# ═════════════════════════════════════════════════════════════════════════════
# Extract `server_name` value from a nginx config file. Returns first match.
nginx_extract_server_name() {
    grep -m1 'server_name' "$1" 2>/dev/null | awk '{print $2}' | tr -d ';'
}

# Returns 0 if site symlink exists in sites-enabled, non-zero otherwise.
nginx_site_is_enabled() {
    [[ -L "/etc/nginx/sites-enabled/$1" ]]
}

# ═════════════════════════════════════════════════════════════════════════════
# DOMAIN validation
# ═════════════════════════════════════════════════════════════════════════════
# Usage: nginx_validate_domain <domain>
# Returns 0 if domain matches basic DNS hostname rules, 1 otherwise.
nginx_validate_domain() {
    local d="$1"
    [[ "$d" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$ ]]
}
