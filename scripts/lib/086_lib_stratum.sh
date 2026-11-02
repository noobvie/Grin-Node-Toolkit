# =============================================================================
# lib/086_lib_stratum.sh — mining / stratum latency probes for 086 (key 8)
# =============================================================================
# Sourced by 086_grin_diagnostics.sh after 086_lib_diag.sh. It holds the shared
# state and helpers, so it comes BEFORE the two files that depend on it; the
# fixed order is 086_lib_stratum.sh, _stack.sh, _baseline.sh. Sourced, not
# executed — no shebang, no `set -e`. Every function here is reached through a
# `fn || true` menu arm, so errexit is OFF for the whole body: each command that
# creates or deletes a file carries its own guard.
#
# WHAT IT ANSWERS (086 design §10)
#   How long this node takes to hand miners a job for a new tip, and where that
#   time goes. The pool's stale badge and Solo Health show the symptom; these
#   functions time the cause.
#
#   dgs_probe_prepare / dgs_probe_run   black-box probe (§10.2): connects to
#                                       the node's stratum port as a miner,
#                                       polls the tip, times tip → first job.
#                                       Works at any file_log_level.
#   dgs_build_log                       build timing from DEBUG lines (§10.3)
#   dgs_rejects                         node-side rejects per hour (§10.4)
#   dgs_threads / dgs_thread_*          per-thread CPU from /proc (§10.5);
#                                       dgs_probe_run also takes one pair
#                                       across a new tip and one idle pair
#
#   In 086_lib_stratum_stack.sh:        dgs_stack_capture, the ask-first stack
#                                       capture of the stratum thread (§10.6)
#   In 086_lib_stratum_baseline.sh:     dgs_binary_fingerprint, dgs_baseline_*,
#                                       dgs_save_screen, dgs_quick_baseline —
#                                       baseline JSON, screen copy and the A/B
#                                       compare data (§10.7)
#
#   Each function leaves its result in $DG_TMP (files listed at the function)
#   and in DGS_* variables, so the key 8 screen and the support bundle print
#   the same numbers.
#
# READ-ONLY. The probe never submits a share and never asks for `status`. Its
# only node-side effects are one extra stratum connection and, on a node with
# no other stratum client, template builds while it is connected — which is
# why dgs_gate exists (§10.2.4). The stack capture pauses the node while a
# debugger is attached, only after a typed y; the one signal this file ever
# sends is a single SIGCONT when a capture left the node stopped (§10.6).
#
# PRIVACY. The owner secret's PATH goes to the python helper in argv; the
# helper reads the value and hands it to curl on stdin (`-K -`), so it is never
# in `ps`. Nothing saved keeps pre_pow, nonces or proofs.
#
# AWK. Debian's default awk is mawk: no mktime, no gensub, no 3-arg match, no
# {n} intervals. Dates are turned into day numbers with integer arithmetic.
# =============================================================================

[[ -n "${_DGS_LIB_LOADED:-}" ]] && return 0
_DGS_LIB_LOADED=1

# dg_tv, dg_secret_path and dg_log_* live there; 086 sources it first, a test
# harness may not.
if ! declare -F dg_tv >/dev/null 2>&1; then
    # shellcheck source=086_lib_diag.sh
    source "$(dirname "${BASH_SOURCE[0]}")/086_lib_diag.sh"
fi

# ─── State ────────────────────────────────────────────────────────────────────
# Set by dgs_probe_prepare (and its parts). Read by dgs_probe_run and the screen.
DGS_PID=""; DGS_DIR=""; DGS_NET=""; DGS_API_HOST=""; DGS_API_PORT=""
DGS_PID_LIST=""                # exe-matched pids for DGS_DIR, space separated
DGS_TOML=""
DGS_ENABLED=""                 # enable_stratum_server as written in the toml
DGS_ADDR=""                    # stratum_server_addr as written in the toml
DGS_HOST=""; DGS_PORT=""       # the address the probe dials
DGS_PORT_WARN=""               # non-empty: the port is the OTHER network's
DGS_ATTEMPT=15                 # attempt_time_per_block
DGS_LOG_LEVEL=""               # file_log_level
DGS_WALLET_URL=""; DGS_BURN=""
DGS_CFG=""                     # ok|disabled|addr_missing|addr_bad|addr_nonlocal
DGS_LISTEN=""                  # yes|no|unknown
DGS_SECRET_PATH=""; DGS_FSECRET_PATH=""
DGS_PREP=""                    # ok|pid_mismatch|<DGS_CFG>|not_listening|no_python|no_curl
# Gate (§10.2.4)
DGS_GATE=""                    # run|ask|refuse
DGS_GATE_OTHERS=""             # established clients on the stratum port, or "unknown"
DGS_WALLET_HOST=""; DGS_WALLET_PORT=""
DGS_WALLET_STATE=""            # n/a|listening|refused|timeout|nonlocal|unset|burn
# Probe result
DGS_PROBE_STATUS=""; DGS_PROBE_ERR=""
declare -gA DGS_P=()           # probe key=value result (dgs_probe_load)
declare -gA DGS_B=()           # build-log key=value result
declare -gA DGS_R=()           # rejects key=value result
DGS_PSI_CPU60=""               # /proc/pressure/cpu some avg60 when the probe ended
# Thread CPU (§10.5): the pair across a new tip, the idle pair, a standalone pair
declare -gA DGS_CT=() DGS_CI=() DGS_C=()
declare -gA DGS_K=()           # stack capture result (§10.6)
declare -gA DGS_BIN=()         # binary fingerprint (§10.7)
declare -gA DGS_QB=()          # newest baseline for the running binary (key 1)
declare -gA DGS_CMP=()         # compare header: the two runs and their flags
DGS_BL_DEFAULT_A=""; DGS_BL_DEFAULT_B=""; DGS_BL_COUNT=0
DGS_BL_STATUS=""; DGS_BL_FILE=""; DGS_SCREEN_FILE=""
DGS_STAMP=""                   # UTC stamp shared by one run's .txt and .json

# /proc root for every READ in this file. Assigned here and never taken from
# the environment, so only code that sources this file and then reassigns it
# (a fixture test) can point it elsewhere. Signals and debugger attaches always
# use the real pid.
_DGS_PROC=/proc
_DGS_STACK_ACTIVE=0; _DGS_STACK_INT=""; _DGS_CONT_SENT=0
_DGS_PROBE_PID=""; _DGS_WATCH_PID=""   # live probe helper and CPU sampler

DGS_LOGIN="toolkit-086-latency-probe"

# ─── Small helpers ────────────────────────────────────────────────────────────
_dgs_need_tmp() {
    [[ -n "${DG_TMP:-}" && -d "$DG_TMP" && -w "$DG_TMP" ]] && return 0
    error "086 scratch dir is missing (DG_TMP)."
    return 1
}

_dgs_rm() {   # <file>... — remove, loudly on failure
    local f
    for f in "$@"; do
        [[ -e "$f" ]] || continue
        rm -f "$f" || { error "Cannot remove $f"; return 1; }
    done
    return 0
}

_dgs_is_loopback() {
    case "${1:-}" in
        127.*|::1|localhost) return 0 ;;
    esac
    return 1
}

# A loopback address, or one assigned to an interface on this box. The probe
# never dials anything else (§10.2.1).
_dgs_is_local() {
    local h=${1:-}
    [[ -n "$h" ]] || return 1
    _dgs_is_loopback "$h" && return 0
    dg_have ip || return 1
    ip -o addr show 2>/dev/null | awk '{ split($4, a, "/"); print a[1] }' | grep -qxF "$h"
}

_dgs_toolkit_version() {
    local v=""
    [[ -n "${TOOLKIT_ROOT:-}" ]] \
        && v=$(grep -oE 'Grin Node Toolkit v[0-9.]+' "$TOOLKIT_ROOT/grin-node-toolkit.sh" 2>/dev/null | head -1 || true)
    v=${v##* }
    printf '%s' "${v:-unknown}"
}

# TCP connect with a 3 s bound. rc 0 open · 124 no answer · other refused.
_dgs_tcp_open() {   # <host> <port>
    timeout 3 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$1" "$2" 2>/dev/null
}

# Reads a key=value file into the named associative array.
_dgs_load_kv() {   # <file> <array-name>
    local f=$1 k v
    local -n _dgs_kv=$2
    _dgs_kv=()
    [[ -r "$f" ]] || return 1
    while IFS='=' read -r k v; do
        [[ -n "$k" ]] && _dgs_kv[$k]=$v
    done < "$f"
    return 0
}

# Restores a trap saved with `trap -p SIG`; an empty save means "default".
_dgs_restore_trap() {   # <saved> <SIG>
    if [[ -n "$1" ]]; then eval "$1"; else trap - "$2"; fi
}
_dgs_report_dir() {
    [[ -n "${REPORT_DIR:-}" ]] || { error "REPORT_DIR is not set."; return 1; }
    if [[ ! -d "$REPORT_DIR" ]]; then
        mkdir -p "$REPORT_DIR" || { error "Cannot create $REPORT_DIR"; return 1; }
    fi
    chmod 700 "$REPORT_DIR" || { error "Cannot set mode 700 on $REPORT_DIR"; return 1; }
    return 0
}

# Copies <src> to <dest> as mode 600 through a temp name in the same dir.
_dgs_install_private() {   # <src> <dest>
    local src=$1 dst=$2 tmp="$2.tmp.$$"
    [[ -d "$dst" ]] && { error "$dst is a directory."; return 1; }
    ( umask 077 && cp -- "$src" "$tmp" ) || { error "Cannot write $tmp"; return 1; }
    chmod 600 "$tmp" || { error "Cannot set mode 600 on $tmp"; rm -f "$tmp"; return 1; }
    mv -f -- "$tmp" "$dst" || { error "Cannot move $tmp to $dst"; rm -f "$tmp"; return 1; }
    return 0
}


# ─── §10.2.1  Which node, which address ──────────────────────────────────────
# The pid must be the ONLY exe-matched grin for the dir: a cwd/argv match can
# select the tmux server or the other network's node.
dgs_check_pid() {   # <pid> <dir>
    local pid=$1 dir=$2
    DGS_PID_LIST=$(gnc_grin_pids_for_dir "$dir" | tr '\n' ' ')
    DGS_PID_LIST=${DGS_PID_LIST% }
    [[ "$DGS_PID_LIST" == "$pid" ]]
}

# Reads the stratum keys from <dir>/grin-server.toml. rc 0 when there is an
# address to dial; otherwise DGS_CFG names why not.
dgs_stratum_config() {   # <dir> <net>
    local dir=$1 net=$2 host port other
    DGS_TOML="$dir/grin-server.toml"
    DGS_ENABLED=$(dg_tv "$DGS_TOML" enable_stratum_server)
    DGS_ADDR=$(dg_tv "$DGS_TOML" stratum_server_addr)
    DGS_ATTEMPT=$(dg_tv "$DGS_TOML" attempt_time_per_block)
    [[ "$DGS_ATTEMPT" =~ ^[0-9]+$ ]] || DGS_ATTEMPT=15
    DGS_LOG_LEVEL=$(dg_tv "$DGS_TOML" file_log_level)
    DGS_WALLET_URL=$(dg_tv "$DGS_TOML" wallet_listener_url)
    DGS_BURN=$(dg_tv "$DGS_TOML" burn_reward)
    DGS_HOST=""; DGS_PORT=""; DGS_PORT_WARN=""

    # grin starts the stratum server only for Some(true).
    if [[ "$DGS_ENABLED" != "true" ]]; then DGS_CFG=disabled; return 1; fi
    # No serde default: a missing address panics the stratum thread at start.
    if [[ -z "$DGS_ADDR" ]]; then DGS_CFG=addr_missing; return 1; fi
    host=${DGS_ADDR%:*}; port=${DGS_ADDR##*:}
    host=${host#\[}; host=${host%\]}
    if [[ ! "$port" =~ ^[0-9]+$ ]] || [[ "$host" == "$DGS_ADDR" ]]; then DGS_CFG=addr_bad; return 1; fi
    case "$host" in 0.0.0.0|::|localhost) host=127.0.0.1 ;; esac
    if ! _dgs_is_local "$host"; then DGS_CFG=addr_nonlocal; return 1; fi
    other=13416; [[ "$net" == testnet ]] && other=3416
    if [[ "$port" == "$other" ]]; then
        DGS_PORT_WARN="port $port is the other network's stratum port"
    fi
    DGS_HOST=$host; DGS_PORT=$port; DGS_CFG=ok
    return 0
}

# yes|no|unknown — enabled in the toml but not listening means the node has
# not restarted since, or the bind failed (grin panics on a failed bind).
dgs_stratum_listening() {   # <port>
    if ! dg_have ss; then DGS_LISTEN=unknown; return 0; fi
    if ss -tln "( sport = :$1 )" 2>/dev/null | tail -n +2 | grep -q .; then
        DGS_LISTEN=yes
    else
        DGS_LISTEN=no
    fi
    return 0
}

# ─── §10.2.4  The gate ───────────────────────────────────────────────────────
# With no other stratum client, the probe's own connection starts template
# builds, and each build asks the wallet listener for a coinbase. A dead
# listener makes the build retry every 5 s forever, holding the state lock,
# and that outlives the probe. So: refuse when the listener is dead, ask when
# it cannot be proven alive. Sets DGS_GATE run|ask|refuse.
dgs_gate() {   # <stratum-port> <wallet_listener_url> <burn_reward>
    local port=$1 url=$2 burn=$3 hp rc
    DGS_GATE=""; DGS_WALLET_HOST=""; DGS_WALLET_PORT=""; DGS_WALLET_STATE="n/a"
    # LOCAL port only, so the pool's end of a same-host link is not counted.
    if dg_have ss; then
        DGS_GATE_OTHERS=$(ss -tn state established "( sport = :$port )" 2>/dev/null | tail -n +2 | wc -l)
        DGS_GATE_OTHERS=$(_dg_num "${DGS_GATE_OTHERS// /}")
    else
        DGS_GATE_OTHERS=unknown
    fi
    if [[ "$DGS_GATE_OTHERS" =~ ^[0-9]+$ ]] && (( DGS_GATE_OTHERS > 0 )); then
        DGS_GATE=run; return 0
    fi
    if [[ "$burn" == "true" ]]; then
        DGS_WALLET_STATE=burn; DGS_GATE=ask; return 0
    fi
    if [[ -z "$url" ]]; then
        DGS_WALLET_STATE=unset; DGS_GATE=ask; return 0
    fi
    hp=${url#*://}; hp=${hp%%/*}
    if [[ "$hp" == \[*\]* ]]; then
        DGS_WALLET_HOST=${hp#\[}; DGS_WALLET_HOST=${DGS_WALLET_HOST%%\]*}
        DGS_WALLET_PORT=${hp##*\]}; DGS_WALLET_PORT=${DGS_WALLET_PORT#:}
    elif [[ "$hp" == *:* ]]; then
        DGS_WALLET_HOST=${hp%:*}; DGS_WALLET_PORT=${hp##*:}
    else
        DGS_WALLET_HOST=$hp; DGS_WALLET_PORT=""
    fi
    if [[ -z "$DGS_WALLET_PORT" ]]; then
        DGS_WALLET_PORT=80; [[ "$url" == https://* ]] && DGS_WALLET_PORT=443
    fi
    if ! _dgs_is_loopback "$DGS_WALLET_HOST" || [[ ! "$DGS_WALLET_PORT" =~ ^[0-9]+$ ]]; then
        DGS_WALLET_STATE=nonlocal; DGS_GATE=ask; return 0
    fi
    _dgs_tcp_open "$DGS_WALLET_HOST" "$DGS_WALLET_PORT"; rc=$?
    case "$rc" in
        0)   DGS_WALLET_STATE=listening; DGS_GATE=ask ;;
        124) DGS_WALLET_STATE=timeout;   DGS_GATE=refuse ;;
        *)   DGS_WALLET_STATE=refused;   DGS_GATE=refuse ;;
    esac
    return 0
}

# Everything the probe needs, from ONE pid and its dir — nothing re-resolved by
# net name. rc 0 = ready; DGS_PREP names the reason otherwise. The gate verdict
# is in DGS_GATE and is enforced by dgs_probe_run.
dgs_probe_prepare() {   # <pid> <dir> <net> <api-host> <api-port>
    DGS_PID=$1; DGS_DIR=$2; DGS_NET=$3; DGS_API_HOST=$4; DGS_API_PORT=$5
    DGS_PREP=""; DGS_GATE=""; DGS_LISTEN=""
    if ! dgs_check_pid "$DGS_PID" "$DGS_DIR"; then DGS_PREP=pid_mismatch; return 1; fi
    if ! dgs_stratum_config "$DGS_DIR" "$DGS_NET"; then DGS_PREP=$DGS_CFG; return 1; fi
    dgs_stratum_listening "$DGS_PORT"
    if [[ "$DGS_LISTEN" == no ]]; then DGS_PREP=not_listening; return 1; fi
    if ! dg_have python3; then DGS_PREP=no_python; return 1; fi
    if ! dg_have curl; then DGS_PREP=no_curl; return 1; fi
    DGS_SECRET_PATH=$(dg_secret_path "$DGS_DIR" api_secret_path .api_secret "$DGS_NET" || true)
    DGS_FSECRET_PATH=$(dg_secret_path "$DGS_DIR" foreign_api_secret_path .foreign_api_secret "$DGS_NET" || true)
    dgs_gate "$DGS_PORT" "$DGS_WALLET_URL" "$DGS_BURN"
    DGS_PREP=ok
    return 0
}

# ─── §10.2.2  The probe helper (python3 -I) ──────────────────────────────────
# One select() loop waits on the stratum socket and on the in-flight curl at
# the same time, so a job line is stamped when the socket becomes readable,
# never late by the length of a get_status call.
IFS= read -r -d '' _DGS_PROBE_PY <<'PY' || true
import argparse, json, math, os, select, signal, socket, subprocess, sys, time
from datetime import datetime, timezone

LINE_CAP = 64 * 1024        # a job line is under 1 KiB
CONNECT_S = 3.0
LOGIN_S = 5.0
TICK_S = 0.1                # select() never sleeps longer than this
POLL_MAX_S = 2              # curl --max-time per poll
POLL_KILL_S = 4.0           # a curl still alive after this is killed
NO_JOB_S = 120.0
WIDE_S = 2.0
KEEPALIVE_S = 60.0
KEEPALIVE_WAIT_S = 30.0
MAX_POLL_FAILS = 10         # consecutive failed polls end the run
HARD_CAP_S = 30 * 60

STOP_REQ = []               # set from the signal handler


def on_signal(signum, frame):
    STOP_REQ.append("interrupted")


def clock():
    return time.monotonic(), time.time()


def utc_hms(w):
    d = datetime.fromtimestamp(w, timezone.utc)
    return d.strftime("%H:%M:%S.") + str(d.microsecond // 100000)


def utc_iso(w):
    d = datetime.fromtimestamp(w, timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (d.microsecond // 1000)


def pct(vals, p):
    if not vals:
        return None
    s = sorted(vals)
    i = max(0, int(math.ceil(p * len(s))) - 1)
    return s[min(i, len(s) - 1)]


def rnd(v, n=2):
    return None if v is None else round(v, n)


def curl_cfg(secret):
    if not secret:
        return b""
    esc = secret.replace("\\", "\\\\").replace('"', '\\"')
    return ('user = "grin:%s"\n' % esc).encode()


def unwrap_ok(raw):
    try:
        d = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        return None
    r = d.get("result") if isinstance(d, dict) else None
    if isinstance(r, dict) and "Ok" in r:
        return r["Ok"]
    return None


def read_secret(path):
    if not path:
        return ""
    with open(path, "r") as f:
        return "".join(f.read().split())


class Fatal(Exception):
    def __init__(self, status, msg):
        Exception.__init__(self, msg)
        self.status = status
        self.msg = msg


class Probe(object):
    def __init__(self, a):
        self.a = a
        self.cfg = curl_cfg(read_secret(a.secret_file))
        self.fcfg = curl_cfg(read_secret(a.foreign_secret_file)) if a.foreign_secret_file else b""
        self.sock = None
        self.buf = b""
        self.poll = None
        self.next_poll = 0.0
        self.poll_s = a.poll_ms / 1000.0
        self.polls = 0
        self.poll_fail = 0
        self.consec_fail = 0
        self.poll_skipped = 0
        self.poll_lat = []
        self.base = None          # first successful get_status
        self.cur_hash = None
        self.cur_height = None
        self.t_old_send = None    # send time of the last poll that returned cur_hash
        self.user_agent = ""
        self.sync_status = ""
        self.rows = []
        self.j0 = []              # unclaimed job_id == 0 arrivals
        self.last_job = None
        self.refresh_gaps = []
        self.match = 0
        self.mismatch = 0
        self.nojob_streak = 0
        self.login_ok = None
        self.login_err = ""
        self.api_err = ""
        self.api_auth = False
        self.stratum_err = ""
        self.ka_sent = None
        self.last_ka = 0.0
        self.msg_id = 10
        self.status = None
        self.reason = ""
        self.t0_m, self.t0_w = clock()
        self.end_w = None

    # ── stratum ───────────────────────────────────────────────────────────
    def send(self, obj):
        try:
            self.sock.sendall((json.dumps(obj, separators=(",", ":")) + "\n").encode())
        except OSError as e:     # socket.timeout is an OSError too
            raise Fatal("stratum_lost", "stratum write failed: %s" % (e.strerror or "timed out"))

    def connect(self):
        try:
            s = socket.create_connection((self.a.host, self.a.port), timeout=CONNECT_S)
        except socket.timeout:
            self.stratum_err = "no answer within %d s" % CONNECT_S
            return False
        except ConnectionRefusedError:
            self.stratum_err = "refused the connection"
            return False
        except OSError as e:
            self.stratum_err = "connect failed: %s" % e.strerror
            return False
        s.settimeout(2.0)     # bounds sendall; recv runs only after select()
        self.sock = s
        return True

    def on_line(self, line, t_m, t_w):
        try:
            m = json.loads(line.decode("utf-8", "replace"))
        except ValueError:
            raise Fatal("protocol", "a line from the stratum port is not JSON")
        if not isinstance(m, dict):
            raise Fatal("protocol", "a line from the stratum port is not a JSON object")
        method = m.get("method")
        if method == "job":
            p = m.get("params") or {}
            h, j = p.get("height"), p.get("job_id")
            if isinstance(h, int) and isinstance(j, int):
                self.on_job(h, j, t_m, t_w)
        elif method == "login":
            if m.get("result") == "ok":
                self.login_ok = True
            else:
                self.login_ok = False
                self.login_err = json.dumps(m.get("error"))[:120]
        elif method == "getjobtemplate":
            e = m.get("error")
            if isinstance(e, dict) and e.get("code") == -32000:
                raise Fatal("syncing", "the stratum server says the node is syncing")
        elif method == "keepalive":
            self.ka_sent = None

    def read_sock(self, t_m, t_w):
        try:
            data = self.sock.recv(65536)
        except socket.timeout:
            return
        except OSError as e:
            raise Fatal("stratum_lost", "stratum read failed: %s" % e.strerror)
        if not data:
            raise Fatal("stratum_lost", "the node closed the stratum connection")
        self.buf += data
        while True:
            i = self.buf.find(b"\n")
            if i < 0:
                break
            line, self.buf = self.buf[:i], self.buf[i + 1:]
            if len(line) > LINE_CAP:
                raise Fatal("protocol", "a stratum line is longer than 64 KiB")
            line = line.strip()
            if line:
                self.on_line(line, t_m, t_w)
        if len(self.buf) > LINE_CAP:
            raise Fatal("protocol", "a stratum line is longer than 64 KiB")

    # ── tip polling ───────────────────────────────────────────────────────
    def start_poll(self, t_m):
        body = '{"jsonrpc":"2.0","method":"get_status","params":[],"id":1}'
        try:
            p = subprocess.Popen(
                [self.a.curl, "-s", "-K", "-", "--max-time", str(POLL_MAX_S),
                 "-w", "\n%{http_code}",
                 "-H", "Content-Type: application/json", "-d", body, self.a.api_url],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        except OSError as e:
            raise Fatal("error", "cannot run curl: %s" % e.strerror)
        try:
            p.stdin.write(self.cfg)
            p.stdin.close()
        except OSError:
            pass
        self.poll = {"proc": p, "t": t_m, "out": b""}
        self.next_poll = t_m + self.poll_s

    def kill_poll(self):
        if self.poll is None:
            return
        p = self.poll["proc"]
        try:
            p.kill()
        except OSError:
            pass
        try:
            p.wait(timeout=1)
        except Exception:
            pass
        try:
            p.stdout.close()
        except Exception:
            pass
        self.poll = None

    def read_poll(self, t_m, t_w):
        p = self.poll["proc"]
        chunk = os.read(p.stdout.fileno(), 65536)
        if chunk:
            self.poll["out"] += chunk
            if len(self.poll["out"]) > 1048576:
                self.kill_poll()
                self.poll_done(None, None, t_m, t_w)
            return
        t_send = self.poll["t"]
        out = self.poll["out"]
        try:
            p.wait(timeout=1)
        except Exception:
            pass
        self.kill_poll()
        # curl -w appends "\n<http_code>" after the body.
        body, _, code = out.rpartition(b"\n")
        self.poll_done(body, t_send, t_m, t_w, code.strip().decode("ascii", "replace"))

    def poll_done(self, out, t_send, t_m, t_w, code=""):
        if t_send is not None:
            self.polls += 1
            self.poll_lat.append(t_m - t_send)
        st = unwrap_ok(out) if out else None
        tip = st.get("tip") if isinstance(st, dict) else None
        if not isinstance(tip, dict) or "last_block_pushed" not in tip:
            self.poll_fail += 1
            self.consec_fail += 1
            if self.base is None:
                el = (t_m - t_send) if t_send is not None else POLL_MAX_S
                if code in ("401", "403"):
                    self.api_auth = True
                    self.api_err = "HTTP %s: the owner secret was rejected" % code
                elif code in ("", "000"):
                    self.api_err = ("no reply within %d s" % POLL_MAX_S) \
                        if el >= POLL_MAX_S - 0.2 else "no connection (refused or reset)"
                else:
                    self.api_err = "HTTP %s without a parsed {\"Ok\":…}" % code
            elif self.consec_fail >= MAX_POLL_FAILS:
                raise Fatal("api_lost", "%d get_status polls in a row failed" % MAX_POLL_FAILS)
            return
        self.consec_fail = 0
        self.user_agent = str(st.get("user_agent") or "")
        self.sync_status = str(st.get("sync_status") or "")
        h, hh = tip.get("height"), tip.get("last_block_pushed")
        if self.base is None:
            self.base = {"height": h, "hash": hh}
            self.cur_hash, self.cur_height, self.t_old_send = hh, h, t_send
            return
        if self.sync_status and self.sync_status != "no_sync":
            raise Fatal("syncing", "the node left no_sync during the run (%s)" % self.sync_status)
        if hh != self.cur_hash:
            self.new_tip(h, hh, t_send, t_m, t_w)
        self.t_old_send = t_send

    # ── measurement ───────────────────────────────────────────────────────
    def new_tip(self, h, hh, t_send, t_m, t_w):
        prev_h = self.cur_height
        row = {"tip": h, "prev": prev_h, "t_prev": self.t_old_send, "seen_m": t_m,
               "seen_w": t_w, "job_m": None, "job_w": None, "flags": [], "closed": False}
        row["w"] = t_m - row["t_prev"]
        if h <= prev_h:
            row["flags"].append("reorg")
        if row["w"] > WIDE_S:
            row["flags"].append("wide")
        after = self.rows[-1]["seen_m"] if self.rows else self.t0_m
        self.rows.append(row)
        self.cur_hash, self.cur_height = hh, h
        self.tip_event(h, t_w)
        # The job may have beaten the poll; on a healthy node that is normal.
        # It must have arrived after the previous tip was seen, so a job left
        # over from before a same-height reorg is never paired with the new tip.
        for j in self.j0:
            if not j["claimed"] and j["height"] == h + 1 and j["m"] > after:
                self.assign(row, j)
                break

    # One line per new tip, for the bash side's thread sampler (§10.5). A
    # failed write costs only that sample, never the measurement.
    def tip_event(self, h, t_w):
        if not self.a.events:
            return
        try:
            with open(self.a.events, "a") as f:
                f.write("tip %s %.3f\n" % (h, t_w))
        except OSError:
            pass

    def on_job(self, height, job_id, t_m, t_w):
        lj = self.last_job
        if lj and lj["height"] == height and job_id == lj["job_id"] + 1:
            self.refresh_gaps.append(t_m - lj["m"])
        self.last_job = {"height": height, "job_id": job_id, "m": t_m}
        # A job at the OLD height after the new tip was seen: the loop was
        # still in an earlier build when the tip changed. After a same-height
        # reorg the old and new heights are equal, and a job_id 0 job there is
        # the row's own new-block job, not a sign of queueing.
        for r in self.rows:
            own = job_id == 0 and height == r["tip"] + 1
            if r["job_m"] is None and not r["closed"] and height == r["prev"] + 1 \
                    and not own and t_m > r["seen_m"] and "queued" not in r["flags"]:
                r["flags"].append("queued")
        if job_id != 0:
            return
        if self.base is not None:
            if abs(height - (self.cur_height + 1)) <= 1:
                self.match += 1
            else:
                self.mismatch += 1
                if self.mismatch >= 2 and self.match == 0:
                    raise Fatal("wrong_node", "job heights never match the polled tip; "
                                "the stratum port belongs to another node")
        j = {"height": height, "m": t_m, "w": t_w, "claimed": False}
        for r in reversed(self.rows):
            if r["job_m"] is None and not r["closed"] and r["tip"] + 1 == height \
                    and t_m > r["t_prev"]:
                self.assign(r, j)
                return
        self.j0.append(j)
        del self.j0[:-50]

    def assign(self, row, j):
        j["claimed"] = True
        row["job_m"], row["job_w"] = j["m"], j["w"]
        row["lat"] = j["m"] - row["seen_m"]
        if row["lat"] < row["w"]:
            row["flags"].append("below-res")
        if row is not self.rows[-1] and self.rows[-1]["seen_m"] < j["m"]:
            row["flags"].append("stale-on-arrival")
        row["closed"] = True
        self.nojob_streak = 0
        # The loop is sequential: once a later tip has its job, an older one
        # without a job will never get one.
        for r in self.rows:
            if r is row:
                break
            if r["job_m"] is None and not r["closed"]:
                r["flags"].append("superseded")
                r["closed"] = True
        self.say(row)

    def check_nojob(self, t_m):
        for r in self.rows:
            if r["job_m"] is None and not r["closed"] and t_m - r["seen_m"] > NO_JOB_S:
                r["flags"].append("no-job")
                r["closed"] = True
                self.nojob_streak += 1
                self.say(r)
                if self.nojob_streak >= 2:
                    raise Fatal("no_job", "two new tips in a row got no job within %d s" % NO_JOB_S)

    def say(self, r):
        if r["job_m"] is None:
            txt = "no job within %d s" % NO_JOB_S
        elif "below-res" in r["flags"]:
            txt = "< %.2f s (below the probe's resolution)" % r["w"]
        else:
            txt = "%.2f s" % r["lat"]
        fl = [f for f in r["flags"] if f != "below-res"]
        sys.stdout.write("  tip %-9s seen %s  job %s%s\n" % (
            r["tip"], utc_hms(r["seen_w"]), txt, ("   " + " ".join(fl)) if fl else ""))
        sys.stdout.flush()

    def done_count(self):
        return sum(1 for r in self.rows if r["job_m"] is not None)

    # ── loop ──────────────────────────────────────────────────────────────
    def pump(self, until_m):
        t_m = time.monotonic()
        rl = []
        if self.sock is not None:
            rl.append(self.sock)
        if self.poll is not None:
            rl.append(self.poll["proc"].stdout)
        wait = max(0.0, min(TICK_S, until_m - t_m))
        if self.poll is None and self.base is not None:
            wait = max(0.0, min(wait, self.next_poll - t_m))
        if rl:
            ready, _, _ = select.select(rl, [], [], wait)
        else:
            time.sleep(wait)
            ready = []
        t_m, t_w = clock()
        for f in ready:
            if f is self.sock:
                self.read_sock(t_m, t_w)
            elif self.poll is not None and f is self.poll["proc"].stdout:
                self.read_poll(t_m, t_w)
        if self.poll is not None and t_m - self.poll["t"] > POLL_KILL_S:
            t_send = self.poll["t"]
            self.kill_poll()
            self.poll_done(None, t_send, t_m, t_w)

    def preflight(self):
        connected = self.connect()
        if connected:
            self.msg_id = 1
            self.send({"id": 1, "jsonrpc": "2.0", "method": "login",
                       "params": {"login": self.a.login, "pass": "", "agent": self.a.agent}})
        self.start_poll(time.monotonic())
        dl_login = time.monotonic() + LOGIN_S
        while not STOP_REQ:
            t_m = time.monotonic()
            login_wait = connected and self.login_ok is None and t_m < dl_login
            if not login_wait and self.poll is None:
                break
            self.pump(dl_login if login_wait else t_m + TICK_S)
        if STOP_REQ:
            raise Fatal("interrupted", "stopped before the run started")
        if connected and self.login_ok is None:
            self.stratum_err = "no login reply within %d s" % LOGIN_S
        elif connected and self.login_ok is False:
            self.stratum_err = "login rejected: %s" % self.login_err
        if self.base is None and self.api_auth and not self.stratum_err:
            raise Fatal("api_auth", "the owner API rejected the secret")
        if self.stratum_err or self.base is None:
            raise Fatal("node_down", "the node did not answer")
        if self.sync_status and self.sync_status != "no_sync":
            raise Fatal("syncing", "the node is syncing (%s)" % self.sync_status)
        self.send({"id": 2, "jsonrpc": "2.0", "method": "getjobtemplate", "params": None})
        self.last_ka = time.monotonic()
        self.next_poll = time.monotonic()

    def run(self):
        self.preflight()
        sys.stdout.write("  connected · waiting for new blocks (Ctrl+C stops and keeps the rows)\n")
        sys.stdout.flush()
        stop_at = self.t0_m + min(self.a.max_s, HARD_CAP_S)
        while True:
            if STOP_REQ:
                raise Fatal("interrupted", "stopped with Ctrl+C")
            t_m = time.monotonic()
            if self.done_count() >= self.a.blocks:
                self.status, self.reason = "ok", "%d blocks measured" % self.a.blocks
                return
            if t_m >= stop_at:
                self.status, self.reason = "time", "time limit reached"
                return
            if self.poll is None and t_m >= self.next_poll:
                self.start_poll(t_m)
            elif self.poll is not None and t_m >= self.next_poll:
                self.poll_skipped += 1
                self.next_poll += self.poll_s
            if t_m - self.last_ka >= KEEPALIVE_S:
                self.msg_id += 1
                self.send({"id": self.msg_id, "jsonrpc": "2.0", "method": "keepalive", "params": None})
                self.last_ka = t_m
                if self.ka_sent is None:
                    self.ka_sent = t_m
            if self.ka_sent is not None and t_m - self.ka_sent > KEEPALIVE_WAIT_S:
                raise Fatal("stratum_lost", "no keepalive reply within %d s" % KEEPALIVE_WAIT_S)
            self.check_nojob(t_m)
            self.pump(stop_at)

    def close(self):
        self.kill_poll()
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None

    # ── block interval for the loss estimate (§10.2.7) ────────────────────
    def header_ts(self, h):
        body = json.dumps({"jsonrpc": "2.0", "method": "get_header",
                           "params": [h, None, None], "id": 1})
        try:
            r = subprocess.run(
                [self.a.curl, "-s", "-K", "-", "--max-time", "3",
                 "-H", "Content-Type: application/json", "-d", body, self.a.foreign_url],
                input=self.fcfg, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5)
        except (OSError, subprocess.SubprocessError):
            return None
        ok = unwrap_ok(r.stdout)
        ts = ok.get("timestamp") if isinstance(ok, dict) else None
        if not isinstance(ts, str):
            return None
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
        except (ValueError, AttributeError):   # fromisoformat needs python 3.7
            return None

    def block_interval(self):
        if not self.a.foreign_url or self.cur_height is None or self.cur_height <= 60:
            return 60.0, "fallback"
        t1 = self.header_ts(self.cur_height)
        t0 = self.header_ts(self.cur_height - 60) if t1 is not None else None
        if t0 is None or t1 is None or t1 <= t0:
            return 60.0, "fallback"
        return (t1 - t0) / 60.0, "headers"

    # ── output ────────────────────────────────────────────────────────────
    def results(self):
        counted = [r for r in self.rows if r["job_m"] is not None
                   and not set(r["flags"]) & {"superseded", "no-job", "wide"}]
        vals = [0.0 if "below-res" in r["flags"] else r["lat"] for r in counted]
        ws = [r["w"] for r in counted]
        n = len(vals)
        mean = (sum(vals) / n) if n else None
        bi, bi_src = self.block_interval() if n else (60.0, "fallback")
        rp50 = pct(self.refresh_gaps, 0.5)
        dlo = dhi = None
        if rp50 is not None:
            dlo = max(0.0, rp50 - self.a.attempt)
            dhi = max(0.0, rp50 - self.a.attempt + 1)

        def cnt(flag):
            return sum(1 for r in self.rows if flag in r["flags"])

        rows = []
        for r in self.rows:
            rows.append({
                "tip": r["tip"],
                "seen": utc_iso(r["seen_w"]),
                "job": utc_iso(r["job_w"]) if r["job_w"] is not None else None,
                "lat_s": rnd(r.get("lat"), 3),
                "w_s": rnd(r["w"], 3),
                "flags": [f for f in r["flags"]] + ([] if r["closed"] else ["unfinished"]),
            })
        probe = {
            "status": self.status, "reason": self.reason,
            "n": n,
            "p50_s": rnd(pct(vals, 0.5)) if n >= 3 else None,
            "p95_s": rnd(pct(vals, 0.95)) if n >= 3 else None,
            "max_s": rnd(max(vals)) if n >= 3 else None,
            "mean_s": rnd(mean),
            "bound_s": rnd(pct(ws, 0.95)),
            "refresh_p50_s": rnd(rp50, 1), "refresh_n": len(self.refresh_gaps),
            "deadline_build_s": rnd(dlo, 1), "deadline_build_hi_s": rnd(dhi, 1),
            "reorgs": cnt("reorg"), "queued": cnt("queued"),
            "stale_on_arrival": cnt("stale-on-arrival"), "superseded": cnt("superseded"),
            "no_job": cnt("no-job"), "wide": cnt("wide"),
            "below_res": sum(1 for r in counted if "below-res" in r["flags"]),
            "loss_pct": rnd(mean / bi * 100.0, 1) if mean is not None and bi else None,
            "block_interval_s": rnd(bi, 1), "block_interval_src": bi_src,
            "poll_ms": self.a.poll_ms, "polls": self.polls, "poll_fail": self.poll_fail,
            "poll_skipped": self.poll_skipped, "poll_p95_s": rnd(pct(self.poll_lat, 0.95), 3),
            "started_at": utc_iso(self.t0_w), "ended_at": utc_iso(self.end_w or time.time()),
            "duration_s": rnd((self.end_w or time.time()) - self.t0_w, 1),
            "tip_start": self.base["height"] if self.base else None,
            "user_agent": self.user_agent,
            "api_err": self.api_err, "stratum_err": self.stratum_err,
            "rows": rows,
        }
        return probe


def write_atomic(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(text)
    os.replace(tmp, path)


def write_out(prefix, probe):
    write_atomic(prefix + ".json", json.dumps(probe, separators=(",", ":")) + "\n")
    kv = []
    for k, v in probe.items():
        if k == "rows":
            continue
        v = "" if v is None else str(v)
        kv.append("%s=%s" % (k, v.replace("\n", " ")))
    write_atomic(prefix + ".kv", "\n".join(kv) + "\n")
    tsv = []
    for r in probe["rows"]:
        tsv.append("\t".join([
            str(r["tip"]), r["seen"][11:22], (r["job"] or "")[11:22],
            "" if r["lat_s"] is None else "%.3f" % r["lat_s"],
            "%.3f" % r["w_s"], ",".join(r["flags"])]))
    write_atomic(prefix + ".rows", "".join(t + "\n" for t in tsv))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True)
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--api-url", required=True)
    ap.add_argument("--secret-file", default="")
    ap.add_argument("--foreign-url", default="")
    ap.add_argument("--foreign-secret-file", default="")
    ap.add_argument("--blocks", type=int, default=5)
    ap.add_argument("--poll-ms", type=int, default=200)
    ap.add_argument("--max-s", type=int, default=600)
    ap.add_argument("--attempt", type=int, default=15)
    ap.add_argument("--login", required=True)
    ap.add_argument("--agent", required=True)
    ap.add_argument("--curl", default="curl")
    ap.add_argument("--out", required=True)
    ap.add_argument("--events", default="")
    a = ap.parse_args()
    os.umask(0o077)
    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)
    try:
        pr = Probe(a)
    except OSError as e:
        probe = {"status": "error", "reason": "cannot read the secret file: %s" % e.strerror, "rows": []}
        write_out(a.out, probe)
        return 1
    rc = 0
    try:
        pr.run()
    except Fatal as e:
        pr.status, pr.reason = e.status, e.msg
        rc = 2 if pr.base is None else 0
    except Exception as e:
        pr.status, pr.reason = "error", "%s: %s" % (type(e).__name__, e)
        rc = 1
    finally:
        pr.end_w = time.time()
        pr.close()
    write_out(a.out, pr.results())
    return rc


if __name__ == "__main__":
    sys.exit(main())
PY

# Runs the probe prepared by dgs_probe_prepare. Prints the helper's live rows.
#   [blocks]     new-block jobs to measure, 1–10 (the screen offers 3, 5, 10)
#   [poll_ms]    tip poll interval, 100–1000
#   [confirmed]  1 when the operator answered y to the gate's question
#   [max_s]      run length cap in seconds (default 600, hard cap 1800)
#   [threads]    1 (default): sample thread CPU across the first new tip and
#                once between blocks (§10.5), into DGS_CT / DGS_CI
# Result: $DG_TMP/dgs_probe.{json,kv,rows}, DGS_P (dgs_probe_load) and
# DGS_PROBE_STATUS. rc 0 when result files were written.
#   .json  the `probe` object of the §10.7 baseline record, plus run counters
#   .kv    the same scalars as key=value
#   .rows  tip · seen (UTC) · job (UTC) · latency s · bracket w s · flags
# Thread samples: $DG_TMP/dgs_cpu_tip.* and dgs_cpu_idle.* (dgs_thread_diff).
# DGS_PSI_CPU60 holds the host's CPU pressure when the run ended.
dgs_probe_run() {
    local blocks=${1:-5} poll_ms=${2:-200} confirmed=${3:-0} max_s=${4:-600} threads=${5:-1}
    local py out err rc pid old_int old_term agent ev wpid=""
    DGS_PROBE_STATUS=""; DGS_PROBE_ERR=""; DGS_P=(); DGS_CT=(); DGS_CI=(); DGS_PSI_CPU60=""
    _dgs_need_tmp || return 1
    if [[ "$DGS_PREP" != ok ]]; then
        error "Probe not prepared (${DGS_PREP:-not run})."
        DGS_PROBE_STATUS=not_prepared; return 1
    fi
    case "$DGS_GATE" in
        run) ;;
        ask)
            if [[ "$confirmed" != 1 ]]; then DGS_PROBE_STATUS=not_confirmed; return 1; fi ;;
        *)  DGS_PROBE_STATUS=refused; return 1 ;;
    esac
    [[ "$blocks" =~ ^[0-9]+$ ]] && (( blocks >= 1 && blocks <= 10 )) || blocks=5
    [[ "$poll_ms" =~ ^[0-9]+$ ]] && (( poll_ms >= 100 && poll_ms <= 1000 )) || poll_ms=200
    [[ "$max_s" =~ ^[0-9]+$ ]] && (( max_s >= 30 && max_s <= 1800 )) || max_s=600

    py="$DG_TMP/dgs_probe.py"; out="$DG_TMP/dgs_probe"; err="$DG_TMP/dgs_probe.err"
    ev="$DG_TMP/dgs_tips.evt"
    _dgs_rm "$out.json" "$out.kv" "$out.rows" "$err" "$ev" || return 1
    _dgs_cpu_clear tip || return 1
    _dgs_cpu_clear idle || return 1
    : > "$ev" || { error "Cannot write $ev"; return 1; }
    printf '%s' "$_DGS_PROBE_PY" > "$py" || { error "Cannot write $py"; return 1; }
    agent="grin-node-toolkit-086/$(_dgs_toolkit_version)"

    # 086's global `trap 'exit 130' INT TERM` would leave the whole script on
    # Ctrl+C. For the helper's run, signals are forwarded to it instead; it
    # closes the socket, kills its curl and writes the rows it has.
    old_int=$(trap -p INT); old_term=$(trap -p TERM)
    python3 -I "$py" --host "$DGS_HOST" --port "$DGS_PORT" \
        --api-url "http://$DGS_API_HOST:$DGS_API_PORT/v2/owner" \
        --secret-file "$DGS_SECRET_PATH" \
        --foreign-url "http://$DGS_API_HOST:$DGS_API_PORT/v2/foreign" \
        --foreign-secret-file "$DGS_FSECRET_PATH" \
        --blocks "$blocks" --poll-ms "$poll_ms" --max-s "$max_s" --attempt "$DGS_ATTEMPT" \
        --login "$DGS_LOGIN" --agent "$agent" --out "$out" --events "$ev" 2> "$err" &
    pid=$!
    _DGS_PROBE_PID=$pid
    trap 'kill -INT '"$pid"' 2>/dev/null || true' INT
    trap 'kill -TERM '"$pid"' 2>/dev/null || true' TERM
    # The sampler runs beside the helper and ends on its own once the helper
    # has exited (a pair already started across a tip still finishes, ≤ 10 s).
    # As a background job it ignores the terminal's Ctrl+C.
    if [[ "$threads" == 1 && -n "$DGS_PID" && -d "$_DGS_PROC/$DGS_PID/task" ]]; then
        _dgs_cpu_watch "$ev" "$pid" "$DGS_PID" &
        wpid=$!
        _DGS_WATCH_PID=$wpid
    fi
    # `wait` returns early when a trap fires; keep waiting until the helper has
    # written its result and exited. The helper bounds its own run.
    while :; do
        wait "$pid" 2>/dev/null; rc=$?
        kill -0 "$pid" 2>/dev/null || break
    done
    if [[ -n "$wpid" ]]; then
        while kill -0 "$wpid" 2>/dev/null; do wait "$wpid" 2>/dev/null; done
    fi
    _DGS_PROBE_PID=""; _DGS_WATCH_PID=""
    _dgs_restore_trap "$old_int" INT
    _dgs_restore_trap "$old_term" TERM
    DGS_PSI_CPU60=$(_dgs_psi_cpu60)
    _dgs_load_kv "$DG_TMP/dgs_cpu_tip.kv" DGS_CT || true
    _dgs_load_kv "$DG_TMP/dgs_cpu_idle.kv" DGS_CI || true

    [[ -s "$err" ]] && DGS_PROBE_ERR=$(tail -n 5 "$err" | cut -c1-200)
    _dgs_rm "$py" "$err" "$ev" || true
    if ! dgs_probe_load; then
        error "The probe wrote no result (exit $rc). ${DGS_PROBE_ERR}"
        DGS_PROBE_STATUS=error
        return 1
    fi
    DGS_PROBE_STATUS=${DGS_P[status]:-error}
    log "[086] stratum probe $DGS_NET status=$DGS_PROBE_STATUS n=${DGS_P[n]:-0} p95=${DGS_P[p95_s]:-} rc=$rc"
    return 0
}

dgs_probe_load() { _dgs_load_kv "$DG_TMP/dgs_probe.kv" DGS_P; }

# For 086's EXIT path: a probe still running when 086 leaves (a signal its
# traps do not cover) gets SIGTERM, which makes the helper close the socket
# and kill its curl; whatever is left after 2 s is killed.
dgs_probe_cleanup() {
    local p i alive
    local -a pids=()
    for p in "$_DGS_PROBE_PID" "$_DGS_WATCH_PID"; do
        [[ "$p" =~ ^[0-9]+$ ]] && pids+=("$p")
    done
    (( ${#pids[@]} > 0 )) || return 0
    kill -TERM "${pids[@]}" 2>/dev/null || true
    for (( i = 0; i < 20; i++ )); do
        alive=0
        for p in "${pids[@]}"; do kill -0 "$p" 2>/dev/null && alive=1; done
        (( alive == 1 )) || break
        sleep 0.1
    done
    kill -KILL "${pids[@]}" 2>/dev/null || true
    _DGS_PROBE_PID=""; _DGS_WATCH_PID=""
    return 0
}

# ─── §10.3  Build timing from the Debug log ──────────────────────────────────
# Writes the lines of the node log from the last <hours> into <out>, through
# 086's window helpers (rotated .gz files included). Grin's prefix is local
# time, so the cut-off is formatted in local time too.
dgs_log_window_file() {   # <dir> <hours> <out>
    local dir=$1 hours=$2 out=$3 lf since_epoch since
    [[ "$hours" =~ ^[0-9]+$ ]] || hours=6
    lf=$(dg_node_logfile "$dir")
    since_epoch=$(( $(date +%s) - hours * 3600 ))
    since=$(date -d "@$since_epoch" '+%Y%m%d %H:%M:%S')
    dg_log_window "$lf" "$since" "$since_epoch" | dg_log_filter "$since" > "$out" \
        || { error "Cannot write $out"; return 1; }
    return 0
}

# Shared awk prelude: seconds of day from a grin prefix, a day number from
# YYYYMMDD (days-from-civil, integer arithmetic only), and the gap between
# two prefixes with the midnight rule of §10.3.
_DGS_AWK_TIME='
function sod(ts) { return substr(ts, 10, 2) * 3600 + substr(ts, 13, 2) * 60 + substr(ts, 16, 6) }
function dayn(ts,   y, m, d, era, yoe, doy) {
    y = substr(ts, 1, 4) + 0; m = substr(ts, 5, 2) + 0; d = substr(ts, 7, 2) + 0
    if (m <= 2) y -= 1
    era = int(y / 400); yoe = y - era * 400
    doy = int((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
    return era * 146097 + yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy
}
# Inverse of dayn: day number → YYYYMMDD.
function civ(z,   era, doe, yoe, y, doy, mp, d, m) {
    era = int(z / 146097); doe = z - era * 146097
    yoe = int((doe - int(doe / 1460) + int(doe / 36524) - int(doe / 146096)) / 365)
    y = yoe + era * 400
    doy = doe - (365 * yoe + int(yoe / 4) - int(yoe / 100))
    mp = int((5 * doy + 2) / 153)
    d = doy - int((153 * mp + 2) / 5) + 1
    m = mp + (mp < 10 ? 3 : -9)
    if (m <= 2) y++
    return sprintf("%04d%02d%02d", y, m, d)
}
function gap(a, b,   s) {
    s = sod(b) - sod(a)
    if (substr(a, 1, 8) != substr(b, 1, 8)) s += 86400
    return s
}
function ists(l) { return l ~ /^[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9]/ }
'

# Pairs each `resend updated block` with the next `broadcast job` and the
# `sending block H with id J` line after it. J == 0 is a new-block build,
# J > 0 a deadline refresh — read from the log, never inferred from timing.
# Result files in $DG_TMP:
#   dgs_build.tsv   start · end · total · A · B · C · D · trigger · height · job_id
#                   (segments in s, "-" when a mark is missing; incomplete
#                   builds have trigger "incomplete")
#   dgs_build.stat  trigger · metric · n · p50 · p95 · max
#   dgs_build.slow  the 10 slowest complete builds, same columns as .tsv
#   dgs_build.kv    resend_lines, builds, new_n, refresh_n, unknown_n,
#                   incomplete, stale_debug, stale_in_new_build, file_log_level,
#                   state (debug|not_logged)
# Also loads DGS_B. <toml> is optional; it only fills file_log_level.
dgs_build_log() {   # <window-file> [toml]
    local wf=$1 toml=${2:-} t="$DG_TMP/dgs_build"
    DGS_B=()
    _dgs_need_tmp || return 1
    [[ -r "$wf" ]] || { error "Log window $wf not readable"; return 1; }
    _dgs_rm "$t.tsv" "$t.stat" "$t.slow" "$t.kv" "$t.vals" || return 1

    awk "$_DGS_AWK_TIME"'
        function fin(trig, h, j,   tot, a, b, c, d) {
            tot = (end != "") ? gap(st, end) : -1
            if (tot < 0 || tot > 600) trig = "incomplete"
            a = (cb != "")    ? sprintf("%.3f", gap(st, cb))    : "-"
            b = (cb != "" && bl != "") ? sprintf("%.3f", gap(cb, bl)) : "-"
            c = (bl != "" && bc != "") ? sprintf("%.3f", gap(bl, bc)) : "-"
            d = (bc != "" && sd != "") ? sprintf("%.3f", gap(bc, sd)) : "-"
            printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", st, (end != "" ? end : "-"), \
                (trig == "incomplete" ? "-" : sprintf("%.3f", tot)), a, b, c, d, trig, h, j > tsv
            if (trig == "incomplete") incomplete++
            else { builds++; cnt[trig]++ }
            if (trig == "new") stin += np
            np = 0
            if (trig != "incomplete") { lastend = end; lasttrig = trig }
            open_ = 0; st = cb = bl = bc = sd = end = ""
        }
        !ists($0) { next }
        {
            ts = substr($0, 1, 21)
            if (index($0, "resend updated block")) {
                resend++
                # A resend before the `sending block` line: the build itself
                # finished (it broadcast), only its trigger is unknown.
                if (open_) fin(bc != "" ? "unknown" : "incomplete", "-", "-")
                open_ = 1; st = ts; cb = bl = bc = sd = end = ""; np = 0
                next
            }
            if (index(tolower($0), "submitted too late")) {
                stale++
                # handle_submit waits on the read lock a build holds, so a
                # stale line logs at, or just after, the end of that build.
                if (open_) np++
                else if (lasttrig == "new" && lastend != "" && gap(lastend, ts) <= 0.5) stin++
                next
            }
            if (!open_) next
            if (cb == "" && index($0, "get_coinbase")) { cb = ts; next }
            if (bl == "" && index($0, "Built new block")) { bl = ts; next }
            if (bc == "" && index($0, "broadcast job")) { bc = ts; end = ts; next }
            if (bc != "" && match($0, /sending block [0-9]+ with id [0-9]+/)) {
                sd = ts
                split(substr($0, RSTART, RLENGTH), p, " ")
                fin((p[6] + 0 == 0) ? "new" : "refresh", p[3], p[6])
            }
        }
        END {
            if (open_) {
                if (bc != "") fin("unknown", "-", "-")
                else fin("incomplete", "-", "-")
            }
            printf "resend_lines=%d\nbuilds=%d\nnew_n=%d\nrefresh_n=%d\nunknown_n=%d\nincomplete=%d\nstale_debug=%d\nstale_in_new_build=%d\n", \
                resend, builds, cnt["new"], cnt["refresh"], cnt["unknown"], incomplete, stale, stin > kv
        }
    ' tsv="$t.tsv" kv="$t.kv" "$wf" || { error "Build-log parse failed"; return 1; }
    [[ -f "$t.tsv" ]] || { : > "$t.tsv" || { error "Cannot write $t.tsv"; return 1; }; }

    # Percentiles: one "trigger|metric value" line per measurement, sorted,
    # then nearest-rank per group. mawk has no asort, so sort(1) does it.
    awk -F'\t' '$8 == "new" || $8 == "refresh" || $8 == "unknown" {
        printf "%s|total\t%s\n", $8, $3
        if ($4 != "-") printf "%s|A\t%s\n", $8, $4
        if ($5 != "-") printf "%s|B\t%s\n", $8, $5
        if ($6 != "-") printf "%s|C\t%s\n", $8, $6
        if ($7 != "-") printf "%s|D\t%s\n", $8, $7
    }' "$t.tsv" | LC_ALL=C sort -t$'\t' -k1,1 -k2,2g > "$t.vals" \
        || { error "Cannot write $t.vals"; return 1; }
    awk -F'\t' '
        function flush(   i50, i95, a) {
            if (n == 0) return
            i50 = int(0.5 * n); if (i50 < 0.5 * n) i50++
            i95 = int(0.95 * n); if (i95 < 0.95 * n) i95++
            split(key, a, "|")
            printf "%s\t%s\t%d\t%.3f\t%.3f\t%.3f\n", a[1], a[2], n, v[i50], v[i95], v[n]
        }
        $1 != key { flush(); key = $1; n = 0 }
        { v[++n] = $2 + 0 }
        END { flush() }
    ' "$t.vals" > "$t.stat" || { error "Cannot write $t.stat"; return 1; }
    awk -F'\t' '$3 != "-"' "$t.tsv" | LC_ALL=C sort -t$'\t' -k3,3gr | head -10 > "$t.slow" \
        || { error "Cannot write $t.slow"; return 1; }
    _dgs_rm "$t.vals" || return 1

    {
        printf 'file_log_level=%s\n' "$( [[ -n "$toml" ]] && dg_tv "$toml" file_log_level )"
        # Zero resend lines means "not logged", whatever the toml says: the
        # toml may have changed since the node started.
        if (( $(_dg_num "$(awk -F= '$1 == "resend_lines" {print $2}' "$t.kv")") > 0 )); then
            echo "state=debug"
        else
            echo "state=not_logged"
        fi
    } >> "$t.kv" || { error "Cannot write $t.kv"; return 1; }
    _dgs_load_kv "$t.kv" DGS_B
    return 0
}

# ─── §10.4  Node-side rejects per hour ───────────────────────────────────────
# All reject lines are error! in v5.5.2, so they exist at every log level;
# accepted shares (info!) give the denominator only at Info and below.
# Matched on the log-line tail, which also matches the RPC message text, so a
# pool or miner log reads the same. First match wins.
# Result files in $DG_TMP:
#   dgs_rej.hourly  hour · stale · low_diff · invalid · invalid_share · accepted
#                   (every clock hour from the window's first line to its last)
#   dgs_rej.kv      window_h, stale, low_diff, invalid, invalid_share, accepted,
#                   stale_pct (empty without accepted lines), hours_total,
#                   hours_with_stale, burst_max (most stale lines in any
#                   10-minute span), burst_start, pattern
#                   (none|burst|steady|scattered); burst and steady both
#                   need at least 10 stale lines, fewer is scattered
# Also loads DGS_R. The pattern is a lean, like every 086 origin.
dgs_rejects() {   # <window-file> [window-hours]
    local wf=$1 wh=${2:-} t="$DG_TMP/dgs_rej"
    DGS_R=()
    _dgs_need_tmp || return 1
    [[ -r "$wf" ]] || { error "Log window $wf not readable"; return 1; }
    _dgs_rm "$t.hourly" "$t.kv" || return 1

    awk "$_DGS_AWK_TIME"'
        !ists($0) { next }
        {
            ts = substr($0, 1, 21)
            dn = dayn(ts); hh = substr(ts, 10, 2) + 0
            hi = dn * 24 + hh
            if (first == "") first = hi
            last = hi
            l = tolower($0); k = ""
            if (index(l, "submitted too late"))                 k = "stale"
            else if (index(l, "rejected due to low difficulty")) k = "low"
            else if (index(l, "failed to validate solution"))    k = "inv"
            else if (index(l, "failed to validate share"))       k = "invs"
            else if (index(l, "got share at height"))            k = "acc"
            if (k == "") next
            c[k]++; hc[hi, k]++
            if (k == "stale") {
                mi = dn * 1440 + hh * 60 + substr(ts, 13, 2)
                if (!(mi in mc)) mlist[++nm] = mi
                mc[mi]++
                if (!(hi in hs)) { hs[hi] = 1; nhs++ }
            }
        }
        END {
            ht = (first == "") ? 0 : last - first + 1
            for (h = first; ht && h <= last; h++)
                printf "%s %02d:00\t%d\t%d\t%d\t%d\t%d\n", civ(int(h / 24)), h % 24, \
                    hc[h, "stale"], hc[h, "low"], hc[h, "inv"], hc[h, "invs"], hc[h, "acc"] > hourly
            # Most stale lines in any 10-minute span (minutes m .. m+9).
            # Log lines are in time order, so the minute list is too.
            bm = 0; bs = ""; j = 1; run = 0
            for (i = 1; i <= nm; i++) {
                run += mc[mlist[i]]
                while (mlist[i] - mlist[j] > 9) { run -= mc[mlist[j]]; j++ }
                if (run > bm) { bm = run; bs = mlist[j] }
            }
            tot = c["stale"] + c["low"] + c["inv"] + c["invs"]
            sp = (c["acc"] > 0) ? sprintf("%.1f", c["stale"] * 100 / (c["acc"] + tot)) : ""
            pat = "none"
            if (c["stale"] > 0) {
                if (c["stale"] >= 10 && bm * 2 >= c["stale"])   pat = "burst"
                else if (c["stale"] >= 10 && ht > 0 && nhs * 4 >= ht * 3) pat = "steady"
                else                                           pat = "scattered"
            }
            bst = ""
            if (bs != "") bst = sprintf("%02d:%02d", int((bs % 1440) / 60), bs % 60)
            printf "stale=%d\nlow_diff=%d\ninvalid=%d\ninvalid_share=%d\naccepted=%d\nstale_pct=%s\nhours_total=%d\nhours_with_stale=%d\nburst_max=%d\nburst_start=%s\npattern=%s\n", \
                c["stale"], c["low"], c["inv"], c["invs"], c["acc"], sp, ht, nhs, bm, bst, pat > kv
        }
    ' hourly="$t.hourly" kv="$t.kv" "$wf" || { error "Reject parse failed"; return 1; }
    [[ -f "$t.hourly" ]] || { : > "$t.hourly" || { error "Cannot write $t.hourly"; return 1; }; }
    printf 'window_h=%s\n' "$wh" >> "$t.kv" || { error "Cannot write $t.kv"; return 1; }
    _dgs_load_kv "$t.kv" DGS_R
    return 0
}

# ─── §10.5  Per-thread CPU ───────────────────────────────────────────────────
# CPU % = Δ(utime + stime) / CLK_TCK / elapsed. The elapsed time comes from
# /proc/uptime in each snapshot, so a late `sleep` does not inflate the result.

_dgs_uptime_s() {   # whole seconds since boot
    local u=""
    { read -r u _ < "$_DGS_PROC/uptime"; } 2>/dev/null || true
    u=${u%.*}
    _dg_num "$u"
}

_dgs_psi_cpu60() {   # "some avg60" from /proc/pressure/cpu, empty without PSI
    awk '$1 == "some" { for (i = 2; i <= NF; i++) if (substr($i, 1, 6) == "avg60=") { print substr($i, 7); exit } }' \
        "$_DGS_PROC/pressure/cpu" 2>/dev/null || true
}

_dgs_cpu_clear() {   # <label>
    _dgs_rm "$DG_TMP/dgs_cpu_$1.a" "$DG_TMP/dgs_cpu_$1.b" "$DG_TMP/dgs_cpu_$1.tsv" \
        "$DG_TMP/dgs_cpu_$1.top" "$DG_TMP/dgs_cpu_$1.kv" "$DG_TMP/dgs_cpu_$1.raw"
}

# One snapshot of a process's threads and of the host's CPU counters:
#   W <uptime s>
#   H <total jiffies (user..steal)> <iowait> <steal>
#   T <tid> <utime+stime> <state> <comm>
# Fields are read after stripping `pid (comm) ` (comm may hold spaces or ")"),
# so the first remaining field is the state and the 12th/13th are utime and
# stime, as in dg_sample_procs. A thread that exits mid-read is skipped.
dgs_thread_snap() {   # <pid> <out>
    local pid=$1 out=$2 t tid comm st rest up
    local -a f
    [[ -d "$_DGS_PROC/$pid/task" ]] || { error "No thread list for pid $pid."; return 1; }
    {
        if { read -r up _ < "$_DGS_PROC/uptime"; } 2>/dev/null; then printf 'W\t%s\n' "$up"; fi
        # guest time is already inside user, so the total stops at steal.
        awk '$1 == "cpu" { t = 0; for (i = 2; i <= 9 && i <= NF; i++) t += $i
                           printf "H\t%.0f\t%s\t%s\n", t, $6, (NF >= 9 ? $9 : 0); exit }' \
            "$_DGS_PROC/stat" 2>/dev/null
        for t in "$_DGS_PROC/$pid/task"/[0-9]*; do
            tid=${t##*/}
            { IFS= read -r comm < "$t/comm" && IFS= read -r st < "$t/stat"; } 2>/dev/null || continue
            rest=${st##*) }
            read -r -a f <<< "$rest"
            (( ${#f[@]} > 12 )) || continue
            [[ "${f[11]}" =~ ^[0-9]+$ && "${f[12]}" =~ ^[0-9]+$ ]] || continue
            printf 'T\t%s\t%s\t%s\t%s\n' "$tid" "$(( f[11] + f[12] ))" "${f[0]}" "$comm"
        done
    } > "$out" || { error "Cannot write $out"; return 1; }
    return 0
}

# Compares two snapshots. A thread only in <a> exited and is dropped; one only
# in <b> — or whose comm changed, or whose counter went down (a reused tid) —
# is `new`, and its whole counter counts as used inside the window.
# Result files:
#   <prefix>.tsv  tid · comm · CPU % · new|"" · state, highest CPU first
#   <prefix>.top  the first 8 lines of .tsv
#   <prefix>.kv   secs, hz, threads, exited, new, proc_pct, stratum_tid,
#                 stratum_pct, stratum_state, stratum_new, steal_pct,
#                 iowait_pct (empty when /proc/stat gave nothing)
dgs_thread_diff() {   # <snap-a> <snap-b> <prefix> [nominal-secs]
    local a=$1 b=$2 pre=$3 nom=${4:-10} hz
    [[ -r "$a" && -r "$b" ]] || { error "Thread snapshot missing."; return 1; }
    hz=$(getconf CLK_TCK 2>/dev/null || true)
    [[ "$hz" =~ ^[0-9]+$ ]] && (( hz > 0 )) || hz=100
    awk -F'\t' -v hz="$hz" -v nom="$nom" -v kv="$pre.kv" -v raw="$pre.raw" '
        FNR == NR {
            if ($1 == "W") w0 = $2
            else if ($1 == "H") { h0 = $2; io0 = $3; st0 = $4 }
            else if ($1 == "T") { ta[$2] = $3; ca[$2] = $5 }
            next
        }
        $1 == "W" { w1 = $2; next }
        $1 == "H" { h1 = $2; io1 = $3; st1 = $4; next }
        $1 == "T" {
            nb++; tid = $2; seen[tid] = 1
            if ((tid in ta) && ca[tid] == $5 && $3 + 0 >= ta[tid] + 0) { d[nb] = $3 - ta[tid]; s[nb] = "" }
            else { d[nb] = $3 + 0; s[nb] = "new"; nn++ }
            id[nb] = tid; cm[nb] = $5; stt[nb] = $4
        }
        END {
            el = nom + 0
            if (w0 != "" && w1 != "" && w1 - w0 > 0) el = w1 - w0
            stid = ""; sp = ""; sst = ""; sn = ""
            printf "" > raw
            for (i = 1; i <= nb; i++) {
                p = d[i] / hz / el * 100
                tot += p
                printf "%s\t%s\t%.1f\t%s\t%s\n", id[i], cm[i], p, s[i], stt[i] > raw
                if (cm[i] == "stratum_server" && stid == "") { stid = id[i]; sp = sprintf("%.1f", p); sst = stt[i]; sn = s[i] }
            }
            gone = 0
            for (t in ta) if (!(t in seen)) gone++
            steal = ""; iow = ""
            if (h0 != "" && h1 != "" && h1 - h0 > 0) {
                steal = sprintf("%.1f", (st1 - st0) * 100 / (h1 - h0))
                iow = sprintf("%.1f", (io1 - io0) * 100 / (h1 - h0))
            }
            printf "secs=%.2f\nhz=%d\nthreads=%d\nexited=%d\nnew=%d\nproc_pct=%.1f\n", el, hz, nb, gone, nn, tot > kv
            printf "stratum_tid=%s\nstratum_pct=%s\nstratum_state=%s\nstratum_new=%s\nsteal_pct=%s\niowait_pct=%s\n", \
                stid, sp, sst, sn, steal, iow > kv
        }
    ' "$a" "$b" || { error "Thread CPU compare failed."; return 1; }
    LC_ALL=C sort -t$'\t' -k3,3gr -k1,1n "$pre.raw" > "$pre.tsv" || { error "Cannot write $pre.tsv"; return 1; }
    head -8 "$pre.tsv" > "$pre.top" || { error "Cannot write $pre.top"; return 1; }
    _dgs_rm "$pre.raw" || return 1
    return 0
}

# Snapshot, wait <secs>, snapshot, compare, into $DG_TMP/dgs_cpu_<label>.*.
# With [abort-pid], gives up (rc 2, no result) as soon as that process is gone.
_dgs_thread_pair() {   # <pid> <label> <secs> [abort-pid]
    local pid=$1 label=$2 secs=$3 abort=${4:-} pre="$DG_TMP/dgs_cpu_$2" i
    _dgs_cpu_clear "$label" || return 1
    dgs_thread_snap "$pid" "$pre.a" || return 1
    for (( i = 0; i < secs; i++ )); do
        sleep 1
        if [[ -n "$abort" ]] && ! kill -0 "$abort" 2>/dev/null; then
            _dgs_rm "$pre.a" || true
            return 2
        fi
    done
    dgs_thread_snap "$pid" "$pre.b" || return 1
    dgs_thread_diff "$pre.a" "$pre.b" "$pre" "$secs" || return 1
    _dgs_rm "$pre.a" "$pre.b" || return 1
    return 0
}

_dgs_lines() { _dg_num "$(wc -l < "$1" 2>/dev/null | tr -d ' ')"; }

# Background sampler beside the probe helper (§10.5 timing). It reads the
# helper's tip events:
#   · the first new tip starts the pair across a new-block build, which
#     finishes even if the helper exits meanwhile;
#   · the idle pair starts 25 s after the latest tip, so its 10 s window sits
#     mid-way between blocks at a ~60 s block time. A tip inside the window
#     voids it and re-arms; it is dropped when the helper exits first.
_dgs_cpu_watch() {   # <events> <helper-pid> <node-pid>
    local ev=$1 hp=$2 pid=$3 seen=0 n now due="" c0 tipdone=0
    while kill -0 "$hp" 2>/dev/null; do
        n=$(_dgs_lines "$ev")
        now=$(_dgs_uptime_s)
        if (( n > seen )); then
            seen=$n
            if (( tipdone == 0 )); then
                _dgs_thread_pair "$pid" tip 10 || return 1
                tipdone=1
                n=$(_dgs_lines "$ev")
                if (( n > seen )); then seen=$n; due=$(( $(_dgs_uptime_s) + 20 )); else due=$(( now + 25 )); fi
                continue
            fi
            [[ -n "$due" ]] && due=$(( now + 25 ))
        fi
        if [[ -n "$due" ]] && (( now >= due )); then
            c0=$seen
            _dgs_thread_pair "$pid" idle 10 "$hp" || return 0
            n=$(_dgs_lines "$ev")
            if (( n == c0 )); then return 0; fi
            _dgs_cpu_clear idle || return 1
            seen=$n; due=$(( $(_dgs_uptime_s) + 20 ))
        fi
        sleep 0.2
    done
    return 0
}

# Standalone pair (key 8 → threads, and the bundle's untimed sample). The pid
# must pass dgs_check_pid. Result: $DG_TMP/dgs_cpu_<label>.{tsv,top,kv}, DGS_C.
dgs_threads() {   # <pid> <dir> [secs] [label]
    local pid=$1 dir=$2 secs=${3:-10} label=${4:-now}
    DGS_C=()
    _dgs_need_tmp || return 1
    [[ "$secs" =~ ^[0-9]+$ ]] && (( secs >= 1 && secs <= 60 )) || secs=10
    if ! dgs_check_pid "$pid" "$dir"; then
        DGS_C[status]=pid_mismatch
        return 1
    fi
    if ! _dgs_thread_pair "$pid" "$label" "$secs"; then
        DGS_C[status]=error
        return 1
    fi
    _dgs_load_kv "$DG_TMP/dgs_cpu_$label.kv" DGS_C
    DGS_C[status]=ok
    return 0
}
