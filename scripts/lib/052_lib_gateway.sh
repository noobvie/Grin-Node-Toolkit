# 052_lib_gateway.sh — Accio (script 052) gateway service: install, nginx glue,
# service control, self-test, uninstall.
#
# Sourced by 052_grin_accio.sh — inherits its colors, info/warn/error/success,
# pause, log, and the ACC_* variables set by acc_set_network.
#
#  Public entries
#    acg_gateway_menu        the "3) Gateway service" screen
#    acg_install_gateway     node + user + app files + config + systemd unit
#    acg_nginx_glue          accio_* rate zones + /tor/, /listen and /wallet/ snippets
#    acg_selftest            16 offline checks; the S3 guard test + the S4b routes
#    acg_service_ctl         start / stop / restart
#    acg_status              service, ports, tor, nginx glue, /health
#    acg_logs                journalctl tail
#    acg_uninstall_gateway   unit + app dir + snippet (leaves the site alone)
#
# ─── What this service is, in one paragraph ──────────────────────────────────
# Accio is self-custodial: the seed is generated in the visitor's browser tab
# and never reaches this box. But a tab can neither open a TCP connection to a
# hidden service nor listen for one, so BOTH directions need a server-side
# helper. That is all this is. Upstream does the outbound job with three custom
# nginx C modules (SOCKS-Proxy, Block-Access, Allow-Headers) and the inbound one
# with an unlicensed C++ daemon (WebSocket-Listener). The modules build as .so
# files against the exact installed nginx, so an `apt upgrade nginx` breaks
# `load_module` and nginx then refuses to start AT ALL — taking Fidelius,
# GrinScan, the pool, Drop and the node API down with it; the daemon has no
# licence and may not be shipped at all. One small Node process instead means
# stock nginx from apt, no apt-mark hold, and nothing we cannot redistribute.
#
# ─── Packet boundary ─────────────────────────────────────────────────────────
# S3 shipped /tor/ (outbound). S4b added /listen and /wallet/<suffix>/v2/foreign
# (inbound) to the SAME service and the SAME unit — not a second one.
#
# ⚠ S4b introduced the first thing this service writes to disk: the suffix ↔
#   session table under $ACC_DIR/gateway-state. Losing it is not a cache miss —
#   the browser client discards any address the gateway stops recognising and
#   mints a new one, so a lost table changes the RECEIVING ADDRESS of every
#   wallet that has ever connected. Back it up with the box; never delete it to
#   "clean up".

# ─── Paths and identity ──────────────────────────────────────────────────────
# A dedicated unprivileged account, NOT `grin`. This process is the only part
# of Accio exposed to bytes chosen by an arbitrary hidden service, and `grin`
# owns node directories, wallet seeds and API secrets belonging to every other
# product on the box. There is nothing for this service to share with them.
ACG_USER="grinaccio"

# The rate-limit zone names. `accio_` prefixed on purpose: zone names are global
# to nginx across every product on this box, and upstream's conf declares bare
# `tor`, `listen` and `wallet` zones, any of which would collide with another
# product that ever wants those words.
ACG_ZONE="accio_tor"
ACG_ZONE_LISTEN="accio_listen"
ACG_ZONE_WALLET="accio_wallet"
ACG_ZONE_CONF="script052-rate-limits"

_acg_app_dir()      { echo "$ACC_GATEWAY_DIR"; }
_acg_conf_json()    { echo "$ACC_DIR/gateway.json"; }
# The suffix ↔ session table (S4b). A SIBLING of the app dir, not inside it:
# the app dir is deleted and rewritten by every install, and this file is what
# stops a reinstall from changing the receiving address of every wallet that
# has ever connected. It is the only thing this service writes to disk.
_acg_state_dir()    { echo "$ACC_DIR/gateway-state"; }
_acg_unit_path()    { echo "/etc/systemd/system/${ACC_SERVICE}.service"; }
_acg_snippet_path() { echo "/etc/nginx/snippets/accio-${ACC_NET_SHORT}-gateway.conf"; }
# The onion front's copy of the same three routes, pointed at the gateway's
# SECOND listener (S7). It is a separate file, not a reuse of the one above,
# because the port IS the trust boundary: the gateway classifies a request by
# socket.localPort, and a snippet that sent onion traffic to $ACC_PORT would
# hand a Tor visitor the nginx front's header handling — the exact forgery the
# port split exists to prevent. Written by acg_nginx_glue; INCLUDED by
# 052_lib_nginx.sh's onion vhost.
_acg_snippet_path_onion() { echo "/etc/nginx/snippets/accio-${ACC_NET_SHORT}-gateway-onion.conf"; }
# Where this lib parks a copy of an nginx file before it edits one. OUTSIDE
# /etc/nginx, and that is not tidiness.
#
# ⚠ Every "is the zone there / is the include there" check in this file and in
#   acg_status is a grep, and a grep does not know that nginx loads
#   conf.d/*.conf but NOT conf.d/x.conf.accio-backup-20260812_120000. A backup
#   left inside the tree answers those greps for as long as it exists — so a
#   zone that nginx does not have reads as present, the snippet referencing it
#   is written anyway, and nginx then refuses to start AT ALL, taking every
#   other vhost on this box with it. That is the one failure this whole file is
#   arranged to prevent, and a backup in the wrong directory reintroduces it.
_acg_backup_dir()   { echo "$ACC_DIR/nginx-backups"; }

# =============================================================================
# PREREQUISITES
# =============================================================================

# Node.js. The gateway has NO npm dependencies (see gateway/socks5.js for why
# SOCKS5 is hand-written rather than pulled from npm), so this is only about the
# runtime, and the bar is low: plain node:http / node:net / node:tls, Node 18+.
# We still offer v24 when nothing is installed, to match 059 and 093 and leave
# one Node on the box rather than two.
_acg_ensure_node() {
    if command -v node &>/dev/null; then
        local major
        major=$(node --version 2>/dev/null | tr -d 'v' | cut -d. -f1)
        if [[ "${major:-0}" -ge 18 ]]; then
            success "Node.js $(node --version) present."
            return 0
        fi
        warn "Node.js $(node --version) is too old — the gateway needs v18+."
    else
        info "Node.js is not installed."
    fi
    echo -ne "  Install Node.js v24 LTS via NodeSource now? [Y/n]: "
    local ok; read -r ok || true
    if [[ "${ok,,}" == "n" ]]; then info "Cancelled."; return 1; fi
    command -v curl &>/dev/null || { apt-get install -y curl 2>/dev/null || yum install -y curl; }
    if [[ -f /etc/debian_version ]]; then
        curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
            || { error "NodeSource setup failed."; return 1; }
        apt-get install -y nodejs || { error "apt-get install nodejs failed."; return 1; }
    elif [[ -f /etc/redhat-release ]]; then
        curl -fsSL https://rpm.nodesource.com/setup_24.x | bash - \
            || { error "NodeSource setup failed."; return 1; }
        yum install -y nodejs || { error "yum install nodejs failed."; return 1; }
    else
        error "Unsupported OS — install Node.js v18+ manually, then re-run."
        return 1
    fi
    success "Node.js $(node --version) installed."
}

# Tor, as a CLIENT only. No hidden service is created here — the onion that
# fronts Accio itself is 052_lib_nginx.sh's job, and it is a different thing
# from the SOCKS proxy this service dials out through.
_acg_ensure_tor() {
    if ! command -v tor &>/dev/null; then
        echo -ne "  tor is not installed — install it now? [Y/n]: "
        local yn; read -r yn || true
        if [[ "${yn,,}" == "n" ]]; then
            warn "Without tor the gateway starts but every /tor/ forward answers 502."
            return 0
        fi
        if command -v apt-get &>/dev/null; then
            apt-get install -y tor || { error "apt-get install tor failed."; return 1; }
        else
            yum install -y tor || { error "yum install tor failed."; return 1; }
        fi
    fi
    systemctl is-active --quiet tor 2>/dev/null || systemctl is-active --quiet tor@default 2>/dev/null || {
        systemctl enable --now tor 2>/dev/null || systemctl enable --now tor@default 2>/dev/null || true
    }
    # Prove the SOCKS port is actually listening rather than trusting the unit
    # state: a tor that is "active" but has SocksPort 0 in torrc looks healthy
    # and forwards nothing.
    if command -v ss &>/dev/null && ss -ltn 2>/dev/null | grep -q '127.0.0.1:9050'; then
        success "Tor SOCKS5 proxy is listening on 127.0.0.1:9050."
    else
        warn "Nothing is listening on 127.0.0.1:9050 — check: systemctl status tor; grep SocksPort /etc/tor/torrc"
    fi
    return 0
}

_acg_ensure_user() {
    if id "$ACG_USER" &>/dev/null; then return 0; fi
    info "Creating system user $ACG_USER (no shell, no home, no login)..."
    if command -v useradd &>/dev/null; then
        useradd --system --no-create-home --shell /usr/sbin/nologin "$ACG_USER" 2>/dev/null \
            || useradd --system --no-create-home --shell /sbin/nologin "$ACG_USER" \
            || { error "useradd $ACG_USER failed."; return 1; }
    else
        error "useradd not available — create the $ACG_USER system account manually."
        return 1
    fi
    success "User $ACG_USER created."
}

# =============================================================================
# 1) INSTALL
# =============================================================================
acg_install_gateway() {
    clear
    echo -e "\n${BOLD}${CYAN}── Accio gateway [$ACC_NET_LABEL] — install ──${RESET}\n"
    echo -e "  ${DIM}One Node process on 127.0.0.1:$ACC_PORT. It holds no key: Accio's${RESET}"
    echo -e "  ${DIM}seed lives in the visitor's browser tab. This only carries bytes${RESET}"
    echo -e "  ${DIM}the tab cannot carry itself — an outbound POST to a payee's onion,${RESET}"
    echo -e "  ${DIM}and an inbound payment relayed down the tab's own WebSocket.${RESET}"
    echo -e "  ${DIM}Zero npm dependencies; the install makes no network request${RESET}"
    echo -e "  ${DIM}beyond installing Node.js and tor if they are absent.${RESET}\n"

    if [[ ! -d "$ACC_GATEWAY_SRC" ]]; then
        error "Gateway source missing: $ACC_GATEWAY_SRC (is the toolkit repo complete?)"
        pause; return 0
    fi
    if [[ ! -f "$ACC_GATEWAY_SRC/server.js" ]]; then
        error "$ACC_GATEWAY_SRC/server.js not found — nothing to install."
        pause; return 0
    fi

    _acg_ensure_node || { pause; return 0; }
    _acg_ensure_tor  || { pause; return 0; }
    _acg_ensure_user || { pause; return 0; }

    local app_dir conf_json state_dir
    app_dir="$(_acg_app_dir)"; conf_json="$(_acg_conf_json)"; state_dir="$(_acg_state_dir)"

    # ── The one directory this service writes to ─────────────────────────────
    # It holds the suffix ↔ session table. If it is lost, every wallet that has
    # ever connected gets a NEW receiving address the next time it reconnects —
    # the client discards a suffix the moment the gateway stops recognising it.
    # So this is created before the service, owned by the service user, and
    # never deleted by an install or an upgrade.
    # Guarded, not bare: this lib is always entered as `fn || true` from a menu,
    # so errexit is OFF for its whole body and a failed mkdir here would sail on
    # to write a unit whose ReadWritePaths names a directory that does not
    # exist. systemd then refuses to start the service with "Failed to set up
    # mount namespacing", which reads as nothing whatsoever to do with a missing
    # directory.
    mkdir -p "$state_dir" || { error "Could not create $state_dir"; pause; return 0; }
    chown "$ACG_USER":"$ACG_USER" "$state_dir" 2>/dev/null || true
    chmod 700 "$state_dir" || { error "Could not chmod 700 $state_dir"; pause; return 0; }
    if [[ -f "$state_dir/listen-state.json" ]]; then
        success "Existing address table kept: $state_dir/listen-state.json"
    else
        success "Address table directory: $state_dir"
    fi

    # Glob every top-level .js rather than naming them: a module added in a
    # later packet would otherwise be missing on the VPS and die at startup as
    # a bare MODULE_NOT_FOUND, which reads as "the service is broken" rather
    # than "a file was not copied".
    info "Copying $ACC_GATEWAY_SRC → $app_dir ..."
    mkdir -p "$app_dir" || { error "Could not create $app_dir"; pause; return 0; }
    cp "$ACC_GATEWAY_SRC"/*.js "$app_dir/" || { error "Copy failed."; pause; return 0; }
    # `if`, never `[[ ... ]] && cmd`: the parent runs under `set -e`, and a
    # false test makes the whole list return 1, which kills the script instead
    # of skipping the copy (CLAUDE.md, menu-loop trap).
    if [[ -f "$ACC_GATEWAY_SRC/package.json" ]]; then
        cp "$ACC_GATEWAY_SRC/package.json" "$app_dir/" || warn "package.json was not copied."
    fi
    # The README goes with it so the unit's Documentation= can point INTO the
    # install rather than back at the toolkit checkout, which an operator is
    # free to move or delete once the deploy is done.
    if [[ -f "$ACC_GATEWAY_SRC/README.md" ]]; then
        cp "$ACC_GATEWAY_SRC/README.md" "$app_dir/" || warn "README.md was not copied."
    fi
    success "Gateway files copied ($(find "$app_dir" -maxdepth 1 -name '*.js' | wc -l) modules)."

    # ── gateway.json ─────────────────────────────────────────────────────────
    # Written fresh every install for the keys this product owns (ports, domain,
    # onion, network), because those come from $ACC_CONF and an install is
    # exactly when they may have changed. Operator-tunable limits are preserved
    # if the file already exists.
    local domain onion
    domain="$(_acc_conf_get ACCIO_DOMAIN "")"
    onion="$(_acc_conf_get ACCIO_ONION "")"

    # ⚠ VALIDATED AT THE POINT OF USE, not only at the prompt. Both menu paths
    #   that record ACCIO_DOMAIN check it (052_grin_accio.sh and 052_lib_nginx.sh
    #   both apply nginx_validate_domain's regex) — but 052_lib_build.sh tells an
    #   operator to "Set ACCIO_DOMAIN= in $ACC_CONF", which goes through neither.
    #   These two values are interpolated straight into the JSON below, so a
    #   stray quote is not merely a typo that breaks the file: a value like
    #     x", "allow_clearnet_destinations": true, "domain": "x
    #   is VALID JSON that turns off the .onion-only destination policy the whole
    #   SSRF story rests on, in a config nobody would re-read afterwards.
    if [[ -n "$domain" && ! "$domain" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$ ]]; then
        error "ACCIO_DOMAIN in $ACC_CONF is not a usable domain name: $domain"
        warn  "Nothing was written. Set it with \"Nginx, SSL & onion\", which validates it."
        pause; return 0
    fi
    if [[ -n "$onion" && ! "$onion" =~ ^[a-z2-7]{56}\.onion$ ]]; then
        error "ACCIO_ONION in $ACC_CONF is not a v3 onion address: $onion"
        warn  "Nothing was written. Re-mint it with \"Nginx, SSL & onion → Tor hidden service\"."
        pause; return 0
    fi
    # tor_port is 0 on a FRESH config — the second listener stays closed until
    # "Nginx, SSL & onion → Tor hidden service" mints the onion and points a
    # second nginx server block at it (that action sets tor_port itself).
    # $ACC_CONF's ACCIO_TOR_PORT records which port that will be; it is not a
    # request to open it now.
    if [[ -z "$domain" ]]; then
        warn "No ACCIO_DOMAIN in $ACC_CONF yet."
        echo -e "  ${DIM}The gateway starts without one; it only means no Origin is on the${RESET}"
        echo -e "  ${DIM}allowlist, so a browser request that carries an Origin header is${RESET}"
        echo -e "  ${DIM}refused. Run \"2) Rebuild site\" once to record the domain, then re-run.${RESET}"
        echo ""
    fi

    if [[ -f "$conf_json" ]]; then
        info "Updating existing $conf_json (limits you tuned are kept)."
        # ⚠ CHECKED, not fire-and-forget. Every key below is one this product
        #   owns, and a silent failure on any of them leaves the service running
        #   on a value from a previous deployment — the wrong network label, an
        #   Origin allowlist for a domain that has moved, or worst of all a
        #   state_dir that never landed.
        #
        #   An S3-era config has none of the S4b keys. config.js defaults them,
        #   so the service starts either way — but state_dir defaults to "" and
        #   the gateway then runs IN MEMORY, changing every wallet's receiving
        #   address on every restart. That is invisible from a running service
        #   (it looks perfectly healthy until the next restart), so a failure to
        #   write it stops the install rather than scrolling past as a warning.
        _acg_json_set "$conf_json" network   "\"$ACC_NETWORK\"" \
            && _acg_json_set "$conf_json" domain    "\"$domain\"" \
            && _acg_json_set "$conf_json" onion     "\"$onion\"" \
            && _acg_json_set "$conf_json" port      "$ACC_PORT" \
            && _acg_json_set "$conf_json" state_dir "\"$state_dir\"" \
            || { error "$conf_json was not fully updated — not touching the service."; pause; return 0; }
        # tor_port stays whatever it is: S7 sets it when the onion exists, and
        # an install must not close a listener the operator already enabled.
    else
        cat > "$conf_json" << CONF || { error "Could not write $conf_json"; pause; return 0; }
{
  "network": "$ACC_NETWORK",
  "domain": "$domain",
  "onion": "$onion",
  "port": $ACC_PORT,
  "tor_port": 0,
  "socks_host": "127.0.0.1",
  "socks_port": 9050,
  "socks_isolate_per_destination": true,
  "allow_clearnet_destinations": false,
  "destination_path_pattern": "^(?:/.+)?/v2/foreign\$",
  "allowed_destination_ports": [80, 443],
  "allow_null_origin": true,
  "allow_extension_origins": true,
  "extra_allowed_origins": [],
  "max_body_bytes": 10485760,
  "connect_timeout_ms": 60000,
  "send_timeout_ms": 120000,
  "read_timeout_ms": 180000,
  "max_concurrent": 64,
  "onion_rate_per_second": 10,
  "onion_burst": 40,

  "listen_enabled": true,
  "state_dir": "$state_dir",
  "state_flush_ms": 2000,
  "state_sweep_ms": 600000,

  "session_ttl_days": 90,
  "max_sessions": 20000,
  "empty_session_ttl_ms": 3600000,
  "session_cookie_name": "accio_session",
  "session_cookie_secure": "auto",

  "suffix_length": 16,
  "max_suffixes_per_session": 16,
  "max_suffixes_total": 100000,

  "max_sockets_per_session": 8,
  "max_sockets_total": 512,
  "ws_max_message_bytes": 262144,
  "ws_ping_interval_ms": 25000,
  "ws_pong_timeout_ms": 20000,
  "ws_message_rate_per_second": 20,
  "ws_message_burst": 60,

  "inbound_body_bytes": 131072,
  "inbound_timeout_ms": 180000,
  "max_inbound_in_flight": 256,
  "max_inbound_per_suffix": 8,
  "onion_inbound_rate_per_second": 5,
  "onion_inbound_burst": 20,

  "log_destinations": false
}
CONF
        success "Config written: $conf_json"
    fi

    # App files are read-only to the service; the config is readable, not
    # writable. The service writes to exactly ONE path — $state_dir, created
    # above and the unit's only ReadWritePaths — and that is the suffix ↔ session
    # table, which is DURABLE STATE, not a cache: lose it and every wallet that
    # ever connected gets a new receiving address. (This comment used to say the
    # gateway "writes nothing to disk at all"; that was true up to S3 and became
    # false at S4b. Left corrected rather than deleted, because acting on the old
    # wording — dropping ReadWritePaths to tighten the unit — is precisely how
    # that address rotation would be reintroduced.)
    #
    # Guarded, like every other write in this lib: "the app files are read-only
    # to the service" is a claim, and a chmod that failed while the install
    # printed nothing is that claim quietly becoming false.
    chown -R root:root "$app_dir" || { error "Could not chown $app_dir to root."; pause; return 0; }
    chmod -R go-w "$app_dir"      || { error "Could not drop group/other write on $app_dir."; pause; return 0; }
    chown root:"$ACG_USER" "$conf_json" 2>/dev/null || true
    chmod 640 "$conf_json"        || { error "Could not chmod 640 $conf_json."; pause; return 0; }

    _acg_write_unit || { pause; return 0; }

    echo ""
    echo -ne "  Enable autostart on boot? [Y/n]: "
    local en; read -r en || true
    if [[ "${en,,}" != "n" ]]; then
        if systemctl enable "$ACC_SERVICE" 2>/dev/null; then success "Autostart enabled."; fi
    fi
    echo -ne "  Start the gateway now? [Y/n]: "
    local st; read -r st || true
    if [[ "${st,,}" != "n" ]]; then
        if systemctl restart "$ACC_SERVICE"; then
            sleep 1
            if systemctl is-active --quiet "$ACC_SERVICE"; then
                success "Gateway running on 127.0.0.1:$ACC_PORT"
            else
                error "Gateway exited immediately — journalctl -u $ACC_SERVICE -n 40"
            fi
        else
            error "systemctl restart failed — journalctl -u $ACC_SERVICE -n 40"
        fi
    fi

    echo ""
    echo -e "  ${DIM}nginx still has to route /tor/ here — that is option 2 on this screen.${RESET}"
    log "[acg_install_gateway] net=$ACC_NETWORK port=$ACC_PORT node=$(node --version 2>/dev/null)"
    pause
    return 0
}

# Minimal JSON value setter. node is guaranteed present by this point.
#
# Returns non-zero when the write did not happen, and it is the CALLER's job to
# act on that. It used to warn and return success, which meant a failure to set
# state_dir — the one key that decides whether every wallet keeps its receiving
# address across a restart — was a single yellow line in a scrolling install.
_acg_json_set() {
    local file="$1" key="$2" raw="$3"
    node -e '
        const fs = require("node:fs");
        const [file, key, raw] = process.argv.slice(1);
        let d = {};
        try { d = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
        d[key] = JSON.parse(raw);
        fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
    ' "$file" "$key" "$raw" 2>/dev/null || { error "Could not update $key in $file"; return 1; }
    return 0
}

_acg_write_unit() {
    local node_bin unit app_dir conf_json state_dir
    node_bin=$(command -v node) || { error "node not found on PATH."; return 1; }
    unit="$(_acg_unit_path)"; app_dir="$(_acg_app_dir)"; conf_json="$(_acg_conf_json)"
    state_dir="$(_acg_state_dir)"

    # ProtectSystem=strict with exactly ONE ReadWritePaths. S3's unit had none,
    # because the gateway wrote nothing at all; S4b has to persist the suffix ↔
    # session table, and that is the whole of it — no DB, no cache, no logs of
    # its own (journald takes stdout). The path is added explicitly rather than
    # relaxing ProtectSystem to `full`, exactly as S3's comment asked.
    # MemoryDenyWriteExecute is deliberately ABSENT: V8 JITs, and setting it
    # makes node fail to start with an error that points nowhere useful.
    #
    # ⚠ S8 ADDED THE EGRESS FILTER, AND IT IS THE STRONGEST CONTROL IN THIS FILE.
    # Every claim this product makes about SSRF rests on one regex in guard.js
    # being right about what a destination may be. IPAddressDeny=any with only
    # localhost allowed moves that from "our filter is correct" to "the kernel
    # will not carry the packet": the process may talk to nginx and to the Tor
    # SOCKS port and to nothing else, so a guard bug becomes a failed connection
    # instead of a request to an address someone chose for us. Everything this
    # service legitimately reaches is on 127.0.0.1 — both listeners bind there
    # and socks_host defaults to it.
    #   ⚠ An operator who points socks_host at a Tor on ANOTHER host must add
    #     that address here, or every forward will fail with EPERM.
    #   On a kernel or systemd without cgroup BPF support these two directives
    #   are logged and ignored, so they cannot stop the service from starting.
    #
    # MemoryMax bounds the blast radius of the tables the listen rail keeps: the
    # inbound budget is 256 × 1 MB of body plus the address table, so half a
    # gigabyte is generous, and being OOM-killed and restarted by systemd is a
    # better failure than taking the node, the pool and Fidelius down with us.
    cat > "$unit" << SYSTEMD || { error "Could not write $unit"; return 1; }
[Unit]
Description=Accio gateway [$ACC_NET_LABEL] — Tor forwarder + inbound listen rail for the Grin browser wallet (script 052)
# Points INTO the install, not back at the toolkit checkout: the repo is the
# operator's to move or delete once a deploy is done, and a Documentation= that
# dangles is worse than none.
Documentation=file://$app_dir/README.md
After=network.target tor.service
Wants=tor.service

[Service]
Type=simple
User=$ACG_USER
Group=$ACG_USER
WorkingDirectory=$app_dir
Environment="NODE_ENV=production"
Environment="ACCIO_GATEWAY_CONF=$conf_json"
ExecStart=$node_bin $app_dir/server.js
Restart=always
RestartSec=5
StartLimitIntervalSec=0
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ReadWritePaths=$state_dir
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
IPAddressDeny=any
IPAddressAllow=localhost
MemoryMax=512M
TasksMax=256
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
CapabilityBoundingSet=
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SYSTEMD
    systemctl daemon-reload
    success "systemd unit: $unit"
    return 0
}

# =============================================================================
# 2) NGINX GLUE
# =============================================================================
# Two artefacts: the shared-memory rate zone (conf.d) and the /tor/ location
# (snippets). Both are idempotent. The vhost include is offered separately
# because editing a live vhost is the one step that can take other sites down,
# so it is nginx -t gated with a restore-on-failure.
acg_nginx_glue() {
    clear
    echo -e "\n${BOLD}${CYAN}── Accio gateway [$ACC_NET_LABEL] — nginx glue ──${RESET}\n"

    if ! command -v nginx &>/dev/null; then
        error "nginx is not installed. Deploy the site first (packet S2)."
        pause; return 0
    fi

    # shellcheck disable=SC1090
    if [[ -f "$SCRIPT_DIR/lib/nginx_shared_helpers.sh" ]]; then
        source "$SCRIPT_DIR/lib/nginx_shared_helpers.sh"
    else
        error "Missing $SCRIPT_DIR/lib/nginx_shared_helpers.sh"
        pause; return 0
    fi

    # ⚠ THE RETURN VALUE IS THE POINT. This function is entered as
    #   `acg_nginx_glue || true`, so errexit is off for its whole body and a
    #   bare call here would discard every refusal _acg_ensure_zones can make.
    #   A snippet naming a zone nginx does not have is not a broken wallet: it
    #   is nginx refusing to START, and every other vhost on this box —
    #   Fidelius, GrinScan, the pool, Drop, the node API — going down with it at
    #   the next reload or reboot. So nothing gets written until the zones are
    #   confirmed present.
    _acg_ensure_zones || {
        error "The rate zones are not in place — no snippet was written."
        echo -e "  ${DIM}This is deliberate: a snippet referencing a missing zone stops nginx${RESET}"
        echo -e "  ${DIM}from starting at all, which takes every other site on this box with${RESET}"
        echo -e "  ${DIM}it. Fix the zones above, then re-run this action.${RESET}"
        pause; return 0
    }

    _acg_write_snippet nginx || { error "Could not write $(_acg_snippet_path)"; pause; return 0; }
    success "Location snippet: $(_acg_snippet_path)"

    # The onion copy is written unconditionally, even with no hidden service
    # configured. It costs one file and nothing includes it until the onion
    # vhost exists — whereas writing it only when the onion is already up means
    # an operator who enables Tor first gets an onion that serves the static
    # page and 404s every gateway route, with nothing on screen to say why.
    _acg_write_snippet onion || { error "Could not write $(_acg_snippet_path_onion)"; pause; return 0; }
    success "Onion-front snippet: $(_acg_snippet_path_onion)"
    echo -e "  ${DIM}(included by the onion vhost — 052_lib_nginx.sh, menu 4)${RESET}"

    echo ""
    echo -e "  ${BOLD}Add the include to the Accio vhost${RESET}"
    echo -e "  ${DIM}One line, inside the server{} block that serves Accio:${RESET}"
    echo -e "  ${CYAN}      include $(_acg_snippet_path);${RESET}"
    echo ""

    local vhost
    vhost="$(_acg_find_vhost)"
    if [[ -z "$vhost" ]]; then
        warn "No Accio vhost found under /etc/nginx/sites-available."
        echo -e "  ${DIM}Deploy the site first (packet S2); it will carry the include itself.${RESET}"
        pause; return 0
    fi
    if grep -qF "$(_acg_snippet_path)" "$vhost" 2>/dev/null; then
        success "Already included in $vhost — nothing to do."
        _acg_reload_nginx
        pause; return 0
    fi

    echo -e "  Found vhost: ${BOLD}$vhost${RESET}"
    echo -ne "  Insert the include into it now? [Y/n]: "
    local yn; read -r yn || true
    if [[ "${yn,,}" == "n" ]]; then info "Left untouched."; pause; return 0; fi

    if _acg_vhost_insert_include "$vhost"; then
        # The include just landed at the END of the server block — after the
        # static-asset regex location that 052_lib_nginx.sh writes. nginx tries
        # regex locations in source order, so the gateway's belong first. That
        # lib can regenerate the vhost with the include correctly placed, and it
        # is idempotent, so ask it to whenever it is available.
        if declare -F acn_refresh_vhost >/dev/null 2>&1; then
            acn_refresh_vhost || true
        elif [[ -f "$SCRIPT_DIR/lib/052_lib_nginx.sh" ]]; then
            # shellcheck disable=SC1090
            source "$SCRIPT_DIR/lib/052_lib_nginx.sh"
            acn_refresh_vhost || true
        else
            warn "052_lib_nginx.sh is missing — the include was appended at the"
            warn "end of the server block. Re-run \"Nginx, SSL & onion → Deploy\""
            warn "once it is back, so the gateway routes sort before the static ones."
        fi
    fi
    pause
    return 0
}

# Three zones now, where S3 wrote one. Never an inline limit_req_zone (CLAUDE.md
# rule 1): zone names live in the global http context, so two products defining
# the same name differently is a hard nginx failure that takes every vhost down.
#
# ⚠ The upgrade path is the whole reason this is a function. nginx_ensure_rate_
# limit_zones is a no-op when its conf file already exists — which is exactly
# the state an S3 box is in, with a file defining accio_tor and nothing else.
# Left alone, the S4b snippet would reference accio_listen and accio_wallet,
# nginx would fail "unknown limit_req_zone", AND NGINX WOULD THEN REFUSE TO
# START AT ALL, taking every other vhost on the box with it. So a missing zone
# has to be detected and the file regenerated on purpose.
#
# ⚠ AND THE SECOND REASON: `grep -r /etc/nginx` IS THE WRONG QUESTION.
# nginx loads nginx.conf, conf.d/*.conf and sites-enabled/* — it does NOT load
# conf.d/script052-rate-limits.conf.accio-backup-20260812_120000. A recursive
# grep reads both, so a zone that survives only in a backup answers "present"
# while nginx has none of it. That is not hypothetical: this function used to
# take its backup INSIDE conf.d, and the duplicate-zone guard inside
# nginx_ensure_rate_limit_zones then found the zone in that very backup and
# skipped writing the file — returning 0, so the caller printed a green
# "Rate zones →" line for a file that did not exist, and the status screen
# agreed with it forever after because it used the same recursive grep. The
# snippets were written regardless, and nginx would refuse to start at the next
# reload. Ask only the files nginx actually reads.
_acg_zone_defined() {
    local zone="$1" f
    for f in /etc/nginx/nginx.conf /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/*; do
        [[ -f "$f" ]] || continue
        if grep -qsE "limit_req_zone[^;]*zone=${zone}[: ]" "$f"; then return 0; fi
    done
    return 1
}

_acg_ensure_zones() {
    local conf_file="/etc/nginx/conf.d/${ACG_ZONE_CONF}.conf"
    local zone missing=""
    for zone in "$ACG_ZONE" "$ACG_ZONE_LISTEN" "$ACG_ZONE_WALLET"; do
        if ! _acg_zone_defined "$zone"; then
            missing="$missing $zone"
        fi
    done

    if [[ -z "$missing" ]]; then
        success "Rate zones present: $ACG_ZONE $ACG_ZONE_LISTEN $ACG_ZONE_WALLET"
        return 0
    fi

    # Only ever regenerate a file we own. If a zone is missing but the file is
    # someone else's, say so and change nothing — a duplicate zone is fatal.
    if [[ -f "$conf_file" ]]; then
        if ! grep -q "Grin Node Toolkit" "$conf_file" 2>/dev/null; then
            error "$conf_file exists but is not ours — add these zones by hand:$missing"
            return 1
        fi
        warn "Adding the S4b zones ($missing) — regenerating $conf_file."
        echo -e "  ${DIM}Any rate you hand-tuned in that file is reset to the defaults.${RESET}"
        # The backup goes to $ACC_DIR/nginx-backups, NEVER beside the original.
        # nginx_ensure_rate_limit_zones refuses to write when it finds any of
        # these zones anywhere under /etc/nginx, and a backup sitting in conf.d
        # is exactly such a find — the regeneration would then be skipped while
        # reporting success. See _acg_backup_dir.
        local bdir; bdir="$(_acg_backup_dir)"
        mkdir -p "$bdir" || { error "Could not create $bdir"; return 1; }
        cp -a "$conf_file" "$bdir/$(basename "$conf_file").$(date +%Y%m%d_%H%M%S)" \
            || { error "Could not back up $conf_file — not regenerating it."; return 1; }
        info "Previous zones backed up to $bdir/"
        rm -f "$conf_file" || { error "Could not remove $conf_file"; return 1; }
    fi

    # Evacuate any backup an EARLIER version of this function left inside
    # conf.d. It is not loaded by nginx (the name does not end in .conf) but it
    # is still read by nginx_ensure_rate_limit_zones' duplicate-zone guard, and
    # one of them is enough to make the write below silently do nothing on a box
    # that has been through the S3→S4b upgrade once already.
    local stale
    for stale in /etc/nginx/conf.d/*.accio-backup-*; do
        [[ -f "$stale" ]] || continue
        mkdir -p "$(_acg_backup_dir)" || break
        if mv "$stale" "$(_acg_backup_dir)/"; then
            warn "Moved a stale backup out of conf.d: $(basename "$stale")"
        else
            error "$stale must be moved out of /etc/nginx — it blocks the zone write."
            return 1
        fi
    done

    # 10r/s each, and they are separate zones rather than one shared one because
    # they are different workloads: a burst of outbound sends must not consume
    # the budget that inbound payments and listener handshakes draw on.
    nginx_ensure_rate_limit_zones "$ACG_ZONE_CONF" \
        "${ACG_ZONE}:10r/s:10m" \
        "${ACG_ZONE_LISTEN}:10r/s:10m" \
        "${ACG_ZONE_WALLET}:10r/s:10m" || true

    # ⚠ VERIFY THE OUTCOME, NOT THE EXIT CODE. nginx_ensure_rate_limit_zones
    #   returns 0 for "wrote it" AND for both of its two skip paths (the file
    #   already exists; a zone is defined elsewhere). Only one of those three
    #   leaves us with usable zones, and trusting the 0 is how this function
    #   came to announce zones it had not written.
    local still_missing=""
    for zone in "$ACG_ZONE" "$ACG_ZONE_LISTEN" "$ACG_ZONE_WALLET"; do
        if ! _acg_zone_defined "$zone"; then still_missing="$still_missing $zone"; fi
    done
    if [[ -n "$still_missing" ]]; then
        error "These zones are still not defined in any file nginx loads:$still_missing"
        echo -e "  ${DIM}Add them by hand to $conf_file, one line each:${RESET}"
        for zone in $still_missing; do
            echo -e "  ${CYAN}      limit_req_zone \$binary_remote_addr zone=${zone}:10m rate=10r/s;${RESET}"
        done
        return 1
    fi
    success "Rate zones → $conf_file"
    return 0
}

# _acg_write_snippet [front]
#   front = nginx (default) → 127.0.0.1:$ACC_PORT,     rate-limited by nginx
#           onion          → 127.0.0.1:$ACC_TOR_PORT,  NOT rate-limited here
#
# ⚠ WHY THE ONION COPY CARRIES NO limit_req. Every Tor visitor arrives from
#   127.0.0.1, so `$binary_remote_addr` is one single key for all of them: a
#   zone that looks per-client is in fact one global bucket, and the first busy
#   visitor 503s everyone else. The gateway already meters the onion front on
#   purpose (onion_rate_per_second / onion_inbound_rate_per_second), which is
#   the same global limit applied knowingly and with a message that explains
#   itself. Adding limit_req here would apply it twice and blame nginx.
_acg_write_snippet() {
    local front="${1:-nginx}" snippet port lr_tor lr_listen lr_wallet front_label
    if [[ "$front" == "onion" ]]; then
        snippet="$(_acg_snippet_path_onion)"; port="$ACC_TOR_PORT"
        # tor does NOT arrive here. It arrives at the nginx onion server block
        # (052_lib_nginx.sh, its own port), and THAT block includes this file to
        # proxy the three routes on to the gateway's second listener below.
        front_label="ONION front (nginx onion block → 127.0.0.1:$ACC_TOR_PORT)"
        lr_tor="    # No limit_req — see 052_lib_gateway.sh; the gateway meters this front."
        lr_listen="$lr_tor"
        lr_wallet="$lr_tor"
    else
        snippet="$(_acg_snippet_path)"; port="$ACC_PORT"
        front_label="NGINX front (clearnet, 127.0.0.1:$ACC_PORT)"
        lr_tor="    limit_req zone=$ACG_ZONE burst=40 delay=20;"
        lr_listen="    limit_req zone=$ACG_ZONE_LISTEN burst=40 delay=20;"
        lr_wallet="    limit_req zone=$ACG_ZONE_WALLET burst=40 delay=20;"
    fi
    # Guarded, and the caller checks: a `cat >` that failed while the caller
    # printed "Location snippet: …" in green is indistinguishable from success,
    # and the vhost include would then name a file that does not exist — which
    # nginx treats the same way it treats a missing zone, by refusing to start.
    mkdir -p /etc/nginx/snippets || { error "Could not create /etc/nginx/snippets"; return 1; }
    cat > "$snippet" << NGINX || { error "Could not write $snippet"; return 1; }
# Grin Node Toolkit — Accio (script 052) gateway routes, $ACC_NET_LABEL.
# $front_label
# Generated by scripts/lib/052_lib_gateway.sh — re-run "Gateway service →
# nginx glue" to regenerate. Include this INSIDE the Accio server{} block:
#
#     include $snippet;
#
# ⚠ THERE IS DELIBERATELY NO add_header IN THIS FILE, AND NONE MAY BE ADDED.
#   An add_header anywhere inside a location block discards EVERY add_header
#   inherited from the enclosing server block. One "harmless" line here would
#   silently strip Content-Security-Policy and Strict-Transport-Security from
#   exactly the route that talks to untrusted hidden services, with no error
#   and no visible symptom. The gateway emits its own Cache-Control instead.
#
# ⚠ THE REGEX ACCEPTS ONE **OR TWO** SLASHES AFTER THE SCHEME.
#   nginx runs with merge_slashes on by default, so by the time this location
#   is matched, /tor/http://abc.onion/v2/foreign has already become
#   /tor/http:/abc.onion/v2/foreign. Upstream's own conf allows both for the
#   same reason. A single-slash-blind regex passes every loopback test and
#   fails for every real browser.
#
# ⚠ TO WHOEVER WRITES THE VHOST: keep \`try_files\` inside \`location / { }\`,
#   NOT in the server block. A server-level try_files is inherited by every
#   location that does not define its own — including this one — and it runs
#   before the content phase, so \`try_files \$uri \$uri/ =404\` would 404 every
#   /tor/ request looking for a file that was never going to exist. (Upstream's
#   own conf does put it at server level and evidently works, so nginx may well
#   treat a proxied location differently; this is cheap insurance either way and
#   it is standard practice regardless.)
#
# The gateway re-checks everything this file does (method, destination, path,
# Origin, Content-Type, body size) because the onion front has no nginx in
# front of it at all. Nothing here is the only copy of a control — except
# limit_req, which needs the real client IP that only nginx knows.

location ~ ^/tor/(https?):/{1,2}(.+/.*)\$ {
$lr_tor
    # Matches the gateway's own max_body_bytes default. The gateway enforces its
    # own copy — this one only spares us carrying a body we would then refuse.
    client_max_body_size 10m;

    proxy_pass http://127.0.0.1:$port;
    proxy_http_version 1.1;
    proxy_set_header Connection "";

    # Off, exactly as upstream has it. Recompressing a wallet's JSON-RPC
    # response buys nothing on a body this small, and compressing a response
    # that mixes attacker-chosen and secret content is how compression side
    # channels start. It also keeps the bytes the onion sent byte-identical.
    gzip off;
    gzip_vary off;

    # Stream both ways: a slate is small, but buffering a proxied body to disk
    # would put payment data on this box's filesystem for no benefit.
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_redirect off;

    # No X-Forwarded-For, no X-Real-IP. The gateway does not rate-limit by IP
    # (this limit_req does), and not sending the visitor's address is one less
    # place it can be logged or leaked toward the payee.

    proxy_connect_timeout 60s;
    proxy_send_timeout 120s;
    # Longer than the gateway's own 180s read timeout, on purpose: the gateway
    # should be the one that answers 504, so the operator sees its message
    # rather than a bare nginx error page.
    proxy_read_timeout 200s;
}

# ─── The inbound rail (packet S4b) ───────────────────────────────────────────
# A browser tab cannot open a listening socket, so a wallet's receiving address
# is a URL on THIS box: the tab holds a WebSocket open on /listen, and every
# POST to /wallet/<suffix>/v2/foreign is relayed down it. Both locations replace
# upstream's WebSocket-Listener daemon, which carries no licence at all and
# therefore cannot be shipped by this toolkit.

location = /listen {
$lr_listen

    proxy_pass http://127.0.0.1:$port;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$http_host;

    # The session cookie IS the ownership proof for a receiving address — the
    # protocol's own \`Own URL\` call carries nothing but the suffix, which is
    # public. This is the only location in this file that forwards a cookie, and
    # the gateway is the only thing that sets one.
    proxy_set_header Cookie \$http_cookie;
    proxy_set_header Origin \$http_origin;

    # Lets the gateway decide whether the session cookie may carry \`Secure\`.
    # It is NOT a client-supplied value here: nginx overwrites whatever the
    # client sent. The gateway ignores this header entirely on the onion front,
    # where nothing overwrites it.
    proxy_set_header X-Forwarded-Proto \$scheme;

    # An idle listener socket is the NORMAL state — a wallet with nothing to
    # receive says nothing for hours. Upstream reaps at 60s; the gateway pings
    # every 25s to stay inside that, but a longer window here halves the
    # reconnect churn, and every reconnect costs an \`Own URL\` per wallet.
    proxy_connect_timeout 60s;
    proxy_send_timeout 120s;
    proxy_read_timeout 120s;

    proxy_buffering off;
    proxy_request_buffering off;
    proxy_redirect off;
    gzip off;
    gzip_vary off;
}

location ~ ^/wallet/[a-zA-Z0-9]{4,64}/v2/foreign\$ {
$lr_wallet

    # ⚠ SET EXPLICITLY. Upstream's own /wallet/ location sets no
    # client_max_body_size at all and silently inherits nginx's 1 MB default —
    # a limit nobody chose. The gateway enforces its own copy of this, because
    # the onion front has no nginx in front of it.
    client_max_body_size 1m;

    proxy_pass http://127.0.0.1:$port;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host \$http_host;

    # No Cookie here, deliberately: this is a PUBLIC payment inbox reached
    # cross-origin by a stranger's wallet. It must never see a credential, and
    # the gateway's cookie is scoped to /listen so a browser would not send one
    # anyway. No X-Forwarded-For either — a payee learns nothing about a payer
    # beyond the slate they were sent.

    proxy_connect_timeout 60s;
    proxy_send_timeout 120s;
    # Longer than the gateway's own inbound_timeout_ms (180s), so the GATEWAY is
    # the one that answers 504 and the sender gets its message. Upstream parks
    # this request for 208 WEEKS; a bounded wait is the whole point.
    proxy_read_timeout 200s;

    proxy_buffering off;
    proxy_request_buffering off;
    proxy_redirect off;
    gzip off;
    gzip_vary off;
}
NGINX
    return 0
}

# Look for the vhost that serves Accio. Checked in order of confidence: the
# name S2's installer will use, then the configured domain, then any vhost that
# already roots at this network's site directory.
_acg_find_vhost() {
    local domain candidate
    domain="$(_acc_conf_get ACCIO_DOMAIN "")"
    for candidate in \
        "/etc/nginx/sites-available/accio-${ACC_NET_SHORT}" \
        "/etc/nginx/sites-available/${domain}" ; do
        if [[ -n "$candidate" && -f "$candidate" ]]; then echo "$candidate"; return 0; fi
    done
    # ⚠ THE TWO EXCLUSIONS ARE NOT TIDYING.
    #
    #   -onion: the onion server block roots at the SAME $ACC_SITE_DIR, so this
    #   fallback would happily return it — and the caller then inserts the
    #   CLEARNET snippet, which proxies to $ACC_PORT, into the onion vhost. That
    #   is precisely the forgery the port split exists to prevent: a Tor visitor
    #   would get the nginx front's header handling, and that snippet's
    #   limit_req, keyed on $binary_remote_addr, becomes ONE global bucket
    #   because every Tor visitor arrives from 127.0.0.1. `nginx -t` passes and
    #   no status screen shows it.
    #
    #   .accio-backup-: a backup is not a vhost. Returning one sends the include
    #   to a file nginx never reads (so /tor/ is silently unrouted), and sends
    #   the UNINSTALL's dangling-include sweep there too — leaving the real
    #   include pointing at a deleted snippet, which stops nginx from starting.
    #
    # `|| true` is load-bearing: with no match grep exits 1, `pipefail` makes the
    # whole pipeline exit 1, and under the parent's `set -e` that KILLS the
    # script instead of returning "no vhost found". It happens to be masked
    # today because every caller writes `vhost="$(_acg_find_vhost)"`, and a
    # library function must not depend on its caller's syntax for that.
    if [[ -d /etc/nginx/sites-available ]]; then
        grep -rls "root ${ACC_SITE_DIR}" /etc/nginx/sites-available 2>/dev/null \
            | grep -v -- '-onion$' \
            | grep -v -- '\.accio-backup-' \
            | head -n1 || true
    fi
    return 0
}

# Insert `include <snippet>;` just before the closing brace of a server block.
# The block chosen is the first one that listens on 443 (the TLS vhost is where
# the wallet is actually served); failing that, the first server block in the
# file. awk tracks brace depth rather than pattern-matching a closing line,
# because a vhost with a nested location{} would otherwise get the include
# planted inside that location.
# _acg_awk_insert <want_ssl 0|1> <snippet path> <vhost> → vhost text on stdout
_acg_awk_insert() {
    local want_ssl="$1" snippet="$2" vhost="$3"
    awk -v inc="    include ${snippet};" -v want_ssl="$want_ssl" '
        BEGIN { depth = 0; inserted = 0; in_server = 0; ssl = 0 }
        {
            line = $0
            if (depth == 0 && line ~ /^[[:space:]]*server[[:space:]]*\{/) { in_server = 1; ssl = 0 }
            if (in_server && (line ~ /listen[^;]*443/ || line ~ /ssl_certificate/)) ssl = 1
            n = gsub(/\{/, "{", line); m = gsub(/\}/, "}", line)
            newdepth = depth + n - m
            # This line closes the server block we are inside: the include goes
            # immediately before it, so it lands at the end of that block.
            if (in_server && depth > 0 && newdepth == 0) {
                if (!inserted && (want_ssl == 0 || ssl == 1)) { print inc; inserted = 1 }
                in_server = 0
            }
            depth = newdepth
            print $0
        }
    ' "$vhost"
}

_acg_vhost_insert_include() {
    local vhost="$1" snippet backup tmp bdir
    snippet="$(_acg_snippet_path)"
    # NOT "${vhost}.accio-backup-…". A copy of the vhost left in
    # sites-available still contains the include line, and acg_status decides
    # whether the include is present by grepping that directory — so one backup
    # makes "vhost include present" report green for good, including after the
    # rollback below has restored a vhost that never had it. See _acg_backup_dir.
    bdir="$(_acg_backup_dir)"
    mkdir -p "$bdir" || { error "Could not create $bdir"; return 1; }
    backup="$bdir/$(basename "$vhost").$(date +%Y%m%d_%H%M%S)"
    tmp="$(mktemp)" || { error "mktemp failed"; return 1; }

    cp -a "$vhost" "$backup" || { error "Could not back up $vhost"; return 1; }

    # Pass 1 targets the TLS block; pass 2 (want_ssl=0) falls back to the first
    # server block, which is the right answer before certbot has run and the
    # file is HTTP-only. Depth is tracked by counting braces rather than by
    # matching a closing line, so a vhost containing nested location{} blocks
    # does not get the include planted inside one of them.
    _acg_awk_insert 1 "$snippet" "$vhost" > "$tmp" 2>/dev/null || true
    if ! grep -qF "$snippet" "$tmp"; then
        _acg_awk_insert 0 "$snippet" "$vhost" > "$tmp" 2>/dev/null || true
    fi

    if ! grep -qF "$snippet" "$tmp"; then
        error "Could not find a server{} block in $vhost — add the include by hand."
        rm -f "$tmp" "$backup"
        return 1
    fi

    cat "$tmp" > "$vhost"
    rm -f "$tmp"

    if nginx -t 2>/dev/null; then
        success "Include added to $vhost (backup: $backup)"
        _acg_reload_nginx
        return 0
    fi
    # A broken nginx config does not just break Accio — nginx refuses to start
    # and every vhost on the box goes with it. Roll back, always.
    error "nginx -t failed after the edit — restoring $vhost from the backup."
    nginx -t 2>&1 | sed 's/^/    /' || true
    cat "$backup" > "$vhost"
    warn "Restored. Add the include by hand: include $snippet;"
    return 1
}

_acg_reload_nginx() {
    if nginx -t 2>/dev/null; then
        if systemctl reload nginx 2>/dev/null; then
            success "nginx reloaded."
        else
            warn "nginx -t passed but reload failed — check: systemctl status nginx"
        fi
        return 0
    fi
    error "nginx -t failed — NOT reloading. Fix the config first:"
    nginx -t 2>&1 | sed 's/^/    /' || true
    return 1
}

# =============================================================================
# 3) SELF-TEST — this IS packet S3's guard verification
# =============================================================================
# Sixteen results: fifteen HTTP probes plus one property check (the durability
# of the address table, which no probe can express). All against 127.0.0.1,
# none contacting Tor or leaving the box, so this runs in under a second and
# can be repeated after any change.
# The design's stated check — "a /tor/http://127.0.0.1:3413/... request is
# refused" — is probe 3.
#
# What this does NOT prove is the end-to-end send; that needs a real payee and
# is the browser half of S3's verification.
acg_selftest() {
    clear
    echo -e "\n${BOLD}${CYAN}── Accio gateway [$ACC_NET_LABEL] — self-test ──${RESET}\n"

    if ! systemctl is-active --quiet "$ACC_SERVICE" 2>/dev/null; then
        error "$ACC_SERVICE is not running — start it first."
        pause; return 0
    fi
    command -v curl &>/dev/null || { error "curl is required for the self-test."; pause; return 0; }

    local base="http://127.0.0.1:$ACC_PORT"
    # A syntactically valid v3 onion (56 base32 chars) that does not exist. Used
    # only where the probe must be REFUSED before any network call, so it is
    # never dialled.
    local onion="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad.onion"
    local pass=0 fail=0

    _acg_probe() {
        local want="$1" label="$2"; shift 2
        local got
        got=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@" 2>/dev/null) || got="000"
        if [[ "$got" == "$want" ]]; then
            echo -e "  ${GREEN}PASS${RESET}  $label ${DIM}($got)${RESET}"
            pass=$((pass + 1))
        else
            echo -e "  ${RED}FAIL${RESET}  $label ${DIM}(wanted $want, got $got)${RESET}"
            fail=$((fail + 1))
        fi
    }

    echo -e "  ${DIM}Reachability${RESET}"
    _acg_probe 200 "/health answers" "$base/health"

    echo ""
    echo -e "  ${DIM}The SSRF guard — the reason this gateway is ours and not a module${RESET}"
    _acg_probe 403 "loopback destination refused" \
        -X POST -H 'Content-Type: application/json' --data '{}' \
        "$base/tor/http://127.0.0.1:3413/v2/foreign"
    _acg_probe 403 "loopback refused via the merged-slash form too" \
        -X POST -H 'Content-Type: application/json' --data '{}' \
        "$base/tor/http:/127.0.0.1:3413/v2/foreign"
    _acg_probe 403 "'localhost' name refused" \
        -X POST -H 'Content-Type: application/json' --data '{}' \
        "$base/tor/http://localhost:3413/v2/foreign"
    _acg_probe 403 "malformed onion label refused" \
        -X POST -H 'Content-Type: application/json' --data '{}' \
        "$base/tor/http://evil.onion/v2/foreign"

    echo ""
    echo -e "  ${DIM}Request policy (mirrors upstream's Block-Access directives)${RESET}"
    _acg_probe 405 "GET refused (POST and OPTIONS only)" \
        "$base/tor/http://$onion/v2/foreign"
    _acg_probe 403 "non-Foreign-API path refused" \
        -X POST -H 'Content-Type: application/json' --data '{}' \
        "$base/tor/http://$onion/v2/owner"
    _acg_probe 415 "non-JSON POST refused" \
        -X POST -H 'Content-Type: text/plain' --data 'x' \
        "$base/tor/http://$onion/v2/foreign"
    _acg_probe 403 "foreign Origin refused" \
        -X POST -H 'Content-Type: application/json' -H 'Origin: https://evil.example' --data '{}' \
        "$base/tor/http://$onion/v2/foreign"

    # ── The inbound rail (S4b) ───────────────────────────────────────────────
    # Every probe here is a REFUSAL, on purpose: a successful receive needs a
    # browser holding a WebSocket open and a real payer, which is the end-to-end
    # half of this packet's verification and cannot be done with curl.
    echo ""
    echo -e "  ${DIM}The inbound rail — /listen + /wallet/<suffix>/v2/foreign${RESET}"
    # 16 lowercase base32 characters that we did not mint, so it cannot exist.
    local nosuch="aaaaaaaaaaaaaaaa"
    _acg_probe 404 "an unknown address is 404, not a hung request" \
        -X POST -H 'Content-Type: application/json' --data '{}' \
        "$base/wallet/$nosuch/v2/foreign"
    _acg_probe 204 "CORS preflight is answered by the gateway" \
        -X OPTIONS "$base/wallet/$nosuch/v2/foreign"
    _acg_probe 415 "a non-JSON payment body is refused" \
        -X POST -H 'Content-Type: text/plain' --data 'x' \
        "$base/wallet/$nosuch/v2/foreign"
    _acg_probe 405 "GET on an address is refused" \
        "$base/wallet/$nosuch/v2/foreign"
    _acg_probe 404 "a non-Foreign-API path under /wallet/ is refused" \
        -X POST -H 'Content-Type: application/json' --data '{}' \
        "$base/wallet/$nosuch/v2/owner"
    # 426, not 400. server.js answers a plain GET on /listen with
    # `426 Upgrade Required` and an `Upgrade: websocket` header, deliberately —
    # it is the correct status and a self-explaining one for whoever is holding
    # the curl. This probe asserted 400 and so FAILED on a perfectly healthy
    # gateway, printing "do not proceed to a real send" on the one screen that
    # gates the first real send. An assertion that cries wolf is worse than no
    # assertion: it teaches the operator to read past a red self-test.
    _acg_probe 426 "/listen refuses a plain HTTP GET (it wants a websocket upgrade)" \
        "$base/listen"

    # Not a probe — a property. An in-memory table means every wallet's
    # receiving address changes on the next restart, and nothing else on this
    # screen would reveal it.
    echo ""
    # curl was already required at the top of this function, so no second test.
    local durable
    durable=$(curl -s --max-time 3 "$base/health" 2>/dev/null | grep -o '"durable": *true' || true)
    if [[ -n "$durable" ]]; then
        echo -e "  ${GREEN}PASS${RESET}  the address table is durable ${DIM}(survives a restart)${RESET}"
        pass=$((pass + 1))
    else
        echo -e "  ${RED}FAIL${RESET}  the address table is IN MEMORY — every restart changes every address"
        echo -e "        ${DIM}set \"state_dir\" in $(_acg_conf_json) and restart${RESET}"
        fail=$((fail + 1))
    fi

    echo ""
    if [[ "$fail" -eq 0 ]]; then
        success "$pass/$((pass + fail)) probes passed."
        echo -e "  ${DIM}Still owed, and it needs a browser: send tGRIN from the wallet page${RESET}"
        echo -e "  ${DIM}to a Fidelius onion address and confirm it arrives.${RESET}"
    else
        error "$fail of $((pass + fail)) probes failed — do not proceed to a real send."
        echo -e "  ${DIM}journalctl -u $ACC_SERVICE -n 40${RESET}"
    fi
    log "[acg_selftest] pass=$pass fail=$fail"
    pause
    return 0
}

# =============================================================================
# 4) SERVICE CONTROL / STATUS / LOGS / UNINSTALL
# =============================================================================
acg_service_ctl() {
    local action="$1"
    if [[ ! -f "$(_acg_unit_path)" ]]; then
        error "Not installed — no $(_acg_unit_path)."
        pause; return 0
    fi
    if systemctl "$action" "$ACC_SERVICE"; then
        success "$action → $ACC_SERVICE"
    else
        error "$action failed — journalctl -u $ACC_SERVICE -n 40"
    fi
    sleep 1
    pause
    return 0
}

acg_status() {
    clear
    echo -e "\n${BOLD}${CYAN}── Accio gateway [$ACC_NET_LABEL] — status ──${RESET}\n"

    local unit; unit="$(_acg_unit_path)"
    if [[ -f "$unit" ]]; then
        echo -e "  Unit          ${GREEN}$unit${RESET}"
    else
        echo -e "  Unit          ${DIM}not installed${RESET}"
    fi
    if systemctl is-active --quiet "$ACC_SERVICE" 2>/dev/null; then
        echo -e "  Service       ${GREEN}● running${RESET}  ($ACC_SERVICE)"
    else
        echo -e "  Service       ${YELLOW}stopped${RESET}  ($ACC_SERVICE)"
    fi
    if systemctl is-enabled --quiet "$ACC_SERVICE" 2>/dev/null; then
        echo -e "  Autostart     ${GREEN}enabled${RESET}"
    else
        echo -e "  Autostart     ${DIM}disabled${RESET}"
    fi

    echo ""
    if command -v ss &>/dev/null; then
        if ss -ltn 2>/dev/null | grep -q "127.0.0.1:$ACC_PORT"; then
            echo -e "  nginx front   ${GREEN}127.0.0.1:$ACC_PORT${RESET}"
        else
            echo -e "  nginx front   ${YELLOW}not listening on 127.0.0.1:$ACC_PORT${RESET}"
        fi
        # THIS LISTENER IS THE GATEWAY'S, not the nginx block tor talks to —
        # those are two ports (see the port map in 052_grin_accio.sh). Say which
        # one this line is about, or a green light here reads as "the onion
        # works" when nginx may have nothing bound at all.
        if ss -ltn 2>/dev/null | grep -q "127.0.0.1:$ACC_TOR_PORT"; then
            echo -e "  onion front   ${GREEN}127.0.0.1:$ACC_TOR_PORT${RESET} ${DIM}(this service; nginx fronts it)${RESET}"
        else
            echo -e "  onion front   ${DIM}closed — enable it in \"Nginx, SSL & onion\"${RESET}"
        fi
        if ss -ltn 2>/dev/null | grep -q '127.0.0.1:9050'; then
            echo -e "  Tor SOCKS5    ${GREEN}127.0.0.1:9050${RESET}"
        else
            echo -e "  Tor SOCKS5    ${RED}absent — every /tor/ forward will answer 502${RESET}"
        fi
    fi

    echo ""
    local snippet vhost_found
    snippet="$(_acg_snippet_path)"
    vhost_found="$(_acg_find_vhost)"
    if [[ -f "$snippet" ]]; then
        echo -e "  nginx snippet ${GREEN}$snippet${RESET}"
        # sites-ENABLED, because that is what nginx loads. Grepping
        # sites-available as well was how a stale copy of a vhost — or, before
        # this lib moved its backups out of the tree, one of our own — could
        # report the include as present after the live vhost had lost it.
        if grep -rqsF "$snippet" /etc/nginx/sites-enabled 2>/dev/null; then
            echo -e "  vhost include ${GREEN}present${RESET}"
        elif [[ -n "$vhost_found" ]] && grep -qsF "$snippet" "$vhost_found"; then
            echo -e "  vhost include ${YELLOW}in $vhost_found, but that vhost is not enabled${RESET}"
        else
            echo -e "  vhost include ${YELLOW}MISSING — /tor/ is not routed to the gateway${RESET}"
        fi
    else
        echo -e "  nginx snippet ${DIM}not written${RESET}"
    fi
    local zone zones_ok=1 zone_list=""
    for zone in "$ACG_ZONE" "$ACG_ZONE_LISTEN" "$ACG_ZONE_WALLET"; do
        # _acg_zone_defined, not a recursive grep: a zone surviving only in a
        # backup file is a zone nginx does not have, and reporting it green here
        # is how the missing-zone outage stays invisible.
        if _acg_zone_defined "$zone"; then
            zone_list="$zone_list $zone"
        else
            zones_ok=0
            zone_list="$zone_list ${RED}${zone}(missing)${RESET}"
        fi
    done
    if [[ "$zones_ok" -eq 1 ]]; then
        echo -e "  rate zones    ${GREEN}${zone_list# }${RESET}"
    else
        echo -e "  rate zones    ${YELLOW}${zone_list# }${RESET}"
        echo -e "                ${DIM}re-run \"nginx glue\" — nginx will not start with a zone missing${RESET}"
    fi

    # ── The address table ────────────────────────────────────────────────────
    # Shown as a first-class fact, not buried in /health: if this is absent or
    # in-memory, every wallet's receiving address changes at the next restart.
    echo ""
    local state_file; state_file="$(_acg_state_dir)/listen-state.json"
    if [[ -f "$state_file" ]]; then
        echo -e "  address table ${GREEN}$state_file${RESET}"
        echo -e "                ${DIM}$(stat -c '%s bytes, modified %y' "$state_file" 2>/dev/null | cut -d. -f1)${RESET}"
        echo -e "                ${DIM}⚠ back this up — losing it changes every wallet's address${RESET}"
    elif [[ -d "$(_acg_state_dir)" ]]; then
        echo -e "  address table ${DIM}$(_acg_state_dir) — empty (no wallet has connected yet)${RESET}"
    else
        echo -e "  address table ${YELLOW}no state directory — run Install${RESET}"
    fi

    echo ""
    if command -v curl &>/dev/null && systemctl is-active --quiet "$ACC_SERVICE" 2>/dev/null; then
        echo -e "  ${DIM}/health:${RESET}"
        curl -s --max-time 3 "http://127.0.0.1:$ACC_PORT/health" 2>/dev/null | sed 's/^/    /' \
            || echo -e "    ${YELLOW}no answer${RESET}"
    fi
    pause
    return 0
}

acg_logs() {
    clear
    echo -e "\n${BOLD}${CYAN}── Accio gateway [$ACC_NET_LABEL] — logs ──${RESET}\n"
    echo -e "  ${DIM}Destinations are NOT logged unless log_destinations is turned on in${RESET}"
    echo -e "  ${DIM}$(_acg_conf_json) — a /tor/ destination is the payee's${RESET}"
    echo -e "  ${DIM}wallet address, and a journal of those is a payment graph.${RESET}\n"
    journalctl -u "$ACC_SERVICE" -n 60 --no-pager 2>/dev/null || warn "No journal entries."
    pause
    return 0
}

acg_uninstall_gateway() {
    clear
    echo -e "\n${BOLD}${CYAN}── Accio gateway [$ACC_NET_LABEL] — uninstall ──${RESET}\n"
    echo -e "  ${DIM}Removes the service, its files and the nginx snippet.${RESET}"
    echo -e "  ${DIM}The built site, the vhost and the certificate are left alone.${RESET}"
    echo -e "  ${DIM}No custody risk either way — nothing here ever held a key.${RESET}\n"
    echo -e "  ${BOLD}The address table is KEPT${RESET} ${DIM}($(_acg_state_dir))${RESET}"
    echo -e "  ${DIM}so a reinstall gives every wallet back the address it already${RESET}"
    echo -e "  ${DIM}has. Delete that directory only if you intend every existing${RESET}"
    echo -e "  ${DIM}receiving address to stop working — payments sent to an old${RESET}"
    echo -e "  ${DIM}address after that are answered 404 with nothing to explain it.${RESET}\n"
    echo -ne "  Type ${BOLD}REMOVE${RESET} to confirm: "
    local c; read -r c || true
    if [[ "$c" != "REMOVE" ]]; then info "Cancelled."; pause; return 0; fi

    systemctl disable --now "$ACC_SERVICE" 2>/dev/null || true
    rm -f "$(_acg_unit_path)"
    systemctl daemon-reload 2>/dev/null || true
    # `:?` on the variable, not on the accessor: if acc_set_network were ever
    # skipped this expands to nothing and `rm -rf ""` is a no-op that reads as
    # success. Matches acc_uninstall in 052_grin_accio.sh.
    rm -rf "${ACC_GATEWAY_DIR:?}"
    rm -f "$(_acg_snippet_path)" "$(_acg_snippet_path_onion)"
    success "Service, app files and snippets removed."

    # The include would now point at a file that no longer exists, and nginx
    # refuses to start on a missing include — which would take every other
    # vhost on this box down at the next reload or reboot.
    #
    # BOTH vhosts have to be swept, not just the clearnet one: since S7 the
    # onion vhost includes its own gateway snippet, and leaving that include
    # behind is the same box-wide outage by a different file name.
    # ⚠ SWEEP EVERY VHOST, not the two we can name. acg_nginx_glue targets
    #   _acg_find_vhost, which will pick sites-available/<domain> or any vhost
    #   whose root is the site dir — so an include can be living in a file this
    #   function cannot predict, and one that is missed is the box-wide outage
    #   above. This is the same grep-driven sweep acc_uninstall does in
    #   052_grin_accio.sh, and the two must not drift apart.
    #
    # ⚠ `%` AS THE SED DELIMITER, not the `\|…|d` this used to carry. That form
    #   worked only for as long as the pattern held no alternation: `|` is both
    #   the delimiter and the ERE alternation operator, so the first person to
    #   add one closes the address early and gets "sed: unmatched (" during a
    #   live uninstall. The pattern already contains a group; do not tempt it.
    local vhost cleaned=0
    if [[ -d /etc/nginx/sites-available ]]; then
        while IFS= read -r vhost; do
            [[ -n "$vhost" && -f "$vhost" ]] || continue
            warn "Removing the now-dangling include from $vhost"
            if sed -i -E "\%accio-${ACC_NET_SHORT}-gateway(-onion)?\.conf%d" "$vhost"; then
                cleaned=1
            else
                error "Could not edit $vhost — remove the include line by hand NOW:"
                error "  nginx refuses to START on an include naming a file that is gone."
            fi
        # sites-AVAILABLE only, deliberately. A sites-enabled entry is a symlink
        # to the file we are already editing, and `sed -i` does not edit through
        # a symlink — it REPLACES it with a regular file, silently severing the
        # available↔enabled pair so the next edit to the real vhost changes
        # nothing that nginx loads.
        done < <(grep -rlsE "accio-${ACC_NET_SHORT}-gateway(-onion)?\.conf" \
                     /etc/nginx/sites-available 2>/dev/null \
                 | grep -v -- '\.accio-backup-' | sort -u || true)
    fi
    if [[ "$cleaned" -eq 1 ]]; then _acg_reload_nginx || true; fi
    # The rate zones and the system user are shared with the other network's
    # instance, so none of them is removed here. The address table is kept for
    # the reason printed above.
    echo -e "  ${DIM}Left in place: the accio_* rate zones and the $ACG_USER user${RESET}"
    echo -e "  ${DIM}(shared with the other network's gateway), the address table${RESET}"
    echo -e "  ${DIM}at $(_acg_state_dir), and the pre-edit${RESET}"
    echo -e "  ${DIM}copies of any nginx file this product touched, at $(_acg_backup_dir).${RESET}"
    log "[acg_uninstall_gateway] net=$ACC_NETWORK"
    pause
    return 0
}

# =============================================================================
# MENU
# =============================================================================
acg_gateway_menu() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN} 052) ACCIO — GATEWAY SERVICE [$ACC_NET_LABEL]${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  ${DIM}$ACC_SERVICE on 127.0.0.1:$ACC_PORT — /tor/ out, /listen + /wallet/ in.${RESET}"
        echo -e "  ${DIM}It holds no key: Accio's seed lives in the visitor's browser tab.${RESET}"
        echo -e "  ${DIM}It does hold the address table — see Status before uninstalling.${RESET}"
        echo ""
        if systemctl is-active --quiet "$ACC_SERVICE" 2>/dev/null; then
            echo -e "  State: ${GREEN}● running${RESET}"
        elif [[ -f "$(_acg_unit_path)" ]]; then
            echo -e "  State: ${YELLOW}installed, stopped${RESET}"
        else
            echo -e "  State: ${DIM}not installed${RESET}"
        fi
        echo ""
        echo -e "  ${GREEN}1${RESET}) Install / update     ${DIM}(node, user, files, config, unit)${RESET}"
        echo -e "  ${GREEN}2${RESET}) nginx glue           ${DIM}(rate zone + /tor/ location + include)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Self-test            ${DIM}(16 offline checks: guard + inbound rail)${RESET}"
        echo ""
        echo -e "  ${GREEN}4${RESET}) Start        ${GREEN}5${RESET}) Stop        ${GREEN}6${RESET}) Restart"
        echo -e "  ${GREEN}7${RESET}) Status       ${GREEN}8${RESET}) Logs"
        echo ""
        echo -e "  ${RED}9${RESET}) Uninstall gateway"
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-9 / 0]: ${RESET}"
        local choice; read -r choice || true
        case "$choice" in
            1) acg_install_gateway   || true ;;
            2) acg_nginx_glue        || true ;;
            3) acg_selftest          || true ;;
            4) acg_service_ctl start   || true ;;
            5) acg_service_ctl stop    || true ;;
            6) acg_service_ctl restart || true ;;
            7) acg_status            || true ;;
            8) acg_logs              || true ;;
            9) acg_uninstall_gateway || true ;;
            0) break ;;
            "") continue ;;
            *) echo -e "\n${RED}Invalid option.${RESET}"; sleep 1 ;;
        esac
    done
    return 0
}
