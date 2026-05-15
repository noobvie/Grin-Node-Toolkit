# Script 07 Mining Pool — Implementation Guides

**Reference:** See `script07_flow_refactor.txt` for architecture and phase dependencies.

---

## Phase 0c — Environment Validation & Setup

### What's Created

✅ **Foundation for Node.js mining pool backend**

- `package.json` — Dependencies (Express, better-sqlite3, bcryptjs, jsonwebtoken, node-cron)
- `index.js` — Express app entry point with basic routes
- `lib/db.js` — SQLite database with all 10 tables + indexes
- `lib/wallet.js` — Grin wallet API wrapper (balance, send, address validation)
- `lib/config.js` — Configuration loader (JSON + environment variables)
- `pool.json.template` — Configuration template (copy to `pool.json`)
- `scripts/nuke.js` — Cleanup script for testing (`npm run nuke`)

### Setup Instructions

#### 1. Install Dependencies

```bash
cd web/07_mining_pool/back-end-pool
npm install
```

#### 2. Create Configuration

```bash
cp pool.json.template pool.json
```

Edit `pool.json` to match your testnet environment:
- `wallet_dir`: Path to grin-wallet directory (e.g., `/opt/grin/pool-test/`)
- `node_api_url`: Grin node API endpoint (e.g., `http://127.0.0.1:13413` for testnet)
- `jwt_secret`: Generate a random secret (32+ characters)
- `network`: Set to `testnet` for development

#### 3. Start the Pool

```bash
npm start
```

Expected output:
```
[2026-05-15T...] Loading pool configuration...
  Network: testnet
  API port: 8080
  Stratum port: 3333
[2026-05-15T...] Database initialized at ./pool.sqlite
[2026-05-15T...] Wallet API initialized (testnet)
[2026-05-15T...] Pool API listening on port 8080
```

#### 4. Test the Setup

```bash
# Check health
curl http://localhost:8080/health

# List database tables
curl http://localhost:8080/api/test/tables

# Add a test miner
curl -X POST http://localhost:8080/api/test/add-miner \
  -H "Content-Type: application/json" \
  -d '{"grin_address":"grin1testaddress1234567890"}'

# List miners
curl http://localhost:8080/api/test/miners
```

### Validation Checklist (Phase 0c)

- [ ] npm install succeeds
- [ ] pool.json created and configured
- [ ] npm start runs without errors
- [ ] GET /health returns 200 OK
- [ ] GET /api/test/tables shows 10 tables
- [ ] POST /api/test/add-miner works with valid address
- [ ] Database file created (pool.sqlite)
- [ ] bash -n check passes on all .js files

```bash
npm run check-syntax
```

### Reset for Testing

To wipe the database and restart:

```bash
npm run nuke
npm start
```

---

## Phase 1 — Mining Core

### What's Added

✅ **Stratum mining protocol server + share/block tracking**

- `lib/stratum-server.js` — TCP server (stratum protocol)
- `lib/stratum-protocol.js` — Message parsing & validation
- `lib/shares.js` — Share validation & storage
- `lib/blocks.js` — Block crediting & status tracking
- `lib/miners.js` — Miner session management
- New API endpoints for testing

### Stratum Protocol Support

#### Mining Methods

- `mining.subscribe(username)` — Miner login
  - Username format: `grin1<address>[.worker_name]`
  - Returns: subscription ID, extra nonce 1, extra nonce 2 size

- `mining.submit(username, job_id, extra_nonce2, block_bits, block_time)` — Share submission
  - Validates difficulty, stores share in database
  - Returns: true on accept, error on reject

### API Endpoints (Phase 1)

#### Stratum Stats
```
GET /api/stratum/stats
Response: { active_connections, active_miners, sessions }
```

#### Pool Stats
```
GET /api/pool/stats
Response: { total_blocks_found, total_reward, confirmed_blocks, active_miners }
```

#### Recent Blocks
```
GET /api/pool/blocks?limit=50
Response: [ { id, height, hash, nonce, reward, status, found_by, found_at } ]
```

#### Miner Shares
```
GET /api/account/{grin_address}/shares?limit=100&offset=0
Response: [ { grin_address, difficulty, block_height, share_hash, created_at } ]
```

#### Credit Block (Testing Only)
```
POST /api/test/credit-block
Body: { height, hash, nonce, reward, miner_address }
Response: { success, block_id, height, hash, reward }
```

### Testing Phase 1

#### 1. Start the Pool
```bash
npm start
```

#### 2. Connect a Test Miner

Use `nc` (netcat) or a stratum mining client:

```bash
# Using netcat (raw connection)
nc localhost 3333

# Send subscription message
{"jsonrpc": "2.0", "method": "mining.subscribe", "params": ["grin1testaddress1234567890abcdefghijklmnopqr"], "id": 1}

# Response should include subscription ID
# Then send share
{"jsonrpc": "2.0", "method": "mining.submit", "params": ["grin1testaddress...", "job1", "extra2", "difficulty", "timestamp"], "id": 2}
```

Or use a Python test script:
```python
import socket
import json

sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.connect(('127.0.0.1', 3333))

# Subscribe
msg = {
    "jsonrpc": "2.0",
    "method": "mining.subscribe",
    "params": ["grin1testaddress1234567890abcdefghijklmnopqr"],
    "id": 1
}
sock.send((json.dumps(msg) + '\n').encode())
response = sock.recv(1024)
print(response.decode())

# Submit share
msg = {
    "jsonrpc": "2.0",
    "method": "mining.submit",
    "params": ["grin1testaddress1234567890abcdefghijklmnopqr", "job1", "extra", "bits", "time"],
    "id": 2
}
sock.send((json.dumps(msg) + '\n').encode())
response = sock.recv(1024)
print(response.decode())

sock.close()
```

#### 3. Monitor Miner Connections
```bash
curl http://localhost:8080/api/stratum/stats
```

Expected output:
```json
{
  "active_connections": 1,
  "active_miners": 1,
  "sessions": [
    {
      "grin_address": "grin1testaddress...",
      "worker_name": "default",
      "difficulty": 1,
      "shares": 1,
      "online_seconds": 42
    }
  ]
}
```

#### 4. Credit a Block
```bash
curl -X POST http://localhost:8080/api/test/credit-block \
  -H "Content-Type: application/json" \
  -d '{
    "height": 12345,
    "hash": "abc123def456...",
    "nonce": 42,
    "reward": 60.0,
    "miner_address": "grin1testaddress1234567890abcdefghijklmnopqr"
  }'
```

#### 5. Check Pool Stats
```bash
curl http://localhost:8080/api/pool/stats
```

Expected output:
```json
{
  "total_blocks_found": 1,
  "total_reward": 60,
  "confirmed_blocks": 0,
  "confirmed_reward": 0,
  "immature_blocks": 1,
  "active_miners": 1,
  "active_connections": 1
}
```

### Validation Checklist (Phase 1)

- [ ] npm start runs without errors
- [ ] Stratum server listening on port 3333
- [ ] Test miner connects via mining.subscribe
- [ ] Share submission accepted (mining.submit returns true)
- [ ] GET /api/stratum/stats shows active connections
- [ ] Block credit endpoint works
- [ ] GET /api/pool/stats shows blocks and miners
- [ ] Database contains shares and blocks
- [ ] bash -n check passes

```bash
npm run check-syntax
```

---

## Phases 7, 8, 2, 6 — Payment Pipeline

Complete payment flow: **Block Confirmation → PPLNS Rewards → Wallet Integration → Withdrawal Processing**

### What's Added

#### Phase 7: Grin Node Integration
- `lib/grin-node.js` — Grin node API wrapper (RPC calls)
- `lib/block-monitor.js` — Watches for block confirmations
- `lib/orphan-detector.js` — Detects orphaned blocks via nonce verification

**How it works:**
- Polls Grin node every 30 seconds
- When block height ≥ confirm_depth: verifies nonce against chain
- If nonce mismatch: marks block as orphaned, reverses payouts
- If confirmed: updates block status, triggers reward distribution

#### Phase 8: PPLNS Reward Distribution
- `lib/rewards.js` — PPLNS reward calculator

**How it works:**
- When block is confirmed: fetches all shares in 60-block window
- Distributes `(block_reward - pool_fee)` proportional to share difficulty
- Credits miner balances and logs all transactions
- Pool fee goes to configurable address

#### Phase 2: Wallet Integration (Enhanced)
- `lib/wallet-tor.js` — Tor address sending + probing

**How it works:**
- `sendToTorAddress()` — Calls grin-wallet CLI to send payment
- `probeToronlineStatus()` — Checks if miner Tor listener is online (3-second timeout)
- `validateWalletSetup()` — Verifies wallet config exists

#### Phase 6: Withdrawal Scheduler
- `lib/withdrawal-scheduler.js` — Payment queue + retry logic

**How it works:**
- Monitors withdrawals in `tor_checking` status
- Probes Tor address reachability
- If online: sends payment via grin-wallet
- If offline: schedules retry (6h, 12h, 24h, 48h)
- After 4 failed retries: marks as `tor_failed`, reverses balance

### API Endpoints (Phase 7–6)

#### Node Status (Phase 7)
```
GET /api/admin/node-status
Response: { ok, height, total_difficulty, network, timestamp }
```

#### Block Monitor Status
```
GET /api/admin/block-monitor
Response: { running, last_known_height, last_orphan_check }
```

#### Distribute Rewards (Phase 8 — Testing)
```
POST /api/test/distribute-block
Body: { block_id }
Response: { block_id, block_height, success, total_reward, shares_distributed,
            unique_miners, pool_fee, miner_reward }
```

#### Reward Stats (Phase 8)
```
GET /api/admin/reward-stats
Response: { total_credited, miners_with_balance, top_miners }
```

#### Initiate Withdrawal (Phase 6 — Testing)
```
POST /api/test/initiate-withdrawal
Body: { grin_address, amount }
Response: { withdrawal_id, grin_address, amount, status, created_at }
```

#### View Withdrawals (Phase 6)
```
GET /api/admin/withdrawals?status=tor_checking|tor_sending|retry_scheduled|confirmed|tor_failed
Response: [ { id, grin_address, amount, status, retry_count, next_retry_at, ... } ]
```

#### Withdrawal Scheduler Status (Phase 6)
```
GET /api/admin/withdrawal-scheduler
Response: { running, pending, confirmed, failed }
```

#### Miner Balance (Public)
```
GET /api/account/{grin_address}/balance
Response: { grin_address, balance, balance_locked, total }
```

### Data Flow Diagram

```
[Miners connect]
       ↓
[Phase 1] Stratum Server
       ↓
[Submit shares] → [Database: shares table]
       ↓
[Block found] → [Credit pool] (Phase 1 mining)
       ↓
[Phase 7] Block Monitor polls Grin node
       ↓
[Orphan Detector] verifies nonce on-chain
       ↓
[Block confirmed] → status = 'confirmed'
       ↓
[Phase 8] Reward Distributor
       ↓
[Calculate PPLNS] → [Credit miner balances]
       ↓
[Balances logged] → [balance_log table]
       ↓
[Phase 6] Withdrawal Scheduler
       ↓
[Probe Tor address] → [Phase 2] Wallet Tor
       ↓
[Online?] → [Send via grin-wallet]
       ↓
[Success] → status = 'confirmed'
       ↓
[Lock → Unlock] → balance_locked → balance -= amount
       ↓
[Failed/Offline] → [Schedule retry] → [retry_scheduled]
       ↓
[Max retries] → [tor_failed, reverse balance]
```

### Testing Sequence

#### 1. Verify Node Connection
```bash
curl http://localhost:8080/api/admin/node-status
```

Expected:
```json
{
  "ok": true,
  "height": 12345,
  "total_difficulty": 1000000,
  "network": "testnet",
  "timestamp": 1234567890000
}
```

#### 2. Credit a Block
```bash
curl -X POST http://localhost:8080/api/test/credit-block \
  -H "Content-Type: application/json" \
  -d '{
    "height": 12000,
    "hash": "abc123...",
    "nonce": 42,
    "reward": 60.0,
    "miner_address": "grin1test..."
  }'
```

#### 3. Wait for Block Confirmation
Block Monitor will:
- Check node every 30s
- After 100 blocks (testnet): verify nonce
- Update status to 'confirmed'

Check progress:
```bash
curl http://localhost:8080/api/admin/block-monitor
curl http://localhost:8080/api/pool/blocks
```

#### 4. Distribute Rewards
Once block is confirmed:
```bash
curl -X POST http://localhost:8080/api/test/distribute-block \
  -H "Content-Type: application/json" \
  -d '{ "block_id": 1 }'
```

Check miner balances:
```bash
curl http://localhost:8080/api/account/grin1test.../balance
```

#### 5. Initiate Withdrawal
```bash
curl -X POST http://localhost:8080/api/test/initiate-withdrawal \
  -H "Content-Type: application/json" \
  -d '{
    "grin_address": "miner-tor-address.onion:3415",
    "amount": 10.0
  }'
```

#### 6. Monitor Withdrawal Status
```bash
curl http://localhost:8080/api/admin/withdrawals
curl http://localhost:8080/api/admin/withdrawal-scheduler
```

States:
- `tor_checking` → Probing Tor address (3s timeout)
- `tor_sending` → Sending via grin-wallet
- `confirmed` → Payment sent successfully
- `retry_scheduled` → Waiting for next retry
- `tor_failed` → Max retries exceeded, balance reversed

### Configuration (pool.json)

```json
{
  "node_api_url": "http://127.0.0.1:13413",
  "node_api_secret": "<grin_node_secret>",
  "confirm_depth_testnet": 100,
  "confirm_depth_mainnet": 1441,
  "pool_fee_percent": 2.0,
  "wallet_dir": "/opt/grin/pool-test/",
  "tor_socks_port": 9050,
  "tor_check_timeout_ms": 3000,
  "withdrawal_retry_delays": [21600, 43200, 86400, 172800]
}
```

### Validation Checklist

- [ ] Grin node running and accessible
- [ ] Node API secret configured
- [ ] Block Monitor starts without errors
- [ ] Block confirmation works (status changes to 'confirmed')
- [ ] Orphan detection triggered (6-hour interval)
- [ ] PPLNS distribution credits miner balances
- [ ] Withdrawal scheduler starts
- [ ] Withdrawals transition through states
- [ ] Reward stats show credited amounts
- [ ] Balance ledger is accurate

---

## Phases 4, 5, 10, 11, 12 — Admin Auth, Monitoring, Public API, Logging, UI

Admin authentication, real-time monitoring, public endpoints, audit logging, and admin dashboard UI.

### What's Added

#### Phase 4: Admin Authentication
- `lib/auth.js` — User registration, login, JWT tokens, password hashing
- `lib/auth-middleware.js` — `requireAuth`, `requireAdmin`, `requireFreshAuth` middleware
- Routes: `/api/auth/login`, `/api/auth/register`, `/api/auth/refresh`, `/api/auth/change-password`

**Features:**
- Bcrypt password hashing (10-salt cost)
- JWT access tokens (1h expiry) + refresh tokens (7d)
- Fresh auth requirement for sensitive operations (< 5 min)
- Login attempt logging to admin_audit_log

#### Phase 5: Stratum Monitoring (Real-time Hashrate)
- `lib/hashrate-tracker.js` — Records hashrate samples every 60s

**Metrics:**
- Pool hashrate (1h, 24h average)
- Per-miner hashrate tracking
- Top miners leaderboard
- Active connections

#### Phase 10: Public API Endpoints
- `/api/pool/stats` — Overall pool metrics
- `/api/pool/blocks` — Recent blocks with status
- `/api/pool/miners` — Top miners by balance
- `/api/pool/payments` — Recent confirmed withdrawals
- `/api/account/{addr}/balance` — Miner balance info (public)

#### Phase 11: Logging & Monitoring
- Admin audit log (all admin actions: login, password change, withdrawals)
- Comprehensive metrics endpoint
- Health check endpoint
- Error tracking throughout system

#### Phase 12: Admin UI Mockups
- `public/login.html` — Login/register form
- `public/admin.html` — Admin dashboard with:
  - Pool metrics cards (miners, hashrate, blocks, withdrawals)
  - Recent blocks table
  - Withdrawal queue
  - Top miners leaderboard
  - Audit log

### Architecture

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

### API Endpoints Reference

#### Phase 4 — Authentication

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

#### Phase 5 — Hashrate Monitoring

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

#### Phase 10 — Public Endpoints

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

#### Phase 11 — Admin Monitoring

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

### Testing Sequence

#### 1. Create Admin Account
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

#### 2. Login
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

#### 3. Access Admin Dashboard
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

#### 4. Open Admin UI
Navigate to: `http://localhost:8080/admin.html`
- Enter credentials on login.html
- View dashboard with real-time metrics
- Monitor blocks, withdrawals, miners

#### 5. Public API (no auth required)
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

### Configuration Requirements

Add to `pool.json`:
```json
{
  "port": 8080,
  "jwt_secret": "your-random-secret-32-chars-min",
  "pool_fee_percent": 2.0,
  "pool_fee_address": "pool_fee"
}
```

### Security Notes

- Passwords hashed with bcrypt (10 salt rounds)
- JWT tokens with expiry (access: 1h, refresh: 7d)
- Fresh auth required for sensitive ops (< 5 min)
- All admin actions logged (username, action, IP, timestamp)
- HTTPS recommended for production (enable SSL in nginx)

### Admin UI Features (Phase 12)

Dashboard shows:
- **Metrics Cards**: Active miners, pool hashrate, blocks, withdrawals
- **Recent Blocks**: Height, hash, reward, status, miner address
- **Withdrawal Queue**: Address, amount, status, retry count
- **Top Miners**: Address, balance, hashrate status
- **Audit Log**: Admin actions with timestamp and IP

Live updates every 10-30 seconds.

### Validation Checklist

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

---

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

See the full refactor plan at: `script07_flow_refactor.txt`
