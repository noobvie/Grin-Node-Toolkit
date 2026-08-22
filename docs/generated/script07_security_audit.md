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
  deliberately). Admin cancel stays (step-up gated). ~~OPEN follow-up: the automatic
  retry/reversal paths carry the same theoretical double-pay exposure; fix = record slate_id
  on Tor sends and check wallet tx state (`retrieve_txs`) before any retry or reversal.~~
  → **CLOSED 2026-08-01, see §H1.** The prescribed fix was half-built: `_captureTorSlateId()`
  recorded the slate_id but nothing consulted it, so the retry ladder still re-sent blindly.
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
  window, before any lock is taken. Purpose: (1) safety margin over the (then-open, now closed
  in §H1) slate_id/`retrieve_txs` double-pay window in E.1 — a "failed" Tor send that actually
  posted gets 30 min to surface before the miner can pull the same funds through another rail.
  **Note this never covered the retry ladder itself** (same row re-entering `sendWithdrawal`,
  which does not pass this check) — only a *new* withdrawal on another rail. §H1 is what closed
  the ladder;
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
reversal shares the exposure) — **closed 2026-08-01 by §H1/§H2**; this rail is in fact the most
exposed to the finalize race, since its 10-minute TTL is far tighter than slatepack's 24 h and
relay redelivery makes duplicate response events routine rather than exceptional.

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

Pre-mainnet review of the three payout rails, run before topping up a real wallet. The spine —
one balance-lock accounting path with three delivery adapters — was found sound and was NOT
restructured. Two ways it could pay the same money twice were found and closed. Both were the
same bug class: **a decision to spend money made from state read before an `await`, and
re-checked nowhere.**

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

### Verification (unit-level; NOT VPS-tested)

54 assertions against the **real** methods — the scheduler ones driven over a real SQLite, the
cache lifted out of the real `index.js` — so they cannot drift from shipped code. The pool's
`better-sqlite3` is a native module that exists only on the VPS, so the harness runs on Node's
built-in `node:sqlite` with a shim for the one better-sqlite3-ism used (`db.transaction(fn)`).

Covered: the H2 interleaving replayed end to end (claim → sweep runs → confirm: paid once, **not**
refunded); second claim / second confirm / reversal-on-settled all refused and verified to move no
money; admin cancel on a claimed row 409s; stale reclaim in all three directions; H1 exact-slate
and amount+time matches plus every rejection path (cancelled tx, wrong amount, tx predating the
row, no wallet, junk response); the false positive that would matter most (another payout's
slate_id never borrowed at an identical amount); cache hit/miss, concurrent dedup, throwing-probe
cleanup, 500-entry bound, TTL expiry; and that the withdraw pre-flight never reaches the cache.

**Still to validate on the VPS:** `_priorSendLanded` matches against grin-wallet's `TxLogEntry`
shape — confirm a real `retrieve_txs` response carries `creation_ts` and the
`amount_debited`/`amount_credited`/`fee` fields where expected before leaning on it.

### Still open after this pass (none can move money incorrectly)

- **Dead `canInitiateWithdrawal()`** (zero callers) encodes a status list missing
  `slatepack_pending` and `MAX_USER_PENDING = 10`, contradicting the one-pending-per-address rule
  the live path enforces. Harmless until someone wires it up believing it is the cap check, which
  would re-open the cross-rail hole §E.2 closed. Delete it or reduce it to a wrapper.
- **Audit action string takes unvalidated input.** The withdraw route builds its audit action by
  interpolating the request's `method` field before that value is validated (the check sits after
  every early return), so a failed proof with an arbitrary `method` writes
  `owner_proof:withdraw_<anything>:deny` into `admin_audit_log.action`. Not SQL injection
  (parameterised), but the audit reader matches on `action LIKE` patterns, so rows can be planted
  that mimic other event types and muddy an incident trail.
- **Placeholder zeros in `_releaseLockAndDebit`** — its two debit rows still write `0` for balance
  before/after (the locked columns are correct). Reversals were fixed in §H2.

## I. Re-audit 2026-08-21 (pre-retest pass — backend, frontend, payment path)

Full fresh pass ahead of a GRINIUM re-test. Scope: every Express route + its authz chain,
`lib/auth*`, the whole payout path (all three rails), PPLNS/block-reward accounting,
share retention, the lottery draw, the generated nginx vhost, and the public + admin
front-ends. Still **NOT VPS-tested** — every finding below is code-level.

**Re-verified clean this pass** (no change needed): JWT handling (jsonwebtoken 9.0.3,
type-discriminated access/refresh, `sst` absolute cap, `pwa` step-up freshness); cookie
flags (`httpOnly` + `sameSite:strict` + `secure` under the unit's `NODE_ENV=production`,
so CSRF on the cookie-auth surface is closed); `trust proxy: 'loopback'` making XFF
unspoofable; SQL — every dynamic `SET` clause is built from a hardcoded `_clean()` key
whitelist, so `ads`/`pages`/`posts`/`pool_locations` are not injectable; stratum
`validateUsername` (bech32 + `[a-z0-9_-]` worker names) means no miner-controlled string
ever reaches a renderer; asset upload/delete (magic-byte sniff, server-controlled
filename, DB-lookup-then-`basename` unlink, sandbox CSP on `/uploads/` + `/custom/`);
NIP-05 resolution (domain allowlist + hostname-shape guard, no IP literals) — no SSRF;
withdrawal balance locking (CAS `WHERE balance >= ?`, one-pending-per-address inside the
transaction, `_claimForFinalize` before the first `await` on all three rails); the
`sqlite-compat` transaction shim (real BEGIN/COMMIT/ROLLBACK + savepoint nesting, and no
`transaction(async …)` anywhere); first-admin-only registration.

### I1 — [High] The generated nginx vhost drops **every** security header on the two locations that serve HTML

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

### I2 — [Medium] No HSTS anywhere in the nginx vhost

`grep add_header` over the generated config returns no `Strict-Transport-Security`. The
Express app sets it, but only on responses it generates (`/api/…`, `/blog/<slug>`) — the
HTML page load itself never carries it, so a first-visit downgrade is not protected even
though `:80` redirects. Add it to the shared snippet from I1.

### I3 — [Medium] The block-reward "verify against the chain before crediting" control is dead code

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

### I4 — [Medium-High] Reward distribution is not atomic with the `confirmed → paid` flip → double-credit on a crash

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

### I5 — [Low-Medium] `creditBalances` writes placeholder zeros into every credit ledger row

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

### I6 — [Low] Miner credit has no account-existence guard, unlike the pool-fee credit

The pool-fee path does `INSERT OR IGNORE INTO miner_accounts` before crediting
([:165-169](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L165-L169)); the
miner loop does a bare `UPDATE … WHERE grin_address = ?` with no such guard and no
`changes` check. Because `balance_log.grin_address` is a FK and `PRAGMA foreign_keys = ON`
([db.js:17](../../web/07_mining_pool_public/back-end-pool/lib/db.js#L17)), a missing account
row does not silently swallow the credit — the ledger insert throws, the transaction rolls
back, `distributeRewards` returns `success:false`, and the block stays `'confirmed'` and is
**retried every 30 seconds indefinitely**. Nothing currently deletes `miner_accounts` rows,
so this is latent rather than live, but it is a hard stall with no alert if it ever fires.

### I7 — [Medium] `POST /api/admin/settings/:section` re-implements step-up and loses the mandatory-2FA gate

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

### I8 — [Medium] The lottery seed is chosen *after* the entry set is known, so a "provably fair" draw is grindable

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

### I9 — [Low] Share retention's safety floor ignores blocks stuck in `confirmed`

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

### I10 — [Low] Operator-supplied region labels reach `innerHTML` unescaped on the network map

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

### Carried forward from §H (re-confirmed still open)

- **Unvalidated `method` in the withdraw audit action** ([index.js:3477-3485](../../web/07_mining_pool_public/back-end-pool/index.js#L3477-L3485)).
  Re-checked the render side this pass: `payments.html:772` escapes with `escHtml()`, so
  this is **not** stored XSS — it remains an audit-trail-pollution issue only, as §H states.
- **Dead `canInitiateWithdrawal()`** — still zero callers, still encodes the wrong cap.
- **Placeholder zeros in `_releaseLockAndDebit`** — see I5, now known to be the same bug on
  both the credit and debit sides.
- **C3 access token unrevocable until expiry** — unchanged; the 24 h idle ceiling still
  bounds it.

### Stale comment worth correcting

[ip-filter.js:279-283](../../web/07_mining_pool_public/back-end-pool/lib/ip-filter.js#L279-L283)
documents `app.set('trust proxy', 1)`. The live setting is `'loopback'`
([index.js:219](../../web/07_mining_pool_public/back-end-pool/index.js#L219)), which is
stricter and correct — the comment just predates the change.

### Re-test sequencing note (not a code finding)

`/api/auth/register` is first-admin-only, but the check is a `SELECT COUNT(*)` immediately
before `registerAdmin()`. Whoever reaches it first owns the pool. During the re-test,
register the admin account **before** the vhost is publicly resolvable, or keep
`admin_allowlist` set until it is done — the nginx network gate ships open by default.

### I — resolution pass, 2026-08-21 (same day, add-ons, NOT VPS-tested)

All ten findings fixed. Unit-verified by `scripts/test-money-path.js` (new, wired into
`npm test` — 30 assertions, all passing); the nginx and front-end changes are code-level only
and still need the VPS re-test to confirm.

| # | Fix | Where |
|---|---|---|
| I1 | Security headers moved into two generated snippets under `/etc/nginx/snippets/`; **every** block that declares an `add_header` of its own now re-`include`s one (`/admin/`, `/`, `/uploads/`, `/custom/`) | `07_grin_mining_public_pool.sh` |
| I2 | `Strict-Transport-Security` added to the common snippet — included only from the `:443` server, never the `:80` redirect | same |
| I3 | `new RewardDistributor(config, blockMonitor.grinNode)`; check rewritten to `getHeader` and made fail-closed | `index.js`, `lib/rewards.js` |
| I4 | Credits + pool fee + incentives + the `confirmed→paid` CAS flip collapsed into ONE transaction, flip first | `lib/rewards.js` |
| I5 | Real `balance_before/after` + `locked_before/after` on every credit row, and in the shared `_move` | `lib/rewards.js`, `lib/incentives.js` |
| I6 | `INSERT OR IGNORE` + a `changes !== 1` assertion on the miner credit | `lib/rewards.js` |
| I7 | New `stepUpRefused()` carries **both** halves of the step-up contract; both inline call sites use it | `index.js` |
| I8 | Draws are now commit-reveal against a future block, with a frozen published entry set | `lib/lottery.js`, `lib/db.js` |
| I9 | Retention floor covers `status IN ('immature','confirmed')` | `lib/retention.js` |
| I10 | `esc()` added and applied to both `innerHTML` interpolations | `public_html/js/network-map.js` |

**Two corrections to the findings above, both learned while fixing them:**

- **I3 was worse than reported, and the naive fix would have broken every payout.** The dead
  branch called `getBlock(height)` and compared `nodeBlock.hash`, but `GrinNodeAPI.getBlock`
  returns `{ header: { hash, … }, inputs, outputs }` — there is no top-level `.hash`. So
  simply passing `grinNode` in would have made `undefined !== block.hash` true on every block
  and hard-failed all distribution. The check now uses `getHeader`, which additionally is the
  only correct call here: a pruned node (`mainnet-prune`, the standard deployment) keeps the
  full header chain at every height but serves block *bodies* only inside the pruning horizon.
  Comparison is on **nonce** (authoritative — it is what `OrphanDetector.verifyBlockOnChain`
  already uses in production) plus **hash** when both sides are 64-hex; a non-hex stored hash
  logs loudly and falls back to nonce rather than freezing payouts on a format assumption that
  has not been checked against a live node. **Confirm on the VPS** that `blocks.hash` — parsed
  out of the node stratum's `blockfound - <hash>` reply — matches `get_header(h).hash`, and if
  the warning appears, tighten this to hash-mandatory.

- **I6 is not reachable, and its severity should read Info, not Low.** `shares.grin_address`
  is itself `REFERENCES miner_accounts(grin_address)`, so a share cannot exist for an address
  with no account row — the "block stalls in `confirmed` forever" failure needs a state the
  schema forbids. Verified by trying to construct it in the test harness: the insert fails
  with `FOREIGN KEY constraint failed`. The `INSERT OR IGNORE` is kept as consistency with the
  pool-fee path, not as a bug fix. §I9's fix stands on its own regardless (a node outage, not
  I6, is the realistic way a block lingers in `confirmed`).

**Behaviour changes an operator will notice:**

1. **Distribution now refuses rather than proceeding when the node is unreachable.** The old
   `else` branch logged `[WARNING] Grin node not available - skipping blockchain verification`
   and credited anyway. A block now stays `confirmed` and retries next tick. Expect delayed —
   never unverified — payouts during a node outage.
2. **The lottery no longer pays out when the button is pressed.** `draw-now` COMMITS: it
   freezes the entry set and pot and locks the draw to block `tip + 10`. Winners are picked
   and paid on a later hourly tick, once that block is mined (~10 min). The admin confirm
   dialog and toast were rewritten to say so, and a new `.toast.warn` style was added for the
   "no eligible entries" case. Campaigns gain a `drawing` status for the same interval.
3. **Draws committed before a shutdown survive it** — `resolveCommittedDraws()` runs first on
   every scheduler tick, so an unrevealed draw resolves whenever the process comes back.

**Residual on I8:** a reorg deeper than `SEED_DELAY_BLOCKS` (10) at exactly the committed
height would change the seed. Grin reorgs are shallow and the entry set + pot are already
frozen, so the exposure is a re-rolled winner, not a manipulable one — but the reveal reads
whatever header is canonical at read time, so a draw is only as final as the block it names.

**Still open (unchanged, carried from §H):** the unvalidated `method` in the withdraw audit
action, dead `canInitiateWithdrawal()`, placeholder zeros in `_releaseLockAndDebit` (the
credit-side instances were fixed under I5; the debit side was left alone this pass because it
sits inside the payout state machine and deserves its own review), and C3.

### §I — self-review pass (2026-08-21)

A second read of the §I fixes themselves, looking for defects introduced by the fixes. Three
were found and corrected; a fourth is a repository-history problem, not a code one.

1. **I1 introduced an over-broad HSTS.** The new shared header snippet shipped
   `Strict-Transport-Security "max-age=31536000; includeSubDomains"`. There was no HSTS before
   this pass, so the directive is entirely new — and `includeSubDomains` is the wrong default
   here. `subdomain` in `pool.json` is routinely the operator's **apex** domain (the vhost
   derives `www.<subdomain>` from it and treats the bare domain as canonical), so the header
   would pin every sibling host on that domain — `api.`, `testapi.`, anything else the
   operator runs — to HTTPS for a year. Browsers cache the directive for the full `max-age`,
   so removing the header afterwards does not undo it: an http-only or bad-cert sibling stays
   unreachable until it expires. The protection gained covers only hosts this script never
   deploys. **Fixed:** `max-age=31536000`, no `includeSubDomains`, no `preload`, with the
   reasoning written into the snippet so it is not "helpfully" re-added.
2. **I8's reveal could not be diagnosed.** `resolveDraw()` caught every `getHeader` failure and
   returned `null`, so "the seed block is not mined yet" (normal, every tick until reveal) and
   "the node has been unreachable for a week" produced the same silent no-op. A draw stuck in
   `committed` forever would emit no log line at all. **Fixed:** the tip is read first; below
   `seed_height` is silent and normal, at-or-above it a `getHeader` failure is an anomaly and
   is logged with both heights.
3. **I8 added a redundant index.** `idx_lottery_entries_draw ON lottery_entries(draw_id,
   grin_address)` duplicates the implicit index SQLite already creates for
   `PRIMARY KEY (draw_id, grin_address)` — same columns, same order — costing a second write
   per entry row for nothing. **Fixed:** removed.

**Confirmed correct on re-read** (checked, not assumed): `blockMonitor.grinNode` and
`getHeader()` both exist with the shapes I3 relies on; `dueDraws()` keys off `created_at`,
which is stamped at COMMIT, so a draw awaiting reveal does not re-trigger; `runDueCampaigns`
filters `status='scheduled'`, which excludes the new `drawing`; `_scheduleNextOccurrence`
INSERTs a fresh row rather than mutating the one the reveal later stamps; `lottery_draws`
has no CHECK on `status` and both `seed_hash`/`drawn_at` are nullable, so the commit INSERT is
valid on an existing DB with no migration; the public `recent_winners` payload and the fortune
board both read through `lottery_winners`, so a `committed` draw cannot render as a null seed;
the settings route's duplicated freshness check is reached only when fresh and cannot
double-send; `stepUpRefused` emits a byte-identical refusal to `requireTotpEnrolled`; and
`network-map.js` has no third unescaped `innerHTML` sink.

**Repository note (not a defect in the code):** the I1/I2 nginx work was swept into commit
`1cafea0 "docs(comments): audit batch A5 — public pool (shell)"` by a concurrent
comment-audit session. The fix is present and correct, but its commit message describes it as
comment-only, so a later reader auditing when HSTS/CSP inheritance was fixed will not find it
there. Worth a note in the changelog.
