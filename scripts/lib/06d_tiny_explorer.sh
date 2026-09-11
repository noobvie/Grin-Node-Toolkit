# 06d_tiny_explorer.sh — Tiny Explorer: stateless, mainnet-only Grin block
# explorer for pool deep-links (e.g. scan.grin.money/block/<height>).
# Sourced by 06_global_grin_health.sh — inherits colors, log(), info(),
# success(), warn(), error(), die(), pause(), require_root().
#
# Model: web/06d_tiny_explorer/ (Node.js/Express, no DB). Single mainnet service
# grin-tiny-explorer. Secrets resolved live via grin_node_secrets.sh.
#
# Sourced lib → no shebang, no `set -e` of its own. Every tinyx_* entry point is
# dispatched from the 06 menu as `tinyx_x || true`, which disables errexit for the
# whole call tree below it (CLAUDE.md, project_lib_errexit_suppression) — so 06's
# `set -euo pipefail` protects nothing in here. Deploy therefore goes through
# tinyx_deploy_files(), which guards its own copy; the bare `cp -r` it replaced in
# tinyx_install / tinyx_update was exactly the shape that fails silently.

# ── Paths ─────────────────────────────────────────────────────────────────────

TINYX_DIR="/opt/grin/tiny-explorer"
TINYX_WEB="${TOOLKIT_ROOT}/web/06d_tiny_explorer"
TINYX_APP="${TINYX_DIR}/app"
TINYX_CONFIG="${TINYX_DIR}/config.json"
TINYX_LOG="${TINYX_DIR}/tiny-explorer.log"
TINYX_SVC="grin-tiny-explorer"
NGINX_TINYX_CONF="/etc/nginx/sites-available/tiny-explorer"
TINYX_PORT=8471

# ── Tor (Wallet Checker tier 2) ───────────────────────────────────────────────

# The liveness probe dials the wallet's onion through a LOCAL tor SOCKS proxy —
# tor as a CLIENT only, no hidden service. Ported from _acg_ensure_tor in
# 052_lib_gateway.sh so both products fail the same way.
#
# Called only when the operator has just answered "yes" to the probe. Before R9
# this function did not exist and the prompt merely printed "(apt install tor)",
# so the single most likely outcome of answering yes was a probe that returned
# "could not check" to every visitor — the exact state the off-by-default is
# there to prevent. Returns 0 when 127.0.0.1:<port> is listening, 1 otherwise;
# the caller decides what to do about it, because leaving the probe on with no
# tor is a choice an operator is allowed to make (they may be about to install
# it by hand) — but not one they should make by accident.
# Two loopback families and two ways of asking, because this answer is what the
# status screen turns red and what talks an operator out of the probe:
#   · a tor whose torrc says `SocksPort [::1]:9050` is up and usable, and the
#     old literal 127.0.0.1 match called it down;
#   · a box with no iproute2 has no `ss` at all, and returning 1 there reports
#     "no SOCKS" about a proxy nobody looked for.
# The fallback is bash's own /dev/tcp — an actual connect, which is better
# evidence than a listener table anyway. Run in a subshell so the fd closes with
# it; tor drops an unspoken SOCKS connection without complaint.
_tinyx_tor_socks_up() {
    local port="${1:-9050}"
    if command -v ss &>/dev/null; then
        ss -ltn 2>/dev/null | grep -Eq "(127\.0\.0\.1|\[::1\]):${port}([[:space:]]|$)" && return 0
        return 1
    fi
    (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null && return 0
    (exec 3<>"/dev/tcp/::1/${port}") 2>/dev/null && return 0
    return 1
}

_tinyx_ensure_tor() {
    local port="${1:-9050}"

    if ! command -v tor &>/dev/null; then
        echo -ne "  tor is not installed — install it now? [Y/n]: "
        local yn; read -r yn || true
        if [[ "${yn,,}" == "n" ]]; then
            return 1
        fi
        if command -v apt-get &>/dev/null; then
            # Refresh first, as 01_lib_source_build.sh / 052_lib_nginx.sh /
            # 07_lib_gateway.sh all do: a box whose apt cache predates the
            # current pool fails the install on 404s for URLs that no longer
            # exist, which reads as "tor is unavailable" rather than "run apt
            # update". Non-fatal — a stale cache may still have a usable tor.
            apt-get update -qq || warn "apt-get update reported errors — trying the install anyway."
            apt-get install -y tor || { error "apt-get install tor failed."; return 1; }
        elif command -v dnf &>/dev/null; then
            dnf install -y tor || { error "dnf install tor failed."; return 1; }
        else
            yum install -y tor || { error "yum install tor failed."; return 1; }
        fi
    fi

    systemctl is-active --quiet tor 2>/dev/null || systemctl is-active --quiet tor@default 2>/dev/null || {
        systemctl enable --now tor 2>/dev/null || systemctl enable --now tor@default 2>/dev/null || true
    }

    # Prove the SOCKS port is listening rather than trusting the unit state: a
    # tor that is "active" with SocksPort 0 in torrc looks healthy and proxies
    # nothing, and the probe would report every wallet as uncheckable.
    #
    # ⚠ POLL, never ask once. `systemctl enable --now tor` returns as soon as
    # the unit is started, which is BEFORE tor has read its torrc, opened its
    # control socket and bound SocksPort — a second or three on a small VPS.
    # Asking immediately therefore fails on a tor that was just installed
    # perfectly well, and the caller's next prompt ("Leave the probe enabled
    # anyway? [y/N]") defaults to No — so a successful install ended with the
    # probe switched OFF, which is the exact outcome this function exists to
    # prevent. 052's version gets away with one shot only because it merely
    # warns and always returns 0; this one's return value decides a setting.
    local waited=0
    while true; do
        if _tinyx_tor_socks_up "$port"; then
            success "Tor SOCKS proxy is listening on 127.0.0.1:${port}."
            return 0
        fi
        (( waited >= 15 )) && break
        [[ $waited -eq 0 ]] && info "Waiting for tor to bind 127.0.0.1:${port}..."
        sleep 1
        waited=$(( waited + 1 ))
    done
    warn "Nothing is listening on 127.0.0.1:${port} after ${waited}s — check: systemctl status tor; grep SocksPort /etc/tor/torrc"
    return 1
}

# ── Deploy ──────────────────────────────────────────────────────────────────────

# The ONE place app files are copied to the box. Both tinyx_install and
# tinyx_update call it; neither may go back to a bare `cp -r`.
#
# Two exclusions, and neither is cosmetic:
#   · test/  — the re-runnable assertion suite (fixtures + runners) added in R8.
#     It exists to be run in the repo before a change ships and has no job on a
#     production box, so it is EXCLUDED rather than "acceptable to ship".
#   · node_modules — if anyone ever ran `npm install` in the toolkit checkout, a
#     wholesale copy would clobber the box's `--omit=dev` tree with a dev tree.
#     The VPS builds its own via `npm install --prefix "$TINYX_APP"`.
#
# tar, not cp: `cp -r` has no --exclude. tar is present on every target distro,
# and the pipe is guarded by pipefail (set by 06_global_grin_health.sh and NOT
# suppressed by the `tinyx_x || true` dispatch, unlike errexit).
tinyx_deploy_files() {
    [[ -d "$TINYX_WEB" ]] || { error "Toolkit source missing: ${TINYX_WEB}"; return 1; }
    mkdir -p "$TINYX_APP" || { error "Could not create ${TINYX_APP}"; return 1; }
    tar -C "$TINYX_WEB" --exclude=./test --exclude=./node_modules -cf - .         | tar -C "$TINYX_APP" -xf -         || { error "Deploy failed: could not copy app files to ${TINYX_APP}"; return 1; }
    return 0
}

# ── Restart-onto-new-state helper ─────────────────────────────────────────────

# Anything that rewrites app files or config.json must land on the RUNNING
# process, and nothing else in this lib does that: server.js is read into memory
# once at exec, and config.json is JSON.parse'd once at startup and never re-read.
# `systemctl daemon-reload` does NOT help — it re-reads unit files only.
#
# The failure is silent and reads as a broken deploy rather than a stale one: the
# page shells ARE re-read from disk per request (sendEntityPage), so a new
# index.html shows its new tool cards at once while the routes behind them exist
# only in the new server.js and 404 out of the OLD process's catch-all handler.
# New pages, old router. That is exactly how /proof, /wallet-check, /node-check
# and /mining shipped dead on an already-running box.
#
# No-op (rc 0) when the service is not running — the caller's own Start step will
# pick the new state up. rc 1 only when a restart was attempted and FAILED, i.e.
# the box is still serving the old state.
tinyx_restart_if_running() {
    local what="${1:-build}"
    systemctl is-active --quiet "$TINYX_SVC" || return 0
    info "Service is running — restarting it onto the new ${what}…"
    if ! systemctl restart "$TINYX_SVC" 2>/dev/null; then
        warn "Failed to restart ${TINYX_SVC} — it is STILL serving the old ${what}."
        echo -e "  ${DIM}Fix: systemctl restart ${TINYX_SVC}${RESET}"
        return 1
    fi
    sleep 3
    if ss -tlnp 2>/dev/null | grep -q ":${TINYX_PORT} "; then
        success "${TINYX_SVC} restarted — port :${TINYX_PORT} listening."
    else
        warn "${TINYX_SVC} restarted but port :${TINYX_PORT} is not listening."
        echo -e "  ${DIM}Check: journalctl -u ${TINYX_SVC} -n 20${RESET}"
    fi
    return 0
}

# ── Install ───────────────────────────────────────────────────────────────────

tinyx_install() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── Tiny Explorer: Install ──${RESET}\n"

    echo -e "  ${DIM}Stateless mainnet block explorer — no SQLite, no crawler.${RESET}"
    echo -e "  ${DIM}Best served by an ARCHIVE node so old permalinks resolve.${RESET}\n"

    # Archive pre-flight (informational — Tiny Explorer still runs on a pruned node,
    # but old /block/<height> links below the pruning horizon will 404).
    if [[ -d /opt/grin/node/mainnet-full ]] && \
       grep -qs "^archive_mode *= *true" /opt/grin/node/mainnet-full/grin-server.toml 2>/dev/null; then
        success "Archive node detected at /opt/grin/node/mainnet-full ✓"
    else
        warn "Archive node not confirmed — old block permalinks may return 404."
        echo -e "  ${DIM}For full history: Script 01 → Setup Grin New Node → Archive mode.${RESET}"
        echo -ne "  Continue anyway? [Y/n]: "; read -r c
        [[ "${c,,}" == "n" ]] && { info "Cancelled."; pause; return; }
    fi

    # Node.js (>= 18 is plenty — no node:sqlite needed here).
    local node_major=0
    if command -v node &>/dev/null; then
        node_major=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
    fi
    if [[ "${node_major:-0}" -ge 18 ]]; then
        success "Node.js $(node --version) ✓"
    else
        info "Installing Node.js 20.x via NodeSource…"
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash - || { die "NodeSource setup failed."; return; }
        apt-get install -y nodejs -qq || { die "Node.js install failed."; return; }
        success "Node.js installed: $(node --version)"
    fi

    info "Deploying app to ${TINYX_APP}…"
    tinyx_deploy_files || { die "Deploy failed."; return; }

    info "Installing npm dependencies…"
    npm install --prefix "${TINYX_APP}" --omit=dev --silent || { die "npm install failed."; return; }
    success "npm packages installed."

    chown -R www-data:www-data "${TINYX_DIR}"

    cat > "/etc/systemd/system/${TINYX_SVC}.service" <<UNIT
[Unit]
Description=Grin Tiny Explorer (mainnet block explorer)
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=${TINYX_APP}
ExecStart=/usr/bin/node ${TINYX_APP}/tiny-explorer-server.js
Environment=TINY_EXPLORER_CONFIG=${TINYX_CONFIG}
Restart=on-failure
RestartSec=10
StandardOutput=append:${TINYX_LOG}
StandardError=append:${TINYX_LOG}

[Install]
WantedBy=multi-user.target
UNIT

    systemctl daemon-reload

    # Re-running Install on a box that is ALREADY serving is the normal way a new
    # build lands, so the redeploy above must reach the running process.
    if systemctl is-active --quiet "$TINYX_SVC"; then
        tinyx_restart_if_running "build" || true
        success "Tiny Explorer updated — files redeployed and service restarted."
    else
        success "Tiny Explorer installed."
        echo -e "  Next: run ${BOLD}Configure (2)${RESET} to write config.json."
    fi
    log "tinyx_install complete"
    pause
}

# ── Configure ─────────────────────────────────────────────────────────────────

tinyx_configure() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── Tiny Explorer: Configure ──${RESET}\n"

    # Resolve the LIVE mainnet node dir + secrets via the shared helper.
    local node_dir foreign_secret_path owner_secret_path
    if declare -F grin_live_node_dir &>/dev/null; then
        node_dir=$(grin_live_node_dir mainnet 2>/dev/null || true)
        foreign_secret_path=$(grin_node_secret_path mainnet foreign 2>/dev/null || true)
        owner_secret_path=$(grin_node_secret_path mainnet owner 2>/dev/null || true)
    fi
    [[ -z "$node_dir" ]] && { node_dir="/opt/grin/node/mainnet-prune"; [[ -d /opt/grin/node/mainnet-full ]] && node_dir="/opt/grin/node/mainnet-full"; }
    [[ -z "$foreign_secret_path" ]] && foreign_secret_path="${node_dir}/.foreign_api_secret"
    [[ -z "$owner_secret_path"   ]] && owner_secret_path="${node_dir}/.api_secret"

    local node_url="http://127.0.0.1:3413/v2/foreign"
    local owner_url="http://127.0.0.1:3413/v2/owner"

    echo -e "  ${DIM}Live mainnet node: ${node_dir}${RESET}"
    echo -ne "  Node Foreign URL [${node_url}]: "; read -r u; [[ -n "$u" ]] && node_url="$u"

    # Connectivity pre-check
    info "Testing node connection…"
    if ! ss -tlnp 2>/dev/null | grep -q ":3413 "; then
        warn "Mainnet node API :3413 not listening — is the node running?"
        echo -ne "  Continue anyway? [Y/n]: "; read -r c; [[ "${c,,}" == "n" ]] && { info "Cancelled."; pause; return; }
    elif [[ -f "$owner_secret_path" ]]; then
        local secret resp
        secret=$(tr -d '[:space:]' < "$owner_secret_path" 2>/dev/null || true)
        resp=$(curl -s --max-time 5 -u "grin:${secret}" -H 'Content-Type: application/json' \
            -d '{"jsonrpc":"2.0","method":"get_status","params":[],"id":1}' "$owner_url" 2>/dev/null || true)
        echo "$resp" | grep -q '"sync_status"' && success "Node reachable ✓" || warn "Node not reachable at ${owner_url}"
    fi

    # Domain (prompted, never hardcoded; example only)
    echo ""
    echo -ne "  Public domain (e.g. scan.grin.money): "; read -r domain
    [[ -z "$domain" ]] && { warn "Domain required."; pause; return; }
    if [[ ! "$domain" =~ ^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$ ]]; then
        warn "Invalid domain '${domain}'."; pause; return
    fi
    local base_url="https://${domain}"

    # Optional custom slogan (a good default is baked into the pages)
    echo -ne "  Slogan under the logo (blank = keep default): "; read -r slogan

    # GA4 (optional). Sample id shown per operator request.
    local ga4_id=""
    echo -ne "  GA4 Measurement ID (blank to disable, e.g. G-05D6ERFRVW): "; read -r ga4_input
    if [[ -n "$ga4_input" ]]; then
        if [[ "$ga4_input" =~ ^G- ]]; then ga4_id="$ga4_input"; else warn "GA4 ID must start with 'G-' — analytics disabled."; fi
    fi

    # world.grin.money stats source for the "Node peers · 30d" card
    local peers_stats_url="https://world.grin.money"
    echo -ne "  Peers-stats source URL [${peers_stats_url}]: "; read -r p; [[ -n "$p" ]] && peers_stats_url="${p%/}"

    # Wallet Checker tier 2 — the Tor liveness probe (POST /api/wallet-check).
    #
    # ON by default for a NEW install (changed 2026-09-10). "Is this wallet
    # answering right now?" is the reason most visitors open the Wallet Checker
    # at all, and leaving it off shipped a tile that answered every question
    # except the one that was asked. The original default was written when this
    # prompt could only DETECT a missing tor daemon; _tinyx_ensure_tor now
    # installs one, starts it and polls until SOCKS is actually bound, so the
    # box no longer has to arrive qualified — it can be made so here.
    #
    # ⚠ This is the INSTALLER default, not the code default. The server still
    # treats a missing wallet_check_probe key as false (tiny-explorer-server.js,
    # `config.wallet_check_probe === true`) and that must stay: a config that
    # lost the key — hand-edited, half-restored, written by an older toolkit —
    # must fail CLOSED rather than start dialling Tor because a line went
    # missing. The two defaults answer different questions: this one is "what
    # should a fresh box do", that one is "what does an unreadable config mean".
    #
    # The current value is READ BACK from the existing config first, and now
    # reads BOTH values, not just true. This function rewrites config.json
    # wholesale, so a one-sided read-back silently overwrites whichever choice
    # is not the default: before, an operator who turned the probe ON lost it by
    # re-running Configure for a new domain; with the default flipped, a
    # one-sided read-back would do the same to an operator who deliberately
    # turned it OFF. An explicit value in the config is a decision and outranks
    # the default in both directions — only an install whose config does not
    # already record a choice gets the default. That is very nearly "a new
    # install" but not exactly: a config written before this key existed
    # (pre-99087d9) matches neither grep and takes the default too. The
    # operator still sees the prompt, so it is a proposal, never a migration.
    local wallet_probe="true"
    if [[ -f "$TINYX_CONFIG" ]]; then
        if grep -Eq '"wallet_check_probe"[[:space:]]*:[[:space:]]*true' "$TINYX_CONFIG" 2>/dev/null; then
            wallet_probe="true"
        elif grep -Eq '"wallet_check_probe"[[:space:]]*:[[:space:]]*false' "$TINYX_CONFIG" 2>/dev/null; then
            wallet_probe="false"
        fi
    fi
    local tor_socks_port=9050
    local tor_up="no"
    echo ""
    if _tinyx_tor_socks_up "$tor_socks_port"; then
        tor_up="yes"
        echo -e "  ${DIM}Tor SOCKS detected on 127.0.0.1:${tor_socks_port}.${RESET}"
    else
        echo -e "  ${DIM}No Tor SOCKS listener on 127.0.0.1:${tor_socks_port} — the probe needs one; this can install it.${RESET}"
    fi
    local probe_hint="y/N"; [[ "$wallet_probe" == "true" ]] && probe_hint="Y/n"
    # Name the consequence IN the prompt when the default is yes and the box has
    # no tor. Installing a daemon is a side effect beyond what "set up an
    # explorer" implies, and an operator pressing Enter through the prompts
    # should not discover it afterwards. The install itself still asks
    # separately inside _tinyx_ensure_tor — this is the warning, not the
    # consent.
    local probe_extra=""
    [[ "$wallet_probe" == "true" && "$tor_up" != "yes" ]] && probe_extra=" ${DIM}(installs tor)${RESET}"
    # `|| probe_ans="n"` is the EOF branch and it must DECLINE, not fall through
    # to the default. A read at EOF (stdin closed, Configure driven from a pipe)
    # returns non-zero and leaves the variable empty — indistinguishable from a
    # pressed Enter — and with the default now yes that walks straight into
    # _tinyx_ensure_tor and apt-get installs a daemon with nobody at the
    # keyboard. A printed default is an offer to a human; with no human, take
    # the answer that changes nothing.
    local probe_ans
    echo -ne "  Enable the Wallet Checker Tor liveness probe?${probe_extra} [${probe_hint}]: "
    read -r probe_ans || probe_ans="n"
    # The catch-all keeps the DEFAULT and must never name a value. It used to be
    # `*) wallet_probe="false"`, which was invisible while the default was false
    # and became a live bug the moment it flipped: the prompt printed [Y/n]
    # while every input but a bare "y"/"yes" — "Y " with the space a paste
    # leaves behind, "ye", "1" — silently answered no, with nothing echoed to
    # say so. This is also the idiom the rest of this file already uses (:284,
    # :560): only an explicit n means no.
    if [[ -n "$probe_ans" ]]; then
        case "${probe_ans,,}" in
            y|yes) wallet_probe="true" ;;
            n|no)  wallet_probe="false" ;;
            *)     warn "Unrecognised answer '${probe_ans}' — keeping the default (${wallet_probe})." ;;
        esac
    fi

    # Answering "yes" with no tor on the box used to write the flag and stop
    # there, leaving a button that could only ever answer "could not check" —
    # which reads to a visitor as every wallet being offline, not as an
    # unequipped server. So offer the install here, and if it does not come up,
    # say plainly what the operator is choosing before writing the flag.
    if [[ "$wallet_probe" == "true" && "$tor_up" != "yes" ]]; then
        if ! _tinyx_ensure_tor "$tor_socks_port"; then
            echo -e "  ${DIM}Without a SOCKS proxy the probe answers \"could not check\" every time.${RESET}"
            echo -ne "  Leave the probe enabled anyway? [y/N]: "
            local keep; read -r keep || true
            case "${keep,,}" in
                y|yes) warn "Probe left ON — install tor, then: systemctl restart ${TINYX_SVC}" ;;
                *)     wallet_probe="false"; info "Probe left OFF. Re-run Configure once tor is listening." ;;
            esac
        fi
    fi

    mkdir -p "${TINYX_DIR}"

    # Copy node secrets into the app data dir (www-data-owned, 600) — same model
    # as GrinScan so www-data need not join the grin group.
    local tx_foreign="${TINYX_DIR}/.foreign_api_secret"
    local tx_owner="${TINYX_DIR}/.api_secret"
    if [[ -f "$foreign_secret_path" ]]; then cp "$foreign_secret_path" "$tx_foreign"; chown www-data:www-data "$tx_foreign"; chmod 600 "$tx_foreign"; else warn "Foreign secret not found at ${foreign_secret_path}."; fi
    if [[ -f "$owner_secret_path"   ]]; then cp "$owner_secret_path"   "$tx_owner";   chown www-data:www-data "$tx_owner";   chmod 600 "$tx_owner";   else warn "Owner secret not found at ${owner_secret_path}.";   fi

    # Build the fallback_explorers array + optional slogan line via a heredoc.
    #
    # ⚠ tor_onion_virtual_port is 80, NOT 3415. grin-wallet publishes the wallet
    # foreign-API hidden service as `HiddenServicePort 80 <listener>`
    # (impls/src/tor/config.rs, source-verified 2026-07-19). 3415 is the CLEARNET
    # listener port and dialling it through Tor fails for every healthy wallet
    # there is — which reads as "everyone is offline", not as a bug. Do not
    # "correct" this to match the wallet port table in CLAUDE.md.
    cat > "$TINYX_CONFIG" <<JSON
{
  "network":             "mainnet",
  "node_url":            "${node_url}",
  "node_owner_url":      "${owner_url}",
  "foreign_secret_path": "${tx_foreign}",
  "owner_secret_path":   "${tx_owner}",
  "port":                ${TINYX_PORT},
  "web_dir":             "${TINYX_APP}/public",
  "domain":              "${domain}",
  "base_url":            "${base_url}",
  "slogan":              "${slogan}",
  "block_cache_ms":      45000,
  "tip_cache_ms":        30000,
  "price_cache_ms":      120000,
  "peers_cache_ms":      3600000,
  "latest_count":        20,
  "peers_stats_url":     "${peers_stats_url}",
  "wallet_check_probe":  ${wallet_probe},
  "tor_socks_host":      "127.0.0.1",
  "tor_socks_port":      ${tor_socks_port},
  "tor_onion_virtual_port": 80,
  "tor_check_timeout_ms":   8000,
  "tor_check_retries":      2,
  "node_check_max_inflight": 8,
  "ga4_measurement_id":  "${ga4_id}",
  "fallback_explorers": [
    { "name": "Grincoin.org", "url": "https://grincoin.org", "blurb": "Full archive explorer — deep block bodies since genesis." },
    { "name": "GrinScan",     "url": "https://grinscan.org", "blurb": "Dual-network explorer with charts, peers, price, and a REST API." }
  ]
}
JSON

    # A blank slogan is left as "" in the config — the server treats it as falsy
    # and falls back to its baked default (no fragile post-edit needed).

    chown www-data:www-data "$TINYX_CONFIG"
    chown -R www-data:www-data "${TINYX_DIR}"
    success "Config written: ${TINYX_CONFIG}"

    # Register with the shared secret self-heal so a node rebuild re-copies secrets
    # and restarts grin-tiny-explorer (grin_sync_tiny_explorer in grin_node_secrets.sh).
    if declare -F grin_install_secret_sync &>/dev/null; then grin_install_secret_sync || true; fi

    echo ""
    # config.json is parsed ONCE at startup, so every value written above is inert
    # on a live service until it is restarted. The Wallet Checker Tor probe is the
    # sharp edge: the page decides whether to offer the button from
    # window.TINYEXP_WALLET_PROBE, injected at render from the value the PROCESS
    # holds — so an un-restarted box keeps showing tier 1 and the toggle reads as
    # a control that does nothing.
    if systemctl is-active --quiet "$TINYX_SVC"; then
        tinyx_restart_if_running "config" || true
        echo -e "  Next: ${BOLD}Setup Nginx (4)${RESET} if you have not already."
    else
        echo -e "  Next: ${BOLD}Service Control (3) → Start${RESET}, then ${BOLD}Setup Nginx (4)${RESET}."
    fi
    log "tinyx_configure: ${domain} → ${TINYX_CONFIG}"
    pause
}

# ── Service Control ───────────────────────────────────────────────────────────

tinyx_service_control() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── Tiny Explorer: Service Control ──${RESET}\n"
    echo -e "  ${GREEN}S${RESET}) Start   ${GREEN}T${RESET}) Stop   ${RED}R${RESET}) Remove service   ${DIM}0) Cancel${RESET}"
    echo -ne "\n${BOLD}Action [S/T/R/0]: ${RESET}"; read -r action

    case "${action^^}" in
        S)
            [[ -f "$TINYX_CONFIG" ]] || { warn "Config not found. Run Configure (2) first."; pause; return; }
            systemctl start "$TINYX_SVC" 2>/dev/null && success "${TINYX_SVC} started." || { error "Failed to start ${TINYX_SVC}."; pause; return; }
            local waited=0
            while [[ $waited -lt 10 ]]; do
                sleep 2; waited=$((waited+2))
                if ss -tlnp 2>/dev/null | grep -q ":${TINYX_PORT} "; then
                    success "Port :${TINYX_PORT} is listening."
                    echo -e "  Local URL: ${CYAN}http://127.0.0.1:${TINYX_PORT}${RESET}"
                    break
                fi
            done
            ss -tlnp 2>/dev/null | grep -q ":${TINYX_PORT} " || warn "Port :${TINYX_PORT} not listening yet — check: journalctl -u ${TINYX_SVC} -n 20"
            ;;
        T)
            systemctl stop "$TINYX_SVC" 2>/dev/null && success "${TINYX_SVC} stopped." || warn "${TINYX_SVC} was not running."
            ;;
        R)
            systemctl stop "$TINYX_SVC" 2>/dev/null || true
            systemctl disable "$TINYX_SVC" 2>/dev/null || true
            rm -f "/etc/systemd/system/${TINYX_SVC}.service"
            systemctl daemon-reload
            success "${TINYX_SVC} removed."
            ;;
        0|"") return ;;
        *) warn "Invalid action."; sleep 1 ;;
    esac
    log "tinyx_service_control: ${action}"
    pause
}

# ── Setup Nginx ───────────────────────────────────────────────────────────────

tinyx_setup_nginx() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── Tiny Explorer: Setup Nginx ──${RESET}\n"

    command -v nginx   &>/dev/null || { die "Nginx not installed. Run option N first."; return; }
    nginx_ensure_certbot

    local domain=""
    [[ -f "$TINYX_CONFIG" ]] && domain=$(grep -oE '"domain":[[:space:]]*"[^"]*"' "$TINYX_CONFIG" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
    local cfg_domain="$domain"
    echo -ne "  Public domain (e.g. scan.grin.money)${domain:+ [${domain}]}: "; read -r d
    [[ -n "$d" ]] && domain="$d"
    [[ -z "$domain" ]] && { warn "Domain required."; pause; return; }
    if [[ ! "$domain" =~ ^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$ ]]; then warn "Invalid domain."; pause; return; fi

    # The domain lives in TWO places and only ONE of them is prompted here. The
    # vhost decides which host reaches the app; config.json's domain/base_url are
    # baked into <title>, the canonical link and every og:/twitter: tag at render
    # time (injectGlobals). Typing a different host here therefore serves host A
    # while all seven pages claim host B — which crawlers act on and no visitor
    # ever sees. Sync it rather than letting the two drift silently.
    if [[ -n "$cfg_domain" && "$domain" != "$cfg_domain" && -f "$TINYX_CONFIG" ]]; then
        echo ""
        warn "config.json still says ${cfg_domain} — page titles, canonical and og: tags would claim that host."
        echo -ne "  Update config.json to ${domain} and restart the service? [Y/n]: "; read -r sync_ans
        if [[ "${sync_ans,,}" != "n" ]]; then
            if sed -i -e "s|\"domain\":[[:space:]]*\"[^\"]*\"|\"domain\":              \"${domain}\"|" \
                      -e "s|\"base_url\":[[:space:]]*\"[^\"]*\"|\"base_url\":            \"https://${domain}\"|" \
                      "$TINYX_CONFIG"; then
                success "config.json domain → ${domain}"
                tinyx_restart_if_running "domain" || true
            else
                warn "Could not update ${TINYX_CONFIG} — edit domain/base_url by hand, or re-run Configure (2)."
            fi
        else
            warn "Left as-is — canonical and og: tags will keep pointing at ${cfg_domain}."
        fi
    fi

    echo -e "  ${YELLOW}Note:${RESET} pointing this domain here ${BOLD}repoints it from option C (grincoin clone) to D${RESET} if C used it."

    local ssl_email=""
    if ! certbot accounts list 2>/dev/null | grep -q "Account ID"; then
        echo -ne "  Email for SSL certificate (Let's Encrypt): "; read -r ssl_email
        [[ -z "$ssl_email" ]] && { warn "Email required for first certbot run."; pause; return; }
    fi

    # Unique rate-limit zones (never reuse grinscan_api) — via shared helper w/ fallback.
    #
    # TWO conf basenames, deliberately. nginx_ensure_rate_limit_zone is a NO-OP when its
    # conf file already exists, so appending tinyx_probe to script06d-rate-limit.conf would
    # work on a fresh install and SILENTLY never reach a box installed before phase 2. A
    # second basename is the only form that lands on both. Never merge these two files, and
    # never reuse tinyx_api for the probe routes — they are rated an order of magnitude
    # apart because a probe spends an outbound connection, not a chain read.
    if declare -F nginx_ensure_rate_limit_zone &>/dev/null; then
        nginx_ensure_rate_limit_zone "tinyx_api"   "30r/m" "10m" "script06d-rate-limit"
        nginx_ensure_rate_limit_zone "tinyx_probe" "10r/m" "10m" "script06d-probe-rate-limit"
    else
        local rate_conf="/etc/nginx/conf.d/script06d-rate-limit.conf"
        if [[ ! -f "$rate_conf" ]]; then
            mkdir -p /etc/nginx/conf.d
            echo 'limit_req_zone $binary_remote_addr zone=tinyx_api:10m rate=30r/m;' > "$rate_conf"
        fi
        local probe_conf="/etc/nginx/conf.d/script06d-probe-rate-limit.conf"
        if [[ ! -f "$probe_conf" ]]; then
            mkdir -p /etc/nginx/conf.d
            echo 'limit_req_zone $binary_remote_addr zone=tinyx_probe:10m rate=10r/m;' > "$probe_conf"
        fi
    fi

    info "Writing nginx config for ${domain}…"
    # proxy_pass ALL paths (crucially /block/<height>) to the Node app — no static
    # rule may intercept the pool deep-link path.
    cat > "$NGINX_TINYX_CONF" <<NGINX
server {
    listen 80;
    server_name ${domain};

    # Probe routes only. An exact-match location wins outright over the /api/ prefix
    # below, so these do NOT also carry tinyx_api — one bucket each, the tighter one.
    # Both routes are live: node-check spends an outbound HTTP request, wallet-check
    # a Tor circuit for up to tor_check_retries x tor_check_timeout_ms. That is why
    # they are rated an order of magnitude below the chain reads on /api/.
    # wallet-check answers 503 {"reason":"probe_disabled"} while wallet_check_probe
    # is false, which is the default — the page never offers the control then.
    location = /api/node-check {
        limit_req zone=tinyx_probe burst=5 nodelay;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_pass http://127.0.0.1:${TINYX_PORT};
    }

    location = /api/wallet-check {
        limit_req zone=tinyx_probe burst=5 nodelay;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_pass http://127.0.0.1:${TINYX_PORT};
    }

    location /api/ {
        limit_req zone=tinyx_api burst=20 nodelay;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_pass http://127.0.0.1:${TINYX_PORT};
    }

    location / {
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_pass http://127.0.0.1:${TINYX_PORT};
    }
}
NGINX

    ln -sf "$NGINX_TINYX_CONF" "/etc/nginx/sites-enabled/$(basename "$NGINX_TINYX_CONF")" 2>/dev/null || true
    nginx -t 2>&1 | while IFS= read -r line; do echo "  $line"; done || { die "nginx config test failed."; return; }
    systemctl reload nginx || true
    success "Nginx config applied."

    info "Requesting SSL certificate from Let's Encrypt…"
    local certbot_email_args=(); [[ -n "$ssl_email" ]] && certbot_email_args=(--email "$ssl_email")
    certbot --nginx -d "$domain" --non-interactive --agree-tos "${certbot_email_args[@]}" --redirect \
        && success "SSL certificate issued for ${domain}." \
        || warn "Certbot failed — check DNS/connectivity."

    cat > "/etc/logrotate.d/tiny-explorer" <<LOGROTATE
${TINYX_LOG} {
    daily
    rotate 14
    compress
    missingok
    notifempty
    copytruncate
}
LOGROTATE

    success "Nginx + SSL setup complete."
    echo -e "  URL: ${CYAN}https://${domain}${RESET}"
    echo -e "  Deep-link test: ${CYAN}https://${domain}/block/<height>${RESET}"
    echo -e "  Kernel proof:   ${CYAN}https://${domain}/kernel/<excess>${RESET}"
    echo -e "  Output lookup:  ${CYAN}https://${domain}/output/<commit>${RESET}"
    log "tinyx_setup_nginx: ${domain}"
    pause
}

# ── Auto-Start ────────────────────────────────────────────────────────────────

tinyx_autostart() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── Tiny Explorer: Auto-Start on Boot ──${RESET}\n"
    systemctl enable "$TINYX_SVC" 2>/dev/null && success "${TINYX_SVC} enabled for auto-start." || warn "Failed to enable ${TINYX_SVC}."
    log "tinyx_autostart"
    pause
}

# ── Status ────────────────────────────────────────────────────────────────────

tinyx_status() {
    clear
    echo -e "\n${BOLD}${CYAN}── Tiny Explorer: Status ──${RESET}\n"

    local active; active=$(systemctl is-active "$TINYX_SVC" 2>/dev/null || echo inactive)
    [[ "$active" == active ]] && echo -e "  Service:  ${GREEN}● running${RESET}" || echo -e "  Service:  ${RED}○ ${active}${RESET}"
    ss -tlnp 2>/dev/null | grep -q ":${TINYX_PORT} " && echo -e "  Port :${TINYX_PORT}: ${GREEN}listening${RESET}" || echo -e "  Port :${TINYX_PORT}: ${YELLOW}not listening${RESET}"
    [[ -f "$TINYX_CONFIG" ]] && echo -e "  Config:   ${GREEN}✓ ${TINYX_CONFIG}${RESET}" || echo -e "  Config:   ${RED}✗ not found${RESET}"

    # Wallet Checker tier 2. This line exists because the probe's failure mode is
    # otherwise invisible from here: the flag can be on while tor is gone or has
    # SocksPort 0, and every visitor then gets "could not check" while the
    # service, port, config and nginx rows all read green. Nothing else on this
    # screen looks at tor.
    if [[ -f "$TINYX_CONFIG" ]]; then
        local probe_port
        probe_port=$(grep -oE '"tor_socks_port"[[:space:]]*:[[:space:]]*[0-9]+' "$TINYX_CONFIG" 2>/dev/null | grep -oE '[0-9]+$')
        probe_port="${probe_port:-9050}"
        if grep -Eq '"wallet_check_probe"[[:space:]]*:[[:space:]]*true' "$TINYX_CONFIG" 2>/dev/null; then
            if _tinyx_tor_socks_up "$probe_port"; then
                echo -e "  Probe:    ${GREEN}✓ on${RESET}  ${DIM}Tor SOCKS 127.0.0.1:${probe_port} listening${RESET}"
            else
                echo -e "  Probe:    ${RED}on, but no Tor SOCKS on 127.0.0.1:${probe_port}${RESET}"
                echo -e "            ${DIM}Every wallet check answers \"could not check\" — systemctl status tor${RESET}"
            fi
        else
            # Off is no longer the default, so say how to change it: reaching
            # this line now means someone chose it or a tor install failed.
            echo -e "  Probe:    ${DIM}off — Wallet Checker is address-only (no liveness button)${RESET}"
            echo -e "            ${DIM}Turn it on with Configure (2) — it is on by default for new installs.${RESET}"
        fi
    fi

    if [[ -f "$NGINX_TINYX_CONF" ]]; then
        local domain; domain=$(grep -E "^\s+server_name " "$NGINX_TINYX_CONF" | awk '{print $2}' | tr -d ';' | head -1)
        echo -e "  Nginx:    ${GREEN}✓ configured${RESET}  ${DIM}${domain}${RESET}"
        if [[ -n "$domain" ]] && certbot certificates 2>/dev/null | grep -q "$domain"; then
            echo -e "  SSL:      ${GREEN}✓ active${RESET}"
        else
            echo -e "  SSL:      ${YELLOW}not issued${RESET}"
        fi
    else
        echo -e "  Nginx:    ${YELLOW}not configured${RESET}"
    fi

    if [[ "$active" == active ]]; then
        local tip; tip=$(curl -s --max-time 4 "http://127.0.0.1:${TINYX_PORT}/api/tip" 2>/dev/null || true)
        [[ -n "$tip" ]] && echo -e "  Tip:      ${CYAN}${tip}${RESET}"

        # Staleness guard. server.js and config.json are read ONCE at exec, so a
        # process older than the files on disk is serving code the box no longer
        # has — the exact state in which the tool pages 404 while the homepage
        # already links to them. Nothing else in this lib can see that, so it has
        # to be reported here rather than left to be inferred from a 404.
        # tar preserves mtimes on deploy, so a file's mtime is its checkout time:
        # newer-than-start means it arrived after this process did.
        local started_epoch=0 newest_app=0 cfg_epoch=0 raw_started=""
        raw_started=$(systemctl show -p ActiveEnterTimestamp --value "$TINYX_SVC" 2>/dev/null || true)
        [[ -n "$raw_started" ]] && started_epoch=$(date -d "$raw_started" +%s 2>/dev/null || echo 0)
        newest_app=$(find "$TINYX_APP" -path "${TINYX_APP}/node_modules" -prune -o -type f -printf '%T@\n' 2>/dev/null \
            | sort -n | tail -1 | cut -d. -f1)
        [[ -f "$TINYX_CONFIG" ]] && cfg_epoch=$(stat -c %Y "$TINYX_CONFIG" 2>/dev/null || echo 0)
        if [[ "${started_epoch:-0}" -gt 0 ]]; then
            if [[ "${newest_app:-0}" -gt "$started_epoch" ]]; then
                echo ""
                warn "App files are NEWER than the running process — it is serving the old build."
                echo -e "  ${DIM}New pages/routes will 404 until you run ${BOLD}U) Update${RESET}${DIM} (or: systemctl restart ${TINYX_SVC}).${RESET}"
            elif [[ "${cfg_epoch:-0}" -gt "$started_epoch" ]]; then
                echo ""
                warn "config.json is NEWER than the running process — its settings are not in effect."
                echo -e "  ${DIM}Restart to apply: systemctl restart ${TINYX_SVC}${RESET}"
            fi
        fi
    fi
    echo ""
    pause
}

# ── Logs ──────────────────────────────────────────────────────────────────────

tinyx_logs() {
    clear
    echo -e "\n${BOLD}${CYAN}── Tiny Explorer: Logs ──${RESET}\n"
    if [[ ! -f "$TINYX_LOG" ]]; then warn "No log found: ${TINYX_LOG}"; pause; return; fi
    echo -e "  ${DIM}Log: ${TINYX_LOG}${RESET}\n"
    tail -n 50 "$TINYX_LOG"
    echo ""
    echo -ne "  ${GREEN}F${RESET}) Follow live   ${DIM}0) Back${RESET}  [F/0]: "; read -r fol
    [[ "${fol^^}" == "F" ]] && { echo -e "  ${DIM}Ctrl+C to stop.${RESET}"; tail -f "$TINYX_LOG" || true; }
}

# ── Update ────────────────────────────────────────────────────────────────────

tinyx_update() {
    require_root
    clear
    echo -e "\n${BOLD}${CYAN}── Tiny Explorer: Update ──${RESET}\n"
    [[ -d "$TINYX_APP" ]] || { warn "Not installed. Run Install (1) first."; pause; return; }

    info "Redeploying app files from toolkit…"
    tinyx_deploy_files || { die "Redeploy failed — app files left as they were."; pause; return; }
    chown -R www-data:www-data "${TINYX_DIR}"
    success "App files redeployed."

    info "Updating npm dependencies…"
    npm install --prefix "${TINYX_APP}" --omit=dev --silent && success "npm packages updated." || warn "npm install reported errors."

    systemctl restart "$TINYX_SVC" 2>/dev/null && success "${TINYX_SVC} restarted." || warn "Failed to restart ${TINYX_SVC}."
    sleep 3
    ss -tlnp 2>/dev/null | grep -q ":${TINYX_PORT} " && success "Port :${TINYX_PORT} listening." || warn "Port :${TINYX_PORT} not listening after restart."
    log "tinyx_update"
    pause
}

# ── Nuke ──────────────────────────────────────────────────────────────────────

tinyx_nuke() {
    require_root
    clear
    echo -e "\n${BOLD}${RED}── Tiny Explorer: Nuke ──${RESET}\n"
    echo -e "  ${YELLOW}Stops + disables the service, removes the app dir, and removes ONLY${RESET}"
    echo -e "  ${YELLOW}Tiny Explorer's nginx vhost + its two rate-limit zone confs${RESET}"
    echo -e "  ${YELLOW}(script06d-rate-limit.conf, script06d-probe-rate-limit.conf).${RESET}"
    echo -e "  ${DIM}Does NOT touch Node.js or the Grin node.${RESET}\n"
    echo -ne "  ${BOLD}${RED}Type 'nuke' to confirm: ${RESET}"; read -r confirm
    [[ "$confirm" != "nuke" ]] && { info "Cancelled — nothing removed."; sleep 1; return; }

    systemctl is-active  "$TINYX_SVC" &>/dev/null && systemctl stop    "$TINYX_SVC" 2>/dev/null && success "Stopped ${TINYX_SVC}"
    systemctl is-enabled "$TINYX_SVC" &>/dev/null && systemctl disable "$TINYX_SVC" 2>/dev/null || true
    [[ -f "/etc/systemd/system/${TINYX_SVC}.service" ]] && { rm -f "/etc/systemd/system/${TINYX_SVC}.service"; success "Removed systemd unit"; }
    systemctl daemon-reload

    [[ -d "$TINYX_DIR" ]] && { rm -rf "${TINYX_DIR:?}"; success "Removed ${TINYX_DIR}"; }

    local nginx_link="/etc/nginx/sites-enabled/$(basename "$NGINX_TINYX_CONF")"
    [[ -f "$NGINX_TINYX_CONF" ]] && { rm -f "$NGINX_TINYX_CONF"; success "Removed ${NGINX_TINYX_CONF}"; }
    [[ -L "$nginx_link" ]] && { rm -f "$nginx_link"; success "Removed ${nginx_link}"; }
    [[ -f /etc/nginx/conf.d/script06d-rate-limit.conf ]] && { rm -f /etc/nginx/conf.d/script06d-rate-limit.conf; success "Removed script06d-rate-limit.conf"; }
    [[ -f /etc/nginx/conf.d/script06d-probe-rate-limit.conf ]] && { rm -f /etc/nginx/conf.d/script06d-probe-rate-limit.conf; success "Removed script06d-probe-rate-limit.conf"; }
    [[ -f /etc/logrotate.d/tiny-explorer ]] && rm -f /etc/logrotate.d/tiny-explorer

    if command -v nginx &>/dev/null && systemctl is-active nginx &>/dev/null; then
        nginx -t &>/dev/null && systemctl reload nginx && success "Nginx reloaded." || warn "Nginx config test failed after nuke — reload manually."
    fi

    echo ""
    success "Nuke complete. Run Install (1) → Configure (2) to rebuild."
    log "tinyx_nuke"
    pause
}
