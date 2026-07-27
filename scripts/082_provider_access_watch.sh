#!/bin/bash
# =============================================================================
# 082_provider_access_watch.sh - Provider / host-access tamper watch
# =============================================================================
# Detects the signals a rented VPS CAN observe from inside the guest that hint
# a provider (or an attacker with console/rescue access) touched the box:
#
#   • new / removed authorized_keys entries       (backdoor key)        HIGH
#   • changed sshd / sudoers / cron / systemd unit hashes (tampering)   MED/HIGH
#   • boot_id change you didn't trigger            (rescue boot / migration)
#   • kernel or kernel-cmdline change              (rescue/single-user)
#   • new SSH logins accepted                      (someone got in)
#   • large heartbeat gap with no reboot           (VM pause / clock jump)
#
# Design rules (see docs/generated/script082_design.md):
#   1. Alerts MUST leave the box — a log on the same server an attacker touched
#      is worthless. Delivery goes out-of-band via ntfy / Telegram / email /
#      Nostr (any subset the operator configures).
#   2. Keep a copy of the baseline HASH off-box so they can't silently rewrite
#      it — the tool prints it after every baseline for you to save.
#   3. Secrets live in /opt/grin/conf/access-watch/alert.conf (chmod 600),
#      never hardcoded.
#
# This is DETECTION only. The two things that actually raise the ceiling —
# LUKS + dropbear-initramfs remote-unlock, and keeping the wallet seed off the
# public VPS — are bigger and out of scope here (noted in the menu as pointers).
#
# Scope: runs as root on the VPS. All real work is done by a self-contained
# worker installed at /opt/grin/access-watch.sh, driven by a systemd timer;
# this menu is a thin front-end that installs, configures and inspects it.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Paths ────────────────────────────────────────────────────────────────────
LOG_DIR="/opt/grin/logs"
LOG_FILE="$LOG_DIR/grin_access_watch_$(date +%Y%m%d_%H%M%S).log"
AW_DIR="/opt/grin/conf/access-watch"
STATE_DIR="$AW_DIR/state"
BASELINE="$AW_DIR/baseline"
ALERT_CONF="$AW_DIR/alert.conf"
WORKER="/opt/grin/access-watch.sh"
SVC="/etc/systemd/system/grin-access-watch.service"
TIMER="/etc/systemd/system/grin-access-watch.timer"
mkdir -p "$LOG_DIR" "$AW_DIR" "$STATE_DIR"
chmod 700 "$AW_DIR"

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

# ─── Logging ──────────────────────────────────────────────────────────────────
log()     { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; log "[INFO]  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; log "[OK]    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; log "[WARN]  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; log "[ERROR] $*"; }

pause() { echo ""; echo "Press Enter to return to menu..."; read -r; }
confirm() {
    local prompt="$1"
    echo ""
    echo -ne "${BOLD}${YELLOW}▶ $prompt [y/N]: ${RESET}"
    local ans; read -r ans
    [[ "${ans,,}" == "y" ]]
}

# ─── Root guard ────────────────────────────────────────────────────────────────
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
    error "This tool must run as root (it reads /etc/ssh, /etc/sudoers, journald)."
    exit 1
fi

# =============================================================================
# Worker installer — writes the self-contained /opt/grin/access-watch.sh.
# Refreshed on every launch so the deployed worker always matches the toolkit.
# =============================================================================
_aw_install_worker() {
    cat > "$WORKER" <<'AW_WORKER_EOF'
#!/bin/bash
# Grin Node Toolkit — provider/host access tamper watcher (worker).
# Installed by scripts/082_provider_access_watch.sh — do NOT edit by hand.
# Usage: access-watch.sh {baseline|check|test}
set -uo pipefail

AW_DIR="/opt/grin/conf/access-watch"
BASELINE="$AW_DIR/baseline"
ALERT_CONF="$AW_DIR/alert.conf"
STATE_DIR="$AW_DIR/state"
LOG="/opt/grin/logs/access-watch.log"
mkdir -p "$AW_DIR" "$STATE_DIR" /opt/grin/logs 2>/dev/null || true

note() { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG" 2>/dev/null || true; }

_sha_file() { sha256sum "$1" 2>/dev/null | awk '{print $1}'; }
_sha_str()  { printf '%s' "$1" | sha256sum 2>/dev/null | awk '{print $1}'; }
_meta()     { awk -v k="$1" '$1==k{print $2; exit}' "$2" 2>/dev/null; }

# ── State collectors ─────────────────────────────────────────────────────────
# Every user's authorized_keys, one line per key, identified by fingerprint so
# a swapped key of the same length is still caught.
_collect_authkeys() {
    local user uid home ak line tmp fp
    while IFS=: read -r user _ uid _ _ home _; do
        [[ "$uid" =~ ^[0-9]+$ ]] || continue
        if [[ "$uid" -ne 0 && "$uid" -lt 1000 ]]; then continue; fi
        ak="$home/.ssh/authorized_keys"
        [[ -f "$ak" ]] || continue
        while IFS= read -r line; do
            line="${line#"${line%%[![:space:]]*}"}"
            [[ -z "$line" || "$line" == \#* ]] && continue
            tmp="$(mktemp)"; printf '%s\n' "$line" > "$tmp"
            fp="$(ssh-keygen -l -f "$tmp" 2>/dev/null | awk '{print $2}')"
            rm -f "$tmp"
            [[ -n "$fp" ]] && echo "authkey $user $fp"
        done < "$ak"
    done < /etc/passwd
}

# SHA-256 of the files an in-band tamper / persistence backdoor would touch.
_collect_files() {
    local -a paths=()
    local sshd_bin p
    sshd_bin="$(command -v sshd 2>/dev/null || true)"
    [[ -n "$sshd_bin" ]] && paths+=("$(readlink -f "$sshd_bin" 2>/dev/null || echo "$sshd_bin")")
    paths+=(/etc/ssh/sshd_config /etc/sudoers /etc/passwd /etc/group /etc/crontab \
            /etc/hosts.allow /etc/hosts.deny /etc/ld.so.preload)
    shopt -s nullglob
    paths+=(/etc/ssh/sshd_config.d/*.conf /etc/sudoers.d/* /etc/cron.d/* \
            /etc/systemd/system/*.service /etc/systemd/system/*.timer)
    shopt -u nullglob
    for p in "${paths[@]}"; do
        if [[ -f "$p" ]]; then echo "file $p $(_sha_file "$p")"; else echo "file $p MISSING"; fi
    done
}

_collect() {
    {
        _collect_authkeys
        _collect_files
        echo "bootid $(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)"
        echo "cmdline $(_sha_str "$(cat /proc/cmdline 2>/dev/null || echo '')")"
        echo "kernel $(uname -r 2>/dev/null || echo unknown)"
    } | sort
}

# Recent accepted SSH logins (journald preferred, auth.log/secure fallback).
_recent_accepted() {
    if command -v journalctl &>/dev/null; then
        journalctl _COMM=sshd --since "1 day ago" --no-pager 2>/dev/null | grep -a "Accepted " || true
    else
        grep -ah "Accepted " /var/log/auth.log /var/log/secure 2>/dev/null || true
    fi
}

# ── Alert delivery — every configured channel, one failing never blocks others ─
notify() {
    local severity="$1" subject="$2" body="$3"
    local host stamp full prio
    host="$(hostname 2>/dev/null || echo vps)"
    stamp="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
    full="[$severity] $subject
host: $host
time: $stamp

$body"
    [[ -f "$ALERT_CONF" ]] && { set -a; . "$ALERT_CONF"; set +a; }
    prio="default"; [[ "$severity" == "HIGH" ]] && prio="urgent"

    if [[ -n "${NTFY_URL:-}" ]]; then
        curl -fs --max-time 15 -H "Title: Grin VPS access-watch: $subject" \
             -H "Priority: $prio" -H "Tags: rotating_light" \
             -d "$full" "$NTFY_URL" >/dev/null 2>&1 && note "sent: ntfy" || note "FAILED: ntfy"
    fi
    if [[ -n "${TG_BOT_TOKEN:-}" && -n "${TG_CHAT_ID:-}" ]]; then
        curl -fs --max-time 15 \
             --data-urlencode "chat_id=${TG_CHAT_ID}" \
             --data-urlencode "text=$full" \
             "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" >/dev/null 2>&1 \
             && note "sent: telegram" || note "FAILED: telegram"
    fi
    if [[ -n "${MAIL_TO:-}" ]]; then
        _send_email "Grin VPS access-watch: $subject" "$full" && note "sent: email" || note "FAILED: email"
    fi
    if [[ -n "${NOSTR_SK:-}" && -n "${NOSTR_RELAY:-}" ]]; then
        _send_nostr "$full" && note "sent: nostr" || note "FAILED/skipped: nostr"
    fi
}

_send_email() {
    local subj="$1" body="$2"
    if command -v sendmail &>/dev/null; then
        printf 'To: %s\nSubject: %s\nContent-Type: text/plain; charset=UTF-8\n\n%s\n' \
            "$MAIL_TO" "$subj" "$body" | sendmail -t 2>/dev/null
    elif command -v mail &>/dev/null; then
        printf '%s\n' "$body" | mail -s "$subj" "$MAIL_TO" 2>/dev/null
    elif command -v msmtp &>/dev/null; then
        printf 'To: %s\nSubject: %s\n\n%s\n' "$MAIL_TO" "$subj" "$body" | msmtp "$MAIL_TO" 2>/dev/null
    else
        note "email: no sendmail/mail/msmtp binary found"; return 1
    fi
}

# Nostr needs a signer (schnorr/secp256k1) — we shell out to nak or nostril.
_send_nostr() {
    local body="$1"
    if command -v nak &>/dev/null; then
        nak event --sec "$NOSTR_SK" -c "$body" "$NOSTR_RELAY" >/dev/null 2>&1
    elif command -v nostril &>/dev/null && command -v websocat &>/dev/null; then
        nostril --sec "$NOSTR_SK" --content "$body" 2>/dev/null | websocat -n1 "$NOSTR_RELAY" >/dev/null 2>&1
    else
        note "nostr: needs 'nak' (or 'nostril'+'websocat') installed — skipped"; return 1
    fi
}

# ── Actions ──────────────────────────────────────────────────────────────────
do_baseline() {
    _collect > "$BASELINE"
    chmod 600 "$BASELINE"
    # Prime the seen-logins set so only logins AFTER the baseline are reported.
    : > "$STATE_DIR/seen_logins"
    while IFS= read -r l; do
        [[ -n "$l" ]] && _sha_str "$l" >> "$STATE_DIR/seen_logins"
    done < <(_recent_accepted)
    date +%s > "$STATE_DIR/last_seen"
    local h; h="$(_sha_file "$BASELINE")"
    echo "$h" > "$STATE_DIR/baseline_hash"
    date -u '+%Y-%m-%d %H:%M:%S UTC' > "$STATE_DIR/baseline_time"
    rm -f "$STATE_DIR/last_alert_hash" 2>/dev/null || true
    echo "OK" > "$STATE_DIR/last_status"
    echo "Baseline captured. No changes yet." > "$STATE_DIR/last_report"
    note "baseline captured ($h)"
    echo "$h"
}

do_check() {
    if [[ ! -f "$BASELINE" ]]; then
        note "check: no baseline yet"
        echo "NO_BASELINE" > "$STATE_DIR/last_status"
        echo "No baseline captured yet. Run 'baseline' first." > "$STATE_DIR/last_report"
        return 0
    fi

    local ALERT_ON_LOGIN=1
    [[ -f "$ALERT_CONF" ]] && { set -a; . "$ALERT_CONF"; set +a; }

    local cur; cur="$(mktemp)"
    _collect > "$cur"

    local standing="" events="" severity="LOW"

    # authorized_keys ---------------------------------------------------------
    local newk lostk
    newk="$(comm -13 <(grep '^authkey ' "$BASELINE") <(grep '^authkey ' "$cur") 2>/dev/null || true)"
    lostk="$(comm -23 <(grep '^authkey ' "$BASELINE") <(grep '^authkey ' "$cur") 2>/dev/null || true)"
    if [[ -n "$newk" ]]; then
        severity="HIGH"
        standing+="[!] NEW authorized_key(s) — possible backdoor:"$'\n'
        while IFS= read -r l; do [[ -n "$l" ]] && standing+="    + ${l#authkey }"$'\n'; done <<< "$newk"
    fi
    if [[ -n "$lostk" ]]; then
        [[ "$severity" == "LOW" ]] && severity="MEDIUM"
        standing+="[-] REMOVED authorized_key(s):"$'\n'
        while IFS= read -r l; do [[ -n "$l" ]] && standing+="    - ${l#authkey }"$'\n'; done <<< "$lostk"
    fi

    # watched system files ----------------------------------------------------
    local -A bh ch
    local _pfx p hh
    while read -r _pfx p hh; do [[ -n "$p" ]] && bh["$p"]="$hh"; done < <(grep '^file ' "$BASELINE")
    while read -r _pfx p hh; do [[ -n "$p" ]] && ch["$p"]="$hh"; done < <(grep '^file ' "$cur")
    local filechanges=""
    for p in "${!ch[@]}"; do
        if [[ -z "${bh[$p]+x}" ]]; then
            filechanges+="    NEW watched file: $p"$'\n'
        elif [[ "${bh[$p]}" != "${ch[$p]}" ]]; then
            if   [[ "${ch[$p]}" == "MISSING" ]]; then filechanges+="    DELETED: $p"$'\n'
            elif [[ "${bh[$p]}" == "MISSING" ]]; then filechanges+="    CREATED: $p"$'\n'
            else filechanges+="    MODIFIED: $p"$'\n'; fi
        fi
    done
    for p in "${!bh[@]}"; do
        [[ -z "${ch[$p]+x}" ]] && filechanges+="    GONE from watched set: $p"$'\n'
    done
    if [[ -n "$filechanges" ]]; then
        [[ "$severity" == "LOW" ]] && severity="MEDIUM"
        standing+="[*] System file integrity changes:"$'\n'"$filechanges"
    fi

    # boot / kernel / cmdline -------------------------------------------------
    local bb cb bk ck bc cc
    bb="$(_meta bootid "$BASELINE")"; cb="$(_meta bootid "$cur")"
    bk="$(_meta kernel "$BASELINE")"; ck="$(_meta kernel "$cur")"
    bc="$(_meta cmdline "$BASELINE")"; cc="$(_meta cmdline "$cur")"
    if [[ "$bb" != "$cb" ]]; then
        [[ "$severity" == "LOW" ]] && severity="MEDIUM"
        standing+="[~] REBOOT since baseline (boot_id changed) — rescue boot / host migration if you didn't reboot."$'\n'
    fi
    if [[ "$bk" != "$ck" ]]; then
        [[ "$severity" == "LOW" ]] && severity="MEDIUM"
        standing+="[~] Kernel changed: $bk -> $ck (upgrade, or booted a rescue kernel)."$'\n'
    fi
    if [[ "$bc" != "$cc" ]]; then
        severity="HIGH"
        standing+="[!] Kernel cmdline changed — possible rescue/single-user or init= tampering."$'\n'
    fi

    # new SSH logins (event) --------------------------------------------------
    local seen="$STATE_DIR/seen_logins"; touch "$seen"
    local l h newlogins=""
    while IFS= read -r l; do
        [[ -z "$l" ]] && continue
        h="$(_sha_str "$l")"
        if ! grep -qxF "$h" "$seen" 2>/dev/null; then
            echo "$h" >> "$seen"
            newlogins+="    - $(sed -E 's/.*(Accepted [^:]*).*/\1/' <<< "$l")"$'\n'
        fi
    done < <(_recent_accepted)
    if [[ "$(wc -l < "$seen" 2>/dev/null || echo 0)" -gt 1000 ]]; then
        tail -n 500 "$seen" > "$seen.tmp" 2>/dev/null && mv "$seen.tmp" "$seen"
    fi
    if [[ -n "$newlogins" && "${ALERT_ON_LOGIN:-1}" != "0" ]]; then
        events+="[i] New SSH login(s) accepted since last check:"$'\n'"$newlogins"
    fi

    # heartbeat / clock jump (event) -----------------------------------------
    local now last gap interval threshold
    now="$(date +%s)"
    last="$(cat "$STATE_DIR/last_seen" 2>/dev/null || echo '')"
    echo "$now" > "$STATE_DIR/last_seen"
    interval="$(cat "$STATE_DIR/interval_seconds" 2>/dev/null || echo 900)"
    if [[ -n "$last" && "$bb" == "$cb" ]]; then
        gap=$(( now - last )); threshold=$(( interval * 3 + 300 ))
        if (( gap > threshold )); then
            events+="[?] Possible VM pause / clock jump: ${gap}s between checks (expected ~${interval}s), no reboot."$'\n'
        fi
    fi

    # report + notify decision ------------------------------------------------
    local report=""
    [[ -n "$standing" ]] && report+="$standing"$'\n'
    [[ -n "$events" ]]   && report+="$events"$'\n'
    [[ -z "$report" ]]   && report="No changes detected. Keys, watched files and boot state match the baseline."
    echo "$report" > "$STATE_DIR/last_report"
    date -u '+%Y-%m-%d %H:%M:%S UTC' > "$STATE_DIR/last_check_time"

    # Standing findings re-alert only when they CHANGE (no every-N-min spam for
    # a persistent condition like a reboot); events always alert (once each,
    # deduped by the seen-logins set / advancing heartbeat).
    local standing_hash prev send=0
    standing_hash="$(_sha_str "$standing")"
    prev="$(cat "$STATE_DIR/last_alert_hash" 2>/dev/null || echo '')"
    [[ -n "$standing" && "$standing_hash" != "$prev" ]] && send=1
    [[ -n "$events" ]] && send=1

    if [[ -n "$standing" || -n "$events" ]]; then
        echo "ALERT" > "$STATE_DIR/last_status"
    else
        echo "OK" > "$STATE_DIR/last_status"
    fi

    if [[ $send -eq 1 ]]; then
        local subj="changes detected"
        [[ "$severity" == "HIGH" ]] && subj="CRITICAL changes detected"
        notify "$severity" "$subj" "$report"
        [[ -n "$standing" ]] && echo "$standing_hash" > "$STATE_DIR/last_alert_hash"
        note "check: ALERT dispatched (severity $severity)"
    else
        note "check: OK / standing condition already alerted"
    fi
    rm -f "$cur"
}

do_test() {
    notify "LOW" "test alert" \
        "This is a TEST from the Grin provider access-watch on $(hostname 2>/dev/null || echo vps). If you received this, the channel works."
    note "test alert dispatched"
    echo "Test alert dispatched to all configured channels."
}

case "${1:-check}" in
    baseline) do_baseline ;;
    check)    do_check ;;
    test)     do_test ;;
    *)        echo "usage: $0 {baseline|check|test}"; exit 1 ;;
esac
AW_WORKER_EOF
    chmod 755 "$WORKER"
    log "worker installed/refreshed at $WORKER"
}

# =============================================================================
# alert.conf helpers
# =============================================================================
# %q-quote the value so the worker can safely `source` it.
_aw_set_conf() {
    local key="$1" val="$2" tmp
    touch "$ALERT_CONF"; chmod 600 "$ALERT_CONF"
    tmp="$(mktemp)"
    grep -v "^${key}=" "$ALERT_CONF" 2>/dev/null > "$tmp" || true
    printf '%s=%q\n' "$key" "$val" >> "$tmp"
    mv "$tmp" "$ALERT_CONF"
    chmod 600 "$ALERT_CONF"
}
_aw_get_conf() {
    local key="$1"
    [[ -f "$ALERT_CONF" ]] || return 0
    ( set -a; . "$ALERT_CONF" 2>/dev/null; set +a; printf '%s' "${!key:-}" )
}
_aw_has() { [[ -n "$(_aw_get_conf "$1")" ]]; }

# =============================================================================
# systemd timer helpers
# =============================================================================
_aw_timer_active() { systemctl is-active grin-access-watch.timer &>/dev/null; }

_aw_install_timer() {
    local mins="$1"
    cat > "$SVC" <<EOF
[Unit]
Description=Grin Node Toolkit - provider/host access tamper check
After=network-online.target

[Service]
Type=oneshot
ExecStart=$WORKER check
EOF
    cat > "$TIMER" <<EOF
[Unit]
Description=Grin access-watch periodic check (every ${mins} min)

[Timer]
OnBootSec=2min
OnUnitActiveSec=${mins}min
Unit=grin-access-watch.service

[Install]
WantedBy=timers.target
EOF
    echo $(( mins * 60 )) > "$STATE_DIR/interval_seconds"
    systemctl daemon-reload
    systemctl enable --now grin-access-watch.timer >/dev/null 2>&1
    log "timer installed (${mins} min)"
}

_aw_remove_timer() {
    systemctl disable --now grin-access-watch.timer >/dev/null 2>&1 || true
    rm -f "$TIMER" "$SVC"
    systemctl daemon-reload
    log "timer removed"
}

# =============================================================================
# Menu actions
# =============================================================================
snapshot_baseline() {
    clear
    echo -e "${BOLD}${CYAN}  Snapshot baseline${RESET}"
    echo ""
    if [[ -f "$BASELINE" ]]; then
        warn "A baseline already exists (captured $(cat "$STATE_DIR/baseline_time" 2>/dev/null || echo '?'))."
        if ! confirm "Overwrite it with the CURRENT system state as the new trusted baseline?"; then
            info "Kept existing baseline."; pause; return 0
        fi
    fi
    info "Capturing keys, file hashes and boot state..."
    local h; h="$("$WORKER" baseline || true)"
    echo ""
    success "Baseline captured."
    echo ""
    echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}  COPY THIS HASH OFF THE SERVER (paste it somewhere safe):${RESET}"
    echo -e "  ${BOLD}${YELLOW}$h${RESET}"
    echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "  ${DIM}If an attacker rewrites the baseline on-box, this saved value won't${RESET}"
    echo -e "  ${DIM}match — that's your tamper-evidence. Re-check it after any incident.${RESET}"
    pause
}

run_check_now() {
    clear
    echo -e "${BOLD}${CYAN}  Run check now${RESET}"
    echo ""
    if [[ ! -f "$BASELINE" ]]; then
        warn "No baseline yet — snapshot one first (option 1)."; pause; return 0
    fi
    info "Diffing current state against baseline..."
    "$WORKER" check || true
    echo ""
    local status; status="$(cat "$STATE_DIR/last_status" 2>/dev/null || echo '?')"
    if [[ "$status" == "OK" ]]; then
        success "No changes detected."
    else
        warn "Findings (also just sent to your alert channels if configured):"
    fi
    echo ""
    sed 's/^/  /' "$STATE_DIR/last_report" 2>/dev/null || true
    pause
}

show_last_report() {
    clear
    echo -e "${BOLD}${CYAN}  Last check report${RESET}"
    echo ""
    if [[ -f "$STATE_DIR/last_report" ]]; then
        echo -e "  ${DIM}Baseline taken : $(cat "$STATE_DIR/baseline_time" 2>/dev/null || echo '?')${RESET}"
        echo -e "  ${DIM}Last check     : $(cat "$STATE_DIR/last_check_time" 2>/dev/null || echo 'never')${RESET}"
        echo -e "  ${DIM}Status         : $(cat "$STATE_DIR/last_status" 2>/dev/null || echo '?')${RESET}"
        echo ""
        sed 's/^/  /' "$STATE_DIR/last_report"
    else
        info "No check has run yet."
    fi
    pause
}

configure_alerts() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Configure alert channels${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  ${DIM}Alerts must leave the box. Configure any subset; each is tried${RESET}"
        echo -e "  ${DIM}independently. Secrets are stored in $ALERT_CONF (chmod 600).${RESET}"
        echo ""
        local m_ntfy m_tg m_mail m_nostr m_login
        _aw_has NTFY_URL      && m_ntfy="${GREEN}configured${RESET}"  || m_ntfy="${DIM}off${RESET}"
        ( _aw_has TG_BOT_TOKEN && _aw_has TG_CHAT_ID ) && m_tg="${GREEN}configured${RESET}" || m_tg="${DIM}off${RESET}"
        _aw_has MAIL_TO       && m_mail="${GREEN}configured${RESET}" || m_mail="${DIM}off${RESET}"
        ( _aw_has NOSTR_SK && _aw_has NOSTR_RELAY ) && m_nostr="${GREEN}configured${RESET}" || m_nostr="${DIM}off${RESET}"
        [[ "$(_aw_get_conf ALERT_ON_LOGIN)" == "0" ]] && m_login="${DIM}off${RESET}" || m_login="${GREEN}on${RESET}"
        echo -e "  ${GREEN}1${RESET}) ntfy.sh        [$m_ntfy]"
        echo -e "  ${GREEN}2${RESET}) Telegram bot   [$m_tg]"
        echo -e "  ${GREEN}3${RESET}) Email          [$m_mail]"
        echo -e "  ${GREEN}4${RESET}) Nostr note     [$m_nostr]"
        echo -e "  ${CYAN}5${RESET}) Alert on new SSH login  [$m_login]"
        echo -e "  ${YELLOW}6${RESET}) Send TEST alert to all configured channels"
        echo -e "  ${DIM}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select: ${RESET}"
        local c; read -r c
        case "$c" in
            1)
                echo -ne "ntfy topic URL (e.g. https://ntfy.sh/grin-mybox-7h2k), empty to clear: "
                local v; read -r v
                if [[ -z "$v" ]]; then _aw_set_conf NTFY_URL ""; info "ntfy cleared."
                else _aw_set_conf NTFY_URL "$v"; success "ntfy URL saved."; fi
                sleep 1 ;;
            2)
                echo -ne "Telegram bot token (from @BotFather): "; local t; read -rs t; echo
                echo -ne "Telegram chat id: "; local ci; read -r ci
                _aw_set_conf TG_BOT_TOKEN "$t"; _aw_set_conf TG_CHAT_ID "$ci"
                success "Telegram saved."; sleep 1 ;;
            3)
                echo -ne "Alert email address (needs a working sendmail/mail/msmtp), empty to clear: "
                local e; read -r e
                if [[ -z "$e" ]]; then _aw_set_conf MAIL_TO ""; info "Email cleared."
                else
                    _aw_set_conf MAIL_TO "$e"
                    if command -v sendmail &>/dev/null || command -v mail &>/dev/null || command -v msmtp &>/dev/null; then
                        success "Email saved."
                    else
                        warn "Saved, but no sendmail/mail/msmtp found — install one for email to work."
                    fi
                fi
                sleep 1 ;;
            4)
                echo -e "${DIM}Nostr needs a signer on the box: 'nak' (recommended) or 'nostril'+'websocat'.${RESET}"
                echo -ne "Nostr secret key (nsec/hex): "; local sk; read -rs sk; echo
                echo -ne "Nostr relay (wss://...): "; local rl; read -r rl
                _aw_set_conf NOSTR_SK "$sk"; _aw_set_conf NOSTR_RELAY "$rl"
                if command -v nak &>/dev/null || { command -v nostril &>/dev/null && command -v websocat &>/dev/null; }; then
                    success "Nostr saved."
                else
                    warn "Saved, but no signer found — install 'nak' for Nostr to work."
                fi
                sleep 1 ;;
            5)
                if [[ "$(_aw_get_conf ALERT_ON_LOGIN)" == "0" ]]; then
                    _aw_set_conf ALERT_ON_LOGIN "1"; success "New-login alerts ON."
                else
                    _aw_set_conf ALERT_ON_LOGIN "0"; success "New-login alerts OFF."
                fi
                sleep 1 ;;
            6)
                info "Sending test alert..."
                "$WORKER" test || true
                echo ""
                echo -e "  ${DIM}Delivery results are in /opt/grin/logs/access-watch.log${RESET}"
                pause ;;
            0) break ;;
            *) warn "Invalid selection."; sleep 1 ;;
        esac
    done
}

manage_timer() {
    clear
    echo -e "${BOLD}${CYAN}  Scheduled watch (systemd timer)${RESET}"
    echo ""
    if _aw_timer_active; then
        local iv; iv="$(cat "$STATE_DIR/interval_seconds" 2>/dev/null || echo '?')"
        success "Timer is ACTIVE (interval ${iv}s)."
        echo ""
        echo -e "  ${YELLOW}1${RESET}) Change interval"
        echo -e "  ${RED}2${RESET}) Disable timer"
        echo -e "  ${DIM}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select: ${RESET}"; local c; read -r c
        case "$c" in
            1)
                if [[ ! -f "$BASELINE" ]]; then warn "Snapshot a baseline first (option 1)."; pause; return 0; fi
                echo -ne "Check interval in minutes [15]: "; local m; read -r m; m="${m:-15}"
                [[ "$m" =~ ^[0-9]+$ ]] && (( m >= 1 )) || { warn "Invalid — using 15."; m=15; }
                _aw_install_timer "$m"; success "Interval set to ${m} min."; sleep 2 ;;
            2)
                _aw_remove_timer; success "Timer disabled."; sleep 2 ;;
            0) return 0 ;;
            *) warn "Invalid selection."; sleep 1 ;;
        esac
    else
        warn "Timer is DISABLED."
        echo ""
        if [[ ! -f "$BASELINE" ]]; then
            info "Snapshot a baseline first (option 1), then enable the timer here."
            pause; return 0
        fi
        if confirm "Enable periodic checks now?"; then
            echo -ne "Check interval in minutes [15]: "; local m; read -r m; m="${m:-15}"
            [[ "$m" =~ ^[0-9]+$ ]] && (( m >= 1 )) || { warn "Invalid — using 15."; m=15; }
            _aw_install_timer "$m"
            success "Timer enabled — checks every ${m} min."
        else
            info "Left disabled."
        fi
        sleep 2
    fi
}

show_status() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Access-watch status${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    if [[ -f "$BASELINE" ]]; then
        success "Baseline : present ${DIM}($(cat "$STATE_DIR/baseline_time" 2>/dev/null || echo '?'))${RESET}"
        echo -e "  ${DIM}hash: $(cat "$STATE_DIR/baseline_hash" 2>/dev/null || echo '?')${RESET}"
    else
        warn "Baseline : NOT captured"
    fi
    if _aw_timer_active; then
        success "Timer    : active ${DIM}(every $(( $(cat "$STATE_DIR/interval_seconds" 2>/dev/null || echo 0) / 60 )) min)${RESET}"
    else
        warn "Timer    : disabled"
    fi
    echo -e "  ${BOLD}Last check :${RESET} $(cat "$STATE_DIR/last_check_time" 2>/dev/null || echo 'never')  ${DIM}[$(cat "$STATE_DIR/last_status" 2>/dev/null || echo '-')]${RESET}"
    echo ""
    echo -e "${BOLD}Alert channels:${RESET}"
    _aw_has NTFY_URL      && echo -e "  ${GREEN}✓${RESET} ntfy"      || echo -e "  ${DIM}·${RESET} ntfy"
    ( _aw_has TG_BOT_TOKEN && _aw_has TG_CHAT_ID ) && echo -e "  ${GREEN}✓${RESET} telegram" || echo -e "  ${DIM}·${RESET} telegram"
    _aw_has MAIL_TO       && echo -e "  ${GREEN}✓${RESET} email"     || echo -e "  ${DIM}·${RESET} email"
    ( _aw_has NOSTR_SK && _aw_has NOSTR_RELAY ) && echo -e "  ${GREEN}✓${RESET} nostr" || echo -e "  ${DIM}·${RESET} nostr"
    if ! _aw_has NTFY_URL && ! _aw_has MAIL_TO && ! ( _aw_has TG_BOT_TOKEN && _aw_has TG_CHAT_ID ) && ! ( _aw_has NOSTR_SK && _aw_has NOSTR_RELAY ); then
        echo ""
        warn "No alert channel configured — findings would stay on-box only. Set one in option 4."
    fi
    echo ""
    echo -e "  ${DIM}Worker: $WORKER   Log: /opt/grin/logs/access-watch.log${RESET}"
    pause
}

hardening_pointers() {
    clear
    echo -e "${BOLD}${CYAN}  Beyond detection — raise the ceiling${RESET}"
    echo ""
    echo -e "This tool DETECTS provider access; it can't prevent it. Two measures do"
    echo -e "real work and fit this toolkit's node/wallet split:"
    echo ""
    echo -e "  ${BOLD}1) Full-disk encryption + remote unlock${RESET} ${DIM}(LUKS + dropbear-initramfs)${RESET}"
    echo -e "     ${DIM}You type the passphrase over SSH into initramfs at boot; it never${RESET}"
    echo -e "     ${DIM}lives on the box. Defeats 'mount my disk while the VM is off'. Does${RESET}"
    echo -e "     ${DIM}NOT stop live RAM reads while running.${RESET}"
    echo ""
    echo -e "  ${BOLD}2) Treat the VPS as untrusted for secrets${RESET}"
    echo -e "     ${DIM}Keep the wallet seed / owner-API secret OFF the public VPS — node${RESET}"
    echo -e "     ${DIM}on the VPS, wallet elsewhere. Fits the toolkit's existing split.${RESET}"
    echo ""
    echo -e "  ${DIM}Also run: Admin > SSH Key Hardening (085) for key-only root login.${RESET}"
    pause
}

# =============================================================================
# Main menu
# =============================================================================
show_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 082)  Provider Access Watch  ${DIM}(host-tamper detection)${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "${BOLD}  Baseline & checks${RESET}"
    echo -e "  ${GREEN}1${RESET})  Snapshot baseline       ${DIM}record trusted state (prints off-box hash)${RESET}"
    echo -e "  ${GREEN}2${RESET})  Run check now           ${DIM}diff current state vs baseline${RESET}"
    echo -e "  ${GREEN}3${RESET})  Show last report        ${DIM}findings from the most recent check${RESET}"
    echo ""
    echo -e "${BOLD}  Automation & alerts${RESET}"
    echo -e "  ${CYAN}4${RESET})  Configure alert channels ${DIM}ntfy · Telegram · email · Nostr · test${RESET}"
    echo -e "  ${CYAN}5${RESET})  Scheduled watch (timer)  ${DIM}enable/disable · set interval${RESET}"
    echo -e "  ${CYAN}6${RESET})  Status                   ${DIM}baseline, timer, channels at a glance${RESET}"
    echo ""
    echo -e "${BOLD}  Info${RESET}"
    echo -e "  ${YELLOW}7${RESET})  Beyond detection         ${DIM}LUKS remote-unlock · wallet-off-VPS${RESET}"
    echo ""
    echo -e "  ${DIM}0${RESET})  Return to admin menu"
    echo ""
    echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -ne "${BOLD}Select [0-7]: ${RESET}"
}

main() {
    _aw_install_worker
    while true; do
        show_menu
        local choice; read -r choice
        case "$choice" in
            1) snapshot_baseline   || true ;;
            2) run_check_now       || true ;;
            3) show_last_report    || true ;;
            4) configure_alerts    || true ;;
            5) manage_timer        || true ;;
            6) show_status         || true ;;
            7) hardening_pointers  || true ;;
            0) break ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

main "$@"
