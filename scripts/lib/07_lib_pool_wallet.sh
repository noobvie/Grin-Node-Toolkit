# =============================================================================
# lib/07_lib_pool_wallet.sh — Coinbase + payout wallet for the PUBLIC POOL
# =============================================================================
# Same technique as lib/07_solo_wallet.sh, but for the public-pool product:
# pool naming (pw_*), pool directories (/opt/grin/pubpoolwallet/...), and TWO
# listeners instead of one, because a pool needs both wallet APIs running:
#
#   · Foreign API  (3415) — `grin-wallet listen`.  The Grin node's built-in
#       stratum calls this via grin-server.toml `wallet_listener_url` to
#       build_coinbase when a miner finds a block → THIS is how the pool
#       receives block rewards. No listener ⇒ the node can't build a block
#       template ⇒ the pool earns nothing.
#   · Owner API    (3420) — `grin-wallet owner_api`.  The pool backend
#       (back-end-pool/lib/wallet.js) opens an ECDH session here to check the
#       balance and send Tor payouts to miners.
#
# Both run as separate tmux sessions against the SAME wallet dir — the proven
# pattern from Script 052 (Grin Drop), which runs `listen` + `owner_api` side
# by side the same way.
#
# Owns the password file the backend reads
# (/opt/grin/pubpool/mainnet/.wallet_pass, mode 600) — pw_setup writes it during
# init/recover (and prompts for it when an existing wallet has no saved copy).
# The listeners read it unattended so they can auto-start after a reboot/crash
# (boot autostart + */5 watchdog). pw_setup also records the wallet's address
# as pool_address in the pool config (the node-stratum login identity).
#
#   pw_setup                install binary + init|recover + patch tomls + start
#   pw_listener_start       (re)start BOTH listeners in tmux
#   pw_listener_stop        stop both
#   pw_listener_status      one line per listener
#   pw_show_address         print the pool wallet's Grin address
#   pw_patch_node_toml      point the node's wallet_listener_url at 3415
#   pw_autostart_enable / pw_autostart_disable / pw_autostart_status
#   pw_watchdog_install / pw_watchdog_remove / pw_watchdog_status
#
# Convention: sourced lib → NO shebang / NO `set -e`.
# =============================================================================

[[ -n "${_GRIN_POOL_WALLET_SH_LOADED:-}" ]] && return 0
_GRIN_POOL_WALLET_SH_LOADED=1

_PW_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=grin_wallet_install.sh
source "$_PW_LIB_DIR/grin_wallet_install.sh"
# shellcheck source=grin_node_control.sh
source "$_PW_LIB_DIR/grin_node_control.sh"

# ─── Constants (network-aware; env-overridable for testing) ──────────────────
# The pool now supports testnet (see CLAUDE.md). $POOL_NET is set by the parent script
# (mainnet|testnet). Testnet uses the grin-wallet testnet ports (13415/13420), the
# `--testnet` CLI flag, the testnet node dir, and `_testnet`-suffixed tmux/watchdog names
# so a testnet wallet never collides with a mainnet one on the same box.
_PW_NET="${POOL_NET:-mainnet}"
if [[ "$_PW_NET" == "testnet" ]]; then
    PW_FOREIGN_PORT="${PW_FOREIGN_PORT:-13415}"
    PW_OWNER_PORT="${PW_OWNER_PORT:-13420}"
    PW_NET_FLAG="--testnet"
    _PW_NODE_NET="testnet"
    PW_TMUX_FOREIGN="${PW_TMUX_FOREIGN:-grin_pubpoolwallet_testnet_foreign}"
    PW_TMUX_OWNER="${PW_TMUX_OWNER:-grin_pubpoolwallet_testnet_owner}"
    PW_WATCHDOG_BIN="${PW_WATCHDOG_BIN:-/usr/local/bin/grin-pubpool-wallet-watchdog-testnet}"
    PW_WATCHDOG_CRON="${PW_WATCHDOG_CRON:-/etc/cron.d/grin-pubpool-wallet-watchdog-testnet}"
    PW_WATCHDOG_STATE="${PW_WATCHDOG_STATE:-/opt/grin/pubpool/wallet-watchdog-testnet}"
    PW_WATCHDOG_LOG="${PW_WATCHDOG_LOG:-/opt/grin/logs/pubpool-wallet-watchdog-testnet.log}"
    PW_AUTOSTART_TAG="${PW_AUTOSTART_TAG:-# grin-node-toolkit: grin_pubpoolwallet_testnet_autostart}"
else
    PW_FOREIGN_PORT="${PW_FOREIGN_PORT:-3415}"
    PW_OWNER_PORT="${PW_OWNER_PORT:-3420}"
    PW_NET_FLAG=""
    _PW_NODE_NET="mainnet"
    PW_TMUX_FOREIGN="${PW_TMUX_FOREIGN:-grin_pubpoolwallet_foreign}"
    PW_TMUX_OWNER="${PW_TMUX_OWNER:-grin_pubpoolwallet_owner}"
    PW_WATCHDOG_BIN="${PW_WATCHDOG_BIN:-/usr/local/bin/grin-pubpool-wallet-watchdog}"
    PW_WATCHDOG_CRON="${PW_WATCHDOG_CRON:-/etc/cron.d/grin-pubpool-wallet-watchdog}"
    PW_WATCHDOG_STATE="${PW_WATCHDOG_STATE:-/opt/grin/pubpool/wallet-watchdog}"
    PW_WATCHDOG_LOG="${PW_WATCHDOG_LOG:-/opt/grin/logs/pubpool-wallet-watchdog.log}"
    PW_AUTOSTART_TAG="${PW_AUTOSTART_TAG:-# grin-node-toolkit: grin_pubpoolwallet_autostart}"
fi

if ! declare -F info    >/dev/null 2>&1; then info()    { echo "[INFO]  $*"; }; fi
if ! declare -F warn    >/dev/null 2>&1; then warn()    { echo "[WARN]  $*"; }; fi
if ! declare -F error   >/dev/null 2>&1; then error()   { echo "[ERROR] $*" >&2; }; fi
if ! declare -F success >/dev/null 2>&1; then success() { echo "[OK]    $*"; }; fi

# ─── Path resolvers (read live pool config when available) ──────────────────
# pool_read_conf / the POOL_* vars are defined by the parent pool script. When
# this lib is exercised standalone the env fallbacks keep the resolvers working.
pw_wallet_dir() {
    if declare -F pool_read_conf >/dev/null 2>&1; then
        pool_read_conf "grin_wallet_dir" "${POOL_WALLET_DIR:-/opt/grin/pubpoolwallet/$_PW_NET}"
    else
        echo "${POOL_WALLET_DIR:-/opt/grin/pubpoolwallet/$_PW_NET}"
    fi
}
pw_pass_file() {
    if declare -F pool_read_conf >/dev/null 2>&1; then
        pool_read_conf "wallet_pass_file" "${POOL_APP_DIR:-/opt/grin/pubpool/$_PW_NET}/.wallet_pass"
    else
        echo "${POOL_APP_DIR:-/opt/grin/pubpool/$_PW_NET}/.wallet_pass"
    fi
}
pw_bin()             { echo "$(pw_wallet_dir)/grin-wallet"; }
pw_toml()            { echo "$(pw_wallet_dir)/grin-wallet.toml"; }
pw_launcher_foreign(){ echo "$(pw_wallet_dir)/listen-foreign.sh"; }
pw_launcher_owner()  { echo "$(pw_wallet_dir)/listen-owner.sh"; }

# ─── Passphrase reader (min 3 chars, confirm; "0" cancels → rc 1) ───────────
_pw_read_new_pass() {
    local pass pass2
    while true; do
        read -rs -p "  Passphrase (min 3 chars, 0 to cancel): " pass; echo "" >&2
        [[ "$pass" == "0" ]] && return 1
        if [[ ${#pass} -lt 3 ]]; then echo "  Too short." >&2; continue; fi
        read -rs -p "  Confirm passphrase: " pass2; echo "" >&2
        if [[ "$pass" != "$pass2" ]]; then echo "  Mismatch — try again." >&2; unset pass pass2; continue; fi
        unset pass2; break
    done
    printf '%s' "$pass"
}

# ─── Verify a passphrase actually opens the wallet seed ──────────────────────
# Runs the local `address` command (no node needed) — succeeds only if the seed
# decrypts. Used before saving a passphrase, so we never hand the listeners a
# password that can't open the wallet. <dir> <bin> <pass>
_pw_verify_pass() {
    local d="$1" b="$2" p="$3" out
    out=$( cd "$d" && "$b" $PW_NET_FLAG --top_level_dir "$d" -p "$p" address 2>&1 )
    # Matches grin1… (mainnet) and tgrin1… (testnet — "tgrin1" contains "grin1").
    grep -qiE 'grin1[a-z0-9]{40,}|tor address' <<< "$out"
}

# ─── Archive an existing wallet dir aside as <dir>_ddmmyy ────────────────────
# grin-wallet refuses to `init` over an existing config dir ("Wallet
# configuration already exists"), so a fresh wallet must move the old one aside.
# Renamed, never deleted — the seed/passphrase stay recoverable. <dir>
_pw_archive_wallet_dir() {
    local d="$1" stamp archive
    stamp=$(date +%d%m%y)
    archive="${d}_${stamp}"
    [[ -e "$archive" ]] && archive="${d}_${stamp}-$(date +%H%M%S)"
    if mv "$d" "$archive"; then
        success "Old wallet archived → $archive (renamed, not deleted)."
        warn "Its seed + passphrase still live there — keep it until the new wallet is confirmed."
        return 0
    fi
    error "Could not move $d aside (→ $archive). Resolve manually and re-run."
    return 1
}

# ─── Port-collision guard ───────────────────────────────────────────────────
# 3415/3420 are grin-wallet defaults — another wallet service (05C, 051/055, a
# 052 drop) may already hold them. NEVER auto-kill another service's wallet.
# Returns 0 if free OR already held by OUR session; rc 1 if a foreign process
# holds it. <port> <our-tmux-name>
_pw_port_collision_check() {
    local port="$1" tmux_name="$2"
    gnc_get_pid_on_port "$port" >/dev/null 2>&1 || return 0   # free → OK
    if tmux has-session -t "$tmux_name" 2>/dev/null; then
        info "Port $port already served by our session '$tmux_name'."
        return 0
    fi
    error "Port $port is in use by ANOTHER process (not '$tmux_name')."
    error "  Likely 05C cmdwallet, 051/055 web wallet, or a 052 drop wallet."
    error "  Stop that service first, or move the pool wallet to a non-default"
    error "  port and update grin-wallet.toml + the backend config to match."
    return 1
}

# ─── Launchers (read pass from the saved file; kept out of the tmux cmd) ─────
pw_write_launchers() {
    local dir bin pass_file lf lo
    dir=$(pw_wallet_dir); bin=$(pw_bin); pass_file=$(pw_pass_file)
    lf=$(pw_launcher_foreign); lo=$(pw_launcher_owner)
    mkdir -p "$dir"

    cat > "$lf" <<EOF
#!/bin/bash
# GENERATED by 07_lib_pool_wallet.sh — Foreign listener (coinbase, port $PW_FOREIGN_PORT).
cd "$dir" || exit 1
_p=\$(cat "$pass_file" 2>/dev/null || echo "")
exec "$bin" $PW_NET_FLAG --top_level_dir "$dir" -p "\$_p" listen
EOF
    chmod 700 "$lf"

    cat > "$lo" <<EOF
#!/bin/bash
# GENERATED by 07_lib_pool_wallet.sh — Owner API listener (payouts, port $PW_OWNER_PORT).
cd "$dir" || exit 1
_p=\$(cat "$pass_file" 2>/dev/null || echo "")
exec "$bin" $PW_NET_FLAG --top_level_dir "$dir" -p "\$_p" owner_api
EOF
    chmod 700 "$lo"
}

# ─── Listener start / stop / status ─────────────────────────────────────────
_pw_start_one() {
    # <port> <tmux_name> <launcher> <label>
    local port="$1" tmux_name="$2" launcher="$3" label="$4"
    _pw_port_collision_check "$port" "$tmux_name" || return 1
    if tmux has-session -t "$tmux_name" 2>/dev/null; then
        info "$label listener already running (session '$tmux_name')."
        return 0
    fi
    [[ -x "$launcher" ]] || pw_write_launchers
    info "Starting pool $label listener on port $port..."
    SHELL=/bin/bash tmux new-session -d -s "$tmux_name" "$launcher" \
        || { error "Failed to start tmux session '$tmux_name'."; return 1; }
    if gnc_wait_for_port "$port" 20 2; then
        success "$label listener up on $port (session '$tmux_name')."
    else
        error "$label session started but port $port is NOT listening — wrong passphrase, port collision, or wallet busy."
        error "  Check: tmux attach -t $tmux_name"
        return 1
    fi
}

pw_listener_start() {
    [[ -f "$(pw_pass_file)" ]] || { error "No saved wallet password ($(pw_pass_file)) — run Setup wallet first."; return 1; }
    [[ -x "$(pw_bin)" ]] || { error "No grin-wallet binary at $(pw_bin) — run Setup wallet first."; return 1; }
    [[ -x "$(pw_launcher_foreign)" && -x "$(pw_launcher_owner)" ]] || pw_write_launchers

    local rc=0
    _pw_start_one "$PW_FOREIGN_PORT" "$PW_TMUX_FOREIGN" "$(pw_launcher_foreign)" "Foreign(coinbase)" || rc=1
    _pw_start_one "$PW_OWNER_PORT"   "$PW_TMUX_OWNER"   "$(pw_launcher_owner)"   "Owner(payouts)"    || rc=1
    return $rc
}

pw_listener_stop() {
    local stopped=0 t
    for t in "$PW_TMUX_FOREIGN" "$PW_TMUX_OWNER"; do
        if tmux has-session -t "$t" 2>/dev/null; then
            tmux kill-session -t "$t" 2>/dev/null || true
            success "Stopped listener (session '$t')."
            stopped=1
        fi
    done
    [[ "$stopped" -eq 1 ]] || info "No running pool wallet listener sessions."
}

pw_listener_status() {
    local rows=( "$PW_FOREIGN_PORT|$PW_TMUX_FOREIGN|Foreign(coinbase)" \
                 "$PW_OWNER_PORT|$PW_TMUX_OWNER|Owner(payouts)" )
    local row port tmux_name label up_sess up_port tag
    for row in "${rows[@]}"; do
        IFS='|' read -r port tmux_name label <<< "$row"
        up_sess="no"; up_port="no"
        tmux has-session -t "$tmux_name" 2>/dev/null && up_sess="yes"
        gnc_get_pid_on_port "$port" >/dev/null 2>&1 && up_port="yes"
        if [[ "$up_sess" == "yes" && "$up_port" == "yes" ]]; then
            tag="${GREEN:-}[RUNNING]${RESET:-}"
        else
            tag="${RED:-}[DOWN]${RESET:-}"
        fi
        printf '%s %-18s session=%s port=%s(%s)\n' "$tag" "$label" "$up_sess" "$port" "$up_port"
    done
}

pw_show_address() {
    local dir bin pf
    dir=$(pw_wallet_dir); bin=$(pw_bin); pf=$(pw_pass_file)
    [[ -x "$bin" && -f "$pf" ]] || { error "Pool wallet not set up (binary/password missing)."; return 1; }
    ( cd "$dir" && "$bin" $PW_NET_FLAG --top_level_dir "$dir" -p "$(cat "$pf")" address 2>/dev/null ) \
        | grep -oE 't?grin1[a-z0-9]{40,}' | head -1 || warn "Could not read address."
}

# ─── Patch the node's grin-server.toml wallet_listener_url → our Foreign API ─
# The node's stratum sends every block's coinbase to wallet_listener_url. For a
# pool that MUST be the pool wallet (3415), or rewards go to the wrong wallet.
pw_patch_node_toml() {
    local node_dir toml wlu="http://127.0.0.1:${PW_FOREIGN_PORT}/v2/foreign"
    node_dir=$(gnc_resolve_node_dir "$_PW_NODE_NET" 2>/dev/null || true)
    if [[ -z "$node_dir" ]]; then
        local default_toml="/opt/grin/node/${_PW_NODE_NET}-prune/grin-server.toml"
        echo -ne "Path to the node's grin-server.toml [$default_toml]: "
        read -r toml; [[ -z "$toml" ]] && toml="$default_toml"
    else
        toml="$node_dir/grin-server.toml"
    fi
    if [[ ! -f "$toml" ]]; then
        warn "grin-server.toml not found ($toml) — set wallet_listener_url = \"$wlu\" manually."
        return 1
    fi
    cp -a "$toml" "${toml}.bak.$(date +%s)" 2>/dev/null && info "Backed up $toml"
    if grep -Eq "^[[:space:]]*#?[[:space:]]*wallet_listener_url[[:space:]]*=" "$toml"; then
        sed -i -E "s|^[[:space:]]*#?[[:space:]]*wallet_listener_url[[:space:]]*=.*|wallet_listener_url = \"$wlu\"|" "$toml"
        success "Patched wallet_listener_url → $wlu in $toml"
        warn "Restart the Grin node for the coinbase change to take effect."
    else
        warn "wallet_listener_url not present in $toml — add it under [server.stratum_mining_config]:"
        warn "  wallet_listener_url = \"$wlu\""
    fi
}

# ─── Setup: install binary + init|recover + patch tomls + start listeners ───
pw_setup() {
    local dir bin toml pass_file

    if [[ "$_PW_NET" == "testnet" ]]; then
        echo -e "\n${BOLD:-}Set up pool wallet (coinbase + payouts) — TESTNET${RESET:-}\n"
        warn "TESTNET — this wallet receives test tGRIN coinbase + sends test payouts (no real value)."
        warn "Wallet runs with --testnet on ports ${PW_FOREIGN_PORT}/${PW_OWNER_PORT}; addresses are tgrin1…"
    else
        echo -e "\n${BOLD:-}Set up pool wallet (coinbase + payouts) — Mainnet${RESET:-}\n"
        warn "MAINNET — this wallet receives REAL GRIN coinbase and sends miner payouts."
    fi

    # Wallet dir is asked here, not in 2) Configure — it's a wallet concern, and
    # every other pw_* path (binary, toml, launchers) derives from it. Must be
    # answered BEFORE the resolvers below run.
    if declare -F pool_write_conf_key >/dev/null 2>&1; then
        local cur_dir new_dir
        cur_dir=$(pw_wallet_dir)
        echo -ne "Wallet dir [$cur_dir]: "
        read -r new_dir || true
        if [[ -n "$new_dir" && "$new_dir" != "$cur_dir" ]]; then
            pool_write_conf_key "grin_wallet_dir" "$new_dir"
            info "Wallet dir set to $new_dir"
        fi
    fi

    dir=$(pw_wallet_dir); bin=$(pw_bin); toml=$(pw_toml); pass_file=$(pw_pass_file)

    # 1) Decide what to do when a wallet already exists. grin-wallet refuses to
    #    `init` over an existing config dir, so a NEW / RECOVERED wallet must move
    #    the old dir aside first (archived → <dir>_ddmmyy, never deleted). We only
    #    archive AFTER a valid new passphrase is in hand (step 3a), so a cancel at
    #    the passphrase prompt never disturbs the existing wallet.
    local action="new"          # new | existing | recover
    if [[ -f "$toml" ]]; then
        warn "Wallet already initialized at $dir."
        echo -e "  What do you want to do?"
        echo -e "    1) Use the EXISTING wallet  (you remember its passphrase)"
        echo -e "    2) Create a NEW wallet      (archive old dir → ${dir}_$(date +%d%m%y), then init)"
        echo -e "    3) Recover from seed        (archive old dir, then init -hr)"
        echo -ne "  Select [1/2/3/0]: "
        local choice; read -r choice || true
        case "$choice" in
            1) action="existing" ;;
            2) action="new" ;;
            3) action="recover" ;;
            *) info "Cancelled."; return 1 ;;
        esac
    fi

    mkdir -p "$dir"

    # 3a) NEW / RECOVERED wallet — read passphrase, (archive old), install, init.
    if [[ "$action" == "new" || "$action" == "recover" ]]; then
        echo ""
        echo -e "  ${YELLOW:-}This passphrase is SAVED to disk (mode 600). Both listeners must open${RESET:-}"
        echo -e "  ${YELLOW:-}the wallet unattended, so the saved copy is what lets them auto-start${RESET:-}"
        echo -e "  ${YELLOW:-}after a reboot/crash (boot autostart + */5 watchdog).${RESET:-}"
        echo ""
        local pass; pass=$(_pw_read_new_pass) || { info "Cancelled."; return 1; }
        local init_flag="-h"; [[ "$action" == "recover" ]] && init_flag="-hr"

        # Archive the existing wallet only now — passphrase captured, so a cancel
        # above left the old wallet untouched. Confirm, then move it aside.
        if [[ -f "$toml" ]]; then
            echo ""
            warn "The existing wallet at $dir will be ARCHIVED (renamed), not deleted."
            echo -ne "  Proceed? [y/N]: "
            local cfm; read -r cfm || true
            [[ "${cfm,,}" == "y" ]] || { info "Cancelled."; unset pass; return 1; }
            _pw_archive_wallet_dir "$dir" || { unset pass; return 1; }
            mkdir -p "$dir"
        fi

        # Binary into the (now fresh) dir.
        gwi_install_grin_wallet "$dir" 0 || { error "grin-wallet install failed."; unset pass; return 1; }

        info "Running grin-wallet init ($init_flag) — follow any seed prompts..."
        # Security trade-off: -p exposes the passphrase in argv during init.
        ( cd "$dir" && "$bin" $PW_NET_FLAG --top_level_dir "$dir" -p "$pass" init $init_flag )
        local rc=$?
        if [[ $rc -ne 0 ]]; then error "grin-wallet init failed (rc=$rc)."; unset pass; return 1; fi

        # Confirm the seed decrypts with this passphrase before saving it — a
        # password the listeners can't use is worse than no password.
        if ! _pw_verify_pass "$dir" "$bin" "$pass"; then
            error "The new wallet did not open with that passphrase — aborting setup."
            unset pass; return 1
        fi

        install -m 600 /dev/null "$pass_file" 2>/dev/null || true
        printf '%s' "$pass" > "$pass_file"; chmod 600 "$pass_file"; unset pass
        if declare -F pool_write_conf_key >/dev/null 2>&1; then
            pool_write_conf_key "wallet_pass_file" "$pass_file"
        fi
        success "Passphrase saved: $pass_file (mode 600) — enables listener auto-start."

    # 3b) EXISTING wallet — prompt for the passphrase and verify it opens the
    #     wallet before saving. We refuse to continue on a wrong passphrase, so
    #     the listeners (and every later step) only ever see a working one.
    else
        # Binary (shared download/verify lib) — no-op if already present.
        gwi_install_grin_wallet "$dir" 0 || { error "grin-wallet install failed."; return 1; }

        echo ""
        info "Using the existing wallet at $dir."
        echo -e "  Enter its passphrase so both listeners can open it unattended:"
        local exist_pass
        while true; do
            read -rs -p "  Passphrase (0 to cancel): " exist_pass; echo ""
            [[ "$exist_pass" == "0" ]] && { info "Cancelled."; unset exist_pass; return 1; }
            if _pw_verify_pass "$dir" "$bin" "$exist_pass"; then break; fi
            error "That passphrase did not open the wallet — try again (0 to cancel)."
        done
        install -m 600 /dev/null "$pass_file" 2>/dev/null || true
        printf '%s' "$exist_pass" > "$pass_file"; chmod 600 "$pass_file"; unset exist_pass
        if declare -F pool_write_conf_key >/dev/null 2>&1; then
            pool_write_conf_key "wallet_pass_file" "$pass_file"
        fi
        success "Passphrase verified & saved: $pass_file (mode 600)."
    fi

    # 4) Patch grin-wallet.toml — pin the API ports + node foreign secret + log cap.
    if [[ -f "$toml" ]]; then
        _pw_set_toml_key "$toml" "api_listen_port"       "$PW_FOREIGN_PORT" && info "grin-wallet.toml api_listen_port → $PW_FOREIGN_PORT"
        _pw_set_toml_key "$toml" "owner_api_listen_port" "$PW_OWNER_PORT"   && info "grin-wallet.toml owner_api_listen_port → $PW_OWNER_PORT"
        _pw_set_toml_key "$toml" "log_max_files"         "5"

        local node_dir secret
        node_dir=$(gnc_resolve_node_dir "$_PW_NODE_NET" 2>/dev/null || true)
        if [[ -n "$node_dir" && -f "$node_dir/.foreign_api_secret" ]]; then
            secret="$node_dir/.foreign_api_secret"
            _pw_set_toml_key "$toml" "node_api_secret_path" "\"$secret\"" \
                && success "Patched node_api_secret_path → $secret" \
                || echo "node_api_secret_path = \"$secret\"" >> "$toml"
        else
            warn "Node ${_PW_NODE_NET} dir/.foreign_api_secret not found — set node_api_secret_path in"
            warn "  $toml manually if the node uses a foreign secret."
        fi
    fi

    # 5) Point the node's stratum coinbase at this wallet.
    echo ""
    pw_patch_node_toml || true

    # 6) Start both listeners. The wallet MUST be able to listen before setup is
    #    considered done — a wrong passphrase or port collision surfaces here, and
    #    the operator should NOT continue (start the service, accept miners) until
    #    both listeners are up, or coinbase + payouts silently fail.
    echo ""
    pw_write_launchers
    if ! pw_listener_start; then
        error "Pool wallet listeners are NOT both up — setup is incomplete."
        error "  Do NOT start the pool service yet. Fix the cause (passphrase, port"
        error "  collision, node) and re-run 5) Set up wallet until both show [RUNNING]."
        return 1
    fi

    # 7) Record the pool's Grin address in the pool config — the backend uses it
    #    to login to the node's built-in stratum (node-stratum-client.js). It can
    #    only be read once the wallet exists, which is why it lives here and not
    #    in 2) Configure.
    if declare -F pool_write_conf_key >/dev/null 2>&1; then
        echo ""
        local pool_addr
        # t?grin1 — keep the leading 't' on testnet addresses (tgrin1…); a bare grin1
        # pattern would let grep -o strip the 't' and save a mainnet-format address.
        pool_addr=$( (pw_show_address 2>/dev/null || true) | grep -oiE 't?grin1[a-z0-9]{40,}' | head -1 || true)
        if [[ -n "$pool_addr" ]]; then
            pool_write_conf_key "pool_address" "$pool_addr"
            success "Pool Grin address saved to config: $pool_addr"
        else
            warn "Could not auto-detect the wallet address."
            echo -ne "  Pool Grin address (blank to skip): "
            local manual_addr; read -r manual_addr || true
            if [[ -n "$manual_addr" ]]; then
                pool_write_conf_key "pool_address" "$manual_addr"
                success "Pool Grin address saved to config."
            else
                warn "pool_address not set — the backend can't login to the node stratum"
                warn "  until it is set (re-run Setup wallet, or edit the pool config)."
            fi
        fi
        if declare -F pool_service_control >/dev/null 2>&1 \
           && systemctl is-active --quiet "${POOL_SERVICE:-}" 2>/dev/null; then
            info "Restarting ${POOL_SERVICE} to apply wallet config..."
            systemctl restart "$POOL_SERVICE" || true
        fi
    fi

    echo ""
    echo -e "  ${RED:-}${BOLD:-}⚠  SECURITY — passphrase is visible in the process list${RESET:-}"
    echo -e "  ${YELLOW:-}Both listeners run 'grin-wallet -p <pass> ...', so the passphrase appears${RESET:-}"
    echo -e "  ${YELLOW:-}in 'ps aux' / /proc/<pid>/cmdline for their lifetime. Anyone with root on${RESET:-}"
    echo -e "  ${YELLOW:-}this box can read it. grin-wallet has no stdin/env passphrase input.${RESET:-}"
    echo -e "  ${YELLOW:-}→ Keep the hot balance low; sweep coinbase to a wallet on a box you control.${RESET:-}"
    echo ""
    info "Coinbase path : node stratum → wallet_listener_url http://127.0.0.1:${PW_FOREIGN_PORT}/v2/foreign"
    info "Payout path   : backend → Owner API http://127.0.0.1:${PW_OWNER_PORT}/v3/owner"
    info "Enable Auto-restart so the listeners survive reboot/crash."
}

# Replace an existing key (commented or not) in a grin-wallet.toml; rc 1 if absent.
_pw_set_toml_key() {
    local file="$1" key="$2" val="$3"
    if grep -Eq "^[[:space:]]*#?[[:space:]]*${key}[[:space:]]*=" "$file"; then
        sed -i -E "s|^[[:space:]]*#?[[:space:]]*${key}[[:space:]]*=.*|${key} = ${val}|" "$file"
        return 0
    fi
    return 1
}

# =============================================================================
# REBOOT AUTOSTART (root crontab, tag-guarded) — starts BOTH listeners at boot
# =============================================================================
pw_autostart_status() {
    local cron; cron=$(crontab -l 2>/dev/null || true)
    if echo "$cron" | grep -qF "$PW_AUTOSTART_TAG"; then
        echo -e "${GREEN:-}[OK]${RESET:-} Pool wallet listener autostart ENABLED"
    else
        echo -e "${DIM:-}[--] Pool wallet listener autostart not set${RESET:-}"
    fi
}

pw_autostart_enable() {
    local delay="${1:-45}" cron lf lo
    [[ "$delay" =~ ^[0-9]+$ ]] || delay=45
    lf=$(pw_launcher_foreign); lo=$(pw_launcher_owner)
    [[ -x "$lf" && -x "$lo" ]] || pw_write_launchers
    [[ -f "$(pw_pass_file)" ]] || { error "No saved password — run Setup wallet first."; return 1; }

    # Boot delay larger than the node's (the listeners need the node up first).
    local line="@reboot sleep $delay && env SHELL=/bin/bash bash -c 'tmux new-session -d -s $PW_TMUX_FOREIGN \"$lf\"; tmux new-session -d -s $PW_TMUX_OWNER \"$lo\"' $PW_AUTOSTART_TAG"
    cron=$(crontab -l 2>/dev/null || true)
    echo "$cron" | grep -qF "$PW_AUTOSTART_TAG" && cron=$(echo "$cron" | grep -vF "$PW_AUTOSTART_TAG" || true)
    { echo "$cron"; echo "$line"; } | grep -v '^[[:space:]]*$' | crontab -
    success "Pool wallet listener autostart enabled (delay ${delay}s)."
}

pw_autostart_disable() {
    local cron; cron=$(crontab -l 2>/dev/null || true)
    [[ -z "$cron" ]] && { info "Crontab empty."; return 0; }
    cron=$(echo "$cron" | grep -vF "$PW_AUTOSTART_TAG" || true)
    echo "$cron" | grep -v '^[[:space:]]*$' | crontab - 2>/dev/null || crontab -r 2>/dev/null || true
    success "Pool wallet listener autostart disabled."
}

# =============================================================================
# LISTENER WATCHDOG (*/5) — relaunch either listener if its port drops
# =============================================================================
_pw_write_watchdog_bin() {
    mkdir -p "$(dirname "$PW_WATCHDOG_BIN")"
    local dir lf lo
    dir=$(pw_wallet_dir); lf=$(pw_launcher_foreign); lo=$(pw_launcher_owner)
    cat > "$PW_WATCHDOG_BIN" <<EOF
#!/bin/bash
# grin-pubpool-wallet-watchdog — GENERATED by 07_lib_pool_wallet.sh. Do not edit.
STATE_DIR="$PW_WATCHDOG_STATE"
LOG_FILE="$PW_WATCHDOG_LOG"
FOREIGN_PORT="$PW_FOREIGN_PORT"
OWNER_PORT="$PW_OWNER_PORT"
TMUX_FOREIGN="$PW_TMUX_FOREIGN"
TMUX_OWNER="$PW_TMUX_OWNER"
LAUNCH_FOREIGN="$lf"
LAUNCH_OWNER="$lo"
PASS_FILE="$(pw_pass_file)"
EOF
    cat >> "$PW_WATCHDOG_BIN" <<'EOF'
set -uo pipefail
mkdir -p "$STATE_DIR" "$(dirname "$LOG_FILE")" 2>/dev/null || true
wlog() { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }

port_listening() { # <port>
    if command -v ss &>/dev/null; then
        ss -tlnp 2>/dev/null | grep -q ":$1 " && return 0
    fi
    command -v lsof &>/dev/null && lsof -tni :"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# Only manage a wallet that has been set up (launchers + saved pass present).
[[ -x "$LAUNCH_FOREIGN" && -x "$LAUNCH_OWNER" && -f "$PASS_FILE" ]] || exit 0

check_one() { # <port> <tmux_name> <launcher> <tag>
    local port="$1" tmux_name="$2" launcher="$3" tag="$4"
    port_listening "$port" && return 0
    # Cooldown: at most one relaunch per 10 min to avoid a flap loop.
    local state="$STATE_DIR/${tag}.state" now last
    now=$(date -u +%s)
    last=$(cat "$state" 2>/dev/null || echo 0)
    [[ "$last" =~ ^[0-9]+$ ]] || last=0
    if (( now - last < 600 )); then
        wlog "$tag down on $port but in cooldown — skipping."
        return 0
    fi
    wlog "$tag DOWN on $port — relaunching '$tmux_name'."
    tmux kill-session -t "$tmux_name" 2>/dev/null || true
    SHELL=/bin/bash tmux new-session -d -s "$tmux_name" "$launcher" 2>>"$LOG_FILE" \
        && wlog "$tag relaunch issued." || wlog "$tag relaunch FAILED."
    echo "$now" > "$state"
}

check_one "$FOREIGN_PORT" "$TMUX_FOREIGN" "$LAUNCH_FOREIGN" "foreign"
check_one "$OWNER_PORT"   "$TMUX_OWNER"   "$LAUNCH_OWNER"   "owner"
exit 0
EOF
    chmod 750 "$PW_WATCHDOG_BIN"
    info "Wrote pool wallet watchdog: $PW_WATCHDOG_BIN"
}

pw_watchdog_install() {
    mkdir -p "$PW_WATCHDOG_STATE" "$(dirname "$PW_WATCHDOG_LOG")" 2>/dev/null || true
    _pw_write_watchdog_bin
    cat > "$PW_WATCHDOG_CRON" <<EOF
# grin-node-toolkit: pool wallet listener watchdog (every 5 min).
SHELL=/bin/bash
*/5 * * * * root $PW_WATCHDOG_BIN >/dev/null 2>&1
EOF
    chmod 644 "$PW_WATCHDOG_CRON"
    success "Pool wallet watchdog installed (*/5) — relaunches Foreign(3415) + Owner(3420) if they drop."
}

pw_watchdog_remove() {
    rm -f "$PW_WATCHDOG_CRON" "$PW_WATCHDOG_BIN"
    success "Pool wallet watchdog removed."
}

pw_watchdog_status() {
    if [[ -f "$PW_WATCHDOG_CRON" && -x "$PW_WATCHDOG_BIN" ]]; then
        success "Pool wallet watchdog: INSTALLED ($PW_WATCHDOG_CRON)"
    else
        warn "Pool wallet watchdog: NOT installed."
    fi
    [[ -f "$PW_WATCHDOG_LOG" ]] && { info "Recent log:"; tail -n 6 "$PW_WATCHDOG_LOG" 2>/dev/null || true; }
}
