# =============================================================================
# lib/grin_node_public_compact.sh — compaction durations from the node log
# =============================================================================
# Sibling of lib/grin_node_public.sh (which sources it). Two builds of grin log
# a finished compaction, with different units:
#   patch 0002 (scripts/patches/grin/0002-log-compaction-timings.patch)
#       "compact: finished in 41s (txhashset 40s, output_pos index 1s)"
#   PR #3939 (mimblewimble/grin)
#       "compact: finished in 610ms"
# A release build without either logs nothing, and the page then says so.
# "compact: skipping …" lines (debug only) are not compactions and never match.
#
#   gnp_compact_scan <net> <node_dir> [now]   read the new log lines, append
#                                             one history line per compaction
#
# READ-ONLY toward the node: it only reads grin-server.log (and the rolled
# grin-server.log.N.gz copies) and writes <net>/public/.compact_scan, never
# into the node dir, and holds no grin file open between calls. State = the
# log's inode, the byte offset consumed, and a fingerprint of the file's first
# line (an inode number can be reused after a roll). On a roll, the unread tail
# of the old file is taken from the .gz that now holds it (same bytes, found by
# its fingerprint), then any newer rolled file whole, then the live file from 0.
# A first scan reads only the live file; at most GNP_SCAN_MAX_BYTES are read
# and GNP_SCAN_MAX_EVENTS compactions appended per call (each append reloads the
# chain), so a huge log is caught up over a few calls.
#
# Log stamps are the box's LOCAL time; the history line carries the UTC start
# date. A compaction's history key is c-<inode>-<byte offset of its line>, and
# gnp_history_append hashes it, so a re-read never lists one twice.
# Only a line of the exact shape "<date> <time> <LEVEL> grin_chain::… -
# compact: finished in <n>(ms|s)…" counts, so a peer-supplied string inside
# another log line cannot fake one. No log text ever leaves this file.
# Caller holds public/.lock and has run gnp_history_sync (there must be a chain).
# =============================================================================

[[ -n "${_GRIN_NODE_PUBLIC_COMPACT_SH_LOADED:-}" ]] && return 0
_GRIN_NODE_PUBLIC_COMPACT_SH_LOADED=1

GNP_SCAN_MAX_BYTES=67108864   # most of one log read per scan (64 MiB)
GNP_SCAN_MAX_EVENTS=60        # most compactions handed to the chain per scan (each is an append)
GNP_COMPACT_LAST=10           # compactions listed in availability.json
GNP_COMPACT_ADDED=0           # lines this scan handed to the chain (incl. already known)

# _gnp_fp — stdin → 16 hex of its first line, or "-" when there is none.
_gnp_fp() {
    local l
    l=$(head -c 256 | head -n 1)
    if [[ -z "$l" ]]; then printf -- '-'; return 0; fi
    printf '%s' "$l" | sha256sum | cut -c1-16
}

# _gnp_scan_state <net> — loads public/.compact_scan into _GNP_SC_INO/OFF/FP/LOGGED
# (empty when absent or malformed: the scan then starts from the live file's top).
_gnp_scan_state() {
    local f a="" b="" c="" d="" e=""
    f="$(gnp_public_dir "$1")/.compact_scan"
    _GNP_SC_INO=""; _GNP_SC_OFF=0; _GNP_SC_FP=""; _GNP_SC_LOGGED=0
    if [[ -f "$f" && ! -L "$f" ]]; then read -r a b c d e < "$f" 2>/dev/null || true; fi
    if [[ "$a" == v1 && "$b" =~ ^[0-9]{1,20}$ && "$c" =~ ^[0-9]{1,15}$ && "$d" =~ ^([0-9a-f]{16}|-)$ && "$e" =~ ^[01]$ ]]; then
        _GNP_SC_INO="$b"; _GNP_SC_OFF="$c"; _GNP_SC_FP="$d"; _GNP_SC_LOGGED="$e"
    fi
    return 0
}

# _gnp_scan_save <net> <inode> <offset> <fp> <logged>
_gnp_scan_save() {
    local d tmp
    d=$(gnp_public_dir "$1")
    tmp=$(mktemp "$d/.compact_scan.XXXXXX" 2>/dev/null) || { _gnp_err "Cannot write in $d."; return 1; }
    printf 'v1 %s %s %s %s\n' "$2" "$3" "$4" "$5" > "$tmp" 2>/dev/null \
        || { rm -f -- "$tmp" 2>/dev/null; _gnp_err "Cannot write $tmp."; return 1; }
    chmod 600 "$tmp" 2>/dev/null || { rm -f -- "$tmp" 2>/dev/null; _gnp_err "Cannot chmod $tmp."; return 1; }
    mv -f -- "$tmp" "$d/.compact_scan" 2>/dev/null \
        || { rm -f -- "$tmp" 2>/dev/null; _gnp_err "Cannot replace $d/.compact_scan."; return 1; }
    return 0
}

# _gnp_scan_read <label> <offset> <max bytes> <path> [gz]
# Reads the COMPLETE lines of <path> from <offset>. A last line that has no
# newline yet (or was cut by the byte cap) is left for the next scan: the
# stream ends in a random token, so that line shows up glued to it.
# Sets _GNP_SC_USED (bytes consumed), _GNP_SC_SEEN (a "compact: starting" or
# "finished" line was there) and appends "<label>|<offset>|<stamp>|<seconds>"
# to _GNP_SC_EV. rc 1 when the stream never reached its end token.
_gnp_scan_read() {
    local lbl="$1" off="$2" max="$3" p="$4" gz="${5:-}" tok out t a b c ok=0 room=$(( GNP_SCAN_MAX_EVENTS - ${#_GNP_SC_EV[@]} ))
    tok="GNPEND$RANDOM$RANDOM$RANDOM"
    _GNP_SC_USED=0; _GNP_SC_SEEN=0; _GNP_SC_CUT=0
    out=$({
        if [[ "$gz" == gz ]]; then zcat -- "$p" 2>/dev/null | tail -c +$(( off + 1 )) | head -c "$max"
        else tail -c +$(( off + 1 )) -- "$p" 2>/dev/null | head -c "$max"; fi
        printf '%s\n' "$tok"
    } | LC_ALL=C awk -v tok="$tok" -v base="$off" -v room="$room" '
        BEGIN { pos = 0; seen = 0; nev = 0; lim = length(tok) }
        {
            n = length($0)
            if (n >= lim && substr($0, n - lim + 1) == tok) { printf "E|%.0f|%d|0\n", pos, seen; done = 1; exit }
            if ($1 ~ /^[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]$/ && $2 ~ /^[0-9][0-9]:[0-9][0-9]:[0-9][0-9]/ \
                && $4 ~ /^grin_chain::/ && $5 == "-" && $6 == "compact:") {
                if ($7 == "starting") seen = 1
                else if ($7 == "finished" && $8 == "in" && $9 ~ /^[0-9][0-9]*(ms|s)$/ && length($9) <= 12) {
                    seen = 1
                    if ($9 ~ /ms$/) v = int(substr($9, 1, length($9) - 2) / 1000 + 0.5)
                    else v = substr($9, 1, length($9) - 1) + 0
                    if (v <= 9999999) {
                        printf "F|%.0f|%s-%s-%s %s|%.0f\n", base + pos, substr($1, 1, 4), substr($1, 5, 2), substr($1, 7, 2), substr($2, 1, 8), v
                        if (++nev >= room) { printf "E|%.0f|%d|1\n", pos + n + 1, seen; done = 1; exit }
                    }
                }
            }
            pos += n + 1
        }
        END { if (!done) print "X" }')
    while IFS='|' read -r t a b c; do
        case "$t" in
            F) _GNP_SC_EV+=("$lbl|$a|$b|$c") ;;
            E) _GNP_SC_USED="$a"; _GNP_SC_SEEN="$b"; _GNP_SC_CUT="$c"; ok=1 ;;
        esac
    done <<< "$out"
    (( ok == 1 ))
}

# gnp_compact_scan <net> <node_dir> [now] — rc 0 ok (state saved, or nothing to
# save yet) · 1 error (nothing saved: the next scan repeats it, and the chain's
# dedupe absorbs the repeat). GNP_COMPACT_ADDED counts the compactions it handed
# to the chain.
gnp_compact_scan() {
    local net="$1" dir="${2:-}" now="${3:-}" lf ino ino2 fp g gfp line label from sorted
    local st_ino st_off st_fp logged matched=0 budget="$GNP_SCAN_MAX_BYTES" r ev end rc secs
    local n_ino n_off n_fp rolled=0 hold=0
    local -a gzs=() eps=() ev_parts
    _gnp_valid_net "$net" || return 1
    [[ "$now" =~ ^[0-9]+$ ]] || now=$(_gne_now)
    GNP_COMPACT_ADDED=0
    [[ -n "$dir" && -d "$dir" ]] || return 0
    lf=$(_gne_node_logfile "$dir")
    [[ -f "$lf" ]] || return 0
    _gnp_ensure_dir "$net" || return 1
    _gnp_scan_state "$net"
    st_ino="$_GNP_SC_INO"; st_off="$_GNP_SC_OFF"; st_fp="$_GNP_SC_FP"; logged="$_GNP_SC_LOGGED"
    ino=$(stat -c %i -- "$lf" 2>/dev/null); [[ "$ino" =~ ^[0-9]{1,20}$ ]] || return 0
    fp=$(_gnp_fp < "$lf")
    _GNP_SC_EV=()
    n_ino="$ino"; n_off=0; n_fp="$fp"
    if [[ -n "$st_ino" ]]; then
        if [[ "$st_ino" != "$ino" || ( "$st_fp" != - && "$st_fp" != "$fp" ) ]] \
            || (( $(stat -c %s -- "$lf" 2>/dev/null || echo 0) < st_off )); then
            rolled=1
        else
            n_off="$st_off"
        fi
    fi
    if (( rolled )); then
        # The file we were reading rolled: its bytes are in a .gz now, found by fingerprint.
        for g in "$lf".[0-9]*.gz; do
            if [[ -f "$g" && "$g" =~ \.([0-9]+)\.gz$ ]]; then gzs+=("${BASH_REMATCH[1]} $g"); fi
        done
        sorted=""
        if (( ${#gzs[@]} > 0 )); then sorted=$(printf '%s\n' "${gzs[@]}" | sort -rn -k1,1); fi   # oldest roll first
        while IFS= read -r line; do
            [[ -n "$line" ]] || continue
            g="${line#* }"
            gfp=$(zcat -- "$g" 2>/dev/null | _gnp_fp)
            if (( matched == 0 )); then
                [[ "$st_fp" != - && "$gfp" == "$st_fp" ]] || continue
                matched=1; label="$st_ino"; from="$st_off"
            else
                [[ "$gfp" != - ]] || continue
                label=$(( 0x${gfp:0:12} )); from=0
            fi
            _gnp_scan_read "$label" "$from" "$budget" "$g" gz || { _gnp_err "compaction scan: cannot read $g."; return 1; }
            budget=$(( budget - _GNP_SC_USED )); [[ "$_GNP_SC_SEEN" == 1 ]] && logged=1
            if (( budget < 1048576 || _GNP_SC_CUT == 1 )); then
                # Byte or event cap: save THIS rolled file as the one being read (label =
                # its key's inode part, fp = how the next scan finds it), so it resumes here.
                n_ino="$label"; n_off=$(( from + _GNP_SC_USED )); n_fp="$gfp"; hold=1
                break
            fi
        done <<< "$sorted"
    fi
    if (( hold == 0 )); then
        _gnp_scan_read "$ino" "$n_off" "$budget" "$lf" || { _gnp_err "compaction scan: cannot read the node log."; return 1; }
        n_off=$(( n_off + _GNP_SC_USED )); [[ "$_GNP_SC_SEEN" == 1 ]] && logged=1
        ino2=$(stat -c %i -- "$lf" 2>/dev/null)
        [[ "$ino2" == "$ino" ]] || return 0      # rolled while reading: redo next scan
    fi
    # Local log stamps → epochs in one date call; per line if any stamp is unusable.
    if (( ${#_GNP_SC_EV[@]} > 0 )); then
        for ev in "${_GNP_SC_EV[@]}"; do IFS='|' read -r -a ev_parts <<< "$ev"; eps+=("${ev_parts[2]}"); done
        mapfile -t eps < <(printf '%s\n' "${eps[@]}" | date -f - '+%s' 2>/dev/null)
        if (( ${#eps[@]} != ${#_GNP_SC_EV[@]} )); then
            eps=()
            for ev in "${_GNP_SC_EV[@]}"; do
                IFS='|' read -r -a ev_parts <<< "$ev"
                eps+=("$(date -d "${ev_parts[2]}" '+%s' 2>/dev/null)")
            done
        fi
        r=0
        for ev in "${_GNP_SC_EV[@]}"; do
            IFS='|' read -r -a ev_parts <<< "$ev"
            secs="${ev_parts[3]}"; end="${eps[$r]:-}"; r=$(( r + 1 ))
            if [[ ! "$end" =~ ^[0-9]{1,12}$ ]] || (( end < secs )); then continue; fi
            logged=1; rc=0
            gnp_history_append "$net" compaction "c-${ev_parts[0]}-${ev_parts[1]}" $(( end - secs )) "$secs" \
                $(( now - end > GNP_LATE_S ? 1 : 0 )) 2>/dev/null || rc=$?
            if (( rc == 1 )); then _gnp_err "compaction scan: the history chain refused a line."; return 1; fi
            GNP_COMPACT_ADDED=$(( GNP_COMPACT_ADDED + 1 ))
        done
    fi
    _gnp_scan_save "$net" "$n_ino" "$n_off" "$n_fp" "$logged"
}

# _gnp_compactions_json <net> [now] — the compactions object of availability.json,
# built from the compaction lines already in public/history.jsonl (UTC start
# date and whole seconds, nothing else): the newest GNP_COMPACT_LAST, and
# count / median / max over the last 30 days. logged:false = the log never
# showed a compaction line, i.e. this grin build does not log them.
_gnp_compactions_json() {
    local net="$1" now="${2:-}" f n logged=0 rows last="" cut vals cnt=0 med=null mx=null line d s a b
    local -a v
    [[ "$now" =~ ^[0-9]+$ ]] || now=$(_gne_now)
    f="$(gnp_public_dir "$net")/history.jsonl"
    _gnp_scan_state "$net"; logged="$_GNP_SC_LOGGED"
    if [[ -f "$f" && ! -L "$f" ]]; then
        n=$(wc -l < "$f" 2>/dev/null | tr -dc '0-9')
        rows=$(head -n "${n:-0}" -- "$f" 2>/dev/null | grep -a '"type":"compaction"' \
            | sed -n 's/^.*"date":"\([0-9-]*\)","duration_s":\([0-9]*\),.*$/\1 \2/p')
    fi
    if [[ -n "${rows:-}" ]]; then
        logged=1
        while read -r d s; do
            [[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ && "$s" =~ ^[0-9]{1,8}$ ]] || continue
            last+="${last:+,}{\"date\":\"$d\",\"duration_s\":$(( 10#$s ))}"
        done < <(printf '%s\n' "$rows" | tac | sort -s -k1,1r | head -n "$GNP_COMPACT_LAST")
        cut=$(date -u -d "@$(( now - 30 * 86400 ))" '+%Y-%m-%d' 2>/dev/null)
        vals=$(printf '%s\n' "$rows" | awk -v c="$cut" '$1 >= c && $2 ~ /^[0-9]+$/ { print $2 + 0 }' | sort -n)
        if [[ -n "$vals" ]]; then
            mapfile -t v <<< "$vals"
            cnt=${#v[@]}; mx="${v[cnt-1]}"
            a="${v[(cnt-1)/2]}"; b="${v[cnt/2]}"; med=$(( (a + b + 1) / 2 ))
        fi
    fi
    if (( logged == 1 )); then
        printf '{"logged":true,"last":[%s],"d30":{"count":%d,"median_s":%s,"max_s":%s}}' "$last" "$cnt" "$med" "$mx"
    else
        printf '{"logged":false,"last":[],"d30":{"count":0,"median_s":null,"max_s":null}}'
    fi
}
