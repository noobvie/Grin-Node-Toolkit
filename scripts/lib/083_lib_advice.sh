# =============================================================================
# 083_lib_advice.sh — Turns the facts gathered by 083_lib_profile.sh into
#                     scored findings for the Optimization & Hardening advisor.
# =============================================================================
# Sourced, not executed — no shebang (see CLAUDE.md). Requires 083_lib_profile.sh
# to be sourced FIRST.
#
# READ-ONLY, deliberately. Every finding carries a `fix` string that the operator
# runs themselves. There is no apply path in this release, and that is a design
# decision, not an omission: on a remote VPS a bad sysctl or a `ufw enable`
# issued before an SSH allow-rule is a box you can only recover from the
# provider's console. Suggest first, measure on a real node, automate later.
#
# ⚠ ERREXIT: sourced into a script dispatched as `fn || true`, so errexit is off
# for the whole body. Nothing here may depend on `set -e` — every probe is
# already sentinel-returning (see the profile lib), and every arithmetic guard
# below tests for "unknown" BEFORE comparing, because `(( unknown > 4 ))` is a
# bash syntax error, not a false.
#
# SEVERITIES
#   CRIT  money/uptime/security risk that is live right now
#   WARN  will bite under load, or on the next reboot
#   INFO  worth knowing; no action strictly required
#   OK    checked and healthy — printed so a clean box reads as verified,
#         not as a check that silently didn't run
#   NA    not applicable on this host (container restriction, absent subsystem)
# =============================================================================

# Parallel arrays — bash 4 has no array-of-struct. Index i is one finding.
ADV_SEV=();  ADV_AREA=(); ADV_TITLE=()
ADV_OBS=();  ADV_REC=();  ADV_FIX=()

adv_reset() { ADV_SEV=(); ADV_AREA=(); ADV_TITLE=(); ADV_OBS=(); ADV_REC=(); ADV_FIX=(); }

# adv_add <sev> <area> <title> <observed> <recommendation> [fix-command]
adv_add() {
    ADV_SEV+=("$1"); ADV_AREA+=("$2"); ADV_TITLE+=("$3")
    ADV_OBS+=("$4"); ADV_REC+=("$5");  ADV_FIX+=("${6:-}")
}

adv_count_sev() {   # <SEV> → how many findings carry it
    local want="$1" n=0 s
    for s in ${ADV_SEV[@]+"${ADV_SEV[@]}"}; do
        [[ "$s" == "$want" ]] && n=$(( n + 1 ))
    done
    echo "$n"
}

# True when $1 is a plain non-negative integer. Guards every numeric comparison
# against the "unknown" sentinel, which would otherwise abort the arithmetic.
adv_is_num() { [[ "${1:-}" =~ ^[0-9]+$ ]]; }

# rc 0 when an `ss` Local-Address:Port field is a LOOPBACK bind, i.e. reachable
# only from this host. Everything that is not loopback is treated as reachable
# from somewhere else — see the note above the node-API check for why the test
# must be written this way round.
#   loopback : 127.0.0.1:3413 · 127.x.y.z:3413 · [::1]:3413 · ::1:3413
#   exposed  : 0.0.0.0:3413 · [::]:3413 · *:3413 · 203.0.113.7:3413
_adv_is_loopback_bind() {
    local b="${1:-}"
    b="${b%:*}"                      # strip the :port, leaving the address
    # The brackets MUST be quoted here: bare ${b#[} makes bash read the `[` as
    # the start of a bracket expression and the strip silently does nothing.
    b="${b#"["}"; b="${b%"]"}"       # unwrap an IPv6 literal's brackets
    case "$b" in
        127.*|::1|0:0:0:0:0:0:0:1|localhost) return 0 ;;
        *) return 1 ;;
    esac
}

# =============================================================================
# CPU
# =============================================================================
adv_check_cpu() {
    local cores steal load model
    cores=$(hp_cpu_cores); steal=$(hp_cpu_steal_pct)
    load=$(hp_load_per_core); model=$(hp_cpu_model)

    adv_add INFO CPU "Processor" \
        "${model:-unknown} — ${cores} core(s)" \
        "Grin sync is largely single-threaded; block validation (rangeproofs) is what uses extra cores."

    if adv_is_num "$cores"; then
        if (( cores < 2 )); then
            adv_add WARN CPU "Single core" \
                "${cores} core" \
                "1 core syncs a node, but leaves nothing for a wallet listener, miner or web service on the same box. Expect a slow initial sync." \
                ""
        else
            adv_add OK CPU "Core count" "${cores} cores" "Adequate for a node plus supporting services."
        fi
    fi

    # Steal is the single most useful VPS number and the one nobody looks at.
    if [[ "$steal" != "$HP_UNKNOWN" ]]; then
        local steal_int="${steal%%.*}"
        if adv_is_num "$steal_int" && (( steal_int >= 10 )); then
            adv_add CRIT CPU "High CPU steal" \
                "${steal}% of all CPU time since boot was taken by the hypervisor" \
                "Sustained steal above ~10% means you are sharing a heavily oversubscribed host. No local tuning recovers this — initial sync will crawl. Consider a dedicated-vCPU plan or another provider." \
                ""
        elif adv_is_num "$steal_int" && (( steal_int >= 3 )); then
            adv_add WARN CPU "Noticeable CPU steal" \
                "${steal}% steal since boot" \
                "Some contention from neighbouring VMs. Tolerable for a synced node; it will lengthen an initial sync." \
                ""
        else
            adv_add OK CPU "CPU steal" "${steal}%" "Little or no hypervisor contention."
        fi
    fi

    if [[ "$load" != "$HP_UNKNOWN" ]]; then
        local load_int="${load%%.*}"
        if adv_is_num "$load_int" && (( load_int >= 2 )); then
            adv_add WARN CPU "Load above capacity" \
                "1-min load is ${load}x the core count" \
                "Something is saturating this box. Identify it with 'top' before tuning anything else — tuning will not fix an overloaded host." \
                "top -b -n1 | head -20"
        else
            adv_add OK CPU "Load average" "${load}x per core" "Within capacity."
        fi
    fi
}

# =============================================================================
# MEMORY + SWAP
# =============================================================================
# Grin's cold start opens LMDB and rebuilds the bitmap accumulator across the
# whole output MMR, single-threaded and memory-hungry. An OOM-kill part-way
# through does not resume — the next start begins again, which presents as a
# node that is permanently "still syncing" rather than as a crash.
adv_check_memory() {
    local ram swap avail want_swap
    ram=$(hp_mem_total_mb); swap=$(hp_swap_total_mb); avail=$(hp_mem_available_mb)

    adv_add INFO Memory "Installed RAM" \
        "${ram} MB total, ${avail} MB available now" \
        "Page cache is what makes a Grin node fast — the chain files are mmap'd, so free RAM is not wasted RAM."

    if ! adv_is_num "$ram"; then return 0; fi

    # A small box needs swap MORE than a big one — it is the OOM margin for the
    # cold-boot MMR rebuild, not a substitute for RAM. Above ~2 GB a flat 2 GB
    # of margin is enough, so there are only two tiers here on purpose.
    if (( ram < 2048 )); then want_swap=4096; else want_swap=2048; fi

    if (( ram < 1536 )); then
        adv_add CRIT Memory "Very low RAM" \
            "${ram} MB" \
            "Below ~1.5 GB a mainnet node is at real risk of being OOM-killed during the cold-boot MMR rebuild, which restarts from scratch each time. Run a PRUNED node only, and make sure swap is present." \
            ""
    elif (( ram < 4096 )); then
        adv_add WARN Memory "Low RAM for an archive node" \
            "${ram} MB" \
            "Fine for a pruned node. NOT enough for archive mode: the archive chain_data does not fit in page cache, so bulk get_block reads thrash the box (swap fills, kswapd pegs a core)." \
            ""
    else
        adv_add OK Memory "RAM capacity" "${ram} MB" "Comfortable for a pruned node; archive mode is viable from ~8 GB up."
    fi

    if adv_is_num "$swap"; then
        if (( swap == 0 )); then
            if hp_is_restricted_container; then
                adv_add NA Memory "Swap" \
                    "none, and this is a $(hp_virt) container" \
                    "Containers of this type normally forbid swapon. Nothing to do here — but the low-RAM warnings above matter more as a result."
            else
                adv_add WARN Memory "No swap configured" \
                    "0 MB swap" \
                    "Add ~${want_swap} MB. Swap is not there to be used — it is the margin that stops the kernel OOM-killing the node mid-rebuild. Paired with vm.swappiness=10 it stays almost untouched." \
                    "fallocate -l ${want_swap}M /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab"
            fi
        elif (( swap < want_swap / 2 )); then
            adv_add INFO Memory "Small swap" \
                "${swap} MB (suggested ~${want_swap} MB for ${ram} MB RAM)" \
                "Usable, but a little thin as OOM margin for a cold node start." \
                ""
        else
            adv_add OK Memory "Swap present" "${swap} MB" "Enough headroom for the cold-boot MMR rebuild."
        fi
    fi
}

# =============================================================================
# KERNEL / SYSCTL
# =============================================================================
adv_check_kernel() {
    if hp_is_restricted_container; then
        adv_add NA Kernel "Kernel tuning" \
            "$(hp_virt) container" \
            "Most sysctl keys are read-only in this container type — the host controls them. Skipping kernel recommendations rather than suggesting writes that will silently fail."
        return 0
    fi

    local swappiness cachepressure somaxconn backlog thp
    swappiness=$(hp_sysctl vm.swappiness)
    cachepressure=$(hp_sysctl vm.vfs_cache_pressure)
    somaxconn=$(hp_sysctl net.core.somaxconn)
    backlog=$(hp_sysctl net.core.netdev_max_backlog)
    thp=$(hp_thp_mode)

    # Script 01 already writes these two at build time; report as verified
    # rather than re-recommending what the toolkit set.
    if adv_is_num "$swappiness"; then
        if (( swappiness > 10 )); then
            adv_add WARN Kernel "vm.swappiness too high" \
                "${swappiness} (default 60)" \
                "Set to 10 so the kernel evicts the mmap'd chain page cache last. This is the single biggest cold-boot speed-up available locally." \
                "sysctl -w vm.swappiness=10 && echo 'vm.swappiness = 10' >> /etc/sysctl.d/99-grin-node.conf"
        else
            adv_add OK Kernel "vm.swappiness" "${swappiness}" "Favours page cache over swap, as a node wants."
        fi
    fi

    if adv_is_num "$cachepressure"; then
        if (( cachepressure > 50 )); then
            adv_add INFO Kernel "vm.vfs_cache_pressure" \
                "${cachepressure} (default 100)" \
                "50 keeps dentry/inode cache alive longer, which helps the many-small-file access pattern of the chain directory." \
                "sysctl -w vm.vfs_cache_pressure=50 && echo 'vm.vfs_cache_pressure = 50' >> /etc/sysctl.d/99-grin-node.conf"
        else
            adv_add OK Kernel "vm.vfs_cache_pressure" "${cachepressure}" "Retains metadata cache well."
        fi
    fi

    # Only relevant because a public node accepts many inbound P2P connections.
    if adv_is_num "$somaxconn"; then
        if (( somaxconn < 1024 )); then
            adv_add WARN Kernel "net.core.somaxconn low" \
                "${somaxconn}" \
                "A public node with a high inbound peer limit needs a deeper accept queue, or bursts of peer connections are dropped at the kernel before grin ever sees them." \
                "sysctl -w net.core.somaxconn=1024 && echo 'net.core.somaxconn = 1024' >> /etc/sysctl.d/99-grin-node.conf"
        else
            adv_add OK Kernel "net.core.somaxconn" "${somaxconn}" "Accept queue deep enough for many peers."
        fi
    fi

    if adv_is_num "$backlog"; then
        if (( backlog < 2500 )); then
            adv_add INFO Kernel "net.core.netdev_max_backlog" \
                "${backlog}" \
                "Raising to 5000 gives more headroom for packet bursts on a busy P2P node." \
                "sysctl -w net.core.netdev_max_backlog=5000 && echo 'net.core.netdev_max_backlog = 5000' >> /etc/sysctl.d/99-grin-node.conf"
        else
            adv_add OK Kernel "net.core.netdev_max_backlog" "${backlog}" "Adequate burst headroom."
        fi
    fi

    case "$thp" in
        always)
            adv_add WARN Kernel "Transparent hugepages set to 'always'" \
                "always" \
                "LMDB maps the chain files; THP in 'always' mode inflates resident memory and adds compaction stalls that surface as node start-up pauses. 'madvise' keeps the benefit for callers that ask for it." \
                "echo madvise > /sys/kernel/mm/transparent_hugepage/enabled   # non-persistent; add a systemd unit or GRUB flag to make it survive reboot"
            ;;
        madvise|never)
            adv_add OK Kernel "Transparent hugepages" "$thp" "Will not interfere with LMDB."
            ;;
        *)
            adv_add INFO Kernel "Transparent hugepages" "could not read" "Skipped — /sys/kernel/mm/transparent_hugepage is not readable here."
            ;;
    esac
}

# =============================================================================
# DISK / IO
# =============================================================================
adv_check_disk() {
    local target="${1:-/opt/grin}"
    local probe="$target"
    [[ -d "$probe" ]] || probe="/"

    local kind sched fs free used opts
    kind=$(hp_disk_kind "$probe"); sched=$(hp_io_scheduler "$probe")
    fs=$(hp_fs_type "$probe");     free=$(hp_free_mb "$probe")
    used=$(hp_used_pct "$probe");  opts=$(hp_mount_opts "$probe")

    adv_add INFO Disk "Storage backing $probe" \
        "${fs} on ${kind} — ${free} MB free (${used}% used), opts: ${opts}" \
        "A pruned node wants ~10 GB of headroom; an archive node ~25 GB and rising."

    if [[ "$kind" == "hdd" ]]; then
        adv_add WARN Disk "Rotational disk" \
            "spinning disk detected" \
            "Grin's initial sync is heavily random-read. On a spinning disk expect a sync measured in days rather than hours. An SSD/NVMe plan is the single biggest improvement available." \
            ""
    fi

    if adv_is_num "$used"; then
        if (( used >= 90 )); then
            adv_add CRIT Disk "Disk nearly full" \
                "${used}% used, ${free} MB free" \
                "A full disk corrupts an LMDB write and takes the node down hard. Free space now — hub 08 key 7 (Disk Cleanup) handles archives, temp and nginx logs." \
                ""
        elif (( used >= 75 )); then
            adv_add WARN Disk "Disk filling up" \
                "${used}% used, ${free} MB free" \
                "Plan for chain growth plus any backups you keep on the same volume." \
                ""
        else
            adv_add OK Disk "Free space" "${used}% used, ${free} MB free" "Room for chain growth."
        fi
    fi

    if adv_is_num "$free" && (( free < 10240 )); then
        adv_add WARN Disk "Tight headroom for chain data" \
            "${free} MB free" \
            "Below ~10 GB free, a pruned mainnet node plus its logs and a single backup archive can fill the volume." \
            ""
    fi

    case "$sched" in
        none|mq-deadline|deadline|kyber)
            adv_add OK Disk "IO scheduler" "$sched" "Appropriate for SSD/NVMe."
            ;;
        cfq|bfq)
            adv_add INFO Disk "IO scheduler" \
                "$sched" \
                "On an SSD, 'none' or 'mq-deadline' generally beats a fairness scheduler for this workload. Low impact — worth changing only if IO is measurably a bottleneck." \
                ""
            ;;
        *)
            adv_add INFO Disk "IO scheduler" "${sched}" "Not determined — virtual/network-backed disks often expose no selectable scheduler."
            ;;
    esac

    if [[ "$opts" != "$HP_UNKNOWN" ]]; then
        if hp_atime_ok "$probe"; then
            adv_add OK Disk "atime behaviour" "$( [[ "$opts" == *noatime* ]] && echo noatime || echo relatime )" \
                "Read-heavy chain access is not generating a metadata write per read."
        else
            adv_add INFO Disk "atime writes enabled" \
                "neither noatime nor relatime in: ${opts}" \
                "Every read of a chain file also writes an access timestamp. Adding noatime removes pure-waste writes on a read-heavy workload." \
                "# add 'noatime' to this filesystem's options in /etc/fstab, then: mount -o remount,noatime ${probe}"
        fi
    fi

    if hp_unit_enabled fstrim.timer; then
        adv_add OK Disk "fstrim.timer" "enabled" "SSD blocks are being trimmed on schedule."
    elif [[ "$kind" == "ssd" ]]; then
        adv_add INFO Disk "fstrim.timer not enabled" \
            "disabled or absent" \
            "Weekly TRIM keeps SSD write latency stable as the chain directory churns." \
            "systemctl enable --now fstrim.timer"
    fi
}

# =============================================================================
# FILE DESCRIPTORS + NODE CONFIG
# =============================================================================
adv_check_node() {
    local soft hard
    soft=$(hp_nofile_soft); hard=$(hp_nofile_hard)

    # `ulimit -Sn` legitimately prints "unlimited", which is not a number — so
    # without this branch the fd check simply vanished on those hosts, and a
    # missing finding reads as a passed one.
    if [[ "$soft" == "unlimited" ]]; then
        adv_add OK Node "Open-file limit" "soft nofile = unlimited" "No descriptor ceiling to hit."
    elif adv_is_num "$soft"; then
        if (( soft < 4096 )); then
            adv_add WARN Node "Open-file limit low" \
                "soft nofile = ${soft} (hard = ${hard})" \
                "The node holds a socket per peer plus LMDB and MMR handles. With a high inbound peer limit, ${soft} descriptors runs out only once the peer count climbs — long after the operator stopped watching, so it presents as random peer loss." \
                "printf '* soft nofile 65535\\n* hard nofile 65535\\n' >> /etc/security/limits.conf   # then re-login; for systemd units set LimitNOFILE=65535"
        else
            adv_add OK Node "Open-file limit" "soft nofile = ${soft}" "Room for a high peer count."
        fi
    fi

    # peer_max_inbound_count sizing. Script 01 sets 999 deliberately so a
    # well-resourced box acts as a community seed. That is the right default
    # there and the wrong one on a 1 GB VPS — this check exists to catch the
    # mismatch, not to argue with the default.
    local ram net dir peers suggested
    ram=$(hp_mem_total_mb)
    for net in mainnet testnet; do
        dir=$(grin_live_node_dir "$net" 2>/dev/null || true)
        [[ -n "$dir" && -d "$dir" ]] || continue
        peers=$(hp_peer_max_inbound "$dir")
        adv_is_num "$peers" || continue
        adv_is_num "$ram"   || continue

        if   (( ram <  2048 )); then suggested=25
        elif (( ram <  4096 )); then suggested=50
        elif (( ram <  8192 )); then suggested=100
        else                         suggested=0     # 0 = leave the default alone
        fi

        if (( suggested > 0 && peers > suggested * 3 )); then
            adv_add WARN Node "Inbound peer limit high for this box (${net})" \
                "peer_max_inbound_count = ${peers} with ${ram} MB RAM" \
                "This is a toolkit heuristic, not a measured limit: each inbound peer costs a socket and buffers, so a community-seed value of ${peers} on ${ram} MB competes with the page cache the node depends on. Something nearer ${suggested} suits this box. Raise it once you can watch memory under load." \
                "sed -i 's/^peer_max_inbound_count = .*/peer_max_inbound_count = ${suggested}/' ${dir}/grin-server.toml   # then restart the node"
        else
            adv_add OK Node "Inbound peer limit (${net})" \
                "peer_max_inbound_count = ${peers}" \
                "Proportionate to ${ram} MB RAM."
        fi
    done
}

# =============================================================================
# TIME + LOGGING
# =============================================================================
adv_check_time_logs() {
    local ts
    ts=$(hp_timesync_unit)
    if [[ "$ts" == "none" ]]; then
        adv_add WARN Time "No time synchronisation running" \
            "no active timesync unit found" \
            "A drifting clock gets a node rejected or banned by its peers, and it fails in a way that looks like a networking problem. On Ubuntu 24 systemd-timesyncd is already installed." \
            "systemctl enable --now systemd-timesyncd"
    elif hp_clock_synced; then
        adv_add OK Time "Clock synchronised" "$ts, NTP synchronised" "Peers will accept this node's timestamps."
    else
        adv_add WARN Time "Time sync running but not synchronised" \
            "$ts active, NTPSynchronized=no" \
            "The unit is up but has not reached a source yet — check egress on UDP/123." \
            "timedatectl status"
    fi

    local cap size
    cap=$(hp_journal_max_use); size=$(hp_journal_size)
    if [[ "$cap" == "unset" ]]; then
        adv_add INFO Logs "journald size is uncapped" \
            "SystemMaxUse unset, currently using ${size}" \
            "Without a cap the journal grows until the volume is full, which takes the node down weeks after whoever enabled debug logging forgot about it." \
            "mkdir -p /etc/systemd/journald.conf.d && printf '[Journal]\\nSystemMaxUse=500M\\n' > /etc/systemd/journald.conf.d/99-grin.conf && systemctl restart systemd-journald"
    else
        adv_add OK Logs "journald capped" "SystemMaxUse=${cap} (currently ${size})" "Journal cannot fill the disk."
    fi
}

# =============================================================================
# SECURITY
# =============================================================================
# The node API ports carry no authentication beyond a shared secret and were
# never meant to face the internet. Everything else in this section is ordinary
# VPS hygiene; this first check is the Grin-specific one.
adv_check_security() {
    local fw raw
    fw=$(hp_ufw_state); raw=$(hp_raw_firewall_rules)

    case "$fw" in
        active)
            adv_add OK Security "Firewall active" "ufw enabled" "Inbound traffic is filtered."
            ;;
        inactive)
            adv_add CRIT Security "Firewall installed but OFF" \
                "ufw present, status inactive" \
                "Every listening port on this box is reachable from the internet. Allow SSH FIRST, then enable — enabling ufw before the SSH rule exists will lock you out of a remote VPS with no way back except the provider's console." \
                "ufw allow OpenSSH && ufw allow 3414/tcp && ufw --force enable"
            ;;
        absent)
            if adv_is_num "$raw" && (( raw > 5 )); then
                adv_add INFO Security "No ufw, but nftables/iptables rules exist" \
                    "${raw} raw firewall rules present" \
                    "Something is filtering already. Verify it covers the node API ports before assuming you are protected." \
                    "nft list ruleset 2>/dev/null | head -40"
            else
                adv_add CRIT Security "No firewall detected" \
                    "ufw absent and no meaningful raw rules" \
                    "Install and configure ufw. Allow SSH FIRST — enabling a firewall before the SSH rule exists locks you out of a remote VPS." \
                    "apt install -y ufw && ufw allow OpenSSH && ufw allow 3414/tcp && ufw --force enable"
            fi
            ;;
    esac

    # Node API exposure — the finding that matters most on a Grin box.
    #
    # ⚠ Grade by "is this address loopback?", NEVER by "is this address the
    # 0.0.0.0 wildcard". A node bound to one specific PUBLIC ip (a common way to
    # publish a node deliberately) is every bit as reachable as a wildcard bind,
    # but matches no wildcard pattern — so a wildcard test hands that box the
    # reassuring OK line "not directly reachable from the internet", which is
    # the exact opposite of the truth. Loopback is a short, closed list; public
    # is everything else, so test for the safe case and treat the rest as
    # exposed. Also: a port usually carries TWO listeners (v4 and v6), so read
    # every row rather than head -1 — the safe one must not mask the exposed one.
    local port bind binds exposed
    for port in 3413 13413; do
        binds=$(ss -tln "sport = :$port" 2>/dev/null | tail -n +2 | awk '{print $4}' || true)
        [[ -z "$binds" ]] && continue
        exposed=""
        while IFS= read -r bind; do
            [[ -n "$bind" ]] || continue
            _adv_is_loopback_bind "$bind" && continue
            exposed="${exposed:+$exposed, }$bind"
        done <<< "$binds"
        if [[ -n "$exposed" ]]; then
            bind="$exposed"
            if [[ "$fw" == "active" ]]; then
                adv_add WARN Security "Node API bound to all interfaces (port ${port})" \
                    "listening on ${bind}, firewall is up" \
                    "The firewall is currently the only thing between the node API and the internet. Confirm ufw does not allow ${port}, and prefer binding the API to 127.0.0.1 so a firewall mistake is not immediately fatal. Script 04 is the supported way to publish the FOREIGN API only." \
                    "ufw status | grep -E '${port}' || echo 'not allowed through ufw — good'"
            else
                adv_add CRIT Security "Node API publicly reachable (port ${port})" \
                    "listening on ${bind} with no active firewall" \
                    "The node API is exposed to the internet right now. Close it immediately. If you want to publish chain data publicly, use Script 04, which serves the FOREIGN API only and 403s the owner API." \
                    "ufw allow OpenSSH && ufw --force enable   # then verify: ss -tlnp 'sport = :${port}'"
            fi
        else
            adv_add OK Security "Node API bound to loopback (port ${port})" \
                "$(tr '\n' ' ' <<< "$binds")" \
                "Reachable only from this host, so a firewall mistake is not immediately fatal."
        fi
    done

    # Wallet listener ports should never be public either. Same loopback test —
    # a wildcard-only check would miss a listener pinned to the public IP.
    for port in 3415 13415; do
        binds=$(ss -tln "sport = :$port" 2>/dev/null | tail -n +2 | awk '{print $4}' || true)
        [[ -z "$binds" ]] && continue
        exposed=""
        while IFS= read -r bind; do
            [[ -n "$bind" ]] || continue
            _adv_is_loopback_bind "$bind" && continue
            exposed="${exposed:+$exposed, }$bind"
        done <<< "$binds"
        if [[ -n "$exposed" ]]; then
            adv_add WARN Security "Wallet listener reachable off-host (port ${port})" \
                "listening on ${exposed}" \
                "Expose a wallet listener publicly only if you intend to receive from strangers over it. Tor (wallet owner API) is the supported path for that." \
                ""
        fi
    done

    if hp_have fail2ban-client || hp_unit_active fail2ban; then
        if hp_unit_active fail2ban; then
            adv_add OK Security "fail2ban active" "running" "SSH brute-force attempts are being banned."
        else
            adv_add WARN Security "fail2ban installed but not running" \
                "inactive" "Start and enable it, or the jails do nothing." \
                "systemctl enable --now fail2ban"
        fi
    else
        adv_add WARN Security "fail2ban not installed" \
            "absent" \
            "A public SSH port sees continuous brute-force traffic. fail2ban's default sshd jail is enough to end it. Secondary to key-only login, not a substitute for it." \
            "apt install -y fail2ban && systemctl enable --now fail2ban"
    fi

    if hp_unattended_ok; then
        adv_add OK Security "Automatic security updates" "unattended-upgrades installed and scheduled" "Security patches apply without you."
    else
        adv_add WARN Security "Automatic security updates not active" \
            "unattended-upgrades missing or not scheduled" \
            "A node runs unattended for months. Installed-but-unscheduled is the usual trap, so verify the schedule as well as the package." \
            "apt install -y unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades"
    fi

    local pend
    pend=$(hp_pending_security_updates)
    if adv_is_num "$pend"; then
        if (( pend > 0 )); then
            adv_add WARN Security "Pending security updates" \
                "${pend} security update(s) waiting" \
                "Apply them, then reboot if the kernel was among them." \
                "apt update && apt upgrade -y"
        else
            adv_add OK Security "Security updates" "none pending" "System packages are current."
        fi
    fi
}

# =============================================================================
# SSH POSTURE  (read-only summary — 085 owns every change)
# =============================================================================
# Deliberately reports and never edits. 085_ssh_hardening.sh has the staged
# rollout, the sshd -t validation, the reload-not-restart rule and the
# dead-man timer; duplicating any of that here would create a second, worse
# path to the same change. This screen tells you whether to go there.
adv_check_ssh() {
    # ONE `sshd -T` for all three values. Three separate invocations could
    # disagree with each other (a reload between them), and each one re-parses
    # the whole config.
    local dump cfg_root cfg_pw port
    dump=$(sshd -T 2>/dev/null || true)
    cfg_root=$(awk '/^permitrootlogin /{print $2; exit}'      <<< "$dump" || true)
    cfg_pw=$(awk   '/^passwordauthentication /{print $2; exit}' <<< "$dump" || true)
    port=$(awk     '/^port /{print $2; exit}'                 <<< "$dump" || true)

    if [[ -z "$cfg_root" && -z "$cfg_pw" ]]; then
        adv_add INFO SSH "SSH configuration not readable" \
            "sshd -T produced no output" \
            "Cannot assess SSH posture here. Open SSH Key Hardening from this menu to inspect and change it."
        return 0
    fi

    adv_add INFO SSH "SSH listening port" "${port:-unknown}" "Shown so a non-default port is not mistaken for a closed one."

    if [[ "$cfg_pw" == "yes" ]]; then
        adv_add WARN SSH "Password authentication enabled" \
            "PasswordAuthentication yes" \
            "Key-only login removes the entire brute-force surface. Use SSH Key Hardening from this menu — it stages the change, validates with 'sshd -t', reloads rather than restarts, and offers a dead-man timer so a mistake cannot lock you out." \
            ""
    else
        adv_add OK SSH "Password authentication disabled" "PasswordAuthentication ${cfg_pw}" "Key-only login is in force."
    fi

    case "$cfg_root" in
        yes)
            adv_add WARN SSH "Root login by password permitted" \
                "PermitRootLogin yes" \
                "Set to prohibit-password so root can log in by key but never by password. SSH Key Hardening does this safely." \
                ""
            ;;
        prohibit-password|without-password)
            adv_add OK SSH "Root login" "PermitRootLogin ${cfg_root}" "Key-only for root."
            ;;
        no)
            adv_add OK SSH "Root login" "PermitRootLogin no" "Root cannot log in over SSH."
            ;;
        forced-commands-only)
            adv_add OK SSH "Root login" "PermitRootLogin forced-commands-only" \
                "Root may only run a key's forced command — no interactive root shell."
            ;;
        *)
            # Never fall silent on an unrecognised value: a blank where a
            # PermitRootLogin finding should be reads as "checked and fine".
            adv_add INFO SSH "Root login setting not recognised" \
                "PermitRootLogin ${cfg_root:-<empty>}" \
                "This value is not one this advisor knows how to grade — check it by hand in SSH Key Hardening."
            ;;
    esac
}

# =============================================================================
# RUN ALL
# =============================================================================
# Each check is ||-guarded: a probe that fails on an unusual host must cost its
# own section, never the rest of the report.
adv_run_all() {
    adv_reset
    adv_check_cpu        || true
    adv_check_memory     || true
    adv_check_kernel     || true
    adv_check_disk "/opt/grin" || true
    adv_check_node       || true
    adv_check_time_logs  || true
    adv_check_security   || true
    adv_check_ssh        || true
}
