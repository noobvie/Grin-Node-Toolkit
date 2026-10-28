# =============================================================================
# 081_lib_bulk_add.sh — add many servers at once, using each root password ONCE
# =============================================================================
# Sourced by 081_host_monitor_port.sh (Mass Deployment → Manage Servers, key 6).
# No shebang, no `set -e`: dispatched as `_mdb_bulk_add || true`, so every
# fallible step carries its own guard.
#
# The password is used for one thing only: ssh-copy-id of /root/.ssh/grin_deploy.
# Only servers whose KEY login then works are written to mass_deploy.conf, and
# that file never holds a password. Passwords live in shell variables for the
# run (cleared at the end), reach sshpass through the SSHPASS environment
# variable (`sshpass -e`, never `-p`, which `ps` would show), and pasted lines
# are read without echo so they do not land in the terminal scrollback.
#
# Borrowed from 081 at call time: $MASS_DEPLOY_CONF, $CONF_DIR, $MD_SSH_OPTS,
# _md_ssh, info/warn/error/success/log and the colour variables.
# =============================================================================

[[ -n "${_GRIN_081_BULK_ADD_LOADED:-}" ]] && return 0
_GRIN_081_BULK_ADD_LOADED=1

MDB_KEY="/root/.ssh/grin_deploy"
MDB_TOOLKIT_PATH_DEFAULT="/opt/grin-node-toolkit"

# _mdb_ensure_sshpass — install sshpass if missing (EPEL on Rocky/Alma).
_mdb_ensure_sshpass() {
    command -v sshpass >/dev/null 2>&1 && return 0
    info "sshpass is needed for the one-time password login. Installing..."
    if command -v apt-get >/dev/null 2>&1; then
        apt-get install -y sshpass >/dev/null 2>&1 || { apt-get update -qq >/dev/null 2>&1 && apt-get install -y sshpass >/dev/null 2>&1; }
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y sshpass >/dev/null 2>&1 || { dnf install -y epel-release >/dev/null 2>&1 && dnf install -y sshpass >/dev/null 2>&1; }
    fi
    command -v sshpass >/dev/null 2>&1 && { success "sshpass installed."; return 0; }
    error "Could not install sshpass. Install it by hand, then run this again."
    return 1
}

# _mdb_ensure_key — create the ed25519 deploy key if it does not exist yet.
_mdb_ensure_key() {
    [[ -f "$MDB_KEY" && -f "$MDB_KEY.pub" ]] && return 0
    info "Generating deploy key $MDB_KEY ..."
    mkdir -p /root/.ssh && chmod 700 /root/.ssh || { error "Cannot prepare /root/.ssh."; return 1; }
    ssh-keygen -q -t ed25519 -f "$MDB_KEY" -N "" -C "grin-node-toolkit" \
        || { error "ssh-keygen failed."; return 1; }
    return 0
}

# _mdb_known <label> <host> — true when the label or host is already configured.
_mdb_known() {
    [[ -f "$MASS_DEPLOY_CONF" ]] || return 1
    awk -F'|' -v l="$1" -v h="$2" '!/^#/ && ($1==l || $2==h) {f=1} END {exit !f}' "$MASS_DEPLOY_CONF"
}

_mdb_bulk_add() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Bulk Add Servers (one-time password)${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo "  One server per line:   label|ip|port|user|password"
    echo "  port/user may be empty (22 / root). Leave the password empty on every"
    echo "  line to type ONE shared password afterwards."
    echo -e "  ${DIM}e.g.  vps-de1|203.0.113.10|22|root|S3cret${RESET}"
    echo ""
    echo -e "  The password is used once to install the deploy key, then forgotten."
    echo ""
    local src=""
    echo -ne "  ${BOLD}Path to a server list file (Enter = paste the lines instead): ${RESET}"
    read -r src || src=""
    if [[ -n "$src" && ! -f "$src" ]]; then
        error "No such file: $src"; echo "Press Enter to continue..."; read -r || true; return 0
    fi
    [[ -z "$src" ]] && echo -e "  Input is ${BOLD}hidden${RESET}. Paste the lines, then press Enter on an empty line."

    local -a L=() H=() P=() U=() W=()
    local line lbl host port user pw n=0 bad=0 need_shared=0
    # fd 3 is the file, or the terminal for a hidden paste.
    if [[ -n "$src" ]]; then exec 3< "$src" || { error "Cannot read $src"; return 0; }
    else exec 3<&0; fi
    while IFS= read -rs -u 3 line || [[ -n "$line" ]]; do
        line="${line%$'\r'}"
        if [[ -z "${line// /}" ]]; then [[ -z "$src" ]] && break; continue; fi
        [[ "$line" == \#* ]] && continue
        IFS='|' read -r lbl host port user pw <<< "$line"
        lbl="${lbl// /}"; host="${host// /}"; port="${port// /}"; user="${user// /}"
        if [[ ! "$lbl" =~ ^[A-Za-z0-9._-]+$ || ! "$host" =~ ^[A-Za-z0-9.:-]+$ ]]; then
            bad=$((bad+1)); continue
        fi
        [[ -z "$port" ]] && port=22
        [[ -z "$user" ]] && user=root
        if [[ ! "$port" =~ ^[0-9]+$ || ! "$user" =~ ^[a-z_][a-z0-9_-]*$ ]]; then bad=$((bad+1)); continue; fi
        [[ -z "$pw" ]] && need_shared=1
        L+=("$lbl"); H+=("$host"); P+=("$port"); U+=("$user"); W+=("$pw")
        n=$((n+1))
    done
    exec 3<&-
    echo ""
    if (( bad > 0 )); then info "Read $n server line(s), $bad malformed line(s) ignored."
    else info "Read $n server line(s)."; fi
    if (( n == 0 )); then echo "Press Enter to continue..."; read -r || true; return 0; fi

    local shared=""
    if (( need_shared )); then
        echo -ne "  ${BOLD}Shared root password (hidden): ${RESET}"
        read -rs shared || shared=""
        echo ""
        [[ -z "$shared" ]] && { warn "No password given - cancelled."; W=(); return 0; }
    fi

    _mdb_ensure_sshpass || { W=(); shared=""; echo "Press Enter to continue..."; read -r || true; return 0; }
    _mdb_ensure_key     || { W=(); shared=""; echo "Press Enter to continue..."; read -r || true; return 0; }

    local tpath
    echo -ne "  Toolkit path on the servers [$MDB_TOOLKIT_PATH_DEFAULT]: "
    read -r tpath || tpath=""
    [[ -z "$tpath" ]] && tpath="$MDB_TOOLKIT_PATH_DEFAULT"

    if [[ ! -f "$MASS_DEPLOY_CONF" ]]; then
        mkdir -p "$CONF_DIR" && {
            echo "# mass_deploy.conf — Grin Node Toolkit fleet configuration"
            echo "# Format: label|host|ssh_port|ssh_user|ssh_key|toolkit_path"
            echo "# Generated: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
            echo ""
        } > "$MASS_DEPLOY_CONF" || { error "Cannot create $MASS_DEPLOY_CONF."; W=(); shared=""; return 1; }
    fi

    echo ""
    local i ok=0 skip=0 fail=0 out
    for (( i=0; i<n; i++ )); do
        printf "  ${BOLD}[%-16s]${RESET}  %s@%s:%s  ... " "${L[$i]}" "${U[$i]}" "${H[$i]}" "${P[$i]}"
        if _mdb_known "${L[$i]}" "${H[$i]}"; then
            echo -e "${YELLOW}already in the list - skipped${RESET}"; skip=$((skip+1)); continue
        fi
        pw="${W[$i]:-$shared}"
        # Already reachable by key (e.g. key pasted in the provider panel): no password needed.
        out=$(_md_ssh "${L[$i]}" "${H[$i]}" "${P[$i]}" "${U[$i]}" "$MDB_KEY" "echo __CONN_OK__" 2>&1) || true
        if ! grep -q "__CONN_OK__" <<< "$out"; then
            out=$(SSHPASS="$pw" sshpass -e ssh-copy-id -i "$MDB_KEY.pub" -p "${P[$i]}" \
                    -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 \
                    "${U[$i]}@${H[$i]}" 2>&1) || true
            out=$(_md_ssh "${L[$i]}" "${H[$i]}" "${P[$i]}" "${U[$i]}" "$MDB_KEY" "echo __CONN_OK__" 2>&1) || true
        fi
        if grep -q "__CONN_OK__" <<< "$out"; then
            if echo "${L[$i]}|${H[$i]}|${P[$i]}|${U[$i]}|$MDB_KEY|$tpath" >> "$MASS_DEPLOY_CONF"; then
                echo -e "${GREEN}key OK - added${RESET}"; ok=$((ok+1))
                log "[BULK ADD] ${L[$i]} ${U[$i]}@${H[$i]}:${P[$i]} key installed, added"
            else
                echo -e "${RED}key OK but could not write $MASS_DEPLOY_CONF${RESET}"; fail=$((fail+1))
            fi
        else
            echo -e "${RED}FAILED${RESET}  ${DIM}wrong password, root login disabled, or unreachable - not added${RESET}"
            fail=$((fail+1))
            log "[BULK ADD] ${L[$i]} ${U[$i]}@${H[$i]}:${P[$i]} key install failed"
        fi
    done
    W=(); pw=""; shared=""

    echo ""
    echo -e "  Summary: ${GREEN}${ok} added${RESET}  ${YELLOW}${skip} skipped${RESET}  ${RED}${fail} failed${RESET}"
    echo -e "  ${DIM}Passwords were not saved anywhere. Added servers log in with $MDB_KEY.${RESET}"
    if [[ -n "$src" && -f "$src" ]]; then
        # shred overwrites the data before unlinking; a plain rm leaves it readable on disk.
        echo -ne "  ${BOLD}Securely delete the password file $src now? [Y/n]: ${RESET}"
        local ans; read -r ans || ans=""
        if [[ ! "$ans" =~ ^[Nn] ]]; then
            if shred -u -z "$src" 2>/dev/null || rm -f "$src"; then success "Deleted $src."
            else error "Could not delete $src - remove it by hand."; fi
        else
            warn "$src still holds root passwords - delete it with: shred -u $src"
        fi
    fi
    echo ""
    echo "Press Enter to continue..."; read -r || true
    return 0
}
