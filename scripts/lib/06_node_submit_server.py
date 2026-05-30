#!/usr/bin/env python3
"""
grin-node-submit
================
Tiny HTTP server that accepts community Grin node submissions and admin removals.
Nginx proxies /add-node from the stats domain to this server on 127.0.0.1:5060.
Admin removal is local-only: curl -X DELETE "http://127.0.0.1:5060/remove-node?..."

Config (env vars — loaded from /opt/grin/grin-stats/config.env by systemd):
    GRIN_COMMUNITY_NODES  path to community_nodes.json
                          default: dirname(GRIN_DB_PATH)/community_nodes.json
    GRIN_SUBMIT_PORT      listening port  (default: 5060)
    GRIN_SUBMIT_TOKEN     admin token required for DELETE /remove-node
    GRIN_DB_PATH          used to derive community_nodes path when GRIN_COMMUNITY_NODES unset
"""

import hashlib
import hmac
import json
import os
import re
import secrets as _secrets
import sys
import time
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

# ── Config ────────────────────────────────────────────────────────────────────

_db_dir = os.path.dirname(
    os.environ.get("GRIN_DB_PATH", "/opt/grin/grin-stats/stats.db")
)
COMMUNITY_NODES_PATH = os.environ.get(
    "GRIN_COMMUNITY_NODES",
    os.path.join(_db_dir, "community_nodes.json"),
)
PORT        = int(os.environ.get("GRIN_SUBMIT_PORT", "5060"))
ADMIN_TOKEN = os.environ.get("GRIN_SUBMIT_TOKEN", "")

MAX_NODES_PER_NET  = 50   # hard cap per network
RATE_LIMIT_MAX     = 2    # submissions per IP per window
RATE_LIMIT_WINDOW  = 3600 # seconds (1 hour)

# Genesis (height-0) header hash → network. This is the only reliable, permanent
# way to tell mainnet from testnet: both networks serve a fixed genesis block whose
# header hash never changes. Values from mimblewimble/grin core/src/genesis.rs.
# Headers are never pruned, so get_header(0) works even on pruned community nodes.
GENESIS_HASHES = {
    "40adad0aec27797b48840aa9e00472015c21baea118ce7a2ff1a82c0f8f5bf82": "mainnet",
    "edc758c1370d43e1d733f70f58cf187c3be8242830429b1676b89fd91ccf2dab": "testnet",
}

# Local Tor SOCKS5 proxy — used to reach .onion nodes (their Foreign API is not
# directly routable). Matches the ecosystem checker's proxy convention.
TOR_SOCKS_PROXY = "socks5h://127.0.0.1:9050"

# Challenge tokens — HMAC-SHA256 over a 15-min time window; no state needed.
# Key = ADMIN_TOKEN (set at install time). Falls back to a per-process random
# key so the endpoint still works even if the env var is missing at startup.
_CHALLENGE_KEY = (ADMIN_TOKEN or _secrets.token_hex(32)).encode()
_CHALLENGE_WINDOW = 900  # seconds per window (~15 min)

# ── State (thread-safe) ───────────────────────────────────────────────────────

_lock         = threading.Lock()
_rate_tracker = {}  # ip → [timestamp, ...]

# ── Community nodes I/O ───────────────────────────────────────────────────────

def _load_community():
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


def _save_community(data):
    os.makedirs(os.path.dirname(COMMUNITY_NODES_PATH), exist_ok=True)
    tmp = COMMUNITY_NODES_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, separators=(",", ":"))
    os.replace(tmp, COMMUNITY_NODES_PATH)

# ── Challenge tokens ─────────────────────────────────────────────────────────

def _make_challenge():
    """Return a 24-char HMAC token valid for the current 15-min window."""
    window = str(int(time.time()) // _CHALLENGE_WINDOW).encode()
    return hmac.digest(_CHALLENGE_KEY, window, hashlib.sha256).hex()[:24]


def _valid_challenge(tok):
    """Accept tokens from the current and the previous window (~30 min total)."""
    if not tok or len(tok) != 24:
        return False
    now = int(time.time())
    for w in (now // _CHALLENGE_WINDOW, now // _CHALLENGE_WINDOW - 1):
        expected = hmac.digest(_CHALLENGE_KEY, str(w).encode(), hashlib.sha256).hex()[:24]
        if hmac.compare_digest(tok, expected):
            return True
    return False

# ── Helpers ───────────────────────────────────────────────────────────────────

def _json(handler, status, body):
    raw = json.dumps(body).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(raw)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(raw)


def _rate_limited(ip):
    now = time.time()
    with _lock:
        ts = [t for t in _rate_tracker.get(ip, []) if now - t < RATE_LIMIT_WINDOW]
        if len(ts) >= RATE_LIMIT_MAX:
            return True
        ts.append(now)
        _rate_tracker[ip] = ts
    return False


def _validate_url(url):
    if not url:
        return "URL is required."
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        return "Invalid URL."
    host = (parsed.hostname or "").lower()
    is_onion = host.endswith(".onion")
    if is_onion:
        if not url.startswith("http://"):
            return "Tor (.onion) nodes must use http://"
    else:
        if not url.startswith("https://"):
            return "URL must start with https://"
        if re.match(r"^\d{1,3}(\.\d{1,3}){3}$", host):
            return "IP addresses are not allowed — use a domain name."
        if not re.match(r"^[a-zA-Z0-9._-]+\.[a-zA-Z]{2,}$", host):
            return "Invalid domain name."
    if not host or host in ("localhost", "127.0.0.1", "::1"):
        return "Local addresses are not allowed."
    return None


def _rpc_via_tor(rpc_url, payload):
    """POST a Foreign API call to an .onion node through the local Tor SOCKS5 proxy.
    Returns (data_dict_or_None, error_str_or_None)."""
    try:
        import requests as _req
    except ImportError:
        return None, "Tor support unavailable on the server."
    proxies = {"http": TOR_SOCKS_PROXY, "https": TOR_SOCKS_PROXY}
    try:
        resp = _req.post(
            rpc_url, data=payload, proxies=proxies, timeout=20,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "grin-node-submit/1.0",
            },
        )
        return resp.json(), None
    except Exception as exc:
        return None, f"Could not reach Tor node: {exc}"


def _probe_node(url):
    """Return (ok, detected_net_or_None, error_str_or_None).

    Detects the network by reading the genesis (height-0) header hash and matching
    it against GENESIS_HASHES — so the submitter never has to pick a network and can
    never pick the wrong one. .onion nodes are reached through the local Tor proxy."""
    host    = (urllib.parse.urlparse(url).hostname or "").lower()
    rpc_url = url.rstrip("/") + "/v2/foreign"
    payload = json.dumps(
        {"jsonrpc": "2.0", "method": "get_header", "params": [0, None, None], "id": 1}
    ).encode()
    try:
        if host.endswith(".onion"):
            data, err = _rpc_via_tor(rpc_url, payload)
            if err:
                return False, None, err
        else:
            req = urllib.request.Request(
                rpc_url, data=payload,
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": "grin-node-submit/1.0",
                },
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return False, None, f"Node returned HTTP {exc.code}."
    except Exception as exc:
        return False, None, f"Could not reach node: {exc}"

    r = data.get("result", {})
    if isinstance(r, dict) and "Ok" in r:
        genesis_hash = (r["Ok"].get("hash") or "").lower()
        net = GENESIS_HASHES.get(genesis_hash)
        if net:
            return True, net, None
        return False, None, "Reachable, but not a recognised Grin mainnet or testnet node."
    return False, None, "Node responded but returned unexpected data."

# ── Request handler ───────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        pass  # route access log through print() only on notable events

    def _ip(self):
        forwarded = self.headers.get("X-Real-IP") or self.headers.get("X-Forwarded-For", "")
        return forwarded.split(",")[0].strip() or self.address_string()

    # ── OPTIONS (CORS preflight) ──────────────────────────────────────────────
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    # ── GET /submit-token ─────────────────────────────────────────────────────
    def do_GET(self):
        if self.path == "/submit-token":
            _json(self, 200, {"token": _make_challenge()})
            return
        _json(self, 404, {"ok": False, "message": "Not found."})

    # ── POST /add-node ────────────────────────────────────────────────────────
    def do_POST(self):
        if self.path != "/add-node":
            _json(self, 404, {"ok": False, "message": "Not found."})
            return

        ip = self._ip()
        if _rate_limited(ip):
            _json(self, 429, {"ok": False, "message": "Too many submissions — try again in an hour."})
            return

        length = int(self.headers.get("Content-Length", 0))
        if length > 2048:
            _json(self, 413, {"ok": False, "message": "Request body too large."})
            return
        body   = self.rfile.read(length).decode("utf-8", errors="replace")
        params = dict(urllib.parse.parse_qsl(body))

        # Honeypot — bots often fill every field; humans never see this one.
        # Return a fake success so bots don't know they were filtered.
        if params.get("website", ""):
            _json(self, 200, {"ok": True,
                "message": "Node submitted! It will appear after the next hourly ecosystem check."})
            return

        if not _valid_challenge(params.get("submit_token", "")):
            _json(self, 400, {"ok": False,
                "message": "Invalid or expired submission token — please try again."})
            return

        url = params.get("node_url", "").strip().rstrip("/")

        err = _validate_url(url)
        if err:
            _json(self, 400, {"ok": False, "message": err})
            return

        # Probe before taking the lock (network I/O can be slow). The probe also
        # determines the network from the genesis hash — the submitter does not choose.
        ok, net, probe_err = _probe_node(url)
        if not ok:
            _json(self, 400, {"ok": False, "message": f"Node rejected — {probe_err}"})
            return

        with _lock:
            data = _load_community()
            # A node belongs to exactly one network; guard against duplicates on either.
            existing = {n["url"].rstrip("/").lower()
                        for lst in data.values() for n in lst}
            if url.lower() in existing:
                _json(self, 409, {"ok": False, "message": "This node is already listed on the community list."})
                return
            if len(data[net]) >= MAX_NODES_PER_NET:
                _json(self, 429, {"ok": False,
                    "message": f"Community list is full ({MAX_NODES_PER_NET} nodes). Contact the admin."})
                return
            data[net].append({
                "url":          url,
                "submitted_ts": int(time.time()),
                "fail_count":   0,
            })
            _save_community(data)

        print(f"[SUBMIT] {net} (auto-detected) {url} from {ip}", flush=True)
        _json(self, 200, {"ok": True,
            "message": f"Node submitted as {net} (detected automatically). "
                       "It will appear after the next hourly ecosystem check."})

    # ── DELETE /remove-node ───────────────────────────────────────────────────
    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/remove-node":
            _json(self, 404, {"ok": False, "message": "Not found."})
            return

        params = dict(urllib.parse.parse_qsl(parsed.query))
        token  = params.get("token", "")
        url    = params.get("url",   "").strip().rstrip("/")

        if not ADMIN_TOKEN or token != ADMIN_TOKEN:
            _json(self, 403, {"ok": False, "message": "Forbidden."})
            return
        if not url:
            _json(self, 400, {"ok": False, "message": "url param required."})
            return

        with _lock:
            data    = _load_community()
            removed = False
            for net in ("mainnet", "testnet"):
                before    = len(data[net])
                data[net] = [n for n in data[net] if n["url"].rstrip("/") != url]
                if len(data[net]) < before:
                    removed = True
            if removed:
                _save_community(data)
                print(f"[REMOVE] {url}", flush=True)
                _json(self, 200, {"ok": True, "message": "Node removed."})
            else:
                _json(self, 404, {"ok": False, "message": "Node not found in community list."})

# ── Server ────────────────────────────────────────────────────────────────────

class ThreadedServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def main():
    if not ADMIN_TOKEN:
        print("[WARN] GRIN_SUBMIT_TOKEN not set — DELETE /remove-node is disabled.", file=sys.stderr)
    server = ThreadedServer(("127.0.0.1", PORT), Handler)
    print(f"[OK] grin-node-submit listening on 127.0.0.1:{PORT}", flush=True)
    print(f"[OK] community_nodes → {COMMUNITY_NODES_PATH}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[OK] Stopped.", flush=True)


if __name__ == "__main__":
    main()
