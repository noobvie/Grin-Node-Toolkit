#!/usr/bin/env python3
"""
rest-collector.py — Grin Node Toolkit · REST API updater
=========================================================
Queries the Grin node foreign API (locally; Basic Auth injected automatically
if .foreign_api_secret is present) and writes
static JSON files that nginx serves as a lightweight REST API.

Installed by script 04 (option 9 / 11) to:
    /usr/local/lib/grin-node-toolkit/rest-collector.py

Called every 60 s by a cron job running as www-data:
    * * * * * www-data python3 <this file> <port> <rest_dir> [foreign_secret_path]

Output files (written atomically via tmp + rename):
    {rest_dir}/stats.json       — full snapshot: height, supply, difficulty, hash, versions
    {rest_dir}/supply.json      — circulating supply only
    {rest_dir}/height.json      — block height only
    {rest_dir}/difficulty.json  — total difficulty only
    {rest_dir}/emission.json    — emission schedule (static values, no node call needed)

Exit codes:
    0  success
    1  RPC error (node unreachable, bad response, etc.)
"""

import sys
import json
import math
import os
import base64
import tempfile
import datetime
import urllib.request


# ── RPC helpers ───────────────────────────────────────────────────────────────

def rpc_call(port, method, secret_path=None):
    """
    Call a Grin foreign API v2 JSON-RPC method on localhost.
    If secret_path is provided and the file exists, adds HTTP Basic Auth
    (script 01 creates .foreign_api_secret and enables auth on the foreign API).
    Returns the unwrapped Ok value, or raises RuntimeError on failure.
    """
    payload = json.dumps({
        "jsonrpc": "2.0",
        "method":  method,
        "params":  [],
        "id":      1,
    }).encode()

    headers = {"Content-Type": "application/json"}
    if secret_path and os.path.isfile(secret_path):
        with open(secret_path) as fh:
            secret = fh.read().strip()
        token = base64.b64encode(f"grin:{secret}".encode()).decode()
        headers["Authorization"] = f"Basic {token}"

    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/v2/foreign",
        data=payload,
        headers=headers,
    )

    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())

    result = data.get("result", {})
    if isinstance(result, dict):
        if "Ok" in result:
            return result["Ok"]
        if "Err" in result:
            raise RuntimeError(f"Node error: {result['Err']}")
    raise RuntimeError(f"Unexpected response: {data}")


# ── Atomic file writer ────────────────────────────────────────────────────────

def write_atomic(path, obj):
    """
    Write a JSON object to path atomically (temp file → os.replace).
    Prevents nginx from ever serving a half-written file.
    """
    directory = os.path.dirname(path)
    fd, tmp_path = tempfile.mkstemp(dir=directory, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(obj, fh, indent=2)
            fh.write("\n")
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <port> <rest_dir> [foreign_secret_path]", file=sys.stderr)
        sys.exit(1)

    port        = int(sys.argv[1])
    rest_dir    = sys.argv[2]
    secret_path = sys.argv[3] if len(sys.argv) >= 4 else None

    # Fetch live data from the node foreign API.
    # Basic Auth is injected automatically if a .foreign_api_secret file is present.
    tip = rpc_call(port, "get_tip",     secret_path)
    ver = rpc_call(port, "get_version", secret_path)

    height     = int(tip["height"])
    supply     = height * 60          # 1 GRIN/s · 60 s/block
    difficulty = int(tip["total_difficulty"])
    block_hash = tip["last_block_pushed"]
    node_ver   = ver.get("node_version", "")
    hdr_ver    = ver.get("block_header_version", 0)
    updated_at = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    os.makedirs(rest_dir, exist_ok=True)

    # stats.json — full snapshot, most useful for integrations
    write_atomic(os.path.join(rest_dir, "stats.json"), {
        "height":         height,
        "supply":         supply,
        "difficulty":     difficulty,
        "hash":           block_hash,
        "node_version":   node_ver,
        "header_version": hdr_ver,
        "updated_at":     updated_at,
    })

    # supply.json — circulating supply only
    write_atomic(os.path.join(rest_dir, "supply.json"), {
        "supply":     supply,
        "unit":       "GRIN",
        "formula":    "height × 60  (1 GRIN/s · 60 s/block · no max supply)",
        "updated_at": updated_at,
    })

    # height.json — block height only
    write_atomic(os.path.join(rest_dir, "height.json"), {
        "height":     height,
        "updated_at": updated_at,
    })

    # difficulty.json — total difficulty only
    write_atomic(os.path.join(rest_dir, "difficulty.json"), {
        "difficulty": difficulty,
        "updated_at": updated_at,
    })

    # emission.json — static schedule, no node call needed
    write_atomic(os.path.join(rest_dir, "emission.json"), {
        "per_second": 1,
        "per_block":  60,
        "per_day":    86400,
        "per_year":   31536000,
        "unit":       "GRIN",
        "max_supply": None,
        "note":       "Grin has no maximum supply — emission is constant and infinite",
    })


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        sys.exit(1)
