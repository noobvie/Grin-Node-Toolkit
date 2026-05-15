# Phases 7, 8, 2, 6 — Payment Pipeline

Complete payment flow: **Block Confirmation → PPLNS Rewards → Wallet Integration → Withdrawal Processing**

## What's Added

### Phase 7: Grin Node Integration
- `lib/grin-node.js` — Grin node API wrapper (RPC calls)
- `lib/block-monitor.js` — Watches for block confirmations
- `lib/orphan-detector.js` — Detects orphaned blocks via nonce verification

**How it works:**
- Polls Grin node every 30 seconds
- When block height ≥ confirm_depth: verifies nonce against chain
- If nonce mismatch: marks block as orphaned, reverses payouts
- If confirmed: updates block status, triggers reward distribution

### Phase 8: PPLNS Reward Distribution
- `lib/rewards.js` — PPLNS reward calculator

**How it works:**
- When block is confirmed: fetches all shares in 60-block window
- Distributes `(block_reward - pool_fee)` proportional to share difficulty
- Credits miner balances and logs all transactions
- Pool fee goes to configurable address

### Phase 2: Wallet Integration (Enhanced)
- `lib/wallet-tor.js` — Tor address sending + probing

**How it works:**
- `sendToTorAddress()` — Calls grin-wallet CLI to send payment
- `probeToronlineStatus()` — Checks if miner Tor listener is online (3-second timeout)
- `validateWalletSetup()` — Verifies wallet config exists

### Phase 6: Withdrawal Scheduler
- `lib/withdrawal-scheduler.js` — Payment queue + retry logic

**How it works:**
- Monitors withdrawals in `tor_checking` status
- Probes Tor address reachability
- If online: sends payment via grin-wallet
- If offline: schedules retry (6h, 12h, 24h, 48h)
- After 4 failed retries: marks as `tor_failed`, reverses balance

## API Endpoints (Phase 7–6)

### Node Status (Phase 7)
```
GET /api/admin/node-status
Response: { ok, height, total_difficulty, network, timestamp }
```

### Block Monitor Status
```
GET /api/admin/block-monitor
Response: { running, last_known_height, last_orphan_check }
```

### Distribute Rewards (Phase 8 — Testing)
```
POST /api/test/distribute-block
Body: { block_id }
Response: { block_id, block_height, success, total_reward, shares_distributed,
            unique_miners, pool_fee, miner_reward }
```

### Reward Stats (Phase 8)
```
GET /api/admin/reward-stats
Response: { total_credited, miners_with_balance, top_miners }
```

### Initiate Withdrawal (Phase 6 — Testing)
```
POST /api/test/initiate-withdrawal
Body: { grin_address, amount }
Response: { withdrawal_id, grin_address, amount, status, created_at }
```

### View Withdrawals (Phase 6)
```
GET /api/admin/withdrawals?status=tor_checking|tor_sending|retry_scheduled|confirmed|tor_failed
Response: [ { id, grin_address, amount, status, retry_count, next_retry_at, ... } ]
```

### Withdrawal Scheduler Status (Phase 6)
```
GET /api/admin/withdrawal-scheduler
Response: { running, pending, confirmed, failed }
```

### Miner Balance (Public)
```
GET /api/account/{grin_address}/balance
Response: { grin_address, balance, balance_locked, total }
```

## Data Flow Diagram

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

## Testing Sequence

### 1. Verify Node Connection
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

### 2. Credit a Block
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

### 3. Wait for Block Confirmation
Block Monitor will:
- Check node every 30s
- After 100 blocks (testnet): verify nonce
- Update status to 'confirmed'

Check progress:
```bash
curl http://localhost:8080/api/admin/block-monitor
curl http://localhost:8080/api/pool/blocks
```

### 4. Distribute Rewards
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

### 5. Initiate Withdrawal
```bash
curl -X POST http://localhost:8080/api/test/initiate-withdrawal \
  -H "Content-Type: application/json" \
  -d '{
    "grin_address": "miner-tor-address.onion:3415",
    "amount": 10.0
  }'
```

### 6. Monitor Withdrawal Status
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

## Configuration (pool.json)

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

## Validation Checklist

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

## Next: Phase 4 (Auth) + Phase 10 (API)

After testing Phases 7–6:
- Phase 4: Admin authentication (JWT + password)
- Phase 10: Public API endpoints (account pages)
- Phase 5: Stratum monitoring dashboard
- Phase 11/12: Admin UI mockups

See the full refactor plan at:
`flowcharts/script07_flow_refactor.txt`
