# 052_lib_nginx.sh — Accio (script 052): the web front. Stock nginx vhost,
# Let's Encrypt, the Tor hidden service, and the download route for the
# standalone artefact.
#
# Sourced by 052_grin_accio.sh — inherits its colors, info/warn/error/success,
# pause, log, and the ACC_* variables set by acc_set_network.
#
#   Public entries
#     acn_nginx_menu       the "4) Nginx, SSL & onion" screen
#     acn_deploy_web       domain → HTTP vhost → certbot → SSL vhost (idempotent)
#     acn_onion_enable     mint/keep the onion, open the onion front, rebuild
#     acn_onion_disable    close the onion front (the KEY is kept — see below)
#     acn_status           vhost, cert expiry, onion, headers, front ports
#     acn_remove_web       vhosts + snippets (the built site and cert survive)
#
#   Also called from OUTSIDE this file — treat these as public too:
#     acn_refresh_vhost        rewrite whatever vhosts exist, no prompts.
#                              Called by 052_lib_gateway.sh (acg_nginx_glue)
#                              and by 052_grin_accio.sh (acc_install).
#     acn_write_headers_snippet  the shared header set. Called by both actions
#                              here, and safe to call before anything else.
#
# ─── STOCK nginx, and why that is the whole point ────────────────────────────
# Upstream fronts this wallet with FOUR custom nginx C modules (SOCKS-Proxy,
# Block-Access, Allow-Headers and — undocumented in its own README —
# headers-more). Each is an .so built against the exact installed nginx, so an
# `apt upgrade nginx` breaks `load_module` and nginx then REFUSES TO START AT
# ALL, taking Fidelius, GrinScan, the pool, Drop and the node API down with it.
# The first three are replaced by the Node gateway (052_lib_gateway.sh). The
# fourth is replaced right here, by plain `add_header`.
#
# ⚠ THE ONE TRAP IN DOING THAT — `add_header` IN A CHILD BLOCK DISCARDS EVERY
#   `add_header` INHERITED FROM ITS PARENT. Not "merges with": discards. So a
#   `location` that adds one Cache-Control silently loses Content-Security-
#   Policy, Referrer-Policy and the rest, with no error and nothing visible in
#   the response but their absence. That is how a CSP goes missing from exactly
#   the routes that matter.
#
#   The rule this file follows, without exception:
#     • the shared header set lives in ONE snippet (accio-<net>-headers.conf);
#     • EVERY block that emits any add_header of its own `include`s it first;
#     • blocks that add nothing simply inherit, and are left alone.
#   Grep discipline: if you add an `add_header` anywhere below, the block it
#   lands in must already carry that include, or you have just deleted the
#   site's security headers for that route.
#
#   Two smaller differences from headers-more, both already handled:
#     • `more_set_headers -s 200` is status-filtered; plain add_header applies
#       to a fixed status list, so every header below carries `always`.
#     • `more_clear_headers Server` has NO stock equivalent. `server_tokens off`
#       shortens the value to "nginx" and that is as far as nginx will go.
#
# ─── What is served, and what is proxied ─────────────────────────────────────
#   /                       $ACC_SITE_DIR — prerendered static files, no PHP
#   /standalone.html        the offline artefact, as a DOWNLOAD (see below)
#   /tor/<url>              ┐
#   /listen (WebSocket)     ├ the gateway, via 052_lib_gateway.sh's snippet
#   /wallet/<suffix>/…      ┘
#
# ⚠ THE GATEWAY INCLUDE IS PLACED BY THIS FILE, AND ITS POSITION IS LOAD-BEARING.
#   nginx matches regex locations in the order they appear. The static-asset
#   location below is `location ~* \.(?:js|css|…)$` — unanchored, so it would
#   also match a /tor/ destination path ending in one of those extensions and
#   answer it as a missing file. Putting the gateway include FIRST settles it.
#   (acg_nginx_glue appends the include at the end of the server block when it
#   has to add one itself. Deploying through this file means it never has to.)
#
# ─── The onion: THREE listeners, THREE ports ─────────────────────────────────
# tor does not talk to the gateway. It talks to a SECOND nginx server block —
# the wallet is ~7 MB of WASM and static assets that nginx should serve over the
# onion exactly as it does over TLS — and that block proxies only /tor/, /listen
# and /wallet/ through. So the chain has three hops and needs three ports:
#
#   tor ──→ 127.0.0.1:$ACC_TOR_FRONT_PORT ──→ [nginx onion server block]
#                                                    │
#                                          proxy_pass ▼
#                                        127.0.0.1:$ACC_TOR_PORT ──→ [gateway]
#
# Both fronts arrive at the gateway on 127.0.0.1, so it cannot tell them apart
# by peer address — but it can by `socket.localPort`, and that is the only
# reason a Tor visitor cannot forge X-Forwarded-For and mint a fresh identity
# per request. Never point the hidden service at $ACC_PORT.
#
# ⚠ AND NEVER AT $ACC_TOR_PORT EITHER — THAT IS THE GATEWAY'S OWN SOCKET.
#   Collapsing the front onto it looks like one fewer port and is in fact a
#   bind collision. nginx reloads first and takes the port; the gateway's next
#   restart gets EADDRINUSE and server.js calls process.exit(1), so the whole
#   service dies and the CLEARNET /tor/, /listen and /wallet/ rails go with it
#   — enabling the onion breaks the site that was working. (`nginx -t` cannot
#   see it: it never binds. `systemctl reload` returns 0 either way. Which is
#   why _acn_reload now checks the listener actually appeared.) And even past
#   the race, the onion snippet's proxy_pass would point at the very block that
#   includes it.
#
# ─── Two rules for editing the vhost heredocs below ──────────────────────────
# They are UNQUOTED heredocs, because they interpolate $domain, $ACC_SITE_DIR
# and the rest. That means the shell reads their contents, comments included:
#   1. NO BACKTICKS, not even inside a comment. `foo` is command substitution
#      and the word simply vanishes from the generated config — verified, not
#      theorised: an early draft of this file lost two words from the HSTS
#      comment exactly this way, and a backticked word that happened to name a
#      real command would have injected its OUTPUT into an nginx config.
#      Use "double quotes" for emphasis in here.
#   2. Escape every nginx variable as \$host, \$uri, \$request_uri. An
#      unescaped one expands to empty at generation time, which is not a syntax
#      error — it is a vhost that quietly redirects to https:// with no host.
# The same applies to Content-Disposition: nginx accepts \" inside a quoted
# string, but three levels of backslash through a heredoc is how you end up
# with three arguments where nginx wants one, so the filename is an unquoted
# RFC 6266 token instead.
#
# ⚠ MINTING THE ONION IS NOT ENOUGH — THE SITE MUST BE REBUILT AFTERWARDS.
#   TOR_SERVER_ADDRESS is baked into the built files at build time (it is what
#   the wallet's "Onion Service" address type hands out). An onion that exists
#   but was never built in means the page advertises a CLEARNET host to someone
#   who chose the onion. acn_onion_enable therefore offers the rebuild itself
#   and says so loudly if it is declined. The same is true of HTTPS: the first
#   successful certbot run flips ACCIO_HTTPS=on and the site needs a rebuild.

# ─── Paths ───────────────────────────────────────────────────────────────────
# The clearnet vhost name matches _acg_find_vhost's FIRST candidate on purpose:
# the gateway lib looks for /etc/nginx/sites-available/accio-<net> before it
# tries anything else, so the two libs agree without either importing the other.
_acn_vhost()          { echo "/etc/nginx/sites-available/accio-${ACC_NET_SHORT}"; }
_acn_link()           { echo "/etc/nginx/sites-enabled/accio-${ACC_NET_SHORT}"; }
_acn_onion_vhost()    { echo "/etc/nginx/sites-available/accio-${ACC_NET_SHORT}-onion"; }
_acn_onion_link()     { echo "/etc/nginx/sites-enabled/accio-${ACC_NET_SHORT}-onion"; }
_acn_headers()        { echo "/etc/nginx/snippets/accio-${ACC_NET_SHORT}-headers.conf"; }
# The headers that belong to the TLS front ONLY (HSTS, Onion-Location). A second
# snippet rather than more lines in the first, because the onion front must not
# emit either — and rather than a literal repeated in three blocks, because a
# repeated literal is how the three come to disagree. See the writer below.
_acn_tls_headers()    { echo "/etc/nginx/snippets/accio-${ACC_NET_SHORT}-tls-headers.conf"; }
_acn_gw_snippet()     { echo "/etc/nginx/snippets/accio-${ACC_NET_SHORT}-gateway.conf"; }
_acn_gw_onion_snip()  { echo "/etc/nginx/snippets/accio-${ACC_NET_SHORT}-gateway-onion.conf"; }
_acn_hs_dir()         { echo "/var/lib/tor/grin-accio-${ACC_NET_SHORT}"; }
_acn_torrc_marker()   { echo "# grin-accio-${ACC_NET_SHORT} (script 052)"; }
_acn_standalone_dir() { echo "$ACC_DIR/standalone"; }

# =============================================================================
# HEADERS SNIPPET
# =============================================================================
# Everything upstream sets with more_set_headers, MINUS the three that are
# per-front and therefore belong to the block that includes this file:
#   Cache-Control            static assets want the opposite value
#   Strict-Transport-Security  meaningless on a plain-HTTP onion front
#   Onion-Location           points AT the onion; never emitted BY it
#
# Content-Security-Policy is upstream's policy PLUS four directives S8 added; it
# is no longer verbatim. It still reads loose — 'unsafe-eval' and 'unsafe-inline'
# in script-src, connect-src * — and S8 measured all three against the vendored
# source rather than tightening them on how they read:
#   'unsafe-eval'   REQUIRED, and wider than it needs to be. There is no eval()
#                   and no Function("…") in the tree; the only caller is
#                   WebAssembly.instantiate in the five emscripten wrappers, which
#                   is what 'wasm-unsafe-eval' exists for. Both tokens are listed
#                   so that dropping this one later is a one-word edit — do that
#                   only AFTER watching the wallet boot and sign without it, since
#                   a browser too old to know 'wasm-unsafe-eval' would then fail
#                   to instantiate the crypto at all.
#   'unsafe-inline' REQUIRED. index.html carries 144 inline event handlers.
#   connect-src *   REQUIRED. The visitor chooses their own Grin node URL.
# The four additions — object-src, base-uri, form-action, frame-ancestors — do
# NOT fall back to default-src, so before S8 they were unrestricted. Verified
# against the tree: no <object>/<embed>, both <form>s post to themselves, the
# three blob: URLs are anchor downloads (ungated by CSP), and every Worker is
# constructed from a same-origin file path, not a blob. base-uri is 'self' rather
# than 'none' because errors/template.php legitimately emits a <base href>.
# The remaining half of the answer is an S2 run — see script052_security_audit.md.
acn_write_headers_snippet() {
    local f; f="$(_acn_headers)"
    mkdir -p /etc/nginx/snippets
    cat > "$f" << 'HDRS'
# Grin Node Toolkit — Accio (script 052) security headers.
# Generated by scripts/lib/052_lib_nginx.sh. Do not edit by hand; re-run
# "Nginx, SSL & onion → Deploy / update the web front" to regenerate.
#
# ⚠ INCLUDE THIS IN EVERY BLOCK THAT SETS ANY add_header OF ITS OWN.
#   nginx does not merge a location's add_header set with its server's — it
#   REPLACES it. A location that adds one header and forgets this include has
#   silently dropped the Content-Security-Policy for that route.
#
# Cache-Control, Strict-Transport-Security and Onion-Location are deliberately
# NOT here: each differs per block or per front, so each block sets its own.

add_header X-Frame-Options           "SAMEORIGIN"                       always;
add_header X-Content-Type-Options    "nosniff"                          always;
add_header Referrer-Policy           "same-origin"                      always;

# Cross-origin isolation. NOT load-bearing: scripts/common.js only reaches for
# SharedArrayBuffer when crossOriginIsolated is true and defines a fallback, so
# losing these degrades the wallet rather than breaking it.
add_header Cross-Origin-Opener-Policy   "same-origin"                   always;
add_header Cross-Origin-Embedder-Policy "require-corp"                  always;

# Upstream's policy, plus the four directives S8 added. See the note in
# 052_lib_nginx.sh before changing a single token of it — every loose-looking
# directive here is required by the WASM crypto, by the inlined build output, or
# by the visitor's right to point this wallet at their own node.
#
# S8 measured the three loose ones against the vendored source instead of
# reading them:
#   'unsafe-inline' script-src  REQUIRED. index.html carries 144 inline event
#                   handlers (onerror=/onload= on every asset it loads).
#   'unsafe-eval'   REQUIRED TODAY, and narrower than it needs to be. There is
#                   no eval() and no Function("…") anywhere in the tree — the
#                   only caller is WebAssembly.instantiate in the five
#                   emscripten wrappers, which is what 'wasm-unsafe-eval'
#                   exists for. That token is listed here now so that dropping
#                   'unsafe-eval' later is a one-word edit; it is NOT dropped
#                   yet, because a browser too old to know 'wasm-unsafe-eval'
#                   would then refuse to instantiate the crypto and the wallet
#                   would fail to start. Drop it once the acceptance session has
#                   watched the wallet boot and sign with it removed.
#   connect-src *   REQUIRED. The visitor chooses their own Grin node URL.
# The four additions cost nothing here and close what default-src cannot:
# object-src, base-uri, form-action and frame-ancestors do NOT fall back to
# default-src, so before this they were unrestricted. base-uri is 'self' rather
# than 'none' because the rendered error pages legitimately carry a <base href>
# pointing at this host (errors/template.php).
add_header Content-Security-Policy "default-src 'self'; connect-src *; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'" always;

# Everything this wallet legitimately asks for, and nothing else. `usb` and
# `bluetooth` are the hardware-wallet paths; `camera` is the QR scanner;
# `clipboard-write` is how an address or a slatepack leaves the page.
add_header Permissions-Policy "camera=(self), clipboard-write=(self), usb=(self), bluetooth=(self), cross-origin-isolated=(self), screen-wake-lock=(self), fullscreen=(self), autoplay=(), display-capture=(), encrypted-media=(), geolocation=(), gyroscope=(), accelerometer=(), magnetometer=(), microphone=(), midi=(), payment=(), serial=(), hid=(), idle-detection=(), interest-cohort=(), browsing-topics=(), clipboard-read=(), local-fonts=(), otp-credentials=(), picture-in-picture=(), publickey-credentials-get=(), xr-spatial-tracking=()" always;

# The language menu is client-side (scripts/languages.js carries every
# translation), but a cookie still selects the default, so a shared cache must
# not serve one visitor's copy to another.
add_header Vary "Accept-Language, Cookie" always;
HDRS
    success "Header snippet: $f"
    return 0
}

# The TLS front's own two headers. Written by _acn_write_ssl_vhost, included by
# every TLS block that sets any add_header of its own — exactly like the shared
# snippet above, and for the same reason.
#
# WHY THESE TWO ARE NOT IN THAT SNIPPET: the onion front includes it, and must
# emit neither. HSTS on a plain-HTTP response is ignored, and Onion-Location
# points AT the onion so the onion may never emit it.
#
# WHY THEY ARE A SNIPPET AND NOT THREE COPIES OF A LITERAL: they were, and the
# `always` HSTS line appeared three times in one heredoc. A max-age changed in
# one of the three is a difference nothing reports — and R4 found the same shape
# had already cost the site Onion-Location on two routes, because those two
# blocks re-included the shared snippet, re-stated HSTS, and simply forgot this.
# One file that every TLS block includes cannot drift out of step with itself.
_acn_write_tls_headers() {
    local onion="$1" f; f="$(_acn_tls_headers)"
    mkdir -p /etc/nginx/snippets
    {
        echo "# Grin Node Toolkit — Accio (script 052) TLS-front headers."
        echo "# Generated by scripts/lib/052_lib_nginx.sh. Do not edit by hand."
        echo "#"
        echo "# ⚠ INCLUDE THIS, AND accio-${ACC_NET_SHORT}-headers.conf, IN EVERY TLS BLOCK"
        echo "#   THAT SETS ANY add_header OF ITS OWN. A location's add_header set"
        echo "#   REPLACES its server's — it does not merge with it."
        echo "#"
        echo "# NOT included by the onion front: HSTS is ignored on a plain-HTTP"
        echo "# response, and Onion-Location points AT the onion."
        echo ""
        # No "includeSubDomains", unlike upstream. Upstream owns its whole apex
        # and every host under it; this toolkit does not — the same box commonly
        # serves api., testapi., scan. and a pool vhost, and an operator who
        # deploys Accio at an apex domain would be forcing HTTPS onto every
        # sibling host that exists now or ever will, from one wallet's vhost.
        # "preload" is left off for the same reason, and because it is close to
        # irreversible.
        echo 'add_header Strict-Transport-Security "max-age=63072000" always;'
        if [[ -n "$onion" ]]; then
            echo ""
            echo "# What makes Tor Browser offer the .onion automatically."
            echo "add_header Onion-Location \"http://${onion}\$request_uri\" always;"
        fi
    } > "$f"
    return 0
}

# =============================================================================
# VHOSTS
# =============================================================================

# The HTTP-only bootstrap. Written FIRST, reloaded, and only then does certbot
# run: an nginx config that names /etc/letsencrypt/live/<domain>/ before the
# cert exists hard-fails `nginx -t`, and a failed `nginx -t` is a box where
# nginx will not start — every other vhost included (CLAUDE.md, LE bootstrap).
_acn_write_http_vhost() {
    local domain="$1" vhost; vhost="$(_acn_vhost)"
    cat > "$vhost" << HTTPCONF
# Grin Node Toolkit — Accio [$ACC_NET_LABEL], HTTP bootstrap.
# Generated by scripts/lib/052_lib_nginx.sh. This file is REPLACED by the full
# TLS vhost as soon as certbot has issued a certificate.
server {
    listen 80;
    listen [::]:80;
    server_name $domain;
    server_tokens off;

    # No /.well-known/acme-challenge/ location on purpose. certbot --nginx
    # inserts its own for the duration of a challenge, and a webroot fallback
    # rooted at the site directory would be a trap: every build REPLACES that
    # directory by an atomic rename, so a challenge file written into it can be
    # swapped out from under certbot between the write and the fetch.
    location / { return 301 https://\$host\$request_uri; }
}
HTTPCONF
    ln -sf "$vhost" "$(_acn_link)"
    return 0
}

# The real vhost. Only ever written when the certificate already exists.
_acn_write_ssl_vhost() {
    local domain="$1" onion="$2"
    local vhost gw hdrs tls_hdrs ssl_extra="" standalone_dir listen443
    vhost="$(_acn_vhost)"; gw="$(_acn_gw_snippet)"; hdrs="$(_acn_headers)"
    standalone_dir="$(_acn_standalone_dir)"
    listen443="$(_acn_http2_listen)"

    # HSTS and Onion-Location, in one file the three TLS blocks below include.
    tls_hdrs="$(_acn_tls_headers)"
    _acn_write_tls_headers "$onion"

    # Include the LE snippets only when they exist — naming a missing include
    # is the same hard `nginx -t` failure as naming a missing cert.
    #
    # ⚠ THE `else` IS NOT OPTIONAL. options-ssl-nginx.conf is where the TLS
    #   floor lives, so a box without it does not fall back to "certbot's
    #   defaults" — it falls back to NGINX's, which on anything before 1.23 is
    #   `ssl_protocols TLSv1 TLSv1.1 TLSv1.2`. That is TLS 1.0 on a wallet page,
    #   arrived at by omission. python3-certbot-nginx normally ships the file,
    #   so this branch is the unlucky path, not the usual one — which is exactly
    #   why it would never have been noticed in testing.
    if [[ -f /etc/letsencrypt/options-ssl-nginx.conf ]]; then
        ssl_extra="    include /etc/letsencrypt/options-ssl-nginx.conf;"
    else
        ssl_extra="    # certbot's options-ssl-nginx.conf is absent on this box, so the TLS
    # floor is set here instead of inherited from nginx's (pre-1.23 that
    # would include TLSv1 and TLSv1.1).
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:AccioSSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;"
    fi
    if [[ -f /etc/letsencrypt/ssl-dhparams.pem ]]; then
        ssl_extra+=$'\n'"    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"
    fi

    # The gateway include may legitimately not exist yet (the gateway is
    # installed separately). Referencing a missing include is fatal to nginx, so
    # it is emitted only when the file is there; "Gateway service → nginx glue"
    # writes the snippet and adds the include itself if this ran first.
    local gw_include=""
    if [[ -f "$gw" ]]; then
        gw_include="    include $gw;"
    fi

    cat > "$vhost" << SSLCONF
# Grin Node Toolkit — Accio [$ACC_NET_LABEL] — self-custodial Grin web wallet.
# Generated by scripts/lib/052_lib_nginx.sh — re-run "Nginx, SSL & onion" to
# regenerate. STOCK nginx: no load_module, no php-fpm, no custom modules.
#
# Header rule: any block below that sets an add_header of its own MUST include
# BOTH of these first, or it silently drops the site's CSP, its HSTS, or its
# Onion-Location. Two files, both required, no exceptions on this front:
#   $hdrs
#   $tls_hdrs

server {
    listen 80;
    listen [::]:80;
    server_name $domain;
    server_tokens off;

    # No /.well-known/acme-challenge/ location here either, for the reason the
    # HTTP bootstrap gives: a webroot rooted at the site directory is a trap,
    # because every build REPLACES that directory by an atomic rename and a
    # challenge file can be swapped out from under certbot between the write and
    # the fetch. Renewal does not need one — certbot renews with the authenticator
    # recorded at issue time (--nginx), which inserts its own exact-match location
    # for the life of the challenge and takes it out again afterwards.
    location / { return 301 https://\$host\$request_uri; }
}

server {
$listen443
    server_name $domain;
    server_tokens off;

    ssl_certificate     /etc/letsencrypt/live/$domain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$domain/privkey.pem;
$ssl_extra

    root $ACC_SITE_DIR;
    index index.html;
    charset utf-8;
    autoindex off;

    access_log /var/log/nginx/accio-${ACC_NET_SHORT}-access.log;
    error_log  /var/log/nginx/accio-${ACC_NET_SHORT}-error.log;

    # The wallet holds its own seed; nothing it POSTs to this box is large.
    # The /tor/ location raises this to 10m for itself.
    client_max_body_size 1m;

    include $hdrs;
    include $tls_hdrs;
    add_header Cache-Control "no-store, no-transform" always;

    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_min_length 1000;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml application/javascript application/json application/manifest+json application/wasm image/svg+xml font/woff font/woff2;

    error_page 401 /errors/401.html;
    error_page 403 /errors/403.html;
    error_page 404 /errors/404.html;
    error_page 500 /errors/500.html;
    error_page 502 /errors/502.html;
    error_page 503 /errors/503.html;
    error_page 504 /errors/504.html;

    # ⚠ ORDER IS LOAD-BEARING. nginx tries regex locations in source order, and
    # the static-asset regex below is not anchored — it would otherwise match a
    # /tor/ destination path ending in .js and answer it as a missing file.
$gw_include

    # The offline artefact, served as a DOWNLOAD rather than a page. That is not
    # decoration: the file inlines its fonts, WASM and scripts as data: URIs,
    # which this site's own Content-Security-Policy forbids. Rendered here it
    # would half-load and look broken; saved to disk and opened from file:// it
    # works, which is the entire point of it.
    # ⚠ BOTH SNIPPETS, IN EVERY BLOCK BELOW THAT SETS ANY add_header. Neither is
    # optional and neither substitutes for the other: the shared one carries CSP
    # and friends, the TLS one carries HSTS and Onion-Location. S8 caught these
    # two blocks answering with no Strict-Transport-Security; R4 then caught the
    # replacement — a repeated HSTS literal — still missing Onion-Location here.
    # Same trap as the one this whole file warns about, one level further in,
    # twice. An include cannot be half-remembered the way a literal can.
    location = /standalone.html {
        alias $standalone_dir/current.html;
        include $hdrs;
        include $tls_hdrs;
        add_header Cache-Control "no-store, no-transform" always;
        add_header Content-Disposition "attachment; filename=accio-wallet-${ACC_NET_SHORT}.html" always;
        default_type "text/html";
    }

    # Content-addressed by the ?v= query the build stamps on every reference, so
    # a two-year immutable lifetime is safe: a changed file gets a new URL.
    #
    # max-age is written into this one header rather than left to an "expires"
    # directive. Both would emit a Cache-Control, and nginx does not merge them
    # — the response would carry the header TWICE, which is legal but is read
    # differently by intermediaries and is not what anyone reviewing this file
    # would expect to see on the wire.
    location ~* \.(?:js|css|json|wasm|png|ico|svg|txt|woff|woff2|vert|frag)\$ {
        include $hdrs;
        include $tls_hdrs;
        add_header Cache-Control "public, max-age=63072000, no-transform, immutable" always;
    }

    # ⚠ try_files belongs HERE, never in the server block. At server level it is
    # inherited by every location that does not define its own — including the
    # proxied gateway ones — and would 404 each of them looking for a file that
    # was never going to exist.
    location / {
        try_files \$uri \$uri/ =404;
    }
}
SSLCONF
    ln -sf "$vhost" "$(_acn_link)"
    return 0
}

# The onion front: same document root, its own local port, no TLS, no HSTS, no
# Onion-Location. Bound to 127.0.0.1 — tor is the only thing that may reach it.
#
# It listens on $ACC_TOR_FRONT_PORT and proxies to $ACC_TOR_PORT. Those are two
# different numbers on purpose; the file header says what happens when they are
# not. The caller is expected to have warned if $gw_onion is missing.
_acn_write_onion_vhost() {
    local vhost hdrs gw_onion standalone_dir
    vhost="$(_acn_onion_vhost)"; hdrs="$(_acn_headers)"
    gw_onion="$(_acn_gw_onion_snip)"; standalone_dir="$(_acn_standalone_dir)"

    local gw_include=""
    if [[ -f "$gw_onion" ]]; then
        gw_include="    include $gw_onion;"
    fi

    cat > "$vhost" << ONIONCONF
# Grin Node Toolkit — Accio [$ACC_NET_LABEL] — Tor hidden service front.
# Generated by scripts/lib/052_lib_nginx.sh.
#
# tor forwards the hidden service's port 80 to 127.0.0.1:$ACC_TOR_FRONT_PORT,
# and THIS block answers it. It then proxies the three gateway routes on to
# 127.0.0.1:$ACC_TOR_PORT, which is the gateway's second listener — a different
# process on a different port, not this one.
#
# The gateway having its own port per front is a security control: it classifies
# a request by socket.localPort, which is the only reason a Tor visitor cannot
# forge X-Forwarded-For and mint a fresh identity per request. Never point the
# hidden service at $ACC_PORT, and never at $ACC_TOR_PORT either — that is the
# gateway's socket, and two processes cannot bind it.
#
# No Strict-Transport-Security (the onion is plain HTTP by design — Tor already
# authenticates and encrypts the connection, and an HSTS header on a non-HTTPS
# response is ignored anyway) and no Onion-Location (this IS the onion). That is
# the whole reason those two live in their own snippet, which this never includes.
server {
    listen 127.0.0.1:$ACC_TOR_FRONT_PORT;
    server_name _;
    server_tokens off;

    root $ACC_SITE_DIR;
    index index.html;
    charset utf-8;
    autoindex off;

    access_log /var/log/nginx/accio-${ACC_NET_SHORT}-onion-access.log;
    error_log  /var/log/nginx/accio-${ACC_NET_SHORT}-onion-error.log;

    client_max_body_size 1m;

    include $hdrs;
    add_header Cache-Control "no-store, no-transform" always;

    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_min_length 1000;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml application/javascript application/json application/manifest+json application/wasm image/svg+xml font/woff font/woff2;

    error_page 401 /errors/401.html;
    error_page 403 /errors/403.html;
    error_page 404 /errors/404.html;
    error_page 500 /errors/500.html;
    error_page 502 /errors/502.html;
    error_page 503 /errors/503.html;
    error_page 504 /errors/504.html;

    # Same ordering rule as the clearnet vhost: gateway first.
$gw_include

    location = /standalone.html {
        alias $standalone_dir/current.html;
        include $hdrs;
        add_header Cache-Control "no-store, no-transform" always;
        add_header Content-Disposition "attachment; filename=accio-wallet-${ACC_NET_SHORT}.html" always;
        default_type "text/html";
    }

    location ~* \.(?:js|css|json|wasm|png|ico|svg|txt|woff|woff2|vert|frag)\$ {
        include $hdrs;
        add_header Cache-Control "public, max-age=63072000, no-transform, immutable" always;
    }

    location / {
        try_files \$uri \$uri/ =404;
    }
}
ONIONCONF
    ln -sf "$vhost" "$(_acn_onion_link)"
    return 0
}

# =============================================================================
# HELPERS
# =============================================================================

# Ask tor to re-read torrc, and only fall back to a restart if it will not.
#
# ⚠ THIS BOX IS NOT TOR'S ONLY TENANT. Script 04 publishes the node's onion,
#   Fidelius has one, the Transporter has one, and the pool's payouts ride
#   outbound SOCKS circuits through the same daemon. `systemctl restart tor`
#   drops all of that for a torrc change that belongs to Accio alone. tor adds
#   and removes hidden services on SIGHUP, so the restart is a fallback, not
#   the method. Scripts 01, 04 and 08del already do it this way.
#
# `tor@default` first, then `tor`: on Debian `tor.service` is a oneshot wrapper
# (ExecStart=/bin/true) and acting on it does nothing to the running instance,
# while on RHEL `tor.service` IS the instance and `tor@default` does not exist.
_acn_tor_reload() {
    systemctl reload  tor@default 2>/dev/null && return 0
    systemctl reload  tor         2>/dev/null && return 0
    warn "tor would not reload — falling back to a restart (other onions on this"
    warn "box will blink: the node API's, Fidelius's, the Transporter's)."
    systemctl restart tor@default 2>/dev/null && return 0
    systemctl restart tor         2>/dev/null && return 0
    return 1
}

_acn_load_shared() {
    local helper="$SCRIPT_DIR/lib/nginx_shared_helpers.sh"
    if [[ ! -f "$helper" ]]; then
        error "Missing $helper"
        return 1
    fi
    # shellcheck disable=SC1090
    source "$helper"
}

# _acn_reload [expected_listen_addr ...]
#
# ⚠ A CLEAN `nginx -t` AND A ZERO-EXIT RELOAD DO NOT MEAN THE CONFIG IS LIVE.
#   `nginx -t` parses; it never opens a socket, so it cannot see a `listen` on
#   an address something else already holds. `systemctl reload` signals the
#   master and returns 0 immediately, long before the master tries to bind. A
#   vhost that cannot claim its port therefore reports "nginx reloaded." and
#   serves nothing — which is how R4's port collision would have looked on
#   screen: entirely successful. So every caller that adds a `listen` passes the
#   address here and we go and look.
#
# A failed check is a WARNING, not an error return: the reload itself did
# succeed, the rest of the config is live, and there is nothing to roll back.
# What the operator needs is the port number and where to look.
_acn_reload() {
    if ! nginx -t 2>/dev/null; then
        error "nginx -t FAILED — not reloading:"
        nginx -t 2>&1 | sed 's/^/    /' || true
        return 1
    fi
    if ! systemctl reload nginx 2>/dev/null; then
        warn "nginx -t passed but reload failed — systemctl status nginx"
        return 1
    fi
    success "nginx reloaded."

    local addr missing=""
    for addr in "$@"; do
        [[ -n "$addr" ]] || continue
        command -v ss &>/dev/null || break
        # The master binds during the reload, not before it returns. One short
        # settle beats a false alarm on a busy box.
        local i=0
        while (( i < 5 )); do
            if ss -ltn 2>/dev/null | grep -qF "$addr "; then break; fi
            sleep 1; i=$(( i + 1 ))
        done
        if (( i >= 5 )); then missing="$missing $addr"; fi
    done

    if [[ -n "$missing" ]]; then
        missing="${missing# }"
        warn "nginx reloaded, but is NOT listening on: $missing"
        warn "Almost always a port already held by another process. Check with:"
        echo -e "  ${DIM}ss -ltnp | grep -E '${missing// /|}'${RESET}"
        echo -e "  ${DIM}journalctl -u nginx -n 20   (look for 'Address already in use')${RESET}"
        return 0
    fi
    return 0
}

# nginx runs as www-data/nginx and must be able to traverse /opt/grin/accio-<net>
# to reach site/. Only the site tree and that one directory are opened up:
# gateway.json is 640 root:grinaccio and gateway-state is 700, and both keep
# their own modes because `chmod` here is targeted, never recursive from $ACC_DIR.
_acn_fix_site_perms() {
    [[ -d "$ACC_SITE_DIR" ]] || return 0
    chmod 755 "$ACC_DIR" 2>/dev/null || true
    chmod -R a+rX "$ACC_SITE_DIR" 2>/dev/null || true
    if [[ -d "$(_acn_standalone_dir)" ]]; then
        chmod 755 "$(_acn_standalone_dir)" 2>/dev/null || true
        chmod -R a+rX "$(_acn_standalone_dir)" 2>/dev/null || true
    fi
    return 0
}

# HTTP/2, spelled the way THIS box's nginx understands it.
#
# nginx 1.25.1 deprecated `listen … http2` in favour of a separate `http2 on;`
# directive. Neither spelling is universal: `http2 on;` is an "unknown
# directive" on Debian 12's 1.22, and the old form warns (but works) on 1.25+.
# Guessing either way costs a failed `nginx -t` — which on this box does not
# mean "Accio is misconfigured", it means nginx does not start and every other
# vhost goes with it. So ask the binary.
#
# `|| true` on the substitution, not decoration: the entry script runs under
# `set -o pipefail`, so with nginx absent this pipeline exits 127 and the bare
# assignment `v=$(…)` would take the script down. Every caller today happens to
# sit inside an `|| true` chain that suppresses errexit, which is luck rather
# than a guarantee (see CLAUDE.md on libs running without errexit).
_acn_http2_listen() {
    local v major minor patch
    v=$( { nginx -v 2>&1 || true; } | sed -n 's|.*nginx/\([0-9.]*\).*|\1|p' ) || true
    IFS=. read -r major minor patch <<< "${v:-0.0.0}"
    major=${major:-0}; minor=${minor:-0}; patch=${patch:-0}
    if (( major > 1 )) || (( major == 1 && minor > 25 )) \
       || (( major == 1 && minor == 25 && patch >= 1 )); then
        printf '    listen 443 ssl;\n    listen [::]:443 ssl;\n    http2 on;\n'
    else
        printf '    listen 443 ssl http2;\n    listen [::]:443 ssl http2;\n'
    fi
}

# A cert can exist from an earlier run, from another product, or not at all.
_acn_cert_exists() {
    [[ -f "/etc/letsencrypt/live/$1/fullchain.pem" ]]
}

_acn_cert_expiry() {
    local domain="$1" pem="/etc/letsencrypt/live/$1/fullchain.pem"
    [[ -f "$pem" ]] || return 1
    openssl x509 -enddate -noout -in "$pem" 2>/dev/null | cut -d= -f2
}

# The rebuild that HTTPS and the onion both require. Offered, never silent: the
# built tree is what carries HTTPS_SERVER_ADDRESS and TOR_SERVER_ADDRESS, and a
# site built before either existed advertises the wrong one forever.
_acn_offer_rebuild() {
    local why="$1"
    echo ""
    echo -e "  ${YELLOW}The built site is now out of date: $why${RESET}"
    echo -e "  ${DIM}Those values are baked in at BUILD time, not read at runtime.${RESET}"
    echo -ne "  Rebuild the site now? [Y/n]: "
    local yn; read -r yn || true
    if [[ "${yn,,}" == "n" ]]; then
        warn "Not rebuilt — the live site still advertises the OLD values."
        warn "Run \"2) Rebuild site\" before telling anyone the address."
        return 0
    fi
    if ! declare -F accio_build >/dev/null 2>&1; then
        local lib="$SCRIPT_DIR/lib/052_lib_build.sh"
        if [[ ! -f "$lib" ]]; then
            error "Missing $lib — rebuild by hand with \"2) Rebuild site\"."
            return 0
        fi
        # shellcheck disable=SC1090
        source "$lib"
    fi
    local domain; domain="$(_acc_conf_get ACCIO_DOMAIN "")"
    if accio_build "$ACC_NETWORK" "$domain" "$ACC_SITE_DIR"; then
        _acn_fix_site_perms
        success "Site rebuilt."
    else
        error "Rebuild failed — the previous site is still live and untouched."
    fi
    return 0
}

# Rewrite whichever vhosts already exist, from the current config, and reload.
# No prompts, no certbot, no install — safe to call after anything that changes
# what the vhost should contain.
#
# ⚠ THIS IS WHAT KEEPS THE GATEWAY INCLUDE IN THE RIGHT PLACE. The include is
#   only written by _acn_write_ssl_vhost when the snippet file already exists,
#   and on a first deploy it does not: the gateway is installed after the web
#   front. acg_nginx_glue then appends the include at the END of the server
#   block — after the static-asset regex location, which is the one ordering
#   this file says must not happen. Calling this afterwards regenerates the
#   vhost wholesale, so the appended copy disappears and the properly placed
#   one takes over. Returns 0 when there was nothing to do.
acn_refresh_vhost() {
    local domain onion did=0
    local -a expect=()
    domain="$(_acc_conf_get ACCIO_DOMAIN "")"
    onion="$(_acc_conf_get ACCIO_ONION "")"

    if [[ -n "$domain" ]] && _acn_cert_exists "$domain" && [[ -f "$(_acn_vhost)" ]]; then
        _acn_write_ssl_vhost "$domain" "$onion"; did=1
    fi
    if [[ -f "$(_acn_onion_vhost)" ]]; then
        _acn_write_onion_vhost; did=1
        expect+=( "127.0.0.1:$ACC_TOR_FRONT_PORT" )
    fi
    if [[ "$did" -eq 0 ]]; then return 0; fi

    # An empty array expands to nothing under `set -u` only with the +() form.
    if _acn_reload ${expect[@]+"${expect[@]}"}; then
        success "Vhosts refreshed — gateway routes are ahead of the static ones."
        return 0
    fi
    error "nginx -t failed after refreshing the vhosts. The previous config is"
    error "still loaded; fix the error above before the next reload or reboot."
    return 1
}

# =============================================================================
# 1) DEPLOY / UPDATE THE WEB FRONT
# =============================================================================
acn_deploy_web() {
    clear
    echo -e "\n${BOLD}${CYAN}── Accio [$ACC_NET_LABEL] — web front ──${RESET}\n"
    echo -e "  ${DIM}Stock nginx: static files plus three proxied routes. No custom${RESET}"
    echo -e "  ${DIM}modules, no php-fpm, no version hold — an nginx upgrade on this${RESET}"
    echo -e "  ${DIM}box can never stop nginx from starting on Accio's account.${RESET}\n"

    if [[ "$ACC_NETWORK" == "mainnet" ]]; then
        echo -e "  ${YELLOW}⚠ MAINNET — real GRIN.${RESET}"
        echo -e "  ${DIM}Deploy here only after a testnet round trip you watched succeed:${RESET}"
        echo -e "  ${DIM}a send out through /tor/ AND a payment in through /listen.${RESET}"
        echo -e "  ${DIM}Custody is still zero — no seed exists on this box either way —${RESET}"
        echo -e "  ${DIM}but a broken inbound rail loses a stranger's real payment.${RESET}"
        echo ""
        echo -ne "  Continue? [y/N]: "
        local go; read -r go || true
        if [[ "${go,,}" != "y" ]]; then info "Cancelled."; pause; return 0; fi
        echo ""
    fi

    _acn_load_shared || { pause; return 0; }

    # ── domain ───────────────────────────────────────────────────────────────
    local cur domain
    cur="$(_acc_conf_get ACCIO_DOMAIN "")"
    echo -e "  ${DIM}Example: wallet.grin.money  (testnet: testwallet.grin.money)${RESET}"
    echo -ne "  Domain${cur:+ [current: $cur]}: "
    read -r domain || true
    domain="${domain// /}"
    domain="${domain:-$cur}"
    if [[ -z "$domain" ]] || ! nginx_validate_domain "$domain"; then
        error "Not a usable domain name."
        pause; return 0
    fi
    if [[ "$domain" != "$cur" && -n "$cur" ]]; then
        warn "Domain changed: $cur → $domain"
        echo -e "  ${DIM}The site must be rebuilt afterwards — the old name is baked into${RESET}"
        echo -e "  ${DIM}canonical URLs, hreflang and the web manifest.${RESET}"
    fi
    _acc_conf_set ACCIO_DOMAIN "$domain"
    _acc_conf_set ACCIO_NETWORK "$ACC_NETWORK"
    _acc_conf_set ACCIO_NODE_URL   "$(_acc_conf_get ACCIO_NODE_URL "$ACC_NODE_URL")"
    _acc_conf_set ACCIO_GATEWAY_PORT "$(_acc_conf_get ACCIO_GATEWAY_PORT "$ACC_PORT")"
    _acc_conf_set ACCIO_TOR_PORT     "$(_acc_conf_get ACCIO_TOR_PORT "$ACC_TOR_PORT")"
    _acc_conf_set ACCIO_TOR_FRONT_PORT "$(_acc_conf_get ACCIO_TOR_FRONT_PORT "$ACC_TOR_FRONT_PORT")"

    if [[ ! -s "$ACC_SITE_DIR/index.html" ]]; then
        warn "No built site at $ACC_SITE_DIR yet."
        echo -e "  ${DIM}The vhost is written anyway; run \"2) Rebuild site\" and the${RESET}"
        echo -e "  ${DIM}files appear underneath it. Nothing here depends on build order.${RESET}"
        echo ""
    fi

    nginx_install_with_certbot || { pause; return 0; }
    acn_write_headers_snippet

    mkdir -p "$ACC_SITE_DIR"
    _acn_fix_site_perms

    # ── certificate ──────────────────────────────────────────────────────────
    # The HTTP-only bootstrap is written ONLY when there is no certificate yet.
    # Writing it unconditionally would be tidier to read and worse to run: this
    # action is re-run to pick up a new onion, a moved gateway or a header
    # change, and on every one of those the bootstrap vhost — which has no
    # `listen 443` at all — would take HTTPS down between the two reloads. On a
    # live wallet that is a real outage for the sake of a step that has nothing
    # left to do, now that no ACME webroot location is written (see the vhost).
    local had_cert=0
    if _acn_cert_exists "$domain"; then
        had_cert=1
        success "Certificate already present for $domain (expires $(_acn_cert_expiry "$domain"))."
        info "Keeping the current vhost live until the new one passes nginx -t."
    else
        _acn_write_http_vhost "$domain"
        if ! _acn_reload; then
            error "The HTTP bootstrap vhost did not load — stopping before certbot."
            pause; return 0
        fi
        success "HTTP vhost live: $(_acn_vhost)"

        local email; email="$(_acc_conf_get ACCIO_LE_EMAIL "")"
        echo ""
        echo -ne "  Let's Encrypt email${email:+ [current: $email]}: "
        local em; read -r em || true
        email="${em:-$email}"
        if [[ -z "$email" ]]; then
            error "certbot needs an email address. Nothing else was changed."
            pause; return 0
        fi
        _acc_conf_set ACCIO_LE_EMAIL "$email"

        # --no-redirect: we write our own 301 in the vhost below, and letting
        # certbot rewrite this file would fight the next deploy.
        if ! certbot --nginx -d "$domain" --non-interactive --agree-tos -m "$email" --no-redirect; then
            error "certbot failed. The HTTP vhost is live and nothing is broken."
            echo -e "  ${DIM}Check: DNS for $domain points at this box, and port 80 is open.${RESET}"
            echo -e "  ${DIM}Cloudflare? Set the record to 'DNS only' (grey cloud) and retry.${RESET}"
            pause; return 0
        fi
        success "Certificate issued for $domain."
    fi

    # ── the real vhost ───────────────────────────────────────────────────────
    local onion; onion="$(_acc_conf_get ACCIO_ONION "")"
    _acn_write_ssl_vhost "$domain" "$onion"
    if ! _acn_reload; then
        # The running config is still the old one — _acn_reload does not reload
        # on a failed `nginx -t`. But the FILE on disk is now broken, and the
        # next reload by any other product, or the next reboot, would fail on
        # it and stop nginx for the whole box. So a known-good file goes back in
        # its place, even though that costs HTTPS for this vhost until the error
        # above is fixed and this action re-run.
        error "The TLS vhost failed to load. Restoring the HTTP-only bootstrap:"
        error "Accio will answer on HTTP only until this is fixed and re-run."
        _acn_write_http_vhost "$domain"
        _acn_reload || true
        # The site is now plain HTTP whatever an earlier run recorded. Leaving
        # ACCIO_HTTPS=on here would make the install summary print an https://
        # URL that answers nothing, and would bake HTTPS_SERVER_ADDRESS into the
        # next build — the build reads this key, not the vhost.
        _acc_conf_set ACCIO_HTTPS off
        pause; return 0
    fi
    success "Accio is live at https://$domain"

    local was_https; was_https="$(_acc_conf_get ACCIO_HTTPS "off")"
    _acc_conf_set ACCIO_HTTPS on

    if [[ -f "$(_acn_gw_snippet)" ]]; then
        success "Gateway routes included (/tor/, /listen, /wallet/<suffix>)."
    else
        warn "The gateway snippet does not exist yet — /tor/, /listen and"
        warn "/wallet/ are NOT routed. Run \"3) Gateway service → nginx glue\"."
        echo -e "  ${DIM}Until then the wallet page loads and syncs, but cannot send${RESET}"
        echo -e "  ${DIM}to an onion address or receive a payment.${RESET}"
    fi

    if [[ "$was_https" != "on" || "$domain" != "$cur" || "$had_cert" -eq 0 ]]; then
        _acn_offer_rebuild "HTTPS and the canonical domain are baked into the build"
    fi

    log "[acn_deploy_web] net=$ACC_NETWORK domain=$domain cert=$had_cert"
    pause
    return 0
}

# =============================================================================
# 2) TOR HIDDEN SERVICE
# =============================================================================

# Remove our marked torrc block: the marker line plus the two directives under
# it. Used to rewrite (a port change) and to clean up — a stale HiddenServicePort
# silently points the onion at the wrong local port, which is the one failure
# mode that looks like it works.
_acn_torrc_strip() {
    local marker; marker="$(_acn_torrc_marker)"
    [[ -f /etc/tor/torrc ]] || return 0
    grep -qF "$marker" /etc/tor/torrc 2>/dev/null || return 0
    local tmp; tmp=$(mktemp) || return 1
    awk -v m="$marker" '
        $0 == m  { skip = 2; next }
        skip > 0 { skip--; next }
        { print }
    ' /etc/tor/torrc > "$tmp" && cat "$tmp" > /etc/tor/torrc
    rm -f "$tmp"
    return 0
}

acn_onion_enable() {
    clear
    echo -e "\n${BOLD}${CYAN}── Accio [$ACC_NET_LABEL] — Tor hidden service ──${RESET}\n"
    echo -e "  ${DIM}Serves the SAME wallet over a .onion address, from a second nginx${RESET}"
    echo -e "  ${DIM}block on 127.0.0.1:$ACC_TOR_FRONT_PORT, which proxies the three gateway${RESET}"
    echo -e "  ${DIM}routes on to 127.0.0.1:$ACC_TOR_PORT. Visitors reach the wallet without${RESET}"
    echo -e "  ${DIM}a DNS lookup, a certificate authority, or an exit node.${RESET}\n"
    echo -e "  ${DIM}This is a DIFFERENT thing from the gateway's outbound Tor client:${RESET}"
    echo -e "  ${DIM}that dials OUT to a payee's onion; this one lets visitors dial IN.${RESET}\n"

    if [[ ! -s "$ACC_SITE_DIR/index.html" ]]; then
        error "No built site at $ACC_SITE_DIR — build and deploy first."
        pause; return 0
    fi
    if ! command -v nginx &>/dev/null; then
        error "nginx is not installed — deploy the web front first."
        pause; return 0
    fi

    if ! command -v tor &>/dev/null; then
        echo -ne "  tor is not installed — install it now? [Y/n]: "
        local yn; read -r yn || true
        if [[ "${yn,,}" == "n" ]]; then info "Cancelled."; pause; return 0; fi
        if command -v apt-get &>/dev/null; then
            # `update` first: on a box whose package lists are stale (a fresh
            # image, or one that has only ever had certbot installed by another
            # product), `install` fails on a 404 for a version that has moved.
            apt-get update 2>/dev/null || warn "apt-get update failed — trying the install anyway."
            apt-get install -y tor || { error "apt-get install tor failed."; pause; return 0; }
        else
            # tor is NOT in the RHEL/Rocky/Alma base repos — it comes from EPEL,
            # which may or may not already be here depending on which product
            # installed certbot first. Asking for it is idempotent.
            rpm -q epel-release >/dev/null 2>&1 || yum install -y epel-release \
                || warn "Could not install epel-release — tor may not be found."
            yum install -y tor || { error "yum install tor failed."; pause; return 0; }
        fi
    fi

    # Written by the gateway lib, included by the onion vhost below. It is NOT
    # written here and its absence is not fatal — but an onion that serves the
    # wallet page and 404s every send, every listener handshake and every
    # inbound payment is the kind of half-working that costs an afternoon, so
    # it gets said before anything is changed rather than discovered after.
    if [[ ! -f "$(_acn_gw_onion_snip)" ]]; then
        warn "No onion gateway snippet at $(_acn_gw_onion_snip)."
        echo -e "  ${DIM}The onion will serve the wallet page but /tor/, /listen and${RESET}"
        echo -e "  ${DIM}/wallet/ will 404 over it: no sending, no receiving. Run${RESET}"
        echo -e "  ${DIM}\"3) Gateway service → nginx glue\" first, or re-run this after.${RESET}"
        echo ""
    fi

    local hs_dir marker
    hs_dir="$(_acn_hs_dir)"; marker="$(_acn_torrc_marker)"

    # Always rewritten rather than skipped-if-present: a block written by an
    # earlier version could name the wrong port, and that failure is invisible.
    # The KEY is untouched — tor reuses $hs_dir/hs_ed25519_secret_key, so the
    # onion address survives this and every later re-run.
    _acn_torrc_strip
    # → $ACC_TOR_FRONT_PORT, which is NGINX's. Not $ACC_TOR_PORT: that is the
    # gateway's own socket, and pointing tor at it would put two processes on
    # one port. The nginx block below is what forwards on to the gateway.
    cat >> /etc/tor/torrc << TORRC

$marker
HiddenServiceDir $hs_dir/
HiddenServicePort 80 127.0.0.1:$ACC_TOR_FRONT_PORT
TORRC
    success "torrc block written (hidden service → 127.0.0.1:$ACC_TOR_FRONT_PORT)"

    acn_write_headers_snippet >/dev/null
    _acn_write_onion_vhost
    # The listen address is passed so a bind failure is reported rather than
    # celebrated — this block adds a `listen` nothing else on the box should
    # want, and `nginx -t` cannot tell us whether it got it.
    if ! _acn_reload "127.0.0.1:$ACC_TOR_FRONT_PORT"; then
        error "The onion vhost failed to load — rolling it back."
        rm -f "$(_acn_onion_link)" "$(_acn_onion_vhost)"
        _acn_torrc_strip
        _acn_reload || true
        pause; return 0
    fi
    success "Onion nginx front: 127.0.0.1:$ACC_TOR_FRONT_PORT → gateway :$ACC_TOR_PORT"

    # The gateway opens its onion listener only when tor_port is non-zero.
    local conf_json="$ACC_DIR/gateway.json"
    if [[ -f "$conf_json" ]] && command -v node &>/dev/null; then
        node -e '
            const fs = require("node:fs");
            const [file, port] = process.argv.slice(1);
            const d = JSON.parse(fs.readFileSync(file, "utf8"));
            d.tor_port = Number(port);
            fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
        ' "$conf_json" "$ACC_TOR_PORT" 2>/dev/null \
            && success "Gateway onion listener enabled (tor_port=$ACC_TOR_PORT)." \
            || warn "Could not set tor_port in $conf_json — set it by hand and restart."
        if systemctl is-active --quiet "$ACC_SERVICE" 2>/dev/null; then
            systemctl restart "$ACC_SERVICE" 2>/dev/null \
                && success "Gateway restarted." \
                || warn "Gateway restart failed — journalctl -u $ACC_SERVICE -n 40"
        fi
    else
        warn "No $conf_json — install the gateway, then re-run this action so"
        warn "its onion listener opens. Until then /tor/, /listen and /wallet/"
        warn "answer 502 over the onion while the static page still loads."
    fi

    # RELOAD before restart, the same order Scripts 01, 04 and 08del use. tor
    # re-reads torrc on SIGHUP and adds or drops hidden services without
    # dropping the process — and this box is not tor's only tenant. A restart
    # takes down the node's onion (Script 04), Fidelius's, the Transporter's,
    # and every in-flight SOCKS circuit the pool's payouts are riding on, for a
    # config change that belongs to Accio alone.
    if ! _acn_tor_reload; then
        error "tor reload and restart both failed — systemctl status tor"
        pause; return 0
    fi

    # tor writes the hostname on first start of a new service; give it a moment.
    local onion="" i
    for i in 1 2 3 4 5 6; do
        if [[ -f "$hs_dir/hostname" ]]; then
            onion=$(tr -d '[:space:]' < "$hs_dir/hostname")
            [[ -n "$onion" ]] && break
        fi
        sleep 2
    done

    if [[ -z "$onion" ]]; then
        warn "tor has not published the hostname yet."
        echo -e "  ${DIM}Check shortly: cat $hs_dir/hostname${RESET}"
        echo -e "  ${DIM}Then re-run this action so the address is recorded and built in.${RESET}"
        pause; return 0
    fi

    local prev; prev="$(_acc_conf_get ACCIO_ONION "")"
    _acc_conf_set ACCIO_ONION "$onion"
    echo ""
    success "Onion address: ${BOLD}$onion${RESET}"
    echo ""
    echo -e "  ${DIM}⚠ BACK UP $hs_dir/ — it holds the SECRET KEY,${RESET}"
    echo -e "  ${DIM}  not just the address. Lose it and the address is gone forever;${RESET}"
    echo -e "  ${DIM}  a new one is a different site to everyone who bookmarked it.${RESET}"

    # The clearnet vhost now has an onion to advertise via Onion-Location.
    local domain; domain="$(_acc_conf_get ACCIO_DOMAIN "")"
    if [[ -n "$domain" ]] && _acn_cert_exists "$domain"; then
        _acn_write_ssl_vhost "$domain" "$onion"
        _acn_reload || true
        success "Onion-Location header added to https://$domain"
    fi

    if [[ "$onion" != "$prev" ]]; then
        _acn_offer_rebuild "TOR_SERVER_ADDRESS is now http://$onion"
    fi

    log "[acn_onion_enable] net=$ACC_NETWORK onion=$onion port=$ACC_TOR_PORT"
    pause
    return 0
}

acn_onion_disable() {
    clear
    echo -e "\n${BOLD}${CYAN}── Accio [$ACC_NET_LABEL] — disable the onion ──${RESET}\n"
    echo -e "  ${DIM}Closes the hidden service and the onion nginx front.${RESET}"
    echo -e "  ${BOLD}The key is KEPT${RESET} ${DIM}($(_acn_hs_dir)) so re-enabling${RESET}"
    echo -e "  ${DIM}gives back the SAME address. Delete that directory only if you${RESET}"
    echo -e "  ${DIM}mean to abandon the address permanently.${RESET}\n"
    echo -ne "  Disable it? [y/N]: "
    local yn; read -r yn || true
    if [[ "${yn,,}" != "y" ]]; then info "Cancelled."; pause; return 0; fi

    _acn_torrc_strip
    rm -f "$(_acn_onion_link)" "$(_acn_onion_vhost)"

    # ⚠ THE GATEWAY'S ONION SNIPPET IS DELIBERATELY KEPT. It used to be deleted
    #   here, which bought nothing — the only thing that ever includes it is the
    #   onion vhost, and that is gone one line above, so it cannot dangle — and
    #   cost something real: _acn_write_onion_vhost only emits the include when
    #   the file exists, so the NEXT enable would silently produce an onion that
    #   serves the wallet page and 404s every send, every listener handshake and
    #   every inbound payment, with nothing on screen to say why. The file is
    #   inert while the onion is off. Leave it where the gateway lib put it.

    local conf_json="$ACC_DIR/gateway.json"
    if [[ -f "$conf_json" ]] && command -v node &>/dev/null; then
        node -e '
            const fs = require("node:fs");
            const file = process.argv[1];
            const d = JSON.parse(fs.readFileSync(file, "utf8"));
            d.tor_port = 0;
            fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
        ' "$conf_json" 2>/dev/null || true
        systemctl is-active --quiet "$ACC_SERVICE" 2>/dev/null \
            && systemctl restart "$ACC_SERVICE" 2>/dev/null || true
    fi

    # Drop Onion-Location from the clearnet vhost — advertising an onion that
    # no longer answers sends every Tor Browser visitor to a dead address.
    _acc_conf_set ACCIO_ONION ""
    local domain; domain="$(_acc_conf_get ACCIO_DOMAIN "")"
    if [[ -n "$domain" ]] && _acn_cert_exists "$domain"; then
        _acn_write_ssl_vhost "$domain" ""
    fi
    _acn_reload || true
    _acn_tor_reload || warn "tor did not reload — the hidden service may still be published."

    success "Onion front disabled. The key is still at $(_acn_hs_dir)."
    _acn_offer_rebuild "the built site still advertises the old onion address"
    pause
    return 0
}

# =============================================================================
# 3) STATUS
# =============================================================================
acn_status() {
    clear
    echo -e "\n${BOLD}${CYAN}── Accio [$ACC_NET_LABEL] — web front status ──${RESET}\n"

    local domain onion vhost
    domain="$(_acc_conf_get ACCIO_DOMAIN "")"
    onion="$(_acc_conf_get ACCIO_ONION "")"
    vhost="$(_acn_vhost)"

    echo -e "  Domain        ${BOLD}${domain:-—}${RESET}"
    if [[ -f "$vhost" ]]; then
        if [[ -L "$(_acn_link)" ]]; then
            echo -e "  Clearnet vhost ${GREEN}$vhost${RESET} ${DIM}(enabled)${RESET}"
        else
            echo -e "  Clearnet vhost ${YELLOW}$vhost — NOT enabled${RESET}"
        fi
        if grep -q 'listen 443' "$vhost" 2>/dev/null; then
            echo -e "  TLS           ${GREEN}yes${RESET}"
        else
            echo -e "  TLS           ${YELLOW}HTTP bootstrap only — certbot has not run${RESET}"
        fi
    else
        echo -e "  Clearnet vhost ${DIM}not deployed${RESET}"
    fi

    if [[ -n "$domain" ]] && _acn_cert_exists "$domain"; then
        echo -e "  Certificate   ${GREEN}expires $(_acn_cert_expiry "$domain")${RESET}"
    else
        echo -e "  Certificate   ${DIM}none${RESET}"
    fi

    echo ""
    if [[ -f "$(_acn_onion_vhost)" ]]; then
        echo -e "  Onion vhost   ${GREEN}$(_acn_onion_vhost)${RESET}"
    else
        echo -e "  Onion vhost   ${DIM}not deployed${RESET}"
    fi
    if [[ -n "$onion" ]]; then
        echo -e "  Onion address ${GREEN}$onion${RESET}"
    elif [[ -f "$(_acn_hs_dir)/hostname" ]]; then
        echo -e "  Onion address ${YELLOW}$(cat "$(_acn_hs_dir)/hostname" 2>/dev/null) — present but NOT recorded${RESET}"
        echo -e "                ${DIM}re-run \"Tor hidden service\" so it is built in${RESET}"
    else
        echo -e "  Onion address ${DIM}none${RESET}"
    fi
    # ⚠ TWO PORTS, CHECKED SEPARATELY, AND THE LABELS SAY WHICH IS WHICH. When
    # these were one number, one line went green whichever process had won the
    # bind — the screen actively hid the collision it existed to show.
    if command -v ss &>/dev/null; then
        local listening; listening=$(ss -ltn 2>/dev/null || true)
        if grep -qF "127.0.0.1:$ACC_TOR_FRONT_PORT " <<< "$listening"; then
            echo -e "  Onion front   ${GREEN}nginx on 127.0.0.1:$ACC_TOR_FRONT_PORT${RESET} ${DIM}(tor points here)${RESET}"
        else
            echo -e "  Onion front   ${DIM}closed — no nginx on 127.0.0.1:$ACC_TOR_FRONT_PORT${RESET}"
        fi
        if grep -qF "127.0.0.1:$ACC_TOR_PORT " <<< "$listening"; then
            echo -e "  Onion gateway ${GREEN}gateway on 127.0.0.1:$ACC_TOR_PORT${RESET} ${DIM}(the front proxies here)${RESET}"
        elif [[ -f "$(_acn_onion_vhost)" ]]; then
            echo -e "  Onion gateway ${YELLOW}nothing on 127.0.0.1:$ACC_TOR_PORT — /tor/, /listen and${RESET}"
            echo -e "                ${YELLOW}/wallet/ answer 502 over the onion${RESET}"
            echo -e "                ${DIM}gateway down, or tor_port still 0 in gateway.json${RESET}"
        else
            echo -e "  Onion gateway ${DIM}closed${RESET}"
        fi
    fi

    echo ""
    if [[ -f "$(_acn_headers)" ]]; then
        echo -e "  Headers       ${GREEN}$(_acn_headers)${RESET}"
    else
        echo -e "  Headers       ${YELLOW}missing — the site has no CSP${RESET}"
    fi
    if [[ -f "$(_acn_tls_headers)" ]]; then
        echo -e "  TLS headers   ${GREEN}$(_acn_tls_headers)${RESET}"
    elif [[ -n "$domain" ]] && _acn_cert_exists "$domain"; then
        echo -e "  TLS headers   ${YELLOW}missing — no HSTS, no Onion-Location${RESET}"
    fi
    if [[ -f "$(_acn_gw_snippet)" ]]; then
        if grep -qF "$(_acn_gw_snippet)" "$vhost" 2>/dev/null; then
            echo -e "  Gateway route ${GREEN}included${RESET}"
        else
            echo -e "  Gateway route ${YELLOW}snippet exists but is NOT included in the vhost${RESET}"
        fi
    else
        echo -e "  Gateway route ${DIM}no snippet — /tor/, /listen, /wallet/ unrouted${RESET}"
    fi

    echo ""
    # The build is the only place HTTPS and the onion are recorded into the
    # served files, so a mismatch here is the "it all looks fine but the address
    # is wrong" failure. Worth its own line.
    local built_https built_onion info_file="${ACC_SITE_DIR}.BUILD_INFO"
    if [[ -f "$info_file" ]]; then
        built_https=$(grep -E '^https=' "$info_file" | cut -d= -f2-)
        built_onion=$(grep -E '^onion=' "$info_file" | cut -d= -f2-)
        echo -e "  Built with    ${DIM}https=${built_https:-?}  onion=${built_onion:-none}${RESET}"
        if [[ "${built_onion:-}" != "$onion" ]]; then
            echo -e "  ${YELLOW}⚠ The built site was made with a different onion value than the${RESET}"
            echo -e "  ${YELLOW}  one configured. Rebuild, or the wallet hands out the wrong${RESET}"
            echo -e "  ${YELLOW}  receiving host to anyone choosing \"Onion Service\".${RESET}"
        fi
    else
        echo -e "  Built with    ${DIM}no build info — the site has never been built here${RESET}"
    fi

    local sa="$(_acn_standalone_dir)/current.html"
    if [[ -f "$sa" ]]; then
        echo -e "  Standalone    ${GREEN}$(du -h "$sa" 2>/dev/null | cut -f1) → /standalone.html${RESET}"
    else
        echo -e "  Standalone    ${DIM}not built (menu 6)${RESET}"
    fi

    pause
    return 0
}

# =============================================================================
# 4) REMOVE
# =============================================================================
acn_remove_web() {
    clear
    echo -e "\n${BOLD}${CYAN}── Accio [$ACC_NET_LABEL] — remove the web front ──${RESET}\n"
    echo -e "  ${DIM}Removes both vhosts, the header snippet and the torrc block.${RESET}"
    echo -e "  ${DIM}KEPT: the built site, the certificate, the onion KEY, the gateway${RESET}"
    echo -e "  ${DIM}and its address table. Nothing here ever held a seed.${RESET}\n"
    echo -ne "  Type ${BOLD}REMOVE${RESET} to confirm: "
    local c; read -r c || true
    if [[ "$c" != "REMOVE" ]]; then info "Cancelled."; pause; return 0; fi

    rm -f "$(_acn_link)" "$(_acn_vhost)"
    rm -f "$(_acn_onion_link)" "$(_acn_onion_vhost)"
    # Both header snippets. Safe to delete in either order: the only files that
    # `include` them are the two vhosts removed above, so neither can be left
    # dangling — and a dangling include is not a broken wallet, it is nginx
    # refusing to START and taking every other vhost on this box with it.
    rm -f "$(_acn_headers)" "$(_acn_tls_headers)"
    _acn_torrc_strip
    _acn_tor_reload || true
    _acn_reload || true
    success "Vhosts and header snippets removed."
    echo -e "  ${DIM}Certificate kept: certbot delete --cert-name $(_acc_conf_get ACCIO_DOMAIN '<domain>')${RESET}"
    echo -e "  ${DIM}Onion key kept:   $(_acn_hs_dir)${RESET}"
    log "[acn_remove_web] net=$ACC_NETWORK"
    pause
    return 0
}

# =============================================================================
# MENU
# =============================================================================
acn_nginx_menu() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN} 052) ACCIO — NGINX, SSL & ONION [$ACC_NET_LABEL]${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        local domain onion
        domain="$(_acc_conf_get ACCIO_DOMAIN "")"
        onion="$(_acc_conf_get ACCIO_ONION "")"
        echo -e "  ${DIM}Domain: ${domain:-not set}${RESET}"
        echo -e "  ${DIM}Onion:  ${onion:-none}${RESET}"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Deploy / update the web front  ${DIM}(vhost + Let's Encrypt)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Tor hidden service             ${DIM}(mint / re-point the onion)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Status"
        echo ""
        echo -e "  ${RED}4${RESET}) Disable the onion  ${DIM}(key kept)${RESET}"
        echo -e "  ${RED}5${RESET}) Remove the web front"
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-5 / 0]: ${RESET}"
        local choice; read -r choice || true
        case "$choice" in
            1) acn_deploy_web   || true ;;
            2) acn_onion_enable || true ;;
            3) acn_status       || true ;;
            4) acn_onion_disable|| true ;;
            5) acn_remove_web   || true ;;
            0) break ;;
            "") continue ;;
            *) echo -e "\n${RED}Invalid option.${RESET}"; sleep 1 ;;
        esac
    done
    return 0
}
