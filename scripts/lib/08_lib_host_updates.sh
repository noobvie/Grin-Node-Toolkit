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
#   disable removes ONLY toolkit-owned files, turns the schedule off, never
#           purges a package. Pre-enable copies stay in /opt/grin/host-updates/.
#   run-now one security-only patch pass. Never reboots, never restarts services.
#
# Inputs are ENVIRONMENT lines prepended by hu_script, not argv, so the same
# text works through `bash -s` with or without an ssh hop:
#   HU_NODESOURCE=yes|no   enable only: also allow deb.nodesource.com (apt)
#   HU_ROOT=/abs/path      TEST ONLY — see "HU_ROOT" below
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

# Keys the status snippet prints, in display order. A caller over SSH parses the
# same lines, so renaming a key is an interface change for 081.
HU_STATUS_KEYS=(family distro auto_updates toolkit_policy security_only
    pending_security reboot_required services_restart needrestart_policy
    nodesource_origin php_repo lock_busy)

# -----------------------------------------------------------------------------
# Shared prelude, concatenated in front of every snippet body so each runnable
# script is complete on its own.
#
# HU_ROOT: a path prefix applied to every /etc, /var and /opt path a snippet
# reads or writes, so enable/disable can be exercised against a scratch tree on
# a dev box without touching its real config. When it is set: package installs,
# systemctl and the patch run are SKIPPED (printed as `skip:`), the root check
# is waived, and apt-config is pointed at the scratch tree through APT_CONFIG.
# Live read-only probes (apt-get -s, needrestart, fuser) still read the real
# host. HU_FAMILY / HU_DNF_VERSION override detection only in that mode, so the
# dnf file layout can be tested on an apt box. Never set HU_ROOT in production.
#
# Temp files carry a `.bak` suffix: apt reads every file in apt.conf.d without
# an extension, but silently ignores `*.bak` (Dir::Ignore-Files-Silently), so a
# half-written temp can never be parsed as config.
# -----------------------------------------------------------------------------
read -r -d '' _HU_PRELUDE <<'HU_EOF' || true
set -u
export LC_ALL=C
R="${HU_ROOT:-}"; R="${R%/}"
if [[ -n "$R" ]]; then
    case "$R" in /*) ;; *) echo "ERROR: HU_ROOT must be an absolute path"; exit 2 ;; esac
elif [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: must run as root"; exit 1
fi
NS="${HU_NODESOURCE:-no}"
case "$NS" in yes|no) ;; *) echo "ERROR: HU_NODESOURCE must be yes or no"; exit 2 ;; esac
MARK="Written by Grin Node Toolkit (host updates)"
ST_DIR="$R/opt/grin/host-updates"; ST="$ST_DIR/state"
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
_unit() {
    if [[ -n "$R" ]]; then echo skipped; return 0; fi
    command -v systemctl >/dev/null 2>&1 || { echo unknown; return 0; }
    local s; s=$(systemctl is-enabled "$1" 2>/dev/null); echo "${s:-absent}"
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
        case "$e" in
            *nodesource*) ns=yes ;;
            *[Ss]ecurity*) sec=1 ;;
            *) other="${other:+$other; }$e" ;;
        esac
    done < <(_apt_origins)
    if [[ -n "$other" ]]; then SEC_ONLY=no; elif (( sec )); then SEC_ONLY=yes; else SEC_ONLY=n/a; fi
    NONSEC="$other"; NS_ALLOWED="$ns"
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
_restart_probe() {
    REBOOT=unknown; SVCS=unknown
    if [[ "$FAM" == apt ]]; then
        REBOOT=no
        [[ -e "$R/var/run/reboot-required" ]] && REBOOT=yes
        if command -v needrestart >/dev/null 2>&1; then
            local nr k
            nr=$(NEEDRESTART_MODE=l needrestart -b -r l 2>/dev/null || true)
            SVCS=$(sed -n 's/^NEEDRESTART-SVC: //p' <<< "$nr" | paste -sd, -)
            SVCS="${SVCS:-none}"
            k=$(sed -n 's/^NEEDRESTART-KSTA: //p' <<< "$nr" | head -1)
            case "$k" in 2|3) REBOOT=yes ;; esac
        fi
    elif [[ "$FAM" == dnf ]] && command -v dnf >/dev/null 2>&1; then
        local rc=0 out
        dnf -q needs-restarting -r >/dev/null 2>&1 || rc=$?
        case "$rc" in 0) REBOOT=no ;; 1) REBOOT=yes ;; esac
        rc=0; out=$(dnf -q needs-restarting -s 2>/dev/null) || rc=$?
        if [[ "$rc" -eq 0 ]]; then SVCS=$(grep -v '^[[:space:]]*$' <<< "$out" | paste -sd, -); SVCS="${SVCS:-none}"; fi
    fi
}
HU_EOF

# -----------------------------------------------------------------------------
# status — read-only. Never takes the dpkg lock: the pending count uses
# `apt-get -s` with Debug::NoLocking, the same probe 083's report uses.
# auto_updates=on needs the package installed AND the schedule live — on apt
# APT::Periodic::Unattended-Upgrade non-zero (read from apt's EFFECTIVE config,
# so a later file overriding ours is seen) and the upgrade timer not disabled;
# on dnf the timer enabled and apply_updates=yes.
# -----------------------------------------------------------------------------
read -r -d '' _HU_STATUS_BODY <<'HU_EOF' || true
echo "family=$FAM"
echo "distro=${OS_ID:-unknown}${OS_CODE:+ $OS_CODE}"
NOTES=()
if [[ "$FAM" == apt ]]; then
    inst=no; command -v unattended-upgrade >/dev/null 2>&1 && inst=yes
    per=$(_aptcfg shell V APT::Periodic::Unattended-Upgrade 2>/dev/null | sed -n "s/^V='\(.*\)'$/\1/p")
    tmr=$(_unit apt-daily-upgrade.timer)
    au=off
    if [[ "$inst" == yes && -n "$per" && "$per" != 0 ]]; then
        case "$tmr" in disabled|masked|absent) ;; *) au=on ;; esac
    fi
    echo "auto_updates=$au"
    [[ "$inst" == no ]] && NOTES+=("unattended-upgrades is not installed")
    [[ "$inst" == yes && ( -z "$per" || "$per" == 0 ) ]] && NOTES+=("unattended-upgrades is installed but APT::Periodic::Unattended-Upgrade is off")
    case "$tmr" in disabled|masked) NOTES+=("apt-daily-upgrade.timer is $tmr") ;; esac
    if [[ -f "$F_POL" ]]; then echo "toolkit_policy=present"; else echo "toolkit_policy=absent"; fi
    _classify_origins
    echo "security_only=$SEC_ONLY"
    [[ -n "$NONSEC" ]] && NOTES+=("effective policy also allows non-security origins: $NONSEC")
    n=$(apt-get -s -o Debug::NoLocking=true upgrade 2>/dev/null | grep -ci '^Inst.*security' || true)
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
    inst=unknown
    if [[ -z "$R" ]] && command -v rpm >/dev/null 2>&1; then
        if rpm -q "$DNF_PKG" >/dev/null 2>&1; then inst=yes; else inst=no; fi
    fi
    tmr=$(_unit "$DNF_TIMER")
    itmr=no; [[ "$DNFV" == 4 && "$(_unit dnf-automatic-install.timer)" == enabled ]] && itmr=yes
    apply=$(_dnf_eff apply_updates no)
    utype=$(_dnf_eff upgrade_type default)
    au=off
    if [[ "$inst" == yes ]]; then
        if [[ "$itmr" == yes ]] || [[ "$tmr" == enabled && "$apply" =~ ^(yes|true|1)$ ]]; then au=on; fi
    fi
    echo "auto_updates=$au"
    [[ "$inst" == no ]] && NOTES+=("$DNF_PKG is not installed")
    if _ours "$F_DNF"; then echo "toolkit_policy=present"; else echo "toolkit_policy=absent"; fi
    if [[ "$utype" == security ]]; then echo "security_only=yes"; else echo "security_only=no"; NOTES+=("dnf-automatic upgrade_type is '$utype'"); fi
    rc=0; out=""
    if command -v dnf >/dev/null 2>&1; then out=$(dnf -q check-upgrade --security 2>/dev/null) || rc=$?; else rc=255; fi
    case "$rc" in
        0)   echo "pending_security=0" ;;
        100) echo "pending_security=$(grep -cE '^[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+' <<< "$out" || true)" ;;
        *)   echo "pending_security=unknown" ;;
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
elif [[ -x /usr/bin/php ]] || compgen -G '/usr/sbin/php-fpm*' >/dev/null; then echo "php_repo=distro"
else echo "php_repo=none"; fi
echo "lock_busy=$(_lock_busy)"
for n in "${NOTES[@]+"${NOTES[@]}"}"; do echo "note=$n"; done
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
# ubuntu-advantage 51 file; anything numbered higher can still widen the list,
# which is why the sanity check below reads the EFFECTIVE config back.
#
# Origins (each taken from the live Release file):
#   Ubuntu  security pocket: Origin "Ubuntu", Suite "<codename>-security";
#           ESM: Origin "UbuntuESM" Suite "<codename>-infra-security" and
#           Origin "UbuntuESMApps" Suite "<codename>-apps-security".
#   Debian 12/13: Origin "Debian", Label "Debian-Security", Codename
#           "<codename>-security" (security.debian.org bookworm-/trixie-security).
#   NodeSource (opt-in): deb.nodesource.com/node_24.x/dists/nodistro/Release
#           has Origin ". nodistro", Label ". nodistro", Codename "nodistro"
#           (fetched 2026-11-01). That Origin starts with ". " and is generated
#           by aptly, so the pattern matches on `site=` (a documented
#           unattended-upgrade key) plus codename instead.
#
# needrestart: on Ubuntu 24.04 needrestart restarts services by itself after a
# non-interactive upgrade. `l` (list only) keeps node, pool, nginx, php-fpm and
# tor running; the operator restarts them when ready. Configured only where
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
    local src="$1" key="$2" bk="$ST_DIR/$(basename "$1").pre-enable"
    [[ -n "$(_st_get "$key")" ]] && return 0
    if [[ -f "$src" ]] && ! _ours "$src"; then
        if [[ ! -e "$bk" ]]; then cp -p "$src" "$bk" || { echo "ERROR: cannot back up $src"; return 1; }; fi
        _st_set "$key" yes || return 1
        echo "backed up: $src -> $bk"
    else
        _st_set "$key" no || return 1
    fi
}
if [[ "$FAM" == apt ]]; then
    if ! _policy_patterns >/dev/null; then echo "ERROR: unsupported distro '${OS_ID:-unknown}' (Ubuntu and Debian only)"; exit 1; fi
    if [[ -n "$R" ]]; then
        echo "skip: package install (HU_ROOT test mode)"
    elif ! command -v unattended-upgrade >/dev/null 2>&1; then
        echo "installing unattended-upgrades (waits up to 120 s for the dpkg lock)..."
        AO=(-o DPkg::Lock::Timeout=120 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
        export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
        if ! apt-get "${AO[@]}" install -y -q unattended-upgrades >/dev/null 2>&1; then
            apt-get -o DPkg::Lock::Timeout=120 update -q >/dev/null 2>&1
            apt-get "${AO[@]}" install -y -q unattended-upgrades >/dev/null 2>&1 \
                || { echo "ERROR: apt-get install unattended-upgrades failed (lock still held, or no network)"; exit 1; }
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
    elif command -v systemctl >/dev/null 2>&1; then
        systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 \
            || echo "WARN: could not enable apt-daily timers"
    fi
    _classify_origins
    per=$(_aptcfg shell V APT::Periodic::Unattended-Upgrade 2>/dev/null | sed -n "s/^V='\(.*\)'$/\1/p")
    rb=$(_aptcfg shell V Unattended-Upgrade::Automatic-Reboot 2>/dev/null | sed -n "s/^V='\(.*\)'$/\1/p")
    _apt_origins | sed 's/^/effective_origin=/'
    echo "check: periodic=$per automatic_reboot=$rb security_only=$SEC_ONLY nodesource=$NS_ALLOWED"
    if [[ "$SEC_ONLY" != yes ]]; then echo "WARN: a later apt.conf.d file widens the policy: ${NONSEC:-no security origin left}"; fi
    if [[ "$per" != 1 ]]; then echo "WARN: APT::Periodic::Unattended-Upgrade is '$per' after writing — another file overrides it"; fi
    if [[ "$rb" != false ]]; then echo "WARN: Automatic-Reboot is '$rb' after writing — another file overrides it"; fi
elif [[ "$FAM" == dnf ]]; then
    if [[ -n "$R" ]]; then
        echo "skip: package install (HU_ROOT test mode)"
    elif ! rpm -q "$DNF_PKG" >/dev/null 2>&1; then
        echo "installing $DNF_PKG..."
        dnf install -y -q "$DNF_PKG" >/dev/null 2>&1 || { echo "ERROR: dnf install $DNF_PKG failed"; exit 1; }
        echo "installed: $DNF_PKG"
    fi
    _bk_once "$F_DNF" had_dnf || exit 1
    printf '# %s. Disable through the toolkit to restore the previous file.\n[commands]\nupgrade_type = security\ndownload_updates = yes\napply_updates = yes\nreboot = never\n\n[emitters]\nemit_via = stdio\n' "$MARK" \
        | _wr "$F_DNF" || exit 1
    _st_set wrote_dnf yes || exit 1
    echo "wrote: $F_DNF"
    if [[ "$NS" == yes ]]; then echo "WARN: NodeSource opt-in is apt-only — security-only dnf skips repos without advisories"; fi
    if [[ -n "$R" ]]; then echo "skip: systemctl enable --now $DNF_TIMER (HU_ROOT test mode)"
    else
        systemctl enable --now "$DNF_TIMER" >/dev/null 2>&1 || { echo "ERROR: could not enable $DNF_TIMER"; exit 1; }
        echo "enabled: $DNF_TIMER"
    fi
    echo "check: upgrade_type=$(_dnf_eff upgrade_type default) apply_updates=$(_dnf_eff apply_updates no) reboot=$(_dnf_eff reboot never)"
else
    echo "ERROR: no apt-get or dnf found"; exit 1
fi
echo __OK__
HU_EOF

# -----------------------------------------------------------------------------
# disable — "off" means off: the apt schedule is written back as "0" and the
# dnf timer is disabled, even when the host had them on before enable (the
# pre-enable copies are kept in the state dir for anyone who wants them back).
# Only files carrying the toolkit marker are deleted; packages stay installed.
# -----------------------------------------------------------------------------
read -r -d '' _HU_DISABLE_BODY <<'HU_EOF' || true
if [[ "$FAM" == apt ]]; then
    if _ours "$F_POL"; then rm -f "$F_POL" || { echo "ERROR: cannot remove $F_POL"; exit 1; }; echo "removed: $F_POL"
    elif [[ -e "$F_POL" ]]; then echo "WARN: $F_POL has no toolkit marker — left in place"
    else echo "absent: $F_POL"; fi
    if [[ "$(_st_get wrote_auto)" == yes ]] || _ours "$F_AUTO"; then
        printf '// %s. Automatic updates turned off by the toolkit.\nAPT::Periodic::Update-Package-Lists "0";\nAPT::Periodic::Unattended-Upgrade "0";\n' "$MARK" \
            | _wr "$F_AUTO" || exit 1
        echo "wrote: $F_AUTO (schedule off)"
    fi
    if _ours "$F_NR"; then rm -f "$F_NR" || { echo "ERROR: cannot remove $F_NR"; exit 1; }; echo "removed: $F_NR"; fi
elif [[ "$FAM" == dnf ]]; then
    if [[ -n "$R" ]]; then echo "skip: systemctl disable --now $DNF_TIMER (HU_ROOT test mode)"
    elif command -v systemctl >/dev/null 2>&1; then
        systemctl disable --now "$DNF_TIMER" >/dev/null 2>&1 || echo "WARN: could not disable $DNF_TIMER"
        echo "disabled: $DNF_TIMER"
    fi
    if _ours "$F_DNF"; then
        bk="$ST_DIR/automatic.conf.pre-enable"
        if [[ "$(_st_get had_dnf)" == yes && -f "$bk" ]]; then
            if ! { cp -p "$bk" "$F_DNF.hu$$.bak" && mv -f "$F_DNF.hu$$.bak" "$F_DNF"; }; then
                rm -f "$F_DNF.hu$$.bak"; echo "ERROR: cannot restore $F_DNF"; exit 1
            fi
            echo "restored: $F_DNF from $bk"
        else
            rm -f "$F_DNF" || { echo "ERROR: cannot remove $F_DNF"; exit 1; }
            echo "removed: $F_DNF"
        fi
    fi
else
    echo "ERROR: no apt-get or dnf found"; exit 1
fi
if [[ -f "$ST" ]]; then rm -f "$ST" || { echo "ERROR: cannot remove $ST"; exit 1; }; fi
ls "$ST_DIR"/*.pre-enable >/dev/null 2>&1 && echo "kept: pre-enable copies in $ST_DIR"
echo "auto_updates=off"
echo __OK__
HU_EOF

# -----------------------------------------------------------------------------
# run-now — one security-only pass. On apt it runs unattended-upgrade, which
# applies exactly the policy above; without the toolkit drop-in it would apply
# the stock policy (on Debian that includes point-release updates), so it
# refuses until enable has run. NEEDRESTART_MODE=l keeps needrestart from
# restarting services even where our drop-in is absent.
# -----------------------------------------------------------------------------
read -r -d '' _HU_RUNNOW_BODY <<'HU_EOF' || true
if [[ -n "$R" ]]; then echo "skip: run-now does nothing in HU_ROOT test mode"; echo __OK__; exit 0; fi
export NEEDRESTART_MODE=l DEBIAN_FRONTEND=noninteractive
w=0
while [[ "$(_lock_busy)" == yes && $w -lt 120 ]]; do
    (( w == 0 )) && echo "package manager busy — waiting up to 120 s..."
    sleep 5; w=$((w+5))
done
rc=0
if [[ "$FAM" == apt ]]; then
    _ours "$F_POL" || { echo "ERROR: toolkit security policy not installed — run enable first"; exit 1; }
    command -v unattended-upgrade >/dev/null 2>&1 || { echo "ERROR: unattended-upgrade not installed — run enable first"; exit 1; }
    apt-get -o DPkg::Lock::Timeout=120 update -q >/dev/null 2>&1 || echo "WARN: apt-get update failed — using cached package lists"
    unattended-upgrade -v 2>&1 || rc=$?
elif [[ "$FAM" == dnf ]]; then
    dnf upgrade --security -y 2>&1 || rc=$?
else
    echo "ERROR: no apt-get or dnf found"; exit 1
fi
_restart_probe
echo "reboot_required=$REBOOT"
echo "services_restart=$SVCS"
[[ "$rc" -eq 0 ]] || { echo "ERROR: patch run exited $rc"; exit 1; }
echo __OK__
HU_EOF

# -----------------------------------------------------------------------------
# hu_script <action> [nodesource=yes|no] — print the complete runnable script.
# The env lines go FIRST so the prelude sees them; HU_ROOT is passed through
# only when the caller has it set (tests).
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
    printf 'HU_NODESOURCE=%s\n' "$ns"
    if [[ -n "${HU_ROOT:-}" ]]; then printf 'HU_ROOT=%q\n' "$HU_ROOT"; fi
    if [[ -n "${HU_ROOT:-}" && -n "${HU_FAMILY:-}" ]]; then printf 'HU_FAMILY=%q\n' "$HU_FAMILY"; fi
    if [[ -n "${HU_ROOT:-}" && -n "${HU_DNF_VERSION:-}" ]]; then printf 'HU_DNF_VERSION=%q\n' "$HU_DNF_VERSION"; fi
    printf '%s\n%s\n' "$_HU_PRELUDE" "$body"
}

# -----------------------------------------------------------------------------
# Local wrappers (083). Colours and info/warn/error/log come from the caller.
# -----------------------------------------------------------------------------

# hu_run <action> [nodesource=…] — run locally, streaming output line by line
# (a patch run takes minutes) and copying it into LOG_FILE when the caller has
# one. rc 0 only if the script exited 0 AND its last line is __OK__ — a script
# killed halfway must never read as success.
hu_run() {
    local script tmp rc last
    script=$(hu_script "$@") || return 2
    tmp=$(mktemp) || { error "mktemp failed"; return 1; }
    bash -s <<< "$script" 2>&1 | tee "$tmp" | grep --line-buffered -v '^__OK__$' | sed -u 's/^/    /'
    rc=${PIPESTATUS[0]}
    last=$(tail -1 "$tmp" 2>/dev/null || true)
    if [[ -n "${LOG_FILE:-}" ]]; then
        { echo "[hu] $* rc=$rc"; sed 's/^/[hu]   /' "$tmp"; } >> "$LOG_FILE" 2>/dev/null || true
    fi
    rm -f "$tmp" 2>/dev/null || true
    if [[ $rc -eq 0 && "$last" == "__OK__" ]]; then return 0; fi
    return 1
}

# hu_status_load — run the status script and fill HU_ST[key]=value plus the
# HU_NOTES array. rc 1 when the script did not finish.
declare -gA HU_ST=()
HU_NOTES=()
hu_status_load() {
    local out line k v
    HU_ST=(); HU_NOTES=()
    out=$(hu_script status | bash -s 2>/dev/null) || true
    [[ "$(printf '%s\n' "$out" | tail -1)" == "__OK__" ]] || return 1
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
        error "The status check did not complete — see $LOG_FILE."
        return 1
    fi
    local s="${HU_ST[security_only]:-unknown}"
    echo -e "  ${DIM}${HU_ST[distro]:-unknown} · package manager ${HU_ST[family]:-unknown}${RESET}"
    echo ""
    _hu_row "Automatic updates"     "${HU_ST[auto_updates]:-unknown}"       'on'
    _hu_row "Toolkit policy"        "${HU_ST[toolkit_policy]:-unknown}"     'present'
    _hu_row "Security-only"         "$s"                                    'yes'
    _hu_row "Pending security"      "${HU_ST[pending_security]:-unknown}"   '0'
    _hu_row "Reboot required"       "${HU_ST[reboot_required]:-unknown}"    'no'
    _hu_row "Services to restart"   "${HU_ST[services_restart]:-unknown}"   'none'
    _hu_row "needrestart list-only" "${HU_ST[needrestart_policy]:-unknown}" 'present|n/a'
    _hu_row "NodeSource origin"     "${HU_ST[nodesource_origin]:-unknown}"  'not-allowed|allowed|n/a'
    _hu_row "PHP packages from"     "${HU_ST[php_repo]:-unknown}"           'distro|none'
    _hu_row "Package lock busy"     "${HU_ST[lock_busy]:-unknown}"          'no'
    local n
    if (( ${#HU_NOTES[@]} > 0 )); then
        echo ""
        for n in "${HU_NOTES[@]}"; do echo -e "  ${YELLOW}·${RESET} $n"; done
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

hu_action_enable() {
    _hu_banner
    echo ""
    echo -e "  Installs the OS security-update service and limits it to the distro's"
    echo -e "  ${BOLD}security channel${RESET:-}. It never reboots and never restarts services — a"
    echo -e "  running node, pool, nginx or tor keeps running; you restart them when ready."
    echo -e "  The stock config files are not edited; Disable removes what this writes."
    echo ""
    echo -e "  ${BOLD}NodeSource (Node.js) updates${RESET:-}"
    echo -e "  ${DIM}NodeSource publishes every Node.js 24.x release — new features and fixes,${RESET:-}"
    echo -e "  ${DIM}not security fixes only — so allowing it lets an unattended run move the${RESET:-}"
    echo -e "  ${DIM}Node.js runtime under the pool and web apps. Debian/Ubuntu only.${RESET:-}"
    local ns=no
    if _hu_confirm "Also apply NodeSource updates automatically?"; then ns=yes; fi
    echo ""
    _hu_confirm "Enable automatic security updates now (NodeSource: $ns)?" \
        || { info "Cancelled — nothing was changed."; _hu_pause; return 0; }
    log "[hu] enable requested nodesource=$ns"
    echo ""
    if hu_run enable "nodesource=$ns"; then
        success "Automatic security updates enabled."
    else
        error "Enable did not complete — see the output above and $LOG_FILE."
    fi
    _hu_pause
}

hu_action_disable() {
    _hu_banner
    echo ""
    echo -e "  Turns automatic updates OFF and removes the toolkit's policy files. Packages"
    echo -e "  stay installed; copies of any file replaced at enable stay in /opt/grin/host-updates/."
    echo ""
    _hu_confirm "Disable automatic security updates?" \
        || { info "Cancelled — nothing was changed."; _hu_pause; return 0; }
    log "[hu] disable requested"
    echo ""
    if hu_run disable; then success "Automatic updates are off."
    else error "Disable did not complete — see the output above and $LOG_FILE."; fi
    _hu_pause
}

hu_action_run_now() {
    _hu_banner
    echo ""
    echo -e "  Applies pending SECURITY updates once, now. No reboot and no service"
    echo -e "  restarts — the result says whether either is needed. Can take minutes."
    echo ""
    _hu_confirm "Run a security patch now?" \
        || { info "Cancelled — nothing was changed."; _hu_pause; return 0; }
    log "[hu] run-now requested"
    echo ""
    if hu_run run-now; then success "Security patch run finished."
    else error "Patch run did not complete — see the output above and $LOG_FILE."; fi
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
        echo -e "  ${DIM}Security-channel patches only · never reboots · never restarts services.${RESET:-}"
        echo ""
        echo -e "  ${GREEN:-}1${RESET:-})   Show status               ${DIM}read-only${RESET:-}"
        echo -e "  ${YELLOW:-}2${RESET:-})   Enable                    ${DIM}asks first; NodeSource is opt-in${RESET:-}"
        echo -e "  ${YELLOW:-}3${RESET:-})   Disable                   ${DIM}asks first; removes toolkit files only${RESET:-}"
        echo -e "  ${YELLOW:-}4${RESET:-})   Run security patch now    ${DIM}asks first; one pass, no reboot${RESET:-}"
        echo ""
        echo -e "  ${DIM}0${RESET:-})   Back to Host Optimization"
        echo -e "${DIM:-}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET:-}"
        echo -ne "${BOLD:-}Select [0-4]: ${RESET:-}"
        read -r choice || return 0
        case "$choice" in
            1) hu_action_status  || true ;;
            2) hu_action_enable  || true ;;
            3) hu_action_disable || true ;;
            4) hu_action_run_now || true ;;
            0) return 0 ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}
