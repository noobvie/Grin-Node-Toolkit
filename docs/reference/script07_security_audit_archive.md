# Script 07 — Public Mining Pool (Security Audit) — Archive of closed findings

> **Covers code as of:** 2026-09-06 (text moved verbatim from `script07_security_audit.md`; each finding carries its own date) · **Last verified:** never systematically verified — a move is not a verification; individual findings keep their own verification dates · **Product code last changed:** 2026-10-04 (see the core file header)

Closed findings (status FIXED / CLOSED / BUILT / NOT REACHABLE) moved out of [`script07_security_audit.md`](script07_security_audit.md) so the core file keeps the roll-up and the open items. Text is verbatim; grouped by the audit section it came from. Cross-references such as "see §J4 resolution pass" point at the core file, where those passes still live. Closed findings that still carry an open half stay in the core file.

---

## C. Re-audit 2026-07-10 (fresh pass — auth + money path verified against current code)

### C1 — [Medium] `/api/pool/miners` and `/api/pool/payments` leak full raw data, unauthenticated *and* un-rate-limited — **FIXED 2026-07-28**
- **Evidence:** [index.js:1767-1779](../../web/07_mining_pool_public/back-end-pool/index.js#L1767-L1779)
  returns `grin_address, balance, is_online` for the top-500 addresses by balance (full addresses
  + exact live balances). [index.js:1781-1793](../../web/07_mining_pool_public/back-end-pool/index.js#L1781-L1793)
  runs `SELECT * FROM withdrawals … LIMIT 500` — full payout history with complete addresses,
  amounts, timestamps, and every current/future column. **Neither has `rateLimiter.middleware('public')`**
  (most other public routes do), so both are freely scrapeable.
- **Impact:** On a privacy coin this is the worst public-leak class — anyone can enumerate every
  miner's payout address, exact balance, and full payment cadence, and correlate the two lists.
- **Fixed 2026-07-28**, in the course of verifying `api-docs.html` against the live route table —
  the auto-generated reference was about to *advertise* all three of these:
  - `/api/pool/miners` — addresses now masked via the shared `maskAddr()` (`grin1qxy…mn4p`). The
    balance distribution is legitimate pool-health data and survives masking; the address→balance
    mapping, which is what made it a targeting list, does not. No front-end consumed it.
  - `/api/pool/payments` — `SELECT *` replaced with an explicit column list. Dropped `slate_id`,
    `tor_check_result`, `retry_count`, `next_retry_at`, `cancel_reason`, `cancelled_by`: pool
    payout-machinery internals that read as a per-miner reliability record and are rendered by
    nothing. `grin_address` stays FULL here on purpose — address-as-identity means the account page
    is public and keyed by it, and both consumers link the row through to `/account-settings.html`.
  - **`/api/miners/top` DELETED.** Not in the original finding, found during the same sweep and
    strictly worse: full address + `balance` + `balance_locked` + share count + online flag +
    account age, ordered by balance descending and *offset-paginated*, so a scraper could walk the
    pool's whole custodial position miner by miner. No consumer anywhere in the repo; duplicated
    `/api/pool/miners`. The legitimate leaderboards (`/api/stratum/top-miners`,
    `/api/pool/top-block-finders`) rank on contribution, not on balance.
  - `/api/pool/blocks` — `SELECT *` → explicit columns; dropped the winning `nonce` and internal
    `id`/`created_at` (the block hash already anchors a find on any chain explorer).
  - The rate-limiter half of the finding was **already stale**: both routes carry
    `rateLimiter.middleware('public')` in current code.
- **Still open (deliberate):** `/api/pool/top-block-finders` publishes full addresses. It is a
  luck leaderboard, not a balance list, and both it and `/api/pool/payments` need the full address
  for the account deep-link the pages render. Revisit only if the deep-link is dropped.

### C2 — [Low-Medium] Tor-rail withdrawal has no ownership gate → balance-lock griefing / forced payout — **FIXED 2026-07-17, see §E**
- **Evidence:** `POST /api/account/:addr/withdraw` with `method:'tor'` (the default) takes **no**
  IP-proof — any anonymous caller triggers a full-balance withdrawal for *any* address
  ([index.js:2037-2040](../../web/07_mining_pool_public/back-end-pool/index.js#L2037-L2040)). The
  design note is right that this can't *steal* (funds go to the address's own Tor listener), but:
- **Impact:** (a) A griefer can force-lock a victim's balance in a pending withdrawal; the
  one-pending-per-address cap then blocks the *real* owner from withdrawing for the full retry
  window (up to 6+12+24+48h) if the victim's Tor listener is offline. Re-triggerable → indefinite
  withdrawal denial. (b) Forces premature output consolidation / payout timing on the victim.
  No fund loss, but a cheap, unauthenticated DoS on any miner's payouts.
- **Fix:** Apply the same `verifyIpProof` throttle to the Tor rail (or a per-address re-trigger
  cooldown), and/or let the owner cancel a pending Tor withdrawal they didn't start.

## F. Payout-path throttle hardening — 2026-07-22 (add-ons, NOT VPS-tested)

### F1 — Money-write routes rode the loose `public` bucket (1200/min) — **FIXED**
The 4 money-write endpoints (`POST /api/account/:addr/withdraw`, `POST …/withdraw/:id/finalize`,
`POST` + `DELETE …/nostr-destination`) now use a **dedicated `withdraw` rate bucket**
(`lib/rate-limiter.js`, default **20/min per-IP**, overridable via `config.rate_limits.withdraw`)
instead of `public`. `tor-check` and every read/stats/admin route stay on their existing buckets —
no other limit value changed. A real payout is ~2 requests (create → finalize), so 20/min leaves
ample headroom for a small NAT'd farm while cutting automation. This bucket is the coarse DoS pad
in front of the memory-hard scrypt verify.

### F2 — Ownership-proof throttle was per-ADDRESS only → distributed sweep + scrypt CPU lever — **FIXED**
`lib/owner-proof.js` `verifyOwnerProof` threw a per-address counter only (`FAIL_MAX=8`/10min),
so an attacker walking the public leaderboard got a **fresh 8-guess budget per address**, and each
guess forced a 16 MB scrypt (a CPU/mem-exhaustion lever). Added a **second, per-IP counter** in the
same `_fails` Map (keyed `ip:<canonicalIp>`), `FAIL_MAX_IP=20`/10min, same 5-min lockout — it caps
*total* failed guesses from one source across ALL addresses. Signature is now
`verifyOwnerProof(db, addr, submitted, clientIp?)`; the 4th arg is **optional** (omitting it =
old address-only behaviour, backward compatible) and all 4 index.js callsites pass `reqIp`.
A single-address user hits the address lock (8) **before** the IP lock (20), so no new
false-positive for normal use; only the distributed-sweep attacker trips the IP lock.

**Verified:** `node --check` on index.js + both libs; a 5-case stub-DB test (distributed sweep
locks at the 21st attempt, a different IP is unaffected, a solo user locks at the 9th, a correct
password verifies, the no-IP path still works) — all pass. NOT yet VPS-tested.

**Deferred (YAGNI, do NOT build unless a real need appears):** an *off-by-default* operator
captcha toggle (reuse the existing login-captcha infra at `/api/auth/captcha`) or a hashcash PoW
challenge before withdraw. Both were considered and intentionally not built — the F1/F2 throttles
plus the theft-proof rails are the proportionate control.

---

## G. IP handling review — 2026-07-25 (add-ons, NOT VPS-tested)

### G1 — [Medium] Audit trail re-created the (address, IP, time) linkage that proof-hashing removed — **FIXED**

`auditOwnerProof()` wrote `canonicalizeIp(req.ip)` **in full**, next to `target_id = <grin_address>`,
on every withdrawal / slatepack / cancel / destination-register attempt — and `admin_audit_log` had
**no retention policy at all**, so it accumulated indefinitely. This reconstructed exactly the linkage
the 2026-07-17 scrypt hashing of `last_ip`/`prev_ip` was introduced to eliminate, defeating the
"the DB holds no raw mining IPs" property in `owner-proof.js`.

**Fix — coarsen, don't hash.** Hashing the audit IP would destroy the log's operational purpose
(incident response needs "group these events by origin"; a per-row salted hash makes every row
unlinkable, and a *shared* salt is just a reversible 2³² lookup for IPv4 — the same weakness as G2).
So new `coarsenIp()` keeps the routing prefix and drops the host part:

- **IPv4 → `/24`** (`203.0.113.47` → `203.0.113.0/24`)
- **IPv6 → `/48`** (`2001:db8:1234:5678::1` → `2001:db8:1234::/48`) — the standard end-site
  allocation; a `/64` is often one subscriber and identifies a household about as well as the
  full address.

Abuse patterns (a sweep from one block, a farm fumbling proofs) stay visible; pinning an event to a
single subscriber line does not. Non-IP input returns `null` (stored NULL, never opaque junk).

- **Admin rows are deliberately untouched** (`admin_id NOT NULL`) — the operator's own login origin
  is operator data, and full precision is what makes it useful.
- The one admin-initiated caller (`admin_verify`) *is* coarsened; its actor is already identified by
  `details.by`, so no attribution is lost.
- **The throttle is unaffected** — `verifyOwnerProof`'s per-IP lockout keys on the full in-memory IP,
  so coarsening never widens a lockout to a whole `/24`.
- `migrateAuditLogIps(db)` rewrites historical miner rows in place at startup (synchronous —
  truncation, no KDF; idempotent, `ip NOT LIKE '%/%'`).

**Retention:** new `database.audit_log_keep_days` (default **180**, runtime floor **30**) pruned by
`retention.js` step 4, surfaced in `status().counts.admin_audit_log` and the settings-database panel.
Floor of 30 so a mis-set value can never leave the money path untraceable.

### G3 — [Low] Network-map feeds published a country breakdown by default — **FIXED 2026-07-25**

Follow-up to G2, raised by the operator: *"/api/network/peers should be disabled — I don't want peer
IPs public."*

**First, the factual correction:** neither network-map feed has ever returned an IP address.
`/api/network/peers` returns `GROUP BY country_code` counts; `/api/pool/topology` returns gateway
status plus miners-per-country. Every `lat`/`lng` in either response comes from
`geoip.placeInCountry()`, which is a *seeded random point inside the country* — a dot is never a real
location. `peer_key` and `miner_accounts.last_ip` never appear in any response. Confirmed by reading
both handlers end to end.

**What was genuinely exposed** is the aggregation itself: which countries mine at this pool and which
countries the node peers with, unauthenticated and on by default. That is low-sensitivity at scale
and progressively worse as the pool gets smaller — the G2 minimum-bucket problem, now reachable.

**Fixed, two layers:**

1. **`access.network_map_public`, default `'false'`** — both `/api/pool/topology` and
   `/api/network/peers` return **404** when off. 404 rather than 403: a 403 confirms the feature
   exists and is merely disabled. Gating only the peers feed would have been half a fix — topology
   publishes the same class of data for miners. `networkMapPublic()` fails **closed** if settings are
   unreadable. `network-map.js` already wraps both fetches in `try/catch` and renders its illustrative
   sample globe on failure, so the page degrades instead of breaking.
2. **`access.network_map_min_bucket`, default `3`** — when publishing *is* enabled, countries below
   the floor are merged into one unnamed `Other` row (no `country_code`, `lat`/`lng` null) rather than
   dropped, so totals stay truthful while thin countries go unnamed. Closes the G2 open item.

> **Defaults changed 2026-09-13** (operator decision, add-ons branch, not VPS-tested):
> `network_map_public` now defaults **`'true'`** and `network_map_min_bucket` **`1`** (no floor).
> Rationale: the map is a nav/sitemap headline page, and closed-by-default + floor 3 meant a new
> pool's own country never lit up — read as "broken" rather than "private". The gate, the 404
> semantics and the floor mechanics are unchanged; the operator switches them back on in
> admin → Access. Note `getSection()` layers stored rows over defaults, so an existing install that
> never saved the Access form also flips on at upgrade. In the same change the **sample globe was
> REMOVED** from `network-map.js` — an unreachable feed now renders a bare globe, zeroed placards and
> a "not published" note. The sample topology had been mistaken for real data twice (2026-07-26,
> 2026-09-13), which makes it a misinformation surface, not a degradation aid. The same-day
> review of that change added **`geo_available`** to `/api/network/peers` (the flag the admin
> owner-evidence endpoint already carried): without `geoip-lite` the peer collector is a permanent
> no-op, so an empty peer layer must read "install the optional package", never "wait 30 s". The
> page now words the peer-layer note by cause — feed off (one sentence shared with topology),
> geo off, or genuinely not collected yet — and says nothing when both feeds are populated.

The floor is applied to `network_peers` **before the twinkle `points` array is built**, not only to
the country list — points are placed at their country's position, so emitting them for a thin country
would re-expose precisely what the floor hides. Client-side this is already safe: `network-map.js`
filters `c.lat != null` before rendering, and its country-highlight set matches on canonical
Natural-Earth names, which `Other` never matches.

**Related, NOT fixed here — resolved later:** `/api/pool/miners` (§C1) returned every miner's
**full** Grin address and balance unauthenticated. No IP — but a bigger identity leak than the map
ever was, and it contradicted the posture `/api/stratum/stats` already applies (that route truncates
addresses to `xxxxxxxxx…xxxx` specifically so the session list can't be scraped into a miner
census). **Closed 2026-07-28** — that same truncation is now applied to `/api/pool/miners`; see §C1.

### G4 — Payout request audit surfaced in the admin panel — **BUILT 2026-07-25**

The G1 rows existed but had no reader: the only views over `admin_audit_log` were
`/api/admin/audit-log` (undifferentiated firehose) and `login-history` (admin actions only), so
answering *"is someone hammering the payout button?"* meant reading nginx logs. Added
**`GET /api/admin/payments/audit`** (`secureAdmin`) plus a **Payout request audit** section on
`admin-panel/payments.html`.

Covers the ownership-gated money surface on **both** the accept and deny path — `withdraw_tor`,
`withdraw_slatepack`, `withdraw_nostr`, `slatepack_finalize`, `nostr_destination_register|remove` —
selected by a `LIKE` over the action prefix so it tracks `owner-proof.js` without duplicating its
action list. Admin rows (`admin_id NOT NULL`) and non-money `owner_proof:admin_verify` rows are
excluded. Params: `days` (1–3650), `result` (`all|deny|ok`), `limit`/`offset`.

**Country capture.** `auditOwnerProof()` now resolves the origin country from the **full** IP —
the one point where it still exists — and stores the ISO code in `details.geo`. It goes in the
details JSON, **not a new column**: `db.js migrateAdminAuditLog()` DROPS the table whenever its
columns don't match the canonical set, so adding a column would delete every existing audit row on
the next deploy. Wrapped in its own try/catch (geo is a nice-to-have; it must never fail an audit
write) and resolves to null on private/loopback addresses or when `geoip-lite` isn't installed —
the response carries `geo_available` so the UI can say which case it is.

**Retention interaction is reported, not hidden.** The window is clamped to
`database.audit_log_keep_days`; the response returns `requested_days`, `window_days`,
`retention_days` and `truncated_by_retention` so asking for 1 year under 180-day retention shows
"showing 180d — retention keeps only 180d" instead of an empty stretch that reads as "nobody tried".

**`top_denied_origins`** groups refusals by origin prefix over the whole window in SQL (not over the
returned page, so paging can't hide a burst), reporting `denials` and **`addresses`** — distinct
targets. That second number is the actual signal: many denials against *one* address is a miner
mistyping their own password; many denials across *many* addresses from one prefix is an
address-sweep. The banner escalates to error styling only on the latter.

The panel notes explicitly that rate-limiter rejections (§F1/F2) are refused **before** the ownership
check and leave no row, so a quiet table is not proof that nothing was attempted.

> Origin stays the coarsened `/24`//`48` from G1 — sufficient here, since repeated attempts from one
> origin still group. This view does not reintroduce host-level IP storage.

## H. Payout double-pay hardening + probe oracle — 2026-08-01 (add-ons, NOT VPS-tested)

### H1 — [Critical] Tor retry re-sent without checking whether the first send landed — **FIXED**

`sendToTorAddress` shells out to `grin-wallet send` with a `wallet_send_timeout_ms` ceiling
(120 s default) and then `SIGKILL`s it. A kill at 120 s does **not** mean the tx failed to post:
the Tor round-trip, finalize and broadcast can all have completed while the CLI still held the
pipe. The scheduler saw `success:false`, scheduled a retry, and hours later sent the same amount
again. Both land; the miner is paid twice; the ledger debits once. Unrecoverable.

The E.2 reversal cooldown never covered this — it gates a miner starting a *new* withdrawal after
a refund, whereas a retry is the same row re-entering `sendWithdrawal` without passing that check.

**Fix — `_priorSendLanded()`**, consulted at the top of `sendWithdrawal` but only on a re-attempt
(`retry_count > 0` or a `slate_id` already captured), so the first attempt costs no extra wallet
round-trip. A hit confirms the row instead of re-sending. Matching is deliberately narrow, because
a false *positive* marks a miner paid who was not:

- exact `slate_id` when one exists (authoritative — no amount heuristics);
- otherwise a `TxSent` whose net-to-recipient equals this payout's net, created no earlier than
  the withdrawal row, **and whose slate_id is not already claimed by a different withdrawal** —
  so two miners withdrawing the same amount can never collide;
- `TxSentCancelled` excluded (never reached the chain). Note this is stricter than
  `_captureTorSlateId`'s `/Sent/` regex, which matches the cancelled form — that one only
  decorates a proof link, this one decides whether to spend.

When the wallet cannot be read at all it returns `checked:false` and the retry proceeds with a
loud error naming itself. Fail-open is deliberate: refusing to retry would strand live payouts
whenever the Owner API blips, a worse trade than a logged unknown.

### H2 — [Critical] Finalize and the TTL sweep could both settle one row — **FIXED**

`finalizeSlatepackWithdrawal` and `finalizeNostrWithdrawal` read the row, checked
`status === 'slatepack_pending'`, then awaited three wallet calls before writing anything back.
Nothing claimed the row in between, while `processSlatepackExpiry` selected on that same status
and `cancelWithdrawal` could fire at any moment. Node yields at each await, so the scheduler
loop runs inside the gap:

> finalize reads row (pending, ok) → await yields → expiry reverses the lock (**miner refunded**)
> → finalize resumes → `postTx` broadcasts (**miner also paid on-chain**).

Only two of seven status writes in the scheduler were guarded with `AND status = ?`.
`_creditConfirm`, `_reverseLock`, `markConfirmed` and `markFailed` all wrote `WHERE id = ?`
unconditionally. The failure was also **quiet**: the clamp in `_releaseLockAndDebit` keeps the
ledger internally consistent with the wrong outcome, so `integrity_drift` does not fire — only
the coverage invariant catches it, after the coins are gone.

Most likely trigger was **not** the TTL but an **admin cancel** — an operator cancelling a payout
that looks stuck at exactly the moment the miner's wallet finally answers.

**Fix — a `finalizing` claim, plus three things it needs to be safe:**

1. `_claimForFinalize()` runs `SET status='finalizing' WHERE id=? AND status='slatepack_pending'`
   before the first await; both finalize methods bail unless they win. `finalizing` is inside
   `PENDING_SQL` (still holds the one-pending slot, still counted in-flight) but is matched by
   neither the expiry sweep nor `cancelWithdrawal` — an admin cancel on a claimed row now 409s.
2. **Every settlement write is now a CAS inside one transaction.** `_creditConfirm` and
   `_reverseLock` guard on the expected `fromStatus` and run the status flip *and* the balance
   move together, so confirm and reverse compete for the row and the loser moves no money.
   `markConfirmed`/`markFailed` were rewritten to delegate rather than hand-roll the same three
   statements again. (This also closed the separate finding that those paths were non-transactional
   — it was a requirement of the guard, not an extra.)
3. `reclaimStaleFinalizing()` resolves an abandoned claim (>10 min, i.e. a process restart
   mid-finalize) **from the wallet tx log, never by guessing**: slate present → confirm; slate
   absent → back to `slatepack_pending`; wallet unreachable → leave it and re-ask next tick. It
   runs even while payouts are frozen, since it only records what the chain already decided. A
   guard that can strand a balance is not an improvement.
4. A throw from `postTx` is treated as **ambiguous, not failed** — the row stays claimed for the
   sweep. Releasing the claim there would have rebuilt the same bug one layer down.

> **Trap for future changes:** `markFailed` is reached with the row in `tor_sending`, not the
> `retry_scheduled` its old event row claimed. A guard hard-coded to `retry_scheduled` silently
> strands every exhausted-retry balance; it now reads the live status.

> **Trap #2 — age the CLAIM, not the row** (caught in self-review, after the first implementation
> shipped it wrong). `reclaimStaleFinalizing` originally aged rows by
> `COALESCE(confirmed_at, created_at)`. For a claimed row `confirmed_at` is NULL, so it fell back
> to `withdrawals.created_at` — **when the payout was requested**, which for a slatepack row is up
> to 24 h before the miner responds. Every fresh claim therefore looked instantly stale, so the
> sweep would race a live finalize, release its claim, and hand the row back to the expiry sweep:
> the exact double-pay the claim exists to prevent, re-introduced by its own recovery path, worst
> on the rail with the longest TTL. The claim's age now comes from the `to_status='finalizing'`
> event `_claimForFinalize` writes (indexed by `withdrawal_id, created_at`), and that event is
> written in the SAME transaction as the status flip — a claim without its timestamp would look
> infinitely old. Regression test: a fresh claim on a 24 h-old withdrawal must not be reclaimed,
> and the sweep must not even consult the wallet for it.

> **`finalizing` had to be added to every other in-flight status list** or the fix causes its own
> incident. The sharp one is AlertMonitor's `inFlight`: a row missing there reads as an
> unexplained wallet drain and **auto-freezes the pool**. Also updated: reconciliation's pending
> sum and payout-matching window, the account-summary pending display, the admin payments view,
> and the account page's status label ("settling"). No migration — `status` is plain TEXT with no
> CHECK constraint.

### H3 — [Medium] `tor-check` was a public wallet-uptime oracle for any Grin address — **FIXED**

`GET /api/account/:addr/tor-check` rode the loose `public` bucket (1200/min) with no ownership
gate and **no check that the address had ever mined here**. `probeToronlineStatus` derives the
onion from the bech32 address by pure math, so it answered *"is this wallet listener up right
now?"* for **any** Grin address — an activity side-channel on people who never opted into this
pool. Reachable without API knowledge: the account page probes whatever address is typed into it.
Secondarily an amplification lever — one cheap HTTP request became a Tor circuit build plus up to
`torCheckRetries` SOCKS connects.

**Deliberately NOT fixed with an ownership proof.** The probe runs *before* the miner has typed
anything and its job is to tell them which rail to pick, so gating it removes the hint exactly
when it is useful — and a proof would not stop amplification anyway, since a miner holding a valid
proof can still hammer it. Three changes instead:

> **Superseded 2026-09-23 (payout-rails fix, impl §10.5):** the probe no longer runs on page load.
> It runs only when the miner presses *Check Tor wallet*, which sends `?fresh=1`. That re-probes
> once the cached answer is 10 s old; younger answers come from the cache. Each probe is now a
> `check_version` POST over a fresh circuit per attempt, with an 8 s timeout, so it takes up to
> ~32 s. The three changes below are all still in place. The reasoning above ("runs before the
> miner has typed anything") describes the page as it was.

- **Account-existence check** → 404 for an address that never mined here. This is the one that
  matters; it closes the arbitrary-address oracle at no UX cost. Same 404 shape as
  `GET /api/account/:addr`, so it reveals nothing that endpoint doesn't. Residual signal for
  miners who *are* here is small — the pool already publishes their hashrate, which tracks
  activity far more closely than listener uptime.
- **60 s per-address response cache + in-flight dedup.** The cache alone would not have fixed
  click-spam: rapid clicks arrive *before* the first probe resolves, all miss an empty cache and
  each builds its own circuit. The in-flight map collapses them onto one promise, cleaned in a
  `finally` — without that, a probe that throws (tor daemon down) parks a rejected promise under
  that address and every later request is handed the same failure forever. Bounded at 500 entries,
  expired-first eviction, so an address sweep cannot grow it without limit.
- **Dedicated `torcheck: 10/min` bucket** (not `public`, and deliberately not shared with
  `export` — a miner's CSV download would otherwise eat their probe budget). With the cache
  handling repeats, this number is really about **enumeration**: how many *distinct* addresses one
  IP can probe per minute. At 1200 you could walk the leaderboard sampling every miner's wallet
  uptime in seconds; at 10 you cannot.

> The withdraw pre-flight gate still probes **fresh** — it is a money decision that can refuse a
> payout, so a 60 s-stale "offline" must never block a listener the miner just started. Caching a
> UI hint and caching a gate are different calls.

> **Footgun:** `rateLimiter.middleware()` does `if (!limit) return next()` — an unrecognised bucket
> name **silently disables rate limiting** rather than erroring. The name in the route and the key
> in `this.limits` must match exactly.

### H4 — [Low/UX] Status-list and status-label drift found while reviewing H1–H3 — **FIXED**

Adding a status surfaced how many hand-written status lists had already drifted as the slatepack
and Goblin rails landed. All pre-existing; all one-liners.

- **`getStatus()`** counted pending as `('tor_checking','tor_sending','retry_scheduled')` — it
  predates both newer rails, so the admin scheduler view's "pending" count had been silently
  excluding **every** slatepack and Goblin payout in flight. Now uses `PENDING_SQL`, the constant
  that exists precisely for this. (Note: a grep for lists *containing* `slatepack_pending` does
  not find this one — it never had it. Search by `tor_checking` instead.)
- **`payments.html` `STATUS` map** had no entry for any slatepack/Goblin state, so those rows fell
  through to `['badge-dim', <raw status>]` — an in-flight payout showing "slatepack_pending" in
  the same grey the panel uses for CANCELLED. All five now labelled with correct severity colours.
- **`payments.html` `ACTIVE`** (the "active" filter chip) omitted `slatepack_pending`, so filtering
  to active hid exactly the payouts an operator would be filtering for.
- **`payout-methods.js` `BASE_STATUS`** had an `expired` key, but the TTL sweep writes
  `slatepack_expired` — the key never matched anything and those rows rendered the raw token on
  the public account page. Relabelled *"expired — balance returned"*, which is the part the miner
  actually needs to know.

`canInitiateWithdrawal()`'s two stale lists are deliberately left — it is dead code and listed
under "still open" below; fixing its lists would make it look maintained.

### H5 — [High] The LAST rung of the Tor retry ladder refunded without asking the wallet — **FIXED 2026-09-13** (add-ons, NOT VPS-tested)

**Found** while answering the question "can a miner keep the wallet online for the pre-flight,
then pull it offline once the send starts, and get paid twice?" The literal version of that
attack is harmless — a Grin tx needs the recipient's signature, so a wallet that goes dark before
the slate round-trip completes produces no transaction at all and the eventual refund is correct.
The mirror image is not: the wallet **answers**, the pool finalises and **broadcasts**, and the
CLI still reports failure (SIGKILLed at `wallet_send_timeout_ms` after the post — §H1's scenario).

§H1's guard (`_priorSendLanded`) runs **before each re-attempt**, so it covered attempts 0..N-1 of
the ladder. It never covered attempt N: `sendWithdrawal` → send "fails" → `scheduleRetry` sees
`retry_count >= retryDelays.length` → `markFailed()` → `_reverseLock()` with no question asked.
Under §H1 this was a timing accident; under an adversary it is a recipe — the ladder is
deterministic (6 h / 12 h / 24 h / 48 h) and the retry count is on the account page, so a wallet
that stays dark for attempts 0..3 and then answers attempt 4 slowly enough to straddle the 120 s
timeout keeps the coins **and** gets the balance back. Reconciliation's coverage invariant would
have flagged the shortfall afterwards (detection), but nothing prevented it.

**Fix** (`lib/withdrawal-scheduler.js` `markFailed`): the final rung now makes the same three-way
decision a re-attempt does, against the wallet's own tx log —
`confirmed` → settle via `markConfirmed` (slate attached as proof, never refund);
`unconfirmed` → `_deferSend` (balance stays locked, re-ask in 15 min, no rung consumed);
`absent`/`TxSentCancelled` → `_reverseLock` as before — the **only** branch that refunds.
One deliberate asymmetry with `sendWithdrawal`: a wallet that **cannot be read** is parked, not
proceeded past. In `sendWithdrawal` proceeding keeps live money moving through a brief outage; in
`markFailed` the only thing proceeding does is refund, and a refund on top of a landed send is the
one outcome that cannot be undone. `_deferSend` gained an optional `why` so the event note says
"could not be read" rather than "holds an unconfirmed send" in that case.

**Tests** — `scripts/test-payout-guard.js` §5 drives the real path (row on its last rung, a stub
send that returns failure but leaves a `TxSent` in the wallet log): confirmed → settled, paid
once, slate attached; unconfirmed → parked, locked, `retry_count` unchanged; absent → refunded
with the reversal in `balance_log` (control); unreadable → parked with the honest note. Run
against the pre-fix scheduler the first three cases fail with `{"balance":100,"balance_locked":0}`
beside a confirmed on-chain send — i.e. the double payment, reproduced. 52/52 after the fix; the
full `npm run test:unit` suite stays green.

**Not changed:** the admin `POST /api/admin/withdrawals/:id/retry` route (re-locks a `tor_failed`
row and re-enters the ladder with the guard armed off the event log — §J4-2) and
`reclaimStaleTorSending`, both of which already consult the log before moving money.

**Same-day review found the wait was one cycle long.** A deferred row comes back through
`sendWithdrawal` 15 min later, and that path's unreadable-wallet policy is *proceed loudly* — so a
last-rung row parked because the log could not be read would, if the wallet was **still** dark,
be sent **blind** on pickup: the double payment this section closes, reached by the door it
opened. The same gap already existed for an ordinary-rung deferral (an unconfirmed send was
*seen*, then the wallet went dark → blind send). Fixed in `sendWithdrawal`: when the log cannot
be read and the row carries any `deferred:%` event, it is re-parked via `_deferSend` (note
"could not be read after an earlier deferral"); only a row that has **never** been deferred keeps
proceed-loudly. A deferral is a standing statement that the outcome is unknown, and an unreadable
wallet cannot dissolve it. Second review item: the last-rung `confirmed` branch now calls
`recordTorFee` before `markConfirmed`, as `sendWithdrawal`'s recovered branch does, so
reconciliation can explain the fee gap. Tests §5 +6 (re-park on both rungs, plus the
never-deferred control); 67/67. Also: this section and the next were first numbered H3/H4,
colliding with the 2026-08-01 H3/H4 above — renumbered H5/H6 the same day.

### H6 — Signed payment proofs as dispute evidence — **BUILT 2026-09-13** (add-ons, NOT VPS-tested), with its threat model

**Why.** The account page's kernel link (§J11-2) proves a payout transaction was *mined*. It does
not prove *who received it*: a Grin kernel carries no addresses, so a pool could point at any
kernel and write a miner's address beside it, and the explorer would truthfully confirm the
kernel exists. Against a miner who says "I never received it" in front of a third party that is
a tie. grin-wallet's `PaymentProof` breaks it: `{amount, excess, recipient_address,
recipient_sig, sender_address, sender_sig}` where `recipient_sig` is the recipient key's ed25519
signature over `amount ‖ excess ‖ sender_address` — and the recipient key *is* the miner's
`grin1…` address. Anyone can verify it with `grin-wallet verify_proof` (layout confirmed against
upstream's CI-asserted test vector, memory `project_payment_proof_fixture`). The Tor CLI rail
already had one for every payout — `grin-wallet send -d <slatepack addr>` requests a proof by
default (only `--no_payment_proof` disables it, v5.4.1 CLI spec) — it was simply never fetched.

**What was built.**
- `withdrawals.payment_proof TEXT` (additive migration; `NULL` = not fetched, `''` = the wallet
  holds none, terminal). `lib/wallet.js retrievePaymentProof(slateId)` → Owner API
  `retrieve_payment_proof`, local tx-log read.
- `withdrawal-scheduler.fetchAndStorePaymentProof(id)` + `backfillPaymentProofs()` on the
  scheduler tick (after the kernel backfill; read-only, runs while frozen). Asks only for rows
  that are `confirmed` **and already have a kernel** (the wallet refuses proofs for unconfirmed
  txs), Tor rail only, newest 20 per tick, ≥60 s apart.
- **Miner:** `POST /api/account/:addr/withdrawals/proofs` (the existing ownership-gated reveal)
  now also returns `payment_proofs: { id: PaymentProof }` (newest 500). One press of *Reveal
  proofs* gives every mined payout its `proof ↗` kernel link and every Tor payout a `⬇ file`
  that saves `payout-<id>-proof.json` — byte-compatible with `export_proof`, built client-side
  from a Blob. The list GET carries `has_payment_proof` (boolean) only.
- **Operator:** `GET /api/admin/withdrawals/:id/payment-proof` (`secureAdmin`) serves the stored
  proof or fetches it from the wallet once; 🧾 on the admin payments page downloads it.
  `/api/admin/withdrawals` strips the blob to `has_payment_proof`.

**Threat model — what this surface does and does not add.**
1. *Misattribution (the real risk).* A proof is served as "your wallet signed for this", so a
   wrong one is worse than none — §J4-11's failure class (a stranger's `slate_id` on the row)
   would hand a miner someone else's receipt. **Guard:** the proof's `excess` must equal the
   row's `kernel_excess` or nothing is stored (`kernel_mismatch`, logged). Test §6 covers it.
2. *Privacy / leakage.* The proof names the miner's address **and** the kernel in one signed
   document — at least as linking as the kernel, so it gets the identical §J11-2 treatment: the
   per-address GET may only drop it or coerce it to a boolean (leakage test asserts the mention
   count exactly as it does for `kernel_excess`); the value travels only on the ownership-gated
   POST on the `withdraw` bucket. Nothing new is published.
3. *Sender-address disclosure.* The proof carries the pool wallet's own slatepack address. To the
   miner this is **not new information** — it was in the slate their wallet signed, and their
   wallet's tx log holds it. To the admin it is theirs. No public route emits it.
4. *Wallet-load lever.* The miner route **never touches the wallet** (DB only; leakage test asserts
   no `wallet.`/`withdrawalScheduler.` in the handler) — an address with 500 payouts costs one
   SELECT. The admin route may make one local tx-log read per call, behind admin auth; the id is
   the only input and the slate comes from **our row**, so it cannot look up arbitrary wallet txs.
5. *Forgery / tamper.* The server never accepts a proof from a client — it only serves what the
   wallet returned. A proof altered by anyone (pool included) fails signature verification, which
   is the property that makes it evidence. A proof is only as strong as its verification: the
   miner-facing copy says to run `verify_proof` and to compare the kernel with `grin-wallet txs`.
6. *Front-end.* Text-only DOM for every proof field; the download is a same-page Blob (no URL to
   land in a log). Demo mode is unaffected (no `payment_proofs` in the fixture → no button).

**Deliberately not done:** enabling proofs on the Owner-API slatepack/nostr rail
(`payment_proof_recipient_address: null` in `initSendTx`). It changes the slate every recipient
wallet must sign and is a money-path change; those payouts keep `''` and the UI says so. And no
new bucket, no new secret, no new public route.

**Tests:** `test-payout-guard.js` §6 (store on kernel match; refuse on mismatch; `''` for non-Tor
and for the wallet's definitive "no proof"; `NULL` on transient error; `''` terminal; backfill
selects exactly the eligible row) and `test-public-leakage.js` §H6 (7 assertions). Migration
checked by building a DB with HEAD's `db.js` and opening it with the new one. Full suite green.

**VPS still owes:** one real `retrieve_payment_proof` round-trip (field names/`amount` type as
returned by v5.4.1 over Owner v3), and one `verify_proof` of a downloaded file.

## I. Re-audit 2026-08-21 (pre-retest pass — backend, frontend, payment path)

### I1 — [High] The generated nginx vhost drops **every** security header on the two locations that serve HTML — **FIXED 2026-08-21 (see §I resolution pass)**

`add_header` in nginx is not additive across levels: these directives are inherited from
the previous configuration level **if and only if** there are no `add_header` directives
defined on the current level. The vhost sets four headers at server level
([07_grin_mining_public_pool.sh:1153-1160](../../scripts/07_grin_mining_public_pool.sh#L1153-L1160)) —
`X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy`, and the full CSP.

Two locations then declare an `add_header` of their own, purely for cache control, and in
doing so discard all four:

| Location | Own `add_header` | Serves | Result |
|---|---|---|---|
| [`location /admin/`:1186](../../scripts/07_grin_mining_public_pool.sh#L1186) | `Cache-Control "no-cache"` | the whole admin panel (HTML/JS/CSS, `try_files` from disk) | **no CSP, no XFO, no nosniff, no Referrer-Policy** |
| [`location /`:1331](../../scripts/07_grin_mining_public_pool.sh#L1331) | `Cache-Control "no-cache"` | every public page — index, login, account-settings, miners-stats, blocks, donate, payment-history — and all CSS/JS | **same** |

The locations that *do* keep the headers are the proxied `/api/…` ones, i.e. the JSON
endpoints where a CSP does the least. The two surfaces a browser actually renders have
none. Concretely: the admin panel is framable (clickjacking against `secureAdmin` actions —
ads, pages, posts, settings reads), and the CSP that is supposed to contain any XSS on the
account/payout pages is absent. Express's own header middleware
([index.js:243-250](../../web/07_mining_pool_public/back-end-pool/index.js#L243-L250))
does not cover this — those files are served by nginx off disk, never proxied.

This is the exact trap already documented for Script 052 in CLAUDE.md, live in 07.

**Fix:** move the four headers into a snippet and `include` it in *every* block that adds
a header of its own (`/admin/`, `/`), or drop the `Cache-Control` `add_header` in favour
of `expires -1;` / a `map`-driven variable that does not reset inheritance.

### I2 — [Medium] No HSTS anywhere in the nginx vhost — **FIXED 2026-08-21 (see §I resolution pass)**

`grep add_header` over the generated config returns no `Strict-Transport-Security`. The
Express app sets it, but only on responses it generates (`/api/…`, `/blog/<slug>`) — the
HTML page load itself never carries it, so a first-visit downgrade is not protected even
though `:80` redirects. Add it to the shared snippet from I1.

### I3 — [Medium] The block-reward "verify against the chain before crediting" control is dead code — **FIXED 2026-08-21 (see §I resolution pass)**

[rewards.js:26-47](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L26-L47)
guards its blockchain re-verification with `if (this.grinNode)` and comments it
`FIX #1, #5: CRITICAL — Prevents fake blocks from being credited if block_monitor is
compromised`. But `RewardDistributor`'s constructor
([rewards.js:5-11](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L5-L11))
never assigns `this.grinNode`, and the only construction site passes one argument:
`new RewardDistributor(config)` ([index.js:473](../../web/07_mining_pool_public/back-end-pool/index.js#L473)).

`this.grinNode` is therefore permanently `undefined`. Every distribution takes the `else`
branch and logs `[WARNING] Grin node not available - skipping blockchain verification`.
The height+hash re-check has never run.

**Impact is bounded, not zero.** Blocks only reach `status='confirmed'` through
`OrphanDetector.verifyBlockOnChain()`, which does check the chain — by **nonce**, not hash
([orphan-detector.js:12-36](../../web/07_mining_pool_public/back-end-pool/lib/orphan-detector.js#L12-L36)).
So the primary gate exists; what is missing is the independent second check at the moment
money is credited, plus the stronger hash comparison. The operational tell is that the
`[WARNING]` line will print on **every** payout during the re-test — if you see it, this is
why, and it is not a node connectivity problem.

**Fix:** `BlockMonitor` already owns a `GrinNodeAPI` ([block-monitor.js:9](../../web/07_mining_pool_public/back-end-pool/lib/block-monitor.js#L9)).
Pass it in — `new RewardDistributor(config, blockMonitor.grinNode)` — and store it.

### I4 — [Medium-High] Reward distribution is not atomic with the `confirmed → paid` flip → double-credit on a crash — **FIXED 2026-08-21 (see §I resolution pass)**

[rewards.js:80-82](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L80-L82):

```js
const distributionResult = this.creditBalances(...);   // commits its own transaction(s)
this.db.prepare("UPDATE blocks SET status = 'paid' WHERE id = ?").run(blockId);
```

`creditBalances` runs **three** separate units of work — the miner-credit `transaction()`
([:139-160](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L139-L160)), then
the pool-fee credit **outside any transaction**
([:162-182](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L162-L182)), then
`incentiveTx()` — and the status flip is a fourth, in the caller.

If the process dies (or the box reboots, or systemd restarts the unit) after the miner
credits commit but before the status flip, the block is still `status='confirmed'`.
`BlockMonitor.distributeConfirmedBlocks()` re-selects exactly that row on the next 30 s tick
and **credits every miner a second time**. Nothing prevents it: the flip has no CAS
(`WHERE id = ? AND status = 'confirmed'`), and `balance_log` has no uniqueness constraint
on `(reference_type, reference_id, grin_address)`
([db.js:425-440](../../web/07_mining_pool_public/back-end-pool/lib/db.js#L425-L440)) to
make the replay fail. A partial run also leaves miners credited with the pool fee or the
incentive rebalance never applied.

The header comment on `distributeConfirmedBlocks` claims the sweep "is naturally
idempotent" ([block-monitor.js:133-137](../../web/07_mining_pool_public/back-end-pool/lib/block-monitor.js#L133-L137)).
It is idempotent only if the process never dies at the wrong instant.

**Fix:** one transaction covering miner credits + pool fee + incentives + the status flip,
with the flip as a guarded CAS that must report `changes === 1`.

### I5 — [Low-Medium] `creditBalances` writes placeholder zeros into every credit ledger row — **FIXED 2026-08-21 (see §I resolution pass)**

Both the miner credit ([:146-151](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L146-L151))
and the pool-fee credit ([:174-181](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L174-L181))
insert `balance_before, balance_after, locked_before, locked_after` as literal
`0, 0, 0, 0`. Same class as the `_releaseLockAndDebit` item still open from §H, but on the
**credit** path — the primary money-in event, and the one surfaced to miners at
`/api/account/:addr/balance/log` and on the transparency page. With zeros there, the ledger
cannot reconstruct a balance history or independently corroborate a disputed payout; the
`amount` column is the only real data in the row. The withdrawal path
([withdrawal-scheduler.js:686-691](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L686-L691))
already reads `before` and writes real values — mirror that.

### I6 — [Info] Miner credit has no account-existence guard, unlike the pool-fee credit — **NOT REACHABLE (schema-blocked); guard added anyway 2026-08-21**

The pool-fee path does `INSERT OR IGNORE INTO miner_accounts` before crediting
([:165-169](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L165-L169)); the
miner loop does a bare `UPDATE … WHERE grin_address = ?` with no such guard and no
`changes` check. Because `balance_log.grin_address` is a FK and `PRAGMA foreign_keys = ON`
([db.js:17](../../web/07_mining_pool_public/back-end-pool/lib/db.js#L17)), a missing account
row does not silently swallow the credit — the ledger insert throws, the transaction rolls
back, `distributeRewards` returns `success:false`, and the block stays `'confirmed'` and is
**retried every 30 seconds indefinitely**. Nothing currently deletes `miner_accounts` rows,
so this is latent rather than live, but it is a hard stall with no alert if it ever fires.

### I7 — [Medium] `POST /api/admin/settings/:section` re-implements step-up and loses the mandatory-2FA gate — **FIXED 2026-08-21 (see §I resolution pass)**

[index.js:5809-5820](../../web/07_mining_pool_public/back-end-pool/index.js#L5809-L5820)
runs under `secureAdmin` and then checks freshness inline with
`authManager.isTokenFresh(req.token, STEP_UP_MAX_AGE_S)`. That reproduces
`requireFreshAuth` but **not** `requireTotpEnrolled`, which is the second element of the
`freshAdmin` chain ([index.js:794-799](../../web/07_mining_pool_public/back-end-pool/index.js#L794-L799))
and the only thing that enforces `access.require_admin_totp`.

Consequence: on a pool with mandatory 2FA turned on, an admin who has **not** enrolled is
correctly refused by every `freshAdmin` route — but can still write the `payout` section
(`withdrawal_fee`, `min_withdrawal`, `withdrawal_cooldown_minutes`, `tor_preflight_gate`,
`dormancy_enabled`, `nostr_nip05_domains`, `nostr_relays`) with a password-only re-auth,
since `/api/admin/reauth` verifies the password and nothing else
([index.js:1802-1821](../../web/07_mining_pool_public/back-end-pool/index.js#L1802-L1821)).
`nostr_nip05_domains` is the SSRF/typo-squat allowlist, so this is not a cosmetic section.

Blast radius is limited by the per-field validators (`withdrawal_fee` caps at 1 GRIN) and
by needing a valid admin password + live session, which is why this is Medium and not High.
[index.js:5428](../../web/07_mining_pool_public/back-end-pool/index.js#L5428) (`POST
/api/admin/locations` with a WireGuard pubkey) has the identical shape.

**Fix:** call `requireTotpEnrolled` explicitly on both, or refactor the inline check into a
`conditionalFreshAdmin` helper that carries both halves.

### I8 — [Medium] The lottery seed is chosen *after* the entry set is known, so a "provably fair" draw is grindable — **FIXED 2026-08-21 (see §I resolution pass)**

[lottery.js:133-140](../../web/07_mining_pool_public/back-end-pool/lib/lottery.js#L133-L140)
takes the seed from `grinNode.getTip()` **at draw time**, and the winner is
`sha256(seed_hash + ":" + salt) mod totalTickets` with `salt = eventName || type`. Both
inputs are under the drawer's control at the moment of drawing:

- the **seed** is whatever the current tip happens to be, and `POST
  /api/admin/incentives/lottery/draw-now` lets the operator pick *when* that is;
- the **salt** is `eventName`, a free-text field on the same request.

Entries come from `hashrate_history`, which the operator can read. So the winner for the
current tip is computable offline before clicking draw — wait for a favourable tip (or vary
`eventName`) and the "deterministic" draw picks whoever you like. A verifiable lottery needs
**commit-then-reveal**: publish "the winner will be derived from the hash of block N" for a
*future* N, then draw at N.

Second, weaker point: the module header claims "anyone can recompute the result from the
seed + the public share data" ([lottery.js:9-12](../../web/07_mining_pool_public/back-end-pool/lib/lottery.js#L9-L12)),
but the entry set is per-address `hashrate_history` work, which is **not** published (and by
the IP/address-privacy design deliberately is not). A third party cannot recompute the draw
today, so the fairness claim is not currently checkable regardless of the seed.

The operator already controls the prize pool outright (`/api/admin/incentives/award`), so
this is not an escalation — it is an integrity-of-claims issue. It matters as soon as any
public page says the draws are provably fair.

### I9 — [Low] Share retention's safety floor ignores blocks stuck in `confirmed` — **FIXED 2026-08-21 (see §I resolution pass)**

`_sharesCutoffHeight` ([retention.js:36-54](../../web/07_mining_pool_public/back-end-pool/lib/retention.js#L36-L54))
lowers the prune floor for the oldest **`status='immature'`** block, but not for a block in
`'confirmed'` (matured, awaiting distribution). Normally harmless — distribution runs every
30 s, and the general `currentHeight − (confirmDepth + PPLNS + margin)` cutoff already
covers a promptly-paid block. But combined with I6 (a block that stalls in `'confirmed'`
retrying forever) or a long node outage, the shares that block needs can age out from under
it. `getSharesForDistribution` then returns empty, and the `no_shares_found` branch marks it
`'paid'` with **the reward retained by the pool and the miners never credited**
([rewards.js:50-62](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L50-L62)).
Cheap fix: `WHERE status IN ('immature','confirmed')` in the floor query.

### I10 — [Low] Operator-supplied region labels reach `innerHTML` unescaped on the network map — **FIXED 2026-08-21 (see §I resolution pass)**

[network-map.js:249](../../web/07_mining_pool_public/public_html/js/network-map.js#L249)
interpolates `best.name` — `h.label` / `g.label || g.region` from `pool_locations`, written
via `POST /api/admin/locations` — straight into `tip.innerHTML`, and
[:381](../../web/07_mining_pool_public/public_html/js/network-map.js#L381) does the same for
donut legend names (those are geoip country names, i.e. server-controlled, so only the
label path is reachable). Admin-authored, so it is self-XSS in the same class as the CMS
`pages.html` and ad `html_code` fields — but unlike those it is not a deliberate
HTML-authoring field, and with I1 open there is no CSP to contain it. Use `escapeText()`
(already present at [branding.js:936](../../web/07_mining_pool_public/public_html/js/branding.js#L936))
or `textContent`.

## §J1 — Route & guard matrix (2026-08-25, add-ons, NOT VPS-TESTED)

### J1-1 — [High] The routes that inject executable script into every public page sit at `secureAdmin`, one tier below `withdrawals/:id/retry` — and one of those pages is the admin login form — **FIXED 2026-08-25 (see resolution pass)**

**Threat actor:** an attacker holding a live admin access token (§C3: unrevocable for the
idle window, ≤24 h, surviving logout, password change and *Revoke sessions*). Secondarily:
a logged-in admin who has **not** enrolled 2FA on a pool with `access.require_admin_totp`
on — the §I7 shape, reached through a different section.

`POST /api/admin/settings/:section` is `secureAdmin` and applies step-up only when
`STEP_UP_SETTINGS_SECTIONS.has(section)` or a `STEP_UP_SETTINGS_KEYS` value actually changed
([index.js:5941-5956](../../web/07_mining_pool_public/back-end-pool/index.js#L5941-L5956),
[:5989-6004](../../web/07_mining_pool_public/back-end-pool/index.js#L5989-L6004)). The gated
set is `payout`, `access`, `incentives`, `database` plus four `pool_info` keys. **`analytics`
and `branding` are in neither**, and they carry:

| Key | Section | Effect |
|---|---|---|
| `custom_head_html` | analytics | raw HTML into `<head>` of every public page |
| `custom_body_html` | analytics | raw HTML before `</body>` |
| `plausible_src` / `umami_src` / `matomo_url` | analytics | third-party script origins |
| `custom_css`, `font_url`, `cta_link` | branding | CSS injection + a fetched font origin |

It is not innerHTML-inert. [branding.js:717-745](../../web/07_mining_pool_public/public_html/js/branding.js#L717-L745)
parses the value into a detached `<div>` and then **deliberately re-creates every `<script>`
node through `cloneScript()`** ([:751-762](../../web/07_mining_pool_public/public_html/js/branding.js#L751-L762))
"so they run". This happens before the cookie-consent branch, so it is unconditional.

The escalation is the page list. Thirteen public pages load `branding.js`, and two of them
matter:

- **`account-settings.html`** — the withdrawal form. Injected JS can rewrite the destination
  or the amount inside the money UI itself.
- **`login.html`** — [`<script src="/js/branding.js">` at :606](../../web/07_mining_pool_public/public_html/login.html#L606),
  with `#password` at [:297](../../web/07_mining_pool_public/public_html/login.html#L297) and
  `#totp-code` at [:345](../../web/07_mining_pool_public/public_html/login.html#L345).

So an attacker who holds only a stolen session — precisely the actor `freshAdmin` exists to
stop — can write a keylogger onto the admin login form, wait for the operator to sign in, and
harvest **the admin password and a live TOTP code**. That is `secureAdmin` → `freshAdmin`
escalation, and it defeats the step-up gate on all 31 `freshAdmin` routes rather than
bypassing one of them. There is no CSP containment: the app CSP at
[index.js:252](../../web/07_mining_pool_public/back-end-pool/index.js#L252) allows
`script-src 'self' 'unsafe-inline'`, and the pages are served from disk by nginx anyway.
The `/admin/` panel does **not** execute these fields (it has no `branding.js`), which bounds
the blast radius to the public origin — but the login form is on the public origin.

The same tier applies to the deliberate HTML-authoring routes, which are the same class one
step less sharp: `POST /api/admin/ads` (`html_code` → [ads.js:50](../../web/07_mining_pool_public/public_html/js/ads.js#L50)
string-concatenated into markup, so `<img onerror>` runs even though a bare `<script>` would
not), `POST /api/admin/pages`, `POST /api/admin/posts` — all `secureAdmin`, all destructive
on their `DELETE` twin.

**This is not a re-litigation of the §B accepted risk.** §B accepts that
`custom_head_html`/`custom_body_html`/`custom_css` *are* stored site-wide XSS by design, and
states the mitigation as "an attacker must already control the admin account". The finding
here is that (a) the codebase's own definition of "control the admin account" for dangerous
actions is `freshAdmin`, not `secureAdmin`, and these routes are below it; and (b) because
`login.html` is in the injection surface, the capability is not merely equal to admin control
— it *acquires* the password that a stolen session lacks.

**Fix (small, local):** add `'analytics'` and `'branding'` to `STEP_UP_SETTINGS_SECTIONS`
(they are cosmetic sections that happen to carry two script sinks, so the cheaper alternative
is adding `custom_head_html`, `custom_body_html`, `custom_css`, `font_url`, `plausible_src`,
`umami_src`, `matomo_url` to `STEP_UP_SETTINGS_KEYS` — that keeps a tagline edit prompt-free,
which is the reason the key-level gate exists at all). Promote `ads`/`pages`/`posts` writes
to `freshAdmin` in the same change, or accept them explicitly with the reasoning written down.
**Separately, and independent of the tier:** `login.html` has no business loading `branding.js`
— an operator-HTML sink on the credential-entry page is wrong at any tier. Handoff to **J15**.

---

### J1-3 — [Medium] `POST /api/admin/locations` can retarget every miner's rig at `secureAdmin`, while removing the same region is `freshAdmin` — **FIXED 2026-08-25 (see resolution pass)**

**Threat actor:** attacker on a stolen admin session.

[index.js:5487](../../web/07_mining_pool_public/back-end-pool/index.js#L5487) is `secureAdmin`,
with the step-up correctly applied to the WireGuard-pairing branch only
([:5507](../../web/07_mining_pool_public/back-end-pool/index.js#L5507)) — the §D.3 / §I7 fix,
still intact. The comment justifies the split as "metadata-only saves stay plain
`secureAdmin` so routine region edits don't prompt".

But `stratum_url` is not metadata. It is upserted straight into `pool_locations`
([:5528-5540](../../web/07_mining_pool_public/back-end-pool/index.js#L5528-L5540)), published
by `GET /api/pool/locations`, and rendered on the public dashboard as the connection string
miners copy into their rigs
([reactor-dashboard.js:715](../../web/07_mining_pool_public/public_html/js/reactor-dashboard.js#L715),
[:830](../../web/07_mining_pool_public/public_html/js/reactor-dashboard.js#L830)). Editing it
points the pool's own "how to connect" panel at an attacker's stratum server. `api_url` has
the same property for anything reading the regional API.

The tier is inconsistent with its own neighbours: `DELETE /api/admin/locations/:id` (removes
one region card) and `POST /api/admin/miners/:addr/ban` (stops one miner earning) are both
`freshAdmin`. Redirecting the whole pool's advertised hashrate is not.

Damage is not instant — miners must re-point manually, and existing rigs keep hashing to the
real stratum — which is why this is Medium and not High. It is a hashrate/reputation attack,
not a balance theft.

**Fix:** gate the branch, not the route — `if ((stratum_url !== row.stratum_url ||
api_url !== row.api_url) && stepUpRefused(req, res)) return;` alongside the existing
`wgPubkey` check. Same pattern already in the file, one line.

---

## §J2 — Auth, session & 2FA (2026-08-25, add-ons, NOT VPS-TESTED)

### J2-1 — [High] `/api/admin/reauth` counts no failed attempts, so the step-up password can be ground at 2400/min — and step-up never asks for a second factor even on a mandatory-2FA pool — **FIXED 2026-08-26 (see §J2 resolution pass)**

**Threat actor: session thief.**

Step-up exists for exactly one attacker. The code says so:

> *"A live (or stolen) session alone is not enough — the client must call `/api/admin/reauth` first."*
> — [index.js:804](../../web/07_mining_pool_public/back-end-pool/index.js#L804)

Every money and destructive route (the 31 `freshAdmin` routes counted in §J1 — withdrawal
retry/cancel, payout freeze, dormancy send-payout, prize-pool topup, wallet adopt-identity) is
reachable the moment `/api/admin/reauth` returns a `pwa=now` token. So the strength of that
whole tier is the strength of the password check on this one route.

That check has **no attempt counter of any kind**:

- [index.js:1839](../../web/07_mining_pool_public/back-end-pool/index.js#L1839) —
  `app.post('/api/admin/reauth', secureAdmin, …)`. `secureAdmin` is
  `rateLimiter('admin')` → `ipFilter('admin')` → `requireAdmin`
  ([index.js:771](../../web/07_mining_pool_public/back-end-pool/index.js#L771)).
- `rateLimiter.limits.admin = 2400` per minute, per IP
  ([lib/rate-limiter.js:44](../../web/07_mining_pool_public/back-end-pool/lib/rate-limiter.js#L44),
  keyed on `getClientIp` at [:87](../../web/07_mining_pool_public/back-end-pool/lib/rate-limiter.js#L87)).
- On failure the handler writes a `reauth_failed` audit row and returns 401
  ([index.js:1846–1852](../../web/07_mining_pool_public/back-end-pool/index.js#L1846)). It does
  **not** call `recordAdminLoginFailure()` — the fail2ban-style per-IP auto-ban
  ([index.js:852](../../web/07_mining_pool_public/back-end-pool/index.js#L852)) — which is wired
  to only two of the codebase's credential checks: `/api/auth/login`
  ([:1748](../../web/07_mining_pool_public/back-end-pool/index.js#L1748)) and
  `/api/auth/login/totp` ([:1776](../../web/07_mining_pool_public/back-end-pool/index.js#L1776)).
- `AuthManager.stepUp()`
  ([lib/auth.js:684](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L684)) does a bare
  `comparePassword` and returns. Unlike `login()`
  ([lib/auth.js:260](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L260)) it never
  calls `_recordPairFailure`, so the `(username, IP)` lockout is not armed either.

Harness — ten consecutive wrong-password `stepUp()` calls, versus one wrong-password `login()`:

```
[6] lockout entries after 10 failed stepUp(): 0 | lockoutRemaining: 0
[6] login() for comparison -> lockout entries: 1
```

**Nor does the second factor help.** `freshAdmin`'s `requireTotpEnrolled`
([index.js:793](../../web/07_mining_pool_public/back-end-pool/index.js#L793)) checks
`isTotpEnabled(user_id)` — whether the account *has* 2FA — and never asks for a code. On a pool
with `access.require_admin_totp` on, the step-up challenge is still **password only**. This route
is not one factor of two; it is the whole gate.

**Failure scenario.** A session thief lifts the `access_token` cookie. Today they can read the
panel but not move money. They POST `/api/admin/reauth` in a loop from one IP: 2400 guesses/min
= 3.46 M/day, no lockout, no auto-ban, no captcha, no escalating delay, nothing beyond one audit
row per attempt. `registerAdmin` enforces `password.length >= 8` and nothing else
([lib/auth.js:98](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L98)) — no complexity
rule, no dictionary check — so an operator-chosen 8-character password is well inside that
budget. On success every `freshAdmin` route opens, including `payouts/freeze` and
`withdrawals/:id/retry`.

**Second, quieter call site.** `/api/auth/change-password`
([index.js:1940](../../web/07_mining_pool_public/back-end-pool/index.js#L1940)) verifies
`old_password` ([lib/auth.js:486](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L486))
behind `rateLimiter('auth')` (200/min) and `requireAuth` — again with no lockout, no auto-ban and
**no** `ipFilter`. Same actor, 288 k guesses/day, and this one writes no audit row at all.

**The DoS side of the same fact.** `bcryptjs` is pure JavaScript running on the single event loop
that also validates stratum shares. Measured on this workstation at the configured cost 12:

```
bcryptjs cost-12 compare avg ms: 304
```

2400 × 0.304 s = **730 CPU-seconds demanded per 60 s of wall clock**. The process cannot keep up;
a session thief who never guesses the password still stalls share intake and every API route.
Same shape as the "a long job on the shared loop stalls SHARES, not just the page" trap recorded
in memory `project_pool_db_capacity`.

**Fix (not applied — changes money-gate behaviour, needs an operator decision).**
1. Call `_recordPairFailure(req.user.username, req.ip)` + `recordAdminLoginFailure(req.ip)` on a
   failed `stepUp`, and refuse while `lockoutRemaining() > 0` — the same three-layer policy the
   login route already has (memory `project_pool_admin_login_security`). Because the key is
   `(username, IP)`, this cannot be turned into an operator lockout by a third party.
2. Give `reauth` and `change-password` their own tight bucket (`stepup: 10/min`), not
   `admin`/`auth`.
3. When `totpIsMandatory()`, make `stepUp` require a TOTP code as well — otherwise "mandatory
   2FA" is not enforced on the one path that unlocks money.
4. Raise the minimum admin password length; 8 with no complexity rule is not a credible floor for
   a single-account, root-equivalent panel.

Note that (1) alone does not close the CPU lever — the bcrypt runs before any counter can see the
result. (2) is what bounds the CPU.

---

### J2-2 — [Medium] First-admin registration TOCTOU is real and remotely winnable — two concurrent registrations both become admins — **FIXED 2026-08-26 (see §J2 resolution pass)**

**Threat actor: anonymous.**

Carried into this session by §J1's handoff and §I's re-test sequencing note, both of which leave
it "held by launch procedure". This pass demonstrates it rather than describing it, because the
demonstration changes what that procedure has to guarantee.

[index.js:1629](../../web/07_mining_pool_public/back-end-pool/index.js#L1629) reads the admin
count synchronously and then `await`s:

```js
const adminCount = db.prepare('SELECT COUNT(*) as cnt FROM users WHERE is_admin=1').get();
if (adminCount.cnt > 0) return res.status(403).json({ error: 'Admin registration closed.' });
…
const result = await authManager.registerAdmin(username, password);   // :1648
```

`registerAdmin` ([lib/auth.js:88](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L88))
awaits `hashPassword` — a cost-12 bcrypt, ~300 ms — **between** its own existence check and the
`INSERT`. That await yields the event loop for roughly a third of a second, which is an enormous
window for an HTTP race. `users.username` is `NOT NULL UNIQUE`
([lib/db.js:515](../../web/07_mining_pool_public/back-end-pool/lib/db.js#L515)), so the guard that
does exist only stops *duplicate-named* winners — two different names both land.

Harness — two concurrent registrations against an empty `users` table, replaying the exact
statements from :1629 and :1648:

```
[1] concurrent register results: {"success":true,"user_id":1,"username":"operator","is_admin":true} {"success":true,"user_id":2,"username":"attacker","is_admin":true}
[1] admins now in DB: ["operator","attacker"] -> RACE OPEN = true
```

**Failure scenario.** The window opens when the service first starts and closes when the operator
registers. An attacker who reaches the panel in that window — a scanner watching a new subdomain,
or anyone who knows the pool is being stood up — POSTs `/api/auth/register` concurrently with the
operator's own registration and receives a second, fully-privileged admin account with its own
password, its own 2FA and its own sessions. Nothing later revokes it: the panel has no
user-management surface, and the `register` audit row is the only trace (`--list` in the
break-glass CLI would show the account, if anyone looked). The captcha is not a barrier — it is a
plain-text arithmetic question, deliberately so (memory `project_pool_admin_login_security`), and
the attacker only needs to solve two.

The mitigations that exist are procedural, not code: the app binds `127.0.0.1`
([index.js:743](../../web/07_mining_pool_public/back-end-pool/index.js#L743)), so the window is
only reachable once the nginx vhost is live, and Script 07's guided installer registers over
loopback. Neither is guaranteed by anything in this file.

**Fix (not applied — the plan asks for a decision, and both options have an operator cost).**
Either (a) do the count check *and* the insert inside one `db.transaction()`, with the bcrypt hash
computed **before** the transaction opens — three lines, closes it outright; or (b) keep the
procedure but make it enforceable by refusing `/api/auth/register` unless `isLocalRequest(req)`,
so first-admin creation is on-box only and the remote window never exists. (b) is stronger and
matches how the installer already works; it costs an operator who wanted to register from a
browser on another machine.

---

### J2-3 — [Medium] The 2FA login budget is per-IP only and the `twofa_token` is unlimited-use, so a distributed attacker holding the password is not bounded — **FIXED 2026-08-26 (see §J2 resolution pass)**

**Threat actor: password holder (distributed).**

Memory `project_pool_admin_login_security` names mandatory TOTP as the backstop a botnet cannot
out-scale, and the code repeats it:

> *"a large BOTNET defeats any per-source lock, because each new IP starts with a clean counter.
> What bounds that is the per-IP auth rate limit plus the fail2ban-style auto-ban — and,
> properly, mandatory TOTP."*
> — [lib/auth.js:38–43](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L38)

The TOTP step's own budget has the same per-source shape, so it inherits the same weakness:

- `ADMIN_2FA_FAIL_THRESHOLD = 20` per IP per 15 min
  ([index.js:373](../../web/07_mining_pool_public/back-end-pool/index.js#L373)), counted by
  `recordAdminLoginFailure(ip, '2fa')` — **keyed on IP, never on the account or the token**.
- The `twofa_token` minted at
  [index.js:1720](../../web/07_mining_pool_public/back-end-pool/index.js#L1720) is a plain
  300-second JWT `{user_id, type:'2fa'}`
  ([lib/auth.js:604](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L604)).
  `verify2faToken` ([:608](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L608))
  decodes and returns — it consumes nothing, records nothing, and binds to nothing.

Harness:

```
[8] verify2faToken #1: 1 #2: 1 #3: 1
```

So one token is a **bearer credential replayable from any number of source addresses** for five
minutes. The 20-guess ceiling is per IP, not per token and not per account, and the fail2ban jail
`grin-pool-login` does not cover this route at all — its failregex matches `POST /api/auth/login`
while step two posts to `/api/auth/login/totp` (that correction is already recorded in memory
`project_pool_admin_login_security`).

**Failure scenario.** A password holder solves one captcha, logs in, and gets a `twofa_token`.
They fan it out to N hosts. Each host may spend 20 guesses before its own IP is banned; the token
itself is never invalidated and the account is never locked. With `window = 1` three codes are
live at any instant out of 10⁶, so p ≈ 3 × 10⁻⁶ per guess and 20 N guesses per token window. A few
thousand hosts across repeated windows — and windows are free, because a fresh `twofa_token` costs
one captcha and one correct password — reduces "mandatory 2FA" to a matter of patience. Nothing in
the design makes the attacker pay per *account*, which is the axis that actually matters.

**The two 2FA management routes have no counter at all.** `POST /api/admin/2fa/disable`
([index.js:1903](../../web/07_mining_pool_public/back-end-pool/index.js#L1903)) and
`POST /api/admin/2fa/recovery/regenerate`
([:1913](../../web/07_mining_pool_public/back-end-pool/index.js#L1913)) both call
`verifyTotpOrRecovery` ([lib/auth.js:559](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L559))
with only the `admin` bucket (2400/min) in front and no call to `recordAdminLoginFailure` — about
139 minutes of sustained requests from one IP for one expected code hit. It is **not an escalation
path today**: both are `freshAdmin`, so reaching them already requires a full session plus the
password, i.e. the attacker has already beaten 2FA. It matters because the code-guessing counter
is wired to one of the three routes that verify a code, which is the kind of asymmetry that
becomes a hole the next time a tier moves. The recovery branch also runs up to 10 cost-12 bcrypt
compares per submission
([lib/auth.js:569–576](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L569)) — roughly
3 s of shared-event-loop CPU per request, which is the J2-1 lever again.

**Fix (not applied).** Make the budget follow the *account*, not the source: give the
`twofa_token` a `jti`, hold it in a Map with an attempt counter, and invalidate it after 5
failures or 1 success. A distributed attacker then gains nothing from extra IPs, while an honest
operator fumbling codes on one device is unaffected — which is exactly the false-positive worry
that set `ADMIN_2FA_FAIL_THRESHOLD` to 20 in the first place. Separately, route `disable` and
`recovery/regenerate` failures through `recordAdminLoginFailure(ip, '2fa')` so all three code
checks share one counter.

---

### J2-4 — [Medium] Any anonymous client can evict every pending CAPTCHA challenge and lock the operator out of the admin panel — **FIXED 2026-08-26 (see §J2 resolution pass)**

**Threat actor: anonymous.**

`lib/captcha.js` keeps one **global, un-keyed** store capped at 5000 entries, and `_prune()` evicts
**oldest-inserted first** to get back under the cap:

```js
constructor({ ttlMs = 300000, max = 5000 } = {}) { … this.store = new Map(); }   // :103
_prune() {
  …
  if (this.store.size > this.max) {
    let excess = this.store.size - this.max;
    for (const id of this.store.keys()) { this.store.delete(id); if (--excess <= 0) break; }
  }
}                                                                                 // :109
issue() { this._prune(); … this.store.set(id, { answer, expires }); }             // :124
```
— [lib/captcha.js:103–133](../../web/07_mining_pool_public/back-end-pool/lib/captcha.js#L103)

Issuing is free and unauthenticated: `GET /api/auth/captcha` sits on the `public` bucket, 1200/min
per IP ([index.js:1616](../../web/07_mining_pool_public/back-end-pool/index.js#L1616)), explicitly
so the form "can fetch one without spending the stricter `auth` budget". Every call inserts a row.
Insertion order in a JS `Map` is fixed at first insert, so the operator's challenge sits at a fixed
position and is deleted once 5000 newer ones arrive.

**Failure scenario.** The operator opens `/login.html`, the page fetches a challenge, they type
their password. Meanwhile an attacker holds ~250 `GET /api/auth/captcha` per second (≈13 source
IPs at the published per-IP limit, fewer if the operator is slow to type). By the time the operator
submits, their `captcha_id` has been evicted; `verify()` returns `false` on the missing entry
([:138](../../web/07_mining_pool_public/back-end-pool/lib/captcha.js#L138)) and the login route
answers **"Captcha incorrect or expired. Try again."**
([index.js:1698](../../web/07_mining_pool_public/back-end-pool/index.js#L1698)). Reloading gets a
fresh challenge that is evicted the same way. The operator cannot log in, and the error blames
them — it reads as a typo, not an attack. There is no log line, no alert and no counter that would
say otherwise; `_prune()` is silent.

This matters because it is precisely the failure mode the lockout design refuses to permit. The
key was moved to `(username, IP)` specifically so that

> *"anyone could fail 5 logins every 15 min and keep the real operator permanently locked out of
> their own pool — including during an incident, when payouts and the freeze kill-switch are
> exactly what's needed"*
> — [lib/auth.js:27–33](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L27)

The captcha store hands that same denial back through a different door, at lower cost to the
attacker (no failed logins, so no auto-ban, no fail2ban hit, nothing in the audit log), and against
**every** admin at once rather than one `(username, IP)` pair. Recovery options are thin: `register`
is closed; `login` has no `isLocalRequest` bypass (only `register` does,
[index.js:1639](../../web/07_mining_pool_public/back-end-pool/index.js#L1639)); restarting the pool
service clears the store but the flood resumes in seconds; and the break-glass CLI resets passwords,
not captchas.

**Fix (not applied — small, but it is a live availability control and deserves the operator's
sign-off rather than a same-session edit).** Key the store per client IP with a small per-IP cap
(say 20 outstanding) and evict *that IP's own* oldest first, so flooding is self-inflicted:

```js
issue(ip) { … this.store.set(id, { answer, expires, ip }); this._pruneIp(ip); }
```

The global 5000 cap then stays only as a memory backstop. A stateless HMAC challenge
(`id = HMAC(secret, answer‖expiry‖nonce)`) removes the store entirely but loses single-use, which
is a property worth keeping — the per-IP cap is the better trade.

**Not a finding, checked and cleared:** the same oldest-first eviction exists on
`AuthManager.lockouts` (`lockoutMaxEntries = 20000`,
[lib/auth.js:150](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L150)) and would, in
principle, let an attacker evict their own lock. It is not reachable: entries are created only from
inside `login()`, and 10 failures from one IP earn a 1 h auto-ban
([index.js:360](../../web/07_mining_pool_public/back-end-pool/index.js#L360)), so filling 20 000
slots would need ~2000 fresh IPs per hour — an attacker with that already ignores per-source locks
by definition.

---

### J2-5 — [Medium] TOTP codes are replayable — no used-counter, so one observed code works repeatedly across its 90-second window — **FIXED 2026-08-26 (see §J2 resolution pass)**

**Threat actor: password holder who has seen one code** (shoulder-surf, a screenshot in a support
thread, a phishing page that harvests password + code, malware reading the notification shade).

`totp.verify` ([lib/totp.js:63](../../web/07_mining_pool_public/back-end-pool/lib/totp.js#L63))
compares against counters `-1 … +1` and returns. Nothing records that a counter was consumed —
`users` has `totp_secret`, `totp_enabled`, `totp_pending_secret` and no last-used column
([lib/db.js:522–524](../../web/07_mining_pool_public/back-end-pool/lib/db.js#L522)), and
`verifyTotpOrRecovery` ([lib/auth.js:559](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L559))
writes only on the *recovery-code* branch. Recovery codes are correctly single-use
([:572](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L572)); TOTP codes are not.

Harness — one code, three submissions, plus the neighbouring steps:

```
[4] totp code 425411 use#1: true use#2: true use#3: true
[5] prev-step code accepted: true | next-step code accepted: true
```

RFC 6238 §5.2 is explicit that a verifier must not accept a second use of the same OTP, precisely
because the protocol's only defence against an observed code is that it is spent. `window = 1`
widens the exposure to three 30-second steps, so an observed code is live for up to 90 s and can be
used any number of times inside it — on `/api/auth/login/totp`, on `/api/admin/2fa/disable`, or on
`/api/admin/2fa/recovery/regenerate`, in any combination.

**Failure scenario.** A phishing page collects username, password and one code. Today the attacker
replays all three at `/api/auth/login/totp` and gets a session. With the code spent, that replay
fails and the attacker must hold a live channel to the victim for every subsequent action — the
difference between a credential-harvesting page and a real-time relay, and the whole reason
single-use exists.

**Fix (not applied — needs a schema column, so it is not a same-session edit).** Add
`users.totp_last_counter INTEGER NOT NULL DEFAULT 0`; have `verify` return the matched counter and
reject any counter `<= totp_last_counter`, storing it on success. Roughly ten lines across
`totp.js`, `auth.js` and the `db.js` migration. Keep `window = 1` — clock drift is the
false-positive risk the operator actually meets, and single-use is orthogonal to it.

---

### J2-7 — [Low] A disabled admin account is distinguishable from a non-existent one, skips the bcrypt timing equaliser, and is exempt from the lockout counter — **FIXED 2026-08-26 (see §J2 resolution pass)**

**Threat actor: anonymous.**

`login()` orders its branches so the `is_active` check sits between the user lookup and the password
compare ([lib/auth.js:249](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L249)):

```js
if (!user) { await this.comparePassword(password, await this._dummyHash());   // :239 equaliser
             this._recordPairFailure(username, ip); return {…'Invalid username or password'}; }
if (!user.is_active) { return { success:false, error:'Account is disabled' }; }   // :249
```

Harness:

```
[7] disabled -> "Account is disabled" | unknown -> "Invalid username or password"
[7] lockout entries after 1 disabled + 1 unknown attempt: 1 (expect 2 if both counted)
```

Three small divergences from the surrounding design, which is otherwise careful about exactly this:
a distinct error string, no `_dummyHash` compare (so the response also returns measurably faster —
the timing oracle the equaliser at :234–239 was written to close), and no `_recordPairFailure`, so
guesses against a disabled account never arm the `(username, IP)` lock.

Impact is genuinely small: a pool normally has one admin, `is_active = 0` is only reachable via a
direct DB edit, and the per-IP auto-ban still fires from
[index.js:1748](../../web/07_mining_pool_public/back-end-pool/index.js#L1748) because
`result.success` is false. It is Low because it confirms a username to an anonymous prober and
because it is a hole in a defence the same function goes to some trouble to build.

**Fix (not applied).** Move the `is_active` test to after the password compare, return the generic
string, and record the pair failure — i.e. treat a disabled account exactly like a wrong password.

---

### J2-8 — [Info] Verified clean

Recorded so a later session does not re-derive them. Each was read and, where it could be, executed.

| Question (plan §J2) | Result |
|---|---|
| **JWT secret provenance / entropy / persistence** | `crypto.randomBytes(32).toString('hex')` (64 chars), `openssl rand -hex 32` fallback, written **once** to `pool.json` at install ([07_grin_mining_public_pool.sh:595–600](../../scripts/07_grin_mining_public_pool.sh#L595)). `validateConfig` hard-fails on missing / `<32` chars ([lib/config.js:209](../../web/07_mining_pool_public/back-end-pool/lib/config.js#L209)) rather than minting at boot. Both generators failing writes an empty value → FATAL, so it fails closed. |
| **`algorithm` pinned on verify (alg-confusion / `none`)** | `jwt.verify` passes no `algorithms` ([lib/auth.js:360](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L360)), but jsonwebtoken 9 defaults to `['HS256','HS384','HS512']` for a non-PEM secret. Executed against the installed 9.0.3: a forged `alg:none` token → `jwt signature is required`. **Not exploitable.** Pinning `{ algorithms: ['HS256'] }` is still worth adding as defence-in-depth against a future major bump. |
| **`expiresIn` set; `iss`/`aud` checked** | `expiresIn` set on all three token types (access = live idle, refresh 7 d, 2fa 300 s). No `iss`/`aud` — one issuer, one secret, and every consumer checks the `type` claim, so there is no confusable audience. |
| **`/api/auth/refresh` re-mints `pwa`?** (§J1 handoff) | **No.** `refreshAccessToken` passes `pwa = 0` explicitly ([lib/auth.js:433](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L433)) and `isTokenFresh` rejects `pwa = 0` outright ([:675](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L675)). A silent refresh cannot grant step-up freshness. |
| **Refresh rotated / single-use / session-bound** | Rotated via `token_version + 1` on every refresh; replay rejected at [:408](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L408) — harness: `"Refresh token revoked"`. `sst` is carried unchanged through refresh **and** step-up ([:433](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L433), [:694](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L694)), so the absolute cap is anchored to the original login and is not decorative. |
| **Login lockout key / timing / audit action** | Pair key `${username.toLowerCase()}\0${ip}` checked **before** the user lookup ([:220](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L220)); unknown usernames counted ([:242](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L242)); `_dummyHash` equalises timing ([:239](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L239)) — **except** on the disabled branch, which is J2-7. Failure action is `login_failed` at both writers ([index.js:1745](../../web/07_mining_pool_public/back-end-pool/index.js#L1745), [lib/auth.js:660](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L660)), matching memory `project_pool_admin_login_security`. |
| **TOTP secret at rest / enrollment binding / recovery codes** | Secret is 20 random bytes base32 ([lib/totp.js:43](../../web/07_mining_pool_public/back-end-pool/lib/totp.js#L43)), stored plaintext in `users.totp_secret` — unavoidable for TOTP and equivalent to the wallet password already accepted in *Residual risks*. `confirm2faEnrollment` reads `totp_pending_secret` for the **confirming** `user_id` ([lib/auth.js:538](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L538)), so a secret cannot be bound to another account. Recovery codes: 7 random bytes → 10 base32 chars, bcrypt-hashed, single-use via `used_at` ([:582](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L582), [:572](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L572)). Digit compare is `crypto.timingSafeEqual` ([lib/totp.js:71](../../web/07_mining_pool_public/back-end-pool/lib/totp.js#L71)). `disable` is `freshAdmin` **and** demands a code. |
| **CAPTCHA replay / offline solve / bypass** | Single-use — deleted on the first `verify()` whether right or wrong ([lib/captcha.js:140](../../web/07_mining_pool_public/back-end-pool/lib/captcha.js#L140)), so a solved token cannot be spread across password guesses. Machine-solvable by design, deliberately left at two operands (memory `project_pool_admin_login_security`) — **not** re-reported. `isLocalRequest()` is the **only** bypass and applies to `register` only; `login` has none. |
| **`isLocalRequest` forgeability** | Safe as deployed. `trust proxy = 'loopback'` ([index.js:224](../../web/07_mining_pool_public/back-end-pool/index.js#L224)) and every pool `/api` location sets `X-Forwarded-For $proxy_add_x_forwarded_for`, which **appends** the real client on the right. Executed against `proxy-addr` with the compiled `loopback` trust list: attacker-sent `XFF: 127.0.0.1` + nginx append → `req.ip = 9.9.9.9`. It only breaks if a vhost stops setting XFF (then `req.ip` resolves to `127.0.0.1`) — **handoff to J16: do not remove that line.** |
| **Cookie flags** | `httpOnly`, `sameSite:'strict'`, `secure` when `NODE_ENV==='production'` — and the systemd unit sets it ([07_grin_mining_public_pool.sh:642](../../scripts/07_grin_mining_public_pool.sh#L642)). `sameSite:'strict'` is the only CSRF control on the admin mutations, and it holds: `/api/admin/` and `/api/auth/` are excluded from the CORS allowlist ([index.js:268](../../web/07_mining_pool_public/back-end-pool/index.js#L268)) and the `Authorization` header fallback is unreachable cross-origin. |
| **Session-policy clamps agree** | Validator 1–24 h idle / 1–168 h absolute ([lib/pool-settings.js:906–920](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L906)) matches `_sessionPolicy`'s runtime clamp exactly ([lib/auth.js:75–79](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L75)), and `abs < idle` is repaired at [:84](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L84). No silently-ignored saved value. |
| **`revoke-sessions` actually revokes** | Yes — a real server-side `token_version` bump, not a cookie clear (it clears no cookies at all). Scope is `req.user.user_id` only; with more than one admin account it does **not** revoke the others. Worth knowing if J2-2 ever produces a second admin. |
| **Break-glass CLI** | Root-checked ([scripts/admin-reset.js:353](../../web/07_mining_pool_public/back-end-pool/scripts/admin-reset.js#L353)), no HTTP surface, never calls `initDb()` (which would drop `admin_audit_log`), writes an `admin_cli_reset` audit row per action, never accepts a password in argv. Confirmed as described in memory `project_pool_admin_login_security`. `--unlock` also sets `is_active = 1`, so it can re-enable a deliberately disabled account — root-only, Info. |

---

## §J3 — Ownership gate & account API (2026-08-26, add-ons, NOT VPS-TESTED)

### J3-1 — [High] One accepted share writes BOTH ownership-proof legs, so the AND-gate protecting the payout *destination* is one factor, not two — **FIXED 2026-08-26 (see §J3 resolution pass)**

**Threat actor: rig holder.**

`POST /api/account/:addr/nostr-destination` is the only miner-reachable route that can point a
payout somewhere other than the miner's own wallet, and the code says so plainly:

> *"Goblin pays a USERNAME — so this endpoint, not the withdraw endpoint, is where money can be
> redirected. It therefore demands BOTH proofs (mining IP AND rig password) where a withdrawal
> accepts either."*
> — [index.js:3765–3768](../../web/07_mining_pool_public/back-end-pool/index.js#L3765)

`requireBothProofs` ([index.js:3769–3788](../../web/07_mining_pool_public/back-end-pool/index.js#L3769))
implements that honestly: two `verifyOwnerProof` calls, the first pinned to `method === 'ip'`, the
second to `method === 'password'`, so submitting the password in both fields cannot pass.

The problem is upstream. Both legs are captured **from the same event, by the same call**:

```js
if (!session.ipRecorded) {
  session.ipRecorded = true;
  this.minerManager.recordOwnerEvidence(session.grinAddress, session.ip, session.pass);
```
— [lib/stratum-server.js:599–601](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L599)

`recordOwnerEvidence` then writes the IP window
([owner-proof.js:276–282](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L276))
and the password window
([:295–299](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L295)) in one
statement. Nothing checks who is connected — stratum login is unauthenticated by design (the
address *is* the username,
[stratum-protocol.js:61–66](../../web/07_mining_pool_public/back-end-pool/lib/stratum-protocol.js#L61)),
and any address may be mined by anyone. So one accepted share submitted under a victim's address,
with an attacker-chosen rig password, hands the attacker **both** halves of the AND-gate: the
password they chose, and their own IP.

Harness (steps 1–2 — the victim mines first, then one attacker session):

```
victim proof: IP leg              {"ok":true,"reason":"match","method":"ip"}
victim proof: password leg        {"ok":true,"reason":"match","method":"password"}

== 2. ATTACKER submits ONE accepted share under the victim address ==
attacker IP leg   (needs method=ip)          {"ok":true,"reason":"match","method":"ip"}
attacker pass leg (needs method=password)    {"ok":true,"reason":"match","method":"password"}
=> requireBothProofs (nostr-destination) WOULD PASS        true
```

**Failure scenario.** The Goblin rail is enabled. An attacker reads the public leaderboard
(`/api/pool/top-block-finders`) or the account API for a miner with a large balance, points any
rig at that address with `pass = "chosen-secret-99"` for a few seconds, and stops. They now
register their own goblin.st username as the victim's payout destination, wait out the 48 h
cooldown, and withdraw the balance to themselves.

**What still stands, and what does not.** §E.3's other four layers are real and each does its job:
the destination is stored, never taken from the withdraw body (layer 1); the 48 h cooldown holds
(layer 2); TOFU re-pin (3) and the NIP-05 allowlist (4) are untouched. The one that fails is the
premise underneath layer 2 — *"Registration is visible on the miner's own account page, so the
real owner … has the whole window to spot a hijack."* That assumes the owner looks. Worse, the
change-alert DM
([index.js:3794–3812](../../web/07_mining_pool_public/back-end-pool/index.js#L3794)) fires only at
a **previous** destination, so a victim who has never used the Goblin rail — the common case —
gets no alert at all, and their account page shows a destination they would have to already be
watching for.

**Fix (not applied — structural, plan rule 3).** The AND-gate needs two factors that cannot be
written by one event. Options, cheapest first:

1. **Refuse to accept a proof captured after the account had a balance.** Stamp
   `last_pass_set_at` / `last_ip_set_at` at capture and make `requireBothProofs` reject a leg
   younger than the destination cooldown. An attacker's freshly-injected proof is then unusable
   for 48 h, during which the victim's own mining re-captures and evicts it.
2. **Do not let a *new* proof value silently displace an existing one on an account that already
   has one.** Capture into a pending slot; promote it only after N sessions or a fixed age.
3. **Require the Goblin registration to be confirmed from the previous destination or by a Tor
   payout to the mining address** — i.e. make the confirmation use a rail that cannot be forged.

Option 1 is the smallest change and closes the scenario above without touching the stratum path.
Whichever is chosen, the fix belongs in `owner-proof.js` + the `nostr-destination` route, not in
`stratum-server.js`, because the capture itself is legitimate — it is *trusting* it that is not.

---

### J3-2 — [High] `password_proof.live.distinct` on the public account summary is an unthrottled online oracle for the rig-password leg — **FIXED 2026-08-26 (see §J3 resolution pass)**

**Threat actor: anonymous.**

`GET /api/account/:addr` publishes live cross-rig password diagnostics:

```js
password_proof: {
  state: acct.pass_proof_state || null,
  live: minerManager ? minerManager.getPasswordConsistency(acct.grin_address) : null
}
```
— [index.js:3046–3049](../../web/07_mining_pool_public/back-end-pool/index.js#L3046)

The comment defends this as safe because it is counts-only, and it is:

> *"A non-compliant password can never be accepted as proof, so telling a visitor it is short or a
> factory default reveals only that a door they can't open is shut."*
> — [index.js:3041–3043](../../web/07_mining_pool_public/back-end-pool/index.js#L3041)

That reasoning covers `state`. It does not cover `live`. `getPasswordConsistency` builds a **Set of
the raw password strings across every currently-connected session for that address** and returns
its size:

```js
for (const [, s] of this.activeSessions) {
  if (s.grinAddress !== grinAddress) continue;
  sessions++;
  const p = typeof s.pass === 'string' ? s.pass.trim() : '';
  if (p && isUsablePassword(p, this.db)) usable.add(p);
  else unusable++;
}
return { sessions, distinct: usable.size, unusable };
```
— [lib/miners.js:201–218](../../web/07_mining_pool_public/back-end-pool/lib/miners.js#L201)

A stratum session is created at **login**, before any share
([stratum-server.js:477](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L477)),
and login is unauthenticated. So:

1. Attacker opens a stratum connection, logs in as `<victim-address>.probe` with candidate
   password **X**.
2. Attacker fetches `GET /api/account/<victim-address>`.
3. If `distinct` is unchanged, **X is byte-identical to a password one of the victim's live rigs
   is using**. If it went up by one, X is wrong.

This is a direct equality oracle on the password leg of the gate, and it **bypasses every control
built to protect that leg**: `FAIL_MAX = 8` per address per 10 minutes
([owner-proof.js:230](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L230)), the
per-IP counter added by §F2, the 16 MB scrypt that makes each guess expensive
([:179](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L179)), and
`auditOwnerProof`'s deny row ([:415](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L415)).
No guess reaches `verifyOwnerProof` at all, so nothing is counted, nothing is slowed and nothing
is logged.

**Failure scenario, with the rate that actually applies.** `max_connections_per_ip` defaults to
**320** ([stratum-server.js:120](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L120)),
and the account summary rides the loose `public` bucket at 1200/min
([index.js:2963](../../web/07_mining_pool_public/back-end-pool/index.js#L2963)). The attacker does
not have to test one candidate per request: open 320 sessions carrying 320 *distinct* candidates,
read `distinct` once, and the count tells them how many of the 320 were hits; a binary search over
the batch (≈9 further reads, closing sockets to bisect) isolates which. That is ~320 candidates
per ~10 HTTP requests, i.e. of order 10⁴ candidates per minute from a single IP — against a gate
whose designed budget is 8 per 10 minutes. Rig passwords are typed once into ASIC firmware and are
overwhelmingly dictionary-grade; `PASS_MIN = 8`
([owner-proof.js:153](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L153)) is
the only entropy floor.

**Note this is not the same hole as J3-1** — it needs no mining hardware and no PoW at all, and it
recovers the *victim's real* password rather than injecting a new one, which means it also survives
any fix that makes injected proofs untrusted.

**Fix (not applied).** `live` exists to answer one operator-facing question — *"are my rigs
configured consistently?"* — and that question is not the public's. Either:

- drop `distinct` from the public payload and keep `sessions` / `unusable` (which carry no
  password material), moving the full breakdown to `GET /api/admin/miners/:addr`; or
- keep the shape but make it non-differential: report `distinct` only when
  `sessions >= 3`, or coarsen to a boolean `consistent: distinct <= 1`. A boolean still flips on a
  correct guess, so this is the weaker option — **prefer removal.**

The `state` field can stay: it is derived from the account row, not from live sessions, and the
comment's reasoning about it holds.

---

### J3-3 — [High] The per-address failed-proof lockout is a weapon: ~9 requests per 10 minutes from one IP permanently denies a miner access to their own balance — **FIXED 2026-08-26 (see §J3 resolution pass)**

**Threat actor: anonymous.**

`verifyOwnerProof` locks per **address**, and the lock is applied regardless of *who* failed:

```js
if (isLockedOut(grinAddress) || (ipKey && isLockedOut(ipKey))) {
  return { ok: false, reason: 'too_many_attempts' };
}
```
— [owner-proof.js:326–328](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L326)

with `FAIL_MAX = 8` per 10-minute window and a 5-minute lockout
([:229–232](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L229)). §F2 reasoned
about this counter only from the attacker's side — *"an attacker walking the public leaderboard
gets a fresh 8-guess budget per address"* — and added the per-IP counter to cap the sweep. Neither
counter considers the **victim's** side: the address lock has no notion of an origin, so the eight
guesses that trip it need not come from the person being locked out.

Harness (step 5 — eight wrong guesses, each from a different source IP so the per-IP counter never
fires, then the real owner tries their real password):

```
after 8 wrong guesses from 8 distinct IPs   {"ok":false,"reason":"too_many_attempts"}
owner locked out of their own address?      true
```

**Failure scenario.** `_throttleState` resets a key only when its window has aged past
`FAIL_WINDOW_MS` ([:238](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L238)),
and `_registerFail` re-arms `lockedUntil` on *every* call once `count >= max`
([:250–254](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L250)). So sustaining
a lock costs 8 requests to arm it and 1 request per window thereafter — call it **9 requests per
10 minutes, ≈54 per hour**, which sits comfortably under both the `withdraw` bucket (20/min per
IP, §F1) *and* the per-IP proof counter (20 per 10 min), so **one IP is enough** and no throttle
anywhere ever fires. Targets are read straight off the public leaderboard. The victim's every
attempt returns `too_many_attempts` — they cannot withdraw by Tor, by slatepack, or by Goblin, and
there is no miner-facing appeal path: the public cancel was removed in §E.1 and every admin
remedy needs the operator.

Left running, this ends at the §Abandoned-balance policy: 24 months dormant, swept to the prize
pool. The griefing the gate was built to prevent — *"each one burns a pool-paid network fee"* — is
one fee. This is the whole balance.

**Fix (not applied).** Separate "this address is under attack" from "this requester is failing".
The per-IP counter (§F2) is the one that should refuse service; the per-address counter should
raise the *cost* without ever hard-refusing an origin that has not itself failed. Concretely:

- key the lockout on the **pair** `(address, requester-IP)`, keeping a much looser per-address
  counter for alerting/audit only; and/or
- once an address is under a lock, still accept a proof from an origin with a clean per-IP record,
  after a delay (a fixed 2–5 s sleep costs an attacker nothing they aren't already paying and
  costs the real owner one page-load).

`admin_audit_log` already records every `owner_proof:*:deny`
([owner-proof.js:422–430](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L422)),
so the operator-visible signal for a targeted lockout campaign already exists — nothing surfaces
it yet. Worth an AlertMonitor rule alongside the fix.

---

### J3-4 — [Medium] Two accepted shares evict both slots of a victim's last-2 proof window, and a miner who has stopped mining can never restore it — **FIXED 2026-08-26 (see §J3 resolution pass)**

**Threat actor: rig holder.**

The last-2 window exists so that *"an ISP re-lease or a rig-side password change never locks the
owner out"* ([owner-proof.js:34–35](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L34)).
It is also only two slots deep, and — per J3-1 — a stranger can write to it. `recordOwnerEvidence`
rotates `last → prev` on every changed value
([:278–281](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L278),
[:296–299](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L296)), so two attacker
sessions with different IPs and different passwords fill both slots and the owner's evidence is
gone.

Harness (steps 3–4 — one attacker session leaves the victim working; the second does not):

```
== 3. victim still works after ONE attacker session (last-2 window) ==
victim IP still verifies                     true

== 4. a SECOND attacker session evicts the victim entirely ==
victim IP after 2 attacker sessions          {"ok":false,"reason":"no_match"}
victim password after 2 attacker sessions    {"ok":false,"reason":"no_match"}
```

**Failure scenario.** A miner leaves the pool — sells the rig, switches pools, or simply finishes a
run — with a balance below `min_withdrawal` that later matures over the line, or with a balance
they intend to withdraw next month. Two shares from any rig, at any point afterwards, permanently
remove their ability to prove ownership: they cannot re-capture without mining again, which is
exactly the thing they have stopped doing. `verifyOwnerProof` returns `no_match` rather than
`no_recorded_proof`, so nothing on the account page tells them what happened — it looks like they
mistyped.

Severity is Medium rather than High only because an **active** miner self-heals on their next
accepted share. That is also why it is a separate finding from J3-1 and not a note under it: a fix
that stops a *fresh* proof being trusted (J3-1 option 1) does not stop it being *written*, and so
does not stop the eviction.

**Fix (not applied).** Do not let a new value displace a stored one when the account has a balance
and the new value's session has not sustained mining — the same pending-slot mechanism as J3-1
option 2 closes both. A cheaper partial: keep the owner's *oldest* proof pinned in a third slot
that only a successful verify from that same value can refresh.

---

### J3-5 — [High] `donate100` on an unauthenticated stratum login diverts up to 100% of another miner's future earnings, and the account API never shows it — **FIXED 2026-08-26 (see §J3 resolution pass)**

**Threat actor: anonymous.**

`handleLogin` writes a persistent, money-affecting per-address setting **before any proof of work
and before a session even exists**:

```js
if (parsed.donation_percent !== null && parsed.donation_percent !== undefined) {
  try {
    this.incentives.setDonation(parsed.grin_address, parsed.donation_percent);
```
— [lib/stratum-server.js:470–472](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L470)

Ten lines below it, the file states the rule this breaks:

> *"the miner's source IP / password are deliberately NOT recorded here. Stratum login is
> unauthenticated (the address IS the username), so recording at login let anyone with a TCP socket
> log in under a victim's address and poison its ownership-proof windows … Both are recorded on
> the session's first ACCEPTED share instead — evidence requires actual PoW."*
> — [lib/stratum-server.js:462–466](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L462)

The donation write sits *above* that comment and did not get the same treatment. `setDonation`
([lib/incentives.js:164–177](../../web/07_mining_pool_public/back-end-pool/lib/incentives.js#L164))
clamps to 0–100 and refuses the two reserved addresses, then upserts. `applyToDistribution` spends
it at every block:

```js
const pct = this.donationPercent(address);
if (pct > 0) {
  const donated = gross * (pct / 100);
  ...
  this._move(address, -donated, 'debit', 'donation', blockHeight);
  this.creditPrizePool(donated, 'donation', blockHeight);
```
— [lib/incentives.js:211–221](../../web/07_mining_pool_public/back-end-pool/lib/incentives.js#L211)

**This one is live on a default pool.** `incentives_enabled: 'true'` and
`allow_miner_donations: 'true'` are both defaults
([lib/pool-settings.js:550, :554](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L550)),
unlike the Goblin rail in J3-1.

**Failure scenario.** One TCP connect and one `login` frame — `{"login":"<victim>.x-donate100"}`,
no share, no password, immediately disconnect — and 100% of that address's every future PPLNS
credit is redirected to the prize pool. It is **persistent and not self-healing**: the victim's own
logins call `setDonation` only when their worker name carries a `donateN` tag
([stratum-server.js:470](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L470)),
which for a normal rig it never does, so a normal login does not clear it. It is also
**irreversible** — the prize pool drains through lotteries, streak top-ups and join bonuses to
other people; there is no clawback path back to the victim.

**And the account API — this session's scope — is where the victim should have found out.**
`GET /api/account/:addr` returns 25 fields including `dormancy`, `payouts_frozen` and
`password_proof` diagnostics ([index.js:3011–3062](../../web/07_mining_pool_public/back-end-pool/index.js#L3011))
and **does not return `donation_percent`**. The only public surface carrying it is
`GET /api/pool/donors`, which is a **Top-100 wall**
([index.js:3155–3161](../../web/07_mining_pool_public/back-end-pool/index.js#L3155)) — a victim
appears there only once enough of their money has already been taken to rank. So the pool debits a
miner's earnings on the basis of a setting the miner has no way to read and did not make.

**Scope note.** The write lives in `stratum-server.js` (§J6) and `incentives.js`, outside this
session's file list. It is reported here in full rather than as a handoff because it is the exact
question §J3 was given — *can miner A act on miner B's balance?* — and because the corrective half
that **is** in scope (the account summary must expose `donation_percent`) would otherwise be
written up with no cause attached. §J6 owns the stratum-side fix.

**Fix (not applied).** Three parts, in order of value:

1. **Move the `setDonation` call to the first accepted share**, beside `recordOwnerEvidence`
   ([stratum-server.js:599](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L599)),
   and gate it on `session.ipRecorded` the same way. This makes the comment at :462–466 true of the
   whole login handler instead of two-thirds of it. It does **not** fully close the hole (a rig
   holder can still set it, per J3-1) but it removes the anonymous no-hardware path.
2. **Add `donation_percent` to `GET /api/account/:addr`** so the account page can show it. In
   scope for this session; smallest change here.
3. Consider requiring `donateN` to be *confirmed* — an ownership-gated `POST /api/account/:addr/donation`
   — with the worker-name tag kept only as a convenience that arms a pending value. That is a
   design decision, not an audit call.

---

### J3-6 — [Low] The failed-proof throttle Map has no expiry sweeper and no size cap — **FIXED 2026-08-26 (see §J3 resolution pass)**

**Threat actor: anonymous.**

`_fails` grows one entry per failing address and one per failing source IP
([owner-proof.js:233](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L233)).
Entries are created in `_throttleState` and removed **only** by `_clearFails` on a successful
verify ([:256–258](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L256)). There
is no periodic sweep, no `TOR_PROBE_MAX`-style ceiling, and no eviction: `_throttleState` merely
*resets* a stale entry when that same key is touched again
([:238–241](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L238)), which never
happens for a key the attacker abandons. Compare the tor-probe cache one file over, which was
explicitly bounded for this reason in §H3 — *"this is a cache, not a registry"*
([index.js:3581](../../web/07_mining_pool_public/back-end-pool/index.js#L3581)).

Growth is genuinely slow, and the reason is worth recording so nobody re-rates this: the per-IP
lockout returns at :326 **before** `failBoth()` runs, so once an origin is locked it stops
creating new address keys. One source IP therefore adds roughly 20 keys per 10-minute window —
order of 10³ keys and a few hundred KB per day. It needs a large distributed effort to matter, and
a restart clears it.

**Fix (not applied).** A single `setInterval` sweep dropping entries whose `first` is older than
`FAIL_WINDOW_MS` and whose `lockedUntil` has passed, plus a hard size ceiling with
oldest-first eviction — the shape already used at
[index.js:3596–3606](../../web/07_mining_pool_public/back-end-pool/index.js#L3596). Never evict an
entry that is *currently* locked out, or eviction becomes the throttle bypass.

---

### J3-7 — [Low] `?direction=` resolves through `Object.prototype`, splicing a native function's source into the ledger `WHERE` clause — **FIXED 2026-08-26 (see §J3 resolution pass)**

**Threat actor: anonymous.**

```js
const direction = LEDGER_DIRECTION_SQL[req.query.direction] ? req.query.direction : null;
...
const where = `grin_address = ? AND created_at >= ?` +
  (direction ? ` AND ${LEDGER_DIRECTION_SQL[direction]}` : '');
```
— [index.js:3432–3436](../../web/07_mining_pool_public/back-end-pool/index.js#L3432)

`LEDGER_DIRECTION_SQL` is an object literal
([:3425](../../web/07_mining_pool_public/back-end-pool/index.js#L3425)), so the membership test
walks the prototype chain. Harness (step 7, replaying the two-key map against the same expression):

```
  ?direction=in                -> AND (event_type='credit')
  ?direction=constructor       -> AND function Object() { [native code] }
  ?direction=toString          -> AND function toString() { [native code] }
  ?direction=hasOwnProperty    -> AND function hasOwnProperty() { [native code] }
  ?direction=nope              -> (ignored)
```

**This is not injection today** and should not be written up as one: the interpolated text is a
built-in function's source, which the attacker cannot influence, and SQLite rejects it — the route
returns `500 {"error":"near \"function\": syntax error"}` from
[:3475](../../web/07_mining_pool_public/back-end-pool/index.js#L3475). What it is: a free 500 that
leaks a fragment of the query text, on a route reachable by anyone, and a **dynamic SQL fragment
selected by an unguarded object index** — one prototype-polluting path elsewhere in the process
away from being the real thing. It is the same shape as J1-6 (`POST /api/admin/settings/constructor`)
and it is worth fixing as a pair.

The correct pattern is already in this file, 1,200 lines earlier:

```js
const allowed = ['week', 'month', 'year', 'all'];
const range = allowed.includes(req.query.range) ? req.query.range : 'month';
```
— [index.js:3218–3219](../../web/07_mining_pool_public/back-end-pool/index.js#L3218)

**Fix (not applied, one line):** `Object.hasOwn(LEDGER_DIRECTION_SQL, req.query.direction)`, or
build the map with `Object.create(null)`. Note `LEDGER_DIRECTION_SQL.out` is also read directly at
[:3561](../../web/07_mining_pool_public/back-end-pool/index.js#L3561) by `/earnings` — that call
site is a literal property access and is unaffected.

---

### J3-8 — [Low] The two CSV routes put an unvalidated `:addr` into a response header and skip the account-existence check their siblings have — **FIXED 2026-08-26 (see §J3 resolution pass)**

**Threat actor: anonymous.**

```js
res.setHeader('Content-Disposition',
  `attachment; filename="pool-ledger-${tag}-${addr.slice(0, 12)}-${...}.csv"`);
```
— [index.js:3461–3462](../../web/07_mining_pool_public/back-end-pool/index.js#L3461), and the same
shape at [:3514–3515](../../web/07_mining_pool_public/back-end-pool/index.js#L3514).

`addr` is `req.params.addr` with no shape validation anywhere on either route, and — unlike
`GET /api/account/:addr` ([:2972](../../web/07_mining_pool_public/back-end-pool/index.js#L2972)) and
`tor-check` ([:3626](../../web/07_mining_pool_public/back-end-pool/index.js#L3626), the §H3 fix) —
neither route checks that the address exists before doing work.

Verified bounds with a one-shot against Node 24's own header validator:

```
CRLF  : THROWS ERR_INVALID_CHAR
quote : ACCEPTED -> attachment; filename="a";x="-all.csv"
```

So header/response splitting is **not** possible (Node rejects CR/LF, and the route would 500),
but a `"` inside the first 12 characters does break out of the quoted `filename` and append a
parameter. Twelve characters is too few to fit a competing `filename=`, the `Content-Type` stays
`text/csv`, and the victim would have to follow the attacker's own link — so the practical ceiling
is close to zero. It is reported because it is unvalidated request data reaching a response header
in a money-adjacent route, which is a property worth not having, and because the missing existence
check is a §H3 lesson that did not propagate to the two siblings.

**Fix (not applied):** validate `:addr` against `/^t?grin1[ac-hj-np-z02-9]{58}$/` once, in a
shared handler for the whole `/api/account/:addr` family — the regex already exists at
[index.js:6039](../../web/07_mining_pool_public/back-end-pool/index.js#L6039) for the admin award
route. That single change also removes the sanitising burden from every current and future route
in the block.

---

### J3-9 — [Info] §H3's `tor-check` fix re-verified: no exploitable timing oracle remains

**Threat actor: anonymous.** The plan asked specifically whether the §H3 fix left a timing oracle.
Re-read in full:

- The account-existence check runs **before** the probe and returns the same 404 shape as
  `GET /api/account/:addr` ([index.js:3626–3627](../../web/07_mining_pool_public/back-end-pool/index.js#L3626)) —
  so the arbitrary-address oracle is genuinely closed, not merely rate-limited.
- The cache is bounded at 500 with expired-first eviction then oldest-insert eviction
  ([:3596–3606](../../web/07_mining_pool_public/back-end-pool/index.js#L3596)), and the in-flight
  map is cleaned in a `finally` ([:3610–3612](../../web/07_mining_pool_public/back-end-pool/index.js#L3610)),
  so the "parked rejected promise" failure the §H3 note warned about cannot occur.
- The cache key is `req.params.addr`, and because only one spelling of an address can exist as a
  row (see *Verified correct*), the key is canonical — there is no second spelling that would miss
  the cache and re-amplify.

**Residual, stated so the question is closed rather than left open:** a cache **hit** answers in
microseconds and a miss takes a Tor circuit build, so an attacker on the `torcheck` bucket
(10/min) can learn whether a given address was probed in the last 60 s — in practice, whether that
miner just opened the payout page. It is a low-rate presence signal about an imminent withdrawal,
not a wallet-uptime oracle, and removing it would mean removing the cache that §H3 added.
*(Superseded 2026-09-23: the page no longer probes on load, so a cache hit now means the miner
pressed Check, not that they opened the page. `?fresh=1` lets any caller force a re-probe once the
cached answer is 10 s old, where the cache used to hold it for 60 s. The existence check, the
bucket and the dedup are unchanged. Whether the shorter floor matters is open; see the Status
roll-up.)* **No
action recommended.**

---

## §J4 — Payout execution (2026-08-26, add-ons, NOT VPS-TESTED)

### J4-1 — [Critical] `reclaimStaleFinalizing` treats an output lock as proof of broadcast, so every stale claim confirms — a node outage during `post_tx` silently confiscates the miner's payout — **FIXED 2026-08-27 (see §J4 resolution pass)**

**Threat actor: the system.** No attacker, no miner action, no admin.

§H2 added `finalizing` as a claim held across the three wallet calls of a finalize, and
`reclaimStaleFinalizing` to resolve a claim whose owner died. Its doctrine is explicit and correct:

> *"it must not be blindly reverted either: if postTx already ran, reverting refunds a miner who was
> paid. So ask the wallet which it was… found as a live TxSent → it posted → confirm"*
> ([withdrawal-scheduler.js:1372–1385](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L1372))

The test it actually performs is:

```js
const live = new Set(
  txs.filter((t) => t && t.tx_slate_id && String(t.tx_type) === 'TxSent')
     .map((t) => String(t.tx_slate_id)));            // :1418–1421
...
if (w.slate_id && live.has(String(w.slate_id))) {    // :1425
  this._creditConfirm(w.id, 'finalizing', 'recovered: broadcast confirmed from wallet tx log');
```

By the premise above, that set contains **every slate this pool has ever issued and not cancelled**,
from the moment `createSlatepackWithdrawal` locked its outputs. So `live.has(slate_id)` is true for
every stale row that has a `slate_id` — which is every row that got past creation. The
`else if (w.slate_id)` branch that returns a row to `slatepack_pending` is **unreachable in
production**; the sweep does not resolve an ambiguity, it always answers "paid".

`_creditConfirm` then flips the row to `confirmed`, releases `balance_locked`, writes the
`withdrawal` debit and credits the flat fee to `pool_fee`. The miner's money is gone from the
ledger and no transaction exists.

**Why this is not a rare crash case.** The pool *routes* the ambiguous outcome here on purpose.
When `post_tx` throws — node down, tx rejected, mempool refusal — both finalize paths deliberately
leave the row claimed:

> *"postTx threw … outcome UNKNOWN, left claimed for the stale-finalize sweep to resolve"*
> ([:866–869](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L866),
> [:1021–1024](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L1021))

Ten minutes later the sweep resolves it as *paid*. A node restart during payouts is enough. It also
runs **while payouts are frozen** ([:82–87](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L82)) —
justified as "only resolves rows to the truth already on-chain", which is exactly the claim that
does not hold — so an operator who hit the emergency stop is still losing miners' balances.

**Why nothing catches it.** Reconciliation's coverage goes *up* (the wallet holds coins the ledger
no longer owes), and only a shortfall alarms. `auditWalletSends` looks the other way — wallet sends
with no pool row — so it sees nothing. The single visible symptom is a payout that is `confirmed`
but whose `kernel_excess` never arrives, because `backfillKernelProofs` can only match a tx that
mined ([:537](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L537)).
That is a blank column on the account page's Proof link.

**Harness — T1, real `reclaimStaleFinalizing`, stale claim, `TxSent`/`confirmed:false`:**

```
[finalize] stale claim 1: slate S1 DID post — confirming
  PASS  row is CONFIRMED even though nothing was broadcast          status=confirmed
  PASS  lock released + miner debited (ledger says paid)            balance=0 locked=0
  PASS  a 'withdrawal' debit row was written
  PASS  control: a cancelled tx DOES re-open the row                status=slatepack_pending
```

The control matters: the `TxSentCancelled` case still works, so the branch is live and the test is
not rigged — it is only the discriminator that is wrong.

**Recommended fix (structural — left for a decision, plan rule 3).** Make the sweep three-state, as
its own doctrine already demands:

- `TxSent && e.confirmed` (or `kernel_excess` present) → confirm. Unambiguous.
- `TxSentCancelled`, or slate absent from the log → release the claim. Unambiguous.
- `TxSent && !e.confirmed` → **UNKNOWN**: leave the claim standing and re-ask next tick, the same
  branch already used for "wallet unreachable". A genuinely broadcast tx becomes `confirmed` within
  minutes; one that was never posted stays claimed.

That third case needs an operator surface, which is why it is not a one-liner: a row can now sit in
`finalizing` indefinitely, so it needs an age escalation (an alert + a Payments-page action) rather
than an automatic decision. That is the correct trade — the module's own words, *"a stalled payout
is recoverable while a double-pay is not"* ([:1383](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L1383)) —
and it applies just as forcefully to a wrongly-debited one.

---

### J4-2 — [High] The admin *Retry* button zeroes `retry_count`, which is the only trigger for the §H1 double-send guard — so it re-sends, unguarded, exactly the payouts most likely to have already landed — **FIXED 2026-08-27 (see §J4 resolution pass)**

**Threat actor: the system, via an honest logged-in admin.**

§H1's guard is armed by one condition:

```js
if (withdrawal.retry_count > 0 || withdrawal.slate_id) {   // :360
  const prior = await this._priorSendLanded(withdrawal, netSend);
```

`POST /api/admin/withdrawals/:id/retry` on a `tor_failed` row re-locks the balance and writes:

```js
db.prepare('UPDATE withdrawals SET status = ?, retry_count = 0, next_retry_at = NULL WHERE id = ?')
  .run('tor_checking', id);                                 // index.js:2373
```

A `tor_failed` row is one that exhausted the whole ladder — four Tor sends, each `SIGKILL`ed at
`wallet_send_timeout_ms` if it hung. That is the precise population §H1 was written for: *"a kill at
120 s does not mean the tx failed to post."* And a Tor row that never reported success never had a
`slate_id` captured — `_captureTorSlateId` runs only after `sendResult.success`
([:386–388](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L386)). So
after the admin retry, **both** arms of the guard condition are false, and the scheduler sends
again without ever asking the wallet.

The reset is not gratuitous — it is there to give the row a fresh retry ladder. It just happens to
erase the one field the double-send guard reads.

**Harness — T2, two rows identical but for `retry_count`, same wallet log containing a `TxSent`
whose net matches this payout:**

```
  PASS  wallet tx log never consulted before the send                getTransactions calls before send = 0
  PASS  a second Tor send WAS issued for an amount already paid      sends=99.96
⚠️  Withdrawal 1: an earlier attempt DID post (slate S9) — confirming instead of re-sending
  PASS  control: identical row with retry_count=1 — the guard runs and blocks the re-send
```

**Recommended fix (small, but on the money path — left with J4-1 for one decision).** Arm the guard
on the payout's history rather than on a mutable counter: `sendWithdrawal` should call
`_priorSendLanded` whenever the row has **any** prior `to_status='tor_sending'` event, which no
admin action erases. Keep the ladder reset if the operator wants it; just stop it from doubling as
a guard switch. (`retry_count = 0` should also carry a comment saying what it disarms, or the next
person re-adds it.)

---

### J4-4 — [Medium] `_priorSendLanded` skips its time filter when the tx log carries no parseable `creation_ts`, so any historical same-amount send is accepted as this payout — **FIXED 2026-08-27 (see §J4 resolution pass)**

**Threat actor: the system.**

The non-`slate_id` branch of the double-send guard matches on amount, bounded by time:

```js
const when = this._txCreatedAt(t);
if (when !== null && when < createdAt - 60) return false;   // :454
```

`_txCreatedAt` returns `null` when `creation_ts` is absent or unparseable
([:470–476](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L470)), and
the comment calls that *"no opinion"*. But the guard's own header states the failure that matters:
*"Matching is deliberately narrow, because a false POSITIVE marks a miner paid who was not."*
Treating "no opinion" as "no objection" removes the only bound on age, so **every** `TxSent` in the
wallet's whole history whose net matches becomes a candidate — and a pool paying round amounts or
full balances will have those. §H already flagged this shape as unverified: *"confirm a real
`retrieve_txs` response carries `creation_ts`… before leaning on it."* Until that is checked on a
VPS, the fallback is fail-**unsafe**.

**Harness — T2b, the same year-old transaction with and without its timestamp:**

```
  PASS  control: a dated old tx is correctly rejected as a match     sends=1
⚠️  Withdrawal 1: an earlier attempt DID post (slate OLD) — confirming instead of re-sending
  PASS  the SAME old tx with no timestamp is accepted as this payout — miner marked paid, never sent
        sends=0 status=confirmed slate=OLD
```

**Recommended fix.** An unparseable timestamp is a *missing observation*, so it belongs in the
branch the method already has for one: return `{ checked: false, tx: null }` with the loud log at
[:373–377](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L373) rather
than silently confirming. Fold this in with J4-1's `.confirmed` change — same method family, same
VPS check (`retrieve_txs`'s real `TxLogEntry` shape) closes both.

---

### J4-6 — [Low] A non-numeric `withdrawal_cooldown_minutes` silently switched the cross-rail reversal cooldown off — **FIXED 2026-08-26**

**Threat actor: the operator (misconfiguration).** Carried over as a handoff from §J3.

```js
const cooldown = (mins === undefined || mins === null ? 30 : mins) * 60;
if (!cooldown) return;
```

`0` disabling the cooldown is documented and intended. `NaN` disabling it was not: `'thirty' * 60`
is `NaN`, `!NaN` is `true`, and the method returned before reading `balance_log` — with no log line.
Same family as memory `project_config_loader_type_traps`.

Reachability is narrow and that is why it is Low: the settings validator rejects a non-number
([pool-settings.js:826–829](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L826))
and `applyToConfig` passes the validated value straight through
([:1473](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1473)), so the admin
panel cannot produce it. A hand-edited `pool.json` can — `config.js:73` reads the raw key with no
coercion. That is an on-box operator, not an attacker; the finding is that a money guard turned
itself off without saying so.

**Fixed** at [withdrawal-scheduler.js:183–201](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L183):
a non-finite or negative value falls back to the 30 min default and logs once, naming the offending
value and pointing at `0` as the supported way to disable. `Number('')` is `0`, so an empty string
keeps its old meaning — the change is confined to values that were never a number.

**Harness — T4, post-fix:**

```
  PASS  control: a numeric 30 blocks the request                                    code=429
[payout] withdrawal_cooldown_minutes is not a number ("thirty") — using the 30 min default…
  PASS  POST-FIX: a non-numeric value falls back to 30 and warns                    code=429
  PASS  POST-FIX: an explicit 0 still disables the cooldown                         code=null
  PASS  POST-FIX: an absent key still defaults to 30                                code=429
```

---

### J4-7 — [Low] The Tor pre-flight gate fails **silent**, not merely open — an operator who switched it on cannot tell it has been inert — **FIXED 2026-08-26**

**Threat actor: the operator (undetected misconfiguration).**

Fail-open on `online: null` is correct and must stay (memory `project_pool_tor_preflight_gate`: *"a
pool box without a working probe NEVER bricks Tor"*). The problem was that nothing said so.
`probeToronlineStatus` returns `{ online: null, reason: 'socks_unavailable' | 'tor_unavailable' |
'derivation_failed' }` without logging
([wallet-tor.js:150–170](../../web/07_mining_pool_public/back-end-pool/lib/wallet-tor.js#L150)), and
the withdraw route swallowed even a thrown probe:

```js
try { reach = await walletTor.probeToronlineStatus(addr); } catch (_) { reach = { online: null }; }
```

A dead tor daemon, or the optional `socks` dependency never installed, therefore disables the gate
permanently and invisibly — the admin checkbox stays ticked, the miner sees no message, the log says
nothing. The operator learns from the retry/refund cycles the gate exists to prevent.

**Fixed** at [index.js:3750–3763](../../web/07_mining_pool_public/back-end-pool/index.js#L3750): the
`catch` now keeps the error text as the reason, and any `online === null` outcome emits one warn
line naming the reason and stating that the send is being allowed. Behaviour is unchanged — still
fail-open, still no block, still `grin-wallet` as the authority at send.

> **Superseded 2026-09-23 (payout-rails fix, impl §10.5):** the probe no longer uses the `socks` lib,
> so `socks_unavailable` is gone. The null reasons are now `tor_unavailable`, `derivation_failed`
> and `probe_failed`. This finding assumed that a *slow* tor produced `null`, but it did not. The
> old probe scored a proxy timeout (`'Proxy connection timed out'`) as a confident `false`, so the
> gate **blocked** instead of failing open, and the new warning never fired for that case. A
> timeout with no reply from the local proxy is now `null`. The fix above is unchanged.

---

## §J5 — Reward & orphan ledger (2026-08-27, add-ons, NOT VPS-TESTED)

### J5-1 — [Critical] `blocks.nonce` is an `INTEGER` column and a Grin nonce is a full-width `u64`, so reading back a found block throws — one block in two permanently stops all maturity, distribution and orphan detection — **FIXED 2026-08-27 (see §J5 resolution pass)**

**Threat actor: the system** (and, if anyone wants it sooner, the block-finding miner, who picks
the value).

The nonce is carried through the pool **as a decimal string**, deliberately.
[stratum-protocol.js:13–20](../../web/07_mining_pool_public/back-end-pool/lib/stratum-protocol.js#L13)
re-extracts the literal digits out of the raw JSON with a regex, with a comment explaining exactly
why: `JSON.parse` rounds integers past 2^53 and the node then rejects the share. That string
reaches [`creditBlock`](../../web/07_mining_pool_public/back-end-pool/lib/blocks.js#L47) unchanged
([stratum-server.js:659](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L659))
and is bound into a column declared
[`nonce INTEGER NOT NULL`](../../web/07_mining_pool_public/back-end-pool/lib/db.js#L345).

SQLite applies INTEGER affinity to the string. What that does depends on magnitude, and there are
three outcomes, none of them "stores the nonce":

```
$ node -e "…INSERT the string into an INTEGER column, then read typeof(nonce)…"
{ id: 1, ty: 'integer', astext: '4611686018427387904'  }   # 2^62      → INTEGER, exact
{ id: 2, ty: 'real',    astext: '9.22337203685478e+18' }   # 2^63      → REAL, precision GONE
{ id: 3, ty: 'integer', astext: '1234567'              }   # small     → INTEGER, exact
```

The pool does not use better-sqlite3. `package.json` lists no such dependency and
[`lib/sqlite-compat.js:24`](../../web/07_mining_pool_public/back-end-pool/lib/sqlite-compat.js#L24)
wraps Node's built-in `node:sqlite` `DatabaseSync` ("migrated off better-sqlite3", `engines.node
>= 24`). `node:sqlite` does **not** silently round an out-of-range INTEGER on read the way
better-sqlite3 does — it throws:

```
$ node -e "…SELECT * FROM blocks WHERE status='immature'…"
SWEEP THROWS -> ERR_OUT_OF_RANGE Value is too large to be represented as a JavaScript number: 4611686018427387904
```

`readBigInts` is not set anywhere in the codebase (`grep` over `lib/` + `index.js` returns only an
unrelated `BigInt` in `lottery.js`), so every read of that column goes through the throwing path.

**What that takes down.** Every one of these does `SELECT *` (or names `nonce`) on `blocks`, so
each throws for the whole result set — one poisoned row kills the query, not just its own row:

| Call site | Effect |
|---|---|
| [block-monitor.js:78](../../web/07_mining_pool_public/back-end-pool/lib/block-monitor.js#L78) `checkImmatureBlocks` | caught at `:119` → `maturity sweep aborted` **every 30 s, forever**. No block ever reaches `confirmed` |
| [orphan-detector.js:60](../../web/07_mining_pool_public/back-end-pool/lib/orphan-detector.js#L60) `detectOrphans` | returns `aborted:true` on every 6 h pass |
| [rewards.js:20](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L20) `distributeRewards` | `success:false` for any block it is asked to settle |
| [blocks.js:83, 93, 104, 142, 154, 166, 318](../../web/07_mining_pool_public/back-end-pool/lib/blocks.js#L83) | `getBlock`, `getBlockByHeight`, `getRecentBlocks`, `getImmatureBlocks`, `getBlocksByStatus`, `getBlocksMintedByMiner`, `getLastBlock` — all swallow it and return `null`/`[]` |
| [index.js:2815](../../web/07_mining_pool_public/back-end-pool/index.js#L2815) `GET /api/admin/blocks` | selects `nonce` explicitly → **HTTP 500**, so the operator's blocks page goes blank at the same moment |
| [blocks.js:50](../../web/07_mining_pool_public/back-end-pool/lib/blocks.js#L50) `creditBlock` → `getLastBlock()` | swallowed → `round_shares` silently mis-captured for every subsequent block, so the luck chart is wrong too |

**The odds, from source in this workspace.** grin-miner draws a fresh full-width random nonce per
attempt — `grin-miner`'s `cuckoo-miner/src/miner/util.rs:40` (read from the sibling checkout in this workspace):
`let nonce: u64 = rand::OsRng::new().unwrap().gen();`. For a uniform `u64`:

- `< 2^53` → INTEGER, exact, harmless: **p = 2⁻¹¹ ≈ 0.049 %**
- `[2^53, 2^63)` → INTEGER, **read throws**: **p ≈ 49.95 %**
- `≥ 2^63` → REAL, read succeeds but the stored value is a rounded double: **p = 50 %**

So the expected number of blocks the pool survives is **two**. The 50 % REAL branch is not a
reprieve either — it only *appears* to work, and for a bad reason (see J5-3).

**Why no test caught it.** [`scripts/test-money-path.js:63`](../../web/07_mining_pool_public/back-end-pool/scripts/test-money-path.js#L63)
uses `const NONCE = 12345`. Every §I regression test, and the whole 30-assertion money-path suite,
runs on a five-digit nonce — a value in the 0.049 % band that is the only one this schema can hold.
The suite is green on a schema that cannot store a real Grin nonce.

**Fix (not applied — structural, and it forces the J5-3 decision with it).** Three coupled pieces,
and the order matters:

1. `blocks.nonce` becomes `TEXT NOT NULL` and `creditBlock` binds `String(nonce)`. There is no
   production DB to migrate — the pool has never run on a VPS — so this is a schema edit plus a
   `DROP`/recreate note for any testnet DB, not a migration.
2. **Before** step 1 ships, fix the comparators (J5-3). Storing the nonce *correctly* is exactly
   what makes both existing comparisons fail, and the failure direction is `orphan + reverse`.
3. Add a real u64 to the money-path fixtures. `scripts/test-block-ledger.js` §[2] already pins the
   current broken behaviour with a `KNOWN OPEN` assertion — when the schema is fixed that
   assertion fails, which is the intended signal to update it.

**Mainnet must not start before this is closed.** It is not a degradation; the pool mines, credits
nobody, and reports itself healthy.

---

### J5-2 — [High] A JSON-RPC *envelope* error is classified as a statement about the chain, so `Method not found` orphans a live block and reverses its payouts — **FIXED 2026-08-27**

**Threat actor: operator (honest) — a misconfigured or version-skewed node URL.** Not remotely
triggerable, but the consequence is money moving backwards.

Memory `project_pool_node_error_classification` states the rule this session was asked to check
against: *classify by ORIGIN, never by a message string*. The uncommitted diff implements it
properly for the transport layer — `transportFailure()` vs `nodeReplyFailure()`, and
[orphan-detector.js:40](../../web/07_mining_pool_public/back-end-pool/lib/orphan-detector.js#L40)
now gates on `err.nodeReplied === true && err.notFound === true` instead of
`err.message.includes('height')`. That part is correct and re-verified.

But `_rpcCall` has **two** node-answered branches, and both were funnelled into the same
constructor:

- [grin-node.js:322](../../web/07_mining_pool_public/back-end-pool/lib/grin-node.js#L322) —
  `data.error`, the JSON-RPC **envelope** error. `-32601 Method not found`, `-32602 Invalid params`,
  a parse error. This describes the *call*, not the chain.
- `data.result.Err` — the Grin handler's own `Result::Err`. This one genuinely is a statement about
  the chain.

`notFound` was derived by substring-matching the payload in both cases. `{"code":-32601,"message":
"Method not found"}` contains `not found`. Demonstrated against the real `GrinNodeAPI` +
`OrphanDetector` with a stubbed `node-fetch`:

```
node Err NotFound (a real chain statement)
   -> nodeReplied=true notFound=true   ==> verifyBlockOnChain: ORPHAN + REVERSE PAYOUTS
JSON-RPC envelope: Method not found (-32601)
   -> nodeReplied=true notFound=true   ==> verifyBlockOnChain: ORPHAN + REVERSE PAYOUTS   ← wrong
JSON-RPC envelope: Invalid params
   -> nodeReplied=true notFound=false  ==> rethrow (block stays immature)
```

This is not hypothetical: CLAUDE.md already records that a grin node answers **`Method not
found`** for a method the endpoint does not carry (`get_tip` on the Owner API). `get_header` is a
**Foreign** method. Any deployment where `node_api_url` resolves `/v2/foreign` to something other
than the Foreign handler — an nginx rewrite, a satellite gateway misroute, a future grin that moves
the method — makes *every* `getHeader` return `-32601`, and the maturity sweep then orphans every
block past confirm depth and calls `reverseBlockPayouts` on each. The same shape as the original
bug, one layer up: the previous version matched our own wrapper message, this one matched the
envelope's.

**Fixed.** `nodeReplyFailure()` takes an explicit `chainStatement` flag
([grin-node.js:37](../../web/07_mining_pool_public/back-end-pool/lib/grin-node.js#L37)). Only
`result.Err` passes `true`; an envelope error sets `notFound = false` unconditionally and carries
`chainStatement:false` so a future caller cannot re-derive it. Regression-tested in
`test-block-ledger.js` §[1], with a CONTROL asserting a genuine `Err: NotFound` still *does*
orphan — an over-broad fix here would be as bad as the bug, since it would stop the pool ever
recognising a real orphan.

---

### J5-3 — [High] The nonce cannot be an exact chain comparator at all — `JSON.parse` has already rounded it — so fixing J5-1 turns both existing checks into a mass-orphan bug — **FIXED 2026-08-27 (see §J5 resolution pass)**

**Threat actor: the system.** This is a fix-ordering hazard, filed as a finding because the obvious
repair for J5-1 detonates it.

Two places compare the pool's stored nonce against the node's, and they disagree with each other:

- [orphan-detector.js:16](../../web/07_mining_pool_public/back-end-pool/lib/orphan-detector.js#L16)
  — `if (header.nonce === blockNonce)`. Strict, no coercion. The `else` branch is
  `orphan + reverseBlockPayouts`.
- [rewards.js:53](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L53) —
  `if (String(nodeHeader.nonce) !== String(block.nonce))`, with a comment noting the node's u64
  "may arrive as a number or a string depending on magnitude". Fails closed (refuses to credit).

Neither survives an exactly-stored nonce, because the loss happens on the **node** side before
either runs. `grin-node.js` reads the reply with `response.json()`, i.e. `JSON.parse`:

```
exact u64 nonce         : 4611686018427387904
after JSON.parse(number): 4611686018427388000   lossless? false
after JSON.parse(string): 4611686018427387904   lossless? true

--- if blocks.nonce were stored EXACTLY (TEXT column) ---
orphan-detector  header.nonce === block.nonce : false   (number vs string)  → ORPHAN
rewards.js       String(a) !== String(b)      : true    (mismatch)          → refuse to credit
```

Both comparisons fail, and the destructive one fails destructively. Note the second row: if grin
serialises the nonce as a JSON **string**, `===` against a stored number is false too. There is no
magnitude at which both sites are simultaneously correct.

Today this is masked by J5-1 and by luck: the `≥ 2^63` half stores a rounded REAL and the node
delivers *the same rounded double*, so the comparison passes on two values that are both wrong —

```
fromDb   = 18446744073709552000  (number)
fromNode = 18446744073709552000  (number)
equal? true    either equals the true nonce 18446744073709551615? false
```

— and the `[2^53, 2^63)` half never reaches a comparison because the read throws first.

**Recommended fix (a decision, not a patch).** Make **`hash` the mandatory comparator and drop the
nonce as a verifier.** The hash is a 64-hex string end to end: grin's stratum answers
`blockfound - <hash>` and the pool takes the tail verbatim
([node-stratum-client.js:148](../../web/07_mining_pool_public/back-end-pool/lib/node-stratum-client.js#L148)),
`blocks.hash` is `TEXT NOT NULL UNIQUE`, and `get_header(h).hash` is the same hex — nothing in that
path passes through a JS number. §I3's resolution deliberately left the hash comparison *optional*
(nonce-only fallback with a warning) because the stratum reply format had never been checked
against a live node; §J17 owes that observation, and it is now the gating item for this finding
rather than a nice-to-have. If the nonce is kept at all, it must be compared as
`Number(a) === Number(b)` — deliberately normalising **both** sides through the same lossy double —
and that must be written down as intentional, because it looks like the bug it is preventing.

**Do not fix J5-1 without fixing this in the same change.**

---

### J5-4 — [Medium] `'paid'` is missing from every block-status count, so the pool publicly reports 0 confirmed blocks and 0 confirmed reward in steady state — **FIXED 2026-08-27**

**Threat actor: none — a correctness defect, read by anonymous internet.**

`rewards.js` flips `confirmed → paid` the instant it distributes
([rewards.js:141](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L141)), so `'paid'`
is the terminal success state and `'confirmed'` is a ~30-second transient. `getPoolStats` counted
only `'confirmed'`:

```sql
SELECT COUNT(*)                FROM blocks WHERE status = 'confirmed'   -- confirmed_blocks
SELECT COALESCE(SUM(reward),0) FROM blocks WHERE status = 'confirmed'   -- confirmed_reward
```
```js
immature_blocks: totalBlocks.count - confirmedBlocks.count
```

In steady state `confirmed_blocks` and `confirmed_reward` are **0**, and `immature_blocks` is every
block the pool has ever found — including the orphaned ones, which the subtraction also folds in.
`getPoolStats` feeds five routes plus
[`poolstats-reporter.js:95`](../../web/07_mining_pool_public/back-end-pool/lib/poolstats-reporter.js#L95),
the external pool-listing publisher — so the pool advertises "0 blocks confirmed, 0 GRIN confirmed"
to third-party listing sites while paying miners normally. The blocks-page doughnut had the same
root: [blocks.js:305](../../web/07_mining_pool_public/back-end-pool/lib/blocks.js#L305) sent every
unrecognised status, `'paid'` included, to the *maturing* bucket.

For a pool asking miners to trust it with custody, "we have confirmed zero blocks" is the worst
possible number to get wrong.

**Fixed.** Both aggregates read `status IN ('confirmed','paid')`; `immature_blocks` is counted
directly rather than by subtraction, so orphans no longer land in it; the doughnut puts `'paid'`
under confirmed. Regression-tested in `test-block-ledger.js` §[4] against a fixture holding one
block of each status.

---

### J5-5 — [Medium] A failed share query is indistinguishable from "no shares", and that branch permanently confiscates the block reward — **FIXED 2026-08-27**

**Threat actor: the system** — a transient DB fault is enough.

`getSharesForDistribution` swallowed every exception and returned `[]`:

```js
} catch (err) {
  console.error(`Error fetching shares for distribution: ${err.message}`);
  return [];          // ← indistinguishable from an empty window
}
```

The caller reads `[]` as a settled fact
([rewards.js:94–111](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L94)): it
CAS-flips the block to `'paid'`, credits nobody, and returns `reason:'no_shares_found'`. The block
is now terminal — `distributeConfirmedBlocks` only selects `'confirmed'`, so **nothing ever retries
it** and the whole 60 GRIN stays in the pool wallet with no ledger entry against it.

The trigger does not need an attacker. `SQLITE_BUSY`, `SQLITE_FULL` (a full disk on a VPS, with the
`ORDER BY created_at` spilling to a temp b-tree), `SQLITE_IOERR`, or a corrupt index all arrive as
a throw from `.all()`. §I9 fixed the *retention* route to this same outcome (shares aged out from
under a stalled block); this is the same terminal branch reached by a transient fault instead, and
the direction is identical — reward retained, miners never credited.

Note the DB has no `busy_timeout` pragma
([db.js:16–17](../../web/07_mining_pool_public/back-end-pool/lib/db.js#L16) sets `journal_mode` and
`foreign_keys` only), so SQLite's default of 0 means any contention surfaces immediately as
`SQLITE_BUSY` rather than waiting. That is J7's to rule on (handoff below).

**Fixed.** The catch rethrows. The throw lands in `distributeRewards`' outer catch, which returns
`success:false` and leaves the row `'confirmed'` for the next 30 s tick — delayed, never wrong, the
same principle §I3's resolution adopted for an unreachable node. Regression-tested in
`test-block-ledger.js` §[5], including a **CONTROL** proving a genuinely empty share window still
settles the block as before.

---

### J5-6 — [Medium] The block status flip is not a claim: a swallowed `UPDATE` leaves the row replayable, and the reversal has no idempotency guard its own sibling has — **FIXED 2026-08-27**

**Threat actor: the system.**

`confirmBlock` and `orphanBlock` were bare `UPDATE … WHERE id = ?` with no status predicate, no
`changes` check, and a `catch` that logged and returned nothing. Both callers then moved money
regardless of whether the flip landed:

```js
this.orphanDetector.confirmBlock(block.id);
this.orphanDetector.incentives.payBlockFinderJackpot(block);   // ← runs either way
…
this.orphanDetector.orphanBlock(block.id, verification.reason);
this.orphanDetector.reverseBlockPayouts(block.id);             // ← runs either way
```

If the `UPDATE` fails the row is still `'immature'`, so the next 30 s tick re-selects it and runs
the same branch again. The jackpot is protected by its own `reference_id` check
([incentives.js:308–312](../../web/07_mining_pool_public/back-end-pool/lib/incentives.js#L308)) —
but `reverseBlockPayouts` had **no** such guard, and a reversal row does not cancel out the credit
rows it re-reads, so a second call debits the same amount again, clamping down through the miner's
balance across a couple of ticks. `incentives.reverseJackpot()`, twenty lines away, does exactly
this check; the block reversal simply never got one.

§I4 established the right pattern for this in `rewards.js` — *"The flip goes FIRST inside the
transaction: it is the claim"* — and these two transitions were the ones that never adopted it.

**Fixed.** Both are now CAS on `status = 'immature'`, return a boolean, and both call sites
`continue` when the claim fails ([orphan-detector.js:118–154](../../web/07_mining_pool_public/back-end-pool/lib/orphan-detector.js#L118),
[block-monitor.js:96–112](../../web/07_mining_pool_public/back-end-pool/lib/block-monitor.js#L96)).
`reverseBlockPayouts` gained the same `event_type='reversal' AND reference_id=?` guard as
`reverseJackpot`. Regression-tested in `test-block-ledger.js` §[3]: re-claim refused, second
reversal a no-op.

---

### J5-7 — [Low] A falsy `Ok` fell through both unwrap branches and returned the `{"Ok":…}` wrapper as a result — **FIXED 2026-08-27**

**Threat actor: none — latent.**

The node serialises Rust `Result<T,E>` as `{"Ok":T}` / `{"Err":E}` and the unwrap was a truthiness
test: `if (data && data.result && data.result.Ok) return data.result.Ok;`. A legitimate falsy `T` —
`validate_chain` and `push_transaction` both answer `{"Ok":null}` — matched neither branch and fell
through to `return data.result`, handing the caller the **wrapper object** as a successful result.
Only `validateChain()` is currently exposed to it, so nothing is broken today; it is the kind of
latent unwrap bug CLAUDE.md's "never read `data.result` directly" note exists to prevent.

**Fixed.** `hasOwnProperty` on `'Ok'` / `'Err'` after a `typeof === 'object'` guard
([grin-node.js:328–340](../../web/07_mining_pool_public/back-end-pool/lib/grin-node.js#L328)).
Asserted in `test-block-ledger.js` §[1].

---

### J5-8 — [Medium] Every money detector is aimed at a shortfall, so a totally stalled distribution pipeline — the outcome of J5-1, J5-2 and a long node outage alike — raises nothing — **FIXED 2026-08-27 (see §J5 resolution pass)**

**Threat actor: none — a detection gap**, and the reason J5-1 would have reached mainnet.

The plan asks whether the reconciliation invariants would *detect* the failures in this session,
not merely report a total. Working through them:

| Failure | `integrity_drift` | `coverage_full_gap` | Alerts? |
|---|---|---|---|
| Double credit (§I4's old bug) | 0 — ledger and log both doubled | **negative** | yes, `coverage_shortfall` |
| Credit for a block the chain never carried | 0 | **negative** | yes |
| Under-reversal (clamped clawback, J5-11) | 0 — the row logs the clamped amount | **negative** | yes |
| **Nothing is distributed at all** (J5-1, J5-2, node outage) | 0 | **positive — a surplus** | **no** |

The invariant is ledger-vs-log, so it is blind to all four; coverage carries every one of them —
except the last, where the sign flips. The wallet fills with block rewards while `total_owed` stays
flat, and [alert-monitor.js:182–190](../../web/07_mining_pool_public/back-end-pool/lib/alert-monitor.js#L182)
only fires when `coverage_full_ok === false`. A surplus is the *shape* of a healthy pool, so
nothing anywhere is looking at it.

Nor is anything watching the blocks table for staleness.
[`checkOrphanedBlocks`](../../web/07_mining_pool_public/back-end-pool/lib/alert-monitor.js#L548) is
the **only** blocks query in AlertMonitor and it fires on `status='orphaned'` alone. A block sitting
in `'immature'` at 5,000 confirmations, or parked in `'confirmed'` for a week, is silent. So is
`reconciliation.js`: `immature_blocks` counts `status='immature'` only
([reconciliation.js:136](../../web/07_mining_pool_public/back-end-pool/lib/reconciliation.js#L136)),
which means a block stuck in `'confirmed'` appears in *neither* `immature_blocks` nor `total_owed`
— it vanishes from the statement entirely.

The operational tell for all of these is a `console.error` line and nothing else. §I3's resolution
already accepted "delayed, never unverified" payouts during a node outage as correct behaviour —
which it is — but that decision quietly created a state the pool cannot distinguish from health.

**Recommended (not applied — this is new detector surface, not a local fix).** A `distribution_stalled`
check on the money cadence: alert (warning, no freeze) when any block has been `'immature'` for more
than `confirm_depth × 2` blocks below tip, or `'confirmed'` for more than N minutes; and a
`coverage_surplus` informational threshold so an unexplained wallet excess past the same bounds
`wallet_drain` uses is at least visible. Both belong beside the existing money checks in
`alert-monitor.js`. Flagging to **§J17** as a launch-gate item: on the testnet run, the operator
must be able to tell "no blocks found yet" from "blocks found, none credited" **without reading the
log**.

---

### J5-9 — [Low] `confirm_depth_mainnet` / `confirm_depth_testnet` are dead settings keys — the operator can edit the maturity depth, see it persist, and change nothing — **FIXED 2026-08-27 (see §J5 resolution pass)**

**Threat actor: operator (honest).**

[`admin-panel/settings-payout.html:82–88`](../../web/07_mining_pool_public/back-end-pool/admin-panel/settings-payout.html#L82)
renders *Mainnet Confirm Depth* and *Testnet Confirm Depth* as editable number inputs. They are
declared in the `payout` defaults
([pool-settings.js:172–173](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L172)),
so `updateSection` accepts them, writes them to `pool_config`, and `getSection` reads them back —
the value sticks in the form and the operator has every reason to think it took effect.

`applyToConfig` never copies them
([pool-settings.js:1444–1500](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1444)
maps `pool_fee_percent`, `min_withdrawal`, `withdrawal_fee`, the two pending caps, the cooldown,
the Tor gate and the five Nostr keys — and nothing else). Every consumer therefore keeps reading
`config.confirm_depth_*` from `pool.json`
([block-monitor.js:83](../../web/07_mining_pool_public/back-end-pool/lib/block-monitor.js#L83),
[orphan-detector.js:55](../../web/07_mining_pool_public/back-end-pool/lib/orphan-detector.js#L55),
[retention.js:23](../../web/07_mining_pool_public/back-end-pool/lib/retention.js#L23),
[index.js:2819](../../web/07_mining_pool_public/back-end-pool/index.js#L2819)) — and the installer
never writes those keys into `pool.json` at all (`grep confirm_depth scripts/` → no match), so
`lib/config.js:95–96`'s fallback of **1440 / 100** is the value, permanently.

Same class as **J1-5** (`admin_ip_allowlist`), but on the control that decides when GRIN becomes
spendable. Two things make it worth writing up rather than shrugging at:

1. The current direction is safe — stuck at Grin's real `COINBASE_MATURITY` of 1440 — **because**
   the key is dead. The moment someone wires it up, the safety goes with it.
2. The key has **no validator** (`PoolSettings.validators.payout` has no entry for it), so the
   stored value can be `0`, `-1` or `"soon"`. A `confirm_depth` of 0 credits and pays out a
   coinbase that cannot be spent for another day, which coverage would then report as a liquid
   shortfall and auto-freeze on.

**Fix:** decide one way. Either delete both keys and the two form rows, or add them to
`applyToConfig` **with** a validator clamping mainnet to `>= 1440` (never below consensus) and
testnet to a sane floor — and note that the value is read at startup, so it needs a restart.

---

### J5-10 — [Low] The block reward is the hardcoded constant `60`, so the pool silently keeps every transaction fee in the blocks it finds, and that surplus biases the coverage check — **FIXED 2026-08-27 (see §J5 resolution pass)**

**Threat actor: none — an undisclosed accounting choice.**

[stratum-server.js:64](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L64):
`const GRIN_BLOCK_REWARD = 60;`, passed straight into `creditBlock` at `:659` and stored as
`blocks.reward`. Nothing ever reads the actual coinbase. In Grin the coinbase output is
`REWARD + Σ(kernel fees in the block)` — 60 GRIN is the *emission*, not the payment. PPLNS
therefore distributes exactly 60 minus the pool fee, regardless of what the block actually paid,
and the fee remainder accrues to the pool on top of the advertised `pool_fee_percent`.

The amounts are small (Grin blocks are usually near-empty; a tx kernel fee is ~0.023 GRIN) and the
direction is safe — the wallet holds *more* than the ledger owes. But it is the same class of
distortion §H/§I already corrected in the other direction with `withdrawals.fee`: an unrecorded
sender-paid cost was dragging `coverage_full_gap` negative, so it was measured and added back
([reconciliation.js:181](../../web/07_mining_pool_public/back-end-pool/lib/reconciliation.js#L181)).
This one drags the same gap **positive** by an unrecorded amount, which masks a real shortfall of
the same size — precisely the failure mode that correction exists to prevent.

It is also derivable rather than unknowable: `get_block(height)` returns the block's kernels with
their `fee`, and it is called at block-found time, well inside a pruned node's horizon, so
`reward = 60 + Σ fees` is a single extra call. Whether to credit it to miners or keep it is the
operator's call — but the pool should *record* which it is doing, and the transparency page should
say so. Right now neither the code nor the public copy mentions that fees exist.

---

## §J6 — Stratum & share intake (2026-08-27, add-ons, NOT VPS-TESTED)

### J6-1 — [Critical] The share dedup key contains the miner's own worker name, so one solved share is credited once per label — PPLNS weight is forgeable at ≥11× with no assumptions about the node — **FIXED 2026-09-01**

**Threat actor: mining miner.** Any rig that can find one legitimate share.

The dedup identity is built at
[stratum-server.js:557](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L557):

```js
const shareHash = this.shareValidator.generateShareHash(
  session.grinAddress, workId, session.workerName, nonce);
```

and [shares.js:83–86](../../web/07_mining_pool_public/back-end-pool/lib/shares.js#L83) hashes
`` `${grinAddress}-${workId}-${workerName}-${nonce}` ``. `workId` is the job's `pre_pow` — that part
is the 2026-07-17 fix and it is correct. `session.workerName` is not: it comes from
`validateUsername`'s `.worker_name` suffix
([stratum-protocol.js:61–92](../../web/07_mining_pool_public/back-end-pool/lib/stratum-protocol.js#L61)),
i.e. **whatever the miner typed after the dot**, up to 32 characters of `[a-z0-9_-]` (25 until 2026-09-21; the worker part is now case-folded before the charset check, the address is not). Change the
label, change the hash, and the same `(pre_pow, nonce, pow)` inserts again.

Measured end to end through the real handlers — one socket, one solved share, eight labels:

```
CONFIRMED  the SAME address + SAME pre_pow + SAME nonce hashes differently per worker name
CONFIRMED  ONE solution re-submitted under 8 worker names is credited 8 times
CONFIRMED  ...multiplying this address's PPLNS weight 8x for one unit of real work
CONFIRMED  every copy passed the share_hash UNIQUE constraint
CONFIRMED  all done from ONE TCP socket, inside the 25 msg/s token bucket
CONFIRMED  control — same worker name, 5 resubmits of one solution → 1 credited share
```

The control line matters: dedup works perfectly for the case it was tested against, which is why
`scripts/test-stratum-guards.js` passes. Its six assertions all hold the worker name constant.

**The comment defending the field is wrong, which is why nobody caught it.**
[shares.js:80–82](../../web/07_mining_pool_public/back-end-pool/lib/shares.js#L80) says the worker
name is in the key so "two different miners that share a worker name (e.g. the default) can never
collide on (work, worker, nonce) and have one's valid share rejected as the other's duplicate."
But `grinAddress` is already the first component of the key and two different miners are two
different addresses — cross-miner isolation was already total without it. Confirmed:

```
CONFIRMED  the address alone already separates two miners sharing a worker name
```

So the field buys nothing and costs the whole control.

**No assumption about grin's stratum is required for the first ~11×.** Memory
`project_pool_stratum_node_jobid` records, from live testing, that the node re-issues *many* job_ids
for one **identical** `pre_pow` (a new block version roughly every 15 s at the same height), and
memory `project_pool_stratum_hardening` records that this is exactly what made the previous
job_id-keyed dedup credit one solution "once per wrapping job (up to JOB_WINDOW×)". `JOB_WINDOW` is
10 ([stratum-server.js:29](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L29))
and `jobIdMap` holds ~11 live entries. So the attacker pairs worker label *w<sub>k</sub>* with
wrapping pool job *j<sub>k</sub>*: every submit carries a **node job_id the node has never seen this
nonce against**, and the header is byte-identical so the PoW verifies every time. The pool's key
differs only in the label. Whether grin's stratum keeps any per-`(version, nonce)` cache is
irrelevant to that first factor of ~11 — and if it keeps none, the multiplier is bounded only by
the 25 msg/s token bucket and the 320-connections-per-IP cap.

**Cost to the attacker: nothing.** They mine honestly at whatever rate their hardware allows and
multiply the recorded weight afterwards. PPLNS pays `your shares ÷ total shares`, so an 11× forgery
takes ~11× the payout — drawn directly from every honest miner in the pool. It is invisible in every
pool-side readout, because a forged share is indistinguishable from a real one in the `shares` table;
the only tell is a per-address hashrate on the leaderboard that exceeds what the rig can physically
do, and nothing compares those.

**Fix — one line.** Drop `workerName` from `generateShareHash`'s input at
[shares.js:84](../../web/07_mining_pool_public/back-end-pool/lib/shares.js#L84) (keep the parameter
so call sites and the `test-stratum-guards.js` signature don't move, or drop it at both ends). The
key becomes `address + pre_pow + nonce`, which is the complete identity of "this miner solved this
template with this nonce" and cannot be re-spelled. `shares.worker_name` stays as the attribution
column it already is — the label still reaches the DB and the account page, it just stops being part
of the uniqueness decision. Worth adding to `test-stratum-guards.js` as an assertion that *denies*:
two worker names, one solution, one credited share.

---

### J6-2 — [Critical] `lastSeenAt` is never refreshed, so every stratum session is deleted ten minutes after login while its socket keeps mining — after which the pool forwards nothing to the node and a found block is lost — **FIXED 2026-09-01**

**Threat actor: the system.** No attacker. No misconfiguration. A wall clock.

[`miners.js:44`](../../web/07_mining_pool_public/back-end-pool/lib/miners.js#L44) sets
`lastSeenAt: Date.now()` when the session is created.
[`miners.js:265–275`](../../web/07_mining_pool_public/back-end-pool/lib/miners.js#L265) deletes
every session where `now - session.lastSeenAt > timeoutMs`, default **600000**, and
[stratum-server.js:183](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L183)
runs that sweep every 60 seconds with no argument. The only writer that could keep a session alive
is `updateSession` ([miners.js:57–63](../../web/07_mining_pool_public/back-end-pool/lib/miners.js#L57)),
and it has **no call sites anywhere in the repo**:

```
$ grep -rn "updateSession" --include=*.js .            # (node_modules excluded)
lib/miners.js:57:  updateSession(sessionId, updates) {
```

The submit path does not touch it either — `recordShare` writes `shareCount` and `lastShareAt`
([miners.js:174–183](../../web/07_mining_pool_public/back-end-pool/lib/miners.js#L174)), neither of
which the sweeper reads.

Driven through the real handlers:

```
CONFIRMED  recordShare() leaves lastSeenAt untouched
CONFIRMED  pruneInactiveSessions() deletes the still-connected session
CONFIRMED  a submit on that live socket answers "Session not found"
CONFIRMED  ...and the solution is NEVER forwarded to the node (a block would be lost)
CONFIRMED  ...and the socket is left open, so the rig never reconnects
CONFIRMED  miner_accounts.is_online flipped to 0 while the rig is mining
```

**Two timers of the same length, keyed on different things.** `socket.setTimeout(600000)`
([stratum-server.js:295](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L295))
is Node's *inactivity* timer and resets on every byte received, so a working rig's socket never
expires. The session timer never resets at all. The result is that the two are guaranteed to
disagree for exactly the connections that matter: the busy ones.

**What the operator would see.** `Pruned N inactive sessions` in the log every minute, all miners
showing offline on the dashboard while the stratum port carries traffic, a pool hashrate that decays
to zero over the first ten minutes and stays there, and — the expensive part — `handleSubmit`
returning at
[stratum-server.js:513–516](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L513)
*before* `forwardSubmit`, so a solution that solves a block is never handed to the node and the
block is simply never claimed. Recovery depends entirely on whether a given rig's firmware
re-logs-in after N consecutive rejects; grin-miner does not, and the pool must not depend on
firmware behaviour it doesn't control.

This is the failure mode memory `project_pool_stratum_node_jobid` warns about in its own words — *an
availability bug that looks like an attack*. It would present as "shares stop counting", which is
the same symptom as the job_id and nonce bugs, and would be misdiagnosed the same way.

**Fix.** Refresh the session on activity. The correct spot is the message loop rather than the
submit handler, so a `status`/`getjobtemplate` keepalive counts: touch the session where
`handleMessage` is dispatched
([stratum-server.js:354–358](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L354)),
or make `_stat`/`recordShare` set `lastSeenAt` and accept that a purely-idle-but-connected rig is
pruned. **Coupled to J6-4** — refreshing `lastSeenAt` without also closing the previous session on
re-login turns that finding's leak from a 10-minute-lifetime leak into a permanent one. The two must
land together, which is why this is written up rather than patched here.

---

### J6-3 — [High] PROXY-protocol v2 is honoured on the public `:3333` listener, so any anonymous client picks the IP the pool records — and the per-IP connection counter leaks, permanently locking a shared NAT out of the pool — **FIXED 2026-09-01**

**Threat actor: anonymous.**

`handleNewConnection` runs the PROXY-v2 phase unconditionally
([stratum-server.js:363–378](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L363)).
`isPublic` gates the per-IP *cap* but not the header parse. The header is only ever meant to arrive
on a region listener: `_listen(this.port, '0.0.0.0', …, true)` is the public port
([:161](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L161)), region listeners
bind `region_listen_host` ([:172–181](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L172)),
and the gateway forwards to the **region** port over WireGuard, never to `:3333` —
[`07_lib_gateway.sh:351–353`](../../scripts/lib/07_lib_gateway.sh#L351) writes
`server central ${hub_ep} send-proxy-v2` where `hub_ep` is documented at
[`:74`](../../scripts/lib/07_lib_gateway.sh#L74) as "central wg IP:port for THIS region, e.g.
`10.66.66.1:3391`". So there is no deployment in which a public-listener PROXY header is legitimate.

Two consequences, both confirmed against the real handler with a hand-built 28-byte v2 TCP4 header
claiming `10.0.0.9` from a socket whose `remoteAddress` was `198.51.100.77`:

```
CONFIRMED  per-IP counter incremented against the real address
CONFIRMED  an anonymous client on :3333 sets the IP the pool records
CONFIRMED  cleanup decrements the SPOOFED key, so the real IP stays counted forever
```

**(a) The recorded IP is attacker-chosen.** `ip` is reassigned at
[:374](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L374) and then flows into
`createSession(…, ip, …)` ([:477](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L477)),
which is what `recordOwnerEvidence` hashes into the ownership gate's IP leg
([:643–649](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L643)) and what
`recordMinerCountry` geolocates for the public network map
([:620](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L620)). The §J3 fixes
correctly put both writes behind an accepted share — but they assumed the value being written was
observed, not asserted. It decouples *the IP that did the work* from *the IP on record*, which is
the exact binding the gate's IP leg exists to make. It also poisons the country attribution on the
network map with no proof of work beyond one share.

**(b) The per-IP cap leaks, and the leak is a weapon against other people.** The counter is
incremented at accept time against `socket.remoteAddress`
([:268–277](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L268)) but
`cleanup` decrements `this.connectionsByIp.get(ip)`
([:302–304](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L302)) — the
*reassigned* `ip`. With a spoofed header the decrement lands on a key that holds nothing (`(undefined
|| 1) - 1 === 0` → `delete`, a no-op) and the real address stays counted for the life of the
process. `max_connections_per_ip` defaults to 320, so **320 connect-header-disconnect cycles
permanently exhaust one source address's budget**. That is self-inflicted for a lone attacker — and
a denial-of-service against everyone else when the address is shared: one host behind a CGNAT or a
mining-farm NAT can lock out every legitimate miner sharing that egress IP, until the pool process
is restarted. The comment at
[:126–129](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L126) says the cap is
"deliberately generous so shared-NAT / CGNAT / farm miners aren't collateral-blocked", which is
precisely the population this turns into collateral. `connectionsByIp` also never shrinks back, so
it grows one permanent entry per attacking address.

**Fix.** Two independent changes, both small: (1) skip the PROXY phase entirely when `isPublic` —
set `proxyDone = true` before the first `data` event on the public listener, so `:3333` is always
raw stratum; (2) capture the accept-time address into its own `const cappedIp` and have `cleanup`
decrement *that*, never the mutable `ip`. Do (2) regardless of (1) — it is the invariant, and it
keeps holding if a future deployment ever does front `:3333` with a local proxy.

---

### J6-4 — [Medium] A repeated `login` on one socket creates a new session and abandons the old one, so one connection can allocate sessions at the message rate — and every abandoned one inflates the public counters — **FIXED 2026-09-01**

**Threat actor: anonymous.**

`handleLogin` has no guard against being called twice on the same connection. Each call runs
`ensureMinerExists` + `createSession` ([:469–478](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L469))
and hands the new id to the `setSession` closure
([:354–358](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L354)), which
overwrites the socket's `sessionId` local. The previous session is never passed to `closeSession`.
`cleanup` ([:299–310](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L299))
can only reclaim the one the closure still points at.

```
CONFIRMED  50 logins on ONE socket -> 50 live sessions in activeSessions
CONFIRMED  closing the socket reclaims only the LAST one (49 leak until the 10-min prune)
```

Each abandoned session holds the address, region, worker name and the stratum password as typed
(sliced to `PASS_MAX + 1`, [:446](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L446)).
The token bucket allows 25 messages/second sustained per connection and the per-IP connection cap is
320, so one source address can allocate ~8,000 sessions/second. They survive until the ten-minute
sweep, so the steady-state resident set is ~4.8M session objects per attacking IP — and the sweep
that eventually clears them calls `closeSession` → `updateMinerOnline` per entry
([miners.js:66–72](../../web/07_mining_pool_public/back-end-pool/lib/miners.js#L66)), i.e. millions
of synchronous SQLite `UPDATE`s inside one loop on the event loop the share path shares. That is the
stall shape memory `project_pool_db_capacity` describes, reached without a single HTTP request.

Second-order, and cheaper to reach: `activeSessions` is iterated in full by `getActiveMinersCount`,
`getSessionsByMiner`, `getPasswordConsistency` and `getStats`, and `getStats()` is served on the
public `/api/stratum/stats` and `/api/pool/stats`
([index.js:2153](../../web/07_mining_pool_public/back-end-pool/index.js#L2153),
[:2177](../../web/07_mining_pool_public/back-end-pool/index.js#L2177)). So the leak turns two
anonymous GETs at the `public` bucket rate into an O(sessions) scan each, and inflates
`active_connections` / `active_miners` on the public dashboard with sessions that do not exist.

**Fix.** In `handleLogin`, before `createSession`, close the session the connection already holds —
the handler needs a `getSession` accessor alongside the `setSession` it is already given. Optionally
also refuse a second `login` on an authenticated socket outright; the Grin stratum spec has no
re-login flow, so nothing legitimate does it.

---

### J6-5 — [Medium] Nothing penalises a session that produces only rejects, so `:3333` is an unauthenticated 8,000/s amplifier onto the node's PoW verifier and onto the journal — **FIXED 2026-09-01**

**Threat actor: anonymous.**

A submit reaches `forwardSubmit` if it has the five required keys, a `job_id` inside the window and a
`height` equal to the current job's
([stratum-server.js:519–545](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L519)).
`pow` need only be a non-empty array — its contents are never inspected pool-side, deliberately, so
that the node stays the authority ([:559–567](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L559)).
Every such submit therefore costs the Grin node a full Cuckatoo verification, and the pool learns
nothing it can act on: `_stat(sessionId, 'rejected')` increments a counter
([:578](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L578)) that is only ever
*displayed* — `session.rejected` is read by `getStats`, `getWorkersForAccount` and `alert-monitor`,
and by nothing that disconnects, throttles or bans. `banMiner` has exactly one caller, the admin
route at [index.js:6142](../../web/07_mining_pool_public/back-end-pool/index.js#L6142).

```
CONFIRMED  120 garbage submits were all relayed to the node for PoW verification
CONFIRMED  the session is still alive after 100 consecutive node rejections
CONFIRMED  every rejection wrote its own log line (121 lines for 120 submits)
CONFIRMED  nothing reads session.rejected — no auto-ban, no per-session reject ceiling
```

The 120 were sent inside the documented budget — 99 against the burst, then a one-second pause for
the 25/s refill — so this is the *sustained allowance*, not a burst the guard is meant to cut.

At 25 messages/s × 320 connections, **one source address can force ~8,000 PoW verifications per
second** on the node that also has to stay synced and build templates; the pool's own caps put the
whole-box ceiling at 25,000 sockets. Every rejection also writes its own `console.warn`
([:532](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L532),
[:579](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L579)) at ~120 bytes, so
8,000/s is ≈1 MB/s of journal — ~80 GB/day from one IP, on the disk the SQLite DB lives on.

Note the interaction with the `maxPending` backpressure at
[node-stratum-client.js:164–167](../../web/07_mining_pool_public/back-end-pool/lib/node-stratum-client.js#L164):
it correctly stops the pool OOMing when the node stalls, but the way it stops is by returning
`accepted: false` — so once an attacker has driven node latency high enough to fill the backlog,
**every honest miner's share is refused too**. The guard converts a memory exhaustion into a
pool-wide share outage, which is the right trade only if something upstream is stopping the
attacker, and nothing is.

**Fix.** A per-session consecutive-reject ceiling is the cheap 90%: disconnect after N node
rejections with no intervening accept (a real rig's reject rate is ~1%, so N=50 never fires
legitimately). Rate-limit the two warn lines to one per session per interval with a count. Both are
local to `handleSubmit`. A per-address reject ratio feeding `banMiner` is the fuller answer and is an
operator-policy decision.

---

### J6-6 — [Medium] Any charset-valid string is accepted as a Grin address and gets a `miner_accounts` row at login — the bech32 checksum is never verified — **FIXED 2026-09-01**

**Threat actor: anonymous.**

`validateUsername` checks the human-readable prefix, the bech32 *charset* and the length —
`^(grin1|tgrin1)([ac-hj-np-z02-9]{58})(\.…)?$`
([stratum-protocol.js:63–66](../../web/07_mining_pool_public/back-end-pool/lib/stratum-protocol.js#L63)) —
and never verifies the 6-symbol bech32 checksum those last characters *are*. `handleLogin` then calls
`ensureMinerExists` ([stratum-server.js:469](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L469)
→ [miners.js:87–97](../../web/07_mining_pool_public/back-end-pool/lib/miners.js#L87)), which
`INSERT OR IGNORE`s the row before any proof of anything.

```
CONFIRMED  24 junk (checksum-invalid) logins on one socket created 24 new miner_accounts rows
```

Each login is three synchronous statements on the shared DB — `isBanned` SELECT, `ensureMinerExists`
INSERT, `updateMinerOnline` UPDATE — so at the sustained 25/s × 320 connections the write path is
~24,000 statements/s against the database the share INSERT and every public API read also use. The
row count grows without bound and without an owner; nothing prunes `miner_accounts`, because a row
there is an account that might hold a balance.

Two smaller consequences worth naming. A miner who fat-fingers one character of their address gets a
*working* login and a balance that accrues to an address nobody holds the key to — the checksum
exists to catch precisely that, and the pool discards it. And the addresses that reach
[`ensureMinerExists`](../../web/07_mining_pool_public/back-end-pool/lib/miners.js#L87) are the same
strings that later reach the payout path as destinations.

**Fix.** Verify the bech32 checksum in `validateUsername` — it is ~25 lines of polymod with no
dependency, and it is the difference between "looks like an address" and "is one". Second, do not
create the account row at login: `submitShare` is where an address first earns the right to exist,
and `ensureMinerExists` can move there (the `shares` FK to `miner_accounts` means it must run before
the first INSERT, not before the first login).

---

### J6-7 — [Medium] One accepted share still permanently rewrites a stranger's `donation_percent`, and it is cheaper than rotating that address's ownership proof — **FIXED 2026-09-01**

**Threat actor: mining miner.** Re-opened per plan rule 2, with a demonstration — §J3-5's fix is
correct as far as it goes and is not being re-litigated.

§J3-5 moved the `donateN` write out of `handleLogin`, where it needed no work at all, and parked it
on the session until the first node-accepted share
([stratum-server.js:616–631](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L616)).
That closed the zero-cost version. What remains is that the write is still **unconditional,
un-throttled, permanent, and gated on `acceptedShares === 1`** — while the far less valuable act of
*rotating* an ownership proof this address already has costs `PROOF_MIN_SHARES = 4`
([:38](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L38),
[:643–648](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L643)). The cheaper
action is the one that redirects money.

```
CONFIRMED  ONE accepted share diverts 100% of a stranger address future PPLNS credit
CONFIRMED  ...and it is written even with incentives_enabled = false
```

`setDonation` ([incentives.js:173–186](../../web/07_mining_pool_public/back-end-pool/lib/incentives.js#L173))
upserts `miner_incentives.donation_percent` with no history and no audit row. The share the attacker
must produce is credited **to the victim**, so the entire cost of the attack is one share at the
node's minimum share difficulty. The proceeds go to the prize pool, which pays out to other people —
memory `project_pool_dormant_balances` records that direction as final — so the diversion is
irreversible even after it is noticed.

The second line is a separate defect in the same call: `setDonation` checks only
`allow_miner_donations` and not `incentives_enabled`, whereas `donationsActive()` at
[incentives.js:162–164](../../web/07_mining_pool_public/back-end-pool/lib/incentives.js#L162)
requires both. So an operator who has switched incentives off still accumulates donation percentages
that take effect the moment they switch them back on.

**Mitigations that are real, and their limits.** The value is visible — `donation_percent` is on the
public account summary ([index.js:3105–3108](../../web/07_mining_pool_public/back-end-pool/index.js#L3105)),
which is §J3-5 part 2 having landed. And it is recoverable: the victim can log in once with
`.donate0`, which `validateUsername` treats as an explicit opt-out
([stratum-protocol.js:74–81](../../web/07_mining_pool_public/back-end-pool/lib/stratum-protocol.js#L74)).
But there is no HTTP route that sets or clears it — stratum is the only writer — so the remedy
requires the miner to notice a number on a page and know what to type, and the attacker can re-set
it for the price of another share, indefinitely. That asymmetry is what keeps this open rather than
closed by §J3-5.

**Fix.** Gate the donation write on `PROOF_MIN_SHARES` like the proof rotation beside it — the tag is
a preference, and a preference that moves money should cost at least what rotating an identity costs.
Better still, only honour it when the address has **no** stored `donation_percent`, or when the
session also satisfies the ownership evidence already on record. Add `incentives_enabled` to
`setDonation`'s guard.

---

### J6-8 — [Low] Blank frames are free — `continue` sits above the token-bucket spend, and the socket deadline resets on any byte — **FIXED 2026-09-01**

**Threat actor: anonymous.**

[stratum-server.js:330](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L330) is
`if (!line.trim()) continue;`, and the bucket is spent at
[:332–343](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L332) — *after* it.
A frame containing only whitespace costs a `split`, a `trim` and nothing else.

```
CONFIRMED  200,000 blank frames spend zero tokens and do not disconnect
CONFIRMED  ...whitespace-only frames behave the same
```

On its own this is CPU-cheap and bandwidth-bound. It matters because it is also the keepalive: the
only thing that closes an unauthenticated socket is `socket.setTimeout(600000)`
([:295](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L295)), which is Node's
*inactivity* timer and restarts on every byte received. One newline every nine minutes holds a slot
in the 25,000-socket global ceiling
([:261–264](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L261)) forever, for
one byte of traffic, with no login and no proof of anything — and the global cap refuses *real*
miners once it is reached. There is no separate deadline by which a connection must have logged in.

**Fix.** Move the blank-line skip below the bucket spend (or count blank frames at a reduced weight),
and add a pre-login deadline — a connection that has not authenticated within ~60 s of accept is
destroyed. The second is the one that matters; it is a `setTimeout` cleared in `handleLogin`.

---

### J6-9 — [Low] A login with no work behind it is published as an online worker on someone else's account page — **FIXED 2026-09-01**

**Threat actor: anonymous.**

`getWorkersForAccount` merges live sessions into the per-worker breakdown
([hashrate-tracker.js:205–216](../../web/07_mining_pool_public/back-end-pool/lib/hashrate-tracker.js#L205))
and, at [:241–256](../../web/07_mining_pool_public/back-end-pool/lib/hashrate-tracker.js#L241),
appends every live worker that has no shares in the window as an entry with `online: true`. There is
no `acceptedShares` filter.

```
CONFIRMED  a login with zero accepted shares appears as an ONLINE worker on another address
CONFIRMED  ...carrying an attacker-chosen label into the account page
```

This is the sibling of §J3-2, which added exactly that filter to `getPasswordConsistency`
([miners.js:233](../../web/07_mining_pool_public/back-end-pool/lib/miners.js#L233) — `if
(!(s.acceptedShares > 0)) continue;`) for the same reason: a stratum session exists from *login*,
and login is unauthenticated. `getWorkersForAccount` was not given the same treatment.

Impact is bounded — the label is `[a-z0-9_-]{1,32}` (`{1,25}` until 2026-09-21), so nothing escapes into markup, and no money
moves. What it costs is the diagnostic: a miner reading their own workers list sees rigs they do not
own, and the injected rows carry `accepted`/`rejected`/`stale` counters that skew the `reject_pct`
the page exists to show. The same sessions also surface on the public `/api/stratum/stats`
([index.js:2151–2170](../../web/07_mining_pool_public/back-end-pool/index.js#L2151)), where the
address is truncated but the attacker-chosen worker name is not.

**Fix.** One line, matching §J3-2: skip sessions with `acceptedShares === 0` in the live-merge loops.

---

### J6-10 — [Low] `isValidJob` has no upper bound and accepts non-integers, so an out-of-range `job_id` silently falls back instead of being rejected — **FIXED 2026-09-01**

**Threat actor: mining miner.**

[stratum-server.js:707–711](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L707):

```js
return this.jobCounter > 0 && jobId > 0 && jobId >= Math.max(1, this.jobCounter - JOB_WINDOW);
```

There is no `jobId <= this.jobCounter`, no integer check, and no consultation of `jobIdMap` — which
is the structure that actually knows which jobs exist.

```
CONFIRMED  isValidJob accepts a job_id far ABOVE jobCounter (no upper bound)
CONFIRMED  isValidJob accepts a non-integer job_id
```

Nothing is credited: the lookup at
[:547](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L547) misses,
`nodeJobId` is `undefined`, and `forwardSubmit` is handed the miner's raw `job_id`
([:574–576](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L574)) which the node
stales. The finding is that the two fallbacks at
[:554–556](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L554) — `workId`
degrading to `currentJob.pre_pow` and then to `String(job_id)` — are described in the comment as
reachable only "if the window entry is somehow gone — isValidJob already gated it", and that is not
true. The `String(job_id)` branch in particular would make the dedup key the *miner's own integer*,
which is the state the 2026-07-17 fix existed to remove; today it is unreachable only because
`currentJob` is always set once a job has arrived.

**Fix.** Make `isValidJob` ask `this.jobIdMap.has(job_id)` — that is the authoritative window and it
is already pruned to `JOB_WINDOW` at
[:234–237](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L234). Then `jobEntry`
can never be missing and both fallbacks can go, along with the comment defending them.

---

### J6-11 — [Low] The nonce is un-quoted on the node wire by a first-match regex over the whole payload, and `forwardSubmit` passes the miner's `params` through verbatim — so a miner-chosen key decides what the node parses — **FIXED 2026-09-01**

**Threat actor: mining miner.**

Two halves that were written to solve the u64 precision bug and are correct for well-formed input.
Parse side ([stratum-protocol.js:18–21](../../web/07_mining_pool_public/back-end-pool/lib/stratum-protocol.js#L18))
re-extracts the literal digits with `/"nonce"\s*:\s*(\d+)/` and carries the nonce as a string. Send
side ([node-stratum-client.js:192](../../web/07_mining_pool_public/back-end-pool/lib/node-stratum-client.js#L192))
strips the quotes again with `.replace(/"nonce":"(\d+)"/, '"nonce":$1')` — **non-global, first match,
over the entire serialised message**. And `handleSubmit` forwards `{ ...params, job_id }`
([stratum-server.js:574–576](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L574)),
so every extra key the miner invented is serialised too, in the miner's own insertion order.

A nested object whose key is `nonce` and whose value is a *quoted* number satisfies the send-side
pattern while being invisible to the parse-side one:

```
CONFIRMED  parse side extracts the real u64 nonce as a string
CONFIRMED  send side unquotes the DECOY and leaves the real nonce quoted on the node wire
CONFIRMED  ...so a miner-chosen params key decides what the node parses
```

Today this is self-harm — the miner's own nonce reaches grin's serde as a quoted string, `u64`
deserialisation fails, and their share is lost. It is rated Low for that reason. The reason it is
worth writing down is what sits behind it: **all shares from all miners funnel through one upstream
socket** ([node-stratum-client.js:42–50](../../web/07_mining_pool_public/back-end-pool/lib/node-stratum-client.js#L42)),
and if grin's stratum ever tears a connection down on a malformed frame rather than answering with an
error, one miner's crafted submit becomes a pool-wide outage: `socket.on('close')` resolves every
in-flight submit as `accepted: false`
([:96–100](../../web/07_mining_pool_public/back-end-pool/lib/node-stratum-client.js#L96)) and
reconnects after 5 s, repeatable at 25/s. **That node-side behaviour is not verified here** and
cannot be without a node; it is listed for J17 below.

**Fix.** Build the wire payload from known fields instead of regexing the serialised blob:
whitelist `{ id, jsonrpc, method, params: { edge_bits, height, job_id, nonce, pow } }` in
`forwardSubmit`, and place the nonce with a targeted replacement on a payload that can contain only
one `"nonce"`. That also closes the pass-through of arbitrary miner keys to the node in one move.

---

### J6-12 — [Low] `bindRegionListener`'s idempotency check reads `server.address()`, which is `null` until the listen completes, and a failed bind is reported as success — **FIXED 2026-09-01**

**Threat actor: logged-in admin** (the honest operator pairing a gateway).

[stratum-server.js:192–202](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L192)
guards against double-binding a port by scanning `this.servers` for one whose `address().port`
matches. `net.Server#address()` returns `null` until the asynchronous `listen` has completed, and
`_listen` pushes the server object into the array *before* that
([:207–216](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L207)). So a
re-pair issued before the previous bind settled sees `a` as `null`, skips the match and binds again.
`_listen` has no way to report failure — the `error` handler only logs
([:212–214](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L212)) — and
`bindRegionListener` returns `true` unconditionally, which the caller discards anyway
([index.js:5867](../../web/07_mining_pool_public/back-end-pool/index.js#L5867)). The admin panel
therefore reports a successful pairing for a listener that is not listening, and the dead server
object stays in `this.servers` where the next idempotency scan will also read `null` from it.

This is the exact shape CLAUDE.md warns about for the Accio onion path — *nothing on this box reports
a bind collision*, and a status line that greps for a port goes green whichever role won.

**Fix.** Track bound ports in a `Set` updated inside the `listen` callback and consulted
synchronously, and give `_listen` a callback so `bindRegionListener` can return the real outcome to
the pairing route (which should surface it, not discard it).

---

### J6-13 — [Info] Verified correct, with evidence

Checked and found sound — recorded so a later pass does not re-derive them.

- **The `pre_pow` dedup half is right.** `setNewJob` stores `{ node, pre_pow }` per pool job and
  prunes to `JOB_WINDOW` by ascending key with an early `break`
  ([stratum-server.js:220–238](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L220)),
  so `jobIdMap` is bounded at ~11 entries and every re-version of one template collapses to one
  dedup identity. The control probe confirms five resubmits of one solution under one label credit
  once. J6-1 is a *second* field in the same key, not a regression in this one.
- **The u64 nonce carriage works.** A 2^64-scale nonce survives parse as a string and is re-emitted
  bare on the node wire; verified against `17293822569102704642`. J6-11 is about the *mechanism*, not
  about this case failing.
- **PoW is validated before anything is persisted.** `forwardSubmit` is awaited and a non-accept
  returns before `submitShare`
  ([stratum-server.js:568–585](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L568)).
  The comment's history — that an earlier version recorded first — is worth keeping.
- **Share difficulty is not client-supplied.** `session.difficulty` is a hardcoded `1.0`
  ([miners.js:26](../../web/07_mining_pool_public/back-end-pool/lib/miners.js#L26)), `submitShare`
  refuses `<= 0` ([shares.js:21–23](../../web/07_mining_pool_public/back-end-pool/lib/shares.js#L21)),
  and `setSessionDifficulty` has no callers — so nothing in a submit influences the recorded weight.
  **This answers §J5's handoff:** PPLNS weight per *share* is unforgeable; it is the *number of
  shares* that J6-1 forges, which is a different lever than the one J5 asked about.
- **The line cap does bound complete lines.** `MAX_LINE_BYTES` is tested on the partial remainder
  after the split ([stratum-server.js:317–327](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L317)),
  and since the remainder is re-checked on every `data` event before its terminating newline can
  arrive, a complete line can never exceed it. The comment's reasoning is correct. (`.length` counts
  UTF-16 units, not bytes, so the true byte ceiling is up to 3× higher — harmless at this cap.)
- **Both connection caps are enforced before allocation.** The global ceiling and the per-IP cap both
  `socket.destroy()` and `return` before any session or buffer exists
  ([:259–278](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L259)). J6-3(b) is
  about the *decrement*, not the check.
- **`maxPending` backpressure is correct as memory management** — `forwardSubmit` refuses at the
  ceiling rather than growing the map
  ([node-stratum-client.js:164–167](../../web/07_mining_pool_public/back-end-pool/lib/node-stratum-client.js#L164)),
  and `close` resolves every pending entry so no caller hangs
  ([:96–100](../../web/07_mining_pool_public/back-end-pool/lib/node-stratum-client.js#L96)). Its
  *availability* consequence is written up in J6-5.
- **`banMiner` is enforced at login, before a session exists**
  ([stratum-server.js:460–468](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L460)),
  and leaves the balance row intact so anything owed can still be paid.
- **The §J3 fixes are present and in the right order.** IP/password evidence and the country lookup
  are behind `session.acceptedShares`, not login
  ([:611–650](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L611)); `mayDisplace`
  is gated on `PROOF_MIN_SHARES` while first capture is not; the deliberate no-record comment at
  [:471–475](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L471) matches what
  the code does. The handoff asked J6 to re-read `handleLogin` for any *other* pre-PoW write: the
  three that remain are `ensureMinerExists` (J6-6), `createSession` (J6-4) and `updateMinerOnline`,
  all reported above; there are no others.
- **Injection surface is clean at the source.** The address is charset- and length-anchored and the
  worker label is `[a-z0-9_-]{1,32}` after truncation (`{1,25}` until 2026-09-21; the case-fold runs BEFORE the charset regex, so it adds nothing to the charset)
  ([stratum-protocol.js:59–86](../../web/07_mining_pool_public/back-end-pool/lib/stratum-protocol.js#L59)),
  so neither can carry markup, quotes, control characters or a newline into a log line, a DB column
  or a JSON body. Every statement in `shares.js` and `hashrate-tracker.js` is parameterised; the only
  template interpolations in the latter's SQL are the two frozen literal tuples at
  [hashrate-tracker.js:589–590](../../web/07_mining_pool_public/back-end-pool/lib/hashrate-tracker.js#L589).
  The `donateN` and worker-label regexes are bounded (`{1,3}`, input ≤ 48 chars — 40 until 2026-09-21) — no ReDoS.
- **`getPoolHistory`'s cache is the right shape** — keyed on `hours|maxPoints` with a 64-entry
  ceiling and a TTL equal to the sampling interval
  ([hashrate-tracker.js:11–18](../../web/07_mining_pool_public/back-end-pool/lib/hashrate-tracker.js#L11)),
  so the one public read whose cost scales with pool size cannot be used to stall the share path.

---

## §J7 — DB layer, SQL & amount arithmetic (2026-09-01, add-ons, NOT VPS-TESTED)

### J7-2 — [Medium] `Math.min(parseInt(…), CAP)` has no lower bound, so `?limit=-1` is `LIMIT -1` — "no limit" — and defeats the row cap that is §C1's fix on two public money endpoints — **FIXED 2026-09-01**

**Threat actor: anonymous.** One unauthenticated GET.

SQLite treats a **negative `LIMIT` as no limit at all**. Confirmed against `node:sqlite` on a
10-row table:

```
limit=-1 offset=0    -> 10 rows [1,2,3,4,5,6,7,8,9,10]
limit=5  offset=-3   -> 5 rows  [1,2,3,4,5]        (negative OFFSET is clamped to 0 — harmless)
```

Fourteen route handlers clamped the limit with `Math.min(parseInt(…), CAP)` and **no
`Math.max(…, 1)`**, so a negative passed straight through to the binding. The two that matter:

- [`GET /api/pool/payments`](../../web/07_mining_pool_public/back-end-pool/index.js#L2974) —
  capped at 500. With `?limit=-1` it returns **every confirmed payout the pool has ever made**,
  with the **full** `grin_address`, amount, fee, method and `kernel_excess`. `withdrawals` is
  never pruned (memory `project_pool_admin_table`), so that is the pool's entire lifetime payment
  history in one request.
- [`GET /api/pool/miners`](../../web/07_mining_pool_public/back-end-pool/index.js#L2924) — capped
  at 500, addresses masked. With `?limit=-1` it returns **every account row**, ordered by balance
  descending.

That cap is not incidental: §C1 ("`/api/pool/miners` and `/api/pool/payments` leak full raw data")
was closed on 2026-07-28 with masking, a rate limit and an explicit column list — and the row cap
is the part that bounds how much one request can pull. A negative limit removed it.

The same defect reached `/api/pool/top-block-finders`, `/api/pool/unclaimed`,
`/api/public/lottery/winners`, `/api/account/:addr/shares`, `/api/account/:addr/balance/log`,
`/api/account/:addr/withdrawals` and five `secureAdmin` list endpoints. **The second cost is not
disclosure but the event loop:** an unbounded `SELECT` on the shared synchronous `DatabaseSync`
blocks share submission for every connected miner while it runs — the same mechanism as the
`hashrate_history` scan in memory `project_pool_db_capacity`, which is recorded there as a real
incident and not a theoretical one.

**Fixed** by moving all fourteen sites onto the safe idiom the same file already used at
[index.js:4650–4651](../../web/07_mining_pool_public/back-end-pool/index.js#L4650):

```js
const limit  = Math.min(Math.max(parseInt(req.query.limit,  10) || 50, 1), 500);
const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
```

The ordering matters and is the reason the broken variants were broken in two different ways —
see J7-4. `grep -n "Math.min(parseInt(req.query.limit" index.js` now returns nothing.

---

### J7-4 — [Low] A non-numeric `limit` or `offset` binds `NaN`, which `node:sqlite` rejects outright, turning a typo into a 500 that echoes the driver's message — **FIXED 2026-09-01**

**Threat actor: anonymous.** Same GETs as J7-2.

`Math.max` and `Math.min` **propagate `NaN`** — that is why the "clamped" variants were no better
than the unclamped ones:

```
Math.min(Math.max(parseInt("abc"), 1), 500) = NaN
Math.min(parseInt("abc"), 500)              = NaN
```

`/api/pool/blocks` used the first form
([index.js:2238](../../web/07_mining_pool_public/back-end-pool/index.js#L2238) before this pass), so
it looked defended and was not. Binding the result:

```
limit=NaN offset=NaN -> THREW Error datatype mismatch
limit=Infinity       -> THREW Error datatype mismatch
limit=2.7            -> THREW Error datatype mismatch
```

`node:sqlite` binds a non-integer JS number as a REAL and SQLite refuses a REAL in `LIMIT`. Every
one of these routes ends `catch (err) { res.status(500).json({ error: err.message }); }`, so
`?limit=abc` returns **HTTP 500 with the string `datatype mismatch`** — a driver-level detail on a
public endpoint, and a cheap way to fingerprint the storage engine. (Note this is a
better-sqlite3 → `node:sqlite` behaviour change of the same family as memory
`reference_nodesqlite_u64_throws`: the old driver would have coerced rather than thrown.)

**Fixed** with J7-2: `parseInt(x, 10) || DEFAULT` **before** the clamps, so `NaN` becomes the
default and never reaches `Math.max`.

---

### J7-5 — [Medium] `isNaN()` is not a finiteness check, so `"Infinity"` passes every amount guard — and a `REAL` balance stores `+Inf` permanently, invisibly, and with the prize-pool overdraw guard switched off for good — **FIXED 2026-09-01**

**Threat actor: logged-in admin (`freshAdmin`).** Not an escalation — this admin can already move
money. It is a one-typo, unrecoverable, *silent* corruption of the pool's accounting, on inputs
where every neighbouring guard in the codebase is stricter.

Four amount inputs guarded on `isNaN`/`> 0` and nothing else:

| Route / function | Guard as written |
|---|---|
| `POST /api/admin/incentives/prize-pool/topup` → `manualTopup` | `if (!(amt > 0)) throw` |
| `POST /api/admin/incentives/award` | `if (isNaN(amount) \|\| amount <= 0)` |
| `POST /api/admin/miners/:addr/inject` | `if (isNaN(amount) \|\| amount <= 0)` |
| `POST /api/admin/incentives/lottery/draw-now` | `parseFloat(req.body.pot_grin) \|\| 0` |

`parseFloat("Infinity")` is `Infinity`; `isNaN(Infinity)` is `false`; `Infinity <= 0` is `false`;
`Infinity` is truthy. All four accept it. Run through the real balance statement:

```
parseFloat("Infinity")       = Infinity
manualTopup guard  !(amt > 0) rejects?          false
award/inject guard isNaN(amt)||amt<=0 rejects?  false

UPDATE accepted Infinity ->      { balance: Infinity, t: 'real' }
after a -1000 correction ->      { balance: Infinity, t: 'real' }
JSON to the admin panel  ->      {"balance":null,"t":"real"}
Infinity - Infinity      =       NaN
```

Three consequences, in order of how bad they are:

1. **It cannot be undone.** `balance = balance + delta` is the only way any code path moves a
   balance. `Infinity + (any finite number)` is `Infinity`. The account is permanently broken and
   nothing in the admin panel can repair it.
2. **It is invisible.** `JSON.stringify(Infinity)` is **`null`**, so `GET /api/admin/incentives`
   and every other read renders the corrupted bucket as empty, not as broken.
3. **It disables a money guard.** `debitPrizePool`'s only overdraw check is
   `if (this.prizePoolBalance() < amount) return false`
   ([incentives.js:78–83](../../web/07_mining_pool_public/back-end-pool/lib/incentives.js#L78)).
   With the bucket at `Infinity` that comparison is false forever, so **every subsequent prize
   award is funded from a pool that does not exist** — crediting real, withdrawable miner
   balances against nothing. And any reconciliation arithmetic that crosses the value yields
   `NaN`, which compares `false` against every threshold, so the money alerts in
   memory `project_pool_reconciliation` go quiet rather than firing.

The same module gets it right two functions away: `setDonation` clamps with
`Math.max(0, Math.min(100, p))` ([incentives.js:190](../../web/07_mining_pool_public/back-end-pool/lib/incentives.js#L190)),
which handles `Infinity` correctly. This is an inconsistency, not a design choice.

**Fixed** — all four inputs now use `Number.isFinite`:

```js
if (!Number.isFinite(amount) || amount <= 0) {
  return res.status(400).json({ error: 'amount must be a positive, finite number' });
}
```

and `manualTopup` throws *"top-up amount must be a positive, finite number"*. The `pot_grin`
override resolves to `0` on a non-finite value. Nothing else changed; the 206-assertion suite is
unchanged and green.

---

### J7-6 — [Medium] The break-glass admin-reset CLI still `require`s `better-sqlite3`, which the pool dropped and the installer no longer builds — so the documented 2FA-lockout recovery path cannot run on any installed pool — **FIXED 2026-09-01**

**Threat actor: none — a lockout.** The failure mode is the operator losing their own pool.

[`scripts/admin-reset.js:41`](../../web/07_mining_pool_public/back-end-pool/scripts/admin-reset.js#L41)
loaded `require('better-sqlite3')`. Three facts make that unloadable on a real box:

- `package.json` dependencies are `express, bcryptjs, jsonwebtoken, node-fetch, dotenv, ipaddr.js,
  cookie-parser, multer, socks, nodemailer, nostr-tools, ws` (+ optional `geoip-lite`).
  `'better-sqlite3' in dependencies` → **false**.
- The installer deliberately removed the toolchain that would build it —
  [`07_grin_mining_public_pool.sh:553–554`](../../scripts/07_grin_mining_public_pool.sh#L553):
  *"No build-essential/gcc-c++: the pool has no native npm modules since the better-sqlite3 →
  node:sqlite migration."*
- `npm ci --omit=dev` installs exactly what `package.json` lists.

Demonstrated: `require('better-sqlite3')` → `MODULE_NOT_FOUND`. And the failure is worse than a
crash, because `loadDeps()` catches it and prints *"Run it through the installed wrapper
(grin-pool-admin-reset-<net>), which execs node from the pool app dir where node_modules lives"* —
advice that is already being followed, so the operator retries the thing that just failed.

**Why this is a Medium and not a footnote.** This CLI is the only recovery path for an admin who
enabled mandatory 2FA and lost the authenticator *and* the recovery codes. §J2-6 documented what it
can and cannot do on the assumption that it runs. `--clear-2fa` and `--set-password` are the pool's
entire break-glass story, and they could not execute.

**Fixed** — the CLI now loads the same shim the service uses:

```js
Database = require('../lib/sqlite-compat');
```

Verified it is a true drop-in: the file uses only `.prepare/.run/.get/.all`, `.pragma`,
`.transaction` and `.close`, which is exactly `sqlite-compat`'s surface. `--help` works, and
`--list` was run end-to-end against a temp fixture DB carrying the production `users` and
`admin_recovery_codes` schema:

```
  ID  USERNAME            ADMIN  ACTIVE  2FA   CODES  FAILED
  ------------------------------------------------------------
  1   operator            yes    yes     on    0      0
```

`db.pragma('busy_timeout = 5000')` was added at the same point and the "WAL means this is safe
alongside the running service" comment corrected — per J7-1, a write from this CLI makes the live
service's next write fail instantly, and the honest guidance is to run it with the service stopped.

---

### J7-9 — [Info] Verified correct, with evidence

Read and confirmed, not assumed. Recorded so the next pass does not re-derive them.

**No unparameterised SQL reaches a request value.** Every template-literal SQL fragment in the
backend, with what fills it:

| Site | Interpolated value | Source |
|---|---|---|
| `ads.js:120`, `pages.js:108`, `posts.js:133` | `SET` column list | keys of a `_clean()` result — every key is a literal in that function |
| `ads.js:165` | `?` placeholder list | `list.map(() => '?')`, ids `parseInt`-ed and capped at 20 |
| `db.js:1252`, `owner-proof.js:439` | `SET` column list | string literals pushed alongside their bound values |
| `retention.js:164` | table name | six literals in `status()`'s own object |
| `withdrawal-scheduler.js` ×5, `index.js:2251/3526/3547` | `PENDING_SQL`, `LEDGER_DIRECTION_SQL`, `where` | module constants; the only request-chosen one (`?direction=`) is `Object.hasOwn`-gated per §J3-7 |
| `reconciliation.js:45/48`, `ledger-rollup.js:64` | `FLOW_CASES(...)`, `DAY` | module constants |
| `rewards.js:301/306`, `index.js:4224` | `?` placeholder lists | generated from array length |
| `index.js:3527/3580` | `CSV_MAX_ROWS` | the literal `50000` |
| `index.js:4671` | `resultClause` | one of two literals chosen by an allowlist |

**No dynamic `ORDER BY` anywhere.** `grep` for `req.query.sort|order|by|column` and `ORDER BY ${`
returns only the §J3-7 site. `AdminTable` sorts and pages in the browser, so the admin list
endpoints never take a column name.

**All 39 `db.transaction()` bodies are synchronous.** None is `async`, and none `await`s — which
matters because the shim's `transaction()` runs `BEGIN`, calls `fn`, then `COMMIT` synchronously;
an `async fn` would return a pending Promise and COMMIT before the body finished. Verified by
grep across `lib/` and `index.js`.

**The shim's savepoint nesting works.** `incentives.js` participating in the `rewards.js`
transaction is the case it exists for. Tested: a committed outer keeps the inner write; a
**rolled-back outer discards it**; an inner that throws and is caught leaves `_txDepth` correct so
the next statement in the outer still commits.

**`foreign_keys = ON` really is in force through the shim** — a violating INSERT throws
`FOREIGN KEY constraint failed`. §I6's and §J5's guards depend on this and it is not obvious that
a `PRAGMA` issued via `prepare().all()` takes effect.

**The withdrawal amount path is correctly guarded**, unlike the admin amount inputs in J7-5.
`createWithdrawal` takes `parseFloat(amount)` from the request body, and `Infinity` — which passes
`isNaN(amt) || amt <= 0` and the `min_withdrawal` floor and `_netSend` — is stopped by the CAS,
because `balance >= Infinity` is false and the handler maps 0 changed rows to a 409. Negative and
`NaN` are rejected earlier. `_feeFor` is confirmed still unclamped, per memory
`project_pool_fee_model`'s warning not to "fix" it.

**§J5's INTEGER-column sweep is closed: no other column holds a value that can exceed 2^53.**
The columns fed from chain data are `blocks.height` and `shares.block_height` (chain height, ~4 ×
10⁶) and `blocks.nonce`, which §J5-1 already moved to TEXT with a DDL comment explaining why.
`total_difficulty` — J5's named next candidate — **is never stored**: it is read in
`_fetchNetworkDifficulty`, differenced immediately, and only the difference is persisted, into
`blocks.network_difficulty` which is `REAL`. Every remaining INTEGER column is a unix timestamp, a
row id, a boolean flag, a count, or a TOTP counter. Memory `reference_nodesqlite_u64_throws` needs
no update.

**`Σ credits == minerReward` to the nanogrin.** The float-drift worry from §J5's handoff was
measured, not reasoned about: for a 7-way split the residual is `7.1e-15` GRIN, i.e. **0
nanogrin**. Ledger and log take the same double, so the integrity invariant is unaffected. The
float problem in this codebase is J7-3's rounding at the *boundary*, not accumulation.

**Money writes are transactional where it counts.** Reward distribution (CAS flip + credits + fee +
incentives), withdrawal creation, admin retry/cancel, dormancy disposition and `manualPayout` are
each one `db.transaction()`. `dormancy.manualPayout` checks the balance *outside* its transaction
and debits without a CAS — safe only because `DatabaseSync` is synchronous and nothing `await`s
between the two, which is worth knowing before anyone makes that function `async`.

---

## §J8 — Secrets & key management (2026-09-01, add-ons, NOT VPS-TESTED)

### J8-2 — [Medium] `GET /api/admin/miners/:addr` was `SELECT *`, so it shipped the six ownership-proof scrypt hashes — the values the DB exists to keep unreadable — into an admin browser — **FIXED 2026-09-01**

**Threat actor: stolen admin session** (a legitimate admin gains nothing they didn't have). §C3's
access token is unrevocable for up to 24 h, so "the admin panel returned it" and "an attacker
holding a stolen cookie downloaded it" are the same event here.

`miner_accounts` carries six proof columns —
`last_ip`, `prev_ip`, `anchor_ip` (salted scrypt of the miner's mining IP) and
`last_pass_hash`, `prev_pass_hash`, `anchor_pass_hash` (salted scrypt of the rig password). They
are hashed precisely so that *"the database holds no readable mining IP and no readable password,
and a value can only be checked against a hash you supply yourself"* — which is what the pool's own
public privacy page promises miners
([lib/pool-settings.js:448](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L448)).

Two sibling routes get this right, and one did not:

| Route | Query | Proof hashes exposed? |
|---|---|---|
| `GET /api/account/:addr` (public) | selects the hash columns, then builds an **explicit** response object reporting only `has_recorded_ip` / `has_recorded_pass` booleans ([index.js:3055–3086](../../web/07_mining_pool_public/back-end-pool/index.js#L3055)) | no |
| `GET /api/admin/miners` (list) | explicit 8-column list ([index.js:6053](../../web/07_mining_pool_public/back-end-pool/index.js#L6053)) | no |
| `GET /api/admin/miners/:addr` (detail) | `SELECT * FROM miner_accounts` → `res.json({ miner: { ...acct, … } })` | **all six** |

The list was tightened and the detail was not — the same shape as the 2026-07-28 pass that replaced
`SELECT *` on `/api/pool/payments` and `/api/pool/miners` (§C1), whose comment still stands at
[index.js:2966](../../web/07_mining_pool_public/back-end-pool/index.js#L2966).

Why it matters beyond tidiness: the rig-password hash is **one leg of the ownership gate** that
authorises a payout and, after §J3-1, one of the two legs on the destination-change gate. scrypt at
16 MB makes recovering it expensive rather than impossible, and an attacker who does recover one has
a proof that is valid until the miner rotates it — which most never will. Exporting it moves a
credential from a place nothing can read (post-J8-1) to a place a stolen cookie can.

The admin panel reads **none** of the six —
`grep -rn "pass_hash\|last_ip\|prev_ip\|anchor_ip\|anchor_pass" admin-panel/ public_html/` returns
nothing, and `miners.html` only ever calls this route's `/ban` and `/unban` siblings. There was no
consumer to break.

**Fixed 2026-09-01.** Replaced with an explicit 23-column list
([index.js:6070–6095](../../web/07_mining_pool_public/back-end-pool/index.js#L6070)). The
`*_at` timestamps are kept (they carry the same "is a proof on record / when did it last change"
signal the public route publishes, with no hash), and `pass_proof_state` is kept because it is a
verdict string that is already public on `/api/account/:addr` and is what answers *"why won't my
rig password work?"*.

---

### J8-6 — [Info] Verified correct, with evidence

Recorded so a later session does not re-derive them.

| Question (plan §J8) | Result |
|---|---|
| **JWT secret at rest / in transit** | `pool.json` only, written `0600` by `pool_write_conf_key`'s `fs.chmodSync(path, 0o600)` ([07_grin_mining_public_pool.sh:229](../../scripts/07_grin_mining_public_pool.sh#L229)), `chown grinpool:grinpool` by `pool_deroot` ([:499](../../scripts/07_grin_mining_public_pool.sh#L499)). Never in the DB, never in a response, never in a log. Provenance / entropy / `expiresIn` were settled by §J2-8 — not re-checked here. |
| **Wallet passphrase never in argv** | Confirmed on **both** consumers. `execWalletCommand` `spawn`s `grin-wallet` with an args array and writes the passphrase to `proc.stdin` ([lib/wallet-tor.js:214–252](../../web/07_mining_pool_public/back-end-pool/lib/wallet-tor.js#L214)); the generated listener launcher starts `owner_api` with **no** `-p` and the ECDH helper takes the passphrase as a **file path** ([07_lib_pool_wallet.sh:256–316](../../scripts/lib/07_lib_pool_wallet.sh#L256)). `.wallet_pass` is written `chmod 600` at both writers ([:602](../../scripts/lib/07_lib_pool_wallet.sh#L602), [:627](../../scripts/lib/07_lib_pool_wallet.sh#L627)) and `chown`ed to `grinpool` by `_pw_own_pass_file`. So the passphrase is not in `ps aux` — the trap CLAUDE.md flags. `-p` survives only in `init` and a one-shot `address` probe, already documented as bounded. |
| **No secret reaches a response body** | Swept all ~180 routes. No handler serialises `config` (`grep` for `res.json(…config`, `...config`, `JSON.stringify(config)` → one hit, `adsManager.setConfig()`, which is ad layout). No handler returns `err.stack` — every `catch` is `err.message`. Two real leaks found and reported: J8-2 (fixed) and J8-3 (open). |
| **`/api/admin/alerts/config`** | Correctly redacted — returns `{ email: !!…, discord: !!…, slack: !!… }`, booleans only ([index.js:5161–5171](../../web/07_mining_pool_public/back-end-pool/index.js#L5161)). |
| **Settings audit diff** | Records **key names only**, never before/after values, with the reasoning written at the site ([lib/pool-settings.js:1410–1425](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1410)) and a regression test asserting it (`test-admin-guards.js:76–80`, which uses a literal `telegram_bot_token: '123456:SUPERSECRETTOKEN'`). |
| **Node secret resolution + the de-rooting grant** | Three-step resolve — explicit value → explicit path → detected live node dir ([lib/grin-node.js:64–78](../../web/07_mining_pool_public/back-end-pool/lib/grin-node.js#L64)) — reading **by path**, so a node rebuild needs no copy kept in sync. `CHANGE_ME…` placeholders resolve to `''`. `_warnNoSecret` prints the path and the reason, **never the value**, and distinguishes EACCES (with the exact `chgrp`/`chmod` fix) from ENOENT ([:111–134](../../web/07_mining_pool_public/back-end-pool/lib/grin-node.js#L111)). The code's stated expectation — `640 root:grinsecret`, applied by `pool_deroot()` and re-applied by `grin_sync_pool_stratum()` — **matches what the shell sets**; the defect is that a second product sets something else (J8-4). |
| **Poolstats API key** | Never logged (`updateApiKey` logs literally *"API key updated (never logged)"*); sent as `Authorization: Bearer` and never in the body or URL; endpoint forced to `https:` at `start()` or the reporter refuses to run; rotation persists atomically via a `{ mode: 0o600 }` temp file + `rename` that re-reads `pool.json` rather than dumping the merged in-memory config ([lib/poolstats-reporter.js:236–258](../../web/07_mining_pool_public/back-end-pool/lib/poolstats-reporter.js#L236)). One rough edge → J8-7. |
| **Nostr identity key** | `fs.writeFileSync(this.keyFile, hex, { mode: 0o600 })` plus an explicit `chmodSync` ([lib/nostr-payout.js:441–442](../../web/07_mining_pool_public/back-end-pool/lib/nostr-payout.js#L441)); default path is `.nostr_payout_key` beside the DB. The log line names the **file**, not the key. Correctly scoped in its own comment: transport identity only, *"it can never sign a Grin slate, so a leak exposes metadata, not funds"*. |
| **Telegram bot token in a URL** | The token is a **path segment** of `api.telegram.org/bot<token>/sendMessage`, but `postWebhook`'s rejection message is `HTTP ${statusCode}: ${body.slice(0,200)}` — the URL is not interpolated, and the caller wraps it as `Telegram delivery failed: ${err.message}`. So a delivery failure does not print the token. |
| **Wallet-identity TOFU pin can't be silently re-pointed** | `adoptWalletIdentity` has exactly two callers. The admin one is `POST /api/admin/wallet/adopt-identity` — **`freshAdmin`**, refuses when the wallet is unreachable (*"you must not adopt a phantom"*), and writes a `wallet_adopt_identity` audit row carrying **both** `previous` and `adopted` ([index.js:2646–2660](../../web/07_mining_pool_public/back-end-pool/index.js#L2646)). The other is `probeWalletIdentity`'s documented trust-on-first-use, which fires only when the `wallet_identity` row is **absent** ([lib/reconciliation.js:361–386](../../web/07_mining_pool_public/back-end-pool/lib/reconciliation.js#L361)). Checked that nothing can make the row absent on a live pool: `retention.js` deletes from `shares`, `hashrate_history`, `alerts` and `admin_audit_log` only; `resetSection`/`resetAll` touch `pool_config` only; `db.js`'s two destructive migrations drop `admin_audit_log` and `blocks`. `wallet_identity` is never deleted. An unreachable wallet returns `{reachable:false}` **without mutating state**, so a wallet outage cannot re-pin. |
| **Admin session token custody** | `httpOnly` + `sameSite:'strict'` cookies; `public_html/js/auth.js` uses `credentials:'include'` throughout and its header comment states the token is deliberately unreadable to JS. No `localStorage`/`sessionStorage` anywhere in `public_html/js/`. |
| **Miner proof hashing** | Per-record random 16-byte salt, scrypt at 16 MB, format `v1$<saltB64>$<hashB64>`, compared with `crypto.timingSafeEqual` ([lib/owner-proof.js:197–228](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L197)). No shared pepper to manage or back up. As described in memory `project_pool_ip_privacy`. |

---

## §J9 — Settings & config integrity (2026-09-02, add-ons, NOT VPS-TESTED)

### J9-1 — [High] `pool_visibility`, `address_whitelist`, `max_miners` and `mining_mode` are enforced by nothing — a "Private (whitelisted only)" pool is fully open, and the step-up gate on those keys is what makes it look real — **FIXED BY DELETION 2026-09-02**

**Threat actor: anonymous internet.** No credential is needed to defeat this, because there is
nothing to defeat.

Four keys in `pool_info` describe who may mine and how many of them:

| Key | Default | Validator | UI | In `STEP_UP_SETTINGS_KEYS`? | Read by |
|---|---|---|---|---|---|
| `pool_visibility` | `'public'` | yes — `public\|private\|maintenance` | `<select>`: *"Private (whitelisted only)"* | **yes** | **nothing** |
| `address_whitelist` | `'[]'` | none | a dedicated add/remove list manager | **yes** | **nothing** |
| `max_miners` | `0` | yes — integer ≥ 0 | number input, *"0 = no limit"* | **yes** | **nothing** |
| `mining_mode` | `'stratum'` | yes — `stratum\|solo` | `<select>` | no | **nothing** |

Evidence, run over the whole product tree (`web/07_mining_pool_public/`, `--include=*.js
--include=*.html --include=*.json`, `node_modules` excluded). Every hit for all four names is one
of: the `defaults` block, the `validators` block, the admin form, `STEP_UP_SETTINGS_KEYS`, or the
existing test that asserts they are in that Set. There is no consumer:

```
index.js:6299   'address_whitelist',  // who is allowed to mine here     <- the gate list
index.js:6300   'max_miners',
index.js:6301   'pool_visibility',
settings-common.js:333   whitelistGroup.style.display = visibility.value === 'private' ? …
settings-pool-info.html:53   <select id="pool_visibility">  … Private (whitelisted only)
test-admin-guards.js:124   … .every(k => gated.includes(k))
```

The stratum login path is where an allow/deny decision would have to live, and the only moderation
gate it has is the per-address ban:

```js
// lib/stratum-server.js:563 — the ONLY check between a login frame and a session
// Moderation gate: a banned address is refused before a session is created …
```
([stratum-server.js:563–571](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L563))

`buildPublicConfig()` does publish `pool.visibility` at `/api/public/branding`
([pool-settings.js:1188](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1188)),
so the value leaves the box — but no page in `public_html/js/` reads it either. It is a label on a
JSON response.

**Why this is High and the other dead keys in this pass are Low.** §J1-5 (`admin_ip_allowlist`),
§J5-9 (`confirm_depth_*`, since fixed) and §J8-3 (`alerts`) are all keys an operator can set and
see persist while nothing happens. This one is different in three ways:

1. **It is an access control, and the alternative to it working is "anyone in the world can mine
   here".** An operator running a private pool for a known set of addresses gets no error, no
   warning, and a whitelist UI that stores their entries.
2. **The step-up gate is affirmative evidence that it is real.** These four keys were deliberately
   singled out of an otherwise cosmetic section and put behind password re-auth + mandatory 2FA,
   with the comment *"pool_info … also carries the pool's cut and who may mine at all"*
   ([index.js:6296](../../web/07_mining_pool_public/back-end-pool/index.js#L6296)). An operator
   who is challenged for a TOTP code when they edit a field has been told that field matters.
3. **`max_miners` is also the pool's only stated admission bound.** §J6 and §J12 both reason about
   connection caps; this is the one an operator would reach for, and it is not wired to anything.

**Fixed by deletion.** Three options were written up here — (a) delete the keys and the UI,
(b) enforce them in `stratum-server.js` beside the ban check, (c) enforce visibility/whitelist and
delete `max_miners` + `mining_mode`. **(a) was chosen.** The deciding argument is below, and it is
a stronger one than this finding first gave for (a) ("smallest, honest").

**Partial enforcement would have been worse than none.** "Private" is a product mode, not a login
check. Wiring only the stratum gate leaves a private pool publishing every member's address,
balance and hashrate through `/api/pool/miners` (memory `project_pool_ip_privacy` records that
leak as still open), the public leaderboard, `miners-stats.html` and the fortune board. The
operator would get a control that works in the one place they can see it and fails in every place
they cannot — a deeper deception than the current honest-because-total failure, and one that only
surfaces after someone has already trusted it.

Two supporting facts, both checked after the finding was first written:

- **No design commitment existed.** `pool_visibility`, `address_whitelist` and `max_miners` appear
  in **no** design doc and in no shipped CMS copy (`script07_design.md`'s "whitelist" hits are
  Nostr destination whitelisting and the *solo* private pool, a different product). This was schema
  scaffolding written early and never wired — there was no promised feature to honour.
- **`max_miners` should not be built at all.** A global admission cap is a self-DoS lever: an
  attacker opens `max_miners` connections — logins, no valid share required — and no legitimate
  miner can join. §J6-3 already rated a *weaker* version of this High (a leaking per-IP counter
  permanently locking out a shared NAT). Per-IP connection caps are the correct instrument; a
  global one is strictly worse than what already ships.

Enforcement was genuinely cheap — `stratum-server.js` already `require`s `IncentivesManager`,
which builds its own `PoolSettings` via `getDb()`, so the wiring is two lines, and
`owner-proof.js`'s `extraBannedSet()` 60 s in-process cache is the established pattern for a
cached settings read on a hot path; about 25 lines at
[stratum-server.js:563](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L563).
Cheapness was not the constraint. The design gap was, and 25 lines do not close it.

**Six keys were deleted, not four.** `access.invite_codes_enabled` and `access.invite_codes`
(§J9-8) are the same unbuilt gated-membership idea one section over, and went with them.

| Site | Change |
|---|---|
| `lib/pool-settings.js` `defaults.pool_info` | 4 keys removed, replaced by a comment recording why they must not return unwired |
| `lib/pool-settings.js` `defaults.access` | `invite_codes_enabled`, `invite_codes` removed |
| `lib/pool-settings.js` `validators.pool_info` | `pool_visibility`, `mining_mode`, `max_miners` validators removed |
| `lib/pool-settings.js` `buildPublicConfig` | `pool.visibility` no longer published (no page read it) |
| `index.js` `STEP_UP_SETTINGS_KEYS` | 3 entries removed; `pool_fee_percent` stays |
| `admin-panel/settings-pool-info.html` | the whole "Visibility & Mining" section; `max_miners` out of Pool Economics |
| `admin-panel/settings-access.html` | the invite-codes checkbox |
| `admin-panel/settings-common.js` | `updatePoolVisibilityUI()`, its `change` listener, its `populateForm` call, `addToWhitelist()` |
| `scripts/test-admin-guards.js` | the old 4-key gated assertion replaced by 12 that hold all six out of **both** `defaults` and the step-up set |

Orphan `pool_config` rows on an already-deployed pool are inert once the keys are gone — the same
disposition §J1-5 chose. Maintenance mode is unaffected: it lives on the Announcements tab and
never used `pool_visibility`'s vestigial third enum value.

**If a private pool is wanted later**, it goes through `script07_design.md` as a designed feature
covering the stratum gate **and** the public API/leaderboard surface **and** the two questions
these four keys never answered: what happens to a removed member's existing balance, and whether
the whitelist gates withdrawals as well as mining.

---

### J9-2 — [Medium] The step-up gate on `pool_fee_percent` compares with `Number()` while the validator parses with `parseFloat`, so `0x1` reads as "unchanged" against a stored `1` and then stores `0` — the pool fee goes to zero on a plain `secureAdmin` session — **FIXED 2026-09-02**

**Threat actor: stolen admin session.** This defeats the exact control that exists to make a stolen
token less useful than a live operator.

`POST /api/admin/settings/:section` demands step-up in two cases: the section is in
`STEP_UP_SETTINGS_SECTIONS`, or `criticalSettingChanged()` says a key in `STEP_UP_SETTINGS_KEYS`
actually moved ([index.js:6353–6373](../../web/07_mining_pool_public/back-end-pool/index.js#L6353)).
`pool_info` is **not** a step-up section, so for `pool_fee_percent` the whole gate is
`settingValueUnchanged()`. As found:

```js
const na = Number(sa), nb = Number(sb);
if (sa !== '' && sb !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
```

`Number()` accepts `0x`/`0b`/`0o` literals. Every numeric validator in `pool-settings.js` uses
`parseFloat` or `parseInt(v, 10)`, which stop at the `x`. The two disagree, and the comparison is
the half that decides whether a TOTP code is demanded. Demonstrated against the real function and
the real validator, both read out of the source:

```
submitted   stored  step-up skipped?  validator stores
0x10        16      true              0
0X10        16      true              0
0b1010      10      true              0
0o12        10      true              0
0x1         1       true              0
```

So against the shipped default fee of `1.0`, a single request:

```
POST /api/admin/settings/pool_info      Cookie: <stolen secureAdmin token>
{"pool_fee_percent":"0x1"}
```

returns `200`, writes `pool_config` row `pool_info.pool_fee_percent = 0` (`value_type=number`),
`applyToConfig` copies it into `config.pool_fee_percent` at the next restart, and no password
re-auth and no TOTP code was asked for. The audit row **is** written (§J1-2's fix), naming
`pool_fee_percent` — so it is detectable after the fact, which is why this is Medium and not High.

Direction matters: `parseFloat` is a prefix parse, so it is always ≤ `Number` on these literals.
The bypass drives a value **down to 0**, never up. For `pool_fee_percent` that is the pool giving
away its own cut; for `max_miners` it means "unlimited" (moot, per J9-1). It is not a path to
crediting an attacker.

The function's own comment already states the right policy — *"Ambiguity resolves to 'changed' — a
false positive costs one extra TOTP prompt, a false negative silently lets the fee move on a plain
session."* The bug is that a hex literal was not recognised as ambiguous.

**Fixed** — the numeric branch now requires both sides to be plain decimal, and anything else falls
through to the string compare, which reads as changed:

```js
const plainDecimal = (v) =>
  typeof v === 'number' || /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(String(v));
const na = Number(sa), nb = Number(sb);
if (sa !== '' && sb !== '' && plainDecimal(sa) && plainDecimal(sb) &&
    Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
return String(sa) === String(sb);
```

Re-run: `0x1`/`0b1010`/`0o12` are all CHANGED; `'1.0'` vs `1` and `' 1.50 '` vs `1.5` still skip
step-up (a cosmetic save must not prompt); `'2'` vs `1` still prompts; the structural JSON branch is
untouched. Five assertions added.

---

### J9-4 — [Medium] Three settings validators guard on `isNaN()`, so `min_withdrawal = Infinity` persists — every payout rail refuses forever, it survives restart, and the admin panel renders it as an empty field — **FIXED 2026-09-02**

**Threat actor: logged-in admin / the system.** A one-token typo or paste. §J7-5 fixed this class on
four *route* inputs and explicitly did not cover `pool-settings.js`, which is this session's file.

`parseFloat('Infinity')` is `Infinity`; so is `parseFloat('1e400')`. `isNaN(Infinity)` is `false`.
Three validators had no upper bound to catch it:

| Validator | Guard as found | `'Infinity'` → |
|---|---|---|
| `payout.min_withdrawal` | `isNaN(n) \|\| n <= 0` | **accepted** |
| `incentives.join_bonus_amount` (`nonNeg`) | `isNaN(n) \|\| n < 0` | **accepted** |
| `incentives.jackpot_amount` (`nonNeg`) | `isNaN(n) \|\| n < 0` | **accepted** |
| `pool_info.pool_fee_percent` | `… n > 50` | throws |
| `payout.withdrawal_fee` | `… n > 1` | throws |
| `incentives.*_percent` (`percent`) | `… n > 100` | throws |
| every `intRange` / `parseInt` key | `parseInt('Infinity')` is `NaN` | throws |

Run against the real validators:

```
payout.min_withdrawal          "Infinity" -> Infinity   finite=false
incentives.join_bonus_amount   "Infinity" -> Infinity   finite=false
incentives.join_bonus_amount   "1e400"    -> Infinity   finite=false
incentives.jackpot_amount      "Infinity" -> Infinity   finite=false
```

`min_withdrawal` is the one that bites. Follow it through:

1. `updateSection` stores `valueStr = 'Infinity'`, `value_type = 'number'`
   ([pool-settings.js:1408–1416](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1408)).
2. `getSection` reads it back with `parseFloat` → `Infinity`.
3. `applyToConfig` copies it: `config.min_withdrawal = payout.min_withdrawal`
   ([pool-settings.js:1536](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1536)).
   The cross-field guard right above it is `config.withdrawal_fee >= config.min_withdrawal` —
   `0.04 >= Infinity` is false, so the guard does not fire.
4. Neither `validateConfig` sees it. `lib/config.js`'s runs *before* `mergeDbSettings`, and its test
   is `min_withdrawal <= 0`; `index.js`'s does not check the key at all.
5. Every rail then reads `const minW = this.config.min_withdrawal || 25.0;` — `Infinity` is truthy,
   so `minW` is `Infinity` and **every** withdrawal request is refused, on Tor, slatepack and Nostr
   alike ([withdrawal-scheduler.js:698, 787, 938](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L698)).

It is durable (a `pool_config` row, re-applied on every boot) and it is **invisible**:
`JSON.stringify(Infinity)` is `null`, so `GET /api/admin/settings/payout` sends
`"min_withdrawal": null` and the panel renders an **empty** Minimum Withdrawal box. The operator
sees a blank field, not a broken one — §J7-5's point 2, reached through the settings surface.

The two incentives keys are currently blocked one layer down: `maybePayJoinBonus` and
`payBlockFinderJackpot` both call `debitPrizePool(amount, …)`, whose overdraw check
`prizePoolBalance() < Infinity` is true, so the credit is refused and no balance is corrupted
([incentives.js:264–280, 309–330](../../web/07_mining_pool_public/back-end-pool/lib/incentives.js#L264)).
That is luck, not defence — §J7-5 established that this is exactly the guard that stops working the
moment any bucket holds `+Inf`.

**Fixed** — all three now use `Number.isFinite`, with the error text saying "finite":

```js
if (!Number.isFinite(n) || n <= 0) throw new Error('min_withdrawal must be a finite number > 0');
…
if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a finite number >= 0`);
```

Five assertions added, including a control that `'25'` and `'0.5'` still validate.

---

### J9-5 — [Low] §J1-6 and §J7-8's prototype-walking schema lookups — **FIXED 2026-09-02**

Not a new finding: this is the fix §J1-6 handed to this session and §J7-8 asked to be treated as
required rather than tidy-up. Recorded here only so the two open items can be closed.

Both gates walked `Object.prototype`: `if (!PoolSettings.defaults[section])` accepted
`constructor`, `toString`, `valueOf`, `__proto__` and `hasOwnProperty`; `if (!(key in
PoolSettings.defaults[section]))` accepted `name`, `length`, `call`, `toString`. §J7-8's point
stands and is the reason this is a fix and not a shrug: the key gate is the one settings write that
produces **no** `admin_audit_log` row, because the diff is taken over `Object.keys(afterState)` and
a prototype key never appears there.

**Fixed** with two own-property helpers used at all four call sites — `getSection`, `updateSection`
(section + key), `resetSection`:

```js
const hasSection = (section) =>
  Object.prototype.hasOwnProperty.call(PoolSettings.defaults, section) &&
  PoolSettings.defaults[section] !== null && typeof PoolSettings.defaults[section] === 'object';
const hasKey = (section, key) =>
  Object.prototype.hasOwnProperty.call(PoolSettings.defaults[section], key);
```
([pool-settings.js:55–60](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L55))

The `typeof === 'object'` half is not decoration: without it a future own-property that happens to
be a function or a string would pass the section gate and then be spread into `{}`.

Verified against the real class: all five prototype names are refused by `getSection`,
`updateSection` and `resetSection`, all five are refused as keys, and `pool_info` / `pool_name`
still work. Eleven assertions added. **§J1-6 and §J7-8 are closed by this.**

---

### J9-7 — [Low] The pool's only fail-open security switch failed open in complete silence — **FIXED 2026-09-02**

**Threat actor: the system.** This answers §J2's handoff (*"whether a settings-read failure should
be loud is J9's question"*).

The enumeration the plan asked for. Every security-relevant switch, and what it does when the
settings read fails:

| Switch | Read shape | On read error | Verdict |
|---|---|---|---|
| `access.require_admin_totp` | `String(…) === 'true'` ([index.js:817](../../web/07_mining_pool_public/back-end-pool/index.js#L817)) | **fail OPEN** — 2FA optional | correct, was **silent** |
| `access.network_map_public` | `=== true \|\| === 'true'` | fail closed — feed 404s | correct |
| `access.session_timeout_hours` / `_absolute_hours` | `sessionPolicyProvider` | falls back 1 h idle / 12 h absolute | correct |
| `access.extra_banned_passwords` | raw `pool_config` row, 60 s cache | fail open to the hardcoded seed | correct — additions-only by design |
| `payout.tor_preflight_gate` | `config` (startup) | fail open | deliberate; §J4-7 made it non-silent |
| `payout.dormancy_enabled` | `flag()` | throws → no sweep | fail closed |
| `database.retention_enabled` | `=== true \|\| === 'true'` | throws → no prune | fail closed |
| `incentives.*` | `flag()` | throws → no credit | fail closed |
| `criticalSettingChanged` | `getSection` in `try` | `return true` → demand step-up | fail closed, and commented as such |

One fail-open switch, and the reasoning behind it is right — failing closed would brick every
step-up endpoint, *including the ones needed to repair the settings*, on a transient DB error, and
the break-glass CLI would be the only way back. Keep it.

But it said nothing. A `getSection('access')` failure silently downgraded a pool from mandatory 2FA
to optional 2FA with no log line, no alert and no audit row — and because `totpIsMandatory()` is
called per-request from `requireTotpEnrolled` and `stepUpRefused`, the downgrade lasts exactly as
long as the DB problem and then heals, leaving nothing behind.

**Fixed** — the catch now logs, throttled to one line a minute so a persistently broken DB cannot
flood the journal on a per-request read:

```js
console.error(
  `[SECURITY] access.require_admin_totp is unreadable (${e.message}) — mandatory 2FA ` +
  `is being treated as OFF until the settings read succeeds. Check the database.`
);
```

An `alerts` row would be better than a log line and is the natural home for it, but per §J8-3 that
section currently delivers nowhere; this is the honest version until that is settled.

---

### J9-9 — [Info] Verified correct, with evidence — including four inbound handoffs answered

**1. Trap 1 does not exist in this product.** All 22 boolean-shaped keys, checked at every read
site: `flag()` (`v === true || v === 'true'`) in `incentives.js:17`, `lottery.js:5`,
`dormancy.js:43`; the same test inline in `retention.js:65` and `networkMapPublic()`;
`String(…) === 'true'` in `totpIsMandatory()`; and `buildPublicConfig()` coercing every public
boolean before it leaves the server, so `branding.js`'s bare truthiness tests
(`if (seo.robots_noindex)`, `if (a.cookie_consent_enabled)`, `!!brand.allow_theme_switch`) never see
a string. A quoted `"false"` reads as **off** at every one of them. Nineteen of the 22 have no
validator, so this is a property of the readers, not the writer — worth stating, because a new
reader written as `if (s.some_flag)` would reintroduce it immediately.

**2. The admin panel cannot disagree with the server about a switch.** `populateForm` binds a
checkbox with `el.checked = value === true || value === 'true'`
([settings-common.js:78](../../web/07_mining_pool_public/back-end-pool/admin-panel/settings-common.js#L78))
— the identical test. A value that is neither (an object, `"yes"`, `"1"`) renders **unchecked** and
reads as **false**. There is no shape that shows "2FA required: ON" while the server reads it off.

**3. The server-side validator is the authority, not the form** — but the authority is thinner than
it looks. `updateSection` rejects any key not in `defaults[section]` and runs the section's
validator server-side, so the harvester cannot introduce a key. **68 of ~143 keys have no validator
at all**, though, so for those the only server-side check is "this key exists" — the *type* is
whatever the client sent, and `updateSection` derives `value_type` from it. That is what made J9-3
and J9-4 possible, and it is why the answer to "is the form the authority?" is "no, but for 68 keys
the server is only checking the name."

**4. `POST /api/admin/settings/:section/restore` is `freshAdmin`**
([index.js:6391](../../web/07_mining_pool_public/back-end-pool/index.js#L6391)) — password re-auth
**and** `requireTotpEnrolled`. It cannot roll a security setting back on a plain session.
`resetSection` writes a `reset_settings` audit row, and unlike `updateSection` it always writes one
(there is no no-op suppression), which is the right asymmetry for a bulk delete.

**5. `resetAll()` is defined and unrouted — leave it that way.**
([pool-settings.js:1515](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1515))
It is `DELETE FROM pool_config` with **no WHERE**, and three subsystems keep private rows in that
table outside `PoolSettings.defaults`: `_migrations` markers (`pages_seeded`, `regions_seeded`),
the `ads` section ([ads.js:220, 418](../../web/07_mining_pool_public/back-end-pool/lib/ads.js#L220)),
and the dormancy anchor. Wiring `resetAll` to a route would re-arm every one-time seeder at the
next restart — re-seeding shipped CMS pages and the grinium.com default regions **over the
operator's edits**. If it is ever exposed it needs `WHERE section IN (…)` over
`Object.keys(defaults)` first.

**6. §J3's handoff answered — no.** `access.extra_banned_passwords` cannot be left in a shape that
parses as an empty array by accident: the validator always returns `JSON.stringify(cleaned)`, an
array literal, and `''` / `'[]'` normalise to `'[]'` (the operator explicitly clearing the list).
`owner-proof.js extraBannedSet()` reads the raw row, `JSON.parse`s it, and requires `Array.isArray`
before use, falling through to the hardcoded seed otherwise
([owner-proof.js:152–170](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L152)).
Both the 60 s cache and the fail-open-to-seed are correct: the list is additions-only on top of the
seed and the structural rules, so the failure mode is "an operator's extra entry is briefly not
enforced", never "a banned password becomes usable proof".

**7. §J4's handoff answered — partly, and one item is worse than "can it emit a non-number".**
`withdrawal_cooldown_minutes`, `nostr_destination_cooldown_hours` and `nostr_pending_ttl_minutes`
all have `parseInt` validators that throw on `NaN` and enforce ranges, so no, they cannot emit a
non-number. But **`max_pending_withdrawals` and `max_user_pending` have no validator at all** and
`applyToConfig` copies them verbatim
([pool-settings.js:1519–1524](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1519)).
The consumer saves it: both are read once in the scheduler constructor as
`Math.max(1, parseInt(config.max_pending_withdrawals, 10) || 100)`
([withdrawal-scheduler.js:66–67](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L66)),
so garbage falls back to the default. Two riders: the read is **constructor-time**, so editing
either cap in the panel does nothing until a restart and the UI says nothing about that; and there
is no **upper** bound, so an admin can set `max_pending_withdrawals` to any integer and remove the
pool's global pending cap entirely. `slatepack_ttl_hours` and `wallet_send_timeout_ms`, the other
two §J4 named, are **not settings keys at all** — they exist only in `pool.json`, so only a
hand-edit reaches them, which is on-box root and §J16's file.

**8. `getSection`'s per-key JSON fallback is right.** A malformed `json` row logs and keeps that
key's default instead of throwing
([pool-settings.js:1156–1168](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1156)).
Checked against the security-relevant JSON keys: `nostr_nip05_domains` (the NIP-05 allowlist) falls
back through `applyToConfig`'s `parseJsonArray(…, ['goblin.st'])` to the safe default, not to an
empty allowlist; `enabled_themes`, `page_seo`, `custom_theme` and `banners` all fall back to their
shipped defaults. No corrupt row widens anything.

**9. Both `validateConfig` functions run, and they are different functions.** `lib/config.js`'s is
called from inside `loadConfig` (jwt_secret ≥32 chars, with no auto-generate — correct; network;
`min_withdrawal > 0`; `withdrawal_fee` non-negative and below the floor). `index.js:300`'s is a
*second*, separately-defined function called at `index.js:402` (network, port range, `db_path`
anchored to `/opt/grin/` or `./` with a traversal check, stratum port range, fee 0–50). The name
collision is confusing but not a bug — `index.js` imports only `loadConfig` and `mergeDbSettings`
from the module. Worth a rename the next time either is touched.

**10. `applyToConfig`'s cross-field guard is correct and is the only place it can be.** Per-key
validators see one value; lowering `min_withdrawal` on its own can strand a stored `withdrawal_fee`
above the new floor, which would make every at-minimum payout net ≤ 0. The guard runs after both
are merged and falls back to `withdrawal_fee = 0` with a warning
([pool-settings.js:1540–1548](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1540)).
Same reasoning as the `incentives` lottery-pot rule inside `updateSection`'s transaction, which
rolls the whole update back — and takes the audit row with it — when the two pots exceed 100%.

## §J10 — Uploads, assets, CMS & ads (2026-09-02, add-ons, NOT VPS-TESTED)

### J10-1 — [Medium] The CMS media endpoint took the stored file extension from the client-declared MIME and never read a byte of the file, so §A's stored-XSS fix was absent from the second upload endpoint — **FIXED 2026-09-02**

**Threat actor: stolen admin session** (a legitimate admin has no reason to do this, and the
result is a file under the operator's own TLS name).

§A hardened `POST /api/admin/assets/upload` on exactly this point, and the fix is still intact:
`saveAsset` calls `detectImage()` on the buffer and builds the name as
`${type}_${ts}_${rand}.${detected.ext}` — the uploader's filename and declared MIME reach disk
nowhere ([asset-manager.js:103-113](../../web/07_mining_pool_public/back-end-pool/lib/asset-manager.js#L103-L113)).

`POST /api/admin/media`, added later for the Quill CMS editor, did neither. Before this session:

```js
const ALLOWED_IMG = { 'image/jpeg': '.jpg', …, 'image/svg+xml': '.svg' };   // index.js:513
mediaUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const ext = ALLOWED_IMG[file.mimetype] || '.bin';                     //  ← :518
      …
      cb(null, `${Date.now()}-${rand}-${safe}${ext}`);
```

`file.mimetype` is the part's `Content-Type` header — attacker-chosen. It is the *only* gate
(`fileFilter` tests the same map) and it is what names the file. There is no sniff anywhere in
the path, and `diskStorage` means the bytes are already written before the handler sees them.

**Demonstrated**, driving the real multer config with a synthetic multipart body:

```
declared mimetype : image/svg+xml
original name     : notes.txt
stored filename   : 1788363314180-174ac525-notes.svg
bytes on disk     : "<html><body><script>alert(document.domain)</script></body></html>"
```

nginx maps `.svg` → `image/svg+xml` from `mime.types`, so that file is served as a scriptable
document from the pool's own origin.

**Why Medium and not High.** It does not execute today. `location /uploads/` sets
`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`
([07_grin_mining_public_pool.sh:1434](../../scripts/07_grin_mining_public_pool.sh#L1434)) and the
Express fallback mount sets the identical header
([index.js:797-806](../../web/07_mining_pool_public/back-end-pool/index.js#L797-L806)), so a
directly-opened SVG lands in an opaque origin with scripts blocked twice over. **The defect is
that this was the whole defence.** §A deliberately built two layers because that header is one
`add_header` in one `location` in a generated file, and §I1 is the recorded incident where a
child block silently discarded the parent's entire header set — the exact failure mode this
endpoint had no second line for. A pool whose vhost predates the §I1 snippets, or whose operator
hand-edits that block, loses containment with nothing to notice it.

**Fix applied.** `detectImage` and a new `WEBP_SNIFFER` are exported from `asset-manager.js`;
`mediaUpload` moves to `memoryStorage`; the route sniffs the buffer, derives the extension from
the detected type, asserts path containment and writes the file itself
([index.js:2760-2790](../../web/07_mining_pool_public/back-end-pool/index.js#L2760-L2790)). The
declared-MIME map survives only as a cheap pre-filter and now uses `hasOwnProperty` rather than
a bare property lookup, matching §J9-5.

WEBP is the wrinkle worth recording: the CMS endpoint accepts it and the branding-asset endpoint
never has (`allowedMimeTypes` has four entries, and `SNIFFERS` had three). So WEBP detection is
**not** in the shared `SNIFFERS` list — it is a separate export the media route passes in as
`extra`. Folding it into `SNIFFERS` as a tidy-up would silently let a WEBP file through the
logo/favicon endpoint by declaring itself `image/png`; `test-cms-uploads.js` asserts both
directions.

---

### J10-4 — [Medium] `seo.site_url` shipped as `https://grinium.com`, so every fresh pool declared a domain the operator does not own as the canonical home of the operator's own content — **FIXED 2026-09-02**

**Threat actor: third-party domain holder.** No attack is needed for the damage; an attack only
determines who benefits.

`siteOrigin()` is the single origin used by the whole SEO surface, and it prefers the setting
over the request:

```js
function siteOrigin(req) {
  const seo = poolSettings.getSection('seo');
  if (seo.site_url) return String(seo.site_url).replace(/\/+$/, '');
  return (req.protocol || 'https') + '://' + req.get('host');
}
```

`seo.site_url` defaulted to `'https://grinium.com'`
([pool-settings.js:159](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L159)),
`getSection` returns the default whenever no `pool_config` row exists, and **nothing writes that
row at install time** — a full-tree grep for `site_url` finds the default, its validator, one
`buildPublicConfig` line and `siteOrigin`; the installer never mentions it. So the fallback branch
was dead and every pool that had not hand-edited SEO settings emitted, verbatim:

| Surface | What it said |
|---|---|
| `/sitemap.xml` | `<loc>https://grinium.com/…</loc>` for every page, CMS page and blog post ([index.js:1399-1429](../../web/07_mining_pool_public/back-end-pool/index.js#L1399-L1429)) |
| `/robots.txt` | `Sitemap: https://grinium.com/sitemap.xml` ([:1374](../../web/07_mining_pool_public/back-end-pool/index.js#L1374)) |
| `/blog/rss.xml` | every `<link>` and `<guid isPermaLink="true">` ([:1327-1359](../../web/07_mining_pool_public/back-end-pool/index.js#L1327)) |
| `/blog/<slug>`, `/page.html?p=` | server-rendered `<link rel="canonical">` **and** `og:url` |
| every other public page | `branding.js` builds the client-side canonical, `og:url` and the JSON-LD `url` from the same value ([public_html/js/branding.js:232-245](../../web/07_mining_pool_public/public_html/js/branding.js#L232-L245), [:291](../../web/07_mining_pool_public/public_html/js/branding.js#L291)) |

**Failure scenario.** An operator installs the pool at `pool.example.com`, writes three blog
posts and shares them. Every unfurl on Discord/Telegram/Slack resolves `og:url` to
`grinium.com/blog/…`; a search engine reads a canonical pointing off-site and drops
`pool.example.com` in favour of a host that does not serve that content; `robots.txt` advertises a
sitemap on a domain the operator has no control over. The pool works perfectly the whole time and
nothing in the admin panel hints at it — the field is a blank-looking text input buried in SEO
settings. If that domain later lapses, whoever buys it inherits the canonical, the RSS
permalinks and the social-card destination of every pool ever deployed from this toolkit.

**Fix applied.** The default is now `''`
([pool-settings.js:159-166](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L159)),
and `siteOrigin` gains a middle branch that derives the origin from the installer-set domain
([index.js:1363-1372](../../web/07_mining_pool_public/back-end-pool/index.js#L1363-L1372)):

```js
if (seo.site_url) return …;                                   // operator override, unchanged
if (config.subdomain) return 'https://' + config.subdomain;   // pool.json, installer-written
return (req.protocol || 'https') + '://' + req.get('host');   // last resort
```

`config.subdomain` is already loaded ([lib/config.js:200](../../web/07_mining_pool_public/back-end-pool/lib/config.js#L200))
from the value the installer prompts for and writes
([07_grin_mining_public_pool.sh:718-732](../../scripts/07_grin_mining_public_pool.sh#L718)),
so this needs no new configuration.

**The ordering is the point, and a naive fix gets it wrong.** Simply blanking the default would
have handed the origin to `req.get('host')` — the client-supplied Host header — on a vhost that,
being the only `listen 443` server the script writes, is the box's default server and therefore
answers on any Host. That branch has been unreachable for the life of this code precisely because
`site_url` was never empty; blanking the default without the `config.subdomain` step would have
made it live in the same commit. It is kept only as the dev/no-installer fallback.

One line was also added at the `/api/public/config` handler so the client half agrees with the
server half ([index.js:983-990](../../web/07_mining_pool_public/back-end-pool/index.js#L983)):
without it, the blanked default would merely *drop* `branding.js`'s canonical from every
non-server-rendered page rather than correcting it.

**Left as-is, deliberately:** `branding.website_link` also defaults to `https://grinium.com`
([pool-settings.js:141](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L141)).
That one is a visible footer link, sitting in the Branding settings page with a label, and it is a
default the operator is *meant* to see and change — not a machine-readable identity claim made on
their behalf. Same for the GRINIUM strings in `og_title`, `meta_description` and
`twitter_handle`. See the handoff below for the one member of this family that is not cosmetic.

---

### J10-5 — [Low] `POST /api/admin/assets/upload` with no `?type=` defaulted to `'custom'`, which is not an asset type, so the request always failed with an error naming an internal constant — **FIXED 2026-09-02**

**Threat actor: none — the system.** A usability defect on an admin endpoint, recorded because
it is a dead branch that reads as a working one.

`const assetType = req.query.type || 'custom';` fed `saveAsset`, whose first line is
`if (!this.allowedTypes.includes(assetType)) throw new Error(...)` — and `allowedTypes` is
`['logo','logo_dark','favicon','og_image','apple_touch_icon','icon_192','icon_512']`
([asset-manager.js:61](../../web/07_mining_pool_public/back-end-pool/lib/asset-manager.js#L61)).
`'custom'` has never been in it. The admin panel always sends `?type=`
([settings-common.js:289](../../web/07_mining_pool_public/back-end-pool/admin-panel/settings-common.js#L289)),
so the branch is unreachable from the UI and the failure only appears to someone calling the API
directly — who gets `Invalid asset type: custom` and no list of what would work. Worse, the
default *looks* like a supported "miscellaneous upload" mode that a later change might rely on.

**Fix applied:** the route validates `?type=` up front against `assetManager.allowedTypes` and
returns the valid set in the error
([index.js:6639-6647](../../web/07_mining_pool_public/back-end-pool/index.js#L6639)).

---

### J10-6 — [Info] Verified correct, with evidence

Every row below was read and, where a behaviour was in question, exercised — not assumed.

| Checked | Result |
|---|---|
| **`DELETE /api/admin/assets/:filename` traversal** (the plan's first item) | Closed, three ways. Express `:filename` cannot match a `/`; the handler looks the name up in `pool_assets` with a bound parameter *before* touching the disk, so an unknown name throws `Asset not found`; and the unlink uses `path.basename(asset.filename)` — the stored, server-generated name — with a `path.dirname(...) === uploadDir` assert ([asset-manager.js:154-173](../../web/07_mining_pool_public/back-end-pool/lib/asset-manager.js#L154-L173)). `..%2F..%2Fetc%2Fpasswd` decodes to one param, matches no row, and stops at the DB |
| **Sandbox CSP on every path that serves an uploaded file** | Present on **both** serving paths, which matters because they are different code. In production nginx serves `/uploads/` and `/custom/` from `alias` directives — Express never sees them — and each block re-`include`s the common header snippet *and* sets `default-src 'none'; style-src 'unsafe-inline'; sandbox` with `always`, so it is on the `try_files … =404` error response too ([07_grin_mining_public_pool.sh:1428-1451](../../scripts/07_grin_mining_public_pool.sh#L1428)). The Express fallback mount sets the identical pair in `setHeaders` ([index.js:797-806](../../web/07_mining_pool_public/back-end-pool/index.js#L797)) and, being `send`'s pre-stream hook, it also covers a 304 |
| **nginx `alias` traversal on `/uploads/`, `/custom/`** | Not present. Both locations carry the trailing slash (`location /uploads/`, not `location /uploads`), so the `/uploads../` escape does not match the prefix at all; and nginx normalises `..` out of the URI before location matching |
| **`fs.readFileSync(path.join(config.web_dir, name))`** (the plan's named site) | `readShell(name)` is called from exactly two places, both with a hardcoded literal — `'post.html'` and `'page.html'`. No request value reaches it |
| **RSS + sitemap XML escaping** | Both escape `& < >` and every interpolated value is element **text**; the one attribute in the feed (`isPermaLink="true"`) is a literal, so `"` being unescaped cannot break out. Post slugs additionally pass `encodeURIComponent` in the RSS `<link>`/`<guid>` |
| **`:slug` / `:key` traversal or file read** | `postsManager.getPublic` / `pagesManager.getPublic` bind the value into a parameterised `WHERE slug = ?` and return a row or `null` — the param never touches a path. Slugs are written only through `slugify()` (`[a-z0-9-]`, ≤64/80 chars), including in the five-slug legacy `pages` migration and both content seeds |
| **Host-header injection into the server-rendered `<head>`** | Contained even before J10-4's change: every value in `seoHead()` goes through `attrEsc`, which escapes `& < > " '` ([index.js:1509-1511](../../web/07_mining_pool_public/back-end-pool/index.js#L1509)) — including `canonical`, `og:url` and the 404 branch's `origin + '/blog/' + req.params.slug` |
| **`toDescription()` on authored HTML** | Drops `<script>`/`<style>` **bodies** before stripping tags, and decodes entities only *after* tag-stripping, so `&lt;b&gt;` can never become a tag; output is then `attrEsc`'d into the meta content |
| **`ALLOWED_IMG[file.mimetype]` prototype walk** | **Checked and NOT reachable**, despite matching §J1-6 / §J7-8 / §J9-5 exactly. `ALLOWED_IMG['constructor']` is truthy and would have put `function Object() { [native code] }` into the filename — but busboy composes the value as `` `${conType.type}/${conType.subtype}` `` (`node_modules/busboy/lib/types/multipart.js:325-327`), so `file.mimetype` always contains a `/` and no `Object.prototype` key does. Recorded so a later session does not re-flag it. The lookup was switched to `hasOwnProperty` anyway as part of J10-1 |
| **CSRF on the multipart upload endpoints** | Covered. A multipart POST is a "simple request" that needs no preflight, but both auth cookies are `sameSite: 'strict'` ([index.js:934](../../web/07_mining_pool_public/back-end-pool/index.js#L934), [:943](../../web/07_mining_pool_public/back-end-pool/index.js#L943)), and CORS is `GET`-only with no `Allow-Credentials` |
| **`/api/public/ads` field exposure** | `publicByPlacement` selects an explicit column list; `notes` (the admin-only sponsor memo — contact and payment terms), `weight`, `impressions`, `clicks` and both timestamps are not in it ([ads.js:135-144](../../web/07_mining_pool_public/back-end-pool/lib/ads.js#L135)). `?placement=` is validated against a fixed array and an array-valued param returns `[]` |
| **Draft / unpublished enumeration** | No oracle. `posts.getPublic` requires `status='published'`, `pages.getPublic` requires `is_published=1` **and** non-empty HTML, and unknown vs unpublished return the identical 404 on both the API and the shell routes |
| **`update()`'s dynamic `SET` clause in `ads`/`pages`/`posts`** | Safe: `Object.keys` runs over `_clean`'s output, which only ever assigns from a fixed key set; `_id` is stripped from the input shape and never copied into it. Values are bound. (§D's "`_clean()`-built SET clauses (fixed key set)" re-confirmed after three files changed since) |
| **`parseInt(req.params.id)` → `NaN` on the six CMS CRUD routes** | Not a fault. Suspected as a §J7-4 sibling and tested against `node:sqlite` directly: binding `NaN` neither throws nor matches — `get(NaN)` returns `undefined` and `run(NaN)` reports `changes: 0`. So `/api/admin/pages/abc` returns a clean 404, which is correct |
| **multer field limits** | Neither instance sets `fields`/`parts`/`fieldSize`, so multer's defaults apply (`fieldSize` 1 MB, `fields`/`parts` unbounded). Both endpoints are `secureAdmin`, and `files: 1` plus the byte cap bounds the file half. Noted, not a finding at this tier — but it belongs in §J12's sweep if that session wants a complete picture of admin-side body limits |
| **`/sitemap.xml` cost** | Three queries per request (`listEnabled`, a `COUNT(*)`, a 50-row page), on the `public` bucket behind nginx's 600 r/m `_api` zone. Not a lever |

---

## §J11 — Public API leakage & privacy (2026-09-02, add-ons, NOT VPS-TESTED)

### J11-1 — [Medium] The address mask is a 9+4 truncation and six sibling public feeds publish the full addresses that invert it, so §C1's fix, the dormant-balance mask and the live-session mask are all reversible by join — **FIXED 2026-09-02 (option b; see the §J11 resolution pass — it was SEVEN feeds, not six)**

**Threat actor: anonymous internet / competitor.**

`maskAddr` keeps nine leading and four trailing characters
([index.js:295-298](../../web/07_mining_pool_public/back-end-pool/index.js#L295)), and three
more copies of the same function exist —
[index.js:2195](../../web/07_mining_pool_public/back-end-pool/index.js#L2195) (live sessions),
[dormancy.js:47-51](../../web/07_mining_pool_public/back-end-pool/lib/dormancy.js#L47) and
[lottery.js:539](../../web/07_mining_pool_public/back-end-pool/lib/lottery.js#L539) (10+4).

Four public surfaces mask. **Six do not:**

| Route | Field | Cap | Notes |
|---|---|---|---|
| `GET /api/pool/blocks` | `found_by` | 500/page, **`offset` has no upper bound** ([index.js:2271](../../web/07_mining_pool_public/back-end-pool/index.js#L2271)) | blocks are never pruned, so this walks the whole history |
| `GET /api/pool/top-block-finders` | `found_by AS grin_address` + `total_reward`, sorted desc | 1000 rows / 3650 days ([index.js:3005](../../web/07_mining_pool_public/back-end-pool/index.js#L3005)) | the exact shape §C1 masked on `/api/pool/miners` |
| `GET /api/pool/payments` | `grin_address` | 500 ([index.js:3041](../../web/07_mining_pool_public/back-end-pool/index.js#L3041)) | documented as deliberate |
| `GET /api/pool/donors` | `grin_address AS address` | 100 ([index.js:3296](../../web/07_mining_pool_public/back-end-pool/index.js#L3296)) | |
| `GET /api/stratum/top-miners` | `grin_address` | 1000 ([index.js:4636](../../web/07_mining_pool_public/back-end-pool/index.js#L4636) → [hashrate-tracker.js:133](../../web/07_mining_pool_public/back-end-pool/lib/hashrate-tracker.js#L133)) | |
| `GET /api/stratum/top-avg-hashrate` | `grin_address` | 1000 / 90 days ([hashrate-tracker.js:162](../../web/07_mining_pool_public/back-end-pool/lib/hashrate-tracker.js#L162)) | |

Nine leading plus four trailing bech32 characters is not a partial identifier — it is a unique
one. Demonstrated against the real schema:

```
── GET /api/pool/miners — MASKED
   {"grin_address":"grin1qqqq…zz9x","balance":1234.5,"is_online":1}

── GET /api/pool/top-block-finders — FULL
   {"grin_address":"grin1qqqqqqq…qqqzzzz9x","blocks_found":1,"total_reward":60}

── Mask inversion
   masked row from /api/pool/miners : grin1qqqq…zz9x  balance 1234.5
   candidates from the FULL feeds   : 1
   recovered full address           : grin1qqqqqqq…qqqzzzz9x
```

So the mask stops a copy-paste harvest and nothing else. Three consequences, worst first:

1. **`/api/pool/unclaimed` becomes a targeting list.** It publishes, per masked address,
   `balance`, `last_activity_at`, `idle_days`, `dispose_at` and `days_until_disposal`
   ([dormancy.js:156-164](../../web/07_mining_pool_public/back-end-pool/lib/dormancy.js#L156)).
   Un-masked by the join, that is "this exact address holds N GRIN, its owner has not been
   seen in 700 days, and the pool will sweep it in 30" — an inventory of balances whose owners
   demonstrably are not watching, which is precisely the population an ownership-gate attack
   (§J3) wants.
2. **§C1's fix does not hold.** `/api/pool/miners` is the rich list sorted by balance; the
   join restores the address→balance mapping its own API doc line says "is not" public
   ([index.js:1140](../../web/07_mining_pool_public/back-end-pool/index.js#L1140)).
3. **`/api/stratum/stats`'s session mask does not hold either** — answering §J6's handoff
   below.

**The disposition §C1 asked for.** `/api/pool/miners` no longer publishes the raw pair, so
§C1's specific finding is closed; the *control it installed* is not effective. The choice is
between three coherent positions, and the pool currently holds none of them:

- **(a) Address-as-identity, stated.** Drop the masks. They cost nothing to an attacker and
  buy the operator a false claim. Publish full addresses everywhere and say so on the privacy
  page. Cheapest, most honest, worst for miners.
- **(b) Mask consistently and break the deep-link.** Mask the three leaderboards and
  `found_by`. The account-page link (`addrCell`,
  [miners-stats.html:284-288](../../web/07_mining_pool_public/public_html/miners-stats.html#L284))
  then cannot be built from a leaderboard row, which is the actual cost — a miner would paste
  their own address instead of clicking their row. **Recommended — and this is what was
  built.**
- **(c) Opt-in leaderboards.** A per-account "show me on the leaderboard" flag, default off.
  Correct and the most work: it needs an ownership-gated write, a UI, and it silently empties
  the leaderboards until miners find the switch.

**Resolution: option (b), 2026-09-02.** Nine public list routes now mask (the six above, plus a
seventh the table missed — `/api/stratum/hashrate`'s `top_miners` — and the two that already
did), the four account-page deep-links are gone, and the invariant is asserted per route by the
test suite. Detail, and what it costs a miner, in the resolution pass below.

### J11-3 — [Medium] The account dossier is address-addressable with no login, the leaderboard hands out the addresses, and the page invites search engines to index the result — **FIXED 2026-09-02 (both halves: `noindex, follow` on the page, and J11-1 removed every link into it)**

**Threat actor: anonymous internet, competitor, bulk crawler.** This answers §J3's handoff.

`GET /api/account/:addr` ([index.js:3075-3199](../../web/07_mining_pool_public/back-end-pool/index.js#L3075))
returns, for any address, with no credential: `balance`, `balance_locked`, `total`,
`total_paid`, `payouts_count`, `blocks_found`, the full pending withdrawal row (id, amount,
method, status, retry_count, next_retry_at), `is_online`, `last_seen_at`, `created_at`, share
count, hashrate, the dormancy countdown, `has_recorded_ip` / `has_recorded_pass`, the evidence
change timestamps, `donation_percent`, `password_proof.state` and `.live`, and the Nostr
destination username. `GET /api/account/:addr/workers`
([index.js:3210](../../web/07_mining_pool_public/back-end-pool/index.js#L3210)) adds the
per-rig inventory: worker name, hashrate, share count, last share, reject% and stale%.

Each field is defensible on its own and §J8 confirmed no proof hash escapes. The finding is
the **composition at scale**: J11-1 supplies up to 1000 full addresses in one request, and the
`public` bucket allows 1200/min, so one IP holds a complete per-miner dossier of the pool —
balance, earnings, rig count, rig names, uptime and payout state — in **under a minute**. That
is not "the address is identity"; it is a published customer list.

**And the pool asks to have it indexed.** `account-settings.html` declares
`<meta name="robots" content="index, follow, max-snippet:-1">`
([account-settings.html:8](../../web/07_mining_pool_public/public_html/account-settings.html#L8)),
`robots.txt` defaults to `Disallow:` — allow everything
([index.js:1383](../../web/07_mining_pool_public/back-end-pool/index.js#L1383)) — and
`miners-stats.html`, which **is** in `SITEMAP_PATHS`
([index.js:1401](../../web/07_mining_pool_public/back-end-pool/index.js#L1401)), renders every
leaderboard row as `<a href="/account-settings.html?addr=grin1…">`
([miners-stats.html:284-288](../../web/07_mining_pool_public/public_html/miners-stats.html#L284)).
A crawler following the sitemap therefore requests up to 1500 URLs each carrying a miner's full
address in the query string.

The static `<link rel="canonical">` points at the addr-less URL
([account-settings.html:34](../../web/07_mining_pool_public/public_html/account-settings.html#L34)),
which will usually keep the parameterised variants out of *Google's* index — but a canonical is
a hint, it does not stop the crawl, and it binds nobody else. The addresses land in Bing, in
Common Crawl, and in every AI training crawler's corpus, permanently and outside the operator's
control. `login.html` got exactly this treatment for exactly this reason — *"an indexed admin
login is free reconnaissance"*, `noindex, nofollow`
([login.html:12-14](../../web/07_mining_pool_public/public_html/login.html#L12)) — and the page
whose URL carries a miner's identity did not.

**Recommended, and cheap:** set `account-settings.html` to `noindex, follow` (matching
login.html's precedent; `follow` so the shell nav still passes link equity). Leave `robots.txt`
permissive — a `Disallow` would stop the crawl *before* the `noindex` is read, which is the
classic way a URL ends up indexed anyway.

**Resolution, 2026-09-02: exactly that, and both halves landed.** The meta tag is now
`noindex, follow` with the reasoning inline, `robots.txt` is untouched, and J11-1's option (b)
independently removed every `?addr=` link the site emitted — so there is no longer a crawl path
into the page at all. The `?addr=` *reader* stays (a miner may bookmark or share their own link);
what is gone is the pool publishing one. Both are asserted in the suite.

### J11-4 — [Medium] Every pool deployed from this toolkit beacons every visitor of every public page to one fixed third-party GA4 property, with the CSP already widened to allow it and no consent banner — **FIXED 2026-09-02**

**Threat actor: none — the pool does this by default.** The beneficiary is the
**third-party property holder**; the parties harmed are every visitor and the operator, who
inherits the GDPR/ePrivacy exposure of a tracker they did not choose. This is §J10's handoff,
confirmed live.

The shipped defaults:

```
pool-settings.js:186   provider: 'none',      // was 'ga4'
pool-settings.js:187   ga_tracking_id: '',    // was 'G-GMYJ4PVG4L'
pool-settings.js:198   cookie_consent_enabled: 'false',
```

The chain is complete end to end — this is not a dead default:

1. `buildPublicConfig` passes both through unchanged
   ([pool-settings.js:1286-1288](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1286));
2. `/api/public/branding` serves them to every public page
   ([index.js:979](../../web/07_mining_pool_public/back-end-pool/index.js#L979));
3. `loadProvider` dispatches `'ga4'` → `loadGa4('G-GMYJ4PVG4L')`
   ([branding.js:761-762](../../web/07_mining_pool_public/public_html/js/branding.js#L761)),
   which injects `https://www.googletagmanager.com/gtag/js?id=…`
   ([branding.js:803-807](../../web/07_mining_pool_public/public_html/js/branding.js#L803));
4. `cookie_consent_enabled` is `'false'`, so the consent gate at
   [branding.js:744](../../web/07_mining_pool_public/public_html/js/branding.js#L744) is
   skipped and the script loads immediately;
5. **and the generated nginx CSP already allowlists it** —
   `script-src … https://www.googletagmanager.com`, `connect-src … https://*.google-analytics.com`
   ([07_grin_mining_public_pool.sh:1269](../../scripts/07_grin_mining_public_pool.sh#L1269)).
   Nothing blocks the beacon.

Same family as J10-4 and from the same defaults block, but with a sharper edge: `seo.site_url`
mis-attributed the operator's *content*; this ships the operator's *visitors*. On a product
whose stated position is scrypt-hashed miner IPs, country-only geo and a k-anonymity floor,
the out-of-the-box behaviour is a full third-party page-view stream. The plausible / umami /
matomo defaults are all empty — GA4 is the only one wired up.

**Second half, found in the same read: the address scrub is one-sided.** `loadGa4` pins
`page_location` to `scrubbedLocation()`, which deletes `?addr=` so a miner's address never
reaches GA4 in the page URL
([branding.js:775-820](../../web/07_mining_pool_public/public_html/js/branding.js#L775)) —
good, and deliberate. But `gtag('config', …)` sets no `page_referrer`, and GA4 defaults that
parameter to `document.referrer`. Every in-site navigation *away* from
`account-settings.html?addr=grin1…` (the shell nav is on every page) therefore sends the
address as the referrer of the next page view. The scrub covers the page you are on and not
the page you came from.

**Fixed:** `provider` defaults to `'none'` and `ga_tracking_id` to `''` — analytics is
opt-in, the operator supplies their own property, and no pool ships pointing at someone
else's. `loadGa4` now pins `page_referrer` to a scrubbed referrer alongside `page_location`,
so an operator who *does* enable GA4 gets the scrub on both parameters. The CSP allowlist is
left alone: it is what makes an operator's own GA4/Plausible/Umami choice work, and it emits
nothing on its own.

### J11-5 — [Low] The k-anonymity floor guards the country breakdown but not the region breakdown, and the region breakdown is not behind the network-map gate — **FIXED 2026-09-02 (option a, on both the live feed and its durable history — see the §J11 resolution pass)**

**Threat actor: anonymous internet.**

`/api/pool/topology` applies both controls: `networkMapPublic()` 404s the whole route when the
map is off ([index.js:4201](../../web/07_mining_pool_public/back-end-pool/index.js#L4201)), and
countries below `network_map_min_bucket` (default 3) are folded into an unnamed *Other* row
before any point is built ([index.js:4314](../../web/07_mining_pool_public/back-end-pool/index.js#L4314)).
`/api/network/peers` does the same ([index.js:4429](../../web/07_mining_pool_public/back-end-pool/index.js#L4429)).
Both are correct.

`/api/pool/stats/regions` has neither. It publishes, ungated and with no floor, per region:
`region`, `label`, `country`, `country_code`, `stratum_url`, `status`, `hashrate_gps`,
`miners`, `shares_window`
([index.js:4584-4596](../../web/07_mining_pool_public/back-end-pool/index.js#L4584)). On a
single-box pool this is harmless — one region, and it is the pool. On a **multi-region** pool
each region carries an operator-declared `country_code`, so a row reading
`{region:'sgn', country_code:'VN', miners:1}` is the same statement the floor exists to
prevent, at gateway granularity: *one identifiable person mines near Vietnam*. The floor's own
helper text names the harm — *"a country holding one participant never points at one person"*
([settings-access.html:137-139](../../web/07_mining_pool_public/back-end-pool/admin-panel/settings-access.html#L137)).
`/api/pool/metrics/history/regions`
([index.js:3263](../../web/07_mining_pool_public/back-end-pool/index.js#L3263)) publishes the
same counts as a durable series over `?range=all`, so the thin-region history is public too.

Not the same severity as the country feed: a gateway country is a coarse proxy (a miner may
route through any region), the floor only ever hid *which* country, and the operator declares
the gateway's country themselves. But the control is inconsistent, and the inconsistency is
invisible from the admin panel — an operator who leaves the network map off has not made the
per-place miner count private.

Two options: (a) apply `network_map_min_bucket` to the `miners` field only, reporting
`miners: null` (not 0 — see §J5-4's lesson about a suppressed number reading as a real zero)
below the floor while `status` and `stratum_url` stay; (b) accept it and say so in the toggle's
helper text, which currently implies the map switch covers the whole who-mines-where question.

**Resolution: option (a), 2026-09-02, with two corrections to the option as written above.**
(1) `hashrate_gps` and `shares_window` are suppressed alongside `miners` — with one miner in a
region the hashrate *is* that miner's rig size, so masking the count alone would have been
theatre. (2) The floor was applied to `/api/pool/metrics/history/regions` as well; suppressing
only the live view would have left `?range=all` publishing yesterday's thin-region counts
forever. `status`/`online` are kept deliberately — a stated residual, not an oversight. Detail
and the render-side trap it exposed are in the resolution pass below.

### J11-7 — [Info] Two account routes parse their window parameter without a default, so `?hours=abc` silently answers "this miner has no data" — **FIXED 2026-09-02**

**Threat actor: none (a typo, or a client that sends an empty string).** Reported because the
failure mode is a *wrong answer on the money UI*, not an error.

Three call sites use `parseInt(req.query.x || N)` rather than the `parseInt(x, 10) || N` form
§J7-4 standardised — the `||` runs before `parseInt`, so a non-numeric string survives it and
`NaN` reaches the clamps, which propagate it:

```
index.js:3213  Math.min(Math.max(parseInt('abc' || 10),   1), 1440)  -> NaN
index.js:3225  Math.min(Math.max(parseInt('abc' || 24),   1),  720)  -> NaN
index.js:3241  (same)
```

Unlike §J7-4's routes these do not 500 — both consumers carry their own try/catch and return an
empty array — so the miner gets a plausible, wrong answer. Demonstrated:

```
index.js:3225  ?hours=abc  ->  hours = NaN
  getAccountHistory(NaN) -> []
index.js:3213  ?window=abc ->  windowMin = NaN
  getWorkersForAccount(NaN) -> []

  control: the same calls with the intended defaults
  getAccountHistory(24)    -> [{"t":1788384829,"gps":12.5}]
  getWorkersForAccount(10) -> [{"worker_name":"rig-01","hashrate_gps":0.000137,…}]
```

`window_min: NaN` also serialises to `null` in the response, so the echo does not reveal the
bad input either. On the account page that renders as *no rigs online* and *no hashrate
history* for a miner who is mining normally.

`index.js:3577` (`parseInt(req.query.days || 0)`) is the same form but harmless — `NaN > 0` is
false, so it falls through to "all history", which is the documented default.

**Fixed:** all three switched to `parseInt(x, 10) || N`, matching §J7-2/§J7-4.

### J11-8 — [Info] Verified correct, with evidence

Each of these was the plan's explicit ask, and each was read at the write side rather than
inferred from a comment.

- **Miner IPs are scrypt-hashed at capture, not at read.** `recordOwnerEvidence` canonicalises,
  then stores `v1$salt$hash` — the raw IP is never bound into an INSERT
  ([owner-proof.js:387-405](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L387)).
  Capture is on the first **accepted share**, not at login, and deliberately so
  ([stratum-server.js:592-596](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L592)).
- **Audit IPs are coarsened at write.** `auditOwnerProof` calls `coarsenIp(ip)` inside the
  INSERT's parameter list — IPv4→/24, IPv6→/48, non-IP→NULL
  ([owner-proof.js:116-127](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L116),
  applied at [:639](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L639)).
  The 180-day prune is real and runs: `retention_enabled` defaults to `'true'`
  ([pool-settings.js:645](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L645)),
  `audit_log_keep_days` has a **runtime floor of 30**
  ([retention.js:92](../../web/07_mining_pool_public/back-end-pool/lib/retention.js#L92)) so a
  mis-set value cannot disable it, and the DELETE is inside the retention transaction
  ([retention.js:119-121](../../web/07_mining_pool_public/back-end-pool/lib/retention.js#L119)).
- **geoip is country-only by construction.** `lookupCountry` returns `{cc, name}` and the IP is
  never returned, stored or logged
  ([geoip.js:40-51](../../web/07_mining_pool_public/back-end-pool/lib/geoip.js#L40)); the only
  three callers pass a transient IP and keep the code
  ([miners.js:134-147](../../web/07_mining_pool_public/back-end-pool/lib/miners.js#L134),
  [index.js:674](../../web/07_mining_pool_public/back-end-pool/index.js#L674),
  [owner-proof.js:629](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L629)).
- **`network_peers.peer_key` re-verified (§G2, and the plan's `node_id` question).** It is
  `sha256(net + '|' + ip)` truncated to 32 hex, unsalted
  ([index.js:678](../../web/07_mining_pool_public/back-end-pool/index.js#L678)) — reversible for
  IPv4, as §G2 accepted. **The re-verification the plan asked for is that it never leaves the
  box**: `/api/network/peers` selects `country_code, country, COUNT(*)` and emits only country
  rows plus scattered points
  ([index.js:4418-4483](../../web/07_mining_pool_public/back-end-pool/index.js#L4418)); no
  public route returns `peer_key`. The salt question that made memory
  `project_peer_map_location_grouping` a finding on **06** does not arise here, because 06
  publishes its per-node identifier and the pool publishes none. Do not "harden" this — salting
  breaks the cross-snapshot dedup the column exists for.
- **The network-map gate fails closed and the floor is applied before the points.**
  `networkMapPublic()` returns `false` on a settings read error
  ([index.js:4155-4164](../../web/07_mining_pool_public/back-end-pool/index.js#L4155)), the
  default is `'false'`
  ([pool-settings.js:277](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L277)),
  and both routes 404 rather than 403 so the feature's existence is not confirmed. In
  `/api/network/peers` the thin rows are filtered *before* the twinkle loop
  ([index.js:4430-4432](../../web/07_mining_pool_public/back-end-pool/index.js#L4430)), which is
  the ordering that matters — points are placed inside their own country.
- **Sample data is labelled** (memory `project_pool_network_map`). `#nm-note` distinguishes
  "feed unreachable → sample topology" from "no miners yet" and from sample peers
  ([network-map.js:439-451](../../web/07_mining_pool_public/public_html/js/network-map.js#L439)),
  and `FALLBACK_TOPOLOGY` carries `geo_source:'sample'`
  ([network-map.js:83](../../web/07_mining_pool_public/public_html/js/network-map.js#L83)). It
  is small muted text under the globe — a legibility question for §J15, not a leak.
  **Superseded 2026-09-13:** the legibility question answered itself — the label was missed
  twice and the sample was taken for real data, so `FALLBACK_TOPOLOGY`/`FALLBACK_PEERS` were
  deleted. An unreachable feed now draws a bare globe with a "not published" note.
- **CORS carries no cookie-reading route.** The `*` origin is set for **GET/OPTIONS only** on
  `/api/public/`, `/api/config/`, `/api/pool/`, `/api/account/`, `/api/stratum/`,
  `/api/network/`, with no `Access-Control-Allow-Credentials`
  ([index.js:275-291](../../web/07_mining_pool_public/back-end-pool/index.js#L275)). Every route
  under those six prefixes was enumerated: none reads `req.cookies`, none calls
  `requireAdmin`, and the money actions on `/api/account/` are POST/DELETE, which the method
  filter excludes. `/api/admin/` and `/api/auth/` are not in the list.
- **`lib/ip-filter.js` is admin-only and leaks nothing outward.** It is mounted solely inside
  `secureAdmin` ([index.js:814-818](../../web/07_mining_pool_public/back-end-pool/index.js#L814));
  the one field it echoes is `your_ip`, which is the caller's own address
  ([ip-filter.js:47](../../web/07_mining_pool_public/back-end-pool/lib/ip-filter.js#L47)); and
  `getClientIp` reads `req.ip` under `trust proxy: 'loopback'`, not the raw header
  ([ip-filter.js:288-291](../../web/07_mining_pool_public/back-end-pool/lib/ip-filter.js#L288)).
- **No public route returns a raw IP.** Enumerated across all **51 unauthenticated route
  registrations** — 50 GETs (`/health` carries an `/api/health` alias on the same call) plus
  `POST /api/public/ads/event`; the four ownership-proof-gated account POST/DELETEs and
  `GET /api/auth/captcha` (§J2's) are excluded from that count.
  §J8-5's journal sink (the pool's own systemd journal logs address + raw mining IP on login)
  remains the only out-of-DB IP↔address pairing, and it is not reachable over HTTP.
- **`/api/pool/locations` and the gateway roster are public by necessity, and the hub is not
  named.** `stratum_url` is where a miner points a rig
  ([index.js:4134](../../web/07_mining_pool_public/back-end-pool/index.js#L4134)); the hub's own
  host appears in no public response, and `/api/pool/topology` publishes the hub's **country**
  only, behind the gate. The residual — that `/api/pool/stats/regions` gives an attacker live
  feedback on whether a DoS against one gateway is working — is inherent to publishing honest
  liveness and is accepted.

## §J12 — Rate limiting & resource exhaustion (2026-09-02, add-ons, NOT VPS-TESTED)

### J12-1 — [High] `/api/stratum/top-avg-hashrate` full-scans `hashrate_history` on every request and `?days` never enters the plan — the cheapest unauthenticated way to stall share intake — **FIXED 2026-09-02 (see §J12 resolution pass)**

**Threat actor: anonymous internet.**

The handler clamps its inputs correctly — `days ≤ 90`, `limit ≤ 1000`
([index.js:4666-4667](../../web/07_mining_pool_public/back-end-pool/index.js#L4666)) — and
hands them to `getTopAvgHashrate`
([hashrate-tracker.js:156-179](../../web/07_mining_pool_public/back-end-pool/lib/hashrate-tracker.js#L156)):

```sql
SELECT grin_address, COALESCE(SUM(hashrate_gps * window_seconds), 0) / ? AS avg_gps
FROM hashrate_history WHERE recorded_at > ?
GROUP BY grin_address ORDER BY avg_gps DESC LIMIT ?
```

Two indexes exist on that table
([db.js:506](../../web/07_mining_pool_public/back-end-pool/lib/db.js#L506),
[:518](../../web/07_mining_pool_public/back-end-pool/lib/db.js#L518)) and **neither serves this
query.** Run against the real schema in `node:sqlite`:

```
EXPLAIN QUERY PLAN → SCAN hashrate_history USING INDEX idx_hashrate_address
                   | USE TEMP B-TREE FOR ORDER BY
```

`SCAN`, not `SEARCH`. The `recorded_at > ?` predicate sits on the **second** column of
`idx_hashrate_address(grin_address, recorded_at DESC)`, so it cannot seek: SQLite walks the
whole index, does a table lookup on every row for `hashrate_gps` and `window_seconds` (neither
is in that index), and builds a temp B-tree to sort. **The `days` parameter never enters the
plan at all** — `?days=1` costs exactly what `?days=90` costs, which is the entire table.

That table is written at one row per active miner per minute
([hashrate-tracker.js:9](../../web/07_mining_pool_public/back-end-pool/lib/hashrate-tracker.js#L9),
[:63](../../web/07_mining_pool_public/back-end-pool/lib/hashrate-tracker.js#L63)) and pruned at
`database.hashrate_keep_days`, **default 100**
([retention.js:104-107](../../web/07_mining_pool_public/back-end-pool/lib/retention.js#L104)).
At the 1000-miner target of memory `project_pool_db_capacity` the steady state is
1000 × 1440 × 100 ≈ **144 million rows**, scanned per request. At 100 miners it is 14.4 M.

`node:sqlite` is synchronous and the stratum server shares this process. This is the exact
hazard the author has already identified and closed for the sibling endpoint — the comment
above `idx_hashrate_time` spells it out, *"a multi-second scan blocks share submission for
every connected miner"*
([db.js:507-517](../../web/07_mining_pool_public/back-end-pool/lib/db.js#L507)) — and
`getPoolHistory` additionally got a TTL cache for the same reason
([hashrate-tracker.js:295-302](../../web/07_mining_pool_public/back-end-pool/lib/hashrate-tracker.js#L295)).
`getTopAvgHashrate` got neither, and it is the more expensive of the two.

**Impact.** nginx allows ~10 req/s from one host. Ten full-table scans a second against a
synchronous DB is not a slow page — it is the share pipeline stopped, and §J6 established that
stopped share intake is how a found block is lost. No credential, no proof, one `curl` loop.

**Fix — NOT applied (plan rule 3: this is structural).** Three options, in order of preference:
**(a)** add a covering index `hashrate_history(recorded_at, grin_address, hashrate_gps,
window_seconds)` so the plan becomes a covering range seek and `days` finally bounds the work;
**(b)** serve the sustained-contribution leaderboard from the never-pruned
`pool_metrics_hourly` rollup instead of raw samples; **(c)** at minimum give it the same TTL
cache `getPoolHistory` has — the answer is identical for every caller, so a 60 s memo makes the
whole endpoint one query a minute. (a) and (c) together are the right answer. It is left open
because creating that index on a populated 100-day table is a migration with a lock, not an
edit — the same hazard class as §J7-1's `VACUUM` cron, and it belongs in the same conversation.
`scripts/test-rate-limits.js` pins the `SCAN` plan so the day someone adds the index, the suite
says the finding is closed rather than silently continuing to pass.

### J12-2 — [High] `/api/pool/status` made two upstream RPCs per request — one to the hot wallet — and answered with a cache *header* instead of a cache — **FIXED 2026-09-02**

**Threat actor: anonymous internet.**

[index.js:2250-2278](../../web/07_mining_pool_public/back-end-pool/index.js#L2250) as it stood.
Every hit did, unconditionally and in series:

1. `await blockMonitor.grinNode.getStatus()` — a node **Owner API** JSON-RPC call with a 10 s
   fetch timeout ([grin-node.js:307](../../web/07_mining_pool_public/back-end-pool/lib/grin-node.js#L307));
2. `await wallet.getBalance()` — a **wallet Owner API v3** call: AES-256-GCM over the ECDH
   session, 10 s timeout.

Then it set `Cache-Control: public, max-age=15`. That is a hint to the *client*. It costs an
attacker one header to ignore, and nothing on the box consults it.

**Why this is a finding and not a nitpick.** The endpoint 1200 lines further down in the same
file does the same class of work and got the real control, with the reasoning written out:

> *"60s cache: MPS polls on a fixed interval and this is a public GET that touches the node and
> the DB, so an uncached version is a free amplification handle (same reasoning as
> getPoolHistory in lib/hashrate-tracker.js)."*
> — [index.js:3471-3476](../../web/07_mining_pool_public/back-end-pool/index.js#L3471)

`/api/pool/status` is the *other* public GET that touches the node, it also touches the wallet,
and it is polled by every homepage visitor rather than by one listing service.

**Impact.** At ~10 req/s from one host: 10 node Owner-API calls and 10 wallet Owner-API calls
per second, sustained, unauthenticated. `getBalance()` defaults to `refresh = false`
([wallet.js:40-44](../../web/07_mining_pool_public/back-end-pool/lib/wallet.js#L40)), so it is
an LMDB read rather than a node-wide output scan — that is the single thing keeping this out of
Critical, and it is deliberate and documented. What remains is still serious: `WalletAPI` is a
**singleton shared with the payout path**, and `_call` mutates `this.aesKey` / `this.sessionOpen`
and re-runs `initSession()` on any session-shaped error
([wallet.js:200-219](../../web/07_mining_pool_public/back-end-pool/lib/wallet.js#L200)). A flood
of concurrent status calls races that shared session against the withdrawal scheduler's own
calls, and each in-flight request holds a 10 s socket to the wallet.

**Fixed.** Given the 15 s server-side TTL its own header already advertised, plus in-flight
dedup so a burst arriving on a cold cache collapses to one upstream pair — the pattern
`torProbeCached` and `cachedGatewayStatus` already use in this file. Last-good is served when a
build fails, so a down node cannot turn the endpoint back into a per-request prober.

### J12-3 — [Medium] The four SEO paths are proxied with no `X-Forwarded-For` and no `limit_req` zone, so every visitor shares one app bucket and ~1200 requests from one host 429s `/robots.txt` and `/sitemap.xml` for everyone — **FIXED 2026-09-02 (see §J12 resolution pass)**

**Threat actor: anonymous internet; the collateral is every crawler.**

The generated vhost proxies four paths on one line each, with `Host` and nothing else
([07_grin_mining_public_pool.sh:1400-1404](../../scripts/07_grin_mining_public_pool.sh#L1400)):

```nginx
location = /robots.txt    { proxy_pass http://127.0.0.1:$POOL_PORT; proxy_set_header Host $host; }
location = /sitemap.xml   { proxy_pass http://127.0.0.1:$POOL_PORT; proxy_set_header Host $host; }
location = /manifest.json { proxy_pass http://127.0.0.1:$POOL_PORT; proxy_set_header Host $host; }
location = /blog/rss.xml  { proxy_pass http://127.0.0.1:$POOL_PORT; proxy_set_header Host $host; }
```

No `limit_req`. No `X-Forwarded-For`. All four handlers carry `rateLimiter.middleware('public')`
([index.js:1347](../../web/07_mining_pool_public/back-end-pool/index.js#L1347),
[:1394](../../web/07_mining_pool_public/back-end-pool/index.js#L1394),
[:1419](../../web/07_mining_pool_public/back-end-pool/index.js#L1419),
[:1451](../../web/07_mining_pool_public/back-end-pool/index.js#L1451)).

With no `X-Forwarded-For` header present, `trust proxy: 'loopback'` leaves `req.ip` as the
socket address — nginx's `127.0.0.1`. The limiter key for all four is therefore the single
bucket `public|127.0.0.1`, **shared by every visitor on Earth**.

**This exact trap is documented three blocks further down the same file**, where it was
recognised and fixed for `/page.html`:

> *"Forwards the client IP, unlike the SEO-file proxies above: this one is a real page a
> visitor loads, and the app rate-limits it per IP — without these headers every visitor would
> share nginx's single 127.0.0.1 bucket."*
> — [07_grin_mining_public_pool.sh:1411-1414](../../scripts/07_grin_mining_public_pool.sh#L1411)

The comment even names "the SEO-file proxies above" as the contrast case. What it does not say
is that those four are *also* the only proxied paths with no `limit_req` zone, which is what
makes the shared bucket cheap to reach.

**Two consequences, both live.**

1. **A denial of service on the pool's own discoverability.** ~1200 requests to `/sitemap.xml`
   — seconds, since nginx applies no zone — trips `public|127.0.0.1` into a lockout. Every
   subsequent request to any of the four then returns 429, for every visitor and every crawler,
   re-tripping for as long as the attacker keeps going. A sustained 429 on `robots.txt` is read
   by search engines as "do not crawl this site"; on `sitemap.xml` it is a fetch failure. This
   is also the one place where J12-4's dead backoff worked in the *defender's* favour, and the
   fix there makes the lockout longer.
2. **Real per-request work, unmetered at the edge.** `/sitemap.xml` runs `listEnabled()`, a
   `COUNT(*)` and a 50-row post page
   ([index.js:1419-1447](../../web/07_mining_pool_public/back-end-pool/index.js#L1419)); the
   other three each run uncached `getSection()` reads (see J12-8). None of it is capped by nginx.

**And one latent trap from the same root cause.** `isLocalRequest(req)` returns `true` for any
request arriving on a location that does not set `X-Forwarded-For`
([index.js:241-244](../../web/07_mining_pool_public/back-end-pool/index.js#L241)) — its
docstring's premise, *"a loopback `req.ip` can ONLY be a direct on-box call"*, is false for
exactly these four locations. It is **not exploitable today**: its single call site is the
CAPTCHA bypass in `POST /api/auth/register`
([index.js:1735](../../web/07_mining_pool_public/back-end-pool/index.js#L1735)), which is served
by `location /api/auth/` and does forward the header. But the invariant the function documents
is not true of this vhost, and the next route proxied the SEO way would inherit "the trusted
operator on the box" for free.

**Fix (not applied — it is a vhost change, §J16's file).** Add `proxy_set_header X-Real-IP
$remote_addr;` + `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` and
`limit_req zone=${POOL_SERVICE}_static burst=20 nodelay;` to all four blocks — i.e. treat them
exactly as `/page.html` is already treated. Independently, tighten `isLocalRequest` to require
*both* a loopback `req.ip` **and** an absent `x-forwarded-for` header, so the function's
docstring becomes true by construction rather than by the vhost happening to agree with it.

### J12-4 — [Medium] The limiter's exponential backoff was unreachable code: the violation record was deleted at expiry, so the lockout was always 30 s and the one-hour cap could never apply — **FIXED 2026-09-02**

**Threat actor: anonymous internet — this is a control that under-performed, not a hole.**

[rate-limiter.js:216-263](../../web/07_mining_pool_public/back-end-pool/lib/rate-limiter.js#L216)
as it stood. The documented behaviour is a ladder:

```js
const violationCount = (this.violations.get(key)?.count || 0) + 1;
const lockoutDuration = Math.min(
  30000 * Math.pow(2, violationCount - 1), // Exponential backoff: 30s → 60s → 120s
  3600000 // Cap at 1 hour
);
```

`violationCount` could never be anything but 1. Every path into that line:

- If a violation record existed and `lockedUntil > now`, `checkLimit` returned `false` at :226 —
  it never reached the escalation.
- If it existed and had expired, it was **`delete`d at :229** and execution continued.
- So by the time the escalation ran, `this.violations.get(key)` was *always* `undefined` —
  either it never existed, or the branch above had just removed it.
  `(undefined?.count || 0) + 1` → `1`. `30000 * 2**0` → **30 s, every time.**
- `startCleanup` deleted expired violations too, so no path preserved a count either.

`getViolations()` therefore reported `violation_count: 1` for every entry it would ever return,
and the admin *Login Security* panel's escalation column was a constant.

**Impact.** A persistent violator was refused for 30 s, re-evaluated against a 60 s sliding
window that had not yet drained, re-locked for another 30 s, and settled into roughly "budget
requests per ~90 s" forever, with no escalating cost. That is a *weaker* control than the
comment describes, not a broken one — the sliding window is what actually held the line. It is
Medium rather than Low because both the audit trail and the operator UI present a ladder that
did not exist, and because §J2-1 reasoned about the `stepup` budget while the code advertised an
escalating penalty on top of it that was never applied.

**Fixed.** `checkLimit` now keeps the record when it clears an expired `lockedUntil` instead of
deleting it, and the cleanup sweep only drops a violation once it has been expired for a full
`VIOLATION_MEMORY_MS` (10 minutes). An expired-but-remembered record is inert everywhere it
matters — `peek()`, `getStatus()` and `getViolations()` all test `lockedUntil > now` — so
keeping it does not extend a lockout by a millisecond; it only remembers that this bucket has
misbehaved before. Ten minutes was chosen so a client hammering back through every lockout
climbs the ladder while an operator who tripped the admin budget once during a busy afternoon
is back to a 30 s penalty by the time they notice. Verified: 30 → 60 → 120 s across three
consecutive expiries, and `getViolations()` empty for a lapsed record.

### J12-5 — [Medium] The two admin CSV exports have no row cap and ride the 2400/min `admin` bucket, while the public per-address exports are capped at 50,000 rows on a dedicated 10/min bucket — **FIXED 2026-09-02 (see §J12 resolution pass)**

**Threat actor: logged-in admin, or a stolen `secureAdmin` session — neither route is
`freshAdmin`, and §C3 is still open.**

```js
app.get('/api/admin/export/payouts.csv', secureAdmin, ...)      // index.js:2950
  SELECT ... FROM withdrawals WHERE status = 'confirmed' ORDER BY confirmed_at DESC
app.get('/api/admin/export/fee-revenue.csv', secureAdmin, ...)  // index.js:2967
  SELECT ... FROM blocks ORDER BY height DESC
```

No `LIMIT`. Both `.all()` the entire result into an array, then `sendCsv` builds **one string in
memory** by `map` + `join` over every row
([index.js:2941-2947](../../web/07_mining_pool_public/back-end-pool/index.js#L2941)) before a
single byte is written. Neither table is ever pruned — `retention.js` prunes `shares`,
`hashrate_history`, `alerts`, `admin_audit_log` and `balance_log`, and the code says so of
`withdrawals` explicitly
([index.js:3641-3643](../../web/07_mining_pool_public/back-end-pool/index.js#L3641)).

The asymmetry is the point. The *public, per-address* exports two hundred lines away are capped
at `CSV_MAX_ROWS = 50000` and gated on a dedicated 10/min `export` bucket
([index.js:3637-3654](../../web/07_mining_pool_public/back-end-pool/index.js#L3637)). The
*pool-wide, all-time* exports have neither, and sit on the 2400/min bucket the polling dashboard
needs to stay loose.

**Impact.** At 1000 miners over a year `payouts.csv` is a few hundred thousand rows; the peak
allocation is the row array plus the joined string plus Express's copy of it — several times the
row bytes, synchronously, on the event loop that validates shares. `blocks` holds one row per
block *this pool finds*, so `fee-revenue.csv` is the milder half. A valid admin session is
required, which is why this is Medium.

**Fix (not applied — it changes what an operator's export contains, plan rule 3).** Put both on
the `export` bucket, add the same `CSV_MAX_ROWS` cap their public siblings use with a `?before=`
cursor for the operator who genuinely wants everything, or stream row-by-row with `res.write`
instead of building one string.

### J12-6 — [Medium] `/api/public/price` never cached a failure and had no in-flight dedup, so any upstream refusal turned it into a per-request outbound fetch — **FIXED 2026-09-02**

**Threat actor: anonymous internet.**

[index.js:1059-1088](../../web/07_mining_pool_public/back-end-pool/index.js#L1059) as it stood.
The cache was written only on the success path, and only when a number came back:

```js
if (data.available) _priceCache = { ts: now, data };
```

`_priceCache.ts` was not touched on any failure. So an upstream `403`, `429`, timeout or network
blip produced no negative cache entry — it produced **nothing**, and the very next request
re-ran the `fetch`. There was also no in-flight guard, so even on the happy path every request
arriving between cache expiry and the first response fired its own outbound call. Both are
solved elsewhere in this same file: `cachedGatewayStatus` has a `running` flag
([index.js:145-155](../../web/07_mining_pool_public/back-end-pool/index.js#L145)),
`torProbeCached` has an in-flight `Map`, `refreshStratumProbes` has both.

**Why the failure path is not hypothetical.** Memory `project_grin_btc_price_source` records
that CoinGecko rejects requests without a *descriptive* `User-Agent` — it is why
`06_price_collector.py`, `07_mining_block_collector.py`, `06b_grinscan/server.js` and
`06d_tiny_explorer` all had to gain a headers block. This call set only
`{ accept: 'application/json' }`, and Node's `fetch` supplies `user-agent: node` by default
(probed locally on Node v24.14.1 against a throwaway one-shot listener). A bare `node` is not a
descriptive User-Agent, so there is good reason to expect the failure branch to be the
*permanent* state on a fresh mainnet pool — at which point every one of the ~10 req/s nginx
allows becomes an outbound HTTPS request with a 5 s abort: up to 50 concurrent sockets held by
one anonymous client, plus whatever reputation the pool's egress IP earns upstream.

**Fixed.** Four changes: a descriptive `User-Agent` is now sent (matching what the other four
toolkit callers had to add); any failure stamps a 60 s negative cache so a broken upstream is
retried on a timer rather than per request; a 200 that carries no price is treated as a failure
too, so an upstream that quietly drops the `grin` id cannot re-open the hole; and an in-flight
promise collapses concurrent misses to one fetch. Stale-if-error behaviour is unchanged.

### J12-7 — [Medium] `/api/pool/effort`'s round window had no lower bound, so a pool that has not yet found a block summed the entire `shares` table on every request — **FIXED 2026-09-02**

**Threat actor: anonymous internet. Worst on a brand-new pool — i.e. on launch day.**

[index.js:3409-3411](../../web/07_mining_pool_public/back-end-pool/index.js#L3409) as it stood:

```js
const roundDiff = db.prepare(
  'SELECT COALESCE(SUM(difficulty), 0) AS d FROM shares WHERE created_at > ?'
).get(lastBlockAt || 0).d;
```

`lastBlockAt` comes from `blockManager.getLastBlock()` and is `null` until this pool finds its
first block. `null || 0` → `0`, so the predicate became `created_at > 0` — **every row**. The
plan is a proper index seek (`SEARCH shares USING INDEX idx_share_created (created_at>?)`,
confirmed with `EXPLAIN QUERY PLAN`), but a seek from zero visits the whole table, and
`idx_share_created(created_at)` does not carry `difficulty`, so every row is also a table lookup.

The network-difficulty half of the same handler is carefully cached for 60 s
([index.js:3398-3407](../../web/07_mining_pool_public/back-end-pool/index.js#L3398)) precisely so
a poll cannot hammer the node. The share sum beside it was uncached and unbounded.

**Impact.** Two shapes. (1) *Launch day*: no block found yet, every hit sums the whole `shares`
table, and the effort widget is on the homepage. (2) *Steady state*: a small pool's round can
legitimately run for days, while `shares` retention is governed by the PPLNS/confirm window
rather than by the round — so the sum grows without bound relative to the round it claims to
measure. Both were uncached at ~10 req/s.

**Fixed.** The window is floored at `now - 7 days` rather than at 0, which is well past the
PPLNS/confirm retention horizon, so on a pool that *has* found a block the floor never binds and
the published figure is unchanged. The response is also memoised for 30 s — its inputs move no
faster than a block. Two new fields, `round_window_from` and `round_window_capped`, say when the
figure is measured from the floor rather than from a real block, so a brand-new pool's effort
number is honest rather than silently meaningless.

### J12-8 — [Low] `/api/public/branding` rebuilt the entire white-label payload from five uncached settings reads on every request, on the endpoint every public page hits on every load — **FIXED 2026-09-02**

**Threat actor: anonymous internet. Answers §J9-8's handoff.**

`buildPublicConfig` calls `getSection()` five times
([pool-settings.js:1202-1206](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1202)),
and `getSection` is a fresh `SELECT key, value, value_type FROM pool_config WHERE section = ?`
plus a per-row type coercion every single time — there is no memo anywhere in that module
([pool-settings.js:1158-1187](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1158)).
The route then adds asset lookups, an incentives summary and a lottery read
([index.js:995-1049](../../web/07_mining_pool_public/back-end-pool/index.js#L995)) and set
`Cache-Control: public, max-age=60` — again a client hint, not a control.

§J9-8 established that ~40 of the strings in that payload are bounded only by
`express.json()`'s 100 KB **per-request** limit, and that successive writes accumulate. So the
response size is an operator-set number with no ceiling, rebuilt from roughly eight queries, on
the one endpoint every page on the site fetches on every load.

Low rather than Medium because the queries are small and indexed (`idx_pool_config_section`) and
because the payload only gets large if the operator makes it large. It is on the list because it
is the *most-hit* endpoint in the product and the one place where J9-8's missing length caps turn
into a bandwidth multiplier.

**Fixed.** A 60 s server-side memo of the built payload — the same window the header already
advertised — keyed on `req.hostname` (which feeds `connection.stratum_host`) and bounded to 32
entries, because the Host header is attacker-chosen and a cache must not become a registry. It is
invalidated explicitly on every settings and asset write (`updateSection`, `resetSection`,
`saveAsset`, `deleteAsset`) so an operator's edit still appears immediately; the TTL is the
backstop for the inputs that are *not* settings writes — the prize-pool figure and the lottery
schedule, both of which have their own live endpoints. **The length caps themselves stay §J9-8's
open item**: caching does not make an unbounded payload smaller, it only stops it being paid for
per request.

### J12-9 — [Low] `/api/pool/topology` full-scans `shares` and compiles an `IN (…)` clause with one placeholder per live session — **MEMO FIXED 2026-09-02; the `IN (…)` width is unchanged (see §J12 resolution pass)**

**Threat actor: anonymous internet, but only where the operator has published the network map.**

[index.js:4215](../../web/07_mining_pool_public/back-end-pool/index.js#L4215). Two uncached costs
per request:

1. The 15-minute share aggregate
   ([index.js:4237-4241](../../web/07_mining_pool_public/back-end-pool/index.js#L4237)) plans as
   `SCAN shares USING INDEX idx_share_region | USE TEMP B-TREE FOR count(DISTINCT)` — a full
   index scan, because `created_at > ?` sits on the second column of
   `idx_share_region(region, created_at)` and cannot seek.
2. The geo lookup builds its SQL *text* from the live session count
   ([index.js:4302-4306](../../web/07_mining_pool_public/back-end-pool/index.js#L4302)):
   `addrs.map(() => '?').join(',')`. Under §J6's global socket ceiling that is up to a ~50 KB
   statement compiled per request, and it approaches SQLite's 32,766-parameter limit — past
   which the `prepare` throws and the endpoint 500s rather than degrading.

The expensive *outbound* parts are handled properly — `cachedGatewayStatus` (15 s + running flag)
and `refreshStratumProbes` (60 s + running flag + 2-strike verdict) are both kept out of the
request path with the reasoning written out. Only the DB half was left uncached.

**Low** because `networkMapPublic()` gates the whole handler and it is **off by default**, so a
stock pool 404s here (memory `project_pool_network_map`). It becomes a Medium the day an operator
publishes the map. **Fix:** a 30 s memo — the response is identical for every caller and its
inputs move on a 15-minute window — plus a chunked or temp-table lookup instead of a
session-length `IN` clause.

> **Superseded 2026-09-13:** `network_map_public` now defaults to **`'true'`**, so the "off by
> default" half of the Low rating no longer holds — every stock pool serves this handler. The
> severity does not rise because the fix above (30 s memo, `TOPOLOGY_TTL_MS`) had already
> shipped and is asserted by `scripts/test-rate-limits.js` (§J12-9); the un-memoised path this
> finding describes is not reachable. The session-length `IN` clause is still as written.

### J12-10 — [Low] The `api` bucket was dead, and a `rate_limits` value of `0` disables a bucket rather than blocking — **BUCKET FIXED 2026-09-02; the falsy-limit behaviour is documented, deliberately not changed**

**Threat actor: nobody for the first half; on-box root for the second (Info, plan rule 7).**

**The dead bucket.** `api: 600` was defined with a rationale, and was `middleware()`'s default
argument — but a sweep of every `middleware(` / `peek(` / `consume(` call in `index.js` found
**zero** uses: `admin` 8, `public` 51, `auth` 7, `export` 4, `withdraw` 4, `stepup` 2,
`torcheck` 1, `api` **0**. A bucket nobody references is a number a future reviewer assumes
covers something.

**The falsy-limit trap.** `middleware()` treats any falsy limit as *no limit*
([rate-limiter.js:112-119](../../web/07_mining_pool_public/back-end-pool/lib/rate-limiter.js#L112))
and `Object.assign(this.limits, config.rate_limits)` merges the operator's `pool.json` values
verbatim with no validation. So `"rate_limits": { "torcheck": 0 }` — the natural way to write
"allow no probes", and the comments in that file actively invite the edit by saying the key is
overridable — silently removes the bucket entirely. Same shape as
`project_config_loader_type_traps`, on the security-switch axis.

`rate_limits` reaches the app only from a hand-edited `pool.json`: the installer never writes it,
it is not a settings section, nothing in the admin UI touches it, and it survives `mergeEnvVars`
only via the `...config` spread at
[config.js:41](../../web/07_mining_pool_public/back-end-pool/lib/config.js#L41). That makes it
root-only and therefore Info.

**Half fixed.** The dead `api` bucket is removed and `middleware()`'s default moved to `public`.
The falsy-limit behaviour is left as it is and documented instead, at `middleware()` and at both
comment sites that advertise an override: rejecting `0` would remove an operator's only way to
switch a bucket off deliberately, and choosing between "0 means off" and "0 means block" is a
product decision, not a defect to patch silently. The regression suite now fails if any bucket
is defined without a consumer, or any route names a bucket that does not exist.

### J12-11 — [Low] Nothing bounds the limiter's own maps or the three auto-ban maps, and two admin reads walk them end to end — **FIXED 2026-09-02 (see §J12 resolution pass)**

**Threat actor: anonymous internet, but the ceiling is the attacker's IPv4 source space.**

Five unbounded `Map`s keyed by client IP:

| Map | Where | Swept? |
|---|---|---|
| `RateLimiter.requests` | [rate-limiter.js:17](../../web/07_mining_pool_public/back-end-pool/lib/rate-limiter.js#L17) | Every 5 min, whole-map iteration |
| `RateLimiter.violations` | [rate-limiter.js:18](../../web/07_mining_pool_public/back-end-pool/lib/rate-limiter.js#L18) | Same sweep (now with a 10-minute memory — J12-4) |
| `adminLoginFailures` | [index.js:386](../../web/07_mining_pool_public/back-end-pool/index.js#L386) | **Never.** Pruned only on the next failure from the same IP, or on threshold/success |
| `admin2faFailures` | [index.js:397](../../web/07_mining_pool_public/back-end-pool/index.js#L397) | **Never**, same |
| `IpFilter.tempBans` | [ip-filter.js:24](../../web/07_mining_pool_public/back-end-pool/lib/ip-filter.js#L24) | Lazily — only when that IP is looked up, or when the admin panel lists them |

No size cap on any of them, unlike almost every other cache in this product (`torProbeCache` 500,
`_poolHistoryCache` capped, and now `_brandingCache` 32; `nostr_seen_events` — §J4-8 — is the one
other unbounded store). Two admin reads then walk the limiter maps in full per request:
`getStatus(ip)` iterates every key to sum one IP's counters
([rate-limiter.js:292-296](../../web/07_mining_pool_public/back-end-pool/lib/rate-limiter.js#L292))
and `getViolations()` iterates every violation, both on one `secureAdmin` route at 2400/min
([index.js:4855-4864](../../web/07_mining_pool_public/back-end-pool/index.js#L4855)); `resetIp` is
a third full walk.

**Why this is Low and not the "is the limiter itself the DoS?" answer the plan expected.** The key
is the *real* source address — `X-Forwarded-For` is unspoofable here (J12-14) — so growing the map
costs an attacker one distinct source IP per key. The obvious multiplier would be an IPv6 /64,
which is 2^64 free keys; **the generated vhost is IPv4-only** (`listen 443 ssl http2` at
[07_grin_mining_public_pool.sh:1285](../../scripts/07_grin_mining_public_pool.sh#L1285), with no
`listen [::]:443` companion), so that lever does not exist on a stock deployment. What is left is
botnet-sized: 10,000 distinct IPv4 sources → ~70,000 entries across the bucket types, tens of MB,
swept within 5 minutes. The three auto-ban maps additionally cost a solved CAPTCHA per entry.

**Fix (not applied — it should be sized against real traffic).** A size cap with oldest-first
eviction on `requests`/`violations`, a TTL sweep on the two `adminLoginFailures` maps, and a
per-IP index for `getStatus` if the admin panel is expected to work on a box under attack. Note
that the eviction policy is security-relevant: evicting a `violations` entry **lifts a lockout**,
so a cap must be large enough that it is never reached in normal operation.

### J12-12 — [Low] The Tor pre-flight probe is priced by the `withdraw` bucket, so one proof-holding miner can force 20 circuit builds a minute — **FIXED 2026-09-02 (answers §J3's handoff; see §J12 resolution pass)**

**Threat actor: registered miner — needs one valid ownership proof.**

§J3 handed this over. Re-checked and still true: in `POST /api/account/:addr/withdraw` the probe
runs at [index.js:3833](../../web/07_mining_pool_public/back-end-pool/index.js#L3833), **before**
`createWithdrawal` — which is where the one-pending-per-address cap and the cross-rail cooldown
live. So a miner whose every withdrawal would be refused by those checks still buys a probe per
request. Each probe is up to `torCheckRetries` (2) SOCKS connects at `torCheckTimeoutMs` (3000)
each ([wallet-tor.js:92-95](../../web/07_mining_pool_public/back-end-pool/lib/wallet-tor.js#L92),
[:162-167](../../web/07_mining_pool_public/back-end-pool/lib/wallet-tor.js#L162)) — up to **6 s of
tor descriptor lookup per request**, at the `withdraw` bucket's 20/min.

> **Superseded 2026-09-23 (payout-rails fix, impl §10.5):** the timeout is now **8000 ms**, and an
> attempt covers the SOCKS connect plus a `check_version` reply, each with its own timeout. The
> worst case is therefore ≈ **32 s** per request, not 6 s. The ordering fix below still keeps a
> request that is going to be refused from paying for a probe. The 32 s against the `/api/` 30 s
> `proxy_read_timeout` is an open question; see the Status roll-up.

The `tor-check` route's excellent cache is **deliberately not used here**, and the reason is sound
and money-shaped:

> *"DELIBERATELY NOT used by the withdraw pre-flight gate. That one is a money decision (it can
> refuse a payout), so it always takes a fresh probe: a 60s-stale 'offline' must never block a
> listener the miner just started."*
> — [index.js:3737-3740](../../web/07_mining_pool_public/back-end-pool/index.js#L3737)

**So the fix is not a cache — it is ordering.** Move the pre-flight below the pending/cooldown
checks (or hoist those checks above it), so a request that is going to be refused anyway never
buys a circuit. That preserves the freshness guarantee exactly: a request that *will* create a
withdrawal still gets a fresh probe. Left open because it means splitting `createWithdrawal`'s
admission checks out of the scheduler, which is §J4's module.

The second half of §J3's handoff is also still true: every failed proof writes an
`admin_audit_log` row
([owner-proof.js:422](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L422))
*including* those already rejected by the lockout, so a locked-out attacker still grows that table
at the bucket rate for the full 180-day retention. That is disk rather than CPU and it is bounded
at 20/min/IP — recorded so it is not lost, not promoted to its own finding.

### J12-14 — [Info] Verified correct, with evidence

| Checked | Result |
|---|---|
| **`trust proxy: 'loopback'` and the XFF chain** | Correct, and for the right reason. nginx sets `X-Forwarded-For $proxy_add_x_forwarded_for` on every proxied location that matters, which appends `$remote_addr` on the **right**. Express with `trust proxy: 'loopback'` walks XFF right-to-left skipping trusted hops, so `req.ip` resolves to the rightmost *untrusted* entry — the real client. A client-supplied `X-Forwarded-For` lands to the **left** of that and can never win. Read at [07_grin_mining_public_pool.sh:1384-1395](../../scripts/07_grin_mining_public_pool.sh#L1384) against [rate-limiter.js:361-364](../../web/07_mining_pool_public/back-end-pool/lib/rate-limiter.js#L361). The four exceptions are J12-3 |
| **The satellite / model-C gateway path breaking `req.ip`** | **Does not exist any more — the plan's premise is stale.** There is no satellite HTTP ingestion API: regional gateways are HAProxy + WireGuard *stratum* forwarders that carry the miner IP in PROXY-protocol v2 on the stratum port, and shares are written locally with the region stamped from the listener ([index.js:983-990](../../web/07_mining_pool_public/back-end-pool/index.js#L983)). Nothing a gateway does reaches the HTTP limiter. The PROXY-v2 half is §J6-3's, and is fixed there |
| **Bucket keying** | `<type>\|<ip>` ([rate-limiter.js:188-190](../../web/07_mining_pool_public/back-end-pool/lib/rate-limiter.js#L188)). No bucket name contains `\|`, so no cross-type collision — and, the thing it was built to fix, a login budget is not consumed by dashboard polls |
| **The five existing response caches** | Four are exemplary. `cachedGatewayStatus` (15 s + `running` flag, stale-while-revalidate, never in the request path), `refreshStratumProbes` (60 s + `running` flag + a 2-strike verdict so one flaky dial is not a verdict), `torProbeCached` (60 s + in-flight Map + a 500-entry bound with expired-first eviction), `getPoolHistory` (TTL + bounded key space + explicitly does *not* cache a failure), `_poolstatsFeed` (60 s + a **bounded** 15-minute last-good window, with the reasoning that a silently-frozen listing feed is worse than a visible error). The gaps were J12-2, J12-6, J12-7, J12-8 and J12-9 |
| **`express.json()` body limit** | Default 100 KB, applied globally ([index.js:232](../../web/07_mining_pool_public/back-end-pool/index.js#L232)). nginx caps at its own 1 MB default everywhere except `/api/admin/` (6 MB, for the 5 MB media upload). Adequate; the per-*value* half is §J9-8's |
| **multer field limits (§J10's handoff)** | Confirmed: neither instance sets `fields`/`parts`/`fieldSize` ([index.js:545-549](../../web/07_mining_pool_public/back-end-pool/index.js#L545), [asset-manager.js:83-86](../../web/07_mining_pool_public/back-end-pool/lib/asset-manager.js#L83)), so multer's defaults apply — `fieldSize` 1 MB but `fields`/`parts` unbounded. **Not a finding**: nginx's `client_max_body_size 6m` on `/api/admin/` bounds the whole body however many parts it is split into, `files: 1` plus the byte cap bounds the file half, and both endpoints are `secureAdmin`. Worth setting explicitly; it is not a lever |
| **`/api/pool/blocks` unbounded `offset` (§J11-9b's handoff)** | **Not a cost lever.** `ORDER BY height DESC LIMIT ? OFFSET ?` uses `idx_block_height`, and `blocks` holds one row per block *this pool finds* — hundreds to low thousands, not a share-volume table. A deep offset walks an index that fits in page cache and returns empty. §J11's *privacy* point (it makes the full `found_by` set walkable) stands on its own; the cost half does not |
| **The two public account CSV exports (§J7's and §J11's handoffs)** | The 10/min `export` bucket is sized correctly. Both are row-capped at 50,000 and scoped to one address ([index.js:3654](../../web/07_mining_pool_public/back-end-pool/index.js#L3654)), so the worst case is ~7 MB per request and 10/min bounds it. Real row counts are far lower — `withdrawals` is one row per payout for one miner, and `balance_log` raw rows prune at 60 days |
| **`crypto.scrypt` on the ownership-proof path** | Uses the **async** form ([owner-proof.js:207](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L207), [:225](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L225)), so the 16 MB memory-hard work runs on the libuv threadpool, **not** the event loop that validates shares, and `maxmem: 64 MB` caps a single call. Up to ~6 compares per withdraw request at 20/min/IP saturates the 4 default threadpool slots but cannot stall share intake. §F2's per-IP throttle is still attached |
| **nginx zone coverage** | `_auth` 200 · `_captcha` 600 · `_api` 600 · `_admin` 2400 · `_static` 6000 r/m, all `$binary_remote_addr`-keyed through `nginx_ensure_rate_limit_zones` ([07_grin_mining_public_pool.sh:1048-1053](../../scripts/07_grin_mining_public_pool.sh#L1048)) — so zone creation goes through the shared primitive CLAUDE.md requires, and nginx's fixed-size shared-memory zones self-bound under a source flood where the app's Maps do not. Every proxied location carries a zone **except** the four in J12-3, plus the two `alias` static blocks (`/uploads/`, `/custom/`, which nginx serves from disk without reaching the app) |

## §J13 — Outbound calls, SSRF & dependencies (2026-09-03, add-ons, NOT VPS-TESTED)

### J13-1 — [Medium] The admin *test* button bypasses every gate the poolstats pusher has, so a pool with the feature switched OFF and no API key still POSTs its live stats to a third party on demand — **FIXED 2026-09-03**

**Threat actor: logged-in admin, including a stolen `secureAdmin` session** (§C3 keeps that a
live actor).

Every precondition the poolstats pusher has lives in `start()`
([poolstats-reporter.js:38-65](../../web/07_mining_pool_public/back-end-pool/lib/poolstats-reporter.js#L38)):
it returns early when `!this.enabled`, returns early when `poolstats_api_key` is blank, and
returns early when `poolstats_endpoint` does not parse as `https:`. `submit()` had **none** of
them — it went straight to `collectStats()` + `httpPost()`. And
[`index.js:5079`](../../web/07_mining_pool_public/back-end-pool/index.js#L5079) calls
`poolstatsReporter.submit()` directly:

```js
app.post('/api/admin/poolstats/test', secureAdmin, (req, res) => {
  poolstatsReporter.submit()          // ← start()'s three gates are not on this path
```

So on a default pool — `poolstats_enabled` is not written by the installer, and the key is
never set — one `secureAdmin` request makes the box POST `pool_name`, `subdomain`, `network`,
live miner count, hashrate, block counts and `pool_fee` to
`https://api.miningpoolstats.stream/submit`, with the header `Authorization: Bearer ` (empty),
from a feature the operator has switched off. The aggregates are public; the *disclosure of
this pool's existence and subdomain to a named third party* is not, and neither is the egress
itself on a box whose whole design is Tor-friendly.

**Its sibling gets this right**, which is what makes it a finding rather than a design
position: `POST /api/admin/alerts/test` refuses with a 400 when no channel is configured
([index.js:5402-5405](../../web/07_mining_pool_public/back-end-pool/index.js#L5402)) —
`'No alert channels are configured. Set a webhook / email / Telegram in pool.json first.'`
Two test routes, written to two different rules.

Two riders found while reading it. (a) **The three poolstats routes have no admin-panel UI at
all** — `grep -rn poolstats admin-panel/` returns nothing, so `GET /api/admin/poolstats`,
`POST /api/admin/poolstats/update-key` (`freshAdmin`) and `POST /api/admin/poolstats/test`
are an unreferenced admin surface reachable only by hand. (b) `getStatus()` returns
`api_key_preview` — the first 7 and last 4 characters of the key
([poolstats-reporter.js:241](../../web/07_mining_pool_public/back-end-pool/lib/poolstats-reporter.js#L241)) —
which is a deliberate and normal affordance, but note it is `secureAdmin`, not `freshAdmin`,
while *rotating* the same key is `freshAdmin`.

**Fixed** by moving the preconditions onto the action instead of onto one of its two callers:
new `_assertSubmittable()`
([poolstats-reporter.js:81](../../web/07_mining_pool_public/back-end-pool/lib/poolstats-reporter.js#L81))
re-checks enabled + key + `https:`, and `submit()` calls it first
([:99](../../web/07_mining_pool_public/back-end-pool/lib/poolstats-reporter.js#L99)). The test
route now answers `500 poolstats reporting is disabled (set poolstats_enabled in pool.json)`
instead of silently sending. The periodic path is unchanged in behaviour — `start()` already
refused to schedule.

---

### J13-3 — [Low] Neither raw-`https` consumer capped its response body, and `timeout` on an `https.request` is an inactivity timer — so a drip-feeding endpoint holds the socket open and grows an unbounded string — **FIXED 2026-09-03**

**Threat actor: whoever operates the configured endpoint** — `api.miningpoolstats.stream`, a
Discord/Slack webhook host, or anything a compromised `pool.json` names. Not reachable by an
anonymous client.

Both raw-`https` sinks accumulated the whole response into a JS string with no bound:

```js
res.on('data', chunk => { responseBody += chunk.toString('utf8'); });   // poolstats
res.on('data', chunk => { data += chunk; });                            // alert-delivery
```

and both relied on `timeout: 10000` in the request options to bound the exchange. That option
sets a **socket inactivity** timer — a server that sends one byte every nine seconds never
trips it, while the string grows for as long as it cares to keep sending. The two are
complementary, not redundant: neither one alone bounds the interaction.

This is a real difference from the two `node-fetch` sinks, which is why it is a finding rather
than a general observation: node-fetch v2's `timeout` *is* applied to the response body as
well as the request
(`node_modules/node-fetch/lib/index.js:384-389`, comment `// allow timeout on slow response
body`), so #1 and #2 in the inventory are bounded in time even though they set no `size`.

**Fixed** with a 64 KB cap in both — far more than any webhook ack or submit response —
destroying the request and rejecting on overflow
([poolstats-reporter.js:180](../../web/07_mining_pool_public/back-end-pool/lib/poolstats-reporter.js#L180),
[alert-delivery.js:223](../../web/07_mining_pool_public/back-end-pool/lib/alert-delivery.js#L223)).
The `res.on('end')` handlers now return early when the cap tripped, so a capped request cannot
also resolve.

---

### J13-6 — [Medium] The deploy step re-runs `npm` only when `package.json` changed, but `npm ci` installs from `package-lock.json` — so a lockfile-only security fix rsyncs onto the box and is never installed — **FIXED 2026-09-03**

**Threat actor: none directly.** This is the patch pipeline, and it fails in the direction
where the operator believes a fix has landed.

`pool_deploy_code` gates the dependency install on a single hash:

```bash
old_pkg_hash=$(sha1sum "$POOL_APP_DIR/package.json" …)
new_pkg_hash=$(sha1sum "$POOL_APP_SRC/package.json" …)
…
if [[ "$old_pkg_hash" != "$new_pkg_hash" ]]; then
    local npm_cmd="install"
    [[ -f "$POOL_APP_DIR/package-lock.json" ]] && npm_cmd="ci"
```

and the `rsync` immediately above it copies the *whole* source tree, lockfile included, with
no `--exclude` for it. So on a lockfile-only change the sequence is: new `package-lock.json`
written to `$POOL_APP_DIR`, hashes compared on `package.json` alone, equal, `info "package.json
unchanged — skipping npm"`, `node_modules` untouched. The box keeps running the old tree while
the lockfile beside it claims otherwise, and **nothing on the box compares the two** — `npm ci`
is the only thing that would have noticed, and it is exactly what was skipped.

This is not a hypothetical shape. `npm ci` installs transitive versions **only** from the
lockfile, and the overwhelming majority of dependency security fixes are transitive: a patched
`qs` under `express`, a patched `cookie`, a patched `raw-body`. All of them are reachable by
regenerating the lock with `package.json` byte-identical. Same code in the Install step at
[07_grin_mining_public_pool.sh:584-588](../../scripts/07_grin_mining_public_pool.sh#L584) —
that one is harmless, because Install always runs `npm` unconditionally.

**Fixed** by hashing both files as one stream, in both the source and the deployed copy
([07_grin_mining_public_pool.sh:901-902](../../scripts/07_grin_mining_public_pool.sh#L901)):

```bash
old_pkg_hash=$(cat "$POOL_APP_DIR/package.json" "$POOL_APP_DIR/package-lock.json" 2>/dev/null | sha1sum | awk '{print $1}')
new_pkg_hash=$(cat "$POOL_APP_SRC/package.json"  "$POOL_APP_SRC/package-lock.json"  2>/dev/null | sha1sum | awk '{print $1}')
```

`cat` of a missing file is a no-op under `2>/dev/null` and the hash of the remaining stream is
still stable, so a tree with no lockfile behaves exactly as before. The two log lines were
updated to name both files, so the skip message does not keep making the claim that caused the
bug. `bash -n` clean.

---

### J13-9 — [Info] Verified correct, with evidence

Each of these was read rather than assumed, and each answers a question the plan asked
explicitly.

**The NIP-05 resolver is closed at three independent layers**, which is the plan's
"an allowed host that 302s to localhost is the classic bypass" question:
(1) `nostr-tools`' `queryProfile` passes **`redirect: "manual"`** to `fetch`
(`node_modules/nostr-tools/lib/cjs/nip05.js:62`) — the library does not follow redirects at
all, so the bypass has no first step;
(2) its `NIP05_REGEX` requires at least one dot in the host, so `localhost` and any
single-label internal name cannot even form a query;
(3) the settings validator normalises to lowercase bare hostnames, rejects IPv4 literals,
leading/trailing dots and `..`, and caps the list at 20
([pool-settings.js:944-953](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L944)),
with an empty list falling back to `['goblin.st']` and never to "allow all". This confirms and
closes §J9's handoff on that key. The call is also wrapped in a 10 s budget
([nostr-payout.js:383](../../web/07_mining_pool_public/back-end-pool/lib/nostr-payout.js#L383)) —
see J13-10 for that budget's one weakness.

**The node and wallet URLs are not settings-writable.** `node_api_url` resolves from
`pool.json` or `NODE_API_URL` only ([config.js:115](../../web/07_mining_pool_public/back-end-pool/lib/config.js#L115))
and appears nowhere in `pool-settings.js`; the wallet Owner URL is built from a constant
`127.0.0.1` and a port ([wallet.js:24](../../web/07_mining_pool_public/back-end-pool/lib/wallet.js#L24));
`node_stratum_host/port` are likewise pool.json-only
([config.js:125-129](../../web/07_mining_pool_public/back-end-pool/lib/config.js#L125)). So the
plan's central question — *can an operator-set URL be aimed at the node's Owner API?* — is
**no** for every settings-writable key. Aiming any of them requires writing `pool.json`, which
is on-box root.

**The price fetch is correct on all four counts the plan named.** The descriptive User-Agent is
present ([index.js:1126-1132](../../web/07_mining_pool_public/back-end-pool/index.js#L1126)),
which memory `project_grin_btc_price_source` says CoinGecko 403s without; there is a 5 s
`AbortSignal.timeout`; failures are negative-cached and in-flight-deduped (§J12-6); and the
result reaches **no money path** — `grep -rn` for the cache and the endpoint finds only the
route itself and its API-docs entry. A dead price feed degrades the footer ticker to
`{ available: false }` and touches nothing else.

**`captcha.js` is genuinely self-hosted.** No `require` of any network module, no third-party
verify call — the answer is generated and checked in-process
([captcha.js:73-97](../../web/07_mining_pool_public/back-end-pool/lib/captcha.js#L73)). The
plan listed captcha as an outbound surface; on this pool it is not one.

**`wallet-tor.js`'s `send` is the pattern CLAUDE.md asks for**, re-confirmed: `spawn` with an
argv array and no shell, the passphrase fed on **stdin** rather than `-p`, a hard
`sendTimeoutMs` kill, and the destination regex-validated by `isPayoutAddress` *before* it
reaches `-d`. The SOCKS proxy is a loopback constant and the onion is derived from the miner's
own bech32 address, never supplied. (`isPayoutAddress` accepting both `grin1` and `tgrin1`
regardless of network is already §J16's, from §J4 — not re-reported.)

**Goblin's four off-by-default layers, re-verified in code** (memory
`project_pool_nostr_payouts`): (1) the default is `'false'` and the validator normalises
empty/absent to `'false'`
([pool-settings.js:223](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L223),
[:929](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L929)), with
`config.js:79` coercing the quoted boolean correctly — the trap from memory
`project_config_loader_type_traps` is not present here; (2) the account summary reports runtime
truth, `!!(nostrBridge && nostrBridge.isEnabled())`
([index.js:3389](../../web/07_mining_pool_public/back-end-pool/index.js#L3389)), and the bridge
is `null` whenever its constructor or `start()` threw
([index.js:602-612](../../web/07_mining_pool_public/back-end-pool/index.js#L602)); (3) the
markup fails closed (§J15's file); (4) the server refuses regardless of the page — 503 on the
`method:'nostr'` withdraw branch
([index.js:4089](../../web/07_mining_pool_public/back-end-pool/index.js#L4089)) and on `POST
/nostr-destination` ([index.js:4261](../../web/07_mining_pool_public/back-end-pool/index.js#L4261)),
with `DELETE` deliberately ungated. All four stand. J13-7 is the one thing this does not
cover: the layers are correct *at boot*.

**The registration route gates before it resolves.** `POST /api/account/:addr/nostr-destination`
runs `requireBothProofs` and the account-existence check *before* calling
`resolveDestination`, so the NIP-05 lookup — the outbound call — is not reachable by an
unproven caller ([index.js:4257-4272](../../web/07_mining_pool_public/back-end-pool/index.js#L4257)).

---

## §J14 — Admin panel front-end (2026-09-03, add-ons, NOT VPS-TESTED)

### J14-1 — [Medium] `paid` is the terminal state of every block the pool actually earned, and the blocks page does not know it exists — so a healthy pool's own history renders as grey unknown rows with a maturity countdown still running, under a KPI that contradicts the table — **FIXED 2026-09-03**

**Threat actor: none (operator observability).** A correctness finding on the screen §J5-8's
money alerts assume an operator is reading.

`lib/rewards.js` flips a block `confirmed → paid` the moment it distributes, roughly 30 s after
maturity ([rewards.js:94, 135](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L94)).
`paid` is therefore not a rare state — on any pool that has run longer than a few hours it is
the status of **almost every block in the table**. §J5-4 established exactly this and fixed the
counters. It did not reach the admin panel, where three separate places still believed the
status set was `immature | confirmed | orphaned`:

1. **`STATUS`** in
   [`admin-panel/blocks.html:94`](../../web/07_mining_pool_public/back-end-pool/admin-panel/blocks.html#L94)
   had no `paid` row, so every paid block fell through to `['badge-dim', b.status]` — the
   **same grey the panel uses for cancelled and expired payouts** — carrying the raw string
   `paid` as its label.
2. **The maturity cell** returned `'—'` only for `confirmed` and `orphaned`. A `paid` block
   took the other branch and, with `blocks_to_maturity` at 0, rendered as **`ready`** — the
   label for a block still *waiting* to be processed.
3. **The backend feeding it**, `GET /api/admin/blocks`
   ([index.js:3029](../../web/07_mining_pool_public/back-end-pool/index.js#L3029)), computed
   `blocks_to_maturity` from the same three-status list.

The compounding part is the filter strip. The chips are All / Maturing / Confirmed / Orphaned,
and `Confirmed` sends `?status=confirmed`, which the route turns into `WHERE status = ?` — an
exact match. The KPI directly above reads `summary.confirmed_blocks`, which `getPoolStats()`
computes as `WHERE status IN ('confirmed','paid')`
([blocks.js:246](../../web/07_mining_pool_public/back-end-pool/lib/blocks.js#L246)). **So the
card says "47 confirmed" and clicking Confirmed shows one row**, with no chip at all that
reaches the other 46. An operator checking whether the pool's blocks paid out sees a table of
grey unknowns and a filter that looks broken.

**Fix (this session).** `paid: ['badge-ok', 'Paid out']` added to `STATUS`; the maturity cell
and `index.js:3029` both extended to treat `paid` like `confirmed`; a `Paid out` filter chip
added. Pinned by `test-admin-panel.js` §1, which also asserts the premise (`rewards.js` still
writes `'paid'`) so the test cannot pass by the status quietly disappearing.

### J14-2 — [Medium] The dashboard's *Recent Withdrawals* table is wired to a schema that has never existed: every row shows a January-1970 date, the literal string `undefined` for the miner, an empty tx column, and a grey "finished" badge whether the payout succeeded or failed — **FIXED 2026-09-03**

**Threat actor: none (operator observability).** `admin-panel/index.html` is the page an
operator lands on, and this table is its only money content.

`GET /api/admin/withdrawals` is `SELECT * FROM withdrawals`
([index.js:2482](../../web/07_mining_pool_public/back-end-pool/index.js#L2482)). That table's
columns are `id, grin_address, amount, fee, fee_charged, status, method, slate_id,
retry_count, …, created_at, confirmed_at, kernel_excess`
([db.js:588](../../web/07_mining_pool_public/back-end-pool/lib/db.js#L588)). The renderer read
four fields and **three of them do not exist**:

| Cell | Code | What the schema has | Rendered |
|---|---|---|---|
| Date | `fmtDate(w.created_at)` → `new Date(iso)` | `created_at INTEGER` **unixepoch seconds** | `21/01/1970, 16:47` |
| User | `escHtml(w.username \|\| w.user_id)` | neither column exists | the literal `undefined` |
| Tx ID | `w.tx_slate_id` | the column is `slate_id` | always `—` |
| Status | `STATUS_BADGE[w.status]` | see below | grey `badge-dim`, for **every** status |

The status map listed `waiting_finalize`, `finalized`, `completed`, `failed`, `expired` — a
set **no payout rail has ever written**. The scheduler's real states are `tor_checking`,
`tor_sending`, `retry_scheduled`, `slatepack_pending`, `finalizing`, `confirmed`,
`tor_failed`, `slatepack_failed`, `nostr_failed`, `slatepack_expired`, `cancelled`, all
enumerated correctly in `payments.html:392`. So every row fell through to
`<span class="badge badge-dim">${escHtml(w.status)}</span>` — and `badge-dim` is precisely the
colour `payments.html` reserves for **cancelled and expired**. A `tor_failed` payout and a
`confirmed` one rendered identically, in the shade that means "over, nothing to do".

That is §H4 verbatim ("Status-list and status-label drift found while reviewing H1–H3 —
**FIXED**") — a fix that landed on `payments.html` only.

Demonstrated with the real code paths and a live `created_at`:

```
created_at            : 1788440579
index.html    fmtDate : 21/01/1970, 16:47:20      ← unscaled seconds
payments.html fmtTs   : 03/09/2026, 13:02:59      ← the same value, ×1000
index.html User cell  : undefined
index.html Tx cell    : —
badge for 'confirmed' : FALLS THROUGH to badge-dim + raw status
badge for 'tor_failed': FALLS THROUGH to badge-dim + raw status
```

**Fix (this session).** `fmtDate` → `fmtTs` (`× 1000`); the User column reads `grin_address`
(truncated, full value in `title=`, matching `payments.html`) and is relabelled **Miner**; the
Tx column reads `slate_id` and is relabelled **Slate ID**; `STATUS_BADGE` replaced with the
eleven real statuses and their `payments.html` labels. `test-admin-panel.js` §2 pins all five,
asserts the schema premise by parsing `db.js` rather than trusting this write-up, checks the
dashboard's badge set still **covers** `payments.html`'s so the two cannot drift apart again,
and carries a control that fails if a status the scheduler never writes reappears.

### J14-3 — [Low] Five row buttons splice an HTML-escaped value into a JS string literal inside an `on*` attribute, where the parser decodes it back before the JS runs — and the only thing stopping it is a validator in another file, on another route — **FIXED 2026-09-03**

**Threat actor: registered miner (`miners.html`), anonymous internet (`users.html`),
logged-in admin (`regions.html`)** — in each case whoever supplies the interpolated value.

`escHtml()` maps `'` to `&#39;`. That is correct in text and in an attribute *value*. It is
**not** correct for a value placed inside a JavaScript string literal that itself sits inside
an attribute, because the HTML parser decodes entities in the attribute value **before** the
JS is handed to the script parser. `&#39;` becomes a real apostrophe, closes the literal, and
everything after it is code. Five sites had that shape:

| Site | Interpolated value | Chosen by |
|---|---|---|
| `miners.html` ban button | `m.grin_address` | registered miner |
| `miners.html` unban button | `m.grin_address` | registered miner |
| `users.html` top failed-login origins | `r.ip` | anonymous internet |
| `users.html` auto-banned addresses | `b.ip` | anonymous internet |
| `regions.html` pairing button | `r.region` | logged-in admin |

`onclick="banMiner('${escHtml(m.grin_address)}')"` with an address of `');alert(1);//` yields
`onclick="banMiner('&#39;);alert(1);//')"`, which the parser hands to JS as
`banMiner('');alert(1);//')`.

**None of the five is exploitable today, and that is the finding.** Each is blocked by
something outside the file:

- The two addresses are blocked by §J6-6's bech32 validator in
  [`lib/stratum-protocol.js:114`](../../web/07_mining_pool_public/back-end-pool/lib/stratum-protocol.js#L114)
  (charset `[ac-hj-np-z02-9]` plus a BIP-173 checksum), and by the same charset test on
  `POST /api/admin/incentives/award` (index.js:6534). Every `INSERT … miner_accounts` call
  site was checked: the other four take an address that already came through one of those.
- The two IPs are blocked by `trust proxy = 'loopback'` (index.js:227) plus nginx's
  `$proxy_add_x_forwarded_for` — `proxy-addr` rejects any non-IP forwarded entry as untrusted
  and stops walking there, so `req.ip` is the real client address and never a header string.
- **`regions.html` has no such guarantee.** `POST /api/admin/locations` applies
  `^[a-z0-9-]{2,12}$` to `region` **only when a `wg_pubkey` is present**
  ([index.js:6098](../../web/07_mining_pool_public/back-end-pool/index.js#L6098)); a
  metadata-only region takes any non-empty string at all. The button is nevertheless
  unreachable for such a region because it renders only when `hasPeer` is true, and `hasPeer`
  is fed from `config.region_ports` or a WireGuard handshake — both of which exist only on the
  pairing branch that *does* validate. The sole defence is that two independent conditions
  happen to be gated by the same `if (wgPubkey)`.

That is defence by coincidence across three files, and exactly the kind of guarantee a later
"let operators name regions freely" change removes without anyone noticing.

**Fix (this session).** All five now pass the value as a `data-*` attribute and read it back
with `this.dataset` — `data-addr="${escHtml(…)}" onclick="banMiner(this.dataset.addr)"` — so
the value never enters a JS parsing context. `test-admin-panel.js` §3 sweeps every panel file
for the `on…="fn('${esc…` shape, carries a control proving the sweep detects the pattern it
looks for, and asserts the three `this.dataset` replacements are wired.

### J14-4 — [Medium] The admin panel is served the **public** page CSP, so it allowlists four third-party script origins and five `connect-src` origins it never uses — handing any admin-panel XSS a ready exfiltration channel — **FIXED 2026-09-03 (follow-up pass)**

**Threat actor: logged-in admin (a stolen `secureAdmin` session), escalating via an XSS the
CSP would otherwise contain.**

The plan asked this session to state plainly that XSS in the panel is unmitigated because the
CSP carries `'unsafe-inline'`. It does, and it is — but the more actionable half is *which*
CSP the panel actually receives.

`/admin/` is served by nginx as **static files**, not proxied:

```nginx
location /admin/ {
    …
    include $hdr_page;
    add_header Cache-Control "no-cache" always;
    try_files $uri $uri/ $uri.html =404;
}
```
([07_grin_mining_public_pool.sh:1315](../../scripts/07_grin_mining_public_pool.sh#L1315))

So the Express security-header middleware — which sets a tight
`default-src 'self'; script-src 'self' 'unsafe-inline'; …` at
[index.js:264](../../web/07_mining_pool_public/back-end-pool/index.js#L264) — **never runs for
an admin HTML page.** What the browser gets is `$hdr_page`, the snippet written for the public
site:

```
script-src  'self' 'unsafe-inline' https://cdn.jsdelivr.net https://www.googletagmanager.com
                                   https://plausible.io https://cloud.umami.is;
connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com
                   https://*.googletagmanager.com https://plausible.io https://cloud.umami.is;
```
([07_grin_mining_public_pool.sh:1276](../../scripts/07_grin_mining_public_pool.sh#L1276))

The admin panel needs **none of it**. Every asset all 21 pages load is same-origin, and both
heavy libraries are vendored locally — the complete inventory:

```
/admin/styles.css   /admin/settings.css   /css/pool.css   /js/vendor/quill.snow.css
/admin/admin-shell.js   /admin/cms-editor.js   /admin/settings-common.js
/js/api.js   /js/auth.js   /js/charts-init.js   /js/stepup.js
/js/vendor/chart.umd.min.js   /js/vendor/quill.js
```

The consequence is narrow but real. `default-src 'self'` would leave an injected script with
no `fetch`/XHR/WebSocket destination at all — data would have to leave by navigation, which is
visible and loses the session. The inherited `connect-src` restores a silent channel: five
third-party hosts, three of them wildcards, reachable from a background `fetch()` on a page
that holds the admin session, the reconciliation figures, the miner ledger and — during
enrolment — the plaintext TOTP secret. The `script-src` half additionally permits an injected
`<script src>` to pull code from jsdelivr, which serves arbitrary npm and GitHub content.

Also absent from both snippets: `frame-ancestors`, `base-uri`, `form-action`, `object-src`.
`X-Frame-Options: DENY` **is** present in `$hdr_common` and is re-included by `/admin/`, so
the plan's clickjacking question is answered — nginx does not strip it, and the include that
keeps it alive is the one §I1 added. `base-uri`/`form-action` matter only once an injection
exists, but they are what stops an injected `<base>` or a re-pointed login form.

**Fix (applied in the follow-up pass).** The panel gets its own snippet rather than the shared
one being narrowed, since the public CSP legitimately needs the analytics hosts:

```nginx
# hdr_admin.conf — the admin panel loads NOTHING third-party (chart.js and quill are vendored
# under /js/vendor/), so it must not inherit the public page's analytics allowlist.
include <hdr_common>;
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" always;
```

then swap `include $hdr_page;` for `include $hdr_admin;` in `location /admin/`.
`'unsafe-inline'` must stay — the panel's logic lives in inline blocks (J14-5) — and
`img-src data:` must stay, because the 2FA enrolment QR is a client-generated `data:` image.

**As shipped.** `pool_setup_nginx` now writes a third snippet,
`/etc/nginx/snippets/script07-<service>-admin-headers.conf`, alongside the common and page
ones, and `location /admin/` includes it instead of `$hdr_page`
([07_grin_mining_public_pool.sh:1281](../../scripts/07_grin_mining_public_pool.sh#L1281)).
The policy shipped is the one above, verbatim. Four notes on the edges:

- **The public CSP is untouched.** `location /` still includes `$hdr_page`; a global tightening
  would have broken the analytics providers and Google Fonts on every public page. The
  regression test asserts both halves — and the control that reads `location /` had to be
  written to skip the pre-certbot **one-line** `location / { try_files …; }` bootstrap vhost
  higher up the same file, which matched first and made the control pass vacuously.
- **The panel's zero-third-party premise is now a test, not a claim.** A sweep over all 21 HTML
  pages fails if any of them gains an off-origin `<script src>` or `<link href>`, because that
  is exactly the edit that would turn this CSP from correct into a blank page. The only
  external URL anywhere in the panel today is the *placeholder text* of the `font_url` input on
  `settings-branding.html` — a value the public site loads, never this one.
- **Cleanup names it.** `/etc/nginx/snippets/` is swept by nothing else on the box (08del walks
  only `sites-available`/`sites-enabled`), so the new file is removed in the same `rm` as the
  vhost that includes it — never before it, which would fail `nginx -t`.
- **The theme export still works under `connect-src 'self'`.** `settings-common.js:729` builds a
  `Blob` and clicks an anchor carrying `download`, so it is a download, not a navigation, and
  no CSP fetch directive applies. Checked before shipping.

**Not verifiable here:** no `nginx -t` was run — nothing in this repo runs on a VPS. The snippet
is generated text; its content is asserted statically and the first real proof is §J17's deploy.
On an existing box it lands only when the operator re-runs *4) Setup nginx*.

### J14-5 — [Low] `npm run check-syntax` — the pool's only pre-commit gate — could not see 2,754 lines of the admin panel's JavaScript, because it lives in inline `<script>` blocks — **FIXED 2026-09-03**

**Threat actor: none (process).** Recorded because that gate's own header comment already
documents one round of this exact failure.

`scripts/check-syntax.js` walks `lib/`, `scripts/` and `admin-panel/` for files ending `.js`.
The panel's three `.js` files are 2,408 lines. **The other 2,754 lines — the payout queue and
freeze kill-switch (`payments.html`), region CRUD and WireGuard pairing (`regions.html`),
ban/unban (`miners.html`), the login-security dashboard (`users.html`) — sit inside one inline
`<script>` per page and were never checked by anything.** Measured by extraction: 21 pages,
21 inline blocks, 2,754 lines.

The gate exists precisely because the previous one reported success unconditionally. A syntax
error in `payments.html`'s inline block takes down the whole payouts page — including the
`AdminTable.create` calls that run at parse time, which is the exact failure the no-op handle
in `admin-shell.js:549` was written to prevent — and `npm test` would still be green.

**Fix (this session).** `check-syntax.js` now extracts every inline `<script>` (skipping
`<script src=…>`), line-pads it so node's reported line number is the real one in the HTML,
and runs the same `node --check`. **Proven to fail**: injecting `{{{ deliberate syntax error`
into `blocks.html` produced `FAIL admin-panel/blocks.html (inline <script> #1)` /
`admin-panel/blocks.html:80` and exit 1; the file was restored and the gate returned to green.
Current output: `Syntax OK — 59 files + 21 inline <script> blocks checked.`

### J14-6 — [Low] A settings save the server refuses reported the fixed string "Save failed", discarding the reason — including the unknown-key error that names the offending element, every validator message, and the step-up refusal — **FIXED 2026-09-03**

**Threat actor: none (operator diagnosis of a security control).**

`saveSection()` posted the section and then did `if (!response.ok) throw new Error('Save failed')`
([settings-common.js:184](../../web/07_mining_pool_public/back-end-pool/admin-panel/settings-common.js#L184)),
so the toast read `Error saving settings: Save failed` for all of:

- `Unknown key '<id>' in section '<x>'` — the error that *names the offending input id*, which
  is the whole diagnostic value described in memory `project_pool_admin_settings_form`;
- every per-key validator refusal, i.e. the visible half of §J9-2 (`pool_fee_percent`),
  §J9-3 (`custom_theme`) and §J9-4 (`min_withdrawal = Infinity`);
- `Re-authentication required to change a fee, whitelist or visibility setting` — the
  §J1-1 / §J9-3 step-up gate. An operator who cancelled the password prompt, or whose step-up
  was refused, got the same three words as for a typo.

The last is the security-relevant case: a gate whose refusal is indistinguishable from a
generic failure is a gate the operator learns to retry rather than to read.
`restoreSection()` had the same shape.

**Fix (this session).** Both read `body.error` and fall back to `HTTP <status>`. The step-up
*retry* path itself was already correct — see J14-10.

### J14-7 — [Low] The announcement and lottery-event attribute escapers escape `"` but not `&`, so an operator's own text is silently rewritten on the next render — **FIXED 2026-09-03**

**Threat actor: none (data integrity).** Not an injection: the values sit in `value="…"` on an
`<input>` and the quote *is* escaped, so there is no breakout.

```js
function bannerAttr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }
function eventAttr(s)  { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }
```
([settings-common.js:803, 887](../../web/07_mining_pool_public/back-end-pool/admin-panel/settings-common.js#L803))

Escaping `"` without escaping `&` first means any entity the operator typed is decoded by the
browser on the way back in. A banner reading `Fees &amp; payouts explained` reloads as
`Fees & payouts explained`, and the next save stores the changed text. Announcement banners
are published on every public page and, per §J1-9, can carry an operator URL onto
`login.html` — a surface whose stored text should not drift on its own.

**Fix (this session).** `&` escaped first in both. Pinned by `test-admin-panel.js` §4.

### J14-8 — [Low] Three escapers used `String(s || '')`, so a legitimate `0` rendered as blank — a pool with no connected rigs displayed "Miners:" with nothing after it — **FIXED 2026-09-03**

**Threat actor: none (operator observability).**

`escHtml` in `health.html:99`, `users.html:179` and `index.html:107` began `String(s || '')`.
Every falsy value — `0` included — became the empty string. On `health.html` that reaches
`renderServiceDetail()`, which builds the stratum card from `svc.miners_connected`,
`svc.port`, `svc.pid` and `svc.size_mb`
([health.html:103](../../web/07_mining_pool_public/back-end-pool/admin-panel/health.html#L103)),
each guarded by `!= null` — so a genuine `0` passed the guard and then rendered as `Miners:`
with nothing after the colon. "Zero miners" and "this field is missing" looked identical on
the health page.

**Fix (this session).** All three changed to `String(s == null ? '' : s)`, matching the six
pages that already used that form. `test-admin-panel.js` §5 sweeps every escaper in the panel
for both properties (all five characters escaped; no `String(s || '')`) and asserts the sweep
found at least ten escapers, so a clean result cannot mean "found none".

### J14-9 — [Low] The ads table presents anonymous-writable counters as a measured click-through rate, with no qualifier — **FIXED 2026-09-03 (follow-up pass); takes J10-3 dispositions 1 + 2**

**Threat actor: anonymous internet.**

Inbound handoff from §J10. `POST /api/public/ads/event` lets any unauthenticated client
increment the impression and click counters with no existence check, dedup or cap (J10-3,
OPEN). `admin-panel/ads.html:600` renders those two numbers as

```js
const ctr = v > 0 ? ` (${(c / v * 100).toFixed(1)}%)` : '';
return `${v.toLocaleString()} / ${c.toLocaleString()}${ctr}`;
```

under the column heading **Views / Clicks** — a percentage to one decimal place, which reads
as measurement. The page's only qualifier (`ads.html:113`) says *"Views/clicks are coarse
counters (no visitor data stored)"*, which addresses privacy, not trust: it tells the operator
nothing is recorded *about visitors*, not that anyone on the internet can set the number. If
the operator ever bills a sponsor from this column, the figure is attacker-chosen.

**Fix (applied in the follow-up pass).** §J10 offered three dispositions for J10-3, and its own
text argues for option 1 — because option 3, the only one that actually makes the counters
trustworthy, costs the pool a per-visitor record it has decided not to keep. The follow-up
takes **option 1 and option 2**, and explicitly not option 3:

- **Option 1 — the render half (this finding).** The column header is now
  `Views / Clicks (unverified)`, the ratio renders as `(~4.5%)` rather than `(4.5%)`, and the
  note above the table says the counters are *unverified client-reported* numbers that anyone
  can inflate or deflate and are **never a billable measurement** — replacing the old sentence,
  which only promised that no visitor data is stored (privacy, not trust). The qualifier is
  header *text*, not a `title` tooltip, because a tooltip does not exist on touch.
- **Option 2 — the cheap server half.** `recordEvents` now carries the same serving predicate as
  `publicByPlacement` (`is_active = 1` and inside the start/end window,
  [ads.js:157](../../web/07_mining_pool_public/back-end-pool/lib/ads.js#L157)), so an ad the
  public site is **not** showing cannot accrue events at all. That does not stop a determined
  client inflating a live ad, and the code comment says so plainly; it stops the counters of a
  finished or unlaunched campaign moving, which is the case an operator is most likely to read
  as fact. The route still answers `204` unconditionally, so counting fewer rows never becomes
  an id-existence oracle.
- **Option 3 still declined**, on the reasoning §J10 gave: a per-(IP-hash, ad, hour) seen-set
  *is* a per-visitor record, and memory `project_pool_ip_privacy` plus this endpoint's own
  comment both say the pool does not keep one. **§J10-3 therefore stays OPEN as a Medium** —
  the endpoint remains anonymous-writable by design. What changed is that nothing presents its
  output as measurement any more, which is what made it money-adjacent.

A regression test pins both halves, including a control asserting the two SQL predicates stay
identical: if `publicByPlacement` gains a condition and `recordEvents` does not, "served" and
"countable" drift apart silently.

### J14-10 — [Info] Verified correct, with evidence

Everything the plan named that turned out sound, plus the sweeps behind the headline.

- **DOM-XSS sweep — clean, mechanically.** A scanner over all 24 panel files flagged every
  `${…}` interpolation with no escape/format call; each hit was then read in context. All
  operator-, miner- and server-supplied strings reaching `innerHTML` are escaped:
  `miners.html` (address, ban reason), `payments.html` (address, cancel reason, `ip_prefix`,
  wallet identity, reconciliation problem list), `blocks.html` (`found_by`), `users.html`
  (username, IP — *including the attacker-chosen username on a failed login*, which is the
  highest-value string an anonymous actor can push into this panel), `regions.html` (label,
  region, country, `stratum_url`), `ads.html` / `pages.html` / `posts.html` (CMS titles, slugs,
  tags, notes), `health.html` (service messages), `settings-common.js` (IP lists, prize
  ledger, lottery draws, campaign names, page-SEO keys). The remaining unescaped
  interpolations are all numeric (`toFixed`, `toLocaleString`, `parseInt`) or static literals
  from in-file constant maps (`STATUS`, `PLACEMENT_LABEL`, `STATUS_META`, `BLOCK_LABEL`,
  `NAV_LABEL`, `LOGIN_LABEL`). The `${escapeHtmlSafe(…)}` sites in `settings-common.js` were
  separately checked for *context*, since that helper deliberately does not escape quotes: all
  are in text position, and every attribute position uses `escapeAttrSafe` (the page-SEO
  title) or a dedicated `…Attr` helper.
- **`AdminTable`'s own renderer is safe — and it was the right thing to check first.** It
  escapes everything it composes itself: the error row (`'Error: ' + esc(state.err)`), the
  empty row, and the "No rows match “q”" line
  ([admin-shell.js:648](../../web/07_mining_pool_public/back-end-pool/admin-panel/admin-shell.js#L648)).
  Row markup is delegated to each page's `row()`, which is where the escaping obligation has
  to live — and does, above. Its one raw-HTML write, `note.innerHTML`, takes page-authored
  markup with a single `{days}` placeholder filled from `parseInt(settings[key], 10)`; the
  API-supplied variant (`setNoteDays(a.window_days)`) is a server integer.
  `window.Explorer.link()` escapes both its URL and its label and `encodeURIComponent`s the
  value into the path.
- **No token, secret or credential reaches client storage.** The panel's only
  `localStorage`/`sessionStorage` writes are the theme key, the sidebar scroll position, the
  cached network name, and the two `AdminSession` activity timestamps
  (`admin-shell.js:132, 258, 475, 861`). Sessions are httpOnly cookies (index.js:883, 892);
  `Auth.setToken()` is a documented no-op and `API.decodePayload()` returns `null`. Nothing
  puts a token in a URL — the only query strings the panel builds are `?hours=`, `?days=`,
  `?limit=`, `?status=`, `?type=` and `?remove_peer=1`, all `encodeURIComponent`'d where they
  carry a value. The two secrets the panel *does* display — the TOTP enrolment secret and the
  recovery codes — go through `textContent`, and the otpauth QR is generated client-side.
  Pinned by `test-admin-panel.js` §6.
- **Step-up: the client re-authenticates and retries; it does not silently drop a money
  action.** `adminFetch()` returns non-403s untouched, inspects a 403 via `res.clone().json()`
  so the caller can still read the body, and steps up only on `challenge_required` — an
  IP-allowlist or role 403 is correctly *not* treated as recoverable
  ([stepup.js:59](../../web/07_mining_pool_public/public_html/js/stepup.js#L59)). It asks for
  the TOTP code only when the server answers `totp_code_required`, surfaces §J2-1's lockout
  and `retry_after_seconds` instead of failing mutely, and on cancel hands the original 403
  back so the caller reports it. All 16 `adminFetch` call sites check `res.ok` (or an
  equivalent body test) before claiming success, except `pushSeoGa4ToAnalytics()`, which is
  deliberately best-effort and documented as such.
- **Every page that calls a `freshAdmin` route also loads `stepup.js`.** Checked mechanically:
  `miners.html`, `payments.html`, `regions.html`, `users.html` and all ten settings pages load
  it; `ads.html`, `pages.html`, `posts.html`, `blocks.html`, `health.html` and `index.html` do
  not — and every route those six call (`/api/admin/ads*`, `/api/admin/pages*`,
  `/api/admin/posts*`, `/api/admin/media`, `/api/admin/blocks`, `/api/admin/health*`,
  `/api/admin/dashboard`, `GET /api/admin/withdrawals`) is `secureAdmin`
  (index.js:2832–3000, 5538–5989). So there is no page that can meet a step-up challenge it
  has no handler for.
- **Clickjacking: `X-Frame-Options: DENY` survives to the admin panel.** Set by Express
  (index.js:265) *and* by nginx's `$hdr_common`, which `location /admin/` re-includes
  alongside its own `add_header` — the §I1 discipline holding. The `frame-ancestors` gap was
  J14-4, and the follow-up pass closed it for `/admin/` (`frame-ancestors 'none'` is in the new
  admin snippet); the *public* pages still rely on `X-Frame-Options` alone.
- **The auth gate is on every page.** `API.guardAdminPage()` is called by all eleven data
  pages directly and by `settings-common.js`'s `DOMContentLoaded` handler for all ten settings
  pages. It bounces only on 401/403 and treats 429/503 as transient — the same posture §J12-3
  established server-side. nginx's `auth_request /admin/_authcheck` is the real gate; this is
  the documented fallback.
- **The settings-harvester id sweep re-runs clean.** Re-implemented from memory
  `project_pool_admin_settings_form` against the live `PoolSettings.defaults`: for each of the
  ten settings pages, every `input`/`select`/`textarea` id inside `.settings-form` that is not
  `settings-skip` was diffed against that section's default keys. **Zero orphans** — which is
  the specific confirmation §J9-1 needed, since deleting `pool_visibility`,
  `address_whitelist`, `max_miners` and `mining_mode` from the defaults would have made
  `pool_info` throw `Unknown key` on every save had any input survived. The reverse check (a
  real key wrongly carrying `settings-skip`, which would make a field silently never save) is
  also clean, and the five `settings-allow-empty` fields are exactly the five the memory
  documents (`hub_country_code`, `ga_tracking_id`, `public_stratum_host`, `founded_year`,
  `home_title`).
- **`cms-editor.js`'s raw `innerHTML` in `setHTML()` is operator content by design** — it is
  the editor round-trip for `pages.html` / `posts.body_html`, the same operator-trusted tier
  §J1-1 settled. Uploads go through `/api/admin/media`, which §J10-1 fixed to sniff the file
  rather than trust the declared MIME, and nginx serves `/uploads/` under a `sandbox` CSP.
- **The manual/Tor payout form submits what it displays.** `sendTorPayout()` and
  `recordManualPayout()` build their confirm text from the same `address`/`amount` locals they
  post (`payments.html:1057–1099`) with no transform in between, and both disable their button
  for the duration. `postPayoutWithAcks()`'s two escalation flags (`verified_ack`,
  `above_min_needs_ack`) are each asked once and carried across the retry, so neither can be
  set without an explicit operator confirmation that names what it waives.

## §J15 — Public front-end (2026-09-03, add-ons, NOT VPS-TESTED)

### J15-1 — [Medium] `maintenance_message` reaches `innerHTML` raw on eleven public pages — the sixth operator-HTML sink, the one §J1-1's key table missed, and the only one still at plain `secureAdmin` with no validator at all — **FIXED 2026-09-03**

**Threat actor: an attacker holding a live admin access token (§C3), or a logged-in admin.**
The §J1-1 actor, at the §J1-1 tier.

`showMaintenance()` built the overlay by string concatenation and set it with `innerHTML`.
The title on the line above went through `escapeText()`; the message did not:

```js
inner += '<h1 …>🛠 ' + escapeText(maint.title || 'Under Maintenance') + '</h1>';
inner += '<div style="…">' + (maint.message || '') + '</div>';   // operator-controlled message
overlay.innerHTML = inner;
```
([branding.js:1078–1086](../../web/07_mining_pool_public/public_html/js/branding.js#L1078-L1086),
pre-fix). The comment `// operator-controlled message` is the whole justification, and it is
the §B accepted risk applied to a field that was never in it.

**Why §J1-1 did not catch it.** §J1-1 built its table from the *settings keys* it could see in
`analytics` and `branding`. `maintenance_message` lives in a third section, `notices`
([pool-settings.js:629–632](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L629-L632)),
and the only `notices` key with any validator is `banners`
([pool-settings.js:862–872](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L862-L872)) —
`maintenance_message` has none: no length cap, no HTML filter, nothing. It is also in neither
gate: `STEP_UP_SETTINGS_KEYS` does not list it
([index.js:6790–6817](../../web/07_mining_pool_public/back-end-pool/index.js#L6790-L6817)) and
`STEP_UP_SETTINGS_SECTIONS` is `['payout','access','incentives','database']`
([index.js:6770](../../web/07_mining_pool_public/back-end-pool/index.js#L6770)) — `notices` is
not among them. So after §J1-1 promoted `custom_head_html`, `custom_body_html`, `custom_css`,
`font_url`, `font_family`, `cta_link`, the three analytics origins and (in §J9-3)
`custom_theme`, **this was the one raw-HTML sink left at plain `secureAdmin`.**

**It is not innerHTML-inert.** A bare `<script>` set via `innerHTML` does not execute, but
`<img src=x onerror=…>` does — the same distinction §J1-1 already recorded for `ads.js`.

**Blast radius.** `showMaintenance` runs on every page whose `<html>` lacks
`data-maintenance="exempt"`. Exactly two pages carry it — `login.html:2` and
`account-settings.html:2` — so the overlay renders on the other **eleven**: `index`, `blocks`,
`blog`, `post`, `page`, `donate`, `fortune-board`, `miners-stats`, `network-map`,
`payment-history`, `api-docs`. Login being exempt means this does not reach the password
field the way §J1-1 did, which is why this is Medium and not High. It is still script
execution **on the origin that also serves `account-settings.html`**: same-origin, so
`window.open('/account-settings.html')` from an injected script gives full DOM access to the
withdrawal form regardless of `X-Frame-Options: DENY`.

There is no CSP containment. The page CSP is `script-src 'self' 'unsafe-inline'`
([07_grin_mining_public_pool.sh:1286](../../scripts/07_grin_mining_public_pool.sh#L1286)).

**Fix applied — escape it, don't gate it.** `maint.message` now goes through the same
`escapeText()` as the title
([branding.js:1085](../../web/07_mining_pool_public/public_html/js/branding.js#L1085)). Gating
would have been the §J1-1 move, but this field is not an HTML-authoring surface: it is a
status notice, its shipped default is one plain sentence, and no admin page offers it as a
rich-text editor. Escaping removes the sink instead of locking a door in front of it. **What
an operator loses:** a `<b>` in a maintenance message. If one ever needs a link, add it as a
`link`/`link_text` pair through `safeHref()` the way `renderBanners()` already does (§J1-9) —
never by widening this back to raw HTML.

**Pinned** by `test-branding-sinks.js` section [5], with a control that fails if the overlay
does not render at all and a second control asserting the `&lt;img` entity is *present* — so
the test cannot pass by the message being dropped rather than escaped.

**Handoff to §J1 / §J9 (defence in depth, not applied here):** `maintenance_message` still has
no validator and no length cap — it is one of the unbounded settings values §J9-8 left OPEN —
and `notices` is still not a step-up section. The escape closes the script path; the missing
cap is §J9's.

---

### J15-2 — [Medium] `Auth.fetch` never rejects and hands a 429's JSON body back as data, so every "unavailable" branch on the public pages was dead code and one rate-limited request rendered the pool as zero miners, zero blocks, zero payouts and a 0.0 % fee — **FIXED 2026-09-03**

**Threat actor: anonymous, plus the system itself.** No attacker is required — an API
restart, a node blip, or the visitor's own reload rate is enough. It is also reachable
*against* a population: the app rate limiter buckets per `req.ip`, and every visitor behind
one NAT or one un-`X-Forwarded-For`'d proxy location shares a bucket (the §J12-3 shape).

`Auth.fetch()` ([auth.js:39–78](../../web/07_mining_pool_public/public_html/js/auth.js#L39-L78))
puts its entire body inside one `try/catch` that returns `null`. It therefore **cannot
reject**. It also returns the *parsed body* of a non-2xx — deliberately, because the admin
panel reads `body.error` off a 4xx to show the server's reason (34 sites; `ads.html:670`,
`pages.html:219`, `posts.html:261`, …). That contract is right for the panel and wrong for a
public page, and eleven public reads used it anyway.

**Demonstrated, not inferred.** The real `auth.js` was run in a `vm` context against a stubbed
`fetch` in four modes, and the guard expressions from the three consuming pages were then
replayed verbatim on its return value:

```
── 429 JSON ──  rejected? false   returned: {"error":"Too many requests","message":"Rate limit
                                             exceeded. Retry after 37 seconds.", …}
  reactor loadStats  "if (!s) return" -> guard passed? true
    c-miners = 0 | c-blocks24 = 0 | c-total = 0 | c-reward = 0
    pl-fee   = 0.0% | pl-min = 0.0 GRIN
  reactor loadBlocks -> "NO BLOCKS FOUND YET"
  miners-stats renderHrPage -> "No active miners in the last 24 hours"
  payment-history ph-paid-all = 0.000 | ph-count-all = 0 | ph-fee-pct = 0 %

── 502 HTML ──  rejected? false   returned: null      (same four render lines)
── net error ──  rejected? false   returned: null     (same four render lines)
── 200 OK   ──  rejected? false   returned: {"active_miners":42, …}
  reactor loadStats -> c-miners = 42 | c-blocks24 = 3 | c-total = 118 | c-reward = 7080
```

The `200 OK` row is the control: the harness renders real numbers when the response is good,
so the zeros above are the code's behaviour and not the shim's.

Two distinct defects, both visible in that output:

1. **A 429 body is an object, so `if (!s) return` does not fire.** The rate limiter answers
   `res.status(429).json({error, message, retry_after_seconds, limit, window_minutes})`
   ([rate-limiter.js:136](../../web/07_mining_pool_public/back-end-pool/lib/rate-limiter.js#L136),
   [:214](../../web/07_mining_pool_public/back-end-pool/lib/rate-limiter.js#L214)). Every
   `s.active_miners || 0` then evaluates to `0` — not a placeholder, a **number the page
   presents as live**. On `/api/config/pool-info` that is a published **0.0 % pool fee and a
   0.0 GRIN minimum withdrawal**.
2. **`Auth.fetch` never throws, so every `catch` around it was unreachable.** The strings
   `'Hashrate data unavailable'`, `'Block-finder data unavailable'`,
   `'Hashrate history unavailable'` (miners-stats.html) sat in blocks that could not run. The
   reachable branches said the opposite: *"No active miners in the last 24 hours"*, *"No
   blocks found in the last 30 days yet — be the first!"*, *"NO BLOCKS FOUND YET"*, *"NO
   PAYOUTS YET"*, and on the transparency page **`Total paid all-time` → `0 ツ`, `Payouts
   all-time` → `0`, `Effective pool fee` → `0 %`**.

That last one is the sharpest: `payment-history.html` exists to prove the pool pays. During
any outage it asserted the pool has never paid anyone.

**This is the §J14 handoff instantiated.** §J14 noted the `null`-ambiguity and handed it over;
what it could not see from the panel side is that on a public page the ambiguity resolves into
a *false statement about money*, and that the honest strings were unreachable.

**One page already had it right**, which is what proves the pattern was reachable and simply
not applied: `donate.html:389–397` distinguishes the two and prints `DONOR DATA UNAVAILABLE`.

**Fix applied.**
- New `Auth.read(url)` ([auth.js:80–111](../../web/07_mining_pool_public/public_html/js/auth.js#L80-L111)) —
  parsed body on a 2xx **only**; `null` on any non-2xx, any non-JSON body and any network
  failure. `Auth.fetch` is left exactly as it was, so the 34 admin sites that read `body.error`
  keep working. `Auth.read` also does no 401 redirect: a public page has no session to lose.
- All eleven public reads in `reactor-dashboard.js`, all seven in `miners-stats.html` and all
  three in `payment-history.html` switched to it. `grep -c 'Auth.fetch' js/reactor-dashboard.js`
  is now `0`.
- `null` is now distinguished from empty where the distinction is a claim about the pool:
  `BLOCK FEED UNAVAILABLE` + a warn lamp
  ([reactor-dashboard.js:515–524](../../web/07_mining_pool_public/public_html/js/reactor-dashboard.js#L515-L524)),
  `PAYOUT FEED UNAVAILABLE` + a warn lamp ([:590–598](../../web/07_mining_pool_public/public_html/js/reactor-dashboard.js#L590-L598)),
  and `if (data === null) throw new Error('unavailable')` at the four sites in
  `miners-stats.html` / `payment-history.html` whose `catch` already carried the right string —
  which is what makes those blocks reachable for the first time.
- Two pages that use a raw `fetch` with `r.ok ? r.json() : null` had the same collapse with a
  different helper: `fortune-board.html` (a 429 printed *"Winners will appear here after the
  first draw."*) and `api-docs.html` (*"No public endpoints reported."*). Both now reject a
  non-2xx so their existing `.catch` strings fire. `blocks.html` and `donate.html` were already
  correct and are unchanged.

**Not changed, deliberately:** the tiles that fall back to their `—` placeholder
(`ms-miners`, `ph-paid-all`, `pl-fee`, …) now simply keep it, because `Auth.read` returns
`null` and every one of those guards is `if (x)`. Verified each placeholder is `—` and not
`0` in the static markup.

---

### J15-4 — [Low] The one box that gates every money action on the account page is `type="text"`, while the same secret is `type="password"` fifty lines below it — **FIXED 2026-09-03**

**Threat actor: anyone with sight of the screen, plus the browser itself.** Shoulder-surfing,
a screen share, a support screenshot, and browser session-restore.

`#acct-ip-proof` is the single ownership-proof input. `getProof()` reads it
([account-settings.html:1590–1594](../../web/07_mining_pool_public/public_html/account-settings.html#L1590-L1594))
and **every** money action on the page calls `getProof()` first: the Tor withdraw, the
slatepack create, the slatepack finalize, the Goblin send, and the §J11-2 kernel-proof reveal.
Its own label and placeholder say what it accepts: *"A recent mining IP … **or** your rig's
stratum password"*.

It shipped as `type="text"`. Fifty lines below, `#acct-nostr-pass-proof` — the **same secret**,
on the same page, in the Goblin destination form — was already `type="password"`. One of the
two is wrong, and it is the one that gates more.

Consequences, in order of likelihood: it is legible on screen for the whole session (this page
is long-lived — miners leave it open watching hashrate); `autocomplete="off"` is advisory and
Chrome and Firefox have each ignored it for non-login-shaped fields across various versions,
so the value can land in form-restore and come back on a back-navigation or after a crash; and
it is in every screenshot, which is how miners ask for support.

**Fix applied.** `type="password"` by default, wrapped in `.proof-wrap` with an in-field
**Show / Hide** toggle
([account-settings.html:427–429](../../web/07_mining_pool_public/public_html/account-settings.html#L427-L429),
wired at [:1915](../../web/07_mining_pool_public/public_html/account-settings.html#L1915)). The
toggle exists because the *other* accepted value is an IP address, which is unusable masked —
a plain `type="password"` would have been a worse form. The state is per-session and never
persisted, so a reload always comes back masked, and the button carries `aria-pressed` and an
`aria-label` so the state is announced.

---

### J15-5 — [Low] `custom_theme` still applied on the credential page — the last operator-authored CSS sink above `branding.js`'s guard — **FIXED 2026-09-03 (closes §J9-3's handoff)**

**Threat actor: an attacker holding a live admin access token (§C3).** §J9-3 gated and
validated this key server-side and handed the front-end half here, naming both the fix and the
test hook.

`applyTheme()`'s `custom_theme` loop sat **above** `if (!isCredentialPage())`, so unlike
`custom_css`, `font_url` and `font_family` it reached `login.html`. Confirmed by the harness,
which now prints the pre-fix state as a failure when the change is reverted:

```
FAIL  login: NO custom_theme CSS custom properties (audit J15-5)
      {"--text":"#101010","--bg":"#101010","--pwned-marker":"#123456", …}
```

§J9-3's validator bounds what a value may *contain* (≤200 keys, ≤200 chars, no `url()`, no
`expression()`, no angle brackets, custom properties only) but not what it *means* — whichever
declaration consumes it via `var()` decides that. Setting `--bg` to the value of `--text` is
enough to make the 2FA prompt unreadable, which is the same class of harm as `custom_css` and
the reason `custom_css` has been gated here since §J1-1.

**Fix applied:** the loop moved inside the existing guard, next to `custom_css`
([branding.js:412–428](../../web/07_mining_pool_public/public_html/js/branding.js#L412-L428)),
exactly as §J9-3 specified. A white-labelled login page keeps its accent colour, logo, pool
name and named theme; only the raw variable map is withheld.

`accent_color` travels through the same `setVar()` and is deliberately **not** gated — it is
regex-bound to `/^#[0-9a-f]{6}$/`, so it is a colour and nothing else. That is now pinned as a
positive assertion in the harness, so a future change that widens its validator has to come
back and read the line.

---

### J15-6 — [Low] The public page CSP allowlists `cdn.jsdelivr.net`, which no public page loads — an unused third-party script origin in front of the withdrawal form — **FIXED 2026-09-03**

**Threat actor: an attacker holding a live admin access token (§C3).** This is §J14-4's
argument applied to the public origin.

`$hdr_page` carried `script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net …`. A sweep of
all thirteen public pages and every file under `public_html/js/` found **zero** references to
that host — Chart.js is vendored at `public_html/js/vendor/chart.umd.min.js`, and the only
`jsdelivr` string anywhere in the tree is inside that vendored file's own SRI comment plus two
`node_modules` READMEs. It is a leftover from before the vendoring.

It matters more here than it did in the panel: §B accepts that operator HTML can inject script
into these pages, and the public origin serves `account-settings.html`. An unused third-party
script origin is a ready loader for exactly that.

**Fix applied:** removed from `script-src` in `$hdr_page`
([07_grin_mining_public_pool.sh:1286](../../scripts/07_grin_mining_public_pool.sh#L1286)), with
the reasoning written into the snippet's own header comment. The four analytics origins stay —
unlike jsdelivr they become reachable by design the moment an operator switches a provider on.
`bash -n` clean; `test-admin-panel.js` §7 (which asserts on the header section) still 39/39,
and none of its assertions referenced jsdelivr.

**Handoff to §J16:** this is your file. The plan already tells you to re-read the header
section as one unit now that there are three snippets; this is one token less to read. The
open question §J14 left you is unchanged: `$hdr_page` still sets no `frame-ancestors`,
`base-uri`, `form-action` or `object-src`, which only `$hdr_admin` does.

---

### J15-7 — [Low] The pending-payout strip has no way to say "stuck": every in-flight label is written for the seconds-long case and §J4-3's stranded row rendered as "almost done" forever — **FIXED 2026-09-03 (answers §J4's handoff)**

**Threat actor: the system.** §J4's handoff asked whether a long-lived `finalizing` state
would make the account page's label a lie. It does, and `tor_sending` is worse.

`BASE_PENDING` maps `finalizing` → *"broadcasting to the Grin network — almost done"*
([payout-methods.js:55–58](../../web/07_mining_pool_public/public_html/js/payout-methods.js#L55-L58))
and the Tor rail maps `tor_checking`/`tor_sending` → *"sending over Tor now…"*
([account-settings.html:1174](../../web/07_mining_pool_public/public_html/account-settings.html#L1174)).
**§J4-3 is OPEN**: a crash while a payout is `tor_sending` strands the row permanently — the
balance stays locked, `canWithdraw` stays false because it requires `!a.pending_withdrawals`,
the withdraw button stays disabled, and the strip said *"sending over Tor now…"* about it
indefinitely with nothing to indicate how long. Only `retry_scheduled` had a time on it
(`next attempt …`).

**Fix applied.** The strip now shows how long the payout has been in flight, and past 30
minutes in an in-flight state (`tor_checking`, `tor_sending`, `finalizing`) says so plainly and
tells the miner to contact the operator with the payout number
([account-settings.html:1204–1226](../../web/07_mining_pool_public/public_html/account-settings.html#L1204-L1226)).
`created_at` is already on the wire — the account route selects it into `pendingRow`
([index.js:3320–3325](../../web/07_mining_pool_public/back-end-pool/index.js#L3320-L3325)) — so
no API change was needed. A local `fmtElapsed` was written rather than reusing `fmtAge()`,
which is day-granular (it exists for account age) and rendered a 20-minute-old payout as
"0 days".

This does not unstick anything. It is the difference between a miner waiting and a miner
reporting it — **§J4-3 remains OPEN and is still the real fix.**

---

### J15-8 — [Low] `/api/pool/effort` publishes `round_window_capped` and the dashboard never read it, so a pool that has not found a block presented a window as a round and printed a luck verdict for it — **FIXED 2026-09-03 (answers §J12's handoff)**

**Threat actor: none — display integrity.** §J12-7 added a lower bound to the round window
(the unbounded version summed the whole `shares` table on every request) and shipped
`round_window_from` + `round_window_capped` so the page could say when the figure is measured
from a floor rather than from a block
([index.js:3699–3700](../../web/07_mining_pool_public/back-end-pool/index.js#L3699-L3700)). Nothing
read either field: `grep round_window js/reactor-dashboard.js` returned nothing.

The effort gauge and the sub-line therefore rendered *"luck 87% (lucky)"* for a pool that has
never found a block — a verdict on a round that does not exist. The arithmetic is honest; the
presentation was not.

**Fix applied:** when `round_window_capped` is true the sub-line reads *"no block found yet —
measured from a window, not a round"* and the luck figure is suppressed
([reactor-dashboard.js:430–447](../../web/07_mining_pool_public/public_html/js/reactor-dashboard.js#L430-L447)).
The gauge still shows the effort number, which is the one thing a pre-first-block pool can
legitimately display.

---

### J15-11 — [Info] Verified correct, with evidence

Read and confirmed, not assumed. Each line says what was checked.

- **`login.html` leaks no credential and cannot be bypassed client-side.** No credential
  reaches the URL or history: both handlers `preventDefault()` and POST a JSON body
  ([:486–532](../../web/07_mining_pool_public/public_html/login.html#L486-L532),
  [:534–585](../../web/07_mining_pool_public/public_html/login.html#L534-L585)). `twofaToken`
  lives in a closure variable, never in storage — the whole-tree storage sweep below confirms
  it. The TOTP step cannot be skipped: `handleTotp` navigates only on `data.success` from
  `/api/auth/login/totp`, and the password step's only other exit is `data.totp_required`,
  which the server sets — there is no client-side branch that reaches `/admin/` without a
  server "yes". `?reason=` is matched against a two-entry allowlist
  (`/[?&]reason=([a-z_]+)/` → `{idle, expired}`) and unknown values render nothing, so the URL
  cannot inject text. The CAPTCHA id is cleared **before** each fetch so a failed refresh says
  "expired" rather than silently reusing a dead challenge.
- **`login.html` loads no shell and therefore no ads.** It deliberately skips
  `public-shell.js` ([:358](../../web/07_mining_pool_public/public_html/login.html#L358)), which
  matters because `mount()` injects a header and footer `[data-ad-slot]` on every page that
  *does* load it and then appends `/js/ads.js`
  ([public-shell.js:335–357](../../web/07_mining_pool_public/public_html/js/public-shell.js#L335-L357)) —
  and `renderAd()` inserts `html_code` raw and `activateScripts()` re-creates its `<script>`
  nodes so they run ([ads.js:48–50](../../web/07_mining_pool_public/public_html/js/ads.js#L48-L50),
  [:116–126](../../web/07_mining_pool_public/public_html/js/ads.js#L116-L126)). Ads on the
  credential page would have been §J1-1 all over again through a second loader. They are not.
  Ads **do** render on `account-settings.html`, which is the §B accepted position and no worse
  than `branding.js`'s sinks already on that page at the same `secureAdmin` tier.
- **The Goblin rail's markup fails closed** — layer 3 of the four in memory
  `project_pool_nostr_payouts`, confirmed as §J4/§J13 asked. `acct-pay-nostr-label`,
  `acct-pay-nostr-pane`, `acct-dest-goblin` and the `acct-destinations` wrapper all ship
  `style="display:none"` in the static HTML and are revealed only by `applySummary()` on
  `summary.nostr_payouts_enabled`
  ([payout-goblin.js:210](../../web/07_mining_pool_public/public_html/js/payout-goblin.js#L210),
  [payout-methods.js:122–137](../../web/07_mining_pool_public/public_html/js/payout-methods.js#L122-L137)).
- **The rail list is server-driven and no public page names an optional rail in visible static
  copy.** A grep for `Goblin|Nostr|nostr` across the other twelve pages and `public-shell.js`
  returns two hits, both the operator's *social* link hook (`data-brand="social-nostr"`), itself
  hidden until configured. The `PayoutMethods` registry holds no rail names in shared page code,
  and the `fallback: true` rail is Tor — the one that cannot be switched off.
- **The withdrawal status map matches what the scheduler actually writes.** Enumerated every
  status literal across `withdrawal-scheduler.js`, `dormancy.js`, `nostr-payout.js` and
  `index.js`: `pending` (never inserted), `tor_checking`, `tor_sending`, `tor_failed`,
  `slatepack_pending`, `slatepack_expired`, `slatepack_failed`, `finalizing`, `retry_scheduled`,
  `confirmed`, `cancelled`, `nostr_failed`. All twelve are covered by `BASE_STATUS` plus the
  three rail `statuses` maps; rows insert as `tor_checking` or `slatepack_pending`, never
  `pending`. This is the §J14-1/§J14-2 class of bug and the public page does **not** have it.
  One dead entry: Goblin declares `nostr_sending`, which nothing writes — harmless,
  `statusLabel` falls back to the raw string.
- **§J11-1 and §J11-2's render halves are in place.** `miners-stats.html addrCell()` is plain
  text with the deep-link removed and the reasoning in a comment; `blocks.html` dropped the
  full-address `title` tooltip; `donate.html donorCard()` renders a masked address with neither
  link nor title; the account page's kernel column shows `hidden` until `revealProofs()` returns
  one for the ownership-proved address, and `revealedProofs` is cleared on every new lookup so a
  revealed kernel cannot survive into another address's view
  ([account-settings.html:906–908](../../web/07_mining_pool_public/public_html/account-settings.html#L906-L908)).
- **§J6-9's render half is closed at the source, so there is nothing to fix here.** Worker names
  are `escHtml`'d into the account page's table
  ([account-settings.html:1257–1262](../../web/07_mining_pool_public/public_html/account-settings.html#L1257-L1262)),
  and §J6-9's backend fix means a row can no longer be planted on a stranger's account without
  an accepted share behind it. §J14 confirmed the admin panel renders no worker labels at all,
  so the trace ends here.
- **Nothing sensitive is in browser storage.** Whole-tree sweep of `localStorage` /
  `sessionStorage`: the miner's own Grin address (`ADDR_KEY`, with a comment saying why),
  `cookie-consent`, `banner-dismissed-<id>`, `pool-network`, `grinium-theme`, and ads'
  per-placement session dismissal. **No token, no proof, no password, no address of anyone
  else.** Every access is wrapped in `try/catch` for private mode.
- **No external script, stylesheet, font or beacon in any static page.** The only absolute
  off-origin references anywhere in `public_html/*.html` are two `<a href>` — `world.grin.money`
  on the network map and the `tools.grin.money` link of J15-10 — plus the SEO URLs of J15-3.
  Fonts are self-hosted under `public_html/fonts/`; `fonts.googleapis.com` appears exactly once
  in the tree, inside `branding.js`'s `font_url` branch, which only runs when the operator sets
  one. The page CSP (`default-src 'self'` + the analytics origins + Google Fonts) is therefore
  wider than what any page actually loads — J15-6 removed the one entry that can never be
  needed; the analytics hosts stay because §J11-4 left the *feature* available while removing
  the *default*.
- **No `on*` handler anywhere splices an interpolated value.** This is §J14-3's bug class on the
  public side. A regex sweep for an `on…=` attribute containing `${`, `' +` or `" +` returns
  nothing; the nine static `onclick` attributes that exist (`blog`, `donate`, `fortune-board`,
  `login`) are literal function calls with constant arguments.
- **`Explorer.link()` is safe for untrusted chain strings** — `encodeURIComponent` on the value,
  then `xEsc` (all five characters) on both the built URL and the label
  ([branding.js:147–166](../../web/07_mining_pool_public/public_html/js/branding.js#L147-L166)).
  It is the only HTML-returning helper used across pages and it is used at six sinks.
- **`safeHref()` still covers all five operator URL fields** (§J1-9): banner link, `cta_link`,
  social links, `support_forum_url`, `pgp_key_url` — parsed with the WHATWG `URL` parser,
  `http:`/`https:` only. `test-branding-sinks.js` section [4] pins it on both a normal page and
  the credential page, with a control that an `https` link *does* render.
- **`injectStructuredData` cannot break out of its `<script>`.** It sets `textContent` on an
  element created with `createElement`, so a `</script>` inside a value is never re-parsed.
- **`api.js guardAdminPage()` escapes the username** with all five characters before
  `nav.innerHTML` ([api.js:111–114](../../web/07_mining_pool_public/public_html/js/api.js#L111-L114)),
  and no public-page JS writes a token to storage, a URL or a log — re-confirming §J14's finding
  from the file's own side of the split.
- **`network-map.js` is clean beyond §I10's fix.** `esc()` covers every operator-authored region
  label at all four sinks; the interpolated colours are literals or computed from a three-way
  status switch; `fillPlacard`'s `set(id, html)` receives only `String(number)` and literal
  `<small>` wrappers; `#nm-note`'s messages are constant strings chosen by a branch, not
  composed from feed data.
- **`charts-init.js` (591 lines) contains no HTML sink at all** — every label goes through
  Chart.js as data.

---

## §J16 — Deployment & infra (2026-09-03, add-ons, NOT VPS-TESTED)

### J16-1 — [Medium] The first-admin password is passed in **argv**, twice, so the plaintext sits in `/proc/*/cmdline` for the whole registration — readable by exactly the account a backend RCE lands on — **FIXED 2026-09-03**

**Threat actor: any unprivileged local account, and specifically `grinpool`.**

`pool_setup_admin` read the password with `read -rs` (correct), then handed it straight to two
`execve()`s:

```bash
payload=$(node -e "…JSON.stringify({password: process.argv[2]…})" \
    "$admin_user" "$admin_pass" "${admin_email:-}")      #  argv[2]
resp=$(curl -sS -X POST … -d "$payload" …)               #  the JSON, password included
```

`/proc/<pid>/cmdline` is world-readable on a default Linux box — `hidepid` is not set by this
toolkit or by any supported distro's default — so both processes published the plaintext to
every local account for as long as they ran. The `node` hop is milliseconds. **The `curl` hop is
not:** it stays alive for the whole HTTP round trip, and the server side of that round trip is a
deliberately slow bcrypt hash. That is a comfortable polling window, and nothing about it is
racy — the operator runs this step on a schedule the attacker can watch (`7) Create admin
account`, or the guided flow, or any later re-run after a `Z) Cleanup`).

This is the same trap CLAUDE.md sets out for `grin-wallet -p`, and §J8 verified that the *wallet*
passphrase respects it on both consumers ("the passphrase is not in `ps aux`" — §J8's inventory
row 9). The admin password did not, and no pass had looked.

**Why it is worth more than "they already have the box".** The reader most likely to be present
is `grinpool`, and `grinpool` already has `pool.db` — i.e. the **bcrypt hash**. The plaintext is
strictly more: it is what passes `/api/admin/reauth`, and `freshAdmin` (the step-up +
mandatory-2FA tier) is, per §J1's own framing, *"the only control that a stolen token does not
carry."* Every money-moving route sits behind it. So the leak converts "attacker has the backend"
into "attacker has the step-up gate too", and it is very likely a password reused elsewhere.

**Fix applied** ([:1898–1924](../../scripts/07_grin_mining_public_pool.sh#L1898)). Both hops are
stdin-fed. `printf` is a bash **builtin**, so the values never reach an `execve()` at all:

```bash
payload=$(printf '%s\0%s\0%s' "$admin_user" "$admin_pass" "${admin_email:-}" | node -e "…")
resp=$(printf '%s' "$payload" | curl -sS … --data-binary @- …)
```

NUL-separated rather than newline-separated so no field can be confused with another and a
password may contain anything but NUL. Verified against the real builder with a password
containing a space, a double quote and a colon — `{"username":"bob","password":"p@ss w:rd\"x",
"email":""}`, byte-identical in shape to what the argv version produced. `bash -n` clean.

---

### J16-3 — [Medium] The gateway's HAProxy — the process terminating anonymous internet TCP on a box that holds a WireGuard key into the pool — ran as **root** for its entire life — **FIXED 2026-09-03**

**Threat actor: anonymous internet.**

The generated `haproxy.cfg`'s `global` section carried `log` and `maxconn` and nothing else — no
`user`, no `group`, no `chroot` — and the generated unit carried no `User=` and no sandbox
directives at all:

```
[Service]
Type=simple
ExecStartPre=/usr/sbin/haproxy -c -f …
ExecStart=/usr/sbin/haproxy -f … -db
Restart=on-failure
RestartSec=5
LimitNOFILE=65535
```

haproxy drops privileges only when told to, and it was not told to, so it stayed root. The
distro's own `/etc/haproxy/haproxy.cfg` ships `user haproxy` / `group haproxy` — but this is a
**dedicated instance** pointed at its own config file, deliberately not touching the distro's
(comment at [07_lib_gateway.sh:135](../../scripts/lib/07_lib_gateway.sh#L135)), so it inherited
none of that.

This is the exact argument `pool_deroot()` makes for the hub, applied to the box where it was
never applied. The hub's comment states it plainly: *"the backend parses untrusted input from the
public internet on TWO surfaces … root here turned any RCE into hub-WG-key + node-secret +
LE-key compromise"* ([:614–617](../../scripts/07_grin_mining_public_pool.sh#L614)). The gateway
box has one of those surfaces and one of those keys: `/opt/grin/gateway/wg_private.key` and
`/etc/wireguard/wg-grinpool.conf` are the credential that puts a peer inside the pool's tunnel,
and per J16-2 a party inside that tunnel is trusted for every miner in the region.

Nothing needed root: the stratum port is >1024, so root is unnecessary even at bind time.

**Fix applied.**
- `global` now emits `user`/`group` ([:395–400](../../scripts/lib/07_lib_gateway.sh#L395)),
  resolved at render time to `haproxy` where that account exists and `nobody` otherwise —
  emitting a `user` line naming a non-existent account would make `ExecStartPre`'s `-c` fail and
  take the whole service down, which is a worse outcome than the bug. `chroot` deliberately
  omitted: it breaks `log /dev/log`.
- The unit gains `NoNewPrivileges=yes`, `ProtectSystem=full`, `ProtectHome`, `PrivateTmp`,
  `ProtectKernelTunables`, `ProtectControlGroups`, `RestrictSUIDSGID` and
  `RestrictAddressFamilies` ([:158–175](../../scripts/lib/07_lib_gateway.sh#L158)).
  `NoNewPrivileges` is safe here and is *not* safe on the hub unit — the hub deliberately omits
  it because the panel's pairing path runs `sudo grin-gateway-ctl`; a gateway never shells out.
- **Deliberately stopped short of `ProtectSystem=strict` and `PrivateDevices=yes`.** Both are
  the right end state, and both can take away `/dev/log` or a config read in ways that only show
  up on a box. This unit has never started anywhere. §J17 should tighten once a real gateway has
  been seen running — noted in the unit's own comment so the next reader knows it is a staged
  decision, not an oversight.

`bash -n` clean.

---

### J16-5 — [Low] The vhost is symlinked into `sites-enabled` **before** it is tested, and left enabled when the test fails — so one bad `admin_allowlist` entry takes **every site on the box** down at the next reboot — **FIXED 2026-09-03**

**Threat actor: none — this is an availability trap, and the operator springs it.** Reported
because the blast radius is the whole box, not the pool.

Both write paths did the same thing:

```bash
ln -sf "$POOL_NGINX_CONF" "$sites_enabled" 2>/dev/null || true
nginx -t 2>&1 && systemctl reload nginx \
    || { error "nginx config test failed. Check $POOL_NGINX_CONF"; return 1; }
```

On a failed test the function prints an error and returns — and the broken file stays symlinked
into `sites-enabled`. The **running** nginx is unaffected (the reload never happened), so nothing
looks wrong. The next `nginx` **start** is what fails, and that is a reboot, or a `systemctl
restart` from any other toolkit script, or certbot's renewal hook. nginx refuses to start with a
config error, so every vhost on the box goes down together — the same failure shape memory
`project_fidelius_wg_dns01_access` records for a down `wg0`, from a different cause.

The likely trigger is not a generator bug. `admin_allowlist` is a hand-edited `pool.json` string
split on commas and spliced straight into `allow ${_entry};`
([:1163–1168](../../scripts/07_grin_mining_public_pool.sh#L1163)) with no validation, so a
stray character in an operator's CIDR list is enough. (The splice itself is on-box-root input and
therefore Info under plan rule 7 — the *deferred, box-wide* failure is what makes it worth a
finding.)

The same lines also swallowed the symlink's own failure: `2>/dev/null || true` meant a failed
`ln` left `nginx -t` passing — because it was testing *without* this vhost — and
`success "nginx configured for https://…"` printing over a site that was never enabled. That is
the errexit-suppression class CLAUDE.md and memory `project_lib_errexit_suppression` describe,
in the parent script rather than a lib.

**Fix applied** at both sites ([:1596–1606](../../scripts/07_grin_mining_public_pool.sh#L1596)
for the HTTP bootstrap, [:1655–1682](../../scripts/07_grin_mining_public_pool.sh#L1655) for the
SSL vhost). `ln -sf` is now guarded and fatal. On a failed `nginx -t` the symlink is removed
again **when this run created it**; when the vhost was already enabled the previous symlink is
left in place (removing it would take a *working* pool offline to protect against a reboot) and
the operator is told explicitly that the on-disk file is invalid and must be fixed before any
restart.

---

### J16-6 — [Low] The gateway accepts a `GRINGW1|` pairing string with only its **port** validated, so one field of an out-of-band text line sets the box's `AllowedIPs` — **FIXED 2026-09-03**

**Threat actor: whoever hands the gateway operator their pairing line.** The pool operator, or
anyone impersonating them — the string is explicitly designed to travel out of band ("Copy the
key above to the pool operator… Both hand back one `GRINGW1|…` line").

`gw_apply_pairing_string` checked the tag, checked six fields for non-emptiness, and checked
`port` was digits. Every value then landed verbatim in `/etc/wireguard/wg-grinpool.conf`.

The field that matters is `hubip`, which renders as `AllowedIPs = ${hub_ip}/32`. WireGuard
accepts a **comma-separated list** there, so `0.0.0.0/0, 10.66.66.1` renders as a syntactically
valid catch-all, and `wg-quick up` then installs a default route into the tunnel. Combined with
`pub` and `ep` from the same line (also unvalidated, also attacker-chosen), the gateway box's
**entire egress** goes to a WireGuard peer of the sender's choosing, with a working handshake. It
is a noisy attack — the same field feeds `server central ${hubip}:${port}`, so haproxy's `-c`
check fails and the forwarder does not start — but a dead forwarder on a freshly-paired box reads
as a pairing problem, which is exactly what the operator has been told to expect at that step.

The asymmetry is the tell: the **hub's** helper validates every input it takes before touching
anything — `--net` against an enum, `--region` against `^[a-z0-9-]{2,12}$`, `--pubkey` against
the 44-char WireGuard wire format, and its header says *"validates ALL inputs itself (never
trusts the caller, even root)"* ([07_lib_gwctl.sh:34](../../scripts/lib/07_lib_gwctl.sh#L34)).
The edge, which is the side receiving a string from someone else, validated one field.

**Fix applied** ([:238–255](../../scripts/lib/07_lib_gateway.sh#L238)): per-field shape checks
mirroring what `grin-gateway-ctl` actually emits — region against the hub's own regex, hub key
against the same 44-char base64 form, endpoint as `host:port`, both tunnel IPs as a **single**
dotted-quad (optionally `/32` for the gateway's own), port range-checked. Each failure names the
offending field rather than falling through to the generic "not a valid GRINGW1 string", so a
transcription error is diagnosable.

---

### J16-7 — [Low] A failed `wg genkey` leaves a zero-byte private key that the idempotency check reports as present **forever**, and the operator is told the keypair was generated — **FIXED 2026-09-03**

**Threat actor: none — a silent-failure trap.** Reported because the hub side already fixed this
exact bug and the edge kept it, and because the failure mode is "everything looks paired and no
handshake ever happens", which is expensive to debug across two boxes.

```bash
if [[ ! -f "$GW_DIR/wg_private.key" ]]; then
    ( umask 077; wg genkey > "$GW_DIR/wg_private.key" )
    wg pubkey < "$GW_DIR/wg_private.key" > "$GW_DIR/wg_public.key"
    success "Generated WireGuard keypair."
fi
```

The redirect creates the file **before** `wg genkey` runs, so a failure leaves a 0-byte private
key. `-f` then says "present" on every subsequent run, so it is never regenerated; `wg pubkey`
on empty input leaves an empty public key; and the install screen prints the (blank) key with
`success`. Nothing is guarded, and this lib runs with errexit suppressed for its whole body
(`gw_install || true` in `pool_gateway_loop`, memory `project_lib_errexit_suppression`), so the
`set -euo pipefail` at the top of the entry script protects none of it.

The hub learned this and wrote the reason down: *"-s (non-empty), not -f: a truncated key file
would otherwise be 'present' and every later pairing string would carry an empty hub pubkey"*
([07_lib_gwctl.sh:160](../../scripts/lib/07_lib_gwctl.sh#L160)), and it also repairs a missing
public half on the "kept" path. The gateway had neither.

**Fix applied** ([:118–143](../../scripts/lib/07_lib_gateway.sh#L118)): `-s` instead of `-f`, an
explicit non-empty check after `genkey`, both commands `||`-guarded with `return 1`, and the
hub's public-half repair branch added. While in the same file, the neighbouring unguarded writes
were closed too — `gw_render_wireguard` now fails loudly if `$GW_DIR/wg_private.key` is empty, if
the config write fails, or if the `chmod 600` on the tunnel key fails
([:390–402](../../scripts/lib/07_lib_gateway.sh#L390)), and `gw_render_forwarder`'s
`cat > "$GW_HAPROXY_CFG"` is guarded ([:392](../../scripts/lib/07_lib_gateway.sh#L392)). The last
one matters most: an unwritten forwarder config used to print `info "Wrote $GW_HAPROXY_CFG"` and
then fail at `ExecStartPre`.

---

### J16-8 — [Low] `_pool_db_scalar` opens the miner database **read-write, as root, on every menu render**, and unlike its sibling never hands the WAL sidecars back — **FIXED 2026-09-03**

**Threat actor: unprivileged local account (a brief 0644 window), and the system (a durable
lockout).**

`_pool_db_scalar` is a `SELECT` helper. `_pool_step_done 7` calls it to draw the ✓ next to
*Create admin account*, so it runs **every time any Script 07 menu is drawn**, as root, against a
database the de-rooted service owns. `DatabaseSync` opens read-write by default, and a read-write
open of a WAL database **creates** `pool.db-wal` and `pool.db-shm` when they are absent — root
owned, `0644` under the default umask. That is the same disclosure §J8-1 closed, on files §J8-1's
own note calls out as carrying *"the most recent writes verbatim"*; `lib/db.js` tightens them only
at **service start**, so anything created while the service is stopped stays `0644` until the next
start. And if that `node` is interrupted the root-owned sidecars persist, after which the
`grinpool` service cannot open its own database — which surfaces as "attempt to write a readonly
database" after nothing but a menu being drawn.

The sibling root-write at the region-card INSERT already knows this and chowns the three files
back ([:2622–2626](../../scripts/07_grin_mining_public_pool.sh#L2622)). The far more frequent
caller did not.

**Fix applied** ([:391–404](../../scripts/07_grin_mining_public_pool.sh#L391)):
`new DatabaseSync(path, { readOnly: true })`. A read-only open has no business creating either
sidecar, so the repair is to stop asking for write access rather than to add a third chown.
Verified the option exists and works on the pinned runtime with a one-shot `node` call against a
scratch DB (node v24.14.1 — `readOnly open OK: { 'COUNT(*)': 1 }`); scratch DB deleted.

While there, **§J8-1's handoff item 3 is applied**: the region-card helper now `chmod 600`s the
three files beside the `chown` it already did
([:2630](../../scripts/07_grin_mining_public_pool.sh#L2630)).

---

### J16-9 — [Low] The `www` → apex HTTPS redirect is a **server block**, so it inherited nothing — it was the one response on the box with no HSTS, no `nosniff` and no `X-Frame-Options` — **FIXED 2026-09-03**

**Threat actor: an active network attacker on a first visit to `www.<domain>`.**

`$www_https_block` emitted `listen`, `server_name`, the two cert paths, `$ssl_extra` and a
`return 301`. It is a **separate `server`**, not a `location`, so the §I1 include rule — which
every reader applies to `location` blocks — never got applied to it, and the block inherited
nothing from the apex server below.

HSTS is scoped **per host**. `www.<domain>` is a different host to the browser, and this vhost
deliberately ships HSTS **without `includeSubDomains`** (with a good, written reason — the
`subdomain` key is frequently the operator's apex, and pinning every sibling for a year is a
blast radius the toolkit should not choose). The two facts combine: the www name was never
pinned, no matter how long the apex had been.

**Fix applied** ([:1279](../../scripts/07_grin_mining_public_pool.sh#L1279)): `include
$hdr_common;` plus `server_tokens off;` in the www block. `add_header … always` applies to a
`301`, so the redirect carries the full common set.

**A second bug found while applying it, and worth its own line:** `$www_https_block` is assembled
inside a double-quoted assignment at [:1210](../../scripts/07_grin_mining_public_pool.sh#L1210),
while `hdr_common` was declared at what was line 1250 — **forty lines later**. Adding the include
naively would have expanded `$hdr_common` to the empty string and emitted a bare `include ;`,
which is a hard `nginx -t` failure that (before J16-5) would have been left symlinked. The four
snippet-path `local`s were moved above the first block that references one
([:1200–1208](../../scripts/07_grin_mining_public_pool.sh#L1200)), with a comment saying why they
live there. This is the kind of thing that cannot be caught by reading the *generated* config,
only by rendering it — see Verification.

---

### J16-10 — [Low] The pool vhost is the only toolkit vhost with no `server_tokens off`, and every rate-limit rejection answers **503** — the same status as a dead backend — **FIXED 2026-09-03**

**Threat actor: anonymous internet (reconnaissance); and the operator, who cannot tell a throttle
from an outage.** Closes **§J11-6's nginx half**.

Two one-line gaps in the same block:

1. **`server_tokens off`.** `grep -rn server_tokens scripts/` returns 051, 051x and 084 and not
   07. §J11-6 fixed the Express half (`x-powered-by` disabled) and handed the nginx banner here.
   With `server_tokens on` (the default) nginx puts its exact version in `Server:` and in its own
   error pages — including the pages the rate limiter serves, which are the responses an attacker
   probing the limits will see most of.
2. **`limit_req_status`.** nginx's default rejection status for `limit_req` is **503**, which is
   also what a proxied location returns when the backend is down. So in the access log, and to
   the front end, "you are being throttled" and "the pool is offline" are the same event. The
   app's own limiter returns **429**, which is what `Auth.read` / `public-shell.js` were built to
   understand after §J15-2 — and §J12-3's whole finding was that a sustained 429 on `robots.txt`
   reads as "do not crawl", which the 503 form reads as *worse*. Script 02 already sets
   `limit_req_status 429` on its own vhost, so this is a consistency gap as much as a bug.

**Fix applied** ([:1400–1407](../../scripts/07_grin_mining_public_pool.sh#L1400)): both
directives on the apex `:443` server; `server_tokens off` also on the www block (J16-9). Not
added to the `:80` redirect server — it emits a bare 301 and no rate limit, and the version
banner there is disclosed by every other vhost on the box anyway; adding it is harmless and can
ride along the next time that block is touched.

`proxy_hide_header X-Powered-By` was **not** added, deliberately: §J11-6 removed the header at
the source, so hiding a header the app no longer emits would be a control with nothing to do and
a comment that goes stale the moment someone re-enables it.

---

### J16-11 — [Low] The public page CSP carried none of `frame-ancestors` / `base-uri` / `form-action` / `object-src`, on the origin that serves the withdrawal form — **FIXED 2026-09-03 (§J16's call, answering §J14 and §J15)**

**Threat actor: an attacker holding a live admin token (§C3), via the operator-HTML sinks §B
accepts.**

Both §J14 and §J15 handed this over as an open question in the same words — *"`$hdr_page` still
sets no `frame-ancestors`, `base-uri`, `form-action` or `object-src`, which only `$hdr_admin`
does … that is §J16's call, not this session's."* **The call is yes**, and for a stronger reason
than symmetry with the admin panel.

§B accepts, by design, that operator-authored HTML reaches the public pages (`custom_head_html`,
`custom_body_html`, ad `html_code`, CMS `body_html` — five sinks, tier settled in §J1-1). The
public origin is also the one that serves `account-settings.html`: the withdrawal form and the
rig-password box. Each of the four directives closes something `default-src 'self'` does not:

- **`base-uri 'self'`** — an injected `<base href="https://evil/">` re-points every *relative*
  URL on the page, including the page's own `/api/account/…` calls. `default-src` does not
  constrain `<base>` at all. On a page whose relative fetches carry a payout destination, this
  is the sharpest of the four.
- **`form-action 'self'`** — stops a form being re-targeted off-origin. Does **not** fall back
  to `default-src`, so its absence was a real hole rather than a redundancy.
- **`object-src 'none'`** — `default-src` covered it as `'self'`; `'none'` is strictly tighter
  and nothing on these pages uses `<object>`/`<embed>`.
- **`frame-ancestors 'none'`** — the CSP form of the `X-Frame-Options: DENY` already in
  `$hdr_common`. Unlike XFO it is honoured for nested frames and by browsers that have dropped
  XFO entirely.

**Compatibility verified mechanically before applying, not by eye:** across all thirteen pages
and every file under `public_html/js/`, there are **zero** `<base>` tags, **zero**
`<object>`/`<embed>`, and **zero** `<iframe>`. The only `<form>`s are the three on `login.html`,
all `onsubmit=`-driven with no `action` attribute (so they submit to the current URL — `'self'`
by definition). Ad-network iframes were already blocked by the existing `default-src 'self'`, so
nothing regresses there.

**Fix applied** ([:1357](../../scripts/07_grin_mining_public_pool.sh#L1357)), with the reasoning
in the snippet's own header comment. The analytics and Google Fonts origins are untouched.
`scripts/test-admin-panel.js` §7 gains two assertions — that `$hdr_page` now carries all four,
and a **control** that it still allowlists the analytics + font origins, so a future tightening
cannot quietly break every operator who switched a provider on. 41/41, up from 39.

---

### J16-13 — [Info] Verified correct, with evidence

Read and confirmed, not assumed. Listed because a later reader should not have to re-derive them.

**1. The header section, re-read as one unit — the plan's headline ask.** There are now three
snippets and **four** blocks that declare an `add_header` of their own. All four re-include:

| Block | Declares | Re-includes |
|---|---|---|
| `location /admin/` | `Cache-Control: no-cache` | `$hdr_admin` ✓ (§J14-4's change, correct) |
| `location /` | `Cache-Control: no-cache` | `$hdr_page` ✓ |
| `location /uploads/` | sandbox CSP + `Cache-Control` | `$hdr_common` ✓ |
| `location /custom/` | sandbox CSP + `Cache-Control` | `$hdr_common` ✓ |

Every other `location` declares no header and correctly inherits the server-level
`include $hdr_page`. The two `alias` blocks correctly take `$hdr_common` and **not** `$hdr_page`
— they serve operator-uploaded files and must replace the page CSP with the sandbox one, which
is the whole reason there were two snippets before there were three. `$hdr_common` is included by
both other snippets rather than duplicated, so `X-Frame-Options`, `nosniff`, `Referrer-Policy`
and HSTS have exactly one definition. The HSTS comment's reasoning for omitting
`includeSubDomains` is sound and should not be "tidied" — see J16-9 for the one consequence it
had. `/etc/nginx/snippets/` is not auto-included on Debian or RHEL, so none of this leaks into
another vhost, and `Z) Cleanup` removes all three snippets (asserted by `test-admin-panel.js` §7).

**2. Bind addresses — nothing else listens publicly, and the port roles are not collapsed.**
`HOST=127.0.0.1` in the unit; `config.host || process.env.HOST || '127.0.0.1'`
([config.js:53](../../web/07_mining_pool_public/back-end-pool/lib/config.js#L53)) and
`pool_ensure_defaults` never seeds a `host` key, so the env value is what `app.listen` gets. Five
distinct roles on five distinct ports: public stratum `3333` on `0.0.0.0` (intended), region
listeners on `region_listen_host` = the hub's tunnel IP, node stratum upstream `127.0.0.1:3416`,
Central API `127.0.0.1:8080` (`8090` testnet), WireGuard `51820/udp` (`51821`). The only port the
installer opens in a firewall is the wg one, in `init-server`; region ports are deliberately left
closed because they bind the tunnel address. Nothing shares a port with anything.

**3. The `isLocalRequest` invariant §J2 asked me to protect is intact.** Every proxied `/api`
location sets `X-Forwarded-For $proxy_add_x_forwarded_for` — all eleven of them, including the
four SEO paths §J12-3 fixed and `= /admin/_authcheck`. With `trust proxy = 'loopback'` that
appends the real client on the right, so `req.ip` never resolves to `127.0.0.1` for a proxied
request and the register-captcha bypass stays on-box-only. **Treat that line as security-relevant
in every future edit**, as §J2 asked.

**4. Rate-limit zones are correct and globally unique.** Five zones, all created through
`nginx_ensure_rate_limit_zones` into `/etc/nginx/conf.d/script07-${POOL_SERVICE}.conf` — never
inline, per CLAUDE.md. Names are `${POOL_SERVICE}_{auth,api,static,captcha,admin}`, i.e.
`grin-pool-manager_auth` and its testnet `-testnet` sibling; `grep -rn 'zone=' scripts/` shows no
collision with Script 04's `grin_api`/`grin_conn`, Script 02's `grin_req`, or 051/051x's
`grinwallet_*`/`grinxp_*`. Mainnet and testnet pools on one box get separate zones, separate
snippets, separate vhosts and separate conf files.

**5. The Cloudflare real-IP path is safe even when the answer is wrong.** The prompt defaults to
**yes**, so an operator pressing Enter gets the snippet whether or not they use Cloudflare. That
is harmless: `real_ip_header CF-Connecting-IP` only applies to peers matching a
`set_real_ip_from` entry, and the snippet contains nothing but Cloudflare's published ranges,
fetched fresh at write time with the existing file kept as a fallback if the fetch fails
([nginx_shared_helpers.sh:526–558](../../scripts/lib/nginx_shared_helpers.sh#L526)). A direct
connection from a non-Cloudflare address cannot spoof its IP through it.

**6. `ReadWritePaths` does not widen what a compromised backend can reach.** The unit grants
`/etc/wireguard` and `$(dirname "$POOL_CONF")` = `/opt/grin/conf`. Both are still governed by
filesystem permissions inside the namespace: `/etc/wireguard` is `chmod 700 root:root`
(`pool_ensure_wg_prereqs`) so `grinpool` cannot write it directly — only `sudo grin-gateway-ctl`
can, which is the point, and that helper validates every input. `/opt/grin/conf` is `0755
root:root`, so `grinpool` can rewrite the one file it owns (`pool.json`, `0600`) and cannot
create, unlink or modify any other product's config there. `/opt/grin/conf/wg{,-testnet}/`, which
holds the hub WireGuard private key, is `chmod 700 root:root` and not traversable by `grinpool`.

**7. The scoped sudoers is genuinely scoped.** One line, one absolute path, no wildcard, no
arguments: `grinpool ALL=(root) NOPASSWD: /usr/local/bin/grin-gateway-ctl`, written `0440` and
`visudo -c`-validated with the file removed on failure
([:520–528](../../scripts/07_grin_mining_public_pool.sh#L520)). The target is `root:root 0755`,
so `grinpool` cannot rewrite the thing it is allowed to run as root. The helper's own argument
parser accepts exactly `--net`/`--region`/`--pubkey` and rejects anything else outright, validates
all three against enums/regexes, computes `AllowedIPs` internally so `0.0.0.0/0` is
unrepresentable, and re-checks `EUID == 0`. This is the right shape for a privileged helper and
it is worth saying so explicitly, because it is the one place the de-rooting hands power back.

**8. The de-rooted unit's remaining shape is deliberate and documented.** `User=grinpool`,
`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `RestrictSUIDSGID`. `NoNewPrivileges` is
**absent on purpose** (it would break the `sudo grin-gateway-ctl` path) and the unit says so.
`Restart=on-failure` with `RestartSec=5`. No `MemoryMax`/`TasksMax` — worth adding one day, but a
Node process that OOMs is not the risk this pass is about.

**9. `admin_allowlist` shipping open by default — §J16's decision: keep it, and the reason has
changed.** The plan asked me to rule on this. **Keep the open default.** The written rationale
(*"a fresh install is never locked out while there is no adoption yet for anyone to attack"*) is
sound on its own, and the thing that made it dangerous is gone: it was dangerous because it left
the `/api/auth/register` TOCTOU remotely winnable, and **§J2-2 closed that race in code** on
2026-08-26. A network gate is now defence in depth over a login surface that has captcha, per-
`(username,IP)` lockout, optional mandatory 2FA, an auto-ban and a fail2ban jail — not the only
thing standing between an attacker and admin. Two riders, both for §J17's launch notes rather
than for code: the gate covers `/admin/` and `/api/admin/` only, so **`/api/auth/*` stays
globally reachable even when the allowlist is set** — which is correct (the login door must open
for the allowlisted IPs and nginx cannot tell them apart before authentication) but is *not* what
"the panel locks to localhost + those entries only" implies; and per J16-4 the app-side gate an
operator might reach for instead does not persist.

**10. Two `chmod`-adjacent things that are already right.** `pool_fix_web_perms` normalises the
docroot to dirs `755` / files `644` and chowns to `www-data` — the `chown` silently no-ops on
RHEL (where nginx runs as `nginx`), but the modes alone are sufficient there, so the docroot
works on both families. And `pool_write_conf_key` does `chmodSync(…, 0o600)` on every write, so
`pool.json` — which holds `jwt_secret` — is never briefly world-readable.

---

## §J17 — Pre-mainnet operational gate (2026-09-04, add-ons, NOT VPS-TESTED)

### J17-1 — [High] The first-admin registration window is open to the internet, and **both** mitigations the gate plan names for it are inert — one is not wired to the route, the other is contradicted by the installer's own step order — **FIXED 2026-09-04**

**Threat actor: anonymous internet.**

`POST /api/auth/register`
([index.js:1794](../../web/07_mining_pool_public/back-end-pool/index.js#L1794)) creates a
**fully-privileged admin** — and sets its session cookies with `pwa=now`, so the session is even
step-up *fresh* — for whoever asks, whenever `SELECT COUNT(*) FROM users WHERE is_admin=1` is
zero. §J2-2 fixed the concurrency half (two simultaneous registrations both succeeding); it did
not, and did not claim to, close the window itself. The plan's condition 3 is where that was
meant to be handled, by procedure. Neither half of the procedure works:

**(a) `admin_allowlist` does not cover this route.** The generator emits `$admin_rules` into
exactly two locations — `location /admin/`
([:1428](../../scripts/07_grin_mining_public_pool.sh#L1428)) and `location /api/admin/`
([:1470](../../scripts/07_grin_mining_public_pool.sh#L1470)). Registration is `/api/auth/`
([:1502](../../scripts/07_grin_mining_public_pool.sh#L1502)), which carries a `limit_req` zone
and no allowlist at any setting. An operator who follows the plan, sets `admin_allowlist` to
their own IP and believes the panel is locked down has not touched the registration route at all.

**(b) "while the vhost is not yet publicly resolvable" is not a state the installer ever passes
through.** Guided setup step 4 runs `certbot --nginx -d "$subdomain"`
([:1223](../../scripts/07_grin_mining_public_pool.sh#L1223)) — HTTP-01, which **requires** public
DNS and port 80 reachable, and whose issuance publishes the hostname to Certificate Transparency
within seconds. The backend does not exist yet at that point (step 6 starts it), so the exposure
opens at step 6 and closes at step 7. In the guided flow that is short. It is not short when:

- the operator uses the numbered menu instead of `G)`, which is a first-class documented path;
- step 7 fails — the guided flow *continues* on a warning
  (`"Admin account not created — run 7) …"`,
  [:2377](../../scripts/07_grin_mining_public_pool.sh#L2377)) and leaves the service running;
- **the pool.db is ever reset.** `pool_reset_db`
  ([:2256–2293](../../scripts/07_grin_mining_public_pool.sh#L2256)) deletes the database and
  **restarts the service immediately** — on a live, CT-logged, DNS-published pool, now with zero
  admins. Its closing message is *"A fresh schema is created automatically when the service
  starts"*; nothing warns that admin registration just reopened to the internet. An attacker
  polling that one endpoint at the `_auth` zone's rate wins the moment the operator does this.

**The captcha is not the barrier.** It is single-digit `a+b` / `a×b`
([captcha.js:74–79](../../web/07_mining_pool_public/back-end-pool/lib/captcha.js#L74)), and its
own header says it exists *"purely to raise the per-attempt cost of scripted brute force"*
([captcha.js:3–8](../../web/07_mining_pool_public/back-end-pool/lib/captcha.js#L3)) — a
per-attempt cost is irrelevant when one attempt wins permanently.

And the public login page **advertised it**: a permanently-visible *"New admin? Register here"*
link on every pool forever ([login.html:308–310](../../web/07_mining_pool_public/public_html/login.html#L308)),
whether or not an admin exists.

**Fixed** by gating the route on `isLocalRequest(req)` — loopback IP **and** no forwarding
header ([index.js:250–254](../../web/07_mining_pool_public/back-end-pool/index.js#L250)). This
costs the supported path nothing: `pool_setup_admin` already POSTs to `http://127.0.0.1:$port`
([:1922](../../scripts/07_grin_mining_public_pool.sh#L1922)), hitting Express directly with no
nginx and therefore no `X-Forwarded-For`. Registering from elsewhere is an SSH port-forward. The
code comment at `auth.js:113–115` had already named this as the stronger option; it is now taken.
The login page's register link is replaced with a line saying registration runs on the server.

> The register **form** in `login.html` is kept (its ids are referenced by `toggleRegister` /
> `handleRegister` and `loadCaptcha('register')`), but is no longer reachable from the UI. A
> later cleanup can remove all three together; removing the markup alone would break the JS.

---

### J17-2 — [High] The backup/restore drill the gate mandates is itself a double-pay event: a restore rewinds the ledger, and the scheduler starts 170 lines before the check that would freeze it — **FIXED 2026-09-04 (freeze-on-restore)**

**Threat actor: the operator, following the documented procedure.**

Gate condition 4 requires a *"DB **backup and restore** (089)"* drill. Restoring `pool.db`
rewinds the pool's ledger to the snapshot. **The chain and the wallet do not rewind with it.**
Every payout that settled between the snapshot and the restore comes back as an owed balance
that the wallet has already spent:

- a `withdrawals` row that was `confirmed` returns as `retry_scheduled` / `tor_sending` /
  `finalizing` — the scheduler picks it up and re-sends;
- a row that did not exist at snapshot time returns as **nothing at all**, with the miner's
  balance restored. There is no prior row, so §H1's `_priorSendLanded` duplicate check has
  nothing to match against. That is a clean double-pay with no guard in the path whatsoever.

The safety net that should catch this is `coverage_shortfall` → `_maybeFreeze`
([alert-monitor.js:191–201](../../web/07_mining_pool_public/back-end-pool/lib/alert-monitor.js#L191)),
and `payout_auto_freeze` is on by default
([:41](../../web/07_mining_pool_public/back-end-pool/lib/alert-monitor.js#L41)). **It arrives
late.** Startup order in `index.js`:

```
595  withdrawalScheduler.start();   → schedulerLoop() runs processRetryQueue() on its first pass
...
766  alertMonitor.start();          → check() → computeReconciliation() → an await on a wallet RPC
```

`schedulerLoop`'s first iteration reads `isFrozen()` and, finding nothing frozen, goes straight
to the send paths ([withdrawal-scheduler.js:79–99](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L79)).
AlertMonitor is not even constructed until 170 lines later, and its first check is an async
reconciliation against the wallet. The race is real and it is on the wrong side.

`pbk_restore` never mentions any of this. Its framing is disaster recovery *onto a fresh box*
(*"Disaster-recovery order on a FRESH box"*,
[07_lib_pool_backup.sh:196](../../scripts/lib/07_lib_pool_backup.sh#L196)) — where the concern
does not arise — but nothing restricts the menu entry to that case, and its five-step "to finish"
checklist covers node secrets, WireGuard, the wallet listener, nginx and *"Service control →
Start"*, with no step between the restore and the restart that looks at the money.

**Fixed** in `pbk_restore`: after extraction and **before** `pool_deroot` (so the WAL sidecars the
write creates are chowned back with everything else — §J16-8's trap in reverse), the restored
`payout_control` row is set `frozen = 1`, `frozen_by = 'restore'`. `payout_control` is a persisted
table, so the flag rides *inside* the restored DB and survives the restart the checklist asks
for. A new step 5b tells the operator to reconcile before resuming, and the failure branch tells
them explicitly not to start the service. Cost on a fresh-box rebuild from the newest backup:
one click in admin → Payouts.

> **This does not make the restore safe, it makes it inert.** The operator still has to reconcile
> a ledger that is behind the chain. What it removes is the window where the scheduler acts on
> the rewound ledger before a human has looked at it.

---

### J17-3 — [Medium] `wallet_drain` is the only detector in the file with no `resolveAlert`, so the pool's top theft alarm delivers **once for the life of the install** and every later drain is silent — **FIXED 2026-09-04**

**Threat actor: whoever is draining the wallet. Also the operator, who is not told twice.**

Gate condition 6 is *"alert delivery tested … and someone actually receiving them."*

`triggerAlert` returns early when an active row of the same type already exists — incrementing
`occurrence_count` and returning **before** `deliverAlert`
([alert-monitor.js:684–691](../../web/07_mining_pool_public/back-end-pool/lib/alert-monitor.js#L684)).
That is correct anti-spam design, and it depends entirely on something eventually resolving the
row. Every detector in the file pairs its `triggerAlert` with a `resolveAlert` on the healthy
branch — `coverage_shortfall`, `ledger_integrity_drift`, `unrecorded_wallet_send`,
`large_withdrawal`, `payout_surge`, `wallet_identity_changed`, `node_down`, `wallet_offline`,
`wallet_balance_low`, `high_rejection_rate`, `payout_failed`, `block_orphaned`,
`distribution_stalled`. Thirteen of them. `grep -n "resolveAlert('" lib/alert-monitor.js` returns
no `wallet_drain`.

`wallet_drain` is the direct *"the wallet was swiped"* signal — `level: 'critical'`, auto-freezes
payouts ([:244–251](../../web/07_mining_pool_public/back-end-pool/lib/alert-monitor.js#L244)).
Consequence:

1. First unexplained drain → row inserted `active` → delivered to Discord/Slack/Telegram/email.
2. The row stays `active` forever. `acknowledgeAlert` writes `acknowledged_at` and
   `snoozeAlert` writes `snoozed_until`; **neither touches `status`**
   ([:801–835](../../web/07_mining_pool_public/back-end-pool/lib/alert-monitor.js#L801)) — and
   there is no admin route to resolve an alert at all (`/acknowledge` and `/snooze` are the only
   two, [index.js:5617,5631](../../web/07_mining_pool_public/back-end-pool/index.js#L5617)).
3. Every subsequent drain — a second theft, a larger one — bumps a counter and delivers
   **nothing**. The panel keeps showing the *first* drain's message and amount.

The auto-freeze still fires each time, so the money protection is intact; it is the notification
that is muted, on the one alarm where being told twice matters most. A single false positive
during a legitimate manual sweep is enough to arm this permanently.

**Fixed** — an `else` branch calling `resolveAlert('wallet_drain')` when the unexplained delta is
under threshold, matching all thirteen siblings.

**Not re-reported here:** §J8-3 (the panel's whole `alerts` settings section is inert — the nine
keys, three of them credentials, are stored in the DB and read by nothing) remains **open** and is
the *other* reason condition 6 fails. Delivery reads `config`
([alert-delivery.js:14–21](../../web/07_mining_pool_public/back-end-pool/lib/alert-delivery.js#L14)),
i.e. hand-edited `pool.json`. That path does work — `mergeEnvVars` spreads the raw config
([config.js:38–42](../../web/07_mining_pool_public/back-end-pool/lib/config.js#L38)), so an
operator-added `discord_webhook_url` reaches `alertDelivery` — and `/api/admin/alerts/test`'s
refusal names the file. So condition 6 is *achievable*, but only by editing JSON on the box, and
only if the operator ignores the settings page built for it.

---

### J17-4 — [Medium] One ed25519 key has **two** accepted spellings — `grin1…` and `tgrin1…` — so the same miner is two accounts with two balances, and a mainnet pool will credit and try to pay a testnet-labelled address — **FIXED 2026-09-04 (see the §J17 resolution pass)**

**Threat actor: no attacker required. This is the testnet → mainnet transition the gate's own
condition 5 prescribes.**

§J3's headline was *"there is exactly one spelling, and it holds at every call site."* That claim
is correct for what it examined — uppercase bech32, percent-encoding, trailing whitespace, and
SQLite's BINARY collation on `miner_accounts.grin_address`. It did not consider the **HRP**. A
Grin Slatepack address is `bech32(hrp, ed25519_pubkey)`; the same 32-byte key encodes to two
different, fully-valid, lowercase, checksum-correct strings depending on whether the prefix is
`grin` or `tgrin`, and `validateUsername` accepts both with **no network parameter**:

```js
const re = new RegExp(`^(grin1|tgrin1)(${bech32}{58})(\\.([a-z0-9_-]{1,${MAX_WORKER_RAW_LEN}}))?$`);
```
([stratum-protocol.js:112–121](../../web/07_mining_pool_public/back-end-pool/lib/stratum-protocol.js#L112))

Demonstrated against the pool's own module (one-shot harness, output verbatim):

```
key (hex)       : a16b5a4a2aba4c0c5ee2591755b528eb4deb4cab5deb515c7c2a320ff8f8409d
mainnet spelling: grin159445j32hfxqchhztyt4tdfgadx7kn9tth44zhru9geql78cgzws20lczj
testnet spelling: tgrin159445j32hfxqchhztyt4tdfgadx7kn9tth44zhru9geql78cgzws46jh9l

validateUsername(grin1…)      -> grin159445j32hfxqchhztyt4tdfgadx7kn9tth44zhru9geql78cgzws20lczj
validateUsername(tgrin1…)     -> tgrin159445j32hfxqchhztyt4tdfgadx7kn9tth44zhru9geql78cgzws46jh9l
both accepted                 : true
same 5-bit body               : true
distinct account keys         : true
checksums independently valid : true true
validateUsername arity        : 1        ← takes no network
```

Both strings are checksum-valid because bech32's checksum is computed **over the HRP** — the two
are not each other's typo, they are two correct encodings. §J6-6 added checksum verification and
closed the charset hole; it did not make the check network-aware, and could not have, because the
function is never given the network.

**Nothing else in the pool closes it either.** The one network-aware validator that exists —
`validateGrinAddress(address, network)`
([wallet.js:147–154](../../web/07_mining_pool_public/back-end-pool/lib/wallet.js#L147)) — is
**dead code**: `grep -rn "validateGrinAddress" --include=*.js .` returns its definition and
nothing else. The gate actually used on the payout path is
`isPayoutAddress` ([wallet-tor.js:206–208](../../web/07_mining_pool_public/back-end-pool/lib/wallet-tor.js#L206)),
`/^(grin1|tgrin1)[ac-hj-np-z02-9]{58}$/i` — both HRPs, and case-insensitive. `config.network` is
never consulted anywhere on the address path, and `validateConfig`
([config.js](../../web/07_mining_pool_public/back-end-pool/lib/config.js)) makes no
network-consistency check of any kind between the pool, the node and the wallet.

**Consequences, in order of likelihood:**

1. **Split identity.** One miner, two `miner_accounts` rows, two balances, two independent
   ownership proofs, two donation settings. Each balance is measured against `min_withdrawal`
   (default 25 GRIN) separately, so a miner who changes the HRP mid-round strands the first
   balance below threshold with no way to merge it. Nothing in the product can even show them
   the two are the same key.
2. **A mainnet pool crediting a testnet-labelled address.** This is condition 5's exact
   sequence — testnet soak, then mainnet, with the operator's own rig config carried over. Real
   GRIN accrues to `tgrin1…`, and the payout is then handed straight to `grin-wallet send -d`
   ([wallet-tor.js:105–114](../../web/07_mining_pool_public/back-end-pool/lib/wallet-tor.js#L105)),
   which *is* chain-aware and refuses it. The result is a failed payout and a balance the miner
   cannot move — and per §J15-7 the pending strip has only just learned how to say "stuck".

**Not fixed here.** The fix is one parameter — pass `config.network` into `validateUsername` and
reject the foreign HRP at stratum login — but it sits on the share-intake path §J6 owns, it
changes who can log in to an already-deployed pool, and it needs a decision about existing rows
carrying the wrong prefix. It is small; it is not local. **§J6 owns it, and it must be closed
before the testnet→mainnet switch, not after.**

---

### J17-6 — [Low] Gate condition 2 is `npm test` green, and **nothing runs `npm test`** — no CI, no hook, and the deploy step does not; one suite of 48 assertions covering §J2's P0 fixes was wired to nothing at all — **FIXED 2026-09-04 (the orphan suite)**

**Threat actor: none — this is the gate's own instrumentation.**

The suite is real and it is good: **445 reported assertions across 12 suites**, encoding most of §J1–§J16's
fixes as executable regressions. Run this session, twice, green both times.

Nothing causes it to run:

- **No CI.** `.github/` contains exactly one file, `ISSUE_TEMPLATE/ecosystem-submission.yml`.
  There is no workflow.
- **No git hook.** `.git/hooks` holds only the `.sample` files.
- **The deploy step does not.** `pool_deploy_code` rsyncs the backend and then runs `npm ci`
  **only when `package.json`/`package-lock.json` changed**
  ([:959–962](../../scripts/07_grin_mining_public_pool.sh#L959)); `npm test` appears nowhere in
  the shell. A deploy from a dirty working tree ships whatever is in it.
- **And one suite was not even in the chain.** `scripts/test-auth-hardening.js` — 48 assertions
  covering §J2-1 (step-up brute force + second factor), §J2-2 (the atomic first-admin gate),
  §J2-3, §J2-4 (captcha store eviction), §J2-5 (TOTP replay) — was referenced by **nothing**:
  not `test:unit`, not the shell, not any doc. `grep -rn "test-auth-hardening"` over the repo
  returned exactly one hit: a `Run:` line in its own header comment. It passes 48/48 when run by
  hand, which is how it was found. The §J2 fixes are all P0 and their only regression net was
  detached.

**Fixed** — `test-auth-hardening.js` added to `test:unit`, after `test-admin-guards.js`. The
suite is now 445 reported assertions and `npm test` exits 0.

**Not fixed:** nothing still runs it automatically. That is a repo-level decision (a CI workflow,
or `npm test` as a gate inside `pool_deploy_code` — the latter is attractive because it would
refuse to deploy a broken tree, and unattractive because it puts a test run on the operator's
production box). Recorded for the operator; see the runbook below.

---

