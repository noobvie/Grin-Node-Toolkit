# Phase 1 — Mining Core

## What's Added

✅ **Stratum mining protocol server + share/block tracking**

- `lib/stratum-server.js` — TCP server (stratum protocol)
- `lib/stratum-protocol.js` — Message parsing & validation
- `lib/shares.js` — Share validation & storage
- `lib/blocks.js` — Block crediting & status tracking
- `lib/miners.js` — Miner session management
- New API endpoints for testing

## Stratum Protocol Support

### Mining Methods

- `mining.subscribe(username)` — Miner login
  - Username format: `grin1<address>[.worker_name]`
  - Returns: subscription ID, extra nonce 1, extra nonce 2 size

- `mining.submit(username, job_id, extra_nonce2, block_bits, block_time)` — Share submission
  - Validates difficulty, stores share in database
  - Returns: true on accept, error on reject

## API Endpoints (Phase 1)

### Stratum Stats
```
GET /api/stratum/stats
Response: { active_connections, active_miners, sessions }
```

### Pool Stats
```
GET /api/pool/stats
Response: { total_blocks_found, total_reward, confirmed_blocks, active_miners }
```

### Recent Blocks
```
GET /api/pool/blocks?limit=50
Response: [ { id, height, hash, nonce, reward, status, found_by, found_at } ]
```

### Miner Shares
```
GET /api/account/{grin_address}/shares?limit=100&offset=0
Response: [ { grin_address, difficulty, block_height, share_hash, created_at } ]
```

### Credit Block (Testing Only)
```
POST /api/test/credit-block
Body: { height, hash, nonce, reward, miner_address }
Response: { success, block_id, height, hash, reward }
```

## Testing Phase 1

### 1. Start the Pool
```bash
npm start
```

### 2. Connect a Test Miner
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

### 3. Monitor Miner Connections
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

### 4. Credit a Block
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

### 5. Check Pool Stats
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

## Validation Checklist (Phase 1)

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

## Next: Phase 6 (Payment Monitor)

Once Phase 1 is confirmed working:
1. Connect to real Grin node API
2. Monitor for confirmed blocks
3. Distribute rewards via PPLNS (Phase 8)
4. Process withdrawals (Phase 6)

See the full refactor plan at:
`flowcharts/script07_flow_refactor.txt`
