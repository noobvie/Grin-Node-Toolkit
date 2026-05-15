"""
monitor.py — Stratum log parser and miner state tracker for the Grin Pool Manager.

Reads the grin-server log file incrementally (tail-style) every 10 seconds.
Recognised log patterns:

  Login  : "Stratum - Got login from worker: <worker>"
  Share  : "Stratum - share accepted from worker: <worker>"
  Block  : "Mined block at height <N>"

Workers are named "<username>.<N>" (e.g. alice.1). The username portion is used
to look up the pool User record.
"""

from __future__ import annotations

import logging
import os
import re
import socket
import subprocess
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from database import Block, Miner, Share, User

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Regex patterns
# ---------------------------------------------------------------------------

_RE_LOGIN = re.compile(
    r"Stratum\s+-\s+Got\s+login\s+from\s+worker:\s+(\S+)", re.IGNORECASE
)
_RE_SHARE = re.compile(
    r"Stratum\s+-\s+share\s+accepted\s+from\s+worker:\s+(\S+)", re.IGNORECASE
)
_RE_BLOCK = re.compile(
    r"Mined\s+block\s+at\s+height\s+(\d+)", re.IGNORECASE
)

_OFFLINE_AFTER_MINUTES = 10


# ---------------------------------------------------------------------------
# Log path detection
# ---------------------------------------------------------------------------

def _resolve_log_path(cfg: dict) -> str:
    """
    Try to detect the log file from /proc/<pid>/exe for the process listening
    on node_api_port. Falls back to cfg["log_path"].
    """
    fallback: str = cfg.get("log_path", "/opt/grin/logs/grin-server.log")

    # Only meaningful on Linux
    if not os.path.isdir("/proc"):
        return fallback

    port: int = cfg.get("node_api_port", 3413)
    try:
        result = subprocess.run(
            ["ss", "-tlnp", f"sport = :{port}"],
            capture_output=True,
            text=True,
            timeout=3,
        )
        for line in result.stdout.splitlines():
            # Extract pid from e.g. pid=12345,
            m = re.search(r"pid=(\d+)", line)
            if m:
                pid = m.group(1)
                exe_link = f"/proc/{pid}/exe"
                try:
                    exe_path = os.readlink(exe_link)
                    # grin binary is typically next to its data dir
                    bin_dir = os.path.dirname(exe_path)
                    candidate = os.path.join(
                        os.path.dirname(bin_dir), "logs", "grin-server.log"
                    )
                    if os.path.isfile(candidate):
                        log.debug("Detected log path via PID %s: %s", pid, candidate)
                        return candidate
                except (OSError, PermissionError):
                    pass
    except Exception as exc:
        log.debug("Log path auto-detection failed: %s", exc)

    return fallback


# ---------------------------------------------------------------------------
# Main monitor class
# ---------------------------------------------------------------------------

class StratumMonitor:
    """Incremental stratum log parser."""

    def __init__(self, cfg: dict) -> None:
        self.cfg = cfg
        self.log_path: str = _resolve_log_path(cfg)
        self._position: int = 0          # byte offset in log file
        self._last_block_height: int = 0

    # ------------------------------------------------------------------
    # Public API (called by scheduler)
    # ------------------------------------------------------------------

    async def tick(self, session: AsyncSession) -> None:
        """
        Called every ~10 s by the APScheduler job.

        Opens the log file, seeks to the last-known position, reads any new
        lines, and processes login / share / block events.
        """
        if not os.path.isfile(self.log_path):
            log.debug("Log file not found: %s", self.log_path)
            return

        try:
            with open(self.log_path, "r", encoding="utf-8", errors="replace") as fh:
                # If the file was rotated (smaller than our saved position), reset
                fh.seek(0, 2)  # seek to end
                end_pos = fh.tell()
                if end_pos < self._position:
                    log.info("Log file appears rotated — resetting position")
                    self._position = 0

                fh.seek(self._position)
                new_lines = fh.readlines()
                self._position = fh.tell()

            for line in new_lines:
                line = line.rstrip("\n")
                await self._process_line(line, session)

        except OSError as exc:
            log.warning("Could not read stratum log %s: %s", self.log_path, exc)

        await self.update_online_status(session)

    async def update_online_status(self, session: AsyncSession) -> None:
        """Mark miners as offline if last_seen is older than _OFFLINE_AFTER_MINUTES."""
        cutoff = datetime.utcnow() - timedelta(minutes=_OFFLINE_AFTER_MINUTES)
        await session.execute(
            update(Miner)
            .where(Miner.is_online == True, Miner.last_seen < cutoff)  # noqa: E712
            .values(is_online=False)
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _process_line(self, line: str, session: AsyncSession) -> None:
        """Dispatch a single log line to the appropriate handler."""
        m_login = _RE_LOGIN.search(line)
        if m_login:
            await self._on_worker_login(m_login.group(1), session)
            return

        m_share = _RE_SHARE.search(line)
        if m_share:
            await self._on_share_accepted(m_share.group(1), session)
            return

        m_block = _RE_BLOCK.search(line)
        if m_block:
            height = int(m_block.group(1))
            await self._on_block_found(height, session)

    async def _get_or_create_miner(
        self, worker_name: str, session: AsyncSession
    ) -> Miner:
        """Return existing Miner row or create a new one."""
        result = await session.execute(
            select(Miner).where(Miner.worker_name == worker_name)
        )
        miner: Optional[Miner] = result.scalar_one_or_none()

        if miner is None:
            user_id = await self._resolve_user_id(worker_name, session)
            miner = Miner(
                worker_name=worker_name,
                user_id=user_id,
                first_seen=datetime.utcnow(),
            )
            session.add(miner)
            await session.flush()
            log.info("New miner registered: %s (user_id=%s)", worker_name, user_id)

        return miner

    async def _resolve_user_id(
        self, worker_name: str, session: AsyncSession
    ) -> Optional[int]:
        """
        Derive the pool username from the worker name (split on '.').

        "alice.1" → look up User with username "alice".
        Returns None if no matching user is found.
        """
        username = worker_name.split(".")[0]
        result = await session.execute(
            select(User.id).where(User.username == username)
        )
        row = result.first()
        return row[0] if row else None

    async def _on_worker_login(
        self, worker_name: str, session: AsyncSession
    ) -> None:
        """Handle a worker login event — upsert the Miner record."""
        miner = await self._get_or_create_miner(worker_name, session)
        miner.last_seen = datetime.utcnow()
        miner.is_online = True
        # Refresh user_id in case user was created after the miner first appeared
        if miner.user_id is None:
            miner.user_id = await self._resolve_user_id(worker_name, session)
        await session.flush()

    async def _on_share_accepted(
        self, worker_name: str, session: AsyncSession
    ) -> None:
        """Handle an accepted share — record a Share row."""
        miner = await self._get_or_create_miner(worker_name, session)
        miner.last_seen = datetime.utcnow()
        miner.is_online = True
        await session.flush()

        share = Share(
            user_id=miner.user_id,
            share_weight=1.0,
            earned_grin=0.0,
            recorded_at=datetime.utcnow(),
        )
        session.add(share)
        await session.flush()

    async def _on_block_found(self, height: int, session: AsyncSession) -> None:
        """
        Create a Block record when a new height is detected.

        Prevents duplicate processing with _last_block_height guard.
        """
        if height <= self._last_block_height:
            return
        self._last_block_height = height

        # Avoid duplicate DB entries
        existing = await session.execute(
            select(Block).where(Block.height == height)
        )
        if existing.scalar_one_or_none() is not None:
            return

        block = Block(height=height, found_at=datetime.utcnow())
        session.add(block)
        await session.flush()
        log.info("Block found at height %d (id=%d)", height, block.id)

        # Link unassigned shares to this block
        from sqlalchemy import update as sa_update

        await session.execute(
            sa_update(Share)
            .where(Share.block_id == None)  # noqa: E711
            .values(block_id=block.id)
        )
        await session.flush()

        # Trigger reward distribution (imported here to avoid circular imports)
        from rewards import distribute_block_reward
        await distribute_block_reward(block.id, session)
