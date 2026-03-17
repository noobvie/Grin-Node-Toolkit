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
LOG_DIR="$SCRIPT_DIR/../log"
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

# =============================================================================
# BACKUP
# =============================================================================
run_backup() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  BACKUP — Grin Node Toolkit${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

    # ── Step 1: Destination ──────────────────────────────────────────────────
    section "Step 1: Backup destination"
    echo -e "  Default: ${BOLD}$BACKUP_DIR${RESET}"
    echo -ne "${BOLD}Enter destination path (or Enter for default): ${RESET}"
    read -r _dest_input
    local dest_dir="${_dest_input:-$BACKUP_DIR}"
    mkdir -p "$dest_dir" || { error "Cannot create $dest_dir"; return 1; }
    success "Destination: $dest_dir"

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
    section "Step 3: Wallet data"
    if [[ ${#wallet_dirs[@]} -gt 0 ]]; then
        echo -e "  ${YELLOW}Wallet dirs contain seed files — loss = unrecoverable.${RESET}"
        echo ""
        for _w in "${wallet_dirs[@]}"; do
            echo -e "  ${DIM}$_w${RESET}"
        done
        echo ""
        echo -ne "${BOLD}Include wallet data? [Y/n]: ${RESET}"
        read -r _wallet_choice
        if [[ "${_wallet_choice,,}" != "n" ]]; then
            for _w in "${wallet_dirs[@]}"; do
                sources+=("$_w")
                manifest_lines+=("wallet: $_w")
                info "  ✓ $_w"
            done
        else
            warn "  — Wallet data excluded. Ensure you have your seed phrase backed up separately."
        fi
    else
        warn "  — No wallet dirs found in $wallets_conf (skipping)"
    fi

    # ── Step 4: Optional logs ────────────────────────────────────────────────
    section "Step 4: Optional — include logs"
    local include_logs=false
    if [[ -d /opt/grin/logs ]]; then
        echo -ne "${BOLD}Include /opt/grin/logs/? [y/N]: ${RESET}"
        read -r _log_choice
        if [[ "${_log_choice,,}" == "y" ]]; then
            sources+=("/opt/grin/logs")
            manifest_lines+=("logs: /opt/grin/logs")
            include_logs=true
            info "  ✓ /opt/grin/logs"
        fi
    else
        info "  — /opt/grin/logs not found (skipping)"
    fi

    if [[ ${#sources[@]} -eq 0 ]]; then
        warn "Nothing to back up. Aborting."
        pause; return 0
    fi

    # ── Step 5: Create archive ───────────────────────────────────────────────
    section "Step 5: Creating archive"
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

    # ── Step 6: Done ─────────────────────────────────────────────────────────
    section "Backup complete"
    success "Archive : $dest_dir/$archive_name"
    success "Size    : $size"
    log "[BACKUP] Created: $dest_dir/$archive_name ($size)"
    pause
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
    echo ""
    log "[RESTORE] Completed from: $chosen_archive"
    pause
}

# =============================================================================
# MAIN MENU
# =============================================================================
main() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  9  Backup & Restore — Grin Node Toolkit${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  ${BOLD}B${RESET})  Create a backup"
        echo -e "     ${DIM}Saves conf, nginx, SSL certs, web UIs, crontabs${RESET}"
        echo ""
        echo -e "  ${BOLD}R${RESET})  Restore from a backup"
        echo -e "     ${DIM}Restores files from a previous backup archive${RESET}"
        echo ""
        echo -e "  ${DIM}0)  Return${RESET}"
        echo ""
        echo -ne "${BOLD}Choice [B/R/0]: ${RESET}"
        read -r _choice

        case "${_choice,,}" in
            b) run_backup  ;;
            r) run_restore ;;
            0) break       ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

main
