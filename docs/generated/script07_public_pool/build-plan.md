# GRINIUM — Build Plan & Bug Tracker (master)

**Updated:** 2026-06-06 — **full code verification pass complete.**
Every backend module, the frontend auth/theme JS, and `package.json` were read
and each 2026-05-16 audit bug re-checked against the current clone. Statuses
below are evidence-based (file:line cited). Design detail lives in the topic
docs ([architecture](architecture.md) · [backend](backend.md) ·
[payments](payments.md) · [infrastructure](infrastructure.md) ·
[security](security.md) · [ui-ux](ui-ux.md)).

---

## Reality check (revised after verification)

The earlier framing ("40 bugs to fix") undersells it. The truth: **the data,
auth, stratum, and monitoring layers are largely built and many original bugs
are fixed — but the entire money pipeline is not wired.** Blocks found are never
saved, rewards are never distributed, and there is no way to create a withdrawal.
So the work splits cleanly:

- **Mostly done / fixable:** stratum, share intake, wallet ECDH, auth, rate-limit
  scaffolding, settings, schema. ~12 original bugs already fixed.
- **Greenfield (build, don't fix):** block persistence → confirmation → PPLNS
  distribution → withdrawal creation → payout. This is GROUP E and it's mostly
  absent, not buggy.

**Salvage remains the right call** — the hard Grin-specific parts (stratum
protocol, Owner-API v3 ECDH) work; the missing money pipeline is well-specified
and bounded.

---

## Verified fixed since the 2026-05-16 audit (no action needed)

| ID | Was | Now (evidence) |
|---|---|---|
| BUG-01 | Bitcoin stratum | Grin `login/submit/getjobtemplate` — `stratum-protocol.js` |
| BUG-06 | `Date.parse(hash)` stale check | removed; staleness via job-window — `shares.js:20`, `stratum-server.js:317` |
| BUG-07 | jobId never increments / `server.connections` | `jobCounter`++ in `setNewJob`; sockets in a `Map` — `stratum-server.js:67,37` |
| BUG-08 | TCP fragmentation | per-socket `lineBuffer` — `stratum-server.js:94,112` |
| BUG-11 | command injection | `spawn('grin-wallet', args)` array, no shell — `wallet-tor.js:120` |
| BUG-13 | v3 without ECDH | full `init_secure_api`+secp256k1+AES-GCM — `wallet.js:69-90` |
| BUG-18 | audit-log schema mismatch | unified `(admin_id,action,target_type,target_id,details,ip)` + drop-and-recreate migration; all 3 writers aligned — `db.js:33,171`, `auth.js:248`, `pool-settings.js:234` |
| confirm_depth=10 | too shallow | now **1441/100** — `config.js:27-28` |

> BUG-14 (calls non-existent Owner `send`) is **OBSOLETE** — current code has no
> Owner-API send at all; payouts go through the `grin-wallet` CLI
> (`wallet-tor.js`). Removed from the active list.

---

## Bug catalog — confirmed OPEN (verified against current code)

Legend: ❌ confirmed present, with evidence.

### A — Money pipeline (the big gap — mostly *unbuilt*)
| ID | Status | Finding (evidence) |
|---|---|---|
| BUG-02 | ❌ | **Blocks never persisted.** `stratum-server.js:270` logs "BLOCK FOUND" but never INSERTs into `blocks`; `BlockManager.creditBlock` is not wired. `blocks` stays empty → whole reward chain has no input. |
| BUG-04 | ❌ | **`distributeRewards()` never called.** `block-monitor.js` confirms/orphans blocks but never invokes the reward distributor; no caller anywhere. |
| BUG-05 | ❌ | **`RewardDistributor.grinNode` undefined.** ctor is `constructor(config)` only (`rewards.js:4`); `index.js:173` never sets `.grinNode` → on-chain verification always skipped (`rewards.js:24`). |
| NEW-1 | ❌ | **No withdrawal-creation path.** There is no `POST /api/account/:addr/withdraw` route and no auto-payout job that inserts withdrawals. Consequence: balance is never moved to `balance_locked`, and `canInitiateWithdrawal()` (the BUG-10 limiter) is never reached. Supersedes BUG-09/BUG-10. |
| BUG-03 | ❌ | **PPLNS double-pay.** `shares` has no `paid_in_block_id`; `getSharesForDistribution` (`rewards.js:99`) selects a height window with no paid filter → overlapping blocks pay shares twice. |
| BUG-16 | ❌ | **Money in `REAL` floats** throughout `db.js:59,75,91,114,133`. Move to INTEGER nanoGRIN. |
| BUG-17 | ❌ | **Orphan reversal wrong.** `orphan-detector.js:138` reverses `block.reward/shares.length` (equal split, not PPLNS weights), ignores pool fee, no negative-balance guard. |
| NEW-3 | ❌ | **Ledger before/after columns are fake.** `rewards.js:140`, `withdrawal-scheduler.js:252` write `balance_before/after/locked_before/after = 0` → running-balance validation & reconciliation impossible. |
| BUG-12 | ❌ | **Tor send path dead.** scheduler passes `grin_address` (`grin1…`) but `wallet-tor.isTorAddress` expects `…\.onion` (`wallet-tor.js:113`) → every send throws "Invalid Tor address". Also still does a Tor port-probe (circuit-identity leak). |
| BUG-15 | ❌ | **Node Foreign API unauthenticated.** Basic Auth sent only `if (isOwner && secret)` (`grin-node.js:112`); `getTip/getHeader/getBlock/getOutputs` send none → 401 if node requires it. |

### B — Auth / security
| ID | Status | Finding (evidence) |
|---|---|---|
| BUG-19 | ❌ | **Frontend guard always passes.** `public_html/js/auth.js:119` `requireAuth()` calls async `isLoggedIn()` without `await` (Promise→truthy); and `isLoggedIn()` probes public `/api/health` (`:110`) → 200 for everyone. (The correct pattern exists unused in `getToken()`.) |
| BUG-20 | ❌ | **Spoofable client IP.** `ip-filter.js:230` and `rate-limiter.js:215` read `x-forwarded-for` first; no `app.set('trust proxy')` in `index.js` → allowlist & lockout bypass by spoofing the header. |
| BUG-21 | ❌ | **Refresh tokens replayable.** `auth.js:166` reissues without tracking/revoking the old `jti`. |
| BUG-22 | ❌ | **No account lockout.** `auth.js:60` login has no failed-attempt counter; `users` table has no lockout columns. Per-IP limit is XFF-spoofable (BUG-20). |
| BUG-23 | ❌ | **bcrypt rounds = 10** (`auth.js:237`). Use ≥ 12. |
| BUG-37 | ❌ (mitigated) | **`jwt_secret` auto-generates if missing** (`config.js:24`). A config-hash warning was added (`index.js:111`) but the secret is still minted inline → JWTs silently invalidated on restart. Install must write it; boot should error if absent. |

### C — Monitoring (alert system is effectively non-functional)
| ID | Status | Finding (evidence) |
|---|---|---|
| BUG-24 | ❌ | **Alert monitor reads fields/methods that don't exist.** `alert-monitor.js`: `status.sync_status==='Synced'` (`:118`, node returns no such field), `walletTor.checkHealth()` (`:155`, method absent), `stats.shares_accepted_1h` (`:207`, absent), `WHERE status='failed'` + `updated_at` (`:256`, status is `tor_failed`, column doesn't exist), `found_at > datetime('now',…)` vs unixepoch int (`:283`). Net: node/wallet alerts throw or fire every cycle. |
| BUG-25 | ❌ | **`alert_thresholds` not wired.** Stored as JSON in `pool_settings` (`pool-settings.js:67`) but `applyToConfig` (`:256`) never copies it to `config`; `alert-monitor.js:36` reads `config.alert_thresholds?.…` → always defaults. |
| BUG-26 | ❌ | **Alert delivery stubbed.** `alert-monitor.deliverAlert` (`:376`) only `console.log`s "Would send…"; `alert-delivery.js` exists but `index.js:219` never passes it into `AlertMonitor`. |

### D — Public data / frontend / ops
| ID | Status | Finding (evidence) |
|---|---|---|
| BUG-32 | ❌ | **Public PII leak.** `/api/pool/miners` (`index.js:560`) returns address+balance; `/api/pool/payments` (`:574`) returns full withdrawal rows — both unauthenticated. |
| BUG-33 | ❌ | **Fake dashboard metrics.** `index.js:871` `uptime_hours:730.5`, `:888` `found_7d:18`, `:1107` hardcoded latency. |
| NEW-4 | ❌ | **`/api/miners/top` throws.** Queries `shares.miner_address` + `shares.timestamp` (`index.js:1006`) — columns are `grin_address`/`created_at`. Endpoint errors. |
| NEW-5 | ❌ | **Admin withdrawal mgmt + payment-stats missing.** No `/api/admin/withdrawals/:id/retry|cancel`, no `/api/admin/payment-stats`. `requireFreshAuth` is imported but never used. The payment-stats page (payments.md) has no backend. |
| BUG-27 | ❔→❌ likely | **Unescaped `innerHTML`.** Not exhaustively re-greped this pass, but the admin/public HTML trees still build rows via string interpolation. Treat as open; centralize `escHtml`. |
| BUG-28 | ❌ | **CSP allows `unsafe-inline`** for scripts (`index.js:48`); CSP is set in Express, not nginx. |
| BUG-29 | ❌ | **SVG uploads accepted** (`asset-manager.js:14`) → stored XSS via admin logo. |
| BUG-30 | ❌ | **Uploaded assets unreachable.** `getAssetUrl` → `/custom/<f>` (`asset-manager.js:137`) but no `express.static` route registered in `index.js`. |
| BUG-31 | ❌ | **multer 1.x** (`package.json:32`, `^1.4.5-lts.1`). |
| BUG-34 | ❌ | **No HTML served by Express at all** + two HTML trees (`public_html/`, `back-end-pool/admin-panel/`, `back-end-pool/public/`). nginx must serve one; pick and wire. |
| BUG-35 | ❌ | **Theme key/value fragmentation.** `theme.js:5` key `admin-theme`, 5 themes (matrix/dark/light/naruto/japan) — **no `atomic`**, yet `index.js:55` `ALLOWED_THEMES=['dark','light','atomic']` and the disliked preview is `grinium-v1-atomic`. |
| BUG-36 | ❔ | Hardcoded prod URLs in HTML `<head>` — not re-verified this pass (HTML not fully read); treat as open. |
| BUG-38 | ❌ | **node-fetch v2** still used (`package.json:28`, `wallet.js:16`, `grin-node.js:1`). Use global fetch + AbortController. |
| BUG-39 | ❌ | **Hashrate uses fixed target.** `hashrate-tracker.js:45` feeds `session.difficulty` which is hardcoded `1.0` (`miners.js:18`) → pool hashrate is meaningless. Sum accepted-share difficulty instead. |
| BUG-40 | ❌ | **Two `MinerManager` instances.** `index.js:156` and `stratum-server.js:35` each `new MinerManager` → separate `activeSessions`. `/api/pool/stats` (index's, empty) disagrees with `/api/stratum/stats` (stratum's). |

### Other verified-new findings
| ID | Status | Finding |
|---|---|---|
| NEW-6 | ❌ | **Graceful shutdown incomplete.** `index.js:1232` SIGINT → bare `process.exit(0)`; no SIGTERM (systemd uses it), scheduler/db not stopped → WAL not cleanly flushed. |
| NEW-7 | ❌ | **Duplicate confirm logic.** `block-monitor.checkImmatureBlocks` and `orphan-detector.detectOrphans` both confirm/orphan blocks; neither triggers distribution. Consolidate. |
| NEW-8 | ❌ | **Port/config drift.** `config.js` defaults port 8080 / stratum 3333 (≠ README 3002/3416); health route reads `config.node_api_port`/`wallet_foreign_api_port` keys that don't exist → fallbacks always used. Reconcile config schema. |
| NEW-9 | ⚠ | **NodeStratumClient needs `pool_address`** or it won't log in to the node stratum → no jobs → miners get no work (`node-stratum-client.js:41`). Ensure installer sets it. |

---

## Corrected build sequence

Groups A–D largely stand; **GROUP E is now explicitly "build the money pipeline,"
not "fix bugs."** Do one group at a time with a passing gate.

**GROUP A — Data integrity** — A2 `shares.paid_in_block_id` (BUG-03) · A3 nanoGRIN
INTEGER (BUG-16) · A4 wire `alert_thresholds` into config (BUG-25) · A5
`jwt_secret` no auto-gen (BUG-37) · A6 real `balance_log` before/after (NEW-3).
*(A1/BUG-18 already done.)*
**GATE:** clean start; ledger before/after correct on a test credit.

**GROUP B — Auth + access** — B1 await frontend guard vs `/api/admin/dashboard`
(BUG-19) · B2 trust-proxy + `req.ip` (BUG-20) · B3 refresh revocation (BUG-21) ·
B4 lockout + bcrypt 12 (BUG-22/23) · B5 serve & gate one HTML tree (BUG-34).
**GATE:** dashboard 401 w/o cookie, 200 with; XFF spoof blocked.

**GROUP C — Wallet/node** — C1 fix Tor send address handling, drop probe (BUG-12)
· C2 Foreign API Basic Auth (BUG-15) · C3 drop node-fetch (BUG-38) · C4 reconcile
config/ports + `pool_address` (NEW-8/9).
**GATE:** `getBalance` correct; a test send to a real `grin1…` completes
(+ payment proof — see [payments.md](payments.md)).

**GROUP D — Mining core** — D3 hashrate from accepted-share difficulty (BUG-39) ·
D4 single `MinerManager` injected into stratum (BUG-40). *(D1/D2 already done.)*
**GATE:** real miner connects (needs `pool_address`), submits shares, sees them.

**GROUP E — Money pipeline (BUILD)** — E1 persist found blocks from stratum →
`blocks` + `BlockManager.creditBlock` (BUG-02) · E2 pass `grinNode` to rewards
(BUG-05) · E3 trigger `distributeRewards` on confirm; consolidate confirm logic
(BUG-04, NEW-7) · E4 withdrawal-creation endpoint + auto-payout job with atomic
balance lock + limits (NEW-1, BUG-09/10) · E5 correct PPLNS-weighted orphan
reversal incl. fee + neg-guard (BUG-17) · E6 admin retry/cancel + payment-stats
endpoints w/ `requireFreshAuth` (NEW-5) · E7 **Slatepack method** (claim token +
lazy slate + payment proof — see [payments.md](payments.md)).
**GATE:** testnet block end-to-end → PPLNS credit → Tor *and* Slatepack
withdrawal each complete → poisoned row → correct weighted reversal → admin
payment-stats reconciliation = 0.

**GROUP F — Monitoring + hardening** — F1 fix alert-monitor field/method/SQL
mismatches (BUG-24) · F2 inject + call alert-delivery (BUG-26) · F3 aggregate/gate
public endpoints + fix `/api/miners/top` (BUG-32, NEW-4) · F4 drop fake metrics
(BUG-33) · F5 central escHtml (BUG-27) · F6 inline handlers out / tighten CSP
(BUG-28) · F7 strip SVG + asset static route (BUG-29/30) · F8 multer v2 (BUG-31) ·
F9 theme key + value consolidation incl. `atomic` (BUG-35) · F10 templated prod
URLs (BUG-36) · F11 graceful SIGTERM shutdown (NEW-6).
**GATE:** security re-audit: zero critical findings.

---

## Validation against production pools
(`grin-pool`, `open-grin-pool`, `grin-pool-monitor`) — confirmed: address-as-
identity, Tor slate delivery, per-miner balance+fee, PPLNS. Corrections already
in code: confirm_depth 1441; orphan-by-nonce. Still to apply: exact-amount
reversal (BUG-17), no Tor probe (BUG-12), refresh revocation (BUG-21).

---

## CRITICAL pre-launch checklist (unchanged in intent; status added)

1. **Block maturity & orphan detection** — nonce check ✅ present; **persistence
   of found blocks ❌ missing (BUG-02)**; reversal math ❌ wrong (BUG-17).
2. **Balance locking & races** — ❌ no creation/locking path (NEW-1).
3. **Miner auto-create race** — ✅ `INSERT OR IGNORE` (`miners.js:68`).
4. **Wallet idempotency** — ❌ no `txid` caching; send path broken (BUG-12).
5. **Stratum worker-name validation** — ✅ `stratum-protocol.js:22`.
6. **Node API failure handling** — ⚠ partial (loops tolerate `status.ok=false`);
   no circuit breaker.
7. **Wallet stdout parsing** — ⚠ `wallet-tor` returns raw stdout; no parse/verify.
8. **confirm_depth config** — ✅ 1441/100 (`config.js`).
9. **Ledger reconciliation** — ❌ blocked by NEW-3 (fake before/after) + no job.
10. **Admin session security** — ⚠ httpOnly cookies ✅; fresh-auth helper exists
    but unused (NEW-5); lockout ❌ (BUG-22).
11. **Deployment gate** — `bash -n`, schema, node/wallet reachability, etc.

**Before mainnet:** 7-day testnet soak; Litestream backups + tested restore
([infrastructure.md](infrastructure.md)); monitoring actually firing (Group F);
operator runbook; `confirm_depth=1441`; no hardcoded secrets.

---

## Decision deltas (2026-06-06)
| Topic | Decision | Doc |
|---|---|---|
| Payments | Tor **and** Slatepack in v1 (one state machine, claim token + payment proof, lazy slate) | [payments.md](payments.md) |
| Database | SQLite now → Postgres only for HA/multi-writer; never MariaDB; satellite federation | [infrastructure.md](infrastructure.md) |
| Money | Integer nanoGRIN (BUG-16) | [architecture.md](architecture.md) |
| Stack | Express + static HTML baseline; Next.js abandoned | [00_overview.md](00_overview.md) |
| UI/UX | `grinium-v1-atomic` neon theme being replaced; see redesign | [ui-ux.md](ui-ux.md) |
