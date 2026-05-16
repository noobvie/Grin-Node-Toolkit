# Pool Configuration Schema

**Purpose:** Define all configurable settings for a user-deployed Grin mining pool. These settings are customizable via the **Admin Web Interface** only — operators log in and adjust them without restarting services.

**Storage:** `/opt/grin/conf/grin_pool.json` (JSON format, readable by pool backend)

---

## 1. Basic Pool Settings

**Admin Panel:** Settings → General

| Setting | Type | Default | Range | Notes |
|---------|------|---------|-------|-------|
| `pool_name` | string | "My Grin Pool" | 1-100 chars | Pool display name on public dashboard |
| `pool_description` | string | "" | 0-500 chars | Short description for public page |
| `pool_logo_url` | string | "" | URL or empty | Logo on public dashboard |
| `subdomain` | string | "" | FQDN format | Public domain (e.g., `pool.example.com`). Set by setup script; rarely changed. |
| `network` | enum | "mainnet" | "mainnet" only | (testnet has no web interface) |
| `language` | string | "en" | "en", "es", "fr", etc. | Web UI language (future: i18n) |

**Takes effect:** Immediately (frontend reload)  
**Requires restart:** No

---

## 2. Mining Configuration

**Admin Panel:** Settings → Mining

| Setting | Type | Default | Range | Notes |
|---------|------|---------|-------|-------|
| `stratum_port` | integer | 3416 | 1024-65535 | Port miners connect to (set by script 07) |
| `node_api_port` | integer | 3413 | 1024-65535 | Grin node API port for pool status checks |
| `min_difficulty` | float | 1.0 | 0.1-100 | Minimum share difficulty to accept |
| `max_difficulty` | float | 1000000 | min_diff-10M | Maximum share difficulty (dynamic scaling) |
| `pool_target_block_time` | integer | 60 | 30-300 | Target seconds between blocks for fee calculation |
| `connection_timeout_secs` | integer | 600 | 60-3600 | Kick miner if silent for N seconds |

**Takes effect:** On next miner connect/reconnect  
**Requires restart:** No (except stratum_port — requires grin node restart)

---

## 3. Fee & Reward Settings

**Admin Panel:** Settings → Fees & Rewards

| Setting | Type | Default | Range | Notes |
|---------|------|---------|-------|-------|
| `pool_fee_percent` | float | 0.0 | 0.0-10.0 | Pool fee % of block reward. Set to 0 for no fees (public/community pool). |
| `pool_fee_address` | string | "" | Grin address | Where pool fees go (pool operator wallet). Required if fee_percent > 0. |
| `withdrawal_fee` | float | 0.0 | 0.0-1.0 | Fee per withdrawal transaction (GRIN). Set to 0 for free withdrawals. |
| `min_withdrawal` | float | 2.0 | 0.1-100.0 | Minimum balance to trigger auto-payout (GRIN) |
| `payout_frequency_hours` | integer | 24 | 1-720 | Auto-payout interval (e.g., hourly, daily, weekly) |
| `reward_model` | enum | "pplns" | "pplns", "prop", "solo" | Reward distribution model (see below) |

**Reward Models:**
- **pplns:** Pay-Per-Last-N-Shares (default). Each share within N diff-1 target blocks earns proportional reward. Resistant to pool hopping.
- **prop:** Proportional. Each block, rewards split by share count since last block. Faster payouts, vulnerable to hopping.
- **solo:** Solo mining. Blocks only earned by submitter's own address. Pool is just a stratum interface; no pool fee or sharing.

**Takes effect:** On next payout (for pplns/prop) or next block (for solo)  
**Requires restart:** No

---

## 4. Wallet & Payment Settings

**Admin Panel:** Settings → Wallet & Payments

| Setting | Type | Default | Range | Notes |
|---------|------|---------|-------|-------|
| `grin_wallet_dir` | string | "/opt/grin/wallet/mainnet" | Path | Location of grin-wallet binary/config |
| `wallet_check_interval_secs` | integer | 600 | 60-3600 | How often to check wallet online status before payout |
| `payout_method` | enum | "tor" | "tor" only | Send payouts via Tor (only method supported currently) |
| `tor_socks_proxy` | string | "127.0.0.1:9050" | IP:port | Tor SOCKS proxy for wallet connections |
| `payout_retry_max_days` | integer | 7 | 1-30 | Retry failed payouts for N days before giving up |
| `payout_retry_interval_hours` | integer | 6 | 1-24 | Wait N hours between retry attempts |

**Takes effect:** On next payout cycle  
**Requires restart:** No (wallet_dir change requires restart)

---

## 5. Security & Access Control

**Admin Panel:** Settings → Security

| Setting | Type | Default | Range | Notes |
|---------|------|---------|-------|-------|
| `enable_public_stats` | boolean | true | true/false | Allow unauthenticated access to `/account/<address>` stats page |
| `enable_public_api` | boolean | true | true/false | Allow unauthenticated access to `/api/pool/stats`, `/api/stratum/stats` |
| `jwt_secret` | string | (auto-gen) | — | JWT signing key (generated on first install, never show in UI) |
| `admin_ip_allowlist` | array | [] | IPs/CIDRs or empty | If set, only these IPs can access admin endpoints. CIDR: "192.168.1.0/24", IP: "203.0.113.42" |
| `admin_ip_blacklist` | array | [] | IPs/CIDRs | Block these IPs from accessing admin endpoints. Empty = no blacklist. |
| `rate_limits` | object | see below | — | Per-endpoint rate limits (requests per minute per IP) |
| `rate_limits.public` | integer | 60 | 1-1000 | Rate limit for public `/health` endpoint (allow external monitoring) |
| `rate_limits.auth` | integer | 3 | 1-100 | Rate limit for auth endpoints (prevent brute-force) |
| `rate_limits.api` | integer | 30 | 1-1000 | Rate limit for general API endpoints (queries) |
| `rate_limits.admin` | integer | 10 | 1-100 | Rate limit for admin endpoints (requires IP allowlist) |
| `session_timeout_mins` | integer | 60 | 5-1440 | Admin session timeout (auto-logout after N mins of inactivity) |

**Takes effect:** Immediately (except JWT secret & IP allowlist require service restart)  
**Requires restart:** No (optional for better security: yes for IP list)

---

## 6. Display & Branding (Public Dashboard)

**Admin Panel:** Settings → Branding

| Setting | Type | Default | Range | Notes |
|---------|------|---------|-------|-------|
| `show_block_rewards` | boolean | true | true/false | Display confirmed block rewards on public stats |
| `show_active_miners` | boolean | true | true/false | Show count of active miners on public dashboard |
| `show_hashrate` | boolean | true | true/false | Display estimated hashrate on public dashboard |
| `show_pool_fee` | boolean | true | true/false | Publicly disclose pool fee % |
| `show_estimated_blocks` | boolean | false | true/false | Show estimated blocks until next payout (risky, ETA can vary widely) |
| `custom_css_url` | string | "" | URL or empty | Custom CSS file URL for branding (future feature) |
| `maintenance_mode` | boolean | false | true/false | Show "Under Maintenance" page; block new connections |

**Takes effect:** Immediately (frontend reload)  
**Requires restart:** No

---

## 7. Alerts & Notifications

**Admin Panel:** Settings → Alerts

| Setting | Type | Default | Range | Notes |
|---------|------|---------|-------|-------|
| `alert_check_interval_secs` | integer | 60 | 10-600 | How often to check pool health (seconds) |
| `alert_email_address` | string | "" | Email or empty | Where to send alert emails |
| `alert_types_enabled` | object | see below | — | Which alerts to enable/disable |
| `alert_types_enabled.node_down` | boolean | true | true/false | Alert if node unreachable/out-of-sync |
| `alert_types_enabled.wallet_offline` | boolean | true | true/false | Alert if wallet API unreachable |
| `alert_types_enabled.wallet_balance_low` | boolean | true | true/false | Alert if wallet balance below threshold |
| `alert_types_enabled.block_orphaned` | boolean | true | true/false | Alert if blocks get orphaned |
| `alert_types_enabled.payout_failed` | boolean | true | true/false | Alert if payouts fail |
| `alert_types_enabled.high_rejection_rate` | boolean | true | true/false | Alert if shares rejected > threshold |
| `alert_types_enabled.high_error_rate` | boolean | false | true/false | Alert if API errors > threshold |
| `alert_types_enabled.tor_unreachable` | boolean | true | true/false | Alert if Tor connection fails |
| `alert_types_enabled.difficulty_spike` | boolean | false | true/false | Alert if difficulty changes > threshold |
| `alert_types_enabled.connection_surge` | boolean | false | true/false | Alert if connections spike |
| `alert_thresholds.wallet_balance_warning_grin` | float | 50.0 | 0-∞ | Balance warning threshold (GRIN) |
| `alert_thresholds.rejection_rate_warning_percent` | float | 1.0 | 0-100 | Share rejection rate warning (%) |
| `alert_thresholds.error_rate_warning_percent` | float | 5.0 | 0-100 | API error rate warning (%) |
| `alert_thresholds.difficulty_change_warning_percent` | float | 20.0 | 0-100 | Difficulty change warning (%) |

**Takes effect:** On service restart (alert_check_interval_secs) or immediately (enablement flags)  
**Requires restart:** Yes (for interval changes)

**Delivery Methods:**
- ✅ Dashboard notifications (real-time, in-app)
- 🔧 Email (requires SMTP config)
- 🔧 Discord webhooks (requires webhook URL)
- 🔧 Slack webhooks (requires webhook URL)

---

## 8. External Monitoring (Poolstats Integration)

**Admin Panel:** Settings → External Monitoring

| Setting | Type | Default | Range | Notes |
|---------|------|---------|-------|-------|
| `poolstats_enabled` | boolean | false | true/false | Enable periodic push to miningpoolstats.stream |
| `poolstats_api_key` | string | "" | Secret key or empty | API key from miningpoolstats.stream (never logged or displayed in full) |
| `poolstats_endpoint` | string | "https://api.miningpoolstats.stream/submit" | URL | HTTPS endpoint for submissions (HTTPS-only enforced) |
| `poolstats_interval_mins` | integer | 10 | 5-60 | How often to push stats (minutes) |

**Takes effect:** On service restart  
**Requires restart:** Yes  
**Security:** API key transmitted in HTTPS Authorization header (never in body/URL). File permissions: `0600` (owner only).

**What gets sent to poolstats.stream:**
- Pool name, URL, network (mainnet)
- Pool fee %, active miners, hashrate, blocks found
- Last block height, reward, timestamp
- Reward model (PPLNS/Prop/Solo)
- No sensitive data (wallet addresses, balances, passwords)

---

## 8. Advanced Settings

**Admin Panel:** Settings → Advanced

| Setting | Type | Default | Range | Notes |
|---------|------|---------|-------|-------|
| `enable_testnet` | boolean | false | true/false | Run pool on testnet for testing. TESTNET ONLY, disables mainnet. |
| `log_level` | enum | "info" | "debug", "info", "warn", "error" | Backend logging verbosity |
| `database_vacuum_hours` | integer | 168 | 1-8760 | SQLite VACUUM frequency (optimize DB size) |
| `archive_old_shares_days` | integer | 30 | 7-365 | Delete share records older than N days (save space) |
| `max_workers_per_address` | integer | 100 | 1-10000 | Max concurrent connections per Grin address (DoS protection) |
| `enable_prometheus_metrics` | boolean | false | true/false | Export metrics at `/metrics` for monitoring tools |
| `stripe_api_key` | string | "" | Key or empty | (Future: donations via Stripe) |
| `discord_webhook_url` | string | "" | URL or empty | Post block finds to Discord channel |

**Takes effect:** On service restart (most) or immediately (log_level)  
**Requires restart:** Yes (except log_level)

---

## 8. Stored Automatically (Not User-Editable)

These are set by script 07 during setup and rarely changed:

```json
{
  "service_port": 3002,
  "pool_app_dir": "/opt/grin/pool/mainnet",
  "pool_db_path": "/opt/grin/pool/mainnet/pool.db",
  "pool_log_path": "/opt/grin/logs/grin-pool.log",
  "service_name": "grin-pool-manager",
  "created_at": "2026-05-15T12:34:56Z",
  "toolkit_version": "07.2"
}
```

---

## Sample Configuration File

```json
{
  "pool_name": "Grin Community Pool",
  "pool_description": "Public mining pool for Grin (PPLNS, 1% fee)",
  "pool_logo_url": "https://pool.example.com/img/logo.png",
  "subdomain": "pool.example.com",
  "network": "mainnet",
  "language": "en",

  "alert_check_interval_secs": 60,
  "alert_email_address": "admin@pool.example.com",
  "alert_types_enabled": {
    "node_down": true,
    "wallet_offline": true,
    "wallet_balance_low": true,
    "block_orphaned": true,
    "payout_failed": true,
    "high_rejection_rate": true,
    "high_error_rate": false,
    "tor_unreachable": true,
    "difficulty_spike": false,
    "connection_surge": false
  },
  "alert_thresholds": {
    "wallet_balance_warning_grin": 50.0,
    "rejection_rate_warning_percent": 1.0,
    "error_rate_warning_percent": 5.0,
    "difficulty_change_warning_percent": 20.0
  },
  "smtp": {
    "enabled": false,
    "host": "smtp.example.com",
    "port": 587,
    "secure": true,
    "user": "alerts@pool.example.com",
    "password": "your-password",
    "from": "alerts@pool.example.com"
  },
  "discord_webhook_url": "",
  "slack_webhook_url": "",

  "stratum_port": 3416,
  "node_api_port": 3413,
  "min_difficulty": 1.0,
  "max_difficulty": 1000000.0,
  "pool_target_block_time": 60,
  "connection_timeout_secs": 600,

  "pool_fee_percent": 1.0,
  "pool_fee_address": "grin1abcdef...",
  "withdrawal_fee": 0.001,
  "min_withdrawal": 2.0,
  "payout_frequency_hours": 24,
  "reward_model": "pplns",

  "grin_wallet_dir": "/opt/grin/wallet/mainnet",
  "wallet_check_interval_secs": 600,
  "payout_method": "tor",
  "tor_socks_proxy": "127.0.0.1:9050",
  "payout_retry_max_days": 7,
  "payout_retry_interval_hours": 6,

  "enable_public_stats": true,
  "enable_public_api": true,
  "admin_ip_allowlist": [
    "203.0.113.0/24",
    "198.51.100.42"
  ],
  "admin_ip_blacklist": [],
  "rate_limits": {
    "public": 60,
    "auth": 3,
    "api": 30,
    "admin": 10
  },
  "session_timeout_mins": 60,

  "show_block_rewards": true,
  "show_active_miners": true,
  "show_hashrate": true,
  "show_pool_fee": true,
  "show_estimated_blocks": false,
  "custom_css_url": "",
  "maintenance_mode": false,

  "poolstats_enabled": true,
  "poolstats_api_key": "sk_live_abc123xyz...",
  "poolstats_endpoint": "https://api.miningpoolstats.stream/submit",
  "poolstats_interval_mins": 10,

  "log_level": "info",
  "database_vacuum_hours": 168,
  "archive_old_shares_days": 30,
  "max_workers_per_address": 100,
  "enable_prometheus_metrics": false,
  "discord_webhook_url": ""
}
```

---

## Admin Panel Layout

```
Settings (gear icon, admin-only)
├─ General
│  ├─ Pool name
│  ├─ Description
│  ├─ Logo URL
│  └─ Subdomain (read-only)
│
├─ Mining
│  ├─ Stratum port (read-only)
│  ├─ Node API port
│  ├─ Min/Max difficulty
│  ├─ Connection timeout
│  └─ Target block time
│
├─ Fees & Rewards
│  ├─ Pool fee % (slider: 0-10)
│  ├─ Pool fee address
│  ├─ Withdrawal fee
│  ├─ Min withdrawal
│  ├─ Auto-payout frequency
│  └─ Reward model (dropdown: pplns/prop/solo)
│
├─ Wallet & Payments
│  ├─ Wallet directory
│  ├─ Payout method (read-only: "Tor")
│  ├─ Tor proxy address
│  ├─ Wallet check interval
│  ├─ Payout retry days
│  └─ Payout retry interval
│
├─ Security
│  ├─ Public stats (toggle)
│  ├─ Public API (toggle)
│  ├─ Admin IP allowlist (text area)
│  ├─ Rate limits (3 sliders)
│  └─ Session timeout (mins)
│
├─ Branding
│  ├─ Show block rewards (toggle)
│  ├─ Show active miners (toggle)
│  ├─ Show hashrate (toggle)
│  ├─ Show pool fee (toggle)
│  └─ Maintenance mode (toggle)
│
├─ Advanced
│  ├─ Log level (dropdown)
│  ├─ DB vacuum frequency
│  ├─ Archive old shares
│  ├─ Max workers per address
│  ├─ Prometheus metrics (toggle)
│  └─ Discord webhook (optional)
│
└─ Danger Zone
   ├─ Change password
   ├─ Backup configuration
   └─ Factory reset (confirm 3x)
```

---

## Admin Panel Actions

**Beyond settings, the admin panel also offers:**

| Action | Location | Role |
|--------|----------|------|
| **View Dashboard** | Home | Admin sees: active miners, recent blocks, pending payouts, pool health |
| **View Miners** | Miners tab | List all miners (address + worker), shares, balance, status |
| **View Blocks** | Blocks tab | All found blocks (confirmed/orphaned), rewards, payouts |
| **View Payouts** | Payouts tab | All withdrawal history (pending/completed/failed), retry status |
| **Manual Payout** | Payouts → Manual | Trigger immediate payout to a specific miner (bypass schedule) |
| **View Logs** | Logs tab | Real-time tail of pool service logs (last 100 lines) |
| **Backup Now** | Tools | Download DB + config as tar.gz |
| **Database Stats** | Tools | DB size, share count, user count, orphaned blocks |
| **Change Password** | Account | Update admin password |
| **Invite Admin** | Account (future) | Create more admin users |
| **Audit Log** | Tools (future) | Who changed what and when |

---

## Default Configuration Strategy

When **script 07 runs setup**, it auto-creates `grin_pool.json` with sensible defaults:

```bash
# Mainnet pool defaults
pool_fee_percent: 0.0           # No fee by default (user enables if desired)
min_withdrawal: 2.0 GRIN
payout_frequency_hours: 24
reward_model: pplns
show_pool_fee: true             # Transparent about fees
maintenance_mode: false

# Security defaults
rate_limit_auth: 3              # Lock after 3 failed logins
session_timeout_mins: 60
admin_ip_allowlist: []          # Open to all IPs (user can restrict)
```

Users can then log in immediately and customize before going live.

---

## Future Extensions

- **Tiered fee structure:** Different fees for different pools (private vs public)
- **Custom reward model:** Weighted scoring, sponsor bonuses
- **Multi-sig admin panel:** 2-of-3 approval for payout changes
- **Recurring donation:** Auto-contribute % of rewards to development
- **Pool hopping detection:** Alert admin if detected
- **Mobile app:** Dashboard on phone
