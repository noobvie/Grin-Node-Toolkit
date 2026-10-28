# =============================================================================
# lib/086_lib_stratum_baseline.sh — binary fingerprint, baselines, A/B compare (§10.7)
# =============================================================================
# Sourced by 086_grin_diagnostics.sh after 086_lib_stratum.sh, which it
# depends on (dgs_* state, _dgs_rm, _dgs_load_kv, _dgs_report_dir,
# _dgs_install_private, the shared DGS_BIN/DGS_QB/DGS_CMP arrays). It does not
# need the stack file. Sourced, not executed — no shebang, no `set -e`.
# =============================================================================

[[ -n "${_DGS_BASELINE_LOADED:-}" ]] && return 0
_DGS_BASELINE_LOADED=1

if [[ -z "${_DGS_LIB_LOADED:-}" ]]; then
    # shellcheck source=086_lib_stratum.sh
    source "$(dirname "${BASH_SOURCE[0]}")/086_lib_stratum.sh"
fi

# ─── §10.7  Binary fingerprint ───────────────────────────────────────────────
# Taken from the RUNNING process: /proc/<pid>/exe reads the image that runs,
# even when a newer file sits on disk. <dir>/.grin_binary_info
# has three writers in different shapes (design §10.7):
#   Script 01 key G   artifact = <store path>, source_ref = … (a real source
#                     build only), then the artifact's .info as "# " lines:
#                     "# commit = …", "# toolkit_patch = <name> sha256:<hex>",
#                     or "# sha256 = …" for an archived release
#   081 binary push   the same shape; artifact = a path on the CONTROLLER
#   081 upgrade       header "… official release …", artifact = a release tag
# Script 01's release install deletes the file, so no file is the normal state
# of a release install and says nothing either way.
# Result: DGS_BIN and $DG_TMP/dgs_bin.kv:
#   sha256 sha12 record(present|absent) provenance record_provenance
#   source_ref commit artifact artifact_check patches patch_<n>
# provenance: source_build | archived_release | release | no_record | swapped.
# A record whose artifact (or recorded sha256) no longer hashes to the running
# exe is `swapped`; record_provenance keeps what the record said.
# artifact_check: match | mismatch | record_match | record_mismatch |
#                 not_on_box | none (no path to hash, e.g. a release tag) |
#                 n/a | unreadable
dgs_binary_fingerprint() {   # <pid> <dir>
    local pid=$1 dir=$2 info="$2/.grin_binary_info" sha asha prov chk art k
    local -A R=()
    DGS_BIN=()
    _dgs_need_tmp || return 1
    sha=$(sha256sum "$_DGS_PROC/$pid/exe" 2>/dev/null | cut -c1-64)
    [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || sha=""
    DGS_BIN[sha256]=$sha; DGS_BIN[sha12]=${sha:0:12}
    if [[ ! -f "$info" ]]; then
        DGS_BIN[record]=absent; DGS_BIN[provenance]=no_record; DGS_BIN[artifact_check]=n/a
    else
        DGS_BIN[record]=present
        awk '
            function val(s) { sub(/^[^=]*=[ \t]*/, "", s); sub(/[ \t\r]+$/, "", s); return s }
            NR == 1 && index(tolower($0), "official release") { rel = 1 }
            /^source_ref[ \t]*=/           { sref = val($0) }
            /^artifact[ \t]*=/             { art = val($0) }
            /^#[ \t]*commit[ \t]*=/        { com = val($0) }
            /^#[ \t]*toolkit_patch[ \t]*=/ { np++; p[np] = val($0) }
            /^#[ \t]*sha256[ \t]*=/        { rs = val($0) }
            END {
                printf "release=%d\nsource_ref=%s\nartifact=%s\ncommit=%s\nrecord_sha256=%s\npatches=%d\n", \
                    rel, sref, art, com, rs, np
                for (i = 1; i <= np; i++) printf "patch_%d=%s\n", i, p[i]
            }' "$info" > "$DG_TMP/dgs_bin.rec" || { error "Cannot read $info"; return 1; }
        _dgs_load_kv "$DG_TMP/dgs_bin.rec" R
        _dgs_rm "$DG_TMP/dgs_bin.rec" || return 1
        if [[ -n "${R[source_ref]:-}" || -n "${R[commit]:-}" ]]; then prov=source_build
        elif [[ -n "${R[record_sha256]:-}" ]]; then prov=archived_release
        elif [[ "${R[release]:-0}" == 1 ]]; then prov=release
        else prov=no_record
        fi
        # A source build's .info has no sha256 of the binary, so hashing the
        # artifact is the only check; an archived release also carries one.
        art=${R[artifact]:-}
        if [[ -z "$sha" ]]; then
            chk=unreadable
        elif [[ "$art" == /* && -f "$art" ]]; then
            asha=$(sha256sum "$art" 2>/dev/null | cut -c1-64)
            if [[ "$asha" == "$sha" ]]; then chk=match; else chk=mismatch; fi
        elif [[ "${R[record_sha256]:-}" =~ ^[0-9a-f]{64}$ ]]; then
            if [[ "${R[record_sha256]}" == "$sha" ]]; then chk=record_match; else chk=record_mismatch; fi
        elif [[ "$art" == /* ]]; then
            chk=not_on_box
        else
            chk=none
        fi
        DGS_BIN[record_provenance]=$prov
        [[ "$chk" == mismatch || "$chk" == record_mismatch ]] && prov=swapped
        DGS_BIN[provenance]=$prov; DGS_BIN[artifact_check]=$chk
        for k in source_ref commit artifact patches; do DGS_BIN[$k]=${R[$k]:-}; done
        for k in "${!R[@]}"; do [[ "$k" == patch_* ]] && DGS_BIN[$k]=${R[$k]}; done
    fi
    for k in "${!DGS_BIN[@]}"; do printf '%s=%s\n' "$k" "${DGS_BIN[$k]}"; done > "$DG_TMP/dgs_bin.kv" \
        || { error "Cannot write $DG_TMP/dgs_bin.kv"; return 1; }
    return 0
}

# ─── §10.7  Baseline files and the A/B compare ───────────────────────────────
# One run = two files at the top level of REPORT_DIR, both mode 600 and named
# with the same UTC stamp:
#   stratum_<net>_<stamp>.txt   the screen (dgs_save_screen)
#   stratum_<net>_<stamp>.json  the baseline record (dgs_baseline_save)
# Key 6 deletes only the .txt screens; the .json baselines stay, so a
# before/after compare still works months later (operator decision, §10.7).
# JSON is read and written by the python3 helper below: without python3 there
# is no baseline and no compare (§10.2.2).

dgs_report_stamp() { DGS_STAMP=$(date -u +%Y%m%d_%H%M%S); }

# Saves the captured screen (ANSI colours removed) as the run's .txt. The
# caller captures it with `> >(tee <file>)`, never `| tee` (§4).
# Sets DGS_SCREEN_FILE.
dgs_save_screen() {   # <captured-screen-file>
    local src=$1 dst esc=$'\033' plain="$DG_TMP/dgs_screen.plain"
    DGS_SCREEN_FILE=""
    _dgs_need_tmp || return 1
    [[ -r "$src" ]] || { error "Screen copy $src not readable."; return 1; }
    [[ "$DGS_NET" == mainnet || "$DGS_NET" == testnet ]] || { error "No network for the report name."; return 1; }
    [[ -n "$DGS_STAMP" ]] || dgs_report_stamp
    _dgs_report_dir || return 1
    dst="$REPORT_DIR/stratum_${DGS_NET}_${DGS_STAMP}.txt"
    sed "s/${esc}\[[0-9;]*[A-Za-z]//g" "$src" > "$plain" || { error "Cannot write $plain"; return 1; }
    _dgs_install_private "$plain" "$dst" || return 1
    _dgs_rm "$plain" || true
    DGS_SCREEN_FILE=$dst
    return 0
}

IFS= read -r -d '' _DGS_BL_PY <<'PY' || true
import json, os, sys

PROBE_KEYS = ("n", "p50_s", "p95_s", "max_s", "bound_s", "refresh_p50_s",
              "deadline_build_s", "reorgs", "queued", "stale_on_arrival",
              "superseded", "loss_pct", "block_interval_s")
MAX_BYTES = 65536           # a baseline is under 2 KB; anything larger is not one
NOISE_FLOOR_S = 0.5         # below this both runs read "healthy"; no 2x test


def num(s):
    if s is None or s == "":
        return None
    try:
        return int(s)
    except ValueError:
        pass
    try:
        return float(s)
    except ValueError:
        return None


def isnum(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def read_kv(path):
    d = {}
    with open(path) as f:
        for line in f:
            k, sep, v = line.rstrip("\n").partition("=")
            if sep:
                d[k] = v
    return d


def write_private(path, text):
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(tmp, path)


def write_plain(path, lines):
    with open(path, "w") as f:
        f.write("".join(l + "\n" for l in lines))


def g(r, *path):
    for k in path:
        if not isinstance(r, dict):
            return None
        r = r.get(k)
    return r


def fmt(v):
    if v is None:
        return ""
    return " ".join(str(v).split())


def load(path):
    if os.path.getsize(path) > MAX_BYTES:
        raise ValueError("too large")
    with open(path) as f:
        r = json.load(f)
    if not (isinstance(r, dict) and r.get("kind") == "stratum_latency" and r.get("v") == 1):
        raise ValueError("not a stratum baseline")
    return r


def load_dir(d, net):
    out = []
    prefix = "stratum_%s_" % net
    try:
        names = os.listdir(d)
    except OSError:
        return out
    for name in names:
        if not (name.startswith(prefix) and name.endswith(".json")):
            continue
        p = os.path.join(d, name)
        try:
            r = load(p)
        except (OSError, ValueError):
            continue
        if r.get("net") == net:
            out.append((p, r))
    out.sort(key=lambda pr: (str(pr[1].get("at") or ""), pr[0]), reverse=True)
    return out


def stale_pct(r):
    rj = r.get("rejects") or {}
    acc, st = rj.get("accepted"), rj.get("stale")
    if not isnum(acc) or not acc or not isnum(st):
        return None
    tot = st + (rj.get("low_diff") or 0) + (rj.get("invalid") or 0)
    return round(st * 100.0 / (acc + tot), 1)


def cmd_write(kvp, probep, statp, out):
    kv = read_kv(kvp)
    with open(probep) as f:
        pj = json.load(f)
    probe = dict((k, pj.get(k)) for k in PROBE_KEYS)
    probe["rows"] = [{"tip": r.get("tip"), "seen": r.get("seen"), "job": r.get("job"),
                      "lat_s": r.get("lat_s"), "flags": r.get("flags") or []}
                     for r in (pj.get("rows") or [])]
    pk = sorted((k for k in kv if k.startswith("bin.patch_") and k[10:].isdigit()),
                key=lambda k: int(k[10:]))
    binary = {"user_agent": kv.get("bin.user_agent") or None,
              "sha256": kv.get("bin.sha256") or None,
              "source_ref": kv.get("bin.source_ref") or None,
              "commit": kv.get("bin.commit") or None,
              "toolkit_patches": [kv[k] for k in pk],
              "provenance": kv.get("bin.provenance") or "no_record"}
    config = {"stratum_addr": kv.get("cfg.stratum_addr") or None,
              "attempt_time_per_block": num(kv.get("cfg.attempt_time_per_block")),
              "file_log_level": kv.get("cfg.file_log_level") or None,
              "poll_ms": num(kv.get("cfg.poll_ms"))}
    log = {"available": kv.get("log.state") == "debug"}
    if log["available"]:
        log["window_h"] = num(kv.get("log.window_h"))
        log["new_n"] = num(kv.get("log.new_n"))
        log["refresh_n"] = num(kv.get("log.refresh_n"))
        try:
            with open(statp) as f:
                for line in f:
                    p = line.rstrip("\n").split("\t")
                    if len(p) >= 6 and p[0] == "new" and p[1] == "total":
                        log["new_p50_s"], log["new_p95_s"] = num(p[3]), num(p[4])
                    elif len(p) >= 6 and p[0] == "new" and p[1] == "C":
                        log["new_c_p95_s"] = num(p[4])
        except OSError:
            pass
    if "rej.stale" in kv:
        inv = (num(kv.get("rej.invalid")) or 0) + (num(kv.get("rej.invalid_share")) or 0)
        rejects = {"window_h": num(kv.get("rej.window_h")), "stale": num(kv.get("rej.stale")),
                   "low_diff": num(kv.get("rej.low_diff")), "invalid": inv,
                   "accepted": num(kv.get("rej.accepted")),
                   "pattern": kv.get("rej.pattern") or None}
    else:
        rejects = {"available": False}
    cpu = {"stratum_server_pct": num(kv.get("cpu.stratum_pct")),
           "steal_pct": num(kv.get("cpu.steal_pct")),
           "iowait_pct": num(kv.get("cpu.iowait_pct")),
           "psi_cpu_avg60": num(kv.get("cpu.psi_cpu_avg60"))}
    rec = {"v": 1, "kind": "stratum_latency", "net": kv.get("net"), "at": kv.get("at"),
           "binary": binary, "config": config, "probe": probe, "log": log,
           "rejects": rejects, "cpu": cpu}
    write_private(out, json.dumps(rec, separators=(",", ":")) + "\n")
    return 0


def cmd_list(d, net, running, out_tsv, out_kv):
    recs = load_dir(d, net)
    lines = []
    for p, r in recs:
        sha = fmt(g(r, "binary", "sha256"))
        lines.append("\t".join([p, fmt(r.get("at")), fmt(g(r, "binary", "user_agent")), sha[:12],
                                fmt(g(r, "probe", "p95_s")), fmt(g(r, "probe", "n")),
                                fmt(g(r, "binary", "provenance")), fmt(g(r, "config", "poll_ms")),
                                fmt(g(r, "config", "attempt_time_per_block")), sha]))
    a = None
    if running:
        a = next((pr for pr in recs if g(pr[1], "binary", "sha256") == running), None)
    if a is None and recs:
        a = recs[0]
    b = None
    if a is not None:
        asha = g(a[1], "binary", "sha256")
        b = next((pr for pr in recs if g(pr[1], "binary", "sha256") != asha), None)
    write_plain(out_tsv, lines)
    write_plain(out_kv, ["count=%d" % len(recs),
                         "default_a=%s" % (a[0] if a else ""),
                         "default_b=%s" % (b[0] if b else "")])
    return 0


def quick_fields(p, r):
    sha = fmt(g(r, "binary", "sha256"))
    return [("file", p), ("at", r.get("at")), ("n", g(r, "probe", "n")),
            ("p50_s", g(r, "probe", "p50_s")), ("p95_s", g(r, "probe", "p95_s")),
            ("max_s", g(r, "probe", "max_s")), ("loss_pct", g(r, "probe", "loss_pct")),
            ("user_agent", g(r, "binary", "user_agent")),
            ("provenance", g(r, "binary", "provenance")),
            ("source_ref", g(r, "binary", "source_ref")), ("sha12", sha[:12]),
            ("stratum_cpu_pct", g(r, "cpu", "stratum_server_pct")),
            ("steal_pct", g(r, "cpu", "steal_pct")),
            ("psi_cpu_avg60", g(r, "cpu", "psi_cpu_avg60"))]


def cmd_quick(d, net, sha, out_kv):
    for p, r in load_dir(d, net):
        if sha and g(r, "binary", "sha256") == sha:
            write_plain(out_kv, ["status=found"] + ["%s=%s" % (k, fmt(v)) for k, v in quick_fields(p, r)])
            return 0
    write_plain(out_kv, ["status=none"])
    return 0


METRICS = (("p50_s", "lat", lambda r: g(r, "probe", "p50_s")),
           ("p95_s", "lat", lambda r: g(r, "probe", "p95_s")),
           ("max_s", "lat", lambda r: g(r, "probe", "max_s")),
           ("deadline_build_s", "build", lambda r: g(r, "probe", "deadline_build_s")),
           ("loss_pct", "lat", lambda r: g(r, "probe", "loss_pct")),
           ("stale_pct", "log", stale_pct),
           ("stratum_cpu_pct", "cpu", lambda r: g(r, "cpu", "stratum_server_pct")))


def cmd_compare(pa, pb, out_tsv, out_kv):
    ra, rb = load(pa), load(pb)
    pd = g(ra, "config", "poll_ms") != g(rb, "config", "poll_ms")
    ad = g(ra, "config", "attempt_time_per_block") != g(rb, "config", "attempt_time_per_block")
    rows = []
    for name, kind, fn in METRICS:
        va, vb = fn(ra), fn(rb)
        d = round(vb - va, 2) if isnum(va) and isnum(vb) else None
        mark = "config" if (kind == "lat" and pd) or (kind == "build" and ad) else ""
        rows.append("\t".join([name, fmt(va), fmt(vb), fmt(d), mark]))
    sa, sb = g(ra, "binary", "sha256"), g(rb, "binary", "sha256")
    same = bool(sa) and sa == sb
    noise = False
    if same:
        for key in ("p50_s", "p95_s"):
            va, vb = g(ra, "probe", key), g(rb, "probe", key)
            if isnum(va) and isnum(vb):
                hi, lo = max(va, vb), min(va, vb)
                if hi >= NOISE_FLOOR_S and hi > 2 * lo:
                    noise = True
    diff = [k for k, f in (("poll_ms", pd), ("attempt_time_per_block", ad)) if f]
    kv = ["same_sha=%d" % same, "noise=%d" % noise, "config_diff=%s" % ",".join(diff)]
    for side, p, r in (("a", pa, ra), ("b", pb, rb)):
        kv += ["%s_file=%s" % (side, p), "%s_at=%s" % (side, fmt(r.get("at"))),
               "%s_user_agent=%s" % (side, fmt(g(r, "binary", "user_agent"))),
               "%s_sha12=%s" % (side, fmt(g(r, "binary", "sha256"))[:12]),
               "%s_provenance=%s" % (side, fmt(g(r, "binary", "provenance"))),
               "%s_source_ref=%s" % (side, fmt(g(r, "binary", "source_ref"))),
               "%s_n=%s" % (side, fmt(g(r, "probe", "n"))),
               "%s_poll_ms=%s" % (side, fmt(g(r, "config", "poll_ms"))),
               "%s_attempt=%s" % (side, fmt(g(r, "config", "attempt_time_per_block")))]
    write_plain(out_tsv, rows)
    write_plain(out_kv, kv)
    return 0


def main():
    cmds = {"write": (cmd_write, 4), "list": (cmd_list, 5), "quick": (cmd_quick, 4),
            "compare": (cmd_compare, 4)}
    if len(sys.argv) < 2 or sys.argv[1] not in cmds or len(sys.argv) - 2 != cmds[sys.argv[1]][1]:
        sys.stderr.write("usage: write|list|quick|compare <args>\n")
        return 2
    os.umask(0o077)
    try:
        return cmds[sys.argv[1]][0](*sys.argv[2:])
    except (OSError, ValueError) as e:
        sys.stderr.write("%s: %s\n" % (type(e).__name__, e))
        return 1


if __name__ == "__main__":
    sys.exit(main())
PY

_dgs_bl_py() {   # <subcommand> <args...> — runs the helper, stderr shown on failure
    local py="$DG_TMP/dgs_bl.py" err="$DG_TMP/dgs_bl.err" rc
    printf '%s' "$_DGS_BL_PY" > "$py" || { error "Cannot write $py"; return 1; }
    python3 -I "$py" "$@" 2> "$err"; rc=$?
    if (( rc != 0 )); then
        error "Baseline helper failed ($1, exit $rc): $(tail -n 3 "$err" 2>/dev/null | tr '\n' ' ' | cut -c1-200)"
    fi
    _dgs_rm "$py" "$err" || true
    return "$rc"
}

# Writes $REPORT_DIR/stratum_<net>_<DGS_STAMP>.json (mode 600), the §10.7
# record, from the last probe ($DG_TMP/dgs_probe.json, DGS_P), DGS_B with
# $DG_TMP/dgs_build.stat, DGS_R, DGS_CT (the pair across a new tip),
# DGS_PSI_CPU60 and a fresh dgs_binary_fingerprint of DGS_PID. The caller
# may set DGS_B[window_h] (the log window's hours) for log.window_h.
# Sets DGS_BL_FILE, or DGS_BL_STATUS no_python | no_probe | no_blocks | error.
# A run that measured no block writes no baseline: key 1 would only read it
# as "0 blocks measured".
dgs_baseline_save() {
    local in="$DG_TMP/dgs_bl.in" dst k
    DGS_BL_STATUS=""; DGS_BL_FILE=""
    _dgs_need_tmp || { DGS_BL_STATUS=error; return 1; }
    if ! dg_have python3; then DGS_BL_STATUS=no_python; return 1; fi
    if [[ ! -s "$DG_TMP/dgs_probe.json" ]]; then DGS_BL_STATUS=no_probe; return 1; fi
    if (( $(_dg_num "${DGS_P[n]:-0}") < 1 )); then DGS_BL_STATUS=no_blocks; return 1; fi
    [[ "$DGS_NET" == mainnet || "$DGS_NET" == testnet ]] || { error "No network for the baseline name."; DGS_BL_STATUS=error; return 1; }
    dgs_binary_fingerprint "$DGS_PID" "$DGS_DIR" || { DGS_BL_STATUS=error; return 1; }
    [[ -n "$DGS_STAMP" ]] || dgs_report_stamp
    _dgs_report_dir || { DGS_BL_STATUS=error; return 1; }
    dst="$REPORT_DIR/stratum_${DGS_NET}_${DGS_STAMP}.json"
    {
        printf 'net=%s\nat=%s-%s-%sT%s:%s:%sZ\n' "$DGS_NET" "${DGS_STAMP:0:4}" "${DGS_STAMP:4:2}" \
            "${DGS_STAMP:6:2}" "${DGS_STAMP:9:2}" "${DGS_STAMP:11:2}" "${DGS_STAMP:13:2}"
        printf 'bin.user_agent=%s\n' "${DGS_P[user_agent]:-}"
        for k in "${!DGS_BIN[@]}"; do printf 'bin.%s=%s\n' "$k" "${DGS_BIN[$k]}"; done
        printf 'cfg.stratum_addr=%s\ncfg.attempt_time_per_block=%s\ncfg.file_log_level=%s\ncfg.poll_ms=%s\n' \
            "$DGS_ADDR" "$DGS_ATTEMPT" "$DGS_LOG_LEVEL" "${DGS_P[poll_ms]:-}"
        for k in "${!DGS_B[@]}"; do printf 'log.%s=%s\n' "$k" "${DGS_B[$k]}"; done
        for k in "${!DGS_R[@]}"; do printf 'rej.%s=%s\n' "$k" "${DGS_R[$k]}"; done
        for k in "${!DGS_CT[@]}"; do printf 'cpu.%s=%s\n' "$k" "${DGS_CT[$k]}"; done
        printf 'cpu.psi_cpu_avg60=%s\n' "$DGS_PSI_CPU60"
    } > "$in" || { error "Cannot write $in"; DGS_BL_STATUS=error; return 1; }
    if ! _dgs_bl_py write "$in" "$DG_TMP/dgs_probe.json" "$DG_TMP/dgs_build.stat" "$dst"; then
        _dgs_rm "$in" "$dst.tmp" || true
        DGS_BL_STATUS=error; return 1
    fi
    _dgs_rm "$in" || true
    chmod 600 "$dst" || { error "Cannot set mode 600 on $dst"; DGS_BL_STATUS=error; return 1; }
    DGS_BL_FILE=$dst
    log "[086] stratum baseline $dst sha ${DGS_BIN[sha12]:-?} provenance ${DGS_BIN[provenance]:-?}"
    return 0
}

# Saved baselines for <net>, newest first, for the compare picker.
# Result: $DG_TMP/dgs_bl.tsv
#   file · at · user_agent · sha12 · p95_s · n · provenance · poll_ms ·
#   attempt_time_per_block · sha256
# DGS_BL_COUNT; DGS_BL_DEFAULT_A = newest run of <running-sha> (else the
# newest run); DGS_BL_DEFAULT_B = newest run of a different sha (or empty).
dgs_baseline_list() {   # <net> [running-sha]
    local net=$1 run=${2:-}
    local -A L=()
    DGS_BL_COUNT=0; DGS_BL_DEFAULT_A=""; DGS_BL_DEFAULT_B=""
    _dgs_need_tmp || return 1
    dg_have python3 || { error "python3 is needed to read baselines."; return 1; }
    [[ -n "${REPORT_DIR:-}" ]] || { error "REPORT_DIR is not set."; return 1; }
    _dgs_rm "$DG_TMP/dgs_bl.tsv" "$DG_TMP/dgs_bl.kv" || return 1
    _dgs_bl_py list "$REPORT_DIR" "$net" "$run" "$DG_TMP/dgs_bl.tsv" "$DG_TMP/dgs_bl.kv" || return 1
    _dgs_load_kv "$DG_TMP/dgs_bl.kv" L
    DGS_BL_COUNT=$(_dg_num "${L[count]:-0}")
    DGS_BL_DEFAULT_A=${L[default_a]:-}; DGS_BL_DEFAULT_B=${L[default_b]:-}
    _dgs_rm "$DG_TMP/dgs_bl.kv" || true
    return 0
}

# Side-by-side data for two baselines (A = before, B = after; Δ = B − A).
# Result: $DG_TMP/dgs_cmp.tsv  metric · A · B · Δ · mark, for p50_s, p95_s,
#   max_s, deadline_build_s, loss_pct, stale_pct, stratum_cpu_pct. mark is
#   "config" where the two runs' poll_ms (latency rows) or
#   attempt_time_per_block (deadline_build_s) differ: not comparable.
# DGS_CMP: same_sha, noise (1 = same sha and p50 or p95 differ by more than
#   2x above 0.5 s: "host noise likely; repeat both"), config_diff, and per
#   side a_/b_: file at user_agent sha12 provenance source_ref n poll_ms attempt.
dgs_baseline_compare() {   # <file-a> <file-b>
    DGS_CMP=()
    _dgs_need_tmp || return 1
    dg_have python3 || { error "python3 is needed to compare baselines."; return 1; }
    _dgs_rm "$DG_TMP/dgs_cmp.tsv" "$DG_TMP/dgs_cmp.kv" || return 1
    _dgs_bl_py compare "$1" "$2" "$DG_TMP/dgs_cmp.tsv" "$DG_TMP/dgs_cmp.kv" || return 1
    _dgs_load_kv "$DG_TMP/dgs_cmp.kv" DGS_CMP
    return 0
}

# Key 1's reader: the newest stratum_<net>_*.json whose binary.sha256 is the
# running exe's hash. It never runs the probe.
# DGS_QB: status found | none | no_python | no_exe, and when found: file at n
#   p50_s p95_s max_s loss_pct user_agent provenance source_ref sha12
#   stratum_cpu_pct steal_pct psi_cpu_avg60.
dgs_quick_baseline() {   # <net> <pid>
    local net=$1 pid=$2 sha
    DGS_QB=()
    _dgs_need_tmp || return 1
    if ! dg_have python3; then DGS_QB[status]=no_python; return 0; fi
    sha=$(sha256sum "$_DGS_PROC/$pid/exe" 2>/dev/null | cut -c1-64)
    if [[ ! "$sha" =~ ^[0-9a-f]{64}$ ]]; then DGS_QB[status]=no_exe; return 0; fi
    [[ -n "${REPORT_DIR:-}" ]] || { error "REPORT_DIR is not set."; return 1; }
    _dgs_rm "$DG_TMP/dgs_qb.kv" || return 1
    _dgs_bl_py quick "$REPORT_DIR" "$net" "$sha" "$DG_TMP/dgs_qb.kv" || return 1
    _dgs_load_kv "$DG_TMP/dgs_qb.kv" DGS_QB
    _dgs_rm "$DG_TMP/dgs_qb.kv" || true
    return 0
}
