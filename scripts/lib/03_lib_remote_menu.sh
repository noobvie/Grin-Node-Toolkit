# 03_lib_remote_menu.sh — remote-copy menus of Script 03 (menus C and D and the --cron-remote run): add, schedule, SSH key setup, copy now.
# Sourced by 03_grin_share_chain_data.sh; shares its globals and log/info/warn/error. The rsync engine is 03_lib_remote.sh.
# Moved as-is; this script sets no errexit and file operations are not individually guarded.

################################################################################
# Remote copy (option C/D) — see docs/reference/script03_design.md section 15
################################################################################

# site_key -> the local nginx web dir the archive was published into. Lives here
# rather than in the lib because it reads the nginx config's variables.
_rc_src_for_site_key() {
    case "$1" in
        fullmain)  printf '%s' "${LOCAL_WEB_DIR_MAINNET_FULL:-}"   ;;
        prunemain) printf '%s' "${LOCAL_WEB_DIR_MAINNET_PRUNED:-}" ;;
        prunetest) printf '%s' "${LOCAL_WEB_DIR_TESTNET_PRUNED:-}" ;;
    esac
}

# Entry point for --cron-remote (and for the legacy --cron-ssh flag).
#   $1 (optional) = a single site_key to copy. Empty = every configured one.
#   Each site_key gets its own cron entry, because their BUILD cadences differ
#   (fullmain biweekly, the pruned pair more often) and the copy offset is
#   derived from the build. Without the argument every entry would carry an
#   identical command line, and installing the second would delete the first.
run_cron_remote() {
    local only_key="${1:-}"
    if [[ ! -f "$CONF_NGINX" ]]; then
        echo "ERROR: Nginx config not found: $CONF_NGINX"
        echo "Run the script interactively and select option A first."
        exit 1
    fi
    load_nginx_config
    [ -f "$CONF_SSH" ] && load_ssh_config
    rc_migrate_legacy || true

    echo "=========================================="
    echo " Grin Share — Remote copy"
    echo "=========================================="

    local sk src rc=0 any=false
    mkdir -p "$LOG_DIR"
    for sk in fullmain prunemain prunetest; do
        [ -n "$only_key" ] && [ "$sk" != "$only_key" ] && continue
        [ -n "$(rc_targets_list "$sk")" ] || continue
        any=true
        src="$(_rc_src_for_site_key "$sk")"
        if [ -z "$src" ]; then
            echo "  $sk: no local web dir in the nginx config — skipping"
            continue
        fi
        LOG_FILE="$LOG_DIR/remote_${sk}_$(date -u '+%Y%m%d_%H%M%S').log"
        touch "$LOG_FILE" 2>/dev/null || true
        rc_run_site_key "$sk" "$src" || rc=1
    done
    [ "$any" = false ] && echo "  No mirrors configured. Use option C to add one."

    # Off-box report. Reads the per-target state files rather than this run's
    # results, so a mirror that failed two runs ago and was skipped this time is
    # still counted as failing. Silent when nothing changed since the last run.
    if [ "$any" = true ]; then
        if [ "$RC_NOTIFY" = true ] && ! galert_available; then
            echo "  (no alert channel configured — set one up in Script 082 to be told when a copy fails)"
        fi
        rc_notify_summary || true
    fi

    echo "=========================================="
    echo " Remote copy finished"
    echo "=========================================="
    return $rc
}

# Derive the copy schedule from the BUILD schedule rather than asking for a
# second clock. The operator thinks "a few hours after the build", not in cron
# fields, and tying the two together means changing the build time does not
# silently leave the copy firing before there is anything new to copy.
#
# The result comes back in RC_SCHED_EXPR and the reason for a refusal in
# RC_SCHED_WARN. Both are globals because reading this through
# $( ) would run the function in a SUBSHELL — so every variable it set was
# discarded, and the operator got a bare "could not derive a schedule" while the
# sentence explaining why was thrown away.
_rc_derive_schedule() {
    local site_key="$1" offset="$2" tag line m h rest nh
    RC_SCHED_EXPR=""; RC_SCHED_WARN=""
    case "$site_key" in
        prunetest) tag="$CRON_COMMENT_NGINX_TEST" ;;
        *)         tag="$CRON_COMMENT_NGINX_MAIN" ;;
    esac
    # The build cron is ONE line with its marker appended at the END:
    #   0 0 1,15 * * bash .../03_...sh --cron-nginx-main >> ...log 2>&1 # ...grin_share_nginx_main
    # (see cron_line= in the installer). So the marker is matched as a substring
    # of that line. Never look for the marker on a line of its own
    # (the next-line layout is one this script never writes): that made the whole
    # function return empty every single time.
    line=$(crontab -l 2>/dev/null | grep -F "$tag" | tail -1)
    # Legacy combined schedule, only when there is no per-network one. Anchored
    # to end-of-line because "...grin_share_nginx" is a PREFIX of both
    # per-network markers, so a plain -F would return the TESTNET line when asked
    # about mainnet and the copy would run on the wrong network's timetable.
    # Same anchor the installer uses when it retires that line.
    [ -z "$line" ] && line=$(crontab -l 2>/dev/null | grep -E 'grin_share_nginx[[:space:]]*$' | tail -1)
    if [ -z "$line" ]; then
        RC_SCHED_WARN="no build schedule found for ${site_key} yet - set one with option E first"
        return 1
    fi
    m=$(awk '{print $1}' <<< "$line"); h=$(awk '{print $2}' <<< "$line")
    rest=$(awk '{print $3" "$4" "$5}' <<< "$line")
    case "$m" in ''|*[!0-9]*) RC_SCHED_WARN="the build cron's minute field ('$m') is not a plain number"; return 1 ;; esac
    case "$h" in ''|*[!0-9]*) RC_SCHED_WARN="the build cron's hour field ('$h') is not a plain number"; return 1 ;; esac
    # A wrap means the copy lands on the day AFTER the build while the
    # day-of-month field still says the build's day - so it would fire a day
    # early, before the archive exists. Refuse rather than emit a wrong schedule.
    if [ $(( h + offset )) -ge 24 ]; then
        RC_SCHED_WARN="an offset of ${offset}h from ${h}:00 crosses midnight, which the day-of-month field ('$rest') cannot follow - use a smaller offset, or move the build earlier"
        return 1
    fi
    nh=$(( (h + offset) % 24 ))
    RC_SCHED_EXPR="$m $nh $rest"
    return 0
}

_rc_prompt() { local __v="$1" __p="$2" __d="$3" __t; echo -ne "  $__p [$__d]: "; read -r __t; printf -v "$__v" '%s' "${__t:-$__d}"; }

menu_remote_add() {
    local sk al host port key rdir bw
    echo ""
    # Say it before the eight prompts, not after the connection test at the end.
    # Adding a mirror whose key is not installed yet is allowed — the config is
    # just text and the copy is not running now — but it ends in a failed test,
    # and a failed test with no explanation is what sends an operator looking for
    # a bug that is not there.
    if ! _rc_key_present "$RC_KEY_DEFAULT"; then
        sched_warn "No SSH key on this server yet — set one up with menu item 1 first."
        echo -e "  ${DIM}You can still add the mirror now, but its connection test will fail${RESET}"
        echo -e "  ${DIM}until the key exists here and is installed on that host.${RESET}"
        echo ""
    fi
    echo -e "  ${BOLD}Which archive does this mirror serve?${RESET}"
    echo -e "    1) fullmain    2) prunemain    3) prunetest"
    echo -ne "  Select [1-3]: "; read -r sk
    case "$sk" in 1) sk=fullmain ;; 2) sk=prunemain ;; 3) sk=prunetest ;; *) sched_warn "Cancelled."; return 0 ;; esac

    _rc_prompt al   "Short name for this mirror" "m$(date +%s | tail -c 4)"
    _rc_prompt host "SSH host (user@ip)"         "root@"
    _rc_prompt port "SSH port"                   "22"
    _rc_prompt key  "SSH key path"               "$RC_KEY_DEFAULT"
    # Defaulted from the site_key, never computed from the node type + network:
    # that arithmetic is what produced 'prunedtest' in the legacy config.
    _rc_prompt rdir "Remote web dir"             "/var/www/$sk"
    _rc_prompt bw   "Bandwidth cap KB/s (0 = uncapped)" "0"

    local line="${sk}|${al}|${host}|${port}|${key}|${rdir}|${bw}|true"
    if rc_target_add "$line"; then
        sched_success "Mirror '$al' added for $sk."
        echo ""
        echo -e "  ${DIM}Testing the connection...${RESET}"
        if ! rc_target_test "$line"; then
            sched_warn "Added, but the mirror is not reachable yet."
            echo -e "  ${DIM}Nothing is broken — the entry is saved. Go to menu item 1 (SSH${RESET}"
            echo -e "  ${DIM}access) and run steps 2 and 3 for ${host}, then re-test with item 3.${RESET}"
        fi
    else
        sched_error "Could not add the mirror."
    fi
    echo ""; echo "Press Enter to continue..."; read -r
}

menu_remote_schedule() {
    local sk offset expr
    echo ""
    echo -e "  ${BOLD}Which archive's copy schedule?${RESET}"
    echo -e "    1) fullmain    2) prunemain    3) prunetest"
    echo -ne "  Select [1-3]: "; read -r sk
    case "$sk" in 1) sk=fullmain ;; 2) sk=prunemain ;; 3) sk=prunetest ;; *) return 0 ;; esac

    _rc_prompt offset "Hours after the build" "3"
    case "$offset" in ''|*[!0-9]*) sched_error "Not a number."; sleep 1; return 0 ;; esac

    # Called directly, NOT through $( ) - see the note on _rc_derive_schedule.
    if ! _rc_derive_schedule "$sk" "$offset"; then
        sched_error "Could not derive a copy schedule."
        [ -n "${RC_SCHED_WARN:-}" ] && echo -e "  ${DIM}${RC_SCHED_WARN}${RESET}"
        echo ""; echo "Press Enter to continue..."; read -r; return 0
    fi
    expr="$RC_SCHED_EXPR"

    local this_script; this_script=$(realpath "${BASH_SOURCE[0]}")
    local tag="$CRON_COMMENT_REMOTE $sk"
    local cmd="bash $this_script --cron-remote $sk >> $LOG_DIR/cron_remote.log 2>&1"
    # Drop any EXISTING entry for this site_key by what it DOES, not by whether
    # it is byte-identical to the one about to be written. Matching the exact
    # line only removed a reschedule that changed nothing: raising the offset
    # from 3h to 5h left the old line in place, because it no longer matched, and
    # the copy then ran twice a night on two schedules for ever. The tag line was
    # removed either way, so the survivor was untagged and invisible in the
    # "installed schedules" list. Same pattern menu_remote_unschedule uses.
    # Read the crontab FULLY into a variable before writing it back, the way
    # every other cron writer in Script 03 does. Piping `crontab -l` straight
    # into `crontab -` has both ends of the same store open at once, and this
    # was the only place doing it — reading and writing the crontab in one
    # pipeline is exactly the shape that turns into a truncated crontab if the
    # writing end ever opens its target before the reading end is done.
    local existing
    existing=$(crontab -l 2>/dev/null | grep -v -x -F "$tag" \
        | grep -v -E -- "--cron-remote[[:space:]]+${sk}([[:space:]]|\$)")
    if ! ( printf '%s\n' "$existing"; echo "$tag"; echo "$expr $cmd" ) \
            | grep -v '^$' | crontab -; then
        sched_error "Could not install the cron entry."; sleep 2; return 0
    fi
    sched_success "Copy scheduled: $expr  (${offset}h after the $sk build)"
    echo -e "  ${DIM}The job is idempotent — it exits doing nothing if the archive has not changed,${RESET}"
    echo -e "  ${DIM}so a build that runs late or fails cannot make it ship a stale set.${RESET}"
    echo ""; echo "Press Enter to continue..."; read -r
}

# ---------------------------------------------------------------------------
# SSH access — the FIRST thing an operator does in this menu
# ---------------------------------------------------------------------------
# Order matters here: a wrong order costs every new operator the same hour.
# With "Add a mirror" first and "SSH key" last, the path the menu invites is:
# add a mirror -> watch its automatic connection test fail -> go looking for
# what was missing. Worse, the key screen built its ssh-copy-id
# lines by reading the CONFIGURED mirrors, so on a fresh box — the only box
# where it is actually needed — it printed a key and no instructions at all.
#
# Access is step 1 and stands on its own: it asks for the host itself
# instead of requiring one to already be in the config, and it names the machine
# each command belongs on. The most common newbie failure here is running a step
# on the wrong box (generating a second key on the mirror, or pasting the
# PRIVATE half into authorized_keys), so every line says THIS SERVER or THE
# MIRROR rather than leaving it to be inferred.
#
# The password rule is load-bearing: this script NEVER reads the
# mirror's password. ssh-copy-id is run on the operator's terminal and does its
# own prompting, so the secret goes from the keyboard to ssh and never through a
# shell variable, the session log or `ps`.
RC_KEY_DEFAULT="/root/.ssh/grin_share_ed25519"

# Both halves, because either one alone is useless: the private half without the
# .pub cannot be installed anywhere, and the .pub without the private half
# cannot log in. ssh-keygen writes them together, but a half-copied /root/.ssh
# from an old box arrives with only one of them.
_rc_key_present() { [ -f "$1" ] && [ -f "${1}.pub" ]; }

# Step 1 — on THIS SERVER. Idempotent by refusal, not by overwrite: an existing
# key is never regenerated, because a new one would silently orphan every mirror
# that already trusts the old public half, and that failure would only surface at
# the next unattended copy.
_rc_key_create() {
    local kp="$1" a
    echo ""
    echo -e "  ${BOLD}Step 1 · on THIS SERVER — create the key${RESET}"
    echo ""
    if _rc_key_present "$kp"; then
        sched_info "The key already exists — nothing to do."
        echo -e "  ${DIM}private half: ${kp}${RESET}"
        echo -e "  ${DIM}public half:  ${kp}.pub   (this is the one that goes on a mirror)${RESET}"
        echo ""
        echo -e "  ${DIM}It is deliberately NOT regenerated. A new key would leave every mirror${RESET}"
        echo -e "  ${DIM}that already trusts this one locked out, and you would only find out${RESET}"
        echo -e "  ${DIM}at the next scheduled copy.${RESET}"
        return 0
    fi
    if [ -f "$kp" ] || [ -f "${kp}.pub" ]; then
        sched_warn "Only half of the key pair is present at $kp"
        echo -e "  ${DIM}Move both files aside and run this step again — ssh-keygen will not${RESET}"
        echo -e "  ${DIM}write over an existing file, and half a pair can never log in.${RESET}"
        return 1
    fi
    echo -e "  This creates ${BOLD}${kp}${RESET} on this machine."
    echo -e "  ${DIM}No passphrase: cron has no keyboard to type one into. That is why the${RESET}"
    echo -e "  ${DIM}mirror-side hardening on menu item 5 matters.${RESET}"
    echo ""
    echo -ne "  Create it now? [Y/n]: "; read -r a
    if [[ "${a,,}" == "n" ]]; then
        sched_info "Skipped."
        return 1
    fi
    mkdir -p "$(dirname "$kp")" && chmod 700 "$(dirname "$kp")" \
        || { sched_error "Could not create $(dirname "$kp")."; return 1; }
    if ssh-keygen -t ed25519 -N "" -f "$kp" -C "grin-share@$(hostname)" >/dev/null 2>&1; then
        sched_success "Created $kp and ${kp}.pub"
        return 0
    fi
    sched_error "ssh-keygen failed."
    return 1
}

# Ask which mirror a step applies to. Offers the configured ones as a numbered
# list AND accepts a typed host, because the whole point of moving this above
# "Add a mirror" is that it has to work when nothing is configured yet.
# Answers in RC_KH_HOST / RC_KH_PORT. Returns 1 if cancelled.
RC_KH_HOST=""; RC_KH_PORT=""

_rc_ask_mirror_host() {
    local line n sel
    local -a lines=()
    RC_KH_HOST=""; RC_KH_PORT=""
    while IFS= read -r line; do lines+=("$line"); done < <(rc_targets_list)
    echo ""
    if [ ${#lines[@]} -gt 0 ]; then
        echo -e "  ${BOLD}Which mirror?${RESET}"
        for n in "${!lines[@]}"; do
            printf "    %d) %-12s %s   port %s\n" "$((n+1))" \
                "$(rc_target_field "${lines[$n]}" 2)" \
                "$(rc_target_field "${lines[$n]}" 3)" \
                "$(rc_target_field "${lines[$n]}" 4)"
        done
        printf "    %d) %s\n" "$(( ${#lines[@]} + 1 ))" "a host that is not in the list yet"
        echo -ne "  Select [1-$(( ${#lines[@]} + 1 )), 0 = cancel]: "; read -r sel
        case "$sel" in
            ''|*[!0-9]*|0) return 1 ;;
        esac
        if [ "$sel" -ge 1 ] && [ "$sel" -le ${#lines[@]} ]; then
            RC_KH_HOST="$(rc_target_field "${lines[$((sel-1))]}" 3)"
            RC_KH_PORT="$(rc_target_field "${lines[$((sel-1))]}" 4)"
            return 0
        fi
        [ "$sel" -eq $(( ${#lines[@]} + 1 )) ] || return 1
    fi
    _rc_prompt RC_KH_HOST "Mirror SSH host (user@ip)" "root@"
    _rc_prompt RC_KH_PORT "Mirror SSH port"           "22"
    # "root@" is the prompt's own default and is not a host. Catching it here is
    # the difference between a clear refusal and ssh spending 15s resolving "".
    case "$RC_KH_HOST" in
        ''|*@) sched_error "No host given."; return 1 ;;
    esac
    case "$RC_KH_PORT" in
        ''|*[!0-9]*) sched_error "Port must be a number."; return 1 ;;
    esac
    return 0
}

# Step 2 — run on THIS SERVER, but it is the one step that changes THE MIRROR.
# Two routes, because ssh-copy-id only works where the mirror still accepts
# password logins; a hardened VPS image with PasswordAuthentication off needs the
# manual paste, and an operator who is not told that reads the failure as "the
# key is broken" and regenerates it, which breaks the mirrors that did work.
_rc_key_install() {
    local kp="$1" host port a
    echo ""
    echo -e "  ${BOLD}Step 2 · install the public half on a mirror${RESET}"
    if ! _rc_key_present "$kp"; then
        sched_error "No key yet — do step 1 first."
        return 1
    fi
    _rc_ask_mirror_host || return 1
    host="$RC_KH_HOST"; port="$RC_KH_PORT"
    echo ""
    echo -e "  ${BOLD}How should it get onto ${host}?${RESET}"
    echo -e "    ${GREEN}1${RESET}) Automatically, from here ${DIM}(asks for the mirror's password once)${RESET}"
    echo -e "    ${GREEN}2${RESET}) Manually — show me what to run ${BOLD}on the mirror${RESET}"
    echo -ne "  Select [1-2, 0 = cancel]: "; read -r a
    case "$a" in
        1) ;;
        2) _rc_key_show_manual "$kp" "$host" "$port"; return 0 ;;
        *) return 1 ;;
    esac

    if ! command -v ssh-copy-id >/dev/null 2>&1; then
        sched_warn "ssh-copy-id is not installed on this server."
        echo -e "  ${DIM}apt install openssh-client   /   dnf install openssh-clients${RESET}"
        _rc_key_show_manual "$kp" "$host" "$port"
        return 1
    fi
    echo ""
    echo -e "  ${DIM}ssh-copy-id asks for ${host}'s password itself — this script never sees${RESET}"
    echo -e "  ${DIM}it, stores it or logs it. If it refuses immediately, that mirror has${RESET}"
    echo -e "  ${DIM}password logins disabled: use the manual route instead.${RESET}"
    echo ""
    echo -e "  ${DIM}\$ ssh-copy-id -i ${kp}.pub -p ${port} ${host}${RESET}"
    echo ""
    # No BatchMode here, deliberately: this is the one call in the whole remote
    # path that has to be able to prompt.
    if ssh-copy-id -o ConnectTimeout=15 -i "${kp}.pub" -p "$port" "$host"; then
        sched_success "Public key installed on $host."
        # The single most-asked question after this step, answered before it gets
        # asked. A plain `ssh <host>` offers only the DEFAULT identity names —
        # ~/.ssh/id_rsa, id_ecdsa, id_ed25519 — and this key is deliberately not
        # one of them, so ssh never offers it and drops straight to a password
        # prompt. That looks exactly like "ssh-copy-id did not work", and the
        # usual reaction is to regenerate the key, which breaks the mirrors that
        # WERE working. The key is fine; the test command was missing -i.
        echo ""
        echo -e "  ${BOLD}Testing it by hand? You must pass -i, or it will still ask for a password:${RESET}"
        echo -e "    ${DIM}ssh -i ${kp} -p ${port} ${host}${RESET}"
        echo ""
        echo -e "  ${DIM}Plain 'ssh ${host}' only tries the default key names (id_rsa, id_ed25519).${RESET}"
        echo -e "  ${DIM}This key is not one of those, so ssh never offers it and falls back to${RESET}"
        echo -e "  ${DIM}the password — that is not a failed install. The copy always passes -i.${RESET}"
        echo ""
        echo -e "  ${DIM}Now run step 3 — installed and working are different claims.${RESET}"
        return 0
    fi
    sched_error "ssh-copy-id did not complete."
    echo -e "  ${DIM}Usual causes: wrong password, wrong port, the mirror refuses password${RESET}"
    echo -e "  ${DIM}logins, or a firewall in between. The manual route below covers all of${RESET}"
    echo -e "  ${DIM}those except the firewall.${RESET}"
    _rc_key_show_manual "$kp" "$host" "$port"
    return 1
}

# The manual route. Printed as a block to run ON THE MIRROR, with the public key
# inline so there is nothing to look up — and with the private half named as the
# thing that must never leave this server, because pasting the wrong file into
# authorized_keys is the classic first mistake and it gives the key away.
_rc_key_show_manual() {
    local kp="$1" host="${2:-<mirror>}" port="${3:-22}" pub
    pub="$(cat "${kp}.pub" 2>/dev/null)"
    if [ -z "$pub" ]; then
        sched_error "Cannot read ${kp}.pub — run step 1 first."
        return 1
    fi
    echo ""
    echo -e "  ${BOLD}Run this ${YELLOW}ON THE MIRROR${RESET}${BOLD} (${host}), as the user the copy will log in as:${RESET}"
    echo ""
    echo -e "${DIM}    mkdir -p ~/.ssh && chmod 700 ~/.ssh${RESET}"
    # echo, not printf '%s\n': this line is itself printed through `echo -e`, so a
    # backslash escape inside it has to survive TWO expansions to reach the
    # operator's screen intact. It did not — the escape was consumed here and the
    # command printed with a real line break through the middle of it, which
    # pastes as two broken commands. echo supplies the newline on the mirror side
    # and leaves nothing here to escape.
    echo -e "${DIM}    echo '${pub}' >> ~/.ssh/authorized_keys${RESET}"
    echo -e "${DIM}    chmod 600 ~/.ssh/authorized_keys${RESET}"
    echo ""
    echo -e "  ${YELLOW}That is the PUBLIC half (${kp}.pub) — safe to paste anywhere.${RESET}"
    echo -e "  ${YELLOW}${kp} (no .pub) is the private half: it never leaves this server.${RESET}"
    echo ""
    echo -e "  ${DIM}Then come back to step 3 and verify — do not assume it worked.${RESET}"
    return 0
}

# Step 3 — on THIS SERVER. The only thing that proves the setup: a key that
# exists and a key that logs in are different claims.
#
# The probe itself lives in lib/03_lib_remote.sh (rc_ssh_login_probe), NOT here,
# because "Test every configured mirror" has to run the identical command. When
# each had its own copy they drifted — this one pinned unknown host keys and the
# other could not, so the same mirror passed here and failed there with a
# misleading message. Read the comment on rc_ssh_login_probe for why -i and
# BatchMode=yes are both load-bearing.
_rc_key_verify() {
    local kp="$1" host port
    echo ""
    echo -e "  ${BOLD}Step 3 · on THIS SERVER — verify the login works${RESET}"
    if ! _rc_key_present "$kp"; then
        sched_error "No key yet — do step 1 first."
        return 1
    fi
    _rc_ask_mirror_host || return 1
    host="$RC_KH_HOST"; port="$RC_KH_PORT"
    echo ""
    echo -e "  ${DIM}\$ ssh -i ${kp} -p ${port} ${host}${RESET}"
    echo -e "  ${DIM}Key only, no password fallback — so a pass here is a pass for cron too.${RESET}"
    if rc_ssh_login_probe "$kp" "$port" "$host"; then
        echo ""
        sched_success "Key login works."
        echo -e "  ${DIM}remote user: $(printf '%s\n' "$RC_SSH_PROBE_OUT" | sed -n 2p)${RESET}"
        echo -e "  ${DIM}remote host: $(printf '%s\n' "$RC_SSH_PROBE_OUT" | sed -n 3p)${RESET}"
        echo ""
        echo -e "  ${DIM}That is everything the copy needs from SSH. Next: add the mirror${RESET}"
        echo -e "  ${DIM}(item 2 on the previous screen) if it is not in the list yet.${RESET}"
        echo ""
        echo -e "  ${DIM}Keep the -i when you test by hand later: plain 'ssh ${host}' tries only${RESET}"
        echo -e "  ${DIM}the default key names and will still ask for a password.${RESET}"
        return 0
    fi
    echo ""
    sched_error "Key login failed."
    echo ""
    printf '%s\n' "$RC_SSH_PROBE_OUT" | sed 's/^/    /'
    echo ""
    rc_ssh_explain_failure "$host" "$port" "$kp"
    return 1
}

_rc_key_hardening_notes() {
    echo ""
    echo -e "  ${BOLD}${YELLOW}Worth doing on each mirror${RESET}"
    echo ""
    echo -e "  ${DIM}This key has no passphrase, because cron cannot type one. So whoever${RESET}"
    echo -e "  ${DIM}holds it holds whatever account it opens — and if you pointed the${RESET}"
    echo -e "  ${DIM}mirror at root@, that is root on every mirror you have. Two changes${RESET}"
    echo -e "  ${DIM}on the mirror side cost nothing and cap the blast radius:${RESET}"
    echo ""
    echo -e "    ${DIM}1. give the mirror a dedicated user that owns only its web dir:${RESET}"
    echo -e "       ${DIM}useradd -m -s /bin/bash grinmirror${RESET}"
    echo -e "       ${DIM}chown -R grinmirror: /var/www/<site_key>${RESET}"
    echo -e "       ${DIM}...then set this mirror's host to grinmirror@<ip>${RESET}"
    echo ""
    echo -e "    ${DIM}2. restrict the key in that user's ~/.ssh/authorized_keys, so a${RESET}"
    echo -e "       ${DIM}stolen copy cannot open a shell or forward a port:${RESET}"
    echo -e "       ${DIM}restrict,no-agent-forwarding,no-port-forwarding ssh-ed25519 AAAA...${RESET}"
    echo ""
    echo -e "  ${DIM}The copy needs mkdir, rsync, sed and mv inside that one directory and${RESET}"
    echo -e "  ${DIM}nothing else, so it keeps working under both.${RESET}"
    echo ""
    echo "Press Enter to continue..."; read -r
}

menu_remote_keys() {
    local kp="$RC_KEY_DEFAULT" choice s1
    while true; do
        clear
        if _rc_key_present "$kp"; then s1="${GREEN}created${RESET}"; else s1="${YELLOW}not created yet${RESET}"; fi
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  SSH access — one-time setup, once per mirror${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "  ${DIM}Two machines are involved:${RESET}"
        echo -e "    ${BOLD}THIS SERVER${RESET}  the producer — builds the archive and sends the copy"
        echo -e "    ${BOLD}THE MIRROR${RESET}   the target   — receives it and serves the download"
        echo ""
        echo -e "  ${DIM}You type every command below on ${RESET}${BOLD}THIS SERVER${RESET}${DIM}. Step 2 is the only one${RESET}"
        echo -e "  ${DIM}that changes the mirror, and it can also just print what to paste there.${RESET}"
        echo ""
        echo -e "  Key on this server: ${DIM}${kp}${RESET}   [${s1}]"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Step 1 — create the key here"
        echo -e "  ${GREEN}2${RESET}) Step 2 — install the public half on a mirror"
        echo -e "  ${GREEN}3${RESET}) Step 3 — verify the login works ${DIM}(key only, no password)${RESET}"
        echo ""
        echo -e "  ${CYAN}4${RESET}) Show the public key ${DIM}(to paste on a mirror by hand)${RESET}"
        echo -e "  ${CYAN}5${RESET}) Recommended hardening on the mirror side"
        echo ""
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-5 / 0]: ${RESET}"
        read -r choice
        case "$choice" in
            1) _rc_key_create "$kp" || true
               echo ""; echo "Press Enter to continue..."; read -r ;;
            2) _rc_key_install "$kp" || true
               echo ""; echo "Press Enter to continue..."; read -r ;;
            3) _rc_key_verify "$kp" || true
               echo ""; echo "Press Enter to continue..."; read -r ;;
            4) _rc_key_show_manual "$kp" || true
               echo ""; echo "Press Enter to continue..."; read -r ;;
            5) _rc_key_hardening_notes || true ;;
            0) break ;;
            "") ;;
            *) sched_warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# Pick an existing mirror from a numbered list. Every other prompt in this menu
# is a numbered choice; remove and enable/disable were the two that asked the
# operator to TYPE a site_key and an alias from memory. That is the worst place
# for free text: "site_key" is internal jargon that appears in no other prompt,
# and a typed typo in the remove path would report success.
# Answers in RC_PICK_SK / RC_PICK_AL / RC_PICK_EN. Returns 1 if cancelled.
RC_PICK_SK=""; RC_PICK_AL=""; RC_PICK_EN=""

_rc_pick_target() {
    local prompt="$1" line n=0 sel
    local -a lines=()
    RC_PICK_SK=""; RC_PICK_AL=""; RC_PICK_EN=""
    while IFS= read -r line; do lines+=("$line"); done < <(rc_targets_list)
    if [ ${#lines[@]} -eq 0 ]; then
        sched_warn "No mirrors are configured yet."; sleep 1; return 1
    fi
    echo ""
    echo -e "  ${BOLD}${prompt}${RESET}"
    for n in "${!lines[@]}"; do
        printf "    %d) %-10s %-12s %s%s\n" "$((n+1))" \
            "$(rc_target_field "${lines[$n]}" 1)" \
            "$(rc_target_field "${lines[$n]}" 2)" \
            "$(rc_target_field "${lines[$n]}" 3)" \
            "$([ "$(rc_target_field "${lines[$n]}" 8)" = "true" ] || printf '  (disabled)')"
    done
    echo -ne "  Select [1-${#lines[@]}, 0 = cancel]: "; read -r sel
    case "$sel" in
        ''|*[!0-9]*) return 1 ;;
        0) return 1 ;;
    esac
    [ "$sel" -ge 1 ] && [ "$sel" -le ${#lines[@]} ] || return 1
    line="${lines[$((sel-1))]}"
    RC_PICK_SK="$(rc_target_field "$line" 1)"
    RC_PICK_AL="$(rc_target_field "$line" 2)"
    RC_PICK_EN="$(rc_target_field "$line" 8)"
    return 0
}

# The rows are listed in the order the work is actually done. SSH access is
# first because nothing below it can succeed without it, and "Add a mirror" ends
# with an automatic connection test — a new operator who started there would
# watch a test fail for a reason the menu had not mentioned yet. Keys are positional in this script (03 is not hub 05 or 08), so
# reordering rows is allowed; what is not optional is the `|| true` on every
# dispatch — this loop runs under `set -e`.
menu_remote_setup() {
    load_nginx_config
    [ -f "$CONF_SSH" ] && load_ssh_config
    rc_migrate_legacy || true
    local choice line
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Remote Copy — mirrors for the published archive${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "  ${DIM}Copies the finished .tar.gz to other servers. The Grin node keeps${RESET}"
        echo -e "  ${DIM}running throughout — this never touches chain_data.${RESET}"
        echo ""
        rc_status_table
        echo ""
        echo -e "  ${BOLD}Set up a mirror${RESET} ${DIM}— in this order${RESET}"
        echo -e "  ${GREEN}1${RESET}) SSH access ${DIM}— create a key, install it on the mirror, verify${RESET}"
        echo -e "  ${GREEN}2${RESET}) Add a mirror ${DIM}— do 1 for that host first${RESET}"
        echo -e "  ${GREEN}3${RESET}) Test every configured mirror ${DIM}(connection + identity)${RESET}"
        echo ""
        echo -e "  ${BOLD}Manage${RESET}"
        echo -e "  ${CYAN}4${RESET}) Enable / disable a mirror"
        echo -e "  ${CYAN}5${RESET}) Remove a mirror"
        echo -e "  ${CYAN}6${RESET}) Schedule the copy ${DIM}(N hours after the build)${RESET}"
        echo -e "  ${CYAN}7${RESET}) Remove a copy schedule"
        echo ""
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-7 / 0]: ${RESET}"
        read -r choice
        case "$choice" in
            1) menu_remote_keys || true ;;
            2) menu_remote_add || true ;;
            3) echo ""
               if [ -z "$(rc_targets_list)" ]; then
                   sched_warn "No mirrors are configured yet — add one with item 2."
               else
                   while IFS= read -r line; do rc_target_test "$line" || true; done < <(rc_targets_list)
               fi
               echo ""; echo "Press Enter to continue..."; read -r ;;
            4) if _rc_pick_target "Enable / disable which mirror?"; then
                   if [ "$RC_PICK_EN" = "true" ]; then
                       rc_target_set_enabled "$RC_PICK_SK" "$RC_PICK_AL" false \
                           && sched_success "Disabled $RC_PICK_AL." || sched_error "Failed."
                   else
                       rc_target_set_enabled "$RC_PICK_SK" "$RC_PICK_AL" true \
                           && sched_success "Enabled $RC_PICK_AL."  || sched_error "Failed."
                   fi
                   sleep 1
               fi ;;
            5) if _rc_pick_target "Remove which mirror?"; then
                   rc_target_remove "$RC_PICK_SK" "$RC_PICK_AL" \
                       && sched_success "Removed $RC_PICK_AL." || sched_error "Not removed."
                   sleep 1
               fi ;;
            6) menu_remote_schedule || true ;;
            7) menu_remote_unschedule || true ;;
            0) break ;;
            "") ;;
            *) sched_warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# Remove a copy schedule. Nothing else does: remove_nginx_schedule greps for
# "grin_share_nginx", which deliberately does not match "grin_share_remote", so
# without this an operator who deletes every mirror still has a cron entry
# firing for them for ever.
menu_remote_unschedule() {
    local sk cur out tag
    cur=$(crontab -l 2>/dev/null | grep -F "$CRON_COMMENT_REMOTE" | sed 's/^/    /')
    echo ""
    if [ -z "$cur" ]; then
        sched_info "No copy schedules are installed."
        echo ""; echo "Press Enter to continue..."; read -r; return 0
    fi
    echo -e "  ${BOLD}Installed copy schedules:${RESET}"
    echo -e "${DIM}${cur}${RESET}"
    echo ""
    echo -e "  ${BOLD}Remove which?${RESET}"
    echo -e "    1) fullmain    2) prunemain    3) prunetest    4) all"
    echo -ne "  Select [1-4, 0 = cancel]: "; read -r sk
    case "$sk" in 1) sk=fullmain ;; 2) sk=prunemain ;; 3) sk=prunetest ;; 4) sk=all ;; *) return 0 ;; esac

    # Two lines go per schedule: the tag, and the command it introduces. The
    # command is matched on its own "--cron-remote <site_key>" rather than on
    # being adjacent to the tag, so a hand-edited crontab still cleans up.
    if [ "$sk" = all ]; then
        out=$(crontab -l 2>/dev/null               | grep -v -F "$CRON_COMMENT_REMOTE"               | grep -v -E -- "--cron-(remote|ssh)([[:space:]]|$)" || true)
    else
        tag="$CRON_COMMENT_REMOTE $sk"
        out=$(crontab -l 2>/dev/null               | grep -v -x -F "$tag"               | grep -v -E -- "--cron-remote[[:space:]]+${sk}([[:space:]]|$)" || true)
    fi
    if printf '%s
' "$out" | grep -v '^$' | crontab -; then
        sched_success "Copy schedule removed ($sk)."
        sched_log "Removed remote copy cron: $sk"
    else
        sched_error "Could not update the crontab."
    fi
    echo ""; echo "Press Enter to continue..."; read -r
}

menu_remote_copy_now() {
    if [[ ! -f "$CONF_NGINX" ]]; then
        show_error_pause "Nginx config not found." "Run option A first — the copy ships what the nginx build produced."
        return
    fi
    echo -e "\n${CYAN}[INFO]${RESET}  Copying the published archive to every enabled mirror."
    # Says what the code does. No local or remote sha256 pass runs by default (each
    # would read a 17-20 GB file an extra time, the IO this design avoids), and a
    # screen that claims a gate nobody is running is worse than no screen.
    echo -e "  ${DIM}rsync verifies every file it transfers, so a corrupt copy fails the run.${RESET}"
    echo -e "  ${DIM}The .sha256 ships alongside the archive for downloaders to check.${RESET}"
    echo -e "  ${DIM}Mirrors already holding this build are skipped.${RESET}"
    echo ""
    # rc_should_push confirms against the mirror itself rather than trusting
    # our own state file, so a wiped mirror is picked up automatically and this
    # is rarely needed - but "copy now" has to be able to mean it.
    echo -ne "  Force re-upload to mirrors that already hold this build? [y/N]: "
    read -r _rc_force
    if [[ "${_rc_force,,}" == "y" ]]; then RC_FORCE=true; else RC_FORCE=false; fi
    echo ""

    # No off-box alert from the menu: the operator is reading the result on the
    # screen, and a notification about something they just watched fail trains
    # them to ignore the channel. Cron runs still alert.
    ( RC_NOTIFY=false; run_cron_remote )
    local rc=$?
    RC_FORCE=false
    [ $rc -ne 0 ] && sched_error "One or more mirrors failed. See $LOG_DIR/remote_*.log"
    echo ""; echo "Press Enter to continue..."; read -r
}
