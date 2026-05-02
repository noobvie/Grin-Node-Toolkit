#!/usr/bin/env python3
"""
grin-ecosystem-checker
======================
Checks Grin DNS seeds (TCP) and ecosystem service URLs (HTTP).
Tracks per-IP uptime and per-domain WHOIS expiry in SQLite.
Writes ecosystem.json for the ecosystem.html status page.

Usage:
    python3 06_ecosystem_checker.py --update    TCP + HTTP checks + stale WHOIS refresh  [default]
    python3 06_ecosystem_checker.py --init-db   Create DB tables only
    python3 06_ecosystem_checker.py --whois     Force WHOIS refresh for all seed domains

Config (env vars — loaded from config.env by cron):
    GRIN_WWW_DATA   default: /var/www/grin-stats/data
    GRIN_DB_PATH    default: /opt/grin/grin-stats/stats.db
"""

import argparse
import json
import os
import socket
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

# ── Config ────────────────────────────────────────────────────────────────────

WWW_DATA     = os.environ.get("GRIN_WWW_DATA",   "/var/www/grin-stats/data")
DB_PATH      = os.environ.get("GRIN_DB_PATH",   "/opt/grin/grin-stats/stats.db")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN",   "")  # optional — raises rate limit 60→5000/hr

WHOIS_TTL_HOURS = 24   # re-fetch WHOIS only when cached value is older than this

# ── DNS seed lists ─────────────────────────────────────────────────────────────

DNS_SEEDS = {
    "mainnet": [
        "mainnet-seed.grinnode.live",
        "grincoin.org",
        "main.gri.mw",
        "mainnet.grinffindor.org",
        "main-seed.grin.money",
        "mainnet.fountainoffairfortune.it",
    ],
    "testnet": [
        "testnet.grincoin.org",
        "test.gri.mw",
        "testnet.grinffindor.org",
        "test-seed.grin.money",
        "testnet.fountainoffairfortune.it",
    ],
}

SEED_PORTS = {"mainnet": 3414, "testnet": 13414}

# ── Ecosystem services ─────────────────────────────────────────────────────────
# type: "http" (default) | "github" | "gitea" | "stock"
# since: "Mon YYYY" string shown in UI, or None to omit

SERVICES = [
    # ── Explorers ──────────────────────────────────────────────────────────────
    {"category": "Explorer",    "name": "Grin Explorer",     "url": "https://grinexplorer.net",                             "since": "Jan 2019"},
    {"category": "Explorer",    "name": "GrinCoin.org",      "url": "https://grincoin.org/",                                "since": None},

    # ── Exchanges ──────────────────────────────────────────────────────────────
    {"category": "Exchange",    "name": "Gate.io",           "url": "https://www.gate.com/trade/GRIN_USDT",                 "since": "Feb 2019"},
    {"category": "Exchange",    "name": "NoirTrade",         "url": "https://noirtrade.com/trade?pair=GRIN_BTC",            "since": None},
    {"category": "Exchange",    "name": "nonlogs.io",        "url": "https://nonlogs.io/trade/GRIN-BTC",                   "since": None},

    # ── Wallets ────────────────────────────────────────────────────────────────
    {"category": "Wallet",      "name": "GRIM",              "url": "https://gri.mw/",                                     "since": None},
    {"category": "Wallet",      "name": "Grin++",            "url": "https://grinplusplus.github.io/",                     "since": None},
    {"category": "Wallet",      "name": "Easy Grin",         "url": "https://wallet.easygrin.org/",                        "since": None},
    {"category": "Wallet",      "name": "MWC Wallet",        "url": "https://mwcwallet.com/",                              "since": None},

    # ── Community ──────────────────────────────────────────────────────────────
    {"category": "Community",   "name": "grin.mw",           "url": "https://grin.mw",                                     "since": "Jan 2019"},
    {"category": "Community",   "name": "Grin Forum",        "url": "https://forum.grin.mw",                               "since": "Jan 2019"},
    {"category": "Community",   "name": "docs.grin.mw",      "url": "https://docs.grin.mw",                                "since": None},
    {"category": "Community",   "name": "grin.money",        "url": "http://grin.money",                                   "since": None},
    {"category": "Community",   "name": "World Stats",       "url": "https://world.grin.money",                            "since": None},

    # ── Infrastructure ─────────────────────────────────────────────────────────
    {"category": "Node",        "name": "GrinNode.live",     "url": "https://grinnode.live/",                              "since": None},

    # ── E-Commerce ─────────────────────────────────────────────────────────────
    {"category": "Ecommerce",   "name": "Grinily",           "url": "https://grinily.com",                                 "since": None},

    # ── Hardware miners — Shopify .json stock check ────────────────────────────
    {"category": "Miner",       "name": "iPollo G1 Mini",    "url": "https://ipollo.com/products/ipollo-g1-mini",          "since": None, "type": "stock"},
    {"category": "Miner",       "name": "iPollo G1",         "url": "https://ipollo.com/products/ipollo-g1",               "since": None, "type": "stock"},

    # ── Mining pools ───────────────────────────────────────────────────────────
    {"category": "Mining Pool", "name": "2Miners",           "url": "https://2miners.com/grin-mining-pool",                "since": None},
    {"category": "Mining Pool", "name": "EasyGrin Pool",     "url": "https://pool.easygrin.org/",                         "since": None},
    {"category": "Mining Pool", "name": "Always Pool",       "url": "https://pool.always.vip/",                           "since": None},
    {"category": "Mining Pool", "name": "NTMiner Pool",      "url": "https://ntminerpool.com/",                           "since": None},
    {"category": "Mining Pool", "name": "Gaea Pool",         "url": "https://gaeapool.com/",                              "since": None},
    {"category": "Mining Pool", "name": "Pool Stats",        "url": "https://miningpoolstats.stream/grin",                "since": None},

    # ── Dev repos — fetch last release / commit via API ────────────────────────
    {"category": "Dev",         "name": "grin",              "url": "https://github.com/mimblewimble/grin",                "since": "Mar 2018", "type": "github"},
    {"category": "Dev",         "name": "grin-wallet",       "url": "https://github.com/mimblewimble/grin-wallet",         "since": "Jan 2019", "type": "github"},
    {"category": "Dev",         "name": "GRIM",              "url": "https://github.com/GetGrin/grim",                    "since": None,       "type": "github"},
    {"category": "Dev",         "name": "GRIM (mirror)",     "url": "https://code.gri.mw/GUI/grim",                       "since": None,       "type": "gitea"},
    {"category": "Dev",         "name": "Grin++",            "url": "https://github.com/GrinPlusPlus/GrinPlusPlus",        "since": None,       "type": "github"},
    {"category": "Dev",         "name": "Grin Node Toolkit", "url": "https://github.com/noobvie/Grin-Node-Toolkit",        "since": None,       "type": "github"},
    {"category": "Dev",         "name": "GrinSuite",         "url": "https://github.com/noobvie/GrinSuite",                "since": None,       "type": "github"},
]

def _build_services():
    """Return SERVICES list, appending operator-deployed toolkit services from env."""
    svcs = list(SERVICES)
    toolkit = [
        ("GRIN_DROP_URL",         "Grin Drop"),
        ("GRIN_WASM_URL",         "WASM Wallet"),
        ("GRIN_WOOCOMMERCE_URL",  "WooCommerce Gateway"),
    ]
    for env_var, label in toolkit:
        url = os.environ.get(env_var, "").strip()
        if url:
            svcs.append({"category": "Toolkit", "name": label, "url": url, "since": None})
    return svcs

# ── Database ───────────────────────────────────────────────────────────────────

def open_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn

def init_schema(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS dns_seed_history (
            host          TEXT    NOT NULL,
            ip            TEXT    NOT NULL,
            first_seen_ok INTEGER NOT NULL,
            last_seen_ok  INTEGER NOT NULL,
            PRIMARY KEY (host, ip)
        );

        CREATE TABLE IF NOT EXISTS dns_seed_whois (
            host       TEXT    PRIMARY KEY,
            expiry_ts  INTEGER,
            fetched_ts INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ecosystem_service_history (
            url           TEXT    PRIMARY KEY,
            first_seen_ok INTEGER NOT NULL,
            last_seen_ok  INTEGER NOT NULL
        );
    """)
    conn.commit()

# ── DNS seed TCP checks ────────────────────────────────────────────────────────

def _tcp_ok(ip, port, timeout=5):
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except OSError:
        return False

def _check_seed_host(host, port, now, conn):
    try:
        addrs = socket.getaddrinfo(host, port, socket.AF_INET)
        ips = sorted({a[4][0] for a in addrs})
    except OSError:
        ips = []

    if not ips:
        return {"host": host, "port": port, "expiry_ts": None,
                "expiry_str": None, "expiry_days": None, "ips": []}

    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = {ex.submit(_tcp_ok, ip, port): ip for ip in ips}
        results = {futures[f]: f.result() for f in as_completed(futures)}

    ip_entries = []
    for ip in ips:
        ok = results.get(ip, False)
        row = conn.execute(
            "SELECT first_seen_ok FROM dns_seed_history WHERE host=? AND ip=?",
            (host, ip),
        ).fetchone()

        if ok:
            if row:
                conn.execute(
                    "UPDATE dns_seed_history SET last_seen_ok=? WHERE host=? AND ip=?",
                    (now, host, ip),
                )
                first_seen = row[0]
            else:
                conn.execute(
                    "INSERT INTO dns_seed_history VALUES (?,?,?,?)",
                    (host, ip, now, now),
                )
                first_seen = now
            uptime_days = max(0, (now - first_seen) // 86400)
        else:
            uptime_days = None

        ip_entries.append({"ip": ip, "ok": ok, "uptime_days": uptime_days})

    whois_row = conn.execute(
        "SELECT expiry_ts FROM dns_seed_whois WHERE host=?", (host,)
    ).fetchone()
    expiry_ts   = whois_row[0] if whois_row else None
    expiry_str, expiry_days = _format_expiry(expiry_ts, now)

    return {
        "host":        host,
        "port":        port,
        "expiry_ts":   expiry_ts,
        "expiry_str":  expiry_str,
        "expiry_days": expiry_days,
        "ips":         ip_entries,
    }

def _format_expiry(expiry_ts, now):
    if expiry_ts is None:
        return None, None
    days = (expiry_ts - now) // 86400
    dt   = datetime.fromtimestamp(expiry_ts, tz=timezone.utc)
    return dt.strftime("%b %Y"), int(days)

# ── WHOIS domain expiry ────────────────────────────────────────────────────────

def _fetch_whois_expiry(host):
    """Return unix timestamp of domain expiry, or None on failure."""
    try:
        import whois  # python-whois
    except ImportError:
        return None
    try:
        w = whois.whois(host)
        exp = w.expiration_date
        if exp is None:
            return None
        if isinstance(exp, list):
            exp = exp[0]
        if hasattr(exp, "timestamp"):
            return int(exp.timestamp())
        return None
    except Exception:
        return None

def cmd_whois(conn, force=False):
    """Refresh WHOIS expiry for all seed domains. Skips if cached < WHOIS_TTL_HOURS old."""
    now  = int(time.time())
    ttl  = WHOIS_TTL_HOURS * 3600
    all_hosts = [h for hosts in DNS_SEEDS.values() for h in hosts]
    unique_hosts = list(dict.fromkeys(all_hosts))

    for host in unique_hosts:
        row = conn.execute(
            "SELECT fetched_ts FROM dns_seed_whois WHERE host=?", (host,)
        ).fetchone()
        if not force and row and (now - row[0]) < ttl:
            continue  # still fresh

        print(f"[WHOIS] {host} ...", end=" ", flush=True)
        expiry_ts = _fetch_whois_expiry(host)
        conn.execute(
            "INSERT OR REPLACE INTO dns_seed_whois(host, expiry_ts, fetched_ts) VALUES(?,?,?)",
            (host, expiry_ts, now),
        )
        conn.commit()
        if expiry_ts:
            dt = datetime.fromtimestamp(expiry_ts, tz=timezone.utc)
            print(f"expires {dt.strftime('%b %Y')}")
        else:
            print("— (unknown or parse failed)")

# ── HTTP service checks ────────────────────────────────────────────────────────

def _http_check(url, timeout=8):
    """Return (ok, status_code, response_ms)."""
    t0 = time.monotonic()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "grin-ecosystem-checker/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            ms = int((time.monotonic() - t0) * 1000)
            return True, resp.status, ms
    except urllib.error.HTTPError as e:
        ms = int((time.monotonic() - t0) * 1000)
        # Treat 4xx as reachable (server is up), only 5xx as failed
        ok = e.code < 500
        return ok, e.code, ms
    except Exception:
        ms = int((time.monotonic() - t0) * 1000)
        return False, None, ms

def _gh_headers():
    h = {"User-Agent": "grin-ecosystem-checker/1.0",
         "Accept":     "application/vnd.github.v3+json"}
    if GITHUB_TOKEN:
        h["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    return h


def _check_github(url):
    """
    Fetch latest release (tag + date) from GitHub API.
    Falls back to most recent commit if no releases exist.
    Returns (ok, status_code, response_ms, extra_dict).
    extra_dict keys: git_tag, git_date, git_kind ('release' | 'commit')
    """
    after = url.rstrip("/").split("github.com/")
    if len(after) < 2:
        return False, None, 0, {}
    parts = after[1].split("/")
    if len(parts) < 2:
        return False, None, 0, {}
    owner, repo = parts[0], parts[1]
    headers = _gh_headers()

    # Try latest release
    t0 = time.monotonic()
    try:
        req = urllib.request.Request(
            f"https://api.github.com/repos/{owner}/{repo}/releases/latest",
            headers=headers,
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            ms   = int((time.monotonic() - t0) * 1000)
            data = json.loads(resp.read())
            tag  = data.get("tag_name", "")
            pub  = (data.get("published_at") or "")[:10]
            return True, 200, ms, {"git_tag": tag, "git_date": pub, "git_kind": "release"}
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            return False, exc.code, int((time.monotonic() - t0) * 1000), {}
        # 404 = repo has no releases — fall through to commits
    except Exception:
        return False, None, int((time.monotonic() - t0) * 1000), {}

    # Fall back to last commit
    t0 = time.monotonic()
    try:
        req = urllib.request.Request(
            f"https://api.github.com/repos/{owner}/{repo}/commits?per_page=1",
            headers=headers,
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            ms   = int((time.monotonic() - t0) * 1000)
            data = json.loads(resp.read())
            if data:
                date = (data[0].get("commit", {}).get("committer", {}).get("date") or "")[:10]
                sha  = (data[0].get("sha") or "")[:7]
                return True, 200, ms, {"git_tag": sha, "git_date": date, "git_kind": "commit"}
            return True, 200, ms, {}
    except Exception:
        return False, None, int((time.monotonic() - t0) * 1000), {}


def _check_gitea(url):
    """
    Fetch latest release or commit from a Gitea instance API.
    Returns (ok, status_code, response_ms, extra_dict).
    """
    parsed   = urllib.parse.urlparse(url)
    base     = f"{parsed.scheme}://{parsed.netloc}"
    parts    = parsed.path.strip("/").split("/")
    if len(parts) < 2:
        return False, None, 0, {}
    owner, repo = parts[0], parts[1]
    api_base = f"{base}/api/v1"
    headers  = {"User-Agent": "grin-ecosystem-checker/1.0"}

    # Try latest release
    t0 = time.monotonic()
    try:
        req = urllib.request.Request(
            f"{api_base}/repos/{owner}/{repo}/releases?limit=1&page=1",
            headers=headers,
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            ms   = int((time.monotonic() - t0) * 1000)
            data = json.loads(resp.read())
            if data:
                tag = data[0].get("tag_name", "")
                pub = (data[0].get("published_at") or "")[:10]
                return True, 200, ms, {"git_tag": tag, "git_date": pub, "git_kind": "release"}
    except urllib.error.HTTPError as exc:
        if exc.code not in (404, 403):
            return False, exc.code, int((time.monotonic() - t0) * 1000), {}
    except Exception:
        return False, None, int((time.monotonic() - t0) * 1000), {}

    # Fall back to last commit
    t0 = time.monotonic()
    try:
        req = urllib.request.Request(
            f"{api_base}/repos/{owner}/{repo}/commits?sha=main&limit=1",
            headers=headers,
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            ms   = int((time.monotonic() - t0) * 1000)
            data = json.loads(resp.read())
            if data:
                date = (data[0].get("created") or "")[:10]
                sha  = (data[0].get("sha") or "")[:7]
                return True, 200, ms, {"git_tag": sha, "git_date": date, "git_kind": "commit"}
            return True, 200, ms, {}
    except Exception:
        return False, None, int((time.monotonic() - t0) * 1000), {}


def _check_stock(url):
    """
    Check Shopify product availability via the /products/{handle}.json endpoint.
    Returns (ok, status_code, response_ms, extra_dict).
    extra_dict keys: in_stock (bool)
    """
    json_url = url.rstrip("/") + ".json"
    t0 = time.monotonic()
    try:
        req = urllib.request.Request(
            json_url, headers={"User-Agent": "grin-ecosystem-checker/1.0"}
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            ms       = int((time.monotonic() - t0) * 1000)
            data     = json.loads(resp.read())
            variants = data.get("product", {}).get("variants", [])
            in_stock = any(v.get("available", False) for v in variants)
            return True, 200, ms, {"in_stock": in_stock}
    except Exception:
        return False, None, int((time.monotonic() - t0) * 1000), {}


def _check_services(services, now, conn):
    def check_one(svc):
        svc_type = svc.get("type", "http")
        if svc_type == "github":
            ok, code, ms, extra = _check_github(svc["url"])
        elif svc_type == "gitea":
            ok, code, ms, extra = _check_gitea(svc["url"])
        elif svc_type == "stock":
            ok, code, ms, extra = _check_stock(svc["url"])
        else:
            ok, code, ms = _http_check(svc["url"])
            extra = {}
        return svc, ok, code, ms, extra

    results = []
    with ThreadPoolExecutor(max_workers=10) as ex:
        futures = {ex.submit(check_one, s): s for s in services}
        for f in as_completed(futures):
            svc, ok, code, ms, extra = f.result()
            row = conn.execute(
                "SELECT first_seen_ok FROM ecosystem_service_history WHERE url=?",
                (svc["url"],),
            ).fetchone()
            if ok:
                if row:
                    conn.execute(
                        "UPDATE ecosystem_service_history SET last_seen_ok=? WHERE url=?",
                        (now, svc["url"]),
                    )
                    first_seen = row[0]
                else:
                    conn.execute(
                        "INSERT INTO ecosystem_service_history VALUES (?,?,?)",
                        (svc["url"], now, now),
                    )
                    first_seen = now
                uptime_days = max(0, (now - first_seen) // 86400)
            else:
                uptime_days = None

            result = {
                "category":    svc["category"],
                "name":        svc["name"],
                "url":         svc["url"],
                "type":        svc.get("type", "http"),
                "since":       svc.get("since"),
                "ok":          ok,
                "status_code": code,
                "response_ms": ms if ok else None,
                "uptime_days": uptime_days,
            }
            result.update(extra)  # git_tag, git_date, git_kind, in_stock
            results.append(result)

    # Preserve SERVICES ordering
    url_order = {s["url"]: i for i, s in enumerate(services)}
    results.sort(key=lambda r: url_order.get(r["url"], 999))
    return results

# ── JSON write ─────────────────────────────────────────────────────────────────

def _write_json(filename, data):
    os.makedirs(WWW_DATA, exist_ok=True)
    path = os.path.join(WWW_DATA, filename)
    tmp  = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    os.replace(tmp, path)

# ── Commands ───────────────────────────────────────────────────────────────────

def cmd_init_db():
    conn = open_db()
    init_schema(conn)
    conn.close()
    print("[OK] Ecosystem DB tables created.")

def cmd_update():
    now  = int(time.time())
    conn = open_db()
    init_schema(conn)

    # Refresh stale WHOIS entries quietly (no force)
    cmd_whois(conn, force=False)

    # DNS seed TCP checks
    print("[INFO] Checking DNS seeds...")
    dns_result = {"mainnet": [], "testnet": []}
    for net, hosts in DNS_SEEDS.items():
        port = SEED_PORTS[net]
        for host in hosts:
            entry = _check_seed_host(host, port, now, conn)
            dns_result[net].append(entry)
            status = f"{sum(1 for ip in entry['ips'] if ip['ok'])}/{len(entry['ips'])} IPs ok"
            print(f"  {host}: {status}")

    # HTTP service checks
    print("[INFO] Checking ecosystem services...")
    services = _build_services()
    svc_results = _check_services(services, now, conn)
    for r in svc_results:
        icon = "✓" if r["ok"] else "✗"
        print(f"  {icon} {r['name']} ({r['url']})")

    conn.commit()
    conn.close()

    _write_json("ecosystem.json", {
        "updated":   now,
        "dns_seeds": dns_result,
        "services":  svc_results,
    })
    print(f"[OK] ecosystem.json written to {WWW_DATA}")

# ── Entry point ────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Grin Ecosystem Checker")
    group  = parser.add_mutually_exclusive_group()
    group.add_argument("--update",  action="store_true",
                       help="TCP + HTTP checks + stale WHOIS refresh (default)")
    group.add_argument("--init-db", action="store_true",
                       help="Create DB tables only")
    group.add_argument("--whois",   action="store_true",
                       help="Force WHOIS refresh for all seed domains")
    args = parser.parse_args()

    if args.init_db:
        cmd_init_db()
    elif args.whois:
        conn = open_db()
        init_schema(conn)
        cmd_whois(conn, force=True)
        conn.commit()
        conn.close()
    else:
        cmd_update()

if __name__ == "__main__":
    main()
