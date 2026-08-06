# Script 051 — Fidelius: Grin Transporter integration

**Status:** built 2026-08-06, **NOT VPS-tested.** Verified locally against a live
Transporter (121 assertions, all passing) with a stubbed wallet.
**Depends on:** Script 093 Grin Transporter ≥ v0.2.1.

---

## What this adds

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

## Files

| File | Change |
|---|---|
| `web/051_fidelius/transporter.js` | **new** — protocol client (auth, deposit, list, delete, `send`, `poll`) |
| `web/051_fidelius/server.js` | config storage, 5 routes, background poller, `markAddressProven` |
| `web/051_fidelius/client/index.html` | Send panel, Receive inbox, Setup section |
| `web/051_fidelius/client/app.js` | wiring for all three surfaces |
| `web/051_fidelius/client/style.css` | `.checkbox-row` |
| `scripts/051_grin_fidelius.sh` | deploy now globs `*.js` (see *Deploy* below) |

## Why not `web/093_transporter/client/agent.js`

The standalone agent needs `wallet_pass_file` — a passphrase on disk. Fidelius
keeps the passphrase **in process memory only** and has no `.wallet_pass`
fallback; that is its central security property. Shipping the agent alongside it
would have required undoing that. The agent's *logic* is ported into
`transporter.js` instead, which takes a caller-supplied `call(method, params)`
closure bound to the session `server.js` already holds. The module never sees a
passphrase, the registry, or an HTTP route, so it is testable without a wallet.

Secondary reason: Fidelius is multi-wallet; the agent is one-config-per-wallet.

---

## The four protocol deltas (all deliberate, all load-bearing)

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

---

## Design decisions

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

---

## API

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

---

## Deploy — one real break, fixed

`ww_deploy_app()` used to enumerate files:

```bash
cp -r "$WW_SRC_DIR/server.js" "$WW_SRC_DIR/package.json" "$WW_SRC_DIR/client" ...
```

`transporter.js` would never have reached the VPS, and the failure surfaces only
at service start as a bare `MODULE_NOT_FOUND`. It now globs `"$WW_SRC_DIR"/*.js`,
which also covers the next module. The glob still excludes `client/` and any
`node_modules`.

---

## Testing with two wallets

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

---

## Verification performed

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

## Review pass (same day, post-build)

A full re-read of the delivered code found four defects. All are fixed above; they
are recorded because each is a class of mistake, not a one-off.

1. **The first-send safety net was built but never connected.** `testPassed` and
   `markAddressProven()` were written specifically to feed the Tor panel's
   test-send warning, and then the Transporter form was shipped without that
   warning — so the flag had no consumer on the rail it was added for. Building
   half of a guard is worse than building none: the design doc claimed a
   protection the UI did not have.
2. **The network badge disagreed with the other two Send panels.**
   `refreshSendTspAvailability()` overwrote the `send-method-net` badge that
   `selectWallet()` paints, replacing `TESTNET` with an unstyled lowercase
   `testnet` and dropping the colour class. Three panels on one screen must not
   disagree about which chain is about to be spent from.
3. **`findAddrEntry()` was case-sensitive** while the two Send forms normalise
   the address differently (Tor sends it as typed, Transporter lowercases). The
   same address could read as proven on one rail and unknown on the other.
4. **The relay's TTL was printed as a raw ISO instant.** A misread expiry is a
   user re-sending a payment that had not actually expired, so it is now trimmed
   to minutes and explicitly labelled UTC.

Confirmed *not* problems, having been checked: the idle backstop's
`IDLE_GET_ACTIONS` regex does not match `…/transporter/status`, so the 10-second
inbox poll cannot renew a session (the manual **Check Now**, a POST, correctly
does); `showModal` assigns button labels with `textContent`, so the unescaped
amount in a label is not an injection point; the nginx CSP (`connect-src 'self'`,
`script-src 'self'`) needs no change and no inline handler was added.

## Open / not done

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
