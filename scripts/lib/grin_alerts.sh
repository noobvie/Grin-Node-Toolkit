# ============================================================================
# grin_alerts.sh — off-box alert delivery, shared across toolkit products
#
# Sourced, never executed. No shebang.
#
# WHY THIS EXISTS, AND WHY IT IS NOT A CALL INTO SCRIPT 082
# ---------------------------------------------------------
# 082 (Provider Access Watch) already knows how to reach the operator when the
# box itself cannot be trusted. The obvious move is to call into it — but 082
# deliberately compiles a SELF-CONTAINED worker to /opt/grin/access-watch.sh so
# that a tamper alert never depends on the rest of the toolkit still being
# intact. Making it source a lib would undo the one property it is built for.
#
# So this lib duplicates the delivery code and shares the thing that actually
# matters: **the same alert.conf**. The operator configures channels once, in
# 082's menu, and every product that sources this lib can reach them. There is
# no second place to set up a bot token, and no product that silently has no
# way to tell you it failed.
#
# The cost is real and worth stating: a channel added to 082 does not appear
# here on its own. The channel set below mirrors 082's — ntfy, Telegram, email,
# nostr — and must be kept in step by hand if that list ever grows.
#
# ERREXIT: per CLAUDE.md `project_lib_errexit_suppression`, callers reach these
# through `fn || …`, which disables errexit for the whole body. Nothing here is
# allowed to abort a caller: a product must never fail its real work because it
# could not send a message ABOUT that work. Every path returns a status.
# ============================================================================

GALERT_CONF="${GALERT_CONF:-/opt/grin/conf/access-watch/alert.conf}"
GALERT_TIMEOUT="${GALERT_TIMEOUT:-15}"

# Loaded lazily so a conf written after this file was sourced is still seen.
_galert_load() {
    # Unset every channel key BEFORE sourcing. `set -a; . conf` exports each key,
    # so one later removed from the conf keeps resolving from the previous load —
    # CLAUDE.md's documented `source` trap, and here it means a channel the
    # operator turned off in 082 would go on receiving alerts for the life of the
    # process. Caught by a test that loaded two different confs in one shell.
    unset NTFY_URL TG_BOT_TOKEN TG_CHAT_ID MAIL_TO NOSTR_SK NOSTR_RELAY
    [ -f "$GALERT_CONF" ] || return 1
    # Sourced WITHOUT `set -a`, unlike 082, which needs the export because it
    # hands these to a compiled worker. Here they are only ever read in this
    # shell, and exporting would put the Telegram bot token and the nostr secret
    # key into the environment of every child the run spawns afterwards — tar,
    # pigz, ssh, rsync — for no gain. Plain shell variables are enough.
    # shellcheck disable=SC1090
    . "$GALERT_CONF" 2>/dev/null
    return 0
}

_galert_log() {
    if declare -F rc_log >/dev/null 2>&1; then rc_log "$*"
    elif declare -F log >/dev/null 2>&1; then log "$*"
    else echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*"; fi
}

# 0 when at least one channel is configured. Callers use this to say "alerts are
# off" once, rather than silently doing nothing on every failure — an operator
# who thinks they are covered and is not, is worse off than one who knows.
galert_available() {
    _galert_load || return 1
    [ -n "${NTFY_URL:-}" ] && return 0
    [ -n "${TG_BOT_TOKEN:-}" ] && [ -n "${TG_CHAT_ID:-}" ] && return 0
    [ -n "${MAIL_TO:-}" ] && return 0
    [ -n "${NOSTR_SK:-}" ] && [ -n "${NOSTR_RELAY:-}" ] && return 0
    return 1
}

galert_channels() {
    _galert_load || return 0
    local out=""
    [ -n "${NTFY_URL:-}" ] && out="${out}ntfy "
    [ -n "${TG_BOT_TOKEN:-}" ] && [ -n "${TG_CHAT_ID:-}" ] && out="${out}telegram "
    [ -n "${MAIL_TO:-}" ] && out="${out}email "
    [ -n "${NOSTR_SK:-}" ] && [ -n "${NOSTR_RELAY:-}" ] && out="${out}nostr "
    printf '%s' "${out% }"
}

_galert_email() {
    local subj="$1" body="$2"
    if command -v sendmail &>/dev/null; then
        printf 'To: %s\nSubject: %s\nContent-Type: text/plain; charset=UTF-8\n\n%s\n' \
            "$MAIL_TO" "$subj" "$body" | sendmail -t 2>/dev/null
    elif command -v mail &>/dev/null; then
        printf '%s\n' "$body" | mail -s "$subj" "$MAIL_TO" 2>/dev/null
    elif command -v msmtp &>/dev/null; then
        printf 'To: %s\nSubject: %s\n\n%s\n' "$MAIL_TO" "$subj" "$body" | msmtp "$MAIL_TO" 2>/dev/null
    else
        return 1
    fi
}

_galert_nostr() {
    local body="$1"
    if command -v nak &>/dev/null; then
        nak event --sec "$NOSTR_SK" -c "$body" "$NOSTR_RELAY" >/dev/null 2>&1
    elif command -v nostril &>/dev/null && command -v websocat &>/dev/null; then
        nostril --sec "$NOSTR_SK" --content "$body" 2>/dev/null | websocat -n1 "$NOSTR_RELAY" >/dev/null 2>&1
    else
        return 1
    fi
}

# galert_send <severity> <subject> <body> [product]
#
# Returns 0 if at least one channel accepted it. One channel failing never stops
# the others — the whole point of having several is that the reachable one wins.
galert_send() {
    local severity="$1" subject="$2" body="$3" product="${4:-grin-node-toolkit}"
    local host stamp full prio sent=1

    _galert_load || { _galert_log "alerts: no $GALERT_CONF — nothing sent"; return 1; }
    galert_available || { _galert_log "alerts: no channel configured — nothing sent"; return 1; }

    host="$(hostname 2>/dev/null || echo vps)"
    stamp="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
    full="[$severity] $subject
host: $host
time: $stamp
from: $product

$body"
    prio="default"; [ "$severity" = "HIGH" ] && prio="urgent"

    if [ -n "${NTFY_URL:-}" ]; then
        if curl -fs --max-time "$GALERT_TIMEOUT" \
                -H "Title: $product: $subject" -H "Priority: $prio" \
                -d "$full" "$NTFY_URL" >/dev/null 2>&1; then
            sent=0; _galert_log "alerts: sent via ntfy"
        else _galert_log "alerts: ntfy FAILED"; fi
    fi
    if [ -n "${TG_BOT_TOKEN:-}" ] && [ -n "${TG_CHAT_ID:-}" ]; then
        if curl -fs --max-time "$GALERT_TIMEOUT" \
                --data-urlencode "chat_id=${TG_CHAT_ID}" \
                --data-urlencode "text=$full" \
                "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" >/dev/null 2>&1; then
            sent=0; _galert_log "alerts: sent via telegram"
        else _galert_log "alerts: telegram FAILED"; fi
    fi
    if [ -n "${MAIL_TO:-}" ]; then
        if _galert_email "$product: $subject" "$full"; then
            sent=0; _galert_log "alerts: sent via email"
        else _galert_log "alerts: email FAILED (no sendmail/mail/msmtp?)"; fi
    fi
    if [ -n "${NOSTR_SK:-}" ] && [ -n "${NOSTR_RELAY:-}" ]; then
        if _galert_nostr "$full"; then
            sent=0; _galert_log "alerts: sent via nostr"
        else _galert_log "alerts: nostr FAILED/skipped (needs nak, or nostril+websocat)"; fi
    fi
    return $sent
}
