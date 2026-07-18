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
FLR_MIXEXIT_REPO_URL="${FLR_MIXEXIT_REPO_URL:-https://github.com/2ro/floonet-mixexit}"
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
FLR_LANDING_NIPS="${FLR_LANDING_NIPS:-1,11,44}"  # NIP-11 fallback chips (live doc overrides)

# nginx zones (script-specific, script09- prefixed per CLAUDE.md rules)
FLR_REQ_ZONE="floonet_ws"
FLR_CONN_ZONE="floonet_conn"

# Backup (shared engine conventions: product "floonet")
FLR_BAK_WRAPPER="/usr/local/bin/grin-floonet-backup"
FLR_BAK_CRON="/etc/cron.d/grin-floonet-backup"
FLR_BAK_LOG="/opt/grin/logs/floonet_backup_cron.log"

# Deployer settings (persisted in FLR_CONF)
FLR_DOMAIN=""
FLR_EMAIL=""
FLR_BAK_KEEP=7
FLR_BAK_HOUR=3
FLR_BAK_MIN=25
FLR_INSTALLED_REV=""   # source rev the installed binary was built from

# ─── Deployer conf ───────────────────────────────────────────────────────────
flr_load_conf() {
    FLR_DOMAIN=""; FLR_EMAIL=""; FLR_BAK_KEEP=7; FLR_BAK_HOUR=3; FLR_BAK_MIN=25
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
# ./floonet-rs first — the "release archive layout"). No releases exist as of
# 2026-07-10; this future-proofs the deployer without blocking on it.
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
    html=$(cat <<'FLR_LANDING_HTML'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>@@NAME@@</title>
<meta name="description" content="@@DESC@@">
<meta name="color-scheme" content="dark">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cpath d='M16 4c-5 0-9 4-9 9v13l3-2 3 2 3-2 3 2 3-2 3 2V13c0-5-4-9-9-9z' fill='%23130d20' stroke='%23c3b3ff' stroke-width='1.4'/%3E%3Ccircle cx='12.5' cy='13' r='1.4' fill='%23c3b3ff'/%3E%3Ccircle cx='19.5' cy='13' r='1.4' fill='%23c3b3ff'/%3E%3C/svg%3E">
<style>
  :root{
    --void:#0a0712; --night:#130d20; --night2:#180f28; --card:#160e26;
    --veil:#251a3a; --veil2:#34254f;
    --grin:#ff9a4d; --grin-soft:#ffc38f; --grin-glow:rgba(255,154,77,.16);
    --ghost:#c3b3ff; --ghost-dim:rgba(195,179,255,.14); --moon:#dfe7ff;
    --text:#eae4f7; --dim:#a294c0; --faint:#6f6391;
    --serif:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Times New Roman",ui-serif,serif;
    --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    --mono:ui-monospace,"SF Mono","JetBrains Mono","Cascadia Code",Menlo,Consolas,monospace;
    --maxw:920px;
  }
  *{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  body{margin:0; background:var(--void); color:var(--text); font-family:var(--sans);
    line-height:1.65; -webkit-font-smoothing:antialiased; overflow-x:hidden;}
  a{color:var(--grin-soft); text-decoration:none} a:hover{color:var(--grin)}
  ::selection{background:var(--ghost);color:#0a0712}
  :focus-visible{outline:2px solid var(--ghost);outline-offset:3px;border-radius:5px}
  .wrap{max-width:var(--maxw);margin:0 auto;padding:0 24px}
  .eyebrow{font-family:var(--mono); font-size:.7rem; letter-spacing:.34em;
    text-transform:uppercase; color:var(--faint); margin:0;}
  h2,h3{font-family:var(--serif); font-weight:600; letter-spacing:-.01em}

  /* ── HERO ─────────────────────────────────────────── */
  .hero{position:relative; padding:92px 0 66px; overflow:hidden}
  #veil{position:absolute; inset:0; width:100%; height:100%; z-index:0}
  .hero::after{content:""; position:absolute; inset:0; z-index:1; pointer-events:none;
    background:radial-gradient(ellipse 75% 65% at 50% 36%, transparent 42%, var(--void) 100%);}
  .hero .wrap{position:relative; z-index:2}
  .materialize{opacity:0; filter:blur(10px); transform:translateY(10px);
    animation:appear 1.5s cubic-bezier(.2,.7,.2,1) forwards}
  .materialize.d1{animation-delay:.15s} .materialize.d2{animation-delay:.5s}
  .materialize.d3{animation-delay:.9s} .materialize.d4{animation-delay:1.25s}
  @keyframes appear{to{opacity:1; filter:blur(0); transform:none}}

  .badge{display:inline-flex; align-items:center; gap:9px; font-family:var(--mono);
    font-size:.68rem; letter-spacing:.22em; text-transform:uppercase; color:var(--dim);
    border:1px solid var(--veil2); border-radius:100px; padding:6px 15px;
    background:rgba(19,13,32,.55); backdrop-filter:blur(5px);}
  .wisp{width:8px;height:8px;border-radius:50%;background:var(--ghost);
    box-shadow:0 0 8px 1px var(--ghost); animation:breathe 3.2s ease-in-out infinite}
  @keyframes breathe{0%,100%{opacity:.45;transform:scale(.85)}50%{opacity:1;transform:scale(1.1)}}

  /* headline "torch reveal" — a light follows the cursor and SWAPS the visible
     title for the secret beneath it: the base title is masked OUT inside the
     torch, the secret is masked IN only inside the torch. Cursor away (default)
     → base title fully shown, secret hidden. */
  h1.reveal{font-family:var(--serif); font-weight:600; letter-spacing:-.02em;
    font-size:clamp(2.6rem,7.3vw,4.9rem); line-height:1.05; margin:.34em 0 .12em;
    display:grid; position:relative; isolation:isolate; cursor:crosshair;}
  .layer{grid-area:1/1; text-wrap:balance; z-index:1}
  .layer em{font-style:italic; color:var(--ghost);
    text-shadow:0 0 22px rgba(195,179,255,.5), 0 0 3px rgba(195,179,255,.3);}
  .layer.base{
    -webkit-mask:radial-gradient(190px circle at var(--mx,-999px) var(--my,-999px), transparent 0%, rgba(0,0,0,.4) 52%, #000 74%);
            mask:radial-gradient(190px circle at var(--mx,-999px) var(--my,-999px), transparent 0%, rgba(0,0,0,.4) 52%, #000 74%);}
  .layer.secret{color:var(--moon);
    text-shadow:0 0 26px rgba(223,231,255,.55), 0 0 4px rgba(223,231,255,.45);
    -webkit-mask:radial-gradient(190px circle at var(--mx,-999px) var(--my,-999px), #000 0%, rgba(0,0,0,.55) 52%, transparent 74%);
            mask:radial-gradient(190px circle at var(--mx,-999px) var(--my,-999px), #000 0%, rgba(0,0,0,.55) 52%, transparent 74%);}
  .layer.secret em{color:var(--moon)}
  .torch{position:absolute; z-index:0; width:340px; height:340px; border-radius:50%;
    transform:translate(-50%,-50%); pointer-events:none; opacity:0; transition:opacity .35s;
    background:radial-gradient(circle, rgba(195,179,255,.22), rgba(195,179,255,.05) 45%, transparent 68%);}
  .rhint{display:block; font-family:var(--mono); font-size:.64rem; letter-spacing:.18em;
    text-transform:uppercase; color:var(--faint); margin:.5em 0 0; transition:opacity .6s;}
  .incant{font-family:var(--serif); font-style:italic; font-size:clamp(1.05rem,2.6vw,1.38rem);
    color:var(--dim); margin:.35em 0 2.1em; max-width:52ch;}
  .incant b{color:var(--moon); font-weight:600; font-style:normal;
    font-family:var(--mono); font-size:.86em; letter-spacing:.02em;}

  .beacon{background:linear-gradient(180deg, var(--night2), var(--night));
    border:1px solid var(--veil2); border-radius:18px; padding:20px; max-width:600px;
    box-shadow:0 30px 70px -34px #000, 0 0 40px -18px rgba(195,179,255,.35),
      inset 0 1px 0 rgba(223,231,255,.05);}
  .beacon-label{display:flex;justify-content:space-between;align-items:center;
    font-family:var(--mono); font-size:.66rem; letter-spacing:.18em; text-transform:uppercase;
    color:var(--faint); margin-bottom:12px;}
  .beacon-label b{color:var(--ghost);font-weight:600}
  .connect{display:flex; gap:10px; align-items:stretch}
  .url{flex:1; min-width:0; display:flex; align-items:center; gap:10px; background:#0c0817;
    border:1px solid var(--veil2); border-radius:12px; padding:14px 16px; overflow-x:auto;}
  .url .proto{color:var(--faint); font-family:var(--mono)}
  .url code{font-family:var(--mono); font-size:clamp(.9rem,2.6vw,1.16rem); color:var(--grin);
    white-space:nowrap; font-weight:500;}
  .copy{flex:none; display:inline-flex;align-items:center;gap:8px; font-family:var(--mono);
    font-size:.8rem; font-weight:600; letter-spacing:.04em; color:#160a02; background:var(--grin);
    border:none; border-radius:12px; padding:0 20px; cursor:pointer;
    transition:transform .12s, background .2s, box-shadow .2s; box-shadow:0 0 0 rgba(255,154,77,0);}
  .copy:hover{background:var(--grin-soft); box-shadow:0 0 22px -4px var(--grin)}
  .copy:active{transform:scale(.96)} .copy.done{background:var(--ghost); color:#0a0712}
  .beacon-hint{font-family:var(--mono);font-size:.7rem;color:var(--faint);margin:13px 2px 0}

  /* ── GOBLIN WALLET GUIDE (recreated wallet screens) ─── */
  .guide{margin-top:34px}
  .guide-lead{color:var(--dim); font-size:.98rem; margin:0 0 20px; max-width:60ch}
  .guide-lead b{color:var(--text)}
  .shots{display:grid; grid-template-columns:1fr 1fr; gap:18px}
  figure.shot{margin:0}
  figure.shot figcaption{font-size:.86rem; color:var(--dim); margin-top:11px; padding-left:2px}
  figure.shot figcaption b{color:var(--ghost); font-weight:600}
  /* goblin app chrome — scoped so its yellow theme can't leak into the page */
  .gob{--g-bg:#0d0d0e; --g-panel:#181819; --g-row:#161617; --g-line:#262628;
    --g-text:#e9e9ec; --g-dim:#8b8b91; --g-yellow:#f6df1e; --g-green:#38d67a;
    display:flex; background:var(--g-bg); border:1px solid var(--veil2); border-radius:14px;
    overflow:hidden; height:100%; font-family:var(--sans); color:var(--g-text);
    box-shadow:0 24px 50px -32px #000;}
  .gob-side{flex:none; width:74px; padding:16px 0; border-right:1px solid var(--g-line);
    display:flex; flex-direction:column; gap:3px; align-items:stretch;}
  .gob-brand{display:flex; align-items:center; gap:6px; font-weight:700; font-size:.74rem;
    padding:0 12px 12px; color:var(--g-text)}
  .gob-brand svg{filter:drop-shadow(0 0 3px rgba(255,255,255,.15))}
  .gob-nav{display:flex; align-items:center; gap:8px; padding:7px 12px; font-size:.66rem;
    color:var(--g-dim)}
  .gob-nav.on{color:var(--g-text)} .gob-nav.on i{background:#222}
  .gob-nav i{width:6px;height:6px;border-radius:2px;background:#333;flex:none}
  .gob-main{flex:1; min-width:0; padding:16px 16px 18px}
  .gob-title{font-size:.98rem; font-weight:700; margin:0 0 12px; display:flex; align-items:center; gap:7px}
  .gob-title .bk{color:var(--g-dim)}
  .gob-lbl{font-size:.56rem; letter-spacing:.13em; text-transform:uppercase; color:var(--g-dim); margin:12px 2px 6px}
  .gob-lbl:first-child{margin-top:0}
  .gob-panel{background:var(--g-panel); border-radius:10px; overflow:hidden}
  .gob-row{display:flex; justify-content:space-between; align-items:center; gap:10px;
    padding:10px 12px; font-size:.76rem; border-bottom:1px solid var(--g-line);}
  .gob-row:last-child{border-bottom:none}
  .gob-row .v{color:var(--g-dim); font-size:.73rem; white-space:nowrap}
  .gob-row.hot{background:rgba(246,223,30,.09)}
  .gob-row.hot span:first-child{color:var(--g-yellow); font-weight:600}
  .gob-row.hot .v{color:var(--g-yellow)}
  .gob-row .mono{font-family:var(--mono); font-size:.72rem}
  .gob-row.fresh span:first-child{color:var(--grin)}
  .gob-input{background:var(--g-panel); border:1px solid #2f2f31; border-radius:9px;
    padding:10px 12px; font-family:var(--mono); font-size:.74rem; color:var(--g-text); margin-bottom:9px}
  .gob-input .cur{color:var(--grin)}
  .gob-input .care{color:var(--g-yellow); animation:blink 1.1s step-end infinite}
  @keyframes blink{50%{opacity:0}}
  .gob-btn{display:block; width:100%; text-align:center; border:none; border-radius:9px;
    padding:9px; font-size:.76rem; font-weight:700; margin-top:8px; font-family:var(--sans)}
  .gob-btn.ghost{background:var(--g-panel); color:var(--g-text); border:1px solid var(--g-line)}
  .gob-btn.save{background:var(--g-yellow); color:#111}
  .gob-check{color:var(--g-green)}

  /* ── SECTIONS ─────────────────────────────────────── */
  section{padding:60px 0; border-top:1px solid var(--veil)}
  .sec-head{margin-bottom:34px}
  .sec-head h2{font-size:clamp(1.6rem,4vw,2.3rem); margin:.3em 0 0; text-wrap:balance}
  .sec-head p{color:var(--dim); max-width:62ch; margin:.7em 0 0; font-size:1.02rem}
  .sec-head p.lore{font-family:var(--serif); font-style:italic; color:var(--ghost); opacity:.9}

  .pillars{display:grid; grid-template-columns:repeat(3,1fr); gap:16px}
  .card{background:var(--card); border:1px solid var(--veil); border-radius:16px;
    padding:26px 22px; transition:border-color .25s, transform .25s, box-shadow .25s;}
  .card:hover{border-color:var(--veil2); transform:translateY(-4px);
    box-shadow:0 20px 46px -30px #000, 0 0 30px -20px rgba(195,179,255,.6)}
  .card .ic{width:40px;height:40px;border-radius:11px; margin-bottom:17px; display:grid;
    place-items:center; color:var(--ghost); background:var(--ghost-dim);
    border:1px solid rgba(195,179,255,.22);}
  .card h3{font-size:1.24rem; margin:0 0 .45em}
  .card p{color:var(--dim); font-size:.93rem; margin:0} .card p+p{margin-top:.7em}

  .info{background:var(--night); border:1px solid var(--veil); border-radius:16px;
    overflow:hidden; font-family:var(--mono); font-size:.9rem;}
  .info-top{display:flex;justify-content:space-between;align-items:center;gap:12px; padding:14px 20px;
    border-bottom:1px solid var(--veil); background:#0c0817; color:var(--faint);
    letter-spacing:.14em; font-size:.68rem; text-transform:uppercase;}
  .info-top .src{display:inline-flex;align-items:center;gap:8px}
  .kv{display:grid; grid-template-columns:170px 1fr}
  .kv>div{padding:13px 20px; border-bottom:1px solid var(--veil); min-width:0}
  .kv .k{color:var(--faint); letter-spacing:.05em}
  .kv .v{color:var(--text); word-break:break-word}
  .kv .v .chip{display:inline-block; background:var(--ghost-dim); color:var(--ghost);
    border-radius:5px; padding:1px 8px; margin:2px 6px 2px 0; font-size:.82em}
  .kv>div:nth-last-child(-n+2){border-bottom:none}

  .links{display:grid; grid-template-columns:repeat(2,1fr); gap:12px}
  .link{display:flex; align-items:center; gap:14px; padding:18px 20px; border:1px solid var(--veil);
    border-radius:13px; background:var(--card); transition:border-color .2s, background .2s;}
  .link:hover{border-color:var(--ghost); background:var(--night2)}
  .link .dot{width:9px;height:9px;border-radius:50%;background:var(--ghost);flex:none;
    box-shadow:0 0 8px var(--ghost)}
  .link .t{color:var(--text); font-weight:600}
  .link .d{color:var(--faint); font-size:.82rem; font-family:var(--mono)}
  .link .arr{margin-left:auto; color:var(--faint); font-family:var(--mono)}
  .link:hover .arr{color:var(--ghost)}

  footer{border-top:1px solid var(--veil); padding:46px 0 62px; color:var(--dim)}
  footer .wrap{display:flex; flex-wrap:wrap; gap:16px 26px; align-items:center; justify-content:space-between}
  footer .fnav{display:flex; flex-wrap:wrap; gap:6px 20px; font-size:.9rem}
  footer .made{font-size:.86rem; display:inline-flex; align-items:center; gap:8px; color:var(--faint)}
  .disc{font-family:var(--serif); font-style:italic; font-size:.9rem; color:var(--faint); margin-top:22px}

  @media (max-width:760px){
    .pillars{grid-template-columns:1fr} .links{grid-template-columns:1fr}
    .shots{grid-template-columns:1fr}
    .connect{flex-direction:column} .copy{padding:13px 20px; justify-content:center}
    .kv{grid-template-columns:118px 1fr} footer .wrap{flex-direction:column; align-items:flex-start}
    .gob-side{width:56px} .gob-brand span, .gob-nav span{display:none}
  }
  @media (prefers-reduced-motion:reduce){
    .materialize{animation:none; opacity:1; filter:none; transform:none}
    .wisp,.gob-input .care{animation:none}
    .torch{transition:none}
  }
</style>
</head>
<body>
<div class="hero">
  <canvas id="veil" aria-hidden="true"></canvas>
  <div class="wrap">
    <span class="badge materialize d1"><span class="wisp"></span> Grin &middot; Nostr relay &middot; <span id="badge-net">@@NETLABEL@@</span></span>
    <h1 class="materialize d2 reveal" id="reveal">
      <span class="layer base">Money that keeps<br><em>a secret.</em></span>
      <span class="layer secret">No amounts.<br><em>No addresses.</em></span>
      <span class="torch" id="torch"></span>
    </h1>
    <span class="rhint materialize d2" id="revealHint">&#10022;&ensp;shine a torch across the words</span>
    <p class="incant materialize d2">
      A self-hosted relay for Grin — the currency with no addresses and no visible amounts.
      It carries encrypted slatepacks between wallets so people pay privately, by name.
      Connect over <b>wss://</b>.
    </p>
    <div class="beacon materialize d3">
      <div class="beacon-label"><span>Whisper your wallet toward</span> <b>&#10022;</b></div>
      <div class="connect">
        <div class="url"><span class="proto">wss://</span><code id="relay-host">@@RELAYHOST@@/</code></div>
        <button class="copy" id="copyBtn" type="button">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          <span id="copyTxt">Copy</span>
        </button>
      </div>
      <p class="beacon-hint">Add this to your goblin / Grin wallet's relay list &mdash; here's where:</p>
    </div>

    <div class="guide materialize d4">
      <p class="guide-lead">In <b>goblin</b>, relays live under <b>Settings &rarr; Nostr Relays</b>. Paste the URL
      above into <b>Add relay</b>, then <b>Save &amp; reconnect</b> &mdash; one reachable relay is enough to receive.</p>
      <div class="shots">
        <figure class="shot">
          <div class="gob">
            <aside class="gob-side">
              <div class="gob-brand">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="#e9e9ec"><path d="M12 3c-3.3 0-6 2.7-6 6v7l2-1.5L10 16l2-1.5L14 16l2-1.5L18 16V9c0-3.3-2.7-6-6-6z"/><circle cx="9.5" cy="9.5" r="1.1" fill="#0d0d0e"/><circle cx="14.5" cy="9.5" r="1.1" fill="#0d0d0e"/></svg>
                <span>goblin</span>
              </div>
              <div class="gob-nav"><i></i><span>Wallet</span></div>
              <div class="gob-nav"><i></i><span>Pay</span></div>
              <div class="gob-nav"><i></i><span>Activity</span></div>
              <div class="gob-nav"><i></i><span>Receive</span></div>
              <div class="gob-nav on"><i></i><span>Settings</span></div>
            </aside>
            <div class="gob-main">
              <div class="gob-title">Settings</div>
              <div class="gob-lbl">Identity</div>
              <div class="gob-panel">
                <div class="gob-row"><span>Username</span><span class="v">hellogrin &rsaquo;</span></div>
                <div class="gob-row"><span>Copy npub (public)</span><span class="v">&#10697;</span></div>
                <div class="gob-row hot"><span>Nostr Relays</span><span class="v">3 relays &rsaquo;</span></div>
                <div class="gob-row"><span>Trusted Sites</span><span class="v">0 &rsaquo;</span></div>
              </div>
            </div>
          </div>
          <figcaption>1 &middot; Open <b>Settings &rarr; Nostr Relays</b></figcaption>
        </figure>

        <figure class="shot">
          <div class="gob">
            <aside class="gob-side">
              <div class="gob-brand">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="#e9e9ec"><path d="M12 3c-3.3 0-6 2.7-6 6v7l2-1.5L10 16l2-1.5L14 16l2-1.5L18 16V9c0-3.3-2.7-6-6-6z"/><circle cx="9.5" cy="9.5" r="1.1" fill="#0d0d0e"/><circle cx="14.5" cy="9.5" r="1.1" fill="#0d0d0e"/></svg>
                <span>goblin</span>
              </div>
              <div class="gob-nav"><i></i><span>Wallet</span></div>
              <div class="gob-nav"><i></i><span>Pay</span></div>
              <div class="gob-nav"><i></i><span>Activity</span></div>
              <div class="gob-nav"><i></i><span>Receive</span></div>
              <div class="gob-nav on"><i></i><span>Settings</span></div>
            </aside>
            <div class="gob-main">
              <div class="gob-title"><span class="bk">&lsaquo;</span> Relays</div>
              <div class="gob-lbl">Your relays</div>
              <div class="gob-panel">
                <div class="gob-row"><span class="mono">wss://relay.floonet.dev</span><span class="v">&times;</span></div>
                <div class="gob-row fresh"><span class="mono">wss://@@RELAYHOST@@</span><span class="v">&times;</span></div>
              </div>
              <div class="gob-lbl">Add relay</div>
              <div class="gob-input"><span class="cur">wss://@@RELAYHOST@@</span><span class="care">&#9611;</span></div>
              <button class="gob-btn ghost">Add relay</button>
              <button class="gob-btn save">Save &amp; reconnect</button>
            </div>
          </div>
          <figcaption>2 &middot; Paste your relay URL, then <b>Save &amp; reconnect</b></figcaption>
        </figure>
      </div>
    </div>
  </div>
</div>

<section id="what">
  <div class="wrap">
    <div class="sec-head">
      <p class="eyebrow">The lore &amp; the plumbing</p>
      <h2>Named for a tongue-tying charm.</h2>
      <p class="lore">MimbleWimble's whitepaper was signed by a certain dark lord; its first
      builder wrote as the folklore keeper of an invisibility cloak. The cryptography lives up to the myth.</p>
      <p>Grin transactions are <em>interactive</em> &mdash; sender and receiver build each payment together by
      exchanging a slatepack. A relay lets that happen asynchronously and encrypted, so you never post an
      address, run a listener, or coordinate timing.</p>
    </div>
    <div class="pillars">
      <article class="card">
        <div class="ic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a15 15 0 0 0 0 18M12 3a15 15 0 0 1 0 18M3.5 9h17M3.5 15h17"/></svg></div>
        <h3>Grin</h3>
        <p>A MimbleWimble currency with no addresses and no amounts on-chain. Privacy isn't a setting
        you switch on &mdash; it's the ground it's built on.</p>
        <p>Fair-launched, no premine, a steady 1&nbsp;GRIN/second forever.</p>
      </article>
      <article class="card">
        <div class="ic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h16M4 12l4-4M4 12l4 4M20 6l-4 4-4-4"/><circle cx="12" cy="18" r="2.4"/></svg></div>
        <h3>Cloaked transport</h3>
        <p>Slatepacks travel as Nostr messages, sealed end-to-end with NIP-44. The relay stores and forwards
        ciphertext &mdash; it never sees an amount, a key, or a balance.</p>
        <p>Offline? The message waits until your wallet returns.</p>
      </article>
      <article class="card">
        <div class="ic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="M6.7 7.2 9.6 10M17.3 7.2 14.4 10M6.7 16.8 9.6 14M17.3 16.8 14.4 14"/></svg></div>
        <h3>floonet &amp; goblin</h3>
        <p><strong style="color:var(--text)">floonet</strong> is the Grin-native relay stack;
        <strong style="color:var(--text)">goblin</strong> is the wallet that speaks it &mdash; pay-by-name over
        Nostr, routed through a mixnet.</p>
        <p>Run your own relay and you rent no one's infrastructure.</p>
      </article>
    </div>
  </div>
</section>

<section id="info">
  <div class="wrap">
    <div class="sec-head">
      <p class="eyebrow">Relay information</p>
      <h2>What this relay reveals.</h2>
      <p>Served live as a NIP-11 document &mdash; the little it's willing to say about itself.
      Wallets read it before connecting.</p>
    </div>
    <div class="info">
      <div class="info-top">
        <span>document &middot; nostr+json</span>
        <span class="src"><span class="wisp"></span> <span id="nip11-src">live</span></span>
      </div>
      <div class="kv">
        <div class="k">name</div><div class="v" id="n-name">@@NAME@@</div>
        <div class="k">description</div><div class="v" id="n-desc">@@DESC@@</div>
        <div class="k">software</div><div class="v" id="n-soft">@@SOFTWARE@@</div>
        <div class="k">supported nips</div><div class="v" id="n-nips">@@NIPS@@</div>
        <div class="k">endpoint</div><div class="v" id="n-url">@@RELAYURL@@</div>
      </div>
    </div>
  </div>
</section>

<section id="learn">
  <div class="wrap">
    <div class="sec-head"><p class="eyebrow">Go deeper</p><h2>Learn about Grin &amp; floonet.</h2></div>
    <div class="links">
      <a class="link" href="https://grin.mw" target="_blank" rel="noopener"><span class="dot"></span><span><span class="t">grin.mw</span><br><span class="d">The Grin project home</span></span><span class="arr">&#8599;</span></a>
      <a class="link" href="https://forum.grin.mw" target="_blank" rel="noopener"><span class="dot"></span><span><span class="t">forum.grin.mw</span><br><span class="d">Community &amp; support</span></span><span class="arr">&#8599;</span></a>
      <a class="link" href="https://docs.floonet.dev" target="_blank" rel="noopener"><span class="dot"></span><span><span class="t">docs.floonet.dev</span><br><span class="d">Relay stack documentation</span></span><span class="arr">&#8599;</span></a>
      <a class="link" href="https://docs.goblin.st" target="_blank" rel="noopener"><span class="dot"></span><span><span class="t">docs.goblin.st</span><br><span class="d">The goblin P2P wallet</span></span><span class="arr">&#8599;</span></a>
    </div>
  </div>
</section>

<footer>
  <div class="wrap">
    <span class="made">Made with &#10084;&#65039; from Saigon
      <svg viewBox="0 0 27 18" width="21" height="14" role="img" aria-label="Yellow flag with three red stripes" style="vertical-align:-2px;border-radius:2px"><rect width="27" height="18" fill="#FFCD00"/><rect y="4" width="27" height="2" fill="#DA251D"/><rect y="8" width="27" height="2" fill="#DA251D"/><rect y="12" width="27" height="2" fill="#DA251D"/></svg>
    </span>
    <nav class="fnav">
      <a href="https://grin.mw" target="_blank" rel="noopener">grin.mw</a>
      <a href="https://docs.floonet.dev" target="_blank" rel="noopener">floonet</a>
      <a href="https://docs.goblin.st" target="_blank" rel="noopener">goblin</a>
      <a href="https://github.com/noobvie/Grin-Node-Toolkit" target="_blank" rel="noopener">GitHub</a>
    </nav>
  </div>
  <div class="wrap"><p class="disc">This relay carries only encrypted ciphertext. It cannot read your messages, your keys, or your balance.</p></div>
</footer>

<script>
(function(){
  "use strict";
  var host = location.host || "@@RELAYHOST@@";
  var fullUrl = "wss://" + host + "/";
  var hostEl = document.getElementById("relay-host");
  if (hostEl) hostEl.textContent = host + "/";

  var btn = document.getElementById("copyBtn"), txt = document.getElementById("copyTxt");
  btn && btn.addEventListener("click", function(){
    var done = function(){ btn.classList.add("done"); txt.textContent = "Copied";
      setTimeout(function(){ btn.classList.remove("done"); txt.textContent="Copy"; },1600); };
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(fullUrl).then(done).catch(fallback);
    } else { fallback(); }
    function fallback(){ var t=document.createElement("textarea"); t.value=fullUrl;
      document.body.appendChild(t); t.select(); try{document.execCommand("copy");}catch(e){}
      document.body.removeChild(t); done(); }
  });

  // Headline torch reveal — a light follows the cursor and uncovers the secret
  // phrase beneath the title. On load it sweeps once to teach the interaction;
  // touch devices loop the sweep (no cursor to follow).
  (function(){
    var el = document.getElementById('reveal'); if(!el) return;
    var torch = document.getElementById('torch'), hint = document.getElementById('revealHint');
    var touch = window.matchMedia && matchMedia('(hover:none)').matches;
    var busy = false, used = false;
    function put(x,y){ el.style.setProperty('--mx', x+'px'); el.style.setProperty('--my', y+'px');
      if(torch){ torch.style.left=x+'px'; torch.style.top=y+'px'; torch.style.opacity=1; } }
    function off(){ el.style.setProperty('--mx','-999px'); el.style.setProperty('--my','-999px');
      if(torch) torch.style.opacity=0; }
    function hideHint(){ if(!used){ used=true; if(hint) hint.style.opacity=0; } }
    function sweep(done){ busy=true; var r=el.getBoundingClientRect(), y=r.height*0.52, t=0;
      (function step(){ t += 0.017; put(t*r.width, y);
        if(t<1){ requestAnimationFrame(step); } else { busy=false; if(!touch) off(); if(done) done(); } })(); }
    if(!touch){
      el.addEventListener('pointermove', function(e){ if(busy) return; hideHint();
        var r=el.getBoundingClientRect(); put(e.clientX-r.left, e.clientY-r.top); });
      el.addEventListener('pointerleave', function(){ if(!busy) off(); });
      setTimeout(function(){ sweep(); }, 2300);          // one teaching sweep after materialize
    } else {
      hideHint();
      (function loop(){ sweep(function(){ setTimeout(loop, 1500); }); })();
    }
  })();

  // NIP-11: fetch live from this origin; fall back to templated defaults.
  (function(){
    var src = document.getElementById("nip11-src");
    if (!window.fetch) { if(src) src.textContent="static"; return; }
    fetch("/", { headers:{ "Accept":"application/nostr+json" }, cache:"no-store" })
      .then(function(r){ var ct=r.headers.get("content-type")||"";
        if(ct.indexOf("nostr+json")<0 && ct.indexOf("json")<0) throw 0; return r.json(); })
      .then(function(d){
        if(!d || typeof d!=="object") throw 0;
        set("n-name", d.name); set("n-desc", d.description);
        set("n-soft", d.software && String(d.software).replace(/^.*\//,""));
        set("n-url", fullUrl);
        if(Array.isArray(d.supported_nips)){
          var box=document.getElementById("n-nips");
          if(box){ box.innerHTML=""; d.supported_nips.forEach(function(nn){
            var s=document.createElement("span"); s.className="chip"; s.textContent=nn; box.appendChild(s); }); }
        }
        if(src) src.textContent="live";
      })
      .catch(function(){ if(src) src.textContent="static preview"; set("n-url", fullUrl); });
    function set(id,val){ if(val==null||val==="") return; var el=document.getElementById(id); if(el) el.textContent=val; }
  })();

  // Ambient cloak-veil: drifting aurora blobs + rising spectral motes.
  (function(){
    var cv=document.getElementById("veil"); if(!cv||!cv.getContext) return;
    var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion:reduce)").matches;
    var ctx=cv.getContext("2d"), W=0,H=0, DPR=Math.min(window.devicePixelRatio||1,2);
    var blobs=[], motes=[];
    function resize(){ var r=cv.getBoundingClientRect(); W=r.width;H=r.height;
      cv.width=W*DPR; cv.height=H*DPR; ctx.setTransform(DPR,0,0,DPR,0,0); }
    function init(){
      blobs=[
        {x:.28,y:.32,r:.42,c:"195,179,255",a:.16,px:0.00013,py:0.00009,t:Math.random()*9},
        {x:.72,y:.28,r:.38,c:"255,154,77",a:.10,px:0.00010,py:0.00012,t:Math.random()*9},
        {x:.5,y:.58,r:.5,c:"223,231,255",a:.07,px:0.00008,py:0.00007,t:Math.random()*9}
      ];
      motes=[]; for(var i=0;i<24;i++) motes.push(mote(true));
    }
    function mote(seed){ return { x:Math.random()*W, y:seed?Math.random()*H:H+8,
      r:0.6+Math.random()*1.6, s:0.15+Math.random()*0.5, a:0.15+Math.random()*0.5, drift:(Math.random()-.5)*0.25 }; }
    function frame(){
      ctx.clearRect(0,0,W,H);
      for(var i=0;i<blobs.length;i++){ var b=blobs[i]; b.t+=1;
        var cx=(b.x+Math.sin(b.t*b.px)*0.06)*W, cy=(b.y+Math.cos(b.t*b.py)*0.06)*H, rr=b.r*Math.max(W,H);
        var g=ctx.createRadialGradient(cx,cy,0,cx,cy,rr);
        g.addColorStop(0,"rgba("+b.c+","+b.a+")"); g.addColorStop(1,"rgba("+b.c+",0)");
        ctx.fillStyle=g; ctx.fillRect(0,0,W,H); }
      for(var j=0;j<motes.length;j++){ var m=motes[j]; m.y-=m.s; m.x+=m.drift;
        if(m.y<-8){ motes[j]=mote(false); continue; }
        ctx.beginPath(); ctx.arc(m.x,m.y,m.r,0,Math.PI*2);
        ctx.fillStyle="rgba(223,231,255,"+m.a+")"; ctx.fill(); }
      raf=requestAnimationFrame(frame);
    }
    var raf; resize(); init(); window.addEventListener("resize", function(){ resize(); init(); });
    if(reduce){
      for(var i=0;i<blobs.length;i++){ var b=blobs[i], cx=b.x*W, cy=b.y*H, rr=b.r*Math.max(W,H);
        var g=ctx.createRadialGradient(cx,cy,0,cx,cy,rr);
        g.addColorStop(0,"rgba("+b.c+","+b.a+")"); g.addColorStop(1,"rgba("+b.c+",0)");
        ctx.fillStyle=g; ctx.fillRect(0,0,W,H); }
    } else { frame(); }
  })();
})();
</script>
</body>
</html>
FLR_LANDING_HTML
)
    # Render with Python: it HTML-escapes each value and does literal placeholder
    # replacement. Bash ${var//old/new} is deliberately NOT used here — bash 5.2
    # treats & and \ in the replacement string specially (sed-like), which would
    # silently corrupt any value containing them; 5.1 does not. Python is immune.
    if ! FLR_TMPL="$html" FLR_NIP11="$live_nip11" python3 - \
            "$name" "$desc" "$software" "$relay_url" "$relayhost" \
            "$FLR_LANDING_NIPS" "$netlabel" \
            > "$FLR_WWW/index.html" <<'PYEOF'
import os, sys, json, html as H
tmpl = os.environ.get("FLR_TMPL", "")
a = (sys.argv[1:8] + [""] * 7)[:7]
name, desc, software, relay_url, relayhost, nips_csv, netlabel = a
esc = lambda s: H.escape(str(s) if s is not None else "", quote=True)

# Prefer the relay's OWN live NIP-11 doc — it lists the ACTUALLY activated NIPs
# (and the real software string). Fall back to the configured CSV when the relay
# wasn't reachable at write time (e.g. first deploy, before service start).
nips = [n.strip() for n in nips_csv.split(",") if n.strip()]
try:
    doc = json.loads(os.environ.get("FLR_NIP11", "") or "{}")
    if isinstance(doc.get("supported_nips"), list) and doc["supported_nips"]:
        nips = [str(n) for n in doc["supported_nips"]]
    if doc.get("software"):
        software = str(doc["software"]).rsplit("/", 1)[-1]
except Exception:
    pass

chips = "".join('<span class="chip">%s</span>' % esc(n) for n in nips)
repl = {
    "@@NAME@@": esc(name), "@@DESC@@": esc(desc),
    "@@SOFTWARE@@": esc(software), "@@RELAYURL@@": esc(relay_url),
    "@@RELAYHOST@@": esc(relayhost), "@@NIPS@@": chips, "@@NETLABEL@@": esc(netlabel),
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
        echo -e "  Pubkey whitelist (writers)          : ${DIM}$(flr_toml_get authorization pubkey_whitelist || echo '(open)')${RESET}"
        echo -e "  Public note authors                 : ${DIM}$(flr_toml_get authorization public_note_authors || echo '(open)')${RESET}"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Toggle NIP-42 auth"
        echo -e "  ${GREEN}2${RESET}) Toggle NIP-42 for DMs"
        echo -e "  ${GREEN}3${RESET}) Set pubkey whitelist (hex pubkeys)"
        echo -e "  ${GREEN}4${RESET}) Set public note authors (hex pubkeys)"
        echo -e "  ${DIM}0) Back${RESET}\n"
        echo -ne "${BOLD}Select: ${RESET}"
        local c; read -r c || true
        case "$c" in
            1) _flr_toggle_bool authorization nip42_auth "NIP-42 auth" && _flr_offer_restart ;;
            2) _flr_toggle_bool authorization nip42_dms "NIP-42 for DMs" && _flr_offer_restart ;;
            3) _flr_set_pubkey_array authorization pubkey_whitelist "Allowed writer pubkeys" && _flr_offer_restart ;;
            4) _flr_set_pubkey_array authorization public_note_authors "Public note author pubkeys" && _flr_offer_restart ;;
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

flr_mixexit() {
    clear
    echo -e "${BOLD}${CYAN}── Nym mixnet exit (optional add-on) ──${RESET}\n"
    echo -e "  ${DIM}The mixnet exit is a SEPARATE optional binary (floonet-mixexit) that${RESET}"
    echo -e "  ${DIM}upstream's installer co-installs when it sits next to the relay binary.${RESET}"
    echo -e "  ${DIM}It routes relay traffic through the Nym mixnet for stronger privacy.${RESET}\n"
    # 1) Already in the relay source tree (workspace member)?
    local mix_dir=""
    mix_dir=$(find "$FLR_SRC" -maxdepth 2 -type d -iname '*mixexit*' 2>/dev/null | head -n1 || true)
    local mix_src=""
    if [[ -n "$mix_dir" ]]; then
        mix_src="$FLR_SRC"
    elif git ls-remote --exit-code "$FLR_MIXEXIT_REPO_URL" >/dev/null 2>&1; then
        echo -ne "  Found upstream repo ${FLR_MIXEXIT_REPO_URL} — clone and build it? [y/N]: "
        local c; read -r c || true
        [[ "${c,,}" == "y" ]] || { info "Cancelled."; pause; return 0; }
        mix_src="/opt/grin/floonet/mixexit-src"
        if [[ -d "$mix_src/.git" ]]; then
            git -C "$mix_src" pull --quiet 2>/dev/null || true
        else
            git clone --depth 1 "$FLR_MIXEXIT_REPO_URL" "$mix_src" \
                || { error "Clone failed."; pause; return 0; }
        fi
    else
        warn "floonet-mixexit source not found (not in the relay tree, no separate repo reachable)."
        echo -e "  ${DIM}Check https://docs.floonet.dev for current mixnet-exit instructions.${RESET}"
        pause; return 0
    fi
    flr_ensure_rust || { pause; return 0; }
    _flr_ensure_build_memory
    info "Building floonet-mixexit… (a failed named-bin attempt falls back to a full build)"
    if ! (cd "$mix_src" && cargo build --release --bin floonet-mixexit) \
        && ! (cd "$mix_src" && cargo build --release); then
        _flr_release_build_memory
        error "mixexit build failed."; pause; return 0
    fi
    _flr_release_build_memory
    local built
    built=$(find "$mix_src/target/release" -maxdepth 1 -type f -name '*mixexit*' -perm -u+x 2>/dev/null | head -n1 || true)
    [[ -n "$built" ]] || { error "Build finished but no mixexit binary found."; pause; return 0; }
    # Place it where upstream install.sh co-installs from, then re-run it.
    cp "$built" "$FLR_SRC/$(basename "$built")"
    if [[ -f "$FLR_SRC/deploy/install.sh" ]]; then
        (cd "$FLR_SRC" && bash deploy/install.sh) \
            && success "Upstream installer co-installed the mixnet exit." \
            || warn "install.sh failed — binary left at $FLR_SRC/$(basename "$built")."
    else
        install -m 755 "$built" "/usr/local/bin/$(basename "$built")"
        success "Installed → /usr/local/bin/$(basename "$built") (configure per docs.floonet.dev)."
    fi
    pause
}

flr_uninstall() {
    clear
    flr_load_conf
    echo -e "${BOLD}${RED}── Uninstall Floonet relay ──${RESET}\n"
    echo -e "  Removes: service, binary, nginx vhost, rate-limit zones, backup cron."
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
