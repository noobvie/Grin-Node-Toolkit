# =============================================================================
# 081_lib_binary_push.sh — push a locally stored grin binary to remote servers
# =============================================================================
# Sourced by 081_host_monitor_port.sh (Mass Deployment → Remote Node Control,
# keys f and g). No shebang, no `set -e`: the menu dispatches `_mdp_push || true`,
# which disables errexit for the whole call tree, so every cp/mv/scp/ssh below
# carries its own guard.
#
#   f) _mdp_push      pick a binary from /opt/grin/bin, pre-flight, transfer
#                     (node still running), then in ONE ssh session: stop all
#                     nodes, verify none remains, swap. Nodes are left stopped.
#   g) _mdp_rollback  same single session: stop, verify, restore <dir>/grin.prev
#
# Source is ONLY the local store /opt/grin/bin (Script 01 source-build artifacts
# grin-*, *.info excluded). Remote boxes have no toolkit libs, so each remote
# step is a self-contained script sent through `ssh … bash -s`; it prints
# machine-readable `MDP|key|value` lines and a final __OK__ that must be seen.
#
# Stop, verify and swap share one session on purpose: a keepalive/watchdog cron
# firing between separate sessions would restart a node under the new binary.
# Every remote script starts with `trap '' HUP PIPE` (added by _mdp_rexec) so a
# dropped connection cannot kill it halfway through a swap.
#
# Nodes are left stopped: the operator decides when they come back, via the
# reboot offer (the @reboot cron lines tagged `grin-node-toolkit:
# grin_autostart_<net>`) or menu key a.
#
# Borrowed from 081 at call time: _md_select_servers (+ _md_labels/_md_hosts/
# _md_ports/_md_users/_md_keys), _md_ssh, $MD_SSH_OPTS, _MD_NODE_STOP_SNIPPET,
# info/warn/error/success/log and the colour variables.
# =============================================================================

[[ -n "${_GRIN_081_BINARY_PUSH_LOADED:-}" ]] && return 0
_GRIN_081_BINARY_PUSH_LOADED=1

MDP_BIN_DIR="${MDP_BIN_DIR:-/opt/grin/bin}"
MDP_PAUSE_DEFAULT=120

# Per-run state.
_MDP_ART=""; _MDP_NAME=""; _MDP_SHA=""; _MDP_VER=""; _MDP_PAUSE=0; _MDP_DRY=0
_MDP_LAST=""; _MDP_TOUCHED=0; _P_ERR=""
declare -a _MDP_O=()               # ssh/scp options for the current host
declare -a _MDP_S_LABEL=() _MDP_S_OLD=() _MDP_S_NEW=() _MDP_S_RES=() _MDP_S_AUTO=() _MDP_S_STOP=()
declare -a _MDP_REBOOT=()          # "idx|autostart|tag" for hosts whose nodes we stopped cleanly

# ─── Remote scripts (quoted heredocs: nothing here is expanded locally) ───────

# Read-only probe: arch, free KB under /opt/grin, node dirs + version, dirs
# holding grin.prev, and which autostart cron lines are active.
_mdp_rs_probe() { cat <<'MDP_REMOTE'
echo "MDP|arch|$(uname -m)"
p=/opt/grin; [[ -d $p ]] || p=/
echo "MDP|free_kb|$(df -Pk "$p" 2>/dev/null | awk 'NR==2{print $4}')"
for d in /opt/grin/node/mainnet-prune /opt/grin/node/mainnet-full /opt/grin/node/testnet-prune; do
    [[ -x "$d/grin" ]] || continue
    echo "MDP|dir|$d|$(timeout 10 "$d/grin" --version 2>/dev/null | head -1)"
    [[ -f "$d/grin.prev" ]] && echo "MDP|prev|$d"
done
cron=$(crontab -l 2>/dev/null | grep -v '^[[:space:]]*#')
for n in mainnet testnet; do
    printf '%s\n' "$cron" | grep -qF "grin-node-toolkit: grin_autostart_$n" && echo "MDP|auto|$n"
done
echo __OK__
MDP_REMOTE
}

# Prepare the store and drop any stale partial upload.
_mdp_rs_prep() { cat <<'MDP_REMOTE'
mkdir -p /opt/grin/bin || { echo "MDP|err|cannot create /opt/grin/bin"; exit 0; }
rm -f "/opt/grin/bin/$ART_NAME.part"
echo __OK__
MDP_REMOTE
}

# Verify the uploaded .part, publish it, and prove it runs on THIS host.
_mdp_rs_finish() { cat <<'MDP_REMOTE'
D=/opt/grin/bin; P="$D/$ART_NAME.part"
got=$(sha256sum "$P" 2>/dev/null | cut -d' ' -f1)
if [[ "$got" != "$WANT" ]]; then rm -f "$P"; echo "MDP|err|sha256 mismatch after upload (${got:-none})"; exit 0; fi
mv -f "$P" "$D/$ART_NAME" || { rm -f "$P"; echo "MDP|err|could not move upload into place"; exit 0; }
chmod 755 "$D/$ART_NAME" || { echo "MDP|err|chmod failed"; exit 0; }
v=$(timeout 15 "$D/$ART_NAME" --version 2>/dev/null | head -1)
if [[ -z "$v" ]]; then echo "MDP|err|binary prints no version here (glibc/arch mismatch?)"; exit 0; fi
echo "MDP|ver|$v"
echo __OK__
MDP_REMOTE
}

# Follows the stop snippet in the SAME session. Gate: a surviving
# `grin server run` ends the script with MDP|err, so nothing after it runs.
_mdp_rs_verify() { cat <<'MDP_REMOTE'
sleep 2
left=""
for p in $(pgrep -x grin 2>/dev/null); do
    if tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q 'server run'; then left="$left $p"; fi
done
if [[ -n "$left" ]]; then echo "MDP|err|grin server run still alive:$left - nothing changed"; exit 0; fi
echo "MDP|stopped|1"
restore_prev() {
    cp -a "$1/grin.prev" "$1/grin.rb" && mv -f "$1/grin.rb" "$1/grin" || { rm -f "$1/grin.rb"; return 1; }
}
MDP_REMOTE
}

# Swap every node dir. A dir already on this exact binary is skipped so its
# grin.prev (the real rollback copy) is never overwritten by a re-push.
_mdp_rs_swap() { cat <<'MDP_REMOTE'
ART="/opt/grin/bin/$ART_NAME"
handled=0
for dir in /opt/grin/node/mainnet-prune /opt/grin/node/mainnet-full /opt/grin/node/testnet-prune; do
    [[ -x "$dir/grin" ]] || continue
    old=$(timeout 10 "$dir/grin" --version 2>/dev/null | head -1)
    if cmp -s "$dir/grin" "$ART"; then
        echo "MDP|skip|$dir|already current|$old"; handled=$((handled+1)); continue
    fi
    if ! { cp -a "$dir/grin" "$dir/grin.prev.tmp" && mv -f "$dir/grin.prev.tmp" "$dir/grin.prev"; }; then
        rm -f "$dir/grin.prev.tmp"; echo "MDP|dir_fail|$dir|could not back up grin to grin.prev (dir untouched)"; continue
    fi
    if ! { install -m 755 "$ART" "$dir/grin.new" && mv -f "$dir/grin.new" "$dir/grin"; }; then
        rm -f "$dir/grin.new"
        if restore_prev "$dir"; then echo "MDP|dir_fail|$dir|install failed (previous binary put back)"
        else echo "MDP|dir_fail|$dir|install failed AND restore failed"; echo "MDP|suspect|$dir"; fi
        continue
    fi
    if id grin >/dev/null 2>&1; then chown grin:grin "$dir/grin" "$dir/grin.prev" 2>/dev/null; fi
    new=$(timeout 10 "$dir/grin" --version 2>/dev/null | head -1)
    if [[ -z "$new" ]]; then
        if restore_prev "$dir"; then echo "MDP|dir_fail|$dir|new binary silent after install (previous put back)"
        else echo "MDP|dir_fail|$dir|new binary silent AND restore failed"; echo "MDP|suspect|$dir"; fi
        continue
    fi
    {
        echo "# Installed by Grin Node Toolkit — pushed from $CTRL (081)"
        echo "installed_utc = $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
        echo "artifact      = $ART"
        echo "version_str   = $new"
        echo "replaced      = $old"
        echo "rollback      = cp -a $dir/grin.prev $dir/grin   # then restart the node"
        if [[ -f "$ART.info" ]]; then sed 's/^/# /' "$ART.info"; fi
    } > "$dir/.grin_binary_info" || echo "MDP|warn|could not write $dir/.grin_binary_info"
    echo "MDP|swap|$dir|$old|$new"
    handled=$((handled+1))
done
if [[ $handled -gt 0 ]]; then echo __OK__; else echo "MDP|err|no node dir was swapped"; fi
MDP_REMOTE
}

# Restore grin.prev over grin where one exists; keep it if the result is silent.
_mdp_rs_rollback() { cat <<'MDP_REMOTE'
restored=0
for dir in /opt/grin/node/mainnet-prune /opt/grin/node/mainnet-full /opt/grin/node/testnet-prune; do
    [[ -f "$dir/grin.prev" ]] || continue
    cur=$(timeout 10 "$dir/grin" --version 2>/dev/null | head -1)
    if ! restore_prev "$dir"; then
        echo "MDP|dir_fail|$dir|restore from grin.prev failed (grin.prev kept)"; echo "MDP|suspect|$dir"; continue
    fi
    if id grin >/dev/null 2>&1; then chown grin:grin "$dir/grin" 2>/dev/null; fi
    back=$(timeout 10 "$dir/grin" --version 2>/dev/null | head -1)
    if [[ -z "$back" ]]; then
        echo "MDP|dir_fail|$dir|restored binary prints no version (grin.prev kept)"; echo "MDP|suspect|$dir"; continue
    fi
    rm -f "$dir/grin.prev" "$dir/.grin_binary_info"
    echo "MDP|swap|$dir|$cur|$back"
    restored=$((restored+1))
done
if [[ $restored -gt 0 ]]; then echo __OK__; else echo "MDP|err|nothing restored"; fi
MDP_REMOTE
}

# ─── Local helpers ────────────────────────────────────────────────────────────

# _mdp_opts — ssh/scp options for the current host (MD_SSH_OPTS stays untouched).
_mdp_opts() {
    read -ra _MDP_O <<< "$MD_SSH_OPTS"
    _MDP_O+=(-o ServerAliveInterval=15 -o ServerAliveCountMax=4)
    if [[ -n "$_h_key" && -f "$_h_key" ]]; then _MDP_O+=(-i "$_h_key"); fi
}

# _mdp_rexec — run the script on stdin on the current host. The one place that
# prefixes `trap '' HUP PIPE`.
_mdp_rexec() {
    { echo "trap '' HUP PIPE"; cat; } | ssh "${_MDP_O[@]}" -p "$_h_port" "$_h_user@$_h_host" "bash -s" 2>&1
}

# _mdp_val <output> <key> — value of the first MDP|key|… line.
_mdp_val() { printf '%s\n' "$1" | sed -n "s/^MDP|$2|//p" | head -1; }
# _mdp_vals <output> <key> — every value of that key, one per line.
_mdp_vals() { printf '%s\n' "$1" | sed -n "s/^MDP|$2|//p"; }

_mdp_load_host() {
    local i="$1"
    _h_label="${_md_labels[$i]}"; _h_host="${_md_hosts[$i]}"; _h_port="${_md_ports[$i]}"
    _h_user="${_md_users[$i]}"; _h_key="${_md_keys[$i]}"
    _mdp_opts
}

# _mdp_is_self <host> — true when the entry is this controller.
_mdp_is_self() {
    local h="$1" a
    case "$h" in localhost|127.*|::1) return 0 ;; esac
    if [[ "$h" == "$(hostname 2>/dev/null)" || "$h" == "$(hostname -f 2>/dev/null)" ]]; then return 0; fi
    for a in $(hostname -I 2>/dev/null); do
        if [[ "$h" == "$a" ]]; then return 0; fi
    done
    return 1
}

# _mdp_collapse "dir|ver"… — one version when all dirs agree, else "name ver, …".
_mdp_collapse() {
    local e first="" same=1 s=""
    (( $# )) || { echo "-"; return 0; }
    for e in "$@"; do
        if [[ -z "$first" ]]; then first="${e#*|}"; fi
        if [[ "${e#*|}" != "$first" ]]; then same=0; fi
    done
    if (( same )); then echo "${first:-?}"; return 0; fi
    for e in "$@"; do s+="${s:+, }$(basename "${e%%|*}") ${e#*|}"; done
    echo "$s"
}

# _mdp_record <res> <reason> <old> <new> <autostart> <reboot-idx|""> <tag> — one summary row.
_mdp_record() {
    local res="$1" reason="$2" old="${3:--}" new="${4:--}" auto="${5:--}" ridx="${6:-}" tag="${7:-}" stop=0
    if [[ "$res" == FAILED ]] && (( _MDP_TOUCHED )); then
        stop=1; warn "$_h_label: nodes are STOPPED — start with key a or reboot"
    fi
    _MDP_S_LABEL+=("$_h_label"); _MDP_S_OLD+=("$old"); _MDP_S_NEW+=("$new")
    _MDP_S_RES+=("$res${reason:+: $reason}"); _MDP_S_AUTO+=("$auto"); _MDP_S_STOP+=("$stop")
    _MDP_LAST="$res"
    if [[ -n "$ridx" ]]; then _MDP_REBOOT+=("$ridx|$auto|$tag"); fi
    log "[BINARY PUSH] $_h_label ($_h_host) $res${reason:+: $reason} old='$old' new='$new' autostart=$auto stopped_on_fail=$stop"
    return 0
}

# _mdp_parse <output> — print per-dir lines; sets _R_* counters and versions.
_mdp_parse() {
    local out="$1" d a b
    local -a olds=() news=()
    _R_NSW=0; _R_NSKIP=0; _R_NFAIL=0; _R_SUSPECT=0; _R_WHY=""; _R_STOPPED=0; _R_OK=0
    _R_ERR=$(_mdp_val "$out" err)
    if grep -q '^MDP|stopped|' <<< "$out"; then _R_STOPPED=1; fi
    if grep -q '^__OK__' <<< "$out"; then _R_OK=1; fi
    while IFS='|' read -r d a b; do
        [[ -z "$d" ]] && continue
        echo "    $d: $a -> $b"; _R_NSW=$((_R_NSW+1)); olds+=("$d|$a"); news+=("$d|$b")
    done < <(_mdp_vals "$out" swap)
    while IFS='|' read -r d a b; do
        [[ -z "$d" ]] && continue
        echo "    $d: already current ($b)"; _R_NSKIP=$((_R_NSKIP+1)); olds+=("$d|$b"); news+=("$d|$b")
    done < <(_mdp_vals "$out" skip)
    while IFS='|' read -r d a; do
        [[ -z "$d" ]] && continue
        error "$d: $a"; _R_NFAIL=$((_R_NFAIL+1)); _R_WHY="$a"
    done < <(_mdp_vals "$out" dir_fail)
    _R_SUSPECT=$(_mdp_vals "$out" suspect | grep -c . || true)
    _mdp_vals "$out" warn | while IFS= read -r d; do warn "$d"; done
    _R_OLD=$(_mdp_collapse ${olds[@]+"${olds[@]}"}); _R_NEW=$(_mdp_collapse ${news[@]+"${news[@]}"})
}

# _mdp_conclude <idx> <autostart> <fallback-old> <verb> — turn _R_* into a row.
_mdp_conclude() {
    local idx="$1" auto="$2" fb="$3" verb="$4" ridx="" tag="" note=""
    if (( _R_STOPPED && _R_SUSPECT == 0 )); then ridx="$idx"; fi
    if (( _R_SUSPECT > 0 )); then note=" - $_R_SUSPECT dir(s) SUSPECT, check by hand"; fi
    if (( _R_OK == 0 || _R_NSW + _R_NSKIP == 0 )); then
        _mdp_record FAILED "${_R_WHY:-${_R_ERR:-no result}}$note" "$fb" - "$auto" "$ridx" "failed, clean"; return 1
    fi
    if (( _R_NFAIL > 0 )); then
        _mdp_record FAILED "partial: $_R_NSW $verb, $_R_NFAIL failed ($_R_WHY)$note" "$_R_OLD" "$_R_NEW" "$auto" "$ridx" partial; return 1
    fi
    if (( _R_NSW == 0 )); then
        success "Already current on every node dir; nodes left stopped."
        _mdp_record OK "already current" "$_R_OLD" "$_R_NEW" "$auto" "$ridx"; return 0
    fi
    local extra=""; (( _R_NSKIP > 0 )) && extra=", $_R_NSKIP already current"
    success "$verb $_R_NSW node dir(s)${extra}; nodes left stopped."
    _mdp_record OK "$_R_NSW dir(s)" "$_R_OLD" "$_R_NEW" "$auto" "$ridx"
    return 0
}

_mdp_countdown() {
    local s="$_MDP_PAUSE"
    (( s > 0 )) || return 0
    for (( ; s>0; s-- )); do
        printf '\r  Pausing before the next server: %4ds ' "$s"
        sleep 1
    done
    printf '\r%60s\r' ''
}

# Common questions: servers, pause. Returns 1 to abort.
_mdp_ask_common() {
    _md_select_servers || return 1
    local p
    echo -ne "  ${BOLD}Pause between servers in seconds [${MDP_PAUSE_DEFAULT}]: ${RESET}"
    read -r p
    [[ -z "$p" ]] && p="$MDP_PAUSE_DEFAULT"
    if [[ ! "$p" =~ ^[0-9]+$ ]]; then error "Pause must be a whole number of seconds."; return 1; fi
    _MDP_PAUSE="$p"
    _MDP_S_LABEL=(); _MDP_S_OLD=(); _MDP_S_NEW=(); _MDP_S_RES=(); _MDP_S_AUTO=(); _MDP_S_STOP=(); _MDP_REBOOT=()
    return 0
}

# _mdp_pick_artifact — newest first, version + sha256 each; sets _MDP_*.
_mdp_pick_artifact() {
    local -a arts=()
    mapfile -t arts < <(find "$MDP_BIN_DIR" -maxdepth 1 -type f -name 'grin-*' ! -name '*.info' ! -name '*.part' \
        -printf '%T@ %p\n' 2>/dev/null | sort -rn | cut -d' ' -f2-)
    if [[ ${#arts[@]} -eq 0 ]]; then
        error "No grin-* binaries in $MDP_BIN_DIR. Build one first (Script 01, source build)."
        return 1
    fi
    echo ""
    echo -e "  ${BOLD}Binaries in $MDP_BIN_DIR (newest first):${RESET}"
    local i v s
    for i in "${!arts[@]}"; do
        v=$(timeout 10 "${arts[$i]}" --version 2>/dev/null | head -1)
        s=$(sha256sum "${arts[$i]}" 2>/dev/null | cut -c1-16)
        printf "    ${CYAN}%2d${RESET}) %s\n        %s   sha256 %s...\n" "$((i+1))" "$(basename "${arts[$i]}")" "${v:-(no --version output)}" "$s"
    done
    echo -e "    ${DIM} 0${RESET}) Cancel"
    echo -ne "  ${BOLD}Select binary: ${RESET}"
    local sel; read -r sel
    if [[ ! "$sel" =~ ^[0-9]+$ ]] || (( sel < 1 || sel > ${#arts[@]} )); then info "Cancelled."; return 1; fi
    _MDP_ART="${arts[$((sel-1))]}"; _MDP_NAME=$(basename "$_MDP_ART")
    if [[ ! "$_MDP_NAME" =~ ^grin-[A-Za-z0-9._+-]+$ ]]; then error "Unsafe file name: $_MDP_NAME"; return 1; fi
    _MDP_VER=$(timeout 10 "$_MDP_ART" --version 2>/dev/null | head -1)
    if [[ -z "$_MDP_VER" ]]; then error "$_MDP_NAME prints no version here - refusing to push it."; return 1; fi
    _MDP_SHA=$(sha256sum "$_MDP_ART" 2>/dev/null | cut -d' ' -f1)
    if [[ -z "$_MDP_SHA" ]]; then error "Could not hash $_MDP_ART."; return 1; fi
    return 0
}

# _mdp_probe — fills _P_ARCH _P_FREE _P_AUTO _P_DIRS[] _P_PREV[]; 1 if unreachable.
_mdp_probe() {
    local out; out=$(_mdp_rs_probe | _mdp_rexec)
    if ! grep -q '^__OK__' <<< "$out"; then _P_ERR=$(printf '%s\n' "$out" | head -2 | tr '\n' ' '); return 1; fi
    _P_ARCH=$(_mdp_val "$out" arch); _P_FREE=$(_mdp_val "$out" free_kb)
    _P_AUTO=$(_mdp_vals "$out" auto | paste -sd, -); [[ -z "$_P_AUTO" ]] && _P_AUTO="none"
    mapfile -t _P_DIRS < <(_mdp_vals "$out" dir)
    mapfile -t _P_PREV < <(_mdp_vals "$out" prev)
    return 0
}

# _mdp_run_hosts <fn> — one server at a time; <fn> <idx> records its own row.
_mdp_run_hosts() {
    local fn="$1" n=${#_md_selected_idx[@]} k=0 idx j ans
    for idx in "${_md_selected_idx[@]}"; do
        k=$((k+1)); _MDP_LAST=""; _MDP_TOUCHED=0
        _mdp_load_host "$idx"
        echo ""
        echo -e "  ${BOLD}[$k/$n] $_h_label${RESET}  $_h_user@$_h_host:$_h_port"
        if _mdp_is_self "$_h_host"; then
            warn "this is the controller itself - skipped."; _mdp_record SKIPPED "this server"; continue
        fi
        "$fn" "$idx" || true
        if [[ "$_MDP_LAST" == FAILED ]] && (( k < n )); then
            echo -ne "  ${YELLOW}Continue with the remaining servers? [y/N]: ${RESET}"
            read -r ans
            if [[ ! "$ans" =~ ^[Yy]$ ]]; then
                for (( j=k; j<n; j++ )); do
                    _mdp_load_host "${_md_selected_idx[$j]}"; _MDP_TOUCHED=0; _mdp_record "NOT RUN" "stopped by operator"
                done
                return 0
            fi
        fi
        if (( k < n && _MDP_TOUCHED )); then _mdp_countdown; fi
    done
}

_mdp_summary() {
    local i
    echo ""
    echo -e "  ${BOLD}Summary${RESET}"
    printf "  %-16s | %-30s | %-30s | %-34s | %s\n" "Server" "Old version" "New version" "Result" "Autostart"
    for i in "${!_MDP_S_LABEL[@]}"; do
        printf "  %-16.16s | %-30.30s | %-30.30s | %-34.34s | %s\n" "${_MDP_S_LABEL[$i]}" \
            "${_MDP_S_OLD[$i]}" "${_MDP_S_NEW[$i]}" "${_MDP_S_RES[$i]}" "${_MDP_S_AUTO[$i]}"
    done
    for i in "${!_MDP_S_LABEL[@]}"; do
        if [[ "${_MDP_S_STOP[$i]}" == 1 ]]; then
            warn "${_MDP_S_LABEL[$i]}: FAILED - nodes are STOPPED — start with key a or reboot"
        fi
    done
}

# _mdp_offer_reboot — once for the whole run. Hosts without autostart are
# excluded; partial hosts are labelled. Suspect hosts never reach the list.
_mdp_offer_reboot() {
    local -a pick=(); local e idx auto tag lbl=""
    echo ""
    info "Nodes on the changed servers are STOPPED."
    for e in ${_MDP_REBOOT[@]+"${_MDP_REBOOT[@]}"}; do
        idx="${e%%|*}"; auto="${e#*|}"; tag="${auto#*|}"; auto="${auto%%|*}"
        if [[ "$auto" == none ]]; then
            warn "${_md_labels[$idx]}: no grin_autostart cron line - a reboot will NOT start its node; excluded."
        else
            pick+=("$idx"); lbl+="${lbl:+, }${_md_labels[$idx]}${tag:+ ($tag)}"
        fi
    done
    if [[ ${#pick[@]} -eq 0 ]]; then
        info "No server eligible for reboot. Start nodes with Remote Node Control key a."
        return 0
    fi
    echo "  Eligible: $lbl"
    echo -ne "  ${BOLD}Reboot the swapped servers so @reboot autostart brings the nodes up? [y/N]: ${RESET}"
    local ans; read -r ans
    [[ "$ans" =~ ^[Yy]$ ]] || { info "No reboot. Start nodes with key a, or reboot later with key e."; return 0; }
    local out
    for idx in "${pick[@]}"; do
        _mdp_load_host "$idx"
        out=$(_md_ssh "$_h_label" "$_h_host" "$_h_port" "$_h_user" "$_h_key" \
            "shutdown -r +1 'Rebooting via grin-node-toolkit' && echo __OK__")
        if grep -q '__OK__' <<< "$out"; then success "$_h_label: reboot scheduled (+1 min)"; log "[BINARY PUSH] $_h_label reboot scheduled"
        else error "$_h_label: reboot failed: $out"; fi
    done
}

# ─── f) Push ──────────────────────────────────────────────────────────────────

_mdp_host_push() {
    local idx="$1" out ent need_kb v old_v
    info "Pre-flight (node untouched)..."
    if ! _mdp_probe; then error "unreachable or probe failed: ${_P_ERR:-}"; _mdp_record FAILED "unreachable"; return 1; fi
    echo "    arch $_P_ARCH | free ${_P_FREE:-?} KB | autostart: $_P_AUTO"
    for ent in ${_P_DIRS[@]+"${_P_DIRS[@]}"}; do echo "    ${ent%%|*}: ${ent#*|}"; done
    if [[ "$_P_ARCH" != "$(uname -m)" ]]; then
        warn "arch $_P_ARCH differs from this server ($(uname -m))."; _mdp_record SKIPPED "arch $_P_ARCH" - - "$_P_AUTO"; return 0
    fi
    if (( ${#_P_DIRS[@]} == 0 )); then warn "no node directory with a grin binary."; _mdp_record SKIPPED "no node dir" - - "$_P_AUTO"; return 0; fi
    need_kb=$(( ($(stat -c %s "$_MDP_ART") / 1024 + 1) * (1 + 2 * ${#_P_DIRS[@]}) + 10240 ))
    if [[ ! "${_P_FREE:-}" =~ ^[0-9]+$ ]] || (( _P_FREE < need_kb )); then
        error "free space ${_P_FREE:-?} KB < needed ~${need_kb} KB"; _mdp_record FAILED "low disk space" - - "$_P_AUTO"; return 1
    fi
    old_v=$(_mdp_collapse "${_P_DIRS[@]}")

    info "Transfer (node keeps running)..."
    out=$({ printf 'ART_NAME=%q\n' "$_MDP_NAME"; _mdp_rs_prep; } | _mdp_rexec)
    if ! grep -q '^__OK__' <<< "$out"; then
        error "prepare failed: $(_mdp_val "$out" err)"; _mdp_record FAILED "remote prepare" "$old_v" - "$_P_AUTO"; return 1
    fi
    out=$(scp "${_MDP_O[@]}" -P "$_h_port" "$_MDP_ART" "$_h_user@$_h_host:$MDP_BIN_DIR/$_MDP_NAME.part" 2>&1) \
        || { error "scp failed: $out"; _mdp_record FAILED "scp failed" "$old_v" - "$_P_AUTO"; return 1; }
    if [[ -f "$_MDP_ART.info" ]]; then
        out=$(scp "${_MDP_O[@]}" -P "$_h_port" "$_MDP_ART.info" "$_h_user@$_h_host:$MDP_BIN_DIR/$_MDP_NAME.info" 2>&1) \
            || warn "provenance .info not copied: $out"
    fi
    out=$({ printf 'ART_NAME=%q\nWANT=%q\n' "$_MDP_NAME" "$_MDP_SHA"; _mdp_rs_finish; } | _mdp_rexec)
    if ! grep -q '^__OK__' <<< "$out"; then
        error "$(_mdp_val "$out" err)"; _mdp_record FAILED "$(_mdp_val "$out" err)" "$old_v" - "$_P_AUTO"; return 1
    fi
    v=$(_mdp_val "$out" ver)
    success "Staged $MDP_BIN_DIR/$_MDP_NAME on the server, sha256 verified, runs: $v"
    if (( _MDP_DRY )); then _mdp_record "DRY-RUN OK" "" "$old_v" "$v" "$_P_AUTO"; return 0; fi

    _MDP_TOUCHED=1
    info "Stopping all nodes, verifying, swapping (one session)..."
    out=$({ printf 'ART_NAME=%q\nCTRL=%q\n' "$_MDP_NAME" "$(hostname 2>/dev/null || echo controller)"
            printf '%s\n' "$_MD_NODE_STOP_SNIPPET"; _mdp_rs_verify; _mdp_rs_swap; } | _mdp_rexec)
    _mdp_parse "$out"
    _mdp_conclude "$idx" "$_P_AUTO" "$old_v" swapped
}

_mdp_push() {
    [[ -n "${_md_selected_idx+x}" ]] || _md_selected_idx=()
    _mdp_pick_artifact || { echo "Press Enter to continue..."; read -r; return 0; }
    _mdp_ask_common    || { echo "Press Enter to continue..."; read -r; return 0; }
    local ans
    echo ""
    echo -e "  ${BOLD}Push summary${RESET}"
    echo "    binary  : $_MDP_NAME"
    echo "    version : $_MDP_VER"
    echo "    sha256  : $_MDP_SHA"
    echo "    servers : ${#_md_selected_idx[@]} (one at a time, ${_MDP_PAUSE}s pause)"
    warn "Every node on a server is STOPPED before its binary is swapped, and left stopped."
    echo ""
    echo -e "  ${BOLD}Mode:${RESET}"
    echo -e "    ${CYAN}1${RESET}) Full push  ${DIM}check + copy + stop nodes + swap binary${RESET}"
    echo -e "    ${CYAN}2${RESET}) Dry run    ${DIM}check + copy to /opt/grin/bin only — nodes keep running${RESET}"
    echo -ne "  ${BOLD}Select mode [1]: ${RESET}"
    # read fails only at EOF (no operator): decline rather than take a default.
    read -r ans || ans=0
    case "${ans:-1}" in
        1) _MDP_DRY=0 ;;
        2) _MDP_DRY=1 ;;
        *) info "Cancelled."; return 0 ;;
    esac
    local _what="FULL PUSH — nodes will be stopped and swapped"
    (( _MDP_DRY )) && _what="DRY RUN — no node is touched"
    echo -ne "  ${BOLD}Proceed (${_what})? [Y/n]: ${RESET}"
    read -r ans || ans=n
    [[ "$ans" =~ ^[Nn] ]] && { info "Cancelled."; return 0; }
    log "[BINARY PUSH] start artifact=$_MDP_NAME sha256=$_MDP_SHA dry=$_MDP_DRY servers=${#_md_selected_idx[@]}"
    _mdp_run_hosts _mdp_host_push
    _mdp_summary
    (( _MDP_DRY )) || _mdp_offer_reboot
    echo ""; echo "Press Enter to continue..."; read -r
    return 0
}

# ─── g) Roll back ─────────────────────────────────────────────────────────────

_mdp_host_rollback() {
    local idx="$1" out
    info "Pre-flight (node untouched)..."
    if ! _mdp_probe; then error "unreachable or probe failed: ${_P_ERR:-}"; _mdp_record FAILED "unreachable"; return 1; fi
    echo "    autostart: $_P_AUTO | grin.prev in: ${_P_PREV[*]:-none}"
    if [[ ${#_P_PREV[@]} -eq 0 ]]; then warn "no grin.prev - nothing to roll back."; _mdp_record SKIPPED "no grin.prev" - - "$_P_AUTO"; return 0; fi
    _MDP_TOUCHED=1
    info "Stopping all nodes, verifying, restoring (one session)..."
    out=$({ printf '%s\n' "$_MD_NODE_STOP_SNIPPET"; _mdp_rs_verify; _mdp_rs_rollback; } | _mdp_rexec)
    _mdp_parse "$out"
    _mdp_conclude "$idx" "$_P_AUTO" - restored
}

_mdp_rollback() {
    [[ -n "${_md_selected_idx+x}" ]] || _md_selected_idx=()
    _mdp_ask_common || { echo "Press Enter to continue..."; read -r; return 0; }
    local ans
    echo ""
    warn "Each selected server: all nodes STOPPED, grin.prev restored over grin, nodes left stopped."
    echo -ne "  ${BOLD}Proceed with rollback on ${#_md_selected_idx[@]} server(s)? [y/N]: ${RESET}"
    read -r ans
    [[ "$ans" =~ ^[Yy]$ ]] || { info "Cancelled."; return 0; }
    log "[BINARY PUSH] rollback start servers=${#_md_selected_idx[@]}"
    _mdp_run_hosts _mdp_host_rollback
    _mdp_summary
    _mdp_offer_reboot
    echo ""; echo "Press Enter to continue..."; read -r
    return 0
}
