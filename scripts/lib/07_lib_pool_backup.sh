# =============================================================================
# 07_lib_pool_backup.sh — Encrypted backup / restore / schedule for the PUBLIC POOL hub
# =============================================================================
# Design §13.10c: the hub was the only money-holding product without a backup.
# Same shared engine as solo/drop (lib/grin_backup_engine.sh gbe_* + offsite
# gbp_* push): /opt/grin/backups/grin_<product>_backup_<DDMMYYYY>.tar.gz.enc,
# password = <personal_key><DDMMYYYY>, AES-256-CBC/PBKDF2-600k, fd:3.
# Product name: `pubpool` (mainnet) / `pubpooltestnet` — one archive per net per day.
#
# Backup set — everything a fresh 07 install can NOT regenerate:
#   · pool.db            balances / shares / audit — snapshotted via the SQLite
#                        online-backup API (two-phase tar; never a live WAL copy)
#   · $POOL_CONF         pool.json incl. region_ports + jwt_secret
#   · wallet dir         seed + grin-wallet.toml + api secrets + tor send dirs
#                        (grin-wallet BINARY excluded — redeployable)
#   · app dir extras     .wallet_pass, custom_assets, uploads (code + node_modules
#                        excluded — 1) Install / 9) Deploy regenerate them)
#   · WG identity        $WG_DIR_CONF/server_*.key + /etc/wireguard/wg-grinpool*.conf
#                        → restoring these means gateways never RE-PAIR (same hub
#                        key, same tunnel IPs). Whether they reconnect unaided depends
#                        on the hub's public IP — see the runbook below.
#   · nginx vhost        $POOL_NGINX_CONF (cert itself is NOT included — certbot
#                        re-issues once DNS points at the new box)
#   · games DB           $PGS_DB (grinium-games.db, design §19 (script07_design_games.md) D18) when the /play/
#                        service is installed — snapshotted like pool.db, BEST EFFORT:
#                        a missing or unreadable games DB is a warning, never a failed
#                        backup. It is NOT extracted with the rest: restore asks about it
#                        separately (pgs_restore_db_from_archive, 07_lib_pool_games.sh).
#   · TLS cert           ONLY in a Migrate OUT archive (07_lib_pool_migrate.sh sets
#                        PBK_INCLUDE_CERTS=1 for that one call): live/archive/renewal
#                        for the vhost's lineage(s) + accounts/. Daily and "Backup now"
#                        archives stay certificate-free; the cron wrapper below has
#                        its own source list and never reads the flag.
#
# Restore runbook (printed at the end of pbk_restore): fresh box → Script 01 node
# → 07 hub 1) Install → restore → grin-secret-sync → re-point DNS. Gateways then:
#   · same hub IP (rebuild in place)     → reconnect on their own;
#   · new IP, gateway paired to a DNS name (hub W → 5) with the re-resolve timer
#     (gateway 3) installs it)           → reconnect ~2–3 min after the DNS change;
#   · new IP, gateway paired to a raw IP → on EACH gateway: 2) Configure the new
#     endpoint, then 3) Bring up tunnel.
# WireGuard resolves an Endpoint only at wg-quick up, so without the timer even a
# DNS-name gateway stays on the old IP. The old hub's tunnel must also be DOWN: while
# it still handshakes, the timer sees a fresh handshake and never re-resolves.
#
# Sourced by 07_grin_mining_public_pool.sh AFTER the POOL_* constants are set;
# WG_*/pw_* are referenced at CALL time (they are defined later in the parent).
# Convention: sourced lib → NO shebang / NO `set -e`.
# =============================================================================

[[ -n "${_GRIN_POOL_BACKUP_SH_LOADED:-}" ]] && return 0
_GRIN_POOL_BACKUP_SH_LOADED=1

# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/grin_backup_engine.sh"

# ─── Constants (POOL_NET/POOL_SERVICE are set by the parent before sourcing) ──
PBK_BACKUP_DIR="${PBK_BACKUP_DIR:-/opt/grin/backups}"
if [[ "${POOL_NET:-mainnet}" == "testnet" ]]; then
    PBK_PRODUCT="pubpooltestnet"
    PBK_CONF="${PBK_CONF:-/opt/grin/conf/grin_pubpool_backup_testnet.conf}"
else
    PBK_PRODUCT="pubpool"
    PBK_CONF="${PBK_CONF:-/opt/grin/conf/grin_pubpool_backup.conf}"
fi
PBK_PREFIX="grin_${PBK_PRODUCT}_backup_"
# Wrapper/cron paths deliberately REUSE the legacy plain-backup names, so the
# existing cleanup + cron-menu code keeps matching them.
PBK_WRAPPER="${PBK_WRAPPER:-/usr/local/bin/grin-pool-backup-${POOL_NET:-mainnet}}"
PBK_CRON="${PBK_CRON:-/etc/cron.d/${POOL_SERVICE:-grin-pool-manager}-backup}"
PBK_KEEP_DEFAULT=14
PBK_LOG="${PBK_LOG:-/opt/grin/logs/pubpool-backup-${POOL_NET:-mainnet}.log}"
PBK_LE_DIR="${PBK_LE_DIR:-/etc/letsencrypt}"
# DB snapshots (07_lib_pool_dbsnap.sh): pool.db + games DB on their own frequent cron.
# The name never contains "_backup_", so no daily-archive glob, restore list, Migrate IN
# or remote day-prune can mistake one for a full archive.
PDS_PREFIX="grin_${PBK_PRODUCT}_dbsnap_"
PDS_CRON="${PDS_CRON:-/etc/cron.d/${POOL_SERVICE:-grin-pool-manager}-dbsnap}"
PDS_KEEP_DEFAULT=48
PDS_INTERVAL_DEFAULT=60
# Stamp names must NOT start with ".$PDS_PREFIX" — the wrapper deletes stale hidden temp
# files by that prefix.
PDS_STAMP="${PDS_STAMP:-$PBK_BACKUP_DIR/.dbsnap-${PBK_PRODUCT}.stamp}"
PDS_PUSH_STAMP="${PDS_PUSH_STAMP:-$PBK_BACKUP_DIR/.dbsnap-${PBK_PRODUCT}.pushed}"
# Taken by the daily run, the snapshot run and a restore, so none runs on top of another.
PBK_LOCK="${PBK_LOCK:-$PBK_BACKUP_DIR/.lock-pool-backup-${POOL_NET:-mainnet}}"
# Cert opt-in. Assigned here, NOT read from the environment, so an exported value can
# never put the TLS private key into a routine backup. pmg_migrate_out raises it with
# `local`, which bash scopes dynamically: _pbk_sources sees 1 only inside that call.
PBK_INCLUDE_CERTS=0

if ! declare -F info    >/dev/null 2>&1; then info()    { echo "[INFO]  $*"; }; fi
if ! declare -F warn    >/dev/null 2>&1; then warn()    { echo "[WARN]  $*"; }; fi
if ! declare -F error   >/dev/null 2>&1; then error()   { echo "[ERROR] $*" >&2; }; fi
if ! declare -F success >/dev/null 2>&1; then success() { echo "[OK]    $*"; }; fi
if ! declare -F _pool_pause >/dev/null 2>&1; then _pool_pause() { echo ""; echo "Press Enter to continue..."; read -r || true; }; fi

PBK_KEEP="$PBK_KEEP_DEFAULT"
PBK_HOUR=2
PBK_MIN=0
PDS_INTERVAL="$PDS_INTERVAL_DEFAULT"
PDS_KEEP="$PDS_KEEP_DEFAULT"
PDS_PUSH=1
PDS_PUSH_MIN=0

pbk_load_conf() {
    PBK_KEEP="$PBK_KEEP_DEFAULT"; PBK_HOUR=2; PBK_MIN=0
    PDS_INTERVAL="$PDS_INTERVAL_DEFAULT"; PDS_KEEP="$PDS_KEEP_DEFAULT"; PDS_PUSH=1; PDS_PUSH_MIN=0
    # shellcheck disable=SC1090
    [[ -f "$PBK_CONF" ]] && source "$PBK_CONF" 2>/dev/null
    [[ "$PBK_KEEP" =~ ^[0-9]+$ ]] || PBK_KEEP="$PBK_KEEP_DEFAULT"
    [[ "$PBK_HOUR" =~ ^[0-9]+$ ]] || PBK_HOUR=2
    [[ "$PBK_MIN"  =~ ^[0-9]+$ ]] || PBK_MIN=0
    [[ "$PDS_INTERVAL" =~ ^(15|30|60|120)$ ]] || PDS_INTERVAL="$PDS_INTERVAL_DEFAULT"
    [[ "$PDS_KEEP" =~ ^[0-9]+$ && "$PDS_KEEP" -ge 1 ]] || PDS_KEEP="$PDS_KEEP_DEFAULT"
    [[ "$PDS_PUSH" == 0 ]] || PDS_PUSH=1
    [[ "$PDS_PUSH_MIN" =~ ^[0-9]+$ ]] || PDS_PUSH_MIN=0
    gbe_load_key
}

pbk_save_conf() {
    mkdir -p "$(dirname "$PBK_CONF")" || { error "Cannot create $(dirname "$PBK_CONF")."; return 1; }
    ( umask 077; cat > "$PBK_CONF" <<EOF
# Public pool hub backup config — generated by 07_grin_mining_public_pool.sh
# Schedule/retention only. The personal key lives in the SHARED conf
# (grin_backup.conf — one key for ALL product backups).
PBK_KEEP=$PBK_KEEP
PBK_HOUR=$PBK_HOUR
PBK_MIN=$PBK_MIN
PDS_INTERVAL=$PDS_INTERVAL
PDS_KEEP=$PDS_KEEP
PDS_PUSH=$PDS_PUSH
PDS_PUSH_MIN=$PDS_PUSH_MIN
EOF
    ) || { error "Could not write $PBK_CONF."; return 1; }
    chmod 600 "$PBK_CONF"
}

# ─── Sources (resolved at call time — wallet dir/WG paths live in the parent) ─
# Echoes absolute existing paths, one per line. The wallet dir + app dir get
# their excludes in _pbk_make_tar; everything here is tarred relative to /.
_pbk_sources() {
    local s wdir
    wdir=$(pw_wallet_dir 2>/dev/null || echo "${POOL_WALLET_DIR:-}")
    {
        for s in "$POOL_APP_DIR" "$POOL_CONF" "$wdir" \
                 "${WG_DIR_CONF:-}" "${WG_CONF:-}" "${POOL_NGINX_CONF:-}"; do
            [[ -n "$s" && -e "$s" ]] && echo "$s"
        done
        if [[ "$PBK_INCLUDE_CERTS" == "1" ]]; then _pbk_cert_paths; fi
    } | sort -u
}

# Let's Encrypt material for the pool vhost — Migrate OUT only (see PBK_INCLUDE_CERTS).
# Lineage names come from the vhost's own ssl_certificate lines, so a lineage certbot
# suffixed on a re-issue (pool.example.com-0001) is the one that moves; the subdomain is
# added as a fallback for a vhost that has not been rewritten since certbot ran.
# live/<n> holds RELATIVE symlinks into archive/<n>. They are passed as directory
# members, and GNU tar stores a symlink as a symlink unless told -h/--dereference, which
# this lib never passes — so both halves travel and the links still resolve on restore.
# accounts/ goes too: renewal/<n>.conf names an ACME account by id, and without it the
# first `certbot renew` on the new box fails ~60 days after the move, silently.
_pbk_cert_paths() {
    local le="$PBK_LE_DIR" n sub=""
    local -a names=()
    if [[ -f "${POOL_NGINX_CONF:-}" ]]; then
        while IFS= read -r n; do [[ -n "$n" ]] && names+=("$n"); done < <(
            grep -oE "${le}/live/[^/[:space:];]+/" "$POOL_NGINX_CONF" 2>/dev/null \
                | sed -E "s|^${le}/live/||; s|/\$||" | sort -u)
    fi
    if declare -F pool_read_conf >/dev/null 2>&1; then sub=$(pool_read_conf "subdomain" ""); fi
    [[ -n "$sub" ]] && names+=("$sub")
    local any=0
    for n in "${names[@]}"; do
        [[ "$n" =~ ^[A-Za-z0-9.-]+$ ]] || continue   # a lineage is a hostname; anything else is not ours
        [[ -d "$le/live/$n" ]] || continue
        echo "$le/live/$n"
        [[ -d "$le/archive/$n" ]]      && echo "$le/archive/$n"
        [[ -f "$le/renewal/$n.conf" ]] && echo "$le/renewal/$n.conf"
        any=1
    done
    if [[ "$any" -eq 1 && -d "$le/accounts" ]]; then echo "$le/accounts"; fi
}

# ─── Payout freeze — the ONE writer of payout_control for restore AND migration ─
# pbk_freeze_payouts <pool.db> <reason> <frozen_by>. rc 0 only when the row reads back
# frozen=1. Shared so the restore and Migrate OUT paths cannot drift: both depend on the
# same persisted flag being in the DB that the next service start reads (audit §J17-2).
# busy_timeout because Migrate OUT writes this while the service is still RUNNING (the
# freeze must land before the stop); the scheduler re-reads the row every loop, so the
# freeze takes effect on the live process without a restart.
pbk_freeze_payouts() {
    local db="$1" reason="$2" by="$3"
    [[ -f "$db" ]] || { error "No pool.db at $db — nothing to freeze."; return 1; }
    node -e "
const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync(process.argv[1]);
d.exec('PRAGMA busy_timeout = 15000');
d.exec('CREATE TABLE IF NOT EXISTS payout_control (id INTEGER PRIMARY KEY CHECK (id = 1), frozen INTEGER NOT NULL DEFAULT 0, reason TEXT DEFAULT NULL, frozen_by TEXT DEFAULT NULL, frozen_at INTEGER DEFAULT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))');
d.prepare(\"INSERT INTO payout_control (id, frozen, reason, frozen_by, frozen_at, updated_at) VALUES (1, 1, ?, ?, unixepoch(), unixepoch()) ON CONFLICT(id) DO UPDATE SET frozen = 1, reason = excluded.reason, frozen_by = excluded.frozen_by, frozen_at = excluded.frozen_at, updated_at = excluded.updated_at\").run(process.argv[2], process.argv[3]);
const r = d.prepare('SELECT frozen FROM payout_control WHERE id = 1').get();
d.close();
process.exit(r && r.frozen === 1 ? 0 : 1);
" "$db" "$reason" "$by" 2>/dev/null
}

# ─── Stratum pause — a restored pool.db boots NOT accepting miners (design §21.13 Q1) ─
# pbk_pause_stratum <pool.db> <reason> <paused_by>. Writes the single stratum_control row the
# pool's lib/stratum-pause.js load() reads BEFORE the stratum server binds anything, so the
# next service start opens no listener until the operator resumes it in admin → Announcements
# → Stratum — or it auto-resumes at `until` (now + PBK_STRATUM_PAUSE_S). Why: a restored or
# migrated ledger must be checked before it acks a share it may not be able to credit.
# The DDL is lib/db.js's VERBATIM (one line here) — change one, change both; the test
# test-stratum-pause-restore.js compares them. `until` is ALWAYS written (load() would cap a
# NULL one at boot+2 h, but the row must say what the operator was told). settled_at = now:
# the service is stopped, so nothing is in flight. planned_* (a scheduled window) is kept —
# it is the operator's own plan and load()/evaluate() handle it; last_result is cleared (it
# describes the OLD process's binds). source/by/reason travel as argv, so the JS carries no
# single quote and stays in a single-quoted node -e (the test extracts it from this file).
# MUST run while the service is STOPPED (a running pool holds the row in memory and its next
# write would overwrite this one) and BEFORE the de-root sweep — this read-write open as root
# creates the WAL sidecars. Prints the `until` (unix s) on stdout; rc 0 only when the row
# reads back paused with that `until` in the future.
PBK_STRATUM_PAUSE_S="${PBK_STRATUM_PAUSE_S:-7200}"
pbk_pause_stratum() {
    local db="$1" reason="$2" by="$3"
    [[ -f "$db" ]] || { error "No pool.db at $db — cannot pause stratum."; return 1; }
    node -e '
const { DatabaseSync } = require("node:sqlite");
const [db, reason, by, secs] = process.argv.slice(1);
if (!/^[1-9][0-9]*$/.test(secs || "")) process.exit(1);
const d = new DatabaseSync(db);
d.exec("PRAGMA busy_timeout = 15000");
d.exec("CREATE TABLE IF NOT EXISTS stratum_control (id INTEGER PRIMARY KEY CHECK (id = 1), paused INTEGER NOT NULL DEFAULT 0, source TEXT DEFAULT NULL, reason TEXT DEFAULT NULL, paused_by TEXT DEFAULT NULL, since INTEGER DEFAULT NULL, settled_at INTEGER DEFAULT NULL, until INTEGER DEFAULT NULL, planned_start INTEGER DEFAULT NULL, planned_end INTEGER DEFAULT NULL, planned_reason TEXT DEFAULT NULL, planned_by TEXT DEFAULT NULL, last_result TEXT DEFAULT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))");
const now = Math.floor(Date.now() / 1000);
const until = now + Number(secs);
d.prepare("INSERT INTO stratum_control (id, paused, source, reason, paused_by, since, settled_at, until, last_result, updated_at) VALUES (1, 1, ?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT(id) DO UPDATE SET paused = 1, source = excluded.source, reason = excluded.reason, paused_by = excluded.paused_by, since = excluded.since, settled_at = excluded.settled_at, until = excluded.until, last_result = NULL, updated_at = excluded.updated_at").run("restore", reason, by, now, now, until, now);
const r = d.prepare("SELECT paused, until FROM stratum_control WHERE id = 1").get();
d.close();
if (!r || r.paused !== 1 || r.until !== until || !(until > now)) process.exit(1);
process.stdout.write(String(until));
' "$db" "$reason" "$by" "$PBK_STRATUM_PAUSE_S" 2>/dev/null
}

# Human UTC time for a unix-seconds value (empty in → empty out).
_pbk_utc() {
    if [[ -n "${1:-}" ]]; then date -u -d "@$1" '+%Y-%m-%d %H:%M UTC' 2>/dev/null || echo "@$1"; fi
}

# Backend CODE at the top of the app dir. lib/, admin-panel/, scripts/ and node_modules/ were
# always excluded, but these three were not, so a restore put the ARCHIVE's index.js and
# package files next to THIS box's lib/ — two code versions in one app, silently (security audit, hub-move review
# C3: an older daily backup restored after a deploy, or a Migrate IN onto a box installed from
# a newer checkout). Code comes from 1) Install / 9) Deploy, never from an archive: excluded
# when an archive is made AND when one is extracted, so archives made before this change
# cannot bring it back either. The cron wrapper below carries the same names.
# routes/ is the same kind of code: since the 2026-10 code-layout refactor index.js registers
# its HTTP routes from routes/, so an archive's routes/ beside this box's index.js is C3 again.
# A directory name here excludes everything under it, on create and on extract alike.
_pbk_code_excludes() {
    local f
    for f in index.js package.json package-lock.json routes; do
        printf -- '--exclude=%s\n' "${POOL_APP_DIR#/}/$f"
    done
}

# ─── Two-phase tar (live pass excludes *.db*; pool.db appended from a snapshot) ─
# $1 = output .tar.gz. Same pattern as 059: a global *.db exclude on the live
# pass cannot strip the staged snapshot because it is appended in a second call.
# rc 0 ok · 1 tar reported an error (lenient callers may accept it) · 2 pool.db EXISTS
# but could not be put in the archive — always fatal: an archive without the ledger looks
# like a backup and restores no balances (security audit, hub-move review C5).
_pbk_make_tar() {
    local outgz="$1"
    local work; work=$(mktemp /tmp/grin_pubpool_bakwork_XXXXXX.tar 2>/dev/null) || return 1

    local db="$POOL_APP_DIR/pool.db" stage="" dbrel=""
    if [[ -f "$db" ]]; then
        dbrel="${db#/}"
        stage=$(mktemp -d /tmp/grin_pubpool_dbsnap_XXXXXX 2>/dev/null) \
            || { rm -f "$work"; error "Could not create a staging dir for the pool.db snapshot (/tmp full?)."; return 2; }
        if ! mkdir -p "$stage/$(dirname "$dbrel")" || ! gbe_snapshot_db "$db" "$stage/$dbrel" \
           || [[ ! -s "$stage/$dbrel" ]]; then
            rm -rf "$stage"; rm -f "$work"
            error "Could not snapshot $db — the archive would carry no balances."
            return 2
        fi
    fi

    # Games DB (design §19 (script07_design_games.md) D18) — same two-phase snapshot, but best effort: any problem is a
    # warning and the archive simply carries no games data. Never rc 2, never fatal.
    local gdbrel=""
    if [[ -n "${PGS_DB:-}" && -f "$PGS_DB" ]] && declare -F pgs_snapshot_db >/dev/null 2>&1; then
        if [[ -z "$stage" ]]; then stage=$(mktemp -d /tmp/grin_pubpool_dbsnap_XXXXXX 2>/dev/null) || stage=""; fi
        if [[ -n "$stage" ]] && pgs_snapshot_db "$stage/${PGS_DB#/}"; then
            gdbrel="${PGS_DB#/}"
        else
            warn "Could not snapshot the games DB ($PGS_DB) — this archive carries no games data."
        fi
    fi

    local -a live_rels=(); local s
    while IFS= read -r s; do live_rels+=("${s#/}"); done < <(_pbk_sources)

    local wdir; wdir=$(pw_wallet_dir 2>/dev/null || echo "${POOL_WALLET_DIR:-/nonexistent}")
    local -a ex=(
        --exclude="${wdir#/}/grin-wallet"
        --exclude="*/node_modules"
        --exclude="${POOL_APP_DIR#/}/lib"
        --exclude="${POOL_APP_DIR#/}/admin-panel"
        --exclude="${POOL_APP_DIR#/}/scripts"
        --exclude="*.log"
        --exclude="*.db"
        --exclude="*.db-wal"
        --exclude="*.db-shm"
        --exclude="*.db-journal"
        --exclude="*.pre-restore-*"
    )
    local x
    while IFS= read -r x; do ex+=("$x"); done < <(_pbk_code_excludes)

    local rc=0
    if [[ "${#live_rels[@]}" -gt 0 ]]; then
        tar -cf "$work" "${ex[@]}" -C / "${live_rels[@]}" 2>/dev/null
        rc=$?
    else
        rc=1
    fi
    if [[ -n "$stage" && -n "$dbrel" ]]; then
        if [[ ! -f "$work" ]] || ! tar -rf "$work" -C "$stage" "$dbrel" 2>/dev/null; then
            rm -rf "$stage"; rm -f "$work"
            error "Could not append the pool.db snapshot to the archive."
            return 2
        fi
    fi
    if [[ -n "$gdbrel" && -f "$work" ]]; then
        tar -rf "$work" -C "$stage" "$gdbrel" 2>/dev/null \
            || warn "Could not append the games DB snapshot — this archive carries no games data."
    fi
    [[ -n "$stage" ]] && rm -rf "$stage"

    if [[ ! -f "$work" ]]; then rm -f "$work"; return 1; fi
    if ! gzip -c "$work" > "$outgz" 2>/dev/null; then rm -f "$work"; return 1; fi
    rm -f "$work"
    return $rc
}

pbk_prune() { gbe_prune_count "$PBK_PRODUCT" "${1:-$PBK_KEEP}" "$PBK_BACKUP_DIR"; }

# ─── Archive core (non-interactive) — shared by Backup now and Migrate OUT ────
# tar → encrypt → offsite push; sets $GBE_ARCHIVE. The caller has already loaded
# the key (gbe_require_key). $1 = strict: 1 turns a tar warning into a failure.
# Backup now keeps it lenient (a file changing under a RUNNING pool is normal);
# Migrate OUT is strict, because everything is stopped by then and a partial
# archive is the one thing a move cannot recover from.
_pbk_build_archive() {
    local strict="${1:-0}" tmp_gz
    tmp_gz=$(mktemp "/tmp/grin_pubpool_bak_XXXXXX.tar.gz") || { error "mktemp failed."; return 1; }
    info "Creating archive..."
    local trc=0
    _pbk_make_tar "$tmp_gz" || trc=$?
    if [[ "$trc" -eq 2 ]]; then   # pool.db could not go in: fatal in BOTH modes
        rm -f "$tmp_gz"
        error "pool.db (every balance) is not in the archive — nothing was encrypted."
        return 1
    fi
    if [[ "$trc" -ne 0 ]]; then
        if [[ "$strict" == "1" ]]; then
            rm -f "$tmp_gz"
            error "tar reported an error while building the archive — nothing was encrypted."
            return 1
        fi
        warn "tar reported issues (a file changed mid-read, or a missing optional path — usually harmless)."
    fi
    gbe_finalize_archive "$PBK_PRODUCT" "$tmp_gz" "$PBK_BACKUP_DIR" || return 1
}

# ─── Backup now (interactive) ────────────────────────────────────────────────
pbk_backup_now() {
    echo -e "\n${BOLD}Pool hub backup — ${POOL_NET_LABEL:-$POOL_NET}${RESET}"
    command -v openssl >/dev/null 2>&1 || { error "openssl not found — cannot encrypt."; return 1; }
    pbk_load_conf

    local -a srcs=(); local s
    while IFS= read -r s; do srcs+=("$s"); done < <(_pbk_sources)
    if [[ "${#srcs[@]}" -eq 0 ]]; then
        warn "Nothing to back up yet — run 1) Install (and 5) Set up wallet) first."
        return 1
    fi
    echo -e "  ${DIM}Will archive (pool.db snapshot + config + wallet seed/secrets + WG identity;${RESET}"
    echo -e "  ${DIM}redeployable code/node_modules/binary excluded):${RESET}"
    for s in "${srcs[@]}"; do echo -e "    ${DIM}$s${RESET}"; done
    echo ""

    gbe_require_key || { info "Backup needs a personal key."; return 1; }

    # Under the lock: the daily cron would otherwise race this for today's archive name.
    _pbk_locked _pbk_build_archive 0 || return 1

    echo -e "  ${YELLOW}This archive contains the wallet seed AND the hub WireGuard private key —${RESET}"
    echo -e "  ${YELLOW}anyone with the file + your key can spend and impersonate the hub.${RESET}"
    mkdir -p "$(dirname "$PBK_LOG")"
    echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] backup created: $(basename "$GBE_ARCHIVE")" >> "$PBK_LOG" 2>/dev/null || true
    pbk_prune "$PBK_KEEP"
}

# ─── Restore core (non-interactive) — shared by Restore and Migrate IN ────────
# _pbk_restore_extract <decrypted.tar.gz> <freeze reason> <frozen_by>
# Stops the pool + wallet listener, extracts to the original paths and FREEZES payouts on
# the restored ledger. ONE implementation so the restore and the migration can never
# disagree on what a restore leaves behind — above all on the freeze. The caller owns the
# input file and every message about the outcome, then MUST call _pbk_restore_perms (kept
# separate only so each caller can print its freeze verdict before the sweep's output).
# rc 0 = extracted + frozen · 1 = extraction failed · 2 = extracted, freeze FAILED — never
# start the service on this · 3 = no pool.db in the archive (the one that was here is back,
# and frozen) · 4 = nothing extracted (backup lock busy, or the old pool.db set could not be
# moved aside). PBK_EXTRACT_FROZEN = 1 when payouts on the pool.db now in place are frozen (set on EVERY path, rc 1 included), else 0.
# It also PAUSES STRATUM on that pool.db (design §21.13 Q1): PBK_EXTRACT_PAUSED = 1 and
# PBK_EXTRACT_PAUSE_UNTIL = <unix s> when it took, else 0 / "". A failed pause NEVER changes
# rc — an open stratum is not a money loss the way live payouts are; callers warn loudly
# (_pbk_report_stratum_pause) and the restore stands.
# Optional 4th+ args name the ONLY members to extract (a DB-snapshot restore passes pool.db).
# Before extracting, the pool.db in place moves aside WITH its -wal/-shm, as one set, to
# pool.db.pre-restore-<UTC time> (PBK_EXTRACT_ASIDE). A leftover -wal beside the restored
# file would be replayed into it by SQLite on the next open — frames of a different
# database, i.e. corruption — and the set kept whole is the old ledger, intact.
# Runs holding $PBK_LOCK, so a scheduled backup never reads a half-extracted pool.db.
_pbk_restore_extract() {
    # Set here, not only inside the locked body: when the lock cannot be taken the callers
    # still read these (under set -u), and "nothing touched" must read as not frozen.
    PBK_EXTRACT_FROZEN=0; PBK_EXTRACT_PAUSED=0; PBK_EXTRACT_PAUSE_UNTIL=""; PBK_EXTRACT_ASIDE=""
    _pbk_locked _pbk_restore_extract_locked "$@"
}

# _pbk_locked <fn> [args…] — run fn in THIS shell (its globals survive) holding $PBK_LOCK.
# Waits up to 10 min for a scheduled run to finish; the fd is closed on every path.
# rc 4 = the lock was not taken and fn never ran (nothing changed); else fn's rc.
_pbk_locked() {
    local rc=0 fd
    mkdir -p "$(dirname "$PBK_LOCK")" 2>/dev/null || true
    if ! exec {fd}>>"$PBK_LOCK"; then error "Cannot open the backup lock $PBK_LOCK — nothing changed."; return 4; fi
    if command -v flock >/dev/null 2>&1 && ! flock -w 600 "$fd"; then
        exec {fd}>&-
        error "A scheduled pool backup still holds $PBK_LOCK after 10 min — nothing changed. Try again."
        return 4
    fi
    "$@" || rc=$?
    exec {fd}>&-
    return "$rc"
}

# Puts the set moved aside by _pbk_restore_extract_locked back in place (no pool.db came
# out of the archive). Clears PBK_EXTRACT_ASIDE when it worked.
_pbk_unaside_db() {
    local db="$POOL_APP_DIR/pool.db" a="${PBK_EXTRACT_ASIDE:-}" x
    [[ -n "$a" && -f "$a" ]] || return 0
    if ! mv "$a" "$db"; then error "Could not move $a back to $db."; return 1; fi
    for x in wal shm; do
        if [[ -e "$a-$x" ]]; then mv "$a-$x" "$db-$x" || warn "Could not move $a-$x back."; fi
    done
    PBK_EXTRACT_ASIDE=""
    info "No pool.db came out of the archive — the one that was in place is back."
}

_pbk_restore_extract_locked() {
    local clear="$1" reason="$2" by="$3" rc=0 x
    shift 3
    local -a members=("$@")
    local -a ex=()
    PBK_EXTRACT_FROZEN=0
    PBK_EXTRACT_PAUSED=0
    PBK_EXTRACT_PAUSE_UNTIL=""
    PBK_EXTRACT_ASIDE=""
    systemctl stop "$POOL_SERVICE" 2>/dev/null || true
    if declare -F pw_listener_stop >/dev/null 2>&1; then pw_listener_stop 2>/dev/null || true; fi

    local db="$POOL_APP_DIR/pool.db" aside
    if [[ -f "$db" ]]; then
        aside="$db.pre-restore-$(date -u +%Y%m%d_%H%M%S)"
        if ! mv "$db" "$aside"; then
            error "Could not move the current pool.db aside — nothing extracted."
            return 1
        fi
        PBK_EXTRACT_ASIDE="$aside"
        for x in wal shm; do
            if [[ -e "$db-$x" ]]; then
                if ! mv "$db-$x" "$aside-$x"; then
                    # Extracting now would leave this sidecar beside the restored file, and
                    # SQLite would replay it into it. Put everything back and stop.
                    error "Could not move $db-$x aside — nothing extracted; the pool.db set is back in place."
                    _pbk_unaside_db >/dev/null
                    return 4
                fi
            fi
        done
    fi

    while IFS= read -r x; do ex+=("$x"); done < <(_pbk_code_excludes)
    # The games DB is never extracted here: the games service may be running on it, and
    # the operator is asked separately (D18) — pgs_restore_db_from_archive, called by both
    # callers after this, stops the games, moves stale sidecars aside and places it.
    if [[ -n "${PGS_DB:-}" ]]; then ex+=("--exclude=${PGS_DB#/}"); fi
    if ! tar -xzf "$clear" -C / "${ex[@]}" --preserve-permissions "${members[@]}" 2>/dev/null; then
        # A FAILED extraction is a partial one: the wallet dir may already be the archive's
        # while pool.db (appended LAST, so usually the last member written) is still the old
        # one, or half-written. Whatever pool.db is there now gets frozen too, so neither 2)
        # Restore nor Migrate IN leaves payouts live on a mixed state (security audit, hub-move review C4).
        # pool.db never written (it is the last member) → the old ledger goes back, and is frozen.
        if [[ ! -f "$db" ]]; then _pbk_unaside_db; fi
        if [[ -f "$POOL_APP_DIR/pool.db" ]] && pbk_freeze_payouts "$POOL_APP_DIR/pool.db" "$reason" "$by"; then
            PBK_EXTRACT_FROZEN=1
        fi
        _pbk_restore_pause_stratum
        return 1
    fi
    # An archive without pool.db must not leave the box with none at all: the old ledger goes
    # back, is frozen like any restored one, and the rc says no ledger came from the archive.
    local got_db=1
    if [[ ! -f "$db" ]]; then got_db=0; _pbk_unaside_db; fi

    # ── FREEZE PAYOUTS on the restored ledger (audit §J17-2) ────────────────────
    # A restore rewinds pool.db to the snapshot. The CHAIN and the WALLET do not rewind with
    # it, so every payout that settled after the snapshot comes back as an owed balance the
    # wallet has already spent — and the withdrawal scheduler starts at index.js:595, roughly
    # 170 lines and several subsystem inits BEFORE the AlertMonitor at index.js:766 whose
    # coverage_shortfall check is what would auto-freeze. Its first loop pass sends. Freezing
    # here makes the restored ledger inert until a human has reconciled it: payout_control is
    # a persisted table, so the flag rides in the restored DB itself and survives the restart.
    # Written BEFORE pool_deroot below so the WAL sidecars this read-write open creates get
    # chowned back to the service user with everything else (§J16-8's trap, in reverse).
    # Written BEFORE the caller's _pbk_restore_perms, so the sidecars this open creates
    # are swept back to the service user with everything else.
    if [[ -f "$POOL_APP_DIR/pool.db" ]]; then
        if pbk_freeze_payouts "$POOL_APP_DIR/pool.db" "$reason" "$by"; then PBK_EXTRACT_FROZEN=1; else rc=2; fi
        # Same moment and the same reason to be here (before the de-root sweep): the pool
        # must come up NOT accepting miners on a ledger nobody has checked yet.
        _pbk_restore_pause_stratum
    else
        rc=3
    fi
    if [[ "$got_db" -eq 0 && "$rc" -eq 0 ]]; then rc=3; fi
    return "$rc"
}

# Sets PBK_EXTRACT_PAUSED / PBK_EXTRACT_PAUSE_UNTIL for whatever pool.db is in place now.
# Reason + paused_by are fixed: the restore core serves 2) Restore and Migrate IN alike.
_pbk_restore_pause_stratum() {
    local u=""
    [[ -f "$POOL_APP_DIR/pool.db" ]] || return 0
    if u=$(pbk_pause_stratum "$POOL_APP_DIR/pool.db" \
            'pool.db restored (restore / Migrate IN) — check the pool, then Resume' 'system:restore') \
            && [[ "$u" =~ ^[0-9]+$ ]]; then
        PBK_EXTRACT_PAUSED=1
        PBK_EXTRACT_PAUSE_UNTIL="$u"
    fi
    return 0
}

# The operator's message for that pause — the SAME words after 2) Restore and Migrate IN.
_pbk_report_stratum_pause() {
    if [[ "${PBK_EXTRACT_PAUSED:-0}" == "1" ]]; then
        warn "Stratum PAUSED on the restored pool.db until $(_pbk_utc "$PBK_EXTRACT_PAUSE_UNTIL") ($(( PBK_STRATUM_PAUSE_S / 60 )) min from now)."
        echo -e "  ${DIM}The pool will start NOT accepting miners. Check the pool, then Resume in${RESET}"
        echo -e "  ${DIM}admin → Announcements → Stratum (or it resumes on its own at that time — a pool${RESET}"
        echo -e "  ${DIM}started AFTER it boots accepting: pause it there first if you are not ready).${RESET}"
    else
        error "Could NOT pause stratum on the restored pool.db — stratum will OPEN on start."
        echo -e "  ${DIM}Miners will be accepted on a ledger nobody has checked. Once the pool is up,${RESET}"
        echo -e "  ${DIM}pause it at once in admin → Announcements → Stratum, check it, then resume.${RESET}"
    fi
}

# Perms: tar extracts as root — re-assert the de-rooted ownership (§13.9) and
# the secret modes. pool_deroot is the canonical sweep when available.
_pbk_restore_perms() {
    if declare -F pool_deroot >/dev/null 2>&1; then
        pw_pin_reset || true
        pool_deroot || true
    fi
    chmod 600 "$POOL_CONF" 2>/dev/null || true
    chmod 600 /etc/wireguard/wg-grinpool*.conf 2>/dev/null || true
}

# ─── Restore (interactive) ───────────────────────────────────────────────────
pbk_restore() {
    echo -e "\n${BOLD}Pool hub restore — ${POOL_NET_LABEL:-$POOL_NET}${RESET}"
    command -v openssl >/dev/null 2>&1 || { error "openssl not found — cannot decrypt."; return 1; }
    mkdir -p "$PBK_BACKUP_DIR" 2>/dev/null || true

    echo -e "  ${DIM}Disaster-recovery order on a FRESH box (design §13.10c): Script 01 node →${RESET}"
    echo -e "  ${DIM}07 hub 1) Install → THIS restore → grin-secret-sync → re-point DNS →${RESET}"
    echo -e "  ${DIM}gateways reconnect with no re-pairing (a NEW hub IP: see the steps printed at the end).${RESET}"
    echo ""

    local -a baks=(); local f
    while IFS= read -r f; do [[ -n "$f" ]] && baks+=("$f"); done \
        < <(ls -t "$PBK_BACKUP_DIR/${PBK_PREFIX}"*.tar.gz.enc 2>/dev/null || true)
    if [[ "${#baks[@]}" -eq 0 ]]; then
        warn "No ${PBK_PREFIX}* backups in $PBK_BACKUP_DIR — copy one there first (scp/rsync)."
        return 1
    fi
    echo -e "  ${BOLD}Available backups (newest first):${RESET}"
    local i=1 sz
    for f in "${baks[@]}"; do
        sz=$(du -sh "$f" 2>/dev/null | cut -f1 || echo "?")
        echo -e "  ${GREEN}$i${RESET}) $(basename "$f")  ${DIM}($sz)${RESET}"
        (( i++ ))
    done
    echo -e "  ${DIM}0) Cancel${RESET}"
    echo -ne "${BOLD}Select backup [1-${#baks[@]}/0]: ${RESET}"
    local sel; read -r sel || true
    [[ "$sel" =~ ^[0-9]+$ && "$sel" -ge 1 && "$sel" -le "${#baks[@]}" ]] || { info "Cancelled."; return 1; }
    local chosen="${baks[$((sel-1))]}"

    local d; d=$(gbe_parse_date "$chosen") || { error "Cannot read date from filename."; return 1; }
    local key pass tmp_clear
    read -rs -p "  Personal key for this backup: " key; echo ""
    [[ -z "$key" ]] && { warn "No key entered."; return 1; }
    pass="${key}${d}"; unset key
    tmp_clear=$(mktemp "/tmp/grin_pubpool_restore_XXXXXX.tar.gz") || { unset pass; return 1; }
    if ! gbe_decrypt "$chosen" "$tmp_clear" "$pass"; then
        rm -f "$tmp_clear"; unset pass
        error "Wrong key or corrupt backup."; return 1
    fi
    unset pass
    tar -tzf "$tmp_clear" >/dev/null 2>&1 || { rm -f "$tmp_clear"; error "Decrypted file is not a valid archive."; return 1; }
    success "Decrypted and validated."

    echo ""
    echo -e "  ${RED}${BOLD}This OVERWRITES current files at their original paths:${RESET}"
    tar -tzf "$tmp_clear" 2>/dev/null | awk -F/ 'NF>=3{print "/"$1"/"$2"/"$3}' | sort -u | sed 's|^|    |'
    echo ""
    echo -ne "  Type ${BOLD}RESTORE${RESET} to confirm (pool service + wallet listener will be stopped): "
    local go; read -r go || true
    [[ "$go" == "RESTORE" ]] || { rm -f "$tmp_clear"; info "Restore cancelled."; return 1; }

    local xrc=0
    _pbk_restore_extract "$tmp_clear" \
        'ledger restored from backup — reconcile before resuming' 'restore'
    xrc=$?
    # Games DB: its own question, default Y (D18). Skipped after a failed extraction — the
    # operator restores again cleanly anyway. Whatever happens, the pool restore goes on.
    if [[ "$xrc" -ne 1 && "$xrc" -ne 4 ]] && declare -F pgs_restore_db_from_archive >/dev/null 2>&1; then
        pgs_restore_db_from_archive "$tmp_clear" "$(basename "$chosen")" \
            || warn "Games database not restored — the pool restore continues (P → 9 restores it later)."
    fi
    rm -f "$tmp_clear"
    case "$xrc" in
        0) warn "Payouts FROZEN on the restored ledger — the wallet has spent money this DB no longer knows about."
           _pbk_report_stratum_pause ;;
        1) error "Extraction failed — this box may now hold a PARTIAL restore (disk full? df -h)."
           if [[ "$PBK_EXTRACT_FROZEN" == "1" ]]; then
               warn "Payouts FROZEN on the pool.db now in place. Restore again cleanly before starting anything."
           else
               error "Payouts could NOT be frozen — do NOT start the service; freeze from the admin panel first."
           fi
           if [[ -f "$POOL_APP_DIR/pool.db" ]]; then _pbk_report_stratum_pause; fi
           _pbk_restore_perms
           return 1 ;;
        2) error "Could not freeze payouts on the restored pool.db."
           error "  Do NOT start the service yet: freeze from the admin panel first, or the"
           error "  scheduler may re-send payouts the chain has already made."
           _pbk_report_stratum_pause ;;
        4) warn "Nothing was restored — see the message above, then run 2) again."
           return 1 ;;
        3) warn "The archive held NO pool.db — the ledger that was here is still in place (payouts frozen)."
           warn "  Everything else in the archive was restored." ;;
        *) : ;;
    esac
    _pbk_restore_perms

    success "Restore complete — pool.db, config, wallet, WG identity are back in place."
    if [[ -n "${PBK_EXTRACT_ASIDE:-}" ]]; then
        echo -e "  ${DIM}The pool.db that was here is kept as $PBK_EXTRACT_ASIDE (+ its -wal/-shm) — delete it once the pool checks out.${RESET}"
    fi
    if ls "$PBK_BACKUP_DIR/${PDS_PREFIX}"*.tar.gz.enc >/dev/null 2>&1; then
        echo -e "  ${DIM}DB snapshots are here, maybe newer than this archive — 2) Restore → DB snapshot puts the newest on top of this.${RESET}"
    fi
    echo ""
    echo -e "  ${BOLD}To finish (order matters):${RESET}"
    echo -e "    1) ${BOLD}grin-secret-sync${RESET} — re-points the wallet at THIS box's node secrets."
    echo -e "    2) ${BOLD}wg-quick down/up ${WG_IFACE:-wg-grinpool}${RESET} (or W → 1) — brings the restored tunnel up."
    echo -e "       No gateway needs re-pairing. Whether they reconnect on their own depends on the IP:"
    echo -e "       ${DIM}· same IP as before → yes, on their PersistentKeepalive.${RESET}"
    echo -e "       ${DIM}· new IP, gateway paired to a DNS name (W → 5) → update that A record; gateways${RESET}"
    echo -e "       ${DIM}  with the re-resolve timer (their 3) Bring up tunnel installs it) follow in ~2–3 min.${RESET}"
    echo -e "       ${DIM}· new IP, gateway paired to a raw IP → on EACH gateway: 2) Configure the new${RESET}"
    echo -e "       ${DIM}  endpoint, then 3) Bring up tunnel. (Gateway 5) Status says which kind it is.)${RESET}"
    echo -e "       ${DIM}The OLD hub's tunnel must be down, or gateways keep handshaking with it.${RESET}"
    echo -e "    3) ${BOLD}5) Set up wallet → 2) Start listener${RESET} — restored .wallet_pass unlocks it."
    echo -e "    4) ${BOLD}4) Setup nginx${RESET} if this is a fresh box (a daily archive carries no cert;"
    echo -e "       ${DIM}a Migrate OUT archive does — then 4) runs without certbot; the header snippets${RESET}"
    echo -e "       ${DIM}and rate-limit zones it also writes are never in an archive).${RESET}"
    echo -e "    ${RED}5b)${RESET} ${BOLD}Reconcile BEFORE resuming payouts${RESET} — admin → Health → Reconciliation."
    echo -e "       ${DIM}Payouts are frozen (above). The restored ledger is older than the chain: any${RESET}"
    echo -e "       ${DIM}payout that settled after the snapshot is owed again here but already spent${RESET}"
    echo -e "       ${DIM}on-chain. Resuming without reconciling re-sends it. Resume from admin →${RESET}"
    echo -e "       ${DIM}Payouts once coverage reports clean. (Not an issue on a FRESH-box rebuild${RESET}"
    echo -e "       ${DIM}from the newest backup — but freeze/reconcile costs nothing there either.)${RESET}"
    echo -e "    5) ${BOLD}6) Service control → Start${RESET}, then check admin → health."
    if [[ "${PBK_EXTRACT_PAUSED:-0}" == "1" ]]; then
        echo -e "    6) ${BOLD}Resume stratum${RESET} in admin → Announcements → Stratum once the pool checks out."
        echo -e "       ${DIM}It starts PAUSED (no miner accepted) and resumes on its own at $(_pbk_utc "$PBK_EXTRACT_PAUSE_UNTIL").${RESET}"
    fi
    mkdir -p "$(dirname "$PBK_LOG")"
    echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] restore from: $(basename "$chosen")" >> "$PBK_LOG" 2>/dev/null || true
}

# ─── Scheduled runs: ONE generated wrapper, two modes ─────────────────────────
#   $PBK_WRAPPER          daily full archive (same set as pbk_backup_now, never certs)
#   $PBK_WRAPPER dbsnap   database snapshot (pool.db + games DB only — no seed, config,
#                         WG key or vhost), on its own cron (07_lib_pool_dbsnap.sh)
# Cron cannot source the toolkit, so the wrapper is standalone; it is regenerated by
# pool_backup_refresh_generated (pool deploy, key 9) and whenever a schedule changes.
# Both modes take $PBK_LOCK: a snapshot never overlaps itself or the daily run (it skips),
# and the daily run waits for a snapshot in progress. Both run at the lowest best-effort
# CPU and I/O priority — the reads compete with share writes on the same disk.
# The SQLite reads use the online-backup API only. A copy of a live WAL database is
# not a snapshot, so a failed backup-API call writes no archive rather than a raw copy.
_pbk_wrapper_text() {
    local wdir; wdir=$(pw_wallet_dir 2>/dev/null || echo "${POOL_WALLET_DIR:-}")
    cat <<WRAP
#!/bin/bash
# Grin public pool hub backup — generated by 07_grin_mining_public_pool.sh. Do not edit.
#   (no argument)  daily full archive: pool.db, games DB, pool.json, wallet seed/secrets,
#                  WG identity, nginx vhost
#   dbsnap         database snapshot: pool.db + games DB only
set -uo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin
MODE="\${1:-full}"
[[ "\$MODE" == full || "\$MODE" == dbsnap ]] || { echo "usage: \$0 [dbsnap]" >&2; exit 2; }
CONF="$PBK_CONF"
KEYCONF="$GBE_CONF"
BACKUP_DIR="$PBK_BACKUP_DIR"
PREFIX="$PBK_PREFIX"
SNAP_PREFIX="$PDS_PREFIX"
LOG="$PBK_LOG"
LOCK="$PBK_LOCK"
STAMP="$PDS_STAMP"
PUSH_STAMP="$PDS_PUSH_STAMP"
APP_DIR="$POOL_APP_DIR"
POOL_CONF="$POOL_CONF"
WALLET_DIR="$wdir"
WG_DIR="${WG_DIR_CONF:-}"
WG_FILE="${WG_CONF:-}"
NGINX_VHOST="${POOL_NGINX_CONF:-}"
GAMES_DB="${PGS_DB:-}"
PUSH_BIN="${GBP_BIN:-/usr/local/bin/grin-backup-push}"
PUSH_LOG="${GBP_LOG:-/opt/grin/logs/backup-push.log}"

TS=\$(date -u '+%Y-%m-%d %H:%M:%S UTC')
TAG=""; [[ "\$MODE" == dbsnap ]] && TAG="dbsnap: "
log() { echo "[\$TS] \${TAG}\$*" >> "\$LOG"; }
mkdir -p "\$(dirname "\$LOG")" 2>/dev/null || true

PBK_KEEP=$PBK_KEEP_DEFAULT; PDS_KEEP=$PDS_KEEP_DEFAULT; PDS_PUSH=1; PDS_PUSH_MIN=0
# shellcheck disable=SC1090
[[ -f "\$CONF" ]] && source "\$CONF"
[[ "\$PBK_KEEP" =~ ^[0-9]+\$ && "\$PBK_KEEP" -ge 1 ]] || PBK_KEEP=$PBK_KEEP_DEFAULT
[[ "\$PDS_KEEP" =~ ^[0-9]+\$ && "\$PDS_KEEP" -ge 1 ]] || PDS_KEEP=$PDS_KEEP_DEFAULT
[[ "\$PDS_PUSH" == 0 ]] || PDS_PUSH=1
[[ "\$PDS_PUSH_MIN" =~ ^[0-9]+\$ ]] || PDS_PUSH_MIN=0
GBE_PERSONAL_KEY_B64=""
# shellcheck disable=SC1090
[[ -f "\$KEYCONF" ]] && source "\$KEYCONF"
KEY=\$(printf '%s' "\$GBE_PERSONAL_KEY_B64" | base64 -d 2>/dev/null || true)
[[ -n "\$KEY" ]] || { log "ERROR: no personal key set"; exit 1; }

renice -n 19 -p \$\$ >/dev/null 2>&1 || true
ionice -c2 -n7 -p \$\$ >/dev/null 2>&1 || true
mkdir -p "\$(dirname "\$LOCK")" 2>/dev/null || true
exec 9>>"\$LOCK" || { log "ERROR: cannot open the lock \$LOCK"; exit 1; }
if [[ "\$MODE" == dbsnap ]]; then
    flock -n 9 || { log "skipped — another pool backup is running"; exit 0; }
else
    flock -w 1800 9 || { log "ERROR: another pool backup held the lock for 30 min — no archive written"; exit 1; }
fi

mkdir -p "\$BACKUP_DIR" || { log "ERROR: cannot create \$BACKUP_DIR"; exit 1; }
chmod 700 "\$BACKUP_DIR" 2>/dev/null || true
# Hidden temp files of a run that was killed (we hold the lock, so none is live).
find "\$BACKUP_DIR" -maxdepth 1 -type f \\( -name ".\${PREFIX}*" -o -name ".\${SNAP_PREFIX}*" \\) -mmin +240 -delete 2>/dev/null || true

STAGE=""; WORK=""; TMP=""; ENC=""
cleanup() { [[ -n "\$STAGE" ]] && rm -rf "\$STAGE"; rm -f "\$WORK" "\$TMP" "\$ENC" 2>/dev/null; return 0; }
trap cleanup EXIT
fail() { log "ERROR: \$1 — no archive written"; exit 1; }

# Backup-API copy of a live SQLite db. A root open can create the -wal/-shm sidecars;
# they are handed back to the db file's owner, or the service could not open them.
snap() {  # <src.db> <dst>
    mkdir -p "\$(dirname "\$2")" || return 1
    python3 -c 'import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()' \\
        "\$1" "\$2" 2>/dev/null || { rm -f "\$2"; return 1; }
    local x
    for x in "\$1-wal" "\$1-shm"; do
        if [[ -e "\$x" ]]; then chown --reference="\$1" "\$x" 2>/dev/null || true; fi
    done
    [[ -s "\$2" ]]
}

DB="\$APP_DIR/pool.db"
DBREL=""; GDBREL=""
D=\$(date +%d%m%Y)
PASS="\${KEY}\${D}"

if [[ "\$MODE" == dbsnap ]]; then
    [[ -f "\$DB" ]] || fail "no pool.db at \$DB"
    # UTC in a snapshot name: local time repeats an hour at a DST fall-back, and two
    # snapshots with one name would overwrite each other. The date half keys the password.
    NOW=\$(date -u +%d%m%Y_%H%M); D="\${NOW%_*}"; PASS="\${KEY}\${D}"
    ARCHIVE="\$BACKUP_DIR/\${SNAP_PREFIX}\${NOW}.tar.gz.enc"
    ENC_PREFIX=".\${SNAP_PREFIX}"
else
    LIVE=(); for s in "\$APP_DIR" "\$POOL_CONF" "\$WALLET_DIR" "\$WG_DIR" "\$WG_FILE" "\$NGINX_VHOST"; do
        [[ -n "\$s" && -e "\$s" ]] && LIVE+=( "\${s#/}" )
    done
    [[ "\${#LIVE[@]}" -gt 0 ]] || fail "nothing to back up"
    ARCHIVE="\$BACKUP_DIR/\${PREFIX}\${D}.tar.gz.enc"
    ENC_PREFIX=".\${PREFIX}"
fi

STAGE=\$(mktemp -d /tmp/grin_pubpool_cronsnap_XXXXXX 2>/dev/null) || { STAGE=""; fail "no staging dir (/tmp full?)"; }
WORK=\$(mktemp /tmp/grin_pubpool_cronwork_XXXXXX.tar) || fail "mktemp failed"
# pool.db present but not snapshotted = NO archive: one without the ledger restores no balances.
if [[ -f "\$DB" ]]; then
    DBREL="\${DB#/}"
    snap "\$DB" "\$STAGE/\$DBREL" || fail "could not snapshot pool.db"
fi
# Games DB (design §19 D18): best effort — a failure is a WARN line, never a lost archive.
if [[ -n "\$GAMES_DB" && -f "\$GAMES_DB" ]]; then
    if snap "\$GAMES_DB" "\$STAGE/\${GAMES_DB#/}"; then
        GDBREL="\${GAMES_DB#/}"
    else
        log "WARN: games DB not snapshotted — this archive carries no games data"
    fi
fi
# Skip a snapshot whose databases are identical to the last one stored. Hashed from the
# backup-API copies, not the live files: a checkpoint rewrites pool.db and drops its WAL
# without changing a row, while the copy of an unchanged database is byte-identical.
HASH=""
if [[ "\$MODE" == dbsnap ]]; then
    HASH=\$(cd "\$STAGE" && find . -type f -print0 | sort -z | xargs -0 sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1)
    if [[ -n "\$HASH" && -f "\$STAMP" && "\$(cat "\$STAMP" 2>/dev/null)" == "\$HASH" ]]; then
        log "skipped — no database change since the last snapshot"; exit 0
    fi
fi

if [[ "\$MODE" == full ]]; then
    EX=( --exclude="\${WALLET_DIR#/}/grin-wallet" --exclude="*/node_modules" \\
         --exclude="\${APP_DIR#/}/lib" --exclude="\${APP_DIR#/}/admin-panel" --exclude="\${APP_DIR#/}/scripts" \\
         --exclude="\${APP_DIR#/}/index.js" --exclude="\${APP_DIR#/}/package.json" --exclude="\${APP_DIR#/}/package-lock.json" \\
         --exclude="\${APP_DIR#/}/routes" \\
         --exclude="*.log" --exclude="*.db" --exclude="*.db-wal" --exclude="*.db-shm" --exclude="*.db-journal" \\
         --exclude="*.pre-restore-*" )
    tar -cf "\$WORK" "\${EX[@]}" -C / "\${LIVE[@]}" 2>/dev/null || true
    [[ -f "\$WORK" ]] || fail "tar wrote nothing"
    if [[ -n "\$DBREL" ]]; then
        tar -rf "\$WORK" -C "\$STAGE" "\$DBREL" 2>/dev/null || fail "could not append pool.db to the archive"
    fi
else
    tar -cf "\$WORK" -C "\$STAGE" "\$DBREL" 2>/dev/null || fail "could not tar the pool.db snapshot"
fi
if [[ -n "\$GDBREL" ]]; then
    tar -rf "\$WORK" -C "\$STAGE" "\$GDBREL" 2>/dev/null \\
        || log "WARN: could not append the games DB — this archive carries no games data"
fi
rm -rf "\$STAGE"; STAGE=""
TMP=\$(mktemp /tmp/grin_pubpool_cronbak_XXXXXX.tar.gz) || fail "mktemp failed"
gzip -c "\$WORK" > "\$TMP" 2>/dev/null || fail "gzip failed"
rm -f "\$WORK"; WORK=""
[[ -s "\$TMP" ]] || fail "empty archive (disk full?)"

# Encrypt into a hidden mode-600 file beside the target, then rename it in, so the final
# name never holds a partial file and a failure leaves an earlier archive untouched.
ENC=\$(mktemp "\$BACKUP_DIR/\${ENC_PREFIX}XXXXXX") || fail "mktemp failed in \$BACKUP_DIR"
openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass fd:3 \\
    -in "\$TMP" -out "\$ENC" 3<<<"\$PASS" 2>/dev/null || fail "openssl failed"
unset PASS KEY
rm -f "\$TMP"; TMP=""
chmod 600 "\$ENC"; chown root:root "\$ENC" 2>/dev/null || true
# A daily archive that already exists today (a Backup now earlier, or Migrate OUT) moves
# aside as <prefix><HHMMSS>_<DDMMYYYY> — the date stays the last field every restore reads.
if [[ "\$MODE" == full && -e "\$ARCHIVE" ]]; then
    T=\$(date -r "\$ARCHIVE" +%H%M%S 2>/dev/null) || T="000000"
    ASIDE="\$BACKUP_DIR/\${PREFIX}\${T}_\${D}.tar.gz.enc"; n=1
    while [[ -e "\$ASIDE" ]]; do ASIDE="\$BACKUP_DIR/\${PREFIX}\${T}-\${n}_\${D}.tar.gz.enc"; n=\$((n + 1)); done
    mv "\$ARCHIVE" "\$ASIDE" || fail "could not move the earlier \$(basename "\$ARCHIVE") aside"
    if [[ -f "\$ARCHIVE.sha256" ]]; then mv -f "\$ARCHIVE.sha256" "\$ASIDE.sha256" 2>/dev/null || true; fi
    log "earlier archive of today kept as \$(basename "\$ASIDE")"
fi
mv -f "\$ENC" "\$ARCHIVE" || fail "could not move the archive into place"
ENC=""
SZ=\$(du -sh "\$ARCHIVE" 2>/dev/null | cut -f1 || echo "?")
if [[ "\$MODE" == dbsnap ]]; then
    printf '%s\n' "\$HASH" > "\$STAMP" 2>/dev/null || true
    log "snapshot created: \$(basename "\$ARCHIVE") (\$SZ)"
else
    log "backup created: \$(basename "\$ARCHIVE") (\$SZ)"
fi

if [[ "\$MODE" == dbsnap ]]; then KEEP="\$PDS_KEEP"; PAT="\${SNAP_PREFIX}"; else KEEP="\$PBK_KEEP"; PAT="\${PREFIX}"; fi
N=\$(ls -1 "\$BACKUP_DIR/\${PAT}"*.tar.gz.enc 2>/dev/null | wc -l)
if [[ "\$N" -gt "\$KEEP" ]]; then
    ls -t "\$BACKUP_DIR/\${PAT}"*.tar.gz.enc 2>/dev/null \\
        | tail -n +\$((KEEP + 1)) | xargs -r rm -f 2>/dev/null || true
    log "pruned (kept newest \$KEEP)"
fi

# The archive is in place: release the lock BEFORE the push. An upload may take minutes to
# hours on a slow link, and holding the lock through it would make the daily run (30 min)
# and a restore (10 min) give up.
exec 9>&-

# Offsite push (scp) — silent no-op unless configured via the toolkit menus. A snapshot
# is pushed when PDS_PUSH is on and PDS_PUSH_MIN minutes have passed since the last one.
DO_PUSH=1
if [[ "\$MODE" == dbsnap ]]; then
    if [[ "\$PDS_PUSH" != 1 ]]; then
        DO_PUSH=0
    elif [[ "\$PDS_PUSH_MIN" -gt 0 ]]; then
        LAST=\$(cat "\$PUSH_STAMP" 2>/dev/null || echo 0); [[ "\$LAST" =~ ^[0-9]+\$ ]] || LAST=0
        if [[ \$(( \$(date +%s) - LAST )) -lt \$(( PDS_PUSH_MIN * 60 )) ]]; then DO_PUSH=0; fi
    fi
fi
if [[ "\$DO_PUSH" == 1 && -x "\$PUSH_BIN" ]]; then
    if "\$PUSH_BIN" "\$ARCHIVE"; then
        if [[ "\$MODE" == dbsnap ]]; then date +%s > "\$PUSH_STAMP" 2>/dev/null || true; fi
    else
        log "WARN: offsite push failed — see \$PUSH_LOG"
    fi
fi
exit 0
WRAP
}

_pbk_write_wrapper() { gbp_install_generated "$PBK_WRAPPER" "$(_pbk_wrapper_text)"; }

# Toggle: enabled → offer disable; disabled → require key, write wrapper + cron.
pbk_schedule() {
    pbk_load_conf
    echo -e "\n${BOLD}Daily hub backup schedule — ${POOL_NET_LABEL:-$POOL_NET}${RESET}"
    if [[ -f "$PBK_CRON" ]]; then
        echo -e "  Status: ${GREEN}enabled${RESET}  ${DIM}(daily $(printf '%02d:%02d' "$PBK_HOUR" "$PBK_MIN") UTC, keep $PBK_KEEP · log: $PBK_LOG)${RESET}"
        echo -ne "  Disable it? [y/N]: "
        local c; read -r c || true
        if [[ "${c,,}" == "y" ]]; then
            rm -f "$PBK_CRON" || { error "Could not remove $PBK_CRON."; return 1; }
            # The DB snapshot cron runs the same wrapper.
            if [[ ! -f "$PDS_CRON" ]]; then rm -f "$PBK_WRAPPER" 2>/dev/null || true; fi
            success "Daily backup disabled."
        fi
        return 0
    fi
    echo -e "  ${DIM}Runs once a day (encrypted archive + offsite push if configured), keeps${RESET}"
    echo -e "  ${DIM}the newest $PBK_KEEP archives. Uses the saved personal key — no prompt at run time.${RESET}"
    gbe_require_key || { info "Scheduling needs a personal key."; return 1; }
    command -v flock >/dev/null 2>&1 || { error "flock not found (util-linux) — cannot schedule safely."; return 1; }
    pbk_save_conf || return 1
    _pbk_write_wrapper || return 1
    # By rename: cron ignores a name with a dot, so it never reads the half-written file.
    printf '# Grin public pool hub daily backup — generated by 07_grin_mining_public_pool.sh\n%s %s * * * root %s\n' \
        "$PBK_MIN" "$PBK_HOUR" "$PBK_WRAPPER" > "$PBK_CRON.new" \
        && chmod 644 "$PBK_CRON.new" && mv -f "$PBK_CRON.new" "$PBK_CRON" \
        || { rm -f "$PBK_CRON.new" 2>/dev/null; error "Could not write $PBK_CRON."; return 1; }
    success "Daily backup enabled → $PBK_CRON  (daily $(printf '%02d:%02d' "$PBK_HOUR" "$PBK_MIN") UTC)"
}

pbk_list_backups() {
    echo ""
    echo -e "  ${BOLD}Backups in $PBK_BACKUP_DIR:${RESET}"
    local any=0 f sz
    while IFS= read -r f; do
        [[ -n "$f" ]] || continue
        any=1; sz=$(du -sh "$f" 2>/dev/null | cut -f1 || echo "?")
        echo -e "    $(basename "$f")  ${DIM}($sz)${RESET}"
    done < <(ls -t "$PBK_BACKUP_DIR/${PBK_PREFIX}"*.tar.gz.enc 2>/dev/null || true)
    # if-form: a trailing `[[ ]] && echo` would make this return 1 whenever
    # backups exist — the bare caller under set -e would die (CLAUDE.md trap).
    if [[ "$any" -eq 0 ]]; then echo -e "    ${DIM}(none yet)${RESET}"; fi
}

pbk_settings() {
    local c
    while true; do
        clear
        pbk_load_conf
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Pool hub — Backup settings (${POOL_NET_LABEL:-$POOL_NET})${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        local key_state="${RED}not set${RESET}"; [[ -n "$GBE_PERSONAL_KEY" ]] && key_state="${GREEN}set${RESET}"
        echo -e "  Personal key : $key_state   ${DIM}($GBE_CONF · shared by all products)${RESET}"
        echo -e "  Retention    : ${BOLD}$PBK_KEEP${RESET} archives  ${DIM}· DB snapshots: $PDS_KEEP (set in 3) Schedules)${RESET}"
        echo -e "  Schedule time: $(printf '%02d:%02d' "$PBK_HOUR" "$PBK_MIN") UTC"
        pbk_list_backups
        pds_list
        echo ""
        echo -e "  ${GREEN}1${RESET}) Set / change personal key"
        echo -e "  ${GREEN}2${RESET}) Set retention (number of archives to keep)"
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-2/0]: ${RESET}"
        read -r c || c=0
        case "$c" in
            "") continue ;;
            1) gbe_set_key || true; _pool_pause ;;
            2) echo -ne "  Keep how many archives [current $PBK_KEEP]: "
               local n; read -r n || true
               if [[ "$n" =~ ^[0-9]+$ && "$n" -ge 1 ]]; then
                   PBK_KEEP="$n"; pbk_save_conf; success "Retention set to $n."
                   [[ -f "$PBK_CRON" ]] && _pbk_write_wrapper
               else
                   warn "Unchanged (enter a positive number)."
               fi
               _pool_pause ;;
            0) return 0 ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# ─── Backup & Restore menu (pool main menu option B) ─────────────────────────
pool_backup_menu() {
    local choice
    while true; do
        clear
        pbk_load_conf
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Pool hub — Backup & Restore (${POOL_NET_LABEL:-$POOL_NET})${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        local sched="${RED}off${RESET}"; [[ -f "$PBK_CRON" ]] && sched="${GREEN}daily $(printf '%02d:%02d' "$PBK_HOUR" "$PBK_MIN") UTC${RESET}"
        if pds_enabled; then
            if [[ -f "$PBK_CRON" ]]; then sched+="${DIM} + ${RESET}"; else sched=""; fi
            sched+="${GREEN}DB snapshot every ${PDS_INTERVAL} min${RESET}"
        fi
        local key_state="${RED}not set${RESET}"; [[ -n "$GBE_PERSONAL_KEY" ]] && key_state="${GREEN}set${RESET}"
        local push_state="${DIM}off${RESET}"; gbp_configured && push_state="${GREEN}on${RESET}"
        echo -e "  ${DIM}Dir: $PBK_BACKUP_DIR · key: ${RESET}$key_state${DIM} · schedule: ${RESET}$sched${DIM} · offsite: ${RESET}$push_state"
        echo -e "  ${DIM}Covers: pool.db (balances) · pool.json · wallet seed · WG identity (no gateway${RESET}"
        echo -e "  ${DIM}re-pairing; a new hub IP may need a step on each gateway) · nginx vhost${RESET}"
        echo -e "  ${DIM}· games DB when /play/ is installed (restore asks about it separately).${RESET}"
        echo -e "  ${DIM}DB snapshots (3): pool.db + games DB only, every 15–120 min — no seed, no config.${RESET}"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Backup now           ${DIM}(encrypted archive)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Restore from backup   ${DIM}(full archive or DB snapshot · extract + runbook)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Schedules             ${DIM}(daily full archive · DB snapshot every 15–120 min)${RESET}"
        echo -e "  ${GREEN}4${RESET}) Settings              ${DIM}(personal key · retention · list)${RESET}"
        echo -e "  ${GREEN}5${RESET}) Offsite push (scp)    ${DIM}(auto-copy each archive to a remote server)${RESET}"
        echo ""
        echo -e "  ${YELLOW}6${RESET}) Migrate OUT           ${DIM}(this hub → a new box: freeze, stop, final archive)${RESET}"
        echo -e "  ${YELLOW}7${RESET}) Migrate IN            ${DIM}(NEW box: CHECK first · restore, verify, start)${RESET}"
        echo ""
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-7/0]: ${RESET}"
        read -r choice || choice=0
        case "$choice" in
            "") continue ;;
            1) pbk_backup_now  || true; _pool_pause ;;
            2) pool_backup_restore_menu || true; _pool_pause ;;
            3) pds_schedule_menu || true ;;
            4) pbk_settings    || true ;;
            5) gbp_setup       || true ;;
            6) pmg_migrate_out || true; _pool_pause ;;
            7) pmg_migrate_in  || true; _pool_pause ;;
            0) return 0 ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# Guided hub move (menu keys 6/7). Sourced HERE, after everything it reuses above
# (pbk_freeze_payouts, _pbk_build_archive, _pbk_restore_extract, PBK_*), so every consumer of this lib
# gets the menu's targets without a second source line in the parent script.
# shellcheck source=07_lib_pool_migrate.sh
source "$(dirname "${BASH_SOURCE[0]}")/07_lib_pool_migrate.sh"

# DB snapshots (menu keys 2/3): schedule, list, DB-only restore. Same reasoning as above —
# it reuses PBK_*/PDS_*, the wrapper and the restore core.
# shellcheck source=07_lib_pool_dbsnap.sh
source "$(dirname "${BASH_SOURCE[0]}")/07_lib_pool_dbsnap.sh"
