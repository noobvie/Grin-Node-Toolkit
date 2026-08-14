# =============================================================================
# 052_lib_vendor.sh — Accio (script 052): vendored-tree integrity + upstream watch
# =============================================================================
# Sourced by 052_grin_accio.sh (menu key 5) and by 052_lib_build.sh (every
# build). Inherits colours, info/warn/error/success/pause/log and the ACC_*
# variables set by acc_set_network. No shebang, no `set -e` of its own.
#
#   PUBLIC ENTRIES
#     acv_vendor_menu               the "5) Check upstream" screen
#     acv_verify_vendor [--quiet]   OFFLINE. vendor/ vs vendor/SHA256SUMS.
#                                   Returns 1 on one changed byte — this is
#                                   what the build gates on.
#     acv_check_upstream            THE ONLY NETWORK ACTION IN 052. Reports
#                                   what upstream changed since the pin and
#                                   changes nothing at all.
#     acv_pin_report                print the pin record, no I/O past reading it
#
# ─── The two halves, and why they must stay apart ────────────────────────────
# S0 vendored two upstreams and pinned them. A pin that is never checked is a
# comment, so this file is the checker. It has exactly two jobs and they pull
# in opposite directions:
#
#   VERIFY   runs on every build, touches no network, and FAILS THE BUILD.
#   CHECK    talks to github, runs only when an operator asks, and is
#            incapable of changing anything — no write ever lands outside a
#            scratch directory and a report file.
#
# Keeping them apart is the whole design. An "update check" that can also
# update is a supply-chain hole with a menu entry attached; put it on a timer
# and it is a supply-chain hole with a cron schedule attached. Accio is a
# SELF-CUSTODIAL wallet: whatever this box serves is what signs the visitor's
# transactions. Upstream code reaches that page only by a human re-vendoring,
# re-pinning and committing it in this repo — never by anything running here.
#
# So: nothing in this file installs a timer, and `acv_verify_vendor` is
# asserted offline at runtime (`_acv_assert_offline_path`) rather than trusted,
# the same way `_acb_assert_offline` guards the build.
#
# ─── What "verified" means, precisely ────────────────────────────────────────
# Three checks, in order, because each one is worthless without the one before:
#
#   1. PINNED_SHA carries the manifest's own sha256. Check it first — a
#      tamperer who edits vendor/ and then regenerates SHA256SUMS defeats
#      step 2 completely, and step 1 is the only thing that notices.
#   2. `sha256sum -c` every path the manifest lists (274 across both trees).
#   3. The file SET, both ways. `sha256sum -c` cannot see a file that was
#      ADDED — it only checks what is listed. An added file is the more
#      interesting attack anyway: the build copies the whole tree, so a
#      dropped-in script ships without a single listed hash changing.
#
# Only all three together mean anything. Step 1 alone trusts the tree, step 2
# alone trusts the manifest, step 3 alone trusts nothing but proves nothing.
#
# Step 3 reads paths by COLUMN, so step 2 is preceded by a parse guard: a
# manifest line that GNU sha256sum escaped (leading `\`, for a filename holding
# a backslash or newline) shifts that column and would surface as a phantom
# missing/extra pair instead of as the parse problem it is.
#
# ⚠ NEVER "fix" a verify failure on the VPS by regenerating SHA256SUMS. The
#   manifest is a repo artefact produced at vendor time from a clean archive;
#   regenerating it on the target certifies whatever is on the target, which
#   is precisely the thing being questioned. A legitimate upstream bump is a
#   re-vendor in this repo, by hand, following the recipe at the bottom of
#   web/052_accio/PINNED_SHA — and note the CRLF trap recorded there, which
#   has already produced a "pinned, byte-exact" tree that was neither, twice.
#
# ─── What the upstream check reports, and what it deliberately does not ──────
# It never checks out a working tree: the scratch repository is created with
# `init --bare`, so not one byte of upstream code is ever materialised as a
# file on this box. It reads three things out of that bare repo:
#
#   • is the pinned commit still IN upstream's history? A "no" means a
#     force-push or a rewrite, which is a security event, not an update.
#   • what landed since the pin (subjects + changed paths).
#   • which changed paths our patches/ overlay replaces. Those are the ONLY
#     files that can conflict on a bump, and keeping the overlay small is what
#     keeps this review cheap — see patches/README.md.
#
# It does not judge whether an update is worth taking, and it must not: that
# call needs a human reading a diff of a wallet's cryptography.
# =============================================================================

# ─── Tunables ────────────────────────────────────────────────────────────────
ACV_GIT_BIN="${ACV_GIT_BIN:-git}"

# How many commit subjects to print inline. The full `--stat` always goes to
# the report file regardless — a bump with 300 commits should not scroll the
# one line that matters (the flagged overlay files) off the operator's screen.
ACV_LOG_LINES="${ACV_LOG_LINES:-25}"

# =============================================================================
# Paths — resolved lazily so the lib also works if sourced before a network is
# selected (verify is network-agnostic; only the report path uses ACC_DIR).
# =============================================================================

_acv_product_src() {
    if [[ -n "${ACC_PRODUCT_SRC:-}" ]]; then echo "$ACC_PRODUCT_SRC"; return 0; fi
    local root
    root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
    echo "$root/web/052_accio"
}

_acv_vendor_dir()  { echo "$(_acv_product_src)/vendor"; }
_acv_manifest()    { echo "$(_acv_product_src)/vendor/SHA256SUMS"; }
_acv_pin_file()    { if [[ -n "${ACC_PINNED_SHA:-}" ]]; then echo "$ACC_PINNED_SHA"; else echo "$(_acv_product_src)/PINNED_SHA"; fi; }
_acv_patches_dir() { if [[ -n "${ACC_PATCHES_SRC:-}" ]]; then echo "$ACC_PATCHES_SRC"; else echo "$(_acv_product_src)/patches"; fi; }

# PINNED_SHA is KEY="VALUE", one per line, and the header calls it
# shell-sourceable — but we read it, never source it. Sourcing an unset key
# leaves the PREVIOUS value resolving (the trap Script 01's source build hit),
# and a pin record is the last file where a stale value should survive.
_acv_pin() {
    local key="$1" default="${2:-}" v=""
    local f; f="$(_acv_pin_file)"
    if [[ ! -f "$f" ]]; then echo "$default"; return 0; fi
    v=$(grep -m1 -E "^${key}=" "$f" 2>/dev/null | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//') || true
    if [[ -n "$v" ]]; then echo "$v"; else echo "$default"; fi
}

_acv_fmt_bytes() {
    local b="${1:-0}"
    if [[ ! "$b" =~ ^[0-9]+$ ]]; then echo "$b"; return 0; fi
    if   (( b >= 1048576 )); then awk -v b="$b" 'BEGIN{printf "%.2f MiB", b/1048576}'
    elif (( b >= 1024 ));    then awk -v b="$b" 'BEGIN{printf "%.1f KiB", b/1024}'
    else echo "${b} B"; fi
}

# =============================================================================
# Guard — the verify path may not reach the network
# =============================================================================

# The build calls acv_verify_vendor, and the build's whole point is that it is
# offline (052_lib_build.sh, "WHY THIS FILE EXISTS"). That property now spans
# two files, so it is asserted at runtime here too: an edit that gives the
# verify chain a fetcher fails the build instead of quietly weakening the pin.
#
# It greps the PARSED function bodies (`declare -f`), not the file — this file
# is *supposed* to contain a fetcher, in acv_check_upstream, which is exempted
# below and is never called by a build. Bash discards comments when it parses a
# function, so comments cannot trip it.
#
# ⚠ DENY-LIST, never an allow-list. It used to name the nine functions in the
#   verify chain, and that made the guard blind to the exact edit it exists to
#   catch: a TENTH helper. Verified — define `_acv_helper` with a downloader in
#   it, call it from acv_verify_vendor, and the old guard passed clean, because
#   a name nobody added to the list is unguarded by construction. It now
#   enumerates every acv_*/_acv_* function actually defined and skips only
#   ACV_OFFLINE_EXEMPT. Adding a helper is guarded by default; exempting one is
#   a visible edit that shows up in review.
#
# ⚠ A MESSAGE STRING can trip it: the pattern only wants a command position,
#   but ` <name> ` inside a quoted string looks identical. That is on purpose
#   and it is cheap to live with — a checked function must not name these tools
#   in its output either. Point the operator at PINNED_SHA's recipe instead of
#   spelling a command out here.
#
# It is defence in depth, not a sandbox. A determined edit can still reach the
# network through something the pattern does not name; this catches the
# careless one, which is the kind that actually happens.

# Allowed to reach the network — plus the detector itself, whose own pattern
# string necessarily names the tools it forbids. Everything else matching
# `_?acv_` is checked.
ACV_OFFLINE_EXEMPT=(acv_check_upstream _acv_check_one _acv_assert_offline_path)

_acv_assert_offline_path() {
    local pat hit="" fn body e skip checked=0
    # Split across concatenations for the same reason 052_lib_build.sh does it:
    # a plain grep of this lib for the two common downloaders must return only
    # the update-check function, not the detector that exists to forbid them.
    # ACV_GIT_BIN is in the pattern because this lib never spells the tool out
    # — _acv_check_one invokes it through the variable, so a literal-name-only
    # detector would miss the one form an edit here is most likely to copy.
    # /dev/tcp and /dev/udp are in it because they need no external binary at
    # all: bash opens those sockets itself, and a tool-name-only pattern misses
    # every one of them.
    pat="(^|[;&|(]|[[:space:]])(gi""t|wg""et|cu""rl|nc|scp|sftp|rsync|ftp|pyth""on3?|pe""rl)[[:space:]]"
    pat="${pat}|ACV_GIT_BIN|/dev/tc""p/|/dev/ud""p/"
    while IFS= read -r fn; do
        if [[ -z "$fn" ]]; then continue; fi
        skip=0
        for e in "${ACV_OFFLINE_EXEMPT[@]}"; do
            if [[ "$fn" == "$e" ]]; then skip=1; break; fi
        done
        if (( skip == 1 )); then continue; fi
        checked=$((checked + 1))
        body=$(declare -f "$fn" | grep -E "$pat" || true)
        if [[ -n "$body" ]]; then hit="${hit}${fn}: ${body}"$'\n'; fi
    done < <(declare -F | awk '{print $3}' | grep -E '^_?acv_' || true)

    # A guard that checked nothing would return "clean" and certify a chain
    # nobody looked at. This lib defines a dozen matching functions, so a count
    # this low means the enumeration broke, not that the tree is fine.
    if (( checked < 5 )); then
        error "The offline guard enumerated only $checked function(s) — it is"
        error "  broken, so nothing here can be trusted to be offline."
        return 1
    fi
    if [[ -n "$hit" ]]; then
        error "The integrity check must never reach the network. Found:"
        echo "$hit" >&2
        return 1
    fi
    return 0
}

# =============================================================================
# Integrity — offline, and the gate the build runs through
# =============================================================================

# Manifest lines are `<64 hex><space>[*| ]<path>`, so the path begins at column
# 67. Cut by column, never by field: two vendored files have spaces in their
# names ("third-party libraries instructions.txt", "MWC Wallet license.txt")
# and awk would truncate both to something that exists nowhere.
_acv_manifest_paths() {
    cut -c67- < "$1" | LC_ALL=C sort
}

# Everything under vendor/ except the manifest itself, which by construction
# cannot list its own hash.
#
# `! -type d`, deliberately NOT `-type f`. A symlink is the cheapest way to add
# content the manifest never lists: `-type f` would not list it, `sha256sum -c`
# only checks listed paths, and the build's `cp -a` preserves it — so it ships.
# The manifest lists 274 regular files and upstream has no symlink, FIFO or
# device node, so anything that is not a directory and not listed is an extra
# and must fail. (A symlink REPLACING a listed file is already caught: step 2
# follows it and hashes the target.)
_acv_tree_paths() {
    ( cd "$1" && find . ! -type d ! -path ./SHA256SUMS | sed 's|^\./||' | LC_ALL=C sort )
}

# acv_verify_vendor [--quiet]
#   0 = the vendored tree is byte-identical to what was pinned at vendor time
#   1 = it is not, or the check could not be completed (treat both as failure)
acv_verify_vendor() {
    local quiet=0
    if [[ "${1:-}" == "--quiet" ]]; then quiet=1; fi

    _acv_assert_offline_path || return 1

    local vdir man pin
    vdir="$(_acv_vendor_dir)"; man="$(_acv_manifest)"; pin="$(_acv_pin_file)"

    if [[ ! -d "$vdir" ]]; then error "Vendored tree missing: $vdir"; return 1; fi
    if [[ ! -f "$man" ]]; then
        error "Checksum manifest missing: $man"
        error "Without it nothing here is pinned. Restore it from the repo."
        return 1
    fi
    if ! command -v sha256sum >/dev/null 2>&1; then
        error "sha256sum not found — the vendored tree cannot be verified."
        return 1
    fi

    local fails=0

    # ── 1. the manifest itself ───────────────────────────────────────────────
    # First, because a regenerated manifest makes step 2 agree with anything.
    local want_man have_man
    want_man="$(_acv_pin VENDORED_MANIFEST_SHA256 "")"
    have_man=$(sha256sum "$man" | cut -d' ' -f1) || have_man=""
    if [[ ! -f "$pin" ]]; then
        # Distinct from the next branch on purpose. _acv_pin returns the default
        # for a missing FILE and a missing KEY alike, and reporting both as
        # "carries no VENDORED_MANIFEST_SHA256" sends the operator hunting for a
        # key inside a file that is not there. Both are fatal, so both are
        # errors — this one used to print as a warning.
        error "There is no pin record at $pin"
        error "  Nothing certifies the manifest, so the manifest certifies only"
        error "  itself. Restore the file from the repo; do not re-pin."
        fails=$((fails + 1))
    elif [[ -z "$want_man" ]]; then
        error "$pin carries no VENDORED_MANIFEST_SHA256 — the manifest is"
        error "  unpinned, so it certifies only itself. Restore the key."
        fails=$((fails + 1))
    elif [[ "$have_man" != "$want_man" ]]; then
        error "The checksum manifest does not match its pin."
        error "  expected  $want_man"
        error "  found     $have_man"
        error "  ⚠ A regenerated manifest agrees with a tampered tree. Do not"
        error "    re-pin to make this pass — re-vendor per the recipe in PINNED_SHA."
        fails=$((fails + 1))
    fi

    # ── 2. every listed file ─────────────────────────────────────────────────
    # First: is the manifest even parseable the way step 3 reads it? GNU
    # sha256sum ESCAPES any line whose filename contains a backslash or a
    # newline — it prefixes the line with `\` and escapes the character, which
    # shifts the path one column right and makes the column cut in
    # _acv_manifest_paths wrong for that line. That still fails closed (the
    # mis-cut path lands in BOTH the missing and the extra list), but it fails
    # as a confusing pair of phantom files rather than as the parse problem it
    # is. Upstream has no such filename; if one ever appears, say so plainly.
    if grep -q '^\\' "$man"; then
        error "The manifest contains escaped filename lines (leading backslash)."
        error "  Those carry a backslash or newline in the filename, which the"
        error "  column-based path reader below would mis-parse. Re-vendor and"
        error "  teach _acv_manifest_paths to unescape before trusting this."
        fails=$((fails + 1))
    fi

    local out rc=0
    out=$( cd "$vdir" && sha256sum -c --quiet SHA256SUMS 2>&1 ) || rc=$?
    if (( rc != 0 )); then
        local n
        n=$(printf '%s\n' "$out" | grep -c . || true)
        error "Vendored file check FAILED — $n line(s) from the checker:"
        printf '%s\n' "$out" | head -40 >&2
        if (( n > 40 )); then error "  … $((n - 40)) more (re-run for the full list)"; fi
        fails=$((fails + 1))
    fi

    # ── 3. the file set, both directions ─────────────────────────────────────
    # The one thing step 2 structurally cannot see: a file that was ADDED. The
    # build stages the whole tree, so an unlisted file ships.
    local extra missing
    extra=$(LC_ALL=C comm -13 <(_acv_manifest_paths "$man") <(_acv_tree_paths "$vdir")) || extra=""
    missing=$(LC_ALL=C comm -23 <(_acv_manifest_paths "$man") <(_acv_tree_paths "$vdir")) || missing=""
    if [[ -n "$extra" ]]; then
        error "Files present in vendor/ that the manifest does not list:"
        printf '%s\n' "$extra" | sed 's/^/    + /' >&2
        error "  Nothing may live under vendor/ that was not received from"
        error "  upstream. Our own changes belong in patches/."
        fails=$((fails + 1))
    fi
    if [[ -n "$missing" ]]; then
        error "Files the manifest lists that are not in vendor/:"
        printf '%s\n' "$missing" | sed 's/^/    - /' >&2
        fails=$((fails + 1))
    fi

    if (( fails > 0 )); then
        error "Vendored tree NOT verified ($fails check(s) failed)."
        log "acv_verify_vendor: FAIL ($fails)"
        return 1
    fi

    # ── report ───────────────────────────────────────────────────────────────
    local count bytes
    # `grep -c` prints 0 AND exits 1 on no match, so `|| true` is the correct
    # guard here — `|| echo 0` would append a second line to the count.
    count=$(_acv_manifest_paths "$man" | grep -c . || true)
    bytes=$( ( cd "$vdir" && find . -type f ! -path ./SHA256SUMS -printf '%s\n' 2>/dev/null ) \
             | awk '{s+=$1} END {print s+0}' ) || bytes=""
    if (( quiet == 1 )); then
        info "Vendored tree verified — $count files, manifest ${have_man:0:8}…"
    else
        success "Vendored tree verified."
        echo -e "  ${DIM}manifest    ${have_man}${RESET}"
        echo -e "  ${DIM}files       ${count}${RESET}"
        if [[ -n "$bytes" && "$bytes" != "0" ]]; then
            local want_bytes; want_bytes="$(_acv_pin VENDORED_BYTES "")"
            local tag=""
            if [[ -n "$want_bytes" && "$want_bytes" != "$bytes" ]]; then tag="  ⚠ pin says $want_bytes"; fi
            echo -e "  ${DIM}bytes       ${bytes}  ($(_acv_fmt_bytes "$bytes"))${tag}${RESET}"
        fi
        echo -e "  ${DIM}wallet      $(_acv_pin UPSTREAM_SHA8 unknown)  v$(_acv_pin UPSTREAM_VERSION unknown)${RESET}"
        echo -e "  ${DIM}build spec  $(_acv_pin STANDALONE_SHA8 unknown)${RESET}"
    fi
    log "acv_verify_vendor: OK ($count files)"
    return 0
}

# =============================================================================
# Upstream check — the only thing in 052 that opens a socket to the internet
# =============================================================================

# The overlay, expressed the way upstream names its files. Derived from
# patches/ at run time rather than listed: the overlay is expected to grow (S9
# deletions, later fixes), and a hand-kept copy would be wrong on the first
# session that forgot to update it — which is the session where a missed
# conflict silently reverts a patch.
#
# Two kinds, and only one of them can conflict:
#   replaced  a patch file that shadows a vendored file. An upstream change to
#             one of these is the whole cost of a bump.
#   added     a patch file with no upstream counterpart — currently one,
#             `MWC Wallet license.txt` (upstream's LICENSE copied under
#             public_html so the About credit has a link target inside the
#             served root). Upstream can never "change" it, so it must not be
#             cross-referenced. It is why upstream's root `LICENSE` is in the
#             wallet's watched list instead: if that changes, our copy is
#             stale and the credit misstates the licence.
#   $1 = replaced (default) | added
_acv_patched_upstream_paths() {
    local mode="${1:-replaced}" pdir vdir rel
    pdir="$(_acv_patches_dir)/public_html"
    vdir="$(_acv_vendor_dir)/upstream-wallet/public_html"
    if [[ ! -d "$pdir" ]]; then return 0; fi
    while IFS= read -r rel; do
        if [[ -z "$rel" ]]; then continue; fi
        if [[ -e "$vdir/$rel" ]]; then
            if [[ "$mode" == "replaced" ]]; then echo "public_html/$rel"; fi
        else
            if [[ "$mode" == "added" ]]; then echo "public_html/$rel"; fi
        fi
    done < <( cd "$pdir" && find . -type f | sed 's|^\./||' ) | LC_ALL=C sort
}

# One upstream. Bare repo, read-only inspection, no working tree ever created.
#   $1 label  $2 url  $3 pinned sha  $4 scratch root  $5 report file
#   $6 "patches" to cross-reference the overlay, anything else to skip it
#   $7 pipe-separated extra paths worth flagging for this repo
_acv_check_one() {
    local label="$1" url="$2" sha="$3" root="$4" report="$5" xref="$6" watched="${7:-}"
    local dir="$root/${label}"

    echo ""
    echo -e "${BOLD}── $label ${RESET}${DIM}$url${RESET}"
    echo -e "  ${DIM}pinned at ${sha}${RESET}"

    # ── the URL is data from a file, so treat it as data ─────────────────────
    # `remote add origin "$url"` will happily accept `ext::sh -c '…'`, and git's
    # ext transport RUNS THAT COMMAND at fetch time. `file://` and scp-style
    # `host:path` are the same class of surprise. Editing PINNED_SHA already
    # implies write access to the repo, but there is no reason a bad pin should
    # escalate from "fetches the wrong repository" to "executes code as root".
    # Plain https, nothing else.
    if [[ ! "$url" =~ ^https://[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)+/?$ ]]; then
        error "Refusing to fetch: the pin record's URL for '$label' is not a"
        error "  plain https clone URL."
        error "    $url"
        error "  Fix PINNED_SHA in the repo. Nothing was fetched."
        return 1
    fi

    mkdir -p "$dir" || { error "Cannot create $dir"; return 1; }
    if ! "$ACV_GIT_BIN" init --bare -q "$dir" 2>/dev/null; then
        error "Could not create a scratch repository in $dir"
        return 1
    fi
    "$ACV_GIT_BIN" -C "$dir" remote add origin "$url" || return 1

    info "Fetching (read-only, into $dir) …"
    # All branches, full history — a shallow fetch cannot contain the pin, and
    # "is the pin still reachable" is the single most important answer here.
    if ! "$ACV_GIT_BIN" -C "$dir" fetch --no-tags -q origin '+refs/heads/*:refs/remotes/origin/*' 2>&1; then
        error "Fetch failed. No network, or upstream moved: $url"
        error "Nothing was changed."
        return 1
    fi
    if ! "$ACV_GIT_BIN" -C "$dir" remote set-head origin -a >/dev/null 2>&1; then
        error "Upstream advertises no default branch — cannot compare."
        return 1
    fi
    local head_ref head_sha
    head_ref=$("$ACV_GIT_BIN" -C "$dir" symbolic-ref --short refs/remotes/origin/HEAD) || return 1
    head_sha=$("$ACV_GIT_BIN" -C "$dir" rev-parse "$head_ref") || return 1

    # ── is the pin still in upstream's history? ──────────────────────────────
    # A "no" is not an update, it is a rewritten history. Report it as the
    # security event it is and stop: a diff against a rewritten branch is
    # meaningless, and taking it would mean adopting code nobody reviewed.
    if ! "$ACV_GIT_BIN" -C "$dir" cat-file -e "${sha}^{commit}" 2>/dev/null; then
        echo ""
        error "⚠ THE PINNED COMMIT IS NOT REACHABLE FROM ANY UPSTREAM BRANCH."
        error "  $sha"
        error "  Upstream force-pushed, rewrote history, or deleted the branch"
        error "  it was on. This is not an update — investigate before trusting"
        error "  anything from this repository again."
        error "  Our copy is unaffected: vendor/ is ours and is byte-pinned."
        {
            echo "== $label — PINNED COMMIT NOT REACHABLE =="
            echo "url        $url"
            echo "pinned     $sha"
            echo "head       $head_ref $head_sha"
        } >> "$report"
        return 1
    fi

    if [[ "$head_sha" == "$sha" ]]; then
        success "No changes — upstream $head_ref is still exactly our pin."
        { echo "== $label — no changes =="; echo "pinned/head $sha"; } >> "$report"
        return 0
    fi

    local n
    n=$("$ACV_GIT_BIN" -C "$dir" rev-list --count "${sha}..${head_ref}") || n="?"
    if [[ "$n" == "0" ]]; then
        # Head differs but nothing is ahead of the pin: our pin is on another
        # branch, or ahead of the default one. Worth saying plainly.
        warn "Upstream $head_ref ($(echo "$head_sha" | cut -c1-8)) does not descend from our pin,"
        warn "  and nothing is ahead of it. The pin is on a different branch."
        { echo "== $label — pin off the default branch =="; echo "pinned $sha"; echo "head   $head_ref $head_sha"; } >> "$report"
        return 0
    fi

    echo ""
    warn "$n commit(s) upstream since the pin  →  $head_ref @ $(echo "$head_sha" | cut -c1-8)"
    echo ""
    # `|| true` is not decoration: `head -n N` closes the pipe, git dies of
    # SIGPIPE (141), and under the caller's `set -o pipefail` that is the
    # pipeline's status. Verified: a truncated pipeline returns 141 and `set -e`
    # aborts. It needs ~900 commits to fill the 64 KB pipe buffer, so it would
    # surface years from now, on the one screen an operator runs before taking a
    # security fix. Both call sites happen to be `||`-guarded today; that is the
    # caller's property, not this function's.
    "$ACV_GIT_BIN" -C "$dir" log --no-decorate --format='  %h  %ad  %s' --date=short \
        "${sha}..${head_ref}" | head -n "$ACV_LOG_LINES" || true
    if [[ "$n" =~ ^[0-9]+$ ]] && (( n > ACV_LOG_LINES )); then
        echo -e "  ${DIM}… $((n - ACV_LOG_LINES)) more — full log in the report file${RESET}"
    fi

    # ── changed paths ────────────────────────────────────────────────────────
    local changed
    changed=$("$ACV_GIT_BIN" -C "$dir" diff --name-only "${sha}" "${head_ref}") || changed=""
    local nchanged
    nchanged=$(printf '%s\n' "$changed" | grep -c . || true)
    echo ""
    info "$nchanged file(s) differ from our pin."

    # ── the only question that decides how expensive a bump is ───────────────
    if [[ "$xref" == "patches" ]]; then
        local repl overlap
        repl=$(_acv_patched_upstream_paths replaced)
        echo ""
        if [[ -z "$repl" ]]; then
            # "Cannot tell", NOT "no conflict". The overlay is derived by testing
            # each patch file against vendor/, so a missing or empty vendored
            # tree classifies every patch as an addition — and this check would
            # then print a clean bill of health on the one screen an operator
            # reads before taking a security fix. Refuse to answer instead.
            warn "Cannot cross-reference the overlay — patches/ resolves to ZERO"
            warn "  replaced files. vendor/ is missing or empty; run Verify (key 1)."
            warn "  Treat the conflict list as UNKNOWN, not as empty."
        else
            overlap=$(LC_ALL=C comm -12 <(printf '%s\n' "$changed" | LC_ALL=C sort) \
                                        <(printf '%s\n' "$repl")) || overlap=""
            if [[ -n "$overlap" ]]; then
                local no; no=$(printf '%s\n' "$overlap" | grep -c . || true)
                warn "⚠ $no changed file(s) are REPLACED by our patches/ overlay:"
                printf '%s\n' "$overlap" | sed 's/^/      /'
                echo ""
                echo -e "  ${DIM}These are the only files that can conflict. Taking this update${RESET}"
                echo -e "  ${DIM}means re-applying each of those patches to its NEW upstream — the${RESET}"
                echo -e "  ${DIM}\`ACCIO PATCH\` markers say what each one changed and why.${RESET}"
            else
                success "None of the changed files are replaced by patches/ — a bump"
                echo -e "  ${DIM}would carry no overlay conflict.${RESET}"
            fi
        fi
    fi

    if [[ -n "$watched" ]]; then
        local w hits=""
        while IFS= read -r w; do
            if [[ -z "$w" ]]; then continue; fi
            if printf '%s\n' "$changed" | grep -qxF "$w"; then hits="$hits  $w"$'\n'; fi
        done < <(printf '%s\n' "$watched" | tr '|' '\n')
        if [[ -n "$hits" ]]; then
            echo ""
            warn "Also changed — files we keep as a SPEC rather than vendor:"
            printf '%s' "$hits"
        fi
    fi

    {
        echo "== $label =="
        echo "url     $url"
        echo "pinned  $sha"
        echo "head    $head_ref $head_sha"
        echo "commits $n"
        echo ""
        "$ACV_GIT_BIN" -C "$dir" log --stat --no-decorate "${sha}..${head_ref}"
        echo ""
    } >> "$report"
    return 0
}

acv_check_upstream() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 052) ACCIO — CHECK UPSTREAM${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  ${DIM}Reports what upstream has changed since our pin, and which of${RESET}"
    echo -e "  ${DIM}those files our patches/ overlay replaces. It CHANGES NOTHING:${RESET}"
    echo -e "  ${DIM}vendor/ is not written, the built site is not touched, and no${RESET}"
    echo -e "  ${DIM}upstream file is ever checked out — the scratch clone is bare.${RESET}"
    echo ""
    echo -e "  ${YELLOW}This is the only action in Accio that uses the network.${RESET}"
    echo -e "  ${DIM}It will contact:${RESET}"
    echo -e "  ${DIM}  $(_acv_pin UPSTREAM_URL '?')${RESET}"
    echo -e "  ${DIM}  $(_acv_pin STANDALONE_URL '?')${RESET}"
    echo ""

    if ! command -v "$ACV_GIT_BIN" >/dev/null 2>&1; then
        error "$ACV_GIT_BIN is not installed — nothing was checked."
        echo -e "  ${BOLD}apt-get install -y git${RESET}   (Rocky/Alma: ${BOLD}dnf install -y git${RESET})"
        return 1
    fi

    echo -ne "${BOLD}Fetch upstream now? [y/N]: ${RESET}"
    local ans; read -r ans || true
    case "${ans,,}" in
        y|yes) ;;
        *) info "Nothing was fetched."; return 0 ;;
    esac

    local root
    root=$(mktemp -d -t accio-upstream.XXXXXXXX) || { error "Cannot create a scratch directory."; return 1; }
    # Belt and braces: the design says "never into the deployed tree", so prove
    # it rather than trusting mktemp's TMPDIR.
    case "$root" in
        "$(_acv_product_src)"*|"${ACC_DIR:-/opt/grin/accio-nowhere}"*)
            error "Refusing to fetch into $root — that is inside the product tree."
            rm -rf -- "${root:?}"; return 1 ;;
    esac

    # A full-history fetch of a wallet repo is long enough that Ctrl-C during it
    # is normal, and every other exit below already cleans up. Without this, an
    # interrupt orphans a scratch clone in the temp dir, which the next run
    # cannot see and will not reuse. Clean up, restore the default, re-raise:
    # swallowing the signal instead would resume a run whose tree just vanished.
    # There is no other INT/TERM trap in 052, so nothing is being clobbered.
    trap 'rm -rf -- "${root:?}" 2>/dev/null; trap - INT TERM; kill -INT $$' INT TERM

    local report="${LOG_DIR:-/opt/grin/logs}/accio_upstream_check_$(date +%Y%m%d_%H%M%S).log"
    mkdir -p "$(dirname "$report")" 2>/dev/null || true
    if ! : > "$report" 2>/dev/null; then
        # ⚠ The fallback must NOT be inside $root. It was, and $root is removed
        # at the end of this function — so on precisely the box where the log
        # directory is unwritable, the path printed as "full log with per-commit
        # stats" was deleted a few lines after being printed. The report is the
        # whole deliverable of this screen; a fetch whose findings cannot be
        # kept is not worth running.
        local alt=""
        if alt=$(mktemp -t accio-upstream-report.XXXXXXXX 2>/dev/null); then
            warn "Cannot write to ${report%/*} — using $alt instead."
            report="$alt"
        else
            error "Nowhere to write the report — not ${report%/*}, not the temp dir."
            error "Nothing was fetched."
            rm -rf -- "${root:?}"
            trap - INT TERM
            return 1
        fi
    fi
    {
        echo "Accio (052) upstream check — $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
        echo "Nothing was modified by this run."
        echo ""
    } >> "$report" 2>/dev/null || true

    local rc=0
    # Watched extras for the wallet: `nginx.conf` is the spec S3/S4b replaced
    # (kept at docs/upstream-nginx.conf.reference, deliberately outside
    # vendor/), and `LICENSE` is the source of our copied credit target —
    # neither is cross-referenced by the overlay check, and both matter.
    _acv_check_one "wallet" \
        "$(_acv_pin UPSTREAM_URL '')" "$(_acv_pin UPSTREAM_SHA '')" \
        "$root" "$report" "patches" "nginx.conf|LICENSE" || rc=1
    _acv_check_one "build-spec" \
        "$(_acv_pin STANDALONE_URL '')" "$(_acv_pin STANDALONE_SHA '')" \
        "$root" "$report" "no" "build.sh" || rc=1

    echo ""
    echo -e "  ${DIM}Full log with per-commit stats: $report${RESET}"
    echo ""
    echo -e "  ${BOLD}Taking an update is a deliberate act, and it happens in the repo,${RESET}"
    echo -e "  ${BOLD}not on this box:${RESET}"
    echo -e "  ${DIM}  1. re-vendor per the recipe at the bottom of PINNED_SHA${RESET}"
    echo -e "  ${DIM}     (note the CRLF trap — it has bitten twice)${RESET}"
    echo -e "  ${DIM}  2. re-apply every flagged patch, keep the ACCIO PATCH markers${RESET}"
    echo -e "  ${DIM}  3. regenerate vendor/SHA256SUMS and re-pin PINNED_SHA${RESET}"
    echo -e "  ${DIM}  4. rebuild, re-run the testnet send AND receive, re-run the audit${RESET}"
    echo ""
    echo -e "  ${DIM}We never DEPEND on upstream to build; we keep the OPTION to take${RESET}"
    echo -e "  ${DIM}a security fix. Nothing here auto-updates, and nothing installs a${RESET}"
    echo -e "  ${DIM}timer to do it later — this is a self-custodial wallet.${RESET}"

    rm -rf -- "${root:?}"
    trap - INT TERM
    log "acv_check_upstream: report=$report rc=$rc"
    return "$rc"
}

# =============================================================================
# Pin report
# =============================================================================

acv_pin_report() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 052) ACCIO — PIN RECORD${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    local pin; pin="$(_acv_pin_file)"
    if [[ ! -f "$pin" ]]; then
        error "No pin record at $pin"
        return 1
    fi
    echo -e "  ${BOLD}Wallet${RESET}  ${DIM}(what the visitor's browser actually runs)${RESET}"
    echo -e "    name      $(_acv_pin UPSTREAM_NAME '?')"
    echo -e "    url       $(_acv_pin UPSTREAM_URL '?')"
    echo -e "    commit    $(_acv_pin UPSTREAM_SHA '?')"
    echo -e "    subject   $(_acv_pin UPSTREAM_COMMIT_SUBJECT '?')"
    echo -e "    dated     $(_acv_pin UPSTREAM_COMMIT_DATE '?')"
    echo -e "    version   $(_acv_pin UPSTREAM_VERSION '?')   licence $(_acv_pin UPSTREAM_LICENSE '?')"
    echo -e "    files     $(_acv_pin UPSTREAM_FILE_COUNT '?') / $(_acv_fmt_bytes "$(_acv_pin UPSTREAM_BYTES 0)")"
    echo ""
    echo -e "  ${BOLD}Build spec${RESET}  ${DIM}(a SPEC — vendored, read, never executed)${RESET}"
    echo -e "    name      $(_acv_pin STANDALONE_NAME '?')"
    echo -e "    url       $(_acv_pin STANDALONE_URL '?')"
    echo -e "    commit    $(_acv_pin STANDALONE_SHA '?')"
    echo -e "    files     $(_acv_pin STANDALONE_FILE_COUNT '?') / $(_acv_fmt_bytes "$(_acv_pin STANDALONE_BYTES 0)")"
    echo ""
    echo -e "  ${BOLD}Manifest${RESET}"
    echo -e "    path      $(_acv_pin VENDORED_MANIFEST '?')"
    echo -e "    sha256    $(_acv_pin VENDORED_MANIFEST_SHA256 '?')"
    echo -e "    covers    $(_acv_pin VENDORED_FILE_COUNT '?') files / $(_acv_fmt_bytes "$(_acv_pin VENDORED_BYTES 0)")"
    echo -e "    vendored  $(_acv_pin VENDORED_DATE '?')"
    echo ""
    local n_repl n_add
    n_repl=$(_acv_patched_upstream_paths replaced | grep -c . || true)
    n_add=$(_acv_patched_upstream_paths added    | grep -c . || true)
    echo -e "  ${BOLD}Overlay${RESET}  ${DIM}(patches/, applied by whole-file replacement at build time)${RESET}"
    if (( n_repl == 0 )) && (( n_add > 0 )); then
        # The same refusal _acv_check_one makes, for the same reason. The two
        # counts are DERIVED by testing each patch file against vendor/, so a
        # missing or empty vendor/ classifies every patch as an addition and
        # renders "replaces 0 — the only ones an upstream bump can conflict
        # with" as a clean bill of health that was never checked. One screen
        # guarded it and this one did not; a zero here means "cannot tell".
        warn "Cannot classify the overlay — 0 of ${n_add} patch file(s) match a"
        warn "  vendored path, so vendor/ is missing or empty. Run Verify (key 1)."
        warn "  Treat the conflict count as UNKNOWN, not as zero."
    else
        echo -e "    replaces  ${n_repl} vendored file(s)  ${DIM}— the only ones an upstream bump can conflict with${RESET}"
        echo -e "    adds      ${n_add} file(s) with no upstream counterpart"
    fi
    echo ""
    echo -e "  ${DIM}Full provenance: web/052_accio/PROVENANCE.md${RESET}"
    return 0
}

# =============================================================================
# Menu
# =============================================================================

acv_vendor_menu() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN} 052) ACCIO — SOURCE INTEGRITY & UPSTREAM${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  ${DIM}The browser wallet is vendored and pinned, never fetched at${RESET}"
        echo -e "  ${DIM}build time. This screen is how that pin is kept honest.${RESET}"
        echo ""
        echo -e "  ${DIM}wallet     $(_acv_pin UPSTREAM_SHA8 '?')  v$(_acv_pin UPSTREAM_VERSION '?')${RESET}"
        echo -e "  ${DIM}manifest   $(_acv_pin VENDORED_FILE_COUNT '?') files across both pinned trees${RESET}"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Verify vendored tree   ${DIM}(offline — the build runs this too)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Check upstream         ${DIM}(network; reports only, changes nothing)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Show pin record"
        echo ""
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-3 / 0]: ${RESET}"
        local choice; read -r choice || true
        case "$choice" in
            1) clear; acv_verify_vendor || true; pause ;;
            2) acv_check_upstream || true; pause ;;
            3) acv_pin_report || true; pause ;;
            0) break ;;
            "") continue ;;
            *) echo -e "\n${RED}Invalid option.${RESET}"; sleep 1 ;;
        esac
    done
    return 0
}
