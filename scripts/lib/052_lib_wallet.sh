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
# OPTION 1 — Setup wallet (5-step flow)
# =============================================================================

drop_setup_wallet() {
    clear
    echo -e "\n${BOLD}${CYAN}── Grin Drop [$DROP_NET_LABEL] — 1) Setup Wallet ──${RESET}\n"

    # ── Step 0/5 — System user ────────────────────────────────────────────────
    echo -e "  ${BOLD}Step 0/5 — System user${RESET}"
    if ! id grin &>/dev/null; then
        info "Creating system user: grin"
        useradd --system --no-create-home --shell /bin/false grin \
            || { die "Failed to create 'grin' user — run as root."; pause; return; }
        success "System user 'grin' created."
    else
        info "System user 'grin' already exists."
    fi
    mkdir -p "$DROP_WALLET_DIR" "$DROP_APP_DIR"
    chown -R grin:grin "$DROP_WALLET_DIR" 2>/dev/null || true
    chmod 750 "$DROP_WALLET_DIR"
    echo ""

    # ── Step 1/5 — Binary ─────────────────────────────────────────────────────
    echo -e "  ${BOLD}Step 1/5 — Binary${RESET}"
    if [[ -x "$DROP_WALLET_BIN" ]]; then
        local cur_ver; cur_ver=$("$DROP_WALLET_BIN" --version 2>&1 | head -1 || echo "unknown")
        info "Existing binary: $DROP_WALLET_BIN ($cur_ver)"
        echo -ne "  Re-download latest? [y/N]: "
        read -r redl || true
        if [[ "${redl,,}" != "y" ]]; then
            info "Keeping existing binary. Skipping download."
        else
            _drop_download_wallet || { pause; return; }
        fi
    else
        _drop_download_wallet || { pause; return; }
    fi
    echo ""

    # ── Step 2/5 — Select Grin node ───────────────────────────────────────────
    echo -e "  ${BOLD}Step 2/5 — Select Grin node${RESET}"
    local chosen_node=""
    chosen_node=$(_drop_select_node) || { pause; return; }
    [[ -z "$chosen_node" ]] && { info "Node selection cancelled."; pause; return; }
    info "Selected node: $chosen_node"
    echo ""

    # ── Step 3/5 — Init or recover ────────────────────────────────────────────
    echo -e "  ${BOLD}Step 3/5 — Wallet init / recovery${RESET}"
    local wallet_pass=""
    local is_new_wallet=false
    if [[ -f "$DROP_WALLET_DIR/grin-wallet.toml" ]]; then
        info "Wallet already initialized at $DROP_WALLET_DIR"
        echo -e "  ${GREEN}1${RESET}) Keep existing wallet  ${DIM}(skip init)${RESET}"
        echo -e "  ${YELLOW}2${RESET}) Recover from seed"
        echo -e "  ${RED}3${RESET}) Create NEW wallet  ${DIM}(overwrites existing data!)${RESET}"
        echo -e "  ${DIM}0) Cancel${RESET}"
        echo -ne "  Select [1/2/3/0]: "
        read -r init_choice || true
    else
        echo -e "  ${GREEN}1${RESET}) Create new wallet"
        echo -e "  ${YELLOW}2${RESET}) Recover from seed"
        echo -e "  ${DIM}0) Cancel${RESET}"
        echo -ne "  Select [1/2/0]: "
        read -r init_choice || true
        [[ "$init_choice" == "3" ]] && init_choice="1"  # remap if toml exists path
    fi

    case "$init_choice" in
        0) info "Cancelled."; return ;;
        1)
            if [[ -f "$DROP_WALLET_DIR/grin-wallet.toml" ]]; then
                info "Keeping existing wallet. Reading passphrase..."
                wallet_pass=$(_drop_read_pass_prompt) || { pause; return; }
            else
                wallet_pass=$(_drop_init_wallet "new") || { pause; return; }
                is_new_wallet=true
            fi
            ;;
        2) wallet_pass=$(_drop_init_wallet "recover") || { pause; return; } ;;
        3) wallet_pass=$(_drop_init_wallet "new")    || { pause; return; }; is_new_wallet=true ;;
        *) warn "Invalid choice."; pause; return ;;
    esac
    echo ""

    # ── Step 2b/5 — Write grin-wallet.toml ───────────────────────────────────
    echo -e "  ${BOLD}Step 2b/5 — Write grin-wallet.toml${RESET}"
    _drop_write_toml "$chosen_node"
    echo ""

    # ── Step 4/5 — Fix ownership ──────────────────────────────────────────────
    echo -e "  ${BOLD}Step 4/5 — Fix ownership${RESET}"
    chown -R grin:grin "$DROP_WALLET_DIR" 2>/dev/null || true
    chmod 750 "$DROP_WALLET_DIR"
    chmod 600 "$DROP_WALLET_DIR/grin-wallet.toml" 2>/dev/null || true
    # Secret files are created by wallet on first listen — pre-create with tight perms
    touch "$DROP_WALLET_DIR/wallet_data/.api_secret" \
          "$DROP_WALLET_DIR/.owner_api_secret" 2>/dev/null || true
    chown grin:grin "$DROP_WALLET_DIR/wallet_data/.api_secret" \
                    "$DROP_WALLET_DIR/.owner_api_secret" 2>/dev/null || true
    chmod 600 "$DROP_WALLET_DIR/wallet_data/.api_secret" \
              "$DROP_WALLET_DIR/.owner_api_secret" 2>/dev/null || true
    success "Ownership fixed."
    echo ""

    # ── Step 5/5 — Summary ────────────────────────────────────────────────────
    echo -e "  ${BOLD}Step 5/5 — Summary${RESET}"
    echo ""
    echo -e "  ${BOLD}Wallet dir  :${RESET} $DROP_WALLET_DIR"
    echo -e "  ${BOLD}Binary      :${RESET} $DROP_WALLET_BIN"
    echo -e "  ${BOLD}Config      :${RESET} $DROP_WALLET_DIR/grin-wallet.toml"
    echo -e "  ${BOLD}Node        :${RESET} $chosen_node"
    echo -e "  ${BOLD}Passphrase  :${RESET} $DROP_PASS  ${DIM}(mode 600)${RESET}"
    local _seed_f="$DROP_APP_DIR/seed-drop.txt"
    [[ -f "$_seed_f" ]] && echo -e "  ${BOLD}Seed backup :${RESET} $_seed_f  ${DIM}(encrypted)${RESET}"
    echo ""
    success "Wallet setup complete."
    echo -e "  ${DIM}Next: run option 2) Wallet Listening to start the Foreign + Owner API sessions.${RESET}"
    log "[drop_setup_wallet] network=$DROP_NETWORK chosen_node=$chosen_node"
    drop_ensure_defaults
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

_drop_read_pass_prompt() {
    if [[ -f "$DROP_PASS" ]]; then
        cat "$DROP_PASS"
        return 0
    fi
    local p
    while true; do
        read -rs -p "  Wallet passphrase (Enter to skip for no-passphrase wallet): " p; echo "" >&2
        local p2
        read -rs -p "  Confirm passphrase: " p2; echo "" >&2
        if [[ "$p" == "$p2" ]]; then break; fi
        echo "  Passphrases do not match. Try again." >&2
    done
    echo "$p"
}

_drop_init_wallet() {
    local mode="$1"  # "new" or "recover"
    local wallet_pass wallet_pass2

    while true; do
        read -rs -p "  Wallet passphrase (blank = no passphrase): " wallet_pass; echo "" >&2
        read -rs -p "  Confirm passphrase: " wallet_pass2; echo "" >&2
        if [[ "$wallet_pass" == "$wallet_pass2" ]]; then break; fi
        error "Passphrases do not match. Try again."
    done

    mkdir -p "$DROP_WALLET_DIR"
    local init_flag="-h"
    [[ "$mode" == "recover" ]] && init_flag="-hr"

    local init_log="/tmp/grin_drop_init_$$"
    info "Running: grin-wallet $DROP_NET_FLAG init $init_flag"
    echo -e "  ${YELLOW}Write down the seed phrase!${RESET}\n" >&2

    local pass_arg=""
    [[ -n "$wallet_pass" ]] && pass_arg="-p $wallet_pass"
    # shellcheck disable=SC2086
    cd "$DROP_WALLET_DIR" && "$DROP_WALLET_BIN" \
        $DROP_NET_FLAG --top_level_dir "$DROP_WALLET_DIR" \
        $pass_arg init $init_flag \
        2>&1 | tee "$init_log" >&2
    local rc=${PIPESTATUS[0]}

    if [[ $rc -ne 0 ]]; then
        warn "Init exited with code $rc — check output above."
        rm -f "$init_log"; return 1
    fi

    # Save passphrase file
    mkdir -p "$(dirname "$DROP_PASS")"
    echo "$wallet_pass" > "$DROP_PASS"
    chmod 600 "$DROP_PASS"
    id grin &>/dev/null && chown grin:grin "$DROP_PASS" 2>/dev/null || true
    success "Passphrase saved to $DROP_PASS (mode 600)"

    echo "" >&2
    echo -e "  ${BOLD}${RED}⚠ Security warning:${RESET}" >&2
    echo -e "  ${YELLOW}Passphrase is stored plain text on server.${RESET}" >&2
    echo -e "  ${YELLOW}Hosting provider + root can read it. Keep balance low.${RESET}" >&2
    echo "" >&2

    # Offer seed backup (new wallet only)
    if [[ "$mode" == "new" ]]; then
        echo -ne "  Save encrypted seed backup? [y/N]: " >&2
        read -r do_backup || true
        if [[ "${do_backup,,}" == "y" ]]; then
            _drop_backup_seed "$init_log"
        fi
    fi
    rm -f "$init_log"

    echo "$wallet_pass"
}

_drop_backup_seed() {
    local src_log="$1"
    local seed_file="$DROP_APP_DIR/seed-drop.txt"

    echo ""
    echo -e "  ${BOLD}Encrypt seed backup${RESET}"
    local seed_pass seed_pass2
    while true; do
        read -rs -p "  Seed backup password: " seed_pass; echo ""
        [[ -z "$seed_pass" ]] && warn "Password cannot be empty." && continue
        read -rs -p "  Confirm password: " seed_pass2; echo ""
        [[ "$seed_pass" == "$seed_pass2" ]] && break
        error "Passwords do not match."
    done

    # Extract seed lines (last ~6 lines containing words)
    local seed_content
    seed_content=$(tail -10 "$src_log" | grep -v "^\s*$" || true)

    local tmp_plain="/tmp/grin_seed_plain_$$"
    echo "$seed_content" > "$tmp_plain"
    openssl enc -aes-256-cbc -pbkdf2 -iter 600000 \
        -pass "pass:${seed_pass}" \
        -in  "$tmp_plain" \
        -out "$seed_file" 2>/dev/null \
        || { warn "openssl encryption failed — seed not saved."; rm -f "$tmp_plain"; return; }
    rm -f "$tmp_plain"
    unset seed_pass seed_pass2

    chmod 600 "$seed_file"
    chown root:root "$seed_file" 2>/dev/null || true
    success "Encrypted seed backup → $seed_file (mode 600, owned root)"
    echo ""
    echo -e "  ${DIM}Decrypt: openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in seed-drop.txt${RESET}"
}

_drop_write_toml() {
    local node_url="$1"
    local toml="$DROP_WALLET_DIR/grin-wallet.toml"

    # Ports
    local foreign_port owner_port chain_type
    if [[ "$DROP_NETWORK" == "mainnet" ]]; then
        foreign_port=3415; owner_port=3420; chain_type="Mainnet"
    else
        foreign_port=13415; owner_port=13420; chain_type="Testnet"
    fi

    # Node API secret (from script 01 if available)
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

    # Patch if toml already exists, otherwise just patch key sections
    if [[ -f "$toml" ]]; then
        _patch_toml "$toml" "api_listen_addr"        "\"0.0.0.0:${foreign_port}\""
        _patch_toml "$toml" "api_listen_port"        "$foreign_port"
        _patch_toml "$toml" "owner_api_listen_port"  "$owner_port"
        _patch_toml "$toml" "owner_api_include_foreign" "false"
        _patch_toml "$toml" "check_node_api_http_addr" "\"${node_url}\""
        _patch_toml "$toml" "data_file_dir"          "\"${DROP_WALLET_DIR}/wallet_data/\""
        _patch_toml "$toml" "log_file_path"          "\"${DROP_WALLET_DIR}/grin-wallet.log\""
        _patch_toml "$toml" "use_tor_listener"       "false"
        _patch_toml "$toml" "chain_type"             "\"$chain_type\""
        [[ -n "$node_secret_path" ]] && \
            _patch_toml "$toml" "node_api_secret_path" "\"$node_secret_path\""
    else
        # Write minimal toml from scratch
        mkdir -p "$DROP_WALLET_DIR/wallet_data"
        cat > "$toml" << TOML_EOF
[wallet]
chain_type = "$chain_type"
api_listen_port = $foreign_port
api_listen_addr = "0.0.0.0:${foreign_port}"
owner_api_listen_port = $owner_port
owner_api_include_foreign = false
check_node_api_http_addr = "${node_url}"
data_file_dir = "${DROP_WALLET_DIR}/wallet_data/"
log_file_path = "${DROP_WALLET_DIR}/grin-wallet.log"
use_tor_listener = false
$([ -n "$node_secret_path" ] && echo "node_api_secret_path = \"$node_secret_path\"")
TOML_EOF
    fi

    success "grin-wallet.toml written (chain_type=$chain_type, foreign=$foreign_port, owner=$owner_port)"
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
