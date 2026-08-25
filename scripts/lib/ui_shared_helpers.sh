# =============================================================================
# ui_shared_helpers.sh — Shared interactive-prompt helpers for toolkit menus.
# =============================================================================
# Sourced, not executed — no shebang (see CLAUDE.md). Unnumbered because it is
# cross-script, following the nginx_shared_helpers.sh precedent.
#
# WHY THIS EXISTS
# Every "type a value" prompt in the toolkit used a bare `read -r`, so the only
# way out of one you opened by mistake was Ctrl+C — which kills the whole menu
# script, not just the prompt. Worse, several of those prompts treated a bare
# Enter as "take the default AND PROCEED", so the instinctive way to back out
# actually confirmed a destructive action: hub 08's custom-branch prompt turned
# an empty Enter into a self-update from `main`, and the retention prompts
# turned it into a delete. A cancel key is therefore a safety feature here, not
# a convenience.
#
# ⚠ ERREXIT: sourced into scripts whose menu dispatch is `fn || true`, which
# disables errexit for the whole callee body. Nothing here relies on `set -e`.
#
# ⚠ COLOURS: the caller owns them (see CLAUDE.md — defined once in the main
# script, inherited via source). Every reference here is `${VAR:-}` so this lib
# is safe to source under `set -u` into a script that defines none of them.
# =============================================================================

# Source guard — these are pure function definitions, but re-sourcing inside a
# loop is wasted work and makes double-definition bugs harder to spot.
[[ -n "${UI_SHARED_HELPERS_LOADED:-}" ]] && return 0
UI_SHARED_HELPERS_LOADED=1

# The cancel key, in one place so every prompt and every hint agrees.
#
# WHY `q` AND NOT `0` OR BARE ENTER:
#   0     — already a legitimate VALUE in numeric prompts ("0 archives") and
#           already means "back" in sub-menus; reusing it makes it ambiguous.
#   Enter — already means "accept the default" wherever a prompt has one, and a
#           key cannot mean both "proceed with the default" and "do nothing".
#   q     — never a valid day count, IP address, branch name or letter-set, so
#           it can mean exactly one thing everywhere.
UI_CANCEL_KEY="q"

# -----------------------------------------------------------------------------
# _ui_name_ok <varname> <reserved-prefix> — reject a target name that would
# collide with the CALLING function's own locals.
#
# `printf -v "$name"` writes to whatever `$name` says, and bash's dynamic
# scoping means the callee's locals are in scope at that moment. So a caller
# asking ui_ask to fill `_uia_ans` overwrites ui_ask's working variable instead
# of their own — and the failure is SILENT: rc 0, empty value, caller proceeds
# with nothing. Long unlikely names make that improbable, not impossible, so
# assert it rather than hoping.
#
# ⚠ The prefix is a PARAMETER, not a fixed list of every prefix in this file:
# ui_ask_num legitimately asks ui_ask to fill its own `_uin_val`, so a blanket
# "reject anything starting _ui*" refuses the lib's own internal call and every
# ui_ask_num in the toolkit silently returns "cancelled". Each function bans
# only ITS OWN namespace.
# -----------------------------------------------------------------------------
_ui_name_ok() {
    local _uio_name="${1:-}" _uio_pre="${2:-}"
    if [[ -z "$_uio_name" ]]; then
        echo "ui_shared_helpers: no variable name given" >&2
        return 1
    fi
    if [[ -n "$_uio_pre" && "$_uio_name" == ${_uio_pre}* ]]; then
        echo "ui_shared_helpers: refusing to write to '$_uio_name' — it collides with this function's own locals (${_uio_pre}*)" >&2
        return 1
    fi
    return 0
}

# -----------------------------------------------------------------------------
# ui_ask <varname> <prompt> [default]
#
#   rc 0 → <varname> holds the entered value, or <default> on a bare Enter.
#   rc 1 → the operator cancelled. <varname> is set EMPTY and the caller MUST
#          return without acting.
#
# Cancel is `q`, EOF (Ctrl+D), or — only when the prompt has no default — a
# bare Enter. Leading/trailing whitespace is trimmed, which is what a pasted
# value needs (a trailing space silently breaks an IP match otherwise).
#
# Callers must test the return value, never the variable: an empty string is a
# legitimate answer to some prompts, so `[[ -z $x ]]` is not a cancel test.
#
#   ui_ask ip "Enter IP address to act on" || { info "Cancelled."; pause; return; }
# -----------------------------------------------------------------------------
ui_ask() {
    local _uia_var="${1:-}" _uia_prompt="${2:-}" _uia_default="${3-}"
    local _uia_ans="" _uia_hint=""

    _ui_name_ok "$_uia_var" "_uia_" || return 1

    if [[ -n "$_uia_default" ]]; then
        _uia_hint="[default ${_uia_default} · ${UI_CANCEL_KEY} = cancel]"
    else
        _uia_hint="[${UI_CANCEL_KEY} or Enter = cancel]"
    fi

    printf '%b' "${_uia_prompt} ${DIM:-}${_uia_hint}${RESET:-}: " >&2

    # A failed read is EOF (Ctrl+D) — treat it as cancel rather than looping on
    # a stale value, which is what a bare `read -r` does at the end of a pipe.
    if ! IFS= read -r _uia_ans; then
        printf '\n' >&2
        printf -v "$_uia_var" '%s' ''
        return 1
    fi

    # Trim leading/trailing whitespace (paste-safe).
    _uia_ans="${_uia_ans#"${_uia_ans%%[![:space:]]*}"}"
    _uia_ans="${_uia_ans%"${_uia_ans##*[![:space:]]}"}"

    case "$_uia_ans" in
        q|Q|quit|QUIT|cancel|CANCEL)
            printf -v "$_uia_var" '%s' ''
            return 1
            ;;
    esac

    if [[ -z "$_uia_ans" ]]; then
        # Bare Enter: take the default if there is one, otherwise cancel. A
        # prompt with no default has nothing to proceed WITH, so treating Enter
        # as confirmation there is how "just get me out of here" became a
        # destructive action.
        if [[ -n "$_uia_default" ]]; then
            printf -v "$_uia_var" '%s' "$_uia_default"
            return 0
        fi
        printf -v "$_uia_var" '%s' ''
        return 1
    fi

    printf -v "$_uia_var" '%s' "$_uia_ans"
    return 0
}

# -----------------------------------------------------------------------------
# ui_ask_num <varname> <prompt> [default] [min] [max]
#
# ui_ask plus validation, re-prompting until the answer is an integer in range.
# Cancel behaves exactly as in ui_ask, so the retry loop is always escapable —
# an un-escapable validation loop is the same trap this file exists to remove.
# -----------------------------------------------------------------------------
ui_ask_num() {
    local _uin_var="${1:-}" _uin_prompt="${2:-}" _uin_default="${3-}"
    local _uin_min="${4-}" _uin_max="${5-}" _uin_val=""

    _ui_name_ok "$_uin_var" "_uin_" || return 1

    while true; do
        ui_ask _uin_val "$_uin_prompt" "$_uin_default" || {
            printf -v "$_uin_var" '%s' ''
            return 1
        }
        if [[ ! "$_uin_val" =~ ^[0-9]+$ ]]; then
            echo -e "  ${YELLOW:-}Please enter a whole number, or ${UI_CANCEL_KEY} to cancel.${RESET:-}" >&2
            continue
        fi
        if [[ -n "$_uin_min" ]] && (( _uin_val < _uin_min )); then
            echo -e "  ${YELLOW:-}Minimum is ${_uin_min}.${RESET:-}" >&2
            continue
        fi
        if [[ -n "$_uin_max" ]] && (( _uin_val > _uin_max )); then
            echo -e "  ${YELLOW:-}Maximum is ${_uin_max}.${RESET:-}" >&2
            continue
        fi
        printf -v "$_uin_var" '%s' "$_uin_val"
        return 0
    done
}

# -----------------------------------------------------------------------------
# ui_end [note]
#
# Closing marker for a long read-only screen. A report that simply stops leaves
# the operator wondering whether it was truncated or is still running — say so
# explicitly instead.
# -----------------------------------------------------------------------------
ui_end() {
    local _uie_note="${1-}"
    echo ""
    echo -e "${DIM:-}────────────────────────────────────────────────────────${RESET:-}"
    if [[ -n "$_uie_note" ]]; then
        echo -e "  ${BOLD:-}[END]${RESET:-}  ${DIM:-}${_uie_note}${RESET:-}"
    else
        echo -e "  ${BOLD:-}[END]${RESET:-}"
    fi
    echo -e "${DIM:-}────────────────────────────────────────────────────────${RESET:-}"
}
