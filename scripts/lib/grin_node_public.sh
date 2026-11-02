# =============================================================================
# lib/grin_node_public.sh — the PUBLIC projection of the node event recorder
# =============================================================================
# The recorder (lib/grin_node_events.sh, 086 design §8) keeps a ledger and a
# status file that hold pids, boot ids, free-text reasons and exact times. This
# lib turns them into the small files a node's public status page serves:
#
#   gnp_kind_label <class> / gnp_error_label <sub>   THE public label map
#   gnp_project <net> [now]          availability.json content → stdout
#   gnp_write_availability <net> [now]   project + privacy gate + atomic write
#   gnp_write_public <net> <name> <content>   the only writer of public files
#   gnp_assert_public <name> <json>  the privacy gate every public file passes
#   gnp_chain_json <net>             {"lines","head"} of public/history.jsonl
#   gnp_history_sync <net> [now]     append closed outages/planned spans to the
#                                    hash chain (creates it + backfills once)
#   gnp_history_append <net> <type> …   one line (the compaction scanner's entry)
#   gnp_verify_chain <net>           check every link; names the altered line
#   gnp_write_history <net>          public/history.json (the raw lines as strings)
#   gnp_compact_scan <net> <node_dir>   compaction durations from the node log, onto
#                                    the chain (lib/grin_node_public_compact.sh)
#
# The history chain (public/history.jsonl) is append-only: line 0 is
# chain_start, every later line carries "prev" = sha256 of the previous line's
# exact bytes (no newline), and "src", a dedupe key, so a re-run never appends
# the same event twice. src = sha256(salt ‖ key)[0:16], where the salt is a
# per-net secret in <net>/.public_salt (0600, outside public/): unsalted, a
# src plus the published date gives back the key's exact epoch second. The
# salt is created with a new chain only; with a chain and no usable salt,
# every append and every public write refuses (a new salt would give every
# event a new src and list it again). Back it up and restore it WITH
# history.jsonl. LOCKING: these functions take no lock. Every caller that
# writes (sync, append, write_history, write_availability) must hold flock on
# public/.lock, or two writers can give two lines the same seq; the caller
# creates public/ before it locks (gnp_public_dir names it).
#
# Contract (each item is a review gate):
#   · writes ONLY under $GNE_EVENTS_DIR/<net>/public/ — never into a node dir,
#     never into a web root (04's collector and 06d copy/read from here), and
#     never through a symlinked public/ dir;
#   · nothing the ledger or status.json holds reaches a public file except
#     through the label map, a UTC date, a duration rounded to the minute, or
#     a sum from dgr_availability. No timestamp of the OPEN outage, no reason,
#     pid, boot_id, node_dir, grin_version, evidence name or `by`;
#   · an outage appears in the list only once a ledger line has closed it;
#   · every public file is 0644 by an explicit chmod (the worker runs umask 022
#     but the recorder writes 0600 files elsewhere).
# The availability sweep is dgr_availability (lib/086_lib_recorder.sh), reused
# so 086's screen, the pool's sweep and the public page count the same seconds
# and 086's screen and the public page show the same pct (auth_fail counts as up).
#
# Conventions: sourced lib → NO shebang / NO `set -e`; reached from `fn || true`
# menu arms and the worker, so errexit is OFF here and every create/copy/move/
# delete carries its own guard (project_lib_errexit_suppression). Awk is
# mawk-safe: no gensub/asort/strftime/length(array), no {n} intervals.
# =============================================================================

[[ -n "${_GRIN_NODE_PUBLIC_SH_LOADED:-}" ]] && return 0
_GRIN_NODE_PUBLIC_SH_LOADED=1

# shellcheck source=086_lib_recorder.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/086_lib_recorder.sh"
# shellcheck source=grin_node_public_compact.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/grin_node_public_compact.sh"

GNP_SCHEMA=1
GNP_LIST_MAX=50           # outages / planned rows in availability.json (90 d)
GNP_LIST_DAYS=90

# Every key availability.json may carry (its v:1 contract). The gate refuses a
# file with any other key, so a new key is added here on purpose or not at all.
GNP_AVAIL_KEYS=" v net generated state up_days windows 7 30 90 pct observed_d planned_min outages
 date duration_min kind error planned compactions logged last duration_s d30 count median_s max_s
 chain lines head check method "
# Keys of the recorder's own files that must never appear in ANY public file,
# whatever its allow-list says (checked first, so an allow-list typo cannot
# let one through).
GNP_FORBIDDEN_KEYS=" started_at since first_fail_ts reason by pid prev_pid rc boot_id node_dir
 grin_version evidence outage_id id ts updated last_ok last_check up_since node_started_at
 open_outage alerted_for class class_initial sub sub_state observed_gap_s clean_shutdown
 pending_restart_by pending_restart_ts last_pid start_ref outage_started_at outage_class
 last_evidence last_capture_ts recorder_version strikes last_api "
# Every key a history.jsonl line may carry.
GNP_HIST_KEYS=" v seq type date duration_min duration_s kind error src imported prev "
# One space-separated line each, so " key " matches at a line break too.
GNP_AVAIL_KEYS="${GNP_AVAIL_KEYS//$'\n'/ }"
GNP_FORBIDDEN_KEYS="${GNP_FORBIDDEN_KEYS//$'\n'/ }"

# The four history line shapes, key order fixed. A line matching none of them
# is never written or published. "src" is always 16 hex (the salted hash of a
# ledger id or of a compaction's c-<log inode>-<byte offset>).
_GNP_RE_HEAD='^\{"v":1,"seq":(0|[1-9][0-9]{0,8}),"type":"'
_GNP_RE_DATE='","date":"[0-9]{4}-[0-9]{2}-[0-9]{2}"'
_GNP_RE_TAIL='(,"imported":true)?,"prev":"[0-9a-f]{64}"\}$'
_GNP_HIST_SHAPES=(
    '^\{"v":1,"seq":0,"type":"chain_start","date":"[0-9]{4}-[0-9]{2}-[0-9]{2}","prev":null\}$'
    "${_GNP_RE_HEAD}outage${_GNP_RE_DATE},\"duration_min\":(0|[1-9][0-9]{0,5}),\"kind\":\"[a-z() ]{1,40}\",\"error\":(null|\"[A-Za-z0-9 ()/-]{1,40}\"),\"src\":\"[0-9a-f]{16}\"${_GNP_RE_TAIL}"
    "${_GNP_RE_HEAD}planned${_GNP_RE_DATE},\"duration_min\":(0|[1-9][0-9]{0,5}),\"src\":\"[0-9a-f]{16}\"${_GNP_RE_TAIL}"
    "${_GNP_RE_HEAD}compaction${_GNP_RE_DATE},\"duration_s\":(0|[1-9][0-9]{0,7}),\"src\":\"[0-9a-f]{16}\"${_GNP_RE_TAIL}"
)

# Errors go through the menu's error() when there is one, else to stderr (the
# worker has no colours/logging of its own).
_gnp_err() {
    if declare -F error >/dev/null 2>&1; then error "$*"; else echo "grin-node-public: $*" >&2; fi
    return 0
}

# ─── Label map ──────────────────────────────────────────────────────────────
# The one place a recorder class/sub becomes public text. Anything not listed:
# kind "unknown", error null. Readers print these strings as text and never
# mirror the table.
gnp_kind_label() { # <class> → label
    case "${1:-}" in
        hung)                 printf 'hung' ;;
        wedged)               printf 'sync stalled' ;;
        crashed)              printf 'crashed' ;;
        killed)               printf 'killed' ;;
        corrupted)            printf 'chain data corrupted' ;;
        failed_start)         printf 'failed to start' ;;
        unexplained_stop)     printf 'stopped (unexplained)' ;;
        restart_by_watchdog)  printf 'restarted by watchdog' ;;
        *)                    printf 'unknown' ;;
    esac
    return 0
}

gnp_error_label() { # <sub> → label, or nothing (= null)
    local s="${1:-}" n
    case "$s" in
        thread_panic)   printf 'thread panic' ;;
        panic)          printf 'panic' ;;
        verify_failed:kernel|verify_failed:output|verify_failed:rangeproof)
                        printf 'PMMR verify failed (%s)' "${s#verify_failed:}" ;;
        oom|oom_start)  printf 'out of memory' ;;
        lmdb)           printf 'LMDB error' ;;
        chain_error)    printf 'chain-state error' ;;
        io_stall)       printf 'disk I/O stall' ;;
        compaction)     printf 'compaction' ;;
        timeout)        printf 'API timeout' ;;
        port_closed)    printf 'API port closed' ;;
        clean_shutdown) printf 'clean shutdown' ;;
        rc=137)         printf 'SIGKILL' ;;
        *)
            # Any other exit code: the integer only, 0-255.
            if [[ "$s" =~ ^rc=([0-9]{1,3})$ ]]; then
                n=$(( 10#${BASH_REMATCH[1]} ))
                if (( n <= 255 )); then printf 'exit code %d' "$n"; fi
            fi
            ;;
    esac
    return 0
}

# Public state from status.json's: auth_fail counts as up (the node answers,
# and availability counts it as up too). `stopped` is a planned stop — not an
# outage, but the node does not answer, so the page says down. Anything else
# is unknown.
_gnp_state_label() {
    case "${1:-}" in
        up|auth_fail)  printf 'up' ;;
        starting)      printf 'starting' ;;
        down|stopped)  printf 'down' ;;
        *)             printf 'unknown' ;;
    esac
    return 0
}

# ─── Privacy gate + writer ──────────────────────────────────────────────────
# gnp_assert_public <name> <json> → rc 0 when the content may be published.
# Names: availability.json, history.jsonl (ONE raw history line) and
# history.json (whose every line must pass as history.jsonl).
# Every "key": must be in that file's allow-list and in no forbidden list; the
# values (keys stripped) must hold no IPv4/IPv6 address, no .onion, and no
# epoch-like 10-digit number. The only values exempt from the digit check are
# a 64-hex "head"/"prev" and a 16-hex "src", in exactly that shape. Pure bash
# (no subprocess): history.json runs it once per line. rc 1 + a message naming
# the KEY or the pattern, never the value.
gnp_assert_public() {
    local name="$1" js="$2" allowed k m re rest vals=""
    case "$name" in
        availability.json) allowed="$GNP_AVAIL_KEYS" ;;
        history.jsonl)     allowed="$GNP_HIST_KEYS" ;;
        history.json)      _gnp_assert_history_json "$js"; return ;;
        *) _gnp_err "No privacy allow-list for public file '$name'."; return 1 ;;
    esac
    # The values are labels, dates, numbers and hex: an escape can only hide a key.
    if [[ "$js" == *\\* ]]; then _gnp_err "$name: holds an escaped character."; return 1; fi
    if [[ "$js" == *$'\n'* || "$js" == *$'\r'* ]]; then _gnp_err "$name: not one line."; return 1; fi
    if [[ "$name" == history.jsonl ]]; then
        # Only the shape its type names is tried (each =~ recompiles its regex,
        # and history.json runs this once per line). A line naming no type, or
        # the wrong one, matches no shape: refused.
        case "$js" in
            *'"type":"chain_start"'*) re="${_GNP_HIST_SHAPES[0]}" ;;
            *'"type":"outage"'*)      re="${_GNP_HIST_SHAPES[1]}" ;;
            *'"type":"planned"'*)     re="${_GNP_HIST_SHAPES[2]}" ;;
            *'"type":"compaction"'*)  re="${_GNP_HIST_SHAPES[3]}" ;;
            *)                        re="" ;;
        esac
        if [[ -z "$re" || ! "$js" =~ $re ]]; then _gnp_err "$name: not one of the history line shapes."; return 1; fi
    fi
    rest="$js"
    while [[ "$rest" =~ \"([^\"\\]*)\"[[:space:]]*: ]]; do
        m="${BASH_REMATCH[0]}"; k="${BASH_REMATCH[1]}"
        if [[ "$GNP_FORBIDDEN_KEYS" == *" $k "* ]]; then _gnp_err "$name: forbidden key '$k'."; return 1; fi
        if [[ "$allowed" != *" $k "* ]]; then _gnp_err "$name: key '$k' is not on its allow-list."; return 1; fi
        vals+="${rest%%"$m"*} "
        rest="${rest#*"$m"}"
        case "$k" in
            head|prev) if [[ "$rest" =~ ^\"[0-9a-f]{64}\" ]]; then rest="${rest:66}"; fi ;;
            src)       if [[ "$rest" =~ ^\"[0-9a-f]{16}\" ]]; then rest="${rest:18}"; fi ;;
        esac
    done
    vals+="$rest"
    if [[ "$vals" =~ [0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3} ]]; then _gnp_err "$name: holds an IPv4-like value."; return 1; fi
    if [[ "$vals" =~ [0-9A-Fa-f]{0,4}:[0-9A-Fa-f]{0,4}:[0-9A-Fa-f]{0,4} ]]; then _gnp_err "$name: holds an IPv6-like value."; return 1; fi
    if [[ "${vals,,}" == *.onion* ]]; then _gnp_err "$name: holds an onion address."; return 1; fi
    if [[ "$vals" =~ [0-9]{10} ]]; then _gnp_err "$name: holds an epoch-like number."; return 1; fi
    return 0
}

# history.json = {"v":1,"net":"<net>","lines":["<line>",…]}. Each element is a
# raw line with only its quotes escaped (a raw line holds no backslash), so it
# ends at the first unescaped `","`; every element must pass as history.jsonl.
# The body is split in ONE substitution (`","` → newline; the file has none)
# and read line by line: slicing the remaining body once per element costs
# quadratic time, minutes for a chain of a few thousand lines.
_gnp_assert_history_json() {
    local js="$1" body el bq='\"' dq='"' sep='","' left
    if [[ "$js" == *$'\n'* || "$js" == *$'\r'* ]]; then _gnp_err "history.json: not one line."; return 1; fi
    if [[ ! "$js" =~ ^\{\"v\":1,\"net\":\"([a-z]+)\",\"lines\":\[(.*)\]\}$ ]]; then
        _gnp_err "history.json: not the {v,net,lines} wrapper."; return 1
    fi
    body="${BASH_REMATCH[2]}"
    _gnp_valid_net "${BASH_REMATCH[1]}" || return 1
    [[ -n "$body" ]] || return 0
    if (( ${#body} < 2 )) || [[ "$body" != \"* || "$body" != *\" ]]; then _gnp_err "history.json: a line is not a string."; return 1; fi
    body="${body:1:${#body}-2}"
    while IFS= read -r el; do
        left="${el//"$bq"/}"
        if [[ "$left" == *[\"\\]* ]]; then _gnp_err "history.json: a line with a stray quote or escape."; return 1; fi
        gnp_assert_public history.jsonl "${el//"$bq"/"$dq"}" || return 1
    done <<< "${body//"$sep"/$'\n'}"
    return 0
}

gnp_public_dir() { printf '%s/%s/public' "$GNE_EVENTS_DIR" "$1"; }

_gnp_valid_net() {
    local n
    for n in "${GNE_NETS[@]}"; do [[ "$1" == "$n" ]] && return 0; done
    _gnp_err "Unknown network '${1:-}'."
    return 1
}

# _gnp_ensure_dir <net> — public/ 0755 inside an EXISTING recorder net dir
# (this lib never creates the recorder's own dirs). A symlink is refused: root
# would otherwise write wherever it points, a web root included.
_gnp_ensure_dir() {
    local base="$GNE_EVENTS_DIR/$1" d
    d=$(gnp_public_dir "$1")
    if [[ ! -d "$base" || -L "$base" ]]; then _gnp_err "$base is missing — install the recorder first."; return 1; fi
    if [[ -L "$d" ]]; then _gnp_err "$d is a symlink — refusing to write through it."; return 1; fi
    if [[ ! -d "$d" ]]; then
        mkdir "$d" 2>/dev/null || { _gnp_err "Cannot create $d."; return 1; }
    fi
    chmod 755 "$d" 2>/dev/null || { _gnp_err "Cannot chmod $d."; return 1; }
    return 0
}

# gnp_write_public <net> <name> <content> — gate, then temp + chmod 0644 + mv in
# the same dir, so a reader sees the old file or the new one, never half.
gnp_write_public() {
    local net="$1" name="$2" js="$3" d tmp
    _gnp_valid_net "$net" || return 1
    [[ "$name" =~ ^[a-z_]+\.json$ ]] || { _gnp_err "Bad public file name '$name'."; return 1; }
    gnp_assert_public "$name" "$js" || return 1
    _gnp_ensure_dir "$net" || return 1
    d=$(gnp_public_dir "$net")
    # A chain whose salt is gone can no longer be extended: publish nothing.
    if [[ -s "$d/history.jsonl" ]]; then _gnp_salt_load "$net" 0 || return 1; fi
    tmp=$(mktemp "$d/.$name.XXXXXX" 2>/dev/null) || { _gnp_err "Cannot write in $d."; return 1; }
    printf '%s\n' "$js" > "$tmp" 2>/dev/null || { rm -f -- "$tmp" 2>/dev/null; _gnp_err "Cannot write $tmp."; return 1; }
    chmod 644 "$tmp" 2>/dev/null || { rm -f -- "$tmp" 2>/dev/null; _gnp_err "Cannot chmod $tmp."; return 1; }
    mv -f -- "$tmp" "$d/$name" 2>/dev/null || { rm -f -- "$tmp" 2>/dev/null; _gnp_err "Cannot replace $d/$name."; return 1; }
    return 0
}

# ─── Projection: status.json + ledger → availability.json ───────────────────
_gnp_jstr() { if [[ -z "${1:-}" ]]; then printf 'null'; else _gne_js "$1"; fi; }

# _gnp_windows <net> <now> → the "windows" object. pct = (up + auth) ÷
# (up + auth + down), floored to 0.01 so a real outage never reads 100.00;
# observed and planned time are printed beside it, never folded in.
_gnp_windows() {
    local line kv out="" w up dn pl au un o obs den p k v
    while IFS= read -r line; do
        [[ "$line" == win=* ]] || continue
        w=""; up=0; dn=0; pl=0; au=0; un=0; o=0
        for kv in $line; do
            k="${kv%%=*}"; v="${kv#*=}"
            [[ "$v" =~ ^[0-9]+$ ]] || continue
            case "$k" in
                win) w="$v" ;; up) up="$v" ;; down) dn="$v" ;; planned) pl="$v" ;;
                auth) au="$v" ;; unobs) un="$v" ;; outages) o="$v" ;;
            esac
        done
        [[ -n "$w" ]] || continue
        obs=$(( w * 86400 - un )); (( obs < 0 )) && obs=0
        den=$(( up + au + dn ))
        if (( den > 0 )); then
            p=$(( (up + au) * 10000 / den ))
            p=$(printf '%d.%02d' $(( p / 100 )) $(( p % 100 )))
        else
            p=null
        fi
        obs=$(( (obs * 10 + 43200) / 86400 ))
        out+="${out:+,}\"$w\":{\"pct\":$p,\"observed_d\":$(( obs / 10 )).$(( obs % 10 )),\"planned_min\":$(( (pl + 30) / 60 )),\"outages\":$o}"
    done < <(dgr_availability "$1" "$2")
    printf '{%s}' "$out"
}

# _gnp_event_rows <net> <now> [since] → "O|start|date|minutes|class|sub|outage_id"
# for each CLOSED outage and "P|start|date|minutes|id" (id = the ledger line
# that opened it) for each closed planned span (state stopped/starting, the
# sweep's planned bucket), ending after <since> (default: the last 90 d),
# newest first. Raw class/sub here; the label map is applied by the caller.
# A "|" inside a field becomes "_", so the columns never shift.
#  · An outage comes only from the line that closed it (its started_at +
#    duration_s), so an open outage never appears. Its sub is the latest one a
#    down/reclass line gave that outage_id.
#  · An outage or planned span that a recorder_start cut off was never seen to
#    end: it is not listed (the sweep counts that tail, the list cannot date it).
#  · A planned span ended by a `down` ends at that outage's backdated start
#    (the sweep's down-over-state precedence). A span already open on the
#    first row read is not listed: its opening line is not in view.
#  · The opener of a span is the first stopped/starting row after a row
#    that was not: only that id keys it.
_gnp_event_rows() {
    local net="$1" now="$2" since="${3:-}"
    [[ "$since" =~ ^[0-9]+$ ]] || since=$(( now - GNP_LIST_DAYS * 86400 ))
    dgr_ledger_cat "$net" "$since" | dgr_parse \
    | awk -v since="$since" '
        function ymd(t,   z, era, doe, yoe, y, doy, mp, d, m) {
            z = int(t / 86400) + 719468; era = int(z / 146097); doe = z - era * 146097
            yoe = int((doe - int(doe / 1460) + int(doe / 36524) - int(doe / 146096)) / 365)
            y = yoe + era * 400; doy = doe - (365 * yoe + int(yoe / 4) - int(yoe / 100))
            mp = int((5 * doy + 2) / 153); d = doy - int((153 * mp + 2) / 5) + 1
            m = (mp < 10) ? mp + 3 : mp - 9
            if (m <= 2) y++
            return sprintf("%04d-%02d-%02d", y, m, d)
        }
        function mins(s) { return sprintf("%.0f", int((s + 30) / 60)) }
        function f(s) { gsub(/[|]/, "_", s); return s }
        BEGIN { FS = "\037" }
        {
            ts = $1 + 0; ev = $2; st = $3; oid = $7; sa = $8; du = $9; id = $14
            if (ev == "down" && id != "") { osub[id] = $6; ocl[id] = $4 }
            if (ev == "reclass" && oid != "") { osub[oid] = $6; if ($4 != "") ocl[oid] = $4 }
            if (ev != "down" && oid != "" && du ~ /^[0-9]+$/ && !(oid in done)) {
                done[oid] = 1
                s = (sa ~ /^[0-9]+$/) ? sa + 0 : ts - du
                c = ($4 != "") ? $4 : ocl[oid]
                if (s + du > since) printf "O|%.0f|%s|%s|%s|%s|%s\n", s, ymd(s), mins(du), f(c), f(osub[oid]), f(oid)
            }
            pl = (st == "stopped" || st == "starting")
            if (p0 != "" && (!pl || ev == "recorder_start")) {
                if (ev != "recorder_start") {
                    e = ts
                    if (ev == "down" && sa ~ /^[0-9]+$/ && sa + 0 < e) e = sa + 0
                    if (e < p0) e = p0
                    if (e > since) printf "P|%.0f|%s|%s|%s\n", p0, ymd(p0), mins(e - p0), f(pid0)
                }
                p0 = ""
            }
            # A span opens only where the state ENTERS stopped/starting from a
            # row in view. Row 1 (the read window starts in an older file) and
            # the rows after it in the same span may sit inside a span whose
            # opener is out of view: their ids would give it a second src.
            if (pl && !ppl && p0 == "" && ev != "recorder_start" && NR > 1) { p0 = ts; pid0 = id }
            ppl = (ev == "recorder_start") ? 0 : pl
        }' \
    | sort -t '|' -k2,2nr
}

# gnp_chain_json <net> → {"lines":N,"head":"<sha256 hex>"|null} over the
# COMPLETE lines of public/history.jsonl. A trailing fragment with no newline
# is not part of the chain and is ignored here.
gnp_chain_json() {
    local f n last h
    f="$(gnp_public_dir "$1")/history.jsonl"
    if [[ ! -f "$f" || -L "$f" ]]; then printf '{"lines":0,"head":null}'; return 0; fi
    n=$(wc -l < "$f" 2>/dev/null | tr -dc '0-9'); n=$(( 10#${n:-0} ))
    if (( n == 0 )); then printf '{"lines":0,"head":null}'; return 0; fi
    last=$(head -n "$n" -- "$f" 2>/dev/null | tail -n 1)
    h=$(printf '%s' "$last" | sha256sum 2>/dev/null | cut -c1-64)
    [[ "$h" =~ ^[0-9a-f]{64}$ ]] || { printf '{"lines":%d,"head":null}' "$n"; return 0; }
    printf '{"lines":%d,"head":"%s"}' "$n" "$h"
}

# gnp_project <net> [now] → availability.json (one line) on stdout. Pure read:
# writes nothing. rc 1 only for a bad net.
gnp_project() {
    local net="$1" now="${2:-}" st state upd us up_days=null gen row
    local outs="" plans="" no=0 np=0 kind err
    _gnp_valid_net "$net" || return 1
    [[ "$now" =~ ^[0-9]+$ ]] || now=$(_gne_now)
    st=$(dgr_status_line "$net")
    state=$(_gnp_state_label "$(_gne_jget "$st" state)")
    upd=$(_gne_int "$(_gne_jget "$st" updated)")
    if [[ -z "$upd" ]] || (( now - upd > DGR_STALE_S )); then state=unknown; fi
    if [[ "$state" == up ]]; then
        us=$(_gne_int "$(_gne_jget "$st" up_since)")
        if [[ -n "$us" ]] && (( us <= now )); then up_days=$(( (now - us) / 86400 )); fi
    fi
    gen=$(date -u -d "@$now" '+%Y-%m-%dT%H:%MZ' 2>/dev/null)
    [[ "$gen" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$ ]] || gen=""
    while IFS='|' read -r -a row; do
        if [[ "${row[0]}" == O ]] && (( no < GNP_LIST_MAX )); then
            kind=$(gnp_kind_label "${row[4]:-}"); err=$(gnp_error_label "${row[5]:-}")
            outs+="${outs:+,}{\"date\":\"${row[2]}\",\"duration_min\":$(( 10#${row[3]} )),\"kind\":$(_gnp_jstr "$kind"),\"error\":$(_gnp_jstr "$err")}"
            no=$(( no + 1 ))
        elif [[ "${row[0]}" == P ]] && (( np < GNP_LIST_MAX )); then
            plans+="${plans:+,}{\"date\":\"${row[2]}\",\"duration_min\":$(( 10#${row[3]} ))}"
            np=$(( np + 1 ))
        fi
    done < <(_gnp_event_rows "$net" "$now" | awk -F'|' '$3 ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/ && $4 ~ /^[0-9]+$/')
    printf '{"v":%d,"net":"%s","generated":%s,"state":"%s","up_days":%s,"windows":%s,"outages":[%s],"planned":[%s],"compactions":%s,"chain":%s,"check":{"method":"get_tip"}}' \
        "$GNP_SCHEMA" "$net" "$(_gnp_jstr "$gen")" "$state" "$up_days" "$(_gnp_windows "$net" "$now")" \
        "$outs" "$plans" "$(_gnp_compactions_json "$net" "$now")" "$(gnp_chain_json "$net")"
}

# gnp_write_availability <net> [now] — project, gate, write public/availability.json.
gnp_write_availability() {
    local js
    js=$(gnp_project "$1" "${2:-}") || return 1
    gnp_write_public "$1" availability.json "$js"
}

# ─── History chain: public/history.jsonl → history.json ─────────────────────
# Line shapes: _GNP_HIST_SHAPES. A torn last line (no newline: a write that
# died mid-line) is cut off before the next append, never chained over; every
# reader already ignores it. State of the loaded chain, set by _gnp_hist_load
# and advanced by _gnp_hist_write: _GNP_H_N (complete lines = next seq),
# _GNP_H_PREV (sha256 of the last line), _GNP_H_SRCS (" src src … ").
GNP_HIST_ADDED=0

GNP_LATE_S=7200          # an event appended this long after it closed is "imported"

# src = the first 16 hex of sha256(salt ‖ key). printf is a builtin, so the
# salt is never on a command line.
_gnp_src_hash() { printf '%s%s' "$_GNP_H_SALT" "$1" | sha256sum 2>/dev/null | cut -c1-16; }

# _gnp_salt_load <net> <may create 0|1> → _GNP_H_SALT (64 hex) from
# <net>/.public_salt. A missing salt is created (random, 0600) only when the
# caller is building a NEW chain; otherwise missing, unreadable or malformed =
# rc 1, and an existing file is never overwritten.
_gnp_salt_load() {
    local f="$GNE_EVENTS_DIR/$1/.public_salt" s="" tmp
    _GNP_H_SALT=""
    if [[ -L "$f" ]]; then _gnp_err "$f is a symlink — refusing to use it."; return 1; fi
    if [[ ! -e "$f" && "${2:-0}" == 1 ]]; then
        s=$(head -c 32 /dev/urandom 2>/dev/null | od -An -tx1 | tr -dc '0-9a-f')
        [[ "$s" =~ ^[0-9a-f]{64}$ ]] || { _gnp_err "Cannot read /dev/urandom."; return 1; }
        tmp=$(mktemp "$f.XXXXXX" 2>/dev/null) || { _gnp_err "Cannot write the salt beside $f."; return 1; }
        printf '%s\n' "$s" > "$tmp" 2>/dev/null || { rm -f -- "$tmp" 2>/dev/null; _gnp_err "Cannot write $tmp."; return 1; }
        chmod 600 "$tmp" 2>/dev/null || { rm -f -- "$tmp" 2>/dev/null; _gnp_err "Cannot chmod $tmp."; return 1; }
        mv -f -- "$tmp" "$f" 2>/dev/null || { rm -f -- "$tmp" 2>/dev/null; _gnp_err "Cannot create $f."; return 1; }
    fi
    s=""
    { read -r s; } 2>/dev/null < "$f"
    if [[ ! "$s" =~ ^[0-9a-f]{64}$ ]]; then
        _gnp_err "$f is missing or unreadable — restore it with history.jsonl; nothing appended or published."
        return 1
    fi
    _GNP_H_SALT="$s"
}

_gnp_sha_line() { printf '%s' "$1" | sha256sum 2>/dev/null | cut -c1-64; }

# _gnp_hist_load <file> — cut off a torn tail, then load the chain state. rc 1
# when the file cannot be used: a symlink, or a last line that is not the
# next seq (the chain is damaged; gnp_verify_chain says where).
_gnp_hist_load() {
    local f="$1" n keep last tb
    _GNP_H_N=0; _GNP_H_PREV=""; _GNP_H_SRCS=" "
    if [[ -L "$f" ]]; then _gnp_err "$f is a symlink — refusing to use it."; return 1; fi
    [[ -s "$f" ]] || return 0
    n=$(wc -l < "$f" 2>/dev/null | tr -dc '0-9'); n=$(( 10#${n:-0} ))
    tb=$(tail -c 1 -- "$f" 2>/dev/null | od -An -tx1 | tr -dc '0-9a-f')
    if [[ "$tb" != 0a ]]; then
        keep=$(head -n "$n" -- "$f" 2>/dev/null | wc -c | tr -dc '0-9')
        truncate -s "$(( 10#${keep:-0} ))" -- "$f" 2>/dev/null || { _gnp_err "Cannot cut the torn last line off $f."; return 1; }
        _gnp_err "warning: $f ended in a torn line; it was cut off (the chain keeps $n lines)."
    fi
    (( n > 0 )) || return 0
    last=$(tail -n 1 -- "$f" 2>/dev/null)
    if [[ "$last" != "{\"v\":1,\"seq\":$(( n - 1 )),\"type\":"* ]]; then
        _gnp_err "$f: line $(( n - 1 )) is not seq $(( n - 1 )) — the chain is damaged; nothing appended."
        return 1
    fi
    _GNP_H_PREV=$(_gnp_sha_line "$last")
    [[ "$_GNP_H_PREV" =~ ^[0-9a-f]{64}$ ]] || { _gnp_err "sha256sum failed."; return 1; }
    _GNP_H_SRCS+="$(sed -n 's/.*"src":"\([^"]*\)".*/\1/p' -- "$f" 2>/dev/null | tr '\n' ' ')"
    _GNP_H_N=$n
    return 0
}

# _gnp_hist_write <file> <line> — gate, then ONE printf >> (a line is < 400
# bytes, so the append is a single write). rc 2 = refused by the gate, nothing
# written; rc 1 = the write failed (a torn tail is cut off at the next load).
_gnp_hist_write() {
    local f="$1" line="$2"
    gnp_assert_public history.jsonl "$line" || return 2
    printf '%s\n' "$line" >> "$f" 2>/dev/null || { _gnp_err "Cannot append to $f."; return 1; }
    _GNP_H_PREV=$(_gnp_sha_line "$line")
    _GNP_H_N=$(( _GNP_H_N + 1 ))
    if [[ "$line" =~ \"src\":\"([^\"]+)\" ]]; then _GNP_H_SRCS+="${BASH_REMATCH[1]} "; fi
    GNP_HIST_ADDED=$(( GNP_HIST_ADDED + 1 ))
    return 0
}

# _gnp_hist_put <file> <type> <key> <start epoch> <amount> <imported 0|1> [class] [sub]
# Builds and appends one event line unless its src is already in the chain.
# amount = minutes (outage, planned) or seconds (compaction). key = the ledger
# id (outage_id, or the id of the line that opened a planned span) or a
# compaction's c-<inode>-<offset>; only its salted hash is published. Raw
# class/sub go through the label map here, so no caller can bypass it.
# rc 0 appended or already there · 2 refused input, nothing written · 1 write error.
_gnp_hist_put() {
    local f="$1" type="$2" key="$3" ep="$4" amt="$5" imp="$6" src d mid line
    if [[ ! "$ep" =~ ^[0-9]{1,12}$ || ! "$amt" =~ ^[0-9]{1,8}$ ]]; then _gnp_err "history: bad time or duration."; return 2; fi
    if (( _GNP_H_N == 0 )); then _gnp_err "history: no chain_start yet."; return 1; fi
    if [[ -z "${_GNP_H_SALT:-}" ]]; then _gnp_err "history: no salt loaded."; return 1; fi
    case "$type" in
        outage|planned) [[ "$key" =~ ^[A-Za-z0-9_.-]{1,64}$ ]] || { _gnp_err "history: unusable ledger id."; return 2; } ;;
        compaction)     [[ "$key" =~ ^c-[0-9]{1,20}-[0-9]{1,20}$ ]] || { _gnp_err "history: bad compaction key."; return 2; } ;;
        *) _gnp_err "history: unknown line type '$type'."; return 2 ;;
    esac
    src=$(_gnp_src_hash "$key")
    [[ "$src" =~ ^[0-9a-f]{16}$ ]] || { _gnp_err "sha256sum failed."; return 1; }
    if [[ "$_GNP_H_SRCS" == *" $src "* ]]; then return 0; fi
    d=$(date -u -d "@$ep" '+%Y-%m-%d' 2>/dev/null)
    [[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { _gnp_err "history: cannot date the event."; return 2; }
    amt=$(( 10#$amt ))
    case "$type" in
        outage)     mid="\"duration_min\":$amt,\"kind\":$(_gnp_jstr "$(gnp_kind_label "${7:-}")"),\"error\":$(_gnp_jstr "$(gnp_error_label "${8:-}")")" ;;
        planned)    mid="\"duration_min\":$amt" ;;
        compaction) mid="\"duration_s\":$amt" ;;
    esac
    line="{\"v\":1,\"seq\":$_GNP_H_N,\"type\":\"$type\",\"date\":\"$d\",$mid,\"src\":\"$src\""
    if [[ "$imp" == 1 ]]; then line+=',"imported":true'; fi
    _gnp_hist_write "$f" "$line,\"prev\":\"$_GNP_H_PREV\"}"
}

# gnp_history_sync <net> [now] — append every closed outage and planned span
# of the last 90 d that the chain does not hold yet (by src). With no chain
# yet, it builds a NEW one in a temp file (chain_start, then every closed event
# in the whole ledger marked "imported":true, i.e. written after the fact) and
# moves it in whole, so a half-done backfill is never live. An event appended
# more than GNP_LATE_S after it closed (publishing was off, or a restored
# ledger) is marked imported too. A watchdog restart
# with no down line is not an outage and is not listed. Caller holds
# public/.lock. rc 0 ok (GNP_HIST_ADDED = lines added) · 1 error.
gnp_history_sync() {
    local net="$1" now="${2:-}" d f tgt tmp="" since imp=0 day rc=0 r i
    local -a row
    _gnp_valid_net "$net" || return 1
    [[ "$now" =~ ^[0-9]+$ ]] || now=$(_gne_now)
    _gnp_ensure_dir "$net" || return 1
    d=$(gnp_public_dir "$net"); f="$d/history.jsonl"
    _gnp_hist_load "$f" || return 1
    _gnp_salt_load "$net" $(( _GNP_H_N == 0 )) || return 1
    GNP_HIST_ADDED=0
    if (( _GNP_H_N == 0 )); then
        day=$(date -u -d "@$now" '+%Y-%m-%d' 2>/dev/null)
        tmp=$(mktemp "$d/.history.XXXXXX" 2>/dev/null) || { _gnp_err "Cannot write in $d."; return 1; }
        if ! _gnp_hist_write "$tmp" "{\"v\":1,\"seq\":0,\"type\":\"chain_start\",\"date\":\"$day\",\"prev\":null}"; then
            rm -f -- "$tmp" 2>/dev/null; return 1
        fi
        tgt="$tmp"; since=0; imp=1
    else
        tgt="$f"; since=$(( now - GNP_LIST_DAYS * 86400 ))
    fi
    while IFS='|' read -r -a row; do
        i=$imp
        if (( now - row[1] - row[3] * 60 > GNP_LATE_S )); then i=1; fi
        case "${row[0]}" in
            O) _gnp_hist_put "$tgt" outage "${row[6]:-}" "${row[1]}" "${row[3]}" "$i" "${row[4]:-}" "${row[5]:-}" ;;
            P) _gnp_hist_put "$tgt" planned "${row[4]:-}" "${row[1]}" "${row[3]}" "$i" ;;
            *) continue ;;
        esac
        r=$?
        if (( r == 1 )); then rc=1; break; fi
    done < <(_gnp_event_rows "$net" "$now" "$since" | sort -t '|' -k2,2n -k1,1)
    if [[ -n "$tmp" ]]; then
        if (( rc != 0 )); then rm -f -- "$tmp" 2>/dev/null; GNP_HIST_ADDED=0; return 1; fi
        chmod 644 "$tmp" 2>/dev/null || { rm -f -- "$tmp" 2>/dev/null; _gnp_err "Cannot chmod $tmp."; return 1; }
        mv -f -- "$tmp" "$f" 2>/dev/null || { rm -f -- "$tmp" 2>/dev/null; _gnp_err "Cannot create $f."; return 1; }
    fi
    return "$rc"
}

# gnp_history_append <net> <type> <key> <start epoch> <amount> [imported 0|1] [class] [sub]
# One line onto an EXISTING chain (gnp_history_sync creates it, so the ledger
# backfill is never skipped). Arguments as _gnp_hist_put. Caller holds
# public/.lock. rc 0 appended or already there · 2 refused input · 1 error.
gnp_history_append() {
    local net="$1" f
    _gnp_valid_net "$net" || return 1
    f="$(gnp_public_dir "$net")/history.jsonl"
    _gnp_hist_load "$f" || return 1
    if (( _GNP_H_N == 0 )); then _gnp_err "No history chain for $net yet."; return 1; fi
    _gnp_salt_load "$net" 0 || return 1
    GNP_HIST_ADDED=0
    _gnp_hist_put "$f" "${2:-}" "${3:-}" "${4:-}" "${5:-}" "${6:-0}" "${7:-}" "${8:-}"
}

# gnp_verify_chain <net> — read-only. Checks every complete line: its shape
# (the public gate), seq = its index, line 0 = chain_start with prev null,
# each prev = sha256 of the line before, and no src twice. Names the altered
# line: an edit inside line k breaks the link k→k+1 (and k-1→k too when it
# hits k's own prev). An edit of the LAST line breaks no link: only a
# reader who kept the earlier chain head can see it. rc 0 OK · 1 broken/none.
gnp_verify_chain() {
    local net="$1" f line="" k=0 n prev="" s nbad=0 first=-1 who
    local -A seen=() badlink=() badline=()
    _gnp_valid_net "$net" || return 1
    f="$(gnp_public_dir "$net")/history.jsonl"
    if [[ -L "$f" || ! -s "$f" ]]; then printf 'No history chain for %s.\n' "$net"; return 1; fi
    while IFS= read -r line; do
        if ! gnp_assert_public history.jsonl "$line" 2>/dev/null; then
            badline[$k]=1; printf 'line %d: not a valid public history line\n' "$k"
        fi
        if [[ "$line" != "{\"v\":1,\"seq\":$k,"* ]]; then badline[$k]=1; printf 'line %d: seq is not %d\n' "$k" "$k"; fi
        if (( k == 0 )); then
            if [[ "$line" != *'"type":"chain_start",'*',"prev":null}' ]]; then badline[0]=1; printf 'line 0: not a chain_start with prev null\n'; fi
        elif [[ "$line" != *",\"prev\":\"$prev\"}" ]]; then
            badlink[$k]=1; printf 'line %d: prev is not the sha256 of line %d\n' "$k" $(( k - 1 ))
        fi
        if [[ "$line" =~ \"src\":\"([^\"]+)\" ]]; then
            s="${BASH_REMATCH[1]}"
            if [[ -n "${seen[$s]:-}" ]]; then badline[$k]=1; printf 'line %d: src already on line %s\n' "$k" "${seen[$s]}"; fi
            seen[$s]=$k
        fi
        prev=$(_gnp_sha_line "$line")
        k=$(( k + 1 )); line=""
    done < "$f"
    n=$k
    if [[ -n "$line" ]]; then printf 'warning: a torn last line (%d bytes) is not part of the chain; the next append cuts it off\n' "${#line}"; fi
    for (( k = 0; k < n; k++ )); do
        if [[ -n "${badline[$k]:-}${badlink[$k]:-}" ]]; then
            nbad=$(( nbad + 1 ))
            if (( first < 0 )); then first=$k; fi
        fi
    done
    if (( nbad == 0 )); then printf 'OK: %d lines, head %s\n' "$n" "$prev"; return 0; fi
    # A broken link at k alone (line k itself fine, link k+1 fine) means the
    # bytes of line k-1 changed; otherwise line k itself was edited.
    if [[ -n "${badlink[$first]:-}" && -z "${badline[$first]:-}" && -z "${badlink[$(( first + 1 ))]:-}" ]]; then
        who=$(( first - 1 ))
    else
        who=$first
    fi
    printf 'FAIL: line %d was changed after it was chained (%d of %d lines flagged)\n' "$who" "$nbad" "$n"
    return 1
}

# gnp_history_json <net> → {"v":1,"net":…,"lines":["<raw line>",…]} on stdout:
# the COMPLETE lines, each carried as a string with its quotes escaped, so a
# visitor hashes exactly the chained bytes. Pure read; gnp_write_public gates it.
gnp_history_json() {
    local net="$1" f n out=""
    _gnp_valid_net "$net" || return 1
    f="$(gnp_public_dir "$net")/history.jsonl"
    if [[ -f "$f" && ! -L "$f" ]]; then
        # One pipeline, linear in the chain's size (a bash loop appending to a
        # growing string is quadratic). head -n N drops a torn last line.
        n=$(wc -l < "$f" 2>/dev/null | tr -dc '0-9')
        out=$(head -n "$(( 10#${n:-0} ))" -- "$f" 2>/dev/null | sed 's/"/\\"/g; s/^/"/; s/$/"/' | paste -sd, -)
    fi
    printf '{"v":%d,"net":"%s","lines":[%s]}' "$GNP_SCHEMA" "$net" "$out"
}

# gnp_write_history <net> — render, gate every line, write public/history.json.
gnp_write_history() {
    local js
    js=$(gnp_history_json "$1") || return 1
    gnp_write_public "$1" history.json "$js"
}
