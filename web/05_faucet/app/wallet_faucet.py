"""
wallet_faucet.py — grin-wallet CLI integration for the testnet faucet.

All commands use --testnet. The wallet binary is expected at:
    <cfg["wallet_dir"]>/grin-wallet-faucet-bin

Password is read from /opt/grin/faucet/.wallet_pass_faucet (600 perms).
"""

import os
import re
import subprocess
from config_faucet import get_wallet_password


def _bin(cfg: dict) -> str:
    return os.path.join(cfg["wallet_dir"], "grin-wallet-faucet-bin")


def _run(cmd: list, cwd: str, timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        cwd=cwd,
        timeout=timeout,
    )


def _base_cmd(cfg: dict) -> list:
    password = get_wallet_password()
    cmd = [_bin(cfg), "--testnet"]
    if password:
        cmd += ["-p", password]
    return cmd


def get_balance(cfg: dict) -> float:
    """Return spendable balance in GRIN (float). Raises RuntimeError on failure."""
    cmd = _base_cmd(cfg) + ["info", "--output-format", "json"]
    result = _run(cmd, cfg["wallet_dir"])
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "grin-wallet info failed")

    import json
    try:
        data = json.loads(result.stdout)
        nano = int(data.get("amount_currently_spendable", 0))
        return nano / 1_000_000_000
    except (json.JSONDecodeError, KeyError, ValueError):
        # Fallback: parse text output  "Currently Spendable: X.XXX"
        match = re.search(r"Currently Spendable:\s+([\d.]+)", result.stdout)
        if match:
            return float(match.group(1))
        raise RuntimeError("Could not parse wallet balance")


def get_address(cfg: dict) -> str:
    """Return the wallet's slatepack address (tgrin1... or grin1...). Raises on failure."""
    cmd = _base_cmd(cfg) + ["address"]
    result = _run(cmd, cfg["wallet_dir"])
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "grin-wallet address failed")

    # Address appears on its own line: "grin1..." or "tgrin1..."
    for line in result.stdout.splitlines():
        line = line.strip()
        if re.match(r"^(grin1|tgrin1)[a-z0-9]+$", line):
            return line
    raise RuntimeError("Could not parse wallet address from output")


def init_send(cfg: dict, recipient_address: str, amount: float) -> tuple[str, str]:
    """
    Initiate a send to recipient_address for amount GRIN.
    Returns (slatepack_text, tx_slate_id).
    slatepack_text is the BEGINSLATEPACK...ENDSLATEPACK block to show the user.
    """
    cmd = _base_cmd(cfg) + [
        "send",
        "-d", recipient_address,
        "-a", str(amount),
    ]
    result = _run(cmd, cfg["wallet_dir"], timeout=90)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "grin-wallet send failed")

    output = result.stdout
    slatepack = _extract_slatepack(output)
    if not slatepack:
        raise RuntimeError("No slatepack found in grin-wallet send output")

    # Try to extract tx slate id (UUID-like) from output
    tx_id = ""
    match = re.search(r"[Tt]x [Ss]late [Ii][Dd]:\s*([0-9a-f-]{36})", output)
    if match:
        tx_id = match.group(1)

    return slatepack, tx_id


def finalize(cfg: dict, response_slate: str) -> str:
    """
    Finalize the transaction from user's response slatepack.
    Returns tx_slate_id extracted from output, or empty string.
    Raises RuntimeError if grin-wallet finalize fails.
    """
    cmd = _base_cmd(cfg) + ["finalize", "-m", response_slate]
    result = _run(cmd, cfg["wallet_dir"], timeout=90)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "grin-wallet finalize failed")

    tx_id = ""
    match = re.search(r"[Tt]x [Ss]late [Ii][Dd]:\s*([0-9a-f-]{36})", result.stdout)
    if match:
        tx_id = match.group(1)
    return tx_id


# ── Internal ─────────────────────────────────────────────────────────────────

def _extract_slatepack(text: str) -> str:
    """Extract BEGINSLATEPACK...ENDSLATEPACK from grin-wallet output."""
    start = text.find("BEGINSLATEPACK")
    end = text.find("ENDSLATEPACK")
    if start == -1 or end == -1:
        return ""
    return text[start: end + len("ENDSLATEPACK")].strip()
