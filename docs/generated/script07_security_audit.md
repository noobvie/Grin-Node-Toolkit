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
