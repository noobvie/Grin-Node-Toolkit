# GRINIUM — Architecture

**Updated:** 2026-06-06
See [00_overview.md](00_overview.md) for stack reality (Express + HTML, not Next.js).

---

## Three-layer stack

```
┌──────────────────────────────────────────────────────────────┐
│ Nginx (reverse proxy, HTTPS via certbot)                     │
│  • serves static frontend  (/var/www/grin-pool/*)            │
│  • /api/* → Node.js backend (localhost)                      │
│  • security headers, rate-limit zones                        │
└───────────────────────────────┬──────────────────────────────┘
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│ Node.js / Express backend                                    │
│  HTTP API + Stratum TCP server, single long-lived process    │
│  Core systems (see backend.md):                              │
│   auth · stratum · shares · miners · blocks · block-monitor  │
│   rewards (PPLNS) · wallet · wallet-tor · withdrawal-scheduler│
│   orphan-detector · hashrate-tracker · alert-monitor         │
│   pool-settings · rate-limiter · ip-filter                   │
└───────────────────────────────┬──────────────────────────────┘
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│ SQLite (better-sqlite3)  /opt/grin/pool/<net>/pool.db        │
│  miner_accounts · shares · blocks · withdrawals · balance_log │
│  withdrawal_events · users · admin_audit_log · pool_settings  │
│  pool_locations · hashrate_history                            │
└───────────────────────────────┬──────────────────────────────┘
                                 ▼
        Grin node (Owner+Foreign API) · grin-wallet · Tor
```

One backend process per network. Mainnet and testnet run fully isolated
(separate dirs, ports, services, DB files).

---

## Request / money flow

```
Miner ── stratum ──▶ share validated ──▶ shares table
                                            │
Pool wallet finds coinbase ──▶ blocks table (status=pending)
                                            │
        confirm_depth reached (1441 mainnet / 100 testnet)
                                            │
        orphan check (nonce in chain?) ──▶ if orphan: reverse
                                            │ else
                          PPLNS distribute ──▶ miner_accounts.balance
                                            │
        balance ≥ threshold / manual ──▶ withdrawal (Tor or Slatepack)
                                            │
                                    grin-wallet send ──▶ Grin network
```

Every balance change writes an append-only `balance_log` row. Every withdrawal
state change writes a `withdrawal_events` row. See [payments.md](payments.md).

---

## Ports

| Service | Mainnet | Testnet |
|---|---|---|
| Backend HTTP API | 3002 | 3003 |
| Stratum (miners connect) | 3416 | 13416 |
| Grin node API (Owner/Foreign) | 3413 | 13413 |
| Wallet Foreign / Owner API | 3415 / 3420 | 13415 / 13420 |
| Tor SOCKS | 9050 | 9050 |

> Note the discrepancy with the parent toolkit's CLAUDE.md, which documents the
> *solo* stratum on `3333` and a pool HTTP API on `8080`. GRINIUM (the public
> pool) uses `3416`/`3002`. These are different products; don't unify the ports.

---

## Database schema (target)

10 core tables. **Money columns are target `INTEGER` nanoGRIN** (1 GRIN = 1e9);
the current code still uses `REAL` — see BUG-16 in [build-plan.md](build-plan.md).
Timestamps are `INTEGER` unixepoch.

### miner_accounts — balances, keyed by Grin address (no user rows for miners)
```sql
grin_address   TEXT PRIMARY KEY,
balance        INTEGER NOT NULL DEFAULT 0,   -- nanoGRIN, spendable
balance_locked INTEGER NOT NULL DEFAULT 0,   -- nanoGRIN, held in pending withdrawal
total_paid     INTEGER NOT NULL DEFAULT 0,
is_online      INTEGER NOT NULL DEFAULT 0,
location       TEXT DEFAULT NULL,            -- region miner connected to (multi-region)
created_at     INTEGER NOT NULL
-- CHECK (balance >= 0), CHECK (balance_locked >= 0)
```

### shares — PPLNS input
```sql
id                 INTEGER PRIMARY KEY,
grin_address       TEXT NOT NULL REFERENCES miner_accounts(grin_address),
worker_name        TEXT,
difficulty         REAL NOT NULL,            -- share weight (currently fixed 1.0)
earned_grin        INTEGER DEFAULT 0,        -- credited on distribution
paid_in_block_id   INTEGER DEFAULT NULL,     -- set at distribution → prevents double-pay (BUG-03)
created_at         INTEGER NOT NULL
-- INDEX (paid_in_block_id), INDEX (created_at)
```

### blocks — found blocks + maturity
```sql
id          INTEGER PRIMARY KEY,
height      INTEGER UNIQUE NOT NULL,
hash        TEXT UNIQUE,
nonce       INTEGER,                          -- for orphan nonce-check (pre-launch req)
miner_address TEXT,
reward      INTEGER NOT NULL,                 -- nanoGRIN
status      TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | orphan
location    TEXT DEFAULT NULL,
found_at    INTEGER NOT NULL
```

### withdrawals — payouts (Tor or Slatepack); see payments.md for full spec
```sql
id            INTEGER PRIMARY KEY,
grin_address  TEXT NOT NULL REFERENCES miner_accounts(grin_address),
amount        INTEGER NOT NULL,               -- nanoGRIN
fee           INTEGER NOT NULL DEFAULT 0,
method        TEXT NOT NULL DEFAULT 'tor',    -- tor | slatepack   (NEW)
status        TEXT NOT NULL DEFAULT 'tor_checking',
retry_count   INTEGER NOT NULL DEFAULT 0,
next_retry_at INTEGER DEFAULT NULL,
claim_token   TEXT DEFAULT NULL,              -- slatepack only, one-time (NEW)
txid          TEXT DEFAULT NULL,              -- idempotency (pre-launch req)
cancelled_by  INTEGER REFERENCES users(id),
created_at    INTEGER NOT NULL,
confirmed_at  INTEGER DEFAULT NULL
-- INDEX (grin_address, status), INDEX (status, next_retry_at)
```

### balance_log — append-only ledger (every balance/locked change)
```sql
id, grin_address, event_type(credit|debit|lock|reversal|cancel),
amount, balance_before, balance_after, locked_before, locked_after,
reference_type(share|withdrawal|admin_adjust), reference_id, created_at
-- INDEX (grin_address, created_at DESC), INDEX (created_at DESC)
```

### withdrawal_events — per-withdrawal state transition log (append-only)
```sql
id, withdrawal_id, from_status, to_status,
triggered_by(auto|scheduler|admin|system|miner), actor_id, note, created_at
```

### users — admin accounts only
```sql
id, username UNIQUE, password_hash, is_admin DEFAULT 1,
failed_login_attempts INTEGER DEFAULT 0, locked_until INTEGER, created_at
```

### admin_audit_log — every admin mutation (one column shape — see BUG-18)
```sql
id, admin_id, action, target_type, target_id,
before_state(JSON), after_state(JSON), ip, created_at
-- INDEX (admin_id, created_at DESC), INDEX (target_type, target_id, created_at DESC)
```

### pool_settings — runtime config overrides editable via admin UI
```sql
key TEXT PRIMARY KEY, value TEXT, value_type(string|int|float|bool|json), updated_at
```
> `value_type='json'` must be honored on read (BUG-25) — alert_thresholds is JSON.

### pool_locations — multi-region endpoints
```sql
id, region, api_url, log_path DEFAULT NULL, is_active DEFAULT 1, created_at
```

### hashrate_history — timeseries (also used for per-region aggregates)
```sql
id, grin_address DEFAULT NULL, worker_name, hashrate_gps REAL,
miner_count INTEGER, recorded_at INTEGER
```

---

## API catalog (Express routes)

**Public — no auth (address is identity):**
```
GET  /api/health
GET  /api/pool/stats
GET  /api/pool/stats/regions
GET  /api/pool/blocks?limit&offset&status
GET  /api/pool/payments?limit&offset          (aggregate/anon — see security.md)
GET  /api/pool/miners/top?limit&sort
GET  /api/pool/locations
GET  /api/account/:addr
GET  /api/account/:addr/balance/log?limit&offset
GET  /api/account/:addr/tor-check             (rate-limited per addr)
POST /api/account/:addr/withdraw  { amount, method? }
GET  /api/claim/:id?token=…                   (slatepack — returns S1)   NEW
POST /api/claim/:id?token=…  { slatepack_s2 } (slatepack — finalize)     NEW
```

**Admin auth (admin register is CLI-only, not exposed):**
```
POST /api/auth/login          GET /api/auth/me
POST /api/auth/refresh        POST /api/auth/logout
POST /api/auth/reauth         (fresh-auth for sensitive ops)
```

**Admin (requireAdmin):**
```
GET  /api/admin/dashboard | /health | /stats | /metrics
GET  /api/admin/payment-stats | /payment-stats/miners/:addr
GET  /api/admin/miners        PUT /api/admin/miners/:addr
POST /api/admin/miners/:addr/inject           (testnet only)
GET  /api/admin/withdrawals
POST /api/admin/withdrawals/:id/retry   [requireFreshAuth]
POST /api/admin/withdrawals/:id/cancel  [requireFreshAuth]
GET  /api/admin/withdrawals/:id/events
GET  /api/admin/users         PUT /api/admin/users/:id
GET  /api/admin/audit-log
GET  /api/admin/alerts | alerts/:id/acknowledge | snooze | config
GET/POST /api/admin/locations   DELETE /api/admin/locations/:id
```

---

## Multi-region — satellite federation (not a shared DB)

The primary backend owns the one database. Remote regions run their own Grin
node + a backend in **satellite mode** that just exposes `/api/pool/stats`. The
primary **pulls** aggregates every 60s into `hashrate_history`. Satellites never
write the primary's DB → no distributed-database problem, SQLite stays viable.

```
Region EU  [grin node + satellite backend]  ─┐
Region US  [grin node + satellite backend]  ─┤ /api/pool/stats (HTTP, pulled 60s)
Region ASIA[grin node + satellite backend]  ─┘
                                              ▼
                          PRIMARY backend (owns pool.db)
```

**Open gap:** the design federates *display stats* but does not yet specify how
an accepted **share** from a remote-region miner reaches the central ledger.
Decided approach: satellites **forward accepted shares** to the primary over an
internal HTTP channel (batched, latency-tolerant) — keeps one writer, keeps
SQLite. See [infrastructure.md](infrastructure.md) for why this beats a shared
network DB.

Schema support: `pool_locations.log_path`, `miners.location` (additive
`ALTER TABLE ADD COLUMN`, safe on existing DBs).

---

## Testnet

Backend is config-driven; testnet = a different config file. Isolated instance:
`/opt/grin/pool/testnet/`, service `grin-pool-manager-testnet`, port 3003,
stratum 13416, node API 13413. Currency label `tGRIN` vs `GRIN` via a
`currency()` config helper. Testnet flag is `--testnet` (never `--floonet`).
Admin balance-inject endpoint is testnet-only (guarded). `confirm_depth`
defaults to 100 on testnet for faster feedback.
