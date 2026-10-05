# =============================================================================
# lib/grin_alert_send.sh — off-box alert DELIVERY (ntfy / Telegram / email / Nostr)
# =============================================================================
# Extracted 2026-10-03 from 082 Provider Access Watch's worker (086 design
# §8.10), so the node event recorder sends through the SAME code instead of a
# copy. Delivery only: the caller owns its config file, its debounce and its
# wording. Every configured channel is tried; one failing never blocks another.
#
# Users:
#   · 082 — INLINED into the generated /opt/grin/access-watch.sh by
#     _aw_install_worker (cat'd between two quoted heredocs). That worker stays
#     ONE self-contained file, the property 082 is built on: a tamper alert must
#     not depend on anything else on the box still being intact. So this file
#     must stay inlinable: no shebang, no top-level `return`, no `source`.
#   · grin-node-events (086 §8 recorder) — sourced from its /opt/grin/lib copy.
#   NOT lib/grin_alerts.sh (Script 03): an older, separate copy of the same
#   channel code with its own title and `from:` line, not converged onto this.
#
# The caller sets the channel variables — plain shell variables, ideally
# `local` to the calling function. Exporting them hands the bot token and the
# nostr key to the environment of every child process.
#   NTFY_URL   TG_BOT_TOKEN TG_CHAT_ID   MAIL_TO   NOSTR_SK NOSTR_RELAY
#
# Knobs. All optional; 082's worker sets the first three and nothing else, which
# reproduces its pre-extraction requests and log lines exactly.
#   GAS_TITLE_PREFIX  ntfy Title / email Subject prefix   [Grin Node Toolkit]
#   GAS_NTFY_TAGS     ntfy Tags header; empty = none      []
#   GAS_LOG_FN        function given each log line        [stderr]
#   GAS_PRIORITY      ntfy Priority; empty = HIGH→urgent, anything else→default
#   GAS_MAX_TIME      seconds per channel (curl --max-time) [15]
#   GAS_CMD_TIMEOUT   1 = also bound sendmail/mail/msmtp/nak/nostril/websocat
#                     with `timeout`, at the same per-channel limit [0]
#   GAS_DEADLINE      epoch: a channel whose turn comes after it is skipped and
#                     every limit is clamped to it [none]
#   GAS_HIDE_SECRETS  1 = the ntfy topic URL and the Telegram URL (it embeds the
#                     bot token) reach curl on stdin (-K -), not argv [0]. Nostr
#                     is NOT covered: nak and nostril take the key only as --sec,
#                     so it is in argv for the length of one send whenever Nostr
#                     is configured.
#
# ERREXIT: reached through `fn || …` from libs and from workers that run
# without -e. Nothing here aborts a caller; every path returns a status.
# =============================================================================

_GAS_T=15

_gas_log() {
    if [[ -n "${GAS_LOG_FN:-}" ]] && declare -F "$GAS_LOG_FN" >/dev/null 2>&1; then
        "$GAS_LOG_FN" "$*"
    else
        echo "$*" >&2
    fi
    return 0
}

# _gas_turn <channel> → 0 and _GAS_T = this channel's time limit, or 1 (logged)
# when GAS_DEADLINE has passed.
_gas_turn() {
    local max="${GAS_MAX_TIME:-15}" now left
    if ! [[ "$max" =~ ^[0-9]+$ ]] || (( max < 1 )); then max=15; fi
    _GAS_T="$max"
    [[ "${GAS_DEADLINE:-}" =~ ^[0-9]+$ ]] || return 0
    printf -v now '%(%s)T' -1
    left=$(( GAS_DEADLINE - now ))
    if (( left < 2 )); then
        _gas_log "skipped: $1 (alert time budget spent)"
        return 1
    fi
    if (( left < max )); then _GAS_T="$left"; fi
    return 0
}

# Space-separated configured channels ("" = none). Pure: reads variables only.
gas_channels() {
    local out=""
    [[ -n "${NTFY_URL:-}" ]] && out+="ntfy "
    [[ -n "${TG_BOT_TOKEN:-}" && -n "${TG_CHAT_ID:-}" ]] && out+="telegram "
    [[ -n "${MAIL_TO:-}" ]] && out+="email "
    [[ -n "${NOSTR_SK:-}" && -n "${NOSTR_RELAY:-}" ]] && out+="nostr "
    printf '%s' "${out% }"
    return 0
}

# _gas_ntfy <body> — reads the caller's hdr array. A topic URL is a credential
# (anyone holding it can read and post), so under GAS_HIDE_SECRETS it goes to
# curl on stdin too.
_gas_ntfy() {
    local u
    if [[ "${GAS_HIDE_SECRETS:-0}" == 1 ]]; then
        u="${NTFY_URL//\\/\\\\}"; u="${u//\"/\\\"}"
        printf 'url = "%s"\n' "$u" | curl -fs --max-time "$_GAS_T" "${hdr[@]}" -d "$1" -K - >/dev/null 2>&1
    else
        curl -fs --max-time "$_GAS_T" "${hdr[@]}" -d "$1" "$NTFY_URL" >/dev/null 2>&1
    fi
}

_gas_telegram() {
    local text="$1" u
    if [[ "${GAS_HIDE_SECRETS:-0}" == 1 ]]; then
        # printf is a builtin: the token never appears in any process's argv.
        u="https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage"
        u="${u//\\/\\\\}"; u="${u//\"/\\\"}"
        printf 'url = "%s"\n' "$u" | curl -fs --max-time "$_GAS_T" -K - \
             --data-urlencode "chat_id=${TG_CHAT_ID}" \
             --data-urlencode "text=$text" >/dev/null 2>&1
    else
        curl -fs --max-time "$_GAS_T" \
             --data-urlencode "chat_id=${TG_CHAT_ID}" \
             --data-urlencode "text=$text" \
             "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" >/dev/null 2>&1
    fi
}

_gas_email() {
    local subj="$1" body="$2"
    local -a t=()
    if [[ "${GAS_CMD_TIMEOUT:-0}" == 1 ]] && command -v timeout &>/dev/null; then t=(timeout "$_GAS_T"); fi
    if command -v sendmail &>/dev/null; then
        printf 'To: %s\nSubject: %s\nContent-Type: text/plain; charset=UTF-8\n\n%s\n' \
            "$MAIL_TO" "$subj" "$body" | "${t[@]}" sendmail -t 2>/dev/null
    elif command -v mail &>/dev/null; then
        printf '%s\n' "$body" | "${t[@]}" mail -s "$subj" "$MAIL_TO" 2>/dev/null
    elif command -v msmtp &>/dev/null; then
        printf 'To: %s\nSubject: %s\n\n%s\n' "$MAIL_TO" "$subj" "$body" | "${t[@]}" msmtp "$MAIL_TO" 2>/dev/null
    else
        _gas_log "email: no sendmail/mail/msmtp binary found"; return 1
    fi
}

# Nostr needs a signer (schnorr/secp256k1) — we shell out to nak or nostril.
_gas_nostr() {
    local body="$1"
    local -a t=()
    if [[ "${GAS_CMD_TIMEOUT:-0}" == 1 ]] && command -v timeout &>/dev/null; then t=(timeout "$_GAS_T"); fi
    if command -v nak &>/dev/null; then
        "${t[@]}" nak event --sec "$NOSTR_SK" -c "$body" "$NOSTR_RELAY" >/dev/null 2>&1
    elif command -v nostril &>/dev/null && command -v websocat &>/dev/null; then
        "${t[@]}" nostril --sec "$NOSTR_SK" --content "$body" 2>/dev/null | "${t[@]}" websocat -n1 "$NOSTR_RELAY" >/dev/null 2>&1
    else
        _gas_log "nostr: needs 'nak' (or 'nostril'+'websocat') installed — skipped"; return 1
    fi
}

# gas_send <severity> <subject> <body> — every configured channel, in the order
# ntfy, Telegram, email, Nostr. rc 0 = at least one channel accepted it.
gas_send() {
    local severity="$1" subject="$2" body="$3"
    local host stamp full prio title sent=1
    local -a hdr
    host="$(hostname 2>/dev/null || echo vps)"
    stamp="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
    full="[$severity] $subject
host: $host
time: $stamp

$body"
    prio="${GAS_PRIORITY:-}"
    if [[ -z "$prio" ]]; then
        prio="default"
        if [[ "$severity" == "HIGH" ]]; then prio="urgent"; fi
    fi
    title="${GAS_TITLE_PREFIX:-Grin Node Toolkit}: $subject"

    if [[ -n "${NTFY_URL:-}" ]] && _gas_turn ntfy; then
        hdr=(-H "Title: $title" -H "Priority: $prio")
        if [[ -n "${GAS_NTFY_TAGS:-}" ]]; then hdr+=(-H "Tags: $GAS_NTFY_TAGS"); fi
        if _gas_ntfy "$full"; then
            sent=0; _gas_log "sent: ntfy"
        else
            _gas_log "FAILED: ntfy"
        fi
    fi
    if [[ -n "${TG_BOT_TOKEN:-}" && -n "${TG_CHAT_ID:-}" ]] && _gas_turn telegram; then
        if _gas_telegram "$full"; then sent=0; _gas_log "sent: telegram"; else _gas_log "FAILED: telegram"; fi
    fi
    if [[ -n "${MAIL_TO:-}" ]] && _gas_turn email; then
        if _gas_email "$title" "$full"; then sent=0; _gas_log "sent: email"; else _gas_log "FAILED: email"; fi
    fi
    if [[ -n "${NOSTR_SK:-}" && -n "${NOSTR_RELAY:-}" ]] && _gas_turn nostr; then
        if _gas_nostr "$full"; then sent=0; _gas_log "sent: nostr"; else _gas_log "FAILED/skipped: nostr"; fi
    fi
    return "$sent"
}
