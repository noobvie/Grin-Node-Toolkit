"""
config.py — Load and save the Grin Pool Manager configuration.

Config file location (in priority order):
  1. Argument passed to load() / save()
  2. Environment variable GRIN_POOL_CONF
  3. Default: /opt/grin/conf/grin_pool.json
"""

import json
import os
import stat
import logging

log = logging.getLogger(__name__)

DEFAULT_CONF_PATH = "/opt/grin/conf/grin_pool.json"

DEFAULTS: dict = {
    "pool_name": "My Grin Pool",
    "subdomain": "",
    "network": "mainnet",
    "stratum_port": 3416,
    "node_api_port": 3413,
    "pool_fee_percent": 0.0,
    "min_withdrawal": 2.0,
    "withdrawal_fee": 0.0,
    "pool_type": "personal",
    "locations": [],
    "grin_wallet_dir": "/opt/grin/wallet/mainnet",
    "log_path": "/opt/grin/logs/grin-pool.log",
    "jwt_secret": "",
    "jwt_access_expire_minutes": 60,
    "jwt_refresh_expire_days": 7,
    "service_port": 3002,
    "db_url": "sqlite+aiosqlite:////opt/grin/pool/mainnet/pool.db",
    "wallet_pass_file": "/opt/grin/pool/mainnet/wallet_pass",
}


def _resolve_path(conf_path: str | None) -> str:
    """Return the effective config file path."""
    if conf_path:
        return conf_path
    env = os.environ.get("GRIN_POOL_CONF", "").strip()
    if env:
        return env
    return DEFAULT_CONF_PATH


def load(conf_path: str | None = None) -> dict:
    """
    Load the pool config from disk.

    Merges file values on top of DEFAULTS so every key is always present.
    Returns a dict.
    """
    path = _resolve_path(conf_path)
    cfg: dict = dict(DEFAULTS)
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                on_disk = json.load(fh)
            cfg.update(on_disk)
        except Exception as exc:
            log.warning("Failed to load config from %s: %s — using defaults", path, exc)
    else:
        log.info("Config file not found at %s — using defaults", path)
    return cfg


def save(cfg: dict, conf_path: str | None = None) -> None:
    """
    Persist *cfg* to disk as pretty-printed JSON.

    Creates parent directories if they do not exist.
    """
    path = _resolve_path(conf_path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, indent=2)
        log.info("Config saved to %s", path)
    except Exception as exc:
        log.error("Failed to save config to %s: %s", path, exc)
        raise


def get_wallet_password(cfg: dict) -> str:
    """
    Read the wallet password from the pass-file defined in *cfg*.

    The file must be chmod 600 (owner-read-only). Returns "" on any error.
    """
    pass_file = cfg.get("wallet_pass_file", "")
    if not pass_file:
        return ""
    if not os.path.isfile(pass_file):
        log.debug("Wallet password file not found: %s", pass_file)
        return ""
    try:
        file_stat = os.stat(pass_file)
        mode = stat.S_IMODE(file_stat.st_mode)
        if mode != 0o600:
            log.warning(
                "Wallet password file %s has mode %o (expected 600) — proceeding anyway",
                pass_file,
                mode,
            )
        with open(pass_file, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except Exception as exc:
        log.error("Could not read wallet password from %s: %s", pass_file, exc)
        return ""


def is_testnet(cfg: dict) -> bool:
    """Return True when the pool is running on Grin's testnet (floonet)."""
    db_url: str = cfg.get("db_url", "")
    return "testnet" in db_url.lower()
