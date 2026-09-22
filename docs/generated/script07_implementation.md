# Script 07 — Public Mining Pool (Implementation)

> **Covers code as of:** 2026-09-07 · **Last verified:** 2026-09-07 — §§1–8 and §11 re-derived from
> `scripts/07_grin_mining_public_pool.sh`, `scripts/lib/07_lib_{gateway,gwctl,hub,pool_backup,pool_wallet}.sh`
> and `web/07_mining_pool_public/back-end-pool/`. §§9–10 are as-written add-on notes, not re-verified — except §10.4, written against the
> code it describes on 2026-09-22 (Part 1 backend and Part 2 account page, both re-read after the
> edits) and backed by the suite counts quoted in it.
> §1b re-verified 2026-09-21: all 49 `API_DOC_META` rows read against their handlers (static, no VPS).
> **Product code last changed:** 2026-09-22 (ownership-proof SET, design §17 Part 2 — account page: `public_html/account-settings.html` only — `proofHintText()` renders `a.proofs` as counts + last-added instead of two booleans, the "Evidence changed" banner and the `evidence` argument deleted, `renderPasswordProof(pp, proofs)` warns only past `proofs.max` ("Too many passwords") with several passwords inside the cap now an OK line, `PASS_STATE_TEXT.ok` reworded, the `Accepted:` line and three fold paragraphs restated for a set of ten, DEMO dataset reshaped; suite unchanged at 875/875 — §10.4 "Part 2". Same day, Part 1 — backend: `miner_proofs` table + `miner_accounts.proof_salt`, per-address scrypt salt, set capture/verify with LRU eviction and a flagged-not-deleted anchor, `migrateProofSet()` replacing `migrateOwnerProofHashes`+`backfillProofAnchors`, `proofs` on the account and admin miner views, `test-owner-gate.js` 19 → 36 and `test-public-leakage.js` 77 → 86 — §10.4. 2026-09-21 (donor names, design §16 Part 5 — the independent review: two fixes in `lib/donor-names.js` (rescan parses the list once per walk; a separators-only label is no label), `test-donor-names.js` 148 → 156, design §16.12 written — §10.3 "Part 5". Same day, Part 4: `/api/pool/donors` v2 — league/past/totals/ranking via `lib/donor-ledger.js donorWall()`, `donate.html` D-03 league + past strip + ranking sentence + not-verified line, D-01 `yourbrandname-donate10`, api-docs row, `test-donor-league.js` 68/68, leakage §9 — §10.3 "Part 4". Same day, Part 3: admin → Donors page, `GET /api/admin/donors` + `/summary`, `POST …/censor|uncensor` audited, rescan on list/pool-name change, dashboard `new_donor_names_7d` + nav badge, `allow_miner_donations`/`donation_address` moved off `settings-incentives.html`, `parseDonateToken` export, `check-syntax.js` type-sniff fix — §10.3 "Part 3". Same day, Part 2: six `donor_*` columns, `lib/donor-names.js` + `lib/donor-ledger.js`, six `incentives` settings keys, capture on the from-zero set only, `/api/account/:addr` `donor_name` + state, account-page row — §10.3 "Part 2". Same day, Part 1: worker part case-folded, label cap 25 → 32, raw 40 → 48, `donor_label` — §10.3 "Part 1". Same day: api-docs audit: 9 meta rows corrected, the drift-check
> regex line-anchored, and `GET /api/account/:addr/shares` un-broken — it had answered `{}` since it
> was written because `getSharesForMiner` was `async` and never awaited. Same day: P-02b lamps show workers; P-03 prints the share COUNT, not the summed difficulty; P-04 24H trace gap-filled with zeros — §7 row 4, §9. Same day: account `is_online` per rig, not per address; donor-wall totals over every donor and `active_donors` from live tags — §10.3. 2026-09-20: share credit unit + one shared `MinerManager` — first live-miner test found every hashrate at 0.00 G/s and MINERS ONLINE 0; §7 rows 3 and 5. Earlier the same day: pairing string carries the public port; gateway Status boot line, design §13.12s) — `scripts/07_grin_mining_*.sh`, `scripts/lib/07_lib_*.sh`, `web/07_mining_pool_public/`

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
| Network peer snapshot | `index.js` | 20 min | `snapshotNetworkPeers` — per node (mainnet + testnet when both run on the box) reads `get_connected_peers` **and** `get_peers` (the node's own peer store, stamped with its `last_connected`); the live list alone is ~8 sticky outbound seats, the store is what the node's own background probing (~100 handshakes / 20 s) has verified. Country-only rows in `network_peers`; feeds `/api/network/peers` |
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
| Pool hashrate reads ~0 / meaningless | Hashrate is summed accepted-share difficulty over the window (`GPS = sumDiff × 42 / window_s / 16384`), so what each share is CREDITED must be in the chain's unit: job target × the C32 graph weight (16384), `shareCreditDifficulty()` in `stratum-protocol.js`. **This shipped wrong until 2026-09-20** — every share was written at the session's `1.0` vardiff placeholder, so the first live test (8 rigs, ~350 accepted shares) showed 0.00 G/s on every gauge, chart and worker row, and 0 % round effort. `db.js migrateShareCreditUnit` rescales pre-fix rows once (marker `share_credit_c32_units`) so PPLNS weight and luck stay in one unit across the upgrade. Sanity check after a deploy: one rig at job target 1 = `shares_per_min × 0.7 G/s`. |
| Homepage P-03 prints **millions of "SHARES"** after a few hours of one rig; P-04 24H trace shows **no dip** across a mining pause | Two consequences of the share unit above, found 2026-09-21 on grinium.com. (a) `/api/pool/effort.round_shares` is the round's SUMMED difficulty in chain units (the effort numerator, ~16384 per share — `21,544,960 / 16384 = 1315` real shares); the mimic labelled it "SHARES". The endpoint now also returns `round_share_count` (a `COUNT(*)` from the same scan) and the mimic prints that, compact (`1.3 K SHARES`), with the sum on hover. (b) `recordHashrates()` writes a `hashrate_history` row per address WITH a share that minute — a minute with none writes nothing, so a pause is a hole in TIME, and the chart's x-axis is categorical, so the two samples either side of a 3-hour pause sit one step apart and the line simply continues. `getPoolHistory()` now regularizes onto the 60 s sampling grid (`_fillGaps`: absent minute → `0`, from the first sample to now; leading absence left alone so a young pool's trace isn't squashed) before thinning. This is a KNOWN zero — the "draw a null as a gap" rule is for values the server withholds. `getAccountHistory()` (account page chart) has the same hole and is NOT changed. |
| `/api/pool/stats` disagrees with `/api/stratum/stats` (MINERS ONLINE 0 with rigs connected; every account worker "dropped"; stale/reject `–`) | Two `MinerManager` instances. **Was the shipped state until 2026-09-20**: `index.js` and the `StratumServer` constructor each made their own, and the API side's never held a session. `index.js` now injects its instance (`new StratumServer(config, minerManager)`); the constructor's private fallback is for standalone (test) construction only. |
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
| Pairing string | `GRINGW1\|region\|hub_pubkey\|hub_public_endpoint\|hub_tunnel_ip\|gw_tunnel_ip/32\|region_port\|public_stratum_port` | one line, printed by the pool box; paste it on the gateway instead of typing the values. The 8th field (since 2026-09-20) is the pool's **public miner port** — the gateway must listen on exactly it, so the gateway takes it from here rather than asking. A 7-field string from an older hub still parses (the gateway keeps its saved port); an 8-field string on a pre-2026-09-20 gateway is **rejected** (`read` folds the extra field into `region_port`) — pull both boxes together. |
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
   The public stratum port it then shows must be the **pool's** public port (`3333` mainnet): the
   admin Regions card appends that shared port to the region's hostname itself, so a gateway
   listening anywhere else is advertised on a port it does not serve. A current pairing string
   carries it (8th field) and pre-fills the prompt; the bracketed value is otherwise whatever was
   saved on this box last time, not a default.
3. `3) Bring up tunnel` (`wg-quick up wg-grinpool` — the gateway box always names its single
   tunnel `wg-grinpool`, whichever network the pool is on) → `4) Service control` → start the forwarder.
4. `5) Status` → tunnel handshake present, `:3333` listening, and `On reboot : forwarder and
   tunnel start automatically`. The two units are enabled by two different steps (`1)` enables
   `grin-gateway`, `3)` enables `wg-quick@wg-grinpool`); a box missing either reboots into
   `:3333` listening with nothing behind it, which the pool's Port check cannot tell from healthy —
   Status names the missing one and the `systemctl enable` that fixes it.

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
# public route has no meta entry, or a meta entry names a route that no longer exists. The meta
# regex is LINE-ANCHORED (^\s*'KEY':) on purpose: unanchored it also matched "POST /api/account"
# inside a description that cross-references another route and reported a dead entry that did
# not exist (2026-09-21). It checks KEYS only — the notes on each row are still read by hand,
# and that hand-read is what found a route labelled `raw` that returns a bare array, a body line
# that named one proof where the handler demands two, and an endpoint that had always answered `{}`.
node -e '
const src=require("fs").readFileSync("index.js","utf8");
const pf=src.slice(src.indexOf("const PUBLIC_API_PREFIXES = ["));
const P=[...pf.slice(0,pf.indexOf("];")).matchAll(/.(\/api\/[^"'"'"']+)./g)].map(m=>m[1]);
const R=[...src.matchAll(/app\.(get|post|put|delete|patch)\(\s*.([^"'"'"']+)./g)]
  .map(m=>m[1].toUpperCase()+" "+m[2]).filter(k=>P.some(p=>k.split(" ")[1].startsWith(p)));
const b=src.slice(src.indexOf("const API_DOC_META = {"));
const M=new Set([...b.slice(0,b.indexOf("\n  };")).matchAll(/^\s*.((?:GET|POST|PUT|DELETE|PATCH) \/api\/[^"'"'"']+).:/gm)].map(m=>m[1]));
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
  keeps an existing sample via `COALESCE` when a re-run passes NULL. **2026-09-20: `worker_count`**
  (additive migration, NULL for hours rolled up before it) — distinct `(grin_address,
  COALESCE(worker_name,'default'))` pairs per hour, the same key `getWorkerBreakdown` groups on.
- **`pool_region_metrics_hourly`** — `(bucket_start, region)` PK: per-region GPS, distinct
  miners, share count, from the `shares.region` stamp. Backs "miners by gateway" trends.

**Endpoints** (public, rate-limited, same `?range=day|week|month|year|all` vocabulary):
- `/api/pool/metrics/history` — now also returns `network_hashrate_gps` per point (null-safe),
  and since 2026-09-20 `worker_count` (null = pre-column hour; a gap, never 0).
- `/api/pool/metrics/history/regions` (new) — `{ series: [{ region, points: [{t, miner_count,
  hashrate_gps}] }] }`, busiest-first.
- **Re-bucketing rule for counts (2026-09-20):** at day-or-coarser buckets both readers take the
  **peak hour** (`MAX`) for `miner_count`/`worker_count`, not the average. `AVG` counted every idle
  hour as zero: the first live day had 2 miners for 3 of 16 completed hours, Month/Year/All rounded
  6/16 to **0** while Day showed 2. Hashrate stays `AVG`, money stays `SUM`. The P-02 panel title
  says which it is showing (`distinct per hour` / `peak hour per day|week|month`), and P-02 now
  draws miners + workers as two lines on one count axis (`renderMultiTrendLine`), the workers line
  omitted entirely until the first hour with a recorded value.

**Frontend**
- Homepage **P-04** now stacks three Chart.js recorders (the hand-rolled 24h strip chart was
  removed; `chart.umd.min.js` + `charts-init.js` are now loaded by `index.html`): pool hashrate
  (24H = fine 5-min series from `/api/pool/hashrate/history`, 7D/30D = rollup), **network
  hashrate as an aligned small-multiple below it** (never dual-axis — network GPS is orders of
  magnitude above pool GPS), and miners online (fixed 30d). Range toggle 24H/7D/30D in the
  panel title (`.chart-range`, reactor.css). **2026-09-21:** the 24H series is gap-filled server-side
  (see §7 — a mining pause used to vanish from the trace); the hourly rollup behind 7D/30D always
  wrote zero-hours, so those ranges were already right. Same day, **P-02b** gateway lamps read
  `2 miners / 5 workers` — `/api/pool/stats/regions` gained `workers` (distinct address+rig pairs,
  the rollup's key), withheld together with `miners` under the k-anonymity floor, plus `totals.workers`.
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

### 10.3 Account online state is per RIG, not per address (2026-09-21, add-ons — NOT VPS-tested)

First multi-rig test: one of two workers dropped and the account page read **Status: Offline** /
**Miner offline** while the other rig kept submitting. Root cause in `lib/miners.js`:
`closeSession()` wrote `miner_accounts.is_online = 0` on EVERY session close — the flag is
per address, sessions are per rig — and nothing but the next login ever set it back. The
admin miner lists read the same column, so they showed it too.

- **Backend:** `closeSession` (and so `pruneInactiveSessions`) now drops the flag only when it
  closed the address's LAST live session (`getSessionsByMiner().length === 0`).
- **Account page:** P-05 Status and the header lamp are now one three-state readout,
  `renderOnlineState(online, total)`, driven by the same per-worker rows as the P-03 LEDs and the
  "Workers online" pill: all seen-in-24h rigs online → `Online ⛏` / `Miner online`; none →
  `Offline` / `Miner offline` (warn lamp); some → `Partial — x / y online` /
  `x of y workers online` (warn lamp). First paint uses the account flag, then the worker fetch
  refines it, so the summary can no longer disagree with the table under it. Note the two feeds
  differ on purpose: the per-rig `online` needs an accepted share (audit §J6-9), the account
  flag flips at login — a rig that just connected reads Offline until its first share lands.
- **Worker name is now what the miner typed:** `<address>.donate10` logged in as worker
  **default** — `validateUsername` stripped the `donateN` token from the label, and with nothing
  left the stand-in name applied. Nothing on screen said why, so it read as a bug. Nothing
  depended on the strip (the % travels as `parsed.donation_percent` → session → applied on the
  first accepted share; the name only groups shares), so the token is now READ and never cut:
  `.donate10` → worker `donate10`, `.rig01-donate10` → `rig01-donate10`. The literal name is
  also the one place a rig's donation is visible, which is what audit §J3-5 asked for. A name
  over the visible cap that carries a token is cut on its label part so the token stays on screen
  (the cap was 25 here, so `rig-name-that-is-long-enough-donate100` → `rig-name-that-i-donate100`,
  still 100 %; it is 32 since the Part 1 note below, which also strips the cut's trailing separator).
  Public copy on `donate.html` updated; `scripts/test-stratum-guards.js` +5 cases (59/59).

Verified locally: `node --check` on `miners.js`, `stratum-protocol.js` and the extracted inline
script; stub-DB run of two sessions on one address (close one → flag untouched, close last → 0;
prune → 0); stub-DOM run of `renderOnlineState` for 1/1, 0/1, 2/2, 1/3, 0/4; guard suite 59/59.

**Donor wall (`/api/pool/donors`, `donate.html` D-03) — same day.** Three findings from the
live-miner test, all fixed:
- `totals` were summed **after** `LIMIT 100`, so "Donors" / "Donated all-time" undercounted from
  the 101st donor on. The LIMIT moved out of the SQL (the `ORDER BY` already forces the full
  aggregate) and the cards are sliced in JS; `totals` now cover every donor.
- `active_donors` counted cards with a debit, and a donation is debited only when a block
  **matures** — a young pool reported "0 currently donating" for days with tags set. It now
  counts `miner_incentives.donation_percent > 0` directly, and the empty wall says "N miners have
  a donate tag set — the first slice is taken when the pool's next block matures".
- Both `current_percent` and `active_donors` are gated on `donationsActive()` (the predicate
  `/api/account/:addr` already used), so a pool with donations switched off shows every card
  `paused` rather than advertising cuts it is not taking.
- Copy: D-01 gained the "raise = go through `donate0` first" row (§J6-7 only lowers directly),
  and the account page's donation-row tooltip says the same. No age-out: past donors stay on
  the wall with `paused` — deliberate, a thank-you is not revoked when the giving stops.
  *(Superseded the same day by Part 4 below: the wall is a windowed league now, and a donor with
  nothing in the window moves to the capped "past donors" strip — still never deleted.)*
Verified with an in-memory stub of the three ledger tables (102 donors → 100 cards, count 102,
Σ exact; 5 live tags incl. 2 with no debit; donations off → 0 active, all badges 0).

**Part 1 (login grammar) — design §16, 2026-09-21, NOT VPS-tested.** The first of six
sessions for the donor names + league (design §16; per-session plan kept outside the repo).
`validateUsername` in `lib/stratum-protocol.js` only:
- **Worker part case-folded** — everything after the first `.` has ASCII `A-Z` folded before the
  grammar runs, so `MyBrand-donate10` logs in as worker `mybrand-donate10` at 10 % (it was refused
  at login). The address is never folded: `GRIN1…` and any mixed-case address still return null.
  ASCII-only on purpose — `toLowerCase()` maps U+212A KELVIN SIGN into the charset as `k`.
- **Limits** `MAX_WORKER_NAME_LEN` 25 → **32**, `MAX_WORKER_RAW_LEN` 40 → **48** (a 27-char brand
  clipped to `northern-hashwo-donate10`). The cut rule is unchanged — cut the label, keep the token,
  so ≥ 22 label chars survive beside `-donate100` — but the cut label now loses any trailing `-`/`_`:
  `rig-name-that-is-long-enough-donate100` → `rig-name-that-is-long-donate100`, never
  `…long--donate100`. An uncut label is byte-faithful (a typed `acme--donate10` keeps `acme-`).
- **Fourth return field `donor_label`** — `null` with no live token (a plain name, including an
  out-of-range `donate101`); `''` when the token is the whole name (`donate10` → masked address on
  the wall); else the label part **after** the cut, lowercase, which Part 2 stores as the donor name.
  The existing three fields are unchanged and stay first. `stratum-server.js` reads the result by
  field name, so nothing else moved.
- **Copy stating the old limit** fixed in place: the login error line (`stratum-server.js`, now
  "auto-shortens to 32 chars; keep it within 48"), the getting-started step on `index.html` (also
  no longer says "lowercase" as a requirement — it is applied), and five statements in the
  security audit (§J6-1, §J6-9, §J6-13, Handoffs). `donate.html` D-01 is Part 4's.
- **Tests** `scripts/test-stratum-guards.js` 61 → **71/71**: the cut expectation updated; +10 —
  uppercase worker folds, uppercase / mixed-case address refused (with and without a worker; the
  case-fold must not leak into the address), 32-char name kept whole (plain and 22 + token),
  33-char cut (both), 48 accepted / 49 refused, `_` and multi-separator strip, the three
  `donor_label` values, and the return shape (exactly four keys, existing three first).

Verified locally: `node --check` on `stratum-protocol.js`, `stratum-server.js` and the test
script; guard suite 71/71; no server started, no file left in the repo.

**Part 2 (storage + capture + the miner's own view) — design §16.3/§16.4/§16.9, 2026-09-21,
NOT VPS-tested.** Names are now captured and stored, and shown ONLY to their owner on the
account page — nothing public reads them until Part 3's moderation exists (plan ordering, not a
preference).
- **Columns** — the six `donor_*` columns from §16.3 on `miner_incentives`, in the CREATE for a
  fresh DB and via `migrateMinerIncentives()` (same add-column-if-missing pattern as
  `miner_accounts`) for an existing one; idempotent, runs on every boot.
- **`lib/donor-names.js` (new)** — the whole name model, `db` passed in, no dependency on
  `index.js` or `pool-settings.js` (the latter imports the starter list from it): `normalise`
  (lowercase, strip `-`/`_`, leet `0→o 1→i 3→e 4→a 5→s 7→t`), fixed `RESERVED` (the ten §16.4
  words + the pool name, which is applied only when it normalises to ≥ 3 chars — a two-letter
  pool name would censor everyone), `STARTER_BLOCKLIST` (51 entries, the DEFAULT of the setting),
  `matchBlocklist` (reserved first, then the operator list split on newlines — never a RegExp;
  returns the entry as typed for the admin badge), `captureDonorName` (§16.4 exactly: `''` clears,
  `admin` sticky, `allow` override, else `auto` + word or NULL; `donor_name_set_at` on every call;
  a clear also drops an `auto` verdict since it was about the name that is gone, while `admin` /
  `allow` survive as per-address decisions), `rescanAll` (walks `donor_name IS NOT NULL` rows that
  are NULL/`auto` — bounded by names, never shares; returns `scanned`, `censored` = rows in `auto`
  AFTER the scan, `cleared` = `auto` rows the new list no longer matches; re-stamps `censor_at`
  only on a change), `displayState` (the ONE function both the account API and Part 4's wall
  call — `shown | masked | censored | expired`, `name` null for everything but `shown` unless
  censored + `marker`), and `donorSettings` — the bounded reader every consumer goes through.
- **Two deltas from §16 worth knowing.** (1) Expiry counts from the LATER of the last donation
  debit and the capture itself, in calendar months (UTC): a name just set through the ceremony is
  not instantly "expired" while its first debit is still a block away, and a returning donor who
  re-runs the ceremony is fresh again. (2) Censor outranks expiry — a censored name that also
  aged out still reports `censored` (and the marker, if chosen).
- **Settings** — six keys on the `incentives` section with write-side validators (list cleaned to
  one trimmed entry per line, ≤ 64 KB / 4000 entries; display a closed enum; ints/percent/cap
  bounded) AND `donorSettings()` re-bounding every value on read (a hand-edited row, a blank or
  `"abc"` → the default, never NaN). No new booleans. `donation_address` and
  `allow_miner_donations` stay where they are; Part 3 moves them.
- **Capture site** — `stratum-server.js` parks `donor_label` on the session at login beside the
  percent; the donation-apply block moved verbatim into `_applyParkedDonation(session)` (one
  call site, same PROOF_MIN_SHARES gate at it) so the test can drive the real branch; the name
  write is `wrote && current === 0 && percent > 0` and nothing else — a LOWER, a same-value
  resend, a refused raise, a `donate0`, or a set that `setDonation` refused (donations off) never
  reach it. `_captureDonorName` reads the list + pool name fresh per capture (once per ceremony,
  never per share) and logs one line: masked address, name, censor state — never the password
  or IP.
- **`lib/donor-ledger.js` (new)** — `lastDonatedAt(db, address, H)`, the single-address form of
  the composite rollup + raw read `/api/pool/donors` uses. One home for the ledger SQL so Part 3/4
  extend it rather than fork it; no column was added for the date.
- **`/api/account/:addr`** gains `donor_name` + `donor_name_state`, behind the same
  `donationsActive()` gate as `donation_percent` (both null on a dormant pool), through
  `displayState`. `API_DOC_META` row updated. The account page's donation row now also stays
  visible for a PAUSED donor who has a name (`paused (0%)`), with a second line: *Donor name:
  acme* / *hidden by the pool — contact the operator if this is a mistake* / *expired —
  reconnect with your tag to refresh it*; `textContent`, never innerHTML; tooltip explains the
  rename ceremony. `masked` and null print nothing extra.
- **Tests** `scripts/test-donor-names.js` (new, in-memory copy of the REAL schema via
  `initDb(':memory:')`, in `npm run test:unit`): **100/100** — migration twice, normalise/leet,
  reserved (incl. pool name and its 3-char floor), list (CRLF, order, regex-special text never
  throws), the `classic ⊃ ass` false positive documented as EXPECTED, capture in every censor
  state, `''` clear semantics, rescan counts + idempotence + empty list, displayState for all four
  states × both display modes + the exact calendar boundary, bounded readers with junk input,
  validators + a store round trip, the composite ledger read across the horizon, and the stratum
  gate with a stub incentives manager (eight arms incl. the full ceremony) plus the real capture
  path with its log line. Guard suite unchanged at 71/71; admin-panel 41, public-leakage 58,
  admin-guards 65, money-path 32 all green; `check-syntax` 64 files + 29 inline blocks.

Verified locally, one-shot only (no server): `node --check` on every touched file, the suites
above, and the account page's donation-row branch driven against a stub DOM for all six states.
`git status --short` shows the three new files and nothing else untracked.

**Part 3 (admin: routes, audit, rescan, `donors.html`, settings move, dashboard count) — design
§16.5/§16.8, 2026-09-21, NOT VPS-tested.** The operator's moderation surface. Nothing public
changed: `/api/pool/donors` and `donate.html` are untouched (Part 4), and the guard suite now
pins that the public route still masks and emits no censor word/by.
- **`GET /api/admin/donors` (secureAdmin)** — one row per address that has a ledger debit, a
  live tag, **or a stored name** (a widening of §16.8's two: a miner who ran the ceremony and
  paused before the first matured block has a name on file and no debit, and moderation that
  starts after publication is the review gate §16.1 #3 rejected). FULL addresses. Per row:
  name + the six `donor_*` columns, `current_percent` (0 when donations are switched off — the
  same gate as the wall), `lifetime_donated`, `in_window_donated`, `active_months`, first/last,
  `donation_count`, `multiplier`, `score`, `rank` (league order; null with nothing in the window),
  `is_new` (captured ≤ 7 d), `renamed_while_censored` (`admin` and `set_at > censor_at`), and
  `workers` from `getWorkersForAccount(addr, 1440)` — `{name, online, tagged}`, `tagged` via
  the new `parseDonateToken()` export of `lib/stratum-protocol.js` (the login regex became a
  named constant both use; `validateUsername` is byte-for-byte the same, guard suite 71/71).
  Envelope: `count`, `window_days`, `donations_active`, `new_names_7d`, `now`; `?limit` ≤ 500.
  Cost: ONE composite ledger scan (the same UNION `/api/pool/donors` has always run) + a small
  `miner_incentives` read + per-returned-row indexed worker lookups on a table pruned to ~31 h.
- **`lib/donor-ledger.js`** grew the per-address aggregate `donorLedger(db, {H, windowDays,
  now})` (lifetime, in-window, first/last, count, **active months = `COUNT(DISTINCT
  strftime('%Y-%m', t))`** over rollup + raw) and the §16.6 helpers `loyaltyMultiplier`,
  `donorScore`, `leagueOrder` — Part 4's league imports these, so the admin list and the wall
  cannot rank differently. **Window boundary, stated once in the lib:** a rolled day is one row
  at its UTC midnight and is in the window WHOLE when that midnight is ≥ the cutoff (a 23:59
  debit on a rolled day counts by its day); raw rows compare at second precision.
- **`POST /api/admin/donors/:addr/censor` and `/uncensor` (freshAdmin)** — `:addr` through
  `GRIN_ADDR_RE` (400), then `lib/donor-names.js adminCensor()`, which is the state machine, the
  write and the `admin_audit_log` row (`donor_censor` / `donor_uncensor`, target_type `donor`,
  details `{name, previous}`, ip) in ONE transaction — fail-closed like `updateSection`. 404
  unknown address, 409 already in that state. Table: NULL/auto/allow → censor → `admin`;
  NULL/auto/admin → uncensor → `allow` (never NULL — NULL would re-arm the auto-list). A censor
  on an address with no name yet is allowed (pre-emptive, sticky); an un-censor from NULL is
  allowed (pre-emptive whitelist). The word is cleared on either — it described an auto verdict.
- **Rescan hook** in `POST /api/admin/settings/:section`: reads the list + pool name BEFORE the
  write and, when either CHANGED (not merely present — the harvester posts every key), runs
  `rescanAll` and returns `rescan: {scanned, censored, cleared}` on the response; a rescan
  failure is reported in that field and never fails a save that already landed. Renaming the
  pool triggers it too, because the pool name is a reserved word (§16.4 #2).
- **Dashboard** `new_donor_names_7d` (`countNewNames`: `donor_name IS NOT NULL AND set_at ≥
  now − 7 d`, so a cleared name is not "new") on `/api/admin/dashboard` → a sixth Overview tile
  linking to Donors; **`GET /api/admin/donors/summary`** (one COUNT) feeds the nav badge that
  `admin-shell.js decorateDonorBadge()` paints on the Donors row on every page load — painted
  only for a positive number, so a 429 body can never render "undefined". Pill ink is
  `var(--btn-text)`, the admin bundle's ink-on-accent token (`--bg` does not exist there).
- **`admin-panel/donors.html` (new)** — NAV child of Dashboard directly after Miners. Same
  shell as `miners.html` (auth gate, AdminTable with search + paging, `setRows` keeping page +
  query on the 60 s timer, `reset` only from the state select: all / named / censored / new).
  Columns per §16.8 with medals for the top 3, the state badges (`ok` · `auto: "word"` ·
  `admin-censored` · `allowed` · `NEW` · `renamed while censored`), workers as LED + name with
  the tagged rig marked 🏷 (6 shown, "+N more"), and `.btn-icon` row actions (🚫 censor / ✅
  allow, shown per state) passing the address via `data-addr`. Every name/word/worker name goes
  through `escHtml`. A non-2xx body from `API.get` renders as an ERROR row, never as "no
  donors". **Donation settings** on the same page: `allow_miner_donations` + `donation_address`
  (MOVED here — `settings-incentives.html` keeps one line linking to Donors; the moved keys exist
  on exactly one page, pinned by test), then the six donor keys with helpers, the list as a
  monospace textarea. The form is PAGE-LOCAL, not `settings-common.js`: `saveSection()` discards
  the response body and the one thing this form must show is the rescan counts. Its harvester
  follows the same three rules (bind by id; `settings-skip`; blank scalars dropped unless
  `settings-allow-empty` — `donation_address` carries it so "leave blank" persists). No merge
  step was needed: `updateSection()` upserts only the keys it is sent, so the partial form and
  the Incentives page never clobber each other. Both flash targets hide INLINE (the 2026-09-19
  rule). Writes go through `adminFetch` — `Auth.fetch` would surface a freshAdmin challenge with
  no way to complete it; a plain session on this page is the normal case.
- **Tests** — `test-donor-names.js` 100 → **148/148** (+ token parser, ledger aggregate with the
  exact day-edge in/out, window 0, junk window, below-horizon raw invisible, score/multiplier/cap
  incl. NaN/Infinity in, league order, the full censor table with audit rows, fail-closed
  rollback via a bad admin FK, new-names count at the 7-day edge); `test-admin-panel.js` 41 →
  **71/71** (page exists, NAV position, id sweep against the LIVE `PoolSettings.defaults`, moved
  keys on exactly one page, inline-hidden flash targets, `this.dataset` row buttons, adminFetch
  not Auth.read, error-vs-empty, escaping, rescan flash, the Overview tile; the sweep was
  negative-controlled with a stray hidden id); `test-admin-guards.js` 65 → **79/79** (guard tier
  per route read from the declaration — control: ban=fresh, miners=secure — address gate,
  delegation to `adminCensor`, 404/409, the rescan hook's before/after shape, public route
  unchanged, dashboard field). All 14 suites green; `npm test` exit 0.
- **A pre-existing gate bug fixed on the way — `scripts/check-syntax.js`.** Its `type=` sniff ran
  over the WHOLE `<script>` match, body included, so any inline block whose row template contains
  `type="button"` read as `type=button` → "not JavaScript" → skipped. `donors.html`, `miners.html`
  and the admin `index.html` were never syntax-checked, and a deliberately broken `donors.html`
  passed `npm run check-syntax` with "Syntax OK". Now sniffs the opening tag's attributes only:
  29 → **32** inline blocks; the negative control fails with the file named.

Verified locally, one-shot only (no server): `node --check` on every touched file; the suites
above; the page's inline script driven through a stub DOM (28 checks: hostile names/words/worker
names escaped, actions per state, filters, timer vs reset, 429-as-error, harvester rules, save +
rescan flash, refusal reasons, populate); the real `GET /api/admin/donors`, censor/uncensor,
dashboard and settings-save handlers extracted from `index.js` and run against the in-memory
schema (21 checks incl. the rescan hook firing on a list change, NOT on an unchanged list, on an
empty list, and on a pool rename). `git status --short` shows `donors.html` + Part 2's three
files and nothing else untracked.

**Part 4 (public: `/api/pool/donors` v2, D-03 league + past strip, copy, api-docs, leakage
tests) — design §16.6/§16.7/§16.9, 2026-09-21, NOT VPS-tested.** The part that makes names
visible. The admin page and the capture rule are untouched.
- **`lib/donor-ledger.js donorWall(db, {ds, now, H, active, rigsOnline, mask})`** builds the
  whole response — in the lib, not the route, because `index.js` starts a server on require and
  a route can only ever be read as text; `scripts/test-donor-league.js` runs the builder against
  the in-memory schema. Shape: `{ league: [card…], past: { donors: [card…], more }, totals,
  ranking: { window_days, loyalty_percent_per_month, loyalty_cap, name_expiry_months },
  censored_display }`. Card: `rank` (1..N, null on past) · `name` · `name_state` · `address`
  (masked) · `in_window_donated` · `total_donated` · `active_months` · `multiplier` · `score` ·
  `current_percent` · `first/last_donated_at` · `donation_count` · `rigs_online`. League =
  in-window > 0, `leagueOrder`, LIMIT 100; past = nothing in the window, most recent last
  donation first (ties: lifetime DESC, address ASC — rolled days tie by the day), LIMIT 20 +
  `more`; the two are disjoint by construction. `totals` stay lifetime over every donor; a
  donor beyond the 100th league place is on neither list but is counted (design as written).
  **The mask is a REQUIRED argument and the lib throws without one** — a wall with no mask is
  §J11-1, and `past` is exactly the second array a route would forget. Names through the SAME
  `displayState` the account API uses; no card key starts with `donor_`. Settings through
  `donorSettings()` (bounded), with a fallback to defaults when no `ds` is passed, so a blank
  or `"Infinity"` setting can never reach a multiplier (memory
  `reference_money_number_boundary_traps`). Cost: the one composite ledger scan the route has
  always run, one COUNT for `active_donors`, one IN-list read of `miner_incentives` for the
  ≤ 120 cards shown.
- **Route** — thin: reads `donationsActive()`, `donorSettings`, builds `rigs_online` in ONE
  pass over `minerManager.getActiveSessions()` (MINING sessions only, `acceptedShares > 0`,
  §J6-9 — a login is unauthenticated, so without the share bar anyone could put rigs on
  someone else's card; distinct worker names, never a shares query per card) and passes
  `mask: (a) => maskAddr(a)`. Same `public` bucket; still `raw` shape.
- **`donate.html`** — D-01: `grin1…address.donate10` now says the wall shows the masked
  address; the `rig01-donate5` row became `grin1…address.yourbrandname-donate10` with the
  donor-name sentence (lowercase, up to 32 characters; plain `donate10` = masked address); the
  panel note gained "to change your donor name, use the same ceremony as a raise" and that a
  plain `donate10` at that step removes the name. D-03 is "Donor league": a ranking sentence
  (`#donor-ranking`) rewritten from `ranking` — "in the last N days" / "all-time" for 0 — with
  a window-agnostic static fallback so a failed fetch never states a wrong number; cards per
  §16.7 (medal or `#N`, display name, GRIN in window with "in window" only when a window is
  set, lifetime only when it differs, `×1.4 loyalty · 4 months`, `donating N%` / `paused`,
  `since <day> · N rigs online`); a **past-donors strip** (`#donor-past`: name/masked +
  lifetime + last day, then "and N more past donors"); "Names are chosen by the donors and are
  not verified by the pool." at the foot of the panel; "(all times UTC)" stays once in the
  deck-head. Three empty states: no donors (tags-set message kept), donors but an empty
  window ("NO DONATIONS IN THE RANKING WINDOW YET — past donors below"), and unavailable.
  **Every name goes through `escHtml`** — the marker `<censored-donor>` contains angle
  brackets and must display literally. The read stays the page's own 2xx-only `fetch`
  (`r.ok ? r.json() : null`, the `Auth.read` contract — `auth.js` is not loaded on this page
  and `Auth.fetch` is never used). Names `word-break: break-all`; the first line of a card
  clears the absolute rank badge (`padding-right: 44px`).
- **api-docs** — the `GET /api/pool/donors` meta row rewritten for the v2 shape (league/past/
  totals/ranking, score formula, opt-in lowercase name, masked addresses, the marker only under
  `marker`, window edge). §1b drift check: 49 routes / 49 meta / 0 / 0; row hand-read against
  `donorWall()`.
- **Tests** — `scripts/test-donor-league.js` (new, in-memory, **68/68**): mask required; 102
  donors → league 100, totals 102, Σ exact, ranks 1..100; window 365 drops a 400-day donor to
  past with lifetime intact and window 0 brings it back with in_window == lifetime; the exact
  day-edge in/out; active months across rollup + raw (3), multiplier ×1.3, cap ×3 at 30 months
  and a lower cap honoured, 0 % loyalty; tie order (months DESC, first ASC); past cap 20 + more
  5, order, same-day tie-break; league/past disjoint; empty league + past; all name states in
  both display modes, expiry incl. 0 = never; leakage sweep (no `donor_censor*` /
  `donor_name_set_at` / `grin_address` key, no full address string, no censor word, no marker
  under masked); the switch gating; `rigs_online` from Map/function, NaN → 0, never ranked;
  junk/blank/Infinity settings → defaults and finite scores, JSON round trip with no
  null-from-Infinity. `scripts/test-public-leakage.js` 59 → **77/77** with §9: the route
  delegates with the mask and reads no donor column itself; the lib's card builder has no
  `donor_` key and masks via `opts.mask` only; neither `index.js` (outside the api-docs row) nor
  the ledger lib spells the marker — `displayState` is the one emitter (exactly 3 mentions in
  `donor-names.js`); `/api/account/:addr` selects three donor columns and emits two fields;
  live `displayState` checks (masked → null, marker → the string, unknown value → masked, marker
  never touches shown/masked/expired, never a `donor_` key). `test-admin-guards.js`'s Part 3 pin
  on the old inline `r.address = maskAddr(r.address)` updated to the v2 form (79/79); added to
  `npm run test:unit`. 15 suites green; `check-syntax.js` 65 files + 32 inline blocks.
- **Delta vs §16:** none in substance. Two things the design left implicit are now stated:
  the past strip's tie-break, and that a league overflow (>100 in the window) is counted in
  `totals` but shown on neither list.

Verified locally, one-shot only: `node --check` on every touched file; the suites above; the
page's inline script `vm.Script`-parsed; the **390 px iframe probe** (a throwaway Node static
server on 127.0.0.1 with stubbed `/api/*`, Chrome headless `--dump-dom`, killed in-session) on
three fixtures — full league with a 31- and a 32-char name, the marker, a 100 % badge, and a
past strip with `more` 14; past-only with an all-time window; no donors with 2 tags set —
`docWidth` 375 (= 390 − scrollbar), **0 elements past the right edge**, every state's copy
rendered as designed. `git status --short` shows `test-donor-league.js` and the Part 2/3 files
untracked and nothing else.

**Part 5 (independent review of Parts 1–4) — design §16 + §16.10, 2026-09-21, NOT VPS-tested.**
A separate cold session read the working-tree diff against §16 in the plan's nine-question order
(stranger write trace, public leakage field list, censor state table, a hand-recomputed card,
type traps, DB cost by `EXPLAIN QUERY PLAN`, panel rules, public-page rules, docs honesty). The
questions, their answers and the deltas table are **design §16.12** — the durable record; this
note is what changed in the tree.
- **Fix A (Medium) — `lib/donor-names.js rescanAll`** parsed the operator's list once per
  NAME: `matchBlocklist(name, listText, …)` re-ran `parseList` (normalising every entry) on
  every row. Measured 300 names × the 4000-entry validator ceiling = **1048 ms** per list save
  on the synchronous connection the stratum server shares — a one-second share-intake stall,
  admin-triggered. The matcher is now two layers: `matchEntries(name, entries, poolEntry)` over a
  pre-parsed list, with `matchBlocklist` the one-name convenience over it; the walk parses once
  (**16 ms**). `poolNameEntry` and `matchEntries` are exported for the test.
- **Fix B (Low) — `captureDonorName`**: a separators-only label (`--donate10` arrives as `-`,
  `_-_-donate10` as `_-_` — inside the grammar, so Part 1 hands it over as typed) passed
  `LABEL_RE`, normalised to `''`, matched nothing and was stored and shown as the name `-`. It is
  now no label (clears, like `''`); `-a-` and a lone leet digit are still names.
- **Tests** `scripts/test-donor-names.js` 148 → **156/156**: four label cases for B; for A an
  equivalence check (`matchEntries(parsed) ≡ matchBlocklist(text)` over six names incl. a
  reserved word, the pool name and a list entry), a source pin that `rescanAll` calls
  `parseList` exactly once above its row loop and the loop uses `matchEntries`, the 4000-entry
  list giving the same verdicts, and a 2 s ceiling on that walk. Every other suite unchanged; all
  16 (15 scripts + `check-syntax`) green after the fixes.
- **Docs** — design §16 heading and file header no longer say "NOT built" / "Parts 3–6 design
  only"; §16.11 Part 5 row; §16.12 added; security audit header + Status roll-up now name Parts
  2–4's new surface and that §16.12 is its only review so far; memory `project_pool_incentives`.
- **Not re-run here:** Part 4's 390 px iframe probe (documented method and fixtures above);
  nothing on a VPS.

Verified locally, one-shot only: `node --check` on the two touched files, the 16 suites, the
scratch recompute script (scratchpad, deleted). `git status --short` shows the same five
untracked files as Part 4 and nothing else.

---

### 10.4 Ownership-proof SET — backend (2026-09-22, add-ons — NOT VPS-tested)

Design contract: [`script07_design.md`](script07_design.md) §17. This is **Part 1 of five**
(backend); the account page is Part 2, the copy sweep Part 3, an independent review Part 4 and
VPS acceptance Part 5. §17.6 carries each part's state.

Replaces the **2-slot proof window** that had gated every self-service money action since
2026-07-17 (§10, audit §E/§F/§J3). The window compared a capture against its newer slot only, so
two facilities whose rigs reconnected in turn rotated it on every reconnect — re-stamping the age
the §J3-1 destination gate reads and lighting an "evidence changed" warning for honest churn.
The page's "use the same password on every rig" was a workaround for the slot count.

**Schema** (`lib/db.js`) — one new table and one new column, no `DROP COLUMN`:

```sql
CREATE TABLE IF NOT EXISTS miner_proofs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grin_address  TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('ip','pass')),
  hash          TEXT NOT NULL,            -- 'v2$<b64>' or a carried-over 'v1$<salt>$<b64>'
  first_seen_at INTEGER DEFAULT NULL,     -- NEVER updated; NULL = migrated unknown = OLD
  last_seen_at  INTEGER NOT NULL,         -- refreshed on every match; the LRU key
  is_anchor     INTEGER NOT NULL DEFAULT 0,
  evicted_at    INTEGER DEFAULT NULL,     -- NULL = live; only an anchor is ever non-live
  UNIQUE (grin_address, kind, hash)
);
CREATE INDEX IF NOT EXISTS idx_miner_proofs_lru
  ON miner_proofs (grin_address, kind, evicted_at, last_seen_at);
-- miner_accounts + proof_salt TEXT DEFAULT NULL
```

The ten legacy columns (`last_ip`/`prev_ip`/`anchor_ip`, `last_pass_hash`/`prev_pass_hash`/
`anchor_pass_hash`, the four `*_at`) stay in the schema and are **read by exactly one function**,
the migration below. A grep for them across `web/07_mining_pool_public/` returns `lib/db.js`'s
schema and `lib/owner-proof.js`'s migration and nothing else.

**Capture / verify** (`lib/owner-proof.js`). `PROOF_SET_MAX = 10` live rows per (address, kind),
a module constant and deliberately not a setting. Per kind a capture does exactly one of:

| state | action | audit |
|---|---|---|
| value is already a LIVE row | `last_seen_at = now`. **`first_seen_at` never moves.** | none |
| the live set is EMPTY | insert; the row becomes the anchor | none |
| anything else (new value, or the evicted anchor returning) | needs `mayDisplace`; evicts LRU live rows first | `evidence_added` `{kind, live_after, evicted}` |

`evidence_displaced` is retired. Eviction is least-recently-**seen**, and an **anchor row is
flagged `evicted_at`, never deleted** — the one `DELETE FROM miner_proofs` in the codebase sits
behind `if (r.is_anchor) … else DELETE`.

`verifyOwnerProof` keeps its signature and every reason string; `slot` is now `'set' | 'anchor'`,
and **`'anchor'` only for an EVICTED anchor row** — a live anchor is an ordinary member, so an
actively-mining owner is not barred from the destination gate. `age_seconds` comes from
`first_seen_at`. **`requireBothProofs` in `index.js` is unchanged** (no diff hunk in its region);
because `first_seen_at` is write-once, the §J3-1 AND+AGE gate is strictly stronger than before —
the rotation that used to reset a leg's age no longer exists.

**One salt per ADDRESS** (`miner_accounts.proof_salt`, 16 random bytes, base64), minted by
`getOrCreateSalt` with `UPDATE … WHERE proof_salt IS NULL` **then a re-read** — two rigs' first
shares landing together must agree on one salt, so the function never returns the value it just
generated. Rows are `v2$<hashB64>`; scrypt parameters unchanged (N=16384, r=8, p=1, 32-byte key,
16 MB). Digests compare with `crypto.timingSafeEqual`.

*Measured KDF cost per verify* (asserted by wrapping `crypto.scrypt`, not reasoned about — audit
§F2 sizes the per-IP throttle against this): **1** call on a v2-only set of any size, success or
failure; **1 + n_v1** once the account has a salt and still holds legacy rows; **n_v1** while it
has no salt at all. The old code cost up to 6. One digest serves BOTH kinds, memoised per
distinct spelling, which is what keeps a single submission at one call.

**Migration** — `migrateProofSet(db)`, synchronous, called where `backfillProofAnchors` was, ahead
of the stratum listener (an account reaching its first post-upgrade capture with an empty set
would anchor to whoever mined that share). `migrateOwnerProofHashes` and `backfillProofAnchors`
are **deleted**; their jobs are subsumed. Mapping: the anchor becomes an `is_anchor=1` row, live
when its stored string equals `last` or `prev` and otherwise `evicted_at = anchor_set_at`; `last`
and `prev` become live rows carrying their own `*_at` as `first_seen_at`. Rows insert anchor →
prev → last so `id` — the LRU tiebreaker when timestamps are unknown — runs oldest to newest. A
pre-v1 plaintext value is hashed with `scryptSync` **outside** the transaction.

*Idempotency proof, stated because there is no marker table (repo style):* the migration NULLs
all ten columns for every account it copied, and its `SELECT` is `WHERE <any legacy value> IS NOT
NULL`. A second run therefore selects zero rows, returns 0 and logs nothing. Asserted both ways —
the columns are NULL afterwards, and a second call inserts nothing.

**API shape.** `GET /api/account/:addr` drops the `evidence` object and gains
`proofs: { ip, pass, max, anchor, last_added_at }` — live counts per kind, the cap, whether an
anchor row exists at all, and the newest `first_seen_at` across both kinds.
`has_recorded_ip` / `has_recorded_pass` are derived from the counts (each includes its kind's
anchor, evicted or not, because an evicted anchor still verifies). `GET /api/admin/miners/:addr`
gains `proofs.{ip,pass} = { live, oldest_first_seen, newest_last_seen, anchor_live }`. **No
response body, anywhere, carries a proof value, a digest, `proof_salt` or a per-row capture
time** — `test-public-leakage.js` asserts that on both routes, on `index.js` as a whole, and on
every `console.*` line in `owner-proof.js`.

Observed live against the real `lib/db.js` schema (one-shot script, temp DB deleted): 3 IPs +
2 passwords → `{ip:3, pass:2, max:10, anchor:true, last_added_at:…}`; past the cap → `{ip:10, …}`
with the admin view reporting `anchor_live:0` for the evicted IP anchor while `proofs.anchor`
stays true; a never-mined account → all zeros, `anchor:false`, `last_added_at:null`.

**Tests** — `scripts/test-owner-gate.js` **19 → 36**, `scripts/test-public-leakage.js` **77 → 86**;
suite total **849 → 875 across 15 suites, all passing** (`npm test`, which also runs
`check-syntax`). Its `freshDb()` now builds the DB through `lib/sqlite-compat.js` rather than a
bare `node:sqlite` `DatabaseSync`: the bare one has no `.transaction()`, so a migration opening one
threw in the test and worked in production — the wrong way round for a test to be wrong. New
coverage: LRU eviction order; an anchor flagged not deleted, still verifying, still refused by the
destination gate, and refused outright under `allowAnchor:false`; re-activating an evicted anchor
gated by `mayDisplace` and not breaking the cap; three sites surviving six reconnects with
`first_seen_at` unmoved and **no audit row for a refresh**; one share creating but not adding;
the migration's mapping, column clearing and no-op second run; a v1 row verifying and being
rewritten as v2 in place; two concurrent first captures landing on ONE salt and ONE anchor; the
KDF-cost table above; and every reason string `index.js` maps.

**Not changed:** `PROOF_MIN_SHARES`, the (address, origin) lockout and its counters,
`pass_proof_state`, `getPasswordConsistency` (still live-session-based, still guarded on
`session.acceptedShares`), the withdraw/export rate buckets, `requireBothProofs`.

**Deltas from §17**, all additive:
- §17.4 asks `test-public-leakage.js` to assert the `proofs` shape and the absence of
  `proof_salt`; the Part-1 file list in the run plan did not name that file. Added here — it is
  an API-shape assertion and Parts 2/3 do not touch it.
- `_makeRoom` takes a `headroom` argument (1 for an insert, 0 for the migration's defensive
  trim). Evicting `live − max + 1` when nothing is being inserted would throw away a working
  proof for nothing.
- `is_anchor` is decided **inside** the INSERT statement via `EXISTS`, not from a snapshot read
  before the KDF. Two first captures racing through scrypt would otherwise each see an empty set
  and each claim the anchor. For the same reason `_captureProof` reads the rows **twice** — once
  to find which v1 hashes need testing, and again after the last `await`, so nothing that decides
  (live count, cap, LRU pick) is read across an await from the write that depends on it.
- `hashProof` (the v1 writer) is exported. Nothing in production writes v1 any more, but the
  regression suite needs to build a legacy row through the same code that parses one.

Verified locally, one-shot only: `node --check` on each changed `.js`, `npm test` (875/875), and
the runtime aggregate script above (scratchpad, temp DB deleted). No server was started.

#### Part 2 — account page (2026-09-22, `public_html/account-settings.html` only)

Renders what Part 1 returns. One file, no backend change, no new test.

- **On-record hint** — `proofHintText(a)`, a new function beside `renderPasswordProof`, replaces
  the two-boolean sentence with counts off `a.proofs`: *"On record for this address: 3 mining IPs
  and 2 rig passwords (up to 10 of each) · last added 2026-09-20 13:21"*. Singular/plural on both
  nouns; one count at zero names only the other kind and drops *"of each"*; `last_added_at` null
  drops the clause. Time via the page's `fmtWhen` (UTC, suffix-free — the deck head states it once).
- **Three branches, on purpose.** Counts when `proofs` is present; the old whether-not-how-many
  sentence when it is **absent** (an older backend or a cached response — a count the server did
  not send is not a fact about the account, and rendering 0 would read as "nothing recorded"); and
  a distinct line when both live counts are 0 but the write-once original survives, since that
  account *can* still reach its wallet and "No proof recorded yet" would be a lie to the one miner
  who most needs to know. That third state is reachable through the migration — an account whose
  `anchor_*` was set with both window slots empty lands as one evicted anchor row and no live row.
- **"Evidence changed" banner deleted** (design §17.2 #8), and the `evidence` argument with it —
  `renderPasswordProof(pp, proofs)` now takes the counts, because the cap is what its remaining
  warning is measured against. Neither fact is lost: *last added* is in the hint, and the "someone
  else mined to this address" explanation moved into the *Why does my rig password matter?* fold.
- **Password diagnostics.** `PASS_STATE_TEXT.ok` → **"Password recorded — this rig's password is
  on record and will work as proof."**; every reject state (too short / too long / too common /
  charset / invalid) keeps its text, they are real diagnostics. The live-session lines: the old
  **Mismatch** fired at *two* distinct passwords and told everyone to run one password everywhere
  — it is now **"Too many passwords"** and fires only past `proofs.max`; two or more within the cap
  is an OK **"On record"** line. *None usable* and *Partial* keep their logic.
- **`max === 0` means "the backend did not send a cap", never "zero allowed."** Both branches that
  depend on it fail quiet: no over-cap warning, and the multi-password line drops its *"both are on
  record"* verdict for a claim-free reading — the build that sends no cap is the 2-slot one, where
  that promise would be false.
- **Static copy.** The *Accepted:* line under the input ("any IP your rigs have recently submitted
  shares from … the pool keeps up to 10 of each"), and the fold: a new *What the pool keeps*
  paragraph (10 of each; a reconnect from a known IP refreshes it and does not restart the
  destination-change clock; past 10, the least recently used drops off), a new *If a proof appeared
  that you did not add* paragraph (the deleted banner's content), and *Setting one* with the
  same-password rule demoted to a convenience. The *can't be used to steal your coins* and
  *factory defaults* paragraphs are unchanged — both still true.
- **DEMO dataset** now carries `proofs: { ip: 3, pass: 2, max: 10, anchor: true, last_added_at }`
  and `live.distinct: 2`, so the operator's no-API preview renders the shipped shape and shows the
  multi-password case as normal rather than as the warning it used to be. `evidence` is gone.

**Deviation from the run plan**, deliberate: the plan said keep *Partial* as it was, but its
sentence was *"Set the same password on every rig"* — a 2-slot workaround, and §17.5 names
`renderPasswordProof` as copy that must change. It now reads *"Set one on that rig too — it does
not have to match the others."* Logic unchanged. Part 3's grep (`last two|last-2|two most recent|
prev_*`) would not have caught the sentence.

**Numbers in prose.** The fold and the *Accepted:* line spell the cap as a literal **10**;
`PROOF_SET_MAX` is a hardcoded constant by design (§17.2 #1), not a setting, so there is nothing
to interpolate — but if it ever moves, these two strings move with it. The rendered lines
(hint, over-cap warning) all read `proofs.max` from the API.

**Not touched:** every backend file, `public_html/index.html`, the CMS defaults — Part 3 owns
those, and they still state the last-2 window.

Verified locally, one-shot only: `npm run check-syntax` (65 files + 32 inline `<script>` blocks,
which covers this page), `npm test` **875/875 across 15 suites, unchanged** — no suite asserts
this page's copy — and a scratchpad `vm` probe that pulls `proofHintText`/`renderPasswordProof`
straight out of the HTML and runs 22 assertions over all their branches (it caught two real
defects before passing: a fabricated timestamp in a fixture, and the *"on record"* promise on the
no-cap path). No server, no browser. Mobile: no block gained a fixed height — `.pass-diag` is a
wrapping flex column, the fold is `<details>` and ships collapsed — and the longest new uppercase
`<b>` label, **TOO MANY PASSWORDS** (18 ch), is shorter than the shipping
**PASSWORD UNSUPPORTED CHARACTERS** (31 ch), so no new overflow surface. The 390 px iframe probe
needs a browser and was **not** run.

**Owed:** Part 3 (copy sweep — `public_html/index.html`, `lib/pool-settings.js` CMS defaults,
`admin-panel/users.html` still state the last-2 window), Part 4 (independent review), Part 5
(VPS). Nothing here has run outside a local harness.

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
