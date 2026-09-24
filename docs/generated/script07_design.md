# Script 07 — Public Mining Pool (Design)

> **Covers code as of:** 2026-09-23 for §4's effective-latency note, §11's gateway :443 note and §13.13 (hub move + connect-page latency, written against the uncommitted working tree) · 2026-09-07 for the multi-region surface (§2–§7, §11–§12, rewritten against the live code) · 2026-06-08 for the rest of the §6 endpoint table
> **Last verified:** 2026-09-23, PARTIAL — **§13.13's dark-gate / restored-pool bullets and §13.13.6 only, by the Part 9 review session**, read against the code it changed. Also 2026-09-23, PARTIAL — **§13.13 (hub move + latency), by the fold session only**: the names, keys and menu keys it cites grepped in the code (`B → 6/7` dispatch in `07_lib_pool_backup.sh`, the `pmg_*` function list, `probe_host`/`probe_enabled`/`grin-gateway-probe`/`maxconn 2000` in `07_lib_gateway.sh`, `latency_probe_domain`/`latency_hub_url`/the page `connect-src` in the pool script, `SEED_VERSION = 3` and the `_state`/`local_region` stamp in `lib/db.js`, `payout_control.before` in the manifest), the suggest route read in full in `index.js` (privacy + cache claims) and the header + `pickRecommended` of `lib/connect-suggest.js`; `npm test` re-run that session, 1133/1133 across 19 suites. **Taken from the seven build sessions' own reports, not re-checked:** the step order inside Migrate OUT/IN, the harness counts, the nginx/haproxy runtime measurements (incl. the 40-request `limit_req` figure), the Globalping numbers and the downtime estimate. Also 2026-09-23, PARTIAL — **§8's new Tor pre-flight paragraph only**, read against `lib/wallet-tor.js` (`REASONS`, `classifyProbeError`, `probeToronlineStatus`) and the `index.js` withdraw-route gate (null → allow + warn, false → 409, runs before `createWithdrawal`). The rest of §8 was not re-checked. Also 2026-09-23, PARTIAL — **§17 (all of it), by the Part 4 review**: every §17.2 decision and §17.4 threat note read against `lib/owner-proof.js` in full, the `miner_proofs` readers in `index.js` and `lib/db.js`, `requireBothProofs` + every `verifyOwnerProof` call site, the startup order, the two work guards in `lib/stratum-server.js`, `scripts/test-owner-gate.js` and the page's two renderers; KDF counts measured by a scratch harness, not reasoned. Three places were WRONG and are annotated in place (§17.2 #2/#3/#9, §17.4) with §17.7 holding the detail. Earlier the same day: **§17.6's Part 3 entry only**, read against the code that session: `migratePagesFromConfig` in `lib/db.js` (seed-once marker) and the `/restore` route in `index.js`. Before that: 2026-09-07, PARTIAL — **the multi-region surface only**, read against the code: the mode selector + `pool_mode_conflict_check` in `scripts/07_grin_mining_public_pool.sh`, `role`/`region`/`region_ports` in `back-end-pool/lib/config.js`, listener-port region stamping in `lib/stratum-server.js`, `shares.region` + `pool_locations` + `pool_region_metrics_hourly` in `lib/db.js`, the ingestion/health/region routes in `index.js`, and the WireGuard + region-port derivation in `scripts/lib/07_lib_gwctl.sh`. Everything outside that surface — the rest of §6, and §7–§10, §13–§15 — still rests on the 2026-06-08 pass (account + payout routes re-verified 2026-07-13) and was **not** re-checked, with one line-scoped exception: the admin-surface note in the §6 not-built list was corrected 2026-09-07 against `back-end-pool/admin-panel/` and `admin-shell.js`.
> **Product code last changed:** 2026-09-23 (Part 9 review fixes C1–C6 — dark gate, unit disabled across Migrate IN, code never archived/extracted, freeze on a failed extraction, no archive without pool.db, midnight-safe OUT; `07_lib_pool_migrate.sh`, `07_lib_pool_backup.sh`). Same day (hub move + connect-page latency, §13.13 — seeds v3 + local-region stamp in `lib/db.js`; NEW `lib/region-rtt.js`, `lib/connect-suggest.js`, `lib/latency-probe.js`; `/api/pool/connect/suggest`, `hub_rtt_ms`/`is_hub`, `connection.latency` on branding in `index.js`; `reactor-dashboard.js` + `reactor.css` measurement; gateway re-resolve timer + `6) Latency probe` in `07_lib_gateway.sh`; NEW `07_lib_pool_migrate.sh` + shared freeze/archive/restore cores in `07_lib_pool_backup.sh`; hub `/ping` + CSP in the pool script; suite 960 → 1133, 16 → 19 suites; **uncommitted, not VPS-tested**). Same day (payout-rails fix — `lib/wallet.js` `create_slatepack_message` named params; Tor probe ported from 06d in `lib/wallet-tor.js` + new `lib/socks5.js`, 8 s default, `?fresh=1` on tor-check; P-04 slimmed and the §17.2 #8 fold removed; suite 881 → 945; impl §10.5; **not VPS-tested**). Same day (§17 Part 4 review — `index.js`: `migrateProofSet` moved ahead of `stratumServer.start()`, `proof_too_recent`/`anchor_not_accepted_here` texts; `lib/owner-proof.js`: racing duplicate capture no longer evicts a second proof, a returning evicted anchor restarts `first_seen_at`; `test-owner-gate.js` 36 → 42, suite 875 → 881; **not VPS-tested**, §17.7). Same day (§17 Part 3 — copy sweep, no logic: the homepage setup guide, the shipped Terms/Privacy/FAQ defaults in `lib/pool-settings.js`, the `anchor_not_accepted_here` error text + two `index.js` doc/comment sites, and stratum/owner-proof/db comments restated for a set of ten; suite unchanged at 875/875; §17.6 Part 3). 2026-09-22 (§17 Part 2 built — the account page: `public_html/account-settings.html` renders `proofs` as counts, drops the "Evidence changed" banner, warns only past the cap and restates the gate copy for a set of ten; **not VPS-tested**, impl §10.4 "Part 2", §17.6 records the deltas). Same day (§17 Part 1 built — the ownership-proof SET backend: `miner_proofs` + `miner_accounts.proof_salt`, per-address scrypt salt, set capture/verify with LRU eviction and a flagged-not-deleted anchor, `migrateProofSet()` replacing `migrateOwnerProofHashes` and `backfillProofAnchors`, `proofs` on the account and admin miner views, suite 849 → 875; **not VPS-tested**, impl §10.4, §17.6 records the deltas). 2026-09-21 (§16 Part 5 review: two fixes in `lib/donor-names.js` — the rescan parses the list once per walk, not per name, and a separators-only label is no label — §16.12; the same day Parts 1–4 were built in order: login grammar → storage + capture + account view → admin moderation → the public league, impl §10.3 "Part 1"–"Part 4", every part **not VPS-tested**; earlier the same day: `/api/pool/donors` totals over every donor + `active_donors` from live tags, account `is_online` per rig — impl §10.3). 2026-09-20: pairing string carries the public port; gateway Status boot line, §13.12s; anchored ufw test + unmanaged-firewall readout, §13.12t — `scripts/07_grin_mining_*.sh`, `scripts/lib/07_lib_*.sh`, `web/07_mining_pool_public/`
> Prose last edited 2026-09-23 (§13.13 added — hub move + connect-page latency; §4 gained the effective-latency rule; §11 the gateway :443 probe note; §13.10b/c annotated where a hub IP change was said to need no gateway action). Earlier the same day (§18 added — donations v2: per-share donation, reviewed donor profiles with nickname + top-5 banner; design only, NOT built; §16 marked superseded in part and its Part 6 replaced by §18.10 Part 7). Earlier the same day (payout-rails fix: §8 gained the Tor pre-flight probe paragraph, replacing a "no TCP port-probe before send" claim that had been false since 2026-07-19; §17.2 #8 annotated where the operator reversed the fold placement). Earlier the same day (§17.7 added — the Part 4 review's ten answers and three fixes; §17.2 #2/#3/#9, §17.3 and §17.4 annotated where the review found them wrong; §17.6 Part 4 done). Earlier the same day (§17 intro + §17.6 — Part 3 done, with its three deltas, incl. that already-installed pools keep the old CMS page text; §6's slatepack note pointed at §17). 2026-09-22 (§17.6 updated — Parts 1 (backend) and 2 (account page) are built, with each part's deltas from §17 recorded there; Parts 3–5 unrun. Earlier the same day: §17 added — ownership-proof SET of 10 per kind with a per-address salt, replacing the 2-slot window). 2026-09-21 (§16 added — donor names + donor league; §16.11 tracks the build, Parts 1–5 done, Part 6 = VPS acceptance still owed; §16.12 records what building changed against the design and the Part 5 review's findings).

**Product:** `scripts/07_grin_mining_public_pool.sh` + web app under `web/07_mining_pool_public/`.
**Scope:** the complete public-pool design — architecture, deployment modes, multi-region
(Model C gateways), database, API, reward pipeline, payments, white-label, and UI/UX.

> **Companion docs (max-3 convention):**
> [`script07_implementation.md`](script07_implementation.md) — deploy, runbook, status, troubleshooting ·
> [`script07_security_audit.md`](script07_security_audit.md) — vulnerabilities, hardening, fixes.
> The **solo** miner (`07_grin_mining_solo.sh`) is a separate product —
> see the solo flowchart appendix at the end of this file.
>
> This file absorbs the former `script07_multi_region_design.md` and the imported
> `script07_public_pool/` GRINIUM doc set (deleted 2026-06-08). Where those described the
> standalone **Grinium** repo (`web/back-end-pool/`, ports `3002/3416`), this doc uses the
> **toolkit** layout (`web/07_mining_pool_public/`, ports `3333/3416/8080`).

---

## 1. What it is

A self-hostable **public mining pool for Grin**. The toolkit deploys the node (Script 01);
Script 07 deploys the full pool stack on top of a running node + grin-wallet.

- **Model:** address-as-identity (2miners style) — a miner's Grin address *is* their login
  (`grin_address.worker_name` as the stratum username). No miner registration/accounts.
- **Rewards:** PPLNS (default; configurable to Proportional or Solo via admin panel).
- **Auth:** admin-only JWT sessions. Miners never authenticate.
- **Script 07 role:** **infrastructure only** — deploy files, systemd, nginx, backups. All
  business logic lives in the pool web code; all settings are set via the web admin panel
  (config in `/opt/grin/conf/grin_pubpool.json`), never bash config files.

### Stack reality — Express, not Next.js
An earlier "v4" plan to rewrite in Next.js + Tailwind **never happened**. Treat any
"Next.js / Tailwind / App Router" mention in old notes as an abandoned proposal. The live
stack is:

| Layer | What's in the repo |
|---|---|
| Backend | **Express** (`back-end-pool/index.js`), one long-lived process per network |
| Frontend | **Static HTML + vanilla JS** (`public_html/*.html`, `js/*.js`), served by nginx |
| Styling | `public_html/css/pool.css` + `js/theme.js` (CSS variables) |
| Database | **SQLite** via Node's built-in `node:sqlite` (synchronous, in-process; `lib/sqlite-compat.js` shim keeps the better-sqlite3-style API; needs Node 24+) |
| Process mgr | **systemd** (+ watchdog cron) |

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Nginx (reverse proxy, HTTPS via certbot)                      │
│  • serves static frontend  (public_html → /var/www/…)         │
│  • /api/* → Express backend (localhost :8080)                 │
│  • security headers, rate-limit zones (shared helper)         │
└───────────────────────────────┬──────────────────────────────┘
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│ Express backend  (back-end-pool/index.js)                     │
│  HTTP API (:8080) + Stratum TCP server (:3333), one process   │
│  lib/: auth · stratum-server/-protocol · node-stratum-client  │
│   shares · miners · blocks · block-monitor · rewards (PPLNS)  │
│   orphan-detector · hashrate-tracker · wallet · wallet-tor    │
│   withdrawal-scheduler · pool-settings · rate-limiter         │
│   ip-filter · alert-monitor/-delivery · asset-manager         │
│   incentives · lottery · retention · reconciliation           │
└───────────────────────────────┬──────────────────────────────┘
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│ SQLite (node:sqlite)  /opt/grin/pubpool/<net>/pool.sqlite     │
│  miner_accounts · shares · blocks · withdrawals · balance_log │
│  withdrawal_events · users · admin_audit_log · pool_settings  │
│  pool_locations · hashrate_history · miner_incentives ·       │
│  lottery_draws · lottery_winners                              │
└───────────────────────────────┬──────────────────────────────┘
                                 ▼
        Grin node (Owner+Foreign API) · grin-wallet · Tor
```

One backend process per network; mainnet and testnet run fully isolated (separate dirs,
ports, services, DB files). `--testnet` flag (never `--floonet`); currency label `tGRIN`
vs `GRIN` via a config helper.

### Request / money flow
```
Miner ── stratum ──▶ proxy validates share ──▶ shares table
                                                  │
Pool finds a block ──▶ blocks (status=pending, nonce, height, reward)
                                                  │
        confirm_depth reached (1440 mainnet / 100 testnet)
                                                  │
        orphan check (nonce still in chain?) ──▶ if orphan: reverse exact credits
                                                  │ else confirm
                                  PPLNS distribute ──▶ miner_accounts.balance
                                                  │
        balance ≥ threshold / manual ──▶ withdrawal (Tor or Slatepack)
                                                  │
                                  grin-wallet send ──▶ Grin network
```
Every balance change writes an append-only `balance_log` row; every withdrawal state change
writes a `withdrawal_events` row.

---

## 3. Deployment modes

Script 07 has a **mode selector**. Two modes are offered on the menu; a third is arg-only.
A mode may also be passed non-interactively as `$1` (`singlebox` | `hub` | `gateway`).

```
Public Mining Pool Deployment Mode — <network>
  1) Pool server      The pool itself — runs everything. Start here.
                      Serves local miners as region "main"; accepts regional
                      gateways from other zones later — no rebuild.
  2) Regional gateway A thin stratum forwarder on ANOTHER box: no node,
                      no wallet — tunnels miners to your pool server.
  Z) Cleanup public pool        0) Back to mining hub
```

| Mode | Arg | Deploys | Library | Config file |
|---|---|---|---|---|
| **Pool server** | `singlebox` | Everything on one box: Central API (sole DB writer) + SQLite/WAL + schema + retention + web dashboard + admin + wallet (Tor/Slatepack payouts) + nginx + the **public** stratum listener | core `pool_*` fns (`pool_singlebox_loop`) | `grin_pubpool.json` · testnet `grin_pubpool_testnet.json` |
| **Regional gateway** | `gateway` | HAProxy (`mode tcp`) + WireGuard **only** — no Node process, no node, no wallet, no DB, no keys | `scripts/lib/07_lib_gateway.sh` | `grin_gateway.json` |
| **Central Hub** *(arg-only)* | `hub` | The same brain, without a local public stratum — all mining arrives via gateways | `scripts/lib/07_lib_hub.sh` | `grin_pubpool.json` |

`config.js` selects the app role via the `role` key — **`singlebox` | `hub`, and nothing else.**
A **regional gateway is not an app role**: it runs no Node process, so it never reads `role`.
`pool_mode_conflict_check` refuses to put a pool server/hub and a gateway on the same box —
both want stratum `:3333`, so it is one mining role per box.

WireGuard peers and the central `region_ports` map are mutated through exactly one path,
`grin-gateway-ctl` (`scripts/lib/07_lib_gwctl.sh`), shared by the CLI (`W` menu) and the admin
panel so the two can never drift apart. See §13 for that pairing flow.

---

## 4. Multi-region — why SQLite stays, and how regions attach

> This section is the **why**. The as-built account — bring-up order, scenario matrix, smoke
> tests — is §8 "Multi-region (Model C) — as built" of
> [`script07_implementation.md`](script07_implementation.md).
> **Multi-region is optional and most pools never need it:** one pool box already serves every
> miner on `:3333` as region `main`. Add a gateway only to cut latency for miners on another
> continent.

### Single-writer by design
Trace every arrow that reaches the DB: there is exactly **one** — the central pool process → DB.
Gateways, nodes and stratum listeners never open the database. Several regions can feed shares in,
but every path converges on **one process**, and only that process writes.

```
Miners (Asia) ─▶ Asia Gateway ─┐  WireGuard: raw stratum + PROXY-v2
Miners (US)   ─▶ US Gateway   ─┼─▶ region listeners 10.66.66.1:3391, :3392 … ─┐
                               │                                              ├─▶ pool process ──▶ SQLite (WAL)
Miners (local) ── stratum :3333 ──▶ public listener ───────────────────────────┘    (single writer)        ▲
                                                                                                           │
                                                                       Dashboard ── reads ─────────────────┘
```

"Concurrent load from 3 regions" is **connection** concurrency at the TCP/HTTP layer (Node's event
loop), not **database-writer** concurrency. SQLite WAL gives one writer + unlimited concurrent
readers, 100k+ batched inserts/sec (vs ~100 shares/sec for a 1,000-miner pool), and single-file
backup.

**That argument survived the Model C refactor — and got stronger, so it is kept here, not merely
inherited.** Its pre-2026-06 form was *"adding a satellite is a new HTTP client, not a new DB
writer."* Under Model C a region is not even a new client: it is **a new TCP listener inside the
same process**, bound to the WireGuard interface. The old form leaned on a *discipline* (a relay
must POST and never touch the DB file) that a future contributor could break; the new one is
*structural* — a gateway ships no code that could open a database, because it ships no Node at
all. The conclusion is unchanged and now harder to violate: **adding a region does not add a DB
writer, so SQLite keeps fitting.**

**Migrate to PostgreSQL only if the topology changes** so the DB stops having a single writer: the
pool process goes multi-process/replicated behind an LB; the DB moves onto a separate box (SQLite
has no network protocol — NFS/SMB breaks its locking); sustained >10k durable shares/sec; hot
relational data >~20–50 GB; or you need multi-master/hot-standby. **Never MariaDB.**

PRAGMAs at DB creation: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`,
`foreign_keys=ON` (file space reclaimed by the weekly `VACUUM` cron — Script 07 option C).

### Share capture = our own stratum proxy (not log-tailing)
In Grin the node's stratum is integrated with no clean external `getblocktemplate`, so the practical
"own server" is a **stratum proxy in front of the node's built-in stratum** (the proven `grin-pool`
model). Ours is not a separate daemon: `lib/stratum-server.js` (miner-facing) and
`lib/node-stratum-client.js` (node-facing) both run **inside the pool process**, so recording a
share is an in-process call, never a network hop:

```
Miners ──stratum──▶ stratum-server.js ──▶ accounting ──▶ pool.sqlite
                          │
                          └── node-stratum-client.js ──stratum──▶ node built-in stratum (localhost)
```

It binds the **public** stratum port (`3333` / testnet `13333`); the node's built-in stratum binds
**localhost only** (`3416` / testnet `13416` — grin's own `stratum_server_addr` default, which the
toolkit never moves). It sees every `login`/`submit` as structured JSON → reliable
`address.worker` identity + difficulty + nonce + timestamp, per-miner **vardiff**, dedup by
`(nonce, height)`, rate-limits, and abuse bans. Log-tailing was **rejected** (brittle format, one
global difficulty, no guaranteed per-share identity).

### Region attribution is by listener PORT, not by a string the edge sends
Each gateway's WireGuard tunnel targets **its own** central listener port — `region_ports`, a
`{ "<region>": <port> }` map in the pool config, allocated from a per-network base (`3391`
mainnet / `13391` testnet) by `grin-gateway-ctl`. `stratum-server.js` binds one listener per entry
on `region_listen_host` — **the WireGuard server IP in production**, defaulting to loopback so a
misconfigured box fails closed instead of exposing an unauthenticated port — and stamps that
listener's static label on every share arriving on it.

That is a security property, not just plumbing. The region tag is **server-derived and
unspoofable**: nothing a miner or a compromised edge sends can change it, which removes the old
"the region string the relay sends must match the hub's" footgun outright. PROXY-protocol v2
(which recovers the real miner IP behind the tunnel) is armed on **region listeners only**, so the
public `:3333` can never be fed a forged header. Conversely the per-IP connection cap applies to
the public listener only — a region tunnel is trusted, and one peer IP fronts a whole region.

`StratumServer.bindRegionListener(region, port)` adds a listener at runtime, so pairing a gateway
from the admin panel takes effect with **no restart and no miner disruption** (§13.3). Removing a
peer does not hot-unbind: that listener simply goes idle until the next natural restart.

### A gateway does not shorten the trip to the hub (effective latency)
A gateway ends the miner's **TCP connection**. It does not end the **share's journey**: every
share still crosses gateway → hub before it is validated and counted, and every job still comes
back the same way. So what a miner feels is the **effective** latency:

```
via a gateway = miner → gateway + gateway → hub
direct        = miner → hub
```

A nearby gateway can therefore be *slower* than no gateway. The case that made this concrete
(2026-09-23, Globalping, hub moving to OVH Gravelines): Singapore → Gravelines direct measured
148–162 ms, while Hong Kong → Europe varied from 159 to ~250 ms **depending only on the HK
provider's route** — so a Singapore miner sent to an HK gateway could lose 100 ms. The EU
datacenter choice (Gravelines vs Strasbourg) was worth ~1–15 ms; the gateway provider's route
was worth ~100 ms.

Two rules follow, and both are built (§13.13): the connect page ranks by effective latency, never
by distance to the nearest box; and **direct wins a near-tie** — a gateway must beat the hub by
more than 15 ms to be recommended, because it is one more trusted box in the path (it vouches for
the miner's IP — audit §J16-2) and one more thing that can go down. Put a gateway where the
gateway→hub leg is short and well-routed, not merely where miners are.

---

## 5. Database schema

> **Authoritative source = `back-end-pool/lib/db.js` (`createSchema()`).** The live schema keys
> tables by `grin_address` (not `miner_id`), stores balances as **`REAL` GRIN** (not nanogrin
> integers), and uses a single-resolution `hashrate_history`. The idealized integer-nanoGRIN /
> downsampled model in older notes is a *conceptual target*, not the current code.

Core tables (`/opt/grin/pubpool/<net>/pool.sqlite`):

| Table | Purpose | Retention |
|---|---|---|
| `miner_accounts` | balance, balance_locked, total_paid, is_online, location — keyed by `grin_address` | live |
| `shares` | PPLNS input (grin_address, worker, difficulty, block_height, **region**, created_at) — `region` is the **listener label**, stamped by whichever stratum listener accepted the connection (public listener → `config.region`, default `'default'`/`main`; a per-region tunnel listener → that region's key). It is server-derived, never client-asserted, and drives per-region stats only; PPLNS weighting is region-agnostic. Legacy rows predating the column read `'default'`. | sliding window (pruned) |
| `blocks` | found blocks + maturity (height, hash, nonce, reward, status, found_by) | forever |
| `withdrawals` | payouts (amount, fee, method tor\|slatepack, status, retry_count, txid) | forever |
| `balance_log` | append-only ledger of every balance/locked change | raw window `balance_log_keep_days` (default 60, floor 45) — rolled into `balance_log_daily` first; see §14 |
| `balance_log_daily` | daily rollup of the ledger — (UTC day, address, event_type, reference_type) → total_amount, event_count | **forever** (≈150 MB/10 yr @1000 miners) |
| `withdrawal_events` | per-withdrawal state-transition log | forever |
| `users` | admin accounts only (bcrypt, lockout columns) | forever |
| `admin_audit_log` | every admin mutation (admin_id, action, target, before/after, ip) | forever |
| `pool_settings` | runtime config overrides editable via admin UI (key/value/value_type) | live |
| `pool_locations` | operator-declared regions (region UNIQUE, label, api_url, stratum_url, is_active) — **purely descriptive**: labels + public stratum URLs for the "point your rig at your nearest region" grid, left-joined onto live share aggregates by `region`. A row here grants nothing; the real region wiring is the WireGuard peer + `region_ports` entry created by `grin-gateway-ctl`, and this box self-registers its own region via `ensureLocalRegion()`. | live |
| `hashrate_history` | timeseries + per-region aggregates | pruned by age |
| `pool_region_metrics_hourly` | one row per (hour, region) — hashrate/miner counts aggregated from `shares.region`; backs the public per-region trend charts | durable (bounded by region count) |
| `miner_incentives` | per-address join_bonus_paid, donation_percent, streak_days | live |
| `lottery_draws` / `lottery_winners` | verifiable lottery state | forever |

`pool_fee` and `prize_pool` are **reserved pseudo-addresses** (rows in `miner_accounts`) filtered
out of every miner-facing surface. Money flows through `balance_log` for audit.

---

## 6. API catalog (Express routes)

> **Verified against `back-end-pool/index.js` (2026-06-08; account + payout routes re-verified 2026-07-13;
> the ingestion / `health/*` / region routes re-verified 2026-09-07).** ✅ = wired in the backend ·
> ❌ = documented target, not yet built (see "Not yet implemented" below). Paths are the
> *actual* registered routes — earlier drafts of this catalog overstated the surface.

**Public — no auth (address is identity):**
```
✅ GET  /health  |  /api/health                         (alias; nginx proxies /api/*)
✅ GET  /api/pool/stats | /api/pool/stats/regions | /api/pool/blocks | /api/pool/payments
✅ GET  /api/pool/miners (balance distribution, addresses MASKED) | /api/pool/locations
✅ GET  /api/stratum/stats | /api/stratum/hashrate | /api/config/pool-info
✅ GET  /api/account/:addr | /:addr/balance/log | /:addr/shares | /:addr/tor-check
❌ GET  /api/miners/top | /api/account/:addr/balance   REMOVED 2026-07-28 (rich-list / duplicate;
        see script07_security_audit.md §C1). The live list is always /api/public/endpoints.
✅ GET  /api/account/:addr/workers | /:addr/hashrate/history
✅ POST /api/account/:addr/withdraw   { amount?, method?, ip_proof? }   (Tor auto; Slatepack IP-gated)   [IMPLEMENTED 2026-07]
✅ POST /api/account/:addr/withdraw/:id/finalize   { response_slatepack, ip_proof }   (Slatepack S2 finalize)   [IMPLEMENTED 2026-07]
✅ POST /api/account/:addr/min-payout   { min_payout, ip_proof }   (per-miner threshold; IP-gated, ≥ pool min)   [IMPLEMENTED 2026-07]
✅ GET  /api/public/branding | /public/page/:key | /public/lottery/winners
✅ GET  /robots.txt | /sitemap.xml | /manifest.json     (dynamic, exact-match nginx proxies)
⚠ /api/claim/:id?token=…   — claim-token route SUPERSEDED (never built); Slatepack payout now ships via the
                              IP-gated account self-service flow above (§8), not a claim link
```

**Ingestion: there is none — and that is the design.**
```
❌ POST /api/shares | /api/blocks   REMOVED 2026-06-22 (f2ebade) with the satellite role.
```
Regional gateways forward **raw stratum over WireGuard**, not shares over HTTP, so there is no
share/block ingestion API, no `hub_shared_secret`, and no ingestion allowlist to get wrong. Every
share is recorded by the central stratum server exactly like a local miner's (§4). Per-region
liveness is derived from recent shares plus a best-effort WireGuard handshake age, and served at
`/api/admin/health/gateways`.

Public region surface (no auth):
```
✅ GET  /api/pool/stats/regions | /api/pool/metrics/history/regions
✅ GET  /api/pool/topology        (404 unless the operator has enabled the public network map)
```
`/stats/regions` and `/metrics/history/regions` apply a **k-anonymity floor**: a region with
`0 < miners < min_bucket` reports `miners` / `hashrate_gps` / `shares_window` as `null` with
`below_floor:true`. That is *withheld*, not zero — a real zero is still `0`, and a chart must draw
a `null` as a **gap**, never as `0`. Totals stay exact.

**Admin auth (admin register is CLI-only):**
```
✅ POST /api/auth/login | /refresh | /logout | /change-password
❌ POST /api/auth/reauth     ❌ GET /api/auth/me        (fresh-reauth/whoami — NOT built)
```

**Admin (`requireAdmin` = rate-limit + IP filter + JWT):**
```
✅ GET  /api/admin/dashboard | /metrics | /audit-log
✅ GET  /api/admin/health  (roll-up)  |  /health/node | /health/wallet | /health/system | /health/gateways
✅ GET  /api/admin/miners | /miners/:addr     POST /api/admin/miners/:addr/inject  (testnet only)
✅ GET  /api/admin/withdrawals | /withdrawal-scheduler
✅ GET/POST/DELETE /api/admin/locations[/:id]
✅ GET/POST /api/admin/settings | /settings/:section | /settings/:section/restore
✅ GET/POST /api/admin/database/status | /database/cleanup
✅ GET  /api/admin/alerts | /alerts/:id/acknowledge | /snooze | /config
✅ POST /api/admin/assets/upload | GET /assets | DELETE /assets/:filename
✅ GET/POST /api/admin/incentives/prize-pool[/topup] | /incentives/lottery/draws|draw-now
✅ GET/POST /api/admin/security/* | /poolstats/*
❌ PUT  /api/admin/miners/:addr                         (admin edit of a miner — NOT built)
✅ POST /api/admin/withdrawals/:id/retry|cancel  (freshAdmin)   [IMPLEMENTED]   ❌ GET /…/:id/events  (NOT built)
❌ GET/PUT /api/admin/users[/:id]                       (admin user CRUD — NOT built; create via CLI)
❌ GET  /api/admin/payment-stats                        (reconciliation page API — NOT built)
```

### Not yet implemented (doc-vs-code, 2026-06-08)
These remain **documented targets without backend routes**; tracked so the catalog stays honest:
- **Slatepack claim** (`/api/claim/:id`) — the *claim-token route shape* was superseded and never
  built. The Slatepack payout **rail itself IS now wired** (2026-07) via the account self-service flow
  (`POST /api/account/:addr/withdraw` method=slatepack → `/withdraw/:id/finalize`), IP-gated + encrypted
  to the miner address (§8). Tor is **no longer** the only wired payout rail.
- **Admin user CRUD** (`/api/admin/users[/:id]`) — NOT built (create via CLI). Manual withdrawal
  `retry`/`cancel` **ARE now built** (`freshAdmin`-gated); only the `/…/:id/events` timeline is missing.
  `back-end-pool/admin-panel/users.html` (nav title **Sessions**) references user-CRUD, but nothing
  else in the panel depends on it. There is no `public_html/admin-dashboard.html` — the admin surface
  is `back-end-pool/admin-panel/`, rsynced to the web root's `/admin/` at install.
- **`/api/admin/miners/:addr` PUT**, **`/api/auth/reauth` + `/me`**, **`/api/admin/payment-stats`**.

---

## 7. Reward pipeline (PPLNS)

```
1. The stratum server detects a found block → blocks(status=pending, nonce, height, reward)
   - always local: BlockManager.creditBlock on this box (dedups by `hash` UNIQUE).
     Under Model C there is only ever one node + one wallet, so a share arriving over a
     region tunnel credits by exactly the same path as a local one.
2. block-monitor (each tick): tip_height − block.height ≥ confirm_depth ?
3. orphan-detector: is the block's nonce still in the chain?  no → orphan+reverse · yes → confirmed
4. rewards.distributeConfirmedBlocks: PPLNS over the last-N-blocks share window
5. withdrawal-scheduler pays out when balance ≥ threshold (Tor / Slatepack)
```

- **`confirm_depth` = 1440 mainnet / 100 testnet** — equals Grin `COINBASE_MATURITY = 1440`
  (a coinbase is unspendable until 1440 confirmations); critical for reorg safety. Validated
  against `grin-pool` / `open-grin-pool`.
- **Double-pay guard:** distributed shares are marked paid (per-block) inside the distribution
  transaction so overlapping windows can't pay a share twice.
- **Fee routing:** `fee = gross − net`; credited to the `pool_fee` pseudo-address. Default
  `pool_fee_percent` is **1.0** (`config.js`, `pool-settings.js`, and the bash
  installers all agree); operator-editable via the admin panel.
- **The pool fee is taken at BLOCK MATURITY, never at withdrawal** — and that is a correctness
  choice, not a convenience one (revisited and re-affirmed 2026-07-27). Block reward is the only
  correct fee base: (1) orphan reversal replays the exact `balance_log` credits *including* the
  fee, so a fee already banked at withdrawal time would be unrecoverable once the miner had
  withdrawn; (2) charging at the withdrawal door would tax the pool's own giveaways (join bonus,
  streak, prize awards) on the way out while letting a dormant-swept balance escape fee-free;
  (3) a later `pool_fee_percent` change would apply retroactively to GRIN mined under the old
  rate; (4) displayed balances stay equal to what the miner receives, so `min_withdrawal` and
  every account/ledger surface mean exactly what they say.
- **Orphan reversal** reads the *actual* credited amounts from `balance_log` and reverses those
  exact values (PPLNS-weighted, including the fee credit); never pushes a balance below 0.
- **Payout threshold:** default `min_withdrawal` = **25 GRIN** (raised from 5.0 on 2026-07-13; agrees
  across `config.js`, `pool-settings.js`, admin `settings-payout.html`, and the
  bash installer). Rationale: each payout is an interactive tx that adds a **permanent kernel** to the
  chain, so a low floor multiplies both chain growth and pool payout load. Operator-editable in the
  admin panel. Each miner may set a personal `min_payout` override (IP-gated
  `POST /api/account/:addr/min-payout`) that can only **raise** the floor — enforced at write time and
  re-checked in `withdrawal-scheduler.js`, so an override never drops a payout below the pool minimum.
- **Flat withdrawal fee:** default `withdrawal_fee` = **0.04 GRIN** (added 2026-07-27; `config.js`,
  `pool-settings.js`, admin `settings-payout.html`). Deducted from every payout on **all three
  rails**; `0` makes the pool absorb the cost. Grin charges the **sender** a network fee by
  transaction *weight* — `(inputs + 21×outputs + 3×kernels) × 0.0005` — so a payout costs the
  pool ~0.023 GRIN whether it is 25 or 2500 GRIN. Left unrecovered that cost scales with payout
  *count* and eats ~9% of fee income at a 25 GRIN floor (~23% at 10). 0.04 covers even a
  ~10-input sweep (~0.0275). Invariants: `0 ≤ withdrawal_fee < min_withdrawal`, enforced in
  `validateConfig` **and** re-checked in `PoolSettings.applyToConfig` (a per-field validator
  can't see the other value, and lowering the floor alone can strand a stored fee above it —
  that path falls back to 0 rather than making every at-minimum payout unpayable).
  - **Accounting (why it's charged on CONFIRM, not on request):** the miner is locked and
    debited the full gross `amount`; only `amount − fee_charged` goes on-chain. The fee is
    credited to `pool_fee` inside `_releaseLockAndDebit`, which runs only on a confirmed payout.
    Charging at request time would force every reversal path (Tor final failure, slatepack
    expiry, Nostr send failure, admin cancel) to un-charge it — miss one and the pool banks a
    fee for a payout that never happened *and* breaks the integrity invariant. On confirm,
    **zero reversal paths change**.
  - **Two columns, two different fees — do not conflate.** `withdrawals.fee` = the REAL on-chain
    network fee (backfilled by `recordTorFee` / `_slateFeeGrin`), read by reconciliation to
    explain the wallet-vs-ledger gap. `withdrawals.fee_charged` = the flat fee billed to the
    miner, frozen at request time so a later settings change can't rewrite historical terms.
    They are independent; the pool profits or loses the difference.
  - **Ledger shape:** the release writes **two** debit rows summing to the released amount —
    `reference_type='withdrawal'` (net, what the miner actually received) and
    `'withdrawal_fee'` (the fee) — plus a matching `'withdrawal_fee'` **credit** to `pool_fee`. Splitting
    keeps "paid to miners" honest: reconciliation's flow statement and the public payments page
    both read `debit/'withdrawal'` as money paid out, so logging the gross there would overstate
    every payout by the fee. `'withdrawal_fee'` is deliberately **not** counted as external money IN
    by `FLOW_CASES` — like `fee_cut`, it is an internal transfer of GRIN the pool already held.
    `reconciliation.js` `FEE_CASES.collected` counts `('pool_fee','withdrawal_fee')` together.
  - **Reporting:** every "GRIN sent to miners" figure in `hashrate-tracker.js` (hourly rollup,
    payments series, payout-size histogram, lifetime `paid_all`) reads
    `amount − COALESCE(fee_charged,0)`. Legacy rows carry `fee_charged = 0`, which is the
    historically *correct* value (they predate the fee), so the migration needs no backfill.
    `totals.fee_percent` stays the **block-reward** split only — mixing the flat fee in would make
    the advertised pool fee % depend on how often miners withdraw; the flat fees are reported
    separately as `totals.withdrawal_fees_all`.
  - **Open:** `payment-history.html` does not yet surface `withdrawal_fees_all` — the number is
    served but not rendered, so the public page currently understates total operator take.

---

## 8. Payments — Tor + Slatepack (one state machine, two transports)

Every Grin transaction is interactive (2-of-2). "Tor" and "Slatepack" are two **transports** for the
same slate round-trip, so there is **one** withdrawal state machine with a `method` dimension; only
"deliver the slate" branches. Balance locking, retry, reversal, ledger, and audit are shared.

| Transport | Miner does | Works if miner offline? | Pool calls |
|---|---|---|---|
| **Tor** | nothing (listener auto-signs) | no | `init_send_tx` → post over Tor → `finalize_tx` |
| **Slatepack** | copy-paste S1 → sign → paste S2 | yes | `init_send_tx` (lazy) → miner returns S2 → `finalize_tx` |

**Tor is primary, Slatepack is the fallback, and that is the whole set the pool ships.** A store-and-forward
relay rail (093 Transporter) was carried here as a reserved, forced-off placeholder until 2026-08-13 and
has been **removed**: pool payouts over the Transporter are blocked on wallet *relay-receive* support that
does not exist upstream, so the placeholder advertised a delivery date the pool could not set. Nothing was
wired — no scheduler branch, no `method='transporter'` — so removal is a deletion of the promise, not of a
feature. `public_html/js/payout-methods.js` makes rails self-registering, so re-adding one later costs a
file plus a `<script>` tag.

**Auto-payout** (6h scheduler, no human) can only attempt the zero-interaction method (Tor); on Tor
failure to an offline miner the withdrawal becomes **Slatepack-claimable** instead of reversing.

**Slatepack security — IMPLEMENTED 2026-07 (differs from the original claim-token/payment-proof plan):**
the slate isn't inherently address-bound (the receiver supplies their output in S2), so two controls
apply: (1) an **IP ownership gate** (`lib/owner-proof.js`, anti-grief/anti-spam) — the requester must
present a mining source IP from the address's proof set (the last-2 window until 2026-09-22; up to 10 per kind since — §17), throttled 8/10min → 5min lockout; (2) **encryption
to the address** (anti-theft) — the S1 slatepack is age-encrypted to the miner's grin address
(`createSlatepackMessage(slate, [grinAddress])`), so a non-owner who clears the IP gate only gets an
undecryptable blob. `payment_proof_recipient_address` is left **`null`** — encryption, not payment proof,
is the anti-theft control actually shipped. Tor needs neither (listener is address-bound).

**Balance model** (`miner_accounts`, always in sync, each change logged):

| Event | balance | balance_locked |
|---|---|---|
| Create (CAS: only if balance ≥ amount+fee, else 409) | − (amount+fee) | + (amount+fee) |
| Confirm | — | − (amount+fee) |
| Permanent fail / admin cancel | + (amount+fee) | − (amount+fee) |

Miner pays **no fee** on a failed/cancelled withdrawal (full reversal). **Max 1 pending withdrawal
per address** (429). Tor retry backoff 6/12/24/48h, then permanent fail. Reference Slatepack pool: GaeaPool.

**Tor pre-flight probe** *(corrected 2026-09-23: this section used to say "no TCP port-probe before
send", which has been false since the pre-flight gate was built on 2026-07-19)*. Before it locks any
funds, a Tor withdrawal probes the miner's wallet. The pool derives the v3 onion from the grin
address and POSTs `check_version` to that onion's foreign API over a fresh Tor circuit. The answer
is **tri-state**: `true` means a grin-wallet answered. `false` means the pool's own tor works and the
wallet did not answer, so the payout is refused with a 409 and nothing is locked. `null` means the
pool could not look (its own tor is down or silent), so the gate **fails open** and grin-wallet
decides at send time. A timeout with no reply from the local proxy is `null`, never `false`.
Mechanics and reason codes → impl §10.5.

---

## 9. White-label / branding / SEO / incentives

Operator customisation flows from the admin panel into the public pages **client-side** (nginx serves
static pages; Express only answers `/api/*`):

```
admin (settings.html) ─POST /api/admin/settings/<section>─▶ pool_settings (SQLite)
public page ─GET /api/public/branding─▶ buildPublicConfig() ─▶ /js/branding.js applies
   title/meta/OG/Twitter/canonical/JSON-LD · theme (CSS vars + custom CSS + font) ·
   analytics · maintenance overlay · banners · [data-brand] content
```

- **`branding.js`** is loaded by every public page and is **defensive** — any fetch/field failure
  leaves the page's hardcoded defaults intact. It bridges the two theme systems (public
  `body.<theme>-theme` classes + admin `theme.js` CSS variables).
- **Config sections** in `pool-settings.js` defaults: `branding` (logo/dark-logo, theme,
  custom_theme JSON, font, hero/CTA), `seo` (title_template, per-page SEO, structured data),
  `analytics` (GA4 / Plausible / Umami / Matomo + custom head/body HTML + cookie consent),
  `pages` (operator-authored about/terms/privacy/faq/impressum), `notices` (maintenance mode +
  announcement banners).
- **Dynamic SEO/PWA:** `robots.txt`, `sitemap.xml`, `manifest.json` generated by Express and served
  via exact-match nginx `location =` proxies. Canonical origin = `seo.site_url` else request host.
- **Theme builder:** colour picker per CSS variable → hidden `custom_theme` JSON; 13 selectable
  themes via shared `css/themes.css` + `js/public-theme.js`; export/import.
- **Miner-config generator** (`/connect`) builds copy-paste lolMiner/GMiner/SRBMiner commands from
  `/api/public/branding`.
- **Uploaded assets** served at `/custom/<file>` from a config-driven `assets_dir`.

### Incentives (prize pool, bonuses, lottery)
All under the **Incentives** admin tab, off until `incentives_enabled`. Register-free preserved
(grin_address is identity). Funded by a reserved **`prize_pool`** pseudo-address (fee-cut diversion +
miner `donateN` worker tags + manual top-ups / published Slatepack donation address).

- **Join bonus** — one-time, paid only after an address's first confirmed withdrawal (anti-Sybil).
- **Block-finder jackpot** — flat amount at block maturity; clawed back on orphan. Sybil-proof.
- **Loyalty streak** — capped multiplier for consecutive days; funded from `prize_pool`.
- **Lottery** — weekly + special events; pot A share-weighted, pot B equal-chance;
  **verifiable** (winner derived from the node tip block hash captured at draw time).

Public pages: `donate.html` (channels + live prize-pool size), `fortune-board.html` (winner history
+ draw seed for audit).

> Known register-free trade-off: pot B + per-address bonuses are partly Sybil-farmable; share-weighting
> + min-shares bar + the Sybil-*proof* features (jackpot, streak, fee-cut) carry the fairness load.
> Optional free accounts for true one-person-one-entry is a deferred phase-2 item.

---

## 10. UI / UX

Static HTML + vanilla JS in `public_html/`:
`index, login, miners-stats, payment-history, pool-info, system-health, account-settings,
admin-dashboard, connect, donate, fortune-board, page` + the IPOLLO testnet guide.
A second admin tree lives in `back-end-pool/admin-panel/` (index/users/miners/payments/health/settings).

**Public pages:** home (miners online, pool/network hashrate C32, last block, fee, luck %, price,
24h chart, 5–10s refresh); `/blocks`; `/payments` (aggregated/anonymized); `/miners` (top-50 by 24h
hashrate, truncated addresses); `/account/:addr`; `/faq`. **Admin:** dashboard, users, miners,
withdrawals, payment-stats (reconciliation + anomalies), health, settings.

**Standards:** per-page SEO (title/description/OG/canonical + JSON-LD); mobile responsive
(tables stack, ≥44px touch targets); GA4/analytics via the branding system; central `escHtml` on every
interpolation sink; worker-name regex enforced at the stratum layer.

---

## 11. Network ports

| Service | Mainnet | Testnet | Access |
|---|---|---|---|
| Public stratum (miners) | 3333 | 13333 | Public |
| Per-region stratum listeners (Model C) | 3391, 3392 … | 13391, 13392 … | **WireGuard interface only** (`region_listen_host`; loopback until set) |
| WireGuard (gateway tunnels) | udp 51820 (`wg-grinpool`, 10.66.66.0/24) | udp 51821 (`wg-grinpool-tn`, 10.66.67.0/24) | Public UDP on the central box; peers are explicit |
| Node built-in stratum (proxy upstream) | 127.0.0.1:3416 | 127.0.0.1:13416 | localhost only |
| Central API / Pool HTTP API | 8080 | 8090 | Public web (nginx). No ingestion surface — see §6 |
| Web dashboard | 443 | 443 | Public |
| Node API (Owner/Foreign) | 3413 | 13413 | localhost |
| Wallet Foreign / Owner | 3415 / 3420 | 13415 / 13420 | localhost |
| P2P | 3414 | 13414 | Public |

> A regional gateway box exposes the public stratum port `3333`/`13333`; it holds no
> node, wallet, DB or keys, and reaches the central box over the tunnel alone. Because both a
> pool server and a gateway want `:3333`, `pool_mode_conflict_check` keeps them on separate boxes.
> **Since 2026-09-23 a gateway may also expose `:443`** — only when the operator turns on its
> `6) Latency probe` (§13.13.5): a separate HAProxy instance answering `GET /ping` with an empty
> 204 and 404 to everything else. `:80` is then opened for certbot's standalone challenge but is
> bound only for the seconds of an issue/renewal. The hub's own `/ping` rides its existing `:443`.
>
> The single-box installer was migrated off the legacy `3417/3002` to `3333/8080` in 2026-06
> (bash + backend in sync — see `config.js`). The **node upstream** was NOT moved with them:
> the `3334` this doc once planned was never implemented, because Script 01 leaves the node's
> `stratum_server_addr` at grin's default, so the pool must dial `3416`/`13416` out of the box.
> Three sites carry that number and must stay agreed — `pool_ensure_defaults`
> (`07_grin_mining_public_pool.sh`), `node_stratum_port` (`back-end-pool/lib/config.js`), and
> `grin_sync_pool_stratum` (`lib/grin_node_secrets.sh`), which re-patches the toml after a node
> rebuild. It is operator-overridable via `node_stratum_port` in the pool config. The **solo**
> product (`07_grin_mining_solo.sh`) dials the same `3416`/`13416`.

---

## 12. Follow-ups (not implemented)

> Tracked as deferred decisions D2–D9 in
> [`script07_implementation.md`](script07_implementation.md) → "Deferred decisions & open items".
> Do not re-implement without a product call. (The 2026-06-08 security hardening — trust proxy,
> bcrypt 12, lockout, refresh revocation, jwt fail-loud, escHtml, confirm_depth 1440 — is **done**;
> see that doc's status table and security audit §B.)


- Move money columns from `REAL` GRIN to **integer nanoGRIN** (engine-independent; do it in SQLite,
  carries to Postgres later).
- i18n / multi-language content; fiat (USD/EUR/BTC) price display.
- Unify the public `body.<theme>-theme` system onto the `theme.js` CSS-variable system.
- Admin live-preview iframe + WCAG contrast check in the theme builder.
- Optional free miner accounts for true one-person-one-entry lottery.

---

## 13. Admin-panel gateway pairing — IMPLEMENTED 2026-07-13 (same day as design; NOT VPS-tested — see §13.6b)

> Collapses the 4-hop WireGuard pairing ping-pong (gateway pubkey → SSH to hub CLI →
> pairing string → back to gateway → *then* declare the region again in admin → Regions)
> into **one admin-panel form** that does the WG peer add and the `pool_locations` upsert
> atomically. Kills the dual-registry drift that `pool_wg_list` currently warns about.
> **Implementation branch: `add-ons`** — operator decision 2026-07-13: pool work moves to
> `add-ons` (it contains the `publicpool` tip; WG hub↔gateway path is E2E-verified, so the
> separate testing branch is retired for new work — fast-forward `publicpool` or leave frozen).

### 13.1 Target UX (after)

```
GATEWAY BOX                          HUB ADMIN PANEL (browser)
1. Toolkit → Gateway → 1) Install
   → prints WG public key   ────────→ 2. Regions & Gateways → ➕ New region
                                         fill label/country/stratum URL
                                         + paste gateway pubkey → Save
                            ←──────────  panel shows GRINGW1|… (copy button)
3. 2) Configure → paste GRINGW1
4. 3) Tunnel up → 4) Start           5. Status chip goes green (handshake age)
```

Two human hops instead of four; no SSH session on the hub; region exists in exactly one
place. The gateway-side flow ([`07_lib_gateway.sh`](../../scripts/lib/07_lib_gateway.sh))
is **unchanged** — it already consumes the `GRINGW1` string.

### 13.2 Component 1 — `grin-gateway-ctl` root helper (single WG mutation path)

One root-owned executable becomes the **only** code that mutates `/etc/wireguard/wg-grinpool*.conf`
and `region_ports`; both the CLI `W` menu and the panel backend call it. Logic moves out of
`pool_wg_add_peer` / `pool_wg_list` / `pool_wg_remove_peer` (currently
`07_grin_mining_public_pool.sh` ~1927–2140) into the helper; those menu functions become thin
callers that pretty-print its JSON.

- **Deployed to:** `/usr/local/bin/grin-gateway-ctl` (root:root `0755`), written from a heredoc
  by a new sourced lib **`scripts/lib/07_lib_gwctl.sh`** (`pool_gwctl_install()`), called from
  `pool_wg_setup_server` and on every hub setup run (idempotent regen, like other units).
- **Language:** bash + embedded `node` for JSON (the hub always has Node; the *gateway* box
  doesn't, but the helper never runs there).
- **Per-network:** every subcommand takes `--net mainnet|testnet` and derives
  `WG_IFACE` / tunnel `/24` / `ListenPort` / `REGION_PORT_BASE` / `$POOL_CONF` exactly as
  `07_grin_mining_public_pool.sh:1853-1866` does today (single source: the helper).

| Subcommand | Does | stdout (always JSON) |
|---|---|---|
| `add-peer --net N --region R --pubkey K` | validate → dup-guard → assign next free `/32` + region port (existing region KEEPS its port) → append `[Peer]` → `wg syncconf` → write `region_ports` + `region_listen_host` into pool.json | `{ok, existing:false, region, peer_ip, region_port, hub_pubkey, hub_endpoint, hub_tunnel_ip, pairing:"GRINGW1\|…"}` |
| same, pubkey already a peer | **no write** (preserves the 2026-07-05 cryptokey-routing lesson) | same shape with `existing:true` |
| `remove-peer --net N --region R` | delete `[Peer]` block + `region_ports[R]` → `wg syncconf` | `{ok, removed:R}` |
| `list --net N` | re-derive pairing strings from wg conf + pool.json | `{ok, gateways:[{region, peer_ip, region_port, pairing}]}` |
| `status --net N` | `wg show <iface> dump` → per-region handshake age + rx/tx bytes | `{ok, gateways:[{region, handshake_age, rx_bytes, tx_bytes}]}` |

**Validation inside the helper (never trusts the caller, even root):**

| Input | Rule |
|---|---|
| `--net` | literally `mainnet` or `testnet` |
| `--region` | `^[a-z0-9-]{2,12}$` |
| `--pubkey` | `^[A-Za-z0-9+/]{43}=$` (wg key wire format) |
| AllowedIPs | **not an input** — helper computes next free `/32`; `0.0.0.0/0` is unrepresentable |

Errors → non-zero exit + `{ok:false, error:"…"}` on stdout so `execFile` callers get one parse path.

**Privilege note:** `grin-pool-manager` currently runs `User=root`
(`07_grin_mining_public_pool.sh:470`) — historical convenience, not a requirement. §13.9
de-roots it as part of this work; the backend calls the helper via
`sudo grin-gateway-ctl …` under a one-line scoped sudoers entry. Design the backend call as a
single `gwctl()` wrapper so the sudo prefix lives in exactly one place.

### 13.3 Component 2 — backend (`back-end-pool/index.js`)

All handlers call the helper via `execFile('/usr/local/bin/grin-gateway-ctl', [...], {timeout: 10000})`
— argv array, never a shell string. One shared `gwctl(args)` promise wrapper.

1. **Extend `POST /api/admin/locations`** (`secureAdmin`, exists at ~3068) with an optional
   `wg_pubkey` body field. When present and non-empty: after the `pool_locations` upsert,
   call `add-peer`; on success include `pairing` + `peer_ip` + `region_port` (and `existing`)
   in the JSON response; on helper failure return `502` **with the location still saved** and
   a `wg_error` field (metadata save must not be hostage to wg state). Audit-log action
   `gateway_pair` with `{region, pubkey, peer_ip, region_port, existing}`.
2. **New `GET /api/admin/gateways/:region/pairing`** (`secureAdmin`) → helper `list`, filter
   by region → `{pairing}`. Powers a "Show pairing string" button for lost strings (replaces
   SSH `W → 3`).
3. **Extend `DELETE /api/admin/locations/:id`** (`freshAdmin`, exists at ~3101): optional
   `?remove_peer=1` also calls `remove-peer` for that region. Peer removal is destructive →
   stays behind `freshAdmin` (recent re-auth), audit action `gateway_unpair`.
4. **Status:** no new endpoint — `GET /api/admin/health/gateways` (~2977) already merges share
   recency + `readWgHandshakes()` + active TCP probe. Optionally later: enrich with rx/tx from
   helper `status` (the existing `readWgHandshakes()` stays as the zero-dependency fallback).

**Listener activation without a stratum blip (hot-bind).** Today a new region requires a
`grin-pool-manager` restart so `stratum-server.js` binds the new tunnel-IP listener
(`lib/stratum-server.js:126-128` reads `region_ports` only at start). The panel backend *is*
that same process, so restarting it from a request handler is self-defeating. Design:

- Add `bindRegionListener(region, port)` to `StratumServer` — same accept/stamp logic as the
  boot-time loop, callable at runtime; update in-memory `config.region_ports[region]` after the
  helper succeeds, then call it. No restart, zero miner disruption.
- The **CLI** path (`W → 2`, now helper-backed) keeps its existing
  `systemctl restart grin-pool-manager` since it runs outside the process; on next boot the
  hot-bound listener is rebuilt from pool.json anyway (helper already persisted it).
- `remove-peer` v1 does **not** hot-unbind (rare op; listener on a removed region just goes
  idle until the next natural restart — document in UI copy).

### 13.4 Component 3 — panel page (`admin-panel/regions.html`)

Page renames to **"Regions & Gateways"**. Changes to the existing form/table (482-line page,
form fields at ~180–210):

- New form field: **Gateway WireGuard public key** *(optional — leave empty for a
  metadata-only region entry: a label with no tunnel behind it)*, with inline format hint
  (44 chars, ends `=`).
- After save-with-pubkey: result card showing the `GRINGW1|…` string in a monospace box with a
  📋 copy button + the four-step "what to do on the gateway box now" mini-guide. Warn banner
  when `existing:true` ("key already paired — existing tunnel IP/port kept").
- Per-row **tunnel chip** fed by the already-polled `/api/admin/health/gateways`:
  `🔒 handshake 12s` (green <180s / yellow <600s / red otherwise / grey "no peer") next to the
  existing stratum-probe status; plus a "Show pairing string" row action (endpoint #2).
- Delete flow gains a checkbox "also remove the WireGuard peer (unpair the gateway box)" →
  `?remove_peer=1`.
- **Field guide** (collapsible at top, currently "STEP 1 of 4") rewritten to the new 2-hop
  flow: 1 install on gateway box → 2 this form → 3 paste string there → 4 watch chip go green.

### 13.5 CLI (`W` menu) after the refactor

`W → 1` setup server: unchanged + installs the helper. `W → 2/3/R`: thin wrappers —
prompt as today, call the helper, pretty-print (colored) from its JSON. Kept as the offline
fallback and for headless operators; because both paths share the helper, drift is impossible.
The "region wired but not declared in admin" warning in `pool_wg_list` stays (still reachable
via CLI-only pairing) but should become rare.

### 13.6 Security summary

- **No key material moves.** Only public keys and internal addressing cross the panel; both
  private keys stay in their boxes' root-only files. Trust model identical to the CLI flow.
- **Blast radius of a compromised admin session** = add/remove a stratum-forwarder peer with a
  helper-chosen `/32` — strictly less than the payout/config power an admin session already has.
  Tunnel-side listeners are only the per-region stratum ports (Central API stays on localhost).
- Helper self-validates all inputs (§13.2), `execFile` argv only, `freshAdmin` on unpair,
  audit log on pair/unpair, dup-pubkey guard preserved verbatim.

### 13.6b Implementation deltas (2026-07-13 — what building it changed vs the plan)

- **grinsecret group covers BOTH node secrets, not just foreign.** The §13.9 audit missed
  that `lib/grin-node.js` reads the node's `.api_secret` (Owner, `get_status`) *and*
  `.foreign_api_secret` directly by path (the pool runs as root). `pool_deroot` +
  `grin_sync_pool_stratum` set `root:grinsecret 640`
  on both (the secret self-heal re-applies it after a node rebuild).
- **The pool wallet LISTENER is de-rooted too.** The backend spawns `grin-wallet send`
  (payouts) as `grinpool`; a root-run tmux listener would leave root-owned lmdb/tx-log
  files that EACCES the send. `pw_write_launchers` now drops the listener to `grinpool`
  (su + `HOME=<wallet dir>` + pre-launch chown sweep, mirroring the node launch contract)
  whenever the user exists.
- **Helper gained a region-replace flow.** `add-peer` on an existing region with a NEW
  pubkey swaps the key in place — the region keeps its tunnel IP *and* port (the §13.10d
  gateway-box-replacement story, previously only implicit). Response carries `replaced:true`.
- **Panel delete "checkbox" is a second `confirm()`** (native dialogs can't host one);
  a third confirm guards unpairing a gateway that handshook <180 s ago.
- **`wg_endpoint_host` (§13.10b) is a plain pool.json key** set via CLI menu `W → 5`
  (no helper subcommand — the helper reads it when composing endpoints).
- **§13.10c backup:** the legacy plain `pool_backup` + cron wrapper were replaced outright
  (wrapper/cron file names kept so cleanup keeps matching); product names `pubpool` /
  `pubpooltestnet`; C) cron menu option 1 delegates to the same `pbk_schedule`.
- **Local verification done:** `bash -n` + `node --check` on all touched files; the
  generated `grin-gateway-ctl` exercised end-to-end with stubbed `wg`/paths (fresh add,
  dup-key no-write, region replace, validation rejects, remove, list/status, DNS
  endpoint); `_gns_toml_repatch` unit-tested (quote-normalised no-op fix baked in);
  `_pbk_make_tar` include/exclude verified. **The §13.8 VPS plan still stands** — real
  wg syncconf, the sudo path from the de-rooted service, hot-bind E2E, and the live-box
  migration order (testnet hub → payout round → mainnet) are untested.

### 13.7 Files changed (branch `add-ons`)

| File | Change |
|---|---|
| `scripts/lib/07_lib_gwctl.sh` | **new** — writes `/usr/local/bin/grin-gateway-ctl` (heredoc), `pool_gwctl_install()` |
| `scripts/07_grin_mining_public_pool.sh` | source new lib; install helper in `pool_wg_setup_server`; refactor `pool_wg_add_peer`/`pool_wg_list`/`pool_wg_remove_peer` into helper callers; `pool_deroot()` (§13.9): grinpool user, chown sweep, hardened unit, sudoers |
| `web/07_mining_pool_public/back-end-pool/index.js` | `gwctl()` wrapper; extend locations POST/DELETE; pairing GET |
| `web/07_mining_pool_public/back-end-pool/lib/stratum-server.js` | `bindRegionListener()` hot-bind |
| `web/07_mining_pool_public/back-end-pool/admin-panel/regions.html` | pubkey field, pairing card, tunnel chip, unpair checkbox, guide rewrite |
| `scripts/lib/07_lib_gateway.sh` | none (consumes `GRINGW1` unchanged) |
| `scripts/lib/07_lib_pool_backup.sh` | **new** (§13.10c) — hub backup on shared gbe_*/gbp_* engine |
| `scripts/lib/grin_node_secrets.sh` | add `grin_sync_pool_stratum` consumer (§13.10a) |
| hub menu / `07_lib_pool_wallet.sh` | "Replace pool wallet" entry reusing existing `pw_*` steps (§13.10e); `wg_endpoint_host` option (§13.10b) |

### 13.8 Test plan

1. `bash -n` all touched scripts; `node --check` index.js / stratum-server.js.
2. Helper unit pass on a VPS: `add-peer` (fresh + dup + second region), `list`, `status`,
   `remove-peer`; verify `wg show` peers and pool.json after each.
3. Panel E2E on testnet: create region with pubkey → copy string → gateway `2) Configure` →
   tunnel up → chip green → `nc` a raw stratum login through the gateway → share stamped with
   region (proves hot-bind worked **without** restarting `grin-pool-manager`).
4. Regression: CLI `W → 2` add for a *second* gateway while the panel-added one stays alive
   (syncconf must not drop the live tunnel); dup-pubkey re-add from the panel shows the
   `existing:true` banner and changes nothing.

### 13.9 De-rooting `grin-pool-manager` (part of this work)

**Why root is unacceptable here:** this one process parses untrusted input from the public
internet on TWO surfaces — the HTTP API behind nginx AND the raw stratum TCP socket (:3333,
arbitrary miners, JSON protocol parsing) — on top of a large npm dependency tree. Any RCE or
supply-chain hit is currently an instant **full root** compromise: hub WG private key (tunnel
impersonation + pivot into every gateway), node `.api_secret`s, Let's Encrypt keys, audit-log
tamper, persistence. Honest caveat: de-rooting does NOT protect the hot wallet — the backend
must be able to spend (payouts) by design, so a compromised backend can still drain it at any
privilege level (see `script07_security_audit.md` §Residual risks). De-rooting protects the
*box*, the *keys*, and the *other products* on it.

**Audit result (2026-07-13):** the running service has exactly ONE root dependency —
`readWgHandshakes()` (`index.js:50-70`: reads root-only `/etc/wireguard/*.conf` + runs
`wg show`). No `systemctl` calls, no other privileged ops; ports are unprivileged;
everything else is file-ownership convenience.

Plan (new `pool_deroot()` in the hub setup, runs on install + idempotently on upgrade):

1. **Service user:** `useradd -r -s /usr/sbin/nologin grinpool` (per-box, both nets share it).
2. **Ownership sweep:** `chown -R grinpool:grinpool` on `$POOL_APP_DIR` (app + pool.db + logs),
   `$POOL_CONF` (admin panel writes config), and the pool **wallet dir** (grin-wallet spawn +
   `.wallet_pass` + tor send dirs). Node secrets: `grinpool` needs read on the node's
   `.foreign_api_secret` — group-read via a `grinsecret` group rather than world-read.
3. **Unit changes:** `User=grinpool`, plus hardening now that it's meaningful:
   `ProtectSystem=strict` + `ReadWritePaths=` (app dir, wallet dir, conf dir), `ProtectHome=yes`,
   `PrivateTmp=yes`, `RestrictSUIDSGID=yes`. **Do NOT set `NoNewPrivileges=yes`** — it blocks
   sudo, which the helper path needs (revisit only if the helper ever moves to a socket-
   activated root service).
4. **Sudoers:** one file `/etc/sudoers.d/grin-pool-gwctl`:
   `grinpool ALL=(root) NOPASSWD: /usr/local/bin/grin-gateway-ctl` (helper is root-owned 0755,
   root-writable only — sudoers on a non-root-writable absolute path).
5. **Code swap:** `readWgHandshakes()` is replaced by the `gwctl('status')` wrapper
   (`sudo grin-gateway-ctl status --net …`); keep the existing silent-`catch` fallback so a
   box without the helper (old install, gateway-only role) degrades to share-recency status
   exactly as today.
6. **Migration on live boxes:** re-running hub setup applies user+chown+unit+sudoers, then
   restarts. Test order: testnet hub first; verify stratum accepts shares, admin login works,
   a payout round completes (wallet spawn as `grinpool`), THEN mainnet.

Blast-radius after: compromised backend = hot-wallet funds (unavoidable by design) + peer
add/remove via the validated helper. It can no longer read the WG/hub private keys, node
owner secrets, or write outside its own dirs.

### 13.10 Operational scenarios & disaster recovery (added 2026-07-13)

Five real-life scenarios, scoped honestly: two needed **new code**, three are **runbooks**
(documentation + small menu affordances). All belong to this work package.
*(Status 2026-08-22: both new-code items — (a) and (b) — are BUILT. The per-scenario
"New code" lines below are kept as the original scoping, each annotated with what shipped.)*

**a) Grin node rebuild (new api/foreign secrets) — mostly already automatic.**
`07_lib_pool_wallet.sh:577` already installs the shared secret self-heal
(`grin_node_secrets.sh` timer, every 5 min): a rebuilt node's new `.foreign_api_secret` is
re-applied to the pool wallet's `node_api_secret_path` without operator action
(`grin_sync_wallets` sweeps `/opt/grin/**/grin-wallet.toml`). **The uncovered half:** a
rebuild wipes the node's own `grin-server.toml`, losing the pool's stratum wiring
(`enable_stratum_server`, `stratum_server_addr` :3416/:13416, `wallet_listener_url` → :3420).
→ **New code — ✅ BUILT.** `grin_sync_pool_stratum` (`lib/grin_node_secrets.sh:576`) is in the
`grin_secrets_sync_all` chain and ships exactly as scoped: guarded on the pool conf existing,
re-applies `enable_stratum_server`, `stratum_server_addr` (from the conf's `node_stratum_port`,
defaulting to `3416`/`13416`) and `wallet_listener_url` → `:3420`/`:13420`, and does NOT restart
the node — it prints "RESTART the <net> node to take effect". It also re-applies the de-rooted
`root:grinsecret 640` mode a rebuild would reset to `600 root:root`. Runbook line: after any node
rebuild, `grin-secret-sync` once + restart node + check admin health page.

**b) Provider/IP change of the HUB — make endpoints DNS-based (small helper feature).**
Today `add-peer` bakes the ipify-resolved raw IP into every pairing string; an IP change
strands every gateway (each needs `wg_hub_endpoint` edited by hand). → **New code (cheap) — ✅ BUILT** (`pool_wg_endpoint_host`, menu `W → 5`; read by
`07_lib_gwctl.sh`):
optional `wg_endpoint_host` in pool.json (set once in helper/panel, e.g. `hub.grinium.net`);
when set, pairing strings carry `host:port` instead of the raw IP. WireGuard resolves the
name at `wg-quick up` — so a provider IP change becomes: update DNS A record → each gateway
`systemctl restart wg-quick@wg-grinpool` (or the toolkit's 3) Bring up tunnel). Existing
IP-paired gateways: one-field edit in `2) Configure` (manual path already supports it).
*(Superseded in part 2026-09-23, §13.13.3: a gateway now runs a **re-resolve timer**, so with a
DNS-name endpoint it follows a hub IP change within ~2–3 min of the DNS change with no restart
on the gateway box. The raw-IP case is unchanged: `2) Configure` the new endpoint, then `3)`.)*
Gateway IP changes need nothing on the hub (gateway dials out) — only the miner-facing DNS
(`stratum_url` in pool_locations) moves.

**c) Hub disaster recovery — NEW `07_lib_pool_backup.sh` on the shared engine.**
The pool hub is the ONLY money-holding product without backup today (solo has
`07_solo_backup.sh`, drop has `059_lib_backup.sh`, both on the shared `grin_backup_engine.sh`
gbe_*/gbp_* + offsite push). Same model (personal key, `grin_pubpool_backup_DDMMYYYY`,
daily cron, scp push). Backup set — everything a fresh `07` install can't regenerate:
`pool.db` (balances/shares/audit — snapshot via SQLite `.backup` or two-phase tar like 059,
never a live copy of a WAL db), `$POOL_CONF` (incl. `region_ports`), wallet dir (seed +
`.wallet_pass` + tor keys), WG identity (`$WG_DIR_CONF/server_*.key` + `/etc/wireguard/wg-grinpool*.conf`
— restoring these means **gateways reconnect with zero re-pairing**), nginx vhost + cert
note. Restore runbook: fresh box → Script 01 node (or restore alongside) → `07` hub install
→ restore backup → `grin-secret-sync` → re-point DNS (trivial if (b) is DNS-based) →
gateways reconnect on their PersistentKeepalive with no operator action on any gateway box.
*(⚠ Corrected 2026-09-23 — that last clause held only when the restored hub keeps its IP.
WireGuard resolves a hostname `Endpoint` once, at `wg-quick up`, and PersistentKeepalive keeps
sending to the address it already has. Three cases, now stated the same way in
`07_lib_pool_backup.sh`: **same IP** (rebuild in place) → gateways reconnect on their own;
**new IP + DNS-name endpoint + re-resolve timer** → they follow within ~2–3 min of the DNS
change, no action on the gateway box; **new IP + raw-IP endpoint** → on each gateway,
`2) Configure` the new endpoint, then `3)`. A planned move to a new box is now its own guided
flow, Migrate OUT / Migrate IN — §13.13.4.)*

**d) Gateway disaster recovery — runbook only, by design (< 5 min).**
A gateway's total state = `grin_gateway.json` + one WG keypair; everything else is
regenerated. Two paths: (1) *no backup needed*: fresh box → Gateway `1) Install` (new
keypair) → panel: unpair old key / pair new pubkey (region **keeps** its tunnel IP + port by
the existing replace-guard) → paste new GRINGW1 → up; miners' DNS unchanged if the new box
takes over the IP, else one A-record flip. (2) *with the (c) engine, optional*: a tiny
`grin_gateway_backup` tar of `/opt/grin/gateway` + `/etc/wireguard/wg-grinpool.conf` +
`grin_gateway.json` restores the SAME identity — no hub-side action at all. Document both;
(1) is the primary story because it needs nothing prepared in advance.

**e) Hot-wallet switch (compromise / corruption) — runbook + menu option.**
Safe by architecture: miner balances/owed amounts live in **pool.db**, not the wallet, so
swapping wallets never loses accounting. Procedure (new hub menu entry "Replace pool
wallet", also documented for manual use): 1 pause payouts (admin toggle) → 2 move old wallet
dir aside → 3 `grin-wallet init` fresh (new seed, recorded offline) → 4 re-run the existing
wallet setup path (toml patch, `.wallet_pass`, ECDH unlock, node `wallet_listener_url`
re-patch + node restart — all existing `pw_*` code) → 5 sweep old wallet balance → new
wallet from a separate box/dir (old seed still valid unless truly compromised; if
compromised, sweep FIRST, fastest wins) → 6 resume payouts. Coinbase maturity note: rewards
mined to the old wallet in the last 1440 blocks must mature before the sweep completes —
keep the old dir until balance is zero.

### 13.11 Out of scope (deferred)

**Level 2 token enrollment** — panel mints a one-time token; gateway box POSTs its pubkey to a
public `POST /api/gateway/enroll` and receives the pairing payload (zero human key-carrying).
Bolts onto this design (same helper, same response shape); revisit only if third-party
operators run gateways at scale.

### 13.12 Panel-side multi-region bootstrap + onboarding fixes — IMPLEMENTED 2026-08-22 (NOT VPS-tested)

§13.1 promised "pair a gateway without an SSH session on the hub". That was **false for
every pool that had never gone multi-region**: `add-peer` requires `/etc/wireguard/wg-grinpool*.conf`,
which only `pool_wg_setup_server` (menu `W → 1`) created. Worse, the panel's region save
upserted `pool_locations` **before** calling the helper — so the first attempt left a saved
region card *and* a 502 naming an SSH menu the how-to never mentioned. A flow-trace of both
routes (bash + panel) found seven more onboarding defects around it; all are fixed here.

**a) `grin-gateway-ctl init-server` — the hub tunnel becomes a helper subcommand.**
Package (install, retrying once behind `apt-get update`), keypair, `/etc/wireguard` conf,
firewall UDP rule, `wg-quick up` + enable, `region_listen_host` in pool.json. Idempotent by
construction: an existing conf is **kept** (regenerating rotates the hub key and strands every
paired gateway) and a live interface is **synced, never bounced**. Also re-derives a missing
`server_public.key` from the private key — otherwise an interrupted first run makes every
later pairing string carry an empty hub key. Emits the usual single JSON object.

**b) `pool_wg_setup_server` is now a thin caller over (a).** It was a second implementation of
the same steps; the tunnel net, listen port and conf layout had to be kept in sync by hand
across two files. Same posture as `add-peer`/`remove-peer`/`list` since §13.5.

**c) Panel: `GET`/`POST /api/admin/gateways/server`.** GET is the page's pre-flight (`ready`
true/false, never an error — "no tunnel" is the normal state of a single-box pool); POST runs
init-server behind `freshAdmin` step-up (raising a tunnel is at least as sensitive as pairing a
peer, which is already step-up gated) with a 180s exec timeout, audits `gateway_server_init`,
and mirrors `region_listen_host` into the live config. `regions.html` renders either an
**Enable multi-region** banner or the hub's coordinates.

**d) The half-write is gone.** `POST /api/admin/locations` now pre-flights with a read-only
`list` **before** the upsert when a `wg_pubkey` is present, returning **409 `wg_server_missing`**
and writing nothing. The client checks that flag *before* the existing `wg_error` branch, which
would otherwise report "region saved" about a request that saved nothing.

**e) CLI `add-peer` parity with `remove-peer`.** Remove already `DELETE`s the `pool_locations`
row; add only printed "remember to declare it", which is how a region ends up wired but invisible
on the connect grid. Add now inserts the card with `is_active = 0` — visible in admin, not on the
public grid, because there is no stratum hostname to publish yet.

**f) The CLI restart is now a choice, not a surprise.** Panel pairing hot-binds; the CLI runs
outside the process and can only restart `grin-pool-manager`, which drops every miner on **every**
region. It now says so and asks, and names the panel as the no-restart path.

**g) Gateway box: firewall + honest next-step.** `gw_install` never opened the public stratum
port (the hub opens its own wg port), so a box with active ufw finished pairing green and refused
every miner. New `gw_open_firewall` runs from Install and Configure; `gw_status` reports the ufw
rule beside the listener. Install's tail said "Next: 2) Configure" — the one thing the operator
must *not* do, since the pairing string does not exist yet; it now stops and points at the hub.

**h) DNS is a step.** The A-record (pointing at the **gateway** box, not the hub) was a
parenthetical; it gates the Port-check column, so its absence read as a broken gateway. It is now
its own numbered step in the panel how-to and is printed by both `gw_configure` and CLI add-peer.

**i) `gw_configure` silent no-op.** The region-port prompt composes `hub_endpoint` from two
answers and dropped the port when the hub tunnel IP was still blank, with no message. It now says
what was not saved and why.

**Second pass (same day) — six defects found reviewing (a)–(i):**

**j) A readable conf is not a running tunnel.** `list` reported only that `$WG_CONF` exists, so
the panel's readiness light went green on a hub whose interface was down — the state in which
*every* gateway is dark. `list` now carries `interface_up` (`wg show`), the GET forwards it, and
the banner has a third state: **set up, but the tunnel is DOWN**, whose button is the same
idempotent `init-server` (keeps the keypair, so nothing needs re-pairing).

**k) `Auth.fetch` resolves `null` on failure — it never throws.** `loadServerState`'s `try/catch`
was therefore dead code, and a failed/rate-limited request fell through to `!d.ready` and nagged a
healthy pool to enable a tunnel it already runs. It now moves state only on `d.success === true`;
`_mrReady` is tri-state (`null` = never answered, and `null` is not evidence of anything).

**l) `_mrReady` was written and never read.** It now short-circuits a save that carries a
`wg_pubkey` while the hub is known-not-ready — otherwise `adminFetch` prompts for the step-up
password on the way to a guaranteed 409.

**m) `synced:false` was invisible in the panel.** `add-peer` reports when `wg syncconf` did not
load the new peer into the running interface; the CLI has always warned, the route dropped the
field and reported plain success. The symptom then appears on the *gateway* box and reads as a
pairing fault. Now returned as `sync_warning` and shown on the pairing card.

**n) The CLI's `pool_locations` insert could create a root-owned `pool.db`.** `node:sqlite` opens
create-if-missing, so (e) would have created the database — and, in WAL mode, `pool.db-wal`/`-shm` —
owned by root, after which the de-rooted `grinpool` service cannot open its own database. Guarded
on the file already existing, and the WAL sidecars are chowned back unconditionally.

**o) `apt-get` did not wait for the dpkg lock.** A fresh VPS is usually mid-`unattended-upgrades`;
without `-o DPkg::Lock::Timeout=60` both install attempts fail instantly and the operator is told
wireguard-tools "could not be installed" by a box that was merely busy for 20 seconds.

Also corrected in the same pass: the new-region tail ("two things left", DNS, region card) was
printing on the **box-replacement** path too, where all of it is already done; add-peer's
prerequisite error named only the SSH menu; and the CLI's "publish it" hint omitted that the
region card's **Active** checkbox is what actually publishes it.

**p) THE BLOCKER: `ProtectSystem=strict` made every panel-side WireGuard write fail.** Found
answering "is this ready to test?", before any of it ran. The hardened unit (§13.9) builds a
**mount namespace**, and a namespace is inherited by every child — *including one that becomes
root through setuid `sudo`*. Gaining root does not get you out of it. `/etc/wireguard` was not in
`ReadWritePaths`, so `sudo grin-gateway-ctl add-peer` ran as root and still could not append a
`[Peer]`. This was never an `init-server` bug: it broke **`add-peer` and `remove-peer` too**,
i.e. the whole §13.1 promise of "pair a gateway without an SSH session", for every de-rooted box.
`list` and `status` are reads, so the pre-flight, the readiness banner and the health column all
kept working — the page looked healthy right up to the moment you saved. `NoNewPrivileges` was
already deliberately absent with a comment about this very sudo path; the mount namespace simply
was not the part that got considered.

Fixed by opening exactly one path and moving the rest off the request:
- `ReadWritePaths` gains `-/etc/wireguard`. DAC still applies inside the namespace, so `grinpool`
  cannot write those root-owned files itself — only the scoped helper can.
- New `pool_ensure_wg_prereqs()` installs `wireguard-tools` **and creates `/etc/wireguard`** at
  pool-install time. Both must happen before the unit starts: `apt` can never run inside the
  namespace (`/usr`, `/var` read-only), and `ReadWritePaths` is bound at service **start**, so a
  directory created later is not writable in the already-running service's namespace.
- The update path does not rewrite the unit, so `pool_deploy_code` now detects a pre-§13.12p unit
  (`ProtectSystem=strict` without `/etc/wireguard`) and says which operations will fail.
- Steps that remain outside the namespace are reported instead of swallowed: `systemctl enable`
  (writes `/etc/systemd/system`) returns `boot_enabled`, and `ufw allow` already returned
  `ufw-failed`. Both surface as persistent **caveats** on the page — the tunnel is up, but a
  reboot loses it / the UDP port is still shut, and neither has a local symptom.
- Error strings now name the namespace and the fix, rather than saying "install it manually".

`/etc/systemd/system` and `/etc/ufw` stay closed, deliberately: those two steps are worth one SSH
command, and widening the unit for them would trade the whole point of de-rooting for convenience.

Accepted risk, not fixed: `init-server` may still install a package inside an HTTP request when
run on a box where the installer's `pool_ensure_wg_prereqs` did not succeed, so an `execFile`
timeout can interrupt `apt`. The 180s budget makes that unlikely, and the common path no longer
touches apt at all.

Unchanged and deliberately so: the shared-helper architecture, the GRINGW1 string, the dup-key
and same-region guards, and the §13.11 token enrollment (still deferred — these fixes reduce the
manual hops but do not remove the two hand-carried payloads).

**q) `1) Install` was not safe to re-run — and (p) makes re-running it the documented fix.**
Prescribing "re-run Install once to pick up the new unit" turned a first-run-only assumption into
a data-loss bug. `pool_install`'s rsync was `rsync -a --delete "$POOL_APP_SRC/" "$POOL_APP_DIR/"`
with **no excludes**, so on an already-installed box it mirrored the checkout and deleted every
runtime artefact the app owns: `pool.db` (every miner's balance), `.wallet_pass`, `custom_assets`,
`uploads`, `node_modules`. On a first install `POOL_APP_DIR` is empty and each exclude is a no-op,
which is exactly why the gap survived — the bug is invisible until the step is run a second time.
`pool_install` now carries the same exclude list as `pool_deploy_code`.

The same audit found `uploads/` (CMS media from the admin editor) missing from `pool_deploy_code`'s
excludes, so **every code deploy silently pruned it** — independent of (p), and older. The comment
on the nginx `/uploads/` block asserted the opposite, and its reasoning is the trap worth naming:
living *outside* `public_html` protects a dir from the **docroot** rsync in `pool_deploy_web`, and
not at all from the **backend** rsync, which `--delete`s `POOL_APP_DIR` itself. Both comments are
corrected, and the rule is now stated where the next author will be adding a runtime dir: every new
dir the app writes under `POOL_APP_DIR` needs an exclude in **both** rsyncs.

**r) A failed "Enable multi-region" was indistinguishable from an ignored click (found 2026-09-19,
first live report).** The operator clicked, confirmed, and minutes later saw the same banner with the
same pre-flight reason (`wg-grinpool.conf missing`). Three independent gaps, all fixed:
- **Every `flash()` in the admin panel rendered nothing.** `pool.css` gave `.error-msg` /
  `.success-msg` `display: none`, and each page's `flash()` reveals with `el.style.display = ''` —
  which only removes the element's inline `display:none` and then defers back to the stylesheet's.
  So the red "Could not enable multi-region: …" was never painted, on this page or on miners,
  payments, pages, posts, ads or users (all use the pattern; all have carried it since the
  2026-06 merge). The `display:none` is gone from the two rules — every element that uses them
  already hides itself inline, which is where the initial state belongs.
- **The failure did not stay on screen, and was not where the operator was looking.** `flash()`
  targets `#r-msg` on the *Add or edit a region* toolbar, three cards below the banner, and
  clears in 5 s; `#mr-reason` describes the STATE and is untouched by a failed attempt. The
  banner now has a persistent `#mr-error` under the button — cleared on retry, hidden when the
  tunnel reads as up — carrying the helper's message plus the journal / `W → 1` fallback. The
  fallback is **omitted when the 403 carries `step_up`** (the browser-side refusal below): nothing
  reached the pool then, so "check the journal" would be false and SSH the wrong next step.
- **The box kept no record.** The POST route audits `gateway_server_init` only on success and its
  catch did not log, so a failed enable left nothing in the journal either. It now
  `console.error`s. `gwctl()` also names a **timeout** explicitly — a helper killed at 180 s
  prints no JSON, and execFile's bare `Command failed: sudo -n …` read as an instant failure.

A fourth gap turned up on the same path while reading the evidence: the `/api/admin/` nginx block
had `proxy_read_timeout 30s` under a route whose helper is budgeted **180 s** (the apt path). On
that path nginx would 504 the browser while init-server kept running to success — "Enable failed"
about a tunnel that came up seconds later. Raised to 200 s (re-run **4) Setup nginx** to apply).

On the reporting operator's box the evidence cleared every server-side candidate: the sudo journal
showed the page's `list`/`status` reads and **no `init-server` call at all**, the helper carried the
subcommand, sudoers/`ReadWritePaths`/`wireguard-tools` were all in place, and an in-namespace
reproduction (`nsenter -m` → `runuser -u grinpool` → `sudo -n … init-server`) succeeded first time.
So the POST was refused **before** the handler. The nginx access log settled which gate: one
`POST /api/admin/gateways/server … 403` with a **53-byte** body — exactly
`{"error":"Session expired","challenge_required":true}`, the `requireFreshAuth` step-up challenge
(the 2FA refusal is 131 bytes) — and **no `POST /api/admin/reauth` after it**. The password prompt
`adminFetch` opens on that challenge was closed without a password: the operator's own account was
"clicked Enable and OK", i.e. OK on the *second* dialog, the prompt, with nothing typed — which
`reauth()` treats as cancel. `adminFetch` then handed back the original 403, the caller threw
`"Session expired"` (false: the session was fine) into the dead `flash()`, and the button reset.

Fixed at the two places the story went wrong, on top of (r)'s visibility fixes:
- `stepup.js` `reauth()` now resolves `{ outcome: 'ok' | 'cancelled' | 'failed', reason }`, and
  `adminFetch` answers a cancelled or failed step-up with a **synthetic 403** whose body says what
  happened ("Not done — this action needs your admin password and the authorization dialog was
  cancelled…"; `step_up: 'cancelled'|'failed'`, the failure `reason` inlined). Every caller
  prints `body.error` verbatim and none matched the literal text, so this corrects payments,
  users, miners and settings in the same edit.
- The Enable confirm() now says a password box may open next, and how to complete it.

Verified locally by driving `adminFetch` through a stub `fetch` + empty `prompt`: one request, no
reauth call, no retry, 403 with the new body. Note the operator's own reproduction
(`nsenter … init-server`) had already raised the tunnel, so the panel path was not re-clicked.

**Second live finding, same day, after deploying the above:** the operator clicked Enable, got
the new red "Not done — … the prompt was closed without one" — and **no password prompt had
appeared at all**. That branch is reachable only when `window.prompt()` returns null/empty, so
the browser (Firefox 156) had refused to open it. The pattern is exactly what browsers throttle as
"successive dialogs": the step-up prompt comes ~200 ms after the action's own `confirm()` closes,
from an async continuation (the 403 has to arrive first), i.e. without user activation. Which
rule fired is not knowable from the page, and does not matter: a page cannot tell a suppressed
native dialog from a Cancel, so **`window.prompt()` is the wrong tool for the step-up** — and it
had also been echoing the admin password in cleartext. `stepup.js` now opens an **in-page
dialog** (built lazily from the panel's own `.modal-overlay`/`.modal` rules in `pool.css`, which
every admin page loads; masked `type=password`, `autocomplete=current-password`; Enter submits,
Escape/Cancel/backdrop cancel, focus returns to the button). Null now means the operator's own
decision, and the message says "the authorization dialog was cancelled". Flow: a wrong password or
code re-opens the dialog with the server's reason (a typo must not cost the whole action); the
second factor is a separate code-only step, asked only after the pool accepted the password
(`/api/admin/reauth` verifies before it answers `totp_code_required`); a lockout or budget
refusal ends the loop and the 403 carries the retry time; concurrent protected requests share one
dialog. Verified with a stub DOM through nine scenarios (three cancel paths, empty submit, wrong→
right password, 2FA with a wrong code, lockout, two-at-once, fresh session). NOT VPS-tested.

**s) The gateway was asked for a number only the hub knows (found 2026-09-19, first live
pairing).** The Regions card for `yyz` read `stratum+tcp://yyz.grinium.com:3333 · ✗ :3333
unreachable · 🔒 1m ago · ● Active` — a healthy tunnel and a dead port — while `ss` on the gateway
showed haproxy on **:13333**. Every region is advertised on the pool's single public port
(`regions.html` appends `STRATUM_PORT` to the host, and the Port check dials the same URL), so the
gateway has exactly one right answer for "Public stratum port", and it cannot derive it: the value
lives in the hub's `pool.json`. Yet `gw_configure` *asked*, and its prompt printed the saved value
in brackets, so the 13333 typed once (the pool's testnet number) came back on every later run
looking like a default — the operator's reading, reasonably, was "the setup says 13333". Two
"command not found" lines from the heredoc trap (memory `reference_bash_unquoted_heredoc_backticks`)
printed in the same screen, which did not help the prompt's credibility.

Fixed at the source: `grin-gateway-ctl` reads `stratum_port` from `pool.json` (per-network default
when absent) and appends it as the pairing string's **8th field** in both emitters (`add-peer` and
`list`, so the panel's Save, its 🔑 re-print and the SSH menu all agree); the response JSON also
carries `public_stratum_port`. `gw_apply_pairing_string` accepts 7 or 8 fields (a string from an
older hub still works), validates the port, writes `public_stratum_port` and says so when it
changed the saved value; it also strips CRs, since the last field is now a number a Windows
clipboard would turn into `3333\r`. The prompt gained the missing sentence — the POOL's port, where
to read it (admin → Regions shows `Port :NNNN`), and that a current pairing string fills it in.
Compatibility edge: an 8-field string on a pre-fix gateway is **rejected** (bash `read` folds the
extra field into `region_port`, which fails the digit check) — pull both boxes together; documented
in the implementation doc's format row. Same day, `5) Status` gained an **On reboot** line: the
forwarder and the tunnel are enabled by two different menu steps (`1)` and `3)`), each `|| true`,
and a box missing either reboots into `:3333 listening` with nothing behind it — which the Port
check reads as ✓. Verified with stubs: hub emitter (default / explicit / missing key, both
emitters), gateway parser (7 fields, 8 fields, CR, bogus port, out-of-range, 9 fields, unchanged
port), Status in all four enabled/disabled combinations. NOT VPS-tested.

**t) Status cried wolf about ufw (found 2026-09-20, first live gateway).** With the port fixed by
(s), the gateway's `5) Status` read `:3333 listening · ufw is ACTIVE but :3333 is not allowed —
miners will be refused`, and re-running `1) Install` and `2) Configure` (both call
`gw_open_firewall`) changed nothing. The actual unreachability was a wrong A record; once that was
corrected miners connected — *while Status still showed the warning*, which is only possible if ufw
was never active on that box. The cause: (g)'s three ufw tests in `07_lib_gateway.sh` and
`07_lib_gwctl.sh` were the bare `ufw status | grep -q active`, and a disabled ufw answers
`Status: inactive` — a string that contains `active`. So an inactive ufw was "active": Configure
printed `ufw: opened 3333/tcp` (a rule on an inactive ufw does nothing), Status found no rule table
to match and warned forever, and on the hub `init-server` reported `firewall: ufw` for a UDP port it
had not opened. Every other script in the repo already anchored the test (`"Status: active"`); the
three Script-07 sites now do too. The unmanaged branch also stopped being a blank: Status now says
`host firewall: none active — not what blocks :3333`, checks `iptables -S INPUT` for a raw
DROP/REJECT (the Oracle-image trap that `ufw status` never shows) and points at the provider's
network firewall, and firewalld gained the `--query-port` readout ufw always had. Configure's order
is unchanged and deliberate: the port is opened at the END, after the pairing string may have
changed it — opening "as soon as the port is entered" would open the stale number. Stub-tested
(inactive / active-no-rule / active-rule / `on eth0` rule / raw-iptables REJECT).

### 13.13 Hub move (Migrate OUT / IN) + connect-page latency — BUILT 2026-09-23 (NOT VPS-tested; adversarial review done 2026-09-23, 6 fixes)

Built in seven parts on one day, to move the mainnet hub from New York (racknd) to **OVH
Gravelines, France**, with gateways in New York, Los Angeles, Hong Kong and Toronto. Two tracks:
**the move** (seeds, gateway re-resolve, Migrate OUT, Migrate IN) and **the connect page**
(estimate, probe endpoints, browser measurement). The as-built detail (files, keys, manifest
schema, runbook) is impl §8.7; this section keeps the *why*. **Nothing here has run on a VPS.** The
adversarial review (money path first) ran the same day: six confirmed defects fixed, twelve
plausible ones reported — the security audit's Status roll-up ("Part 9 review") has the table,
and §13.13.6 below what is still open.

#### 13.13.1 The evidence behind the placement

A 2026-09-23 survey of the big Grin pools (DNS → geolocation) found three of four HK-centred —
their "US" and "EU" hostnames alias one HK box — and the two real non-Asia cores in **Germany**.
Nobody runs a real central-US server. Globalping from the same probes to Gravelines and Strasbourg:
the two differ by ~1–15 ms everywhere, but **HK → EU ranged 159 / 182 / 248–265 ms by the HK
provider's route**, and Singapore → Gravelines direct (148–162 ms) beat Singapore → HK gateway →
hub. That is where the §4 effective-latency rule comes from. Operator lesson: mtr-test a gateway
provider's route to the hub on a monthly term before committing.

#### 13.13.2 Seeds v3 and the moved hub's own region (`lib/db.js`)

**Seeds v3** adds `hkg` Hong Kong, `sin` Singapore and **`cqf` Gravelines** — seeded INACTIVE on
grinium domains only, like every seed. `cqf` is the IATA code of Calais–Dunkerque, the airport
nearest OVH Gravelines (~15 km); `gra` and `lil` are the obvious wrong guesses and the code comment
says so.

**The trap it had to fix (F3).** The old hub (local region `nyc`) seeds `cqf` inactive, and
`ensureLocalRegion` deliberately never re-activates a row — that rule is what keeps an operator's
"switch this region off" from being undone by a restart. So a hub moved to `cqf` would have stayed
**unpublished** forever: no connect card, no map marker, and nothing in any log. The fix persists
the local region the DB last saw (`pool_config` `_state`/`local_region`). When the configured
local region **differs** from the stamp, the new row is activated **once** and the stamp updated,
in one transaction; the old row is left alone (that box may become a gateway). A restart with an
unchanged region still never re-activates anything. **No stamp means unknown, not "moved"**: it is
only stamped, never used to activate — otherwise every upgrade of an existing pool would re-publish
a row its operator had switched off. That is why Migrate IN writes the OLD tag as the stamp when an
archive predates the stamp (§13.13.4). ⚠ `ensureLocalRegion` runs for `singlebox` only; a
mining-less `hub` role has no local row.

#### 13.13.3 Gateways follow a hub IP change — the re-resolve timer (F1)

WireGuard resolves a hostname `Endpoint` once, at `wg-quick up`, and a gateway writes a static
`Endpoint`. So "gateways reconnect with no action" was only true when the hub kept its IP (§13.10c,
now corrected). A gateway now installs `grin-gateway-reresolve` (a oneshot service + a 60 s timer,
`AccuracySec=5s`), the same logic as WireGuard's upstream `contrib/reresolve-dns`: if the peer's
endpoint is a hostname and its last handshake is older than 135 s, `wg set … endpoint host:port`,
which makes WireGuard resolve the name again. Design choices, each with a reason:
- The source is the rendered WG conf (what `wg-quick` actually loaded), not `grin_gateway.json`.
- A key that is not on the interface is **skipped**, not set — `wg set peer <unknown>` would ADD a
  peer.
- The unit keeps `CAP_NET_ADMIN` and deliberately has **no** `PrivateNetwork` (a private netns has
  no wg interface, so the unit would succeed while doing nothing) and no `PrivateDevices`
  (`/dev/log`).
- It is installed by `3) Bring up tunnel`; existing gateways get it the next time the operator
  runs `3)`. `5) Status` warns when the endpoint is an IP literal, and the hub prints a warning
  under every `GRINGW1` pairing string while `wg_endpoint_host` is empty.

**F2 — the old hub's tunnel must go DOWN at cutover.** Re-resolve fires only on a stale
handshake. While the old hub still answers, handshakes stay fresh and every gateway stays attached
to the old box. Migrate OUT therefore stops *and disables* the hub's `wg-quick@` unit.

**What a hostile DNS answer can do:** WireGuard's key authentication still holds, so a wrong IP
cannot impersonate the hub; the tunnel simply does not come up until DNS is right. The
re-resolve timer adds an availability dependency on DNS, not a confidentiality one. (The
adversarial review should confirm that reading.)

#### 13.13.4 Migrate OUT / Migrate IN — the order IS the safety design (F4)

Menu `B → 6` (old hub) and `B → 7` (new box), in `scripts/lib/07_lib_pool_migrate.sh`. The one
outcome it exists to prevent is **two live pools on one wallet seed**: two hubs both accepting
shares means two ledgers owing the same miners, and two wallets spending the same outputs. Every
step is ordered around that.

**Migrate OUT** (typed `MIGRATE`):
1. **Preflight, read-only.** In-flight withdrawals are listed using the statuses the *deployed*
   scheduler itself treats as pending. They are not a hard stop — the DB and the wallet are
   snapshotted *after* the stop, so they move together — but a second typed `PROCEED` is needed.
2. **Freeze payouts first**, before anything stops, so the scheduler cannot start a payout while we
   wait. It is the same SQL the restore uses, now one shared helper (`pbk_freeze_payouts`), so the
   two can never drift. A freeze someone else had already set is kept in the manifest
   (`payout_control.before`), so its reason is not lost.
3. **Wallet evidence**: the watchdog cron and `@reboot` line are removed *first* (the 5-minute
   watchdog would otherwise relaunch the listener during a minutes-long `info`), then the listener
   is stopped, then `grin-wallet info` runs as the service user with the passphrase on stdin.
4. **Stop and disable** the pool service, the hub WireGuard (stop the `wg-quick@` unit, not just
   `wg-quick down`, or the rollback's `enable --now` is a silent no-op — F2), and the daily backup
   cron (it writes the SAME archive name and would replace the migration archive). The node keeps
   running.
5. **Manifest** in the app dir, so it rides inside the archive: net, source IP, domain, local
   region + its stamp, WG endpoint, node height, wallet evidence, and ledger continuity figures —
   counts, sums, max ids **and per-row sha256 digests** of accounts, blocks, withdrawals and
   balance_log.
6. **Strict archive** (every critical path that exists must be in it) plus a `.sha256` sidecar,
   verified by decrypting it again. **D4: the Let's Encrypt material rides in this archive only**
   — `live/` symlinks stored as symlinks, `archive/`, the renewal conf, and `accounts/` (renewal
   conf names an account id; without it the first renewal on the new box fails ~60 days later).
   Daily backups still exclude certs.
7. Optional push to the new box by scp (remote sha256 compared).
Any failure after step 2 leaves the pool **frozen**, prints the state and a resume ("run B → 6
again" — every step is idempotent) and the rollback commands. Rollback is valid only while the
new hub has accepted no share and paid nothing.

**Migrate IN** (typed `MIGRATE`, or `CHECK` for the read-only box checks):
- **Run `CHECK` before Migrate OUT.** A missing install, an unsynced node, or an unwired node
  stratum (only a node restart fixes that) is fixed while the old hub still serves, not inside
  the downtime window.
- **Archive + manifest gate.** The newest archive with a sidecar is the default; the manifest's
  `archive_name` must equal the archive's name (a later daily archive of a once-migrated box
  carries the old manifest), an old manifest needs `PROCEED`, the node must be at or past the
  manifest's height, and a **clobber guard** refuses to overwrite a local ledger that has newer
  shares unless `OVERWRITE LEDGER` is typed.
- **Dark gate.** IN refuses to start while the old hub answers — a TCP dial of its stratum AND a
  pinned `https://<domain>/api/health` to the old IP that must *parse* `status: ok` (an HTTP 200 is
  not proof). **Dark needs the old box's own "no" on both:** a TCP RST from its stratum port, and
  an HTTP answer from its :443 that is not the pool (Migrate OUT leaves nginx up, so a dark hub
  answers 502). A firewall answers for a box too — a DROP times out, firewalld's default reject
  says "No route to host" — so a timeout, a no-route or a :443 that answers nothing is **unknown**,
  never dark, and needs a typed `OLD HUB IS DARK` (review C6). The probe runs again immediately
  before the pool starts. Same public IP = a rebuild in place, skipped.
- **The restored pool cannot start by accident.** 1) Install enabled the pool unit; IN disables it
  before extracting and only step 7 enables it again, so a failure plus a reboot never starts the
  old hub's seed unattended (review C2). Backend code (`index.js`, `package*.json`) is never taken
  from an archive — this box's checkout is kept (review C3).
- **Restore frozen** (`frozen_by` = `migrate-in`), then the new location (tag, label, country,
  lat/lng; writes the old tag as the F3 stamp when the archive has none), then bring-up: secret
  self-heal, the grin-wallet binary pinned to the restored version, web files, tunnel, nginx.
- **Continuity** compares 18 ledger figures, the per-row digests and the wallet identity with the
  manifest, using the *manifest's* in-flight SQL (newer code must not make equal ledgers differ).
  A sum + count match alone would pass two swapped balances; the digests do not. The wallet must
  refresh from this node and match the recorded total. **Any ✗ stops before the pool starts.**
- **Start**, then a DNS screen listing exactly which records to change, then a watch screen per
  region (handshake age, last share, miners). Unfreezing is **never** done here: reconcile, then
  resume in admin → Payouts.

**Downtime estimate (never measured):** ~15–30 min of miner downtime — OUT 3–8 min (the wallet
refresh dominates) + IN 5–12 min + DNS 1–5 min at a 60 s TTL; gateways follow ~2–3 min after DNS.
The testnet rehearsal must measure it.

#### 13.13.5 Connect-page latency — estimate first, measurement wins

Decision: **show an estimate instantly, replace it with the browser's own measurement, fall back
to the estimate.**

**A — the estimate** (`GET /api/pool/connect/suggest`, `lib/connect-suggest.js`). The viewer is
placed at their **country centroid** (geo-IP, country level only). A server sits at its declared
lat/lng, else its country centroid. RTT ≈ great-circle km × 0.015 ms (calibrated against the
2026-09-23 Globalping set; within ±25% of every sample). A gateway's figure is viewer→gateway **+
`hub_rtt_ms`**; the direct figure is viewer→hub. Offline regions, gateways with no measured
`hub_rtt_ms`, and rows with no position are skipped. **Same-country trap:** seeded rows carry no
lat/lng, so a seeded gateway sits exactly where a same-country viewer is placed — 0 km, i.e. every
US visitor "inside" the NYC datacenter. A centroid-placed server in the viewer's own country is
therefore given a typical in-country distance instead. It is still crude: **operators should
declare lat/lng on every gateway row** (admin → Regions). Privacy: the IP is resolved to a country
for this one computation and dropped — not stored, logged or echoed, and nor is the country;
`Cache-Control: private, no-store`.

**`hub_rtt_ms`** (on `/api/pool/stats/regions`) is the minimum of the last 5 successful TCP
connects from the hub to each gateway's **public** stratum port — about one hub↔gateway RTT on
the path the tunnel takes, but not the tunnel itself. `0` on the hub's own row, `null` before a
first successful probe. `is_hub` marks the direct row (on a `singlebox` only).

**B — the measurement.** Each server answers `GET /ping` with an empty **204**, CORS `*` and
`Timing-Allow-Origin: *` so the page can read Resource Timing cross-origin.
- **Hub:** a `/ping` location in the main vhost, via a named location — a bare `return` runs in
  nginx's rewrite phase, *before* `limit_req`, so it would never be rate-limited (measured on nginx
  1.24: 40 rapid requests → 40 × 204 bare vs 20 × 204 + 20 × 429 this way). Behind a CDN the hub
  cannot be timed directly, so the operator may set `latency_hub_url` to a DNS-only name under the
  probe domain; unset behind a CDN = the hub keeps its estimate.
- **Gateway:** `6) Latency probe` runs a **separate** HAProxy instance (`grin-gateway-probe`), not
  a frontend inside the forwarder — the forwarder's pre-start `haproxy -c` covers its whole config
  (a bad or missing pem would stop stratum), and it has no reload (every certificate renewal would
  drop every miner). It serves one 204 route, 30 requests / 10 s per IP, TLS ≥ 1.2, no logs, no
  backend. Its certificate comes from certbot standalone, so `:80` is bound only for the seconds of
  an issue or renewal.
- **CSP.** The public page's `connect-src` gains `https://*.<probe_domain>`. `probe_domain` is the
  pool's own subdomain and **never derived wider** (a public-suffix trap: `pool.example.co.uk` →
  `co.uk`); `latency_probe_domain` may name a *parent* of it, nothing else. The admin CSP stays
  `connect-src 'self'`.
- **The page** (`reactor-dashboard.js`) measures once the connect panel is first in view: a
  warm-up, then 3 sequential probes → the minimum; a failed warm-up ends it (an unanswering host
  would otherwise cost four 2.5 s timeouts); only a 204 counts. A gateway's measured figure is
  its leg **+ `hub_rtt_ms`**. Results are cached per URL for 10 min in sessionStorage; a rate-limited
  **Re-test** control re-measures. The ranking rule (`pickRecommended`, direct wins within the bias)
  is one function in `lib/connect-suggest.js` with a copy in the page, and the page takes the bias
  from `/api/public/branding` → `connection.latency.direct_bias_ms`, so there is no second literal;
  a test runs both copies on 2,000 generated cases.

**Known limits (for the review):** a ranking that mixes a measured row with an estimated row
compares two instruments, so the estimate's ±25% can flip a near tie; a gateway probe name proxied
through a CDN would answer from the CDN edge and read as near — only DNS-only probe names mean
anything.

#### 13.13.6 Still open

- **Adversarial review — DONE 2026-09-23** (audit Status roll-up, "Part 9 review"). Fixed, each
  proven by a failing harness scenario first: a Migrate OUT across local midnight made its own
  archive unusable to Migrate IN (C1); Migrate IN left the pool unit that 1) Install enabled
  enabled across a failure, so a reboot started the restored pool (C2); archives carried
  `index.js`/`package*.json`, so a restore mixed two code versions (C3); `2) Restore` froze nothing
  after a failed extraction (C4); Backup now and the daily cron could write an archive without
  pool.db (C5); the dark gate took a firewall's reject for the old box's own "no" (C6 — now only a
  RST on stratum plus an HTTP answer that is not the pool proves dark). The two build-found items
  C4/C5 are among those fixes.
- **Reported, not changed** (review P-items): the weekly VACUUM's EXIT trap can restart the old pool
  if Migrate OUT runs mid-vacuum (P1 — until OUT removes that cron too, never start a move near
  Sunday 03:00 UTC); a stale-but-self-consistent archive after a rollback passes IN (P2); the dark
  gate probes the old box's egress IP (P4); `2) Restore` leaves the wallet watchdog able to
  relaunch the listener mid-extract (P5); the old `nyc` row can be recommended as a "gateway" until
  it is deactivated (P7). Still open from the build: plain `2) Restore` leaves an enabled cert-less
  vhost (Migrate IN disables it); a digest that errors is `null` → `skip`; the ufw rules for the
  per-region ports on the wg interface are not checked; `/api/pool/topology` keeps its own copy of
  the status rules; the public CORS `*` also applies to the per-viewer suggest route; the old box's
  certbot keeps attempting renewals after DNS moves (noise, gone at wipe).
- **VPS acceptance:** testnet rehearsal of the whole move (including a stale archive and a live
  old hub, to prove the refusals), a re-resolve drill, one gateway's latency probe live, then the
  mainnet move. The old box then stays dark ~7 days before it is wiped — and may be rebuilt as the
  `nyc` gateway, whose seeded row is untouched.

---

## 14. Data retention & ledger rollup — IMPLEMENTED 2026-07-16 (branch `add-ons`; NOT VPS-tested)

Industry-standard three-tier retention (mirrors Miningcore/NOMP/commercial pools: raw shares
ephemeral, daily earnings kept for years, blocks/payouts forever). Keeps the SQLite file at a
**bounded steady state (~2–4 GB modest / ~8–12 GB at 1000-miner scale)** instead of unbounded
growth (~30+ GB/yr raw), while every *lifetime* public/audit figure stays exact forever.

### 14.1 What is kept, what is pruned

| Tier | Table | Retention | Why safe |
|---|---|---|---|
| working buffer | `shares` | height floor: confirm_depth + PPLNS 60 + `shares_margin_blocks` (default 360 → ~31 h) | PPLNS + orphan reversal read nothing older; luck/effort snapshotted into `blocks.network_difficulty`/`round_shares` at find time |
| display detail | `hashrate_history` | `hashrate_keep_days` (100) | per-miner wiggle-line only; pool-wide trends live forever in `pool_metrics_hourly` |
| **ledger detail** | `balance_log` | `balance_log_keep_days` (default 60, **floor 45**) | rolled into `balance_log_daily` first, verify-before-delete (14.2) |
| aggregates | `pool_metrics_hourly`, `balance_log_daily` | **forever** (~1 MB/yr + ~150 MB/10 yr) | size independent of miner count × time detail |
| money record | `blocks`, `withdrawals`, `withdrawal_events`, lottery | **forever** (~50 MB/yr) | the actual audit/tax record; payouts also mirrored on-chain |

Floor 45 on `balance_log_keep_days`: raw-only readers use windows up to 30 d (reconciliation
wallet-send audit `window_days=30`, account earnings 30 d, payments day/week/month ranges) + slack.

### 14.2 Ledger rollup — `lib/ledger-rollup.js` (the one contract to remember)

`balance_log_daily (day, grin_address, event_type, reference_type, total_amount, event_count)`
— these dimensions exactly reconstruct every lifetime consumer (verified by test, 14.4).

**Horizon contract:** marker `pool_config('_state','balance_log_rollup_horizon')` = **H**
(UTC-day-aligned) ⇒ rollup fully covers `created_at < H`. Composite lifetime reads =
`rollup(day < H) + raw(created_at >= H)` — no gap, no double-count, at every prune state.
Window reads with cutoff ≥ now − keep_days may read raw only.

Retention pass (hourly, `lib/retention.js`): ① `rollupCompletedDays` — whole completed UTC days,
idempotent replace-on-conflict, marker advanced in the same tx; ② `verifyAndPruneRaw` — deletes
one day at a time, **only after** that day's raw COUNT/SUM matches its rollup; a mismatch halts
pruning (`ledger_rollup_mismatch` in retention status/log) and never deletes an unverified day.
Rollup rows are never pruned. File space reclaimed by the weekly VACUUM cron, as before.

### 14.3 Consumers repointed to composite reads (all in this change)

- `hashrate-tracker.getPaymentsHistory` — lifetime totals (fee %, to-miners, giveaways) always
  composite; `year`/`all` series merge rollup+raw **additively** per bucket (a week/month bucket
  can straddle H); day/week/month ranges stay raw-only (≤30 d < floor 45).
- `lib/reconciliation.js` — lifetime flows, `pool_fee`/`prize_pool` funding detail, and the
  **integrity invariant** (Σledger vs Σbalances, feeds auto-freeze) are composite; d1/d7 raw.
- NOT repointed (verified within raw window): account earnings 1h/24h/7d/30d, ledger statement +
  CSV (row detail now labeled "kept 60 days", presets 30/60/all-retained), incentives jackpot
  dedup, prize-pool activity feed.

### 14.4 Chart/stat ↔ retention audit (2026-07-16, all pages)

| Surface | Source | Longest window | Verdict |
|---|---|---|---|
| Dashboard strip-chart + 24h peak, KPIs, top-miners 1h | `hashrate_history` 24 h; `shares` ≤24 h | 24 h vs ~31 h shares floor | ✅ (height-based prune fails toward *keeping more*) |
| miners-stats trends Day→All-Time | `pool_metrics_hourly` | all-time | ✅ forever |
| miners-stats leaderboards (30 d) | `blocks` / `hashrate_history` | 30 d vs forever/100 d | ✅ |
| blocks page explorer + P-01…P-04 (incl. luck) | `blocks` (+ snapshot cols) | all-time | ✅ forever |
| payment-history tiles + 4 charts, every range | `withdrawals` + composite ledger | all-time | ✅ exact via rollup |
| account P-01 hashrate (Day/Week/Month) | `hashrate_history` | 30 d vs 100 d | ✅ (Year/All already disabled with note) |
| account earnings / ledger cards | raw `balance_log` | 30 d vs 45-floor | ✅ |
| account P-06/P-07 row ledger + CSV | raw `balance_log` | keep_days | ✅ labeled; older detail = daily granularity |
| admin reconciliation + money alerts | composite + raw d1/d7; wallet-send audit 30 d | ✅ |
| lottery/campaign eligibility | `hashrate_history` | campaign window | ✅ while campaigns ≤ `hashrate_keep_days` (100) — enforce if longer campaigns are ever added |

**Smoke-tested** (scratchpad `test-ledger-rollup.js`, node:sqlite): synthetic 90-day ledger
(1526 rows) → rollup + prune to 45 d (763 rows deleted) ⇒ payments `all` totals, `year` series
bucket-by-bucket, reconciliation lifetime flows, fee/prize buckets and `integrity_drift = 0`
all **identical** before/after; re-run is a no-op. NOT yet run against a live VPS DB.

### 14.5 Size forecast (5–7 yr, with this design)

Modest pool (~20 blk/day): **2–4 GB** total. Large pool (1000 miners, ~400 blk/day): **8–12 GB**
— dominated by *constant-size* working windows (shares ~1 GB, hashrate ~1.5 GB, raw ledger 60 d
~4–5 GB), plus slow-growing forever-tables (~0.2 GB/yr). Deferred (size-only, not correctness):
vardiff (bounds share-row rate), per-miner **hourly** hashrate rollup w/ optional `worker_name`
dimension (would allow cutting `hashrate_keep_days` and enable per-rig history >24 h — worker
detail today exists only in `shares`). Optional future: yearly SQLite/CSV cold archive of pruned
raw ledger as a public transparency download.

---

## 15. Goblin nickname payouts over Nostr — DESIGN ONLY (2026-07-17, NOT built)

Operator idea: on the account page, a miner passes the ownership gate, enters their **Goblin
wallet username** (e.g. `alice` → `alice@goblin.st` via NIP-05), and the pool delivers the
payout slatepack to their Goblin wallet over Nostr — no Tor listener, no manual copy/paste.
Decision 2026-07-17: **design first, build later** (after the current batch is VPS-tested).

### 15.1 Why it's feasible (verified groundwork)

The slatepack-over-Nostr wire format was SOURCE-VERIFIED 2026-07-09 against goblin
`src/nostr/*.rs` (full detail → `script05_design_goblin.md`, memory
`reference_goblin_ecosystem`). Facts that matter here:

- **Payload**: NIP-17 private DM — kind-14 rumor, content = `"[Goblin] GRIN payment message …"`
  preamble + blank line + **plain-armor** slatepack (confidentiality = the DM layer, so the
  pool's existing `recipients: []` slatepack creation is byte-compatible). Tags `["goblin","1"]`.
  Caps: rumor 32 KB, slatepack 30 KB, note 256 chars.
- **Encryption**: standard **NIP-44 v2 always works** (goblin's "v3" is its own negotiated
  extension, only used when the peer advertises it — a Node bridge never needs it).
  `nostr-tools` (nip44/nip59/nip17/nip05 + SimplePool over ws) covers everything.
- **Ingest**: goblin AutoReceive (default policy Everyone) signs S2 automatically when the
  wallet is online; it finalizes only if the sender pubkey == stored counterparty ⇒ **the pool
  must send from the same Nostr key it listens on** (one persistent pool identity key).
- **Relays**: shared floor `wss://relay.floonet.dev` is pinned in every goblin publish+inbox
  set (plus relay.0xchat.com, offchain.pub). Public wss — no relay of our own is required
  (the 091 floonet-rs deployer stays optional compose-when-present).
- **Timing**: goblin pending-send expiry is **24 h**; catch-up lookback 3 days (wrap
  `created_at` fuzzed ≤ 2 d past). Pairs naturally with our slatepack TTL expiry/refund.

### 15.2 The security tension — this rail pays a THIRD PARTY

Every existing rail can only pay the miner's own wallet: Tor dials the mining address's
`.onion`; the manual slatepack is age-encrypted **to the mining address**. That is why the
ownership gate is anti-griefing, not authentication — a passed gate cannot redirect funds.
A nickname rail breaks that invariant: coins go to **whoever controls the npub** behind the
username. A guessed IP (CGNAT neighbour!) or a leaked rig password would become real theft.
The IP-or-password gate MUST NOT be the only thing standing between an attacker and an
arbitrary-destination payout.

**Mitigation — registered destination + cooldown (exchange-style address whitelisting):**
1. `POST /api/account/:addr/nostr-destination` (ownership-gated, rate-limited): resolves the
   NIP-05 username → npub, stores `{username, npub, registered_at}` on `miner_accounts`,
   audit-logs the change. Re-registration overwrites and **resets the clock**.
2. A Nostr payout is allowed only when `now - registered_at ≥ cooldown` (config, default
   **48 h**, operator-tunable ≥ 24 h). Until then the account page shows "activates at <UTC>".
3. The pending registration is prominently visible on the account page (and in the account
   audit trail), so the legitimate owner — who checks their stats — has the whole cooldown
   window to notice a hijack attempt, re-register (clock reset evicts the attacker's entry),
   and rotate their rig password.
4. Registration + first use each raise an admin money-alert (reuses AlertMonitor channels);
   per-rail spend caps can piggyback on the existing large_withdrawal alert.
5. The npub is pinned at registration time (TOFU): at send time the pool re-resolves the
   NIP-05 name and **refuses if the npub changed** (a goblin.st account takeover must not
   silently redirect payouts — the miner must re-register through the gate + cooldown).

### 15.3 Bridge module sketch (`lib/nostr-payout.js`, in-process — no separate daemon)

- One pool Nostr identity key (generated at setup, stored like `.wallet_pass`; NEVER the
  operator's social `nostr_link` key from branding).
- `SimplePool` over `wss://relay.floonet.dev` + 2 fallback relays (operator-configurable
  JSON list in pool_config; compose-with-091 just prepends the self-hosted relay).
- Send path (piggybacks the existing slatepack state machine — NEW `method='nostr'` rows
  reuse `slatepack_pending`): create S1 (same wallet call as the manual rail, `recipients:
  []` plain armor) → wrap per NIP-17 (kind-14 rumor → NIP-44 v2 seal → gift wrap) → publish
  to the destination's inbox relays (kind-10050 lookup, fallback to the shared floor).
- Receive path: persistent subscription for gift wraps addressed to the pool key; unwrap →
  regex-extract exactly ONE `BEGINSLATEPACK` block (tag-distrusting, same as goblin) →
  classify by parsed slate state → if it's S2 for a `slatepack_pending` nostr row, run the
  existing finalize path (same code as the manual rail's finalize, minus the HTTP route).
- Failure states map onto what already exists: no S2 within TTL → the standard slatepack
  expiry refund (goblin's own 24 h pending expiry means a dead wallet fails fast); relay
  publish failure → park as `retry_scheduled` and reuse the Tor retry ladder; NIP-05
  resolution failure or npub mismatch → 4xx at request time, nothing locked.
- Freeze/kill-switch: `_assertNotFrozen()` gates the new entry point exactly like the other
  rails; the reconciliation coverage math needs no change (locked balances behave identically
  to the manual slatepack rail).
- **Pending exclusivity + cooldown come for free.** Because `method='nostr'` rows park in
  `slatepack_pending`, they are already counted by the shared `PENDING_SQL`, so the
  one-pending-per-address rule holds across Tor + slatepack + Nostr with no new code — a miner
  can never run a Nostr payout alongside another rail. The nostr create entry point must also
  call `_assertNoRecentReversal()` (added round 3, 2026-07-17) so the failed-payout cooldown
  spans this rail too; a Nostr failure that reverses the lock goes through the same
  `_reverseLock` → `balance_log` reversal row that arms the cooldown. This is the concrete
  payoff of "reuse the withdrawal state machine": the cross-rail double-pay guard already
  covers a rail that isn't built yet.

### 15.4 Build order (when green-lit)

1. Schema + registration endpoint + cooldown + account-page UI (no sending yet) — smallest
   reviewable slice, and the cooldown clock can already be running for early adopters.
2. Bridge send/receive with a testnet goblin wallet against the public relay floor.
3. Alerts + admin visibility (registered destinations list, per-rail counters).
4. VPS E2E with a real Goblin wallet, then enable on mainnet behind a pool_config flag
   (default OFF).

Est. scope: ~1 session for slice 1, 1–2 for the bridge. Deps: `nostr-tools` (+ `ws`) — the
only new npm packages; everything else reuses the existing withdrawal state machine.

### 15.5 BUILT 2026-07-18 (add-ons, NOT VPS-tested) — what shipped vs the sketch

Implemented as one in-process bridge `lib/nostr-payout.js` + a `method='nostr'` rail on the
existing scheduler. Feature flag `nostr_payouts_enabled` defaults **OFF**; nostr-tools + ws are
lazy-required inside `start()` so a pool without `npm install` (or with the flag off) boots
normally. Deviations from the sketch, all deliberate:

- **Send-only rail (no donation-receive).** The pool is always the payout *sender*; the bridge
  subscribes for the S2 *response* only. The §3.2 donation-ingest flow is out of scope here
  (that was a Drop feature) — the receive pipeline finalizes S2s for our own pending sends and
  drops everything else.
- **S1 is plain armor (`recipients:[]`)** — the ONE wallet-call difference from the manual
  slatepack rail (which age-encrypts to the mining address). Confidentiality is the Nostr DM
  layer, and goblin's AutoReceive expects plain armor (§2.4). Everything else reuses
  `createSlatepackWithdrawal`'s lock/fee/expiry machinery verbatim.
- **Publish failure reverses immediately** (status `nostr_failed`) rather than entering the Tor
  retry ladder (which is Tor-transport-specific). Simpler and safe: the miner just re-requests.
  A *delivered but unanswered* send still parks in `slatepack_pending` and refunds via the
  normal TTL sweep, so a genuinely-offline wallet is covered.
- **NIP-05 domain allowlist** (`nostr_nip05_domains`, default `["goblin.st"]`) added as an
  explicit SSRF + look-alike-domain guard beyond §2.6's hostname validation — the pool will
  only resolve a username against an allowlisted domain.
- **TOFU re-pin at send time**: the route re-resolves the stored username and refuses the
  payout if the npub changed since registration (§15.2 #5), on top of the ≥48 h cooldown.
- **Response binding is defence-in-depth**: the bridge routes an incoming S2 to a pending row
  by matching the seal-sender pubkey to the registered `nostr_npub`; the scheduler then
  re-checks that match AND binds `slate.id` before finalizing.

Files: `lib/nostr-payout.js` (bridge, all nostr-tools calls isolated in a "wire" section),
`lib/withdrawal-scheduler.js` (`createNostrWithdrawal` / `finalizeNostrWithdrawal` +
`nostrBridge` injection), `index.js` (startup construct+start, response-handler wiring,
`POST`/`DELETE /api/account/:addr/nostr-destination`, `method:'nostr'` withdraw branch,
account-summary `nostr_destination` + `nostr_payouts_enabled`), `lib/db.js`
(miner_accounts `nostr_username`/`nostr_npub`/`nostr_registered_at`, `nostr_seen_events` dedup
table created by the bridge), `lib/config.js` + `lib/pool-settings.js` (4 config keys),
`admin-panel/settings-payout.html` + `settings-common.js` (admin fields),
`public_html/account-settings.html` (P-04 Goblin option + registration UI). Security detail →
security_audit §E.3; build notes → implementation §10.2.

### 15.6 OFF-BY-DEFAULT IS A GUARANTEE, NOT A DEFAULT VALUE (verified 2026-08-13)

Goblin is a third-party rail depending on relays we don't run and wallet software the miner
installs separately, so a pool that has not deliberately switched it on must show **no trace of
it to an end user**. Four independent layers enforce that; all four were re-verified 2026-08-13.

1. **Default** — `payout.nostr_payouts_enabled: 'false'` in `lib/pool-settings.js`, with a
   validator that accepts only `true`/`false` and normalises an empty or absent value to
   `'false'`, never to truthy. The admin checkbox in `settings-payout.html` ships unchecked.
2. **The account summary reports RUNTIME truth, not the setting.** `index.js` sends
   `nostr_payouts_enabled: !!(nostrBridge && nostrBridge.isEnabled())`. So a pool where the
   operator ticked the box but `npm install` never ran — the bridge constructor throws and is
   caught, leaving `nostrBridge = null` — reports **false** and the UI stays hidden. A flag that
   is on while the feature cannot work must never render a payout option.
3. **Markup fails closed.** All three Goblin blocks in `account-settings.html` (radio `<label>`
   :472, payout pane :509, destination card :561) ship `style="display:none;"`, so nothing appears
   before the summary lands and there is no flash of an unavailable rail. `PayoutMethods.applySummary`
   reveals the label and the destination card only when `isEnabled(summary)` passes, unchecks the
   radio if the rail is switched off while it was selected, re-checks the `fallback` rail (Tor),
   and hides the whole `#acct-destinations` heading when no destination card is visible. The
   **pane** is not driven by `isEnabled` at all — `sync()` shows whichever pane matches the
   *checked* radio, and a disabled rail's radio can never be the checked one. Worth knowing before
   adding a rail: a pane with no radio would never be hidden by this machinery.
4. **The server refuses regardless of what the page shows** — `503` on
   `POST /api/account/:addr/withdraw` with `method:'nostr'` (index.js :3520) and on
   `POST /api/account/:addr/nostr-destination` (:3642). Hiding a control is presentation; this is
   the actual gate, and it holds against a hand-crafted request. **`DELETE /nostr-destination` is
   deliberately NOT gated** — de-registration cannot redirect money, and a miner must still be able
   to clear a pinned destination after the operator switches the rail off, or the pin is stranded
   in `miner_accounts` with no route to remove it.

**One leak existed and was fixed 2026-08-13:** `public_html/index.html` carried a static line
—"Nostr / Goblin transport planned"— rendered to every visitor irrespective of the flag, and stale
besides (the rail shipped 2026-07-18). Removed. The homepage now describes only the two rails
every pool always has. **Rule: no public page may name an optional rail in static copy.** The
account page is the only surface allowed to mention Goblin, because it is the only one that
gates on the summary.

Not a leak, and deliberately kept: a *withdrawal history* row whose `method` is `nostr` keeps
rendering "Goblin (Nostr)" after the rail is switched off. That is the miner's own past payment,
and `payout-methods.js` falls back to the raw method string for a rail that no longer registers,
so history never renders `undefined`.

> Unrelated near-miss when grepping: `data-brand="social-nostr"` in `index.html` /
> `public-shell.js` is the pool's optional **Nostr social link** in the footer (`branding.nostr_link`,
> also hidden by default). It has nothing to do with the payout rail — do not wire the two together.

---

## 16. Donor names + donor league — DESIGN (2026-09-21; Parts 1–5 BUILT + reviewed the same day, NOT VPS-tested)

> **⚠ Superseded in part by §18 (2026-09-23, design only).** The donation becomes per SHARE (no
> stored %, no ceremony), the worker label stops being a donor name, and names + banners move to a
> reviewed donor profile on the account page. The ranking (§16.6) and expiry survive. Read §18
> first; this section is the record of v1 and of what is still built today.

Operator idea, settled in discussion 2026-09-21 after the first live-miner test of the donate
tag: let a donor put a **brand name** on the public donor wall (`donate.html` D-03), make the
wall **competitive** (amount × loyalty), and keep every donor forever with **post-moderation**
from the admin panel rather than a review gate. Six build sessions; the per-session prompts are
kept outside the repo (plans dir) and fold back here when run. Status per part → §16.11; what
building changed against §16.1–§16.10, and the independent review's findings → §16.12. §16.1–§16.10
are left as designed — read them with §16.12 beside them.

### 16.1 Decisions (all FINAL unless a build finds a hard reason)

| # | Decision | Why |
|---|---|---|
| 1 | Name comes from the **worker label** of the tagged rig: `yourbrandname-donate10` → name `yourbrandname`; plain `donateN` → **masked address** (as today) | Register-free, no new UI for the miner; the tag already lives in the worker name (§J3-5) |
| 2 | Name is written **only on a set-from-zero** (`donate0` → `donateN`), the same path as a raise (§J6-7). A lower never touches the name | Stratum login is unauthenticated; without this anyone can rename any active donor by mining four shares to their address |
| 3 | **Post-moderation, accept-all by default.** A name shows as soon as its card exists; the operator censors after the fact | The cheapest way to put text on this page is to donate GRIN and wait for a block ("cost to post"); a review queue would gate the honest 99 % for the troll 1 % |
| 4 | Censor is **per address and sticky**: a censored donor's later renames stay censored until an admin clears it. Un-censor sets an `allow` override the auto-list respects | Otherwise it is whack-a-mole |
| 5 | Censored / expired / absent name → the card shows the **masked address** by default; `<censored-donor>` is an operator setting, off by default | A visible "censored" marker is the reaction a troll wants and makes the wall look like it has a problem |
| 6 | **Auto-censor word list** ships as a starter (impersonation words + compact English profanity), editable in admin; saving **re-scans** every name | Never complete, English-only — the operator's own words are the real list |
| 7 | Ranking **score = GRIN in window × (1 + loyalty% × active months)**, multiplier capped; ties by months ↓ then first donation ↑ | A strict amount → duration → rigs priority never reaches the second key: 9-decimal amounts never tie |
| 8 | **Active months** = distinct UTC months with ≥ 1 donation **debit** | "Months since first donation" rewards a one-off; "months the tag was on" costs nothing on an idle rig; a debit costs GRIN |
| 9 | Window default **365 days** (setting; 0 = lifetime). Lifetime GRIN still printed on every card | A lifetime board freezes — the early big donor is #1 forever |
| 10 | **Rigs displayed, never ranked** | Renaming a worker is free and says nothing about generosity |
| 11 | Donors with nothing in the window leave the league for a capped **Past donors** strip; nothing is ever deleted and `Donors` / `Donated all-time` stay lifetime | The user's "prune by date" without removing a thank-you |
| 12 | **Name expiry**: masked address again 12 months after the last donation (setting; 0 = never) | Keeping the tag on is what keeps the name up |
| 13 | Names display **lowercase**; charset stays `a-z0-9_-` (no dots → no domains) | Login grammar has no case; the charset is the best free anti-spam rule we have |
| 14 | Worker part **case-folded** at login; visible label **32**, raw **48** (was 25 / 40) | `MyBrand-donate10` was *refused at login*; a 27-char brand clipped to `northern-hashwo-donate10` |

### 16.2 Login grammar (`lib/stratum-protocol.js validateUsername`)
`grin1…` + `.` + worker, worker lowercased **before** the regex (the address stays strict —
grin never emits uppercase bech32). `MAX_WORKER_NAME_LEN` 25 → 32, `MAX_WORKER_RAW_LEN` 40 → 48;
the existing rule "cut the label, keep the token" is unchanged, so beside `-donate100` a label
keeps ≥ 22 chars. Token parse unchanged (`(?:(.*?)[-_])?donate(\d{1,3})$`, 0–100 only, leading
zeros allowed, 4+ digits = plain name). `dm[1]` (the label) is what becomes the donor name.

### 16.3 Data model — six columns on `miner_incentives` (ALTER … ADD COLUMN, same helper pattern as `miner_accounts`)
| Column | Meaning |
|---|---|
| `donor_name TEXT` | lowercase label as captured; NULL = none |
| `donor_name_set_at INTEGER` | unix, when captured (drives the admin NEW badge) |
| `donor_censor TEXT` | NULL · `auto` · `admin` · `allow` (admin override — auto-list skips this address) |
| `donor_censor_word TEXT` | the list entry that matched, for the admin badge (`auto: "word"`) |
| `donor_censor_at INTEGER`, `donor_censor_by INTEGER` | unix + admin user id (NULL for auto) |
No new table. Lifetime totals, first/last dates, active months and rigs are all derived at read
time from the ledger composite (`balance_log_daily` + `balance_log`) and the 24 h share window.

### 16.4 Capture rule (`lib/stratum-server.js`, in the block that applies `session.donationPercent` after `PROOF_MIN_SHARES`)
Only when `setDonation` is called on the **from-zero** branch (`current === 0 && new > 0`):
`label = dm[1]` from the parsed login (empty → clear `donor_name` to NULL — a plain `donateN`
after a branded one removes the name). Then `lib/donor-names.js`:
1. `normalise(label)` — strip `-`/`_`, map leet `0→o 1→i 3→e 4→a 5→s 7→t`, lowercase.
2. Reserved (fixed in code, always applied): pool `pool_name` lowercased, `admin official
   operator support staff pool grinium prize jackpot winner`.
3. Operator list (`donor_name_blocklist`, one entry per line, matched as a **substring of the
   normalised name**).
4. Write `donor_name`, `donor_name_set_at`; if `donor_censor` is `admin` → leave it (sticky);
   if `allow` → leave it (override); else set `auto` + word on a match, or NULL.
Reserved and list hits are **stored, not refused** — the name exists, it just never displays.
`setDonation` itself is untouched (it still refuses reserved addresses and honours both flags).

### 16.5 Moderation model — three layers, in order of what they catch
1. **Cost to post** — a name displays only on a card with a donation debit (existing card rule).
2. **Auto-list** at capture and on every list save (rescan walks all `donor_name IS NOT NULL`
   rows, skipping `allow` and `admin`). False positives (`classic` ⊃ `ass`) are expected; the
   fix is the admin un-censor, which sets `allow`.
3. **Admin → Donors** page (§16.8): Censor / Un-censor per address, audit-logged
   (`donor_censor` / `donor_uncensor` in `admin_audit_log`, target_type `donor`).
Plus one public line under the wall: *"Names are chosen by the donors and are not verified by
the pool."* And the stranger case (decision 2) is closed at the write, not by moderation.

### 16.6 Ranking (`/api/pool/donors`)
```
W  = donor_rank_window_days (365; 0 = lifetime)
A  = GRIN donated inside W          (composite read; day-aligned for rolled days)
M  = distinct UTC months with a donation debit, lifetime
mult = min(1 + donor_loyalty_percent_per_month/100 × M, donor_loyalty_cap)   (10 %, ×3)
score = A × mult
league  = donors with A > 0, ORDER BY score DESC, M DESC, first_donated_at ASC, LIMIT 100
past    = donors with A = 0 (lifetime > 0), ORDER BY last_donated_at DESC, LIMIT 20 + count
```
Published on the page in one sentence. `totals` stay lifetime over every donor (fixed
2026-09-21, impl §10.3). `active_donors` counts live tags (same fix).

### 16.7 Public wall (`donate.html` D-03) — per card
rank (🥇🥈🥉 for the league top 3) · **display name** · GRIN in window · lifetime GRIN (when
different) · `×1.4 loyalty · 4 months` · `donating 10 %` / `paused` · since (first donation) ·
`N rigs online` (display only). **Display name** = `donor_name` when it is set, not censored,
and `last_donated_at` is inside the expiry — else the masked address, or `<censored-donor>`
when the operator chose that and the reason is a censor. The API emits `name` (or `null`) and
`name_state` (`shown` · `masked` · `censored` · `expired`) and **never** the censored string.
Past-donors strip: name/masked + lifetime GRIN + last donation, then "and N more past donors".

### 16.8 Admin → Donors (`admin-panel/donors.html`, NAV child of Dashboard after Miners)
Table (one row per address with a lifetime debit **or** a live tag; **full** addresses — admin
side): rank · score · address · donor name + state badge (`ok` / `auto: "word"` /
`admin-censored` / `allowed` / NEW < 7 d / `renamed while censored`) · current % · lifetime ·
in-window · active months · first / last · workers (24 h window, LED, tagged rig marked) ·
**Censor** / **Un-censor**. `AdminTable` controller, search + filter (all / censored / new).
Settings form on the same page (harvester, ids = keys): `allow_miner_donations` and
`donation_address` **move here** from `settings-incentives.html` (which keeps a link) ·
`donor_name_blocklist` (textarea) · `donor_censored_display` (`masked` | `marker`) ·
`donor_rank_window_days` · `donor_loyalty_percent_per_month` · `donor_loyalty_cap` ·
`donor_name_expiry_months`. Dashboard + nav show "N new donor names this week".
Routes: `GET /api/admin/donors` (secureAdmin), `POST /api/admin/donors/:addr/censor` and
`/uncensor` (freshAdmin, audit), rescan hooked into the settings save for the list key.

### 16.9 Miner side
`/api/account/:addr` gains `donor_name` + `donor_name_state`; the account page donation row
prints *Donor name: acme* · *hidden by the pool* (a false positive must know to contact the
operator) · *expired — reconnect with your tag to refresh*. Changing a name = the raise
ceremony (`donate0`, a few shares, `newname-donateN`), documented beside the raise row on D-01.
D-01 example row becomes `grin1…address.yourbrandname-donate10`.

### 16.10 Security notes for the audit pass
- **Stranger write** is bounded to paused addresses (decision 2) and costs 4 accepted shares
  paid to the victim; the address is masked so a hostile name on someone's card identifies
  no one but them; the victim clears it with the ceremony, the admin with a click.
- **Leakage**: `name` on a public feed is opt-in disclosure by the donor; the address stays
  masked (§J11-1); `test-public-leakage.js` must assert no full address and no censored string
  ever leave `/api/pool/donors` or `/api/account/:addr`.
- **Gaming**: months need a debit (GRIN); rigs are not ranked; the window resets the race.
- **Type traps** (memory `project_config_loader_type_traps`): every new numeric setting is
  parsed with a bound, `donor_censored_display` is a closed enum, the list is split on
  newlines and trimmed, never `eval`'d or used as a regex.

### 16.11 Status
| Part | Scope | State |
|---|---|---|
| 1 | Login grammar: case-fold, 32/48, `donor_label`, tests (D-01 example row moved to Part 4 with the rest of the page copy) | **done 2026-09-21, not VPS-tested** — impl §10.3 "Part 1"; guard suite 71/71 |
| 2 | Storage + capture + `lib/donor-names.js` + settings keys + account API/page | **done 2026-09-21, not VPS-tested** — impl §10.3 "Part 2"; `test-donor-names.js` 100/100. Two deltas recorded there: expiry counts from the later of last debit and capture (calendar months), and censor outranks expiry. `lib/donor-ledger.js` started early with the per-address `lastDonatedAt` so Part 3/4 extend one file |
| 3 | Admin: routes, audit, rescan, `donors.html`, settings move, dashboard count | **done 2026-09-21, not VPS-tested** — impl §10.3 "Part 3"; `test-donor-names.js` 148/148, admin-panel 71/71, admin-guards 79/79. Deltas recorded there: the admin list also shows STORED-NAME rows with no debit and no tag (moderate before the first debit publishes); un-censor from NULL and censor of a nameless address are both allowed (pre-emptive, sticky); renaming the pool re-scans too; the settings form is page-local so the rescan counts can be shown; the nav badge reads a one-COUNT `/api/admin/donors/summary`, not the dashboard route. §16.6's window edge is now stated: a rolled day at its UTC midnight ≥ cutoff is in WHOLE |
| 4 | Public: `/api/pool/donors` v2, D-03 league/past, copy, api-docs meta, leakage tests | **done 2026-09-21, not VPS-tested** — impl §10.3 "Part 4"; `test-donor-league.js` 68/68, leakage 77/77, admin-guards 79/79. The response is built by `lib/donor-ledger.js donorWall()` (the route is thin) with the address mask a REQUIRED argument; two implicit points now stated: past-strip ties break on lifetime DESC then address ASC, and a league overflow (>100 in window) is counted in `totals` but shown on neither list. 390 px iframe probe: 0 overflow on three page states |
| 5 | Review of 1–4 against this section + security notes; fold into docs + memory | **done 2026-09-21** (a separate cold session reading the working-tree diff) — the nine questions and their answers are §16.12; **two code findings, both fixed** in `lib/donor-names.js` (rescan parsed the list per NAME — ~1 s per list save at the validator's ceiling on the shared synchronous connection; a separators-only label was stored and shown as the name `-`), `test-donor-names.js` 148 → 156/156; three docs corrections (this section's heading + header said "NOT built" / "Parts 3–6 design only" while §16.11 said Parts 1–4 done; the security audit named only Part 1). All 16 suites green after the fixes. Nothing here has run on a VPS |
| 6 | VPS acceptance on testnet with live miners | **superseded 2026-09-23** — never run; replaced by §18.10 Part 7, which tests the v2 behaviour instead |

### 16.12 Implementation deltas + the Part 5 review (2026-09-21)

What the four build sessions changed against §16.1–§16.10 (each was recorded in §16.11 / impl
§10.3 as it happened; collected here so the design reads true), then what the independent
review found. Nothing below has been VPS-tested.

**Deltas — what shipped differs from the section above in these ways, and why:**

| § | As designed | As built | Why |
|---|---|---|---|
| 16.2 | worker part "lowercased" | ASCII `A-Z` only, folded BEFORE the charset regex | `toLowerCase()` maps U+212A KELVIN SIGN into the charset as `k`; a byte outside `[a-z0-9_-]` must keep failing, not be adopted |
| 16.4 #2 | pool name always reserved | reserved only when it normalises to **≥ 3 chars** | a one- or two-letter pool name would censor nearly every donor |
| 16.4 | `''` clears `donor_name` | `''` clears the name **and an `auto` verdict**; `admin` / `allow` survive | the auto verdict was about the name that is gone; the two admin states are per-ADDRESS decisions |
| 16.4 (review) | any label inside the grammar is a name | a label with **no letter or digit** (`--donate10` → `-`) is **no label** — same as `''` | it normalises to nothing, matches nothing, and headed a card as the name `-` |
| 16.7 #12 | expiry = 12 months after the **last donation** | 12 **calendar** months (UTC) after the **later of** the last debit and the capture; **censor outranks expiry** | a name just re-set through the ceremony must not read "expired" while its first debit is a block away; an aged-out censored name is still the operator's decision |
| 16.5 #2 | rescan on list save | rescan on list save **or pool rename**; the list is parsed **once per walk** (review) | the pool name is a reserved word, so renaming the pool changes verdicts; per-name parsing cost ~1 s per save at 4000 entries × 300 names |
| 16.5 #3 / 16.8 | table = addresses with a debit **or** a live tag | also addresses with a **stored name** and neither; un-censor from NULL and censor of a nameless address both allowed (pre-emptive, sticky) | a donor who ran the ceremony then paused has a name on file and no debit — moderation that starts after the first debit publishes it is the review gate #3 rejected |
| 16.6 | "day-aligned for rolled days" | stated exactly: a rolled day is **in WHOLE** when its UTC midnight ≥ `now − W`, else out whole; raw rows at second precision | the cutoff lands on a day edge for anything older than the rollup horizon — say so once, in the lib |
| 16.6 | `past` ORDER BY `last_donated_at DESC` | ties broken on lifetime DESC, then address ASC | rolled days tie by the day; an unordered tie shuffles the strip on every poll |
| 16.6 | league LIMIT 100 | a donor past the 100th league place is counted in `totals` and shown on **neither** list | design as written; now stated |
| 16.6 | `active_donors` "counts live tags" | `COUNT(*)` of `miner_incentives.donation_percent > 0`, 0 while donations are off | one COUNT, not a filter over the cards; the same `donationsActive()` gate as every other "current" reading |
| 16.8 | settings form "harvester, ids = keys" | the form is **page-local** (same three harvester rules), not `settings-common.js` | `saveSection()` discards the response body, and the one thing this form must show is the rescan counts; `updateSection()` upserts only the keys it is sent, so no merge step was needed |
| 16.8 | "Dashboard + nav show N new names" | dashboard tile from `/api/admin/dashboard new_donor_names_7d`; the nav badge from a one-COUNT `GET /api/admin/donors/summary` | the dashboard route runs a dozen queries; a badge painted on every page load must not |
| 16.8 | workers "tagged rig marked" | `parseDonateToken()` exported from `lib/stratum-protocol.js` (the login regex became a named constant both use) | one grammar, not a second copy drifting from the login |
| 16.9 | donation row shows a name | the row stays visible for a **paused** donor who has a name (`paused (0%)` + the name line) | a paused donor keeps their name; hiding the row would hide the one place they can read it |
| 16.10 | mask the address | `donorWall()` **throws** without a mask function and applies it to both arrays inside the lib | `past` is exactly the second array a route would forget (§J11-1) |
| — | — | `scripts/check-syntax.js` sniffed `type=` over the whole `<script>` MATCH, body included, so any page whose row template contains `type="button"` was never syntax-checked | found while adding `donors.html`; fixed to the opening tag only (29 → 32 inline blocks) |

**Part 5 review — nine questions, read cold against the diff (answers verified against the code,
not the notes):**

1. **Stranger write.** `captureDonorName` has ONE call site: `_applyParkedDonation` → `wrote && current === 0 && percent > 0`. A LOWER, a same-% reconnect, `donate0`, a refused raise, and a set `setDonation` refused (donations off, reserved address) never reach it; a banned address is refused at login before a session exists. A stranger at `donate1` against a PAUSED donor does reach it — by design (#2, §16.10): the name is replaced (or cleared by a plain tag), an `auto` verdict goes with it, `admin`/`allow` survive, and the victim's account page shows the new name / "hidden by the pool". Confirmed as designed.
2. **Leakage.** Public responses touching `miner_incentives`: `/api/account/:addr` (emits `donor_name` + `donor_name_state`, selects three columns) and `/api/pool/donors` (via `donorWall`; no card key starts with `donor_`, `donor_censor` is read for `displayState` and never emitted). `GET /api/admin/miners/:addr` returns the whole row (`SELECT *`) but is `secureAdmin`. The marker string leaves only when `censored_display` is `marker`. Nothing else.
3. **Censor state table** (current → capture(name) / capture('') / rescan / censor / uncensor): NULL → auto-or-NULL / NULL / auto-or-NULL / admin / allow · auto → re-matched / NULL (word, at, by cleared) / auto-or-cleared / admin / allow · admin → admin (name + set_at updated) / NULL, admin kept / skipped / 409 / allow · allow → allow / NULL, allow kept / skipped / admin / 409. Matches §16.4/§16.5 plus the deltas above.
4. **Ranking.** One card hand-recomputed from a stub DB (rolled 1.0 + rolled 2.0 + raw 0.5, three distinct months: `3.5 × 1.3 = 4.55`; a second donor `0.25 × 1.2 = 0.3`); the rolled day at `now − 365 d` (midnight < a noon cutoff) is OUT and the next day IN, as stated; ties by months then first donation; `slice()` in JS, no `LIMIT -1`; blank / `"abc"` / `NaN` / `"Infinity"` / `0` cap / `1e9` months all resolve to the documented defaults through `donorSettings()`, and a raw section passed by mistake still gives a finite score.
5. **Type traps.** Every reader of the six keys goes through `donorSettings()` (bounded ints, 0–100 percent, cap ≥ 1, closed enum) except the rescan hook, which reads the list text and hands it to `rescanAll` → `parseList` (split on newlines, trimmed, never a `RegExp`; the only `new RegExp` in the lib is built from the `MAX_WORKER_NAME_LEN` constant). Write-side validators mirror the bounds. No new booleans.
6. **DB cost** (EXPLAIN QUERY PLAN, no ANALYZE — as the capacity memory prescribes): `donorLedger` = the same two `SEARCH`es the old wall query ran plus a temp b-tree for `COUNT(DISTINCT)` over donation rows only; `lastDonatedAt` = two indexed `SEARCH`es; the three `miner_incentives` reads are scans of a table with one row per address; the admin list's per-row `getWorkersForAccount(addr, 1440)` is a `SEARCH shares USING INDEX idx_share_address` + a per-address temp b-tree — bounded by that address's ≤ 31 h of shares, up to 500 rows per page load, polled every 60 s per open admin tab. **First per-row shares read in the panel**; cheaper than one table-wide 24 h scan while donors ≪ miners. The one real cost found was the rescan (finding A below).
7. **Admin panel.** `.error-msg`/`.success-msg` carry no `display:none` (inline `style` hides them); the nav pill's ink is `var(--btn-text)`, the admin bundle's ink-on-accent token; the page uses `API.get` (= `Auth.fetch`) for reads and `adminFetch` (step-up aware, in-page dialog — `confirm()` then `adminFetch` is one native dialog, not a chain) for every write; the two moved keys exist on exactly one page, and `updateSection()` upserts partial key sets so the Incentives page and this one cannot clobber each other; both POSTs are `freshAdmin` and `adminCensor()` writes its `admin_audit_log` row in the same transaction; the settings save is audited by `updateSection`.
8. **Public page.** Every name passes `escHtml` (`nameCell` serves both the grid and the past strip); "(all times UTC)" is stated once in the deck-head; the 390 px iframe probe was run by Part 4 on three fixtures (0 elements past the right edge) and not re-run here; empty league + non-empty past, tags-set-but-no-debit, and unavailable each have their own copy; the `API_DOC_META` row lists the 14 card keys and the four top-level ones exactly as `donorWall()` emits them, with the notes (opt-in lowercase ≤ 32, masked, marker only under `marker`, totals lifetime over every donor, window edge) hand-read against the builder.
9. **Docs.** §16.11's counts matched a fresh run of every suite (guards 71, names 148 → 156 after the fixes, league 68, leakage 77, admin-panel 71, admin-guards 79). Three honesty defects, fixed: this section's heading and the file header still said "NOT built" / "Parts 3–6 are design only" / "Parts 1–2 done" while §16.11 said Parts 1–4 done; the security audit's freshness header named only Part 1 although Parts 2–4 added a public text surface, two admin write routes, six settings and a rescan hook (none of which has had a §J-style pass — this review is the only one so far, and its header now says so). No session scaffolding in `docs/generated/`.

**Findings (both fixed, `lib/donor-names.js`):**

- **A · Medium (efficiency on the shared connection).** `rescanAll` called `matchBlocklist` per row, and `matchBlocklist` re-parsed the whole list text (normalising every entry) on every call. Measured: 300 stored names × the validator's 4000-entry ceiling = **1048 ms** per list save, on the synchronous connection StratumServer shares — a one-second stall of share intake, admin-triggered (not an amplification vector). Fixed by splitting the matcher (`matchEntries(name, entries, poolEntry)` under `matchBlocklist`) and parsing once per walk: **16 ms**. Pinned by an equivalence test, a source check that `parseList` is called once above the loop, and a 2 s ceiling.
- **B · Low (cosmetic, but a name-shaped non-name on a public page).** A worker label made only of separators is inside the grammar — `--donate10` hands `validateUsername`'s `donor_label` over as `-`, `_-_-donate10` as `_-_` — passed `LABEL_RE`, normalised to `''`, matched nothing, and was stored and SHOWN as the donor name `-`. Now treated as no label at capture (clears, like `''`); one real character (`-a-`, or a lone leet digit `0`) is still a name.

**Known properties, not findings (stated so the next reader does not re-derive them):** an
`allow` override is exactly that — a donor un-censored for a false positive can rename to
anything and it shows until an admin acts; the NEW badge (7 d) and the dashboard tile are the
signal, there is no "renamed while allowed" state. A stranger's rig mining to a donor's address
appears in that donor's admin `workers` cell (with the tag mark if tagged) — §J6-9 already
accepted this for sessions with an accepted share, and here it is what lets the operator SEE a
stranger write. Donation ledger rows are counted as debits only, as the wall always did; an orphan
reversal has never touched donation rows (out of §16's scope). `parseInt` quirks (`"1e3"` → 1)
apply to every `intRange` setting on the panel and are the same on the write side, so a stored
value never disagrees with its read.

---

## 17. Ownership-proof SET — 10 per kind, per-address salt (2026-09-22 — Parts 1–3 BUILT, Part 4 reviewed 2026-09-23, nothing VPS-tested)

Replaces the **2-slot proof window** (`last_ip`/`prev_ip`, `last_pass_hash`/`prev_pass_hash`)
that has gated every self-service money action since 2026-07-17 (impl §10; audit §E, §F, §J3).
Built in five sessions — backend → account page → copy sweep + docs → independent review → VPS
acceptance — with the run order kept outside the repo. §17.6 carries each part's state: **Parts 1
(the backend), 2 (the account page) and 3 (the copy sweep) are built, and the independent review
(Part 4) has run** — it fixed three defects, and §17.7 records them against this contract.
Already-installed pools still show the old window in their CMS pages until the
operator edits them (§17.6, Part 3 delta 3). Nothing in this section has run on a VPS.

### 17.1 Why the 2-slot window is wrong, not merely small

- `recordOwnerEvidence` compares a capture against **`last_ip` only** (owner-proof.js, the
  `matchesStoredIp(ip, row.last_ip)` test). Two facilities A/B whose rigs reconnect in turn
  rotate the window on **every** reconnect: `last=b,prev=a` → `last=a,prev=b` → …. Each
  rotation (1) re-stamps `last_ip_at = now`, so the §J3-1 AND+AGE gate reads a freshly-reset
  age and refuses the owner's own destination change (`proof_too_recent`) whenever their rigs
  reconnected inside the last hour; (2) writes an `evidence_displaced` audit row and lights the
  account page's **"Evidence changed"** warning for seven days — for honest churn. With three
  or more sites every reconnect evicts one site's proof.
- The page's "use the **same** password on every rig" was therefore a workaround for the slot
  count, not a security property. **Operator decision 2026-09-22:** it becomes a convenience
  tip; different passwords per site all work; the window becomes a set of ten.

### 17.2 Decisions (all FINAL unless a build finds a hard reason)

1. **Storage is a SET per (address, kind)** in a new table `miner_proofs` (§17.3). Cap
   **`PROOF_SET_MAX = 10` live rows per kind**, a hardcoded constant in `lib/owner-proof.js` —
   not an admin setting: the only reason to keep it small was scrypt cost, and #3 removes that.
2. **Eviction is least-recently-SEEN** (`last_seen_at`), never FIFO. A known value seen again
   refreshes `last_seen_at`; **`first_seen_at` never moves** and is what the age gate reads.
   *(Part 4, §17.7 #3: never moves on a LIVE row — an evicted anchor returning restarts it.)*
3. **One salt per address.** `miner_accounts.proof_salt` (16 random bytes, base64, minted on the
   address's first v2 hash with `UPDATE … WHERE proof_salt IS NULL` then re-read, so two rigs'
   first shares landing together share one salt). Rows store `v2$<hashB64>`; scrypt parameters
   unchanged (N=16384, r=8, p=1, keylen 32, 16 MB). **One scrypt per verify and per capture
   regardless of set size** *(Part 4, §17.7 #5: two for a non-canonical, password-shaped IP)*; digests compared with `crypto.timingSafeEqual`. Legacy
   `v1$salt$hash` rows are copied as-is and cost one scrypt each until evicted; a capture that
   MATCHES a v1 row (the plaintext is in hand at that moment) rewrites it in place as v2.
4. **Anchor unchanged in meaning** (§J3-4): the address's first-ever value of each kind, flagged
   `is_anchor=1` on its own row. Never deleted — when it is the LRU row of a full set it is
   marked `evicted_at` instead of removed. `verifyOwnerProof` reports `slot='anchor'` **only for
   an evicted anchor row**; a live anchor is an ordinary member (today a window hit already
   wins the label). `requireBothProofs` in index.js keeps refusing `slot='anchor'` and any leg
   younger than `MIN_PROOF_AGE_SEC` — its code does not change.
5. **Capture rule** (`mayDisplace` keeps its §J3-4 meaning): refreshing a known live value is
   always allowed; INSERT into an **empty** set is allowed on the first accepted share and that
   row becomes the anchor; INSERT into a **non-empty** set — including re-activating an evicted
   anchor — needs `mayDisplace` (`PROOF_MIN_SHARES = 4`, unchanged). A full set evicts LRU live
   rows until the count is below the cap (evict `count − max + 1`, so a concurrent double-insert
   self-corrects on the next capture instead of growing).
6. **Audit:** `evidence_added` (`kind`, live count after, `evicted` yes/no) on every insert into
   a non-empty set — that is the hostile signature. No row on refresh. `evidence_displaced` is
   retired.
7. **Public account summary** gains `proofs: { ip, pass, max, anchor, last_added_at }` — live
   counts, the cap, whether an anchor row exists, and the newest `first_seen_at` across both
   kinds. Never a value, a hash, a salt, or per-row timestamps. `has_recorded_ip` /
   `has_recorded_pass` stay (derived from the counts). The `evidence` object is removed. The
   admin miner view gets per-kind `{ live, oldest_first_seen, newest_last_seen, anchor_live }`,
   no hashes (§J8-2 stays satisfied).
8. **Account page:** no warning banner. The on-record hint states the counts and the last-added
   time; the "someone else mined to this address" explanation moves into the collapsed *Why
   does my rig password matter?* fold. Password diagnostics keep every reject-reason state;
   **"Mismatch" only when live distinct passwords exceed `max`**; two or more distinct passwords
   within the cap is an OK line. The "same password on every rig" sentences become a tip.
   *(Reversed 2026-09-23 at the operator's request, "less text": the fold is removed. The
   "someone else mined to this address" and "it can't be used to steal your coins" reasoning is
   now an HTML comment above the P-04 gate label, and the account page has no visible home for it.
   The password rules link to the homepage setup guide. Impl §10.5 Part 3 lists where each fact
   went.)*
9. **Legacy columns** (`last_ip`, `prev_ip`, `last_pass_hash`, `prev_pass_hash`, the four `*_at`,
   `anchor_ip`, `anchor_pass_hash`, `anchor_set_at`) are copied into the set by ONE synchronous
   `migrateProofSet(db)` that runs where `backfillProofAnchors` ran — ahead of the stratum
   listener, for the same reason *(Part 4, §17.7 #1: "where the backfill ran" was AFTER the
   listener; it now runs immediately before `stratumServer.start()`)* — and are then **NULLed; the NULL is the idempotency proof**
   (repo style: no marker table; `migrateOwnerProofHashes` + `backfillProofAnchors` are deleted,
   their jobs subsumed). Columns stay in the schema — never `DROP COLUMN`. Mapping: the anchor
   value becomes a row with `is_anchor=1`; if it equals `last` or `prev` that is the same row and
   it is live; otherwise `evicted_at = anchor_set_at` (it was already outside the window). `last`
   and `prev` become live rows with `first_seen_at = last_*_at` / `prev_*_at` (NULL = unknown =
   old, the existing rule). A pre-v1 plaintext value is hashed to v2 with `scryptSync` during the
   copy — bounded, one-time, and no VPS has ever held one.
10. **Not touched:** `PROOF_MIN_SHARES`, the (address, origin) lockout and its counters, the
    AND+AGE gate, `pass_proof_state`, `getPasswordConsistency`, the `withdraw`/`export` rate
    buckets, `verifyOwnerProof`'s signature and return keys (`ok, reason, method, slot,
    age_seconds` — `slot` is now `'set' | 'anchor'`).

### 17.3 Data model

```sql
CREATE TABLE IF NOT EXISTS miner_proofs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  grin_address  TEXT    NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN ('ip','pass')),
  hash          TEXT    NOT NULL,                 -- 'v2$<b64>' (per-address salt) or legacy 'v1$<salt>$<b64>'
  first_seen_at INTEGER DEFAULT NULL,             -- never updated on a live row (a returning anchor restarts it, §17.7); NULL = migrated without a timestamp = old
  last_seen_at  INTEGER NOT NULL,                 -- refreshed on every matching capture; the LRU key
  is_anchor     INTEGER NOT NULL DEFAULT 0,       -- first-ever value of this kind; never deleted
  evicted_at    INTEGER DEFAULT NULL,             -- NULL = live. Only an anchor row can be non-live
  UNIQUE (grin_address, kind, hash)
);
CREATE INDEX IF NOT EXISTS idx_miner_proofs_lru ON miner_proofs (grin_address, kind, evicted_at, last_seen_at);
-- miner_accounts: + proof_salt TEXT DEFAULT NULL (same add-column-if-missing helper as the other 2026 columns)
```

"Live" = `evicted_at IS NULL`. Counts, the cap and the LRU pick all range over live rows only.
A non-anchor row that is evicted is deleted, not flagged.

### 17.4 Threat notes for the review pass

- **Grief ceiling unchanged.** A stranger's proof still lets them trigger a payout to the
  OWNER's wallet (Tor pays the address's onion, a slatepack is encrypted to it) — the accepted
  residue from §E. What changes is that their entry now sits *beside* the owner's instead of
  pushing it out.
- **Evicting an owner's value** now requires out-churning every live owner rig: LRU keeps
  whatever is most recently seen and the owner's rigs keep refreshing. The departed miner is
  covered by the anchor exactly as before.
- **Per-address salt vs per-row salt:** an offline attacker with the DB precomputes scrypt once
  per address instead of once per row — at most a ×10 saving on a 2^32 × 16 MB job, and the
  work still cannot be shared across addresses. Same order, accepted.
- **The CPU lever (§F2 math) holds:** a failed verify costs 1 scrypt + n_v1, where n_v1 ≤ 3 for a
  migrated account and 0 once its v1 rows are upgraded or evicted. Today it is 2–3.
  *(Part 4 measured this as under-stated on both terms — 1–2 v2 digests, and n_v1 counts both
  kinds, so ≤ 6: a transitional ceiling of **8**, above the window's 6. Still bounded by
  FAIL_MAX_IP; see §17.7 #5.)*
- **First capture into an empty set is still cheap**, so an address's anchor is whoever mines
  to it first. Unchanged from §J3-4; the AND+AGE gate is what keeps that from redirecting money.
- **Keying trap (§J3 self-review):** every per-connection question must read
  `session.acceptedShares`, never `shareCount` — the latter counts the whole address.
- **Nothing that reaches a browser may carry a hash or the salt**: `test-public-leakage.js`
  must assert the shape of `proofs` and the absence of `proof_salt`.

### 17.5 Copy that states the old window (must all change)

`public_html/account-settings.html` (P-04 gate block, `PASS_STATE_TEXT`, `renderPasswordProof`,
the fold), `public_html/index.html` (setup guide), `back-end-pool/lib/pool-settings.js` (shipped
CMS defaults — privacy page + FAQ; seeds only, an installed pool keeps its edited pages),
`index.js` `API_DOC_META` for `GET /api/account/:addr`, `admin-panel/users.html`,
`lib/miners.js` + `lib/stratum-server.js` comments, and the prose in audit §E/§F/§J3 (which
describes what WAS — add a pointer to this section rather than rewriting findings).

### 17.6 Status
| Part | Scope | State |
|---|---|---|
| 1 | Backend: `miner_proofs`, per-address salt, set capture/verify, migration, account + admin API, tests | **done 2026-09-22, NOT VPS-tested** |
| 2 | Account page P-04: counts hint, fold text, password diagnostics, demo dataset | **done 2026-09-22, NOT VPS-tested** |
| 3 | Copy sweep (§17.5), docs fold, memory | **done 2026-09-23, NOT VPS-tested** |
| 4 | Independent review of 1–3 against this section + §17.4 | **done 2026-09-23** — 3 code defects fixed, 2 docs corrections, suite 875 → 881; §17.7 |
| 5 | VPS acceptance — **MAINNET**, not testnet (operator decision 2026-09-23): the migration is a one-way door over real balances, `/inject` is testnet-only so a payout test needs a matured real credit (confirm_depth 1440), and every rig is a paying customer. Dry-run the migration on a DB copy first; the go/no-go is "accounts with a balance and no proof row" matching its pre-upgrade baseline | not started |

**Part 3 as built (2026-09-23)** → `script07_implementation.md` §10.4, "Part 3". Copy and comments
only — no logic changed, suite unchanged at **875/875**. Surfaces corrected: the homepage setup
guide's PIN line (`public_html/index.html`), the shipped Terms, Privacy and FAQ defaults in
`lib/pool-settings.js` (four passages, and each page's *Last updated* moved to September 2026), the
`requireBothProofs` comment and the `nostr-destination` `API_DOC_META` row in `index.js`, three
`lib/stratum-server.js` comments, one in `lib/owner-proof.js`, the legacy-column comment in
`lib/db.js`, and pointer notes in audit §J3 and its Status roll-up (findings left as written).
Deltas:
1. **`admin-panel/users.html` needed nothing.** §17.5 lists it, but it states no proof window —
   its "window" is the audit-log time range.
2. **One user-facing error string changed**: the 409 `anchor_not_accepted_here` text claimed "that
   proof is your original recorded one", which since Part 1 fires only for an EVICTED anchor. It now
   says the original has dropped out of the ten most recently used. Same branch, same code, same
   reason string.
3. **⚠ Installed pools do NOT get the new CMS text.** `lib/db.js` seeds the pages table once
   (`migratePagesFromConfig`, marker `pages_seeded`), and there is no restore-to-default control
   for pages — the `/restore` route resets `pool_config` sections, not `pages` rows. A pool that has
   ever started keeps its 2-slot Terms, Privacy and FAQ text until the operator edits those three
   pages by hand in Admin → Pages. Recorded for Part 4, not fixed (no behaviour change this part).

**Part 2 as built** → `script07_implementation.md` §10.4, "Part 2". §17.2 #8 was built as
specified. Three deltas, all additive:
1. **A third hint state** — live counts 0 but the write-once anchor alive. §17.2 #7 does not name
   it and the run plan said "both zero → first-run text", which would tell an account that can
   still reach its wallet that nothing is recorded. Reachable via the migration (an `anchor_*`
   with both window slots empty lands as one evicted row, no live row).
2. **`proofs` absent is its own branch** — an older backend or a cached response gets the old
   whether-not-how-many sentence, and the two cap-dependent password lines fail quiet. A count the
   server did not send is not a fact about the account, and "0 on record" would be a false alarm.
3. **The *Partial* line's advice changed** ("set the same password on every rig" → "set one on
   that rig too — it does not have to match the others"). The run plan said to leave that branch
   alone; §17.5 names `renderPasswordProof` as copy that must change, and Part 3's grep would not
   have found the sentence. Logic unchanged.

**Part 1 as built** → `script07_implementation.md` §10.4. Everything in §17.2 and §17.3 was built
as specified. Deltas, all additive and all recorded in §10.4:
1. **`test-public-leakage.js` got the §17.4 assertions** (the `proofs` shape, the absence of
   `proof_salt`, no digest in a log line). §17.4 asks for them; the run plan's Part-1 file list
   did not name the file. They are API-shape assertions, and Parts 2–3 do not touch it.
2. **`_makeRoom(db, rows, now, headroom)`** — 1 when a row is about to be inserted, 0 for the
   migration's defensive trim. Evicting `live − max + 1` when nothing is being inserted would
   discard a working proof for nothing.
3. **`is_anchor` is computed inside the INSERT** (`CASE WHEN EXISTS (… is_anchor = 1)`), not from
   a snapshot taken before the KDF. Two first captures racing through scrypt would otherwise each
   see an empty set and each claim the anchor. For the same reason `_captureProof` reads the rows
   twice — once to learn which v1 rows need testing, once after the last `await` — so nothing that
   decides (live count, cap, LRU pick) is read across an await from the write depending on it.
4. **`hashProof` (the v1 writer) is exported.** No production path writes v1 any more, but the
   regression suite must build a legacy row through the code that parses one.
5. **`freshDb()` in the test now uses `lib/sqlite-compat.js`**, the wrapper production uses. A bare
   `node:sqlite` `DatabaseSync` has no `.transaction()`, so the migration threw in the test and
   worked in production.

Measured, not assumed — a failed verify costs **1** scrypt on a v2-only set of any size, **1 + n_v1**
on a migrated account that has a salt, **n_v1** while it has none (§F2's throttle is sized on this;
the old window cost up to 6). *(Part 4: incomplete — see §17.7 #5 for the 2 and the 8.)* Suite:
**849 → 875 checks across 15 suites, all passing.**

**Part 1 ships alone.** `account-settings.html` still reads the removed `evidence` object but
guards it with `|| {}`, so it degrades to no warning and no crash until Part 2.

### 17.7 Implementation deltas + the Part 4 review (2026-09-23)

**What building changed against §17**, collected from §17.6: `_makeRoom`'s `headroom` argument;
`is_anchor` decided inside the INSERT; the double read in `_captureProof`; `hashProof` exported;
`freshDb()` on `sqlite-compat.js`; the leakage assertions (Part 1). A third hint state, a
`proofs`-absent branch, the *Partial* wording (Part 2). `users.html` untouched, the 409 text
reworded, the CMS seed-once gap (Part 3). All additive; none changed a §17.2 decision.

**The review** read the code cold, not the build reports. Each of the ten questions, answered
from the code (line numbers as of this review; impl §10.4 "Part 4" has the fix table):

| # | Question | Answer |
|---|---|---|
| 1 | Can the live set exceed `PROOF_SET_MAX`? | **No.** `_captureProof` decides after its last `await` (re-read → `_makeRoom` → insert, all synchronous); the migration trims with `headroom 0`; a re-activated anchor goes through the same `_makeRoom`. But the race found **#2** below: a set could drop to 9 for no reason. |
| 2 | Can an anchor row be DELETED? | **No.** The only `DELETE FROM miner_proofs` is behind `if (r.is_anchor) … else` in `_makeRoom`; no `OR REPLACE` exists anywhere in the backend; `_upgradeV1Row`'s UNIQUE conflict is caught (ABORT, not REPLACE); nothing deletes a `miner_accounts` row. |
| 3 | Does `first_seen_at` move? | **Not on a refresh** (only `last_seen_at` is written). But it failed the question the other way: a returning EVICTED anchor kept its old stamp, which is worse — **#3**. It now restarts, the only write that moves it, and only forward. |
| 4 | Scrypt calls on a FAILED verify | (a) fresh account, no rows: **0** (`no_recorded_proof` before any KDF); with v2 rows: **1**, or **2** for a non-canonical, password-shaped IP (`2001:db8::1`). (b) migrated, three v1 rows of one kind, salted: **4**; no salt yet: **3**; with anchor/last/prev of BOTH kinds and a salt: **8**. §17.4's "1 + n_v1, n_v1 ≤ 3" was low on both terms — **#5**. |
| 5 | Hash / salt / raw value in any output? | **No.** Account view: counts + `last_added_at` (the newest live `first_seen_at` — one row's timestamp, but §17.2 #7 specifies it). Admin view: explicit column list, per-kind aggregates. Audit: `{kind, live_after, evicted}` + coarsened IP + country. `console.*` in `owner-proof.js`: address + reason code or `e.message` only. |
| 6 | Is the migration idempotent, and ahead of the listener? | **Idempotent: yes** (NULLs what it copied; asserted). **Ahead of the listener: NO** — it ran ~130 lines after `stratumServer.start()`, behind `await nostrBridge.start()`, and the §J3 backfill had the same placement since 2026-08-26 — **#1**. Fixed and locked by a source-order check. |
| 7 | Anything keyed on `shareCount`? | **No.** Both guards (`stratum-server.js` donation + capture) and both readers (`miners.js getPasswordConsistency`, `index.js` donors rigs-online) read `acceptedShares`; `shareCount` survives only as a display field. |
| 8 | Tests that drive helpers while production does something else | Three: the cadence (`acceptedShares === 1 \|\| >= 4`) lives in `stratum-server.js` and is never executed by a test — the tests pass `mayDisplace` directly; `destinationLegOk` is a REPLICA of `requireBothProofs` (in step today, and it does not cover the "password in both fields" `method` check); and the migration check that claimed to cover anchor == last used data where they differed, so the common upgrade case was untested (it works; now covered). The "concurrent first captures" check does exercise the re-read — it would fail against the pre-KDF-snapshot draft. |
| 9 | Page vs a backend with no `proofs` | **Degrades correctly.** `proofHintText` falls back to the booleans; `renderPasswordProof` treats `max 0` as "unknown" and drops both cap-dependent verdicts. |
| 10 | Is the grief ceiling still "a payout to the OWNER's wallet"? | **Yes, with #3 fixed.** Withdraw (Tor/slatepack/nostr-to-registered) takes one proof, anchor allowed; destination register takes both legs via `requireBothProofs`, which refuses `slot 'anchor'` and any leg under `max(1 h, cooldown)`. Before #3 a re-activated anchor passed as an aged IP leg — still not theft (the password leg is aged and owner-only), but a hole in the §J3-4 rule. |

**Fixed:**
1. **Startup order** — `migrateProofSet(db)` moved before `stratumServer.start()`. It matters most
   on exactly the pool Part 5 upgrades first: MAINNET, where Nostr payouts may be on.
2. **Duplicate-capture race** — `_captureProof` re-locates its match by its own v2 digest too.
   Needs a v1 row's await window, i.e. a migrated account; the trigger is ordinary (rigs behind one
   NAT reaching `PROOF_MIN_SHARES` together). Reproduced 2 rows lost, fixed to 1.
3. **Returning anchor restarts its age** — `first_seen_at = now` on re-activation. **This amends
   §17.2 #2** ("`first_seen_at` never moves" → never on a LIVE row). The honest-owner cost is one
   cooldown on that one leg, for a miner with more than ten sites whose original returns; their
   other live proofs keep their ages.
4. **`proof_too_recent` text** prints the enforced floor, not `cooldownH` (a 0 cooldown said
   "0 h"); the anchor text interpolates `PROOF_SET_MAX`.
5. **KDF cost statements corrected** (§17.4, impl §10.4, the `verifyOwnerProof` comment) and both
   uncounted cases asserted. Not changed in behaviour: 8 per failed guess while v1 rows survive is
   bounded by `FAIL_MAX_IP = 20` per 10 min (160 KDFs per origin, vs 120 under the window), is
   transitional, and removing it would mean refusing to try an IP-shaped value as a password.

**Decided, not changed:** CMS re-seed stays an operator note (operator-owned legal text; the stale
wording under-states the product, it does not endanger anyone). The Part 3 409 text is accurate.

**Open for Part 5:** the account page says a new password is "on record" at share 1, but on an
address that already has proofs it is inserted at share 4 (`PROOF_MIN_SHARES`). Reword only if
Part 5 measures share 4 taking hours rather than minutes.

Suite **875 → 881** (`test-owner-gate.js` 36 → 42). Each new regression check failed against the
pre-review code before the fix.

---

## 18. Donations v2 — per-share donation + reviewed donor profiles (DESIGN 2026-09-23, NOT built)

Operator review of §16 on 2026-09-23, before its VPS acceptance ran. Three findings, all about
what a miner *believes* the tag does versus what the code does:

1. **The tag was per ADDRESS, not per rig.** `rig01-donate10` stored 10 % against the whole
   address (`miner_incentives.donation_percent`) and `applyToDistribution` took it from **every**
   rig's earnings. A miner with five rigs and one tag donated from all five, and the wall's
   "N rigs online" read as if only the tagged one gave.
2. **Removing the tag did not stop it.** A plain `rig01` login left the stored % untouched; only
   `donate0` cleared it. Two rigs with different tags resolved by connection order.
3. **The raise ceremony read as a bug.** "`donate0`, a few shares, then `donate20`" is a security
   rule (§J6-7: login is unauthenticated, so a stored % must never be raisable by a stranger),
   but to a miner whose software restarts and re-sends the name anyway it looks pointless.

And one product finding: a brand name typed into a worker label (`yourbrand-donate10`) is a poor
channel — 32 lowercase characters, no logo, set through the ceremony, and anyone mining to a paused
address could overwrite it (§16.10 accepted that). This section replaces both mechanisms. **§16 stays
as the record of v1**; where they disagree, §18 wins. The per-session build prompts are kept
outside the repo (plans dir), as for §16/§17.

### 18.1 Decisions (operator, 2026-09-23 — FINAL unless a build finds a hard reason)

| # | Decision | Replaces |
|---|---|---|
| 1 | **Donation is per SHARE.** A share whose worker name carries a live `donateN` token (0–100) donates N % of the PPLNS credit *that share* earns. Nothing is stored per address. | §16.4's stored % + §J6-7's lower-only rule |
| 2 | **No ceremony.** Rename the rig (`rig01-donate20`, or plain `rig01`) and restart the miner — it applies from that rig's next share. `donate0` is now just "a tag of 0 %", equal to no tag. | §16.9's raise/rename ceremony |
| 3 | The worker label is **only a rig name** again. Recommended form `rig01-donate10`; the label in front of the token is no longer captured as a donor name. | §16.1 #1, §16.2's `donor_label`, §16.4 |
| 4 | **Donor profile** = a **nickname** (every donor) + a **banner image** (shown only for the top N of the league, default **5**). Set by the donor on the **account page**, not by worker name and not by email. | §16.1 #1, #13 |
| 5 | Profile writes are gated like a payout-destination change: **both proofs** (mining IP **and** rig password), each **aged** past the same floor (`requireBothProofs`, §J3-1) — plus the address must have **≥ 1 donation debit** (cost to post). | — (new surface) |
| 6 | **Everything is pre-moderated.** A submitted name or banner is invisible to the public until an admin approves it. The word list becomes **flag words** shown in the review queue, not an auto-censor. | §16.1 #3 (post-moderation), #4, #5, #6; §16.5 |
| 7 | Banner formats **PNG, JPEG, GIF** only (animated GIF allowed) — sniffed from the bytes; **SVG and WEBP refused**. | — |
| 8 | Card and account wording state **how many rigs** donate: *"since 2026-09-21 · 2 rigs donating"*, *"Donating to the prize pool: 10 % of new earnings from 2 of 5 rigs"*. | §16.7 `donating 10 %` / `rigs online` |
| 9 | Ranking (§16.6 score, window, loyalty, past strip) and name **expiry** (§16.7 #12) are **unchanged**; expiry now hides an *approved* profile, banner included. | — |

### 18.2 Money path (`lib/rewards.js` → `lib/incentives.js applyToDistribution`)

For a block with PPLNS shares `S`, miner reward `R`, `T = Σ diff`:

```
gross[a]   = Σ_{s ∈ S, s.addr = a}  R × diff_s / T                       (unchanged)
donated[a] = Σ_{s ∈ S, s.addr = a}  R × diff_s / T × pct(s) / 100
pct(s)     = parseDonateToken(s.worker_name)?.percent ?? 0               (lib/stratum-protocol.js)
```

- `shares.worker_name` is already written on every share (post-cut label, token kept — §16.2),
  so no schema change. `rewards.js` builds a `donateMap` beside `minerMap` and passes it to
  `applyToDistribution(blockHeight, minerMap, poolFee, donateMap)`; the donation leg reads
  `donateMap.get(address)` instead of `donationPercent(address)`. Clamp `min(donated, gross)`
  against float drift; skip `RESERVED_ADDRESSES`; only when `incentives_enabled` **and**
  `allow_miner_donations` (a tag on a pool with donations off donates nothing, as today).
- Ledger shape **unchanged**: one `debit/donation` row per address per block, one `credit/donation`
  to `prize_pool`. So `donor-ledger.js`, the prize-pool statement, `reconciliation.js` and the
  rollup need no change — verify, don't assume.
- **Removed:** `IncentivesManager.setDonation` / `donationPercent`, `stratum-server`'s parked
  donation (`session.donationPercent`, `_applyParkedDonation`, the `PROOF_MIN_SHARES` donation
  branch), `_captureDonorName`, `validateUsername`'s `donor_label`, `miners.js donationPercent`.
  `validateUsername` keeps returning `donation_percent` (the login log line and the tag grammar
  tests use it). The `miner_incentives.donation_percent` column and the six v1 `donor_*` columns
  stay in the schema, **unread** — dropping them is a later cleanup, not part of this build.
- **Upgrade effect** (say it in the release note): a v1 address-wide % stops at deploy. A miner who
  tagged one of five rigs now donates from that one only; a miner who removed a tag but never sent
  `donate0` stops donating. Tagged shares already in the PPLNS window still donate — the window is
  ~60 blocks, so for about an hour after a rename a found block can still take the old tag's cut.

### 18.3 Live readings — one helper, three surfaces

`liveDonations(sessions)` (pure, `lib/donor-ledger.js`) over **mining** sessions only
(`acceptedShares > 0`, §J6-9) → `Map<address, { rigs_online, rigs_donating, pct_min, pct_max,
donating_workers[] }>`. Distinct worker names, as the wall's `rigs_online` already counts.
Consumers, all gated on `donationsActive()` (off ⇒ zeros, as today):

| Surface | Reads |
|---|---|
| `/api/account/:addr` | `donation: { rigs_donating, rigs_online, pct_min, pct_max, workers }`; `donation_percent` kept = `pct_max` until the page switches (Part 5), then dropped |
| `/api/account/:addr/workers` | per worker `donate_percent` (from its name; null = untagged) |
| `/api/pool/donors` | per card `rigs_donating`, `pct_min`, `pct_max`; `totals.active_donors` = addresses with `rigs_donating > 0`; `current_percent` kept = `pct_max` until Part 4, then dropped |
| admin `/api/admin/donors` | same three fields per row |

Copy rules: one % → "10 %"; mixed → "5–20 %"; `rigs_donating = 0` → "paused — no tagged rig
online". The wall card: *"since 2026-09-21 · 2 rigs donating"* and *"10 % of new earnings from 2
rigs"*. The account row: *"10 % of new earnings from 2 of 5 rigs online"* + the rig names.

### 18.4 Donor profile — data model

```sql
CREATE TABLE IF NOT EXISTS donor_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  grin_address TEXT NOT NULL REFERENCES miner_accounts(grin_address),
  kind         TEXT NOT NULL CHECK (kind IN ('name','banner')),
  status       TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','replaced','withdrawn','removed')),
  name         TEXT,                 -- kind=name: as typed after normalise (18.5)
  image        BLOB,                 -- kind=banner: the bytes while PENDING only; NULL after any decision
  file         TEXT,                 -- kind=banner: server filename once approved (uploads/donors/)
  mime TEXT, width INTEGER, height INTEGER, bytes INTEGER, sha256 TEXT,
  submitted_at INTEGER NOT NULL DEFAULT (unixepoch()),
  decided_at   INTEGER, decided_by INTEGER REFERENCES users(id),
  reason       TEXT                  -- reject/remove reason, ≤ 200 chars, SHOWN to the donor
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_donor_req_pending  ON donor_requests(grin_address, kind) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS uq_donor_req_approved ON donor_requests(grin_address, kind) WHERE status = 'approved';
CREATE INDEX        IF NOT EXISTS idx_donor_req_status  ON donor_requests(status, submitted_at);

CREATE TABLE IF NOT EXISTS donor_blocks (
  grin_address TEXT PRIMARY KEY REFERENCES miner_accounts(grin_address),
  blocked_at INTEGER NOT NULL DEFAULT (unixepoch()), blocked_by INTEGER REFERENCES users(id), reason TEXT
);
```

- **Why a request log, not columns:** history and audit come free, the two partial unique indexes
  make "one live + one pending per kind" a database fact, and the v1 columns are left alone.
- **Why a BLOB for a pending banner:** a pending image must never be web-reachable, and a new
  on-disk directory would need a deploy-script exclude (the backend rsync `--delete`s the app dir)
  plus a backup entry. In `pool.db` it is backed up by the 089/pool backup for free and served only
  by an admin route. Bounded: ≤ one pending banner per address × 300 KB, NULLed on every decision.
- **State machine** (per address × kind): submit → `pending` (an existing pending → `replaced`,
  blob NULLed) · approve → `approved` (the previous approved → `replaced`, its file deleted) ·
  reject → `rejected` · donor withdraws → `withdrawn` · donor or admin removes the live one →
  `removed` (file deleted). Every transition is one transaction; admin transitions write their
  `admin_audit_log` row inside it (fail-closed, like `adminCensor` did).
- Approving a banner writes `uploads/donors/<16 random hex>.<ext>` (ext from the sniff, never the
  upload), `mkdir -p` on first use, path containment check, mode 0644. Served by nginx's existing
  `location /uploads/` (sandbox CSP + nosniff, already excluded from the rsync and in the backup) —
  **no deploy-script change**. Verify that claim in the build; don't assume it.

### 18.5 Validation

**Name** — trim, collapse internal whitespace to one space, then: 2–32 chars; charset
`A-Z a-z 0-9 space - _ . & '` (ASCII only: no homoglyphs, no RTL overrides); at least one letter
or digit. **Case is kept** (brands are cased). Dots are allowed (a donor may name a domain) —
links are never made clickable. Anything else → 400 with the rule in the message.

**Banner** — multer memory storage with `limits.fileSize = 300 KB` (the limit is what stops a large
body, not a check after buffering it), one file. Then:
1. Sniff PNG / JPEG / GIF from the bytes. **Do not call `detectImage` as-is** — it returns `svg`
   for an XML head; use the binary sniffers only and refuse everything else (SVG, WEBP included).
2. Parse dimensions from the header — PNG IHDR, GIF logical screen, JPEG first SOFn (skip
   APPn/other segments; SOF0–SOF15 except C4/C8/CC). A header that does not parse is a refusal.
3. Width 320–1600, height 80–400, aspect (w/h) 2:1 to 8:1. Recommended on every surface:
   **800 × 200 (4:1)**, "PNG, JPG or GIF (animation allowed), up to 300 KB".
4. Store sha256 + dims + mime; the client's filename and declared MIME are never used.

### 18.6 Routes

**Miner** (public, `rateLimiter.middleware('withdraw')`, every write through `requireBothProofs`
generalised with a purpose string so its errors stop saying "payout destination"; outcomes to
`auditOwnerProof` as `donor_profile_submit` / `_withdraw` / `_remove`):

| Route | Does |
|---|---|
| `POST /api/account/:addr/donor-profile/name` | `{ name, proof, password_proof }` → pending |
| `POST /api/account/:addr/donor-profile/banner` | multipart `file` + the two proofs → pending |
| `DELETE /api/account/:addr/donor-profile/:kind` | `{ which: 'pending'|'live', proofs }` → withdrawn / removed |

Refusals, each with its own reason code: donations off (503) · no donation debit yet
(`not_a_donor`, 409) · `blocked` (403) · the proof codes `requireBothProofs` already emits.

`GET /api/account/:addr` gains `donor_profile`: `{ eligible, blocked, name: { live, state,
pending_at, rejected: { reason, at } | null }, banner: { live_url, width, height, pending_at,
rejected, slot_rank, slots } }`. The **pending name text and pending image are never returned**
here — the account page is public to anyone holding the address. `state` = `shown` · `expired`
· `none`. `slot_rank` = the league rank, so the page can say "shows while you're in the top 5
(you're #8)".

**Admin** (`secureAdmin` reads, `freshAdmin` + audit writes):

| Route | Does |
|---|---|
| `GET /api/admin/donors/requests?status=pending` | the queue: address (full), kind, name, dims/bytes/mime, submitted_at, flags (below), the donor's rank/lifetime |
| `GET /api/admin/donors/requests/:id/image` | the pending or approved bytes; `Content-Type` = stored sniffed mime, `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: no-store` |
| `POST …/requests/:id/approve` · `…/reject {reason}` | transitions above |
| `POST /api/admin/donors/:addr/remove {kind, reason}` | removes a live item |
| `POST /api/admin/donors/:addr/block {reason}` · `/unblock` | submission block; blocking also withdraws that address's pending requests |
| `GET /api/admin/donors/summary` | pending count (the nav badge — replaces "new names this week") |

**Flags** on a queued name (hints, never automatic decisions): reserved word / pool name
(§16.4's `RESERVED` + pool-name rule), a flag-word hit (`donor_name_blocklist`, normalised
substring as today), and **"same as an approved donor"** (normalised equality with another
address's live name — impersonation between donors).
The admin page loads a pending image through `adminFetch` → blob → object URL (a plain `<img src>`
would not carry admin auth); check the admin CSP's `img-src` allows `blob:`.

**Removed:** `POST /api/admin/donors/:addr/censor|uncensor`, the rescan-on-save hook,
`captureDonorName` / `rescanAll` / `adminCensor` / `countNewNames` / `CENSORED_MARKER` from
`lib/donor-names.js` (which keeps `normalise`, `parseList`, `matchEntries`, `RESERVED`,
`STARTER_BLOCKLIST`, `addMonthsUtc`, `donorSettings`).

**Settings:** remove `donor_censored_display`; keep the `donor_name_blocklist` key, relabelled
*"Flag words — highlighted in the review queue"*; add `donor_banner_slots` (int 0–10, default 5,
0 = banners off), bounded in `donorSettings()` and in the write validator.

### 18.7 Public wall (`/api/pool/donors`, `donate.html`)

- Card `name` = the **approved, unexpired** name, else null; `name_state` ∈ `shown` · `masked` ·
  `expired` (`censored` is gone — an unapproved name simply is not there).
- `banner: { url, width, height } | null` — **only** on league cards with `rank ≤ donor_banner_slots`
  and an approved, unexpired banner. Past strip: never.
- **D-03 layout:** a **Top-N spotlight** above the league — rank 1 full width, 2–N in a grid; the
  banner in a 4:1 box, `object-fit: contain`, `width`/`height` attributes set (no layout shift),
  `alt` = the name or "Donor #N", `loading="lazy"`; a spotlight card without a banner shows the
  name large. Ranks N+1… keep today's compact cards. Past strip unchanged.
- **D-01 copy rewrite:** the examples table becomes: `rig01-donate10` → *"this rig donates 10 % of
  what it earns — your other rigs are unaffected"*; whole-name `donate10`; plain `rig01`; typos
  ignored; *"To change or stop: rename the rig and restart the miner. It applies from that rig's
  next share (shares from the last hour keep the old tag if a block is found soon)."* The
  `yourbrandname` row and the raise row are **deleted**.
- **New D-01b "Your donor name & banner":** set it on your account page (Donor profile) with your
  mining IP + rig password; every name and banner is **reviewed before it appears**; the top N
  donors show a banner — 800 × 200 recommended, PNG/JPG/GIF, ≤ 300 KB; one fallback line: contact
  the operator (the pool's contact link) if you can't pass the check.
- Keep *"Names are chosen by the donors…"* reworded: *"Names and banners are chosen by donors and
  reviewed by the pool before they appear."*

### 18.8 Account page (`account-settings.html`)

- Donation row: *"10 % of new earnings from 2 of 5 rigs online"* + the donating rig names; tooltip
  states the per-rig rule and "rename + restart to change". The ceremony text is **deleted**.
- P-03 workers table: a `donates 10 %` badge per tagged rig.
- New **Donor profile** panel (shown when `donor_profile.eligible`, or with a one-line "donate from
  any rig to unlock" otherwise): current name + state; name form; banner upload with a client-side
  preview and the same size/dimension checks *as a hint* (the server is the check); pending /
  rejected (+ reason) / approved lines; withdraw and remove buttons; the two proof fields reuse the
  Goblin-destination form's inputs and help text. The banner line says whether it is displaying
  ("top 5 — showing" / "you're #8 — shows while you're in the top 5").

### 18.9 Security notes for the review pass

- **Money.** The only donation input is `shares.worker_name`, which a stranger controls for **their
  own** shares only — a stranger tagging your address donates their work, never yours. So §J6-7's
  threat (redirect up to 100 % of a victim's future credit) has no state left to attack. The review
  must prove **no money path still reads `miner_incentives.donation_percent`** (grep + a test that
  sets the column to 100 and asserts it moves nothing), and that `donated[a] ≤ gross[a]` for every
  address, including `donate100` and mixed-tag addresses.
- **Profile writes** need both proofs, aged; a donation debit; not blocked; one pending per kind —
  so the queue is bounded by eligible donors and a stranger who mined to an address briefly passes
  neither the age floor nor (without the rig password) the AND.
- **Upload.** Bytes-sniffed allowlist without SVG; header-parsed dimensions bounded (a decoded frame
  ≤ 1600 × 400 × 4 B); size capped by multer before buffering; server filename; pending bytes only
  in the DB; approved files only under `/uploads/` (sandbox CSP + nosniff); the admin image route
  sends the stored mime with nosniff + sandbox + no-store. A polyglot is served as an image and
  cannot render as a document.
- **Leakage** (`test-public-leakage.js` must assert): no pending name, pending image, reject reason,
  blob, decider id or full address on `/api/pool/donors`; `banner` absent below the slot rank and
  on the past strip; `/api/account/:addr` never carries the pending text or bytes. The reject reason
  **is** shown on the donor's own (public, address-addressable) account page — the admin UI says so
  beside the reason field.
- **Type traps** (memory `project_config_loader_type_traps`): `donor_banner_slots` bounded on read
  and write; `which` and `kind` closed enums; `:id` parsed and range-checked.

### 18.10 Status

| Part | Scope | State |
|---|---|---|
| 1 | Money path: per-share donation, v1 parking/capture removed, `liveDonations()` + the additive API fields, tests | not started |
| 2 | Profile backend: tables, `lib/donor-profiles.js` (validation, sniff + dims, state machine, files), miner routes, `requireBothProofs` generalised, account `donor_profile`, settings keys | not started |
| 3 | Admin: queue + image route + approve/reject/remove/block, `donors.html` rewrite, nav badge, v1 moderation removed | not started |
| 4 | Public: `/api/pool/donors` v3, `donate.html` D-01/D-01b/D-03 spotlight, api-docs, leakage tests | not started |
| 5 | Account page: donation row, workers badge, Donor profile panel | not started |
| 6 | Review of 1–5 against §18 + §18.9 (a separate cold session), docs + memory fold | not started |
| 7 | VPS acceptance on testnet with live miners (replaces §16.11 Part 6) | not started |

## Appendix — Solo private pool flowchart, merged from flowcharts/script07_mining_solo_flow_chart.txt 2026-07-09

```text
================================================================================
 07_grin_mining_solo.sh — Solo Private Pool Flowchart   [current as of 2026-07-06]
================================================================================

 Configure & manage solo mining on a Grin node: enable the node's built-in
 stratum, set the coinbase wallet, publish the port, and (optionally) run a
 combined coinbase wallet listener, a stats web page, watchdogs, and a payout
 split for a trusted group.

 Launch:  grin-node-toolkit → 07 Mining hub → Solo private pool
          Optional arg:  07_grin_mining_solo.sh lan   → LAN stats-page mode
          (SOLO_NET_MODE = "public" default | "lan"; only the stats page differs —
           every mining mechanic is identical in both modes.)

 MENU MODEL — network-as-parent (mirrors 059 Grin Drop)
   The top screen picks a network ONCE (1/2); inside that branch SOLO_NETWORK is
   set and inherited, so per-action network prompts are gone. Cross-network tools
   (both-net status, the unified stats page, global watchdogs, maintenance,
   payouts) live on the top screen, not inside a branch. All-numeric keys for
   main actions; letters (A / C) for guided-start and destructive/admin.

 Entry
   └─> main("$1")               $1 == "lan" → SOLO_NET_MODE=lan
         ├─> direct-launch mode guard (skip when SOLO_LAUNCHED_VIA_HUB set):
         │     warn if a deployed stats vhost's mode ≠ the launched mode
         └─> loop: show_menu()  ← network-select screen, loops until 0

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  TOP MENU — Network-select screen  (show_menu / main dispatch)          │
  └─────────────────────────────────────────────────────────────────────────┘
   Header shows show_compact_status(): per-net Node RUNNING/OFF (ss only, no API
   call) + Stratum LISTENING/OFF + bind PUBLIC/LOCAL.

   A) Start here — node check ............ solo_node_precheck()
   1) Configure solo pool Mainnet ........ _set_solo_net mainnet → solo_net_menu()
   2) Configure solo pool Testnet ........ _set_solo_net testnet → solo_net_menu()
   3) Deploy stats web page .............. solo_deploy_stats_page()   (both nets)
   4) Node, Wallet & Mining Status ....... show_node_status()        (both nets)
   5) Watchdogs (global) ................. watchdog_menu()
   6) Maintenance ........................ maintenance_menu()   (lib/07_solo_backup.sh)
   7) Payouts & settlement ............... solo_settlement_menu()     (mainnet)
   C) Clean up solo mining ............... solo_cleanup()   (Danger Zone)
   0) Back to main menu

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  PER-NET BRANCH  (after 1/2 — SOLO_NETWORK set)   solo_net_menu()        │
  └─────────────────────────────────────────────────────────────────────────┘
   Header shows _show_node_info(net): Node / Wallet listener / Stratum / miners
   + toml enable/bind/wallet/burn for the chosen net.

     1) Wallet          ▸  wallet_menu()      (combined coinbase listener)
     2) Stratum         ▸  stratum_menu()     (setup&publish / config / restrict)
     3) Terminal Stats  →  solo_live_stats(net)   (live dashboard, this net)
     0) Back to network select

================================================================================
 A) START HERE — NODE PRE-CHECK   solo_node_precheck()
================================================================================
 Read-only "step 0": solo mining needs a fully-synced node on THIS server.
   ├─> _precheck_one_net(mainnet, 3413, primary)
   │     ├─> ss :3413 → RUNNING? else point at Script 01 (real mining needs it)
   │     └─> gnc_owner_get_status → sync_status / tip.height / connections
   │           no_sync → "✓ Ready to mine" ; *_sync → "⏳ still syncing, wait"
   ├─> _precheck_one_net(testnet, 13413, optional)  [same; "spin one up too"]
   ├─> _precheck_next_action → most-useful next step (mainnet priority)
   └─> can launch Script 01 in-process (build/sync a node without leaving 07)

================================================================================
 1) WALLET — Central coinbase listener   wallet_menu()   (lib/07_solo_wallet.sh)
================================================================================
 Runs the whole wallet flow inside Script 07: init/recover → save pass → patch
 toml → start ONE COMBINED Owner+Foreign listener that receives coinbase and stays
 alive across reboots/crashes. Dir: /opt/grin/solowallet/<net>/.

 Header: sw_listener_status (both nets) + sw_autostart_status + sw_watchdog_status.

   1) Setup / Recover ....... sw_setup(net)
        1. grin_wallet_install.sh → download + verify grin-wallet binary
        2. init (grin-wallet init -h)  OR  recover (init -hr from seed)
        3. _sw_read_new_pass → save passphrase to <dir>/.passphrase (chmod 600)
        4. patch grin-wallet.toml: node_api_secret_path → node's .foreign_api_secret
           + owner_api_include_foreign = true   (mount Foreign on the Owner port)
        5. grin_install_secret_sync → box-wide secret self-heal
        6. sw_port_collision_check, then start the combined listener
   2) Start listener ........ sw_listener_start(net)  → listen.sh in tmux
   3) Stop listener ......... sw_listener_stop(net)
   4) Show address .......... sw_show_address(net)   (grin-wallet -p … address)
   5) Enable boot autostart . sw_autostart_enable(net)   @reboot tag-guarded cron
   6) Disable boot autostart  sw_autostart_disable(net)
   7) Install listener watchdog  sw_watchdog_install    */5 relaunch if port down
   8) Remove listener watchdog   sw_watchdog_remove
   0) Back

 ─── COMBINED LISTENER — `-p owner_api`, and WHY NOT ECDH LIKE THE PUBLIC POOL ──
   The node funds coinbase via the wallet FOREIGN API (build_coinbase). Solo runs:
       grin-wallet <net_flag> -p <pass> owner_api   (owner_api_include_foreign=true)
         → Owner API + mounted Foreign API BOTH on 3420 / 13420
           (NOT the old bare-`listen` Foreign 3415 / 13415)
   · `-p` opens the wallet at startup, so the mounted Foreign build_coinbase works
     IMMEDIATELY — no unlock step. Verified testnet 2026-07-06 (CbData on 13420).
   · Launcher listen.sh reads the pass from .passphrase (not in the tmux argv),
     but the wallet process still shows `-p <pass>` in `ps aux` / /proc/cmdline.

   The public POOL runs the identical owner_api+include_foreign listener but DROPS
   `-p` and unlocks at runtime via an ECDH `open_wallet` helper (Owner API v3:
   init_secure_api → key exchange → open_wallet, keychain mask held in memory).
   Solo deliberately does NOT copy that:
     · ECDH open_wallet is an Owner-API SESSION op — it needs a persistent client
       to run the handshake and hold the mask. The pool already has one (its
       Node/Express backend). Solo has NO backend; adding a Node service JUST to
       unlock a wallet pulls in a dependency solo is designed to avoid.
     · `-p owner_api` reaches the SAME end state (wallet open, Foreign coinbase
       live) with a saved pass file and zero moving parts.
   TRADE-OFF: the saved-pass model exposes the passphrase in the listener's argv
   (same hot-wallet rationale the pool documents in script07_security_audit.md).
   grin-server.toml wallet_listener_url MUST be the BASE URL http://127.0.0.1:3420
   (node appends /v2/foreign itself; a stored /v2/foreign or old :3415 → no coinbase).

================================================================================
 2) STRATUM — enable + publish the node's built-in stratum   stratum_menu()
================================================================================
 Header: show_compact_status(). Setup and Publish are now ONE action.

   1) Setup & Publish ..... _stratum_dispatch setup <net> → _do_setup_stratum()
        find_grin_server_toml(net, api_port)  [running-PID → readlink → scan → prompt]
        ├─> enable_stratum_server = true
        ├─> wallet_listener_url = base URL (default http://127.0.0.1:3420, 13420 test)
        │     normalises legacy values: strips /v2/foreign, snaps old :3415/:13415
        │     → Owner port (combined listener), else node calls a dead port
        ├─> burn_reward = false  (forced — never prompt; can't burn real rewards)
        └─> flows into _enable_stratum():
              ├─> _show_stratum_port_guide → confirm
              ├─> stratum_server_addr = "0.0.0.0:<port>"
              ├─> firewall: 1) all IPs (ufw/iptables, -C guarded) · 2) one IP · 3) skip
              ├─> graceful_restart_grin(api_port, net)   [TERM→wait→tmux restart]
              ├─> print miner connect box: stratum+tcp://<public|LAN ip>:<port>
              │     + worker/login hint "<nickname>.rig1" (dot groups payout split)
              │     + Cloudflare "DNS only (grey cloud)" warning (public mode)
              └─> _solo_watch_for_miner → optionally tail for first miner connect
   2) Manual config ....... _do_configure_stratum()   single-field editor
        show fields 1-4 → pick one → sed patch → graceful_restart_grin
   3) Restrict ............ _disable_stratum()
        stratum_server_addr = "127.0.0.1:<port>" · ufw delete · graceful_restart_grin
   0) Back

================================================================================
 3) TERMINAL STATS   solo_live_stats(net)     (per-net branch ▸ 3)
================================================================================
 Live in-terminal dashboard (Enter = refresh, 0 = return).
   ├─> read .api_secret + .foreign_api_secret from /opt/grin/node/<net>-prune/
   └─> each refresh:
         ├─> curl 127.0.0.1:<api>/v2/owner get_status → height, total_difficulty, peers
         ├─> _solo_network_hashrate: two get_header (Foreign API) over a 60-block
         │     window → Cuckatoo32 GPS = diff_delta × 42 / dt / 16384 (G/s·kG/s·MG/s)
         └─> ss ESTAB on stratum port → miners connected

================================================================================
 3) DEPLOY STATS WEB PAGE   solo_deploy_stats_page()     (top menu ▸ 3)
================================================================================
 ONE unified static page (nginx) shows mainnet + testnet side by side. No Node.js,
 no DB, no systemd. nginx injects Basic Auth per network so the secret never
 reaches the browser. Public mode = domain + Let's Encrypt; LAN mode = plain HTTP.

   ├─> auto-detect nets: have_main/have_test from /opt/grin/node/<net>-prune/.api_secret
   │     (a missing net gets no proxy location → greys out on the page)
   ├─> nginx_install_with_certbot (install up front; bare node has no /etc/nginx)
   ├─> ADDRESS:
   │     LAN mode  → prompt LAN IP (_detect_lan_ipv4) + HTTP port (default 80)
   │     public    → Cloudflare/DNS note → prompt subdomain → nginx_validate_domain
   │                 → DNS pre-check (getent hosts)
   ├─> cp index.html + setup-solo-mining.html + logo → /var/www/grin-solo-mining-stat
   ├─> write data/config.json: stratum ports + advertised IP + slogan + portcheck_api
   │     (collector reads it; editable live — no redeploy for slogan/ports)
   ├─> _solo_prompt_payout_split → write/remove /opt/grin/conf/grin_solo_payment.json
   ├─> install collector (see COLLECTOR below) → cron every 5 min + initial run
   ├─> _solo_prompt_access_lock (public mode) → apr1 htpasswd (see ACCESS LOCK)
   ├─> write vhost:
   │     · per detected net: location = /api/status/<net> → node Owner API get_status
   │       (Basic Auth injected; rate-limit zone solo_stats_api) + wallet liveness probe
   │     · location / → static web_dir ; chmod 600 (b64 token in conf)
   │     · LAN: listen <ip>:<port>   ·   public: listen 80 (certbot adds 443)
   ├─> nginx_enable_site (include + symlink + nginx -t + reload)
   └─> public mode: nginx_run_certbot(subdomain, --redirect) → 443 + HTTP→HTTPS
         on failure: page stays live over HTTP, prompt to fix DNS & retry

   Reused shared-lib helpers (lib/nginx_shared_helpers.sh): nginx_install_with_certbot ·
   nginx_validate_domain · nginx_enable_site · nginx_run_certbot · nginx_test_reload.

 ─── COLLECTOR   lib/07_mining_block_collector.py ──────────────────────────────
   Installed → /usr/local/bin/grin-solo-mining-collector.py (+ wrapper), cron */5,
   state /opt/grin/solo-stats/. Parses the node log → per-net SQLite
   (solo_mining_stats_<net>.db) + derived JSON the page reads:
     blocks_<key>.json · miners_<key>.json · poolstats_<key>.json (miningpoolstats
     pollable) · split_main.json (payout split, mainnet only, when enabled).
   Also maintains the payout ledger (matured-block earnings, chain-verified at
   maturity) and answers the settlement CLI (--list-balances / --record-payment /
   --list-payments) used by menu 7.

 ─── PAYOUT SPLIT (mainnet, display + running balance)  grin_solo_payment.json ─
   Opt-in toggle (one prompt in deploy). For a TRUSTED friend group sharing the
   solo pool: solo always pays ONE coinbase wallet; the split just shows who earned
   what so the operator settles by hand. NO Grin addresses stored, ever.
   · Identity = nickname = worker text BEFORE the first dot (alpha.01, alpha.02 →
     alpha). Automatic grouping; nothing to pre-register.
   · Fairness = matured-block reward (60 GRIN, no halving) split by work-share
     (difficulty-weighted, not raw share count). Only MATURED (chain-verified,
     1440-block) blocks count → an orphan never inflates a split.
   · Running balance per nickname: All-time earn − Paid = To be Paid (see menu 7).

 ─── ACCESS LOCK (public mode)  STATS_HTPASSWD /etc/nginx/grin-solo-stats.htpasswd ─
   Opt-in HTTP Basic Auth over the certbot HTTPS (openssl passwd -apr1 → no
   apache2-utils). Default: PROTECT location / + /api/* + split_main.json; leave
   poolstats_*.json PUBLIC so miningpoolstats.com can still poll. Optional
   sub-choice hides poolstats too. HTTPS-only (the :80 block 301s first).

================================================================================
 4) NODE, WALLET & MINING STATUS   show_node_status()   (top menu ▸ 4, both nets)
================================================================================
   _show_node_info(net) per network:
     ├─> Node   : ss :api → RUNNING (PID, binary, dir, tmux attach hint via
     │            gnc_has_grin_session → gtmux|tmux) / NOT RUNNING
     ├─> Wallet : ss :3420/13420 → LISTENING (combined Owner+Foreign) / NOT RUNNING
     │            / not configured
     ├─> Stratum: ss :stratum → LISTENING + ESTAB miner count / not listening
     └─> toml   : enable / bind / wallet_listener_url / burn

================================================================================
 5) WATCHDOGS (global)   watchdog_menu()   (top menu ▸ 5)
================================================================================
 Four independent keepalives; header shows the state of each.
   1/2) Node-sync watchdog ....... gnk_watchdog_install / _remove   (grin_node_keepalive.sh)
          restarts a WEDGED node (height not advancing vs external reference),
          not just a dead PID. External ref = 2+ THIRD-PARTY nodes (NEVER the
          operator's own api.grin.money — circular). Fetch failure ≠ restart.
          Anti-flap: state file + cooldown + post-restart grace.
   3/4) Node boot-autostart ...... gnk_autostart_enable / _disable  (per net / both)
          ONE shared tag-guarded @reboot cron (also managed by Script 03).
   5/6) Wallet-listener watchdog . sw_watchdog_install / _remove   (*/5, relaunch 3420/13420)
   7/8) Stratum watchdog ......... solo_stratum_watchdog_install / _remove
          (*/5, /etc/cron.d/grin-stratum-watchdog — WARN if stratum drops / drifts)
   0) Back
   NOTE: candidate to fold 1+5+7 into ONE "solo health" */5 cron eventually.

================================================================================
 6) MAINTENANCE   maintenance_menu()   (top menu ▸ 6, lib/07_solo_backup.sh)
================================================================================
 Encrypted backup of everything a solo miner can't recreate.
   1) Deploy new code ...... solo_deploy_code()   re-copy collector .py + web page
                              from the checkout (git pull via Admin 08→8 first)
   2) Backup now ........... sb_backup_now()   AES-256-CBC PBKDF2-600k, pass on fd:3
        archives /opt/grin/solowallet (wallets+binary+seed+.passphrase),
        /opt/grin/solo-stats (SQLite, online-backup snapshot), grin_solo_payment.json
        → /opt/grin/backups/grin_solo_backup_<DDMMYYYY>.tar.gz.enc (600)
   3) Restore from backup .. sb_restore()   pick file → type personal key → extract
                              to original paths (tar -C / -p)
   4) Schedule daily ....... sb_schedule()   cron + <keep>-archive retention
   5) Settings ............. sb_settings()   personal key · retention · list
   6) Show recovery seed ... sb_show_seed(net)   the ultimate wallet backup
   0) Back
   Password model: <personal_key><DDMMYYYY>. personal_key stored b64 in
   grin_solo_backup.conf (600) for the unattended cron; typed by hand on restore.
   NOT backed up: node dir / grin-server.toml (re-publish stratum after restore),
   nor the backup key itself.

================================================================================
 7) PAYOUTS & SETTLEMENT   solo_settlement_menu()   (top menu ▸ 7, MAINNET)
================================================================================
 Requires the mainnet stats DB (deploy stats page ▸ 3 with payout split enabled).
   Shows a per-nickname running balance:
     All-time earn (matured-block rewards) − Paid (recorded) = To be Paid.
   1) Record a payment ..... _settlement_record_payment()
        numbered picker (biggest To-be-Paid first) → nickname → amount
        (Enter = full owed) → note → confirm → collector --record-payment
        → refresh split_main.json now (don't wait for cron)
   2) Payment history ...... _settlement_show_history()   latest 20, newest first
   0) Back
   Pay each nickname OUT-OF-BAND (one normal Grin tx from your own address book),
   then record it here so 'To be Paid' drops. No address is ever stored or shown.

================================================================================
 C) CLEAN UP   solo_cleanup()   (top menu ▸ C, DANGER ZONE)
================================================================================
 Removes solo infra (stratum config revert, collector bin/wrapper/cron + state,
 stratum watchdog, stats vhost/web dir) with per-group confirmation. KEEPS the
 node + grin-server.toml, the wallet seed (/opt/grin/solowallet), and encrypted
 backups (/opt/grin/backups) + key. Full destructive wipe lives in Script 08del.

================================================================================
 INTERNAL HELPERS
================================================================================
  find_grin_server_toml(net, api_port)   ss PID → readlink /proc/pid/exe → toml;
        else scan known dirs by chain_type; prompt if multiple/none → FOUND_GRIN_TOML
  _resolve_stratum_toml(net, api_port)    non-interactive variant (status screens)
  graceful_restart_grin(api_port, net)    ss PID → binary/dir → tmux session →
        kill -TERM (wait 30s, -KILL) → SHELL=/bin/bash tmux new-session restart
  _find_grin_session_for_pid(pid)         map node PID → tmux session name
  _detect_public_ipv4 / _detect_lan_ipv4  advertised stratum host (Internet / LAN)
  _stratum_bind_line(toml, port)          PUBLIC/LOCAL/not-set for the status header
  sw_* (lib/07_solo_wallet.sh)            combined listener / cron / watchdog / address
  gnc_* (lib/grin_node_control.sh)        gnc_owner_get_status · gnc_has_grin_session
  gnk_* (lib/grin_node_keepalive.sh)      node boot-autostart + node-sync watchdog

  Sourced libs: nginx_shared_helpers · grin_node_secrets · grin_node_control ·
  grin_node_keepalive · 07_solo_wallet · 07_solo_backup · grin_wallet_install.

================================================================================
 PORT REFERENCE
================================================================================
  Stratum (miners → node)            Mainnet 3416   Testnet 13416
    grin-server.toml → stratum_server_addr
  Node Owner API (local — stats/watchdog/precheck)   Mainnet 3413   Testnet 13413
  Wallet combined listener — Owner API + mounted Foreign (coinbase delivery)
    Mainnet 3420   Testnet 13420
    grin-server.toml wallet_listener_url → http://127.0.0.1:3420  (node adds /v2/foreign)
    (was bare-`listen` Foreign 3415/13415 before the 2026-07-06 combined
     `-p owner_api` + owner_api_include_foreign change)

================================================================================
 SECURITY MODEL
================================================================================
  · Node .api_secret (/opt/grin/node/<net>-prune/) never leaves the VPS; nginx
    injects Basic Auth for /api/status → browser never sees it; conf chmod 600.
  · Wallet .passphrase (/opt/grin/solowallet/<net>/) chmod 600 — enables unattended
    `-p owner_api` boot; trade-off = passphrase in the listener argv (ps aux).
  · Stratum opened to 0.0.0.0 only when the operator runs Setup & Publish (firewall
    rule added then); Restrict reverts to 127.0.0.1.
  · Access lock (optional, public mode): apr1 htpasswd 640, HTTPS-only; keeps
    poolstats_*.json public for miningpoolstats unless the operator opts to hide it.
  · Payout split stores NO Grin addresses — nicknames + % + GRIN only.
  · Node-sync watchdog never trusts a bare PID and never uses the operator's own
    endpoint as the external truth (circular); external fetch failure ≠ restart.

================================================================================
 LEDGER / TIME conventions
================================================================================
  · Collector ledger day-keys + timestamps in UTC; the web page converts UTC →
    the viewer's local timezone for display.
  · Matured-block counting is chain-verified at 1440 maturity (get_block hash
    compare) so an orphan never inflates a payout.
  · Testing: local `bash -n` + /check + /review only (needs a Linux + root VPS to
    run); the operator runs live on the VPS.

================================================================================

```

================================================================================
 ABANDONED-BALANCE DISPOSITION + MANUAL PAYOUT  (add-ons, 2026-07-22)
================================================================================
Problem: the pool is custodial between credit and payout. A miner can accrue a
balance then vanish (lost seed/pass, abandoned rig). Left forever, these balances
bloat the ledger and sit as an unbacked-looking liability. Operator question:
what to do with them, correctly and defensibly?

DECISION (locked with operator, 2026-07-22):
  · An address with NO accepted share AND NO successful payout for `dormancy_months`
    (default 24), still holding a balance, is "abandoned".
  · Its balance is SWEPT and REDISTRIBUTED to miners active in the last
    `dormancy_active_window_days` (default 30), weighted by recent sustained work
    (hashrate_history — raw shares prune within ~a day, so they can't back a 30-day
    window; hashrate_history is kept 100d and is the same source the lottery uses).
  · Disposition is FINAL. The owner reclaims any time BEFORE it (account-page
    countdown + public masked list) by simply requesting a payout. NOT after.
  · Funds go to ACTIVE MINERS, NEVER the operator. This is the ethical anchor and
    the line the ToS/banner must state.
  · Why final-and-redistribute (not reserve, not reclaim-forever): the "redistribute
    + reclaim-forever" combo is exploitable — a whale can let one address go dormant,
    farm most of the redistribution back to its active addresses, then reclaim the
    original from pool funds. Making disposition FINAL kills the exploit (the faker
    just loses money waiting) while still rewarding the miners who secure the pool.
    OFF by default — enabling it is a deliberate, disclosed operator decision.

┌── REVISION 2026-07-22b (operator): DESTINATION CHANGED → COMMUNITY PRIZE POOL ──────┐
│ After discussion, the swept balance is NO LONGER split among active miners. It is    │
│ swept into the single `prize_pool` bucket instead — where it is given away through   │
│ the pool's existing, publicly-auditable draws (Pot A whale-cap + Pot B equal-chance).│
│ WHY the change (simpler + more transparent + fairer):                                │
│   · Deletes the entire recipient-selection engine — no equal-vs-weighted decision,   │
│     no Sybil-per-address hole (equal split would be farmable), no dust-spraying a     │
│     tiny balance across hundreds of miners (0.005 GRIN each = pointless + N log rows),│
│     no "no active recipients → defer" edge case. Prize pool always exists.            │
│   · Small dormant balances (the typical case — sub-threshold dust that could never    │
│     auto-pay) accumulate and are handed out in meaningful chunks, not sprayed.        │
│   · Small miners still get the "fair" outcome via Pot B equal-chance, but behind the  │
│     lottery's anti-Sybil gates (min-active-days + min-work) — not a raw money split.  │
│   · Still an INTERNAL transfer, still NEVER the operator. Because prize_pool is        │
│     excluded from custodial liability, sweeping there correctly REDUCES miner-owed.   │
│ LEDGER: per-source debit reference_type='dormant_sweep' UNCHANGED; the credit is now  │
│   a SINGLE row to prize_pool, reference_type='dormant' (was per-recipient             │
│   'dormant_payout'). Σdebit == the one credit → integrity invariant still nets 0      │
│   (INV_CASES sums credit/debit regardless of ref_type). remainder always 0,           │
│   recipient_count always 1. No reconciliation break; added prize.from_dormant to the  │
│   bucket breakdown for transparency.                                                  │
│ TRANSPARENCY (the point of the change): incentives.prizePoolStatement() = lifetime    │
│   in/out by source over the rollup horizon; public GET /api/pool/prize-pool +          │
│   donate.html D-05 panel; admin GET /api/admin/incentives/prize-pool statement +      │
│   settings-incentives.html breakdown. The earlier "whale exploit" rationale below is   │
│   now moot — a whale can't farm a lottery pot back the way it could a direct split.   │
└──────────────────────────────────────────────────────────────────────────────────────┘

GRANDFATHERING: the clock counts from max(last_activity, dormancy_policy_effective_at).
The first enabled run stamps `dormancy_policy_effective_at = now` and disposes NOBODY,
so every address gets a full window of runway after the policy goes live. Operators can
only ever push the anchor later (more runway), never retroactively shorten it.

LEDGER MODEL (why it's safe on the custodial books):
  · Disposition is an INTERNAL transfer: Σ debited from sources == Σ credited to
    recipients (rounding remainder handed to the top-weight recipient), so the
    reconciliation integrity invariant nets to exactly zero and the coins never leave
    the wallet. Fresh reference_types keep it OUT of the external IN/OUT flow:
      - debit  source     → reference_type='dormant_sweep'
      - credit recipient  → reference_type='dormant_payout'  (reference_id = batch id)
    reconciliation.js INV_CASES sums by event_type (credit +, debit −), so no change
    to reconciliation.js is needed; ledger-rollup keeps (addr,event_type,ref_type) as
    dimensions so the new types roll up automatically.
  · Guards: excludes reserved pseudo-addresses (pool_fee/prize_pool) and banned
    addresses; freeze-aware (skips while payouts frozen); DEFERS if there are no active
    recipients (never sweeps into the void — balances stay put, reclaimable).

SUB-THRESHOLD PAYOUT (below-min "email support to withdraw" flow):
  A below-min miner who wants to stop and withdraw emails support. Admin first verifies
  ownership — types the CLAIMED mining IP or rig password into
  /api/admin/dormancy/verify-owner → verifyOwnerProof() returns match/no-match ONLY
  (proofs are salted-scrypt hashes; nothing is revealed). Then TWO paths (the
  "Tor + hardened recorder" scope chosen 2026-07-22):

  PRIMARY — backend-initiated Tor send (/api/admin/dormancy/send-payout, freshAdmin):
    the pool sends it itself, through the SAME locked withdrawal flow a miner uses, via
    withdrawalScheduler.createWithdrawal(addr, amt, 'tor', {adminOverride:true}). The new
    `adminOverride` opt bypasses ONLY the min-withdrawal floor + the post-failure reversal
    cooldown; the freeze, the CAS balance lock, and the one-pending-per-address cap (the
    double-pay guard — a second send while one is pending is rejected 429) ALL still apply.
    Real network fee + kernel are captured by the scheduler and recorded automatically —
    no out-of-band step, no send-then-record window. Requires the miner's wallet listener
    reachable over Tor (scheduler declines + reverses the lock if not).
    withdrawal_events.triggered_by = 'admin_override'.

  FALLBACK — recorder (/api/admin/dormancy/manual-payout, freshAdmin): for a send the
    admin already made out-of-band (slatepack / wallet CLI). manualPayout() writes a
    CONFIRMED withdrawals row (method='manual') + a 'withdrawal' debit — SAME taxonomy as
    an automated payout, which keeps coverage correct AND makes
    reconciliation.auditWalletSends() MATCH the send instead of flagging false theft.
    Never raw-subtract a balance (breaks the integrity invariant). HARDENED against
    double-submit (review finding #1): dedup rejects a duplicate kernel_excess/slate_id
    (a unique on-chain id) or an identical (address, amount, method='manual') within 60s
    → {ok:false, duplicate_*}; the frontend also disables the button in-flight. Without
    this a resubmit would write a 2nd debit for one real send → over-debit + audit drift.

  SLATEPACK from the admin panel is deliberately NOT built as a broker UI — an interactive
  Mimblewimble tx is an unavoidable 2-message round-trip (there is no non-interactive
  slatepack send in Grin), so slatepack cases route through the recorder rather than
  pretending the panel makes them convenient.

CODE MAP:
  · lib/dormancy.js — DormancyManager: _candidates, listDormant (masked/unmasked),
    statusFor (account countdown), history, preview (dry-run), runOnce (the atomic sweep
    → single prize_pool credit; 6h scheduler + first pass 60s after boot), manualPayout.
    maskAddress = grin1qxy…mn4p. (_activeRecipients removed in the 2026-07-22b revision.)
  · lib/incentives.js — prizePoolStatement(recentLimit): lifetime in/out breakdown by
    source (fee_cut/donation/topup/dormant in; prize_award/jackpot/join_bonus/streak out)
    over the ledger-rollup horizon + balance + recent rows. Shared by admin + public.
  · db.js — dormancy_dispositions (one row/batch) + dormancy_disposed_sources (one
    row/swept address); never pruned → historical detail behind the public page after
    raw balance_log prunes at 60d.
  · pool-settings.js — payout.{dormancy_enabled(false), dormancy_months(24),
    dormancy_active_window_days(30), dormancy_policy_effective_at(0=auto)} + validators;
    ToS `terms` default gained "4. Abandoned and unclaimed balances" (existing pools
    must add the clause manually — pages are seeded once into the CMS `pages` table).
  · lib/withdrawal-scheduler.js — createWithdrawal() gained a 4th arg `opts`; opts.adminOverride
    bypasses only the min floor + reversal cooldown (all other guards intact) and stamps
    withdrawal_events.triggered_by='admin_override'.
  · index.js — GET /api/pool/unclaimed (public, masked: dormant list + disposition
    ledger); account `/api/account/:addr` gains a `dormancy` field; admin GET
    /api/admin/dormancy (status+preview+unmasked list+history, secureAdmin), POST
    /run + /manual-payout + /send-payout (freshAdmin) + /verify-owner (secureAdmin).
    /send-payout honours the freeze and maps createWithdrawal's numeric .code to HTTP status.
  · Frontend — payment-history.html: page-scoped notice banner (payout part only, NOT
    site-wide) + U-01 tiles / U-02 masked dormant list (+ "check your own account page"
    disambiguation) / U-03 redistribution ledger. account-settings.html: per-address
    dormancy notice (counting/eligible/disposed) + a sub-threshold "email support" note
    (#acct-subthreshold, shown only when 0<balance<min; reuses branding.js contact-link).
    admin payments.html: dormancy KPIs + "run now" + "Pay a below-minimum miner" (ownership
    verify → ⚡Send Tor payout now [primary] OR Record out-of-band send [fallback, button
    disabled in-flight]) + dormant list + history. settings-payout.html: config controls.

STATUS: BUILT on `add-ons` 2026-07-22, node --check + integration smoke tests (temp DB:
disposition weights/remainder, reserved+banned exclusion, grandfather, over-balance reject;
below-min adminOverride locks funds + one-pending cap blocks a 2nd send; recorder dedup
rejects duplicate kernel/slate/recent, no double-debit — all verified). NOT YET VPS-tested.
