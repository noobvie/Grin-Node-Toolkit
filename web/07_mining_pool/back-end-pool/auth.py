"""
auth.py — JWT authentication and brute-force lockout for the Grin Pool Manager.

Provides:
  - Password hashing / verification (bcrypt via passlib)
  - IP-based login lockout (5 attempts / 15 minutes)
  - JWT access + refresh token creation / decoding
  - FastAPI dependency helpers: get_current_user, require_admin
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import LoginAttempt, User

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

LOCKOUT_ATTEMPTS = 5
LOCKOUT_MINUTES = 15

_ALGORITHM = "HS256"

_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


# ---------------------------------------------------------------------------
# Password helpers
# ---------------------------------------------------------------------------

def hash_password(password: str) -> str:
    """Return a bcrypt hash of *password*."""
    return _pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    """Return True if *plain* matches the stored *hashed* password."""
    return _pwd_context.verify(plain, hashed)


# ---------------------------------------------------------------------------
# Brute-force lockout
# ---------------------------------------------------------------------------

async def is_locked_out(ip: str, session: AsyncSession) -> bool:
    """
    Return True when *ip* has made >= LOCKOUT_ATTEMPTS failed logins in the
    last LOCKOUT_MINUTES minutes.
    """
    cutoff = datetime.utcnow() - timedelta(minutes=LOCKOUT_MINUTES)
    result = await session.execute(
        select(func.count(LoginAttempt.id)).where(
            LoginAttempt.ip_address == ip,
            LoginAttempt.attempted_at >= cutoff,
        )
    )
    count: int = result.scalar_one()
    return count >= LOCKOUT_ATTEMPTS


async def record_attempt(ip: str, session: AsyncSession) -> None:
    """Persist a failed login attempt for *ip*."""
    attempt = LoginAttempt(ip_address=ip, attempted_at=datetime.utcnow())
    session.add(attempt)
    await session.flush()


async def clear_attempts(ip: str, session: AsyncSession) -> None:
    """Remove all recorded login attempts for *ip* (called on successful login)."""
    await session.execute(
        delete(LoginAttempt).where(LoginAttempt.ip_address == ip)
    )
    await session.flush()


# ---------------------------------------------------------------------------
# JWT helpers
# ---------------------------------------------------------------------------

def create_access_token(
    data: dict[str, Any],
    secret: str,
    expires_minutes: int = 60,
) -> str:
    """Return a signed JWT access token that expires in *expires_minutes*."""
    payload = dict(data)
    expire = datetime.now(tz=timezone.utc) + timedelta(minutes=expires_minutes)
    payload.update({"exp": expire, "type": "access"})
    return jwt.encode(payload, secret, algorithm=_ALGORITHM)


def create_refresh_token(
    data: dict[str, Any],
    secret: str,
    expires_days: int = 7,
) -> str:
    """Return a signed JWT refresh token that expires in *expires_days*."""
    payload = dict(data)
    expire = datetime.now(tz=timezone.utc) + timedelta(days=expires_days)
    payload.update({"exp": expire, "type": "refresh"})
    return jwt.encode(payload, secret, algorithm=_ALGORITHM)


def decode_token(token: str, secret: str) -> dict[str, Any]:
    """
    Decode and verify *token*.

    Raises ``jose.JWTError`` if the token is invalid or expired.
    """
    return jwt.decode(token, secret, algorithms=[_ALGORITHM])


# ---------------------------------------------------------------------------
# FastAPI dependency helpers
# ---------------------------------------------------------------------------

async def get_current_user(
    token: str,
    session: AsyncSession,
    secret: str,
) -> User:
    """
    Validate *token* and return the corresponding active User.

    Raises HTTPException 401 on any authentication failure.
    """
    credentials_exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = decode_token(token, secret)
    except JWTError:
        raise credentials_exc

    username: str | None = payload.get("sub")
    if not username:
        raise credentials_exc

    result = await session.execute(
        select(User).where(User.username == username)
    )
    user = result.scalar_one_or_none()

    if user is None:
        raise credentials_exc
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account is disabled",
        )
    return user


async def require_admin(current_user: User) -> User:
    """
    Guard that ensures *current_user* has admin privileges.

    Raises HTTPException 403 if not.
    """
    if not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator access required",
        )
    return current_user
