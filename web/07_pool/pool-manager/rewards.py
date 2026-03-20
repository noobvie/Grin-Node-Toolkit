"""
rewards.py — Block reward distribution for the Grin Pool Manager.

After a block is found, all shares since the previous block are tallied and
each contributing miner receives a proportional slice of the block reward
(minus the pool fee).
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from database import Block, Share, User, Withdrawal

log = logging.getLogger(__name__)

# Standard Grin block reward (ProgPoW era default)
BLOCK_REWARD_GRIN = 60.0


async def distribute_block_reward(block_id: int, session: AsyncSession) -> None:
    """
    Distribute the reward for *block_id* proportionally among all users
    who have unearned shares attached to that block.

    Steps:
      1. Fetch block + pool fee from config (imported lazily).
      2. Sum share weights per user for this block.
      3. Compute each user's earned portion.
      4. Credit user.balance and stamp each Share.earned_grin.
    """
    # Fetch block record
    result = await session.execute(select(Block).where(Block.id == block_id))
    block: Optional[Block] = result.scalar_one_or_none()
    if block is None:
        log.warning("distribute_block_reward: block_id=%d not found", block_id)
        return

    gross_reward: float = block.reward if block.reward else BLOCK_REWARD_GRIN

    # Load pool fee from config (avoid hard import at module level)
    import config as cfg_mod
    cfg = cfg_mod.load()
    fee_pct: float = float(cfg.get("pool_fee_percent", 0.0))
    net_reward: float = gross_reward * (1.0 - fee_pct / 100.0)

    # Fetch all shares for this block that haven't been assigned earnings yet
    shares_result = await session.execute(
        select(Share).where(Share.block_id == block_id, Share.earned_grin == 0.0)
    )
    shares: list[Share] = list(shares_result.scalars().all())

    if not shares:
        log.info("distribute_block_reward: no unearned shares for block %d", block_id)
        return

    # Sum total weight
    total_weight: float = sum(s.share_weight for s in shares)
    if total_weight <= 0:
        log.warning("distribute_block_reward: total share weight is 0 for block %d", block_id)
        return

    # Group shares by user_id
    user_shares: dict[Optional[int], list[Share]] = {}
    for share in shares:
        user_shares.setdefault(share.user_id, []).append(share)

    log.info(
        "Distributing %.4f GRIN (block %d, fee %.2f%%) among %d users / %d shares",
        net_reward,
        block_id,
        fee_pct,
        len(user_shares),
        len(shares),
    )

    for user_id, user_share_list in user_shares.items():
        user_weight: float = sum(s.share_weight for s in user_share_list)
        earned: float = net_reward * (user_weight / total_weight)
        per_share: float = earned / len(user_share_list)

        # Stamp each share
        for share in user_share_list:
            share.earned_grin = per_share

        # Credit user balance
        if user_id is not None:
            await session.execute(
                update(User)
                .where(User.id == user_id)
                .values(balance=User.balance + earned)
            )
            log.debug(
                "User %d credited %.6f GRIN for block %d",
                user_id,
                earned,
                block_id,
            )

    await session.flush()
    log.info("Block %d reward distribution complete", block_id)


async def get_pool_stats_totals(session: AsyncSession) -> dict:
    """
    Return aggregate pool-level statistics:

      - total_unclaimed:      sum of all user balances
      - pending_withdrawals:  count of withdrawals with status = 'waiting_finalize'
      - last_block_found:     datetime of the most recently found block (or None)
    """
    # Sum all spendable user balances
    bal_result = await session.execute(select(func.sum(User.balance)))
    total_unclaimed: float = bal_result.scalar_one() or 0.0

    # Count pending withdrawals
    pending_result = await session.execute(
        select(func.count(Withdrawal.id)).where(
            Withdrawal.status == "waiting_finalize"
        )
    )
    pending_withdrawals: int = pending_result.scalar_one() or 0

    # Most recent block
    block_result = await session.execute(
        select(Block.found_at).order_by(Block.found_at.desc()).limit(1)
    )
    row = block_result.first()
    last_block_found: Optional[datetime] = row[0] if row else None

    return {
        "total_unclaimed": round(total_unclaimed, 6),
        "pending_withdrawals": pending_withdrawals,
        "last_block_found": last_block_found,
    }
