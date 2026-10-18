# =============================================================================
# 07_lib_pool_install.sh — Install, configure, deploy and guided-setup sections of the public pool script (menus 1/2/3/9/G).
# =============================================================================
# Sourced by 07_grin_mining_public_pool.sh after the POOL_* constants; shares its globals and log/info/warn/error.
# Trap: moved as-is; runs with errexit off (callers guard with `|| true`), so its file operations are not individually guarded.

# ═══════════════════════════════════════════════════════════════════════════════
# 1) INSTALL
# ═══════════════════════════════════════════════════════════════════════════════

# Ensure Node.js 24+ (node:sqlite needs >= 24). Installs or upgrades via
# NodeSource when the box has no node or one that is too old. Used by the pool
# (singlebox/hub) install — regional gateways run no Node and don't call this.
pool_ensure_node24() {
    local node_ver=0
    command -v node &>/dev/null && \
        node_ver=$(node -e 'process.stdout.write(process.version.slice(1).split(".")[0])' 2>/dev/null || echo 0)
    if [[ "$node_ver" -ge 24 ]]; then
        success "Node.js $(node --version 2>/dev/null) found."
        return 0
    fi
    if [[ "$node_ver" -gt 0 ]]; then
        warn "Node.js v${node_ver} found — the pool requires v24+ (node:sqlite). Upgrading via NodeSource..."
    else
        info "Node.js not found — installing v24 LTS via NodeSource..."
    fi
    if command -v apt-get &>/dev/null; then
        # Distro nodejs/npm packages conflict with NodeSource — remove them first.
        apt-get remove -y nodejs npm 2>/dev/null || true
        apt-get autoremove -y 2>/dev/null || true
        curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
            || { error "NodeSource setup failed."; return 1; }
        apt-get install -y nodejs 2>&1 | tail -3 \
            || { error "Node.js install failed."; return 1; }
    elif command -v dnf &>/dev/null; then
        dnf remove -y nodejs npm 2>/dev/null || true
        curl -fsSL https://rpm.nodesource.com/setup_24.x | bash - \
            || { error "NodeSource setup failed."; return 1; }
        dnf install -y nodejs 2>&1 | tail -3 \
            || { error "Node.js install failed."; return 1; }
    else
        error "No apt/dnf found — install Node.js 24+ manually from https://nodejs.org/."
        return 1
    fi
    success "Node.js installed: $(node --version)"
}

# ─── De-root the pool backend (design §13.9) ───────────────────────────────────
# Creates the grinpool service user, sweeps ownership of everything the backend
# must write (app dir + pool.db + .wallet_pass + uploads, pool.json, wallet dir,
# log), grants group-read on the node's TWO secret files via the grinsecret group
# (lib/grin-node.js reads .api_secret AND .foreign_api_secret directly), and
# writes the one-line scoped sudoers so the backend may run grin-gateway-ctl as
# root — and nothing else. Idempotent: runs on every install/upgrade; on a live
# box a re-run of 1) Install migrates the old root service in place.
# Honest caveat (script07_security_audit.md §Residual risks): this does NOT
# protect the hot wallet — the backend must be able to spend by design. It
# protects the box, the WG/node/LE keys, and the other products on it.
pool_deroot() {
    if ! id grinpool &>/dev/null; then
        useradd -r -s /usr/sbin/nologin grinpool 2>/dev/null \
            || useradd -r -s /sbin/nologin grinpool 2>/dev/null \
            || { error "Could not create the grinpool service user."; return 1; }
        info "Created service user grinpool."
    fi
    getent group grinsecret >/dev/null 2>&1 || groupadd -r grinsecret 2>/dev/null || true
    usermod -aG grinsecret grinpool 2>/dev/null || true

    # Ownership sweep — reclaims root-owned leftovers from the pre-de-root era.
    # ||-guarded: a chown hiccup must not abort the whole install under set -e.
    [[ -d "$POOL_APP_DIR" ]] && { chown -R grinpool:grinpool "$POOL_APP_DIR" 2>/dev/null || true; }
    [[ -f "$POOL_CONF" ]] && { chown grinpool:grinpool "$POOL_CONF" 2>/dev/null || true; }
    local wdir; wdir=$(pw_wallet_dir 2>/dev/null || echo "$POOL_WALLET_DIR")
    [[ -d "$wdir" ]] && { chown -R grinpool:grinpool "$wdir" 2>/dev/null || true; }
    touch "$POOL_LOG" 2>/dev/null || true
    chown grinpool:grinpool "$POOL_LOG" 2>/dev/null || true

    # Node secrets → group-read (640 root:grinsecret), never world-read. A node
    # rebuild regenerates them 600 root-only; grin_sync_pool_stratum (secret
    # self-heal chain) re-applies this, so it heals without operator action.
    local ndir sf
    ndir=$(grin_live_node_dir "$POOL_NET" 2>/dev/null || true)
    if [[ -n "$ndir" ]]; then
        for sf in "$ndir/.api_secret" "$ndir/.foreign_api_secret"; do
            [[ -f "$sf" ]] || continue
            chgrp grinsecret "$sf" 2>/dev/null || true
            chmod 640 "$sf" 2>/dev/null || true
        done
    fi

    # Scoped sudo: grin-gateway-ctl is root-owned 0755 (root-writable only), so
    # this cannot be parlayed into arbitrary root by the grinpool user.
    cat > /etc/sudoers.d/grin-pool-gwctl <<'EOF'
# grin-node-toolkit: de-rooted pool backend → gateway pairing helper (design §13.9)
grinpool ALL=(root) NOPASSWD: /usr/local/bin/grin-gateway-ctl
EOF
    chmod 440 /etc/sudoers.d/grin-pool-gwctl
    if command -v visudo &>/dev/null && ! visudo -c -f /etc/sudoers.d/grin-pool-gwctl >/dev/null 2>&1; then
        rm -f /etc/sudoers.d/grin-pool-gwctl
        warn "sudoers validation failed — removed grin-pool-gwctl entry (panel gateway pairing disabled)."
    fi
    success "grinpool service user ready — ownership swept, node secrets group-read, scoped sudo installed."
}

pool_install() {
    echo -e "\n${BOLD}Installing Pool Manager (${POOL_NET_LABEL})...${RESET}\n"

    # rc 1 on a guard block (not 0): the guided flow must treat a refused install
    # as a failure and abort, not continue to Configure on a blocked box.
    pool_check_exclusivity || return 1
    # Defense-in-depth: refuse if a gateway (or legacy satellite) already occupies this
    # box (in case the selector guard was bypassed via a direct/non-interactive entry).
    pool_mode_conflict_check "${POOL_MODE:-singlebox}" || return 1

    if [[ ! -d "$POOL_APP_SRC" ]]; then
        error "Pool app source not found: $POOL_APP_SRC"
        error "Run this script from within the GRINIUM repository."
        return 1
    fi
    if [[ ! -f "$POOL_APP_SRC/package.json" ]]; then
        error "package.json not found in $POOL_APP_SRC"
        return 1
    fi

    info "Checking system packages..."
    # No build-essential/gcc-c++: the pool has no native npm modules since the
    # better-sqlite3 → node:sqlite migration (everything else is pure JS).
    if command -v apt-get &>/dev/null; then
        apt-get install -y logrotate sqlite3 2>&1 | tail -5
    elif command -v dnf &>/dev/null; then
        # RHEL-family names the CLI package `sqlite` (it ships /usr/bin/sqlite3);
        # `dnf install sqlite3` fails — and the pipe to tail masks the failure.
        dnf install -y logrotate sqlite 2>&1 | tail -5
    fi

    pool_ensure_node24 || return 1

    mkdir -p "$POOL_APP_DIR"
    chmod 700 "$POOL_APP_DIR"
    info "Copying pool manager to $POOL_APP_DIR..."
    # ⚠ SAME --delete EXCLUDES AS pool_deploy_code, and for a stronger reason.
    # Install is not a first-run-only step: an operator re-runs it to pick up a
    # changed systemd unit (that is the documented fix for the /etc/wireguard
    # ReadWritePaths change, §13.12p). On a first install POOL_APP_DIR is empty
    # and every exclude is a no-op; on a re-run, a bare --delete mirrors the
    # checkout and so DELETES the runtime state the app owns — pool.db (every
    # miner's balance), .wallet_pass, custom_assets and uploads. node_modules is
    # excluded too: the npm step below would rebuild it, but only after a slow
    # full reinstall. A re-runnable step must never destroy data.
    rsync -a --delete \
        --exclude='pool.db' --exclude='pool.db-wal' --exclude='pool.db-shm' \
        --exclude='.wallet_pass' --exclude='node_modules' \
        --exclude='custom_assets' --exclude='uploads' \
        "$POOL_APP_SRC/" "$POOL_APP_DIR/" \
        2>/dev/null || cp -r "$POOL_APP_SRC/"* "$POOL_APP_DIR/"
    # Install replaces the code and node_modules/ but never restarts, so a pool running
    # through a re-run keeps the old code. Leave the restart marker: the next 9) Deploy
    # new code restarts it, and any start after this (menu 6) makes the marker stale.
    _pool_restart_mark_set "$POOL_RESTART_MARK" "$POOL_SERVICE"

    local npm_cmd="install"
    [[ -f "$POOL_APP_DIR/package-lock.json" ]] && npm_cmd="ci"
    info "Installing Node.js dependencies (npm $npm_cmd)..."
    printf 'pending\n' > "$POOL_DEPS_STAMP" 2>/dev/null || warn "Could not write $POOL_DEPS_STAMP."
    (cd "$POOL_APP_DIR" && npm "$npm_cmd" --omit=dev 2>&1 | tail -20) \
        || { error "npm $npm_cmd failed in $POOL_APP_DIR — see /root/.npm/_logs/ (latest *-debug-0.log)."; return 1; }
    _pool_pkg_hash "$POOL_APP_DIR" > "$POOL_DEPS_STAMP" 2>/dev/null || warn "Could not write $POOL_DEPS_STAMP."
    success "Node.js dependencies installed."

    # No separate DB-init step: lib/db.js initDb() creates/migrates the schema
    # at db_path on every service start.
    info "Database schema is created automatically on first service start."

    local jwt_secret; jwt_secret=$(pool_read_conf "jwt_secret" "")
    if [[ -z "$jwt_secret" ]]; then
        jwt_secret=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" \
            2>/dev/null || openssl rand -hex 32)
        pool_write_conf_key "jwt_secret" "$jwt_secret"
        success "JWT secret generated."
    fi

    pool_ensure_defaults

    # De-root FIRST (creates the grinpool user + ownership + scoped sudo) so the
    # hardened unit below can reference an existing user. Also installs the
    # grin-gateway-ctl helper the panel/CLI pairing path depends on (§13.2/§13.9).
    pool_gwctl_install || true
    pool_ensure_wg_prereqs
    pool_deroot || return 1

    # Undo this step's own `chmod 700 "$POOL_APP_DIR"` for the two directories nginx has
    # to reach, so a re-run of Install stops silently 404-ing every logo and CMS image
    # until 4) Setup nginx is run again (audit §J8-7b). After pool_deroot so the chown
    # inside it lands on a user that exists.
    pool_ensure_served_dirs || true

    local node_bin; node_bin=$(command -v node 2>/dev/null || echo /usr/bin/node)
    local wallet_rw; wallet_rw=$(pw_wallet_dir 2>/dev/null || echo "$POOL_WALLET_DIR")
    # User=grinpool (§13.9): the backend parses untrusted input from the public
    # internet on TWO surfaces (HTTP API + raw stratum TCP) atop a large npm tree —
    # root here turned any RCE into hub-WG-key + node-secret + LE-key compromise.
    # ReadWritePaths entries are '-'-prefixed (ignore-if-missing) because the wallet
    # dir may not exist until step 5. Do NOT add NoNewPrivileges — it breaks the
    # scoped `sudo grin-gateway-ctl` the panel pairing path uses.
    #
    # ⚠ /etc/wireguard is in ReadWritePaths for the SAME reason, and it is not
    # optional. ProtectSystem=strict builds a MOUNT NAMESPACE, and a namespace is
    # inherited by every child — including one that becomes root through setuid
    # sudo. Gaining root does not get you out of it. Without this entry the helper
    # runs as root and still cannot append a [Peer], so `add-peer`, `remove-peer`
    # and `init-server` all fail from the panel while `list`/`status` (reads) keep
    # working — the page looks healthy right up to the moment you save (§13.12p).
    # pool_ensure_wg_prereqs() (entry script) creates the directory BEFORE this unit starts,
    # because ReadWritePaths is bound at service start: a directory created later
    # is not writable inside the already-running service's namespace.
    cat > "/etc/systemd/system/$POOL_SERVICE.service" << EOF
[Unit]
Description=Grin Pool Manager (GRINIUM — ${POOL_NET_LABEL})
After=network.target
Wants=network.target

[Service]
Type=simple
User=grinpool
WorkingDirectory=$POOL_APP_DIR
Environment="GRIN_POOL_CONF=$POOL_CONF"
Environment="NODE_ENV=production"
Environment="HOST=127.0.0.1"
Environment="PORT=$POOL_PORT"
ExecStart=$node_bin $POOL_APP_DIR/index.js
Restart=on-failure
RestartSec=5
LimitNOFILE=65535
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
RestrictSUIDSGID=yes
ReadWritePaths=-$POOL_APP_DIR -$(dirname "$POOL_CONF") -$wallet_rw -$LOG_DIR -/etc/wireguard

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "$POOL_SERVICE" 2>/dev/null || true
    success "Systemd service $POOL_SERVICE installed (runs as grinpool, hardened unit)."

    mkdir -p "$(dirname "$POOL_LOG")"
    cat > "/etc/logrotate.d/${POOL_SERVICE}" << EOF
$POOL_LOG {
    daily
    rotate 10
    size 20M
    compress
    delaycompress
    missingok
    notifempty
    postrotate
        systemctl kill -s USR2 $POOL_SERVICE 2>/dev/null || true
    endscript
}
EOF
    success "Logrotate configured."

    # Fail2ban login guard is part of the base install; non-fatal so a missing
    # EPEL repo doesn't abort the whole install — fix the cause and re-run Install.
    pool_setup_fail2ban || warn "fail2ban setup failed — fix the cause (e.g. enable EPEL) and re-run 1) Install."

    echo ""
    success "Pool manager installed."
    echo -e "  Next: ${BOLD}2) Configure${RESET} → ${BOLD}3) Deploy${RESET} → ${BOLD}4) Nginx${RESET} → ${BOLD}5) Set up wallet${RESET} → ${BOLD}6) Start service${RESET} → ${BOLD}7) Admin account${RESET}"
}

# ═══════════════════════════════════════════════════════════════════════════════
# 2) CONFIGURE
# ═══════════════════════════════════════════════════════════════════════════════

pool_configure() {
    echo -e "\n${BOLD}Configure Pool Manager — ${POOL_NET_LABEL}${RESET}"
    echo -e "${DIM}Only the pool domain is set here — everything else defaults and is${RESET}"
    echo -e "${DIM}edited in the web admin panel after login.${RESET}\n"

    # The config read/write helpers run on node (installed by step 1). Without
    # it every write fails silently, so make the missing prerequisite explicit.
    if ! command -v node &>/dev/null; then
        error "Node.js not found — run 1) Install first."
        return 1
    fi
    pool_ensure_defaults

    # The domain is the ONLY install-time setting asked here. Everything else
    # (pool name, fee %, min withdrawal, reward model, payout options, …) is
    # seeded with sane defaults during 1) Install and is edited in the web admin
    # panel after first login — so the installer stays minimal. The domain is the
    # exception: it's REQUIRED for nginx + certbot (the public site + admin HTTPS) and
    # is NOT editable in the admin panel, so it must be captured up front.
    # node_stratum_port stays at its default (3416 / testnet 13416 — Grin's native
    # stratum_server_addr port); advanced operators running the node's built-in stratum
    # on another port edit grin_pubpool.json directly.
    local val

    # Enter keeps an existing value; with none set we loop until a valid domain
    # is given (0 to cancel out of Configure).
    echo -e "  ${DIM}(Full domain or subdomain for the pool site, e.g. pool.example.com or example.com)${RESET}"
    local cur_domain; cur_domain=$(pool_read_conf "subdomain" "")
    while true; do
        echo -ne "Domain/subdomain [${cur_domain}]: "
        read -r val
        if [[ -z "$val" ]]; then
            # Enter with an existing value keeps it; with none, the field is
            # mandatory — re-prompt instead of writing an empty domain.
            [[ -n "$cur_domain" ]] && break
            warn "A domain is required for a public pool (HTTPS for the site + admin). Enter 0 to cancel Configure."
            continue
        fi
        [[ "$val" == "0" ]] && { info "Configure cancelled."; return 1; }
        if nginx_validate_domain "$val"; then
            pool_write_conf_key "subdomain" "$val"; cur_domain="$val"; break
        fi
        warn "Invalid domain name '$val' — try again (e.g. pool.example.com), or 0 to cancel."
    done

    # ── This server's region location (public connect card) ──────────────────
    # Optional but recommended: most pools sit behind Cloudflare, so the public site
    # can't geo-locate the box — the operator tells us where it is. Shown as the
    # region's label + country flag on the homepage connect card. All editable later
    # in admin → Regions. Enter keeps the current value; blank country = no flag.
    echo
    echo -e "  ${DIM}(Where is THIS pool server? Shown on the public connect card. Optional — Enter to skip.)${RESET}"
    local cur_rlabel; cur_rlabel=$(pool_read_conf "region_label" "")
    echo -ne "Region display name (e.g. Saigon, New York) [${cur_rlabel}]: "
    read -r val
    [[ -n "$val" ]] && pool_write_conf_key "region_label" "$val"
    local cur_rcountry; cur_rcountry=$(pool_read_conf "region_country" "")
    echo -ne "Country name (e.g. Vietnam, United States) [${cur_rcountry}]: "
    read -r val
    [[ -n "$val" ]] && pool_write_conf_key "region_country" "$val"
    local cur_rcc; cur_rcc=$(pool_read_conf "region_country_code" "")
    echo -e "  ${DIM}(2-letter ISO country code for the flag, e.g. VN, DE, US. Blank = no flag.)${RESET}"
    echo -ne "Country code [${cur_rcc}]: "
    read -r val
    if [[ -n "$val" ]]; then
        # Normalise to uppercase A–Z; reject anything that isn't a 2-letter code.
        val=$(printf '%s' "$val" | tr '[:lower:]' '[:upper:]')
        if [[ "$val" =~ ^[A-Z]{2}$ ]]; then
            pool_write_conf_key "region_country_code" "$val"
        else
            warn "Ignoring '$val' — country code must be exactly two letters (e.g. VN)."
        fi
    fi

    info "All other settings (name, fee, min withdrawal, payouts) default now and"
    info "  are editable in the web admin panel after you create the admin account."

    # Wallet dir, pool Grin address + wallet password are NOT asked here — the
    # wallet doesn't exist yet at this point. All three are captured by
    # 5) Set up wallet (pw_setup), which asks for the dir, creates the wallet,
    # saves the passphrase and records the address.
    info "Wallet dir, pool Grin address + wallet password are set during 5) Set up wallet."

    # Keep the already-deployed frontend in sync with a changed pool name
    # (no-op before 3) Deploy has run).
    pool_write_web_config_js

    if systemctl is-active --quiet "$POOL_SERVICE" 2>/dev/null; then
        info "Restarting $POOL_SERVICE to apply config..."
        systemctl restart "$POOL_SERVICE"
    fi
    success "Pool manager configured."
}

# ═══════════════════════════════════════════════════════════════════════════════
# 3) DEPLOY WEB FILES
# ═══════════════════════════════════════════════════════════════════════════════

pool_deploy_web() {
    if [[ ! -d "$POOL_WEB_SRC" ]]; then
        error "Web source not found: $POOL_WEB_SRC"
        return 1
    fi

    info "Deploying web files (${POOL_NET_LABEL}) to $POOL_WEB_DIR..."
    mkdir -p "$POOL_WEB_DIR"
    rsync -a --delete "$POOL_WEB_SRC/" "$POOL_WEB_DIR/" \
        2>/dev/null || cp -r "$POOL_WEB_SRC/"* "$POOL_WEB_DIR/"

    # Serve the full web admin (dashboard/settings/users/payments/incentives/health) at /admin/.
    # It ships in the app source under admin-panel/; copy it into the web root so nginx's
    # `try_files $uri $uri/ $uri.html` resolves /admin/ → /admin/index.html. The admin pages
    # self-guard (redirect to /login.html without a session) and every /api/admin/* call they
    # make is IP-allowlist + JWT protected, so the static HTML itself carries no secrets.
    # NOTE: must run AFTER the --delete rsync above, which would otherwise prune /admin/.
    if [[ -d "$POOL_APP_SRC/admin-panel" ]]; then
        info "Deploying web admin panel to $POOL_WEB_DIR/admin..."
        mkdir -p "$POOL_WEB_DIR/admin"
        rsync -a --delete "$POOL_APP_SRC/admin-panel/" "$POOL_WEB_DIR/admin/" \
            2>/dev/null || cp -r "$POOL_APP_SRC/admin-panel/"* "$POOL_WEB_DIR/admin/"
    fi

    pool_write_web_config_js

    # Ownership + perms: the docroot is rsync'd as root, leaving files root:root.
    # nginx (www-data) must be able to traverse + read every file it serves, so
    # normalise the WHOLE tree (incl. /admin and the just-written pool-config.js)
    # to www-data:www-data with dirs 755 / files 644. Idempotent; cheap.
    pool_fix_web_perms

    success "Web files deployed to $POOL_WEB_DIR"
}

# Normalise the deployed docroot to the nginx web user with sane perms. Called by
# every web-deploy path (3) Deploy web files, 9) Deploy new code → pool_deploy_web,
# and the guided setup) so a redeploy never leaves root:root or over-tight modes
# that nginx (www-data) can't read.
pool_fix_web_perms() {
    [[ -d "$POOL_WEB_DIR" ]] || return 0
    chown -R www-data:www-data "$POOL_WEB_DIR" 2>/dev/null || true
    find "$POOL_WEB_DIR" -type d -exec chmod 755 {} + 2>/dev/null || true
    find "$POOL_WEB_DIR" -type f -exec chmod 644 {} + 2>/dev/null || true
}

# (Re)generate the static frontend config. Called by 3) Deploy and by
# 2) Configure (after a pool-name change) so the deployed site never serves a
# stale pool name. No-op until the web files have been deployed.
pool_write_web_config_js() {
    [[ -d "$POOL_WEB_DIR/js" ]] || return 0
    local pool_name escaped_name
    pool_name=$(pool_read_conf "pool_name" "My Grin Pool")
    escaped_name=$(node -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$pool_name" 2>/dev/null \
        || printf '"%s"' "${pool_name//\"/\\\"}")
    cat > "$POOL_WEB_DIR/js/pool-config.js" << EOF
// Auto-generated by GRINIUM pool_deploy.sh
window.POOL_NETWORK = "$(pool_read_conf network "$POOL_NET")";
window.POOL_NAME = ${escaped_name};
EOF
}

# ─── Restart only what changed (shared with pgs_deploy_code) ───────────────────
# A deploy restarts a service only when the files its Node process LOADS changed;
# static files are served by nginx from disk and go live without one. A pool restart
# drops every miner's stratum connection, so a CSS fix must not cost that.
#
# Runtime manifest = "sha256  path" per file under <dir>, restricted to the named
# paths. Contents and names only: rsync -a copies the checkout's mtimes (a fresh
# clone changes every timestamp, no code) and pool_deroot re-chowns the tree on every
# deploy, so neither timestamps nor ownership may count as a change.
POOL_RUNTIME_PATHS=(index.js lib routes package.json package-lock.json)
POOL_RESTART_MARK="$(dirname "$POOL_APP_DIR")/.${POOL_NET}.restart-pending"
# "pending" while npm runs, else the package hash node_modules/ was installed from
# (rationale at the npm gate in pool_deploy_code; 1) Install keeps it current too).
POOL_DEPS_STAMP="$(dirname "$POOL_APP_DIR")/.${POOL_NET}.deps-installed"

# Hash of the package files npm installs from, as one stream (both, never package.json alone).
_pool_pkg_hash() { # <dir>
    cat "$1/package.json" "$1/package-lock.json" 2>/dev/null | sha1sum | awk '{print $1}'
}

_pool_runtime_manifest() { # <dir> <path>... — absent paths simply contribute nothing
    local dir="$1"; shift
    [[ -d "$dir" ]] || return 0
    (cd "$dir" 2>/dev/null && find "$@" -type f -print0 2>/dev/null | LC_ALL=C sort -z \
        | xargs -0 -r sha256sum 2>/dev/null) || true
}

# Print the runtime files that differ between two manifests (added, changed or
# deleted), at most 8 plus a count — this explains a restart, it does not decide one.
_pool_runtime_diff() { # <manifest before> <manifest after>
    # comm (coreutils), not diff: diffutils is not guaranteed on a minimal install.
    local -a files
    mapfile -t files < <(LC_ALL=C comm -3 <(printf '%s\n' "$1" | LC_ALL=C sort) \
            <(printf '%s\n' "$2" | LC_ALL=C sort) 2>/dev/null \
        | sed -n 's/^\t\{0,1\}[0-9a-f]\{64\} [ *]//p' | LC_ALL=C sort -u)
    local i
    for (( i = 0; i < ${#files[@]} && i < 8; i++ )); do
        echo -e "      ${DIM}${files[i]}${RESET}"
    done
    if (( ${#files[@]} > 8 )); then echo -e "      ${DIM}…and $(( ${#files[@]} - 8 )) more${RESET}"; fi
}

# The pending marker exists ⇒ runtime code is on disk that <service> has not loaded.
# A deploy writes it the moment runtime code lands and removes it only after a
# successful restart, so a deploy that stops anywhere in between (npm failure, Ctrl-C,
# a dropped SSH session, a failed restart) still leaves it behind. It goes stale once the
# service has started at or after the marker's mtime — by ANY route (menu 6, P → 4, a
# reboot, systemd Restart=, Migrate IN) — so no other start site has to clear it.
_pool_restart_pending() { # <marker> <service> → rc 0 = still pending
    local marker="$1" svc="$2" started mark
    [[ -f "$marker" ]] || return 1
    systemctl is-active --quiet "$svc" 2>/dev/null || return 0
    # TZ=UTC: systemctl prints the box's local zone, whose abbreviation `date` may not parse.
    started=$(TZ=UTC systemctl show -p ActiveEnterTimestamp --value "$svc" 2>/dev/null)
    # An empty timestamp must not reach `date -d ""`, which answers today's midnight.
    [[ -n "$started" ]] && started=$(date -d "$started" +%s 2>/dev/null) || started=0
    mark=$(stat -c %Y "$marker" 2>/dev/null) || mark=0
    if (( started >= mark )); then
        rm -f "$marker" 2>/dev/null || warn "Could not remove the stale restart marker $marker." >&2
        return 1
    fi
    return 0
}

_pool_restart_mark_set() { # <marker> <service>
    printf 'Runtime code deployed %s is not yet loaded by %s.\n' \
        "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "$2" > "$1" 2>/dev/null \
        || warn "Could not write the restart marker $1 — the next deploy cannot tell $2 is behind." >&2
}

# One word on stdout: what a deploy should do with <service>. Called as $(…), so every
# message inside it goes to stderr. The caller has already written the marker if this
# run changed runtime code.
#   changed — running, and this deploy changed its runtime code → restart
#   pending — running, and an earlier deploy's code is still not loaded → restart
#   current — running the code on disk → leave it alone
#   stopped — not running; the marker stays for the next start / deploy
_pool_restart_decision() { # <service> <marker> <changed 0|1>
    local svc="$1" marker="$2" changed="$3"
    if ! systemctl is-active --quiet "$svc" 2>/dev/null; then
        echo stopped
    elif [[ "$changed" == 1 ]]; then
        echo changed
    elif _pool_restart_pending "$marker" "$svc"; then
        echo pending
    else
        echo current
    fi
}

_pool_restart_mark_age() { # <marker> → "YYYY-MM-DD HH:MM UTC" of the marker's mtime
    local m; m=$(stat -c %Y "$1" 2>/dev/null) || { echo "unknown time"; return 0; }
    date -u -d "@$m" '+%Y-%m-%d %H:%M UTC' 2>/dev/null || echo "unknown time"
}

# ───────────────────────────────────────────────────────────────────────────────
# 9) DEPLOY NEW CODE — refresh runtime copies from the checkout, restart what changed
# ───────────────────────────────────────────────────────────────────────────────
# A lightweight update path for an ordinary code pull (js/html/media only): it
# refreshes BOTH trees the pool runs from —
#   · backend  $POOL_APP_SRC  → $POOL_APP_DIR   (index.js, lib/*.js, admin-panel/…)
#   · frontend $POOL_WEB_SRC  → $POOL_WEB_DIR   (via pool_deploy_web)
# — and restarts the pool only when its runtime code (POOL_RUNTIME_PATHS) changed or
# an earlier deploy's code is still unloaded; a static-only change goes live without
# a restart. The games service gets the same treatment in pgs_deploy_code, on its own.
# This fills the gap between 3) Deploy web files (frontend ONLY — never touches the
# backend) and 1) Install (heavy: re-runs npm/apt/fail2ban AND does not restart).
#
# The backend rsync uses --delete to mirror the checkout (so a file deleted from
# source is removed on the server too) but EXCLUDES the runtime artefacts the app
# owns, never the repo: the SQLite DB (pool.db + WAL/SHM sidecars), the wallet
# password file, node_modules (deps — refreshed only when package.json changes),
# custom_assets (operator-uploaded white-label media) and uploads (CMS media from
# the admin editor). rsync protects excluded paths from --delete, so miner
# balances / secrets / deps / media survive untouched.
#
# ⚠ Add an exclude here for EVERY new runtime dir the app writes under
# POOL_APP_DIR. Living outside public_html protects a dir from the DOCROOT rsync
# in pool_deploy_web, not from this one — this --delete targets POOL_APP_DIR
# itself. `uploads` was missing that exclude and was pruned on every deploy.
pool_deploy_code() {
    echo ""
    echo -e "  ${BOLD}Deploy new code — ${POOL_NET_LABEL}${RESET} — refresh backend + frontend from the checkout, restart what changed."
    echo -e "  ${DIM}Source: $TOOLKIT_ROOT${RESET}"
    echo -e "  ${YELLOW}Pull the latest first${RESET} (git pull) so the checkout holds the new code."
    echo ""

    if [[ ! -d "$POOL_APP_SRC" ]]; then
        error "Pool app source not found: $POOL_APP_SRC"
        return 1
    fi
    if [[ ! -d "$POOL_APP_DIR" ]]; then
        error "Pool not installed yet ($POOL_APP_DIR missing) — run 1) Install first."
        return 1
    fi

    # Did package.json change? Capture the OLD (deployed) hash before the rsync
    # overwrites it, compare against the source. Only then do we re-run npm —
    # an ordinary js/html refresh skips the (slow) dependency install entirely.
    #
    # ⚠ BOTH files, not just package.json (audit §J13-6). npm ci installs from
    # package-lock.json, and almost every dependency SECURITY fix is lockfile-only: a
    # transitive pin bumped by `npm audit fix` changes the lock and leaves package.json
    # byte-identical. Hashing package.json alone rsynced the new lock into place and then
    # skipped npm, so the box kept running the vulnerable tree while the lockfile on disk
    # claimed it was patched — and nothing compares the two.
    #
    # ⚠ Compare against what was INSTALLED, not what was copied. The rsync below puts the
    # new package files in place BEFORE npm runs, so after a failed or interrupted npm the
    # deployed files already match the source and a re-run would skip npm, leaving the old
    # tree under the new lockfile. The stamp says "pending" while npm runs and holds the
    # package hash once it succeeded. It lives beside the restart marker, NOT in
    # node_modules/: `npm ci` deletes node_modules first, so a stamp there would vanish
    # with the failure it records. No stamp (a box that predates it) falls back to the
    # deployed files, which is what this gate always trusted; no node_modules/ at all
    # forces npm.
    local old_pkg_hash new_pkg_hash installed_hash deps_stamp="$POOL_DEPS_STAMP"
    old_pkg_hash=$(_pool_pkg_hash "$POOL_APP_DIR")
    new_pkg_hash=$(_pool_pkg_hash "$POOL_APP_SRC")
    installed_hash=$(head -n1 "$deps_stamp" 2>/dev/null || true)
    [[ -n "$installed_hash" ]] || installed_hash="$old_pkg_hash"
    [[ -d "$POOL_APP_DIR/node_modules" ]] || installed_hash="missing"

    local rt_before rt_after rt_changed=0
    rt_before=$(_pool_runtime_manifest "$POOL_APP_DIR" "${POOL_RUNTIME_PATHS[@]}")

    info "Refreshing backend code → $POOL_APP_DIR ..."
    rsync -a --delete \
        --exclude='pool.db' --exclude='pool.db-wal' --exclude='pool.db-shm' \
        --exclude='.wallet_pass' --exclude='node_modules' \
        --exclude='custom_assets' --exclude='uploads' \
        "$POOL_APP_SRC/" "$POOL_APP_DIR/" \
        || {
            # A partial copy may already have replaced runtime files; mark them so the
            # re-run restarts even though it then sees no difference.
            rt_after=$(_pool_runtime_manifest "$POOL_APP_DIR" "${POOL_RUNTIME_PATHS[@]}")
            if [[ "$rt_before" != "$rt_after" ]]; then _pool_restart_mark_set "$POOL_RESTART_MARK" "$POOL_SERVICE"; fi
            error "Backend rsync failed — re-run 9) Deploy new code."; return 1
        }
    success "Backend code refreshed."

    # Mark NOW, not at the restart: every return between here and the restart (npm
    # failure, Ctrl-C) would otherwise leave new code on disk that no later deploy sees.
    rt_after=$(_pool_runtime_manifest "$POOL_APP_DIR" "${POOL_RUNTIME_PATHS[@]}")
    if [[ "$rt_before" != "$rt_after" ]]; then
        rt_changed=1
        _pool_restart_mark_set "$POOL_RESTART_MARK" "$POOL_SERVICE"
    fi

    if [[ "$installed_hash" != "$new_pkg_hash" ]]; then
        local npm_cmd="install"
        [[ -f "$POOL_APP_DIR/package-lock.json" ]] && npm_cmd="ci"
        if [[ "$installed_hash" == pending ]]; then
            warn "The last dependency install did not finish — running npm $npm_cmd again ..."
        elif [[ "$installed_hash" == missing ]]; then
            warn "node_modules/ is missing — running npm $npm_cmd ..."
        else
            warn "package.json / package-lock.json changed — running npm $npm_cmd ..."
        fi
        # A new tree under a running process is runtime even when no .js changed.
        rt_changed=1
        _pool_restart_mark_set "$POOL_RESTART_MARK" "$POOL_SERVICE"
        printf 'pending\n' > "$deps_stamp" 2>/dev/null \
            || warn "Could not write $deps_stamp — if npm fails, a re-run may not retry it."
        (cd "$POOL_APP_DIR" && npm "$npm_cmd" --omit=dev 2>&1 | tail -20) \
            || { error "npm $npm_cmd failed — see /root/.npm/_logs/ (latest *-debug-0.log). Re-run 9) Deploy new code to retry."; return 1; }
        printf '%s\n' "$new_pkg_hash" > "$deps_stamp" 2>/dev/null \
            || warn "Could not write $deps_stamp — the next deploy will run npm again."
        success "Dependencies updated."
    else
        info "package.json + package-lock.json unchanged — skipping npm (deps untouched)."
    fi

    # Frontend (public_html → /var/www/grin-pool) + admin panel + pool-config.js.
    # No-op-safe if the web files were never deployed (it recreates the dir).
    pool_deploy_web || warn "Frontend deploy reported a problem — backend is still refreshed."

    # Upgrade-path de-root (§13.9): rsync ran as root, so re-sweep ownership and
    # regenerate the pairing helper — idempotent no-ops on an already-migrated box.
    # A pre-de-root install also needs 1) Install re-run once for the hardened unit.
    pool_gwctl_install || true
    pool_ensure_wg_prereqs
    # pool_deroot may add grinpool to a group (grinsecret, for the node secrets); a running
    # process gets new groups only from a restart, so a change there counts as runtime.
    local groups_before groups_after
    groups_before=$(id -G grinpool 2>/dev/null || true)
    pool_deroot || warn "De-root sweep failed — the service may not start as grinpool."
    groups_after=$(id -G grinpool 2>/dev/null || true)
    if [[ "$groups_before" != "$groups_after" ]]; then
        rt_changed=1
        _pool_restart_mark_set "$POOL_RESTART_MARK" "$POOL_SERVICE"
    fi
    if grep -q '^User=root' "/etc/systemd/system/$POOL_SERVICE.service" 2>/dev/null; then
        warn "Service unit still runs as root — re-run 1) Install once to apply the hardened grinpool unit."
    fi
    # An update does NOT rewrite the unit, so a box installed before §13.12p keeps a
    # ReadWritePaths without /etc/wireguard. Under ProtectSystem=strict that makes
    # every panel-side WireGuard WRITE fail while the reads keep working — the page
    # looks healthy and only the save breaks. Cheap to detect, expensive to debug.
    local _unit="/etc/systemd/system/$POOL_SERVICE.service"
    if [[ -f "$_unit" ]] && grep -q '^ProtectSystem=strict' "$_unit" 2>/dev/null &&
       ! grep -q '^ReadWritePaths=.*/etc/wireguard' "$_unit" 2>/dev/null; then
        warn "This box's service unit cannot write /etc/wireguard."
        echo -e "  ${DIM}Gateway pairing and multi-region setup FROM THE ADMIN PANEL will fail${RESET}"
        echo -e "  ${DIM}(the page's status columns will still look fine — only writes break).${RESET}"
        echo -e "  ${DIM}Fix: re-run 1) Install once to apply the updated unit. The pool menu${RESET}"
        echo -e "  ${DIM}W) Multi-region works either way — it runs as root outside the service.${RESET}"
    fi

    # Refresh the break-glass recovery wrapper — the rsync above may have replaced
    # scripts/admin-reset.js, and this must never be the stale copy on the day it's needed.
    pool_admin_reset_install || true

    # Make the new backend live — only if its runtime code changed (or an earlier
    # deploy's is still unloaded). A stopped service is left stopped (the operator
    # starts it via 6) Service control).
    local decision
    decision=$(_pool_restart_decision "$POOL_SERVICE" "$POOL_RESTART_MARK" "$rt_changed")
    case "$decision" in
        changed|pending)
            if [[ "$decision" == changed ]]; then
                info "Pool runtime changed:"
                _pool_runtime_diff "$rt_before" "$rt_after"
                if [[ "$groups_before" != "$groups_after" ]]; then
                    echo -e "      ${DIM}grinpool's group membership (new groups load only on restart)${RESET}"
                fi
            else
                info "Pool runtime unchanged this run, but an earlier deploy is still not loaded"
                echo -e "  ${DIM}(marker from $(_pool_restart_mark_age "$POOL_RESTART_MARK")).${RESET}"
            fi
            info "Restarting $POOL_SERVICE to load the new code..."
            if systemctl restart "$POOL_SERVICE"; then
                rm -f "$POOL_RESTART_MARK" 2>/dev/null || warn "Could not remove $POOL_RESTART_MARK — the next deploy will restart once more."
                success "$POOL_SERVICE restarted — new code is live."
            else
                _pool_restart_mark_set "$POOL_RESTART_MARK" "$POOL_SERVICE"
                error "Restart failed — check: journalctl -u $POOL_SERVICE -n 50"
                return 1
            fi
            ;;
        current)
            info "Pool runtime code unchanged (static files only) — $POOL_SERVICE NOT restarted."
            ;;
        *)
            if [[ "$rt_changed" == 1 ]] || [[ -f "$POOL_RESTART_MARK" ]]; then
                info "$POOL_SERVICE is not running — start it via 6) Service control to load the new code."
            else
                info "$POOL_SERVICE is not running — start it via 6) Service control."
            fi
            ;;
    esac

    # The /play/ games service rides along when it is installed (design §19.12 (script07_design_games.md)). It
    # restarts only itself; a games failure never fails the pool deploy above.
    if pgs_installed; then
        pgs_deploy_code || warn "Games deploy reported a problem — the pool deploy above is complete; see P → 5."
    fi

    echo ""
    success "Deploy new code complete."
}

# ═══════════════════════════════════════════════════════════════════════════════
# G) GUIDED FULL SETUP
# ═══════════════════════════════════════════════════════════════════════════════

# Pause between guided steps. Enter continues; 0 (or q) aborts the guided flow
# (rc 1) so the caller can return to the menu. <label of the next step>

# Run guided step <n> "<label>" <fn> — when the step already looks complete
# (per _pool_step_done), offer to skip it. This makes re-running G) after a
# mid-flow abort resume where it left off instead of redoing everything.
_pool_guided_step() {
    local n="$1" label="$2" fn="$3"
    if _pool_step_done "$n"; then
        echo -ne "  Step $n) $label looks ${GREEN}already done${RESET} — re-run it? [y/N]: "
        local re; read -r re
        [[ "${re,,}" == "y" ]] || { info "Skipped: $label (already done)."; return 0; }
    fi
    "$fn"
}

pool_guided_setup() {
    echo -e "\n${BOLD}${CYAN}═══ Guided Full Setup — GRINIUM Pool (${POOL_NET_LABEL}) ═══${RESET}\n"
    pool_check_exclusivity || return 0
    echo -e "  Runs steps 1 → 7 straight through (no pause between steps)."
    echo -e "  You're only asked for real inputs: the pool domain, SSL/certbot,"
    echo -e "  the wallet passphrase, and the admin username/password."
    echo -e "  Steps already completed (✓) can be skipped when prompted:"
    local _step_names=("Install" "Configure" "Deploy web files" "Setup nginx" \
                       "Set up wallet" "Service running" "Admin account")
    local _i
    for _i in 1 2 3 4 5 6 7; do
        echo -e "    $(_pool_step_mark "$_i") ${_step_names[$((_i-1))]}"
    done
    echo ""
    echo -ne "  Continue? [Y/n]: "
    read -r go; [[ "${go,,}" == "n" ]] && return

    # Run straight through — no "press Enter" gate between steps. Steps that need
    # no input just print their banner and proceed; the only stops are real inputs
    # (the pool domain, certbot, the wallet passphrase, the admin credentials).
    # Every step is ||-guarded: under set -e an unguarded failure would kill the
    # whole script instead of returning to the menu. Abort the guided flow with a
    # message on the first hard failure; the operator fixes it and re-runs.
    echo -e "\n${BOLD}${CYAN}── Step 1/7: Install ──${RESET}"
    _pool_guided_step 1 "Install" pool_install \
        || { error "Install failed — fix the cause and re-run G) Guided setup."; return 0; }

    echo -e "\n${BOLD}${CYAN}── Step 2/7: Configure (pool domain) ──${RESET}"
    _pool_guided_step 2 "Configure" pool_configure \
        || { error "Configure failed — aborting guided setup."; return 0; }

    echo -e "\n${BOLD}${CYAN}── Step 3/7: Deploy web files ──${RESET}"
    _pool_guided_step 3 "Deploy web files" pool_deploy_web \
        || { error "Web deploy failed — aborting guided setup."; return 0; }

    echo -e "\n${BOLD}${CYAN}── Step 4/7: Setup nginx + SSL ──${RESET}"
    _pool_guided_step 4 "Setup nginx" pool_setup_nginx \
        || { error "Nginx setup failed — aborting guided setup."; return 0; }

    # Wallet setup must end with the combined listener up AND unlocked (pw_setup
    # returns non-zero otherwise, or on a deliberate cancel). Don't roll on to the
    # service + admin steps with a wallet that can't listen/open — coinbase + payouts
    # would silently fail. Default to stopping; only continue if the operator opts in.
    echo -e "\n${BOLD}${CYAN}── Step 5/7: Set up wallet (combined coinbase + payout listener) ──${RESET}"
    if ! _pool_guided_step 5 "Set up wallet" pw_setup; then
        warn "Wallet not fully set up (listeners down or setup cancelled) — finish via 5) Set up wallet."
        echo -ne "  Continue with the remaining steps anyway (service + admin)? [y/N]: "
        local go2; read -r go2
        [[ "${go2,,}" == "y" ]] || { info "Guided setup stopped — completed steps are kept."; return 0; }
    fi

    echo -e "\n${BOLD}${CYAN}── Step 6/7: Start service ──${RESET}"
    pool_start_service || true
    # Wait for the service to actually bind its port before creating the admin —
    # the first start runs DB init/migrations, so it isn't instant. Without this
    # the next step's port check can fail and skip admin creation.
    local _svc_port; _svc_port=$(pool_read_conf "service_port" "$POOL_PORT")
    info "Waiting for $POOL_SERVICE to listen on port $_svc_port..."
    gnc_wait_for_port "$_svc_port" 30 2 >/dev/null 2>&1 \
        || warn "Service not listening yet — 7) admin creation will wait/retry."

    echo -e "\n${BOLD}${CYAN}── Step 7/7: Create admin account ──${RESET}"
    _pool_guided_step 7 "Create admin account" pool_setup_admin \
        || warn "Admin account not created — run 7) Create admin account once the service is up."

    local _domain; _domain=$(pool_read_conf "subdomain" "your-domain")
    local _allow;  _allow=$(pool_read_conf "admin_allowlist" "")
    echo ""
    success "Guided setup complete."
    echo ""
    echo -e "  ${BOLD}Public pool:${RESET}   https://$_domain"
    echo -e "  ${BOLD}Admin login:${RESET}   https://$_domain/login.html   (redirects to /admin/ after sign-in)"
    echo -e "  ${BOLD}API docs:${RESET}      https://$_domain/api-docs.html"
    echo ""
    # Listing feed. Always live (a plain public route — nothing to enable), but MPS does not
    # auto-discover: it stays unpolled until a human there is given the URL. Printing it here is
    # the only place an operator would learn it exists.
    echo -e "  ${BOLD}Get listed on miningpoolstats.stream/grin${RESET}"
    echo -e "  Feed (already live):  ${GREEN}https://$_domain/api/pool/poolstats${RESET}"
    echo -e "  ${DIM}They POLL that URL — nothing is pushed and no file is generated. Contact them${RESET}"
    echo -e "  ${DIM}via miningpoolstats.stream and ask to list the pool, giving that URL. Refreshes${RESET}"
    echo -e "  ${DIM}every 60s; 1–5 min is a sensible poll interval. Aggregates only (no addresses),${RESET}"
    echo -e "  ${DIM}so it needs no auth. Check it looks right before you send it:${RESET}"
    echo -e "    ${CYAN}curl -s https://$_domain/api/pool/poolstats | python3 -m json.tool${RESET}"
    echo ""
    if [[ -n "$_allow" ]]; then
        echo -e "  ${BOLD}${YELLOW}The admin panel is IP-restricted${RESET} — only the listed IPs can reach /admin/."
        echo -e "  Currently allowed:  ${GREEN}localhost + $_allow${RESET}"
        echo ""
        echo -e "  ${YELLOW}Getting 403 on /admin/?${RESET} The IP you browse from isn't on the list above"
        echo -e "  (it can differ from your SSH IP). Add your browsing IP, then re-run ${BOLD}4) Setup nginx${RESET}:"
        echo ""
        echo -e "    ${CYAN}# 1) On the machine you browse from, open https://api.ipify.org to get its IP${RESET}"
        echo -e "    ${CYAN}# 2) Add it (replace 1.2.3.4 — existing entries are kept):${RESET}"
        echo -e "    ${CYAN}node -e 'const f=\"$POOL_CONF\",ip=process.argv[1];const d=JSON.parse(require(\"fs\").readFileSync(f,\"utf8\"));const s=new Set((d.admin_allowlist||\"\").split(/[,\\\\s]+/).filter(Boolean));s.add(ip);d.admin_allowlist=[...s].join(\",\");require(\"fs\").writeFileSync(f,JSON.stringify(d,null,2));require(\"fs\").chmodSync(f,0o600);console.log(\"admin_allowlist =\",d.admin_allowlist)' 1.2.3.4${RESET}"
        echo -e "    ${CYAN}# 3) Re-run menu option 4) Setup nginx  (rewrites the vhost + reloads)${RESET}"
    else
        echo -e "  ${BOLD}${YELLOW}The admin panel is OPEN to all IPs${RESET} (testing default) — anyone who knows the"
        echo -e "  URL can reach /admin/, gated only by login (JWT + captcha + lockout + auto-ban)."
        echo -e "  ${BOLD}Harden once you have adoption:${RESET} set ${BOLD}admin_allowlist${RESET} in $POOL_CONF to your"
        echo -e "  browsing/VPN IP(s), then re-run ${BOLD}4) Setup nginx${RESET} to lock it down."
    fi
    echo ""
    return 0
}
