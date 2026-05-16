# GRINIUM Mining Pool — Design Specification

**Date:** 2026-05-15  
**Version:** 1.0 MVP  
**Status:** Complete & Validated

---

## Table of Contents
1. [Executive Summary](#executive-summary)
2. [System Architecture](#system-architecture)
3. [Admin Backend API Design](#admin-backend-api-design)
4. [Pool Configuration Schema](#pool-configuration-schema)
5. [Health & Security](#health--security)
6. [Database Schema](#database-schema)
7. [Deployment Architecture](#deployment-architecture)

---

## Executive Summary

GRINIUM is a **three-layer mining pool system** for Grin cryptocurrency:

1. **Bash Deployment Layer** — Infrastructure automation
2. **Node.js Backend** — API server with all core systems
3. **Frontend** — Web UI for miners and admins

**Key Features:**
- ✅ Stratum mining protocol support
- ✅ PPLNS reward distribution (60-block window)
- ✅ Grin wallet integration via Foreign/Owner APIs
- ✅ Tor-based anonymous payouts
- ✅ JWT authentication with admin controls
- ✅ Real-time monitoring & alerts
- ✅ NEXUS/Light/Atomic theme system
- ✅ Responsive design (mobile/tablet/desktop)

**Status:** MVP ready for testnet launch

---

## System Architecture

### Three-Layer Stack

```
┌─────────────────────────────────────────────────────────┐
│ Nginx (Reverse Proxy)                                   │
│ - Serves static files: /var/www/grin-pool/*            │
│ - Routes /api/* → localhost:3002 (Node.js backend)     │
│ - SSL/TLS via certbot                                  │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ Node.js/Express Backend (port 3002)                    │
│ Core Systems:                                           │
│ • Auth Manager (JWT + user mgmt)                       │
│ • Stratum Server (port 3416 for miners)               │
│ • Block Manager (monitor found blocks)                │
│ • Share Validator (difficulty scaling)                │
│ • Miner Manager (track connected miners)              │
│ • Reward Distributor (PPLNS algorithm)                │
│ • Wallet API (Grin Foreign/Owner)                     │
│ • Withdrawal Scheduler (Tor payouts)                  │
│ • Alert Monitor (health checks)                       │
│ • Rate Limiter & IP Filter                            │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ SQLite Database (/opt/grin/pool/mainnet/pool.db)       │
│ Tables:                                                 │
│ • miner_accounts (balances)                            │
│ • shares (mining shares)                               │
│ • blocks (found blocks)                                │
│ • withdrawals (payouts)                                │
│ • users (admin accounts)                               │
│ • admin_audit_log (security log)                       │
└─────────────────────────────────────────────────────────┘
```

### Deployed File Structure

**Development (Toolkit):**
```
web/07_mining_pool/
├── back-end-pool/          ← Node.js source
├── public_html/            ← Frontend source (7 pages)
└── scripts/                ← Deployment automation
```

**Production (VPS):**
```
/opt/grin/pool/mainnet/     ← Node.js app
/var/www/grin-pool/         ← Frontend (nginx serves)
/etc/nginx/sites-*          ← Nginx config
/etc/systemd/system/        ← Service files
```

### Request Flow

```
Miner Connects
    ↓
Stratum Server (port 3416)
    ↓
Share Validation
    ↓
Store in Database
    ↓
Block Found? → Reward Distribution → Payout Scheduling
    ↓
Tor Withdrawal
    ↓
Grin Network
```

---

## Admin Backend API Design

### Authentication Endpoints

**POST `/api/auth/register`** — Create admin account
```json
{
  "username": "admin",
  "password": "secure_password"
}
→ {success: true, message: "Admin created"}
```

**POST `/api/auth/login`** — Get access token
```json
{
  "username": "admin",
  "password": "secure_password"
}
→ {
  success: true,
  access_token: "eyJhbGc...",
  refresh_token: "eyJhbGc..."
}
```

**POST `/api/auth/change-password`** — Update password (requires auth)
```json
{
  "old_password": "old",
  "new_password": "new"
}
→ {success: true, message: "Password updated"}
```

### Dashboard Endpoints

**GET `/api/admin/dashboard`** — Unified admin dashboard
Returns: pool status, stratum metrics, hashrate, blocks, payouts, alerts

**GET `/api/pool/stats`** — Public pool statistics
Returns: active miners, blocks found, pool fee, avg hashrate

### Health & Monitoring

**GET `/api/admin/health/node`** — Node health checks
- API reachability
- Sync status
- Peer count
- Network difficulty

**GET `/api/admin/health/wallet`** — Wallet health checks
- API reachability
- Tor status
- Balance (available/locked)
- Sync status

**GET `/api/admin/metrics`** — Combined metrics (blocks, rewards, hashrate, withdrawals)

**GET `/api/stratum/stats`** — Active connections, shares/sec, difficulty

**GET `/api/stratum/hashrate`** — Hashrate statistics (current, 24h avg, peak)

### Withdrawal Management

**GET `/api/admin/withdrawals`** — List all payouts
Query: `?status=pending|confirmed|failed`

**GET `/api/admin/withdrawal-scheduler`** — Payout scheduler status

**POST `/api/test/initiate-withdrawal`** — Test endpoint (manual payout)

### Block Tracking

**GET `/api/pool/blocks`** — List found blocks
Query: `?limit=50` (default)

**POST `/api/test/credit-block`** — Test endpoint (manual block credit)

**GET `/api/admin/block-monitor`** — Block monitor status

**POST `/api/test/distribute-block`** — Test endpoint (manual reward distribution)

### Miner Endpoints

**GET `/api/miners/top`** — Top miners ranking
Query: `?limit=10&offset=0`

**GET `/api/pool/miners`** — All miners list
Query: `?limit=50`

**GET `/api/test/miners`** — Test endpoint for miner data

**GET `/api/account/:addr/balance`** — Miner balance (public)

**GET `/api/account/:addr/shares`** — Miner share history

**POST `/api/account/update`** — Update account settings (requires auth)

### Audit & Alerts

**GET `/api/admin/audit-log`** — Admin action history
Query: `?limit=100&offset=0`

**GET `/api/admin/alerts`** — Active alerts

**POST `/api/admin/alerts/:id/acknowledge`** — Acknowledge alert

**POST `/api/admin/alerts/:id/snooze`** — Snooze alert (minutes)

**GET `/api/admin/alerts/config`** — Alert configuration

### Public Endpoints

**GET `/api/health`** — Basic health check (no auth required)

**GET `/api/config/pool-info`** — Pool information (public)

---

## Pool Configuration Schema

### Configuration Categories

#### 1. Basic Settings
| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `pool_name` | string | "GRINIUM" | Display name |
| `pool_description` | string | "" | Short description |
| `network` | enum | "mainnet" | mainnet only |
| `language` | string | "en" | UI language |

#### 2. Mining Configuration
| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `stratum_port` | integer | 3416 | Miner connection port |
| `node_api_port` | integer | 3413 | Grin node port |
| `min_difficulty` | float | 1.0 | Minimum share difficulty |
| `max_difficulty` | float | 1000000 | Maximum difficulty |
| `connection_timeout_secs` | integer | 600 | Miner idle timeout |

#### 3. Fee & Rewards
| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `pool_fee_percent` | float | 0.0 | Pool fee (0-10%) |
| `pool_fee_address` | string | "" | Pool fee wallet address |
| `withdrawal_fee` | float | 0.0 | Fee per withdrawal |
| `min_withdrawal` | float | 2.0 | Minimum payout amount |
| `payout_frequency_hours` | integer | 24 | Auto-payout interval |
| `reward_model` | enum | "pplns" | pplns, prop, solo |

#### 4. Wallet & Payments
| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `grin_wallet_dir` | string | "/opt/grin/wallet/mainnet" | Wallet location |
| `wallet_check_interval_secs` | integer | 600 | Check interval |
| `payout_method` | enum | "tor" | Tor only (currently) |
| `tor_socks_proxy` | string | "127.0.0.1:9050" | Tor proxy |
| `payout_retry_max_days` | integer | 7 | Retry period |

#### 5. Security & Access
| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `enable_public_stats` | boolean | true | Public stats visible |
| `enable_public_api` | boolean | true | Public API access |
| `jwt_secret` | string | (auto-gen) | Never show in UI |
| `admin_ip_allowlist` | array | [] | Admin IP whitelist |
| `admin_ip_blacklist` | array | [] | IP blacklist |

#### 6. Branding
| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `pool_logo_url` | string | "" | Logo image URL |
| `theme` | enum | "dark" | dark, light, atomic |
| `default_language` | string | "en" | Default UI language |

#### 7. Advanced
| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `tor_enabled` | boolean | true | Enable Tor integration |
| `alert_check_interval_secs` | integer | 60 | Health check frequency |
| `alert_email_address` | string | "" | Alert email |
| `discord_webhook_url` | string | "" | Discord alerts |
| `slack_webhook_url` | string | "" | Slack alerts |

---

## Health & Security

### Health Check Endpoints

All admin endpoints require:
- **Authentication:** JWT token in `Authorization: Bearer {token}` header
- **Rate Limiting:** 10 requests/min for admin endpoints
- **IP Filtering:** Optional allowlist/blacklist

### Security Architecture

```
┌──────────────────────────────┐
│ Nginx (SSL/TLS)              │
│ • Enforces HTTPS             │
│ • Rate limiting (headers)    │
│ • Security headers           │
└──────────────────┬───────────┘
                   ↓
┌──────────────────────────────┐
│ Express.js Middleware        │
│ • Rate Limiter               │
│ • IP Filter                  │
│ • JWT Auth Validator         │
│ • CORS (if needed)           │
└──────────────────┬───────────┘
                   ↓
┌──────────────────────────────┐
│ Route Handlers               │
│ • Permission checks          │
│ • Input validation           │
│ • Database operations        │
└──────────────────────────────┘
```

### API Response Standardization

**Success Response:**
```json
{
  "success": true,
  "data": { ... },
  "timestamp": "2026-05-15T12:34:56Z"
}
```

**Error Response:**
```json
{
  "success": false,
  "error": "Error message",
  "code": "ERROR_CODE",
  "timestamp": "2026-05-15T12:34:56Z"
}
```

**HTTP Status Codes:**
- 200 OK
- 400 Bad Request
- 401 Unauthorized (invalid/missing token)
- 403 Forbidden (insufficient permissions)
- 404 Not Found
- 500 Internal Server Error

---

## Database Schema

### Core Tables

#### miner_accounts
```sql
CREATE TABLE miner_accounts (
  id INTEGER PRIMARY KEY,
  grin_address TEXT UNIQUE,
  balance REAL DEFAULT 0.0,
  balance_locked REAL DEFAULT 0.0,
  is_online BOOLEAN DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### shares
```sql
CREATE TABLE shares (
  id INTEGER PRIMARY KEY,
  miner_address TEXT,
  difficulty REAL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(miner_address) REFERENCES miner_accounts(grin_address)
);
```

#### blocks
```sql
CREATE TABLE blocks (
  id INTEGER PRIMARY KEY,
  height INTEGER UNIQUE,
  hash TEXT UNIQUE,
  miner_address TEXT,
  reward REAL,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(miner_address) REFERENCES miner_accounts(grin_address)
);
```

#### withdrawals
```sql
CREATE TABLE withdrawals (
  id INTEGER PRIMARY KEY,
  grin_address TEXT,
  amount REAL,
  fee REAL DEFAULT 0.0,
  status TEXT DEFAULT 'pending',
  tx_hash TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  confirmed_at TIMESTAMP
);
```

#### users (Admin)
```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE,
  password_hash TEXT,
  is_admin BOOLEAN DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### admin_audit_log
```sql
CREATE TABLE admin_audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  action TEXT,
  resource TEXT,
  details TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
```

#### user_settings
```sql
CREATE TABLE user_settings (
  user_id INTEGER PRIMARY KEY,
  email TEXT,
  preferred_pool_server TEXT DEFAULT 'US East',
  min_payout REAL DEFAULT 10.0,
  notification_level TEXT DEFAULT 'all',
  theme TEXT DEFAULT 'dark',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## Deployment Architecture

### Infrastructure Components

**Network Diagram:**
```
Internet
  ↓
Nginx (HTTPS)
  ├─ /api/* → Node.js:3002
  └─ /* → /var/www/grin-pool/
      ↓
Node.js Backend (3002)
  ├─ Stratum Server (3416)
  ├─ SQLite Database
  └─ Grin Wallet Integration
      ↓
Grin Node (3413)
  ↓
Tor Network (9050)
  ↓
Miners
```

### Service Dependencies

```
grin-node (running)
    ↓
grin-pool-manager (Node.js)
    ├─ Depends on: grin-node, systemd
    ├─ Listens on: :3002 (API), :3416 (Stratum)
    └─ Database: /opt/grin/pool/mainnet/pool.db
```

### File Paths (Production VPS)

```
/opt/grin/
├── pool/mainnet/
│   ├── index.js
│   ├── lib/
│   ├── pool.json (config)
│   └── pool.db (database)
├── conf/
│   └── grin_pool.json (admin settings)
└── logs/
    └── grin-pool.log

/var/www/
├── grin-pool/
│   ├── index.html
│   ├── admin-dashboard.html
│   ├── js/auth.js
│   └── ...

/etc/nginx/sites-available/
└── grin-pool

/etc/systemd/system/
└── grin-pool-manager.service
```

---

## Summary

This design specification provides:
- ✅ Three-layer architecture (Nginx, Node.js, Database)
- ✅ 20+ REST API endpoints
- ✅ Database schema with 7+ tables
- ✅ Configuration schema with 8 categories
- ✅ Security model (JWT, IP filtering, rate limiting)
- ✅ Health monitoring system
- ✅ Deployment paths and service dependencies

**Ready for:** Integration testing → Production deployment

