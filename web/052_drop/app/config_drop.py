"""
config_drop.py — Load and update /opt/grin/drop-<net>/grin_drop.conf
"""

import json
import os

CONF_PATH = os.environ.get("DROP_CONF", "/opt/grin/drop-test/grin_drop.conf")
PASS_PATH = os.environ.get("DROP_WALLET_PASS", "/opt/grin/drop-test/.wallet_pass")

DEFAULTS = {
    "drop_name":              "Grin Drop",
    "site_description":       "Claim free GRIN or donate to keep the drop running.",
    "og_image_url":           "",
    "subdomain":              "",
    "claim_amount_grin":      2.0,
    "claim_window_hours":     24,
    "wallet_dir":             "/opt/grin/drop-test/wallet",
    "wallet_port":            3004,
    "service_port":           3004,
    "finalize_timeout_min":   5,
    "wallet_address":         "",
    "giveaway_enabled":       True,
    "donation_enabled":       True,
    "show_public_stats":      True,
    "admin_secret_path":      "",
    "admin_htuser":           "admin",
    "maintenance_mode":       False,
    "maintenance_message":    "We'll be back soon. Thank you for your patience.",
    "theme_default":          "matrix",
    "log_path":               "/opt/grin/drop-test/drop-activity.log",
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
