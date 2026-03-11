#!/usr/bin/env python3
"""
node-collector.py — Grin Node Toolkit · Node stats updater
===========================================================
Runs as the Grin node OS user (not www-data) to access privileged data:
  · Owner API via .api_secret  → connected peer count
  · Filesystem (du)            → chain data size in MB/GB
  · grin-server.toml           → archive_mode true/false

Installed by script 04 (option 9 / 11) to:
    /usr/local/lib/grin-node-toolkit/node-collector.py

Called every 60 s by a separate cron job running as the grin node user:
    * * * * * grin python3 <this file> <port> <rest_dir> <grin_data_dir>

Output file (written atomically via tmp + rename):
    {rest_dir}/node.json  — peers, chain_size_mb, archive_mode, updated_at

All three fields are optional — omitted from the JSON if unavailable
(node not running, wrong path, permission error, etc.).

Exit codes:
    0  success (node.json written, even if some fields are missing)
    1  fatal error (rest_dir not writable, etc.)
"""

import sys
import json
import os
import tempfile
import datetime
import urllib.request
import base64
import subprocess


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


# ── Filesystem helpers ────────────────────────────────────────────────────────

def dir_size_mb(path):
    """Return total size of a directory tree in MB using du, or None on error."""
    try:
        result = subprocess.run(
            ["du", "-sb", path],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode == 0:
            size_bytes = int(result.stdout.split()[0])
            return round(size_bytes / (1024 * 1024), 1)
    except Exception:
        pass
    return None


def read_archive_mode(toml_path):
    """Parse archive_mode from grin-server.toml. Returns True/False/None."""
    try:
        with open(toml_path) as fh:
            for line in fh:
                stripped = line.strip()
                if stripped.startswith("archive_mode"):
                    val = stripped.split("=", 1)[1].strip().lower()
                    return val == "true"
    except Exception:
        pass
    return None


# ── Atomic file writer ────────────────────────────────────────────────────────

def write_atomic(path, obj):
    """Write a JSON object to path atomically (tmp file → os.replace)."""
    directory = os.path.dirname(path)
    fd, tmp_path = tempfile.mkstemp(dir=directory, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(obj, fh, indent=2)
            fh.write("\n")
        os.chmod(tmp_path, 0o644)   # ensure nginx (www-data) can read root-owned files
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

    updated_at = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
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

    # ── Chain data size ───────────────────────────────────────────────────────
    chain_dir = os.path.join(grin_data_dir, "chain_data")
    size_mb   = dir_size_mb(chain_dir if os.path.isdir(chain_dir) else grin_data_dir)
    if size_mb is not None:
        node_data["chain_size_mb"] = size_mb

    # ── Archive mode ──────────────────────────────────────────────────────────
    toml_path    = os.path.join(grin_data_dir, "grin-server.toml")
    archive_mode = read_archive_mode(toml_path)
    if archive_mode is not None:
        node_data["archive_mode"] = archive_mode

    # ── Write node.json ───────────────────────────────────────────────────────
    os.makedirs(rest_dir, exist_ok=True)
    write_atomic(os.path.join(rest_dir, "node.json"), node_data)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        sys.exit(1)
