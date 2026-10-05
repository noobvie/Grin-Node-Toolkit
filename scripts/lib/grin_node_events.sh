# =============================================================================
# lib/grin_node_events.sh — node event recorder (READ-ONLY observer)
# =============================================================================
# Design: docs/generated/script086_design.md §8. Operator UI: 086 Diagnostics
# (hub 08 key 6). Records each down/up transition per network, keeps planned
# stops, boots and node starts out of the outage count, and keeps a ledger and
# a status file that the pool (as grinpool) can read.
#
#   gne_install            conf (if absent) + lib copies + worker + timer (30 s)
#   gne_remove             worker + units + logrotate; keeps state and conf
#   gne_status             timer state + per-net summary + last ledger lines
#   gne_decide             THE state machine — pure, no I/O (§8.4)
#   gne_classify           evidence → failure class refinement (§8.6, Part 3)
#   gne_import_alert_channels  copy 082's channel keys into recorder.conf (§8.10)
#   gne_set_channel / gne_set_num  validated recorder.conf writes (086's menu)
#
# Worker: /usr/local/bin/grin-node-events  check | capture | show [net] | test-alert
#   (generated from a QUOTED heredoc; sources only the /opt/grin/lib/ copies)
#   `capture <net> watchdog_restart <reason>` is the watchdog's one hook (§8.9):
#   it records restart_by_watchdog and saves the pane BEFORE the restart kills it.
#   Alerts (§8.10, Part 4): `check` decides and claims them under the lock and
#   delivers them AFTER it, through lib/grin_alert_send.sh (shared with 082), so a
#   slow channel never makes the watchdog's capture give up on the lock.
#
# READ-ONLY (§8.2 — every item is a review gate):
#   · never starts, stops, restarts, kills or signals a node; never touches
#     a tmux server except `has-session` + `capture-pane` behind the socket
#     guard in _gne_pane_capture;
#   · never writes into a node dir — it READS .grin_last_start/.grin_last_exit,
#     grin-server.toml, the secret, the node log and chain_data/txhashset sizes;
#   · the Owner API probe feeds the secret to curl on STDIN (-K -), never argv —
#     NOT gnc_owner_get_status (§8.13 F-3);
#   · deletes only inside $GNE_EVENTS_DIR (consumed planned-stop markers, its own
#     temp files, evidence bundles past their caps — names validated first);
#   · recorder.conf is parsed against an allow-list, never sourced.
#
# Conventions: sourced lib → NO shebang / NO `set -e`. It is reached through
# `fn || true` menu arms and from the worker, so errexit is OFF here: every
# create/copy/move/delete carries its own guard (project_lib_errexit_suppression).
# nounset-safe: the worker runs `set -uo pipefail`.
# =============================================================================

[[ -n "${_GRIN_NODE_EVENTS_SH_LOADED:-}" ]] && return 0
_GRIN_NODE_EVENTS_SH_LOADED=1

_GNE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GNE_CONTROL_LIB="${GNE_CONTROL_LIB:-$_GNE_LIB_DIR/grin_node_control.sh}"
GNE_SIG_LIB="${GNE_SIG_LIB:-$_GNE_LIB_DIR/grin_log_signatures.sh}"
GNE_ALERT_LIB="${GNE_ALERT_LIB:-$_GNE_LIB_DIR/grin_alert_send.sh}"
# shellcheck source=grin_node_control.sh
source "$GNE_CONTROL_LIB"
# 086's signature table (data only). Optional: an install from before Part 3
# has no copy, and the bundle then just lacks its signature-count section.
# shellcheck source=grin_log_signatures.sh
if [[ -r "$GNE_SIG_LIB" ]]; then source "$GNE_SIG_LIB"; fi
# Alert delivery (Part 4). Optional the same way: without it, alerts are off
# and `check` says so once per conf edit; recording is unaffected.
# shellcheck source=grin_alert_send.sh
if [[ -r "$GNE_ALERT_LIB" ]]; then source "$GNE_ALERT_LIB"; fi

# ─── Paths / constants (env-overridable for testing) ────────────────────────
GNE_RECORDER_VERSION="2026-10-03"
GNE_EVENTS_DIR="${GNE_EVENTS_DIR:-$GNC_EVENTS_DIR}"
GNE_CONF="${GNE_CONF:-/opt/grin/conf/node-events/recorder.conf}"
GNE_BIN="${GNE_BIN:-/usr/local/bin/grin-node-events}"
GNE_LIB_INSTALL_DIR="${GNE_LIB_INSTALL_DIR:-/opt/grin/lib}"
GNE_SERVICE="${GNE_SERVICE:-/etc/systemd/system/grin-node-events.service}"
GNE_TIMER="${GNE_TIMER:-/etc/systemd/system/grin-node-events.timer}"
GNE_LOGROTATE="${GNE_LOGROTATE:-/etc/logrotate.d/grin-node-events}"
GNE_WATCHDOG_BY="grin-node-sync-watchdog"
GNE_CADENCE=30            # the timer's OnUnitActiveSec — keep the two in step
GNE_NETS=(mainnet testnet)
GNE_WATCHDOG_LOG="${GNE_WATCHDOG_LOG:-/opt/grin/logs/node-watchdog.log}"
# 082's channel file — read ONLY by gne_import_alert_channels, on request.
GNE_AW_ALERT_CONF="${GNE_AW_ALERT_CONF:-/opt/grin/conf/access-watch/alert.conf}"
# Alert delivery bounds (§8.10): per channel, and for all of one run's alerts.
GNE_ALERT_CHANNEL_S=8
GNE_ALERT_BUDGET_S=20
# Evidence (§8.9). Line caps are per file; the MB/day caps come from recorder.conf.
GNE_CAPTURE_MIN_GAP=300   # one bundle per net per 5 min (corrupted is exempt)
GNE_CAPTURE_PER_OUTAGE=3  # watchdog-restart bundles per outage
GNE_LOG_LINES=5000
GNE_START_LINES=3000      # lines kept after the last "Starting server"
GNE_PANE_LINES=300
GNE_KERNEL_LINES=500
GNE_LOG_MAX_BACK=21600    # never read more than 6 h of node log for one bundle

# =============================================================================
# CONFIG — KEY=VALUE, allow-listed, range-checked, never sourced (§8.11)
# =============================================================================
# "KEY default min max" — numeric keys. ENABLED_NETS and the alert channel keys
# (_GNE_CHAN_KEYS, 082's names, Part 4) are handled separately.
_GNE_NUM_KEYS=(
    "DOWN_STRIKES 2 1 10"
    "START_TIMEOUT_MIN 30 5 240"
    "MARKER_TTL_MIN 15 1 120"
    "GAP_FACTOR 10 3 100"
    "EVIDENCE_BUNDLE_MB 50 1 1000"
    "EVIDENCE_TOTAL_MB 500 10 10000"
    "EVIDENCE_DAYS 180 1 3650"
    "ALERT_DOWN_AFTER_MIN 3 1 1440"
    "ALERT_LOOP_COUNT 3 2 50"
    "ALERT_LOOP_WINDOW_MIN 60 5 1440"
    "ALERT_UNCLEAN_BOOT 1 0 1"
)

# Alert channel keys — the same names as 082's alert.conf, so the import is a
# copy, not a translation. Values are validated (_gne_chan_valid): one that
# fails turns that channel OFF and is reported BY NAME, never by value.
_GNE_CHAN_KEYS=(NTFY_URL TG_BOT_TOKEN TG_CHAT_ID MAIL_TO NOSTR_SK NOSTR_RELAY)

# _gne_chan_valid <key> <value> → 0 when usable (empty = channel off = valid).
# Stricter than 082, which takes anything: a MAIL_TO starting with "-" would be
# an option to `mail`/`msmtp`, and a quote or backslash in a URL has no business
# in a curl config line.
_gne_chan_valid() {
    local v="$2" re
    [[ -z "$v" ]] && return 0
    (( ${#v} <= 512 )) || return 1
    case "$1" in
        NTFY_URL)     re='^https?://[^[:space:][:cntrl:]"\\]+$' ;;
        NOSTR_RELAY)  re='^wss?://[^[:space:][:cntrl:]"\\]+$' ;;
        TG_BOT_TOKEN) re='^[0-9]+:[A-Za-z0-9_-]+$' ;;
        TG_CHAT_ID)   re='^(-?[0-9]+|@[A-Za-z0-9_]+)$' ;;
        MAIL_TO)      re='^[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+$' ;;
        NOSTR_SK)     re='^(nsec1[02-9ac-hj-np-z]+|[0-9a-fA-F]{64})$' ;;
        *)            return 1 ;;
    esac
    [[ "$v" =~ $re ]]
}

# gne_conf_load → sets GNE_C_<KEY> for every allow-listed key, and
# GNE_CONF_WARNINGS (newline-separated) for values that fell back to a default.
gne_conf_load() {
    local spec key def min max line k v
    GNE_CONF_WARNINGS=""
    for spec in "${_GNE_NUM_KEYS[@]}"; do
        read -r key def min max <<< "$spec"
        printf -v "GNE_C_$key" '%s' "$def"
    done
    for key in "${_GNE_CHAN_KEYS[@]}"; do printf -v "GNE_C_$key" '%s' ""; done
    GNE_C_ENABLED_NETS="mainnet testnet"
    [[ -r "$GNE_CONF" ]] || return 0

    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^[[:space:]]*([A-Z_]+)[[:space:]]*=[[:space:]]*(.*)$ ]] || continue
        k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"
        # Channel values are taken whole (a URL may hold a `#`): trim, unquote
        # one matching pair, validate.
        if [[ " ${_GNE_CHAN_KEYS[*]} " == *" $k "* ]]; then
            v="${v%"${v##*[![:space:]]}"}"
            if [[ "$v" =~ ^\"(.*)\"$ || "$v" =~ ^\'(.*)\'$ ]]; then v="${BASH_REMATCH[1]}"; fi
            if _gne_chan_valid "$k" "$v"; then
                printf -v "GNE_C_$k" '%s' "$v"
            else
                printf -v "GNE_C_$k" '%s' ""
                GNE_CONF_WARNINGS+="$k is not a valid value — that channel is OFF"$'\n'
            fi
            continue
        fi
        v="${v%%#*}"                                   # trailing comment
        v="${v%"${v##*[![:space:]]}"}"                 # trailing blanks
        v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"
        if [[ "$k" == ENABLED_NETS ]]; then
            local n out=""
            for n in $v; do
                case "$n" in
                    mainnet|testnet) out+="$n " ;;
                    *) GNE_CONF_WARNINGS+="ENABLED_NETS: ignored '$n'"$'\n' ;;
                esac
            done
            GNE_C_ENABLED_NETS="${out% }"
            continue
        fi
        for spec in "${_GNE_NUM_KEYS[@]}"; do
            read -r key def min max <<< "$spec"
            [[ "$k" == "$key" ]] || continue
            if [[ "$v" =~ ^[0-9]+$ ]] && (( 10#$v >= min && 10#$v <= max )); then
                printf -v "GNE_C_$key" '%s' "$((10#$v))"
            else
                GNE_CONF_WARNINGS+="$key='$v' is not a number in $min..$max — using $def"$'\n'
            fi
            break
        done
    done < "$GNE_CONF"
    return 0
}

_gne_write_default_conf() {
    [[ -f "$GNE_CONF" ]] && return 0
    mkdir -p -m 700 "$(dirname "$GNE_CONF")" || { error "Cannot create $(dirname "$GNE_CONF")."; return 1; }
    local tmp
    tmp=$(mktemp "$(dirname "$GNE_CONF")/.recorder.conf.XXXXXX") || { error "Cannot write in $(dirname "$GNE_CONF")."; return 1; }
    cat > "$tmp" <<'CONF' || { rm -f "$tmp"; error "Cannot write $GNE_CONF."; return 1; }
# Grin node event recorder — configuration (086 design §8.11).
# KEY=VALUE lines. This file is PARSED, never sourced: unknown keys are ignored,
# and a value outside its range falls back to the default (logged once).

# Networks to watch, intersected with the instances conf.
ENABLED_NETS=mainnet testnet

# Consecutive failed 30 s checks before a node is called DOWN.
DOWN_STRIKES=2
# A start (or post-boot autostart) gets this long to answer get_status before
# it becomes failed_start. PROVISIONAL until real 5.5.1 start times are measured.
START_TIMEOUT_MIN=30
# An unconsumed planned-stop marker older than this is stale.
MARKER_TTL_MIN=15
# A gap of more than GAP_FACTOR x 30 s between checks is recorded as unobserved.
GAP_FACTOR=10

# Evidence bundles (Part 3).
EVIDENCE_BUNDLE_MB=50
EVIDENCE_TOTAL_MB=500
EVIDENCE_DAYS=180

# Alerts (Part 4). DOWN is sent once an outage has lasted this many minutes.
ALERT_DOWN_AFTER_MIN=3
# A restart loop = this many sync-watchdog restarts within the window.
ALERT_LOOP_COUNT=3
ALERT_LOOP_WINDOW_MIN=60
# 1 = alert when the host rebooted WITHOUT a clean shutdown while a node was up.
ALERT_UNCLEAN_BOOT=1

# Off-box alert channels, under 082's key names. Empty = off. This file is the
# recorder's own: it never reads Provider Access Watch's alert.conf on its own;
# 086's recorder menu can IMPORT those channels on request.
# One value per key, unquoted. Nostr needs `nak` (or nostril + websocat).
NTFY_URL=
TG_BOT_TOKEN=
TG_CHAT_ID=
MAIL_TO=
NOSTR_SK=
NOSTR_RELAY=
CONF
    chmod 600 "$tmp" || { rm -f "$tmp"; error "Cannot chmod $tmp."; return 1; }
    mv -f "$tmp" "$GNE_CONF" || { rm -f "$tmp"; error "Cannot install $GNE_CONF."; return 1; }
    info "Wrote default recorder config: $GNE_CONF"
    return 0
}

# gne_conf_set <KEY> <value> — replace (or append) one allow-listed key in
# recorder.conf, atomically, 0600. Pure bash on purpose: a channel value is a
# secret, and sed/grep would put it in argv. The caller validates the value's
# meaning (_gne_chan_valid / a range); this only refuses unknown keys and
# control characters (a newline would inject a second line).
gne_conf_set() {
    local k="$1" v="$2" spec key ok=0 tmp line done_=0 re
    [[ "$k" == ENABLED_NETS || " ${_GNE_CHAN_KEYS[*]} " == *" $k "* ]] && ok=1
    for spec in "${_GNE_NUM_KEYS[@]}"; do read -r key _ <<< "$spec"; [[ "$k" == "$key" ]] && ok=1; done
    (( ok )) || { error "recorder.conf: unknown key $k."; return 1; }
    [[ "$v" == *[[:cntrl:]]* ]] && { error "recorder.conf: $k contains a control character."; return 1; }
    _gne_write_default_conf || return 1
    tmp=$(mktemp "$(dirname "$GNE_CONF")/.recorder.conf.XXXXXX") || { error "Cannot write in $(dirname "$GNE_CONF")."; return 1; }
    chmod 600 "$tmp" || { rm -f "$tmp"; error "Cannot chmod $tmp."; return 1; }
    re="^[[:space:]]*$k[[:space:]]*="
    {
        while IFS= read -r line || [[ -n "$line" ]]; do
            if [[ "$line" =~ $re ]]; then
                (( done_ )) && continue              # drop a duplicate key
                printf '%s=%s\n' "$k" "$v"; done_=1
            else
                printf '%s\n' "$line"
            fi
        done < "$GNE_CONF"
        (( done_ )) || printf '%s=%s\n' "$k" "$v"
    } > "$tmp" || { rm -f "$tmp"; error "Cannot write $tmp."; return 1; }
    mv -f "$tmp" "$GNE_CONF" || { rm -f "$tmp"; error "Cannot install $GNE_CONF."; return 1; }
    return 0
}

# gne_set_channel <KEY> <value> — validate, then write one alert channel key
# (086's alert settings). An empty value turns that channel off. A rejected
# value is reported by key NAME only: it may be a secret.
gne_set_channel() {
    [[ " ${_GNE_CHAN_KEYS[*]} " == *" ${1:-} "* ]] || { error "Not an alert channel key: ${1:-}."; return 1; }
    if ! _gne_chan_valid "$1" "${2-}"; then
        error "$1: that value is not in the accepted form — nothing was changed."
        return 1
    fi
    gne_conf_set "$1" "${2-}"
}

# gne_set_num <KEY> <value> — range-checked write of one numeric key.
gne_set_num() {
    local spec key def min max
    for spec in "${_GNE_NUM_KEYS[@]}"; do
        read -r key def min max <<< "$spec"
        [[ "$key" == "${1:-}" ]] || continue
        if [[ ! "${2:-}" =~ ^[0-9]{1,6}$ ]] || (( 10#$2 < min || 10#$2 > max )); then
            error "$key must be a whole number in $min..$max — nothing was changed."
            return 1
        fi
        gne_conf_set "$key" "$((10#$2))"
        return
    done
    error "Not a numeric recorder key: ${1:-}."
    return 1
}

# gne_chan_valid <KEY> <value> — rc 0 when the value is usable (a pair's two
# halves are checked BEFORE either is written, so a menu never leaves half set).
gne_chan_valid() { _gne_chan_valid "${1:-}" "${2-}"; }

# gne_num_specs — one "KEY default min max" line per numeric key (for a menu).
gne_num_specs() { printf '%s\n' "${_GNE_NUM_KEYS[@]}"; }

# gne_chan_keys — the alert channel key names, one per line.
gne_chan_keys() { printf '%s\n' "${_GNE_CHAN_KEYS[@]}"; }

# _gne_unq <value> — undo bash `printf %q`, the way 082's _aw_set_conf writes
# alert.conf, WITHOUT evaluating it. rc 1 = a form this does not decode ($'…'
# ANSI-C quoting, or an unescaped shell metacharacter) — the caller skips it.
_gne_unq() {
    local s="$1" out="" c i
    if [[ "$s" == "''" ]]; then return 0; fi
    if [[ "$s" == "\$'"* ]]; then return 1; fi
    if [[ "$s" =~ ^\'([^\']*)\'$ ]]; then printf '%s' "${BASH_REMATCH[1]}"; return 0; fi
    for (( i = 0; i < ${#s}; i++ )); do
        c="${s:i:1}"
        if [[ "$c" == '\' ]]; then
            i=$(( i + 1 )); c="${s:i:1}"
        elif [[ "$c" == [\'\"\$\`\;\&\|\<\>\(\)[:space:]] ]]; then
            return 1
        fi
        out+="$c"
    done
    printf '%s' "$out"
}

# gne_import_alert_channels [alert.conf] — the explicit "import channels from
# Access Watch" action (§8.10). Copies each allow-listed channel key that 082
# has SET; a key 082 has empty leaves the recorder's value alone. alert.conf is
# read line by line and never sourced (§8.2). Prints key NAMES only.
gne_import_alert_channels() {
    local src="${1:-$GNE_AW_ALERT_CONF}" line k raw v got="" bad="" n=0
    local -A val=()
    [[ -r "$src" ]] || { error "Cannot read $src — is Provider Access Watch (hub 08 → 2) set up?"; return 1; }
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^([A-Z_]+)=(.*)$ ]] || continue
        k="${BASH_REMATCH[1]}"; raw="${BASH_REMATCH[2]}"
        [[ " ${_GNE_CHAN_KEYS[*]} " == *" $k "* ]] || continue
        if ! v=$(_gne_unq "$raw"); then bad+="$k "; unset 'val[$k]'; continue; fi
        if ! _gne_chan_valid "$k" "$v"; then bad+="$k "; unset 'val[$k]'; continue; fi
        val[$k]="$v"                                 # a later line wins, as `source` would
    done < "$src"
    for k in "${_GNE_CHAN_KEYS[@]}"; do
        [[ -n "${val[$k]:-}" ]] || continue
        gne_conf_set "$k" "${val[$k]}" || return 1
        got+="$k "; n=$(( n + 1 ))
    done
    if (( n )); then success "Imported from Access Watch: ${got% }"; else warn "Access Watch has no channel set — nothing imported."; fi
    if [[ -n "$bad" ]]; then warn "Not imported (a value the recorder cannot use safely): ${bad% }"; fi
    gne_conf_load
    local ch; ch=$(_gne_alert_channels)
    if [[ -n "$ch" ]]; then info "Recorder alert channels now active: $ch"
    else warn "No recorder alert channel is active (a Telegram or Nostr pair needs both halves)."; fi
    return 0
}

# =============================================================================
# SMALL PURE HELPERS (bash builtins only)
# =============================================================================
_gne_int() { [[ "${1:-}" =~ ^[0-9]+$ ]] && printf '%s' "$((10#$1))"; return 0; }

# JSON string (or null when empty). Control characters become spaces.
_gne_js() {
    local s="${1-}"
    if [[ -z "$s" ]]; then printf 'null'; return 0; fi
    s="${s//\\/\\\\}"; s="${s//\"/\\\"}"
    s="${s//[$'\001'-$'\037'$'\177']/ }"
    printf '"%s"' "$s"
}
# JSON integer (or null).
_gne_jn() { if [[ "${1:-}" =~ ^-?[0-9]+$ ]]; then printf '%s' "$1"; else printf 'null'; fi; }

# _gne_jget <one-line json> <key> → the value of the FIRST top-level-looking
# "key": — strings unquoted, null → empty. Only for files this lib writes
# (status.json is one line, scalar keys before the nested open_outage object).
_gne_jget() {
    local re='[{,]"'"$2"'":("([^"\\]|\\.)*"|[^,}]*)' v
    [[ "${1:-}" =~ $re ]] || return 0
    v="${BASH_REMATCH[1]}"
    [[ "$v" == null ]] && return 0
    if [[ "$v" == \"*\" ]]; then
        v="${v:1:${#v}-2}"; v="${v//\\\"/\"}"; v="${v//\\\\/\\}"
    fi
    printf '%s' "$v"
}

# Restrict to the ledger's character sets (§8.8).
_gne_clean_word()   { local s="${1:-}"; s="${s//[^A-Za-z0-9_.-]/_}"; printf '%s' "${s:0:40}"; }
_gne_clean_sub()    { local s="${1:-}"; s="${s//[^a-z0-9_=:.-]/_}"; printf '%s' "${s:0:40}"; }
_gne_clean_reason() { local s="${1:-}"; s="${s//[^[:print:]]/ }"; s="${s//|/ }"; printf '%s' "${s:0:160}"; }

# _gne_exit_class <rc|empty> → "class sub" for a pid that went away (§8.6).
_gne_exit_class() {
    local rc="${1:-}"
    if [[ -z "$rc" ]]; then echo "unexplained_stop exit_unknown"; return 0; fi
    case "$rc" in
        137)            echo "killed rc=137" ;;
        0|130|143)      echo "unexplained_stop rc=$rc" ;;
        *)              echo "crashed rc=$rc" ;;   # 101 panic, 134 abort, 139 segv, any other
    esac
}

# =============================================================================
# gne_decide — the §8.4 transition table as ONE pure function.
# =============================================================================
# Inputs  (unset/empty = unknown):
#   GNE_I_NOW GNE_I_CADENCE GNE_I_STRIKES_NEED GNE_I_START_TIMEOUT_S
#   GNE_I_MARKER_TTL_S GNE_I_GAP_FACTOR
#   GNE_I_BOOT_ID GNE_I_BTIME GNE_I_AUTOSTART_DELAY  (empty = no @reboot line)
#   GNE_I_REGISTERED (1 = in the instances conf AND enabled)
#   GNE_I_PID GNE_I_PID_START GNE_I_API (ok|timeout|refused|bad|auth|no_secret)
#   GNE_I_LAST_START_TS GNE_I_LAST_EXIT_TS GNE_I_LAST_EXIT_RC
#   GNE_I_MARKER (1 = file present) GNE_I_MARKER_TS GNE_I_MARKER_BY
#   GNE_I_MARKER_PID GNE_I_MARKER_REASON
#   previous status.json:  GNE_I_P_STATE GNE_I_P_BOOT_ID GNE_I_P_LAST_CHECK
#   GNE_I_P_SINCE GNE_I_P_CLASS GNE_I_P_SUB GNE_I_P_SUB_STATE GNE_I_P_STRIKES
#   GNE_I_P_FIRST_FAIL GNE_I_P_LAST_PID GNE_I_P_NODE_STARTED GNE_I_P_START_REF
#   GNE_I_P_OUTAGE_ID GNE_I_P_OUTAGE_START GNE_I_P_OUTAGE_CLASS
#   GNE_I_P_LAST_OUTAGE_END GNE_I_P_PENDING_BY GNE_I_P_PENDING_TS
# Outputs:
#   GNE_O_STATE GNE_O_CLASS GNE_O_SUB GNE_O_SUB_STATE GNE_O_SINCE GNE_O_STRIKES
#   GNE_O_FIRST_FAIL GNE_O_LAST_PID GNE_O_START_REF GNE_O_UP_SINCE
#   GNE_O_OUTAGE_ID ("NEW" = opened by the event flagged `open`)
#   GNE_O_OUTAGE_START GNE_O_OUTAGE_CLASS GNE_O_LAST_OUTAGE_END
#   GNE_O_PENDING_BY GNE_O_PENDING_TS
#   GNE_O_CONSUME_MARKER (1 = delete the marker)
#   GNE_O_EV[]  one record per ledger line, '|'-separated:
#     event|state|class|class_initial|sub|by|started_at|duration_s|outage|rc|observed_gap_s|reason
#     outage = open | close | cont | ""  (which outage_id the line carries)
# Prints nothing. gne_decide_line prints "state class events" for harnesses.
gne_decide() {
    GNE_O_EV=()
    local now cad need st_to ttl gapf
    now=$(_gne_int "${GNE_I_NOW:-}")
    cad=$(_gne_int "${GNE_I_CADENCE:-30}");            cad=${cad:-30}
    need=$(_gne_int "${GNE_I_STRIKES_NEED:-2}");       need=${need:-2}
    st_to=$(_gne_int "${GNE_I_START_TIMEOUT_S:-1800}"); st_to=${st_to:-1800}
    ttl=$(_gne_int "${GNE_I_MARKER_TTL_S:-900}");      ttl=${ttl:-900}
    gapf=$(_gne_int "${GNE_I_GAP_FACTOR:-10}");        gapf=${gapf:-10}

    local boot="${GNE_I_BOOT_ID:-}" btime delay reg="${GNE_I_REGISTERED:-0}"
    btime=$(_gne_int "${GNE_I_BTIME:-}"); delay=$(_gne_int "${GNE_I_AUTOSTART_DELAY:-}")
    local pid pid_start api="${GNE_I_API:-bad}" ls_ts ex_ts ex_rc
    pid=$(_gne_int "${GNE_I_PID:-}"); pid_start=$(_gne_int "${GNE_I_PID_START:-}")
    ls_ts=$(_gne_int "${GNE_I_LAST_START_TS:-}")
    ex_ts=$(_gne_int "${GNE_I_LAST_EXIT_TS:-}"); ex_rc=$(_gne_int "${GNE_I_LAST_EXIT_RC:-}")
    # No process → nothing to authenticate against: an unreadable secret says
    # nothing about a node that is not running, so it is judged as not
    # answering. Otherwise a rebuild that wipes the secret (no vault entry yet)
    # drops a STOPPED node to `unknown`, and its next start reads as an outage.
    if [[ "$api" == no_secret && -z "$pid" ]]; then api=refused; fi
    local m="${GNE_I_MARKER:-0}" m_ts m_by m_pid m_reason
    m_ts=$(_gne_int "${GNE_I_MARKER_TS:-}"); m_by="${GNE_I_MARKER_BY:-}"
    m_pid=$(_gne_int "${GNE_I_MARKER_PID:-}"); m_reason="${GNE_I_MARKER_REASON:-}"

    local p_state="${GNE_I_P_STATE:-}" p_state_orig="${GNE_I_P_STATE:-}" p_boot="${GNE_I_P_BOOT_ID:-}"
    local p_last_check p_node_started
    p_last_check=$(_gne_int "${GNE_I_P_LAST_CHECK:-}")
    p_node_started=$(_gne_int "${GNE_I_P_NODE_STARTED:-}")

    # Working state, seeded from the previous status.
    local state="$p_state" class="${GNE_I_P_CLASS:-}" sub="${GNE_I_P_SUB:-}"
    local sub_state="${GNE_I_P_SUB_STATE:-}" since strikes fft lpid start_ref
    since=$(_gne_int "${GNE_I_P_SINCE:-}")
    strikes=$(_gne_int "${GNE_I_P_STRIKES:-}"); strikes=${strikes:-0}
    fft=$(_gne_int "${GNE_I_P_FIRST_FAIL:-}")
    lpid=$(_gne_int "${GNE_I_P_LAST_PID:-}")
    start_ref=$(_gne_int "${GNE_I_P_START_REF:-}")
    local o_id="${GNE_I_P_OUTAGE_ID:-}" o_start o_class="${GNE_I_P_OUTAGE_CLASS:-}" lend
    o_start=$(_gne_int "${GNE_I_P_OUTAGE_START:-}")
    lend=$(_gne_int "${GNE_I_P_LAST_OUTAGE_END:-}")
    local pend_by="${GNE_I_P_PENDING_BY:-}" pend_ts
    pend_ts=$(_gne_int "${GNE_I_P_PENDING_TS:-}")
    local consume=0 in_boot=0 clear_lpid=0 d_dur="" d_out=""

    if [[ -z "$now" ]]; then now=0; fi
    case "$p_state" in
        ""|up|starting|stopped|down|auth_fail|unregistered|unknown) ;;
        *) p_state=unknown; p_state_orig=unknown ;;   # garbage in status.json
    esac

    # ── 0. First run ──────────────────────────────────────────────────────────
    if [[ -z "$p_state" ]]; then
        _gne_d_ev recorder_start unknown "" "" "" "" "" "" "" "" "" ""
        p_state=unknown; state=unknown
    fi

    # ── 1. Unobserved gap / clock anomaly (same boot only) ───────────────────
    if [[ -n "$p_last_check" && -n "$p_boot" && "$p_boot" == "$boot" ]]; then
        if (( now < p_last_check || now - p_last_check > gapf * cad )); then
            local g=$(( now - p_last_check )); (( g < 0 )) && g=0
            _gne_d_ev gap "$p_state" "" "" "" "" "" "" "" "" "$g" ""
            strikes=0; fft=""
        fi
    fi

    # ── 2. Host boot (rule 1) ─────────────────────────────────────────────────
    if [[ -n "$p_boot" && -n "$boot" && "$p_boot" != "$boot" ]]; then
        local b_state=stopped bend="${btime:-$now}"
        if [[ -n "$delay" ]]; then b_state=starting; start_ref=$(( ${btime:-$now} + delay )); else start_ref=""; fi
        _gne_d_close "$bend"
        _gne_d_ev boot "$b_state" "${d_out:+$o_class}" "" "" "" "${d_out:+$o_start}" "$d_dur" "$d_out" "" "" ""
        _gne_d_clear
        p_state="$b_state"; state="$b_state"; since="$now"
        strikes=0; fft=""; lpid=""; sub_state=""; pend_by=""; pend_ts=""
        # A marker from before the boot refers to a pid that no longer exists.
        if [[ "$m" == 1 && -n "$m_ts" && -n "$btime" ]] && (( m_ts < btime )); then
            consume=1; m=0
        fi
        in_boot=1
    elif [[ -n "$delay" && -n "$btime" ]] && (( now - btime < delay + st_to )); then
        in_boot=1
    fi

    # ── 3. Not registered / disabled (rule 2) ────────────────────────────────
    if [[ "$reg" != 1 ]]; then
        if [[ "$p_state" != unregistered ]]; then
            _gne_d_close "$now"
            _gne_d_ev unregistered unregistered "${d_out:+$o_class}" "" "" "" "${d_out:+$o_start}" "$d_dur" "$d_out" "" "" ""
            since="$now"
        fi
        _gne_d_clear
        state=unregistered; class=""; sub=""; sub_state=""; strikes=0; fft=""; start_ref=""; lpid=""
        _gne_decide_out "$now" "$state" "$class" "$sub" "$sub_state" "$since" "$strikes" "$fft" \
            "$lpid" "$start_ref" "$o_id" "$o_start" "$o_class" "$lend" "$pend_by" "$pend_ts" "$consume" "$pid_start"
        return 0
    fi
    if [[ "$p_state" == unregistered ]]; then p_state=stopped; lpid=""; fi

    # ── 4. Marker: stale? valid? watchdog? (§8.5) ────────────────────────────
    if [[ "$m" == 1 && ( -z "$m_ts" || $(( now - m_ts )) -gt $ttl ) ]]; then
        _gne_d_ev stale_marker "$p_state" "" "" "" "$(_gne_clean_word "$m_by")" "" "" "" "" "" ""
        consume=1; m=0
    fi
    local m_planned=0 wd=0
    if [[ "$m" == 1 && "$m_by" != "$GNE_WATCHDOG_BY" && -n "$m_pid" && "$m_pid" != 0 \
          && -n "$lpid" && "$m_pid" == "$lpid" ]]; then
        m_planned=1
    fi
    if [[ "$m" == 1 && "$m_by" == "$GNE_WATCHDOG_BY" ]]; then wd=1; fi
    if [[ -n "$pend_by" && -n "$pend_ts" ]] && (( now - pend_ts <= st_to )); then wd=1; fi

    # Who started a new process (rule 7/12/15 `by`).
    local start_by=unknown
    if (( wd )); then start_by="$GNE_WATCHDOG_BY"
    elif [[ "$m" == 1 ]]; then start_by=$(_gne_clean_word "$m_by")
    elif (( in_boot )); then start_by=boot_autostart
    fi
    [[ -n "$start_by" ]] || start_by=unknown

    local pid_gone=0 pid_new=0
    [[ -z "$pid" ]] && pid_gone=1
    [[ -n "$pid" && "$pid" != "$lpid" ]] && pid_new=1
    # .grin_last_exit belongs to the process that went away if it was written
    # after that process (or the latest pane run) started (§8.3).
    local ex_valid=0
    if [[ -n "$ex_ts" ]]; then
        if [[ -n "$ls_ts" ]] && (( ex_ts >= ls_ts )); then ex_valid=1; fi
        if [[ -n "$p_node_started" ]] && (( ex_ts + 1 >= p_node_started )); then ex_valid=1; fi
    fi
    local x_class x_sub
    if (( ex_valid )); then read -r x_class x_sub <<< "$(_gne_exit_class "$ex_rc")"
    else read -r x_class x_sub <<< "$(_gne_exit_class "")"; fi
    local h_sub=bad_reply
    case "$api" in timeout) h_sub=timeout ;; refused) h_sub=port_closed ;; esac
    # Start reference for a process seen now.
    local new_ref="${pid_start:-$now}"
    if [[ -n "$ls_ts" ]] && (( ls_ts > new_ref && ls_ts <= now )); then new_ref="$ls_ts"; fi

    local rc_ev=""; (( ex_valid )) && rc_ev="$ex_rc"

    # ── 5. Observation ────────────────────────────────────────────────────────
    case "$api" in
    ok) # rule 3
        if [[ "$p_state" == up && $pid_new == 1 && -n "$lpid" ]]; then
            # Stopped and restarted between two checks: not an outage (below
            # the 2-strike resolution), but on the record.
            _gne_d_ev start up "" "" "" "$start_by" "" "" "" "$rc_ev" "" "$(_gne_clean_reason "$m_reason")"
            consume=$(( consume | m )); pend_by=""; pend_ts=""
        fi
        if [[ "$p_state" == auth_fail ]]; then
            _gne_d_ev auth_ok up "" "" "" "" "" "" "" "" "" ""
        elif [[ "$p_state" != up ]]; then
            _gne_d_close "$now"
            _gne_d_ev up up "${d_out:+$o_class}" "" "" "" "${d_out:+$o_start}" "$d_dur" "$d_out" "" "" ""
            _gne_d_clear
        fi
        (( pid_new )) && { consume=$(( consume | m )); pend_by=""; pend_ts=""; }
        state=up; strikes=0; fft=""; start_ref=""; sub_state=""
        ;;
    auth) # rule 4 — the node answers; a secret is wrong. Never downtime.
        if [[ "$p_state" != auth_fail ]]; then
            _gne_d_close "$now"
            _gne_d_ev auth_fail auth_fail "${d_out:+$o_class}" "" "" "" "${d_out:+$o_start}" "$d_dur" "$d_out" "" "" ""
            _gne_d_clear
        fi
        (( pid_new )) && { consume=$(( consume | m )); pend_by=""; pend_ts=""; }
        state=auth_fail; strikes=0; fft=""; start_ref=""; sub_state=""
        ;;
    no_secret) # rule 5 — cannot judge; an open outage stays open
        if [[ "$p_state_orig" != unknown ]]; then
            _gne_d_ev probe_error unknown "" "" "no_secret" "" "" "" "" "" "" "owner API secret unreadable"
        fi
        state=unknown; strikes=0; fft=""
        ;;
    *)  # timeout | refused | bad — a failed check (unless starting)
        case "$p_state" in
        up|auth_fail|unknown)
            if [[ "$p_state" == unknown && -z "$lpid" && -z "$pid" ]]; then
                state=stopped                       # first sight: not running, cause unknown
            elif (( pid_gone || (pid_new && ${#lpid} > 0) )); then
                if (( m_planned && pid_gone )); then                        # rule 6
                    _gne_d_ev stop stopped "" "" "" "$(_gne_clean_word "$m_by")" "" "" "" "$rc_ev" "" "$(_gne_clean_reason "$m_reason")"
                    state=stopped; consume=1; strikes=0; fft=""
                elif (( (m_planned || wd) && ! pid_gone )); then            # rule 7
                    _gne_d_ev start starting "" "" "" "$start_by" "" "" "" "$rc_ev" "" "$(_gne_clean_reason "$m_reason")"
                    state=starting; start_ref="$new_ref"; consume=$(( consume | m ))
                    pend_by=""; pend_ts=""; strikes=0; fft=""
                elif (( wd && pid_gone )); then
                    # The watchdog killed it and is relaunching (capture recorded it).
                    state=starting; start_ref="$now"; clear_lpid=1; strikes=0; fft=""
                else                                                        # rule 8
                    strikes=$(( strikes + 1 )); [[ -n "$fft" ]] || fft="$now"
                    if (( strikes >= need )); then
                        _gne_open_down "$x_class" "$x_class" "$x_sub" "$fft" "$rc_ev" \
                            "process gone, no planned-stop marker"
                        if (( pid_new )); then
                            _gne_d_ev start down "$o_class" "" "" "$start_by" "" "" cont "" "" ""
                            sub_state=restarting; consume=$(( consume | m )); pend_by=""; pend_ts=""
                        fi
                    fi
                fi
            elif (( m_planned )); then
                # A toolkit stop of THIS pid is in progress (§8.5): grin can take
                # minutes to exit after SIGTERM (Script 01 waits up to 300 s), and
                # its API failing meanwhile is the stop, not a hang. No strike. The
                # marker's TTL bounds this: a kill that never lands goes stale and
                # the strikes resume.
                :
            elif [[ "$p_state" == unknown && -n "$pid_start" ]] && (( now - pid_start < st_to )); then
                state=starting; start_ref="$new_ref"
            else                                                            # rule 9
                strikes=$(( strikes + 1 )); [[ -n "$fft" ]] || fft="$now"
                if (( strikes >= need )); then
                    _gne_open_down hung hung "$h_sub" "$fft" "" "pid alive, API $api x$strikes"
                fi
            fi
            ;;
        starting) # rules 10, 11, 16
            [[ -n "$start_ref" ]] || start_ref="$now"
            if (( pid_gone )); then
                if (( m_planned )); then
                    _gne_d_ev stop stopped "" "" "" "$(_gne_clean_word "$m_by")" "" "" "" "$rc_ev" "" "$(_gne_clean_reason "$m_reason")"
                    state=stopped; consume=1
                elif (( wd )); then
                    if [[ -n "$lpid" ]]; then start_ref="$now"; fi
                    clear_lpid=1
                elif [[ -n "$lpid" ]] || (( ex_valid && ex_ts >= start_ref )); then
                    local fs_sub="exited_rc=${ex_rc:-unknown}" fs_at="$now"
                    (( ex_valid )) || fs_sub="exited"
                    (( ex_valid && ex_ts >= start_ref )) && fs_at="$ex_ts"
                    _gne_open_down failed_start failed_start "$fs_sub" "$fs_at" "$rc_ev" \
                        "process exited before its first get_status ok"
                elif (( now - start_ref < st_to )); then
                    state=starting
                else
                    _gne_open_down failed_start failed_start timeout "$(( start_ref + st_to ))" "" \
                        "no get_status ok within $(( st_to / 60 )) min of start"
                fi
            else
                if (( pid_new )) && [[ -n "$lpid" ]]; then
                    if (( m_planned || wd )); then
                        _gne_d_ev start starting "" "" "" "$start_by" "" "" "" "$rc_ev" "" "$(_gne_clean_reason "$m_reason")"
                        start_ref="$new_ref"; consume=$(( consume | m )); pend_by=""; pend_ts=""
                    else
                        local fs_at="$now"; (( ex_valid )) && fs_at="$ex_ts"
                        _gne_open_down failed_start failed_start "exited_rc=${ex_rc:-unknown}" "$fs_at" "$rc_ev" \
                            "process exited before its first get_status ok"
                        _gne_d_ev start down "$o_class" "" "" "$start_by" "" "" cont "" "" ""
                        sub_state=restarting; consume=$(( consume | m ))
                    fi
                elif (( pid_new )); then
                    # First process of this start: count from when it started.
                    (( new_ref > start_ref )) && start_ref="$new_ref"
                    consume=$(( consume | m )); pend_by=""; pend_ts=""
                fi
                if [[ "$state" == starting ]] && (( now - start_ref >= st_to )); then
                    _gne_open_down failed_start failed_start timeout "$(( start_ref + st_to ))" "" \
                        "no get_status ok within $(( st_to / 60 )) min of start"
                fi
            fi
            ;;
        stopped) # rules 12, 13
            if [[ -n "$pid" ]]; then
                _gne_d_ev start starting "" "" "" "$start_by" "" "" "" "" "" "$(_gne_clean_reason "$m_reason")"
                state=starting; start_ref="$new_ref"; consume=$(( consume | m )); pend_by=""; pend_ts=""
            fi
            ;;
        down) # rules 14, 15 — one outage spans every restart until rule 3
            if (( pid_new )); then
                _gne_d_ev start down "$o_class" "" "" "$start_by" "" "" cont "$rc_ev" "" "$(_gne_clean_reason "$m_reason")"
                sub_state=restarting; consume=$(( consume | m )); pend_by=""; pend_ts=""
            elif (( pid_gone && m_planned )); then
                # The operator stopped a down node on purpose: the outage ends here.
                _gne_d_close "$now"
                _gne_d_ev stop stopped "${d_out:+$o_class}" "" "" "$(_gne_clean_word "$m_by")" "${d_out:+$o_start}" "$d_dur" "$d_out" "$rc_ev" "" "$(_gne_clean_reason "$m_reason")"
                _gne_d_clear
                state=stopped; consume=1
            elif (( pid_gone )); then
                sub_state=""
            fi
            ;;
        esac
        ;;
    esac

    # ── 6. Derived fields ─────────────────────────────────────────────────────
    if (( clear_lpid )); then lpid=""
    elif [[ -n "$pid" ]] && ! { [[ "$state" == up || "$state" == auth_fail || "$state" == unknown ]] && (( strikes > 0 )); }; then
        # Mid-strike, keep the pre-failure pid so a change is still visible at
        # the tipping check.
        lpid="$pid"
    fi
    if [[ "$state" == down ]]; then class="$o_class"; else class=""; sub=""; sub_state=""; fi
    [[ "$state" == starting ]] || start_ref=""
    if [[ "$state" != "$p_state_orig" ]]; then since="$now"; fi
    [[ -n "$since" ]] || since="$now"

    _gne_decide_out "$now" "$state" "$class" "$sub" "$sub_state" "$since" "$strikes" "$fft" \
        "$lpid" "$start_ref" "$o_id" "$o_start" "$o_class" "$lend" "$pend_by" "$pend_ts" "$consume" "$pid_start"
    return 0
}

# ── gne_decide's helpers. They run INSIDE gne_decide and read/write its locals
# through bash's dynamic scope; never call them from anywhere else. ──────────

# One ledger record (see gne_decide's header for the 12 fields).
_gne_d_ev() { GNE_O_EV+=("$1|$2|$3|$4|$5|$6|$7|$8|$9|${10}|${11}|${12}"); }

# _gne_d_close <end_ts> — the current event closes the open outage, if any:
# sets d_dur / d_out (=close) and the last outage end.
_gne_d_close() {
    d_dur=""; d_out=""
    if [[ -n "$o_id" ]]; then
        local s="${o_start:-$1}"
        d_dur=$(( $1 - s )); if (( d_dur < 0 )); then d_dur=0; fi
        d_out=close; lend="$1"
    fi
    return 0
}
_gne_d_clear() { o_id=""; o_start=""; o_class=""; }

# _gne_open_down <class> <class_initial> <sub> <started_at> <rc> <reason>
# Opens a counted outage unless one is already open.
_gne_open_down() {
    state=down; strikes=0; fft=""
    if [[ -n "$o_id" ]]; then return 0; fi
    o_id=NEW; o_start="$4"; o_class="$1"; sub="$3"
    (( o_start > now )) && o_start="$now"
    _gne_d_ev down down "$1" "$2" "$3" "" "$o_start" "" open "$5" "" "$6"
    return 0
}

_gne_decide_out() {
    GNE_O_STATE="$2"; GNE_O_CLASS="$3"; GNE_O_SUB="$4"; GNE_O_SUB_STATE="$5"
    GNE_O_SINCE="$6"; GNE_O_STRIKES="$7"; GNE_O_FIRST_FAIL="$8"; GNE_O_LAST_PID="$9"
    GNE_O_START_REF="${10}"; GNE_O_OUTAGE_ID="${11}"; GNE_O_OUTAGE_START="${12}"
    GNE_O_OUTAGE_CLASS="${13}"; GNE_O_LAST_OUTAGE_END="${14}"
    GNE_O_PENDING_BY="${15}"; GNE_O_PENDING_TS="${16}"; GNE_O_CONSUME_MARKER="${17}"
    # up_since = later of the process start and the end of the last outage (§8.4).
    GNE_O_UP_SINCE=""
    if [[ "$2" == up ]]; then
        local ps="${18}" le="${14}" us=""
        us="$ps"
        if [[ -n "$le" ]] && { [[ -z "$us" ]] || (( le > us )); }; then us="$le"; fi
        GNE_O_UP_SINCE="${us:-$1}"
    fi
}

# Harness convenience: "state class event,event,…"
gne_decide_line() {
    gne_decide
    local e out=""
    for e in "${GNE_O_EV[@]}"; do out+="${e%%|*},"; done
    printf '%s %s %s\n' "$GNE_O_STATE" "${GNE_O_CLASS:--}" "${out%,}"
}

# =============================================================================
# INPUT GATHERING (read-only)
# =============================================================================
_gne_now() { printf '%(%s)T' -1; }

_gne_boot_id() {
    local b=""
    read -r b 2>/dev/null < /proc/sys/kernel/random/boot_id || true
    b="${b//-/}"; printf '%s' "${b:0:8}"
}
_gne_btime() {
    local k v
    while read -r k v _; do
        if [[ "$k" == btime ]]; then printf '%s' "$v"; return 0; fi
    done 2>/dev/null < /proc/stat
    return 0
}

# _gne_pid_start <pid> <btime> <clk_tck> → epoch the process started.
# Field 22 of /proc/<pid>/stat, parsed after the LAST ')' (comm may hold
# spaces or parens): the remainder starts at field 3, so 22 is index 19.
_gne_pid_start() {
    local line rest f=()
    read -r line 2>/dev/null < "/proc/$1/stat" || return 0
    rest="${line##*) }"
    read -ra f <<< "$rest"
    [[ "${f[19]:-}" =~ ^[0-9]+$ && "${2:-}" =~ ^[0-9]+$ && "${3:-}" =~ ^[1-9][0-9]*$ ]] || return 0
    printf '%s' "$(( $2 + f[19] / $3 ))"
}

# First uncommented `key = value` in a toml, quotes and trailing comment removed.
_gne_tv() {
    grep -E "^[[:space:]]*$2[[:space:]]*=" "$1" 2>/dev/null | head -1 \
        | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*#.*$//' | tr -d '"' || true
}

# _gne_node_pid <dir> <port> → the grin node pid. EXE-matched (§8.3): the
# shared tmux server's argv and cwd look like a node too. The port is a
# fallback only, and only for a process whose binary is named grin.
_gne_node_pid() {
    local p exe
    p=$(gnc_grin_pids_for_dir "$1" | head -n 1)
    if [[ -z "$p" ]]; then
        p=$(gnc_get_pid_on_port "$2" 2>/dev/null || true)
        if [[ -n "$p" ]]; then
            exe=$(_gnc_exe_path "$p" 2>/dev/null || true)
            [[ "$(basename "${exe:-x}")" == grin ]] || p=""
        fi
    fi
    printf '%s' "$p"
}

# _gne_secret_file <dir> <net> → the Owner API secret file, rc 1 if none.
# `~` is the node dir first: the launch contract runs grin with HOME=<dir>.
_gne_secret_file() {
    local dir="$1" net="$2" raw c
    local -a cands=()
    raw=$(_gne_tv "$dir/grin-server.toml" api_secret_path)
    if [[ -n "$raw" ]]; then
        case "$raw" in
            "~"*) cands+=("$dir${raw#\~}" "/opt/grin${raw#\~}") ;;
            /*)   cands+=("$raw") ;;
            *)    cands+=("$dir/$raw") ;;
        esac
    fi
    cands+=("$dir/.api_secret" "/opt/grin/keys/$net/.api_secret")
    for c in "${cands[@]}"; do
        if [[ -r "$c" ]]; then printf '%s' "$c"; return 0; fi
    done
    return 1
}

# _gne_probe <url> <secret-file> → ok | timeout | refused | auth | bad | no_secret
# One Owner get_status, 8 s cap. The secret travels in a curl config on STDIN
# (-K -), never on argv (§8.2, F-3). Reachability needs a parsed result.Ok.
_gne_probe() {
    local url="$1" sf="$2" secret esc out rc code body
    secret=$(tr -d '[:space:]' < "$sf" 2>/dev/null || true)
    if [[ -z "$secret" ]]; then echo no_secret; return 0; fi
    esc="${secret//\\/\\\\}"; esc="${esc//\"/\\\"}"
    out=$(printf 'user = "grin:%s"\n' "$esc" | curl -s -K - --max-time 8 \
            -H 'Content-Type: application/json' \
            -d '{"jsonrpc":"2.0","method":"get_status","params":[],"id":1}' \
            -w '\n%{http_code}\n' "$url" 2>/dev/null; echo "${PIPESTATUS[1]}")
    unset secret esc
    rc="${out##*$'\n'}"; out="${out%$'\n'*}"
    code="${out##*$'\n'}"; body="${out%$'\n'*}"
    case "$rc" in
        28) echo timeout; return 0 ;;
        7)  echo refused; return 0 ;;
        0)  ;;
        *)  echo bad; return 0 ;;
    esac
    case "$code" in
        401|403) echo auth; return 0 ;;
    esac
    if [[ "$code" == 200 && "$body" =~ \"result\"[[:space:]]*:[[:space:]]*\{[[:space:]]*\"Ok\" ]]; then
        echo ok
    else
        echo bad
    fi
}

# _gne_kv_file <file> <key> → value of `key=` in a one-line `k=v k=v` file.
_gne_kv_file() {
    local line="" re
    read -r line 2>/dev/null < "$1" || true
    re="(^| )$2=([^ ]*)"
    [[ "$line" =~ $re ]] && printf '%s' "${BASH_REMATCH[2]}"
    return 0
}

# _gne_autostart_delay <net> <crontab text> → N from `@reboot sleep N`, or empty.
_gne_autostart_delay() {
    local line
    line=$(printf '%s\n' "$2" | grep -F "grin_autostart_$1" | head -n 1)
    [[ "$line" =~ @reboot[[:space:]]+sleep[[:space:]]+([0-9]+) ]] && printf '%s' "${BASH_REMATCH[1]}"
    return 0
}

# _gne_clean_shutdown → true | false | null — how the PREVIOUS boot ended
# (§8.4). journald first; wtmp (`last -x`) when there is no previous journal.
_gne_clean_shutdown() {
    local j
    if j=$(journalctl -b -1 -n 80 --no-pager -o cat 2>/dev/null) && [[ -n "$j" ]]; then
        if printf '%s\n' "$j" | grep -qE 'systemd-shutdown|Reached target.*(Shutdown|Power-Off|Reboot)|reboot: (Restarting|Power down)'; then
            echo true
        else
            echo false
        fi
        return 0
    fi
    # wtmp, newest first: the current boot's `reboot` line, then the previous
    # boot's `shutdown` line if it ended cleanly.
    j=$(last -x -n 4 reboot shutdown 2>/dev/null | awk 'NF {print $1}' | head -n 2 | tr '\n' ' ')
    case "$j" in
        "reboot shutdown "*) echo true ;;
        "reboot reboot "*)   echo false ;;
        *)                   echo null ;;
    esac
}

# _gne_grin_version <binary> <cached-key> <cached-version> → "key<TAB>version".
# Cached per binary path + mtime. Runs as grin in a throwaway dir under the
# events dir with HOME there — never in the node dir, never as root (§8.2).
_gne_grin_version() {
    local bin="$1" key mt tmp v=""
    mt=$(stat -c %Y "$bin" 2>/dev/null || true)
    key="$bin:$mt"
    if [[ -n "$mt" && "$key" == "$2" && -n "$3" ]]; then printf '%s\t%s' "$key" "$3"; return 0; fi
    if [[ -n "$mt" ]] && id grin >/dev/null 2>&1; then
        if tmp=$(mktemp -d "$GNE_EVENTS_DIR/.vtmp.XXXXXX" 2>/dev/null); then
            if chown grin "$tmp" 2>/dev/null && chmod 700 "$tmp" 2>/dev/null; then
                v=$(su -s /bin/sh grin -c "cd '$tmp' && HOME='$tmp' timeout 10 '$bin' --version" 2>/dev/null </dev/null | head -n 1)
            fi
            rm -rf "$tmp" 2>/dev/null || true
        fi
        [[ "$v" =~ ([0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.+-]*) ]] && v="${BASH_REMATCH[1]:0:32}" || v=""
    fi
    printf '%s\t%s' "$key" "$v"
}

# =============================================================================
# WRITERS
# =============================================================================
_gne_append_ledger() { # <ledger> <json line>
    printf '%s\n' "$2" >> "$1" 2>/dev/null || { echo "grin-node-events: cannot append to $1" >&2; return 1; }
    return 0
}

# _gne_next_id <net> <now> → sets _GNE_ID. Ledger ids are <net>-<ts>-<seq>; the
# per-second seq lives in _GNE_ID_TS/_GNE_ID_SEQ (seeded from status.json's
# last_id_ts/last_id_seq), so a check and a capture in the same second never
# reuse an id.
_GNE_ID=""; _GNE_ID_TS=""; _GNE_ID_SEQ=""
_gne_next_id() {
    if [[ "$_GNE_ID_TS" == "$2" ]]; then _GNE_ID_SEQ=$(( ${_GNE_ID_SEQ:-0} + 1 )); else _GNE_ID_TS="$2"; _GNE_ID_SEQ=0; fi
    _GNE_ID="$1-$2-$_GNE_ID_SEQ"
}

# _gne_ledger_json <net> <ts> <id> <event> <state> <class> <class_initial> <sub>
#   <outage_id> <started_at> <duration_s> <pid> <prev_pid> <rc> <by> <reason>
#   <evidence> <grin_version> <clean_shutdown true|false|null> <observed_gap_s>
# → one §8.8 ledger line. Every free-text field is re-cleaned here, so a caller
# cannot put log text or a control character into the ledger by accident.
_gne_ledger_json() {
    local cs="${19:-null}"
    [[ "$cs" == true || "$cs" == false ]] || cs=null
    local l="{\"v\":1,\"id\":$(_gne_js "$3"),\"net\":$(_gne_js "$1"),\"ts\":$(_gne_jn "$2")"
    l+=",\"event\":$(_gne_js "$(_gne_clean_word "$4")"),\"state\":$(_gne_js "$(_gne_clean_word "$5")")"
    l+=",\"class\":$(_gne_js "$(_gne_clean_word "$6")"),\"class_initial\":$(_gne_js "$(_gne_clean_word "$7")")"
    l+=",\"sub\":$(_gne_js "$(_gne_clean_sub "$8")"),\"outage_id\":$(_gne_js "$(_gne_clean_word "$9")")"
    l+=",\"started_at\":$(_gne_jn "${10}"),\"duration_s\":$(_gne_jn "${11}")"
    l+=",\"pid\":$(_gne_jn "${12}"),\"prev_pid\":$(_gne_jn "${13}"),\"rc\":$(_gne_jn "${14}")"
    l+=",\"by\":$(_gne_js "$(_gne_clean_word "${15}")"),\"reason\":$(_gne_js "$(_gne_clean_reason "${16}")")"
    l+=",\"evidence\":$(_gne_js "$(_gne_clean_word "${17}")"),\"boot_id\":$(_gne_js "$(_gne_clean_word "$_GNE_CTX_BOOT")")"
    l+=",\"grin_version\":$(_gne_js "${18:0:32}")"
    l+=",\"clean_shutdown\":$cs,\"observed_gap_s\":$(_gne_jn "${20}")}"
    printf '%s' "$l"
}

# _gne_jset <one-line json> <key> <raw JSON value> → the json with the FIRST
# [{,]"key": value replaced (the same first-match rule as _gne_jget), or, when
# the key is absent (a status.json from an older recorder), inserted before
# "open_outage". Values may be a string, number, null, a flat [..] or {..}.
_gne_jset() {
    local s="$1" k="$2" v="$3" re m pre
    re='[{,]"'"$k"'":("([^"\\]|\\.)*"|\[[^]]*\]|\{[^}]*\}|[^,}]*)'
    if [[ "$s" =~ $re ]]; then
        m="${BASH_REMATCH[0]}"
        pre="${s%%"$m"*}"
        printf '%s%s"%s":%s%s' "$pre" "${m:0:1}" "$k" "$v" "${s:${#pre}+${#m}}"
    elif [[ "$s" == *',"open_outage":'* ]]; then
        pre="${s%%,\"open_outage\":*}"
        printf '%s,"%s":%s%s' "$pre" "$k" "$v" "${s:${#pre}}"
    else
        printf '%s,"%s":%s}' "${s%\}}" "$k" "$v"
    fi
}

_gne_write_status() { # <file> <json>
    local tmp
    tmp=$(mktemp "$(dirname "$1")/.status.XXXXXX" 2>/dev/null) || { echo "grin-node-events: cannot write in $(dirname "$1")" >&2; return 1; }
    if printf '%s\n' "$2" > "$tmp" 2>/dev/null && chmod 644 "$tmp" 2>/dev/null && mv -f "$tmp" "$1" 2>/dev/null; then
        return 0
    fi
    rm -f "$tmp" 2>/dev/null || true
    echo "grin-node-events: cannot replace $1" >&2
    return 1
}

# =============================================================================
# EVIDENCE BUNDLES + CLASSIFICATION (Part 3 — §8.6 refinement, §8.9 bundles)
# =============================================================================
# A bundle is <net>/evidence/<YYYYmmddTHHMMSSZ>_<class>/ (0700 root, files 0600).
# It is RAW: only root reads it, and masking happens at export (Part 5), never
# in place. Nothing from it reaches the ledger or status.json except its dir
# NAME. The one matched signature line is kept in match.txt for Part 4's alert.

_GNE_BUNDLE_RE='^[0-9]{8}T[0-9]{6}Z_[a-z_]+(-[0-9])?$'

# "YYYYmmdd HH:MM:SS" in the box's TZ — the grin log's own line prefix, so a
# window is cut by string comparison. UTC for everything a person reads.
_gne_local_ts() { date -d "@$1" '+%Y%m%d %H:%M:%S' 2>/dev/null; }
_gne_utc_ts()   { date -u -d "@$1" '+%Y-%m-%d %H:%M:%S UTC' 2>/dev/null; }

# _gne_node_logfile <dir> → the node log (log_file_path; `~` = the node dir).
_gne_node_logfile() {
    local lf; lf=$(_gne_tv "$1/grin-server.toml" log_file_path)
    [[ "$lf" == "~"* ]] && lf="$1${lf#\~}"
    [[ -n "$lf" && -f "$lf" ]] || lf="$1/grin-server.log"
    printf '%s' "$lf"
}

# _gne_log_stream <logfile> <since_epoch> → the node log from <since> on, across
# a rotation (grin's roller writes <log>.N.gz; one is read only if it was
# written after <since>). Continuation lines (backtraces) follow the verdict of
# the stamped line above them, as in 086's dg_log_filter.
_gne_log_stream() {
    local lf="$1" since="$2" s f
    s=$(_gne_local_ts "$since") || return 0
    [[ -n "$s" ]] || return 0
    {
        for f in $(ls -tr -- "$lf".[0-9]* 2>/dev/null); do
            (( $(stat -c %Y "$f" 2>/dev/null || echo 0) >= since )) || continue
            case "$f" in
                *.gz) zcat -- "$f" 2>/dev/null || true ;;
                *)    cat -- "$f" 2>/dev/null || true ;;
            esac
        done
        cat -- "$lf" 2>/dev/null || true
    } | awk -v s="$s" '
        /^[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9] / { inw = (substr($0, 1, 17) >= s) }
        inw { print }'
    return 0
}

# _gne_log_split <bundle> — stdin = the window; stdout = every line (the caller
# keeps the tail). One pass, bounded memory, mawk-safe. Also writes:
#   start.txt    from the LAST "Starting server" line on (≤ GNE_START_LINES):
#                the start window, wherever it falls in a long window;
#   .notable     every line a class rule can key on (the caller keeps the tail);
#   .window_n    the window's line count;
#   .sigcounts   "<idx>\t<count>" per 086 signature over its ERROR/WARN lines.
_gne_log_split() {
    local b="$1" i
    # A sentinel row, so the table file is never empty: with an empty first
    # file, awk's NR == FNR stays true and the whole log would read as table.
    printf '#\t-1\n' > "$b/.sigs"
    if declare -p DG_SIG_RE >/dev/null 2>&1; then
        for i in "${!DG_SIG_RE[@]}"; do printf '%s\t%s\n' "${DG_SIG_RE[$i]}" "$i" >> "$b/.sigs"; done
    fi
    awk -F'\t' -v sf="$b/start.txt" -v nf="$b/.notable" -v cf="$b/.window_n" \
        -v gf="$b/.sigcounts" -v smax="$GNE_START_LINES" '
        NR == FNR { if ($2 >= 0) { re[$2] = $1; ns = ($2 + 1 > ns ? $2 + 1 : ns) }; next }
        {
            l = tolower($0)
            if (l ~ /starting server/) { close(sf); printf "" > sf; sn = 0; st = 1 }
            if (st && sn < smax) { print > sf; sn++ }
            if (l ~ /panicked at|verify failed|corrupt|mdb_|invalid ?root|txhashset.*(invalid|fail|err)|compact|shutdown|out of memory|memory allocation/) print > nf
            if (ns && $0 ~ /^[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9] [0-9:.]+ (ERROR|WARN) /)
                for (i = 0; i < ns; i++) if (l ~ re[i]) { c[i]++; break }
            print; n++
        }
        END {
            print n + 0 > cf
            for (i = 0; i < ns; i++) if (c[i]) printf "%d\t%d\n", i, c[i] > gf
        }' "$b/.sigs" - 2>/dev/null
    return 0
}

# _gne_pane_capture <dir> <lines> → the node's tmux pane, raw. GUARDED (§8.2):
# grin's socket only when it exists AND is grin-owned; root's only when its
# socket file exists. has-session / capture-pane never start a server.
_gne_pane_capture() {
    local sess sock guid rsock=/tmp/tmux-0/default
    command -v tmux >/dev/null 2>&1 || { echo "# tmux is not installed"; return 0; }
    sess=$(_grin_session_name "$1")
    guid=$(id -u grin 2>/dev/null || true)
    if sock=$(gnc_grin_tmux_socket 2>/dev/null) && [[ -n "$guid" && "$(stat -c %u "$sock" 2>/dev/null)" == "$guid" ]] \
        && tmux -S "$sock" has-session -t "$sess" 2>/dev/null; then
        echo "# grin socket, session $sess"
        tmux -S "$sock" capture-pane -p -J -S "-$2" -t "$sess" 2>/dev/null
    elif [[ -S "$rsock" ]] && tmux -S "$rsock" has-session -t "$sess" 2>/dev/null; then
        echo "# ROOT socket, session $sess (it should be on the grin socket)"
        tmux -S "$rsock" capture-pane -p -J -S "-$2" -t "$sess" 2>/dev/null
    else
        echo "# no tmux session $sess on either socket — the pane is gone"
    fi
    return 0
}

# Kernel lines about memory, I/O, filesystems, hung tasks and segfaults since
# <since>. journald when present; dmesg otherwise (not time-filtered).
_gne_kernel_lines() {
    local re='out of memory|oom|killed process|i/o error|ext4-fs|xfs|btrfs|blocked for more than|hung_task|segfault|nvme|blk_update_request|read-only file system|grin'
    if command -v journalctl >/dev/null 2>&1; then
        echo "# journalctl -k --since $(_gne_utc_ts "$1"), filtered"
        journalctl -k --since "@$1" --no-pager -o short-iso 2>/dev/null | grep -aiE "$re" | tail -n "$GNE_KERNEL_LINES"
    elif command -v dmesg >/dev/null 2>&1; then
        echo "# journalctl absent: dmesg -T, filtered, NOT time-limited"
        dmesg -T 2>/dev/null | grep -aiE "$re" | tail -n "$GNE_KERNEL_LINES"
    else
        echo "# neither journalctl nor dmesg is available"
    fi
    return 0
}

_gne_host_snapshot() { # <node_dir>
    local p
    echo "## date / uptime";  date -u 2>/dev/null; uptime 2>/dev/null
    echo "## loadavg";        cat /proc/loadavg 2>/dev/null
    echo "## free -m";        free -m 2>/dev/null
    echo "## swap";           swapon --show 2>/dev/null || cat /proc/swaps 2>/dev/null
    echo "## df -h (node dir)"; df -h "$1" 2>/dev/null
    echo "## df -i (node dir)"; df -i "$1" 2>/dev/null
    for p in cpu memory io; do
        echo "## pressure $p"; cat "/proc/pressure/$p" 2>/dev/null || echo "(no PSI)"
    done
    return 0
}

# _gne_ps_snapshot <pid> <last_pid> — grin processes, their parent shells, and
# for a live node its thread states (D = waiting on disk) and memory.
_gne_ps_snapshot() {
    local p pp line rest t tid st n=0
    echo "## processes named grin"
    ps -o pid,ppid,user,stat,lstart,etime,rss,args -C grin 2>/dev/null || echo "(none)"
    for p in $(printf '%s\n' "${1:-}" "${2:-}" | grep -E '^[0-9]+$' | sort -u); do
        [[ -d "/proc/$p" ]] || { echo "## pid $p: gone"; continue; }
        read -r line 2>/dev/null < "/proc/$p/stat" || continue
        rest="${line##*) }"; read -r _ pp _ <<< "$rest"
        echo "## pid $p — parent $pp"
        ps -o pid,ppid,user,stat,lstart,etime,args -p "$pp" 2>/dev/null
        echo "## /proc/$p/status"
        grep -E '^(State|VmRSS|VmSwap|Threads|voluntary_ctxt|nonvoluntary_ctxt)' "/proc/$p/status" 2>/dev/null
        echo "## open fds: $(ls "/proc/$p/fd" 2>/dev/null | wc -l)"
        echo "## thread states (count state)"
        for t in /proc/"$p"/task/*/stat; do
            read -r line 2>/dev/null < "$t" || continue
            rest="${line##*) }"; echo "${rest%% *}"
        done | sort | uniq -c
        echo "## threads in D state (tid comm wchan), first 20"
        for t in /proc/"$p"/task/*; do
            read -r line 2>/dev/null < "$t/stat" || continue
            rest="${line##*) }"; st="${rest%% *}"
            [[ "$st" == D ]] || continue
            tid="${t##*/}"; n=$(( n + 1 )); (( n > 20 )) && break
            echo "$tid $(cat "$t/comm" 2>/dev/null) $(cat "$t/wchan" 2>/dev/null)"
        done
    done
    return 0
}

# _gne_chain_snapshot <node_dir> — txhashset file sizes, the pmmr_hash.bin % 32
# check and the kernel data tail, as the upstream issue draft asks. Reads only.
_gne_chain_snapshot() {
    local dir="$1" db m d sz
    db=$(_gne_tv "$dir/grin-server.toml" db_root)
    [[ "$db" == "~"* ]] && db="$dir${db#\~}"
    [[ -n "$db" ]] || db="$dir/chain_data"
    echo "# db_root: $db"
    for m in kernel output rangeproof; do
        d="$db/txhashset/$m"
        echo "## $m"
        ls -l --time-style=+%Y-%m-%dT%H:%M:%S "$d" 2>/dev/null || { echo "(missing: $d)"; continue; }
        if [[ -f "$d/pmmr_hash.bin" ]]; then
            sz=$(stat -c %s "$d/pmmr_hash.bin" 2>/dev/null || echo 0)
            echo "pmmr_hash.bin: $sz bytes, % 32 = $(( sz % 32 ))  (non-zero = a torn hash file)"
        fi
    done
    echo "## kernel/pmmr_data.bin — last 64 bytes"
    if [[ -f "$db/txhashset/kernel/pmmr_data.bin" ]]; then
        if command -v xxd >/dev/null 2>&1; then
            tail -c 64 "$db/txhashset/kernel/pmmr_data.bin" 2>/dev/null | xxd
        else
            tail -c 64 "$db/txhashset/kernel/pmmr_data.bin" 2>/dev/null | od -A d -t x1 -v
        fi
    else
        echo "(missing)"
    fi
    return 0
}

# ── Classification ───────────────────────────────────────────────────────────
# _gne_grep1 <ere> <file>... → the first matching line (case-insensitive) in the
# first file that has one, control characters blanked, ≤ 300 chars. rc 1 = none.
_gne_grep1() {
    local re="$1" f l; shift
    for f in "$@"; do
        [[ -s "$f" ]] || continue
        l=$(grep -m1 -aiE -- "$re" "$f" 2>/dev/null) || continue
        l="${l//[$'\001'-$'\037'$'\177']/ }"
        printf '%s' "${l:0:300}"; return 0
    done
    return 1
}

# _gne_oom_line <kernel.txt> <pid|empty> → the kernel OOM line that killed OUR
# grin. Both nets run a process named grin, so the pid must match when known.
_gne_oom_line() {
    local l ll p r1='killed process ([0-9]+) \(grin\)' r2='oom-kill:.*task=grin,pid=([0-9]+)'
    [[ -s "$1" ]] || return 1
    while IFS= read -r l; do
        ll="${l,,}"; p=""
        if [[ "$ll" =~ $r1 ]] || [[ "$ll" =~ $r2 ]]; then p="${BASH_REMATCH[1]}"; fi
        [[ -n "$p" ]] || continue
        if [[ -z "${2:-}" || "$p" == "$2" ]]; then printf '%s' "${l:0:300}"; return 0; fi
    done < <(grep -aiE 'killed process [0-9]+ \(grin\)|oom-kill:.*task=grin,' "$1" 2>/dev/null)
    return 1
}

# _gne_hung_task_line <kernel.txt> <pid> → a hung-task line for a thread of our
# grin. grin names its threads, so the comm is often not "grin": a tid that is
# still a task of <pid> counts too.
_gne_hung_task_line() {
    local l r='task ([^ :]+):([0-9]+) blocked for more than'
    [[ -s "$1" ]] || return 1
    while IFS= read -r l; do
        [[ "$l" =~ $r ]] || continue
        if [[ "${BASH_REMATCH[1]}" == grin ]] || [[ -n "${2:-}" && -d "/proc/$2/task/${BASH_REMATCH[2]}" ]]; then
            printf '%s' "${l:0:300}"; return 0
        fi
    done < <(grep -aE 'blocked for more than' "$1" 2>/dev/null)
    return 1
}

_gne_r() { GNE_R_CLASS="$1"; GNE_R_SUB="$2"; GNE_R_SIG="$3"; GNE_R_STATUS="$4"; GNE_R_LINE="$5"; }

# gne_classify <bundle> <class_initial> <sub_initial> <pid_alive 0|1>
#              <start_window 0|1> <archive 0|1> [<last_pid>]
# The §8.6 refinement table. Reads start.txt / notable.txt / pane.txt /
# kernel.txt in <bundle> and nothing else, so a harness can feed it files.
# Sets GNE_R_CLASS GNE_R_SUB GNE_R_SIG GNE_R_STATUS (CONFIRMED | SEEN |
# PROVISIONAL) GNE_R_LINE. With no match the class stays the initial one.
# start_window = the current run never answered get_status (failed_start, or a
# restart inside an open outage): only then do generic chain words mean
# `corrupted` — a peer's bad block prints the same words during sync (§4).
# A lean, never a verdict.
gne_classify() {
    local b="$1" ci="$2" si="$3" alive="${4:-0}" sw="${5:-0}" arch="${6:-0}" lpid="${7:-}" hit mmr=""
    local start="$b/start.txt" note="$b/notable.txt" pane="$b/pane.txt" kern="$b/kernel.txt"
    _gne_r "$ci" "$si" "" "" ""

    # 1. A txhashset MMR failed verify while opening — CONFIRMED (2026-09-30).
    #    grin prints it only at start, so it needs no start-window gate. It is
    #    a DEBUG line: at file_log_level=Info only the final error is logged.
    if hit=$(_gne_grep1 'attempting to open (kernel|output|rangeproof) pmmr .*fail \(verify failed\)' "$start" "$note" "$pane"); then
        [[ "${hit,,}" =~ open\ (kernel|output|rangeproof)\ pmmr ]] && mmr="${BASH_REMATCH[1]}"
        _gne_r corrupted "verify_failed${mmr:+:$mmr}" pmmr_verify_failed CONFIRMED "$hit"; return 0
    fi
    # 2. LMDB's own corruption errors, start window only — PROVISIONAL.
    if (( sw )) && hit=$(_gne_grep1 'mdb_corrupted|mdb_page_notfound|mdb_bad_txn|mdb_invalid' "$start" "$pane"); then
        _gne_r corrupted lmdb lmdb_corrupt PROVISIONAL "$hit"; return 0
    fi
    # 3. The kernel OOM killer took OUR grin — CONFIRMED format. Gone pid only.
    if (( ! alive )) && hit=$(_gne_oom_line "$kern" "$lpid"); then
        if [[ "$ci" == failed_start ]]; then _gne_r killed oom_start kernel_oom CONFIRMED "$hit"
        else _gne_r killed oom kernel_oom CONFIRMED "$hit"; fi
        return 0
    fi
    # 4. Generic chain-integrity words, start window only — PROVISIONAL.
    if (( sw )) && hit=$(_gne_grep1 'corrupt|invalid ?root|txhashset.*(invalid|fail|err)' "$start" "$pane"); then
        _gne_r corrupted chain_error chain_integrity PROVISIONAL "$hit"; return 0
    fi
    # 5. A Rust panic. Off the main thread it kills only that thread, so with a
    #    live pid it is a hung sub-reason, not a crash (PROVISIONAL until we
    #    know whether grin builds with panic=abort).
    if hit=$(_gne_grep1 'panicked at' "$pane" "$note"); then
        case "$ci" in
            hung)                     if (( alive )); then _gne_r hung thread_panic panic PROVISIONAL "$hit"; return 0; fi ;;
            crashed|unexplained_stop) if (( ! alive )); then _gne_r crashed panic panic CONFIRMED "$hit"; return 0; fi ;;
            failed_start)             _gne_r failed_start panic panic CONFIRMED "$hit"; return 0 ;;
        esac
    fi
    # 6. Hung on I/O: a kernel hung-task line for one of our threads — PROVISIONAL.
    if [[ "$ci" == hung ]] && hit=$(_gne_hung_task_line "$kern" "$lpid"); then
        _gne_r hung io_stall hung_task PROVISIONAL "$hit"; return 0
    fi
    # 7. Archive compaction inside the window — PROVISIONAL. NOT suppressed: a
    #    compaction hang is a real outage (reference_grin_archive_compaction_storm).
    if [[ "$ci" == hung ]] && (( arch )) && hit=$(_gne_grep1 'compact' "$note"); then
        _gne_r hung compaction compaction PROVISIONAL "$hit"; return 0
    fi
    # 8. grin's own clean-shutdown pair — SEEN 2026-10-03. Which trigger writes
    #    it (Ctrl+C, q, SIGTERM) is still open, so the class stays.
    if [[ "$ci" == unexplained_stop ]] && hit=$(_gne_grep1 'shutdown in progress, please wait' "$note" "$pane") \
        && _gne_grep1 'shutdown complete' "$note" "$pane" >/dev/null; then
        _gne_r unexplained_stop clean_shutdown clean_shutdown SEEN "$hit"; return 0
    fi
    return 0
}

# ── Bundles ──────────────────────────────────────────────────────────────────
# _gne_bundle_mkdir <net> <now> <name_class> → GNE_B_NAME / GNE_B_DIR. rc 1 = none.
_gne_bundle_mkdir() {
    local ed="$GNE_EVENTS_DIR/$1/evidence" base name n=1 cls="${3//[^a-z_]/_}"
    GNE_B_NAME=""; GNE_B_DIR=""
    if [[ ! -d "$ed" ]]; then mkdir -p "$ed" 2>/dev/null; chmod 700 "$ed" 2>/dev/null; fi
    [[ -d "$ed" ]] || return 1
    base="$(date -u -d "@$2" '+%Y%m%dT%H%M%SZ' 2>/dev/null)_${cls:-unknown}"
    [[ "$base" =~ ^[0-9]{8}T ]] || return 1
    # Plain mkdir is the atomic claim (it fails only if the name exists); the
    # mode is set after, so a chmod hiccup can never read as "name taken".
    name="$base"
    while [[ -e "$ed/$name" ]] || ! mkdir -- "$ed/$name" 2>/dev/null; do
        n=$(( n + 1 )); (( n > 9 )) && return 1
        name="$base-$n"
    done
    chmod 700 "$ed/$name" 2>/dev/null || true
    GNE_B_NAME="$name"; GNE_B_DIR="$ed/$name"
    return 0
}

# _gne_bundle_fill <bundle> <net> <node_dir> <pid> <last_pid> <class_initial>
#   <sub_initial> <since> <start_window 0|1> <now> <trigger text>
# The PANE FIRST — it is what the restart destroys — then the cheap host state,
# then the node log (the slow part), classification, chain sizes, summary.
# Sets GNE_R_* via gne_classify. A missing input is a note in a file, never an
# error: a half-filled bundle still beats none.
_gne_bundle_fill() {
    local b="$1" net="$2" dir="$3" pid="$4" lpid="$5" ci="$6" si="$7" since="$8" sw="$9" now="${10}" trig="${11}"
    local alive=0 arch=0 lf f line ts
    [[ -n "$pid" && ( -z "$lpid" || "$pid" == "$lpid" ) ]] && alive=1
    since=$(( ${since:-$now} - 120 ))
    (( since >= now - GNE_LOG_MAX_BACK )) || since=$(( now - GNE_LOG_MAX_BACK ))
    [[ "$(_gne_tv "$dir/grin-server.toml" archive_mode)" == true ]] && arch=1

    _gne_pane_capture "$dir" "$GNE_PANE_LINES" > "$b/pane.txt" 2>&1
    {
        echo "# written by the node's tmux pane (lib/grin_node_control.sh _gnc_node_run_cmd)"
        for f in .grin_last_start .grin_last_exit; do
            line=""; read -r line 2>/dev/null < "$dir/$f" || true
            ts=$(_gne_kv_inline "$line" ts)
            echo "$f: ${line:-(absent)}${ts:+   [$(_gne_utc_ts "$ts")]}"
        done
    } > "$b/exit.txt" 2>&1
    _gne_ps_snapshot "$pid" "$lpid" > "$b/ps.txt" 2>&1
    _gne_host_snapshot "$dir" > "$b/host.txt" 2>&1
    _gne_kernel_lines "$since" > "$b/kernel.txt" 2>&1
    tail -n 20 "$GNE_WATCHDOG_LOG" > "$b/watchdog.txt" 2>/dev/null \
        || echo "(no watchdog log at $GNE_WATCHDOG_LOG)" > "$b/watchdog.txt"
    lf=$(_gne_node_logfile "$dir")
    _gne_log_stream "$lf" "$since" | _gne_log_split "$b" | tail -n "$GNE_LOG_LINES" > "$b/grin-log.txt" 2>/dev/null
    tail -n 2000 "$b/.notable" > "$b/notable.txt" 2>/dev/null || : > "$b/notable.txt"

    gne_classify "$b" "$ci" "$si" "$alive" "$sw" "$arch" "$lpid"
    if [[ "$ci" == failed_start || "$GNE_R_CLASS" == corrupted ]]; then
        _gne_chain_snapshot "$dir" > "$b/chain.txt" 2>&1
    fi
    if [[ -n "$GNE_R_LINE" ]]; then printf '%s\n' "$GNE_R_LINE" > "$b/match.txt"; fi
    _gne_write_summary "$b" "$net" "$dir" "$pid" "$lpid" "$ci" "$since" "$now" "$trig" "$lf"
    _gne_bundle_finish "$b"
    return 0
}

_gne_write_summary() { # <b> <net> <dir> <pid> <lpid> <ci> <since> <now> <trigger> <logfile>
    local b="$1" fl wn idx cnt
    wn=$(_gne_int "$(cat "$b/.window_n" 2>/dev/null)")
    fl=$(_gne_tv "$3/grin-server.toml" file_log_level)
    {
        echo "Grin node event recorder — evidence bundle ${b##*/}"
        echo "=============================================================================="
        echo "network      : $2"
        echo "node dir     : $3"
        echo "captured     : $(_gne_utc_ts "$8")"
        echo "trigger      : $9"
        echo "class        : ${GNE_R_CLASS:-?}   (initial: ${6:-?})"
        echo "sub          : ${GNE_R_SUB:--}"
        echo ""
        echo "LIKELY, NOT A VERDICT. The class is a lean drawn from the files in this"
        echo "bundle (086 design §8.6). Read them before acting on it."
        echo ""
        if [[ -n "$GNE_R_SIG" ]]; then
            echo "matched signature : $GNE_R_SIG ($GNE_R_STATUS)"
            echo "matched line      : $GNE_R_LINE"
        else
            echo "matched signature : none — the class comes from the recorder's own"
            echo "                    observation (exit code, API result, timings)."
        fi
        echo ""
        echo "process      : pid now=${4:-none}   last seen by the recorder=${5:-none}"
        sed -n 's/^\.grin_last_/last /p' "$b/exit.txt" 2>/dev/null | sed 's/^/             : /'
        echo "log window   : from $(_gne_utc_ts "$7") (log-local $(_gne_local_ts "$7")), ${wn:-0} lines;"
        echo "               grin-log.txt keeps the last $GNE_LOG_LINES, start.txt the start window"
        echo "node log     : ${10}"
        if [[ -n "$fl" && ! "$fl" =~ ^(Debug|Trace)$ ]]; then
            echo "log level    : file_log_level=$fl. grin logs the PMMR 'verify failed' lines at"
            echo "               DEBUG, so a corrupted start shows only its final error here."
        fi
        echo ""
        case "$GNE_R_CLASS" in
            corrupted) echo "!! Restarts will NOT fix this: chain_data needs a resync (Script 03 restore"
                       echo "!! or a Script 01 rebuild). chain.txt has the txhashset sizes and the"
                       echo "!! pmmr_hash.bin % 32 check the upstream issue asks for." ;;
            killed)    echo "The kernel or an operator killed grin: kernel.txt and host.txt show memory/swap." ;;
            hung)      echo "The process was alive but its API did not answer: ps.txt has thread states"
                       echo "(D = waiting on disk) and host.txt the pressure counters." ;;
            crashed)   echo "grin exited on its own: pane.txt holds what it printed last." ;;
        esac
        echo ""
        echo "086 log signatures in the window (ERROR/WARN lines; origin is a lean):"
        if [[ -s "$b/.sigcounts" ]] && declare -p DG_SIG_NAME >/dev/null 2>&1; then
            sort -t$'\t' -k2,2nr "$b/.sigcounts" | while IFS=$'\t' read -r idx cnt; do
                printf '  %-18s %7s  %s\n' "${DG_SIG_NAME[$idx]:-?}" "$cnt" "${DG_SIG_ORIGIN[$idx]:-?}"
            done
        else
            echo "  none matched"
        fi
        echo ""
        echo "This bundle is RAW: IP addresses and hostnames are NOT masked. Share it through"
        echo "086's export (it masks them), not by copying the directory."
    } > "$b/summary.txt" 2>/dev/null
    return 0
}

# Byte cap (EVIDENCE_BUNDLE_MB: the log files shrink from the front, the newest
# lines are kept), scratch files removed, manifest written, modes set.
_gne_bundle_finish() {
    local b="$1" cap kb over f sz trunc=no wn
    wn=$(_gne_int "$(cat "$b/.window_n" 2>/dev/null)")
    if [[ -n "$wn" ]] && (( wn > GNE_LOG_LINES )); then trunc=yes; fi
    rm -f "$b/.sigs" "$b/.sigcounts" "$b/.window_n" "$b/.notable" 2>/dev/null || true
    cap=$(( ${GNE_C_EVIDENCE_BUNDLE_MB:-50} * 1024 ))
    kb=$(_gne_int "$(du -sk "$b" 2>/dev/null | cut -f1)")
    if [[ -n "$kb" ]] && (( kb > cap )); then
        over=$(( (kb - cap) * 1024 + 65536 ))
        for f in grin-log.txt notable.txt start.txt pane.txt kernel.txt; do
            (( over > 0 )) || break
            [[ -f "$b/$f" ]] || continue
            sz=$(stat -c %s "$b/$f" 2>/dev/null || echo 0)
            if (( sz > over )); then
                tail -c "$(( sz - over ))" "$b/$f" > "$b/.cut" 2>/dev/null && mv -f "$b/.cut" "$b/$f" 2>/dev/null
                over=0
            else
                : > "$b/$f"; over=$(( over - sz ))
            fi
            trunc=yes
        done
        rm -f "$b/.cut" 2>/dev/null || true
    fi
    {
        for f in "$b"/*; do
            [[ -f "$f" ]] && printf '%-14s %10s bytes\n' "${f##*/}" "$(stat -c %s "$f" 2>/dev/null)"
        done
        echo "truncated=$trunc"
    } > "$b/manifest.txt" 2>/dev/null
    chmod 600 "$b"/* 2>/dev/null || true
    chmod 700 "$b" 2>/dev/null || true
    return 0
}

# _gne_capture <net> <dir> <pid> <last_pid> <class_initial> <sub_initial>
#   <since> <start_window> <keep 0|1> <now> <trigger> <rename 0|1>
# mkdir + fill + classify in one call (the check path). keep=0 is the 5-minute
# rate limit: the bundle survives only if it shows `corrupted`. rename=1 renames
# the dir to the refined class. rc 0 = kept · 2 = classified, discarded · 1 = none.
_gne_capture() {
    GNE_R_CLASS="$5"; GNE_R_SUB="$6"; GNE_R_SIG=""; GNE_R_STATUS=""; GNE_R_LINE=""
    _gne_bundle_mkdir "$1" "${10}" "$5" || { echo "grin-node-events: cannot create an evidence bundle for $1" >&2; return 1; }
    _gne_bundle_fill "$GNE_B_DIR" "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "${10}" "${11}"
    if [[ "$9" != 1 && "$GNE_R_CLASS" != corrupted ]]; then
        rm -rf -- "$GNE_B_DIR" 2>/dev/null || true
        GNE_B_NAME=""; GNE_B_DIR=""
        return 2
    fi
    if [[ "${12}" == 1 && "$GNE_R_CLASS" != "$5" ]]; then
        local nn="${GNE_B_NAME:0:16}_${GNE_R_CLASS//[^a-z_]/_}" ed="${GNE_B_DIR%/*}"
        if [[ ! -e "$ed/$nn" ]] && mv -- "$GNE_B_DIR" "$ed/$nn" 2>/dev/null; then
            GNE_B_NAME="$nn"; GNE_B_DIR="$ed/$nn"
        fi
    fi
    _gne_prune_evidence "$GNE_B_DIR"
    return 0
}

# _gne_prune_evidence [keep_dir] — EVIDENCE_DAYS first, then EVIDENCE_TOTAL_MB
# across both nets, oldest first; a bundle that a `corrupted` ledger line names
# goes last. Deletes ONLY dirs under <net>/evidence/ whose name matches the
# bundle pattern (never a symlink), and never <keep_dir> (the one just written).
_gne_prune_evidence() {
    local keep="${1:-}" now cutoff net ed b name kb total=0 prot=" " line cap pass r n k p
    local -a rows=() sorted=()
    now=$(_gne_now)
    cutoff=$(date -u -d "@$(( now - ${GNE_C_EVIDENCE_DAYS:-180} * 86400 ))" '+%Y%m%dT%H%M%SZ' 2>/dev/null) || return 0
    [[ -n "$cutoff" ]] || return 0
    for net in "${GNE_NETS[@]}"; do
        ed="$GNE_EVENTS_DIR/$net/evidence"
        [[ -d "$ed" ]] || continue
        while IFS= read -r line; do
            [[ "$line" =~ \"evidence\":\"([^\"]+)\" ]] && prot+="$net/${BASH_REMATCH[1]} "
        done < <(grep -h '"class":"corrupted"' "$GNE_EVENTS_DIR/$net/ledger.jsonl" 2>/dev/null)
        for b in "$ed"/*; do
            [[ -d "$b" && ! -L "$b" && "$b" != "$keep" ]] || continue
            name="${b##*/}"
            [[ "$name" =~ $_GNE_BUNDLE_RE ]] || continue
            if [[ "$name" < "$cutoff" ]]; then
                rm -rf -- "$b" 2>/dev/null || echo "grin-node-events: cannot prune $b" >&2
                continue
            fi
            kb=$(_gne_int "$(du -sk -- "$b" 2>/dev/null | cut -f1)")
            total=$(( total + ${kb:-0} ))
            rows+=("$name|${kb:-0}|$b|$net")
        done
    done
    [[ -n "$keep" && -d "$keep" ]] && total=$(( total + $(_gne_int "$(du -sk -- "$keep" 2>/dev/null | cut -f1)") + 0 ))
    cap=$(( ${GNE_C_EVIDENCE_TOTAL_MB:-500} * 1024 ))
    (( total > cap )) || return 0
    (( ${#rows[@]} )) || return 0
    mapfile -t sorted < <(printf '%s\n' "${rows[@]}" | sort)
    for pass in 0 1; do
        for r in "${sorted[@]}"; do
            (( total > cap )) || return 0
            IFS='|' read -r n k p net <<< "$r"
            if (( pass == 0 )) && [[ "$prot" == *" $net/$n "* ]]; then continue; fi
            [[ -d "$p" ]] || continue
            if rm -rf -- "$p" 2>/dev/null; then total=$(( total - k )); fi
        done
    done
    return 0
}

# _gne_refine_events <class> <sub> — the evidence refined the class of the
# outage gne_decide just opened: rewrite the class on its `open`/`cont` records
# (class_initial keeps the observation-only class) and on the outage outputs.
_gne_refine_events() {
    local i ev st cl ci sb by sa du oc rc gp rs
    for i in "${!GNE_O_EV[@]}"; do
        IFS='|' read -r ev st cl ci sb by sa du oc rc gp rs <<< "${GNE_O_EV[$i]}"
        case "$oc" in
            open) cl="$1"; sb="$2" ;;
            cont) cl="$1" ;;
            *)    continue ;;
        esac
        GNE_O_EV[$i]="$ev|$st|$cl|$ci|$sb|$by|$sa|$du|$oc|$rc|$gp|$rs"
    done
    GNE_O_OUTAGE_CLASS="$1"
    if [[ "$GNE_O_STATE" == down ]]; then GNE_O_CLASS="$1"; GNE_O_SUB="$2"; fi
    return 0
}

# =============================================================================
# ALERTS (Part 4 — §8.10)
# =============================================================================
# gne_check_net DECIDES each alert and CLAIMS its debounce key in status.json's
# alerted_for, under the lock; gne_worker_check DELIVERS after releasing it.
# Claim-then-send is at-most-once: a send that dies half-way (unit timeout,
# reboot) is lost rather than repeated every 30 s. Delivery holding the lock
# would make the watchdog's capture (15 s lock wait) give up on its evidence.
# The body carries net, class, sub, duration, a bundle path under
# $GNE_EVENTS_DIR and the ONE matched signature line, scrubbed. Nothing else
# from a log, no IP, no secret.
_GNE_ALERTS_ON=0
_GNE_ALERTED="[]"
_GNE_PA_SEV=(); _GNE_PA_PRIO=(); _GNE_PA_TAGS=(); _GNE_PA_SUBJ=(); _GNE_PA_BODY=()
_GNE_PA_BOOT_NETS=""
_GNE_ALERT_LOG_FN=_gne_alert_log

_gne_alerts_reset() {
    _GNE_PA_SEV=(); _GNE_PA_PRIO=(); _GNE_PA_TAGS=(); _GNE_PA_SUBJ=(); _GNE_PA_BODY=()
    _GNE_PA_BOOT_NETS=""
    return 0
}
_gne_alert_push() { # <severity> <ntfy priority> <ntfy tags> <subject> <body>
    _GNE_PA_SEV+=("$1"); _GNE_PA_PRIO+=("$2"); _GNE_PA_TAGS+=("$3"); _GNE_PA_SUBJ+=("$4"); _GNE_PA_BODY+=("$5")
    return 0
}
_gne_alert_log()        { echo "grin-node-events: alert: $*" >&2; return 0; }
_gne_alert_log_stdout() { echo "  $*"; return 0; }

# Configured channel names ("" = none, or the delivery lib is missing). The
# channel variables are LOCAL here and in _gne_alerts_deliver — never exported.
_gne_alert_channels() {
    declare -F gas_channels >/dev/null 2>&1 || return 0
    local NTFY_URL="${GNE_C_NTFY_URL:-}" TG_BOT_TOKEN="${GNE_C_TG_BOT_TOKEN:-}" TG_CHAT_ID="${GNE_C_TG_CHAT_ID:-}" \
          MAIL_TO="${GNE_C_MAIL_TO:-}" NOSTR_SK="${GNE_C_NOSTR_SK:-}" NOSTR_RELAY="${GNE_C_NOSTR_RELAY:-}"
    gas_channels
}

_gne_fmt_dur() { # <seconds> → "45 s" / "12 min" / "3 h 5 min" / "2 d 4 h"
    local s; s=$(_gne_int "${1:-}")
    if [[ -z "$s" ]]; then printf 'an unknown time'; return 0; fi
    if   (( s < 60 ));    then printf '%d s' "$s"
    elif (( s < 3600 ));  then printf '%d min' $(( s / 60 ))
    elif (( s < 86400 )); then printf '%d h %d min' $(( s / 3600 )) $(( s % 3600 / 60 ))
    else                       printf '%d d %d h' $(( s / 86400 )) $(( s % 86400 / 3600 ))
    fi
    return 0
}

# _gne_alert_scrub <log line> → one printable line ≤ 240 chars: IPv4/IPv6 fully
# masked (an alert leaves the box, so 086's keep-the-/24 mask is not enough),
# absolute paths cut to their last part, key=secret values and long tokens
# redacted. The grin timestamp ("HH:MM:SS") and Rust paths (a::b) survive.
_gne_alert_scrub() {
    local s="${1:0:600}"
    s="${s//[^[:print:]]/ }"
    s=$(printf '%s\n' "$s" | sed -E \
        -e 's/\b[0-9]{1,3}(\.[0-9]{1,3}){3}\b/x.x.x.x/g' \
        -e 's/\[[0-9a-fA-F.]*:[0-9a-fA-F:.]*\]/[ipv6]/g' \
        -e 's/(^|[^0-9A-Za-z_:])[0-9a-fA-F]{1,4}(:[0-9a-fA-F]{1,4}){4,7}([^0-9A-Za-z_:]|$)/\1ipv6\3/g' \
        -e 's/(^|[^0-9A-Za-z_:])[0-9a-fA-F]{1,4}(:[0-9a-fA-F]{1,4})*::([0-9a-fA-F]{1,4}(:[0-9a-fA-F]{1,4})*)?([^0-9A-Za-z_:]|$)/\1ipv6\5/g' \
        -e 's#(/[A-Za-z0-9._-]+)+/([A-Za-z0-9._-]+)#.../\2#g' \
        -e "s/((pass(word)?|passwd|token|secret|api_?key|auth)[\"']?[[:space:]]*[=:][[:space:]]*[\"']?)[^[:space:]\"'&,;]+/\1<redacted>/Ig" \
        -e 's/[A-Za-z0-9+=_-]{32,}/<redacted>/g' 2>/dev/null)
    printf '%s' "${s:0:240}"
}

_gne_alerted_has() { [[ "$_GNE_ALERTED" == *"\"$1\""* ]]; }

# _gne_alerted_add <key> [protect] — append to _GNE_ALERTED, keep the last 20.
# Keys containing <protect> (the open outage's id) are never the ones dropped:
# a long restart loop adds an hourly loop: key, and evicting the outage's own
# down: key would re-send its DOWN.
_gne_alerted_add() {
    local inner="${_GNE_ALERTED#[}" it drop
    inner="${inner%]}"
    local -a items=() keep=()
    IFS=, read -ra items <<< "$inner"
    items+=("\"$1\"")
    drop=$(( ${#items[@]} - 20 ))
    for it in "${items[@]}"; do
        if (( drop > 0 )) && [[ -z "${2:-}" || "$it" != *"$2"* ]]; then drop=$(( drop - 1 )); continue; fi
        keep+=("$it")
    done
    local IFS=,
    _GNE_ALERTED="[${keep[*]}]"
    return 0
}

# _gne_alerts_decide <net> <now> <alerted json> <open outage id> <outage start>
#   <outage class> <sub> <evidence name> <closed outage id> <closed duration>
#   <closing event> <closed class> <boot clean_shutdown> <previous state> <ledger>
# Pushes this net's alerts and leaves the updated key list in _GNE_ALERTED.
_gne_alerts_decide() {
    local net="$1" now="$2" oid="$4" ostart="$5" oclass="$6" osub="$7" evn="$8"
    local cloid="$9" cldu="${10}" clev="${11}" clclass="${12}" bootcs="${13}" pstate="${14}" lfile="${15}"
    local edir="$GNE_EVENTS_DIR/$net/evidence" match="" ml="" evp="" body subj lean
    _GNE_ALERTED="${3:-[]}"
    [[ "$_GNE_ALERTED" == \[*\] ]] || _GNE_ALERTED="[]"
    if [[ -n "$evn" && "$evn" =~ $_GNE_BUNDLE_RE ]]; then
        evp="$edir/$evn"
        if [[ -r "$evp/match.txt" ]]; then
            read -r ml 2>/dev/null < "$evp/match.txt" || true
            [[ -n "$ml" ]] && match=$(_gne_alert_scrub "$ml")
        fi
    fi
    lean="${oclass:-unknown}${osub:+ ($osub)} — a lean, not a verdict"

    # CORRUPTED: immediately, HIGH. It stands in for the same outage's DOWN (two
    # pages for one event is noise), so down: is claimed too and the RECOVERY
    # still follows it.
    if [[ -n "$oid" && "$oclass" == corrupted ]] && ! _gne_alerted_has "corrupted:$oid"; then
        body="The $net node failed with class $lean."
        body+=$'\n'"Restarts will not fix this — chain_data needs a resync; evidence: ${evp:-none captured}"
        [[ -n "$match" ]] && body+=$'\n'"Matched: $match"
        _gne_alert_push HIGH urgent rotating_light "$net chain_data CORRUPTED" "$body"
        _gne_alerted_add "corrupted:$oid" "$oid"
        _gne_alerted_has "down:$oid" || _gne_alerted_add "down:$oid" "$oid"
    fi

    # RESTART LOOP: ≥ ALERT_LOOP_COUNT watchdog restarts inside the window. The
    # key is the hour of the COUNT-th restart in the window, so a loop that keeps
    # going is re-reported at most about once an hour.
    if [[ -f "$lfile" ]]; then
        local -a lts=()
        local line ts reason="" from re_ts='"ts":([0-9]+)' re_r='"reason":"(([^"\\]|\\.)*)"'
        from=$(( now - GNE_C_ALERT_LOOP_WINDOW_MIN * 60 ))
        while IFS= read -r line; do
            [[ "$line" == *'"event":"restart_by_watchdog"'* && "$line" =~ $re_ts ]] || continue
            ts="${BASH_REMATCH[1]}"
            (( ts >= from && ts <= now )) || continue
            lts+=("$ts")
            if [[ "$line" =~ $re_r ]]; then reason="${BASH_REMATCH[1]}"; else reason=""; fi
        done < <(tail -n 400 "$lfile" 2>/dev/null)
        if (( ${#lts[@]} >= GNE_C_ALERT_LOOP_COUNT )); then
            local key="loop:$net:$(( lts[GNE_C_ALERT_LOOP_COUNT - 1] / 3600 ))"
            if ! _gne_alerted_has "$key"; then
                reason="${reason//\\\"/\"}"; reason="${reason//\\\\/\\}"
                body="The sync watchdog restarted the $net node ${#lts[@]} times in the last $GNE_C_ALERT_LOOP_WINDOW_MIN min."
                [[ -n "$reason" ]] && body+=$'\n'"Latest watchdog reason: $reason"
                [[ -n "$oid" ]] && body+=$'\n'"Open outage: class $lean, since $(_gne_utc_ts "$ostart")."
                body+=$'\n'"If the class is corrupted, restarts will not fix it."
                _gne_alert_push HIGH urgent rotating_light "$net restart LOOP" "$body"
                _gne_alerted_add "$key" "$oid"
            fi
        fi
    fi

    # DOWN: once the open outage has lasted ALERT_DOWN_AFTER_MIN (from its
    # backdated start). A shorter outage sends nothing, and so no RECOVERY.
    if [[ -n "$oid" && "$ostart" =~ ^[0-9]+$ ]] && (( now - ostart >= GNE_C_ALERT_DOWN_AFTER_MIN * 60 )) \
        && ! _gne_alerted_has "down:$oid"; then
        body="The $net node is DOWN: $lean."
        body+=$'\n'"Down since $(_gne_utc_ts "$ostart") ($(_gne_fmt_dur $(( now - ostart ))))."
        [[ -n "$evp" ]] && body+=$'\n'"Evidence: $evp"
        [[ -n "$match" ]] && body+=$'\n'"Matched: $match"
        _gne_alert_push MEDIUM high warning "$net node DOWN ($oclass)" "$body"
        _gne_alerted_add "down:$oid" "$oid"
    fi

    # RECOVERY: the event that closed an outage whose DOWN (or CORRUPTED) went out.
    if [[ -n "$cloid" ]] && _gne_alerted_has "down:$cloid" && ! _gne_alerted_has "up:$cloid"; then
        case "$clev" in
            up)   subj="$net node back UP after $(_gne_fmt_dur "$cldu")"
                  body="The $net node answers get_status again. The outage (class ${clclass:-unknown}) lasted $(_gne_fmt_dur "$cldu")." ;;
            boot) subj="$net outage ended by a host reboot"
                  body="The host rebooted during the $net outage (class ${clclass:-unknown}); it is counted up to the reboot: $(_gne_fmt_dur "$cldu"). Watch the next start." ;;
            *)    subj="$net outage closed ($clev)"
                  body="The $net outage (class ${clclass:-unknown}) was closed by a '$clev' event after $(_gne_fmt_dur "$cldu")." ;;
        esac
        _gne_alert_push INFO default white_check_mark "$subj" "$body"
        _gne_alerted_add "up:$cloid" "$oid"
    fi

    # UNCLEAN HOST STOP: one host event — the nets are merged into ONE alert at
    # delivery; each net still claims the key in its own status.json.
    if [[ "$bootcs" == false && "$pstate" == up && "${GNE_C_ALERT_UNCLEAN_BOOT:-1}" == 1 ]] \
        && ! _gne_alerted_has "boot:$_GNE_CTX_BOOT"; then
        _GNE_PA_BOOT_NETS+="$net "
        _gne_alerted_add "boot:$_GNE_CTX_BOOT" "$oid"
    fi
    return 0
}

# _gne_alerts_deliver — send everything pushed this run. Bounded (§8.10):
# GNE_ALERT_CHANNEL_S per channel, GNE_ALERT_BUDGET_S for the whole run; a
# channel whose turn comes later is skipped and logged. rc 1 = some alert
# reached no channel.
_gne_alerts_deliver() {
    local i rc=0 now
    if [[ -n "$_GNE_PA_BOOT_NETS" ]]; then
        _gne_alert_push MEDIUM default warning "host rebooted WITHOUT a clean shutdown" \
            "The host restarted without a clean shutdown while these nodes were up: ${_GNE_PA_BOOT_NETS% }."$'\n'"An unclean stop can corrupt chain_data (it preceded a kernel PMMR verify failure on grin 5.5.1). If a node then fails to start, the recorder reports it."
        _GNE_PA_BOOT_NETS=""
    fi
    (( ${#_GNE_PA_SUBJ[@]} )) || return 0
    if ! declare -F gas_send >/dev/null 2>&1; then
        echo "grin-node-events: $GNE_ALERT_LIB missing — ${#_GNE_PA_SUBJ[@]} alert(s) NOT sent; re-install from 086." >&2
        _gne_alerts_reset
        return 1
    fi
    local NTFY_URL="${GNE_C_NTFY_URL:-}" TG_BOT_TOKEN="${GNE_C_TG_BOT_TOKEN:-}" TG_CHAT_ID="${GNE_C_TG_CHAT_ID:-}" \
          MAIL_TO="${GNE_C_MAIL_TO:-}" NOSTR_SK="${GNE_C_NOSTR_SK:-}" NOSTR_RELAY="${GNE_C_NOSTR_RELAY:-}"
    local GAS_TITLE_PREFIX="Grin node events" GAS_LOG_FN="$_GNE_ALERT_LOG_FN" GAS_MAX_TIME="$GNE_ALERT_CHANNEL_S" \
          GAS_CMD_TIMEOUT=1 GAS_HIDE_SECRETS=1 GAS_PRIORITY="" GAS_NTFY_TAGS="" GAS_DEADLINE
    printf -v now '%(%s)T' -1
    GAS_DEADLINE=$(( now + GNE_ALERT_BUDGET_S ))
    for i in "${!_GNE_PA_SUBJ[@]}"; do
        GAS_PRIORITY="${_GNE_PA_PRIO[$i]}"; GAS_NTFY_TAGS="${_GNE_PA_TAGS[$i]}"
        "$_GNE_ALERT_LOG_FN" "[${_GNE_PA_SEV[$i]}] ${_GNE_PA_SUBJ[$i]}"
        gas_send "${_GNE_PA_SEV[$i]}" "${_GNE_PA_SUBJ[$i]}" "${_GNE_PA_BODY[$i]}" || rc=1
    done
    _gne_alerts_reset
    return "$rc"
}

# =============================================================================
# THE CHECK (worker `check`)
# =============================================================================
# Per-run context shared by both nets.
_GNE_CTX_BOOT=""; _GNE_CTX_BTIME=""; _GNE_CTX_CLK=""; _GNE_CTX_CRON=""; _GNE_CTX_CLEAN=""

# gne_check_net <net> — one read-only check, one status rewrite, ledger lines
# for the transitions. Caller holds the lock.
gne_check_net() {
    local net="$1" now dir="" reg=0 netdir sfile lfile prev=""
    now=$(_gne_now)
    netdir="$GNE_EVENTS_DIR/$net"; sfile="$netdir/status.json"; lfile="$netdir/ledger.jsonl"
    [[ -f "$sfile" ]] && read -r prev 2>/dev/null < "$sfile"

    if [[ " $GNE_C_ENABLED_NETS " == *" $net "* ]] && dir=$(gnc_resolve_node_dir "$net"); then reg=1; else dir=""; fi
    # A net never registered and never observed leaves no trace.
    if (( ! reg )) && [[ -z "$prev" ]]; then return 0; fi
    mkdir -p -m 755 "$netdir" 2>/dev/null || { echo "grin-node-events: cannot create $netdir" >&2; return 1; }
    mkdir -p -m 700 "$netdir/evidence" 2>/dev/null || true

    # ── inputs ──
    local port pid="" pid_start="" api=bad url host addr sf ls_ts="" ex_ts="" ex_rc=""
    port=$(gnc_node_api_port "$net")
    if (( reg )); then
        pid=$(_gne_node_pid "$dir" "$port")
        [[ -n "$pid" ]] && pid_start=$(_gne_pid_start "$pid" "$_GNE_CTX_BTIME" "$_GNE_CTX_CLK")
        addr=$(_gne_tv "$dir/grin-server.toml" api_http_addr)
        [[ -n "$addr" ]] || addr="127.0.0.1:$port"
        host="${addr%:*}"; [[ "$host" == 0.0.0.0 || -z "$host" ]] && host=127.0.0.1
        url="http://$host:${addr##*:}/v2/owner"
        if sf=$(_gne_secret_file "$dir" "$net"); then api=$(_gne_probe "$url" "$sf"); else api=no_secret; fi
        ls_ts=$(_gne_kv_file "$dir/.grin_last_start" ts)
        ex_ts=$(_gne_kv_file "$dir/.grin_last_exit" ts)
        ex_rc=$(_gne_kv_file "$dir/.grin_last_exit" rc)
    fi
    local mfile="$netdir/planned_stop" mline="" m=0
    if [[ -f "$mfile" ]]; then
        m=1; read -r mline 2>/dev/null < "$mfile" || true; mline="${mline:0:512}"
    fi
    local mreason=""
    [[ "$mline" =~ \ reason=(.*)$ ]] && mreason="${BASH_REMATCH[1]}"

    # ── decide ──
    GNE_I_NOW="$now"; GNE_I_CADENCE="$GNE_CADENCE"; GNE_I_STRIKES_NEED="$GNE_C_DOWN_STRIKES"
    GNE_I_START_TIMEOUT_S=$(( GNE_C_START_TIMEOUT_MIN * 60 ))
    GNE_I_MARKER_TTL_S=$(( GNE_C_MARKER_TTL_MIN * 60 )); GNE_I_GAP_FACTOR="$GNE_C_GAP_FACTOR"
    GNE_I_BOOT_ID="$_GNE_CTX_BOOT"; GNE_I_BTIME="$_GNE_CTX_BTIME"
    GNE_I_AUTOSTART_DELAY=$(_gne_autostart_delay "$net" "$_GNE_CTX_CRON")
    GNE_I_REGISTERED="$reg"; GNE_I_PID="$pid"; GNE_I_PID_START="$pid_start"; GNE_I_API="$api"
    GNE_I_LAST_START_TS="$ls_ts"; GNE_I_LAST_EXIT_TS="$ex_ts"; GNE_I_LAST_EXIT_RC="$ex_rc"
    GNE_I_MARKER="$m"; GNE_I_MARKER_TS=$(_gne_kv_inline "$mline" ts); GNE_I_MARKER_BY=$(_gne_kv_inline "$mline" by)
    GNE_I_MARKER_PID=$(_gne_kv_inline "$mline" pid); GNE_I_MARKER_REASON="$mreason"
    GNE_I_P_STATE=$(_gne_jget "$prev" state);        GNE_I_P_BOOT_ID=$(_gne_jget "$prev" boot_id)
    GNE_I_P_LAST_CHECK=$(_gne_jget "$prev" last_check); GNE_I_P_SINCE=$(_gne_jget "$prev" since)
    GNE_I_P_CLASS=$(_gne_jget "$prev" class);        GNE_I_P_SUB=$(_gne_jget "$prev" sub)
    GNE_I_P_SUB_STATE=$(_gne_jget "$prev" sub_state); GNE_I_P_STRIKES=$(_gne_jget "$prev" strikes)
    GNE_I_P_FIRST_FAIL=$(_gne_jget "$prev" first_fail_ts); GNE_I_P_LAST_PID=$(_gne_jget "$prev" last_pid)
    GNE_I_P_NODE_STARTED=$(_gne_jget "$prev" node_started_at); GNE_I_P_START_REF=$(_gne_jget "$prev" start_ref)
    GNE_I_P_OUTAGE_ID=$(_gne_jget "$prev" outage_id); GNE_I_P_OUTAGE_START=$(_gne_jget "$prev" outage_started_at)
    GNE_I_P_OUTAGE_CLASS=$(_gne_jget "$prev" outage_class); GNE_I_P_LAST_OUTAGE_END=$(_gne_jget "$prev" last_outage_end)
    GNE_I_P_PENDING_BY=$(_gne_jget "$prev" pending_restart_by); GNE_I_P_PENDING_TS=$(_gne_jget "$prev" pending_restart_ts)
    gne_decide

    # ── grin version (cached per binary + mtime) ──
    local gv_key gv="" vk
    gv_key=$(_gne_jget "$prev" grin_version_key); gv=$(_gne_jget "$prev" grin_version)
    if (( reg )) && [[ -x "$dir/grin" ]]; then
        vk=$(_gne_grin_version "$dir/grin" "$gv_key" "$gv")
        gv_key="${vk%%$'\t'*}"; gv="${vk#*$'\t'}"
    fi

    # ── evidence for a NEW outage (Part 3, §8.9) ──
    # Captured BEFORE the ledger lines are written, so the `down` line carries
    # the refined class (class_initial keeps the observation-only one) and the
    # bundle name. The check is not under the watchdog's 20 s budget.
    local e ev st cl ci sb by sa du oc rc gp rs
    local cap_ts cap_n last_ev ev_name="" ci_open="" si_open=""
    cap_ts=$(_gne_int "$(_gne_jget "$prev" last_capture_ts)")
    cap_n=$(_gne_int "$(_gne_jget "$prev" outage_captures)")
    last_ev=$(_gne_jget "$prev" last_evidence)
    for e in "${GNE_O_EV[@]}"; do
        IFS='|' read -r ev st cl ci sb by sa du oc rc gp rs <<< "$e"
        if [[ "$oc" == open ]]; then ci_open="$ci"; si_open="$sb"; fi
    done
    if [[ -n "$ci_open" ]] && (( reg )); then
        local since sw=0 keep=1 crc
        since=$(_gne_int "$(_gne_jget "$prev" last_ok)")
        if [[ "$ci_open" == failed_start ]]; then
            sw=1
            [[ -n "$GNE_I_P_START_REF" ]] && since=$(_gne_int "$GNE_I_P_START_REF")
        fi
        [[ -n "$since" ]] || since=$(( now - 1800 ))
        if [[ -n "$cap_ts" ]] && (( now - cap_ts < GNE_CAPTURE_MIN_GAP )); then keep=0; fi
        _gne_capture "$net" "$dir" "$pid" "$GNE_I_P_LAST_PID" "$ci_open" "$si_open" "$since" "$sw" \
            "$keep" "$now" "outage opened (initial class $ci_open)" 1
        crc=$?
        if (( crc == 0 || crc == 2 )); then _gne_refine_events "$GNE_R_CLASS" "$GNE_R_SUB"; fi
        if (( crc == 0 )); then ev_name="$GNE_B_NAME"; last_ev="$ev_name"; cap_ts="$now"; fi
    fi

    # ── ledger lines ──
    local oid cs evn ev_out_id="" cur_oid="${GNE_I_P_OUTAGE_ID:-}"
    local a_cl_oid="" a_cl_du="" a_cl_ev="" a_cl_class="" a_boot_cs=""
    _GNE_ID_TS=$(_gne_int "$(_gne_jget "$prev" last_id_ts)"); _GNE_ID_SEQ=$(_gne_int "$(_gne_jget "$prev" last_id_seq)")
    for e in "${GNE_O_EV[@]}"; do
        IFS='|' read -r ev st cl ci sb by sa du oc rc gp rs <<< "$e"
        _gne_next_id "$net" "$now"
        evn=""
        case "$oc" in
            open)       oid="$_GNE_ID"; cur_oid="$_GNE_ID"; ev_out_id="$_GNE_ID"; evn="$ev_name" ;;
            close|cont) oid="$cur_oid" ;;
            *)          oid="" ;;
        esac
        cs=null
        if [[ "$ev" == boot ]]; then
            [[ -n "$_GNE_CTX_CLEAN" ]] || _GNE_CTX_CLEAN=$(_gne_clean_shutdown)
            cs="$_GNE_CTX_CLEAN"
        fi
        _gne_append_ledger "$lfile" "$(_gne_ledger_json "$net" "$now" "$_GNE_ID" "$ev" "$st" "$cl" "$ci" "$sb" \
            "$oid" "$sa" "$du" "$pid" "$GNE_I_P_LAST_PID" "$rc" "$by" "$rs" "$evn" "$gv" "$cs" "$gp")" || true
        if [[ "$oc" == close ]]; then a_cl_oid="$cur_oid"; a_cl_du="$du"; a_cl_ev="$ev"; a_cl_class="$cl"; cur_oid=""; fi
        if [[ "$ev" == boot ]]; then a_boot_cs="$cs"; fi
    done
    local o_id="$GNE_O_OUTAGE_ID"
    [[ "$o_id" == NEW ]] && o_id="$ev_out_id"
    # Watchdog-restart bundles are counted per outage (capture enforces the cap).
    if [[ -z "$o_id" || "$o_id" != "${GNE_I_P_OUTAGE_ID:-}" ]]; then cap_n=0; fi

    # ── marker consumption: only if it is still the line we read ──
    if [[ "$GNE_O_CONSUME_MARKER" == 1 && -f "$mfile" ]]; then
        local mnow=""; read -r mnow 2>/dev/null < "$mfile" || true
        if [[ "${mnow:0:512}" == "$mline" ]]; then rm -f "$mfile" 2>/dev/null || true; fi
    fi

    # ── alerts (Part 4, §8.10): decide and claim here; delivered after the lock ──
    local alerted='[]' re='"alerted_for":(\[[^]]*\])'
    [[ "$prev" =~ $re ]] && alerted="${BASH_REMATCH[1]}"
    if (( _GNE_ALERTS_ON )); then
        # The open outage's bundle: this run's, or the last one if it was taken
        # during this outage (a watchdog capture, or its corrupted reclass).
        local a_ev=""
        if [[ -n "$o_id" ]]; then
            if [[ -n "$ev_name" ]]; then a_ev="$ev_name"
            elif [[ -n "$last_ev" && -n "$cap_ts" && "$GNE_O_OUTAGE_START" =~ ^[0-9]+$ ]] && (( cap_ts >= GNE_O_OUTAGE_START )); then
                a_ev="$last_ev"
            fi
        fi
        _gne_alerts_decide "$net" "$now" "$alerted" "$o_id" "$GNE_O_OUTAGE_START" "$GNE_O_OUTAGE_CLASS" \
            "$GNE_O_SUB" "$a_ev" "$a_cl_oid" "$a_cl_du" "$a_cl_ev" "$a_cl_class" "$a_boot_cs" \
            "${GNE_I_P_STATE:-}" "$lfile"
        alerted="$_GNE_ALERTED"
    fi

    # ── status.json (one line; scalar keys first, open_outage last) ──
    local last_ok; last_ok=$(_gne_jget "$prev" last_ok)
    [[ "$api" == ok ]] && last_ok="$now"
    # Like last_pid: while a strike is pending on a vanished pid, keep the old
    # start time, or the tipping check cannot tie .grin_last_exit to it (§8.3).
    local ns_out="$pid_start"
    if [[ -z "$pid" && "${GNE_O_STRIKES:-0}" != 0 ]]; then ns_out="$GNE_I_P_NODE_STARTED"; fi
    local js
    js="{\"v\":1,\"net\":$(_gne_js "$net"),\"updated\":$now,\"recorder_version\":$(_gne_js "$GNE_RECORDER_VERSION")"
    js+=",\"boot_id\":$(_gne_js "$_GNE_CTX_BOOT"),\"state\":$(_gne_js "$GNE_O_STATE"),\"class\":$(_gne_js "$GNE_O_CLASS")"
    js+=",\"sub\":$(_gne_js "$GNE_O_SUB"),\"sub_state\":$(_gne_js "$GNE_O_SUB_STATE"),\"since\":$(_gne_jn "$GNE_O_SINCE")"
    js+=",\"up_since\":$(_gne_jn "$GNE_O_UP_SINCE"),\"node_started_at\":$(_gne_jn "$ns_out"),\"pid\":$(_gne_jn "$pid")"
    js+=",\"last_pid\":$(_gne_jn "$GNE_O_LAST_PID"),\"grin_version\":$(_gne_js "$gv"),\"grin_version_key\":$(_gne_js "$gv_key")"
    js+=",\"node_dir\":$(_gne_js "$dir"),\"last_api\":$(_gne_js "$api"),\"last_ok\":$(_gne_jn "$last_ok")"
    js+=",\"last_check\":$now,\"strikes\":$(_gne_jn "$GNE_O_STRIKES"),\"first_fail_ts\":$(_gne_jn "$GNE_O_FIRST_FAIL")"
    js+=",\"start_ref\":$(_gne_jn "$GNE_O_START_REF"),\"last_outage_end\":$(_gne_jn "$GNE_O_LAST_OUTAGE_END")"
    js+=",\"outage_id\":$(_gne_js "$o_id"),\"outage_started_at\":$(_gne_jn "$GNE_O_OUTAGE_START")"
    js+=",\"outage_class\":$(_gne_js "$GNE_O_OUTAGE_CLASS")"
    js+=",\"pending_restart_by\":$(_gne_js "$GNE_O_PENDING_BY"),\"pending_restart_ts\":$(_gne_jn "$GNE_O_PENDING_TS")"
    js+=",\"last_capture_ts\":$(_gne_jn "$cap_ts"),\"outage_captures\":$(_gne_jn "${cap_n:-0}")"
    js+=",\"last_evidence\":$(_gne_js "$(_gne_clean_word "$last_ev")")"
    js+=",\"last_id_ts\":$(_gne_jn "$_GNE_ID_TS"),\"last_id_seq\":$(_gne_jn "$_GNE_ID_SEQ"),\"alerted_for\":$alerted"
    if [[ -n "$o_id" ]]; then
        js+=",\"open_outage\":{\"id\":$(_gne_js "$o_id"),\"started_at\":$(_gne_jn "$GNE_O_OUTAGE_START"),\"class\":$(_gne_js "$GNE_O_OUTAGE_CLASS")}}"
    else
        js+=",\"open_outage\":null}"
    fi
    _gne_write_status "$sfile" "$js" || return 1
    return 0
}

# Same as _gne_kv_file, on a string.
_gne_kv_inline() {
    local re="(^| )$2=([^ ]*)"
    [[ "${1:-}" =~ $re ]] && printf '%s' "${BASH_REMATCH[2]}"
    return 0
}

# Warn about bad conf values once per conf edit (stamp = the conf's mtime).
_gne_conf_warn_once() {
    [[ -n "${GNE_CONF_WARNINGS:-}" ]] || return 0
    local mt stamp="$GNE_EVENTS_DIR/.conf_warned" old=""
    mt=$(stat -c %Y "$GNE_CONF" 2>/dev/null || echo 0)
    read -r old 2>/dev/null < "$stamp" || true
    [[ "$old" == "$mt" ]] && return 0
    printf '%s' "$GNE_CONF_WARNINGS" | sed 's/^/grin-node-events: recorder.conf: /' >&2
    printf '%s\n' "$mt" > "$stamp" 2>/dev/null || true
    return 0
}

# gne_worker_check — the timer's run: both nets, under the shared lock.
gne_worker_check() {
    [[ -d "$GNE_EVENTS_DIR" ]] || { echo "grin-node-events: $GNE_EVENTS_DIR missing — re-install from 086." >&2; return 1; }
    gne_conf_load
    _gne_alerts_setup
    _gne_conf_warn_once
    _gne_lock 20 || { echo "grin-node-events: lock busy (a capture is running) — skipping this check." >&2; return 0; }
    _GNE_CTX_BOOT=$(_gne_boot_id); _GNE_CTX_BTIME=$(_gne_btime)
    _GNE_CTX_CLK=$(getconf CLK_TCK 2>/dev/null || echo 100)
    _GNE_CTX_CRON=$(crontab -l 2>/dev/null || true); _GNE_CTX_CLEAN=""
    local net
    for net in "${GNE_NETS[@]}"; do
        gne_check_net "$net" || echo "grin-node-events: $net check failed." >&2
    done
    _gne_prune_daily
    _gne_unlock
    # After the lock: a slow channel delays only the next check (the timer is
    # OnUnitActiveSec), never the watchdog's capture.
    _gne_alerts_deliver || true
    return 0
}

# _gne_alerts_setup — after gne_conf_load: alerts are ON when a channel is
# configured AND the delivery lib is loaded. Channels set without the lib is a
# broken install, reported through the once-per-conf-edit warning.
_gne_alerts_setup() {
    local k vn any=0
    _GNE_ALERTS_ON=0
    _gne_alerts_reset
    for k in "${_GNE_CHAN_KEYS[@]}"; do vn="GNE_C_$k"; [[ -n "${!vn:-}" ]] && any=1; done
    (( any )) || return 0
    if ! declare -F gas_send >/dev/null 2>&1; then
        GNE_CONF_WARNINGS+="alert channels are set but $GNE_ALERT_LIB is missing — alerts are OFF; re-install from 086"$'\n'
        return 0
    fi
    if [[ -n "$(_gne_alert_channels)" ]]; then
        _GNE_ALERTS_ON=1
    else
        GNE_CONF_WARNINGS+="only half of an alert channel pair is set (TG_BOT_TOKEN+TG_CHAT_ID, NOSTR_SK+NOSTR_RELAY) — alerts are OFF"$'\n'
    fi
    return 0
}

# gne_worker_test_alert — one INFO message through every configured channel.
# Per-channel results go to stdout; rc 0 = at least one channel accepted it.
gne_worker_test_alert() {
    local ch host
    gne_conf_load
    if [[ -n "${GNE_CONF_WARNINGS:-}" ]]; then printf '%s' "$GNE_CONF_WARNINGS" | sed 's/^/recorder.conf: /' >&2; fi
    declare -F gas_send >/dev/null 2>&1 || { echo "grin-node-events: $GNE_ALERT_LIB missing — re-install from 086." >&2; return 1; }
    ch=$(_gne_alert_channels)
    if [[ -z "$ch" ]]; then
        echo "No alert channel is configured in $GNE_CONF."
        echo "Set one, or import Provider Access Watch's channels, from 086's recorder menu."
        return 1
    fi
    host=$(hostname 2>/dev/null || echo vps)
    echo "Sending a test alert via: $ch"
    _gne_alerts_reset
    _gne_alert_push INFO default information_source "test alert" \
        "This is a TEST from the Grin node event recorder on $host. If you received this, the channel works."
    _GNE_ALERT_LOG_FN=_gne_alert_log_stdout _gne_alerts_deliver
}

# _gne_lock <wait_s> — the shared check/capture lock (flock on $GNE_EVENTS_DIR/
# .lock). rc 1 = busy. Without flock the two run unserialised (logged nowhere:
# flock ships with util-linux on every supported distro).
_GNE_LOCK_FD=""
_gne_lock() {
    local lock="$GNE_EVENTS_DIR/.lock" fd
    _GNE_LOCK_FD=""
    command -v flock >/dev/null 2>&1 || return 0
    ( umask 077; : >> "$lock" ) 2>/dev/null || true
    exec {fd}>>"$lock" || return 1
    if ! flock -w "$1" "$fd"; then exec {fd}>&-; return 1; fi
    _GNE_LOCK_FD="$fd"
    return 0
}
_gne_unlock() {
    if [[ -n "$_GNE_LOCK_FD" ]]; then exec {_GNE_LOCK_FD}>&-; fi
    _GNE_LOCK_FD=""
    return 0
}

# Evidence caps also apply when nothing is being captured (a box that stops
# failing still ages its bundles out). Once a day, stamped.
_gne_prune_daily() {
    local stamp="$GNE_EVENTS_DIR/.last_prune" last="" now
    now=$(_gne_now)
    read -r last 2>/dev/null < "$stamp" || true
    last=$(_gne_int "$last")
    if [[ -n "$last" ]] && (( now - last < 86400 && now >= last )); then return 0; fi
    _gne_prune_evidence
    printf '%s\n' "$now" > "$stamp" 2>/dev/null || true
    return 0
}

# gne_worker_capture <net> <kind> <reason>
#   kind watchdog_restart — the watchdog's hook (§8.9), called BEFORE its
#        restart kills the pane. Records restart_by_watchdog, saves a bundle.
#   kind manual — a bundle on demand: no ledger line, no state change.
# Bounded for the watchdog's `timeout 20`: the lock is waited for 15 s at most
# (busy = give up, never delay the restart), and the ledger/status writes come
# BEFORE the slow evidence work, so a timeout loses evidence, never the event.
gne_worker_capture() {
    local net="${1:-}" kind="${2:-}" reason rc
    reason=$(_gne_clean_reason "${3:-}")
    case "$net" in mainnet|testnet) ;; *) echo "grin-node-events: capture needs mainnet|testnet" >&2; return 2 ;; esac
    case "$kind" in watchdog_restart|manual) ;; *) echo "grin-node-events: capture kind is watchdog_restart|manual" >&2; return 2 ;; esac
    [[ -d "$GNE_EVENTS_DIR/$net" ]] || return 0      # this net is not observed
    gne_conf_load
    _gne_lock 15 || { echo "grin-node-events: lock busy — capture skipped." >&2; return 0; }
    _gne_capture_locked "$net" "$kind" "$reason"
    rc=$?
    _gne_unlock
    return "$rc"
}

_gne_capture_locked() {
    local net="$1" kind="$2" reason="$3" now sfile lfile prev="" dir="" pid="" st lpid gv
    now=$(_gne_now)
    _GNE_CTX_BOOT=$(_gne_boot_id); _GNE_CTX_BTIME=$(_gne_btime)
    _GNE_CTX_CLK=$(getconf CLK_TCK 2>/dev/null || echo 100)
    sfile="$GNE_EVENTS_DIR/$net/status.json"; lfile="$GNE_EVENTS_DIR/$net/ledger.jsonl"
    [[ -f "$sfile" ]] && read -r prev 2>/dev/null < "$sfile"
    dir=$(gnc_resolve_node_dir "$net") || dir=""
    [[ -n "$dir" ]] && pid=$(_gne_node_pid "$dir" "$(gnc_node_api_port "$net")")
    st=$(_gne_jget "$prev" state); lpid=$(_gne_jget "$prev" last_pid); gv=$(_gne_jget "$prev" grin_version)

    local last_ok cap_ts cap_n since o_id o_start o_class o_sub sub_state
    last_ok=$(_gne_int "$(_gne_jget "$prev" last_ok)")
    cap_ts=$(_gne_int "$(_gne_jget "$prev" last_capture_ts)")
    cap_n=$(_gne_int "$(_gne_jget "$prev" outage_captures)"); cap_n=${cap_n:-0}
    o_id=$(_gne_jget "$prev" outage_id); o_start=$(_gne_int "$(_gne_jget "$prev" outage_started_at)")
    o_class=$(_gne_jget "$prev" outage_class); o_sub=$(_gne_jget "$prev" sub)
    sub_state=$(_gne_jget "$prev" sub_state)
    # The log window: since the last good check or the last capture, whichever
    # is later — a restart loop's earlier runs are in the earlier bundles.
    since="$last_ok"
    if [[ -n "$cap_ts" ]] && { [[ -z "$since" ]] || (( cap_ts > since )); }; then since="$cap_ts"; fi
    [[ -n "$since" ]] || since=$(( now - 1800 ))

    if [[ "$kind" == manual ]]; then
        [[ -n "$dir" ]] || { echo "grin-node-events: $net is not in the instances conf." >&2; return 1; }
        local mc="manual"; [[ "$st" == down && -n "$o_class" ]] && mc="$o_class"
        if _gne_capture "$net" "$dir" "$pid" "$lpid" "$mc" "${o_sub:-}" "$since" 0 1 "$now" "manual capture${reason:+: $reason}" 0; then
            echo "$GNE_B_DIR"
            [[ -n "$GNE_R_SIG" ]] && echo "matched: $GNE_R_SIG ($GNE_R_STATUS) → class $GNE_R_CLASS (a lean, not a verdict)"
        fi
        return 0
    fi

    # ── watchdog_restart ──
    # The watchdog acts on ONE failed probe every 5 min; the recorder needs two
    # 30 s strikes. So the watchdog can restart a node the recorder still calls
    # `up`, and the restart is itself minutes of 5.5 start-up. When that happens
    # the capture opens the outage (a `wedged:` reason → wedged): without it a
    # restart loop the watchdog catches early would read as 100 % available.
    # In `starting` / `stopped` / `auth_fail` / `unknown` it opens nothing — a
    # watchdog restart of a node that never came up is not a new outage.
    local opened=0 ci="" si="" sa="" rc_x=""
    if [[ "$st" == up && -z "$o_id" ]]; then
        if [[ "$reason" == wedged:* ]]; then ci=wedged; si=tip_stalled
        elif [[ -n "$pid" && "$reason" == "no tip.height"* ]]; then ci=hung; si=bad_reply
        elif [[ -n "$pid" ]]; then ci=hung; si=watchdog_probe
        else
            local ls_ts ex_ts ex_rc ns
            ls_ts=$(_gne_int "$(_gne_kv_file "$dir/.grin_last_start" ts)")
            ex_ts=$(_gne_int "$(_gne_kv_file "$dir/.grin_last_exit" ts)")
            ex_rc=$(_gne_int "$(_gne_kv_file "$dir/.grin_last_exit" rc)")
            ns=$(_gne_int "$(_gne_jget "$prev" node_started_at)")
            if [[ -n "$ex_ts" ]] && { { [[ -n "$ls_ts" ]] && (( ex_ts >= ls_ts )); } || { [[ -n "$ns" ]] && (( ex_ts + 1 >= ns )); }; }; then
                rc_x="$ex_rc"
            fi
            read -r ci si <<< "$(_gne_exit_class "$rc_x")"
        fi
        sa=$(_gne_int "$(_gne_jget "$prev" first_fail_ts)"); sa=${sa:-$now}
        opened=1
    fi

    # Bundle? At most GNE_CAPTURE_PER_OUTAGE per outage; within 5 min of the
    # last one it is kept only if it shows `corrupted` (then named by a reclass).
    local mk=1 keep=1 evn=""
    if (( opened )) || [[ -n "$o_id" ]]; then (( cap_n < GNE_CAPTURE_PER_OUTAGE )) || mk=0; fi
    if [[ -n "$cap_ts" ]] && (( now - cap_ts < GNE_CAPTURE_MIN_GAP )); then keep=0; fi
    [[ -n "$dir" ]] || mk=0
    if (( mk )); then _gne_bundle_mkdir "$net" "$now" watchdog_restart || mk=0; fi
    (( mk && keep )) && evn="$GNE_B_NAME"

    # ── ledger + status FIRST (cheap; survives a timeout in the evidence work) ──
    _GNE_ID_TS=$(_gne_int "$(_gne_jget "$prev" last_id_ts)"); _GNE_ID_SEQ=$(_gne_int "$(_gne_jget "$prev" last_id_seq)")
    if (( opened )); then
        _gne_next_id "$net" "$now"
        o_id="$_GNE_ID"; o_start="$sa"; o_class="$ci"; o_sub="$si"
        _gne_append_ledger "$lfile" "$(_gne_ledger_json "$net" "$now" "$o_id" down down "$ci" "$ci" "$si" \
            "$o_id" "$sa" "" "$pid" "$lpid" "$rc_x" "" "the watchdog restarted a node the recorder last saw up" \
            "$evn" "$gv" null "")" || true
    fi
    local r_state="${st:-unknown}"; [[ -n "$o_id" ]] && r_state=down
    _gne_next_id "$net" "$now"
    _gne_append_ledger "$lfile" "$(_gne_ledger_json "$net" "$now" "$_GNE_ID" restart_by_watchdog "$r_state" \
        "${o_id:+$o_class}" "" "" "$o_id" "" "" "$pid" "$lpid" "" "$GNE_WATCHDOG_BY" "$reason" "$evn" "$gv" null "")" || true

    local js="$prev"
    if [[ -n "$js" ]]; then
        js=$(_gne_jset "$js" pending_restart_by "$(_gne_js "$GNE_WATCHDOG_BY")")
        js=$(_gne_jset "$js" pending_restart_ts "$now")
        js=$(_gne_jset "$js" last_id_ts "$(_gne_jn "$_GNE_ID_TS")")
        js=$(_gne_jset "$js" last_id_seq "$(_gne_jn "$_GNE_ID_SEQ")")
        if (( opened )); then
            js=$(_gne_jset "$js" state '"down"')
            js=$(_gne_jset "$js" class "$(_gne_js "$ci")")
            js=$(_gne_jset "$js" sub "$(_gne_js "$(_gne_clean_sub "$si")")")
            js=$(_gne_jset "$js" sub_state null)
            js=$(_gne_jset "$js" since "$now")
            js=$(_gne_jset "$js" up_since null)
            js=$(_gne_jset "$js" strikes 0)
            js=$(_gne_jset "$js" first_fail_ts null)
            js=$(_gne_jset "$js" outage_id "$(_gne_js "$o_id")")
            js=$(_gne_jset "$js" outage_started_at "$(_gne_jn "$sa")")
            js=$(_gne_jset "$js" outage_class "$(_gne_js "$ci")")
            js=$(_gne_jset "$js" outage_captures 0)
            js=$(_gne_jset "$js" open_outage "{\"id\":$(_gne_js "$o_id"),\"started_at\":$(_gne_jn "$sa"),\"class\":$(_gne_js "$ci")}")
        fi
        if [[ -n "$evn" ]]; then
            js=$(_gne_jset "$js" last_capture_ts "$now")
            js=$(_gne_jset "$js" last_evidence "$(_gne_js "$evn")")
            [[ -n "$o_id" ]] && js=$(_gne_jset "$js" outage_captures "$(( cap_n + 1 ))")
        fi
        _gne_write_status "$sfile" "$js" || true
    fi
    (( mk )) || return 0

    # ── evidence (the slow part) ──
    # Start window = the run being killed never answered get_status.
    local sw=0
    if [[ "$st" == starting || "$sub_state" == restarting || ( "$st" == down && "$o_class" == failed_start ) ]]; then sw=1; fi
    _gne_bundle_fill "$GNE_B_DIR" "$net" "$dir" "$pid" "$lpid" "${o_class:-${st:-unknown}}" "${o_sub:-}" \
        "$since" "$sw" "$now" "watchdog restart: ${reason:-no reason given}"
    if (( ! keep )); then
        if [[ "$GNE_R_CLASS" == corrupted ]]; then
            evn="$GNE_B_NAME"
        else
            rm -rf -- "$GNE_B_DIR" 2>/dev/null || true
        fi
    fi
    # Reclass: always to `corrupted`; to anything else only for the outage this
    # capture opened (the watchdog's own guess was the only class it had).
    if [[ -n "$o_id" && -n "$GNE_R_CLASS" && "$GNE_R_CLASS" != "$o_class" ]] \
        && { [[ "$GNE_R_CLASS" == corrupted ]] || (( opened )); }; then
        _gne_next_id "$net" "$now"
        _gne_append_ledger "$lfile" "$(_gne_ledger_json "$net" "$now" "$_GNE_ID" reclass down "$GNE_R_CLASS" "$o_class" \
            "$GNE_R_SUB" "$o_id" "$o_start" "" "$pid" "$lpid" "" "" "evidence refined the class" "$evn" "$gv" null "")" || true
        if [[ -n "$js" ]]; then
            js=$(_gne_jset "$js" class "$(_gne_js "$GNE_R_CLASS")")
            js=$(_gne_jset "$js" sub "$(_gne_js "$(_gne_clean_sub "$GNE_R_SUB")")")
            js=$(_gne_jset "$js" outage_class "$(_gne_js "$GNE_R_CLASS")")
            js=$(_gne_jset "$js" last_id_ts "$(_gne_jn "$_GNE_ID_TS")")
            js=$(_gne_jset "$js" last_id_seq "$(_gne_jn "$_GNE_ID_SEQ")")
            js=$(_gne_jset "$js" open_outage "{\"id\":$(_gne_js "$o_id"),\"started_at\":$(_gne_jn "$o_start"),\"class\":$(_gne_js "$GNE_R_CLASS")}")
            if [[ -n "$evn" ]]; then
                js=$(_gne_jset "$js" last_capture_ts "$now")
                js=$(_gne_jset "$js" last_evidence "$(_gne_js "$evn")")
            fi
            _gne_write_status "$sfile" "$js" || true
        fi
    fi
    if [[ -n "$evn" ]]; then _gne_prune_evidence "$GNE_B_DIR"; fi
    return 0
}

# gne_worker_show [net] — status.json + the last ledger lines.
gne_worker_show() {
    local net nets=("${GNE_NETS[@]}")
    [[ -n "${1:-}" ]] && nets=("$1")
    for net in "${nets[@]}"; do
        [[ -d "$GNE_EVENTS_DIR/$net" ]] || continue
        echo "== $net =="
        if [[ -f "$GNE_EVENTS_DIR/$net/status.json" ]]; then cat "$GNE_EVENTS_DIR/$net/status.json"; else echo "(no status.json yet)"; fi
        echo "-- last ledger lines --"
        tail -n 15 "$GNE_EVENTS_DIR/$net/ledger.jsonl" 2>/dev/null || echo "(no ledger yet)"
    done
    return 0
}

# =============================================================================
# INSTALL / REMOVE / STATUS
# =============================================================================
_gne_copy_lib() { # <src> <dest>
    local tmp
    [[ -f "$1" ]] || { error "Missing $1."; return 1; }
    tmp=$(mktemp "$(dirname "$2")/.lib.XXXXXX") || { error "Cannot write in $(dirname "$2")."; return 1; }
    cp -f "$1" "$tmp" || { rm -f "$tmp"; error "Cannot copy $1."; return 1; }
    chmod 644 "$tmp" || { rm -f "$tmp"; error "Cannot chmod $tmp."; return 1; }
    mv -f "$tmp" "$2" || { rm -f "$tmp"; error "Cannot install $2."; return 1; }
    return 0
}

_gne_write_worker() {
    local tmp
    tmp=$(mktemp "$(dirname "$GNE_BIN")/.grin-node-events.XXXXXX") || { error "Cannot write in $(dirname "$GNE_BIN")."; return 1; }
    # Line block 1: baked paths (expanded). Body: QUOTED heredoc — nothing in
    # it expands at install time (reference_bash_unquoted_heredoc_backticks).
    cat > "$tmp" <<EOF || { rm -f "$tmp"; error "Cannot write the worker."; return 1; }
#!/bin/bash
# grin-node-events — GENERATED by lib/grin_node_events.sh. Do not edit;
# re-install from hub 08 → Diagnostics → Node event recorder to regenerate.
# READ-ONLY node event recorder (086 design §8). Never signals a node.
GNE_LIB_FILE="$GNE_LIB_INSTALL_DIR/grin_node_events.sh"
export GNE_EVENTS_DIR="$GNE_EVENTS_DIR"
export GNE_CONF="$GNE_CONF"
EOF
    cat >> "$tmp" <<'EOF' || { rm -f "$tmp"; error "Cannot write the worker."; return 1; }
set -uo pipefail
export LC_ALL=C
umask 022
[[ -r "$GNE_LIB_FILE" ]] || { echo "grin-node-events: $GNE_LIB_FILE missing — re-install from 086." >&2; exit 1; }
# shellcheck source=/dev/null
source "$GNE_LIB_FILE"

case "${1:-}" in
    check)      gne_worker_check ;;
    capture)    shift; gne_worker_capture "$@" || true ;;
    show)       gne_worker_show "${2:-}" ;;
    test-alert) gne_worker_test_alert; exit $? ;;
    *)
        echo "Usage: grin-node-events check | capture <mainnet|testnet> <watchdog_restart|manual> [reason] | show [mainnet|testnet] | test-alert"
        exit 2
        ;;
esac
exit 0
EOF
    chmod 750 "$tmp" || { rm -f "$tmp"; error "Cannot chmod the worker."; return 1; }
    mv -f "$tmp" "$GNE_BIN" || { rm -f "$tmp"; error "Cannot install $GNE_BIN."; return 1; }
    return 0
}

_gne_write_units() {
    cat > "$GNE_SERVICE" <<EOF || { error "Cannot write $GNE_SERVICE."; return 1; }
[Unit]
Description=Grin Node Toolkit - node event recorder (read-only check)
After=network.target

[Service]
Type=oneshot
ExecStart=$GNE_BIN check
Nice=10
# best-effort, NOT idle: during an archive disk thrash an idle-class recorder
# would starve, and that is exactly when it must run (086 design §8.11).
IOSchedulingClass=best-effort
IOSchedulingPriority=7
TimeoutStartSec=120
EOF
    cat > "$GNE_TIMER" <<'EOF' || { error "Cannot write $GNE_TIMER."; return 1; }
[Unit]
Description=Grin node event recorder (every 30 s)

[Timer]
OnBootSec=60s
OnUnitActiveSec=30s
AccuracySec=1s
Unit=grin-node-events.service

[Install]
WantedBy=timers.target
EOF
    chmod 644 "$GNE_SERVICE" "$GNE_TIMER" || { error "Cannot chmod the units."; return 1; }
    return 0
}

# Rename-based rotation (no copytruncate): the worker reopens the ledger on
# every append, and the pool's ingest sees a new inode and resets its offset.
_gne_write_logrotate() {
    if [[ ! -d "$(dirname "$GNE_LOGROTATE")" ]]; then
        warn "logrotate not present — the ledger will not be rotated (it grows by one line per transition)."
        return 0
    fi
    cat > "$GNE_LOGROTATE" <<EOF || { error "Cannot write $GNE_LOGROTATE."; return 1; }
# grin-node-toolkit: node event recorder ledger (086 design §8.7).
# Rename + create, never copytruncate: copytruncate can lose a line appended
# mid-copy, and the pool's ingest tracks the inode.
$GNE_EVENTS_DIR/*/ledger.jsonl {
    size 10M
    rotate 12
    missingok
    notifempty
    nocopytruncate
    create 0644 root root
    compress
    delaycompress
}
EOF
    chmod 644 "$GNE_LOGROTATE" || { error "Cannot chmod $GNE_LOGROTATE."; return 1; }
    return 0
}

# gne_install — conf (if absent), state dirs, lib copies, worker, units,
# logrotate; enables the timer. Idempotent: re-running regenerates the worker
# and refreshes the lib copies (the way to pick up a toolkit update).
gne_install() {
    if [[ $EUID -ne 0 ]]; then error "Installing the recorder needs root."; return 1; fi
    command -v systemctl >/dev/null 2>&1 || { error "systemd not found — the recorder runs from a systemd timer."; return 1; }
    command -v curl >/dev/null 2>&1 || { error "curl not found — the recorder probes the Owner API with it."; return 1; }
    local src="${BASH_SOURCE[0]}" net

    # The events root is what turns the planned-stop markers on (§8.5).
    mkdir -p "$GNE_EVENTS_DIR" || { error "Cannot create $GNE_EVENTS_DIR."; return 1; }
    chmod 755 "$GNE_EVENTS_DIR" || { error "Cannot chmod $GNE_EVENTS_DIR."; return 1; }
    for net in "${GNE_NETS[@]}"; do
        if gnc_resolve_node_dir "$net" >/dev/null 2>&1; then
            mkdir -p -m 755 "$GNE_EVENTS_DIR/$net" || { error "Cannot create $GNE_EVENTS_DIR/$net."; return 1; }
            mkdir -p -m 700 "$GNE_EVENTS_DIR/$net/evidence" || { error "Cannot create $GNE_EVENTS_DIR/$net/evidence."; return 1; }
        fi
    done
    _gne_write_default_conf || return 1

    mkdir -p -m 755 "$GNE_LIB_INSTALL_DIR" || { error "Cannot create $GNE_LIB_INSTALL_DIR."; return 1; }
    _gne_copy_lib "$GNE_CONTROL_LIB" "$GNE_LIB_INSTALL_DIR/grin_node_control.sh" || return 1
    _gne_copy_lib "$src" "$GNE_LIB_INSTALL_DIR/grin_node_events.sh" || return 1
    _gne_copy_lib "$GNE_SIG_LIB" "$GNE_LIB_INSTALL_DIR/grin_log_signatures.sh" || return 1
    _gne_copy_lib "$GNE_ALERT_LIB" "$GNE_LIB_INSTALL_DIR/grin_alert_send.sh" || return 1
    _gne_write_worker || return 1
    _gne_write_units || return 1
    _gne_write_logrotate || return 1

    systemctl daemon-reload || { error "systemctl daemon-reload failed."; return 1; }
    systemctl enable --now grin-node-events.timer >/dev/null 2>&1 \
        || { error "Could not enable grin-node-events.timer — see: systemctl status grin-node-events.timer"; return 1; }
    success "Node event recorder installed: $GNE_BIN (timer every 30 s, read-only)."
    info "State: $GNE_EVENTS_DIR/<net>/{status.json,ledger.jsonl}   Config: $GNE_CONF"
    return 0
}

# gne_remove — worker, units, logrotate stanza and the lib copy. Keeps state,
# evidence and conf (08del removes those, asking about evidence first).
gne_remove() {
    if [[ $EUID -ne 0 ]]; then error "Removing the recorder needs root."; return 1; fi
    systemctl disable --now grin-node-events.timer >/dev/null 2>&1 || true
    # grin_alert_send.sh: only the recorder runs from the /opt/grin/lib copy
    # (082 inlines the lib into its own worker), so the copy goes with it.
    rm -f "$GNE_TIMER" "$GNE_SERVICE" "$GNE_BIN" "$GNE_LOGROTATE" "$GNE_LIB_INSTALL_DIR/grin_node_events.sh" \
        "$GNE_LIB_INSTALL_DIR/grin_log_signatures.sh" "$GNE_LIB_INSTALL_DIR/grin_alert_send.sh" \
        || { error "Could not remove every recorder file — check $GNE_BIN and $GNE_SERVICE."; return 1; }
    systemctl daemon-reload 2>/dev/null || true
    success "Node event recorder removed (state kept: $GNE_EVENTS_DIR, config kept: $GNE_CONF)."
    return 0
}

# gne_status — timer state + per-net summary.
gne_status() {
    if systemctl is-active grin-node-events.timer >/dev/null 2>&1 && [[ -x "$GNE_BIN" ]]; then
        success "Node event recorder: INSTALLED, timer active."
    elif [[ -x "$GNE_BIN" ]]; then
        warn "Node event recorder: installed, but the timer is NOT active (systemctl status grin-node-events.timer)."
    else
        warn "Node event recorder: NOT installed."
    fi
    local ch=""
    if [[ -r "$GNE_CONF" ]]; then gne_conf_load; ch=$(_gne_alert_channels); fi
    if [[ -n "$ch" ]]; then info "Alerts: $ch"; else warn "Alerts: OFF (no channel configured in $GNE_CONF)."; fi
    local net s now age st
    now=$(_gne_now)
    for net in "${GNE_NETS[@]}"; do
        s=""; [[ -f "$GNE_EVENTS_DIR/$net/status.json" ]] && read -r s < "$GNE_EVENTS_DIR/$net/status.json"
        [[ -n "$s" ]] || continue
        st=$(_gne_jget "$s" state); age=$(_gne_jget "$s" updated)
        [[ "$age" =~ ^[0-9]+$ ]] && age=$(( now - age )) || age="?"
        info "$net: state=${st:-?}$( [[ -n "$(_gne_jget "$s" class)" ]] && printf ' class=%s' "$(_gne_jget "$s" class)" )  last check ${age}s ago  grin $(_gne_jget "$s" grin_version)"
        if (( ${age//\?/999} > 120 )); then warn "$net: status.json is STALE (>120 s) — the recorder is not running."; fi
        tail -n 3 "$GNE_EVENTS_DIR/$net/ledger.jsonl" 2>/dev/null | sed 's/^/    /' || true
    done
    return 0
}
