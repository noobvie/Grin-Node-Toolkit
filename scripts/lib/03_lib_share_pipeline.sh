# 03_lib_share_pipeline.sh — share pipeline of Script 03 (menu B and the --cron-nginx* runs): sync check, disk preflight, compress, manifest, node stop/restart.
# Sourced by 03_grin_share_chain_data.sh; shares its globals and log/info/warn/error.
# Moved as-is; this script sets no errexit and file operations are not individually guarded.

# Dual-verification: Grin Owner API v2 + grin client — at least one must confirm no_sync
check_grin_sync_status() {
    log "=========================================="
    log "SYNC STATUS CHECK"
    log "=========================================="

    local api_port
    [ "$NETWORK_TYPE" = "testnet" ] && api_port=13413 || api_port=3413

    local api_secret=""
    for location in "$GRIN_DIR/.api_secret" "$GRIN_DATA_DIR/../.api_secret" \
                    "$HOME/.grin/main/.api_secret" "/root/.grin/main/.api_secret"; do
        if [ -f "$location" ]; then
            api_secret=$(tr -d '\n\r' < "$location" 2>/dev/null)
            log "API secret: $location"
            break
        fi
    done
    [ -z "$api_secret" ] && log "WARNING: .api_secret not found"

    # ── API check ──────────────────────────────────────────────────────────────
    log ""
    log "Check 1/2: Owner API v2..."
    local api_response="" api_sync_status="" api_connections="" api_height=""
    local api_check_passed=false

    if [ -n "$api_secret" ]; then
        api_response=$(curl -s -X POST --connect-timeout 5 \
            -u "grin:$api_secret" "http://127.0.0.1:$api_port/v2/owner" \
            -H "Content-Type: application/json" \
            -d '{"jsonrpc":"2.0","method":"get_status","params":[],"id":1}' 2>/dev/null)
    else
        api_response=$(curl -s -X POST --connect-timeout 5 \
            "http://127.0.0.1:$api_port/v2/owner" \
            -H "Content-Type: application/json" \
            -d '{"jsonrpc":"2.0","method":"get_status","params":[],"id":1}' 2>/dev/null)
    fi

    if [ -z "$api_response" ]; then
        log "  ✗ Cannot connect to Owner API on port $api_port"
    elif echo "$api_response" | grep -q '"error"'; then
        local emsg; emsg=$(echo "$api_response" | grep -o '"message"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4)
        log "  ✗ API error: ${emsg:-unknown}"
    else
        if command -v jq &>/dev/null; then
            api_sync_status=$(echo "$api_response" | jq -r '.result.Ok.sync_status // empty' 2>/dev/null)
            api_connections=$(echo "$api_response" | jq -r '.result.Ok.connections // empty' 2>/dev/null)
            api_height=$(echo "$api_response" | jq -r '.result.Ok.tip.height // empty' 2>/dev/null)
        else
            api_sync_status=$(echo "$api_response" | grep -o '"sync_status"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4)
            api_connections=$(echo "$api_response" | grep -o '"connections"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$')
            api_height=$(echo "$api_response" | grep -o '"height"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$')
        fi
        log "  sync_status: ${api_sync_status:-unknown}  connections: ${api_connections:-?}  height: ${api_height:-?}"
        [ "$api_sync_status" = "no_sync" ] && api_check_passed=true \
            && log "  ✓ API: fully synced" || log "  ✗ API: not synced (${api_sync_status:-unknown})"
    fi

    # ── Client check ───────────────────────────────────────────────────────────
    log ""
    log "Check 2/2: Grin client..."
    local client_output="" client_exit_code=1 client_sync_status="" client_check_passed=false
    local attempt=1

    if [ ! -f "$GRIN_BINARY" ]; then
        log "  ✗ Binary not found: $GRIN_BINARY"
    else
        while [ $attempt -le 3 ]; do
            log "  Attempt $attempt/3..."
            client_output=$(cd "$GRIN_DIR" && timeout 30 "$GRIN_BINARY" client status 2>&1)
            client_exit_code=$?
            [ $client_exit_code -eq 0 ] && [ -n "$client_output" ] && { log "  Command succeeded"; break; }
            [ $attempt -lt 3 ] && sleep 5
            attempt=$((attempt+1))
        done

        if [ $client_exit_code -ne 0 ]; then
            log "  ✗ Client failed after 3 attempts"
        else
            client_sync_status=$(echo "$client_output" | tr -d '\r' | grep -i "sync status" | tail -1 | sed 's/.*:[[:space:]]*//' | tr -d '[:space:]')
            log "  Parsed sync status: '${client_sync_status:-not found}'"
            [ "$client_sync_status" = "no_sync" ] && client_check_passed=true \
                && log "  ✓ Client: no_sync" || log "  ✗ Client: '${client_sync_status:-unknown}'"
        fi
    fi

    # ── Result ────────────────────────────────────────────────────────────────
    log ""
    log "  API check:    $([ "$api_check_passed"    = true ] && echo "✓ PASSED" || echo "✗ FAILED (${api_sync_status:-unknown})")"
    log "  Client check: $([ "$client_check_passed" = true ] && echo "✓ PASSED" || echo "✗ FAILED (${client_sync_status:-unknown})")"
    log ""

    if [ "$api_check_passed" = true ] || [ "$client_check_passed" = true ]; then
        [ -n "$api_connections" ] && [ "$api_connections" -ge 1 ] 2>/dev/null \
            && log "  Peer connections: $api_connections" \
            || log "  ⚠ Peer connections unknown or none"
        log "✓ Node verified as fully synced — proceeding"
        return 0
    fi

    log "✗ SYNC CHECK FAILED — BACKUP ABORTED"
    log "Both checks failed. Wait for node to finish syncing, then retry."
    return 1
}

# Validate that the output directory and binary are accessible before starting
validate_nginx_config() {
    local errors=0
    [ ! -d "$GRIN_DATA_DIR" ] && { log "ERROR: chain_data not found: $GRIN_DATA_DIR"; errors=$((errors+1)); }
    [ ! -f "$GRIN_BINARY" ]   && { log "ERROR: binary not found: $GRIN_BINARY";        errors=$((errors+1)); }
    [ $errors -gt 0 ] && exit 1
    log "✓ Configuration validated"
    check_grin_sync_status || exit 1
}

################################################################################
# Nginx pipeline steps
################################################################################

# Step 0a: decide whether this run can finish BEFORE anything is destroyed.
#
# Why this exists, and why it runs first. The publish sequence deletes the live
# archive (step 0) long before its replacement exists (step 5), so a run that
# cannot finish takes the mirror down with it. With fullmain published on the
# 1st and 15th, that failure leaves a mirror dead for up to 17 days (a twice-weekly
# cadence would heal within four), which is what makes "fail before deleting anything" worth real code.
#
# Three outcomes, measured on OUTPUT_DIR's filesystem — the only one that has to
# hold the archive, since chain_data may well sit on another disk:
#   room for both            -> RETAIN_PREVIOUS=true, the published set keeps
#                               serving for the whole build and is swapped out at
#                               the end of step 5
#   room only after deleting -> RETAIN_PREVIOUS=false, the historical behaviour
#   room for neither         -> abort, having touched nothing
preflight_disk_space() {
    log "Step 0a: Checking disk space before publishing..."
    mkdir -p "$OUTPUT_DIR"

    # Size the payload as it will actually be tarred: step 2 deletes the node's
    # own state-sync zips, which on an archive node run to several GB. Counting
    # them here would inflate the estimate into a false abort.
    local src_kb
    src_kb=$(du -sk --exclude='txhashset_snapshot*.zip' --exclude='txhashset_zip*' \
                 "$GRIN_DATA_DIR" 2>/dev/null | awk '{print $1; exit}')
    case "$src_kb" in
        ''|*[!0-9]*)
            log "WARNING: could not size $GRIN_DATA_DIR — proceeding without the space check"
            RETAIN_PREVIOUS=false; return 0 ;;
    esac

    # POSIX df: -P forces one line per filesystem, -k gives KiB blocks.
    local df_line avail_kb mount_pt
    df_line=$(df -Pk "$OUTPUT_DIR" 2>/dev/null | awk 'NR==2')
    avail_kb=$(printf '%s\n' "$df_line" | awk '{print $4}')
    mount_pt=$(printf '%s\n' "$df_line" | awk '{print $6}')
    case "$avail_kb" in
        ''|*[!0-9]*)
            log "WARNING: could not read free space on $OUTPUT_DIR — proceeding without the space check"
            RETAIN_PREVIOUS=false; return 0 ;;
    esac

    # What step 0 would hand back if it deleted the published archive.
    local reclaim_kb
    reclaim_kb=$(find "$OUTPUT_DIR" -maxdepth 1 -type f -name '*.tar.gz' -printf '%k\n' 2>/dev/null \
                 | awk '{s+=$1} END {print s+0}')
    case "$reclaim_kb" in ''|*[!0-9]*) reclaim_kb=0 ;; esac

    # Kept apart from reclaim_kb, which grows below: this is the published
    # archive alone, and it doubles as the compression measurement further down.
    local prev_archive_kb="$reclaim_kb" archive_count
    archive_count=$(find "$OUTPUT_DIR" -maxdepth 1 -type f -name '*.tar.gz' 2>/dev/null | wc -l)

    # Step 2 (remove_old_txhashset) deletes the node's own state-sync zips before
    # the tar runs — which is exactly why src_kb excludes them above. Those bytes
    # go back to the filesystem too, and on an archive node they run to several
    # GB, so they are reclaimable in precisely the same sense as the published
    # archive. Counting them on one side of the sum and not the other is what
    # turns a run that would have fit into a false abort.
    #
    # Only credited when chain_data sits on the SAME filesystem as OUTPUT_DIR:
    # freeing space on another disk does nothing for the one being written to.
    # Top-level globs deliberately — a nested zip is undercounted, and undercounting
    # reclaimable space is the safe direction for this check.
    local snap_kb=0 chain_mount
    chain_mount=$(df -Pk "$GRIN_DATA_DIR" 2>/dev/null | awk 'NR==2 {print $6}')
    if [ -n "$mount_pt" ] && [ "$chain_mount" = "$mount_pt" ]; then
        local zip_kb=0 dir_kb=0
        zip_kb=$(du -sck "$GRIN_DATA_DIR"/txhashset_snapshot*.zip 2>/dev/null | awk 'END {print $1+0}')
        dir_kb=$(du -sck "$GRIN_DATA_DIR"/txhashset_zip*         2>/dev/null | awk 'END {print $1+0}')
        snap_kb=$((zip_kb + dir_kb))
        case "$snap_kb" in ''|*[!0-9]*) snap_kb=0 ;; esac
        [ "$snap_kb" -gt 0 ] && reclaim_kb=$((reclaim_kb + snap_kb))
    fi

    local ratio="$COMPRESS_RATIO_PRUNED" ratio_src="estimate"
    [ "$NODE_TYPE" = "full" ] && ratio="$COMPRESS_RATIO_FULL"

    # Self-calibration. COMPRESS_RATIO_* is a guess about how compressible this
    # chain is; the archive already sitting in OUTPUT_DIR is the answer, measured
    # on this box, this chain and this compressor at this level. Prefer the
    # measurement and the constants become what they should always have been —
    # a seed for the first run, before there is anything to measure.
    #
    # This is what a 0.95 guess costs when the truth is 0.87: on an 18 GiB
    # archive node the phantom 8 points are ~1.5 GiB of need that does not
    # exist, which is enough to abort a run that has completed fine for months.
    #
    # Direction of the drift, stated carefully because it goes the UNSAFE way.
    # The denominator is TODAY's chain_data while the published archive came from
    # a smaller one, so the derived ratio reads slightly LOW. need then works out
    # to almost exactly the previous archive's size, while the new one will be
    # bigger by one cadence of chain growth (~7 MiB/day of chain_data, so ~85 MiB
    # of archive over a fortnight). That undershoot is what DISK_HEADROOM_MB is
    # there to absorb — 512 MiB covers roughly six cadences — but it means the
    # headroom is load-bearing here, not decorative. Do not cut it to zero on the
    # reasoning that the ratio is measured rather than guessed.
    #
    # Guards. Exactly one archive, or the sum is two generations added together
    # and meaningless. A sane band, because a truncated or half-written archive
    # would otherwise talk this check into greenlighting a run that cannot
    # finish — the one outcome the whole function exists to prevent. Outside the
    # band the constant stands and the anomaly is logged rather than swallowed.
    if [ "$archive_count" -eq 1 ] && [ "$prev_archive_kb" -gt 0 ] && [ "$src_kb" -gt 0 ]; then
        local measured
        measured=$(awk -v a="$prev_archive_kb" -v s="$src_kb" 'BEGIN { printf "%.3f", a/s }')
        if awk -v m="$measured" 'BEGIN { exit !(m >= 0.30 && m <= 1.10) }'; then
            ratio="$measured"; ratio_src="measured from the published archive"
        else
            log "  WARNING: published archive implies ratio $measured — outside 0.30-1.10, ignoring it"
            log "           (a truncated or foreign .tar.gz in $OUTPUT_DIR would look like this)"
        fi
    fi

    local need_kb
    need_kb=$(awk -v s="$src_kb" -v r="$ratio" -v h="$DISK_HEADROOM_MB" \
              'BEGIN { printf "%d", (s * r) + (h * 1024) }')

    log "  chain_data to archive : $((src_kb/1024)) MiB"
    log "  estimated need        : $((need_kb/1024)) MiB (ratio $ratio, $ratio_src + ${DISK_HEADROOM_MB} MiB headroom)"
    log "  free on ${mount_pt:-?} : $((avail_kb/1024)) MiB (+ $((reclaim_kb/1024)) MiB reclaimable)"
    [ "$snap_kb" -gt 0 ] && log "    of which txhashset snapshots freed by step 2: $((snap_kb/1024)) MiB"

    if [ "$reclaim_kb" -gt 0 ] && [ "$avail_kb" -ge "$need_kb" ]; then
        RETAIN_PREVIOUS=true
        log "  Room for both — the published archive stays online for this build"
    elif [ $((avail_kb + reclaim_kb)) -ge "$need_kb" ]; then
        RETAIN_PREVIOUS=false
        log "  Room only after reclaiming — the published archive is removed first"
    else
        RETAIN_PREVIOUS=false
        log "ERROR: not enough space on ${mount_pt:-$OUTPUT_DIR}, even after reclaiming"
        log "  need $((need_kb/1024)) MiB, would have $(((avail_kb + reclaim_kb)/1024)) MiB"
        log "  Nothing was deleted and the node was NOT stopped — whatever is published stays served."
        log "ERROR: skipping this instance (free space, or lower the COMPRESS_RATIO_* estimate if it is too pessimistic for this data)"
        # return, NOT error_exit. error_exit is `exit 1`, and run_cron_nginx runs
        # mainnet then testnet in one process — so aborting here would take a
        # perfectly healthy testnet publish down with a mainnet disk problem.
        # Nothing has been stopped or deleted at this point, so returning is
        # clean: the caller simply moves on to the next instance.
        return 1
    fi
}

# Step 0: clear the artefacts this pipeline published earlier from the output dir
#
# OUTPUT_DIR is a live nginx web root, not a scratch dir. Only the files THIS
# pipeline publishes are removed — anything else the operator put there is kept.
# In particular index.html (the Script 02 landing page) must survive, otherwise
# every sync would silently revert the site to the bare autoindex.
clean_output_directory() {
    log "Step 0: Cleaning output directory: $OUTPUT_DIR"
    mkdir -p "$OUTPUT_DIR"
    cd "$OUTPUT_DIR" || error_exit "Cannot access $OUTPUT_DIR"

    # Debris in every case: interrupted transfers and abandoned temp files. The
    # sweep is name-scoped to protect index.html (not a blanket delete), so debris
    # has to be named or it accumulates forever. The leading-dot patterns are
    # spelled out because a bare * never matches them — that includes step 5's own
    # hidden work files.
    local -a targets=( '*.tar.gz.part' '*.tar.gz.tmp' '*.tar.gz.[0-9]'
                       'wget-log' 'wget-log.*' '.chaindata.json.*'
                       '.*.tar.gz.tmp' '.*.sha256.tmp' )

    if [ "${RETAIN_PREVIOUS:-false}" = true ]; then
        # Step 0a found room for both, so the published set is left exactly as it
        # is — archive, checksum, README and manifest all still agree with each
        # other, and the mirror keeps serving something complete and verifiable
        # for the whole build. Step 5 replaces the set in one short swap instead
        # of this step emptying the directory up front.
        log "Retaining the published archive for this build (step 0a found room for both)"
    else
        # chaindata.json goes first on purpose: its presence is the "archive is
        # complete and downloadable" signal, so it must never outlive the archive.
        targets=( chaindata.json '*.tar.gz' '*.sha256' README.txt
                  check_status_before_download.txt "${targets[@]}" )
    fi

    local removed=0 pat f
    for pat in "${targets[@]}"; do
        for f in $pat; do                # unquoted on purpose — glob expands here
            [ -f "$f" ] || continue      # unmatched glob stays literal — skip it
            rm -f "$f" && removed=$((removed+1))
        done
    done

    # Anything still here is the operator's (index.html, robots.txt, assets).
    # Listed, not deleted — if the count surprises you, that dir has cruft.
    local kept
    kept=$(find . -maxdepth 1 -type f 2>/dev/null | wc -l)
    log "Removed $removed published file(s); kept $kept other file(s)"
    if [ "$kept" -gt 0 ]; then
        log "  kept: $(find . -maxdepth 1 -type f -printf '%f ' 2>/dev/null)"
    fi
    log "Output directory ready"
}

# Step 1: graceful SIGTERM → SIGKILL if needed
stop_grin_node() {
    log "Step 1: Stopping Grin node..."
    local pid; pid=$(get_pid_on_port "$GRIN_PORT")
    [ -z "$pid" ] && { log "Grin not running on port $GRIN_PORT — skipping"; return 0; }

    # Planned-stop marker BEFORE the signal (lib/grin_node_control.sh) — this
    # SIGTERM bypasses gnc_kill_grin_session, so nothing else would name the pid.
    local _sess
    if _sess=$(gnc_session_of_pid "$pid"); then gnc_mark_planned_stop "$_sess" "chain data share"; fi

    log "PID $pid on port $GRIN_PORT — sending SIGTERM..."
    kill -TERM "$pid" 2>/dev/null
    local count=0
    while ps -p "$pid" >/dev/null 2>&1 && [ $count -lt "$GRIN_STOP_TIMEOUT" ]; do
        sleep 2; count=$((count+2))
        [ $((count % 30)) -eq 0 ] && log "Waiting for stop... (${count}s)"
    done

    if ps -p "$pid" >/dev/null 2>&1; then
        [ "$FORCE_KILL_IF_STUCK" = true ] && { log "Timeout — sending SIGKILL..."; kill -KILL "$pid" 2>/dev/null; sleep 3; } \
            || error_exit "Grin failed to stop after ${GRIN_STOP_TIMEOUT}s"
    fi

    is_grin_running && error_exit "Failed to stop Grin after multiple attempts"
    log "Grin stopped (port $GRIN_PORT free)"
}

# Step 2: remove large txhashset zip files and txhashset_zip dir before compressing
remove_old_txhashset() {
    log "Step 2: Removing txhashset_snapshot*.zip files and txhashset_zip directory..."
    cd "$GRIN_DATA_DIR" || error_exit "Cannot access $GRIN_DATA_DIR"
    local count; count=$(find . -name "txhashset_snapshot*.zip" 2>/dev/null | wc -l)
    [ "$count" -gt 0 ] && find . -name "txhashset_snapshot*.zip" -delete && log "Removed $count zip file(s)" \
        || log "No txhashset_snapshot*.zip found"
    local zip_dirs; zip_dirs=$(find . -maxdepth 1 -type d -name "txhashset_zip*" 2>/dev/null)
    if [[ -n "$zip_dirs" ]]; then
        find . -maxdepth 1 -type d -name "txhashset_zip*" -exec rm -rf {} +
        log "Removed txhashset_zip* director(ies)"
    else
        log "No txhashset_zip* directory found"
    fi
}

# Step 3: peer directory — kept in archive intentionally.
# Do not remove it: when DNS seeds are unavailable
# (as happened when all Grin DNS seed nodes went offline in 2026-04) a node
# that bootstraps from this archive has no peers at all and cannot connect.
# Including the peer DB gives downloaders a head-start with known-good peers.
# LMDB reinitialises lock.mdb on open, so cross-platform copies are safe.
remove_peer_directory() {
    log "Step 3: Keeping peer directory (skipped — see comment above)"
}

# Step 4: write status file to signal download is not yet ready
create_status_in_progress() {
    log "Step 4: Setting status: in progress..."
    mkdir -p "$OUTPUT_DIR"
    if [ "${RETAIN_PREVIOUS:-false}" = true ]; then
        # "DO NOT download" would simply be false here: the published set is
        # intact and verifiable right up to the swap at the end of step 5.
        #
        # It MUST still open with the literal "Sync completed." — that exact
        # string is the readiness gate in three separate consumers, one of which
        # is out of our control:
        #   01_build_new_grin_node.sh  grep -q "Sync completed." -> else SKIP HOST
        #   081_host_monitor_port.sh   same grep -> reports "sync in progress"
        #   lib/02_lib_landing.sh      classify() regex -> badge state
        # Script 01 runs on strangers' VPSes at whatever version they downloaded,
        # so a client that predates this line will never learn a new vocabulary.
        # Word it any other way and every such client skips a mirror that is
        # serving a complete, checksummed archive — which is exactly the outcome
        # retaining it was meant to prevent.
        #
        # The wording is also just accurate: this file describes what is
        # PUBLISHED, not what the box happens to be doing. Keep the suffix free
        # of "in progress" — the landing page tests that phrase first and would
        # grey the mirror out.
        echo "Sync completed. You may download the ${NODE_TYPE} ${NETWORK_TYPE} archive. Verify the checksum first. Last updated: $(get_utc_timestamp) (A newer archive is being prepared; the one published here stays valid until it is replaced.)" \
            > "$STATUS_FILE"
    else
        echo "Sync is in progress. DO NOT download. Check back in 30 minutes. Last updated $(get_utc_timestamp)" \
            > "$STATUS_FILE"
    fi
}

# Which IO scheduler backs a path. `ionice` is honoured by the CFQ and BFQ
# schedulers ONLY; on mq-deadline or none — which is what modern kernels pick for
# virtio-blk and NVMe, i.e. essentially every VPS — the priority is accepted and
# then silently ignored. Worth knowing rather than assuming, so the log can say
# whether the IO throttle is real instead of implying one that is not there.
_io_scheduler() {
    local dev sched
    dev=$(df -P "$1" 2>/dev/null | awk 'NR==2 {print $1}')
    dev=${dev##*/}
    case "$dev" in
        nvme*|mmcblk*) dev=${dev%p[0-9]*} ;;              # nvme0n1p1 -> nvme0n1
        *)             dev=${dev%%[0-9]*} ;;              # vda1 -> vda
    esac
    [ -r "/sys/block/$dev/queue/scheduler" ] || return 1
    sched=$(tr ' ' '\n' < "/sys/block/$dev/queue/scheduler" 2>/dev/null \
            | grep -o '^\[.*\]$' | tr -d '[]')
    [ -n "$sched" ] || return 1
    printf '%s\n' "$sched"
}

# Clamp an operator-supplied compression level to something the chosen compressor
# actually accepts. pigz takes 0 (store, near-zero CPU) but GNU gzip REJECTS -0
# outright — and because the level is env-overridable, an unguarded 0 would build
# fine on a box with pigz and hard-fail on the fallback box beside it, at step 5,
# with the node already stopped. Non-numeric input would otherwise reach the
# compressor as a flag.
_clamp_level() {
    local v="$1" lo="$2"
    case "$v" in ''|*[!0-9]*) echo 6; return 0 ;; esac
    if [ "$v" -lt "$lo" ]; then echo "$lo"
    elif [ "$v" -gt 9 ]; then echo 9
    else echo "$v"; fi
}

# Step 5: tar.gz chain_data + sha256 checksum
#
# Compression runs through pigz (parallel gzip) when it is available. pigz emits
# a STANDARD gzip stream under the same .tar.gz name, so every downstream
# assumption in Script 01 still holds unchanged — the manifest's
# ^[A-Za-z0-9._-]+\.tar\.gz$ regex, the autoindex href grep, and `tar -xzf`
# extraction in both transfer modes. This change is invisible to downloaders,
# which is exactly why pigz was chosen over zstd (a .tar.zst breaks all three).
# Falls back to plain gzip on hosts where pigz cannot be installed.
#
# WARNING: this script does NOT set `set -euo pipefail` (nearly every other
# top-level script in scripts/ does — 03 is the exception, not 01 the outlier), and
# in a pipeline `$?` reports the LAST command — pigz — not tar. Without the
# PIPESTATUS check below, a tar that died halfway (disk full, IO error, a file
# vanishing mid-read) would publish a TRUNCATED archive alongside a perfectly
# valid .sha256 and a perfectly valid manifest. Every integrity and freshness
# check downstream would accept it, because each one is self-consistent with the
# corrupt file. A lone `tar -czf` has a sound `$?` test; as a pipeline it is the
# PIPESTATUS check that makes this load-bearing.
compress_chain_data() {
    log "Step 5: Compressing chain_data..."
    # Every failure path below RETURNS rather than calling error_exit. error_exit
    # is `exit 1`, and by this point step 1 has already stopped the grin node, so
    # exiting here would skip step 9 and leave the node down indefinitely — on a
    # mirror box, until a human noticed. Returning lets the caller restart it.
    cd "$GRIN_DATA_DIR/.." || { log "ERROR: cannot access parent of chain_data"; return 1; }
    local dir_name; dir_name=$(basename "$GRIN_DATA_DIR")
    local base="grin_${NODE_TYPE}_${NETWORK_TYPE}_$(date +%Y%m%d)"
    local out="$OUTPUT_DIR/${base}.tar.gz"

    # Build under a HIDDEN temp name and swap at the very end. Two reasons:
    #   - nginx autoindex does not list dotfiles, and Script 01's fallback
    #     discovery greps that listing for hrefs, so with a hidden temp a client
    #     can never see the partial file. A visible temp name would be offered
    #     for download the moment tar created it.
    #   - when step 0a retained the previous archive, that archive keeps serving
    #     until the instant its replacement is complete AND checksummed.
    # A same-day re-run produces an identical $base, which the swap handles: the
    # old file is removed and the temp renamed into its place.
    local tmp="$OUTPUT_DIR/.${base}.tar.gz.tmp"
    local tmpsum="$OUTPUT_DIR/.${base}.sha256.tmp"
    rm -f "$tmp" "$tmpsum"
    # Create both mode 600 BEFORE anything writes to them. nginx autoindex omits
    # dotfiles from the listing, but it still SERVES one that is requested by
    # exact name — and the name is fully predictable from the date. Without this
    # a downloader could pull a half-written archive off the mirror. The
    # redirections below truncate these files without changing their mode; the
    # swap re-opens them to 644 once the content is real.
    ( umask 077; : > "$tmp"; : > "$tmpsum" ) \
        || { log "ERROR: cannot create work files in $OUTPUT_DIR"; return 1; }

    local level="$COMPRESS_LEVEL_PRUNED"
    [ "$NODE_TYPE" = "full" ] && level="$COMPRESS_LEVEL_FULL"

    # Deprioritise CPU *and* IO. The grin node is stopped, but nginx, the wallet
    # listener and the mining pool are all still serving from this box.
    local -a pre=()
    command -v nice   &>/dev/null && pre+=(nice -n 19)
    if command -v ionice &>/dev/null; then
        pre+=(ionice -c 3)
        local sched; sched=$(_io_scheduler "$OUTPUT_DIR") || sched=""
        case "$sched" in
            bfq|cfq) log "IO priority: idle class, honoured (scheduler: $sched)" ;;
            "")      log "IO priority: idle class requested (scheduler unknown)" ;;
            *)       log "IO priority: idle class requested but the '$sched' scheduler ignores it — expect full-speed IO" ;;
        esac
    fi

    # Keep the archive read out of the page cache. This is the cost that does not
    # show up in `top`: streaming ~20 GB through tar evicts essentially everything
    # else the box had cached, so nginx, the wallet and the pool all fall back to
    # cold disk for a long while after the run finishes. nocache marks the pages
    # dropped as it goes (posix_fadvise DONTNEED) and costs nothing when absent.
    # It wraps TAR, not the compressor: tar is the side doing the bulk reading,
    # and the compressor's output goes to a shell redirect it never opens itself,
    # so an LD_PRELOAD shim could not see that fd anyway.
    local -a rdr=("${pre[@]}")
    ensure_package nocache nocache || true
    if command -v nocache &>/dev/null; then
        rdr+=(nocache)
        log "Page cache: nocache active on the read side"
    else
        log "Page cache: nocache unavailable — the read will evict other services' cached pages"
    fi

    local cores; cores=$(nproc 2>/dev/null || echo 1)
    case "$cores" in ''|*[!0-9]*) cores=1 ;; esac
    [ "$cores" -lt 1 ] && cores=1
    # COMPRESS_THREADS caps it; anything unusable falls back to every core.
    case "$COMPRESS_THREADS" in
        ''|*[!0-9]*) : ;;
        *) if [ "$COMPRESS_THREADS" -ge 1 ] && [ "$COMPRESS_THREADS" -lt "$cores" ]; then
               cores="$COMPRESS_THREADS"
           fi ;;
    esac
    ensure_package pigz pigz || true
    local -a comp
    if command -v pigz &>/dev/null; then
        level=$(_clamp_level "$level" 0)
        comp=("${pre[@]}" pigz "-$level" -p "$cores")
        # --rsyncable resets the compressor at content-defined boundaries, so an
        # edit early in the stream does not shift every byte after it. Without
        # it, one changed block near the start makes the whole .gz differ and
        # rsync ships all ~18 GB again; with it, rsync's delta transfer finds
        # the unchanged runs. chain_data grows mostly by APPEND between builds,
        # so most of the archive genuinely is unchanged - which is the case this
        # flag is for, and the case a mirror hits every fortnight.
        #
        # It matters here and not for a browser download because rsync over ssh
        # uses delta transfer by default (only local->local implies
        # --whole-file). Costs a few % ratio, which at level 1 is noise.
        #
        # Probed, never assumed: it is a build-time option, absent from some
        # distro pigz builds, and an unknown flag makes pigz exit non-zero -
        # which would fail the whole pipeline rather than degrade.
        if pigz --help 2>&1 | grep -qi -- '--rsyncable'; then
            comp+=(--rsyncable)
            log "Compressor: pigz -$level across $cores core(s), --rsyncable (mirrors resync cheaply)"
        else
            log "Compressor: pigz -$level across $cores core(s) (no --rsyncable in this build)"
        fi
    else
        level=$(_clamp_level "$level" 1)
        comp=("${pre[@]}" gzip "-$level")
        # Debian patches --rsyncable into gzip; upstream and RHEL do not have it.
        if gzip --help 2>&1 | grep -qi -- '--rsyncable'; then
            comp+=(--rsyncable)
            log "Compressor: gzip -$level --rsyncable (pigz unavailable — single-threaded)"
        else
            log "Compressor: gzip -$level (pigz unavailable — single-threaded)"
        fi
    fi

    # "${rdr[@]}" carries nice/ionice/nocache and goes on TAR, not just the
    # compressor: tar is the process that reads the whole ~20 GB off disk, so it
    # is the one whose IO needs deprioritising.
    # Still exactly two pipeline elements — the PIPESTATUS check below indexes 0
    # and 1, so adding a third stage here would silently stop checking one of them.
    "${rdr[@]}" tar -cf - \
        --exclude="${dir_name}/lmdb/lock.mdb" \
        --exclude="${dir_name}/peer/lock.mdb" \
        "$dir_name" | "${comp[@]}" > "$tmp"
    local st=("${PIPESTATUS[@]}")
    if [ "${st[0]}" -ne 0 ] || [ "${st[1]}" -ne 0 ]; then
        rm -f "$tmp" "$tmpsum"
        log "ERROR: compression failed (tar=${st[0]} compressor=${st[1]}) — partial archive removed, published archive untouched"
        return 1
    fi

    # Hash the temp file but write the FINAL name into the checksum line. Taking
    # sha256sum's own output would record ".grin_….tar.gz.tmp", and Script 01
    # runs `sha256sum -c` against the downloaded file, so the name field has to
    # be the name the client actually has on disk.
    local hash
    hash=$(sha256sum "$tmp" 2>/dev/null | awk '{print $1; exit}')
    if [ ${#hash} -ne 64 ]; then
        rm -f "$tmp" "$tmpsum"
        log "ERROR: checksum generation failed for ${base}.tar.gz — archive discarded"
        return 1
    fi
    # Two spaces: that is sha256sum's own binary-mode separator, and `-c` will
    # not parse the line with one.
    printf '%s  %s\n' "$hash" "${base}.tar.gz" > "$tmpsum" \
        || { rm -f "$tmp" "$tmpsum"; log "ERROR: cannot write ${base}.sha256"; return 1; }

    local newsize; newsize=$(du -h "$tmp" | cut -f1)

    # ---- swap ----------------------------------------------------------------
    # Order is load-bearing. The manifest is the "ready" signal, so it is removed
    # BEFORE the file it names: its absence reads as "not ready" and clients fall
    # back to the file listing, whereas a manifest still naming an archive that
    # has just been deleted reads as READY and hands the client a 404 it reports
    # as a broken mirror. Everything after it is a rename within one directory,
    # so the window where nothing is published is a few milliseconds — not the
    # length of a compress, which clearing in step 0 would cost.
    #
    # Take the site_key lock for the swap ONLY. A remote copy holds this same
    # lock for its whole run, so a swap can never pull files out from under an
    # upload that is mid-transfer. The lock is taken here rather than around the
    # whole function on purpose: everything above wrote to .tmp files that no
    # reader looks at, so serialising the ~30 min compression would delay builds
    # behind uploads for no benefit at all.
    #
    # Released by the caller, after update_status_completed has written the
    # manifest — the swap is not complete until the "ready" signal is back.
    _SWAP_LOCKED=false
    if rc_lock_acquire "$(rc_site_key_for "$NODE_TYPE" "$NETWORK_TYPE")" 1800; then
        _SWAP_LOCKED=true
    else
        # 30 minutes is long enough that a copy is stuck, not merely slow. Block
        # the build indefinitely and a hung upload stops the archive being
        # rebuilt at all, which is worse; so swap anyway. The copy re-reads
        # generated_utc after its transfer and aborts rather than publish a set
        # that spans two builds, which is what makes proceeding here safe.
        log "WARNING: a remote copy has held the share lock for 30 min — swapping anyway."
        log "         That copy will detect the change and abort rather than publish a mixed set."
    fi

    rm -f "$OUTPUT_DIR/chaindata.json"
    local old
    for old in "$OUTPUT_DIR"/*.tar.gz "$OUTPUT_DIR"/*.sha256; do
        [ -f "$old" ] && rm -f "$old"
    done
    mv -f "$tmp" "$out" \
        || { log "ERROR: could not publish ${base}.tar.gz (built archive left at $tmp)"; return 1; }
    mv -f "$tmpsum" "$OUTPUT_DIR/${base}.sha256" \
        || { log "ERROR: could not publish ${base}.sha256"; return 1; }
    # Explicit 644: these are created under root's umask and mv preserves the
    # temp file's mode, so a tightened umask (077) would publish an archive nginx
    # cannot read — a 403 on the payload itself. Same reasoning as the manifest.
    chmod 644 "$out" "$OUTPUT_DIR/${base}.sha256" 2>/dev/null || true
    log "Archive size: $newsize"

    ARCHIVE_BASE="$base"   # consumed by write_chaindata_manifest at step 7
    create_readme "$base"
    log "Compression complete"
}

# Step 6: write README.txt with download and setup instructions
create_readme() {
    local base=$1
    local arc_setting chain_setting net_label port_info toml_block

    [ "$ARCHIVE_NODE" = true ] && arc_setting="archive_mode = true" || arc_setting="archive_mode = false"
    if [ "$NETWORK_TYPE" = "testnet" ]; then
        chain_setting='chain_type = "Testnet"'; net_label="TESTNET"; port_info="P2P Port : $GRIN_PORT_TESTNET"
    else
        chain_setting='chain_type = "Mainnet"'; net_label="MAINNET"; port_info="P2P Port : $GRIN_PORT_MAINNET"
    fi
    toml_block="   ${arc_setting}
   ${chain_setting}"

    cat > "$OUTPUT_DIR/README.txt" << EOF
Grin ${NODE_TYPE^} Node Backup - ${net_label}
Created      : $(get_utc_timestamp)
Network      : ${net_label}
Node type    : ${NODE_TYPE^^}
${port_info}
Next chain_data refresh: Undefined as the server owner will decide the cron job.
However, default config will refresh the chain_data At 00:00 on Monday and Thursday.
This Grin master node is configured automatically by the Grin Node Toolkit https://github.com/noobvie/grin-node-toolkit

===Instructions to run your grin node/wallet locally below===
Download Grin binary: https://github.com/mimblewimble/grin/releases

================================================================================
LINUX
================================================================================
1. Download  ${base}.tar.gz  and  ${base}.sha256
2. Verify    sha256sum -c ${base}.sha256
3. Extract   tar -xzf ${base}.tar.gz
4. Stop your Grin node
5. Remove old chain_data, move extracted folder in its place
6. Set in grin-server.toml:
${toml_block}
7. Start Grin node

--- Alternative: on-the-fly extraction (no .tar.gz saved locally) -------------
  Use this if disk space is tight or you want to skip the verification step.
  Streams the archive directly into tar — nothing is stored temporarily.
  SHA256 checksum verification is skipped.

  1. Stop your Grin node
  2. Remove old chain_data:  rm -rf /path/to/grin_dir/chain_data
  3. Run from your Grin node directory:
       cd /path/to/grin_dir
       wget -O - https://<this-server-url>/${base}.tar.gz | tar -xzvf -
  4. Set in grin-server.toml and start Grin node (steps 6 and 7 above)
--------------------------------------------------------------------------------

================================================================================
WINDOWS (PowerShell - tar is built-in)
================================================================================
1. Download all files to a folder
2. Verify    Get-FileHash -Algorithm SHA256 ${base}.tar.gz
             Compare with value in ${base}.sha256
3. Extract   tar -xzf ${base}.tar.gz
4. Stop Grin, replace chain_data folder
5. Edit grin-server.toml (in %USERPROFILE%\.grin\main\):
${toml_block}
6. Start Grin node

--- Alternative: on-the-fly extraction (no .tar.gz saved locally) -------------
  Use this if disk space is tight or you want to skip the verification step.
  Requires curl.exe and tar — both built into Windows 10 / 11 by default.
  Streams the archive directly into tar — nothing is stored temporarily.
  SHA256 checksum verification is skipped.

  1. Stop your Grin node
  2. Delete the old chain_data folder in Explorer or with:
       Remove-Item -Recurse -Force "$env:USERPROFILE\.grin\main\chain_data"
  3. Navigate to your Grin node directory in PowerShell, then run:
       cd "$env:USERPROFILE\.grin\main"
       curl.exe -L "https://<this-server-url>/${base}.tar.gz" | tar -xzf -
  4. Edit grin-server.toml and start Grin node (steps 5 and 6 above)
--------------------------------------------------------------------------------

================================================================================
GRIM WALLET  (https://gri.mw)
================================================================================
1. Download and verify (see Linux or Windows section above)
2. Stop Grim wallet
3. Replace chain_data in:
   Windows : %USERPROFILE%\.grim\main\
   Linux   : ~/.grim/main/
   macOS   : ~/Library/Application Support/grim/main/
4. Edit grin-server.toml in that folder:
${toml_block}
5. Start Grim - first run may take a few minutes to verify the chain

================================================================================
Notes:
  archive_mode = true  -> full node (all history, ~20 GB+)
  archive_mode = false -> pruned node (recent data, ~6 GB+)
  chain_type = "Mainnet" uses port $GRIN_PORT_MAINNET
  chain_type = "Testnet" uses port $GRIN_PORT_TESTNET
  chain_data location set by db_root in grin-server.toml

Support: https://forum.grin.mw/
EOF
    log "README.txt generated"
}

# Step 7a: publish chaindata.json — the machine-readable manifest
#
# Consumers (Script 01's mirror discovery, the Script 02 landing page) read this
# instead of scraping nginx's autoindex HTML for href="*.tar.gz".
#
# INVARIANT: the manifest exists ONLY when the archive is complete and
# downloadable. There is deliberately no "status" field — absence IS the
# not-ready signal, so a stale manifest can never disagree with a status file.
# Step 0 deletes it before anything else for the same reason.
#
# Written to a temp file and mv'd into place: mv within one filesystem is
# atomic, so a poller never observes a half-written manifest.
#
# No jq needed here — every value is script-controlled, so a heredoc is safe.
# (jq is a Script 01 dependency for READING; the sharing host may not have it.)
write_chaindata_manifest() {
    local base=$1
    local tar="$OUTPUT_DIR/${base}.tar.gz"
    [ -f "$tar" ] || { log "WARNING: $tar missing — manifest not written"; return 0; }

    local site_key size sha tmp
    case "${NODE_TYPE}_${NETWORK_TYPE}" in
        full_mainnet)   site_key="fullmain"  ;;
        pruned_mainnet) site_key="prunemain" ;;
        pruned_testnet) site_key="prunetest" ;;
        *)              site_key="${NODE_TYPE}_${NETWORK_TYPE}" ;;
    esac

    size=$(stat -c %s "$tar" 2>/dev/null || echo 0)
    # the .sha256 is "<hex>  <filename>" — take field 1
    sha=$(awk '{print $1; exit}' "$OUTPUT_DIR/${base}.sha256" 2>/dev/null || echo "")

    tmp="$OUTPUT_DIR/.chaindata.json.$$"
    cat > "$tmp" << EOF
{
  "schema": 1,
  "site_key": "${site_key}",
  "network": "${NETWORK_TYPE}",
  "node_type": "${NODE_TYPE}",
  "archive_mode": ${ARCHIVE_NODE:-false},
  "archive": "${base}.tar.gz",
  "checksum_file": "${base}.sha256",
  "sha256": "${sha}",
  "size_bytes": ${size},
  "generated_utc": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "generator": "grin-node-toolkit/03_grin_share_chain_data.sh"
}
EOF
    # 644 explicitly: the file is created under root's umask and mv preserves the
    # temp file's mode, so a tightened umask (077) would publish a manifest nginx
    # cannot read — a 403 on the one file that signals "ready".
    chmod 644 "$tmp" 2>/dev/null || true
    mv -f "$tmp" "$OUTPUT_DIR/chaindata.json" \
        || { rm -f "$tmp"; log "WARNING: could not publish chaindata.json"; return 0; }
    log "Manifest published: chaindata.json (${site_key}, ${size} bytes)"
}

# Step 7: write status file to signal download is ready
update_status_completed() {
    # manifest first, then the human status note — a consumer that sees "ready"
    # must never then fail to find the manifest it implies
    [ -n "${ARCHIVE_BASE:-}" ] && write_chaindata_manifest "$ARCHIVE_BASE"
    echo "Sync completed. You may download the ${NODE_TYPE} ${NETWORK_TYPE} archive. Verify the checksum first. Last updated: $(get_utc_timestamp)" \
        > "$STATUS_FILE"
    log "Status set: completed"
}

# Step 8: chown output dir to web server user
change_file_ownership() {
    [ -z "$FILE_OWNER" ] && return 0
    log "Step 8: Setting file ownership to $FILE_OWNER..."
    chown -R "$FILE_OWNER" "$OUTPUT_DIR" \
        && log "✓ Ownership set" \
        || log "WARNING: chown failed — run manually: chown -R $FILE_OWNER $OUTPUT_DIR"
}

# Step 9: start Grin in a tmux session
restart_grin_node() {
    log "Step 9: Restarting Grin node..."
    is_grin_running && { log "Already running — skipping"; return 0; }
    [ ! -f "$GRIN_BINARY" ] && { log "WARNING: binary not found at $GRIN_BINARY — start manually"; return 1; }

    cd "$GRIN_DIR" || error_exit "Cannot access $GRIN_DIR"
    ensure_package tmux tmux || log "WARNING: could not install tmux — start may fail"

    # Shared contract launcher (lib/grin_node_control.sh): kills any stale
    # session with this name on BOTH tmux servers, sweeps leftover grin
    # processes for this dir (lock-file protection), and starts the node AS
    # the grin user with HOME=$GRIN_DIR on grin's tmux socket (view via gtmux).
    log "Starting in tmux session '$TMUX_SESSION' (grin-owned — view via gtmux)..."
    gnc_launch_node_session "$GRIN_DIR" "$GRIN_BINARY" "$TMUX_SESSION" \
        || { log "WARNING: launch failed — start manually: cd $GRIN_DIR && su -s /bin/bash -c 'HOME=$GRIN_DIR ./grin server run' grin"; return 1; }
    sleep 5

    if is_grin_running; then
        log "✓ Grin started (PID: $(get_pid_on_port "$GRIN_PORT"))"
        log "  Attach: gtmux attach -t $TMUX_SESSION  |  Detach: Ctrl+B D  (plain 'tmux attach' won't find it)"
    else
        log "WARNING: Grin did not start within 5s — check: gtmux attach -t $TMUX_SESSION"
        return 1
    fi
}

################################################################################
# Nginx pipeline orchestration
################################################################################

# Run the full nginx share pipeline for one port (one node instance)
run_nginx_share_for_port() {
    local port=$1
    check_timezone_utc
    reset_detection_vars

    if detect_active_port "$port"; then
        detect_grin_binary
        detect_config_file
        detect_network_type
        detect_node_type
        detect_chain_data
        setup_derived_variables
        save_instance_detection          # keep conf fresh after live run
    elif ! load_instance_from_conf "$port"; then
        # Nothing listening on the port AND no usable entry in the instances conf.
        # Returning silently here would make an entire network disappear
        # from a run that otherwise reports "jobs finished" — the operator sees a
        # fresh testnet archive, no error anywhere, and no clue mainnet was
        # dropped. Say which network went and why.
        local _skip_net="mainnet"
        [ "$port" = "$GRIN_PORT_TESTNET" ] && _skip_net="testnet"
        echo "[$(date '+%Y-%m-%d %H:%M:%S UTC' -u)] SKIPPED $_skip_net: nothing listening on port $port and no usable entry in $INSTANCES_CONF (chain_data path missing or stale) — nothing was published for this network"
        return 0
    else
        setup_derived_variables          # conf loaded — still need OUTPUT_DIR etc.
    fi

    # Skip if SYNC_CHOICE excludes this network
    [ "$SYNC_CHOICE" = "mainnet" ] && [ "$NETWORK_TYPE" = "testnet" ] && \
        { echo "[$(date '+%Y-%m-%d %H:%M:%S UTC' -u)] Skipping testnet (SYNC_CHOICE=mainnet)"; return 0; }
    [ "$SYNC_CHOICE" = "testnet" ] && [ "$NETWORK_TYPE" = "mainnet" ] && \
        { echo "[$(date '+%Y-%m-%d %H:%M:%S UTC' -u)] Skipping mainnet (SYNC_CHOICE=testnet)"; return 0; }

    log "=========================================="
    log "Starting nginx share: $NETWORK_TYPE / $NODE_TYPE"
    log "=========================================="

    display_configuration
    validate_nginx_config
    preflight_disk_space || return 1
    clean_output_directory
    stop_grin_node
    remove_old_txhashset
    remove_peer_directory
    create_status_in_progress
    # Steps 5-8 are bracketed so that step 9 runs on BOTH paths. The node is
    # stopped from step 1 onward; a compress that dies here must not exit the
    # script outright and leave the node stopped until someone notices. Publishing is
    # skipped on failure — with RETAIN_PREVIOUS the previous archive is still
    # sitting there intact, so the mirror carries on serving it.
    if compress_chain_data; then
        update_status_completed
        # The swap lock is taken inside compress_chain_data, immediately before
        # the rm+mv, and released here rather than there: the manifest that
        # update_status_completed writes is the "ready" signal, so the swap is
        # not finished until it exists. Releasing earlier would let a copy start
        # during the gap and find no manifest.
        [ "${_SWAP_LOCKED:-false}" = true ] && { rc_lock_release; _SWAP_LOCKED=false; }
        change_file_ownership
    else
        [ "${_SWAP_LOCKED:-false}" = true ] && { rc_lock_release; _SWAP_LOCKED=false; }
        log "Publish skipped for this run — restarting the node and leaving the published set as it was"
        _SHARE_RC=1
    fi
    restart_grin_node

    if [ "${_SHARE_RC:-0}" -ne 0 ]; then
        log "=========================================="
        log "Nginx share FAILED: $NETWORK_TYPE / $NODE_TYPE (node restarted, previous archive left in place)"
        log "=========================================="
        _SHARE_RC=0
        return 1
    fi
    log "=========================================="
    log "Nginx share complete: $NETWORK_TYPE / $NODE_TYPE  →  $FINAL_DEST"
    log "=========================================="
}

# Try to start Grin from known directories when not found on expected port.
# Priority: (1) conf file entry, (2) toolkit default directories.
# Session name comes from _grin_session_name (lib/grin_node_control.sh):
# grin_<nodetype>_<networktype>, e.g. grin_pruned_mainnet.
try_start_from_known_dir() {
    local network=$1   # mainnet or testnet
    local port=$2

    local found_binary="" found_dir=""

    # 1) Check conf file first (respects custom install paths)
    if [[ -f "$INSTANCES_CONF" ]]; then
        # shellcheck source=/dev/null
        source "$INSTANCES_CONF" 2>/dev/null || true
        local conf_dir=""
        if [[ "$network" == "testnet" ]]; then
            conf_dir="${PRUNETEST_GRIN_DIR:-}"
        else
            conf_dir="${FULLMAIN_GRIN_DIR:-${PRUNEMAIN_GRIN_DIR:-}}"
        fi
        if [[ -n "$conf_dir" && -x "$conf_dir/grin" ]]; then
            found_dir="$conf_dir"
            found_binary="$conf_dir/grin"
            echo "  → Binary from conf: $found_binary"
        fi
    fi

    # 2) Fall back to toolkit default directories if conf had no entry
    if [[ -z "$found_binary" ]]; then
        local fallback_dirs=()
        if [[ "$network" == "testnet" ]]; then
            fallback_dirs=("/opt/grin/node/testnet-prune")
        else
            fallback_dirs=("/opt/grin/node/mainnet-full" "/opt/grin/node/mainnet-prune")
        fi
        for d in "${fallback_dirs[@]}"; do
            if [[ -x "$d/grin" ]]; then
                found_dir="$d"
                found_binary="$d/grin"
                echo "  → Binary from default path: $found_binary"
                break
            fi
        done
    fi

    if [[ -z "$found_binary" ]]; then
        echo "  ✗ No grin binary found in conf or default directories."
        echo "    Start grin manually and re-run, or verify chain_data exists first."
        return 1
    fi

    ensure_package tmux tmux || echo "  WARNING: could not install tmux — start may fail"
    # Session name convention: grin_<nodetype>_<networktype>
    local sess; sess="$(_grin_session_name "$found_dir")"

    # Shared contract launcher: stale-session kill on BOTH tmux servers +
    # leftover-process sweep + grin-owned start on grin's tmux socket. The
    # launcher sets SHELL=/bin/bash itself (this path may run from cron).
    gnc_launch_node_session "$found_dir" "$found_binary" "$sess" || true
    echo "  → Started in tmux session '$sess' (view: gtmux attach -t $sess) — waiting for port $port (up to 120s)..."

    local elapsed=0
    while [ $elapsed -lt 120 ]; do
        sleep 5; elapsed=$((elapsed + 5))
        if [ -n "$(get_pid_on_port "$port")" ]; then
            echo "  ✓ Grin $network is up after ${elapsed}s"
            return 0
        fi
        [ $((elapsed % 30)) -eq 0 ] && echo "    ... still waiting (${elapsed}s)"
    done

    echo "  ✗ Grin $network did not start within 120s"
    echo "    Start manually:  cd $found_dir && tmux attach -t $sess"
    return 1
}

# Entry point for --cron-nginx[-main|-test]  (loads nginx conf, runs selected ports)
#   $1 (optional) = "mainnet" or "testnet" — restrict to one network (per-network
#   cron job). Empty = both. Effective selection is SYNC_CHOICE (config) ∩ $1 (flag).
run_cron_nginx() {
    local only_net="${1:-}"
    if [[ ! -f "$CONF_NGINX" ]]; then
        echo "ERROR: Nginx config not found: $CONF_NGINX"
        echo "Run the script interactively and select option A first."
        exit 1
    fi
    load_nginx_config

    # Intersect config's SYNC_CHOICE with the per-network cron flag.
    local do_main=true do_test=true
    [ "$SYNC_CHOICE" = "mainnet" ] && do_test=false
    [ "$SYNC_CHOICE" = "testnet" ] && do_main=false
    [ "$only_net" = "mainnet" ]    && do_test=false
    [ "$only_net" = "testnet" ]    && do_main=false

    echo "=========================================="
    echo " Grin Share — Nginx pipeline"
    echo "=========================================="
    echo " SYNC_CHOICE: $SYNC_CHOICE${only_net:+   (cron filter: $only_net)}"
    echo ""

    local has_main=false has_test=false
    [ "$do_main" = true ] && [ -n "$(get_pid_on_port "$GRIN_PORT_MAINNET")" ] && has_main=true
    [ "$do_test" = true ] && [ -n "$(get_pid_on_port "$GRIN_PORT_TESTNET")" ] && has_test=true

    # If not running, attempt auto-start from toolkit default directories
    if [ "$do_main" = true ] && [ "$has_main" = false ]; then
        echo "  - Mainnet not running — attempting auto-start..."
        try_start_from_known_dir "mainnet" "$GRIN_PORT_MAINNET" && has_main=true
    fi
    if [ "$do_test" = true ] && [ "$has_test" = false ]; then
        echo "  - Testnet not running — attempting auto-start..."
        try_start_from_known_dir "testnet" "$GRIN_PORT_TESTNET" && has_test=true
    fi

    [ "$has_main" = false ] && [ "$has_test" = false ] && {
        echo "ERROR: No Grin node running or started for the selected network(s)."
        echo "Start grin manually, let it sync, then retry."
        exit 1
    }

    [ "$do_main" = true ] && { [ "$has_main" = true ] && echo "  ✓ Mainnet ready" || echo "  - Mainnet skipped (not running)"; }
    [ "$do_test" = true ] && { [ "$has_test" = true ] && echo "  ✓ Testnet ready" || echo "  - Testnet skipped (not running)"; }
    echo ""

    [ "$do_main" = true ] && run_nginx_share_for_port "$GRIN_PORT_MAINNET"
    [ "$do_test" = true ] && run_nginx_share_for_port "$GRIN_PORT_TESTNET"

    echo ""
    echo "=========================================="
    echo " Nginx share jobs finished"
    echo "=========================================="
}
