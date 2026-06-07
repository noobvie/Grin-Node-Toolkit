# GRINIUM — Security

**Updated:** 2026-06-06
Auth, rate limiting, hardening, data-leak prevention. Bug refs (BUG-NN) →
[build-plan.md](build-plan.md). Payment-specific security (claim token, payment
proof, withdrawal spam) lives in [payments.md](payments.md).

---

## Trust model

- **Miners never authenticate.** Address-as-identity. All miner-facing endpoints
  are public, keyed by Grin address. Safety comes from funds always going to the
  miner's own address (Tor) or being payment-proof-bound (Slatepack), **not**
  from access control on the endpoints.
- **Admins authenticate.** JWT sessions, admin-only. Admin registration is a CLI
  action, not an exposed endpoint.

---

## Authentication

- **Password hashing:** bcrypt, **rounds ≥ 12** (current code uses 10 — BUG-23).
- **JWT in an httpOnly cookie** (`pool_token`) — not localStorage (avoids XSS
  token theft). A separate non-secret `pool_user` cookie (`{username, is_admin}`)
  is readable by the client for display only.
- **Access token** short-lived (≤ 1h). **Refresh tokens must be revocable:**
  track `jti` in a `refresh_tokens` table and revoke the old one on refresh;
  otherwise a stolen refresh token is valid for its full lifetime (BUG-21).
- **Account lockout:** per-username `failed_login_attempts` + `locked_until`;
  lock after N failures. Per-IP rate limiting alone is bypassed by IP rotation
  (BUG-22).
- **Frontend auth gate must `await`** the async check (BUG-19). The current code
  calls `isLoggedIn()` (a Promise) without awaiting → always truthy → every
  visitor passes. Gate against an **authenticated** endpoint
  (`/api/admin/dashboard` returns 401), never the public `/api/health`.

## Admin re-authentication (sensitive ops)

Withdrawal **retry/cancel** require `requireFreshAuth(300)`:
- JWT age < 5 min → allow.
- JWT age ≥ 5 min → `403 { challenge_required: true }`; client prompts for
  password → `POST /api/auth/reauth { password }` → fresh token → retry.
Stateless (uses JWT `iat`); no extra token store needed.

---

## Network-layer protections

- **Trust proxy correctly.** `app.set('trust proxy', 1)` and use `req.ip`
  everywhere. The current IP allowlist/rate-limiter read raw `X-Forwarded-For`,
  which a client can spoof to impersonate an allowed IP (BUG-20). Strip the
  header-trust code.
- **Rate limiting:** nginx zones (`pool_api` 30 r/m public; `pool_torcheck`
  1/60s/IP) plus app-level limits (admin endpoints; 1 tor-check/5min per
  address). Defined via the shared nginx helper, never inline.
- **Helmet** for security headers (frameguard deny, etc.) as defense-in-depth;
  CSP is owned by nginx.

---

## XSS / frontend hardening

- **Escape all interpolated data.** There are ~11 `innerHTML = data.map(...)`
  sinks (worker names, status reasons, settings values) and only one file
  defines an escaper (BUG-27). Centralize `escHtml()` in `/js/escape.js` and use
  it everywhere, or build DOM via `createElement` + `textContent`.
- **Worker-name validation at the stratum layer** (`^grin1[a-z0-9]+(\.[a-z0-9]+)?$`)
  stops malicious worker names (e.g. `grin1<script>`) entering the DB in the
  first place.
- **CSP:** currently allows `'unsafe-inline'` for scripts because pages use
  inline `onclick=`/`<script>` (BUG-28) — CSP is decorative until inline handlers
  move to `addEventListener` in separate `.js` files; then drop `unsafe-inline`
  / use nonces.
- **Uploads:** drop `image/svg+xml` from allowed MIME types (SVG can carry
  `<script>` → stored XSS via admin logo, BUG-29). Register the static route for
  uploaded assets (BUG-30) and upgrade `multer` to v2 (BUG-31 — v1 CVEs).

---

## Public data-leak prevention

- `GET /api/pool/payments` and `/api/pool/miners` must **not** expose raw rows
  with full addresses + amounts/balances (BUG-32). Either gate behind admin, or
  return **aggregates / anonymized leaderboards** (truncated addresses, totals).
- No fake/hardcoded metrics in any public or dashboard response (BUG-33).
- Per-address pages are public by design (2miners-style) but show only that
  address's own data, retrieved by exact address.

---

## Audit logging

- **One column shape** for `admin_audit_log`: `(admin_id, action, target_type,
  target_id, before_state JSON, after_state JSON, ip, created_at)`. The current
  code has three different writers with mismatched columns and a NOT NULL
  `target_type`, so every audit INSERT silently fails → empty log (BUG-18). Fix
  the schema and all writers.
- **No admin mutation may succeed without an audit row** (enforced at the
  handler). Records actor, IP, before/after JSON, timestamp.
- CSV export of the log for external audit.

---

## Validation notes from production pools

(`grin-pool`, `open-grin-pool`, `grin-pool-monitor`)

- **Confirm-depth 1441** (mainnet), not 10 — prevents reorg payouts (loss of
  pool capital).
- **No Tor port-probing** before send — leaks circuit identity.
- **Orphan detection by nonce** validated against the chain after payout, with
  exact-amount reversal (prevents orphan steals).
- **JWT can't be revoked mid-session** — mitigated by short expiry + refresh
  revocation + fresh-auth on sensitive ops.

---

## Security pre-launch gate (subset of the full checklist)

- [ ] bcrypt ≥ 12; refresh revocation; account lockout
- [ ] httpOnly cookie auth; frontend gate awaits an authenticated endpoint
- [ ] `trust proxy` + `req.ip`; no `X-Forwarded-For` trust
- [ ] central `escHtml` on every interpolation sink; worker-name regex enforced
- [ ] SVG rejected; multer v2; uploaded-asset static route + MIME check
- [ ] public payments/miners endpoints aggregated or gated
- [ ] `admin_audit_log` single shape; every admin action audited
- [ ] HTTPS enforced; secrets only in `pool.json`, never in code
