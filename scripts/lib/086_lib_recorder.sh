# =============================================================================
# lib/086_lib_recorder.sh — 086's read side of the node event recorder
# =============================================================================
# Design: docs/generated/script086_design.md §8.12 (+ as-built §8.18). The
# recorder itself is lib/grin_node_events.sh; this lib only READS what it
# writes (ledger.jsonl, status.json, evidence/) and turns that into the 086
# sub-menu's timeline, availability summary, evidence list and masked export.
# Nothing here signals a node or writes under /opt/grin/node-events/.
#
#   dgr_nets                  nets that have a recorder dir
#   dgr_status_get <net> <k>  one flat key from status.json
#   dgr_ledger_cat <net> <since>   ledger lines oldest first, across rotations
#   dgr_parse                 ledger JSON (stdin) → \037-separated rows
#   dgr_timeline_rows <net> <n>    the last n rows + each outage's duration
#   dgr_availability <net> <now>   7 / 30 / 90 d sums (key=value lines)
#   dgr_bundles               evidence bundles, newest first
#   dgr_export <dest> <bundle path>...   masked copy + tarball
#   dgr_support_section       status + last 20 ledger lines (086's bundle)
#
# Conventions: sourced lib → NO shebang / NO `set -e`; reached through `fn ||
# true` menu arms, so errexit is OFF here and every create/copy/move/delete
# carries its own guard (project_lib_errexit_suppression). Awk is mawk-safe:
# no gensub/asort/length(array), no {n} intervals, numbers printed with %.0f
# (mawk prints a large integral number in %.6g otherwise).
# Rows are \037 (unit separator)-delimited, NOT tab: `read` with IFS=$'\t'
# collapses consecutive tabs (tab is IFS whitespace), so an empty field would
# shift every column after it.
# =============================================================================

[[ -n "${_086_LIB_RECORDER_LOADED:-}" ]] && return 0
_086_LIB_RECORDER_LOADED=1

# shellcheck source=grin_node_events.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/grin_node_events.sh"

DGR_SEP=$'\037'
DGR_STALE_S=120          # status.json older than this = the recorder is not running (§8.8)
DGR_WINDOWS="7 30 90"    # availability windows, days

dgr_installed() { [[ -x "$GNE_BIN" ]]; }
dgr_timer_active() { systemctl is-active --quiet grin-node-events.timer 2>/dev/null; }

dgr_nets() {
    local n
    for n in "${GNE_NETS[@]}"; do
        if [[ -f "$GNE_EVENTS_DIR/$n/status.json" || -f "$GNE_EVENTS_DIR/$n/ledger.jsonl" ]]; then echo "$n"; fi
    done
    return 0
}

dgr_status_line() { # <net> → the one-line status.json (empty when absent)
    local s=""
    if [[ -f "$GNE_EVENTS_DIR/$1/status.json" ]]; then read -r s 2>/dev/null < "$GNE_EVENTS_DIR/$1/status.json" || true; fi
    printf '%s' "$s"
}
dgr_status_get() { _gne_jget "$(dgr_status_line "$1")" "$2"; }

dgr_utc()     { date -u -d "@$1" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || printf '%s' "$1"; }
dgr_utc_min() { date -u -d "@$1" '+%Y-%m-%d %H:%M' 2>/dev/null || printf '%s' "$1"; }
dgr_dur()     { _gne_fmt_dur "$1"; }

# ── Ledger reading ───────────────────────────────────────────────────────────
_dgr_cat1() { case "$1" in *.gz) gzip -dc -- "$1" 2>/dev/null ;; *) cat -- "$1" 2>/dev/null ;; esac; }
_dgr_first_ts() {
    local l=""
    l=$(_dgr_cat1 "$1" | head -n 1)
    [[ "$l" =~ \"ts\":([0-9]+) ]] && printf '%s' "${BASH_REMATCH[1]}"
    return 0
}

# dgr_ledger_cat <net> <since_epoch> — the ledger from the newest file back,
# adding logrotate's older files (ledger.jsonl.1, .2.gz, …) only until one
# starts at or before <since>. One line before the window is what tells the
# availability walk which state the window opened in.
dgr_ledger_cat() {
    local d="$GNE_EVENTS_DIR/$1" since="${2:-0}" i f ft
    local -a files=()
    [[ -f "$d/ledger.jsonl" ]] && files=("$d/ledger.jsonl")
    for (( i = 1; i <= 50; i++ )); do
        if (( ${#files[@]} )); then
            ft=$(_dgr_first_ts "${files[0]}")
            if [[ -n "$ft" ]] && (( ft <= since )); then break; fi
        fi
        if   [[ -f "$d/ledger.jsonl.$i" ]];    then f="$d/ledger.jsonl.$i"
        elif [[ -f "$d/ledger.jsonl.$i.gz" ]]; then f="$d/ledger.jsonl.$i.gz"
        else break; fi
        files=("$f" "${files[@]}")
    done
    for f in "${files[@]}"; do _dgr_cat1 "$f"; done
    return 0
}

# dgr_parse — ledger JSON lines (stdin) → rows (stdout), \037-separated:
#  1 ts  2 event  3 state  4 class  5 class_initial  6 sub  7 outage_id
#  8 started_at  9 duration_s  10 by  11 reason  12 evidence  13 observed_gap_s
#  14 id  15 clean_shutdown  16 pid  17 rc  18 grin_version
# null → empty. A line without v:1 and a numeric ts is dropped. Field values
# are the writer's own (§8.8: no log text), unescaped for display.
dgr_parse() {
    awk '
    function jv(s, k,    v, i, c, out) {
        if (!match(s, "[{,]\"" k "\":")) return ""
        v = substr(s, RSTART + RLENGTH)
        if (substr(v, 1, 1) == "\"") {
            out = ""
            for (i = 2; i <= length(v); i++) {
                c = substr(v, i, 1)
                if (c == "\\") { i++; c = substr(v, i, 1); if (c == "n" || c == "t" || c == "r") c = " "; out = out c; continue }
                if (c == "\"") break
                out = out c
            }
            gsub("[\037\t]", " ", out)
            return out
        }
        if (match(v, /^[^,}]*/)) v = substr(v, 1, RLENGTH)
        if (v == "null") return ""
        return v
    }
    BEGIN { OFS = "\037" }
    {
        if (jv($0, "v") != "1") next
        ts = jv($0, "ts"); if (ts !~ /^[0-9]+$/) next
        print ts, jv($0, "event"), jv($0, "state"), jv($0, "class"), jv($0, "class_initial"), \
              jv($0, "sub"), jv($0, "outage_id"), jv($0, "started_at"), jv($0, "duration_s"), \
              jv($0, "by"), jv($0, "reason"), jv($0, "evidence"), jv($0, "observed_gap_s"), \
              jv($0, "id"), jv($0, "clean_shutdown"), jv($0, "pid"), jv($0, "rc"), jv($0, "grin_version")
    }'
}

# dgr_timeline_rows <net> <n> — the last n parsed rows, oldest first, with a
# 19th field: for a `down` row the outage's length ("<seconds>" once a later
# line closed it, "open" while it is still open); empty on other rows.
# Reads the live file plus ledger.jsonl.1 (delaycompress keeps it plain).
dgr_timeline_rows() {
    local d="$GNE_EVENTS_DIR/$1" n="${2:-25}"
    { _dgr_cat1 "$d/ledger.jsonl.1"; _dgr_cat1 "$d/ledger.jsonl"; } | tail -n "$n" | dgr_parse \
    | awk '
        BEGIN { FS = OFS = "\037" }
        { row[NR] = $0; ev[NR] = $2; id[NR] = $14
          if ($2 != "down" && $7 != "" && $9 != "") close_d[$7] = $9 }
        END {
            for (i = 1; i <= NR; i++) {
                x = ""
                if (ev[i] == "down") x = (id[i] in close_d) ? close_d[id[i]] : "open"
                print row[i], x
            }
        }'
}

# dgr_availability <net> <now> — one block of key=value lines per window
# ("win=7 up=… down=… planned=… auth=… unobs=… outages=… mttr_n=… longest=…
# longest_start=… longest_class=… longest_open=… classes=hung:2,… stops=…
# boots=… unclean=… r_watchdog=… r_toolkit=… r_unknown=…"), then "P|ts|by|reason"
# rows (planned stops, newest 15 in the widest window) and "B|ts|clean" rows.
#
# Time is put in exactly one bucket by a sweep over the ledger (§8.4, §8.15):
#   unobs   — a `gap` interval, the stale tail after status.json stopped
#             updating, before the first line, or state unknown/unregistered;
#   down    — inside a counted outage [started_at, started_at + duration_s]
#             (the backdated start is why this is an interval, not a state);
#   planned — state stopped / starting (planned stops, boot + start windows);
#   auth    — state auth_fail (the node answers; a secret is wrong);
#   up      — state up.
# Precedence unobs > down > state, so a gap inside an outage is not downtime.
# A boot that closes an outage leaves its reboot window unobserved, not down.
dgr_availability() {
    local net="$1" now="$2" st upd end_t stale=0 maxd=0 w since
    for w in $DGR_WINDOWS; do (( w > maxd )) && maxd=$w; done
    since=$(( now - maxd * 86400 ))
    st=$(dgr_status_line "$net")
    upd=$(_gne_int "$(_gne_jget "$st" updated)")
    end_t="$now"
    if [[ -n "$upd" ]] && (( now - upd > DGR_STALE_S && upd < now )); then end_t="$upd"; stale=1; fi
    # A ledger with no status.json beside it (restored by 089, recorder never
    # run here): its last line is the last thing anyone observed.
    if [[ -z "$st" ]]; then
        local last=""
        last=$(tail -n 1 "$GNE_EVENTS_DIR/$net/ledger.jsonl" 2>/dev/null)
        if [[ "$last" =~ \"ts\":([0-9]+) ]] && (( BASH_REMATCH[1] < now )); then end_t="${BASH_REMATCH[1]}"; stale=1; fi
    fi
    dgr_ledger_cat "$net" "$since" | dgr_parse \
    | awk -v end_t="$end_t" -v now="$now" -v stale="$stale" '
        BEGIN { FS = OFS = "\037" }
        {
            ts = $1 + 0; ev = $2; st = $3; cl = $4; oid = $7; sa = $8; du = $9; gp = $13; id = $14
            if (have) { print pts, "S+", pst; print ts, "S-", pst }
            # recorder_start = a first run with no status.json (fresh install,
            # or a ledger restored by 089): nothing before it was observed
            # since the previous line, and an outage still open then was never
            # seen to end — it ends at the last line that saw it.
            if (ev == "recorder_start" && have) {
                if (ts > pts) { print pts, "G+"; print ts, "G-" }
                if (cur != "" && !(cur in oe)) oe[cur] = (pts > os[cur]) ? pts : os[cur]
                cur = ""
            }
            pts = ts; pst = st; have = 1
            if (ev == "down" && id != "") {
                if (!(id in os)) { no++; ord[no] = id }
                os[id] = (sa ~ /^[0-9]+$/) ? sa + 0 : ts; ocl[id] = cl; cur = id
            }
            if (ev == "reclass" && (oid in os) && cl != "") ocl[oid] = cl
            if (ev != "down" && oid != "" && du ~ /^[0-9]+$/ && (oid in os)) {
                oe[oid] = os[oid] + du
                if (oid == cur) cur = ""
                if (ev == "boot" && ts > oe[oid]) { print oe[oid], "G+"; print ts, "G-" }
            }
            if (ev == "gap" && gp ~ /^[0-9]+$/ && gp + 0 > 0) { print ts - gp, "G+"; print ts, "G-" }
            if (ev == "stop")  print ts, "P", $10, $11
            if (ev == "boot")  print ts, "B", $15
            if (ev == "start") print ts, "T", $10
            if (ev == "restart_by_watchdog") print ts, "W"
        }
        END {
            if (have && end_t > pts) { print pts, "S+", pst; print end_t, "S-", pst }
            if (stale + 0 && now > end_t) { print end_t, "G+"; print now, "G-" }
            for (i = 1; i <= no; i++) {
                id = ord[i]; e = (id in oe) ? oe[id] : end_t; op = (id in oe) ? 0 : 1
                if (e < os[id]) e = os[id]
                print os[id], "D+"; print e, "D-"
                print os[id], "O", os[id], e, ocl[id], op
            }
        }' \
    | sort -t "$DGR_SEP" -k1,1n \
    | awk -v now="$now" -v wins="$DGR_WINDOWS" '
        function bucket(   s) {
            if (gc > 0) return "unobs"
            if (dc > 0) return "down"
            for (s in sc) if (sc[s] > 0) {
                if (s == "up") return "up"
                if (s == "down") return "down"
                if (s == "stopped" || s == "starting") return "planned"
                if (s == "auth_fail") return "auth"
                return "unobs"
            }
            return "unobs"
        }
        function measure(a, b,   k, lo, hi, bk) {
            bk = bucket()
            for (k = 1; k <= nw; k++) {
                lo = (a > w0[k]) ? a : w0[k]; hi = (b < now) ? b : now
                if (hi > lo) acc[k, bk] += hi - lo
            }
        }
        BEGIN {
            FS = "\037"; nw = split(wins, W, " "); wmax = 1
            for (k = 1; k <= nw; k++) { w0[k] = now - W[k] * 86400; if (W[k] + 0 > W[wmax] + 0) wmax = k }
        }
        {
            t = $1 + 0
            if (started && t > prev) measure(prev, t)
            if (!started || t > prev) prev = t
            started = 1
            kd = $2
            if (kd == "S+") sc[$3]++
            else if (kd == "S-") sc[$3]--
            else if (kd == "D+") dc++
            else if (kd == "D-") dc--
            else if (kd == "G+") gc++
            else if (kd == "G-") gc--
            else if (kd == "O") {
                s = $3 + 0; e = $4 + 0; c = ($5 == "") ? "unknown" : $5
                for (k = 1; k <= nw; k++) {
                    if (e <= w0[k] && $6 != 1) continue
                    if (s > now) continue
                    cnt[k]++; ccls[k, c]++
                    if (!((k, c) in seen)) { seen[k, c] = 1; clist[k] = clist[k] (clist[k] == "" ? "" : " ") c }
                    if (s >= w0[k]) started_in[k]++
                    if (!(k in lg) || e - s > lg[k]) { lg[k] = e - s; lgs[k] = s; lgc[k] = c; lgo[k] = $6 }
                }
            }
            else if (kd == "P" || kd == "B" || kd == "T" || kd == "W") {
                if (t > now) next
                for (k = 1; k <= nw; k++) {
                    if (t < w0[k]) continue
                    if (kd == "P") stops[k]++
                    if (kd == "B") { boots[k]++; if ($3 == "false") unclean[k]++ }
                    if (kd == "W") rw[k]++
                    if (kd == "T") {
                        if ($3 == "" || $3 == "unknown") ru[k]++
                        else if ($3 != "grin-node-sync-watchdog" && $3 != "boot_autostart") rt[k]++
                    }
                }
                if (t >= w0[wmax]) {
                    if (kd == "P") { np++; pl[np] = "P|" $1 "|" $3 "|" $4 }
                    if (kd == "B") { nb++; bl[nb] = "B|" $1 "|" $3 }
                }
            }
        }
        END {
            if (started && now > prev) measure(prev, now)
            for (k = 1; k <= nw; k++) {
                cls = ""; n = split(clist[k], cl, " ")
                for (j = 1; j <= n; j++) cls = cls (cls == "" ? "" : ",") cl[j] ":" ccls[k, cl[j]]
                up = acc[k, "up"] + 0; dn = acc[k, "down"] + 0; pl_ = acc[k, "planned"] + 0; au = acc[k, "auth"] + 0
                un = W[k] * 86400 - up - dn - pl_ - au; if (un < 0) un = 0
                printf "win=%s up=%.0f down=%.0f planned=%.0f auth=%.0f unobs=%.0f outages=%d started=%d", \
                    W[k], up, dn, pl_, au, un, cnt[k] + 0, started_in[k] + 0
                if (k in lg) printf " longest=%.0f longest_start=%.0f longest_class=%s longest_open=%d", lg[k], lgs[k], lgc[k], lgo[k]
                printf " classes=%s stops=%d boots=%d unclean=%d r_watchdog=%d r_toolkit=%d r_unknown=%d\n", \
                    cls, stops[k] + 0, boots[k] + 0, unclean[k] + 0, rw[k] + 0, rt[k] + 0, ru[k] + 0
            }
            for (i = np; i >= 1 && i > np - 15; i--) print pl[i]
            for (i = nb; i >= 1 && i > nb - 15; i--) print bl[i]
        }'
}

# ── Evidence bundles ─────────────────────────────────────────────────────────
# dgr_bundles → "name|net|path|kb|class" lines, newest first (bundle names
# start with their UTC stamp, so a reverse name sort is a time sort).
dgr_bundles() {
    local net b name kb
    for net in "${GNE_NETS[@]}"; do
        for b in "$GNE_EVENTS_DIR/$net/evidence"/*; do
            [[ -d "$b" && ! -L "$b" ]] || continue
            name="${b##*/}"
            [[ "$name" =~ $_GNE_BUNDLE_RE ]] || continue
            kb=$(du -sk -- "$b" 2>/dev/null | cut -f1)
            printf '%s|%s|%s|%s|%s\n' "$name" "$net" "$b" "${kb:-0}" "$(sed -E 's/^[0-9T]+Z_//; s/-[0-9]$//' <<< "$name")"
        done
    done | sort -r -t '|' -k1,1
    return 0
}

# dgr_mask <protect...> — stdin → stdout, for files that leave the box (an
# upstream issue is public). 086's dg_maskip, then the /24 it keeps is masked
# too (a peer's /24 is still a fingerprint in a public post), then dg_redact.
# Each <protect> string (a bundle name — 20+ chars, so dg_redact would eat it)
# is swapped out before redaction and back after.
dgr_mask() {
    local -a pre=() post=() host=()
    local p i=0 hs hf
    for p in "$@"; do
        [[ -n "$p" && "$p" =~ ^[A-Za-z0-9_-]+$ ]] || continue
        pre+=(-e "s/$p/@@DGRKEEP${i}@@/g"); post+=(-e "s/@@DGRKEEP${i}@@/$p/g")
        i=$(( i + 1 ))
    done
    # The box's own name, wherever a shell prompt or a path printed it. A short
    # or generic name ("node", "debian") would mangle ordinary words, so only a
    # name of 5+ characters that is not a common word is replaced.
    hs=$(hostname -s 2>/dev/null || true); hf=$(hostname -f 2>/dev/null || true)
    if [[ ${#hf} -ge 5 && "$hf" =~ ^[A-Za-z0-9.-]+$ && "$hf" == *.* ]]; then
        host+=(-e "s/${hf//./[.]}/<host>/g")
    fi
    case "${hs,,}" in localhost|debian|ubuntu|server|rocky|almalinux|grinnode) hs="" ;; esac
    if [[ ${#hs} -ge 5 && "$hs" =~ ^[A-Za-z0-9-]+$ ]]; then
        host+=(-e "s/(^|[^A-Za-z0-9_-])$hs([^A-Za-z0-9_-]|$)/\\1<host>\\2/g")
    fi
    {
        if (( ${#pre[@]} )); then sed -E "${pre[@]}"; else cat; fi
    } | { if (( ${#host[@]} )); then sed -E "${host[@]}"; else cat; fi; } \
      | dg_maskip \
      | sed -E 's/\b[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.x\b/x.x.x.x/g; s/\b[0-9a-fA-F]{1,4}:[0-9a-fA-F]{1,4}:[0-9a-fA-F]{1,4}:x\b/ipv6/g' \
      | dg_redact \
      | { if (( ${#post[@]} )); then sed -E "${post[@]}"; else cat; fi; }
}

# dgr_export <out.tar.gz> <bundle_path>... — masked copies of the bundles, the
# matching nets' status.json and last 200 ledger lines, and a README, into one
# tarball (0600). rc 1 = nothing written.
dgr_export() {
    local out="$1"; shift
    local stage root b name net f nets=" " n=0
    # Inside 086's DG_TMP when there is one: its EXIT trap then also cleans up
    # a staging dir that a Ctrl+C left behind.
    stage=$(mktemp -d "${DG_TMP:-${TMPDIR:-/tmp}}/grin-events-export.XXXXXX") || { error "mktemp failed."; return 1; }
    chmod 700 "$stage" 2>/dev/null || true
    root="grin_node_events_export_$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -p "$stage/$root" || { error "Cannot create the staging dir."; rm -rf -- "$stage"; return 1; }
    for b in "$@"; do
        [[ -d "$b" ]] || continue
        name="${b##*/}"; net=$(basename "$(dirname "$(dirname "$b")")")
        [[ "$name" =~ $_GNE_BUNDLE_RE && "$net" =~ ^(mainnet|testnet)$ ]] || continue
        [[ "$nets" == *" $net "* ]] || nets+="$net "
        n=$(( n + 1 ))
        mkdir -p "$stage/$root/$net/$name" || { error "Cannot stage $name."; rm -rf -- "$stage"; return 1; }
        for f in "$b"/*; do
            [[ -f "$f" && ! -L "$f" ]] || continue
            dgr_mask "$name" < "$f" > "$stage/$root/$net/$name/${f##*/}" 2>/dev/null \
                || { error "Cannot mask ${f##*/} of $name."; rm -rf -- "$stage"; return 1; }
        done
    done
    (( n )) || { error "None of the chosen bundles exists any more."; rm -rf -- "$stage"; return 1; }
    for net in $nets; do
        # The ledger and status hold no log text and no IPs by construction
        # (§8.8). Masked for IPs anyway, NOT redacted: ids and bundle names are
        # 20+ characters and are the whole point of these two files.
        dgr_status_line "$net" | dg_maskip > "$stage/$root/$net/status.json" 2>/dev/null || true
        tail -n 200 "$GNE_EVENTS_DIR/$net/ledger.jsonl" 2>/dev/null | dg_maskip > "$stage/$root/$net/ledger_last200.jsonl" || true
    done
    {
        echo "Grin node event recorder — export for an upstream report"
        echo "created : $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
        echo "toolkit : Grin Node Toolkit, 086 Diagnostics → Node event recorder"
        echo "kernel  : $(uname -sr 2>/dev/null)"
        for net in $nets; do echo "grin $net: $(dgr_status_get "$net" grin_version)"; done
        echo ""
        echo "Each <net>/<bundle>/ is one evidence bundle (086 design §8.9). Start with"
        echo "summary.txt. The class it names is a LEAN, not a verdict."
        echo ""
        echo "MASKED: IPv4/IPv6 addresses (fully), this host's name, key=value secrets"
        echo "and any token of 20+ characters (block hashes included). NOT masked:"
        echo "other hostnames and domains that appear in logs."
    } > "$stage/$root/README.txt" || { error "Cannot write the README."; rm -rf -- "$stage"; return 1; }
    # umask first: the tarball holds raw-ish evidence until the chmod lands.
    ( umask 077; tar -czf "$out" -C "$stage" "$root" ) 2>/dev/null \
        || { error "tar failed."; rm -f -- "$out"; rm -rf -- "$stage"; return 1; }
    chmod 600 "$out" 2>/dev/null || true
    rm -rf -- "$stage" 2>/dev/null || true
    return 0
}

# dgr_support_section — for 086's support bundle: install state, then per net
# status.json and the last 20 ledger lines. IP-masked; not redacted (see above).
dgr_support_section() {
    local net
    dg_sec "NODE EVENT RECORDER (086 design §8)"
    if dgr_installed; then
        echo "worker : $GNE_BIN (installed)   timer: $(systemctl is-active grin-node-events.timer 2>/dev/null || echo unknown)"
    else
        echo "worker : not installed (086 → 7 → I)"
    fi
    for net in "${GNE_NETS[@]}"; do
        [[ -d "$GNE_EVENTS_DIR/$net" ]] || continue
        dg_sub "$net status.json"
        dgr_status_line "$net" | dg_maskip; echo ""
        dg_sub "$net ledger, last 20 lines"
        tail -n 20 "$GNE_EVENTS_DIR/$net/ledger.jsonl" 2>/dev/null | dg_maskip || echo "(no ledger)"
        dg_sub "$net evidence bundles"
        ls -1 "$GNE_EVENTS_DIR/$net/evidence" 2>/dev/null | tail -n 20 || echo "(none)"
    done
    return 0
}
