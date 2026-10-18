# =============================================================================
# 07_lib_pool_ops.sh — Admin account, wallet menu, service control, VACUUM/cron, logs and DB reset for the public pool script (menus 7/A/5/6/C/L/DEL).
# =============================================================================
# Sourced by 07_grin_mining_public_pool.sh after the POOL_* constants; shares its globals and log/info/warn/error.
# Trap: moved as-is; runs with errexit off (callers guard with `|| true`), so its file operations are not individually guarded.

# ═══════════════════════════════════════════════════════════════════════════════
# 7) CREATE ADMIN ACCOUNT
# ═══════════════════════════════════════════════════════════════════════════════

pool_setup_admin() {
    local port; port=$(pool_read_conf "service_port" "$POOL_PORT")
    echo -e "\n${BOLD}Create Admin Account — ${POOL_NET_LABEL}${RESET}\n"

    # The service may still be binding the port — the FIRST start runs DB
    # init/migrations, so it isn't instant. Wait briefly instead of bailing
    # immediately (this is the common case right after 6) Start service and in
    # the guided flow, where a 2s gap isn't enough).
    if ! ss -tlnp 2>/dev/null | grep -q ":$port "; then
        info "Waiting for the pool manager to listen on port $port..."
        if declare -F gnc_wait_for_port >/dev/null 2>&1; then
            gnc_wait_for_port "$port" 20 2 >/dev/null 2>&1 || true
        fi
    fi
    if ! ss -tlnp 2>/dev/null | grep -q ":$port "; then
        warn "Pool manager is not running on port $port."
        warn "Start the service (option 6) first, then run this again."
        warn "If it won't start, check: journalctl -u $POOL_SERVICE -n 50 --no-pager"
        return 1
    fi

    # Re-prompt on validation failure instead of bailing — a single typo shouldn't
    # send the operator back to the menu. Empty input at any prompt cancels cleanly.
    echo -e "  ${DIM}(Username: at least 3 characters — blank to cancel)${RESET}"
    while true; do
        echo -ne "Admin username: "
        read -r admin_user
        [[ -z "$admin_user" ]] && { info "Cancelled — no admin account created."; return; }
        if [[ ${#admin_user} -lt 3 ]]; then
            error "Username must be at least 3 characters. Try again."
            continue
        fi
        break
    done

    # Password + confirmation share one loop: a mismatch or a too-short password
    # re-asks both fields (typos are silent under read -rs and would otherwise lock
    # the operator out of an account whose password they can't reproduce).
    echo -e "  ${DIM}(Password: at least 8 characters — blank to cancel)${RESET}"
    while true; do
        echo -ne "Admin password: "
        read -rs admin_pass; echo ""
        [[ -z "$admin_pass" ]] && { info "Cancelled — no admin account created."; return; }
        if [[ ${#admin_pass} -lt 8 ]]; then
            error "Password must be at least 8 characters. Try again."
            continue
        fi

        echo -ne "Confirm admin password: "
        read -rs admin_pass2; echo ""
        [[ -z "$admin_pass2" ]] && { info "Cancelled — no admin account created."; return; }
        if [[ "$admin_pass" != "$admin_pass2" ]]; then
            error "Passwords do not match. Try again."
            continue
        fi
        break
    done

    echo -ne "Admin email (optional): "
    read -r admin_email

    # No captcha here: /api/auth/register skips the anti-robot gate for direct on-box
    # (loopback) calls — see isLocalRequest() in back-end-pool/index.js. This guided
    # flow always POSTs to 127.0.0.1, and the captcha only exists to slow REMOTE brute
    # force on the public login form, not the trusted root operator doing first-admin setup.
    # ⚠ The admin password NEVER goes in argv — not node's, not curl's (audit §J16-1).
    # /proc/<pid>/cmdline is world-readable on a default Linux box, so `-d "$payload"`
    # published the plaintext first-admin password to every local account for the whole
    # HTTP round trip — which includes the server's deliberately-slow bcrypt hash. The
    # account that reads it most cheaply is `grinpool`, i.e. exactly where an RCE in the
    # internet-facing backend lands, and the plaintext is what defeats the freshAdmin
    # step-up gate that a stolen token cannot. Same rule CLAUDE.md sets for grin-wallet's
    # `-p`, and the same one lib/wallet-tor.js already follows.
    #
    # Both hops are therefore stdin-fed:
    #   · node builds the JSON from stdin (a NUL-separated line, so no field can be
    #     confused with another and a password may contain anything but NUL)
    #   · curl reads the body with `--data-binary @-`, so nothing lands in its argv
    # printf is a bash builtin — the values never reach an execve() either.
    local payload
    payload=$(printf '%s\0%s\0%s' "$admin_user" "$admin_pass" "${admin_email:-}" | node -e "
const b=[];process.stdin.on('data',d=>b.push(d)).on('end',()=>{
  const [username,password,email]=Buffer.concat(b).toString('utf8').split('\0');
  process.stdout.write(JSON.stringify({username,password,email}));
});" 2>/dev/null)
    if [[ -z "$payload" ]]; then
        error "Failed to build JSON payload (node not available?)."
        return 1
    fi

    # Do NOT use curl -f here: on HTTP 4xx the -f flag discards the JSON body and
    # curl only prints "curl: (22) ... error: 400", hiding the real reason. Capture
    # the body + status code separately so the operator sees the actual error
    # (e.g. "Password must be at least 8 characters" / "Admin registration closed").
    local resp http_code body
    resp=$(printf '%s' "$payload" | curl -sS -X POST "http://127.0.0.1:$port/api/auth/register" \
        -H "Content-Type: application/json" --data-binary @- \
        -w $'\n%{http_code}' 2>&1)
    http_code="${resp##*$'\n'}"
    body="${resp%$'\n'*}"

    if [[ "$http_code" == "200" ]] && echo "$body" | grep -q '"success"[[:space:]]*:[[:space:]]*true'; then
        # No separate "promote" step needed: registerAdmin() inserts the first
        # user with is_admin=1 (registration closes once an admin exists).
        # Verify it landed so the step-7 ✓ marker and the operator agree.
        if _pool_step_done 7; then
            success "Admin '$admin_user' registered (is_admin confirmed in pool.db)."
        else
            success "Admin '$admin_user' registered."
            warn "Could not confirm the admin row in pool.db — check 8) Pool status."
        fi
    else
        # Pull the human-readable message out of the JSON {"error":"..."} body.
        local msg
        msg=$(printf '%s' "$body" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{const j=JSON.parse(s);process.stdout.write(j.error||j.message||s);}catch{process.stdout.write(s);}
});" 2>/dev/null)
        [[ -z "$msg" ]] && msg="$body"
        error "Registration failed (HTTP ${http_code:-?}): $msg"
        case "$http_code" in
            400) warn "Requirements: username ≥ 3 characters, password ≥ 8 characters." ;;
            403) warn "An admin already exists — registration is closed. Reset via Z) Cleanup or remove the admin row from pool.db to re-register." ;;
            000|"") warn "No response — is the service running? Check 6) Service control and 8) Pool status." ;;
        esac
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# A) ADMIN RECOVERY — break-glass access restore (root, on-box only)
# ═══════════════════════════════════════════════════════════════════════════════
# Installs and drives back-end-pool/scripts/admin-reset.js. The web login can lock the
# operator out of their OWN pool in ways the panel cannot fix from inside:
#   * authenticator lost AND the 10 one-time recovery codes gone  → no 2FA path back
#   * forgotten admin password                                    → no password path back
# Before this existed the only route was hand-writing UPDATE statements against a live
# pool.db during an outage, with no audit trail. It is also the prerequisite for turning on
# access.require_admin_totp (mandatory 2FA): compulsory 2FA with no recovery path means one
# lost phone can stop miner payouts indefinitely.
#
# NOT a backdoor, and must never become one: it needs a root shell on this box, and root can
# already read pool.db / mint a token from jwt_secret. Never expose this over HTTP.

pool_admin_reset_install() {
    local src="$POOL_APP_DIR/scripts/admin-reset.js"
    if [[ ! -f "$src" ]]; then
        warn "admin-reset.js not found at $src — run 3) Deploy web files (or 9) Deploy new code) first."
        return 1
    fi

    # Wrapper, not a symlink: it pins GRIN_POOL_CONF for this network and runs node from
    # $POOL_APP_DIR so require() resolves node_modules (better-sqlite3 is a native module
    # built in place — it cannot be loaded from an arbitrary cwd).
    cat > "$POOL_ADMIN_RESET_BIN" <<EOF
#!/bin/bash
# grin-node-toolkit Script 07 — break-glass admin recovery for the ${POOL_NET} public pool.
# Generated by pool_admin_reset_install(); edit the script, not this wrapper.
set -euo pipefail
export GRIN_POOL_CONF="$POOL_CONF"
cd "$POOL_APP_DIR"
exec node "$POOL_APP_DIR/scripts/admin-reset.js" "\$@"
EOF
    chmod 750 "$POOL_ADMIN_RESET_BIN"
    chown root:root "$POOL_ADMIN_RESET_BIN" 2>/dev/null || true
    success "Installed $POOL_ADMIN_RESET_BIN"
    return 0
}

# Interactive front-end so the operator doesn't have to remember flag names during an
# incident. Each option shells out to the CLI, which does the DB work and the audit row.
pool_admin_recovery_menu() {
    while true; do
        clear
        echo -e "\n${BOLD}Admin Recovery — ${POOL_NET_LABEL}${RESET}  ${DIM}(break-glass: root, on this box only)${RESET}\n"

        if [[ -x "$POOL_ADMIN_RESET_BIN" ]]; then
            echo -e "  CLI: ${GREEN}$POOL_ADMIN_RESET_BIN${RESET}"
        else
            echo -e "  CLI: ${YELLOW}not installed${RESET} ${DIM}(pick I to install)${RESET}"
        fi
        echo -e "  ${DIM}Use when the panel login can't be fixed from inside: lost authenticator with${RESET}"
        echo -e "  ${DIM}the recovery codes gone, or a forgotten password. Every action is audited.${RESET}"
        echo ""
        echo -e "  ${GREEN}1${RESET}) List admin accounts   ${DIM}(2FA state, unused recovery codes, failed logins)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Clear 2FA             ${DIM}(lost authenticator AND codes → password-only login)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Set a new password    ${DIM}(prompted; never on the command line)${RESET}"
        echo -e "  ${GREEN}4${RESET}) New recovery codes    ${DIM}(10 fresh one-time codes; replaces the old set)${RESET}"
        echo -e "  ${GREEN}5${RESET}) Clear failed-login counter / re-enable an account"
        echo ""
        echo -e "  ${GREEN}I${RESET}) (Re)install the CLI   ${DIM}(after a code deploy)${RESET}"
        echo -e "  ${DIM}0) Back${RESET}"
        echo ""
        echo -ne "${BOLD}Select: ${RESET}"
        read -r ar_choice

        # Every branch is ||-guarded: a non-zero return must come back to this menu,
        # not kill the script under set -e.
        case "${ar_choice,,}" in
            "")  continue ;;
            i)   pool_admin_reset_install || true ;;
            1)   _pool_admin_reset_run --list || true ;;
            2)   _pool_admin_reset_user_action --clear-2fa || true ;;
            3)   _pool_admin_reset_user_action --set-password || true ;;
            4)   _pool_admin_reset_user_action --new-recovery-codes || true ;;
            5)   _pool_admin_reset_user_action --unlock || true ;;
            0|q) break ;;
            *)   warn "Invalid option." ; sleep 1 ; continue ;;
        esac

        echo ""; echo "Press Enter to continue..."; read -r
    done
}

# Run the CLI, self-installing on first use so the operator isn't told "not installed"
# at the exact moment they need it.
_pool_admin_reset_run() {
    if [[ ! -x "$POOL_ADMIN_RESET_BIN" ]]; then
        info "Installing the recovery CLI first..."
        pool_admin_reset_install || return 1
    fi
    echo ""
    "$POOL_ADMIN_RESET_BIN" "$@"
}

# Prompt for the target username, then run a single-account action.
_pool_admin_reset_user_action() {
    local action="$1"
    echo ""
    echo -ne "Username (blank to cancel): "
    read -r ar_user
    if [[ -z "$ar_user" ]]; then
        info "Cancelled."
        return 0
    fi
    _pool_admin_reset_run --user "$ar_user" "$action"
}

# ═══════════════════════════════════════════════════════════════════════════════
# 5) POOL WALLET (combined coinbase + payout listener, Owner+Foreign 3420)
# ═══════════════════════════════════════════════════════════════════════════════
# Thin menu over the pw_* functions in lib/07_lib_pool_wallet.sh. The pool needs
# BOTH wallet APIs running: Foreign (the node's stratum builds coinbase here →
# block rewards) and Owner (the backend sends Tor payouts here). Setup installs
# the binary, inits/recovers the wallet, patches the node's wallet_listener_url,
# and starts both listeners; the rest is ongoing listener control.

pool_wallet_menu() {
    while true; do
        echo -e "\n${BOLD}Pool Wallet — ${POOL_NET_LABEL} — combined coinbase + payouts (Owner+Foreign ${PW_OWNER_PORT})${RESET}"
        pw_listener_status
        local wd_tag
        if [[ -f "$PW_WATCHDOG_CRON" ]]; then wd_tag="${GREEN}[OK] watchdog${RESET}"; else wd_tag="${DIM}[--] watchdog${RESET}"; fi
        echo -e "  $(pw_autostart_status)    $wd_tag"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Set up wallet        ${DIM}(install + init/recover + save pass/address + start)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Start listener       ${DIM}(owner_api + include_foreign, Owner+Foreign ${PW_OWNER_PORT}, auto-unlock)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Stop listener"
        echo -e "  ${GREEN}4${RESET}) Show pool address"
        echo -e "  ${GREEN}5${RESET}) Patch node wallet_listener_url"
        echo -e "  ${GREEN}6${RESET}) Auto-restart on boot ${DIM}(enable / disable)${RESET}"
        echo -e "  ${GREEN}7${RESET}) Watchdog */5        ${DIM}(install / remove)${RESET}"
        echo -e "  ${GREEN}8${RESET}) Replace pool wallet  ${DIM}(compromise/corruption runbook — balances live in pool.db)${RESET}"
        echo -e "  ${GREEN}9${RESET}) grin-wallet binary   ${DIM}(update · roll back · verify — seed and pool.db untouched)${RESET}"
        echo -e "  ${DIM}0) Back${RESET}"
        echo -ne "${BOLD}Select: ${RESET}"
        local c; read -r c
        case "$c" in
            1) pw_setup || true ;;
            2) pw_listener_start || true ;;
            3) pw_listener_stop || true ;;
            4) pw_show_address || true ;;
            5) pw_patch_node_toml || true ;;
            6) echo -ne "  Enable or disable? [e/d]: "; local a; read -r a
               case "${a,,}" in
                   e) pw_autostart_enable || true ;;
                   d) pw_autostart_disable || true ;;
                   *) warn "Cancelled." ;;
               esac ;;
            7) echo -ne "  Install or remove? [i/r]: "; local w; read -r w
               case "${w,,}" in
                   i) pw_watchdog_install || true ;;
                   r) pw_watchdog_remove || true ;;
                   *) warn "Cancelled." ;;
               esac ;;
            8) pw_replace_wallet || true ;;
            9) pw_binary_menu || true ;;
            0|"") return 0 ;;
            *) warn "Invalid option." ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════════════
# 6) SERVICE CONTROL
# ═══════════════════════════════════════════════════════════════════════════════

pool_service_control() {
    local action="$1"
    case "$action" in
        start)
            systemctl start "$POOL_SERVICE" \
                && success "$POOL_SERVICE started." \
                || error "Failed to start $POOL_SERVICE."
            ;;
        stop)
            systemctl stop "$POOL_SERVICE" \
                && success "$POOL_SERVICE stopped." \
                || error "Failed to stop $POOL_SERVICE."
            ;;
        restart)
            systemctl restart "$POOL_SERVICE" \
                && success "$POOL_SERVICE restarted." \
                || error "Failed to restart $POOL_SERVICE."
            ;;
    esac
}

pool_service_menu() {
    if [[ ! -f "/etc/systemd/system/$POOL_SERVICE.service" ]]; then
        error "Service unit not found — run 1) Install first."
        return 1
    fi
    echo -e "\n${BOLD}Service Control — ${POOL_NET_LABEL} ($POOL_SERVICE)${RESET}"
    if systemctl is-active --quiet "$POOL_SERVICE" 2>/dev/null; then
        echo -e "  Status: ${GREEN}● running${RESET}"
        echo -e "  ${GREEN}1${RESET}) Stop    ${RED}2${RESET}) Restart    ${DIM}0) Back${RESET}"
        echo -ne "Choice: "
        read -r sc
        case "$sc" in
            1) pool_service_control stop;    _pool_pause ;;
            2) pool_service_control restart; _pool_pause ;;
        esac
    else
        echo -e "  Status: ${RED}● stopped${RESET}"
        echo -e "  ${GREEN}1${RESET}) Start    ${DIM}0) Back${RESET}"
        echo -ne "Choice: "
        read -r sc
        # if-form: a trailing `[[ ]] &&` would make "0/back" return 1 → set -e kills the caller
        if [[ "$sc" == "1" ]]; then pool_service_control start; _pool_pause; fi
    fi
}

pool_start_service() {
    if [[ ! -f "/etc/systemd/system/$POOL_SERVICE.service" ]]; then
        error "Service unit not found — run 1) Install first."
        return 1
    fi
    if ! systemctl is-active --quiet "$POOL_SERVICE" 2>/dev/null; then
        pool_service_control start
    else
        info "$POOL_SERVICE is already running."
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# C) CRON SCHEDULES
# ═══════════════════════════════════════════════════════════════════════════════

# Write the offline-VACUUM maintenance script the cron calls (audit §J7-1).
#
# Offline because VACUUM holds an EXCLUSIVE lock for the whole rewrite, and a pool that keeps
# serving through it loses every write that lands in the window — including the block-found
# INSERT, which nothing can reconstruct. Stopping the service makes the outage explicit and
# bounded instead of silent and arbitrary.
#
# Uses node, not sqlite3: node is a hard dependency of this product and `sqlite3` is not
# installed by anything in this toolkit, so the old cron line pointed at a binary that is
# usually absent — the "maintenance" it promised had very likely never run at all.
pool_write_vacuum_script() {
    local dest="/usr/local/bin/${POOL_SERVICE}-vacuum"
    cat > "$dest" << EOF || { error "Could not write $dest"; return 1; }
#!/bin/bash
# Offline SQLite VACUUM for $POOL_SERVICE — generated by Script 07 (audit §J7-1).
# Stops the pool, compacts pool.db, starts it again. NEVER run a VACUUM against the live DB.
set -uo pipefail
DB="$POOL_APP_DIR/pool.db"
SVC="$POOL_SERVICE"
log() { echo "[\$(date -u '+%Y-%m-%d %H:%M:%S UTC')] [vacuum] \$*"; }

[[ -f "\$DB" ]] || { log "no database at \$DB — nothing to do"; exit 0; }

was_active=no
if systemctl is-active --quiet "\$SVC"; then was_active=yes; fi

# The service comes back whatever happens below — a failed vacuum must never leave the pool
# down until someone notices on Monday.
restore() {
  if [[ "\$was_active" == "yes" ]]; then
    systemctl start "\$SVC" && log "\$SVC restarted" || log "FAILED to restart \$SVC — START IT BY HAND"
  fi
}
trap restore EXIT

if [[ "\$was_active" == "yes" ]]; then
  systemctl stop "\$SVC" || { log "could not stop \$SVC — refusing to vacuum a live database"; exit 1; }
  log "\$SVC stopped"
  # Let the final WAL checkpoint land before touching the file.
  sleep 2
fi

before=\$(stat -c %s "\$DB" 2>/dev/null || echo 0)
if node -e '
const { DatabaseSync } = require("node:sqlite");
const d = new DatabaseSync(process.argv[1]);
d.exec("VACUUM");
d.close();
' "\$DB"; then
  after=\$(stat -c %s "\$DB" 2>/dev/null || echo 0)
  log "VACUUM ok — \$before → \$after bytes"
else
  log "VACUUM FAILED — database left as it was"
fi

# The vacuum ran as root, so pool.db and any WAL sidecars it recreated are root-owned; the
# de-rooted service could not then write to its own database (audit §J16-8, same trap).
if id grinpool >/dev/null 2>&1; then
  chown grinpool:grinpool "\$DB" "\$DB-wal" "\$DB-shm" 2>/dev/null || true
fi
chmod 600 "\$DB" 2>/dev/null || true
EOF
    chmod 700 "$dest" || { error "Could not chmod $dest"; return 1; }
    return 0
}

# Run an offline VACUUM once, now, at a time the operator chose (menu C → V / G).
# For the pool this is the preferred path: the vacuum stops the WHOLE pool service (stratum,
# site, API, payouts), and that downtime belongs in a planned, announced window rather than on
# a timer. The script is regenerated first so a manual run always uses the current version,
# and removed afterwards when no cron owns it — it exists at rest only while its cron does.
# Args: <label> <service> <db> <script> <writer fn> <cron file> <log>
_pool_vacuum_run_now() {
    local label="$1" svc="$2" db="$3" bin="$4" writer="$5" cron="$6" log="$7"
    echo -e "\n${BOLD}Run ${label} VACUUM now — ${POOL_NET_LABEL}${RESET}\n"

    if [[ ! -f "$db" ]]; then
        warn "No database at $db — nothing to vacuum."
        return 0
    fi
    if command -v pgrep >/dev/null 2>&1 && pgrep -f -- "$bin" >/dev/null 2>&1; then
        warn "A ${label} VACUUM is already running — wait for it to finish (see $log)."
        return 0
    fi

    local size free_kb state
    size=$(stat -c %s "$db" 2>/dev/null || echo 0)
    free_kb=$(df -Pk "$(dirname "$db")" 2>/dev/null | awk 'NR==2 {print $4}')
    state=$(systemctl is-active "$svc" 2>/dev/null || true)
    echo -e "  Database : $db ($(( size / 1048576 )) MB)"
    echo -e "  Service  : $svc (${state:-unknown})"
    echo ""
    if [[ "$state" == "active" ]]; then
        warn "$svc will be STOPPED for the whole vacuum and started again afterwards."
        if [[ "$label" == "pool" ]]; then
            echo -e "  ${DIM}Stratum, the website, the API and payouts are all down meanwhile; shares${RESET}"
            echo -e "  ${DIM}submitted in that window are lost. Announce the window to miners first.${RESET}"
        fi
    fi
    # VACUUM builds a full copy in SQLite's temp dir, then writes it back through the WAL —
    # roughly the database's size twice over while it runs (once if the temp dir is elsewhere).
    if [[ -n "$free_kb" ]] && (( free_kb * 1024 < size * 2 )); then
        warn "Only $(( free_kb / 1024 )) MB free beside the database — VACUUM needs up to twice its size."
    fi
    echo -ne "  Proceed? [y/N]: "
    local ans; read -r ans
    if [[ ! "$ans" =~ ^[Yy]$ ]]; then
        info "Cancelled — nothing was changed."
        return 0
    fi

    "$writer" || { error "Could not write the maintenance script — VACUUM NOT run."; return 1; }
    # The script exits 0 when the VACUUM itself fails (it logs "VACUUM FAILED" and carries on to
    # restore the service), so the outcome is read from its own "VACUUM ok" line, not from rc.
    local out; out=$(mktemp) || { error "mktemp failed — VACUUM NOT run."; return 1; }
    info "Running $bin (output also goes to $log) ..."
    "$bin" 2>&1 | tee -a "$log" "$out"
    local rc=${PIPESTATUS[0]} ok=no
    if grep -q '\[vacuum\] VACUUM ok' "$out" 2>/dev/null; then ok=yes; fi
    rm -f "$out"

    if [[ ! -f "$cron" ]]; then
        rm -f "$bin" || warn "Could not remove $bin (no cron uses it)."
    fi
    if [[ "$state" == "active" ]] && ! systemctl is-active --quiet "$svc"; then
        error "$svc is NOT running after the vacuum — start it now: systemctl start $svc"
        return 1
    fi
    if (( rc != 0 )) || [[ "$ok" != "yes" ]]; then
        error "The VACUUM did not complete (exit $rc) — read the lines above. The database is unchanged."
        return 1
    fi
    success "${label^} VACUUM finished."
    return 0
}

pool_cron_schedules() {
    echo -e "\n${BOLD}Cron Schedules — ${POOL_NET_LABEL} ($POOL_SERVICE)${RESET}\n"
    local cron_backup="/etc/cron.d/${POOL_SERVICE}-backup"
    local cron_vacuum="/etc/cron.d/${POOL_SERVICE}-vacuum"
    local vacuum_script="/usr/local/bin/${POOL_SERVICE}-vacuum"

    [[ -f "$cron_backup" ]] \
        && echo -e "  Daily backup  : ${GREEN}enabled${RESET}  ($cron_backup)" \
        || echo -e "  Daily backup  : ${DIM}disabled${RESET}"

    [[ -f "$cron_vacuum" ]] \
        && echo -e "  Weekly VACUUM : ${GREEN}enabled${RESET}  ($cron_vacuum)" \
        || echo -e "  Weekly VACUUM : ${DIM}disabled${RESET}"
    if pgs_installed; then
        [[ -f "$PGS_CRON_VACUUM" ]] \
            && echo -e "  Games VACUUM  : ${GREEN}enabled${RESET}  ($PGS_CRON_VACUUM)" \
            || echo -e "  Games VACUUM  : ${DIM}disabled${RESET}"
    fi

    echo ""
    echo -e "  ${GREEN}1${RESET}) Toggle daily backup (02:00 UTC)"
    echo -e "  ${GREEN}2${RESET}) Toggle weekly SQLite VACUUM (Sunday 03:00 UTC)"
    if pgs_installed; then
        echo -e "  ${GREEN}3${RESET}) Toggle weekly games VACUUM (Sunday 03:30 UTC — stops the games only)"
    fi
    echo ""
    echo -e "  ${GREEN}V${RESET}) Run pool VACUUM now   ${DIM}(stops the pool — use a planned window)${RESET}"
    if pgs_installed; then
        echo -e "  ${GREEN}G${RESET}) Run games VACUUM now  ${DIM}(stops the games only)${RESET}"
    fi
    echo -e "  ${DIM}0) Back${RESET}"
    echo -ne "Choice: "
    read -r cc

    case "$cc" in
        1)
            # Delegates to the shared-engine schedule (encrypted archive + offsite
            # push + retention) — same toggle as B) Backup & Restore → Schedule.
            pbk_schedule || true
            _pool_pause
            ;;
        2)
            if [[ -f "$cron_vacuum" ]]; then
                rm -f "$cron_vacuum" "$vacuum_script"
                success "Weekly VACUUM cron disabled."
            else
                # ⚠ Never a one-liner `sqlite3 pool.db "VACUUM;"` against the LIVE
                # database, weekly, while the service was running (audit §J7-1). VACUUM takes an
                # EXCLUSIVE lock for as long as it takes to rewrite the whole file — minutes on a
                # busy pool — and no `busy_timeout` survives that. Everything the backend writes in
                # that window fails, including the one write that cannot be redone: the INSERT that
                # records a block the pool just found. It also assumed /usr/bin/sqlite3 exists,
                # which the installer never installs (the app uses node:sqlite).
                #
                # So: stop the service, vacuum, start it again. The pool is down for the duration
                # — which is the honest cost of a VACUUM and far cheaper than a lost block — and
                # the restart is in a trap so a failed vacuum can never leave the pool stopped.
                if ! pool_write_vacuum_script; then
                    error "Could not write the maintenance script — VACUUM cron NOT enabled."
                    _pool_pause
                    return 0
                fi
                cat > "$cron_vacuum" << EOF
0 3 * * 0 root $vacuum_script >> $POOL_LOG 2>&1
EOF
                success "Weekly VACUUM cron enabled ($cron_vacuum)."
                warn "The pool is STOPPED for the duration of the vacuum (Sunday 03:00 UTC)."
                echo -e "  ${DIM}Miners reconnect on their own; shares submitted while it is down are lost,${RESET}"
                echo -e "  ${DIM}which is why it runs at the quietest hour. Run it by hand any time with:${RESET}"
                echo -e "    ${CYAN}$vacuum_script${RESET}"
            fi
            _pool_pause
            ;;
        3)
            if pgs_installed; then pgs_vacuum_toggle || true; _pool_pause; fi
            ;;
        v|V)
            _pool_vacuum_run_now pool "$POOL_SERVICE" "$POOL_APP_DIR/pool.db" \
                "$vacuum_script" pool_write_vacuum_script "$cron_vacuum" "$POOL_LOG" || true
            _pool_pause
            ;;
        g|G)
            if pgs_installed; then
                _pool_vacuum_run_now games "$PGS_SERVICE" "$PGS_DB" \
                    "$PGS_VACUUM_BIN" _pgs_write_vacuum_script "$PGS_CRON_VACUUM" "$PGS_LOG" || true
                _pool_pause
            fi
            ;;
    esac
}

# ═══════════════════════════════════════════════════════════════════════════════
# L) VIEW LOGS
# ═══════════════════════════════════════════════════════════════════════════════

pool_view_logs() {
    if [[ ! -f "$POOL_LOG" ]]; then
        warn "Log file not found: $POOL_LOG"
        return
    fi
    tail -n 50 "$POOL_LOG" | less -FRX
}

# ═══════════════════════════════════════════════════════════════════════════════
# DEL) RESET DATABASE
# ═══════════════════════════════════════════════════════════════════════════════

pool_reset_db() {
    local db_path="$POOL_APP_DIR/pool.db"

    echo -e "\n${RED}${BOLD}━━━ DANGER ZONE — Reset Pool Database (${POOL_NET_LABEL}) ━━━${RESET}"
    echo ""

    if [[ ! -f "$db_path" ]]; then
        warn "Database not found: $db_path"
        return
    fi

    local db_size; db_size=$(du -sh "$db_path" 2>/dev/null | cut -f1 || echo "?")
    local user_count
    user_count=$(_pool_db_scalar "SELECT COUNT(*) FROM users" "$db_path" || true)
    [[ -n "$user_count" ]] || user_count="?"

    echo -e "  Database : $db_path  ($db_size)"
    echo -e "  Users    : $user_count accounts"
    echo -e "  Network  : ${POOL_NET_LABEL}"
    echo ""
    warn "This will permanently DELETE all users, balances, shares, blocks, and withdrawals."
    echo ""
    echo -ne "Type ${RED}RESET POOL DATABASE${RESET} to confirm: "
    read -r confirm1
    [[ "$confirm1" != "RESET POOL DATABASE" ]] && { info "Aborted."; return; }

    echo -ne "Type ${RED}YES${RESET} to proceed: "
    read -r confirm2
    [[ "$confirm2" != "YES" ]] && { info "Aborted."; return; }

    pool_service_control stop 2>/dev/null || true
    sleep 1

    rm -f "${db_path:?refusing to rm — db_path is empty}"
    success "Database deleted."
    info "A fresh schema is created automatically when the service starts (lib/db.js)."

    pool_service_control start 2>/dev/null || true
}
