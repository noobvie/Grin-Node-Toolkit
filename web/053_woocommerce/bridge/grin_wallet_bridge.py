"""
GrinPay — Grin Wallet Bridge (Flask)
=====================================
HTTP bridge between the WooCommerce PHP plugin and the grin-wallet CLI.

Architecture:
  WooCommerce PHP plugin  →  this Flask process (localhost:3006/3007)
                          →  grin-wallet CLI  →  local Grin node

Endpoints:
  GET  /api/status                      — health check (node, wallet, python versions)
  GET  /api/address                     — merchant Slatepack address
  POST /api/invoice                     — create Slatepack invoice for an amount
  POST /api/finalize                    — finalise a buyer's signed response slate
  GET  /api/tx_status/<tx_id>           — poll transaction confirmation status

Security:
  - Binds to 127.0.0.1 only (never 0.0.0.0).
  - Optional X-Api-Key header check (set GRINPAY_API_KEY env var to enable).
  - All shell arguments passed via list (no shell=True), preventing injection.
  - SLATE input is validated against a strict regex before use.

Configuration (environment variables):
  GRINPAY_WALLET_DIR    path to wallet data dir (default: ~/.grin/main or ~/.grin/test)
  GRINPAY_WALLET_PASS   wallet password (required for invoice/finalize)
  GRINPAY_NODE_API      node owner API URL (default: http://127.0.0.1:3413/v2/owner)
  GRINPAY_NODE_SECRET   node API secret (default: reads ~/.grin/main/.api_secret)
  GRINPAY_NETWORK       mainnet | testnet (default: mainnet)
  GRINPAY_PORT          port to listen on (default: 3006 for mainnet, 3007 for testnet)
  GRINPAY_API_KEY       shared secret for X-Api-Key auth (optional; empty = no auth)
  GRINPAY_TIMEOUT       wallet CLI timeout in seconds (default: 60)

Usage:
  python grin_wallet_bridge.py
  # or via gunicorn:
  gunicorn -w 1 -b 127.0.0.1:3006 grin_wallet_bridge:app
"""

from __future__ import annotations

import functools
import logging
import os
import platform
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request, Response

# ── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("grinpay_bridge")

# ── Configuration ─────────────────────────────────────────────────────────────

NETWORK      = os.environ.get("GRINPAY_NETWORK", "mainnet").lower()
PORT_DEFAULT = 3007 if NETWORK == "testnet" else 3006
PORT         = int(os.environ.get("GRINPAY_PORT", PORT_DEFAULT))
API_KEY      = os.environ.get("GRINPAY_API_KEY", "").strip()
CLI_TIMEOUT  = int(os.environ.get("GRINPAY_TIMEOUT", "60"))

# grin-wallet CLI binary — must be on PATH or set GRINPAY_WALLET_BIN
WALLET_BIN   = os.environ.get("GRINPAY_WALLET_BIN", "grin-wallet")

# Wallet data directory
if "GRINPAY_WALLET_DIR" in os.environ:
    WALLET_DIR = Path(os.environ["GRINPAY_WALLET_DIR"]).expanduser()
else:
    WALLET_DIR = Path.home() / ".grin" / ("test" if NETWORK == "testnet" else "main")

WALLET_PASS  = os.environ.get("GRINPAY_WALLET_PASS", "")

# Node API (for version check)
NODE_API     = os.environ.get("GRINPAY_NODE_API", "http://127.0.0.1:3413/v2/owner")
NODE_SECRET_PATH = Path.home() / ".grin" / ("test" if NETWORK == "testnet" else "main") / ".api_secret"

# ── Slatepack validation regex ────────────────────────────────────────────────

# Grin Slatepack strings are base58-encoded and start with "BEGINSLATEPACK."
# We allow a generous but bounded character set to prevent injection.
_SLATEPACK_RE = re.compile(
    r"^BEGINSLATEPACK\.[A-Za-z0-9+/=\s]{10,65000}ENDSLATEPACK\.$",
    re.DOTALL,
)

# Grin Slatepack address: bech32-like, 56-61 chars (grin1...)
_ADDRESS_RE = re.compile(r"^grin1[a-z0-9]{6,90}$")

# TX ID: UUID v4 format
_TXID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

# ── Flask app ─────────────────────────────────────────────────────────────────

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False


# ── Auth middleware ───────────────────────────────────────────────────────────

def require_api_key(f):  # type: ignore[misc]
    """Decorator: enforce X-Api-Key check when GRINPAY_API_KEY is configured."""
    @functools.wraps(f)
    def decorated(*args: Any, **kwargs: Any) -> Any:
        if API_KEY:
            provided = request.headers.get("X-Api-Key", "")
            if not provided or provided != API_KEY:
                return jsonify({"success": False, "error": "Unauthorized"}), 401
        return f(*args, **kwargs)
    return decorated


# ── Wallet CLI helper ─────────────────────────────────────────────────────────

def _wallet_args(extra: list[str]) -> list[str]:
    """
    Build grin-wallet CLI argument list.

    All arguments are passed as a list — no shell=True, no injection risk.
    """
    args = [WALLET_BIN]
    if NETWORK == "testnet":
        args += ["-e", "floonet"]
    if WALLET_DIR.exists():
        args += ["-t", str(WALLET_DIR)]
    if WALLET_PASS:
        args += ["-p", WALLET_PASS]
    args += extra
    return args


def run_wallet(extra: list[str], input_data: str | None = None) -> tuple[bool, str]:
    """
    Run grin-wallet CLI and return (success, output_or_error).

    grin-wallet uses LMDB which allows only one writer at a time, so
    concurrent calls may fail with a lock error — the caller should handle
    that and return HTTP 503 so the PHP side can retry.
    """
    cmd = _wallet_args(extra)
    log.info("wallet cmd: %s", " ".join(cmd[0:3] + ["..."]))
    try:
        result = subprocess.run(
            cmd,
            input=input_data,
            capture_output=True,
            text=True,
            timeout=CLI_TIMEOUT,
        )
        if result.returncode != 0:
            err = (result.stderr or result.stdout or "").strip()
            log.warning("wallet error (rc=%d): %s", result.returncode, err[:300])
            return False, err
        out = (result.stdout or "").strip()
        return True, out
    except subprocess.TimeoutExpired:
        log.error("wallet CLI timed out after %ds", CLI_TIMEOUT)
        return False, f"Wallet CLI timed out after {CLI_TIMEOUT}s"
    except FileNotFoundError:
        return False, f"grin-wallet binary not found: {WALLET_BIN}"
    except Exception as exc:  # pylint: disable=broad-except
        log.exception("wallet subprocess error")
        return False, str(exc)


# ── Version helpers ───────────────────────────────────────────────────────────

def _get_wallet_version() -> str:
    ok, out = run_wallet(["--version"])
    if not ok:
        return "unknown"
    # e.g. "grin-wallet 5.4.0"
    m = re.search(r"(\d+\.\d+[\.\d]*)", out)
    return m.group(1) if m else out[:30]


def _get_node_version() -> str:
    """Try to read node version via JSON-RPC to the node owner API."""
    try:
        import urllib.request
        import json

        secret = ""
        if NODE_SECRET_PATH.exists():
            secret = NODE_SECRET_PATH.read_text().strip()

        payload = json.dumps({
            "jsonrpc": "2.0",
            "method": "get_version",
            "params": [],
            "id": 1,
        }).encode()

        req = urllib.request.Request(
            NODE_API,
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        if secret:
            import base64
            creds = base64.b64encode(f"grin:{secret}".encode()).decode()
            req.add_header("Authorization", f"Basic {creds}")

        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            version = (
                data.get("result", {})
                    .get("Ok", {})
                    .get("node_version", "unknown")
            )
            return str(version)
    except Exception:  # pylint: disable=broad-except
        return "unknown"


def _parse_tx_list(output: str) -> list[dict[str, Any]]:
    """
    Parse grin-wallet txs --json output into a list of dicts.

    Falls back to empty list on parse error.
    """
    import json
    try:
        data = json.loads(output)
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and "transactions" in data:
            return data["transactions"]  # type: ignore[return-value]
    except json.JSONDecodeError:
        pass
    return []


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/api/status")
@require_api_key
def api_status() -> Response:
    """
    Health check.

    Returns wallet version, node version, python version, network, and
    whether the wallet directory exists.
    """
    wallet_version = _get_wallet_version()
    node_version   = _get_node_version()
    python_version = platform.python_version()
    wallet_ok      = WALLET_DIR.exists()

    return jsonify({
        "success":        True,
        "network":        NETWORK,
        "wallet_version": wallet_version,
        "node_version":   node_version,
        "python_version": python_version,
        "wallet_dir_ok":  wallet_ok,
    })


@app.get("/api/address")
@require_api_key
def api_address() -> Response:
    """Return the merchant's Slatepack address."""
    ok, out = run_wallet(["address"])
    if not ok:
        return jsonify({"success": False, "error": out}), 500

    # grin-wallet address output example:
    #   "Slatepack Address: grin1abc123..."
    # or simply the address on its own line.
    address = ""
    for line in out.splitlines():
        line = line.strip()
        m = re.search(r"(grin1[a-z0-9]{6,90})", line)
        if m:
            address = m.group(1)
            break

    if not address:
        return jsonify({"success": False, "error": "Could not parse address from output"}), 500

    return jsonify({"success": True, "address": address})


@app.post("/api/invoice")
@require_api_key
def api_invoice() -> Response:
    """
    Create a Slatepack invoice for a given amount.

    Request JSON:
      {
        "amount":   "12.345678",   // GRIN amount (string, 9 decimal places max)
        "order_id": "1234"          // WooCommerce order ID (for logging only)
      }

    Response JSON:
      {
        "success": true,
        "slate":   "BEGINSLATEPACK. ... ENDSLATEPACK.",
        "tx_id":   "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
      }
    """
    data = request.get_json(silent=True) or {}

    amount_raw = str(data.get("amount", "")).strip()
    order_id   = str(data.get("order_id", "")).strip()

    # Validate amount: positive float with up to 9 decimal places.
    if not re.match(r"^\d+(\.\d{1,9})?$", amount_raw) or float(amount_raw) <= 0:
        return jsonify({"success": False, "error": "Invalid amount"}), 400

    log.info("Creating invoice: amount=%s order_id=%s", amount_raw, order_id)

    # grin-wallet invoice -a <amount> --slatepack_message
    ok, out = run_wallet(["invoice", "-a", amount_raw, "--slatepack_message"])
    if not ok:
        if "lock" in out.lower():
            return jsonify({"success": False, "error": "Wallet busy, try again"}), 503
        return jsonify({"success": False, "error": out}), 500

    # Extract Slatepack from output
    slate = _extract_slatepack(out)
    if not slate:
        log.error("Could not extract Slatepack from wallet output: %s", out[:200])
        return jsonify({"success": False, "error": "Could not parse Slatepack from wallet output"}), 500

    # Extract the tx_id (Shared Transaction ID / Slate UUID) from txs list
    tx_id = _get_latest_tx_id()
    if not tx_id:
        log.warning("Could not retrieve tx_id for order %s", order_id)
        tx_id = ""

    return jsonify({"success": True, "slate": slate, "tx_id": tx_id})


@app.post("/api/finalize")
@require_api_key
def api_finalize() -> Response:
    """
    Finalise a buyer's signed Slatepack response.

    Request JSON:
      {
        "slate_response": "BEGINSLATEPACK. ... ENDSLATEPACK.",
        "order_id":       "1234"
      }

    Response JSON:
      {
        "success": true,
        "tx_id":   "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
      }
    """
    data = request.get_json(silent=True) or {}

    slate_response = str(data.get("slate_response", "")).strip()
    order_id       = str(data.get("order_id", "")).strip()

    if not slate_response:
        return jsonify({"success": False, "error": "slate_response is required"}), 400

    if not _SLATEPACK_RE.match(slate_response):
        return jsonify({"success": False, "error": "Invalid Slatepack format"}), 400

    log.info("Finalizing slate for order %s", order_id)

    # grin-wallet finalize reads the signed slate from stdin
    ok, out = run_wallet(["finalize", "--slatepack_message", "-i"], input_data=slate_response)
    if not ok:
        if "lock" in out.lower():
            return jsonify({"success": False, "error": "Wallet busy, try again"}), 503
        return jsonify({"success": False, "error": out}), 500

    # Retrieve the tx_id of the just-finalised transaction
    tx_id = _get_latest_tx_id()

    return jsonify({"success": True, "tx_id": tx_id or ""})


@app.get("/api/tx_status/<tx_id>")
@require_api_key
def api_tx_status(tx_id: str) -> Response:
    """
    Poll transaction confirmation status.

    :param tx_id:  Slate UUID stored as _grinpay_tx_id in WooCommerce order meta.

    Response JSON:
      {
        "success":       true,
        "tx_id":         "xxxxxxxx-...",
        "status":        "pending" | "confirmed" | "cancelled",
        "confirmations": 2
      }
    """
    if not _TXID_RE.match(tx_id):
        return jsonify({"success": False, "error": "Invalid tx_id format"}), 400

    ok, out = run_wallet(["txs", "--json"])
    if not ok:
        return jsonify({"success": False, "error": out}), 500

    txs = _parse_tx_list(out)

    for tx in txs:
        shared_id = str(tx.get("shared_transaction_id") or tx.get("id") or "")
        if shared_id.lower() == tx_id.lower():
            confirmed     = tx.get("confirmed", False)
            num_confirms  = int(tx.get("num_confirmations") or 0)
            tx_type       = str(tx.get("tx_type") or "").lower()
            # Cancelled if the wallet has marked it as such
            is_cancelled  = "cancel" in tx_type

            if is_cancelled:
                status = "cancelled"
            elif confirmed or num_confirms >= 1:
                status = "confirmed"
            else:
                status = "pending"

            return jsonify({
                "success":       True,
                "tx_id":         shared_id,
                "status":        status,
                "confirmations": num_confirms,
            })

    # TX not found in wallet — still pending from bridge perspective
    return jsonify({
        "success":       True,
        "tx_id":         tx_id,
        "status":        "pending",
        "confirmations": 0,
    })


# ── Internal helpers ──────────────────────────────────────────────────────────

def _extract_slatepack(output: str) -> str:
    """
    Extract a BEGINSLATEPACK...ENDSLATEPACK block from CLI output.
    """
    m = re.search(
        r"(BEGINSLATEPACK\..*?ENDSLATEPACK\.)",
        output,
        re.DOTALL,
    )
    if m:
        return m.group(1).strip()
    return ""


def _get_latest_tx_id() -> str:
    """
    Return the Shared Transaction ID (UUID) of the most recent wallet TX.

    grin-wallet assigns a UUID to each slate; this is what we store as
    _grinpay_tx_id in WooCommerce so we can poll its status later.
    """
    ok, out = run_wallet(["txs", "--json"])
    if not ok or not out:
        return ""

    txs = _parse_tx_list(out)
    if not txs:
        return ""

    # The most recently created tx is last in the list.
    latest = txs[-1]
    tx_id  = str(latest.get("shared_transaction_id") or latest.get("id") or "")
    return tx_id


# ── Error handlers ────────────────────────────────────────────────────────────

@app.errorhandler(404)
def not_found(_err: Exception) -> tuple[Response, int]:
    return jsonify({"success": False, "error": "Not found"}), 404


@app.errorhandler(405)
def method_not_allowed(_err: Exception) -> tuple[Response, int]:
    return jsonify({"success": False, "error": "Method not allowed"}), 405


@app.errorhandler(500)
def internal_error(err: Exception) -> tuple[Response, int]:
    log.exception("Unhandled exception")
    return jsonify({"success": False, "error": "Internal server error"}), 500


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    log.info(
        "GrinPay bridge starting — network=%s port=%d wallet_dir=%s",
        NETWORK, PORT, WALLET_DIR,
    )
    if not WALLET_PASS:
        log.warning(
            "GRINPAY_WALLET_PASS is not set — invoice/finalize operations will fail "
            "unless the wallet was opened with an empty password."
        )
    if not API_KEY:
        log.warning(
            "GRINPAY_API_KEY is not set — the bridge is accessible without authentication. "
            "Set this variable if the bridge is reachable from untrusted networks."
        )
    # Bind to loopback only — never expose to the network.
    app.run(host="127.0.0.1", port=PORT, debug=False)
