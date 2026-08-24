# ============================================================================
# 03_lib_remote.sh — remote copy (option C) for the chain-data share pipeline
#
# Sourced by scripts/03_grin_share_chain_data.sh. No shebang: this file is
# never executed directly.
#
# WHAT THIS MOVES: the FINISHED archive (.tar.gz + .sha256 + README + manifest)
# from a producer's local nginx web dir to one or more mirrors. It never touches
# chain_data and never stops the grin node — the node runs throughout. Do not
# confuse this with the "rsync raw chain_data" proposal in
# docs/generated/script03_design.md section 14.4, which is a different thing and
# is the only one that involves node downtime.
#
# ERREXIT: per CLAUDE.md `project_lib_errexit_suppression`, every caller reaches
# these functions through `fn || …` or `if fn; then`, which disables errexit for
# the whole body — and the parent script sets no errexit anyway. So every command
# here that creates, copies, moves or deletes carries its own guard. Do not
# assume the caller protects anything.
# ============================================================================

RC_TARGETS_CONF="${RC_TARGETS_CONF:-/opt/grin/conf/grin_share_targets.conf}"
RC_STATE_DIR="${RC_STATE_DIR:-/opt/grin/state}"
RC_LOCK_DIR="${RC_LOCK_DIR:-/opt/grin/locks}"
RC_MARKER_NAME=".grin-mirror.conf"

# Checksum verification is OFF by default — an operator decision, not an
# oversight. Reading a 17-20 GB archive twice locally is exactly the IO this
# whole redesign exists to avoid, and the wire is already covered: rsync
# checksums every file it transfers and exits non-zero if the reconstruction
# does not match, so a corrupt transfer fails the run on its own. What these
# two gates would add is protection against a source archive that was already
# corrupt on disk, and proof of what is sitting on the mirror afterwards.
# The .sha256 ships with the archive either way, so downloaders can verify.
# Set either to true to turn the corresponding read back on.
RC_VERIFY_LOCAL="${RC_VERIFY_LOCAL:-false}"
RC_VERIFY_REMOTE="${RC_VERIFY_REMOTE:-false}"

# Re-upload even when the state file says this mirror already holds the build.
RC_FORCE="${RC_FORCE:-false}"

RC_SSH_OPTS="${RC_SSH_OPTS:--o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6}"
RC_RSYNC_TIMEOUT="${RC_RSYNC_TIMEOUT:-1800}"

# Populated by rc_preflight_local for the caller to consume.
RC_ARCHIVE=""; RC_SHA_FILE=""; RC_SHA=""; RC_GENERATED=""

rc_log() {
    if declare -F log >/dev/null 2>&1; then log "$*"
    else echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*"; fi
}
rc_err() { rc_log "ERROR: $*"; }

# ---------------------------------------------------------------------------
# Site key — ONE mapping, used everywhere
# ---------------------------------------------------------------------------
# The (node_type, network) -> site_key mapping was written out separately in
# write_chaindata_manifest and in the nginx setup, and a third copy was about to
# appear here. They are what a mirror is addressed by, so a drift between copies
# sends one network's archive into another network's directory — and because
# rsync runs with --delete, that DELETES the other mirror rather than merely
# misfiling. One function, no second opinion.
rc_site_key_for() {
    local ntype="$1" net="$2"
    case "${ntype}_${net}" in
        full_mainnet)   echo "fullmain"  ;;
        pruned_mainnet) echo "prunemain" ;;
        pruned_testnet) echo "prunetest" ;;
        *)              echo "${ntype}_${net}" ;;
    esac
}

rc_site_key_valid() {
    case "$1" in fullmain|prunemain|prunetest) return 0 ;; *) return 1 ;; esac
}

# ---------------------------------------------------------------------------
# Targets file
# ---------------------------------------------------------------------------
# Line-based rather than shell variables. Two reasons: a site_key fans out to
# N mirrors, which dynamically-named vars express badly; and CLAUDE.md's
# `source` trap — a key deleted from a conf keeps resolving from the previous
# source, so a removed target would linger as a live upload destination.
#
#   site_key|alias|ssh_host|ssh_port|ssh_key|remote_dir|bwlimit_kbps|enabled
#
# alias is the operator's short name for the mirror and is unique per site_key;
# it is also what the state file is keyed by.

rc_targets_init() {
    [ -f "$RC_TARGETS_CONF" ] && return 0
    mkdir -p "$(dirname "$RC_TARGETS_CONF")" \
        || { rc_err "cannot create $(dirname "$RC_TARGETS_CONF")"; return 1; }
    cat > "$RC_TARGETS_CONF" << 'EOF'
# Grin share — remote copy targets. Managed by 03_grin_share_chain_data.sh.
# One mirror per line:
#   site_key|alias|ssh_host|ssh_port|ssh_key|remote_dir|bwlimit_kbps|enabled
# site_key is one of: fullmain prunemain prunetest
# bwlimit_kbps: 0 = unlimited (rsync --bwlimit)
EOF
    local rc=$?
    [ $rc -eq 0 ] || { rc_err "cannot write $RC_TARGETS_CONF"; return 1; }
    chmod 600 "$RC_TARGETS_CONF" 2>/dev/null || true
    return 0
}

# Emit every non-comment target line, optionally filtered by site_key.
rc_targets_list() {
    local want="${1:-}" line sk
    [ -f "$RC_TARGETS_CONF" ] || return 0
    while IFS= read -r line; do
        case "$line" in ''|\#*) continue ;; esac
        sk="${line%%|*}"
        [ -n "$want" ] && [ "$sk" != "$want" ] && continue
        printf '%s\n' "$line"
    done < "$RC_TARGETS_CONF"
}

# rc_target_field <line> <1-8>
rc_target_field() {
    printf '%s' "$1" | awk -F'|' -v n="$2" '{print $n}'
}

rc_target_valid() {
    local line="$1" sk al host port key rdir bw en
    IFS='|' read -r sk al host port key rdir bw en <<< "$line"
    rc_site_key_valid "$sk" || { rc_err "unknown site_key '$sk'"; return 1; }
    [ -n "$al" ]   || { rc_err "target has no alias"; return 1; }
    [ -n "$host" ] || { rc_err "target '$al' has no host"; return 1; }
    [ -n "$rdir" ] || { rc_err "target '$al' has no remote dir"; return 1; }
    [ -n "$key" ]  || { rc_err "target '$al' has no ssh key path"; return 1; }
    case "$port" in ''|*[!0-9]*) rc_err "target '$al' port '$port' is not numeric"; return 1 ;; esac
    case "$bw"   in ''|*[!0-9]*) rc_err "target '$al' bwlimit '$bw' is not numeric"; return 1 ;; esac
    # 'enabled' is compared against the literal true at run time, so anything else
    # silently means DISABLED. Reject it here instead, or a typo produces a mirror
    # that is configured, listed, and never updated.
    case "$en" in
        true|false) : ;;
        *) rc_err "target '$al' enabled flag must be true or false, got '$en'"; return 1 ;;
    esac
    # Shell metacharacters. rdir is interpolated into a command that runs on the
    # mirror and host/key go into ssh's argv, so a stray quote is remote command
    # execution and a leading '-' is an ssh option. The operator types these, so
    # this is not an attack surface — but a typo must not run anything.
    case "$sk$al$host$key$rdir" in
        *[\'\"\`\$\;\&\|\<\>\(\)\\]*|*[[:space:]]*)
            rc_err "target '$al' contains whitespace or a shell metacharacter — refusing"; return 1 ;;
    esac
    case "$host" in -*) rc_err "target '$al' host '$host' starts with '-' — ssh would read it as an option"; return 1 ;; esac
    case "$key"  in -*) rc_err "target '$al' key path starts with '-'"; return 1 ;; esac
    # --delete does not misfile a wrong path: it ERASES whatever is really there.
    # So the remote dir must be a per-site_key directory and never a shared parent
    # like /var/www, /srv or /usr/share/nginx/html, which hold other vhosts.
    case "$rdir" in
        /*/"$sk") : ;;
        *) rc_err "target '$al' remote dir must end in /$sk (got '$rdir')"
           rc_err "  a shared parent such as /var/www would be erased by rsync --delete"
           return 1 ;;
    esac
    case "$rdir" in
        /opt/grin/*) rc_err "target '$al' remote dir '$rdir' is inside a node directory"; return 1 ;;
    esac
    return 0
}

rc_target_exists() {
    local sk="$1" al="$2" line
    while IFS= read -r line; do
        [ "$(rc_target_field "$line" 2)" = "$al" ] && return 0
    done < <(rc_targets_list "$sk")
    return 1
}

rc_target_add() {
    local line="$1" sk al
    rc_target_valid "$line" || return 1
    sk="$(rc_target_field "$line" 1)"; al="$(rc_target_field "$line" 2)"
    rc_targets_init || return 1
    if rc_target_exists "$sk" "$al"; then
        rc_err "a target named '$al' already exists for $sk"; return 1
    fi
    printf '%s\n' "$line" >> "$RC_TARGETS_CONF" \
        || { rc_err "cannot append to $RC_TARGETS_CONF"; return 1; }
    return 0
}

rc_target_remove() {
    local sk="$1" al="$2" tmp
    # Report "nothing to remove" as a FAILURE. Returning 0 for a mirror that was
    # never there made the menu print "Removed." after a mistyped name, so an
    # operator retiring a mirror could walk away believing it was gone while it
    # was still enabled and still receiving every upload. rc_target_set_enabled
    # already refuses an unknown alias; these two must agree.
    # Both fields are required. rc_target_exists takes an empty site_key as
    # "any", so an empty one would match on the alias alone and then delete
    # nothing, since the awk below still compares $1 — a silent no-op reported
    # as success.
    [ -n "$sk" ] && [ -n "$al" ] || { rc_err "removing a mirror needs both a site_key and a name"; return 1; }
    [ -f "$RC_TARGETS_CONF" ] || { rc_err "no targets file"; return 1; }
    rc_target_exists "$sk" "$al" || { rc_err "no mirror '$al' for $sk"; return 1; }
    tmp="${RC_TARGETS_CONF}.tmp.$$"
    awk -F'|' -v sk="$sk" -v al="$al" \
        '/^#/ || $0 == "" { print; next } !($1 == sk && $2 == al) { print }' \
        "$RC_TARGETS_CONF" > "$tmp" \
        || { rm -f "$tmp"; rc_err "cannot rewrite targets file"; return 1; }
    chmod 600 "$tmp" 2>/dev/null || true
    mv -f "$tmp" "$RC_TARGETS_CONF" \
        || { rm -f "$tmp"; rc_err "cannot replace targets file"; return 1; }
    return 0
}

# Flip the enabled flag IN PLACE. The obvious implementation is remove-then-add,
# but that has no rollback: a write failure between the two steps deletes a
# mirror the operator only meant to pause. One rewrite, or nothing changes.
rc_target_set_enabled() {
    local sk="$1" al="$2" want="$3" tmp found
    case "$want" in true|false) : ;; *) rc_err "enabled must be true or false"; return 1 ;; esac
    [ -f "$RC_TARGETS_CONF" ] || { rc_err "no targets file"; return 1; }
    rc_target_exists "$sk" "$al" || { rc_err "no mirror '$al' for $sk"; return 1; }
    tmp="${RC_TARGETS_CONF}.tmp.$$"
    awk -F'|' -v OFS='|' -v sk="$sk" -v al="$al" -v want="$want" \
        '/^#/ || $0 == "" { print; next }
         ($1 == sk && $2 == al) { $8 = want } { print }' \
        "$RC_TARGETS_CONF" > "$tmp" \
        || { rm -f "$tmp"; rc_err "cannot rewrite targets file"; return 1; }
    chmod 600 "$tmp" 2>/dev/null || true
    mv -f "$tmp" "$RC_TARGETS_CONF" \
        || { rm -f "$tmp"; rc_err "cannot replace targets file"; return 1; }
    return 0
}

# ---------------------------------------------------------------------------
# Per-target state — "did last night's copy work?"
# ---------------------------------------------------------------------------
rc_state_file() { printf '%s/share_target_%s_%s.env' "$RC_STATE_DIR" "$1" "$2"; }

rc_state_get() {
    local f="$1" k="$2"
    [ -f "$f" ] || return 1
    sed -n "s/^${k}=//p" "$f" | head -1
}

# rc_state_set <file> KEY=VALUE ...
rc_state_set() {
    local f="$1"; shift
    mkdir -p "$(dirname "$f")" || { rc_err "cannot create $(dirname "$f")"; return 1; }
    local tmp="${f}.tmp.$$" kv k
    : > "$tmp" || { rc_err "cannot write $tmp"; return 1; }
    # carry forward anything not being overwritten
    if [ -f "$f" ]; then
        while IFS= read -r kv; do
            k="${kv%%=*}"
            local keep=true a
            for a in "$@"; do [ "${a%%=*}" = "$k" ] && keep=false; done
            [ "$keep" = true ] && printf '%s\n' "$kv" >> "$tmp"
        done < "$f"
    fi
    for kv in "$@"; do printf '%s\n' "$kv" >> "$tmp"; done
    mv -f "$tmp" "$f" || { rm -f "$tmp"; rc_err "cannot update state file $f"; return 1; }
    return 0
}

# ---------------------------------------------------------------------------
# Lock — the nginx pipeline and the copy must never overlap
# ---------------------------------------------------------------------------
# Without this, the copy can fire while the nginx build is mid-swap and ship a
# set that is being replaced under it. It also stops two copies of the same
# site_key overlapping, which a slow uplink makes likely at archive sizes.
#
# The two sides hold it very differently, on purpose:
#   * the COPY holds it for its whole run — it is the reader, and every file it
#     touches must stay put until it is done;
#   * the BUILD holds it only around the publish SWAP (a few seconds of rm+mv),
#     not around the ~30 min compression, which writes to .tmp files nothing
#     else looks at. Serialising the compression instead would mean an upload
#     could delay a build by hours for no benefit.
# The build waits a bounded 30 min for the lock and then proceeds anyway rather
# than stall indefinitely behind a stuck upload; rc_push_target's post-transfer
# generated_utc re-check is what covers that escape hatch.
#
# Held on fd 200. If flock is missing the work still runs — refusing to publish
# because a helper is absent would be worse than the race it prevents.
rc_lock_acquire() {
    local site_key="$1" wait_s="${2:-0}"
    command -v flock &>/dev/null || { rc_log "flock unavailable — proceeding without a lock"; return 0; }
    mkdir -p "$RC_LOCK_DIR" || { rc_err "cannot create $RC_LOCK_DIR"; return 1; }
    exec 200>"$RC_LOCK_DIR/share-${site_key}.lock" \
        || { rc_err "cannot open lock for $site_key"; return 1; }
    if [ "$wait_s" -gt 0 ]; then
        flock -w "$wait_s" 200 || { rc_err "another share job holds the $site_key lock"; return 1; }
    else
        flock -n 200 || { rc_err "another share job holds the $site_key lock — skipping"; return 1; }
    fi
    return 0
}
rc_lock_release() { exec 200>&- 2>/dev/null || true; }

# ---------------------------------------------------------------------------
# Local pre-flight — the gates that run before a single byte moves
# ---------------------------------------------------------------------------
_rc_json_str() {
    sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" 2>/dev/null | head -1
}

rc_preflight_local() {
    local site_key="$1" src="$2"
    RC_ARCHIVE=""; RC_SHA_FILE=""; RC_SHA=""; RC_GENERATED=""

    [ -d "$src" ] || { rc_err "source dir not found: $src"; return 1; }

    # 1. manifest present == the build reached step 7. Its ABSENCE is the
    #    "not ready" signal the nginx pipeline deliberately publishes, so this
    #    also covers the window where a build is mid-swap.
    local man="$src/chaindata.json"
    [ -f "$man" ] || { rc_err "no chaindata.json in $src — the build has not completed"; return 1; }

    # 2. it must describe the site_key we think we are shipping
    local man_key; man_key="$(_rc_json_str "$man" site_key)"
    if [ "$man_key" != "$site_key" ]; then
        rc_err "manifest says site_key '$man_key' but this target expects '$site_key' — refusing"
        return 1
    fi

    # 3. the human status note, as a second source for the same signal
    local status="$src/check_status_before_download.txt"
    if [ -f "$status" ]; then
        grep -q "Sync completed\." "$status" \
            || { rc_err "status note does not say the sync completed — not shipping"; return 1; }
    else
        rc_log "WARNING: no status note in $src (manifest present, continuing)"
    fi

    # 4. the files the manifest names must actually be there
    RC_ARCHIVE="$(_rc_json_str "$man" archive)"
    RC_SHA_FILE="$(_rc_json_str "$man" checksum_file)"
    RC_SHA="$(_rc_json_str "$man" sha256)"
    RC_GENERATED="$(_rc_json_str "$man" generated_utc)"
    case "$RC_ARCHIVE" in
        *.tar.gz) : ;;
        *) rc_err "manifest archive name '$RC_ARCHIVE' is not a .tar.gz"; return 1 ;;
    esac
    [ -f "$src/$RC_ARCHIVE" ]  || { rc_err "manifest names $RC_ARCHIVE but it is not in $src"; return 1; }
    [ -f "$src/$RC_SHA_FILE" ] || { rc_err "manifest names $RC_SHA_FILE but it is not in $src"; return 1; }

    # 5. optional: verify the source archive against its own .sha256. Off by
    #    default — see the RC_VERIFY_LOCAL comment at the top of this file.
    if [ "$RC_VERIFY_LOCAL" = true ]; then
        rc_log "Verifying local archive before upload (this reads the whole file)..."
        ( cd "$src" && sha256sum -c "$RC_SHA_FILE" >/dev/null 2>&1 ) \
            || { rc_err "$RC_ARCHIVE FAILED its own checksum — refusing to ship a corrupt archive"; return 1; }
        rc_log "  local checksum OK"
    fi
    return 0
}

# ---------------------------------------------------------------------------
# Remote identity — the guard that stops one network erasing another
# ---------------------------------------------------------------------------
# rsync runs with --delete, so a wrong remote_dir does not misfile an archive:
# it DELETES whatever mirror is really there. Checked before every transfer,
# never cached.
rc_remote_identity() {
    local line="$1" sk al host port key rdir bw en
    IFS='|' read -r sk al host port key rdir bw en <<< "$line"
    local ssh_c="ssh $RC_SSH_OPTS -i $key -p $port $host"

    # Ask the mirror what it thinks it is, in decreasing order of authority.
    local probe
    probe=$($ssh_c "
        if [ -f '$rdir/$RC_MARKER_NAME' ]; then
            printf 'marker '; sed -n 's/^site_key=//p' '$rdir/$RC_MARKER_NAME' | head -1
        elif [ -f '$rdir/chaindata.json' ]; then
            printf 'manifest '; sed -n 's/.*\"site_key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p' '$rdir/chaindata.json' | head -1
        elif ls '$rdir'/*.tar.gz >/dev/null 2>&1; then
            printf 'tarname '; ls '$rdir'/*.tar.gz | head -1 | xargs -n1 basename
        elif [ -d '$rdir' ]; then
            printf 'empty\n'
        else
            printf 'absent\n'
        fi" 2>/dev/null)
    local kind="${probe%% *}" val="${probe#* }"

    case "$kind" in
        marker|manifest)
            # An empty or truncated file leaves val holding the word 'marker'
            # itself (there was no space to split on). Say so, and say how to
            # clear it — otherwise the refusal reads as "this is a 'marker'
            # mirror", which names no file and suggests no fix.
            if [ -z "$val" ] || [ "$val" = "$kind" ]; then
                rc_err "REFUSING: $host:$rdir has a $kind file with no readable site_key in it"
                rc_err "  delete $rdir/$([ "$kind" = marker ] && echo "$RC_MARKER_NAME" || echo chaindata.json) on the mirror, then retry"
                return 1
            fi
            if [ "$val" = "$sk" ]; then
                rc_log "  identity OK ($kind says $val)"; return 0
            fi
            rc_err "REFUSING: $host:$rdir is a '$val' mirror, but this target is '$sk'"
            rc_err "  a transfer here would --delete that mirror's archive. Fix the remote dir."
            return 1 ;;
        tarname)
            # Same test Script 01 uses at its step 3b.
            local ok=true
            case "$sk" in
                fullmain)  echo "$val" | grep -qi full   && echo "$val" | grep -qi mainnet || ok=false ;;
                prunemain) echo "$val" | grep -qi pruned && echo "$val" | grep -qi mainnet || ok=false ;;
                prunetest) echo "$val" | grep -qi pruned && echo "$val" | grep -qi testnet || ok=false ;;
            esac
            if [ "$ok" = true ]; then
                rc_log "  identity OK (existing archive '$val' matches $sk)"; return 0
            fi
            rc_err "REFUSING: $host:$rdir holds '$val', which is not a '$sk' archive"
            return 1 ;;
        empty|absent)
            # An empty or missing directory cannot be someone else's mirror.
            rc_log "  first use of $host:$rdir — claiming it for $sk"
            return 0 ;;
        *)
            rc_err "could not read the identity of $host:$rdir (ssh failed?)"
            return 1 ;;
    esac
}

rc_write_marker() {
    local line="$1" sk al host port key rdir bw en
    IFS='|' read -r sk al host port key rdir bw en <<< "$line"
    # A dotfile on purpose: nginx autoindex hides it, and the --exclude='.*' on
    # the rsync below keeps --delete from ever removing it, so it survives every
    # publish cycle and stays authoritative.
    ssh $RC_SSH_OPTS -i "$key" -p "$port" "$host" \
        "mkdir -p '$rdir' && printf 'site_key=%s\nsource_host=%s\nfirst_seen=%s\n' \
            '$sk' '$(hostname -f 2>/dev/null || hostname)' '$(date -u '+%Y-%m-%dT%H:%M:%SZ')' \
            > '$rdir/$RC_MARKER_NAME' && chmod 600 '$rdir/$RC_MARKER_NAME'" 2>/dev/null \
        || { rc_log "WARNING: could not write the identity marker on $host"; return 1; }
    return 0
}

# ---------------------------------------------------------------------------
# Idempotence — the state check that makes the schedule offset stop mattering
# ---------------------------------------------------------------------------
# A fixed "N hours after the build" offset fires whether or not a build actually
# happened. With retention in place that failure is quiet rather than loud: the
# previous archive is still sitting there complete, so the copy would succeed and
# spend a full upload re-sending what the mirror already has. Comparing the
# manifest's generated_utc against what was last shipped makes the job a no-op in
# that case, which in turn makes it safe to run often and self-healing after a
# late or failed build.
rc_should_push() {
    local line="$1" sk al host port key rdir bw en
    IFS='|' read -r sk al host port key rdir bw en <<< "$line"

    if [ "$RC_FORCE" = true ]; then
        rc_log "  $al: forced — uploading regardless of what the state file says"
        return 0
    fi

    local sf; sf="$(rc_state_file "$sk" "$al")"
    local last; last="$(rc_state_get "$sf" last_generated_utc 2>/dev/null)" || last=""
    [ -n "$last" ] || return 0
    [ "$last" = "$RC_GENERATED" ] || return 0

    # Our state says this mirror is current. Confirm it ON THE MIRROR before
    # believing it. The state file records what we did, not what is there — a
    # mirror that was rebuilt, wiped or had its web dir cleared still has a
    # state file saying "done", and skipping on that basis is exactly how a dead
    # mirror stays dead until a human notices. One cheap ssh answers it.
    local remote_gen
    remote_gen=$(ssh $RC_SSH_OPTS -i "$key" -p "$port" "$host" \
        "sed -n 's/.*\"generated_utc\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p' '$rdir/chaindata.json' 2>/dev/null | head -1" 2>/dev/null)

    if [ "$remote_gen" = "$RC_GENERATED" ]; then
        rc_log "  $al: already holds the archive built $RC_GENERATED — nothing to do"
        return 1
    fi
    rc_log "  $al: state said current, but the mirror reports '${remote_gen:-nothing}' — uploading"
    return 0
}

# ---------------------------------------------------------------------------
# Transfer
# ---------------------------------------------------------------------------
rc_push_target() {
    local line="$1" src="$2"
    local sk al host port key rdir bw en
    IFS='|' read -r sk al host port key rdir bw en <<< "$line"
    local ssh_c=(ssh $RC_SSH_OPTS -i "$key" -p "$port" "$host")
    local sf; sf="$(rc_state_file "$sk" "$al")"
    local t0; t0=$(date +%s)

    rc_state_set "$sf" "site_key=$sk" "alias=$al" "host=$host" \
                 "last_attempt_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "last_result=running" || true

    rc_log "→ $al ($host:$rdir)"

    # Put the mirror's previous READY state back. Runs on every failure path.
    #
    # Without it, a transient rsync failure leaves a mirror that still holds a
    # complete previous archive advertised as NOT ready — and Script 01's mirror
    # discovery greps for "Sync completed.", so it skips that mirror entirely. At
    # the fullmain cadence the next attempt is a fortnight away, so one network
    # blip would take a working mirror out of rotation for up to 14 days. That is
    # the same regression the local pipeline's RETAIN_PREVIOUS exists to prevent,
    # and the mirror deserves the same rule: the published set stays valid until
    # a replacement has fully landed.
    #
    # Guarded on _rc_stashed rather than merely being harmless before the stash
    # exists. The first failure path is "ssh connection failed", and restoring
    # over a dead connection means a second full ConnectTimeout per unreachable
    # mirror — a run against several down mirrors spent its time waiting for
    # connections it already knew were refused, before it had touched anything.
    local _rc_stashed=false
    _rc_restore_remote() {
        [ "$_rc_stashed" = true ] || return 0
        "${ssh_c[@]}" "
            if [ -f '$rdir/.chaindata.json.prev' ]; then
                mv -f '$rdir/.chaindata.json.prev' '$rdir/chaindata.json'
                printf '%s\n' 'Sync completed. You may download the ${sk} archive. Verify the checksum first. (A newer archive was attempted and did not finish; the one published here is the previous complete one and stays valid.)' > '$rdir/check_status_before_download.txt'
            fi" 2>/dev/null || true
    }

    _rc_fail() {
        _rc_restore_remote
        rc_state_set "$sf" "last_result=failed" "last_error=$1" \
                     "last_finished_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')" || true
        rc_err "$al: $1"
        return 1
    }

    "${ssh_c[@]}" exit 2>/dev/null || { _rc_fail "ssh connection failed"; return 1; }

    rc_remote_identity "$line" || { _rc_fail "remote identity check refused the transfer"; return 1; }

    "${ssh_c[@]}" "mkdir -p '$rdir'" 2>/dev/null \
        || { _rc_fail "cannot create remote dir $rdir"; return 1; }

    # Remote free space. Needed BECAUSE of --delete-after: the old archive's
    # space is not reclaimed until the transfer has finished, so the mirror has
    # to hold both at once — the same arithmetic step 0a does locally.
    local need_kb avail_kb
    need_kb=$(( ( $(stat -c %s "$src/$RC_ARCHIVE" 2>/dev/null || echo 0) / 1024 ) + 262144 ))
    avail_kb=$("${ssh_c[@]}" "df -Pk '$rdir' 2>/dev/null | awk 'NR==2 {print \$4}'" 2>/dev/null)
    case "$avail_kb" in
        ''|*[!0-9]*) rc_log "  could not read remote free space — continuing" ;;
        *) if [ "$avail_kb" -lt "$need_kb" ]; then
               { _rc_fail "remote has $((avail_kb/1024)) MiB free, needs $((need_kb/1024)) MiB"; return 1; }
           fi
           rc_log "  remote free: $((avail_kb/1024)) MiB (needs $((need_kb/1024)) MiB)" ;;
    esac

    # Take the mirror out of "ready" for the duration. Removing chaindata.json
    # first is the same absence-is-not-ready rule the local pipeline follows: a
    # manifest naming an archive that is being overwritten reads as READY and
    # hands clients a partial file.
    #
    # Stash it first, so _rc_restore_remote can put the mirror back the way it
    # was if anything below fails. A dotfile, so --exclude='.*' shields it from
    # --delete and nginx autoindex does not list it.
    if "${ssh_c[@]}" "[ -f '$rdir/chaindata.json' ] && cp -f '$rdir/chaindata.json' '$rdir/.chaindata.json.prev'" 2>/dev/null; then
        _rc_stashed=true
    fi
    "${ssh_c[@]}" "rm -f '$rdir/chaindata.json'" 2>/dev/null || true
    "${ssh_c[@]}" "printf '%s\n' 'Upload in progress. DO NOT download. $(date -u '+%Y-%m-%d %H:%M:%S UTC')' > '$rdir/check_status_before_download.txt'" 2>/dev/null \
        || rc_log "  WARNING: could not write the remote status note"

    ensure_package rsync rsync >/dev/null 2>&1 || true
    command -v rsync &>/dev/null || { _rc_fail "rsync is not installed"; return 1; }

    local -a rs=(rsync -a --delete-after --partial-dir=.rsync-partial
                 --timeout="$RC_RSYNC_TIMEOUT" --info=progress2
                 --exclude='.*' --exclude='index.html' --exclude='robots.txt'
                 --exclude='sitemap.xml' --exclude='grin-logo.svg'
                 --exclude='mirrors.json' --exclude='chaindata.json')

    # Allow-list for --delete. The --exclude list above names the files we know
    # about, which protects those and nothing else: anything a mirror operator
    # put in that directory that we never thought of is still deleted, and the
    # path validation that stops us pointing at /var/www only covers the shapes
    # someone thought to enumerate.
    #
    # rsync filter rules are first-match-wins, and 'R' (risk) marks a file as
    # deletable while 'P' (protect) exempts it. So risking exactly the two
    # generated names and protecting everything else inverts the default: --delete
    # can now remove a superseded archive and its checksum, and literally nothing
    # else. A wrong remote_dir becomes a misfiling instead of an erasure.
    rs+=(--filter='R *.tar.gz' --filter='R *.sha256' --filter='P *')
    [ "${bw:-0}" -gt 0 ] 2>/dev/null && rs+=(--bwlimit="$bw")
    rs+=(-e "ssh $RC_SSH_OPTS -i $key -p $port" "$src/" "$host:$rdir/")

    rc_log "  rsync: --delete-after, resumable, ${bw:-0} KB/s cap (0 = uncapped)"
    "${rs[@]}" || { _rc_fail "rsync failed"; return 1; }

    # The producer may have swapped in a NEW archive while this transfer was
    # running. Compression takes ~30 min and an upload can take longer, so the
    # windows genuinely overlap. The swap holds this same lock, so it normally
    # waits for us — but it gives up after 30 min and proceeds rather than stall
    # the build forever, which is the case this catches. If the local manifest
    # has moved on, what we just shipped is a mixture of two builds: abort and
    # put the mirror back, rather than publish a manifest for a set that never
    # existed. The next run ships the new archive cleanly.
    local now_gen; now_gen="$(_rc_json_str "$src/chaindata.json" generated_utc)"
    if [ -n "$now_gen" ] && [ "$now_gen" != "$RC_GENERATED" ]; then
        { _rc_fail "the local archive was rebuilt mid-transfer (${RC_GENERATED} -> ${now_gen}) — not publishing a mixed set"; return 1; }
    fi

    # Optional: prove what actually landed on the mirror's disk. Off by default —
    # rsync already verifies its own transfer. Runs BEFORE the manifest is
    # published, so a bad copy is never advertised as ready.
    if [ "$RC_VERIFY_REMOTE" = true ]; then
        rc_log "  verifying the checksum on the mirror..."
        "${ssh_c[@]}" "cd '$rdir' && sha256sum -c '$RC_SHA_FILE'" >/dev/null 2>&1 \
            || { _rc_fail "the copy on the mirror FAILED its checksum — manifest not published"; return 1; }
        rc_log "  remote checksum OK"
    fi

    # Manifest last: it is the "complete" signal, so it may only appear once the
    # payload has fully landed AND verified. Temp name is per-run and a dotfile,
    # so --exclude='.*' shields it from --delete if a later run finds it.
    local rtmp="$rdir/.chaindata.json.$$"
    if scp -q $RC_SSH_OPTS -i "$key" -P "$port" "$src/chaindata.json" "$host:$rtmp" 2>/dev/null \
       && "${ssh_c[@]}" "chmod 644 '$rtmp' && mv -f '$rtmp' '$rdir/chaindata.json'" 2>/dev/null; then
        rc_log "  manifest published"
    else
        "${ssh_c[@]}" "rm -f '$rtmp'" 2>/dev/null || true
        { _rc_fail "could not publish the remote manifest"; return 1; }
    fi

    "${ssh_c[@]}" "printf '%s\n' 'Sync completed. You may download the ${sk} archive. Verify the checksum first. Last updated: $(date -u '+%Y-%m-%d %H:%M:%S UTC')' > '$rdir/check_status_before_download.txt'" 2>/dev/null \
        || rc_log "  WARNING: could not write the remote completed note"

    # The stash is only useful until the new set is live.
    "${ssh_c[@]}" "rm -f '$rdir/.chaindata.json.prev'" 2>/dev/null || true

    # No chown here. rsync -a running as root preserves the producer's 644, which
    # is all nginx needs to serve the files; the old code chowned to a hardcoded
    # www-data:www-data, which does not exist on a RHEL-family mirror and failed
    # silently into 2>/dev/null. If a mirror needs different ownership, that is
    # the mirror's business, not the producer's.

    rc_write_marker "$line" || true

    local dt=$(( $(date +%s) - t0 ))
    rc_state_set "$sf" "last_result=ok" "last_success_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
                 "last_finished_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
                 "last_generated_utc=$RC_GENERATED" "last_archive=$RC_ARCHIVE" \
                 "last_sha=$RC_SHA" "last_duration_s=$dt" "last_error=" || true
    rc_log "  done in ${dt}s"
    return 0
}

# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
# Pre-flight runs ONCE per site_key, not once per target: the gates are all
# about the local archive, so re-reading a 17 GB file for every mirror would
# multiply the one genuinely expensive check by the fan-out.
rc_run_site_key() {
    local sk="$1" src="$2" l rc=0
    local -a lines=()
    while IFS= read -r l; do
        [ "$(rc_target_field "$l" 8)" = "true" ] || continue
        lines+=("$l")
    done < <(rc_targets_list "$sk")

    if [ ${#lines[@]} -eq 0 ]; then
        rc_log "$sk: no enabled targets — skipping"
        return 0
    fi

    # Wait a minute rather than giving up instantly. The two things that can hold
    # this lock are very different: a BUILD holds it only for the publish swap —
    # a few seconds of rm+mv — so failing immediately turns a routine overlap
    # into a reported failure and a fortnight of staleness. A running COPY holds
    # it for hours, and 60s is nowhere near enough to outlast one, so that case
    # still gives up quickly, which is what it should do.
    rc_lock_acquire "$sk" 60 || return 1
    if ! rc_preflight_local "$sk" "$src"; then
        rc_lock_release
        return 1
    fi
    rc_log "$sk: $RC_ARCHIVE (built $RC_GENERATED) → ${#lines[@]} mirror(s)"

    for l in "${lines[@]}"; do
        if rc_should_push "$l"; then
            rc_push_target "$l" "$src" || rc=1
        fi
    done
    rc_lock_release
    return $rc
}

# ---------------------------------------------------------------------------
# One SSH login test, shared by every interactive test path
# ---------------------------------------------------------------------------
# There used to be two, and they disagreed. Step 3 of the SSH-access screen ran
# `ssh -i <key> -p <port> <host>` with StrictHostKeyChecking=accept-new; the
# rc_target_test below ran the same command WITHOUT it, under BatchMode=yes —
# and BatchMode cannot answer the "unknown host key" prompt. So testing a mirror
# this box had never connected to failed on the HOST KEY, discarded ssh's own
# explanation with 2>/dev/null, and printed "install the key once with
# ssh-copy-id": a wrong diagnosis for a key that was already installed, pointing
# the operator at the one step that was not the problem. One probe now serves
# both paths, so the two cannot drift apart again.
#
# accept-new is for the INTERACTIVE test only. The copy itself keeps plain
# RC_SSH_OPTS: pinning a first-contact host key is a decision a human takes here
# in front of the result, not something an unattended job does at 03:00. Neither
# path ever accepts a CHANGED key — accept-new still stops on that.
RC_SSH_TEST_OPTS="${RC_SSH_TEST_OPTS:-$RC_SSH_OPTS -o StrictHostKeyChecking=accept-new}"

# rc_ssh_login_probe <key> <port> <host>  -> RC_SSH_PROBE_OUT, rc 0/1
#
# The exact command the copy will use, and the exact one an operator should type
# by hand. Two parts of it are load-bearing:
#   -i <key>       ssh offers only the DEFAULT identity names (id_rsa, id_ecdsa,
#                  id_ed25519) when this is missing. grin_share_ed25519 is none
#                  of them, so a bare `ssh <host>` never offers the key at all
#                  and falls through to a password prompt — which reads as a
#                  failed install and invites regenerating the key, breaking
#                  every mirror that was working.
#   BatchMode=yes  removes the password fallback, so a pass here is a pass for
#                  cron. Without it, ssh would prompt and a mirror holding NO
#                  usable key could still "succeed".
RC_SSH_PROBE_OUT=""
rc_ssh_login_probe() {
    local key="$1" port="$2" host="$3" rc=0
    RC_SSH_PROBE_OUT=""
    if [ ! -f "$key" ]; then
        RC_SSH_PROBE_OUT="local key file not found: $key"
        return 1
    fi
    # 2>&1, not 2>/dev/null: ssh's own wording is the only evidence there is
    # about which of six unrelated things went wrong.
    RC_SSH_PROBE_OUT=$(ssh $RC_SSH_TEST_OPTS -i "$key" -p "$port" "$host" \
        'echo RC_SSH_OK; id -un; uname -n' 2>&1) || rc=$?
    if [ "$rc" -eq 0 ] && printf '%s' "$RC_SSH_PROBE_OUT" | grep -q RC_SSH_OK; then
        return 0
    fi
    return 1
}

# rc_ssh_explain_failure <host> <port> <key>
#
# Map ssh's wording onto the step that is actually missing. Printed with echo,
# not rc_log: this is guidance for whoever is standing at the menu, and the
# headline failure has already been logged by the caller. The colour vars are
# defaulted so this still reads correctly if the lib is ever sourced without the
# parent script's palette.
rc_ssh_explain_failure() {
    local host="$1" port="$2" key="$3" out="$RC_SSH_PROBE_OUT"
    case "$out" in
        *"local key file not found"*)
            echo -e "    ${YELLOW:-}No key on THIS server${RESET:-} — SSH access screen, step 1." ;;
        *"Host key verification failed"*|*"REMOTE HOST IDENTIFICATION HAS CHANGED"*)
            echo -e "    ${YELLOW:-}The mirror's host key is unknown or has CHANGED.${RESET:-}"
            echo -e "    ${DIM:-}Run step 3 on the SSH access screen to pin it, or if the change${RESET:-}"
            echo -e "    ${DIM:-}was expected:  ssh-keygen -R '[${host#*@}]:${port}'${RESET:-}" ;;
        *"Permission denied"*)
            echo -e "    ${YELLOW:-}The mirror answered but rejected the key.${RESET:-} In order of likelihood:"
            echo -e "    ${DIM:-}1. it is not installed for ${host%%@*} (a different user was used)${RESET:-}"
            echo -e "    ${DIM:-}2. mirror-side perms — sshd ignores authorized_keys silently unless${RESET:-}"
            echo -e "    ${DIM:-}   ~ is not group-writable, ~/.ssh is 700 and authorized_keys 600${RESET:-}"
            echo -e "    ${DIM:-}3. PubkeyAuthentication no, or AuthorizedKeysFile moved, in sshd_config${RESET:-}"
            echo -e "    ${DIM:-}install:  ssh-copy-id -i ${key}.pub -p ${port} ${host}${RESET:-}"
            echo -e "    ${DIM:-}diagnose: ssh -v -i ${key} -p ${port} ${host}${RESET:-}" ;;
        *"Connection refused"*)
            echo -e "    ${YELLOW:-}Nothing is listening on port ${port}${RESET:-} — wrong port, or sshd is down." ;;
        *"timed out"*|*"Timeout"*)
            echo -e "    ${YELLOW:-}No answer at all${RESET:-} — a firewall in between, or the wrong IP."
            echo -e "    ${DIM:-}Ask the mirror's provider about inbound port ${port}.${RESET:-}" ;;
        *"Could not resolve"*|*"Name or service not known"*)
            echo -e "    ${YELLOW:-}The hostname does not resolve${RESET:-} — check the spelling." ;;
        *)
            echo -e "    ${DIM:-}ssh said: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-160)${RESET:-}" ;;
    esac
    return 0
}

rc_target_test() {
    local line="$1" sk al host port key rdir bw en
    IFS='|' read -r sk al host port key rdir bw en <<< "$line"
    if ! rc_ssh_login_probe "$key" "$port" "$host"; then
        rc_err "$al: cannot log in to $host:$port with $key"
        rc_ssh_explain_failure "$host" "$port" "$key"
        return 1
    fi
    rc_log "$al: connection OK (remote user $(printf '%s\n' "$RC_SSH_PROBE_OUT" | sed -n 2p))"
    rc_remote_identity "$line" || return 1
    return 0
}

# ---------------------------------------------------------------------------
# Status — the "did last night's copy work?" answer, without reading logs
# ---------------------------------------------------------------------------
rc_status_table() {
    local line sk al host sf res okutc age arch now
    now=$(date +%s)
    printf "  %-10s %-10s %-24s %-9s %-7s %s\n" "SITE KEY" "MIRROR" "HOST" "LAST OK" "RESULT" "ARCHIVE"
    printf "  %-10s %-10s %-24s %-9s %-7s %s\n" "--------" "------" "----" "-------" "------" "-------"
    local any=false
    while IFS= read -r line; do
        any=true
        sk="$(rc_target_field "$line" 1)"; al="$(rc_target_field "$line" 2)"
        host="$(rc_target_field "$line" 3)"
        sf="$(rc_state_file "$sk" "$al")"
        res="$(rc_state_get "$sf" last_result 2>/dev/null)"; [ -n "$res" ] || res="never"
        okutc="$(rc_state_get "$sf" last_success_utc 2>/dev/null)" || okutc=""
        arch="$(rc_state_get "$sf" last_archive 2>/dev/null)"; [ -n "$arch" ] || arch="-"
        if [ -n "$okutc" ]; then
            local ts; ts=$(date -d "$okutc" +%s 2>/dev/null) || ts=""
            if [ -n "$ts" ]; then age="$(( (now - ts) / 86400 ))d"; else age="?"; fi
        else
            age="never"
        fi
        [ "$(rc_target_field "$line" 8)" = "true" ] || al="${al} (off)"
        printf "  %-10s %-10s %-24s %-9s %-7s %s\n" "$sk" "$al" "$host" "$age" "$res" "$arch"
    done < <(rc_targets_list)
    [ "$any" = false ] && printf "  %s\n" "(no targets configured)"
    return 0
}

# ---------------------------------------------------------------------------
# One-time migration off the old singular schema
# ---------------------------------------------------------------------------
# The pre-fan-out config held exactly one host per (net, type) in variables named
# REMOTE_HOST_<NET>_<TYPE>. Those are read here and rewritten as target lines so
# an existing setup is not silently dropped on upgrade. Runs only when no targets
# file exists yet, so it can never duplicate or overwrite hand-edited targets.
rc_migrate_legacy() {
    [ -f "$RC_TARGETS_CONF" ] && return 0
    local combo net ntype sk en host port key rdir migrated=0
    for combo in mainnet:full mainnet:pruned testnet:pruned; do
        net="${combo%%:*}"; ntype="${combo##*:}"
        local ven="SSH_ENABLE_${net^^}_${ntype^^}"
        local vh="REMOTE_HOST_${net^^}_${ntype^^}"
        local vp="REMOTE_PORT_${net^^}_${ntype^^}"
        local vk="REMOTE_SSH_KEY_${net^^}_${ntype^^}"
        local vd="REMOTE_WEB_DIR_${net^^}_${ntype^^}"
        en="${!ven:-false}"; host="${!vh:-}"; port="${!vp:-22}"
        key="${!vk:-}"; rdir="${!vd:-}"
        [ "$en" = "true" ] || continue
        [ -n "$host" ] && [ "$host" != "user@your-server" ] || continue
        sk="$(rc_site_key_for "$ntype" "$net")"
        # The legacy default for this field could compute 'prunedtest' /
        # 'prunedmain', which are not site_keys at all. Anything that is not a
        # real site_key path is replaced rather than migrated.
        case "$rdir" in
            */"$sk") : ;;
            *) rc_log "  migrating $sk: remote dir '$rdir' is not a $sk path — using /var/www/$sk"
               rdir="/var/www/$sk" ;;
        esac
        rc_targets_init || return 1
        if rc_target_add "${sk}|main|${host}|${port}|${key}|${rdir}|0|true"; then
            migrated=$((migrated+1))
        fi
    done
    [ "$migrated" -gt 0 ] && rc_log "Migrated $migrated legacy SSH target(s) into $RC_TARGETS_CONF"
    return 0
}

# ---------------------------------------------------------------------------
# Failure notification — the copy runs unattended, so silence must not read OK
# ---------------------------------------------------------------------------
# A fortnightly cron job that fails leaves a mirror stale for a fortnight, and
# the only evidence is a log nobody opens. Delivery reuses the channels the
# operator already configured in Script 082 (see lib/grin_alerts.sh for why that
# is a shared CONF rather than a shared call).
#
# Alerting is driven off the per-target state files rather than off variables
# collected during the run, so it reports what is actually true across every
# mirror — including one that failed two runs ago and has not been touched
# since, which a run-scoped summary would quietly omit.
RC_NOTIFY="${RC_NOTIFY:-true}"

rc_notify_summary() {
    [ "$RC_NOTIFY" = true ] || return 0
    declare -F galert_send >/dev/null 2>&1 || return 0

    local line sk al host sf res err bad="" n_bad=0 n_ok=0 hash prev
    local hashfile="$RC_STATE_DIR/last_notify.hash"

    while IFS= read -r line; do
        [ "$(rc_target_field "$line" 8)" = "true" ] || continue
        sk="$(rc_target_field "$line" 1)"; al="$(rc_target_field "$line" 2)"
        host="$(rc_target_field "$line" 3)"
        sf="$(rc_state_file "$sk" "$al")"
        res="$(rc_state_get "$sf" last_result 2>/dev/null)"
        case "$res" in
            failed)
                err="$(rc_state_get "$sf" last_error 2>/dev/null)"
                bad="${bad}  ${sk} / ${al} (${host}): ${err:-unknown error}
"
                n_bad=$((n_bad+1)) ;;
            ok) n_ok=$((n_ok+1)) ;;
            # 'running' means a run died without reaching either branch — a kill,
            # a reboot, an OOM. Report it: it is a failure that never got to say so.
            running)
                bad="${bad}  ${sk} / ${al} (${host}): interrupted — no result was recorded
"
                n_bad=$((n_bad+1)) ;;
        esac
    done < <(rc_targets_list)

    prev="$(cat "$hashfile" 2>/dev/null || echo '')"

    if [ "$n_bad" -eq 0 ]; then
        # Recovery is worth exactly one message, and only to someone who was
        # told about the failure in the first place.
        if [ -n "$prev" ]; then
            galert_send LOW "chain-data mirrors are healthy again" \
"All $n_ok enabled mirror(s) copied successfully.

This closes the failure reported earlier." \
                "grin-share (03)" || true
            rm -f "$hashfile" 2>/dev/null || true
        fi
        return 0
    fi

    # Re-alerting an unchanged failure every run is how an operator learns to
    # ignore the channel. Hash the failure set: a NEW or CHANGED failure speaks,
    # a standing one stays quiet until it changes or clears. Same rule 082 uses
    # for standing findings.
    hash="$(printf '%s' "$bad" | sha256sum 2>/dev/null | awk '{print $1}')"
    if [ -n "$hash" ] && [ "$hash" = "$prev" ]; then
        rc_log "alerts: same failure as last run — not re-sending"
        return 0
    fi

    if galert_send HIGH "chain-data mirror copy failed" \
"${n_bad} mirror(s) failed, ${n_ok} succeeded.

${bad}
The mirrors that failed are still serving their PREVIOUS archive — the copy
restores the old manifest rather than leaving a mirror advertised as not ready.
So this is a stale mirror, not a broken one.

Retry:  bash 03_grin_share_chain_data.sh --cron-remote
Logs:   ${LOG_DIR:-/var/log/grin-share}/remote_*.log" \
        "grin-share (03)"; then
        mkdir -p "$RC_STATE_DIR" 2>/dev/null || true
        printf '%s\n' "$hash" > "$hashfile" 2>/dev/null || true
    else
        # Nothing was delivered, so do NOT record the hash — otherwise the first
        # undeliverable alert would silence every repeat of the same failure.
        rc_log "alerts: could not deliver the failure report"
    fi
    return 0
}
