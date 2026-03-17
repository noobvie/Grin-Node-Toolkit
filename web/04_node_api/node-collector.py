#!/usr/bin/env python3
"""
node-collector.py — Grin Node Toolkit · Node stats updater
===========================================================
Runs as root to access the Grin owner API:
  · Owner API via .api_secret  → connected peer count

Installed by script 04 (option 9 / 11) to:
    /usr/local/lib/grin-node-toolkit/node-collector.py

Called every 60 s by a cron job running as root:
    * * * * * root python3 <this file> <port> <rest_dir> <grin_data_dir>

Output file (written atomically via tmp + rename):
    {rest_dir}/node.json  — peers, updated_at

Exit codes:
    0  success (node.json written, even if peers field is missing)
    1  fatal error (rest_dir not writable, etc.)
"""

import sys
import json
import os
import pwd
import grp
import tempfile
import datetime
import urllib.request
import base64


# ── Owner API helper ──────────────────────────────────────────────────────────

def owner_rpc_call(port, method, secret_path):
    """
    Call a Grin owner API v2 JSON-RPC method on localhost.
    Reads the API secret from secret_path for HTTP basic auth.
    Returns the unwrapped Ok value, or raises RuntimeError on failure.
    """
    if os.path.isfile(secret_path):
        with open(secret_path) as fh:
            secret = fh.read().strip()
        token = base64.b64encode(f"grin:{secret}".encode()).decode()
        auth_header = {"Authorization": f"Basic {token}"}
    else:
        auth_header = {}

    payload = json.dumps({
        "jsonrpc": "2.0",
        "method":  method,
        "params":  [],
        "id":      1,
    }).encode()

    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/v2/owner",
        data=payload,
        headers={"Content-Type": "application/json", **auth_header},
    )

    with urllib.request.urlopen(req, timeout=5) as resp:
        data = json.loads(resp.read())

    result = data.get("result", {})
    if isinstance(result, dict):
        if "Ok" in result:
            return result["Ok"]
        if "Err" in result:
            raise RuntimeError(f"Node error: {result['Err']}")
    raise RuntimeError(f"Unexpected response: {data}")


# ── Atomic file writer ────────────────────────────────────────────────────────

def _www_data_ids():
    """Return (uid, gid) for www-data, or (-1, -1) if not found (leave unchanged)."""
    try:
        return pwd.getpwnam("www-data").pw_uid, grp.getgrnam("www-data").gr_gid
    except KeyError:
        return -1, -1


def write_atomic(path, obj):
    """Write a JSON object to path atomically (tmp file → os.replace).
    Output file is owned by www-data:www-data 0644 so nginx can serve it."""
    directory = os.path.dirname(path)
    fd, tmp_path = tempfile.mkstemp(dir=directory, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(obj, fh, indent=2)
            fh.write("\n")
        uid, gid = _www_data_ids()
        os.chown(tmp_path, uid, gid)  # transfer ownership to www-data before rename
        os.chmod(tmp_path, 0o644)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) != 4:
        print(
            f"Usage: {sys.argv[0]} <foreign_port> <rest_dir> <grin_data_dir>",
            file=sys.stderr,
        )
        sys.exit(1)

    port          = int(sys.argv[1])
    rest_dir      = sys.argv[2]
    grin_data_dir = sys.argv[3]

    updated_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    node_data  = {"updated_at": updated_at}

    # ── Connected peers — owner API (same port as foreign, different path) ────
    secret_path = os.path.join(grin_data_dir, ".api_secret")
    try:
        status = owner_rpc_call(port, "get_status", secret_path)
        peers  = status.get("connections")
        if peers is not None:
            node_data["peers"] = int(peers)
    except Exception:
        pass   # node not running or auth failed — field simply omitted

    # ── Write node.json ───────────────────────────────────────────────────────
    os.makedirs(rest_dir, exist_ok=True)
    write_atomic(os.path.join(rest_dir, "node.json"), node_data)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        sys.exit(1)
