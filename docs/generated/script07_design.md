# Script 07 — Public Mining Pool (Design)

> ⚠ **SUPERSEDED — multi-region (§3–4) was re-architected to Model C (2026-06).**
> The satellite/relay "node + stratum proxy + share relay per region" design described in
> §3, §4, and §11 below is **removed**. Regions are now **thin stratum gateways** (HAProxy +
> WireGuard) that forward miner stratum to ONE central node + wallet — no edge node/wallet, no
> `/api/shares` ingestion API, no `hub_shared_secret`. **Authoritative Model C design:**
> [`flowcharts/script07_mining_public_planning.txt`](../../flowcharts/script07_mining_public_planning.txt)
> and the "Multi-region — Model C" section of `.claude/CLAUDE.md`. The rest of this doc (database,
> API, reward pipeline, payments, white-label, UI) is still current.

**Product:** `scripts/07_grin_mining_public_pool.sh` + web app under `web/07_mining_pool_public/`.
**Scope:** the complete public-pool design — architecture, deployment modes, multi-region
federation, database, API, reward pipeline, payments, white-label, and UI/UX.

> **Companion docs (max-3 convention):**
> [`script07_implementation.md`](script07_implementation.md) — deploy, runbook, status, troubleshooting ·
> [`script07_security_audit.md`](script07_security_audit.md) — vulnerabilities, hardening, fixes.
> The **solo** miner (`07_grin_mining_solo.sh`) is a separate product —
> [`flowcharts/script07_mining_solo_flow_chart.txt`](../../flowcharts/script07_mining_solo_flow_chart.txt).
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
| `balance_log` | append-only ledger of every balance/locked change | forever |
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

> **Verified against `back-end-pool/index.js` (2026-06-08).** ✅ = wired in the backend ·
> ❌ = documented target, not yet built (see "Not yet implemented" below). Paths are the
> *actual* registered routes — earlier drafts of this catalog overstated the surface.

**Public — no auth (address is identity):**
```
✅ GET  /health  |  /api/health                         (alias; nginx proxies /api/*)
✅ GET  /api/pool/stats | /api/pool/stats/regions | /api/pool/blocks | /api/pool/payments
✅ GET  /api/pool/miners (by balance) | /api/miners/top | /api/pool/locations
✅ GET  /api/stratum/stats | /api/stratum/hashrate | /api/config/pool-info
✅ GET  /api/account/:addr | /:addr/balance | /:addr/balance/log | /:addr/shares | /:addr/tor-check
✅ POST /api/account/:addr/withdraw   { amount?, method? }   (Tor only; method!='tor' → 400)
✅ GET  /api/public/branding | /public/page/:key | /public/lottery/winners
✅ GET  /robots.txt | /sitemap.xml | /manifest.json     (dynamic, exact-match nginx proxies)
❌ GET/POST /api/claim/:id?token=…                      (Slatepack claim — NOT built; design §8/§12)
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
❌ POST /api/admin/withdrawals/:id/retry|cancel  ❌ GET /…/:id/events   (manual payout ops — NOT built)
❌ GET/PUT /api/admin/users[/:id]                       (admin user CRUD — NOT built; create via CLI)
❌ GET  /api/admin/payment-stats                        (reconciliation page API — NOT built)
```

### Not yet implemented (doc-vs-code, 2026-06-08)
These remain **documented targets without backend routes**; tracked so the catalog stays honest:
- **Slatepack claim** (`/api/claim/:id`) — needs a claim-token store + payment-proof-bound
  `init_send_tx`/`finalize_tx`; the Tor transport is the only wired payout rail. Design §8/§12 D-items.
- **Admin user CRUD** (`/api/admin/users[/:id]`) and **manual withdrawal ops**
  (`retry`/`cancel`/`events`) — the legacy `back-end-pool/admin-panel/users.html` UI references
  some of these; the primary admin surface (`public_html/admin-dashboard.html`) does not depend on them.
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
  `pool_fee_percent` is **1.0** (`config.js`, `pool.json.template`, `pool-settings.js`, and the bash
  installers all agree); operator-editable via the admin panel.
- **Orphan reversal** reads the *actual* credited amounts from `balance_log` and reverses those
  exact values (PPLNS-weighted, including the fee credit); never pushes a balance below 0.

---

## 8. Payments — Tor + Slatepack (one state machine, two transports)

Every Grin transaction is interactive (2-of-2). "Tor" and "Slatepack" are two **transports** for the
same slate round-trip, so there is **one** withdrawal state machine with a `method` dimension; only
"deliver the slate" branches. Balance locking, retry, reversal, ledger, and audit are shared.

| Transport | Miner does | Works if miner offline? | Pool calls |
|---|---|---|---|
| **Tor** | nothing (listener auto-signs) | no | `init_send_tx` → post over Tor → `finalize_tx` |
| **Slatepack** | copy-paste S1 → sign → paste S2 | yes | `init_send_tx` (lazy) → miner returns S2 → `finalize_tx` |
| *Relay (future)* | nothing (relay delivers async) | yes | Grin Transporter / [Script 056](script056_design.md) |

**Auto-payout** (6h scheduler, no human) can only attempt the zero-interaction method (Tor); on Tor
failure to an offline miner the withdrawal becomes **Slatepack-claimable** instead of reversing.

**Slatepack security:** the slate isn't inherently address-bound (the receiver supplies their output
in S2), so two controls are required: (1) a one-time **claim token** (anti-spam) gating the
`/claim/<id>?token=…` link; (2) **payment proof** (anti-theft) — `init_send_tx` sets
`payment_proof_recipient_address = <miner address>` and finalize is refused unless S2 carries a valid
proof signed by that address's key. Tor needs neither (listener is address-bound).

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
([Script 056](script056_design.md)).

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
