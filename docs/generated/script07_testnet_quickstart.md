# Script 07 — Testnet Solo Mining Quickstart

**Goal:** Validate mining mechanics on testnet with IPOLLO ASIC G1 Mini.

**Scope:** Node connectivity → Wallet activation → Stratum listening → IPOLLO connection

---

## Prerequisites

- Testnet Grin node running (script 01 with `--testnet`)
- Node API reachable at `http://127.0.0.1:13413`
- grin-wallet binary available
- IPOLLO G1 Mini on same network (or SSH tunnel)

---

## Step 1: Verify Testnet Node

Check node is running and synced:

```bash
cd /opt/grin/node/testnet-prune

# Get node status (testnet port 13413)
SECRET=$(cat .api_secret)
curl -s -u "grin:$SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"get_status","params":[],"id":1}' \
  http://127.0.0.1:13413/v2/owner | jq '.result.Ok | {height, network, sync_status}'
```

Expected output:
```json
{
  "height": 1234567,
  "network": "Testnet",
  "sync_status": "Synced"
}
```

If not synced, wait for `height` to stop increasing (take ~30 min depending on network).

---

## Step 2: Initialize Testnet Wallet

Create or recover a testnet wallet:

```bash
# Choose a working directory
POOL_WALLET_DIR="/opt/grin/pool-test"
mkdir -p "$POOL_WALLET_DIR"
cd "$POOL_WALLET_DIR"

# Option A: Create new wallet (get free testnet coins from faucet first)
grin-wallet init --testnet

# Option B: Recover from seed
grin-wallet init --testnet -r
# Paste seed when prompted
```

Output:
```
Wallet setup complete!
Wallet data directory: /opt/grin/pool-test/wallet_data
Username: <your-username>
```

Note the seed (save it somewhere safe) and username.

---

## Step 3: Configure grin-wallet.toml

Edit wallet config to listen on Foreign API (stratum connects here):

```bash
# Find and edit the TOML
WALLET_TOML="$POOL_WALLET_DIR/grin-wallet.toml"
cat "$WALLET_TOML" | grep -A 5 "\[api\]"
```

**Key settings to patch:**

```toml
[api]
# Listen on all interfaces (or 127.0.0.1 if IPOLLO is on same machine)
listen_addr = "0.0.0.0"

# Testnet Foreign API port (default 13415, but can be custom)
api_listen_port = 13415

# Enable API
enable_foreign_api = true
enable_owner_api = true

[server]
# Testnet node address
check_node_api_https = false
node_api_secret_path = "<path_to_testnet_node_secret>"
```

**To find testnet node secret:**
```bash
cat /opt/grin/node/testnet-prune/.foreign_api_secret
# Copy this value into grin-wallet.toml
```

**Full example grin-wallet.toml section:**
```toml
[api]
listen_addr = "0.0.0.0"
api_listen_port = 13415
enable_foreign_api = true
enable_owner_api = true

[server]
check_node_api_https = false
node_api_secret_path = "/opt/grin/node/testnet-prune/.foreign_api_secret"
```

---

## Step 4: Start Wallet Listener

```bash
cd "$POOL_WALLET_DIR"

# Start wallet in API mode (testnet)
grin-wallet --testnet listen 2>&1 | tee wallet.log &

# Verify it's listening
sleep 2
ss -tlnp | grep 13415
```

Expected:
```
LISTEN    0      128      0.0.0.0:13415    0.0.0.0:*    users:(("grin-wallet",pid=12345,...))
```

---

## Step 5: Start Stratum Server

Use script 07 to start stratum server:

```bash
# SSH into VPS, run script 07
./grin-node-toolkit.sh

# Select: 7 → Mining Services
# Then: 1 → Setup Stratum Server (Testnet)
# It will prompt for:
#   - Node API URL: http://127.0.0.1:13413 (testnet)
#   - Wallet API URL: http://127.0.0.1:13415 (testnet, Foreign API port from above)
#   - Stratum port: 3333 (or custom, note this)
```

Or manually start stratum:

```bash
# Start Node.js stratum server
cd /opt/grin/pool-test/back-end-pool
npm start

# Should output:
# Stratum server listening on port 3333
# Pool API listening on port 8080
```

Verify listening:
```bash
ss -tlnp | grep 3333
```

---

## Step 6: Configure IPOLLO G1 Mini

On the IPOLLO web interface (`http://<ipollo-ip>:8080`):

1. **Pool Settings** → **Single Pool Configuration**
2. Set:
   - **Pool Address:** `<vps-public-ip>:3333` or `127.0.0.1:3333` (if local)
   - **Worker Name:** Leave blank or set to miner ID
   - **Username:** `grin1<wallet_address_hex>` (or just use any username — stratum assigns to wallet)

3. **Save & Reboot**

**To find wallet address:**
```bash
cd "$POOL_WALLET_DIR"
grin-wallet --testnet info
# Look for: "Listening for inbound transactions on ..."
# Extract the grin1... address
```

---

## Step 7: Monitor Mining

### Check Stratum Activity

```bash
# See active connections
curl http://localhost:8080/api/stratum/stats

# Expected output:
{
  "active_connections": 1,
  "active_miners": 1,
  "sessions": [
    {
      "grin_address": "grin1...",
      "shares": 42,
      "difficulty": 1,
      "online_seconds": 3600
    }
  ]
}
```

### Check Pool Stats

```bash
curl http://localhost:8080/api/pool/stats

# Expected:
{
  "total_blocks_found": 0,
  "total_reward": 0,
  "confirmed_blocks": 0,
  "active_miners": 1,
  "active_connections": 1
}
```

### Watch Wallet Balance

```bash
cd "$POOL_WALLET_DIR"
watch -n 5 'grin-wallet --testnet info | grep -A 2 "Confirmed"'
```

When a block is found and matures (6 blocks on testnet), balance increases.

### View Block Log

```bash
curl http://localhost:8080/api/pool/blocks?limit=10
```

---

## Step 8: Troubleshooting

### IPOLLO not connecting

1. **Check firewall:**
   ```bash
   sudo ufw allow 3333/tcp
   sudo ufw reload
   ```

2. **Check stratum listening on public IP:**
   ```bash
   ss -tlnp | grep 3333
   # Should show: 0.0.0.0:3333 (not 127.0.0.1)
   ```

3. **Check wallet is accessible from IPOLLO:**
   ```bash
   curl -v http://<vps-ip>:13415/v2/foreign
   # Should not hang or timeout
   ```

### Wallet not synced

```bash
# Check wallet sync progress
cd "$POOL_WALLET_DIR"
grin-wallet --testnet info
# Look for "Account: default" and balance status
```

If wallet lags node:
```bash
# Run wallet restore (takes 5-10 min)
grin-wallet --testnet restore
```

### No blocks found

- IPOLLO difficulty might be too high for testnet
- Check IPOLLO is actually submitting shares (look at stratum stats)
- Verify stratum server is running (check `npm` process)

### Stratum crashes on startup

Check logs:
```bash
tail -50 /opt/grin/logs/grin-pool-testnet.log
# Or if running npm directly:
# npm start output should show error
```

Common issue: Wallet not listening yet. Wait 5 sec after starting wallet, then start stratum.

---

## Quick Start Script

```bash
#!/bin/bash
set -e

POOL_WALLET_DIR="/opt/grin/pool-test"
NODE_API="http://127.0.0.1:13413"
WALLET_API="http://127.0.0.1:13415"

echo "=== Testnet Solo Mining Quickstart ==="

# 1. Check node
echo "[1/5] Checking testnet node..."
SECRET=$(cat /opt/grin/node/testnet-prune/.api_secret)
curl -s -u "grin:$SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"get_status","params":[],"id":1}' \
  "$NODE_API/v2/owner" | jq '.result.Ok.height' || { echo "Node not reachable"; exit 1; }

# 2. Init wallet if needed
if [[ ! -d "$POOL_WALLET_DIR" ]]; then
  echo "[2/5] Initializing wallet..."
  mkdir -p "$POOL_WALLET_DIR"
  cd "$POOL_WALLET_DIR"
  grin-wallet init --testnet
else
  echo "[2/5] Wallet already exists"
fi

# 3. Start wallet listener
echo "[3/5] Starting wallet listener..."
pkill -f "grin-wallet.*listen" || true
sleep 1
cd "$POOL_WALLET_DIR"
grin-wallet --testnet listen > wallet.log 2>&1 &
sleep 3

# 4. Start stratum
echo "[4/5] Starting stratum server..."
cd /opt/grin/pool-test/back-end-pool
npm start > stratum.log 2>&1 &
sleep 3

# 5. Show status
echo "[5/5] Checking status..."
echo ""
echo "✓ Wallet address:"
cd "$POOL_WALLET_DIR"
grin-wallet --testnet info | grep "Listening" || echo "  (wallet still syncing...)"
echo ""
echo "✓ Stratum stats:"
curl -s http://localhost:8080/api/stratum/stats | jq '.active_connections'
echo ""
echo "✓ Point IPOLLO to: <vps-ip>:3333"
echo ""
```

Save as `testnet-solo-start.sh`, run with `bash testnet-solo-start.sh`.

---

## Reference: TOML Paths

- **Wallet TOML:** `/opt/grin/pool-test/grin-wallet.toml`
- **Node TOML:** `/opt/grin/node/testnet-prune/grin-server.toml`
- **Node secrets:** `/opt/grin/node/testnet-prune/.api_secret` and `.foreign_api_secret`

---

## Next: From Solo to Pool

Once testnet solo mining works:
1. Add more IPOLLO units (script 07 handles multi-miner stratum)
2. Monitor PPLNS reward distribution (Phase 8)
3. Add withdrawal scheduler for automatic payouts (Phase 6)
4. Deploy to mainnet (same procedure, use 3414/3415/3420 ports)

See `script07_implementation_guides.md` for full pool features.
