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
#   gnc_grin_tmux_socket              grin user's tmux socket path (rc 1 if absent)
#   gnc_has_grin_session <sess>       session exists on EITHER tmux server
#   gnc_kill_grin_session <sess>      kill named session on BOTH tmux servers
#   gnc_kill_all_grin_sessions        kill every grin_* session on BOTH servers
#   gnc_kill_grin_procs [dir] [grace] TERM→wait→KILL grin server processes
#   gnc_launch_node_session <dir> <bin> <sess>   THE ONLY sanctioned node launcher
#   gnc_start_node_tmux <network>     conf-resolved wrapper around the launcher
#   gnc_owner_get_status <network>    raw get_status JSON (Owner API, localhost)
#   gnc_status_field <json> <path>    extract a dotted field from get_status JSON
#   gnc_install_gtmux_helper          install /usr/local/bin/gtmux (view grin sessions)
#
# TWO TMUX SERVERS — the root cause of every "lock file is held by another
# grin process" duplicate: a session started by root lives on root's default
# socket (/tmp/tmux-0/default), while a session started AS the grin user (the
# @reboot autostart, and now ALL launches) lives on grin's per-user socket
# (/tmp/tmux-<uid>/default — what the gtmux CLI helper targets). A kill or
# has-session check that only looks at one server misses nodes on the other →
# a second grin is started → LMDB lock error. Rules:
#   · START nodes only via gnc_launch_node_session → always grin-owned, always
#     on grin's socket, always visible via `gtmux` (never plain root `tmux ls`).
#   · STOP/CHECK sessions only via the gnc_* helpers below → both servers.
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
# name matches the `grep '^grin_'` session sweeps (a dashed name would escape
# them). All scripts (01/03/04/07/081) now derive names from this function.
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
# gnc_grin_tmux_socket   → grin user's per-user tmux socket path, rc 1 if the
# grin user is missing or its tmux server has never started (no socket file).
# Root bypasses the socket-dir perms, so root can drive this server directly.
# -----------------------------------------------------------------------------
gnc_grin_tmux_socket() {
    local uid sock
    uid=$(id -u grin 2>/dev/null) || return 1
    sock="/tmp/tmux-${uid}/default"
    [[ -S "$sock" ]] || return 1
    echo "$sock"
}

# -----------------------------------------------------------------------------
# gnc_has_grin_session <sess>   → rc 0 if the session exists on EITHER tmux
# server. Sets GNC_SESSION_SOCKET to "grin" or "root" so callers can print the
# right attach command (gtmux vs plain tmux).
# -----------------------------------------------------------------------------
gnc_has_grin_session() {
    local sess="${1:-}" sock
    GNC_SESSION_SOCKET=""
    [[ -n "$sess" ]] || return 1
    if sock=$(gnc_grin_tmux_socket) && tmux -S "$sock" has-session -t "$sess" 2>/dev/null; then
        GNC_SESSION_SOCKET="grin"
        return 0
    fi
    if tmux has-session -t "$sess" 2>/dev/null; then
        GNC_SESSION_SOCKET="root"
        return 0
    fi
    return 1
}

# -----------------------------------------------------------------------------
# gnc_kill_grin_session <sess>  — kill the named session on BOTH tmux servers
# (root leftovers from before the gtmux unification included). Never fails.
# -----------------------------------------------------------------------------
gnc_kill_grin_session() {
    local sess="${1:-}" sock
    [[ -n "$sess" ]] || return 0
    tmux kill-session -t "$sess" 2>/dev/null || true
    if sock=$(gnc_grin_tmux_socket); then
        tmux -S "$sock" kill-session -t "$sess" 2>/dev/null || true
    fi
    return 0
}

# -----------------------------------------------------------------------------
# gnc_kill_all_grin_sessions  — kill every grin_* session on BOTH tmux servers.
# -----------------------------------------------------------------------------
gnc_kill_all_grin_sessions() {
    local sess sock
    while IFS= read -r sess; do
        [[ -n "$sess" ]] || continue
        tmux kill-session -t "$sess" 2>/dev/null && info "Tmux session '$sess' closed (root socket)." || true
    done < <(tmux ls -F '#{session_name}' 2>/dev/null | grep '^grin_' || true)
    if sock=$(gnc_grin_tmux_socket); then
        while IFS= read -r sess; do
            [[ -n "$sess" ]] || continue
            tmux -S "$sock" kill-session -t "$sess" 2>/dev/null && info "Tmux session '$sess' closed (grin socket)." || true
        done < <(tmux -S "$sock" ls -F '#{session_name}' 2>/dev/null | grep '^grin_' || true)
    fi
    return 0
}

# -----------------------------------------------------------------------------
# gnc_kill_grin_procs [dir] [grace=30]
# TERM→wait→KILL every `grin server run` process on the OS — regardless of
# which tmux server (or none) hosts it. With <dir>, only processes whose
# cwd or binary dir matches (so mainnet/testnet never kill each other);
# without, ALL grin server processes (full-stop paths only). A survivor here
# is exactly what holds the LMDB/grin lock and breaks the next start.
# -----------------------------------------------------------------------------
gnc_kill_grin_procs() {
    local dir="${1:-}" grace="${2:-30}"
    local -a pids=()
    local pid cwd exe
    while IFS= read -r pid; do
        [[ -n "$pid" ]] || continue
        if [[ -n "$dir" ]]; then
            cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
            exe=$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)
            [[ "$cwd" == "$dir" || "$exe" == "$dir/grin" ]] || continue
        fi
        pids+=("$pid")
    done < <(pgrep -f 'grin server run' 2>/dev/null || true)
    # if-form throughout: this runs under callers' `set -e` (see CLAUDE.md).
    if [[ ${#pids[@]} -eq 0 ]]; then return 0; fi

    info "Stopping leftover grin process(es): ${pids[*]} (SIGTERM, up to ${grace}s)..."
    kill -TERM "${pids[@]}" 2>/dev/null || true
    local waited=0 alive
    while (( waited < grace )); do
        alive=""
        for pid in "${pids[@]}"; do
            if ps -p "$pid" >/dev/null 2>&1; then alive=1; break; fi
        done
        if [[ -z "$alive" ]]; then break; fi
        sleep 2
        waited=$(( waited + 2 ))
    done
    for pid in "${pids[@]}"; do
        if ps -p "$pid" >/dev/null 2>&1; then
            warn "PID $pid still alive after ${grace}s — sending SIGKILL."
            kill -KILL "$pid" 2>/dev/null || true
        fi
    done
    return 0
}

# -----------------------------------------------------------------------------
# gnc_launch_node_session <node_dir> <binary> <session>
# THE ONLY sanctioned node launcher (launch contract, .claude/CLAUDE.md):
#   1. Kills the named session on BOTH tmux servers.
#   2. Sweeps every remaining `grin server run` process for this node dir —
#      a hidden duplicate on the other tmux server is what causes the
#      "lock file is held by another grin process" error.
#   3. Starts the node AS the grin user (su) with HOME=$dir, so the tmux
#      SERVER itself runs on grin's per-user socket → view via `gtmux`
#      (a plain root `tmux ls` will NOT show it — by design).
# 9>&- closes Script 01's flock fd so the long-lived tmux server never
# inherits it (harmless no-op when fd 9 is not open).
# -----------------------------------------------------------------------------
gnc_launch_node_session() {
    local dir="${1:-}" binary="${2:-}" sess="${3:-}"
    [[ -n "$dir" && -n "$binary" && -n "$sess" ]] || { error "gnc_launch_node_session: dir/binary/session required."; return 1; }
    command -v tmux &>/dev/null || { error "tmux not installed — cannot start node."; return 1; }

    gnc_kill_grin_session "$sess"
    gnc_kill_grin_procs "$dir"

    if id grin &>/dev/null; then
        # chown first reclaims any root-owned leftovers from an earlier root-run
        # start (a root-run node writes root:root files that EACCES-block grin).
        chown -R grin:grin "$dir" 2>/dev/null || true
        info "Starting grin in grin-owned tmux session '$sess' — dir $dir"
        su -s /bin/bash grin -c "cd '$dir' && env HOME='$dir' SHELL=/bin/bash tmux new-session -d -s '$sess' 'echo Starting Grin node...; $binary server run; echo; echo Grin process exited. Press Enter to close.; read'" 9>&- \
            || { error "Failed to create grin-owned tmux session '$sess'. Start manually: cd $dir && su -s /bin/bash -c 'HOME=$dir ./grin server run' grin"; return 1; }
    else
        warn "User 'grin' not found — running node as current user. Re-run Script 01 to create it."
        SHELL=/bin/bash tmux new-session -d -s "$sess" -c "$dir" \
            "echo 'Starting Grin node...'; cd '$dir' && HOME='$dir' '$binary' server run; echo ''; echo 'Grin process exited. Press Enter to close.'; read" 9>&- \
            || { error "Failed to create tmux session '$sess'. Start manually: cd $dir && ./grin server run"; return 1; }
    fi

    # Make sure the operator can actually see the grin-owned session.
    gnc_install_gtmux_helper
    info "View: gtmux attach -t $sess   (grin-owned — plain 'tmux attach' won't find it; detach: Ctrl+B then D)"
    return 0
}

# -----------------------------------------------------------------------------
# gnc_start_node_tmux <network> [wait_timeout=120]
# Conf-resolved wrapper around gnc_launch_node_session. Returns 0 once the API
# port is listening, else 1.
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

    gnc_launch_node_session "$dir" "$binary" "$sess" || return 1

    if gnc_wait_for_port "$port" "$wait_timeout"; then
        success "Grin ($network) is up on port $port (session '$sess')."
        return 0
    fi
    warn "Grin ($network) did not bind port $port within ${wait_timeout}s. Check: gtmux attach -t $sess"
    return 1
}

# -----------------------------------------------------------------------------
# gnc_install_gtmux_helper
# Install /usr/local/bin/gtmux — a one-word wrapper to list/attach the grin-user
# tmux session(s). Node autostart runs `grin server run` as the unprivileged
# 'grin' user, so its tmux server lives on grin's per-user socket — invisible to
# a plain `tmux ls` from a root shell. This wrapper points tmux at grin's socket
# (root bypasses the socket-dir perms, so no sudo needed). Idempotent: overwrites
# in place. Best-effort — never fails the caller (always returns 0).
# -----------------------------------------------------------------------------
gnc_install_gtmux_helper() {
    local dest="/usr/local/bin/gtmux"
    cat > "$dest" 2>/dev/null <<'GTMUX_EOF' || return 0
#!/bin/bash
# gtmux — list/attach the Grin node tmux session(s) from a root shell.
# Installed by grin-node-toolkit. The node autostart runs `grin server run` as
# the unprivileged 'grin' user, so its tmux server lives on grin's per-user
# socket, not root's. This wrapper points tmux at grin's socket. Examples:
#   gtmux ls
#   gtmux attach -t grin_pruned_mainnet      # Ctrl+B then D to detach
GRIN_UID="$(id -u grin 2>/dev/null)"
if [[ -n "$GRIN_UID" && -S "/tmp/tmux-${GRIN_UID}/default" ]]; then
    exec tmux -S "/tmp/tmux-${GRIN_UID}/default" "$@"
fi
# grin user missing or its socket not found — fall back to the default server.
exec tmux "$@"
GTMUX_EOF
    chmod 755 "$dest" 2>/dev/null || true
    return 0
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
