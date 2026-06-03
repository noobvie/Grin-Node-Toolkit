# =============================================================================
# lib/grin_wallet_install.sh — grin-wallet binary download + verify (shared)
# =============================================================================
# Factored from Script 05's CMD-wallet download step so Script 07's central
# wallet (and later 05/051/052) share ONE download/verify implementation.
#
#   gwi_install_grin_wallet <dest_dir> [force]
#       Download the latest grin-wallet linux-x86_64 release, verify its
#       checksum when the release publishes one, and install the binary to
#       <dest_dir>/grin-wallet (chmod 755).
#       · force=1 re-downloads even if a binary already exists.
#       On success sets:  GWI_WALLET_BIN  GWI_INSTALLED_VERSION   (rc 0)
#       On failure: rc 1 (caller decides whether to abort).
#
# Convention: sourced lib → NO shebang / NO `set -e`.
# =============================================================================

[[ -n "${_GRIN_WALLET_INSTALL_SH_LOADED:-}" ]] && return 0
_GRIN_WALLET_INSTALL_SH_LOADED=1

GWI_GITHUB_API="${GWI_GITHUB_API:-https://api.github.com/repos/mimblewimble/grin-wallet/releases/latest}"
GWI_WALLET_BIN=""
GWI_INSTALLED_VERSION=""

# Logging fallbacks (an interactive caller already defines richer versions).
if ! declare -F info    >/dev/null 2>&1; then info()    { echo "[INFO]  $*"; }; fi
if ! declare -F warn    >/dev/null 2>&1; then warn()    { echo "[WARN]  $*"; }; fi
if ! declare -F error   >/dev/null 2>&1; then error()   { echo "[ERROR] $*" >&2; }; fi
if ! declare -F success >/dev/null 2>&1; then success() { echo "[OK]    $*"; }; fi

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

# gwi_install_grin_wallet <dest_dir> [force]
gwi_install_grin_wallet() {
    local dest_dir="${1:-}" force="${2:-0}"
    GWI_WALLET_BIN=""; GWI_INSTALLED_VERSION=""

    [[ -n "$dest_dir" ]] || { error "gwi_install_grin_wallet: dest_dir required."; return 1; }
    local wallet_bin="$dest_dir/grin-wallet"

    # Already installed and not forced → report and return.
    if [[ -x "$wallet_bin" && "$force" != "1" ]]; then
        local ver; ver=$("$wallet_bin" --version 2>/dev/null | head -1 || echo "unknown")
        GWI_WALLET_BIN="$wallet_bin"; GWI_INSTALLED_VERSION="$ver"
        info "grin-wallet already installed: $wallet_bin ($ver)"
        return 0
    fi

    command -v curl &>/dev/null || { error "curl not found."; return 1; }
    command -v wget &>/dev/null || { error "wget not found."; return 1; }
    command -v tar  &>/dev/null || { error "tar not found.";  return 1; }
    _gwi_ensure_jq || { error "jq not found and could not be installed."; return 1; }

    info "Fetching latest grin-wallet release from GitHub..."
    local release_json
    release_json=$(curl -fsSL --max-time 30 "$GWI_GITHUB_API") \
        || { error "Failed to reach GitHub API ($GWI_GITHUB_API)."; return 1; }

    local version tar_url sum_url
    version=$(echo "$release_json" | jq -r '.tag_name // empty')
    tar_url=$(echo "$release_json" \
        | jq -r '.assets[] | select(.name | test("linux-x86_64\\.tar\\.gz$"; "i")) | .browser_download_url' \
        | head -1)
    # Optional checksum asset (…linux-x86_64.tar.gz.sha256sum / .sha256).
    sum_url=$(echo "$release_json" \
        | jq -r '.assets[] | select(.name | test("linux-x86_64\\.tar\\.gz\\.(sha256sum|sha256)$"; "i")) | .browser_download_url' \
        | head -1)

    if [[ -z "$tar_url" || "$tar_url" == "null" ]]; then
        error "No linux-x86_64 asset found for grin-wallet ${version:-?}."
        return 1
    fi

    mkdir -p "$dest_dir"
    local tmp_tar="/tmp/grin_wallet_dl_$$.tar.gz"
    local tmp_dir="/tmp/grin_wallet_extract_$$"
    mkdir -p "$tmp_dir"
    # Clean temp files on any return path. A RETURN trap is GLOBAL (not
    # function-scoped without `set -T`), so it would otherwise fire again when
    # the CALLER returns — by then $tmp_tar/$tmp_dir are out of scope and
    # `set -u` aborts with "unbound variable". Guard with :- and self-clear
    # the trap (`trap - RETURN`) so it only runs once, here.
    trap 'rm -rf "${tmp_tar:-}" "${tmp_dir:-}" 2>/dev/null || true; trap - RETURN' RETURN

    info "Version : ${version:-unknown}"
    info "Target  : $wallet_bin"
    wget -c -q -O "$tmp_tar" "$tar_url" \
        || { error "Download failed: $tar_url"; return 1; }

    # ── Verify checksum when the release publishes one ──────────────────────
    if [[ -n "$sum_url" && "$sum_url" != "null" ]]; then
        local tmp_sum="/tmp/grin_wallet_sum_$$"
        if wget -c -q -O "$tmp_sum" "$sum_url"; then
            local expected actual
            expected=$(awk '{print $1; exit}' "$tmp_sum" 2>/dev/null | tr -d '[:space:]')
            actual=$(sha256sum "$tmp_tar" 2>/dev/null | awk '{print $1}')
            rm -f "$tmp_sum"
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
                warn "Could not compute/parse checksum — proceeding unverified."
            fi
        else
            warn "Checksum asset present but download failed — proceeding unverified."
        fi
    else
        warn "Release publishes no checksum asset — installed binary is unverified."
    fi

    tar -xzf "$tmp_tar" -C "$tmp_dir" \
        || { error "Extraction failed."; return 1; }

    local bin_src
    bin_src=$(find "$tmp_dir" -type f -name "grin-wallet" | head -1)
    [[ -n "$bin_src" ]] || { error "grin-wallet binary not found in archive."; return 1; }

    install -m 755 "$bin_src" "$wallet_bin" \
        || { error "Failed to install binary to $wallet_bin."; return 1; }

    GWI_WALLET_BIN="$wallet_bin"
    GWI_INSTALLED_VERSION="${version:-unknown}"
    success "grin-wallet ${version:-} installed: $wallet_bin"
    return 0
}
