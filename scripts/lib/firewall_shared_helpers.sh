# =============================================================================
# Shared Firewall Library — Grin Node Toolkit
# Part of: https://github.com/noobvie/grin-node-toolkit
# =============================================================================
#
# PURPOSE
#   Block / unblock one IP address or CIDR through whichever host firewall is
#   active (firewalld, ufw or plain iptables/ip6tables), so the block really
#   stops traffic and survives a reboot. Used by:
#     · Script 02 — IP Filtering (lib/02_lib_security.sh)
#     · Script 084 — Top 20 Bandwidth Consumers (block / rate-limit an IP)
#
#   Unprefixed file name (like nginx_shared_helpers.sh) because it is not owned
#   by one script. Functions are prefixed `fwh_`.
#
# WHY EACH BACKEND IS HANDLED THE WAY IT IS
#   · ufw evaluates rules top-down and stops at the first match. A plain
#     `ufw deny from X` is APPENDED below the existing `allow 80/443` rules, so
#     the blocked address still reaches nginx. The deny is therefore placed at
#     the top with `ufw prepend` (ufw ≥ 0.36). Without prepend, `ufw insert 1`
#     is used for IPv4 only: ufw refuses to insert an IPv6 rule at the position
#     of an IPv4 rule ("Invalid position"), so IPv6 goes in front of the first
#     (v6) rule instead.
#   · Plain iptables rules live only in the kernel until saved; they are saved
#     to the distro's boot-restore file after every change (fwh_persist).
#   · firewalld rich rules need the address family that matches the address.
#
# CONVENTIONS
#   · Messages go through info / warn / error / success. Callers that define
#     them (084) get their own styling; otherwise the fallbacks below are used
#     (Script 02 gets them from nginx_shared_helpers.sh, same text form).
#   · No `set -e` reliance — every firewall and file command is checked and the
#     function returns non-zero on failure.
#   · The block record (fwh_record_add / fwh_record_remove) is one file for every
#     caller, so an IP blocked from 084 can be unblocked from Script 02.
#   · Before blocking, callers check fwh_target_covers_ssh so the operator does not
#     lock out the SSH session the menu is running in.
# =============================================================================

[[ -n "${_FIREWALL_SHARED_HELPERS_LOADED:-}" ]] && return 0
_FIREWALL_SHARED_HELPERS_LOADED=1

type info    >/dev/null 2>&1 || info()    { echo "[INFO]  $*"; }
type warn    >/dev/null 2>&1 || warn()    { echo "[WARN]  $*" >&2; }
type error   >/dev/null 2>&1 || error()   { echo "[ERROR] $*" >&2; }
type success >/dev/null 2>&1 || success() { echo "[OK]    $*"; }

# ─── Address parsing ─────────────────────────────────────────────────────────

# True when $1 is a dotted-quad IPv4 address (no prefix).
_fwh_is_ipv4_addr() {
    local a="$1" o
    local oct='(0|[1-9][0-9]{0,2})'
    # No leading zeros: some tools read 010 as octal (8), others as decimal (10).
    [[ "$a" =~ ^$oct\.$oct\.$oct\.$oct$ ]] || return 1
    local IFS=.
    for o in $a; do
        (( 10#$o <= 255 )) || return 1
    done
    return 0
}

# True when $1 is an IPv6 address (no prefix): hex groups of 1-4 digits, at most
# one "::", 8 groups (or fewer with "::"), optional dotted IPv4 tail.
_fwh_is_ipv6_addr() {
    local a="$1" groups=8 rest g
    [[ "$a" == *:* && "$a" =~ ^[0-9A-Fa-f:.]+$ ]] || return 1
    if [[ "$a" =~ :([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
        local tail4="${BASH_REMATCH[1]}"     # saved: the next [[ =~ ]] resets BASH_REMATCH
        _fwh_is_ipv4_addr "$tail4" || return 1
        a="${a%"$tail4"}0:0"
    fi
    [[ "$a" == *.* ]] && return 1
    rest="${a//::/}"
    (( ${#a} - ${#rest} <= 2 )) || return 1          # more than one "::"
    [[ "$a" == *:::* ]] && return 1
    # A single colon at either end is only valid as half of "::" (rejects 1::2:, :1::2).
    if [[ "$a" == :* && "$a" != ::* ]]; then return 1; fi
    if [[ "$a" == *: && "$a" != *:: ]]; then return 1; fi
    if [[ "$a" == *::* ]]; then
        [[ "$a" == "::" ]] && return 0
        a="${a/::/:}"
        a="${a#:}"; a="${a%:}"
        local -a parts; IFS=: read -r -a parts <<< "$a"
        (( ${#parts[@]} <= groups - 1 )) || return 1
    else
        [[ "$a" == :* || "$a" == *: ]] && return 1
        local -a parts; IFS=: read -r -a parts <<< "$a"
        (( ${#parts[@]} == groups )) || return 1
    fi
    for g in "${parts[@]}"; do
        [[ "$g" =~ ^[0-9A-Fa-f]{1,4}$ ]] || return 1
    done
    return 0
}

# fwh_ip_family <target>
#   Prints "4" or "6" for a valid address or CIDR; returns 1 (prints nothing)
#   when the target is not a valid IPv4/IPv6 address or CIDR.
fwh_ip_family() {
    local t="${1:-}" addr prefix=""
    [[ -n "$t" ]] || return 1
    addr="${t%%/*}"
    if [[ "$t" == */* ]]; then
        prefix="${t#*/}"
        [[ "$prefix" =~ ^(0|[1-9][0-9]{0,2})$ ]] || return 1    # no leading zeros (/024)
    fi
    if _fwh_is_ipv4_addr "$addr"; then
        [[ -z "$prefix" ]] || (( 10#$prefix <= 32 )) || return 1
        echo 4; return 0
    fi
    if _fwh_is_ipv6_addr "$addr"; then
        [[ -z "$prefix" ]] || (( 10#$prefix <= 128 )) || return 1
        echo 6; return 0
    fi
    return 1
}

# fwh_validate_target <target>
#   Returns 0 when the target may be handed to a firewall, 1 otherwise (with an
#   error message). Refuses a /0 prefix: it would block every address, the
#   operator's SSH session included.
fwh_validate_target() {
    local t="${1:-}"
    if ! fwh_ip_family "$t" >/dev/null; then
        error "Not a valid IPv4/IPv6 address or CIDR: '${t}'"
        return 1
    fi
    if [[ "$t" == */* ]] && (( 10#${t#*/} == 0 )); then
        error "Refusing to block a /0 range — that blocks every address, your SSH session included."
        return 1
    fi
    return 0
}

# ─── Backend detection ───────────────────────────────────────────────────────

# fwh_detect
#   Prints the active backend: firewalld | ufw | iptables | none. Always returns 0.
#   firewalld first: it is the default on RHEL/Rocky/Alma, where driving iptables
#   directly conflicts with it. ufw only when ENABLED: the output must START with
#   "Status: active" (a disabled ufw says "Status: inactive"; lesson in
#   lib/07_lib_gateway.sh gw_open_firewall). A string test, not `ufw status | grep -q`:
#   under pipefail grep -q exits on the first match, ufw can die of SIGPIPE, and the
#   pipeline then reports failure for an active ufw. LC_ALL=C: ufw translates the
#   status line, so a non-English locale would never match.
#   iptables is the fallback whenever the binary exists, so a box with ufw
#   installed but disabled gets raw iptables rules.
fwh_detect() {
    if command -v firewall-cmd &>/dev/null && firewall-cmd --state &>/dev/null; then
        echo firewalld
    elif command -v ufw &>/dev/null && [[ "$(LC_ALL=C ufw status 2>/dev/null)" == "Status: active"* ]]; then
        echo ufw
    elif command -v iptables &>/dev/null; then
        echo iptables
    else
        echo none
    fi
    return 0
}

# ─── Lock-out guard: is the operator's own SSH address inside the target? ───

# Expand a valid IPv6 address (no prefix) to 32 lowercase hex digits.
_fwh_ipv6_expand() {
    local a="${1,,}" head tail out="" g i fill o1 o2 o3 o4
    local -a h=() tl=()
    if [[ "$a" =~ :([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
        local v4="${BASH_REMATCH[1]}"
        IFS=. read -r o1 o2 o3 o4 <<< "$v4"
        a="${a%"$v4"}$(printf '%x:%x' $(( (10#$o1 << 8) | 10#$o2 )) $(( (10#$o3 << 8) | 10#$o4 )))"
    fi
    if [[ "$a" == *::* ]]; then head="${a%%::*}"; tail="${a#*::}"; else head="$a"; tail=""; fi
    if [[ -n "$head" ]]; then IFS=: read -r -a h <<< "$head"; fi
    if [[ -n "$tail" ]]; then IFS=: read -r -a tl <<< "$tail"; fi
    fill=$(( 8 - ${#h[@]} - ${#tl[@]} ))
    for g in "${h[@]}"; do out+="$(printf '%04x' "$(( 16#$g ))")"; done
    for (( i = 0; i < fill; i++ )); do out+="0000"; done
    for g in "${tl[@]}"; do out+="$(printf '%04x' "$(( 16#$g ))")"; done
    echo "$out"
}

_fwh_ipv4_int() {
    local o1 o2 o3 o4
    IFS=. read -r o1 o2 o3 o4 <<< "$1"
    echo $(( (10#$o1 << 24) | (10#$o2 << 16) | (10#$o3 << 8) | 10#$o4 ))
}

# fwh_target_covers_ip <target> <ip>
#   Returns 0 when address <ip> lies inside <target> (an address or CIDR of the
#   same family), 1 otherwise. IPv6 is compared in expanded form, so case and
#   "::" spelling do not matter; a /32 or /128 target is the address itself.
fwh_target_covers_ip() {
    local t="${1:-}" ip="${2:-}" ft fip prefix a b full rem mask
    ft="$(fwh_ip_family "$t")" || return 1
    fip="$(fwh_ip_family "$ip")" || return 1
    [[ "$ft" == "$fip" && "$ip" != */* ]] || return 1
    if [[ "$t" == */* ]]; then
        prefix=$(( 10#${t#*/} ))
    elif [[ "$ft" == 4 ]]; then
        prefix=32
    else
        prefix=128
    fi
    if [[ "$ft" == 4 ]]; then
        a="$(_fwh_ipv4_int "${t%%/*}")"; b="$(_fwh_ipv4_int "$ip")"
        mask=$(( prefix == 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) & 0xFFFFFFFF ))
        (( (a & mask) == (b & mask) ))
        return
    fi
    a="$(_fwh_ipv6_expand "${t%%/*}")"; b="$(_fwh_ipv6_expand "$ip")"
    full=$(( prefix / 4 )); rem=$(( prefix % 4 ))
    [[ "${a:0:full}" == "${b:0:full}" ]] || return 1
    (( rem == 0 )) && return 0
    (( (16#${a:full:1} >> (4 - rem)) == (16#${b:full:1} >> (4 - rem)) ))
}

# fwh_ssh_client_ip
#   Prints the address of the SSH client this session came from; returns 1 (prints
#   nothing) when it cannot be found. sudo's env_reset strips SSH_CLIENT and
#   SSH_CONNECTION, so the environment is only the first source: next come the
#   same variables in the environ of each ancestor process (the login shell above
#   sudo still has them; root may read any /proc/<pid>/environ), then the utmp
#   entry for this terminal (`who -m --ips`).
fwh_ssh_client_ip() {
    local v="" ip="" pid i
    if [[ -n "${SSH_CLIENT:-}" ]]; then
        v="$SSH_CLIENT"
    elif [[ -n "${SSH_CONNECTION:-}" ]]; then
        v="$SSH_CONNECTION"
    else
        pid="$$"
        for (( i = 0; i < 32; i++ )); do
            [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 )) || break
            v="$(tr '\0' '\n' 2>/dev/null < "/proc/$pid/environ" \
                | sed -n 's/^SSH_CLIENT=//p; s/^SSH_CONNECTION=//p' | head -n 1)"
            [[ -n "$v" ]] && break
            pid="$(awk '/^PPid:/ {print $2}' "/proc/$pid/status" 2>/dev/null)"
        done
    fi
    ip="${v%% *}"
    if [[ -z "$ip" ]] && command -v who &>/dev/null; then
        v="$(who -m --ips 2>/dev/null)"
        ip="${v##* }"
        ip="${ip#(}"; ip="${ip%)}"
    fi
    # An IPv4 client on a dual-stack sshd can show as ::ffff:a.b.c.d.
    if [[ "${ip,,}" == ::ffff:*.*.*.* ]]; then ip="${ip:7}"; fi
    [[ "$ip" != */* ]] && fwh_ip_family "$ip" >/dev/null || return 1
    echo "$ip"
}

# fwh_target_covers_ssh <target>
#   Prints the current SSH client address and returns 0 when <target> contains it
#   (blocking <target> would lock the operator out). Returns 1, printing nothing,
#   when it does not or when the SSH client address is unknown.
fwh_target_covers_ssh() {
    local ip
    ip="$(fwh_ssh_client_ip)" || return 1
    fwh_target_covers_ip "${1:-}" "$ip" || return 1
    echo "$ip"
}

# ─── Block record (shared by Script 02 and 084) ──────────────────────────────
# One line per block: "<target> | <YYYY-MM-DD HH:MM UTC> | <reason>". Script 02's
# Unblock lists this file, so every caller that blocks records here.

# fwh_record_file — prints the record path (Script 02 sets BLOCKED_LIST_FILE).
fwh_record_file() {
    echo "${BLOCKED_LIST_FILE:-/etc/grin-toolkit/blocked_ips.list}"
}

# fwh_record_remove <target>
#   Drops every line whose first field is exactly <target> (an anchored regex
#   would also hit 1.2.3.45 when removing 1.2.3.4). Keeps the file's mode and
#   owner. Returns 0 (also when the file does not exist), 1 on a file error.
fwh_record_remove() {
    local t="${1:-}" file tmp
    file="$(fwh_record_file)"
    [[ -f "$file" ]] || return 0
    tmp="$(mktemp "${file}.XXXXXX")" || { error "Cannot create a temp file next to $file"; return 1; }
    if ! awk -F' [|] ' -v t="$t" '$1 != t' "$file" > "$tmp"; then
        rm -f "$tmp"; error "Cannot rewrite $file"; return 1
    fi
    chmod --reference="$file" "$tmp" || { rm -f "$tmp"; error "Cannot copy the mode of $file"; return 1; }
    chown --reference="$file" "$tmp" || { rm -f "$tmp"; error "Cannot copy the owner of $file"; return 1; }
    mv -f "$tmp" "$file" || { rm -f "$tmp"; error "Cannot replace $file"; return 1; }
    return 0
}

# fwh_record_add <target> [reason]
#   Replaces any record for <target> with a fresh line. "|" in the reason becomes
#   "/" so the field separator stays unambiguous. Returns 0, or 1 on a file error.
fwh_record_add() {
    local t="${1:-}" reason="${2:-}" file
    file="$(fwh_record_file)"
    reason="${reason//|//}"
    mkdir -p "$(dirname "$file")" || { error "Cannot create $(dirname "$file")"; return 1; }
    fwh_record_remove "$t" || return 1
    echo "$t | $(date -u '+%Y-%m-%d %H:%M UTC') | ${reason:-no reason}" >> "$file" \
        || { error "Cannot write the block record to $file"; return 1; }
    return 0
}

# ─── iptables persistence ────────────────────────────────────────────────────

# Write `<save_cmd>` output to <file> through a temp file, so a failed save never
# truncates the existing boot ruleset. Restores the SELinux label afterwards
# (mktemp's label is not the one /etc/sysconfig/iptables needs on RHEL).
_fwh_save_to() {
    local save_cmd="$1" file="$2" tmp
    command -v "$save_cmd" &>/dev/null || { error "$save_cmd not found — cannot save to $file"; return 1; }
    mkdir -p "$(dirname "$file")" || { error "Cannot create $(dirname "$file")"; return 1; }
    tmp="$(mktemp "${file}.XXXXXX")" || { error "Cannot create a temp file next to $file"; return 1; }
    if ! "$save_cmd" > "$tmp"; then
        rm -f "$tmp"
        error "$save_cmd failed — $file left unchanged"
        return 1
    fi
    chmod 600 "$tmp" || { rm -f "$tmp"; error "Cannot chmod $tmp"; return 1; }
    mv -f "$tmp" "$file" || { rm -f "$tmp"; error "Cannot move the saved ruleset to $file"; return 1; }
    if command -v restorecon &>/dev/null; then
        restorecon "$file" || warn "restorecon $file failed — check its SELinux label (ls -Z)."
    fi
    return 0
}

# fwh_persist [family]
#   Saves the FULL live iptables and ip6tables rulesets (every loaded rule — the
#   block just added, but also anything else currently loaded, e.g. Docker or
#   fail2ban rules) so they are restored at boot. [family] is the address family
#   just changed (4|6); the ip6tables-service warning on RHEL is shown only for 6
#   or when no family is given. Not for a box where ufw is active: ufw restores
#   only its own rules, and iptables-persistent cannot be installed next to it.
#   Returns:
#     0 — saved where a boot service restores them
#     1 — a save command failed (rules are live but will be lost at reboot)
#     2 — saved to the distro's file, but no restore service is installed/enabled,
#         so they will NOT come back at reboot; the message names the fix
fwh_persist() {
    local fam="${1:-}"
    # Debian/Ubuntu with iptables-persistent / netfilter-persistent.
    if command -v netfilter-persistent &>/dev/null; then
        if netfilter-persistent save >/dev/null 2>&1; then
            info "Full live iptables + ip6tables ruleset saved (netfilter-persistent) — restored at boot."
            return 0
        fi
        error "netfilter-persistent save failed — the rule is live but will be lost at reboot."
        return 1
    fi

    # RHEL family with iptables-services.
    if [[ -f /etc/redhat-release ]]; then
        _fwh_save_to iptables-save /etc/sysconfig/iptables || return 1
        if command -v ip6tables-save &>/dev/null; then
            _fwh_save_to ip6tables-save /etc/sysconfig/ip6tables || return 1
            if [[ "$fam" != 4 ]] && ! systemctl is-enabled ip6tables &>/dev/null; then
                warn "The ip6tables service is not enabled — IPv6 rules will NOT be restored at reboot"
                warn "(systemctl enable ip6tables)."
            fi
        fi
        if systemctl is-enabled iptables &>/dev/null; then
            info "Full live ruleset saved to /etc/sysconfig/iptables{,6} — restored at boot."
            return 0
        fi
        warn "Full live ruleset saved to /etc/sysconfig/iptables{,6}, but the iptables service is"
        warn "not enabled, so it will NOT be restored at reboot. Fix: dnf install iptables-services &&"
        warn "systemctl enable iptables ip6tables (or use firewalld, which persists by itself)."
        return 2
    fi

    # Debian/Ubuntu without iptables-persistent: write the files it would read.
    # Installing it here is not done: on Debian/Ubuntu it conflicts with (removes) ufw.
    _fwh_save_to iptables-save /etc/iptables/rules.v4 || return 1
    if command -v ip6tables-save &>/dev/null; then
        _fwh_save_to ip6tables-save /etc/iptables/rules.v6 || return 1
    fi
    warn "Full live ruleset saved to /etc/iptables/rules.v4 / rules.v6, but iptables-persistent"
    warn "is not installed, so it will NOT be restored at reboot."
    warn "Fix: apt install iptables-persistent (note: it conflicts with ufw and removes it)."
    return 2
}

# After deleting rules: rewrite only the boot files that already exist (or let
# netfilter-persistent do it), so a removed rule cannot come back at reboot. Writes
# nothing new and prints nothing on success. Returns 1 when a save failed.
_fwh_refresh_saved_rules() {
    if command -v netfilter-persistent &>/dev/null; then
        netfilter-persistent save >/dev/null 2>&1 \
            || { error "netfilter-persistent save failed — the saved ruleset still holds the old rule."; return 1; }
        return 0
    fi
    local pair save_cmd file
    for pair in iptables-save:/etc/iptables/rules.v4 ip6tables-save:/etc/iptables/rules.v6 \
                iptables-save:/etc/sysconfig/iptables ip6tables-save:/etc/sysconfig/ip6tables; do
        save_cmd="${pair%%:*}"; file="${pair#*:}"
        [[ -f "$file" ]] || continue
        _fwh_save_to "$save_cmd" "$file" || return 1
    done
    return 0
}

# ─── Per-backend block / unblock ─────────────────────────────────────────────
# Rule counts come back in _FWH_REMOVED, not on stdout: callers' error() may write
# to stdout, and capturing stdout would swallow the reason for a failure.

# The chains a block touches, as "<chain> <match-flag>" pairs.
_FWH_IPT_CHAINS=("INPUT -s" "FORWARD -s" "OUTPUT -d")
_FWH_REMOVED=0

_fwh_iptables_block() {
    local t="$1" tool="$2" spec chain flag
    command -v "$tool" &>/dev/null || { error "$tool not found — cannot block $t"; return 1; }
    for spec in "${_FWH_IPT_CHAINS[@]}"; do
        read -r chain flag <<< "$spec"
        "$tool" -C "$chain" "$flag" "$t" -j DROP 2>/dev/null && continue
        "$tool" -I "$chain" 1 "$flag" "$t" -j DROP \
            || { error "$tool: failed to insert DROP for $t in $chain"; return 1; }
    done
    success "$tool: blocked $t (INPUT / FORWARD / OUTPUT)"
    return 0
}

# _fwh_iptables_unblock <target> <tool> [quiet]
#   Deletes every DROP rule _fwh_iptables_block adds for <target>; count in
#   _FWH_REMOVED. "quiet" prints nothing when there was nothing to remove.
_fwh_iptables_unblock() {
    local t="$1" tool="$2" quiet="${3:-}" spec chain flag n
    _FWH_REMOVED=0
    command -v "$tool" &>/dev/null || { error "$tool not found — cannot unblock $t"; return 1; }
    for spec in "${_FWH_IPT_CHAINS[@]}"; do
        read -r chain flag <<< "$spec"
        # Loop: an older run could have inserted the same rule more than once.
        for (( n = 0; n < 20; n++ )); do
            "$tool" -C "$chain" "$flag" "$t" -j DROP 2>/dev/null || break
            "$tool" -D "$chain" "$flag" "$t" -j DROP \
                || { error "$tool: failed to delete DROP for $t in $chain"; return 1; }
            _FWH_REMOVED=$(( _FWH_REMOVED + 1 ))
        done
    done
    if (( _FWH_REMOVED > 0 )); then
        success "$tool: removed $_FWH_REMOVED DROP rule(s) for $t"
    elif [[ -z "$quiet" ]]; then
        info "$tool: no DROP rule found for $t — nothing to remove"
    fi
    return 0
}

# An IPv6 rule fails when /etc/default/ufw has IPV6=no; name the fix.
_fwh_ufw_v6_hint() {
    if [[ "$1" == 6 && "$2" == *IPv6* ]]; then
        error "Enable IPv6 in ufw: set IPV6=yes in /etc/default/ufw, then: ufw reload"
    fi
    return 0
}

# _fwh_ufw_delete_all <target> <family> [sweep]
#   Deletes every `deny from <target>` ufw rule (works while ufw is disabled too);
#   count in _FWH_REMOVED. Returns 0 when none remain, 1 on error.
#   "sweep" = ufw is not the active backend: there "IPv6 support not enabled" means
#   ufw can hold no IPv6 rule for <target>, so there is nothing to remove.
#   Every ufw call whose output is matched runs under LC_ALL=C: ufw translates it.
_fwh_ufw_delete_all() {
    local t="$1" fam="$2" sweep="${3:-}" out n
    _FWH_REMOVED=0
    for (( n = 0; n < 20; n++ )); do
        if ! out="$(LC_ALL=C ufw --force delete deny from "$t" to any 2>&1)"; then
            if [[ "$out" == *non-existent* ]]; then return 0; fi
            if [[ -n "$sweep" && "$out" == *"IPv6 support not enabled"* ]]; then return 0; fi
            error "ufw delete failed for $t: $out"
            _fwh_ufw_v6_hint "$fam" "$out"
            return 1
        fi
        if [[ "$out" == *non-existent* ]]; then return 0; fi
        _FWH_REMOVED=$(( _FWH_REMOVED + 1 ))
    done
    return 0
}

_fwh_ufw_block() {
    local t="$1" fam="$2" out pos
    # Remove any existing deny for this target first: ufw skips a rule it already
    # has, so a deny appended below the allows would otherwise stay where it is.
    _fwh_ufw_delete_all "$t" "$fam" || return 1

    if ufw --help 2>&1 | grep -qw prepend; then
        out="$(LC_ALL=C ufw prepend deny from "$t" to any 2>&1)" \
            || { error "ufw prepend failed for $t: $out"; _fwh_ufw_v6_hint "$fam" "$out"; return 1; }
    else
        # ufw < 0.36: insert in front of the first rule of the same family.
        if [[ "$fam" == 6 ]]; then
            pos="$(LC_ALL=C ufw status numbered 2>/dev/null | sed -n 's/^\[ *\([0-9][0-9]*\)\].*(v6).*/\1/p' | head -1)"
        else
            pos="$(LC_ALL=C ufw status numbered 2>/dev/null | grep -v '(v6)' | sed -n 's/^\[ *\([0-9][0-9]*\)\].*/\1/p' | head -1)"
        fi
        if [[ -n "$pos" ]]; then
            out="$(LC_ALL=C ufw insert "$pos" deny from "$t" to any 2>&1)" \
                || { error "ufw insert $pos failed for $t: $out"; _fwh_ufw_v6_hint "$fam" "$out"; return 1; }
        else
            # No rule of this family yet, so an appended rule is the first one.
            out="$(LC_ALL=C ufw deny from "$t" to any 2>&1)" \
                || { error "ufw deny failed for $t: $out"; _fwh_ufw_v6_hint "$fam" "$out"; return 1; }
        fi
    fi
    if [[ "$out" == *ERROR* ]]; then
        error "ufw rejected the rule for $t: $out"
        _fwh_ufw_v6_hint "$fam" "$out"
        return 1
    fi
    success "ufw: blocked $t (placed above the allow rules)"
    return 0
}

_fwh_ufw_unblock() {
    local t="$1" fam="$2"
    _fwh_ufw_delete_all "$t" "$fam" || return 1
    if (( _FWH_REMOVED > 0 )); then
        success "ufw: unblocked $t ($_FWH_REMOVED rule(s) removed)"
    else
        info "ufw: no deny rule found for $t — nothing to remove"
    fi
    return 0
}

_fwh_firewalld_rule() {
    local t="$1" fam="$2"
    echo "rule family='ipv${fam}' source address='${t}' drop"
}

_fwh_firewalld_block() {
    local t="$1" fam="$2" rule
    rule="$(_fwh_firewalld_rule "$t" "$fam")"
    if ! firewall-cmd --permanent --query-rich-rule="$rule" &>/dev/null; then
        firewall-cmd --permanent --add-rich-rule="$rule" >/dev/null \
            || { error "firewalld: failed to add drop rule for $t"; return 1; }
    fi
    firewall-cmd --reload >/dev/null \
        || { error "firewalld: rule saved but reload failed — run: firewall-cmd --reload"; return 1; }
    success "firewalld: blocked $t (permanent)"
    return 0
}

_fwh_firewalld_unblock() {
    local t="$1" fam="$2" rule
    rule="$(_fwh_firewalld_rule "$t" "$fam")"
    if ! firewall-cmd --permanent --query-rich-rule="$rule" &>/dev/null; then
        info "firewalld: no drop rule found for $t — nothing to remove"
        return 0
    fi
    firewall-cmd --permanent --remove-rich-rule="$rule" >/dev/null \
        || { error "firewalld: failed to remove drop rule for $t"; return 1; }
    firewall-cmd --reload >/dev/null \
        || { error "firewalld: rule removed but reload failed — run: firewall-cmd --reload"; return 1; }
    success "firewalld: unblocked $t"
    return 0
}

# ─── Public entry points ─────────────────────────────────────────────────────

# fwh_block_ip <target> [backend]
#   Blocks <target> (IPv4/IPv6 address or CIDR) on [backend] (default: fwh_detect).
#   Does not write the block record — call fwh_record_add after a 0 or 2.
#   Returns:
#     0 — blocked, and the block survives a reboot
#     1 — invalid target, no firewall, or a firewall command failed: NOT blocked
#     2 — blocked now, but it will NOT survive a reboot (iptables without a
#         restore service; fwh_persist already printed the fix)
fwh_block_ip() {
    local t="${1:-}" backend="${2:-}" fam
    fwh_validate_target "$t" || return 1
    fam="$(fwh_ip_family "$t")"
    [[ -n "$backend" ]] || backend="$(fwh_detect)"
    case "$backend" in
        firewalld) _fwh_firewalld_block "$t" "$fam" || return 1 ;;
        ufw)       _fwh_ufw_block "$t" "$fam" || return 1 ;;
        iptables)
            if [[ "$fam" == 6 ]]; then
                _fwh_iptables_block "$t" ip6tables || return 1
            else
                _fwh_iptables_block "$t" iptables || return 1
            fi
            # 1 (save failed) and 2 (no restore service) both mean "lost at reboot".
            fwh_persist "$fam" || return 2
            return 0
            ;;
        *)
            error "No supported firewall is active (firewalld, ufw or iptables) — $t was NOT blocked."
            return 1
            ;;
    esac
    return 0
}

# fwh_unblock_ip <target> [backend]
#   Removes the block for <target> on [backend] (default: fwh_detect), and also
#   whatever a block made under a DIFFERENT backend left behind — the firewall
#   active now need not be the one active at block time: raw iptables/ip6tables
#   DROP rules (blocked while ufw/firewalld was off) and a deny in a disabled ufw's
#   rule set (it would return the day ufw is enabled). Saved boot rulesets are
#   rewritten whenever raw rules are deleted. Does not touch the block record — call
#   fwh_record_remove after a 0 or 2.
#   Returns:
#     0 — no block remains (removed, or none was found)
#     1 — invalid target, no firewall, or a firewall command failed
#     2 — removed now, but the saved boot ruleset could not be updated, so the
#         block may come back at reboot
fwh_unblock_ip() {
    local t="${1:-}" backend="${2:-}" fam tool raw_removed=0 failed=0 saved_ok=1
    fwh_ip_family "$t" >/dev/null || { error "Not a valid IPv4/IPv6 address or CIDR: '${t}'"; return 1; }
    fam="$(fwh_ip_family "$t")"
    tool=iptables; [[ "$fam" == 6 ]] && tool=ip6tables
    [[ -n "$backend" ]] || backend="$(fwh_detect)"
    case "$backend" in
        firewalld) _fwh_firewalld_unblock "$t" "$fam" || return 1 ;;
        ufw)       _fwh_ufw_unblock "$t" "$fam" || return 1 ;;
        iptables)
            _fwh_iptables_unblock "$t" "$tool" || failed=1
            raw_removed=$_FWH_REMOVED
            ;;
        *)
            error "No supported firewall is active (firewalld, ufw or iptables)."
            return 1
            ;;
    esac

    if (( ! failed )) && [[ "$backend" != iptables ]] && command -v "$tool" &>/dev/null; then
        _fwh_iptables_unblock "$t" "$tool" quiet || failed=1
        raw_removed=$_FWH_REMOVED
    fi
    if (( ! failed )) && [[ "$backend" != ufw ]] && command -v ufw &>/dev/null; then
        if _fwh_ufw_delete_all "$t" "$fam" sweep; then
            if (( _FWH_REMOVED > 0 )); then
                info "Also removed $_FWH_REMOVED deny rule(s) for $t from the disabled ufw's rule set."
            fi
        else
            failed=1
        fi
    fi
    # Raw rules deleted from the kernel must leave the saved ruleset too, even when a
    # later step failed — otherwise they come back at reboot.
    if (( raw_removed > 0 )); then
        _fwh_refresh_saved_rules || saved_ok=0
    fi
    if (( failed )); then return 1; fi
    if (( ! saved_ok )); then return 2; fi
    return 0
}
