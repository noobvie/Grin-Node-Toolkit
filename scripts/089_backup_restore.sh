#!/bin/bash
# =============================================================================
# 089_backup_restore.sh - Grin Node Toolkit Backup & Restore
# =============================================================================
# Backs up and restores all Grin-related configuration, nginx, SSL certs,
# web files, and cron schedules — but NOT chain data (re-syncable).
#
# Backup archive: /opt/grin/backups/grin_backup_YYYYMMDD_HHMMSS.tar.gz
#
# What is backed up:
#   · /opt/grin/conf/          — node configs, instances registry, API secrets
#   · /opt/grin/wallet/        — wallet dirs (toml, seed, wallet_data) — optional, default Y
#   · /opt/grin/grin-stats/stats.db    — blockchain stats DB (~100 MB, expensive to rebuild)
#   · /opt/grin/grin-stats/config.env  — stats collector config
#   · /opt/grin/grin-price/grin-price.db — price history DB (optional, default Y)
#   · /etc/nginx/sites-available/*  (Grin-related configs only)
#   · /etc/letsencrypt/live/ + renewal/  — SSL certs
#   · /var/www/*grin*/, fullmain/, prunemain/, prunetest/  (web UIs, not archive files)
#   · root + www-data crontabs  — collector schedules
#   · /opt/grin/logs/          — optional, default N
#
# What is NOT backed up (large / reproducible):
#   · /opt/grin/node/*/chain_data/
#   · /opt/grin/bin/grin  (binary — re-download via script 01)
#   · /var/www/fullmain|prunemain|prunetest  static chain archives
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Paths ────────────────────────────────────────────────────────────────────
LOG_DIR="/opt/grin/logs"
LOG_FILE="$LOG_DIR/grin_backup_restore_$(date +%Y%m%d_%H%M%S).log"
CONF_DIR="/opt/grin/conf"
BACKUP_DIR="/opt/grin/backups"
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

# Populates global array WEB_DIRS with Grin web/data directories.
# Same three-source logic as 08del step 2.
_collect_web_dirs() {
    WEB_DIRS=()
    local seen=""

    # Source A — root dirs referenced in Grin nginx configs
    for conf in "${NGINX_GRIN_CONFIGS[@]+"${NGINX_GRIN_CONFIGS[@]}"}"; do
        local root_dir
        root_dir=$(grep -oP '(?<=root\s)[^;]+' "$conf" 2>/dev/null | head -1 | xargs 2>/dev/null || true)
        [[ -z "$root_dir" || ! -d "$root_dir" ]] && continue
        [[ "$seen" == *"|$root_dir|"* ]] && continue
        seen+="|$root_dir|"
        WEB_DIRS+=("$root_dir")
    done

    # Source B — /var/www/*grin* (depth 1, case-insensitive)
    while IFS= read -r _d; do
        [[ "$seen" == *"|$_d|"* ]] && continue
        seen+="|$_d|"
        WEB_DIRS+=("$_d")
    done < <(find /var/www -mindepth 1 -maxdepth 1 -type d -iname '*grin*' 2>/dev/null || true)

    # Fixed node-type dirs (fullmain/prunemain/prunetest)
    for _d in /var/www/fullmain /var/www/prunemain /var/www/prunetest; do
        [[ -d "$_d" ]] || continue
        [[ "$seen" == *"|$_d|"* ]] && continue
        seen+="|$_d|"
        WEB_DIRS+=("$_d")
    done
}

# Cron tag used to identify the backup schedule entry
CRON_TAG="# grin-toolkit-auto-backup"

# =============================================================================
# BACKUP
# =============================================================================
# Pass --auto as first arg for non-interactive mode (used by cron scheduler).
# In auto mode: uses default dest, includes wallet, skips logs, no prompts.
run_backup() {
    local auto=false
    [[ "${1:-}" == "--auto" ]] && auto=true

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

    # ── Step 2: Collect sources ──────────────────────────────────────────────
    section "Step 2: Collecting Grin sources"
    _collect_nginx_grin_configs
    _collect_web_dirs

    local -a sources=()
    local -a manifest_lines=()

    # /opt/grin/conf
    if [[ -d "$CONF_DIR" ]]; then
        sources+=("$CONF_DIR")
        manifest_lines+=("conf: $CONF_DIR")
        info "  ✓ $CONF_DIR"
    else
        warn "  — $CONF_DIR not found (skipping)"
    fi

    # nginx configs
    if [[ ${#NGINX_GRIN_CONFIGS[@]} -gt 0 ]]; then
        for _c in "${NGINX_GRIN_CONFIGS[@]}"; do
            sources+=("$_c")
            manifest_lines+=("nginx-config: $_c")
            info "  ✓ $_c"
        done
    else
        warn "  — No Grin nginx configs found (skipping)"
    fi

    # Let's Encrypt
    for _le in /etc/letsencrypt/live /etc/letsencrypt/renewal; do
        if [[ -d "$_le" ]]; then
            sources+=("$_le")
            manifest_lines+=("letsencrypt: $_le")
            info "  ✓ $_le"
        fi
    done

    # Web dirs (excluding static chain archive dirs)
    for _w in "${WEB_DIRS[@]+"${WEB_DIRS[@]}"}"; do
        sources+=("$_w")
        manifest_lines+=("web: $_w")
        info "  ✓ $_w"
    done

    # Crontabs
    if crontab -l &>/dev/null; then
        manifest_lines+=("crontab: root")
        info "  ✓ root crontab"
    fi
    if [[ -f /var/spool/cron/crontabs/www-data ]]; then
        manifest_lines+=("crontab: www-data")
        info "  ✓ www-data crontab"
    fi

    # ── Step 4: Databases ────────────────────────────────────────────────────
    # stats.db took hours of crawling to build — always include it by default.
    # WAL checkpoint flushes any in-flight writes before we copy the file.
    if [[ "$auto" == false ]]; then
        section "Step 4: Database files"
        echo -e "  ${YELLOW}stats.db contains ~100 MB of crawled blockchain data — expensive to rebuild.${RESET}"
        echo ""
    fi

    local -A _db_labels=(
        ["/opt/grin/grin-stats/stats.db"]="Stats DB (blockchain history)"
        ["/opt/grin/grin-stats/config.env"]="Stats collector config"
        ["/opt/grin/grin-price/grin-price.db"]="Price DB (GRIN/USDT + GRIN/BTC history)"
    )
    for _db in \
        "/opt/grin/grin-stats/stats.db" \
        "/opt/grin/grin-stats/config.env" \
        "/opt/grin/grin-price/grin-price.db"
    do
        [[ -f "$_db" ]] || continue
        local _db_size; _db_size=$(du -sh "$_db" 2>/dev/null | cut -f1)
        local _label="${_db_labels[$_db]}"
        local _include_db=true
        if [[ "$auto" == false ]]; then
            echo -e "  ${DIM}$_db${RESET}  ${DIM}($_db_size — $_label)${RESET}"
            # config.env is tiny and always useful — include silently
            if [[ "$_db" == *.db ]]; then
                echo -ne "  ${BOLD}Include? [Y/n]: ${RESET}"
                read -r _db_choice
                [[ "${_db_choice,,}" == "n" ]] && _include_db=false
            fi
        fi
        if [[ "$_include_db" == true ]]; then
            # Flush any open WAL transactions to the main file before copying.
            # 10s timeout guards against a locked DB hanging the whole backup.
            if [[ "$_db" == *.db ]] && command -v sqlite3 &>/dev/null; then
                timeout 10 sqlite3 "$_db" "PRAGMA wal_checkpoint(FULL);" &>/dev/null || true
            fi
            sources+=("$_db")
            manifest_lines+=("database: $_db  ($_db_size)")
            info "  ✓ $_db  ($_db_size)"
        fi
    done

    # Wallet dirs (from grin_wallets_location.conf)
    local wallets_conf="$CONF_DIR/grin_wallets_location.conf"
    local -a wallet_dirs=()
    if [[ -f "$wallets_conf" ]]; then
        local _wdir
        while IFS= read -r _wdir; do
            [[ -d "$_wdir" ]] && wallet_dirs+=("$_wdir")
        done < <(grep -oP '(?<=_WALLET_DIR=")[^"]+' "$wallets_conf" 2>/dev/null | sort -u || true)
    fi

    # ── Step 3: Wallets ──────────────────────────────────────────────────────
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
                info "  ✓ $_w"
            done
        else
            warn "  — Wallet data excluded. Ensure you have your seed phrase backed up separately."
        fi
    else
        [[ "$auto" == false ]] && warn "  — No wallet dirs found in $wallets_conf (skipping)"
    fi

    # ── Step 5: Optional logs ────────────────────────────────────────────────
    if [[ "$auto" == false ]]; then
        section "Step 5: Optional — include logs"
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

    if [[ ${#sources[@]} -eq 0 ]]; then
        warn "Nothing to back up. Aborting."
        pause; return 0
    fi

    # ── Step 6: Create archive ───────────────────────────────────────────────
    [[ "$auto" == false ]] && section "Step 6: Creating archive"
    [[ "$auto" == true  ]] && log "[AUTO-BACKUP] Starting automated backup to $dest_dir"
    local ts; ts=$(date +%Y%m%d_%H%M%S)
    local archive_name="grin_backup_${ts}.tar.gz"
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
        echo "  /var/www/fullmain|prunemain|prunetest  static archives (re-gen via script 03)"
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

    info "Building archive..."
    local archive_tmp="$tmp_dir/$archive_name"

    # Build tar: stage extra files at / then add real filesystem paths
    # Extra files go into a staging subdir that mirrors root so tar can include them
    local stage="$tmp_dir/stage"
    mkdir -p "$stage"
    cp "$manifest_file" "$stage/MANIFEST.txt"
    mkdir -p "$stage/crontabs"
    [[ -f "$cron_dir/root.crontab"    ]] && cp "$cron_dir/root.crontab"    "$stage/crontabs/"
    [[ -f "$cron_dir/www-data.crontab" ]] && cp "$cron_dir/www-data.crontab" "$stage/crontabs/"
    [[ -f "$nginx_enabled_manifest" ]] && cp "$nginx_enabled_manifest" "$stage/nginx_enabled_symlinks.txt"

    tar -czf "$archive_tmp" \
        -C "$stage" MANIFEST.txt crontabs \
        $( [[ -f "$stage/nginx_enabled_symlinks.txt" ]] && echo "nginx_enabled_symlinks.txt" || true ) \
        "${sources[@]}" \
        2>/dev/null || true

    # Move to final destination atomically
    mv "$archive_tmp" "$dest_dir/$archive_name"
    trap - EXIT
    rm -rf "$tmp_dir"

    local size; size=$(du -sh "$dest_dir/$archive_name" 2>/dev/null | cut -f1)

    # Set permissions: archive is sensitive (contains secrets + wallet seed)
    chmod 600 "$dest_dir/$archive_name" 2>/dev/null || true
    if id grin &>/dev/null; then
        chown -R grin:grin "$dest_dir" 2>/dev/null || true
    fi

    # ── Step 7: Done ─────────────────────────────────────────────────────────
    if [[ "$auto" == false ]]; then
        section "Backup complete"
        success "Archive : $dest_dir/$archive_name"
        success "Size    : $size"
        log "[BACKUP] Created: $dest_dir/$archive_name ($size)"
        pause
    else
        log "[AUTO-BACKUP] Completed: $dest_dir/$archive_name ($size)"
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
    warn "Restore will OVERWRITE existing files. Make sure Grin is stopped first."
    echo ""

    # ── Step 1: Choose archive ───────────────────────────────────────────────
    section "Step 1: Select backup archive"

    local -a archives=()
    if [[ -d "$BACKUP_DIR" ]]; then
        while IFS= read -r _f; do
            archives+=("$_f")
        done < <(find "$BACKUP_DIR" -maxdepth 1 -name 'grin_backup_*.tar.gz' -type f \
                 | sort -r 2>/dev/null || true)
    fi

    local chosen_archive=""

    if [[ ${#archives[@]} -gt 0 ]]; then
        echo -e "  Available archives in ${BOLD}$BACKUP_DIR${RESET}:"
        echo ""
        local i=1
        for _a in "${archives[@]}"; do
            local sz; sz=$(du -sh "$_a" 2>/dev/null | cut -f1)
            echo -e "  ${BOLD}$i)${RESET} $(basename "$_a")  ${DIM}($sz)${RESET}"
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

    # ── Step 2: Show manifest ────────────────────────────────────────────────
    section "Step 2: Archive contents"
    echo ""
    tar -xOzf "$chosen_archive" MANIFEST.txt 2>/dev/null \
        || warn "No MANIFEST.txt found in archive."
    echo ""

    # ── Step 3: Confirm ──────────────────────────────────────────────────────
    if ! confirm_step "Restore $(basename "$chosen_archive") — this will overwrite existing files. Proceed?"; then
        info "Cancelled."
        return 0
    fi

    # ── Step 4: Extract ──────────────────────────────────────────────────────
    section "Step 4: Restoring files"

    local tmp_dir; tmp_dir=$(mktemp -d)
    trap 'rm -rf "$tmp_dir"' EXIT

    info "Extracting archive..."
    tar -xzf "$chosen_archive" -C "$tmp_dir" 2>/dev/null || true

    local nginx_restored=false

    # conf/
    if [[ -d "$tmp_dir/opt/grin/conf" ]]; then
        mkdir -p "$CONF_DIR"
        cp -a "$tmp_dir/opt/grin/conf/." "$CONF_DIR/"
        success "Restored: $CONF_DIR"
        log "[RESTORE] conf → $CONF_DIR"
    fi

    # nginx configs
    if [[ -d "$tmp_dir/etc/nginx/sites-available" ]]; then
        cp -a "$tmp_dir/etc/nginx/sites-available/." /etc/nginx/sites-available/ 2>/dev/null || true
        success "Restored: nginx sites-available"
        nginx_restored=true
        log "[RESTORE] nginx sites-available"
    fi

    # Re-enable nginx symlinks from manifest
    if [[ -f "$tmp_dir/nginx_enabled_symlinks.txt" ]]; then
        while IFS= read -r _bname; do
            local _src="/etc/nginx/sites-available/$_bname"
            local _dst="/etc/nginx/sites-enabled/$_bname"
            if [[ -f "$_src" && ! -e "$_dst" ]]; then
                ln -s "$_src" "$_dst"
                success "Re-enabled nginx: $_bname"
            fi
        done < "$tmp_dir/nginx_enabled_symlinks.txt"
    fi

    # Let's Encrypt
    for _le in live renewal; do
        if [[ -d "$tmp_dir/etc/letsencrypt/$_le" ]]; then
            mkdir -p "/etc/letsencrypt/$_le"
            cp -a "$tmp_dir/etc/letsencrypt/$_le/." "/etc/letsencrypt/$_le/" 2>/dev/null || true
            success "Restored: /etc/letsencrypt/$_le"
            log "[RESTORE] letsencrypt/$_le"
        fi
    done

    # Web dirs
    if [[ -d "$tmp_dir/var/www" ]]; then
        cp -a "$tmp_dir/var/www/." /var/www/ 2>/dev/null || true
        success "Restored: /var/www (Grin web dirs)"
        log "[RESTORE] /var/www"
    fi

    # Wallet dirs
    if [[ -d "$tmp_dir/opt/grin/wallet" ]]; then
        mkdir -p /opt/grin/wallet
        cp -a "$tmp_dir/opt/grin/wallet/." /opt/grin/wallet/ 2>/dev/null || true
        # Restore strict permissions: wallet dirs must not be world-readable
        find /opt/grin/wallet -maxdepth 1 -mindepth 1 -type d | while IFS= read -r _wd; do
            chmod 700 "$_wd" 2>/dev/null || true
            [[ -d "$_wd/wallet_data" ]] && chmod 700 "$_wd/wallet_data" 2>/dev/null || true
            for _s in "$_wd/wallet_data/.api_secret" "$_wd/wallet_data/.owner_api_secret"; do
                [[ -f "$_s" ]] && chmod 600 "$_s" 2>/dev/null || true
            done
        done
        if id grin &>/dev/null; then
            chown -R grin:grin /opt/grin/wallet 2>/dev/null || true
        fi
        success "Restored: /opt/grin/wallet"
        log "[RESTORE] wallet"
    fi

    # Database files (stats.db, config.env, grin-price.db)
    for _db_rel in \
        "opt/grin/grin-stats/stats.db" \
        "opt/grin/grin-stats/config.env" \
        "opt/grin/grin-price/grin-price.db"
    do
        if [[ -f "$tmp_dir/$_db_rel" ]]; then
            local _db_dest="/$_db_rel"
            mkdir -p "$(dirname "$_db_dest")"
            cp -a "$tmp_dir/$_db_rel" "$_db_dest"
            success "Restored: $_db_dest"
            log "[RESTORE] $_db_dest"
        fi
    done

    # Logs
    if [[ -d "$tmp_dir/opt/grin/logs" ]]; then
        mkdir -p /opt/grin/logs
        cp -a "$tmp_dir/opt/grin/logs/." /opt/grin/logs/ 2>/dev/null || true
        success "Restored: /opt/grin/logs"
        log "[RESTORE] logs"
    fi

    # Crontabs
    if [[ -f "$tmp_dir/crontabs/root.crontab" ]]; then
        crontab "$tmp_dir/crontabs/root.crontab"
        success "Restored: root crontab"
        log "[RESTORE] root crontab"
    fi
    if [[ -f "$tmp_dir/crontabs/www-data.crontab" ]]; then
        mkdir -p /var/spool/cron/crontabs
        cp "$tmp_dir/crontabs/www-data.crontab" /var/spool/cron/crontabs/www-data
        chown www-data:crontab /var/spool/cron/crontabs/www-data 2>/dev/null || true
        chmod 600 /var/spool/cron/crontabs/www-data 2>/dev/null || true
        success "Restored: www-data crontab"
        log "[RESTORE] www-data crontab"
    fi

    trap - EXIT
    rm -rf "$tmp_dir"

    # ── Step 5: Reload nginx if needed ───────────────────────────────────────
    if [[ "$nginx_restored" == true ]]; then
        section "Step 5: Reloading nginx"
        if nginx -t 2>/dev/null; then
            systemctl reload nginx && success "nginx reloaded." || warn "nginx reload failed — check manually."
        else
            warn "nginx config test failed — fix before reloading:"
            nginx -t
        fi
    fi

    # ── Step 6: Summary ──────────────────────────────────────────────────────
    section "Restore complete"
    success "Files restored from: $(basename "$chosen_archive")"
    echo ""
    echo -e "  ${YELLOW}Next steps:${RESET}"
    echo -e "  · If the Grin binary is missing, re-install it via ${BOLD}Script 01${RESET}"
    echo -e "  · Start the Grin node via ${BOLD}Script 01 → S) Start${RESET}"
    echo -e "  · Chain data will re-sync automatically, or use ${BOLD}Script 03${RESET} to stream it"
    echo -e "  · If stats.db was restored, resume the stats cron — no re-crawl needed"
    echo -e "  · If grin-price.db was restored, resume the price cron — history is intact"
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

    local this_script; this_script="$(realpath "${BASH_SOURCE[0]}")"
    local cron_line="$_min $_hour * * $cron_days bash $this_script --auto-backup $CRON_TAG"

    # ── Preview + confirm ────────────────────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}Scheduled entry:${RESET}"
    echo -e "  ${GREEN}$cron_line${RESET}"
    echo ""
    echo -e "  Backup runs at ${BOLD}${_picked_time}${RESET} on the selected day(s)."
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
    # Non-interactive mode: called by cron via  bash 089_backup_restore.sh --auto-backup
    if [[ "${1:-}" == "--auto-backup" ]]; then
        run_backup --auto
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
        echo ""

        echo -e "  ${BOLD}B${RESET})  Backup now"
        echo -e "     ${DIM}Saves conf, wallet, nginx, SSL certs, web UIs, crontabs${RESET}"
        echo ""
        echo -e "  ${BOLD}S${RESET})  Schedule automatic backup"
        echo -e "     ${DIM}Daily or 2 days per week · random off-peak time${RESET}"
        echo ""
        echo -e "  ${BOLD}R${RESET})  Restore from a backup"
        echo -e "     ${DIM}Restores files from a previous backup archive${RESET}"
        echo ""
        echo -e "  ${DIM}0)  Return${RESET}"
        echo ""
        echo -ne "${BOLD}Choice [B/S/R/0]: ${RESET}"
        read -r _choice

        case "${_choice,,}" in
            b) run_backup    ;;
            s) run_schedule  ;;
            r) run_restore   ;;
            0) break         ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

main "$@"
