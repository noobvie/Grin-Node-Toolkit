# =============================================================================
# 08_lib_host_updates.sh — automatic OS SECURITY updates (prefix hu_)
# =============================================================================
# Sourced, not executed — no shebang (see CLAUDE.md). Hub-08 shared: used
# locally by 083 (menu key 9) and written so 081's Mass Deployment can send the
# same work to a remote box over SSH.
#
# CONTRACT — the work lives in four SELF-CONTAINED bash scripts held in strings
# (built by hu_script), in the style of 081's _MD_NODE_STOP_SNIPPET: no toolkit
# functions or colours inside, run as root, plain-text output, last line
# `__OK__` on success. A remote box has no toolkit libs, so nothing in a snippet
# may call into this file.
#
#   hu_script <action> [nodesource=yes|no]   prints the runnable script text
#       action: status | enable | disable | run-now
#       Pipe it to `bash -s` locally or `ssh … bash -s` remotely.
#
#   status  read-only `key=value` lines (see HU_STATUS_KEYS below) + note= lines
#   enable  idempotent. apt: unattended-upgrades + 20auto-upgrades + the toolkit
#           policy drop-in (security pocket only, no reboot) + a needrestart
#           list-only drop-in. dnf: dnf-automatic, security-only apply, no reboot.
#           Fails (no __OK__) if the effective config read back afterwards is
#           not security-only, not scheduled, or allows an automatic reboot.
#   disable removes ONLY files that still carry the toolkit marker, turns the
#           schedule off, never purges a package, then reports the real state.
#   run-now one security-only patch pass. Never reboots. Never streamed to a
#           session: both callers start it through hu_launch_script (detached,
#           logged to /var/log/grin-host-updates/) and read it back with
#           hu_poll_script — see "Detached patch runs" below.
#
# Text that comes back from a snippet, a log or a remote host is passed through
# _hu_clean and printed only as a printf %s argument.
#
# What "no restarts" means: library updates never trigger a service restart
# (needrestart is list-only). A patched DAEMON package — nginx, tor, php-fpm,
# openssh — may still restart its own service from its maintainer script
# (dh_installsystemd restart-after-upgrade; EL %systemd_postun_with_restart).
# The grin node and the pool are not packages, so no update touches them.
#
# Inputs are ENVIRONMENT lines prepended by hu_script, not argv, so the same
# text works through `bash -s` with or without an ssh hop:
#   HU_NODESOURCE=yes|no   enable only: also allow deb.nodesource.com (apt)
#   HU_TEST=1 + HU_ROOT    TEST ONLY — see "HU_ROOT" below
#
# State lives in /var/lib/grin-toolkit/host-updates/, NOT /opt/grin: the full
# cleanup (08del) removes /opt/grin but deliberately leaves this host-wide
# security policy in place, and the backups must stay beside it.
#
# ⚠ ERREXIT: the wrappers here are called as `fn || true` from 083's menu, which
# disables errexit for their whole body. Every create/move/delete is guarded
# explicitly, both here and inside the snippets (which run with `set -u` only).
#
# Design and the apt/dnf research behind the policy → docs/reference/
# script083_design.md §10; as built → script083_implementation.md.
# =============================================================================

[[ -n "${HU_LIB_LOADED:-}" ]] && return 0
HU_LIB_LOADED=1

# The wrappers below are also meant for 081, which may not define all of these.
declare -F log     >/dev/null || log()     { :; }
declare -F info    >/dev/null || info()    { echo "[INFO]  $*"; }
declare -F success >/dev/null || success() { echo "[OK]    $*"; }
declare -F warn    >/dev/null || warn()    { echo "[WARN]  $*"; }
declare -F error   >/dev/null || error()   { echo "[ERROR] $*"; }

# Keys the status snippet prints, in display order. A caller over SSH parses the
# same lines, so renaming a key is an interface change for 081.
# shellcheck disable=SC2034  # the published key list, for callers that parse status
HU_STATUS_KEYS=(family distro auto_updates toolkit_policy security_only
    pending_security reboot_required services_restart needrestart_policy
    nodesource_origin php_repo lock_busy)

# -----------------------------------------------------------------------------
# Shared prelude, concatenated in front of every snippet body so each runnable
# script is complete on its own.
#
# HU_ROOT: a path prefix applied to every /etc, /var and /usr path a snippet
# reads or writes, so enable/disable can be exercised against a scratch tree on
# a dev box without touching its real config. It takes effect ONLY together
# with HU_TEST=1 — a stray HU_ROOT exported in root's environment must never
# turn a real enable into a scratch-dir no-op that still prints __OK__. In test
# mode: package installs, systemctl and the patch run are SKIPPED (printed as
# `skip:`), the root check is waived, and apt-config is pointed at the scratch
# tree through APT_CONFIG. Live read-only probes (apt-get -s, needrestart,
# fuser) still read the real host. HU_FAMILY / HU_DNF_VERSION override
# detection only in that mode, so the dnf layout can be tested on an apt box.
#
# Temp files carry a `.bak` suffix: apt reads every file in apt.conf.d without
# an extension, but silently ignores `*.bak` (Dir::Ignore-Files-Silently), so a
# half-written temp can never be parsed as config.
# -----------------------------------------------------------------------------
read -r -d '' _HU_PRELUDE <<'HU_EOF' || true
set -u
export LC_ALL=C
R=""
if [[ "${HU_TEST:-}" == 1 ]]; then
    R="${HU_ROOT:-}"; R="${R%/}"
    case "$R" in /*) ;; *) echo "ERROR: HU_TEST=1 needs an absolute HU_ROOT"; exit 2 ;; esac
elif [[ -n "${HU_ROOT:-}" ]]; then
    echo "WARN: HU_ROOT is set without HU_TEST=1 — ignored, acting on the real system"
fi
if [[ -z "$R" && "$(id -u)" -ne 0 ]]; then echo "ERROR: must run as root"; exit 1; fi
NS="${HU_NODESOURCE:-no}"
case "$NS" in yes|no) ;; *) echo "ERROR: HU_NODESOURCE must be yes or no"; exit 2 ;; esac
MARK="Written by Grin Node Toolkit (host updates)"
ST_DIR="$R/var/lib/grin-toolkit/host-updates"; ST="$ST_DIR/state"
AAC="$R/etc/apt/apt.conf.d"
F_AUTO="$AAC/20auto-upgrades"
F_POL="$AAC/52grin-unattended-upgrades"
NR_DIR="$R/etc/needrestart"; F_NR="$NR_DIR/conf.d/50-grin.conf"
F_DNF="$R/etc/dnf/automatic.conf"
OS_ID=""; OS_CODE=""
for _f in "$R/etc/os-release" /etc/os-release; do
    [[ -r "$_f" ]] || continue
    OS_ID=$(sed -n 's/^ID="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$_f" | head -1)
    OS_CODE=$(sed -n 's/^VERSION_CODENAME="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$_f" | head -1)
    break
done
if [[ -n "$R" && -n "${HU_FAMILY:-}" ]]; then FAM="$HU_FAMILY"
elif command -v apt-get >/dev/null 2>&1; then FAM=apt
elif command -v dnf >/dev/null 2>&1; then FAM=dnf
else FAM=unknown; fi
DNFV=4
if [[ -n "$R" && -n "${HU_DNF_VERSION:-}" ]]; then DNFV="$HU_DNF_VERSION"
elif command -v dnf5 >/dev/null 2>&1 && [[ "$(readlink -f "$(command -v dnf 2>/dev/null)" 2>/dev/null)" == */dnf5 ]]; then DNFV=5; fi
if [[ "$DNFV" == 5 ]]; then DNF_PKG=dnf5-plugin-automatic; DNF_TIMER=dnf5-automatic.timer
else DNF_PKG=dnf-automatic; DNF_TIMER=dnf-automatic.timer; fi
APTBOOT=""
if [[ -n "$R" && "$FAM" == apt ]]; then
    APTBOOT=$(mktemp) || { echo "ERROR: mktemp failed"; exit 1; }
    trap 'rm -f "$APTBOOT"' EXIT
    printf 'Dir::Etc "%s/etc/apt/";\n' "$R" > "$APTBOOT" || { echo "ERROR: cannot write $APTBOOT"; exit 1; }
fi
_aptcfg() {
    if [[ -n "$APTBOOT" ]]; then APT_CONFIG="$APTBOOT" apt-config "$@"; else apt-config "$@"; fi
}
_aptval() { _aptcfg shell V "$1" 2>/dev/null | sed -n "s/^V='\(.*\)'$/\1/p"; }
_aptbool() {
    case "${1,,}" in true|yes|on|1|enable) echo true ;; "") echo unset ;; *) echo false ;; esac
}
_wr() {
    local f="$1" t
    mkdir -p "$(dirname "$f")" || { echo "ERROR: cannot create $(dirname "$f")"; return 1; }
    t="$f.hu$$.bak"
    if cat > "$t" && chmod 644 "$t" && mv -f "$t" "$f"; then return 0; fi
    rm -f "$t" 2>/dev/null
    echo "ERROR: could not write $f"; return 1
}
_st_get() { [[ -r "$ST" ]] && sed -n "s/^$1=//p" "$ST" | tail -1; return 0; }
_st_set() {
    local cur=""
    [[ -r "$ST" ]] && cur=$(grep -v "^$1=" "$ST")
    { [[ -n "$cur" ]] && printf '%s\n' "$cur"; printf '%s=%s\n' "$1" "$2"; } | _wr "$ST"
}
_ours() { [[ -f "$1" ]] && grep -qF "$MARK" "$1" 2>/dev/null; }
_systemd_up() { [[ -z "$R" && -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1; }
_unit() {
    if [[ -n "$R" ]]; then echo skipped; return 0; fi
    _systemd_up || { echo no-systemd; return 0; }
    local s; s=$(systemctl is-enabled "$1" 2>/dev/null </dev/null); echo "${s:-not-found}"
}
_unit_on() { case "$1" in enabled|enabled-runtime|static|alias|generated|skipped) return 0 ;; esac; return 1; }
_apt_timers() {
    T1=$(_unit apt-daily.timer); T2=$(_unit apt-daily-upgrade.timer); TIMERS=ok
    if [[ "$T1" == no-systemd ]]; then
        [[ -x /etc/cron.daily/apt-compat ]] || TIMERS=off
    elif ! _unit_on "$T1" || ! _unit_on "$T2"; then TIMERS=off; fi
}
_ini_get() {
    [[ -r "$1" ]] || return 0
    awk -v s="$2" -v k="$3" '/^[ \t]*\[/{ins=($0 ~ "^[ \t]*\\[" s "\\]")} ins && $0 ~ "^[ \t]*" k "[ \t]*=" {sub(/^[^=]*=[ \t]*/,""); sub(/[ \t\r]+$/,""); v=$0} END{print v}' "$1"
}
_dnf_eff() {
    local v; v=$(_ini_get "$F_DNF" commands "$1")
    if [[ -z "$v" && "$DNFV" == 5 ]]; then v=$(_ini_get "$R/usr/share/dnf5/dnf5-plugins/automatic.conf" commands "$1"); fi
    echo "${v:-$2}"
}
_policy_patterns() {
    # shellcheck disable=SC2016  # ${distro_codename} is expanded by unattended-upgrade, not bash
    case "$OS_ID" in
        ubuntu) printf '%s\n' 'origin=Ubuntu,archive=${distro_codename}-security' \
                    'origin=UbuntuESMApps,archive=${distro_codename}-apps-security' \
                    'origin=UbuntuESM,archive=${distro_codename}-infra-security' ;;
        debian) printf '%s\n' 'origin=Debian,codename=${distro_codename}-security,label=Debian-Security' ;;
        *) return 1 ;;
    esac
    if [[ "$NS" == yes ]]; then echo 'site=deb.nodesource.com,codename=nodistro'; fi
}
_apt_origins() {
    _aptcfg dump 2>/dev/null | sed -n 's/^Unattended-Upgrade::\(Origins-Pattern\|Allowed-Origins\):: "\(.*\)";$/\2/p'
}
_classify_origins() {
    local e sec=0 other="" ns=no
    while IFS= read -r e; do
        [[ -z "$e" ]] && continue
        # shellcheck disable=SC2016  # literal unattended-upgrade patterns, matched exactly
        case "$e" in
            'origin=Ubuntu,archive=${distro_codename}-security'|\
            'origin=UbuntuESMApps,archive=${distro_codename}-apps-security'|\
            'origin=UbuntuESM,archive=${distro_codename}-infra-security'|\
            'origin=Debian,codename=${distro_codename}-security,label=Debian-Security'|\
            'origin=Debian,codename=${distro_codename},label=Debian-Security'|\
            '${distro_id}:${distro_codename}-security'|\
            '${distro_id}ESMApps:${distro_codename}-apps-security'|\
            '${distro_id}ESM:${distro_codename}-infra-security') sec=1 ;;
            'site=deb.nodesource.com,codename=nodistro') ns=yes ;;
            *) other="${other:+$other; }$e" ;;
        esac
    done < <(_apt_origins)
    if [[ -n "$other" ]]; then SEC_ONLY=no
    elif (( sec )) && [[ "$ns" == yes ]]; then SEC_ONLY=yes+nodesource
    elif (( sec )); then SEC_ONLY=yes
    else SEC_ONLY=n/a; fi
    NONSEC="$other"; NS_ALLOWED="$ns"
}
_apt_auto() {
    AUTO_NOTES=()
    local inst=no per upl
    command -v unattended-upgrade >/dev/null 2>&1 && inst=yes
    per=$(_aptval APT::Periodic::Unattended-Upgrade)
    upl=$(_aptval APT::Periodic::Update-Package-Lists)
    _apt_timers
    AU=off
    if [[ "$inst" == yes && -n "$per" && "$per" != 0 && -n "$upl" && "$upl" != 0 && "$TIMERS" == ok ]]; then AU=on; fi
    [[ "$inst" == no ]] && AUTO_NOTES+=("unattended-upgrades is not installed")
    [[ -z "$per" || "$per" == 0 ]] && AUTO_NOTES+=("APT::Periodic::Unattended-Upgrade is off")
    [[ -z "$upl" || "$upl" == 0 ]] && AUTO_NOTES+=("APT::Periodic::Update-Package-Lists is off")
    if [[ "$TIMERS" != ok ]]; then AUTO_NOTES+=("apt timers not active (apt-daily.timer: $T1, apt-daily-upgrade.timer: $T2)"); fi
    return 0
}
_dnf_auto() {
    AUTO_NOTES=()
    local inst=unknown tmr itmr=no apply
    if [[ -z "$R" ]] && command -v rpm >/dev/null 2>&1; then
        if rpm -q "$DNF_PKG" >/dev/null 2>&1 </dev/null; then inst=yes; else inst=no; fi
    elif [[ -n "$R" ]]; then inst=yes
    fi
    tmr=$(_unit "$DNF_TIMER")
    if [[ "$DNFV" == 4 && "$(_unit dnf-automatic-install.timer)" == enabled ]]; then itmr=yes; fi
    apply=$(_dnf_eff apply_updates no)
    AU=off
    if [[ "$inst" == yes ]]; then
        if [[ "$itmr" == yes ]] || { _unit_on "$tmr" && [[ "$apply" =~ ^(yes|true|1)$ ]]; }; then AU=on; fi
    fi
    [[ "$inst" == no ]] && AUTO_NOTES+=("$DNF_PKG is not installed")
    [[ "$itmr" == yes ]] && AUTO_NOTES+=("dnf-automatic-install.timer is enabled (it always applies updates)")
    return 0
}
_lock_busy() {
    if [[ "$FAM" == apt ]]; then
        if command -v fuser >/dev/null 2>&1; then
            fuser "$R/var/lib/dpkg/lock-frontend" "$R/var/lib/dpkg/lock" >/dev/null 2>&1 && { echo yes; return 0; }
            echo no; return 0
        fi
        if pgrep -x 'apt|apt-get|dpkg|aptitude' >/dev/null 2>&1 \
            || pgrep -f '/usr/bin/unattended-upgrade( |$)' >/dev/null 2>&1; then echo yes; else echo no; fi
    elif [[ "$FAM" == dnf ]]; then
        if pgrep -x 'dnf|dnf5|dnf-automatic|rpm|yum' >/dev/null 2>&1; then echo yes; else echo no; fi
    else echo unknown; fi
}
# dnf probes run cache-only (-C) under `timeout`: a status read must never wait
# on the dnf cache lock or a metadata refresh. `needs-restarting` is a plugin,
# and a missing plugin exits 1 ("No such command") — the same code that means
# "reboot required" — so the plugin is detected first and the -r answer is read
# from its TEXT, not its exit code.
_restart_probe() {
    REBOOT=unknown; SVCS=unknown
    if [[ "$FAM" == apt ]]; then
        REBOOT=no
        [[ -e "$R/var/run/reboot-required" ]] && REBOOT=yes
        if command -v needrestart >/dev/null 2>&1; then
            local nr k
            nr=$(NEEDRESTART_MODE=l timeout 120 needrestart -b -r l 2>/dev/null </dev/null || true)
            SVCS=$(sed -n 's/^NEEDRESTART-SVC: //p' <<< "$nr" | paste -sd, -)
            SVCS="${SVCS:-none}"
            k=$(sed -n 's/^NEEDRESTART-KSTA: //p' <<< "$nr" | head -1)
            case "$k" in 2|3) REBOOT=yes ;; esac
        fi
    elif [[ "$FAM" == dnf ]] && command -v dnf >/dev/null 2>&1; then
        timeout 30 dnf -q needs-restarting --help >/dev/null 2>&1 </dev/null || return 0
        local rc=0 out
        out=$(timeout 60 dnf -C needs-restarting -r 2>&1 </dev/null) || rc=$?
        if [[ "$out" == *"Reboot is required"* ]]; then REBOOT=yes
        elif [[ "$rc" -eq 0 ]]; then REBOOT=no; fi
        rc=0; out=$(timeout 60 dnf -q -C needs-restarting -s 2>/dev/null </dev/null) || rc=$?
        if [[ "$rc" -eq 0 ]]; then SVCS=$(grep -v '^[[:space:]]*$' <<< "$out" | paste -sd, -); SVCS="${SVCS:-none}"; fi
    fi
    return 0
}
HU_EOF

# -----------------------------------------------------------------------------
# status — read-only. Never takes the dpkg lock: the pending count uses
# `apt-get -s dist-upgrade` with Debug::NoLocking (dist-upgrade, not upgrade,
# so a kernel ABI bump that needs a new package is counted, not held back).
# auto_updates=on needs the package installed AND the schedule live — on apt
# both APT::Periodic values non-zero (read from apt's EFFECTIVE config, so a
# later file overriding ours is seen) and both apt-daily timers enabled; on dnf
# the timer enabled and apply_updates=yes (or dnf 4's always-apply timer).
# -----------------------------------------------------------------------------
read -r -d '' _HU_STATUS_BODY <<'HU_EOF' || true
echo "family=$FAM"
echo "distro=${OS_ID:-unknown}${OS_CODE:+ $OS_CODE}"
NOTES=()
if [[ "$FAM" == apt ]]; then
    _apt_auto
    echo "auto_updates=$AU"
    NOTES+=("${AUTO_NOTES[@]+"${AUTO_NOTES[@]}"}")
    if [[ -f "$F_POL" ]]; then echo "toolkit_policy=present"; else echo "toolkit_policy=absent"; fi
    _classify_origins
    echo "security_only=$SEC_ONLY"
    [[ -n "$NONSEC" ]] && NOTES+=("effective policy also allows non-security origins: $NONSEC")
    rb=$(_aptbool "$(_aptval Unattended-Upgrade::Automatic-Reboot)")
    [[ "$rb" == true ]] && NOTES+=("Unattended-Upgrade::Automatic-Reboot is true — the box may reboot itself")
    n=$(apt-get -s -o Debug::NoLocking=true dist-upgrade 2>/dev/null </dev/null | grep -ci '^Inst.*security' || true)
    [[ "$n" =~ ^[0-9]+$ ]] || n=unknown
    echo "pending_security=$n"
    _restart_probe
    echo "reboot_required=$REBOOT"
    echo "services_restart=$SVCS"
    if [[ -d "$NR_DIR" ]]; then
        if _ours "$F_NR"; then echo "needrestart_policy=present"; else echo "needrestart_policy=absent"; fi
    else echo "needrestart_policy=n/a"; fi
    if grep -rqsF deb.nodesource.com "$R/etc/apt/sources.list" "$R/etc/apt/sources.list.d/"; then
        if [[ "$NS_ALLOWED" == yes ]]; then
            echo "nodesource_origin=allowed"
            NOTES+=("NodeSource ships every Node.js 24.x release, not security fixes only")
        else echo "nodesource_origin=not-allowed"; fi
    else echo "nodesource_origin=n/a"; fi
    tp=$(grep -rlsE 'ppa\.launchpad(content)?\.net/ondrej|packages\.sury\.org' "$R/etc/apt/sources.list" "$R/etc/apt/sources.list.d/" | xargs -r -n1 basename | paste -sd, -)
elif [[ "$FAM" == dnf ]]; then
    _dnf_auto
    echo "auto_updates=$AU"
    NOTES+=("${AUTO_NOTES[@]+"${AUTO_NOTES[@]}"}")
    if _ours "$F_DNF"; then echo "toolkit_policy=present"; else echo "toolkit_policy=absent"; fi
    utype=$(_dnf_eff upgrade_type default)
    if [[ "$utype" == security ]]; then echo "security_only=yes"; else echo "security_only=no"; NOTES+=("dnf-automatic upgrade_type is '$utype'"); fi
    rbt=$(_dnf_eff reboot never)
    [[ "$rbt" == never ]] || NOTES+=("dnf-automatic reboot is '$rbt' — the box may reboot itself")
    rc=0; out=""
    if command -v dnf >/dev/null 2>&1; then out=$(timeout 60 dnf -q -C check-upgrade --security 2>/dev/null </dev/null) || rc=$?; else rc=255; fi
    case "$rc" in
        0)   echo "pending_security=0" ;;
        100) echo "pending_security=$(grep -cE '^[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+' <<< "$out" || true)" ;;
        *)   echo "pending_security=unknown"; NOTES+=("pending count unavailable (no dnf cache yet, or dnf busy)") ;;
    esac
    _restart_probe
    echo "reboot_required=$REBOOT"
    echo "services_restart=$SVCS"
    echo "needrestart_policy=n/a"
    if compgen -G "$R/etc/yum.repos.d/nodesource*.repo" >/dev/null; then
        echo "nodesource_origin=not-allowed"
        NOTES+=("NodeSource publishes no security advisories, so security-only dnf never updates nodejs — update it by hand")
    else echo "nodesource_origin=n/a"; fi
    tp=$(grep -lsE 'remirepo' "$R"/etc/yum.repos.d/*.repo 2>/dev/null | xargs -r -n1 basename | paste -sd, -)
else
    echo "auto_updates=unknown"
    echo "toolkit_policy=absent"
    NOTES+=("no apt-get or dnf found — unsupported package manager")
    tp=""
fi
if [[ -n "$tp" ]]; then
    echo "php_repo=third-party:$tp"
    NOTES+=("PHP comes from a third-party repo ($tp): its fixes are not in the distro security channel and are NOT applied automatically")
elif [[ -x "$R/usr/bin/php" ]] || compgen -G "$R/usr/sbin/php-fpm*" >/dev/null; then echo "php_repo=distro"
else echo "php_repo=none"; fi
echo "lock_busy=$(_lock_busy)"
for n in "${NOTES[@]+"${NOTES[@]}"}"; do [[ -n "$n" ]] && echo "note=$n"; done
echo __OK__
HU_EOF

# -----------------------------------------------------------------------------
# enable — idempotent; re-running rewrites the same files.
#
# apt: the stock 50unattended-upgrades is never edited. apt config LISTS APPEND
# across apt.conf.d files (verified with apt-config dump on Ubuntu 24.04), so a
# higher-numbered file cannot narrow the stock Allowed-Origins by adding to it.
# Our drop-in therefore opens with apt.conf's `#clear` directive for both
# Allowed-Origins and Origins-Pattern, then lists only the security origins.
# Files are read in lexical order, so 52 runs after the stock 50 and the old
# ubuntu-advantage 51 file; anything numbered higher can still widen the list
# or flip Automatic-Reboot, which is why the EFFECTIVE config is read back
# afterwards and any mismatch FAILS the enable (the files stay for inspection).
#
# 20auto-upgrades is the package's own on/off switch (the unattended-upgrades
# postinst registers it with ucf; `dpkg-reconfigure unattended-upgrades` writes
# it). It is rewritten here, after a one-time copy into the state dir.
#
# Origins (each taken from the live Release file):
#   Ubuntu  security pocket: Origin "Ubuntu", Suite "<codename>-security";
#           ESM: Origin "UbuntuESM" Suite "<codename>-infra-security" and
#           Origin "UbuntuESMApps" Suite "<codename>-apps-security".
#   Debian 12/13: Origin "Debian", Label "Debian-Security", Codename
#           "<codename>-security" (security.debian.org bookworm-/trixie-security).
#   NodeSource (opt-in): deb.nodesource.com/node_24.x/dists/nodistro/Release
#           has Origin ". nodistro", Label ". nodistro", Codename "nodistro"
#           (verified live 2026-11-01). That Origin starts with ". " and is generated
#           by aptly, so the pattern matches on `site=` (a documented
#           unattended-upgrade key) plus codename instead.
#
# needrestart: on Ubuntu 24.04 needrestart restarts services by itself after a
# non-interactive upgrade. `l` (list only) stops a LIBRARY update from
# restarting anything; the operator restarts when ready. Configured only where
# needrestart exists — it is never installed by us.
#
# dnf: EL10 ships dnf 4 (dnf-automatic, dnf-automatic.timer); dnf 5 hosts use
# dnf5-plugin-automatic and dnf5-automatic.timer. Both read /etc/dnf/automatic.conf
# (dnf 5 layers it over /usr/share/dnf5/dnf5-plugins/automatic.conf). On dnf 4
# that file is the package's own full config, so it is backed up once before
# being replaced, and disable puts the backup back.
# -----------------------------------------------------------------------------
read -r -d '' _HU_ENABLE_BODY <<'HU_EOF' || true
mkdir -p "$ST_DIR" || { echo "ERROR: cannot create $ST_DIR"; exit 1; }
chmod 755 "$ST_DIR" 2>/dev/null
_bk_once() {
    local src="$1" key="$2" bk
    bk="$ST_DIR/${1##*/}.pre-enable"
    [[ -n "$(_st_get "$key")" ]] && return 0
    if [[ -f "$src" ]] && ! _ours "$src"; then
        if [[ ! -e "$bk" ]]; then cp -p "$src" "$bk" || { echo "ERROR: cannot back up $src"; return 1; }; fi
        _st_set "$key" yes || return 1
        echo "backed up: $src -> $bk"
    else
        _st_set "$key" no || return 1
    fi
}
FAIL=0
if [[ "$FAM" == apt ]]; then
    if ! _policy_patterns >/dev/null; then echo "ERROR: unsupported distro '${OS_ID:-unknown}' (Ubuntu and Debian only)"; exit 1; fi
    if [[ -n "$R" ]]; then
        echo "skip: package install (HU_ROOT test mode)"
    elif ! command -v unattended-upgrade >/dev/null 2>&1; then
        echo "installing unattended-upgrades (waits up to 120 s for the dpkg lock)..."
        AO=(-o DPkg::Lock::Timeout=120 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
        export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
        # Only the network steps are time-capped: killing apt-get once dpkg runs
        # would leave half-configured packages, so the install proper runs from
        # the already-downloaded archive with the lock timeout as its only wait.
        irc=0; iout=$(timeout 900 apt-get "${AO[@]}" install -y -q -d unattended-upgrades 2>&1 </dev/null) || irc=$?
        if [[ $irc -ne 0 && $irc -ne 124 ]]; then
            timeout 300 apt-get -o DPkg::Lock::Timeout=120 update -q >/dev/null 2>&1 </dev/null
            irc=0; iout=$(timeout 900 apt-get "${AO[@]}" install -y -q -d unattended-upgrades 2>&1 </dev/null) || irc=$?
        fi
        if [[ $irc -eq 124 ]]; then echo "ERROR: downloading unattended-upgrades timed out after 900 s"; exit 1; fi
        if [[ $irc -eq 0 ]]; then iout=$(apt-get "${AO[@]}" install -y -q unattended-upgrades 2>&1 </dev/null) || irc=$?; fi
        if [[ $irc -ne 0 ]]; then
            printf '%s\n' "$iout" | tail -n 15 | sed 's/^/  apt: /'
            echo "ERROR: apt-get install unattended-upgrades failed"; exit 1
        fi
        echo "installed: unattended-upgrades"
    fi
    _bk_once "$F_AUTO" had_auto || exit 1
    printf '// %s. Turn off through the toolkit (Disable).\nAPT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' "$MARK" \
        | _wr "$F_AUTO" || exit 1
    _st_set wrote_auto yes || exit 1
    echo "wrote: $F_AUTO"
    {
        echo "// $MARK. Removed by the toolkit's Disable action."
        echo "// Security origins only: #clear drops every origin listed by earlier files."
        echo "#clear Unattended-Upgrade::Allowed-Origins;"
        echo "#clear Unattended-Upgrade::Origins-Pattern;"
        echo "Unattended-Upgrade::Origins-Pattern {"
        _policy_patterns | while IFS= read -r p; do printf '    "%s";\n' "$p"; done
        echo "};"
        echo 'Unattended-Upgrade::Automatic-Reboot "false";'
    } | _wr "$F_POL" || exit 1
    _st_set nodesource "$NS" || exit 1
    echo "wrote: $F_POL (nodesource=$NS)"
    if [[ -d "$NR_DIR" ]]; then
        { echo "# $MARK. Removed by the toolkit's Disable action."
          echo "# List services that need a restart; never restart them during an upgrade."
          echo "\$nrconf{restart} = 'l';"; } | _wr "$F_NR" || exit 1
        _st_set wrote_nr yes || exit 1
        echo "wrote: $F_NR"
    else
        echo "needrestart: not installed, nothing to configure"
    fi
    if [[ -n "$R" ]]; then echo "skip: systemctl enable apt-daily timers (HU_ROOT test mode)"
    elif _systemd_up; then
        systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 </dev/null || true
    fi
    _classify_origins
    _apt_auto
    rb=$(_aptbool "$(_aptval Unattended-Upgrade::Automatic-Reboot)")
    _apt_origins | sed 's/^/effective_origin=/'
    echo "check: auto_updates=$AU security_only=$SEC_ONLY automatic_reboot=$rb timers=$T1/$T2"
    want=yes; [[ "$NS" == yes ]] && want=yes+nodesource
    if [[ "$SEC_ONLY" != "$want" ]]; then echo "ERROR: effective policy is '$SEC_ONLY', expected '$want' — a later apt.conf.d file changes it: ${NONSEC:-no security origin left}"; FAIL=1; fi
    if [[ "$rb" == true ]]; then echo "ERROR: Unattended-Upgrade::Automatic-Reboot is true after writing — a later apt.conf.d file overrides it"; FAIL=1; fi
    if [[ "$AU" != on ]]; then
        for n in "${AUTO_NOTES[@]+"${AUTO_NOTES[@]}"}"; do echo "ERROR: not scheduled: $n"; done
        [[ "$T1$T2" == *masked* ]] && echo "  (a masked timer is an operator decision: systemctl unmask apt-daily.timer apt-daily-upgrade.timer, then enable again)"
        FAIL=1
    fi
elif [[ "$FAM" == dnf ]]; then
    if [[ -n "$R" ]]; then
        echo "skip: package install (HU_ROOT test mode)"
    elif ! rpm -q "$DNF_PKG" >/dev/null 2>&1 </dev/null; then
        echo "installing $DNF_PKG..."
        # Download under a cap (dnf has no lock timeout and waits forever on a
        # busy rpm db or a dead mirror). The cache-only transaction is NOT capped:
        # killing rpm mid-transaction can leave a damaged rpm database, the same
        # reason the apt branch never caps dpkg.
        irc=0; iout=$(timeout 900 dnf install -y -q --downloadonly "$DNF_PKG" 2>&1 </dev/null) || irc=$?
        if [[ $irc -eq 124 ]]; then echo "ERROR: downloading $DNF_PKG timed out after 900 s (dnf busy, or no mirror)"; exit 1; fi
        if [[ $irc -eq 0 ]]; then iout=$(dnf install -y -q -C "$DNF_PKG" 2>&1 </dev/null) || irc=$?; fi
        if [[ $irc -ne 0 ]]; then
            printf '%s\n' "$iout" | tail -n 15 | sed 's/^/  dnf: /'
            echo "ERROR: dnf install $DNF_PKG failed"; exit 1
        fi
        echo "installed: $DNF_PKG"
    fi
    _bk_once "$F_DNF" had_dnf || exit 1
    printf '# %s. Disable through the toolkit to restore the previous file.\n[commands]\nupgrade_type = security\ndownload_updates = yes\napply_updates = yes\nreboot = never\n\n[emitters]\nemit_via = stdio\n' "$MARK" \
        | _wr "$F_DNF" || exit 1
    _st_set wrote_dnf yes || exit 1
    echo "wrote: $F_DNF"
    if [[ "$NS" == yes ]]; then echo "WARN: NodeSource opt-in is apt-only — security-only dnf skips repos without advisories"; fi
    if [[ -n "$R" ]]; then echo "skip: systemctl enable --now $DNF_TIMER (HU_ROOT test mode)"
    elif ! systemctl enable --now "$DNF_TIMER" >/dev/null 2>&1 </dev/null; then
        echo "ERROR: could not enable $DNF_TIMER (masked?)"; FAIL=1
    fi
    _dnf_auto
    ut=$(_dnf_eff upgrade_type default); ap=$(_dnf_eff apply_updates no); rbt=$(_dnf_eff reboot never)
    echo "check: auto_updates=$AU upgrade_type=$ut apply_updates=$ap reboot=$rbt timer=$(_unit "$DNF_TIMER")"
    [[ "$ut" == security ]] || { echo "ERROR: upgrade_type reads back as '$ut'"; FAIL=1; }
    [[ "$rbt" == never ]] || { echo "ERROR: reboot reads back as '$rbt' — the box could reboot itself"; FAIL=1; }
    [[ "$AU" == on ]] || { echo "ERROR: dnf-automatic is not scheduled to apply updates"; FAIL=1; }
else
    echo "ERROR: no apt-get or dnf found"; exit 1
fi
if (( FAIL )); then echo "ERROR: enable did not reach the intended state — files left in place; fix the cause, then enable or disable"; exit 1; fi
echo __OK__
HU_EOF

# -----------------------------------------------------------------------------
# disable — "off" means off: the apt schedule is written back as "0" and the
# dnf timers are disabled, even when the host had them on before enable (the
# pre-enable copies are kept in the state dir for anyone who wants them back).
# A file is changed only while it still carries the toolkit marker — one the
# operator has edited since is left alone with a WARN. Packages stay installed.
# The last thing printed is the REAL resulting state, read back.
# -----------------------------------------------------------------------------
read -r -d '' _HU_DISABLE_BODY <<'HU_EOF' || true
if [[ "$FAM" == apt ]]; then
    if _ours "$F_POL"; then rm -f "$F_POL" || { echo "ERROR: cannot remove $F_POL"; exit 1; }; echo "removed: $F_POL"
    elif [[ -e "$F_POL" ]]; then echo "WARN: $F_POL has no toolkit marker — left in place"
    else echo "absent: $F_POL"; fi
    if _ours "$F_AUTO"; then
        printf '// %s. Automatic updates turned off by the toolkit.\nAPT::Periodic::Update-Package-Lists "0";\nAPT::Periodic::Unattended-Upgrade "0";\n' "$MARK" \
            | _wr "$F_AUTO" || exit 1
        echo "wrote: $F_AUTO (schedule off)"
    elif [[ -e "$F_AUTO" ]]; then
        echo "WARN: $F_AUTO has no toolkit marker (not written by us, or edited since) — left as is"
    fi
    if _ours "$F_NR"; then rm -f "$F_NR" || { echo "ERROR: cannot remove $F_NR"; exit 1; }; echo "removed: $F_NR"; fi
    _apt_auto
elif [[ "$FAM" == dnf ]]; then
    tmrs=("$DNF_TIMER"); [[ "$DNFV" == 4 ]] && tmrs+=(dnf-automatic-install.timer)
    for t in "${tmrs[@]}"; do
        if [[ -n "$R" ]]; then echo "skip: systemctl disable --now $t (HU_ROOT test mode)"
        elif _unit_on "$(_unit "$t")"; then
            if systemctl disable --now "$t" >/dev/null 2>&1 </dev/null; then echo "disabled: $t"; else echo "WARN: could not disable $t"; fi
        fi
    done
    bk="$ST_DIR/automatic.conf.pre-enable"
    if [[ -e "$F_DNF" ]] && ! _ours "$F_DNF"; then
        echo "WARN: $F_DNF has no toolkit marker (not written by us, or edited since) — left as is"
    elif [[ -f "$bk" ]]; then
        if ! { cp -p "$bk" "$F_DNF.hu$$.bak" && mv -f "$F_DNF.hu$$.bak" "$F_DNF"; }; then
            rm -f "$F_DNF.hu$$.bak"; echo "ERROR: cannot restore $F_DNF"; exit 1
        fi
        echo "restored: $F_DNF from $bk"
    elif [[ -e "$F_DNF" ]]; then
        rm -f "$F_DNF" || { echo "ERROR: cannot remove $F_DNF"; exit 1; }
        echo "removed: $F_DNF"
    fi
    _dnf_auto
else
    echo "ERROR: no apt-get or dnf found"; exit 1
fi
if [[ -f "$ST" ]]; then rm -f "$ST" || { echo "ERROR: cannot remove $ST"; exit 1; }; fi
compgen -G "$ST_DIR/*.pre-enable" >/dev/null && echo "kept: pre-enable copies in $ST_DIR"
echo "auto_updates=$AU"
if [[ "$AU" == on ]]; then echo "WARN: automatic updates are STILL ON through configuration the toolkit did not write"; fi
echo __OK__
HU_EOF

# -----------------------------------------------------------------------------
# run-now — one security-only pass. On apt it runs unattended-upgrade, which
# applies the policy above; it refuses unless the toolkit drop-in is present AND
# the effective config reads back security-only with Automatic-Reboot off
# (without our file it would apply the stock, wider policy — on Debian that
# includes point-release updates). NEEDRESTART_MODE=l keeps needrestart from
# restarting services even where our drop-in is absent. SIGINT and SIGHUP are
# ignored around the package run (inherited by dpkg/rpm), because a Ctrl-C
# mid-dpkg leaves half-configured packages.
# -----------------------------------------------------------------------------
read -r -d '' _HU_RUNNOW_BODY <<'HU_EOF' || true
export NEEDRESTART_MODE=l DEBIAN_FRONTEND=noninteractive
if [[ "$FAM" == apt ]]; then
    _ours "$F_POL" || { echo "ERROR: toolkit security policy not installed — run enable first"; exit 1; }
    command -v unattended-upgrade >/dev/null 2>&1 || { echo "ERROR: unattended-upgrade not installed — run enable first"; exit 1; }
    _classify_origins
    rb=$(_aptbool "$(_aptval Unattended-Upgrade::Automatic-Reboot)")
    case "$SEC_ONLY" in yes|yes+nodesource) ;; *) echo "ERROR: effective policy is not security-only (${NONSEC:-$SEC_ONLY}) — refusing"; exit 1 ;; esac
    [[ "$rb" == true ]] && { echo "ERROR: Unattended-Upgrade::Automatic-Reboot is true — refusing"; exit 1; }
elif [[ "$FAM" != dnf ]]; then
    echo "ERROR: no apt-get or dnf found"; exit 1
fi
if [[ -n "$R" ]]; then echo "skip: patch run (HU_ROOT test mode) — policy checks passed"; echo __OK__; exit 0; fi
w=0
while [[ "$(_lock_busy)" == yes && $w -lt 120 ]]; do
    (( w == 0 )) && echo "package manager busy — waiting up to 120 s..."
    sleep 5; w=$((w+5))
done
echo "Installing security updates — do not interrupt (Ctrl-C is ignored until it finishes)."
rc=0
trap '' INT HUP
if [[ "$FAM" == apt ]]; then
    apt-get -o DPkg::Lock::Timeout=120 update -q >/dev/null 2>&1 </dev/null || echo "WARN: apt-get update failed — using cached package lists"
    unattended-upgrade -v </dev/null 2>&1 || rc=$?
else
    dnf upgrade --security -y </dev/null 2>&1 || rc=$?
fi
trap - INT HUP
_restart_probe
echo "reboot_required=$REBOOT"
echo "services_restart=$SVCS"
[[ "$rc" -eq 0 ]] || { echo "ERROR: patch run exited $rc"; exit 1; }
echo __OK__
HU_EOF

# -----------------------------------------------------------------------------
# hu_script <action> [nodesource=yes|no] — print the complete runnable script.
# The env lines go FIRST so the prelude sees them. HU_TEST/HU_ROOT are always
# emitted, blank unless the caller is in test mode, so a value exported in the
# remote root's environment can never leak in.
# enable and disable open with `trap '' HUP PIPE`: 083 and 081 both run over
# SSH, and a dropped session must not stop the script between two writes (an
# ignored PIPE also keeps a dead reader from killing it). Package output inside
# them is captured into variables, never streamed to the session.
# -----------------------------------------------------------------------------
hu_script() {
    local action="${1:-}" opt="${2:-}" ns=no body
    case "$opt" in
        "")             ;;
        nodesource=yes) ns=yes ;;
        nodesource=no)  ns=no ;;
        *) echo "hu_script: bad option '$opt'" >&2; return 2 ;;
    esac
    case "$action" in
        status)  body="$_HU_STATUS_BODY" ;;
        enable)  body="$_HU_ENABLE_BODY" ;;
        disable) body="$_HU_DISABLE_BODY" ;;
        run-now) body="$_HU_RUNNOW_BODY" ;;
        *) echo "hu_script: unknown action '$action'" >&2; return 2 ;;
    esac
    case "$action" in enable|disable) printf "trap '' HUP PIPE\n" ;; esac
    printf 'HU_NODESOURCE=%s\n' "$ns"
    if [[ "${HU_TEST:-}" == 1 && -n "${HU_ROOT:-}" ]]; then
        printf 'HU_TEST=1\nHU_ROOT=%q\n' "$HU_ROOT"
        [[ -n "${HU_FAMILY:-}" ]] && printf 'HU_FAMILY=%q\n' "$HU_FAMILY"
        [[ -n "${HU_DNF_VERSION:-}" ]] && printf 'HU_DNF_VERSION=%q\n' "$HU_DNF_VERSION"
    else
        printf "HU_TEST=''\nHU_ROOT=''\n"
    fi
    printf '%s\n%s\n' "$_HU_PRELUDE" "$body"
}

# -----------------------------------------------------------------------------
# Detached patch runs — shared by 083 (local, key 9 → 4) and 081 (remote, Mass
# Deployment key 5 → 4).
#
# A patch run must never depend on the session that started it: over SSH a
# dropped connection HUPs the foreground job and closes the pipe under
# dpkg/rpm (dnf's Python print raises BrokenPipeError mid-transaction). So
# run-now is never streamed. hu_launch_script wraps the run-now snippet in a
# launcher that writes it to a root-only file and starts it under
# `systemd-run --collect` (or `setsid nohup` without systemd), logging to
# $HU_LOG_DIR/run-now_<UTC YYYYmmdd_HHMMSS>.log. The exit code lands in
# run-now/rc_<id> only after the snippet returns, so its presence means
# "finished"; run-now/current records the newest run. Callers then only READ:
# hu_poll_script reports state + log tail, so Ctrl-C or a dropped session stops
# the watching, never the run.
#
# Reply lines (`HUR|key|…`, then __OK__):
#   launch  HUR|started|<id>|<log>|<systemd-run|setsid>   or HUR|busy|<id>|<log> + ERROR
#   poll    HUR|state|none|running|done|vanished|other, HUR|id|, HUR|log|, HUR|how|,
#           HUR|rc| (done), HUR|lines|, HUR|last| (last non-blank log line),
#           HUR|kv|reboot_required=… / services_restart=…, HUR|tail|<line> × TAIL
# A run is OK only when state=done, rc=0 and last=__OK__. `vanished` = neither
# a live unit/pid nor an exit code (killed, or the host rebooted under it).
# -----------------------------------------------------------------------------
HU_RUN_DIR=/var/lib/grin-toolkit/host-updates/run-now
HU_LOG_DIR=/var/log/grin-host-updates

read -r -d '' _HU_DET_COMMON <<'HU_EOF' || true
set -u
export LC_ALL=C
CUR="$RUN_DIR/current"
_cur() { if [[ -r "$CUR" ]]; then sed -n "s/^$1=//p" "$CUR" | tail -1; fi; return 0; }
_running() {
    [[ -r "$CUR" ]] || return 1
    local rcf u p
    rcf=$(_cur rcf); u=$(_cur unit); p=$(_cur pid)
    if [[ -n "$rcf" && -e "$rcf" ]]; then return 1; fi
    if [[ -n "$u" ]] && systemctl is-active --quiet "$u" 2>/dev/null </dev/null; then return 0; fi
    if [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null \
        && tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -qF "$RUN_DIR/run-now.sh"; then return 0; fi
    return 1
}
HU_EOF

# The launcher refuses while the previous run is still going (two package runs
# would only queue on the lock, and the record would lose the first), and holds
# a flock on run-now/.lock from that check until the record is written, so two
# controllers starting at once cannot both pass it. The snippet is written to a
# temp name and moved into place, so a running bash keeps reading its own copy.
# Parent dirs are made under umask 022 first: /var/lib/grin-toolkit and
# host-updates/ are shared with enable's state and stay 755; only run-now/ is 700.
read -r -d '' _HU_DET_LAUNCH <<'HU_EOF' || true
for d in "$(dirname "$RUN_DIR")" "$(dirname "$LOG_DIR")"; do
    if [[ ! -d "$d" ]]; then
        if ! { (umask 022; mkdir -p "$d") && chmod 755 "$d"; }; then echo "ERROR: cannot create $d"; exit 1; fi
    fi
done
umask 077
if ! { mkdir -p "$RUN_DIR" && chmod 700 "$RUN_DIR"; }; then echo "ERROR: cannot create $RUN_DIR"; exit 1; fi
if ! { mkdir -p "$LOG_DIR" && chmod 750 "$LOG_DIR"; }; then echo "ERROR: cannot create $LOG_DIR"; exit 1; fi
if command -v flock >/dev/null 2>&1; then
    exec 9>"$RUN_DIR/.lock" || { echo "ERROR: cannot open $RUN_DIR/.lock"; exit 1; }
    if ! flock -n 9; then
        echo "HUR|busy|(starting)|"
        echo "ERROR: another start of a patch run is in progress on this host"
        exit 1
    fi
else
    echo "WARN: flock not found — the busy check is not locked"
fi
if _running; then
    echo "HUR|busy|$(_cur id)|$(_cur log)"
    echo "ERROR: the patch run started $(_cur id) UTC is still running — log $(_cur log)"
    exit 1
fi
command -v base64 >/dev/null 2>&1 || { echo "ERROR: base64 not found"; exit 1; }
ID=$(date -u +%Y%m%d_%H%M%S)
S="$RUN_DIR/run-now.sh"; LOG="$LOG_DIR/run-now_$ID.log"; RCF="$RUN_DIR/rc_$ID"
if [[ -e "$LOG" ]]; then echo "ERROR: $LOG already exists — try again in a second"; exit 1; fi
if ! { printf '%s' "$B64" | base64 -d > "$S.tmp" && chmod 700 "$S.tmp" && mv -f "$S.tmp" "$S"; }; then
    rm -f "$S.tmp"; echo "ERROR: cannot write $S"; exit 1
fi
: > "$LOG" || { echo "ERROR: cannot create $LOG"; exit 1; }
rm -f "$RUN_DIR"/rc_* 2>/dev/null
# The wrapper is a FILE, not a `bash -c` string: systemd expands `$` in a
# unit's command line. $1 script, $2 log, $3 exit-code file.
WR="$RUN_DIR/wrap.sh"
if ! { printf '%s\n' 'bash "$1" </dev/null >>"$2" 2>&1' 'echo "$?" > "$3.tmp" && mv -f "$3.tmp" "$3"' > "$WR.tmp" \
        && chmod 700 "$WR.tmp" && mv -f "$WR.tmp" "$WR"; }; then
    rm -f "$WR.tmp"; echo "ERROR: cannot write $WR"; exit 1
fi
# Both paths start the run with SIGPIPE at its default, so `cmd | head` inside
# it behaves normally: systemd ignores SIGPIPE in a service unless told not to
# (IgnoreSIGPIPE=yes is its default), and this launcher's own PIPE trap would be
# inherited across exec, so the setsid subshell resets it first. fd 9 (the
# lock) is closed in the child so the run does not hold it.
UNIT=""; PID=""; HOW=""
if [[ -d /run/systemd/system ]] && command -v systemd-run >/dev/null 2>&1; then
    UNIT="grin-hu-runnow-${ID/_/-}"
    if systemd-run --unit="$UNIT" --collect --quiet --no-ask-password -p IgnoreSIGPIPE=no \
            --description="Grin Node Toolkit security patch run" \
            /bin/bash "$WR" "$S" "$LOG" "$RCF" </dev/null >/dev/null 2>"$RUN_DIR/launch.err" 9>&-; then
        HOW=systemd-run
    else
        echo "WARN: systemd-run failed ($(head -1 "$RUN_DIR/launch.err" 2>/dev/null)) — using setsid"
        UNIT=""
    fi
fi
if [[ -z "$UNIT" ]]; then
    ( trap - HUP PIPE; exec setsid nohup /bin/bash "$WR" "$S" "$LOG" "$RCF" </dev/null >/dev/null 2>&1 9>&- ) &
    PID=$!; HOW=setsid
fi
if ! { printf 'id=%s\nlog=%s\nrcf=%s\nunit=%s\npid=%s\nhow=%s\n' "$ID" "$LOG" "$RCF" "$UNIT" "$PID" "$HOW" > "$CUR.tmp" \
        && mv -f "$CUR.tmp" "$CUR"; }; then
    echo "ERROR: patch run STARTED ($HOW${UNIT:+ unit $UNIT}${PID:+ pid $PID}, log $LOG) but its record could not be written"
    exit 1
fi
echo "HUR|started|$ID|$LOG|$HOW"
echo __OK__
HU_EOF

read -r -d '' _HU_DET_POLL <<'HU_EOF' || true
if [[ ! -r "$CUR" ]]; then echo "HUR|state|none"; echo __OK__; exit 0; fi
id=$(_cur id); log=$(_cur log); rcf=$(_cur rcf)
echo "HUR|id|$id"; echo "HUR|log|$log"; echo "HUR|how|$(_cur how)"
if [[ -n "$WANT_ID" && "$id" != "$WANT_ID" ]]; then echo "HUR|state|other"; echo __OK__; exit 0; fi
if [[ -n "$rcf" && -r "$rcf" ]]; then echo "HUR|state|done"; echo "HUR|rc|$(head -1 "$rcf")"
elif _running; then echo "HUR|state|running"
else echo "HUR|state|vanished"; fi
if [[ -r "$log" ]]; then
    echo "HUR|lines|$(wc -l < "$log")"
    echo "HUR|last|$(grep -v '^[[:space:]]*$' "$log" | tail -1)"
    grep -E '^(reboot_required|services_restart)=' "$log" | tail -2 | sed 's/^/HUR|kv|/'
    if (( TAIL > 0 )); then tail -n "$TAIL" "$log" | sed 's/^/HUR|tail|/'; fi
else
    echo "HUR|nolog|1"
fi
echo __OK__
HU_EOF

# Run/log dirs, under HU_ROOT in test mode (the same rule as the snippets).
_hu_run_dirs() {
    _HU_RD="$HU_RUN_DIR"; _HU_LD="$HU_LOG_DIR"
    if [[ "${HU_TEST:-}" == 1 && -n "${HU_ROOT:-}" ]]; then
        _HU_RD="${HU_ROOT%/}$HU_RUN_DIR"; _HU_LD="${HU_ROOT%/}$HU_LOG_DIR"
    fi
}

# hu_launch_script <run-now script text> — the complete launcher.
hu_launch_script() {
    local b64
    _hu_run_dirs
    b64=$(printf '%s\n' "$1" | base64 -w0) || { echo "hu_launch_script: base64 failed" >&2; return 1; }
    printf "trap '' HUP PIPE\nRUN_DIR=%q\nLOG_DIR=%q\nB64=%q\n" "$_HU_RD" "$_HU_LD" "$b64"
    printf '%s\n%s\n' "$_HU_DET_COMMON" "$_HU_DET_LAUNCH"
}

# hu_poll_script <run id, or "" for the newest> <log lines to return>
hu_poll_script() {
    _hu_run_dirs
    printf 'RUN_DIR=%q\nWANT_ID=%q\nTAIL=%q\n' "$_HU_RD" "$1" "$2"
    printf '%s\n%s\n' "$_HU_DET_COMMON" "$_HU_DET_POLL"
}

# _hu_clean — strip C0 controls (except tab and newline) and DEL from text that
# came from a script's output, so a remote or log line cannot drive the
# terminal. Print the result only as a printf %s argument, never via echo -e.
_hu_clean() { LC_ALL=C tr -d '\000-\010\013-\037\177'; }

# _hu_val <reply> <key> — first value of a HUR|key| line.
_hu_val() { printf '%s\n' "$1" | sed -n "s/^HUR|$2|//p" | head -1; }

# -----------------------------------------------------------------------------
# Local wrappers (083, and reusable by 081). Colours default to empty and the
# log falls back to /dev/null, so these run under `set -u` in any caller.
# -----------------------------------------------------------------------------
_hu_test_warn() {
    if [[ -n "${HU_ROOT:-}" ]]; then
        if [[ "${HU_TEST:-}" == 1 ]]; then warn "TEST MODE: HU_ROOT=$HU_ROOT — acting on that scratch tree, not this system."
        else warn "HU_ROOT is set in this shell's environment without HU_TEST=1 — it is ignored."; fi
    fi
    return 0
}

# hu_run <action> [nodesource=…] — run enable/disable locally, streaming the
# output and copying it into LOG_FILE. rc 0 only if the script exited 0 AND its
# last line is __OK__ — a script killed halfway must never read as success.
# 083 runs over SSH, so the pipeline must outlive the session: INT and HUP are
# ignored for all of it (inherited by every stage), the snippet itself ignores
# HUP and PIPE (hu_script), and tee keeps writing the log copy after its
# terminal-side reader is gone (--output-error=warn-nopipe). Package output
# inside enable is captured, never streamed. The patch run is not done here at
# all — it is detached (hu_action_run_now).
hu_run() {
    local script tmp rc last
    _hu_test_warn
    script=$(hu_script "$@") || return 2
    tmp=$(mktemp) || { error "mktemp failed"; return 1; }
    trap '' INT HUP
    bash -s <<< "$script" 2>&1 | tee --output-error=warn-nopipe "$tmp" | grep --line-buffered -v '^__OK__$' \
        | LC_ALL=C sed -u -e 's/[\x01-\x08\x0b-\x1f\x7f]//g' -e 's/^/    /'
    rc=${PIPESTATUS[0]}
    trap - INT HUP
    last=$(tail -1 "$tmp" 2>/dev/null || true)
    { echo "[hu] $* rc=$rc"; sed 's/^/[hu]   /' "$tmp"; } >> "${LOG_FILE:-/dev/null}" 2>/dev/null || true
    rm -f "$tmp" 2>/dev/null || true
    if [[ $rc -eq 0 && "$last" == "__OK__" ]]; then return 0; fi
    return 1
}

# hu_status_load — run the status script and fill HU_ST[key]=value plus the
# HU_NOTES array. rc 1 when the script did not finish; its output and stderr
# then go to LOG_FILE.
declare -gA HU_ST=()
HU_NOTES=()
hu_status_load() {
    local out line k v err rc=0
    HU_ST=(); HU_NOTES=()
    _hu_test_warn
    err=$(mktemp) || { error "mktemp failed"; return 1; }
    out=$(hu_script status | bash -s 2>"$err") || rc=$?
    out=$(_hu_clean <<< "$out")
    if [[ "$(printf '%s\n' "$out" | tail -1)" != "__OK__" ]]; then
        { echo "[hu] status failed rc=$rc"; printf '%s\n' "$out" | sed 's/^/[hu]   /'; sed 's/^/[hu] stderr: /' "$err"; } \
            >> "${LOG_FILE:-/dev/null}" 2>/dev/null || true
        rm -f "$err" 2>/dev/null || true
        return 1
    fi
    rm -f "$err" 2>/dev/null || true
    while IFS= read -r line; do
        [[ "$line" == *=* ]] || continue
        k="${line%%=*}"; v="${line#*=}"
        if [[ "$k" == note ]]; then HU_NOTES+=("$v"); else HU_ST["$k"]="$v"; fi
    done <<< "$out"
    return 0
}

_hu_row() {   # <label> <value> <good-values regex> — green when healthy
    local c="${YELLOW:-}"
    [[ "$2" =~ ^($3)$ ]] && c="${GREEN:-}"
    [[ "$2" == unknown ]] && c="${DIM:-}"
    printf "  %-24s ${c}%s${RESET:-}\n" "$1" "$2"
}

hu_render_status() {
    if ! hu_status_load; then
        error "The status check did not complete — details in ${LOG_FILE:-the session log}."
        return 1
    fi
    printf '  %b%s · package manager %s%b\n' "${DIM:-}" "${HU_ST[distro]:-unknown}" "${HU_ST[family]:-unknown}" "${RESET:-}"
    echo ""
    _hu_row "Automatic updates"     "${HU_ST[auto_updates]:-unknown}"       'on'
    _hu_row "Toolkit policy"        "${HU_ST[toolkit_policy]:-unknown}"     'present'
    _hu_row "Security-only"         "${HU_ST[security_only]:-unknown}"      'yes'
    _hu_row "Pending security"      "${HU_ST[pending_security]:-unknown}"   '0'
    _hu_row "Reboot required"       "${HU_ST[reboot_required]:-unknown}"    'no'
    _hu_row "Services to restart"   "${HU_ST[services_restart]:-unknown}"   'none'
    _hu_row "needrestart list-only" "${HU_ST[needrestart_policy]:-unknown}" 'present|n/a'
    _hu_row "NodeSource origin"     "${HU_ST[nodesource_origin]:-unknown}"  'not-allowed|n/a'
    _hu_row "PHP packages from"     "${HU_ST[php_repo]:-unknown}"           'distro|none'
    _hu_row "Package lock busy"     "${HU_ST[lock_busy]:-unknown}"          'no'
    local n
    if (( ${#HU_NOTES[@]} > 0 )); then
        echo ""
        for n in "${HU_NOTES[@]}"; do printf '  %b·%b %s\n' "${YELLOW:-}" "${RESET:-}" "$n"; done
    fi
    return 0
}

_hu_confirm() {   # <question> — rc 0 only on an explicit y
    local a
    echo -ne "  ${BOLD:-}$1 [y/N]: ${RESET:-}"
    read -r a || return 1
    [[ "${a,,}" == y || "${a,,}" == yes ]]
}

_hu_banner() {
    clear
    echo -e "${BOLD:-}${CYAN:-}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET:-}"
    echo -e "${BOLD:-}${CYAN:-} Automatic Security Updates${RESET:-}"
    echo -e "${BOLD:-}${CYAN:-}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET:-}"
}

_hu_pause() { echo ""; echo "Press Enter to return to the Automatic Security Updates menu..."; read -r || true; }

# The restart caveat, worded once for every screen that needs it.
_hu_restart_note() {
    echo -e "  It never reboots. Library updates never restart services (needrestart is"
    echo -e "  set to list-only), but a patched daemon package — nginx, tor, php-fpm,"
    echo -e "  openssh — may restart its own service. The grin node and pool are not"
    echo -e "  packages; updates never touch them."
}

hu_action_enable() {
    _hu_banner
    echo ""
    echo -e "  Installs the OS security-update service and limits it to the distro's"
    echo -e "  ${BOLD:-}security channel${RESET:-}. The stock unattended-upgrades policy file is not"
    echo -e "  edited. Disable turns the schedule off and removes the toolkit's files, so a"
    echo -e "  host that had updates on before Enable ends with them off."
    _hu_restart_note
    local ns=no
    echo ""
    if command -v apt-get >/dev/null 2>&1; then
        echo -e "  ${BOLD:-}NodeSource (Node.js) updates${RESET:-}"
        echo -e "  ${DIM:-}NodeSource publishes every Node.js 24.x release — new features and fixes,${RESET:-}"
        echo -e "  ${DIM:-}not security fixes only — so allowing it lets an unattended run move the${RESET:-}"
        echo -e "  ${DIM:-}Node.js runtime under the pool and web apps.${RESET:-}"
        if _hu_confirm "Also apply NodeSource updates automatically?"; then ns=yes; fi
        echo ""
    fi
    _hu_confirm "Enable automatic security updates now (NodeSource: $ns)?" \
        || { info "Cancelled — nothing was changed."; _hu_pause; return 0; }
    log "[hu] enable requested nodesource=$ns"
    echo ""
    if hu_run enable "nodesource=$ns"; then
        success "Automatic security updates enabled."
    else
        error "Enable did not complete — see the output above and ${LOG_FILE:-the session log}."
    fi
    _hu_pause
}

hu_action_disable() {
    _hu_banner
    echo ""
    echo -e "  Turns automatic updates OFF and removes the toolkit's policy files. Packages"
    echo -e "  stay installed; copies of any file replaced at enable stay in"
    echo -e "  /var/lib/grin-toolkit/host-updates/."
    echo ""
    _hu_confirm "Disable automatic security updates?" \
        || { info "Cancelled — nothing was changed."; _hu_pause; return 0; }
    log "[hu] disable requested"
    echo ""
    if hu_run disable; then success "Disable finished — the last line above is the resulting state."
    else error "Disable did not complete — see the output above and ${LOG_FILE:-the session log}."; fi
    _hu_pause
}

# _hu_print_lines <prefix> — print stdin line by line as data (%s), never as a
# format or an echo -e argument.
_hu_print_lines() { local l; while IFS= read -r l; do printf '%s%s\n' "$1" "$l"; done; }

# _hu_run_result <poll reply> — rc 0 OK, 1 failed/vanished, 3 still running.
_hu_run_result() {
    case "$(_hu_val "$1" state)" in
        done) if [[ "$(_hu_val "$1" rc)" == 0 && "$(_hu_val "$1" last)" == __OK__ ]]; then return 0; fi; return 1 ;;
        running) return 3 ;;
    esac
    return 1
}

# hu_follow_run <id> <log> — print the log as it grows until the run ends or
# HU_WATCH_MAX s (default 1800) pass. Ctrl-C or a dropped SSH session (HUP)
# ends the FOLLOWING only. Returns _hu_run_result's code, 3 when stopped early.
hu_follow_run() {
    local id="$1" lg="$2" n=0 total out st t0=$SECONDS max="${HU_WATCH_MAX:-1800}"
    [[ "$max" =~ ^[0-9]+$ ]] || max=1800
    _HU_STOP=0
    trap '_HU_STOP=1' INT HUP
    info "Following $lg — Ctrl-C (or a dropped SSH session) stops FOLLOWING only; the run continues."
    while :; do
        out=$(hu_poll_script "$id" 0 | bash -s 2>/dev/null | _hu_clean)
        st=$(_hu_val "$out" state)
        if [[ -r "$lg" ]]; then
            total=$(wc -l < "$lg" 2>/dev/null || echo 0)
            if [[ "$total" =~ ^[0-9]+$ ]] && (( total > n )); then
                sed -n "$((n+1)),${total}p" "$lg" | _hu_clean | grep -v '^__OK__$' | _hu_print_lines "    "
                n=$total
            fi
        fi
        case "$st" in done|vanished|other|none) break ;; esac
        (( _HU_STOP )) && break
        if (( SECONDS - t0 >= max )); then warn "Stopped following after ${max}s — the run is still going."; break; fi
        sleep 2
        (( _HU_STOP )) && break
    done
    trap - INT HUP
    _HU_LAST_POLL="$out"
    if (( _HU_STOP )); then echo ""; warn "Stopped following. The patch run continues in the background."; return 3; fi
    _hu_run_result "$out"
}

hu_action_run_now() {
    _hu_banner
    echo ""
    echo -e "  Applies pending SECURITY updates once, now. Can take minutes; the result"
    echo -e "  says whether a reboot or service restart is needed."
    echo -e "  The run is started ${BOLD:-}detached${RESET:-} and logs to $HU_LOG_DIR/, so a dropped"
    echo -e "  SSH session cannot interrupt the package manager; this screen only follows it."
    _hu_restart_note
    echo ""
    _hu_confirm "Run a security patch now?" \
        || { info "Cancelled — nothing was changed."; _hu_pause; return 0; }
    log "[hu] run-now requested"
    _hu_test_warn
    local script launch out rc=0 id="" lg="" how=""
    script=$(hu_script run-now) || { _hu_pause; return 0; }
    launch=$(hu_launch_script "$script") || { error "Could not build the launcher."; _hu_pause; return 0; }
    out=$(bash -s <<< "$launch" 2>&1) || rc=$?
    out=$(_hu_clean <<< "$out")
    { echo "[hu] run-now launch rc=$rc"; printf '%s\n' "$out" | sed 's/^/[hu]   /'; } >> "${LOG_FILE:-/dev/null}" 2>/dev/null || true
    printf '%s\n' "$out" | grep '^WARN:' | _hu_print_lines "    "
    echo ""
    if [[ $rc -eq 0 && "$(printf '%s\n' "$out" | tail -1)" == __OK__ ]]; then
        IFS='|' read -r id lg how <<< "$(_hu_val "$out" started)"
        info "Started run $id UTC ($how)."
    elif [[ -n "$(_hu_val "$out" busy)" ]]; then
        IFS='|' read -r id lg <<< "$(_hu_val "$out" busy)"
        if [[ ! "$id" =~ ^[0-9]{8}_[0-9]{6}$ ]]; then error "Another start is in progress — try again shortly."; _hu_pause; return 0; fi
        warn "A patch run started $id UTC is still going — following it instead of starting another."
    else
        printf '%s\n' "$out" | grep -v '^WARN:' | _hu_print_lines "    "
        error "The patch run could not be started."; _hu_pause; return 0
    fi
    rc=0; hu_follow_run "$id" "$lg" || rc=$?
    log "[hu] run-now $id result rc=$rc"
    case "$rc" in
        0) success "Security patch run finished. Nothing was rebooted." ;;
        3) info "Still running. See Last patch run (key 5) for the result." ;;
        *) error "Patch run did not complete (exit $(_hu_val "$_HU_LAST_POLL" rc)) — log: $lg" ;;
    esac
    _hu_pause
}

# Last patch run — read-only view of the newest detached run on this host.
hu_action_last_run() {
    _hu_banner
    echo ""
    local out st rc=0
    out=$(hu_poll_script "" 20 | bash -s 2>/dev/null | _hu_clean)
    st=$(_hu_val "$out" state)
    if [[ "$(printf '%s\n' "$out" | tail -1)" != __OK__ ]]; then error "Could not read the run record."; _hu_pause; return 0; fi
    if [[ "$st" == none ]]; then info "No patch run has been started on this host from the toolkit."; _hu_pause; return 0; fi
    printf '  Run %s UTC (%s)\n  Log %s\n\n' "$(_hu_val "$out" id)" "$(_hu_val "$out" how)" "$(_hu_val "$out" log)"
    _hu_run_result "$out" || rc=$?
    case "$rc" in
        0) success "Finished OK." ;;
        3) info "Still running." ;;
        *) if [[ "$st" == vanished ]]; then error "Ended without an exit code (killed, or the host rebooted under it)."
           else error "Failed (exit $(_hu_val "$out" rc))."; fi ;;
    esac
    printf '%s\n' "$out" | sed -n 's/^HUR|kv|//p' | _hu_print_lines "    "
    echo ""
    printf '%s\n' "$out" | sed -n 's/^HUR|tail|//p' | _hu_print_lines "    | "
    _hu_pause
}

hu_action_status() {
    _hu_banner
    echo ""
    info "Reading update status (read-only)..."
    echo ""
    hu_render_status || true
    _hu_pause
}

# hu_menu — the sub-menu 083 opens from its key 9.
hu_menu() {
    local choice
    while true; do
        _hu_banner
        echo ""
        echo -e "  ${DIM:-}Security-channel patches only · never reboots · node and pool untouched.${RESET:-}"
        echo ""
        echo -e "  ${GREEN:-}1${RESET:-})   Show status               ${DIM:-}read-only${RESET:-}"
        echo -e "  ${YELLOW:-}2${RESET:-})   Enable                    ${DIM:-}asks first; NodeSource is opt-in${RESET:-}"
        echo -e "  ${YELLOW:-}3${RESET:-})   Disable                   ${DIM:-}asks first; removes toolkit files only${RESET:-}"
        echo -e "  ${YELLOW:-}4${RESET:-})   Run security patch now    ${DIM:-}asks first; detached, no reboot${RESET:-}"
        echo -e "  ${GREEN:-}5${RESET:-})   Last patch run            ${DIM:-}read-only; result and log tail${RESET:-}"
        echo ""
        echo -e "  ${DIM:-}0${RESET:-})   Back to Host Optimization"
        echo -e "${DIM:-}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET:-}"
        echo -ne "${BOLD:-}Select [0-5]: ${RESET:-}"
        read -r choice || return 0
        case "$choice" in
            1) hu_action_status   || true ;;
            2) hu_action_enable   || true ;;
            3) hu_action_disable  || true ;;
            4) hu_action_run_now  || true ;;
            5) hu_action_last_run || true ;;
            0) return 0 ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}
