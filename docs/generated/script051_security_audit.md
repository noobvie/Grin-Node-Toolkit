# Script 051 / 055 — Web Wallets — Security Audit

**Scope:** the private single-user web wallet (`web/051_wallet/server.js` +
`scripts/051_grin_private_web_wallet.sh`), the XP-themed client variant (`web/051_xp_wallet/`),
and the public WASM wallet (055). Focus: key/passphrase handling, auth boundary, SSRF, slate
processing.

**Date:** 2026-07-10 · **Auditor:** Claude · **Verdict:** 051 is carefully built — passphrase
in memory only and piped via stdin (never argv), a Host/Origin anti-rebind/CSRF guard, path
traversal guards, and all auth **fail-closed** behind nginx Basic Auth + TLS. One authenticated
SSRF (`/api/node/ping`). **055 is an unimplemented placeholder** with a sound non-custodial
design; the 051x client stores no keys in the browser.

---

## Trust model (051)
The Node process binds `127.0.0.1:7420` and has **no in-process authentication** — the entire
auth boundary is nginx Basic Auth ([051_…sh:679-680](../../scripts/051_grin_private_web_wallet.sh#L679-L680)),
which fail-closes (nginx errors without the htpasswd file, [:758](../../scripts/051_grin_private_web_wallet.sh#L758)).
Anyone who passes Basic Auth controls **every** registered wallet (connect/unlock, send, view
seed on init). This is acceptable for a single-operator private wallet, but it means the Basic
Auth credential + TLS are the whole game — there is no per-wallet authorization tier.

## Findings

### F1 — [Low] Authenticated SSRF via `/api/node/ping`
- **Evidence:** [server.js:951-969](../../web/051_wallet/server.js#L951-L969) takes `req.query.url`,
  validates only `^https?://`, then `fetch(url + '/v2/foreign', …)`. A `GET`, so the Origin guard
  (POST/PUT/DELETE/PATCH only) doesn't cover it — just the Host check + nginx Basic Auth.
- **Impact:** An authenticated user can make the server issue POST requests to arbitrary
  hosts/ports (internal services, `169.254.169.254`, port-scan by latency). Only `reachable`,
  `latency_ms`, and a parsed `height` are returned, so exfil is minimal, and the caller is the
  trusted operator — hence Low. Still an unnecessary outbound-request primitive.
- **Fix:** Restrict the target to the known node allowlist (`MAINNET_NODES`/`TESTNET_NODES` +
  loopback) or validate the host, and block link-local/loopback-metadata ranges.

### F2 — [Info] Wallet family security model & confirmations
- **All auth via nginx** (above) — document that exposing `:7420` directly, or deploying without
  the htpasswd step, hands over all wallets. The installer's fail-closed nginx is the safeguard.
- **The public WASM wallet is not implemented** (the `scripts/055_*.sh` placeholder audited here
  was deleted 2026-07-29; the product has no number until its build starts). Its intended model —
  client-side WASM crypto, keys never leaving the browser, wallet data in IndexedDB encrypted with
  AES-GCM/PBKDF2, server serves static files only
  ([script05_design.md PART A](script05_design.md)) — is the correct
  non-custodial design. **When built, audit:** the WASM/JS supply chain (SRI/pinning), the
  PBKDF2 iteration count, and XSS on the static host (an XSS = seed theft in a browser wallet).
- **051x XP client** stores no seed/key/passphrase in `localStorage`/`sessionStorage`/`IndexedDB`
  (grep-verified) — it drives the 051 backend rather than holding keys.

---

## Controls that are correct (no action)
- **Passphrase hygiene:** kept in memory only (no `.wallet_pass` on disk); passed to
  `grin-wallet` via **stdin, never argv** — so it can't leak through `ps`
  ([server.js:640-643](../../web/051_wallet/server.js#L640-L643), 668-669); cleared on failed connect.
- **DNS-rebinding + CSRF guard:** strict Host allowlist on every request and Origin/Referer check
  on all state-changing methods ([server.js:353-371](../../web/051_wallet/server.js#L353-L371)).
- **Path traversal:** every client-supplied `dir` is asserted inside `WEBWALLET_ROOT`
  (`_isInsideRoot`, [server.js:441-446](../../web/051_wallet/server.js#L441-L446)); wallet names
  are `^[a-zA-Z0-9\-_]+$`.
- **Send safety:** amount validated `> 0`; destination validated against the bech32 address regex
  **and** network-matched (rejects sending a mainnet wallet to a `tgrin1…` and vice-versa)
  ([server.js:1132-1173](../../web/051_wallet/server.js#L1132-L1173)); slatepack input capped at
  16 KB with format check.
- **Owner API v3 ECDH/AES-256-GCM** implemented correctly (random 12-byte nonce, GCM tag verified).
- **Transport & limits:** `trust proxy` loopback, `express.json` 32 KB, registry `0600`, wallet
  dirs `0700`, per-IP+wallet connect rate limit (5/min), nginx TLS + `server_tokens off` +
  `client_max_body_size 1m`.

---

## Priority for the operator
1. **F1** — allowlist the `/api/node/ping` target.
2. **F2** — never expose `:7420` directly; always front with the installer's nginx Basic Auth +
   TLS. Re-audit 055 when it's actually built (browser-wallet XSS = key theft).
