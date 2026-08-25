# =============================================================================
# 083_lib_profile.sh — Host fact gathering for the Optimization & Hardening
#                      advisor (Script 083). READ-ONLY: nothing in this file
#                      writes, installs, or changes system state.
# =============================================================================
# Sourced, not executed — no shebang (see CLAUDE.md).
#
# ⚠ ERREXIT: this lib is sourced by a script whose menu dispatch is `fn || true`,
# which disables errexit for the whole callee body. Nothing here may rely on
# `set -e` from the caller. Every probe therefore ends in `|| true` / `|| echo`
# and returns a sentinel string rather than a non-zero status, so a missing tool
# on a minimal VPS degrades to "unknown" instead of aborting the whole report.
#
# Every function echoes a single value. "unknown" means "could not measure" and
# MUST render differently from a measured zero — a box with 0 MB of swap and a
# box whose swap we failed to read are different findings with different fixes.
# =============================================================================

HP_UNKNOWN="unknown"

# _hp_out - normalise a probe's stdout to the "unknown" sentinel when it is
# blank. This is NOT redundant with the `|| echo unknown` fallbacks: those fire
# only on a NON-ZERO exit, and awk/sed/grep -o routinely succeed while printing
# NOTHING (a df mount point absent from /proc/mounts, a bind mount, a sysfs file
# with no bracketed selection). The empty string then slips past every
# `[[ "$v" != "$HP_UNKNOWN" ]]` guard downstream and gets rendered as a real
# measurement - which is how an advisor invents a finding about a filesystem it
# never actually read. Pipe every value-returning probe through this.
_hp_out() {
    local v
    v=$(cat 2>/dev/null || true)
    if [[ -z "${v//[[:space:]]/}" ]]; then echo "$HP_UNKNOWN"; return 0; fi
    printf '%s\n' "$v"
}

# _hp_trim - strip leading/trailing whitespace from stdin. Used instead of
# `xargs`, which also performs quote and backslash processing and ERRORS OUT on
# an unmatched quote — turning a merely odd config value into a failed probe.
_hp_trim() {
    local v
    v=$(cat 2>/dev/null || true)
    v="${v#"${v%%[![:space:]]*}"}"
    v="${v%"${v##*[![:space:]]}"}"
    printf '%s\n' "$v"
}

# ─── Virtualisation ───────────────────────────────────────────────────────────
# Drives what is even applicable: OpenVZ/LXC forbid swapon and read-only most
# sysctls, so recommending them there is noise, not advice.
hp_virt() {
    if command -v systemd-detect-virt >/dev/null 2>&1; then
        systemd-detect-virt 2>/dev/null || echo "none"
    elif [[ -f /proc/vz/veinfo ]]; then
        echo "openvz"
    elif grep -qa 'container=lxc' /proc/1/environ 2>/dev/null; then
        echo "lxc"
    else
        echo "$HP_UNKNOWN"
    fi
}

# rc 0 when the guest is a container that cannot take kernel/swap tuning.
hp_is_restricted_container() {
    case "$(hp_virt)" in
        openvz|lxc|lxc-libvirt|docker|podman|systemd-nspawn) return 0 ;;
        *) return 1 ;;
    esac
}

# ─── CPU ──────────────────────────────────────────────────────────────────────
hp_cpu_cores() { nproc 2>/dev/null | _hp_out; }

hp_cpu_model() {
    # Trimmed: /proc/cpuinfo model strings are space-padded, and the untrimmed
    # value renders as "…Graphics  — 8 core(s)" with a stray double space.
    grep -m1 '^model name' /proc/cpuinfo 2>/dev/null \
        | sed 's/.*:[[:space:]]*//' | _hp_trim | _hp_out
}

# Cumulative steal as a percentage of all CPU time since boot, 1 decimal.
# WHY this matters more than core count on a VPS: steal is time the hypervisor
# handed to somebody else. Sustained steal means initial sync will crawl and no
# amount of local tuning recovers it — it is a "change plan or provider"
# finding, which is worth knowing BEFORE spending a week on a sync.
hp_cpu_steal_pct() {
    awk '/^cpu /{
        total = 0; for (i = 2; i <= NF; i++) total += $i;
        if (total <= 0) { print "unknown"; exit }
        printf "%.1f", ($9 / total) * 100; exit
    }' /proc/stat 2>/dev/null || echo "$HP_UNKNOWN"
}

# 1-minute load average per core, 2 decimals.
hp_load_per_core() {
    local l c
    l=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo "")
    c=$(hp_cpu_cores)
    if [[ -z "$l" || "$c" == "$HP_UNKNOWN" ]] || (( c < 1 )); then
        echo "$HP_UNKNOWN"; return 0
    fi
    awk -v l="$l" -v c="$c" 'BEGIN { printf "%.2f", l / c }' 2>/dev/null || echo "$HP_UNKNOWN"
}

# ─── Memory ───────────────────────────────────────────────────────────────────
_hp_meminfo_mb() {   # <MemTotal|SwapTotal|MemAvailable>
    local kb
    kb=$(awk -v k="$1:" '$1 == k { print $2; exit }' /proc/meminfo 2>/dev/null || echo "")
    [[ -z "$kb" ]] && { echo "$HP_UNKNOWN"; return 0; }
    echo $(( kb / 1024 ))
}

hp_mem_total_mb()     { _hp_meminfo_mb MemTotal; }
hp_mem_available_mb() { _hp_meminfo_mb MemAvailable; }
hp_swap_total_mb()    { _hp_meminfo_mb SwapTotal; }

# ─── Sysctl / kernel knobs ────────────────────────────────────────────────────
hp_sysctl() {   # <key> → current value, or "unknown"
    sysctl -n "$1" 2>/dev/null || echo "$HP_UNKNOWN"
}

# Transparent hugepages: echoes the ACTIVE mode (always|madvise|never).
# LMDB maps the chain files; THP in `always` mode inflates resident memory and
# stalls on compaction, which on a small box surfaces as node startup pauses.
hp_thp_mode() {
    local f=/sys/kernel/mm/transparent_hugepage/enabled
    [[ -r "$f" ]] || { echo "$HP_UNKNOWN"; return 0; }
    sed -n 's/.*\[\(.*\)\].*/\1/p' "$f" 2>/dev/null | _hp_out
}

# ─── Disk / IO ────────────────────────────────────────────────────────────────
# The block device backing a path: /opt/grin → "sda" / "nvme0n1" / "vda".
# Strips the partition suffix so the /sys/block lookups below resolve.
hp_backing_device() {   # <path>
    local src base
    src=$(df -P "$1" 2>/dev/null | awk 'NR==2 { print $1 }' || echo "")
    if [[ -z "$src" || "$src" != /dev/* ]]; then echo "$HP_UNKNOWN"; return 0; fi
    base=$(basename "$src")
    # nvme0n1p2 → nvme0n1 ; sda1 → sda ; vda2 → vda ; dm-0 is left alone
    if [[ "$base" =~ ^(nvme[0-9]+n[0-9]+)p[0-9]+$ ]]; then
        base="${BASH_REMATCH[1]}"
    elif [[ "$base" =~ ^([a-z]+)[0-9]+$ ]]; then
        base="${BASH_REMATCH[1]}"
    fi
    [[ -d "/sys/block/$base" ]] && echo "$base" || echo "$HP_UNKNOWN"
}

# "ssd" | "hdd" | "unknown". Most VPS disks report non-rotational even when they
# are network-backed, so treat a "ssd" result as a floor, never as proof of
# local NVMe — which is why the report never promises IO latency from this.
hp_disk_kind() {   # <path>
    local dev r
    dev=$(hp_backing_device "$1")
    [[ "$dev" == "$HP_UNKNOWN" ]] && { echo "$HP_UNKNOWN"; return 0; }
    r=$(cat "/sys/block/$dev/queue/rotational" 2>/dev/null || echo "")
    case "$r" in
        0) echo "ssd" ;;
        1) echo "hdd" ;;
        *) echo "$HP_UNKNOWN" ;;
    esac
}

hp_io_scheduler() {   # <path> → active scheduler name
    local dev s
    dev=$(hp_backing_device "$1")
    [[ "$dev" == "$HP_UNKNOWN" ]] && { echo "$HP_UNKNOWN"; return 0; }
    s=$(cat "/sys/block/$dev/queue/scheduler" 2>/dev/null || echo "")
    [[ -z "$s" ]] && { echo "$HP_UNKNOWN"; return 0; }
    # A single-queue device with no selectable scheduler prints "none" bare.
    if [[ "$s" == *'['* ]]; then
        sed -n 's/.*\[\(.*\)\].*/\1/p' <<< "$s" 2>/dev/null | _hp_out
    else
        echo "$s" | _hp_trim | _hp_out
    fi
}

hp_fs_type()  { df -PT "$1" 2>/dev/null | awk 'NR==2 { print $2 }' | _hp_out; }
hp_free_mb()  { df -Pm "$1" 2>/dev/null | awk 'NR==2 { print $4 }' | _hp_out; }
hp_used_pct() { df -P  "$1" 2>/dev/null | awk 'NR==2 { gsub(/%/,"",$5); print $5 }' | _hp_out; }

# Mount options for the filesystem containing <path>, read from /proc/mounts so
# it reflects what is ACTUALLY mounted rather than what fstab hopes for.
hp_mount_opts() {   # <path>
    local mp
    mp=$(df -P "$1" 2>/dev/null | awk 'NR==2 { print $6 }' || echo "")
    [[ -z "$mp" ]] && { echo "$HP_UNKNOWN"; return 0; }
    awk -v m="$mp" '$2 == m { print $4; exit }' /proc/mounts 2>/dev/null | _hp_out
}

# rc 0 if the fs holding <path> suppresses per-read atime writes.
# relatime (the modern default) is fine; only a bare `atime` mount is wasteful,
# so this deliberately accepts both rather than nagging about a sane default.
hp_atime_ok() {   # <path>
    local o
    o=$(hp_mount_opts "$1")
    [[ "$o" == *noatime* || "$o" == *relatime* ]]
}

# ─── systemd units ────────────────────────────────────────────────────────────
hp_unit_active()  { systemctl is-active  --quiet "$1" 2>/dev/null; }
hp_unit_enabled() { systemctl is-enabled --quiet "$1" 2>/dev/null; }

# First time-sync unit found active, else "none". A drifted clock gets a node
# peer-banned, so this is a node-health check, not general hygiene.
hp_timesync_unit() {
    local u
    for u in systemd-timesyncd chrony chronyd ntp ntpsec openntpd; do
        hp_unit_active "$u" && { echo "$u"; return 0; }
    done
    echo "none"
}

# rc 0 when timedatectl reports the clock actually synchronised.
hp_clock_synced() {
    command -v timedatectl >/dev/null 2>&1 || return 1
    timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -qi '^yes$'
}

# ─── Packages / security surface ──────────────────────────────────────────────
hp_have() { command -v "$1" >/dev/null 2>&1; }

# "active" | "inactive" | "absent"
hp_ufw_state() {
    hp_have ufw || { echo "absent"; return 0; }
    if ufw status 2>/dev/null | grep -qi '^Status: active'; then
        echo "active"
    else
        echo "inactive"
    fi
}

# Rough "is anything filtering at all?" count for boxes that firewall without
# ufw. Deliberately not a pass/fail on its own — it only suppresses a false
# "you have no firewall" when nftables rules are clearly present.
#
# ⚠ `grep -c` PRINTS "0" and EXITS 1 when it matches nothing, so the usual
# `grep -c … || echo 0` fallback emits TWO lines ("0\n0") on the zero case — a
# value that then fails every `^[0-9]+$` numeric guard downstream and silently
# drops the finding it feeds. Swallow the exit status with `|| true` and
# normalise instead; never pair `grep -c` with `|| echo`.
hp_raw_firewall_rules() {
    local n=""
    if hp_have nft; then
        n=$(nft list ruleset 2>/dev/null | grep -cE '^[[:space:]]+(tcp|udp|ct|ip)' || true)
    elif hp_have iptables; then
        n=$(iptables -S 2>/dev/null | grep -cE '^-A' || true)
    fi
    [[ "$n" =~ ^[0-9]+$ ]] || n=0
    echo "$n"
}

# rc 0 when unattended-upgrades is installed AND actually scheduled to run.
# Installed-but-unscheduled is the common trap, so both halves are required —
# the package being present proves nothing on its own.
hp_unattended_ok() {
    { hp_have unattended-upgrade || hp_have unattended-upgrades; } || return 1
    grep -rqs 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/ 2>/dev/null
}

# Same `grep -c` trap as above — the zero case is the COMMON one here (a fully
# patched box), and the "0\n0" it used to emit failed adv_is_num, so the one
# host that deserved the "none pending" OK line was the only one that never
# got it. A check that disappears exactly when it passes is worse than no check.
hp_pending_security_updates() {
    hp_have apt-get || { echo "$HP_UNKNOWN"; return 0; }
    local n
    n=$(apt-get -s -o Debug::NoLocking=true upgrade 2>/dev/null \
        | grep -ci '^Inst.*security' || true)
    [[ "$n" =~ ^[0-9]+$ ]] || n=0
    echo "$n"
}

# ─── Node-facing facts ────────────────────────────────────────────────────────
# Effective open-file limit for a node started from a root shell/tmux. The node
# holds one socket per peer plus LMDB/MMR handles, so a 1024 soft limit sitting
# under a high peer_max_inbound_count is a pairing that fails under load only
# once the peer count climbs — i.e. long after the operator stopped watching.
hp_nofile_soft() { ulimit -Sn 2>/dev/null | _hp_out; }
hp_nofile_hard() { ulimit -Hn 2>/dev/null | _hp_out; }

# Reads peer_max_inbound_count out of a node's grin-server.toml.
hp_peer_max_inbound() {   # <node_dir>
    local f="$1/grin-server.toml"
    [[ -r "$f" ]] || { echo "$HP_UNKNOWN"; return 0; }
    grep -E '^[[:space:]]*peer_max_inbound_count[[:space:]]*=' "$f" 2>/dev/null \
        | head -1 | sed 's/.*=[[:space:]]*//' | tr -d '"' | _hp_trim | _hp_out
}

# journald on-disk cap. An uncapped journal is a slow disk-full that takes the
# node down weeks after whoever turned on debug logging has forgotten about it.
hp_journal_max_use() {
    local v
    v=$(grep -hsE '^[[:space:]]*SystemMaxUse=' /etc/systemd/journald.conf \
            /etc/systemd/journald.conf.d/*.conf 2>/dev/null \
        | tail -1 | sed 's/.*=//' | _hp_trim || true)
    [[ -z "$v" ]] && echo "unset" || echo "$v"
}

hp_journal_size() {
    hp_have journalctl || { echo "$HP_UNKNOWN"; return 0; }
    journalctl --disk-usage 2>/dev/null \
        | grep -oE '[0-9.]+[KMGT]?' | tail -1 | _hp_out
}
