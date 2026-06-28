# shellcheck shell=bash
# ─── Shared node-secret resolution + self-heal ────────────────────────────────
# Sourced library (no shebang — see CLAUDE.md). Used by every toolkit product
# that consumes the Grin node's api/foreign secrets.
#
# WHY THIS EXISTS
# A Grin node rebuild changes BOTH the node directory (mainnet-prune ↔
# mainnet-full) and regenerates the api/foreign secrets. Every consumer that
# froze a secret PATH or VALUE at setup time then breaks silently with HTTP 401
# until someone re-runs that product's setup:
#   • Script 06 collector  — GRIN_*_SECRET_PATH in config.env          (path)
#   • grin-wallet products — node_api_secret_path in grin-wallet.toml  (path)
#   • GrinScan 06b         — secret files COPIED into its data dir     (value)
#   • Script 04 node API   — foreign secret baked into an nginx header (value)
#
# This lib provides ONE canonical, running-node-aware resolver plus idempotent
# "apply" helpers, and a `grin_secrets_sync_all` that re-applies to every
# consumer detected on disk. `grin_install_secret_sync` installs it as a
# systemd timer so the re-sync happens automatically after any future rebuild —
# no per-product setup re-run required.
#
# Guarding note: callers run under `set -euo pipefail`. The "apply" helpers
# return 1 to signal "no change", so callers MUST guard bare invocations with
# `|| true`. The sync wrappers below already do this internally.

GNS_INSTANCES_CONF="${GNS_INSTANCES_CONF:-/opt/grin/conf/grin_instances_location.conf}"
GNS_LIB_INSTALL_PATH="${GNS_LIB_INSTALL_PATH:-/opt/grin/lib/grin_node_secrets.sh}"
GNS_SYNC_BIN="${GNS_SYNC_BIN:-/usr/local/bin/grin-secret-sync}"

# Read one variable from the instances conf without polluting the caller's env.
_gns_conf_var() {
    [[ -f "$GNS_INSTANCES_CONF" ]] || return 0
    ( set +u; source "$GNS_INSTANCES_CONF" 2>/dev/null || true; printf '%s' "${!1:-}" )
}

# ─── Canonical resolver ───────────────────────────────────────────────────────
# grin_live_node_dir <mainnet|testnet> → echoes the node dir actually serving the
# network. Preference: active toolkit tmux session (the running node) → instances
# conf registry → standard toolkit path. Mainnet prefers the full archive when it
# is the running/registered node, else the pruned node (mirrors detect_node()).
grin_live_node_dir() {
    local net="$1" dir=""
    if [[ "$net" == "testnet" ]]; then
        tmux has-session -t grin_pruned_testnet 2>/dev/null && dir=/opt/grin/node/testnet-prune
        [[ -z "$dir" ]] && dir=$(_gns_conf_var PRUNETEST_GRIN_DIR)
        [[ -n "$dir" && -d "$dir" ]] || dir=/opt/grin/node/testnet-prune
    else
        if   tmux has-session -t grin_full_mainnet   2>/dev/null; then dir=/opt/grin/node/mainnet-full
        elif tmux has-session -t grin_pruned_mainnet 2>/dev/null; then dir=/opt/grin/node/mainnet-prune
        fi
        if [[ -z "$dir" ]]; then
            dir=$(_gns_conf_var FULLMAIN_GRIN_DIR)
            [[ -n "$dir" && -d "$dir" ]] || dir=$(_gns_conf_var PRUNEMAIN_GRIN_DIR)
        fi
        if [[ -z "$dir" || ! -d "$dir" ]]; then
            [[ -d /opt/grin/node/mainnet-full ]] && dir=/opt/grin/node/mainnet-full || dir=/opt/grin/node/mainnet-prune
        fi
    fi
    [[ -n "$dir" && -d "$dir" ]] || return 1
    printf '%s\n' "$dir"
}

# grin_node_secret_path <net> <foreign|owner> → absolute secret path resolved from
# the live node's grin-server.toml (~ expanded to /opt/grin), with the in-dir
# default as fallback. Returns 1 if no live node dir.
grin_node_secret_path() {
    local net="$1" which="$2" dir field default raw
    dir=$(grin_live_node_dir "$net") || return 1
    if [[ "$which" == "owner" ]]; then
        field="api_secret_path";         default="$dir/.api_secret"
    else
        field="foreign_api_secret_path"; default="$dir/.foreign_api_secret"
    fi
    raw=$(grep -E "^[[:space:]]*${field}[[:space:]]*=" "$dir/grin-server.toml" 2>/dev/null \
          | head -1 | sed 's/.*=[[:space:]]*//' | tr -d '"' | xargs || true)
    [[ -z "$raw" ]] && { printf '%s\n' "$default"; return 0; }
    raw="${raw/#\~//opt/grin}"
    [[ -f "$raw" ]] && printf '%s\n' "$raw" || printf '%s\n' "$default"
}

# ─── Idempotent appliers (return 0 = changed, 1 = no change / skipped) ─────────
# grin_env_set <file> <KEY> <value> — rewrite KEY=value in a shell env file.
grin_env_set() {
    local file="$1" key="$2" val="$3" cur
    [[ -f "$file" && -n "$val" ]] || return 1
    cur=$(grep -E "^${key}=" "$file" 2>/dev/null | head -1 | cut -d= -f2-)
    [[ "$cur" == "$val" ]] && return 1
    if grep -qE "^${key}=" "$file"; then
        sed -i "s#^${key}=.*#${key}=${val}#" "$file"
    else
        printf '%s=%s\n' "$key" "$val" >> "$file"
    fi
    return 0
}

# grin_toml_set_key <file> <key> <quoted_value> — rewrite `key = quoted_value`
# (uncommenting if needed). Pass the value WITH quotes, e.g. "\"$path\"".
grin_toml_set_key() {
    local file="$1" key="$2" val="$3" cur
    [[ -f "$file" ]] || return 1
    cur=$(grep -E "^[#[:space:]]*${key}[[:space:]]*=" "$file" 2>/dev/null \
          | head -1 | sed -E 's/^[#[:space:]]*[^=]+=[[:space:]]*//')
    [[ "$cur" == "$val" ]] && return 1
    if grep -qE "^[#[:space:]]*${key}[[:space:]]*=" "$file"; then
        sed -i -E "s#^[#[:space:]]*${key}[[:space:]]*=.*#${key} = ${val}#" "$file"
    else
        printf '%s = %s\n' "$key" "$val" >> "$file"
    fi
    return 0
}

# ─── Per-consumer sync ────────────────────────────────────────────────────────
# Each is a no-op when its product is not installed, and only writes when the
# resolved secret actually differs (idempotent → quiet on a healthy box).

# Script 06 collector — repoint the three secret PATH keys in config.env.
grin_sync_collector() {
    local cfg="/opt/grin/grin-stats/config.env" p
    [[ -f "$cfg" ]] || return 0
    p=$(grin_node_secret_path mainnet foreign 2>/dev/null || true)
    [[ -n "$p" ]] && { grin_env_set "$cfg" GRIN_FOREIGN_SECRET_PATH "$p" || true; }
    p=$(grin_node_secret_path mainnet owner 2>/dev/null || true)
    [[ -n "$p" ]] && { grin_env_set "$cfg" GRIN_API_SECRET_PATH "$p" || true; }
    if [[ -d /opt/grin/node/testnet-prune ]]; then
        p=$(grin_node_secret_path testnet owner 2>/dev/null || true)
        [[ -n "$p" ]] && { grin_env_set "$cfg" GRIN_TESTNET_SECRET_PATH "$p" || true; }
    fi
    return 0
}

_gns_copy_if_changed() {
    local src="$1" dst="$2"
    [[ -f "$src" ]] || return 1
    [[ -f "$dst" ]] && cmp -s "$src" "$dst" && return 1
    cp "$src" "$dst" 2>/dev/null || return 1
    chown www-data:www-data "$dst" 2>/dev/null || true
    chmod 600 "$dst" 2>/dev/null || true
    return 0
}

# GrinScan 06b — re-copy the secret VALUES into its data dir; restart on change.
grin_grinscan_sync() {
    local base="/opt/grin/grinscan" net ns dir changed
    [[ -d "$base" ]] || return 0
    for net in mainnet testnet; do
        ns=$( [[ "$net" == testnet ]] && echo test || echo main )
        [[ -d "$base/$ns" ]] || continue
        dir=$(grin_live_node_dir "$net" 2>/dev/null || true)
        [[ -n "$dir" ]] || continue
        changed=0
        _gns_copy_if_changed "$dir/.foreign_api_secret" "$base/$ns/.foreign_api_secret" && changed=1 || true
        _gns_copy_if_changed "$dir/.api_secret"         "$base/$ns/.api_secret"         && changed=1 || true
        [[ "$changed" == 1 ]] && { systemctl restart "grinscan-$ns" 2>/dev/null || true; }
    done
    return 0
}

# grin-wallet products — repoint node_api_secret_path to the live node's foreign
# secret. Only touches wallets pointed at a LOCAL node. Does NOT restart the
# listener (the patch takes effect on the wallet's next start — auto-restarting a
# live listener could interrupt an in-flight send).
grin_sync_wallets() {
    local toml net secret addr
    while IFS= read -r toml; do
        [[ -f "$toml" ]] || continue
        # Skip wallets that talk to a remote node — we must not hand them a local secret.
        addr=$(grep -E '^[[:space:]]*node_api_http_addr[[:space:]]*=' "$toml" 2>/dev/null | head -1)
        [[ -n "$addr" && "$addr" != *127.0.0.1* && "$addr" != *localhost* ]] && continue
        # Network: chain_type is authoritative; the testnet node port (1341x) in
        # node_api_http_addr is a secondary testnet signal. Default mainnet.
        if grep -qiE '^[[:space:]]*chain_type[[:space:]]*=[[:space:]]*"?Testnet' "$toml" \
           || [[ "$addr" == *:1341* ]]; then
            net=testnet
        else
            net=mainnet
        fi
        secret=$(grin_node_secret_path "$net" foreign 2>/dev/null || true)
        [[ -n "$secret" && -f "$secret" ]] || continue
        grin_toml_set_key "$toml" "node_api_secret_path" "\"$secret\"" || true
    done < <(find /opt/grin -maxdepth 4 -name 'grin-wallet.toml' 2>/dev/null || true)
    return 0
}

# Script 04 node-API nginx — re-embed the foreign secret in the Basic-Auth header;
# reload nginx only when the header actually changed. Covers BOTH the public
# MODE-B vhost and the Tor vhost, for each network (4 possible confs). Each is a
# no-op unless it exists AND already carries an injected auth header.
grin_sync_node_api_nginx() {
    command -v nginx >/dev/null 2>&1 || return 0
    local entry conf net dir secret b64 changed=0
    for entry in \
        "/etc/nginx/sites-available/grin-node-api:mainnet" \
        "/etc/nginx/sites-available/grin-node-api-testnet:testnet" \
        "/etc/nginx/sites-available/grin-node-api-tor:mainnet" \
        "/etc/nginx/sites-available/grin-node-api-tor-testnet:testnet"; do
        conf="${entry%:*}"; net="${entry##*:}"
        [[ -f "$conf" ]] || continue
        grep -qE 'proxy_set_header[[:space:]]+Authorization[[:space:]]+"Basic ' "$conf" || continue
        dir=$(grin_live_node_dir "$net" 2>/dev/null || true)
        [[ -n "$dir" && -f "$dir/.foreign_api_secret" ]] || continue
        secret=$(tr -d '[:space:]' < "$dir/.foreign_api_secret" 2>/dev/null || true)
        [[ -n "$secret" ]] || continue
        b64=$(printf '%s' "grin:$secret" | base64 -w0 2>/dev/null || printf '%s' "grin:$secret" | base64)
        grep -qF "Basic $b64\"" "$conf" && continue   # already correct
        sed -i -E "s#proxy_set_header([[:space:]]+)Authorization([[:space:]]+)\"Basic [^\"]*\";#proxy_set_header\\1Authorization\\2\"Basic $b64\";#" "$conf"
        changed=1
    done
    [[ "$changed" == 1 ]] && { nginx -t >/dev/null 2>&1 && systemctl reload nginx 2>/dev/null || true; }
    return 0
}

# Re-apply live node secrets to every consumer installed on this box.
grin_secrets_sync_all() {
    grin_sync_collector       || true
    grin_grinscan_sync        || true
    grin_sync_wallets         || true
    grin_sync_node_api_nginx  || true
    return 0
}

# ─── Install the periodic self-heal (systemd timer) ───────────────────────────
# Copies THIS lib to a stable path, installs a CLI wrapper, and enables a 5-min
# systemd timer. Idempotent — any product may call it on every setup run.
grin_install_secret_sync() {
    local src="${BASH_SOURCE[0]}"
    [[ -f "$src" ]] || return 0
    mkdir -p /opt/grin/lib 2>/dev/null || true
    cp "$src" "$GNS_LIB_INSTALL_PATH" 2>/dev/null || true
    chmod 644 "$GNS_LIB_INSTALL_PATH" 2>/dev/null || true

    cat > "$GNS_SYNC_BIN" <<EOF
#!/bin/bash
# AUTO-GENERATED by grin_node_secrets.sh — re-applies the live Grin node's
# api/foreign secrets to every installed toolkit consumer. Run by the
# grin-secret-sync systemd timer and before each stats collector run.
source "$GNS_LIB_INSTALL_PATH"
grin_secrets_sync_all
EOF
    chmod 755 "$GNS_SYNC_BIN" 2>/dev/null || true

    cat > /etc/systemd/system/grin-secret-sync.service <<EOF
[Unit]
Description=Grin Node Toolkit — re-sync node API secrets to all consumers
After=network.target

[Service]
Type=oneshot
ExecStart=${GNS_SYNC_BIN}
EOF

    cat > /etc/systemd/system/grin-secret-sync.timer <<'EOF'
[Unit]
Description=Periodic Grin node secret re-sync (self-heal after a node rebuild)

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF

    systemctl daemon-reload 2>/dev/null || true
    systemctl enable --now grin-secret-sync.timer 2>/dev/null || true
    return 0
}
