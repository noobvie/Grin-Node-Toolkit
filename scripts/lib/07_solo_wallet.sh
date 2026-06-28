# =============================================================================
# lib/07_solo_wallet.sh — Central wallet for solo mining (Option C)
# =============================================================================
# Lets the operator run the whole flow inside Script 07: init/recover the
# coinbase ("central") wallet, start its Foreign listener (3415/13415 — exactly
# where grin-server.toml's wallet_listener_url points by default), and keep it
# alive across reboots and crashes. This lib holds the shared listener/cron/
# watchdog logic so the USER never leaves Script 07 but the code is not a paste
# of Script 05/052.
#
#   sw_setup <network>              download + init|recover + save pass + patch
#                                   toml + start listener
#   sw_listener_start  <network>    (re)start Foreign listen in tmux
#   sw_listener_stop   <network>
#   sw_listener_status <network>
#   sw_show_address    <network>
#   sw_autostart_enable  <network> [delay]   tag-guarded @reboot listener start
#   sw_autostart_disable <network|all>
#   sw_autostart_status
#   sw_watchdog_install / sw_watchdog_remove / sw_watchdog_status
#
# Coinbase is funded via the wallet FOREIGN API (build_coinbase), which needs
# the wallet OPEN at listener start → the passphrase must be available
# unattended. Saved pass file is chmod 600. Trade-off: -p exposes the passphrase
# in `ps aux` / /proc/<pid>/cmdline for the listener's lifetime (grin-wallet has
# no stdin/env-var passphrase input). The launcher reads the pass from the saved
# file so it is at least not in the tmux command string.
#
# Convention: sourced lib → NO shebang / NO `set -e`.
# =============================================================================

[[ -n "${_GRIN_SOLO_WALLET_SH_LOADED:-}" ]] && return 0
_GRIN_SOLO_WALLET_SH_LOADED=1

_SW_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=grin_wallet_install.sh
source "$_SW_LIB_DIR/grin_wallet_install.sh"
# shellcheck source=grin_node_control.sh
source "$_SW_LIB_DIR/grin_node_control.sh"

# ─── Paths / constants (env-overridable for testing) ────────────────────────
SW_BASE="${SW_BASE:-/opt/grin/solowallet}"
SW_WATCHDOG_BIN="${SW_WATCHDOG_BIN:-/usr/local/bin/grin-wallet-listener-watchdog}"
SW_WATCHDOG_CRON="${SW_WATCHDOG_CRON:-/etc/cron.d/grin-wallet-listener-watchdog}"
SW_STATE_DIR="${SW_STATE_DIR:-/opt/grin/solo-stats}"
SW_WATCHDOG_LOG="${SW_WATCHDOG_LOG:-/opt/grin/logs/wallet-watchdog.log}"

if ! declare -F info    >/dev/null 2>&1; then info()    { echo "[INFO]  $*"; }; fi
if ! declare -F warn    >/dev/null 2>&1; then warn()    { echo "[WARN]  $*"; }; fi
if ! declare -F error   >/dev/null 2>&1; then error()   { echo "[ERROR] $*" >&2; }; fi
if ! declare -F success >/dev/null 2>&1; then success() { echo "[OK]    $*"; }; fi

# ─── Per-network resolvers ──────────────────────────────────────────────────
sw_foreign_port() { [[ "${1:-}" == "testnet" ]] && echo 13415 || echo 3415; }
sw_net_flag()     { [[ "${1:-}" == "testnet" ]] && echo "--testnet" || echo ""; }
sw_dir()          { echo "$SW_BASE/${1:-mainnet}"; }
sw_pass_file()    { echo "$(sw_dir "$1")/.passphrase"; }
sw_toml()         { echo "$(sw_dir "$1")/grin-wallet.toml"; }
sw_launcher()     { echo "$(sw_dir "$1")/listen.sh"; }
sw_wallet_bin()   { echo "$(sw_dir "$1")/grin-wallet"; }
sw_tmux_name()    { echo "grin_solowallet_${1:-mainnet}"; }
sw_autostart_tag(){ echo "# grin-node-toolkit: grin_solowallet_autostart_${1:-mainnet}"; }

# ─── Pass-file migration (old `<net>_pass.txt` → hidden `.passphrase`) ───────
# Earlier builds saved the passphrase as `<net>_pass.txt`. Rename any leftover
# to the current hidden dotfile name so already-deployed wallets keep working
# after an upgrade. Idempotent; only moves when the new file is absent.
_sw_migrate_pass_file() {
    local net="${1:-mainnet}" old new; new=$(sw_pass_file "$net")
    old="$(sw_dir "$net")/${net}_pass.txt"
    [[ -f "$old" && ! -f "$new" ]] || return 0
    mv "$old" "$new" 2>/dev/null && chmod 600 "$new" 2>/dev/null || true
}

# ─── Passphrase reader (min 3 chars, confirm; "0" cancels → rc 1) ───────────
_sw_read_new_pass() {
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

# ─── Port-collision guard ───────────────────────────────────────────────────
# Foreign 3415/13415 are grin-wallet defaults — 05C cmdwallet, 051/055 web
# wallets may already hold them. NEVER auto-kill another service's wallet.
# Returns 0 if free OR already held by OUR session; rc 1 (abort) if a foreign
# process holds it.
sw_port_collision_check() {
    local net="${1:-mainnet}" port; port=$(sw_foreign_port "$net")
    local tmux_name; tmux_name=$(sw_tmux_name "$net")

    gnc_get_pid_on_port "$port" >/dev/null 2>&1 || return 0   # free → OK

    if tmux has-session -t "$tmux_name" 2>/dev/null; then
        info "Foreign port $port already served by our session '$tmux_name'."
        return 0
    fi
    error "Port $port is in use by ANOTHER process (not '$tmux_name')."
    error "  Likely 05C cmdwallet, 051/055 web wallet, or a manual listener."
    error "  Stop that service first, or run the solo wallet on a non-default port"
    error "  and update wallet_listener_url in grin-server.toml to match."
    return 1
}

# ─── Launcher (reads pass from the saved file; kept out of tmux cmd string) ──
sw_write_launcher() {
    local net="${1:-mainnet}" dir bin flag pass_file launcher
    dir=$(sw_dir "$net"); bin=$(sw_wallet_bin "$net"); flag=$(sw_net_flag "$net")
    pass_file=$(sw_pass_file "$net"); launcher=$(sw_launcher "$net")
    mkdir -p "$dir"
    cat > "$launcher" <<EOF
#!/bin/bash
# GENERATED by 07_solo_wallet.sh — starts the coinbase Foreign listener.
cd "$dir" || exit 1
_p=\$(cat "$pass_file" 2>/dev/null || echo "")
exec "$bin" $flag -p "\$_p" listen
EOF
    chmod 700 "$launcher"
}

# ─── Listener start / stop / status ─────────────────────────────────────────
sw_listener_start() {
    local net="${1:-mainnet}" port tmux_name launcher
    port=$(sw_foreign_port "$net"); tmux_name=$(sw_tmux_name "$net"); launcher=$(sw_launcher "$net")

    _sw_migrate_pass_file "$net"
    [[ -f "$(sw_pass_file "$net")" ]] || { error "No saved passphrase for $net (run Setup first)."; return 1; }
    [[ -x "$(sw_wallet_bin "$net")" ]] || { error "No grin-wallet binary for $net (run Setup first)."; return 1; }
    sw_port_collision_check "$net" || return 1

    if tmux has-session -t "$tmux_name" 2>/dev/null; then
        info "Listener already running (session '$tmux_name')."
        return 0
    fi
    [[ -x "$launcher" ]] || sw_write_launcher "$net"

    info "Starting $net coinbase listener on Foreign port $port..."
    SHELL=/bin/bash tmux new-session -d -s "$tmux_name" "$launcher" \
        || { error "Failed to start tmux session '$tmux_name'."; return 1; }

    if gnc_wait_for_port "$port" 20 2; then
        success "Listener up on $port (session '$tmux_name'). Attach: tmux attach -t $tmux_name"
    else
        warn "Session started but port $port not listening yet. Check: tmux attach -t $tmux_name"
    fi
}

sw_listener_stop() {
    local net="${1:-mainnet}" tmux_name; tmux_name=$(sw_tmux_name "$net")
    if tmux has-session -t "$tmux_name" 2>/dev/null; then
        tmux kill-session -t "$tmux_name" 2>/dev/null || true
        success "Stopped $net listener (session '$tmux_name')."
    else
        info "No running $net listener session."
    fi
}

sw_listener_status() {
    local net="${1:-mainnet}" port tmux_name; port=$(sw_foreign_port "$net"); tmux_name=$(sw_tmux_name "$net")
    local up_sess="no" up_port="no" tag
    tmux has-session -t "$tmux_name" 2>/dev/null && up_sess="yes"
    gnc_get_pid_on_port "$port" >/dev/null 2>&1 && up_port="yes"
    if [[ "$up_sess" == "yes" && "$up_port" == "yes" ]]; then
        tag="${GREEN:-}[RUNNING]${RESET:-}"
    else
        tag="${RED:-}[DOWN]${RESET:-}"
    fi
    printf '%s %s: session=%s port=%s(%s)\n' "$tag" "$net" "$up_sess" "$port" "$up_port"
}

sw_show_address() {
    local net="${1:-mainnet}" dir bin flag pf
    dir=$(sw_dir "$net"); bin=$(sw_wallet_bin "$net"); flag=$(sw_net_flag "$net"); pf=$(sw_pass_file "$net")
    [[ -x "$bin" && -f "$pf" ]] || { error "Wallet/pass for $net not set up."; return 1; }
    ( cd "$dir" && "$bin" $flag -p "$(cat "$pf")" address 2>/dev/null ) || warn "Could not read address."
}

# ─── Setup: download + init|recover + save pass + patch toml + start ────────
sw_setup() {
    local net="${1:-mainnet}" dir flag bin toml pass_file
    dir=$(sw_dir "$net"); flag=$(sw_net_flag "$net"); bin=$(sw_wallet_bin "$net")
    toml=$(sw_toml "$net"); pass_file=$(sw_pass_file "$net")

    [[ "$net" == "mainnet" ]] && warn "MAINNET — this wallet receives REAL GRIN coinbase."
    mkdir -p "$dir"
    _sw_migrate_pass_file "$net"

    # 1) Binary (shared download/verify lib)
    gwi_install_grin_wallet "$dir" 0 || { error "grin-wallet install failed."; return 1; }

    # 2) init -h  OR  recover (init -hr from seed)
    if [[ -f "$toml" ]]; then
        warn "Wallet already initialized at $dir."
        echo -ne "  Re-initialize? ${RED:-}(overwrites!)${RESET:-} [y/N]: "
        local re; read -r re || true
        [[ "${re,,}" == "y" ]] || { info "Keeping existing wallet."; }
    fi

    if [[ ! -f "$toml" || "${re:-}" == "y" || "${re:-}" == "Y" ]]; then
        echo -e "  Setup mode:  1) New wallet (init)   2) Recover from seed (init -hr)"
        echo -ne "  Select [1/2/0]: "
        local mode; read -r mode || true
        [[ "$mode" == "0" ]] && { info "Cancelled."; return 1; }

        echo ""
        echo -e "  ${YELLOW:-}Note: this passphrase will be SAVED to disk (mode 600) after init.${RESET:-}"
        echo -e "  ${YELLOW:-}The coinbase listener must open the wallet unattended, so the saved${RESET:-}"
        echo -e "  ${YELLOW:-}copy is what lets it auto-start again after a reboot or crash${RESET:-}"
        echo -e "  ${YELLOW:-}(boot autostart + */5 watchdog). It is never sent over the network.${RESET:-}"
        echo ""
        local pass; pass=$(_sw_read_new_pass) || { info "Cancelled."; return 1; }
        local init_flag="-h"; [[ "$mode" == "2" ]] && init_flag="-hr"

        info "Running grin-wallet init ($init_flag) — follow any seed prompts..."
        # Security trade-off: -p exposes the passphrase in argv during init.
        ( cd "$dir" && "$bin" $flag -p "$pass" init $init_flag )
        local rc=$?
        if [[ $rc -ne 0 ]]; then error "grin-wallet init failed (rc=$rc)."; unset pass; return 1; fi

        # 3) Save passphrase (required for unattended listen + reboot/watchdog).
        echo "$pass" > "$pass_file"; chmod 600 "$pass_file"; unset pass
        success "Passphrase saved: $pass_file (mode 600) — enables listener auto-start on reboot/crash."
    fi

    # 4) Patch grin-wallet.toml: node_api_secret_path → node's .foreign_api_secret
    local node_dir secret
    node_dir=$(gnc_resolve_node_dir "$net" 2>/dev/null || true)
    if [[ -n "$node_dir" && -f "$node_dir/.foreign_api_secret" ]]; then
        secret="$node_dir/.foreign_api_secret"
        if [[ -f "$toml" ]]; then
            if grep -qE '^[#[:space:]]*node_api_secret_path[[:space:]]*=' "$toml"; then
                sed -i -E "s|^[#[:space:]]*node_api_secret_path[[:space:]]*=.*|node_api_secret_path = \"$secret\"|" "$toml"
            else
                echo "node_api_secret_path = \"$secret\"" >> "$toml"
            fi
            success "Patched node_api_secret_path → $secret"
        fi
        # Enable box-wide secret self-heal so node_api_secret_path is
        # auto-refreshed after a future node rebuild (idempotent; needs root).
        declare -F grin_install_secret_sync >/dev/null 2>&1 && { grin_install_secret_sync || true; }
    else
        warn "Node ($net) not in instances conf or .foreign_api_secret missing —"
        warn "  set node_api_secret_path in $toml manually if the node uses a foreign secret."
    fi

    # 5) Patch grin-wallet.toml: log_max_files → 5. The grin-wallet default keeps 32
    #    rotated log files; a solo coinbase listener runs 24/7 and never needs that
    #    depth, so trim to 5 to bound disk use. Force the value regardless of what is
    #    there now (.* after =). Replace-in-place ONLY — grin-wallet init always writes
    #    log_max_files under [logging], so appending (which would land the key in the
    #    wrong TOML section) is never needed; if it's somehow absent we leave it alone.
    if [[ -f "$toml" ]] && grep -qE '^[#[:space:]]*log_max_files[[:space:]]*=' "$toml"; then
        sed -i -E "s|^[#[:space:]]*log_max_files[[:space:]]*=.*|log_max_files = 5|" "$toml"
        success "Patched log_max_files → 5"
    fi

    # 6) Write launcher + start listener
    sw_write_launcher "$net"
    sw_listener_start "$net"

    echo ""
    echo -e "  ${RED:-}${BOLD:-}⚠  SECURITY — passphrase is visible in the process list${RESET:-}"
    echo -e "  ${YELLOW:-}The coinbase listener runs 'grin-wallet -p <pass> listen', so the${RESET:-}"
    echo -e "  ${YELLOW:-}passphrase appears in 'ps aux' / /proc/<pid>/cmdline for the listener's${RESET:-}"
    echo -e "  ${YELLOW:-}whole lifetime. Anyone with root on this server — including your hosting${RESET:-}"
    echo -e "  ${YELLOW:-}provider, or an attacker who breaks in — can read it. grin-wallet has no${RESET:-}"
    echo -e "  ${YELLOW:-}stdin/env-var passphrase input, so this exposure is unavoidable here.${RESET:-}"
    echo -e "  ${YELLOW:-}→ If you don't fully trust this provider, keep the balance low and sweep${RESET:-}"
    echo -e "  ${YELLOW:-}  coinbase rewards to a wallet on a private machine you control.${RESET:-}"
    echo ""
    info "wallet_listener_url default ($net): http://127.0.0.1:$(sw_foreign_port "$net")/v2/foreign"
    info "Enable auto-restart (Setup → Auto-restart) so the listener survives reboot/crash."
}

# =============================================================================
# REBOOT AUTOSTART (root crontab, tag-guarded) — starts the LISTENER at boot
# =============================================================================
sw_autostart_status() {
    # One line, [OK]/[--] per net — matches gnk_autostart_status for a consistent look.
    local cron net tag label out=""; cron=$(crontab -l 2>/dev/null || true)
    for net in mainnet testnet; do
        tag=$(sw_autostart_tag "$net")
        label="Mainnet"; [[ "$net" == "testnet" ]] && label="Testnet"
        if echo "$cron" | grep -qF "$tag"; then
            out+="${GREEN:-}[OK]${RESET:-} ${label}    "
        else
            out+="${DIM:-}[--] ${label}${RESET:-}    "
        fi
    done
    echo -e "${out%    }"
}

sw_autostart_enable() {
    local net="${1:-mainnet}" delay="${2:-40}" tag launcher cron line tmux_name
    [[ "$delay" =~ ^[0-9]+$ ]] || delay=40
    launcher=$(sw_launcher "$net"); tmux_name=$(sw_tmux_name "$net"); tag=$(sw_autostart_tag "$net")
    [[ -x "$launcher" ]] || sw_write_launcher "$net"
    [[ -f "$(sw_pass_file "$net")" ]] || { error "No saved passphrase for $net — run Setup first."; return 1; }

    # Boot delay larger than the node's (wallet listener needs the node first).
    line="@reboot sleep $delay && env SHELL=/bin/bash tmux new-session -d -s $tmux_name '$launcher' $tag"
    cron=$(crontab -l 2>/dev/null || true)
    echo "$cron" | grep -qF "$tag" && cron=$(echo "$cron" | grep -vF "$tag" || true)
    { echo "$cron"; echo "$line"; } | grep -v '^[[:space:]]*$' | crontab -
    success "$net wallet-listener autostart enabled (delay ${delay}s)."
}

sw_autostart_disable() {
    local scope="${1:-all}" cron net tag; cron=$(crontab -l 2>/dev/null || true)
    [[ -z "$cron" ]] && { info "Crontab empty."; return 0; }
    local nets=(); case "$scope" in mainnet) nets=(mainnet);; testnet) nets=(testnet);; *) nets=(mainnet testnet);; esac
    for net in "${nets[@]}"; do tag=$(sw_autostart_tag "$net"); cron=$(echo "$cron" | grep -vF "$tag" || true); done
    echo "$cron" | grep -v '^[[:space:]]*$' | crontab - 2>/dev/null || crontab -r 2>/dev/null || true
    success "Wallet-listener autostart disabled for: ${nets[*]}"
}

# =============================================================================
# LISTENER WATCHDOG (*/5) — relaunch the Foreign listener if its port drops
# =============================================================================
_sw_write_watchdog_bin() {
    mkdir -p "$(dirname "$SW_WATCHDOG_BIN")"
    cat > "$SW_WATCHDOG_BIN" <<EOF
#!/bin/bash
# grin-wallet-listener-watchdog — GENERATED by 07_solo_wallet.sh. Do not edit.
SW_BASE="$SW_BASE"
STATE_DIR="$SW_STATE_DIR"
LOG_FILE="$SW_WATCHDOG_LOG"
EOF
    cat >> "$SW_WATCHDOG_BIN" <<'EOF'
set -uo pipefail
mkdir -p "$STATE_DIR" "$(dirname "$LOG_FILE")" 2>/dev/null || true
wlog() { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }

port_listening() { # <port>
    if command -v ss &>/dev/null; then
        ss -tlnp 2>/dev/null | grep -q ":$1 " && return 0
    fi
    command -v lsof &>/dev/null && lsof -tni :"$1" -sTCP:LISTEN >/dev/null 2>&1
}

for net in mainnet testnet; do
    [[ "$net" == "testnet" ]] && port=13415 || port=3415
    dir="$SW_BASE/$net"
    launcher="$dir/listen.sh"
    pass_file="$dir/.passphrase"
    # Legacy fallback: pre-rename builds saved the pass as `<net>_pass.txt`.
    [[ -f "$pass_file" ]] || pass_file="$dir/${net}_pass.txt"
    tmux_name="grin_solowallet_$net"
    # Only manage a net that has been set up (launcher + saved pass present).
    [[ -x "$launcher" && -f "$pass_file" ]] || continue
    if port_listening "$port"; then
        continue
    fi
    # Cooldown: at most one relaunch per 10 min to avoid a flap loop.
    state="$STATE_DIR/wallet_watchdog_$net.state"
    now=$(date -u +%s)
    last=$(cat "$state" 2>/dev/null || echo 0)
    [[ "$last" =~ ^[0-9]+$ ]] || last=0
    if (( now - last < 600 )); then
        wlog "$net listener down on $port but in cooldown — skipping."
        continue
    fi
    wlog "$net listener DOWN on $port — relaunching '$tmux_name'."
    tmux kill-session -t "$tmux_name" 2>/dev/null || true
    SHELL=/bin/bash tmux new-session -d -s "$tmux_name" "$launcher" 2>>"$LOG_FILE" \
        && wlog "$net relaunch issued." || wlog "$net relaunch FAILED."
    echo "$now" > "$state"
done
exit 0
EOF
    chmod 750 "$SW_WATCHDOG_BIN"
    info "Wrote wallet watchdog: $SW_WATCHDOG_BIN"
}

sw_watchdog_install() {
    mkdir -p "$SW_STATE_DIR" "$(dirname "$SW_WATCHDOG_LOG")" 2>/dev/null || true
    _sw_write_watchdog_bin
    cat > "$SW_WATCHDOG_CRON" <<EOF
# grin-node-toolkit: wallet-listener watchdog (every 5 min).
SHELL=/bin/bash
*/5 * * * * root $SW_WATCHDOG_BIN >/dev/null 2>&1
EOF
    chmod 644 "$SW_WATCHDOG_CRON"
    success "Wallet-listener watchdog installed (*/5). Manages any net with a saved pass + launcher."
}

sw_watchdog_remove() {
    rm -f "$SW_WATCHDOG_CRON" "$SW_WATCHDOG_BIN"
    success "Wallet-listener watchdog removed."
}

sw_watchdog_status() {
    if [[ -f "$SW_WATCHDOG_CRON" && -x "$SW_WATCHDOG_BIN" ]]; then
        success "Wallet-listener watchdog: INSTALLED ($SW_WATCHDOG_CRON)"
    else
        warn "Wallet-listener watchdog: NOT installed."
    fi
    [[ -f "$SW_WATCHDOG_LOG" ]] && { info "Recent log:"; tail -n 6 "$SW_WATCHDOG_LOG" 2>/dev/null || true; }
}
