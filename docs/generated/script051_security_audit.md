# Script 051 / 055 — Web Wallets — Security Audit

**Scope:** the private single-user web wallet (`web/051_fidelius/server.js` +
`scripts/051_grin_fidelius.sh`), the XP-themed client variant (`web/051_xp_wallet/`),
and the public WASM wallet (055). Focus: key/passphrase handling, auth boundary, SSRF, slate
processing.

**Date:** 2026-07-10 · **Revised:** 2026-08-05 · **Auditor:** Claude · **Verdict:** 051 is
carefully built — passphrase in memory only and piped via stdin (never argv), a Host/Origin
anti-rebind/CSRF guard, path traversal guards, and all auth **fail-closed** behind nginx Basic
Auth + TLS. The 2026-07-10 SSRF (F1) is **fixed**. The 2026-08-05 pass found three issues the
first pass missed, two of them capable of losing funds: a wallet-name collision that could
delete the wrong seed (F3), and the fact that **no backup in the toolkit contained a Fidelius
seed** (F4). A review of those fixes then turned up two more: a dead guard in the shared
secret-sync lib that sent the local node's foreign secret to public nodes (F8), and a modal
that swallowed its own validation errors (F9). **055 is an unimplemented placeholder** with a sound non-custodial design; the
051x client stores no keys in the browser.

---

## Trust model (051)
The Node process binds `127.0.0.1:7420` and has **no in-process authentication** — the entire
auth boundary is nginx Basic Auth ([051_…sh:679-680](../../scripts/051_grin_fidelius.sh)),
which fail-closes (nginx errors without the htpasswd file). Anyone who passes Basic Auth
controls **every** registered wallet (connect/unlock, send, view seed). This is acceptable for
a single-operator private wallet, but it means the Basic Auth credential + TLS are the whole
game — there is no per-wallet authorization tier.

---

## Findings

### F1 — [Low] Authenticated SSRF via `/api/node/ping` — **FIXED 2026-08-05**
- **Was:** [server.js](../../web/051_fidelius/server.js) took `req.query.url`, validated only
  `^https?://`, then `fetch(url + '/v2/foreign', …)`. A `GET`, so the Origin guard
  (POST/PUT/DELETE/PATCH only) never covered it.
- **Impact:** an authenticated user could make the server POST to arbitrary hosts/ports —
  internal services, `169.254.169.254`, port-scan by latency.
- **Fix:** `nodePingAllowed()` now gates the target to the curated `MAINNET_NODES` /
  `TESTNET_NODES` lists, loopback, and hosts the operator has already assigned to a wallet in
  the registry (those went through `NODE_URL_RE` at write-config time). Everything else gets
  403 + a `PING_REJECTED` log line before any outbound request.
- **Regression note:** those two server lists are ALSO the client's node picker
  (`PUBLIC_NODES` in `app.js`). They were out of sync — the client offered `api.onlygrins.com`
  and `testapi.onlygrins.com`, which the server didn't know. Both lists now match, and the
  server-side comment says so. **Adding a node to one list without the other now makes it ping
  as unreachable**, not just look untidy.

### F3 — [High] Wallet name collision could delete the wrong seed — **FIXED 2026-08-05**
- **Was:** every route is `/api/wallet/:name/…` and `findWallet()` resolved by **name alone**,
  but registration only enforced uniqueness per `(name, network)`. So a mainnet *and* a
  testnet wallet could both be called `savings`.
- **Impact:** with a collision, `findWallet('savings')` silently returns whichever entry is
  first in `wallets_info.json`. The second wallet is unreachable from the UI, and — because
  `sessions` is keyed by name too — unlocking, sending, and **`DELETE /api/wallet/savings?files=1`**
  all act on the *first* wallet. Clicking Delete on the testnet row destroys the mainnet seed.
  Not remotely triggerable (the operator has to create the collision), which is why it's High
  and not Critical.
- **Fix:** registration goes through one `nameTaken()` helper used by **both** `write-config`
  and `import`, rejecting a name already used on either network and suggesting a `-main`/`-test`
  suffix. `duplicateWalletNames()` detects a pre-existing collision from an older registry:
  logged as `DUPLICATE_WALLET_NAMES` at startup, returned per-row as `duplicateName` from
  `/api/wallets`, rendered as a red `⚠` on the sidebar row (`.wallet-dup`, with the "rename one
  side" hint in its tooltip), and printed by 051's status screen.
- **Residual:** an operator who already has a collision must rename one side by hand (registry
  entry + its directory). The server refuses to guess which one you meant.

### F4 — [High] Fidelius seeds were in no backup at all — **FIXED 2026-08-05**
- **Was:** `089_backup_restore.sh` discovers wallet dirs by reading
  `/opt/grin/conf/grin_wallets_location.conf`. Only `05_grin_wallet_service.sh` and
  `051x_grin_xp_wallet.sh` ever write that file. Fidelius registers wallets in its own
  `wallets_info.json` and nowhere else, so **every archive ever taken excluded every Fidelius
  seed** — while the operator was told "wallet dirs contain seed files" and answered Y.
- **Impact:** total, silent loss of funds on VPS failure or migration. Worst kind of backup
  bug: it reports success.
- **Fix:** 089 Step 5d detects `/opt/grin/fidelius/` **live** (glob of `wallet_<net>_*` plus
  the registry), not from a config file — Fidelius creates wallets from its web UI at any
  time, so a conf written at install time would go stale on the operator's next wallet. The
  restore side stops `grin-fidelius`, restores the tree, re-asserts 700 on wallet dirs and
  600 on the registry + API secrets, and restarts only if it had been running. `app/`,
  `node_modules/` and the `grin-wallet` binary are deliberately excluded (re-deployed by 051
  steps 1 and 3).
- **Ownership note:** the restore keeps `/opt/grin/fidelius` **root-owned**, unlike
  `/opt/grin/wallet` which is chowned to `grin`. server.js runs as root (design D6); chowning
  would lock the Node process out of its own wallets.

### F5 — [Medium] Passphrase survived a closed browser tab — **FIXED 2026-08-05**
- **Was:** `app.js` auto-locks on real user-input idle (`mousemove`/`keydown`/…, configurable
  in Setup) — the correct signal, and it matches the pool's rule that idle is measured on
  interaction, never on request traffic. But it only runs **while a tab is open**. Close the
  browser and nothing ever fires; the passphrase sat in the Node process until systemd
  restarted it.
- **Fix:** a server-side backstop (`WW_IDLE_LOCK_MINUTES`, default 60, 0 disables) written
  into `wallet.env`. It applies the same principle server-side: only deliberate actions
  (any non-GET on `/api/wallet/*`, plus GET of `txs`/`outputs`/`accounts`/`payment-proof`)
  count as activity. The pollers — `/api/wallets`, `/api/wallet/:name/status`, `/api/node/*`,
  `/api/price`, `/api/portfolio` — deliberately do **not**, or a forgotten open tab would renew
  the session forever, which is the exact failure this exists to catch.
- **Expiry zeroes the passphrase only.** Listener/owner child processes keep running, so
  inbound receiving survives an auto-lock; spending requires a re-unlock.

### F6 — [Medium] `script-src 'unsafe-inline'` on a wallet UI — **FIXED 2026-08-05**
- **Was:** the nginx CSP shipped `script-src 'self' 'unsafe-inline'` to permit one `<head>`
  theme-bootstrap script. On a UI that can display a seed phrase, that keyword is what turns
  any HTML-injection bug into seed theft.
- **Fix:** the bootstrap moved to `client/theme-boot.js`, and the two `onclick="…"` attributes
  in slatepack copy buttons became a `wireCopyButton()` helper. `script-src` is now `'self'`
  with nothing else. `style-src` keeps `'unsafe-inline'` (the UI uses `style=""` attributes) —
  a CSS injection cannot execute script, so the risk is not comparable.
- **Do not re-add the keyword.** If a new inline handler appears, wire it after render instead.

### F7 — [Low] Basic Auth had no brute-force cost — **FIXED 2026-08-05**
- **Was:** Basic Auth is the entire auth boundary and nginx never rate-limits 401s, so the
  credential was unlimited-guess from the internet. Flagged as a TODO in the original port
  design and never done.
- **Fix:** 051 step 7 installs `/etc/fail2ban/jail.d/grin-fidelius.conf` — stock
  `nginx-http-auth` (5 fails / 10 min → 1 h ban) and `nginx-limit-req` filters against
  Fidelius's own error log. Its own jail file and logpath, so it never collides with Script
  02's `nginx-grin.conf`. The log files are touched first: fail2ban refuses to start on a
  missing logpath, and nginx only creates them on the first request.

### F8 — [Medium] Node-secret self-heal leaked a local secret to remote nodes — **FIXED 2026-08-05**
Found while reviewing the F-series fixes, in the shared lib 051 was newly wired into.
- **Was:** `lib/grin_node_secrets.sh` → `grin_sync_wallets()` guards "don't hand a local secret
  to a wallet that talks to a remote node" by grepping `^\s*node_api_http_addr\s*=`. The key in
  `grin-wallet.toml` is **`check_node_api_http_addr`** — the anchored pattern never matched it,
  so the guard was dead code and *every* wallet looked local.
- **Impact:** the 5-min timer stamped the local node's `.foreign_api_secret` path into wallets
  configured against a **public** node, and grin-wallet then sends that secret as Basic Auth to
  that third-party host on every balance refresh. Fidelius is the sharpest case because a
  curated public node is its *default*, but the lib is shared — 059, 05 and the pool wallets ran
  the same code. Live on any box that ran Script 01/04/05/06 (they install the same timer), so
  this predates the 051 wiring rather than being caused by it.
- **Fix:** match `(check_)?node_api_http_addr`, and treat "no address key at all" as *skip*
  rather than *assume local* — the cost of guessing wrong is a secret leaving the box. A wallet
  that already carries a stale local `node_api_secret_path` while pointing at a remote node is
  **reported, not auto-edited** (a `WARN` line into the timer's journal): blanking it is a config
  change the operator did not ask for.
- **Operator check:** `grep -l 'node_api_secret_path *= *"/' /opt/grin/*/*/grin-wallet.toml` and
  compare each hit's `check_node_api_http_addr`. If it is not 127.0.0.1/localhost, blank the
  secret path and rotate with `grin-secret-sync --rotate <net>` (needs a node restart).

### F9 — [Low] Modal validation errors closed the dialog instead of showing — **FIXED 2026-08-05**
- **Was:** `showModal()`'s action handler did `try { … } catch { close({error}) }`. Every
  validating `onClick` in `app.js` writes an inline error then **throws** to stop the close — so
  the message flashed and vanished. Clicking "Reveal" with an empty passphrase resolved with
  `{error:'nopass'}`, which the caller's `!r.pass` guard dropped: **the button did nothing at
  all, silently.** Import and Export shared the bug and sent `undefined` to the server instead.
- **Fix:** a throw now keeps the modal open, so the inline message the handler just wrote is the
  visible result. Cancel and the backdrop still resolve `null`, so there is always a way out.
  Nothing reads the old `{error}` shape (grep-verified).

### F2 — [Info] Wallet family security model & confirmations
- **All auth via nginx** (above) — never expose `:7420` directly, and never deploy without the
  htpasswd step. The installer's fail-closed nginx is the safeguard.
- **The public WASM wallet is not implemented.** Its intended model — client-side WASM crypto,
  keys never leaving the browser, wallet data in IndexedDB under AES-GCM/PBKDF2, server serves
  static files only ([script05_design.md PART A](script05_design.md)) — is the correct
  non-custodial design. **When built, audit:** the WASM/JS supply chain (SRI/pinning), the
  PBKDF2 iteration count, and XSS on the static host (an XSS = seed theft in a browser wallet).
- **051x XP client** stores no seed/key/passphrase in `localStorage`/`sessionStorage`/`IndexedDB`
  (grep-verified) — it drives the 051 backend rather than holding keys.

---

## Controls that are correct (no action)
- **Passphrase hygiene:** kept in memory only (no `.wallet_pass` on disk); passed to
  `grin-wallet` via **stdin, never argv** — so it can't leak through `ps`; cleared on failed
  connect and on idle expiry.
- **Reveal-seed** (added 2026-08-05) is passphrase-gated, shares the 5/min connect limiter, and
  opens the wallet with the **typed** passphrase as an `open_wallet` override rather than the
  session's — so an idle-locked wallet can still be recovered, and the session is not a
  prerequisite for proving ownership. Client-side it renders on a 60 s countdown and blanks
  `modalBody` on close: the threat there is a shoulder-surfer or an unattended screen, not the
  network (nginx already provides TLS + Basic Auth).
- **DNS-rebinding + CSRF guard:** strict Host allowlist on every request and Origin/Referer
  check on all state-changing methods.
- **Path traversal:** every client-supplied `dir` is asserted inside `WEBWALLET_ROOT`
  (`_isInsideRoot`); wallet names are `^[a-zA-Z0-9\-_]+$`.
- **Send safety:** amount validated `> 0`; destination validated against the bech32 address
  regex **and** network-matched (rejects sending from a mainnet wallet to a `tgrin1…` and
  vice-versa); slatepack input capped at 16 KB with format check.
- **Owner API v3 ECDH/AES-256-GCM** implemented correctly (random 12-byte nonce, GCM tag verified).
- **Transport & limits:** `trust proxy` loopback, `express.json` 32 KB, registry `0600`, wallet
  dirs `0700`, per-IP+wallet connect rate limit (5/min) shared by connect/show-seed/export/delete
  so an attacker can't farm a fresh allowance per endpoint, nginx TLS + `server_tokens off` +
  `client_max_body_size 1m`.

---

## Open / accepted
1. **Reboot leaves every wallet locked and its listener dead** — passphrases are memory-only by
   design, so inbound receiving stops silently after `systemctl restart` until a human unlocks.
   Correct security trade-off, but nothing tells the operator. Wanted: a banner when a
   registered wallet has no live listener, and optionally an off-box alert (082's pattern).
2. **Client-side auto-lock calls `/disconnect`**, which kills the listener and owner children —
   so a client auto-lock also stops inbound receiving, while the new server-side backstop does
   not. Worth aligning: zero the passphrase, leave the children.
3. **Transaction notes are browser-local** (`localStorage`), unlike the address book which is a
   server-side sidecar. They vanish on a new device and are in no backup.
4. **No Nostr / Transporter (093) transport** — see the design doc's follow-ups.
5. **051x (XP client) still ships `script-src 'self' 'unsafe-inline'`.** F6 tightened Fidelius
   only; `051x_grin_xp_wallet.sh` writes its own vhost (own domain, two CSP headers at ~496 and
   ~618) and its client genuinely needs the keyword today — inline `<script>` in both
   `public_html/index.html` and `xp_shell/index.html`, plus `onclick=` in `grin-wallet-client.js`.
   It drives the **same backend**, so an XSS there can spend. Same fix shape as F6 (extract the
   inline blocks, wire handlers after render); not attempted here because it is a rewrite of that
   client, not a two-line move.
6. **A reorg can renew the server-side idle timer.** `refreshHistory()` — a GET that counts as
   activity — is also called from the 60 s balance poller when a reorg is detected while the
   History tab is open. It only fires during a reorg, and it needs an open tab, where the
   client's own auto-lock is the governing control; left as-is rather than complicating the
   classifier.
7. **`WW_IDLE_LOCK_MINUTES` is rewritten to the default on every 051 step 3.** `ww_save_env`
   regenerates `wallet.env` wholesale, so a hand-edit is lost on redeploy (true of every key in
   that file, not just this one). Export it in the shell before running step 3 to pin a value.

## Priority for the operator
1. **Take a fresh 089 backup.** Any archive made before 2026-08-05 contains **no Fidelius
   seed** (F4) — do not treat old archives as wallet backups.
2. **Check for a name collision** before upgrading: `grep -o '"name": *"[^"]*"'
   /opt/grin/fidelius/wallets_info.json | sort | uniq -d`. Rename one side if it returns
   anything (F3).
3. Re-run 051 steps 3, 4 and 7 to pick up the secret-sync timer, the tightened CSP, and the
   fail2ban jail.
4. Never expose `:7420` directly; always front with the installer's nginx Basic Auth + TLS.
5. Re-audit 055 when it's actually built (browser-wallet XSS = key theft).
