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
        "mainnet.grin.mw",
        "mainnet.grinffindor.org",
        "main-seed.grin.money",
        "mainnet.fountainoffairfortune.it",
    ],
    "testnet": [
        "testnet.grincoin.org",
        "test.gri.mw",
        "testnet.grin.mw",
        "testnet.grinffindor.org",
        "test-seed.grin.money",
        "testnet.fountainoffairfortune.it",
    ],
}

SEED_PORTS = {"mainnet": 3414, "testnet": 13414}

# ── External wallet-API nodes ──────────────────────────────────────────────────
# Domains shared with DNS_SEEDS — no WHOIS check needed, just HTTP response time.

EXTERNAL_NODES = {
    "mainnet": [
        "api.grin.money",
        "api.grinily.com",
        "api.onlygrins.com",
        "api.grinnode.org",
        "main.gri.mw",
        "grincoin.org",
    ],
    "testnet": [
        "testapi.grin.money",
        "testapi.grinily.com",
        "testapi.onlygrins.com",
        "testnet.grincoin.org",
        "test.gri.mw",
    ],
}

# TLDs where WHOIS servers are reliable enough for automated refresh.
# Everything else (.mw, .io, .live, .money, ccTLDs) must be maintained manually
# in 06_domains_exceptions.json — their WHOIS servers block or return bad data.
WHOIS_AUTO_TLDS = {".com", ".org", ".net"}

def _is_auto_tld(domain):
    tld = "." + domain.rsplit(".", 1)[-1] if "." in domain else ""
    return tld in WHOIS_AUTO_TLDS

# Notes shown in place of IP rows when a seed host has no DNS records yet
DNS_SEED_NOTES = {
    "mainnet.grin.mw": "Not available yet — DNS record pending",
    "testnet.grin.mw": "Not available yet — DNS record pending",
}

# ── WHOIS fallback for domains whose WHOIS servers block automated queries ─────
# Edit 06_domains_exceptions.json (same directory) to update dates on renewal.

def _date_to_ts(s):
    """Convert YYYY-MM-DD string to UTC midnight timestamp."""
    from datetime import datetime as _dt
    return int(_dt.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())

def _load_whois_fallback():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "06_domains_exceptions.json")
    try:
        with open(path) as f:
            raw = json.load(f)
        return {
            domain: {
                "registered_ts": _date_to_ts(v["registered"]) if v.get("registered") else None,
                "expiry_ts":     _date_to_ts(v["expires"])    if v.get("expires")    else None,
            }
            for domain, v in raw.items()
        }
    except (FileNotFoundError, json.JSONDecodeError, ValueError, KeyError) as e:
        print(f"[WARN] 06_domains_exceptions.json load failed: {e} — WHOIS fallback disabled", file=sys.stderr)
        return {}

WHOIS_FALLBACK = _load_whois_fallback()

# ── Ecosystem services — loaded from JSON sidecar files ────────────────────────
# Edit 06_ecosystem_sites.json to add/remove service entries (Explorers, Exchanges,
# Wallets, Community, Miners, Pools, APIs).
# Edit 06_ecosystem_dev.json to add/remove development progress repos.
# type: "http" (default) | "github" | "gitea" | "stock"
# since: "Mon YYYY" string shown in UI, or null to omit

def _load_json_sidecar(filename, required=False):
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), filename)
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, list):
            raise ValueError(f"expected a JSON array, got {type(data).__name__}")
        return data
    except (FileNotFoundError, json.JSONDecodeError, ValueError) as e:
        level = "ERROR" if required else "WARN"
        print(f"[{level}] {filename} load failed: {e}", file=sys.stderr)
        if required:
            sys.exit(1)
        return []

ECOSYSTEM_SITES = _load_json_sidecar("06_ecosystem_sites.json", required=True)
ECOSYSTEM_DEV   = _load_json_sidecar("06_ecosystem_dev.json",   required=False)

def _build_services():
    """Return full services list, appending operator-deployed toolkit services from env."""
    svcs = list(ECOSYSTEM_SITES) + list(ECOSYSTEM_DEV)
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
            host          TEXT    PRIMARY KEY,
            expiry_ts     INTEGER,
            registered_ts INTEGER,
            fetched_ts    INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ecosystem_service_history (
            url           TEXT    PRIMARY KEY,
            first_seen_ok INTEGER NOT NULL,
            last_seen_ok  INTEGER NOT NULL
        );
    """)
    # Migrate existing DB: add registered_ts if the column is missing
    try:
        conn.execute("ALTER TABLE dns_seed_whois ADD COLUMN registered_ts INTEGER")
    except Exception:
        pass  # column already exists
    conn.commit()

# ── DNS seed TCP checks ────────────────────────────────────────────────────────

def _tcp_ok(ip, port, timeout=5):
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except OSError:
        return False

def _check_seed_host(host, port, now, conn):
    # WHOIS lookup first — needed even when DNS resolution fails (e.g. pending seeds)
    whois_row = conn.execute(
        "SELECT expiry_ts, registered_ts FROM dns_seed_whois WHERE host=?", (host,)
    ).fetchone()
    expiry_ts     = whois_row[0] if whois_row else None
    registered_ts = whois_row[1] if whois_row else None
    if expiry_ts is None:
        fb = WHOIS_FALLBACK.get(_registrable_domain(host), {})
        expiry_ts     = expiry_ts     or fb.get("expiry_ts")
        registered_ts = registered_ts or fb.get("registered_ts")
    expiry_str, expiry_days, registered_str = _format_expiry(expiry_ts, registered_ts, now)

    try:
        addrs = socket.getaddrinfo(host, port, socket.AF_INET)
        ips = sorted({a[4][0] for a in addrs})
    except OSError:
        ips = []

    if not ips:
        return {
            "host":           host,
            "port":           port,
            "expiry_ts":      expiry_ts,
            "expiry_str":     expiry_str,
            "expiry_days":    expiry_days,
            "registered_str": registered_str,
            "note":           DNS_SEED_NOTES.get(host),
            "ips":            [],
        }

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

    return {
        "host":           host,
        "port":           port,
        "expiry_ts":      expiry_ts,
        "expiry_str":     expiry_str,
        "expiry_days":    expiry_days,
        "registered_str": registered_str,
        "note":           None,
        "ips":            ip_entries,
    }

def _format_expiry(expiry_ts, registered_ts, now):
    expiry_str = expiry_days = registered_str = None
    if expiry_ts is not None:
        days = (expiry_ts - now) // 86400
        expiry_str  = datetime.fromtimestamp(expiry_ts,     tz=timezone.utc).strftime("%b %Y")
        expiry_days = int(days)
    if registered_ts is not None:
        registered_str = datetime.fromtimestamp(registered_ts, tz=timezone.utc).strftime("%b %Y")
    return expiry_str, expiry_days, registered_str

# ── WHOIS domain expiry ────────────────────────────────────────────────────────

def _registrable_domain(host):
    """Strip subdomains — WHOIS servers only hold records for the registrable domain.
    e.g. mainnet-seed.grinnode.live → grinnode.live  |  grincoin.org → grincoin.org"""
    parts = host.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


def _parse_whois_date(s):
    """Parse a date string from raw WHOIS output. Returns UTC timestamp or None."""
    from datetime import datetime as _dt
    s = s.strip().split("T")[0].split(" ")[0]  # drop time portion
    for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%Y/%m/%d", "%d.%m.%Y", "%d-%m-%Y"):
        try:
            return int(_dt.strptime(s, fmt).replace(tzinfo=timezone.utc).timestamp())
        except ValueError:
            pass
    return None


def _fetch_whois_expiry_raw(registrable):
    """Fallback: run system `whois` binary and parse expiry with a broad regex.
    Catches TLDs that python-whois has no built-in parser for (.live, .mw, .money…)."""
    import subprocess
    import re as _re
    _EXPIRY_RE = _re.compile(
        r"(?:registry expiry date|expir(?:y|ation|es?|ed) date"
        r"|paid-till|renewal(?:\s+date)?|valid(?:\s+until)?)\s*[:\s]\s*(\S+)",
        _re.IGNORECASE,
    )
    try:
        result = subprocess.run(
            ["whois", registrable], capture_output=True, text=True, timeout=20
        )
        for m in _EXPIRY_RE.finditer(result.stdout):
            ts = _parse_whois_date(m.group(1))
            if ts:
                return ts, None
        return None, "no expiry pattern matched in raw whois output"
    except FileNotFoundError:
        return None, "whois command not found (run: apt install whois)"
    except subprocess.TimeoutExpired:
        return None, "raw whois timed out"
    except Exception as exc:
        return None, f"raw whois error: {exc}"


def _fetch_whois_expiry(registrable):
    """Return (unix_ts, reason) for domain expiry.
    Tries python-whois first; falls back to system whois binary for TLDs
    that python-whois cannot parse (.live, .mw, .money, etc.)."""
    try:
        import whois  # python-whois
    except ImportError:
        return None, "python-whois not installed (run: pip3 install python-whois)"
    try:
        w = whois.whois(registrable)
        exp = w.expiration_date
        if isinstance(exp, list):
            exp = exp[0]
        # datetime object
        if exp is not None and hasattr(exp, "timestamp"):
            return int(exp.timestamp()), None
        # string date — some TLDs return "2026-01-15 00:00:00" or "2026-01-15"
        if isinstance(exp, str):
            for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%d-%b-%Y"):
                try:
                    from datetime import datetime as _dt
                    parsed = _dt.strptime(exp.strip(), fmt).replace(tzinfo=timezone.utc)
                    return int(parsed.timestamp()), None
                except ValueError:
                    pass
            return None, f"unrecognised date format: {exp!r}"
    except Exception:
        pass  # fall through to raw whois
    # python-whois failed or returned None — try system whois binary
    return _fetch_whois_expiry_raw(registrable)


def cmd_whois(conn, force=False):
    """Refresh WHOIS expiry for all seed domains. Skips if cached < WHOIS_TTL_HOURS old.
    Queries the registrable domain (strips subdomains) and deduplicates so shared
    domains (e.g. main.gri.mw + test.gri.mw → gri.mw) are only fetched once."""
    now  = int(time.time())
    ttl  = WHOIS_TTL_HOURS * 3600
    all_hosts = [h for hosts in DNS_SEEDS.values() for h in hosts]
    # Also include service domains with standard TLDs (.com/.org/.net)
    for svc in SERVICES:
        try:
            hostname = urllib.parse.urlparse(svc["url"]).hostname or ""
            reg = _registrable_domain(hostname)
            if _is_auto_tld(reg) and reg not in all_hosts:
                all_hosts.append(reg)
        except Exception:
            pass
    unique_hosts = list(dict.fromkeys(all_hosts))

    # Deduplicate by registrable domain — cache result keyed on registrable,
    # then write the same expiry_ts/registered_ts for every subdomain that maps to it.
    registrable_cache = {}  # registrable → (expiry_ts, registered_ts, reason)

    for host in unique_hosts:
        row = conn.execute(
            "SELECT fetched_ts FROM dns_seed_whois WHERE host=?", (host,)
        ).fetchone()
        if not force and row and (now - row[0]) < ttl:
            continue  # still fresh

        reg = _registrable_domain(host)
        print(f"[WHOIS] {host} ({reg}) ...", end=" ", flush=True)

        if reg in registrable_cache:
            expiry_ts, registered_ts, reason = registrable_cache[reg]
            print("(cached from registrable domain)", end=" ")
        else:
            expiry_ts, reason = _fetch_whois_expiry(reg)
            registered_ts = None
            # If live WHOIS still returned nothing, use hardcoded fallback
            if expiry_ts is None and reg in WHOIS_FALLBACK:
                fb            = WHOIS_FALLBACK[reg]
                expiry_ts     = fb.get("expiry_ts")
                registered_ts = fb.get("registered_ts")
                reason        = None
                print("(hardcoded fallback)", end=" ")
            registrable_cache[reg] = (expiry_ts, registered_ts, reason)
            time.sleep(1.5)  # be polite to WHOIS servers between unique queries

        conn.execute(
            "INSERT OR REPLACE INTO dns_seed_whois(host, expiry_ts, registered_ts, fetched_ts) VALUES(?,?,?,?)",
            (host, expiry_ts, registered_ts, now),
        )
        conn.commit()
        if expiry_ts:
            dt = datetime.fromtimestamp(expiry_ts, tz=timezone.utc)
            print(f"expires {dt.strftime('%b %Y')}")
        else:
            print(f"— ({reason})")

# ── External node HTTP checks ──────────────────────────────────────────────────

def _check_external_nodes():
    """HTTP-check all external wallet-API nodes. Returns {mainnet:[…], testnet:[…]}."""
    result = {"mainnet": [], "testnet": []}

    def check_one(net, host):
        ok, _, ms = _http_check(f"https://{host}/", timeout=8)
        return net, {"host": host, "ok": ok, "response_ms": ms if ok else None}

    items = [(net, host) for net, hosts in EXTERNAL_NODES.items() for host in hosts]
    with ThreadPoolExecutor(max_workers=10) as ex:
        futures = [ex.submit(check_one, net, host) for net, host in items]
        for f in as_completed(futures):
            net, entry = f.result()
            result[net].append(entry)

    for net in result:
        order = {h: i for i, h in enumerate(EXTERNAL_NODES[net])}
        result[net].sort(key=lambda e: order.get(e["host"], 999))
    return result

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
    extra_dict keys: in_stock (bool | None)  None = no variant data returned
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
            if not variants:
                # Product JSON returned no variant data — can't determine stock
                return True, 200, ms, {"in_stock": None}
            # available=True OR inventory_policy="continue" (pre-order / backorder)
            in_stock = any(
                v.get("available", False) or v.get("inventory_policy") == "continue"
                for v in variants
            )
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
            if ok and "in_stock" in svc:  # hardcoded override takes precedence
                extra["in_stock"] = svc["in_stock"]
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
            # Use domain registration/expiry dates for services on known managed domains
            if result.get("category") != "Development progress":
                try:
                    hostname = urllib.parse.urlparse(svc["url"]).hostname or ""
                    reg = _registrable_domain(hostname)
                    expiry_ts = registered_ts = None
                    # Auto TLDs: read from DB (populated by cmd_whois)
                    if _is_auto_tld(reg):
                        row = conn.execute(
                            "SELECT expiry_ts, registered_ts FROM dns_seed_whois WHERE host=?",
                            (reg,),
                        ).fetchone()
                        if row:
                            expiry_ts, registered_ts = row
                    # Manual TLDs: read from JSON fallback
                    if expiry_ts is None:
                        fb = WHOIS_FALLBACK.get(reg, {})
                        expiry_ts     = fb.get("expiry_ts")
                        registered_ts = registered_ts or fb.get("registered_ts")
                    if not result.get("since") and registered_ts:
                        result["registered_str"] = datetime.fromtimestamp(
                            registered_ts, tz=timezone.utc
                        ).strftime("%b %Y")
                    if expiry_ts:
                        exp_str, exp_days, _ = _format_expiry(expiry_ts, None, now)
                        result["expiry_str"]  = exp_str
                        result["expiry_days"] = exp_days
                except Exception:
                    pass
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

    # External node HTTP checks
    print("[INFO] Checking external nodes...")
    ext_result = _check_external_nodes()
    for net, nodes in ext_result.items():
        for n in nodes:
            icon = "✓" if n["ok"] else "✗"
            ms   = f"{n['response_ms']}ms" if n["response_ms"] is not None else "—"
            print(f"  {icon} [{net}] {n['host']} {ms}")

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
        "updated":        now,
        "dns_seeds":      dns_result,
        "external_nodes": ext_result,
        "services":       svc_results,
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
        # Regenerate ecosystem.json so the HTML page reflects the new expiry dates.
        # cmd_update() calls cmd_whois(force=False) internally — it will skip all
        # entries we just refreshed (they're fresh in the cache) and just re-run
        # the TCP/HTTP checks before writing the JSON.
        print("[INFO] Regenerating ecosystem.json with updated WHOIS data...")
        cmd_update()
    else:
        cmd_update()

if __name__ == "__main__":
    main()
