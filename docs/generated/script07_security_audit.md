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
