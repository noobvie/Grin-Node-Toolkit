# Script 07 — Multi-Region Mining Pool Architecture

**Status:** Design Proposal
**Architecture:** Hub and Spoke (N Satellites + 1 Central Hub)

## 1. Node Roles

### A. Regional Satellites (Asia, USA, Europe, …)
- **Grin Node:** Running in `pruned` mode. Its **built-in stratum is bound to localhost** and serves as the *upstream* job source / block submitter for the proxy. **Never touches the pool database** — it is a blockchain peer only.
- **Stratum Proxy (own server — selected, §5):** The public miner endpoint. Speaks stratum to miners and connects as a stratum client to the local node's built-in stratum upstream. Owns **per-miner vardiff**, structured **identity capture** (`address.worker`), share validation, dedup by `(nonce, height)`, and abuse controls.
- **Share Relay Agent:** Takes structured share/block events from the proxy and delivers them to the Hub.
    - Transport: `HTTPS POST /api/shares` (batched) and `/api/blocks` (block-found).
    - Auth: Shared Secret header over HTTPS (mTLS optional, later).
    - Payload: `{"region": "us-east", "worker": "addr.rig1", "difficulty": 100, "timestamp": 123456789}`.
    - On Hub outage: buffer to a **local SQLite failover file** and replay when the Hub returns.

### B. Central Hub (Single Global Instance)
- **Database:** **SQLite (WAL mode).** The Hub is a *single-writer* system (see §2) — SQLite is the correct fit, not a compromise. The local Europe stratum reaches it via Internal IPC; remote satellites reach it via `HTTPS POST /api/shares`. **All writes funnel through the one Central API process.**
- **API (Next.js/Node):** Receives shares, validates addresses, manages PPLNS accounting. **Sole writer to the database.**
- **Wallet:** Handles payouts via Tor.
- **Web Dashboard:** Miner stats, global hashrate, and block history (read-only DB consumer).

## 2. Database Architecture — Why SQLite, and When to Migrate

### Single-writer by design
Trace every arrow that reaches the database in the architecture diagram: there is exactly **one** — `Central API → Store → DB`. The satellites, Grin nodes, stratum servers, and share pushers never open the database. Three regions ingest shares, but all paths converge on **one Central API process**, and only that process writes.

```
Satellite (Asia)   ─ Share Pusher ─ HTTPS POST /api/shares ─┐
Satellite (USA)    ─ Share Pusher ─ HTTPS POST /api/shares ─┼─▶ Central API ──▶ SQLite (WAL)
Europe (local)     ─ Stratum ─ Internal IPC ────────────────┘   (single writer)        ▲
                                                                                         │
                                                          Next.js Dashboard ── reads ────┘
```

What looks like "concurrent writes from 3 regions" is **connection concurrency** at the HTTP layer (handled by Node's event loop), not **database-writer concurrency**. The Central API accepts the concurrent POSTs, then batches each interval's shares into a single transaction. SQLite in WAL mode gives:
- **One writer + unlimited concurrent readers**, no reader/writer blocking → the dashboard never stalls share ingestion.
- **100k+ row inserts/sec** when batched per interval (vastly above the ~100 shares/sec a 1,000-miner pool produces).
- **Zero database ops** on a box that already handles wallet funds — no extra server to secure/patch/tune, and backup is a single-file copy.

### When to migrate to PostgreSQL
The trigger is **topology of the hub**, not the number of satellites or the miner count. Migrate only if you change the hub so the database stops having a single writer:

| Trigger | Why it forces Postgres |
|---|---|
| **Central API goes multi-process / replicated** behind a load balancer (HA) | Multiple writer processes against one DB — SQLite's single-writer model no longer fits |
| **DB moved onto a separate box** from the Central API (DB-over-network) | SQLite has no network protocol; sharing over NFS/SMB breaks its locking → corruption. Use Postgres or a distributed-SQLite layer (LiteFS / rqlite / dqlite) |
| **Sustained > 10k durable shares/sec** *and* you insist on persisting every raw share | Beyond the comfortable single-writer envelope (and a retention smell — see §4) |
| **Hot relational data > ~20–50 GB** that cannot be pruned | SQLite still works but operational ergonomics favour Postgres at that scale |
| Need **multi-master replication / hot standby** failover | Native to Postgres; not to SQLite |

Adding a 4th/5th satellite changes **none** of these — a new region is a new HTTP *client* (pusher), not a new DB writer. The hub stays single-writer.

### PRAGMAs (set at DB creation)
```sql
PRAGMA journal_mode  = WAL;          -- concurrent readers + one writer
PRAGMA synchronous   = NORMAL;       -- safe with WAL, far faster than FULL
PRAGMA auto_vacuum   = INCREMENTAL;  -- reclaim space after prune (see §4)
PRAGMA busy_timeout  = 5000;         -- ride out brief lock contention
PRAGMA foreign_keys  = ON;
```

## 3. Database Schema

Design rule: **separate the high-volume disposable path (shares) from the low-volume durable path (money).** Raw shares are a sliding window; financial rows are kept forever.

> **Implementation status (2026-06):** the live schema is owned by `back-end-pool/lib/db.js` (`createSchema()`), not this section. It differs from the idealized model below: balances are `REAL` GRIN (not nanogrin integers), tables are keyed by `grin_address` (not `miner_id`), raw `shares` carry `block_height` + `created_at`, and hashrate is a single-resolution `hashrate_history` table. The DDL below is kept as the conceptual target; treat `db.js` as authoritative.

```sql
-- Live miner identity & balance (bounded: ~1 row per address)
CREATE TABLE miners (
  id          INTEGER PRIMARY KEY,
  address     TEXT    NOT NULL UNIQUE,        -- grin address = identity (2miners style)
  balance     INTEGER NOT NULL DEFAULT 0,     -- nanogrin, locked on update (SELECT ... FOR UPDATE pattern)
  total_paid  INTEGER NOT NULL DEFAULT 0,     -- nanogrin
  first_seen  INTEGER NOT NULL,               -- unix seconds
  last_share  INTEGER
);

-- Rolling RAW shares — ONLY the PPLNS window lives here; pruned continuously (§4)
CREATE TABLE shares (
  id          INTEGER PRIMARY KEY,
  miner_id    INTEGER NOT NULL REFERENCES miners(id),
  worker      TEXT,
  region      TEXT,                            -- us-east / asia / europe
  difficulty  INTEGER NOT NULL,                -- share difficulty = PPLNS weight
  is_valid    INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL                 -- unix seconds
);
CREATE INDEX idx_shares_created ON shares(created_at);
CREATE INDEX idx_shares_miner   ON shares(miner_id, created_at);

-- Per-ROUND aggregate — one row per miner per found block; durable PPLNS history.
-- Written when a round closes, then the round's raw shares become prunable.
CREATE TABLE round_shares (
  id          INTEGER PRIMARY KEY,
  block_id    INTEGER NOT NULL REFERENCES blocks(id),
  miner_id    INTEGER NOT NULL REFERENCES miners(id),
  share_count INTEGER NOT NULL,
  diff_sum    INTEGER NOT NULL,                -- summed difficulty = payout weight
  UNIQUE(block_id, miner_id)
);

-- Blocks found (keep forever)
CREATE TABLE blocks (
  id          INTEGER PRIMARY KEY,
  height      INTEGER NOT NULL,
  hash        TEXT    NOT NULL UNIQUE,
  nonce       TEXT,                            -- for nonce-based orphan detection
  reward      INTEGER NOT NULL,                -- nanogrin
  region      TEXT,                            -- which satellite found it
  status      TEXT    NOT NULL DEFAULT 'pending', -- pending|confirmed|orphaned|paid
  found_at    INTEGER NOT NULL,
  matured_at  INTEGER                          -- found_at + maturity (1440 main / 100 test)
);
CREATE INDEX idx_blocks_status ON blocks(status);

-- Payouts (keep forever — audit / tax)
CREATE TABLE payouts (
  id          INTEGER PRIMARY KEY,
  miner_id    INTEGER NOT NULL REFERENCES miners(id),
  amount      INTEGER NOT NULL,                -- nanogrin
  status      TEXT    NOT NULL DEFAULT 'queued', -- queued|sent|confirmed|failed
  slate_id    TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,      -- Tor retry counter (6h, up to 7 days)
  created_at  INTEGER NOT NULL,
  sent_at     INTEGER
);
CREATE INDEX idx_payouts_miner ON payouts(miner_id, created_at);

-- Hashrate time-series — DOWNSAMPLED by resolution (§4)
CREATE TABLE hashrate_samples (
  id          INTEGER PRIMARY KEY,
  miner_id    INTEGER REFERENCES miners(id),   -- NULL = pool-wide aggregate
  resolution  TEXT    NOT NULL,                -- '5m' | '1h' | '1d'
  bucket_ts   INTEGER NOT NULL,                -- bucket start, unix seconds
  gps         REAL    NOT NULL,                -- graphs/sec (Cuckatoo32)
  UNIQUE(miner_id, resolution, bucket_ts)
);
CREATE INDEX idx_hashrate_lookup ON hashrate_samples(resolution, bucket_ts);
```

### Why this stays small (1,000 miners)
- **Raw `shares`** would be ~300 GB/yr if kept whole (~100 shares/sec). Kept as a sliding window only → **~50–100 MB, flat**.
- **`hashrate_samples`** downsampled (5m→1h→1d) → a few hundred MB, then near-flat.
- **`payouts` + `blocks`** kept forever but tiny → **~30 MB/yr**.
- **Net: ~300–600 MB after year 1, ~30 MB/yr thereafter.** Sub-gigabyte for a decade. The size is set by the retention policy, not the miner count.

## 4. Retention & Cleanup

> **Implementation status (2026-06):** implemented in `back-end-pool/lib/retention.js` (`RetentionManager`), scheduled from `index.js`, configured via the admin panel **Settings → Database** (`database` settings section) with live status + manual run at `GET/POST /api/admin/database/*`. It diverges from the idealized job below to fit the real schema:
> - **Shares** are pruned by a **provably-safe height floor** — `confirm_depth + PPLNS window (60) + shares_margin_blocks`, additionally clamped below the oldest `immature` block — so a share that a pending PPLNS distribution or orphan reversal could read is never deleted.
> - **Hashrate** is single-resolution, so it is **pruned by age** (`hashrate_keep_days`) rather than downsampled 5m→1h→1d.
> - **Resolved/acknowledged alerts** are pruned by age.
> - File space is reclaimed by the **existing weekly `VACUUM` cron** (Script 07 option C), not by `auto_vacuum`.

### Three tiers
1. **Delete** — raw shares past the PPLNS window. Already aggregated into `round_shares`; no value. Continuous, not a yearly sweep.
2. **Downsample** — fine hashrate samples roll up as they age: `5m` (7 d) → `1h` (90 d) → `1d` (forever).
3. **Keep / archive** — `payouts` and `blocks` are never deleted (audit/tax). Optional export to compressed CSV/Parquet if you want them out of the hot DB.

### Prune/downsample job (`lib/retention.js`)
Runs on a timer (systemd timer or `setInterval` in the Central API). All windows come from config (§4 admin panel) so ops never edit code.

```js
// lib/retention.js — invoked every cfg.retention.prune_interval_seconds
function runRetention(db, cfg) {
  const now = Math.floor(Date.now() / 1000);
  const r = cfg.retention;

  const tx = db.transaction(() => {
    // 1. Prune raw shares older than the PPLNS window (already in round_shares)
    db.prepare(`DELETE FROM shares WHERE created_at < ?`)
      .run(now - r.pplns_window_seconds);

    // 2. Downsample 5m -> 1h for samples older than hashrate_5m_keep_days, then drop the 5m rows
    const cut5m = now - r.hashrate_5m_keep_days * 86400;
    db.prepare(`
      INSERT OR IGNORE INTO hashrate_samples (miner_id, resolution, bucket_ts, gps)
      SELECT miner_id, '1h', (bucket_ts / 3600) * 3600 AS h, AVG(gps)
      FROM hashrate_samples
      WHERE resolution = '5m' AND bucket_ts < ?
      GROUP BY miner_id, h
    `).run(cut5m);
    db.prepare(`DELETE FROM hashrate_samples WHERE resolution = '5m' AND bucket_ts < ?`)
      .run(cut5m);

    // 3. Downsample 1h -> 1d for samples older than hashrate_1h_keep_days
    const cut1h = now - r.hashrate_1h_keep_days * 86400;
    db.prepare(`
      INSERT OR IGNORE INTO hashrate_samples (miner_id, resolution, bucket_ts, gps)
      SELECT miner_id, '1d', (bucket_ts / 86400) * 86400 AS d, AVG(gps)
      FROM hashrate_samples
      WHERE resolution = '1h' AND bucket_ts < ?
      GROUP BY miner_id, d
    `).run(cut1h);
    db.prepare(`DELETE FROM hashrate_samples WHERE resolution = '1h' AND bucket_ts < ?`)
      .run(cut1h);

    // 4. (1d kept forever when hashrate_1d_keep_days = 0; else prune)
    if (r.hashrate_1d_keep_days > 0) {
      db.prepare(`DELETE FROM hashrate_samples WHERE resolution = '1d' AND bucket_ts < ?`)
        .run(now - r.hashrate_1d_keep_days * 86400);
    }

    // 5. Optional: export+drop payouts older than archive_payouts_after_days (0 = keep in hot DB)
    if (r.archive_payouts_after_days > 0) {
      // exportPayoutsToArchive(db, r.archive_export_path, now - r.archive_payouts_after_days * 86400);
    }
  });
  tx();

  // 6. Release freed pages back to disk (file actually shrinks)
  if (r.vacuum_after_prune) db.pragma('incremental_vacuum');
}
```

> **Safety:** only prune raw `shares` *after* the round has been aggregated into `round_shares`. Never delete shares for a round whose block is still `pending`/`confirming` — orphan reversal (§ pool architecture) may need to recompute it.

### Cleanup options in the admin panel
Per the Script 07 rule (all settings via web admin, no bash config), retention lives in `/opt/grin/conf/grin_pool.json` under a new `retention` category and is editable in the admin panel **Settings → Database / Cleanup**. The job reads this config each run — no restart needed.

```json
"retention": {
  "pplns_window_seconds":      21600,   // raw-share window kept for PPLNS (6h)
  "hashrate_5m_keep_days":     7,       // 5-min resolution retained, then -> 1h
  "hashrate_1h_keep_days":     90,      // 1-hour resolution retained, then -> 1d
  "hashrate_1d_keep_days":     0,       // 0 = keep daily samples forever
  "prune_interval_seconds":    300,     // how often retention.js runs
  "vacuum_after_prune":        true,    // incremental_vacuum to shrink the file
  "archive_payouts_after_days": 0,      // 0 = keep payouts in hot DB forever
  "archive_export_path":       "/opt/grin/pool/archive"
}
```

Admin panel fields (Settings → Database / Cleanup):

| Field | Control | Default | Notes |
|---|---|---|---|
| PPLNS raw-share window | minutes/hours | 6 h | Must be ≥ the PPLNS N window; lower = smaller DB |
| Keep 5-min hashrate for | days | 7 | Then auto-rolls to hourly |
| Keep hourly hashrate for | days | 90 | Then auto-rolls to daily |
| Keep daily hashrate for | days (0 = forever) | 0 | Chart history depth |
| Prune interval | minutes | 5 | How often the job runs |
| Vacuum after prune | toggle | on | Shrinks the file on disk |
| Archive payouts after | days (0 = never) | 0 | Off by default; exports then drops |
| Current DB size | read-only | — | Live `PRAGMA page_count × page_size` |
| Run cleanup now | button | — | Manual trigger of retention.js |

## 5. Share Capture — Stratum Proxy (SELECTED)

**Decision: own stratum server / proxy.** Log-tailing was rejected (see below).

In Grin the node's stratum is integrated and there is no clean external `getblocktemplate` RPC, so the practical "own server" is a **stratum proxy in front of the node's built-in stratum** — the proven model used by `grin-pool`:

```
Miners ──stratum──▶ Stratum Proxy ──stratum (client)──▶ Grin node built-in stratum (localhost)
                         │
                         └── structured share/block events ──▶ Share Relay Agent ──▶ Hub
```

The proxy:
- Binds the **public** stratum port; the node's built-in stratum binds **localhost only**.
- Sees every `login`/`submit` as structured JSON → reliable `address.worker` identity + difficulty + nonce + timestamp (no log parsing).
- Translates between **per-miner vardiff** and the upstream node difficulty.
- Detects block-found when a submit is accepted upstream / meets network difficulty → emits a block event to the relay.
- Validates, de-duplicates by `(nonce, height)`, rate-limits, and can ban abusive miners.

The relay must be resilient: if the Hub is offline, buffer events to a local SQLite failover file and replay on recovery.

```javascript
// Relay agent — receives structured events from the proxy (NOT log scraping)
setInterval(async () => {
    if (shareBuffer.length > 0) {
        try {
            await postToCentral(shareBuffer);   // HTTPS POST /api/shares (shared-secret header)
            shareBuffer = [];
        } catch (err) {
            saveToFailover(shareBuffer);         // local SQLite failover DB; replay on recovery
        }
    }
}, 2000);
```

> **Rejected alternative — log-tailing `grin-server.log`:** brittle (format is not a stable API; breaks on Grin upgrades / log rotation), cannot do per-miner vardiff (built-in stratum has one global `minimum_share_difficulty`), and is not guaranteed to print `address.worker` per share — which would make PPLNS attribution impossible. Acceptable only as a throwaway prototype; not used.

## 6. Network Ports

| Service | Port | Access |
|---|---|---|
| Public stratum (Satellites) | 3333 | Public |
| Node built-in stratum (upstream) | 3334 (testnet 13334) | localhost only |
| P2P (Satellites) | 3414 | Public |
| Central API (share/block ingestion) | 8080 | Satellites only (IP allowlist + shared secret) |
| Web Dashboard | 443 | Public |

> Ports match CLAUDE.md and the Script 07 implementation. The single-box installer was migrated off the legacy `3416/3417/3002` to `3333/3334/8080` in 2026-06.

## 7. Key Advantages
- **Orphan Protection:** If a satellite finds a block, it broadcasts immediately to its local P2P peers, minimizing orphan/uncle blocks.
- **Latency:** Miners get a "local" stratum connection, reducing stale/rejected shares.
- **Scalability:** Add a region by spinning up a new satellite and pointing its pusher at the Hub. The hub stays **single-writer** — a new region is a new HTTP client, not a new DB writer (so SQLite continues to fit; see §2).

## 8. Deployment Modes — Script 07 Split (Step 1 scope)

Script 07 gains a **mode selector**. The existing **single-box** pool is preserved (it is simply "Hub + co-located Satellite" on one server). Two install directions, each backed by its own `07_lib_*` library:

### Direction 1 — Satellite install (`07_lib_satellite.sh`)
Runs on each regional Grin node. Deploys **mining ingress + relay only** — no web, no admin, no pool DB, no wallet.
1. Grin node (pruned) present/started; **built-in stratum enabled on localhost** as the proxy upstream.
2. **Stratum proxy** service (Node.js) — public stratum port; per-miner vardiff; identity capture (§5).
3. **Share relay agent** (Node.js) — structured share/block events → `HTTPS POST` to Hub; shared-secret auth; **local SQLite failover buffer** + replay.
4. systemd units (proxy, relay); ufw (open public stratum; no inbound for Central API).
5. Config → `/opt/grin/conf/grin_satellite.json` (hub URL, shared secret, region name, vardiff bounds).

### Direction 2 — Central Hub install (`07_lib_hub.sh`)
Runs on the central server. Deploys **the brain** — no public stratum required (optional co-located satellite for the Primary region).
1. **Central API** (Node) — `/api/shares` + `/api/blocks` ingestion (IP allowlist + shared secret); PPLNS accounting; **sole DB writer**.
2. **SQLite (WAL)** DB + schema (§3) + `retention.js` job (§4) on a systemd timer.
3. **Next.js** public dashboard + **admin panel** (incl. Database / Cleanup settings).
4. **Grin wallet** — Tor payouts.
5. nginx vhost + SSL; backups; systemd units.
6. Config → `/opt/grin/conf/grin_pool.json` (existing schema + `retention` block + `satellites` allowlist).

**Script 07 role unchanged:** infrastructure only (deploy files, systemd, nginx, backups). All business logic lives in the pool web code.

### Menu shape
```
Script 07 ─ install mode:
  1) Single-box pool   (Hub + local Satellite on one server — existing behaviour)
  2) Central Hub       (brain only; remote satellites relay in)
  3) Satellite         (regional node + proxy + relay → points at a Hub)
```

## 9. Open Decisions Before Coding

| # | Decision | Recommended default |
|---|---|---|
| 1 | Ports | ✅ RESOLVED — single-box migrated to public stratum `3333`, node upstream `127.0.0.1:3334` (testnet `13334`), Central API `8080` (bash + backend in sync) |
| 2 | Satellite→Hub auth | Shared-secret header over HTTPS for v1; mTLS later |
| 3 | Runtime for proxy + relay | Node.js (matches stack; better-sqlite3 for failover buffer) |
| 4 | Event protocol | `POST /api/shares` (batched) + `POST /api/blocks` (block-found); both IP-allowlisted + shared-secret |
| 5 | Confirm proxy upstream model (grin-pool style) against a live node | Verify on testnet before building the proxy |

## 10. Implementation Status

- ✅ **Ports** reconciled to `3333/3334/8080` (bash + backend).
- ✅ **Script 07 mode split** (§8) + `07_lib_satellite.sh` / `07_lib_hub.sh` (bash menus stubbed).
- ✅ **Retention job** (`lib/retention.js`) + admin **Database / Cleanup** settings (§4).
- ✅ **Stratum proxy** — existing `stratum-server.js` (public) + `node-stratum-client.js` (upstream).
- ✅ **Relay agent** (`lib/share-relay.js`) + **satellite entrypoint** (`satellite.js`): forwards accepted shares (batched) + found blocks (immediate) to the hub, with local SQLite failover + at-least-once replay.
- ✅ **Hub ingestion** (`POST /api/shares`, `/api/blocks` in `index.js`): shared-secret header + optional IP allowlist; idempotent via `share_hash` / `hash` UNIQUE.
- ✅ **Config keys**: `role`, `region`, `hub_url`, `hub_shared_secret`, `satellite_ip_allowlist`, `relay_batch_interval_ms`.

- ✅ **Local block crediting** — `stratum-server.js` now credits found blocks to the local DB (single-box/hub) via `BlockManager.creditBlock`, or relays them (satellite). Wired in `index.js` (`setBlockManager`).
- ✅ **Bash deployment glue** — `07_lib_satellite.sh` deploys `satellite.js` (app copy + `npm ci` + systemd + `grin_satellite.json` + node-stratum toml patch); `07_lib_hub.sh` manages the shared secret + satellite IP allowlist in `grin_pool.json`.

- ✅ **PPLNS payout trigger** — `block-monitor.js` now distributes rewards for confirmed blocks each tick (`distributeConfirmedBlocks`), idempotent via the block `confirmed → paid` transition in `rewards.js`. Wired in `index.js` (`setRewardDistributor`). Full chain now closed: found → credit → mature/verify → confirm → distribute → balance → withdrawal.

### Remaining (operator responsibility, not code)
1. **`grin-server.toml` `wallet_listener_url`** — the satellite node's stratum coinbase must point at the POOL wallet (the hub's wallet for multi-region) or block rewards go to the wrong place. `sat_enable_node_stratum` prompts for it but leaves cross-region wallet routing to the operator.
