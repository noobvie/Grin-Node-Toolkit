# GRINIUM — Infrastructure

**Updated:** 2026-06-06
Deployment, nginx, systemd, database choice + backup runbook, multi-region.

---

## Deployment layout

**Repo (dev):**
```
deploy/pool_deploy.sh              guided install → configure → web → nginx → admin → start
deploy/lib/nginx_shared_helpers.sh shared nginx rate-limit-zone primitives
web/back-end-pool/                 Express backend + admin-panel
web/public_html/                   static frontend (nginx serves)
```

**Production (VPS):**
```
/opt/grin/pool/mainnet/   Node app (index.js, lib/, pool.json, pool.db)
/opt/grin/pool/testnet/   Node app (isolated; service ...-testnet, port 3003)
/opt/grin/conf/           admin-editable settings
/opt/grin/logs/           service logs (journald is primary)
/var/www/grin-pool/       frontend served by nginx
/etc/nginx/sites-available/grin-pool
/etc/systemd/system/grin-pool-manager[-testnet].service
```

## systemd unit (per network)

```
[Unit]
Description=Grin Pool Manager (<network>)
After=network.target
[Service]
Type=simple
User=root
WorkingDirectory=/opt/grin/pool/<net>
ExecStart=/usr/bin/node index.js
Environment=NODE_ENV=production
Environment=GRIN_POOL_CONF=/opt/grin/pool/<net>/pool.json
Restart=on-failure
RestartSec=5s
LimitNOFILE=65535
[Install]
WantedBy=multi-user.target
```
> The old "v4" unit used `next start` — ignore; the live entry point is
> `node index.js` (Express). A **watchdog** cron (every 5 min) restarts the
> service if `systemctl is-active` fails — same pattern as `052_lib_wallet.sh`.

## nginx

- `/api/*` → `proxy_pass` to the backend port (3002 / 3003).
- `/*` → static `/var/www/grin-pool/`.
- `/admin` paths and `/api/admin/*` are reachable but **gated in the app**
  (requireAdmin); `robots.txt` disallows `/admin`.
- Rate-limit zones via the shared helper (`nginx_ensure_rate_limit_zone`) — never
  inline `limit_req_zone`. Script-specific zones get a `script07-`-style conf
  name. Key zones: `pool_api` (30 r/m, public API), `pool_torcheck`
  (1 req/60s/IP, the tor-check probe).
- `nginx -t` before every reload.

## Bash installer responsibilities (`pool_install` / `pool_deploy_web`)

- Node ≥ 18 version guard (global `fetch` dependency).
- `npm ci` (or `npm install --omit=dev`) in the app dir.
- Generate `jwt_secret` **once at install** and write it into `pool.json` — the
  backend must **not** auto-regenerate it at boot (BUG-37).
- `node init-db.js` to create/migrate the schema (additive `ALTER TABLE ADD
  COLUMN` guards for new columns).
- Write systemd unit + watchdog cron; `nginx -t`; certbot for SSL.
- `pool_configure()` prompts: network, stratum/node ports, `pool_fee_percent`,
  `pool_fee_address`, `min_withdrawal` (≥ default), `confirm_depth`,
  `auto_payout` toggle, region/`log_path`.
- `pool_update()` (menu `U`): refresh files → `npm install` → restart.
- Every `.sh` change passes `bash -n` before commit.

---

## Database — engine choice (decided 2026-06-06)

**Stay on SQLite (`better-sqlite3`) now. Migrate to PostgreSQL only if true HA/
failover or cross-machine multi-writer pressure appears. Never MariaDB.**

Why this is the right call:

- **Throughput isn't the bottleneck.** Grin's ~60s blocks + Cuckatoo32 mean low
  share volume. Estimate: 50 workers ≈ 8 writes/s, 500 workers ≈ 80 writes/s —
  far under SQLite-WAL's thousands/s on one SSD. Contention only appears around
  ~2,000+ concurrent active miners.
- **Multi-region doesn't require a shared DB.** The satellite-federation model
  (see [architecture.md](architecture.md)) keeps **one writer process** on the
  primary; satellites expose an API and **forward shares**. SQLite cannot be
  shared over a network filesystem — and it doesn't need to be.
- **Switching now is costly and premature.** `better-sqlite3` is synchronous /
  in-process; moving to a networked RDBMS means rewriting the whole DB layer to
  async, on a pool that isn't working yet.
- **If a networked RDBMS is ever needed, Postgres > MariaDB** for a money ledger:
  exact `NUMERIC`/`BIGINT`, `SELECT … FOR UPDATE SKIP LOCKED` (ideal for the
  payout job queue), MVCC, logical replication for per-region read replicas.

**Migration trigger (future):** HA/failover need, OR cross-machine shared-DB
need, OR > ~2,000 concurrent miners. Keep `db.js` a thin abstraction so the swap
touches only that module, not the route handlers.

> The more urgent DB fix is **money precision**: store integer **nanoGRIN**
> (1 GRIN = 1e9), not floating-point `REAL` (BUG-16). Engine-independent; do it
> in SQLite now and it carries straight into Postgres later.

---

## SQLite reliability, backup & restore (runbook)

SQLite does not corrupt on its own — corruption comes from misuse, all
avoidable. The safe topology is exactly ours: **one local writer process on
local disk** (not NFS/SMB).

**Set once at boot (in `db.js`):**
```sql
PRAGMA journal_mode = WAL;     -- concurrent readers + one writer
PRAGMA synchronous  = NORMAL;  -- safe + fast with WAL
PRAGMA busy_timeout = 5000;    -- wait instead of "database is locked"
PRAGMA foreign_keys = ON;
```

**Rules that prevent corruption:**
- DB on the box's **local SSD** only. Cloud *block* volumes (EBS, DO Volumes)
  are fine; **never** a network filesystem (NFS/SMB).
- One process owns the file (✓ by design); one `better-sqlite3` version.
- **Never** `cp`/`rsync` the live `.db` file — you can capture a torn write.

**Backups — use the online backup API, not file copy:**
- **Continuous (primary):** [Litestream](https://litestream.io) streams the WAL
  to S3/B2/another disk in real time → point-in-time restore, seconds of RPO.
- **Periodic snapshot (cron, hourly/daily):**
  `sqlite3 pool.db ".backup '/backups/pool-$(date +%F-%H).db'"` (consistent,
  safe during live writes). Or `VACUUM INTO`.
- **Portable dump (DR/migration):** `sqlite3 pool.db .dump > pool.sql`.
- **Integrity check (nightly cron):** `PRAGMA integrity_check;` → alert if not
  `ok`.

**Restore:**
1. `systemctl stop grin-pool-manager`
2. Replace `pool.db` with the backup, or `litestream restore -o pool.db <url>`
3. `systemctl start grin-pool-manager`
With Litestream you lose at most the last few seconds.

**Honest limit:** SQLite's real weak spot is **HA/failover** (no built-in hot
standby), not corruption. Litestream gives fast restore-to-new-box (minutes,
tiny loss) — sufficient for a pool. True hot standby is the one legitimate future
reason to consider Postgres.

---

## Multi-region topology

- Primary backend owns `pool.db`. Satellites run their own node + a backend in
  satellite mode exposing `/api/pool/stats`.
- Primary pulls aggregates every 60s into `hashrate_history`
  (`worker_name = region`).
- **Latency-sensitive = stratum** (regional servers for low stale-share rates).
  **Latency-tolerant = accounting** (share-forwarding can batch). Don't conflate.
- Schema: `pool_locations.log_path`, `miners.location` (additive columns).
- `GET /api/pool/stats/regions` returns the per-region breakdown.

---

## Pre-launch infra checklist (see build-plan.md for the full list)

- [ ] `confirm_depth = 1441` mainnet / `100` testnet
- [ ] `jwt_secret` written at install, never auto-regenerated
- [ ] Litestream + nightly `integrity_check` + tested restore
- [ ] Watchdog cron for the pool service; graceful SIGTERM shutdown verified
- [ ] HTTPS enforced; `pool.json` holds all secrets (none hardcoded in code)
- [ ] `bash -n` clean on all `07_*`/deploy scripts; `nginx -t` clean
