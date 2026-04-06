# 052_lib_wallet.sh — Grin Drop wallet setup + listener management
# Sourced by 052_grin_drop.sh — inherits all color/log/network variables.
# =============================================================================
#
#  Functions exported:
#    drop_setup_wallet    — step 1: download binary, init/recover, write toml
#    drop_wallet_listener — step 2: manage two tmux sessions (TOR + Owner API)
#

# ─── Public nodes ─────────────────────────────────────────────────────────────

MAINNET_NODES=(
    "api.grin.money"
    "api.grinily.com"
    "api.grinnode.org"
    "main.gri.mw"
    "grincoin.org"
)

TESTNET_NODES=(
    "testapi.grin.money"
    "testapi.grinily.com"
    "testnet.grincoin.org"
    "test.gri.mw"
)

# =============================================================================
# OPTION 1 — Setup wallet (submenu)
# =============================================================================

drop_setup_wallet() {
    while true; do
        clear
        echo -e "\n${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — 1) Setup Wallet ──${RESET}\n"

        # ── Status ────────────────────────────────────────────────────────────
        local bin_st toml_st data_st
        [[ -x "$DROP_WALLET_BIN" ]]                    && bin_st="${GREEN}installed${RESET}"  || bin_st="${DIM}not installed${RESET}"
        [[ -f "$DROP_WALLET_DIR/grin-wallet.toml" ]]   && toml_st="${GREEN}present${RESET}"   || toml_st="${DIM}absent${RESET}"
        [[ -d "$DROP_WALLET_DIR/wallet_data" ]]        && data_st="${GREEN}present${RESET}"   || data_st="${DIM}absent${RESET}"
        local cur_node="${DIM}—${RESET}"
        if [[ -f "$DROP_WALLET_DIR/grin-wallet.toml" ]]; then
            cur_node=$(grep '^check_node_api_http_addr' "$DROP_WALLET_DIR/grin-wallet.toml" \
                2>/dev/null | sed 's/.*= *"\(.*\)"/\1/' || echo "—")
        fi
        echo -e "  Binary      : $bin_st"
        echo -e "  Wallet data : $data_st     Config : $toml_st"
        echo -e "  Current node: $cur_node"
        echo ""

        echo -e "  ${GREEN}1${RESET}) Install new wallet      ${DIM}(first-time setup)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Re-install wallet       ${DIM}(clean + full reinstall)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Update binary           ${DIM}(download latest grin-wallet, keep wallet data)${RESET}"
        echo -e "  ${GREEN}4${RESET}) Switch Grin node        ${DIM}(change node without reinstalling)${RESET}"
        echo -e "  ${GREEN}5${RESET}) View / recover seed     ${DIM}(display seed phrase, optionally save)${RESET}"
        echo -e "  ${DIM}0) Back${RESET}"
        echo ""
        echo -ne "${BOLD}Select [1-5/0]: ${RESET}"
        local choice
        read -r choice || true

        case "$choice" in
            1) _drop_wallet_install_new  ;;
            2) _drop_wallet_reinstall    ;;
            3) _drop_wallet_update_bin   ;;
            4) _drop_wallet_switch_node  ;;
            5) _drop_wallet_view_seed    ;;
            0) break ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# ── Shared helpers ─────────────────────────────────────────────────────────────

_drop_ensure_system_user() {
    if ! id grin &>/dev/null; then
        info "Creating system user: grin"
        useradd --system --no-create-home --shell /bin/false grin \
            || { die "Failed to create 'grin' user — run as root."; return 1; }
        success "System user 'grin' created."
    else
        info "System user 'grin' already exists."
    fi
    mkdir -p "$DROP_WALLET_DIR"
}

_drop_kill_wallet_processes() {
    # Scan network-scoped ports and force-kill any running grin-wallet processes.
    # Populates caller's running_pids array if declared before calling.
    local wallet_ports
    if [[ "$DROP_NETWORK" == "mainnet" ]]; then
        wallet_ports=("3415" "3420")
    else
        wallet_ports=("13415" "13420")
    fi
    local _pids=()
    for port in "${wallet_ports[@]}"; do
        local pids
        pids=$(ss -tlnp 2>/dev/null | awk "/:${port} /{print}" \
            | grep -oP 'pid=\K[0-9]+' || true)
        for pid in $pids; do
            [[ -n "$pid" ]] && _pids+=("$pid (port $port)")
        done
    done
    if [[ ${#_pids[@]} -gt 0 ]]; then
        echo -e "  ${YELLOW}Running grin-wallet processes detected:${RESET}"
        for p in "${_pids[@]}"; do
            echo -e "  ${YELLOW}  ● PID $p${RESET}"
        done
        echo ""
        for p in "${_pids[@]}"; do
            local pid="${p%% *}"
            kill -9 "$pid" 2>/dev/null && info "Killed PID $pid" || true
        done
    fi
}

_drop_fix_ownership() {
    chown -R grin:grin "$DROP_WALLET_DIR" 2>/dev/null || true
    chmod 750 "$DROP_WALLET_DIR"
    chmod 600 "$DROP_WALLET_DIR/grin-wallet.toml" 2>/dev/null || true

    # Generate API secrets if missing or empty — grin-wallet fails to open with empty files
    # api_secret_path → wallet_data/.api_secret  (wallet Foreign API, matches toolkit conf)
    # owner_api_secret_path → .owner_api_secret  (wallet Owner API)
    mkdir -p "$DROP_WALLET_DIR/wallet_data"
    local secret_file
    for secret_file in "$DROP_WALLET_DIR/wallet_data/.api_secret" \
                       "$DROP_WALLET_DIR/.owner_api_secret"; do
        if [[ ! -s "$secret_file" ]]; then
            tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20 > "$secret_file"
            info "Generated API secret: $secret_file"
        fi
        chown grin:grin "$secret_file" 2>/dev/null || true
        chmod 600 "$secret_file"
    done

    success "Ownership fixed."
}

_drop_init_menu() {
    # Prompts new/recover choice and runs _drop_init_wallet. Returns 1 on cancel.
    echo -e "  ${GREEN}1${RESET}) Create new wallet"
    echo -e "  ${YELLOW}2${RESET}) Recover from seed"
    echo -e "  ${DIM}0) Cancel${RESET}"
    echo -ne "  Select [1/2/0]: "
    local init_choice
    read -r init_choice || true
    case "$init_choice" in
        1) _drop_init_wallet "new"     || return 1 ;;
        2) _drop_init_wallet "recover" || return 1 ;;
        0) info "Cancelled."; return 1 ;;
        *) warn "Invalid choice."; return 1 ;;
    esac
}

_drop_select_and_patch() {
    # Runs node selector and patches toml. Returns 1 on cancel/error.
    local chosen_node=""
    chosen_node=$(_drop_select_node) || return 1
    [[ -z "$chosen_node" ]] && { info "Node selection cancelled."; return 1; }
    info "Selected node: $chosen_node"
    _drop_write_toml "$chosen_node" || return 1
    echo "$chosen_node"
}

_drop_print_summary() {
    local chosen_node="$1"
    echo ""
    echo -e "  ${BOLD}Wallet dir  :${RESET} $DROP_WALLET_DIR"
    echo -e "  ${BOLD}Binary      :${RESET} $DROP_WALLET_BIN"
    echo -e "  ${BOLD}Config      :${RESET} $DROP_WALLET_DIR/grin-wallet.toml"
    echo -e "  ${BOLD}Node        :${RESET} $chosen_node"
    [[ -f "$DROP_PASS" ]] && echo -e "  ${BOLD}Passphrase  :${RESET} $DROP_PASS  ${DIM}(plaintext, mode 600)${RESET}"
    [[ -f "$DROP_WORD" ]] && echo -e "  ${BOLD}Seed words  :${RESET} $DROP_WORD  ${DIM}(plaintext, mode 600)${RESET}"
    echo ""
    success "Done."
    echo -e "  ${DIM}Next: run option 2) Wallet Listening to start the listener sessions.${RESET}"
}

# ── Submenu actions ────────────────────────────────────────────────────────────

_drop_wallet_install_new() {
    clear
    echo -e "\n${BOLD}${CYAN}── Install New Wallet [$DROP_NET_LABEL] ──${RESET}\n"

    # Guard: abort if wallet data already exists
    if [[ -d "$DROP_WALLET_DIR/wallet_data" ]] || [[ -f "$DROP_WALLET_DIR/grin-wallet.toml" ]]; then
        warn "Wallet already installed in $DROP_WALLET_DIR"
        echo -e "  ${YELLOW}Use option 2 (Re-install) to wipe and start over.${RESET}"
        pause; return
    fi

    echo -e "  ${BOLD}— System user${RESET}"
    _drop_ensure_system_user || { pause; return; }
    echo ""

    echo -e "  ${BOLD}— Binary${RESET}"
    _drop_download_wallet || { pause; return; }
    echo ""

    echo -e "  ${BOLD}— Wallet init${RESET}"
    _drop_init_menu || { pause; return; }
    echo ""

    echo -e "  ${BOLD}— Grin node${RESET}"
    local chosen_node
    chosen_node=$(_drop_select_and_patch) || { pause; return; }
    echo ""

    echo -e "  ${BOLD}— Ownership${RESET}"
    _drop_fix_ownership
    echo ""

    _drop_print_summary "$chosen_node"
    log "[drop_wallet_install_new] network=$DROP_NETWORK node=$chosen_node"
    drop_ensure_defaults
    pause
}

_drop_wallet_reinstall() {
    clear
    echo -e "\n${BOLD}${CYAN}── Re-install Wallet [$DROP_NET_LABEL] ──${RESET}\n"

    echo -e "  ${BOLD}— System user${RESET}"
    _drop_ensure_system_user || { pause; return; }
    echo ""

    echo -e "  ${BOLD}— Clean existing installation${RESET}"
    if [[ -d "$DROP_WALLET_DIR" ]] && [[ -n "$(ls -A "$DROP_WALLET_DIR" 2>/dev/null)" ]]; then
        warn "Existing wallet installation detected in $DROP_WALLET_DIR"
        _drop_kill_wallet_processes
        echo -e "  ${YELLOW}Make sure you have your seed phrase before continuing.${RESET}"
        echo -ne "  Clean and reinstall? [y/N]: "
        local clean_ok
        read -r clean_ok || true
        if [[ "${clean_ok,,}" != "y" ]]; then
            info "Cancelled."; pause; return
        fi
        rm -rf "$DROP_WALLET_DIR"
        mkdir -p "$DROP_WALLET_DIR"
        success "Wallet directory cleaned."
    else
        info "No existing installation found — continuing as fresh install."
    fi
    echo ""

    echo -e "  ${BOLD}— Binary${RESET}"
    _drop_download_wallet || { pause; return; }
    echo ""

    echo -e "  ${BOLD}— Wallet init${RESET}"
    _drop_init_menu || { pause; return; }
    echo ""

    echo -e "  ${BOLD}— Grin node${RESET}"
    local chosen_node
    chosen_node=$(_drop_select_and_patch) || { pause; return; }
    echo ""

    echo -e "  ${BOLD}— Ownership${RESET}"
    _drop_fix_ownership
    echo ""

    _drop_print_summary "$chosen_node"
    log "[drop_wallet_reinstall] network=$DROP_NETWORK node=$chosen_node"
    drop_ensure_defaults
    pause
}

_drop_wallet_update_bin() {
    clear
    echo -e "\n${BOLD}${CYAN}── Update Binary [$DROP_NET_LABEL] ──${RESET}\n"

    # Guard: wallet should be initialized
    if [[ ! -f "$DROP_WALLET_DIR/grin-wallet.toml" ]]; then
        warn "Wallet not initialized — run Install first."; pause; return
    fi

    # Warn if sessions are running — kill them so binary can be replaced
    local wallet_ports
    if [[ "$DROP_NETWORK" == "mainnet" ]]; then
        wallet_ports=("3415" "3420")
    else
        wallet_ports=("13415" "13420")
    fi
    local sessions_running=false
    for port in "${wallet_ports[@]}"; do
        ss -tlnp 2>/dev/null | grep -q ":${port} " && sessions_running=true && break
    done
    if $sessions_running; then
        warn "Wallet sessions are currently running."
        echo -e "  ${YELLOW}They will be stopped before the binary is replaced.${RESET}"
        echo -ne "  Continue? [y/N]: "
        local ok
        read -r ok || true
        [[ "${ok,,}" != "y" ]] && { info "Cancelled."; pause; return; }
        tmux kill-session -t "$DROP_TMUX_TOR"   2>/dev/null || true
        tmux kill-session -t "$DROP_TMUX_OWNER" 2>/dev/null || true
        _drop_kill_wallet_processes
    fi

    echo -e "  ${BOLD}— Download latest binary${RESET}"
    _drop_download_wallet || { pause; return; }
    echo ""

    # Fix binary ownership only
    chown grin:grin "$DROP_WALLET_BIN" 2>/dev/null || true
    chmod 755 "$DROP_WALLET_BIN"
    success "Binary updated. Wallet data and config untouched."
    echo -e "  ${DIM}Restart listener sessions from option 2) Wallet Listening.${RESET}"
    log "[drop_wallet_update_bin] network=$DROP_NETWORK"
    pause
}

_drop_wallet_switch_node() {
    clear
    echo -e "\n${BOLD}${CYAN}── Switch Grin Node [$DROP_NET_LABEL] ──${RESET}\n"

    if [[ ! -f "$DROP_WALLET_DIR/grin-wallet.toml" ]]; then
        warn "Wallet not initialized — run Install first."; pause; return
    fi

    local cur_node
    cur_node=$(grep '^check_node_api_http_addr' "$DROP_WALLET_DIR/grin-wallet.toml" \
        2>/dev/null | sed 's/.*= *"\(.*\)"/\1/' || echo "—")
    info "Current node: $cur_node"
    echo ""

    local chosen_node
    chosen_node=$(_drop_select_and_patch) || { pause; return; }

    echo ""
    success "Node switched to: $chosen_node"
    echo -e "  ${DIM}Restart listener sessions for the change to take effect.${RESET}"
    log "[drop_wallet_switch_node] network=$DROP_NETWORK node=$chosen_node"
    pause
}

_drop_wallet_view_seed() {
    clear
    echo -e "\n${BOLD}${CYAN}── View / Recover Seed [$DROP_NET_LABEL] ──${RESET}\n"

    if [[ ! -d "$DROP_WALLET_DIR/wallet_data" ]]; then
        warn "Wallet not initialized — run Install first."; pause; return
    fi

    # Get passphrase
    local wallet_pass=""
    if [[ -f "$DROP_PASS" ]]; then
        wallet_pass=$(cat "$DROP_PASS")
        info "Using saved passphrase from $DROP_PASS"
    else
        read -rs -p "  Wallet passphrase (blank if none): " wallet_pass; echo ""
    fi
    echo ""

    info "Retrieving seed phrase from wallet..."
    # Security trade-off: same as init — -p exposes the passphrase in `ps aux`
    # for the duration of this call. One-time, brief.
    local seed_output
    # shellcheck disable=SC2086
    seed_output=$(cd "$DROP_WALLET_DIR" && "$DROP_WALLET_BIN" \
        $DROP_NET_FLAG --top_level_dir "$DROP_WALLET_DIR" \
        -p "$wallet_pass" recover 2>&1) || true

    if [[ -z "$seed_output" ]]; then
        warn "No output from grin-wallet recover — check passphrase."; pause; return
    fi

    echo ""
    warn "Make sure you are alone. The seed phrase will be displayed below."
    read -rs -p "  Press Enter to view..."; echo ""
    echo ""
    echo "  ─── SEED PHRASE ───────────────────────────────────────────"
    echo "$seed_output"
    echo "  ───────────────────────────────────────────────────────────"
    echo ""
    warn "Write it down on paper. Do not rely solely on a digital copy."
    echo ""

    # Offer to save
    echo -ne "  Save seed words to $DROP_WORD? [y/N]: "
    local save_seed
    read -r save_seed || true
    if [[ "${save_seed,,}" == "y" ]]; then
        echo ""
        echo -e "  ${BOLD}${RED}⚠  Security warning — PLAINTEXT SEED STORAGE:${RESET}"
        echo -e "  ${YELLOW}  The seed phrase will be saved in PLAIN TEXT on this server.${RESET}"
        echo -e "  ${YELLOW}  Anyone with root access or your hosting provider can read it.${RESET}"
        echo -e "  ${YELLOW}  A compromised server means your funds are at risk.${RESET}"
        echo ""
        mkdir -p "$(dirname "$DROP_WORD")"
        echo "$seed_output" > "$DROP_WORD"
        chmod 600 "$DROP_WORD"
        chown root:root "$DROP_WORD" 2>/dev/null || true
        success "Seed saved → $DROP_WORD  ${DIM}(plaintext, mode 600, owned root)${RESET}"
    fi

    log "[drop_wallet_view_seed] network=$DROP_NETWORK"
    pause
}

_drop_download_wallet() {
    info "Querying GitHub for latest grin-wallet release..."
    local release_json
    release_json=$(curl -fsSL --max-time 30 "$GRIN_WALLET_GITHUB_API") \
        || { die "Failed to reach GitHub API."; return 1; }

    local version download_url
    version=$(echo "$release_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['tag_name'])" 2>/dev/null \
        || echo "$release_json" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')
    download_url=$(echo "$release_json" | python3 -c "
import json,sys,re
d=json.load(sys.stdin)
for a in d.get('assets',[]):
    if re.search(r'linux-x86_64\.tar\.gz$', a['name'], re.I):
        print(a['browser_download_url']); break
" 2>/dev/null)

    if [[ -z "$download_url" || "$download_url" == "null" ]]; then
        die "No linux-x86_64 tar.gz asset found in release '$version'."; return 1
    fi

    info "Version : $version"
    info "Target  : $DROP_WALLET_BIN"

    local tmp_tar="/tmp/grin_drop_wallet_$$.tar.gz"
    local tmp_dir="/tmp/grin_drop_wallet_extract_$$"
    mkdir -p "$tmp_dir" "$DROP_WALLET_DIR"

    info "Downloading..."
    wget -c --progress=bar:force -O "$tmp_tar" "$download_url" \
        || { die "Download failed."; rm -rf "$tmp_tar" "$tmp_dir"; return 1; }

    info "Extracting..."
    tar -xzf "$tmp_tar" -C "$tmp_dir" \
        || { die "Failed to extract."; rm -rf "$tmp_tar" "$tmp_dir"; return 1; }
    rm -f "$tmp_tar"

    local wallet_bin_src
    wallet_bin_src=$(find "$tmp_dir" -type f -name "grin-wallet" | head -1)
    if [[ -z "$wallet_bin_src" ]]; then
        die "Could not locate 'grin-wallet' binary in archive."; rm -rf "$tmp_dir"; return 1
    fi
    install -m 755 "$wallet_bin_src" "$DROP_WALLET_BIN"
    rm -rf "$tmp_dir"
    success "grin-wallet $version installed to $DROP_WALLET_BIN"
}

_drop_select_node() {
    local -a nodes
    local local_port
    if [[ "$DROP_NETWORK" == "mainnet" ]]; then
        nodes=("${MAINNET_NODES[@]}")
        local_port=3413
    else
        nodes=("${TESTNET_NODES[@]}")
        local_port=13413
    fi

    echo -e "\n  ${BOLD}Available Grin nodes:${RESET}" >&2
    local i=1 first_online=0
    for node in "${nodes[@]}"; do
        local status http_code
        http_code=$(curl -o /dev/null -s -w "%{http_code}" --max-time 5 "https://$node/v2/foreign" 2>/dev/null || echo "000")
        if [[ "$http_code" =~ ^(2|3)[0-9]{2}$ ]] || [[ "$http_code" == "405" ]] || [[ "$http_code" == "404" ]]; then
            status="${GREEN}● online${RESET}"
            [[ $first_online -eq 0 ]] && first_online=$i
        else
            status="${RED}○ offline${RESET}"
        fi
        echo -e "  ${GREEN}$i${RESET}) $node  $status" >&2
        ((i++))
    done

    # Local node
    local local_status local_running=false
    if ss -tlnp 2>/dev/null | grep -q ":${local_port} "; then
        local_status="${GREEN}● running${RESET}"
        local_running=true
    else
        local_status="${DIM}○ not running${RESET}"
    fi
    echo -e "  ${GREEN}$i${RESET}) Local node 127.0.0.1:${local_port}  $local_status" >&2
    echo -e "  ${DIM}0) Back${RESET}" >&2
    echo "" >&2

    # Default: local if running, else first online public node
    local default_sel=""
    if $local_running; then
        default_sel="$i"
    elif [[ $first_online -gt 0 ]]; then
        default_sel="$first_online"
    fi

    if [[ -n "$default_sel" ]]; then
        echo -ne "  Select node [1-$i/0] (default $default_sel): " >&2
    else
        echo -ne "  Select node [1-$i/0]: " >&2
    fi
    local sel
    read -r sel || true
    [[ -z "$sel" && -n "$default_sel" ]] && sel="$default_sel"
    [[ "$sel" == "0" ]] && return 1

    local chosen=""
    if [[ "$sel" =~ ^[0-9]+$ && "$sel" -le "${#nodes[@]}" && "$sel" -ge 1 ]]; then
        chosen="https://${nodes[$((sel-1))]}"
    elif [[ "$sel" == "$i" ]]; then
        chosen="http://127.0.0.1:${local_port}"
    else
        echo "Invalid selection." >&2; return 1
    fi
    echo "$chosen"
}


_drop_read_pass_new() {
    # Returns passphrase via stdout. Min 3 chars. Enter "0" to cancel (exit 1).
    # All UI goes to >&2 so stdout stays clean for $() capture.
    local pass pass2
    while true; do
        read -rs -p "  Passphrase (min 3 chars, 0 to cancel): " pass; echo "" >&2
        [[ "$pass" == "0" ]] && return 1
        if [[ ${#pass} -lt 3 ]]; then
            echo "  Passphrase must be at least 3 characters." >&2
            continue
        fi
        read -rs -p "  Confirm passphrase: " pass2; echo "" >&2
        if [[ "$pass" != "$pass2" ]]; then
            echo "  Passphrases do not match. Try again." >&2
            unset pass pass2
            continue
        fi
        unset pass2
        break
    done
    printf '%s' "$pass"
}

_drop_init_wallet() {
    local mode="$1"  # "new" or "recover"
    # Called directly (not via $()) so grin-wallet has a live TTY.
    # Overwrite guard and file cleanup are handled by drop_setup_wallet step 1.

    mkdir -p "$DROP_WALLET_DIR"

    # ── Passphrase ───────────────────────────────────────────────────────────
    local wallet_pass
    wallet_pass=$(_drop_read_pass_new) || { info "Cancelled."; return 1; }

    # ── Run grin-wallet init ─────────────────────────────────────────────────
    local init_flag="-h"
    [[ "$mode" == "recover" ]] && init_flag="-hr"

    info "Running: grin-wallet $DROP_NET_FLAG init $init_flag"
    [[ "$mode" == "new" ]] && echo -e "\n  ${YELLOW}Write down the seed phrase shown below!${RESET}\n"

    # Run directly — no pipe, full TTY for grin-wallet's seed/passphrase prompts.
    # Security trade-off: -p exposes the passphrase in the process argument list
    # (visible via `ps aux` / /proc/<pid>/cmdline) for the duration of this call.
    # grin-wallet has no stdin or env-var passphrase input — -p is the only option.
    # Exposure is brief (one-time during init) and limited to users with root/ps access.
    # shellcheck disable=SC2086
    cd "$DROP_WALLET_DIR" && "$DROP_WALLET_BIN" \
        $DROP_NET_FLAG --top_level_dir "$DROP_WALLET_DIR" \
        -p "$wallet_pass" init $init_flag
    local rc=$?
    if [[ $rc -ne 0 ]]; then
        warn "Init exited with code $rc — check output above."
        return 1
    fi

    [[ "$mode" == "new" ]] && warn "IMPORTANT: Write down the seed phrase shown above on paper."
    echo ""

    # ── Save passphrase ──────────────────────────────────────────────────────
    echo -e "  ${BOLD}${RED}⚠  Security warning:${RESET}"
    echo -e "  ${YELLOW}  Saving the passphrase allows the wallet listener to auto-start on reboot${RESET}"
    echo -e "  ${YELLOW}  and restart automatically if the wallet process crashes.${RESET}"
    echo -e "  ${YELLOW}  It is stored in PLAIN TEXT — your hosting provider and anyone${RESET}"
    echo -e "  ${YELLOW}  with root access can read it. Keep balance low.${RESET}"
    echo ""
    echo -ne "  Save passphrase for auto-start? [y/N]: "
    local save_pass
    read -r save_pass || true
    [[ "${save_pass,,}" == "y" ]] && _drop_save_pass "$wallet_pass"
    echo ""

    # ── Save seed words ──────────────────────────────────────────────────────
    echo -ne "  Save seed words to $DROP_WORD? [y/N]: "
    local save_seed
    read -r save_seed || true
    [[ "${save_seed,,}" == "y" ]] && _drop_save_seed "$wallet_pass"

    return 0
}

_drop_save_pass() {
    local wallet_pass="$1"
    mkdir -p "$(dirname "$DROP_PASS")"
    echo "$wallet_pass" > "$DROP_PASS"
    chmod 600 "$DROP_PASS"
    id grin &>/dev/null && chown grin:grin "$DROP_PASS" 2>/dev/null || true
    success "Passphrase saved to $DROP_PASS (mode 600)"
}

_drop_save_seed() {
    local wallet_pass="$1"

    echo ""
    # Security trade-off: same as init — -p exposes the passphrase in `ps aux`
    # for the duration of this call. One-time, brief.
    info "Retrieving seed phrase from wallet..."
    local seed_output
    # shellcheck disable=SC2086
    seed_output=$(cd "$DROP_WALLET_DIR" && "$DROP_WALLET_BIN" \
        $DROP_NET_FLAG --top_level_dir "$DROP_WALLET_DIR" \
        -p "$wallet_pass" recover 2>&1) || true

    echo ""
    echo -e "  ${BOLD}${RED}⚠  Security warning — PLAINTEXT SEED STORAGE:${RESET}"
    echo -e "  ${YELLOW}  The seed phrase will be saved in PLAIN TEXT on this server.${RESET}"
    echo -e "  ${YELLOW}  Anyone with root access or your hosting provider can read it.${RESET}"
    echo -e "  ${YELLOW}  A compromised server means your funds are at risk.${RESET}"
    echo -e "  ${YELLOW}  Only use this on a server you fully trust and control.${RESET}"
    echo ""
    warn "Make sure you are alone. The seed phrase will be displayed below."
    read -rs -p "  Press Enter to view and save..."; echo ""
    echo ""
    echo "  ─── SEED PHRASE ───────────────────────────────────────────"
    echo "$seed_output"
    echo "  ───────────────────────────────────────────────────────────"
    echo ""
    warn "Write it down on paper as well. Do not rely solely on this file."
    echo ""

    mkdir -p "$(dirname "$DROP_WORD")"
    echo "$seed_output" > "$DROP_WORD"
    chmod 600 "$DROP_WORD"
    chown root:root "$DROP_WORD" 2>/dev/null || true
    success "Seed words saved → $DROP_WORD  ${DIM}(plaintext, mode 600, owned root)${RESET}"
    echo ""
}

_drop_write_toml() {
    # grin-wallet init already wrote chain_type, ports, data_file_dir, log_file_path,
    # use_tor_listener, etc. based on whether --testnet was passed.
    # We only patch what init cannot know.
    local node_url="$1"
    local toml="$DROP_WALLET_DIR/grin-wallet.toml"

    if [[ ! -f "$toml" ]]; then
        warn "grin-wallet.toml not found — was init skipped?"; return 1
    fi

    # 1. Remote node address — skip if local (grin-wallet default is already 127.0.0.1)
    if [[ "$node_url" != *"127.0.0.1"* ]]; then
        _patch_toml "$toml" "check_node_api_http_addr" "\"${node_url}\""
    fi

    # 2. Local grin node API secret — only needed when connecting to a local node.
    #    grin-wallet calls the node's Foreign API (port 3413/13413) for get_version,
    #    broadcast, etc. Without the correct secret the node returns 403 →
    #    "Cannot parse response" / get_version error.
    #    Node is always installed via script 01 → secret at <node_dir>/.foreign_api_secret
    if [[ "$node_url" == *"127.0.0.1"* ]]; then
        local node_secret_path=""
        local instances_conf="/opt/grin/conf/grin_instances_location.conf"
        if [[ -f "$instances_conf" ]]; then
            # shellcheck source=/dev/null
            source "$instances_conf" 2>/dev/null || true
            local node_dir=""
            if [[ "$DROP_NETWORK" == "testnet" ]]; then
                node_dir="${PRUNETEST_GRIN_DIR:-}"
            else
                node_dir="${PRUNEMAIN_GRIN_DIR:-${FULLMAIN_GRIN_DIR:-}}"
            fi
            [[ -f "$node_dir/.foreign_api_secret" ]] && node_secret_path="$node_dir/.foreign_api_secret"
        fi

        if [[ -n "$node_secret_path" ]]; then
            _patch_toml "$toml" "node_api_secret_path" "\"$node_secret_path\""
            info "Node API secret: $node_secret_path"
        else
            warn "Node secret not found — run script 01 to build the node first."
        fi
    fi

    # 3. Wallet own API secrets (foreign + owner)
    # api_secret_path lives inside wallet_data/ — matches toolkit conf default
    _patch_toml "$toml" "api_secret_path"       "\"$DROP_WALLET_DIR/wallet_data/.api_secret\""
    _patch_toml "$toml" "owner_api_secret_path" "\"$DROP_WALLET_DIR/.owner_api_secret\""

    # 4. Limit log rotation
    _patch_toml "$toml" "log_max_files" "3"

    local node_label="$node_url"
    [[ "$node_url" == *"127.0.0.1"* ]] && node_label="local (127.0.0.1)"
    success "grin-wallet.toml patched (node=$node_label)"
}

# =============================================================================
# OPTION 2 — Wallet listener (two tmux sessions + cron + watchdog)
# =============================================================================

drop_wallet_listener() {
    while true; do
        clear
        echo -e "\n${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — 2) Wallet Listening ──${RESET}\n"

        if [[ ! -x "$DROP_WALLET_BIN" ]]; then
            warn "Wallet binary not found — run option 1 first."; pause; return
        fi
        if [[ ! -f "$DROP_WALLET_DIR/grin-wallet.toml" ]]; then
            warn "Wallet not initialized — run option 1 first."; pause; return
        fi
        if ! command -v tmux &>/dev/null; then
            info "Installing tmux..."; apt-get install -y tmux || { warn "apt-get failed."; pause; return; }
        fi

        # Status
        local tor_st owner_st
        tmux has-session -t "$DROP_TMUX_TOR" 2>/dev/null \
            && tor_st="${GREEN}● running${RESET}" || tor_st="${DIM}○ stopped${RESET}"
        tmux has-session -t "$DROP_TMUX_OWNER" 2>/dev/null \
            && owner_st="${GREEN}● running${RESET}" || owner_st="${DIM}○ stopped${RESET}"

        local tor_port owner_port
        [[ "$DROP_NETWORK" == "mainnet" ]] && { tor_port=3415; owner_port=3420; } \
                                           || { tor_port=13415; owner_port=13420; }
        local port_tor_st port_owner_st
        ss -tlnp 2>/dev/null | grep -q ":${tor_port} "   && port_tor_st="${GREEN}listening${RESET}"   || port_tor_st="${DIM}not listening${RESET}"
        ss -tlnp 2>/dev/null | grep -q ":${owner_port} " && port_owner_st="${GREEN}listening${RESET}" || port_owner_st="${DIM}not listening${RESET}"

        echo -e "  ${BOLD}TOR session${RESET}  ($DROP_TMUX_TOR)   : $tor_st   port :${tor_port} $port_tor_st"
        echo -e "  ${BOLD}Owner session${RESET}($DROP_TMUX_OWNER): $owner_st   port :${owner_port} $port_owner_st"
        echo ""

        local cron_reboot_note="${DIM}not set${RESET}"
        crontab -l 2>/dev/null | grep -q "drop-${DROP_NETWORK}" \
            && cron_reboot_note="${GREEN}enabled${RESET}"
        local watchdog_note="${DIM}not set${RESET}"
        crontab -l 2>/dev/null | grep -q "052_watchdog_${DROP_NETWORK}" \
            && watchdog_note="${GREEN}enabled${RESET}"
        echo -e "  @reboot cron : $cron_reboot_note   watchdog cron : $watchdog_note"
        echo ""

        echo -e "  ${GREEN}1${RESET}) Start both sessions"
        echo -e "  ${GREEN}2${RESET}) Stop  both sessions"
        echo -e "  ${GREEN}3${RESET}) Attach TOR session   ${DIM}($DROP_TMUX_TOR)${RESET}"
        echo -e "  ${GREEN}4${RESET}) Attach Owner session ${DIM}($DROP_TMUX_OWNER)${RESET}"
        echo -e "  ${GREEN}5${RESET}) Toggle @reboot cron  ${DIM}(auto-restart on server reboot)${RESET}"
        echo -e "  ${GREEN}6${RESET}) Toggle watchdog cron ${DIM}(check ports every 5 min)${RESET}"
        echo -e "  ${DIM}↩  Refresh status${RESET}"
        echo -e "  ${DIM}0) Back${RESET}"
        echo ""
        echo -ne "${BOLD}Select [1-6/0]: ${RESET}"
        local choice
        read -r choice || true

        case "$choice" in
            1) _drop_start_both_sessions ;;
            2) _drop_stop_both_sessions  ;;
            3) tmux attach -t "$DROP_TMUX_TOR"   2>/dev/null || warn "Session not running." ;;
            4) tmux attach -t "$DROP_TMUX_OWNER" 2>/dev/null || warn "Session not running." ;;
            5) _drop_toggle_reboot_cron  ;;
            6) _drop_toggle_watchdog_cron ;;
            0) break ;;
            "") continue ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

_drop_read_saved_pass() {
    local wallet_pass=""
    if [[ -f "$DROP_PASS" ]]; then
        wallet_pass=$(cat "$DROP_PASS")
        info "Using saved passphrase from $DROP_PASS"
    else
        read -rs -p "  Wallet passphrase (blank if none): " wallet_pass; echo ""
    fi
    echo "$wallet_pass"
}

_drop_launch_session() {
    local name="$1" cmd="$2"
    local run_user="grin"
    id grin &>/dev/null || run_user="$USER"

    if [[ "$run_user" == "grin" ]]; then
        tmux new-session -d -s "$name" -c "$DROP_WALLET_DIR" \
            "su -s /bin/bash -c \"$cmd; echo ''; echo 'Session exited. Press Enter to close.'; read\" grin"
    else
        tmux new-session -d -s "$name" -c "$DROP_WALLET_DIR" \
            "bash -c \"$cmd; echo ''; echo 'Session exited. Press Enter to close.'; read\""
    fi
}

_drop_start_both_sessions() {
    local wallet_pass
    wallet_pass=$(_drop_read_saved_pass)

    # Security trade-off: -p embeds the passphrase as a literal string in the tmux
    # command and exposes it in `ps aux` / /proc/<pid>/cmdline for the full lifetime
    # of the grin-wallet listen/owner_api process (persistent, not just during startup).
    # grin-wallet has no stdin or env-var passphrase input — -p is the only option.
    local pass_arg=""
    [[ -n "$wallet_pass" ]] && pass_arg="-p '$wallet_pass'"
    local base_cmd="'$DROP_WALLET_BIN' $DROP_NET_FLAG --top_level_dir '$DROP_WALLET_DIR' $pass_arg"

    # TOR / Foreign API session (grin-wallet listen)
    if tmux has-session -t "$DROP_TMUX_TOR" 2>/dev/null; then
        tmux kill-session -t "$DROP_TMUX_TOR" 2>/dev/null || true
    fi
    _drop_launch_session "$DROP_TMUX_TOR" "$base_cmd listen"
    sleep 1
    if tmux has-session -t "$DROP_TMUX_TOR" 2>/dev/null; then
        success "TOR/Foreign session started: $DROP_TMUX_TOR"
    else
        warn "TOR session may have exited — check wallet config."
    fi

    # Owner API session (grin-wallet owner_api)
    if tmux has-session -t "$DROP_TMUX_OWNER" 2>/dev/null; then
        tmux kill-session -t "$DROP_TMUX_OWNER" 2>/dev/null || true
    fi
    _drop_launch_session "$DROP_TMUX_OWNER" "$base_cmd owner_api"
    sleep 1
    if tmux has-session -t "$DROP_TMUX_OWNER" 2>/dev/null; then
        success "Owner API session started: $DROP_TMUX_OWNER"
    else
        warn "Owner API session may have exited — check wallet config."
    fi

    unset wallet_pass pass_arg base_cmd
    log "[drop_start_both_sessions] network=$DROP_NETWORK"
    pause
}

_drop_stop_both_sessions() {
    tmux kill-session -t "$DROP_TMUX_TOR"   2>/dev/null && success "Stopped $DROP_TMUX_TOR"   || info "Not running: $DROP_TMUX_TOR"
    tmux kill-session -t "$DROP_TMUX_OWNER" 2>/dev/null && success "Stopped $DROP_TMUX_OWNER" || info "Not running: $DROP_TMUX_OWNER"
    log "[drop_stop_both_sessions] network=$DROP_NETWORK"
    pause
}

_drop_toggle_reboot_cron() {
    local tag="# grin-drop-${DROP_NETWORK}-reboot"
    local cur_cron; cur_cron=$(crontab -l 2>/dev/null || true)

    if echo "$cur_cron" | grep -q "$tag"; then
        # Remove
        echo "$cur_cron" | grep -v "$tag" | crontab - 2>/dev/null || true
        success "@reboot cron removed for $DROP_NET_LABEL."
    else
        # Add — wrapper script reads pass from file, never appears in ps
        local wrapper="/opt/grin/drop-${DROP_NETWORK}-start.sh"
        local pass_arg=""
        [[ -f "$DROP_PASS" ]] && pass_arg="-p \"\$(cat '$DROP_PASS')\""
        cat > "$wrapper" << WRAPPER_EOF
#!/bin/bash
# Auto-generated by 052_grin_drop.sh — do not edit manually
tmux new-session -d -s "$DROP_TMUX_TOR" -c "$DROP_WALLET_DIR" \\
    "'$DROP_WALLET_BIN' $DROP_NET_FLAG --top_level_dir '$DROP_WALLET_DIR' $pass_arg listen"
sleep 3
tmux new-session -d -s "$DROP_TMUX_OWNER" -c "$DROP_WALLET_DIR" \\
    "'$DROP_WALLET_BIN' $DROP_NET_FLAG --top_level_dir '$DROP_WALLET_DIR' $pass_arg owner_api"
WRAPPER_EOF
        chmod 700 "$wrapper"
        id grin &>/dev/null && chown root:grin "$wrapper" 2>/dev/null || true

        (echo "$cur_cron"; echo "@reboot $wrapper  $tag") | crontab - 2>/dev/null || true
        success "@reboot cron enabled for $DROP_NET_LABEL. Wrapper: $wrapper"
    fi
    pause
}

_drop_toggle_watchdog_cron() {
    local tag="052_watchdog_${DROP_NETWORK}"
    local cur_cron; cur_cron=$(crontab -l 2>/dev/null || true)

    if echo "$cur_cron" | grep -q "$tag"; then
        echo "$cur_cron" | grep -v "$tag" | crontab - 2>/dev/null || true
        success "Watchdog cron removed for $DROP_NET_LABEL."
    else
        local tor_port owner_port
        [[ "$DROP_NETWORK" == "mainnet" ]] && { tor_port=3415; owner_port=3420; } \
                                           || { tor_port=13415; owner_port=13420; }
        local wrapper="/opt/grin/drop-${DROP_NETWORK}-watchdog.sh"
        local pass_arg=""
        [[ -f "$DROP_PASS" ]] && pass_arg="-p \"\$(cat '$DROP_PASS')\""
        cat > "$wrapper" << WATCHDOG_EOF
#!/bin/bash
# Watchdog — auto-generated by 052_grin_drop.sh
ss -tlnp | grep -q ":${tor_port} " || \\
    tmux new-session -d -s "$DROP_TMUX_TOR" -c "$DROP_WALLET_DIR" \\
        "'$DROP_WALLET_BIN' $DROP_NET_FLAG --top_level_dir '$DROP_WALLET_DIR' $pass_arg listen"
ss -tlnp | grep -q ":${owner_port} " || \\
    tmux new-session -d -s "$DROP_TMUX_OWNER" -c "$DROP_WALLET_DIR" \\
        "'$DROP_WALLET_BIN' $DROP_NET_FLAG --top_level_dir '$DROP_WALLET_DIR' $pass_arg owner_api"
WATCHDOG_EOF
        chmod 700 "$wrapper"
        id grin &>/dev/null && chown root:grin "$wrapper" 2>/dev/null || true

        (echo "$cur_cron"; echo "*/5 * * * * $wrapper  # $tag") | crontab - 2>/dev/null || true
        success "Watchdog cron enabled (every 5 min). Wrapper: $wrapper"
    fi
    pause
}
