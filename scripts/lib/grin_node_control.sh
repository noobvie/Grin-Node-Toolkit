# =============================================================================
# lib/grin_node_control.sh — shared Grin node primitives
# =============================================================================
# Sourced by 01 / 03 / 07 (and the node-sync watchdog in grin_node_keepalive.sh).
# Provides the small set of node-control primitives that were previously copied
# across scripts:
#
#   _grin_session_name <dir>          tmux session name from a node dir
#   gnc_node_api_port  <network>      Owner API port (3413 / 13413)
#   gnc_resolve_node_dir <network>    node dir from the instances conf (CONF-ONLY)
#   gnc_node_binary <dir>             path to the grin binary if executable
#   gnc_get_pid_on_port <port>        listening PID on a TCP port
#   gnc_wait_for_port <port> [to] [iv]   block until a port listens (or timeout)
#   gnc_start_node_tmux <network>     (re)start the node in tmux (SHELL=/bin/bash)
#   gnc_owner_get_status <network>    raw get_status JSON (Owner API, localhost)
#   gnc_status_field <json> <path>    extract a dotted field from get_status JSON
#
# Conventions (see .claude/CLAUDE.md):
#   · Lib file — sourced, never executed → NO shebang, NO `set -euo pipefail`.
#   · CONF-ONLY node resolution: only nodes listed in grin_instances_location.conf
#     are managed. NO default-dir fallback (a node absent from the conf is never
#     guessed at, so the watchdog never restarts an unknown binary).
#   · Any tmux launched from cron MUST be prefixed `SHELL=/bin/bash` (cron sets
#     SHELL=/bin/sh; tmux child sessions inherit it and a bare `sh` breaks things).
# =============================================================================

# Source-guard: safe to source multiple times (07 may source this AND keepalive,
# which also sources this).
[[ -n "${_GRIN_NODE_CONTROL_SH_LOADED:-}" ]] && return 0
_GRIN_NODE_CONTROL_SH_LOADED=1

# Authoritative node registry (written by Script 01).
GNC_INSTANCES_CONF="${GNC_INSTANCES_CONF:-/opt/grin/conf/grin_instances_location.conf}"

# Lightweight logging fallbacks — only defined if the caller hasn't already.
# A cron watchdog wrapper sources this with no logging helpers in scope; an
# interactive script (07) already defines richer colored versions and keeps them.
if ! declare -F info    >/dev/null 2>&1; then info()    { echo "[INFO]  $*"; }; fi
if ! declare -F warn    >/dev/null 2>&1; then warn()    { echo "[WARN]  $*"; }; fi
if ! declare -F error   >/dev/null 2>&1; then error()   { echo "[ERROR] $*" >&2; }; fi
if ! declare -F success >/dev/null 2>&1; then success() { echo "[OK]    $*"; }; fi

# -----------------------------------------------------------------------------
# _grin_session_name <node_dir>
# tmux session name convention: grin_<nodetype>_<networktype>.
# Canonical copy (previously duplicated in 01/03/07). Uses UNDERSCORES so the
# name matches `_find_grin_session_for_pid`'s `grep '^grin_'`. NOTE: Script 03's
# autostart cron currently builds a DASHED name (grin-pruned-mainnet) — that is
# the outlier and should be reconciled to this form when 03 is wired to the lib.
# -----------------------------------------------------------------------------
_grin_session_name() {
    case "$(basename "${1:-}")" in
        mainnet-full)  echo "grin_full_mainnet"   ;;
        mainnet-prune) echo "grin_pruned_mainnet" ;;
        testnet-prune) echo "grin_pruned_testnet" ;;
        *)             echo "grin_$(basename "${1:-}")" ;;
    esac
}

# -----------------------------------------------------------------------------
# gnc_node_api_port <network>   → 3413 (mainnet) | 13413 (testnet)
# -----------------------------------------------------------------------------
gnc_node_api_port() {
    [[ "${1:-}" == "testnet" ]] && echo 13413 || echo 3413
}

# -----------------------------------------------------------------------------
# gnc_resolve_node_dir <network>   → node dir from the instances conf, or rc 1.
# CONF-ONLY: no default-dir fallback (deliberate — see header). Mainnet prefers
# a full node over a pruned one (matches Script 03's precedence).
# -----------------------------------------------------------------------------
gnc_resolve_node_dir() {
    local network="${1:-mainnet}" dir=""
    [[ -f "$GNC_INSTANCES_CONF" ]] || return 1

    # Pull values without sourcing the file into our own scope (avoids clobbering
    # any same-named caller globals). Lines look like:  PRUNEMAIN_GRIN_DIR="..."
    local prunemain fullmain prunetest
    prunemain=$(grep -E '^PRUNEMAIN_GRIN_DIR=' "$GNC_INSTANCES_CONF" 2>/dev/null | head -1 | cut -d'"' -f2)
    fullmain=$(grep -E '^FULLMAIN_GRIN_DIR='   "$GNC_INSTANCES_CONF" 2>/dev/null | head -1 | cut -d'"' -f2)
    prunetest=$(grep -E '^PRUNETEST_GRIN_DIR=' "$GNC_INSTANCES_CONF" 2>/dev/null | head -1 | cut -d'"' -f2)

    if [[ "$network" == "testnet" ]]; then
        dir="$prunetest"
    else
        dir="${fullmain:-$prunemain}"
    fi

    [[ -n "$dir" && -d "$dir" ]] || return 1
    echo "$dir"
}

# -----------------------------------------------------------------------------
# gnc_node_binary <node_dir>   → "<dir>/grin" if executable, else rc 1.
# -----------------------------------------------------------------------------
gnc_node_binary() {
    local dir="${1:-}"
    [[ -n "$dir" && -x "$dir/grin" ]] || return 1
    echo "$dir/grin"
}

# -----------------------------------------------------------------------------
# gnc_get_pid_on_port <port>   → listening PID, or rc 1.
# -----------------------------------------------------------------------------
gnc_get_pid_on_port() {
    local port="${1:-}" pid
    [[ -n "$port" ]] || return 1
    if command -v ss &>/dev/null; then
        pid=$(ss -tlnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' | head -1)
        [[ -n "$pid" ]] && { echo "$pid"; return 0; }
    fi
    if command -v lsof &>/dev/null; then
        pid=$(lsof -tni :"$port" -sTCP:LISTEN 2>/dev/null | head -1)
        [[ -n "$pid" ]] && { echo "$pid"; return 0; }
    fi
    return 1
}

# -----------------------------------------------------------------------------
# gnc_wait_for_port <port> [timeout=120] [interval=5]
# Block until the port is listening. rc 0 if up within timeout, else rc 1.
# -----------------------------------------------------------------------------
gnc_wait_for_port() {
    local port="${1:-}" timeout="${2:-120}" interval="${3:-5}" elapsed=0
    [[ -n "$port" ]] || return 1
    while (( elapsed < timeout )); do
        gnc_get_pid_on_port "$port" >/dev/null 2>&1 && return 0
        sleep "$interval"
        elapsed=$(( elapsed + interval ))
    done
    return 1
}

# -----------------------------------------------------------------------------
# gnc_start_node_tmux <network> [wait_timeout=120]
# Resolve the node dir from conf, kill any stale session of the same name, and
# (re)start `grin server run` in a detached tmux session. Returns 0 once the API
# port is listening, else 1. SHELL=/bin/bash is mandatory for cron-launched tmux.
# -----------------------------------------------------------------------------
gnc_start_node_tmux() {
    local network="${1:-mainnet}" wait_timeout="${2:-120}"
    local dir binary sess port

    dir=$(gnc_resolve_node_dir "$network") || {
        error "No $network node in $GNC_INSTANCES_CONF — not starting (conf-only)."
        return 1
    }
    binary=$(gnc_node_binary "$dir") || {
        error "No executable grin binary at $dir/grin — not starting."
        return 1
    }
    sess=$(_grin_session_name "$dir")
    port=$(gnc_node_api_port "$network")

    command -v tmux &>/dev/null || {
        error "tmux not installed — cannot start node."
        return 1
    }

    # Kill any stale session with this name before starting fresh.
    tmux kill-session -t "$sess" 2>/dev/null || true

    info "Starting grin ($network) in tmux session '$sess' — dir $dir"
    SHELL=/bin/bash tmux new-session -d -s "$sess" -c "$dir" \
        "echo 'Starting Grin node...'; cd '$dir' && '$binary' server run; echo ''; echo 'Grin process exited. Press Enter to close.'; read" \
        || { error "Failed to create tmux session '$sess'. Start manually: cd $dir && ./grin server run"; return 1; }

    if gnc_wait_for_port "$port" "$wait_timeout"; then
        success "Grin ($network) is up on port $port (session '$sess')."
        return 0
    fi
    warn "Grin ($network) did not bind port $port within ${wait_timeout}s. Check: tmux attach -t $sess"
    return 1
}

# -----------------------------------------------------------------------------
# gnc_owner_get_status <network> [timeout=8]   → raw get_status JSON on stdout.
# Owner API on localhost, Basic Auth grin:<.api_secret>. The secret never leaves
# the VPS. Returns rc 1 (no output) if the node dir/secret can't be resolved or
# the call fails. Prefer get_status over get_tip (get_tip → "Method not found").
# -----------------------------------------------------------------------------
gnc_owner_get_status() {
    local network="${1:-mainnet}" timeout="${2:-8}"
    local dir port secret
    dir=$(gnc_resolve_node_dir "$network") || return 1
    port=$(gnc_node_api_port "$network")
    secret=$(cat "$dir/.api_secret" 2>/dev/null) || return 1
    [[ -n "$secret" ]] || return 1
    curl -s --max-time "$timeout" -u "grin:$secret" \
        -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","method":"get_status","params":[],"id":1}' \
        "http://127.0.0.1:$port/v2/owner" 2>/dev/null
}

# -----------------------------------------------------------------------------
# gnc_status_field <json> <dotted.path>   → field value, or rc 1.
# The node serialises Result<T,E> as {"Ok": T}; get_status lives under
# result.Ok. Pass paths WITHOUT the result.Ok prefix — it is added automatically.
#   gnc_status_field "$json" tip.height
#   gnc_status_field "$json" sync_status
#   gnc_status_field "$json" connections
# -----------------------------------------------------------------------------
gnc_status_field() {
    local json="${1:-}" path="${2:-}"
    [[ -n "$json" && -n "$path" ]] || return 1
    command -v python3 &>/dev/null || return 1
    GNC_JSON="$json" GNC_PATH="$path" python3 - <<'PY' 2>/dev/null || return 1
import json, os, sys
try:
    data = json.loads(os.environ["GNC_JSON"])
except Exception:
    sys.exit(1)
node = data.get("result", data)
if isinstance(node, dict) and "Ok" in node:
    node = node["Ok"]
for key in os.environ["GNC_PATH"].split("."):
    if isinstance(node, dict) and key in node:
        node = node[key]
    else:
        sys.exit(1)
if node is None:
    sys.exit(1)
print(node)
PY
}
