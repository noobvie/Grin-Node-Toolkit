# Script 07 — Public Mining Pool (Implementation)

> **Covers code as of:** 2026-09-07 · **Last verified:** 2026-09-07 — §§1–8 and §11 re-derived from
> `scripts/07_grin_mining_public_pool.sh`, `scripts/lib/07_lib_{gateway,gwctl,hub,pool_backup,pool_wallet}.sh`
> and `web/07_mining_pool_public/back-end-pool/`. §§9–10 are as-written add-on notes, not re-verified.
> **Product code last changed:** 2026-09-04 — `scripts/07_grin_mining_*.sh`, `scripts/lib/07_lib_*.sh`, `web/07_mining_pool_public/`

Deployment layout, build/wiring status, database runbook, pre-launch checklist, multi-region
(Model C) as-built, and troubleshooting for the public pool. Design lives in
[`script07_design.md`](script07_design.md); security in
[`script07_security_audit.md`](script07_security_audit.md).

> **Roles:** a box is either the **brain** (`singlebox` — the pool, serving its own miners — or a
> mining-less `hub`) or a **regional gateway** (a thin HAProxy + WireGuard stratum forwarder with
> no node, no wallet, no DB, no Node.js). The old **satellite/relay** role — a full node + share
> relay per region — was deleted from the code on 2026-06-22 (`f2ebade`). Nothing runs it any more;
> it survives only as a *legacy-footprint detector* so `Z) Cleanup` can still remove one (§1).

---

## 1. Deployment layout

**Repo:**
```
scripts/07_grin_mining_hub_services.sh    mining-type selector (solo internet/LAN · pool mainnet/testnet)
scripts/07_grin_mining_public_pool.sh     mode selector → singlebox | hub | gateway | cleanup
scripts/lib/07_lib_hub.sh                 Central Hub menu (brain, reuses the parent's pool_* steps)
scripts/lib/07_lib_gateway.sh             Regional GATEWAY install (haproxy + wireguard only)
scripts/lib/07_lib_gwctl.sh               installs /usr/local/bin/grin-gateway-ctl (sole WG mutation path)
scripts/lib/07_lib_pool_wallet.sh         pw_*: combined Owner+Foreign listener, autostart, watchdog
scripts/lib/07_lib_pool_backup.sh         pbk_*: encrypted backup/restore on the shared gbe_/gbp_ engine
scripts/lib/nginx_shared_helpers.sh       shared nginx rate-limit-zone primitives
web/07_mining_pool_public/
  back-end-pool/        Express backend (index.js, lib/, admin-panel/, public/)
  public_html/          static frontend (nginx serves)
```

**Production (VPS)** — every path is network-keyed; mainnet and testnet never share one:

| | Mainnet | Testnet |
|---|---|---|
| App dir | `/opt/grin/pubpool/mainnet/` | `/opt/grin/pubpool/testnet/` |
| Database | `<app dir>/pool.db` (+ `-wal`/`-shm`) | same |
| Config | `/opt/grin/conf/grin_pubpool.json` | `/opt/grin/conf/grin_pubpool_testnet.json` |
| Wallet dir | `/opt/grin/pubpoolwallet/mainnet/` | `/opt/grin/pubpoolwallet/testnet/` |
| Frontend | `/var/www/grin-pool/` | `/var/www/grin-pool-testnet/` |
| nginx vhost | `/etc/nginx/sites-available/grin-public-pool-mainnet` | `…-testnet` |
| systemd | `grin-pool-manager.service` | `grin-pool-manager-testnet.service` |
| Log | `/opt/grin/logs/grin-pool.log` | `/opt/grin/logs/grin-pool-testnet.log` |

Gateway boxes carry a completely different footprint: `/opt/grin/conf/grin_gateway.json`,
`/opt/grin/gateway/haproxy.cfg`, service `grin-gateway`, tunnel `wg-grinpool`
(`/etc/wireguard/wg-grinpool.conf`), log `/opt/grin/logs/grin-gateway.log`.

> **Legacy paths still recognised:** the pre-2026-06 generic names (`grin_pool.json`, `/opt/grin/pool`,
> `/opt/grin/wallet`, vhost `grin-pool`) and the retired satellite footprint (`grin_satellite.json`,
> `/opt/grin/satellite`, service `grin-satellite`) are detected by `Z) Cleanup` and by the
> mode-collision guard — a legacy satellite still binds :3333, so it blocks a brain or gateway
> install until it is removed. That detector is the ONLY remaining satellite code in the repo.

### systemd unit (per network)
```
[Service]
Type=simple
User=grinpool                       # de-rooted (design §13.9): the backend parses untrusted
WorkingDirectory=/opt/grin/pubpool/<net>          # input on TWO public surfaces (HTTP + raw stratum)
Environment="GRIN_POOL_CONF=<conf>" "NODE_ENV=production" "HOST=127.0.0.1" "PORT=<8080|8090>"
ExecStart=<node> index.js
Restart=on-failure
RestartSec=5
LimitNOFILE=65535
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
RestrictSUIDSGID=yes
ReadWritePaths=-<app dir> -/opt/grin/conf -<wallet dir> -/opt/grin/logs -/etc/wireguard
```
Three traps in that unit, all load-bearing:
- **No `NoNewPrivileges`** — it would break the scoped `sudo grin-gateway-ctl` the admin panel's
  pairing path uses.
- **`/etc/wireguard` in `ReadWritePaths` is not optional.** `ProtectSystem=strict` builds a mount
  namespace that every child inherits *including one that becomes root through setuid sudo*. Without
  the entry, `add-peer`/`remove-peer`/`init-server` fail from the panel while `list`/`status` keep
  working — the page looks healthy right up to the moment you save.
- **`ReadWritePaths` is bound at service start**, so `/etc/wireguard` must exist before the unit
  starts (`pool_ensure_wg_prereqs`); a directory created later is not writable inside the namespace.

The backend handles SIGTERM/SIGINT → stop scheduler → `server.close` → `db.close()` so the SQLite
WAL flushes cleanly on `systemctl stop`. `logrotate` rotates `$POOL_LOG` daily/20 M. The **wallet**
listener has its own `@reboot` autostart + `*/5` watchdog cron (`pw_watchdog_install`, menu `5`);
the pool service itself relies on `Restart=on-failure`, not a cron watchdog.

### nginx
- `/api/*` → `proxy_pass` to the backend (`127.0.0.1:8080`/`8090`); `/*` → static `$POOL_WEB_DIR`.
- `robots.txt`/`sitemap.xml`/`manifest.json` are exact-match `location =` proxies (win over static).
- Rate-limit zones via the shared helper only — **never inline `limit_req_zone`**. Script-specific
  zones use a `script07-` conf prefix (`/etc/nginx/conf.d/script07-<service>.conf`); `/custom/`
  sets `X-Content-Type-Options: nosniff` + a sandbox CSP (see security audit).
- **Three** security-header snippets in `/etc/nginx/snippets/` (`…-headers.conf`,
  `…-page-headers.conf`, `…-admin-headers.conf`) — `/admin/` is static-served, so the vhost *is* the
  panel's CSP, and any block with an `add_header` of its own must re-include one (memory
  `project_pool_nginx_header_snippets`). Cleanup removes them in the same `rm` as the vhost that
  includes them, never before it: an orphaned `include` fails `nginx -t`.
- `nginx -t` before every reload.

### Installer responsibilities
- Node ≥ 24 guard (`node:sqlite`) with NodeSource auto-install (`pool_ensure_node24`); `npm ci` in
  the app dir. **The gateway box deliberately has no Node.js** — `07_lib_gateway.sh` reads/writes
  its JSON with `python3`, and must never shell out to `node`.
- Generate `jwt_secret` **once at install** into the pool config. `validateConfig()` throws at boot
  on a missing/short (<32 char) secret rather than minting one — a fresh secret each restart
  silently logs out every admin and breaks refresh tokens.
- Create/migrate schema via `db.js` (`createSchema()`, additive `ALTER TABLE ADD COLUMN` guards).
- `pool_deroot()` creates the `grinpool` service user, chowns what the app must write, and writes
  the scoped sudoers entry allowing exactly one binary (`grin-gateway-ctl`) as root.
- Write the systemd unit + logrotate + VACUUM/backup cron wrappers; `nginx -t`; certbot for SSL.
- `pool_configure()` prompts: pool name, domain, network, ports, `pool_fee_percent`,
  `pool_fee_address`, `min_withdrawal`, `confirm_depth`, region (default `main`).
- **Gateway install** (`07_lib_gateway.sh`): `haproxy` + `wireguard-tools` + `python3` only — no
  node, no npm, no grin node, no build tools. **Hub install** (`07_lib_hub.sh`) is 91 lines: a bare
  hub is a singlebox with no local stratum, so it reuses the parent's `pool_*` steps and the
  parent's WireGuard menu wholesale.
- Every `.sh` change passes `bash -n` before commit.

---

## 2. Implementation status (verified against `web/07_mining_pool_public/`, 2026-09-07)

✅ done · ⚠ partial · ❌ not built

| Area | Status | Notes |
|---|---|---|
| Ports reconciled `3333/3416/8080` | ✅ | `config.js` (stratum 3333/13333, node upstream 3416/13416, HTTP 8080/8090) — bash + backend in sync. The node upstream is grin's own `stratum_server_addr` default: Script 01 never moves it, so the `3334` an earlier plan named was never implemented. |
| Role split | ✅ | `singlebox` \| `hub` in `config.js`; the app has **no third role**. A gateway runs no Node process at all, so it is not an app role — `07_lib_gateway.sh` deploys HAProxy + WireGuard and nothing else. |
| Stratum proxy | ✅ | `stratum-server.js` (public) + `node-stratum-client.js` (upstream) |
| PROXY-protocol v2 ingress | ✅ | pure-JS parser in `stratum-server.js` (`PROXY_V2_SIG`, 256-byte cap, `absent` → treat as a direct miner). Armed on **region listeners only** — the public `:3333` listener is always raw stratum, so a PROXY header cannot be used there to forge a source IP (audit §J6-3a). |
| Per-region stratum listeners | ✅ | `config.region_ports` `{ "<region>": <port> }`, bound to `region_listen_host` (the WireGuard server IP in prod; loopback by default so a misconfigured box never exposes them). Region is stamped from **which listener the share arrived on**, not from a string the edge sends. |
| Regional gateway deploy | ✅ | `07_lib_gateway.sh` (haproxy `mode tcp` + `send-proxy-v2` + a `stick-table` conn-rate limit, privileges dropped after bind) + `07_lib_gwctl.sh` |
| WireGuard pairing, single mutation path | ✅ | `/usr/local/bin/grin-gateway-ctl` is the ONLY code that edits `/etc/wireguard/wg-grinpool*.conf` **and** `region_ports`, so the peer list and the port map cannot drift. Both callers use it: menu `W` over SSH, and the admin panel via scoped `sudo`. Always emits one JSON object. |
| Multi-region observability | ✅ | `shares.region` column + `pool_locations` table; `GET /api/pool/stats/regions`, `/api/pool/locations`, admin `GET/POST/DELETE /api/admin/locations`, `GET /api/admin/health/gateways` (share recency ∧ wg handshake age → online/stale/offline, plus an active TCP probe of each declared public stratum URL) |
| Public account API | ✅ | `GET /api/account/:addr` (summary), `/balance/log`, `/shares`, `/tor-check`; `POST /api/account/:addr/withdraw` → `WithdrawalScheduler` (CAS lock, 1-pending-per-address **across rails**) |
| Admin miners + testnet inject | ✅ | `GET /api/admin/miners[/:addr]`; `POST /api/admin/miners/:addr/inject` (testnet-only, 403 on mainnet) writes `balance_log` + audit row |
| Local block crediting | ✅ | `stratum-server.js` → `BlockManager.creditBlock`; wired via `index.js setBlockManager`. Gateway shares take the **same** path — they are local shares that arrived on a region listener. |
| PPLNS payout trigger | ✅ | `block-monitor.js distributeConfirmedBlocks` each tick; idempotent `confirmed→paid` in `rewards.js`. Full chain closed: found → credit → mature/verify → confirm → distribute → balance → withdrawal |
| Retention/cleanup | ✅ | `lib/retention.js` scheduled from `index.js`; admin **Settings → Database**; height-floor share prune + age-based hashrate/alert prune |
| Encrypted backup/restore | ✅ | `07_lib_pool_backup.sh` on the shared `gbe_*`/`gbp_*` engine (menu `B`) — DB via the SQLite online-backup API, config, wallet seed, **WireGuard identity**, nginx vhost. Restoring the WG identity means gateways reconnect on their `PersistentKeepalive` with zero re-pairing. |
| White-label / branding / SEO | ✅ | see design §9; `branding.js`, dynamic robots/sitemap/manifest, theme builder |
| Incentives (prize pool/bonus/lottery) | ✅ | `lib/incentives.js`, `lib/lottery.js`; `donate.html`, `fortune-board.html` |
| Asset upload hardening | ✅ | see security audit §A |
| Auth hardening | ✅ | `trust proxy`+`req.ip`; bcrypt 12; account lockout; refresh-token rotation+revocation; `jwt_secret` fail-loud at boot; TOTP step-up (`freshAdmin`) on destructive routes — see security audit §B |
| Service de-rooting | ✅ | runs as `grinpool` under a hardened unit (§1); one scoped sudo target |
| System-health metrics | ✅ | real CPU/mem/disk/uptime via admin `GET /api/admin/health/system`; health page lives in the admin panel |
| Money precision (REAL → nanoGRIN) | ❌ | balances still `REAL` GRIN in `db.js` (`miner_accounts.balance REAL NOT NULL DEFAULT 0.0`) — design follow-up, see D2 |
| Auto-payout scheduler | ❌ | **not built.** `payout.auto_payout` exists as a settings key defaulting to `'false'` and **nothing reads it**. Payouts are miner-initiated (account page → Tor/slatepack/Nostr); the scheduler only retries, expires, refunds and reclaims. Treat the key as inert. |
| Grin Transporter payout rail | 🗑 **removed 2026-08-13** | never had pool-side code; the dead `lib/wallet-transporter.js` stub went 2026-08-06 and the last two artefacts (`incentives.transporter_enabled` + the disabled admin checkbox) went together on 2026-08-13. The pool ships **Tor primary + Slatepack fallback**, with Goblin/Nostr as an off-by-default operator opt-in ([093 Transporter](script09_design.md) remains a standalone product) |

### Remaining operator responsibility (not code)
- **`grin-server.toml` `wallet_listener_url`** — the node's stratum coinbase must point at the pool
  wallet's combined listener, and it must be a **BASE** url (`http://127.0.0.1:3420`): the node
  appends `/v2/foreign` itself, so a pathed url doubles the path → 404. `pw_patch_node_toml` writes
  the base url. Under Model C there is exactly **one** node and **one** wallet, both on the central
  box, so the old cross-region "which wallet gets the coinbase?" decision no longer exists.
- **The wallet password on disk** (`.wallet_pass`, 600). `owner_api` boots LOCKED and Owner API v3
  only accepts ECDH-encrypted calls, so the only unlock path is `init_secure_api` → `open_wallet`.
  That unlock must be automatic, because in Grin *receiving is a signing op*: the node calls
  `build_coinbase` for every block template (~15 s) and needs the decrypted keychain. A locked
  wallet is not "miss a reward" — it is **no jobs at all** (symptom: miners Alive, GetWorks=0).
  grin-pool (MWGrinPool) and open-grin-pool keep the password in service config the same way.
  Mitigations = low hot balance, sweep to cold; full writeup in the security audit's
  *Residual / accepted risks*. *(Operator decision, not a code gap.)*

### Deferred decisions & open items — read before mainnet

These are **intentionally not coded yet**. Each needs a product call, not more implementation guessing.
Listed here so we don't re-litigate or accidentally re-implement.

| # | Item | Status / why deferred | Recommendation |
|---|---|---|---|
| D1 | **System-health fake metrics** | ✅ **Resolved 2026-06-08** — real metrics via admin `GET /api/admin/health/system`; the health page moved into the admin panel (gated, not public). | Done. |
| D2 | **Money precision `REAL` GRIN → integer nanoGRIN** | Touches all payout/reward/withdrawal/balance_log math + display. High blast radius. **Carve-out landed 2026-07-17:** per-payout network fees are now RECORDED (`withdrawals.fee` — slatepack from the slate, Tor from the wallet tx log) and reconciliation coverage is fee-adjusted, so fee accumulation no longer false-trips `coverage_shortfall`. The REAL→nanoGRIN unit change itself stays deferred. | Do as its **own PR + full testnet soak**, never as a side-change. Engine-independent (do it in SQLite, carries to Postgres). |
| D3 | ~~**mTLS satellite→hub**~~ | 🗑 **Moot since 2026-06-22.** There is no satellite→hub HTTP ingestion to protect: the edge↔central link is a WireGuard tunnel carrying raw stratum, authenticated by the tunnel's own keypair. The shared-secret header and IP allowlist retired with the role. | Closed — do not re-open as stated. |
| D4 | **Grin Transporter payout rail** | ✅ **Closed 2026-08-13 — removed, not deferred.** Blocked indefinitely on a gate the pool does not control: no mainstream wallet can receive from a relay. A placeholder that cannot name a date is a promise, so the reserved `incentives.transporter_enabled` key and its disabled checkbox in `settings-incentives.html` were deleted **in the same commit** — the settings harvester sends every `id` in `.settings-form` (disabled inputs included) and `updateSection` throws on an unknown key, so removing either alone would have broken every Incentives save. | Done. If a relay rail is ever revisited, add it as a self-registering file under `public_html/js/` like `payout-goblin.js` — do **not** re-introduce a reserved settings key ahead of working code. A pool that already persisted `transporter_enabled` keeps an inert `pool_config` row; `getSection` merges stored rows over defaults without a membership check, so it is harmless and no migration is needed. |
| D5 | **Theme-system unification** (public `body.<theme>-theme` → `theme.js` CSS variables) | Cosmetic; refactor risk across 13 themes. | Defer; not launch-blocking. |
| D6 | **i18n / multi-language content** | Product scope; content + tooling. | Defer (phase 2). |
| D7 | **Fiat (USD/EUR/BTC) price display** | Feature; could wire to the Script 06 price collector. | Optional — your call on data source. |
| D8 | **Optional free miner accounts** (true one-person-one-entry lottery) | Conflicts with register-free identity model; partial Sybil trade-off documented (design §9). | Defer (phase 2 design decision). |
| D9 | **Admin theme live-preview iframe + WCAG contrast check** | Admin UX nicety. | Defer; not launch-blocking. |
| D10 | **Auto-payout** | Never built; the `payout.auto_payout` settings key is inert (§2). Miner-initiated payout is the shipped model, and the ownership gate (§10) exists precisely because an ungated automatic trigger was an abuse surface. | Leave unbuilt unless the product decision changes; if it is dropped for good, delete the dead settings key the way D4's was. |

### Verification still owed by the operator (not changed in code)
Backend items are syntax-checked + logic-reviewed but **not** runtime-tested locally
(`node_modules` live only on the VPS). On a testnet box, confirm:
- a real **login → refresh → old-refresh-replay-rejected** cycle, and **5-fail lockout** then unlock;
- every **admin mutation writes an `admin_audit_log` row** (not line-audited per handler);
- money flow (**orphan reversal exact amounts, idempotent send, CAS balance lock**) against a live DB.

---

## 3. Scheduler jobs

All in-process (no cron except backup + VACUUM). Cadences read from the code, not from settings
unless noted.

| Job | Where | Cadence | Purpose |
|---|---|---|---|
| Block confirmation + distribution | `block-monitor.js` | 30 s | promote pending blocks past `confirm_depth` → `distributeConfirmedBlocks` |
| Orphan detection | `block-monitor.js` | 6 h | nonce-check confirmed blocks; reverse orphans (exact `balance_log` amounts) |
| Withdrawal scheduler loop | `withdrawal-scheduler.js` | 60 s | reclaim stale `finalizing`/`tor_sending`, retry queue, Tor checks, slatepack expiry/refund, kernel-proof backfill. **Freeze-safe:** while frozen it runs only the paths that resolve or refund, never a send. |
| Withdrawal retry ladder | `withdrawal-scheduler.js` | 6/12/24/48 h | `retry_scheduled` rows past `next_retry_at` |
| Hashrate sampling + hourly rollup | `hashrate-tracker.js` | 60 s / hourly | `hashrate_history`; `rollupCompletedHours()` writes the durable `pool_metrics_hourly` + `pool_region_metrics_hourly` (§9) |
| Retention | `retention.js` | `database.prune_interval_minutes` (default 60; first pass +30 s) | prune raw shares + downsample/age hashrate + prune alerts |
| Alert monitor | `alert-monitor.js` | 60 s (`alert_check_interval_secs`) | health/security alerts |
| Reconciliation + money invariants | `alert-monitor.js` → `reconciliation.js` | 300 s (`alert_money_check_interval_secs`) | coverage/flow/integrity check; can trip the payout freeze |
| Dormancy sweep | `dormancy.js` | 6 h (first pass +60 s) | 24-month abandoned-balance disposition → prize pool |
| Lottery / campaigns | `index.js` | 1 h | reveal committed draws, then run due draws + campaigns |
| Loyalty streaks | `index.js` | 24 h | `incentivesManager.updateStreaks()` |
| Network peer snapshot | `index.js` | 20 min | `snapshotNetworkPeers` |
| Stale stratum sessions | `stratum-server.js` | 60 s | `pruneInactiveSessions` |
| miningpoolstats submit | `poolstats-reporter.js` | `poolstats_interval_mins` (default 10) | only when `poolstats_enabled` — **push** mode; the pull feed (§8.6) needs none of this |

There is **no region-aggregation job**: regional shares are written locally by the central stratum
server as they arrive, so nothing has to be pulled from an edge box.
There is **no auto-payout job** (§2, D10).

---

## 4. Database — engine & backup runbook

**Stay on SQLite (Node's built-in `node:sqlite`) now** (one local writer; see design §4 for the
migration triggers). The safe topology is exactly ours: **one local writer process on local disk** —
SQLite does not corrupt on its own; corruption comes from misuse, all avoidable.

The live file is **`/opt/grin/pubpool/<net>/pool.db`** (plus `-wal`/`-shm`). `lib/db.js` chmods all
three to 0600 on every start.

**Rules that prevent corruption:**
- DB on the box's **local SSD** only. Cloud *block* volumes (EBS, DO Volumes) are fine; **never** a
  network filesystem (NFS/SMB).
- One process owns the file (✓ by design); one Node/`node:sqlite` version.
- **Never** `cp`/`rsync` the live `pool.db` — you can capture a torn write.
- **Never VACUUM a live database.** The shipped `/usr/local/bin/<service>-vacuum` (weekly cron,
  menu `C`) stops the service, compacts, and starts it again whatever happens; VACUUM holds an
  EXCLUSIVE lock for the whole rewrite.

**Backups — what actually ships:** menu `B` (`07_lib_pool_backup.sh`) on the shared toolkit engine —
`/opt/grin/backups/grin_pubpool[testnet]_backup_<DDMMYYYY>.tar.gz.enc`, AES-256-CBC/PBKDF2-600k,
password `<personal_key><DDMMYYYY>`, one archive per net per day, optional offsite push. The DB goes
in via the **SQLite online-backup API** (two-phase tar), never a live WAL copy. The set also carries
the config (incl. `region_ports` + `jwt_secret`), the wallet seed/toml/secrets, the **WireGuard
identity**, and the nginx vhost — everything a fresh install cannot regenerate.
Restore runbook: fresh box → Script 01 node → 07 `1) Install` → restore → `grin-secret-sync` →
re-point DNS → gateways reconnect on their own with **no action on any gateway box**.

**Optional additions (not shipped, operator's call):**
- **Continuous:** [Litestream](https://litestream.io) streams the WAL to S3/B2/another disk →
  point-in-time restore, seconds of RPO.
- **Portable dump (DR/migration):** `sqlite3 pool.db .dump > pool.sql`.
- **Integrity check (nightly cron):** `PRAGMA integrity_check;` → alert if not `ok`.

**Restore (file-level):** `systemctl stop` → replace `pool.db` (or `litestream restore`) →
`systemctl start`.

**Honest limit:** SQLite's real weak spot is **HA/failover** (no built-in hot standby), not
corruption. That is the one legitimate future reason to consider Postgres.

---

## 5. Pre-launch checklist

**Money / consensus**
- [x] `confirm_depth = 1440` mainnet / `100` testnet (= Grin `COINBASE_MATURITY`) — set in code (config.js, pool-settings.js, retention.js, template, admin UI)
- [ ] Found blocks persisted; orphan reversal reverses exact `balance_log` amounts incl. fee, no neg balance
- [ ] PPLNS double-pay guard active (shares marked paid per block in the distribution transaction)
- [ ] Withdrawal balance lock is compare-and-swap; max 1 pending per address **across all rails** (`PENDING_SQL`); wallet send idempotent (`txid`)

**Auth / security** (see [`script07_security_audit.md`](script07_security_audit.md))
- [x] bcrypt ≥ 12; refresh-token revocation; account lockout (`auth.js`/`db.js`) — runtime-verify on testnet
- [x] httpOnly cookie auth (`index.js` login/register). ⚠ still verify the frontend gate `await`s an authenticated endpoint (not `/api/health`)
- [x] `trust proxy` + `req.ip` (no raw `X-Forwarded-For` trust); `jwt_secret` written at install and fail-loud at boot
- [x] Service runs as `grinpool` under the hardened unit; exactly one scoped sudo target
- [x] SVG/upload hardening (§A) + `admin_audit_log` single shape (`migrateAdminAuditLog`). ⚠ still confirm public payments/miners are aggregated/masked

**Infra / ops**
- [ ] Encrypted backup run + **a tested restore** (menu `B`); nightly `integrity_check`
- [ ] Weekly offline VACUUM cron present; graceful SIGTERM verified; HTTPS enforced; secrets only in the pool config
- [x] `bash -n` clean on all `07_*` scripts; `node --check` clean on all backend JS — ⚠ `nginx -t` runs on the VPS
- [ ] 7-day testnet soak before mainnet

---

## 6. Testnet mode

Backend is config-driven; testnet = a different config file + a fully isolated instance
(`/opt/grin/pubpool/testnet/`, config `grin_pubpool_testnet.json`, service
`grin-pool-manager-testnet`, node API `13413`, node stratum upstream `13416`, Central API `8090`,
public stratum `13333`, wallet `13420`, WireGuard iface `wg-grinpool-tn` on udp `51821` with
tunnel net `10.66.67.0/24`, region ports from `13391`). Currency label `tGRIN`; `--testnet` (never `--floonet`); `confirm_depth` defaults to 100;
the admin balance-inject endpoint is testnet-only (guarded). A testnet pool can coexist with a
mainnet pool on one box — it collides only with **solo** mining.

Quick solo/testnet smoke test (IPOLLO): init wallet, patch TOML, start listener + node stratum,
point the miner at `:3333`. (This used to point at an in-repo `grin_mining_testnet_instruction.html`;
that page was deleted on 2026-06-13 in `ea0cc43`. The solo product's own walkthrough is the
"Appendix — Solo private pool flowchart" at the end of [`script07_design.md`](script07_design.md).)

---

## 7. Troubleshooting

| Symptom | Likely cause / check |
|---|---|
| Miners connect but get no work | `NodeStratumClient` needs `pool_address` set, or it can't log in to the node's built-in stratum → no jobs. Verify `config.pool_address` and that the node stratum is up on `127.0.0.1:3416`/`13416`. |
| Miners Alive, **GetWorks = 0**, pool otherwise healthy | The pool wallet is LOCKED. `build_coinbase` needs the decrypted keychain for every template, so a locked wallet halts the whole pool, not just rewards. Re-run the ECDH unlock (`pw_*` autostart/watchdog) — after a crash or reboot the decrypted seed is gone from RAM. |
| Pool hashrate reads ~0 / meaningless | Hashrate must come from summed accepted-share difficulty over the window (`GPS = sumDiff × 42 / window_s / 16384`), not the assigned session target. |
| `/api/pool/stats` disagrees with `/api/stratum/stats` | Two `MinerManager` instances — construct one in `index.js` and inject it into the stratum server. |
| **100 % stale / reject** on a gateway region | **Never latency — suspect the protocol.** Two real causes, both fixed in-repo and both worth re-checking after any stratum change: the pool must echo the **node's own `job_id`** (jobIdMap, kept for the whole submit window), and the u64 **nonce must travel as a string** (`JSON.parse` rounds past 2^53 — the tell is node-logged nonces ending in zeros). |
| Miner shows "Dead" but the tunnel pings | The gateway's `hub_endpoint` points at the wrong port — e.g. the node stratum (13416) instead of the **assigned central region port** (13391). Diagnose with a raw stratum login over the tunnel (`nc`). Pasting the `GRINGW1\|…` pairing string instead of typing values makes this impossible to mistype. |
| WireGuard handshake fine, **all TCP dead** | Cryptokey-routing (AllowedIPs) mismatch — the classic cause was a duplicate add-peer moving the hub's AllowedIPs to a fresh tunnel IP while the gateway kept the old one. `grin-gateway-ctl add-peer` now refuses to re-add an existing pubkey (it re-prints the pairing string) and a region keeps its port when its box is replaced. To genuinely re-pair: **remove the peer first**, then add. Handshake age proves the tunnel, not the routing. |
| Panel pairing 502s / "saves" nothing while Regions still lists fine | The service unit is missing `/etc/wireguard` from `ReadWritePaths` (or the directory did not exist at service start) — reads work, writes cannot escape the mount namespace even as root (§1). |
| Region shows `unknown` on `/api/admin/health/gateways` | Neither signal is available yet: no share in the last 15 min **and** no wg handshake. A brand-new region declared in the panel before its peer exists reads `unknown`, not `offline`. |
| JWTs invalid after restart / boot refuses to start | `jwt_secret` missing or <32 chars in the pool config — the backend fails loud by design. Re-run the installer/configure step. |
| Allowlist / lockout bypassable | Missing `app.set('trust proxy', 1)` → code trusts spoofable `X-Forwarded-For`. Use `req.ip`. |
| Uploaded logo/icon 404s | `assets_dir` mismatch vs the app working dir, or the `/custom/` nginx alias/permissions. A re-run of `1) Install` chmods the app dir 700 — `pool_ensure_served_dirs` re-opens the two dirs nginx must reach. |
| Node "won't start" after a root run | A root-run node leaves `root:root` files → the `grin` user gets EACCES. Always run as `grin` with `HOME=$GRIN_DIR` (see CLAUDE.md launch contract). |

Diagnostics: `journalctl -u grin-pool-manager[-testnet] -f`; `systemctl status`; test node API per the
CLAUDE.md curl snippets; `sqlite3 pool.db 'PRAGMA integrity_check;'`; on a gateway,
`journalctl -u grin-gateway -f` and `wg show wg-grinpool`.

---

## 8. Multi-region (Model C) — as built

Implemented 2026-06-22 (`f2ebade`, Phases 1–8) and **live-verified on testnet 2026-07-05**: a real
regional gateway forwarded miner hashrate over WireGuard to the central pool, the pool FOUND BLOCKS
from those shares, and the coinbase arrived in the central wallet's combined listener.

**Multi-region is optional and most pools never need it.** A single pool box already serves every
miner on `:3333` as region `main`. Add a gateway only when you have miners on another continent and
want to cut their latency to the stratum endpoint.

### 8.1 Architecture

```
  Miners (Asia)          Miners (US)            Miners (EU)
     │ stratum+tcp :3333     │ :3333                 │ :3333
     ▼                       ▼                       ▼
 ┌──────────────┐     ┌──────────────┐       ┌──────────────┐
 │ Asia Gateway │     │  US Gateway  │       │  EU Gateway  │   thin edge:
 │   HAProxy    │     │   HAProxy    │       │   HAProxy    │   NO node, NO wallet,
 │ (mode tcp)   │     │              │       │              │   NO keys, NO DB, NO Node.js
 └──────┬───────┘     └──────┬───────┘       └──────┬───────┘
        │  WireGuard (wg-grinpool / udp 51820; testnet wg-grinpool-tn / 51821) carrying
        │  raw stratum bytes + PROXY-protocol v2 (real miner IP)
        └────────────────┬───┴───────────────────────┘
                         ▼
 ╔═════════════ CENTRAL BOX (= the single-box pool) ══════════════════════╗
 ║  region listeners 10.66.66.1:3391, :3392 …  ← region stamped by PORT   ║
 ║  public listener :3333 (raw stratum, no PROXY accepted)                ║
 ║        │                                                               ║
 ║        ▼ stratum-server.js → accounting → pool.db (single writer)      ║
 ║        │ stratum CLIENT (localhost) → Grin node 127.0.0.1:3416         ║
 ║        │ node build_coinbase (localhost) → wallet_listener_url         ║
 ║        ▼ grin-wallet :3420 — ONE combined listener (owner_api +        ║
 ║          include_foreign), ECDH auto-unlock → Tor/slatepack payouts    ║
 ╚════════════════════════════════════════════════════════════════════════╝
```

**Region attribution** is by **listener port**, not by a string the edge sends: each gateway's tunnel
targets its own central port (`region_ports`), and the central stratum server stamps that listener's
label on every share. This kills the old "region string must match" footgun outright. The miner's
real IP is recovered from the PROXY-v2 header — which is armed on region listeners **only**, so the
public `:3333` can never be fed a forged header.

**Why the edge is this thin:** no node means no per-region chain sync, no per-region wallet, and no
"which wallet gets the coinbase?" question — `build_coinbase` is a localhost call on the one box that
has both. All accounting stays single-writer on the central DB.

**The honest tradeoff:** every share round-trips edge→central over the tunnel for PoW validation.
Measured 2026-07-05 on a real cross-continent link: fine at Grin's C32 share rate. The 100 %-stale
episodes seen during that test were **protocol bugs, not latency** (§7).

**Not copied from a Grin reference.** Model C is the documented best-practice pattern for
multi-region pools in general (Bitcoin-scale), but no open-source Grin pool publishes this exact
topology — grin-pool is single-region, and the commercial pools' internals are unobservable from
outside. Treat latency/behaviour claims as "measure on a real link".

### 8.2 The pieces

| Piece | Where | Notes |
|---|---|---|
| WireGuard server | central | mainnet `wg-grinpool`, udp **51820**, tunnel net `10.66.66.0/24`; testnet `wg-grinpool-tn`, udp **51821**, `10.66.67.0/24`. Hub is always `.1`, gateways `.2`, `.3`, … Keys/state in `/opt/grin/conf/wg[-testnet]/`. |
| Region ports | central, `region_ports` in the pool config | allocated from **3391** (mainnet) / **13391** (testnet), bound to `region_listen_host` = the wg server IP |
| Pairing string | `GRINGW1\|region\|hub_pubkey\|hub_public_endpoint\|hub_tunnel_ip\|gw_tunnel_ip/32\|region_port` | one line, printed by the pool box; paste it on the gateway instead of typing seven values |
| Mutation path | `/usr/local/bin/grin-gateway-ctl` (`init-server`/`add-peer`/`remove-peer`/`list`/`status`) | the ONLY writer of `/etc/wireguard/wg-grinpool*.conf` and `region_ports`; validates every input itself and computes AllowedIPs internally (`0.0.0.0/0` is unrepresentable) |
| Operator surfaces | admin panel **Regions & Gateways**, or CLI menu **W** | both call the same helper, so they cannot drift. The panel binds a new listener without the service restart the CLI path needs; the CLI is the SSH/offline fallback. |
| Hub endpoint DNS name | menu `W → 5` | pairing strings then carry a name instead of a raw IP, so a provider/IP change needs only an A-record update + a tunnel restart on each gateway — no re-pairing |

### 8.3 Bring-up order

Start **singlebox** and prove the local pipeline end-to-end *before* adding a gateway. Don't debug
federation and the core pipeline at the same time.

**Pool box** (`07_grin_mining_public_pool.sh` → `1) Pool server`, or `G) Guided Full Setup`):
1. `1) Install` → `2) Configure` (pool name, domain, network, fee, region) → `3) Deploy web files`
   → `4) Setup nginx` → `5) Set up wallet` → `6) Service control` (start) → `7) Create admin`.
2. Only when adding a region: admin panel **Regions & Gateways → Enable multi-region** (or `W → 1`)
   — installs WireGuard, keys, tunnel, firewall, and sets `region_listen_host`.
3. Add the region (panel row, or `W → 2`) → it assigns a tunnel IP + region port and prints **one
   `GRINGW1|…` line**. Copy that.

**Gateway box** (a *different* box — it binds :3333 too), `07_grin_mining_public_pool.sh` →
`2) Regional gateway`:
1. `1) Install` (haproxy + wireguard-tools + python3; generates the keypair — hand its public key to
   the pool box's add-peer step).
2. `2) Configure` → paste the `GRINGW1|…` string (or type region / hub endpoint / tunnel keys).
3. `3) Bring up tunnel` (`wg-quick up wg-grinpool` — the gateway box always names its single
   tunnel `wg-grinpool`, whichever network the pool is on) → `4) Service control` → start the forwarder.
4. `5) Status` → tunnel handshake present, `:3333` listening.

**Miner:** point lolMiner/GMiner/IPOLLO at `stratum+tcp://<gateway-ip>:3333`, username
`<grin_address>.<worker>`. Miners always connect to the public stratum port on their nearest
gateway — region ports are internal plumbing and are never miner-facing.

### 8.4 Scenario matrix

**Layer 1 — bash / deploy**
- Services exist & enabled: `grin-pool-manager[-testnet]` (pool), `grin-gateway` (gateway).
- Configs written 0600: the pool config, `/opt/grin/conf/grin_gateway.json`.
- `jwt_secret` present and **stable across a restart** (not regenerated at boot).
- Ports listening per §11; node built-in stratum is **localhost-only** (`127.0.0.1:3416`, not `0.0.0.0`);
  region listeners bound to the wg IP, **never** `0.0.0.0`.
- `bash -n` clean on all `07_*`; `node --check` clean on backend JS; `nginx -t` OK.

**Layer 2 — backend / money (single box first)**
- Share → PPLNS: submitted shares land in `shares`; a found block matures past `confirm_depth`
  (100 testnet) → `rewards` distributes; `balance_log` gets append-only rows; no share paid twice.
- Orphan path: mark a confirmed block's nonce absent from chain → reversal reverses the **exact**
  `balance_log` amounts (incl. fee), balance never < 0.
- Withdrawal: CAS balance lock (insufficient → `409`); max 1 pending per address across rails
  (`429`); idempotent send (`txid`); reversal cooldown blocks an immediate re-request.
- Ownership gate: a withdraw/finalize without a valid `proof` is refused (§10).
- Auth: login → refresh → **old refresh replay rejected**; 5-fail **lockout** then unlock; every
  admin mutation writes an `admin_audit_log` row.

**Layer 3 — multi-region (pool + one gateway)**
- A share submitted through the gateway appears in the central `shares` table tagged with **that
  region**, and `miner_ip` is the miner's real address (from PROXY-v2), not the gateway's.
- `GET /api/pool/stats/regions` shows the region's GPS/miners/shares; `/api/pool/locations` shows
  its label + public stratum URL; `GET /api/admin/health/gateways` reports it `online` with a
  recent `tunnel_handshake_age` and `stratum_reachable: true`.
- Blocks found from gateway shares credit exactly like local ones (same code path).
- Tunnel-outage drill: stop the tunnel → miners on that gateway disconnect (there is **no edge
  buffer** by design — the edge holds no state) → region goes `stale` then `offline` → bring it
  back and miners reconnect. Nothing to reconcile, because nothing was staged.
- Re-pair drill: `remove-peer` then `add-peer` (never a duplicate add) — and confirm the region
  keeps its port when only the gateway **box** is replaced.

**Layer 4 — frontend / public**
- Public pages render live: home stats, `/blocks`, `/payments` (aggregated), `/miners` (masked
  addresses), an account page for a real address, the connect grid showing every active region.
- Admin: login over HTTPS sets httpOnly cookies; dashboard/withdrawals/settings/Regions load;
  testnet currency label shows `tGRIN`.
- XSS: a worker name / address with HTML metacharacters renders escaped.

**Failure drills (must all degrade safely):** tunnel down (above) · node stratum down (*Miners connect
but get no work*, §7) · wallet locked (*GetWorks = 0*, §7) · DB `PRAGMA integrity_check` not `ok` ·
`systemctl stop` flushes WAL cleanly (no `-wal`/`-shm` growth after stop).

### 8.5 Endpoint reality check — verified against `back-end-pool/index.js` (2026-09-07)

| Endpoint | State | Notes for testing |
|---|---|---|
| `GET /api/health` | ✅ alias of `/health` | either path works |
| `GET /api/pool/stats/regions` | ✅ | per-region GPS/miners/shares over a 15-min window, joined onto `pool_locations` |
| `GET /api/pool/locations` | ✅ | public list of active regions (region/label/stratum_url, grouped by country) |
| `GET /api/admin/health/gateways` | ✅ | per-region liveness: `min(share age, wg handshake age)` → online (<180 s) / stale / offline (≥600 s) / `unknown` when neither signal exists, plus a 2.5 s TCP probe of each declared public stratum URL |
| `GET/POST/DELETE /api/admin/locations` | ✅ | CRUD on `pool_locations` (upsert by `region`); audit-logged. **Metadata only** — the real wiring is the wg peer + region port |
| `GET /api/admin/gateways/server`, `POST /api/admin/gateways/server`, `GET /api/admin/gateways/:region/pairing` | ✅ | panel-side `init-server` / pairing-string retrieval via scoped `sudo grin-gateway-ctl`; the POST is `freshAdmin` (step-up gated) |
| `POST /api/shares`, `POST /api/blocks` | 🗑 **gone** | the satellite ingestion API. Removed 2026-06-22 with the role; there is no shared-secret header and no IP allowlist any more. A gateway sends **stratum bytes over a tunnel**, not HTTP. |
| `GET /api/admin/health/satellites` | 🗑 **gone** | replaced by `/api/admin/health/gateways` |
| `POST /api/account/:addr/withdraw` | ✅ (tor · slatepack · nostr) | `{ amount, method, proof }`; CAS lock in `WithdrawalScheduler`; 409 insufficient / 429 already-pending (any rail) / 400 below min |
| `GET /api/account/:addr` · `/balance/log` · `/shares` · `/tor-check` | ✅ | summary (balance/paid/pending/shares/hashrate, `payouts_frozen`, `has_recorded_ip`/`has_recorded_pass`), append-only ledger, live Tor reachability |
| testnet `POST /api/admin/miners/:addr/inject` | ✅ testnet-only (403 on mainnet) | the "skip the maturity wait" shortcut; credits balance + writes `balance_log` + audit row |
| `POST /api/account/:addr/min-payout` | 🗑 **gone** | per-account threshold retired 2026-07-17 (§10); only pool-wide `min_withdrawal` applies |
| `POST /api/account/:addr/cancel` (public cancel) | 🗑 **gone** | removed 2026-07-17 (§10.1) — both parked states self-recover; admin cancel is step-up gated |
| `GET/POST /api/claim/:id` (slatepack claim rail) | ❌ never built | the slatepack rail ships through the withdraw route, not a claim endpoint |
| `GET/PUT /api/admin/users[/:id]`, `PUT /api/admin/miners/:addr` | ❌ still absent | legacy `admin-panel/users.html` references some; not required by the primary dashboard |
| `GET /api/admin/health/system` | ✅ | real host CPU/mem/disk/uptime |

### 8.6 Copy-paste smoke tests

Run on the box. Set the vars once. `$NET=mainnet` or `testnet`; ports per §11.

```bash
# ── vars ──────────────────────────────────────────────────────────────────────
NET=testnet                        # or mainnet
API=127.0.0.1:8090                 # Central API, local to the pool box (mainnet: 8080)
CONF=/opt/grin/conf/grin_pubpool_testnet.json      # mainnet: grin_pubpool.json
DB=/opt/grin/pubpool/$NET/pool.db
ADDR=tgrin1exampleaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ADMIN_USER=admin; ADMIN_PASS='your-admin-password'

# ── ports listening (pool box: API + public stratum + region ports on the wg IP) ─
ss -tlnp | grep -E ':(3333|13333|3416|13416|8080|8090|3391|13391|443)\b'
ss -ulnp | grep -E ':5182[01]\b'                    # WireGuard (mainnet 51820 / testnet 51821)

# ── 1) health + public reads (no auth) ─────────────────────────────────────────
curl -s http://$API/health                  # /health and /api/health both work
curl -s http://$API/api/config/pool-info
curl -s http://$API/api/pool/stats
curl -s http://$API/api/pool/stats/regions   # per-region GPS/miners/shares
curl -s http://$API/api/pool/locations       # operator-declared active regions
curl -s http://$API/api/stratum/stats
curl -s http://$API/api/stratum/hashrate
curl -s http://$API/api/pool/blocks
curl -s http://$API/api/pool/miners           # balance distribution — addresses MASKED since 2026-07-28
curl -s http://$API/api/pool/payments
# REMOVED 2026-07-28: /api/miners/top (public rich-list, see security audit §C1) and
# /api/account/$ADDR/balance (every field of it is already in /api/account/$ADDR).
curl -s http://$API/api/pool/poolstats        # pool-directory listing feed (see 1c below)
curl -s http://$API/api/public/branding
curl -s http://$API/api/public/endpoints      # the live API reference api-docs.html renders
curl -s http://$API/api/account/$ADDR        # summary (404 until the addr has shares)
curl -s http://$API/api/account/$ADDR/balance/log
curl -s http://$API/api/account/$ADDR/shares
curl -s http://$API/api/account/$ADDR/tor-check

# ── 1c) Getting listed on miningpoolstats.stream/grin ───────────────────────────
# The pool is listed by PULL, not push: they poll a URL, we publish one. Hand them
#     https://<your-pool-domain>/api/pool/poolstats
# and nothing else — no file to generate, no cron, no auth carve-out (it is aggregates only,
# so it is safe unauthenticated). Listings are added by a human at MPS on request; there is no
# auto-discovery, so publishing the URL alone gets you nothing until you contact them.
#
# WHY THE SHAPE LOOKS LIKE THE SOLO FEED: it is a field-for-field mirror of solo's
# poolstats_<net>.json (scripts/lib/07_mining_block_collector.py build_poolstats). If MPS has
# already imported the solo feed, they have a working parser and need no new adapter. Adding
# fields is safe; renaming or dropping one breaks their importer. Two fields are additive-only
# extras here: pool.url and pool.reward_model.
#
# REFRESH: recomputed at most once per 60s and served from an in-process cache in between, so
# polling faster than 1/min returns byte-identical output. 1–5 min is the sensible poll range.
# (Solo's file is regenerated every 5 min by cron, so the pool feed is the fresher of the two.)
# The `ts` field is the generation time — if it stops advancing, the feed is stale.
# On a backend error the last good body is served for up to 15 min, then the endpoint 500s
# rather than serving a frozen feed forever: a listing that silently stops updating is worse
# than one that visibly goes down, because nobody notices the first.
#
# NULL vs 0 — do not treat them the same: network.* is null when the node is unreachable, and
# network.hashrate_gps_24h stays null until pool_metrics_hourly has an hour of samples (it does
# not backfill). pool.last_block is null until the pool finds its first non-orphaned block.
curl -s https://$DOMAIN/api/pool/poolstats | python3 -m json.tool
# Sanity before sending the URL: net matches the network you think you deployed, pool.name is
# not still the default, and pool.url is set (it comes from config.subdomain — blank if the
# installer never recorded a domain, which makes the listing link nowhere).

# ── 1b) API reference contract (api-docs.html) ──────────────────────────────────
# The endpoint LIST is derived from the live Express route table, so it cannot drift: a new
# route under PUBLIC_API_PREFIXES appears by itself, a deleted one disappears. The per-endpoint
# NOTES are hand-maintained in API_DOC_META and CAN drift. When you add a public route, add its
# meta entry in the same commit — desc + shape at minimum. `shape` is not decoration: this API
# is NOT uniform (newer /api/public/* routes return { success, data }, most older ones return
# the payload raw or as a bare array, and errors are ALWAYS { error } with no success flag), and
# the page publishes the real shape per row rather than one blanket claim that is wrong for most
# of them.
#
# Drift check — runs on the SOURCE, so it needs no server and works before you deploy. Fails if a
# public route has no meta entry, or a meta entry names a route that no longer exists:
node -e '
const src=require("fs").readFileSync("index.js","utf8");
const pf=src.slice(src.indexOf("const PUBLIC_API_PREFIXES = ["));
const P=[...pf.slice(0,pf.indexOf("];")).matchAll(/.(\/api\/[^"'"'"']+)./g)].map(m=>m[1]);
const R=[...src.matchAll(/app\.(get|post|put|delete|patch)\(\s*.([^"'"'"']+)./g)]
  .map(m=>m[1].toUpperCase()+" "+m[2]).filter(k=>P.some(p=>k.split(" ")[1].startsWith(p)));
const b=src.slice(src.indexOf("const API_DOC_META = {"));
const M=new Set([...b.slice(0,b.indexOf("\n  };")).matchAll(/.((?:GET|POST|PUT|DELETE|PATCH) \/api\/[^"'"'"']+).:/g)].map(m=>m[1]));
const miss=R.filter(k=>!M.has(k)), dead=[...M].filter(k=>!R.includes(k));
console.log("routes",R.length,"meta",M.size,"| undocumented",miss.length,miss,"| dead",dead.length,dead);
process.exit(miss.length||dead.length?1:0);'

curl -s http://$API/api/public/endpoints | python3 -m json.tool | head -40

# ── 2) admin auth (httpOnly cookies) ────────────────────────────────────────────
curl -s -c /tmp/pool-cookies.txt -X POST http://$API/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}"
C='-b /tmp/pool-cookies.txt'
curl -s $C http://$API/api/admin/dashboard
curl -s $C http://$API/api/admin/audit-log            # expect a login_success row
curl -s $C http://$API/api/admin/health/system        # real CPU/mem/disk/uptime
curl -s $C http://$API/api/admin/health/gateways      # per-region liveness (see §8.5)
curl -s $C http://$API/api/admin/miners
curl -s $C "http://$API/api/admin/miners/$ADDR"
# region registry CRUD (upsert → list → the public surface reflects it)
curl -s $C -X POST http://$API/api/admin/locations -H 'Content-Type: application/json' \
  -d '{"region":"us-east","label":"US East","stratum_url":"us.example.com:3333","is_active":true}'
curl -s $C http://$API/api/admin/locations

# ── 2b) testnet-only: inject balance + drive a withdrawal end-to-end ─────────────
# inject is hard-guarded to testnet (403 on mainnet) — skips the confirm_depth wait.
curl -s $C -X POST "http://$API/api/admin/miners/$ADDR/inject" \
  -H 'Content-Type: application/json' -d '{"amount":25}'
# now the address has balance → trigger a payout. `proof` is the ownership gate (§10):
# the last-2 window of miner IP *or* stratum password recorded for this address.
curl -s -X POST "http://$API/api/account/$ADDR/withdraw" \
  -H 'Content-Type: application/json' \
  -d '{"amount":10,"method":"tor","proof":"203.0.113.9"}'
# CAS guards: a second concurrent request → 429 (pending on ANY rail); over-balance → 409
curl -s $C http://$API/api/admin/withdrawals       # the new withdrawal should appear

# ── 3) DB-layer checks (cross-check the region aggregates) ──────────────────────
sqlite3 "$DB" 'PRAGMA integrity_check;'
sqlite3 "$DB" "SELECT region,COUNT(*) FROM shares GROUP BY region;"   # matches /api/pool/stats/regions
sqlite3 "$DB" 'SELECT grin_address,balance,balance_locked FROM miner_accounts LIMIT 5;'
sqlite3 "$DB" 'SELECT height,status,found_by FROM blocks ORDER BY height DESC LIMIT 5;'
sqlite3 "$DB" "SELECT event_type,reference_type,amount FROM balance_log ORDER BY id DESC LIMIT 5;"

# ── 4) multi-region: central side ──────────────────────────────────────────────
sudo grin-gateway-ctl list   --net $NET | python3 -m json.tool   # regions + pairing strings
sudo grin-gateway-ctl status --net $NET | python3 -m json.tool   # per-region handshake + rx/tx
wg show wg-grinpool          # testnet: wg-grinpool-tn
python3 -c "import json;print(json.load(open('$CONF')).get('region_ports'))"

# ── 5) multi-region: gateway side (on the GATEWAY box) ─────────────────────────
systemctl is-active grin-gateway
journalctl -u grin-gateway -n 30 --no-pager
wg show wg-grinpool latest-handshakes           # a handshake proves the tunnel, NOT the routing
python3 -c "import json;print(json.load(open('/opt/grin/conf/grin_gateway.json')))"
# raw stratum login straight down the tunnel — proves hub_endpoint points at the RIGHT port
printf '{"id":"1","jsonrpc":"2.0","method":"login","params":{"login":"%s","pass":"x","agent":"nc"}}\n' "$ADDR" \
  | nc -w 5 <hub_tunnel_ip> <region_port>

# ── logs ─────────────────────────────────────────────────────────────────────
journalctl -u grin-pool-manager${NET:+-$NET} -n 50 --no-pager
```

> Payouts can't be smoke-tested by a single curl beyond creation (the rest is scheduler-driven and
> needs a matured block + a reachable miner listener). Validate during the 7-day soak: confirm a real
> block, wait `confirm_depth`, request a payout, watch the row reach `confirmed` with a `txid` and a
> kernel proof, then verify the reversal/CAS branches per Layer 2.

---

## 9. Durable trend metrics & public chart recorders (2026-07-17, add-ons — NOT VPS-tested)

Two never-pruned hourly rollup tables (kept out of `lib/retention.js`), written by
`HashrateTracker.rollupCompletedHours()` each completed hour, idempotent upserts:

- **`pool_metrics_hourly`** — pool GPS, distinct miners, blocks, earnings, payout **+ new
  `network_hashrate_gps`** (NULL until sampled). The network sample comes from
  `hashrateTracker.networkGpsProvider` (wired in `index.js` to the block monitor's node client;
  `diff × 42 / 60 / 16384`), fetched at most once per completed hour and applied only to the
  just-completed bucket (catch-up buckets after an outage keep NULL — no fake history). Upsert
  keeps an existing sample via `COALESCE` when a re-run passes NULL.
- **`pool_region_metrics_hourly`** — `(bucket_start, region)` PK: per-region GPS, distinct
  miners, share count, from the `shares.region` stamp. Backs "miners by gateway" trends.

**Endpoints** (public, rate-limited, same `?range=day|week|month|year|all` vocabulary):
- `/api/pool/metrics/history` — now also returns `network_hashrate_gps` per point (null-safe).
- `/api/pool/metrics/history/regions` (new) — `{ series: [{ region, points: [{t, miner_count,
  hashrate_gps}] }] }`, busiest-first.

**Frontend**
- Homepage **P-04** now stacks three Chart.js recorders (the hand-rolled 24h strip chart was
  removed; `chart.umd.min.js` + `charts-init.js` are now loaded by `index.html`): pool hashrate
  (24H = fine 5-min series from `/api/pool/hashrate/history`, 7D/30D = rollup), **network
  hashrate as an aligned small-multiple below it** (never dual-axis — network GPS is orders of
  magnitude above pool GPS), and miners online (fixed 30d). Range toggle 24H/7D/30D in the
  panel title (`.chart-range`, reactor.css).
- **miners-stats P-02b** "Chart recorder — miners by gateway": multi-line per region via new
  `PoolCharts.renderMultiTrendLine()` (union-of-timestamps alignment, gaps NOT interpolated,
  legend for ≥2 series, single y-axis). Colors from `PoolCharts.PALETTE` — 8 fixed slots,
  CVD-validated against the dark panel surface — assigned by region NAME in alphabetical slot
  order (color follows the entity, not the rank). Panel hidden when the only region is
  `default` (single-box) or there's no data.

**Gateway status fix** (same date): `readGatewayStatus()` no longer skips WireGuard peers with
no handshake — a never-handshaked/downed gateway now yields `{handshake: 0}` so
`/api/pool/stats/regions` can mark it `offline` (red). Previously an all-gateways-down pool
returned `{}`, indistinguishable from "wg unavailable", and every dead gateway showed idle
(blue) forever.

**Public copy** (index.html): P-05 patch-note folded into the miner-setup guide (password
guidance now tells miners to pick a real private password — a future release may verify it);
P-08 vardiff line removed (no vardiff exists); payout lines now describe the miner-initiated
Tor/slatepack rails with 6h→48h retry back-off and refund-on-failure; P-03 mimic says
`SLATEPACK ▸ ON REQUEST`. Note: the stratum password is currently **not read or stored**
anywhere (`handleLogin` parses only `login`). *(Superseded later the same day — §10 makes the
password an ownership proof.)*

## 10. Ownership gate v2 + manual-withdrawal simplification (2026-07-17, add-ons — NOT VPS-tested)

Operator decisions (same-day discussion): proof = IP **or** password; keep last-2 windows but
hash at rest; gate **all** money actions; retire the per-account payout threshold.

**Gate (lib/owner-proof.js, rewritten):** `verifyOwnerProof(db, addr, submitted)` takes ONE
field — if it parses as an IP (v4/v6, canonicalised) it's checked against the last-2 IP
window; a usable password is checked against the last-2 password-hash window. All proofs
stored as salted scrypt `v1$salt$hash` (never plaintext); legacy plaintext IPs upgraded by a
background `migrateOwnerProofHashes(db)` at startup (index.js calls it after scheduler start).
Trivial passwords (`x`, `123`, defaults, `d=…`, <4 chars) never capture/verify. Fail throttle
unchanged (8/10 min → 5 min lockout). `canonicalizeIp` gives IPv6 one stable form (zone/
brackets/`::ffff:`/`::`-expansion/v4-tails).

**Capture (stratum):** `handleLogin` now also reads `params.pass` → kept on the in-memory
session only; on a session's **first accepted share** `handleSubmit` calls
`minerManager.recordOwnerEvidence(addr, ip, pass)` (async fire-and-forget) which shifts the
last-2 windows for both proofs. Schema: `miner_accounts` + `last_pass_hash`/`prev_pass_hash`
(migrateMinerAccounts).

**Routes (index.js):** `POST /api/account/:addr/withdraw` (tor AND slatepack),
`…/:id/finalize`, `…/:id/cancel` all verify `req.body.proof` (legacy `ip_proof` accepted) —
rationale: an ungated Tor trigger let anyone force payouts for leaderboard addresses (pool-paid
fees, output consumption, forced timing) and an open cancel was a nuisance vector.
`POST /api/account/:addr/min-payout` **removed**; account GET no longer returns
`min_payout`/`effective_min_payout` and adds `has_recorded_pass` next to `has_recorded_ip`.
Scheduler enforces only pool-wide `config.min_withdrawal` (min_payout column now dead).

**Account page (account-settings.html):** P-04 is one column — single ownership-proof input
(hint links https://tools.grin.money/tools/my-ip/ for IPv4/IPv6 lookup), shared amount field
(blank = full balance, label shows the pool minimum), Tor/slatepack radio. Threshold UI
removed; cancel now sends the proof; friendly `PROOF_REASONS` mapping for gate errors; demo
dataset updated. Sidebar shows the pool minimum.

**Verified locally:** `node --check` on index.js + 5 libs + the extracted inline script;
owner-proof smoke test (canonicalisation v4/v6, capture/no-op/rotation, IP+password verify,
trivial-password rejection, legacy plaintext verify) — all pass. Deploy needs a backend
restart (column migration + background hash migration run automatically).

### 10.1 Same-day follow-up (2026-07-17 later, add-ons — NOT VPS-tested)

Operator decisions after a second discussion round:

- **Public cancel REMOVED** (route + P-04 button + `cancelPending`). Both parked states
  self-recover — Tor `markFailed()` auto-reverses after max retries, slatepack auto-refunds
  via TTL expiry — so cancel was pure abuse surface: a Grin send that *looks* failed may have
  actually posted, and reversing the lock then = double-pay. Admin support cases use the
  existing step-up `POST /api/admin/withdrawals/:id/cancel` (payments page);
  `scheduler.cancelWithdrawal()` kept for admin tooling only. Known residual (documented, not
  built): the automatic retry/reversal paths carry the same theoretical exposure — proper fix
  is recording slate_id on Tor sends + checking wallet tx state (`retrieve_txs`) before any
  retry/reversal.
- **Explicit amount + min/max chips**: blank-=-full-balance retired on the page (API still
  accepts `amount:null`). The amount label has clickable `min <pool-min>` / `max <balance>`
  chips that autofill; `amountValue(msgEl)` now rejects blank/non-positive with a hint.
- **Blocklist additions-only**: new `access.extra_banned_passwords` (pool_config, JSON array;
  validator accepts newline/comma lists and normalises to deduped lowercase, cap 500).
  `isUsablePassword(pass, db)` merges it (60 s cache) ON TOP of the hardcoded seed — the seed
  and structural rules can never be removed via admin. Editable in settings-access.html
  (textarea, one per line; populate special-case in settings-common.js). Because verify
  re-checks the submitted value, a newly added entry stops working as proof immediately.
- **Payout rail status chip**: account summary now returns `payouts_frozen`
  (`scheduler.isFrozen()`, boolean only — the freeze reason stays admin-side); P-04 title
  shows "payouts active/paused" chip and the Tor button disables while frozen.
- **Goblin nickname payouts over Nostr**: design only → `script07_design.md` §15 (registered
  destination + 48 h cooldown + npub TOFU pin; bridge sketch reusing the slatepack state
  machine). Not scheduled.

Verified: `node --check` ×5 + re-extracted inline script; blocklist smoke test (seed + extra
entries, case-insensitivity, corrupt-JSON fail-open) and validator normalisation tests pass.

**Round 3 (same day):** cross-rail payout exclusivity + cooldown (audit §E.2 has the full
security rationale). Shared `PENDING_SQL` in withdrawal-scheduler.js closes the hole where a
pending slatepack didn't block a Tor create (and fixes the same 3-status list in the admin
miner-detail pending view). New `_assertNoRecentReversal()` gate in both create paths:
after any withdrawal reversal (Tor failure, slatepack expiry/creation failure, admin cancel)
the address waits `payout.withdrawal_cooldown_minutes` (default 30, 0 disables) before
requesting another payout on any rail. Plumbed through pool-settings defaults/validator/
applyToConfig, config.js default, and a field on admin settings-payout.html (applied at
backend restart, like min_withdrawal); account-page note mentions the cooldown. The designed
Nostr rail (design §15) inherits both gates automatically since it parks in
`slatepack_pending`. Verified: `node --check` ×4 + 12-case stub-db smoke test (pending gate
cross-rail, cooldown default/custom/disabled, validator bounds) all pass.

### 10.2 Goblin/Nostr payout rail BUILT (2026-07-18, add-ons — NOT VPS-tested)

Full implementation of design §15 (which now carries a §15.5 "what shipped" note). A miner
registers a Goblin username on the account page and is paid over a Nostr DM — no Tor listener.
**OFF by default** (`nostr_payouts_enabled`); needs `npm install` (nostr-tools + ws) and a
backend restart. Third-party rail (pays a username, not the address's own wallet), so it
layers a registered destination + ≥48 h cooldown + TOFU npub re-pin on top of the ownership
gate — see security_audit §E.3 for the threat model.

Build shape (bottom-up):
- `lib/nostr-payout.js` — the bridge. nostr-tools + ws lazy-required inside `start()` (pool
  boots without them when the feature is off / not yet installed). All nostr-tools calls are
  confined to a "wire" section so a future API drift is a localized fix. Does NOT touch
  balances — transport only. Resolves usernames (NIP-05, domain-allowlisted), publishes the
  NIP-17 gift-wrapped slatepack, and runs a persistent subscription that routes an incoming S2
  back to the scheduler. Dedup via a `nostr_seen_events` table. Pool identity key persisted to
  a `.nostr_payout_key` file (transport-only; can't sign slates).
- `lib/withdrawal-scheduler.js` — `createNostrWithdrawal` (mirrors the slatepack rail: same
  CAS lock, `PENDING_SQL` cross-rail one-pending, freeze + failed-payout-cooldown gates, TTL
  refund; S1 is **plain armor** `recipients:[]`; publishes via the bridge, reverses the lock on
  any wallet/relay failure) and `finalizeNostrWithdrawal` (called by the bridge on an S2:
  re-checks sender==registered npub + binds slate.id, then finalize+post+confirm; errors leave
  the row pending for resend/TTL). `nostrBridge` injected post-construction to avoid a cycle.
- `index.js` — constructs+starts the bridge at boot inside a try/catch (missing package →
  warn + disable, never crash); wires the response handler; adds
  `POST`/`DELETE /api/account/:addr/nostr-destination` (ownership-gated, rate-limited) and a
  `method:'nostr'` branch in the withdraw route that enforces registered + cooled-down +
  TOFU-verified destination before calling the scheduler; account summary gains
  `nostr_payouts_enabled` + a `nostr_destination` state object (username + active_at, npub
  never exposed).
- Config: `lib/config.js` defaults + `lib/pool-settings.js` (defaults/validators/applyToConfig)
  for `nostr_payouts_enabled`, `nostr_relays`, `nostr_nip05_domains`,
  `nostr_destination_cooldown_hours`. Admin fields on `settings-payout.html` (+ the
  JSON-array↔newline populate special-case in `settings-common.js`). `package.json` gains
  `nostr-tools` + `ws`.
- Frontend `account-settings.html` P-04: a "Goblin (Nostr)" payout option (shown only when the
  pool enabled the rail) with a register/replace/remove destination form and a send button that
  unlocks only once the destination is past its cooldown.

Verified: `node --check` on all edited JS + the extracted account-page inline script; a
23-case stub smoke test (slatepack extraction one/none/two/oversized, relay-floor forcing +
domain allowlist parsing, all four validators, and the scheduler's createNostrWithdrawal
guards + lock/reverse-on-publish-failure + finalize sender-mismatch rejection) — all pass.
**NOT VPS-tested**: the live Nostr transport (nip59 wrap/unwrap signatures, SimplePool relay
I/O, real goblin AutoReceive round-trip) needs an E2E run against `relay.floonet.dev` with a
real Goblin wallet — do a testnet / tiny-amount pilot first.

---

## 11. Ports

The reference §5 and §8 point at. Mainnet and testnet are separated by PORT, not by box — every
row below has two values.

**Pool box (`singlebox` / `hub`)**

| Port | Mainnet | Testnet | Bind | What |
|---|---|---|---|---|
| Public stratum | 3333 | 13333 | `0.0.0.0` | miners. Raw stratum only — a PROXY-v2 header is never accepted here |
| Central API | 8080 | 8090 | `127.0.0.1` | Express backend; reached from outside only through the nginx vhost |
| HTTPS | 443 | 443 | `0.0.0.0` | nginx (static site + `/api/*` proxy) |
| Node built-in stratum (upstream) | 3416 | 13416 | `127.0.0.1` | grin's own `stratum_server_addr` default — the toolkit does **not** move it |
| Node API (foreign/owner) | 3413 | 13413 | `127.0.0.1` | wallet → node |
| Wallet combined listener | 3420 | 13420 | `127.0.0.1` | `owner_api` + `include_foreign`; ECDH auto-unlock. `:3415`/`:13415` is retired (kept only as `api_listen_port` in `grin-wallet.toml`) |
| Region stratum listeners | 3391, 3392, … | 13391, 13392, … | `region_listen_host` (the wg server IP) | one per regional gateway; region is stamped from the listener |
| WireGuard | 51820/udp (`wg-grinpool`) | 51821/udp (`wg-grinpool-tn`) | `0.0.0.0` | only when multi-region is enabled |

Tunnel nets: `10.66.66.0/24` (mainnet) / `10.66.67.0/24` (testnet); hub `.1`, gateways `.2`, `.3`, …

**Gateway box**

| Port | Value | Bind | What |
|---|---|---|---|
| Public stratum | 3333 (`public_stratum_port`) | `0.0.0.0` | miners; HAProxy `mode tcp` + `send-proxy-v2`, stick-table conn-rate limit |
| WireGuard | ephemeral → the hub's 51820 (mainnet) / 51821 (testnet) udp | — | local iface is always `wg-grinpool` |

A gateway box runs **nothing else** — no node, no wallet, no DB, no Node.js, no HTTP listener.

**One mining role per box.** A brain and a gateway both bind :3333, so `pool_mode_conflict_check`
refuses to install one where the other (or a legacy satellite) already exists. Mainnet and testnet
*pools* can share a box; solo mining cannot share with either.
