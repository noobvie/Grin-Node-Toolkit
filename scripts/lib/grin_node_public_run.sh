# =============================================================================
# lib/grin_node_public_run.sh — when and how the recorder publishes its page
# =============================================================================
# Sibling of lib/grin_node_events.sh, which sources it (_gne_public_load) for
# check's hook and for the worker's `publish` / `verify-chain`. Rendering, the
# privacy gate and the hash chain live in lib/grin_node_public.sh, loaded only
# when a publish or a verify actually runs, so a check with nothing due stays
# cheap.
#
#   gne_worker_publish [net…]     publish the nets in PUBLIC_NETS; any other
#                                 net loses only its SERVED files
#   gne_worker_verify_chain <net> read-only chain check
#   _gne_publish_due <t0>         check's hook: which nets are due, then one
#                                 bounded `publish` worker
#
# Writes only <net>/public/ (04's collector and 06d copy/read from there), under
# public/.lock, never the recorder's .lock: the watchdog's capture never waits
# on it. check runs it as a separate worker under `timeout`, after its lock and
# alerts, ending by GNE_PUBLISH_DEADLINE_S (TimeoutStartSec=120 kills the unit)
# or sooner when a low GAP_FACTOR needs the next check earlier.
#
# Conventions: sourced lib → NO shebang / NO `set -e`; errexit is OFF here, so
# every create/move/delete carries its own guard (project_lib_errexit_suppression).
# =============================================================================

[[ -n "${_GRIN_NODE_PUBLIC_RUN_SH_LOADED:-}" ]] && return 0
_GRIN_NODE_PUBLIC_RUN_SH_LOADED=1

_GNE_RUN_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GNE_PUBLISH_BUDGET_S=60
GNE_PUBLISH_DEADLINE_S=100
# Written and removed by 06d_tiny_explorer.sh (TINYX_SVC); the only 06d marker read here.
GNE_TINYX_UNIT="${GNE_TINYX_UNIT:-/etc/systemd/system/grin-tiny-explorer.service}"
_GNE_PUB_FD=""

# grin_node_public.sh sources its two siblings without a check, so one function
# from each of the three proves the set is whole: a partial set would publish a
# page with no windows or outages.
_gne_public_render_load() { # shellcheck source=grin_node_public.sh
    if [[ -r "$_GNE_RUN_LIB_DIR/grin_node_public.sh" ]]; then source "$_GNE_RUN_LIB_DIR/grin_node_public.sh"; fi
    declare -F gnp_history_sync gnp_compact_scan dgr_availability >/dev/null 2>&1 \
        || { echo "grin-node-events: grin_node_public.sh, grin_node_public_compact.sh or 086_lib_recorder.sh missing in $_GNE_RUN_LIB_DIR — re-install from 086." >&2; return 1; }
}

_gne_public_lock() { # <public dir> <wait s> → _GNE_PUB_FD. No flock = no publish: two writers fork the chain.
    _GNE_PUB_FD=""
    command -v flock >/dev/null 2>&1 || { echo "grin-node-events: flock missing — not publishing." >&2; return 1; }
    exec {_GNE_PUB_FD}>>"$1/.lock" || { _GNE_PUB_FD=""; return 1; }
    if ! flock -w "$2" "$_GNE_PUB_FD"; then
        exec {_GNE_PUB_FD}>&-; _GNE_PUB_FD=""
        echo "grin-node-events: $1/.lock busy — not publishing now." >&2; return 1
    fi
}
_gne_public_unlock() { if [[ -n "$_GNE_PUB_FD" ]]; then exec {_GNE_PUB_FD}>&-; fi; _GNE_PUB_FD=""; return 0; }

# 06d reads public/ as www-data; /opt/grin's mode is whatever the box's umask
# made it (the pool and Games installers widen it the same way). x only, no r,
# and only where 06d's unit exists: 04's collector copies as root and needs none.
_gne_public_traverse() {
    local p m; [[ -f "$GNE_TINYX_UNIT" ]] || return 0
    p=$(dirname "$GNE_EVENTS_DIR"); m=$(stat -c %a "$p" 2>/dev/null)
    if [[ "$m" =~ ^[0-7]{3,4}$ && ! -L "$p" ]] && (( (8#$m & 1) == 0 )); then
        chmod o+x "$p" || { echo "grin-node-events: cannot add o+x on $p — 06d may not read the page." >&2; return 1; }
        echo "grin-node-events: added o+x (traverse) on $p so the status page can be read." >&2
    fi
    return 0
}

# One net. Order under the lock: chain, history.json, availability.json (so its
# chain.head is the history just written), THEN the compaction scan: a slow scan
# or a timeout kill never leaves the served files stale, and the compactions it
# appends are served by the next run. A net's FIRST scan re-renders both files
# at once: until a log has been read, logged:false would claim the grin build
# does not log compactions. A failed chain sync (e.g. its salt is gone)
# publishes nothing.
_gne_publish_net() { # <net> <now>
    local net="$1" now="$2" d dir rc=0 first=0
    [[ -d "$GNE_EVENTS_DIR/$net" ]] || { echo "grin-node-events: $net is not recorded here — nothing to publish." >&2; return 1; }
    _gne_public_traverse || true
    _gnp_ensure_dir "$net" || return 1
    d=$(gnp_public_dir "$net")
    printf '%s\n' "$now" > "$d/.last_publish" || { echo "grin-node-events: cannot write $d/.last_publish." >&2; return 1; }
    _gne_public_lock "$d" 30 || return 1
    [[ -e "$d/.compact_scan" ]] || first=1
    if gnp_history_sync "$net" "$now"; then
        gnp_write_history "$net" && gnp_write_availability "$net" "$now" || rc=1
        if dir=$(gnc_resolve_node_dir "$net" 2>/dev/null) && ! gnp_compact_scan "$net" "$dir" "$now"; then
            echo "grin-node-events: $net compaction scan failed — no new compactions this time." >&2
        elif (( first && rc == 0 )) && [[ -f "$d/.compact_scan" ]]; then
            gnp_write_history "$net" && gnp_write_availability "$net" "$now" || rc=1
        fi
    else
        echo "grin-node-events: $net history chain not updated — nothing published this time." >&2; rc=1
    fi
    _gne_public_unlock
    return "$rc"
}

# Publishing off: only the two SERVED files go. history.jsonl, .public_salt and
# .compact_scan stay, so turning it back on extends the same chain.
_gne_publish_off() { # <net>
    local d="$GNE_EVENTS_DIR/$1/public"
    [[ -e "$d/availability.json" || -e "$d/history.json" ]] || return 0
    if [[ -L "$d" ]]; then echo "grin-node-events: $d is a symlink — not touching it." >&2; return 1; fi
    _gne_public_lock "$d" 30 || return 1
    rm -f -- "$d/availability.json" "$d/history.json" \
        || { _gne_public_unlock; echo "grin-node-events: cannot remove the served files in $d." >&2; return 1; }
    _gne_public_unlock
    echo "grin-node-events: $1 publishing is off — served files removed (history chain kept)." >&2
    return 0
}

# gne_worker_publish [net…] (default both) — a net in PUBLIC_NETS is published
# now; any other net loses its served files. rc 1 = some net failed.
gne_worker_publish() {
    local net rc=0 now
    gne_conf_load
    _gne_public_render_load || return 1
    now=$(_gne_now)
    if (( $# == 0 )); then set -- "${GNE_NETS[@]}"; fi
    for net in "$@"; do
        case "$net" in mainnet|testnet) ;; *) echo "grin-node-events: publish takes mainnet|testnet." >&2; rc=1; continue ;; esac
        if [[ " $GNE_C_PUBLIC_NETS " == *" $net "* ]]; then _gne_publish_net "$net" "$now" || rc=1
        else _gne_publish_off "$net" || rc=1; fi
    done
    return "$rc"
}

# check's hook <SECONDS at its start>: nets due (PUBLIC_EVERY_S since the last
# run, or an outage just closed) plus disabled nets still serving files.
_gne_publish_due() {
    local net d last now left dl; local -a due=()
    now=$(_gne_now)
    for net in "${GNE_NETS[@]}"; do
        d="$GNE_EVENTS_DIR/$net/public"; last=""
        if [[ " $GNE_C_PUBLIC_NETS " == *" $net "* && -d "$GNE_EVENTS_DIR/$net" ]]; then
            read -r last 2>/dev/null < "$d/.last_publish" || true; last=$(_gne_int "$last")
            if [[ -z "$last" || " $_GNE_PUB_CLOSED " == *" $net "* ]] || (( now - last >= GNE_C_PUBLIC_EVERY_S || now < last )); then due+=("$net"); fi
        elif [[ -e "$d/availability.json" || -e "$d/history.json" ]]; then
            due+=("$net")
        fi
    done
    (( ${#due[@]} > 0 )) || return 0
    # The next check starts only after this run: end it (kill grace included)
    # before GAP_FACTOR x cadence, or the recorder logs its own unobserved gap.
    dl=$(( ${GNE_C_GAP_FACTOR:-10} * GNE_CADENCE - GNE_CADENCE ))
    if (( dl > GNE_PUBLISH_DEADLINE_S )); then dl=$GNE_PUBLISH_DEADLINE_S; fi
    left=$(( dl - (SECONDS - $1) ))
    if (( left > GNE_PUBLISH_BUDGET_S )); then left=$GNE_PUBLISH_BUDGET_S; fi
    if (( left < 10 )); then echo "grin-node-events: no time left in this run — publishing next time." >&2; return 0; fi
    timeout -k 5 "$left" "$GNE_BIN" publish "${due[@]}" || echo "grin-node-events: publish ${due[*]} failed or timed out (rc $?)." >&2
    return 0
}

gne_worker_verify_chain() { # <net> — read-only; prints OK/FAIL, rc 0/1
    case "${1:-}" in mainnet|testnet) ;; *) echo "grin-node-events: verify-chain needs mainnet|testnet." >&2; return 2 ;; esac
    _gne_public_render_load || return 1
    gnp_verify_chain "$1"
}
