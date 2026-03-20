"""
db.py — SQLite schema and helpers for the Grin Testnet Faucet.

DB path: /opt/grin/faucet/faucet.db  (overridden by DB_PATH env var)

Tables:
  claims — one row per claim attempt (pending, waiting_finalize, confirmed,
            failed, cancelled)
"""

import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

DB_PATH = os.environ.get("FAUCET_DB", "/opt/grin/faucet/faucet.db")

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


# ── Helpers ──────────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _row_to_dict(row) -> dict:
    return dict(row) if row else {}


# ── Reads ─────────────────────────────────────────────────────────────────────

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


# ── Writes ────────────────────────────────────────────────────────────────────

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
