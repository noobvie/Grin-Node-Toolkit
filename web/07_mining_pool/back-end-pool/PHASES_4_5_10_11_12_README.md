# Phases 4, 5, 10, 11, 12 — Admin Auth, Monitoring, Public API, Logging, UI

Admin authentication, real-time monitoring, public endpoints, audit logging, and admin dashboard UI.

## What's Added

### Phase 4: Admin Authentication
- `lib/auth.js` — User registration, login, JWT tokens, password hashing
- `lib/auth-middleware.js` — `requireAuth`, `requireAdmin`, `requireFreshAuth` middleware
- Routes: `/api/auth/login`, `/api/auth/register`, `/api/auth/refresh`, `/api/auth/change-password`

**Features:**
- Bcrypt password hashing (10-salt cost)
- JWT access tokens (1h expiry) + refresh tokens (7d)
- Fresh auth requirement for sensitive operations (< 5 min)
- Login attempt logging to admin_audit_log

### Phase 5: Stratum Monitoring (Real-time Hashrate)
- `lib/hashrate-tracker.js` — Records hashrate samples every 60s

**Metrics:**
- Pool hashrate (1h, 24h average)
- Per-miner hashrate tracking
- Top miners leaderboard
- Active connections

### Phase 10: Public API Endpoints
- `/api/pool/stats` — Overall pool metrics
- `/api/pool/blocks` — Recent blocks with status
- `/api/pool/miners` — Top miners by balance
- `/api/pool/payments` — Recent confirmed withdrawals
- `/api/account/{addr}/balance` — Miner balance info (public)

### Phase 11: Logging & Monitoring
- Admin audit log (all admin actions: login, password change, withdrawals)
- Comprehensive metrics endpoint
- Health check endpoint
- Error tracking throughout system

### Phase 12: Admin UI Mockups
- `public/login.html` — Login/register form
- `public/admin.html` — Admin dashboard with:
  - Pool metrics cards (miners, hashrate, blocks, withdrawals)
  - Recent blocks table
  - Withdrawal queue
  - Top miners leaderboard
  - Audit log

## Architecture

```
┌─────────────┐
│  Miner CLI  │
└──────┬──────┘
       │
    Stratum (3333)
       │
       ├─→ [Phase 1] Shares → Database
       │
    HTTP API (8080)
       │
       ├─→ [Phase 10] Public endpoints
       │   ├─ GET /api/pool/stats
       │   ├─ GET /api/pool/blocks
       │   ├─ GET /api/pool/miners
       │   ├─ GET /api/account/{addr}/balance
       │   └─ GET /api/pool/payments
       │
       ├─→ [Phase 4] Auth endpoints
       │   ├─ POST /api/auth/login
       │   ├─ POST /api/auth/register
       │   ├─ POST /api/auth/refresh
       │   └─ POST /api/auth/change-password
       │
       ├─→ [Phase 5] Monitoring
       │   └─ GET /api/stratum/hashrate
       │
       ├─→ [Phase 11] Admin metrics
       │   ├─ GET /api/admin/metrics (all data)
       │   └─ GET /api/admin/audit-log
       │
       └─→ [Phase 12] Admin UI
           ├─ /login.html
           └─ /admin.html
```

## API Endpoints Reference

### Phase 4 — Authentication

```
POST /api/auth/register
Body: { username, password }
Response: { success, user_id, username, is_admin }

POST /api/auth/login
Body: { username, password }
Response: { success, access_token, refresh_token, expires_in }

POST /api/auth/refresh
Body: { refresh_token }
Response: { success, access_token, refresh_token, expires_in }

POST /api/auth/change-password (requires Bearer token)
Body: { old_password, new_password }
Response: { success, message }
```

### Phase 5 — Hashrate Monitoring

```
GET /api/stratum/hashrate
Response: {
  pool_hashrate_1h_gps,
  pool_hashrate_24h_gps,
  active_miners,
  active_connections,
  top_miners: [ { grin_address, hashrate_gps, max_hashrate_gps } ]
}

GET /api/stratum/stats
Response: { active_connections, active_miners, sessions }
```

### Phase 10 — Public Endpoints

```
GET /api/pool/stats
Response: { total_blocks_found, total_reward, confirmed_blocks, 
            confirmed_reward, immature_blocks, active_miners }

GET /api/pool/blocks?limit=50
Response: [ { id, height, hash, nonce, reward, status, found_by, found_at } ]

GET /api/pool/miners?limit=50
Response: [ { grin_address, balance, is_online } ]

GET /api/pool/payments?limit=100
Response: [ { id, grin_address, amount, fee, status, created_at, confirmed_at } ]

GET /api/account/{grin_address}/balance
Response: { grin_address, balance, balance_locked, total }
```

### Phase 11 — Admin Monitoring

```
GET /api/admin/metrics (requires Bearer token + requireAdmin)
Response: {
  blocks: { total_blocks_found, total_reward, confirmed_blocks, ... },
  rewards: { total_credited, miners_with_balance, top_miners },
  hashrate: { pool_hashrate_1h_gps, active_miners, top_miners, ... },
  withdrawals: { running, pending, confirmed, failed },
  timestamp
}

GET /api/admin/audit-log?limit=100&offset=0 (requires Bearer token + requireAdmin)
Response: {
  count,
  logs: [ { id, admin_id, action, target_type, target_id, ip, created_at } ]
}
```

## Testing Sequence

### 1. Create Admin Account
```bash
curl -X POST http://localhost:8080/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{ "username": "admin", "password": "password123!" }'
```

Response:
```json
{
  "success": true,
  "user_id": 1,
  "username": "admin",
  "is_admin": true
}
```

### 2. Login
```bash
curl -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{ "username": "admin", "password": "password123!" }'
```

Response:
```json
{
  "success": true,
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIs...",
  "expires_in": 3600
}
```

### 3. Access Admin Dashboard
```bash
# Save the access_token
TOKEN="eyJhbGciOiJIUzI1NiIs..."

# Get admin metrics
curl http://localhost:8080/api/admin/metrics \
  -H "Authorization: Bearer $TOKEN"

# Get audit log
curl http://localhost:8080/api/admin/audit-log \
  -H "Authorization: Bearer $TOKEN"
```

### 4. Open Admin UI
Navigate to: `http://localhost:8080/admin.html`
- Enter credentials on login.html
- View dashboard with real-time metrics
- Monitor blocks, withdrawals, miners

### 5. Public API (no auth required)
```bash
# Check pool stats
curl http://localhost:8080/api/pool/stats

# Get miner balance
curl http://localhost:8080/api/account/grin1test.../balance

# List recent payments
curl http://localhost:8080/api/pool/payments

# Check hashrate
curl http://localhost:8080/api/stratum/hashrate
```

## Configuration Requirements

Add to `pool.json`:
```json
{
  "port": 8080,
  "jwt_secret": "your-random-secret-32-chars-min",
  "pool_fee_percent": 2.0,
  "pool_fee_address": "pool_fee"
}
```

## Security Notes

- Passwords hashed with bcrypt (10 salt rounds)
- JWT tokens with expiry (access: 1h, refresh: 7d)
- Fresh auth required for sensitive ops (< 5 min)
- All admin actions logged (username, action, IP, timestamp)
- HTTPS recommended for production (enable SSL in nginx)

## Admin UI Features (Phase 12)

Dashboard shows:
- **Metrics Cards**: Active miners, pool hashrate, blocks, withdrawals
- **Recent Blocks**: Height, hash, reward, status, miner address
- **Withdrawal Queue**: Address, amount, status, retry count
- **Top Miners**: Address, balance, hashrate status
- **Audit Log**: Admin actions with timestamp and IP

Live updates every 10-30 seconds.

## Validation Checklist

- [ ] Register admin account
- [ ] Login with correct credentials
- [ ] Rejected with incorrect password
- [ ] JWT token works for admin endpoints
- [ ] Fresh auth check (wait 5+ min, retry sensitive op, get 403)
- [ ] Refresh token generates new access token
- [ ] Admin metrics show correct data
- [ ] Audit log records login attempts
- [ ] Public endpoints work without auth
- [ ] Admin UI loads and displays data
- [ ] Hashrate tracker records samples
- [ ] Top miners leaderboard updates

## Next Steps

All core features complete:
- ✅ Phase 0c: Setup
- ✅ Phase 1: Mining (stratum)
- ✅ Phase 7: Node integration
- ✅ Phase 8: PPLNS rewards
- ✅ Phase 2: Wallet Tor
- ✅ Phase 6: Withdrawals
- ✅ Phase 4: Admin auth
- ✅ Phase 5: Hashrate monitoring
- ✅ Phase 10: Public API
- ✅ Phase 11: Audit logging
- ✅ Phase 12: Admin UI

**Ready for deployment testing** on testnet.

See the full refactor plan at:
`flowcharts/script07_flow_refactor.txt`
