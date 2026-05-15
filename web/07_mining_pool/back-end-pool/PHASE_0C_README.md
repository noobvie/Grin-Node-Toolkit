# Phase 0c — Environment Validation & Setup

## What's Created

✅ **Foundation for Node.js mining pool backend**

- `package.json` — Dependencies (Express, better-sqlite3, bcryptjs, jsonwebtoken, node-cron)
- `index.js` — Express app entry point with basic routes
- `lib/db.js` — SQLite database with all 10 tables + indexes
- `lib/wallet.js` — Grin wallet API wrapper (balance, send, address validation)
- `lib/config.js` — Configuration loader (JSON + environment variables)
- `pool.json.template` — Configuration template (copy to `pool.json`)
- `scripts/nuke.js` — Cleanup script for testing (`npm run nuke`)

## Setup Instructions

### 1. Install Dependencies

```bash
cd web/07_mining_pool/back-end-pool
npm install
```

### 2. Create Configuration

```bash
cp pool.json.template pool.json
```

Edit `pool.json` to match your testnet environment:
- `wallet_dir`: Path to grin-wallet directory (e.g., `/opt/grin/pool-test/`)
- `node_api_url`: Grin node API endpoint (e.g., `http://127.0.0.1:13413` for testnet)
- `jwt_secret`: Generate a random secret (32+ characters)
- `network`: Set to `testnet` for development

### 3. Start the Pool

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

### 4. Test the Setup

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

## Validation Checklist (Phase 0c)

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

## Reset for Testing

To wipe the database and restart:

```bash
npm run nuke
npm start
```

## Next: Phase 1

Once Phase 0c is working:
1. Mining core (stratum protocol, share acceptance, PPLNS)
2. Block crediting
3. Balance tracking

See the full refactor plan at:
`flowcharts/script07_flow_refactor.txt`
