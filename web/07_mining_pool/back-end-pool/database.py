"""
database.py — SQLAlchemy 2.0 async models and session factory for the Grin Pool Manager.

Engine is created lazily via setup_engine(db_url) called from app startup.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import AsyncGenerator

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    event,
)
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Declarative base
# ---------------------------------------------------------------------------

class Base(DeclarativeBase):
    pass


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    username = Column(String(64), unique=True, nullable=False, index=True)
    email = Column(String(255), nullable=True)
    password_hash = Column(String(256), nullable=False)
    grin_address = Column(String(255), nullable=True)
    balance = Column(Float, default=0.0)           # spendable
    balance_locked = Column(Float, default=0.0)    # pending withdrawals
    fee_exempt = Column(Boolean, default=False)
    is_admin = Column(Boolean, default=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_login = Column(DateTime, nullable=True)


class LoginAttempt(Base):
    __tablename__ = "login_attempts"

    id = Column(Integer, primary_key=True)
    ip_address = Column(String(45), nullable=False, index=True)
    attempted_at = Column(DateTime, default=datetime.utcnow)


class Miner(Base):
    __tablename__ = "miners"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    worker_name = Column(String(128), nullable=False, index=True)  # e.g. "alice.1"
    last_seen = Column(DateTime, nullable=True)
    first_seen = Column(DateTime, default=datetime.utcnow)
    hashrate_1h = Column(Float, default=0.0)    # GPS
    hashrate_24h = Column(Float, default=0.0)   # GPS
    is_online = Column(Boolean, default=False)


class Block(Base):
    __tablename__ = "blocks"

    id = Column(Integer, primary_key=True)
    height = Column(Integer, unique=True, nullable=False)
    hash = Column(String(64), nullable=True)
    reward = Column(Float, default=60.0)
    found_at = Column(DateTime, default=datetime.utcnow)
    location = Column(String(64), nullable=True)


class Share(Base):
    __tablename__ = "shares"

    id = Column(Integer, primary_key=True)
    block_id = Column(Integer, ForeignKey("blocks.id"), nullable=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    share_weight = Column(Float, default=1.0)
    earned_grin = Column(Float, default=0.0)
    recorded_at = Column(DateTime, default=datetime.utcnow)


class Withdrawal(Base):
    __tablename__ = "withdrawals"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    amount = Column(Float, nullable=False)
    fee = Column(Float, default=0.0)
    tx_slate_id = Column(String(64), nullable=True)
    slatepack_out = Column(Text, nullable=True)    # slatepack sent TO user
    slatepack_in = Column(Text, nullable=True)     # response slate FROM user
    status = Column(
        String(32), default="pending"
    )  # pending|waiting_finalize|confirmed|failed|cancelled
    confirmation_height = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    expires_at = Column(DateTime, nullable=True)   # created_at + 5 min
    finalized_at = Column(DateTime, nullable=True)


class PoolLocation(Base):
    __tablename__ = "pool_locations"

    id = Column(Integer, primary_key=True)
    region = Column(String(64), nullable=False)
    subdomain = Column(String(255), nullable=False)
    stratum_port = Column(Integer, nullable=False)
    api_url = Column(String(255), nullable=True)
    is_active = Column(Boolean, default=True)


class HashrateHistory(Base):
    __tablename__ = "hashrate_history"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)  # NULL = pool total
    worker_name = Column(String(128), nullable=True)
    recorded_at = Column(DateTime, default=datetime.utcnow)
    hashrate_gps = Column(Float, default=0.0)
    miner_count = Column(Integer, default=0)


# ---------------------------------------------------------------------------
# Engine / session factory (created lazily)
# ---------------------------------------------------------------------------

_engine: AsyncEngine | None = None
_async_session_factory: async_sessionmaker[AsyncSession] | None = None


def setup_engine(db_url: str) -> None:
    """
    Initialise the global async engine and session factory.

    Call this once from the FastAPI startup event before any DB access.
    """
    global _engine, _async_session_factory

    connect_args: dict = {}
    if "sqlite" in db_url:
        connect_args["check_same_thread"] = False

    _engine = create_async_engine(
        db_url,
        connect_args=connect_args,
        echo=False,
        future=True,
    )

    _async_session_factory = async_sessionmaker(
        _engine,
        expire_on_commit=False,
        class_=AsyncSession,
    )
    log.info("Database engine created for %s", db_url)


async def init_db() -> None:
    """
    Create all tables and enable WAL mode for SQLite.

    Must be called after setup_engine().
    """
    if _engine is None:
        raise RuntimeError("setup_engine() must be called before init_db()")

    async with _engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

        # Enable WAL journal mode for better concurrent read performance on SQLite
        if "sqlite" in str(_engine.url):
            await conn.exec_driver_sql("PRAGMA journal_mode=WAL;")
            await conn.exec_driver_sql("PRAGMA synchronous=NORMAL;")
            await conn.exec_driver_sql("PRAGMA foreign_keys=ON;")

    log.info("Database tables initialised (WAL enabled for SQLite)")


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """
    FastAPI dependency that yields a single AsyncSession per request.

    Usage:
        @app.get("/example")
        async def handler(session: AsyncSession = Depends(get_session)):
            ...
    """
    if _async_session_factory is None:
        raise RuntimeError("setup_engine() must be called before get_session() is used")

    async with _async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    """Return the session factory (for use outside of FastAPI DI, e.g. scheduler)."""
    if _async_session_factory is None:
        raise RuntimeError("setup_engine() must be called first")
    return _async_session_factory
