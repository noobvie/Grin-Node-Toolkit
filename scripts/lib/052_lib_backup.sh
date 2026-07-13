# 052_lib_backup.sh — Encrypted backup / restore / schedule for Grin Drop
# =============================================================================
# Ports the solo-mining backup approach (lib/07_solo_backup.sh) into the Drop.
# One encrypted archive of everything BOTH drop networks can't recreate:
#   /opt/grin/drop-test/   full wallet dir MINUS redeployable bulk — i.e. the
#   /opt/grin/drop-main/   grin-wallet binary + wallet_data/ (seed + outputs) +
#                          grin-wallet.toml + .foreign/.owner api secrets +
#                          .temp_<net> passphrase + .word_<net> seed words +
#                          grin_drop_<net>.conf + drop-<net>.db.
#                          EXCLUDED: server/ public_html/ node_modules/ *.log
#                          (all re-created by option 5 Deploy + option 1 Setup).
#   /opt/grin/conf/drop_shared.conf   shared domain / ssl / GA4 / turnstile.
#
# Each drop-<net>.db is consistency-snapshotted via SQLite's online-backup API
# before archiving (see _dbk_make_tar) so a backup is never a torn copy of a
# mid-write DB even while the Node.js service is live. Everything else is tarred
# live — wallet_data/ is LMDB; the seed inside it is immutable, so the copy is
# always recoverable (a Scan after restore rebuilds the output cache if stale).
#
# Archive: /opt/grin/backups/grin_drop_backup_<DDMMYYYY>.tar.gz.enc  (mode 600)
#   · dir + AES-256-CBC/PBKDF2-600k crypto mirror the solo lib for repo consistency
#   · password NEVER on the process list (fd:3 here-string)
#
# Password model (standard across ALL products — see lib/grin_backup_engine.sh):
#   <personal_key><DDMMYYYY>   e.g.  123abc04072026
#   · personal_key — ONE shared secret for all product backups; stored base64
#     in grin_backup.conf (mode 600) so the daily cron can run unattended.
#     Typed by HAND on restore. (Migrated from the old grin_drop_backup.conf.)
#   · DDMMYYYY — parsed from the filename → per-file salt, not a secret.
#   Lose the key AND the box → archives are unrecoverable (the date alone won't
#   open them). Seed words are ALSO in the archive, so the key protects the seed.
#
# Restore: pick a file → type the personal key ONCE → decrypt + validate →
# single extract to the EXACT original /opt/grin/… paths (tar -C / -p). Then
# start the wallet listeners + services. Legacy grin_drop_all_backup_* archives
# (old interactive-password, staging-rename layout) are still restorable.
#
# Convention: sourced lib → NO shebang / NO `set -e`.
# =============================================================================

[[ -n "${_GRIN_DROP_BACKUP_SH_LOADED:-}" ]] && return 0
_GRIN_DROP_BACKUP_SH_LOADED=1

# Shared backup engine — key (ONE personal key for all products, in
# /opt/grin/conf/grin_backup.conf), naming, crypto, prune, offsite push.
# This lib keeps only the drop-specific source list + restore steps.
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/grin_backup_engine.sh"

# ─── Paths / constants (env-overridable for testing) ────────────────────────
DBK_BACKUP_DIR="${DBK_BACKUP_DIR:-/opt/grin/backups}"
DBK_CONF="${DBK_CONF:-/opt/grin/conf/grin_drop_backup.conf}"     # key + schedule (mode 600)
DBK_WRAPPER="${DBK_WRAPPER:-/usr/local/bin/grin-drop-backup}"
DBK_CRON="${DBK_CRON:-/etc/cron.d/grin-drop-backup}"
DBK_PREFIX="grin_drop_backup_"
DBK_LEGACY_PREFIX="grin_drop_all_backup_"                         # old cherry-pick archives
DBK_KEEP_DEFAULT=14
DBK_LOG="${DBK_LOG:-/opt/grin/logs/drop-backup.log}"

# Absolute source paths (existing only). The two drop dirs carry the wallet;
# the shared conf carries cross-network domain/ssl settings. drop-<net>.db lives
# in a SEPARATE data dir (outside the wallet dir, so a wallet re-install can't
# wipe it) and is snapshotted separately in _dbk_make_tar.
DBK_TEST_DIR="${DBK_TEST_DIR:-/opt/grin/drop-test}"
DBK_MAIN_DIR="${DBK_MAIN_DIR:-/opt/grin/drop-main}"
DBK_TEST_DB="${DBK_TEST_DB:-/opt/grin/drop-test-data/drop-test.db}"
DBK_MAIN_DB="${DBK_MAIN_DB:-/opt/grin/drop-main-data/drop-main.db}"

_dbk_sources() {
    local s
    for s in "$DBK_TEST_DIR" "$DBK_MAIN_DIR" "${DROP_SHARED_CONF:-/opt/grin/conf/drop_shared.conf}"; do
        [[ -e "$s" ]] && echo "$s"
    done
}

# logging fallbacks (mirror the drop main script so the lib survives standalone use)
if ! declare -F info    >/dev/null 2>&1; then info()    { echo "[INFO]  $*"; }; fi
if ! declare -F warn    >/dev/null 2>&1; then warn()    { echo "[WARN]  $*"; }; fi
if ! declare -F error   >/dev/null 2>&1; then error()   { echo "[ERROR] $*" >&2; }; fi
if ! declare -F success >/dev/null 2>&1; then success() { echo "[OK]    $*"; }; fi
if ! declare -F pause   >/dev/null 2>&1; then pause()   { echo ""; echo "Press Enter to continue..."; read -r || true; }; fi
if ! declare -F log     >/dev/null 2>&1; then log()     { :; }; fi

# ─── Config (personal key stored base64 to dodge all quoting issues) ─────────
DBK_PERSONAL_KEY=""
DBK_KEEP="$DBK_KEEP_DEFAULT"
DBK_HOUR=3
DBK_MIN=30

dbk_load_conf() {
    DBK_KEEP="$DBK_KEEP_DEFAULT"; DBK_HOUR=3; DBK_MIN=30
    if [[ -f "$DBK_CONF" ]]; then
        # shellcheck disable=SC1090
        source "$DBK_CONF" 2>/dev/null || true
    fi
    [[ "$DBK_KEEP" =~ ^[0-9]+$ ]] || DBK_KEEP="$DBK_KEEP_DEFAULT"
    [[ "$DBK_HOUR" =~ ^[0-9]+$ ]] || DBK_HOUR=3
    [[ "$DBK_MIN"  =~ ^[0-9]+$ ]] || DBK_MIN=30
    # Key lives in the SHARED engine conf (migrated from this file on first use).
    gbe_load_key
    DBK_PERSONAL_KEY="$GBE_PERSONAL_KEY"
}

dbk_save_conf() {
    mkdir -p "$(dirname "$DBK_CONF")"
    ( umask 077; cat > "$DBK_CONF" <<EOF
# Grin Drop backup config — generated by 052_grin_drop.sh
# Schedule/retention only. The personal key lives in the SHARED conf
# (grin_backup.conf — one key for ALL product backups).
DBK_KEEP=$DBK_KEEP
DBK_HOUR=$DBK_HOUR
DBK_MIN=$DBK_MIN
EOF
    )
    chmod 600 "$DBK_CONF"
    chown root:root "$DBK_CONF" 2>/dev/null || true
}

dbk_date() { date +%d%m%Y; }

# Parse the DDMMYYYY out of a new-format backup filename → echo it, rc 1 otherwise.
dbk_parse_date() {
    local base; base=$(basename "$1")
    local d="${base#"$DBK_PREFIX"}"; d="${d%.tar.gz.enc}"
    [[ "$d" =~ ^[0-9]{8}$ ]] && { echo "$d"; return 0; }
    return 1
}

# ─── Set / change the personal key (shared engine key) ──────────────────────
dbk_set_key() {
    if gbe_set_key; then
        DBK_PERSONAL_KEY="$GBE_PERSONAL_KEY"
        return 0
    fi
    return 1
}

# Ensure a key exists (prompt to set one if not). rc 1 if still unset.
_dbk_require_key() {
    gbe_require_key || return 1
    DBK_PERSONAL_KEY="$GBE_PERSONAL_KEY"
}

# ─── Prune to the newest DBK_KEEP archives (new-format only) ─────────────────
dbk_prune() {
    gbe_prune_count drop "${1:-$DBK_KEEP}" "$DBK_BACKUP_DIR"
}

# ─── Build the gzip tar with consistent SQLite snapshots ────────────────────
# $1 = output .tar.gz. Two-phase so a global `*.db` exclude on the live pass
# can't strip the staged snapshots (they are appended in a separate tar call):
#   phase 1 — uncompressed tar of the drop dirs + shared conf, EXCLUDING the
#             redeployable bulk (server/ public_html/ node_modules/ *.log) and
#             the live .db files;
#   phase 2 — append each drop-<net>.db from a consistency-snapshot stage.
# Then gzip. MUST be called from an `if !`/`||` context (set -e disabled inside).
_dbk_make_tar() {
    local outgz="$1"
    local work; work=$(mktemp /tmp/grin_drop_bakwork_XXXXXX.tar 2>/dev/null) || return 1

    # Consistency-snapshot the drop DBs (online-backup API) into a stage.
    local stage; stage=$(mktemp -d /tmp/grin_drop_dbsnap_XXXXXX 2>/dev/null) || stage=""
    local -a db_rels=()
    local db rel
    if [[ -n "$stage" ]]; then
        for db in "$DBK_TEST_DB" "$DBK_MAIN_DB"; do
            [[ -f "$db" ]] || continue
            rel="${db#/}"
            mkdir -p "$stage/$(dirname "$rel")"
            python3 -c 'import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()' \
                "$db" "$stage/$rel" 2>/dev/null || cp -p "$db" "$stage/$rel"
            db_rels+=("$rel")
        done
    fi

    # Live sources (existing only), relative to / so restore lands them exactly.
    local -a live_rels=(); local s
    while IFS= read -r s; do live_rels+=("${s#/}"); done < <(_dbk_sources)

    local -a ex=(
        --exclude="opt/grin/drop-test/server"
        --exclude="opt/grin/drop-main/server"
        --exclude="opt/grin/drop-test/public_html"
        --exclude="opt/grin/drop-main/public_html"
        --exclude="*/node_modules"
        --exclude="*.log"
        --exclude="*.db"
        --exclude="*.db-wal"
        --exclude="*.db-journal"
    )

    local rc=0
    if [[ "${#live_rels[@]}" -gt 0 ]]; then
        tar -cf "$work" "${ex[@]}" -C / "${live_rels[@]}" 2>/dev/null
        rc=$?
    else
        rc=1
    fi
    # Append the consistent DB snapshots (separate call → *.db exclude above
    # does not apply). Benign if it warns; the live pass already holds the rest.
    if [[ -n "$stage" && "${#db_rels[@]}" -gt 0 && -f "$work" ]]; then
        tar -rf "$work" -C "$stage" "${db_rels[@]}" 2>/dev/null || rc=$?
    fi
    [[ -n "$stage" ]] && rm -rf "$stage"

    if [[ ! -f "$work" ]]; then rm -f "$work"; return 1; fi
    if ! gzip -c "$work" > "$outgz" 2>/dev/null; then rm -f "$work"; return 1; fi
    rm -f "$work"
    return $rc
}

# ─── Backup now (interactive) ───────────────────────────────────────────────
dbk_backup_now() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Grin Drop — Backup now (testnet + mainnet)${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    command -v openssl >/dev/null 2>&1 || { error "openssl not found — cannot encrypt."; return 1; }

    local -a srcs=(); local s
    while IFS= read -r s; do srcs+=("$s"); done < <(_dbk_sources)
    if [[ "${#srcs[@]}" -eq 0 ]]; then
        warn "Nothing to back up yet — set up a wallet (Testnet/Mainnet ▸ Setup wallet) first."
        return 1
    fi

    echo -e "  ${DIM}Will archive (wallet binary + wallet_data + secrets + seed + DB + config;${RESET}"
    echo -e "  ${DIM}redeployable web/server/node_modules excluded):${RESET}"
    for s in "${srcs[@]}"; do echo -e "    ${DIM}$s${RESET}"; done
    echo ""

    _dbk_require_key || { info "Backup needs a personal key."; return 1; }

    local tmp_gz
    tmp_gz=$(mktemp "/tmp/grin_drop_bak_XXXXXX.tar.gz") || { error "mktemp failed."; return 1; }

    info "Creating archive..."
    # tar may exit non-zero for a benign "file changed as we read it" (the live
    # listener touching wallet_data) — a warning, not fatal. The engine refuses
    # to encrypt a ZERO-BYTE tar (a truncated/disk-full write).
    if ! _dbk_make_tar "$tmp_gz"; then
        warn "tar reported issues (a file changed mid-read, or a missing optional path — usually harmless)."
    fi

    # Engine: verify → encrypt (<personal_key><DDMMYYYY>) → 600 → offsite push.
    gbe_finalize_archive drop "$tmp_gz" "$DBK_BACKUP_DIR" || return 1

    echo -e "  ${YELLOW}This archive contains the wallet seed — anyone with both the file and${RESET}"
    echo -e "  ${YELLOW}your key can spend. Only store offsite copies you trust.${RESET}"
    mkdir -p "$(dirname "$DBK_LOG")"
    echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] backup created: $(basename "$GBE_ARCHIVE")" >> "$DBK_LOG" 2>/dev/null || true

    dbk_prune "$DBK_KEEP"
    log "[dbk_backup_now] archive=$(basename "$GBE_ARCHIVE")"
}

# ─── Stop drop services + wallet sessions before a restore ──────────────────
_dbk_stop_all() {
    local svc sess
    for svc in grin-drop-test grin-drop-main; do
        if systemctl is-active --quiet "$svc" 2>/dev/null; then
            info "Stopping $svc ..."; systemctl stop "$svc" 2>/dev/null || true
        fi
    done
    for sess in drop-test-tor drop-test-ownerapi drop-test-scan \
                drop-main-tor drop-main-ownerapi drop-main-scan; do
        tmux has-session -t "$sess" 2>/dev/null && {
            tmux kill-session -t "$sess" 2>/dev/null && info "Stopped tmux: $sess" || true
        }
    done
    # Kill any surviving wallet processes holding wallet_data open (orphans/scan).
    local wb
    for wb in "$DBK_TEST_DIR/grin-wallet" "$DBK_MAIN_DIR/grin-wallet"; do
        pkill -9 -f "$wb" 2>/dev/null || true
    done
}

# ─── Re-assert tight perms on restored secrets/dirs ─────────────────────────
_dbk_fix_perms() {
    local dir
    for dir in "$DBK_TEST_DIR" "$DBK_MAIN_DIR"; do
        [[ -d "$dir" ]] || continue
        id grin &>/dev/null && chown -R grin:grin "$dir" 2>/dev/null || true
        chmod 750 "$dir" 2>/dev/null || true
        chmod 600 "$dir/grin-wallet.toml" "$dir/.foreign_api_secret" "$dir/.owner_api_secret" \
                  "$dir"/.temp_* "$dir"/*.db "$dir"/grin_drop_*.conf 2>/dev/null || true
        # seed words file is owned by root (matches the setup flow)
        chmod 600 "$dir"/.word_* 2>/dev/null || true
        chown root:root "$dir"/.word_* 2>/dev/null || true
    done
    # DBs now live outside the drop dirs (own data dir). Two things to fix here —
    # this runs only during restore, with the drop services already stopped:
    #   1. A PRE-MOVE backup extracts its DB back INSIDE the wallet dir
    #      (/opt/grin/drop-<net>/drop-<net>.db). Relocate it to the data dir, else
    #      the app restarts and creates a fresh EMPTY DB at the new path, silently
    #      ignoring the restored data. (In steady state migration already removed
    #      the in-dir copy, so this only fires right after such a restore.)
    #   2. tar extracts as root (--same-owner), so the data DIR lands root:root —
    #      chown the DIR (not just the file), else SQLite (as grin) can't create
    #      its WAL/-shm/journal files inside it and every write fails.
    local db dbdir old_indir sfx
    for db in "$DBK_TEST_DB" "$DBK_MAIN_DB"; do
        dbdir="$(dirname "$db")"
        old_indir="${dbdir%-data}/$(basename "$db")"   # data dir → sibling wallet dir
        if [[ "$old_indir" != "$db" && -f "$old_indir" ]]; then
            mkdir -p "$dbdir"
            for sfx in "" "-wal" "-shm" "-journal"; do
                [[ -f "$old_indir$sfx" ]] && mv -f "$old_indir$sfx" "$db$sfx" 2>/dev/null || true
            done
        fi
        [[ -d "$dbdir" ]] || continue
        id grin &>/dev/null && chown -R grin:grin "$dbdir" 2>/dev/null || true
        chmod 700 "$dbdir" 2>/dev/null || true
        [[ -f "$db" ]] && chmod 600 "$db" 2>/dev/null || true
    done
    [[ -f "${DROP_SHARED_CONF:-/opt/grin/conf/drop_shared.conf}" ]] && \
        chmod 600 "${DROP_SHARED_CONF:-/opt/grin/conf/drop_shared.conf}" 2>/dev/null || true
}

_dbk_restart_services() {
    local svc
    for svc in grin-drop-test grin-drop-main; do
        [[ -f "/etc/systemd/system/${svc}.service" ]] && {
            systemctl start "$svc" 2>/dev/null && success "$svc restarted." \
                || warn "$svc failed to start — check: journalctl -u $svc -n 30"
        }
    done
}

# ─── Restore (interactive) — handles new-format + legacy archives ───────────
dbk_restore() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Grin Drop — Restore from backup${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    command -v openssl >/dev/null 2>&1 || { error "openssl not found — cannot decrypt."; return 1; }
    mkdir -p "$DBK_BACKUP_DIR" 2>/dev/null || true

    echo -e "${BOLD}${YELLOW}┏━ HOW TO RESTORE (e.g. migrating to a new server) ━━━━━━━━━━┓${RESET}"
    echo -e "${BOLD}${YELLOW}┃${RESET} ${BOLD}1.${RESET} Copy the backup archive from the OLD box onto THIS one, into:"
    echo -e "${BOLD}${YELLOW}┃${RESET}      ${CYAN}$DBK_BACKUP_DIR/${RESET}   ${DIM}(scp or rsync it over)${RESET}"
    echo -e "${BOLD}${YELLOW}┃${RESET} ${BOLD}2.${RESET} Pick it from the list below."
    echo -e "${BOLD}${YELLOW}┃${RESET} ${BOLD}3.${RESET} Type the ${BOLD}personal key${RESET} you set on the old box. ${DIM}(The date is${RESET}"
    echo -e "${BOLD}${YELLOW}┃${RESET}      ${DIM}auto-read from the filename.)${RESET} ${RED}No key → cannot decrypt.${RESET}"
    echo -e "${BOLD}${YELLOW}┃${RESET} ${BOLD}4.${RESET} Confirm — files extract to their original ${BOLD}/opt/grin/…${RESET} paths"
    echo -e "${BOLD}${YELLOW}┃${RESET}      ${DIM}(wallets + seed + secrets + DB + config, both networks).${RESET}"
    echo -e "${BOLD}${YELLOW}┃${RESET} ${DIM}Fresh box: then Install (option 3) → Wallet listening (option 2)${RESET}"
    echo -e "${BOLD}${YELLOW}┃${RESET}   ${DIM}per network. Install re-creates the Node service + web files and${RESET}"
    echo -e "${BOLD}${YELLOW}┃${RESET}   ${DIM}KEEPS the restored DB/config/wallet. Domain/nginx (option 1) is${RESET}"
    echo -e "${BOLD}${YELLOW}┃${RESET}   ${DIM}NOT in the backup — rebuild it after.${RESET}"
    echo -e "${BOLD}${YELLOW}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${RESET}"
    echo ""

    # List new-format + legacy archives together, newest first.
    local -a baks=()
    while IFS= read -r f; do [[ -n "$f" ]] && baks+=("$f"); done \
        < <(ls -t "$DBK_BACKUP_DIR/${DBK_PREFIX}"*.tar.gz.enc \
                  "$DBK_BACKUP_DIR/${DBK_LEGACY_PREFIX}"*.enc 2>/dev/null || true)
    if [[ "${#baks[@]}" -eq 0 ]]; then
        warn "No backups found in $DBK_BACKUP_DIR."
        echo -e "  ${DIM}On a fresh machine, copy your grin_drop_backup_*.tar.gz.enc there first.${RESET}"
        return 1
    fi

    echo -e "  ${BOLD}Available backups (newest first):${RESET}"
    local i=1 f sz tag
    for f in "${baks[@]}"; do
        sz=$(du -sh "$f" 2>/dev/null | cut -f1 || echo "?")
        tag=""; [[ "$(basename "$f")" == "$DBK_LEGACY_PREFIX"* ]] && tag=" ${DIM}(legacy)${RESET}"
        echo -e "  ${GREEN}$i${RESET}) $(basename "$f")  ${DIM}($sz)${RESET}$tag"
        (( i++ ))
    done
    echo -e "  ${DIM}0) Cancel${RESET}"
    echo ""
    echo -ne "${BOLD}Select backup [1-${#baks[@]}/0]: ${RESET}"
    local sel; read -r sel || true
    [[ "$sel" == "0" || -z "$sel" ]] && return 1
    if ! [[ "$sel" =~ ^[0-9]+$ ]] || [[ "$sel" -lt 1 || "$sel" -gt "${#baks[@]}" ]]; then
        warn "Invalid selection."; return 1
    fi
    local chosen="${baks[$((sel-1))]}"
    echo ""
    info "Selected: $(basename "$chosen")"

    # Legacy archives use the old interactive-password + staging-rename layout.
    if [[ "$(basename "$chosen")" == "$DBK_LEGACY_PREFIX"* ]]; then
        _dbk_restore_legacy "$chosen"
        return
    fi

    # ── New-format: password = personal key + DDMMYYYY-from-filename ──────────
    local d; d=$(dbk_parse_date "$chosen") || { error "Cannot read date from filename: $(basename "$chosen")"; return 1; }
    local key pass tmp_clear
    read -rs -p "  Personal key for this backup: " key; echo ""
    [[ -z "$key" ]] && { warn "No key entered."; return 1; }
    pass="${key}${d}"; unset key
    tmp_clear=$(mktemp "/tmp/grin_drop_restore_XXXXXX.tar.gz") || { error "mktemp failed."; unset pass; return 1; }

    if ! gbe_decrypt "$chosen" "$tmp_clear" "$pass"; then
        rm -f "$tmp_clear"; unset pass
        error "Wrong key or corrupt backup."; return 1
    fi
    unset pass
    if ! tar -tzf "$tmp_clear" >/dev/null 2>&1; then
        rm -f "$tmp_clear"; error "Decrypted file is not a valid archive."; return 1
    fi
    success "Decrypted and validated."

    echo ""
    echo -e "  ${RED}${BOLD}This OVERWRITES current files at their original paths:${RESET}"
    tar -tzf "$tmp_clear" 2>/dev/null | awk -F/ 'NF>=3{print "/"$1"/"$2"/"$3}' | sort -u | sed 's|^|    |'
    echo ""
    echo -ne "  Type ${BOLD}RESTORE${RESET} to confirm (services + wallet listeners will be stopped): "
    local go; read -r go || true
    if [[ "$go" != "RESTORE" ]]; then rm -f "$tmp_clear"; info "Restore cancelled."; return 1; fi

    _dbk_stop_all

    if ! tar -xzf "$tmp_clear" -C / --preserve-permissions 2>/dev/null; then
        rm -f "$tmp_clear"; error "Extraction failed."; return 1
    fi
    rm -f "$tmp_clear"
    _dbk_fix_perms
    success "Restore complete — wallets, seed, secrets, DB and config are back in place."

    _dbk_restart_services
    echo ""
    echo -e "  ${BOLD}To finish (order matters — restore does NOT start listeners):${RESET}"
    echo -e "    1) ${BOLD}Install${RESET} (option 3) for each network — re-creates the Node.js"
    echo -e "       service + server/ + public_html/ + node_modules (excluded from the"
    echo -e "       backup). It KEEPS the restored DB, config and wallet, and offers to"
    echo -e "       start the service. ${DIM}(On a box that already had it, this just refreshes deps.)${RESET}"
    echo -e "    2) ${BOLD}Wallet listening${RESET} (option 2) ▸ Start Both — the restored .temp_<net>"
    echo -e "       passphrase opens the wallet with no prompt. The Owner API must be UP"
    echo -e "       for balance / claim / donate to work."
    echo -e "    3) ${BOLD}Start service${RESET} (option 6) if you skipped starting it in Install."
    echo -e "    4) ${BOLD}Create / Update domain${RESET} (option 1) to rebuild nginx + SSL."
    echo -e "    ${DIM}If a balance looks wrong after restore, run Setup wallet ▸ Scan once.${RESET}"
    mkdir -p "$(dirname "$DBK_LOG")"
    echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] restore from: $(basename "$chosen")" >> "$DBK_LOG" 2>/dev/null || true
    log "[dbk_restore] backup=$(basename "$chosen")"
}

# ─── Legacy restore — old grin_drop_all_backup_* (interactive pass + rename) ─
_dbk_restore_legacy() {
    local chosen="$1"
    echo -e "  ${DIM}Legacy archive — interactive password, staging-rename layout.${RESET}"
    echo -ne "  Backup password: "
    local bak_pass; read -rs bak_pass; echo ""
    local tmp_test="/tmp/grin_drop_restore_test_$$"
    if ! gbe_decrypt "$chosen" "$tmp_test" "$bak_pass"; then
        rm -f "$tmp_test"; error "Wrong password or corrupt backup."; unset bak_pass; return 1
    fi
    if ! tar -tzf "$tmp_test" &>/dev/null; then
        rm -f "$tmp_test"; error "Decrypted archive is not a valid tar.gz."; unset bak_pass; return 1
    fi
    success "Password verified — archive is valid."
    echo ""
    echo -e "  ${RED}${BOLD}⚠ Overwrites existing data for any networks found in the backup:${RESET}"
    tar -tzf "$tmp_test" 2>/dev/null | grep -v '/$' | sed 's|^|  → |'
    echo ""
    echo -ne "  Type ${BOLD}RESTORE${RESET} to confirm: "
    local confirm; read -r confirm || true
    if [[ "$confirm" != "RESTORE" ]]; then
        rm -f "$tmp_test"; unset bak_pass; info "Cancelled."; return 1
    fi

    _dbk_stop_all

    local tmp_dir="/tmp/grin_drop_restore_$$"
    mkdir -p "$tmp_dir"
    tar -xzf "$tmp_test" -C "$tmp_dir" 2>/dev/null || true
    rm -f "$tmp_test"; unset bak_pass

    if [[ -d "$tmp_dir/testnet" ]]; then
        info "Restoring testnet ..."
        [[ -f "$tmp_dir/testnet/drop.db" ]]        && { mkdir -p "$(dirname "$DBK_TEST_DB")"; cp "$tmp_dir/testnet/drop.db"        "$DBK_TEST_DB";                          chmod 600 "$DBK_TEST_DB";                          id grin &>/dev/null && chown grin:grin "$DBK_TEST_DB" 2>/dev/null || true; success "Testnet DB restored."; }
        [[ -f "$tmp_dir/testnet/grin_drop.conf" ]] && { cp "$tmp_dir/testnet/grin_drop.conf" "$DBK_TEST_DIR/grin_drop_test.conf";     chmod 600 "$DBK_TEST_DIR/grin_drop_test.conf";     id grin &>/dev/null && chown grin:grin "$DBK_TEST_DIR/grin_drop_test.conf" 2>/dev/null || true; success "Testnet config restored."; }
        [[ -f "$tmp_dir/testnet/wallet_pass" ]]    && { cp "$tmp_dir/testnet/wallet_pass"    "$DBK_TEST_DIR/.temp_test";              chmod 600 "$DBK_TEST_DIR/.temp_test";              id grin &>/dev/null && chown grin:grin "$DBK_TEST_DIR/.temp_test" 2>/dev/null || true; success "Testnet wallet pass restored."; }
        [[ -f "$tmp_dir/testnet/seed-words" ]]     && { cp "$tmp_dir/testnet/seed-words"     "$DBK_TEST_DIR/.word_test";              chmod 600 "$DBK_TEST_DIR/.word_test";              chown root:root "$DBK_TEST_DIR/.word_test" 2>/dev/null || true; success "Testnet seed words restored."; }
    fi
    if [[ -d "$tmp_dir/mainnet" ]]; then
        info "Restoring mainnet ..."
        [[ -f "$tmp_dir/mainnet/drop.db" ]]        && { mkdir -p "$(dirname "$DBK_MAIN_DB")"; cp "$tmp_dir/mainnet/drop.db"        "$DBK_MAIN_DB";                          chmod 600 "$DBK_MAIN_DB";                          id grin &>/dev/null && chown grin:grin "$DBK_MAIN_DB" 2>/dev/null || true; success "Mainnet DB restored."; }
        [[ -f "$tmp_dir/mainnet/grin_drop.conf" ]] && { cp "$tmp_dir/mainnet/grin_drop.conf" "$DBK_MAIN_DIR/grin_drop_main.conf";     chmod 600 "$DBK_MAIN_DIR/grin_drop_main.conf";     id grin &>/dev/null && chown grin:grin "$DBK_MAIN_DIR/grin_drop_main.conf" 2>/dev/null || true; success "Mainnet config restored."; }
        [[ -f "$tmp_dir/mainnet/wallet_pass" ]]    && { cp "$tmp_dir/mainnet/wallet_pass"    "$DBK_MAIN_DIR/.temp_main";              chmod 600 "$DBK_MAIN_DIR/.temp_main";              id grin &>/dev/null && chown grin:grin "$DBK_MAIN_DIR/.temp_main" 2>/dev/null || true; success "Mainnet wallet pass restored."; }
        [[ -f "$tmp_dir/mainnet/seed-words" ]]     && { cp "$tmp_dir/mainnet/seed-words"     "$DBK_MAIN_DIR/.word_main";              chmod 600 "$DBK_MAIN_DIR/.word_main";              chown root:root "$DBK_MAIN_DIR/.word_main" 2>/dev/null || true; success "Mainnet seed words restored."; }
    fi
    [[ -f "$tmp_dir/shared/drop_shared.conf" ]] && {
        cp "$tmp_dir/shared/drop_shared.conf" "${DROP_SHARED_CONF:-/opt/grin/conf/drop_shared.conf}"
        chmod 600 "${DROP_SHARED_CONF:-/opt/grin/conf/drop_shared.conf}"
        success "Shared config (domain settings) restored."
    }
    rm -rf "$tmp_dir"

    _dbk_fix_perms   # also chowns the new drop-<net>-data DB dirs to grin
    _dbk_restart_services
    echo ""
    warn "Legacy backups DO NOT include wallet_data/ — run Setup wallet ▸ Scan (or"
    warn "Recover from seed) for each network to rebuild the wallet from the seed words."
    log "[dbk_restore_legacy] backup=$(basename "$chosen")"
}

# ─── Daily schedule (cron) ──────────────────────────────────────────────────
# Self-contained wrapper (cron can't source the toolkit): reads the key from
# DBK_CONF, builds key+date, and runs the same two-phase tar | gzip | openssl |
# prune. Flags MUST stay byte-identical to dbk_backup_now so cron archives
# restore cleanly.
_dbk_write_wrapper() {
    cat > "$DBK_WRAPPER" <<WRAP
#!/bin/bash
# Grin Drop daily backup — generated by 052_grin_drop.sh. Do not edit.
set -uo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin   # cron has a minimal PATH; be explicit
CONF="$DBK_CONF"           # drop schedule/retention
KEYCONF="$GBE_CONF"        # SHARED personal key (one key for all products)
BACKUP_DIR="$DBK_BACKUP_DIR"
PREFIX="$DBK_PREFIX"
LOG="$DBK_LOG"
TEST_DIR="$DBK_TEST_DIR"; MAIN_DIR="$DBK_MAIN_DIR"
TEST_DB="$DBK_TEST_DB";   MAIN_DB="$DBK_MAIN_DB"
SHARED_CONF="${DROP_SHARED_CONF:-/opt/grin/conf/drop_shared.conf}"

TS=\$(date -u '+%Y-%m-%d %H:%M:%S UTC')
DBK_KEEP=$DBK_KEEP_DEFAULT
# shellcheck disable=SC1090
[[ -f "\$CONF" ]] && source "\$CONF"
GBE_PERSONAL_KEY_B64=""
# shellcheck disable=SC1090
[[ -f "\$KEYCONF" ]] && source "\$KEYCONF"
KEY=\$(printf '%s' "\$GBE_PERSONAL_KEY_B64" | base64 -d 2>/dev/null || true)
# Legacy fallback — pre-engine confs stored the key per-product.
[[ -n "\$KEY" ]] || KEY=\$(sed -n "s/^[A-Za-z_]*_PERSONAL_KEY_B64='\([^']*\)'.*/\1/p" "\$CONF" 2>/dev/null | head -1 | base64 -d 2>/dev/null || true)
[[ -n "\$KEY" ]] || { echo "[\$TS] ERROR: no personal key set" >> "\$LOG"; exit 1; }
[[ "\$DBK_KEEP" =~ ^[0-9]+\$ ]] || DBK_KEEP=$DBK_KEEP_DEFAULT

D=\$(date +%d%m%Y)
PASS="\${KEY}\${D}"
ARCHIVE="\$BACKUP_DIR/\${PREFIX}\${D}.tar.gz.enc"
mkdir -p "\$BACKUP_DIR"; chmod 700 "\$BACKUP_DIR" 2>/dev/null || true

LIVE=(); for s in "\$TEST_DIR" "\$MAIN_DIR" "\$SHARED_CONF"; do [[ -e "\$s" ]] && LIVE+=( "\${s#/}" ); done
[[ "\${#LIVE[@]}" -gt 0 ]] || { echo "[\$TS] ERROR: nothing to back up" >> "\$LOG"; exit 1; }

WORK=\$(mktemp /tmp/grin_drop_cronwork_XXXXXX.tar) || exit 1
STAGE=\$(mktemp -d /tmp/grin_drop_cronsnap_XXXXXX 2>/dev/null) || STAGE=""
DBRELS=()
if [[ -n "\$STAGE" ]]; then
    for db in "\$TEST_DB" "\$MAIN_DB"; do
        [[ -f "\$db" ]] || continue
        rel="\${db#/}"
        mkdir -p "\$STAGE/\$(dirname "\$rel")"
        python3 -c 'import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()' \
            "\$db" "\$STAGE/\$rel" 2>/dev/null || cp -p "\$db" "\$STAGE/\$rel"
        DBRELS+=( "\$rel" )
    done
fi
EX=( --exclude="opt/grin/drop-test/server" --exclude="opt/grin/drop-main/server" \
     --exclude="opt/grin/drop-test/public_html" --exclude="opt/grin/drop-main/public_html" \
     --exclude="*/node_modules" --exclude="*.log" \
     --exclude="*.db" --exclude="*.db-wal" --exclude="*.db-journal" )
tar -cf "\$WORK" "\${EX[@]}" -C / "\${LIVE[@]}" 2>/dev/null || true
if [[ -n "\$STAGE" && "\${#DBRELS[@]}" -gt 0 && -f "\$WORK" ]]; then
    tar -rf "\$WORK" -C "\$STAGE" "\${DBRELS[@]}" 2>/dev/null || true
fi
[[ -n "\$STAGE" ]] && rm -rf "\$STAGE"
TMP=\$(mktemp /tmp/grin_drop_cronbak_XXXXXX.tar.gz) || { rm -f "\$WORK"; exit 1; }
gzip -c "\$WORK" > "\$TMP" 2>/dev/null || { rm -f "\$WORK" "\$TMP"; echo "[\$TS] ERROR: gzip failed" >> "\$LOG"; exit 1; }
rm -f "\$WORK"
[[ -s "\$TMP" ]] || { rm -f "\$TMP"; echo "[\$TS] ERROR: empty archive (disk full?)" >> "\$LOG"; exit 1; }
if openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass fd:3 \
        -in "\$TMP" -out "\$ARCHIVE" 3<<<"\$PASS" 2>/dev/null; then
    chmod 600 "\$ARCHIVE"; chown root:root "\$ARCHIVE" 2>/dev/null || true
    SZ=\$(du -sh "\$ARCHIVE" 2>/dev/null | cut -f1 || echo "?")
    echo "[\$TS] backup created: \$(basename "\$ARCHIVE") (\$SZ)" >> "\$LOG"
else
    rm -f "\$TMP" "\$ARCHIVE"; echo "[\$TS] ERROR: openssl failed" >> "\$LOG"; exit 1
fi
rm -f "\$TMP"; unset PASS KEY

# Offsite push (scp) — silent no-op unless configured via the toolkit menus
if [[ -x "${GBP_BIN:-/usr/local/bin/grin-backup-push}" ]]; then
    "${GBP_BIN:-/usr/local/bin/grin-backup-push}" "\$ARCHIVE" \
        || echo "[\$TS] WARN: offsite push failed — see ${GBP_LOG:-/opt/grin/logs/backup-push.log}" >> "\$LOG"
fi

N=\$(ls -1 "\$BACKUP_DIR/\${PREFIX}"*.tar.gz.enc 2>/dev/null | wc -l)
if [[ "\$N" -gt "\$DBK_KEEP" ]]; then
    ls -t "\$BACKUP_DIR/\${PREFIX}"*.tar.gz.enc 2>/dev/null \
        | tail -n +\$((DBK_KEEP + 1)) | xargs rm -f 2>/dev/null || true
    echo "[\$TS] pruned (kept newest \$DBK_KEEP)" >> "\$LOG"
fi
WRAP
    chmod 750 "$DBK_WRAPPER"
}

dbk_schedule() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Grin Drop — Schedule daily backup${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    dbk_load_conf

    if [[ -f "$DBK_CRON" ]]; then
        echo -e "  Status: ${GREEN}enabled${RESET}  ${DIM}(daily $(printf '%02d:%02d' "$DBK_HOUR" "$DBK_MIN"), keep $DBK_KEEP)${RESET}"
        echo -e "  ${DIM}cron: $DBK_CRON · log: $DBK_LOG${RESET}"
        echo ""
        echo -e "  ${RED}1${RESET}) Disable daily backup"
        echo -e "  ${DIM}0) Back${RESET}"
        echo -ne "Choice: "
        local c; read -r c || true
        if [[ "$c" == "1" ]]; then
            rm -f "$DBK_CRON" "$DBK_WRAPPER"
            success "Daily backup disabled."
        fi
        return 0
    fi

    echo -e "  ${DIM}Runs once a day, keeps the newest $DBK_KEEP archives.${RESET}"
    echo -e "  ${DIM}Uses the saved personal key — no prompt at run time.${RESET}"
    echo ""
    _dbk_require_key || { info "Scheduling needs a personal key."; return 1; }

    _dbk_write_wrapper
    cat > "$DBK_CRON" <<EOF
# Grin Drop daily backup — generated by 052_grin_drop.sh
$DBK_MIN $DBK_HOUR * * * root $DBK_WRAPPER
EOF
    success "Daily backup enabled → $DBK_CRON  (daily $(printf '%02d:%02d' "$DBK_HOUR" "$DBK_MIN"))"
    echo -e "  ${DIM}Wrapper: $DBK_WRAPPER · log: $DBK_LOG${RESET}"
}

# ─── Settings (key · retention · list) ──────────────────────────────────────
dbk_list_backups() {
    echo ""
    echo -e "  ${BOLD}Backups in $DBK_BACKUP_DIR:${RESET}"
    local any=0 f sz tag
    while IFS= read -r f; do
        [[ -n "$f" ]] || continue
        any=1; sz=$(du -sh "$f" 2>/dev/null | cut -f1 || echo "?")
        tag=""; [[ "$(basename "$f")" == "$DBK_LEGACY_PREFIX"* ]] && tag=" ${DIM}(legacy)${RESET}"
        echo -e "    $(basename "$f")  ${DIM}($sz)${RESET}$tag"
    done < <(ls -t "$DBK_BACKUP_DIR/${DBK_PREFIX}"*.tar.gz.enc \
                   "$DBK_BACKUP_DIR/${DBK_LEGACY_PREFIX}"*.enc 2>/dev/null || true)
    [[ "$any" -eq 0 ]] && echo -e "    ${DIM}(none yet)${RESET}"
}

dbk_settings() {
    local c
    while true; do
        clear
        dbk_load_conf
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Grin Drop — Backup settings${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        local key_state="${RED}not set${RESET}"; [[ -n "$DBK_PERSONAL_KEY" ]] && key_state="${GREEN}set${RESET}"
        echo -e "  Personal key : $key_state   ${DIM}($GBE_CONF · shared by all products)${RESET}"
        echo -e "  Retention    : ${BOLD}$DBK_KEEP${RESET} archives"
        echo -e "  Schedule time: $(printf '%02d:%02d' "$DBK_HOUR" "$DBK_MIN")"
        dbk_list_backups
        echo ""
        echo -e "  ${GREEN}1${RESET}) Set / change personal key"
        echo -e "  ${GREEN}2${RESET}) Set retention (number of archives to keep)"
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-2/0]: ${RESET}"
        read -r c || c=0
        case "$c" in
            "") continue ;;
            1) dbk_set_key || true; pause ;;
            2) echo -ne "  Keep how many archives [current $DBK_KEEP]: "
               local n; read -r n || true
               if [[ "$n" =~ ^[0-9]+$ ]] && [[ "$n" -ge 1 ]]; then
                   DBK_KEEP="$n"; dbk_save_conf; success "Retention set to $n."
               else
                   warn "Unchanged (enter a positive number)."
               fi
               pause ;;
            0) return ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# ─── Backup & Restore menu (top-level option B) ─────────────────────────────
drop_backup_menu() {
    local choice
    while true; do
        clear
        dbk_load_conf
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Grin Drop — Backup & Restore${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        local sched="${RED}off${RESET}"; [[ -f "$DBK_CRON" ]] && sched="${GREEN}daily $(printf '%02d:%02d' "$DBK_HOUR" "$DBK_MIN")${RESET}"
        local key_state="${RED}not set${RESET}"; [[ -n "$DBK_PERSONAL_KEY" ]] && key_state="${GREEN}set${RESET}"
        local push_state="${DIM}off${RESET}"; gbp_configured && push_state="${GREEN}on${RESET}"
        echo -e "  ${DIM}Dir: $DBK_BACKUP_DIR · key: ${RESET}$key_state${DIM} · schedule: ${RESET}$sched${DIM} · offsite: ${RESET}$push_state"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Backup now            ${DIM}(encrypted archive: wallets + seed + DB + config)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Restore from backup   ${DIM}(one-shot extract to original paths)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Schedule daily backup ${DIM}(cron · ${DBK_KEEP}-archive retention)${RESET}"
        echo -e "  ${GREEN}4${RESET}) Settings              ${DIM}(personal key · retention · list)${RESET}"
        echo -e "  ${GREEN}5${RESET}) Offsite push (scp)    ${DIM}(auto-copy each archive to a remote server)${RESET}"
        echo ""
        echo -e "  ${DIM}↩  Press Enter to refresh${RESET}"
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-5/0]: ${RESET}"
        read -r choice || choice=0
        case "$choice" in
            "") continue ;;
            1) dbk_backup_now || true; pause ;;
            2) dbk_restore    || true; pause ;;
            3) dbk_schedule   || true; pause ;;
            4) dbk_settings   || true ;;
            5) gbp_setup      || true ;;
            0) return ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}
