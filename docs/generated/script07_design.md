# Script 07 — Public Mining Pool (Design)

> ⚠ **SUPERSEDED — multi-region (§3–4) was re-architected to Model C (2026-06).**
> The satellite/relay "node + stratum proxy + share relay per region" design described in
> §3, §4, and §11 below is **removed**. Regions are now **thin stratum gateways** (HAProxy +
> WireGuard) that forward miner stratum to ONE central node + wallet — no edge node/wallet, no
> `/api/shares` ingestion API, no `hub_shared_secret`. **Authoritative Model C design:**
> the Model C appendix of [`script07_implementation.md`](script07_implementation.md)
> and the "Multi-region — Model C" section of `.claude/CLAUDE.md`. The rest of this doc (database,
> API, reward pipeline, payments, white-label, UI) is still current.

**Product:** `scripts/07_grin_mining_public_pool.sh` + web app under `web/07_mining_pool_public/`.
**Scope:** the complete public-pool design — architecture, deployment modes, multi-region
federation, database, API, reward pipeline, payments, white-label, and UI/UX.

> **Companion docs (max-3 convention):**
> [`script07_implementation.md`](script07_implementation.md) — deploy, runbook, status, troubleshooting ·
> [`script07_security_audit.md`](script07_security_audit.md) — vulnerabilities, hardening, fixes.
> The **solo** miner (`07_grin_mining_solo.sh`) is a separate product —
> see the solo flowchart appendix at the end of this file.
>
> This file absorbs the former `script07_multi_region_design.md` and the imported
> `script07_public_pool/` GRINIUM doc set (deleted 2026-06-08). Where those described the
> standalone **Grinium** repo (`web/back-end-pool/`, ports `3002/3416`), this doc uses the
> **toolkit** layout (`web/07_mining_pool_public/`, ports `3333/3334/8080`).

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
│   incentives · lottery · retention · share-relay              │
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

## 3. Deployment modes (hub-and-spoke) — ⚠ SUPERSEDED by Model C
> The `satellite` role below was removed. Roles are now `singlebox | hub` (app) plus a thin
> `gateway` (HAProxy+WireGuard, no app). See the Model C plan + CLAUDE.md.

Script 07 has a **mode selector** (may be passed non-interactively as `$1`):

```
Script 07 ─ install mode:
  1) Single-box pool   (Hub + local Satellite on one server — original behaviour)
  2) Central Hub       (brain only; remote satellites relay in)
  3) Satellite         (regional node + proxy + relay → points at a Hub)
```

| Mode | Deploys | Library | Config file |
|---|---|---|---|
| **singlebox** | Everything on one box (Hub + co-located Satellite) | core `pool_*` fns | `grin_pubpool.json` |
| **hub** | Central API (sole DB writer) + SQLite/WAL + schema + retention + web dashboard + admin + wallet (Tor payouts) + nginx | `scripts/lib/07_lib_hub.sh` | `grin_pubpool.json` |
| **satellite** | Regional node + stratum proxy + share relay — **no** web/admin/DB/wallet | `scripts/lib/07_lib_satellite.sh` | `grin_satellite.json` |

`config.js` selects mode via the `role` key (`singlebox` | `hub` | `satellite`).

---

## 4. Multi-region — why SQLite stays, and how shares federate — ⚠ SUPERSEDED by Model C
> Shares no longer "federate" over HTTP. Gateways forward raw stratum over WireGuard to a
> per-region central listener port; the central box records every share directly (still
> single-writer SQLite). The `/api/shares` + `/api/blocks` transport below is removed.
> The SQLite-single-writer rationale still holds. See the Model C plan + CLAUDE.md.

### Single-writer by design
Trace every arrow that reaches the DB: there is exactly **one** — `Central API → DB`. Satellites,
nodes, stratum servers, and relays never open the database. Three regions ingest shares, but all
paths converge on **one Central API process**, and only that process writes.

```
Satellite (Asia)   ─ relay ─ HTTPS POST /api/shares ─┐
Satellite (USA)    ─ relay ─ HTTPS POST /api/shares ─┼─▶ Central API ──▶ SQLite (WAL)
Hub-local stratum  ─ in-process ─────────────────────┘   (single writer)        ▲
                                                                                 │
                                                  Dashboard ── reads ────────────┘
```

"Concurrent writes from 3 regions" is **connection** concurrency at the HTTP layer (Node's event
loop), not **database-writer** concurrency. The Central API accepts concurrent POSTs, then batches
each interval's shares into one transaction. SQLite WAL gives one writer + unlimited concurrent
readers, 100k+ batched inserts/sec (vs ~100 shares/sec for a 1,000-miner pool), and single-file
backup. **Adding a satellite is a new HTTP client, not a new DB writer — so SQLite keeps fitting.**

**Migrate to PostgreSQL only if the hub topology changes** so the DB stops having a single writer:
Central API goes multi-process/replicated behind an LB; the DB moves onto a separate box (SQLite has
no network protocol — NFS/SMB breaks its locking); sustained >10k durable shares/sec; hot relational
data >~20–50 GB; or you need multi-master/hot-standby. **Never MariaDB.**

PRAGMAs at DB creation: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`,
`foreign_keys=ON` (file space reclaimed by the weekly `VACUUM` cron — Script 07 option C).

### Share capture = own stratum proxy (not log-tailing)
In Grin the node's stratum is integrated with no clean external `getblocktemplate`, so the practical
"own server" is a **stratum proxy in front of the node's built-in stratum** (the proven `grin-pool`
model):

```
Miners ──stratum──▶ Stratum Proxy ──stratum (client)──▶ node built-in stratum (localhost)
                         │
                         └── structured share/block events ──▶ Share Relay ──▶ Hub
```

The proxy binds the **public** stratum port (`3333`); the node's built-in stratum binds **localhost
only** (`3334` / testnet `13334`). It sees every `login`/`submit` as structured JSON → reliable
`address.worker` identity + difficulty + nonce + timestamp, per-miner **vardiff**, dedup by
`(nonce, height)`, rate-limits, and abuse bans. Log-tailing was **rejected** (brittle format, one
global difficulty, no guaranteed per-share identity).

### Satellite → Hub transport
- `POST /api/shares` (batched) + `POST /api/blocks` (block-found) to the Central API `:8080`.
- Auth: shared-secret header over HTTPS + optional IP allowlist (mTLS later).
- Payload e.g. `{"region":"us-east","worker":"addr.rig1","difficulty":100,"timestamp":…}`.
- On Hub outage the relay buffers to a **local SQLite failover file** and replays (at-least-once;
  idempotent on the hub via `share_hash` / block `hash` UNIQUE).

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
| `shares` | PPLNS input (grin_address, worker, difficulty, block_height, **region**, created_at) — `region` tags the originating region (local stratum → `config.region`; ingested → satellite's region) for per-region stats; PPLNS weighting is region-agnostic | sliding window (pruned) |
| `blocks` | found blocks + maturity (height, hash, nonce, reward, status, found_by) | forever |
| `withdrawals` | payouts (amount, fee, method tor\|slatepack, status, retry_count, txid) | forever |
| `balance_log` | append-only ledger of every balance/locked change | raw window `balance_log_keep_days` (default 60, floor 45) — rolled into `balance_log_daily` first; see §14 |
| `balance_log_daily` | daily rollup of the ledger — (UTC day, address, event_type, reference_type) → total_amount, event_count | **forever** (≈150 MB/10 yr @1000 miners) |
| `withdrawal_events` | per-withdrawal state-transition log | forever |
| `users` | admin accounts only (bcrypt, lockout columns) | forever |
| `admin_audit_log` | every admin mutation (admin_id, action, target, before/after, ip) | forever |
| `pool_settings` | runtime config overrides editable via admin UI (key/value/value_type) | live |
| `pool_locations` | operator-declared regions (region UNIQUE, label, api_url, stratum_url, is_active) — descriptive registry joined onto live share aggregates by `region`; ingestion auth is the pool.json allowlist+secret, not this table | live |
| `hashrate_history` | timeseries + per-region aggregates | pruned by age |
| `miner_incentives` | per-address join_bonus_paid, donation_percent, streak_days | live |
| `lottery_draws` / `lottery_winners` | verifiable lottery state | forever |

`pool_fee` and `prize_pool` are **reserved pseudo-addresses** (rows in `miner_accounts`) filtered
out of every miner-facing surface. Money flows through `balance_log` for audit.

---

## 6. API catalog (Express routes)

> **Verified against `back-end-pool/index.js` (2026-06-08; account + payout routes re-verified 2026-07-13).** ✅ = wired in the backend ·
> ❌ = documented target, not yet built (see "Not yet implemented" below). Paths are the
> *actual* registered routes — earlier drafts of this catalog overstated the surface.

**Public — no auth (address is identity):**
```
✅ GET  /health  |  /api/health                         (alias; nginx proxies /api/*)
✅ GET  /api/pool/stats | /api/pool/stats/regions | /api/pool/blocks | /api/pool/payments
✅ GET  /api/pool/miners (by balance) | /api/miners/top | /api/pool/locations
✅ GET  /api/stratum/stats | /api/stratum/hashrate | /api/config/pool-info
✅ GET  /api/account/:addr | /:addr/balance | /:addr/balance/log | /:addr/shares | /:addr/tor-check
✅ GET  /api/account/:addr/workers | /:addr/hashrate/history
✅ POST /api/account/:addr/withdraw   { amount?, method?, ip_proof? }   (Tor auto; Slatepack IP-gated)   [IMPLEMENTED 2026-07]
✅ POST /api/account/:addr/withdraw/:id/finalize   { response_slatepack, ip_proof }   (Slatepack S2 finalize)   [IMPLEMENTED 2026-07]
✅ POST /api/account/:addr/min-payout   { min_payout, ip_proof }   (per-miner threshold; IP-gated, ≥ pool min)   [IMPLEMENTED 2026-07]
✅ GET  /api/public/branding | /public/page/:key | /public/lottery/winners
✅ GET  /robots.txt | /sitemap.xml | /manifest.json     (dynamic, exact-match nginx proxies)
⚠ /api/claim/:id?token=…   — claim-token route SUPERSEDED (never built); Slatepack payout now ships via the
                              IP-gated account self-service flow above (§8), not a claim link
```

**Ingestion (satellites only — IP allowlist + shared secret; region-tagged):**
```
✅ POST /api/shares   (batched; { region, shares:[…] } — region stamped onto each share row)
✅ POST /api/blocks   (block-found; { region, block:{…} })
```
Both also feed the in-memory satellite-liveness monitor surfaced at `/api/admin/health/satellites`.

**Admin auth (admin register is CLI-only):**
```
✅ POST /api/auth/login | /refresh | /logout | /change-password
❌ POST /api/auth/reauth     ❌ GET /api/auth/me        (fresh-reauth/whoami — NOT built)
```

**Admin (`requireAdmin` = rate-limit + IP filter + JWT):**
```
✅ GET  /api/admin/dashboard | /metrics | /audit-log
✅ GET  /api/admin/health/node | /health/wallet | /health/system | /health/satellites
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
  The legacy `back-end-pool/admin-panel/users.html` UI references user-CRUD; the primary admin surface
  (`public_html/admin-dashboard.html`) does not depend on it.
- **`/api/admin/miners/:addr` PUT**, **`/api/auth/reauth` + `/me`**, **`/api/admin/payment-stats`**.

---

## 7. Reward pipeline (PPLNS)

```
1. Stratum proxy detects a found block → blocks(status=pending, nonce, height, reward)
   - single-box/hub: BlockManager.creditBlock (local DB)
   - satellite: relay POST /api/blocks → hub credits
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
- **Orphan reversal** reads the *actual* credited amounts from `balance_log` and reverses those
  exact values (PPLNS-weighted, including the fee credit); never pushes a balance below 0.
- **Payout threshold:** default `min_withdrawal` = **25 GRIN** (raised from 5.0 on 2026-07-13; agrees
  across `config.js`, `pool-settings.js`, admin `settings-payout.html`, and the
  bash installer). Rationale: each payout is an interactive tx that adds a **permanent kernel** to the
  chain, so a low floor multiplies both chain growth and pool payout load. Operator-editable in the
  admin panel. Each miner may set a personal `min_payout` override (IP-gated
  `POST /api/account/:addr/min-payout`) that can only **raise** the floor — enforced at write time and
  re-checked in `withdrawal-scheduler.js`, so an override never drops a payout below the pool minimum.

---

## 8. Payments — Tor + Slatepack (one state machine, two transports)

Every Grin transaction is interactive (2-of-2). "Tor" and "Slatepack" are two **transports** for the
same slate round-trip, so there is **one** withdrawal state machine with a `method` dimension; only
"deliver the slate" branches. Balance locking, retry, reversal, ledger, and audit are shared.

| Transport | Miner does | Works if miner offline? | Pool calls |
|---|---|---|---|
| **Tor** | nothing (listener auto-signs) | no | `init_send_tx` → post over Tor → `finalize_tx` |
| **Slatepack** | copy-paste S1 → sign → paste S2 | yes | `init_send_tx` (lazy) → miner returns S2 → `finalize_tx` |
| *Relay (future)* | nothing (relay delivers async) | yes | Grin Transporter / [092 Transporter](script09_design.md) |

**Auto-payout** (6h scheduler, no human) can only attempt the zero-interaction method (Tor); on Tor
failure to an offline miner the withdrawal becomes **Slatepack-claimable** instead of reversing.

**Slatepack security — IMPLEMENTED 2026-07 (differs from the original claim-token/payment-proof plan):**
the slate isn't inherently address-bound (the receiver supplies their output in S2), so two controls
apply: (1) an **IP ownership gate** (`lib/owner-proof.js`, anti-grief/anti-spam) — the requester must
present one of the address's last-2 mining source IPs, throttled 8/10min → 5min lockout; (2) **encryption
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
per address** (429). Tor retry backoff 6/12/24/48h, then permanent fail; no TCP port-probe before
send (probing leaks Tor circuit identity). Reference Slatepack pool: GaeaPool.

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
+ draw seed for audit). **Grin Transporter** payout rail (#3) is a reserved, forced-off placeholder
([092 Transporter](script09_design.md)).

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
| Public stratum (miners) | 3333 | 3333 | Public |
| Node built-in stratum (proxy upstream) | 127.0.0.1:3334 | 127.0.0.1:13334 | localhost only |
| Central API / Pool HTTP API | 8080 | 8080 | Public web; ingestion satellites-only (allowlist+secret) |
| Web dashboard | 443 | 443 | Public |
| Node API (Owner/Foreign) | 3413 | 13413 | localhost |
| Wallet Foreign / Owner | 3415 / 3420 | 13415 / 13420 | localhost |
| P2P | 3414 | 13414 | Public |

> The single-box installer was migrated off the legacy `3416/3417/3002` to `3333/3334/8080` in
> 2026-06 (bash + backend in sync — see `config.js`). The **solo** product (`07_grin_mining_solo.sh`)
> keeps `3416`.

---

## 12. Follow-ups (not implemented)

> Tracked as deferred decisions D2–D9 in
> [`script07_implementation.md`](script07_implementation.md) → "Deferred decisions & open items".
> Do not re-implement without a product call. (The 2026-06-08 security hardening — trust proxy,
> bcrypt 12, lockout, refresh revocation, jwt fail-loud, escHtml, confirm_depth 1440 — is **done**;
> see that doc's status table and security audit §B.)


- Move money columns from `REAL` GRIN to **integer nanoGRIN** (engine-independent; do it in SQLite,
  carries to Postgres later).
- mTLS for satellite→hub transport (v1 is shared-secret over HTTPS).
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
  metadata-only region / satellite-era entry)*, with inline format hint (44 chars, ends `=`).
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

Five real-life scenarios, scoped honestly: two need **new code**, three are **runbooks**
(documentation + small menu affordances). All belong to this work package.

**a) Grin node rebuild (new api/foreign secrets) — mostly already automatic.**
`07_lib_pool_wallet.sh:577` already installs the shared secret self-heal
(`grin_node_secrets.sh` timer, every 5 min): a rebuilt node's new `.foreign_api_secret` is
re-applied to the pool wallet's `node_api_secret_path` without operator action
(`grin_sync_wallets` sweeps `/opt/grin/**/grin-wallet.toml`). **The uncovered half:** a
rebuild wipes the node's own `grin-server.toml`, losing the pool's stratum wiring
(`enable_stratum_server`, `stratum_server_addr` :3334/:13334, `wallet_listener_url` → :3420).
→ **New code:** add a pool consumer to the self-heal chain per the CLAUDE.md "new consumer"
pattern — `grin_sync_pool_stratum` re-applies `pw_patch_node_toml`-equivalent keys when the
live node's toml has drifted (guarded: only when a pool install exists; node restart is NOT
automatic — the sync prints/flags it, the watchdog or operator restarts). Runbook line:
after any node rebuild, `grin-secret-sync` once + restart node + check admin health page.

**b) Provider/IP change of the HUB — make endpoints DNS-based (small helper feature).**
Today `add-peer` bakes the ipify-resolved raw IP into every pairing string; an IP change
strands every gateway (each needs `wg_hub_endpoint` edited by hand). → **New code (cheap):**
optional `wg_endpoint_host` in pool.json (set once in helper/panel, e.g. `hub.grinium.net`);
when set, pairing strings carry `host:port` instead of the raw IP. WireGuard resolves the
name at `wg-quick up` — so a provider IP change becomes: update DNS A record → each gateway
`systemctl restart wg-quick@wg-grinpool` (or the toolkit's 3) Bring up tunnel). Existing
IP-paired gateways: one-field edit in `2) Configure` (manual path already supports it).
Gateway IP changes need nothing on the hub (gateway dials out) — only the miner-facing DNS
(`stratum_url` in pool_locations) moves.

**c) Hub disaster recovery — NEW `07_lib_pool_backup.sh` on the shared engine.**
The pool hub is the ONLY money-holding product without backup today (solo has
`07_solo_backup.sh`, drop has `052_lib_backup.sh`, both on the shared `grin_backup_engine.sh`
gbe_*/gbp_* + offsite push). Same model (personal key, `grin_pubpool_backup_DDMMYYYY`,
daily cron, scp push). Backup set — everything a fresh `07` install can't regenerate:
`pool.db` (balances/shares/audit — snapshot via SQLite `.backup` or two-phase tar like 052,
never a live copy of a WAL db), `$POOL_CONF` (incl. `region_ports`), wallet dir (seed +
`.wallet_pass` + tor keys), WG identity (`$WG_DIR_CONF/server_*.key` + `/etc/wireguard/wg-grinpool*.conf`
— restoring these means **gateways reconnect with zero re-pairing**), nginx vhost + cert
note. Restore runbook: fresh box → Script 01 node (or restore alongside) → `07` hub install
→ restore backup → `grin-secret-sync` → re-point DNS (trivial if (b) is DNS-based) →
gateways reconnect on their PersistentKeepalive with no operator action on any gateway box.

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
`src/nostr/*.rs` (full detail → `script05_planning_goblin.md`, memory
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

---

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

 MENU MODEL — network-as-parent (mirrors 052 Grin Drop)
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
