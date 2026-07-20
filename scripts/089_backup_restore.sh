#!/bin/bash
# =============================================================================
# 089_backup_restore.sh - Grin Node Toolkit Backup & Restore
# =============================================================================
# Backs up and restores all Grin-related configuration, nginx, SSL certs,
# wallets, databases, and cron schedules — but NOT chain data (re-syncable).
#
# Archive: /opt/grin/backups/grin_toolkit_backup_DDMMYYYY.tar.gz.enc
#          (standard naming/location — lib/grin_backup_engine.sh; one archive
#          per day, a same-day backup overwrites that day's file)
# Encryption: AES-256-CBC · password = <personal_key><DDMMYYYY> — the shared
#             personal key (grin_backup.conf) + the date from the filename.
# Legacy: pre-engine temp_dir_YYYYMMDD_HHMMSS.tar.gz.enc archives (password =
#         DDMMYYYY derived from the filename) remain restorable from
#         /opt/grin/temp or /opt/grin/backups.
# Offsite: menu P configures an scp push (lib/grin_backup_push.sh) — every
#          finished archive is auto-copied to one remote target.
#
# What is backed up:
#   · /opt/grin/conf/          — node configs, instances registry, API secrets
#   · /opt/grin/wallet/        — wallet dirs (toml, seed, wallet_data) — optional, default Y
#   · /opt/grin/drop-test/     — Grin Drop testnet (DB, config, secrets) — optional, default Y
#   · /opt/grin/drop-main/     — Grin Drop mainnet (DB, config, secrets) — optional, default Y
#   · ALL product SQLite DBs — captured via a consistent ONLINE snapshot
#     (sqlite3 ".backup": safe even while a collector is mid-write; duplication
#     with a service's own backup is intentional — this is the one-stop archive):
#       /opt/grin/grin-stats/stats.db          global health — blockchain stats (~100 MB)
#       /opt/grin/grin-price/grin-price.db     global health — price history
#       /opt/grin/grinscan/{test,main}/grinscan.db   GrinScan explorer (per net)
#       /opt/grin/solo-stats/*.db              solo mining — stats / payout ledger
#       /opt/grin/drop-{test,main}/drop-*.db   Grin Drop (alongside config + secrets)
#   · /opt/grin/grin-stats/config.env  — stats collector config
#   · /var/lib/tor/grin-mainnet/, /var/lib/tor/grin-testnet/
#                              — Tor HiddenService Ed25519 keys (.onion identity) — optional, default Y
#   · /etc/floonet-rs/         — Floonet relay config.toml + env (GoblinPay token) — optional, default Y
#   · /var/lib/floonet-rs/*.db — Floonet relay NIP-05 usernames + stored events (online snapshot)
#   · /etc/nginx/sites-available/*  (Grin-related configs only)
#   · /etc/letsencrypt/live/ + renewal/  — SSL certs
#   · root + www-data crontabs  — collector schedules
#   · /opt/grin/logs/          — optional, default N
#
# What is NOT backed up (reproducible via toolkit scripts):
#   · /opt/grin/node/*/chain_data/     (re-sync via script 01)
#   · /opt/grin/bin/grin               (re-download via script 01)
#   · /var/www/                        (re-deployed by nginx setup scripts)
#   · server/, public_html/, grin-wallet binary  (re-deployed by 052)
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Shared backup engine — key (ONE personal key for all products), standard
# naming/location, crypto, offsite push. Also provides the gbp_* push helpers.
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/grin_backup_engine.sh"

# ─── Paths ────────────────────────────────────────────────────────────────────
LOG_DIR="/opt/grin/logs"
LOG_FILE="$LOG_DIR/grin_backup_restore_$(date +%Y%m%d_%H%M%S).log"
CONF_DIR="/opt/grin/conf"
BACKUP_DIR="$GBE_BACKUP_DIR"              # /opt/grin/backups — standard location
LEGACY_BACKUP_DIR="/opt/grin/temp"        # pre-engine temp_dir_* archives live here
mkdir -p "$LOG_DIR"

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

# ─── Logging ──────────────────────────────────────────────────────────────────
log()     { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; log "[INFO]  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; log "[OK]    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; log "[WARN]  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; log "[ERROR] $*"; }

# ─── Helpers ──────────────────────────────────────────────────────────────────
confirm_step() {
    local prompt="$1"
    echo ""
    echo -ne "${BOLD}${YELLOW}▶ $prompt [y/N]: ${RESET}"
    read -r ans
    [[ "${ans,,}" == "y" ]]
}

section() {
    echo ""
    echo -e "${BOLD}${CYAN}── $* ──${RESET}"
    echo ""
}

pause() {
    echo ""
    echo -ne "${DIM}Press Enter to continue...${RESET}"
    read -r _
}

# =============================================================================
# COLLECTORS — build lists of what to include
# =============================================================================

# Populates global array NGINX_GRIN_CONFIGS with relevant nginx config paths.
# A config is "Grin-related" if its filename or its declared root dir matches
# any of the known Grin patterns.
_collect_nginx_grin_configs() {
    NGINX_GRIN_CONFIGS=()
    [[ -d /etc/nginx/sites-available ]] || return 0
    while IFS= read -r conf; do
        local root_dir
        root_dir=$(grep -oP '(?<=root\s)[^;]+' "$conf" 2>/dev/null | head -1 | xargs 2>/dev/null || true)
        local bname; bname=$(basename "$conf")
        if [[ "$bname" == *grin* || "$root_dir" == *grin* \
              || "$root_dir" == */fullmain* || "$root_dir" == */prunemain* \
              || "$root_dir" == */prunetest* ]]; then
            NGINX_GRIN_CONFIGS+=("$conf")
        fi
    done < <(find /etc/nginx/sites-available -maxdepth 1 -type f 2>/dev/null || true)
}

# Cron tag used to identify the backup schedule entry
CRON_TAG="# grin-toolkit-auto-backup"

# =============================================================================
# BACKUP
# =============================================================================
# Pass --auto as first arg for non-interactive mode (used by cron scheduler).
# In auto mode: uses default dest, includes wallet + drop, skips logs, no prompts.
run_backup() {
    local auto=false
    local keep_days=0          # retention in days; 0 = keep all (no auto-delete)
    [[ "${1:-}" == "--auto" ]] && auto=true
    [[ "${2:-}" =~ ^[0-9]+$ ]] && keep_days="${2}"

    if [[ "$auto" == false ]]; then
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  BACKUP — Grin Node Toolkit${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    fi

    # ── Step 1: Destination ──────────────────────────────────────────────────
    local dest_dir="$BACKUP_DIR"
    if [[ "$auto" == false ]]; then
        section "Step 1: Backup destination"
        echo -e "  Default: ${BOLD}$BACKUP_DIR${RESET}"
        echo -ne "${BOLD}Enter destination path (or Enter for default): ${RESET}"
        read -r _dest_input
        dest_dir="${_dest_input:-$BACKUP_DIR}"
    fi
    mkdir -p "$dest_dir" || { error "Cannot create $dest_dir"; return 1; }
    [[ "$auto" == false ]] && success "Destination: $dest_dir"

    # ── Encryption key — shared personal key, standard across ALL products ───
    # Password = <personal_key><DDMMYYYY>; the key is stored (mode 600) so the
    # cron run works unattended, and typed BY HAND on restore.
    if [[ "$auto" == true ]]; then
        gbe_load_key
        if [[ -z "$GBE_PERSONAL_KEY" ]]; then
            log "[AUTO-BACKUP] ERROR: no backup personal key set — open 08 ▸ 9 once and set one."
            return 1
        fi
    else
        gbe_require_key || { error "Backup needs a personal key."; pause; return 1; }
    fi

    # ── Step 2: Collect sources ──────────────────────────────────────────────
    [[ "$auto" == false ]] && section "Step 2: Collecting Grin sources"
    _collect_nginx_grin_configs

    local -a sources=()
    local -a db_sources=()        # SQLite DBs — snapshotted (not live-copied) at archive time
    local -a manifest_lines=()

    # /opt/grin/conf
    if [[ -d "$CONF_DIR" ]]; then
        sources+=("$CONF_DIR")
        manifest_lines+=("conf: $CONF_DIR")
        [[ "$auto" == false ]] && info "  ✓ $CONF_DIR"
    else
        [[ "$auto" == false ]] && warn "  — $CONF_DIR not found (skipping)"
    fi

    # nginx configs
    if [[ ${#NGINX_GRIN_CONFIGS[@]} -gt 0 ]]; then
        for _c in "${NGINX_GRIN_CONFIGS[@]}"; do
            sources+=("$_c")
            manifest_lines+=("nginx-config: $_c")
            [[ "$auto" == false ]] && info "  ✓ $_c"
        done
    else
        [[ "$auto" == false ]] && warn "  — No Grin nginx configs found (skipping)"
    fi

    # Let's Encrypt
    for _le in /etc/letsencrypt/live /etc/letsencrypt/renewal; do
        if [[ -d "$_le" ]]; then
            sources+=("$_le")
            manifest_lines+=("letsencrypt: $_le")
            [[ "$auto" == false ]] && info "  ✓ $_le"
        fi
    done

    # Crontabs
    if crontab -l &>/dev/null; then
        manifest_lines+=("crontab: root")
        [[ "$auto" == false ]] && info "  ✓ root crontab"
    fi
    if [[ -f /var/spool/cron/crontabs/www-data ]]; then
        manifest_lines+=("crontab: www-data")
        [[ "$auto" == false ]] && info "  ✓ www-data crontab"
    fi

    # ── Step 3: Wallets ──────────────────────────────────────────────────────
    local wallets_conf="$CONF_DIR/grin_wallets_location.conf"
    local -a wallet_dirs=()
    if [[ -f "$wallets_conf" ]]; then
        local _wdir
        while IFS= read -r _wdir; do
            [[ -d "$_wdir" ]] && wallet_dirs+=("$_wdir")
        done < <(grep -oP '(?<=_WALLET_DIR=")[^"]+' "$wallets_conf" 2>/dev/null | sort -u || true)
    fi

    if [[ "$auto" == false ]]; then
        section "Step 3: Wallet data"
    fi
    if [[ ${#wallet_dirs[@]} -gt 0 ]]; then
        local include_wallet=true
        if [[ "$auto" == false ]]; then
            echo -e "  ${YELLOW}Wallet dirs contain seed files — loss = unrecoverable.${RESET}"
            echo ""
            for _w in "${wallet_dirs[@]}"; do echo -e "  ${DIM}$_w${RESET}"; done
            echo ""
            echo -ne "${BOLD}Include wallet data? [Y/n]: ${RESET}"
            read -r _wallet_choice
            [[ "${_wallet_choice,,}" == "n" ]] && include_wallet=false
        fi
        if [[ "$include_wallet" == true ]]; then
            for _w in "${wallet_dirs[@]}"; do
                sources+=("$_w")
                manifest_lines+=("wallet: $_w")
                [[ "$auto" == false ]] && info "  ✓ $_w"
            done
        else
            [[ "$auto" == false ]] && warn "  — Wallet data excluded. Ensure you have your seed phrase backed up separately."
        fi
    else
        [[ "$auto" == false ]] && warn "  — No wallet dirs found in $wallets_conf (skipping)"
    fi

    # ── Step 4: Grin Drop data ───────────────────────────────────────────────
    # The Drop DB moved OUT of the wallet dir (2026-07) into its own data dir
    # /opt/grin/drop-<net>-data/ so a wallet re-install can't wipe it. Detect a
    # deployment via the NEW db path, the legacy in-dir db, or the config file.
    local -a _drop_nets=()
    for _net in test main; do
        if [[ -f "/opt/grin/drop-${_net}-data/drop-$_net.db" \
              || -f "/opt/grin/drop-$_net/drop-$_net.db" \
              || -f "/opt/grin/drop-$_net/grin_drop_$_net.conf" ]]; then
            _drop_nets+=("$_net")
        fi
    done

    if [[ ${#_drop_nets[@]} -gt 0 ]]; then
        local include_drop=true
        local include_drop_wallet_data=true

        if [[ "$auto" == false ]]; then
            section "Step 4: Grin Drop data"
            local _net_labels=""
            for _n in "${_drop_nets[@]}"; do
                _net_labels+="drop-$_n  "
            done
            echo -e "  ${YELLOW}Detected: ${BOLD}${_net_labels}${RESET}"
            echo ""
            echo -ne "${BOLD}Include Grin Drop data (DBs, configs, wallet secrets)? [Y/n]: ${RESET}"
            read -r _drop_choice
            [[ "${_drop_choice,,}" == "n" ]] && include_drop=false

            if [[ "$include_drop" == true ]]; then
                echo -ne "${BOLD}Include wallet_data/ (LMDB — faster migration, larger archive)? [Y/n]: ${RESET}"
                read -r _dropw_choice
                [[ "${_dropw_choice,,}" == "n" ]] && include_drop_wallet_data=false
            fi
        fi

        if [[ "$include_drop" == true ]]; then
            for _net in "${_drop_nets[@]}"; do
                local _dir="/opt/grin/drop-$_net"
                local _net_label; [[ "$_net" == "test" ]] && _net_label="testnet" || _net_label="mainnet"
                manifest_lines+=("drop-$_net_label:")
                for _f in \
                    "/opt/grin/drop-${_net}-data/drop-$_net.db" \
                    "$_dir/drop-$_net.db" \
                    "$_dir/grin_drop_$_net.conf" \
                    "$_dir/.temp_$_net" \
                    "$_dir/.word_$_net" \
                    "$_dir/.foreign_api_secret" \
                    "$_dir/.owner_api_secret" \
                    "$_dir/grin-wallet.toml"
                do
                    [[ -f "$_f" ]] || continue
                    if [[ "$_f" == *.db ]]; then
                        db_sources+=("$_f")        # consistent snapshot at archive time
                    else
                        sources+=("$_f")
                    fi
                    manifest_lines+=("  $(basename "$_f")")
                    [[ "$auto" == false ]] && info "  ✓ $_f"
                done
                if [[ "$include_drop_wallet_data" == true && -d "$_dir/wallet_data" ]]; then
                    sources+=("$_dir/wallet_data")
                    manifest_lines+=("  wallet_data/ (LMDB)")
                    [[ "$auto" == false ]] && info "  ✓ $_dir/wallet_data/"
                fi
            done
        else
            [[ "$auto" == false ]] && warn "  — Grin Drop excluded."
        fi
    fi

    # ── Step 5: Databases (ALL products) ─────────────────────────────────────
    # One-stop recovery archive: capture EVERY product SQLite DB — global health
    # (stats + price), GrinScan explorer (test+main), solo mining, and Grin Drop
    # (the drop .db was already queued in Step 4). Included by default; the user
    # hosts services on separate boxes, so duplication here is deliberate.
    # Each DB is captured via an online snapshot at archive time (sqlite3
    # ".backup", see Step 7) — consistent even while a 5-min collector writes.
    if [[ "$auto" == false ]]; then
        section "Step 5: Database files (all products)"
        echo -e "  ${YELLOW}All product DBs are captured via a consistent online snapshot${RESET}"
        echo -e "  ${YELLOW}(safe even while collectors are writing). Included by default.${RESET}"
        echo ""
    fi

    # config.env is a plain file (not a DB) — back it up live.
    if [[ -f /opt/grin/grin-stats/config.env ]]; then
        sources+=("/opt/grin/grin-stats/config.env")
        manifest_lines+=("stats-config: /opt/grin/grin-stats/config.env")
        [[ "$auto" == false ]] && info "  ✓ /opt/grin/grin-stats/config.env"
    fi

    local -A _db_labels=(
        ["/opt/grin/grin-stats/stats.db"]="Global health — blockchain stats (~100 MB)"
        ["/opt/grin/grin-price/grin-price.db"]="Global health — price history"
        ["/opt/grin/grinscan/test/grinscan.db"]="GrinScan explorer — testnet"
        ["/opt/grin/grinscan/main/grinscan.db"]="GrinScan explorer — mainnet"
    )
    local _db
    for _db in \
        /opt/grin/grin-stats/stats.db \
        /opt/grin/grin-price/grin-price.db \
        /opt/grin/grinscan/test/grinscan.db \
        /opt/grin/grinscan/main/grinscan.db \
        /opt/grin/solo-stats/*.db
    do
        [[ -f "$_db" ]] || continue        # unmatched glob stays literal → skipped
        local _db_size; _db_size=$(du -sh "$_db" 2>/dev/null | cut -f1)
        local _label="${_db_labels[$_db]:-Solo mining — stats / payout ledger}"
        db_sources+=("$_db")
        manifest_lines+=("database: $_db  ($_db_size — $_label)")
        [[ "$auto" == false ]] && info "  ✓ $_db  ($_db_size — $_label)"
    done

    # ── Step 5b: Tor HiddenService keys (.onion identity) ────────────────────
    # /var/lib/tor/grin-<network>*/ contains the Ed25519 keypair that defines the
    # .onion address. Backing this up lets the operator restore the same .onion
    # on a new VPS without breaking any wallet that bookmarked the URL.
    # The secret key is sensitive — the archive is AES-256-CBC encrypted by Step 7.
    # There are up to three services per network, each with its OWN identity dir:
    #   grin-<net>-raw-tcp  (Script 01 node onion)
    #   grin-<net>-nginx    (Script 04 Foreign-API onion)
    #   grin-<net>          (legacy pre-migration name, if still present)
    local -a _tor_onion_dirs=()
    for _net in mainnet testnet; do
        for _suffix in "-raw-tcp" "-nginx" ""; do
            local _d="/var/lib/tor/grin-${_net}${_suffix}"
            [[ -d "$_d" && -f "$_d/hs_ed25519_secret_key" ]] && _tor_onion_dirs+=("$_d")
        done
    done
    if [[ ${#_tor_onion_dirs[@]} -gt 0 ]]; then
        local include_tor=true
        if [[ "$auto" == false ]]; then
            section "Step 5b: Tor HiddenService identity keys"
            echo -e "  ${YELLOW}Detected .onion identity directories:${RESET}"
            for _t in "${_tor_onion_dirs[@]}"; do
                local _hn=""
                [[ -f "$_t/hostname" ]] && _hn=" → $(cat "$_t/hostname" 2>/dev/null || echo '?')"
                echo -e "  ${DIM}$_t${RESET}${_hn}"
            done
            echo ""
            echo -e "  ${YELLOW}These keys ARE your .onion identity. Backing them up lets you${RESET}"
            echo -e "  ${YELLOW}restore the same .onion address on another VPS.${RESET}"
            echo ""
            echo -ne "${BOLD}Include Tor HiddenService keys? [Y/n]: ${RESET}"
            read -r _tor_choice
            [[ "${_tor_choice,,}" == "n" ]] && include_tor=false
        fi
        if [[ "$include_tor" == true ]]; then
            for _t in "${_tor_onion_dirs[@]}"; do
                sources+=("$_t")
                manifest_lines+=("tor-onion: $_t")
                [[ "$auto" == false ]] && info "  ✓ $_t"
            done
        else
            [[ "$auto" == false ]] && warn "  — Tor HiddenService keys excluded. .onion identity will be lost on VPS migration."
        fi
    fi

    # ── Step 5c: Floonet relay (091) ─────────────────────────────────────────
    # The Grin-native Nostr relay keeps its identity + settings in /etc/floonet-rs
    # (config.toml + env with the GoblinPay token) and its NIP-05 username
    # registrations + stored events in /var/lib/floonet-rs/*.db. BOTH are needed to
    # migrate the relay to a new VPS with the same nicknames intact — a same-domain
    # move keeps the wss connection alive, but the name@domain registry lives ONLY
    # in the DB. (grin_floonet.conf rides along inside /opt/grin/conf, already added.)
    if [[ -f /etc/floonet-rs/config.toml || -x /usr/local/bin/floonet-rs ]]; then
        local include_floonet=true
        if [[ "$auto" == false ]]; then
            section "Step 5c: Floonet relay (Nostr)"
            echo -e "  ${YELLOW}Detected a floonet-rs relay.${RESET} Backing it up preserves the relay"
            echo -e "  ${YELLOW}config, GoblinPay token, and all NIP-05 usernames + stored events.${RESET}"
            echo ""
            echo -ne "${BOLD}Include Floonet relay (config + DB)? [Y/n]: ${RESET}"
            read -r _floonet_choice
            [[ "${_floonet_choice,,}" == "n" ]] && include_floonet=false
        fi
        if [[ "$include_floonet" == true ]]; then
            if [[ -d /etc/floonet-rs ]]; then
                sources+=("/etc/floonet-rs")
                manifest_lines+=("floonet: /etc/floonet-rs (config.toml + env)")
                [[ "$auto" == false ]] && info "  ✓ /etc/floonet-rs"
            fi
            local _fdb
            for _fdb in /var/lib/floonet-rs/*.db; do
                [[ -f "$_fdb" ]] || continue           # unmatched glob stays literal → skipped
                db_sources+=("$_fdb")                  # consistent snapshot at archive time
                manifest_lines+=("floonet-db: $_fdb (NIP-05 names + events)")
                [[ "$auto" == false ]] && info "  ✓ $_fdb"
            done
        else
            [[ "$auto" == false ]] && warn "  — Floonet relay excluded. Its usernames/events won't travel."
        fi
    fi

    # ── Step 6: Optional logs ────────────────────────────────────────────────
    if [[ "$auto" == false ]]; then
        section "Step 6: Optional — include logs"
        if [[ -d /opt/grin/logs ]]; then
            echo -ne "${BOLD}Include /opt/grin/logs/? [y/N]: ${RESET}"
            read -r _log_choice
            if [[ "${_log_choice,,}" == "y" ]]; then
                sources+=("/opt/grin/logs")
                manifest_lines+=("logs: /opt/grin/logs")
                info "  ✓ /opt/grin/logs"
            fi
        else
            info "  — /opt/grin/logs not found (skipping)"
        fi
    fi

    if [[ ${#sources[@]} -eq 0 && ${#db_sources[@]} -eq 0 ]]; then
        warn "Nothing to back up. Aborting."
        pause; return 0
    fi

    # ── Step 7: Create archive ───────────────────────────────────────────────
    [[ "$auto" == false ]] && section "Step 7: Creating archive"
    [[ "$auto" == true  ]] && log "[AUTO-BACKUP] Starting automated backup to $dest_dir"
    # Standard naming (lib/grin_backup_engine.sh): one archive per day —
    # password = <personal_key><DDMMYYYY-from-filename>.
    local d; d=$(gbe_date)
    local archive_basename="grin_toolkit_backup_${d}"
    local archive_gz="$archive_basename.tar.gz"
    local archive_enc="$archive_basename.tar.gz.enc"
    local tmp_dir; tmp_dir=$(mktemp -d)
    trap 'rm -rf "$tmp_dir"' EXIT

    # Write manifest
    local manifest_file="$tmp_dir/MANIFEST.txt"
    {
        echo "Grin Node Toolkit Backup"
        echo "Created: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
        echo "Host:    $(hostname)"
        echo ""
        echo "Contents:"
        for _line in "${manifest_lines[@]}"; do
            echo "  $_line"
        done
        echo ""
        echo "Excluded (not backed up):"
        echo "  /opt/grin/node/*/chain_data/  (re-sync via script 01)"
        echo "  /opt/grin/bin/grin            (re-download via script 01)"
        echo "  /var/www/                     (re-deployed by toolkit scripts)"
        echo "  server/, public_html/         (re-deployed by script 052)"
    } > "$manifest_file"

    # Write crontabs to staging area
    local cron_dir="$tmp_dir/crontabs"
    mkdir -p "$cron_dir"
    crontab -l > "$cron_dir/root.crontab" 2>/dev/null || true
    if [[ -f /var/spool/cron/crontabs/www-data ]]; then
        cp /var/spool/cron/crontabs/www-data "$cron_dir/www-data.crontab"
    fi

    # Write nginx enabled-symlinks manifest
    local nginx_enabled_manifest="$tmp_dir/nginx_enabled_symlinks.txt"
    if [[ -d /etc/nginx/sites-enabled ]]; then
        for _c in "${NGINX_GRIN_CONFIGS[@]+"${NGINX_GRIN_CONFIGS[@]}"}"; do
            local bname; bname=$(basename "$_c")
            if [[ -L "/etc/nginx/sites-enabled/$bname" ]]; then
                echo "$bname" >> "$nginx_enabled_manifest"
            fi
        done
    fi

    [[ "$auto" == false ]] && info "Building archive..."
    local archive_tmp="$tmp_dir/$archive_gz"

    # Stage extra files (manifest, crontabs, nginx symlinks list)
    local stage="$tmp_dir/stage"
    mkdir -p "$stage"
    cp "$manifest_file" "$stage/MANIFEST.txt"
    mkdir -p "$stage/crontabs"
    [[ -f "$cron_dir/root.crontab"     ]] && cp "$cron_dir/root.crontab"     "$stage/crontabs/"
    [[ -f "$cron_dir/www-data.crontab" ]] && cp "$cron_dir/www-data.crontab" "$stage/crontabs/"
    [[ -f "$nginx_enabled_manifest"    ]] && cp "$nginx_enabled_manifest"     "$stage/nginx_enabled_symlinks.txt"

    # Consistent SQLite snapshots — capture every product DB via the online
    # backup API (sqlite3 ".backup") into the staging tree under its real path
    # (leading / stripped), so the archive layout is identical to a live copy.
    # ".backup" yields a transactionally-consistent file even while a collector
    # is writing — no torn pages, no reliance on a timed checkpoint. Falls back
    # to a WAL checkpoint + live copy if ".backup" can't run. The original
    # owner/mode is copied onto the snapshot (it is created root-owned), so
    # restore lands each DB back with the ownership its service expects.
    local -a staged_db_rels=()
    local _dbsrc _rel
    for _dbsrc in "${db_sources[@]+"${db_sources[@]}"}"; do
        [[ -f "$_dbsrc" ]] || continue
        _rel="${_dbsrc#/}"
        mkdir -p "$stage/$(dirname "$_rel")"
        if command -v sqlite3 &>/dev/null \
           && timeout 60 sqlite3 "$_dbsrc" ".backup '$stage/$_rel'" &>/dev/null \
           && [[ -s "$stage/$_rel" ]]; then
            chmod --reference="$_dbsrc" "$stage/$_rel" 2>/dev/null || true
            chown --reference="$_dbsrc" "$stage/$_rel" 2>/dev/null || true
            [[ "$auto" == false ]] && info "  ✓ snapshot $_dbsrc"
        else
            # Fallback: flush WAL into the main file, then a live copy (cp -a
            # preserves owner/mode). Best effort — skip if even that fails.
            command -v sqlite3 &>/dev/null && timeout 10 sqlite3 "$_dbsrc" "PRAGMA wal_checkpoint(FULL);" &>/dev/null || true
            cp -a "$_dbsrc" "$stage/$_rel" 2>/dev/null || { warn "  Could not snapshot $_dbsrc — skipping."; continue; }
            [[ "$auto" == false ]] && warn "  ~ live copy (no .backup) $_dbsrc"
        fi
        staged_db_rels+=("$_rel")
    done

    # Never let the shared personal key (grin_backup.conf) or the offsite target
    # (grin_backup_remote.conf) travel INSIDE the archive: the whole security
    # model is "key lives in the operator's head, typed by hand on restore".
    # Both are regenerated via 08▸9 after a restore.
    tar -czf "$archive_tmp" \
        --exclude='*/grin_backup.conf' --exclude='*/grin_backup_remote.conf' \
        -C "$stage" MANIFEST.txt crontabs \
        $( [[ -f "$stage/nginx_enabled_symlinks.txt" ]] && echo "nginx_enabled_symlinks.txt" || true ) \
        "${staged_db_rels[@]+"${staged_db_rels[@]}"}" \
        "${sources[@]+"${sources[@]}"}" \
        2>/dev/null || true

    # tar rc is tolerated ("file changed as we read it" is benign) — but a
    # ZERO-BYTE archive is a real failure (disk full mid-write): never encrypt,
    # keep, or push that. (A gzip header is ~20 bytes, so this is a truncation
    # guard, not a "captured nothing" guard — the stage always holds MANIFEST.)
    if [[ ! -s "$archive_tmp" ]]; then
        error "Archive came out empty (zero bytes) — aborting (disk full?)."
        log "[BACKUP] ERROR: empty archive, aborted"
        trap - EXIT; rm -rf "$tmp_dir"
        [[ "$auto" == false ]] && pause
        return 1
    fi

    # Encrypt archive (engine: AES-256-CBC/PBKDF2, password via fd:3)
    [[ "$auto" == false ]] && info "Encrypting archive..."
    local archive_enc_tmp="$tmp_dir/$archive_enc"
    if ! gbe_encrypt "$archive_tmp" "$archive_enc_tmp" "${GBE_PERSONAL_KEY}${d}"; then
        error "openssl encryption failed — aborting."
        log "[BACKUP] ERROR: encryption failed"
        trap - EXIT; rm -rf "$tmp_dir"
        [[ "$auto" == false ]] && pause
        return 1
    fi
    rm "$archive_tmp"

    # Move to final destination atomically
    mv "$archive_enc_tmp" "$dest_dir/$archive_enc"
    trap - EXIT
    rm -rf "$tmp_dir"

    local size; size=$(du -sh "$dest_dir/$archive_enc" 2>/dev/null | cut -f1)

    # Standard archive perms (match solo/drop): 600 root:root, dir 700.
    chmod 600 "$dest_dir/$archive_enc" 2>/dev/null || true
    chown root:root "$dest_dir/$archive_enc" 2>/dev/null || true
    chmod 700 "$dest_dir" 2>/dev/null || true

    # ── Offsite push (scp) — no-op unless configured via menu P ──────────────
    if gbp_configured; then
        if gbp_push_file "$dest_dir/$archive_enc"; then
            [[ "$auto" == false ]] && success "Offsite copy pushed → ${GBP_USER}@${GBP_HOST}:${GBP_DIR}"
            log "[PUSH] $archive_enc → ${GBP_USER}@${GBP_HOST}:${GBP_DIR}"
        else
            [[ "$auto" == false ]] && warn "Offsite push FAILED — local archive is safe. See $GBP_LOG"
            log "[PUSH] FAILED for $archive_enc — see $GBP_LOG"
        fi
    fi

    # ── Retention — auto-delete older scheduled archives (keep_days > 0) ──────
    # Only prunes this toolkit's own encrypted archives (grin_toolkit_backup_* and
    # legacy temp_dir_*), so a custom dest holding other files is never touched.
    # -mtime +N keeps the last N days. keep_days=0 (manual "Backup now", or
    # "Keep all") prunes nothing.
    if [[ "$keep_days" -gt 0 ]]; then
        local _n_pruned
        _n_pruned=$(find "$dest_dir" -maxdepth 1 -type f \
                    \( -name 'grin_toolkit_backup_*.tar.gz.enc' -o -name 'temp_dir_*.tar.gz.enc' \) \
                    -mtime "+$keep_days" -print 2>/dev/null | wc -l | tr -d ' ')
        if [[ "${_n_pruned:-0}" -gt 0 ]]; then
            find "$dest_dir" -maxdepth 1 -type f \
                 \( -name 'grin_toolkit_backup_*.tar.gz.enc' -o -name 'temp_dir_*.tar.gz.enc' \) \
                 -mtime "+$keep_days" -delete 2>/dev/null || true
            log "[RETENTION] Pruned $_n_pruned archive(s) older than $keep_days days in $dest_dir"
            [[ "$auto" == false ]] && info "Retention: pruned $_n_pruned archive(s) older than $keep_days days."
        fi
    fi

    # ── Step 8: Done ─────────────────────────────────────────────────────────
    if [[ "$auto" == false ]]; then
        section "Backup complete"
        success "Archive  : $dest_dir/$archive_enc"
        success "Size     : $size"
        echo ""
        echo -e "  ${YELLOW}Encrypted — password: ${BOLD}your personal key + ${d}${RESET}${YELLOW}  (date in the filename)${RESET}"
        log "[BACKUP] Created: $dest_dir/$archive_enc ($size)"
        pause
    else
        log "[AUTO-BACKUP] Completed: $dest_dir/$archive_enc ($size)"
    fi
}

# =============================================================================
# RESTORE
# =============================================================================
run_restore() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  RESTORE — Grin Node Toolkit${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    warn "Restore will OVERWRITE existing files. Stop the node AND any wallet"
    warn "listeners first — extracting wallet_data/ (LMDB) over an open wallet"
    warn "can corrupt it."
    echo ""

    # ── Step 1: Choose archive ───────────────────────────────────────────────
    section "Step 1: Select backup archive"

    # Standard format (grin_toolkit_backup_*) + legacy encrypted (temp_dir_*)
    # + legacy unencrypted (grin_backup_*), from both the standard dir and the
    # old /opt/grin/temp location, newest first.
    local -a archives=()
    while IFS= read -r _f; do
        [[ -n "$_f" ]] && archives+=("$_f")
    done < <(ls -t "$BACKUP_DIR"/grin_toolkit_backup_*.tar.gz.enc \
                   "$BACKUP_DIR"/temp_dir_*.tar.gz.enc \
                   "$LEGACY_BACKUP_DIR"/temp_dir_*.tar.gz.enc \
                   "$LEGACY_BACKUP_DIR"/grin_backup_*.tar.gz 2>/dev/null || true)

    local chosen_archive=""

    if [[ ${#archives[@]} -gt 0 ]]; then
        echo -e "  Available archives (${BOLD}$BACKUP_DIR${RESET} + legacy ${DIM}$LEGACY_BACKUP_DIR${RESET}):"
        echo ""
        local i=1
        for _a in "${archives[@]}"; do
            local sz; sz=$(du -sh "$_a" 2>/dev/null | cut -f1)
            local _enc_tag=""
            [[ "$_a" == *.enc ]] && _enc_tag="  ${CYAN}[encrypted]${RESET}"
            echo -e "  ${BOLD}$i)${RESET} $(basename "$_a")  ${DIM}($sz)${RESET}${_enc_tag}"
            (( i++ ))
        done
        echo -e "  ${DIM}C) Enter custom path${RESET}"
        echo -e "  ${DIM}0) Cancel${RESET}"
        echo ""
        echo -ne "${BOLD}Choose archive [1-${#archives[@]}/C/0]: ${RESET}"
        read -r _pick

        case "${_pick,,}" in
            0) info "Cancelled."; return 0 ;;
            c)
                echo -ne "${BOLD}Enter full path to archive: ${RESET}"
                read -r chosen_archive
                ;;
            *)
                if [[ "$_pick" =~ ^[0-9]+$ ]] && (( _pick >= 1 && _pick <= ${#archives[@]} )); then
                    chosen_archive="${archives[$(( _pick - 1 ))]}"
                else
                    error "Invalid selection."; pause; return 1
                fi
                ;;
        esac
    else
        warn "No archives found in $BACKUP_DIR."
        echo -ne "${BOLD}Enter full path to archive (or 0 to cancel): ${RESET}"
        read -r chosen_archive
        [[ "$chosen_archive" == "0" ]] && { info "Cancelled."; return 0; }
    fi

    if [[ ! -f "$chosen_archive" ]]; then
        error "Archive not found: $chosen_archive"
        pause; return 1
    fi

    # ── Step 2: Decrypt (if encrypted) ──────────────────────────────────────
    local working_archive="$chosen_archive"
    local tmp_dir; tmp_dir=$(mktemp -d)
    trap 'rm -rf "$tmp_dir"' EXIT

    if [[ "$(basename "$chosen_archive")" == grin_toolkit_backup_*.tar.gz.enc ]]; then
        # ── Standard format: password = <personal_key><DDMMYYYY-from-filename>
        section "Step 2: Decrypting archive"
        local _d
        if ! _d=$(gbe_parse_date "$chosen_archive"); then
            error "Cannot read the date from the filename: $(basename "$chosen_archive")"
            rm -rf "$tmp_dir"; trap - EXIT; pause; return 1
        fi
        echo -e "  ${DIM}Password = your personal key + ${_d} (auto-read from the filename).${RESET}"
        local _key _pass
        read -rs -p "  Personal key for this backup: " _key; echo ""
        if [[ -z "$_key" ]]; then
            warn "No key entered."
            rm -rf "$tmp_dir"; trap - EXIT; pause; return 1
        fi
        _pass="${_key}${_d}"; unset _key
        local _decrypted="$tmp_dir/archive.tar.gz"
        if ! gbe_decrypt "$chosen_archive" "$_decrypted" "$_pass"; then
            unset _pass
            error "Wrong key or corrupt backup."
            rm -rf "$tmp_dir"; trap - EXIT; pause; return 1
        fi
        unset _pass
        success "Decrypted successfully."
        working_archive="$_decrypted"
    elif [[ "$chosen_archive" == *.enc ]]; then
        section "Step 2: Decrypting archive (legacy temp_dir format)"
        # Derive password from YYYYMMDD embedded in filename
        local _bname; _bname=$(basename "$chosen_archive")
        local _date_part; _date_part=$(echo "$_bname" | grep -oP '\d{8}' | head -1 || true)
        local _derived_pass=""
        if [[ "${#_date_part}" -eq 8 ]]; then
            _derived_pass="${_date_part:6:2}${_date_part:4:2}${_date_part:0:4}"
            echo -e "  ${CYAN}Derived password:${RESET} ${BOLD}$_derived_pass${RESET}  ${DIM}(DDMMYYYY from filename)${RESET}"
        fi

        local _decrypted="$tmp_dir/archive.tar.gz"
        local _dec_ok=false

        if [[ -n "$_derived_pass" ]]; then
            info "Trying derived password..."
            if {
                openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
                    -in "$chosen_archive" -out "$_decrypted" -pass fd:3
            } 3< <(printf '%s' "$_derived_pass") 2>/dev/null; then
                _dec_ok=true
                success "Decrypted successfully."
            fi
        fi

        if [[ "$_dec_ok" == false ]]; then
            warn "Derived password did not work. Enter the password manually."
            echo -ne "${BOLD}Password: ${RESET}"
            read -rs _manual_pass
            echo ""
            if ! {
                openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
                    -in "$chosen_archive" -out "$_decrypted" -pass fd:3
            } 3< <(printf '%s' "$_manual_pass") 2>/dev/null; then
                error "Decryption failed — wrong password?"
                rm -rf "$tmp_dir"; trap - EXIT; pause; return 1
            fi
            success "Decrypted successfully."
        fi

        working_archive="$_decrypted"
    fi

    # ── Step 3: Show manifest ────────────────────────────────────────────────
    section "Step 3: Archive contents"
    echo ""
    tar -xOzf "$working_archive" MANIFEST.txt 2>/dev/null \
        || warn "No MANIFEST.txt found in archive."
    echo ""

    # ── Step 4: Confirm ──────────────────────────────────────────────────────
    if ! confirm_step "Restore $(basename "$chosen_archive") — this will overwrite existing files. Proceed?"; then
        info "Cancelled."
        trap - EXIT; rm -rf "$tmp_dir"; return 0
    fi

    # ── Step 5: Extract ──────────────────────────────────────────────────────
    section "Step 5: Restoring files"

    local extract_dir="$tmp_dir/extracted"
    mkdir -p "$extract_dir"
    info "Extracting archive..."
    tar -xzf "$working_archive" -C "$extract_dir" 2>/dev/null || true

    local nginx_restored=false

    # conf/
    if [[ -d "$extract_dir/opt/grin/conf" ]]; then
        mkdir -p "$CONF_DIR"
        cp -a "$extract_dir/opt/grin/conf/." "$CONF_DIR/"
        success "Restored: $CONF_DIR"
        log "[RESTORE] conf → $CONF_DIR"
    fi

    # nginx configs
    if [[ -d "$extract_dir/etc/nginx/sites-available" ]]; then
        cp -a "$extract_dir/etc/nginx/sites-available/." /etc/nginx/sites-available/ 2>/dev/null || true
        success "Restored: nginx sites-available"
        nginx_restored=true
        log "[RESTORE] nginx sites-available"
    fi

    # Re-enable nginx symlinks from manifest
    if [[ -f "$extract_dir/nginx_enabled_symlinks.txt" ]]; then
        while IFS= read -r _bname; do
            local _src="/etc/nginx/sites-available/$_bname"
            local _dst="/etc/nginx/sites-enabled/$_bname"
            if [[ -f "$_src" && ! -e "$_dst" ]]; then
                ln -s "$_src" "$_dst"
                success "Re-enabled nginx: $_bname"
            fi
        done < "$extract_dir/nginx_enabled_symlinks.txt"
    fi

    # Let's Encrypt
    for _le in live renewal; do
        if [[ -d "$extract_dir/etc/letsencrypt/$_le" ]]; then
            mkdir -p "/etc/letsencrypt/$_le"
            cp -a "$extract_dir/etc/letsencrypt/$_le/." "/etc/letsencrypt/$_le/" 2>/dev/null || true
            success "Restored: /etc/letsencrypt/$_le"
            log "[RESTORE] letsencrypt/$_le"
        fi
    done

    # Tor HiddenService keys — restore the .onion identity for each network
    # found in the archive. Two ownership conventions in the wild:
    #   debian-tor:debian-tor   (Debian/Ubuntu)
    #   toranon:toranon         (Rocky/Alma — newer Fedora-based)
    # Try each in order; whichever user actually exists wins.
    # Also strip torrc entries with the same marker for the network — Script 01
    # on the new VPS may write a *different* HS dir; we want torrc to point at
    # the restored one. The next Script 01 run will rewrite the marker block
    # idempotently to the canonical content, so this just keeps things tidy.
    # Restore EVERY grin-* identity dir present in the archive — Script 01
    # (grin-<net>-raw-tcp), Script 04 (grin-<net>-nginx), and any legacy
    # grin-<net> — not just a single hardcoded name. Glob the archive so we
    # never silently drop the Foreign-API onion.
    local _tor_restored_nets=()
    local -a _tor_srcs=()
    shopt -s nullglob
    for _cand in "$extract_dir"/var/lib/tor/grin-*; do
        [[ -d "$_cand" && -f "$_cand/hs_ed25519_secret_key" ]] && _tor_srcs+=("$_cand")
    done
    shopt -u nullglob

    if [[ ${#_tor_srcs[@]} -gt 0 ]]; then
        # Stop tor ONCE before swapping dirs so it doesn't republish stale descriptors
        local _tor_was_running=0
        if systemctl is-active --quiet tor 2>/dev/null; then
            _tor_was_running=1
            systemctl stop tor 2>/dev/null || true
        fi

        # Resolve the tor service user once (varies by distro)
        local _tor_user=""
        for _u in debian-tor toranon tor _tor; do
            if id "$_u" &>/dev/null; then _tor_user="$_u"; break; fi
        done

        for _tor_src in "${_tor_srcs[@]}"; do
            local _base; _base=$(basename "$_tor_src")   # e.g. grin-mainnet-nginx
            local _tor_dst="/var/lib/tor/$_base"

            mkdir -p "$_tor_dst"
            cp -a "$_tor_src/." "$_tor_dst/"

            # Permissions: 700 on dir, 600 on secret key
            chmod 700 "$_tor_dst"
            [[ -f "$_tor_dst/hs_ed25519_secret_key" ]] && chmod 600 "$_tor_dst/hs_ed25519_secret_key"

            if [[ -n "$_tor_user" ]]; then
                chown -R "$_tor_user:$_tor_user" "$_tor_dst" 2>/dev/null || true
            else
                warn "  No tor user found — leaving $_tor_dst owned by root. tor may refuse to read it."
            fi

            _tor_restored_nets+=("$_base")
            local _hn=""
            [[ -f "$_tor_dst/hostname" ]] && _hn=" → $(cat "$_tor_dst/hostname" 2>/dev/null || echo '?')"
            success "Restored Tor identity: $_tor_dst${_hn}"
            log "[RESTORE] tor-onion ${_base}${_hn}"
        done

        if [[ $_tor_was_running -eq 1 ]]; then
            systemctl start tor 2>/dev/null || true
        fi
    fi
    if [[ ${#_tor_restored_nets[@]} -gt 0 ]]; then
        echo -e "  ${YELLOW}Note:${RESET} re-run the owning script so the matching torrc HiddenService"
        echo -e "        stanza is (re)written and tor picks up the identity:"
        echo -e "        ${DIM}· grin-<net>-raw-tcp → Script 01 (or M/T/K rebuild)${RESET}"
        echo -e "        ${DIM}· grin-<net>-nginx   → Script 04 option T (reuses the restored key)${RESET}"
    fi

    # Floonet relay (091) — config identity + NIP-05 username/events DB. Restore
    # BOTH so a new VPS serves the same relay with the same nicknames (a same-domain
    # move keeps the wss connection, but the name@domain registry lives only in the
    # DB). Stop the service first to avoid a torn DB copy. Ownership: config →
    # root:floonet 640 when the stable `floonet` user + unit exist (a DynamicUser
    # fallback can't read a root-only file, so leave 600 then and let 091 relax it);
    # DB/state → floonet:floonet. On a bare box the floonet user/unit may not exist
    # yet — files land root-owned and a later Script 091 run reclaims them.
    local _floonet_restored=false
    if [[ -d "$extract_dir/etc/floonet-rs" ]] || ls "$extract_dir"/var/lib/floonet-rs/*.db >/dev/null 2>&1; then
        systemctl stop floonet-rs 2>/dev/null || true
        if [[ -d "$extract_dir/etc/floonet-rs" ]]; then
            mkdir -p /etc/floonet-rs
            cp -a "$extract_dir/etc/floonet-rs/." /etc/floonet-rs/
            if id floonet &>/dev/null && grep -qs '^User=floonet' /etc/systemd/system/floonet-rs.service 2>/dev/null; then
                chown root:floonet /etc/floonet-rs/config.toml 2>/dev/null || true
                chmod 640 /etc/floonet-rs/config.toml 2>/dev/null || true
            else
                chmod 600 /etc/floonet-rs/config.toml 2>/dev/null || true
            fi
            [[ -f /etc/floonet-rs/env ]] && chmod 600 /etc/floonet-rs/env 2>/dev/null || true
            success "Restored: /etc/floonet-rs (relay config + env)"
            log "[RESTORE] floonet /etc/floonet-rs"
            _floonet_restored=true
        fi
        if ls "$extract_dir"/var/lib/floonet-rs/*.db >/dev/null 2>&1; then
            mkdir -p /var/lib/floonet-rs
            cp -a "$extract_dir"/var/lib/floonet-rs/*.db /var/lib/floonet-rs/ 2>/dev/null || true
            id floonet &>/dev/null && chown -R floonet:floonet /var/lib/floonet-rs 2>/dev/null || true
            success "Restored: /var/lib/floonet-rs (NIP-05 usernames + events)"
            log "[RESTORE] floonet DB"
            _floonet_restored=true
        fi
    fi

    # Wallet dirs
    if [[ -d "$extract_dir/opt/grin/wallet" ]]; then
        mkdir -p /opt/grin/wallet
        cp -a "$extract_dir/opt/grin/wallet/." /opt/grin/wallet/ 2>/dev/null || true
        find /opt/grin/wallet -maxdepth 1 -mindepth 1 -type d | while IFS= read -r _wd; do
            chmod 700 "$_wd" 2>/dev/null || true
            [[ -d "$_wd/wallet_data" ]] && chmod 700 "$_wd/wallet_data" 2>/dev/null || true
            # The live secrets are .foreign_api_secret / .owner_api_secret (in the
            # wallet dir). .api_secret is a dead legacy override — harden the real ones.
            for _s in "$_wd/.foreign_api_secret" "$_wd/.owner_api_secret" \
                      "$_wd/wallet_data/.api_secret" "$_wd/wallet_data/.owner_api_secret"; do
                [[ -f "$_s" ]] && chmod 600 "$_s" 2>/dev/null || true
            done
        done
        if id grin &>/dev/null; then
            chown -R grin:grin /opt/grin/wallet 2>/dev/null || true
        fi
        success "Restored: /opt/grin/wallet"
        log "[RESTORE] wallet"
    fi

    # Grin Drop dirs (individual files extracted from absolute paths)
    for _net in test main; do
        local _drop_src="$extract_dir/opt/grin/drop-$_net"
        local _drop_data_src="$extract_dir/opt/grin/drop-${_net}-data"
        [[ -d "$_drop_src" || -d "$_drop_data_src" ]] || continue
        local _drop_dest="/opt/grin/drop-$_net"
        mkdir -p "$_drop_dest"
        local _net_label; [[ "$_net" == "test" ]] && _net_label="testnet" || _net_label="mainnet"

        for _f in \
            "grin_drop_$_net.conf" \
            ".temp_$_net" \
            ".word_$_net" \
            ".foreign_api_secret" \
            ".owner_api_secret" \
            "grin-wallet.toml"
        do
            [[ -f "$_drop_src/$_f" ]] || continue
            cp "$_drop_src/$_f" "$_drop_dest/$_f"
            chmod 600 "$_drop_dest/$_f" 2>/dev/null || true
        done

        if [[ -d "$_drop_src/wallet_data" ]]; then
            cp -a "$_drop_src/wallet_data" "$_drop_dest/"
            chmod 700 "$_drop_dest/wallet_data" 2>/dev/null || true
        fi

        if id grin &>/dev/null; then
            chown -R grin:grin "$_drop_dest" 2>/dev/null || true
        fi

        # DB → its own data dir (post-2026-07 layout: survives wallet
        # re-install). Accept either archive layout: new (drop-<net>-data/)
        # or legacy (db inside the wallet dir) — never land it back in the
        # wallet dir, or the app restarts with a fresh empty DB.
        local _dbsrc=""
        if [[ -f "$_drop_data_src/drop-$_net.db" ]]; then
            _dbsrc="$_drop_data_src/drop-$_net.db"
        elif [[ -f "$_drop_src/drop-$_net.db" ]]; then
            _dbsrc="$_drop_src/drop-$_net.db"
        fi
        if [[ -n "$_dbsrc" ]]; then
            local _dbdir="/opt/grin/drop-${_net}-data"
            mkdir -p "$_dbdir"
            cp -a "$_dbsrc" "$_dbdir/drop-$_net.db"
            chmod 700 "$_dbdir" 2>/dev/null || true
            chmod 600 "$_dbdir/drop-$_net.db" 2>/dev/null || true
            if id grin &>/dev/null; then
                chown -R grin:grin "$_dbdir" 2>/dev/null || true
            fi
            success "Restored: $_dbdir/drop-$_net.db"
        fi

        success "Restored: Grin Drop $_net_label"
        log "[RESTORE] drop-$_net"
    done

    # Database files — global health (stats/price) + GrinScan explorer.
    # cp -a preserves the owner/mode that was captured into the archive when the
    # snapshot was taken, so each DB lands back as the user its service expects.
    for _db_rel in \
        "opt/grin/grin-stats/stats.db" \
        "opt/grin/grin-stats/config.env" \
        "opt/grin/grin-price/grin-price.db" \
        "opt/grin/grinscan/test/grinscan.db" \
        "opt/grin/grinscan/main/grinscan.db"
    do
        if [[ -f "$extract_dir/$_db_rel" ]]; then
            local _db_dest="/$_db_rel"
            mkdir -p "$(dirname "$_db_dest")"
            cp -a "$extract_dir/$_db_rel" "$_db_dest"
            success "Restored: $_db_dest"
            log "[RESTORE] $_db_dest"
        fi
    done

    # Solo-mining stats DBs — one per network/key, names vary, so glob them.
    if [[ -d "$extract_dir/opt/grin/solo-stats" ]]; then
        mkdir -p /opt/grin/solo-stats
        local _sdb
        for _sdb in "$extract_dir/opt/grin/solo-stats/"*.db; do
            [[ -f "$_sdb" ]] || continue
            cp -a "$_sdb" "/opt/grin/solo-stats/$(basename "$_sdb")"
            success "Restored: /opt/grin/solo-stats/$(basename "$_sdb")"
            log "[RESTORE] /opt/grin/solo-stats/$(basename "$_sdb")"
        done
    fi

    # Logs
    if [[ -d "$extract_dir/opt/grin/logs" ]]; then
        mkdir -p /opt/grin/logs
        cp -a "$extract_dir/opt/grin/logs/." /opt/grin/logs/ 2>/dev/null || true
        success "Restored: /opt/grin/logs"
        log "[RESTORE] logs"
    fi

    # Crontabs
    if [[ -f "$extract_dir/crontabs/root.crontab" ]]; then
        crontab "$extract_dir/crontabs/root.crontab"
        success "Restored: root crontab"
        log "[RESTORE] root crontab"
    fi
    if [[ -f "$extract_dir/crontabs/www-data.crontab" ]]; then
        mkdir -p /var/spool/cron/crontabs
        cp "$extract_dir/crontabs/www-data.crontab" /var/spool/cron/crontabs/www-data
        chown www-data:crontab /var/spool/cron/crontabs/www-data 2>/dev/null || true
        chmod 600 /var/spool/cron/crontabs/www-data 2>/dev/null || true
        success "Restored: www-data crontab"
        log "[RESTORE] www-data crontab"
    fi

    trap - EXIT
    rm -rf "$tmp_dir"

    # ── Step 6: Reload nginx if needed ───────────────────────────────────────
    if [[ "$nginx_restored" == true ]]; then
        section "Step 6: Reloading nginx"
        if nginx -t 2>/dev/null; then
            systemctl reload nginx && success "nginx reloaded." || warn "nginx reload failed — check manually."
        else
            warn "nginx config test failed — fix before reloading:"
            nginx -t
        fi
    fi

    # ── Step 7: Summary ──────────────────────────────────────────────────────
    section "Restore complete"
    success "Files restored from: $(basename "$chosen_archive")"
    echo ""
    echo -e "  ${YELLOW}Next steps:${RESET}"
    echo -e "  · If the Grin binary is missing, re-install it via ${BOLD}Script 01${RESET}"
    echo -e "  · Start the Grin node via ${BOLD}Script 01 → S) Start${RESET}"
    echo -e "  · Chain data will re-sync automatically, or use ${BOLD}Script 03${RESET} to stream it"
    echo -e "  · If stats.db was restored, resume the stats cron — no re-crawl needed"
    echo -e "  · If GrinScan / solo-mining DBs were restored, (re)start those services to pick them up"
    echo -e "  · If Grin Drop was restored, restart services via ${BOLD}Script 052 → menu${RESET}"
    if [[ "$_floonet_restored" == true ]]; then
        echo -e "  · Re-run ${BOLD}Script 091${RESET} to (re)install the relay binary/service — your restored"
        echo -e "    config + NIP-05 usernames are preserved; repoint the domain's DNS + re-issue SSL"
    fi
    echo -e "  · Web content (${DIM}/var/www/${RESET}) is redeployed automatically by each setup script"
    echo ""
    log "[RESTORE] Completed from: $chosen_archive"
    pause
}

# =============================================================================
# SCHEDULE
# =============================================================================
# _active_schedule — prints the current cron line if set, else empty string
_active_schedule() {
    crontab -l 2>/dev/null | grep "$CRON_TAG" | grep -v '^#' || true
}

run_schedule() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  S  Schedule Automatic Backup${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    local current; current="$(_active_schedule)"
    if [[ -n "$current" ]]; then
        echo -e "  ${GREEN}Active schedule:${RESET}  $current"
        echo ""
        echo -e "  ${BOLD}N${RESET})  Set a new schedule  ${DIM}(replaces current)${RESET}"
        echo -e "  ${BOLD}D${RESET})  Remove schedule"
        echo -e "  ${DIM}0)  Return${RESET}"
        echo ""
        echo -ne "${BOLD}Choice [N/D/0]: ${RESET}"
        read -r _sched_action
        case "${_sched_action,,}" in
            d)
                local _new_cron
                _new_cron=$(crontab -l 2>/dev/null | grep -v "$CRON_TAG" || true)
                echo "$_new_cron" | crontab -
                success "Backup schedule removed."
                log "[SCHEDULE] Removed backup cron entry."
                pause; return
                ;;
            0) return ;;
            n) : ;;  # fall through to setup below
            *) warn "Invalid option."; sleep 1; return ;;
        esac
    fi

    # ── Require the shared personal key (the cron run encrypts with it) ──────
    gbe_require_key || { error "Scheduling needs a personal key."; pause; return; }

    # ── Pick frequency ───────────────────────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}1${RESET})  Daily"
    echo -e "  ${BOLD}2${RESET})  2 days per week"
    echo -e "  ${DIM}0)  Cancel${RESET}"
    echo ""
    echo -ne "${BOLD}Frequency [1/2/0]: ${RESET}"
    read -r _freq

    local cron_days="*"   # default: every day

    case "$_freq" in
        0) return ;;
        1) cron_days="*" ;;
        2)
            echo ""
            echo -e "  Pick ${BOLD}2 days${RESET} (space-separated numbers):"
            echo -e "  1=Mon  2=Tue  3=Wed  4=Thu  5=Fri  6=Sat  7=Sun"
            echo ""
            echo -ne "${BOLD}Days [e.g. 1 5]: ${RESET}"
            read -r _days_input
            local -a _picked_days=()
            for _d in $_days_input; do
                if [[ "$_d" =~ ^[1-7]$ ]]; then
                    # cron uses 0=Sun,1=Mon...6=Sat; our input is 1=Mon...7=Sun
                    local _cron_dow=$(( _d % 7 ))
                    _picked_days+=("$_cron_dow")
                fi
            done
            if [[ ${#_picked_days[@]} -ne 2 ]]; then
                error "Please enter exactly 2 valid day numbers (1–7)."; pause; return
            fi
            cron_days="${_picked_days[0]},${_picked_days[1]}"
            ;;
        *)
            warn "Invalid option."; sleep 1; return ;;
    esac

    # ── Pick time (random from off-peak list) ────────────────────────────────
    local -a _time_list=("01:00" "01:30" "02:00" "02:30" "03:00" "03:15" "03:30" "03:45" "04:00" "04:30")
    local _picked_time="${_time_list[$RANDOM % ${#_time_list[@]}]}"
    local _hour="${_picked_time%%:*}"
    local _min="${_picked_time##*:}"

    # ── Pick retention (auto-delete older archives after each run) ────────────
    echo ""
    echo -e "  ${BOLD}Retention — how long to keep backups?${RESET}"
    echo -e "  ${DIM}After each run, encrypted archives older than this in the backup dir${RESET}"
    echo -e "  ${DIM}are auto-deleted. The recovery seed is your ultimate backup regardless.${RESET}"
    echo ""
    echo -e "  ${BOLD}1${RESET})  7 days"
    echo -e "  ${BOLD}2${RESET})  14 days"
    echo -e "  ${BOLD}3${RESET})  30 days"
    echo -e "  ${BOLD}4${RESET})  Keep all  ${DIM}(never auto-delete)${RESET}"
    echo -e "  ${DIM}C)  Custom (enter a number of days)${RESET}"
    echo ""
    echo -ne "${BOLD}Retention [1/2/3/4/C]: ${RESET}"
    read -r _ret_choice

    local keep_days=14   # sensible default if input is unrecognized
    case "${_ret_choice,,}" in
        1) keep_days=7  ;;
        2) keep_days=14 ;;
        3) keep_days=30 ;;
        4) keep_days=0  ;;
        c)
            echo -ne "${BOLD}Keep how many days: ${RESET}"
            read -r _ret_days
            if [[ "$_ret_days" =~ ^[0-9]+$ ]]; then
                keep_days="$_ret_days"
            else
                warn "Not a number — using 14 days."; keep_days=14
            fi
            ;;
        *) warn "Unrecognized — using 14 days."; keep_days=14 ;;
    esac
    local _ret_label
    [[ "$keep_days" -eq 0 ]] && _ret_label="keep all (no auto-delete)" || _ret_label="keep $keep_days days"

    local this_script; this_script="$(realpath "${BASH_SOURCE[0]}")"
    # --keep-days must precede $CRON_TAG (a shell '#' comment): cron passes the
    # whole field to sh, which ignores everything from '#' on. So the flag is
    # parsed and the tag stays a harmless comment used to find/remove the entry.
    local cron_line="$_min $_hour * * $cron_days bash $this_script --auto-backup --keep-days $keep_days $CRON_TAG"

    # ── Preview + confirm ────────────────────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}Scheduled entry:${RESET}"
    echo -e "  ${GREEN}$cron_line${RESET}"
    echo ""
    echo -e "  Backup runs at ${BOLD}${_picked_time}${RESET} on the selected day(s)."
    echo -e "  Retention: ${BOLD}${_ret_label}${RESET}."
    echo -e "  Archives saved to ${BOLD}$BACKUP_DIR${RESET}."
    echo ""
    if ! confirm_step "Install this schedule?"; then
        info "Cancelled."; return
    fi

    # ── Install cron entry ───────────────────────────────────────────────────
    local _existing; _existing=$(crontab -l 2>/dev/null | grep -v "$CRON_TAG" || true)
    printf '%s\n%s\n' "$_existing" "$cron_line" | crontab -
    success "Schedule installed."
    log "[SCHEDULE] $cron_line"
    pause
}

# =============================================================================
# MAIN MENU
# =============================================================================
main() {
    # Non-interactive mode: called by cron via
    #   bash 089_backup_restore.sh --auto-backup [--keep-days N]
    if [[ "${1:-}" == "--auto-backup" ]]; then
        local _keep_days=0          # 0 = keep all (no pruning) unless told otherwise
        shift
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --keep-days) _keep_days="${2:-0}"; shift 2 ;;
                *)           shift ;;
            esac
        done
        run_backup --auto "$_keep_days"
        exit $?
    fi

    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  9  Backup & Restore — Grin Node Toolkit${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""

        # Show active schedule if set
        local _sched; _sched="$(_active_schedule)"
        if [[ -n "$_sched" ]]; then
            echo -e "  ${GREEN}Auto-backup:${RESET} ${DIM}$_sched${RESET}"
        else
            echo -e "  ${DIM}Auto-backup: not scheduled${RESET}"
        fi
        if gbp_configured; then
            echo -e "  ${GREEN}Offsite push:${RESET} ${DIM}${GBP_USER}@${GBP_HOST}:${GBP_DIR}${RESET}"
        else
            echo -e "  ${DIM}Offsite push: not configured${RESET}"
        fi
        echo ""

        echo -e "  ${BOLD}B${RESET})  Backup now"
        echo -e "     ${DIM}Saves conf, wallets, ALL product DBs (online snapshot), nginx, SSL, crontabs · encrypted${RESET}"
        echo ""
        echo -e "  ${BOLD}S${RESET})  Schedule automatic backup"
        echo -e "     ${DIM}Daily or 2 days per week · random off-peak time${RESET}"
        echo ""
        echo -e "  ${BOLD}R${RESET})  Restore from a backup"
        echo -e "     ${DIM}Restores files from a previous backup archive${RESET}"
        echo ""
        echo -e "  ${BOLD}P${RESET})  Offsite push (scp to a remote server)"
        echo -e "     ${DIM}Auto-copy every finished archive to a remote box over ssh${RESET}"
        echo ""
        echo -e "  ${DIM}0)  Return${RESET}"
        echo ""
        echo -ne "${BOLD}Choice [B/S/R/P/0]: ${RESET}"
        read -r _choice

        # Every dispatch is ||-guarded: these functions return 1 on cancel /
        # invalid input, which under `set -e` would otherwise kill the script
        # instead of returning to the menu (CLAUDE.md menu-loop rule).
        case "${_choice,,}" in
            b) run_backup    || true ;;
            s) run_schedule  || true ;;
            r) run_restore   || true ;;
            p) gbp_setup     || true ;;
            0) break         ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

main "$@"
