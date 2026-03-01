#!/usr/bin/env python3
"""
grin-stats-collector
====================
Collects Grin network stats from a local node and exports JSON for Chart.js + Globe.GL.

Usage:
    python3 06_collector.py --init-db         create schema only
    python3 06_collector.py --init-history    backfill all historical data (sampled)
    python3 06_collector.py --update          fetch new blocks + update peers
    python3 06_collector.py --peers-only      update peer geolocation only

Config (env vars or /var/lib/grin-stats/config.env):
    GRIN_NODE_URL          default: http://127.0.0.1:3413/v2/foreign
    GRIN_API_SECRET_PATH   path to .api_secret file (optional)
    GRIN_WWW_DATA          default: /var/www/grin-stats/data
    GRIN_DB_PATH           default: /var/lib/grin-stats/stats.db
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
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

# ── Config ────────────────────────────────────────────────────────────────────

# Foreign API (mainnet) — used for block stats (no auth required)
NODE_URL    = os.environ.get("GRIN_NODE_URL",    "http://127.0.0.1:3413/v2/foreign")
WWW_DATA    = os.environ.get("GRIN_WWW_DATA",    "/var/www/grin-stats/data")
DB_PATH     = os.environ.get("GRIN_DB_PATH",     "/var/lib/grin-stats/stats.db")
SECRET_PATH = os.environ.get("GRIN_API_SECRET_PATH", "")

# Owner APIs — used for get_peers (all known peers, not just connected)
# get_peers on owner API returns 100s of known peers vs 8-30 from get_connected_peers
MAINNET_OWNER_URL  = os.environ.get("GRIN_MAINNET_OWNER_URL", "http://127.0.0.1:3413/v2/owner")
TESTNET_OWNER_URL  = os.environ.get("GRIN_TESTNET_OWNER_URL", "http://127.0.0.1:13413/v2/owner")
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
# How many days back to include in peers.json (0 = current run only)
PEER_HISTORY_DAYS   = 7

# ── API secret ────────────────────────────────────────────────────────────────

def _load_secret(path=""):
    p = path or SECRET_PATH
    if p and os.path.isfile(p):
        with open(p) as f:
            return f.read().strip()
    return ""

API_SECRET         = _load_secret(SECRET_PATH)
TESTNET_API_SECRET = _load_secret(TESTNET_SECRET_PATH)

# ── Grin JSON-RPC helper ──────────────────────────────────────────────────────

def _rpc(url, method, params=None, secret="", retries=3):
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
            with urllib.request.urlopen(req, timeout=15) as resp:
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

def grin_rpc(method, params=None, retries=3):
    """Foreign API call (mainnet, no auth needed for public methods)."""
    return _rpc(NODE_URL, method, params, secret=API_SECRET, retries=retries)

# ── Timestamp helpers ─────────────────────────────────────────────────────────

def parse_ts(ts_str):
    """Convert Grin ISO timestamp string → Unix int."""
    # e.g. "2019-01-15T16:44:15.763877+00:00"
    try:
        ts_str = ts_str.split(".")[0]  # drop sub-seconds
        dt = datetime.strptime(ts_str, "%Y-%m-%dT%H:%M:%S")
        return int(dt.replace(tzinfo=timezone.utc).timestamp())
    except Exception:
        return int(time.time())

def now_ts():
    return int(time.time())

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
            bucket          TEXT NOT NULL DEFAULT 'recent'
        );
        CREATE INDEX IF NOT EXISTS idx_blocks_ts     ON blocks(timestamp);
        CREATE INDEX IF NOT EXISTS idx_blocks_bucket ON blocks(bucket);

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
    """)
    conn.commit()

def get_meta(conn, key, default=None):
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row[0] if row else default

def set_meta(conn, key, value):
    conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", (key, str(value)))
    conn.commit()

# ── Block fetching ────────────────────────────────────────────────────────────

def fetch_header(height):
    """Fetch a single block header. Returns (height, timestamp_int, total_diff) or None."""
    try:
        data = grin_rpc("get_header", {"height": height, "hash": None, "commit": None})
        if not data:
            return None
        return (
            int(data["height"]),
            parse_ts(data["timestamp"]),
            int(data["total_difficulty"]),
        )
    except Exception as exc:
        print(f"  [WARN] header {height}: {exc}", file=sys.stderr)
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
        data = grin_rpc("get_block", {"height": height, "hash": None, "commit": None})
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

# ── Hashrate calculation ──────────────────────────────────────────────────────

def calc_hashrate(rows):
    """
    Given list of (height, ts, total_diff) sorted by height,
    compute per-point hashrate (GPS) using the diff delta / time delta method.
    Returns list of (height, ts, total_diff, hashrate).
    """
    out = []
    for i, (h, ts, diff) in enumerate(rows):
        if i == 0:
            out.append((h, ts, diff, 0.0))
            continue
        ph, pts, pdiff = rows[i - 1]
        dt = ts - pts
        dd = diff - pdiff
        if dt > 0 and dd > 0:
            hr = dd / dt  # graphs per second (GPS)
        else:
            hr = out[-1][3] if out else 0.0
        out.append((h, ts, diff, hr))
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
    batch_size = 20
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
        "INSERT OR REPLACE INTO blocks(height,timestamp,total_diff,hashrate,bucket) VALUES(?,?,?,?,?)",
        [(h, ts, diff, hr, assign_bucket(ts)) for h, ts, diff, hr in rows_with_hr],
    )
    set_meta(conn, "last_height", tip_height)
    set_meta(conn, "last_updated", now_ts())
    conn.commit()
    conn.close()

    # Fetch full block stats for last 90 days
    print("[INFO] Fetching tx/fee stats for last 90 days...")
    _fetch_block_stats_range(tip_height - 90 * BLOCKS_PER_DAY, tip_height)

    # Update peers
    print("[INFO] Updating peer data...")
    _update_peers()

    # Export JSON
    print("[INFO] Exporting JSON files...")
    export_all_json()

    print(f"[OK] Initial history import complete. DB: {DB_PATH}")

# ── Incremental update ────────────────────────────────────────────────────────

def cmd_update():
    conn = open_db()
    init_schema(conn)

    last_height = int(get_meta(conn, "last_height", 0))
    conn.close()

    tip = grin_rpc("get_tip")
    if not tip:
        print("[ERROR] Cannot reach Grin node.", file=sys.stderr)
        sys.exit(1)

    tip_height = int(tip["height"])
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
            "INSERT OR REPLACE INTO blocks(height,timestamp,total_diff,hashrate,bucket) VALUES(?,?,?,?,?)",
            [(h, ts, diff, hr, assign_bucket(ts)) for h, ts, diff, hr in rows_with_hr],
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

        # Full block stats for new blocks only
        _fetch_block_stats_range(last_height + 1, tip_height)

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

def _fetch_block_stats_range(start, end, workers=4):
    heights = list(range(max(0, start), end + 1))
    if not heights:
        return
    conn = open_db()
    init_schema(conn)
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fetch_full_block, h): h for h in heights}
        batch = []
        for fut in as_completed(futures):
            row = fut.result()
            if row:
                batch.append(row)
            done += 1
            if done % 100 == 0:
                print(f"\r  Block stats: {done}/{len(heights)}", end="", flush=True)
        if batch:
            conn.executemany(
                "INSERT OR REPLACE INTO block_stats(height,timestamp,tx_count,fee_total,output_count) VALUES(?,?,?,?,?)",
                batch,
            )
            conn.commit()
    print()
    conn.close()

# ── Peer update ───────────────────────────────────────────────────────────────

def _fetch_all_peers_from_node(owner_url, secret, network_label):
    """
    Query the owner API get_peers (returns ALL known peers — connected, healthy,
    and recently seen). This gives 100-500+ peers vs 8-30 from get_connected_peers.
    Falls back to get_connected_peers on the foreign API if owner API fails.
    """
    peer_list = []

    # Try owner API first (all known peers, requires API secret)
    try:
        raw = _rpc(owner_url, "get_peers", {"peer_addr": None}, secret=secret)
        if raw:
            for p in raw:
                flags = p.get("flags", "")
                # Skip banned peers — they're not healthy network participants
                if "Banned" in str(flags):
                    continue
                addr = p.get("addr", "")
                ip   = addr.rsplit(":", 1)[0].strip("[]")
                port = addr.rsplit(":", 1)[-1] if ":" in addr else "3414"
                if ip and not ip.startswith("127.") and not ip.startswith("::1") \
                       and not ip.startswith("10.")  and not ip.startswith("192.168."):
                    peer_list.append({
                        "ip":         ip,
                        "port":       port,
                        "user_agent": p.get("user_agent", "unknown"),
                        "direction":  p.get("direction", "Outbound"),
                        "network":    network_label,
                    })
            print(f"[INFO] {network_label}: {len(peer_list)} known peers from owner API.")
            return peer_list
    except Exception as exc:
        print(f"[WARN] {network_label} owner API get_peers failed: {exc} — falling back.", file=sys.stderr)

    # Fallback: get_connected_peers on foreign API (direct connections only)
    foreign_url = owner_url.replace("/v2/owner", "/v2/foreign")
    try:
        raw = _rpc(foreign_url, "get_connected_peers", retries=2)
        if raw:
            for p in raw:
                addr = p.get("addr", "")
                ip   = addr.rsplit(":", 1)[0].strip("[]")
                port = addr.rsplit(":", 1)[-1] if ":" in addr else "3414"
                if ip and not ip.startswith("127.") and not ip.startswith("::1"):
                    peer_list.append({
                        "ip":         ip,
                        "port":       port,
                        "user_agent": p.get("user_agent", "unknown"),
                        "direction":  p.get("direction", "Outbound"),
                        "network":    network_label,
                    })
        print(f"[INFO] {network_label}: {len(peer_list)} connected peers (fallback).")
    except Exception as exc:
        print(f"[WARN] {network_label} fallback also failed: {exc}", file=sys.stderr)

    return peer_list

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

    all_peers = []

    # ── Mainnet ───────────────────────────────────────────────────────────────
    if _is_node_running(3413):
        mainnet_peers = _fetch_all_peers_from_node(
            MAINNET_OWNER_URL, API_SECRET, "mainnet"
        )
        all_peers.extend(mainnet_peers)
    else:
        print("[INFO] Mainnet node not running — skipping mainnet peers.")

    # ── Testnet ───────────────────────────────────────────────────────────────
    if _is_node_running(13413):
        testnet_peers = _fetch_all_peers_from_node(
            TESTNET_OWNER_URL, TESTNET_API_SECRET, "testnet"
        )
        all_peers.extend(testnet_peers)
    else:
        print("[INFO] Testnet node not running — skipping testnet peers.")

    if not all_peers:
        print("[WARN] No peers found from any node.", file=sys.stderr)
        _write_peers_json([])
        return

    # De-duplicate: same IP+network can appear multiple times
    seen  = set()
    dedup = []
    for p in all_peers:
        key = (p["ip"], p["network"])
        if key not in seen:
            seen.add(key)
            dedup.append(p)
    all_peers = dedup
    print(f"[INFO] Total unique peers: {len(all_peers)} ({len(seen)} after dedup)")

    # ── Geolocate in batches ──────────────────────────────────────────────────
    geo_map = {}
    unique_ips = list({p["ip"] for p in all_peers})
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
            time.sleep(1.5)  # stay under ip-api.com free tier (45 req/min)
        except Exception as exc:
            print(f"[WARN] Geo batch failed: {exc}", file=sys.stderr)

    # ── Build enriched peer list ──────────────────────────────────────────────
    enriched = []
    ts = now_ts()
    for p in all_peers:
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
            "network":      p["network"],    # "mainnet" | "testnet"
            "last_seen":    ts,
        })

    conn = open_db()

    # ── Upsert current peers into known_peers ─────────────────────────────────
    conn.executemany("""
        INSERT INTO known_peers
            (ip, network, port, user_agent, direction, lat, lng,
             country, country_code, city, first_seen, last_seen)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(ip, network) DO UPDATE SET
            port         = excluded.port,
            user_agent   = excluded.user_agent,
            direction    = excluded.direction,
            lat          = excluded.lat,
            lng          = excluded.lng,
            country      = excluded.country,
            country_code = excluded.country_code,
            city         = excluded.city,
            last_seen    = excluded.last_seen
    """, [
        (p["ip"], p["network"], p["port"], p["user_agent"], p["direction"],
         p["lat"], p["lng"], p["country"], p["country_code"], p["city"],
         ts, ts)
        for p in enriched
    ])

    # ── Prune peers not seen in PEER_RETENTION_DAYS ───────────────────────────
    cutoff = ts - PEER_RETENTION_DAYS * 86400
    deleted = conn.execute(
        "DELETE FROM known_peers WHERE last_seen < ?", (cutoff,)
    ).rowcount
    if deleted:
        print(f"[INFO] Pruned {deleted} stale peers (>{PEER_RETENTION_DAYS}d).")

    # ── Store version snapshot (mainnet only for stats charts) ────────────────
    mainnet_only = [p for p in all_peers if p["network"] == "mainnet"]
    version_counts = Counter(p["user_agent"] for p in mainnet_only)
    if version_counts:
        conn.executemany(
            "INSERT INTO peer_snapshots(sampled_at, user_agent, count) VALUES(?,?,?)",
            [(ts, ua, cnt) for ua, cnt in version_counts.items()],
        )
        conn.execute("DELETE FROM peer_snapshots WHERE sampled_at < ?", (ts - 365 * 86400,))

    conn.commit()

    # ── Read all peers seen within PEER_HISTORY_DAYS for the JSON ─────────────
    history_cutoff = ts - PEER_HISTORY_DAYS * 86400
    rows = conn.execute("""
        SELECT ip, network, port, user_agent, direction,
               lat, lng, country, country_code, city, first_seen, last_seen
        FROM known_peers
        WHERE last_seen >= ?
        ORDER BY last_seen DESC
    """, (history_cutoff,)).fetchall()
    conn.close()

    output_peers = [
        {
            "ip":           r[0],
            "network":      r[1],
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
          f"(including up to {PEER_HISTORY_DAYS}d history).")

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
    for metric, col in (("hashrate", "hashrate"), ("difficulty", "total_diff")):
        daily  = conn.execute(
            f"SELECT timestamp, {col} FROM blocks WHERE bucket='daily'  ORDER BY timestamp"
        ).fetchall()
        hourly = conn.execute(
            f"SELECT timestamp, {col} FROM blocks WHERE bucket='hourly' ORDER BY timestamp"
        ).fetchall()
        recent = conn.execute(
            f"SELECT timestamp, {col} FROM blocks WHERE bucket='recent' ORDER BY timestamp"
        ).fetchall()

        # Current stat from most recent block
        last = conn.execute(
            f"SELECT {col} FROM blocks ORDER BY height DESC LIMIT 1"
        ).fetchone()
        current_val = last[0] if last else 0

        _write_json(f"{metric}.json", {
            "updated":  ts_now,
            "current":  round(current_val, 2),
            "daily":    [[r[0], round(r[1], 2)] for r in daily],
            "hourly":   [[r[0], round(r[1], 2)] for r in hourly],
            "recent":   [[r[0], round(r[1], 2)] for r in recent],
        })

    # ── tip stats ─────────────────────────────────────────────────────────────
    tip_row = conn.execute(
        "SELECT height, timestamp, total_diff FROM blocks ORDER BY height DESC LIMIT 2"
    ).fetchall()
    tip_height    = tip_row[0][0] if tip_row else 0
    avg_blocktime = 0
    if len(tip_row) == 2:
        avg_blocktime = round((tip_row[0][1] - tip_row[1][1]), 1)

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
            f"SELECT (timestamp/{BLOCKS_PER_HOUR*60})*{BLOCKS_PER_HOUR*60} as bucket_ts, SUM({col}) "
            f"FROM block_stats WHERE timestamp >= ? AND timestamp < ? "
            f"GROUP BY bucket_ts ORDER BY bucket_ts",
            (cutoff_30d, cutoff_24h),
        ).fetchall()
        daily_raw = conn.execute(
            f"SELECT (timestamp/86400)*86400 as bucket_ts, SUM({col}) "
            f"FROM block_stats WHERE timestamp < ? "
            f"GROUP BY bucket_ts ORDER BY bucket_ts",
            (cutoff_30d,),
        ).fetchall()

        _write_json(f"{metric}.json", {
            "updated": ts_now,
            "daily":   [[r[0], r[1]] for r in daily_raw],
            "hourly":  [[r[0], r[1]] for r in hourly_raw],
            "recent":  [[r[0], r[1]] for r in recent],
        })

    # ── node versions ─────────────────────────────────────────────────────────
    # Most recent snapshot
    latest_snap_ts = conn.execute(
        "SELECT MAX(sampled_at) FROM peer_snapshots"
    ).fetchone()[0]

    versions = []
    if latest_snap_ts:
        rows = conn.execute(
            "SELECT user_agent, count FROM peer_snapshots WHERE sampled_at=? ORDER BY count DESC",
            (latest_snap_ts,),
        ).fetchall()
        total_peers = sum(r[1] for r in rows)
        # Consolidate minor versions: keep top 5, rest → "Other"
        top = rows[:5]
        other = sum(r[1] for r in rows[5:])
        versions = [{"label": r[0], "count": r[1]} for r in top]
        if other > 0:
            versions.append({"label": "Other", "count": other})

        _write_json("versions.json", {
            "updated":      ts_now,
            "sampled_from": total_peers if latest_snap_ts else 0,
            "versions":     versions,
        })

    # ── summary (for the header stats bar) ───────────────────────────────────
    last_hr   = conn.execute("SELECT hashrate FROM blocks ORDER BY height DESC LIMIT 1").fetchone()
    last_diff = conn.execute("SELECT total_diff FROM blocks ORDER BY height DESC LIMIT 1").fetchone()
    _write_json("summary.json", {
        "updated":        ts_now,
        "tip_height":     tip_height,
        "avg_block_time": avg_blocktime,
        "current_hashrate":   round(last_hr[0], 2)   if last_hr   else 0,
        "current_difficulty": last_diff[0]             if last_diff else 0,
    })

    conn.close()
    print("[OK] JSON exported to:", WWW_DATA)

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
    group.add_argument("--init-db",      action="store_true", help="Create DB schema only")
    group.add_argument("--init-history", action="store_true", help="Backfill all historical data")
    group.add_argument("--update",       action="store_true", help="Fetch new blocks + update peers")
    group.add_argument("--peers-only",   action="store_true", help="Update peer data only")
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
    else:
        # Default: --update
        cmd_update()

if __name__ == "__main__":
    main()
