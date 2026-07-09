# Script 07 — Public Mining Pool (Implementation)

> ⚠ **Multi-region (satellite/relay) sections are SUPERSEDED by Model C (2026-06).** Any
> satellite install/relay/ingestion steps here are obsolete: regions are now thin stratum
> gateways (HAProxy + WireGuard). Authoritative:
> the Model C appendix at the end of this file
> + the Model C section of `.claude/CLAUDE.md`. Single-box deploy/runbook below is current.

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
| Grin Transporter payout rail | ❌ | `lib/wallet-transporter.js` is a forced-off stub ([091 Transporter](script09_design.md)) |

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
| D4 | **Grin Transporter payout rail** | `lib/wallet-transporter.js` is a forced-off stub; blocked on Script 091 (not built). | Keep stub off until [091 Transporter](script09_design.md) ships. |
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

---

## Appendix — Model C refactor plan (multi-region thin gateways), merged from flowcharts/script07_mining_public_planning.txt 2026-07-09

```text
╔══════════════════════════════════════════════════════════════════════════════╗
║   07_grin_mining_public_pool.sh — REFACTOR PLAN: Model C (thin gateways)    ║
╚══════════════════════════════════════════════════════════════════════════════╝

  Version:  planning v1  (refactor proposal) + live-test results (§8)
  Date:     2026-06-21  (implemented 2026-06-22, LIVE-VERIFIED 2026-07-05)
  Author:   design review session (see §1 for how we got here)
  Status:   IMPLEMENTED (Phases 1–8, branch `publicpool`, 2026-06-22). The satellite/relay
            role is fully removed and replaced by the gateway role + central WireGuard +
            per-region PROXY-v2 listeners.
            ✔ LIVE-VERIFIED 2026-07-05 (testnet, see §8): a real regional gateway
            forwarded miner hashrate over WireGuard to the central pool and the pool
            FOUND BLOCKS from those shares; the coinbase arrived in the central
            wallet's combined Owner+Foreign listener. Q2 is answered: latency was
            never the stale cause — two share-forwarding protocol bugs were (§8).

  Scope:    Re-architect the multi-region role of the public pool from
            "full grin node + share relay per region" (the CURRENT built design)
            to "thin stratum gateway per region + one central node + wallet"
            (Model C). Central single-box pool stays ~unchanged; the SATELLITE
            role is replaced by a GATEWAY role.

  ⚠ HONESTY MARKER: Model C is the DOCUMENTED best-practice pattern for
    multi-region pools in GENERAL (Bitcoin-scale pools), but NO open-source Grin
    pool publishes this exact topology. grin-pool is single-region; grinmint /
    2miners / always.vip / easygrin internals are unobservable from outside (DNS
    only shows regional hostnames + one consolidated wallet — see §2). So this
    plan ADAPTS a proven generic pattern to Grin's integrated stratum; it is not
    copied from a Grin reference. Treat latency/behaviour items as "measure on a
    real link", not "known good".


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  1. HOW WE GOT HERE  (summary of the review)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  We set out to pre-flight the SATELLITE install → admin registration →
  connectivity flow of the CURRENT design before live-testing. The review
  surfaced three issues, and the third forced an architecture rethink:

  (a) Single-box menu cannot set hub_shared_secret. Ingestion (/api/shares) is
      hard-gated by that secret; the recommended "1) Pool server" install has no
      menu door to set it → every satellite POST returns 401. (Workaround today:
      relaunch as `hub` arg, or hand-edit grin_pubpool.json.)

  (b) Region name is a free-text string match. The satellite's config `region`
      MUST be byte-identical to the admin → Regions key, or the declared card
      stays "No signal" while live data lands under an orphan region. Nothing
      validates the link.

  (c) COINBASE ROUTING for satellite-found blocks was NEVER fully designed.
      The design doc lists the wallet as localhost-only and satellites as
      "no wallet" — which silently assumes one box. A satellite's grin node
      builds block templates whose coinbase is created by whatever wallet answers
      `wallet_listener_url` (Foreign API 3415). A satellite has no wallet, so the
      reward has nowhere correct to go.

  Coinbase options we weighed for the CURRENT (node-per-region) design:
    • Option A — satellite node → HUB wallet :3415 over a private overlay
                 (WireGuard/Tor). Keeps one wallet, but puts the wallet on the
                 mining CRITICAL PATH (build_coinbase is called per new template);
                 a WAN blip stalls that region's mining. "WireGuard" was the
                 reviewer's inference, not a documented Grin practice.
    • Option B — satellite runs a thin local coinbase wallet, sweeps matured
                 reward to the hub. No WAN coupling, but a seed + funds on every
                 edge box, plus sweep + reconciliation plumbing.
    • Option C — DON'T run a node/wallet at the edge at all. The edge is a thin
                 stratum gateway forwarding to ONE central node + wallet.

  KEY INSIGHT (why Grin is special):
    BTC / Doge / Zcash use getblocktemplate; Monero uses get_block_template
    (wallet_address, reserve_size). In ALL of them the coinbase destination is
    just an ADDRESS STRING handed to the node — the wallet is OFF the mining path.
    That is why "regional node, same payout address everywhere" is trivial for
    them. Grin has NO such call: its MimbleWimble coinbase outputs must be built
    by a LIVE wallet holding the keychain (build_coinbase). Grin is the outlier;
    we cannot copy the easy cross-coin pattern directly.
      Refs: developer.bitcoin.org/reference/rpc/getblocktemplate.html
            web.getmonero.org/resources/developer-guides/daemon-rpc.html

  DECISION DIRECTION: lean Model C. It is the only option where the wallet is
  NEVER on the network and coinbase reverts to a plain localhost call — the same
  way today's single-box pool already works. The documented multi-region pattern
  ("thin edge gateways; wallets/keys/nodes kept central") matches C exactly:
      bitcoinminingpoolsoftware.com/multi-region-stratum-gateways-ddos-architecture.html


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  2. WHAT THE REAL POOLS LOOK LIKE  (external evidence only)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  DNS probe (2026-06-21) of advertised regional endpoints:

    2miners      EU   grin.2miners.com       162.19.139.184   distinct
                 US   us-grin.2miners.com    178.156.166.242  distinct
                 Asia asia-grin.2miners.com  5.223.68.90      distinct   (3 real)

    always.vip   Asia grin.always.vip        8.210.198.156    distinct
                 US   grin.us.always.vip      47.76.42.65      distinct
                 EU   grin.eu.always.vip      47.76.42.65      ← SAME as US (alias)

    easygrin     Asia asia.pool.easygrin.org 34.92.61.52      distinct
                 US   us.pool.easygrin.org   45.79.250.16     distinct
                 EU   europe.pool.easygrin.org 45.79.250.16   ← SAME as US (alias)

  Findings:
    • All three use the SAME external pattern: per-region subdomains, same port,
      one consolidated pool/wallet.
    • Only 2miners runs 3 genuinely distinct regional boxes. always.vip and
      easygrin advertise 3 regions but run only TWO real boxes — "EU" is a CNAME
      to the US box. ⇒ Even established pools don't bother with a real node in
      every advertised region. START SMALL (Asia is the one that always matters).
    • Gateway-vs-node is UNOBSERVABLE from outside. We cannot prove any of them
      use Model C. The only EXPLICIT documentation of the thin-gateway model is
      the generic (non-Grin) article above.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  3. TARGET ARCHITECTURE  (Model C)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

        REGIONS  ── thin edge: NO node, NO wallet, NO keys, NO DB ──

   Miners (Asia)            Miners (US)             Miners (EU)
      │ stratum+tcp :3333        │ :3333                  │ :3333
      ▼                          ▼                        ▼
 ┌──────────────┐         ┌──────────────┐        ┌──────────────┐
 │ Asia Gateway │         │  US Gateway  │        │  EU Gateway  │
 │  TCP/stratum │         │  forwarder   │        │  forwarder   │
 │  forwarder   │         │              │        │              │
 │ (HAProxy /   │         │              │        │              │
 │  nginx strm) │         │              │        │              │
 └──────┬───────┘         └──────┬───────┘        └──────┬───────┘
        │   secured tunnel (WireGuard) carrying:
        │   stratum bytes  +  PROXY-protocol v2 (real miner IP)
        └───────────────┬────────┴───────────────────────┘
                        ▼
 ╔══════════════ CENTRAL BACKEND  (= today's single-box pool) ═══════════╗
 ║   ┌─────────────────────┐   accept-proxy → real miner IP             ║
 ║   │ Pool Stratum-Server │◄── region = which gateway (wg-IP / port)   ║
 ║   │   (Node app :3333)  │   identity=addr.worker, vardiff, shares,   ║
 ║   │   + accounting + DB │   PPLNS, admin, payouts                    ║
 ║   └─────────┬───────────┘                                            ║
 ║             │ stratum CLIENT  (localhost)                            ║
 ║             ▼ 127.0.0.1:3334                                         ║
 ║   ┌─────────────────────┐  builds block template + coinbase         ║
 ║   │   Grin Node :3334   │                                           ║
 ║   └─────────┬───────────┘                                            ║
 ║             │ build_coinbase (localhost, automatic) → POOL wallet    ║
 ║             ▼ wallet_listener_url = http://127.0.0.1:3420            ║
 ║             │ (BASE url — the node appends /v2/foreign itself;       ║
 ║             │  a pathed url doubles it → 404)                        ║
 ║   ┌─────────────────────┐  owns ALL coinbase — never on the network  ║
 ║   │  Grin Wallet :3420  │──► Tor payouts ──► miners                  ║
 ║   │ ONE combined lstnr: │  owner_api + include_foreign = true        ║
 ║   │ Owner+Foreign, ECDH │  (:3415 retired; testnet = 13420)          ║
 ║   │ auto-unlock         │                                            ║
 ║   └─────────────────────┘                                            ║
 ╚═══════════════════════════════════════════════════════════════════════╝

  WHY "ECDH auto-unlock" + password stored on disk (.wallet_pass, 600 root)
    `owner_api` mode boots LOCKED (no -p flag exists for it) — listener up,
    seed still encrypted, and Owner API v3 only accepts encrypted calls, so
    the ONLY unlock path is init_secure_api (ECDH) → open_wallet(password).
    That unlock MUST be automatic, because in Grin RECEIVING IS A SIGNING OP:
    the node calls build_coinbase for EVERY block template (~15s), which needs
    the decrypted keychain. Locked wallet ≠ "miss a reward" — it means NO jobs,
    the whole pool halts (symptom: miners Alive, GetWorks=0). After any app
    crash / server reboot the decrypted seed is gone from RAM, so boot script
    + */5 watchdog re-run the ECDH unlock unattended — which requires the
    password on the box. No way around it: grin has no BTC-style cold receive
    address, and grin-wallet has no scoped tokens (unlocked-for-coinbase =
    capable-of-send, so deferring payouts is policy, not privilege reduction).
    Not our invention: we checked grin-pool (MWGrinPool) and open-grin-pool —
    both keep the wallet password in service config the same way (and solo's
    `listen -p` even exposes it in `ps`, weaker than a 600 file).
    Mitigations = wallet on hub ONLY, low hot balance, sweep to cold. Full
    operator-facing writeup: docs/generated/script07_security_audit.md
    § "Residual / accepted risks".

  REGION ATTRIBUTION (how the central box knows which region a share is from)
    Chosen method: ONE central stratum listener PORT per region (e.g. asia→:3391,
    us→:3392, eu→:3393), each statically mapped region=<name>. Each gateway's
    tunnel targets its region's port. Miner's REAL IP recovered from the PROXY-v2
    header. This avoids PROXY-v2 TLV parsing and avoids the old "region string
    must match" footgun — region is bound by which port/tunnel the gateway uses.
    (Alt: map WireGuard peer IP → region. Either works; pick one in §6.)

  WHAT CHANGES vs CURRENT BUILD
    • Edge SHRINKS: no grin node, no wallet, no stratum-server, no relay, no DB.
      Just a forwarder + WireGuard.
    • Central box is ~UNCHANGED (it is the existing single-box pool) — it only
      gains: accept-proxy parsing + per-region listener ports + WireGuard server.
    • Coinbase problem DELETED (node+wallet co-located → localhost build_coinbase).

  TRADEOFF (the honest cost): every miner SHARE now round-trips edge→central over
  the tunnel for PoW validation. Expected fine for Grin's very low share rate
  (Cuckatoo32), but MUST be measured (stale% on a real cross-continent link)
  before committing to many regions.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  4. WHAT IS REMOVED / KEPT / ADDED  (file-level inventory)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  REMOVED (satellite role no longer exists):
    web/07_mining_pool_public/back-end-pool/satellite.js          (entrypoint)
    web/07_mining_pool_public/back-end-pool/lib/share-relay.js    (relay agent)
    — node-stratum-client.js / stratum-server.js NOT run on the edge anymore
      (they remain in the repo; central still uses them).
    Edge no longer enables the grin node built-in stratum (no edge node).
    Satellite staging/failover SQLite (relay_failover.sqlite) — gone.
    Ingestion auth model: hub_shared_secret for /api/shares — RETIRED (see §5).

  KEPT (central, ~unchanged):
    index.js (central API), db.js, miners.js, blocks.js, wallet.js, all admin
    panel logic, pool-settings.js, retention.js, the whole public_html/ site.
    pool_locations table + admin Regions CRUD (now describes GATEWAYS, see §5d).

  ADDED:
    NEW edge component: a thin stratum gateway (no Node app required — HAProxy or
      nginx stream is enough; a tiny Node passthrough is the fallback).
    NEW lib in central stratum-server.js: PROXY-protocol v2 header parser
      (pure JS, no native dep — consistent with the no-native-modules rule).
    NEW per-region listener config on the central stratum-server.
    NEW WireGuard setup (server on central, peer on each gateway).
    NEW config file: grin_gateway.json (replaces grin_satellite.json).
    NEW bash: scripts/lib/07_lib_gateway.sh (replaces 07_lib_satellite.sh).


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  5. STEP-BY-STEP REFACTOR  (do in this order; each phase is testable)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ── PHASE 0 — Decisions to lock before coding ────────────────────────────
    0.1  Tunnel transport: ★ LOCKED = WireGuard ONLY (2026-06-22). Tor/TLS
         rejected — latency budget is tight (see Q2/Q4); Tor's extra hops are
         unacceptable for the share path.
    0.2  Gateway implementation: HAProxy (send-proxy-v2 native) vs nginx
         stream (proxy_protocol on) vs small Node passthrough.
    0.3  Region attribution: per-region central PORT (recommended) vs
         WireGuard-peer-IP → region map.
    0.4  Keep /api/shares + /api/blocks ingestion endpoints as DEPRECATED no-ops
         for one release, or delete outright? (back-compat vs cleanliness)

  ── PHASE 1 — Central stratum: accept proxied connections ────────────────
    FILE: back-end-pool/lib/stratum-server.js
    1.1  Add a PROXY-protocol v2 parser: on new TCP connection, if the first
         bytes are the PROXY v2 signature, consume the header and set
         session.ip = <real miner IP from header>; else treat as a direct
         connection (keep single-box behaviour). Pure JS, no native module.
    1.2  Support binding MULTIPLE listeners, one per region, each carrying a
         static region label → stamp it on every share (replaces the relayed
         `region` field). Direct local miners keep config.region (default).
    1.3  Confirm minerManager.recordSourceIp() now receives the REAL miner IP
         (from 1.1) so the ownership gate + abuse bans still work.
    TEST: locally, hand-craft a PROXY v2 header in front of a stratum login →
          verify the recorded share row has correct region + miner IP.

  ── PHASE 2 — New gateway role (bash) ────────────────────────────────────
    FILE: scripts/lib/07_lib_gateway.sh   (NEW — replaces 07_lib_satellite.sh)
    2.1  gw_install: install the forwarder package (haproxy OR nginx stream
         module) + wireguard-tools. NO Node app, NO grin node, NO npm.
    2.2  gw_configure: prompt region name, central endpoint (wg IP:port for this
         region), public stratum port (3333), WireGuard keys (generate edge
         keypair, print public key for the operator to add on the hub).
    2.3  gw_render_forwarder: write the HAProxy/nginx-stream config —
         listen :3333 → backend = central region port over wg0, with
         send-proxy-v2 (preserve miner IP). systemd unit grin-gateway.
    2.4  gw_wireguard_up: write /etc/wireguard/wg-grinpool.conf (edge peer),
         bring it up, enable.
    2.5  gw_status / gw_service_control / gw_menu / pool_gateway_loop —
         mirror the old sat_* menu shape (Install / Configure / Tunnel /
         Service / Status), guarded with `|| true` per the menu-loop rule.
    REMOVE: scripts/lib/07_lib_satellite.sh and all sat_* references.
    NOTE: keep bash -n clean; lib files have no shebang (sourced).

  ── PHASE 3 — Central: WireGuard server + per-region ports ───────────────
    FILE: scripts/07_grin_mining_public_pool.sh
    3.1  pool_setup_wireguard (NEW): install wireguard, generate the hub
         server key, write wg-grinpool.conf server side, open the wg UDP port
         in ufw/firewall. A menu action to ADD A GATEWAY PEER (paste the edge
         public key + assign it a wg IP + region → append [Peer], wg syncconf).
    3.2  Map each region → a central stratum listener port (config in
         grin_pubpool.json, e.g. "region_ports": {"asia":3391,...}). The Node
         stratum-server (Phase 1.2) reads this.
    3.3  Firewall: the per-region central stratum ports bind the wg interface
         ONLY (never public). Public :3333 stays for any direct/local miners.
    3.4  pool_select_mode wording: replace "Satellite agent" with
         "Regional gateway"; update help text. `satellite` launch-arg → `gateway`.

  ── PHASE 4 — Retire the relay ingestion path ────────────────────────────
    FILE: back-end-pool/index.js
    4.1  Per decision 0.4: either delete /api/shares + /api/blocks +
         requireSatellite + recordSatelliteHeartbeat + satelliteHeartbeats, OR
         leave them as deprecated 410-Gone stubs for one release.
    4.2  /api/admin/health/satellites → /api/admin/health/gateways: report
         per-region liveness from a NEW signal (WireGuard peer last-handshake
         and/or recent shares per region), NOT the old relay heartbeat.
    4.3  /api/pool/stats/regions: hashrate/miners per region STILL works (shares
         carry region from Phase 1.2). Replace the satellite-heartbeat liveness
         derivation with the gateway-health signal from 4.2.
    FILE: back-end-pool/lib/share-relay.js → DELETE.
    FILE: back-end-pool/satellite.js → DELETE.
    FILE: back-end-pool/lib/config.js → drop satellite-only keys
          (hub_url, hub_shared_secret, relay_*); add nothing edge-side
          (edge no longer runs Node).

  ── PHASE 5 — Hub lib: repurpose the multi-region menu ───────────────────
    FILE: scripts/lib/07_lib_hub.sh
    5.1  Replace "A) Ingestion auth (shared secret)" with WireGuard peer mgmt
         (calls pool_setup_wireguard add-peer from Phase 3.1).
    5.2  Replace "R) Satellite registry (IP allowlist)" — IP allowlist is moot
         (only wg peers can reach the region ports). Repurpose R) to LIST peers
         + their region + last-handshake.
    5.3  Same A)/R) surfaced in the single-box menu (show_menu /
         pool_singlebox_loop) so a single-box operator can grow to multi-region
         without relaunching as `hub` — this also closes review issue (a).

  ── PHASE 6 — Admin panel (html/js) ──────────────────────────────────────
    FILE: back-end-pool/admin-panel/regions.html
    6.1  Reframe a "region" row as a GATEWAY: fields = region key, label,
         country/flag, PUBLIC stratum host:port (for the public connect card),
         + read-only live status (wg handshake age / shares). Remove anything
         implying the edge has its own node/wallet/secret.
    6.2  Form helper text: region key is bound to the gateway's central PORT/peer
         (set during gateway setup), so the old "must match satellite config
         string" warning is GONE — note that instead. (Fixes review issue (b).)
    FILE: back-end-pool/admin-panel/health.html
    6.3  Wherever it referenced satellites, point to Regions + the new
         /api/admin/health/gateways shape.
    FILE: back-end-pool/admin-panel/admin-shell.js
    6.4  NAV: "Regions" entry stays (Dashboard group). No structural nav change.

  ── PHASE 7 — Public frontend (html/js) ──────────────────────────────────
    FILE: public_html/index.html  (#connect regional cards)
    7.1  Region cards already read GET /api/pool/stats/regions — keep, but the
         status pill now reflects gateway health (Phase 4.2). The ≥2-regions
         gate + nearest-region (timezone) logic is UNCHANGED.
    FILE: public_html/js/public-shell.js
    7.2  Footer stratum copy + any "satellite" wording → "regional gateway".
    FILE: public_html/js/charts-init.js / branding.js — no change expected
         (they don't touch the relay).
    7.3  api-docs.html / endpoints introspection: if /api/shares is deleted,
         it disappears from /api/public/endpoints automatically (route-derived).

  ── PHASE 8 — Cleanup, config, docs ──────────────────────────────────────
    8.1  scripts/07_grin_mining_public_pool.sh pool_cleanup: SAT_* → GW_*
         (grin-gateway unit, /opt/grin/gateway, wg-grinpool.conf, grin_gateway.json).
         Keep the node/wallet/backups "kept" rules.
    8.2  Rename /opt/grin/conf/grin_satellite.json → grin_gateway.json;
         /opt/grin/satellite → /opt/grin/gateway. Update SAT_* constants.
    8.3  nginx: /api/shares + /api/blocks `location =` blocks + the _ingest rate
         zone → remove (or keep stubs) per decision 0.4. (script07-<svc>.conf)
    8.4  Update CLAUDE.md §"Script 07 — Mining Pool Architecture" and
         docs/generated/script07_design.md §3–4 to describe Model C; mark the
         old satellite/relay design as superseded.
    8.5  bash -n on every touched script; full lib syntax sweep.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  6. OPEN QUESTIONS / RISKS  (resolve before / during build)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Q1  PROXY-protocol v2 in the Node stratum-server: confirm a clean pure-JS parse
      (no native module). Verify HAProxy `send-proxy-v2` / nginx `proxy_protocol`
      byte layout against the parser. (Stratum is line-delimited JSON AFTER the
      binary PROXY header — make sure the header is fully consumed first.)
  Q2  ★ RESOLVED (2026-07-05): measured on a real link — the gateway path found
      blocks. The 100%-stale episodes seen during testing were PROTOCOL BUGS
      (job_id translation + u64 nonce rounding, §8), not latency. Rule of thumb:
      100% stale/reject is NEVER latency.
  Q3  ★ RESOLVED (2026-07-05): yes — job pushes survive the extra hop fine once
      the node's own job_id is echoed back on submit (§8a).
  Q4  ★ RESOLVED (2026-06-22): WireGuard ONLY. Tor rejected — cannot accept the
      added latency on the share path. (Cost: the central box must expose a
      WireGuard UDP port; acceptable.)
  Q5  ★ RESOLVED: HAProxy stick-table conn-rate limit implemented in
      gw_render_forwarder (100 conn/10s per source IP, tune for reconnect-happy
      miners).
  Q6  Migration: an operator already running the CURRENT satellite design — do we
      provide a convert path, or is this greenfield only (cleanup + reinstall)?
      (Likely greenfield: the product has no adoption yet — confirm.)

  (Historical note: the "do not code until Q2 is measured" gate below was honored —
   one gateway was deployed and measured 2026-07-05; Q2 passed, no pivot needed.)


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  7. EFFORT SHAPE  (rough, for sequencing — not estimates)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Biggest new work : Phase 1 (PROXY parser + per-region listeners) and
                     Phase 2 (gateway bash + WireGuard).
  Mostly deletion  : Phase 4 (retire relay), Phase 8 (cleanup/rename).
  Light touch      : Phases 6–7 (admin/public mostly reword + repoint one health
                     source; the region cards already exist).
  Central pool app : LARGELY UNCHANGED — it is the existing single-box pool with
                     a proxy-aware front door. That is the whole appeal of C.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  8. LIVE TEST RESULTS  (testnet, 2026-07-05 — branch `publicpool`)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  VERIFIED WORKING END-TO-END
    ① COINBASE: node stratum → build_coinbase → pool wallet, on the wallet's
       ONE combined listener (owner_api + include_foreign on 3420/13420, ECDH
       auto-unlock from .wallet_pass). The separate :3415 Foreign listener is
       retired. wallet_listener_url MUST be the BASE url — the node itself
       appends /v2/foreign (mine_block.rs); a pathed url doubles the path → 404.
       pw_patch_node_toml writes the base url. Foreign-on-13420 needs NO auth.
    ② HASHRATE FORWARDING: miner → gateway :3333 → HAProxy (send-proxy-v2)
       → WireGuard → central per-region listener (region stamped by port)
       → pool stratum → node built-in stratum (localhost). Blocks were FOUND
       through this full path; real miner IP recovered from PROXY-v2.

  BUGS FOUND DURING THE TEST  (all now fixed in the repo)
    a) 100% STALE: the pool forwarded its OWN jobCounter as job_id to the node.
       The node only accepts ITS OWN job_id (its block-version index, re-issued
       every ~15s). FIX: jobIdMap pool→node id, kept per-job for the whole
       submit window (latest-only is insufficient — a submit can race a fresh
       job push). stratum-server.js + node-stratum-client.js.
    b) PERSISTENT "Invalid PoW" + node-logged nonces ENDING IN ZEROS: JSON.parse
       rounds a u64 nonce past 2^53. FIX: the nonce is re-extracted from the raw
       line and carried as a STRING end-to-end (stratum-protocol.js); the
       node-facing send() re-emits it as a bare number on the wire.
    c) MINER "Dead" BUT PING OK: gateway hub_endpoint pointed at a guessed port
       (13416, the node stratum) instead of the ASSIGNED central region port
       (13391). Diagnose with a raw stratum login via nc over the tunnel. The
       GRINGW1|... pairing string exists to make this impossible to mistype.
    d) HANDSHAKE OK BUT ALL TCP DEAD (WireGuard cryptokey routing drop): a
       duplicate add-peer moved the hub's live AllowedIPs to a fresh tunnel IP
       while the gateway kept its old one (10.66.67.2 vs .4; hot-fixed live via
       `wg set`). FIX in repo: pool_wg_add_peer now refuses to re-add an
       existing pubkey (it re-prints the existing pairing string instead), and
       a region keeps its central port when its gateway box is replaced.
       To genuinely re-pair: remove the peer (R) first, then add.

  RULES OF THUMB (earned the hard way)
    • 100% stale/reject is NEVER latency — suspect the protocol first.
    • "Coinbase arrived" does NOT prove the wallet→node direction works
      (build_coinbase is local); only `grin-wallet info` / a send exercises it.
    • Handshake age (wg show latest-handshakes) proves the tunnel, not routing —
      cryptokey (AllowedIPs) mismatch drops traffic silently after handshake.

  ────────────────────────────────────────────────────────────────────────
  END — planning v1 + §8 live-test results (2026-07-05). Model C is verified;
  next: GUI/UI/UX pass on web + bash (add-ons branch), then mainnet sizing.
  ────────────────────────────────────────────────────────────────────────

```
