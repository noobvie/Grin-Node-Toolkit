#!/usr/bin/env python3
"""
06_price_collector.py — Grin Price Collector
=============================================
Collects GRIN/USDT (Gate.io) and GRIN/BTC (nonlogs.io) prices,
stores in a local SQLite DB, and exports JSON for the stats page.

📊 STORAGE ESTIMATES
════════════════════
  snapshots table: ~70 bytes/row × 12/hour × 8760 h/year × 2 pairs  ≈ 15 MB/year
    (pruned to 7 days — snapshots are the raw input for BTC OHLCV aggregation)
  ohlcv table: tiny — at most a few thousand rows per pair per interval
    GRIN/USDT: backfilled from Gate.io (1d since Jan 2019)
    GRIN/BTC:  aggregated from snapshots (builds over time, no history API)
  TOTAL: typically < 20 MB

Usage:
    python3 06_price_collector.py --init-db        Create DB schema only
    python3 06_price_collector.py --init-history   Backfill Gate.io GRIN/USDT history
    python3 06_price_collector.py --update         Fetch current prices + export JSON (default)
    python3 06_price_collector.py --export         Re-export JSON only, no fetch

Config (env vars or /opt/grin/grin-price/config.env):
    PRICE_WWW_DATA   Path to write price.json  (default: /var/www/grin-stats/data)
    PRICE_DB_PATH    Path to SQLite database   (default: /opt/grin/grin-price/grin-price.db)

Cron (add via script 06 or crontab -e):
    */5 * * * *  python3 /usr/local/bin/grin-price-collector --update >> /opt/grin/logs/price.log 2>&1
"""

import argparse
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone

# ── Config ────────────────────────────────────────────────────────────────────

_CONFIG_ENV = "/opt/grin/grin-price/config.env"
if os.path.isfile(_CONFIG_ENV):
    with open(_CONFIG_ENV) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _, _v = _line.partition("=")
                os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))

WWW_DATA = os.environ.get("PRICE_WWW_DATA", "/var/www/grin-stats/data")
DB_PATH  = os.environ.get("PRICE_DB_PATH",  "/opt/grin/grin-price/grin-price.db")

# ── Exchange endpoints ────────────────────────────────────────────────────────

GATE_TICKER_URL  = "https://api.gateio.ws/api/v4/spot/tickers?currency_pair=GRIN_USDT"
GATE_CANDLES_URL = "https://api.gateio.ws/api/v4/spot/candlesticks"
NONLOGS_URL      = "https://api.nonlogs.io/api/markets/GRIN-BTC"

# Gate.io candlestick array layout:
#   [0] ts (str)   [1] quote_vol  [2] close  [3] high  [4] low  [5] open  [6] base_vol  [7] is_complete

# Grin genesis / Gate.io listing start point for backfill
GRIN_LISTING_TS = 1547510400  # 2019-01-15 00:00 UTC

# ── Helpers ───────────────────────────────────────────────────────────────────

def now_ts():
    return int(time.time())

def _http_get(url, retries=3, timeout=15):
    """GET a JSON URL with basic retry logic."""
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "Accept":     "application/json",
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            })
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read())
        except (urllib.error.URLError, OSError) as exc:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)
    return None

def _write_json(filename, data):
    """Atomic write to WWW_DATA directory (same pattern as 06_collector.py)."""
    os.makedirs(WWW_DATA, exist_ok=True)
    path = os.path.join(WWW_DATA, filename)
    tmp  = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    os.replace(tmp, path)

# ── Database ──────────────────────────────────────────────────────────────────

def open_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn

def init_schema(conn):
    conn.executescript("""
        -- Raw snapshots every 5 min from both exchange APIs.
        -- Pruned to 7 days (the raw data is aggregated into ohlcv; candles live on).
        CREATE TABLE IF NOT EXISTS snapshots (
            ts           INTEGER NOT NULL,
            pair         TEXT    NOT NULL,
            last_price   REAL    NOT NULL,
            high_24h     REAL,
            low_24h      REAL,
            base_volume  REAL,
            quote_volume REAL,
            bid          REAL,
            ask          REAL,
            change_pct   REAL,
            source       TEXT,
            PRIMARY KEY (ts, pair)
        );
        CREATE INDEX IF NOT EXISTS idx_snap_pair ON snapshots (pair, ts DESC);

        -- OHLCV candles.
        -- GRIN_USDT: populated by Gate.io backfill + incremental fetch.
        -- GRIN_BTC:  aggregated from snapshots (builds over time).
        CREATE TABLE IF NOT EXISTS ohlcv (
            ts       INTEGER NOT NULL,
            pair     TEXT    NOT NULL,
            interval TEXT    NOT NULL,   -- '5m' | '1h' | '6h' | '1d'
            open     REAL    NOT NULL,
            high     REAL    NOT NULL,
            low      REAL    NOT NULL,
            close    REAL    NOT NULL,
            volume   REAL,               -- base volume in GRIN
            PRIMARY KEY (ts, pair, interval)
        );
        CREATE INDEX IF NOT EXISTS idx_ohlcv_lookup ON ohlcv (pair, interval, ts DESC);

        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT
        );
    """)
    conn.commit()

def get_meta(conn, key, default=None):
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row[0] if row else default

def set_meta(conn, key, value):
    conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", (key, str(value)))
    conn.commit()

# ── Fetch: current tickers ────────────────────────────────────────────────────

def fetch_gate_ticker():
    """Fetch current GRIN/USDT ticker from Gate.io. Returns dict or None."""
    try:
        data = _http_get(GATE_TICKER_URL)
        if not data or not isinstance(data, list):
            return None
        t = data[0]
        return {
            "pair":         "GRIN_USDT",
            "last_price":   float(t["last"]),
            "high_24h":     float(t["high_24h"])  if t.get("high_24h")  else None,
            "low_24h":      float(t["low_24h"])   if t.get("low_24h")   else None,
            "base_volume":  float(t.get("base_volume",  0)),
            "quote_volume": float(t.get("quote_volume", 0)),
            "bid":          float(t["highest_bid"]) if t.get("highest_bid") else None,
            "ask":          float(t["lowest_ask"])  if t.get("lowest_ask")  else None,
            "change_pct":   float(t.get("change_percentage", 0)),
            "source":       "gate.io",
        }
    except Exception as exc:
        print(f"[WARN] Gate.io ticker: {exc}", file=sys.stderr)
        return None

def fetch_nonlogs_ticker():
    """Fetch current GRIN/BTC ticker from nonlogs.io. Returns dict or None."""
    try:
        data = _http_get(NONLOGS_URL)
        if not data or "market" not in data:
            return None
        m = data["market"]
        return {
            "pair":         "GRIN_BTC",
            "last_price":   float(m["last_price"]),
            "high_24h":     float(m["high_24h"])       if m.get("high_24h")       else None,
            "low_24h":      float(m["low_24h"])        if m.get("low_24h")        else None,
            "base_volume":  float(m.get("base_volume",  0)),
            "quote_volume": float(m.get("quote_volume", 0)),
            "bid":          float(m["highest_bid"])    if m.get("highest_bid")    else None,
            "ask":          float(m["lowest_ask"])     if m.get("lowest_ask")     else None,
            "change_pct":   float(m.get("percent_change", 0)),
            "source":       "nonlogs.io",
        }
    except Exception as exc:
        print(f"[WARN] nonlogs.io ticker ({NONLOGS_URL}): {exc}", file=sys.stderr)
        return None

# ── Fetch: Gate.io OHLCV candles ─────────────────────────────────────────────

def fetch_gate_candles(interval, from_ts=None, to_ts=None, limit=1000):
    """
    Fetch GRIN/USDT OHLCV from Gate.io.
    Returns list of (ts, open, high, low, close, volume) tuples — complete candles only.
    """
    params = f"currency_pair=GRIN_USDT&interval={interval}&limit={limit}"
    if from_ts:
        params += f"&from={from_ts}"
    if to_ts:
        params += f"&to={to_ts}"
    url = f"{GATE_CANDLES_URL}?{params}"
    try:
        rows = _http_get(url)
        if not rows or not isinstance(rows, list):
            return []
        result = []
        for r in rows:
            # Skip the current incomplete candle (last entry when is_complete=false)
            if len(r) > 7 and str(r[7]).lower() != "true":
                continue
            result.append((
                int(r[0]),     # ts
                float(r[5]),   # open
                float(r[3]),   # high
                float(r[4]),   # low
                float(r[2]),   # close
                float(r[6]),   # base volume (GRIN)
            ))
        return result
    except Exception as exc:
        print(f"[WARN] Gate.io candles ({interval}): {exc}", file=sys.stderr)
        return []

# ── Aggregate BTC snapshots → OHLCV ──────────────────────────────────────────

_INTERVAL_SECS = {"5m": 300, "1h": 3600, "6h": 21600, "1d": 86400, "7d": 7 * 86400}

def aggregate_snapshots(conn, pair, interval):
    """
    Aggregate raw snapshots for a pair into OHLCV candles.
    Returns list of (ts, open, high, low, close, volume) tuples.
    """
    bucket_secs = _INTERVAL_SECS[interval]
    rows = conn.execute(
        "SELECT ts, last_price, base_volume FROM snapshots WHERE pair=? ORDER BY ts",
        (pair,)
    ).fetchall()
    if not rows:
        return []

    buckets = defaultdict(list)
    for ts, price, vol in rows:
        buckets[(ts // bucket_secs) * bucket_secs].append((ts, price, vol or 0.0))

    result = []
    for bucket_ts in sorted(buckets):
        pts    = sorted(buckets[bucket_ts])
        prices = [p for _, p, _ in pts]
        vols   = [v for _, _, v in pts]
        result.append((
            bucket_ts,
            prices[0],            # open
            max(prices),          # high
            min(prices),          # low
            prices[-1],           # close
            sum(vols),            # sum of volumes captured in this bucket
        ))
    return result

# ── DB writes ─────────────────────────────────────────────────────────────────

def store_snapshot(conn, ts, ticker):
    conn.execute(
        """INSERT OR REPLACE INTO snapshots
           (ts, pair, last_price, high_24h, low_24h, base_volume, quote_volume,
            bid, ask, change_pct, source)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (ts, ticker["pair"], ticker["last_price"],
         ticker.get("high_24h"), ticker.get("low_24h"),
         ticker.get("base_volume"), ticker.get("quote_volume"),
         ticker.get("bid"), ticker.get("ask"),
         ticker.get("change_pct"), ticker.get("source")),
    )

def upsert_ohlcv(conn, pair, interval, rows):
    """Insert or replace OHLCV rows. Returns count stored."""
    if not rows:
        return 0
    conn.executemany(
        """INSERT OR REPLACE INTO ohlcv
           (ts, pair, interval, open, high, low, close, volume)
           VALUES (?,?,?,?,?,?,?,?)""",
        [(ts, pair, interval, o, h, l, c, v) for ts, o, h, l, c, v in rows],
    )
    return len(rows)

# ── JSON export ───────────────────────────────────────────────────────────────

# Maps frontend timeframe key → (db interval, seconds back; None = all history)
_TF = {
    "day":   ("5m",  86400),
    "week":  ("1h",  7 * 86400),
    "month": ("6h",  30 * 86400),
    "year":  ("6h",  365 * 86400),
    "all":   ("7d",  None),
}

def _ohlcv_for_export(conn, pair, interval, since):
    """Return [[ts, close, volume], ...] for chart data."""
    if since is None:
        rows = conn.execute(
            "SELECT ts, close, volume FROM ohlcv WHERE pair=? AND interval=? ORDER BY ts",
            (pair, interval),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT ts, close, volume FROM ohlcv WHERE pair=? AND interval=? AND ts>=? ORDER BY ts",
            (pair, interval, since),
        ).fetchall()
    return [[r[0], r[1], r[2] or 0] for r in rows]

def export_price_json():
    conn  = open_db()
    ts_now = now_ts()
    out   = {"updated": ts_now}

    for pair, source_label in (("GRIN_USDT", "gate.io"), ("GRIN_BTC", "nonlogs.io")):
        snap = conn.execute(
            """SELECT last_price, high_24h, low_24h, base_volume,
                      bid, ask, change_pct
               FROM snapshots WHERE pair=? ORDER BY ts DESC LIMIT 1""",
            (pair,),
        ).fetchone()

        oldest_ohlcv = conn.execute(
            "SELECT MIN(ts) FROM ohlcv WHERE pair=? AND interval='1d'", (pair,)
        ).fetchone()[0]
        oldest_snap = conn.execute(
            "SELECT MIN(ts) FROM snapshots WHERE pair=?", (pair,)
        ).fetchone()[0]
        data_since = min(
            oldest_ohlcv if oldest_ohlcv else ts_now,
            oldest_snap  if oldest_snap  else ts_now,
        )

        entry = {
            "source":     source_label,
            "data_since": data_since,
            "last":       snap[0] if snap else None,
            "high_24h":   snap[1] if snap else None,
            "low_24h":    snap[2] if snap else None,
            "volume_24h": snap[3] if snap else None,
            "bid":        snap[4] if snap else None,
            "ask":        snap[5] if snap else None,
            "change_pct": snap[6] if snap else None,
        }

        for tf, (interval, secs_back) in _TF.items():
            since = (ts_now - secs_back) if secs_back else None
            entry[f"ohlcv_{tf}"] = _ohlcv_for_export(conn, pair, interval, since)

        out[pair] = entry

    conn.close()

    usdt_all = len(out.get("GRIN_USDT", {}).get("ohlcv_all", []))
    btc_all  = len(out.get("GRIN_BTC",  {}).get("ohlcv_all", []))
    _write_json("price.json", out)
    print(f"[OK] price.json → USDT: {usdt_all} all-time candles | BTC: {btc_all} all-time candles")

# ── Commands ──────────────────────────────────────────────────────────────────

def cmd_init_db():
    conn = open_db()
    init_schema(conn)
    conn.close()
    print(f"[OK] Database initialised: {DB_PATH}")

def cmd_init_history():
    """
    Backfill full GRIN/USDT history from Gate.io.
    GRIN/BTC has no public history API — it builds organically from --update runs.
    """
    conn = open_db()
    init_schema(conn)

    pair = "GRIN_USDT"
    print(f"[INFO] Backfilling {pair} from Gate.io (Grin listing Jan 2019 → now)...")

    # ── Daily candles: full history ───────────────────────────────────────────
    all_daily = []
    from_ts   = GRIN_LISTING_TS
    page      = 1
    while True:
        batch = fetch_gate_candles("1d", from_ts=from_ts, limit=1000)
        if not batch:
            break
        all_daily.extend(batch)
        last_ts = batch[-1][0]
        last_dt = datetime.fromtimestamp(last_ts, timezone.utc).strftime("%Y-%m-%d")
        print(f"  Page {page}: {len(batch)} candles up to {last_dt}")
        if last_ts >= now_ts() - 86400:
            break  # caught up to today
        from_ts = last_ts + 86400
        page   += 1
        time.sleep(0.5)

    if all_daily:
        n = upsert_ohlcv(conn, pair, "1d", all_daily)
        conn.commit()
        print(f"[OK] Stored {n} daily candles for {pair}")
    else:
        print("[WARN] No daily candles returned — check Gate.io availability", file=sys.stderr)

    # ── 7d candles: full history (~374 weeks — one page) ─────────────────────
    print("[INFO] Fetching 7d (weekly) candles (full history)...")
    rows = fetch_gate_candles("7d", from_ts=GRIN_LISTING_TS, limit=1000)
    if rows:
        n = upsert_ohlcv(conn, pair, "7d", rows)
        conn.commit()
        print(f"[OK] Stored {n} weekly candles")

    # ── 6h candles: last 365 days (paginated — 1460 candles, 2 pages) ──────────
    print("[INFO] Fetching 6h candles (last 365 days)...")
    all_6h   = []
    from_6h  = now_ts() - 365 * 86400
    while True:
        batch = fetch_gate_candles("6h", from_ts=from_6h, limit=1000)
        if not batch:
            break
        all_6h.extend(batch)
        if len(batch) < 1000:
            break
        from_6h = batch[-1][0] + 6 * 3600
        time.sleep(0.3)
    if all_6h:
        n = upsert_ohlcv(conn, pair, "6h", all_6h)
        conn.commit()
        print(f"[OK] Stored {n} 6h candles (last 365 days)")

    # ── 1h candles: last 30 days ──────────────────────────────────────────────
    print("[INFO] Fetching 1h candles (last 30 days)...")
    rows = fetch_gate_candles("1h", from_ts=now_ts() - 30 * 86400, limit=1000)
    if rows:
        n = upsert_ohlcv(conn, pair, "1h", rows)
        conn.commit()
        print(f"[OK] Stored {n} 1h candles")

    # ── 5m candles: last 24h ──────────────────────────────────────────────────
    print("[INFO] Fetching 5m candles (last 24h)...")
    rows = fetch_gate_candles("5m", from_ts=now_ts() - 86400, limit=288)
    if rows:
        n = upsert_ohlcv(conn, pair, "5m", rows)
        conn.commit()
        print(f"[OK] Stored {n} 5m candles")

    conn.close()
    export_price_json()
    print("[OK] History import complete.")
    print(f"[INFO] GRIN/BTC history will build automatically as --update runs every 5 min.")

def cmd_update():
    """Fetch current prices, update candles, aggregate BTC OHLCV, export JSON."""
    conn = open_db()
    init_schema(conn)
    ts = now_ts()

    # ── 1. Fetch current tickers ──────────────────────────────────────────────
    usdt = fetch_gate_ticker()
    btc  = fetch_nonlogs_ticker()

    if usdt:
        store_snapshot(conn, ts, usdt)
        print(f"[INFO] GRIN/USDT  ${usdt['last_price']:.5f}  "
              f"vol={usdt['base_volume']:.0f} GRIN  ({usdt['change_pct']:+.2f}%)")
    else:
        print("[WARN] GRIN/USDT fetch failed", file=sys.stderr)

    if btc:
        store_snapshot(conn, ts, btc)
        sats = round(btc["last_price"] * 1e8)
        print(f"[INFO] GRIN/BTC   {sats} sat  "
              f"vol={btc['base_volume']:.0f} GRIN  ({btc['change_pct']:+.2f}%)")
    else:
        print("[WARN] GRIN/BTC fetch failed", file=sys.stderr)

    conn.commit()

    # ── 2. Incremental Gate.io candles for GRIN_USDT ─────────────────────────
    if usdt:
        for itvl, window in (("5m", 2 * 86400), ("1h", 7 * 86400),
                              ("6h", 90 * 86400), ("1d", 7 * 86400),
                              ("7d", 90 * 86400)):
            last_ts = conn.execute(
                "SELECT MAX(ts) FROM ohlcv WHERE pair='GRIN_USDT' AND interval=?", (itvl,)
            ).fetchone()[0] or 0
            from_ts = max(last_ts, ts - window)
            rows = fetch_gate_candles(itvl, from_ts=from_ts)
            if rows:
                n = upsert_ohlcv(conn, "GRIN_USDT", itvl, rows)
                if n:
                    print(f"[INFO] GRIN_USDT {itvl}: +{n} candles")

        # Keep only 48h of 5m candles (288 per day) — they're re-fetched fresh each day
        conn.execute(
            "DELETE FROM ohlcv WHERE pair='GRIN_USDT' AND interval='5m' AND ts<?",
            (ts - 48 * 3600,),
        )

    # ── 3. Aggregate BTC snapshots → OHLCV ───────────────────────────────────
    # Only delete/replace candles inside the current snapshot window (last 7d).
    # Candles older than the oldest snapshot are preserved so BTC OHLCV accumulates
    # history over time as the snapshot window rolls forward.
    oldest_snap_ts = conn.execute(
        "SELECT MIN(ts) FROM snapshots WHERE pair='GRIN_BTC'"
    ).fetchone()[0]
    for itvl in ("5m", "1h", "6h", "1d", "7d"):
        rows = aggregate_snapshots(conn, "GRIN_BTC", itvl)
        if rows and oldest_snap_ts:
            conn.execute(
                "DELETE FROM ohlcv WHERE pair='GRIN_BTC' AND interval=? AND ts>=?",
                (itvl, oldest_snap_ts),
            )
            n = upsert_ohlcv(conn, "GRIN_BTC", itvl, rows)
            print(f"[INFO] GRIN_BTC  {itvl}: {n} candles (aggregated)")

    # ── 4. Prune snapshots older than 7 days ─────────────────────────────────
    # Only prune when at least one fetch succeeded — if both APIs are down,
    # keep all snapshots so BTC OHLCV aggregation can still run next cycle.
    if usdt or btc:
        deleted = conn.execute(
            "DELETE FROM snapshots WHERE ts<?", (ts - 7 * 86400,)
        ).rowcount
        if deleted:
            print(f"[INFO] Pruned {deleted} old snapshots (>7d)")
    else:
        print("[WARN] Both fetches failed — skipping snapshot prune to preserve BTC OHLCV source data.",
              file=sys.stderr)

    conn.commit()
    conn.close()
    export_price_json()
    print("[OK] Update complete.")

# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Grin Price Collector")
    group  = parser.add_mutually_exclusive_group()
    group.add_argument("--init-db",      action="store_true",
                       help="Create DB schema only")
    group.add_argument("--init-history", action="store_true",
                       help="Backfill Gate.io GRIN/USDT history (run once)")
    group.add_argument("--update",       action="store_true",
                       help="Fetch current prices + export JSON (default)")
    group.add_argument("--export",       action="store_true",
                       help="Re-export JSON from existing DB, no fetch")
    args = parser.parse_args()

    if args.init_db:
        conn = open_db()
        init_schema(conn)
        conn.close()
        print(f"[OK] Database initialised: {DB_PATH}")
    elif args.init_history:
        cmd_init_history()
    elif args.export:
        export_price_json()
    else:
        cmd_update()

if __name__ == "__main__":
    main()
