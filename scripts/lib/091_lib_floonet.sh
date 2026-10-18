# =============================================================================
# lib/091_lib_floonet.sh — Floonet relay (091) helpers
# =============================================================================
#
# Sourced by scripts/091_grin_floonet_relay.sh — inherits colors + logging
# (info/warn/error/success/log/pause/require_root). NO shebang, NO set -e.
#
# What this deploys: the community Grin-native Nostr relay `floonet-rs`
# (github.com/2ro, docs.floonet.dev) — we DEPLOY his software the toolkit way,
# we never fork it. Layout follows his deploy/install.sh conventions:
#   /usr/local/bin/floonet-rs        binary
#   /etc/floonet-rs/config.toml      config (0600, never clobbered on upgrade)
#   /var/lib/floonet-rs              state (SQLite)
#   floonet-rs.service               hardened systemd unit
#
# Toolkit-side additions:
#   /opt/grin/floonet/src            cloned source (build dir)
#   /opt/grin/conf/grin_floonet.conf deployer settings (domain, email, backup)
#   /etc/nginx/sites-available/floonet-relay   wss:// vhost (nginx replaces Caddy)
#
# Decisions locked at implementation (design doc A.4):
#   · ONE relay per operator — Floonet is network-agnostic transport (the
#     relay never touches chain state; upstream runs a single service).
#   · Upstream unit is used AS-IS when his install.sh runs; our fallback unit
#     uses a stable `floonet` user (a 0600 root-owned config is unreadable
#     under DynamicUser — the stable user avoids that trap).
#   · Rust via rustup (root, minimal profile) only when cargo is absent.
# =============================================================================

[[ -n "${_091_LIB_FLOONET_SH_LOADED:-}" ]] && return 0
_091_LIB_FLOONET_SH_LOADED=1

# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/nostr_relay_deploy.sh"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/grin_backup_engine.sh"

# Color fallbacks — caller normally defines these; keep set -u safe regardless.
: "${RED:=}"; : "${GREEN:=}"; : "${YELLOW:=}"; : "${CYAN:=}"
: "${BOLD:=}"; : "${DIM:=}"; : "${RESET:=}"

# ─── Paths / constants ───────────────────────────────────────────────────────
FLR_REPO_URL="${FLR_REPO_URL:-https://github.com/2ro/floonet-rs}"
FLR_SRC="/opt/grin/floonet/src"
FLR_BIN="/usr/local/bin/floonet-rs"
FLR_ETC="/etc/floonet-rs"
FLR_CONFIG="${FLR_ETC}/config.toml"
FLR_ENV_FILE="${FLR_ETC}/env"
FLR_STATE="/var/lib/floonet-rs"
FLR_SVC="floonet-rs"
FLR_CONF="/opt/grin/conf/grin_floonet.conf"
FLR_SITE_NAME="floonet-relay"
FLR_DEFAULT_PORT=8181
FLR_WWW="/var/www/floonet-relay"            # static landing page served to browsers
# Landing-page template; resolved from this lib's own location (the entry sets no TOOLKIT_ROOT).
FLR_LANDING_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/web/091_floonet_relay/landing.html"
FLR_LANDING_NIPS="${FLR_LANDING_NIPS:-1,11,44}"  # NIP-11 fallback chips (live doc overrides)

# nginx zones (script-specific, script09- prefixed per CLAUDE.md rules)
FLR_REQ_ZONE="floonet_ws"
FLR_CONN_ZONE="floonet_conn"

# Backup (shared engine conventions: product "floonet")
FLR_BAK_WRAPPER="/usr/local/bin/grin-floonet-backup"
FLR_BAK_CRON="/etc/cron.d/grin-floonet-backup"
FLR_BAK_LOG="/opt/grin/logs/floonet_backup_cron.log"

# Event retention (OUR feature — floonet-rs/nostr-rs-relay never expires events)
FLR_PRUNE_WRAPPER="/usr/local/bin/grin-floonet-prune"
FLR_PRUNE_CRON="/etc/cron.d/grin-floonet-prune"
FLR_PRUNE_LOG="/opt/grin/logs/floonet_prune.log"
# Kinds that must NEVER be age-pruned: they are the operator's identity/config,
# not traffic. 0 profile, 3 contacts, 5 deletions, plus the whole replaceable
# (10000–19999) and addressable (30000–39999) ranges — a relay list or DM-relay
# list has no newer copy anywhere once it's gone.
FLR_PRUNE_DENY_KINDS="0 3 5"
FLR_PRUNE_MIN_DAYS=7   # goblin's catch-up lookback is 3 days + 24h send expiry

# Deployer settings (persisted in FLR_CONF)
FLR_DOMAIN=""
FLR_EMAIL=""
FLR_BAK_KEEP=7
FLR_BAK_HOUR=3
FLR_BAK_MIN=25
FLR_PRUNE_DAYS=0            # 0 = retention off (keep everything, upstream behaviour)
FLR_PRUNE_KINDS="1059"      # gift wraps — the disposable slatepack envelopes
FLR_PRUNE_HOUR=4
FLR_PRUNE_MIN=10
FLR_INSTALLED_REV=""   # source rev the installed binary was built from

# ─── Deployer conf ───────────────────────────────────────────────────────────
flr_load_conf() {
    FLR_DOMAIN=""; FLR_EMAIL=""; FLR_BAK_KEEP=7; FLR_BAK_HOUR=3; FLR_BAK_MIN=25
    FLR_PRUNE_DAYS=0; FLR_PRUNE_KINDS="1059"; FLR_PRUNE_HOUR=4; FLR_PRUNE_MIN=10
    FLR_INSTALLED_REV=""
    # shellcheck disable=SC1090
    [[ -f "$FLR_CONF" ]] && source "$FLR_CONF" 2>/dev/null || true
}

flr_save_conf() {
    mkdir -p "$(dirname "$FLR_CONF")"
    cat > "$FLR_CONF" <<EOF
# Grin Floonet relay (091) — deployer settings. Managed by 091_grin_floonet_relay.sh.
FLR_DOMAIN='${FLR_DOMAIN}'
FLR_EMAIL='${FLR_EMAIL}'
FLR_BAK_KEEP=${FLR_BAK_KEEP}
FLR_BAK_HOUR=${FLR_BAK_HOUR}
FLR_BAK_MIN=${FLR_BAK_MIN}
FLR_PRUNE_DAYS=${FLR_PRUNE_DAYS}
FLR_PRUNE_KINDS='${FLR_PRUNE_KINDS}'
FLR_PRUNE_HOUR=${FLR_PRUNE_HOUR}
FLR_PRUNE_MIN=${FLR_PRUNE_MIN}
FLR_INSTALLED_REV='${FLR_INSTALLED_REV}'
EOF
    chmod 600 "$FLR_CONF"
}

# ─── Detection / status ──────────────────────────────────────────────────────
flr_installed() {
    [[ -x "$FLR_BIN" ]] || systemctl cat "$FLR_SVC" >/dev/null 2>&1
}

flr_svc_state() {
    systemctl is-active "$FLR_SVC" 2>/dev/null || true
}

flr_port() {
    local p
    p=$(flr_toml_get network port)
    [[ "$p" =~ ^[0-9]+$ ]] && echo "$p" || echo "$FLR_DEFAULT_PORT"
}

# Echo the first free TCP port ≥ $1 (scans a small window). "Free" = nothing is
# LISTENing on it right now. Used to keep the relay's loopback listener off a
# port another local service already owns — most importantly :8080, which the
# toolkit's own Script 07 pool Central API reserves on loopback.
_flr_free_loopback_port() {
    local start="${1:-$FLR_DEFAULT_PORT}" p
    [[ "$start" =~ ^[0-9]+$ ]] || start=$FLR_DEFAULT_PORT
    for (( p=start; p<start+50; p++ )); do
        # ss local-address column ends the port with a space; ":<p> " matches
        # both 127.0.0.1:<p> and [::]:<p> without matching a longer port.
        if ! ss -ltn 2>/dev/null | grep -qE ":${p} "; then
            echo "$p"; return 0
        fi
    done
    echo "$start"   # window exhausted — hand back the requested port
}

flr_relay_url() {
    local u
    u=$(flr_toml_get info relay_url)
    [[ -n "$u" ]] && echo "$u" || echo "(not set)"
}

# Largest SQLite file in the state dir (nostr-rs-relay keeps one main DB).
flr_db_path() {
    ls -S "$FLR_STATE"/*.db 2>/dev/null | head -n1 || true
}

# ─── config.toml get/set (text-preserving, section-aware) ────────────────────
# TOML is edited in place with python3: comments and unrelated lines survive.
# An active `key = …` line is replaced in place; a commented-out `# key = …` is
# uncommented-replaced only when NO active line exists in the section (else a
# duplicate key would brick the relay's TOML parse); missing sections/keys are
# appended. Values are passed ALREADY TOML-formatted (strings pre-quoted,
# booleans/numbers/arrays bare).
_flr_py_toml() {  # <get|set> <file> <section> <key> [toml_value]
    python3 - "$@" <<'PYEOF'
import sys
mode, path, section, key = sys.argv[1:5]
value = sys.argv[5] if len(sys.argv) > 5 else None
try:
    with open(path, encoding='utf-8') as fh:
        lines = fh.readlines()
except FileNotFoundError:
    lines = []

def secname(line):
    s = line.strip()
    if s.startswith('[') and s.endswith(']'):
        return s.strip('[]').strip()
    return None

if mode == 'get':
    cur = ''
    for l in lines:
        n = secname(l)
        if n is not None:
            cur = n
            continue
        if cur != section:
            continue
        s = l.strip()
        if s.startswith('#') or '=' not in s:
            continue
        if s.split('=', 1)[0].strip() == key:
            v = s.split('=', 1)[1].strip()
            if v.startswith('"') and v.count('"') >= 2:
                v = v[1:v.find('"', 1)]
            else:
                v = v.split('#', 1)[0].strip()   # strip an inline comment off bare values
            print(v)
            sys.exit(0)
    sys.exit(1)

# set
newline = f'{key} = {value}\n'
if lines and not lines[-1].endswith('\n'):
    lines[-1] += '\n'                    # never glue an appended key onto the last line

def is_key(line, commented_ok):
    s = line.strip()
    if s.startswith('#'):
        if not commented_ok:
            return False
        s = s[1:].strip()
    return '=' in s and s.split('=', 1)[0].strip() == key

# Pass 1: does the target section already hold an ACTIVE (uncommented) key line?
# If so, that is the line to replace — un-commenting a `# key = …` docs line while
# an active line exists would leave two active keys, and strict TOML parsers (the
# relay's Rust toml crate) reject duplicates → relay refuses to start.
cur, has_active = '', False
for l in lines:
    n = secname(l)
    if n is not None:
        cur = n
        continue
    if cur == section and is_key(l, False):
        has_active = True
        break

out, cur, done, sec_found = [], '', False, False
for l in lines:
    n = secname(l)
    if n is not None:
        if cur == section and not done:
            out.append(newline)          # leaving target section: key was absent
            done = True
        cur = n
        if n == section:
            sec_found = True
        out.append(l)
        continue
    if cur == section:
        if not done and is_key(l, not has_active):
            out.append(newline)
            done = True
            continue
        if done and is_key(l, False):
            continue                     # drop pre-existing active duplicates
    out.append(l)
if not done:
    if not sec_found:
        if out and out[-1].strip() != '':
            out.append('\n')
        out.append(f'[{section}]\n')
    out.append(newline)
with open(path, 'w', encoding='utf-8') as fh:
    fh.writelines(out)
PYEOF
}

flr_toml_get() {  # <section> <key>
    [[ -f "$FLR_CONFIG" ]] || return 1
    _flr_py_toml get "$FLR_CONFIG" "$1" "$2" 2>/dev/null
}

flr_toml_set() {  # <section> <key> <toml_value>
    [[ -f "$FLR_CONFIG" ]] || { error "No $FLR_CONFIG — install the relay first."; return 1; }
    _flr_py_toml set "$FLR_CONFIG" "$1" "$2" "$3"
}

# Quote a shell string as a TOML string.
# Strip ANSI/color escapes and any other control chars FIRST: a colored prompt
# default or a captured value must never leak an ESC byte (0x1b) into config.toml
# — floonet-rs's strict Rust TOML parser rejects it ("invalid character `\u{1b}`")
# and the relay refuses to start. Remove the full SGR sequence, then mop up any
# stray control byte (bare ESC, newline, tab, CR).
flr_toml_str() {
    local s
    s=$(printf '%s' "$1" | LC_ALL=C sed -e 's/\x1b\[[0-9;?]*[ -/]*[@-~]//g' -e 's/[[:cntrl:]]//g')
    printf '"%s"' "${s//\"/\\\"}"
}

# ══════════════════════════════════════════════════════════════════════════════
# SETUP STEPS (each idempotent — the wizard re-runs safely)
# ══════════════════════════════════════════════════════════════════════════════

flr_preflight() {
    require_root
    if [[ ! -f /etc/debian_version && ! -f /etc/redhat-release ]]; then
        error "Unsupported OS — need Debian/Ubuntu or RHEL/Rocky/Alma."
        return 1
    fi
    # Disk: a cargo release build needs ~3-4 GB (toolchain + target dir).
    local avail_kb
    avail_kb=$(df --output=avail -k /opt 2>/dev/null | tail -n1 | tr -d ' ')
    if [[ "${avail_kb:-0}" -lt 4194304 ]]; then
        warn "Less than 4 GB free on /opt — a source build may run out of disk."
        echo -ne "  Continue anyway? [y/N]: "; local c; read -r c || true
        [[ "${c,,}" == "y" ]] || return 1
    fi
    return 0
}

# Low-RAM boxes OOM during cargo builds — offer a temporary swap file.
FLR_TMP_SWAP=""
_flr_ensure_build_memory() {
    FLR_TMP_SWAP=""
    local sf="/var/tmp/floonet-build.swap"
    # A leftover file from an interrupted build would linger forever AND skew
    # the swap total measured below — clear it before deciding anything.
    if [[ -f "$sf" ]]; then
        swapoff "$sf" 2>/dev/null || true
        rm -f "$sf"
        info "Removed a leftover build swap file from an interrupted run."
    fi
    local mem_kb swap_kb
    mem_kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)
    swap_kb=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo 2>/dev/null)
    if [[ "${mem_kb:-0}" -ge 3400000 || "${swap_kb:-0}" -ge 1500000 ]]; then
        return 0
    fi
    warn "This server has <3.5 GB RAM and little swap — the Rust build can OOM."
    echo -ne "  Add a temporary 2 GB swap file for the build (removed after)? [Y/n]: "
    local c; read -r c || true
    [[ "${c,,}" == "n" ]] && return 0
    if ! fallocate -l 2G "$sf" 2>/dev/null; then
        dd if=/dev/zero of="$sf" bs=1M count=2048 status=none 2>/dev/null \
            || { warn "Could not create swap file — continuing without."; rm -f "$sf"; return 0; }
    fi
    chmod 600 "$sf"
    if mkswap "$sf" >/dev/null 2>&1 && swapon "$sf" 2>/dev/null; then
        FLR_TMP_SWAP="$sf"
        success "Temporary 2 GB swap active."
    else
        warn "Could not activate swap file — continuing without."
        rm -f "$sf"
    fi
    return 0
}

_flr_release_build_memory() {
    if [[ -n "$FLR_TMP_SWAP" ]]; then
        swapoff "$FLR_TMP_SWAP" 2>/dev/null || true
        rm -f "$FLR_TMP_SWAP"
        FLR_TMP_SWAP=""
        info "Temporary build swap removed."
    fi
    return 0
}

flr_install_deps() {
    info "Installing build dependencies (git, compiler, protoc, ssl headers)…"
    if [[ -f /etc/debian_version ]]; then
        apt-get update -qq || true
        apt-get install -y -qq git curl build-essential pkg-config libssl-dev \
            protobuf-compiler sqlite3 \
            || { error "apt install failed."; return 1; }
    else
        yum install -y -q epel-release 2>/dev/null || true
        yum install -y -q git curl gcc gcc-c++ make pkgconf-pkg-config \
            openssl-devel protobuf-compiler sqlite \
            || { error "yum install failed."; return 1; }
    fi
    success "Dependencies installed."
}

flr_ensure_rust() {
    # Pick up a prior rustup install for this shell.
    [[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env" 2>/dev/null || true
    if command -v cargo >/dev/null 2>&1; then
        success "Rust toolchain present: $(cargo --version 2>/dev/null | head -n1)"
        return 0
    fi
    info "Installing Rust via rustup (minimal profile — one-time, ~1 min)…"
    curl --proto '=https' --tlsv1.2 -fsS https://sh.rustup.rs \
        | sh -s -- -y --profile minimal >/dev/null \
        || { error "rustup install failed."; return 1; }
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env" 2>/dev/null || export PATH="$HOME/.cargo/bin:$PATH"
    command -v cargo >/dev/null 2>&1 \
        || { error "cargo still not on PATH after rustup."; return 1; }
    success "Rust installed: $(cargo --version 2>/dev/null | head -n1)"
}

flr_fetch_source() {
    mkdir -p "$(dirname "$FLR_SRC")"
    if [[ -d "$FLR_SRC/.git" ]]; then
        info "Updating floonet-rs source…"
        git -C "$FLR_SRC" fetch --quiet origin 2>/dev/null || warn "git fetch failed (offline?) — using existing checkout."
        git -C "$FLR_SRC" reset --hard --quiet origin/HEAD 2>/dev/null \
            || git -C "$FLR_SRC" pull --quiet 2>/dev/null || true
    else
        info "Cloning ${FLR_REPO_URL}…"
        git clone --depth 1 "$FLR_REPO_URL" "$FLR_SRC" \
            || { error "git clone failed — check network / repo URL."; return 1; }
    fi
    success "Source ready at $FLR_SRC ($(git -C "$FLR_SRC" rev-parse --short HEAD 2>/dev/null || echo '?'))"
}

# Probe upstream for a prebuilt release archive (his install.sh already probes
# ./floonet-rs first — the "release archive layout"). Upstream publishes no releases
# yet (check before assuming); this future-proofs the deployer without blocking on it.
_flr_try_prebuilt() {
    local arch; arch=$(uname -m)
    [[ "$arch" == "x86_64" || "$arch" == "aarch64" ]] || return 1
    local api="https://api.github.com/repos/2ro/floonet-rs/releases/latest" url
    url=$(curl -fsSL --max-time 15 "$api" 2>/dev/null \
        | grep -oE '"browser_download_url" *: *"[^"]+"' \
        | grep -i linux | grep -iE "$arch|$([[ "$arch" == x86_64 ]] && echo amd64 || echo arm64)" \
        | head -n1 | sed 's/.*"\(https[^"]*\)".*/\1/') || true
    [[ -n "$url" ]] || return 1
    info "Prebuilt release found — downloading instead of building: $url"
    curl -fSL --max-time 600 -o "$FLR_SRC/floonet-prebuilt.tar.gz" "$url" || return 1
    tar -xzf "$FLR_SRC/floonet-prebuilt.tar.gz" -C "$FLR_SRC" || return 1
    rm -f "$FLR_SRC/floonet-prebuilt.tar.gz"
    [[ -x "$FLR_SRC/floonet-rs" ]]
}

flr_build() {
    if _flr_try_prebuilt; then
        success "Using upstream prebuilt binary (no compile needed)."
        return 0
    fi
    if ! command -v protoc >/dev/null 2>&1; then
        error "protoc missing — dependency step didn't complete."
        return 1
    fi
    _flr_ensure_build_memory
    info "Building floonet-rs from source (cargo release build — 5-15 min on a small VPS)…"
    echo -e "  ${DIM}Coffee time — the build output below is normal.${RESET}"
    if ! (cd "$FLR_SRC" && cargo build --release); then
        _flr_release_build_memory
        error "cargo build failed. Common causes: out of RAM (add swap), out of disk,"
        error "or a missing system package. Scroll up for the first error line."
        return 1
    fi
    _flr_release_build_memory
    [[ -x "$FLR_SRC/target/release/floonet-rs" ]] \
        || { error "Build finished but target/release/floonet-rs is missing."; return 1; }
    success "floonet-rs built."
}

# Heal the state dir for a static-user (StateDirectory=) unit.
# systemd refuses a StateDirectory= whose /var/lib/<name> is a pre-existing
# SYMLINK — it fails setup with status=238/STATE_DIRECTORY ("Failed to set up
# special execution directory in /var/lib: File exists"). That symlink is the
# residue of an earlier DynamicUser unit (upstream install.sh): the real dir
# lives at /var/lib/private/floonet-rs and /var/lib/floonet-rs is a symlink into
# it. Our fallback unit runs as the stable `floonet` user, so convert it back to
# a REAL owned dir, migrating any SQLite state out of the private dir first.
# Idempotent; a live DynamicUser unit is left untouched (systemd manages it).
_flr_heal_state_dir() {
    if systemctl cat "$FLR_SVC" 2>/dev/null | grep -qsE '^DynamicUser=(yes|true|1)'; then
        mkdir -p "$FLR_STATE" 2>/dev/null || true
        return 0
    fi
    local priv="/var/lib/private/floonet-rs"
    if [[ -L "$FLR_STATE" ]]; then
        warn "Healing leftover DynamicUser symlink at ${FLR_STATE}…"
        local tgt src
        tgt=$(readlink -f "$FLR_STATE" 2>/dev/null || true)
        rm -f "$FLR_STATE"
        mkdir -p "$FLR_STATE"
        for src in "$priv" "$tgt"; do
            if [[ -n "$src" && -d "$src" && "$src" != "$FLR_STATE" ]]; then
                cp -a "$src/." "$FLR_STATE/" 2>/dev/null || true
                rm -rf "${src:?}" 2>/dev/null || true
                break
            fi
        done
    else
        mkdir -p "$FLR_STATE"
        # A stray private dir with no symlink also confuses a later start.
        if [[ -d "$priv" ]]; then rm -rf "${priv:?}" 2>/dev/null || true; fi
    fi
    if id -u floonet >/dev/null 2>&1; then
        chown -R floonet:floonet "$FLR_STATE" 2>/dev/null || true
    fi
    return 0
}

# Fallback unit — only used when upstream deploy/install.sh is absent/broken.
# Stable `floonet` user instead of DynamicUser: the 0600 config must stay
# readable by the service without loosening it to world-readable.
_flr_write_fallback_unit() {
    id -u floonet >/dev/null 2>&1 || useradd --system --home-dir "$FLR_STATE" \
        --shell /usr/sbin/nologin floonet 2>/dev/null \
        || useradd --system --home-dir "$FLR_STATE" --shell /sbin/nologin floonet
    _flr_heal_state_dir
    cat > /etc/systemd/system/${FLR_SVC}.service <<UNIT
[Unit]
Description=Floonet — Grin-native Nostr relay (floonet-rs)
Documentation=https://docs.floonet.dev
After=network-online.target
Wants=network-online.target

[Service]
User=floonet
Group=floonet
ExecStart=${FLR_BIN} --config ${FLR_CONFIG}
EnvironmentFile=-${FLR_ENV_FILE}
Restart=on-failure
RestartSec=5
LimitNOFILE=65536
# Hardening (mirrors upstream's unit)
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
MemoryDenyWriteExecute=true
ReadWritePaths=${FLR_STATE}
StateDirectory=floonet-rs

[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload
}

flr_install_binary() {
    local built=""
    [[ -x "$FLR_SRC/floonet-rs" ]] && built="$FLR_SRC/floonet-rs"
    [[ -z "$built" && -x "$FLR_SRC/target/release/floonet-rs" ]] && built="$FLR_SRC/target/release/floonet-rs"
    [[ -n "$built" ]] || { error "No built binary found — run the build step first."; return 1; }

    # Preferred path: upstream's idempotent installer (installs/upgrades the
    # binary + hardened unit; never clobbers an existing config.toml).
    if [[ -f "$FLR_SRC/deploy/install.sh" ]]; then
        info "Running upstream deploy/install.sh…"
        if (cd "$FLR_SRC" && bash deploy/install.sh); then
            success "Upstream installer completed."
        else
            warn "Upstream install.sh failed — falling back to manual install."
        fi
    fi

    # Verify (or complete) the install ourselves — same layout either way.
    if [[ ! -x "$FLR_BIN" ]]; then
        install -m 755 "$built" "$FLR_BIN"
        info "Binary installed → $FLR_BIN"
    fi
    if ! systemctl cat "$FLR_SVC" >/dev/null 2>&1; then
        warn "No systemd unit from upstream installer — writing the toolkit fallback unit."
        _flr_write_fallback_unit
    fi
    _flr_heal_state_dir
    flr_ensure_config
    # Record which source rev is now installed — flr_update compares against
    # THIS (not the fetch delta), so a fetch followed by a failed build can
    # never masquerade as "already up to date" on the next run.
    flr_load_conf
    FLR_INSTALLED_REV=$(git -C "$FLR_SRC" rev-parse HEAD 2>/dev/null || echo "")
    flr_save_conf
    success "floonet-rs installed (binary + unit + config)."
}

# Make sure /etc/floonet-rs/config.toml exists (upstream example preferred),
# and that the database path points at the state dir.
flr_ensure_config() {
    mkdir -p "$FLR_ETC"
    if [[ ! -f "$FLR_CONFIG" ]]; then
        local cand
        for cand in "$FLR_SRC/config.toml" "$FLR_SRC/deploy/config.toml" \
                    "$FLR_SRC/config.toml.example" "$FLR_SRC/deploy/config.toml.example"; do
            if [[ -f "$cand" ]]; then
                cp "$cand" "$FLR_CONFIG"
                info "Config seeded from $(basename "$(dirname "$cand")")/$(basename "$cand")."
                break
            fi
        done
    fi
    if [[ ! -f "$FLR_CONFIG" ]]; then
        warn "No upstream example config found — writing a minimal one."
        cat > "$FLR_CONFIG" <<MINCONF
# floonet-rs config — minimal seed written by the Grin Node Toolkit (091).
# Full schema: ${FLR_REPO_URL}
[info]
relay_url = ""
name = "Floonet relay"
description = "Grin-native Nostr relay (deployed with the Grin Node Toolkit)"

[network]
address = "127.0.0.1"
port = ${FLR_DEFAULT_PORT}

[database]
data_directory = "${FLR_STATE}"
MINCONF
    fi
    # The DB must live in the state dir the unit allows writes to, and the relay
    # must stay loopback-only — nginx is the ONLY public entrance (an upstream
    # example config may ship address = "0.0.0.0", which would bypass the
    # rate/conn limits and expose the bare relay port).
    _flr_py_toml set "$FLR_CONFIG" database data_directory "$(flr_toml_str "$FLR_STATE")"
    _flr_py_toml set "$FLR_CONFIG" network address "$(flr_toml_str "127.0.0.1")"
    # floonet-rs' upstream example config ships network.port = 8080 — the exact
    # loopback port the toolkit's own Script 07 pool Central API reserves. On a
    # box running both, the relay then can't bind (EADDRINUSE) and never starts.
    # Never let the relay inherit 8080; and land it on a port nothing is already
    # LISTENing on so an unrelated squatter doesn't wedge it either. nginx reads
    # the same value via flr_port(), so the vhost and the relay always agree.
    # (If the relay is already up on its current port, that port reads as "in
    # use" by itself — but we only re-pick when the current port is unset/8080,
    # so a healthy re-run never churns the port.)
    local _cur_port _want_port
    _cur_port=$(_flr_py_toml get "$FLR_CONFIG" network port 2>/dev/null || true)
    if [[ ! "$_cur_port" =~ ^[0-9]+$ || "$_cur_port" == "8080" ]]; then
        _want_port=$(_flr_free_loopback_port "$FLR_DEFAULT_PORT")
        _flr_py_toml set "$FLR_CONFIG" network port "$_want_port"
        if [[ "$_cur_port" == "8080" ]]; then
            info "Moved relay off :8080 (reserved for the pool Central API) → :${_want_port}."
        else
            info "Relay loopback port set to :${_want_port}."
        fi
    fi
    # Upstream's example config can ship [goblinpay] with pay_mode enabled
    # (name/write) and no url — floonet-rs then panics on startup
    # ("goblinpay.url must be set when goblinpay.pay_mode is enabled"), an
    # unbootable seed. A plain transport relay doesn't charge for registration,
    # so force pay_mode → "off" UNLESS the operator has set a url (they opt in
    # to charging via flr_menu_goblinpay, which sets both together).
    local _gp_mode _gp_url
    _gp_mode=$(_flr_py_toml get "$FLR_CONFIG" goblinpay pay_mode 2>/dev/null || true)
    _gp_url=$(_flr_py_toml get "$FLR_CONFIG" goblinpay url 2>/dev/null || true)
    if [[ -n "$_gp_mode" && "$_gp_mode" != "off" && -z "$_gp_url" ]]; then
        _flr_py_toml set "$FLR_CONFIG" goblinpay pay_mode "$(flr_toml_str "off")"
        info "Disabled goblinpay.pay_mode (no url set) — relay would panic otherwise."
    fi
    chmod 600 "$FLR_CONFIG"
    # Config must stay readable by the service user:
    #  · our fallback unit (stable `floonet` user) → root:floonet, mode 640
    #  · an upstream DynamicUser unit can NEVER read a root-only file → relax to
    #    644 (safe: secrets live in the env file, never in config.toml)
    if id -u floonet >/dev/null 2>&1 \
        && grep -qs "^User=floonet" /etc/systemd/system/${FLR_SVC}.service 2>/dev/null; then
        chown root:floonet "$FLR_CONFIG"
        chmod 640 "$FLR_CONFIG"
    elif systemctl cat "$FLR_SVC" 2>/dev/null | grep -qsE '^DynamicUser=(yes|true|1)'; then
        chmod 644 "$FLR_CONFIG"
    fi
    return 0
}

flr_configure_identity() {  # <domain> [name] [description]
    local domain="$1" name="${2:-}" desc="${3:-}"
    flr_toml_set info relay_url "$(flr_toml_str "wss://${domain}/")" || return 1
    [[ -n "$name" ]] && flr_toml_set info name "$(flr_toml_str "$name")"
    [[ -n "$desc" ]] && flr_toml_set info description "$(flr_toml_str "$desc")"
    success "config.toml: relay_url = wss://${domain}/"
}

# Enable the built-in NIP-05 name authority for <domain> — self-service,
# NIP-98-authenticated username registration served on the relay's own listener
# (/.well-known/nostr.json + /api/v1/*, carved out to the relay in the nginx
# vhost by _nrd_ws_location). base_url is LOAD-BEARING: NIP-98 auth events are
# verified against it, so it must be the https:// URL clients actually reach —
# hence it's derived from the domain, never guessed. Shared by the guided setup
# (default-on prompt) and the admin menu so both write identical keys.
flr_enable_name_authority() {  # <domain>
    local domain="$1"
    [[ -n "$domain" ]] || { error "flr_enable_name_authority: no domain given."; return 1; }
    flr_toml_set name_authority enabled true || return 1
    flr_toml_set name_authority domain   "$(flr_toml_str "$domain")"
    flr_toml_set name_authority base_url "$(flr_toml_str "https://${domain}")"
    success "NIP-05 name authority enabled for @${domain}."
}

# ─── Landing page (served to browsers; relay clients still reach the relay) ──
# nginx serves $FLR_WWW/index.html to ordinary browser GETs while WebSocket +
# NIP-11 traffic is proxied to floonet-rs (see _nrd_ws_location). The page is a
# self-contained dark-mode explainer of the relay / Grin / floonet, with a
# copy-the-wss://-URL hero. Static NIP-11 fields are templated from config.toml;
# the live relay's NIP-11 document overrides them client-side at runtime.

flr_write_landing_page() {
    [[ -f "$FLR_CONFIG" ]] || { warn "No config.toml yet — skipping landing page."; return 1; }

    # Raw values (Python HTML-escapes them at render time — see below).
    local name desc software relay_url netlabel relayhost
    name=$(flr_toml_get info name 2>/dev/null || true);          [[ -n "$name" ]]     || name="Grin Relay"
    desc=$(flr_toml_get info description 2>/dev/null || true);   [[ -n "$desc" ]]     || desc="A Grin-native Nostr relay for private slatepack transport."
    software=$(flr_toml_get info software 2>/dev/null || true); [[ -n "$software" ]] || software="floonet-rs"
    relay_url=$(flr_toml_get info relay_url 2>/dev/null || true);[[ -n "$relay_url" ]]|| relay_url="wss://${FLR_DOMAIN}/"
    netlabel="floonet"
    # Bare host (no scheme, no trailing slash) — the template adds "/" where a
    # path is wanted. Shown before the client JS re-reads location.host.
    relayhost="${relay_url#wss://}"; relayhost="${relayhost#ws://}"; relayhost="${relayhost%/}"

    # Version + uptime for the status block. Version is a build-time fallback only —
    # the browser prefers the live NIP-11 `version` field (Python also prefers it
    # below). Uptime: floonet-rs never reports it in NIP-11, so bake the systemd
    # service start time (Unix seconds) and let the page count up from it live.
    local version started_epoch since_ts
    version=$("$FLR_BIN" --version 2>/dev/null | head -n1 || true)
    since_ts=$(systemctl show "$FLR_SVC" -p ActiveEnterTimestamp --value 2>/dev/null || true)
    if [[ -n "$since_ts" && "$since_ts" != "n/a" ]]; then
        started_epoch=$(date -d "$since_ts" +%s 2>/dev/null || echo "")
    else
        started_epoch=""
    fi

    # supported_nips must reflect what the relay ACTUALLY has activated, not a
    # guess. The relay computes that itself and publishes it in its NIP-11 doc,
    # so fetch it from the local listener and bake the real list into the page as
    # the SSR fallback (the browser re-fetches live too). Empty when the relay
    # isn't up yet (first deploy writes the page before service start) — then the
    # render falls back to FLR_LANDING_NIPS. Menu L / any re-run captures the live
    # list once the service is running.
    local live_nip11=""
    live_nip11=$(nrd_nip11_fetch "http://127.0.0.1:$(flr_port)" 2>/dev/null || true)

    mkdir -p "$FLR_WWW"
    local html
    [[ -r "$FLR_LANDING_SRC" ]] || { error "Landing template not found: $FLR_LANDING_SRC"; return 1; }
    html=$(<"$FLR_LANDING_SRC")
    # Render with Python: it HTML-escapes each value and does literal placeholder
    # replacement. Bash ${var//old/new} is deliberately NOT used here — bash 5.2
    # treats & and \ in the replacement string specially (sed-like), which would
    # silently corrupt any value containing them; 5.1 does not. Python is immune.
    # NIP-05 name-authority state gates the "claim a username" how-to: when it's
    # disabled, claiming would 404, so the block is omitted from the page entirely.
    local na_enabled
    na_enabled=$(flr_toml_get name_authority enabled 2>/dev/null || echo false)
    if ! FLR_TMPL="$html" FLR_NIP11="$live_nip11" python3 - \
            "$name" "$desc" "$software" "$relay_url" "$relayhost" \
            "$FLR_LANDING_NIPS" "$netlabel" "$version" "$started_epoch" "$na_enabled" \
            > "$FLR_WWW/index.html" <<'PYEOF'
import os, sys, json, time, re, html as H
tmpl = os.environ.get("FLR_TMPL", "")
a = (sys.argv[1:11] + [""] * 10)[:10]
name, desc, software, relay_url, relayhost, nips_csv, netlabel, version, started, na_enabled = a
esc = lambda s: H.escape(str(s) if s is not None else "", quote=True)

# Gate the "claim a username" how-to on NIP-05 name authority being enabled.
# Enabled → drop just the two marker comments and keep the block; disabled →
# strip the whole block so the page never tells users to claim an unregisterable
# name. Done here (not in bash) because the block is full of & entities and bash
# ${var//&/…} would corrupt them.
if str(na_enabled).strip().lower() == "true":
    tmpl = re.sub(r"[ \t]*<!--NAMEGUIDE-(?:START|END)-->[ \t]*\r?\n?", "", tmpl)
else:
    tmpl = re.sub(r"[ \t]*<!--NAMEGUIDE-START-->.*?<!--NAMEGUIDE-END-->[ \t]*\r?\n?",
                  "", tmpl, flags=re.S)

# Version fallback comes from `floonet-rs --version` ("floonet-rs x.y.z") — keep
# just the version token so it doesn't duplicate the software row.
if version:
    version = version.split()[-1]

# Prefer the relay's OWN live NIP-11 doc — it lists the ACTUALLY activated NIPs
# (and the real software/version strings). Fall back to the configured CSV /
# binary version when the relay wasn't reachable at write time (e.g. first
# deploy, before service start).
nips = [n.strip() for n in nips_csv.split(",") if n.strip()]
try:
    doc = json.loads(os.environ.get("FLR_NIP11", "") or "{}")
    if isinstance(doc.get("supported_nips"), list) and doc["supported_nips"]:
        nips = [str(n) for n in doc["supported_nips"]]
    if doc.get("software"):
        software = str(doc["software"]).rsplit("/", 1)[-1]
    if doc.get("version"):
        version = str(doc["version"])
except Exception:
    pass
if not version:
    version = "—"

# SSR uptime string from the baked start epoch (JS re-computes + ticks live).
def fmt_uptime(started):
    try:
        started = int(started)
    except (TypeError, ValueError):
        return "—"
    if started <= 0:
        return "—"
    secs = max(0, int(time.time()) - started)
    d, h, m = secs // 86400, (secs % 86400) // 3600, (secs % 3600) // 60
    pl = lambda n, w: "%d %s%s" % (n, w, "" if n == 1 else "s")
    if d:
        return "up %s, %s" % (pl(d, "day"), pl(h, "hour"))
    if h:
        return "up %s, %s" % (pl(h, "hour"), pl(m, "min"))
    return "up %s" % pl(m, "min")

# Join chips with a space so selecting/copying the row yields "1 2 9 11 …",
# not a run-together "12911…". The JS rebuild (live NIP-11) does the same.
chips = " ".join('<span class="chip">%s</span>' % esc(n) for n in nips)
repl = {
    "@@NAME@@": esc(name), "@@DESC@@": esc(desc),
    "@@SOFTWARE@@": esc(software), "@@RELAYURL@@": esc(relay_url),
    "@@RELAYHOST@@": esc(relayhost), "@@NIPS@@": chips, "@@NETLABEL@@": esc(netlabel),
    "@@NAMEEG@@": esc("grinmoney@" + relayhost),
    "@@VERSION@@": esc(version), "@@STARTED@@": esc(started or ""),
    "@@UPTIME_INIT@@": esc(fmt_uptime(started)),
}
for k, v in repl.items():
    tmpl = tmpl.replace(k, v)
# Always emit UTF-8 (the page declares charset=utf-8) — never rely on the
# process locale, which can be cp1252/ascii and mangle non-ASCII glyphs.
sys.stdout.buffer.write(tmpl.encode("utf-8"))
PYEOF
    then
        error "Could not render $FLR_WWW/index.html"; return 1
    fi
    chmod 755 "$FLR_WWW"; chmod 644 "$FLR_WWW/index.html"
    success "Landing page written: $FLR_WWW/index.html"
    return 0
}

flr_nginx_setup() {  # <domain> <email>
    local domain="$1" email="$2" port; port=$(flr_port)
    # Zones first (script-specific, script09- prefixed conf.d files).
    nginx_ensure_rate_limit_zone "$FLR_REQ_ZONE" "60r/m" "10m" "script09-floonet"
    nginx_ensure_conn_limit_zone "$FLR_CONN_ZONE" "10m" "script09-floonet-conn"
    # Build the browser landing page (non-fatal — relay still works without it).
    flr_write_landing_page || warn "Landing page not written — relay serves proxy-only."
    nrd_deploy_wss_vhost "$FLR_SITE_NAME" "$domain" "$email" "$port" \
        "$FLR_REQ_ZONE" "$FLR_CONN_ZONE" "$FLR_WWW" || return 1
    nrd_firewall_open_web
    return 0
}

flr_start_verify() {
    # Heal a leftover DynamicUser symlink before start (status=238/STATE_DIRECTORY
    # otherwise) — safe no-op on a clean install or a live DynamicUser unit.
    _flr_heal_state_dir
    systemctl daemon-reload
    systemctl enable "$FLR_SVC" >/dev/null 2>&1 || true
    info "Starting ${FLR_SVC}…"
    systemctl restart "$FLR_SVC" || true
    sleep 3
    if [[ "$(flr_svc_state)" != "active" ]]; then
        error "Service failed to start. Last log lines:"
        journalctl -u "$FLR_SVC" -n 15 --no-pager 2>/dev/null || true
        return 1
    fi
    success "Service active."
    local port; port=$(flr_port)
    if nrd_ws_handshake_test "http://127.0.0.1:${port}"; then
        success "WebSocket handshake OK on 127.0.0.1:${port}."
    else
        warn "No WebSocket handshake on 127.0.0.1:${port} yet (relay may still be initialising)."
    fi
    # The landing page was written in step 7, BEFORE the service started, so its
    # baked uptime start-time (and any live NIP-11 fields) were unavailable then.
    # Now that the relay is up, rebuild it once so the status block is accurate on
    # first deploy — no nginx reload needed (nginx serves the static file directly).
    flr_load_conf
    flr_write_landing_page >/dev/null 2>&1 || true
    return 0
}

# ══════════════════════════════════════════════════════════════════════════════
# MONITORING / CONTROL
# ══════════════════════════════════════════════════════════════════════════════

flr_status_dashboard() {
    clear
    flr_load_conf
    local port state; port=$(flr_port); state=$(flr_svc_state)
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Floonet Relay — Status${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    # Service
    local state_col="${RED}${state:-not installed}${RESET}"
    [[ "$state" == "active" ]] && state_col="${GREEN}active${RESET}"
    local since=""
    since=$(systemctl show "$FLR_SVC" -p ActiveEnterTimestamp --value 2>/dev/null || true)
    echo -e "  Service      : $state_col  ${DIM}${since:+since $since}${RESET}"
    local ver=""
    ver=$("$FLR_BIN" --version 2>/dev/null | head -n1 || true)
    echo -e "  Binary       : ${FLR_BIN} ${DIM}${ver}${RESET}"
    echo -e "  Relay URL    : ${BOLD}$(flr_relay_url)${RESET}"

    # Listener
    if ss -tln 2>/dev/null | grep -q ":${port} "; then
        echo -e "  Listener     : ${GREEN}127.0.0.1:${port} listening${RESET}"
    else
        echo -e "  Listener     : ${RED}nothing on :${port}${RESET}"
    fi

    # nginx + certificate
    if nginx_site_is_enabled "$FLR_SITE_NAME"; then
        local cert="/etc/letsencrypt/live/${FLR_DOMAIN}/cert.pem" days="?"
        if [[ -n "$FLR_DOMAIN" && -f "$cert" ]]; then
            local end epoch_end epoch_now
            end=$(openssl x509 -enddate -noout -in "$cert" 2>/dev/null | cut -d= -f2 || true)
            if [[ -n "$end" ]]; then
                epoch_end=$(date -d "$end" +%s 2>/dev/null || echo 0)
                epoch_now=$(date +%s)
                days=$(( (epoch_end - epoch_now) / 86400 ))
            fi
            echo -e "  nginx / SSL  : ${GREEN}enabled${RESET}  ${DIM}cert expires in ${days} days${RESET}"
        else
            echo -e "  nginx / SSL  : ${YELLOW}vhost enabled, no certificate${RESET} ${DIM}(ws:// only — re-run SSL setup)${RESET}"
        fi
    else
        echo -e "  nginx / SSL  : ${RED}vhost not enabled${RESET}"
    fi

    # Data
    local dbsize db events="n/a"
    dbsize=$(du -sh "$FLR_STATE" 2>/dev/null | cut -f1 || echo "?")
    db=$(flr_db_path)
    if [[ -n "$db" ]] && command -v sqlite3 >/dev/null 2>&1; then
        events=$(sqlite3 -readonly "$db" "SELECT COUNT(*) FROM event;" 2>/dev/null || echo "n/a")
    fi
    echo -e "  Data         : ${FLR_STATE} ${DIM}(${dbsize})${RESET}   events stored: ${BOLD}${events}${RESET}"

    # Recent errors
    local errs
    errs=$(journalctl -u "$FLR_SVC" --since "-1h" -p err --no-pager 2>/dev/null | grep -c . || true)
    if [[ "${errs:-0}" -gt 1 ]]; then
        echo -e "  Journal      : ${YELLOW}${errs} error lines in the last hour${RESET} ${DIM}(option 4 → live logs)${RESET}"
    else
        echo -e "  Journal      : ${GREEN}no recent errors${RESET}"
    fi

    # Live end-to-end probes
    echo ""
    echo -e "  ${BOLD}Live checks${RESET}"
    if nrd_ws_handshake_test "http://127.0.0.1:${port}"; then
        echo -e "    Local  ws://127.0.0.1:${port}   ${GREEN}✓ handshake OK${RESET}"
    else
        echo -e "    Local  ws://127.0.0.1:${port}   ${RED}✗ no handshake${RESET}"
    fi
    if [[ -n "$FLR_DOMAIN" ]]; then
        if nrd_ws_handshake_test "https://${FLR_DOMAIN}"; then
            echo -e "    Public wss://${FLR_DOMAIN}   ${GREEN}✓ handshake OK${RESET}"
        else
            echo -e "    Public wss://${FLR_DOMAIN}   ${RED}✗ no handshake${RESET} ${DIM}(DNS/SSL/firewall?)${RESET}"
        fi
    fi
    echo ""
    pause
}

flr_logs() {
    clear
    echo -e "${BOLD}${CYAN}── Floonet relay — live logs (Ctrl-C to return) ──${RESET}\n"
    # Trap INT so Ctrl-C only stops journalctl, not the whole menu script.
    trap ':' INT
    journalctl -u "$FLR_SVC" -n 50 -f --no-pager 2>/dev/null || true
    trap - INT
    echo ""
    return 0
}

flr_service_control() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}── Floonet relay — service control ──${RESET}\n"
        echo -e "  Current state: ${BOLD}$(flr_svc_state)${RESET}\n"
        echo -e "  ${GREEN}1${RESET}) Restart"
        echo -e "  ${GREEN}2${RESET}) Start"
        echo -e "  ${GREEN}3${RESET}) Stop"
        echo -e "  ${GREEN}4${RESET}) Enable autostart on boot"
        echo -e "  ${GREEN}5${RESET}) Disable autostart"
        echo -e "  ${DIM}0) Back${RESET}\n"
        echo -ne "${BOLD}Select: ${RESET}"
        local c; read -r c || true
        case "$c" in
            1) systemctl restart "$FLR_SVC" && success "Restarted." || error "Restart failed — check logs." ;;
            2) systemctl start "$FLR_SVC" && success "Started." || error "Start failed — check logs." ;;
            3) systemctl stop "$FLR_SVC" && success "Stopped." || error "Stop failed." ;;
            4) systemctl enable "$FLR_SVC" >/dev/null 2>&1 && success "Autostart enabled." || error "Failed." ;;
            5) systemctl disable "$FLR_SVC" >/dev/null 2>&1 && success "Autostart disabled." || error "Failed." ;;
            0|"") return 0 ;;
            *) warn "Invalid option."; sleep 1; continue ;;
        esac
        [[ "$c" =~ ^[123]$ ]] && { sleep 2; echo -e "  State now: ${BOLD}$(flr_svc_state)${RESET}"; }
        pause
    done
}

flr_test_relay() {
    clear
    flr_load_conf
    local port; port=$(flr_port)
    echo -e "${BOLD}${CYAN}── Floonet relay — connectivity test ──${RESET}\n"
    info "1/3 Local WebSocket handshake (ws://127.0.0.1:${port})…"
    if nrd_ws_handshake_test "http://127.0.0.1:${port}"; then
        success "Relay answers WebSocket upgrades locally."
    else
        error "No local handshake — the relay itself is down or mis-bound. Check logs (menu 4)."
    fi
    if [[ -n "$FLR_DOMAIN" ]]; then
        echo ""
        info "2/3 Public WebSocket handshake (wss://${FLR_DOMAIN})…"
        if nrd_ws_handshake_test "https://${FLR_DOMAIN}"; then
            success "Public wss:// works — wallets can connect to wss://${FLR_DOMAIN}"
        else
            error "Public handshake failed — check DNS, certificate, and firewall."
        fi
        echo ""
        info "3/3 NIP-11 relay information document…"
        local nip11
        if nip11=$(nrd_nip11_fetch "https://${FLR_DOMAIN}"); then
            echo "$nip11" | python3 -m json.tool 2>/dev/null | head -n 20 || echo "$nip11"
            success "Relay identifies itself correctly."
        else
            warn "No NIP-11 document — some clients use it for discovery (not fatal)."
        fi
    else
        warn "No domain saved yet — public checks skipped (run setup first)."
    fi
    echo ""
    pause
}

# ══════════════════════════════════════════════════════════════════════════════
# CONFIGURATION MENUS (all write config.toml, then offer a restart)
# ══════════════════════════════════════════════════════════════════════════════

_flr_offer_restart() {
    echo -ne "  Apply now (restart the relay)? [Y/n]: "
    local c; read -r c || true
    if [[ "${c,,}" != "n" ]]; then
        systemctl restart "$FLR_SVC" 2>/dev/null && success "Relay restarted." \
            || error "Restart failed — check logs."
    else
        info "Saved — will apply on next restart."
    fi
    return 0
}

_flr_toggle_bool() {  # <section> <key> <label>
    local section="$1" key="$2" label="$3" cur new
    cur=$(flr_toml_get "$section" "$key"); cur="${cur:-false}"
    if [[ "$cur" == "true" ]]; then new="false"; else new="true"; fi
    echo -ne "  ${label} is ${BOLD}${cur}${RESET} — set to ${new}? [Y/n]: "
    local c; read -r c || true
    if [[ "${c,,}" == "n" ]]; then
        info "Unchanged."
        return 1   # nothing changed → caller must not offer a restart
    fi
    flr_toml_set "$section" "$key" "$new" && success "${key} = ${new}"
    return 0
}

# Prompt for a comma-separated pubkey list → TOML array of strings. Every item
# must be a 64-char hex Nostr pubkey (an npub… would silently never match and a
# stray quote would corrupt the TOML). Empty input clears the list.
_flr_set_pubkey_array() {  # <section> <key> <prompt>
    local section="$1" key="$2" prompt="$3" line
    echo -e "  ${DIM}Current: $(flr_toml_get "$section" "$key" || echo '(unset)')${RESET}"
    echo -ne "  ${prompt} (comma-separated hex, blank = empty list, 0 = cancel): "
    read -r line || true
    [[ "$line" == "0" ]] && return 0
    local arr="[" first=1 item
    IFS=',' read -ra _items <<< "$line"
    for item in "${_items[@]}"; do
        item="${item//[[:space:]]/}"
        [[ -n "$item" ]] || continue
        if ! [[ "$item" =~ ^[0-9a-fA-F]{64}$ ]]; then
            warn "'${item}' is not a 64-char hex pubkey (convert npub… to hex first) — nothing changed."
            sleep 2
            return 1
        fi
        [[ $first -eq 0 ]] && arr+=", "
        arr+="\"$item\""
        first=0
    done
    arr+="]"
    flr_toml_set "$section" "$key" "$arr" && success "${key} = ${arr}"
    return 0
}

flr_menu_settings() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}── Relay settings (config.toml [info] / [limits]) ──${RESET}\n"
        echo -e "  Name        : $(flr_toml_get info name || echo '(unset)')"
        echo -e "  Description : $(flr_toml_get info description || echo '(unset)')"
        echo -e "  Relay URL   : $(flr_toml_get info relay_url || echo '(unset)')"
        echo -e "  Max event   : $(flr_toml_get limits max_event_bytes || echo '(upstream default)') bytes"
        echo -e "  Kind list   : ${DIM}$(flr_toml_get limits event_kind_allowlist || echo '(upstream default — 24-kind default-deny)')${RESET}"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Set relay name"
        echo -e "  ${GREEN}2${RESET}) Set description"
        echo -e "  ${GREEN}3${RESET}) Set max event size (bytes)"
        echo -e "  ${GREEN}4${RESET}) Edit event-kind allowlist ${DIM}(advanced — the default-deny list is what keeps a relay lean; only change it if you know the kinds you need)${RESET}"
        echo -e "  ${DIM}0) Back${RESET}\n"
        echo -ne "${BOLD}Select: ${RESET}"
        local c v; read -r c || true
        case "$c" in
            1) echo -ne "  New name: "; read -r v || true
               [[ -n "$v" ]] && flr_toml_set info name "$(flr_toml_str "$v")" && _flr_offer_restart ;;
            2) echo -ne "  New description: "; read -r v || true
               [[ -n "$v" ]] && flr_toml_set info description "$(flr_toml_str "$v")" && _flr_offer_restart ;;
            3) echo -ne "  Max event bytes (e.g. 131072): "; read -r v || true
               if [[ "$v" =~ ^[0-9]+$ ]]; then
                   flr_toml_set limits max_event_bytes "$v" && _flr_offer_restart
               else
                   warn "Not a number — unchanged."; sleep 1
               fi ;;
            4) echo -e "  ${DIM}Enter Nostr kind numbers, e.g. 0,1,4,1059,10002${RESET}"
               echo -ne "  Kinds (comma-separated, blank = cancel): "
               read -r v || true
               if [[ -n "$v" && "$v" =~ ^[0-9,[:space:]]+$ ]]; then
                   local arr="[${v//[[:space:]]/}]"
                   flr_toml_set limits event_kind_allowlist "$arr" && _flr_offer_restart
               else
                   warn "Cancelled / invalid."; sleep 1
               fi ;;
            0|"") return 0 ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

flr_menu_access() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}── Access control (config.toml [authorization]) ──${RESET}\n"
        echo -e "  ${DIM}Who may read from / write to your relay. Defaults are open —${RESET}"
        echo -e "  ${DIM}tighten these if you want a private or invite-only relay.${RESET}\n"
        echo -e "  NIP-42 auth (require login to read) : $(flr_toml_get authorization nip42_auth || echo 'false')"
        echo -e "  NIP-42 for DMs only                 : $(flr_toml_get authorization nip42_dms || echo 'false')"
        echo -e "  Require auth to WRITE               : $(flr_toml_get authorization require_auth_to_write || echo 'false')"
        echo -e "  Pubkey whitelist (writers)          : ${DIM}$(flr_toml_get authorization pubkey_whitelist || echo '(open)')${RESET}"
        echo -e "  Public note authors                 : ${DIM}$(flr_toml_get authorization public_note_authors || echo '(open)')${RESET}"
        echo ""
        echo -e "  ${DIM}floonet-rs never expires stored events, so an open relay grows without${RESET}"
        echo -e "  ${DIM}bound. 'Require auth to write' is the cheapest brake — it keeps anonymous${RESET}"
        echo -e "  ${DIM}strangers from parking data on your disk while still letting anyone who${RESET}"
        echo -e "  ${DIM}proves a key (any wallet) send you a slatepack. See R) for retention.${RESET}\n"
        echo -e "  ${GREEN}1${RESET}) Toggle NIP-42 auth"
        echo -e "  ${GREEN}2${RESET}) Toggle NIP-42 for DMs"
        echo -e "  ${GREEN}3${RESET}) Toggle require auth to write ${DIM}(anti-abuse brake)${RESET}"
        echo -e "  ${GREEN}4${RESET}) Set pubkey whitelist (hex pubkeys)"
        echo -e "  ${GREEN}5${RESET}) Set public note authors (hex pubkeys)"
        echo -e "  ${DIM}0) Back${RESET}\n"
        echo -ne "${BOLD}Select: ${RESET}"
        local c; read -r c || true
        case "$c" in
            1) _flr_toggle_bool authorization nip42_auth "NIP-42 auth" && _flr_offer_restart ;;
            2) _flr_toggle_bool authorization nip42_dms "NIP-42 for DMs" && _flr_offer_restart ;;
            3) _flr_toggle_bool authorization require_auth_to_write "Require auth to write" && _flr_offer_restart ;;
            4) _flr_set_pubkey_array authorization pubkey_whitelist "Allowed writer pubkeys" && _flr_offer_restart ;;
            5) _flr_set_pubkey_array authorization public_note_authors "Public note author pubkeys" && _flr_offer_restart ;;
            0|"") return 0 ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

flr_menu_name_authority() {
    flr_load_conf
    while true; do
        clear
        echo -e "${BOLD}${CYAN}── Name authority — NIP-05 usernames (config.toml [name_authority]) ──${RESET}\n"
        echo -e "  ${DIM}Lets people register name@your-domain usernames on your relay.${RESET}"
        echo -e "  ${DIM}base_url must match the public relay URL (NIP-98 verification).${RESET}\n"
        echo -e "  Enabled  : $(flr_toml_get name_authority enabled || echo 'false')"
        echo -e "  Domain   : $(flr_toml_get name_authority domain || echo '(unset)')"
        echo -e "  Base URL : $(flr_toml_get name_authority base_url || echo '(unset)')"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Enable with defaults ${DIM}(domain=${FLR_DOMAIN:-?}, base_url=https://${FLR_DOMAIN:-?})${RESET}"
        echo -e "  ${GREEN}2${RESET}) Disable"
        echo -e "  ${GREEN}3${RESET}) Set custom domain / base URL"
        echo -e "  ${DIM}0) Back${RESET}\n"
        echo -ne "${BOLD}Select: ${RESET}"
        local c v; read -r c || true
        case "$c" in
            1) [[ -z "$FLR_DOMAIN" ]] && { warn "No domain saved — run setup first."; sleep 2; continue; }
               flr_enable_name_authority "$FLR_DOMAIN" && _flr_offer_restart ;;
            2) flr_toml_set name_authority enabled false && success "Disabled."
               _flr_offer_restart ;;
            3) echo -ne "  NIP-05 domain: "; read -r v || true
               [[ -n "$v" ]] && flr_toml_set name_authority domain "$(flr_toml_str "$v")"
               echo -ne "  Base URL (https://…): "; read -r v || true
               [[ -n "$v" ]] && flr_toml_set name_authority base_url "$(flr_toml_str "$v")"
               _flr_offer_restart ;;
            0|"") return 0 ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

flr_menu_goblinpay() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}── GoblinPay — charge GRIN for registration (config.toml [goblinpay]) ──${RESET}\n"
        echo -e "  ${DIM}Optional: monetise the relay via a GoblinPay server. pay_mode:${RESET}"
        echo -e "  ${DIM}off = free · name = charge for NIP-05 names · write = charge for write access${RESET}\n"
        local token_state="(unset)"
        if grep -qs '^FLOONET_GOBLINPAY_TOKEN=' "$FLR_ENV_FILE" 2>/dev/null; then
            token_state="set (env file)"
        elif flr_toml_get goblinpay api_token >/dev/null 2>&1; then
            token_state="set (config.toml)"
        fi
        echo -e "  pay_mode  : $(flr_toml_get goblinpay pay_mode || echo 'off')"
        echo -e "  URL       : $(flr_toml_get goblinpay url || echo '(unset)')"
        echo -e "  API token : ${token_state}"
        echo -e "  Name price      : $(flr_toml_get goblinpay name_price_grin || echo '(unset)') GRIN"
        echo -e "  Admission price : $(flr_toml_get goblinpay admission_price_grin || echo '(unset)') GRIN"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Set pay_mode (off / name / write)"
        echo -e "  ${GREEN}2${RESET}) Set GoblinPay server URL"
        echo -e "  ${GREEN}3${RESET}) Set API token ${DIM}(stored in ${FLR_ENV_FILE}, mode 600)${RESET}"
        echo -e "  ${GREEN}4${RESET}) Set prices (GRIN)"
        echo -e "  ${DIM}0) Back${RESET}\n"
        echo -ne "${BOLD}Select: ${RESET}"
        local c v; read -r c || true
        case "$c" in
            1) echo -ne "  pay_mode [off/name/write]: "; read -r v || true
               if [[ "$v" =~ ^(off|name|write)$ ]]; then
                   # A paid mode with no url makes floonet-rs panic on start
                   # ("goblinpay.url must be set when goblinpay.pay_mode is
                   # enabled") — refuse to create that unbootable state.
                   local _cur_url; _cur_url=$(flr_toml_get goblinpay url 2>/dev/null || true)
                   if [[ "$v" != "off" && -z "$_cur_url" ]]; then
                       warn "pay_mode='$v' needs a GoblinPay URL — set option 2 first,"
                       warn "or the relay will refuse to start. Leaving pay_mode unchanged."
                       sleep 2
                   else
                       flr_toml_set goblinpay pay_mode "$(flr_toml_str "$v")" && _flr_offer_restart
                   fi
               else
                   warn "Must be off, name, or write."; sleep 1
               fi ;;
            2) echo -ne "  GoblinPay URL (https://…): "; read -r v || true
               [[ -n "$v" ]] && flr_toml_set goblinpay url "$(flr_toml_str "$v")" && _flr_offer_restart ;;
            3) echo -ne "  API token (input hidden): "; read -rs v || true; echo ""
               if [[ -n "$v" ]]; then
                   ( umask 077; touch "$FLR_ENV_FILE" )
                   # Replace or append the env override the unit picks up.
                   sed -i '/^FLOONET_GOBLINPAY_TOKEN=/d' "$FLR_ENV_FILE" 2>/dev/null || true
                   echo "FLOONET_GOBLINPAY_TOKEN=${v}" >> "$FLR_ENV_FILE"
                   chmod 600 "$FLR_ENV_FILE"
                   # Make sure the unit loads the env file (drop-in survives upstream upgrades).
                   mkdir -p "/etc/systemd/system/${FLR_SVC}.service.d"
                   printf '[Service]\nEnvironmentFile=-%s\n' "$FLR_ENV_FILE" \
                       > "/etc/systemd/system/${FLR_SVC}.service.d/toolkit-env.conf"
                   systemctl daemon-reload
                   success "Token stored (env override, never in config.toml)."
                   _flr_offer_restart
               fi
               unset v ;;
            4) echo -ne "  Name registration price (GRIN, blank=skip): "; read -r v || true
               [[ "$v" =~ ^[0-9]+(\.[0-9]+)?$ ]] && flr_toml_set goblinpay name_price_grin "$v"
               echo -ne "  Write admission price (GRIN, blank=skip): "; read -r v || true
               [[ "$v" =~ ^[0-9]+(\.[0-9]+)?$ ]] && flr_toml_set goblinpay admission_price_grin "$v"
               _flr_offer_restart ;;
            0|"") return 0 ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

flr_edit_config() {
    [[ -f "$FLR_CONFIG" ]] || { warn "No $FLR_CONFIG yet — install first."; pause; return 0; }
    "${EDITOR:-nano}" "$FLR_CONFIG"
    _flr_offer_restart
}

# ══════════════════════════════════════════════════════════════════════════════
# UPDATE / MIXNET EXIT / UNINSTALL
# ══════════════════════════════════════════════════════════════════════════════

flr_update() {
    clear
    echo -e "${BOLD}${CYAN}── Update floonet-rs ──${RESET}\n"
    [[ -d "$FLR_SRC/.git" ]] || { warn "No source checkout — run the guided setup instead."; pause; return 0; }
    flr_load_conf
    flr_fetch_source || { pause; return 0; }
    local head
    head=$(git -C "$FLR_SRC" rev-parse HEAD 2>/dev/null || echo "?")
    if [[ "$head" != "?" && "$head" == "$FLR_INSTALLED_REV" && -x "$FLR_BIN" ]]; then
        success "Already up to date ($(git -C "$FLR_SRC" rev-parse --short HEAD 2>/dev/null))."
        pause; return 0
    fi
    flr_ensure_rust  || { pause; return 0; }
    flr_build        || { pause; return 0; }
    flr_install_binary || { pause; return 0; }
    info "Restarting relay with the new binary…"
    systemctl restart "$FLR_SVC" 2>/dev/null || true
    sleep 2
    [[ "$(flr_svc_state)" == "active" ]] && success "Updated and running." \
        || error "Service not active after update — check logs (menu 4)."
    pause
}

# ─── Event retention ─────────────────────────────────────────────────────────
# floonet-rs inherits nostr-rs-relay's storage model: a stored event is kept
# FOREVER — there is no retention, pruning, or NIP-40 expiry key upstream. On a
# relay that accepts writes from strangers that means unbounded disk growth, so
# this is ours to provide. Two deliberate choices:
#
#   * Age is measured on `first_seen` (when WE received it), never `created_at`.
#     A gift wrap's created_at is deliberately fuzzed up to 2 days into the past
#     and is entirely sender-controlled — pruning on it is both wrong and
#     trivially gameable by a sender who backdates.
#   * Identity kinds are refused outright. A profile, contact list or relay list
#     is the ONLY copy in existence; ageing it out destroys data rather than
#     reclaiming space. Traffic is disposable, identity is not.
#
# No automatic VACUUM: freed pages are reused by SQLite, so the file stops
# GROWING (the actual goal) without needing a lock-the-world rewrite. Reclaiming
# space to the OS is a separate, explicit action.

# Refuse kinds that must never be age-pruned.
_flr_prune_kind_ok() {  # <kind>
    local k="$1" deny
    for deny in $FLR_PRUNE_DENY_KINDS; do
        if [[ "$k" == "$deny" ]]; then
            error "Kind $k is identity/config data, not traffic — refusing to prune it."
            return 1
        fi
    done
    if (( k >= 10000 && k <= 19999 )); then
        error "Kind $k is replaceable (10000–19999) — the stored copy is the only one. Refusing."
        return 1
    fi
    if (( k >= 30000 && k <= 39999 )); then
        error "Kind $k is addressable (30000–39999) — the stored copy is the only one. Refusing."
        return 1
    fi
    return 0
}

# Validate + normalise a kind list ("1059,1" or "1059 1") → space-separated.
# Echoes the cleaned list on success.
_flr_prune_clean_kinds() {  # <list>
    local raw="${1//,/ }" out="" k
    for k in $raw; do
        [[ "$k" =~ ^[0-9]+$ ]] || { error "'$k' is not a kind number."; return 1; }
        _flr_prune_kind_ok "$k" || return 1
        out+="${out:+ }$k"
    done
    [[ -n "$out" ]] || { error "No kinds given."; return 1; }
    printf '%s' "$out"
}

# Delete events of <kinds> older than <days>. Batched so the live relay never
# waits on a long write lock. dry=1 counts without deleting.
flr_prune_run() {  # <days> <kinds> [dry]
    local days="$1" kinds="$2" dry="${3:-0}"
    local db; db=$(flr_db_path)
    [[ -n "$db" ]] || { error "No SQLite database found in $FLR_STATE."; return 1; }
    command -v sqlite3 >/dev/null 2>&1 || { error "sqlite3 not installed."; return 1; }
    [[ "$days" =~ ^[0-9]+$ ]] || { error "Days must be a number."; return 1; }
    if (( days < FLR_PRUNE_MIN_DAYS )); then
        error "Refusing a ${days}-day retention — minimum is ${FLR_PRUNE_MIN_DAYS} days."
        echo -e "  ${DIM}goblin looks back 3 days for missed messages and holds unsent slates${RESET}"
        echo -e "  ${DIM}for 24h; pruning tighter than that deletes slatepacks still in flight.${RESET}"
        return 1
    fi
    local clean; clean=$(_flr_prune_clean_kinds "$kinds") || return 1

    # The schema must actually have first_seen — if upstream ever renames it we
    # must stop, not silently fall back to the sender-controlled created_at.
    if ! sqlite3 -readonly "$db" "SELECT first_seen FROM event LIMIT 1;" >/dev/null 2>&1; then
        error "This database has no 'first_seen' column — upstream schema changed."
        echo -e "  ${DIM}Not falling back to created_at: it is sender-controlled and fuzzed.${RESET}"
        return 1
    fi

    local inlist="${clean// /,}"
    local cutoff=$(( $(date +%s) - days * 86400 ))
    local pending
    pending=$(sqlite3 -readonly "$db" \
        "SELECT COUNT(*) FROM event WHERE kind IN ($inlist) AND first_seen < $cutoff;" 2>/dev/null || echo 0)
    pending=${pending:-0}

    if [[ "$dry" == "1" ]]; then
        echo -e "  Would delete ${BOLD}${pending}${RESET} event(s) — kinds [${clean// /, }] older than ${days}d."
        return 0
    fi
    if (( pending == 0 )); then
        info "Nothing to prune (kinds [${clean// /, }] older than ${days}d)."
        return 0
    fi

    local total=0 n
    while true; do
        n=$(sqlite3 "$db" \
            "PRAGMA busy_timeout=15000; PRAGMA foreign_keys=ON;
             DELETE FROM event WHERE id IN (
               SELECT id FROM event
                WHERE kind IN ($inlist) AND first_seen < $cutoff
                LIMIT 2000);
             SELECT changes();" 2>/dev/null) || { error "Delete failed (database locked?)."; return 1; }
        n=${n:-0}
        [[ "$n" =~ ^[0-9]+$ ]] || n=0
        total=$(( total + n ))
        (( n > 0 )) || break
    done

    # foreign_keys=ON only cascades if upstream declared the FK; sweep any
    # orphaned tag rows regardless so they can't accumulate silently.
    if sqlite3 -readonly "$db" "SELECT event_id FROM tag LIMIT 1;" >/dev/null 2>&1; then
        sqlite3 "$db" "PRAGMA busy_timeout=15000;
            DELETE FROM tag WHERE NOT EXISTS (SELECT 1 FROM event e WHERE e.id = tag.event_id);" \
            >/dev/null 2>&1 || true
    fi

    success "Pruned ${total} event(s) — kinds [${clean// /, }] older than ${days}d."
    return 0
}

# Cron wrapper — regenerated on every enable so settings changes land.
_flr_write_prune_wrapper() {
    mkdir -p "$(dirname "$FLR_PRUNE_LOG")" 2>/dev/null || true
    cat > "$FLR_PRUNE_WRAPPER" <<WRAP
#!/bin/bash
# Grin Floonet relay — event retention. Generated by 091_grin_floonet_relay.sh.
# Prunes disposable traffic by first_seen. Identity kinds are never touched.
set -uo pipefail
DB=\$(ls -S ${FLR_STATE}/*.db 2>/dev/null | head -n1)
LOG="${FLR_PRUNE_LOG}"
TS=\$(date '+%Y-%m-%d %H:%M:%S')
DAYS=${FLR_PRUNE_DAYS}
KINDS="${FLR_PRUNE_KINDS// /,}"
[[ -n "\$DB" ]] || { echo "[\$TS] no database found" >> "\$LOG"; exit 0; }
[[ "\$DAYS" -ge ${FLR_PRUNE_MIN_DAYS} ]] || { echo "[\$TS] retention below floor — skipped" >> "\$LOG"; exit 0; }
CUTOFF=\$(( \$(date +%s) - DAYS * 86400 ))
TOTAL=0
while :; do
    N=\$(sqlite3 "\$DB" \\
        "PRAGMA busy_timeout=15000; PRAGMA foreign_keys=ON;
         DELETE FROM event WHERE id IN (
           SELECT id FROM event WHERE kind IN (\$KINDS) AND first_seen < \$CUTOFF LIMIT 2000);
         SELECT changes();" 2>/dev/null) || { echo "[\$TS] delete failed (locked?)" >> "\$LOG"; exit 0; }
    [[ "\$N" =~ ^[0-9]+\$ ]] || N=0
    TOTAL=\$(( TOTAL + N ))
    [[ "\$N" -gt 0 ]] || break
done
sqlite3 "\$DB" "PRAGMA busy_timeout=15000;
    DELETE FROM tag WHERE NOT EXISTS (SELECT 1 FROM event e WHERE e.id = tag.event_id);" \\
    >/dev/null 2>&1 || true
echo "[\$TS] pruned \$TOTAL event(s) — kinds \$KINDS older than \${DAYS}d" >> "\$LOG"
WRAP
    chmod 750 "$FLR_PRUNE_WRAPPER"
}

flr_menu_retention() {
    local c v db
    while true; do
        clear
        flr_load_conf
        echo -e "${BOLD}${CYAN}── Event retention (disk growth control) ──${RESET}\n"
        echo -e "  ${DIM}floonet-rs keeps every event forever — there is no upstream retention${RESET}"
        echo -e "  ${DIM}setting. On an open relay that means the database only ever grows.${RESET}"
        echo -e "  ${DIM}This ages out disposable TRAFFIC. Identity events (profile, contacts,${RESET}"
        echo -e "  ${DIM}relay lists) are refused — they have no other copy.${RESET}\n"

        db=$(flr_db_path)
        if [[ -n "$db" ]] && command -v sqlite3 >/dev/null 2>&1; then
            local sz ev
            sz=$(du -h "$db" 2>/dev/null | cut -f1 || echo "?")
            ev=$(sqlite3 -readonly "$db" "SELECT COUNT(*) FROM event;" 2>/dev/null || echo "?")
            echo -e "  Database   : ${BOLD}${sz}${RESET} ${DIM}($ev events · $db)${RESET}"
        else
            echo -e "  Database   : ${DIM}(not found)${RESET}"
        fi
        local sched="${DIM}off — keeping everything${RESET}"
        [[ -f "$FLR_PRUNE_CRON" ]] && sched="${GREEN}daily $(printf '%02d:%02d' "$FLR_PRUNE_HOUR" "$FLR_PRUNE_MIN")${RESET}"
        echo -e "  Schedule   : $sched"
        echo -e "  Retention  : ${BOLD}${FLR_PRUNE_DAYS}${RESET} days ${DIM}(0 = off · floor ${FLR_PRUNE_MIN_DAYS}d)${RESET}"
        echo -e "  Kinds      : ${BOLD}${FLR_PRUNE_KINDS}${RESET} ${DIM}(1059 = gift wraps, the slatepack envelopes)${RESET}"
        echo -e "  Log        : ${DIM}${FLR_PRUNE_LOG}${RESET}"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Set retention age (days)"
        echo -e "  ${GREEN}2${RESET}) Set kinds to prune"
        echo -e "  ${GREEN}3${RESET}) Preview ${DIM}(dry run — counts, deletes nothing)${RESET}"
        echo -e "  ${GREEN}4${RESET}) Run prune now"
        echo -e "  ${GREEN}5${RESET}) $([[ -f "$FLR_PRUNE_CRON" ]] && echo "Disable" || echo "Enable") daily schedule"
        echo -e "  ${GREEN}6${RESET}) Reclaim disk space ${DIM}(VACUUM — locks the DB, needs 2× size free)${RESET}"
        echo -e "  ${DIM}0) Back${RESET}\n"
        echo -ne "${BOLD}Select: ${RESET}"
        read -r c || true
        case "$c" in
            1) echo -ne "  Keep events for how many days? (min ${FLR_PRUNE_MIN_DAYS}, 0 = off): "
               read -r v || true
               if [[ "$v" =~ ^[0-9]+$ ]] && { (( v == 0 )) || (( v >= FLR_PRUNE_MIN_DAYS )); }; then
                   FLR_PRUNE_DAYS="$v"; flr_save_conf
                   [[ -f "$FLR_PRUNE_CRON" ]] && _flr_write_prune_wrapper
                   success "Retention = ${v} days."
               else
                   warn "Must be 0 (off) or at least ${FLR_PRUNE_MIN_DAYS} — unchanged."
               fi; sleep 1 ;;
            2) echo -e "  ${DIM}Kind numbers to age out, e.g. 1059 (gift wraps) or 1059,1${RESET}"
               echo -e "  ${DIM}Identity kinds (0, 3, 5, 10000–19999, 30000–39999) are refused.${RESET}"
               echo -ne "  Kinds (blank = cancel): "
               read -r v || true
               if [[ -n "$v" ]]; then
                   local cleaned
                   if cleaned=$(_flr_prune_clean_kinds "$v"); then
                       FLR_PRUNE_KINDS="$cleaned"; flr_save_conf
                       [[ -f "$FLR_PRUNE_CRON" ]] && _flr_write_prune_wrapper
                       success "Kinds = ${cleaned}"
                   fi
               else
                   info "Cancelled."
               fi; pause ;;
            3) if (( FLR_PRUNE_DAYS == 0 )); then
                   warn "Retention is off — set an age first."
               else
                   flr_prune_run "$FLR_PRUNE_DAYS" "$FLR_PRUNE_KINDS" 1 || true
               fi; pause ;;
            4) if (( FLR_PRUNE_DAYS == 0 )); then
                   warn "Retention is off — set an age first."; pause
               else
                   flr_prune_run "$FLR_PRUNE_DAYS" "$FLR_PRUNE_KINDS" 1 || true
                   echo -ne "\n  Proceed with the delete? [y/N]: "
                   read -r v || true
                   if [[ "${v,,}" == "y" ]]; then
                       flr_prune_run "$FLR_PRUNE_DAYS" "$FLR_PRUNE_KINDS" 0 || true
                   else
                       info "Cancelled."
                   fi
                   pause
               fi ;;
            5) if [[ -f "$FLR_PRUNE_CRON" ]]; then
                   rm -f "$FLR_PRUNE_CRON" "$FLR_PRUNE_WRAPPER"
                   success "Daily prune disabled."
               elif (( FLR_PRUNE_DAYS == 0 )); then
                   warn "Set a retention age first (option 1)."
               else
                   _flr_write_prune_wrapper
                   cat > "$FLR_PRUNE_CRON" <<EOF
# Grin Floonet relay event retention — generated by 091_grin_floonet_relay.sh
$FLR_PRUNE_MIN $FLR_PRUNE_HOUR * * * root $FLR_PRUNE_WRAPPER
EOF
                   success "Daily prune enabled ($(printf '%02d:%02d' "$FLR_PRUNE_HOUR" "$FLR_PRUNE_MIN")) → $FLR_PRUNE_CRON"
               fi; sleep 1 ;;
            6) db=$(flr_db_path)
               if [[ -z "$db" ]]; then
                   warn "No database found."
               else
                   echo -e "  ${DIM}VACUUM rewrites the file — the relay may block briefly and you${RESET}"
                   echo -e "  ${DIM}need free space equal to the current database size.${RESET}"
                   echo -ne "  Run VACUUM now? [y/N]: "
                   read -r v || true
                   if [[ "${v,,}" == "y" ]]; then
                       info "Vacuuming (this can take a while)…"
                       if sqlite3 "$db" "PRAGMA busy_timeout=60000; VACUUM;" 2>/dev/null; then
                           success "Reclaimed — now $(du -h "$db" 2>/dev/null | cut -f1)."
                       else
                           error "VACUUM failed (database busy or not enough free disk)."
                       fi
                   fi
               fi; pause ;;
            0|"") return 0 ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}

# There is no flr_mixexit (Nym mixnet exit add-on).
#
# Upstream archived 2ro/floonet-mixexit and the Goblin stack moved its privacy
# transport from the Nym mixnet to Tor/arti, so the builder could only ever
# produce a dead binary — and its fallback branch cloned a repo that no longer
# receives commits. Do not re-add it against the archived repo; if a mixnet exit
# comes back it will be a different project with a different build.
#
# 08del_clean_all_grin_things.sh still removes /usr/local/bin/floonet-mixexit on
# purpose: a box that installed it before this date must still be cleanable.

flr_uninstall() {
    clear
    flr_load_conf
    echo -e "${BOLD}${RED}── Uninstall Floonet relay ──${RESET}\n"
    echo -e "  Removes: service, binary, nginx vhost, rate-limit zones, backup + prune cron."
    echo -e "  ${DIM}Backups in /opt/grin/backups are NEVER touched.${RESET}\n"
    echo -ne "  Type ${BOLD}REMOVE${RESET} to continue (anything else cancels): "
    local c; read -r c || true
    [[ "$c" == "REMOVE" ]] || { info "Cancelled."; pause; return 0; }

    systemctl stop "$FLR_SVC" 2>/dev/null || true
    systemctl disable "$FLR_SVC" 2>/dev/null || true
    rm -f "/etc/systemd/system/${FLR_SVC}.service" "/usr/lib/systemd/system/${FLR_SVC}.service"
    rm -rf "/etc/systemd/system/${FLR_SVC}.service.d"
    systemctl daemon-reload
    rm -f "$FLR_BIN"
    nginx_disable_site "$FLR_SITE_NAME" 2>/dev/null || true
    rm -f "/etc/nginx/sites-available/${FLR_SITE_NAME}"
    rm -f /etc/nginx/conf.d/script09-floonet.conf /etc/nginx/conf.d/script09-floonet-conn.conf
    rm -rf "${FLR_WWW:?}"
    nginx_test_reload "floonet uninstall" || true
    rm -f "$FLR_BAK_CRON" "$FLR_BAK_WRAPPER" "/etc/logrotate.d/${FLR_SITE_NAME}"
    rm -f "$FLR_PRUNE_CRON" "$FLR_PRUNE_WRAPPER"
    success "Service, binary, and nginx config removed."

    echo ""
    echo -ne "  Also DELETE relay data (${FLR_STATE}) and config (${FLR_ETC})? [Y/n]: "
    read -r c || true
    if [[ "${c,,}" != "n" ]]; then
        # Also clear the DynamicUser private dir so a from-scratch reinstall
        # never inherits a stale /var/lib/private/floonet-rs → symlink trap.
        rm -rf "${FLR_STATE:?}" "/var/lib/private/floonet-rs" "${FLR_ETC:?}"
        rm -f "$FLR_CONF"
        success "Data and config deleted."
    else
        info "Data and config kept — a reinstall will pick them up."
    fi
    echo -e "  ${DIM}Keeping the cert lets a reinstall reuse it (avoids Let's Encrypt rate limits).${RESET}"
    echo -ne "  Delete the Let's Encrypt certificate for ${FLR_DOMAIN:-'(no domain)'}? [y/N]: "
    read -r c || true
    if [[ "${c,,}" == "y" && -n "$FLR_DOMAIN" ]]; then
        nginx_delete_certbot_cert "$FLR_DOMAIN"
    fi
    echo -ne "  Delete the source/build dir (${FLR_SRC%/*})? [Y/n]: "
    read -r c || true
    if [[ "${c,,}" != "n" ]]; then
        rm -rf "${FLR_SRC:?}"
        rm -rf "${FLR_SRC%/*}"
    fi
    success "Uninstall complete."
    pause
}

# ══════════════════════════════════════════════════════════════════════════════
# BACKUP / RESTORE / SCHEDULE (shared engine — product "floonet")
# ══════════════════════════════════════════════════════════════════════════════
# Archive layout:
#   etc-floonet-rs/   config.toml + env (the relay's identity & settings)
#   state/            consistent SQLite snapshot(s)
#   toolkit/          grin_floonet.conf (deployer settings)

flr_backup_now() {
    gbe_require_key || return 1
    [[ -d "$FLR_ETC" ]] || { error "Nothing to back up — relay not installed."; return 1; }
    local stage tmp
    stage=$(mktemp -d /tmp/grin_floonet_bak_XXXXXX) || return 1
    mkdir -p "$stage/etc-floonet-rs" "$stage/state" "$stage/toolkit"
    cp -a "$FLR_ETC/." "$stage/etc-floonet-rs/" 2>/dev/null || true
    [[ -f "$FLR_CONF" ]] && cp -a "$FLR_CONF" "$stage/toolkit/"
    local db
    for db in "$FLR_STATE"/*.db; do
        [[ -f "$db" ]] || continue
        gbe_snapshot_db "$db" "$stage/state/$(basename "$db")"
    done
    tmp=$(mktemp /tmp/grin_floonet_bak_XXXXXX.tar.gz) || { rm -rf "$stage"; return 1; }
    tar -czf "$tmp" -C "$stage" . 2>/dev/null || true
    rm -rf "$stage"
    gbe_finalize_archive "floonet" "$tmp" || return 1
    gbe_prune_count "floonet" "$FLR_BAK_KEEP"
    return 0
}

flr_restore() {
    clear
    echo -e "${BOLD}${CYAN}── Floonet relay — restore from backup ──${RESET}\n"
    local archives=()
    while IFS= read -r f; do [[ -n "$f" ]] && archives+=("$f"); done \
        < <(ls -t "$GBE_BACKUP_DIR"/grin_floonet_backup_*.tar.gz.enc 2>/dev/null || true)
    if [[ ${#archives[@]} -eq 0 ]]; then
        warn "No floonet backups found in $GBE_BACKUP_DIR."; pause; return 0
    fi
    local i
    for i in "${!archives[@]}"; do
        echo -e "  ${GREEN}$((i+1))${RESET}) $(basename "${archives[$i]}")  ${DIM}($(du -sh "${archives[$i]}" 2>/dev/null | cut -f1))${RESET}"
    done
    echo -e "  ${DIM}0) Cancel${RESET}\n"
    echo -ne "${BOLD}Select archive: ${RESET}"
    local sel; read -r sel || true
    [[ "$sel" =~ ^[0-9]+$ && "$sel" -ge 1 && "$sel" -le ${#archives[@]} ]] || { info "Cancelled."; pause; return 0; }
    local archive="${archives[$((sel-1))]}" d
    d=$(gbe_parse_date "$archive") || { error "Unexpected archive name."; pause; return 0; }
    echo ""
    echo -e "  ${DIM}Password = your personal key + ${d} (typed by hand on restore).${RESET}"
    local key; read -rs -p "  Personal key: " key; echo ""
    [[ -n "$key" ]] || { info "Cancelled."; pause; return 0; }

    local tmp_tar stage
    tmp_tar=$(mktemp /tmp/grin_floonet_res_XXXXXX.tar.gz)
    if ! gbe_decrypt "$archive" "$tmp_tar" "${key}${d}"; then
        rm -f "$tmp_tar"; unset key
        error "Decryption failed — wrong key for this archive's date?"; pause; return 0
    fi
    unset key
    stage=$(mktemp -d /tmp/grin_floonet_res_XXXXXX)
    tar -xzf "$tmp_tar" -C "$stage" 2>/dev/null \
        || { rm -rf "$stage" "$tmp_tar"; error "Archive extraction failed."; pause; return 0; }
    rm -f "$tmp_tar"

    info "Stopping relay…"
    systemctl stop "$FLR_SVC" 2>/dev/null || true
    if [[ -d "$stage/etc-floonet-rs" ]]; then
        mkdir -p "$FLR_ETC"
        cp -a "$stage/etc-floonet-rs/." "$FLR_ETC/"
        chmod 600 "$FLR_CONFIG" 2>/dev/null || true
    fi
    if [[ -d "$stage/state" ]] && ls "$stage/state"/*.db >/dev/null 2>&1; then
        mkdir -p "$FLR_STATE"
        rm -f "$FLR_STATE"/*.db "$FLR_STATE"/*.db-wal "$FLR_STATE"/*.db-shm 2>/dev/null || true
        cp -a "$stage/state/." "$FLR_STATE/"
    fi
    [[ -f "$stage/toolkit/grin_floonet.conf" ]] && cp -a "$stage/toolkit/grin_floonet.conf" "$FLR_CONF"
    # Ownership: the StateDirectory fixes itself under DynamicUser, the config
    # does NOT — keep it readable by whichever unit flavour is installed.
    if id -u floonet >/dev/null 2>&1; then
        chown -R floonet:floonet "$FLR_STATE" 2>/dev/null || true
    fi
    if grep -qs "^User=floonet" /etc/systemd/system/${FLR_SVC}.service 2>/dev/null; then
        chown root:floonet "$FLR_CONFIG" 2>/dev/null || true
        chmod 640 "$FLR_CONFIG" 2>/dev/null || true
    elif systemctl cat "$FLR_SVC" 2>/dev/null | grep -qsE '^DynamicUser=(yes|true|1)'; then
        chmod 644 "$FLR_CONFIG" 2>/dev/null || true
    fi
    rm -rf "$stage"
    info "Starting relay…"
    systemctl start "$FLR_SVC" 2>/dev/null || true
    sleep 2
    if [[ "$(flr_svc_state)" == "active" ]]; then
        success "Restore complete — relay is running."
    else
        error "Relay not active after restore — check logs (menu 4)."
    fi
    echo -e "  ${DIM}nginx/SSL are not part of the archive — re-run setup option 2 if this is a new server.${RESET}"
    pause
}

# Self-contained unattended wrapper (cron never sources repo libs).
_flr_write_bak_wrapper() {
    flr_load_conf
    mkdir -p /opt/grin/logs
    cat > "$FLR_BAK_WRAPPER" <<WRAP
#!/bin/bash
# grin-floonet-backup — unattended daily backup (generated by 091_grin_floonet_relay.sh)
# Standard engine conventions: grin_floonet_backup_DDMMYYYY.tar.gz.enc,
# password = <personal key from ${GBE_CONF}> + DDMMYYYY.
set -u
BACKUP_DIR="${GBE_BACKUP_DIR}"
CONF="${GBE_CONF}"
LOG="${FLR_BAK_LOG}"
KEEP="${FLR_BAK_KEEP}"
TS=\$(date '+%F %T')
D=\$(date +%d%m%Y)
mkdir -p "\$BACKUP_DIR" "\$(dirname "\$LOG")"
KEY_B64=\$(sed -n "s/^GBE_PERSONAL_KEY_B64='\([^']*\)'.*/\1/p" "\$CONF" 2>/dev/null | head -1)
[[ -n "\$KEY_B64" ]] || { echo "[\$TS] ERROR: no personal key in \$CONF" >> "\$LOG"; exit 1; }
KEY=\$(printf '%s' "\$KEY_B64" | base64 -d 2>/dev/null)
[[ -n "\$KEY" ]] || { echo "[\$TS] ERROR: key decode failed" >> "\$LOG"; exit 1; }

STAGE=\$(mktemp -d /tmp/grin_floonet_cronbak_XXXXXX) || exit 1
mkdir -p "\$STAGE/etc-floonet-rs" "\$STAGE/state" "\$STAGE/toolkit"
cp -a ${FLR_ETC}/. "\$STAGE/etc-floonet-rs/" 2>/dev/null
[[ -f ${FLR_CONF} ]] && cp -a ${FLR_CONF} "\$STAGE/toolkit/"
for db in ${FLR_STATE}/*.db; do
    [[ -f "\$db" ]] || continue
    python3 -c 'import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()' \
        "\$db" "\$STAGE/state/\$(basename "\$db")" 2>/dev/null || cp -p "\$db" "\$STAGE/state/"
done

TMP=\$(mktemp /tmp/grin_floonet_cronbak_XXXXXX.tar.gz) || { rm -rf "\$STAGE"; exit 1; }
tar -czf "\$TMP" -C "\$STAGE" . 2>/dev/null
rm -rf "\$STAGE"
[[ -s "\$TMP" ]] || { rm -f "\$TMP"; echo "[\$TS] ERROR: empty archive (disk full?)" >> "\$LOG"; exit 1; }

ARCHIVE="\$BACKUP_DIR/grin_floonet_backup_\$D.tar.gz.enc"
PASS="\${KEY}\${D}"
if openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass fd:3 \
        -in "\$TMP" -out "\$ARCHIVE" 3<<<"\$PASS" 2>/dev/null; then
    chmod 600 "\$ARCHIVE"; chown root:root "\$ARCHIVE" 2>/dev/null || true
    SZ=\$(du -sh "\$ARCHIVE" 2>/dev/null | cut -f1 || echo "?")
    echo "[\$TS] backup created: \$(basename "\$ARCHIVE") (\$SZ)" >> "\$LOG"
else
    rm -f "\$TMP" "\$ARCHIVE"; echo "[\$TS] ERROR: openssl failed" >> "\$LOG"; exit 1
fi
rm -f "\$TMP"; unset PASS KEY

# Offsite push (scp) — silent no-op unless configured via the toolkit menus
if [[ -x "${GBP_BIN:-/usr/local/bin/grin-backup-push}" ]]; then
    "${GBP_BIN:-/usr/local/bin/grin-backup-push}" "\$ARCHIVE" \
        || echo "[\$TS] WARN: offsite push failed" >> "\$LOG"
fi

N=\$(ls -1 "\$BACKUP_DIR"/grin_floonet_backup_*.tar.gz.enc 2>/dev/null | wc -l)
if [[ "\$N" -gt "\$KEEP" ]]; then
    ls -t "\$BACKUP_DIR"/grin_floonet_backup_*.tar.gz.enc 2>/dev/null \
        | tail -n +\$((KEEP + 1)) | xargs rm -f 2>/dev/null || true
    echo "[\$TS] pruned (kept newest \$KEEP)" >> "\$LOG"
fi
WRAP
    chmod 750 "$FLR_BAK_WRAPPER"
}

flr_backup_schedule() {
    flr_load_conf
    if [[ -f "$FLR_BAK_CRON" ]]; then
        echo -e "  Daily backup: ${GREEN}enabled${RESET} ${DIM}($(printf '%02d:%02d' "$FLR_BAK_HOUR" "$FLR_BAK_MIN"), keep $FLR_BAK_KEEP · log: $FLR_BAK_LOG)${RESET}"
        echo -ne "  Disable it? [y/N]: "
        local c; read -r c || true
        if [[ "${c,,}" == "y" ]]; then
            rm -f "$FLR_BAK_CRON" "$FLR_BAK_WRAPPER"
            success "Daily backup disabled."
        fi
        return 0
    fi
    gbe_require_key || { info "Scheduling needs a personal key."; return 1; }
    # Regenerate the wrapper on every enable — settings changes land this way.
    _flr_write_bak_wrapper
    cat > "$FLR_BAK_CRON" <<EOF
# Grin Floonet relay daily backup — generated by 091_grin_floonet_relay.sh
$FLR_BAK_MIN $FLR_BAK_HOUR * * * root $FLR_BAK_WRAPPER
EOF
    success "Daily backup enabled ($(printf '%02d:%02d' "$FLR_BAK_HOUR" "$FLR_BAK_MIN"), keep $FLR_BAK_KEEP) → $FLR_BAK_CRON"
    return 0
}

flr_backup_menu() {
    local c
    while true; do
        clear
        flr_load_conf
        gbe_load_key
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Floonet relay — Backup & Restore${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        local key_state="${RED}not set${RESET}"; [[ -n "$GBE_PERSONAL_KEY" ]] && key_state="${GREEN}set${RESET}"
        local sched="${DIM}off${RESET}"; [[ -f "$FLR_BAK_CRON" ]] && sched="${GREEN}daily $(printf '%02d:%02d' "$FLR_BAK_HOUR" "$FLR_BAK_MIN")${RESET}"
        echo -e "  Personal key : $key_state ${DIM}(shared by all products · $GBE_CONF)${RESET}"
        echo -e "  Schedule     : $sched   Retention: keep ${BOLD}$FLR_BAK_KEEP${RESET}"
        echo -e "  ${DIM}Contents: config.toml + env + SQLite snapshot + deployer settings${RESET}"
        echo ""
        echo -e "  ${BOLD}Backups in $GBE_BACKUP_DIR:${RESET}"
        local any=0 f
        while IFS= read -r f; do
            [[ -n "$f" ]] || continue
            any=1
            echo -e "    $(basename "$f")  ${DIM}($(du -sh "$f" 2>/dev/null | cut -f1))${RESET}"
        done < <(ls -t "$GBE_BACKUP_DIR"/grin_floonet_backup_*.tar.gz.enc 2>/dev/null || true)
        [[ "$any" -eq 0 ]] && echo -e "    ${DIM}(none yet)${RESET}"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Backup now"
        echo -e "  ${GREEN}2${RESET}) Restore from a backup"
        echo -e "  ${GREEN}3${RESET}) Enable / disable daily schedule"
        echo -e "  ${GREEN}4${RESET}) Set / change personal key"
        echo -e "  ${GREEN}5${RESET}) Retention (currently keep $FLR_BAK_KEEP)"
        echo -e "  ${GREEN}6${RESET}) Offsite push setup (scp)"
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-6/0]: ${RESET}"
        read -r c || c=0
        case "$c" in
            "") continue ;;
            1) flr_backup_now || true; pause ;;
            2) flr_restore || true ;;
            3) flr_backup_schedule || true; pause ;;
            4) gbe_set_key || true; pause ;;
            5) echo -ne "  Keep how many archives [current $FLR_BAK_KEEP]: "
               local n; read -r n || true
               if [[ "$n" =~ ^[0-9]+$ && "$n" -ge 1 ]]; then
                   FLR_BAK_KEEP="$n"; flr_save_conf
                   # Live cron wrapper bakes the retention in — regenerate it.
                   [[ -f "$FLR_BAK_CRON" ]] && _flr_write_bak_wrapper
                   success "Retention set to $n."
               else
                   warn "Unchanged (enter a positive number)."
               fi
               pause ;;
            6) gbp_setup || true; pause ;;
            0) return 0 ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}
