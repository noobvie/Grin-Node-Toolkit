#!/usr/bin/env python3
"""
07_mining_block_collector.py — Grin solo-mining stats collector.

Parses a grin node log (incrementally) for two kinds of stratum lines:

  * Block solved (WARN):
      (Server ID: <id>) Solution Found for block <HEIGHT>, hash <H> - Yay!!! ...
  * Accepted share (INFO):
      (Server ID: <id>) Got share at height <H>, hash <X>, edge_bits <E>,
      nonce <N>, job_id <J>, difficulty <ACTUAL>/<TARGET>, submitted by <WORKER>

From these it maintains, per network:
  - a rolling record of blocks this node SOLVED  → blocks_<key>.json
  - per-worker hashrate over 15m / 12h / 24h / 48h, online/offline, with workers
    silent > 7 days pruned                        → miners_<key>.json
  - a rolling daily-average POOL hashrate history (per UTC day, ~400 days, for the
    daily/weekly/monthly trend chart)             → hashrate_<key>.json
  - a miningpoolstats-friendly pool+network summary → poolstats_<key>.json

It also queries the node Owner API (get_status, localhost, reading .api_secret)
to fill network height / difficulty / hashrate for poolstats.

DURABLE STATE: all long-lived state (found blocks, per-worker buckets, daily
hashrate history, payout ledger, log position) lives in ONE SQLite database per
network — <state-dir>/solo_mining_stats_<key>.db (Python stdlib sqlite3, no external
dependency, rollback-journal + synchronous=FULL so a crash mid-write recovers to
the last committed run). The JSON files above are derived VIEWS, regenerated each
run for the static web page to fetch. On the first run after upgrading from the
old JSON-state build, <state-dir>/stats_<key>.state.json and
payment_ledger_main.json are auto-imported once, then left in place (inert).

MAINNET-only payout split (trusted-group payment calculation):
  - an append-only DAILY ledger (UTC day-keyed: per-worker share-difficulty +
    chain-verified matured-block count) → <state-dir>/payment_ledger_main.json
  - a public per-period split (daily/weekly/monthly/yearly: nickname → % + GRIN
    owed, NO addresses) → <out-dir>/split_main.json, toggled by --payment-config
    (default /opt/grin/conf/grin_solo_payment.json). {"enabled": true} groups
    miners by nickname — the text before the first dot in nickname.NN.
  This module computes only — it never holds keys, moves money, or stores a Grin
  address. Matured blocks are CHAIN-VERIFIED at 1440 maturity (Foreign API
  get_block) so an orphaned solution never inflates a payout.

CAVEATS (log-parsing source):
  * Share lines are INFO level — the node's file_log_level must be INFO (or finer)
    or per-worker stats stay empty (blocks still work; Solution Found is WARN).
  * Found blocks are not verified against the chain, so an orphaned solution may
    be counted. Hashrate is a share-difficulty estimate. Run with --dry-run to
    preview matches and tune the regexes for your node version.

Usage:
  07_mining_block_collector.py --net mainnet \\
      --log /opt/grin/node/mainnet-prune/grin-server.log \\
      --state-dir /opt/grin/solo-stats \\
      --out-dir /var/www/grin-solo-mining-stat/data
  07_mining_block_collector.py --net mainnet --log <file> --dry-run
"""

import argparse
import base64
import glob
import gzip
import json
import os
import re
import sqlite3
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timedelta, timezone

# Block-solved line. Group 'h' = block height, 'hash' = block hash (hex).
FOUND_RE = re.compile(
    r"Solution\s+Found\s+for\s+block\s+(?P<h>\d+)\s*,\s*hash\s+(?P<hash>[0-9a-fA-F]+)",
    re.I,
)

# Accepted-share line. 'w' = worker/login. The 'd' (actual difficulty) field is
# matched to anchor the line shape but intentionally NOT summed — see
# SHARE_CREDIT_DIFF for why each share is credited a fixed difficulty instead.
SHARE_RE = re.compile(
    r"Got share at height\s+\d+.*?difficulty\s+(?P<d>\d+)\s*/\s*\d+.*?submitted by\s+(?P<w>\S+)",
    re.I,
)

# grin log timestamp prefix, e.g. "20260531 12:00:00.123"
TS_RE = re.compile(r"^(\d{8})\s+(\d{2}:\d{2}:\d{2})(?:\.\d+)?")

BUCKET = 60                      # share-difficulty bucket size (seconds)
WINDOWS = {"15m": 900, "12h": 43200, "24h": 86400, "48h": 172800}
ONLINE_THRESHOLD = 900           # no share within 15 min ⇒ worker offline
WORKER_TTL = 7 * 86400           # prune workers silent for 7 days
BLOCK_RETENTION = 1830 * 86400   # bound found-block history (~5 yr, covers yearly graph)
HR_HISTORY_RETENTION_DAYS = 1830 # daily pool-hashrate history depth (~5 yr, covers yearly graph)
RECENT_CAP = 2000                # max blocks in the output list (covers a 5-yr yearly chart)
C32_SCALE = 16384                # Cuckatoo32 solution-rate constant (32 * 2^9)

# Per-share work credit. minimum_share_difficulty defaults to 1 — below the C32
# floor — so the node submits EVERY cycle a miner finds and logs its raw ACTUAL
# difficulty. That actual difficulty is Pareto/heavy-tailed (A ≈ 16384 / U) with
# an effectively infinite mean, so SUMMING it makes the hashrate estimate explode
# on the occasional lucky high-difficulty share (e.g. one near-block share alone
# can add >100 G/s to a 15-min window). Instead we credit each accepted share a
# FIXED difficulty: the C32 floor (16384) — the lowest difficulty any valid cycle
# can score, and thus the effective target every share clears. Fed through
# hashrate_gps() this gives GPS = share_count × 42 / window, which is
# self-consistent with the network hashrate formula and low-variance (Poisson in
# the share count). It also makes the payout split credit work by share count
# rather than by luck.
# NOTE: assumes minimum_share_difficulty ≤ 16384 (grin/toolkit default = 1, so
# every cycle is submitted). If an operator raises it above the floor, set this
# to the configured target instead.
SHARE_CREDIT_DIFF = C32_SCALE

NODE_PORTS = {"mainnet": 3413, "testnet": 13413}

# ── Payout split (mainnet only) ────────────────────────────────────────────────
BLOCK_REWARD_GRIN = 60.0         # flat coinbase reward (Grin has no halving)
MAINNET_MATURITY = 1440          # COINBASE_MATURITY — blocks before reward spendable
DEFAULT_PAYMENT_CONFIG = "/opt/grin/conf/grin_solo_payment.json"
SPLIT_PERIODS = ("daily", "weekly", "monthly", "yearly")

# Default pool display name for the poolstats feed. Operators override it by
# setting "pool_name" in <out-dir>/config.json (see load_pool_name).
DEFAULT_POOL_NAME = "Grin Solo (Node Toolkit)"


# ── helpers ──────────────────────────────────────────────────────────────────
def parse_epoch(line):
    """Epoch seconds from a grin log line's timestamp (local tz), or None."""
    m = TS_RE.match(line)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1) + " " + m.group(2), "%Y%m%d %H:%M:%S").timestamp()
    except ValueError:
        return None


def open_maybe_gz(path):
    if path.endswith(".gz"):
        return gzip.open(path, "rt", errors="replace")
    return open(path, "r", errors="replace")


def iso(epoch):
    return datetime.fromtimestamp(epoch).isoformat(timespec="seconds")


def hashrate_gps(sum_diff, window_s):
    if window_s <= 0:
        return 0.0
    return sum_diff * 42.0 / C32_SCALE / window_s


def _read_json(path):
    """Read a JSON file → dict, or {} if missing/unreadable (legacy import only)."""
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def load_pool_name(out_dir):
    """Read the operator-set pool display name from <out-dir>/config.json.
    Falls back to DEFAULT_POOL_NAME when out-dir is unset, the file is missing
    /unreadable, or "pool_name" is absent or blank. config.json is the same
    operator-editable file that already carries host + slogan, so renaming the
    feed needs no redeploy — the next 5-min collector run picks it up.
    """
    if not out_dir:
        return DEFAULT_POOL_NAME
    try:
        with open(os.path.join(out_dir, "config.json")) as fh:
            name = json.load(fh).get("pool_name")
    except (OSError, ValueError, AttributeError):
        return DEFAULT_POOL_NAME
    if isinstance(name, str) and name.strip():
        return name.strip()
    return DEFAULT_POOL_NAME


def save_json_atomic(path, obj, mode=0o600):
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(obj, fh, separators=(",", ":"))
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


# ── SQLite persistence ─────────────────────────────────────────────────────────
# All durable state lives in <state-dir>/solo_mining_stats_<key>.db (one DB per network; the
# mainnet/testnet collector runs never share a file, so no locking contention).
# The in-memory processing below is UNCHANGED — these helpers just load every
# table into the same dict shapes the build_* functions already expect, and write
# them back in a single transaction. Rollback-journal mode (the default) leaves a
# single .db file at rest between the 5-min runs, so the tar backup of
# /opt/grin/solo-stats/ captures a consistent snapshot; synchronous=FULL makes a
# crash mid-write recover to the last committed run (never a torn file).
DB_SCHEMA = """
PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS meta          (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS found_blocks  (height INTEGER PRIMARY KEY, ts REAL NOT NULL, hash TEXT);
CREATE TABLE IF NOT EXISTS workers       (worker TEXT PRIMARY KEY, last_seen REAL NOT NULL);
CREATE TABLE IF NOT EXISTS worker_buckets(worker TEXT NOT NULL, bucket INTEGER NOT NULL, diff REAL NOT NULL, PRIMARY KEY (worker, bucket));
CREATE TABLE IF NOT EXISTS hr_days       (day TEXT PRIMARY KEY, diff_sum INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ledger_days   (day TEXT PRIMARY KEY, blocks_matured INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS ledger_worker (day TEXT NOT NULL, worker TEXT NOT NULL, diff INTEGER NOT NULL, PRIMARY KEY (day, worker));
CREATE TABLE IF NOT EXISTS ledger_blocks (height INTEGER PRIMARY KEY, status TEXT NOT NULL);
"""


def db_connect(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fresh = not os.path.exists(path)
    conn = sqlite3.connect(path, timeout=30)
    conn.executescript(DB_SCHEMA)
    if fresh:
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    return conn


def _meta_get(conn, key, default=None):
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row[0] if row else default


def _meta_set(conn, key, value):
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", (key, value))


def load_state_db(conn):
    """Read every state table back into the dict shapes the build_* code expects."""
    found, hashes = {}, {}
    for h, ts, hsh in conn.execute("SELECT height, ts, hash FROM found_blocks"):
        found[str(h)] = ts
        if hsh:
            hashes[str(h)] = hsh
    workers = {}
    for w, ls in conn.execute("SELECT worker, last_seen FROM workers"):
        workers[w] = {"last_seen": ls, "buckets": {}}
    for w, b, d in conn.execute("SELECT worker, bucket, diff FROM worker_buckets"):
        wk = workers.get(w)
        if wk is not None:
            wk["buckets"][str(b)] = d
    hr_days = {day: ds for day, ds in conn.execute("SELECT day, diff_sum FROM hr_days")}
    net_prev = json.loads(_meta_get(conn, "net_prev", "{}"))
    log_pos = json.loads(_meta_get(conn, "log_pos", "{}"))
    return {"found": found, "hashes": hashes, "workers": workers,
            "net_prev": net_prev, "hr_days": hr_days, "log_pos": log_pos}


def save_state_db(conn, state):
    """Replace every state table from the in-memory dicts in one transaction.
    Full table replace (not incremental) mirrors the old whole-file JSON rewrite —
    correct and simple; the row counts here (≤ a few ×10k buckets) are trivial for
    SQLite, and the build_* code has already pruned the dicts before this runs."""
    with conn:
        conn.execute("DELETE FROM found_blocks")
        conn.executemany(
            "INSERT INTO found_blocks(height, ts, hash) VALUES (?, ?, ?)",
            [(int(h), ts, state["hashes"].get(h)) for h, ts in state["found"].items()])
        conn.execute("DELETE FROM workers")
        conn.execute("DELETE FROM worker_buckets")
        wrows, brows = [], []
        for w, wk in state["workers"].items():
            wrows.append((w, wk.get("last_seen", 0)))
            for b, d in wk.get("buckets", {}).items():
                brows.append((w, int(b), d))
        conn.executemany("INSERT INTO workers(worker, last_seen) VALUES (?, ?)", wrows)
        conn.executemany("INSERT INTO worker_buckets(worker, bucket, diff) VALUES (?, ?, ?)", brows)
        conn.execute("DELETE FROM hr_days")
        conn.executemany("INSERT INTO hr_days(day, diff_sum) VALUES (?, ?)",
                         [(day, int(v)) for day, v in state["hr_days"].items()])
        _meta_set(conn, "net_prev", json.dumps(state["net_prev"]))
        _meta_set(conn, "log_pos", json.dumps(state["log_pos"]))


def load_ledger_db(conn):
    """Payout ledger (mainnet) → {days: {day: {workers, blocks_matured}}, blocks}."""
    days = {}
    for day, bm in conn.execute("SELECT day, blocks_matured FROM ledger_days"):
        days[day] = {"workers": {}, "blocks_matured": bm}
    for day, w, d in conn.execute("SELECT day, worker, diff FROM ledger_worker"):
        if day in days:
            days[day]["workers"][w] = d
    blocks = {str(h): s for h, s in conn.execute("SELECT height, status FROM ledger_blocks")}
    return {"days": days, "blocks": blocks}


def save_ledger_db(conn, ledger):
    with conn:
        conn.execute("DELETE FROM ledger_days")
        conn.execute("DELETE FROM ledger_worker")
        conn.execute("DELETE FROM ledger_blocks")
        drows, wrows = [], []
        for day, e in ledger["days"].items():
            drows.append((day, int(e.get("blocks_matured", 0))))
            for w, d in (e.get("workers") or {}).items():
                wrows.append((day, w, int(d)))
        conn.executemany("INSERT INTO ledger_days(day, blocks_matured) VALUES (?, ?)", drows)
        conn.executemany("INSERT INTO ledger_worker(day, worker, diff) VALUES (?, ?, ?)", wrows)
        conn.executemany("INSERT INTO ledger_blocks(height, status) VALUES (?, ?)",
                         [(int(h), s) for h, s in ledger["blocks"].items()])


def migrate_legacy_json(conn, state_json, ledger_json, is_mainnet):
    """One-time auto-import of the pre-SQLite JSON files into the DB, on the first
    run after upgrade. Guarded by a meta flag so it runs exactly once (also set on
    a fresh install where no legacy file exists). Legacy files are left in place
    (inert) rather than deleted."""
    if _meta_get(conn, "legacy_imported"):
        return
    obj = _read_json(state_json)
    if isinstance(obj, dict) and obj:
        save_state_db(conn, {
            "found": obj.get("found", {}), "hashes": obj.get("hashes", {}),
            "workers": obj.get("workers", {}), "net_prev": obj.get("net_prev", {}),
            "hr_days": obj.get("hr_days", {}), "log_pos": obj.get("log_pos", {}),
        })
    if is_mainnet:
        led = _read_json(ledger_json)
        if isinstance(led, dict) and (led.get("days") or led.get("blocks")):
            save_ledger_db(conn, {"days": led.get("days", {}),
                                  "blocks": led.get("blocks", {})})
    with conn:
        _meta_set(conn, "legacy_imported", "1")


def query_node_status(net):
    """Return get_status 'Ok' dict (height, total_difficulty, connections) or None."""
    secret_path = f"/opt/grin/node/{net}-prune/.api_secret"
    try:
        with open(secret_path) as fh:
            secret = fh.read().strip()
    except OSError:
        return None
    port = NODE_PORTS[net]
    body = json.dumps({"jsonrpc": "2.0", "method": "get_status",
                       "params": [], "id": 1}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/v2/owner", data=body)
    req.add_header("Content-Type", "application/json")
    tok = base64.b64encode(f"grin:{secret}".encode()).decode()
    req.add_header("Authorization", "Basic " + tok)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
        return data.get("result", {}).get("Ok")
    except Exception:
        return None


def query_node_block(net, height):
    """Return the Foreign API get_block 'Ok' dict for `height`, or None.

    Used to chain-verify a found block at maturity: a None result means the node
    was unreachable (retry later); a result whose header.hash differs from the
    one we logged means our solution was orphaned (exclude from payouts).
    """
    secret_path = f"/opt/grin/node/{net}-prune/.foreign_api_secret"
    try:
        with open(secret_path) as fh:
            secret = fh.read().strip()
    except OSError:
        return None
    port = NODE_PORTS[net]
    body = json.dumps({"jsonrpc": "2.0", "method": "get_block",
                       "params": [int(height), None, None], "id": 1}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/v2/foreign", data=body)
    req.add_header("Content-Type", "application/json")
    tok = base64.b64encode(f"grin:{secret}".encode()).decode()
    req.add_header("Authorization", "Basic " + tok)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
        return data.get("result", {}).get("Ok")
    except Exception:
        return None


# ── payout split: UTC ledger + per-period calculation (mainnet only) ───────────
def utc_day(epoch):
    """UTC calendar-day key 'YYYY-MM-DD' for an epoch (split buckets by UTC day)."""
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%d")


def payout_split_enabled(path):
    """Payout-split on/off. True when the config file is present and not explicitly
    disabled ({"enabled": false}); False when absent/unreadable. Workers are grouped
    by nickname automatically — there are no names to pre-register."""
    try:
        with open(path) as fh:
            cfg = json.load(fh)
    except (OSError, ValueError):
        return False
    return isinstance(cfg, dict) and cfg.get("enabled") is not False


def _daily_worker_diff(workers, day):
    """Σ accepted share-difficulty per worker whose 60s bucket falls on UTC `day`."""
    out = {}
    for w, wk in workers.items():
        s = 0.0
        for b, v in wk.get("buckets", {}).items():
            if utc_day(int(b)) == day:
                s += v
        if s > 0:
            out[w] = int(round(s))
    return out


def update_ledger(ledger, workers, found, hashes, status, net, now):
    """Refresh the ledger (mutates + returns it).

    1. Rebuild TODAY's and YESTERDAY's per-worker share-diff from current buckets.
       The 48h bucket window always fully covers both UTC days, so the rewrite is
       idempotent; older days stay frozen (their buckets are already pruned).
    2. Count each found block ONCE, the run after it crosses 1440 maturity, but
       only if the node confirms our hash is the canonical block at that height
       (orphans are recorded and excluded; an unreachable node is retried).
    """
    for day in (utc_day(now - 86400), utc_day(now)):
        entry = ledger["days"].setdefault(day, {"workers": {}, "blocks_matured": 0})
        entry["workers"] = _daily_worker_diff(workers, day)

    tip = ((status or {}).get("tip") or {}).get("height")
    if tip is not None:
        for h in sorted(found, key=lambda x: int(x)):
            if h in ledger["blocks"]:
                continue
            if int(tip) < int(h) + MAINNET_MATURITY:
                continue
            blk = query_node_block(net, int(h))
            if blk is None:
                continue   # node unreachable — leave unmarked, retry next run
            chain_hash = ((blk.get("header") or {}).get("hash") or "").lower()
            stored = (hashes.get(h) or "").lower()
            # The "Solution Found ... hash X" log line emits an ABBREVIATED hash
            # (grin logs the first 6 bytes, e.g. 0000564ceb7e), while get_block
            # returns the full 64-hex header.hash. Compare on the common prefix:
            # a canonical block's full hash starts with the logged abbreviation;
            # an orphan at the same height has a different hash (a 48-bit / 12-hex
            # prefix collision is ~2^-48, so prefix match is safe for orphan
            # detection). Full-equality would mark EVERY block orphan.
            n = min(len(chain_hash), len(stored))
            if n > 0 and chain_hash[:n] == stored[:n]:
                e = ledger["days"].setdefault(utc_day(now),
                                              {"workers": {}, "blocks_matured": 0})
                e["blocks_matured"] = e.get("blocks_matured", 0) + 1
                ledger["blocks"][h] = "matured"
            else:
                ledger["blocks"][h] = "orphan"   # node answered, hash differs
    return ledger


def _nick_of(worker):
    """Group key = the nickname before the first dot (the nickname.NN convention),
    so a miner's rigs (alpha.01, alpha.02, …) settle as one payee. A worker name
    with no dot is its own group."""
    return worker.split(".", 1)[0]


def _window_days(period, now):
    """(label, from_day, to_day, [UTC day keys]) for a split period."""
    today = datetime.fromtimestamp(now, timezone.utc)

    def span(start):
        out, d = [], start
        while d <= today:
            out.append(d.strftime("%Y-%m-%d"))
            d += timedelta(days=1)
        return out

    if period == "daily":
        d = today.strftime("%Y-%m-%d")
        return d, d, d, [d]
    if period == "weekly":
        days = [(today - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(6, -1, -1)]
        return f"{days[0]} → {days[-1]}", days[0], days[-1], days
    if period == "monthly":
        days = span(today.replace(day=1))
        return today.strftime("%Y-%m"), days[0], days[-1], days
    days = span(today.replace(month=1, day=1))
    return today.strftime("%Y"), days[0], days[-1], days


def compute_split(ledger, now):
    """Per-period payout split. reward_P = Σ matured blocks × 60 GRIN, divided by
    work share (Σ share-diff). Workers are grouped by nickname (the text before the
    first dot in nickname.NN). Nicknames + % + GRIN ONLY — never addresses."""
    periods = {}
    for period in SPLIT_PERIODS:
        label, dfrom, dto, days = _window_days(period, now)
        blocks_matured = 0
        diffs = {}
        for day in days:
            e = ledger["days"].get(day)
            if not e:
                continue
            blocks_matured += int(e.get("blocks_matured", 0))
            for w, v in (e.get("workers") or {}).items():
                diffs[w] = diffs.get(w, 0) + v
        total_diff = sum(diffs.values())
        reward = blocks_matured * BLOCK_REWARD_GRIN

        # Group every worker under its nickname (the text before the first dot),
        # so all of one miner's rigs (alpha.01, alpha.02, …) settle as one payee.
        groups = {}
        for w, v in diffs.items():
            g = groups.setdefault(_nick_of(w), {"diff": 0, "workers": set()})
            g["diff"] += v
            g["workers"].add(w)

        persons = []
        for name, g in groups.items():
            diff = g["diff"]
            pct = (diff / total_diff * 100.0) if total_diff > 0 else 0.0
            grin = (reward * diff / total_diff) if total_diff > 0 else 0.0
            persons.append({"name": name, "workers": len(g["workers"]),
                            "diff": int(diff), "pct": round(pct, 1),
                            "grin": round(grin, 3)})
        # highest payout first, then by nickname
        persons.sort(key=lambda x: (-x["grin"], x["name"]))
        periods[period] = {
            "label": label, "from": dfrom, "to": dto,
            "blocks_matured": blocks_matured, "reward": round(reward, 3),
            "total_diff": int(total_diff), "persons": persons,
        }
    return periods


# ── log scanning ─────────────────────────────────────────────────────────────
def _consume_found(line, found, hashes):
    mf = FOUND_RE.search(line)
    if not mf:
        return False
    ts = parse_epoch(line) or time.time()
    h = str(int(mf.group("h")))
    if h not in found or ts < found[h]:
        found[h] = ts
    hashes[h] = mf.group("hash").lower()
    return True


def scan_increment(main_log, pos_state, found, hashes, workers, backfill):
    """Read new log content; update found{}, hashes{} and workers{}; return new pos_state."""
    def handle_line(line):
        if _consume_found(line, found, hashes):
            return
        ms = SHARE_RE.search(line)
        if ms:
            ts = parse_epoch(line) or time.time()
            w = ms.group("w").strip().strip(".,")
            wk = workers.setdefault(w, {"last_seen": 0, "buckets": {}})
            if ts > wk["last_seen"]:
                wk["last_seen"] = ts
            b = str(int(ts // BUCKET) * BUCKET)
            # Credit a FIXED per-share difficulty (SHARE_CREDIT_DIFF), not the
            # heavy-tailed actual difficulty the log reports, so one lucky share
            # cannot spike the hashrate estimate or the payout split.
            wk["buckets"][b] = wk["buckets"].get(b, 0.0) + SHARE_CREDIT_DIFF

    # First run (no state) — backfill found blocks from rotated logs too.
    if backfill:
        for f in sorted(glob.glob(main_log + "*")):
            if f == main_log:
                continue
            try:
                with open_maybe_gz(f) as fh:
                    for line in fh:
                        _consume_found(line, found, hashes)
            except OSError:
                continue

    if not os.path.exists(main_log):
        return pos_state
    st = os.stat(main_log)
    inode, size = st.st_ino, st.st_size
    start = 0
    if (not backfill and pos_state.get("inode") == inode
            and size >= pos_state.get("pos", 0)):
        start = pos_state.get("pos", 0)   # same file, continue where we left off
    try:
        with open(main_log, "r", errors="replace") as fh:
            fh.seek(start)
            for line in fh:
                handle_line(line)
            new_pos = fh.tell()
    except OSError:
        return pos_state
    return {"inode": inode, "pos": new_pos}


# ── output builders ──────────────────────────────────────────────────────────
def build_blocks(found, hashes, now):
    cutoff = now - BLOCK_RETENTION
    found = {h: t for h, t in found.items() if t >= cutoff}
    hashes = {h: v for h, v in hashes.items() if h in found}
    blocks = sorted(
        ({"height": int(h), "ts": iso(t), "hash": hashes.get(h)}
         for h, t in found.items()),
        key=lambda b: b["height"], reverse=True)[:RECENT_CAP]

    def since(days):
        edge = now - days * 86400
        return sum(1 for t in found.values() if t >= edge)

    return found, hashes, {
        "found_24h": since(1), "found_7d": since(7), "found_30d": since(30),
        "total_tracked": len(found), "blocks": blocks,
    }


def build_miners(workers, now):
    """Prune dead workers/buckets; compute windowed hashrate. Returns (workers, payload)."""
    live = {}
    miners = []
    total_hr = 0.0
    online_count = 0
    keep_edge = now - WINDOWS["48h"]
    for w, wk in workers.items():
        if now - wk.get("last_seen", 0) > WORKER_TTL:
            continue   # silent > 7 days → drop entirely
        buckets = {b: v for b, v in wk["buckets"].items() if int(b) >= keep_edge - BUCKET}
        wk["buckets"] = buckets
        live[w] = wk

        hr = {}
        for name, secs in WINDOWS.items():
            edge = now - secs
            s = sum(v for b, v in buckets.items() if int(b) >= edge - BUCKET)
            hr[name] = round(hashrate_gps(s, secs), 3)
        shares_24h = sum(1 for b in buckets if int(b) >= now - 86400)
        online = (now - wk["last_seen"]) <= ONLINE_THRESHOLD
        if online:
            online_count += 1
            total_hr += hr["15m"]
        miners.append({
            "worker": w, "online": online,
            "last_seen": iso(wk["last_seen"]),
            "age_s": int(now - wk["last_seen"]),
            "hr_15m": hr["15m"], "hr_12h": hr["12h"],
            "hr_24h": hr["24h"], "hr_48h": hr["48h"],
            "shares_24h": shares_24h,
        })
    miners.sort(key=lambda m: (not m["online"], -m["hr_15m"]))
    return live, {
        "online_threshold_s": ONLINE_THRESHOLD,
        "total_hr_gps": round(total_hr, 3),
        "miner_count": len(miners), "online_count": online_count,
        "miners": miners,
    }


def _daily_total_diff(workers, day):
    """Σ accepted share-difficulty across ALL workers whose 60s bucket falls on UTC `day`."""
    total = 0.0
    for wk in workers.values():
        for b, v in wk.get("buckets", {}).items():
            if utc_day(int(b)) == day:
                total += v
    return total


def update_hr_history(hr_days, workers, now):
    """Rolling per-UTC-day pool share-difficulty → daily-average hashrate history.

    Like the reward ledger, only TODAY and YESTERDAY are (re)written each run — the
    48h bucket window always covers both, so the rewrite is idempotent and older
    days stay frozen at the value finalised while still inside the window. Entries
    older than HR_HISTORY_RETENTION_DAYS are pruned (bounds the 12-month graph).
    Maintained for BOTH networks (unlike the mainnet-only reward ledger)."""
    for day in (utc_day(now - 86400), utc_day(now)):
        hr_days[day] = int(round(_daily_total_diff(workers, day)))
    cutoff = utc_day(now - HR_HISTORY_RETENTION_DAYS * 86400)
    for day in list(hr_days):
        if day < cutoff:
            del hr_days[day]
    return hr_days


def build_hr_history(hr_days, now):
    """Daily-average pool hashrate (G/s) per UTC day, ascending. The current day is
    divided by elapsed seconds since UTC midnight (not a full 86400) so it reads as
    a live average rather than an artificially low partial-day figure."""
    today = utc_day(now)
    midnight = datetime.fromtimestamp(now, timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0).timestamp()
    elapsed_today = max(1.0, now - midnight)
    points = []
    for day in sorted(hr_days):
        secs = elapsed_today if day == today else 86400.0
        points.append({"day": day, "gps": round(hashrate_gps(hr_days[day], secs), 3)})
    return points


def build_poolstats(net, miners_payload, blocks_payload, found, net_prev, now,
                    status=None, pool_name=DEFAULT_POOL_NAME):
    if status is None:
        status = query_node_status(net)
    height = diff = peers = net_hr = None
    if status:
        tip = status.get("tip", {})
        height = tip.get("height")
        diff = tip.get("total_difficulty")
        peers = status.get("connections")
        if diff is not None and net_prev.get("diff") is not None:
            dt = now - net_prev.get("ts", now)
            dd = diff - net_prev["diff"]
            if dt > 0 and dd > 0:
                net_hr = round(hashrate_gps(dd, dt), 3)
        if diff is not None:
            net_prev["diff"] = diff
            net_prev["ts"] = now

    last_block = None
    if found:
        top = max(int(h) for h in found.keys())
        last_block = {"height": top, "ts": iso(found[str(top)])}

    return net_prev, {
        "ts": iso(now), "net": net,
        "pool": {
            "name": pool_name,
            "hashrate": miners_payload["total_hr_gps"], "hashrate_unit": "gps",
            "workers": miners_payload["online_count"],
            "miners": miners_payload["miner_count"],
            "fee": 0.0,
            "blocks_24h": blocks_payload["found_24h"],
            "last_block": last_block,
        },
        "network": {
            "height": height, "difficulty": diff,
            "hashrate_gps": net_hr, "connections": peers,
        },
    }


# ── main ─────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Grin solo mining stats collector")
    ap.add_argument("--net", required=True, choices=["mainnet", "testnet"])
    ap.add_argument("--log", required=True)
    ap.add_argument("--state-dir", default="/opt/grin/solo-stats")
    ap.add_argument("--out-dir")
    ap.add_argument("--payment-config", default=DEFAULT_PAYMENT_CONFIG,
                    help="nickname-prefix file enabling the mainnet payout split")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    key = "main" if args.net == "mainnet" else "test"

    if args.dry_run:
        nb = nsh = 0
        seen = set()
        files = [args.log] + [f for f in sorted(glob.glob(args.log + "*")) if f != args.log]
        for fpath in files:
            try:
                with open_maybe_gz(fpath) as fh:
                    for line in fh:
                        if FOUND_RE.search(line):
                            nb += 1
                        ms = SHARE_RE.search(line)
                        if ms:
                            nsh += 1
                            seen.add(ms.group("w").strip().strip(".,"))
            except OSError:
                continue
        print(f"[dry-run] {nb} block-solved line(s), {nsh} share line(s), "
              f"{len(seen)} worker(s): {', '.join(sorted(seen)) or '—'}")
        return 0

    now = time.time()
    db_path = os.path.join(args.state_dir, f"solo_mining_stats_{key}.db")
    legacy_state = os.path.join(args.state_dir, f"stats_{key}.state.json")
    legacy_ledger = os.path.join(args.state_dir, "payment_ledger_main.json")
    conn = db_connect(db_path)
    migrate_legacy_json(conn, legacy_state, legacy_ledger, args.net == "mainnet")
    state = load_state_db(conn)
    found = state["found"]
    hashes = state["hashes"]
    workers = state["workers"]
    net_prev = state["net_prev"]
    hr_days = state["hr_days"]
    pos_state = state["log_pos"]
    backfill = not found and not workers and not pos_state

    pos_state = scan_increment(args.log, pos_state, found, hashes, workers, backfill)

    status = query_node_status(args.net)
    found, hashes, blocks_payload = build_blocks(found, hashes, now)
    workers, miners_payload = build_miners(workers, now)
    hr_days = update_hr_history(hr_days, workers, now)
    net_prev, pool_payload = build_poolstats(
        args.net, miners_payload, blocks_payload, found, net_prev, now, status,
        pool_name=load_pool_name(args.out_dir))

    save_state_db(conn, {
        "found": found, "hashes": hashes, "workers": workers,
        "net_prev": net_prev, "hr_days": hr_days, "log_pos": pos_state,
    })

    # ── Payout split (mainnet only) ──────────────────────────────────────────
    # The ledger is maintained unconditionally so history accrues from day one;
    # the public split is emitted only while the operator keeps it enabled.
    if args.net == "mainnet":
        ledger = update_ledger(load_ledger_db(conn), workers, found, hashes,
                               status, args.net, now)
        save_ledger_db(conn, ledger)

        if args.out_dir:
            split_path = os.path.join(args.out_dir, "split_main.json")
            if payout_split_enabled(args.payment_config):
                save_json_atomic(split_path, {
                    "updated": iso(now), "net": "mainnet",
                    "block_reward": BLOCK_REWARD_GRIN, "maturity": MAINNET_MATURITY,
                    "periods": compute_split(ledger, now),
                }, 0o644)
            elif os.path.exists(split_path):
                try:
                    os.remove(split_path)   # feature turned off → drop stale data
                except OSError:
                    pass

    blocks_out = dict(blocks_payload); blocks_out.update({"updated": iso(now), "net": args.net})
    miners_out = dict(miners_payload); miners_out.update({"updated": iso(now), "net": args.net})
    hashrate_out = {"updated": iso(now), "net": args.net, "unit": "gps",
                    "points": build_hr_history(hr_days, now)}

    if args.out_dir:
        save_json_atomic(os.path.join(args.out_dir, f"blocks_{key}.json"), blocks_out, 0o644)
        save_json_atomic(os.path.join(args.out_dir, f"miners_{key}.json"), miners_out, 0o644)
        save_json_atomic(os.path.join(args.out_dir, f"hashrate_{key}.json"), hashrate_out, 0o644)
        save_json_atomic(os.path.join(args.out_dir, f"poolstats_{key}.json"), pool_payload, 0o644)
    else:
        print(json.dumps({"blocks": blocks_out, "miners": miners_out,
                          "hashrate": hashrate_out, "poolstats": pool_payload}, indent=2))
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
