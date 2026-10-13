# Script 051 — Fidelius: implementation

> **Covers code as of:** 2026-08-06 (the doc states "built 2026-08-06") · **Last verified:** never systematically verified
> **Product code last changed:** 2026-08-17 — `scripts/051*_*.sh`, `web/051_fidelius/`, `web/051_xp_wallet/`
> The doc's "121 assertions, all passing" is a test of the *code*, not a check of this document.
> **Scope:** the Grin Transporter rail as built, plus the Build notes for the whole product. The port plan is `script051_design.md`; findings are in `script051_security_audit.md`.

**Status:** built 2026-08-06, **NOT VPS-tested.** Verified locally against a live
Transporter (121 assertions, all passing) with a stubbed wallet.
**Depends on:** Script 093 Grin Transporter ≥ v0.2.1.

## What shipped

### What this adds

A third delivery rail in Fidelius, alongside the two that already existed:

| Rail | Both online? | Human copies a blob? | Recipient can be offline |
|---|---|---|---|
| Tor (`/send` method=tor) | **yes, required** | no | ✗ |
| Slatepack (`/send` method=slatepack) | no | **yes** | ✓ |
| **Transporter (new)** | no | **no** | ✓ |

The Transporter is a store-and-forward queue keyed by slatepack address. Fidelius
PUTs an encrypted slate into the payee's queue; the payee's wallet collects it
whenever it is next unlocked, replies into the sender's queue, and the sender
finalizes and broadcasts.

### Files

| File | Change |
|---|---|
| `web/051_fidelius/transporter.js` | **new** — protocol client (auth, deposit, list, delete, `send`, `poll`) |
| `web/051_fidelius/server.js` | config storage, 5 routes, background poller, `markAddressProven` |
| `web/051_fidelius/client/index.html` | Send panel, Receive inbox, Setup section |
| `web/051_fidelius/client/app.js` | wiring for all three surfaces |
| `web/051_fidelius/client/style.css` | `.checkbox-row` |
| `scripts/051_grin_fidelius.sh` | deploy now globs `*.js` (see *Deploy* below) |

### Why not `web/093_transporter/client/agent.js`

The standalone agent needs `wallet_pass_file` — a passphrase on disk. Fidelius
keeps the passphrase **in process memory only** and has no `.wallet_pass`
fallback; that is its central security property. Shipping the agent alongside it
would have required undoing that. The agent's *logic* is ported into
`transporter.js` instead, which takes a caller-supplied `call(method, params)`
closure bound to the session `server.js` already holds. The module never sees a
passphrase, the registry, or an HTTP route, so it is testable without a wallet.

Secondary reason: Fidelius is multi-wallet; the agent is one-config-per-wallet.

### The four protocol deltas (all deliberate, all load-bearing)

These are the differences between the Transporter path and Fidelius's own
copy-paste send. Each one silently loses money if it is "simplified" back.

**1. `sender_index: 0, recipients: [dest]`.**
Fidelius's manual send uses `sender_index: null, recipients: []`, producing an
**unencrypted** slatepack with **no sender field**. Over a public relay that is
wrong twice: the server can read the blob, and the payee's poll has nowhere to
send S2 back to. It would log *"S1 has no sender address"*, skip, and after 5
deliveries **reap the payment**. Regression-tested — the harness builds a
sender-less S1 and asserts it is skipped and never credited.

**2. Outputs lock at SEND, not at finalize.**
The manual flow locks late ([`server.js` `/finalize`](../../web/051_fidelius/server.js))
because a human is holding the slate. Here the reply may land days later and the
wallet must not re-select those inputs meanwhile. Order is `init → lock → armor →
deposit`, so a failed deposit still leaves a consistent, cancellable state.
**The existing `/finalize` is untouched** — two rails, two lock policies, on
purpose. The Transporter's own S2 branch re-locks inside a `try/catch` because a
second lock errors harmlessly on some builds.

**3. `payment_proof_recipient_address` is always `null`.**
A proof embeds our address in the slate, and newer wallets then auto-dial the
sender's Foreign API on receive, corrupting the context (`KernelSumMismatch` —
the same trap documented for Drop 059). The Send panel therefore offers **no**
proof field on this rail, unlike the Tor panel.

**4. Receiving requires the Foreign listener.**
`receive_tx` goes to `127.0.0.1:<foreignPort>`. Polling and decoding both work
without it, and then every incoming payment fails at the last step — the single
most confusing failure mode here, so the inbox reports it explicitly.

### Design decisions

**Polling is server-side but scoped to UNLOCKED wallets.**
Collecting a slate means decrypting it with the wallet key, so a locked wallet
could not act on the queue even if it fetched one. Tying the poller to the unlock
state gives the operator exactly one control for "is my wallet working for me
right now", and nothing runs after an idle auto-lock.

> The poller **never calls `touchSession()`**. The idle backstop deliberately
> measures deliberate actions, not request traffic; a self-renewing poller would
> keep a forgotten wallet unlocked forever — the exact failure it exists to catch.
> The manual **Check Now** button *does* touch the session, correctly: it is a
> deliberate action.

**Config is per network.** A Transporter instance is bound to one HRP
(`grin`/`tgrin`). A testnet wallet pointed at a mainnet relay does not error — it
deposits into a queue nobody polls. `checkEndpoint()` compares `/health.network`
against the wallet network and raises a **hard error**, both on the Setup "Test"
button and again inside every send.

**`.onion` URLs are rejected with the reason.** Node's fetch (undici) has no
SOCKS support, so an onion host can never be reached from this process. Saving
one cleanly and timing out forever is worse than refusing it.

**Trust model.** Slates are encrypted to the recipient's key and finalizing needs
our key, so a hostile relay cannot read or spend. It can (a) refuse to deliver and
(b) learn which address talks to which. It is an availability and metadata
dependency, not a custody one — which is why a wrong URL is an annoyance and a
wrong *network* is a hard error.

**The first-send test warning applies here too — and matters more.**
The Tor panel offers a 0.1 ∩ test send before any larger first payment to an
unknown address. The Transporter panel now runs the same gate, because the
failure it guards against is *worse* on this rail: a wrong-but-well-formed
address over Tor fails loudly (nothing answers at the other end), while over a
relay the deposit **succeeds** — it lands in a queue nobody owns, no error is
ever raised, and the only symptom is coins that stay reserved forever. The
wording differs from Tor's because the test send is not instant: it says to wait
for the test to *complete* before sending the rest.

Exactly one modal ever fires. The plain "coins are reserved" confirmation is the
`else` branch of the first-send gate, and the gate's own modal carries the same
reserve note, so the two can never stack.

**`testPassed` is not granted by a queued send.** That flag is what the gate
above reads. A Tor send earns it by broadcasting; a Transporter send has merely
been queued, and a wrong, abandoned or unpolled address looks identical at that
moment. So the send records the address with `proven=false`, and
`markAddressProven()` sets the flag later — when *their* reply comes back and
finalizes, the first hard evidence a real wallet is behind it. `findAddrEntry()`
was made case-insensitive at the same time: the Tor form submits the address as
typed while this one lowercases first, so one rail could otherwise report an
address as unknown that the other had already proven.

### API

| Route | Notes |
|---|---|
| `GET  /api/transporter/config` | per-network url + enabled, poll interval |
| `POST /api/transporter/config` | validates URL, clamps interval to 30 s–1 h, forces `enabled=false` when the URL is empty |
| `POST /api/transporter/test` | probes without saving; network mismatch → 502 |
| `GET  /api/wallet/:name/transporter/status` | configured / unlocked / ownerRunning / listenerRunning / lastPoll / lastError / depth |
| `POST /api/wallet/:name/transporter/send` | `{ amount, dest }`; 401 if locked, 409 if unconfigured |
| `POST /api/wallet/:name/transporter/poll` | one manual drain; returns counters + transcript |

Config lives under a `transporter` key in `wallets_info.json` (mode 600) rather
than a new file, so it inherits the same permissions and 089 backup coverage.

**No CSP change.** Every browser call is same-origin `/api/...`; the relay is
contacted server-side. `connect-src 'self'` stands — another reason the relay call
does not belong in the browser. No inline handlers were added.


## Runbook

### Testing with two wallets

1. Deploy a testnet Transporter (script 093) and note its HTTPS URL.
2. Fidelius → **Setup → Grin Transporter** → paste the URL under *Testnet* →
   **Test** (must report `testnet`) → tick auto-check → **Save**.
3. Create two testnet wallets, **A** and **B**. Names must be unique across both
   networks. Unlock both, and on each start **Owner API** *and* **Listener**.
4. On **B**: Receive tab → copy its slatepack address.
5. On **A**: Send tab → *Send via Transporter* → amount + B's address → confirm.
   Above 0.1 ∩ to an address A has never completed a payment to, the first-send
   modal appears — take the **0.1 ∩ test** the first time; it exercises the whole
   round trip for a trivial amount. A's balance shows the amount as locked.
   Nothing is on-chain yet.
6. On **B**: Receive tab → **Check Now** (or wait for the interval). B credits the
   payment and queues the reply.
7. On **A**: Receive tab → **Check Now**. A finalizes and broadcasts.
8. History on both, and B's balance after 10 confirmations.

If step 6 or 7 reports nothing: read the inbox banner first — it names the one
blocking condition (no relay / locked / Owner API down / listener down) rather
than making you guess.

### Verification performed

Local only; no VPS, no real grin-wallet.

- `fid_tsp.js` — **45 assertions.** Two mock wallets pay each other through the
  **real** 093 server: bech32 addresses, ed25519 challenge signing, bearer tokens,
  deposits, ordered reads, deletes. Covers the full S1→S2→finalize round trip,
  network-mismatch guards, exact `grinToNano` parsing, per-address token caching
  (two wallets sharing one client must not thrash it), 401 re-auth, junk reaping,
  the wallet-health guard that stops an outage eating real slates, sender-less S1
  rejection, delivery of a real payment behind 25 junk entries, and uppercase
  address normalisation.
- `fid_routes.js` — **29 assertions.** Boots the **real** Fidelius `server.js`
  next to the real relay: config defaults, URL validation (garbage / non-http /
  credentials / `.onion`), interval clamping, persistence into the registry
  without clobbering the wallet list, endpoint probing, 404s, CSRF-guard
  inheritance on the new routes, and a silent poller with zero wallets.
- `ui_check.js` — **47 assertions.** Static audit of the browser surfaces, added
  during the post-build review: HTML tag balance and duplicate ids, every element
  id the new JS touches, every `q()` lookup resolving to a real (or runtime-built)
  id, every CSS class the new markup uses, `.checkbox-row` actually out-specifying
  `.field label`, the pure helpers (`fmtUtc`, `tspAgo`, `findAddrEntry`), the
  first-send gate's wiring and its never-two-modals structure, the inbox's
  escalating single-condition order, no inline handlers, and every browser call
  being a relative `/api/` path (the `connect-src 'self'` contract).
- `bash -n` across 52 shell files; `node --check` on all Fidelius + 093 JS.

## Build notes — obstacles & lessons

Commit hashes are the bulk commits a change landed in (the repo has few fine-grained ones); `git log -S<symbol>` finds the exact line. The full pre-G7 text of this doc: `git log -- docs/reference/script051_implementation.md`, the commit before the G7 re-org (2026-10-13).

### Transporter rail

#### Deploy list enumerated files, so the new module never shipped
**Symptom:** service start fails with a bare `MODULE_NOT_FOUND` on the VPS only. **Cause:** `ww_deploy_app()` copied `server.js`, `package.json`, `client` by name; `transporter.js` was not on the list. **Fix:** copy `"$WW_SRC_DIR"/*.js` (still excludes `client/` and `node_modules`). **Lesson:** a hand-enumerated deploy list fails only at runtime on the target; glob the source dir.

#### The first-send safety net was built but never connected
**Symptom:** `testPassed` / `markAddressProven()` existed with no consumer on the rail they were added for; the design claimed a warning the UI did not show. **Cause:** the flag was written for the Tor panel's test-send gate, then the Transporter form shipped without the gate. **Fix:** the same gate on the Transporter panel, one modal only. **Lesson:** half a guard is worse than none — it documents a protection that is not there. Grep a new flag's readers before calling it done. Landed in 3fabc1e.

#### Two Send forms normalised the address differently
**Symptom:** the same address read as proven on the Tor rail and unknown on the Transporter rail. **Cause:** the Tor form submits as typed, the Transporter form lowercases first; `findAddrEntry()` was case-sensitive. **Fix:** case-insensitive lookup. **Lesson:** when two forms normalise differently, the shared lookup between them is the bug.

#### Network badge overwritten by a refresh helper
**Symptom:** `TESTNET` replaced by an unstyled lowercase `testnet`. **Cause:** `refreshSendTspAvailability()` rewrote the badge `selectWallet()` paints. **Fix:** stop overwriting it. **Lesson:** three panels on one screen must not disagree about which chain is about to be spent from.

#### Relay TTL printed as a raw ISO instant
**Symptom:** a user could misread an expiry and re-send a payment that had not expired. **Fix:** trimmed to minutes and labelled UTC. **Lesson:** a money-relevant timestamp is shown in one stated zone at human precision.

#### A wallet health probe must cover the half that failed
**Symptom:** real incoming payments were deleted after ~6 minutes. **Cause:** the poller reaped queue entries after 5 deliveries, guarded by an Owner-API probe; the S1 path fails at `receive_tx`, which needs the Foreign listener. Owner-up + listener-down is the normal state of an unlocked wallet nobody started the listener on, and the Owner API is necessarily up because the poll reached that line through it. **Fix:** probe both (`ownAddress` + foreign `check_version`). **Lesson:** a guard that is true whenever the code runs can never fail; probe the dependency that actually broke.

#### Lock outputs at send, not at finalize (manual rail too)
**Symptom:** a pending slatepack send was invisible in History, uncancellable, and its inputs stayed selectable. **Cause:** deferring the lock meant `init_send_tx` wrote no tx-log entry; a second send picked the same coins and produced two conflicting slatepacks. **Fix:** lock at send, matching `grin-wallet send` and the Transporter path; Recover releases an unanswered one. **Lesson:** reserve inputs when you hand out a slate, not when it comes back.

### Wallet identity, passphrase and recovery

#### Wallet names collided across networks
**Symptom:** a mainnet and a testnet `savings`: the second was unreachable, and `DELETE ?files=1` on the visible row destroyed the seed of the hidden one. **Cause:** every route is `/api/wallet/:name/…`, `findWallet()` and `sessions` key on name alone, but registration enforced uniqueness per `(name, network)`. **Fix:** one `nameTaken()` shared by `write-config` and `import`; `duplicateWalletNames()` reports legacy collisions at startup, in `/api/wallets` and on the status screen. **Lesson:** a uniqueness rule must be as wide as the routing key. Landed in 3fabc1e.

#### Recovery (`init -hr`) needs a PTY and asks phrase before password
**Symptom:** recover could never work; the command died before reading a byte. **Cause:** grin-wallet's `parse_init_args` calls `prompt_recovery_phrase()` before `prompt_password_confirm()`, and the phrase prompt (linefeed `Interface`) opens `/dev/tty`, not stdin; a plain `spawn()` under systemd has no controlling terminal. The code also had the order reversed. **Fix:** run recover under `script -qfec` with a prompt matcher (phrase → pass → pass); `init -h`, `listen` and `owner_api` use rpassword/stdin and stay plain. `script` (bsdutils / util-linux) is now a dependency. **Lesson:** read the CLI's prompt code before choosing a stdin channel. Landed in 17c0a8d.

#### grin-wallet is pinned, in two places
**Symptom (avoided):** every wallet stops unlocking after an unattended upgrade, with no local change to blame. **Cause:** passphrases go over stdin, which works only while grin-wallet pins rpassword 4.x; rpassword 7 reads `/dev/tty`. **Fix:** pin `v5.4.1` in `_WW_PIN_TAG` (script) and `GRIN_WALLET_PIN` (server.js); the two must agree. **Lesson:** do not chase `releases/latest` for a binary whose I/O contract you depend on. (The shared toolkit pin later moved to v5.5.0, where stdin still works; Fidelius stays on v5.4.1.)

#### A passphrase outlived a closed browser tab
**Symptom:** the wallet stayed unlocked with no tab open. **Cause:** auto-lock lived only in `app.js`. **Fix:** a server-side backstop `WW_IDLE_LOCK_MINUTES` (default 60) counting only deliberate actions, never the status/price pollers; it zeroes the passphrase but leaves the listener alive so receiving survives. The client auto-lock still calls `/disconnect` and kills the children — the two are not aligned. **Lesson:** idle means user action, never request traffic (same rule as the pool admin). Landed in 3fabc1e.

### Backup, secrets and the node

#### Fidelius seeds were in no backup
**Symptom:** every 089 archive taken before 2026-08-05 held zero Fidelius seeds yet printed "wallet dirs contain seed files". **Cause:** 089 discovers wallet dirs from `grin_wallets_location.conf`, which only the CMD wallet and the XP wallet write; Fidelius registers in its own `wallets_info.json`. **Fix:** a step that live-globs `/opt/grin/fidelius/wallet_<net>_*` (deliberately not a conf file — wallets are created from the web UI at any time, so install-time state goes stale); restore keeps `/opt/grin/fidelius` root-owned (server.js runs as root). **Lesson:** a backup that reports success while omitting a class of data is the worst bug in its category; discover by live state.

#### `grin_sync_wallets()` leaked a local node secret to public nodes
**Symptom:** wallets pointed at public nodes sent the local node's foreign secret as Basic Auth to a third party. **Cause:** the "skip remote nodes" guard grepped `node_api_http_addr`, but the toml key is `check_node_api_http_addr` (anchored, so it never matched); under `pipefail` the no-match `| head -1` also killed errexit callers at the first wallet, while the timer (no `set -e`) stamped the secret into every wallet. **Fix:** `grep -m1 … || true` (never `| head -1` in a `$()` under pipefail), both key spellings, "no address key → skip". A stale remote+local-secret combination is warned about, not auto-edited. **Lesson:** a guard that matches nothing fails open; test it against a real toml. Affects 059/05/07 too.

#### Switching a wallet to a public node left the local secret in place
**Symptom:** the write-path twin of the leak above. **Cause:** `POST /api/wallet/node` changed `check_node_api_http_addr` only, so `node_api_secret_path` kept pointing at the local secret. **Fix:** clear/replace the secret path together with the address. **Lesson:** fields that must change together are one write, not two.

#### Node status described the wrong wallet's node
**Symptom:** a testnet wallet on a public node showed `LOCAL NODE · SYNCED`, the mainnet node's peers, and the wrong chain in the sync banner. **Cause:** `/api/node/status`, `/peers` and `/sync-detail` resolved their node from `loadWallets()[0]`, never the open wallet; each endpoint looked right in isolation. **Fix:** one `resolveWalletNode(wallet)` and `?wallet=<name>` on all three. The registry `nodeUrl` and the toml's `check_node_api_http_addr` are two sources of truth that drift; the toml wins because the binary obeys it, and the disagreement is reported to the operator, never silently resolved. **Lesson:** when two widgets on one screen disagree, the user believes the pessimistic one; check what each resolves its subject from. Landed in 0ad5564.

#### "Local Node — not running" against a synced node
**Symptom:** the node page read offline against a healthy synced mainnet node while peers/sync-detail rendered. **Cause:** three probes called the removed v1 REST API (`GET /v1/status` → 404 on grin 5.x); proved by curl before editing. **Fix:** one `nodeRpc()` with `nodeOwnerRpc`/`nodeForeignRpc` and the `{"Ok":…}` unwrap in one place; a 401 is the one non-2xx that still proves a node is listening. **Trap in the fix:** returning `sync_status: null` for public nodes (honest — only `get_tip` is answerable) made `app.js` call `.toUpperCase()` on null, and that throw landed in the catch that paints "NODE UNREACHABLE" — the same symptom one layer up. **Lesson:** a server-side honesty fix needs its client null path checked in the same pass. Peers/sync-detail on a public node return `available:false` / `synced:null`, never an error or `false` (which fires the "syncing" banner forever).

#### `isLocal` was an unanchored substring match
**Symptom (avoided):** `https://localhost.example.com` counted as local and would have been sent the node's `.api_secret`. **Fix:** anchor to the scheme. **Lesson:** never decide "is this host mine" by substring; this is the second time the product nearly handed a local secret to a third party.

#### `/api/node/ping` was an authenticated SSRF
**Fix:** allowlist = the server's `MAINNET_NODES`/`TESTNET_NODES`, which must stay the same curated set as `PUBLIC_NODES` in `client/app.js` (they had drifted; a node added on one side pings as unreachable). **Lesson:** a list duplicated across client and server needs one owner or a check.

### Page security, logging and naming

#### `script-src 'unsafe-inline'` on a wallet UI
**Fix:** theme boot moved to `client/theme-boot.js` (loaded **without** `defer`, or the light-mode flash returns); two `onclick=` copy buttons became `wireCopyButton()`; the webfont CDN was dropped (it told Google when the operator opened their wallet), so the CSP is first-party only. **Lesson:** removing `'unsafe-inline'` is a code change, not a header change.

#### Service log: `copytruncate` is the only safe rotation
**Symptom (avoided):** the unit fails to start, or the rotated log stays empty forever. **Cause:** systemd `append:` creates the file but not the directory (setup `mkdir -p /opt/grin/logs`), and holds an open fd, so rename-and-create rotation leaves the daemon writing to the old inode (server.js has no USR2 reopen). **Fix:** 051 ships its own `/etc/logrotate.d/grin-fidelius` with `copytruncate` rather than joining Script 08's opt-in list (the same path in both files makes logrotate error "duplicate log entry"). `journalctl -u grin-fidelius` shows only start/stop/crash lines because `append:` redirects stdout away from the journal. **Lesson:** match the rotation method to how the daemon holds its log.

#### The rename was done before the first deploy, on purpose
`grin-web-wallet` → `grin-fidelius` and `/opt/grin/webwallet` → `/opt/grin/fidelius` happened before any VPS deploy — the only window where it is find-and-replace instead of a matched-key migration (stop and remove the old unit and vhost first, move the htpasswd, delete the old ratelimit conf before the new one: two `limit_req_zone` lines with one name is fatal). `/opt/grin/webwallet/` was never Fidelius-only: the XP wallet keeps `xp-mainnet/config.conf` there and was left alone. **Lesson:** rename before the first deploy or not at all. The hub's `_051_installed`/`_051_status` also probed PHP-era paths nothing had written since the Node port, so the row read "not installed" on every current deploy.

### Private access (WireGuard + DNS-01)

Architecture and the menu key are in the design doc; these are the traps. Landed in 56ea004.

#### `listen 10.9.0.1:443` with wg0 down stops all of nginx
**Symptom (avoided):** one failed bind takes every vhost on the box (explorer, pool, file server) offline. **Fix:** `net.ipv4.ip_nonlocal_bind=1` (load-bearing — it also survives a runtime `wg-quick down`) plus an `After=/Wants=wg-quick@wg0` nginx drop-in; `Wants`, never `Requires`. **Lesson:** a wallet change must not be able to break the explorer.

#### An HTTP-01 certificate stops renewing in private mode
**Symptom:** it renews fine the day you switch and fails silently ~60 days later. **Cause:** HTTP-01 answers on public port 80, which private mode removes. **Fix:** the switch hard-refuses an LE cert whose renewal conf is not `authenticator = dns-*`; a Cloudflare Origin cert is fine. **Lesson:** a failure with a 60-day fuse needs a gate at the moment of the change.

#### Never switch on a configured tunnel, only a proven one
**Fix:** gate on `gwa_handshake_seen` (non-zero `wg show latest-handshakes`); a conf file is not evidence. Automatic rollback: a vhost failing `nginx -t` is never left on disk, because the next unrelated `systemctl reload nginx` from any toolkit script would fail on it.

#### fail2ban must `ignoreip` the WireGuard subnet
**Symptom (avoided):** five mistyped passwords from the phone ban the only address that can still reach the wallet, and the unban needs the SSH session this design exists to avoid. **Cause:** after the switch `$remote_addr` is the operator's own tunnel address.

#### `certbot certonly --dns-*` never loads the nginx plugin
**Symptom:** `nginx -t` hard-fails on an `include` of a missing `ssl-dhparams.pem` / `options-ssl-nginx.conf`. **Fix:** both includes are existence-guarded via `_ww_le_ssl_extra()`, which the older `certonly --nginx` path was rerouted through too.

#### `${var//./\\.}` does not escape dots in bash
It returns the string unchanged, leaving every dot a regex wildcard; it bit twice (listener check, peer IP scan). Compare fields with exact-match `awk` instead of building a regex from an IP.

## Open items


1. **Never run against a real grin-wallet.** The wallet side is stubbed. The
   Owner API method names and shapes are taken from the working `agent.js`, but
   `decode_slatepack_message`'s `sender` field is the one thing worth confirming
   first on a testnet box.
2. **No pending-send surface, and `Recover` is now blunter than it was.**
   A queued payment with locked outputs shows up in **Wallet → Recover**
   (`/locked-outputs` → `cancel-tx`), which cancels **every** pending send in one
   action. Before this feature a "stuck pending send" was almost always genuinely
   stuck; now a pending send is the *normal* state for hours or days, so that
   button can un-queue a payment that was going to be delivered. The modal now
   says so explicitly, but the real fix is a per-tx Cancel — a "waiting for reply"
   list with an inline action is the obvious next UI step.
3. **No notification on arrival.** `maybeNotify` exists for balance changes and
   will fire on the credit, but there is no Transporter-specific notification.
4. **Sequential polling.** The auto-poller iterates wallets with `await`, so a
   hung wallet delays the others by up to its timeout. Fine at two wallets.
5. **`POST /api/transporter/test` will fetch any http(s) URL the operator
   types**, and surfaces up to 200 characters of the response on failure — a
   server-side request forgery primitive, deliberately left as-is. Anyone who can
   reach this route can already spend the wallet, so it grants no privilege they
   lack; constraining it would mean an allowlist that defeats the point of a
   user-supplied relay. Worth revisiting only if Fidelius ever gains a lower-
   privileged role.
6. **091/092 unaffected.** This touches 093 only.
