# =============================================================================
# lib/086_lib_diag.sh — probes and collectors for 086 Diagnostics & Support Bundle
# =============================================================================
# Sourced by 086_grin_diagnostics.sh. Sourced, not executed — no shebang, no
# `set -e` (CLAUDE.md). Every function here is reached through a `fn || true`
# menu arm, so errexit is OFF for the whole body: nothing may rely on it, and
# every command that creates or deletes something carries its own guard.
#
# WHAT IT IS FOR
#   Answering "is this our code, the host, or upstream grin?" quickly, from
#   evidence rather than from a hunch. Every check is READ-ONLY; the one
#   exception (the consumer stop test) lives in the calling script behind an
#   explicit typed confirmation.
#
# PRIVACY RULES (everything here may be pasted into an issue or a chat)
#   · A secret VALUE is never printed, and never placed on a command line —
#     curl reads it from a config on stdin (`-K -`), so it is not in `ps`.
#   · IPv4 addresses are masked to the /24, IPv6 to the first three groups.
#   · Long token-like strings (20+ chars of [A-Za-z0-9+=]) are redacted from
#     configs, journals and cron lines. Paths survive: `/` is not in the class.
#   · Hostnames and domains are NOT masked — say so wherever a file is handed
#     over.
#
# PROBE TRAPS (inherited from 083 — see memory project_host_optimization_083)
#   · `grep -c … || echo 0` prints TWO lines when the count is 0. Use
#     `|| true` and normalise with _dg_num.
#   · `ss -tlnH` needs iproute2 >= 4.5; the repo idiom is `ss … | tail -n +2`.
#   · Debian's default awk is mawk: no `{n}` interval expressions in awk regexes.
#
# FINDINGS REGISTRY
#   dg_add <SEV> <AREA> <ORIGIN> <TITLE> <OBSERVED> [HINT]
#   SEV    CRIT | WARN | INFO | OK
#   ORIGIN host | toolkit | upstream | client | chain | network | config | consumer
#          — the LIKELY origin, from a pattern. It is a lean, never a verdict,
#          and every rendered summary says so.
# =============================================================================

[[ -n "${_DG_LIB_LOADED:-}" ]] && return 0
_DG_LIB_LOADED=1

# ─── State ────────────────────────────────────────────────────────────────────
DG_TMP="${DG_TMP:-}"          # scratch dir — the caller creates and removes it
DG_OFFLINE="${GRIN_DIAG_OFFLINE:-0}"   # 1 = skip every call that leaves this box
DG_NODES=()                   # "pid|dir|net|host|port" per running node
DG_MAIN_TIP=""

DG_SEV=(); DG_AREA=(); DG_ORIGIN=(); DG_TITLE=(); DG_OBS=(); DG_HINT=()

# Toolkit services that READ from the node and can safely be paused for the
# consumer load test. Deliberately excludes the pool, wallets and anything that
# holds money or miners: pausing those is an outage, not a measurement.
# Mainnet only: the test measures the mainnet node, so stopping grinscan-test
# would be downtime that measures nothing.
DG_READONLY_CONSUMERS=(grin-tiny-explorer grinscan-main)

# ─── Small helpers ────────────────────────────────────────────────────────────
dg_have() { command -v "$1" >/dev/null 2>&1; }
_dg_num() { [[ "${1:-}" =~ ^[0-9]+$ ]] && printf '%s' "$1" || printf '0'; }
dg_fgt()  { awk -v a="${1:-0}" -v b="${2:-0}" 'BEGIN{exit !(a+0 > b+0)}'; }
dg_sec()  { printf '\n\n##########  %s  ##########\n' "$*"; }
dg_sub()  { printf '\n--- %s ---\n' "$*"; }

dg_maskip() {
    sed -E 's/\b([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})\.[0-9]{1,3}\b/\1.x/g;
            s/\b([0-9a-fA-F]{1,4}:[0-9a-fA-F]{1,4}:[0-9a-fA-F]{1,4}):[0-9a-fA-F:]+\b/\1:x/g'
}
# `-` and `_` are in the class on purpose: bot tokens (Telegram, webhooks) use
# them, and a class without them splits a token into short, unredacted chunks.
# The cost is that a long hyphenated name (grin-pool-manager-backup) is
# redacted too - acceptable for a file meant to be shared. The first rule
# catches short secrets written as key=value / key: value.
dg_redact() {
    sed -E "s/((pass(word)?|passwd|token|secret|api_?key|auth)[\"']?[[:space:]]*[=:][[:space:]]*[\"']?)[^[:space:]\"'&,;]+/\1<redacted>/Ig;
            s/[A-Za-z0-9+=_-]{20,}/<redacted>/g"
}

# First uncommented `key = value` in a toml, quotes and trailing comment removed.
dg_tv() {
    grep -E "^[[:space:]]*$2[[:space:]]*=" "$1" 2>/dev/null | head -1 \
        | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*#.*$//' | tr -d '"' || true
}

dg_add() {
    DG_SEV+=("$1"); DG_AREA+=("$2"); DG_ORIGIN+=("$3")
    DG_TITLE+=("$4"); DG_OBS+=("$5"); DG_HINT+=("${6:-}")
}
dg_reset() { DG_SEV=(); DG_AREA=(); DG_ORIGIN=(); DG_TITLE=(); DG_OBS=(); DG_HINT=(); }
dg_count_sev() {
    local s n=0
    for s in "${DG_SEV[@]}"; do [[ "$s" == "$1" ]] && n=$((n + 1)); done
    printf '%s' "$n"
}

# ─── Node discovery ───────────────────────────────────────────────────────────
# From the RUNNING processes, not from a hard-coded dir: the explorer
# investigation that motivated this tool first went wrong precisely because the
# commands assumed mainnet-full on a host that only had mainnet-prune.
dg_discover_nodes() {
    DG_NODES=()
    local pid dir toml net addr host port
    for pid in $(pgrep -x grin 2>/dev/null || true); do
        tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'server' || continue
        dir=$(readlink -f "/proc/$pid/cwd" 2>/dev/null) || continue
        toml="$dir/grin-server.toml"
        net=mainnet
        if [[ "$(dg_tv "$toml" chain_type)" =~ [Tt]estnet ]] || [[ "$dir" == *testnet* ]]; then
            net=testnet
        fi
        addr=$(dg_tv "$toml" api_http_addr)
        [[ -z "$addr" ]] && addr="127.0.0.1:$(gnc_node_api_port "$net")"
        host=${addr%:*}; port=${addr##*:}
        [[ "$host" == "0.0.0.0" || -z "$host" ]] && host=127.0.0.1
        DG_NODES+=("$pid|$dir|$net|$host|$port")
    done
}

# Secret file for a node dir. `~` is tried as the NODE DIR first: the launch
# contract runs grin with HOME=<node dir>, so that is what the running node
# itself expanded it to. /opt/grin is the fallback grin_node_secret_path uses.
dg_secret_path() {   # <dir> <toml-key> <default-filename> <net>
    local dir=$1 key=$2 def=$3 net=$4 raw c
    local -a cands=()
    raw=$(dg_tv "$dir/grin-server.toml" "$key")
    if [[ -n "$raw" ]]; then
        case "$raw" in
            "~"*) cands+=("$dir${raw#\~}" "/opt/grin${raw#\~}") ;;
            /*)   cands+=("$raw") ;;
            *)    cands+=("$dir/$raw") ;;
        esac
    fi
    cands+=("$dir/$def" "/opt/grin/keys/$net/$def")
    for c in "${cands[@]}"; do
        [[ -f "$c" ]] && { printf '%s\n' "$c"; return 0; }
    done
    return 1
}
dg_read_secret() { [[ -n "${1:-}" && -r "$1" ]] && tr -d '[:space:]' < "$1" || true; }

# ─── Node API ─────────────────────────────────────────────────────────────────
# JSON-RPC call. The secret travels in a curl config read from STDIN, never on
# argv. Prints "<http_code> <seconds>"; the body is left in $DG_TMP/body.
dg_rpc() {
    local url=$1 secret=$2 method=$3 params=$4 mt=${5:-30} esc
    esc=${secret//\\/\\\\}; esc=${esc//\"/\\\"}
    : > "$DG_TMP/body"
    printf 'user = "grin:%s"\n' "$esc" | curl -s -K - -o "$DG_TMP/body" \
        -w '%{http_code} %{time_total}' --max-time "$mt" -H 'Content-Type: application/json' \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"$method\",\"params\":$params,\"id\":1}" \
        "$url" 2>/dev/null || true
}
# Classify the last body. Reachability needs a parsed {"Ok":…}, never a bare 200.
dg_verdict() {
    local b="$DG_TMP/body"
    if   grep -q '"Ok"'    "$b" 2>/dev/null; then echo "Ok"
    elif grep -q '"Err"'   "$b" 2>/dev/null; then echo "Err: $(grep -o '"Err"[^}]*' "$b" | head -c 90)"
    elif grep -q '"error"' "$b" 2>/dev/null; then echo "RPC error: $(head -c 120 "$b")"
    elif [[ -s "$b" ]];                      then echo "non-JSON: $(head -c 80 "$b" | tr -d '\n')"
    else echo "no body (timeout / refused / auth)"; fi
}
# Dotted field from the last body, with result.Ok unwrapped.
dg_body_field() {
    dg_have python3 || return 1
    python3 - "$DG_TMP/body" "$1" <<'PY' 2>/dev/null
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
n = d.get("result", d)
if isinstance(n, dict) and "Ok" in n:
    n = n["Ok"]
for k in sys.argv[2].split("."):
    if isinstance(n, dict) and k in n:
        n = n[k]
    else:
        sys.exit(1)
print(n)
PY
}

# Public reference tip — the one place the quick check leaves the box.
dg_ref_tip() {
    [[ "$DG_OFFLINE" == "1" ]] && return 1
    local ref
    ref=$([[ "$1" == testnet ]] && echo https://testapi.grin.money/v2/foreign || echo https://api.grin.money/v2/foreign)
    curl -s --max-time 10 -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","method":"get_tip","params":[],"id":1}' "$ref" 2>/dev/null \
        | grep -o '"height":[0-9]*' | head -1 | cut -d: -f2 || true
}
dg_upstream_latest() {
    [[ "$DG_OFFLINE" == "1" ]] && return 1
    curl -s --max-time 8 https://api.github.com/repos/mimblewimble/grin/releases/latest 2>/dev/null \
        | grep -o '"tag_name":[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4 || true
}

# ─── Log triage ───────────────────────────────────────────────────────────────
# Known grin log signatures → likely origin + where to look. FIRST MATCH WINS,
# so the order matters: specific causes before generic words like "peer".
# Regexes are lower-case ERE, matched against tolower(line), and must stay
# mawk-safe (no {n} intervals).
DG_SIG_RE=(
    'panicked at'
    'incompletemessage'
    'too many open files'
    'no space left|mdb_map_full|enospc'
    'permission denied|error loading config'
    'lock file|already locked|another grin process|failed to lock'
    'out of memory|memory allocation of|cannot allocate'
    'invalid ?root|corrupt|txhashset.*(invalid|fail)'
    'lmdb|mdb_|store error|db error'
    'too far in the future|clock'
    'wallet_listener|build_coinbase'
    'stratum'
    'api http server error'
    'header_sync|body_sync|state_sync|sync.*(error|fail|stall)'
    'peer|connection refused|connection reset|timed out|broken pipe|ban'
)
DG_SIG_NAME=(panic incomplete-message fd-limit disk-full permission node-lock
             out-of-memory chain-corrupt lmdb clock wallet-listener stratum
             api-other sync p2p)
DG_SIG_ORIGIN=(upstream client host host toolkit toolkit host chain chain host
               config consumer client network network)
DG_SIG_HINT=(
    "A Rust panic inside grin: an upstream bug or an unhandled condition. The backtrace is in the tmux pane capture. Search github.com/mimblewimble/grin/issues for the message before suspecting the toolkit."
    "An API client hung up before the node answered — a slow node (disk/RAM pressure) or a client timeout shorter than the call. Check which process holds connections to the API port. Not a node fault on its own."
    "File-descriptor limit exhausted. Raise LimitNOFILE / ulimit -n for the grin user (Host Optimization, hub 08 key 3, checks this)."
    "Disk or LMDB map full. Free space on the node's filesystem (Disk Cleanup, hub 08 key 7)."
    "Root-owned files in the node dir, or grin started as root / without HOME=<node dir>. Restart the node through the toolkit — it chowns the dir and relaunches as grin. Never test by running grin as root."
    "Two grin processes on one node dir (a root-socket and a gtmux session). Stop the node through the toolkit — it kills both tmux servers — then start it once."
    "The kernel or the allocator ran out of memory. Check the OOM lines in the host section and the swap size."
    "Chain-state validation errors. A PEER sending bad data (during sync or a fork) produces the same words, so first check whether the node is stuck or behind. If it is, restore chain data (Script 03) or resync; if it recurs on FRESH data, it is an upstream issue."
    "LMDB/store error. Check disk health and free space first; if the disk is fine, compare against upstream issues."
    "Block timestamps rejected — check the host clock (NTP sync in the host section)."
    "The node cannot reach the wallet listener that builds coinbase. Only matters for stratum mining (pool / solo)."
    "Stratum-side errors — a miner or the pool proxy. Look at the mining service, not the node."
    "Other API server errors — read the grouped lines below."
    "Sync errors. Only matters if the node is behind the reference tip."
    "P2P noise — normal in small numbers. Only matters with a low peer count or a node that is behind."
)

# Writes the lines of <logfile> (plus rotated .gz files new enough) at or after
# <since> ("YYYYMMDD HH:MM:SS", the grin log's own local-time prefix) to stdout.
# Continuation lines (backtraces) follow the verdict of the line above them.
dg_log_window() {
    local lf=$1 since=$2 since_epoch=$3 gz
    for gz in $(ls -tr "$lf".*.gz 2>/dev/null || true); do
        (( $(stat -c %Y "$gz" 2>/dev/null || echo 0) >= since_epoch )) || continue
        zcat "$gz" 2>/dev/null || true
    done
    [[ -f "$lf" ]] && cat "$lf"
}
dg_log_filter() {   # stdin → stdout, keep lines at/after <since>
    awk -v s="$1" '
        /^[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9] / { inw = (substr($0, 1, 17) >= s) }
        inw { print }'
}

# dg_triage <window-file> <net> <hours> — prints the signature table and adds
# findings. <hours> scales the "per hour" rates.
dg_triage() {
    local wf=$1 net=$2 hours=${3:-1} sigf="$DG_TMP/sigs" i
    : > "$sigf"
    for i in "${!DG_SIG_RE[@]}"; do
        printf '%s\t%s\n' "${DG_SIG_RE[$i]}" "$i" >> "$sigf"
    done
    grep -aE '^[0-9]{8} [0-9:.]+ (ERROR|WARN) ' "$wf" > "$DG_TMP/ew" 2>/dev/null || true
    # Truncate now: awk only creates it when a line is unmatched, so a stale
    # copy from the PREVIOUS node would otherwise be reported as this one's.
    : > "$DG_TMP/other"
    local total; total=$(_dg_num "$(wc -l < "$DG_TMP/ew")")

    # count / first / last per signature; unmatched lines go to $DG_TMP/other
    awk -F'\t' -v other="$DG_TMP/other" '
        NR == FNR { re[$2] = $1; n = ($2 + 1 > n ? $2 + 1 : n); next }
        {
            l = tolower($0); hit = -1
            for (i = 0; i < n; i++) if (l ~ re[i]) { hit = i; break }
            if (hit < 0) { print > other; next }
            c[hit]++; ts = substr($0, 1, 14)
            if (!(hit in f)) f[hit] = ts
            la[hit] = ts
        }
        END { for (i = 0; i < n; i++) if (c[i]) printf "%d\t%d\t%s\t%s\n", i, c[i], f[i], la[i] }
    ' "$sigf" "$DG_TMP/ew" > "$DG_TMP/sigres" 2>/dev/null || true

    echo "  ERROR/WARN lines in window: $total  (window: last ${hours} h)"
    if [[ ! -s "$DG_TMP/sigres" ]]; then
        echo "  no known signature matched"
    else
        printf '  %-18s %7s %8s  %-15s %-15s %s\n' "signature" "count" "per h" "first" "last" "likely origin"
        local idx cnt first last rate
        while IFS=$'\t' read -r idx cnt first last; do
            rate=$(awk -v c="$cnt" -v h="$hours" 'BEGIN{printf "%.1f", c / (h > 0 ? h : 1)}')
            printf '  %-18s %7s %8s  %-15s %-15s %s\n' "${DG_SIG_NAME[$idx]}" "$cnt" "$rate" \
                "$first" "$last" "${DG_SIG_ORIGIN[$idx]}"
            _dg_triage_finding "$net" "$idx" "$cnt" "$rate" "$first" "$last"
        done < <(sort -t$'\t' -k2,2nr "$DG_TMP/sigres")
    fi
    local oc; oc=$(_dg_num "$(wc -l < "$DG_TMP/other")")
    if (( oc > 0 )); then
        echo ""
        echo "  unmatched ERROR/WARN lines ($oc), grouped (numbers/hashes normalised):"
        sed -E 's/^[0-9]{8} [0-9:.]+ //; s/[0-9a-fA-F]{16,}/<hex>/g; s/[0-9]+/N/g' "$DG_TMP/other" \
            | dg_maskip | cut -c1-160 | sort | uniq -c | sort -rn | head -12
    fi
}

# Severity policy per signature. Counted noise (p2p, sync) is INFO unless it is
# heavy; anything that stops the node from working is CRIT on first sight.
_dg_triage_finding() {
    local net=$1 idx=$2 cnt=$3 rate=$4 first=$5 last=$6 sev=INFO
    case "${DG_SIG_NAME[$idx]}" in
        panic|disk-full|permission|node-lock|out-of-memory|fd-limit) sev=CRIT ;;
        # chain-corrupt is WARN, not CRIT: the same words come from a peer's bad block.
        chain-corrupt|lmdb|clock|wallet-listener)                    sev=WARN ;;
        incomplete-message|api-other) dg_fgt "$rate" 20 && sev=WARN ;;
        p2p|sync|stratum)             dg_fgt "$rate" 600 && sev=WARN ;;
    esac
    dg_add "$sev" "Log $net" "${DG_SIG_ORIGIN[$idx]}" \
        "${DG_SIG_NAME[$idx]}: $cnt lines (${rate}/h)" \
        "first $first · last $last" "${DG_SIG_HINT[$idx]}"
}

# Per-hour ERROR / WARN / IncompleteMessage counts — for "when did it start",
# to line up against a binary change, a restart or a toolkit update.
dg_log_hourly() {
    awk '
        /^[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9] / {
            h = substr($0, 1, 11) ":00"
            if (!(h in seen)) { seen[h] = 1; order[++n] = h }
            if ($3 == "ERROR") e[h]++
            if ($3 == "WARN")  w[h]++
            if (index($0, "IncompleteMessage")) im[h]++
        }
        END {
            for (i = 1; i <= n; i++) { h = order[i]
                printf "  %-15s %7d %7d %10d\n", h, e[h], w[h], im[h] }
        }' "$1" > "$DG_TMP/hourly"
    # Header printed separately: a `tail` over the whole table drops it once
    # the window is longer than the tail.
    printf '  %-15s %7s %7s %10s\n' "hour" "ERROR" "WARN" "Incompl."
    tail -n 48 "$DG_TMP/hourly"
    if (( $(wc -l < "$DG_TMP/hourly") > 48 )); then echo "  (older hours omitted - showing the last 48)"; fi
    return 0
}

# ─── Host ─────────────────────────────────────────────────────────────────────
_dg_psi60() { awk -F'avg60=' 'NR==1{split($2, a, " "); print a[1]}' "/proc/pressure/$1" 2>/dev/null || true; }

dg_check_host() {
    local cores memt mema swt swf pct io60 mem60 cpu60 l1 st oom ntp
    cores=$(_dg_num "$(nproc 2>/dev/null)"); (( cores == 0 )) && cores=1
    memt=$(_dg_num "$(awk '/^MemTotal:/{print $2}' /proc/meminfo)")
    mema=$(_dg_num "$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)")
    swt=$(_dg_num "$(awk '/^SwapTotal:/{print $2}' /proc/meminfo)")
    swf=$(_dg_num "$(awk '/^SwapFree:/{print $2}' /proc/meminfo)")

    if (( memt > 0 )); then
        pct=$(( mema * 100 / memt ))
        if (( pct < 10 )); then
            dg_add WARN Host host "Low available memory" "MemAvailable ${pct}% of $((memt / 1024)) MB" \
                "The page cache is what keeps chain reads off the disk. An archive node on a small box will read cold blocks from disk."
        else
            dg_add OK Host host "Memory" "MemAvailable ${pct}% of $((memt / 1024)) MB"
        fi
    fi
    if (( swt > 0 )) && (( (swt - swf) * 100 / swt > 50 )); then
        dg_add WARN Host host "Swap more than half used" "$(( (swt - swf) / 1024 )) MB of $(( swt / 1024 )) MB" \
            "Sustained swapping stalls the node and every API caller behind it."
    fi

    io60=$(_dg_psi60 io); mem60=$(_dg_psi60 memory); cpu60=$(_dg_psi60 cpu)
    if [[ -n "$io60" ]]; then
        if dg_fgt "$io60" 10; then
            dg_add WARN Host host "Disk pressure" "tasks stalled on IO ${io60}% of the last minute" \
                "The disk is the bottleneck. On an archive node this is the classic cause of slow get_block and client timeouts."
        else
            dg_add OK Host host "Disk pressure" "io avg60=${io60}%  memory avg60=${mem60:-?}%  cpu avg60=${cpu60:-?}%"
        fi
    fi
    [[ -n "$mem60" ]] && dg_fgt "$mem60" 5 && dg_add WARN Host host "Memory pressure" \
        "tasks stalled on reclaim ${mem60}% of the last minute" "The box is short of RAM for its workload."

    l1=$(awk '{print $1}' /proc/loadavg)
    dg_fgt "$l1" "$(( cores * 2 ))" && dg_add WARN Host host "High load" "load1=$l1 on $cores cores" \
        "Load counts tasks waiting on disk too — read it together with disk pressure."

    # CPU steal over ~3 s: a noisy neighbour on a shared VPS looks exactly like
    # "grin got slow" and no amount of node tuning fixes it.
    st=$(vmstat 1 3 2>/dev/null | awk 'NR==2{for(i=1;i<=NF;i++) if($i=="st") c=i} NR>2 && c{v=$c} END{print v+0}' || true)
    if dg_fgt "${st:-0}" 10; then
        dg_add WARN Host host "CPU steal" "st=${st}% — the hypervisor is giving this VPS's CPU to someone else" \
            "A provider-side problem. Compare with another VPS or ask the provider."
    fi

    oom=$(journalctl -k --since "24 hours ago" --no-pager 2>/dev/null | grep -ciE 'killed process|out of memory' || true)
    oom=$(_dg_num "$oom")
    (( oom > 0 )) && dg_add CRIT Host host "Kernel OOM kills in the last 24 h" "$oom line(s)" \
        "Something was killed for memory. If it was grin, that explains a restart; see the kernel lines in the bundle."

    # Only filesystems the node and the toolkit write to. A small /boot/efi at
    # 95% is normal and has nothing to do with LMDB.
    local df_pct mnt n
    local -a paths=(/ /opt/grin /var/log /tmp)
    for n in "${DG_NODES[@]}"; do paths+=("$(cut -d'|' -f2 <<< "$n")"); done
    while read -r df_pct mnt; do
        df_pct=$(_dg_num "${df_pct%\%}")
        if (( df_pct >= 90 )); then
            dg_add CRIT Host host "Filesystem almost full" "$mnt is ${df_pct}% used" \
                "A full disk corrupts LMDB writes. Free space before anything else."
        elif (( df_pct >= 80 )); then
            dg_add WARN Host host "Filesystem filling" "$mnt is ${df_pct}% used" ""
        fi
    done < <(df -P "${paths[@]}" 2>/dev/null | awk 'NR>1{print $5, $6}' | sort -u)

    if dg_have timedatectl; then
        ntp=$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)
        if [[ "$ntp" == "no" ]]; then
            dg_add WARN Host host "Clock not NTP-synchronised" "timedatectl NTPSynchronized=no" \
                "Grin rejects headers too far in the future; a drifting clock causes sync and peer trouble."
        fi
    fi
}

dg_dump_host() {
    dg_sec "HOST"
    echo "date (UTC):   $(date -u '+%F %T')    local: $(date '+%F %T %Z')"
    echo "host:         $(hostname -f 2>/dev/null || hostname)"
    echo "os:           $(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-?}")"
    echo "kernel:       $(uname -r)   virt: $(systemd-detect-virt 2>/dev/null || echo ?)"
    echo "cpu:          $(nproc) x $(awk -F: '/model name/{print $2; exit}' /proc/cpuinfo | sed 's/^ *//')"
    echo "uptime/load:  $(uptime)"
    echo "tools:        sar=$(dg_have sar && echo y || echo n) iostat=$(dg_have iostat && echo y || echo n) pidstat=$(dg_have pidstat && echo y || echo n) python3=$(dg_have python3 && echo y || echo n)"
    echo "boots:";  journalctl --list-boots --no-pager 2>/dev/null | tail -5 | sed 's/^/  /'
    dg_sub "memory";  free -h; echo; swapon --show 2>/dev/null || echo "(no swap)"
    grep -E '^(MemTotal|MemAvailable|Cached|Dirty|SwapTotal|SwapFree|Shmem):' /proc/meminfo
    dg_sub "pressure stall info (avg60 = % of the last minute tasks were stalled)"
    local r; for r in cpu memory io; do printf '  %-7s %s\n' "$r" "$(head -1 "/proc/pressure/$r" 2>/dev/null || echo n/a)"; done
    dg_sub "disks"; lsblk -d -o NAME,ROTA,SIZE,TYPE,MODEL 2>/dev/null; echo
    df -hT -x tmpfs -x devtmpfs -x squashfs 2>/dev/null
    dg_sub "vmstat 2 x 6  (wa = disk wait, si/so = swap, st = steal)"; vmstat -w 2 6 2>/dev/null
    if dg_have iostat; then dg_sub "iostat -x 2 2"; iostat -x 2 2 2>/dev/null | grep -vE '^loop' | tail -20; fi
    dg_sub "top processes by CPU"; ps -eo pid,user,pcpu,pmem,rss,etime,args --sort=-pcpu | cut -c1-170 | head -15
    dg_sub "top processes by memory"; ps -eo pid,user,pmem,rss,args --sort=-rss | cut -c1-150 | head -12
    dg_sub "kernel: OOM / IO errors / hung tasks (last 3 days)"
    journalctl -k --since "3 days ago" --no-pager 2>/dev/null \
        | grep -iE 'oom|killed process|I/O error|blk_update|hung task|soft lockup|EXT4-fs error|xfs.*error' | tail -25 || true
    dg_sub "time sync"; timedatectl 2>/dev/null | sed 's/^/  /' || true
}

# ─── Node ─────────────────────────────────────────────────────────────────────
# Quick checks for one node. Adds findings and prints a short block.
dg_check_node() {
    local pid=$1 dir=$2 net=$3 host=$4 port=$5
    local toml="$dir/grin-server.toml" area="Node $net" user dup osp fsp os fs r v t tip
    local own="http://$host:$port/v2/owner" furl="http://$host:$port/v2/foreign"

    echo "  $net  pid=$pid  dir=$dir  api=$host:$port"
    user=$(ps -o user= -p "$pid" 2>/dev/null | tr -d ' ')
    if [[ "$user" == "root" ]]; then
        dg_add CRIT "$area" toolkit "grin is running as root" "pid $pid, user root" \
            "Breaks the node launch contract: the next grin-user start hits EACCES on root-owned files. Restart it through the toolkit."
    fi
    dup=$(_dg_num "$(for p in $(pgrep -x grin 2>/dev/null || true); do readlink -f "/proc/$p/cwd" 2>/dev/null; done | grep -cxF "$dir" || true)")
    (( dup > 1 )) && dg_add CRIT "$area" toolkit "$dup grin processes on one node dir" "$dir" \
        "A root-socket session next to a gtmux one — the LMDB lock error. Stop through the toolkit, then start once."
    # Secret files are excluded: Script 04 sets the foreign secret to
    # root:<web_user> 640 on purpose, and the pool uses root:grinsecret.
    local notgrin
    notgrin=$(find "$dir" -maxdepth 2 ! -user grin ! -name '.api_secret' ! -name '.foreign_api_secret' \
              -print -quit 2>/dev/null || true)
    if [[ -n "$notgrin" ]]; then
        dg_add WARN "$area" toolkit "Files in the node dir not owned by grin" "e.g. $notgrin" \
            "Left by a root-run node or a root copy. The toolkit launcher chowns before start; a manual start does not."
    fi

    local started; started=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')
    started=$(_dg_num "$started")
    (( started > 0 && started < 1800 )) && dg_add INFO "$area" toolkit "Node restarted recently" \
        "up $((started / 60)) min (since $(ps -o lstart= -p "$pid" 2>/dev/null))" \
        "Line this up against the log timeline: was it restarted BECAUSE of the problem, or did the problem start after a restart?"
    local exe; exe=$(readlink "/proc/$pid/exe" 2>/dev/null || true)
    [[ "$exe" == *"(deleted)"* ]] && dg_add INFO "$area" upstream "Binary replaced since the node started" "$exe" \
        "The running node is an OLDER build than the file on disk. A restart picks up the new binary."

    osp=$(dg_secret_path "$dir" api_secret_path .api_secret "$net" || true)
    fsp=$(dg_secret_path "$dir" foreign_api_secret_path .foreign_api_secret "$net" || true)
    os=$(dg_read_secret "$osp"); fs=$(dg_read_secret "$fsp")
    [[ -z "$osp" ]] && dg_add WARN "$area" toolkit "Owner secret file not found" "api_secret_path=$(dg_tv "$toml" api_secret_path)" \
        "Run grin-secret-sync, or re-run the node build's secret step."

    r=$(dg_rpc "$own" "$os" get_status '[]' 15); v=$(dg_verdict); t=${r#* }
    printf '    owner   get_status   %-16s %s\n' "$r" "$v"
    if [[ "$v" == Ok ]]; then
        local syn h c ua
        syn=$(dg_body_field sync_status || true); h=$(dg_body_field tip.height || true)
        c=$(dg_body_field connections || true);  ua=$(dg_body_field user_agent || true)
        echo "    height=${h:-?} peers=${c:-?} sync=${syn:-?} version=${ua:-?}"
        [[ -n "$syn" && "$syn" != "no_sync" ]] && dg_add WARN "$area" network "Node reports it is syncing" "sync_status=$syn" \
            "Slow or failing API calls are expected until sync finishes."
        if [[ "$(_dg_num "$c")" -lt 3 ]]; then
            dg_add WARN "$area" network "Few peers" "connections=${c:-?}" "Check the P2P port (3414/13414) is reachable and the peer limits in grin-server.toml."
        fi
        dg_fgt "$t" 5 && dg_add WARN "$area" host "get_status is slow" "${t}s (Tiny Explorer's install check gives up at 5 s)" \
            "get_status is a cheap call; if it is slow, the node is starved (disk/CPU) — read the Host findings."
        dg_add OK "$area" upstream "Owner API answers" "HTTP $r · ${ua:-version ?}"
    else
        case "$r" in
            401*|403*) [[ -z "$osp" ]] && dg_add CRIT "$area" toolkit "Owner API needs a secret and none was found" "HTTP ${r%% *}" \
                           "The node enforces auth but no .api_secret exists where grin-server.toml points. Run grin-secret-sync."
                       [[ -n "$osp" ]] && dg_add CRIT "$area" toolkit "Owner API rejects the secret on disk" "HTTP ${r%% *} - $osp" \
                           "The file and the running node disagree — a secret rotated under a running node. Restart the node or run grin-secret-sync." ;;
            000*)      dg_add CRIT "$area" host "Owner API not answering" "no reply within 15 s ($v)" \
                           "Node hung, starved, or still starting. Check the Host findings and the tmux pane." ;;
            *)         dg_add WARN "$area" upstream "Owner API returned no result" "HTTP $r · $v" "" ;;
        esac
    fi
    # Control call: the node must REJECT a wrong secret, or the 200 above proves nothing.
    dg_rpc "$own" "gnsCONTROLnotArealSecret" get_status '[]' 10 >/dev/null
    grep -q '"Ok"' "$DG_TMP/body" 2>/dev/null && dg_add WARN "$area" config "Owner API accepts ANY credential" \
        "a deliberately wrong secret got a result" "api_secret_path is unset in grin-server.toml — the Owner API is unauthenticated."

    r=$(dg_rpc "$furl" "$fs" get_tip '[]' 15); v=$(dg_verdict); tip=$(dg_body_field height || true)
    printf '    foreign get_tip      %-16s %s  tip=%s\n' "$r" "$v" "${tip:-?}"
    case "$r" in
        401*|403*) dg_add CRIT "$area" toolkit "Foreign API rejects the secret" "HTTP ${r%% *} - ${fsp:-no secret file found}" \
                       "Every consumer (explorers, wallets, pool) will fail the same way. Run grin-secret-sync." ;;
    esac
    [[ "$net" == mainnet && -n "$tip" ]] && DG_MAIN_TIP=$tip

    local ref; ref=$(dg_ref_tip "$net" || true)
    if [[ -n "$tip" && -n "$ref" ]]; then
        local lag=$(( ref - tip ))
        echo "    public reference tip=$ref  lag=$lag"
        if   (( lag > 60 )); then dg_add CRIT "$area" network "Node is behind" "$lag blocks behind the public reference" "Stuck or slow sync. Read the sync/p2p lines in the log triage."
        elif (( lag > 5 ));  then dg_add WARN "$area" network "Node is slightly behind" "$lag blocks" ""
        else dg_add OK "$area" network "In sync with the public reference" "lag $lag"; fi
    fi

    local fl; fl=$(dg_tv "$toml" file_log_level)
    [[ "$fl" =~ ^(Debug|Trace)$ ]] && dg_add WARN "$area" config "file_log_level=$fl" "$toml" \
        "Debug/Trace logging costs real disk IO and CPU on a busy node. Info is the upstream default."

    local am cd memk
    am=$(dg_tv "$toml" archive_mode)
    if [[ "$am" == "true" ]]; then
        cd=$(du -sk "$dir/chain_data" 2>/dev/null | awk '{print $1}' || true)
        memk=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
        if (( $(_dg_num "$cd") > 2 * $(_dg_num "$memk") )); then
            dg_add INFO "$area" host "Archive chain_data is far larger than RAM" \
                "chain_data $(( $(_dg_num "$cd") / 1048576 )) GB vs RAM $(( $(_dg_num "$memk") / 1048576 )) GB" \
                "Random get_block reads for old heights come from disk. Fine one at a time; a bulk crawl (backfill, many parallel explorer requests) thrashes the page cache."
        fi
    fi
}

dg_check_registered_not_running() {
    local net dir n running
    for net in mainnet testnet; do
        dir=$(gnc_resolve_node_dir "$net" 2>/dev/null || true)
        [[ -n "$dir" ]] || continue
        running=0
        for n in "${DG_NODES[@]}"; do [[ "$(cut -d'|' -f2 <<< "$n")" == "$dir" ]] && running=1; done
        (( running == 0 )) && dg_add CRIT "Node $net" toolkit "Registered node is not running" "$dir" \
            "Start it from Script 01, or check the tmux pane (gtmux ls) for the reason it exited."
    done
}

# Peer user agents — which grin versions this node is talking to. If a fault
# lines up with a version wave on the network, that points upstream.
dg_peer_versions() {   # <owner-url> <secret>
    dg_rpc "$1" "$2" get_connected_peers '[]' 15 >/dev/null
    dg_have python3 || { echo "  (python3 missing)"; return 0; }
    python3 - "$DG_TMP/body" <<'PY' 2>/dev/null || echo "  (no peer list)"
import json, sys, collections
d = json.load(open(sys.argv[1])); r = d.get("result", {}); r = r.get("Ok", r)
c = collections.Counter(p.get("user_agent", "?") for p in (r or []))
d = collections.Counter(p.get("direction", "?") for p in (r or []))
print("  peers: %d  (%s)" % (sum(c.values()), ", ".join("%s %d" % kv for kv in d.items())))
for ua, n in c.most_common(12):
    print("    %-28s %d" % (ua, n))
PY
}

# Keys this node's grin-server.toml changes from what THIS binary generates as
# default. Answers "did our config cause it?" directly: an upstream default the
# toolkit never touched is not a toolkit-caused setting.
# Runs `grin server config` as the grin user in a throwaway dir with HOME set
# to that dir, so it writes nowhere near the node (launch contract rule).
# section.key = value, one per line, sorted — so two tomls diff key by key.
_dg_toml_flat() {
    # Plain [ 	] classes, not [[:space:]]: stays safe on an old mawk.
    awk '/^[ 	]*\[/ { gsub(/[ 	]/, ""); gsub(/^\[+|\]+$/, ""); sec = $0; next }
         /^[ 	]*#/ || /^[ 	]*$/ { next }
         { sub(/[ 	]+#.*$/, ""); k = $0; sub(/[ 	]*=.*/, "", k); gsub(/[ 	]/, "", k)
           v = $0; sub(/^[^=]*=[ 	]*/, "", v); print sec "." k " = " v }' "$1" | sort
}

dg_toml_vs_default() {   # <dir> <net>
    local dir=$1 net=$2 bin tmpd flag=""
    bin="$dir/grin"; [[ -x "$bin" ]] || { echo "  (no executable $bin)"; return 0; }
    id grin >/dev/null 2>&1 || { echo "  (no grin user)"; return 0; }
    # NOT under $DG_TMP: that is root 700, so the grin user could not even cd
    # into a dir created inside it.
    tmpd=$(mktemp -d /tmp/grin-defcfg.XXXXXX) || { echo "  (mktemp failed)"; return 0; }
    chown grin:grin "$tmpd" 2>/dev/null || { echo "  (chown failed)"; rm -rf "$tmpd"; return 0; }
    [[ "$net" == testnet ]] && flag="--testnet"
    su -s /bin/bash grin -c "cd '$tmpd' && HOME='$tmpd' timeout 20 '$bin' $flag server config" >/dev/null 2>&1 || true
    if [[ ! -f "$tmpd/grin-server.toml" ]]; then
        echo "  (the binary did not generate a default config)"
        rm -rf "$tmpd"; return 0
    fi
    _dg_toml_flat "$tmpd/grin-server.toml" > "$tmpd/def.flat"
    _dg_toml_flat "$dir/grin-server.toml"  > "$tmpd/cur.flat"
    echo "  < upstream default for $($bin --version 2>/dev/null)    > this node"
    echo "  (paths differ by design: db_root, log_file_path, *secret_path)"
    local d; d=$(diff "$tmpd/def.flat" "$tmpd/cur.flat" | grep -E '^[<>]' || true)
    if [[ -z "$d" ]]; then echo "  identical"; else printf '%s\n' "$d" | dg_redact | sed 's/^/  /'; fi
    [[ "$tmpd" == /tmp/grin-defcfg.* ]] && rm -rf "$tmpd"
    return 0
}

dg_tmux_capture() {   # <dir> [lines]
    local sess sock lines=${2:-400}
    sess=$(_grin_session_name "$1")
    if sock=$(gnc_grin_tmux_socket 2>/dev/null) \
        && [[ "$(stat -c %u "$sock" 2>/dev/null)" == "$(id -u grin 2>/dev/null)" ]] \
        && tmux -S "$sock" has-session -t "$sess" 2>/dev/null; then
        echo "  (grin socket, session $sess)"
        tmux -S "$sock" capture-pane -p -J -S "-$lines" -t "$sess" 2>/dev/null | dg_maskip | dg_redact
    elif tmux has-session -t "$sess" 2>/dev/null; then
        echo "  (ROOT socket, session $sess — should be on the grin socket)"
        tmux capture-pane -p -J -S "-$lines" -t "$sess" 2>/dev/null | dg_maskip | dg_redact
    else
        echo "  (no tmux session $sess on either socket)"
    fi
}

dg_node_logfile() {   # <dir> → path
    local lf; lf=$(dg_tv "$1/grin-server.toml" log_file_path)
    [[ "$lf" == "~"* ]] && lf="$1${lf#\~}"
    [[ -n "$lf" && -f "$lf" ]] || lf="$1/grin-server.log"
    printf '%s\n' "$lf"
}

dg_dump_node() {   # full node section for the bundle
    local pid=$1 dir=$2 net=$3 host=$4 port=$5 toml="$2/grin-server.toml" osp os k
    dg_sec "NODE $net  dir=$dir  api=$host:$port  pid=$pid"
    dg_sub "quick checks"; dg_check_node "$pid" "$dir" "$net" "$host" "$port"
    dg_sub "versions + timeline"
    echo "  running binary : $(readlink "/proc/$pid/exe" 2>/dev/null)"
    echo "  on-disk binary : $("$dir/grin" --version 2>/dev/null || echo ?)  mtime $(stat -c %y "$dir/grin" 2>/dev/null | cut -c1-19)"
    echo "  binary sha256  : $(sha256sum "$dir/grin" 2>/dev/null | cut -c1-64)"
    echo "  upstream latest: $(dg_upstream_latest || echo '(offline / unreachable)')"
    echo "  process start  : $(ps -o lstart= -p "$pid" 2>/dev/null)   user: $(ps -o user= -p "$pid" 2>/dev/null)"
    echo "  toml mtime     : $(stat -c %y "$toml" 2>/dev/null | cut -c1-19)"
    for k in .api_secret .foreign_api_secret; do
        echo "  $k: $(stat -c '%U:%G %a  mtime %y' "$dir/$k" 2>/dev/null | cut -d. -f1 || echo missing)"
    done
    dg_sub "config (selected keys)"
    for k in chain_type archive_mode api_http_addr db_root log_file_path stdout_log_level file_log_level \
             log_max_size log_max_files api_secret_path foreign_api_secret_path peer_max_inbound_count \
             peer_max_outbound_count peer_min_preferred_outbound_count enable_stratum_server \
             stratum_server_addr wallet_listener_url; do
        printf '  %-36s %s\n' "$k" "$(dg_tv "$toml" "$k")"
    done
    dg_sub "grin-server.toml vs this binary's upstream default"; dg_toml_vs_default "$dir" "$net"
    dg_sub "connected peers by version"
    osp=$(dg_secret_path "$dir" api_secret_path .api_secret "$net" || true); os=$(dg_read_secret "$osp")
    dg_peer_versions "http://$host:$port/v2/owner" "$os"
    dg_sub "process"
    grep -E '^(VmRSS|VmSwap|Threads):' "/proc/$pid/status" 2>/dev/null | sed 's/^/  /'
    echo "  open fds: $(ls "/proc/$pid/fd" 2>/dev/null | wc -l)   limit: $(awk '/Max open files/{print $4}' "/proc/$pid/limits" 2>/dev/null)"
    dg_sub "busiest threads"; top -H -b -n1 -p "$pid" 2>/dev/null | sed -n '7,20p'
    dg_sub "chain_data size"
    timeout 120 du -sh "$dir/chain_data" 2>/dev/null
    timeout 120 du -sh "$dir"/chain_data/* 2>/dev/null | sort -rh | head -8
    dg_sub "node dir"; ls -la "$dir" 2>/dev/null | dg_redact
    dg_sub "API clients (local processes connected to :$port)"
    ss -tnp state established "( dport = :$port )" 2>/dev/null | tail -n +2 \
        | grep -o 'users:(("[^"]*"' | sort | uniq -c || true
    echo "  socket states on :$port -> $(ss -tan "( sport = :$port )" 2>/dev/null | tail -n +2 | awk '{print $1}' | sort | uniq -c | tr '\n' ' ')"
}

# ─── API performance ──────────────────────────────────────────────────────────
# Cold vs warm get_block, a 20-way parallel burst, and optionally the two
# IncompleteMessage experiments (which deliberately WRITE a couple of lines
# into the node log — only run from the dedicated menu item, not the bundle).
dg_api_perf() {   # <dir> <net> <host> <port> <with_incomplete 0|1>
    local dir=$1 net=$2 host=$3 port=$4 with_im=${5:-0}
    local fsp fs furl="http://$3:$4/v2/foreign" r v t tip h pass i
    fsp=$(dg_secret_path "$dir" foreign_api_secret_path .foreign_api_secret "$net" || true)
    fs=$(dg_read_secret "$fsp")
    dg_sec "API PERFORMANCE  $net  ($furl)"
    r=$(dg_rpc "$furl" "$fs" get_tip '[]' 15); tip=$(dg_body_field height || true)
    tip=$(_dg_num "$tip")
    if (( tip == 0 )); then echo "  get_tip failed ($r $(dg_verdict)) — skipped"; return 0; fi

    dg_sub "get_block timing — pass 1 is cold, pass 2 should hit the page cache"
    local -a hs=("$tip" $((tip - 1)) $((tip - 10)) $((tip - 60)) $((tip - 1440)) $((tip - 10080)) $((tip - 43200)))
    [[ "$net" == mainnet && "$(dg_tv "$dir/grin-server.toml" archive_mode)" == "true" ]] \
        && hs+=(2000000 1000000 500000 100000 1)
    # 20 s per call, and stop after 2 timeouts in a row: on a hung node, 24
    # sequential 60 s calls would stall a "3 minute" bundle for 24 minutes.
    local tmo=0
    for pass in 1 2; do
        for h in "${hs[@]}"; do
            (( h < 0 )) && continue
            r=$(dg_rpc "$furl" "$fs" get_block "[$h,null,null]" 20); v=$(dg_verdict); t=${r#* }
            printf '  pass%s get_block %-10s %-16s %s\n' "$pass" "$h" "$r" "$v"
            if [[ "$r" == 000* ]]; then tmo=$((tmo + 1)); else tmo=0; fi
            if (( tmo >= 2 )); then
                echo "  two timeouts in a row - the node is not answering; skipping the rest"
                dg_add CRIT "Perf $net" host "get_block timing out" "two 20 s timeouts in a row" \
                    "The node is hung or starved. Read the Host findings and the tmux pane before anything else."
                return 0
            fi
            if [[ $pass == 1 ]] && (( h >= tip - 60 )) && dg_fgt "$t" 2; then
                dg_add WARN "Perf $net" host "get_block near the tip is slow" "height $h took ${t}s" \
                    "Recent blocks are hot data. Slowness here means the node itself is starved, not an archive cold-read."
            fi
        done
    done

    dg_sub "20 parallel get_block (what an explorer does on a cache miss)"
    for pass in 1 2; do
        local t0 t1; t0=$(date +%s.%N)
        local -a pids=()
        for ((i = 1; i <= 20; i++)); do
            ( esc=${fs//\\/\\\\}; esc=${esc//\"/\\\"}
              printf 'user = "grin:%s"\n' "$esc" | curl -s -K - -o /dev/null -w '%{http_code} %{time_total}\n' \
                  --max-time 30 -H 'Content-Type: application/json' \
                  -d "{\"jsonrpc\":\"2.0\",\"method\":\"get_block\",\"params\":[$((tip - i)),null,null],\"id\":1}" \
                  "$furl" > "$DG_TMP/par_$i" 2>/dev/null ) &
            pids+=($!)
        done
        wait "${pids[@]}" 2>/dev/null || true
        t1=$(date +%s.%N)
        cat "$DG_TMP"/par_* 2>/dev/null | awk -v w="$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.2f", b-a}')" -v p="$pass" \
            '{c[$1]++; s+=$2; if($2>m)m=$2} END{printf "  pass%s: wall=%ss avg=%.2fs max=%.2fs codes:", p, w, (NR?s/NR:0), m; for(k in c) printf " %s×%d", k, c[k]; print ""}'
        rm -f "$DG_TMP"/par_* 2>/dev/null || true
    done

    (( with_im == 1 )) || return 0
    local lf c0 c1 c2 oh
    lf=$(dg_node_logfile "$dir")
    dg_sub "IncompleteMessage experiments (log: $lf)"
    [[ -f "$lf" ]] || { echo "  log file not found — skipped"; return 0; }
    c0=$(_dg_num "$(grep -c IncompleteMessage "$lf" 2>/dev/null || true)")
    ( exec 3<>"/dev/tcp/$host/$port" \
        && printf 'POST /v2/foreign HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n{"jsonrpc":' "$host" >&3
      sleep 1 ) 2>/dev/null || true
    sleep 3; c1=$(_dg_num "$(grep -c IncompleteMessage "$lf" 2>/dev/null || true)")
    echo "  A — half-sent request, then hang up:      new IncompleteMessage lines = $((c1 - c0))"
    oh=$([[ $net == mainnet ]] && echo $(( tip / 2 + RANDOM )) || echo $(( tip > 5000 ? tip - 5000 : 1 )))
    r=$(dg_rpc "$furl" "$fs" get_block "[$oh,null,null]" 1)
    sleep 3; c2=$(_dg_num "$(grep -c IncompleteMessage "$lf" 2>/dev/null || true)")
    echo "  B — get_block $oh, client gives up at 1 s ($r): new lines = $((c2 - c1))"
    echo "  If A adds a line, IncompleteMessage means 'a client hung up early' on this build."
    echo "  B only proves anything if it actually hit the 1 s limit (code 000)."
}

# CPU% and disk MB/s per process over N seconds. args: <secs> label:pid ...
dg_sample_procs() {
    local secs=$1; shift
    local hz lp pid label t1 r1 w1 rss
    hz=$(getconf CLK_TCK 2>/dev/null || echo 100)
    local -A T0=() R0=() W0=()
    for lp in "$@"; do pid=${lp##*:}; [[ -r /proc/$pid/stat ]] || continue
        T0[$pid]=$(sed 's/.*) //' "/proc/$pid/stat" | awk '{print $12+$13}')
        R0[$pid]=$(awk '/^read_bytes/{print $2}' "/proc/$pid/io" 2>/dev/null)
        W0[$pid]=$(awk '/^write_bytes/{print $2}' "/proc/$pid/io" 2>/dev/null)
    done
    sleep "$secs"
    printf '  %-28s %7s %11s %11s %9s\n' "process" "CPU%" "read MB/s" "write MB/s" "RSS MB"
    for lp in "$@"; do label=${lp%:*}; pid=${lp##*:}
        [[ -r /proc/$pid/stat && -n "${T0[$pid]:-}" ]] || continue
        t1=$(sed 's/.*) //' "/proc/$pid/stat" | awk '{print $12+$13}')
        r1=$(awk '/^read_bytes/{print $2}' "/proc/$pid/io" 2>/dev/null)
        w1=$(awk '/^write_bytes/{print $2}' "/proc/$pid/io" 2>/dev/null)
        rss=$(awk '/^VmRSS/{printf "%.0f", $2/1024}' "/proc/$pid/status" 2>/dev/null)
        awk -v l="$label($pid)" -v t0="${T0[$pid]}" -v t1="$t1" -v r0="${R0[$pid]:-0}" -v r1="${r1:-0}" \
            -v w0="${W0[$pid]:-0}" -v w1="${w1:-0}" -v s="$secs" -v hz="$hz" -v rss="$rss" \
            'BEGIN{printf "  %-28s %7.1f %11.2f %11.2f %9s\n", l, (t1-t0)/hz/s*100, (r1-r0)/s/1048576, (w1-w0)/s/1048576, rss}'
    done
}

# ─── Consumers (toolkit services that use the node) ──────────────────────────
# Units the toolkit installs — matched by name so a product added later is
# picked up without editing this list.
dg_toolkit_units() {
    systemctl list-units --all --type=service,timer --no-legend --plain 2>/dev/null \
        | awk '{print $1}' \
        | grep -E '^(grin|grinscan|floonet)' || true
}

dg_check_consumers() {
    local u st nr j401
    for u in $(dg_toolkit_units); do
        st=$(systemctl show "$u" -p ActiveState --value 2>/dev/null)
        [[ "$u" == *.timer ]] && continue
        if [[ "$st" == "failed" ]]; then
            dg_add WARN Services consumer "$u has failed" "$(systemctl show "$u" -p Result --value 2>/dev/null)" \
                "journalctl -u $u -n 50 --no-pager"
        fi
        nr=$(_dg_num "$(systemctl show "$u" -p NRestarts --value 2>/dev/null)")
        (( nr > 3 )) && dg_add WARN Services consumer "$u restarted $nr times" "since it was last started by hand" \
            "A crash loop. Its journal usually names the cause (node unreachable, 401, port in use)."
        # Only 401s that mention the NODE count: a pool or wallet logs its own
        # admin-login 401s too, and those say nothing about the node secret.
        j401=$(journalctl -u "$u" --since '6 hours ago' --no-pager 2>/dev/null \
               | grep -iE '\b401\b|unauthori[sz]ed' | grep -ciE 'node|foreign|owner|:3413|:13413|/v2/' || true)
        j401=$(_dg_num "$j401")
        (( j401 > 0 )) && dg_add CRIT Services toolkit "$u got $j401 node-API auth failures (401) in 6 h" \
            "its copy of the node secret is probably stale" \
            "Run grin-secret-sync (the 5-min timer should already do this — check grin-secret-sync.timer)."
    done
    if systemctl cat grin-secret-sync.timer >/dev/null 2>&1 \
        && ! systemctl is-active --quiet grin-secret-sync.timer 2>/dev/null; then
        dg_add WARN Services toolkit "grin-secret-sync.timer is not active" "consumers will not self-heal after a node rebuild" \
            "systemctl enable --now grin-secret-sync.timer"
    fi
}

dg_dump_services() {
    local u
    dg_sec "TOOLKIT SERVICES"
    dg_sub "units"
    for u in $(dg_toolkit_units); do
        printf '  %-40s %s\n' "$u" "$(systemctl show "$u" -p ActiveState,SubState,NRestarts,ExecMainStartTimestamp --value 2>/dev/null | tr '\n' ' ')"
    done
    for u in $(dg_toolkit_units); do
        [[ "$u" == *.timer ]] && continue
        dg_sub "journal $u (last 6 h: errors/timeouts, last 15 lines)"
        journalctl -u "$u" --since '6 hours ago' --no-pager 2>/dev/null \
            | grep -iE 'error|timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|\b401\b|refused|fail' \
            | tail -15 | dg_maskip | dg_redact | cut -c1-220 || true
    done
    dg_sub "cron (root) + /etc/cron.d"
    crontab -l 2>/dev/null | grep -vE '^\s*(#|$)' | dg_redact | cut -c1-230
    local f
    for f in /etc/cron.d/*; do
        [[ -f "$f" ]] || continue
        echo "  # $f"; grep -vE '^\s*(#|$)' "$f" | dg_redact | cut -c1-230
    done
    dg_sub "timers"; systemctl list-timers --all --no-pager 2>/dev/null | head -30
}

dg_dump_network() {
    dg_sec "NETWORK"
    dg_sub "listening TCP sockets"; ss -tlnp 2>/dev/null | tail -n +2 | dg_maskip | cut -c1-200
    dg_sub "P2P connections"
    local p; for p in 3414 13414; do
        echo "  :$p established: $(ss -tn state established "( sport = :$p or dport = :$p )" 2>/dev/null | tail -n +2 | wc -l)"
    done
    dg_sub "firewall"; (ufw status 2>/dev/null || firewall-cmd --list-all 2>/dev/null || echo "  none detected") | dg_maskip | head -30
    dg_have nginx || return 0
    dg_sub "nginx -t"; nginx -t 2>&1 | tail -3
    dg_sub "vhosts: server_name / listen / proxy_pass / limit_req"
    grep -HnE '^\s*(server_name|listen|proxy_pass|limit_req)\b' /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf 2>/dev/null | cut -c1-160
    local -a logs=(); local al n=0
    mapfile -t logs < <(ls -S /var/log/nginx/*access*.log 2>/dev/null | head -6)
    for al in "${logs[@]}"; do
        [[ -s "$al" ]] || continue
        tail -n 20000 "$al" > "$DG_TMP/al" 2>/dev/null || continue
        dg_sub "access log $al ($(du -h "$al" | cut -f1)), last 20000 lines"
        echo "  span: $(head -1 "$DG_TMP/al" | awk '{print $4}' | tr -d '[')  ->  $(tail -1 "$DG_TMP/al" | awk '{print $4}' | tr -d '[')"
        echo "  status:"; awk '{print $9}' "$DG_TMP/al" | sort | uniq -c | sort -rn | head -8 | sed 's/^/   /'
        echo "  top IPs (masked):"; awk '{print $1}' "$DG_TMP/al" | dg_maskip | sort | uniq -c | sort -rn | head -8 | sed 's/^/   /'
        echo "  top user agents:"; awk -F'"' '{print $6}' "$DG_TMP/al" | cut -c1-100 | sort | uniq -c | sort -rn | head -8 | sed 's/^/   /'
        echo "  top paths (normalised):"
        awk '{print $7}' "$DG_TMP/al" | sed -E 's/\?.*//; s/[0-9a-fA-F]{16,}/<hex>/g; s/[0-9]+/N/g' \
            | sort | uniq -c | sort -rn | head -10 | sed 's/^/   /'
        n=$((n + 1))
    done
    (( n == 0 )) && echo "  (no non-empty access logs)"
}

dg_dump_history() {
    dg_sec "SAR HISTORY"
    dg_have sar || { echo "  sysstat not installed (apt install sysstat) — no history available"; return 0; }
    local sadir=/var/log/sysstat d f; [[ -d $sadir ]] || sadir=/var/log/sa
    for d in "$(date -d yesterday +%d)" "$(date +%d)"; do
        f="$sadir/sa$d"; [[ -f "$f" ]] || continue
        dg_sub "sar -u $f";          sar -u -f "$f" 2>/dev/null | grep -vE '^$'
        dg_sub "sar -q $f (load)";   sar -q -f "$f" 2>/dev/null | grep -vE '^$' | awk 'NR<=3 || NR%3==0'
        dg_sub "sar -r $f (memory)"; sar -r -f "$f" 2>/dev/null | grep -vE '^$' | awk 'NR<=3 || NR%3==0'
        dg_sub "sar -B $f (paging)"; sar -B -f "$f" 2>/dev/null | grep -vE '^$' | awk 'NR<=3 || NR%3==0'
        dg_sub "sar -d $f (disk)";   sar -d -p -f "$f" 2>/dev/null | grep -vE '^$|loop' | awk 'NR<=3 || NR%3==0'
    done
}

dg_toolkit_version() {
    local root="${1:-}" v newest
    v=$(grep -oE 'Grin Node Toolkit v[0-9.]+' "$root/grin-node-toolkit.sh" 2>/dev/null | head -1 || true)
    newest=$(find "$root/scripts" -name '*.sh' -printf '%T@ %TY-%Tm-%Td %TH:%TM %P\n' 2>/dev/null \
             | sort -n | tail -1 | cut -d' ' -f2- || true)
    printf '%s  (newest script: %s)\n' "${v:-unknown}" "${newest:-?}"
}
