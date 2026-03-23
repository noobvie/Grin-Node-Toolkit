"""
wallet.py — grin-wallet CLI integration for the Grin Pool Manager.

All subprocess calls run synchronously; wrap in asyncio.to_thread() if you
need them non-blocking from an async context.

Mainnet:  grin-wallet [-p <pass>] <command>
Testnet:  grin-wallet --floonet [-p <pass>] <command>
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
from typing import Optional

import config

log = logging.getLogger(__name__)

# Timeout for grin-wallet subprocesses (seconds)
_CMD_TIMEOUT = 60


# ---------------------------------------------------------------------------
# Command builder helpers
# ---------------------------------------------------------------------------

def _bin(cfg: dict) -> str:
    """Absolute path to the grin-wallet binary."""
    return os.path.join(cfg.get("grin_wallet_dir", "/opt/grin/wallet/mainnet"), "grin-wallet")


def _base_cmd(cfg: dict) -> list[str]:
    """
    Build the common prefix for every grin-wallet invocation:

      grin-wallet [--floonet] [-p <password>]
    """
    password = config.get_wallet_password(cfg)
    cmd: list[str] = [_bin(cfg)]
    if config.is_testnet(cfg):
        cmd.append("--floonet")
    if password:
        cmd += ["-p", password]
    return cmd


def _run(cmd: list[str], input_text: Optional[str] = None) -> str:
    """
    Execute *cmd* and return stdout as a string.

    Raises RuntimeError on non-zero exit or timeout.
    """
    log.debug("Running: %s", " ".join(cmd[:3]) + " ...")  # avoid logging password
    try:
        proc = subprocess.run(
            cmd,
            input=input_text,
            capture_output=True,
            text=True,
            timeout=_CMD_TIMEOUT,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"grin-wallet command timed out after {_CMD_TIMEOUT}s") from exc

    if proc.returncode != 0:
        stderr = proc.stderr.strip()
        raise RuntimeError(
            f"grin-wallet exited with code {proc.returncode}: {stderr}"
        )
    return proc.stdout


# ---------------------------------------------------------------------------
# Slatepack extraction
# ---------------------------------------------------------------------------

def _extract_slatepack(text: str) -> str:
    """
    Extract the raw slatepack message from *text*.

    Looks for the BEGINSLATEPACK / ENDSLATEPACK markers and returns the
    content (inclusive of both markers). Returns "" if not found.
    """
    begin_marker = "BEGINSLATEPACK"
    end_marker = "ENDSLATEPACK"
    start = text.find(begin_marker)
    end = text.find(end_marker)
    if start == -1 or end == -1:
        return ""
    return text[start: end + len(end_marker)].strip()


def _extract_tx_slate_id(text: str) -> str:
    """
    Extract a UUID-style tx_slate_id from *text* using a simple regex.

    Returns "" if none found.
    """
    m = re.search(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        text,
        re.IGNORECASE,
    )
    return m.group(0) if m else ""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_balance(cfg: dict) -> float:
    """
    Query the wallet's spendable balance.

    Runs: grin-wallet info --output-format json
    Returns the ``amount_currently_spendable`` field divided by 1e9 (nanoGRIN → GRIN).
    Returns 0.0 on any error.
    """
    cmd = _base_cmd(cfg) + ["info", "--output-format", "json"]
    try:
        output = _run(cmd)
        # The wallet may prefix the JSON with status lines; find the first '{'
        json_start = output.find("{")
        if json_start == -1:
            log.warning("get_balance: no JSON in wallet output")
            return 0.0
        data = json.loads(output[json_start:])
        # Navigate to the balance field (structure may vary by wallet version)
        spendable: float = (
            data.get("amount_currently_spendable")
            or data.get("output_heads", {}).get("amount_currently_spendable")
            or 0.0
        )
        return float(spendable) / 1_000_000_000.0
    except Exception as exc:
        log.error("get_balance failed: %s", exc)
        return 0.0


def init_send(cfg: dict, recipient: str, amount: float) -> tuple[str, str]:
    """
    Initiate a Slatepack send to *recipient* for *amount* GRIN.

    Runs: grin-wallet send -d <recipient> -a <amount>

    Returns:
        (slatepack_text, tx_slate_id)

    Raises RuntimeError on failure.
    """
    cmd = _base_cmd(cfg) + [
        "send",
        "-d", recipient,
        "-a", str(amount),
    ]
    output = _run(cmd)
    slatepack = _extract_slatepack(output)
    if not slatepack:
        log.warning("init_send: no slatepack found in wallet output:\n%s", output[:500])
    tx_id = _extract_tx_slate_id(output)
    log.info("init_send: %.6f GRIN → %s  tx_id=%s", amount, recipient[:20], tx_id)
    return slatepack, tx_id


def finalize(cfg: dict, response_slate: str) -> str:
    """
    Finalize a transaction by passing the receiver's response slatepack back
    to the wallet.

    Runs: grin-wallet finalize -m <response_slate>

    Returns the tx_slate_id extracted from the output, or "" on failure.
    """
    cmd = _base_cmd(cfg) + ["finalize", "-m", response_slate]
    try:
        output = _run(cmd)
        tx_id = _extract_tx_slate_id(output)
        log.info("finalize: tx_id=%s", tx_id)
        return tx_id
    except Exception as exc:
        log.error("finalize failed: %s", exc)
        return ""
