# =============================================================================
# lib/01_lib_source_build.sh — compile the grin node binary from git source
# =============================================================================
# Sourced by 01_build_new_grin_node.sh. Reached from the Step-1 menus with key G.
#
#   WHY THIS EXISTS
#     Script 01 normally installs the newest *release* asset from the GitHub API
#     (`download_grin_binary` / `update_binary_only`). When a fix lands on the
#     `staging` branch but no tagged release carries a linux-x86_64 tarball yet,
#     there is no supported way to test it. This lib compiles a chosen git ref
#     (branch, tag or commit) locally and installs the result the same way the
#     release path does — so the operator can test an unreleased node without
#     hand-rolling a build outside the toolkit.
#
#   PUBLIC ENTRY
#     gsb_menu                 build / install / roll back / purge submenu
#                              (all-numeric keys: 1 build, 2 install, 3 use for
#                              this session's build, 4 roll back, 5 purge, 0 back)
#
#   ARTIFACTS + STATE
#     /opt/grin/src/grin                         git checkout (kept — fast rebuilds)
#     /opt/grin/bin/grin-<ver>-<ref>-<sha>       built binaries, never auto-deleted
#     /opt/grin/bin/grin-<ver>-replaced-<sha8>   archived copy of a binary that was
#                                                overwritten (usually the release)
#     /opt/grin/bin/grin-<...>.info              provenance sidecar for each of the above
#     <node_dir>/grin.prev                       the binary this one replaced
#     <node_dir>/.grin_binary_info               what is installed + how to roll back
#
#   TWO BACKUPS, TWO JOBS — not redundancy
#     grin.prev is the 02:00 recovery: same directory, one cp, no path lookup, no
#     network. But it holds ONE generation and dies with the node dir. The
#     /opt/grin/bin archive is the durable one: it survives a rebuild and keeps
#     every distinct binary. Neither replaces the other. Backups do NOT go to
#     /opt/grin/backups — that directory holds encrypted dated tarballs written
#     by the shared backup engine, not bare executables.
#
#   ROLLBACK IS PART OF THE FEATURE, NOT AN EXTRA
#     A source build is by definition untested code. Installing one always keeps
#     the replaced binary as <node_dir>/grin.prev, and option 4 puts it back. An
#     operator who bricks mainnet at 02:00 must not need this file to recover —
#     the restore command is printed after every install and written into
#     .grin_binary_info next to the binary itself. (Submenu option 4.)
#
#   Conventions: sourced lib → NO shebang, NO `set -e` of its own. It runs under
#   the caller's `set -euo pipefail`, so every fallible command is guarded.
#   Borrowed from Script 01 at call time (never at source time): info/warn/error/
#   success/die/log/step_header, stop_grin_gracefully, start_grin_tmux,
#   ensure_swap_and_tuning, $INSTANCES_CONF, colour vars.
# =============================================================================

[[ -n "${_GRIN_01_SOURCE_BUILD_SH_LOADED:-}" ]] && return 0
_GRIN_01_SOURCE_BUILD_SH_LOADED=1

GSB_REPO="${GSB_REPO:-https://github.com/mimblewimble/grin.git}"
GSB_SRC_DIR="${GSB_SRC_DIR:-/opt/grin/src/grin}"
GSB_BIN_DIR="${GSB_BIN_DIR:-/opt/grin/bin}"
GSB_DEFAULT_REF="${GSB_DEFAULT_REF:-staging}"

# Last artifact produced/selected in this session (path to a grin binary).
GSB_ARTIFACT=""

# Filled by _gsb_collect_instances.
GSB_INST_DIRS=()
GSB_INST_NETS=()

# -----------------------------------------------------------------------------
# _gsb_have — true when the caller provided a helper we depend on.
# -----------------------------------------------------------------------------
_gsb_have() { declare -F "$1" >/dev/null 2>&1; }

# -----------------------------------------------------------------------------
# _gsb_pause — uniform "press Enter" that never trips `set -e`.
# -----------------------------------------------------------------------------
_gsb_pause() {
    echo ""
    echo -ne "${DIM}Press Enter to continue...${RESET}"
    read -r _ || true
    echo ""
}

# -----------------------------------------------------------------------------
# _gsb_confirm <prompt> [default:yn]  → 0 = yes, 1 = no
# -----------------------------------------------------------------------------
_gsb_confirm() {
    local prompt="$1" def="${2:-n}" ans=""
    if [[ "$def" == "y" ]]; then
        echo -ne "${BOLD}${prompt} [Y/n]: ${RESET}"
    else
        echo -ne "${BOLD}${prompt} [y/N]: ${RESET}"
    fi
    read -r ans || true
    [[ -z "$ans" ]] && ans="$def"
    case "${ans,,}" in
        y|yes) return 0 ;;
        *)     return 1 ;;
    esac
}

# -----------------------------------------------------------------------------
# _gsb_slug <ref> — filename-safe form of a git ref (feature/x → feature-x).
# -----------------------------------------------------------------------------
_gsb_slug() { echo "$1" | tr '/' '-' | tr -cd '[:alnum:]._-'; }

# =============================================================================
# PREFLIGHT
# =============================================================================

# -----------------------------------------------------------------------------
# _gsb_install_build_deps — compiler toolchain + headers grin needs.
# Package sets follow grin's own INSTALL.md. Missing-only, so re-running is free.
# -----------------------------------------------------------------------------
_gsb_install_build_deps() {
    info "Checking build dependencies..."
    local -a pkgs=() missing=()
    local pkg

    if command -v dnf &>/dev/null; then
        pkgs=(gcc gcc-c++ make cmake git clang llvm-devel clang-devel
              ncurses-devel zlib-devel openssl-devel pkgconf-pkg-config)
        for pkg in "${pkgs[@]}"; do
            rpm -q "$pkg" &>/dev/null 2>&1 || missing+=("$pkg")
        done
        if [[ ${#missing[@]} -gt 0 ]]; then
            info "Installing: ${missing[*]}"
            dnf install -y -q "${missing[@]}" || {
                error "Failed to install build dependencies: ${missing[*]}"
                return 1
            }
        fi
    else
        # libncurses5-dev was dropped in Ubuntu 24.04; libncurses-dev is the
        # forward-compatible name and exists on Debian 11+.
        local ncurses_dev="libncurses-dev"
        apt-cache show libncurses-dev &>/dev/null 2>&1 || ncurses_dev="libncurses5-dev"

        pkgs=(build-essential cmake git clang llvm libclang-dev
              "$ncurses_dev" zlib1g-dev pkg-config libssl-dev)
        for pkg in "${pkgs[@]}"; do
            dpkg -s "$pkg" &>/dev/null 2>&1 || missing+=("$pkg")
        done
        if [[ ${#missing[@]} -gt 0 ]]; then
            info "Installing: ${missing[*]}"
            apt-get update -qq || warn "apt-get update reported errors — continuing."
            apt-get install -y -qq "${missing[@]}" || {
                error "Failed to install build dependencies: ${missing[*]}"
                return 1
            }
        fi
    fi

    success "Build dependencies present."
    return 0
}

# -----------------------------------------------------------------------------
# _gsb_ensure_rust — cargo on PATH, installing rustup (minimal profile) if absent.
# rustup installs into $HOME/.cargo for the CURRENT user (root here); the shell
# that ran the installer does not get the PATH change, so we export it ourselves.
# -----------------------------------------------------------------------------
_gsb_ensure_rust() {
    export PATH="$HOME/.cargo/bin:$PATH"

    if command -v cargo &>/dev/null; then
        success "Rust present: $(cargo --version 2>/dev/null || echo 'cargo')"
        return 0
    fi

    info "Installing Rust via rustup (minimal profile — one-time, ~1 min)..."
    curl --proto '=https' --tlsv1.2 -fsS https://sh.rustup.rs \
        | sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path \
        || { error "rustup install failed."; return 1; }

    export PATH="$HOME/.cargo/bin:$PATH"
    if ! command -v cargo &>/dev/null; then
        error "cargo still not on PATH after rustup install."
        return 1
    fi
    success "Rust installed: $(cargo --version 2>/dev/null || echo 'cargo')"
    return 0
}

# -----------------------------------------------------------------------------
# _gsb_check_resources — disk + RAM guards before a 20-40 minute build.
# A cargo build of grin needs ~4-5 GB for target/ and peaks well above 1 GB RSS
# during linking; on a 1-2 GB VPS the linker is what gets OOM-killed, an hour in.
# ensure_swap_and_tuning (Script 01) already creates a 2-4 GB swapfile when swap
# is short, so reuse it rather than inventing a second swap path.
# -----------------------------------------------------------------------------
_gsb_check_resources() {
    local free_mb
    free_mb=$(df -Pm "$(dirname "$GSB_SRC_DIR")" 2>/dev/null | awk 'NR==2{print $4}' || true)
    [[ -z "$free_mb" ]] && free_mb=$(df -Pm /opt | awk 'NR==2{print $4}' || echo 0)

    if (( free_mb < 6144 )); then
        warn "Only ${free_mb} MB free where the source tree lives ($(dirname "$GSB_SRC_DIR"))."
        warn "A release build needs roughly 5 GB for target/ plus the checkout."
        if ! _gsb_confirm "Continue anyway?" n; then
            info "Build cancelled."
            return 1
        fi
    else
        success "Disk space OK (${free_mb} MB free)."
    fi

    local mem_mb swap_mb
    mem_mb=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
    swap_mb=$(awk '/SwapTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
    info "RAM: ${mem_mb} MB   Swap: ${swap_mb} MB"

    if (( mem_mb + swap_mb < 3000 )); then
        warn "Under ~3 GB RAM+swap — the linker is likely to be OOM-killed."
        if _gsb_have ensure_swap_and_tuning; then
            if _gsb_confirm "Add/verify swap now (Script 01's swap step)?" y; then
                ensure_swap_and_tuning || warn "Swap step reported a problem — continuing."
                swap_mb=$(awk '/SwapTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
                info "Swap now: ${swap_mb} MB"
            fi
        fi
    fi

    # An SSH drop kills a foreground cargo build outright. tmux/screen is the fix.
    if [[ -z "${TMUX:-}" && -z "${STY:-}" ]]; then
        echo ""
        warn "This shell is NOT inside tmux or screen."
        warn "A dropped SSH session will kill the build partway through."
        info  "Recommended: answer N below, leave the menu with 0, then run"
        info  "  ${BOLD}tmux new -s grinbuild${RESET}${CYAN}  and start the toolkit again inside it."
        echo ""
        if ! _gsb_confirm "Build anyway in this shell?" n; then
            info "Build cancelled."
            return 1
        fi
    fi

    return 0
}

# =============================================================================
# SOURCE FETCH + COMPILE
# =============================================================================

# -----------------------------------------------------------------------------
# _gsb_fetch_source <ref> — clone or update $GSB_SRC_DIR and check out <ref>.
# A branch is pinned to origin/<ref> with a hard reset so a re-run always builds
# what upstream has now, not a stale local branch. Tags/commits are checked out
# detached. target/ is never cleaned — that cache is what makes a rebuild minutes
# instead of an hour.
# -----------------------------------------------------------------------------
_gsb_fetch_source() {
    local ref="$1"
    mkdir -p "$(dirname "$GSB_SRC_DIR")"

    if [[ -d "$GSB_SRC_DIR/.git" ]]; then
        info "Updating existing checkout: $GSB_SRC_DIR"
        git -C "$GSB_SRC_DIR" fetch --all --tags --prune \
            || { error "git fetch failed. Check internet access."; return 1; }
    else
        if [[ -e "$GSB_SRC_DIR" ]]; then
            warn "$GSB_SRC_DIR exists but is not a git checkout — replacing it."
            rm -rf "$GSB_SRC_DIR"
        fi
        info "Cloning $GSB_REPO ..."
        git clone "$GSB_REPO" "$GSB_SRC_DIR" \
            || { error "git clone failed. Check internet access."; return 1; }
    fi

    # Discard local modifications so a checkout can never fail on a dirty tree.
    git -C "$GSB_SRC_DIR" reset --hard --quiet HEAD 2>/dev/null || true

    if git -C "$GSB_SRC_DIR" rev-parse --verify -q "origin/$ref^{commit}" >/dev/null 2>&1; then
        info "Checking out branch '$ref' (tracking origin/$ref)..."
        git -C "$GSB_SRC_DIR" checkout -B "$ref" "origin/$ref" --quiet \
            || { error "Could not check out branch '$ref'."; return 1; }
        git -C "$GSB_SRC_DIR" reset --hard --quiet "origin/$ref" || true
    elif git -C "$GSB_SRC_DIR" rev-parse --verify -q "$ref^{commit}" >/dev/null 2>&1; then
        info "Checking out '$ref' (tag or commit, detached HEAD)..."
        git -C "$GSB_SRC_DIR" checkout --detach "$ref" --quiet \
            || { error "Could not check out '$ref'."; return 1; }
    else
        error "Ref '$ref' not found in $GSB_REPO (no branch, tag or commit matches)."
        info  "Branches:  git -C $GSB_SRC_DIR branch -r"
        info  "Tags:      git -C $GSB_SRC_DIR tag --sort=-creatordate | head"
        return 1
    fi

    git -C "$GSB_SRC_DIR" submodule update --init --recursive --quiet 2>/dev/null || true
    return 0
}

# -----------------------------------------------------------------------------
# _gsb_compile — cargo build --release, with a job cap on small boxes.
# rustc runs one process per parallel job and each can hold hundreds of MB, so on
# a small VPS the default (one job per core) is the usual OOM cause.
# -----------------------------------------------------------------------------
_gsb_compile() {
    local mem_mb jobs_arg=""
    mem_mb=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
    if   (( mem_mb > 0 && mem_mb < 2600 )); then jobs_arg="-j1"
    elif (( mem_mb > 0 && mem_mb < 5200 )); then jobs_arg="-j2"
    fi
    [[ -n "$jobs_arg" ]] && info "Limiting cargo to ${jobs_arg#-j} parallel job(s) (RAM ${mem_mb} MB)."

    echo ""
    info "Compiling — this takes roughly 20-45 minutes on a small VPS."
    info "Leave this window open; output below is cargo's."
    echo ""

    local t0 t1
    t0=$(date +%s)
    if ! ( cd "$GSB_SRC_DIR" && cargo build --release ${jobs_arg:+$jobs_arg} ); then
        echo ""
        error "cargo build failed."
        info  "Common causes:"
        info  "  · out of RAM  → add swap, or re-run (the job cap applies from 5 GB down)"
        info  "  · out of disk → df -h $(dirname "$GSB_SRC_DIR")"
        info  "  · stale Rust  → rustup update stable, then rebuild"
        return 1
    fi
    t1=$(date +%s)
    success "Build finished in $(( (t1 - t0) / 60 ))m $(( (t1 - t0) % 60 ))s."
    return 0
}

# -----------------------------------------------------------------------------
# _gsb_stash_artifact <ref> — verify the fresh binary and copy it to $GSB_BIN_DIR
# under a name that records version + ref + commit. Sets GSB_ARTIFACT.
# -----------------------------------------------------------------------------
_gsb_stash_artifact() {
    local ref="$1"
    local built="$GSB_SRC_DIR/target/release/grin"

    if [[ ! -x "$built" ]]; then
        error "Build reported success but $built is missing."
        return 1
    fi

    # Run it once. A binary that cannot even print its version must never reach
    # a node directory.
    local ver_line=""
    ver_line=$("$built" --version 2>/dev/null | head -1 || true)
    if [[ -z "$ver_line" ]]; then
        error "The compiled binary did not respond to --version — refusing to keep it."
        return 1
    fi
    success "Compiled binary reports: $ver_line"

    local ver=""
    ver=$(echo "$ver_line" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[^ ]*' | head -1 || true)
    if [[ -z "$ver" ]]; then
        ver=$(grep -m1 '^version' "$GSB_SRC_DIR/Cargo.toml" 2>/dev/null | cut -d'"' -f2 || true)
    fi
    [[ -z "$ver" ]] && ver="unknown"

    local sha="" head_ref=""
    sha=$(git -C "$GSB_SRC_DIR" rev-parse --short HEAD 2>/dev/null || echo "nosha")
    head_ref=$(git -C "$GSB_SRC_DIR" log -1 --format='%s' 2>/dev/null || true)

    mkdir -p "$GSB_BIN_DIR"
    local name="grin-${ver}-$(_gsb_slug "$ref")-${sha}"
    local dest="$GSB_BIN_DIR/$name"

    install -m 755 "$built" "$dest" || { error "Could not copy binary to $dest."; return 1; }

    cat > "$dest.info" <<EOF
# Grin Node Toolkit — source build provenance
built_utc   = $(date -u '+%Y-%m-%d %H:%M:%S UTC')
repo        = $GSB_REPO
ref         = $ref
commit      = $(git -C "$GSB_SRC_DIR" rev-parse HEAD 2>/dev/null || echo unknown)
commit_msg  = $head_ref
version     = $ver
version_str = $ver_line
built_on    = $(uname -srm 2>/dev/null || echo unknown) / $(hostname 2>/dev/null || echo unknown)
source_dir  = $GSB_SRC_DIR
EOF

    GSB_ARTIFACT="$dest"
    echo ""
    success "Artifact saved: $dest"
    info    "Provenance:     $dest.info"
    _gsb_have log && log "[SOURCE BUILD] ref=$ref commit=$sha version=$ver artifact=$dest"
    return 0
}

# =============================================================================
# ARTIFACTS + INSTANCES
# =============================================================================

# -----------------------------------------------------------------------------
# _gsb_list_artifacts — print previously built binaries, newest first.
# Echoes paths one per line (callers read into an array); prints nothing if none.
# -----------------------------------------------------------------------------
_gsb_list_artifacts() {
    [[ -d "$GSB_BIN_DIR" ]] || return 0
    find "$GSB_BIN_DIR" -maxdepth 1 -type f -name 'grin-*' ! -name '*.info' \
        -printf '%T@ %p\n' 2>/dev/null | sort -rn | cut -d' ' -f2- || true
}

# -----------------------------------------------------------------------------
# _gsb_pick_artifact — set GSB_ARTIFACT from the stash. Returns 1 on cancel/none.
# -----------------------------------------------------------------------------
_gsb_pick_artifact() {
    local -a arts=()
    local line
    while IFS= read -r line; do
        [[ -n "$line" ]] && arts+=("$line")
    done < <(_gsb_list_artifacts)

    if [[ ${#arts[@]} -eq 0 ]]; then
        warn "No source-built binaries in $GSB_BIN_DIR yet — run a build first."
        return 1
    fi

    if [[ ${#arts[@]} -eq 1 ]]; then
        GSB_ARTIFACT="${arts[0]}"
        info "Using: $(basename "$GSB_ARTIFACT")"
        return 0
    fi

    echo ""
    echo -e "  ${BOLD}Available source builds:${RESET}"
    local i
    for i in "${!arts[@]}"; do
        echo -e "    ${GREEN}$((i + 1))${RESET}) $(basename "${arts[$i]}")"
    done
    echo -e "    ${DIM}0${RESET}) Cancel"
    echo ""
    echo -ne "${BOLD}Choose: ${RESET}"
    local pick=""
    read -r pick || true
    if [[ "$pick" =~ ^[1-9][0-9]*$ ]] && (( pick >= 1 && pick <= ${#arts[@]} )); then
        GSB_ARTIFACT="${arts[$((pick - 1))]}"
        return 0
    fi
    info "Cancelled."
    return 1
}

# -----------------------------------------------------------------------------
# _gsb_net_known <mainnet|testnet> — true when that network is already collected.
# -----------------------------------------------------------------------------
_gsb_net_known() {
    local want="$1" n
    for n in ${GSB_INST_NETS[@]+"${GSB_INST_NETS[@]}"}; do
        [[ "$n" == "$want" ]] && return 0
    done
    return 1
}

# -----------------------------------------------------------------------------
# _gsb_collect_instances — installed nodes, from INSTANCES_CONF first (it holds
# custom paths) then the standard /opt/grin/node/* layout for anything missing.
# Fills GSB_INST_DIRS / GSB_INST_NETS.
#
# Deduped by NETWORK, not by directory. A server hosts at most one node per
# network (Step 1 enforces it), but a mainnet prune→full rebuild only rewrites
# INSTANCES_CONF — it does not delete the old directory, so a box can carry both
# /opt/grin/node/mainnet-full and .../mainnet-prune with a binary in each. Keyed
# by directory, both would be collected, and the install/rollback loops would
# start two mainnet nodes fighting over port 3414 ("lock file is held by another
# grin process"). Conf entries win; the filesystem scan only fills gaps, and
# scans mainnet-full first to match grin_live_node_dir's archive-first order.
# -----------------------------------------------------------------------------
_gsb_collect_instances() {
    GSB_INST_DIRS=()
    GSB_INST_NETS=()

    local key varname dir net
    # Sourcing leaves the keys set as ordinary shell variables, and this function
    # is called again on every menu redraw. A mainnet prune→full rebuild DELETES
    # PRUNEMAIN_ from the conf, but a stale PRUNEMAIN_GRIN_DIR from an earlier
    # source (here, or update_binary_only's) would still resolve — and win, since
    # PRUNEMAIN is read before FULLMAIN. Clear them so only what the conf declares
    # right now is considered.
    unset PRUNEMAIN_GRIN_DIR FULLMAIN_GRIN_DIR PRUNETEST_GRIN_DIR
    if [[ -n "${INSTANCES_CONF:-}" && -f "${INSTANCES_CONF:-}" ]]; then
        # shellcheck source=/dev/null
        source "$INSTANCES_CONF" 2>/dev/null || true
        for key in PRUNEMAIN FULLMAIN PRUNETEST; do
            varname="${key}_GRIN_DIR"
            dir="${!varname:-}"
            [[ -n "$dir" && -x "$dir/grin" ]] || continue
            net="mainnet"
            [[ "$key" == "PRUNETEST" ]] && net="testnet"
            _gsb_net_known "$net" && continue
            GSB_INST_DIRS+=("$dir")
            GSB_INST_NETS+=("$net")
        done
    fi

    local -a scan_dirs=(/opt/grin/node/mainnet-full /opt/grin/node/mainnet-prune /opt/grin/node/testnet-prune)
    local -a scan_nets=(mainnet mainnet testnet)
    local i
    for i in "${!scan_dirs[@]}"; do
        [[ -x "${scan_dirs[$i]}/grin" ]] || continue
        _gsb_net_known "${scan_nets[$i]}" && continue
        GSB_INST_DIRS+=("${scan_dirs[$i]}")
        GSB_INST_NETS+=("${scan_nets[$i]}")
    done

    [[ ${#GSB_INST_DIRS[@]} -gt 0 ]]
}

# -----------------------------------------------------------------------------
# _gsb_binary_desc <dir> — one-line "what is installed here" for menus.
# -----------------------------------------------------------------------------
_gsb_binary_desc() {
    local dir="$1" v=""
    [[ -x "$dir/grin" ]] || { echo "no binary"; return 0; }
    v=$("$dir/grin" --version 2>/dev/null | head -1 || true)
    [[ -z "$v" ]] && v="unreadable"
    if [[ -f "$dir/.grin_binary_info" ]]; then
        local src=""
        src=$(grep -m1 '^source_ref' "$dir/.grin_binary_info" 2>/dev/null | cut -d= -f2- | tr -d ' ' || true)
        [[ -n "$src" ]] && v="$v  (source build: $src)"
    fi
    echo "$v"
}

# =============================================================================
# INSTALL + ROLLBACK
# =============================================================================

# -----------------------------------------------------------------------------
# gsb_archive_replaced <node_dir> — keep a copy of the binary about to be
# overwritten in $GSB_BIN_DIR, so it outlives the node directory.
#
# PUBLIC: Script 01's update_binary_only calls this too, so a release update and
# a source install archive the same way.
#
# WHY: <node_dir>/grin.prev is the fast rollback, but it dies with the node dir
# (_remove_instance_dirs does `rm -rf`) and only ever holds ONE generation — two
# source installs in a row and the original release is gone. Source builds are
# already safe: they live in $GSB_BIN_DIR permanently. The binary that has NO
# other copy anywhere is the RELEASE one, because it came from a GitHub tarball
# extracted to /tmp and thrown away. That is what this rescues, into the store
# that already holds binaries — not /opt/grin/backups, which holds encrypted
# dated tarballs and would not know what to do with a bare executable.
#
# Best-effort by design: an archiving failure must never block an install, since
# grin.prev is written either way. Always returns 0.
# -----------------------------------------------------------------------------
gsb_archive_replaced() {
    local dir="$1" bin="$1/grin"
    [[ -x "$bin" ]] || return 0

    # A binary this lib installed is already in $GSB_BIN_DIR under its own
    # provenance name — re-archiving it would just duplicate it under a second.
    if [[ -f "$dir/.grin_binary_info" ]] && grep -q '^source_ref' "$dir/.grin_binary_info" 2>/dev/null; then
        return 0
    fi

    local ver="" sha8=""
    ver=$("$bin" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[^ ]*' | head -1 || true)
    [[ -z "$ver" ]] && ver="unknown"
    # Content-addressed id: re-archiving the same binary is a no-op instead of
    # accumulating one copy per install. Falls back to a date if sha256sum is absent.
    sha8=$(sha256sum "$bin" 2>/dev/null | cut -c1-8 || true)
    [[ -z "$sha8" ]] && sha8="$(date -u +%Y%m%d)"

    mkdir -p "$GSB_BIN_DIR" 2>/dev/null || true
    local dest="$GSB_BIN_DIR/grin-${ver}-replaced-${sha8}"
    if [[ -e "$dest" ]]; then
        info "Replaced binary is already archived as $(basename "$dest")."
        return 0
    fi

    if install -m 755 "$bin" "$dest" 2>/dev/null; then
        cat > "$dest.info" <<EOF
# Grin Node Toolkit — archived copy of a replaced node binary
archived_utc = $(date -u '+%Y-%m-%d %H:%M:%S UTC')
origin       = $bin
version_str  = $("$bin" --version 2>/dev/null | head -1 || echo unknown)
version      = $ver
sha256       = $(sha256sum "$bin" 2>/dev/null | cut -d' ' -f1 || echo unknown)
note         = Not a source build. Kept so a rollback survives the node directory
note         = being deleted, and so two source installs in a row cannot lose it.
EOF
        success "Archived the replaced binary → $(basename "$dest")"
        _gsb_have log && log "[SOURCE BUILD] archived replaced binary $bin → $dest"
    else
        warn "Could not archive the replaced binary into $GSB_BIN_DIR."
        warn "Rollback still works — <node_dir>/grin.prev is written regardless."
    fi
    return 0
}

# -----------------------------------------------------------------------------
# _gsb_install_to_instances — stop nodes, back up each current binary to
# <dir>/grin.prev, install the artifact, restart. Mirrors update_binary_only's
# flow (same stop/restart primitives) so a source build behaves like a release
# update everywhere else in the toolkit.
# -----------------------------------------------------------------------------
_gsb_install_to_instances() {
    local art="${GSB_ARTIFACT:-}"
    if [[ -z "$art" || ! -x "$art" ]]; then
        error "No built binary selected."
        return 1
    fi

    if ! _gsb_collect_instances; then
        warn "No installed Grin node found — nothing to install into."
        info "Build a node first (Step-1 menu), or use option 3 to have this"
        info "binary picked up by the node build you are about to run."
        return 1
    fi

    echo ""
    echo -e "  ${BOLD}Installing:${RESET} $(basename "$art")"
    echo -e "  ${BOLD}Target node(s):${RESET}"
    local i
    for i in "${!GSB_INST_DIRS[@]}"; do
        echo -e "    ${CYAN}→${RESET} ${GSB_INST_NETS[$i]} — ${DIM}${GSB_INST_DIRS[$i]}${RESET}"
        echo -e "        ${DIM}current: $(_gsb_binary_desc "${GSB_INST_DIRS[$i]}")${RESET}"
    done
    echo ""
    warn "This is an UNRELEASED build. Chain data is not touched, but an"
    warn "incompatible node can refuse to start or fall off the chain."
    info "The replaced binary is kept twice: <node_dir>/grin.prev for a one-key"
    info "rollback, and an archived copy in $GSB_BIN_DIR that survives a rebuild."
    echo ""
    if ! _gsb_confirm "Stop the node(s), swap the binary and restart?" n; then
        info "Cancelled — nothing was changed."
        return 1
    fi

    if _gsb_have stop_grin_gracefully; then
        stop_grin_gracefully || warn "Stop step reported a problem — continuing."
    else
        error "stop_grin_gracefully is unavailable — refusing to swap a running binary."
        return 1
    fi

    local art_ver="" art_ref=""
    art_ver=$("$art" --version 2>/dev/null | head -1 || true)
    # The artifact's .info is appended below as COMMENTS, so the node-level file
    # needs its own uncommented ref line — that is what _gsb_binary_desc reads to
    # flag "this node is running an unreleased build" in the menus.
    #
    # Only a SOURCE BUILD has a 'ref =' line. Option 2 also lists the archived
    # 'grin-<ver>-replaced-<id>' binaries (that is the documented way back when
    # grin.prev is gone), and those are official releases — leaving art_ref empty
    # for them is what stops the menu labelling a release "(source build: ...)".
    if [[ -f "$art.info" ]]; then
        art_ref=$(grep -m1 '^ref[[:space:]]*=' "$art.info" 2>/dev/null | cut -d= -f2- | tr -d ' ' || true)
    fi

    for i in "${!GSB_INST_DIRS[@]}"; do
        local dir="${GSB_INST_DIRS[$i]}" net="${GSB_INST_NETS[$i]}"
        local prev_desc=""
        prev_desc=$(_gsb_binary_desc "$dir")

        if [[ -x "$dir/grin" ]]; then
            # Durable copy first (survives a node-dir wipe), then the fast one.
            gsb_archive_replaced "$dir"
            cp -a "$dir/grin" "$dir/grin.prev" \
                || { error "Could not back up $dir/grin — skipping this node."; continue; }
            info "Backed up current binary → $dir/grin.prev  ($prev_desc)"
        fi

        install -m 755 "$art" "$dir/grin" \
            || { error "Install into $dir failed — leaving grin.prev in place."; continue; }
        chown grin:grin "$dir/grin" 2>/dev/null || true

        local hdr="source build (script 01, key G)"
        [[ -z "$art_ref" ]] && hdr="binary reinstalled from $GSB_BIN_DIR (script 01, key G)"
        cat > "$dir/.grin_binary_info" <<EOF
# Installed by Grin Node Toolkit — $hdr
installed_utc = $(date -u '+%Y-%m-%d %H:%M:%S UTC')
artifact      = $art
version_str   = $art_ver
replaced      = $prev_desc
rollback      = cp -a $dir/grin.prev $dir/grin   # then restart the node
EOF
        # source_ref is the flag _gsb_binary_desc and gsb_archive_replaced both
        # read. Written ONLY for a real source build — an archived release put
        # back through option 2 must not claim to be one.
        [[ -n "$art_ref" ]] && echo "source_ref    = $art_ref" >> "$dir/.grin_binary_info"
        [[ -f "$art.info" ]] && sed 's/^/# /' "$art.info" >> "$dir/.grin_binary_info"

        success "Installed into $dir/grin"

        if _gsb_have start_grin_tmux; then
            GRIN_DIR="$dir"
            NETWORK_TYPE="$net"
            start_grin_tmux || warn "Could not start the $net node — check the log."
        else
            warn "start_grin_tmux unavailable — start the $net node manually."
        fi
    done

    echo ""
    success "Source build installed."
    warn    "Watch the node for a few minutes: it must connect to peers and advance its tip."
    echo -e "  ${BOLD}Roll back${RESET} from this menu with ${GREEN}4${RESET}, or manually:"
    for i in "${!GSB_INST_DIRS[@]}"; do
        echo -e "    ${DIM}cp -a ${GSB_INST_DIRS[$i]}/grin.prev ${GSB_INST_DIRS[$i]}/grin${RESET}"
    done
    _gsb_have log && log "[SOURCE BUILD] installed artifact=$art into ${#GSB_INST_DIRS[@]} instance(s)"
    return 0
}

# -----------------------------------------------------------------------------
# _gsb_restore_previous — put <dir>/grin.prev back and restart. The recovery path
# for "I installed staging and the node will not start".
# -----------------------------------------------------------------------------
_gsb_restore_previous() {
    if ! _gsb_collect_instances; then
        warn "No installed Grin node found."
        return 1
    fi

    local -a cand_dirs=() cand_nets=()
    local i
    for i in "${!GSB_INST_DIRS[@]}"; do
        if [[ -f "${GSB_INST_DIRS[$i]}/grin.prev" ]]; then
            cand_dirs+=("${GSB_INST_DIRS[$i]}")
            cand_nets+=("${GSB_INST_NETS[$i]}")
        fi
    done

    if [[ ${#cand_dirs[@]} -eq 0 ]]; then
        warn "No grin.prev backup found in any node directory — nothing to roll back to."
        info "Two other ways back:"
        info "  · option 2 — reinstall an older binary from $GSB_BIN_DIR"
        info "    (archived 'grin-<ver>-replaced-<id>' entries are previous binaries)"
        info "  · Step-1 menu 'update binary only' — re-download the latest release"
        return 1
    fi

    echo ""
    echo -e "  ${BOLD}Rollback targets:${RESET}"
    for i in "${!cand_dirs[@]}"; do
        echo -e "    ${CYAN}→${RESET} ${cand_nets[$i]} — ${DIM}${cand_dirs[$i]}${RESET}"
        echo -e "        ${DIM}now:      $(_gsb_binary_desc "${cand_dirs[$i]}")${RESET}"
        echo -e "        ${DIM}restores: $("${cand_dirs[$i]}/grin.prev" --version 2>/dev/null | head -1 || echo unreadable)${RESET}"
    done
    echo ""
    if ! _gsb_confirm "Restore the previous binary on the node(s) above?" y; then
        info "Cancelled."
        return 1
    fi

    if _gsb_have stop_grin_gracefully; then
        stop_grin_gracefully || warn "Stop step reported a problem — continuing."
    fi

    for i in "${!cand_dirs[@]}"; do
        local dir="${cand_dirs[$i]}" net="${cand_nets[$i]}"
        # Keep the source build around under its artifact name; grin.prev is
        # consumed by the restore so a second rollback cannot loop endlessly.
        if cp -a "$dir/grin.prev" "$dir/grin"; then
            chown grin:grin "$dir/grin" 2>/dev/null || true
            rm -f "$dir/grin.prev" "$dir/.grin_binary_info"
            success "Restored $dir/grin  ($(_gsb_binary_desc "$dir"))"
        else
            error "Restore failed for $dir — binary left as-is."
            continue
        fi
        if _gsb_have start_grin_tmux; then
            GRIN_DIR="$dir"
            NETWORK_TYPE="$net"
            start_grin_tmux || warn "Could not start the $net node — check the log."
        fi
    done

    _gsb_have log && log "[SOURCE BUILD] rolled back ${#cand_dirs[@]} instance(s)"
    return 0
}

# -----------------------------------------------------------------------------
# _gsb_purge_cache — drop target/ (several GB) but keep the checkout + artifacts.
# -----------------------------------------------------------------------------
_gsb_purge_cache() {
    if [[ ! -d "$GSB_SRC_DIR/target" ]]; then
        info "No build cache to purge."
        return 0
    fi
    local sz=""
    sz=$(du -sh "$GSB_SRC_DIR/target" 2>/dev/null | cut -f1 || true)
    warn "Removing $GSB_SRC_DIR/target (${sz:-unknown}) — the next build starts from scratch."
    if _gsb_confirm "Purge the cargo build cache?" n; then
        rm -rf "$GSB_SRC_DIR/target" && success "Build cache removed."
    else
        info "Kept."
    fi
    return 0
}

# =============================================================================
# BUILD PIPELINE + MENU
# =============================================================================

# -----------------------------------------------------------------------------
# _gsb_build — prompt for a ref and run the whole pipeline.
# -----------------------------------------------------------------------------
_gsb_build() {
    echo ""
    echo -e "  ${BOLD}Which git ref should be compiled?${RESET}"
    echo -e "    ${DIM}staging${RESET}      — upstream integration branch (unreleased fixes)"
    echo -e "    ${DIM}master${RESET}       — upstream stable branch"
    echo -e "    ${DIM}v5.5.1${RESET}       — a tag, when no linux binary was published for it"
    echo -e "    ${DIM}<commit sha>${RESET} — an exact commit"
    echo ""
    echo -ne "${BOLD}Ref [${GSB_DEFAULT_REF}]: ${RESET}"
    local ref=""
    read -r ref || true
    [[ -z "$ref" ]] && ref="$GSB_DEFAULT_REF"

    # Refs go straight into git commands; keep the character set boring.
    if [[ ! "$ref" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]]; then
        error "Invalid ref '$ref' — letters, digits, dot, underscore, dash and slash only."
        return 1
    fi

    echo ""
    _gsb_have step_header && step_header "Source Build: $GSB_REPO @ $ref"

    _gsb_check_resources     || return 1
    _gsb_install_build_deps  || return 1
    _gsb_ensure_rust         || return 1
    _gsb_fetch_source "$ref" || return 1

    local sha="" cver=""
    sha=$(git -C "$GSB_SRC_DIR" rev-parse --short HEAD 2>/dev/null || echo "?")
    cver=$(grep -m1 '^version' "$GSB_SRC_DIR/Cargo.toml" 2>/dev/null | cut -d'"' -f2 || true)
    info "At commit $sha — Cargo.toml declares version ${cver:-unknown}."

    _gsb_compile             || return 1
    _gsb_stash_artifact "$ref" || return 1

    echo ""
    # Keys match the gsb_menu rows (2 = install, 3 = use for this session) so the
    # same action never has two different keys depending on where you are.
    echo -e "  ${BOLD}Next:${RESET}"
    echo -e "    ${GREEN}2${RESET} — install it into the node(s) already on this box"
    echo -e "    ${GREEN}3${RESET} — install it into the NEXT node you build (not the release download)"
    echo -e "    ${DIM}Enter${RESET} — leave it in $GSB_BIN_DIR and decide later"
    echo ""
    echo -ne "${BOLD}Choice [2/3/Enter]: ${RESET}"
    local nxt=""
    read -r nxt || true
    case "${nxt}" in
        2) _gsb_install_to_instances || true ;;
        3) _gsb_use_for_session || true ;;
        *) info "Artifact left in $GSB_BIN_DIR." ;;
    esac
    return 0
}

# -----------------------------------------------------------------------------
# _gsb_use_for_session — hand the artifact to Script 01's Step 6.
# download_grin_binary already reuses $GRIN_BIN_TMP when it is set (that is how
# the mainnet+testnet double build avoids a second download), so pointing it at
# the artifact is all that is needed. It is exported as GRIN_PREBUILT_BIN too
# because several Step-1 branches re-exec the script ("exec \$0"), which would
# otherwise drop a plain shell variable.
# -----------------------------------------------------------------------------
_gsb_use_for_session() {
    if [[ -z "${GSB_ARTIFACT:-}" || ! -x "${GSB_ARTIFACT:-}" ]]; then
        _gsb_pick_artifact || return 1
    fi
    export GRIN_PREBUILT_BIN="$GSB_ARTIFACT"
    GRIN_BIN_TMP="$GSB_ARTIFACT"
    echo ""
    success "Armed: $(basename "$GSB_ARTIFACT")"
    info    "Nothing was installed yet — no node exists to install it into."
    info    "Now leave this menu and run the node setup as usual. When it reaches"
    info    "Step 6 (binary install) it will use this binary instead of downloading"
    info    "the GitHub release, for every network built in this run."
    warn    "THIS RUN ONLY — re-run script 01 later and you are back on the latest release."
    _gsb_have log && log "[SOURCE BUILD] session binary set to $GSB_ARTIFACT"
    return 0
}

# -----------------------------------------------------------------------------
# gsb_menu — public entry point (Step-1 menus, key G).
# Always returns 0: it is called from menu loops running under `set -e`.
# -----------------------------------------------------------------------------
gsb_menu() {
    while true; do
        echo ""
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN} Compile Grin from source  ${DIM}(unreleased branch/tag)${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${DIM} Repo: $GSB_REPO${RESET}"
        echo -e "${DIM} Use this when a fix is on 'staging' but no release tarball exists yet.${RESET}"
        echo -e "${DIM} Chain data is never touched; the replaced binary is kept for rollback.${RESET}"
        echo ""

        # Current checkout + artifact state
        if [[ -d "$GSB_SRC_DIR/.git" ]]; then
            local _ref="" _sha=""
            _ref=$(git -C "$GSB_SRC_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')
            _sha=$(git -C "$GSB_SRC_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')
            echo -e "  ${DIM}checkout : $GSB_SRC_DIR  ($_ref @ $_sha)${RESET}"
        else
            echo -e "  ${DIM}checkout : none yet${RESET}"
        fi

        local _n_art=0 _line=""
        while IFS= read -r _line; do
            [[ -n "$_line" ]] && _n_art=$(( _n_art + 1 ))
        done < <(_gsb_list_artifacts)
        echo -e "  ${DIM}builds   : $_n_art in $GSB_BIN_DIR${RESET}"

        if _gsb_collect_instances; then
            local _i
            for _i in "${!GSB_INST_DIRS[@]}"; do
                echo -e "  ${DIM}node     : ${GSB_INST_NETS[$_i]} — $(_gsb_binary_desc "${GSB_INST_DIRS[$_i]}")${RESET}"
            done
        else
            echo -e "  ${DIM}node     : none installed${RESET}"
        fi

        echo ""
        echo -e "  ${GREEN}1${RESET}) Compile a branch/tag into a binary   ${DIM}(default: $GSB_DEFAULT_REF)${RESET}"
        echo -e "  ${CYAN}2${RESET}) Install a local compiled binary into the node(s) already installed"
        echo -e "     ${DIM}replaces <node_dir>/grin, keeps grin.prev, restarts the node${RESET}"
        echo -e "  ${CYAN}3${RESET}) Install a local compiled binary into the NEXT node you build"
        echo -e "     ${DIM}for a node that does not exist yet — Step 6 uses it instead of${RESET}"
        echo -e "     ${DIM}downloading the GitHub release. Applies to this run only.${RESET}"
        echo -e "  ${YELLOW}4${RESET}) Roll back — restore <node_dir>/grin.prev"
        echo -e "  ${DIM}5${RESET}) Purge the cargo build cache  ${DIM}(frees several GB)${RESET}"
        echo -e "  ${DIM}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Choose [1-5, 0 = back]: ${RESET}"
        local choice=""
        read -r choice || true

        case "${choice}" in
            1) _gsb_build || true; _gsb_pause ;;
            2) if _gsb_pick_artifact; then _gsb_install_to_instances || true; fi; _gsb_pause ;;
            3) _gsb_use_for_session || true; _gsb_pause ;;
            4) _gsb_restore_previous || true; _gsb_pause ;;
            5) _gsb_purge_cache || true; _gsb_pause ;;
            0|"") return 0 ;;
            *) warn "Invalid input — choose 1, 2, 3, 4, 5 or 0." ;;
        esac
    done
}
