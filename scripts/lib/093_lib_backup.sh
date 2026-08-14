# 093_lib_backup.sh — Grin Transporter backup / restore / schedule
# Sourced by 093_grin_transporter.sh — inherits colors, logging, TRP_* vars and
# the shared engine (lib/grin_backup_engine.sh, product "transporter").
#
#  Functions exported:
#    trp_backup_now        — staged encrypted archive of BOTH networks
#    trp_restore           — pick an archive, decrypt, restore, restart
#    trp_backup_schedule   — enable/disable the nightly cron
#    trp_backup_menu       — the B) screen
#
# ─── What is in the archive, and why ─────────────────────────────────────────
#   toolkit/     grin_transporter.conf — domains, onions, certbot email
#   <net>/       config.json + a consistent SQLite snapshot of the queue
#   agent-<net>/ agent.json — POINTERS to the wallet secret/passphrase files
#                (0600). The wallet's own seed is NOT here; that belongs to the
#                wallet product's backup, and duplicating it would widen the
#                blast radius of this archive for no gain.
#   tor-<net>/   hs_ed25519_secret_key + hostname, when an onion front exists.
#
# The queue itself holds only ciphertext the server cannot read, so this archive
# is not about protecting slate contents — it is about IDENTITY and CONTINUITY.
# Losing the onion secret key changes the .onion address, and every agent
# configured to reach this Transporter silently stops finding it. That is the
# same reasoning behind the Script 04 onion-identity backup: back up the SECRET
# KEY, not the address, because only the key can reproduce the address.
#
# ONE archive covers BOTH networks (the deployer conf is shared and the schedule
# is per-server), so there is a single "transporter" product in the engine.
#
# Convention: sourced lib → NO shebang / NO `set -e`.

# Directories that make up a full instance set, resolved at call time so an
# instance added after the wrapper was written is still captured.
_trp_instances() {
    local d
    for d in /opt/grin/transporter-main /opt/grin/transporter-test; do
        [[ -d "$d" ]] && echo "$d"
    done
}

# The account tor runs as differs by distro (debian-tor / toranon / tor).
# Getting this wrong makes tor refuse to load a restored hidden service.
_trp_tor_user() {
    local u
    for u in debian-tor toranon tor _tor; do
        id -u "$u" &>/dev/null && { echo "$u"; return 0; }
    done
    # Fall back to whoever owns the state dir.
    if [[ -d /var/lib/tor ]]; then
        stat -c '%U' /var/lib/tor 2>/dev/null && return 0
    fi
    echo ""
}

# =============================================================================
# BACKUP NOW
# =============================================================================
trp_backup_now() {
    gbe_require_key || return 1
    local insts=()
    while IFS= read -r d; do [[ -n "$d" ]] && insts+=("$d"); done < <(_trp_instances)
    if [[ ${#insts[@]} -eq 0 ]]; then
        error "Nothing to back up — no Transporter instance installed."
        return 1
    fi

    local stage tmp
    stage=$(mktemp -d /tmp/grin_transporter_bak_XXXXXX) || return 1
    mkdir -p "$stage/toolkit"
    [[ -f "$TRP_DEPLOY_CONF" ]] && cp -a "$TRP_DEPLOY_CONF" "$stage/toolkit/"

    local dir short net
    for dir in "${insts[@]}"; do
        short="${dir##*-}"                        # main | test
        net="mainnet"; [[ "$short" == "test" ]] && net="testnet"
        mkdir -p "$stage/$short"
        [[ -f "$dir/config.json" ]] && cp -a "$dir/config.json" "$stage/$short/"
        if [[ -f "$dir/transporter.db" ]]; then
            gbe_snapshot_db "$dir/transporter.db" "$stage/$short/transporter.db"
        fi

        local agent_conf="/opt/grin/transporter-agent-${net}/agent.json"
        if [[ -f "$agent_conf" ]]; then
            mkdir -p "$stage/agent-$net"
            cp -a "$agent_conf" "$stage/agent-$net/"
        fi

        local hs="/var/lib/tor/grin-transporter-${net}"
        if [[ -f "$hs/hs_ed25519_secret_key" ]]; then
            mkdir -p "$stage/tor-$net"
            cp -a "$hs/hs_ed25519_secret_key" "$stage/tor-$net/" 2>/dev/null || true
            [[ -f "$hs/hs_ed25519_public_key" ]] && cp -a "$hs/hs_ed25519_public_key" "$stage/tor-$net/" 2>/dev/null || true
            [[ -f "$hs/hostname" ]] && cp -a "$hs/hostname" "$stage/tor-$net/" 2>/dev/null || true
        fi
    done

    tmp=$(mktemp /tmp/grin_transporter_bak_XXXXXX.tar.gz) || { rm -rf "$stage"; return 1; }
    tar -czf "$tmp" -C "$stage" . 2>/dev/null || true
    rm -rf "$stage"
    gbe_finalize_archive "transporter" "$tmp" || return 1
    gbe_prune_count "transporter" "$TRP_BAK_KEEP"
    return 0
}

# =============================================================================
# RESTORE
# =============================================================================
trp_restore() {
    clear
    echo -e "${BOLD}${CYAN}── Grin Transporter — restore from backup ──${RESET}\n"
    local archives=()
    while IFS= read -r f; do [[ -n "$f" ]] && archives+=("$f"); done \
        < <(ls -t "$GBE_BACKUP_DIR"/grin_transporter_backup_*.tar.gz.enc 2>/dev/null || true)
    if [[ ${#archives[@]} -eq 0 ]]; then
        warn "No transporter backups found in $GBE_BACKUP_DIR."; pause; return 0
    fi
    local i
    for i in "${!archives[@]}"; do
        echo -e "  ${GREEN}$((i+1))${RESET}) $(basename "${archives[$i]}")  ${DIM}($(du -sh "${archives[$i]}" 2>/dev/null | cut -f1))${RESET}"
    done
    echo -e "  ${DIM}0) Cancel${RESET}\n"
    echo -ne "${BOLD}Select archive: ${RESET}"
    local sel; read -r sel || true
    [[ "$sel" =~ ^[0-9]+$ && "$sel" -ge 1 && "$sel" -le ${#archives[@]} ]] || { info "Cancelled."; pause; return 0; }
    local archive="${archives[$((sel-1))]}" d
    d=$(gbe_parse_date "$archive") || { error "Unexpected archive name."; pause; return 0; }
    echo ""
    echo -e "  ${DIM}Password = your personal key + ${d} (typed by hand on restore).${RESET}"
    local key; read -rs -p "  Personal key: " key; echo ""
    [[ -n "$key" ]] || { info "Cancelled."; pause; return 0; }

    local tmp_tar stage
    tmp_tar=$(mktemp /tmp/grin_transporter_res_XXXXXX.tar.gz)
    if ! gbe_decrypt "$archive" "$tmp_tar" "${key}${d}"; then
        rm -f "$tmp_tar"; unset key
        error "Decryption failed — wrong key for this archive's date?"; pause; return 0
    fi
    unset key
    stage=$(mktemp -d /tmp/grin_transporter_res_XXXXXX)
    tar -xzf "$tmp_tar" -C "$stage" 2>/dev/null \
        || { rm -rf "$stage" "$tmp_tar"; error "Archive extraction failed."; pause; return 0; }
    rm -f "$tmp_tar"

    info "Stopping Transporter services…"
    systemctl stop grin-transporter-main 2>/dev/null || true
    systemctl stop grin-transporter-test 2>/dev/null || true

    local run_user="grin"; id grin &>/dev/null || run_user="root"
    [[ -f "$stage/toolkit/grin_transporter.conf" ]] && {
        mkdir -p "$(dirname "$TRP_DEPLOY_CONF")"
        cp -a "$stage/toolkit/grin_transporter.conf" "$TRP_DEPLOY_CONF"
    }

    local short net dir restored=0
    for short in main test; do
        [[ -d "$stage/$short" ]] || continue
        net="mainnet"; [[ "$short" == "test" ]] && net="testnet"
        dir="/opt/grin/transporter-${short}"
        mkdir -p "$dir"
        [[ -f "$stage/$short/config.json" ]] && cp -a "$stage/$short/config.json" "$dir/"
        if [[ -f "$stage/$short/transporter.db" ]]; then
            # Drop stale WAL/SHM: they belong to the OLD database file and would
            # be replayed over the restored one.
            rm -f "$dir/transporter.db" "$dir/transporter.db-wal" "$dir/transporter.db-shm"
            cp -a "$stage/$short/transporter.db" "$dir/"
        fi
        chown -R "$run_user:$run_user" "$dir" 2>/dev/null || true
        restored=$((restored + 1))

        if [[ -f "$stage/agent-$net/agent.json" ]]; then
            mkdir -p "/opt/grin/transporter-agent-${net}"
            cp -a "$stage/agent-$net/agent.json" "/opt/grin/transporter-agent-${net}/"
            chmod 600 "/opt/grin/transporter-agent-${net}/agent.json"
            chown "$run_user:$run_user" "/opt/grin/transporter-agent-${net}/agent.json" 2>/dev/null || true
            info "Agent config restored for $net (agent.js itself: re-run menu 7)."
        fi

        if [[ -f "$stage/tor-$net/hs_ed25519_secret_key" ]]; then
            local tor_user hs="/var/lib/tor/grin-transporter-${net}"
            tor_user=$(_trp_tor_user)
            if [[ -n "$tor_user" ]]; then
                mkdir -p "$hs"
                cp -a "$stage/tor-$net"/hs_ed25519_* "$hs/" 2>/dev/null || true
                [[ -f "$stage/tor-$net/hostname" ]] && cp -a "$stage/tor-$net/hostname" "$hs/" 2>/dev/null || true
                chown -R "$tor_user:$tor_user" "$hs" 2>/dev/null || true
                chmod 700 "$hs"; chmod 600 "$hs"/hs_ed25519_* 2>/dev/null || true
                success "Onion identity restored for $net ($(cat "$hs/hostname" 2>/dev/null || echo 'address pending'))."
            else
                warn "tor user not found — onion keys left in the archive, install tor and restore again."
            fi
        fi
    done

    rm -rf "$stage"
    if [[ "$restored" -eq 0 ]]; then
        warn "Archive contained no instance data."
        pause; return 0
    fi

    info "Starting Transporter services…"
    local short2 started=0
    for short2 in main test; do
        [[ -f "/etc/systemd/system/grin-transporter-${short2}.service" ]] || continue
        systemctl start "grin-transporter-${short2}" 2>/dev/null || true
        sleep 1
        if systemctl is-active --quiet "grin-transporter-${short2}" 2>/dev/null; then
            success "grin-transporter-${short2} running."
            started=$((started + 1))
        else
            error "grin-transporter-${short2} did not start — journalctl -u grin-transporter-${short2} -n 30"
        fi
    done
    if [[ "$started" -eq 0 ]]; then
        warn "No service units present — run menu 1 (Install server) to recreate them."
    fi
    echo -e "  ${DIM}nginx/SSL are not part of the archive — re-run menu 3 on a new server.${RESET}"
    echo -e "  ${DIM}If an onion was restored, re-run menu 4 so torrc points at it.${RESET}"
    pause
}

# =============================================================================
# UNATTENDED WRAPPER (cron never sources repo libs)
# =============================================================================
_trp_write_bak_wrapper() {
    mkdir -p /opt/grin/logs
    cat > "$TRP_BAK_WRAPPER" <<WRAP
#!/bin/bash
# grin-transporter-backup — unattended daily backup (generated by 093_grin_transporter.sh)
# Standard engine conventions: grin_transporter_backup_DDMMYYYY.tar.gz.enc,
# password = <personal key from ${GBE_CONF}> + DDMMYYYY.
set -u
BACKUP_DIR="${GBE_BACKUP_DIR}"
CONF="${GBE_CONF}"
LOG="${TRP_BAK_LOG}"
KEEP="${TRP_BAK_KEEP}"
TS=\$(date '+%F %T')
D=\$(date +%d%m%Y)
mkdir -p "\$BACKUP_DIR" "\$(dirname "\$LOG")"
KEY_B64=\$(sed -n "s/^GBE_PERSONAL_KEY_B64='\([^']*\)'.*/\1/p" "\$CONF" 2>/dev/null | head -1)
[[ -n "\$KEY_B64" ]] || { echo "[\$TS] ERROR: no personal key in \$CONF" >> "\$LOG"; exit 1; }
KEY=\$(printf '%s' "\$KEY_B64" | base64 -d 2>/dev/null)
[[ -n "\$KEY" ]] || { echo "[\$TS] ERROR: key decode failed" >> "\$LOG"; exit 1; }

STAGE=\$(mktemp -d /tmp/grin_transporter_cronbak_XXXXXX) || exit 1
mkdir -p "\$STAGE/toolkit"
[[ -f ${TRP_DEPLOY_CONF} ]] && cp -a ${TRP_DEPLOY_CONF} "\$STAGE/toolkit/"

FOUND=0
for SHORT in main test; do
    DIR="/opt/grin/transporter-\$SHORT"
    [[ -d "\$DIR" ]] || continue
    FOUND=1
    NET="mainnet"; [[ "\$SHORT" == "test" ]] && NET="testnet"
    mkdir -p "\$STAGE/\$SHORT"
    [[ -f "\$DIR/config.json" ]] && cp -a "\$DIR/config.json" "\$STAGE/\$SHORT/"
    if [[ -f "\$DIR/transporter.db" ]]; then
        python3 -c 'import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()' \\
            "\$DIR/transporter.db" "\$STAGE/\$SHORT/transporter.db" 2>/dev/null \\
            || cp -p "\$DIR/transporter.db" "\$STAGE/\$SHORT/"
    fi
    AGENT="/opt/grin/transporter-agent-\$NET/agent.json"
    if [[ -f "\$AGENT" ]]; then
        mkdir -p "\$STAGE/agent-\$NET"; cp -a "\$AGENT" "\$STAGE/agent-\$NET/"
    fi
    HS="/var/lib/tor/grin-transporter-\$NET"
    if [[ -f "\$HS/hs_ed25519_secret_key" ]]; then
        mkdir -p "\$STAGE/tor-\$NET"
        cp -a "\$HS"/hs_ed25519_* "\$STAGE/tor-\$NET/" 2>/dev/null
        [[ -f "\$HS/hostname" ]] && cp -a "\$HS/hostname" "\$STAGE/tor-\$NET/" 2>/dev/null
    fi
done
if [[ "\$FOUND" -eq 0 ]]; then
    rm -rf "\$STAGE"; echo "[\$TS] no instance installed — nothing to back up" >> "\$LOG"; exit 0
fi

TMP=\$(mktemp /tmp/grin_transporter_cronbak_XXXXXX.tar.gz) || { rm -rf "\$STAGE"; exit 1; }
tar -czf "\$TMP" -C "\$STAGE" . 2>/dev/null
rm -rf "\$STAGE"
[[ -s "\$TMP" ]] || { rm -f "\$TMP"; echo "[\$TS] ERROR: empty archive (disk full?)" >> "\$LOG"; exit 1; }

ARCHIVE="\$BACKUP_DIR/grin_transporter_backup_\$D.tar.gz.enc"
PASS="\${KEY}\${D}"
if openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass fd:3 \\
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
    "${GBP_BIN:-/usr/local/bin/grin-backup-push}" "\$ARCHIVE" \\
        || echo "[\$TS] WARN: offsite push failed" >> "\$LOG"
fi

N=\$(ls -1 "\$BACKUP_DIR"/grin_transporter_backup_*.tar.gz.enc 2>/dev/null | wc -l)
if [[ "\$N" -gt "\$KEEP" ]]; then
    ls -t "\$BACKUP_DIR"/grin_transporter_backup_*.tar.gz.enc 2>/dev/null \\
        | tail -n +\$((KEEP + 1)) | xargs rm -f 2>/dev/null || true
    echo "[\$TS] pruned (kept newest \$KEEP)" >> "\$LOG"
fi
WRAP
    chmod 750 "$TRP_BAK_WRAPPER"
}

# =============================================================================
# SCHEDULE
# =============================================================================
trp_backup_schedule() {
    if [[ -f "$TRP_BAK_CRON" ]]; then
        echo -e "  Daily backup: ${GREEN}enabled${RESET} ${DIM}($(printf '%02d:%02d' "$TRP_BAK_HOUR" "$TRP_BAK_MIN"), keep $TRP_BAK_KEEP · log: $TRP_BAK_LOG)${RESET}"
        echo -ne "  Disable it? [y/N]: "
        local c; read -r c || true
        if [[ "${c,,}" == "y" ]]; then
            rm -f "$TRP_BAK_CRON" "$TRP_BAK_WRAPPER"
            success "Daily backup disabled."
        fi
        return 0
    fi
    gbe_require_key || { info "Scheduling needs a personal key."; return 1; }
    _trp_write_bak_wrapper
    cat > "$TRP_BAK_CRON" <<EOF
# Grin Transporter daily backup — generated by 093_grin_transporter.sh
# Covers BOTH networks in one archive (product "transporter").
$TRP_BAK_MIN $TRP_BAK_HOUR * * * root $TRP_BAK_WRAPPER
EOF
    chmod 644 "$TRP_BAK_CRON"
    success "Daily backup enabled ($(printf '%02d:%02d' "$TRP_BAK_HOUR" "$TRP_BAK_MIN"), keep $TRP_BAK_KEEP) → $TRP_BAK_CRON"
    return 0
}

# =============================================================================
# MENU
# =============================================================================
trp_backup_menu() {
    local c
    while true; do
        clear
        gbe_load_key
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Grin Transporter — Backup & Restore${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        local key_state="${RED}not set${RESET}"; [[ -n "$GBE_PERSONAL_KEY" ]] && key_state="${GREEN}set${RESET}"
        local sched="${DIM}off${RESET}"; [[ -f "$TRP_BAK_CRON" ]] && sched="${GREEN}daily $(printf '%02d:%02d' "$TRP_BAK_HOUR" "$TRP_BAK_MIN")${RESET}"
        echo -e "  Personal key : $key_state ${DIM}(shared by all products · $GBE_CONF)${RESET}"
        echo -e "  Schedule     : $sched   Retention: keep ${BOLD}$TRP_BAK_KEEP${RESET}"
        echo -e "  ${DIM}Contents: deployer conf + per-network config.json + queue snapshot${RESET}"
        echo -e "  ${DIM}          + agent.json + the .onion SECRET KEY (identity, not the address)${RESET}"
        echo -e "  ${DIM}Covers BOTH networks in one archive.${RESET}"
        echo ""
        local insts=""
        local dd
        while IFS= read -r dd; do [[ -n "$dd" ]] && insts+="$(basename "$dd") "; done < <(_trp_instances)
        echo -e "  Instances    : ${insts:-${DIM}none installed${RESET}}"
        echo ""
        echo -e "  ${BOLD}Backups in $GBE_BACKUP_DIR:${RESET}"
        local any=0 f
        while IFS= read -r f; do
            [[ -n "$f" ]] || continue
            any=1
            echo -e "    $(basename "$f")  ${DIM}($(du -sh "$f" 2>/dev/null | cut -f1))${RESET}"
        done < <(ls -t "$GBE_BACKUP_DIR"/grin_transporter_backup_*.tar.gz.enc 2>/dev/null || true)
        [[ "$any" -eq 0 ]] && echo -e "    ${DIM}(none yet)${RESET}"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Backup now"
        echo -e "  ${GREEN}2${RESET}) Restore from a backup"
        echo -e "  ${GREEN}3${RESET}) Enable / disable daily schedule"
        echo -e "  ${GREEN}4${RESET}) Set / change personal key"
        echo -e "  ${GREEN}5${RESET}) Retention (currently keep $TRP_BAK_KEEP)"
        echo -e "  ${GREEN}6${RESET}) Offsite push setup (scp)"
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-6/0]: ${RESET}"
        read -r c || c=0
        case "$c" in
            "") continue ;;
            1) trp_backup_now || true; pause ;;
            2) trp_restore || true ;;
            3) trp_backup_schedule || true; pause ;;
            4) gbe_set_key || true; pause ;;
            5) echo -ne "  Keep how many archives [current $TRP_BAK_KEEP]: "
               local n; read -r n || true
               if [[ "$n" =~ ^[0-9]+$ && "$n" -ge 1 ]]; then
                   TRP_BAK_KEEP="$n"
                   _trp_conf_set "backup_keep" "$n"
                   # The live cron wrapper bakes retention in — regenerate it.
                   if [[ -f "$TRP_BAK_CRON" ]]; then _trp_write_bak_wrapper; fi
                   success "Retention set to $n."
               else
                   warn "Unchanged (enter a positive number)."
               fi
               pause ;;
            6) gbp_setup || true; pause ;;
            0) return 0 ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}
