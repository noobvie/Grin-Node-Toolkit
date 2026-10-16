# =============================================================================
# lib/01_lib_wizard.sh — Per-node install wizard for Script 01: preflight checks, network and mode selection, setup_one_node.
# =============================================================================
# Sourced by 01_build_new_grin_node.sh; shares its globals and log/info/warn/error helpers.
# Trap: runs with errexit off (the caller guards every call with `|| true`), so guard each file op with `|| { error ...; return 1; }`.

# =============================================================================
# [1b] LEGACY $HOME/.grin DIRECTORY CHECK
# -----------------------------------------------------------------------------
# Detects the non-standard $HOME/.grin path that older grin/grin-wallet versions
# created by default. Runs before an install (menu key 5) and Super Auto.
# Offers D) delete, Enter to keep, 0 to leave the script.
# =============================================================================
check_legacy_grin_dir() {
    [[ ! -d "$HOME/.grin" ]] && return 0

    echo ""
    warn "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    warn "  Legacy Grin directory detected: $HOME/.grin"
    warn "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo -e "  This is a non-standard path that can conflict with the new"
    echo -e "  standardized installation under ${BOLD}/opt/grin/${RESET}."
    local _legacy_size
    _legacy_size=$(du -sh "$HOME/.grin" 2>/dev/null | cut -f1) || _legacy_size="?"
    echo -e "  Size: ${YELLOW}${_legacy_size}${RESET}"
    echo ""
    echo -e "  ${RED}D${RESET}) Delete ${BOLD}$HOME/.grin${RESET}  ${DIM}(recommended)${RESET}"
    echo -e "  ${DIM}Enter${RESET}) Keep it and continue  ${DIM}(may cause config conflicts)${RESET}"
    echo -e "  ${DIM}0${RESET}) Return to master script"
    echo ""
    echo -ne "${BOLD}Choice [D/Enter/0]: ${RESET}"
    local _legacy_choice
    read -r _legacy_choice || true
    case "${_legacy_choice,,}" in
        d)
            rm -rf "$HOME/.grin"
            success "Deleted: $HOME/.grin"
            ;;
        0)
            exit 0
            ;;
        *)
            warn "Keeping $HOME/.grin — this may cause config conflicts."
            ;;
    esac
    echo ""
}

# =============================================================================
# [2] INSTALL DEPENDENCIES
# -----------------------------------------------------------------------------
# Runs apt-get update && upgrade (or dnf update) to ensure the system is
# current, then installs any missing required packages:
# apt-get: tar, openssl, libncurses5 (or libncurses6 on Ubuntu 24.04+),
#          tmux, jq, tor, curl, wget, sqlite3, rsync, cron.
# dnf (Rocky/Alma 10+): epel-release (auto), tar, openssl, ncurses-compat-libs,
#          tmux, jq, tor, curl, wget, sqlite, rsync, cronie.
# OS version check is handled upstream by the master script.
# =============================================================================
check_os_and_deps() {
    step_header "Step 2: System Update & Dependency Check"

    [[ $EUID -ne 0 ]] && die "This script must be run as root (sudo)."

    # ── System update ─────────────────────────────────────────────────────────
    info "Updating system packages..."
    if command -v dnf &>/dev/null; then
        dnf update -y || warn "dnf update encountered errors — continuing."
    else
        apt-get update \
            && apt-get upgrade -y \
            || warn "apt update/upgrade encountered errors — continuing."
    fi
    success "System up to date."
    echo ""

    local os_id
    os_id="$(grep '^ID=' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"' || true)"

    if [[ "$os_id" == "rocky" || "$os_id" == "almalinux" ]]; then
        # Rocky Linux / AlmaLinux 10+ — use dnf
        # ncurses-compat-libs fixes "no version information available" warnings
        # from the Grin binary at runtime. tar and tmux are not installed by default.
        # tor is only available via EPEL — install epel-release first if missing.
        if ! rpm -q epel-release &>/dev/null 2>&1; then
            info "Installing EPEL repository (required for tor)..."
            dnf install -y -q epel-release \
                || die "Failed to install epel-release. Check internet connection."
        fi

        # sqlite (provides the sqlite3 CLI on RHEL-family) — used by 089 backup
        # for consistent online DB snapshots (sqlite3 ".backup").
        # rsync + cronie — used by Script 03 (SSH share, cron schedules); neither
        # is preinstalled on RHEL-family minimal images.
        local packages=(tar tmux curl wget jq tor openssl ncurses-compat-libs sqlite rsync cronie)
        local to_install=()
        for pkg in "${packages[@]}"; do
            rpm -q "$pkg" &>/dev/null 2>&1 || to_install+=("$pkg")
        done

        if [[ ${#to_install[@]} -gt 0 ]]; then
            info "Installing missing packages: ${to_install[*]}"
            dnf install -y -q "${to_install[@]}" \
                || die "Failed to install packages: ${to_install[*]}. See error above."
            success "Packages installed."
        else
            success "All required packages already present."
        fi

        # cronie does not auto-start on install (unlike Debian's cron) — needed
        # by Script 03 schedules and the certbot renewal cron fallback.
        systemctl enable --now crond &>/dev/null || true
    else
        # Debian/Ubuntu — use apt-get
        # ncurses: Ubuntu 24.04 has no libncurses5 — use libncurses6 there.
        local ncurses_pkg
        if apt-cache show libncurses5 &>/dev/null 2>&1; then
            ncurses_pkg="libncurses5"
        else
            ncurses_pkg="libncurses6"
        fi

        # sqlite3 — CLI used by 089 backup for consistent online DB snapshots.
        # rsync + cron — used by Script 03 (SSH share, cron schedules); rsync is
        # no longer guaranteed on minimal Debian images.
        local packages=(tar openssl "$ncurses_pkg" tmux jq tor curl wget sqlite3 rsync cron)
        local to_install=()
        for pkg in "${packages[@]}"; do
            dpkg -s "$pkg" &>/dev/null 2>&1 || to_install+=("$pkg")
        done

        if [[ ${#to_install[@]} -gt 0 ]]; then
            info "Installing missing packages: ${to_install[*]}"
            apt-get update -qq \
                || die "apt-get update failed. Check your internet connection and package sources."
            apt-get install -y -qq "${to_install[@]}" \
                || die "Failed to install packages: ${to_install[*]}. See error above."
            success "Packages installed."
        else
            success "All required packages already present."
        fi
    fi

    # Ensure tor SOCKS daemon is running. apt auto-starts tor on Debian/Ubuntu,
    # but dnf on Rocky/Alma does not. Both `enable` and `start` are no-ops when
    # already in the desired state, so this is safe to re-run on every build.
    if systemctl list-unit-files tor.service &>/dev/null; then
        systemctl enable tor --quiet 2>/dev/null || true
        systemctl start  tor          2>/dev/null || true
        if ss -tlnp 2>/dev/null | grep -q '127.0.0.1:9050'; then
            success "Tor service running (SOCKS on 127.0.0.1:9050)."
        else
            warn "Tor service started but SOCKS port 9050 not yet listening — may need a moment."
        fi
        log "[STEP 2] tor enabled+started."
    fi

    ensure_swap_and_tuning

    log "[STEP 2] Deps OK."
}

# =============================================================================
# [2b] ENSURE SWAP + MEMORY/IO TUNING  (runs once, inside Step 2)
# -----------------------------------------------------------------------------
# A Grin node's startup is memory- and IO-heavy: opening LMDB plus an O(n)
# bitmap-accumulator rebuild over the whole output MMR (single-threaded). On a
# low-RAM VPS a cold boot can OOM-kill the node mid-rebuild — which then re-runs
# from scratch on the next start, looking like a permanently slow node. A small
# swapfile + low swappiness prevents that OOM-kill and keeps more page cache for
# the mmap'd chain files. Idempotent; degrades gracefully on containers (OpenVZ/
# LXC) that forbid swapon — it warns and continues rather than failing the build.
# =============================================================================
ensure_swap_and_tuning() {
    step_header "Step 2b: Swap & Memory Tuning"

    # ── Persistent VM tuning: prefer page cache over swap during the cold boot ──
    local sysctl_file="/etc/sysctl.d/99-grin-node.conf"
    cat > "$sysctl_file" <<'EOF'
# Grin Node Toolkit — favour file/page cache over swap during node startup.
# The node's startup reads several GB of mmap'd chain files on one core; keeping
# them cached (low swappiness) is the single biggest cold-boot speedup we control.
vm.swappiness = 10
vm.vfs_cache_pressure = 50
EOF
    sysctl -p "$sysctl_file" >/dev/null 2>&1 || true
    success "Applied vm.swappiness=10, vm.vfs_cache_pressure=50 ($sysctl_file)."

    # ── Skip swapfile creation if usable swap already exists (≥ ~2 GB) ──────────
    local active_swap_kb active_swap_mb
    active_swap_kb=$(awk '/SwapTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0)
    active_swap_mb=$(( active_swap_kb / 1024 ))
    if (( active_swap_mb >= 1900 )); then
        success "Swap already present (${active_swap_mb} MB) — no swapfile needed."
        log "[STEP 2b] swap present=${active_swap_mb}MB swappiness=10"
        return 0
    fi

    # ── Size: 2 GB default; 4 GB when RAM < 2 GB (more headroom for boot rebuild)──
    local mem_kb mem_mb swap_gb
    mem_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0)
    mem_mb=$(( mem_kb / 1024 ))
    if (( mem_mb > 0 && mem_mb < 2048 )); then swap_gb=4; else swap_gb=2; fi

    local swapfile="/swapfile"
    if [[ -f "$swapfile" ]] && swapon --show=NAME --noheadings 2>/dev/null | grep -qx "$swapfile"; then
        success "$swapfile already active."
        return 0
    fi

    # Disk-space guard: need swap_gb + 1 GB free on / before allocating.
    local free_mb
    free_mb=$(df -Pm / | awk 'NR==2{print $4}')
    if (( free_mb < swap_gb * 1024 + 1024 )); then
        warn "Only ${free_mb} MB free on / — too little for a ${swap_gb} GB swapfile. Skipping swap."
        return 0
    fi

    info "Creating ${swap_gb} GB swapfile at $swapfile (RAM detected: ${mem_mb} MB)..."
    rm -f "$swapfile" 2>/dev/null || true
    if ! fallocate -l "${swap_gb}G" "$swapfile" 2>/dev/null; then
        info "fallocate unavailable — falling back to dd (slower)..."
        if ! dd if=/dev/zero of="$swapfile" bs=1M count=$(( swap_gb * 1024 )) status=none 2>/dev/null; then
            warn "Could not allocate swapfile (likely a container) — continuing without swap."
            rm -f "$swapfile" 2>/dev/null || true
            return 0
        fi
    fi
    chmod 600 "$swapfile"
    if ! mkswap "$swapfile" >/dev/null 2>&1; then
        warn "mkswap failed — removing swapfile and continuing without swap."
        rm -f "$swapfile"; return 0
    fi
    if ! swapon "$swapfile" 2>/dev/null; then
        warn "swapon failed (container may forbid swap) — removing swapfile and continuing."
        rm -f "$swapfile"; return 0
    fi
    # Persist across reboots (only add the fstab line once).
    if ! grep -qE "^[[:space:]]*$swapfile[[:space:]]" /etc/fstab 2>/dev/null; then
        echo "$swapfile none swap sw 0 0" >> /etc/fstab
    fi
    success "${swap_gb} GB swap active and persisted in /etc/fstab."
    log "[STEP 2b] swapfile=${swap_gb}G ram=${mem_mb}MB swappiness=10"
}

# =============================================================================
# [3] SELECT NETWORK TYPE
# -----------------------------------------------------------------------------
# Sets NETWORK_TYPE to mainnet, testnet or both (mainnet first, then testnet).
# RESTRICTED_NETWORK, when set by the menu's Install key, means only that
# network is free: the prompt then offers it alone. A typo re-prompts; 0 (or
# end of input) returns 1 so the caller goes back to the menu.
# =============================================================================
select_network() {
    step_header "Step 3: Network Selection"
    local net_choice

    if [[ -n "$RESTRICTED_NETWORK" ]]; then
        echo ""
        echo -e "  ${GREEN}1${RESET}) Install ${BOLD}${RESTRICTED_NETWORK}${RESET}  (default)"
        echo -e "  ${DIM}0${RESET}) Back to the menu"
        echo ""
        while true; do
            echo -ne "${BOLD}Choice [1]: ${RESET}"
            read -r net_choice || return 1
            case "${net_choice:-1}" in
                1) NETWORK_TYPE="$RESTRICTED_NETWORK"; break ;;
                0) return 1 ;;
                *) warn "Invalid choice '${net_choice}' — enter 1 or 0." ;;
            esac
        done
        info "Network: ${BOLD}${NETWORK_TYPE}${RESET}"
        log "[STEP 3] Network=$NETWORK_TYPE (the other network is installed)"
        return 0
    fi

    echo ""
    echo -e "  ${GREEN}1${RESET}) Mainnet  (default)"
    echo -e "  ${YELLOW}2${RESET}) Testnet"
    echo -e "  ${CYAN}3${RESET}) Both     (you can run both mainnet/testnet in parallel — install mainnet first, then testnet)"
    echo -e "  ${DIM}0${RESET}) Back to the menu"
    echo ""
    while true; do
        echo -ne "${BOLD}Choice [1]: ${RESET}"
        read -r net_choice || return 1
        case "${net_choice:-1}" in
            0) return 1 ;;
            1) NETWORK_TYPE="mainnet"; break ;;
            2) NETWORK_TYPE="testnet"; break ;;
            3) NETWORK_TYPE="both";    break ;;
            *) warn "Invalid choice '${net_choice}' — enter 1, 2, 3 or 0." ;;
        esac
    done
    info "Network: $NETWORK_TYPE"
    log "[STEP 3] Network=$NETWORK_TYPE"
    return 0
}

# =============================================================================
# [4] SELECT ARCHIVE MODE (called once per network)
# -----------------------------------------------------------------------------
# Asks the user to choose between Pruned (default) or Full archive mode.
# IMPORTANT: Testnet does NOT support full archive mode.
# If the user selects full archive for testnet, shows an error and waits for user to exit.
# Default is Pruned for both networks.
# =============================================================================
select_archive_mode() {
    local network="$1"
    step_header "Step 4: Archive Mode (${network})"

    # Super Auto: always pruned, no prompt (both networks are pruned-only).
    if [[ "$SUPER_AUTO" == "true" ]]; then
        ARCHIVE_MODE="pruned"
        info "Super Auto: pruned mode (${network})."
        log "[STEP 4] ArchiveMode=pruned (super-auto)"
        return
    fi

    echo ""
    echo -e "  ${GREEN}1${RESET}) Pruned       (default, recommended — smaller storage, ~10 GiB)"
    echo -e "  ${YELLOW}2${RESET}) Full archive (mainnet only — full UTXO history, ~25 GiB)"
    echo -e "  ${DIM}0${RESET}) Return to main menu"
    echo ""

    if [[ "$network" == "testnet" ]]; then
        warn "Testnet does NOT support full archive mode."
    fi

    echo ""
    echo -ne "${BOLD}Choice [1]: ${RESET}"
    read -r arc_choice || true

    case "${arc_choice:-1}" in
        0) exit 0 ;;
        1) ARCHIVE_MODE="pruned" ;;
        2)
            if [[ "$network" == "testnet" ]]; then
                die "Full archive mode is not supported on testnet."
            fi
            ARCHIVE_MODE="full"
            ;;
        *) die "Invalid archive mode '${arc_choice}'." ;;
    esac

    # Disk space advisory — skipped on rebuild (target dir + instances conf already exist).
    # Derive the target dir for this network+mode to apply the same rebuild check as Step 5.
    local _s4_target_dir
    if   [[ "$ARCHIVE_MODE" == "full"    ]]; then _s4_target_dir="/opt/grin/node/mainnet-full"
    elif [[ "$network"      == "mainnet" ]]; then _s4_target_dir="/opt/grin/node/mainnet-prune"
    else                                          _s4_target_dir="/opt/grin/node/testnet-prune"
    fi

    if [[ -d "$_s4_target_dir" && -f "$INSTANCES_CONF" ]]; then
        info "Existing install detected — skipping disk space advisory (rebuild in place)."
    else
        local _free_kb _free_gb _min_gb
        _free_kb=$(df /opt/grin 2>/dev/null | awk 'NR==2{print $4}' \
                   || df / | awk 'NR==2{print $4}')
        _free_gb=$(awk "BEGIN {printf \"%.1f\", $_free_kb/1048576}")
        [[ "$ARCHIVE_MODE" == "full" ]] && _min_gb=25 || _min_gb=10
        echo ""
        echo -e "  ${DIM}Free disk (/opt/grin):${RESET}  ${BOLD}${_free_gb} GiB${RESET}"
        if awk "BEGIN {exit ($_free_gb >= $_min_gb) ? 0 : 1}"; then
            echo -e "  ${GREEN}✓${RESET}  Sufficient space for ${ARCHIVE_MODE} mode (min ~${_min_gb} GiB)."
        else
            echo ""
            echo -e "  ${RED}⚠  Low disk space:${RESET} ${_free_gb} GiB free, recommended minimum is ~${_min_gb} GiB"
            echo -e "     for ${ARCHIVE_MODE} mode (archive download + extraction)."
            echo ""
            echo -ne "  Continue anyway? [Y/n]: "
            read -r _space_ok || true
            [[ "${_space_ok,,}" == "n" ]] && exit 0
        fi
    fi

    info "Archive mode: $ARCHIVE_MODE"
    log "[STEP 4] ArchiveMode=$ARCHIVE_MODE"
}

# =============================================================================
# [ORCHESTRATOR] FULL SETUP FLOW FOR ONE NETWORK
# -----------------------------------------------------------------------------
# Calls steps 4–14 in sequence for a single network (mainnet or testnet).
# Resets per-node state variables at the end so the flow can be repeated
# cleanly for the second network when "Both" is selected.
# =============================================================================
setup_one_node() {
    local network="$1"

    select_archive_mode "$network"
    create_node_dir     "$network" "$ARCHIVE_MODE"
    download_grin_binary
    generate_config     "$network"
    patch_config        "$network" "$ARCHIVE_MODE"
    generate_secrets    "$network"
    download_chain_data "$network" "$ARCHIVE_MODE"
    if [[ "$SLOW_SYNC_MODE" == "true" ]]; then
        info "Slow sync selected — no archive downloaded. The node will sync from peers."
        log  "[CHAIN DATA] Slow sync — skipping download/verify/extract."
    elif [[ "$STREAM_MODE" == "true" ]]; then
        stream_extract_chain_data
    else
        verify_checksum
        check_disk_space
        extract_chain_data
    fi
    ensure_grin_user
    start_grin_tmux

    # Tor HiddenService — every toolkit-built node is reachable as an .onion HTTP
    # mirror by default. Identity (Ed25519 keys) lives in /var/lib/tor/grin-<net>-raw-tcp/
    # and is preserved across rebuilds.
    step_header "Step 13b: Tor HiddenService (Foreign API onion mirror)"
    local _api_port
    if _api_port=$(_grin_api_port "$network"); then
        _grin_torrc_install "$network" "$_api_port" || \
            warn "Tor HiddenService setup did not complete — node still runs on clearnet."
    else
        warn "Skipping Tor HiddenService setup — unknown network '$network'."
    fi

    show_summary        "$network" "$ARCHIVE_MODE"
    save_instance_location "$network" "$ARCHIVE_MODE"

    # Re-point every consumer at this node. Still required even though the vault
    # kept the secret VALUES identical: consumers store the secret PATH
    # (api_secret_path = <node_dir>/.api_secret), and a prune↔full rebuild moves
    # that directory. Runs after save_instance_location so the resolver can see
    # the new registry entry. Also installs the 5-min self-heal timer.
    _sync_secret_consumers "$network"

    # Post-build hardening. Runs AFTER save_instance_location so gnk_autostart_enable
    # can resolve the node dir from INSTANCES_CONF. Super Auto applies the whole
    # bundle without asking; the custom wizard (key 5, and key 4's full reinstall)
    # asks for autostart per node and for the event recorder once per run, both
    # default YES.
    if [[ "$SUPER_AUTO" == "true" ]]; then
        _super_auto_harden "$network" "$GRIN_DIR"
    else
        _offer_autostart "$network" "$GRIN_DIR"
        _offer_event_recorder
    fi

    # Reset per-node state for the next network (if "both" selected).
    # GRIN_BIN_TMP is intentionally NOT reset — reused by the second setup_one_node call.
    GRIN_DIR=""
    TAR_FILE=""
    SHA_FILE=""
    ARCHIVE_MODE=""
    STREAM_MODE=false
    SLOW_SYNC_MODE=false
    READY_SOURCES=()
}
