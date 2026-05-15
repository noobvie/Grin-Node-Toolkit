"""
main.py — FastAPI application for the Grin Pool Manager.

Endpoints
---------
Public
  GET  /api/health
  GET  /api/pool/stats
  GET  /api/pool/blocks
  GET  /api/pool/locations

Auth
  POST /api/auth/register
  POST /api/auth/login
  POST /api/auth/refresh
  POST /api/auth/logout
  GET  /api/auth/me

User  (Bearer token required)
  GET  /api/user/dashboard
  GET  /api/user/miners
  GET  /api/user/hashrate
  GET  /api/user/blocks
  GET  /api/user/rewards
  GET  /api/user/withdrawals
  POST /api/user/withdraw
  POST /api/user/finalize
  PUT  /api/user/profile

Admin (is_admin=True required)
  GET  /api/admin/health
  GET  /api/admin/stats
  GET  /api/admin/users
  PUT  /api/admin/users/{user_id}
  POST /api/admin/users/{user_id}/inject
  GET  /api/admin/miners
  GET  /api/admin/withdrawals
  POST /api/admin/pay/{withdrawal_id}
  GET  /api/admin/locations
  POST /api/admin/locations
  DELETE /api/admin/locations/{location_id}
"""

from __future__ import annotations

import logging
import re
import socket
from datetime import datetime, timedelta
from typing import Any, Optional

import requests as http_requests
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError
from pydantic import BaseModel, Field
from sqlalchemy import desc, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

import auth
import config as cfg_mod
import database as db
import monitor as mon
import rewards
import scheduler as sched
import wallet as w

log = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

# ---------------------------------------------------------------------------
# Application state (populated at startup)
# ---------------------------------------------------------------------------

_cfg: dict = {}
_monitor: Optional[mon.StratumMonitor] = None

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Grin Pool Manager",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # Tighten to specific origin in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

bearer_scheme = HTTPBearer(auto_error=False)

# ---------------------------------------------------------------------------
# Startup / shutdown
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def startup() -> None:
    global _cfg, _monitor
    _cfg = cfg_mod.load()
    db.setup_engine(_cfg["db_url"])
    await db.init_db()
    _monitor = mon.StratumMonitor(_cfg)
    session_factory = db.get_session_factory()
    sched.setup_scheduler(_cfg, _monitor, session_factory)
    log.info("Grin Pool Manager started on port %d", _cfg.get("service_port", 3002))


@app.on_event("shutdown")
async def shutdown() -> None:
    if sched.scheduler.running:
        sched.scheduler.shutdown(wait=False)
    log.info("Grin Pool Manager shut down")


# ---------------------------------------------------------------------------
# Auth helpers (shared across routes)
# ---------------------------------------------------------------------------

async def _get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    session: AsyncSession = Depends(db.get_session),
) -> db.User:
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    secret = _cfg.get("jwt_secret", "")
    return await auth.get_current_user(credentials.credentials, session, secret)


async def _get_admin_user(
    current_user: db.User = Depends(_get_current_user),
) -> db.User:
    return await auth.require_admin(current_user)


# ---------------------------------------------------------------------------
# Utility: node / stratum health checks
# ---------------------------------------------------------------------------

def _check_stratum_listening(port: int) -> bool:
    """Return True when something is listening on TCP *port* locally."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            return True
    except OSError:
        return False


def _check_node_synced(api_port: int) -> tuple[bool, Optional[int]]:
    """
    Send a JSON-RPC get_tip call to the local grin-node foreign API.

    Returns (reachable: bool, height: int | None).
    """
    url = f"http://127.0.0.1:{api_port}/v2/foreign"
    payload = {
        "jsonrpc": "2.0",
        "method": "get_tip",
        "id": 1,
        "params": [],
    }
    try:
        resp = http_requests.post(url, json=payload, timeout=3)
        data = resp.json()
        height = (
            data.get("result", {})
            .get("Ok", {})
            .get("height")
        )
        return True, height
    except Exception:
        return False, None


def _last_block_found_dt(last_block_found: Optional[datetime]) -> Optional[str]:
    if last_block_found is None:
        return None
    return last_block_found.isoformat()


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

# Auth
class RegisterRequest(BaseModel):
    username: str
    password: str
    email: Optional[str] = None

class LoginRequest(BaseModel):
    username: str
    password: str

class RefreshRequest(BaseModel):
    refresh_token: str

class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"

class AccessTokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"

# User
class ProfileUpdate(BaseModel):
    grin_address: Optional[str] = None

class WithdrawRequest(BaseModel):
    amount: float
    grin_address: str

class FinalizeRequest(BaseModel):
    withdrawal_id: int
    response_slate: str

# Admin
class UserUpdate(BaseModel):
    fee_exempt: Optional[bool] = None
    is_admin: Optional[bool] = None
    is_active: Optional[bool] = None

class InjectRequest(BaseModel):
    amount: float

class LocationCreate(BaseModel):
    region: str
    subdomain: str
    stratum_port: int
    api_url: Optional[str] = None
    is_active: bool = True


# ---------------------------------------------------------------------------
# PUBLIC ENDPOINTS
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health(session: AsyncSession = Depends(db.get_session)):
    """
    Lightweight health probe.

    Returns HTTP 200 with status "ok" or "degraded", or HTTP 503 with "down".
    """
    node_ok, node_height = _check_node_synced(_cfg.get("node_api_port", 3413))
    stratum_ok = _check_stratum_listening(_cfg.get("stratum_port", 3416))

    if node_ok and stratum_ok:
        pool_status = "ok"
    elif stratum_ok:
        pool_status = "degraded"
    else:
        pool_status = "down"

    # Last block
    block_result = await session.execute(
        select(db.Block.found_at).order_by(db.Block.found_at.desc()).limit(1)
    )
    row = block_result.first()
    last_block: Optional[str] = row[0].isoformat() if row else None

    # Online miners
    miner_result = await session.execute(
        select(func.count(db.Miner.id)).where(db.Miner.is_online == True)  # noqa: E712
    )
    miners_online: int = miner_result.scalar_one() or 0

    body = {
        "status": pool_status,
        "pool": _cfg.get("pool_name", ""),
        "network": _cfg.get("network", "mainnet"),
        "stratum_port": _cfg.get("stratum_port", 3416),
        "miners_online": miners_online,
        "node_synced": node_ok,
        "node_height": node_height,
        "last_block_found": last_block,
    }
    http_status = status.HTTP_503_SERVICE_UNAVAILABLE if pool_status == "down" else status.HTTP_200_OK
    return JSONResponse(content=body, status_code=http_status)


@app.get("/api/pool/stats")
async def pool_stats(session: AsyncSession = Depends(db.get_session)):
    """Aggregate pool statistics for the public dashboard."""
    # Hashrate: sum of online miners' 1h hashrate
    hr_result = await session.execute(
        select(func.sum(db.Miner.hashrate_1h)).where(db.Miner.is_online == True)  # noqa: E712
    )
    hashrate_gps: float = hr_result.scalar_one() or 0.0

    miner_result = await session.execute(
        select(func.count(db.Miner.id)).where(db.Miner.is_online == True)  # noqa: E712
    )
    miner_count: int = miner_result.scalar_one() or 0

    # Active locations
    loc_result = await session.execute(
        select(db.PoolLocation).where(db.PoolLocation.is_active == True)  # noqa: E712
    )
    locations = [
        {
            "id": loc.id,
            "region": loc.region,
            "subdomain": loc.subdomain,
            "stratum_port": loc.stratum_port,
        }
        for loc in loc_result.scalars().all()
    ]

    # Difficulty placeholder (would come from node API in a real deployment)
    node_ok, _ = _check_node_synced(_cfg.get("node_api_port", 3413))
    difficulty: Optional[int] = None
    if node_ok:
        try:
            resp = http_requests.post(
                f"http://127.0.0.1:{_cfg.get('node_api_port', 3413)}/v2/foreign",
                json={"jsonrpc": "2.0", "method": "get_tip", "id": 1, "params": []},
                timeout=3,
            )
            difficulty = resp.json().get("result", {}).get("Ok", {}).get("total_difficulty")
        except Exception:
            pass

    return {
        "pool_name": _cfg.get("pool_name", ""),
        "network": _cfg.get("network", "mainnet"),
        "hashrate_gps": round(hashrate_gps, 4),
        "miner_count": miner_count,
        "difficulty": difficulty,
        "locations": locations,
    }


@app.get("/api/pool/blocks")
async def pool_blocks(
    limit: int = 20,
    session: AsyncSession = Depends(db.get_session),
):
    """Most recent blocks found by the pool."""
    result = await session.execute(
        select(db.Block).order_by(db.Block.found_at.desc()).limit(max(1, min(limit, 200)))
    )
    blocks = result.scalars().all()
    return [
        {
            "height": b.height,
            "hash": b.hash,
            "reward": b.reward,
            "found_at": b.found_at.isoformat() if b.found_at else None,
            "location": b.location,
        }
        for b in blocks
    ]


@app.get("/api/pool/locations")
async def pool_locations(session: AsyncSession = Depends(db.get_session)):
    """Return all active pool locations."""
    result = await session.execute(
        select(db.PoolLocation).where(db.PoolLocation.is_active == True)  # noqa: E712
    )
    locs = result.scalars().all()
    return [
        {
            "id": loc.id,
            "region": loc.region,
            "subdomain": loc.subdomain,
            "stratum_port": loc.stratum_port,
            "api_url": loc.api_url,
        }
        for loc in locs
    ]


# ---------------------------------------------------------------------------
# AUTH ENDPOINTS
# ---------------------------------------------------------------------------

_USERNAME_RE = re.compile(r"^[a-zA-Z0-9_]{3,32}$")


@app.post("/api/auth/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def register(
    body: RegisterRequest,
    session: AsyncSession = Depends(db.get_session),
):
    # Validation
    if not _USERNAME_RE.match(body.username):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Username must be 3-32 characters (letters, digits, underscore)",
        )
    if len(body.password) < 8:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Password must be at least 8 characters",
        )

    # Check duplicate
    existing = await session.execute(
        select(db.User).where(db.User.username == body.username)
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Username already taken",
        )

    # Determine if this is the first user (make them admin)
    count_result = await session.execute(select(func.count(db.User.id)))
    user_count: int = count_result.scalar_one() or 0

    user = db.User(
        username=body.username,
        email=body.email,
        password_hash=auth.hash_password(body.password),
        is_admin=(user_count == 0),
        created_at=datetime.utcnow(),
    )
    session.add(user)
    await session.flush()

    secret = _cfg.get("jwt_secret", "")
    access = auth.create_access_token(
        {"sub": user.username},
        secret,
        _cfg.get("jwt_access_expire_minutes", 60),
    )
    refresh = auth.create_refresh_token(
        {"sub": user.username},
        secret,
        _cfg.get("jwt_refresh_expire_days", 7),
    )
    return TokenResponse(access_token=access, refresh_token=refresh)


@app.post("/api/auth/login", response_model=TokenResponse)
async def login(
    body: LoginRequest,
    request: Request,
    session: AsyncSession = Depends(db.get_session),
):
    ip = request.client.host if request.client else "unknown"

    # Lockout check
    if await auth.is_locked_out(ip, session):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Too many failed attempts. Try again in {auth.LOCKOUT_MINUTES} minutes.",
        )

    result = await session.execute(
        select(db.User).where(db.User.username == body.username)
    )
    user = result.scalar_one_or_none()

    if user is None or not auth.verify_password(body.password, user.password_hash):
        await auth.record_attempt(ip, session)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Account is disabled",
        )

    await auth.clear_attempts(ip, session)
    user.last_login = datetime.utcnow()
    await session.flush()

    secret = _cfg.get("jwt_secret", "")
    access = auth.create_access_token(
        {"sub": user.username},
        secret,
        _cfg.get("jwt_access_expire_minutes", 60),
    )
    refresh = auth.create_refresh_token(
        {"sub": user.username},
        secret,
        _cfg.get("jwt_refresh_expire_days", 7),
    )
    return TokenResponse(access_token=access, refresh_token=refresh)


@app.post("/api/auth/refresh", response_model=AccessTokenResponse)
async def refresh_token(body: RefreshRequest):
    secret = _cfg.get("jwt_secret", "")
    try:
        payload = auth.decode_token(body.refresh_token, secret)
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token",
        )
    if payload.get("type") != "refresh":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not a refresh token",
        )
    username = payload.get("sub")
    access = auth.create_access_token(
        {"sub": username},
        secret,
        _cfg.get("jwt_access_expire_minutes", 60),
    )
    return AccessTokenResponse(access_token=access)


@app.post("/api/auth/logout")
async def logout():
    """Client-side token discard — server is stateless."""
    return {"status": "ok"}


@app.get("/api/auth/me")
async def me(current_user: db.User = Depends(_get_current_user)):
    return {
        "id": current_user.id,
        "username": current_user.username,
        "email": current_user.email,
        "grin_address": current_user.grin_address,
        "is_admin": current_user.is_admin,
        "created_at": current_user.created_at.isoformat() if current_user.created_at else None,
    }


# ---------------------------------------------------------------------------
# USER ENDPOINTS
# ---------------------------------------------------------------------------

@app.get("/api/user/dashboard")
async def user_dashboard(
    current_user: db.User = Depends(_get_current_user),
    session: AsyncSession = Depends(db.get_session),
):
    # Total mined (sum of all share earnings for this user)
    total_mined_result = await session.execute(
        select(func.sum(db.Share.earned_grin)).where(db.Share.user_id == current_user.id)
    )
    total_mined: float = total_mined_result.scalar_one() or 0.0

    # Reward today
    today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    today_result = await session.execute(
        select(func.sum(db.Share.earned_grin)).where(
            db.Share.user_id == current_user.id,
            db.Share.recorded_at >= today_start,
        )
    )
    reward_today: float = today_result.scalar_one() or 0.0

    # Online miners for this user
    miner_result = await session.execute(
        select(func.count(db.Miner.id)).where(
            db.Miner.user_id == current_user.id,
            db.Miner.is_online == True,  # noqa: E712
        )
    )
    miners_online: int = miner_result.scalar_one() or 0

    # Total hashrate
    hr_result = await session.execute(
        select(func.sum(db.Miner.hashrate_1h)).where(
            db.Miner.user_id == current_user.id,
            db.Miner.is_online == True,  # noqa: E712
        )
    )
    total_hashrate_gps: float = hr_result.scalar_one() or 0.0

    return {
        "total_mined": round(total_mined, 6),
        "reward_today": round(reward_today, 6),
        "withdrawable": round(current_user.balance, 6),
        "locked": round(current_user.balance_locked, 6),
        "miners_online": miners_online,
        "total_hashrate_gps": round(total_hashrate_gps, 4),
    }


@app.get("/api/user/miners")
async def user_miners(
    current_user: db.User = Depends(_get_current_user),
    session: AsyncSession = Depends(db.get_session),
):
    result = await session.execute(
        select(db.Miner).where(db.Miner.user_id == current_user.id)
    )
    miners = result.scalars().all()
    return [
        {
            "id": m.id,
            "worker_name": m.worker_name,
            "is_online": m.is_online,
            "hashrate_1h": m.hashrate_1h,
            "hashrate_24h": m.hashrate_24h,
            "last_seen": m.last_seen.isoformat() if m.last_seen else None,
            "first_seen": m.first_seen.isoformat() if m.first_seen else None,
        }
        for m in miners
    ]


def _period_to_hours(period: str) -> int:
    mapping = {"1d": 24, "7d": 168, "30d": 720}
    return mapping.get(period, 24)


@app.get("/api/user/hashrate")
async def user_hashrate(
    period: str = "1d",
    current_user: db.User = Depends(_get_current_user),
    session: AsyncSession = Depends(db.get_session),
):
    hours = _period_to_hours(period)
    cutoff = datetime.utcnow() - timedelta(hours=hours)
    result = await session.execute(
        select(db.HashrateHistory)
        .where(
            db.HashrateHistory.user_id == current_user.id,
            db.HashrateHistory.recorded_at >= cutoff,
        )
        .order_by(db.HashrateHistory.recorded_at.asc())
    )
    rows = result.scalars().all()
    return [
        {
            "recorded_at": r.recorded_at.isoformat(),
            "hashrate_gps": r.hashrate_gps,
            "worker_name": r.worker_name,
        }
        for r in rows
    ]


def _period_to_timedelta(period: str) -> timedelta:
    mapping = {"24h": timedelta(hours=24), "7d": timedelta(days=7), "30d": timedelta(days=30)}
    return mapping.get(period, timedelta(hours=24))


@app.get("/api/user/blocks")
async def user_blocks(
    period: str = "24h",
    current_user: db.User = Depends(_get_current_user),
    session: AsyncSession = Depends(db.get_session),
):
    cutoff = datetime.utcnow() - _period_to_timedelta(period)
    # Blocks where this user has earned shares
    result = await session.execute(
        select(db.Block)
        .join(db.Share, db.Share.block_id == db.Block.id)
        .where(
            db.Share.user_id == current_user.id,
            db.Share.earned_grin > 0,
            db.Block.found_at >= cutoff,
        )
        .distinct()
        .order_by(db.Block.found_at.desc())
    )
    blocks = result.scalars().all()
    return [
        {
            "height": b.height,
            "hash": b.hash,
            "reward": b.reward,
            "found_at": b.found_at.isoformat() if b.found_at else None,
        }
        for b in blocks
    ]


@app.get("/api/user/rewards")
async def user_rewards(
    period: str = "30d",
    current_user: db.User = Depends(_get_current_user),
    session: AsyncSession = Depends(db.get_session),
):
    """Return daily reward totals for the given period."""
    cutoff = datetime.utcnow() - _period_to_timedelta(period)
    result = await session.execute(
        select(db.Share)
        .where(
            db.Share.user_id == current_user.id,
            db.Share.earned_grin > 0,
            db.Share.recorded_at >= cutoff,
        )
        .order_by(db.Share.recorded_at.asc())
    )
    shares = result.scalars().all()

    # Bucket by calendar day (UTC)
    daily: dict[str, float] = {}
    for s in shares:
        day = s.recorded_at.strftime("%Y-%m-%d")
        daily[day] = daily.get(day, 0.0) + s.earned_grin

    return [{"date": d, "earned_grin": round(v, 6)} for d, v in sorted(daily.items())]


@app.get("/api/user/withdrawals")
async def user_withdrawals(
    current_user: db.User = Depends(_get_current_user),
    session: AsyncSession = Depends(db.get_session),
):
    result = await session.execute(
        select(db.Withdrawal)
        .where(db.Withdrawal.user_id == current_user.id)
        .order_by(db.Withdrawal.created_at.desc())
    )
    wds = result.scalars().all()
    return [
        {
            "id": wd.id,
            "amount": wd.amount,
            "fee": wd.fee,
            "status": wd.status,
            "tx_slate_id": wd.tx_slate_id,
            "created_at": wd.created_at.isoformat() if wd.created_at else None,
            "expires_at": wd.expires_at.isoformat() if wd.expires_at else None,
            "finalized_at": wd.finalized_at.isoformat() if wd.finalized_at else None,
        }
        for wd in wds
    ]


@app.post("/api/user/withdraw", status_code=status.HTTP_201_CREATED)
async def withdraw(
    body: WithdrawRequest,
    current_user: db.User = Depends(_get_current_user),
    session: AsyncSession = Depends(db.get_session),
):
    min_wd: float = _cfg.get("min_withdrawal", 2.0)
    if body.amount < min_wd:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Minimum withdrawal is {min_wd} GRIN",
        )

    fee: float = 0.0 if current_user.fee_exempt else float(_cfg.get("withdrawal_fee", 0.0))
    total_needed = body.amount + fee

    # Re-fetch user inside this session for accuracy
    user_result = await session.execute(select(db.User).where(db.User.id == current_user.id))
    user = user_result.scalar_one()

    if user.balance < total_needed:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Insufficient balance. Need {total_needed:.6f} GRIN, have {user.balance:.6f} GRIN",
        )

    # Deduct from spendable, add to locked
    user.balance -= total_needed
    user.balance_locked += total_needed
    await session.flush()

    # Initiate wallet send
    try:
        import asyncio
        slatepack, tx_id = await asyncio.to_thread(w.init_send, _cfg, body.grin_address, body.amount)
    except Exception as exc:
        # Rollback balance adjustment
        user.balance += total_needed
        user.balance_locked -= total_needed
        await session.flush()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Wallet error: {exc}",
        )

    now = datetime.utcnow()
    wd = db.Withdrawal(
        user_id=user.id,
        amount=body.amount,
        fee=fee,
        tx_slate_id=tx_id,
        slatepack_out=slatepack,
        status="waiting_finalize",
        created_at=now,
        expires_at=now + timedelta(minutes=5),
    )
    session.add(wd)
    await session.flush()

    return {
        "withdrawal_id": wd.id,
        "slatepack": slatepack,
        "expires_at": wd.expires_at.isoformat(),
    }


@app.post("/api/user/finalize")
async def finalize_withdrawal(
    body: FinalizeRequest,
    current_user: db.User = Depends(_get_current_user),
    session: AsyncSession = Depends(db.get_session),
):
    result = await session.execute(
        select(db.Withdrawal).where(db.Withdrawal.id == body.withdrawal_id)
    )
    wd: Optional[db.Withdrawal] = result.scalar_one_or_none()

    if wd is None or wd.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Withdrawal not found")
    if wd.status != "waiting_finalize":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Withdrawal is in '{wd.status}' state, cannot finalize",
        )
    if wd.expires_at and datetime.utcnow() > wd.expires_at:
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="Withdrawal has expired",
        )

    wd.slatepack_in = body.response_slate

    import asyncio
    tx_id = await asyncio.to_thread(w.finalize, _cfg, body.response_slate)

    wd.status = "confirmed"
    wd.finalized_at = datetime.utcnow()
    if tx_id:
        wd.tx_slate_id = tx_id

    # Release locked balance (the deduction already happened at withdraw time)
    user_result = await session.execute(select(db.User).where(db.User.id == current_user.id))
    user = user_result.scalar_one()
    user.balance_locked -= (wd.amount + wd.fee)
    await session.flush()

    return {"status": "confirmed", "tx_slate_id": wd.tx_slate_id}


@app.put("/api/user/profile")
async def update_profile(
    body: ProfileUpdate,
    current_user: db.User = Depends(_get_current_user),
    session: AsyncSession = Depends(db.get_session),
):
    user_result = await session.execute(select(db.User).where(db.User.id == current_user.id))
    user = user_result.scalar_one()
    if body.grin_address is not None:
        user.grin_address = body.grin_address
    await session.flush()
    return {"status": "ok", "grin_address": user.grin_address}


# ---------------------------------------------------------------------------
# ADMIN ENDPOINTS
# ---------------------------------------------------------------------------

@app.get("/api/admin/health")
async def admin_health(
    _: db.User = Depends(_get_admin_user),
    session: AsyncSession = Depends(db.get_session),
):
    """Full system health report for admins."""
    import shutil
    import psutil  # optional — skip gracefully if not installed

    node_ok, node_height = _check_node_synced(_cfg.get("node_api_port", 3413))
    stratum_ok = _check_stratum_listening(_cfg.get("stratum_port", 3416))

    # Wallet balance probe
    wallet_ok = False
    try:
        import asyncio
        bal = await asyncio.to_thread(w.get_balance, _cfg)
        wallet_ok = True
    except Exception:
        bal = 0.0

    # Nginx probe (port 80)
    nginx_ok = _check_stratum_listening(80)

    # System metrics
    disk_free_gb: Optional[float] = None
    memory_used_pct: Optional[float] = None
    load_avg_1m: Optional[float] = None
    try:
        disk = shutil.disk_usage("/")
        disk_free_gb = round(disk.free / 1e9, 2)
        import psutil as _psutil  # type: ignore
        memory_used_pct = _psutil.virtual_memory().percent
        load_avg_1m = round(_psutil.getloadavg()[0], 2)
    except Exception:
        pass

    stats = await rewards.get_pool_stats_totals(session)
    last_min: Optional[float] = None
    if stats["last_block_found"]:
        delta = datetime.utcnow() - stats["last_block_found"]
        last_min = round(delta.total_seconds() / 60, 1)

    # Active locations
    loc_result = await session.execute(select(db.PoolLocation))
    locations = [
        {"id": loc.id, "region": loc.region, "is_active": loc.is_active}
        for loc in loc_result.scalars().all()
    ]

    return {
        "services": {
            "pool_manager": True,
            "grin_node": node_ok,
            "stratum": stratum_ok,
            "grin_wallet": wallet_ok,
            "nginx": nginx_ok,
            "database": True,
        },
        "system": {
            "disk_free_gb": disk_free_gb,
            "memory_used_pct": memory_used_pct,
            "load_avg_1m": load_avg_1m,
        },
        "pool": {
            "total_unclaimed_grin": stats["total_unclaimed"],
            "pending_withdrawals": stats["pending_withdrawals"],
            "last_block_found_min": last_min,
        },
        "locations": locations,
    }


@app.get("/api/admin/stats")
async def admin_stats(
    _: db.User = Depends(_get_admin_user),
    session: AsyncSession = Depends(db.get_session),
):
    stats = await rewards.get_pool_stats_totals(session)

    total_bal_result = await session.execute(select(func.sum(db.User.balance)))
    total_balance: float = total_bal_result.scalar_one() or 0.0

    total_locked_result = await session.execute(select(func.sum(db.User.balance_locked)))
    total_locked: float = total_locked_result.scalar_one() or 0.0

    user_count_result = await session.execute(select(func.count(db.User.id)))
    user_count: int = user_count_result.scalar_one() or 0

    block_count_result = await session.execute(select(func.count(db.Block.id)))
    block_count: int = block_count_result.scalar_one() or 0

    return {
        **stats,
        "total_user_balance": round(total_balance, 6),
        "total_locked_balance": round(total_locked, 6),
        "user_count": user_count,
        "block_count": block_count,
    }


@app.get("/api/admin/users")
async def admin_users(
    page: int = 1,
    limit: int = 50,
    _: db.User = Depends(_get_admin_user),
    session: AsyncSession = Depends(db.get_session),
):
    offset = (max(1, page) - 1) * limit
    result = await session.execute(
        select(db.User).order_by(db.User.id.asc()).offset(offset).limit(limit)
    )
    users = result.scalars().all()
    total_result = await session.execute(select(func.count(db.User.id)))
    total: int = total_result.scalar_one() or 0
    return {
        "total": total,
        "page": page,
        "limit": limit,
        "users": [
            {
                "id": u.id,
                "username": u.username,
                "email": u.email,
                "balance": u.balance,
                "balance_locked": u.balance_locked,
                "fee_exempt": u.fee_exempt,
                "is_admin": u.is_admin,
                "is_active": u.is_active,
                "created_at": u.created_at.isoformat() if u.created_at else None,
                "last_login": u.last_login.isoformat() if u.last_login else None,
            }
            for u in users
        ],
    }


@app.put("/api/admin/users/{user_id}")
async def admin_update_user(
    user_id: int,
    body: UserUpdate,
    _: db.User = Depends(_get_admin_user),
    session: AsyncSession = Depends(db.get_session),
):
    result = await session.execute(select(db.User).where(db.User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    if body.fee_exempt is not None:
        user.fee_exempt = body.fee_exempt
    if body.is_admin is not None:
        user.is_admin = body.is_admin
    if body.is_active is not None:
        user.is_active = body.is_active
    await session.flush()
    return {"status": "ok", "user_id": user_id}


@app.post("/api/admin/users/{user_id}/inject", status_code=status.HTTP_201_CREATED)
async def admin_inject_balance(
    user_id: int,
    body: InjectRequest,
    _: db.User = Depends(_get_admin_user),
    session: AsyncSession = Depends(db.get_session),
):
    """Direct balance injection — only permitted on testnet."""
    if _cfg.get("network", "mainnet") != "testnet":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Balance injection is only allowed on testnet",
        )
    result = await session.execute(select(db.User).where(db.User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    user.balance += body.amount
    await session.flush()
    log.info("Admin injected %.6f GRIN into user %d (testnet)", body.amount, user_id)
    return {"status": "ok", "new_balance": round(user.balance, 6)}


@app.get("/api/admin/miners")
async def admin_miners(
    _: db.User = Depends(_get_admin_user),
    session: AsyncSession = Depends(db.get_session),
):
    result = await session.execute(
        select(db.Miner).order_by(db.Miner.last_seen.desc().nullslast())
    )
    miners = result.scalars().all()
    return [
        {
            "id": m.id,
            "user_id": m.user_id,
            "worker_name": m.worker_name,
            "is_online": m.is_online,
            "hashrate_1h": m.hashrate_1h,
            "hashrate_24h": m.hashrate_24h,
            "last_seen": m.last_seen.isoformat() if m.last_seen else None,
        }
        for m in miners
    ]


@app.get("/api/admin/withdrawals")
async def admin_withdrawals(
    status_filter: Optional[str] = None,
    _: db.User = Depends(_get_admin_user),
    session: AsyncSession = Depends(db.get_session),
):
    query = select(db.Withdrawal).order_by(db.Withdrawal.created_at.desc())
    if status_filter:
        query = query.where(db.Withdrawal.status == status_filter)
    result = await session.execute(query)
    wds = result.scalars().all()
    return [
        {
            "id": wd.id,
            "user_id": wd.user_id,
            "amount": wd.amount,
            "fee": wd.fee,
            "status": wd.status,
            "tx_slate_id": wd.tx_slate_id,
            "created_at": wd.created_at.isoformat() if wd.created_at else None,
            "expires_at": wd.expires_at.isoformat() if wd.expires_at else None,
            "finalized_at": wd.finalized_at.isoformat() if wd.finalized_at else None,
        }
        for wd in wds
    ]


@app.post("/api/admin/pay/{withdrawal_id}")
async def admin_pay(
    withdrawal_id: int,
    _: db.User = Depends(_get_admin_user),
    session: AsyncSession = Depends(db.get_session),
):
    """Manually finalize a stuck withdrawal using its stored response slate."""
    result = await session.execute(
        select(db.Withdrawal).where(db.Withdrawal.id == withdrawal_id)
    )
    wd: Optional[db.Withdrawal] = result.scalar_one_or_none()
    if wd is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Withdrawal not found")
    if not wd.slatepack_in:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No response slate on file for this withdrawal",
        )

    import asyncio
    tx_id = await asyncio.to_thread(w.finalize, _cfg, wd.slatepack_in)

    wd.status = "confirmed"
    wd.finalized_at = datetime.utcnow()
    if tx_id:
        wd.tx_slate_id = tx_id
    await session.flush()

    return {"status": "confirmed", "tx_slate_id": wd.tx_slate_id}


@app.get("/api/admin/locations")
async def admin_get_locations(
    _: db.User = Depends(_get_admin_user),
    session: AsyncSession = Depends(db.get_session),
):
    result = await session.execute(select(db.PoolLocation).order_by(db.PoolLocation.id))
    locs = result.scalars().all()
    return [
        {
            "id": loc.id,
            "region": loc.region,
            "subdomain": loc.subdomain,
            "stratum_port": loc.stratum_port,
            "api_url": loc.api_url,
            "is_active": loc.is_active,
        }
        for loc in locs
    ]


@app.post("/api/admin/locations", status_code=status.HTTP_201_CREATED)
async def admin_create_location(
    body: LocationCreate,
    _: db.User = Depends(_get_admin_user),
    session: AsyncSession = Depends(db.get_session),
):
    loc = db.PoolLocation(
        region=body.region,
        subdomain=body.subdomain,
        stratum_port=body.stratum_port,
        api_url=body.api_url,
        is_active=body.is_active,
    )
    session.add(loc)
    await session.flush()
    return {"status": "ok", "id": loc.id}


@app.delete("/api/admin/locations/{location_id}", status_code=status.HTTP_200_OK)
async def admin_delete_location(
    location_id: int,
    _: db.User = Depends(_get_admin_user),
    session: AsyncSession = Depends(db.get_session),
):
    result = await session.execute(
        select(db.PoolLocation).where(db.PoolLocation.id == location_id)
    )
    loc = result.scalar_one_or_none()
    if loc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Location not found")
    await session.delete(loc)
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Entry point (for running directly with `python main.py`)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    _boot_cfg = cfg_mod.load()
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=_boot_cfg.get("service_port", 3002),
        reload=False,
        log_level="info",
    )
