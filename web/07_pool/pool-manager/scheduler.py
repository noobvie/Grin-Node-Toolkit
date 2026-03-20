"""
scheduler.py — APScheduler background job wiring for the Grin Pool Manager.

Jobs:
  every 10s  — StratumMonitor.tick()  (parse new log lines)
  every 20s  — rewards distribution check (no-op if already done by monitor)
  every 5min — hashrate snapshot to hashrate_history
  every 30s  — cancel expired waiting_finalize withdrawals
  every 60s  — aggregate stats from remote pool locations (stub)
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import TYPE_CHECKING

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, AsyncSession

from database import HashrateHistory, Miner, User, Withdrawal

if TYPE_CHECKING:
    from monitor import StratumMonitor

log = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()


# ---------------------------------------------------------------------------
# Public setup entry-point
# ---------------------------------------------------------------------------

def setup_scheduler(
    cfg: dict,
    monitor: "StratumMonitor",
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """
    Register all background jobs and start the scheduler.

    Should be called once during application startup after the DB is ready.
    """

    # --- 10 s: parse stratum log -------------------------------------------
    async def _tick() -> None:
        async with session_factory() as session:
            try:
                await monitor.tick(session)
                await session.commit()
            except Exception as exc:
                await session.rollback()
                log.error("monitor.tick error: %s", exc)

    scheduler.add_job(_tick, "interval", seconds=10, id="stratum_tick", max_instances=1)

    # --- 20 s: rewards distribution check -----------------------------------
    # The monitor already triggers distribute_block_reward when it sees a new
    # block. This job serves as a safety net in case the monitor missed a line
    # (e.g., after a restart) — it re-runs distribution for any block whose
    # shares are still unearned.
    async def _rewards_check() -> None:
        from rewards import distribute_block_reward
        from database import Block, Share
        from sqlalchemy import func

        async with session_factory() as session:
            try:
                # Find blocks that still have shares with earned_grin == 0
                subq = (
                    select(Share.block_id)
                    .where(Share.block_id != None, Share.earned_grin == 0.0)  # noqa: E711
                    .distinct()
                    .scalar_subquery()
                )
                result = await session.execute(select(Block.id).where(Block.id.in_(subq)))
                block_ids = [row[0] for row in result.all()]
                for bid in block_ids:
                    await distribute_block_reward(bid, session)
                if block_ids:
                    await session.commit()
            except Exception as exc:
                await session.rollback()
                log.error("rewards_check error: %s", exc)

    scheduler.add_job(
        _rewards_check, "interval", seconds=20, id="rewards_check", max_instances=1
    )

    # --- 5 min: hashrate snapshot -------------------------------------------
    async def _snapshot() -> None:
        await _snapshot_hashrate(session_factory)

    scheduler.add_job(
        _snapshot, "interval", minutes=5, id="hashrate_snapshot", max_instances=1
    )

    # --- 30 s: withdrawal timeout check -------------------------------------
    async def _timeouts() -> None:
        await _check_withdrawal_timeouts(session_factory)

    scheduler.add_job(
        _timeouts, "interval", seconds=30, id="withdrawal_timeouts", max_instances=1
    )

    # --- 60 s: remote location stats aggregation ----------------------------
    async def _remote_stats() -> None:
        await _aggregate_remote_locations(cfg, session_factory)

    scheduler.add_job(
        _remote_stats, "interval", seconds=60, id="remote_stats", max_instances=1
    )

    scheduler.start()
    log.info("Scheduler started with %d jobs", len(scheduler.get_jobs()))


# ---------------------------------------------------------------------------
# Job implementations
# ---------------------------------------------------------------------------

async def _check_withdrawal_timeouts(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """
    Cancel withdrawals that are stuck in 'waiting_finalize' past their
    expires_at timestamp.

    Restores the full locked amount (amount + fee) back to user.balance and
    clears user.balance_locked.
    """
    now = datetime.utcnow()
    async with session_factory() as session:
        try:
            result = await session.execute(
                select(Withdrawal).where(
                    Withdrawal.status == "waiting_finalize",
                    Withdrawal.expires_at != None,       # noqa: E711
                    Withdrawal.expires_at < now,
                )
            )
            expired: list[Withdrawal] = list(result.scalars().all())

            for wd in expired:
                wd.status = "cancelled"
                refund = wd.amount + wd.fee
                await session.execute(
                    update(User)
                    .where(User.id == wd.user_id)
                    .values(
                        balance=User.balance + refund,
                        balance_locked=User.balance_locked - refund,
                    )
                )
                log.info(
                    "Withdrawal %d expired — cancelled, refunded %.6f GRIN to user %d",
                    wd.id,
                    refund,
                    wd.user_id,
                )

            if expired:
                await session.commit()
        except Exception as exc:
            await session.rollback()
            log.error("_check_withdrawal_timeouts error: %s", exc)


async def _snapshot_hashrate(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """
    Record a hashrate snapshot for:
      - The entire pool (user_id=NULL, worker_name=NULL)
      - Each individual user (aggregated across their workers)
      - Each individual worker
    """
    async with session_factory() as session:
        try:
            now = datetime.utcnow()

            # All online miners
            result = await session.execute(
                select(Miner).where(Miner.is_online == True)  # noqa: E712
            )
            online_miners: list[Miner] = list(result.scalars().all())

            # Pool total
            total_gps = sum(m.hashrate_1h for m in online_miners)
            pool_snap = HashrateHistory(
                user_id=None,
                worker_name=None,
                recorded_at=now,
                hashrate_gps=total_gps,
                miner_count=len(online_miners),
            )
            session.add(pool_snap)

            # Per-user aggregates
            user_gps: dict[int, float] = {}
            user_count: dict[int, int] = {}
            for m in online_miners:
                if m.user_id is not None:
                    user_gps[m.user_id] = user_gps.get(m.user_id, 0.0) + m.hashrate_1h
                    user_count[m.user_id] = user_count.get(m.user_id, 0) + 1

            for uid, gps in user_gps.items():
                session.add(
                    HashrateHistory(
                        user_id=uid,
                        worker_name=None,
                        recorded_at=now,
                        hashrate_gps=gps,
                        miner_count=user_count[uid],
                    )
                )

            # Per-worker
            for m in online_miners:
                session.add(
                    HashrateHistory(
                        user_id=m.user_id,
                        worker_name=m.worker_name,
                        recorded_at=now,
                        hashrate_gps=m.hashrate_1h,
                        miner_count=1,
                    )
                )

            await session.commit()
            log.debug(
                "Hashrate snapshot: pool=%.2f GPS, %d miners online",
                total_gps,
                len(online_miners),
            )
        except Exception as exc:
            await session.rollback()
            log.error("_snapshot_hashrate error: %s", exc)


async def _aggregate_remote_locations(
    cfg: dict,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """
    Fetch stats from remote pool locations (if any) and update the local DB.

    This is a stub — real implementation would HTTP-GET each location's
    /api/pool/stats endpoint and merge hashrate / miner counts.
    """
    locations: list[dict] = cfg.get("locations", [])
    if not locations:
        return

    import requests  # optional network dependency

    for loc in locations:
        api_url = loc.get("api_url", "")
        if not api_url:
            continue
        try:
            resp = requests.get(f"{api_url}/api/pool/stats", timeout=5)
            if resp.ok:
                data = resp.json()
                log.debug("Remote location %s: %s", api_url, data)
        except Exception as exc:
            log.debug("Could not reach remote location %s: %s", api_url, exc)
