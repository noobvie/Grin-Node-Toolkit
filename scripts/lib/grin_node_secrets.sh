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

# _gns_has_grin_session <sess> → rc 0 if the session exists on EITHER tmux
# server: the grin user's own socket (gnc_launch_node_session / su-grin
# launches, see grin_node_control.sh) or the plain root socket (legacy/manual
# launches). The node launch contract runs `grin server run` as the `grin`
# user on its own tmux socket, so a bare `tmux has-session` from a root
# context never finds it — this must be checked first or mainnet full/pruned
# detection silently falls back to a directory-existence guess.
_gns_has_grin_session() {
    local sess="$1" uid sock
    [[ -n "$sess" ]] || return 1
    uid=$(id -u grin 2>/dev/null) || uid=""
    if [[ -n "$uid" ]]; then
        sock="/tmp/tmux-${uid}/default"
        [[ -S "$sock" ]] && tmux -S "$sock" has-session -t "$sess" 2>/dev/null && return 0
    fi
    tmux has-session -t "$sess" 2>/dev/null
}

# ─── Canonical resolver ───────────────────────────────────────────────────────
# grin_live_node_dir <mainnet|testnet> → echoes the node dir actually serving the
# network. Preference: active toolkit tmux session (the running node) → instances
# conf registry → standard toolkit path. Mainnet prefers the full archive when it
# is the running/registered node, else the pruned node (mirrors detect_node()).
grin_live_node_dir() {
    local net="$1" dir=""
    if [[ "$net" == "testnet" ]]; then
        _gns_has_grin_session grin_pruned_testnet && dir=/opt/grin/node/testnet-prune
        [[ -z "$dir" ]] && dir=$(_gns_conf_var PRUNETEST_GRIN_DIR)
        [[ -n "$dir" && -d "$dir" ]] || dir=/opt/grin/node/testnet-prune
    else
        if   _gns_has_grin_session grin_full_mainnet;   then dir=/opt/grin/node/mainnet-full
        elif _gns_has_grin_session grin_pruned_mainnet; then dir=/opt/grin/node/mainnet-prune
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

# ─── Persistent secret vault (/opt/grin/keys) ─────────────────────────────────
# WHY: Script 01's generate_secrets() used to mint fresh secrets on EVERY build,
# so a rebuild silently rotated the node's api/foreign secrets and broke every
# consumer holding the VALUE (Script 04's nginx Basic-Auth header, GrinScan,
# Tiny Explorer) until the timer below healed them. The vault makes the secrets
# survive a rebuild: stored once, outside the node dir, restored into whatever
# node dir the next build creates.
#
# Keyed by NETWORK, not by directory — a mainnet-prune → mainnet-full rebuild
# MOVES the node dir, so keying by dir would hand out a new secret anyway and
# defeat the whole point.
#
#   /opt/grin/keys/                  700 root:root
#     mainnet/.api_secret            600 root:root
#     mainnet/.foreign_api_secret
#     testnet/…
#
# DIRECTION MATTERS. Restore (vault → node dir) happens ONLY at build time from
# Script 01, while the node is down. It is deliberately NOT in the 5-min timer:
# the node reads its secret at startup and holds it in memory, so rewriting the
# file under a RUNNING node would leave file and node disagreeing and 401 every
# consumer. The timer only ever CAPTURES (node dir → vault, see
# grin_sync_vault_capture), which is always safe.
GNS_VAULT_DIR="${GNS_VAULT_DIR:-/opt/grin/keys}"
GNS_SECRET_FILES=(".api_secret" ".foreign_api_secret")

# Counters set by grin_secret_vault_ensure so callers can report what happened.
# They count FILES, not networks — the two secrets can take different paths, and
# a caller that reports only the first outcome would hide a secret that actually
# rotated. Always report a mixed result.
GNS_VAULT_RESTORED=0   # value came from the vault (rebuild — secret preserved)
GNS_VAULT_ADOPTED=0    # live secret existed, vault did not → vault seeded
GNS_VAULT_CREATED=0    # nothing anywhere → fresh secret minted
GNS_VAULT_WARNINGS=0   # vault writes that failed (node works; persistence lost)

# 20-char alphanumeric secret — same alphabet/length Script 01 has always used.
_gns_gen_secret() {
    local s
    s=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20 || true)
    [[ ${#s} -eq 20 ]] || return 1
    printf '%s' "$s"
}

_gns_vault_dir_for() {
    case "${1:-}" in
        mainnet|testnet) printf '%s/%s' "$GNS_VAULT_DIR" "$1" ;;
        *) return 1 ;;
    esac
}

# _gns_secret_sane <value> — reject values that cannot be a working secret.
# This is a CORRUPTION filter, not a style rule: it catches a truncated-to-zero
# file, binary garbage written over the secret, and a wrong file copied in
# (e.g. a whole config). It deliberately does NOT require grin's own 20-char
# alphanumeric shape — an operator may have set a custom secret, and rejecting
# it here would make the adopt path REPLACE their working secret, which is far
# worse than the corruption we are guarding against.
# Note it cannot catch a partial write that still looks plausible (7 of 20
# chars) — that is what the live-node probe below is for.
_gns_secret_sane() {
    local v="${1:-}"
    [[ -n "$v" ]] || return 1
    (( ${#v} >= 8 && ${#v} <= 128 )) || return 1
    [[ "$v" =~ ^[[:print:]]+$ ]] || return 1
    return 0
}

# Echo a secret's value, rc 1 when the file is missing, unreadable, blank or
# fails the sanity filter. Every vault read goes through here, so garbage is
# never restored, never adopted and never captured: a corrupt file simply falls
# through to the next branch (adopt → generate) and gets replaced with a
# working secret.
_gns_read_secret() {
    local f="${1:-}" v
    [[ -f "$f" ]] || return 1
    v=$(tr -d '[:space:]' < "$f" 2>/dev/null || true)
    _gns_secret_sane "$v" || return 1
    printf '%s' "$v"
}

# ─── Live-node verification ───────────────────────────────────────────────────
# The node is the only authority on whether a secret is the RIGHT one: it read
# the value at startup and holds it in memory, so a file that no longer matches
# is rejected on the wire. This catches the corruption case _gns_secret_sane
# cannot — a partial write that still looks like a plausible secret.
_gns_node_api_port() {
    case "${1:-}" in
        mainnet) printf '3413'  ;;
        testnet) printf '13413' ;;
        *) return 1 ;;
    esac
}

# <url> <method> <secret> → HTTP status on stdout ("000" = unreachable).
_gns_api_call_code() {
    local url="$1" method="$2" secret="$3" code
    code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 4 \
           -u "grin:$secret" -H 'Content-Type: application/json' \
           -d "{\"jsonrpc\":\"2.0\",\"method\":\"$method\",\"params\":[],\"id\":1}" \
           "$url" 2>/dev/null || true)
    [[ "$code" =~ ^[0-9]{3}$ ]] || code="000"
    printf '%s' "$code"
}

# _gns_probe_secret <net> <owner|foreign> <secret>
#   rc 0 = VERIFIED  — the node accepts it and demonstrably enforces auth
#   rc 1 = REJECTED  — the node is up and refuses it (stale or corrupt file)
#   rc 2 = UNKNOWN   — no curl, node down, or auth not enforced (see below)
#
# The control call is not optional. A node whose grin-server.toml has no
# api_secret_path accepts ANY credential, so a 200 for the candidate proves
# nothing on its own — verified in testing against a live node, where
# `grin:bogus` returned a full get_status result. If a deliberately wrong
# secret is NOT rejected, this probe cannot discriminate and must report
# UNKNOWN rather than falsely confirming.
_gns_probe_secret() {
    local net="$1" which="$2" secret="$3" port url method code_ok code_ctl
    command -v curl >/dev/null 2>&1 || return 2
    port=$(_gns_node_api_port "$net") || return 2
    if [[ "$which" == "owner" ]]; then
        url="http://127.0.0.1:${port}/v2/owner";   method="get_status"
    else
        url="http://127.0.0.1:${port}/v2/foreign"; method="get_version"
    fi

    code_ok=$(_gns_api_call_code "$url" "$method" "$secret")
    [[ "$code_ok" == "000" ]] && return 2
    [[ "$code_ok" == "401" || "$code_ok" == "403" ]] && return 1
    [[ "$code_ok" == "200" ]] || return 2

    code_ctl=$(_gns_api_call_code "$url" "$method" "gnsCONTROLnotArealSecret")
    [[ "$code_ctl" == "401" || "$code_ctl" == "403" ]] || return 2
    return 0
}

# Write a secret into the VAULT (always root-owned 600).
_gns_vault_put() {
    local file="$1" val="$2"
    mkdir -p "$(dirname "$file")" 2>/dev/null || return 1
    printf '%s' "$val" > "$file" 2>/dev/null || return 1
    chmod 600 "$file" 2>/dev/null || true
    return 0
}

# Write a secret into a NODE DIR, rc 0 = changed, 1 = already correct.
# An existing file is rewritten in place so its ownership and mode SURVIVE —
# Script 04 sets the foreign secret to root:<web_user> 640 for the REST
# collector, and the de-rooted pool sets root:grinsecret 640. A blind
# chown/chmod here would silently 403 both. Only brand-new files get the
# 600 grin:grin default.
_gns_node_put() {
    local file="$1" val="$2" existed=0 cur
    [[ -f "$file" ]] && existed=1
    if [[ "$existed" == 1 ]]; then
        cur=$(tr -d '[:space:]' < "$file" 2>/dev/null || true)
        [[ "$cur" == "$val" ]] && return 1
    fi
    printf '%s' "$val" > "$file" 2>/dev/null || return 1
    if [[ "$existed" == 0 ]]; then
        chmod 600 "$file" 2>/dev/null || true
        id grin &>/dev/null && chown grin:grin "$file" 2>/dev/null || true
    fi
    return 0
}

# grin_secret_vault_ensure <mainnet|testnet> <node_dir>
# The single entry point Script 01 calls in place of minting secrets. One
# function serves first install AND every rebuild, because the vault lookup
# comes first and "first install" is simply the case where it misses:
#   1. vault has it      → restore into the node dir   (rebuild: secret preserved)
#   2. node dir has it   → adopt into the vault        (pre-existing install)
#   3. neither           → generate, write both        (first install)
# Branch 2 is what makes this safe to ship to already-deployed servers: the
# first run adopts the secret that is already in use, so nothing changes under
# the running consumers.
#
# RETURN CONTRACT: rc 0 = the node dir ends up with BOTH secrets usable, which
# is the only thing the build actually depends on. A vault write that fails is
# degraded persistence (the secret won't survive the NEXT rebuild), not a broken
# node — it bumps GNS_VAULT_WARNINGS and the build continues. Only "the node has
# no usable secret" is fatal.
grin_secret_vault_ensure() {
    local net="${1:-}" node_dir="${2:-}" vdir name vfile lfile val
    GNS_VAULT_RESTORED=0; GNS_VAULT_ADOPTED=0; GNS_VAULT_CREATED=0; GNS_VAULT_WARNINGS=0

    vdir=$(_gns_vault_dir_for "$net") || return 1
    [[ -n "$node_dir" && -d "$node_dir" ]] || return 1

    mkdir -p "$vdir" 2>/dev/null || GNS_VAULT_WARNINGS=$(( GNS_VAULT_WARNINGS + 1 ))
    chmod 700 "$GNS_VAULT_DIR" 2>/dev/null || true
    chmod 700 "$vdir"          2>/dev/null || true

    for name in "${GNS_SECRET_FILES[@]}"; do
        vfile="$vdir/$name"; lfile="$node_dir/$name"
        if val=$(_gns_read_secret "$vfile"); then
            _gns_node_put "$lfile" "$val" || true
            GNS_VAULT_RESTORED=$(( GNS_VAULT_RESTORED + 1 ))
        elif val=$(_gns_read_secret "$lfile"); then
            _gns_vault_put "$vfile" "$val" || GNS_VAULT_WARNINGS=$(( GNS_VAULT_WARNINGS + 1 ))
            GNS_VAULT_ADOPTED=$(( GNS_VAULT_ADOPTED + 1 ))
        else
            val=$(_gns_gen_secret) || return 1
            _gns_vault_put "$vfile" "$val" || GNS_VAULT_WARNINGS=$(( GNS_VAULT_WARNINGS + 1 ))
            _gns_node_put  "$lfile" "$val" || true
            GNS_VAULT_CREATED=$(( GNS_VAULT_CREATED + 1 ))
        fi
    done

    # Verify the outcome that matters, rather than trusting the writes above:
    # _gns_node_put's failure path is deliberately non-fatal per file, so this
    # is what turns "the node has no usable secret" into a hard failure.
    for name in "${GNS_SECRET_FILES[@]}"; do
        _gns_read_secret "$node_dir/$name" >/dev/null || return 1
    done
    return 0
}

# Mirror the live node's secrets INTO the vault (never the reverse — see the
# direction note above). Safe under the timer: it only ever reads from the node
# dir. Keeps the vault seeded on boxes that have not been rebuilt yet, so the
# very first rebuild after installing this already has something to restore.
#
# NEVER overwrites a good vault entry with an unproven value. Seeding an EMPTY
# slot is unconditional (there is nothing to lose), but replacing an existing
# entry means discarding the copy that protects this box, so it requires the
# live node to confirm the new value. If the probe cannot prove anything
# (node down, no curl, auth not enforced) the vault is left alone — the safe
# default is to keep what we have.
#
# This is also the correct behaviour for a legitimate out-of-band rotation: the
# file changes, the running node still enforces the old value, so capture holds
# off until the node is restarted and the new secret verifies.
grin_sync_vault_capture() {
    local net dir vdir name val cur which rc
    for net in mainnet testnet; do
        dir=$(grin_live_node_dir "$net" 2>/dev/null || true)
        [[ -n "$dir" && -d "$dir" ]] || continue
        vdir=$(_gns_vault_dir_for "$net") || continue
        for name in "${GNS_SECRET_FILES[@]}"; do
            val=$(_gns_read_secret "$dir/$name") || continue     # corrupt/blank → skip
            cur=$(_gns_read_secret "$vdir/$name" 2>/dev/null || true)
            [[ "$cur" == "$val" ]] && continue                   # already mirrored

            if [[ -z "$cur" ]]; then
                _gns_vault_put "$vdir/$name" "$val" || true      # empty slot — seed it
                continue
            fi

            case "$name" in
                .api_secret)         which="owner"   ;;
                .foreign_api_secret) which="foreign" ;;
                *)                   which="foreign" ;;
            esac
            if _gns_probe_secret "$net" "$which" "$val"; then
                _gns_vault_put "$vdir/$name" "$val" || true
            else
                rc=$?
                if [[ "$rc" == 1 ]]; then
                    echo "[grin-secret-sync] $net $name differs from the vault and the node REJECTS it" \
                         "— vault left intact (file looks stale or corrupt)."
                fi
                # rc 2 (unverifiable) stays silent: the node is simply down or
                # does not enforce auth, which is not news every 5 minutes.
            fi
        done
        chmod 700 "$GNS_VAULT_DIR" 2>/dev/null || true
        chmod 700 "$vdir"          2>/dev/null || true
    done
    return 0
}

# grin_secret_vault_rotate <mainnet|testnet> — deliberate rotation: mint NEW
# secrets, update BOTH the vault and the live node dir, then re-sync every
# consumer. The node must be RESTARTED afterwards: it read the old secret at
# startup and still enforces it, so until then every consumer gets 401.
grin_secret_vault_rotate() {
    local net="${1:-}" dir vdir name val
    vdir=$(_gns_vault_dir_for "$net") || {
        echo "[grin-secret-sync] rotate: network must be 'mainnet' or 'testnet'." >&2
        return 1
    }
    dir=$(grin_live_node_dir "$net" 2>/dev/null || true)
    [[ -n "$dir" && -d "$dir" ]] || {
        echo "[grin-secret-sync] rotate: no $net node directory found." >&2
        return 1
    }
    mkdir -p "$vdir" 2>/dev/null || return 1
    chmod 700 "$GNS_VAULT_DIR" 2>/dev/null || true
    chmod 700 "$vdir"          2>/dev/null || true

    for name in "${GNS_SECRET_FILES[@]}"; do
        val=$(_gns_gen_secret) || { echo "[grin-secret-sync] rotate: /dev/urandom unavailable." >&2; return 1; }
        _gns_vault_put "$vdir/$name" "$val" || return 1
        _gns_node_put  "$dir/$name"  "$val" || true
    done
    echo "[grin-secret-sync] rotated $net secrets in $dir (vault: $vdir)."
    grin_secrets_sync_all || true
    echo "[grin-secret-sync] RESTART the $net node now — it still enforces the OLD secret."
    return 0
}

# ─── Idempotent appliers (return 0 = changed, 1 = no change / skipped) ─────────
# grin_env_set <file> <KEY> <value> — rewrite KEY=value in a shell env file.
grin_env_set() {
    local file="$1" key="$2" val="$3" cur
    [[ -f "$file" && -n "$val" ]] || return 1
    # `|| true`: callers run under `set -o pipefail`, where a no-match grep fails the
    # whole pipeline and the assignment with it — which aborts this function on the
    # very first key that isn't in the file yet, i.e. exactly the case it exists for.
    cur=$(grep -E "^${key}=" "$file" 2>/dev/null | head -1 | cut -d= -f2- || true)
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

# Tiny Explorer 06d — re-copy the mainnet secret VALUES into its data dir; restart
# grin-tiny-explorer on change. No-op when the product is absent.
grin_sync_tiny_explorer() {
    local base="/opt/grin/tiny-explorer" dir changed=0
    [[ -d "$base" ]] || return 0
    dir=$(grin_live_node_dir mainnet 2>/dev/null || true)
    [[ -n "$dir" ]] || return 0
    _gns_copy_if_changed "$dir/.foreign_api_secret" "$base/.foreign_api_secret" && changed=1 || true
    _gns_copy_if_changed "$dir/.api_secret"         "$base/.api_secret"         && changed=1 || true
    [[ "$changed" == 1 ]] && { systemctl restart grin-tiny-explorer 2>/dev/null || true; }
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
        # Skip wallets that talk to a remote node — we must not hand them a local
        # secret. grin-wallet.toml spells this key **check_**node_api_http_addr;
        # matching only the bare name made this guard dead code, so every wallet
        # looked local and a remote-node wallet (Fidelius defaults to a curated
        # PUBLIC node) had the local node's foreign secret stamped in — which
        # grin-wallet then sends as Basic Auth to that third-party host. Both
        # spellings are matched so an older/hand-written toml still resolves.
        # `-m1 … || true`, not `| head -1`: under `set -o pipefail` a no-match grep
        # fails the pipeline, the assignment inherits that, and errexit then kills
        # the whole loop at the FIRST wallet — which is what used to happen on every
        # call from an errexit caller (01/04/05/06), since the old pattern matched
        # nothing anywhere. From the timer (no errexit) it fell through instead, with
        # an empty addr, and patched every wallet including the remote ones.
        addr=$(grep -m1 -E '^[[:space:]]*(check_)?node_api_http_addr[[:space:]]*=' "$toml" 2>/dev/null || true)
        # No address key at all → we cannot prove the node is local. Skip rather
        # than guess: the failure mode of guessing is leaking a secret off-box.
        [[ -n "$addr" ]] || continue
        if [[ "$addr" != *127.0.0.1* && "$addr" != *localhost* ]]; then
            # Remote node. Report — don't silently repair — a secret path an
            # earlier (broken-guard) run may already have stamped in: clearing it
            # would be a config change the operator never asked for, and the
            # journal is where the timer's findings belong.
            if grep -qE '^[[:space:]]*node_api_secret_path[[:space:]]*=[[:space:]]*"/' "$toml" 2>/dev/null; then
                echo "WARN: $toml points at a REMOTE node but still carries a local" \
                     "node_api_secret_path — grin-wallet will send that secret off-box." \
                     "Blank it (node_api_secret_path = \"\") unless that remote node is yours."
            fi
            continue
        fi
        # Network: chain_type is authoritative; the testnet node port (1341x) in
        # the address is a secondary testnet signal. Default mainnet.
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

# Public pool hub (Script 07) — re-apply the pool's stratum wiring to the LIVE
# node's grin-server.toml after a node rebuild (design §13.10a). A rebuild wipes
# the toml, losing enable_stratum_server / stratum_server_addr / the
# wallet_listener_url coinbase pointer — the pool then mines nothing. Guarded:
# only when a pool install exists (its JSON conf). Values come from that conf
# (node_stratum_port) + the fixed pool wallet owner port (3420/13420, base URL —
# the node appends /v2/foreign itself). Replaces EXISTING keys only (commented
# or active) — never appends, which could land in the wrong TOML section.
# Also re-applies group-read (root:grinsecret 640) on the node's two secret
# files for the de-rooted grin-pool-manager (lib/grin-node.js reads both).
# The node is NOT restarted automatically — a drifted toml is flagged on stdout
# (timer journal); the operator/watchdog restarts.
_gns_toml_repatch() {  # <file> <key> <desired-val-literal> → 0 changed, 1 no-op
    local file="$1" key="$2" val="$3" cur want
    grep -qE "^[#[:space:]]*${key}[[:space:]]*=" "$file" 2>/dev/null || return 1
    # Both sides quote-normalised (xargs strips surrounding quotes) so a correct
    # quoted value is a no-op — otherwise the timer would cry "drift" every 5 min.
    cur=$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$file" 2>/dev/null \
          | head -1 | sed -E 's/^[^=]+=[[:space:]]*//' | xargs 2>/dev/null || true)
    want=$(printf '%s' "$val" | xargs 2>/dev/null || printf '%s' "$val")
    [[ "$cur" == "$want" ]] && return 1
    sed -i -E "s|^[#[:space:]]*${key}[[:space:]]*=.*|${key} = ${val}|" "$file"
    return 0
}

grin_sync_pool_stratum() {
    local net conf dir toml port owner_port changed sf
    for net in mainnet testnet; do
        if [[ "$net" == "testnet" ]]; then
            conf=/opt/grin/conf/grin_pubpool_testnet.json; owner_port=13420
        else
            conf=/opt/grin/conf/grin_pubpool.json;         owner_port=3420
        fi
        [[ -f "$conf" ]] || continue
        dir=$(grin_live_node_dir "$net" 2>/dev/null || true)
        [[ -n "$dir" ]] || continue
        toml="$dir/grin-server.toml"
        [[ -f "$toml" ]] || continue

        # pool.json is pretty-printed one key per line — grep is enough here
        # (no node dependency; this lib must run on any box the timer lands on).
        port=$(grep -oE '"node_stratum_port"[[:space:]]*:[[:space:]]*[0-9]+' "$conf" 2>/dev/null \
               | grep -oE '[0-9]+$' | head -1 || true)
        [[ -n "$port" ]] || { [[ "$net" == "testnet" ]] && port=13416 || port=3416; }

        changed=0
        # xargs-normalised comparisons: toml strings compare without their quotes.
        _gns_toml_repatch "$toml" "enable_stratum_server" "true" && changed=1 || true
        if ! grep -qE "^[[:space:]]*stratum_server_addr[[:space:]]*=[[:space:]]*\"127\.0\.0\.1:${port}\"" "$toml" 2>/dev/null; then
            _gns_toml_repatch "$toml" "stratum_server_addr" "\"127.0.0.1:${port}\"" && changed=1 || true
        fi
        if ! grep -qE "^[[:space:]]*wallet_listener_url[[:space:]]*=[[:space:]]*\"http://127\.0\.0\.1:${owner_port}\"" "$toml" 2>/dev/null; then
            _gns_toml_repatch "$toml" "wallet_listener_url" "\"http://127.0.0.1:${owner_port}\"" && changed=1 || true
        fi
        if [[ "$changed" == 1 ]]; then
            echo "[grin-secret-sync] pool stratum wiring re-applied to $toml — RESTART the $net node to take effect."
        fi

        # De-rooted backend secret access (root:grinsecret 640) — a rebuild
        # regenerates the files 600 root:root, silently 403-ing the pool.
        if getent group grinsecret >/dev/null 2>&1; then
            for sf in "$dir/.api_secret" "$dir/.foreign_api_secret"; do
                [[ -f "$sf" ]] || continue
                chgrp grinsecret "$sf" 2>/dev/null || true
                chmod 640 "$sf" 2>/dev/null || true
            done
        fi
    done
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
# Capture runs FIRST so the vault mirrors what the node actually serves before
# the consumers are pointed at it (capture is read-only w.r.t. the node dir —
# it never writes a secret back into a running node; see the vault notes above).
grin_secrets_sync_all() {
    grin_sync_vault_capture   || true
    grin_sync_collector       || true
    grin_grinscan_sync        || true
    grin_sync_tiny_explorer   || true
    grin_sync_wallets         || true
    grin_sync_node_api_nginx  || true
    grin_sync_pool_stratum    || true
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
#
# Usage:
#   grin-secret-sync                    re-sync all consumers (default; the timer)
#   grin-secret-sync --rotate <net>     mint NEW secrets for mainnet|testnet,
#                                       update the /opt/grin/keys vault + node dir,
#                                       re-sync consumers. REQUIRES a node restart.
source "$GNS_LIB_INSTALL_PATH"
case "\${1:-}" in
    --rotate) grin_secret_vault_rotate "\${2:-}" ;;
    -h|--help)
        sed -n '6,10p' "\$0"
        ;;
    *)        grin_secrets_sync_all ;;
esac
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
