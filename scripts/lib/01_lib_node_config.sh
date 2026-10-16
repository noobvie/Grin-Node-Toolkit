# =============================================================================
# lib/01_lib_node_config.sh — Node directory, binary, grin-server.toml and secret creation for Script 01.
# =============================================================================
# Sourced by 01_build_new_grin_node.sh; shares its globals and log/info/warn/error helpers.
# Trap: runs with errexit off (the caller guards every call with `|| true`), so guard each file op with `|| { error ...; return 1; }`.

# =============================================================================
# [5] PREPARE NODE DIRECTORY
# -----------------------------------------------------------------------------
# Sets GRIN_DIR to the standardized location for the chosen network+mode:
#   /opt/grin/node/mainnet-full   — full archive, mainnet
#   /opt/grin/node/mainnet-prune  — pruned,       mainnet
#   /opt/grin/node/testnet-prune  — pruned,       testnet
#
# No user prompt is shown for the path — the standardized location is always used.
#
# Disk space check:
#   Skipped when GRIN_SKIP_DISK_CHECK=1 (set by the chain_data rebuild and Super Auto, which
#   already hold or just wiped the directory). On a fresh install
#   the check is a hard stop if space is insufficient.
#
# Existing files in GRIN_DIR are cleared automatically (no confirmation prompt)
# before the binary and chain data download begins.
# =============================================================================
create_node_dir() {
    local network="$1"
    local mode="$2"

    # 1. Resolve standardized path → GRIN_DIR
    local default_dir
    if [[ "$mode" == "full" ]]; then
        default_dir="/opt/grin/node/mainnet-full"
    elif [[ "$network" == "mainnet" ]]; then
        default_dir="/opt/grin/node/mainnet-prune"
    else
        default_dir="/opt/grin/node/testnet-prune"
    fi
    GRIN_DIR="$default_dir"

    step_header "Step 5: Prepare Node Directory"
    info "Node directory: $GRIN_DIR"
    echo ""

    # 1b. Remove the OTHER mainnet variant dir so switching fullmain↔prunemain
    #     leaves no leftover /opt/grin/node/<old-type> directory behind.
    if [[ "$network" == "mainnet" ]]; then
        local _alt_dir
        if [[ "$mode" == "full" ]]; then
            _alt_dir="/opt/grin/node/mainnet-prune"
        else
            _alt_dir="/opt/grin/node/mainnet-full"
        fi
        if [[ -d "$_alt_dir" ]]; then
            warn "Removing old mainnet directory: $_alt_dir"
            rm -rf "$_alt_dir" && success "Removed: $_alt_dir" || warn "Failed to remove: $_alt_dir"
        fi
    fi

    # 2. Disk space check — skipped for chain_data rebuilds and Super Auto (they set GRIN_SKIP_DISK_CHECK=1)
    if [[ "${GRIN_SKIP_DISK_CHECK:-0}" == "1" ]]; then
        info "Rebuild mode — skipping disk space check."
    else
        local min_gb avail_kb avail_gb
        [[ "$mode" == "full" ]] && min_gb=25 || min_gb=10
        local min_kb=$(( min_gb * 1024 * 1024 ))
        local check_path="$GRIN_DIR"
        while [[ ! -d "$check_path" && "$check_path" != "/" ]]; do
            check_path=$(dirname "$check_path")
        done
        avail_kb=$(df -k "$check_path" 2>/dev/null | awk 'NR==2{print $4}') || avail_kb=0
        avail_gb=$(( avail_kb / 1024 / 1024 ))
        echo -e "  ${DIM}$(df -h "$check_path" 2>/dev/null | awk 'NR==1||NR==2' | column -t)${RESET}"
        echo -e "  Available: ${BOLD}${avail_gb} GiB${RESET}  (required: ${min_gb} GiB)"
        echo ""
        if (( avail_kb < min_kb )); then
            die "Insufficient disk space: ${avail_gb} GiB available, ${min_gb} GiB required for ${mode} mode. Free up space on $(df -h "$check_path" 2>/dev/null | awk 'NR==2{print $1}') and retry."
        fi
        success "Disk space OK."
    fi

    # 3. Auto-clean existing files (no confirmation — path is fixed and standardized)
    if [[ -d "$GRIN_DIR" ]]; then
        local _existing_count
        _existing_count=$(find "$GRIN_DIR" -mindepth 1 2>/dev/null | wc -l) || _existing_count=0
        if (( _existing_count > 0 )); then
            warn "Removing ${_existing_count} existing item(s) from $GRIN_DIR ..."
            rm -rf "${GRIN_DIR:?}"/*  2>/dev/null || true
            rm -rf "${GRIN_DIR:?}"/.[!.]* 2>/dev/null || true
            success "Directory cleaned: $GRIN_DIR"
        fi
    fi

    mkdir -p "$GRIN_DIR" \
        || die "Failed to create directory $GRIN_DIR. Check permissions (must run as root)."
    success "Node directory ready: $GRIN_DIR"
    log "[STEP 5] Dir=$GRIN_DIR"
}

# =============================================================================
# [6] DOWNLOAD GRIN BINARY (latest linux-x86_64 from GitHub)
# -----------------------------------------------------------------------------
# Queries the GitHub API for the latest Grin release and downloads the
# linux-x86_64 tar.gz asset. Extracts the 'grin' binary to $GRIN_DIR.
# When setting up "both" networks, the binary is cached from the first download
# and reused for the second network to avoid a redundant download.
# Exits if the GitHub API is unreachable or no matching asset is found.
# =============================================================================
download_grin_binary() {
    step_header "Step 6: Download Grin Binary"

    # Reuse a binary already obtained in this session: either downloaded for the
    # first network of a "both" build, or compiled from source via menu key G.
    if [[ -n "$GRIN_BIN_TMP" && -f "$GRIN_BIN_TMP" ]]; then
        if [[ -n "${GRIN_PREBUILT_BIN:-}" && "$GRIN_BIN_TMP" == "${GRIN_PREBUILT_BIN:-}" ]]; then
            warn "Using the SOURCE-BUILT binary: $(basename "$GRIN_BIN_TMP")"
            warn "This is an unreleased build — not the latest official release."
        else
            info "Reusing binary downloaded earlier in this session."
        fi
        install -m 755 "$GRIN_BIN_TMP" "$GRIN_DIR/grin"
        success "Binary copied to $GRIN_DIR/grin"
        return
    fi

    info "Querying GitHub for latest Grin release..."
    local release_json
    release_json=$(curl -fsSL --max-time 30 "$GRIN_GITHUB_API") \
        || die "Failed to reach GitHub API. Check internet connection."

    local version download_url
    version=$(echo "$release_json" | jq -r '.tag_name')
    download_url=$(echo "$release_json" \
        | jq -r '.assets[] | select(.name | test("linux-x86_64\\.tar\\.gz$"; "i")) | .browser_download_url' \
        | head -1)

    if [[ -z "$download_url" || "$download_url" == "null" ]]; then
        die "No linux-x86_64 tar.gz asset found in GitHub release '$version'."
    fi

    info "Latest version : $version"
    info "Download URL   : $download_url"

    local tmp_tar="/tmp/grin_bin_$$.tar.gz"
    local tmp_dir="/tmp/grin_extract_$$"
    mkdir -p "$tmp_dir"

    info "Downloading binary (showing progress)..."
    wget -e background=off --progress=bar:force -O "$tmp_tar" "$download_url" \
        || die "Binary download failed."

    info "Extracting archive..."
    tar -xzf "$tmp_tar" -C "$tmp_dir" \
        || die "Failed to extract Grin binary archive from $tmp_tar."
    rm -f "$tmp_tar"

    local grin_bin
    grin_bin=$(find "$tmp_dir" -type f -name "grin" | grep -v "grin-wallet" | head -1)
    [[ -z "$grin_bin" ]] && die "Could not locate 'grin' binary in the downloaded archive."

    # Cache for reuse
    GRIN_BIN_TMP="$grin_bin"
    install -m 755 "$grin_bin" "$GRIN_DIR/grin"
    success "Grin $version binary installed to $GRIN_DIR/grin"
    log "[STEP 6] Version=$version Binary=$GRIN_DIR/grin"
}

# =============================================================================
# [7] GENERATE grin-server.toml VIA 'grin server config'
# -----------------------------------------------------------------------------
# Mainnet: './grin server config'
# Testnet: './grin --testnet server config'
# The --testnet flag produces the correct chain_type ("Testnet") and testnet
# ports (13413/13414/13415/13416) automatically — no manual patching needed.
# HOME is overridden to $GRIN_DIR so grin writes its output under our custom
# directory instead of /root.
# If the command fails the error is shown and the user must press Enter —
# there is no fallback minimal config; only the grin-generated file is used.
# =============================================================================
generate_config() {
    local network="$1"
    step_header "Step 7: Generate grin-server.toml"
    local target="$GRIN_DIR/grin-server.toml"

    # If a grin-server.toml already exists, back it up with a timestamp so the
    # newly generated file is always a clean slate.
    if [[ -f "$target" ]]; then
        local backup="${target}.bak.$(date +%s)"
        mv "$target" "$backup" \
            || die "Failed to back up existing config to $backup."
        warn "Existing config backed up: $(basename "$backup")"
    fi

    local cmd
    if [[ "$network" == "testnet" ]]; then
        cmd="./grin --testnet server config"
    else
        cmd="./grin server config"
    fi
    info "Running: $cmd  (HOME overridden to $GRIN_DIR)"

    # No || true — if the command fails, die() stops execution.
    (cd "$GRIN_DIR" && HOME="$GRIN_DIR" $cmd 2>&1 | tee -a "$LOG_FILE") \
        || die "'$cmd' failed. Cannot continue without a valid generated config. Exiting."

    # Locate the newly generated config (grin may write it into a subdirectory)
    local found_config
    found_config=$(find "$GRIN_DIR" -name "grin-server.toml" 2>/dev/null | head -1)

    if [[ -z "$found_config" ]]; then
        die "'$cmd' ran but grin-server.toml was not found in $GRIN_DIR. Check binary compatibility. Exiting."
    fi

    # Move to the root of GRIN_DIR if grin placed it in a subdirectory
    if [[ "$found_config" != "$target" ]]; then
        mv "$found_config" "$target" \
            || die "Failed to move config from $(dirname "$found_config") to $GRIN_DIR."
        info "Config moved from $(dirname "$found_config") → $GRIN_DIR"
    fi

    success "Config ready: $target"
    log "[STEP 7] network=$network cmd=$cmd config=$target"
}

# =============================================================================
# [8] PATCH grin-server.toml WITH USER CHOICES
# -----------------------------------------------------------------------------
# Modifies the generated config with user choices and enforces absolute paths:
#   archive_mode            → true (full) or false (pruned)
#   db_root                 → <node_dir>/chain_data
#   log_file_path           → <node_dir>/grin-server.log
#   api_secret_path         → <node_dir>/.api_secret
#   foreign_api_secret_path → <node_dir>/.foreign_api_secret
#   peer_max_inbound_count  → 999
#   peer_max_outbound_count → 199
#   peer_min_preferred_outbound_count → 199
#   log_max_files           → 10
#   file_log_level          → "Debug" (grin default "Info")
# chain_type and ports are already correct from 'grin [--testnet] server config'
# and do not need patching here.
# If any key is missing from the generated config, it is appended with a warning.
# =============================================================================
patch_config() {
    local network="$1"
    local mode="$2"
    local config="$GRIN_DIR/grin-server.toml"

    step_header "Step 8: Patch Config"

    local archive_val
    [[ "$mode" == "full" ]] && archive_val="true" || archive_val="false"

    # archive_mode
    if grep -q 'archive_mode' "$config"; then
        sed -i "s/^archive_mode = .*/archive_mode = $archive_val/" "$config"
    else
        echo "archive_mode = $archive_val" >> "$config"
        warn "archive_mode not found in config — appended."
    fi

    # db_root — point to our custom directory so grin stores chain data here
    local db_root="$GRIN_DIR/chain_data"
    if grep -q 'db_root' "$config"; then
        sed -i "s|^db_root = .*|db_root = \"$db_root\"|" "$config"
    else
        echo "db_root = \"$db_root\"" >> "$config"
        warn "db_root not found in config — appended."
    fi

    # log_file_path — keep log in the node directory, not in HOME
    if grep -qE '^#?[[:space:]]*log_file_path' "$config"; then
        sed -i -E "s|^#?[[:space:]]*log_file_path[[:space:]]*=.*|log_file_path = \"$GRIN_DIR/grin-server.log\"|" "$config"
    else
        echo "log_file_path = \"$GRIN_DIR/grin-server.log\"" >> "$config"
        warn "log_file_path not found in config — appended."
    fi

    # api_secret_path — absolute path so it works regardless of working directory
    if grep -qE '^#?[[:space:]]*api_secret_path' "$config"; then
        sed -i -E "s|^#?[[:space:]]*api_secret_path[[:space:]]*=.*|api_secret_path = \"$GRIN_DIR/.api_secret\"|" "$config"
    else
        echo "api_secret_path = \"$GRIN_DIR/.api_secret\"" >> "$config"
        warn "api_secret_path not found in config — appended."
    fi

    # foreign_api_secret_path — absolute path so it works regardless of working directory
    if grep -qE '^#?[[:space:]]*foreign_api_secret_path' "$config"; then
        sed -i -E "s|^#?[[:space:]]*foreign_api_secret_path[[:space:]]*=.*|foreign_api_secret_path = \"$GRIN_DIR/.foreign_api_secret\"|" "$config"
    else
        echo "foreign_api_secret_path = \"$GRIN_DIR/.foreign_api_secret\"" >> "$config"
        warn "foreign_api_secret_path not found in config — appended."
    fi

    # peer_max_inbound_count — allow more inbound peers for a community node
    if grep -qE '^#?[[:space:]]*peer_max_inbound_count' "$config"; then
        sed -i -E 's/^#?[[:space:]]*peer_max_inbound_count[[:space:]]*=.*/peer_max_inbound_count = 999/' "$config"
    else
        echo "peer_max_inbound_count = 999" >> "$config"
        warn "peer_max_inbound_count not found in config — appended."
    fi

    # peer_max_outbound_count — more outbound connections for faster propagation
    if grep -qE '^#?[[:space:]]*peer_max_outbound_count' "$config"; then
        sed -i -E 's/^#?[[:space:]]*peer_max_outbound_count[[:space:]]*=.*/peer_max_outbound_count = 199/' "$config"
    else
        echo "peer_max_outbound_count = 199" >> "$config"
        warn "peer_max_outbound_count not found in config — appended."
    fi

    # peer_min_preferred_outbound_count — aggressively maintain outbound connections
    if grep -qE '^#?[[:space:]]*peer_min_preferred_outbound_count' "$config"; then
        sed -i -E 's/^#?[[:space:]]*peer_min_preferred_outbound_count[[:space:]]*=.*/peer_min_preferred_outbound_count = 199/' "$config"
    else
        echo "peer_min_preferred_outbound_count = 199" >> "$config"
        warn "peer_min_preferred_outbound_count not found in config — appended."
    fi

    # log_max_files — keep 10 rotated log files: Debug logging fills each file
    # fast, and 3 held only ~10 days even at Info (086 design F-6)
    if grep -qE '^#?[[:space:]]*log_max_files' "$config"; then
        sed -i -E 's/^#?[[:space:]]*log_max_files[[:space:]]*=.*/log_max_files = 10/' "$config"
    else
        echo "log_max_files = 10" >> "$config"
        warn "log_max_files not found in config — appended."
    fi

    # file_log_level — Debug instead of grin's default Info, so a failure leaves
    # its detail in the log (e.g. the PMMR 'verify failed' lines of a corrupted
    # start are DEBUG-only). stdout_log_level is left at grin's default (Warning)
    # so the tmux pane stays readable. Debug fills log_max_size faster, so the
    # rotated history covers fewer days than at Info.
    if grep -qE '^#?[[:space:]]*file_log_level' "$config"; then
        sed -i -E 's/^#?[[:space:]]*file_log_level[[:space:]]*=.*/file_log_level = "Debug"/' "$config"
    else
        echo 'file_log_level = "Debug"' >> "$config"
        warn "file_log_level not found in config — appended."
    fi

    # enable_stratum_server — deliberately NOT patched here. Stratum is a mining
    # concern owned by Script 07 (solo setup / pool setup enable it; solo cleanup
    # disables it). Forcing it true on every node build would silently re-enable
    # mining config after a 07 cleanup and confuse the 07 setup flow. The grin
    # default (false) is kept for a freshly built node.

    # p2p host — no patch needed: grin v5.5+ already defaults to host = "::"
    # (IPv6 any-address, dual-stack), so no 0.0.0.0→:: rewrite is needed.

    success "Config patched:"
    info "  archive_mode                      = $archive_val"
    info "  db_root                           = \"$db_root\""
    info "  log_file_path                     = \"$GRIN_DIR/grin-server.log\""
    info "  api_secret_path                   = \"$GRIN_DIR/.api_secret\""
    info "  foreign_api_secret_path           = \"$GRIN_DIR/.foreign_api_secret\""
    info "  peer_max_inbound_count            = 999"
    info "  peer_max_outbound_count           = 199"
    info "  peer_min_preferred_outbound_count = 199"
    info "  log_max_files                     = 10"
    info "  file_log_level                    = \"Debug\"  (grin default: Info)"
    info "  enable_stratum_server            = (untouched — Script 07 owns stratum)"
    info "  host (p2p)                        = \"::\"  (v5.5 default — IPv4 + IPv6 dual-stack)"
    log "[STEP 8] archive_mode=$archive_val db_root=$db_root api_secret=$GRIN_DIR/.api_secret peer_limits=999in/199out/199min log_max_files=10 file_log_level=Debug stratum=untouched p2p_host=default(::)"
}

# =============================================================================
# [8b] PROVISION API SECRET FILES (persistent key vault)
# -----------------------------------------------------------------------------
# Ensures .api_secret and .foreign_api_secret exist in $GRIN_DIR, sourcing them
# from the persistent vault at /opt/grin/keys/<network>/ so they SURVIVE a
# rebuild. Delegates to grin_secret_vault_ensure (lib/grin_node_secrets.sh):
#   vault hit  → restore   (rebuild — every consumer keeps working)
#   vault miss → adopt the dir's existing secret, else mint a fresh one, and
#                seed the vault with it
#
# This runs BEFORE the multi-hour chain download (see setup_one_node), which is
# exactly why the vault write happens here and not "after a successful build":
# a failed download would otherwise leave nothing vaulted, and the retry would
# mint a THIRD secret. Vaulting at generation time makes the retry reuse the
# same one.
#
# Usage: generate_secrets <mainnet|testnet>
# The network MUST be passed — the global NETWORK_TYPE is "both" when the user
# selected both networks, so it cannot be used to key the vault here.
# =============================================================================
generate_secrets() {
    local network="${1:-}"
    step_header "Step 8b: API Secret Files (persistent key vault)"

    [[ "$network" == "mainnet" || "$network" == "testnet" ]] \
        || die "generate_secrets: invalid network '$network'."
    declare -F grin_secret_vault_ensure >/dev/null 2>&1 \
        || die "lib/grin_node_secrets.sh not loaded — cannot provision API secrets."

    grin_secret_vault_ensure "$network" "$GRIN_DIR" \
        || die "Failed to provision API secrets for $network (vault: $GNS_VAULT_DIR/$network)."

    local secret_file="$GRIN_DIR/.api_secret"
    local foreign_file="$GRIN_DIR/.foreign_api_secret"
    local _n=${#GNS_SECRET_FILES[@]}

    # The counters count FILES. Report "restored"/"adopted"/"generated" only when
    # ALL of them took that path — otherwise a partial vault (one entry deleted
    # or left blank by an interrupted write) would print "unchanged across this
    # rebuild" while one secret had in fact ROTATED, and the operator would never
    # know a consumer needed attention.
    if [[ "$GNS_VAULT_RESTORED" -eq "$_n" ]]; then
        success "Secrets restored from the key vault — unchanged across this rebuild:"
        info "  vault: $GNS_VAULT_DIR/$network/"
        info "  Consumers (Script 04 nginx, GrinScan, collector, pool) keep working."
    elif [[ "$GNS_VAULT_ADOPTED" -eq "$_n" ]]; then
        success "Existing secrets adopted into the key vault (values kept as-is):"
        info "  vault: $GNS_VAULT_DIR/$network/"
    elif [[ "$GNS_VAULT_CREATED" -eq "$_n" ]]; then
        success "New secrets generated and saved to the key vault:"
        info "  vault: $GNS_VAULT_DIR/$network/  ${DIM}(restored automatically on any future rebuild)${RESET}"
    else
        warn "Mixed outcome — the secrets did NOT all take the same path:"
        info "  restored from vault : $GNS_VAULT_RESTORED of $_n"
        info "  adopted into vault  : $GNS_VAULT_ADOPTED of $_n"
        info "  newly generated     : $GNS_VAULT_CREATED of $_n"
        if [[ "$GNS_VAULT_CREATED" -gt 0 ]]; then
            warn "  A NEW secret was minted — consumers are re-pointed at Step 14b."
        fi
        info "  vault: $GNS_VAULT_DIR/$network/"
    fi

    if [[ "$GNS_VAULT_WARNINGS" -gt 0 ]]; then
        warn "Vault not writable ($GNS_VAULT_WARNINGS write(s) failed) — the node works now,"
        warn "  but these secrets will NOT survive the next rebuild."
        warn "  Check permissions and free space on $GNS_VAULT_DIR"
    fi

    info "  $secret_file"
    info "  $foreign_file"
    log "[STEP 8b] net=$network restored=$GNS_VAULT_RESTORED adopted=$GNS_VAULT_ADOPTED created=$GNS_VAULT_CREATED warnings=$GNS_VAULT_WARNINGS vault=$GNS_VAULT_DIR/$network"
}

# -----------------------------------------------------------------------------
# _sync_secret_consumers <network> — post-build: re-point every installed
# consumer (collector, GrinScan, Tiny Explorer, wallets, Script 04 nginx, pool
# stratum) at the node that was just built, and install the 5-minute self-heal
# timer so any future out-of-band rebuild is healed automatically.
#
# The vault keeps the secret VALUES stable, but consumers also store the secret
# PATH — and a prune↔full rebuild moves the node directory. That path fix is
# what this call delivers.
#
# Fully guarded: every helper is a no-op when its product is absent, and the
# whole thing is best-effort — a sync failure must never abort a good build.
# -----------------------------------------------------------------------------
_sync_secret_consumers() {
    local network="${1:-}"
    declare -F grin_secrets_sync_all >/dev/null 2>&1 || return 0

    step_header "Step 14b: Re-sync API secrets to installed services"
    if declare -F grin_install_secret_sync >/dev/null 2>&1; then
        grin_install_secret_sync || true
        info "Self-heal timer installed: grin-secret-sync.timer (every 5 min)"
    fi
    grin_secrets_sync_all || true
    success "Consumers re-pointed at $GRIN_DIR"
    info "  Manual re-sync any time: ${BOLD}grin-secret-sync${RESET}"
    info "  Deliberate rotation:     ${BOLD}grin-secret-sync --rotate $network${RESET} ${DIM}(needs a node restart)${RESET}"
    log "[STEP 14b] secret consumers re-synced for $network ($GRIN_DIR)"
}

# =============================================================================
# [8c] CREATE GRIN SERVICE USER
# -----------------------------------------------------------------------------
# Creates the 'grin' system user (no login shell, no home dir) if it does not
# already exist, then sets grin:grin ownership on GRIN_DIR so the node runs
# under the service account. Safe to call multiple times (idempotent).
# =============================================================================
ensure_grin_user() {
    step_header "Step 8c: Create grin Service User"

    if id grin &>/dev/null; then
        info "System user 'grin' already exists — skipping creation."
    else
        if useradd -r -s /usr/sbin/nologin -d /opt/grin -M grin 2>/dev/null; then
            success "System user grin:grin created."
        else
            warn "Could not create user 'grin' — node will run as current user."
            return
        fi
    fi

    if [[ -n "${GRIN_DIR:-}" && -d "$GRIN_DIR" ]]; then
        # Chown only the specific node directory — other services (grinscan, drop,
        # wallet, etc.) share /opt/grin/ and manage their own ownership (www-data).
        # Never walk up to the grandparent or it silently breaks every other service.
        chown -R grin:grin "$GRIN_DIR" 2>/dev/null || true
        info "Ownership set: grin:grin → $GRIN_DIR"
    fi
}
