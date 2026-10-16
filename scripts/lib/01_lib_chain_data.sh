# =============================================================================
# lib/01_lib_chain_data.sh — Chain-data download, verify and extract for Script 01 (zone selection, manifest probe, streaming extract).
# =============================================================================
# Sourced by 01_build_new_grin_node.sh; shares its globals and log/info/warn/error helpers.
# Reads the host registry at $SCRIPT_DIR/../extensions/grinmasternodes.json ($SCRIPT_DIR is the entry script's scripts/ dir, not this lib's).
# Trap: runs with errexit off (the caller guards every call with `|| true`), so guard each file op with `|| { error ...; return 1; }`.

# =============================================================================
# [9] DOWNLOAD CHAIN DATA FROM TRUSTED SOURCE
# -----------------------------------------------------------------------------
# Selects the correct chain data source based on network + archive mode.
# Server list is loaded from extensions/grinmasternodes.json (zone-aware registry).
# User selects a zone (America/Asia/Europe/Africa); zones without dedicated
# servers for the chosen site_key automatically fall back to America.
# Site keys (site_key prefix on each hostname):
#   fullmain  — full archive, mainnet
#   prunemain — pruned,       mainnet
#   prunetest — pruned,       testnet
# Each host is checked by _check_and_add_host: the chaindata.json manifest when
# the mirror publishes one, else the legacy probes (the status file must contain
# "Sync completed.").
# If no host in the chosen zone — nor in the America fallback — passes, the user
# is prompted to enter a custom base URL (e.g. https://myserver.com) or press 0
# to return to the master script.
# Custom sources are accepted if they contain a .tar.gz in their directory
# listing (status file check is skipped for custom URLs).
# Parses the directory index to find .tar.gz and .sha256 filenames dynamically.
# Downloads both files to $GRIN_DIR with visible progress for the large tar.
# =============================================================================
_get_site_key() {
    # Returns: fullmain | prunemain | prunetest
    local network="$1" mode="$2"
    local net_short mode_short
    [[ "$network" == "mainnet" ]] && net_short="main" || net_short="test"
    [[ "$mode"    == "full"    ]] && mode_short="full" || mode_short="prune"
    echo "${mode_short}${net_short}"
}

# Freshness tolerance, per artefact. The archive and the pruned snapshots differ
# in BOTH publish cadence and in what staleness actually costs, so one constant
# cannot serve both.
#
#   prunemain / prunetest — Script 03 publishes 2x/week (max normal gap 4 days,
#       Thu->Mon) and 5 = that gap plus one day of grace. Kept TIGHT on purpose:
#       a pruned node more than the cut-through horizon (~1 week) behind tip is
#       expected to abandon block sync, fall back to txhashset state sync, and
#       DISCARD the snapshot it just downloaded — so a stale pruned archive wastes
#       the entire transfer rather than merely aging.
#
#   fullmain — Script 03 publishes biweekly (1st & 15th; max normal gap 17 days,
#       15th -> 1st across a 31-day month). The limit is sized to the RAREST
#       schedule 03's preset menu offers, not to the default, so that no option
#       an operator can pick silently ages a mirror out of client tolerance:
#         biweekly + one missed run ....... 31 days
#         monthly  + one missed run ....... 62 days  (Jul 1 -> Sep 1)
#       70 = that worst case plus 8 days of grace. Kept LOOSE because an archive
#       node syncs forward from whatever head it has: a stale archive costs extra
#       catch-up time, it is never discarded.
#
# WARNING: raising a limit here must ship AND PROPAGATE to clients before Script
# 03's cadence is relaxed to match. Clients enforce whatever version of this
# script they downloaded, so a server-side cron change that outruns this one
# makes every mirror read as stale and takes bootstrap down completely.
_max_age_for_site_key() {
    case "$1" in
        fullmain) echo 70 ;;
        *)        echo  5 ;;
    esac
}

# Read host list for a given zone+sitekey from grinmasternodes.json.
# Returns space-separated hostnames, or empty string if none found.
# Args: zone sitekey registry_path
_get_zone_hosts() {
    local zone="$1" sk="$2" reg="$3"
    [[ ! -f "$reg" ]] && return
    local result=""
    if command -v jq &>/dev/null; then
        result=$(jq -r --arg z "$zone" --arg s "$sk" \
            '(.[$z][$s] // [])[]' "$reg" 2>/dev/null | tr '\n' ' ')
    elif command -v python3 &>/dev/null; then
        result=$(python3 - "$reg" "$zone" "$sk" <<'PYEOF' 2>/dev/null
import json, sys
try:
    reg, zone, sk = sys.argv[1], sys.argv[2], sys.argv[3]
    print(' '.join(json.load(open(reg)).get(zone, {}).get(sk, [])))
except: pass
PYEOF
)
    fi
    echo "${result}" | xargs
}

# Manifest fast path — chaindata.json (schema 1), published by Script 03 step 7a.
#
# Answers in ONE request what the four legacy probes below answer in four, and
# replaces two fragile inferences:
#   · filename       — legacy path: scraped from nginx autoindex HTML (href="*.tar.gz")
#   · freshness      — legacy path: HEAD / Last-Modified, which an index.html silently
#                      poisons with its own frozen mtime
#   · archive type   — legacy path: guessed from substrings in the filename
#
# The manifest exists ONLY when the archive is complete (Script 03 deletes it at
# step 0 and writes it at step 7a), so its mere presence is the ready signal.
#
# Returns 0 = host accepted, 1 = fall through to the legacy probes. ANY doubt
# returns 1: mirrors we do not control, and older toolkit versions, have no
# manifest at all and must keep working exactly as before.
# Args: base_url  max_age_days  site_key
_try_chaindata_manifest() {
    local base="$1" max_age="$2" site_key="$3"
    local json m_tar m_sha m_key m_gen gts age_days

    command -v jq >/dev/null 2>&1 || return 1
    json=$(curl -fsSL --max-time 10 "$base/chaindata.json" 2>/dev/null) || return 1
    jq -e . >/dev/null 2>&1 <<<"$json" || { warn "$base: manifest is not valid JSON — using directory listing."; return 1; }

    m_tar=$(jq -r '.archive       // empty' <<<"$json")
    m_sha=$(jq -r '.checksum_file // empty' <<<"$json")
    m_key=$(jq -r '.site_key      // empty' <<<"$json")
    m_gen=$(jq -r '.generated_utc // empty' <<<"$json")

    # A field this path relies on but cannot answer is doubt, so it falls
    # through rather than proceeding with the check silently skipped. The
    # legacy probes below re-derive all three from the directory listing.
    if [[ -z "$m_tar" || -z "$m_sha" || -z "$m_gen" ]]; then
        warn "$base: manifest is incomplete — using directory listing."
        return 1
    fi

    # Filenames are pasted into a URL, so constrain them to a bare basename —
    # no traversal, no scheme, no absolute path. A hostile mirror can serve
    # anything it likes anyway, but it must not steer us off its own host.
    if [[ ! "$m_tar" =~ ^[A-Za-z0-9._-]+\.tar\.gz$ ]]; then
        warn "$base: manifest archive name rejected — using directory listing."
        return 1
    fi
    if [[ ! "$m_sha" =~ ^[A-Za-z0-9._-]+\.sha256$ ]]; then
        warn "$base: manifest checksum name rejected — using directory listing."
        return 1
    fi

    # Declared type must match what the caller asked for. A manifest that does
    # not state its type cannot satisfy a typed request — downloading the wrong
    # chain is only discovered after the (very large) transfer completes.
    if [[ -n "$site_key" ]]; then
        if [[ -z "$m_key" ]]; then
            warn "$base: manifest states no site_key, expected '$site_key' — using directory listing."
            return 1
        fi
        if [[ "$m_key" != "$site_key" ]]; then
            warn "$base: manifest is '$m_key', expected '$site_key' — skipping."
            return 1
        fi
    fi

    # Freshness from the manifest's own stated timestamp, not file metadata.
    # An unparseable timestamp is doubt: fall through so the legacy HEAD probes
    # enforce max_age, rather than accepting the host with no age check at all.
    gts=$(date -d "$m_gen" +%s 2>/dev/null) || gts=""
    if [[ -z "$gts" ]]; then
        warn "$base: manifest timestamp '$m_gen' unparseable — using directory listing."
        return 1
    fi
    age_days=$(( ( $(date +%s) - gts ) / 86400 ))
    if (( age_days > max_age )); then
        warn "$base: chain data is ${age_days} day(s) old (limit: ${max_age}) — skipping."
        return 1
    fi
    success "$base: manifest OK — chain data is ${age_days} day(s) old."

    # Trust but verify: the manifest promises this file exists
    curl -fsSI --max-time 10 "$base/$m_tar" >/dev/null 2>&1 \
        || { warn "$base: manifest names '$m_tar' but it is not downloadable — skipping."; return 1; }

    READY_SOURCES+=("$base")
    if [[ -z "${_HOST_TAR_NAME:-}" ]]; then
        _HOST_TAR_NAME="$m_tar"
        _HOST_SHA_NAME="$m_sha"
        # Only meaningful alongside the tar name it was published with, so it is
        # captured in the same breath. Cross-checked against the .sha256 file in
        # download_chain_data — two artefacts that must agree.
        _HOST_SHA256=$(jq -r '.sha256 // empty' <<<"$json")
        [[ "$_HOST_SHA256" =~ ^[a-fA-F0-9]{64}$ ]] || _HOST_SHA256=""
    fi
    return 0
}

# Check one host in optimised order (fail fast, fewest bytes first):
#   0. chaindata.json  → manifest fast path; answers 1-4 in one request, and a
#                        host without one falls through to the legacy probes
#   1. HEAD /          → directory Last-Modified  (1 cheap request, skip stale early)
#   2. GET  status txt → "Sync completed."        (small file, confirm node is ready)
#   3. GET  /          → directory listing        (parse tar/sha filenames)
#   3b. tar filename must match the site_key type (a fullmain client must never
#       accept a pruned tar, and vice versa)
#   4. HEAD /$tar      → precise .tar.gz age      (exact file timestamp)
# On pass: appends "https://$host" to READY_SOURCES; sets _HOST_TAR_NAME/_HOST_SHA_NAME
# from the first passing host. Returns 0=pass, 1=skip.
# Args: host  max_age_days  [site_key]
_check_and_add_host() {
    local host="$1" max_age="$2" site_key="${3:-}"
    local base="https://$host"

    # 0. Manifest fast path — falls through to the legacy probes when absent
    if _try_chaindata_manifest "$base" "$max_age" "$site_key"; then
        return 0
    fi

    # 1. HEAD / — quick directory freshness check before downloading anything
    local dir_lm dir_age=0
    dir_lm=$(curl -fsSI --max-time 8 "$base/" 2>/dev/null \
        | grep -i '^last-modified:' | cut -d' ' -f2- | tr -d '\r') || true
    if [[ -n "$dir_lm" ]]; then
        local dir_ts; dir_ts=$(date -d "$dir_lm" +%s 2>/dev/null) || true
        [[ -n "$dir_ts" ]] && dir_age=$(( ( $(date +%s) - dir_ts ) / 86400 ))
        if (( dir_age > max_age )); then
            warn "$host: directory is ${dir_age} day(s) old — skipping."; return 1
        fi
    else
        # No Last-Modified on root — server may not be reachable at all
        curl -fsSI --max-time 8 "$base/" &>/dev/null \
            || { warn "$host: unreachable — skipping."; return 1; }
    fi

    # 2. GET check_status_before_download.txt — confirm node sync is complete
    local status_content
    status_content=$(curl -fsSL --max-time 15 \
        "$base/check_status_before_download.txt" 2>/dev/null) \
        || { warn "$host: status file unavailable — skipping."; return 1; }
    echo "$status_content" | grep -q "Sync completed." \
        || { warn "$host: not synced ($(echo "$status_content" | head -1)) — skipping."; return 1; }

    # 3. GET / — directory listing to discover tar/sha filenames
    local index
    index=$(curl -fsSL --max-time 15 "$base/" 2>/dev/null) \
        || { warn "$host: directory listing failed — skipping."; return 1; }
    local tname sname
    tname=$(echo "$index" | grep -oP 'href="\K[^"]*\.tar\.gz' | grep -v '^\.\.' | head -1)
    sname=$(echo "$index" | grep -oP 'href="\K[^"]*\.sha256'  | grep -v '^\.\.' | head -1)
    [[ -z "$tname" ]] && { warn "$host: no .tar.gz in directory listing — skipping."; return 1; }

    # 3b. Verify tar filename matches the expected site_key type
    if [[ -n "$site_key" ]]; then
        local _type_ok=true
        case "$site_key" in
            fullmain)  echo "$tname" | grep -qi "full"   && echo "$tname" | grep -qi "mainnet" || _type_ok=false ;;
            prunemain) echo "$tname" | grep -qi "pruned" && echo "$tname" | grep -qi "mainnet" || _type_ok=false ;;
            prunetest) echo "$tname" | grep -qi "pruned" && echo "$tname" | grep -qi "testnet" || _type_ok=false ;;
        esac
        if [[ "$_type_ok" == false ]]; then
            warn "$host: tar '$tname' does not match expected type (${site_key}) — skipping."
            return 1
        fi
    fi

    # 4. HEAD /$tname — precise file age on the actual .tar.gz
    local last_mod age_days=0
    last_mod=$(curl -fsSI --max-time 10 "$base/$tname" 2>/dev/null \
        | grep -i '^last-modified:' | cut -d' ' -f2- | tr -d '\r')
    if [[ -n "$last_mod" ]]; then
        local fts; fts=$(date -d "$last_mod" +%s 2>/dev/null) || true
        [[ -n "$fts" ]] && age_days=$(( ( $(date +%s) - fts ) / 86400 ))
        if (( age_days > max_age )); then
            warn "$host: chain data is ${age_days} day(s) old (limit: ${max_age}) — skipping."
            return 1
        fi
        success "$host: chain data is ${age_days} day(s) old — OK."
    else
        info "$host: Last-Modified unavailable — allowing."
    fi

    READY_SOURCES+=("$base")
    # Both names must come from the SAME host: the checksum is fetched from
    # READY_SOURCES[0] using whichever names won here, so a tar name from one
    # host paired with a sha name from another is a guaranteed 404.
    if [[ -z "${_HOST_TAR_NAME:-}" ]]; then
        _HOST_TAR_NAME="$tname"
        _HOST_SHA_NAME="${sname:-}"
    fi
    return 0
}

download_chain_data() {
    local network="$1"
    local mode="$2"

    step_header "Step 9: Chain Data Source & Transfer Mode"

    # ── Ask the transfer mode FIRST ─────────────────────────────────────────────
    # Asked up front (before zone selection / host discovery) so that "Slow sync"
    # can return immediately without any source discovery — and so it stays
    # reachable even when every archive source is stale/down (the exact case where
    # host discovery would otherwise die() before this prompt was ever shown).
    if [[ "$SUPER_AUTO" != "true" ]]; then
    echo ""
    echo -e "${BOLD}  How do you want to get the chain data?${RESET}"
    echo ""
    echo -e "  ${GREEN}1${RESET}) ${BOLD}On-the-fly extraction${RESET} ${DIM}(default — stream directly, no full download)${RESET}"
    echo -e "     ${DIM}Pipes the remote archive straight into tar without saving locally.${RESET}"
    echo -e "     ${DIM}cmd: wget -O - <url> | tar -xzf -${RESET}"
    echo -e "     ${DIM}Saves temporary disk space and reduces total setup time.${RESET}"
    echo -e "     ${DIM}Auto-switches to the next source if the stream fails mid-transfer.${RESET}"
    echo -e "     ${DIM}Note: SHA256 checksum verification is skipped in this mode.${RESET}"
    echo ""
    echo -e "  ${CYAN}2${RESET}) ${BOLD}Full download first${RESET} ${DIM}(more resilient on slow connections)${RESET}"
    echo -e "     ${DIM}Downloads .tar.gz to disk (wget -c, supports resume on interruption).${RESET}"
    echo -e "     ${DIM}Verifies SHA256 checksum before extracting.${RESET}"
    echo -e "     ${DIM}Auto-switches to the next source if download fails mid-transfer.${RESET}"
    echo ""
    echo -e "  ${YELLOW}3${RESET}) ${BOLD}Slow sync${RESET} ${DIM}(no archive — start the node and sync from network peers)${RESET}"
    echo -e "     ${DIM}No download. The node syncs from genesis via its P2P peers, like a${RESET}"
    echo -e "     ${DIM}default fresh node. Slowest (hours to days) but needs no archive${RESET}"
    echo -e "     ${DIM}source and no extra disk for a .tar.gz.${RESET}"
    echo -e "     ${DIM}SHA256 / disk-space checks are not applicable.${RESET}"
    echo ""
    echo -ne "${BOLD}Choose [1/2/3] (default: 1): ${RESET}"
    fi
    local dl_choice
    if [[ "$SUPER_AUTO" == "true" ]]; then
        dl_choice=1
        info "Super Auto: on-the-fly streaming from the fastest available source."
    else
        read -r dl_choice || true
    fi
    dl_choice="${dl_choice:-1}"

    if [[ "$dl_choice" == "3" ]]; then
        SLOW_SYNC_MODE=true
        STREAM_MODE=false
        success "Slow sync selected — no archive will be downloaded."
        info "The node will sync from network peers after it starts (Step 13)."
        log "[STEP 9] Slow sync mode (no archive). network=$network mode=$mode"
        return 0
    elif [[ "$dl_choice" == "1" ]]; then
        STREAM_MODE=true
        SLOW_SYNC_MODE=false
    else
        STREAM_MODE=false
        SLOW_SYNC_MODE=false
    fi

    # Check for an existing .tar.gz in the destination directory before downloading
    local existing_tar
    existing_tar=$(find "$GRIN_DIR" -maxdepth 1 -name "*.tar.gz" 2>/dev/null | head -1)
    if [[ -n "$existing_tar" ]]; then
        warn "Existing archive found: $(basename "$existing_tar")"
        echo -e "  ${GREEN}y${RESET}) Remove and download a fresh copy"
        echo -e "  ${RED}n${RESET}) Keep it and continue"
        echo -e "  ${DIM}0${RESET}) Return to main menu"
        echo ""
        echo -ne "${BOLD}Remove existing archive? [Y/n/0]: ${RESET}"
        read -r rm_choice || true
        case "${rm_choice,,}" in
            0) exit 0 ;;
            n) info "Keeping existing archive. Proceeding..." ;;
            *)
                rm -f "$existing_tar"
                # Also clean up any leftover .sha256 so checksums don't mismatch
                find "$GRIN_DIR" -maxdepth 1 -name "*.sha256" -delete 2>/dev/null || true
                success "Existing archive removed. Downloading fresh copy..."
                ;;
        esac
    fi

    local site_key
    site_key=$(_get_site_key "$network" "$mode")

    # ── Zone selection ─────────────────────────────────────────────────────────
    local REGISTRY
    REGISTRY="$SCRIPT_DIR/../extensions/grinmasternodes.json"

    local _zone_order=(america asia europe africa)

    if [[ ! -f "$REGISTRY" ]]; then
        warn "grinmasternodes.json not found — using built-in America servers."
        SELECTED_ZONE="america"
    elif [[ "$SUPER_AUTO" == "true" ]]; then
        SELECTED_ZONE="all"
        info "Super Auto: auto-selecting the fastest fresh source across all zones."
    else
        echo ""
        echo -e "${BOLD}  Select a download zone:${RESET}"
        echo ""
        local _zi=1
        for _z in "${_zone_order[@]}"; do
            local _zh _zcount=0
            _zh=$(_get_zone_hosts "$_z" "$site_key" "$REGISTRY")
            [[ -n "$_zh" ]] && read -r -a _tmp_arr <<< "$_zh" && _zcount=${#_tmp_arr[@]}
            if (( _zcount > 0 )); then
                printf "  ${GREEN}%d${RESET}) %-10s  ${DIM}[%d server(s)]${RESET}\n" \
                    "$_zi" "${_z^}" "$_zcount"
            else
                printf "  ${CYAN}%d${RESET}) %-10s  ${DIM}[using America servers]${RESET}\n" \
                    "$_zi" "${_z^}"
            fi
            _zi=$(( _zi + 1 ))
        done
        echo -e "  ${GREEN}0${RESET}) Auto  ${DIM}(all zones, fastest available — recommended fallback)${RESET}"
        echo ""
        echo -ne "${BOLD}Zone [1]: ${RESET}"
        local _zone_choice
        read -r _zone_choice || true
        _zone_choice="${_zone_choice:-1}"

        if [[ "$_zone_choice" == "0" ]]; then
            SELECTED_ZONE="all"
        elif [[ "$_zone_choice" =~ ^[1-4]$ ]]; then
            SELECTED_ZONE="${_zone_order[$(( _zone_choice - 1 ))]}"
        else
            warn "Invalid zone '${_zone_choice}' — defaulting to America."
            SELECTED_ZONE="america"
        fi
    fi

    # ── Resolve zone to host list ───────────────────────────────────────────────
    local _resolved_hosts=""
    if [[ "$SELECTED_ZONE" == "all" ]]; then
        for _z in "${_zone_order[@]}"; do
            local _zh; _zh=$(_get_zone_hosts "$_z" "$site_key" "$REGISTRY")
            [[ -n "$_zh" ]] && _resolved_hosts+=" $_zh"
        done
    else
        _resolved_hosts=$(_get_zone_hosts "$SELECTED_ZONE" "$site_key" "$REGISTRY")
        if [[ -z "$_resolved_hosts" ]]; then
            info "No ${SELECTED_ZONE^} servers for ${site_key} — using America servers."
            _resolved_hosts=$(_get_zone_hosts "america" "$site_key" "$REGISTRY")
            SELECTED_ZONE="america"
        fi
    fi

    # ── Build hosts array (deduplicate, then shuffle) ───────────────────────────
    local hosts=()
    mapfile -t hosts < <(tr ' ' '\n' <<< "$_resolved_hosts" | grep -v '^$' | sort -u | shuf)

    # Tolerance depends on the artefact — see _max_age_for_site_key.
    local _MAX_AGE_DAYS; _MAX_AGE_DAYS=$(_max_age_for_site_key "$site_key")

    info "Checking zone hosts (sync status + file age ≤ ${_MAX_AGE_DAYS} days)..."
    local h; for h in "${hosts[@]}"; do info "  → $h"; done

    # Combined check: sync-status + directory listing + file age per host
    local _HOST_TAR_NAME="" _HOST_SHA_NAME="" _HOST_SHA256=""
    READY_SOURCES=()
    for host in "${hosts[@]}"; do
        _check_and_add_host "$host" "$_MAX_AGE_DAYS" "$site_key" || true
    done

    # Auto-fallback to ALL zones (shuffled) if the selected single zone yielded nothing.
    # (Skipped when the user already chose "all" — that pool was just exhausted.)
    if [[ ${#READY_SOURCES[@]} -eq 0 && "$SELECTED_ZONE" != "all" ]]; then
        info "No fresh hosts in ${SELECTED_ZONE^} — trying all zones (fastest available)..."
        local _all_hosts="" _fb_hosts=()
        for _z in "${_zone_order[@]}"; do
            local _zh; _zh=$(_get_zone_hosts "$_z" "$site_key" "$REGISTRY")
            [[ -n "$_zh" ]] && _all_hosts+=" $_zh"
        done
        mapfile -t _fb_hosts < <(tr ' ' '\n' <<< "$_all_hosts" | grep -v '^$' | sort -u | shuf)
        for host in "${_fb_hosts[@]}"; do
            _check_and_add_host "$host" "$_MAX_AGE_DAYS" "$site_key" || true
        done
        [[ ${#READY_SOURCES[@]} -gt 0 ]] && SELECTED_ZONE="all"
    fi

    # All known hosts failed — prompt for custom URL or exit
    if [[ ${#READY_SOURCES[@]} -eq 0 ]]; then
        echo ""
        warn "All known sources are unavailable or have chain data older than ${_MAX_AGE_DAYS} days."
        echo ""
        while true; do
            echo -e "  Enter a ${BOLD}custom base URL${RESET}  ${DIM}(e.g. https://example.com)${RESET}"
            echo -e "  ${GREEN}0${RESET} — return to master script"
            echo ""
            echo -ne "${DIM}[Custom URL / 0 = main menu]: ${RESET}"
            local custom_url
            read -r custom_url || true
            case "${custom_url:-}" in
                0)
                    exit 0
                    ;;
                "")
                    warn "No URL entered — try again or press 0 to return."
                    echo ""
                    continue
                    ;;
                *)
                    custom_url="${custom_url%/}"   # strip trailing slash
                    info "Checking custom source: $custom_url"
                    local custom_status
                    custom_status=$(curl -fsSL --max-time 15 "${custom_url}/check_status_before_download.txt" 2>/dev/null) || true
                    if echo "$custom_status" | grep -q "Sync completed."; then
                        READY_SOURCES=("$custom_url")
                        success "Custom source ready: $custom_url"
                        break
                    fi
                    # Status file absent or not ready — check directory listing for files
                    local custom_index
                    custom_index=$(curl -fsSL --max-time 15 "${custom_url}/" 2>/dev/null) || true
                    if echo "$custom_index" | grep -q '\.tar\.gz'; then
                        READY_SOURCES=("$custom_url")
                        info "Custom source has chain data files — proceeding without status check."
                        break
                    fi
                    warn "No usable chain data found at $custom_url"
                    warn "Check the URL is reachable and contains .tar.gz files, then try again."
                    echo ""
                    ;;
            esac
        done
    fi

    # Filenames already discovered during per-host checks above
    local tar_name sha_name
    tar_name="$_HOST_TAR_NAME"
    sha_name="$_HOST_SHA_NAME"

    [[ -z "$tar_name" ]] && die "No .tar.gz filename found from any ready source."
    [[ -z "$sha_name" ]] && die "No .sha256 filename found from any ready source."

    TAR_FILE="$GRIN_DIR/$tar_name"
    SHA_FILE="$GRIN_DIR/$sha_name"

    # ── Transfer mode already chosen at the top of this function ────────────────
    # STREAM_MODE=true  → on-the-fly streaming (handled later by stream_extract_chain_data)
    # STREAM_MODE=false → full download below. (Slow sync already returned early.)
    if [[ "$STREAM_MODE" == "true" ]]; then
        info "On-the-fly extraction selected. Streaming will begin at Step 10."
        log "[STEP 9] On-the-fly mode. zone=$SELECTED_ZONE sources=(${READY_SOURCES[*]}) tar=$tar_name"
        return 0
    fi

    # ── Full download mode ─────────────────────────────────────────────────────
    info "Downloading checksum file: $sha_name"
    curl -fsSL "${READY_SOURCES[0]}/$sha_name" -o "$SHA_FILE" \
        || die "Failed to download checksum file."
    success "Checksum saved: $SHA_FILE"

    # Cross-check the two artefacts the mirror published. Step 10 verifies the
    # tarball against this .sha256 file; that proves the download is intact, but
    # not that the .sha256 itself is the one that belongs to this archive. When
    # a manifest supplied a digest, the two must agree — a mismatch means a
    # stale .sha256 left beside a fresh manifest, or one of the two was altered.
    # (Absent for legacy/no-manifest mirrors: skipped, not failed.)
    if [[ -n "${_HOST_SHA256:-}" ]]; then
        local file_sha
        file_sha=$(awk '{print $1; exit}' "$SHA_FILE" 2>/dev/null || echo "")
        if [[ "${file_sha,,}" != "${_HOST_SHA256,,}" ]]; then
            die "Checksum file disagrees with the manifest on ${READY_SOURCES[0]}.
  manifest : $_HOST_SHA256
  .sha256  : ${file_sha:-<unreadable>}
This mirror is inconsistent — do not extract its archive. Re-run and pick another source."
        fi
        success "Manifest and checksum file agree."
    fi

    info "Downloading chain data: $tar_name"
    info "(Large file — progress shown below. Auto-switches source on failure.)"
    local dl_ok=false
    local src_num=0 total_src=${#READY_SOURCES[@]}
    for src_base in "${READY_SOURCES[@]}"; do
        src_num=$(( src_num + 1 ))
        info "Trying source $src_num/$total_src: $src_base"
        # -e background=off: same fix as Step 10 — without it wget forks to the background on
        # this target box and writes its progress bar to a wget-log file instead of the screen.
        if wget -c -e background=off --progress=bar:force -O "$TAR_FILE" "$src_base/$tar_name"; then
            dl_ok=true
            success "Chain data downloaded from $src_base"
            break
        else
            warn "Download failed from $src_base."
            rm -f "$TAR_FILE"
            if [[ $src_num -lt $total_src ]]; then
                warn "Switching to source $((src_num + 1))/$total_src..."
            fi
        fi
    done
    [[ "$dl_ok" == "true" ]] || die "Chain data download failed from all available sources."

    success "Chain data downloaded: $TAR_FILE"
    log "[STEP 9] Downloaded $tar_name (full download mode) zone=$SELECTED_ZONE"
}

# =============================================================================
# [10] VERIFY SHA256 CHECKSUM
# -----------------------------------------------------------------------------
# Runs 'sha256sum -c' against the downloaded .sha256 file to verify the
# integrity of the chain data archive. If verification fails, shows error with
# guidance and waits for user before exiting — tar must NOT be extracted on mismatch.
# =============================================================================
verify_checksum() {
    step_header "Step 10: SHA256 Verification"
    info "Running: sha256sum -c $(basename "$SHA_FILE")"

    (cd "$GRIN_DIR" && sha256sum -c "$(basename "$SHA_FILE")" 2>&1 | tee -a "$LOG_FILE") \
        || die "SHA256 checksum FAILED. The download may be corrupted. Exiting."

    success "Checksum verification passed."
    log "[STEP 10] Checksum OK."
}

# =============================================================================
# [11] VERIFY SUFFICIENT DISK SPACE ON /
# -----------------------------------------------------------------------------
# Reads the size of the downloaded .tar.gz file, then checks that the
# currently available free space on / is at least: tar_size + 20%.
# This ensures there is enough headroom to fully extract the archive.
# If space is insufficient, shows error with how much is needed and waits for user.
# =============================================================================
check_disk_space() {
    step_header "Step 11: Disk Space Check"

    local tar_size
    tar_size=$(stat -c%s "$TAR_FILE")

    # Required free = tar_size * 1.2  (bash integer: tar + tar/5)
    local required=$(( tar_size + tar_size / 5 ))

    # Available bytes on /
    local available
    available=$(df -B1 / | awk 'NR==2 {print $4}')

    # Human-readable
    local tar_hr req_hr avail_hr
    tar_hr=$(numfmt   --to=iec-i --suffix=B "$tar_size"  2>/dev/null || echo "${tar_size} B")
    req_hr=$(numfmt   --to=iec-i --suffix=B "$required"  2>/dev/null || echo "${required} B")
    avail_hr=$(numfmt --to=iec-i --suffix=B "$available" 2>/dev/null || echo "${available} B")

    info "Archive size        : $tar_hr"
    info "Required free (×1.2): $req_hr"
    info "Available on /      : $avail_hr"

    if [[ $available -lt $required ]]; then
        die "Insufficient disk space. Need $req_hr free, only $avail_hr available. Free up space and retry."
    fi
    success "Disk space check passed."
    log "[STEP 11] tar=$tar_size required=$required available=$available"
}

# =============================================================================
# HELPER: PROMPT BEFORE OVERWRITING EXISTING CHAIN DATA
# -----------------------------------------------------------------------------
# If $GRIN_DIR/chain_data already exists, asks the user whether to remove it
# before extraction.  Shared by extract_chain_data() and stream_extract_chain_data().
# =============================================================================
_prompt_remove_chain_data() {
    [[ -d "$GRIN_DIR/chain_data" ]] || return 0
    warn "Existing chain_data directory found: $GRIN_DIR/chain_data"
    echo -e "  ${GREEN}Y${RESET}) Remove and extract fresh  ${DIM}(default)${RESET}"
    echo -e "  ${RED}n${RESET}) Keep it (existing files may be overwritten)"
    echo -e "  ${DIM}0${RESET}) Return to main menu"
    echo ""
    echo -ne "${BOLD}Remove existing chain_data? [Y/n/0]: ${RESET}"
    read -r rm_choice || true
    case "${rm_choice,,}" in
        n) info "Keeping existing chain_data (existing files may be overwritten)..." ;;
        0) exit 0 ;;
        *) info "Removing existing chain_data..."
           rm -rf "$GRIN_DIR/chain_data"
           success "Existing chain_data removed. Starting fresh extraction..." ;;
    esac
}

# =============================================================================
# [12] EXTRACT CHAIN DATA INTO NODE DIRECTORY
# -----------------------------------------------------------------------------
# After successful extraction, removes the .tar.gz and .sha256 to reclaim space.
# Shows error with guidance if extraction fails (e.g. corrupted archive or disk error).
# =============================================================================
extract_chain_data() {
    step_header "Step 12: Extract Chain Data"

    _prompt_remove_chain_data

    info "Extracting $(basename "$TAR_FILE") → $GRIN_DIR ..."

    tar -xzf "$TAR_FILE" -C "$GRIN_DIR" 2>&1 | tee -a "$LOG_FILE" \
        || die "Extraction failed. Check disk space and file integrity."

    success "Extraction complete."
    info "Removing downloaded archive to free disk space..."
    rm -f "$TAR_FILE" "$SHA_FILE"
    success "Archive files removed."
    log "[STEP 12] Extraction complete. Archives removed."
}

# =============================================================================
# [STREAM] EXTRACT CHAIN DATA ON-THE-FLY  (no local archive)
# -----------------------------------------------------------------------------
# Pipes the remote .tar.gz directly into tar without saving it locally:
#   wget -O - <url> | tar -xzf - -C "$GRIN_DIR"
# All ready sources from READY_SOURCES are tried in order. On failure, any
# partially extracted chain_data directory is removed before retrying.
# Steps 10 (SHA256) and 11 (disk space) are skipped in this mode.
# =============================================================================
stream_extract_chain_data() {
    step_header "Step 10: Extract Chain Data (On-the-fly)"

    local tar_name="${TAR_FILE##*/}"

    _prompt_remove_chain_data

    local stream_ok=false
    local src_num=0 total_src=${#READY_SOURCES[@]}
    for src_base in "${READY_SOURCES[@]}"; do
        src_num=$(( src_num + 1 ))
        local tar_url="$src_base/$tar_name"
        info "Source $src_num/$total_src: $tar_url"
        info "Running: wget -e background=off --progress=bar:force -O - \"$tar_url\" | tar -xzf - -C \"$GRIN_DIR\""
        info "wget draws a live transfer bar (size, %, speed, ETA) as the stream downloads and extracts."
        [[ $total_src -gt 1 ]] && warn "If this stream fails mid-transfer, the next source will be tried automatically."
        echo ""
        log "[STEP 10] Streaming from $tar_url"
        # -e background=off is THE fix (confirmed 2026-06-02 by isolating the command on the
        # target box): otherwise wget forks to the background and writes its progress (bar, %,
        # speed, ETA) to a "wget-log" FILE instead of the terminal — which is why NO flag
        # (bar:force, --show-progress, dot, or pv) ever showed anything on screen, in or out of
        # tmux. Symptom without it: wget prints "Redirecting output to 'wget-log'" and the
        # terminal stays blank while tar's output still shows. With -e background=off the bar
        # renders live. (No wgetrc 'background=on' exists; wget backgrounds when it lands in a
        # process group without the controlling tty — this flag defeats that unconditionally and
        # is a harmless no-op otherwise.)
        #   --progress=bar:force : draw the bar even though stdout is piped (-O -).
        #   NO -q                : -q suppresses the bar.
        #   tar -xzf - (no -v)   : silent tar so the \r-redrawn bar isn't shredded by filenames.
        if wget -e background=off --progress=bar:force -O - "$tar_url" \
                | tar -xzf - -C "$GRIN_DIR"; then
            stream_ok=true
            break
        else
            warn "Stream failed from $src_base."
            if [[ -d "$GRIN_DIR/chain_data" ]]; then
                warn "Removing partial extraction..."
                rm -rf "$GRIN_DIR/chain_data"
            fi
            if [[ $src_num -lt $total_src ]]; then
                warn "Switching to source $((src_num + 1))/$total_src..."
                echo ""
            fi
        fi
    done

    [[ "$stream_ok" == "true" ]] \
        || die "On-the-fly extraction failed from all available sources. Retry or choose full download mode."

    success "On-the-fly extraction complete."
    log "[STEP 10] On-the-fly extraction complete."
}
