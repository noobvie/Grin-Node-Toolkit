# =============================================================================
# lib/grin_backup_verify.sh — backup VERIFIER (089 Backup & Restore ▸ V)
# =============================================================================
# Proves a backup is restorable without touching a live path: decrypt → extract
# EVERYTHING into a private sandbox → read the restored data → report ✓/✗/⚠
# with a data summary → wipe the sandbox. Nothing is ever extracted to /.
#
#   gbv_verify_newest_all   newest archive of each product in $GBV_BACKUP_DIR
#                           (engine archives, pool DB snapshots, Script 04 onion
#                           tarballs) + freshness vs its schedule + offsite size
#   gbv_verify_file <path>  one archive or ANY file (.tar.gz/.tgz/.tar/.gz/.zip/
#                           .enc/.db/.sqlite/.sql). A file with no profile proves
#                           only that it is READABLE, never that it is COMPLETE.
#   gbv_menu                the V submenu (1 newest · 2 a file · 3 weekly check)
#   gbv_refresh_installed   refresh the weekly check's lib copies (089 menu open)
# rc 0 = every check passed (⚠ allowed) · 1 = at least one ✗.
#
# PROFILES (below, as data) are the per-product facts read from each product's
# own source list: required members, which config files must parse, the
# password rule and the schedule that sets the freshness limit. Keep them in
# step with the product libs they cite. The data checks themselves (SQLite,
# JSON, TOML, key shapes, SQL dumps, safe unzip) are grin_backup_verify_check.py.
#
# Sandbox: mktemp -d $GBV_TMP_ROOT/grin-verify.XXXXXX (mode 700). EXIT/INT/TERM/
# HUP traps that wipe it are set for one verification and the caller's own traps
# are put back afterwards, because this lib is sourced into an interactive menu.
# A signal wipes the sandbox, restores the caller's trap and re-raises the signal
# on $BASHPID (the menu runs each verification in a subshell, so Ctrl-C ends that
# verification and returns to the menu). Sandboxes older than $GBV_STALE_MIN
# minutes (a run killed with -9) are swept at the start of every run.
#
# Writes only: the sandbox, $GBV_LOG (mode 600), and for the weekly check
# $GBV_BIN, $GBV_CRON and the lib copies + version file in $GBV_LIB_INSTALL_DIR.
# The personal key is read without the engine's legacy-key migration, so a
# verify never writes grin_backup.conf. Remote: read-only `wc -c` over ssh.
# Passwords travel via fd:3 (gbe_decrypt) and are never printed; a wallet seed
# is checked for presence and shape only.
#
# Convention: sourced lib → NO shebang / NO `set -e`. Callers run it under
# `|| true`, so every create/move/delete is guarded on its own.
# =============================================================================

[[ -n "${_GRIN_BACKUP_VERIFY_SH_LOADED:-}" ]] && return 0
_GRIN_BACKUP_VERIFY_SH_LOADED=1

_GBV_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$_GBV_LIB_DIR/grin_backup_engine.sh"

# ─── Paths (env-overridable for testing) ─────────────────────────────────────
GBV_BACKUP_DIR="${GBV_BACKUP_DIR:-$GBE_BACKUP_DIR}"
GBV_LEGACY_DIR="${GBV_LEGACY_DIR:-/opt/grin/temp}"          # 089's pre-engine archives
GBV_TMP_ROOT="${GBV_TMP_ROOT:-/var/tmp}"                    # /var/tmp: disk-backed, unlike a tmpfs /tmp
GBV_LOG="${GBV_LOG:-/opt/grin/logs/backup-verify.log}"
GBV_BIN="${GBV_BIN:-/usr/local/bin/grin-backup-verify}"
GBV_CRON="${GBV_CRON:-/etc/cron.d/grin-backup-verify}"
GBV_CRON_DIR="${GBV_CRON_DIR:-/etc/cron.d}"                 # where product backup crons live
GBV_CONF_DIR="${GBV_CONF_DIR:-/opt/grin/conf}"              # product backup confs (read only)
GBV_LIB_INSTALL_DIR="${GBV_LIB_INSTALL_DIR:-/opt/grin/lib}"
GBV_CHECK_PY="${GBV_CHECK_PY:-$_GBV_LIB_DIR/grin_backup_verify_check.py}"
# Alert channels for the weekly run: the node event recorder's (086), read-only and
# allow-listed. Delivery is lib/grin_alert_send.sh beside this lib.
GBV_ALERT_CONF="${GBV_ALERT_CONF:-/opt/grin/conf/node-events/recorder.conf}"
GBV_OWNER_UID="${GBV_OWNER_UID:-0}"                         # who must own the installed copies
GBV_STALE_MIN="${GBV_STALE_MIN:-360}"
GBV_TOOLKIT_CRON_TAG="# grin-toolkit-auto-backup"           # 089's root-crontab tag (CRON_TAG there)
# 1 = may prompt for an older key · 0 = cron: never prompts · empty = ask stdin.
GBV_INTERACTIVE="${GBV_INTERACTIVE:-}"

# ─── Profiles ────────────────────────────────────────────────────────────────
# Member patterns are relative to the archive root with no leading "./"; `*`
# matches across "/" (python fnmatch). "a|b" = either one satisfies the item.
# "<dir>=><member>" = the member is required only when <dir> is in the archive.
# A required member must be a real dir or a regular, non-empty, non-symlink file;
# a required .db must open as SQLite and pass integrity_check.
#   REQ   missing → ✗          OPT   reported present / absent
#   PASS  engine  = <personal key><DDMMYYYY, LAST name field> (gbe_parse_date)
#         dbsnap  = <personal key><DDMMYYYY> from …_dbsnap_<DDMMYYYY>_<HHMM> (UTC)
#         legacy  = DDMMYYYY alone, from temp_dir_<YYYYMMDD>_… (089 restore)
#         plain   = not encrypted
#   SCHED daily:<cron.d file> (limit 26 h) · dbsnap:<cron.d file>:<conf> (2 × interval)
#         toolkit (089 root crontab: every day → 26 h, else 8 days) · none
#   MANIFEST 1 = every conf:/wallet:/fidelius-wallet:/database: path in MANIFEST.txt
#         (089 run_backup) is a required member too.
# JSON/TOML files named in REQ/OPT must parse (✗); any other one that fails is ⚠.
declare -gA GBV_P_LABEL GBV_P_PASS GBV_P_SCHED GBV_P_REQ GBV_P_OPT GBV_P_MANIFEST
GBV_PROFILES=(toolkit pubpool pubpooltestnet pubpool-dbsnap pubpooltestnet-dbsnap
              solo drop floonet transporter tor-onion legacy legacy-plain engine)

# 089_backup_restore.sh run_backup: staged MANIFEST.txt + crontabs/ + live sources.
GBV_P_LABEL[toolkit]="Toolkit backup (08 ▸ 9)"
GBV_P_PASS[toolkit]="engine"; GBV_P_SCHED[toolkit]="toolkit"; GBV_P_MANIFEST[toolkit]=1
GBV_P_REQ[toolkit]="MANIFEST.txt crontabs"
GBV_P_OPT[toolkit]="opt/grin/conf opt/grin/keys opt/grin/wallet etc/nginx/sites-available etc/letsencrypt/live opt/grin/grin-stats/stats.db opt/grin/fidelius etc/floonet-rs"

# 07_lib_pool_backup.sh _pbk_sources/_pbk_make_tar (and its cron wrapper's LIVE list).
# The wallet dir can be pinned elsewhere (pw_wallet_dir), hence the */ prefix.
GBV_P_LABEL[pubpool]="Public pool hub, mainnet — daily full archive"
GBV_P_PASS[pubpool]="engine"; GBV_P_SCHED[pubpool]="daily:grin-pool-manager-backup"
GBV_P_REQ[pubpool]="opt/grin/pubpool/mainnet/pool.db opt/grin/conf/grin_pubpool.json */wallet_data/wallet.seed */grin-wallet.toml"
GBV_P_OPT[pubpool]="opt/grin/pubpool/mainnet/.wallet_pass opt/grin/conf/wg/server_private.key etc/wireguard/wg-grinpool.conf etc/nginx/sites-available/grin-public-pool-mainnet opt/grin/pubgames-data/mainnet/grinium-games.db"

GBV_P_LABEL[pubpooltestnet]="Public pool hub, testnet — daily full archive"
GBV_P_PASS[pubpooltestnet]="engine"; GBV_P_SCHED[pubpooltestnet]="daily:grin-pool-manager-testnet-backup"
GBV_P_REQ[pubpooltestnet]="opt/grin/pubpool/testnet/pool.db opt/grin/conf/grin_pubpool_testnet.json */wallet_data/wallet.seed */grin-wallet.toml"
GBV_P_OPT[pubpooltestnet]="opt/grin/pubpool/testnet/.wallet_pass opt/grin/conf/wg-testnet/server_private.key etc/wireguard/wg-grinpool-tn.conf etc/nginx/sites-available/grin-public-pool-testnet opt/grin/pubgames-data/testnet/grinium-games.db"

# 07_lib_pool_dbsnap.sh: pool.db (+ games DB) only — no seed, config, WG key or vhost.
GBV_P_LABEL[pubpool-dbsnap]="Public pool hub, mainnet — DB snapshot"
GBV_P_PASS[pubpool-dbsnap]="dbsnap"; GBV_P_SCHED[pubpool-dbsnap]="dbsnap:grin-pool-manager-dbsnap:grin_pubpool_backup.conf"
GBV_P_REQ[pubpool-dbsnap]="opt/grin/pubpool/mainnet/pool.db"
GBV_P_OPT[pubpool-dbsnap]="opt/grin/pubgames-data/mainnet/grinium-games.db"

GBV_P_LABEL[pubpooltestnet-dbsnap]="Public pool hub, testnet — DB snapshot"
GBV_P_PASS[pubpooltestnet-dbsnap]="dbsnap"; GBV_P_SCHED[pubpooltestnet-dbsnap]="dbsnap:grin-pool-manager-testnet-dbsnap:grin_pubpool_backup_testnet.conf"
GBV_P_REQ[pubpooltestnet-dbsnap]="opt/grin/pubpool/testnet/pool.db"
GBV_P_OPT[pubpooltestnet-dbsnap]="opt/grin/pubgames-data/testnet/grinium-games.db"

# 07_solo_backup.sh _sb_sources: wallets (binary included, sw_dir = solowallet/<net>)
# + stats DBs + payment flag. Each network dir present needs its own seed + toml.
GBV_P_LABEL[solo]="Solo mining (wallets + stats)"
GBV_P_PASS[solo]="engine"; GBV_P_SCHED[solo]="daily:grin-solo-backup"
GBV_P_REQ[solo]="opt/grin/solowallet/*/wallet_data/wallet.seed
 opt/grin/solowallet/mainnet=>opt/grin/solowallet/mainnet/wallet_data/wallet.seed
 opt/grin/solowallet/mainnet=>opt/grin/solowallet/mainnet/grin-wallet.toml
 opt/grin/solowallet/testnet=>opt/grin/solowallet/testnet/wallet_data/wallet.seed
 opt/grin/solowallet/testnet=>opt/grin/solowallet/testnet/grin-wallet.toml"
GBV_P_OPT[solo]="opt/grin/solo-stats opt/grin/conf/grin_solo_payment.json"

# 059_lib_backup.sh _dbk_sources + the drop-<net>-data DB snapshots.
GBV_P_LABEL[drop]="Grin Drop (both networks)"
GBV_P_PASS[drop]="engine"; GBV_P_SCHED[drop]="daily:grin-drop-backup"
GBV_P_REQ[drop]="opt/grin/drop-test/wallet_data/wallet.seed|opt/grin/drop-main/wallet_data/wallet.seed
 opt/grin/drop-main=>opt/grin/drop-main/wallet_data/wallet.seed
 opt/grin/drop-main=>opt/grin/drop-main/grin-wallet.toml
 opt/grin/drop-test=>opt/grin/drop-test/wallet_data/wallet.seed
 opt/grin/drop-test=>opt/grin/drop-test/grin-wallet.toml"
GBV_P_OPT[drop]="opt/grin/drop-test-data/drop-test.db opt/grin/drop-main-data/drop-main.db opt/grin/conf/drop_shared.conf"

# 091_lib_floonet.sh flr_backup_now: staged etc-floonet-rs/ state/ toolkit/.
GBV_P_LABEL[floonet]="Floonet relay"
GBV_P_PASS[floonet]="engine"; GBV_P_SCHED[floonet]="daily:grin-floonet-backup"
GBV_P_REQ[floonet]="etc-floonet-rs/config.toml"
GBV_P_OPT[floonet]="state/*.db toolkit/grin_floonet.conf"

# 093_lib_backup.sh trp_backup_now: staged <main|test>/ agent-<net>/ tor-<net>/ toolkit/.
GBV_P_LABEL[transporter]="Grin Transporter"
GBV_P_PASS[transporter]="engine"; GBV_P_SCHED[transporter]="daily:grin-transporter-backup"
GBV_P_REQ[transporter]="main/config.json|test/config.json
 main=>main/config.json test=>test/config.json
 agent-mainnet=>agent-mainnet/agent.json agent-testnet=>agent-testnet/agent.json"
GBV_P_OPT[transporter]="main/transporter.db test/transporter.db toolkit/grin_transporter.conf tor-*/hs_ed25519_secret_key"

# 04_grin_node_foreign_api.sh _backup_tor_identity: flat, unencrypted, made on demand.
GBV_P_LABEL[tor-onion]="Node .onion identity (Script 04, unencrypted)"
GBV_P_PASS[tor-onion]="plain"; GBV_P_SCHED[tor-onion]="none"
GBV_P_REQ[tor-onion]="hs_ed25519_secret_key"
GBV_P_OPT[tor-onion]="hs_ed25519_public_key hostname"

# 089 pre-engine archives: temp_dir_* (date-derived password) and plain grin_backup_*.
GBV_P_LABEL[legacy]="Legacy toolkit archive (pre-engine, encrypted)"
GBV_P_PASS[legacy]="legacy"; GBV_P_SCHED[legacy]="none"
GBV_P_REQ[legacy]=""
GBV_P_OPT[legacy]="MANIFEST.txt crontabs opt/grin/conf"

GBV_P_LABEL[legacy-plain]="Legacy toolkit archive (pre-engine, NOT encrypted)"
GBV_P_PASS[legacy-plain]="plain"; GBV_P_SCHED[legacy-plain]="none"
GBV_P_REQ[legacy-plain]=""
GBV_P_OPT[legacy-plain]="MANIFEST.txt crontabs opt/grin/conf"

# Any other grin_<product>_backup_<date>.tar.gz.enc — engine password, no member list.
GBV_P_LABEL[engine]="Engine archive (no product profile)"
GBV_P_PASS[engine]="engine"; GBV_P_SCHED[engine]="none"
GBV_P_REQ[engine]=""; GBV_P_OPT[engine]=""

# Never inside any archive: the shared personal key and the offsite target (089 and
# every product exclude them — the key lives in the operator's head).
GBV_FORBID="grin_backup.conf|*/grin_backup.conf grin_backup_remote.conf|*/grin_backup_remote.conf"

# Basename → profile id. rc 1 = no profile (any-file mode).
gbv_profile_of() {
    local b="${1##*/}"
    case "$b" in
        grin_toolkit_backup_*.tar.gz.enc)          echo toolkit ;;
        grin_pubpool_backup_*.tar.gz.enc)          echo pubpool ;;
        grin_pubpooltestnet_backup_*.tar.gz.enc)   echo pubpooltestnet ;;
        grin_pubpool_dbsnap_*.tar.gz.enc)          echo pubpool-dbsnap ;;
        grin_pubpooltestnet_dbsnap_*.tar.gz.enc)   echo pubpooltestnet-dbsnap ;;
        grin_solo_backup_*.tar.gz.enc)             echo solo ;;
        grin_drop_backup_*.tar.gz.enc)             echo drop ;;
        grin_floonet_backup_*.tar.gz.enc)          echo floonet ;;
        grin_transporter_backup_*.tar.gz.enc)      echo transporter ;;
        grin_tor_onion_mainnet.tar.gz|grin_tor_onion_testnet.tar.gz) echo tor-onion ;;
        temp_dir_*.tar.gz.enc)                     echo legacy ;;
        grin_backup_*.tar.gz)                      echo legacy-plain ;;
        # 059's pre-engine archives take a typed password, not the engine one.
        grin_drop_all_backup_*) return 1 ;;
        grin_*_backup_*.tar.gz.enc)
            if gbe_parse_date "$b" >/dev/null; then echo engine; else return 1; fi ;;
        *) return 1 ;;
    esac
}

# ─── Output / log ────────────────────────────────────────────────────────────
_GBV_NBAD=0; _GBV_NWARN=0
_GBV_SANDBOX=""; _GBV_OLD_TRAPS=""; _GBV_TRAPS_SET=0; _GBV_KEY=""

# Member names come from the archive: control characters would drive the terminal.
_gbv_clean() { local s="$1"; printf '%s' "${s//[$'\001'-$'\037'$'\177']/?}"; }

# The log holds archive names and results, nothing secret, but stays 600 like every
# other backup file.
_gbv_log_init() {
    mkdir -p "$(dirname "$GBV_LOG")" 2>/dev/null || return 0
    ( umask 077; : >> "$GBV_LOG" ) 2>/dev/null || return 0
    chmod 600 "$GBV_LOG" 2>/dev/null || true
    return 0
}

_gbv_log() {
    printf '[%s] %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "$(_gbv_clean "$*")" >> "$GBV_LOG" 2>/dev/null || true
}

# _gbv_line <OK|BAD|WARN|INFO> <text> — prints one report line and logs it.
_gbv_line() {
    local st="$1" msg sym col
    msg="$(_gbv_clean "$2")"
    case "$st" in
        OK)   sym="✓"; col="$GREEN" ;;
        BAD)  sym="✗"; col="$RED";    _GBV_NBAD=$((_GBV_NBAD + 1)) ;;
        WARN) sym="⚠"; col="$YELLOW"; _GBV_NWARN=$((_GBV_NWARN + 1)) ;;
        *)    sym="·"; col="$DIM" ;;
    esac
    if [[ -t 1 ]]; then
        printf '  %b%s%b %s\n' "$col" "$sym" "$RESET" "$msg"
    else
        printf '  %s %s\n' "$sym" "$msg"
    fi
    _gbv_log "  $sym $msg"
}

_gbv_head() {
    local t; t="$(_gbv_clean "$1")"
    if [[ -t 1 ]]; then
        printf '\n%b── %s%b\n' "$BOLD" "$t" "$RESET"
    else
        printf '\n── %s\n' "$t"
    fi
    _gbv_log "── $t"
}

_gbv_human() {
    local n="${1:-0}"
    if command -v numfmt >/dev/null 2>&1; then
        numfmt --to=iec --suffix=B "$n" 2>/dev/null || echo "${n} B"
    else
        echo "${n} B"
    fi
}

_gbv_is_interactive() {
    case "$GBV_INTERACTIVE" in
        1) return 0 ;;
        0) return 1 ;;
    esac
    [[ -t 0 ]]
}

_gbv_pause() { echo ""; echo -ne "${DIM}Press Enter to continue...${RESET}"; read -r _ || true; }

# ─── Personal key, read-only ─────────────────────────────────────────────────
# The engine's gbe_load_key adopts a legacy per-product key by WRITING
# grin_backup.conf; a verifier must not change the box, so the same sources are
# read here without that step (shared conf first, then the legacy confs).
_gbv_read_key() {
    local f b64
    _GBV_KEY=""
    for f in "$GBE_CONF" "$GBE_LEGACY_SOLO_CONF" "$GBE_LEGACY_DROP_CONF"; do
        [[ -f "$f" && -r "$f" ]] || continue
        b64=$(sed -n "s/^[A-Za-z_]*_PERSONAL_KEY_B64='\([^']*\)'.*/\1/p" "$f" 2>/dev/null | head -1)
        [[ -n "$b64" ]] || continue
        _GBV_KEY=$(printf '%s' "$b64" | base64 -d 2>/dev/null) || _GBV_KEY=""
        if [[ -n "$_GBV_KEY" ]]; then return 0; fi
    done
    return 0
}

# ─── Sandbox + traps ─────────────────────────────────────────────────────────
_gbv_cleanup() {
    # Only ever a directory this lib created (name prefix checked before rm -rf).
    if [[ -n "$_GBV_SANDBOX" && "$_GBV_SANDBOX" == "$GBV_TMP_ROOT"/grin-verify.* && -d "$_GBV_SANDBOX" && ! -L "$_GBV_SANDBOX" ]]; then
        chmod -R u+rwX "$_GBV_SANDBOX" 2>/dev/null || true
        rm -rf "$_GBV_SANDBOX" 2>/dev/null || true
    fi
    _GBV_SANDBOX=""
    return 0
}

_gbv_traps_restore() {
    [[ "$_GBV_TRAPS_SET" == "1" ]] || return 0
    trap - EXIT INT TERM HUP
    if [[ -n "$_GBV_OLD_TRAPS" ]]; then eval "$_GBV_OLD_TRAPS"; fi
    _GBV_OLD_TRAPS=""; _GBV_TRAPS_SET=0
    return 0
}

_gbv_on_signal() {
    _gbv_cleanup
    _gbv_traps_restore
    kill -s "$1" "$BASHPID"
}

# In a subshell `trap -p` still prints the PARENT's traps, which are not active there;
# restoring them would arm the parent's EXIT handler (e.g. an rm -rf of its temp dir)
# to run when the subshell ends. So a subshell restores the defaults instead.
_gbv_traps_set() {
    if [[ "$BASHPID" == "$$" ]]; then
        _GBV_OLD_TRAPS="$(trap -p EXIT INT TERM HUP)"
    else
        _GBV_OLD_TRAPS=""
    fi
    _GBV_TRAPS_SET=1
    trap '_gbv_cleanup' EXIT
    trap '_gbv_on_signal INT' INT
    trap '_gbv_on_signal TERM' TERM
    trap '_gbv_on_signal HUP' HUP
}

# Sandboxes a killed run left behind (kill -9, power loss) hold decrypted secrets.
# Swept under a flock so two runs never race; only our own grin-verify.* dirs,
# never through a symlink, and never a lock file someone else planted.
_gbv_sweep_stale() {
    local lock="$GBV_TMP_ROOT/.grin-verify.lock" d
    command -v flock >/dev/null 2>&1 || return 0
    if [[ -L "$lock" ]] || { [[ -e "$lock" ]] && [[ "$(stat -c %u "$lock" 2>/dev/null)" != "$(id -u)" ]]; }; then
        _gbv_log "  ⚠ $lock is a symlink or not ours — stale-sandbox sweep skipped"
        return 0
    fi
    {
        if flock -w 10 8; then
            while IFS= read -r -d '' d; do
                [[ "$d" == "$GBV_TMP_ROOT"/grin-verify.* && -d "$d" && ! -L "$d" ]] || continue
                chmod -R u+rwX "$d" 2>/dev/null || true
                if rm -rf "$d" 2>/dev/null; then _gbv_log "  removed a stale sandbox $d"; fi
            done < <(find "$GBV_TMP_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'grin-verify.*' \
                         -mmin +"$GBV_STALE_MIN" -print0 2>/dev/null)
        fi
    } 8>>"$lock" || true
    chmod 600 "$lock" 2>/dev/null || true
    return 0
}

_gbv_df_kb() {  # <field 2=size 4=avail>
    local kb
    kb=$(df -Pk "$GBV_TMP_ROOT" 2>/dev/null | awk -v f="$1" 'NR==2{print $f}')
    [[ "$kb" =~ ^[0-9]+$ ]] || kb=0
    echo "$kb"
}

# Bytes that must stay free after a step: the sandbox shares the disk with live
# databases, so max(2 GiB, 10 % of the filesystem). GBV_RESERVE_BYTES overrides.
_gbv_reserve() {
    if [[ "${GBV_RESERVE_BYTES:-}" =~ ^[0-9]+$ ]]; then echo "$GBV_RESERVE_BYTES"; return 0; fi
    local tenth=$(( $(_gbv_df_kb 2) * 1024 / 10 )) two=$((2 * 1024 * 1024 * 1024))
    if [[ "$tenth" -gt "$two" ]]; then echo "$tenth"; else echo "$two"; fi
}

# Bytes a step may still use (free − reserve, ≥ 0).
_gbv_budget() {
    local b=$(( $(_gbv_df_kb 4) * 1024 - $(_gbv_reserve) ))
    if [[ "$b" -lt 0 ]]; then b=0; fi
    echo "$b"
}

# _gbv_space_ok <bytes needed> <what> — +10 % margin, reserve kept. rc 1 (and ✗) when short.
_gbv_space_ok() {
    local need=$(( ${1:-0} + ${1:-0} / 10 )) budget
    budget=$(_gbv_budget)
    if [[ "$budget" -lt "$need" ]]; then
        _gbv_line BAD "not enough space in $GBV_TMP_ROOT for $2: needs $(_gbv_human "$need") (incl. 10 % margin) and must leave $(_gbv_human "$(_gbv_reserve)") free for the live services — nothing written"
        return 1
    fi
    return 0
}

# ─── Python checks (grin_backup_verify_check.py) ─────────────────────────────
# Run isolated (-I) from /, so nothing in an extracted tree can shadow a module.
_gbv_py() {
    if ! command -v python3 >/dev/null 2>&1; then
        printf 'WARN\tpython3 not found — data checks (SQLite, JSON, TOML, key formats) skipped\n'
        return 0
    fi
    if [[ ! -r "$GBV_CHECK_PY" ]]; then
        printf 'BAD\tdata checker %s missing — data checks not run\n' "$GBV_CHECK_PY"
        return 0
    fi
    ( cd / && python3 -I "$GBV_CHECK_PY" "$@" ) 2>/dev/null \
        || printf 'BAD\tdata check failed to run (python3 error)\n'
}

# Feed tagged lines into the report. META lines are collected into _GBV_META.
_GBV_META=""
_gbv_emit() {
    local st msg
    while IFS=$'\t' read -r st msg; do
        [[ -n "$st" ]] || continue
        if [[ "$st" == "META" ]]; then _GBV_META+="$msg"$'\n'; continue; fi
        _gbv_line "$st" "$msg"
    done
    return 0
}

# ─── Decrypt ─────────────────────────────────────────────────────────────────
# DDMMYYYY that keys a file's password, per the profile's rule. rc 1 = unreadable.
_gbv_pass_date() {  # <file> <pass-rule>
    local b="${1##*/}"
    case "$2" in
        engine) gbe_parse_date "$b" ;;
        dbsnap)
            if [[ "$b" =~ ^grin_.+_dbsnap_([0-9]{8})_[0-9]{4}\.tar\.gz\.enc$ ]]; then
                echo "${BASH_REMATCH[1]}"; return 0
            fi
            return 1 ;;
        legacy)
            if [[ "$b" =~ ^temp_dir_([0-9]{4})([0-9]{2})([0-9]{2})_ ]]; then
                echo "${BASH_REMATCH[3]}${BASH_REMATCH[2]}${BASH_REMATCH[1]}"; return 0
            fi
            return 1 ;;
        *) return 1 ;;
    esac
}

# Does a decrypted file look like real data? gzip, zip, SQLite, tar (ustar at 257) or
# mostly printable text. Anything else is what a wrong key produces.
_gbv_recognisable() {
    local f="$1" magic n bad
    magic=$(head -c 16 "$f" 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n')
    case "$magic" in
        1f8b*|504b0304*|53514c69746520666f726d6174203300*) return 0 ;;
    esac
    if [[ "$(dd if="$f" bs=1 skip=257 count=5 2>/dev/null)" == "ustar" ]]; then return 0; fi
    n=$(head -c 4096 "$f" 2>/dev/null | wc -c)
    [[ "$n" -gt 0 ]] || return 1
    bad=$(head -c 4096 "$f" 2>/dev/null | LC_ALL=C tr -d '[:print:][:space:]' | wc -c)
    if [[ $((bad * 10)) -le "$n" ]]; then return 0; fi
    return 1
}

# One decrypt attempt. A wrong key passes openssl's padding check about one time in 256
# and yields garbage, so the result must also look right: _GBV_EXPECT=gz → gzip magic
# (every profiled archive), any → _gbv_recognisable (an unprofiled .enc).
_GBV_EXPECT="gz"
_gbv_try() {  # <in> <out> <pass>
    rm -f "$2" 2>/dev/null
    gbe_decrypt "$1" "$2" "$3" || { rm -f "$2" 2>/dev/null; return 1; }
    case "$_GBV_EXPECT" in
        gz)
            if [[ "$(head -c 2 "$2" 2>/dev/null | od -An -tx1 | tr -d ' \n')" != "1f8b" ]]; then
                rm -f "$2" 2>/dev/null; return 1
            fi ;;
        any)
            if ! _gbv_recognisable "$2"; then rm -f "$2" 2>/dev/null; return 1; fi ;;
    esac
    return 0
}

# Up to 3 typed keys (interactive only). $1 in, $2 out, $3 DDMMYYYY suffix ("" = the
# typed text is the whole password). rc 0 decrypted.
_gbv_prompt_decrypt() {
    local in="$1" out="$2" suffix="$3" what="$4" k i
    for i in 1 2 3; do
        k=""
        read -rs -p "  $what (blank = give up, try $i/3): " k || k=""
        echo ""
        if [[ -z "$k" ]]; then unset k; return 1; fi
        if _gbv_try "$in" "$out" "${k}${suffix}"; then unset k; return 0; fi
        echo -e "  ${YELLOW}That does not open it.${RESET}"
    done
    unset k
    return 1
}

# _gbv_decrypt <in> <out> <pass-rule> — reports one line. rc 0 decrypted.
_gbv_decrypt() {
    local in="$1" out="$2" rule="$3" d
    _GBV_EXPECT="gz"
    if ! d=$(_gbv_pass_date "$in" "$rule"); then
        _gbv_line BAD "cannot read the password date from the name — never rename an archive (the date is half its password)"
        return 1
    fi
    if [[ "$rule" == "legacy" ]]; then
        if _gbv_try "$in" "$out" "$d"; then
            _gbv_line OK "decrypted (legacy password = DDMMYYYY derived from the name)"
            return 0
        fi
        if _gbv_is_interactive && _gbv_prompt_decrypt "$in" "$out" "" "Password for this legacy archive"; then
            _gbv_line OK "decrypted with a typed password"
            return 0
        fi
        _gbv_line BAD "could not decrypt — the derived legacy password does not open it (or the file is damaged)"
        return 1
    fi
    _gbv_read_key
    if [[ -n "$_GBV_KEY" ]] && _gbv_try "$in" "$out" "${_GBV_KEY}${d}"; then
        _gbv_line OK "decrypted with this box's saved personal key + $d"
        return 0
    fi
    if _gbv_is_interactive; then
        if [[ -n "$_GBV_KEY" ]]; then
            echo -e "  ${YELLOW}The saved personal key does not open it — it may have been made with an older key.${RESET}"
        else
            echo -e "  ${YELLOW}No personal key is saved on this box.${RESET}"
        fi
        if _gbv_prompt_decrypt "$in" "$out" "$d" "Personal key in force on that date"; then
            _gbv_line OK "decrypted with a typed (older) personal key + $d"
            return 0
        fi
        _gbv_line BAD "could not decrypt — no key tried opens it (wrong key or a damaged file)"
        return 1
    fi
    if [[ -z "$_GBV_KEY" ]]; then
        _gbv_line BAD "could not decrypt — no personal key saved on this box ($GBE_CONF)"
    else
        _gbv_line BAD "could not decrypt with the saved personal key + $d — made with an older key, or the file is damaged (verify it from the menu to type an older key)"
    fi
    return 1
}

# ─── Structure: gzip + tar listing + extract ─────────────────────────────────
# _gbv_tar_extract <tarfile> <dest> <z|""> — gzip test (z), listing (sizes, device
# nodes), free-space check from the listing's own sizes, full extract. rc 0 ok.
_gbv_tar_extract() {
    local tf="$1" dest="$2" z="$3" listing n sz dev
    if [[ "$z" == "z" ]]; then
        if ! gzip -t "$tf" 2>/dev/null; then
            _gbv_line BAD "gzip stream is damaged (gzip -t fails) — truncated or corrupt"
            return 1
        fi
    fi
    if ! listing=$(tar -t${z}vf "$tf" 2>/dev/null); then
        _gbv_line BAD "tar listing fails — the archive is damaged"
        return 1
    fi
    n=$(printf '%s\n' "$listing" | grep -c . || true)
    sz=$(printf '%s\n' "$listing" | awk '$3 ~ /^[0-9]+$/ {s += $3} END {printf "%d", s + 0}')
    dev=$(printf '%s\n' "$listing" | awk 'substr($1,1,1) ~ /[bcp]/' | grep -c . || true)
    if [[ "${n:-0}" -eq 0 ]]; then
        _gbv_line BAD "archive is empty (no members)"
        return 1
    fi
    if [[ "${dev:-0}" -gt 0 ]]; then
        _gbv_line BAD "archive holds $dev device/FIFO node(s) — no toolkit backup does; not extracted"
        return 1
    fi
    _gbv_line OK "$([[ "$z" == z ]] && echo "gzip stream intact · ")tar lists $n members · $(_gbv_human "$sz") uncompressed"
    _gbv_space_ok "$sz" "the extracted archive" || return 1
    mkdir -p "$dest" || { _gbv_line BAD "cannot create the extract dir in the sandbox"; return 1; }
    if ! ( umask 077; tar -x${z}f "$tf" -C "$dest" --no-same-owner 2>/dev/null ); then
        _gbv_line BAD "full extract into the sandbox failed"
        return 1
    fi
    _gbv_line OK "extracted every member into the sandbox"
    return 0
}

# .sha256 sidecar (Migrate OUT writes one beside its archive): first field = sha256 of the file.
_gbv_sidecar() {
    local f="$1" want got
    [[ -f "$f.sha256" ]] || return 0
    want=$(awk 'NR==1{print $1}' "$f.sha256" 2>/dev/null)
    got=$(sha256sum "$f" 2>/dev/null | awk '{print $1}')
    if [[ -n "$want" && "$want" == "$got" ]]; then
        _gbv_line OK "sha256 matches the .sha256 file beside it"
    else
        _gbv_line BAD "sha256 does NOT match the .sha256 file beside it"
    fi
    return 0
}

# ─── Freshness + offsite ─────────────────────────────────────────────────────
# Prints "<limit seconds>|<description>", "unsched|<why>" or "none".
_gbv_sched_limit() {
    local sched="${GBV_P_SCHED[$1]:-none}" kind cronf conf iv line dow
    kind="${sched%%:*}"
    case "$kind" in
        daily)
            cronf="${sched#daily:}"
            if [[ -f "$GBV_CRON_DIR/$cronf" ]]; then echo "$((26 * 3600))|daily cron ($cronf)"
            else echo "unsched|no $GBV_CRON_DIR/$cronf"; fi ;;
        dbsnap)
            cronf="${sched#dbsnap:}"; conf="${cronf#*:}"; cronf="${cronf%%:*}"
            if [[ ! -f "$GBV_CRON_DIR/$cronf" ]]; then echo "unsched|no $GBV_CRON_DIR/$cronf"; return 0; fi
            iv=$(sed -n 's/^PDS_INTERVAL=\([0-9]*\).*/\1/p' "$GBV_CONF_DIR/$conf" 2>/dev/null | tail -1)
            [[ "$iv" =~ ^(15|30|60|120)$ ]] || iv=60
            echo "$((2 * iv * 60))|snapshot cron every $iv min" ;;
        toolkit)
            line=$(_gbv_root_crontab | grep -F "$GBV_TOOLKIT_CRON_TAG" | grep -v '^[[:space:]]*#' | head -1)
            if [[ -z "$line" ]]; then echo "unsched|no 08 ▸ 9 schedule in root's crontab"; return 0; fi
            dow=$(awk '{print $5}' <<<"$line")
            if [[ "$dow" == "*" ]]; then echo "$((26 * 3600))|daily (08 ▸ 9 schedule)"
            else echo "$((8 * 86400))|two days a week (08 ▸ 9 schedule)"; fi ;;
        *) echo "none" ;;
    esac
}

_gbv_root_crontab() {
    if [[ -n "${GBV_ROOT_CRONTAB_FILE:-}" ]]; then
        cat "$GBV_ROOT_CRONTAB_FILE" 2>/dev/null || true
    elif command -v crontab >/dev/null 2>&1; then
        crontab -l 2>/dev/null || true
    fi
    return 0
}

_gbv_age_text() {
    local s="$1"
    if [[ "$s" -lt 7200 ]]; then echo "$((s / 60)) min"
    elif [[ "$s" -lt 172800 ]]; then echo "$((s / 3600)) h"
    else echo "$((s / 86400)) days"; fi
}

# Latest moment the archive can have been made, from its NAME (epoch), or empty.
# dbsnap: DDMMYYYY_HHMM UTC · aside: <HHMMSS>_<DDMMYYYY> local · plain date: end of
# that local day. A copied or touched file gets a new mtime; its name does not.
_gbv_name_epoch() {
    local b="${1##*/}" d
    if [[ "$b" =~ _dbsnap_([0-9]{2})([0-9]{2})([0-9]{4})_([0-9]{2})([0-9]{2})\.tar\.gz\.enc$ ]]; then
        date -u -d "${BASH_REMATCH[3]}-${BASH_REMATCH[2]}-${BASH_REMATCH[1]} ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:59" +%s 2>/dev/null
    elif [[ "$b" =~ _backup_([0-9]{2})([0-9]{2})([0-9]{2})(-[0-9]+)?_([0-9]{2})([0-9]{2})([0-9]{4})\.tar\.gz\.enc$ ]]; then
        date -d "${BASH_REMATCH[7]}-${BASH_REMATCH[6]}-${BASH_REMATCH[5]} ${BASH_REMATCH[1]}:${BASH_REMATCH[2]}:${BASH_REMATCH[3]}" +%s 2>/dev/null
    elif d=$(gbe_parse_date "$b" 2>/dev/null); then
        date -d "${d:4:4}-${d:2:2}-${d:0:2} 23:59:59" +%s 2>/dev/null
    fi
    return 0
}

_gbv_freshness() {  # <file> <profile>
    local f="$1" p="$2" lim desc mt ne age
    mt=$(stat -c %Y "$f" 2>/dev/null) || mt=""
    [[ "$mt" =~ ^[0-9]+$ ]] || { _gbv_line WARN "cannot read the file's age"; return 0; }
    ne=$(_gbv_name_epoch "$f")
    # The older of name-date and mtime: neither a touch nor a copy can make it look fresh.
    if [[ "$ne" =~ ^[0-9]+$ && "$ne" -lt "$mt" ]]; then mt="$ne"; fi
    age=$(( $(date +%s) - mt )); [[ "$age" -ge 0 ]] || age=0
    lim=$(_gbv_sched_limit "$p")
    desc="${lim#*|}"; lim="${lim%%|*}"
    case "$lim" in
        none)
            _gbv_line INFO "age $(_gbv_age_text "$age") (made on demand — no schedule to compare with)" ;;
        unsched)
            _gbv_line WARN "no backup schedule for this product ($desc) — newest archive is $(_gbv_age_text "$age") old" ;;
        *)
            if [[ "$age" -le "$lim" ]]; then
                _gbv_line OK "fresh: $(_gbv_age_text "$age") old ($desc, limit $(_gbv_age_text "$lim"))"
            elif [[ "$p" == *-dbsnap ]]; then
                _gbv_line WARN "newest snapshot is $(_gbv_age_text "$age") old ($desc, limit $(_gbv_age_text "$lim")) — the snapshot run skips when nothing changed, so an idle pool ages legitimately"
            else
                _gbv_line BAD "STALE: newest archive is $(_gbv_age_text "$age") old ($desc, limit $(_gbv_age_text "$lim")) — the scheduled backup is not producing archives"
            fi ;;
    esac
    return 0
}

# Read-only offsite check: the remote copy's byte count vs the local one.
_gbv_offsite() {
    local f="$1" b="${1##*/}" size out rc
    case "$b" in
        grin_*_backup_*.tar.gz.enc|grin_*_dbsnap_*.tar.gz.enc|temp_dir_*.tar.gz.enc) ;;
        *) return 0 ;;   # never pushed (e.g. Script 04's plain onion tarball)
    esac
    if ! gbp_configured; then
        _gbv_line INFO "offsite: push not configured — not checked"
        return 0
    fi
    if [[ ! "$b" =~ ^[A-Za-z0-9._-]+$ || "$GBP_DIR" == *"'"* ]]; then
        _gbv_line WARN "offsite: unexpected characters in the name or remote dir — not checked"
        return 0
    fi
    if [[ ! -f "$GBP_KEY" ]]; then
        _gbv_line WARN "offsite: push key $GBP_KEY missing — not checked"
        return 0
    fi
    size=$(stat -c %s "$f" 2>/dev/null) || size=""
    # StrictHostKeyChecking=yes: this check never adds a known_hosts entry (the push does).
    out=$(timeout --kill-after=10 60 ssh -n -i "$GBP_KEY" -o BatchMode=yes -o ConnectTimeout=15 \
            -o StrictHostKeyChecking=yes -p "$GBP_PORT" "$GBP_USER@$GBP_HOST" \
            "if [ -f '$GBP_DIR/$b' ]; then wc -c < '$GBP_DIR/$b'; else echo MISSING; fi" 2>/dev/null)
    rc=$?
    out=$(printf '%s' "$out" | tr -d '[:space:]')
    if [[ "$rc" -ne 0 || -z "$out" ]]; then
        _gbv_line WARN "offsite: could not reach ${GBP_USER}@${GBP_HOST} (ssh rc $rc) — not checked"
    elif [[ "$out" == "MISSING" ]]; then
        if [[ "$b" =~ _backup_[0-9]{6}(-[0-9]+)?_[0-9]{8}\.tar\.gz\.enc$ ]]; then
            # The push copied it under the plain name; the later archive of that day replaced it there.
            _gbv_line INFO "offsite: earlier same-day copy — offsite holds the later one under the plain name"
        elif [[ "$b" == *_dbsnap_* ]]; then
            _gbv_line WARN "offsite: not on the remote (snapshot pushes follow the pool's own push setting)"
        else
            _gbv_line WARN "offsite: NOT on the remote ${GBP_HOST}:${GBP_DIR}"
        fi
    elif [[ "$out" == "$size" ]]; then
        _gbv_line OK "offsite: remote copy has the same size ($size bytes)"
    else
        _gbv_line BAD "offsite: remote copy is $out bytes, local is $size — the remote copy is DIFFERENT (truncated?)"
    fi
    return 0
}

# ─── Generic (any-file) checks ───────────────────────────────────────────────
# _gbv_check_any <file> <sandbox> <depth> — dispatch on name, then magic. Depth caps
# the .gz/.enc unwrapping at two layers.
_gbv_check_any() {
    local f="$1" sb="$2" depth="${3:-0}" b="${1##*/}" low magic inner sz
    low="${b,,}"
    magic=$(head -c 16 "$f" 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n')
    if [[ "$depth" -gt 2 ]]; then
        _gbv_line WARN "nested more than two layers deep — stopped unwrapping"
        return 0
    fi
    case "$low" in
        *.tar.gz|*.tgz)
            _gbv_tar_extract "$f" "$sb/x$depth" z && _gbv_emit < <(_gbv_py tree "$sb/x$depth") ;;
        *.tar)
            _gbv_tar_extract "$f" "$sb/x$depth" "" && _gbv_emit < <(_gbv_py tree "$sb/x$depth") ;;
        *.zip)       _gbv_check_zip "$f" "$sb" "$depth" ;;
        *.gz)
            if ! gzip -t "$f" 2>/dev/null; then
                _gbv_line BAD "gzip stream is damaged (gzip -t fails)"; return 0
            fi
            if tar -tzf "$f" >/dev/null 2>&1; then
                _gbv_tar_extract "$f" "$sb/x$depth" z && _gbv_emit < <(_gbv_py tree "$sb/x$depth")
                return 0
            fi
            # gzip -l stores the size mod 2^32, so count the real stream instead.
            sz=$(gzip -dc "$f" 2>/dev/null | wc -c)
            _gbv_space_ok "${sz:-0}" "the decompressed file" || return 0
            inner="$sb/u$depth-${b%.*}"
            if ! gzip -dc "$f" > "$inner" 2>/dev/null; then
                _gbv_line BAD "gzip decompression failed"; return 0
            fi
            _gbv_line OK "gzip stream intact · $(_gbv_human "$(stat -c %s "$inner")") decompressed"
            _gbv_check_any "$inner" "$sb" $((depth + 1)) ;;
        *.enc)       _gbv_check_enc "$f" "$sb" "$depth" ;;
        *.db|*.sqlite|*.sqlite3|*.db3)
            _gbv_check_sqlite_file "$f" "$sb" ;;
        *.sql)       _gbv_check_sql "$f" ;;
        *)
            if [[ "$magic" == 1f8b* ]]; then
                inner="$sb/u$depth.gz"
                ln -s "$f" "$inner" 2>/dev/null || { _gbv_line BAD "cannot stage the file in the sandbox"; return 0; }
                _gbv_check_any "$inner" "$sb" "$depth"
            elif [[ "$magic" == 53514c69746520666f726d6174203300* ]]; then
                _gbv_check_sqlite_file "$f" "$sb"
            elif [[ "$magic" == 504b0304* ]]; then
                _gbv_check_zip "$f" "$sb" "$depth"
            elif [[ "$(dd if="$f" bs=1 skip=257 count=5 2>/dev/null)" == "ustar" ]]; then
                _gbv_tar_extract "$f" "$sb/x$depth" "" && _gbv_emit < <(_gbv_py tree "$sb/x$depth")
            elif [[ -r "$f" ]] && cat "$f" >/dev/null 2>&1; then
                _gbv_line WARN "unknown file type — every byte reads back ($(_gbv_human "$(stat -c %s "$f")")), nothing more can be checked"
            else
                _gbv_line BAD "the file cannot be read"
            fi ;;
    esac
    return 0
}

# Zip: unzip -t (when installed) is a second structure opinion only; extraction is
# python zipfile, which refuses symlink entries, absolute/".." paths, anything
# resolving outside the sandbox, and more bytes than the disk budget.
_gbv_check_zip() {
    local f="$1" sb="$2" depth="$3"
    if command -v unzip >/dev/null 2>&1; then
        if unzip -tqq "$f" >/dev/null 2>&1; then
            _gbv_line OK "zip: unzip -t passes"
        else
            _gbv_line BAD "zip: unzip -t reports damaged entries"; return 0
        fi
    fi
    mkdir -p "$sb/z$depth" || { _gbv_line BAD "cannot create the extract dir in the sandbox"; return 0; }
    _GBV_META=""
    _gbv_emit < <(_gbv_py zip "$f" "$sb/z$depth" "$(_gbv_budget)")
    if [[ "$_GBV_META" == *extracted* ]]; then _gbv_emit < <(_gbv_py tree "$sb/z$depth"); fi
    return 0
}

_gbv_check_sqlite_file() {
    local f="$1" sb="$2" cp="$2/db-$(basename "$1")"
    _gbv_space_ok "$(stat -c %s "$f" 2>/dev/null || echo 0)" "a copy of the database" || return 0
    # A consistent copy via the backup API (read-only source open), never the live file.
    if command -v python3 >/dev/null 2>&1 \
       && ( cd / && python3 -I -c 'import sqlite3,sys; s=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()' "$f" "$cp" ) 2>/dev/null; then
        _gbv_line OK "copied into the sandbox with the SQLite backup API"
    elif cp "$f" "$cp" 2>/dev/null; then
        _gbv_line INFO "copied into the sandbox as a plain file (backup API refused it)"
    else
        _gbv_line BAD "cannot copy the database into the sandbox"; return 0
    fi
    _gbv_emit < <(_gbv_py sqlite "$cp" "$(basename "$f")")
    return 0
}

# SQL dumps are text-checked (SQLite ones are also loaded in memory by the checker).
# A MySQL/MariaDB dump is never executed: running an untrusted dump on a production
# database server is a restore test for a spare box.
_gbv_check_sql() {
    local f="$1" n
    _GBV_META=""
    _gbv_emit < <(_gbv_py sql "$f")
    if [[ "$_GBV_META" == *pgcustom* ]]; then
        if command -v pg_restore >/dev/null 2>&1; then
            if pg_restore --list "$f" >/dev/null 2>&1; then
                n=$(pg_restore --list "$f" 2>/dev/null | grep -c 'TABLE DATA' || true)
                _gbv_line OK "PostgreSQL custom-format dump: pg_restore --list reads its table of contents · $n TABLE DATA entries"
            else
                _gbv_line BAD "PostgreSQL custom-format dump: pg_restore --list cannot read it"
            fi
        else
            _gbv_line WARN "PostgreSQL custom-format dump (PGDMP header) — pg_restore not installed, only the header was checked"
        fi
    fi
    return 0
}

# .enc with no profile: saved key + a date found in the name, a legacy date password,
# else a typed one. The decrypted file keeps the inner name (x.sql.enc → x.sql), so it
# is checked as what it is.
_gbv_check_enc() {
    local f="$1" sb="$2" depth="$3" b="${1##*/}" g ok=0 cand out
    local -a cands=()
    out="$sb/d$depth-${b%.[eE][nN][cC]}"
    _GBV_EXPECT="any"
    _gbv_space_ok "$(stat -c %s "$f" 2>/dev/null || echo 0)" "the decrypted file" || return 0
    _gbv_read_key
    while IFS= read -r g; do
        [[ -n "$g" ]] || continue
        if [[ "${g:0:2}" =~ ^(0[1-9]|[12][0-9]|3[01])$ && "${g:2:2}" =~ ^(0[1-9]|1[0-2])$ && "${g:4:2}" == "20" ]]; then
            cands+=("$g")                                       # DDMMYYYY
        fi
        if [[ "${g:0:2}" == "20" && "${g:4:2}" =~ ^(0[1-9]|1[0-2])$ && "${g:6:2}" =~ ^(0[1-9]|[12][0-9]|3[01])$ ]]; then
            cands+=("${g:6:2}${g:4:2}${g:0:4}")                 # YYYYMMDD → DDMMYYYY
        fi
    done < <(grep -oE '[0-9]{8}' <<<"$b")
    if [[ -n "$_GBV_KEY" ]]; then
        for cand in "${cands[@]}"; do
            if _gbv_try "$f" "$out" "${_GBV_KEY}${cand}"; then
                ok=1; _gbv_line OK "decrypted with the saved personal key + $cand (date from the name)"; break
            fi
        done
    fi
    if [[ "$ok" -eq 0 ]]; then
        for cand in "${cands[@]}"; do
            if _gbv_try "$f" "$out" "$cand"; then
                ok=1; _gbv_line OK "decrypted with the legacy date password $cand"; break
            fi
        done
    fi
    if [[ "$ok" -eq 0 ]] && _gbv_is_interactive && _gbv_prompt_decrypt "$f" "$out" "" "Full password for this file"; then
        ok=1; _gbv_line OK "decrypted with a typed password"
    fi
    if [[ "$ok" -eq 0 ]]; then
        _gbv_line BAD "could not decrypt (openssl AES-256-CBC/PBKDF2-600k) to anything recognisable — wrong key or not a toolkit-encrypted file"
        return 0
    fi
    _gbv_check_any "$out" "$sb" $((depth + 1))
    return 0
}

# ─── One verification ────────────────────────────────────────────────────────
# _gbv_run_profiled <file> <profile> <sandbox>
_gbv_run_profiled() {
    local f="$1" p="$2" sb="$3" rule plain
    rule="${GBV_P_PASS[$p]:-plain}"
    if [[ "$rule" == "plain" ]]; then
        plain="$f"
    else
        _gbv_space_ok "$(stat -c %s "$f" 2>/dev/null || echo 0)" "the decrypted archive" || return 0
        plain="$sb/archive.tar.gz"
        _gbv_decrypt "$f" "$plain" "$rule" || return 0
    fi
    # The decrypted file is on disk while the extract runs; the free-space check
    # inside _gbv_tar_extract measures the disk with it already there.
    _gbv_tar_extract "$plain" "$sb/x" z || return 0
    if [[ "$plain" != "$f" ]]; then rm -f "$plain" 2>/dev/null || true; fi
    _gbv_emit < <(GBV_REQ="${GBV_P_REQ[$p]:-}" GBV_OPT="${GBV_P_OPT[$p]:-}" GBV_FORBID="$GBV_FORBID" \
                      GBV_MANIFEST="${GBV_P_MANIFEST[$p]:-0}" _gbv_py tree "$sb/x")
    return 0
}

# gbv_verify_file <path> [--newest] — one file, one ✓/✗/⚠ block. --newest adds the
# freshness check (it only means something for the newest archive of a product).
# rc 0 = no ✗ · 1 = at least one ✗.
gbv_verify_file() {
    local f="${1:-}" newest="${2:-}" p label sb rc
    _GBV_NBAD=0; _GBV_NWARN=0; _GBV_META=""
    _gbv_log_init
    if [[ -z "$f" || ! -f "$f" ]]; then
        _gbv_head "${f:-<no path>}"
        _gbv_line BAD "not a regular file"
        return 1
    fi
    if [[ ! -r "$f" ]]; then
        _gbv_head "$f"
        _gbv_line BAD "cannot read the file (permission?)"
        return 1
    fi
    if p=$(gbv_profile_of "$f"); then label="${GBV_P_LABEL[$p]:-$p}"; else p=""; label="any file — no product profile"; fi
    _gbv_head "$(basename "$f")  ($label · $(_gbv_human "$(stat -c %s "$f" 2>/dev/null || echo 0)"))"

    if ! mkdir -p "$GBV_TMP_ROOT" 2>/dev/null; then
        _gbv_line BAD "cannot use $GBV_TMP_ROOT for the sandbox"
        return 1
    fi
    _gbv_sweep_stale
    _gbv_traps_set
    sb=$(mktemp -d "$GBV_TMP_ROOT/grin-verify.XXXXXX" 2>/dev/null) || sb=""
    if [[ -z "$sb" ]]; then
        _gbv_traps_restore
        _gbv_line BAD "cannot create a sandbox under $GBV_TMP_ROOT"
        return 1
    fi
    _GBV_SANDBOX="$sb"
    if ! chmod 700 "$sb"; then
        _gbv_cleanup; _gbv_traps_restore
        _gbv_line BAD "cannot make the sandbox private (chmod 700)"
        return 1
    fi

    _gbv_sidecar "$f"
    if [[ -n "$p" ]]; then
        _gbv_run_profiled "$f" "$p" "$sb"
    else
        _gbv_check_any "$f" "$sb" 0
        _gbv_line INFO "no product profile: this proves the file is READABLE, not that it is COMPLETE"
    fi
    _gbv_cleanup
    _gbv_traps_restore

    if [[ -n "$p" && "$newest" == "--newest" ]]; then _gbv_freshness "$f" "$p"; fi
    if [[ -n "$p" ]]; then _gbv_offsite "$f"; fi

    if [[ "$_GBV_NBAD" -gt 0 ]]; then
        _gbv_line INFO "RESULT: ✗ FAILED ($_GBV_NBAD problem(s), $_GBV_NWARN warning(s))"
        rc=1
    elif [[ "$_GBV_NWARN" -gt 0 ]]; then
        _gbv_line INFO "RESULT: ⚠ usable, $_GBV_NWARN warning(s)"
        rc=0
    else
        _gbv_line INFO "RESULT: ✓ OK"
        rc=0
    fi
    return "$rc"
}

# Newest archive of each product, one path per line. Key = product (engine name),
# <product>-dbsnap, or the onion tarball's own name (one per network).
_gbv_newest_per_product() {
    local f b key seen=" "
    while IFS= read -r f; do
        [[ -n "$f" && -f "$f" ]] || continue
        b="${f##*/}"
        gbv_profile_of "$b" >/dev/null || continue
        case "$b" in
            grin_*_dbsnap_*)  key="${b#grin_}"; key="${key%%_dbsnap_*}-dbsnap" ;;
            grin_*_backup_*)  key="${b#grin_}"; key="${key%%_backup_*}" ;;
            grin_tor_onion_*) key="$b" ;;
            *) continue ;;
        esac
        [[ "$seen" == *" $key "* ]] && continue
        seen+="$key "
        echo "$f"
    done < <(ls -t "$GBV_BACKUP_DIR"/grin_*_backup_*.tar.gz.enc \
                   "$GBV_BACKUP_DIR"/grin_*_dbsnap_*.tar.gz.enc \
                   "$GBV_BACKUP_DIR"/grin_tor_onion_*.tar.gz 2>/dev/null)
    return 0
}

# One off-box alert for a failed unattended run, through lib/grin_alert_send.sh and
# the node event recorder's channels (086). No channel set, or the delivery lib
# missing or not safely owned → log only. Channel values are read with an
# allow-list, never sourced, and live only in this function's locals.
_gbv_alert() {
    local subject="$1" body="$2" lib="$_GBV_LIB_DIR/grin_backup_verify_alert.sh" k v line
    if [[ ! -e "$lib" ]]; then lib="$_GBV_LIB_DIR/grin_alert_send.sh"; fi   # run from the checkout
    local NTFY_URL="" TG_BOT_TOKEN="" TG_CHAT_ID="" MAIL_TO="" NOSTR_SK="" NOSTR_RELAY=""
    [[ -f "$GBV_ALERT_CONF" && -r "$GBV_ALERT_CONF" ]] || { _gbv_log "  no alert channels ($GBV_ALERT_CONF absent) — result logged only"; return 0; }
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^(NTFY_URL|TG_BOT_TOKEN|TG_CHAT_ID|MAIL_TO|NOSTR_SK|NOSTR_RELAY)=(.*)$ ]] || continue
        k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"
        printf -v "$k" '%s' "$v"
    done < "$GBV_ALERT_CONF"
    if [[ -z "$NTFY_URL$TG_BOT_TOKEN$MAIL_TO$NOSTR_SK" ]]; then
        _gbv_log "  no alert channel configured in $GBV_ALERT_CONF — result logged only"; return 0
    fi
    if [[ ! -r "$lib" ]] || ! _gbv_owned_ok "$lib"; then
        _gbv_log "  ✗ alert NOT sent: $lib missing or not safely owned"; return 0
    fi
    if ! declare -F gas_send >/dev/null 2>&1; then
        # shellcheck source=grin_alert_send.sh
        source "$lib" || { _gbv_log "  ✗ alert NOT sent: cannot load $lib"; return 0; }
    fi
    local GAS_TITLE_PREFIX="Grin backup verify" GAS_LOG_FN="_gbv_log" GAS_MAX_TIME=15 \
          GAS_CMD_TIMEOUT=1 GAS_HIDE_SECRETS=1 GAS_PRIORITY="" GAS_NTFY_TAGS="warning"
    if gas_send HIGH "$subject" "$body"; then _gbv_log "  alert sent"; else _gbv_log "  ✗ alert reached no channel"; fi
    return 0
}

# gbv_verify_newest_all — the newest archive of each product, plus a ✗ for any
# product whose backup is scheduled but which has no archive at all.
gbv_verify_newest_all() {
    local f p n=0 ok=0 bad=0 warn=0 lim failed=""
    local -a files=()
    _gbv_log_init
    _gbv_log "=== backup verify: newest archive of each product in $GBV_BACKUP_DIR ==="
    while IFS= read -r f; do [[ -n "$f" ]] && files+=("$f"); done < <(_gbv_newest_per_product)
    for f in "${files[@]}"; do
        n=$((n + 1))
        if gbv_verify_file "$f" --newest; then
            if [[ "$_GBV_NWARN" -gt 0 ]]; then warn=$((warn + 1)); else ok=$((ok + 1)); fi
        else
            bad=$((bad + 1)); failed+="${f##*/}"$'\n'
        fi
    done
    # Scheduled but nothing on disk = the schedule is failing from the start.
    _GBV_NBAD=0; _GBV_NWARN=0
    local miss=0 have
    for p in toolkit pubpool pubpooltestnet pubpool-dbsnap pubpooltestnet-dbsnap solo drop floonet transporter; do
        lim=$(_gbv_sched_limit "$p")
        case "$lim" in none|unsched*) continue ;; esac
        have=0
        for f in "${files[@]}"; do
            if [[ "$(gbv_profile_of "$f" 2>/dev/null)" == "$p" ]]; then have=1; break; fi
        done
        if [[ "$have" -eq 0 ]]; then
            if [[ "$miss" -eq 0 ]]; then _gbv_head "Scheduled products with NO archive"; fi
            miss=1
            _gbv_line BAD "${GBV_P_LABEL[$p]}: scheduled (${lim#*|}) but no archive in $GBV_BACKUP_DIR"
            bad=$((bad + 1)); failed+="${GBV_P_LABEL[$p]}: no archive"$'\n'
        fi
    done
    echo ""
    if [[ "$n" -eq 0 && "$miss" -eq 0 ]]; then
        _gbv_line WARN "no backup archives found in $GBV_BACKUP_DIR"
        _gbv_log "=== RESULT: no archives ==="
        return 0
    fi
    local summary="checked $n archive(s): $ok ok, $warn with warnings, $bad failed"
    if [[ "$bad" -gt 0 ]]; then
        _gbv_line INFO "OVERALL: ✗ $summary"
        _gbv_log "=== RESULT: FAIL — $summary ==="
        if ! _gbv_is_interactive; then
            _gbv_alert "backup verification FAILED" "$summary"$'\n\n'"Failed:"$'\n'"$failed"$'\n'"Details: $GBV_LOG"
        fi
        return 1
    fi
    _gbv_line INFO "OVERALL: ✓ $summary"
    _gbv_log "=== RESULT: OK — $summary ==="
    return 0
}

# ─── Weekly check (cron) ─────────────────────────────────────────────────────
# Cron cannot source the repo checkout, so the wrapper sources copies installed in
# $GBV_LIB_INSTALL_DIR (verify → engine → push by relative path, + the checker).
# Those copies run as root weekly, so the dir and every copy must be owned by
# $GBV_OWNER_UID and not group/world-writable — checked before installing AND by
# the wrapper itself before it sources anything. A version file records each
# copy's sha256 and the newest source mtime; an older checkout never overwrites
# newer copies (switch the check off and on to force it).
# grin_alert_send.sh is installed under a name of its own (the _verify_alert entry below):
# the node event recorder installs and removes /opt/grin/lib/grin_alert_send.sh on
# its own schedule, and neither feature may delete the other's copy.
_GBV_LIBS=(grin_backup_verify.sh grin_backup_engine.sh grin_backup_push.sh grin_backup_verify_check.py
           grin_backup_verify_alert.sh)
GBV_VERSION_FILE="${GBV_VERSION_FILE:-$GBV_LIB_INSTALL_DIR/grin_backup_verify.version}"

_gbv_src_of() {  # <installed name> → its source path in this lib's dir
    if [[ "$1" == "grin_backup_verify_alert.sh" ]]; then echo "$_GBV_LIB_DIR/grin_alert_send.sh"; else echo "$_GBV_LIB_DIR/$1"; fi
}

# Owned by $GBV_OWNER_UID, not a symlink, no group/world write bit.
_gbv_owned_ok() {
    local p="$1" st uid mode
    [[ -e "$p" && ! -L "$p" ]] || return 1
    st=$(stat -c '%u %a' "$p" 2>/dev/null) || return 1
    uid="${st% *}"; mode="${st#* }"
    [[ "$uid" == "$GBV_OWNER_UID" ]] || return 1
    if (( (8#$mode & 8#022) == 0 )); then return 0; fi
    return 1
}

_gbv_src_newest_mtime() {
    local lib m newest=0
    for lib in "${_GBV_LIBS[@]}"; do
        m=$(stat -c %Y "$(_gbv_src_of "$lib")" 2>/dev/null) || m=0
        if [[ "$m" -gt "$newest" ]]; then newest="$m"; fi
    done
    echo "$newest"
}

# rc 0 = every installed copy has the checkout's content.
_gbv_copies_current() {
    local lib
    for lib in "${_GBV_LIBS[@]}"; do
        cmp -s "$(_gbv_src_of "$lib")" "$GBV_LIB_INSTALL_DIR/$lib" || return 1
    done
    [[ -f "$GBV_VERSION_FILE" ]]
}

_gbv_install_copies() {
    local lib tmp src_m inst_m vtmp
    if [[ "$(cd "$GBV_LIB_INSTALL_DIR" 2>/dev/null && pwd)" == "$_GBV_LIB_DIR" ]]; then return 0; fi
    mkdir -p -m 755 "$GBV_LIB_INSTALL_DIR" || { error "Cannot create $GBV_LIB_INSTALL_DIR."; return 1; }
    if ! _gbv_owned_ok "$GBV_LIB_INSTALL_DIR"; then
        error "$GBV_LIB_INSTALL_DIR is not owned by uid $GBV_OWNER_UID or is group/world-writable — refusing to install code that runs as root."
        _gbv_log "  ✗ lib copies NOT installed: $GBV_LIB_INSTALL_DIR unsafe ownership/mode"
        return 1
    fi
    _gbv_copies_current && return 0
    src_m=$(_gbv_src_newest_mtime)
    inst_m=$(sed -n 's/^# newest source mtime: \([0-9]*\)$/\1/p' "$GBV_VERSION_FILE" 2>/dev/null | head -1)
    if [[ "$inst_m" =~ ^[0-9]+$ && "$src_m" -lt "$inst_m" ]]; then
        warn "Installed weekly-check copies are NEWER than this checkout — not replaced (switch the check off and on to force)."
        _gbv_log "  ⚠ lib copies not refreshed: checkout ($src_m) older than the installed copies ($inst_m)"
        return 0
    fi
    for lib in "${_GBV_LIBS[@]}"; do
        [[ -f "$(_gbv_src_of "$lib")" ]] || { error "Missing $(_gbv_src_of "$lib")."; return 1; }
        tmp=$(mktemp "$GBV_LIB_INSTALL_DIR/.lib.XXXXXX") || { error "Cannot write in $GBV_LIB_INSTALL_DIR."; return 1; }
        cp -f "$(_gbv_src_of "$lib")" "$tmp" || { rm -f "$tmp"; error "Cannot copy $lib."; return 1; }
        chmod 644 "$tmp" || { rm -f "$tmp"; error "Cannot chmod $tmp."; return 1; }
        mv -f "$tmp" "$GBV_LIB_INSTALL_DIR/$lib" || { rm -f "$tmp"; error "Cannot install $lib."; return 1; }
        _gbv_owned_ok "$GBV_LIB_INSTALL_DIR/$lib" || { error "$GBV_LIB_INSTALL_DIR/$lib is not safely owned after install."; return 1; }
    done
    vtmp=$(mktemp "$GBV_LIB_INSTALL_DIR/.ver.XXXXXX") || { error "Cannot write in $GBV_LIB_INSTALL_DIR."; return 1; }
    {
        echo "# grin backup verifier — lib copies for $GBV_BIN. Written by lib/grin_backup_verify.sh."
        echo "# newest source mtime: $src_m"
        ( cd "$GBV_LIB_INSTALL_DIR" && sha256sum "${_GBV_LIBS[@]}" )
    } > "$vtmp" || { rm -f "$vtmp"; error "Cannot write the version file."; return 1; }
    chmod 644 "$vtmp" || { rm -f "$vtmp"; error "Cannot chmod the version file."; return 1; }
    mv -f "$vtmp" "$GBV_VERSION_FILE" || { rm -f "$vtmp"; error "Cannot install $GBV_VERSION_FILE."; return 1; }
    _gbv_log_init
    _gbv_log "  lib copies refreshed in $GBV_LIB_INSTALL_DIR from $_GBV_LIB_DIR (newest source mtime $src_m)"
    return 0
}

_gbv_wrapper_text() {
    local v lib
    echo '#!/bin/bash'
    echo '# grin-backup-verify — weekly restore test of the newest backup of each product.'
    echo '# Generated by lib/grin_backup_verify.sh (08 ▸ 9 ▸ V ▸ 3) — do not edit.'
    echo "# Sources the lib copies in $GBV_LIB_INSTALL_DIR; opening 08 ▸ 9 refreshes them."
    echo 'set -uo pipefail'
    echo 'export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    for v in GBE_BACKUP_DIR GBE_CONF GBE_LEGACY_SOLO_CONF GBE_LEGACY_DROP_CONF GBP_CONF GBP_KEY GBP_BIN GBP_LOG \
             GBV_BACKUP_DIR GBV_LEGACY_DIR GBV_TMP_ROOT GBV_LOG GBV_CRON_DIR GBV_CONF_DIR GBV_ROOT_CRONTAB_FILE \
             GBV_ALERT_CONF GBV_OWNER_UID GBV_RESERVE_BYTES; do
        if [[ -n "${!v:-}" ]]; then printf 'export %s=%q\n' "$v" "${!v}"; fi
    done
    printf 'DIR=%q\n' "$GBV_LIB_INSTALL_DIR"
    printf 'FILES=('; for lib in "${_GBV_LIBS[@]}"; do printf ' %q' "$lib"; done; printf ' )\n'
    cat <<'WRAP'
ts() { date -u '+%Y-%m-%d %H:%M:%S UTC'; }
logx() { mkdir -p "$(dirname "$GBV_LOG")" 2>/dev/null; ( umask 077; echo "[$(ts)] $*" >> "$GBV_LOG" ) 2>/dev/null; }
# Code that runs as root must be root's: no symlink, owner GBV_OWNER_UID, no g/o write.
safe() {
    local st
    [[ -e "$1" && ! -L "$1" ]] || return 1
    st=$(stat -c '%u %a' "$1" 2>/dev/null) || return 1
    if [[ "${st% *}" == "$GBV_OWNER_UID" ]] && (( (8#${st#* } & 8#022) == 0 )); then return 0; fi
    return 1
}
safe "$DIR" || { logx "  ✗ refusing to run: $DIR is not owned by uid $GBV_OWNER_UID or is group/world-writable"; exit 1; }
for f in "${FILES[@]}"; do
    safe "$DIR/$f" || { logx "  ✗ refusing to run: $DIR/$f is missing, a symlink, not owned by uid $GBV_OWNER_UID or group/world-writable — switch the weekly check off and on (08 > 9 > V > 3)"; exit 1; }
done
# Logging fallbacks: the lib's callers normally provide these; under set -u an
# undefined one would end the run.
info()    { echo "[INFO]  $*"; }
warn()    { echo "[WARN]  $*"; }
error()   { echo "[ERROR] $*" >&2; }
success() { echo "[OK]    $*"; }
renice -n 19 -p $$ >/dev/null 2>&1 || true
ionice -c2 -n7 -p $$ >/dev/null 2>&1 || true
# shellcheck source=/dev/null
source "$DIR/grin_backup_verify.sh"
GBV_INTERACTIVE=0
gbv_verify_newest_all
WRAP
}

_gbv_write_generated() {
    local tmp text
    _gbv_install_copies || return 1
    text="$(_gbv_wrapper_text)"
    if [[ -f "$GBV_BIN" && "$(cat "$GBV_BIN" 2>/dev/null)" == "$text" ]]; then return 0; fi
    mkdir -p "$(dirname "$GBV_BIN")" || { error "Cannot create $(dirname "$GBV_BIN")."; return 1; }
    tmp=$(mktemp "$(dirname "$GBV_BIN")/.grin-backup-verify.XXXXXX") || { error "Cannot write in $(dirname "$GBV_BIN")."; return 1; }
    printf '%s\n' "$text" > "$tmp" || { rm -f "$tmp"; error "Cannot write the wrapper."; return 1; }
    chmod 750 "$tmp" || { rm -f "$tmp"; error "Cannot chmod the wrapper."; return 1; }
    mv -f "$tmp" "$GBV_BIN" || { rm -f "$tmp"; error "Cannot install $GBV_BIN."; return 1; }
    return 0
}

# Rewrites the wrapper + lib copies only while the weekly check is on. Called when
# 089's menu opens (the toolkit's self-update has no post-install hook).
gbv_refresh_installed() {
    if [[ -f "$GBV_CRON" || -f "$GBV_BIN" ]]; then _gbv_write_generated || return 1; fi
    return 0
}

gbv_schedule_on() {
    local min tmp
    command -v python3 >/dev/null 2>&1 || warn "python3 not found — the weekly check will skip its data checks."
    _gbv_write_generated || return 1
    min=$((RANDOM % 60))
    mkdir -p "$(dirname "$GBV_CRON")" || { error "Cannot create $(dirname "$GBV_CRON")."; return 1; }
    # cron ignores names containing a dot, so the half-written file is never read.
    tmp="$GBV_CRON.new"
    printf '# Grin backup verifier, weekly — generated by lib/grin_backup_verify.sh (08 > 9 > V > 3)\n%s 6 * * 0 root %s >/dev/null 2>&1\n' \
        "$min" "$GBV_BIN" > "$tmp" || { rm -f "$tmp"; error "Could not write $tmp."; return 1; }
    chmod 644 "$tmp" || { rm -f "$tmp"; error "Could not chmod $tmp."; return 1; }
    mv -f "$tmp" "$GBV_CRON" || { rm -f "$tmp"; error "Could not install $GBV_CRON."; return 1; }
    success "Weekly check ON — Sundays 06:$(printf '%02d' "$min") → $GBV_BIN (result in $GBV_LOG)"
    return 0
}

# Removes the cron file, the wrapper, the lib copies and their version file.
gbv_schedule_off() {
    local lib
    rm -f "$GBV_CRON" || { error "Could not remove $GBV_CRON."; return 1; }
    rm -f "$GBV_BIN" || { error "Could not remove $GBV_BIN."; return 1; }
    if [[ "$(cd "$GBV_LIB_INSTALL_DIR" 2>/dev/null && pwd)" != "$_GBV_LIB_DIR" ]]; then
        for lib in "${_GBV_LIBS[@]}"; do
            rm -f "$GBV_LIB_INSTALL_DIR/$lib" || { error "Could not remove $GBV_LIB_INSTALL_DIR/$lib."; return 1; }
        done
        rm -f "$GBV_VERSION_FILE" || { error "Could not remove $GBV_VERSION_FILE."; return 1; }
    fi
    success "Weekly check OFF — cron, wrapper and lib copies removed."
    return 0
}

_gbv_last_result() {
    grep -F "=== RESULT:" "$GBV_LOG" 2>/dev/null | tail -1
}

# ─── Menu ────────────────────────────────────────────────────────────────────
# Runs one verification in a subshell. The menu shell holds a no-op INT trap while it
# waits, so Ctrl-C ends only the verification (its own trap wipes the sandbox and
# re-raises in the subshell) and the menu comes back. The previous INT trap returns.
_gbv_run_isolated() {
    local old rc
    old="$(trap -p INT)"
    trap ':' INT
    ( trap - INT; "$@" ); rc=$?
    trap - INT
    if [[ -n "$old" ]]; then eval "$old"; fi
    if [[ "$rc" -ge 128 ]]; then echo ""; warn "Interrupted — the sandbox was wiped."; fi
    return "$rc"
}

_gbv_pick_and_verify() {
    local -a files=()
    local f sel i
    while IFS= read -r f; do [[ -n "$f" && -f "$f" ]] && files+=("$f"); done < <(
        ls -t "$GBV_BACKUP_DIR"/* "$GBV_LEGACY_DIR"/temp_dir_*.tar.gz.enc "$GBV_LEGACY_DIR"/grin_backup_*.tar.gz 2>/dev/null | head -20)
    echo ""
    if [[ "${#files[@]}" -gt 0 ]]; then
        echo -e "  ${BOLD}Recent files${RESET} ${DIM}(newest first)${RESET}"
        for i in "${!files[@]}"; do
            printf '  %b%2d%b) %s  %b(%s)%b\n' "$GREEN" "$((i + 1))" "$RESET" "$(_gbv_clean "${files[$i]##*/}")" "$DIM" \
                "$(_gbv_human "$(stat -c %s "${files[$i]}" 2>/dev/null || echo 0)")" "$RESET"
        done
        echo ""
    else
        echo -e "  ${DIM}No files in $GBV_BACKUP_DIR.${RESET}"
    fi
    echo -e "  ${DIM}Any other file works too (.tar.gz .tgz .tar .gz .zip .enc .db .sqlite .sql) — give its full path.${RESET}"
    read -r -p "  Number or full path (0 = cancel): " sel || sel="0"
    sel="${sel#"${sel%%[![:space:]]*}"}"; sel="${sel%"${sel##*[![:space:]]}"}"
    if [[ -z "$sel" || "$sel" == "0" || "${sel,,}" == "q" ]]; then info "Cancelled."; return 0; fi
    if [[ "$sel" =~ ^[0-9]+$ ]]; then
        if [[ "$sel" -ge 1 && "$sel" -le "${#files[@]}" ]]; then
            f="${files[$((sel - 1))]}"
        else
            warn "No file number $sel."; return 1
        fi
    else
        f="$sel"
    fi
    _gbv_run_isolated gbv_verify_file "$f"
}

gbv_menu() {
    local c last saved="$GBV_INTERACTIVE"
    GBV_INTERACTIVE=1
    gbv_refresh_installed || warn "Could not refresh the weekly check's installed copies."
    while true; do
        clear 2>/dev/null || true
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  V  Verify backups — restore test in a sandbox${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  ${DIM}Decrypts, extracts every member into a private dir under $GBV_TMP_ROOT,${RESET}"
        echo -e "  ${DIM}reads the restored data, then wipes it. Nothing live is touched.${RESET}"
        if [[ -f "$GBV_CRON" ]]; then
            echo -e "  ${GREEN}Weekly check:${RESET} ${DIM}on ($GBV_CRON)${RESET}"
        else
            echo -e "  ${DIM}Weekly check: off${RESET}"
        fi
        last=$(_gbv_last_result)
        if [[ -n "$last" ]]; then echo -e "  ${DIM}Last result: $last${RESET}"; fi
        echo ""
        echo -e "  ${BOLD}1${RESET})  Verify the newest backup of each product"
        echo -e "     ${DIM}Every product archive, DB snapshot and onion tarball · freshness · offsite size${RESET}"
        echo ""
        echo -e "  ${BOLD}2${RESET})  Verify a file"
        echo -e "     ${DIM}Pick a recent backup, or any archive / database / SQL dump by path${RESET}"
        echo ""
        echo -e "  ${BOLD}3${RESET})  Weekly check on/off"
        echo -e "     ${DIM}Sundays 06:xx · unattended (never prompts) · result in $GBV_LOG${RESET}"
        echo ""
        echo -e "  ${DIM}0)  Back${RESET}"
        echo ""
        echo -ne "${BOLD}Choice [1/2/3/0]: ${RESET}"
        read -r c || c="0"
        case "${c,,}" in
            1) _gbv_run_isolated gbv_verify_newest_all || true; _gbv_pause ;;
            2) _gbv_pick_and_verify || true; _gbv_pause ;;
            3)
                if [[ -f "$GBV_CRON" ]]; then gbv_schedule_off || true; else gbv_schedule_on || true; fi
                _gbv_pause ;;
            0|q) GBV_INTERACTIVE="$saved"; return 0 ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}
