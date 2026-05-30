#!/usr/bin/env python3
"""
grin-ecosystem-checker
======================
Checks Grin DNS seeds (TCP) and ecosystem service URLs (HTTP).
Tracks per-IP uptime and per-domain RDAP expiry in SQLite.
Writes ecosystem.json for the ecosystem.html status page.

Usage:
    python3 06_ecosystem_checker.py --update    TCP + HTTP checks + stale RDAP refresh  [default]
    python3 06_ecosystem_checker.py --init-db   Create DB tables only
    python3 06_ecosystem_checker.py --whois     Force RDAP refresh for all seed domains

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

RDAP_TTL_HOURS = 24   # re-fetch RDAP only when cached value is older than this
COMMUNITY_NODES_PATH = os.environ.get(
    "GRIN_COMMUNITY_NODES",
    os.path.join(os.path.dirname(DB_PATH), "community_nodes.json"),
)
FAIL_THRESHOLD = 168  # consecutive failed hourly checks before auto-removing a
                      # community node (168 = 7 days). Tolerates reboots/flaky uplinks.

# ── DNS seed lists ─────────────────────────────────────────────────────────────
# Edit 06_dns_seeds.json to add/remove seeds or update pending-DNS notes.
# Edit 06_external_nodes.json to add/remove wallet-API nodes.

def _load_json_config(filename):
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), filename)
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, ValueError) as e:
        print(f"[ERROR] {filename} load failed: {e}", file=sys.stderr)
        sys.exit(1)

_dns_seeds_cfg = _load_json_config("06_dns_seeds.json")
DNS_SEEDS      = {k: v for k, v in _dns_seeds_cfg.items() if k in ("mainnet", "testnet")}
DNS_SEED_NOTES = _dns_seeds_cfg.get("notes", {})
EXTERNAL_NODES = _load_json_config("06_external_nodes.json")

SEED_PORTS = {"mainnet": 3414, "testnet": 13414}

# ── RDAP fallback for domains with no RDAP support (e.g. .mw ccTLD) ──────────
# Edit 06_domains_exceptions.json (same directory) to update dates on renewal.

def _date_to_ts(s):
    """Convert YYYY-MM-DD string to UTC midnight timestamp."""
    return int(datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())

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
        print(f"[WARN] 06_domains_exceptions.json load failed: {e} — RDAP fallback disabled", file=sys.stderr)
        return {}

WHOIS_FALLBACK = _load_whois_fallback()

# ── Community node I/O ─────────────────────────────────────────────────────────

def _load_community_nodes():
    try:
        with open(COMMUNITY_NODES_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            return {"mainnet": [], "testnet": []}
        return {
            "mainnet": [n for n in data.get("mainnet", []) if isinstance(n, dict)],
            "testnet": [n for n in data.get("testnet", []) if isinstance(n, dict)],
        }
    except (FileNotFoundError, json.JSONDecodeError):
        return {"mainnet": [], "testnet": []}


def _save_community_nodes(data):
    tmp = COMMUNITY_NODES_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, separators=(",", ":"))
    os.replace(tmp, COMMUNITY_NODES_PATH)

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
        expiry_ts     = fb.get("expiry_ts")
        registered_ts = registered_ts or fb.get("registered_ts")
    expiry_str, expiry_days, registered_str = _format_expiry(expiry_ts, registered_ts, now)

    try:
        addrs = socket.getaddrinfo(host, port, socket.AF_UNSPEC)
        ips = sorted({a[4][0] for a in addrs if a[0] in (socket.AF_INET, socket.AF_INET6)})
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

# ── RDAP domain expiry ─────────────────────────────────────────────────────────

def _registrable_domain(host):
    """Strip subdomains — RDAP only holds records for the registrable domain.
    e.g. mainnet-seed.grinnode.live → grinnode.live  |  grincoin.org → grincoin.org"""
    parts = host.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


def _parse_rdap_date(s):
    """Parse ISO 8601 date from RDAP eventDate. Returns UTC timestamp or None."""
    if not s:
        return None
    try:
        # Normalize timezone suffix and truncate fractional seconds to 6 digits
        # (microseconds) so Python < 3.11 fromisoformat doesn't reject 7+ digit
        # precision returned by some RDAP servers (e.g. ".0000000").
        import re as _re
        s = s.strip().replace("Z", "+00:00")
        s = _re.sub(r"(\.\d{6})\d+", r"\1", s)
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    except ValueError:
        return None


def _parse_whois_date(s):
    """Parse a date string from raw WHOIS output. Returns UTC timestamp or None."""
    s = s.strip().split("T")[0].split(" ")[0]
    for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%Y/%m/%d", "%d.%m.%Y", "%d-%m-%Y"):
        try:
            return int(datetime.strptime(s, fmt).replace(tzinfo=timezone.utc).timestamp())
        except ValueError:
            pass
    return None


def _fetch_whois_expiry_raw(registrable):
    """Fallback: run system `whois` binary and parse expiry with a broad regex.
    Used when RDAP is unavailable. Returns (expiry_ts, reason)."""
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
        return None, "no expiry pattern matched in whois output"
    except FileNotFoundError:
        return None, "whois binary not found (apt install whois)"
    except subprocess.TimeoutExpired:
        return None, "whois timed out"
    except Exception as exc:
        return None, f"whois error: {exc}"


# TLDs whose registries have their own RDAP servers that rdap.org fails to
# bootstrap correctly. Queried directly when rdap.org returns an error.
# Donuts manages .live/.money/.fail/.stream/.vip and many others.
_RDAP_DIRECT = {
    "live":   "https://rdap.donuts.co/rdap",
    "money":  "https://rdap.donuts.co/rdap",
    "fail":   "https://rdap.donuts.co/rdap",
    "stream": "https://rdap.donuts.co/rdap",
    "vip":    "https://rdap.donuts.co/rdap",
}


def _parse_rdap_response(data, registrable):
    """Extract (expiry_ts, registered_ts, reason) from a parsed RDAP JSON dict."""
    expiry_ts = registered_ts = None
    for event in data.get("events", []):
        action = event.get("eventAction", "").lower()
        ts = _parse_rdap_date(event.get("eventDate", ""))
        # RFC 7483 uses "expiration"; some registrars (e.g. Donuts) use "expiry"
        if action in ("expiration", "expiry"):
            if ts is not None and (expiry_ts is None or ts > expiry_ts):
                expiry_ts = ts
        elif action == "registration":
            if ts is not None and (registered_ts is None or ts < registered_ts):
                registered_ts = ts
    if expiry_ts is None:
        return None, registered_ts, "RDAP returned no expiration event"
    return expiry_ts, registered_ts, None


def _rdap_fetch(url):
    """Fetch and parse an RDAP URL. Returns (data_dict, error_str)."""
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/rdap+json"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode()), None
    except urllib.error.HTTPError as exc:
        return None, f"RDAP HTTP {exc.code}"
    except Exception as exc:
        return None, f"RDAP error: {exc}"


def _fetch_rdap_expiry(registrable):
    """Return (expiry_ts, registered_ts, reason) via RDAP.
    Tries rdap.org first; if that fails, falls back to the registry's own RDAP
    server for TLDs known not to be bootstrapped correctly by rdap.org (e.g.
    Donuts TLDs: .live .money .fail .stream .vip).
    Returns (None, None, reason) on failure so the caller can fall back to the
    whois binary or 06_domains_exceptions.json."""
    tld = registrable.rsplit(".", 1)[-1].lower()

    # Tier 1: rdap.org (covers most gTLDs)
    data, err = _rdap_fetch(f"https://rdap.org/domain/{registrable}")
    if data is not None:
        return _parse_rdap_response(data, registrable)

    # Tier 2: direct registry RDAP for TLDs rdap.org can't bootstrap
    direct_base = _RDAP_DIRECT.get(tld)
    if direct_base:
        data, err2 = _rdap_fetch(f"{direct_base}/domain/{registrable}")
        if data is not None:
            return _parse_rdap_response(data, registrable)
        err = err2  # report the direct-registry error if both fail

    return None, None, err or "RDAP unavailable"


def cmd_whois(conn, force=False):
    """Refresh RDAP expiry for all seed and service domains. Skips if cached < RDAP_TTL_HOURS old.
    Queries the registrable domain (strips subdomains) and deduplicates so shared
    domains (e.g. main.gri.mw + test.gri.mw → gri.mw) are only fetched once."""
    now  = int(time.time())
    ttl  = RDAP_TTL_HOURS * 3600
    all_hosts = [h for hosts in DNS_SEEDS.values() for h in hosts]
    # Include all service domains — RDAP covers all gTLDs, fallback handles the rest
    for svc in _build_services():
        try:
            hostname = urllib.parse.urlparse(svc["url"]).hostname or ""
            reg = _registrable_domain(hostname)
            if reg and reg not in all_hosts:
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
        print(f"[RDAP] {host} ({reg}) ...", end=" ", flush=True)

        if reg in registrable_cache:
            expiry_ts, registered_ts, reason = registrable_cache[reg]
            print("(cached from registrable domain)", end=" ")
        else:
            expiry_ts, registered_ts, reason = _fetch_rdap_expiry(reg)
            # Tier 2: RDAP failed — try system whois binary
            if expiry_ts is None:
                whois_ts, whois_reason = _fetch_whois_expiry_raw(reg)
                if whois_ts is not None:
                    expiry_ts = whois_ts
                    reason    = None
                    print("(whois fallback)", end=" ")
                else:
                    reason = whois_reason
            # Tier 3: both failed — use manual JSON fallback (e.g. .mw ccTLD)
            if expiry_ts is None and reg in WHOIS_FALLBACK:
                fb            = WHOIS_FALLBACK[reg]
                expiry_ts     = fb.get("expiry_ts")
                registered_ts = fb.get("registered_ts")
                reason        = None
                print("(manual fallback)", end=" ")
            elif registered_ts is None and reg in WHOIS_FALLBACK:
                registered_ts = WHOIS_FALLBACK[reg].get("registered_ts")
            registrable_cache[reg] = (expiry_ts, registered_ts, reason)
            time.sleep(1)  # be polite to rdap.org between unique queries

        if expiry_ts is not None:
            conn.execute(
                "INSERT OR REPLACE INTO dns_seed_whois(host, expiry_ts, registered_ts, fetched_ts) VALUES(?,?,?,?)",
                (host, expiry_ts, registered_ts, now),
            )
        else:
            # RDAP/whois failed — preserve any previously good expiry rather than
            # overwriting with NULL, which would show "-" for the next 24h.
            existing = conn.execute(
                "SELECT expiry_ts, registered_ts FROM dns_seed_whois WHERE host=?", (host,)
            ).fetchone()
            if existing and existing[0] is not None:
                conn.execute(
                    "UPDATE dns_seed_whois SET fetched_ts=? WHERE host=?", (now, host)
                )
            else:
                conn.execute(
                    "INSERT OR REPLACE INTO dns_seed_whois(host, expiry_ts, registered_ts, fetched_ts) VALUES(?,?,?,?)",
                    (host, None, None, now),
                )
        conn.commit()
        if expiry_ts:
            dt = datetime.fromtimestamp(expiry_ts, tz=timezone.utc)
            print(f"expires {dt.strftime('%b %Y')}")
        else:
            print(f"— ({reason})")

# ── External node HTTP checks ──────────────────────────────────────────────────

def _check_external_nodes():
    """HTTP-check curated + community wallet-API nodes. Returns {mainnet:[…], testnet:[…]}."""
    result    = {net: [] for net in EXTERNAL_NODES}
    community = _load_community_nodes()

    def _fetch_tip_height(base_url):
        """JSON-RPC call to /v2/foreign get_tip. Returns int or None."""
        rpc_url = base_url.rstrip("/") + "/v2/foreign"
        try:
            rpc = json.dumps({"jsonrpc": "2.0", "method": "get_tip", "params": [], "id": 1}).encode()
            req = urllib.request.Request(
                rpc_url,
                data=rpc,
                headers={"Content-Type": "application/json", "User-Agent": "grin-ecosystem-checker/1.0"},
            )
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read())
            result = data.get("result", {})
            if isinstance(result, dict) and "Ok" in result:
                return result["Ok"].get("height")
            print(f"[WARN] tip height unexpected response from {rpc_url}: {str(data)[:120]}", file=sys.stderr)
            return None
        except urllib.error.HTTPError as e:
            print(f"[WARN] tip height HTTP {e.code} from {rpc_url} (node may require auth)", file=sys.stderr)
            return None
        except Exception as e:
            print(f"[WARN] tip height fetch failed for {rpc_url}: {e}", file=sys.stderr)
            return None

    def check_one(net, protocol, entry, community_url=None):
        if entry.startswith("http://") or entry.startswith("https://"):
            url  = entry
            host = urllib.parse.urlparse(entry).hostname or entry
        else:
            url  = f"https://{entry}/"
            host = entry
        if protocol == "tor":
            ok, _, ms = _http_check_tor(url, timeout=30)
            height = _fetch_tip_height_tor(url, timeout=30) if ok else None
        else:
            ok, _, ms = _http_check(url, timeout=8)
            height = _fetch_tip_height(url) if ok else None
        entry_dict = {
            "host": host, "protocol": protocol, "ok": ok,
            "response_ms": ms if ok else None, "tip_height": height,
        }
        if community_url:
            entry_dict["community"]      = True
            entry_dict["_community_url"] = community_url  # internal — stripped before return
        return net, entry_dict

    # Curated items (from 06_external_nodes.json)
    items = [
        (net, proto, entry, None)
        for net, protos in EXTERNAL_NODES.items()
        for proto, entries in protos.items()
        for entry in entries
    ]
    # Community items — .onion nodes are checked over Tor, the rest over https.
    for net, nodes in community.items():
        for n in nodes:
            host  = (urllib.parse.urlparse(n["url"]).hostname or "").lower()
            proto = "tor" if host.endswith(".onion") else "https"
            items.append((net, proto, n["url"], n["url"]))

    with ThreadPoolExecutor(max_workers=10) as ex:
        futures = [ex.submit(check_one, net, proto, e, comm) for net, proto, e, comm in items]
        for f in as_completed(futures):
            net, entry = f.result()
            result[net].append(entry)

    # Update community fail_counts and auto-remove dead nodes
    for net, nodes in community.items():
        for node in nodes:
            node_url = node["url"].rstrip("/")
            match    = next(
                (r for r in result[net] if r.get("_community_url", "").rstrip("/") == node_url),
                None,
            )
            if match is not None:
                if match["ok"]:
                    node["fail_count"] = 0
                else:
                    node["fail_count"] = node.get("fail_count", 0) + 1
    for net in community:
        before         = len(community[net])
        community[net] = [n for n in community[net] if n.get("fail_count", 0) < FAIL_THRESHOLD]
        removed        = before - len(community[net])
        if removed:
            print(f"[INFO] Auto-removed {removed} dead community node(s) from {net}.")
    _save_community_nodes(community)

    # Strip internal field before returning
    for net in result:
        for entry in result[net]:
            entry.pop("_community_url", None)

    # Sort: curated nodes first (by original order), community nodes at end of each group
    for net in result:
        protos      = EXTERNAL_NODES[net]
        proto_order = {p: i for i, p in enumerate(protos)}
        entry_order = {
            (proto, urllib.parse.urlparse(e).hostname if e.startswith("http") else e): i
            for proto, entries in protos.items()
            for i, e in enumerate(entries)
        }
        result[net].sort(key=lambda e: (
            proto_order.get(e["protocol"], 999),
            entry_order.get((e["protocol"], e["host"]), 999),
        ))
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

def _http_check_tor(url, timeout=30):
    """HTTP check routed through local Tor SOCKS5 proxy. Returns (ok, status_code, response_ms)."""
    try:
        import requests as _req
    except ImportError:
        print("[WARN] tor check skipped — python3-requests not installed", file=sys.stderr)
        return False, None, 0
    proxies = {"http": "socks5h://127.0.0.1:9050", "https": "socks5h://127.0.0.1:9050"}
    t0 = time.monotonic()
    try:
        r = _req.get(url, proxies=proxies, timeout=timeout,
                     headers={"User-Agent": "grin-ecosystem-checker/1.0"})
        ms = int((time.monotonic() - t0) * 1000)
        ok = r.status_code < 500
        return ok, r.status_code, ms
    except Exception as e:
        ms = int((time.monotonic() - t0) * 1000)
        print(f"[WARN] tor check failed for {url}: {e}", file=sys.stderr)
        return False, None, ms

def _fetch_tip_height_tor(base_url, timeout=30):
    """JSON-RPC get_header via Tor SOCKS5. Returns int or None."""
    try:
        import requests as _req
    except ImportError:
        return None
    proxies = {"http": "socks5h://127.0.0.1:9050", "https": "socks5h://127.0.0.1:9050"}
    rpc_url = base_url.rstrip("/") + "/v2/foreign"
    try:
        payload = {"jsonrpc": "2.0", "method": "get_tip", "params": [], "id": 1}
        r = _req.post(rpc_url, json=payload, proxies=proxies, timeout=timeout,
                      headers={"User-Agent": "grin-ecosystem-checker/1.0"})
        data = r.json()
        result = data.get("result", {})
        if isinstance(result, dict) and "Ok" in result:
            return result["Ok"].get("height")
        print(f"[WARN] tor tip height unexpected response from {rpc_url}: {str(data)[:120]}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"[WARN] tor tip height failed for {rpc_url}: {e}", file=sys.stderr)
        return None

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
                    # All TLDs: read from DB (populated by cmd_whois via RDAP)
                    row = conn.execute(
                        "SELECT expiry_ts, registered_ts FROM dns_seed_whois WHERE host=?",
                        (reg,),
                    ).fetchone()
                    if row:
                        expiry_ts, registered_ts = row
                    # If not yet in DB, read from manual fallback (e.g. .mw ccTLD)
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
