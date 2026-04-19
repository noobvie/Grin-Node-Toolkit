"""
GrinPay — Grin Wallet Bridge (Flask)
=====================================
HTTP bridge between the WooCommerce PHP plugin and the grin-wallet owner_api.

Architecture:
  WooCommerce PHP plugin  →  this Flask process (localhost:3006/3007)
                          →  grin-wallet owner_api (localhost:3420/13420)
                          →  local Grin node

The bridge talks to a running grin-wallet daemon via its owner_api JSON-RPC
interface.  No CLI subprocess spawning, no password file on disk.

Endpoints:
  GET  /api/status                      — health check (versions, network)
  GET  /api/address                     — merchant Slatepack address
  POST /api/invoice                     — create Slatepack invoice
  POST /api/finalize                    — finalise buyer's signed response
  GET  /api/tx_status/<tx_id>           — poll transaction confirmation status

Security:
  - Bridge binds to 127.0.0.1 only.
  - Optional X-Api-Key header check (set GRINPAY_API_KEY env var).
  - Slatepack input validated before use.
  - Wallet session token kept in-process memory only — never written to disk.

Wallet daemon prerequisite:
  The grin-wallet owner_api daemon must be running before this bridge starts.
  Start it with: grin-wallet [-e floonet] owner_api
  Default ports: mainnet=3420, testnet=13420

Configuration (environment variables):
  GRINPAY_NETWORK           mainnet | testnet  (default: mainnet)
  GRINPAY_PORT              bridge listen port (default: 3006/3007)
  GRINPAY_API_KEY           shared secret for X-Api-Key auth (optional)
  GRINPAY_OWNER_API_URL     owner_api base URL (default: auto from network)
  GRINPAY_WALLET_PASS       wallet password for open_wallet (default: empty)
  GRINPAY_TIMEOUT           HTTP timeout in seconds (default: 30)

Usage:
  python grin_wallet_bridge.py
  gunicorn -w 1 -b 127.0.0.1:3006 grin_wallet_bridge:app
"""

from __future__ import annotations

import functools
import hmac
import json
import logging
import os
import platform
import re
import urllib.error
import urllib.request
from decimal import Decimal, ROUND_DOWN
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ec import (
    ECDH,
    SECP256K1,
    EllipticCurvePublicKey,
    generate_private_key,
)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives import serialization
from flask import Flask, Response, jsonify, request

# ── Logging ───────────────────────────────────────────────────────────────────

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
WALLET_PASS  = os.environ.get("GRINPAY_WALLET_PASS", "")
TIMEOUT      = int(os.environ.get("GRINPAY_TIMEOUT", "30"))

_owner_api_default_port = 13420 if NETWORK == "testnet" else 3420
OWNER_API_URL = os.environ.get(
    "GRINPAY_OWNER_API_URL",
    f"http://127.0.0.1:{_owner_api_default_port}/v2/owner",
)

# ── Validation patterns ───────────────────────────────────────────────────────

_SLATEPACK_RE = re.compile(
    r"^BEGINSLATEPACK\.[A-Za-z0-9+/=\s]{10,65000}ENDSLATEPACK\.$",
    re.DOTALL,
)
_TXID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

# ── Flask app ─────────────────────────────────────────────────────────────────

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False

# ── In-memory session token (never persisted to disk) ─────────────────────────

_wallet_token: str | None = None

# ── Auth middleware ───────────────────────────────────────────────────────────

def require_api_key(f):  # type: ignore[misc]
    """Enforce X-Api-Key check when GRINPAY_API_KEY is set."""
    @functools.wraps(f)
    def decorated(*args: Any, **kwargs: Any) -> Any:
        if API_KEY:
            provided = request.headers.get("X-Api-Key", "")
            # Constant-time comparison prevents timing-based key enumeration.
            if not provided or not hmac.compare_digest(provided, API_KEY):
                return jsonify({"success": False, "error": "Unauthorized"}), 401
        return f(*args, **kwargs)
    return decorated

# ── owner_api JSON-RPC client ─────────────────────────────────────────────────

def _owner_rpc(method: str, params: dict[str, Any]) -> Any:
    """
    Raw JSON-RPC 2.0 POST to OWNER_API_URL.

    Raises:
      ConnectionError   if the wallet daemon is not reachable.
      RuntimeError      if the owner_api returns an error result.
    """
    payload = json.dumps({
        "jsonrpc": "2.0",
        "method":  method,
        "params":  params,
        "id":      1,
    }).encode()

    req = urllib.request.Request(
        OWNER_API_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
    )

    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.URLError as exc:
        raise ConnectionError(
            f"grin-wallet owner_api not reachable at {OWNER_API_URL}. "
            f"Start it with: grin-wallet owner_api  ({exc})"
        ) from exc

    if data.get("error"):
        raise RuntimeError(f"owner_api RPC error [{method}]: {data['error']}")

    result = data.get("result", {})
    if isinstance(result, dict) and "Err" in result:
        raise RuntimeError(f"owner_api error [{method}]: {result['Err']}")

    return result.get("Ok", result) if isinstance(result, dict) else result


def _open_wallet() -> str:
    """
    Perform ECDH handshake and open_wallet against the running wallet daemon.

    Returns a session token held in process memory only.
    GRINPAY_WALLET_PASS is used for wallets protected by a password.
    For testnet wallets initialised with an empty password, leave the
    env var unset (defaults to empty string).
    """
    # 1. Ephemeral client keypair (secp256k1)
    private_key  = generate_private_key(SECP256K1())
    client_pubkey = private_key.public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.CompressedPoint,
    )

    # 2. init_secure_api → server's compressed pubkey as hex string
    server_pubkey_hex: str = _owner_rpc(
        "init_secure_api", {"ecdh_pubkey": client_pubkey.hex()}
    )

    # 3. ECDH → 32-byte shared secret (x-coordinate of shared EC point)
    server_pubkey = EllipticCurvePublicKey.from_encoded_point(
        SECP256K1(), bytes.fromhex(server_pubkey_hex)
    )
    shared_key: bytes = private_key.exchange(ECDH(), server_pubkey)

    # 4. Encrypt wallet password with AES-256-GCM
    nonce           = os.urandom(12)
    aesgcm          = AESGCM(shared_key)
    ciphertext_tag  = aesgcm.encrypt(nonce, WALLET_PASS.encode("utf-8"), None)

    # 5. open_wallet → session token
    token: str = _owner_rpc("open_wallet", {
        "name":     None,
        "password": {
            "nonce":    nonce.hex(),
            "body_enc": ciphertext_tag.hex(),
        },
    })

    log.info("Wallet opened — session token cached in memory.")
    return token


def _call(method: str, params: dict[str, Any]) -> Any:
    """
    Call a token-gated owner_api method.
    Opens the wallet automatically on first call and re-opens on token expiry.
    """
    global _wallet_token

    if _wallet_token is None:
        _wallet_token = _open_wallet()

    try:
        return _owner_rpc(method, {"token": _wallet_token, **params})
    except RuntimeError as exc:
        err_lower = str(exc).lower()
        if "not opened" in err_lower or "invalid token" in err_lower or "token" in err_lower:
            log.info("Token invalid — re-opening wallet session.")
            _wallet_token = _open_wallet()
            return _owner_rpc(method, {"token": _wallet_token, **params})
        raise

# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/api/status")
@require_api_key
def api_status() -> Response:
    """
    Health check.  Calls get_version() (no token needed) to confirm the wallet
    daemon is reachable, then adds Python and network metadata.
    """
    try:
        version_info = _owner_rpc("get_version", {})
    except ConnectionError as exc:
        return jsonify({"success": False, "error": str(exc)}), 503
    except Exception as exc:  # pylint: disable=broad-except
        return jsonify({"success": False, "error": str(exc)}), 500

    v = version_info if isinstance(version_info, dict) else {}
    return jsonify({
        "success":        True,
        "network":        NETWORK,
        "wallet_version": v.get("version", "unknown"),
        "node_version":   v.get("node_version", "unknown"),
        "python_version": platform.python_version(),
    })


@app.get("/api/address")
@require_api_key
def api_address() -> Response:
    """Return the merchant's Slatepack address."""
    try:
        result = _call("get_slatepack_address", {"derivation_index": 0})
    except ConnectionError as exc:
        return jsonify({"success": False, "error": str(exc)}), 503
    except Exception as exc:  # pylint: disable=broad-except
        log.exception("address error")
        return jsonify({"success": False, "error": str(exc)}), 500

    address = result if isinstance(result, str) else (
        result.get("slatepack_address", "") if isinstance(result, dict) else ""
    )
    if not address:
        return jsonify({"success": False, "error": "Could not retrieve wallet address"}), 500

    return jsonify({"success": True, "address": address})


@app.post("/api/invoice")
@require_api_key
def api_invoice() -> Response:
    """
    Create a Slatepack invoice.

    Request JSON:
      {"amount": "1.5", "order_id": "123"}

    Response JSON:
      {"success": true, "slate": "BEGINSLATEPACK...", "tx_id": "uuid"}

    Amount is in GRIN (decimal string). Converted to nanogrins internally.
    """
    data       = request.get_json(silent=True) or {}
    amount_str = str(data.get("amount", "")).strip()
    order_id   = str(data.get("order_id", "")).strip()

    if not re.match(r"^\d+(\.\d{1,9})?$", amount_str) or float(amount_str) <= 0:
        return jsonify({"success": False, "error": "Invalid amount"}), 400

    # Convert GRIN → nanogrins using Decimal to avoid IEEE 754 float rounding.
    # e.g. float("0.1") * 1e9 = 99999999 on some platforms; Decimal is exact.
    amount_ng = int(Decimal(amount_str).quantize(Decimal("0.000000001"), rounding=ROUND_DOWN) * 1_000_000_000)
    log.info("Creating invoice: %s GRIN (%d ng) order=%s", amount_str, amount_ng, order_id)

    try:
        # Step 1 — create invoice slate
        slate: dict = _call("issue_invoice_tx", {
            "args": {
                "amount":               amount_ng,
                "message":              f"Order {order_id}" if order_id else None,
                "dest_acct_name":       None,
                "target_slate_version": None,
            }
        })

        # Step 2 — encode slate as Slatepack string
        slatepack: str = _call("encode_slatepack_message", {
            "slate":      slate,
            "recipients": [],
        })

        # Extract Slate UUID for order mapping
        tx_id = ""
        if isinstance(slate, dict):
            tx_id = str(slate.get("id") or slate.get("tx_slate_id") or "")

    except ConnectionError as exc:
        return jsonify({"success": False, "error": str(exc)}), 503
    except Exception as exc:  # pylint: disable=broad-except
        log.exception("invoice error")
        return jsonify({"success": False, "error": str(exc)}), 500

    return jsonify({"success": True, "slate": slatepack, "tx_id": tx_id})


@app.post("/api/finalize")
@require_api_key
def api_finalize() -> Response:
    """
    Finalise a buyer's signed Slatepack response and broadcast to the network.

    Request JSON:
      {"slate_response": "BEGINSLATEPACK...", "order_id": "123"}

    Response JSON:
      {"success": true, "tx_id": "uuid"}
    """
    data           = request.get_json(silent=True) or {}
    slate_response = str(data.get("slate_response", "")).strip()
    order_id       = str(data.get("order_id", "")).strip()

    if not slate_response:
        return jsonify({"success": False, "error": "slate_response is required"}), 400
    if not _SLATEPACK_RE.match(slate_response):
        return jsonify({"success": False, "error": "Invalid Slatepack format"}), 400

    log.info("Finalizing slate for order %s", order_id)

    try:
        # Step 1 — decode buyer's Slatepack response → slate object
        signed_slate: dict = _call("decode_slatepack_message", {
            "message": slate_response,
        })

        # Step 2 — finalise transaction
        finalized_slate: dict = _call("finalize_tx", {
            "slate": signed_slate,
        })

        # Step 3 — broadcast to network
        tx = finalized_slate.get("tx") if isinstance(finalized_slate, dict) else None
        if tx is None:
            raise RuntimeError(
                "finalize_tx returned no 'tx' field — cannot broadcast. "
                "Slate may be malformed or wallet version mismatch."
            )
        _call("post_tx", {"tx": tx, "fluff": False})

        # Extract Slate UUID
        tx_id = ""
        if isinstance(finalized_slate, dict):
            tx_id = str(finalized_slate.get("id") or finalized_slate.get("tx_slate_id") or "")

    except ConnectionError as exc:
        return jsonify({"success": False, "error": str(exc)}), 503
    except Exception as exc:  # pylint: disable=broad-except
        log.exception("finalize error")
        return jsonify({"success": False, "error": str(exc)}), 500

    return jsonify({"success": True, "tx_id": tx_id})


@app.get("/api/tx_status/<tx_id>")
@require_api_key
def api_tx_status(tx_id: str) -> Response:
    """
    Poll transaction confirmation status by Slate UUID.

    Response JSON:
      {"success": true, "tx_id": "...", "status": "pending|confirmed|cancelled",
       "confirmations": 2}
    """
    if not _TXID_RE.match(tx_id):
        return jsonify({"success": False, "error": "Invalid tx_id format"}), 400

    try:
        txs = _call("retrieve_txs", {
            "refresh_from_node": False,
            "tx_id":             None,
            "tx_slate_id":       tx_id,
        })
    except ConnectionError as exc:
        return jsonify({"success": False, "error": str(exc)}), 503
    except Exception as exc:  # pylint: disable=broad-except
        return jsonify({"success": False, "error": str(exc)}), 500

    if not txs:
        return jsonify({
            "success":       True,
            "tx_id":         tx_id,
            "status":        "pending",
            "confirmations": 0,
        })

    tx = txs[0] if isinstance(txs, list) else txs
    if not isinstance(tx, dict):
        return jsonify({
            "success":       True,
            "tx_id":         tx_id,
            "status":        "pending",
            "confirmations": 0,
        })

    confirmed    = bool(tx.get("confirmed", False))
    num_confirms = int(tx.get("num_confirmations") or 0)
    tx_type      = str(tx.get("tx_type") or "").lower()
    is_cancelled = "cancel" in tx_type

    if is_cancelled:
        status = "cancelled"
    elif confirmed or num_confirms >= 1:
        status = "confirmed"
    else:
        status = "pending"

    return jsonify({
        "success":       True,
        "tx_id":         tx_id,
        "status":        status,
        "confirmations": num_confirms,
    })


# ── Error handlers ────────────────────────────────────────────────────────────

@app.errorhandler(404)
def not_found(_err: Exception) -> tuple[Response, int]:
    return jsonify({"success": False, "error": "Not found"}), 404

@app.errorhandler(405)
def method_not_allowed(_err: Exception) -> tuple[Response, int]:
    return jsonify({"success": False, "error": "Method not allowed"}), 405

@app.errorhandler(500)
def internal_error(_err: Exception) -> tuple[Response, int]:
    log.exception("Unhandled exception")
    return jsonify({"success": False, "error": "Internal server error"}), 500

# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    log.info(
        "GrinPay bridge starting — network=%s port=%d owner_api=%s",
        NETWORK, PORT, OWNER_API_URL,
    )
    if not WALLET_PASS:
        log.info(
            "GRINPAY_WALLET_PASS not set — will use empty password for open_wallet. "
            "Set this env var if your wallet was initialised with a password."
        )
    if not API_KEY:
        log.warning(
            "GRINPAY_API_KEY not set — bridge accessible without authentication."
        )
    app.run(host="127.0.0.1", port=PORT, debug=False)
