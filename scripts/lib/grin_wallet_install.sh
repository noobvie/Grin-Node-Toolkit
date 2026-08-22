# =============================================================================
# lib/grin_wallet_install.sh — grin-wallet binary: install · update · rollback
# =============================================================================
# ONE download/verify/apply implementation shared by every product that runs a
# grin-wallet binary (05C CMD wallet, 051 Fidelius, 059 Drop, 07 solo, 07 pool).
#
# ── Why a shared VERSION STORE ───────────────────────────────────────────────
# All five products install the identical linux-x86_64 binary, so it is fetched
# once into a store and COPIED out to each product:
#
#   /opt/grin/wallet-bin/<tag>/grin-wallet          verified, immutable
#   /opt/grin/wallet-bin/<tag>/grin-wallet.sha256   sha256 OF THE BINARY
#   <product_dir>/grin-wallet                       the copy in use
#   <product_dir>/.grin-wallet.version              current= / previous= / applied=
#
# Rollback then costs nothing: the previous tag is already on disk, already
# verified. Without the store, "undo a bad update" means hand-fetching an old
# tarball on a live box, which is what we had before.
#
# ── Public API ───────────────────────────────────────────────────────────────
#   gwi_install_grin_wallet <dest_dir> [force]
#       Unchanged contract (three legacy call sites depend on it): install the
#       binary if absent, or re-install when force=1. Now routed through the
#       store and the pin. Sets GWI_WALLET_BIN and GWI_INSTALLED_VERSION (the
#       TAG, e.g. v5.4.1 — not the `--version` line), rc 0/1.
#
#   gwi_fetch_version <tag|latest> [force]   store <- GitHub (download + verify)
#       Sets GWI_STORE_TAG / GWI_STORE_BIN.
#   gwi_apply_version <dest_dir> <tag>       store -> product (swap + smoke test)
#   gwi_rollback      <dest_dir> [tag]       re-apply previous (or a cached tag)
#   gwi_verify_store  <tag>                  rc 0 ok / 1 MISMATCH / 2 no record
#   gwi_current_tag   <dest_dir>             recorded tag of the installed copy
#   gwi_binary_version <path>                `--version` string, "unknown" if none
#   gwi_list_cached                          tags present in the store
#   gwi_update_screen <dest_dir> <label> [stop_cmd] [start_cmd]
#       The one interactive update/rollback screen, dispatched from every
#       product menu. stop_cmd/start_cmd are shell command STRINGS supplied by
#       the caller (e.g. "sw_listener_stop mainnet"); omit them and the screen
#       only prints a restart hint.
#
# ── Three details that decide whether this is safe ───────────────────────────
#  1. SWAP BY RENAME, never by writing over the binary in place. Writing to a
#     file some process is currently executing fails with ETXTBSY. `cp` to a
#     temp name in the SAME directory then `mv` (same filesystem = atomic
#     rename) never hits that. The running listener keeps the old inode until
#     it is restarted — which is why the screen reports stale processes.
#  2. SMOKE-TEST BEFORE THE SWAP. `--version` must exit clean on the staged
#     copy or the swap does not happen at all. That turns a truncated download
#     or a wrong-arch binary from an outage into a no-op.
#  3. EVERY command is individually guarded. This lib is always entered with
#     errexit DISABLED (callers use `fn || true` / `if fn; then`), so a bare
#     cp/mv/mkdir here is a silent failure that ships. See CLAUDE.md and memory
#     `project_lib_errexit_suppression`.
#
# ── The pin ──────────────────────────────────────────────────────────────────
# GWI_DEFAULT_TAG pins the version every product installs, so moving versions is
# a deliberate edit here rather than something an upstream release does for us.
# The pin's original reason was that grin-wallet 5.4.1 pins rpassword 4.x, whose
# read_password() reads STDIN, and rpassword 7's read_password() reads the TTY —
# a naive port would have broken every listener this toolkit feeds a passphrase
# on stdin. That did NOT happen: v5.5.0 (2026-08-12) pins rpassword 7.5.4 but
# branches on `stdin.is_terminal()`, so the non-TTY path still works. Treat the
# hazard as defused, not pending — but keep smoke-testing
# `printf 'x\n' | grin-wallet address` before swapping a pin, because that
# branch is upstream's choice and not a guarantee.
# A product may override with GWI_PIN_TAG (set it to "latest" to track head).
#
# Convention: sourced lib → NO shebang / NO `set -e`.
# =============================================================================

[[ -n "${_GRIN_WALLET_INSTALL_SH_LOADED:-}" ]] && return 0
_GRIN_WALLET_INSTALL_SH_LOADED=1

GWI_GITHUB_REPO="${GWI_GITHUB_REPO:-mimblewimble/grin-wallet}"
GWI_GITHUB_API_BASE="${GWI_GITHUB_API_BASE:-https://api.github.com/repos/${GWI_GITHUB_REPO}/releases}"
# Kept for back-compat: callers that overrode the old single-URL variable
# (a mirror, a test fixture) still get their override honoured for `latest`.
GWI_GITHUB_API="${GWI_GITHUB_API:-${GWI_GITHUB_API_BASE}/latest}"

GWI_STORE_DIR="${GWI_STORE_DIR:-/opt/grin/wallet-bin}"
GWI_DEFAULT_TAG="${GWI_DEFAULT_TAG:-v5.4.1}"

GWI_WALLET_BIN=""
GWI_INSTALLED_VERSION=""
GWI_STORE_TAG=""
GWI_STORE_BIN=""
GWI_LATEST_TAG=""

# Logging fallbacks (an interactive caller already defines richer versions).
if ! declare -F info    >/dev/null 2>&1; then info()    { echo "[INFO]  $*"; }; fi
if ! declare -F warn    >/dev/null 2>&1; then warn()    { echo "[WARN]  $*"; }; fi
if ! declare -F error   >/dev/null 2>&1; then error()   { echo "[ERROR] $*" >&2; }; fi
if ! declare -F success >/dev/null 2>&1; then success() { echo "[OK]    $*"; }; fi

_gwi_pause() {
    if declare -F pause >/dev/null 2>&1; then pause; return 0; fi
    echo ""
    echo -ne "  Press Enter to continue... "
    read -r _ || true
}

# Ensure jq is available (release JSON parsing). Best-effort install on Debian.
_gwi_ensure_jq() {
    command -v jq &>/dev/null && return 0
    if command -v apt-get &>/dev/null; then
        info "Installing jq (required to parse the GitHub release)..."
        apt-get install -y -qq jq >/dev/null 2>&1 || true
    elif command -v dnf &>/dev/null; then
        dnf install -y jq >/dev/null 2>&1 || true
    fi
    command -v jq &>/dev/null
}

# =============================================================================
# Tags, paths and per-product state
# =============================================================================

# A tag becomes a DIRECTORY NAME in the store, and it arrives from GitHub JSON.
# Constrain it to a leading alnum + [A-Za-z0-9._-] so no separator, no leading
# dot and no path component can ever come out of a release name.
_gwi_valid_tag() {
    [[ "${1:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]
}

_gwi_store_tag_dir() { printf '%s/%s\n' "${GWI_STORE_DIR%/}" "$1"; }
_gwi_store_tag_bin() { printf '%s/%s/grin-wallet\n' "${GWI_STORE_DIR%/}" "$1"; }
_gwi_store_tag_sum() { printf '%s/%s/grin-wallet.sha256\n' "${GWI_STORE_DIR%/}" "$1"; }
_gwi_state_file()    { printf '%s/.grin-wallet.version\n' "${1%/}"; }

# gwi_binary_version <path> — the `--version` line, or "unknown".
gwi_binary_version() {
    local bin="${1:-}"
    [[ -x "$bin" ]] || { echo "unknown"; return 1; }
    local v; v=$("$bin" --version 2>/dev/null | head -1)
    [[ -n "$v" ]] || v="unknown"
    printf '%s\n' "$v"
}

_gwi_state_get() {
    local f k v
    f=$(_gwi_state_file "$1"); k="$2"
    [[ -f "$f" ]] || return 1
    v=$(grep -m1 "^${k}=" "$f" 2>/dev/null | cut -d= -f2-)
    [[ -n "$v" ]] || return 1
    printf '%s\n' "$v"
}

# _gwi_state_write <dest_dir> <current> <previous>
_gwi_state_write() {
    local dest="${1%/}" cur="${2:-}" prev="${3:-}" f
    f=$(_gwi_state_file "$dest")
    {
        echo "# Written by lib/grin_wallet_install.sh — do not edit by hand."
        echo "current=$cur"
        echo "previous=$prev"
        echo "applied=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo unknown)"
    } > "$f" 2>/dev/null || { warn "Could not record version state in $f."; return 1; }
    chmod 644 "$f" 2>/dev/null || true
    return 0
}

# gwi_current_tag <dest_dir> — the tag we recorded for the installed copy.
gwi_current_tag() { _gwi_state_get "$1" current; }

# gwi_previous_tag <dest_dir> — the rollback target.
gwi_previous_tag() { _gwi_state_get "$1" previous; }

# gwi_list_cached — tags present in the store, in directory (alphabetical) order.
gwi_list_cached() {
    [[ -d "$GWI_STORE_DIR" ]] || return 0
    local d
    for d in "$GWI_STORE_DIR"/*/; do
        [[ -d "$d" ]] || continue
        [[ -x "${d}grin-wallet" ]] || continue
        basename "$d"
    done
}

# =============================================================================
# Store: fetch + verify
# =============================================================================

# gwi_verify_store <tag>
#   rc 0 = binary matches its recorded sha256
#   rc 1 = MISMATCH (or the binary is missing) — never apply this
#   rc 2 = present but no recorded sha256 (pre-store copy; caller decides)
gwi_verify_store() {
    local tag="${1:-}" bin sum expected actual
    _gwi_valid_tag "$tag" || return 1
    bin=$(_gwi_store_tag_bin "$tag"); sum=$(_gwi_store_tag_sum "$tag")
    [[ -x "$bin" ]] || return 1
    [[ -f "$sum" ]] || return 2
    expected=$(awk '{print $1; exit}' "$sum" 2>/dev/null | tr -d '[:space:]')
    actual=$(sha256sum "$bin" 2>/dev/null | awk '{print $1}')
    [[ -n "$expected" && -n "$actual" ]] || return 2
    [[ "$expected" == "$actual" ]]
}

# gwi_resolve_latest_tag — sets GWI_LATEST_TAG (best effort, never fatal).
gwi_resolve_latest_tag() {
    GWI_LATEST_TAG=""
    command -v curl &>/dev/null || return 1
    _gwi_ensure_jq || return 1
    local t
    t=$(curl -fsSL --max-time 15 "${GWI_GITHUB_API_BASE}/latest" 2>/dev/null \
        | jq -r '.tag_name // empty' 2>/dev/null)
    [[ -n "$t" ]] || return 1
    GWI_LATEST_TAG="$t"
    return 0
}

# Download + verify + populate the store. Runs inside a caller-owned temp dir so
# there is exactly ONE cleanup site (a RETURN trap here would be global and fire
# again in the caller — see the note that used to live in this file).
# _gwi_fetch_impl <tag|latest> <tmp_dir>
_gwi_fetch_impl() {
    local want="$1" tmp_dir="$2"
    local api_url release_json tag tar_url sum_url

    if [[ "$want" == "latest" ]]; then
        api_url="$GWI_GITHUB_API"
    else
        api_url="${GWI_GITHUB_API_BASE}/tags/${want}"
    fi

    info "Querying GitHub for release: ${want}"
    release_json=$(curl -fsSL --max-time 30 "$api_url") \
        || { error "Failed to reach the GitHub API ($api_url)."; return 1; }

    tag=$(echo "$release_json" | jq -r '.tag_name // empty')
    [[ -n "$tag" ]] || { error "Release JSON carries no tag_name."; return 1; }
    _gwi_valid_tag "$tag" || { error "Refusing an unusable release tag: '$tag'"; return 1; }

    tar_url=$(echo "$release_json" \
        | jq -r '.assets[] | select(.name | test("linux-x86_64\\.tar\\.gz$"; "i")) | .browser_download_url' \
        | head -1)
    sum_url=$(echo "$release_json" \
        | jq -r '.assets[] | select(.name | test("linux-x86_64\\.tar\\.gz\\.(sha256sum|sha256)$"; "i")) | .browser_download_url' \
        | head -1)

    if [[ -z "$tar_url" || "$tar_url" == "null" ]]; then
        error "No linux-x86_64 asset found for grin-wallet ${tag}."
        return 1
    fi

    local tmp_tar="$tmp_dir/grin-wallet.tar.gz"
    info "Version : $tag"
    info "Store   : $(_gwi_store_tag_bin "$tag")"
    if [[ -t 1 ]]; then
        wget --progress=bar:force -O "$tmp_tar" "$tar_url" \
            || { error "Download failed: $tar_url"; return 1; }
    else
        wget -q -O "$tmp_tar" "$tar_url" \
            || { error "Download failed: $tar_url"; return 1; }
    fi

    # ── Verify the tarball against the release checksum when one is published ──
    if [[ -n "$sum_url" && "$sum_url" != "null" ]]; then
        local tmp_sum="$tmp_dir/grin-wallet.sha256"
        if wget -q -O "$tmp_sum" "$sum_url"; then
            local expected actual
            expected=$(awk '{print $1; exit}' "$tmp_sum" 2>/dev/null | tr -d '[:space:]')
            actual=$(sha256sum "$tmp_tar" 2>/dev/null | awk '{print $1}')
            if [[ -n "$expected" && -n "$actual" ]]; then
                if [[ "$expected" == "$actual" ]]; then
                    success "Checksum verified (sha256)."
                else
                    error "Checksum MISMATCH — refusing to install."
                    error "  expected: $expected"
                    error "  actual  : $actual"
                    return 1
                fi
            else
                warn "Could not compute/parse the checksum — proceeding unverified."
            fi
        else
            warn "Checksum asset present but its download failed — proceeding unverified."
        fi
    else
        warn "Release ${tag} publishes no checksum asset — the binary is unverified."
    fi

    local ex_dir="$tmp_dir/x"
    mkdir -p "$ex_dir" || { error "Could not create $ex_dir."; return 1; }
    tar -xzf "$tmp_tar" -C "$ex_dir" || { error "Extraction failed."; return 1; }

    local bin_src
    bin_src=$(find "$ex_dir" -type f -name "grin-wallet" | head -1)
    [[ -n "$bin_src" ]] || { error "No 'grin-wallet' binary inside the archive."; return 1; }

    # Stage into the store, then rename — a half-written store entry would be
    # indistinguishable from a good one on the next run.
    local tag_dir staged
    tag_dir=$(_gwi_store_tag_dir "$tag")
    mkdir -p "$tag_dir" || { error "Could not create the store dir $tag_dir."; return 1; }
    chmod 755 "$tag_dir" 2>/dev/null || true
    staged="$tag_dir/.grin-wallet.staged.$$"
    install -m 755 "$bin_src" "$staged" \
        || { error "Could not stage the binary into $tag_dir."; return 1; }

    if ! "$staged" --version >/dev/null 2>&1; then
        rm -f "$staged" 2>/dev/null || true
        error "The downloaded binary does not run on this host (--version failed)."
        error "Wrong architecture, or a corrupt download. Nothing was stored."
        return 1
    fi

    local bin_sha
    bin_sha=$(sha256sum "$staged" 2>/dev/null | awk '{print $1}')
    mv -f "$staged" "$(_gwi_store_tag_bin "$tag")" \
        || { rm -f "$staged" 2>/dev/null || true
             error "Could not place the binary in the store."; return 1; }
    if [[ -n "$bin_sha" ]]; then
        printf '%s  grin-wallet\n' "$bin_sha" > "$(_gwi_store_tag_sum "$tag")" 2>/dev/null \
            || warn "Could not record the store checksum for $tag."
    fi

    GWI_STORE_TAG="$tag"
    GWI_STORE_BIN=$(_gwi_store_tag_bin "$tag")
    success "grin-wallet $tag is in the store."
    return 0
}

# gwi_fetch_version <tag|latest> [force]
#   Ensures the store holds <tag>. A cached, checksum-verified tag costs no
#   network at all — which is what makes rollback instant and offline-safe.
gwi_fetch_version() {
    local want="${1:-latest}" force="${2:-0}"
    GWI_STORE_TAG=""; GWI_STORE_BIN=""

    if [[ "$want" != "latest" ]]; then
        _gwi_valid_tag "$want" || { error "Not a usable version tag: '$want'"; return 1; }
        if [[ "$force" != "1" && -x "$(_gwi_store_tag_bin "$want")" ]]; then
            gwi_verify_store "$want"; local vrc=$?
            if [[ $vrc -eq 0 ]]; then
                GWI_STORE_TAG="$want"; GWI_STORE_BIN=$(_gwi_store_tag_bin "$want")
                info "grin-wallet $want already in the store (checksum verified)."
                return 0
            elif [[ $vrc -eq 2 ]]; then
                warn "Cached $want has no recorded checksum — re-downloading to verify."
            else
                warn "Cached $want FAILED its checksum — re-downloading."
            fi
        fi
    fi

    command -v curl &>/dev/null || { error "curl not found."; return 1; }
    command -v wget &>/dev/null || { error "wget not found."; return 1; }
    command -v tar  &>/dev/null || { error "tar not found.";  return 1; }
    _gwi_ensure_jq || { error "jq not found and could not be installed."; return 1; }

    local tmp_dir
    tmp_dir=$(mktemp -d /tmp/grin_wallet_fetch.XXXXXX 2>/dev/null) \
        || { error "Could not create a temp directory."; return 1; }
    _gwi_fetch_impl "$want" "$tmp_dir"
    local rc=$?
    rm -rf "$tmp_dir" 2>/dev/null || true
    return $rc
}

# =============================================================================
# Store -> product
# =============================================================================

# A binary installed before the store existed has no recorded tag, so a rollback
# after the first managed update would have nothing to go back to. Snapshot it
# into the store first, marked `-local` because we cannot verify its provenance.
# _gwi_snapshot_unmanaged <dest_dir>  → echoes the snapshot tag, or nothing.
_gwi_snapshot_unmanaged() {
    local dest="${1%/}" bin="${1%/}/grin-wallet" ver tag short_sha
    [[ -x "$bin" ]] || return 1
    gwi_current_tag "$dest" >/dev/null 2>&1 && return 1   # already managed

    ver=$(gwi_binary_version "$bin")
    # The sha is part of the tag even when the version parses. The store is
    # SHARED, so two products can each hold an unmanaged binary that reports
    # "5.4.1" without them being the same file — a version-only tag would give
    # the second product a rollback that silently restores the FIRST product's
    # binary. With the sha in the name, a store entry always matches its label,
    # and re-snapshotting the same file is a no-op instead of a collision.
    short_sha=$(sha256sum "$bin" 2>/dev/null | cut -c1-8)
    [[ -n "$short_sha" ]] || short_sha="nosum"
    # "grin-wallet 5.4.1" → v5.4.1-local-1a2b3c4d
    tag=$(printf '%s\n' "$ver" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    if [[ -n "$tag" ]]; then
        tag="v${tag}-local-${short_sha}"
    else
        tag="unknown-${short_sha}"
    fi
    _gwi_valid_tag "$tag" || return 1

    local tag_dir; tag_dir=$(_gwi_store_tag_dir "$tag")
    if [[ ! -x "$(_gwi_store_tag_bin "$tag")" ]]; then
        mkdir -p "$tag_dir" || return 1
        install -m 755 "$bin" "$(_gwi_store_tag_bin "$tag")" || return 1
        local s; s=$(sha256sum "$(_gwi_store_tag_bin "$tag")" 2>/dev/null | awk '{print $1}')
        [[ -n "$s" ]] && printf '%s  grin-wallet\n' "$s" > "$(_gwi_store_tag_sum "$tag")" 2>/dev/null
    fi
    printf '%s\n' "$tag"
    return 0
}

# gwi_apply_version <dest_dir> <tag>
#   Copy a stored version into a product dir. Staged copy → smoke test → rename.
#   Preserves the existing binary's owner/mode (059 runs it as grin:grin, the
#   others as root) so no caller needs its own chown afterwards.
gwi_apply_version() {
    local dest="${1%/}" tag="${2:-}"
    [[ -n "$dest" ]] || { error "gwi_apply_version: dest_dir required."; return 1; }
    _gwi_valid_tag "$tag" || { error "gwi_apply_version: bad tag '$tag'"; return 1; }

    local store_bin; store_bin=$(_gwi_store_tag_bin "$tag")
    gwi_verify_store "$tag"; local vrc=$?
    if [[ $vrc -eq 1 ]]; then
        error "Stored $tag is missing or FAILED its checksum — refusing to apply."
        return 1
    elif [[ $vrc -eq 2 ]]; then
        warn "Stored $tag has no recorded checksum (locally snapshotted copy)."
    fi

    mkdir -p "$dest" || { error "Could not create $dest."; return 1; }
    local target="$dest/grin-wallet"

    # Preserve ownership/mode of the copy we are replacing.
    local own="" mode="755"
    if [[ -e "$target" ]]; then
        own=$(stat -c '%U:%G' "$target" 2>/dev/null || echo "")
        mode=$(stat -c '%a'   "$target" 2>/dev/null || echo "755")
        [[ -n "$mode" ]] || mode="755"
    fi

    # Nothing to roll back to unless the outgoing binary is in the store.
    local prev_tag=""
    prev_tag=$(gwi_current_tag "$dest" 2>/dev/null || true)
    if [[ -z "$prev_tag" && -x "$target" ]]; then
        prev_tag=$(_gwi_snapshot_unmanaged "$dest" 2>/dev/null || true)
    fi
    [[ "$prev_tag" == "$tag" ]] && prev_tag=$(gwi_previous_tag "$dest" 2>/dev/null || true)

    # Stage IN THE SAME DIRECTORY: the final step must be a rename, or replacing
    # a binary a listener is executing fails with ETXTBSY.
    local staged="$dest/.grin-wallet.new.$$"
    rm -f "$staged" 2>/dev/null || true
    cp -f "$store_bin" "$staged" \
        || { error "Could not stage $tag into $dest."; return 1; }
    chmod "$mode" "$staged" 2>/dev/null || chmod 755 "$staged" 2>/dev/null || true
    # Preserving the mode must never preserve a MISSING execute bit — the smoke
    # test below would then fail on a perfectly good binary and refuse the swap.
    [[ -x "$staged" ]] || chmod 755 "$staged" 2>/dev/null || true
    [[ -n "$own" ]] && { chown "$own" "$staged" 2>/dev/null || true; }

    if ! "$staged" --version >/dev/null 2>&1; then
        rm -f "$staged" 2>/dev/null || true
        error "Staged binary failed its smoke test (--version) — NOT swapped in."
        error "The running binary is untouched."
        return 1
    fi

    mv -f "$staged" "$target" \
        || { rm -f "$staged" 2>/dev/null || true
             error "Could not swap the binary into place at $target."; return 1; }

    _gwi_state_write "$dest" "$tag" "$prev_tag" || true

    GWI_WALLET_BIN="$target"
    GWI_INSTALLED_VERSION="$tag"
    success "grin-wallet $tag applied → $target"
    [[ -n "$prev_tag" ]] && info "Rollback target: $prev_tag"
    return 0
}

# gwi_rollback <dest_dir> [tag] — re-apply the previous tag, or a named cached one.
gwi_rollback() {
    local dest="${1%/}" tag="${2:-}"
    if [[ -z "$tag" ]]; then
        tag=$(gwi_previous_tag "$dest" 2>/dev/null || true)
        [[ -n "$tag" ]] || { error "No previous version recorded for $dest — nothing to roll back to."; return 1; }
    fi
    # The store is deliberately NOT in the 089 backup (it re-downloads), so on a
    # restored box the recorded rollback target can be missing. Re-fetch it —
    # except for a local snapshot, which by definition exists nowhere upstream.
    if [[ ! -x "$(_gwi_store_tag_bin "$tag")" ]]; then
        # Keep both shapes: the tag carries a sha suffix (`-local-<sha8>`), but a
        # hand-written or older state file may say plain `-local`.
        case "$tag" in
            *-local|*-local-*|unknown-*)
                error "Snapshot $tag is gone from the store and cannot be re-downloaded."
                error "It was a copy of a binary we did not fetch, so there is no upstream."
                return 1 ;;
        esac
        warn "Version $tag is not in the store — fetching it from GitHub."
        gwi_fetch_version "$tag" \
            || { error "Could not obtain $tag — rollback aborted, nothing changed."; return 1; }
    fi
    info "Rolling back to $tag ..."
    gwi_apply_version "$dest" "$tag"
}

# =============================================================================
# Legacy entry point — unchanged contract
# =============================================================================
# gwi_install_grin_wallet <dest_dir> [force]
gwi_install_grin_wallet() {
    local dest_dir="${1:-}" force="${2:-0}"
    GWI_WALLET_BIN=""; GWI_INSTALLED_VERSION=""

    [[ -n "$dest_dir" ]] || { error "gwi_install_grin_wallet: dest_dir required."; return 1; }
    dest_dir="${dest_dir%/}"
    local wallet_bin="$dest_dir/grin-wallet"

    # Already installed and not forced → report and return (no network).
    if [[ -x "$wallet_bin" && "$force" != "1" ]]; then
        local ver tag
        ver=$(gwi_binary_version "$wallet_bin")
        # GWI_INSTALLED_VERSION is a TAG on every other path (gwi_apply_version
        # sets it), and callers print the two side by side — so report the
        # recorded tag here too, and fall back to the --version line only when
        # this is a pre-store binary that has no tag.
        tag=$(gwi_current_tag "$dest_dir" 2>/dev/null || true)
        GWI_WALLET_BIN="$wallet_bin"; GWI_INSTALLED_VERSION="${tag:-$ver}"
        info "grin-wallet already installed: $wallet_bin ($ver)"
        return 0
    fi

    local want="${GWI_PIN_TAG:-$GWI_DEFAULT_TAG}"
    [[ -n "$want" ]] || want="latest"

    gwi_fetch_version "$want" || return 1
    gwi_apply_version "$dest_dir" "$GWI_STORE_TAG" || return 1
    return 0
}

# =============================================================================
# The shared update / rollback screen
# =============================================================================

# _gwi_running_pids <bin> — PIDs currently executing this exact binary path.
_gwi_running_pids() {
    local bin="${1:-}"
    [[ -n "$bin" ]] || return 1
    command -v pgrep &>/dev/null || return 1
    pgrep -f -- "$bin" 2>/dev/null | tr '\n' ' ' | sed 's/ *$//'
}

_gwi_restart_prompt() {
    local bin="$1" stop_cmd="${2:-}" start_cmd="${3:-}" pids
    pids=$(_gwi_running_pids "$bin")
    [[ -n "$pids" ]] || return 0

    echo ""
    warn "Still running the OLD binary (PIDs: $pids) — a restart is required."
    if [[ -z "$stop_cmd" && -z "$start_cmd" ]]; then
        info "Restart the listener from this product's own menu to pick it up."
        return 0
    fi
    echo -ne "  Restart the listener now? [y/N]: "
    local yn; read -r yn || true
    [[ "${yn,,}" == "y" ]] || { info "Left running on the old binary."; return 0; }

    if [[ -n "$stop_cmd" ]]; then
        info "Stopping: $stop_cmd"
        eval "$stop_cmd" || warn "Stop command returned non-zero — check the listener state."
    fi
    if [[ -n "$start_cmd" ]]; then
        info "Starting: $start_cmd"
        eval "$start_cmd" || warn "Start command returned non-zero — check the listener state."
    fi
    return 0
}

# Every tag ANY product on this box still depends on, as `<tag><TAB><dir>` lines.
# Products all live under the store's parent (/opt/grin), each holding its own
# .grin-wallet.version — so one find answers "who else needs this version".
_gwi_referenced_tags() {
    local base f d k v
    base=$(dirname "${GWI_STORE_DIR%/}")
    [[ -d "$base" ]] || return 0
    while read -r f; do
        [[ -f "$f" ]] || continue
        d=$(dirname "$f")
        for k in current previous; do
            v=$(grep -m1 "^${k}=" "$f" 2>/dev/null | cut -d= -f2-)
            [[ -n "$v" ]] || continue
            printf '%s\t%s\n' "$v" "$d"
        done
    done < <(find "$base" -maxdepth 4 \
                  \( -name chain_data -o -name node_modules -o -name .git \) -prune -o \
                  -type f -name '.grin-wallet.version' -print 2>/dev/null)
    return 0
}

_gwi_prune_screen() {
    local dest="${1%/}" cur prev tag keep
    cur=$(gwi_current_tag  "$dest" 2>/dev/null || true)
    prev=$(gwi_previous_tag "$dest" 2>/dev/null || true)

    # The store is SHARED by all five products, so "unreferenced HERE" is not
    # "unreferenced". Pruning Drop's screen must not delete the version Fidelius
    # is running or holds as its rollback target — and for a *-local snapshot
    # that deletion is permanent, because there is no upstream to re-fetch from.
    local -A other=()
    local _t _who
    while IFS=$'\t' read -r _t _who; do
        [[ -n "$_t" ]] || continue
        [[ "$_who" == "$dest" ]] && continue
        [[ -n "${other[$_t]:-}" ]] && continue
        other["$_t"]="$_who"
    done < <(_gwi_referenced_tags)

    echo ""
    echo -e "  ${BOLD:-}Cached versions in $GWI_STORE_DIR${RESET:-}"
    local -a removable=()
    while read -r tag; do
        [[ -n "$tag" ]] || continue
        keep=""
        if [[ "$tag" == "$cur" ]]; then
            keep="in use"
        elif [[ "$tag" == "$prev" ]]; then
            keep="rollback target"
        elif [[ -n "${other[$tag]:-}" ]]; then
            keep="needed by ${other[$tag]}"
        fi
        if [[ -n "$keep" ]]; then
            echo -e "    $tag  ${DIM:-}($keep — kept)${RESET:-}"
        else
            echo -e "    $tag"
            removable+=("$tag")
        fi
    done < <(gwi_list_cached)

    if [[ ${#removable[@]} -eq 0 ]]; then
        echo ""
        info "Nothing to prune — every cached version is still referenced by a product."
        return 0
    fi

    echo ""
    warn "Removing a cached version means a future rollback to it re-downloads."
    echo -ne "  Delete the ${#removable[@]} unreferenced version(s) listed above? [y/N]: "
    local yn; read -r yn || true
    [[ "${yn,,}" == "y" ]] || { info "Cancelled — nothing was deleted."; return 0; }

    local t
    for t in "${removable[@]}"; do
        _gwi_valid_tag "$t" || continue
        rm -rf "$(_gwi_store_tag_dir "$t")" 2>/dev/null \
            && success "Removed $t" || warn "Could not remove $t"
    done
    return 0
}

# gwi_update_screen <dest_dir> <label> [stop_cmd] [start_cmd]
gwi_update_screen() {
    local dest="${1%/}" label="${2:-grin-wallet}" stop_cmd="${3:-}" start_cmd="${4:-}"
    [[ -n "$dest" ]] || { error "gwi_update_screen: dest_dir required."; return 1; }

    local bin="$dest/grin-wallet"
    local pin="${GWI_PIN_TAG:-$GWI_DEFAULT_TAG}"
    [[ -n "$pin" ]] || pin="latest"

    # One upstream check per screen entry — never per redraw.
    gwi_resolve_latest_tag >/dev/null 2>&1 || true
    local latest="${GWI_LATEST_TAG:-}"

    while true; do
        clear
        echo -e "${BOLD:-}${CYAN:-}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET:-}"
        echo -e "${BOLD:-}${CYAN:-} grin-wallet binary — ${label}${RESET:-}"
        echo -e "${BOLD:-}${CYAN:-}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET:-}"
        echo ""

        local cur prev ver pids
        cur=$(gwi_current_tag  "$dest" 2>/dev/null || true)
        prev=$(gwi_previous_tag "$dest" 2>/dev/null || true)

        echo -e "  Binary   : ${DIM:-}$bin${RESET:-}"
        if [[ -x "$bin" ]]; then
            ver=$(gwi_binary_version "$bin")
            local tag_note
            if [[ -n "$cur" ]]; then tag_note="(tag $cur)"; else tag_note="(tag not recorded)"; fi
            echo -e "  Installed: ${GREEN:-}${ver}${RESET:-}  ${DIM:-}${tag_note}${RESET:-}"
        else
            echo -e "  Installed: ${DIM:-}not installed${RESET:-}"
        fi
        if [[ -n "$prev" ]]; then
            echo -e "  Rollback : ${YELLOW:-}${prev}${RESET:-}  ${DIM:-}(cached, ready)${RESET:-}"
        else
            echo -e "  Rollback : ${DIM:-}no previous version recorded${RESET:-}"
        fi
        echo -e "  Pinned   : ${BOLD:-}${pin}${RESET:-}"
        if [[ -n "$latest" ]]; then
            if [[ "$latest" != "$pin" ]]; then
                echo -e "  Upstream : ${YELLOW:-}${latest}${RESET:-}  ${DIM:-}(newer than the pin)${RESET:-}"
            else
                echo -e "  Upstream : ${DIM:-}${latest} (same as the pin)${RESET:-}"
            fi
        else
            echo -e "  Upstream : ${DIM:-}unknown (GitHub not reachable)${RESET:-}"
        fi
        echo -e "  Store    : ${DIM:-}$GWI_STORE_DIR${RESET:-}"

        pids=$(_gwi_running_pids "$bin")
        if [[ -n "$pids" ]]; then
            echo ""
            echo -e "  ${DIM:-}Running now (PIDs $pids) — a swap needs a listener restart to take effect.${RESET:-}"
        fi

        echo ""
        echo -e "  ${GREEN:-}1${RESET:-}) Install / update to the pinned ${BOLD:-}${pin}${RESET:-}"
        if [[ -n "$latest" && "$latest" != "$pin" ]]; then
            echo -e "  ${GREEN:-}2${RESET:-}) Update to upstream ${BOLD:-}${latest}${RESET:-}  ${DIM:-}(read the warning first)${RESET:-}"
        else
            echo -e "  ${DIM:-}2) Update to upstream latest — nothing newer than the pin${RESET:-}"
        fi
        if [[ -n "$prev" ]]; then
            echo -e "  ${YELLOW:-}3${RESET:-}) Roll back to ${BOLD:-}${prev}${RESET:-}  ${DIM:-}(urgent undo)${RESET:-}"
        else
            echo -e "  ${DIM:-}3) Roll back — no previous version recorded${RESET:-}"
        fi
        echo -e "  ${GREEN:-}4${RESET:-}) Pick any cached version"
        echo -e "  ${GREEN:-}5${RESET:-}) Re-verify the installed binary"
        echo -e "  ${GREEN:-}6${RESET:-}) Prune cached versions"
        echo -e "  ${DIM:-}0) Back${RESET:-}"
        echo ""
        echo -ne "${BOLD:-}Select [1-6/0]: ${RESET:-}"
        local c; read -r c || c=0

        case "$c" in
            "") continue ;;
            1)  echo ""
                if gwi_fetch_version "$pin" && gwi_apply_version "$dest" "$GWI_STORE_TAG"; then
                    _gwi_restart_prompt "$bin" "$stop_cmd" "$start_cmd"
                fi
                _gwi_pause ;;
            2)  if [[ -z "$latest" || "$latest" == "$pin" ]]; then
                    warn "Nothing newer than the pin."; sleep 1; continue
                fi
                echo ""
                warn "Moving OFF the pin ($pin → $latest)."
                warn "This toolkit feeds wallet passphrases on STDIN, which works only"
                warn "because grin-wallet 5.4.1 pins rpassword 4.x. rpassword 7 reads"
                warn "/dev/tty instead — on such a release every unattended listener"
                warn "unlock breaks. Verify the new release before you keep it."
                if [[ -n "$cur" ]]; then
                    info "Rollback to $cur stays one keypress away once this is applied."
                else
                    info "The binary in place now is snapshotted first, so this stays undoable."
                fi
                echo -ne "  Type the tag '$latest' to confirm: "
                local typed; read -r typed || true
                if [[ "$typed" != "$latest" ]]; then
                    info "Cancelled — nothing was changed."; _gwi_pause; continue
                fi
                if gwi_fetch_version "$latest" && gwi_apply_version "$dest" "$GWI_STORE_TAG"; then
                    _gwi_restart_prompt "$bin" "$stop_cmd" "$start_cmd"
                fi
                _gwi_pause ;;
            3)  if [[ -z "$prev" ]]; then warn "No rollback target."; sleep 1; continue; fi
                echo ""
                echo -ne "  Roll back to $prev? [y/N]: "
                local ryn; read -r ryn || true
                if [[ "${ryn,,}" == "y" ]]; then
                    if gwi_rollback "$dest" "$prev"; then
                        _gwi_restart_prompt "$bin" "$stop_cmd" "$start_cmd"
                    fi
                else
                    info "Cancelled."
                fi
                _gwi_pause ;;
            4)  echo ""
                local -a cached=()
                local i=1 t
                while read -r t; do
                    if [[ -n "$t" ]]; then cached+=("$t"); fi
                done < <(gwi_list_cached)
                if [[ ${#cached[@]} -eq 0 ]]; then
                    info "The store is empty — install a version first."; _gwi_pause; continue
                fi
                echo -e "  ${BOLD:-}Cached versions${RESET:-}"
                for t in "${cached[@]}"; do
                    if [[ "$t" == "$cur" ]]; then
                        echo -e "    ${i}) $t  ${DIM:-}(installed)${RESET:-}"
                    else
                        echo -e "    ${i}) $t"
                    fi
                    i=$((i+1))
                done
                echo ""
                echo -ne "  Select [1-${#cached[@]}/0 cancel]: "
                local sel; read -r sel || true
                if [[ "$sel" =~ ^[0-9]+$ ]] && (( sel >= 1 && sel <= ${#cached[@]} )); then
                    if gwi_apply_version "$dest" "${cached[$((sel-1))]}"; then
                        _gwi_restart_prompt "$bin" "$stop_cmd" "$start_cmd"
                    fi
                else
                    info "Cancelled."
                fi
                _gwi_pause ;;
            5)  echo ""
                if [[ ! -x "$bin" ]]; then
                    warn "No binary installed at $bin."
                elif [[ -z "$cur" ]]; then
                    warn "No tag recorded — cannot compare against the store."
                    info "Installed reports: $(gwi_binary_version "$bin")"
                else
                    local a b
                    a=$(sha256sum "$bin" 2>/dev/null | awk '{print $1}')
                    b=$(sha256sum "$(_gwi_store_tag_bin "$cur")" 2>/dev/null | awk '{print $1}')
                    if [[ -n "$a" && "$a" == "$b" ]]; then
                        success "Installed binary matches stored $cur (sha256)."
                    elif [[ -z "$b" ]]; then
                        warn "Stored $cur is gone from $GWI_STORE_DIR — cannot compare."
                    else
                        error "Installed binary DIFFERS from stored $cur."
                        error "  installed: ${a:-?}"
                        error "  stored   : ${b:-?}"
                    fi
                fi
                _gwi_pause ;;
            6)  _gwi_prune_screen "$dest"; _gwi_pause ;;
            0)  return 0 ;;
            *)  warn "Invalid option."; sleep 1 ;;
        esac
    done
}
