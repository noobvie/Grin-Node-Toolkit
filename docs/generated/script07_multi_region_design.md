# Script 07 — Multi-Region Mining Pool Architecture

**Status:** Design Proposal
**Architecture:** Hub and Spoke (3 Satellites + 1 Central Hub)

## 1. Node Roles

### A. Regional Satellites (Asia, USA, Europe)
- **Grin Node:** Running in `pruned` mode. Provides the Stratum job source.
- **Stratum Server:** Built-in Grin node stratum (Port 3416).
- **Share Pusher:** 
    - Logic: Tail `grin-server.log`.
    - Auth: mTLS or a Shared Secret Header.
    - Payload: `{"region": "us-east", "worker": "addr.rig1", "difficulty": 100, "timestamp": 123456789}`.

### B. Central Hub (Single Global Instance)
- **Database:** PostgreSQL (Preferred over SQLite for concurrent writes from 3 regions).
- **API (Next.js/Node):** Receives shares, validates addresses, manages PPLNS accounting.
- **Wallet:** Handles payouts via Tor.
- **Web Dashboard:** Miner stats, global hashrate, and block history.

## 2. Share Pusher Technical Spec

The pusher must be resilient. If the Central Hub is offline, miners should not lose their work.

```javascript
// Pseudocode for Pusher Logic
const tail = spawn('tail', ['-f', 'grin-server.log']);
tail.stdout.on('data', (line) => {
    if (line.includes("Got share")) {
        const share = parseLogLine(line);
        shareBuffer.push(share);
    }
});

setInterval(async () => {
    if (shareBuffer.length > 0) {
        try {
            await postToCentral(shareBuffer);
            shareBuffer = [];
        } catch (err) {
            // Write to local sqlite 'failover' DB if central is down
            saveToFailover(shareBuffer);
        }
    }
}, 2000);
```

## 3. Network Ports

| Service | Port | Access |
|---|---|---|
| Stratum (Satellites) | 3416 | Public |
| P2P (Satellites) | 3414 | Public |
| Central API | 3002 | Satellites Only (IP Whitelist) |
| Web Dashboard | 443 | Public |

## 4. Key Advantages
- **Orphan Protection:** If a satellite finds a block, it broadcasts it immediately to its local P2P peers, minimizing "uncle" or orphan blocks.
- **Latency:** Miners enjoy a "local" connection feeling, reducing rejects.
- **Scalability:** You can add a 4th or 5th region (e.g., South America) just by spinning up a new satellite and pointing the Pusher to the same Hub.

## 5. Next Steps
1. Modify `07_grin_mining_public_pool.sh` to offer a "Satellite" install mode.
2. Develop the `share-pusher.js` utility.
