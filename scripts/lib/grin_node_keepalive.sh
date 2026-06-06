# =============================================================================
# lib/grin_node_keepalive.sh — node keepalive: boot-autostart + sync watchdog
# =============================================================================
# Policy layer on top of grin_node_control.sh. Sourced by 03 / 07.
#
#   REBOOT AUTOSTART  (one tag-guarded @reboot crontab entry per network)
#     gnk_autostart_status                show per-net autostart state
#     gnk_autostart_enable  <network> [delay]   idempotent add/replace
#     gnk_autostart_disable <network|all>
#
#   NODE-SYNC WATCHDOG  (*/5 cron — restarts a down OR wedged node)
#     gnk_watchdog_install                write config + watchdog bin + cron.d
#     gnk_watchdog_remove                 remove bin + cron.d (keep config + state)
#     gnk_watchdog_status                 show cron state + last decision per net
#
# Conventions: sourced lib → NO shebang / NO `set -e`. Reuses Script 03's
# `grin_autostart_<net>` crontab comment tag, so 03 and 07 are two front-doors to
# the SAME single @reboot entry (add is grep-by-tag → replace, never append).
#
# Why "process running" is NOT enough: a stuck grin keeps its port bound and PID
# alive but its tip stops advancing. Health is judged by height progress + an
# EXTERNAL reference, never by PID/port alone. External fetch FAILURE never
# triggers a restart (that is the external's problem) — it only ever CONFIRMS a
# locally-suspected stall.
# =============================================================================

[[ -n "${_GRIN_NODE_KEEPALIVE_SH_LOADED:-}" ]] && return 0
_GRIN_NODE_KEEPALIVE_SH_LOADED=1

# Locate + source the control primitives (sibling lib).
_GNK_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GNK_CONTROL_LIB="${GNK_CONTROL_LIB:-$_GNK_LIB_DIR/grin_node_control.sh}"
# shellcheck source=grin_node_control.sh
source "$GNK_CONTROL_LIB"

# ─── Paths / constants (env-overridable for testing) ────────────────────────
GNK_WATCHDOG_BIN="${GNK_WATCHDOG_BIN:-/usr/local/bin/grin-node-sync-watchdog}"
GNK_WATCHDOG_CRON="${GNK_WATCHDOG_CRON:-/etc/cron.d/grin-node-sync-watchdog}"
GNK_WATCHDOG_CONF="${GNK_WATCHDOG_CONF:-/opt/grin/conf/grin_node_watchdog.json}"
GNK_STATE_DIR="${GNK_STATE_DIR:-/opt/grin/solo-stats}"
GNK_WATCHDOG_LOG="${GNK_WATCHDOG_LOG:-/opt/grin/logs/node-watchdog.log}"

# Crontab comment tags — MUST match Script 03 (interoperable single entry).
GNK_AUTOSTART_TAG_MAIN="# grin-node-toolkit: grin_autostart_mainnet"
GNK_AUTOSTART_TAG_TEST="# grin-node-toolkit: grin_autostart_testnet"

_gnk_autostart_tag() {
    [[ "${1:-}" == "testnet" ]] && echo "$GNK_AUTOSTART_TAG_TEST" || echo "$GNK_AUTOSTART_TAG_MAIN"
}

# =============================================================================
# REBOOT AUTOSTART  (root user crontab, tag-guarded, idempotent)
# =============================================================================

# gnk_autostart_status  → one line, [OK]/[--] per net (matches the success() [OK] style).
gnk_autostart_status() {
    local cron; cron=$(crontab -l 2>/dev/null || true)
    local net tag label out=""
    for net in mainnet testnet; do
        tag=$(_gnk_autostart_tag "$net")
        label="Mainnet"; [[ "$net" == "testnet" ]] && label="Testnet"
        if echo "$cron" | grep -qF "$tag"; then
            out+="${GREEN:-}[OK]${RESET:-} ${label}    "
        else
            out+="${DIM:-}[--] ${label}${RESET:-}    "
        fi
    done
    echo -e "${out%    }"
}

# gnk_autostart_enable <network> [delay=20]
# Resolves the node dir CONF-ONLY, then writes/replaces ONE tagged @reboot line.
gnk_autostart_enable() {
    local net="${1:-mainnet}" delay="${2:-20}"
    [[ "$delay" =~ ^[0-9]+$ ]] || delay=20

    local dir binary sess tag line cron
    dir=$(gnc_resolve_node_dir "$net") || {
        error "No $net node in $GNC_INSTANCES_CONF — cannot enable autostart (conf-only)."
        return 1
    }
    binary=$(gnc_node_binary "$dir") || {
        error "No executable grin binary at $dir/grin — cannot enable autostart."
        return 1
    }
    sess=$(_grin_session_name "$dir")
    tag=$(_gnk_autostart_tag "$net")

    # Same shape as Script 03's line (so both scripts recognise it), but with the
    # conf-resolved dir + canonical (underscore) session name.
    # Runs as the grin user via su (same contract as Script 01 / gnc_start_node_tmux):
    #  - chown first reclaims any root-owned leftovers from an earlier root-run start.
    #  - HOME=$dir gives grin a writable home (it creates .grin/<chain> even with a cwd
    #    config); without it grin EACCES-panics on the root-owned /opt/grin/.grin.
    #  - SHELL=/bin/bash is mandatory for cron-launched tmux (cron sets SHELL=/bin/sh).
    line="@reboot sleep $delay && chown -R grin:grin '$dir' 2>/dev/null; su -s /bin/bash grin -c \"cd '$dir' && env HOME='$dir' SHELL=/bin/bash tmux new-session -d -s $sess '$binary server run'\" $tag"

    cron=$(crontab -l 2>/dev/null || true)
    if echo "$cron" | grep -qF "$tag"; then
        cron=$(echo "$cron" | grep -vF "$tag" || true)
        info "Replacing existing $net autostart entry."
    else
        info "Adding $net autostart entry."
    fi
    { echo "$cron"; echo "$line"; } | grep -v '^[[:space:]]*$' | crontab -
    success "$net autostart enabled (delay ${delay}s, session $sess)."
}

# gnk_autostart_disable <network|all>
gnk_autostart_disable() {
    local scope="${1:-all}" cron tag net
    cron=$(crontab -l 2>/dev/null || true)
    [[ -z "$cron" ]] && { info "Crontab is empty — nothing to disable."; return 0; }

    local nets=()
    case "$scope" in
        mainnet) nets=(mainnet) ;;
        testnet) nets=(testnet) ;;
        *)       nets=(mainnet testnet) ;;
    esac
    for net in "${nets[@]}"; do
        tag=$(_gnk_autostart_tag "$net")
        cron=$(echo "$cron" | grep -vF "$tag" || true)
    done
    echo "$cron" | grep -v '^[[:space:]]*$' | crontab - 2>/dev/null || crontab -r 2>/dev/null || true
    success "Autostart disabled for: ${nets[*]}"
}

# =============================================================================
# NODE-SYNC WATCHDOG
# =============================================================================

# Write a default config only if absent (never clobber operator edits).
# external_refs = third-party height sources. Two forms (mix freely):
#   (1) REST URL string            → GET; height AUTO-DETECTED from common keys
#                                     (height / last_block_height / header.height
#                                      / tip.height / result.Ok.(tip.)height …)
#   (2) {"url":"…","height_path":"a.b.c"}  → GET + pin the exact JSON field
#                                            (height_path also accepts list
#                                             indices, e.g. blocks.0.height)
#   A URL ending in /v2/foreign uses JSON-RPC get_tip (POST) instead of GET.
# VERIFY-LIVE on the VPS. NEVER list the operator's OWN endpoint
# (api.grin.money / testapi.grin.money) — that is circular.
_gnk_write_default_conf() {
    [[ -f "$GNK_WATCHDOG_CONF" ]] && return 0
    mkdir -p "$(dirname "$GNK_WATCHDOG_CONF")"
    cat > "$GNK_WATCHDOG_CONF" <<'JSON'
{
  "_comment": "external_refs: third-party height sources. String = REST GET (height auto-detected). Object {url,height_path} = REST GET pinning a JSON field. URL ending /v2/foreign = JSON-RPC get_tip (POST). Watchdog takes the MAX over reachable refs; an unreachable ref is ignored (never triggers a restart). REPLACE any ref that resolves to the SAME node this watchdog manages (circular).",
  "enabled": { "mainnet": true, "testnet": false },
  "tolerance_blocks": 10,
  "stuck_checks": 2,
  "cooldown_min": 20,
  "post_restart_grace_min": 20,
  "external_refs": {
    "mainnet": [
      { "url": "https://api.grin.money/rest/height.json", "height_path": "height" },
      { "url": "https://grinnode.live:8080/api/blockstats", "height_path": "blockHeight" }
    ],
    "testnet": [
      "https://test.gri.mw/v2/foreign",
      "https://testnet.grincoin.org/v2/foreign"
    ]
  }
}
JSON
    chmod 644 "$GNK_WATCHDOG_CONF"
    info "Wrote default watchdog config: $GNK_WATCHDOG_CONF"
    warn "VERIFY external_refs are reachable third-party height endpoints (see _comment)."
}

# Generate the standalone watchdog executable. It sources control.sh by the
# absolute path baked in at install time (DRY: reuses the same primitives), and
# implements the per-network decision logic with an anti-flap state file.
_gnk_write_watchdog_bin() {
    mkdir -p "$(dirname "$GNK_WATCHDOG_BIN")"

    # Line 1: header + baked control-lib path (expanded). Body: literal heredoc.
    cat > "$GNK_WATCHDOG_BIN" <<EOF
#!/bin/bash
# grin-node-sync-watchdog — GENERATED by grin_node_keepalive.sh. Do not edit;
# re-run Script 07 → Health/Watchdogs → Node-sync to regenerate.
CONTROL_LIB="$GNK_CONTROL_LIB"
WATCHDOG_CONF="$GNK_WATCHDOG_CONF"
STATE_DIR="$GNK_STATE_DIR"
LOG_FILE="$GNK_WATCHDOG_LOG"
EOF

    cat >> "$GNK_WATCHDOG_BIN" <<'EOF'
set -uo pipefail
[[ -f "$CONTROL_LIB" ]] || { echo "control lib missing: $CONTROL_LIB" >&2; exit 1; }
# shellcheck source=/dev/null
source "$CONTROL_LIB"

mkdir -p "$STATE_DIR" "$(dirname "$LOG_FILE")" 2>/dev/null || true

wlog() { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }

# ── config readers (python3; tolerate missing file → defaults) ───────────────
cfg_scalar() { # <dotted.path> <default>
    CFG_FILE="$WATCHDOG_CONF" CFG_PATH="$1" CFG_DEF="$2" python3 - <<'PY' 2>/dev/null || echo "$2"
import json, os, sys
try:
    d = json.load(open(os.environ["CFG_FILE"]))
except Exception:
    print(os.environ["CFG_DEF"]); sys.exit(0)
node = d
for k in os.environ["CFG_PATH"].split("."):
    if isinstance(node, dict) and k in node: node = node[k]
    else: print(os.environ["CFG_DEF"]); sys.exit(0)
print(node if node is not None else os.environ["CFG_DEF"])
PY
}
cfg_refs() { # <network> → one "url<TAB>height_path" per line (height_path may be empty)
    CFG_FILE="$WATCHDOG_CONF" CFG_NET="$1" python3 - <<'PY' 2>/dev/null || true
import json, os
try:
    d = json.load(open(os.environ["CFG_FILE"]))
except Exception:
    raise SystemExit
for u in (d.get("external_refs", {}).get(os.environ["CFG_NET"], []) or []):
    if isinstance(u, dict):
        url = u.get("url", ""); hp = u.get("height_path", "") or ""
    else:
        url = str(u); hp = ""
    if url:
        print(url + "\t" + hp)
PY
}

# ── anti-flap state (per-net JSON) ───────────────────────────────────────────
_state_file() { echo "$STATE_DIR/node_watchdog_$1.json"; }
state_get() { # <network> <key> <default>
    local f; f=$(_state_file "$1")
    SF="$f" SK="$2" SD="$3" python3 - <<'PY' 2>/dev/null || echo "$3"
import json, os, sys
try:
    d = json.load(open(os.environ["SF"]))
except Exception:
    print(os.environ["SD"]); sys.exit(0)
print(d.get(os.environ["SK"], os.environ["SD"]))
PY
}
state_set() { # <network> <key=val> ...
    local net="$1"; shift
    local f; f=$(_state_file "$net")
    SF="$f" SKV="$*" python3 - <<'PY' 2>/dev/null || true
import json, os, sys
f = os.environ["SF"]
try:
    d = json.load(open(f))
    if not isinstance(d, dict): d = {}
except Exception:
    d = {}
for pair in os.environ["SKV"].split():
    if "=" in pair:
        k, v = pair.split("=", 1)
        d[k] = v
json.dump(d, open(f, "w"))
PY
}

# ── external reference: max reachable height across refs (0 if none reachable) ─
# REST URL → GET; URL ending /v2/foreign → JSON-RPC get_tip (POST). Height is
# taken from height_path when given, else auto-detected from common JSON keys.
ext_max_height() { # <network>
    local net="$1" url hp best="" h resp
    while IFS=$'\t' read -r url hp; do
        [[ -n "$url" ]] || continue
        if [[ "$url" == */v2/foreign ]]; then
            resp=$(curl -s --max-time 8 -X POST -H 'Content-Type: application/json' \
                     -d '{"jsonrpc":"2.0","method":"get_tip","params":[],"id":1}' \
                     "$url" 2>/dev/null)
        else
            resp=$(curl -s --max-time 8 "$url" 2>/dev/null)
        fi
        [[ -n "$resp" ]] || continue
        h=$(printf '%s' "$resp" | EXT_HP="${hp:-}" python3 -c '
import json, os, sys
try: d = json.load(sys.stdin)
except Exception: sys.exit(1)
def dig(obj, path):
    cur = obj
    for k in path.split("."):
        if k == "": return None
        if isinstance(cur, list):
            try: cur = cur[int(k)]
            except Exception: return None
        elif isinstance(cur, dict) and k in cur:
            cur = cur[k]
        else:
            return None
    return cur
def as_int(v):
    if isinstance(v, bool): return None
    if isinstance(v, int): return v
    if isinstance(v, str) and v.isdigit(): return int(v)
    return None
cands = []
hp = os.environ.get("EXT_HP", "").strip()
if hp: cands.append(hp)
cands += ["height", "blockHeight", "last_block_height", "header.height",
          "tip.height", "result.Ok.height", "result.Ok.tip.height",
          "result.height", "result.tip.height", "chain.height", "blocks.0.height"]
val = None
for c in cands:
    v = dig(d, c)
    n = as_int(v)
    if n is None and isinstance(v, dict) and "height" in v:
        n = as_int(v["height"])
    if n is not None:
        val = n; break
if val is None: sys.exit(1)
print(val)' 2>/dev/null) || continue
        [[ "$h" =~ ^[0-9]+$ ]] || continue
        if [[ -z "$best" || "$h" -gt "$best" ]]; then best="$h"; fi
    done < <(cfg_refs "$net")
    echo "${best:-0}"
}

# ── restart with cooldown ────────────────────────────────────────────────────
do_restart() { # <network> <reason>
    local net="$1" reason="$2" now cooldown_min last_restart
    now=$(date -u +%s)
    cooldown_min=$(cfg_scalar cooldown_min 20)
    last_restart=$(state_get "$net" last_restart_ts 0)
    [[ "$last_restart" =~ ^[0-9]+$ ]] || last_restart=0
    if (( now - last_restart < cooldown_min * 60 )); then
        wlog "$net WOULD-RESTART ($reason) but in cooldown (${cooldown_min}m); skipping."
        return 0
    fi
    wlog "$net RESTART ($reason)"
    if gnc_start_node_tmux "$net" 120 >>"$LOG_FILE" 2>&1; then
        wlog "$net restart OK."
    else
        wlog "$net restart FAILED — check tmux."
    fi
    state_set "$net" "last_restart_ts=$now" "stuck_count=0"
}

# ── per-network check ────────────────────────────────────────────────────────
check_net() {
    local net="$1"
    [[ "$(cfg_scalar "enabled.$net" false)" == "True" || "$(cfg_scalar "enabled.$net" false)" == "true" ]] || return 0
    gnc_resolve_node_dir "$net" >/dev/null 2>&1 || { wlog "$net not in instances conf — skipping."; return 0; }

    local now grace_min last_restart
    now=$(date -u +%s)
    grace_min=$(cfg_scalar post_restart_grace_min 20)
    last_restart=$(state_get "$net" last_restart_ts 0)
    [[ "$last_restart" =~ ^[0-9]+$ ]] || last_restart=0
    local in_grace=0
    (( now - last_restart < grace_min * 60 )) && in_grace=1

    local port pid status
    port=$(gnc_node_api_port "$net")
    pid=$(gnc_get_pid_on_port "$port" 2>/dev/null || true)
    status=$(gnc_owner_get_status "$net" 8 || true)

    # Signal a/b: hard down or unresponsive → restart (cooldown still applies).
    if [[ -z "$pid" || -z "$status" ]]; then
        do_restart "$net" "node down/unresponsive (pid='${pid:-none}' status=$([[ -n "$status" ]] && echo ok || echo empty))"
        return 0
    fi

    local local_h sync last_h advancing=0
    local_h=$(gnc_status_field "$status" tip.height 2>/dev/null || echo "")
    sync=$(gnc_status_field "$status" sync_status 2>/dev/null || echo "")
    [[ "$local_h" =~ ^[0-9]+$ ]] || { wlog "$net get_status had no tip.height — treating as unresponsive."; do_restart "$net" "no tip.height in get_status"; return 0; }

    last_h=$(state_get "$net" last_height 0)
    [[ "$last_h" =~ ^[0-9]+$ ]] || last_h=0
    (( local_h > last_h )) && advancing=1

    # Record current height/ts for the next run regardless of outcome.
    state_set "$net" "last_height=$local_h" "last_height_ts=$now"

    if (( in_grace )); then
        wlog "$net post-restart grace (h=$local_h sync=$sync) — stuck detection skipped."
        state_set "$net" "stuck_count=0"
        return 0
    fi

    # Catching up AND advancing → legitimate sync, OK.
    if [[ "$sync" != "no_sync" && -n "$sync" ]] && (( advancing )); then
        wlog "$net catching up & advancing (h=$local_h sync=$sync) — OK."
        state_set "$net" "stuck_count=0"
        return 0
    fi

    # External confirmation of a stall (CONFIRMING signal, never sole trigger).
    local tol stuck_need ref stuck
    tol=$(cfg_scalar tolerance_blocks 10)
    stuck_need=$(cfg_scalar stuck_checks 2)
    ref=$(ext_max_height "$net")
    [[ "$ref" =~ ^[0-9]+$ ]] || ref=0

    if (( ref > 0 )) && (( ref - local_h > tol )) && (( advancing == 0 )); then
        stuck=$(state_get "$net" stuck_count 0)
        [[ "$stuck" =~ ^[0-9]+$ ]] || stuck=0
        stuck=$(( stuck + 1 ))
        state_set "$net" "stuck_count=$stuck"
        if (( stuck >= stuck_need )); then
            do_restart "$net" "wedged: local=$local_h ext=$ref tol=$tol not-advancing x$stuck"
        else
            wlog "$net suspected stall (local=$local_h ext=$ref) — stuck_count=$stuck/$stuck_need, waiting."
        fi
        return 0
    fi

    # Either advancing, within tolerance, or external unreachable → OK.
    if (( ref == 0 )); then
        wlog "$net OK-ish (h=$local_h, external refs unreachable — no restart on fetch failure)."
    else
        wlog "$net OK (local=$local_h ext=$ref advancing=$advancing sync=${sync:-?})."
    fi
    state_set "$net" "stuck_count=0"
}

for net in mainnet testnet; do
    check_net "$net"
done
exit 0
EOF
    chmod 750 "$GNK_WATCHDOG_BIN"
    info "Wrote watchdog: $GNK_WATCHDOG_BIN"
}

_gnk_write_watchdog_cron() {
    cat > "$GNK_WATCHDOG_CRON" <<EOF
# grin-node-toolkit: node-sync watchdog (every 5 min). SHELL set for tmux-in-cron.
SHELL=/bin/bash
*/5 * * * * root $GNK_WATCHDOG_BIN >/dev/null 2>&1
EOF
    chmod 644 "$GNK_WATCHDOG_CRON"
    info "Installed cron: $GNK_WATCHDOG_CRON (*/5)"
}

# gnk_watchdog_install — config (if absent) + watchdog bin + cron.d entry.
gnk_watchdog_install() {
    mkdir -p "$GNK_STATE_DIR" "$(dirname "$GNK_WATCHDOG_LOG")" 2>/dev/null || true
    _gnk_write_default_conf
    _gnk_write_watchdog_bin
    _gnk_write_watchdog_cron
    success "Node-sync watchdog installed. Edit $GNK_WATCHDOG_CONF to tune/enable nets."
}

# gnk_watchdog_remove — remove bin + cron.d (keep config + state for re-enable).
gnk_watchdog_remove() {
    rm -f "$GNK_WATCHDOG_CRON" "$GNK_WATCHDOG_BIN"
    success "Node-sync watchdog removed (config + state kept: $GNK_WATCHDOG_CONF)."
}

# gnk_watchdog_status — cron presence + last decision per net.
gnk_watchdog_status() {
    if [[ -f "$GNK_WATCHDOG_CRON" && -x "$GNK_WATCHDOG_BIN" ]]; then
        success "Node-sync watchdog: INSTALLED (cron $GNK_WATCHDOG_CRON)"
    else
        warn "Node-sync watchdog: NOT installed."
    fi
    [[ -f "$GNK_WATCHDOG_CONF" ]] && info "Config: $GNK_WATCHDOG_CONF"
    local net sf
    for net in mainnet testnet; do
        sf="$GNK_STATE_DIR/node_watchdog_$net.json"
        [[ -f "$sf" ]] && info "$net state: $(cat "$sf" 2>/dev/null)"
    done
    [[ -f "$GNK_WATCHDOG_LOG" ]] && {
        info "Last log lines ($GNK_WATCHDOG_LOG):"
        tail -n 6 "$GNK_WATCHDOG_LOG" 2>/dev/null || true
    }
}
