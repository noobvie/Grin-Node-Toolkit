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
flr_toml_str() { printf '"%s"' "${1//\"/\\\"}"; }

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

# Fallback unit — only used when upstream deploy/install.sh is absent/broken.
# Stable `floonet` user instead of DynamicUser: the 0600 config must stay
# readable by the service without loosening it to world-readable.
_flr_write_fallback_unit() {
    id -u floonet >/dev/null 2>&1 || useradd --system --home-dir "$FLR_STATE" \
        --shell /usr/sbin/nologin floonet 2>/dev/null \
        || useradd --system --home-dir "$FLR_STATE" --shell /sbin/nologin floonet
    mkdir -p "$FLR_STATE"
    chown -R floonet:floonet "$FLR_STATE"
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
    mkdir -p "$FLR_STATE"
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

flr_nginx_setup() {  # <domain> <email>
    local domain="$1" email="$2" port; port=$(flr_port)
    # Zones first (script-specific, script09- prefixed conf.d files).
    nginx_ensure_rate_limit_zone "$FLR_REQ_ZONE" "60r/m" "10m" "script09-floonet"
    nginx_ensure_conn_limit_zone "$FLR_CONN_ZONE" "10m" "script09-floonet-conn"
    nrd_deploy_wss_vhost "$FLR_SITE_NAME" "$domain" "$email" "$port" \
        "$FLR_REQ_ZONE" "$FLR_CONN_ZONE" || return 1
    nrd_firewall_open_web
    return 0
}

flr_start_verify() {
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
               flr_toml_set name_authority enabled true
               flr_toml_set name_authority domain "$(flr_toml_str "$FLR_DOMAIN")"
               flr_toml_set name_authority base_url "$(flr_toml_str "https://${FLR_DOMAIN}")"
               success "Name authority enabled for @${FLR_DOMAIN}."
               _flr_offer_restart ;;
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
                   flr_toml_set goblinpay pay_mode "$(flr_toml_str "$v")" && _flr_offer_restart
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
    nginx_test_reload "floonet uninstall" || true
    rm -f "$FLR_BAK_CRON" "$FLR_BAK_WRAPPER" "/etc/logrotate.d/${FLR_SITE_NAME}"
    success "Service, binary, and nginx config removed."

    echo ""
    echo -ne "  Also DELETE relay data (${FLR_STATE}) and config (${FLR_ETC})? [Y/n]: "
    read -r c || true
    if [[ "${c,,}" != "n" ]]; then
        rm -rf "${FLR_STATE:?}" "${FLR_ETC:?}"
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
