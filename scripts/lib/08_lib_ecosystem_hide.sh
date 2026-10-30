# =============================================================================
# 08_lib_ecosystem_hide.sh — Hide / un-hide entries of the ecosystem status page
#                            (Global Grin Health, ecosystem.html) from hub 08.
# =============================================================================
# Sourced, not executed — no shebang (see CLAUDE.md). Uses the caller's colours
# and info/success/warn/error/pause.
#
# WHY A LOCAL FILE
# The page's entries come from 06_ecosystem_sites.json + 06_ecosystem_dev.json,
# which ship with the toolkit; a tarball self-update overwrites them, so editing
# them on the VPS is lost on the next update. The operator's choice lives instead
# in $ECOHIDE_FILE beside stats.db — a JSON array of URLs that the checker
# (06_ecosystem_checker.py, `_load_hidden_urls`) drops from both lists on every
# run. Both sides compare URLs the same way: scheme + host lower-cased, trailing
# slash stripped. A missing or unparsable file hides nothing on the checker side;
# here an unparsable file is reported and left untouched, never overwritten.
#
# The hidden list takes effect on the next checker run (hourly cron at :00 when
# Live Updates are on in Global Grin Health, or "Run checker now" below).
#
# ⚠ ERREXIT: dispatched as `ecohide_menu || true`, so errexit is off for the
# whole body. Every create/chmod/chown/move is guarded explicitly.
# =============================================================================

ECOHIDE_STATS_DIR="/opt/grin/grin-stats"
ECOHIDE_FILE="$ECOHIDE_STATS_DIR/ecosystem_hidden.json"
ECOHIDE_CONFIG_ENV="$ECOHIDE_STATS_DIR/config.env"
ECOHIDE_CHECKER_BIN="/usr/local/bin/grin-ecosystem-checker"
ECOHIDE_WWW_DATA="/var/www/grin-stats/data"

# The deployed sidecars beside the checker are what the page is built from; the
# toolkit copy is the fallback before Global Grin Health has been installed.
ecohide_sites_dir() {
    local deployed; deployed="$(dirname "$ECOHIDE_CHECKER_BIN")"
    if [[ -f "$deployed/06_ecosystem_sites.json" ]]; then
        printf '%s' "$deployed"
    else
        printf '%s' "$SCRIPT_DIR/lib"
    fi
}

# ecohide_py list   <hidden_file> <sites_json> <dev_json>
#   → one line per entry: idx<TAB>H|-<TAB>category<TAB>name<TAB>url
#     Hidden URLs that no longer match any entry are listed last, flagged H,
#     so they can still be un-hidden.
# ecohide_py toggle <hidden_file> <url>
#   → the new hidden list as JSON on stdout (nothing is written here).
# Exit 2 = the hidden file exists but cannot be read or is not a JSON array;
#   non-string items are ignored (and dropped on the next write).
ecohide_py() {
    python3 -I - "$@" <<'PY'
import json, sys, urllib.parse

def norm(url):
    s = str(url).strip()
    try:
        p = urllib.parse.urlsplit(s)
    except ValueError:
        return s.rstrip("/").lower()
    return urllib.parse.urlunsplit(
        (p.scheme.lower(), p.netloc.lower(), p.path.rstrip("/"), p.query, p.fragment))

def load_hidden(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as e:
        print(f"{path}: {e}", file=sys.stderr)
        sys.exit(2)
    if not isinstance(data, list):
        print(f"{path}: expected a JSON array of URLs", file=sys.stderr)
        sys.exit(2)
    return [u for u in data if isinstance(u, str) and u.strip()]

def load_entries(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        print(f"{path}: {e}", file=sys.stderr)
        return []
    return [e for e in data if isinstance(e, dict) and e.get("url")] if isinstance(data, list) else []

def clean(v):
    return str(v if v is not None else "").replace("\t", " ").replace("\n", " ")

action = sys.argv[1]
hidden = load_hidden(sys.argv[2])
if action == "list":
    keys = {norm(u) for u in hidden}
    entries = []
    for p in sys.argv[3:]:
        entries.extend(load_entries(p))
    seen = set()
    i = 0
    for e in entries:
        i += 1
        k = norm(e["url"])
        seen.add(k)
        print("\t".join([str(i), "H" if k in keys else "-",
                         clean(e.get("category") or "Other"), clean(e.get("name") or "?"),
                         clean(e["url"])]))
    for u in hidden:
        if norm(u) not in seen:
            seen.add(norm(u))
            i += 1
            print("\t".join([str(i), "H", "(no longer listed)", "-", clean(u)]))
elif action == "toggle":
    target = norm(sys.argv[3])
    kept = [u for u in hidden if norm(u) != target]
    if len(kept) == len(hidden):
        kept.append(sys.argv[3])
    print(json.dumps(kept, indent=2))
else:
    print(f"unknown action: {action}", file=sys.stderr)
    sys.exit(1)
PY
}

# Atomic replace: temp file in the SAME directory (so the mv is a rename), the
# stats dir's owner and 0644 — the list is not secret and the checker may run
# as root or as that owner.
ecohide_write() {
    local content="$1" tmp owner
    [[ -d "$ECOHIDE_STATS_DIR" ]] || { error "$ECOHIDE_STATS_DIR not found."; return 1; }
    tmp="$(mktemp "$ECOHIDE_STATS_DIR/.ecosystem_hidden.XXXXXX")" \
        || { error "Cannot create a temp file in $ECOHIDE_STATS_DIR (run as root?)."; return 1; }
    printf '%s\n' "$content" > "$tmp" \
        || { rm -f "$tmp"; error "Cannot write $tmp."; return 1; }
    chmod 644 "$tmp" \
        || { rm -f "$tmp"; error "Cannot chmod $tmp."; return 1; }
    owner="$(stat -c '%u:%g' "$ECOHIDE_STATS_DIR" 2>/dev/null || true)"
    if [[ -n "$owner" ]]; then
        chown "$owner" "$tmp" \
            || { rm -f "$tmp"; error "Cannot chown $tmp to $owner."; return 1; }
    fi
    # -T: a directory at the target is an error, not a nest-inside-and-succeed.
    mv -fT "$tmp" "$ECOHIDE_FILE" \
        || { rm -f "$tmp"; error "Cannot move the new list into $ECOHIDE_FILE."; return 1; }
    log "ECOSYSTEM hidden list written: $ECOHIDE_FILE"
}

ecohide_toggle() {
    local url="$1" new rc=0
    new="$(ecohide_py toggle "$ECOHIDE_FILE" "$url")" || rc=$?
    if (( rc == 2 )); then
        error "$ECOHIDE_FILE is unreadable or not a JSON array — fix or delete it by hand; it was NOT changed."
        return 1
    elif (( rc != 0 )); then
        error "Could not compute the new hidden list (python3 exit $rc)."
        return 1
    fi
    ecohide_write "$new" || return 1
}

ecohide_cron_active() {
    crontab -l 2>/dev/null | grep -q "grin_ecosystem_update"
}

# Same invocation as Global Grin Health → Import Data → "Run ecosystem check now".
ecohide_run_checker() {
    if [[ ! -f "$ECOHIDE_CHECKER_BIN" ]]; then
        warn "Ecosystem checker not installed — install Global Grin Health stats first."
        return 1
    fi
    if [[ ! -r "$ECOHIDE_CONFIG_ENV" ]]; then
        error "Cannot read $ECOHIDE_CONFIG_ENV (run as root?)."
        return 1
    fi
    info "Running the ecosystem checker (HTTP + TCP checks — can take a minute or two)..."
    local rc=0
    # shellcheck disable=SC2046
    env $(tr '\n' ' ' < "$ECOHIDE_CONFIG_ENV") python3 "$ECOHIDE_CHECKER_BIN" --update || rc=$?
    if (( rc == 0 )); then
        chown -R www-data:www-data "$ECOHIDE_WWW_DATA" 2>/dev/null || true
        success "Ecosystem check done — the status page now reflects the hidden list."
    else
        error "Ecosystem checker failed (exit $rc)."
        return 1
    fi
}

ecohide_menu() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Ecosystem Page Entries  ${DIM}(hide / un-hide rows on ecosystem.html)${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        if ! command -v python3 &>/dev/null; then
            error "python3 not found — required to read the entry lists."
            pause; return 1
        fi
        if [[ ! -d "$ECOHIDE_STATS_DIR" ]]; then
            warn "$ECOHIDE_STATS_DIR not found — Global Grin Health stats are not installed here."
            pause; return 0
        fi

        local src out rc=0
        src="$(ecohide_sites_dir)"
        out="$(ecohide_py list "$ECOHIDE_FILE" "$src/06_ecosystem_sites.json" "$src/06_ecosystem_dev.json")" || rc=$?
        if (( rc == 2 )); then
            error "$ECOHIDE_FILE is unreadable or not a JSON array — fix or delete it by hand."
            pause; return 1
        elif (( rc != 0 )); then
            error "Could not read the entry lists (python3 exit $rc)."
            pause; return 1
        fi

        local -a urls=() flags=()
        local idx flag cat name url last_cat="" hidden_n=0
        while IFS=$'\t' read -r idx flag cat name url; do
            [[ -n "$idx" ]] || continue
            urls+=("$url"); flags+=("$flag")
            if [[ "$cat" != "$last_cat" ]]; then
                echo -e "  ${BOLD}${cat}${RESET}"
                last_cat="$cat"
            fi
            if [[ "$flag" == "H" ]]; then
                hidden_n=$(( hidden_n + 1 ))
                printf "  ${YELLOW}%3s${RESET}) ${RED}[hidden]${RESET} ${DIM}%-30s %s${RESET}\n" "$idx" "$name" "$url"
            else
                printf "  ${GREEN}%3s${RESET})          %-30s ${DIM}%s${RESET}\n" "$idx" "$name" "$url"
            fi
        done <<< "$out"

        echo ""
        echo -e "  ${DIM}Entries from: $src  ·  hidden list: $ECOHIDE_FILE${RESET}"
        echo -e "  ${DIM}${#urls[@]} entries, $hidden_n hidden.${RESET}"
        if ecohide_cron_active; then
            echo -e "  ${DIM}Changes show on the page after the next hourly checker run (cron at :00), or press r.${RESET}"
        else
            echo -e "  ${YELLOW}Ecosystem cron is not active — changes show only after a checker run (press r).${RESET}"
        fi
        echo ""
        echo -e "  ${GREEN}<number>${RESET}) Hide / un-hide that entry"
        echo -e "  ${GREEN}r${RESET})        Run the ecosystem checker now"
        echo -e "  ${DIM}0${RESET})        Back"
        echo ""
        echo -ne "${BOLD}Select: ${RESET}"
        local c; read -r c || return 0
        case "${c,,}" in
            0|"") break ;;
            r)
                ecohide_run_checker || true
                pause
                ;;
            *)
                # 10# — a leading zero ("08") would otherwise be read as octal.
                if [[ "$c" =~ ^[0-9]+$ ]] && (( ${#c} <= 4 )) && (( 10#$c >= 1 && 10#$c <= ${#urls[@]} )); then
                    local n=$(( 10#$c - 1 ))
                    if ecohide_toggle "${urls[$n]}"; then
                        if [[ "${flags[$n]}" == "H" ]]; then
                            success "Un-hidden: ${urls[$n]}"
                        else
                            success "Hidden: ${urls[$n]}"
                        fi
                        sleep 1
                    else
                        pause
                    fi
                else
                    warn "Invalid selection."; sleep 1
                fi
                ;;
        esac
    done
}
