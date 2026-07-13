# =============================================================================
# lib/nostr_relay_deploy.sh — shared "Nostr relay behind nginx over wss://" lib
# =============================================================================
#
# PURPOSE (design: docs/generated/script09_design.md PART C.1)
#   ONE primitive for the only genuinely fiddly piece both the Floonet relay
#   (091) and GoblinPay's bundled relay (05x) need:
#
#     deploy a nostr-rs-relay publicly reachable over wss://, TLS-terminated,
#     with the Upgrade/Connection headers a WebSocket vhost needs, following
#     the toolkit's Let's Encrypt HTTP-first-then-SSL bootstrap.
#
#   The nginx block is based on upstream floonet-rs docs/reverse-proxy.md
#   (proxy_pass to loopback, proxy_http_version 1.1, Upgrade headers,
#   proxy_read_timeout 1d) — we replace upstream's Caddy with nginx+certbot.
#
#   Rate-limit / conn-limit ZONES stay owned by the CALLING script (per
#   CLAUDE.md nginx rules — script-prefixed conf.d files). Create them with
#   nginx_ensure_rate_limit_zone / nginx_ensure_conn_limit_zone BEFORE calling
#   nrd_deploy_wss_vhost, then pass the zone names in; empty names = no limits.
#
# CONSUMERS
#   · Script 091 — Floonet relay deployer (first consumer)
#   · Script 05x — GoblinPay bundled relay mode (planned)
#
# CONVENTIONS
#   Sourced lib → NO shebang, NO set -e. Caller provides colors + logging
#   (info/warn/error/success); fallbacks below. Requires
#   lib/nginx_shared_helpers.sh (sourced here if not already loaded).
# =============================================================================

[[ -n "${_NOSTR_RELAY_DEPLOY_SH_LOADED:-}" ]] && return 0
_NOSTR_RELAY_DEPLOY_SH_LOADED=1

# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/nginx_shared_helpers.sh"

type info    >/dev/null 2>&1 || info()    { echo "[INFO]  $*"; }
type warn    >/dev/null 2>&1 || warn()    { echo "[WARN]  $*" >&2; }
type error   >/dev/null 2>&1 || error()   { echo "[ERROR] $*" >&2; }
type success >/dev/null 2>&1 || success() { echo "[OK]    $*"; }

# Set by nrd_deploy_wss_vhost: 1 when the SSL (wss://) vhost is live, 0 when
# only the HTTP bootstrap vhost could be brought up (certbot failed).
NRD_SSL_OK=0

# ─── Internal: the shared WebSocket proxy location block ─────────────────────
# $1 = upstream port, $2 = req zone (may be empty), $3 = conn zone (may be empty),
# $4 = landing-page root (may be empty).
#
# When $4 is empty the block proxies EVERY request to the relay (original
# behaviour — GoblinPay and any caller that omits the arg are unaffected).
#
# When $4 is a directory, the block splits traffic: real Nostr clients — a
# WebSocket upgrade, or a NIP-11 fetch (`Accept: application/nostr+json`) — reach
# the relay, while an ordinary browser GET is served the static index.html from
# that directory. This is the standard relay-with-landing-page nginx idiom: the
# proxy plumbing sits at location level (inherited into the implicit `if`
# locations), and `proxy_pass` lives ONLY inside the two `if`s, so a request that
# matches neither falls through to the static root. `try_files` is deliberately
# avoided here — `if` + `try_files` in one location is the genuinely broken combo.
#
# The NIP-05 name authority (floonet's built-in username registrar) serves plain
# HTTP on /.well-known/nostr.json and /api/v1/* — NOT a WS upgrade, NOT
# nostr+json — so with a landing page those would wrongly fall through to the
# static root and 404. Explicit exact/prefix locations carve them back to the
# relay (they out-rank the regex-less `location /`). Only added in the landing
# variant; the pure-proxy variant already sends everything to the relay.
_nrd_ws_location() {
    local port="$1" req_zone="${2:-}" conn_zone="${3:-}" landing="${4:-}"
    local limits=""
    [[ -n "$req_zone"  ]] && limits+="        limit_req zone=${req_zone} burst=30 nodelay;"$'\n'
    [[ -n "$conn_zone" ]] && limits+="        limit_conn ${conn_zone} 20;"$'\n'

    # Proxy plumbing shared by both variants (everything EXCEPT proxy_pass).
    local pheaders
    pheaders=$(cat <<PHDR
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        # WebSocket connections are long-lived — don't let nginx cut them
        proxy_read_timeout 1d;
        proxy_send_timeout 1d;
        proxy_buffering off;
PHDR
)

    if [[ -z "$landing" ]]; then
        cat <<WSLOC
    location / {
${limits}        proxy_pass http://127.0.0.1:${port};
${pheaders}
    }
WSLOC
    else
        cat <<WSLOC
    # NIP-05 name authority (when enabled) serves these paths as plain HTTP,
    # so they must reach the relay, not the static landing page. Exact + prefix
    # location matches take priority over the catch-all location / below.
    location = /.well-known/nostr.json {
${limits}        proxy_pass http://127.0.0.1:${port};
${pheaders}
    }
    location /api/v1/ {
${limits}        proxy_pass http://127.0.0.1:${port};
${pheaders}
    }
    location / {
${limits}        # Relay clients (WebSocket upgrade) + NIP-11 (nostr+json) → relay;
        # ordinary browsers fall through to the static landing page below.
        if (\$http_upgrade ~* websocket)               { proxy_pass http://127.0.0.1:${port}; }
        if (\$http_accept  ~  "application/nostr\\+json") { proxy_pass http://127.0.0.1:${port}; }
        root  ${landing};
        index index.html;
${pheaders}
    }
WSLOC
    fi
}

# ─── Phase 1 vhost: HTTP-only bootstrap (pre-certificate) ────────────────────
# Never references /etc/letsencrypt — safe to load before the cert exists.
# nrd_write_http_vhost <conf_path> <site_name> <domain> <port> [req_zone] [conn_zone] [landing_root]
nrd_write_http_vhost() {
    local conf="$1" name="$2" domain="$3" port="$4" req_zone="${5:-}" conn_zone="${6:-}" landing="${7:-}"
    mkdir -p "$(dirname "$conf")"
    cat > "$conf" <<HTTPVHOST
# Grin Node Toolkit — Nostr relay vhost (${name}) — HTTP bootstrap phase
# Managed by lib/nostr_relay_deploy.sh. Re-running the deployer regenerates it.
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    access_log /var/log/nginx/${name}.access.log;
    error_log  /var/log/nginx/${name}.error.log;

$(_nrd_ws_location "$port" "$req_zone" "$conn_zone" "$landing")
}
HTTPVHOST
}

# ─── Phase 2 vhost: full SSL (wss://) + HTTP→HTTPS redirect ──────────────────
# Only call AFTER the Let's Encrypt cert exists.
# nrd_write_ssl_vhost <conf_path> <site_name> <domain> <port> [req_zone] [conn_zone] [landing_root]
nrd_write_ssl_vhost() {
    local conf="$1" name="$2" domain="$3" port="$4" req_zone="${5:-}" conn_zone="${6:-}" landing="${7:-}"
    local live="/etc/letsencrypt/live/${domain}"
    if [[ ! -f "$live/fullchain.pem" ]]; then
        error "nrd_write_ssl_vhost: no cert at $live — refusing to write an SSL vhost that would fail nginx -t."
        return 1
    fi
    # Include the certbot companion files only when they exist (CLAUDE.md rule).
    local ssl_extra=""
    [[ -f /etc/letsencrypt/options-ssl-nginx.conf ]] && \
        ssl_extra+="    include /etc/letsencrypt/options-ssl-nginx.conf;"$'\n'
    [[ -f /etc/letsencrypt/ssl-dhparams.pem ]] && \
        ssl_extra+="    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"$'\n'
    mkdir -p "$(dirname "$conf")"
    cat > "$conf" <<SSLVHOST
# Grin Node Toolkit — Nostr relay vhost (${name}) — wss:// (SSL) phase
# Managed by lib/nostr_relay_deploy.sh. Re-running the deployer regenerates it.
# WebSocket proxy block based on upstream floonet-rs docs/reverse-proxy.md.
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ${domain};

    ssl_certificate     ${live}/fullchain.pem;
    ssl_certificate_key ${live}/privkey.pem;
${ssl_extra}
    access_log /var/log/nginx/${name}.access.log;
    error_log  /var/log/nginx/${name}.error.log;

$(_nrd_ws_location "$port" "$req_zone" "$conn_zone" "$landing")
}
SSLVHOST
}

# ─── Orchestrator: full HTTP-first → certbot → SSL bootstrap ─────────────────
# nrd_deploy_wss_vhost <site_name> <domain> <email> <port> [req_zone] [conn_zone] [landing_root]
#
# When [landing_root] is a directory, browsers get its static index.html while
# WebSocket + NIP-11 clients still reach the relay (see _nrd_ws_location). Omit
# it for a pure proxy vhost.
#
# Returns 0 when at least the HTTP vhost is serving (check NRD_SSL_OK for
# whether wss:// is actually live); returns 1 on hard nginx failure.
nrd_deploy_wss_vhost() {
    local name="$1" domain="$2" email="$3" port="$4" req_zone="${5:-}" conn_zone="${6:-}" landing="${7:-}"
    local conf="/etc/nginx/sites-available/${name}"
    NRD_SSL_OK=0

    nginx_install_with_certbot || { error "nginx/certbot install failed."; return 1; }

    # Phase 1 — HTTP bootstrap vhost (never references letsencrypt paths).
    nrd_write_http_vhost "$conf" "$name" "$domain" "$port" "$req_zone" "$conn_zone" "$landing"
    nginx_enable_site "$conf" "$name" || { error "HTTP bootstrap vhost failed nginx -t."; return 1; }
    success "HTTP bootstrap vhost live: http://${domain} → 127.0.0.1:${port}"

    # Phase 2 — certificate, then the real wss:// vhost.
    if [[ -f "/etc/letsencrypt/live/${domain}/fullchain.pem" ]] \
        || nginx_run_certbot "$domain" "$email" --no-redirect; then
        if nrd_write_ssl_vhost "$conf" "$name" "$domain" "$port" "$req_zone" "$conn_zone" "$landing" \
            && nginx_test_reload "SSL vhost for $name"; then
            NRD_SSL_OK=1
            nginx_write_logrotate "$name"
            success "wss:// vhost live: wss://${domain}"
        else
            # Fall back to the HTTP vhost so the site keeps working.
            warn "SSL vhost failed — reverting to the HTTP bootstrap vhost."
            nrd_write_http_vhost "$conf" "$name" "$domain" "$port" "$req_zone" "$conn_zone" "$landing"
            nginx_test_reload "revert to HTTP vhost for $name" || true
        fi
    else
        warn "certbot could not issue a certificate for ${domain}."
        warn "Relay is reachable over ws:// (unencrypted) only. Fix DNS (A record"
        warn "→ this server) and port 80 reachability, then re-run the SSL setup."
    fi
    return 0
}

# ─── Firewall: open the web ports (relay itself stays on loopback) ───────────
nrd_firewall_open_web() {
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
        ufw allow 80/tcp  >/dev/null 2>&1 || true
        ufw allow 443/tcp >/dev/null 2>&1 || true
        success "ufw: ports 80/443 open (relay stays loopback-only behind nginx)."
    elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
        firewall-cmd --permanent --add-service=http  >/dev/null 2>&1 || true
        firewall-cmd --permanent --add-service=https >/dev/null 2>&1 || true
        firewall-cmd --reload >/dev/null 2>&1 || true
        success "firewalld: http/https open (relay stays loopback-only behind nginx)."
    else
        info "No active ufw/firewalld detected — make sure ports 80/443 are reachable."
    fi
}

# ─── Verification helpers ─────────────────────────────────────────────────────
# WebSocket handshake test: expects "HTTP/1.1 101 Switching Protocols".
# nrd_ws_handshake_test <base_url>   e.g. https://relay.example.com or http://127.0.0.1:8181
nrd_ws_handshake_test() {
    local url="$1" first=""
    # || true guards pipefail: grabbing only the status line SIGPIPEs curl.
    # NOTE: after the 101 the socket stays open, so curl always waits out
    # --max-time — keep it short or every status screen stalls for its full value.
    first=$(curl -s -i --http1.1 --max-time 4 \
        -H "Connection: Upgrade" -H "Upgrade: websocket" \
        -H "Sec-WebSocket-Version: 13" \
        -H "Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==" \
        "$url" 2>/dev/null | head -n1) || true
    [[ "$first" == *" 101 "* ]]
}

# NIP-11 relay information document (JSON). Echoes the body; rc 1 if not JSON.
# nrd_nip11_fetch <base_url>
nrd_nip11_fetch() {
    local url="$1" body=""
    body=$(curl -fsS --max-time 10 -H 'Accept: application/nostr+json' "$url" 2>/dev/null) || return 1
    [[ "$body" == \{* ]] || return 1
    printf '%s\n' "$body"
}
