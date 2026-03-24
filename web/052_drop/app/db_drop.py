"""
db_drop.py — SQLite schema and helpers for Grin Drop.

DB path: /opt/grin/drop-<net>/drop.db  (overridden by DROP_DB env var)

Tables:
  claims    — one row per claim attempt (pending, waiting_finalize, confirmed,
              failed, cancelled)
  donations — recorded incoming donations for display / accounting
"""

import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

DB_PATH = os.environ.get("DROP_DB", "/opt/grin/drop-test/drop.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS claims (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    grin_address  TEXT    NOT NULL,
    amount        REAL    NOT NULL,
    tx_slate_id   TEXT,
    slatepack_out TEXT,
    slatepack_in  TEXT,
    status        TEXT    NOT NULL DEFAULT 'pending',
    created_at    TEXT    NOT NULL,
    expires_at    TEXT    NOT NULL,
    confirmed_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_claims_address ON claims(grin_address);
CREATE INDEX IF NOT EXISTS idx_claims_status  ON claims(status);

CREATE TABLE IF NOT EXISTS donations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    amount       REAL    NOT NULL,
    tx_id        TEXT    DEFAULT '',
    from_address TEXT    DEFAULT '',
    note         TEXT    DEFAULT '',
    created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_donations_created ON donations(created_at);
"""


def init_db() -> None:
    """Create tables if they don't exist."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with _connect() as conn:
        conn.executescript(SCHEMA)


@contextmanager
def _connect():
    conn = sqlite3.connect(DB_PATH, detect_types=sqlite3.PARSE_DECLTYPES)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _row_to_dict(row) -> dict:
    return dict(row) if row else {}


# ── Reads — claims ─────────────────────────────────────────────────────────────

def get_claim(claim_id: int) -> dict:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM claims WHERE id = ?", (claim_id,)
        ).fetchone()
    return _row_to_dict(row)


def last_confirmed_claim(grin_address: str) -> dict:
    """Return the most recent confirmed (or waiting) claim for this address."""
    with _connect() as conn:
        row = conn.execute(
            """SELECT * FROM claims
               WHERE grin_address = ?
                 AND status IN ('confirmed', 'waiting_finalize', 'pending')
               ORDER BY created_at DESC LIMIT 1""",
            (grin_address,),
        ).fetchone()
    return _row_to_dict(row)


def count_claims_today() -> int:
    today = datetime.now(timezone.utc).date().isoformat()
    with _connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) FROM claims WHERE created_at LIKE ? AND status = 'confirmed'",
            (today + "%",),
        ).fetchone()
    return row[0] if row else 0


def count_claims_total() -> int:
    with _connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) FROM claims WHERE status = 'confirmed'"
        ).fetchone()
    return row[0] if row else 0


def get_expired_claims() -> list:
    """Return all waiting_finalize claims that have passed their expires_at."""
    now = _now_iso()
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM claims WHERE status = 'waiting_finalize' AND expires_at <= ?",
            (now,),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_total_grin_given() -> float:
    """Return the total GRIN given out via confirmed claims."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT COALESCE(SUM(amount), 0.0) FROM claims WHERE status = 'confirmed'"
        ).fetchone()
    return float(row[0]) if row else 0.0


def get_total_grin_received() -> float:
    """Return the total GRIN recorded in donations."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT COALESCE(SUM(amount), 0.0) FROM donations"
        ).fetchone()
    return float(row[0]) if row else 0.0


def stats_summary() -> dict:
    """Return a summary dict for the admin dashboard."""
    today = datetime.now(timezone.utc).date().isoformat()
    with _connect() as conn:
        claims_today = conn.execute(
            "SELECT COUNT(*) FROM claims WHERE created_at LIKE ? AND status = 'confirmed'",
            (today + "%",),
        ).fetchone()[0]
        claims_total = conn.execute(
            "SELECT COUNT(*) FROM claims WHERE status = 'confirmed'"
        ).fetchone()[0]
        pending_count = conn.execute(
            "SELECT COUNT(*) FROM claims WHERE status IN ('waiting_finalize', 'pending')"
        ).fetchone()[0]
        failed_count = conn.execute(
            "SELECT COUNT(*) FROM claims WHERE status = 'failed'"
        ).fetchone()[0]
        total_given_row = conn.execute(
            "SELECT COALESCE(SUM(amount), 0.0) FROM claims WHERE status = 'confirmed'"
        ).fetchone()
        total_received_row = conn.execute(
            "SELECT COALESCE(SUM(amount), 0.0) FROM donations"
        ).fetchone()
        donations_count = conn.execute(
            "SELECT COUNT(*) FROM donations"
        ).fetchone()[0]

    return {
        "claims_today":    int(claims_today),
        "claims_total":    int(claims_total),
        "pending_count":   int(pending_count),
        "failed_count":    int(failed_count),
        "total_given":     float(total_given_row[0]),
        "total_received":  float(total_received_row[0]),
        "donations_count": int(donations_count),
    }


def get_claims_paginated(page: int, per_page: int, status_filter: str = "") -> list:
    """Return a paginated list of claims, optionally filtered by status."""
    offset = (page - 1) * per_page
    with _connect() as conn:
        if status_filter:
            rows = conn.execute(
                """SELECT * FROM claims WHERE status = ?
                   ORDER BY id DESC LIMIT ? OFFSET ?""",
                (status_filter, per_page, offset),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM claims ORDER BY id DESC LIMIT ? OFFSET ?",
                (per_page, offset),
            ).fetchall()
    return [_row_to_dict(r) for r in rows]


def count_claims_filtered(status_filter: str = "") -> int:
    """Return total count of claims, optionally filtered by status."""
    with _connect() as conn:
        if status_filter:
            row = conn.execute(
                "SELECT COUNT(*) FROM claims WHERE status = ?",
                (status_filter,),
            ).fetchone()
        else:
            row = conn.execute("SELECT COUNT(*) FROM claims").fetchone()
    return int(row[0]) if row else 0


# ── Reads — donations ──────────────────────────────────────────────────────────

def get_donations_list(limit: int = 50) -> list:
    """Return the most recent donations."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM donations ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


# ── Writes — claims ────────────────────────────────────────────────────────────

def create_claim(grin_address: str, amount: float, timeout_min: int) -> int:
    """Insert a new pending claim. Returns the new claim id."""
    from datetime import timedelta
    now = datetime.now(timezone.utc)
    expires = now + timedelta(minutes=timeout_min)
    with _connect() as conn:
        cur = conn.execute(
            """INSERT INTO claims (grin_address, amount, status, created_at, expires_at)
               VALUES (?, ?, 'pending', ?, ?)""",
            (grin_address, amount, now.isoformat(timespec="seconds"),
             expires.isoformat(timespec="seconds")),
        )
    return cur.lastrowid


def set_slatepack_out(claim_id: int, slatepack_out: str) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE claims SET slatepack_out = ?, status = 'waiting_finalize' WHERE id = ?",
            (slatepack_out, claim_id),
        )


def set_finalized(claim_id: int, slatepack_in: str, tx_slate_id: str) -> None:
    with _connect() as conn:
        conn.execute(
            """UPDATE claims
               SET slatepack_in = ?, tx_slate_id = ?, status = 'confirmed',
                   confirmed_at = ?
               WHERE id = ?""",
            (slatepack_in, tx_slate_id, _now_iso(), claim_id),
        )


def set_status(claim_id: int, status: str) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE claims SET status = ? WHERE id = ?",
            (status, claim_id),
        )


def cancel_expired(claim_id: int) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE claims SET status = 'cancelled' WHERE id = ? AND status = 'waiting_finalize'",
            (claim_id,),
        )


# ── Writes — donations ─────────────────────────────────────────────────────────

def add_donation(amount: float, tx_id: str = "", from_address: str = "", note: str = "") -> int:
    """Record a donation. Returns the new row id."""
    with _connect() as conn:
        cur = conn.execute(
            """INSERT INTO donations (amount, tx_id, from_address, note, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (amount, tx_id, from_address, note, _now_iso()),
        )
    return cur.lastrowid
