#!/usr/bin/env python3
"""
grin-stats-collector
====================
Collects Grin network stats from a local node and exports JSON for Chart.js + Leaflet.

📊 DATABASE SIZING & STORAGE ESTIMATES
═══════════════════════════════════════
Per-block storage: ~23 bytes (tx_count, fee_total, output_count, timestamp, height)

Grin chain (genesis Jan 2019 → present, ~3.7M blocks):
  • block_stats table (all TX/fees):  ~85 MB
  • blocks table (headers, sampled):  ~100 KB (daily + hourly + recent buckets)
  • Indexes:                          ~15-20% overhead
  • TOTAL:                            ~100-110 MB for complete history

Growth projection:
  • Per year: ~12.1 MB (525,600 new blocks)
  • After 10 more years (2036): ~220 MB total (manageable on any filesystem)

⚠️  MEMORY REQUIREMENTS
══════════════════════
Full history import (--init-history) fetches all 3.7M block stats.
Uses adaptive multi-threading (reduced workers for large batches) + periodic
commits to stay within ~500MB RAM. If you get "Killed (137)" errors:
  Option 1: Add swap space (Linux: fallocate -l 4G /swapfile && mkswap...)
  Option 2: Run incremental backfill: --backfill-stats 90 (fetch 90 days at a time)
  Option 3: Increase available RAM before running --init-history

Usage (commands):
    python3 06_collector.py --init-db            Create DB schema only
    python3 06_collector.py --init-history       Backfill ENTIRE chain (headers + all TX/fees, 6 hours)
    python3 06_collector.py --update             Fetch new blocks + TX stats (incremental)
    python3 06_collector.py --peers-only         Update peer geolocation + active_peers.json only
    python3 06_collector.py --backfill-stats     Fetch last 180 days (default)
    python3 06_collector.py --backfill-stats 90  Fetch last 90 days (lighter on memory)
    python3 06_collector.py --backfill-stats all Fetch ENTIRE chain history from block 0

Config (env vars or /opt/grin/grin-stats/config.env):
    GRIN_NODE_URL          default: http://127.0.0.1:3413/v2/foreign
    GRIN_API_SECRET_PATH   path to .api_secret file (optional)
    GRIN_WWW_DATA          default: /var/www/grin-stats/data
    GRIN_DB_PATH           default: /opt/grin/grin-stats/stats.db
"""

import argparse
import base64
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

try:
    import fcntl   # Linux only — used for the single-run lock (cmd_update)
except ImportError:
    fcntl = None

# ── Config ────────────────────────────────────────────────────────────────────

# Foreign API (mainnet) — block headers, tip, tx stats.
# Protected by foreign_api_secret_path in grin-server.toml (toolkit default).
NODE_URL = os.environ.get("GRIN_NODE_URL", "http://127.0.0.1:3413/v2/foreign")
WWW_DATA = os.environ.get("GRIN_WWW_DATA", "/var/www/grin-stats/data")
DB_PATH  = os.environ.get("GRIN_DB_PATH",  "/opt/grin/grin-stats/stats.db")

# Foreign API secret — set by Script 01 at <node_dir>/.foreign_api_secret
FOREIGN_SECRET_PATH = os.environ.get("GRIN_FOREIGN_SECRET_PATH", "")

# Owner APIs — get_connected_peers / get_peers require Basic Auth.
# Secret paths are written to config.env by the install script.
MAINNET_OWNER_URL   = os.environ.get("GRIN_MAINNET_OWNER_URL",  "http://127.0.0.1:3413/v2/owner")
MAINNET_SECRET_PATH = os.environ.get("GRIN_API_SECRET_PATH",    "")
TESTNET_OWNER_URL   = os.environ.get("GRIN_TESTNET_OWNER_URL",  "http://127.0.0.1:13413/v2/owner")
TESTNET_SECRET_PATH = os.environ.get("GRIN_TESTNET_SECRET_PATH", "")

# Blocks per hour / day at 60-second target
BLOCKS_PER_HOUR = 60
BLOCKS_PER_DAY  = 1440

# Sampling intervals for initial history import
SAMPLE_DAILY  = BLOCKS_PER_DAY   # one point per day for full history
SAMPLE_HOURLY = BLOCKS_PER_HOUR  # one point per hour for last 30 days
SAMPLE_RECENT = 1                # every block for last 24 hours

RECENT_HOURS  = 24
HOURLY_DAYS   = 30

# Geo batch size for ip-api.com (max 100 per call, free tier 45 req/min)
GEO_BATCH     = 100
GEO_URL       = "http://ip-api.com/batch?fields=status,lat,lon,country,countryCode,city,query"

# Peer retention: keep known_peers not seen for more than this many days
PEER_RETENTION_DAYS = 30
# How many days back to include in peers.json (must match ACTIVE_WINDOW_SEC in map.html)
PEER_HISTORY_DAYS   = 7

# Standard Grin P2P ports.
# Testnet: used as a strict filter (all testnet nodes run on 13414).
# Mainnet: used only as the default when addr has no port; no port filter applied
#          (MW/Grim and some MW/Grin nodes listen on non-standard ports — user-agent
#          is the gate for mainnet instead).
MAINNET_P2P_PORT = "3414"
TESTNET_P2P_PORT = "13414"

# ── API secret ────────────────────────────────────────────────────────────────

def _load_secret(path):
    if path and os.path.isfile(path):
        with open(path) as f:
            return f.read().strip()
    return ""

FOREIGN_SECRET     = _load_secret(FOREIGN_SECRET_PATH)
API_SECRET         = _load_secret(MAINNET_SECRET_PATH)
TESTNET_API_SECRET = _load_secret(TESTNET_SECRET_PATH)

# ── Grin JSON-RPC helper ──────────────────────────────────────────────────────

def _rpc(url, method, params=None, secret="", retries=3, timeout=15):
    """Generic JSON-RPC call to any Grin API URL with optional Basic Auth."""
    payload = json.dumps({
        "jsonrpc": "2.0",
        "method":  method,
        "params":  params,
        "id":      1,
    }).encode()
    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json"},
    )
    if secret:
        creds = base64.b64encode(f"grin:{secret}".encode()).decode()
        req.add_header("Authorization", f"Basic {creds}")
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read())
            result = data.get("result", {})
            if isinstance(result, dict) and "Err" in result:
                raise RuntimeError(f"Grin API Err: {result['Err']}")
            return result.get("Ok") if isinstance(result, dict) else result
        except (urllib.error.URLError, OSError):
            if attempt == retries - 1:
                raise
            time.sleep(1 + attempt)
    return None

def grin_rpc(method, params=None, retries=3, timeout=15):
    """Foreign API call — block headers, tip, tx data."""
    return _rpc(NODE_URL, method, params, secret=FOREIGN_SECRET, retries=retries, timeout=timeout)

# ── Timestamp helpers ─────────────────────────────────────────────────────────

def parse_ts(ts_str):
    """Convert Grin ISO timestamp string → Unix int."""
    # e.g. "2019-01-15T16:44:15.763877+00:00" or "2019-01-15T17:38:05+00:00"
    try:
        # Remove subseconds if present
        if '.' in ts_str:
            ts_str = ts_str.split('.')[0]
        # Remove timezone offset if present (+00:00 or Z)
        if '+' in ts_str:
            ts_str = ts_str.split('+')[0]
        elif 'Z' in ts_str:
            ts_str = ts_str.split('Z')[0]
        dt = datetime.strptime(ts_str, "%Y-%m-%dT%H:%M:%S")
        return int(dt.replace(tzinfo=timezone.utc).timestamp())
    except Exception:
        return 0  # Fallback; should be rare with the fixes above

def now_ts():
    return int(time.time())

# ── Single-run lock ─────────────────────────────────────────────────────────
# cron fires --update every 5 min. If a run overruns (slow get_block on a busy
# node) the next cron piles a second collector on top, which slows the node
# further → unbounded pile-up that saturates the node API and freezes every
# JSON export. This non-blocking flock guarantees at most one --update at a time;
# a run that finds the lock held simply exits. Released automatically on process
# exit. (The cron line also wraps the call in `flock -n`; this is the in-process
# belt-and-suspenders that also covers manual runs.)
_LOCK_FH = None

def acquire_run_lock(name="grin-stats-update"):
    """Return True if we acquired the singleton lock, False if another run holds it."""
    global _LOCK_FH
    if fcntl is None:
        return True  # non-Linux dev box — skip locking
    lock_path = os.path.join(os.environ.get("TMPDIR", "/tmp"), f"{name}.lock")
    try:
        _LOCK_FH = open(lock_path, "w")
        fcntl.flock(_LOCK_FH.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False

# ── Database ──────────────────────────────────────────────────────────────────

def open_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn

def init_schema(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS blocks (
            height          INTEGER PRIMARY KEY,
            timestamp       INTEGER NOT NULL,
            total_diff      INTEGER NOT NULL,
            hashrate        REAL,
            kernel_mmr      INTEGER NOT NULL DEFAULT 0,
            output_mmr      INTEGER NOT NULL DEFAULT 0,
            bucket          TEXT NOT NULL DEFAULT 'recent'
        );
        CREATE INDEX IF NOT EXISTS idx_blocks_ts     ON blocks(timestamp);
        CREATE INDEX IF NOT EXISTS idx_blocks_bucket ON blocks(bucket);

        -- Mempool (unconfirmed tx pool) size sampled every --update run.
        -- Forward-only: the node has no record of past pool sizes, so this builds
        -- a history going forward from when sampling began (like peer counts).
        CREATE TABLE IF NOT EXISTS mempool_history (
            sampled_at  INTEGER PRIMARY KEY,
            pool_size   INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_mempool_ts ON mempool_history(sampled_at);

        -- Live UTXO-set size (count of unspent outputs) — derived by paginating the
        -- node's get_unspent_outputs (same method grincoin.org/aglkm uses). Throttled
        -- (not every run) and forward-only: the unspent set only exists at the tip, so
        -- past sizes can't be reconstructed and the history builds forward.
        CREATE TABLE IF NOT EXISTS utxo_history (
            sampled_at  INTEGER PRIMARY KEY,
            utxo_count  INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_utxo_ts ON utxo_history(sampled_at);

        CREATE TABLE IF NOT EXISTS block_stats (
            height          INTEGER PRIMARY KEY,
            timestamp       INTEGER NOT NULL,
            tx_count        INTEGER NOT NULL DEFAULT 0,
            fee_total       INTEGER NOT NULL DEFAULT 0,
            output_count    INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_bstats_ts ON block_stats(timestamp);

        CREATE TABLE IF NOT EXISTS peer_snapshots (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            sampled_at      INTEGER NOT NULL,
            user_agent      TEXT    NOT NULL,
            count           INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_peers_ts ON peer_snapshots(sampled_at);

        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS known_peers (
            ip           TEXT    NOT NULL,
            network      TEXT    NOT NULL DEFAULT 'mainnet',
            port         TEXT,
            user_agent   TEXT,
            direction    TEXT,
            lat          REAL    DEFAULT 0,
            lng          REAL    DEFAULT 0,
            country      TEXT    DEFAULT '',
            country_code TEXT    DEFAULT '',
            city         TEXT    DEFAULT '',
            first_seen   INTEGER NOT NULL,
            last_seen    INTEGER NOT NULL,
            PRIMARY KEY (ip, network)
        );
        CREATE INDEX IF NOT EXISTS idx_kp_last_seen ON known_peers(last_seen);
        CREATE INDEX IF NOT EXISTS idx_kp_country   ON known_peers(country);

        CREATE TABLE IF NOT EXISTS peer_count_history (
            sampled_at      INTEGER NOT NULL,
            mainnet_count   INTEGER NOT NULL DEFAULT 0,
            testnet_count   INTEGER NOT NULL DEFAULT 0,
            country_count   INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_pch_ts ON peer_count_history(sampled_at);

        CREATE TABLE IF NOT EXISTS inflation_ext (
            year     INTEGER NOT NULL,
            asset    TEXT    NOT NULL,   -- 'usd_m2' | 'gold'
            rate_pct REAL,               -- null = not available / undefined
            source   TEXT,               -- e.g. 'worldbank:FM.LBL.BMNY.ZG' or 'wgc:calc'
            fetched  INTEGER NOT NULL,   -- unix ts when this row was last written
            PRIMARY KEY (year, asset)
        );

        -- Daily per-country node counts. One row per (day, network, country); the
        -- last collector run of each day REPLACEs it. Powers the week/month/year/
        -- all-time Top-10 toggle (AVG of daily counts over the window). known_peers
        -- is pruned at 30d, so this is the only source for year/all-time rankings —
        -- it builds forward, no backfill of older history is possible.
        CREATE TABLE IF NOT EXISTS country_daily (
            day_ts       INTEGER NOT NULL,
            network      TEXT    NOT NULL,
            country_code TEXT    NOT NULL,
            country_name TEXT    NOT NULL DEFAULT '',
            peer_count   INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (day_ts, network, country_code)
        );
        CREATE INDEX IF NOT EXISTS idx_cd_day ON country_daily(day_ts);

        -- Daily per-version (user-agent) node counts. Same shape/role as
        -- country_daily, powering the Versions Top-10 timeframe toggle.
        CREATE TABLE IF NOT EXISTS version_daily (
            day_ts      INTEGER NOT NULL,
            network     TEXT    NOT NULL,
            user_agent  TEXT    NOT NULL,
            count       INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (day_ts, network, user_agent)
        );
        CREATE INDEX IF NOT EXISTS idx_vd_day ON version_daily(day_ts);

        -- Cumulative registry of EVERY distinct node ever seen (one row per ip+network,
        -- upserted each run). known_peers is pruned at 30d and the *_daily tables store
        -- only counts, so this is the ONLY source able to count DISTINCT nodes ever for
        -- the "All Time" Top-10 ranking. Builds forward from first deploy; tiny
        -- (~100 B/row → single-digit MB even at tens of thousands of nodes). geo/version
        -- reflect the node's most-recent attribution (refreshed on each upsert).
        CREATE TABLE IF NOT EXISTS seen_peers (
            ip           TEXT    NOT NULL,
            network      TEXT    NOT NULL DEFAULT 'mainnet',
            country_code TEXT    DEFAULT '',
            country      TEXT    DEFAULT '',
            user_agent   TEXT    DEFAULT '',
            first_seen   INTEGER NOT NULL,
            last_seen    INTEGER NOT NULL,
            PRIMARY KEY (ip, network)
        );
        CREATE INDEX IF NOT EXISTS idx_sp_country ON seen_peers(country_code);
    """)
    conn.commit()

    # Migrate old single-column peer_count_history → mainnet_count / testnet_count
    cols = {r[1] for r in conn.execute("PRAGMA table_info(peer_count_history)")}
    if "count" in cols and "mainnet_count" not in cols:
        conn.executescript("""
            ALTER TABLE peer_count_history ADD COLUMN mainnet_count INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE peer_count_history ADD COLUMN testnet_count INTEGER NOT NULL DEFAULT 0;
            UPDATE peer_count_history SET mainnet_count = count;
        """)
        conn.commit()
        cols.update({"mainnet_count", "testnet_count"})
    # Add country_count to existing peer_count_history (distinct countries hosting
    # a node per sample, both networks). Historical rows stay 0 — no backfill, the
    # trend builds going forward.
    if "country_count" not in cols:
        conn.execute(
            "ALTER TABLE peer_count_history ADD COLUMN country_count INTEGER NOT NULL DEFAULT 0"
        )
        conn.commit()

    # Add kernel_mmr / output_mmr to existing blocks tables (header MMR sizes →
    # kernel & output counts since genesis). Historical rows stay 0 until a
    # `--backfill-mmr` run re-reads the headers; new blocks fill them via --update.
    bcols = {r[1] for r in conn.execute("PRAGMA table_info(blocks)")}
    for col in ("kernel_mmr", "output_mmr"):
        if col not in bcols:
            conn.execute(f"ALTER TABLE blocks ADD COLUMN {col} INTEGER NOT NULL DEFAULT 0")
    conn.commit()

def get_meta(conn, key, default=None):
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row[0] if row else default

def set_meta(conn, key, value):
    conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", (key, str(value)))
    conn.commit()

# ── Block fetching ────────────────────────────────────────────────────────────

def mmr_leaves(mmr_size):
    """
    Convert a Merkle Mountain Range size (total node positions, as reported in the
    block header's *_mmr_size fields) into the number of leaves — i.e. the real
    count of kernels / outputs ever committed. An MMR of N leaves stores parent
    hashes too, so size > leaves; we sum the leaves of each perfect-tree "peak".
    """
    size   = int(mmr_size or 0)
    leaves = 0
    while size > 0:
        k = 0
        while (1 << (k + 2)) - 1 <= size:   # largest peak (2^(k+1)-1 nodes) fitting in size
            k += 1
        leaves += 1 << k                    # that peak contributes 2^k leaves
        size   -= (1 << (k + 1)) - 1        # …and 2^(k+1)-1 nodes
    return leaves

def fetch_header(height):
    """Fetch a single block header.
    Returns (height, timestamp_int, total_diff, kernel_mmr_size, output_mmr_size) or None.
    The MMR sizes are header fields available for every height on pruned and archive
    nodes alike (header chain is never pruned)."""
    try:
        data = grin_rpc("get_header", [height, None, None], retries=5)
        if not data or "height" not in data:
            print(f"  [WARN] Empty or invalid response for height {height}", file=sys.stderr)
            return None
        return (
            int(data["height"]),
            parse_ts(data.get("timestamp", "")),
            int(data.get("total_difficulty", 0)),
            int(data.get("kernel_mmr_size", 0)),
            int(data.get("output_mmr_size", 0)),
        )
    except Exception as exc:
        print(f"  [ERROR] Failed height {height}: {exc}", file=sys.stderr)
        return None

def fetch_headers_batch(heights, workers=8):
    """Fetch multiple headers in parallel. Returns list of (height, ts, diff)."""
    results = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fetch_header, h): h for h in heights}
        for fut in as_completed(futures):
            row = fut.result()
            if row:
                results.append(row)
    results.sort(key=lambda r: r[0])
    return results

def fetch_full_block(height):
    """Fetch full block (kernels + outputs) for tx/fee stats."""
    try:
        # get_block is heavy on a full/archival node. Keep the per-block budget
        # small (retries=2, timeout=8) so a slow block costs ~17s, not ~75s —
        # the gap-fill must never starve the JSON export at the end of cmd_update.
        data = grin_rpc("get_block", [height, None, None], retries=2, timeout=8)
        if not data:
            return None
        header   = data.get("header", {})
        kernels  = data.get("kernels", [])
        outputs  = data.get("outputs", [])
        # Exclude coinbase kernels (features == "Coinbase") from tx count
        tx_kernels = [k for k in kernels if k.get("features") != "Coinbase"]
        fee_total  = sum(int(k.get("fee", 0)) for k in tx_kernels)
        return (
            int(header.get("height", height)),
            parse_ts(header.get("timestamp", "")),
            len(tx_kernels),
            fee_total,
            len(outputs),
        )
    except Exception as exc:
        print(f"  [WARN] block {height}: {exc}", file=sys.stderr)
        return None

def fetch_utxo_count():
    """
    Count the live unspent-output set (UTXO-set size) by paginating the Foreign API
    get_unspent_outputs — the same approach grincoin.org (aglkm/grin-explorer) uses.
    Each call returns up to `page` unspent outputs plus the MMR index it stopped at;
    we resume from there and sum the counts. The unspent set is kept small by Grin's
    cut-through, so this is only a handful of calls. Returns int or None on failure.
    """
    page  = 10000
    start = 1
    total = 0
    guard = 0
    while True:
        guard += 1
        if guard > 5000:            # hard safety cap — never loop forever
            print("[WARN] utxo count: iteration cap hit; returning partial", file=sys.stderr)
            break
        resp = grin_rpc("get_unspent_outputs", [start, None, page, False], retries=2, timeout=20)
        if not resp:
            return None if total == 0 else total
        outs = resp.get("outputs", []) or []
        total += len(outs)
        highest = int(resp.get("highest_index", 0) or 0)
        last    = int(resp.get("last_retrieved_index", 0) or 0)
        # Done when we've scanned to the tip of the output MMR, or made no progress.
        if not outs or last <= start - 1 or last >= highest:
            break
        start = last + 1
    return total

# ── Hashrate calculation ──────────────────────────────────────────────────────

def calc_hashrate(rows):
    """
    Given list of (height, ts, total_diff[, kernel_mmr, output_mmr]) sorted by height,
    compute per-point hashrate (GPS) using the Cuckatoo32 formula from aglkm/grin-explorer:
        hashrate_GPS = net_diff * 42 / block_time_seconds / 16384
    where:
        net_diff    = total_diff delta between consecutive sampled rows
        42          = Cuckoo cycle length for Cuckatoo32
        16384       = C32 solution rate = 32 × 2^(32-23) = 32 × 512
        block_time  = actual seconds between the two sampled blocks
    Returns list of (height, ts, total_diff, hashrate, kernel_mmr, output_mmr). MMR
    fields pass straight through (default 0 when a row doesn't carry them, e.g. the
    base reference row in _append_hashrate).
    """
    # Cuckatoo32 constants (matches aglkm/grin-explorer formula)
    CUCKOO_CYCLE  = 42.0
    C32_RATE      = 16384.0   # 32 × 2^9

    out = []
    for i, row in enumerate(rows):
        h, ts, diff = row[0], row[1], row[2]
        kmmr = row[3] if len(row) > 3 else 0
        ommr = row[4] if len(row) > 4 else 0
        if i == 0:
            out.append((h, ts, diff, 0.0, kmmr, ommr))
            continue
        pts, pdiff = rows[i - 1][1], rows[i - 1][2]
        dt = ts - pts
        dd = diff - pdiff
        if dt > 0 and dd > 0:
            hr = dd * CUCKOO_CYCLE / dt / C32_RATE   # GPS (graphs per second)
        else:
            # Invalid data: same or earlier timestamp, or difficulty decreased
            # Do NOT copy previous hashrate (prevents propagation of anomalies)
            hr = 0.0
        out.append((h, ts, diff, hr, kmmr, ommr))
    return out

# ── Bucket assignment ─────────────────────────────────────────────────────────

def assign_bucket(ts):
    age = now_ts() - ts
    if age < RECENT_HOURS * 3600:
        return "recent"
    elif age < HOURLY_DAYS * 86400:
        return "hourly"
    else:
        return "daily"

# ── Initial history import ────────────────────────────────────────────────────

def cmd_init_history():
    print("[INFO] Fetching chain tip...")
    tip = grin_rpc("get_tip")
    if not tip:
        print("[ERROR] Cannot reach Grin node.", file=sys.stderr)
        sys.exit(1)

    tip_height = int(tip["height"])
    print(f"[INFO] Chain tip: {tip_height:,}")

    # Build list of heights to sample
    now = now_ts()
    recent_start  = tip_height - RECENT_HOURS * BLOCKS_PER_HOUR
    hourly_start  = tip_height - HOURLY_DAYS  * BLOCKS_PER_DAY

    heights = set()

    # Recent: every block for last 24h
    heights.update(range(max(0, recent_start), tip_height + 1, SAMPLE_RECENT))

    # Hourly: every 60 blocks for last 30 days (excluding recent window)
    heights.update(range(max(0, hourly_start), recent_start, SAMPLE_HOURLY))

    # Daily: every 1440 blocks for full history (excluding hourly window)
    heights.update(range(0, hourly_start, SAMPLE_DAILY))

    # Always include tip
    heights.add(tip_height)

    heights = sorted(heights)
    total   = len(heights)
    print(f"[INFO] Sampling {total:,} heights (out of {tip_height:,} total blocks)...")
    print(f"[INFO]   Daily  : 0 → {hourly_start:,}  (every {SAMPLE_DAILY} blocks)")
    print(f"[INFO]   Hourly : {hourly_start:,} → {recent_start:,}  (every {SAMPLE_HOURLY} blocks)")
    print(f"[INFO]   Recent : {recent_start:,} → {tip_height:,}  (every block)")

    conn = open_db()
    init_schema(conn)

    # Fetch in batches
    batch_size = 70
    done = 0
    rows_all = []

    for i in range(0, total, batch_size):
        batch_heights = heights[i: i + batch_size]
        rows = fetch_headers_batch(batch_heights, workers=8)
        rows_all.extend(rows)
        done += len(batch_heights)
        pct = done * 100 // total
        print(f"\r  Progress: {done:,}/{total:,}  ({pct}%)", end="", flush=True)

    print()

    # Sort and compute hashrate
    rows_all.sort(key=lambda r: r[0])
    rows_with_hr = calc_hashrate(rows_all)

    # Write to DB
    print("[INFO] Writing to database...")
    conn.execute("DELETE FROM blocks")
    conn.executemany(
        "INSERT OR REPLACE INTO blocks"
        "(height,timestamp,total_diff,hashrate,kernel_mmr,output_mmr,bucket) VALUES(?,?,?,?,?,?,?)",
        [(h, ts, diff, hr, kmmr, ommr, assign_bucket(ts))
         for h, ts, diff, hr, kmmr, ommr in rows_with_hr],
    )
    set_meta(conn, "last_height", tip_height)
    set_meta(conn, "last_updated", now_ts())
    conn.commit()
    conn.close()

    # Fetch full block stats for complete history (ALL blocks since genesis)
    print("[INFO] Fetching tx/fee stats for complete chain history...")
    print("[INFO] ⚠️  Large import: using memory-efficient streaming (may take 6 hours or more)...")
    _fetch_block_stats_range(0, tip_height)

    # Update peers
    print("[INFO] Updating peer data...")
    _update_peers()

    # Export JSON
    print("[INFO] Exporting JSON files...")
    export_all_json()

    print(f"[OK] Initial history import complete. DB: {DB_PATH}")

# ── Incremental update ────────────────────────────────────────────────────────

def cmd_update():
    if not acquire_run_lock():
        print("[INFO] Another --update run is still in progress — skipping "
              "(node may be slow; preventing overlap pile-up).")
        return

    conn = open_db()
    init_schema(conn)

    last_height = int(get_meta(conn, "last_height", 0))
    conn.close()

    tip = grin_rpc("get_tip")
    if not tip:
        print("[ERROR] Cannot reach Grin node.", file=sys.stderr)
        sys.exit(1)

    tip_height = int(tip["height"])

    # ── Sample mempool (unconfirmed tx pool) size — forward-only history ───────
    # Runs every cycle regardless of new blocks; the node only knows the *current*
    # pool, so past values can't be backfilled (the series builds going forward).
    try:
        pool_size = grin_rpc("get_pool_size", [], retries=2, timeout=8)
        if pool_size is not None:
            conn_mp = open_db()
            conn_mp.execute(
                "INSERT OR REPLACE INTO mempool_history(sampled_at, pool_size) VALUES(?,?)",
                (now_ts(), int(pool_size)),
            )
            # Keep ~1 year of 5-min samples (~105k rows ≈ 2 MB); older points fall off.
            conn_mp.execute(
                "DELETE FROM mempool_history WHERE sampled_at < ?", (now_ts() - 366 * 86400,)
            )
            conn_mp.commit()
            conn_mp.close()
            print(f"[INFO] Mempool: {int(pool_size)} unconfirmed tx in pool")
    except Exception as exc:
        print(f"[WARN] mempool sample failed: {exc}", file=sys.stderr)

    # ── Sample UTXO-set size — throttled to ~20 min (pagination is heavier than a
    # single RPC, so don't run it on every 5-min cron tick). Forward-only history.
    try:
        conn_ut = open_db()
        last_utxo_ts = int(get_meta(conn_ut, "last_utxo_sample", 0))
        if now_ts() - last_utxo_ts >= 20 * 60:
            utxo = fetch_utxo_count()
            if utxo is not None:
                conn_ut.execute(
                    "INSERT OR REPLACE INTO utxo_history(sampled_at, utxo_count) VALUES(?,?)",
                    (now_ts(), int(utxo)),
                )
                conn_ut.execute(
                    "DELETE FROM utxo_history WHERE sampled_at < ?", (now_ts() - 366 * 86400,)
                )
                set_meta(conn_ut, "last_utxo_sample", now_ts())
                conn_ut.commit()
                print(f"[INFO] UTXO set: {int(utxo):,} unspent outputs")
        conn_ut.close()
    except Exception as exc:
        print(f"[WARN] utxo sample failed: {exc}", file=sys.stderr)

    if tip_height <= last_height:
        print(f"[INFO] No new blocks (tip: {tip_height:,}).")
    else:
        new_heights = list(range(last_height + 1, tip_height + 1))
        print(f"[INFO] Fetching {len(new_heights)} new block(s) ({last_height+1:,} → {tip_height:,})...")
        rows = fetch_headers_batch(new_heights, workers=4)
        rows.sort(key=lambda r: r[0])
        rows_with_hr = _append_hashrate(rows, last_height)

        conn = open_db()
        conn.executemany(
            "INSERT OR REPLACE INTO blocks"
            "(height,timestamp,total_diff,hashrate,kernel_mmr,output_mmr,bucket) VALUES(?,?,?,?,?,?,?)",
            [(h, ts, diff, hr, kmmr, ommr, assign_bucket(ts))
             for h, ts, diff, hr, kmmr, ommr in rows_with_hr],
        )
        # Re-bucket older rows that may have shifted time windows
        conn.execute(
            "UPDATE blocks SET bucket='hourly' WHERE bucket='recent' AND timestamp < ?",
            (now_ts() - RECENT_HOURS * 3600,),
        )
        conn.execute(
            "UPDATE blocks SET bucket='daily' WHERE bucket='hourly' AND timestamp < ?",
            (now_ts() - HOURLY_DAYS * 86400,),
        )
        set_meta(conn, "last_height", tip_height)
        set_meta(conn, "last_updated", now_ts())
        conn.commit()
        conn.close()

        # Fetch stats for new blocks + fill any gaps in the last HOURLY_DAYS window.
        # last_height is already committed to DB before this runs, so any interruption
        # here would leave gaps permanently on simple range-based fetching.
        # The gap-aware approach: query which heights are actually missing and fetch only those.
        gap_start = max(0, tip_height - HOURLY_DAYS * BLOCKS_PER_DAY)
        conn_gap = open_db()
        have = {r[0] for r in conn_gap.execute(
            "SELECT height FROM block_stats WHERE height BETWEEN ? AND ?",
            (gap_start, tip_height),
        ).fetchall()}
        conn_gap.close()
        missing = [h for h in range(gap_start, tip_height + 1) if h not in have]
        if missing:
            # Cap the per-run gap-fill and give it a hard deadline so a slow
            # get_block can never delay _update_peers()/export_all_json() below
            # (which refresh ALL the public JSON files). Newest-missing first so
            # recent tx/fee charts fill in immediately; older gaps catch up over
            # subsequent runs. Partial progress is committed and resumed next run.
            MAX_GAPFILL_PER_RUN = 60
            GAPFILL_DEADLINE_SEC = 120
            missing.sort(reverse=True)
            batch = sorted(missing[:MAX_GAPFILL_PER_RUN])
            print(f"[INFO] Gap-fill: {len(batch):,} of {len(missing):,} missing block(s) "
                  f"this run (cap {MAX_GAPFILL_PER_RUN}, {GAPFILL_DEADLINE_SEC}s deadline)...")
            try:
                _fetch_block_stats_range(gap_start, tip_height, heights=batch,
                                         deadline=time.time() + GAPFILL_DEADLINE_SEC)
            except Exception as exc:
                print(f"[WARN] gap-fill interrupted ({exc}) — exporting current data anyway.",
                      file=sys.stderr)

    _update_peers()
    export_all_json()
    print("[OK] Update complete.")

def _append_hashrate(new_rows, last_height):
    """Compute hashrate for new rows, using last stored row as base."""
    if not new_rows:
        return []
    conn = open_db()
    row = conn.execute(
        "SELECT height, timestamp, total_diff FROM blocks WHERE height=?", (last_height,)
    ).fetchone()
    conn.close()

    base = [tuple(row)] if row else []
    combined = calc_hashrate(base + new_rows)
    return combined[len(base):]  # return only the new ones

def _fmt_eta(secs):
    """Format seconds into a compact human-readable ETA string."""
    if secs < 60:   return f"{int(secs)}s"
    if secs < 3600: return f"{int(secs/60)}m"
    return f"{secs/3600:.1f}h"

def _progress(done, total, t0):
    """Print a single-line progress bar to stdout (call with \r)."""
    elapsed = time.time() - t0
    rate    = done / elapsed if elapsed > 0 else 1
    eta     = (total - done) / rate if rate > 0 else 0
    pct     = done / total
    filled  = int(30 * pct)
    bar     = "█" * filled + "░" * (30 - filled)
    print(
        f"\r  [{bar}] {done:,}/{total:,} ({pct*100:.1f}%)"
        f"  {rate:.0f} blk/s  ETA {_fmt_eta(eta)}   ",
        end="", flush=True,
    )

def _fetch_block_stats_range(start, end, workers=1, heights=None, deadline=None):
    """
    Fetch block stats (tx/fee data) one block at a time (workers=1, default).

    Sequential mode avoids flooding the local Grin node with concurrent requests.
    Blocks are committed in chunks of 1 000 so progress is saved frequently and
    RAM stays flat regardless of total block count.

    Pass workers > 1 only when the node can handle parallel requests
    (e.g. a fast remote node or a small catch-up batch).

    deadline: optional Unix time after which the fetch stops early (committing
    whatever it has). Used by cmd_update so a slow get_block can never starve the
    JSON export; the remaining blocks are picked up on the next run.
    """
    if heights is None:
        heights = list(range(max(0, start), end + 1))
    if not heights:
        return

    total      = len(heights)
    chunk_size = 1_000   # commit every 1 000 blocks; keeps SQLite WAL small
    conn       = open_db()
    init_schema(conn)
    done = committed = 0
    hit_deadline = False
    t0   = time.time()

    print(f"  Fetching {total:,} blocks (workers={workers}, commit every {chunk_size:,})")

    for ci in range(0, total, chunk_size):
        if deadline and time.time() > deadline:
            hit_deadline = True
            break
        chunk = heights[ci : ci + chunk_size]
        batch = []

        if workers == 1:
            # ── Sequential: one request at a time, no thread overhead ──────────
            for h in chunk:
                if deadline and time.time() > deadline:
                    hit_deadline = True
                    break
                row = fetch_full_block(h)
                if row:
                    batch.append(row)
                done += 1
                if done % 100 == 0 or done == total:
                    _progress(done, total, t0)
        else:
            # ── Parallel: submit only this chunk (not all heights at once) ─────
            with ThreadPoolExecutor(max_workers=workers) as pool:
                futs = [pool.submit(fetch_full_block, h) for h in chunk]
                for fut in as_completed(futs):
                    row = fut.result()
                    if row:
                        batch.append(row)
                    done += 1
                    if done % 100 == 0 or done == total:
                        _progress(done, total, t0)

        if batch:
            conn.executemany(
                "INSERT OR REPLACE INTO block_stats"
                "(height,timestamp,tx_count,fee_total,output_count) VALUES(?,?,?,?,?)",
                batch,
            )
            conn.commit()
            committed += len(batch)

        if hit_deadline:
            break

    print()  # newline after progress bar
    conn.close()
    if hit_deadline:
        print(f"[INFO] Gap-fill deadline reached — committed {committed:,} stats "
              f"({done:,}/{total:,} attempted); remaining blocks resume next run.")
    else:
        print(f"[INFO] Committed {committed:,} block stats to database")

def cmd_backfill_stats(days=None):
    """
    Fetch full block stats for the last N days (or ALL history if days=None).
    Skips already-stored heights.
    
    Database sizing (estimated):
    ├─ Per block (tx/fee data): ~23 bytes
    ├─ Grin chain (2019-2026, ~3.7M blocks): ~85 MB
    ├─ Future growth: ~12.1 MB/year
    └─ Indexes: add ~15% overhead
    
    Examples:
        --backfill-stats all      fetch entire chain history (~85 MB, 3.7M blocks)
        --backfill-stats 180      fetch last 180 days (~6 MB)
        --backfill-stats          fetch last 180 days (default)
    """
    if days is None:
        days = 180
    
    print(f"[INFO] Backfilling block stats for last {days if days != float('inf') else 'ALL'} days...")
    conn = open_db()
    init_schema(conn)
    tip_row = conn.execute(
        "SELECT height FROM blocks ORDER BY height DESC LIMIT 1"
    ).fetchone()
    if not tip_row:
        print("[ERROR] No block headers in DB — run --init-history first.", file=sys.stderr)
        conn.close()
        sys.exit(1)
    tip_height = tip_row[0]
    
    # If days is float('inf'), fetch from block 0; otherwise use time-based cutoff
    start = 0 if days == float('inf') else max(0, tip_height - days * BLOCKS_PER_DAY)
    
    existing = {r[0] for r in conn.execute(
        "SELECT height FROM block_stats WHERE height BETWEEN ? AND ?", (start, tip_height)
    ).fetchall()}
    conn.close()

    heights = [h for h in range(start, tip_height + 1) if h not in existing]
    
    est_mb = len(heights) * 23 / (1024 * 1024)
    print(f"[INFO] Range {start:,} → {tip_height:,}  "
          f"({len(heights):,} to fetch, {len(existing):,} already present, ~{est_mb:.1f} MB)")
    if heights:
        _fetch_block_stats_range(start, tip_height, heights=heights)
    export_all_json()
    print("[OK] Backfill complete.")

def cmd_backfill_mmr():
    """
    Populate kernel_mmr / output_mmr for blocks rows that still have them at 0
    (i.e. rows written before the columns existed). Reads only headers — cheap and
    works on pruned nodes — and only for the already-sampled heights in `blocks`
    (a few thousand rows), so this finishes in minutes, not the hours --init-history
    takes. New blocks get their MMR sizes automatically via --update.
    """
    conn = open_db()
    init_schema(conn)
    heights = [r[0] for r in conn.execute(
        "SELECT height FROM blocks WHERE kernel_mmr = 0 ORDER BY height"
    ).fetchall()]
    conn.close()

    if not heights:
        print("[OK] All blocks rows already have MMR sizes — nothing to backfill.")
        export_all_json()
        return

    print(f"[INFO] Backfilling kernel/output MMR for {len(heights):,} sampled block(s)...")
    conn = open_db()
    done = updated = 0
    t0 = time.time()
    for i in range(0, len(heights), 70):
        batch = heights[i: i + 70]
        rows  = fetch_headers_batch(batch, workers=8)   # (h, ts, diff, kmmr, ommr)
        conn.executemany(
            "UPDATE blocks SET kernel_mmr=?, output_mmr=? WHERE height=?",
            [(r[3], r[4], r[0]) for r in rows],
        )
        conn.commit()
        updated += len(rows)
        done    += len(batch)
        _progress(done, len(heights), t0)
    print()
    conn.close()
    print(f"[INFO] Updated MMR sizes on {updated:,} rows.")
    export_all_json()
    print("[OK] MMR backfill complete.")

# ── Peer update ───────────────────────────────────────────────────────────────

def _mask_ip(ip):
    """Mask the last group of an IP to protect peer privacy:
    IPv4 last octet (1.2.3.4 → 1.2.3.x), IPv6 last hextet (2001:db8::1 → 2001:db8::x)."""
    if ":" in ip and not ip.startswith("["):
        parts = ip.split(":")
        parts[-1] = "x"
        return ":".join(parts)
    parts = ip.rsplit(".", 1)
    if len(parts) == 2:
        return parts[0] + ".x"
    return ip


def _is_public_ip(ip):
    """Return True if ip is a routable public address (not loopback/RFC-1918/IPv6 private)."""
    if not ip:
        return False
    ip_lower = ip.lower()
    return (
        not ip.startswith("127.")
        and not ip_lower == "::1"
        and not ip.startswith("10.")
        and not ip.startswith("192.168.")
        and not ip_lower.startswith("fc")     # IPv6 unique local fc00::/7 (first half)
        and not ip_lower.startswith("fd")     # IPv6 unique local fc00::/7 (second half)
        and not ip_lower.startswith("fe80")   # IPv6 link-local fe80::/10
        and not ip_lower.startswith("2001:db8")  # IPv6 documentation
    )

def _clean_agent(ua):
    """Return the peer's trimmed user agent, or None if blank/empty.
    Blank agents come from routing-table addresses the node only heard about via
    gossip and never handshaked (get_peers returns tens of thousands of these);
    they carry no node identity, so callers skip them instead of flooding the map
    with 'Unknown'. Every non-blank name is kept as-is, capturing new and
    yet-unknown Grin implementations."""
    if ua is None:
        return None
    ua = str(ua).strip()
    return ua or None


def _nat64_to_ipv4(ip):
    """Decode a NAT64 well-known prefix address (64:ff9b::/96, RFC 6052) to plain IPv4.
    e.g. 64:ff9b::b9b1:dbb9 → 185.177.219.185. Returns None if not a NAT64 address."""
    if not ip.lower().startswith("64:ff9b::"):
        return None
    suffix = ip.split("::")[-1]   # e.g. "b9b1:dbb9"
    parts  = suffix.split(":")
    if len(parts) != 2:
        return None
    try:
        hi = int(parts[0], 16)
        lo = int(parts[1], 16)
        return f"{hi >> 8}.{hi & 0xff}.{lo >> 8}.{lo & 0xff}"
    except ValueError:
        return None


def _extract_addr(peer, default_port):
    """Split a Grin peer dict's addr field into (ip, port).
    Strips ::ffff: (IPv4-mapped) and decodes 64:ff9b:: (NAT64) prefixes so
    those addresses are stored and geolocated as plain IPv4."""
    addr = peer.get("addr", "")
    ip   = addr.rsplit(":", 1)[0].strip("[]")
    port = addr.rsplit(":", 1)[-1] if ":" in addr else default_port
    if ip.lower().startswith("::ffff:"):
        ip = ip[7:]
    else:
        decoded = _nat64_to_ipv4(ip)
        if decoded:
            ip = decoded
    return ip, port


def _geo_batch(unique_ips):
    """Geolocate a list of IPs via ip-api.com batch endpoint. Returns {ip: geo_dict}."""
    geo_map = {}
    for i in range(0, len(unique_ips), GEO_BATCH):
        batch = unique_ips[i: i + GEO_BATCH]
        try:
            payload = json.dumps([{"query": ip} for ip in batch]).encode()
            req = urllib.request.Request(
                GEO_URL, data=payload,
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                geo_results = json.loads(resp.read())
            for g in geo_results:
                if g.get("status") == "success":
                    geo_map[g["query"]] = {
                        "lat":          g.get("lat", 0),
                        "lng":          g.get("lon", 0),
                        "country":      g.get("country", ""),
                        "country_code": g.get("countryCode", ""),
                        "city":         g.get("city", ""),
                    }
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                print("[WARN] Geo rate-limited (429) — waiting 65s before next batch...",
                      file=sys.stderr)
                time.sleep(65)
            else:
                print(f"[WARN] Geo batch failed: {exc}", file=sys.stderr)
        except Exception as exc:
            print(f"[WARN] Geo batch failed: {exc}", file=sys.stderr)
        finally:
            time.sleep(1.5)
    return geo_map


def _fetch_connected_peers(owner_url, secret, network_label):
    """
    Fetch CURRENTLY CONNECTED peers via get_connected_peers (owner API, auth required).
    These peers have an active TCP session — guaranteed to be alive right now.
    Typically returns 8–30 peers; used as the authoritative source for peers.json.

    Mainnet: no port filter (MW/Grim and some MW/Grin nodes use non-standard ports);
             peers reporting a blank agent are skipped (gossiped, never-handshaked
             routing entries); every named peer is kept, so all implementations map.
    Testnet: standard port 13414 filter kept (all testnet nodes use it consistently).
    """
    expected_port = MAINNET_P2P_PORT if network_label == "mainnet" else TESTNET_P2P_PORT
    peer_list = []
    try:
        raw = _rpc(owner_url, "get_connected_peers", secret=secret, retries=2)
        if raw:
            for p in raw:
                ip, port = _extract_addr(p, expected_port)
                if not _is_public_ip(ip):
                    continue
                if network_label == "testnet" and port != expected_port:
                    continue
                ua = _clean_agent(p.get("user_agent", ""))
                if not ua:
                    continue
                peer_list.append({
                    "ip":         ip,
                    "port":       port,
                    "user_agent": ua,
                    "direction":  p.get("direction", "Outbound"),
                    "network":    network_label,
                })
        port_info = f"port {expected_port}" if network_label == "testnet" else "any port"
        print(f"[INFO] {network_label}: {len(peer_list)} currently connected peers ({port_info}).")
    except Exception as exc:
        print(f"[WARN] {network_label} get_connected_peers failed: {exc}", file=sys.stderr)
    return peer_list


def _fetch_all_peers_from_node(owner_url, secret, network_label):
    """
    Query the owner API get_peers filtered to Healthy flag only.
    Returns a larger set than get_connected_peers — used for version stats.
    Mainnet: no port filter (nodes run on various ports); user-agent is the gate.
    Testnet: standard port 13414 filter kept.
    """
    expected_port = MAINNET_P2P_PORT if network_label == "mainnet" else TESTNET_P2P_PORT
    peer_list = []
    try:
        raw = _rpc(owner_url, "get_peers", {"peer_addr": None}, secret=secret)
        if raw:
            skipped_port  = 0
            skipped_flag  = 0
            skipped_blank = 0
            for p in raw:
                flags = str(p.get("flags", ""))
                # Only accept peers the node considers Healthy (successfully handshaked)
                if "Healthy" not in flags:
                    skipped_flag += 1
                    continue
                ip, port = _extract_addr(p, expected_port)
                if network_label == "testnet" and port != expected_port:
                    skipped_port += 1
                    continue
                if not _is_public_ip(ip):
                    continue
                # Skip blank-agent peers — gossiped routing entries never handshaked
                ua = _clean_agent(p.get("user_agent", ""))
                if not ua:
                    skipped_blank += 1
                    continue
                # Capture last_seen from the routing table (Unix timestamp)
                last_seen_raw = p.get("last_seen", 0)
                last_seen_ts  = int(last_seen_raw) if last_seen_raw else 0
                peer_list.append({
                    "ip":         ip,
                    "port":       port,
                    "user_agent": ua,
                    "direction":  p.get("direction", "Outbound"),
                    "network":    network_label,
                    "last_seen":  last_seen_ts,
                })
            port_skipped = f", {skipped_port} wrong-port" if network_label == "testnet" else ""
            print(f"[INFO] {network_label}: {len(peer_list)} healthy peers for stats "
                  f"(skipped {skipped_flag} non-Healthy{port_skipped}, "
                  f"{skipped_blank} blank-agent).")
    except Exception as exc:
        print(f"[WARN] {network_label} owner API get_peers failed: {exc}", file=sys.stderr)
    return peer_list

def _upsert_peers(conn, enriched, first_seen_ts, use_max_last_seen=False,
                  preserve_direction=False):
    """
    Upsert a list of enriched peer dicts into known_peers.
    use_max_last_seen=True  keeps the LARGER last_seen so connected peers are never
                            downgraded by older routing-table timestamps.
    preserve_direction=True keeps the existing direction column unchanged; used for
                            routing-table upserts so they never overwrite the accurate
                            direction recorded from get_connected_peers.
    """
    last_seen_sql  = (
        "CASE WHEN excluded.last_seen > last_seen THEN excluded.last_seen ELSE last_seen END"
        if use_max_last_seen else "excluded.last_seen"
    )
    direction_sql  = "direction" if preserve_direction else "excluded.direction"

    conn.executemany(f"""
        INSERT INTO known_peers
            (ip, network, port, user_agent, direction, lat, lng,
             country, country_code, city, first_seen, last_seen)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(ip, network) DO UPDATE SET
            port         = excluded.port,
            user_agent   = excluded.user_agent,
            direction    = {direction_sql},
            lat          = CASE WHEN excluded.lat  != 0  THEN excluded.lat  ELSE lat  END,
            lng          = CASE WHEN excluded.lng  != 0  THEN excluded.lng  ELSE lng  END,
            country      = CASE WHEN excluded.country      != '' THEN excluded.country      ELSE country      END,
            country_code = CASE WHEN excluded.country_code != '' THEN excluded.country_code ELSE country_code END,
            city         = CASE WHEN excluded.city         != '' THEN excluded.city         ELSE city         END,
            last_seen    = {last_seen_sql}
    """, [
        (p["ip"], p["network"], p["port"], p["user_agent"], p["direction"],
         p["lat"], p["lng"], p["country"], p["country_code"], p["city"],
         p.get("last_seen", first_seen_ts), p["last_seen"])
        for p in enriched
    ])


def _is_node_running(port):
    """Quick check if a node is listening on the given port."""
    import socket
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            return True
    except OSError:
        return False

def _update_peers():
    from collections import Counter

    # ── 1. Connected peers — for the map (verified alive right now) ───────────
    # get_connected_peers returns only peers with an active TCP session.
    # These are the only peers we store in known_peers and export to peers.json.
    map_peers = []

    if _is_node_running(3413):
        map_peers.extend(_fetch_connected_peers(MAINNET_OWNER_URL, API_SECRET, "mainnet"))
    else:
        print("[INFO] Mainnet node not running — skipping mainnet peers.")

    if _is_node_running(13413):
        map_peers.extend(_fetch_connected_peers(TESTNET_OWNER_URL, TESTNET_API_SECRET, "testnet"))
    else:
        print("[INFO] Testnet node not running — skipping testnet peers.")

    # ── 2. All healthy known peers — for version stats only ───────────────────
    # get_peers (Healthy flag) gives a larger sample for the version distribution
    # chart. These are NOT stored in known_peers and NOT exported to peers.json.
    stat_peers = []
    if _is_node_running(3413):
        stat_peers.extend(_fetch_all_peers_from_node(MAINNET_OWNER_URL, API_SECRET, "mainnet"))
    if _is_node_running(13413):
        stat_peers.extend(_fetch_all_peers_from_node(TESTNET_OWNER_URL, TESTNET_API_SECRET, "testnet"))

    if not map_peers:
        print("[WARN] No connected peers found from any node.", file=sys.stderr)
        _write_peers_json([])
        # Still record version snapshot from stat_peers if we have any
        if stat_peers:
            conn = open_db()
            ts = now_ts()
            mainnet_only = [p for p in stat_peers if p["network"] == "mainnet"]
            version_counts = Counter(p["user_agent"] for p in mainnet_only)
            if version_counts:
                conn.executemany(
                    "INSERT INTO peer_snapshots(sampled_at, user_agent, count) VALUES(?,?,?)",
                    [(ts, ua, cnt) for ua, cnt in version_counts.items()],
                )
                conn.execute("DELETE FROM peer_snapshots WHERE sampled_at < ?", (ts - 365 * 86400,))
                conn.commit()
            conn.close()
        return

    # De-duplicate map_peers (same IP+network can appear in both mainnet + testnet runs)
    seen  = set()
    dedup = []
    for p in map_peers:
        key = (p["ip"], p["network"])
        if key not in seen:
            seen.add(key)
            dedup.append(p)
    map_peers = dedup
    print(f"[INFO] Connected peers (unique): {len(map_peers)}")

    # ── 3. Geolocate connected peers ──────────────────────────────────────────
    geo_map = _geo_batch(list({p["ip"] for p in map_peers}))

    # ── 4. Build enriched connected peer list ─────────────────────────────────
    enriched = []
    ts = now_ts()
    for p in map_peers:
        geo = geo_map.get(p["ip"], {})
        enriched.append({
            "ip":           p["ip"],
            "port":         p["port"],
            "lat":          geo.get("lat", 0),
            "lng":          geo.get("lng", 0),
            "country":      geo.get("country", ""),
            "country_code": geo.get("country_code", ""),
            "city":         geo.get("city", ""),
            "user_agent":   p["user_agent"],
            "direction":    p["direction"],
            "network":      p["network"],
            "last_seen":    ts,
        })

    conn = open_db()

    # ── 5. Upsert connected peers into known_peers ────────────────────────────
    # Preserve existing geo if the new lookup returned zeros (geo API miss).
    _upsert_peers(conn, enriched, ts)

    # ── 5b. Also store routing-table peers (Healthy, port 3414) ─────────────
    # These extend the map beyond directly connected peers.
    # Grin's get_peers API returns last_seen=0 for routing-table entries, so we
    # fall back to (ts - 60s) — slightly older than live peers but within the
    # 48h frontend filter.  Connected peers always win because their last_seen=ts.
    history_cutoff = ts - PEER_HISTORY_DAYS * 86400
    for p in stat_peers:
        if not p.get("last_seen"):
            p["last_seen"] = ts - 60  # mark as "routing table" (1 min behind live)
    recent_stat = [p for p in stat_peers if p["last_seen"] >= history_cutoff]
    if recent_stat:
        connected_ips = {p["ip"] for p in map_peers}
        new_ips       = list({p["ip"] for p in recent_stat if p["ip"] not in connected_ips})
        if new_ips:
            extra_geo = _geo_batch(new_ips)
            # Merge: don't overwrite geo we already fetched for connected peers
            for ip, geo in extra_geo.items():
                geo_map.setdefault(ip, geo)
        stat_enriched = []
        for p in recent_stat:
            geo = geo_map.get(p["ip"], {})
            stat_enriched.append({
                "ip":           p["ip"],
                "port":         p["port"],
                "lat":          geo.get("lat", 0),
                "lng":          geo.get("lng", 0),
                "country":      geo.get("country", ""),
                "country_code": geo.get("country_code", ""),
                "city":         geo.get("city", ""),
                "user_agent":   p["user_agent"],
                "direction":    p["direction"],
                "network":      p["network"],
                "last_seen":    p["last_seen"],
            })
        # Use MAX(last_seen) and preserve direction so routing-table updates never
        # overwrite the accurate Inbound/Outbound direction from get_connected_peers.
        _upsert_peers(conn, stat_enriched, ts,
                      use_max_last_seen=True, preserve_direction=True)
        print(f"[INFO] Routing-table peers added to map: {len(recent_stat)} "
              f"({len(new_ips)} new IPs geo-located).")

    # ── 6. Prune peers not seen in PEER_RETENTION_DAYS + invalid agents ──────
    cutoff = ts - PEER_RETENTION_DAYS * 86400
    deleted = conn.execute(
        "DELETE FROM known_peers WHERE last_seen < ?", (cutoff,)
    ).rowcount
    if deleted:
        print(f"[INFO] Pruned {deleted} stale peers (>{PEER_RETENTION_DAYS}d).")
    # Purge blank/empty agents and the legacy 'Unknown' label — these are gossiped
    # routing-table addresses the node never handshaked, not real mapped nodes.
    purged = conn.execute(
        "DELETE FROM known_peers "
        "WHERE user_agent IS NULL OR TRIM(user_agent)='' OR user_agent='Unknown'"
    ).rowcount
    if purged:
        print(f"[INFO] Purged {purged} peers with blank/unknown agent names.")

    # ── 7. Version snapshot — use stat_peers if available, else map_peers ─────
    version_source = stat_peers if stat_peers else map_peers
    mainnet_only   = [p for p in version_source if p["network"] == "mainnet"]
    version_counts = Counter(p["user_agent"] for p in mainnet_only)
    if version_counts:
        conn.executemany(
            "INSERT INTO peer_snapshots(sampled_at, user_agent, count) VALUES(?,?,?)",
            [(ts, ua, cnt) for ua, cnt in version_counts.items()],
        )
        conn.execute("DELETE FROM peer_snapshots WHERE sampled_at < ?", (ts - 365 * 86400,))

    conn.commit()

    # ── 8. Export peers.json from known_peers (last PEER_HISTORY_DAYS) ────────
    rows = conn.execute("""
        SELECT ip, network, port, user_agent, direction,
               lat, lng, country, country_code, city, first_seen, last_seen
        FROM known_peers
        WHERE last_seen >= ?
        ORDER BY last_seen DESC
    """, (history_cutoff,)).fetchall()
    # ── 9. Record peer count snapshot for history chart ──────────────────────
    mnet_count = sum(1 for r in rows if r[1] == "mainnet")
    tnet_count = sum(1 for r in rows if r[1] == "testnet")
    # Distinct countries hosting a node this sample (country_code = r[8]), across
    # BOTH networks — same definition as the header "X countries" and the Top-10
    # Countries card, so all three displays agree.
    country_count = len({r[8] for r in rows if r[8]})
    conn.execute(
        "INSERT INTO peer_count_history"
        "(sampled_at, mainnet_count, testnet_count, country_count) VALUES(?,?,?,?)",
        (ts, mnet_count, tnet_count, country_count),
    )
    conn.execute(
        "DELETE FROM peer_count_history WHERE sampled_at < ?",
        (ts - 730 * 86400,),  # keep 2 years
    )
    conn.commit()
    conn.close()

    # IPs running on BOTH mainnet and testnet — computed on the REAL (unmasked)
    # IP so two different hosts sharing a /24 aren't falsely merged once IPv4 is
    # masked to x. Emitted as a per-peer `dual` flag the map uses for colouring.
    _nets_by_ip = {}
    for r in rows:
        _nets_by_ip.setdefault(r[0], set()).add(r[1])
    _dual_ips = {ip for ip, nets in _nets_by_ip.items()
                 if "mainnet" in nets and "testnet" in nets}

    output_peers = [
        {
            "ip":           _mask_ip(r[0]),
            "network":      r[1],
            "dual":         r[0] in _dual_ips,
            "port":         r[2],
            "user_agent":   r[3],
            "direction":    r[4],
            "lat":          r[5],
            "lng":          r[6],
            "country":      r[7],
            "country_code": r[8],
            "city":         r[9],
            "first_seen":   r[10],
            "last_seen":    r[11],
        }
        for r in rows
    ]

    mainnet_count = sum(1 for p in output_peers if p["network"] == "mainnet")
    testnet_count = sum(1 for p in output_peers if p["network"] == "testnet")
    _write_peers_json(output_peers, mainnet_count, testnet_count)
    print(f"[INFO] Peers written: {mainnet_count} mainnet, {testnet_count} testnet "
          f"(connected + routing-table peers from last {PEER_HISTORY_DAYS}d).")

def _write_peers_json(peers, mainnet_count=0, testnet_count=0):
    os.makedirs(WWW_DATA, exist_ok=True)
    out = {
        "updated":        now_ts(),
        "count":          len(peers),
        "mainnet_count":  mainnet_count,
        "testnet_count":  testnet_count,
        "peers":          peers,
    }
    _write_json("peers.json", out)

# ── JSON export ───────────────────────────────────────────────────────────────

def export_all_json():
    os.makedirs(WWW_DATA, exist_ok=True)
    conn = open_db()
    ts_now = now_ts()

    # ── hashrate + difficulty ────────────────────────────────────────────────
    # hashrate (GPS) is stored with the Cuckatoo32 formula: net_diff * 42 / dt / 16384
    # To recover per-block difficulty (net_diff) from stored hashrate:
    #   net_diff = hashrate_GPS * block_target_seconds * 16384 / 42
    # This matches what aglkm/grin-explorer displays as "difficulty".
    BLOCK_TARGET    = 60       # seconds (Grin target block time)
    CUCKOO_CYCLE    = 42.0
    C32_RATE        = 16384.0
    DIFF_MUL        = BLOCK_TARGET * C32_RATE / CUCKOO_CYCLE  # ~23405.7

    # For each bucket, compute hashrate by grouping into time bins and computing
    # delta total_diff / delta time between consecutive bins.  This normalises
    # both sparse entries (from --init-history) and dense per-block entries
    # (aged out of the recent window by --update) which would otherwise spike.

    # Daily: one representative per calendar day
    daily_bins = conn.execute("""
        SELECT (timestamp/86400)*86400 AS day_ts,
               MAX(timestamp)          AS max_ts,
               MAX(total_diff)         AS max_td
        FROM blocks WHERE bucket='daily' AND total_diff > 0
        GROUP BY day_ts ORDER BY day_ts
    """).fetchall()
    hr_daily = []
    for i in range(1, len(daily_bins)):
        _, p_ts, p_td = daily_bins[i - 1]
        d_ts, c_ts, c_td = daily_bins[i]
        dt = c_ts - p_ts
        dd = c_td - p_td
        if dt > 0 and dd > 0:
            hr_daily.append((d_ts, round(dd * CUCKOO_CYCLE / dt / C32_RATE, 2)))

    # Hourly: one representative per hour — normalises sparse (every-60-blocks from
    # --init-history) and dense (per-block, aged from recent via --update) entries.
    hourly_bins = conn.execute("""
        SELECT (timestamp/3600)*3600 AS hour_ts,
               MAX(timestamp)         AS max_ts,
               MAX(total_diff)        AS max_td
        FROM blocks WHERE bucket='hourly' AND total_diff > 0
        GROUP BY hour_ts ORDER BY hour_ts
    """).fetchall()
    hr_hourly = []
    for i in range(1, len(hourly_bins)):
        _, p_ts, p_td = hourly_bins[i - 1]
        h_ts, c_ts, c_td = hourly_bins[i]
        dt = c_ts - p_ts
        dd = c_td - p_td
        if dt > 0 and dd > 0:
            hr_hourly.append((h_ts, round(dd * CUCKOO_CYCLE / dt / C32_RATE, 2)))

    # Recent: 30-block rolling window (~30 minutes) to smooth out 1-second timestamp
    # resolution variance while still showing meaningful sub-hour hashrate trends.
    # Order by height (not timestamp) because Grin timestamps can be non-monotonic
    # (miners set them within protocol bounds), which would corrupt the dt calculation.
    # Start from index SMOOTH_N so every point always has a full 30-block window —
    # the clamped j=0 warm-up phase produces spikes when early blocks share the same
    # second timestamp (dt→0 while dd spans multiple blocks).
    recent_td = conn.execute(
        "SELECT timestamp, total_diff FROM blocks WHERE bucket='recent' AND total_diff > 0 ORDER BY height"
    ).fetchall()
    SMOOTH_N = 30
    hr_recent = []
    for i in range(SMOOTH_N, len(recent_td)):
        j = i - SMOOTH_N
        dt = recent_td[i][0] - recent_td[j][0]
        dd = recent_td[i][1] - recent_td[j][1]
        if dt > 0 and dd > 0:
            hr_recent.append((recent_td[i][0], round(dd * CUCKOO_CYCLE / dt / C32_RATE, 2)))

    for metric, mul in (("hashrate", 1), ("difficulty", DIFF_MUL)):
        _write_json(f"{metric}.json", {
            "updated": ts_now,
            "daily":   [[r[0], round(r[1] * mul, 2)] for r in hr_daily],
            "hourly":  [[r[0], round(r[1] * mul, 2)] for r in hr_hourly],
            "recent":  [[r[0], round(r[1] * mul, 2)] for r in hr_recent],
        })

    # ── tip stats ─────────────────────────────────────────────────────────────
    tip_row = conn.execute(
        "SELECT height, timestamp, total_diff FROM blocks ORDER BY height DESC LIMIT 2"
    ).fetchall()
    tip_height = tip_row[0][0] if tip_row else 0

    # ── transactions + fees ───────────────────────────────────────────────────
    cutoff_24h  = ts_now - 86400
    cutoff_30d  = ts_now - 30 * 86400
    cutoff_all  = 0

    for metric, col in (("transactions", "tx_count"), ("fees", "fee_total")):
        recent = conn.execute(
            f"SELECT timestamp, {col} FROM block_stats WHERE timestamp >= ? ORDER BY timestamp",
            (cutoff_24h,),
        ).fetchall()
        hourly_raw = conn.execute(
            f"SELECT (timestamp/3600)*3600 as bucket_ts, SUM({col}) "
            f"FROM block_stats WHERE timestamp >= ? "
            f"GROUP BY bucket_ts ORDER BY bucket_ts",
            (cutoff_30d,),
        ).fetchall()
        daily_raw = conn.execute(
            f"SELECT (timestamp/86400)*86400 as bucket_ts, SUM({col}) "
            f"FROM block_stats WHERE timestamp < ? "
            f"GROUP BY bucket_ts ORDER BY bucket_ts",
            (cutoff_30d,),
        ).fetchall()

        _write_json(f"{metric}.json", {
            "updated": ts_now,
            "daily":   [[r[0], r[1] if r[1] is not None else 0] for r in daily_raw],
            "hourly":  [[r[0], r[1] if r[1] is not None else 0] for r in hourly_raw],
            "recent":  [[r[0], r[1]] for r in recent],
        })

    # ── kernels + outputs (cumulative counts since genesis) ────────────────────
    # Header MMR sizes → real leaf counts. These are *levels* (monotonic), so each
    # time bucket takes the MAX MMR in that window (not a sum). Coverage matches the
    # blocks table sampling: daily since genesis, hourly for ~30d, per-block recent.
    cur_kernels = cur_outputs = 0
    for metric, col in (("kernels", "kernel_mmr"), ("outputs", "output_mmr")):
        daily_raw = conn.execute(
            f"SELECT (timestamp/86400)*86400 AS bts, MAX({col}) "
            f"FROM blocks WHERE bucket='daily' AND {col} > 0 GROUP BY bts ORDER BY bts"
        ).fetchall()
        hourly_raw = conn.execute(
            f"SELECT (timestamp/3600)*3600 AS bts, MAX({col}) "
            f"FROM blocks WHERE bucket='hourly' AND {col} > 0 GROUP BY bts ORDER BY bts"
        ).fetchall()
        recent_raw = conn.execute(
            f"SELECT timestamp, {col} FROM blocks "
            f"WHERE bucket='recent' AND {col} > 0 ORDER BY height"
        ).fetchall()

        latest = conn.execute(
            f"SELECT {col} FROM blocks WHERE {col} > 0 ORDER BY height DESC LIMIT 1"
        ).fetchone()
        if latest:
            if col == "kernel_mmr": cur_kernels = mmr_leaves(latest[0])
            else:                   cur_outputs = mmr_leaves(latest[0])

        _write_json(f"{metric}.json", {
            "updated": ts_now,
            "daily":   [[r[0], mmr_leaves(r[1])] for r in daily_raw],
            "hourly":  [[r[0], mmr_leaves(r[1])] for r in hourly_raw],
            "recent":  [[r[0], mmr_leaves(r[1])] for r in recent_raw],
        })

    # ── mempool (unconfirmed tx pool) — forward-only gauge ─────────────────────
    # A level metric: bucket with AVG (not sum). recent = raw samples (last 24h),
    # hourly = per-hour average for ~30d, daily = per-day average beyond that.
    mp_recent = conn.execute(
        "SELECT sampled_at, pool_size FROM mempool_history WHERE sampled_at >= ? ORDER BY sampled_at",
        (cutoff_24h,),
    ).fetchall()
    mp_hourly = conn.execute(
        "SELECT (sampled_at/3600)*3600 AS bts, AVG(pool_size) "
        "FROM mempool_history WHERE sampled_at >= ? GROUP BY bts ORDER BY bts",
        (cutoff_30d,),
    ).fetchall()
    mp_daily = conn.execute(
        "SELECT (sampled_at/86400)*86400 AS bts, AVG(pool_size) "
        "FROM mempool_history WHERE sampled_at < ? GROUP BY bts ORDER BY bts",
        (cutoff_30d,),
    ).fetchall()
    mp_latest = conn.execute(
        "SELECT pool_size FROM mempool_history ORDER BY sampled_at DESC LIMIT 1"
    ).fetchone()
    cur_mempool = int(mp_latest[0]) if mp_latest else None

    _write_json("mempool.json", {
        "updated": ts_now,
        "current": cur_mempool,
        "daily":   [[r[0], round(r[1], 2) if r[1] is not None else 0] for r in mp_daily],
        "hourly":  [[r[0], round(r[1], 2) if r[1] is not None else 0] for r in mp_hourly],
        "recent":  [[r[0], r[1]] for r in mp_recent],
    })

    # ── UTXO set size (live unspent outputs) — forward-only level metric ───────
    ut_recent = conn.execute(
        "SELECT sampled_at, utxo_count FROM utxo_history WHERE sampled_at >= ? ORDER BY sampled_at",
        (cutoff_24h,),
    ).fetchall()
    ut_hourly = conn.execute(
        "SELECT (sampled_at/3600)*3600 AS bts, AVG(utxo_count) "
        "FROM utxo_history WHERE sampled_at >= ? GROUP BY bts ORDER BY bts",
        (cutoff_30d,),
    ).fetchall()
    ut_daily = conn.execute(
        "SELECT (sampled_at/86400)*86400 AS bts, AVG(utxo_count) "
        "FROM utxo_history WHERE sampled_at < ? GROUP BY bts ORDER BY bts",
        (cutoff_30d,),
    ).fetchall()
    ut_latest = conn.execute(
        "SELECT utxo_count FROM utxo_history ORDER BY sampled_at DESC LIMIT 1"
    ).fetchone()
    cur_utxo = int(ut_latest[0]) if ut_latest else None

    _write_json("utxo.json", {
        "updated": ts_now,
        "current": cur_utxo,
        "daily":   [[r[0], round(r[1]) if r[1] is not None else 0] for r in ut_daily],
        "hourly":  [[r[0], round(r[1]) if r[1] is not None else 0] for r in ut_hourly],
        "recent":  [[r[0], r[1]] for r in ut_recent],
    })

    # ── Daily aggregate snapshot (powers the year/all-time Top-10 toggle) ──────
    # known_peers is pruned at PEER_RETENTION_DAYS (30d), so week/month rankings can
    # read it live but year/all-time cannot. Each run records the day's active-node
    # counts (last 24h) per country and per version into *_daily, REPLACEing today's
    # rows so the last run of the day wins. These tables build forward — no backfill
    # of pre-existing history is possible. See timeframe builders below.
    day_ts     = (ts_now // 86400) * 86400
    day_cutoff = ts_now - 86400
    for _net in ("mainnet", "testnet"):
        conn.execute("DELETE FROM country_daily WHERE day_ts=? AND network=?", (day_ts, _net))
        for _code, _name, _cnt in conn.execute(
            "SELECT country_code, country, COUNT(*) FROM known_peers "
            "WHERE last_seen>=? AND network=? AND country_code<>'' GROUP BY country_code",
            (day_cutoff, _net),
        ):
            conn.execute(
                "INSERT OR REPLACE INTO country_daily"
                "(day_ts,network,country_code,country_name,peer_count) VALUES(?,?,?,?,?)",
                (day_ts, _net, _code, _name or _code, _cnt))
        conn.execute("DELETE FROM version_daily WHERE day_ts=? AND network=?", (day_ts, _net))
        for _ua, _cnt in conn.execute(
            "SELECT user_agent, COUNT(*) FROM known_peers "
            "WHERE last_seen>=? AND network=? AND user_agent IS NOT NULL "
            "AND TRIM(user_agent)<>'' AND user_agent<>'Unknown' GROUP BY user_agent",
            (day_cutoff, _net),
        ):
            conn.execute(
                "INSERT OR REPLACE INTO version_daily(day_ts,network,user_agent,count) "
                "VALUES(?,?,?,?)", (day_ts, _net, _ua, _cnt))

    # Accumulate the all-time distinct-node registry (powers the "All Time" Top-10 =
    # DISTINCT nodes ever seen). UPSERT from the live known_peers set: first_seen keeps
    # the earliest ever recorded, last_seen + geo/version refresh to the most recent.
    # One row per (ip, network) forever — the only structure that can count distinct
    # nodes across all time, since known_peers is pruned at 30d.
    conn.execute("""
        INSERT INTO seen_peers (ip, network, country_code, country, user_agent, first_seen, last_seen)
        SELECT ip, network, country_code, country, COALESCE(user_agent, ''), first_seen, last_seen
        FROM known_peers WHERE ip IS NOT NULL AND TRIM(ip) <> ''
        ON CONFLICT(ip, network) DO UPDATE SET
            first_seen   = MIN(seen_peers.first_seen, excluded.first_seen),
            last_seen    = MAX(seen_peers.last_seen, excluded.last_seen),
            country_code = CASE WHEN excluded.country_code <> '' THEN excluded.country_code ELSE seen_peers.country_code END,
            country      = CASE WHEN excluded.country <> ''      THEN excluded.country      ELSE seen_peers.country END,
            user_agent   = CASE WHEN TRIM(excluded.user_agent) <> '' THEN excluded.user_agent ELSE seen_peers.user_agent END
    """)
    conn.commit()

    # Timeframe windows. week/month query known_peers live (both within the 30d
    # retention); year/all read the accumulating *_daily tables. year_since=None on
    # the daily side means "all rows", capped to 365d here.
    version_cutoff = ts_now - PEER_HISTORY_DAYS * 86400   # 7d  → "week"
    month_cutoff   = ts_now - 30 * 86400                  # 30d → "month" (retention edge)
    year_since     = day_ts - 364 * 86400                 # 365 daily points → "year"

    # ── node versions (per network: mainnet / testnet / both) ─────────────────
    def _ver_rows(net, cutoff):
        return conn.execute(
            "SELECT user_agent, COUNT(*) AS cnt FROM known_peers "
            "WHERE last_seen >= ? AND network=? "
            "GROUP BY user_agent ORDER BY cnt DESC",
            (cutoff, net),
        ).fetchall()

    def _ver_list(rows):
        """rows: (user_agent, count) sorted desc → top-10 + 'Other versions' list, total."""
        total = sum(r[1] for r in rows)
        top   = rows[:10]
        other = sum(r[1] for r in rows[10:])
        vlist = [{"label": r[0], "count": r[1]} for r in top]
        if other > 0:
            vlist.append({"label": "Other versions", "count": other})
        return vlist, total

    def _ver_networks(rank_fn):
        """rank_fn(net) → [(user_agent, count)] desc; builds the mainnet/testnet/both dict."""
        m = rank_fn("mainnet")
        t = rank_fn("testnet")
        b = Counter()
        for ua, cnt in m: b[ua] += cnt
        for ua, cnt in t: b[ua] += cnt
        mv, mt = _ver_list(m)
        tv, tt = _ver_list(t)
        bv, bt = _ver_list(b.most_common())
        return {
            "mainnet": {"versions": mv, "sampled_from": mt},
            "testnet": {"versions": tv, "sampled_from": tt},
            "both":    {"versions": bv, "sampled_from": bt},
        }

    def _ver_daily_rank(net, since):
        """AVG concurrent nodes per version over the window (absent days count as 0)."""
        where, params = "network=?", [net]
        if since is not None:
            where += " AND day_ts>=?"; params.append(since)
        ndays = conn.execute(
            f"SELECT COUNT(DISTINCT day_ts) FROM version_daily WHERE {where}", params
        ).fetchone()[0] or 1
        rows = conn.execute(
            f"SELECT user_agent, SUM(count) FROM version_daily WHERE {where} GROUP BY user_agent",
            params,
        ).fetchall()
        out = [(ua, max(1, round(s / ndays))) for ua, s in rows]
        out.sort(key=lambda r: -r[1])
        return out

    def _ver_seen_unique(net):
        """All-time: COUNT of DISTINCT nodes ever seen, grouped by version (from seen_peers)."""
        rows = conn.execute(
            "SELECT user_agent, COUNT(*) FROM seen_peers "
            "WHERE network=? AND user_agent IS NOT NULL AND TRIM(user_agent)<>'' "
            "AND user_agent<>'Unknown' GROUP BY user_agent",
            (net,),
        ).fetchall()
        out = [(ua, cnt) for ua, cnt in rows]
        out.sort(key=lambda r: -r[1])
        return out

    week_vnets  = _ver_networks(lambda n: _ver_rows(n, version_cutoff))

    # Fall back to latest peer_snapshots (mainnet-only) if known_peers has no data yet
    if week_vnets["mainnet"]["sampled_from"] == 0 and week_vnets["testnet"]["sampled_from"] == 0:
        latest_snap_ts = conn.execute(
            "SELECT MAX(sampled_at) FROM peer_snapshots"
        ).fetchone()[0]
        if latest_snap_ts:
            rows = conn.execute(
                "SELECT user_agent, count FROM peer_snapshots WHERE sampled_at=? ORDER BY count DESC",
                (latest_snap_ts,),
            ).fetchall()
            sv, st = _ver_list(rows)
            week_vnets["mainnet"] = {"versions": sv, "sampled_from": st}
            week_vnets["both"]    = {"versions": sv, "sampled_from": st}

    # Always write versions.json so the page can load even with no snapshot data.
    # Top-level keys mirror the "week" mainnet view for backward compatibility; the
    # per-network breakdown lives under "networks", and "timeframes" carries the
    # week/month/year/all variants for the page's Top-10 timeframe toggle.
    _write_json("versions.json", {
        "updated":      ts_now,
        "sampled_from": week_vnets["mainnet"]["sampled_from"],
        "versions":     week_vnets["mainnet"]["versions"],
        "networks":     week_vnets,
        "timeframes": {
            "week":  week_vnets,
            "month": _ver_networks(lambda n: _ver_rows(n, month_cutoff)),
            "year":  _ver_networks(lambda n: _ver_daily_rank(n, year_since)),
            "all":   _ver_networks(lambda n: _ver_seen_unique(n)),
        },
    })

    # ── top countries (per network: mainnet / testnet / both) ─────────────────
    # Same windows + structure as versions; counts distinct peers per country.
    def _country_rows(net, cutoff):
        return conn.execute(
            "SELECT country_code, country, COUNT(*) AS cnt FROM known_peers "
            "WHERE last_seen >= ? AND network=? AND country_code != '' "
            "GROUP BY country_code ORDER BY cnt DESC",
            (cutoff, net),
        ).fetchall()

    def _country_list(rows):
        """rows: (code, name, count) sorted desc → top-10 + 'Other countries', total."""
        total = sum(r[2] for r in rows)
        top   = rows[:10]
        other = sum(r[2] for r in rows[10:])
        clist = [{"label": r[1] or r[0], "code": r[0], "count": r[2]} for r in top]
        if other > 0:
            clist.append({"label": "Other countries", "code": "", "count": other})
        return clist, total

    def _country_networks(rank_fn):
        """rank_fn(net) → [(code, name, count)] desc; builds the mainnet/testnet/both dict."""
        m = rank_fn("mainnet")
        t = rank_fn("testnet")
        bc, bn = Counter(), {}
        for code, name, cnt in m + t:
            bc[code] += cnt
            bn.setdefault(code, name)
        b = [(code, bn[code], cnt) for code, cnt in bc.most_common()]
        mc, mt = _country_list(m)
        tc, tt = _country_list(t)
        bcl, bt = _country_list(b)
        return {
            "mainnet": {"countries": mc,  "sampled_from": mt},
            "testnet": {"countries": tc,  "sampled_from": tt},
            "both":    {"countries": bcl, "sampled_from": bt},
        }

    def _country_daily_rank(net, since):
        """AVG concurrent nodes per country over the window (absent days count as 0)."""
        where, params = "network=? AND country_code<>''", [net]
        if since is not None:
            where += " AND day_ts>=?"; params.append(since)
        ndays = conn.execute(
            f"SELECT COUNT(DISTINCT day_ts) FROM country_daily WHERE {where}", params
        ).fetchone()[0] or 1
        rows = conn.execute(
            f"SELECT country_code, MAX(country_name), SUM(peer_count) "
            f"FROM country_daily WHERE {where} GROUP BY country_code", params,
        ).fetchall()
        out = [(code, name, max(1, round(s / ndays))) for code, name, s in rows]
        out.sort(key=lambda r: -r[2])
        return out

    def _country_seen_unique(net):
        """All-time: COUNT of DISTINCT nodes ever seen, grouped by country (from seen_peers)."""
        rows = conn.execute(
            "SELECT country_code, MAX(country), COUNT(*) "
            "FROM seen_peers WHERE network=? AND country_code<>'' GROUP BY country_code",
            (net,),
        ).fetchall()
        out = [(code, name, cnt) for code, name, cnt in rows]
        out.sort(key=lambda r: -r[2])
        return out

    week_cnets = _country_networks(lambda n: _country_rows(n, version_cutoff))

    _write_json("countries.json", {
        "updated":      ts_now,
        "sampled_from": week_cnets["mainnet"]["sampled_from"],
        "countries":    week_cnets["mainnet"]["countries"],
        "networks":     week_cnets,
        "timeframes": {
            "week":  week_cnets,
            "month": _country_networks(lambda n: _country_rows(n, month_cutoff)),
            "year":  _country_networks(lambda n: _country_daily_rank(n, year_since)),
            "all":   _country_networks(lambda n: _country_seen_unique(n)),
        },
    })

    # ── active peers history ──────────────────────────────────────────────────
    cutoff_peer_30d = ts_now - 30 * 86400
    cutoff_peer_24h = ts_now - 86400

    def _peer_series(col):
        daily = conn.execute(f"""
            SELECT (sampled_at/86400)*86400 AS day_ts,
                   CAST(ROUND(AVG({col})) AS INTEGER)
            FROM peer_count_history WHERE sampled_at < ?
            GROUP BY day_ts ORDER BY day_ts
        """, (cutoff_peer_30d,)).fetchall()
        hourly = conn.execute(f"""
            SELECT (sampled_at/3600)*3600 AS hour_ts,
                   CAST(ROUND(AVG({col})) AS INTEGER)
            FROM peer_count_history WHERE sampled_at >= ?
            GROUP BY hour_ts ORDER BY hour_ts
        """, (cutoff_peer_30d,)).fetchall()
        recent = conn.execute(f"""
            SELECT sampled_at, {col}
            FROM peer_count_history WHERE sampled_at >= ?
            ORDER BY sampled_at
        """, (cutoff_peer_24h,)).fetchall()
        return {
            "daily":  [[r[0], r[1]] for r in daily],
            "hourly": [[r[0], r[1]] for r in hourly],
            "recent": [[r[0], r[1]] for r in recent],
        }

    _write_json("active_peers.json", {
        "updated":   ts_now,
        "mainnet":   _peer_series("mainnet_count"),
        "testnet":   _peer_series("testnet_count"),
        "countries": _peer_series("country_count"),  # distinct countries, both networks; builds forward
    })

    # ── summary (for the header stats bar) ───────────────────────────────────
    # Use the 1440-block (≈ 1 day) total_diff window — matches aglkm/grin-explorer:
    #   net_diff = (total_diff[H] - total_diff[H-1440]) / 1440
    #   hashrate = net_diff * 42 / 60 / 16384
    # Fall back to a 60-block hashrate average if fewer rows exist.
    tip_blocks = conn.execute(
        "SELECT height, total_diff FROM blocks ORDER BY height DESC LIMIT 1441"
    ).fetchall()

    if len(tip_blocks) >= 2:
        hi_h, hi_d = tip_blocks[0]
        lo_h, lo_d = tip_blocks[-1]
        block_count = hi_h - lo_h
        if block_count > 0:
            avg_diff       = (hi_d - lo_d) / block_count          # per-block difficulty
            avg_hr         = round(avg_diff * CUCKOO_CYCLE / BLOCK_TARGET / C32_RATE, 2)
            current_diff   = round(avg_diff, 0)
        else:
            avg_hr, current_diff = 0, 0
    else:
        avg_hr_row = conn.execute(
            "SELECT AVG(hashrate) FROM (SELECT hashrate FROM blocks ORDER BY height DESC LIMIT 60)"
        ).fetchone()
        avg_hr       = round(avg_hr_row[0], 2) if avg_hr_row and avg_hr_row[0] else 0
        current_diff = round(avg_hr * DIFF_MUL, 0)

    _write_json("summary.json", {
        "updated":            ts_now,
        "tip_height":         tip_height,
        "current_hashrate":   avg_hr,
        "current_difficulty": current_diff,
        "current_kernels":    cur_kernels,
        "current_outputs":    cur_outputs,
        "current_mempool":    cur_mempool,
        "current_utxo":       cur_utxo,
    })

    conn.close()

    export_inflation_json()
    print("[OK] JSON exported to:", WWW_DATA,
          "(hashrate, difficulty, transactions, fees, active_peers, versions, summary, inflation)")

# ── Inflation history export ──────────────────────────────────────────────────

# Grin mainnet genesis: 2019-01-15 00:00 UTC
_MAINNET_TS = 1547510400

# ── Gold supply: World Gold Council annual mine production data ────────────────
# Source: WGC Gold Demand Trends annual reports (https://www.gold.org/goldhub/data)
# Annual mine production in tonnes.  Update each February when WGC publishes Q4 figures.
_GOLD_MINE_PROD_T = {
    2019: 3534,
    2020: 3401,
    2021: 3561,
    2022: 3612,
    2023: 3644,
    2024: 3661,
    2025: 3672,   # WGC Gold Demand Trends FY2025 — record 3,671.6t (initial est.)
}
_GOLD_STOCK_END_2018 = 190_000   # tonnes above-ground stock at end of 2018 (WGC)
_GOLD_DEFAULT_PROD   = 3_650     # tonne/yr fallback for years not yet in WGC report

def _upsert_inflation_ext(conn, year, asset, rate_pct, source):
    conn.execute(
        """INSERT INTO inflation_ext (year, asset, rate_pct, source, fetched)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(year, asset) DO UPDATE SET
               rate_pct = excluded.rate_pct,
               source   = excluded.source,
               fetched  = excluded.fetched""",
        (year, asset, rate_pct, source, now_ts()),
    )

def _refresh_gold_in_db(conn):
    """
    Upsert gold supply inflation rows into inflation_ext using WGC production data.
    Deterministic — safe to re-run any time; only updates rows where WGC data exists.
    """
    stock = _GOLD_STOCK_END_2018
    current_year = datetime.now(tz=timezone.utc).year
    for year in range(2019, current_year + 1):
        prod = _GOLD_MINE_PROD_T.get(year)
        if prod is None:
            stock += _GOLD_DEFAULT_PROD   # advance stock estimate even for unknown years
            continue                      # don't write speculative rows
        rate = round((prod / stock) * 100, 2)
        _upsert_inflation_ext(conn, year, "gold", rate, "wgc:calc")
        stock += prod
    conn.commit()

def _refresh_usd_m2_in_db(conn):
    """
    Fetch US broad money supply growth (annual %) from World Bank API and upsert into inflation_ext.
    Indicator FM.LBL.BMNY.ZG — Broad money growth (annual %) — direct analog to crypto/gold
    supply inflation: how fast new USD units enter circulation relative to existing supply.
    If the fetch fails, existing DB rows are untouched — history is preserved.
    Source: api.worldbank.org — free, no key required, CORS-enabled.
    """
    url = (
        "https://api.worldbank.org/v2/country/US/indicator/FM.LBL.BMNY.ZG"
        "?format=json&per_page=20&mrv=15"
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "grin-stats/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = json.loads(resp.read())
        items = raw[1] if isinstance(raw, list) and len(raw) > 1 else []
        count = 0
        for item in items:
            if item.get("value") is not None:
                year = int(item["date"])
                if year >= 2019:
                    _upsert_inflation_ext(
                        conn, year, "usd_m2",
                        round(float(item["value"]), 2),
                        "worldbank:FM.LBL.BMNY.ZG",
                    )
                    count += 1
        conn.commit()
        print(f"[OK] USD M2: {count} year(s) upserted from World Bank.")
    except Exception as exc:
        print(f"[WARN] USD M2 fetch from World Bank failed: {exc} — using cached DB rows.")

def _read_inflation_ext(conn, asset):
    """Read all stored rows for an asset from DB, sorted by year."""
    rows = conn.execute(
        "SELECT year, rate_pct, source FROM inflation_ext WHERE asset = ? ORDER BY year",
        (asset,),
    ).fetchall()
    return [{"year": r[0], "rate_pct": r[1], "source": r[2]} for r in rows]

def export_inflation_json():
    """
    Generate issuance.json — annual supply inflation comparison since Grin mainnet.
      grin    : deterministic math (1 GRIN/sec emission) — always recalculated
      usd_m2 : World Bank API (US) → persisted in inflation_ext → served from DB
      gold   : WGC mine production calc → persisted in inflation_ext → served from DB

    USD M2 and Gold are DB-backed: a source outage only prevents new rows from being
    added — all historical rows already in the DB are preserved and still exported.
    """
    ts_now       = now_ts()
    current_year = datetime.fromtimestamp(ts_now, tz=timezone.utc).year
    GRINS_PER_YEAR = 365.25 * 86400  # 31,557,600

    # ── Open DB, refresh external data, read back ─────────────────────────────
    conn = open_db()
    init_schema(conn)                # ensures inflation_ext table exists (safe migration)
    _refresh_gold_in_db(conn)        # deterministic — always safe to run
    _refresh_usd_m2_in_db(conn)  # fetches World Bank US; falls back to cached rows on failure

    usd_m2_rows = _read_inflation_ext(conn, "usd_m2")
    gold_rows   = _read_inflation_ext(conn, "gold")
    conn.close()

    # ── Grin (pure math, no DB) ───────────────────────────────────────────────
    grin_data = []
    for year in range(2019, current_year + 1):
        ts_jan1      = int(datetime(year, 1, 1, tzinfo=timezone.utc).timestamp())
        ts_jan1_next = int(datetime(year + 1, 1, 1, tzinfo=timezone.utc).timestamp())

        if year == 2019:
            supply_start = 0
            new_coins    = ts_jan1_next - _MAINNET_TS
            rate_pct     = None
        elif year == current_year:
            supply_start = ts_jan1 - _MAINNET_TS
            new_coins    = round(GRINS_PER_YEAR)
            rate_pct     = round((GRINS_PER_YEAR / supply_start) * 100, 2)
        else:
            supply_start = ts_jan1 - _MAINNET_TS
            new_coins    = ts_jan1_next - ts_jan1
            rate_pct     = round((new_coins / supply_start) * 100, 2)

        grin_data.append({
            "year":         year,
            "supply_start": supply_start,
            "new_coins":    new_coins,
            "rate_pct":     rate_pct,
        })

    _write_json("issuance.json", {
        "updated":      ts_now,
        "description":  "Annual supply inflation comparison since Grin mainnet (2019-present)",
        "unit":         "percent",
        "mainnet_ts":   _MAINNET_TS,
        "mainnet_date": "2019-01-15",
        "notes": {
            "grin_2019":          "Partial year — mainnet launched Jan 15. supply_start=0, rate_pct=null.",
            "grin_current_yr":    "Projected full-year rate (GRINS_PER_YEAR / supply_at_jan1).",
            "usd_m2_source": "World Bank API — US FM.LBL.BMNY.ZG. DB-backed: history survives outages. Years with negative M2 growth (e.g. 2023) are stored but excluded from log-scale chart.",
            "gold_source":   "WGC mine production / cumulative stock. DB-backed: history survives.",
        },
        "grin":   grin_data,
        "usd_m2": usd_m2_rows,
        "gold":   gold_rows,
    })

def _write_json(filename, data):
    path = os.path.join(WWW_DATA, filename)
    tmp  = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    os.replace(tmp, path)  # atomic write

# ── DB init only ──────────────────────────────────────────────────────────────

def cmd_init_db():
    conn = open_db()
    init_schema(conn)
    conn.close()
    print(f"[OK] Database initialised: {DB_PATH}")

# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Grin Stats Collector")
    group  = parser.add_mutually_exclusive_group()
    group.add_argument("--init-db",        action="store_true", help="Create DB schema only")
    group.add_argument("--init-history",   action="store_true", help="Backfill all historical data (headers + complete TX/fee history)")
    group.add_argument("--update",         action="store_true", help="Fetch new blocks + update peers + TX stats")
    group.add_argument("--peers-only",     action="store_true", help="Update peer data only")
    group.add_argument("--backfill-stats", nargs="?", const=180, metavar="DAYS|all",
                       help="Fetch TX/fee stats for last N days or 'all' for complete history (default: 180)")
    group.add_argument("--backfill-mmr", action="store_true",
                       help="Populate kernel/output MMR sizes on existing blocks rows from headers (fast, header-only)")
    group.add_argument("--export-inflation", action="store_true",
                       help="Write issuance.json — fetches USD M2 from World Bank + Gold from WGC, stores in DB, exports JSON")
    args = parser.parse_args()

    if args.init_db:
        cmd_init_db()
    elif args.init_history:
        cmd_init_history()
    elif args.peers_only:
        conn = open_db()
        init_schema(conn)
        conn.close()
        _update_peers()
        export_all_json()
    elif args.backfill_mmr:
        cmd_backfill_mmr()
    elif args.export_inflation:
        os.makedirs(WWW_DATA, exist_ok=True)
        export_inflation_json()
        print("[OK] issuance.json written to:", WWW_DATA)
    elif args.backfill_stats is not None:
        # Handle "all" keyword or numeric days
        if isinstance(args.backfill_stats, str) and args.backfill_stats.lower() == "all":
            cmd_backfill_stats(float('inf'))
        else:
            try:
                days = int(args.backfill_stats) if isinstance(args.backfill_stats, str) else args.backfill_stats
                cmd_backfill_stats(days)
            except ValueError:
                print(f"[ERROR] Invalid --backfill-stats argument: {args.backfill_stats}. Use a number or 'all'.", 
                      file=sys.stderr)
                sys.exit(1)
    else:
        # Default: --update
        cmd_update()

if __name__ == "__main__":
    main()
