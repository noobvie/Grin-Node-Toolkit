"""
app_faucet.py — Grin Testnet Faucet — Flask application
=========================================================

Endpoints:
  GET  /api/status          public stats + next_claim_at for ?addr=
  GET  /api/qr              PNG QR code for faucet wallet address
  POST /api/claim           {grin_address} → {claim_id, slatepack, expires_at}
  POST /api/finalize        {claim_id, response_slate} → {status, tx_slate_id}

Activity log: /opt/grin/logs/grin-faucet-activity.log
"""

import io
import logging
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone

from flask import Flask, jsonify, request, send_file, abort

import config_faucet as cfg_mod
import db_faucet as db
import wallet_faucet as w

# ── App setup ─────────────────────────────────────────────────────────────────

app = Flask(__name__, static_folder=None)
app.config["JSON_SORT_KEYS"] = False

_cfg = cfg_mod.load()

# ── Activity logger ───────────────────────────────────────────────────────────

def _setup_logger():
    log_path = _cfg.get("log_path", "/opt/grin/logs/grin-faucet-activity.log")
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    handler = logging.FileHandler(log_path)
    handler.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)-5s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    ))
    logger = logging.getLogger("faucet")
    logger.setLevel(logging.DEBUG)
    logger.addHandler(handler)
    return logger


log = _setup_logger()


def _truncate_addr(addr: str) -> str:
    """Show first 6 + last 4 chars for privacy in logs."""
    return addr[:6] + "..." + addr[-4:] if len(addr) > 12 else addr


# ── Timeout background thread ─────────────────────────────────────────────────

def _timeout_worker():
    """Cancel expired waiting_finalize claims every 30 seconds."""
    while True:
        time.sleep(30)
        try:
            expired = db.get_expired_claims()
            for claim in expired:
                db.cancel_expired(claim["id"])
                log.warning(
                    "TIMEOUT      claim_id=%s  addr=%s  (cancelled)",
                    claim["id"], _truncate_addr(claim["grin_address"]),
                )
        except Exception as exc:
            log.error("TIMEOUT_CHECK_ERROR  err=%s", exc)


_t = threading.Thread(target=_timeout_worker, daemon=True)
_t.start()

# ── DB init ───────────────────────────────────────────────────────────────────

db.init_db()

# ── Helpers ───────────────────────────────────────────────────────────────────

def _reload_cfg():
    global _cfg
    _cfg = cfg_mod.load()


def _next_claim_iso(grin_address: str) -> str | None:
    """Return ISO timestamp of next allowed claim, or None if available now."""
    last = db.last_confirmed_claim(grin_address)
    if not last:
        return None
    window_h = _cfg.get("claim_window_hours", 24)
    created = datetime.fromisoformat(last["created_at"])
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    next_allowed = created + timedelta(hours=window_h)
    now = datetime.now(timezone.utc)
    if now >= next_allowed:
        return None
    return next_allowed.isoformat(timespec="seconds")


def _err(msg: str, code: int = 400):
    return jsonify({"error": msg}), code


# ── GET /api/status ───────────────────────────────────────────────────────────

@app.get("/api/status")
def api_status():
    _reload_cfg()
    addr_param = request.args.get("addr", "")

    balance = 0.0
    try:
        balance = w.get_balance(_cfg)
    except Exception as exc:
        log.error("WALLET_FAIL  cmd=info  err=%s", exc)

    payload = {
        "faucet_name":    _cfg.get("faucet_name", "Grin Testnet Faucet"),
        "claim_amount":   _cfg.get("claim_amount_grin", 2.0),
        "wallet_address": _cfg.get("wallet_address", ""),
        "wallet_balance": round(balance, 9),
        "claims_today":   db.count_claims_today(),
        "claims_total":   db.count_claims_total(),
        "next_claim_at":  None,
    }
    if addr_param:
        payload["next_claim_at"] = _next_claim_iso(addr_param)

    return jsonify(payload)


# ── GET /api/qr ───────────────────────────────────────────────────────────────

@app.get("/api/qr")
def api_qr():
    _reload_cfg()
    address = _cfg.get("wallet_address", "")
    if not address:
        abort(404)

    import qrcode
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=6, border=2)
    qr.add_data(address)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return send_file(buf, mimetype="image/png", max_age=3600)


# ── POST /api/claim ───────────────────────────────────────────────────────────

@app.post("/api/claim")
def api_claim():
    _reload_cfg()
    body = request.get_json(silent=True) or {}
    grin_address = (body.get("grin_address") or "").strip()

    if not grin_address:
        return _err("grin_address is required")
    if not re.match(r"^(grin1|tgrin1)[a-z0-9]{40,}$", grin_address):
        return _err("Invalid grin address — expected grin1... or tgrin1... (52+ chars)")

    # Rate-limit check + claim creation are combined atomically via DB unique constraint.
    # We pre-check here for a friendly error message; the DB insert will also enforce it.
    next_at = _next_claim_iso(grin_address)
    if next_at:
        log.warning(
            "RATE_LIMIT   addr=%s  next_claim=%s",
            _truncate_addr(grin_address), next_at,
        )
        return _err(f"Already claimed. Next claim available at {next_at}", 429)

    amount = float(_cfg.get("claim_amount_grin", 2.0))
    timeout_min = int(_cfg.get("finalize_timeout_min", 5))

    claim_id = db.create_claim(grin_address, amount, timeout_min)
    log.info("CLAIM_INIT   addr=%s  claim_id=%s", _truncate_addr(grin_address), claim_id)

    try:
        slatepack, tx_id = w.init_send(_cfg, grin_address, amount)
    except Exception as exc:
        db.set_status(claim_id, "failed")
        log.error("WALLET_FAIL  cmd=send  claim_id=%s  err=%s", claim_id, exc)
        return _err(f"Wallet error: {exc}", 500)

    db.set_slatepack_out(claim_id, slatepack)
    log.info(
        "SLATEPACK_OK claim_id=%s  tx_id=%s",
        claim_id, tx_id or "(pending)",
    )

    return jsonify({
        "claim_id":   claim_id,
        "slatepack":  slatepack,
        "amount":     amount,
        "expires_at": db.get_claim(claim_id)["expires_at"],
    })


# ── POST /api/finalize ────────────────────────────────────────────────────────

@app.post("/api/finalize")
def api_finalize():
    _reload_cfg()
    body = request.get_json(silent=True) or {}
    claim_id = body.get("claim_id")
    response_slate = (body.get("response_slate") or "").strip()

    if not claim_id or not response_slate:
        return _err("claim_id and response_slate are required")

    try:
        claim_id = int(claim_id)
    except (TypeError, ValueError):
        return _err("claim_id must be an integer")

    claim = db.get_claim(claim_id)
    if not claim:
        return _err("Claim not found", 404)
    if claim["status"] == "confirmed":
        return jsonify({"status": "confirmed", "tx_slate_id": claim.get("tx_slate_id", "")})
    if claim["status"] == "cancelled":
        return _err("Claim expired — please start a new claim", 410)
    if claim["status"] not in ("waiting_finalize", "pending"):
        return _err(f"Claim is in state '{claim['status']}'", 409)

    # Check not expired
    expires = datetime.fromisoformat(claim["expires_at"])
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) > expires:
        db.cancel_expired(claim_id)
        log.warning("TIMEOUT      claim_id=%s  (expired on finalize attempt)", claim_id)
        return _err("Claim expired — please start a new claim", 410)

    log.info("FINALIZE_ATTEMPT  claim_id=%s", claim_id)

    try:
        tx_id = w.finalize(_cfg, response_slate)
    except Exception as exc:
        log.error("WALLET_FAIL  cmd=finalize  claim_id=%s  err=%s", claim_id, exc)
        return _err(f"Wallet error: {exc}", 500)

    db.set_finalized(claim_id, response_slate, tx_id or "")
    log.info(
        "FINALIZE_OK  claim_id=%s  tx_slate_id=%s",
        claim_id, tx_id or "(unknown)",
    )
    log.info(
        "CONFIRMED    claim_id=%s  amount=%s GRIN",
        claim_id, claim["amount"],
    )

    return jsonify({
        "status":       "confirmed",
        "tx_slate_id":  tx_id or "",
        "amount":       claim["amount"],
        "message":      "Transaction submitted — confirmed after ~10 blocks (~10 min)",
    })


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(_cfg.get("service_port", 3004))
    app.run(host="127.0.0.1", port=port, debug=False)
