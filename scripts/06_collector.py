#!/usr/bin/env python3
"""
grin-stats-collector
====================
Collects Grin network stats from a local node and exports JSON for Chart.js + Leaflet.

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

# Foreign API (mainnet) — block headers, tip, tx stats.  No auth required.
NODE_URL = os.environ.get("GRIN_NODE_URL", "http://127.0.0.1:3413/v2/foreign")
WWW_DATA = os.environ.get("GRIN_WWW_DATA", "/var/www/grin-stats/data")
DB_PATH  = os.environ.get("GRIN_DB_PATH",  "/var/lib/grin-stats/stats.db")

# Owner APIs — get_connected_peers / get_peers require Basic Auth.
# The secret is in ~/.grin/main/.api_secret (mainnet) and ~/.grin/test/.api_secret (testnet).
# Both paths are written to config.env by the install script.
MAINNET_OWNER_URL   = os.environ.get("GRIN_MAINNET_OWNER_URL",  "http://127.0.0.1:3413/v2/owner")
MAINNET_SECRET_PATH = os.environ.get("GRIN_API_SECRET_PATH",    "~/.grin/main/.api_secret")  # ~/.grin/main/.api_secret
TESTNET_OWNER_URL   = os.environ.get("GRIN_TESTNET_OWNER_URL",  "http://127.0.0.1:13413/v2/owner")
TESTNET_SECRET_PATH = os.environ.get("GRIN_TESTNET_SECRET_PATH", "")  # ~/.grin/test/.api_secret

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

# Standard Grin P2P ports — only accept peers advertising these ports.
# get_peers returns ALL gossip-discovered IPs; non-standard ports are not Grin nodes.
MAINNET_P2P_PORT = "3414"
TESTNET_P2P_PORT = "13414"

# ── API secret ────────────────────────────────────────────────────────────────

def _load_secret(path):
    if path and os.path.isfile(path):
        with open(path) as f:
            return f.read().strip()
    return ""

API_SECRET         = _load_secret(MAINNET_SECRET_PATH)
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
    """Foreign API call — block headers, tip, tx data.  No auth required."""
    return _rpc(NODE_URL, method, params, secret="", retries=retries)

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
        data = grin_rpc("get_header", [height, None, None], retries=5)
        if not data or "height" not in data:
            print(f"  [WARN] Empty or invalid response for height {height}", file=sys.stderr)
            return None
        return (
            int(data["height"]),
            parse_ts(data.get("timestamp", "")),
            int(data.get("total_difficulty", 0)),
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
        data = grin_rpc("get_block", [height, None, None], retries=5)
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
    compute per-point hashrate (GPS) using the Cuckatoo32 formula from aglkm/grin-explorer:
        hashrate_GPS = net_diff * 42 / block_time_seconds / 16384
    where:
        net_diff    = total_diff delta between consecutive sampled rows
        42          = Cuckoo cycle length for Cuckatoo32
        16384       = C32 solution rate = 32 × 2^(32-23) = 32 × 512
        block_time  = actual seconds between the two sampled blocks
    Returns list of (height, ts, total_diff, hashrate).
    """
    # Cuckatoo32 constants (matches aglkm/grin-explorer formula)
    CUCKOO_CYCLE  = 42.0
    C32_RATE      = 16384.0   # 32 × 2^9

    out = []
    for i, (h, ts, diff) in enumerate(rows):
        if i == 0:
            out.append((h, ts, diff, 0.0))
            continue
        ph, pts, pdiff = rows[i - 1]
        dt = ts - pts
        dd = diff - pdiff
        if dt > 0 and dd > 0:
            hr = dd * CUCKOO_CYCLE / dt / C32_RATE   # GPS (graphs per second)
        else:
            # Invalid data: same or earlier timestamp, or difficulty decreased
            # Do NOT copy previous hashrate (prevents propagation of anomalies)
            hr = 0.0
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
    batch_size = 100
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

    # Fetch full block stats for last 180 days
    print("[INFO] Fetching tx/fee stats for last 180 days...")
    _fetch_block_stats_range(tip_height - 180 * BLOCKS_PER_DAY, tip_height)

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

def _fetch_block_stats_range(start, end, workers=4, heights=None):
    if heights is None:
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

def cmd_backfill_stats(days=180):
    """Fetch full block stats for the last N days, skipping already-stored heights."""
    print(f"[INFO] Backfilling block stats for last {days} days...")
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
    start = max(0, tip_height - days * BLOCKS_PER_DAY)
    existing = {r[0] for r in conn.execute(
        "SELECT height FROM block_stats WHERE height BETWEEN ? AND ?", (start, tip_height)
    ).fetchall()}
    conn.close()

    heights = [h for h in range(start, tip_height + 1) if h not in existing]
    print(f"[INFO] Range {start:,} → {tip_height:,}  "
          f"({len(heights):,} to fetch, {len(existing):,} already present)")
    if heights:
        _fetch_block_stats_range(start, tip_height, heights=heights)
    export_all_json()
    print("[OK] Backfill complete.")

# ── Peer update ───────────────────────────────────────────────────────────────

def _is_public_ip(ip):
    """Return True if ip is a routable public address (not loopback/RFC-1918)."""
    return (ip
            and not ip.startswith("127.")
            and not ip.startswith("::1")
            and not ip.startswith("10.")
            and not ip.startswith("192.168."))

def _is_valid_grin_agent(ua):
    """Return True only for known Grin node implementations.
    Rejects blank/unknown agents that flood the routing table from non-Grin software."""
    if not ua:
        return False
    ua_lower = ua.lower()
    return "mw/grin" in ua_lower or "grin++" in ua_lower


def _extract_addr(peer, default_port):
    """Split a Grin peer dict's addr field into (ip, port)."""
    addr = peer.get("addr", "")
    ip   = addr.rsplit(":", 1)[0].strip("[]")
    port = addr.rsplit(":", 1)[-1] if ":" in addr else default_port
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
    """
    expected_port = MAINNET_P2P_PORT if network_label == "mainnet" else TESTNET_P2P_PORT
    peer_list = []
    try:
        raw = _rpc(owner_url, "get_connected_peers", secret=secret, retries=2)
        if raw:
            for p in raw:
                ip, port = _extract_addr(p, expected_port)
                if port != expected_port or not _is_public_ip(ip):
                    continue
                peer_list.append({
                    "ip":         ip,
                    "port":       port,
                    "user_agent": p.get("user_agent", "unknown"),
                    "direction":  p.get("direction", "Outbound"),
                    "network":    network_label,
                })
        print(f"[INFO] {network_label}: {len(peer_list)} currently connected peers (port {expected_port}).")
    except Exception as exc:
        print(f"[WARN] {network_label} get_connected_peers failed: {exc}", file=sys.stderr)
    return peer_list


def _fetch_all_peers_from_node(owner_url, secret, network_label):
    """
    Query the owner API get_peers filtered to Healthy flag only.
    Returns a larger set than get_connected_peers — used for version stats AND
    as a secondary map source (routing-table peers seen within PEER_HISTORY_DAYS).
    Standard P2P port filter applied to exclude gossip-only routing-table noise.
    """
    expected_port = MAINNET_P2P_PORT if network_label == "mainnet" else TESTNET_P2P_PORT
    peer_list = []
    try:
        raw = _rpc(owner_url, "get_peers", {"peer_addr": None}, secret=secret)
        if raw:
            skipped_port  = 0
            skipped_flag  = 0
            skipped_agent = 0
            for p in raw:
                flags = str(p.get("flags", ""))
                # Only accept peers the node considers Healthy (successfully handshaked)
                if "Healthy" not in flags:
                    skipped_flag += 1
                    continue
                ip, port = _extract_addr(p, expected_port)
                if port != expected_port:
                    skipped_port += 1
                    continue
                if not _is_public_ip(ip):
                    continue
                # Only accept known Grin node implementations (MW/Grin or Grin++)
                ua = p.get("user_agent", "")
                if not _is_valid_grin_agent(ua):
                    skipped_agent += 1
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
            print(f"[INFO] {network_label}: {len(peer_list)} healthy peers for stats "
                  f"(skipped {skipped_flag} non-Healthy, {skipped_port} wrong-port, "
                  f"{skipped_agent} unknown-agent).")
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
    # Remove any existing entries without a valid Grin agent (legacy contamination)
    purged = conn.execute(
        "DELETE FROM known_peers "
        "WHERE user_agent NOT LIKE '%MW/Grin%' AND user_agent NOT LIKE '%Grin++%'"
    ).rowcount
    if purged:
        print(f"[INFO] Purged {purged} peers with unknown agent names.")

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
          AND (user_agent LIKE '%MW/Grin%' OR user_agent LIKE '%Grin++%')
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

    hr_daily  = conn.execute(
        "SELECT timestamp, hashrate FROM blocks WHERE bucket='daily'  AND hashrate > 0 ORDER BY timestamp"
    ).fetchall()
    hr_hourly = conn.execute(
        "SELECT timestamp, hashrate FROM blocks WHERE bucket='hourly' AND hashrate > 0 ORDER BY timestamp"
    ).fetchall()
    hr_recent = conn.execute(
        "SELECT timestamp, hashrate FROM blocks WHERE bucket='recent' AND hashrate > 0 ORDER BY timestamp"
    ).fetchall()

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
            f"SELECT (timestamp/{BLOCKS_PER_HOUR*60})*{BLOCKS_PER_HOUR*60} as bucket_ts, SUM({col})*1.0/COUNT(*) "
            f"FROM block_stats WHERE timestamp >= ? AND timestamp < ? "
            f"GROUP BY bucket_ts ORDER BY bucket_ts",
            (cutoff_30d, cutoff_24h),
        ).fetchall()
        daily_raw = conn.execute(
            f"SELECT (timestamp/86400)*86400 as bucket_ts, SUM({col})*1.0/COUNT(*) "
            f"FROM block_stats WHERE timestamp < ? "
            f"GROUP BY bucket_ts ORDER BY bucket_ts",
            (cutoff_30d,),
        ).fetchall()

        _write_json(f"{metric}.json", {
            "updated": ts_now,
            "daily":   [[r[0], round(r[1], 4) if r[1] is not None else 0] for r in daily_raw],
            "hourly":  [[r[0], round(r[1], 4) if r[1] is not None else 0] for r in hourly_raw],
            "recent":  [[r[0], r[1]] for r in recent],
        })

    # ── node versions ─────────────────────────────────────────────────────────
    # Use all unique peers seen in the last PEER_HISTORY_DAYS for a broader sample.
    # This captures every peer we've connected to recently, not just one run's snapshot.
    version_cutoff = ts_now - PEER_HISTORY_DAYS * 86400
    ver_rows = conn.execute(
        "SELECT user_agent, COUNT(*) as cnt FROM known_peers "
        "WHERE last_seen >= ? AND network='mainnet' AND user_agent != '' AND user_agent != 'unknown' "
        "GROUP BY user_agent ORDER BY cnt DESC",
        (version_cutoff,),
    ).fetchall()

    versions    = []
    total_peers = 0
    if ver_rows:
        total_peers = sum(r[1] for r in ver_rows)
        top   = ver_rows[:5]
        other = sum(r[1] for r in ver_rows[5:])
        versions = [{"label": r[0], "count": r[1]} for r in top]
        if other > 0:
            versions.append({"label": "Other", "count": other})
    else:
        # Fall back to latest peer_snapshots if known_peers has no data yet
        latest_snap_ts = conn.execute(
            "SELECT MAX(sampled_at) FROM peer_snapshots"
        ).fetchone()[0]
        if latest_snap_ts:
            rows = conn.execute(
                "SELECT user_agent, count FROM peer_snapshots WHERE sampled_at=? ORDER BY count DESC",
                (latest_snap_ts,),
            ).fetchall()
            total_peers = sum(r[1] for r in rows)
            top   = rows[:5]
            other = sum(r[1] for r in rows[5:])
            versions = [{"label": r[0], "count": r[1]} for r in top]
            if other > 0:
                versions.append({"label": "Other", "count": other})

    # Always write versions.json so the page can load even with no snapshot data
    _write_json("versions.json", {
        "updated":      ts_now,
        "sampled_from": total_peers,
        "versions":     versions,
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
    group.add_argument("--init-db",        action="store_true", help="Create DB schema only")
    group.add_argument("--init-history",   action="store_true", help="Backfill all historical data")
    group.add_argument("--update",         action="store_true", help="Fetch new blocks + update peers")
    group.add_argument("--peers-only",     action="store_true", help="Update peer data only")
    group.add_argument("--backfill-stats", nargs="?", const=180, type=int, metavar="DAYS",
                       help="Fetch TX/fee stats for last N days (default 180), skipping existing")
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
    elif args.backfill_stats is not None:
        cmd_backfill_stats(args.backfill_stats)
    else:
        # Default: --update
        cmd_update()

if __name__ == "__main__":
    main()
