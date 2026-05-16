# Admin Backend Design — Monitoring, Security, Maintenance & Alerts

**Goal:** Provide pool operators with complete visibility into pool health, security posture, and maintenance needs.

---

## 1. Real-Time Dashboard Monitoring

**Endpoint:** `GET /api/admin/dashboard`

Returns unified view of pool health (single call).

```json
{
  "timestamp": "2026-05-15T12:34:56Z",
  "pool_status": {
    "name": "My Grin Pool",
    "uptime_hours": 730.5,
    "last_restart": "2026-05-01T10:00:00Z"
  },
  "stratum_metrics": {
    "active_connections": 45,
    "active_miners": 23,
    "shares_per_sec": 12.5,
    "difficulty_avg": 500.0,
    "connection_errors_1h": 2
  },
  "hashrate": {
    "current_gps": 1024.5,
    "avg_24h_gps": 950.0,
    "peak_gps": 1200.0,
    "difficulty_delta": 500000.0
  },
  "blocks": {
    "found_24h": 3,
    "found_7d": 18,
    "pending_payout": 2,
    "orphaned": 0,
    "last_block": {
      "height": 5123456,
      "timestamp": "2026-05-15T10:30:00Z",
      "reward": 60.0,
      "status": "confirmed"
    }
  },
  "node_health": {
    "status": "connected",
    "height": 5123456,
    "peers": 8,
    "sync_status": "synced",
    "api_latency_ms": 45
  },
  "wallet_health": {
    "status": "online",
    "last_check": "2026-05-15T12:33:00Z",
    "balance": 150.5,
    "balance_locked": 45.0,
    "tor_reachable": true
  },
  "payouts": {
    "pending": 2,
    "failed": 1,
    "last_payout": "2026-05-15T08:00:00Z",
    "next_payout": "2026-05-16T08:00:00Z",
    "total_paid_24h": 200.0
  },
  "alerts": [
    {
      "level": "warning",
      "type": "wallet_balance_low",
      "message": "Wallet balance below 50 GRIN. Payouts may be delayed.",
      "timestamp": "2026-05-15T12:30:00Z"
    }
  ]
}
```

---

## 2. Health Status Endpoints

### 2.1 Node Health

**Endpoint:** `GET /api/admin/health/node`

```json
{
  "status": "healthy",
  "checks": {
    "api_reachable": {
      "status": "ok",
      "latency_ms": 45,
      "endpoint": "http://127.0.0.1:3413/v2/owner"
    },
    "sync_status": {
      "status": "ok",
      "height": 5123456,
      "network_height": 5123456,
      "synced": true
    },
    "peers": {
      "status": "warning",
      "count": 4,
      "healthy_peers": 4,
      "min_required": 3
    },
    "difficulty": {
      "status": "ok",
      "current": 4000000.0,
      "average_24h": 3950000.0
    }
  },
  "timestamp": "2026-05-15T12:34:56Z"
}
```

### 2.2 Wallet Health

**Endpoint:** `GET /api/admin/health/wallet`

```json
{
  "status": "healthy",
  "checks": {
    "api_reachable": {
      "status": "ok",
      "endpoint": "http://127.0.0.1:13415/v2/foreign",
      "latency_ms": 52
    },
    "tor_reachable": {
      "status": "ok",
      "tor_version": "0.4.7.0",
      "last_successful_send": "2026-05-15T08:00:00Z"
    },
    "balance": {
      "status": "ok",
      "total": 150.5,
      "available": 105.5,
      "locked": 45.0,
      "min_required": 10.0
    },
    "synced": {
      "status": "ok",
      "last_sync": "2026-05-15T12:30:00Z",
      "blocks_behind": 0
    }
  },
  "timestamp": "2026-05-15T12:34:56Z"
}
```

### 2.3 Stratum Health

**Endpoint:** `GET /api/admin/health/stratum`

```json
{
  "status": "healthy",
  "metrics": {
    "listening": true,
    "port": 3416,
    "bind_addr": "0.0.0.0",
    "active_connections": 45,
    "active_miners": 23,
    "shares_accepted_1h": 45000,
    "shares_rejected_1h": 123,
    "rejection_rate": 0.27,
    "connection_errors_1h": 2,
    "timeouts_1h": 1
  },
  "alerts": [
    {
      "type": "high_rejection_rate",
      "message": "Share rejection rate 0.27% — monitor for misconfigured difficulty"
    }
  ]
}
```

---

## 3. Alert System

### 3.1 Alert Types & Triggers

| Alert Type | Level | Trigger | Action |
|-----------|-------|---------|--------|
| `node_down` | CRITICAL | Node API unreachable for 30s+ | Email, Dashboard notification |
| `wallet_offline` | CRITICAL | Wallet API unreachable for 5+ min | Email, Slack webhook |
| `wallet_balance_low` | WARNING | Balance < min_withdrawal | Email, Dashboard banner |
| `block_orphaned` | WARNING | Found block marked orphaned | Email, Discord webhook |
| `payout_failed` | WARNING | Withdrawal fails after 2+ retries | Email, Admin task |
| `high_rejection_rate` | WARNING | Share rejection > 1% in 1h | Dashboard notification |
| `high_error_rate` | WARNING | API errors > 5% in 1h | Dashboard notification |
| `tor_unreachable` | WARNING | Tor connection fails for 10+ min | Email, Dashboard |
| `difficulty_spike` | INFO | Difficulty changes > 20% in 1h | Email (optional) |
| `connection_surge` | INFO | New connections > 2x baseline | Dashboard (monitoring) |

### 3.2 Alert Endpoints

**Endpoint:** `GET /api/admin/alerts`

```json
{
  "active": [
    {
      "id": "alert_20260515_001",
      "type": "wallet_balance_low",
      "level": "warning",
      "message": "Wallet balance 45.5 GRIN (min: 50)",
      "triggered_at": "2026-05-15T12:00:00Z",
      "last_seen": "2026-05-15T12:34:56Z",
      "occurrence_count": 1,
      "status": "active",
      "actions": ["acknowledge", "escalate_to_critical", "snooze_1h"]
    }
  ],
  "resolved": [
    {
      "id": "alert_20260515_002",
      "type": "tor_unreachable",
      "level": "warning",
      "triggered_at": "2026-05-15T11:00:00Z",
      "resolved_at": "2026-05-15T11:05:00Z",
      "resolution": "auto_resolved"
    }
  ]
}
```

**Endpoint:** `POST /api/admin/alerts/:alert_id/acknowledge`

```json
{
  "success": true,
  "alert_id": "alert_20260515_001",
  "message": "Alert acknowledged by admin@pool.example.com"
}
```

### 3.3 Alert Delivery Methods

| Method | Config Key | Status | Use Case |
|--------|-----------|--------|----------|
| Dashboard (in-app) | N/A | ✅ Implemented | Real-time, always visible |
| Email | `alert_email_address` | 🔧 To implement | Critical/warning alerts |
| Discord Webhook | `discord_webhook_url` | 🔧 To implement | Block found, payout issues |
| Slack Webhook | `slack_webhook_url` | 🔧 To implement | Team notifications |
| SMS (Twilio) | `twilio_api_key` | 📅 Future | CRITICAL alerts only |
| PagerDuty | `pagerduty_integration_key` | 📅 Future | On-call escalation |

---

## 4. Security Features

### 4.1 Authentication & Authorization

**Already Implemented:**
- JWT-based session auth
- Bcrypt password hashing
- Admin-only endpoints via `requireAdmin()` middleware
- Session timeout (configurable, default 60 min)

**To Add:**
- ✅ IP allowlist (in CONFIG_SCHEMA.md)
- 🔧 Rate limiting on auth endpoints (3 attempts/min)
- 🔧 Failed login logging (with IP, timestamp)
- 📅 2FA (TOTP via Google Authenticator)
- 📅 Multi-admin support (invite/revoke)

### 4.2 Audit Logging

**Endpoint:** `GET /api/admin/audit-log?limit=100&offset=0`

Already implemented. Logs all admin actions:

```json
{
  "count": 100,
  "logs": [
    {
      "id": 12345,
      "admin_user": "admin@pool.example.com",
      "action": "config_update",
      "resource": "pool_fee_percent",
      "old_value": "1.0",
      "new_value": "2.0",
      "ip_address": "203.0.113.42",
      "status": "success",
      "timestamp": "2026-05-15T12:00:00Z"
    },
    {
      "id": 12344,
      "admin_user": "admin@pool.example.com",
      "action": "manual_payout",
      "resource": "withdrawal_id_999",
      "amount": "50.0",
      "to_address": "grin1abc...",
      "status": "initiated",
      "timestamp": "2026-05-15T11:55:00Z"
    }
  ]
}
```

**Security note:** Audit log is immutable (append-only). Admins cannot modify it.

### 4.3 IP Allowlist

**Config:**
```json
{
  "admin_ip_allowlist": [
    "203.0.113.0/24",    // CIDR subnet
    "198.51.100.42",     // Single IP
    "192.0.2.0/25"
  ]
}
```

**Behavior:** If allowlist is set, only these IPs can access `/admin/*` endpoints. Empty list = open to all IPs.

### 4.4 Secrets Management

**Never stored in:**
- ❌ Logs
- ❌ Audit trail
- ❌ Error messages
- ❌ Admin panel display (show redacted: `sk_live_****xyz`)

**Stored in:**
- ✅ Config file `/opt/grin/conf/grin_pool.json` (0600 permissions)
- ✅ Database (encrypted at rest if possible)

---

## 5. Maintenance Features

### 5.1 Database Management

**Endpoint:** `GET /api/admin/maintenance/database`

```json
{
  "database": {
    "path": "/opt/grin/pool/mainnet/pool.db",
    "size_mb": 245.5,
    "size_formatted": "245.5 MB",
    "last_vacuum": "2026-05-15T03:00:00Z",
    "next_vacuum": "2026-05-22T03:00:00Z",
    "vacuum_frequency_days": 7,
    "fragmentation_percent": 12.5
  },
  "tables": {
    "miner_accounts": { "rows": 5432, "size_mb": 15.2 },
    "shares": { "rows": 450000, "size_mb": 125.3 },
    "blocks": { "rows": 89, "size_mb": 0.5 },
    "withdrawals": { "rows": 1234, "size_mb": 8.2 },
    "admin_audit_log": { "rows": 12345, "size_mb": 5.1 }
  },
  "recommendations": [
    "Database fragmentation 12.5% — next VACUUM on 2026-05-22"
  ]
}
```

**Endpoint:** `POST /api/admin/maintenance/vacuum` (requires admin + fresh auth)

Manually trigger SQLite VACUUM (optimize DB size). Runs in background.

```json
{
  "success": true,
  "message": "VACUUM initiated (may take 1-5 min)",
  "estimated_wait_ms": 3000
}
```

### 5.2 Log Management

**Endpoint:** `GET /api/admin/maintenance/logs`

```json
{
  "log_files": [
    {
      "name": "grin-pool.log",
      "path": "/opt/grin/logs/grin-pool.log",
      "size_mb": 145.2,
      "rotation_enabled": true,
      "rotation_size_mb": 500,
      "rotation_retention_days": 30,
      "last_rotated": "2026-05-13T02:00:00Z"
    }
  ],
  "disk_usage": {
    "log_dir_size_mb": 850.5,
    "retention_policy": "rotate when > 500 MB, keep 30 days"
  }
}
```

**Endpoint:** `POST /api/admin/maintenance/logs/rotate`

Force log rotation immediately.

### 5.3 Data Cleanup

**Endpoint:** `POST /api/admin/maintenance/cleanup`

Runs background cleanup:
- Delete shares older than `archive_old_shares_days` (default 30 days)
- Compress old blocks data (future)
- Purge anonymous IP logs (future)

```json
{
  "success": true,
  "cleanup_tasks": [
    {
      "task": "archive_old_shares",
      "deleted_records": 125000,
      "freed_mb": 52.3,
      "duration_seconds": 45
    }
  ]
}
```

### 5.4 Backup & Restore

**Endpoint:** `GET /api/admin/maintenance/backups`

```json
{
  "backups": [
    {
      "id": "backup_20260515_020000",
      "created_at": "2026-05-15T02:00:00Z",
      "size_mb": 356.2,
      "includes": ["pool.db", "grin_pool.json", "admin_audit_log"],
      "status": "completed",
      "storage_location": "/opt/grin/backups/grin-pool-manager/"
    }
  ],
  "next_backup": "2026-05-16T02:00:00Z",
  "backup_schedule": "daily at 02:00 UTC"
}
```

**Endpoint:** `POST /api/admin/maintenance/backup-now`

Trigger immediate backup.

**Endpoint:** `POST /api/admin/maintenance/restore` (requires extra confirmation)

Restore from backup (careful operation).

### 5.5 Service Control

**Endpoint:** `POST /api/admin/maintenance/service/:action`

Actions: `start`, `stop`, `restart`

```json
{
  "success": true,
  "action": "restart",
  "message": "Pool service restarting...",
  "estimated_downtime_seconds": 5
}
```

---

## 6. Metrics & Observability

### 6.1 Prometheus Metrics

**Endpoint:** `GET /metrics` (if enabled)

Exposes metrics in Prometheus format:

```
# HELP pool_active_miners Active miners connected
# TYPE pool_active_miners gauge
pool_active_miners 23

# HELP pool_shares_per_sec Shares submitted per second
# TYPE pool_shares_per_sec gauge
pool_shares_per_sec 12.5

# HELP pool_blocks_found Total blocks found
# TYPE pool_blocks_found counter
pool_blocks_found 89

# HELP pool_hashrate_gps Current hashrate (G/s)
# TYPE pool_hashrate_gps gauge
pool_hashrate_gps{interval="1m"} 1024.5
pool_hashrate_gps{interval="24h"} 950.0
```

Enable in config:
```json
{
  "enable_prometheus_metrics": true
}
```

### 6.2 Grafana Dashboard Template

Provide pre-built Grafana JSON for operators to import:
- Hashrate over time
- Active miners/connections
- Block finding rate
- Share acceptance/rejection
- Payout success rate
- Node health
- Wallet balance

---

## 7. Admin Panel Sections

### 7.1 Dashboard (Home)

**Components:**
- Real-time KPIs (active miners, hashrate, blocks, rewards)
- Health status cards (Node, Wallet, Stratum)
- Alert banner (active warnings/critical)
- Last 5 blocks found
- Last 5 payouts sent
- Hashrate chart (24h)

### 7.2 Monitoring

**Tabs:**
- **Realtime Stats** — hashrate, miners, shares, difficulty
- **Node Health** — sync status, peers, latency, difficulty
- **Wallet Health** — balance, Tor reachability, last transactions
- **Stratum Metrics** — connections, rejection rate, error rate
- **Alerts** — active/resolved, ack/snooze controls

### 7.3 Maintenance

**Tabs:**
- **Database** — size, fragmentation, table stats, VACUUM schedule
- **Logs** — log viewer, rotation status, retention policy
- **Backups** — schedule, recent backups, restore options
- **System Health** — disk usage, RAM, CPU, uptime
- **Services** — start/stop/restart pool and systemd services

### 7.4 Security

**Tabs:**
- **Audit Log** — all admin actions, IP, timestamp
- **Sessions** — active admin sessions, last activity, revoke
- **IP Allowlist** — manage allowed IPs/CIDRs
- **API Keys** — manage poolstats key, rotation history
- **Change Password** — admin password reset

### 7.5 Settings (existing, enhanced)

**Tabs:**
- **General** — pool name, description, logo
- **Mining** — stratum settings
- **Fees** — pool fee %, withdrawal fee, min withdrawal
- **Wallet** — wallet dir, payout schedule
- **Security** — rate limits, session timeout, IP allowlist
- **Alerts** — enable/disable alert types, delivery methods
- **Monitoring** — Prometheus, log level
- **External** — poolstats (already designed), Discord, Slack (to add)

---

## 8. Implementation Roadmap

### Phase 1 (MVP) — Current
- ✅ Dashboard (basic)
- ✅ Health checks (node, wallet, stratum)
- ✅ Audit logging
- ✅ Service control
- ✅ Poolstats integration

### Phase 2 (Next Sprint)
- 🔧 Alert system (dashboard notifications + email)
- 🔧 Database maintenance (VACUUM, cleanup)
- 🔧 Backup/restore
- 🔧 Metrics/Prometheus
- 🔧 Log viewer

### Phase 3 (Future)
- 📅 2FA (TOTP)
- 📅 Multi-admin support
- 📅 Slack/Discord webhooks
- 📅 SMS alerts (Twilio)
- 📅 Custom alert rules (user-configurable thresholds)

---

## 9. Security Checklist

- [ ] All endpoints require admin auth (except `/health`)
- [ ] Secrets never logged to console
- [ ] API keys redacted in UI (show `sk_live_****`)
- [ ] Audit log immutable (append-only)
- [ ] Config file 0600 permissions
- [ ] HTTPS-only for external calls (poolstats, webhooks)
- [ ] Rate limiting on auth endpoints (3 attempts/min)
- [ ] IP allowlist optional but recommended for production
- [ ] Session timeout configurable (default 60 min)
- [ ] Failed login attempts logged with IP
- [ ] Database backups encrypted (future)

---

## 10. Configuration Schema Additions

```json
{
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
  "maintenance": {
    "log_rotation_enabled": true,
    "log_rotation_size_mb": 500,
    "log_retention_days": 30,
    "backup_schedule": "0 2 * * *",
    "backup_retention_days": 30,
    "vacuum_schedule": "0 3 * * 0"
  }
}
```

---

## Summary

This comprehensive admin backend provides operators with:
- ✅ **Real-time visibility** into pool health and metrics
- ✅ **Proactive alerting** for issues (node down, payouts failing, etc.)
- ✅ **Security controls** (IP allowlist, audit log, session management)
- ✅ **Maintenance tools** (backup, cleanup, log rotation)
- ✅ **Observability** (Prometheus metrics, log viewer)

All without requiring pool operators to SSH or manage files manually.
