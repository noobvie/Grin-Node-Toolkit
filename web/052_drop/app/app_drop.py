"""
app_drop.py — Grin Drop — Flask application
============================================

Public endpoints:
  GET  /api/status          public stats + next_claim_at for ?addr=
  GET  /api/public-stats    total given/received, claim counts, donation count
  GET  /api/qr              PNG QR code for drop wallet address
  POST /api/claim           {grin_address} → {claim_id, slatepack, expires_at}
  POST /api/finalize        {claim_id, response_slate} → {status, tx_slate_id}
  GET  /robots.txt          plaintext robots file

Admin endpoints (all under /<admin_secret_path>/):
  GET  /<secret>/                        dashboard
  GET  /<secret>/transactions            paginated claim list
  GET  /<secret>/donations               donations list
  GET  /<secret>/settings                settings form
  POST /<secret>/settings                save settings
  POST /<secret>/api/maintenance         toggle maintenance mode
  POST /<secret>/api/add-donation        record a donation
  GET  /<secret>/export/claims.csv       CSV export

Activity log: /opt/grin/drop-<net>/drop-activity.log
"""

import csv
import io
import logging
import os
import re
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone

from flask import (
    Flask, abort, jsonify, make_response, render_template,
    request, send_file
)

import config_drop as cfg_mod
import db_drop as db
import wallet_drop as w

# ── App setup ─────────────────────────────────────────────────────────────────

app = Flask(__name__, static_folder=None, template_folder="templates")
app.config["JSON_SORT_KEYS"] = False
app.config["SECRET_KEY"] = secrets.token_hex(32)

_cfg = cfg_mod.load()

# Ephemeral CSRF token — regenerated each process restart
_CSRF_TOKEN = secrets.token_hex(16)


def _csrf_ok() -> bool:
    """Validate CSRF token from POST body or X-CSRF-Token header."""
    token = (
        request.json.get("_csrf") if request.is_json else
        request.form.get("_csrf")
    ) or request.headers.get("X-CSRF-Token", "")
    return secrets.compare_digest(token, _CSRF_TOKEN)


# ── Activity logger ───────────────────────────────────────────────────────────

def _setup_logger():
    log_path = _cfg.get("log_path", "/opt/grin/drop-test/drop-activity.log")
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    handler = logging.FileHandler(log_path)
    handler.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)-5s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    ))
    logger = logging.getLogger("drop")
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


def _admin_path() -> str:
    """Return the configured admin secret path (without slashes)."""
    return _cfg.get("admin_secret_path", "")


def _require_admin(secret: str) -> None:
    """Abort 404 if the secret path segment does not match config."""
    _reload_cfg()
    expected = _admin_path()
    if not expected or not secrets.compare_digest(secret, expected):
        abort(404)


# ── Maintenance hook ──────────────────────────────────────────────────────────

@app.before_request
def _maintenance_check():
    _reload_cfg()
    if not _cfg.get("maintenance_mode", False):
        return None
    path = request.path
    admin_p = _admin_path()
    # Allow admin path and /api/ through
    if (admin_p and path.startswith("/" + admin_p)) or path.startswith("/api/"):
        return None
    return render_template(
        "maintenance.html",
        drop_name=_cfg.get("drop_name", "Grin Drop"),
        message=_cfg.get("maintenance_message", "We'll be back soon. Thank you for your patience."),
    ), 503


# ── GET /robots.txt ───────────────────────────────────────────────────────────

@app.get("/robots.txt")
def robots_txt():
    _reload_cfg()
    subdomain = _cfg.get("subdomain", "")
    body = "User-agent: *\nDisallow: /api/\nAllow: /\n"
    if subdomain:
        body += f"\nSitemap: https://{subdomain}/sitemap.xml\n"
    resp = make_response(body)
    resp.headers["Content-Type"] = "text/plain"
    return resp


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

    show_stats = _cfg.get("show_public_stats", True)

    payload = {
        "drop_name":           _cfg.get("drop_name", "Grin Drop"),
        "claim_amount":        _cfg.get("claim_amount_grin", 2.0),
        "wallet_address":      _cfg.get("wallet_address", ""),
        "wallet_balance":      round(balance, 9),
        "claims_today":        db.count_claims_today(),
        "claims_total":        db.count_claims_total(),
        "next_claim_at":       None,
        "maintenance_mode":    _cfg.get("maintenance_mode", False),
        "maintenance_message": _cfg.get("maintenance_message", "We'll be back soon."),
        "giveaway_enabled":    _cfg.get("giveaway_enabled", True),
        "donation_enabled":    _cfg.get("donation_enabled", True),
        "show_public_stats":   show_stats,
    }

    if show_stats:
        payload["total_given"]    = round(db.get_total_grin_given(), 9)
        payload["total_received"] = round(db.get_total_grin_received(), 9)

    if addr_param:
        payload["next_claim_at"] = _next_claim_iso(addr_param)

    return jsonify(payload)


# ── GET /api/public-stats ─────────────────────────────────────────────────────

@app.get("/api/public-stats")
def api_public_stats():
    _reload_cfg()
    if not _cfg.get("show_public_stats", True):
        return jsonify({"error": "Public stats are disabled"}), 403

    summary = db.stats_summary()
    return jsonify({
        "total_given":     round(summary["total_given"], 9),
        "total_received":  round(summary["total_received"], 9),
        "claims_total":    summary["claims_total"],
        "donations_total": summary["donations_count"],
    })


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

    if not _cfg.get("giveaway_enabled", True):
        return _err("Giveaway is currently disabled", 503)

    body = request.get_json(silent=True) or {}
    grin_address = (body.get("grin_address") or "").strip()

    if not grin_address:
        return _err("grin_address is required")
    if not re.match(r"^(grin1|tgrin1)[a-z0-9]{40,}$", grin_address):
        return _err("Invalid grin address — expected grin1... or tgrin1... (52+ chars)")

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
        "status":      "confirmed",
        "tx_slate_id": tx_id or "",
        "amount":      claim["amount"],
        "message":     "Transaction submitted — confirmed after ~10 blocks (~10 min)",
    })


# ── Admin helpers ─────────────────────────────────────────────────────────────

def _admin_ctx(secret: str) -> dict:
    """Base template context for admin pages."""
    _reload_cfg()
    return {
        "csrf":       _CSRF_TOKEN,
        "admin_path": secret,
        "drop_name":  _cfg.get("drop_name", "Grin Drop"),
        "network":    "mainnet" if not _cfg.get("wallet_dir", "").startswith("/opt/grin/drop-test") else "testnet",
        "cfg":        _cfg,
    }


def _get_wallet_balance() -> float:
    try:
        return w.get_balance(_cfg)
    except Exception:
        return 0.0


def _get_service_status() -> str:
    """Return a human-readable service status string."""
    import subprocess
    try:
        result = subprocess.run(
            ["systemctl", "is-active", "--quiet", "grin-drop-test"],
            capture_output=True, timeout=5,
        )
        if result.returncode == 0:
            return "running"
        result2 = subprocess.run(
            ["systemctl", "is-active", "--quiet", "grin-drop-main"],
            capture_output=True, timeout=5,
        )
        if result2.returncode == 0:
            return "running"
        return "stopped"
    except Exception:
        return "unknown"


# ── Admin — dashboard ─────────────────────────────────────────────────────────

@app.get("/<secret>/")
def admin_dashboard(secret: str):
    _require_admin(secret)
    ctx = _admin_ctx(secret)
    ctx["stats"]          = db.stats_summary()
    ctx["recent_claims"]  = db.get_claims_paginated(1, 10)
    ctx["wallet_balance"] = round(_get_wallet_balance(), 9)
    ctx["service_status"] = _get_service_status()
    return render_template("admin/dashboard.html", **ctx)


# ── Admin — transactions ──────────────────────────────────────────────────────

@app.get("/<secret>/transactions")
def admin_transactions(secret: str):
    _require_admin(secret)
    per_page = 25
    page = max(1, int(request.args.get("page", 1) or 1))
    status_filter = request.args.get("status", "")
    search = (request.args.get("search", "") or "").strip()

    # If searching by address, do an address-filtered query
    if search:
        with db._connect() as conn:
            rows = conn.execute(
                """SELECT * FROM claims WHERE grin_address LIKE ?
                   ORDER BY id DESC LIMIT ? OFFSET ?""",
                (f"%{search}%", per_page, (page - 1) * per_page),
            ).fetchall()
            total_filtered = conn.execute(
                "SELECT COUNT(*) FROM claims WHERE grin_address LIKE ?",
                (f"%{search}%",),
            ).fetchone()[0]
        claims = [db._row_to_dict(r) for r in rows]
        total = int(total_filtered)
    else:
        claims = db.get_claims_paginated(page, per_page, status_filter)
        total = db.count_claims_filtered(status_filter)

    total_pages = max(1, (total + per_page - 1) // per_page)

    running_total = 0.0
    for c in claims:
        if c.get("status") == "confirmed":
            running_total += float(c.get("amount", 0))

    ctx = _admin_ctx(secret)
    ctx.update({
        "claims":        claims,
        "page":          page,
        "total_pages":   total_pages,
        "total":         total,
        "status_filter": status_filter,
        "search":        search,
        "running_total": round(running_total, 9),
    })
    return render_template("admin/transactions.html", **ctx)


# ── Admin — donations ─────────────────────────────────────────────────────────

@app.get("/<secret>/donations")
def admin_donations(secret: str):
    _require_admin(secret)
    ctx = _admin_ctx(secret)
    ctx["donations"] = db.get_donations_list(100)
    ctx["total_received"] = round(db.get_total_grin_received(), 9)
    return render_template("admin/donations.html", **ctx)


# ── Admin — settings GET ──────────────────────────────────────────────────────

@app.get("/<secret>/settings")
def admin_settings(secret: str):
    _require_admin(secret)
    ctx = _admin_ctx(secret)
    return render_template("admin/settings.html", **ctx)


# ── Admin — settings POST ─────────────────────────────────────────────────────

@app.post("/<secret>/settings")
def admin_settings_save(secret: str):
    _require_admin(secret)
    if not _csrf_ok():
        abort(403)

    _reload_cfg()
    cfg = dict(_cfg)

    # String fields
    for key in ("drop_name", "site_description", "og_image_url",
                "maintenance_message", "theme_default"):
        val = request.form.get(key)
        if val is not None:
            cfg[key] = val.strip()

    # Numeric fields
    for key in ("claim_amount_grin", "claim_window_hours", "finalize_timeout_min"):
        val = request.form.get(key)
        if val is not None:
            try:
                cfg[key] = float(val)
            except ValueError:
                pass

    # Boolean checkboxes (present = true, absent = false)
    for key in ("giveaway_enabled", "donation_enabled", "maintenance_mode", "show_public_stats"):
        cfg[key] = (request.form.get(key) == "on")

    cfg_mod.save(cfg)
    _reload_cfg()
    log.info("ADMIN_SETTINGS_SAVED")

    ctx = _admin_ctx(secret)
    ctx["saved"] = True
    ctx["restart_msg"] = "Settings saved. Restart the service to apply all changes."
    return render_template("admin/settings.html", **ctx)


# ── Admin API — toggle maintenance ────────────────────────────────────────────

@app.post("/<secret>/api/maintenance")
def admin_api_maintenance(secret: str):
    _require_admin(secret)
    if not _csrf_ok():
        return jsonify({"error": "CSRF validation failed"}), 403

    _reload_cfg()
    cfg = dict(_cfg)
    cfg["maintenance_mode"] = not bool(cfg.get("maintenance_mode", False))
    cfg_mod.save(cfg)
    _reload_cfg()
    log.info("ADMIN_MAINTENANCE mode=%s", cfg["maintenance_mode"])
    return jsonify({"maintenance_mode": cfg["maintenance_mode"]})


# ── Admin API — add donation ───────────────────────────────────────────────────

@app.post("/<secret>/api/add-donation")
def admin_api_add_donation(secret: str):
    _require_admin(secret)
    if not _csrf_ok():
        return jsonify({"error": "CSRF validation failed"}), 403

    body = request.get_json(silent=True) or {}
    try:
        amount = float(body.get("amount", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "amount must be a number"}), 400

    if amount <= 0:
        return jsonify({"error": "amount must be > 0"}), 400

    row_id = db.add_donation(
        amount=amount,
        tx_id=str(body.get("tx_id", "") or ""),
        from_address=str(body.get("from_address", "") or ""),
        note=str(body.get("note", "") or ""),
    )
    log.info("ADMIN_DONATION_ADDED id=%s amount=%s", row_id, amount)
    return jsonify({"id": row_id, "amount": amount})


# ── Admin — export claims CSV ─────────────────────────────────────────────────

@app.get("/<secret>/export/claims.csv")
def admin_export_claims_csv(secret: str):
    _require_admin(secret)

    with db._connect() as conn:
        rows = conn.execute(
            """SELECT id, grin_address, amount, confirmed_at, tx_slate_id
               FROM claims WHERE status = 'confirmed'
               ORDER BY id ASC"""
        ).fetchall()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "address", "amount", "confirmed_at", "tx_slate_id"])
    for row in rows:
        writer.writerow([
            row["id"],
            row["grin_address"],
            row["amount"],
            row["confirmed_at"] or "",
            row["tx_slate_id"] or "",
        ])

    output = buf.getvalue()
    resp = make_response(output)
    resp.headers["Content-Type"] = "text/csv"
    resp.headers["Content-Disposition"] = "attachment; filename=claims.csv"
    return resp


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(_cfg.get("service_port", 3004))
    app.run(host="127.0.0.1", port=port, debug=False)
