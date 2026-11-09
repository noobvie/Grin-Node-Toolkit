#!/usr/bin/env bash
# grin-node-toolkit-installer
#
# One-line installer for the Grin Node Toolkit. Served at:
#     curl -fsSL https://grinnode.org/install | sudo bash
#     https://grinnode.org/install.sh   (same file, fixed URL; checksum at install.sh.sha256)
#
# What it does, in order:
#   1. checks it runs as root on Linux with apt-get or dnf
#   2. installs git and CA certificates if they are missing
#   3. clones https://github.com/noobvie/Grin-Node-Toolkit into /opt/grin-node-toolkit
#      (an existing toolkit folder there is left untouched)
#   4. starts the toolkit menu (./grin-node-toolkit.sh)
#
# Options (when piped, pass them after `bash -s --`):
#   --dir PATH     install somewhere else (or: curl … | sudo GRIN_TOOLKIT_DIR=PATH bash)
#   --branch NAME  clone another branch (default: main)
#   --no-launch    install only; print how to start the menu
#
# The whole body sits inside functions and runs from the last line, so a download
# cut off half-way runs nothing. The marker line above is checked by the landing
# repo's site_manager.sh before it publishes this file.

set -euo pipefail

REPO_URL="https://github.com/noobvie/Grin-Node-Toolkit.git"
DEFAULT_DIR="/opt/grin-node-toolkit"
ENTRY="grin-node-toolkit.sh"

if [[ -t 1 ]]; then
    C_RED=$'\033[0;31m'; C_GRN=$'\033[0;32m'; C_YEL=$'\033[1;33m'; C_CYN=$'\033[0;36m'; C_OFF=$'\033[0m'
else
    C_RED=""; C_GRN=""; C_YEL=""; C_CYN=""; C_OFF=""
fi

step() { printf '%s[install]%s %s\n' "$C_CYN" "$C_OFF" "$*"; }
ok()   { printf '%s[ok]%s      %s\n' "$C_GRN" "$C_OFF" "$*"; }
warn() { printf '%s[warn]%s    %s\n' "$C_YEL" "$C_OFF" "$*" >&2; }
die()  { printf '%s[error]%s   %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

usage() {
    cat <<'EOF'
Grin Node Toolkit installer

  curl -fsSL https://grinnode.org/install | sudo bash
  curl -fsSL https://grinnode.org/install | sudo bash -s -- [options]

Options:
  --dir PATH     install directory (default /opt/grin-node-toolkit;
                 also: curl … | sudo GRIN_TOOLKIT_DIR=PATH bash)
  --branch NAME  branch to clone (default main)
  --no-launch    install only, do not start the menu
  -h, --help     show this help
EOF
}

parse_args() {
    INSTALL_DIR="${GRIN_TOOLKIT_DIR:-$DEFAULT_DIR}"
    BRANCH="main"
    LAUNCH="yes"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dir)       [[ $# -ge 2 ]] || die "--dir needs a path"; INSTALL_DIR="$2"; shift 2 ;;
            --dir=*)     INSTALL_DIR="${1#--dir=}"; shift ;;
            --branch)    [[ $# -ge 2 ]] || die "--branch needs a name"; BRANCH="$2"; shift 2 ;;
            --branch=*)  BRANCH="${1#--branch=}"; shift ;;
            --no-launch) LAUNCH="no"; shift ;;
            -h|--help)   usage; exit 0 ;;
            *)           die "Unknown option: $1 (try --help)" ;;
        esac
    done

    # An absolute path with no "..", so a typo can never land the clone (and the
    # later chmod) somewhere unexpected.
    [[ "$INSTALL_DIR" == /* ]]       || die "--dir must be an absolute path: $INSTALL_DIR"
    [[ "$INSTALL_DIR" != *..* ]]     || die "--dir must not contain '..': $INSTALL_DIR"
    while [[ "$INSTALL_DIR" == */ ]]; do INSTALL_DIR="${INSTALL_DIR%/}"; done
    [[ -n "$INSTALL_DIR" ]]          || die "--dir must not be /"
    # A symlink would be followed by the checks below but replaced by the move.
    [[ ! -L "$INSTALL_DIR" ]]        || die "--dir is a symlink; pass the real path: $(readlink -f -- "$INSTALL_DIR")"
    # Branch names are passed to git as a separate argument; still refuse anything
    # that could read as an option or carries shell-unfriendly characters.
    [[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ && "$BRANCH" != -* ]] || die "Invalid branch name: $BRANCH"
}

check_system() {
    [[ "$(uname -s)" == "Linux" ]] || die "The Grin Node Toolkit runs on a Linux server (found $(uname -s))."
    [[ ${EUID:-$(id -u)} -eq 0 ]] || die "Run as root: curl -fsSL https://grinnode.org/install | sudo bash"

    local pretty="unknown Linux"
    if [[ -r /etc/os-release ]]; then
        # shellcheck source=/dev/null
        pretty="$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-${ID:-unknown}}")"
    fi
    ok "System: $pretty ($(uname -m))"

    if command -v apt-get >/dev/null 2>&1; then
        PKG="apt"
    elif command -v dnf >/dev/null 2>&1; then
        PKG="dnf"
    else
        die "No apt-get or dnf found. The toolkit supports Debian/Ubuntu, Rocky Linux and AlmaLinux."
    fi

    # The toolkit itself decides which releases it supports (it checks on start);
    # here we only warn about the CPU, since the prebuilt Grin binaries are x86_64.
    case "$(uname -m)" in
        x86_64|amd64) ;;
        *) warn "CPU is $(uname -m): the prebuilt Grin node is x86_64 only. The toolkit can build from source (Script 01, key G)." ;;
    esac
}

install_packages() {
    local missing=()
    command -v git >/dev/null 2>&1 || missing+=(git)
    [[ -e /etc/ssl/certs/ca-certificates.crt || -e /etc/pki/tls/certs/ca-bundle.crt ]] || missing+=(ca-certificates)
    if [[ ${#missing[@]} -eq 0 ]]; then
        ok "git is installed."
        return 0
    fi

    step "Installing: ${missing[*]}"
    # stdin from /dev/null: when this script arrives through a pipe, a package
    # manager must never read (and swallow) the rest of it.
    # On a fresh cloud server, cloud-init or unattended-upgrades often holds the
    # apt locks for the first minutes; wait instead of failing. DPkg::Lock::Timeout
    # covers install, but `apt-get update` ignores it for the lists lock, so
    # retry that one for up to 5 minutes.
    if [[ "$PKG" == "apt" ]]; then
        local tries=0
        until DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 update -q </dev/null; do
            tries=$((tries + 1))
            [[ $tries -lt 30 ]] || die "apt-get update failed (still failing after 5 minutes)."
            warn "apt-get update failed — another package job may hold the lock; retrying in 10 s ($tries/30)"
            sleep 10
        done
        DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -q "${missing[@]}" </dev/null \
            || die "apt-get install ${missing[*]} failed."
    else
        dnf install -y -q "${missing[@]}" </dev/null \
            || die "dnf install ${missing[*]} failed."
    fi
    command -v git >/dev/null 2>&1 || die "git is still missing after the install."
    ok "Installed: ${missing[*]}"
}

# True when $1 is owned by root and not writable by group or others.
root_only() {
    local owner mode
    owner=$(stat -c '%u' -- "$1" 2>/dev/null) || return 1
    mode=$(stat -c '%a' -- "$1" 2>/dev/null) || return 1
    [[ "$owner" == 0 ]] && (( (8#$mode & 8#022) == 0 ))
}

install_toolkit() {
    if [[ -e "$INSTALL_DIR" ]]; then
        if [[ -f "$INSTALL_DIR/$ENTRY" ]]; then
            ok "The toolkit is already installed in $INSTALL_DIR — leaving it as it is."
            ok "To update it: start the menu, then 8) Admin & Maintenance → 8) Self-Update."
            # This script would start that menu as root. Only do so when no
            # other account could have changed it.
            if ! root_only "$INSTALL_DIR" || ! root_only "$INSTALL_DIR/$ENTRY"; then
                warn "$INSTALL_DIR or its $ENTRY is not owned by root, or is writable by other users."
                warn "Not starting it automatically. Check it, then run it yourself if you trust it."
                LAUNCH="no"
            fi
            return 0
        fi
        if [[ -d "$INSTALL_DIR" && -z "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]]; then
            : # an empty folder is fine to clone into
        else
            die "$INSTALL_DIR exists and is not the toolkit. Move it away or choose another place with --dir."
        fi
    fi

    step "Cloning $REPO_URL ($BRANCH) into $INSTALL_DIR"
    mkdir -p "$(dirname "$INSTALL_DIR")" || die "Cannot create $(dirname "$INSTALL_DIR")."
    # Clone next to the target and move into place, so an interrupted clone never
    # leaves a half-filled folder that a re-run would mistake for an install.
    local tmp
    tmp="$(mktemp -d "${INSTALL_DIR}.partial.XXXXXX")" || die "Cannot create a temporary folder."
    trap 'rm -rf -- "$tmp"' EXIT
    # GIT_TERMINAL_PROMPT=0: if the repository ever moves or turns private, fail
    # instead of asking for a GitHub password.
    GIT_TERMINAL_PROMPT=0 git clone --quiet --depth 1 --branch "$BRANCH" -- "$REPO_URL" "$tmp/toolkit" </dev/null \
        || die "git clone failed (network, or no branch named '$BRANCH')."
    [[ -f "$tmp/toolkit/$ENTRY" ]] || die "The clone has no $ENTRY — wrong repository or branch?"

    if [[ -d "$INSTALL_DIR" ]]; then rmdir -- "$INSTALL_DIR" || die "Cannot replace the empty folder $INSTALL_DIR."; fi
    mv -- "$tmp/toolkit" "$INSTALL_DIR" || die "Cannot move the clone into $INSTALL_DIR."
    rm -rf -- "$tmp"
    trap - EXIT

    chmod +x "$INSTALL_DIR/$ENTRY" || die "chmod failed on $INSTALL_DIR/$ENTRY."
    find "$INSTALL_DIR/scripts" -maxdepth 1 -name '*.sh' -exec chmod +x {} + 2>/dev/null \
        || warn "Could not mark every script in $INSTALL_DIR/scripts executable."
    ok "Installed in $INSTALL_DIR ($(git -C "$INSTALL_DIR" rev-parse --short HEAD 2>/dev/null || echo '?'))"
}

launch() {
    local start_cmd="cd $INSTALL_DIR && sudo ./$ENTRY"
    echo ""
    if [[ "$LAUNCH" != "yes" ]]; then
        ok "Done. Start the menu with:  $start_cmd"
        return 0
    fi
    # Piped into bash, our stdin is the download, not the keyboard. The menu
    # needs the terminal, so read from /dev/tty — and only when one is usable
    # (cron, CI and `ssh host cmd` have none).
    if ! { : </dev/tty; } 2>/dev/null; then
        ok "Done. No terminal to start the menu in; run:  $start_cmd"
        return 0
    fi
    ok "Starting the Grin Node Toolkit menu…"
    echo "    (next time:  $start_cmd)"
    echo ""
    cd "$INSTALL_DIR" || die "Cannot enter $INSTALL_DIR."
    exec "./$ENTRY" </dev/tty
}

main() {
    parse_args "$@"
    echo ""
    echo "  Grin Node Toolkit — installer"
    echo "  https://grinnode.org"
    echo ""
    check_system
    install_packages
    install_toolkit
    launch
}

main "$@"
