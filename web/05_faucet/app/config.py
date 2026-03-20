"""
config.py — Load and update /opt/grin/conf/grin_faucet.json
"""

import json
import os

CONF_PATH = os.environ.get("FAUCET_CONF", "/opt/grin/conf/grin_faucet.json")
PASS_PATH = os.environ.get("FAUCET_WALLET_PASS", "/opt/grin/faucet/.wallet_pass")

DEFAULTS = {
    "faucet_name":          "Grin Testnet Faucet",
    "subdomain":            "",
    "claim_amount_grin":    2.0,
    "claim_window_hours":   24,
    "wallet_dir":           "/opt/grin/wallet/testnet",
    "wallet_port":          13415,
    "service_port":         3004,
    "finalize_timeout_min": 5,
    "wallet_address":       "",
    "log_path":             "/opt/grin/logs/grin-faucet-activity.log",
}


def load() -> dict:
    """Load config, filling in missing keys with defaults."""
    cfg = dict(DEFAULTS)
    if os.path.isfile(CONF_PATH):
        try:
            with open(CONF_PATH, "r") as f:
                cfg.update(json.load(f))
        except (json.JSONDecodeError, OSError):
            pass
    return cfg


def save(cfg: dict) -> None:
    os.makedirs(os.path.dirname(CONF_PATH), exist_ok=True)
    with open(CONF_PATH, "w") as f:
        json.dump(cfg, f, indent=2)
    os.chmod(CONF_PATH, 0o600)


def get_wallet_password() -> str:
    """Read wallet password from secrets file (600 perms, owned by service user)."""
    if os.path.isfile(PASS_PATH):
        with open(PASS_PATH, "r") as f:
            return f.read().strip()
    return ""
