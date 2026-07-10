# Script 052 — Grin Drop — Security Audit

**Scope:** the public faucet + donation web service (`web/052_drop/server/*.js`) and its
nginx edge (`scripts/lib/052_lib_nginx.sh`). Focus: fund-drain, rate-limit bypass, wallet
abuse, injection. Admin is a server-side bash TUI (root already), so no web-admin surface.

**Date:** 2026-07-10 · **Auditor:** Claude · **Verdict:** No fund-theft or injection bug
found. Drain is bounded by the global daily/hourly cap — but several per-user limiters that
*look* protective are bypassable, so the global cap is the *only* real ceiling. Operators
must set it deliberately.

---

## Threat model
The service holds a hot wallet (passphrase on disk, unattended signing) and pays GRIN out on
anonymous request. The prize the attacker wants is **spendable balance**. Secondary prizes:
wallet DoS (LMDB lock starvation) and skewing public stats.

---

## Findings

### F1 — [Medium] Bot protection fails open and ships disabled → global cap is the only drain brake
- **Evidence:** `verifyTurnstile()` returns `true` when no secret is configured
  ([app.js:147-148](../../web/052_drop/server/app.js#L147-L148)) *and* returns `true` on any
  `fetch` exception ([app.js:156-158](../../web/052_drop/server/app.js#L156-L158)).
  `turnstile_secret` defaults to `''` ([config.js:83](../../web/052_drop/server/config.js#L83)).
- **Impact:** Out of the box there is **no** CAPTCHA. Combined with F2/F3 (bypassable
  per-IP/per-address limits), the drain ceiling is purely `global_daily_claims_cap ×
  claim_grin_per_tx` (default mainnet ≈ 2000 × 0.008 = **16 GRIN/day**, testnet unbounded value).
  An operator who raises the cap or per-tx amount without a working Turnstile is exposed to
  full-cap drain by a single script.
- **Fix:** (a) Log a loud startup WARN when `giveaway_enabled` is true but `turnstile_secret`
  is empty. (b) Make the network-error branch fail *closed* on mainnet (or add a
  `turnstile_fail_open` flag defaulting false for mainnet). (c) Document in the setup flow that
  the global cap — not the cooldown — is the true loss ceiling.

### F2 — [Medium] Anonymous-claim IP is client-spoofable on non-Cloudflare deployments
- **Evidence:** `getClientIp()` trusts `cf-connecting-ip` header **first**
  ([app.js:130-132](../../web/052_drop/server/app.js#L130-L132)); the anon endpoint keys its
  rate limit on `hashIp(getClientIp())` ([app.js:461-472](../../web/052_drop/server/app.js#L461-L472)).
  The nginx vhost only overwrites `X-Real-IP` ([052_lib_nginx.sh:395](../../scripts/lib/052_lib_nginx.sh#L395))
  and **does not** deploy the spoof-safe `set_real_ip_from`/`real_ip_header CF-Connecting-IP`
  block that already exists in `nginx_shared_helpers.sh:485-529`.
- **Impact:** If the site is reached directly (no Cloudflare, or origin IP exposed), an attacker
  sends `CF-Connecting-IP: <random>` on each request → every anon claim looks like a new IP →
  per-IP cooldown fully bypassed. (Bounded by F1's global cap, but that cap is the point.)
- **Fix:** Only honour `CF-Connecting-IP` when the request genuinely came from Cloudflare.
  Wire the existing CF `real_ip` helper into `052_lib_nginx.sh` and have the app read the
  post-`real_ip` `X-Real-IP` (or `req.ip` with `trust proxy` set to the nginx hop) instead of
  trusting the raw CF header. Gate CF-header trust behind a `behind_cloudflare` config flag.

### F3 — [Low] Per-address cooldown is cosmetic (addresses are free)
- **Evidence:** `nextClaimIso()` rate-limits by `grin_address`
  ([app.js:161-170](../../web/052_drop/server/app.js#L161-L170)); a claimer can generate
  unlimited fresh `grin1…` addresses at zero cost.
- **Impact:** The advertised "1 claim / 4h" is trivially defeated by rotating addresses. Not a
  code defect — a design property — but it gives false assurance. Only the global cap bounds drain.
- **Fix:** Documentation/UX honesty: state that the cooldown deters casual repeat-claims, not a
  determined drainer, and that the global cap is the real ceiling. Consider a per-IP cooldown on
  the *address* endpoint too (currently only the anon endpoint is IP-limited).

### F4 — [Low] Edge rate-limit is ineffective behind Cloudflare (no real_ip mapping)
- **Evidence:** All `limit_req` zones key on `$binary_remote_addr`
  ([nginx_shared_helpers.sh:366](../../scripts/lib/nginx_shared_helpers.sh#L366)); the Drop
  vhost never enables `real_ip`. Behind Cloudflare `$remote_addr` is a CF edge IP shared by all
  visitors → the 5r/m API zone either throttles unrelated users together or is defeated by CF's
  IP pool. Directly exposed, it works but is F2-spoofable at the app layer (not the nginx layer,
  which uses `$remote_addr`, so nginx's own limit still holds — good).
- **Fix:** Same as F2 — enable `ngx_http_realip_module` with CF ranges so `$binary_remote_addr`
  reflects the true client.

### F5 — [Low] Operator-controlled strings reflected into HTML unescaped
- **Evidence:** `drop_name` and `maintenance_message` are interpolated into the maintenance
  503 page without escaping ([app.js:181-184](../../web/052_drop/server/app.js#L181-L184)).
- **Impact:** Stored self-XSS only — the values come from the server-side admin (trusted). No
  path for an anonymous user to set them. Low risk; hardening only.
- **Fix:** HTML-escape both before interpolation.

### F6 — [Info] `/api/status?addr=` is an address-activity oracle
- **Evidence:** [app.js:284-285](../../web/052_drop/server/app.js#L284-L285) returns
  `next_claim_at` for any queried address → lets anyone probe whether a given address has
  recently claimed. Minor privacy leak; no fund impact.

### F7 — [Info] Hot-wallet passphrase on disk (accepted residual risk)
- `wallet_pass_file` (`.temp_<suffix>`) is read on every Owner-API session
  ([wallet.js:60-64](../../web/052_drop/server/wallet.js#L60-L64)). Unavoidable for an
  unattended faucet (receive/finalize are signing ops). Ensure the file is `grin:grin` `0600`
  and the DB/`.conf` are `0600` (config write uses `mode:0o600` — good,
  [config.js:143](../../web/052_drop/server/config.js#L143)). Same rationale as the pool's
  hot-wallet note in `script07_security_audit.md`.

---

## Controls that are correct (no action)
- **SQL injection:** none — every query uses `better-sqlite3`/`node:sqlite` prepared statements
  with bound params, incl. the `LIKE` search ([db.js:193-203](../../web/052_drop/server/db.js#L193-L203)).
- **Amount tampering:** claim/anon amounts are clamped server-side to `[0.0001, cap]`
  ([app.js:387-389](../../web/052_drop/server/app.js#L387-L389), 486-488); a user cannot request
  more than the cap. Donation amount capped at 10000 GRIN before touching the wallet.
- **Finalize tampering:** a returned response-slate cannot inflate the payout — `finalize_tx`
  rejects any mismatch with the server-signed `init_send_tx` (KernelSumMismatch). `claim_id` is
  sequential/guessable but useless without the counterparty-signed slate.
- **Self-address drain:** claim and invoice both reject the drop wallet's own address
  ([app.js:362-366](../../web/052_drop/server/app.js#L362-L366), 706-710).
- **Input bounds:** `express.json({limit:'16kb'})`, slatepack `≤8192` bytes + format check
  ([app.js:139-143](../../web/052_drop/server/app.js#L139-L143)).
- **Owner API v3 ECDH/AES-256-GCM** implemented correctly (random 12-byte nonce per call, GCM
  auth tag verified on decrypt — [wallet.js:171-214](../../web/052_drop/server/wallet.js#L171-L214)).
- **Exposure:** app binds `127.0.0.1` only ([app.js:955](../../web/052_drop/server/app.js#L955));
  secrets are never logged; wallet errors are classified, not leaked verbatim to a fund attacker.
- **LMDB DoS mitigation:** single serialized background scanner with quiet-window deferral
  keeps a claim flood from fanning out concurrent node scans ([app.js:908-937](../../web/052_drop/server/app.js#L908-L937)).

---

## Priority for the operator
1. **F1** — never run mainnet with `giveaway_enabled` and an empty `turnstile_secret`; keep the
   global daily cap conservative (it *is* your loss ceiling).
2. **F2/F4** — wire the CF `real_ip` helper into the Drop vhost if you use Cloudflare; otherwise
   don't trust `CF-Connecting-IP` at all.
3. F3/F5/F6 — hardening + doc honesty.
