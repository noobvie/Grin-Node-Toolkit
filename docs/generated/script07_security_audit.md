# Script 07 — Public Mining Pool (Security Audit)

Security model, verified upload/XSS fixes, and the hardening requirements for
`web/07_mining_pool_public/`. Design: [`script07_design.md`](script07_design.md);
deploy/runbook: [`script07_implementation.md`](script07_implementation.md).

> Two kinds of items below: **(A) Verified fixes** — found and fixed in the toolkit's actual
> code (white-label upload work, 2026-06). **(B) Hardening requirements** — the standing
> security model the pool must satisfy (distilled from the Grinium design review + production-pool
> validation against `grin-pool` / `open-grin-pool`). Treat (B) as the audit checklist; verify each
> against current code before mainnet.

---

## Trust model

- **Miners never authenticate.** Address-as-identity; all miner-facing endpoints are public, keyed
  by Grin address. Safety comes from funds always going to the miner's own address (Tor, address-bound
  listener) or being payment-proof-bound (Slatepack) — **not** from access control on the endpoints.
- **Admins authenticate.** Admin-only JWT sessions; admin registration is a CLI action, never an
  exposed endpoint.

---

## A. Asset-upload hardening (verified fixed)

The upload endpoint (`POST /api/admin/assets/upload`) is admin-only (`secureAdmin` = IP allowlist +
admin JWT + rate limit), capped at 2 MB / 1 file. Upload-specific weaknesses found and fixed:

| # | Finding | Risk | Fix |
|---|---------|------|-----|
| 1 | Served `Content-Type` came from the **uploader's filename extension**; the MIME check trusted the spoofable declared type. `evil.html` declared `image/png` → served as `text/html` → **stored XSS in the pool origin**. | High (admin-gated) | Filenames are now **server-controlled**: `${type}_${ts}_${rand}.${ext}` where `ext` comes from the *detected* content type. Original name never used on disk. |
| 2 | `req.query.type` concatenated into the filename **unsanitised**, and `multer` wrote to disk *before* `saveAsset` validated → **arbitrary file write** via `../`. | Medium | `multer.memoryStorage()` — nothing written until validation passes. `type` sanitised (`[^a-z0-9_]` stripped); resolved path asserted inside the upload dir. |
| 3 | No content validation — only the spoofable declared MIME was checked. | Medium | `detectImage()` sniffs **magic bytes** (PNG/JPEG/GIF; SVG must parse as `<svg>` in the head). Non-images rejected 400; the detected MIME is stored. |
| 4 | `/custom/` static location had no isolating headers → a served SVG/HTML could execute on direct navigation. | Medium | vhost `location /custom/` now sets `X-Content-Type-Options: nosniff` + `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`. Image MIME types preserved so logos/icons render. |

**Delete path** (`deleteAsset`) only unlinks the stored basename within the upload dir and requires a
matching DB row first — no traversal.

**SVG decision:** `image/svg+xml` remains allowed (logos are commonly SVG), defended by (a)
magic/structure validation at upload and (b) `nosniff` + sandbox CSP at serve time. `<img src>` never
executes SVG scripts; the headers cover direct navigation.

**Public endpoints (reviewed, no change needed):** `/api/public/branding`, `/public/page/:key`,
`/robots.txt`, `/sitemap.xml`, `/manifest.json` are unauthenticated, rate-limited (`public` tier), and
expose only curated operator-set fields from `buildPublicConfig()` — no balances, secrets, IPs, or
alert thresholds. `:key` is validated against the fixed `pages` allowlist; `page.html` strips `?p=` to
`[a-z0-9_-]`.

---

## B. Hardening requirements (audit checklist)

> **Implemented 2026-06-08 (verified in code):**
> - **`trust proxy` + `req.ip`** — `index.js` sets `app.set('trust proxy', 'loopback')`; the
>   spoofable raw-`x-forwarded-for` reads in `rate-limiter.js`/`ip-filter.js` `getClientIp()` now
>   use `req.ip`. This also makes the satellite ingestion allowlist (`requireSatellite`) compare the
>   real satellite IP instead of nginx's loopback.
> - **bcrypt ≥ 12** — `auth.js` `bcryptRounds` default 12 (was 10).
> - **Account lockout** — `users.failed_login_attempts` + `locked_until`; `login()` locks for 15 min
>   after 5 failures and clears on success (additive `migrateUsers()` for existing DBs).
> - **Refresh-token revocation** — `users.token_version`; refresh **rotates** (bumps the version so the
>   presented refresh token can't be replayed), and logout/password-change call `revokeUserTokens()`.
> - **`jwt_secret` fail-loud** — `config.js` no longer auto-generates at boot; `validateConfig()` throws
>   if it is missing/&lt;32 chars. **Role-gated:** the check is skipped for `role: satellite` (satellites
>   have no web/admin/auth and carry no jwt_secret), so satellite boot is unaffected. Installer still
>   writes it once for hub/singlebox (`07_grin_mining_public_pool.sh`).
> - **escHtml on public sinks** — `miners-stats.html` (grin_address) and `payment-history.html`
>   (tx_hash/status) now escape; `fortune-board.html` already escaped. Defense-in-depth atop the
>   stratum-layer bech32 address regex (`stratum-protocol.js`).
>
> **Still open (needs a product decision before mainnet):** the public **system-health** page renders
> **hardcoded/fake** CPU/Mem/Disk/Network/uptime metrics (and `miners-stats` "98%" uptime). Per
> "no fake metrics," either compute them server-side or omit the cards — recommend **omit** (real
> server resource usage is itself a mild info-leak on a public page).

### Authentication
- **bcrypt rounds ≥ 12.**
- **JWT in an httpOnly cookie** (`pool_token`), not localStorage (avoids XSS token theft); a separate
  non-secret cookie may carry `{username, is_admin}` for display only.
- **Access token short-lived (≤ 1h); refresh tokens revocable** — track `jti`, revoke the old one on
  refresh, or a stolen refresh token is valid for its full lifetime.
- **Account lockout** per-username (`failed_login_attempts` + `locked_until`) — per-IP limiting alone
  is bypassed by IP rotation.
- **Frontend auth gate must `await`** the async check and gate against an **authenticated** endpoint
  (`/api/admin/dashboard` → 401), never the public `/api/health`.
- **`jwt_secret` written at install**, never auto-regenerated at boot (invalidates all sessions).
- **Admin re-auth on sensitive ops:** withdrawal retry/cancel require `requireFreshAuth(300)` —
  JWT age < 5 min allow; else `403 { challenge_required }` → `POST /api/auth/reauth` → fresh token.

### Network layer
- **`app.set('trust proxy', 1)` + use `req.ip` everywhere.** Reading raw `X-Forwarded-For` lets a
  client spoof an allowlisted IP and bypass the rate-limiter/allowlist.
- **Rate limiting:** nginx zones via the shared helper (`pool_api` ~30 r/m public; a per-IP/per-addr
  tor-check probe limit), never inline `limit_req_zone`. Helmet for headers (defense-in-depth; CSP
  owned by nginx).

### XSS / frontend
- **Escape every interpolated value** — centralize `escHtml()` and use it on all `innerHTML`
  interpolation sinks (worker names, status reasons, settings), or build DOM via
  `createElement` + `textContent`.
- **Worker-name validation at the stratum layer** (`^grin1[a-z0-9]+(\.[a-z0-9]+)?$`) stops malicious
  names (e.g. `grin1<script>`) reaching the DB at all.
- **CSP `'unsafe-inline'` for scripts** is currently required by inline page bootstraps + analytics
  init; this weakens the XSS barrier. A nonce-based CSP is stronger but impractical with nginx-served
  static pages + client-side injection. Move inline handlers to `addEventListener` to enable dropping
  it later.

### Public data-leak prevention
- `GET /api/pool/payments` and `/api/pool/miners` must return **aggregates / anonymized** rows
  (truncated addresses, totals), not raw full-address + balance/amount rows.
- **No fake/hardcoded metrics** in any public or dashboard response — compute or omit.
- Per-address pages are public by design but show only that address's own data, by exact address.

### Audit logging
- **One column shape** for `admin_audit_log`: `(admin_id, action, target_type, target_id,
  before_state JSON, after_state JSON, ip, created_at)` — mismatched writers silently fail every
  INSERT → empty log.
- **No admin mutation succeeds without an audit row** (enforced at the handler); CSV export available.

### Consensus / money (validated against production pools)
- **`confirm_depth = 1440` mainnet** (= `COINBASE_MATURITY`, not 10) — prevents reorg payouts (loss of pool capital).
- **No Tor port-probing before send** — probing leaks Tor circuit identity; best-effort send instead.
- **Orphan detection by nonce** validated against the chain after payout, with **exact-amount,
  PPLNS-weighted reversal** (incl. pool fee, never below 0) — prevents orphan steals.
- **Wallet send idempotent** — cache `withdrawals.txid`; never two txids for one withdrawal.
- **Withdrawal balance lock is compare-and-swap**; max 1 pending per address (429); full reversal on
  fail/cancel (miner pays no fee on a failed payout).

---

## Residual / accepted risks

### Hot wallet with password on disk — forced by Grin's receive path, not a shortcut

The pool wallet password is stored in plaintext at `/opt/grin/pubpool/<net>/.wallet_pass`
(root-owned, `chmod 600`; written by `07_lib_pool_wallet.sh`) so the boot script and watchdog
can auto-unlock the wallet (Owner API v3: `init_secure_api` ECDH → `open_wallet`). Operators
regularly ask why the password must live on the server at all. The answer:

1. **In Grin, *receiving* is a signing operation.** There are no addresses: the node's stratum
   calls the wallet's `build_coinbase` for **every block template it builds** (re-versioned
   ~every 15 s, not just when a block is found), and that call derives a key, builds the output
   commitment + rangeproof, and signs the kernel — all requiring the decrypted seed in memory.
   A BTC pool can receive to a cold address with zero hot keys; a Grin pool cannot. There is no
   watch-only option for the coinbase side.
2. **A locked wallet halts the pool, it doesn't just miss rewards.** If `build_coinbase` fails,
   the node cannot construct block templates → stratum has no jobs → every miner idles
   (observed symptom: miners "Alive" but GetWorks = 0). So the wallet must re-unlock unattended
   after any reboot/crash — which requires the secret to be on the box. Postponing *payouts* is
   policy, but it doesn't remove the hot keychain: grin-wallet has no scoped tokens, so the same
   `open_wallet` token that builds coinbases can also `send`.
3. **This matches the wider ecosystem.** grin-pool (MWGrinPool) and open-grin-pool both keep the
   wallet password in service config; `grin-wallet listen -p <pass>` (solo mode) exposes it in
   the process list, which is *weaker* than a 600 file read once at unlock. Encrypting
   `.wallet_pass` would only relocate the problem (key-to-decrypt-the-key on the same box); an
   attacker with root gets the encrypted seed file alongside it anyway.

**Actual mitigations** (the security boundary is the box, not the file): wallet exists only on
the hub — never on gateways/edges; ECDH keeps the password/token off the wire and port 3420
unusable to a non-root local process; keep the hot balance ≈ the pending-payout float and sweep
accumulated coinbase to cold storage on a schedule.

### Other accepted risks

- **Admin-authored HTML is stored, site-wide XSS by design.** `custom_css`, `custom_head_html`,
  `custom_body_html`, content-page HTML, banner/maintenance messages are injected verbatim into every
  visitor's browser — inherent to "inject custom HTML" white-label features. Mitigation is the admin
  auth stack (bcrypt + JWT + IP allowlist + rate limit + httpOnly cookies): an attacker must already
  control the admin account. An operator who wants the vector gone could expose a switch to disable the
  raw-HTML fields (not implemented).
- **Public-page CSP includes `'unsafe-inline'` for scripts** (see above), which compounds the point
  above.
- **Host-header reflection** in `robots.txt`/`sitemap.xml` (`siteOrigin()` falls back to
  `req.get('host')` when `site_url` is unset). Low severity; set `site_url` to pin it.
- **Slatepack is not inherently address-bound** — mitigated by the one-time claim token + mandatory
  payment proof (design §8). Without payment proof, a leaked slate could be completed by an attacker.

---

## Security pre-launch gate

`[x]` = implemented in code 2026-06-08 (syntax-checked + logic-reviewed; runtime-verify on testnet).
`[~]` = partially done — see note. `[ ]` = still owed.

- [x] bcrypt ≥ 12; refresh revocation; account lockout
- [~] httpOnly cookie auth **done**; frontend gate awaits an authenticated endpoint — *verify*
- [x] `trust proxy` + `req.ip`; no `X-Forwarded-For` trust; `jwt_secret` written at install (+ fail-loud at boot)
- [x] `escHtml` on the public miner/payment sinks (+ `fortune-board`); worker-name/address bech32 regex enforced at stratum layer
- [x] SVG validated; uploaded-asset static route + MIME sniff + isolating headers (§A)
- [~] public payments/miners aggregated or gated — *verify*; **fake metrics still present on public system-health page (open item D1)**
- [~] `admin_audit_log` single shape **done** (`migrateAdminAuditLog`); "every admin action audited" — *not line-audited per handler*
- [x] confirm_depth 1440 set; [ ] no Tor probe / nonce orphan check + exact reversal / idempotent sends — *verify money logic against live DB*
- [ ] HTTPS enforced; secrets only in `pool.json`, never in code

---

## C. Re-audit 2026-07-10 (fresh pass — auth + money path verified against current code)

Verified the auth stack and the fund-moving path line-by-line. **Auth is solid** — TOTP login
returns *no* session cookie until the second factor passes ([index.js:939-941](../../web/07_mining_pool_public/back-end-pool/index.js#L939-L941));
money/destructive routes use `freshAdmin` (password step-up via `pwa`); refresh tokens rotate on
`token_version`; account lockout + timing-equalized login (`_dummyHash`). **Withdrawal money
logic is solid** — CAS balance lock (`WHERE balance >= ?`), one-pending-per-address, exact
reversal on fail/expiry, slate-id binding on slatepack finalize. **Incentives** never overdraw
(`debitPrizePool` floor-checks) and the join bonus is Sybil-gated on first real payout.

New / still-open findings:

### C1 — [Medium] `/api/pool/miners` and `/api/pool/payments` leak full raw data, unauthenticated *and* un-rate-limited
- **Evidence:** [index.js:1767-1779](../../web/07_mining_pool_public/back-end-pool/index.js#L1767-L1779)
  returns `grin_address, balance, is_online` for the top-500 addresses by balance (full addresses
  + exact live balances). [index.js:1781-1793](../../web/07_mining_pool_public/back-end-pool/index.js#L1781-L1793)
  runs `SELECT * FROM withdrawals … LIMIT 500` — full payout history with complete addresses,
  amounts, timestamps, and every current/future column. **Neither has `rateLimiter.middleware('public')`**
  (most other public routes do), so both are freely scrapeable.
- **Impact:** On a privacy coin this is the worst public-leak class — anyone can enumerate every
  miner's payout address, exact balance, and full payment cadence, and correlate the two lists.
  This is the audit's long-standing open item ("public payments/miners aggregated or gated —
  *verify*"); **it is still unaddressed in the current code.**
- **Fix:** Return aggregates/anonymized rows only — truncated addresses (`grin1abc…wxyz`), bucketed
  or omitted balances, totals/counts. Replace `SELECT *` with an explicit safe column list. Add the
  `public` rate-limiter. (Per-address pages already correctly show only that exact address's data.)

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

### C3 — [Low] Access token survives logout & password-change until it expires (≤1h)
- **Evidence:** `revokeUserTokens()` only bumps `token_version` (invalidates *refresh* tokens);
  `verifyAccessToken()` never re-checks `tv` against the DB ([auth.js:206-218](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L206-L218),
  [280-290](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L280-L290)). So a stolen/live
  access token keeps working for up to 1h after the victim logs out or changes their password.
- **Impact:** Standard stateless-JWT tradeoff; low, given the 1h TTL and httpOnly+sameSite cookies.
  Worth closing for the admin surface: either check `tv` (one indexed lookup) on `secureAdmin`/
  `freshAdmin`, or shorten the admin access TTL.

### C4 — [Info] Confirmations of accepted/known items
- **IP-proof gate** ([owner-proof.js](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js)):
  the "proof" is a *client-submitted* low-entropy IP string, throttled 8/10 min. Fine as an
  anti-griefing gate — the slatepack payout's real protection is age-encryption to the owner
  address (a non-owner who passes the gate gets an undecryptable blob). No change needed; documented.
- **Fake metrics** on the public system-health surface + per-handler audit-log coverage remain the
  open items from §B (D1). `/api/admin/health/system` fake metrics are admin-only (lower severity
  than a public page). `/api/admin/miners/:addr/inject` credits balance under `secureAdmin` (not
  `freshAdmin`) — if it can move funds, consider promoting it to `freshAdmin`.

**Not re-examined this pass (flagged for a future deep dive):** stratum share-validation/PPLNS
accounting internals, the lottery draw RNG/verifiable-seed, and orphan-reversal against a live DB
— the existing §B checklist covers their requirements but they were not line-verified here.

## D. Re-audit 2026-07-17 (P3 pass — HTTP API + admin auth, ownership gate, SQL, rate limits, XSS)

Scope: `index.js` routes, `lib/miners.js`, `lib/pool-settings.js`, admin-panel pages, and the
front-end pages that echo miner-supplied data. Verified + corrected in the same pass.

### Verified clean (no change needed)
- **Ownership gate is single-sourced:** every mutating account API goes through
  `verifyIpProof()` in [owner-proof.js](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js)
  (min-payout, slatepack withdraw, slatepack finalize). The ungated paths are the documented
  no-theft-vector ones (Tor withdraw = pay-to-self; cancel = own-funds unlock). No bypass found.
- **Admin coverage:** `/api/admin/reconciliation`, payout `control` (GET) and `wallet-audit`
  are `secureAdmin` (rate limit + IP filter + JWT); `freeze`/`resume`, `adopt-identity`,
  withdrawal retry/cancel, ban/unban, award, campaigns are `freshAdmin` (step-up). 2FA is
  enforced at session issuance (`/api/auth/login` returns `totp_required` and only
  `/api/auth/login/totp` mints cookies), so every admin route inherits it.
  `/api/admin/_authcheck` deliberately bypasses the limiter/IP filter (documented nginx
  `auth_request` shim; JWT-only, 204, no data).
- **SQL:** all statements parameterized. The only dynamic fragments are whitelisted:
  `LEDGER_DIRECTION_SQL` (fixed map), CMS `_clean()`-built SET clauses (fixed key set),
  retention table names (internal constants).
- **XSS:** miner identity charset is locked at the stratum boundary
  (`validateUsername`: bech32 address regex + `[a-z0-9_-]` worker names, donate tag → int),
  and the public/admin pages that render addresses/worker names/reasons all escape
  (`escHtml`/`esc`). Uploaded SVGs are served with a sandboxing CSP.

### Corrected this pass
1. **Rate limiting gaps closed** — 12 public GETs had no limiter (`/api/pool/stats|blocks|
   miners|payments|top-block-finders`, `/api/account/:addr/shares|balance`, `/api/stratum/
   hashrate|top-miners|top-avg-hashrate`, `/api/miners/top`, `/api/config/pool-info`) → all now
   `rateLimiter.middleware('public')`; `/api/auth/refresh|logout|change-password` → `'auth'`
   (change-password verifies old_password, so unthrottled = session-holder brute force).
2. **Ownership-gate evidence hardened** — source IP was recorded at stratum **login**
   (unauthenticated: the address is the username), so a bare TCP connect under a victim's
   address could poison/evict its last-2-IP window. Now recorded once per session on the
   **first node-accepted share** (stratum-server `handleSubmit`) — IP evidence requires PoW.
3. **Gateway pairing step-up** — POST `/api/admin/locations` with `wg_pubkey` (pairs a
   WireGuard gateway peer that may forward PROXY-v2 source IPs into the ownership gate) now
   requires fresh auth like peer *removal* already did (inline `isTokenFresh` +
   `challenge_required`; regions.html save switched to `adminFetch` for the reauth flow).
   Metadata-only region saves stay plain `secureAdmin`.
4. **pool-settings `updateSection` stored the raw input, not the validator's output** —
   normalisations (trimmed `donation_address`, deduped `enabled_themes`, cleaned
   `lottery_special_events`) were silently dropped, and an array input whose validator
   returned a JSON string fell through to the binder as a raw array. Now persists `validated`.

### Still open (carried from §C)
C1/C2 (Tor-withdraw trigger/cancel griefing), C3 (access-token survives logout ≤1h),
C4 inject-under-`secureAdmin` promotion — unchanged this pass.
*(Update: C2 and the cancel-griefing half of this item were closed later the same day — §E.)*

## E. Ownership gate v2 — 2026-07-17 (add-ons, NOT VPS-tested)

Operator-decided redesign of the account-page gate ([owner-proof.js](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js) rewritten):

1. **C2 closed — every money action is now gated.** `POST /api/account/:addr/withdraw`
   (BOTH rails), `…/withdraw/:id/finalize`, and `…/withdraw/:id/cancel` all require an
   ownership proof. The balance-lock griefing / forced-payout / fee-burn vectors on the Tor
   rail and the nuisance-cancel vector are gone. Failures are audited per action
   (`owner_proof:withdraw_tor|withdraw_slatepack|slatepack_finalize|withdraw_cancel:deny`).
2. **Proof = recent mining IP (IPv4 or IPv6) OR the rig's stratum password.** Both captured
   at the stratum layer on a session's **first accepted share** (PoW-backed, same
   anti-poisoning rationale as D.2), each in a last-2 distinct window (ISP re-lease /
   rig-side password change never locks the owner out). Trivial passwords (`x`, `123`,
   factory defaults, `d=…` directives, <4 chars) are never captured and never verify —
   a shared default must not become a skeleton key.
3. **Proofs hashed at rest (data minimisation).** Salted scrypt (`N=16384, r=8, p=1`,
   memory-hard vs GPU brute-force of the 2^32 IPv4 space / low-entropy passwords), format
   `v1$salt$hash` in `miner_accounts.last_ip/prev_ip/last_pass_hash/prev_pass_hash`.
   The DB never holds a raw mining IP or password; legacy plaintext IPs are upgraded in a
   background startup migration (`migrateOwnerProofHashes`), with dual-form verify meanwhile.
   Trade-off accepted: no raw-IP forensics from the accounts table (the audit log still
   records HTTP request IPs).
4. **IPv6 canonicalisation** (`canonicalizeIp`): brackets/zone-id stripped, `::ffff:` mapped
   prefix removed, `::` expanded, embedded IPv4 tails folded — one stable form so socket-
   captured and user-typed representations always compare equal.
5. **Per-account `min_payout` endpoint removed** (auto-payout relic; manual withdrawals carry
   an explicit amount). Only the pool-wide `config.min_withdrawal` floor is enforced, in the
   scheduler. Attack surface: one fewer gated mutation endpoint.

Residual risk (unchanged in kind): the gate remains anti-griefing, not authentication — a
NAT/CGNAT co-tenant sharing the miner's public IP can still pass it; both rails stay
independently theft-proof (pay-to-self over Tor; slatepack age-encrypted to the address).

### E.1 Follow-up hardening — 2026-07-17 later same day (add-ons, NOT VPS-tested)

- **Public cancel removed entirely** (supersedes the gated cancel in point 1 above): both parked
  states self-recover (Tor auto-reversal after max retries; slatepack TTL refund), and in
  Grin a send that appears failed may still have posted — a late cancel reversing the lock
  is a **double-pay** vector even when ownership-gated (the legitimate owner could abuse it
  deliberately). Admin cancel stays (step-up gated). OPEN follow-up: the automatic
  retry/reversal paths carry the same theoretical double-pay exposure; fix = record slate_id
  on Tor sends and check wallet tx state (`retrieve_txs`) before any retry or reversal.
- **Operator-extendable password blocklist, additions-only**: `access.extra_banned_passwords`
  (pool_config) merges on top of the hardcoded seed in owner-proof.js with a 60 s cache;
  the seed + structural rules are not admin-removable, so a bad edit can weaken nothing.
  Fail-open to seed-only on missing/corrupt row. Verify re-checks the submitted value, so a
  new entry disables that password as proof immediately, even for accounts that captured it.
- **Freeze visibility**: account summary exposes `payouts_frozen` as a **boolean only** —
  the freeze reason (wallet_drain / integrity_drift …) stays admin-side, since it would tell
  an attacker exactly which incident the pool is fighting.

### E.2 Cross-rail pending gate + failed-payout cooldown — 2026-07-17 round 3 (add-ons, NOT VPS-tested)

- **FIXED: one-directional pending hole.** `createWithdrawal` (Tor) counted only the three
  Tor statuses, so a miner with a pending **slatepack** could open a **Tor** payout in
  parallel — two concurrent locks, violating design §8's one-pending-per-address rule (the
  slatepack path already counted all four statuses; the hole was Tor-side only). Both create
  paths now share one module-level `PENDING_SQL`
  (`tor_checking, tor_sending, retry_scheduled, slatepack_pending`); any future rail that
  parks in these states (e.g. the designed Nostr rail) is inside the gate by construction.
  Admin miner-detail view (`GET /api/admin/miners/:addr`) had the same 3-status list in its
  pending display — also fixed.
- **NEW: cross-rail cooldown after a reversed payout** (operator decision, default 30 min,
  `payout.withdrawal_cooldown_minutes`, 0 disables, cap 1440). `_assertNoRecentReversal()`
  checks the address's latest `balance_log` row with `event_type='reversal'` +
  `reference_type='withdrawal'` (written by Tor `markFailed`, slatepack expiry/creation
  failure `_reverseLock`, and admin cancel) and 429s both create paths while inside the
  window, before any lock is taken. Purpose: (1) safety margin over the OPEN
  slate_id/`retrieve_txs` double-pay window in E.1 — a "failed" Tor send that actually posted
  gets 30 min to surface before the miner can pull the same funds through another rail;
  (2) kills rapid-fire rail-hopping after failures. Orphan/jackpot clawback reversals use
  `reference_type≠'withdrawal'` and do NOT trigger the cooldown.

### E.3 Goblin/Nostr payout rail — threat model (BUILT 2026-07-18, add-ons, NOT VPS-tested)

This rail is categorically different from Tor/slatepack: those can only pay the mining
address's **own** wallet (Tor dials its onion; the slatepack is age-encrypted to it), so the
ownership gate is merely anti-griefing — a passed gate cannot redirect funds. The Nostr rail
pays a **username → npub → whoever controls that key**. So the gate alone must NOT be able to
authorize an arbitrary-destination payout. Layered defenses (all implemented):

1. **Registered destination, not a request parameter.** A payout never takes a username from
   the withdraw body. The destination is stored once via `POST /api/account/:addr/nostr-destination`
   (ownership-gated + rate-limited) and the send route reads only the stored, pinned npub.
2. **≥48 h destination cooldown** (`nostr_destination_cooldown_hours`). A freshly registered
   destination can't receive a payout until it ages out. Registration is visible on the miner's
   own account page, so the real owner — who watches their stats — has the whole window to spot
   a hijack, re-register (which resets the clock and evicts the attacker's entry) and rotate
   the rig password. Re-registration always resets the clock.
3. **TOFU npub re-pin at send time.** The route re-resolves the stored username via NIP-05 and
   refuses the payout (409) if the npub differs from the one pinned at registration — a
   goblin.st account takeover cannot silently redirect a standing destination.
4. **NIP-05 domain allowlist** (`nostr_nip05_domains`, default `["goblin.st"]`) — the resolver
   only fetches `/.well-known/nostr.json` from allowlisted hostnames, and rejects IP-literals /
   paths / ports. This is the SSRF + look-alike-domain guard: the pool's resolver can't be
   pointed at an internal host or a typo-squat domain.
5. **Response (S2) binding, defense in depth.** The bridge routes an incoming gift-wrapped S2
   to a pending row only when the seal-verified sender pubkey equals the registered `nostr_npub`;
   the scheduler then re-checks that equality AND binds `slate.id` to the issued slate before
   finalizing. A forged/mismatched S2 is dropped without any on-chain action. Incoming events
   are size-capped (wrap/rumor/slatepack) and deduped (`nostr_seen_events`) before any parsing.
6. **Inherits every existing money guard.** `method='nostr'` rows park in `slatepack_pending`,
   so they are inside `PENDING_SQL` (one-pending-per-address across all rails), the freeze
   kill-switch (`_assertNotFrozen` on create + finalize), the failed-payout cooldown
   (`_assertNoRecentReversal`), the min-withdrawal floor, and the TTL expiry refund — no
   parallel accounting path. Any wallet/relay send failure reverses the balance lock.
7. **Transport key ≠ money key.** The pool's Nostr identity (`.nostr_payout_key`) can only
   sign Nostr events, never a Grin slate; a leak exposes payout *metadata* (timing/counts on
   public relays — an accepted trade-off, same as goblin itself), not funds.

Residual / to validate on the VPS: the live nostr-tools crypto (nip59 wrap/unwrap) and relay
delivery are exercised only by an E2E run — do a testnet / tiny-amount pilot before enabling on
mainnet. The E.1 slate_id/`retrieve_txs` double-pay hardening applies here too (the failed-send
reversal shares the exposure); the failed-payout cooldown is the current mitigation.

## F. Payout-path throttle hardening — 2026-07-22 (add-ons, NOT VPS-tested)

**Question raised:** should the payout button get a CAPTCHA / Cloudflare Turnstile to blunt
proof brute-force + payout spam?

**Decision: NO CAPTCHA (by default).** Rationale — do not re-litigate in a future pass:
- Both payout rails are **theft-proof** (Tor dials the address's own onion; slatepack/Nostr are
  encrypted to the address / pinned npub). A brute-forced ownership gate cannot *steal*; the
  worst outcome is **griefing** (force a victim's own coins to their own wallet, burning one
  pool-paid fee). Low damage ceiling → CAPTCHA is a heavy answer to a light threat.
- Turnstile conflicts with the pool's **Tor-first, no-account** identity (Tor miners get
  CF challenges on the one screen where they withdraw their own money) and forces a **strict-CSP
  exception** (`challenges.cloudflare.com` script+frame), widening a surface §A/§B narrowed.

Instead, the two *actual* holes on the money path were closed (implementation, not just design):

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

## Abandoned-balance + sub-threshold payout review (add-ons, 2026-07-22)

Post-build logic/security review of the dormancy disposition + manual/backend payout feature
(lib/dormancy.js, withdrawal-scheduler.js override, index.js endpoints, admin/account frontends).
5 findings; all resolved (node --check + temp-DB smoke tests pass; NOT yet VPS-tested).

**Sound by construction (not findings):** single-threaded synchronous node:sqlite transactions make
the disposition sweep and any live withdrawal non-interleaving (no double-spend); both dormancy paths
read *spendable* `balance` (lock model `balance-=amt; balance_locked+=amt`) so locked funds are never
touched; `dormant_sweep`(debit)+`dormant_payout`(credit) net to zero in reconciliation INV_CASES and
stay out of external FLOW_CASES; disposition self-clears (balance>0 filter) so it can't double-sweep.

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| 1 | MED | manualPayout had no double-submit guard → a resubmit wrote a 2nd confirmed withdrawal + debit (over-debit + wallet-audit drift) | dedup in manualPayout(): reject duplicate `kernel_excess`/`slate_id` (unique on-chain id) or identical (address, amount, method='manual') within 60s; frontend disables the button in-flight |
| 2 | LOW | recorder accepted a ≥min amount with no guard → auto-payout scheduler could double-pay in the send↔record gap | manualPayout() rejects `amt >= min_withdrawal` with `above_min_needs_ack` unless `allowAboveMin`; frontend prompts once and retries; steers to the Tor path / freeze |
| 3 | LOW | manualPayout() didn't self-check the freeze (only the endpoint did) | added `if (this.isFrozen()) return payouts_frozen` inside the lib method (defense-in-depth) |
| 4 | LOW | no enforced link between verify-owner and record/send | both money endpoints now require a successful `owner_proof:admin_verify:ok` in admin_audit_log within 15 min, else 428 `verify_required`; explicit `verified_ack` bypass (frontend confirm) for no-proof-on-record accounts |
| 5 | INFO | re-enabling dormancy after a long disable gave no fresh grandfather runway (clock ran through the off period) | pool-settings.updateSection re-arms on a false→true `dormancy_enabled` transition: resets `dormancy_policy_effective_at` to 0 so the next pass re-stamps to now (a full fresh window); true→true saves and disable do NOT reset |

**New capability added in the same pass:** backend-initiated below-min Tor payout
(`POST /api/admin/dormancy/send-payout`) reuses `createWithdrawal(...,{adminOverride:true})` —
bypasses only the min floor + reversal cooldown; freeze, CAS lock, and one-pending-per-address cap
(the double-pay guard) still apply. This is the convenient primary sub-threshold path; the recorder
is the labeled fallback for genuine out-of-band (slatepack/CLI) sends.

## Prize-pool reroute review (add-ons, 2026-07-23)

Follow-up review after the destination change (redistribute-to-active-miners → single prize-pool
credit, REVISION 2026-07-22b). Focus: double-claim / abuse in the reroute + anything the topic misses.
All confirmed-safe items re-verified against live code (single-thread sqlite tx non-interleaving;
spendable-only debit; `dormant_sweep`+`dormant` net zero in INV_CASES and absent from FLOW_CASES;
custodial liability excludes `prize_pool`; reserved addresses excluded as sources; disposed-then-
refunded falls through to a fresh countdown; admin money routes `freshAdmin`-gated). 4 findings, all
fixed (node --check + 18-assertion temp-DB smoke test PASS; NOT VPS-tested).

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| 1 | MED | The ToS reclaim promise ("request a payout to reclaim") was **not durable**: the countdown clock reset only on a *confirmed* payout / fresh share, so a reclaim payout that later **failed & auto-refunded** (or a **partial** withdrawal) left the balance sweepable with the original elapsed clock → next 6h sweep could take it | `dormancy.js` `_candidates()` + `statusFor()` now fold in `MAX(created_at)` of withdrawals of **any status** (`last_request`) into `last_activity`. A reclaim *attempt* durably resets the countdown regardless of the payout's outcome. (No `last_seen_at` write in the withdrawal path → zero side-effect on online tracking.) |
| 2 | MED | Sweeps could run while the incentive **draws were OFF** → abandoned balances pile into a prize pool that never pays out (breaks the ToS "given away through published draws" promise; owner loses reclaim while nobody benefits) | new `_incentivesEnabled()` gate: `runOnce()` skips with `incentives_disabled`, `preview()` reports it as a `blocked` reason, `status()` exposes `incentives_enabled`, admin panel `BLOCK_LABEL` shows "enable prize draws first". No draws → no sweep |
| 3 | LOW | batch `total_swept` was written from the **pre-tx snapshot**, not the in-tx exact sum (identical today, fragile if async ever creeps between candidate collection and the tx) | record `sweptExact` on the batch row inside the transaction (`updBatchTotal`) so the batch is authoritative for the real ledger movement |
| 4 | LOW | `prizePoolStatement` reversal→inflow classification is display-only and could mislabel a hypothetical `reversal/dormant` row | comment clarifying it is a **display grouping only** (reconciliation.js is the accounting authority) and that a `dormant` sweep is terminal by policy — only ever a credit inflow |

**Policy/ToS + wallet copy adapted to match (user directive "the ToS and policy should be adapt,
user wallet or payout should update accordingly"):** ToS §4 (pool-settings.js default `terms`) now
states requesting a payout resets the countdown even if it later fails, that sweeps only run while
draws are active, and that a withdrawal *request* counts as activity; the payout-settings comment +
admin helper text updated (incl. relabel "Active-Miner Window" → "Idle Threshold", dropping the stale
"shared PPLNS-style among miners" text); account-page countdown copy ("counting"/"eligible"/"disposed")
now says "request a payout … resets this countdown" and links the disposed note to the public Prize
Pool ledger. Existing pools must re-seed the ToS page (pages are one-time CMS seeds).

---

## G. IP handling review — 2026-07-25 (add-ons, NOT VPS-tested)

Full sweep of every path where a miner or node IP can land on disk, prompted by the question
"do we hash miner IPs, and should we hash Grin node peer IPs too?". There are exactly **three**
IP-bearing columns in `pool.db`.

| Store | What it holds | Treatment | Verdict |
|---|---|---|---|
| `miner_accounts.last_ip` / `prev_ip` | miner mining source IP (proof window) | salted **scrypt** `v1$<salt>$<hash>`, 16 MB, per-record random salt | ✅ v4 **and** v6 (`canonicalizeIp` expands `::`, folds `::ffff:` v4-mapped, strips zone-id → one stable text form before hashing) |
| `miner_geo.country_code` | miner country | country only, IP discarded at resolve time | ✅ |
| `network_peers.peer_key` | Grin P2P peer | truncated **unsalted** `sha256(net\|ip)` (128-bit) | ⚠️ dedup handle, **not** a privacy control — see G2 |
| `admin_audit_log.ip` | requester origin | **was full plaintext, retained forever** | ❌ → **FIXED, see G1** |

Outside the DB: nginx `${POOL_SERVICE}-access.log` holds real IPs (unavoidable — fail2ban parses
it; bounded by logrotate). `rate-limiter.js` / `ip-filter.js` keep IPs in in-memory `Map`s only,
never persisted.

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

### G2 — [Info/accepted] `network_peers.peer_key` is an unsalted digest — deliberately

`sha256(net + '|' + ip).slice(0,32)`. For IPv4 the entire 2³² space is enumerable in minutes on a
GPU, so this is **reversible by anyone who wants to** — it is a stable dedup handle, not anonymisation.

**Accepted, no change.** Grin P2P node addresses are public by construction: any node on the network
learns its peers' addresses, and the pool only ever stores peers **its own node already connected
to**. Hashing them protects nothing an attacker can't get by running a node for an hour. Salting
would break the cross-snapshot dedup the column exists for (a per-row salt makes the same peer count
N times); a single persistent pepper would restore dedup but only raises the bar to "attacker needs
the pepper" while adding a key to manage and back up — real cost, no meaningful gain.

**The one thing that would matter** is the `country_code` join going public at low peer counts: on a
small testnet pool a country with a single peer is effectively a pointer to one node operator.
`/api/network/peers` should keep aggregating to country with a **minimum bucket size** before that is
exposed — tracked, not yet enforced.

> The code comment on the table ("the raw IP is NEVER stored") is true but reads stronger than the
> property actually is; amended in `db.js` to say dedup handle rather than implying anonymisation.

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

The floor is applied to `network_peers` **before the twinkle `points` array is built**, not only to
the country list — points are placed at their country's position, so emitting them for a thin country
would re-expose precisely what the floor hides. Client-side this is already safe: `network-map.js`
filters `c.lat != null` before rendering, and its country-highlight set matches on canonical
Natural-Earth names, which `Other` never matches.

**Related, NOT fixed here:** `/api/pool/miners` (§C1) still returns every miner's **full** Grin
address and balance unauthenticated. No IP — but it is a bigger identity leak than the map ever was,
and it contradicts the posture `/api/stratum/stats` already applies (that route truncates addresses
to `xxxxxxxxx…xxxx` specifically so the session list can't be scraped into a miner census). C1 stays
open pending an operator decision on public-leaderboard behaviour.

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
