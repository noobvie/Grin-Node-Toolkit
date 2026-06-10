# Script 07 — Public Mining Pool (Implementation)

Deployment layout, build/wiring status, database runbook, pre-launch checklist, and
troubleshooting for the public pool. Design lives in
[`script07_design.md`](script07_design.md); security in
[`script07_security_audit.md`](script07_security_audit.md).

---

## 1. Deployment layout

**Repo:**
```
scripts/07_grin_mining_public_pool.sh   mode selector → install/configure/web/nginx/admin/start
scripts/lib/07_lib_hub.sh               Central Hub install (brain)
scripts/lib/07_lib_satellite.sh         Satellite install (node + proxy + relay)
scripts/lib/nginx_shared_helpers.sh     shared nginx rate-limit-zone primitives
web/07_mining_pool_public/
  back-end-pool/        Express backend (index.js, lib/, satellite.js, admin-panel/, public/)
  public_html/          static frontend (nginx serves)
```

**Production (VPS):**
```
/opt/grin/pubpool/mainnet/   Node app (index.js, lib/, pool.json, pool.sqlite)
/opt/grin/pubpool/testnet/   isolated instance (service …-testnet)
/opt/grin/conf/grin_pubpool.json        singlebox/hub config (admin-editable)
/opt/grin/conf/grin_satellite.json   satellite config (hub URL, secret, region, vardiff)
/var/www/grin-pool/                  frontend served by nginx
/etc/nginx/sites-available/grin-pool
/etc/systemd/system/grin-pool-manager[-testnet].service
```

### systemd unit (per network)
```
[Service]
Type=simple
WorkingDirectory=/opt/grin/pubpool/<net>
ExecStart=/usr/bin/node index.js
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=5s
LimitNOFILE=65535
```
A **watchdog cron** (every 5 min) restarts the service if `systemctl is-active` fails (same
pattern as `052_lib_wallet.sh`). The backend handles SIGTERM/SIGINT → stop scheduler →
`server.close` → `db.close()` so the SQLite WAL flushes cleanly on `systemctl stop`.

### nginx
- `/api/*` → `proxy_pass` to the backend (`:8080`); `/*` → static `/var/www/grin-pool/`.
- `robots.txt`/`sitemap.xml`/`manifest.json` are exact-match `location =` proxies (win over static).
- Rate-limit zones via the shared helper only — **never inline `limit_req_zone`**. Script-specific
  zones use a `script07-` conf prefix (e.g. `pool_api_<net>`); `/custom/` location sets
  `X-Content-Type-Options: nosniff` + a sandbox CSP (see security audit).
- `nginx -t` before every reload.

### Installer responsibilities
- Node ≥ 24 guard (`node:sqlite`) with NodeSource auto-install (`pool_ensure_node24`); `npm ci` (or `--omit=dev`) in the app dir.
- Generate `jwt_secret` **once at install** into `pool.json` (the backend should not silently
  regenerate it at boot — that invalidates all JWTs on restart).
- Create/migrate schema via `db.js` (`createSchema()`, additive `ALTER TABLE ADD COLUMN` guards).
- Write systemd unit + watchdog cron; `nginx -t`; certbot for SSL.
- `pool_configure()` prompts: network, ports, `pool_fee_percent`, `pool_fee_address`,
  `min_withdrawal`, `confirm_depth`, `auto_payout`, region.
- Satellite install (`07_lib_satellite.sh`): deploys `satellite.js` (app copy + `npm ci` + systemd +
  `grin_satellite.json` + node-stratum toml patch). Hub install (`07_lib_hub.sh`): manages the shared
  secret + satellite IP allowlist in `grin_pubpool.json`.
- Every `.sh` change passes `bash -n` before commit.

---

## 2. Implementation status (verified against `web/07_mining_pool_public/`, 2026-06-08)

✅ done · ⚠ partial · ❌ not built

| Area | Status | Notes |
|---|---|---|
| Ports reconciled `3333/3334/8080` | ✅ | `config.js` (stratum 3333, node upstream 3334/13334, HTTP 8080) — bash + backend in sync |
| Mode split singlebox/hub/satellite | ✅ | `config.js` `role`; `07_lib_hub.sh` / `07_lib_satellite.sh` |
| Stratum proxy | ✅ | `stratum-server.js` (public) + `node-stratum-client.js` (upstream) |
| Relay agent + satellite entrypoint | ✅ | `lib/share-relay.js` + `satellite.js` — batched shares + immediate blocks, local SQLite failover + at-least-once replay |
| Hub ingestion `/api/shares` `/api/blocks` | ✅ | `index.js` — shared-secret header + optional IP allowlist; idempotent via `share_hash`/`hash` UNIQUE |
| Multi-region config keys | ✅ | `role, region, hub_url, hub_shared_secret, satellite_ip_allowlist, relay_batch_interval_ms` |
| Multi-region read/observability | ✅ | `region` column on `shares` (`migrateShares()`) + `pool_locations` table; `GET /api/pool/stats/regions` + `/api/pool/locations`; admin `GET/POST/DELETE /api/admin/locations`; in-memory satellite-liveness → `GET /api/admin/health/satellites` |
| Public account API | ✅ | `GET /api/account/:addr` (summary), `/balance/log`, `/tor-check`; `POST /api/account/:addr/withdraw` (Tor only) → `WithdrawalScheduler.createWithdrawal` (CAS lock, 1-pending-per-address) |
| Admin miners + testnet inject | ✅ | `GET /api/admin/miners[/:addr]`; `POST /api/admin/miners/:addr/inject` (testnet-only, 403 on mainnet) writes `balance_log` + audit row |
| Local block crediting | ✅ | `stratum-server.js` → `BlockManager.creditBlock` (single-box/hub) or relay (satellite); wired via `index.js setBlockManager` |
| PPLNS payout trigger | ✅ | `block-monitor.js distributeConfirmedBlocks` each tick; idempotent `confirmed→paid` in `rewards.js`; wired via `setRewardDistributor`. Full chain closed: found → credit → mature/verify → confirm → distribute → balance → withdrawal |
| Retention/cleanup | ✅ | `lib/retention.js` (`RetentionManager`) scheduled from `index.js`; admin **Settings → Database**; height-floor share prune (confirm_depth + PPLNS window + margin, clamped below oldest immature block) + age-based hashrate/alert prune |
| White-label / branding / SEO | ✅ | see design §9; `branding.js`, dynamic robots/sitemap/manifest, theme builder |
| Incentives (prize pool/bonus/lottery) | ✅ | `lib/incentives.js`, `lib/lottery.js`; `donate.html`, `fortune-board.html` |
| Asset upload hardening | ✅ | see security audit §A |
| Auth hardening | ✅ | `trust proxy`+`req.ip` (rate-limiter/ip-filter/satellite allowlist); bcrypt 12; account lockout (`failed_login_attempts`/`locked_until`); refresh-token rotation+revocation (`token_version`); `jwt_secret` fail-loud at boot — see security audit §B |
| Public-page XSS escaping | ✅ | `escHtml` on `miners-stats`/`payment-history` sinks (+ existing `fortune-board`), atop stratum bech32 address regex |
| System-health metrics | ✅ | real CPU/mem/disk/uptime now served by admin `GET /api/admin/health/system` (Node `os` + `fs.statfsSync`); health page moved into the admin panel (was a public page with hardcoded values). ⚠ verify the old public `system-health.html` no longer renders the fake cards |
| Money precision (REAL → nanoGRIN) | ❌ | balances still `REAL` GRIN in `db.js` — design follow-up |
| Grin Transporter payout rail | ❌ | `lib/wallet-transporter.js` is a forced-off stub ([Script 056](script056_design.md)) |

### Remaining operator responsibility (not code)
- **`grin-server.toml` `wallet_listener_url`** — the satellite node's stratum coinbase must point at
  the **pool** wallet (the hub's wallet for multi-region) or block rewards go to the wrong place.
  `sat_enable_node_stratum` already **warns loudly and prompts** for it
  ([`07_lib_satellite.sh`](../../scripts/lib/07_lib_satellite.sh) lines ~214–222); cross-region wallet
  routing is left to the operator by design. *(Not a code gap — operator decision.)*

### Deferred decisions & open items — read before mainnet (2026-06-08)

These are **intentionally not coded yet**. Each needs a product call, not more implementation guessing.
Listed here so we don't re-litigate or accidentally re-implement.

| # | Item | Status / why deferred | Recommendation |
|---|---|---|---|
| D1 | **System-health fake metrics** | ✅ **Resolved 2026-06-08** — real metrics via admin `GET /api/admin/health/system`; health page moved into the admin panel (gated, not public). ⚠ confirm the legacy public `system-health.html` / `miners-stats` uptime no longer render hardcoded values. | Done (backend + page move). Frontend verification owed. |
| D2 | **Money precision `REAL` GRIN → integer nanoGRIN** | Touches all payout/reward/withdrawal/balance_log math + display. High blast radius. | Do as its **own PR + full testnet soak**, never as a side-change. Engine-independent (do it in SQLite, carries to Postgres). |
| D3 | **mTLS satellite→hub** | v1 is shared-secret header over HTTPS (+ IP allowlist), which is acceptable. | Infra/manual (cert provisioning) — defer until multi-operator trust needs it. |
| D4 | **Grin Transporter payout rail** | `lib/wallet-transporter.js` is a forced-off stub; blocked on Script 056 (not built). | Keep stub off until [Script 056](script056_design.md) ships. |
| D5 | **Theme-system unification** (public `body.<theme>-theme` → `theme.js` CSS variables) | Cosmetic; refactor risk across 13 themes. | Defer; not launch-blocking. |
| D6 | **i18n / multi-language content** | Product scope; content + tooling. | Defer (phase 2). |
| D7 | **Fiat (USD/EUR/BTC) price display** | Feature; could wire to the Script 06 price collector. | Optional — your call on data source. |
| D8 | **Optional free miner accounts** (true one-person-one-entry lottery) | Conflicts with register-free identity model; partial Sybil trade-off documented (design §9). | Defer (phase 2 design decision). |
| D9 | **Admin theme live-preview iframe + WCAG contrast check** | Admin UX nicety. | Defer; not launch-blocking. |

### Verification still owed by the operator (not changed in code)
The "Implemented 2026-06-08" items in security audit §B are syntax-checked + logic-reviewed but **not**
runtime-tested locally (`node_modules` live only on the VPS). On a testnet box, confirm:
- a real **login → refresh → old-refresh-replay-rejected** cycle, and **5-fail lockout** then unlock;
- every **admin mutation writes an `admin_audit_log` row** (not line-audited per handler);
- money flow (**orphan reversal exact amounts, idempotent send, CAS balance lock**) against a live DB.

---

## 3. Scheduler jobs

| Job | Cadence | Purpose |
|---|---|---|
| Block confirmation | per tick | promote pending blocks past `confirm_depth` → distribute |
| Orphan detection | 6h | nonce-check confirmed blocks; reverse orphans (exact `balance_log` amounts) |
| Auto-payout | 6h | pay miners with balance ≥ threshold (if `auto_payout`) |
| Withdrawal retry | 30m | re-attempt `retry_scheduled` past `next_retry_at` (6/12/24/48h backoff) |
| Region aggregation | 60s | pull satellite `/api/pool/stats` → `hashrate_history` |
| Retention | `prune_interval_seconds` | prune raw shares + downsample/age hashrate + prune alerts |
| Reconciliation | daily | ledger-vs-balance check; alert on variance |

---

## 4. Database — engine & backup runbook

**Stay on SQLite (Node's built-in `node:sqlite`) now** (one local writer; see design §4 for the migration
triggers). The safe topology is exactly ours: **one local writer process on local disk** — SQLite
does not corrupt on its own; corruption comes from misuse, all avoidable.

**Rules that prevent corruption:**
- DB on the box's **local SSD** only. Cloud *block* volumes (EBS, DO Volumes) are fine; **never** a
  network filesystem (NFS/SMB).
- One process owns the file (✓ by design); one Node/`node:sqlite` version.
- **Never** `cp`/`rsync` the live `.sqlite` — you can capture a torn write.

**Backups — use the online backup API, not file copy:**
- **Continuous (primary):** [Litestream](https://litestream.io) streams the WAL to S3/B2/another disk
  → point-in-time restore, seconds of RPO.
- **Periodic snapshot (cron):** `sqlite3 pool.sqlite ".backup '/backups/pool-$(date +%F-%H).db'"`
  (consistent during live writes) or `VACUUM INTO`.
- **Portable dump (DR/migration):** `sqlite3 pool.sqlite .dump > pool.sql`.
- **Integrity check (nightly cron):** `PRAGMA integrity_check;` → alert if not `ok`.

**Restore:** `systemctl stop` → replace `pool.sqlite` (or `litestream restore`) → `systemctl start`.
With Litestream you lose at most the last few seconds.

**Honest limit:** SQLite's real weak spot is **HA/failover** (no built-in hot standby), not
corruption. That is the one legitimate future reason to consider Postgres.

---

## 5. Pre-launch checklist

**Money / consensus**
- [x] `confirm_depth = 1440` mainnet / `100` testnet (= Grin `COINBASE_MATURITY`) — **set in code 2026-06-08** (config.js, pool-settings.js, retention.js, template, admin UI)
- [ ] Found blocks persisted; orphan reversal reverses exact `balance_log` amounts incl. fee, no neg balance
- [ ] PPLNS double-pay guard active (shares marked paid per block in the distribution transaction)
- [ ] Withdrawal balance lock is compare-and-swap; max 1 pending per address; wallet send idempotent (`txid`)

**Auth / security** (see [`script07_security_audit.md`](script07_security_audit.md))
- [x] bcrypt ≥ 12; refresh-token revocation; account lockout — **code done 2026-06-08** (`auth.js`/`db.js`); runtime-verify on testnet
- [x] httpOnly cookie auth — **code done** (`index.js` login/register set httpOnly cookies). ⚠ still verify the frontend gate `await`s an authenticated endpoint (not `/api/health`)
- [x] `trust proxy` + `req.ip` (no raw `X-Forwarded-For` trust); `jwt_secret` written at install — **code done 2026-06-08**
- [x] SVG/upload hardening (§A) + `admin_audit_log` single shape (`migrateAdminAuditLog`). ⚠ still confirm public payments/miners are aggregated/gated

**Infra / ops**
- [ ] Litestream + nightly `integrity_check` + a **tested restore**
- [ ] Watchdog cron; graceful SIGTERM verified; HTTPS enforced; secrets only in `pool.json`
- [x] `bash -n` clean on all `07_*` scripts (2026-06-08); `node --check` clean on all backend JS — ⚠ `nginx -t` runs on the VPS
- [ ] 7-day testnet soak before mainnet

---

## 6. Testnet mode

Backend is config-driven; testnet = a different config file + isolated instance
(`/opt/grin/pubpool/testnet/`, service `grin-pool-manager-testnet`, node API `13413`, node stratum
upstream `13334`, wallet `13415/13420`). Currency label `tGRIN`; `--testnet` (never `--floonet`);
`confirm_depth` defaults to 100; admin balance-inject endpoint is testnet-only (guarded). Testnet
deploy is stratum-capable; mainnet adds the full web dashboard.

Quick solo/testnet smoke test (IPOLLO): init wallet, patch TOML, start listener + node stratum,
point the miner at `:3333` — see the in-repo `grin_mining_testnet_instruction.html`.

---

## 7. Troubleshooting

| Symptom | Likely cause / check |
|---|---|
| Miners connect but get no work | `NodeStratumClient` needs `pool_address` set, or it can't log in to the node's built-in stratum → no jobs. Verify `config.pool_address` and that the node stratum is up on `127.0.0.1:3334`/`13334`. |
| Pool hashrate reads ~0 / meaningless | Hashrate must come from summed accepted-share difficulty over the window (`GPS = sumDiff × 42 / window_s / 16384`), not the assigned session target. |
| `/api/pool/stats` disagrees with `/api/stratum/stats` | Two `MinerManager` instances — construct one in `index.js` and inject it into the stratum server. |
| Block rewards go to the wrong wallet (multi-region) | Satellite `grin-server.toml` `wallet_listener_url` not pointed at the hub's pool wallet (§2 operator note). |
| JWTs invalid after restart | `jwt_secret` regenerated at boot instead of read from `pool.json` — write it at install. |
| Allowlist / lockout bypassable | Missing `app.set('trust proxy', 1)` → code trusts spoofable `X-Forwarded-For`. Use `req.ip`. |
| Uploaded logo/icon 404s | `assets_dir` mismatch vs the app working dir, or the `/custom/` nginx alias/permissions; ensure the dir is nginx-traversable. |
| Node "won't start" after a root run | A root-run node leaves `root:root` files → `grin` user gets EACCES. Always run as `grin` with `HOME=$GRIN_DIR` (see CLAUDE.md launch contract). |

Diagnostics: `journalctl -u grin-pool-manager[-testnet] -f`; `systemctl status`; test node API per the
CLAUDE.md curl snippets; `sqlite3 pool.sqlite 'PRAGMA integrity_check;'`.

---

## 8. Multi-region bring-up & test plan

Everything here runs on a **testnet VPS** (or two), never locally — `node_modules` and systemd
units live only on the server. The data-plane federation (satellite → relay → hub ingestion →
DB write → PPLNS) is built and testable; a few documented surfaces are **not wired yet** — see
§8.4 before you treat a scenario as "passing".

### 8.1 Topology for the test

| Box | Role | Deploys | Listens |
|---|---|---|---|
| **Hub** | `hub` (or `singlebox` for a 1-box first pass) | Central API + DB + web/admin + wallet + nginx | `:8080` API (ingestion), `:443` web; `:3333` only in singlebox |
| **Satellite** | `satellite` | node + stratum proxy + relay → hub | `:3333` public stratum, relays to hub `:8080` |

Start with **singlebox** to prove the local pipeline end-to-end, *then* split into hub + 1
satellite to prove federation. Don't debug federation and the core pipeline at the same time.

### 8.2 Bring-up order

**Hub** (`07_grin_mining_public_pool.sh` → mode 2):
1. `1) Install` → `2) Configure` (network, fee, wallet, region) → `3) Deploy web` → `4) nginx + SSL` → `5) Create admin`.
2. `A) Ingestion auth` → generate the shared secret (copy it — satellites need it).
3. `R) Satellite registry` → add each satellite's public IP to the allowlist (or leave empty to accept any IP that has the secret).
4. `6) Service control` → start; `7) Status` → confirm `:8080` is listening.

**Satellite** (mode 3, on the regional box):
1. `1) Install` → `2) Configure` (region, **hub URL**, **shared secret**, **pool Grin address**, ports).
2. `3) Enable node stratum` → patches `grin-server.toml` (`enable_stratum_server`, `stratum_server_addr = 127.0.0.1:3334`). **Set `wallet_listener_url` to the hub's pool wallet** — see §2 operator note; this is the #1 multi-region mistake.
3. Restart the Grin node (for the toml change), then `4) Service control` → start the satellite.
4. `5) Status` → confirm `:3333` listening, region/hub set, **backlog shares=0 blocks=0** (a growing backlog = the satellite can't reach the hub → check secret/allowlist/URL/TLS).

**Miner:** point lolMiner/GMiner/IPOLLO at `stratum+tcp://<satellite-ip>:3333`, username `<grin_address>.<worker>`.

### 8.3 Scenario matrix

**Layer 1 — bash / deploy (both libs)**
- Services exist & enabled: `grin-pool-manager[-testnet]` (hub), `grin-satellite` (sat).
- Configs written 0600: `/opt/grin/conf/grin_pubpool.json`, `/opt/grin/conf/grin_satellite.json`.
- `jwt_secret` present in `grin_pubpool.json` and **stable across a restart** (not regenerated at boot).
- Ports listening per §11; node built-in stratum is **localhost-only** (`127.0.0.1:3334`, not `0.0.0.0`).
- `bash -n` clean on all `07_*`; `node --check` clean on backend JS; `nginx -t` OK.

**Layer 2 — backend / money (single-box first)**
- Ingestion authn: POST `/api/shares` with the **wrong** secret → `401`; correct secret → `{accepted,skipped}`.
- Idempotency: replay the same `share_hash` / block `hash` → counted as `skipped` / `duplicate:true`, no double row.
- Share → PPLNS: submitted shares land in `shares`; a found block matures past `confirm_depth` (100 testnet) → `rewards` distributes; `balance_log` gets append-only rows; no share paid twice.
- Orphan path: mark a confirmed block's nonce absent from chain → reversal reverses the **exact** `balance_log` amounts (incl. fee), balance never < 0.
- Withdrawal: CAS balance lock (insufficient balance → `409`); max 1 pending per address (`429`); idempotent send (`txid`).
- Auth (the runtime-verify list, §2): login → refresh → **old refresh replay rejected**; 5-fail **lockout** then unlock; every admin mutation writes an `admin_audit_log` row.

**Layer 3 — multi-region federation (hub + satellite)**
- Satellite relay delivers: submit a share on the satellite → appears in the **hub** `shares` table within `relay_batch_interval_ms` (default 2 s), tagged with the satellite's `region`.
- Region surfaces light up: `GET /api/pool/stats/regions` shows that region's GPS/miners/shares; `GET /api/admin/health/satellites` shows it `online`; a row added via `POST /api/admin/locations` gives it a label on `/api/pool/locations`.
- Block relay is immediate: a found block POSTs to hub `/api/blocks` and credits via the hub `BlockManager`.
- Hub-outage drill: stop the hub → satellite buffers to `relay_failover.sqlite` (`5) Status` backlog climbs) → restart hub → backlog drains to 0, no shares lost, no duplicates on the hub (UNIQUE).
- Allowlist: remove the satellite IP from the registry → ingestion returns `403`; satellite goes `stale`→`offline` on `/api/admin/health/satellites`.

**Layer 4 — frontend / public**
- Public pages render live: home stats, `/blocks`, `/payments` (aggregated), `/miners` (truncated addrs), an account page for a real address.
- Admin: login over HTTPS sets httpOnly cookies; dashboard/withdrawals/settings load; testnet currency label shows `tGRIN`.
- XSS: a worker name / address with HTML metacharacters renders escaped (it's regex-gated at stratum, but confirm `escHtml` on the sinks).

**Failure drills (must all degrade safely):** hub down (above) · bad/blank ingestion secret (401, ingestion inert) · node stratum down (`Miners connect but get no work` — §7) · DB `PRAGMA integrity_check` not `ok` · `systemctl stop` flushes WAL cleanly (no `-wal`/`-shm` growth after stop).

### 8.4 Endpoint reality check — verified against `back-end-pool/index.js` (2026-06-08)

Most of the design §6 catalog is now wired (build of 2026-06-08). The table below records the
**current** state; the smoke tests in §8.5 hit only routes that exist.

| Endpoint | State (2026-06-08) | Notes for testing |
|---|---|---|
| `GET /api/health` | ✅ **now an alias** of `/health` | either path works |
| `GET /api/pool/stats/regions` | ✅ **implemented** | per-region GPS/miners/shares over a 15-min window, joined onto `pool_locations`; multi-region federation is now observable via API, not just the DB |
| `GET /api/pool/locations` | ✅ **implemented** | public list of active regions (region/label/stratum_url) |
| `GET/POST/DELETE /api/admin/locations` | ✅ **implemented** | CRUD on `pool_locations` (upsert by `region`); audit-logged |
| `POST /api/account/:addr/withdraw` | ✅ **implemented** (Tor only) | `{ amount?, method? }`; omit `amount` → full balance; CAS lock in `WithdrawalScheduler.createWithdrawal`; 409 insufficient / 429 already-pending / 400 below min; `method!='tor'` → 400 |
| `GET /api/account/:addr` · `/balance/log` · `/tor-check` | ✅ **implemented** | summary (balance/paid/pending/shares/hashrate), append-only ledger, live Tor reachability |
| testnet `POST /api/admin/miners/:addr/inject` | ✅ **implemented** (testnet-only, 403 on mainnet) | the "skip the 100-block wait" shortcut now exists; `{ amount }` credits balance + writes `balance_log` + audit row. `GET /api/admin/miners[/:addr]` also added |
| `GET/POST /api/claim/:id` (slatepack) | ❌ **still absent** | slatepack claim rail not built (design §8/§12); Tor is the only payout transport |
| `GET/PUT /api/admin/users[/:id]`, `PUT /api/admin/miners/:addr`, withdrawal retry/cancel/events | ❌ **still absent** | legacy `admin-panel/users.html` references some; not required by the primary admin dashboard |
| `GET /api/admin/health/system` · `/health/satellites` | ✅ **implemented** | real host CPU/mem/disk/uptime (resolves D1 fake-metrics); per-region relay liveness (online/stale/offline) |

Schema additions backing the above (`db.js`): `shares.region` column (additive `migrateShares()`),
new `pool_locations` table. Region tagging flows local stratum → `config.region`, ingested → the
satellite's batch `region`.

### 8.5 Copy-paste smoke tests

Run on the box. Set the vars once. `$NET=mainnet` or `testnet`; ports per §11.

```bash
# ── vars ──────────────────────────────────────────────────────────────────────
HUB=127.0.0.1:8080                 # Central API (local to the hub box)
SECRET=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/opt/grin/conf/grin_pubpool.json','utf8')).hub_shared_secret||'')")
ADDR=tgrin1exampleaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ADMIN_USER=admin; ADMIN_PASS='your-admin-password'

# ── ports listening (hub: 8080; singlebox/sat also 3333; node upstream localhost) ─
ss -tlnp | grep -E ':(3333|3334|13334|8080|443)\b'

# ── 1) health + public reads (no auth) ─────────────────────────────────────────
curl -s http://$HUB/health                  # /health and /api/health both work now
curl -s http://$HUB/api/health
curl -s http://$HUB/api/config/pool-info
curl -s http://$HUB/api/pool/stats
curl -s http://$HUB/api/pool/stats/regions   # per-region GPS/miners/shares (multi-region)
curl -s http://$HUB/api/pool/locations       # operator-declared active regions
curl -s http://$HUB/api/stratum/stats
curl -s http://$HUB/api/stratum/hashrate
curl -s http://$HUB/api/pool/blocks
curl -s http://$HUB/api/pool/miners
curl -s http://$HUB/api/pool/payments
curl -s http://$HUB/api/miners/top
curl -s http://$HUB/api/public/branding
curl -s http://$HUB/api/account/$ADDR        # summary (404 until the addr has shares)
curl -s http://$HUB/api/account/$ADDR/balance
curl -s http://$HUB/api/account/$ADDR/balance/log
curl -s http://$HUB/api/account/$ADDR/shares
curl -s http://$HUB/api/account/$ADDR/tor-check

# ── 2) ingestion auth (satellite → hub) ─────────────────────────────────────────
# wrong secret → 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://$HUB/api/shares \
  -H 'Content-Type: application/json' -H 'x-pool-secret: WRONG' \
  -d '{"region":"test","shares":[]}'
# correct secret, one synthetic share → {accepted/skipped}
curl -s -X POST http://$HUB/api/shares \
  -H 'Content-Type: application/json' -H "x-pool-secret: $SECRET" \
  -d "{\"region\":\"test\",\"shares\":[{\"grin_address\":\"$ADDR\",\"worker_name\":\"rig1\",\"difficulty\":1,\"height\":1,\"share_hash\":\"smoke-$(date +%s)\"}]}"
# replay the SAME share_hash → skipped (idempotent UNIQUE), not double-counted
# (re-run the line above; expect accepted:0 skipped:1)
# synthetic block-found
curl -s -X POST http://$HUB/api/blocks \
  -H 'Content-Type: application/json' -H "x-pool-secret: $SECRET" \
  -d "{\"region\":\"test\",\"block\":{\"height\":1,\"hash\":\"smoke-blk-$(date +%s)\",\"nonce\":0,\"found_by\":\"$ADDR\"}}"

# ── 3) admin auth (httpOnly cookies) ────────────────────────────────────────────
curl -s -c /tmp/pool-cookies.txt -X POST http://$HUB/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}"
C='-b /tmp/pool-cookies.txt'
curl -s $C http://$HUB/api/admin/dashboard
curl -s $C http://$HUB/api/admin/audit-log            # expect a login_success row
curl -s $C http://$HUB/api/admin/health/system        # real CPU/mem/disk/uptime
curl -s $C http://$HUB/api/admin/health/satellites     # per-region relay liveness
curl -s $C http://$HUB/api/admin/miners
curl -s $C "http://$HUB/api/admin/miners/$ADDR"
# region registry CRUD (upsert → list → the public surface reflects it)
curl -s $C -X POST http://$HUB/api/admin/locations -H 'Content-Type: application/json' \
  -d '{"region":"us-east","label":"US East","stratum_url":"stratum+tcp://us.example:3333","is_active":true}'
curl -s $C http://$HUB/api/admin/locations

# ── 3b) testnet-only: inject balance + drive a withdrawal end-to-end ─────────────
# inject is hard-guarded to testnet (403 on mainnet) — skips the confirm_depth wait.
curl -s $C -X POST "http://$HUB/api/admin/miners/$ADDR/inject" \
  -H 'Content-Type: application/json' -d '{"amount":25}'
# now the address has balance → trigger a Tor withdrawal (no auth; address is identity)
curl -s -X POST "http://$HUB/api/account/$ADDR/withdraw" \
  -H 'Content-Type: application/json' -d '{"amount":10,"method":"tor"}'
# CAS guards: a second concurrent request → 429 (already pending); over-balance → 409
curl -s $C http://$HUB/api/admin/withdrawals       # the new withdrawal should appear

# ── 4) DB-layer checks (cross-check the federation aggregates) ───────────────────
DB=/opt/grin/pubpool/$NET/pool.sqlite
sqlite3 "$DB" 'PRAGMA integrity_check;'
sqlite3 "$DB" "SELECT region,COUNT(*) FROM shares GROUP BY region;"   # matches /api/pool/stats/regions
sqlite3 "$DB" 'SELECT grin_address,balance,balance_locked FROM miner_accounts LIMIT 5;'
sqlite3 "$DB" 'SELECT height,status,found_by FROM blocks ORDER BY height DESC LIMIT 5;'
sqlite3 "$DB" "SELECT event_type,reference_type,amount FROM balance_log ORDER BY id DESC LIMIT 5;"

# ── 5) satellite side (on the satellite box) ────────────────────────────────────
systemctl is-active grin-satellite
journalctl -u grin-satellite -n 30 --no-pager
FDB=/opt/grin/satellite/relay_failover.sqlite
[ -f "$FDB" ] && sqlite3 "$FDB" 'SELECT COUNT(*) FROM relay_shares; SELECT COUNT(*) FROM relay_blocks;'  # both 0 = caught up

# ── logs ─────────────────────────────────────────────────────────────────────
journalctl -u grin-pool-manager${NET:+-$NET} -n 50 --no-pager
```

> Auto-payout/withdrawal can't be smoke-tested by a single curl (it's scheduler-driven and needs a
> matured block + a Tor listener). Validate it during the 7-day soak: confirm a real block, wait
> `confirm_depth`, watch the 6h auto-payout produce a `withdrawals` row and a `txid`, then verify the
> reversal/CAS branches per Layer 2.
