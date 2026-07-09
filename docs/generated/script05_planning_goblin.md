# Script 05 — Goblin interop planning: Grin Drop (052) ↔ Goblin usernames

**Status:** Research complete (2026-07-09), no code yet. Feature: a Drop visitor enters a
Goblin username (`bob` / `bob@goblin.st` / npub) and (a) **claims** the giveaway straight into
their Goblin wallet, or (b) **donates** to the Drop from their Goblin wallet — no slatepack
copy-paste on either side.

**Verdict: FEASIBLE with standard tooling.** All protocol layers were verified against the
goblin Rust source (`github.com/2ro/goblin`, master @ 2026-07-08) + docs.floonet.dev +
docs.goblin.st. No custom cryptography is needed on our side: the whole stack is standard
Nostr NIPs (05/17/44v2/59) that `nostr-tools` already implements in Node, plus the grin-wallet
Owner/Foreign API calls **Drop already makes today**. The only new component is one transport
module ("Goblin bridge") inside Drop's existing Node backend.

---

## 1. What already exists in the toolkit (reuse map)

Drop's `web/052_drop/server/` already implements **every wallet-side step** of both flows:

| Piece | Where | Notes |
|---|---|---|
| Owner API v3 ECDH session + encrypted calls | `wallet.js` (`ownerApiSession`, `encryptedOwnerCall`) | reuse as-is |
| Foreign API `receive_tx` | `wallet.js` (`foreignApiCall`) | reuse as-is |
| Claim send: `init_send_tx` → `create_slatepack_message` | `app.js` `/api/claim` (~line 401) | already emits **unencrypted armor, `recipients: []`** — exactly what Goblin expects (see §3.4) |
| Claim finalize: `slate_from_slatepack_message` → `tx_lock_outputs` → `finalize_tx` → `post_tx` | `app.js` `/api/finalize` (~line 536) | the S2-consumption path the bridge will call internally |
| Donate receive: `slate_from_slatepack_message` → Foreign `receive_tx` → `create_slatepack_message` (S2) | `app.js` `/api/donate/receive` (~line 634) | the S1-consumption path the bridge will call internally |
| Claim/donation state machine + expiry | `db.js` (SQLite), `slatepack_expire_min`, `wallet_cleanup_hours` auto-`cancel_tx` | needs a **separate, longer window** for Nostr claims (§5.3) |
| Config plumbing | `config.js` DEFAULTS + admin panel `writeConfigKey` | add `goblin_*` keys; no goblin/nostr keys exist today |
| nginx vhost per net | `052_lib_nginx.sh` | serves Drop's own NIP-05 `/.well-known/nostr.json` as a static file (§4.3) |

**What does NOT exist anywhere in the repo:** any Nostr client code (grep for `nostr|nip44|1059`
comes up empty outside docs). The bridge is genuinely new — but it is transport only.

Related planning: `docs/generated/script09_design.md` — 091 Transporter is **not** usable here
(Goblin doesn't speak it); 092 (Floonet relay deployer) is **optional** infrastructure for this
feature, not a dependency (§4.4).

---

## 2. Protocol facts — verified against goblin source

Every claim below cites the file in `2ro/goblin` `src/nostr/` (fetched 2026-07-09, cached in
scratchpad `goblin_src/`).

### 2.1 Message format (`protocol.rs`)

A Goblin payment message is a **NIP-17 private DM**: kind-14 rumor → NIP-44-encrypted kind-13
seal (signed by sender) → NIP-44-encrypted kind-1059 gift wrap (signed by a one-time ephemeral
key, `p`-tagged to the recipient, `created_at` fuzzed up to 2 days into the past).

Rumor **content** (exact layout, `build_payment_content`):

```
[Goblin] GRIN payment message — open in Goblin (https://goblin.st) to process.
<blank line>
BEGINSLATEPACK. ... ENDSLATEPACK.
```

Rumor **tags** (`build_rumor_tags`):
- `["goblin", "1"]` — protocol version marker
- `["subject", "<note ≤256 chars>"]` — optional human note (this is where a "Grin Drop claim"
  label can go)
- `["p", "<recipient pubkey hex>"]` — first tag, standard NIP-17 shape

**Parsing is tolerant and tag-distrusting** — classification "NEVER trusts tags — only the
parsed slate". `extract_slatepack` regex-extracts exactly ONE `BEGINSLATEPACK. … ENDSLATEPACK.`
block from the content (two blocks / none / oversized → rejected). So interop hinges on the
armor being valid, not on matching the preamble byte-for-byte. Still: **mirror the exact
content layout + tags** so other NIP-17 clients render it nicely and future goblin versions
keep accepting us.

Size caps (reject above): wrap content 64 KB, rumor content 32 KB, slatepack 30 KB, note 256
chars.

Control message: rumor with NO slatepack + tag `["goblin-action", "void", "<slate_id>"]` —
cancels an unpaid request. (Drop can send this to void an expired claim; optional.)

### 2.2 Encryption — the "NIP-44 v3" question is RESOLVED (`wrapv3.rs`)

"v3" is **Goblin's own negotiated extension** of NIP-44 (context-bound ciphertexts), **never
required**:

- A sender uses v3 **only if** the recipient's kind-10050 event carries an `encryption` tag
  containing the token `nip44_v3`. **No tag / no 10050 = v2.**
- Goblin's unwrap dispatches on the payload version byte: `0x02` → standard nostr-sdk NIP-44 v2
  path. Doc comment: *"a v2-only peer is completely unaffected."*

**Consequence for the bridge:** operate entirely on **standard NIP-44 v2 + NIP-59** —
`nostr-tools` (`nip44.ts`, `nip59.ts`, `nip17.ts`) implements all of it. Drop's own 10050 simply
advertises **no** `encryption` tag → Goblin senders automatically fall back to v2 when writing
to us. We never need to implement v3.

### 2.3 Ingest policy — what Goblin does with our message (`ingest.rs`)

| Incoming slate state | Default behavior |
|---|---|
| **Standard1** (our claim payout) | **AutoReceive** — wallet signs and replies S2 automatically under the default `AcceptPolicy::Everyone`. Stricter policies (`Contacts`/`Ask`) surface it for a tap instead. Zero-amount and duplicate slate IDs are dropped. |
| **Standard2** (their reply) | finalized only when it matches a pending send **AND the seal-verified sender pubkey == the stored counterparty npub** |
| **Invoice1** (a request for them to pay) | surfaced for explicit approval — **never auto-paid**; droppable via opt-out |

Two hard interop rules fall out of the S2 binding:
1. **Drop must send the claim FROM the same Nostr key it listens on** — Goblin replies S2 to
   the seal-verified sender pubkey; the reply gift wrap is `p`-tagged to *our* key.
2. **Goblin expires pending transactions after 24 h by default** (`expiry_secs`, client.rs) —
   its side cancels and reclaims outputs after that. Drop's claim window should be ≤ 24 h.

### 2.4 The slatepack inside the DM is PLAIN armor (`wallet.rs` ~line 1820)

Goblin builds it with `create_slatepack_message(m, &slate, Some(0), vec![])` — **empty
recipients = unencrypted armored slatepack**; confidentiality comes from the NIP-44 DM layers,
not from slatepack encryption. It parses incoming armor with stock grin-wallet
`parse_slatepack`.

This means **Drop's existing call is already byte-compatible** (`app.js` uses
`recipients: []` too). Difference: Goblin passes `sender_index: Some(0)` (embeds its slatepack
address as armor sender), Drop passes `null` (deliberately, to suppress Tor auto-respond).
Goblin's classification only reads the parsed slate, so `null` remains fine — and keeps the
existing KernelSumMismatch guard intact. No change to the wallet-side calls at all.

### 2.5 Relay topology (`relays.rs`, `pool.rs`, `client.rs`)

- Default relay set (Tor-friendly, probe-vetted): **`wss://relay.floonet.dev`** (the pinned
  "shared relay floor"), `wss://relay.0xchat.com`, `wss://offchain.pub`.
- Every Goblin wallet's inbox subscription (`{kinds:[1059], "#p":[them]}`) **always includes
  relay.floonet.dev**, and every Goblin send always unions its own advertised set (which pins
  relay.floonet.dev first) into the publish targets. Doc comment calls this "MONEY-PATH
  SAFETY".
- Send targets = recipient's kind-10050 relay list (≤ 3, fetched from own relays + discovery
  indexers, cached per contact) + nprofile hints + sender's own set.
- Catch-up on reconnect: fetch gift wraps `since last_connected - 3 days` (`LOOKBACK_SECS = 3 *
  86400`) — the fuzzed `created_at` (up to −2 d) is why the lookback is generous. **The bridge
  must do the same** (subscribe/fetch with `since ≈ now − 3 d`, dedup by event id).
- Publish confirmation: goblin read-backs the event id from the relay for ≤ 30 s
  (`CONFIRM_TIMEOUT`); unconfirmed = "sent-pending", never re-dispatched (duplicate-slate
  protection). Mirror this state model.
- Relays are plain public Nostr relays over `wss://` — Goblin reaches them via Tor, but Tor is
  a client choice, **not** a server requirement. A clearnet Node service can talk to the same
  relays directly. Floonet relay event-kind whitelist (docs.floonet.dev): 0, 3, 5, 13, 1059,
  10002, 10050 — everything the bridge publishes (1059, 10050, 10002, optional 0) is allowed.

### 2.6 Username resolution (`nip05.rs`)

- Standard **NIP-05**: `GET https://<domain>/.well-known/nostr.json?name=<name>` → pubkey +
  optional relay hints. Bare `bob` or `@bob` resolves against the home domain, default
  **goblin.st** (configurable "name authority" for federation).
- Reverse lookup exists: `GET https://<domain>/api/v1/by-pubkey/<hex>` → current name
  (goblin.st API, used for display).
- Hostname validation matters (path-smuggling guard) — the bridge should validate the domain
  the same way before building the well-known URL.
- `nostr-tools` `nip05.queryProfile()` covers the forward lookup.

### 2.7 Node-side library check

`nostr-tools` (nbd-wtf, TS/JS): NIP-44 v2 ✅ (`nip44.ts`), NIP-59 gift wrap ✅ (`nip59.ts`),
NIP-17 ✅ (`nip17.ts`), NIP-05 ✅ (`nip05.ts`), `SimplePool` works in Node with the `ws`
package (`useWebSocketImplementation`). Two new npm deps total: `nostr-tools`, `ws`.

---

## 3. The two flows

### 3.1 Claim → Goblin username (Drop = sender, SRS)

```
 CLAIMANT (browser)          DROP BACKEND + BRIDGE                     NOSTR RELAYS              CLAIMANT'S GOBLIN WALLET
 ───────────────────         ─────────────────────                    ────────────              ────────────────────────
 1. enters "bob" or
    bob@goblin.st or npub ─► 2. NIP-05 resolve → npub
                                (nostr-tools nip05 / direct npub)
                             3. fetch bob's kind-10050 DM relays
                                (from our relays + discovery)
                             4. init_send_tx → tx_lock_outputs        (existing app.js code)
                             5. create_slatepack_message S1
                                (recipients:[], sender_index:null)
                             6. build kind-14 rumor
                                (preamble + armor, goblin/subject tags)
                                seal (v2) + gift wrap (v2)
                             7. publish ────────────────────────────► bob's 10050 relays
                                confirm read-back ≤30 s                + relay.floonet.dev        (bob offline OK — relay stores)
                             8. claim status: awaiting_reply                                  ─► 9. wallet comes online,
                                                                                                   catch-up fetch, unwrap,
                                                                                                   AutoReceive → signs S2
                            11. gift wrap addressed to OUR npub ◄──── 10. wraps S2, publishes to
                                (persistent subscription                  our 10050 relays
                                {kinds:[1059], #p:[drop_npub]})
                            12. verify seal-sender == claim's npub
                                slate_from_slatepack → tx_lock_outputs
                                → finalize_tx → post_tx               (existing /api/finalize path)
                            13. claim status: completed  ──────────►  UI shows "sent to your Goblin wallet ✓"
```

The browser's role ends at step 1 — no slatepack ever shown. Steps 8–12 are asynchronous
(minutes to hours); the claim page can poll claim status exactly like today.

### 3.2 Donation ← Goblin user (Drop = receiver, SRS)

```
 DONOR'S GOBLIN WALLET                    NOSTR RELAYS            DROP BRIDGE + BACKEND
 ─────────────────────                    ────────────            ─────────────────────
 1. donor pays "drop@<dropdomain>"
    (or scans our nprofile QR)
 2. NIP-05 resolve via OUR nginx
    /.well-known/nostr.json
 3. S1 gift wrap ───────────────────────► our 10050 relays ─────► 4. subscription delivers wrap
                                                                  5. unwrap (v2), extract armor,
                                                                     parse → must be Standard1
                                                                  6. Foreign receive_tx           (existing /api/donate/receive path)
                                                                  7. create_slatepack S2, wrap,
 9. AutoIngest: S2 matches pending ◄───── 8. publish to donor's      publish
    send → finalize_tx → post_tx             10050 + shared floor
10. donation on chain; Drop's balance-refresh sees it; record donation row
```

Note the symmetry: **one bridge module serves both flows** — it just feeds unwrapped armor into
the two existing endpoints' internals and wraps their existing outputs.

### 3.3 Donation invoices (optional phase)

Drop's existing `/api/donate/invoice` produces Invoice1 slatepacks. Sent over the bridge these
surface in Goblin as a payment request (**never auto-paid** — donor taps approve, replies I2,
Drop finalizes). Works protocol-wise; ship after the two core flows.

---

## 4. New component — the Goblin bridge (design sketch, no code)

### 4.1 Identity

- One **secp256k1 Nostr keypair per Drop instance** (per net), generated once, stored like the
  other secrets: `/opt/grin/drop-<net>/.nostr_key` (hex, chmod 600, `grin`-owned). This is a
  *transport* identity — totally separate from the wallet seed; compromise leaks metadata, not
  funds (it can't sign slates).
- On boot the bridge publishes (replaceable, so idempotent):
  - **kind 10050** DM relay list (≤ 3 relays, MUST include `wss://relay.floonet.dev`; **no
    `encryption` tag** → peers speak v2 to us),
  - kind 10002 (NIP-65) mirror,
  - optional kind 0 profile (name "Grin Drop @ <domain>", picture = drop logo URL).

### 4.2 Runtime (inside Drop's existing `app.js` process)

- `SimplePool` over `ws`: persistent subscription `{kinds:[1059], "#p":[our_pk]}` on our relay
  set; on (re)connect, catch-up fetch with `since = now − 3 d`; dedup by event id in a new
  SQLite table.
- Unwrap v2 → enforce rumor-author == seal-signer (nostr-tools nip59 does this) → size caps →
  `extract_slatepack` equivalent (single armor block) → parse via existing wallet calls →
  dispatch on slate state exactly like `ingest.rs` (§2.3), with Drop's own guards: S2 must
  match a pending Nostr claim row AND sender pubkey; S1 = donation (subject tag → donor note);
  everything else dropped + logged.
- Outbound: resolve → fetch recipient 10050 (10 s cap, fall back to our own set — goblin does
  the same) → publish to recipient relays ∪ ours → read-back confirm ≤ 30 s → mark
  awaiting_reply.
- New SQLite table (in the existing `/opt/grin/drop-<net>-data/` DB): nostr claim/donation
  meta — slate_id, direction, counterparty npub, event ids, status, timestamps. Mirrors
  goblin's `TxNostrMeta` state machine (Created → AwaitingS2 → Finalized / Cancelled /
  Expired).

### 4.3 Drop's own username (donations)

Serve NIP-05 from the Drop vhost — a **static `/.well-known/nostr.json`** written by
`052_lib_nginx.sh` (one heredoc + CORS `Access-Control-Allow-Origin: *`): maps e.g.
`drop@<dropdomain>` → the bridge pubkey. Donors then literally type `drop@grin.money`-style
names into Goblin. (Registering a name on goblin.st instead/additionally is possible but
involves their paid-registration flow — self-hosting the NIP-05 file is free, instant, and
pure toolkit-style nginx work.)

### 4.4 Relation to Script 09

- **091 Transporter: not involved.** Goblin clients can't poll it.
- **092 Floonet relay: optional composition, not a dependency.** Phase 1 rides
  `relay.floonet.dev` + public Tor-friendly relays. If the operator later deploys 092, the
  bridge's relay list (config key) simply gains `wss://relay.<owndomain>` — and the 092 bundled
  name authority could host the Drop's username too. Compose-when-present, same rule as
  GoblinPay×092 (script09_design.md PART C).

### 4.5 New config keys (DEFAULTS in `config.js`, admin-panel editable)

```
goblin_enabled            false     master switch (claim + donate UI fields hidden when off)
goblin_relays             [floonet.dev, 0xchat.com, offchain.pub]   our advertised set (≤3)
goblin_nip05_name         "drop"    username part served from our well-known
goblin_claim_expire_hours 12        Nostr-claim window (≤ goblin's 24 h peer expiry)
goblin_home_domain        "goblin.st"  default domain for bare usernames
```

---

## 5. Gaps, risks, gotchas (ranked)

1. **`wallet_cleanup_hours` conflict (must fix in phase 1).** Drop auto-cancels unfinalized
   wallet txs after 1 h. A Goblin claimant offline for 3 h would return a valid S2 to an
   already-cancelled tx → finalize fails (and goblin-side shows a stuck tx until their 24 h
   expiry). The cleanup sweep must skip slate IDs with an active Nostr-claim row younger than
   `goblin_claim_expire_hours`; on OUR expiry, `cancel_tx` + optionally send the
   `goblin-action: void` control message.
2. **Single-author protocol risk.** "goblin/1" tags exist, but the format is one active
   project, not a frozen NIP. Mitigations: tag-distrusting tolerant parsing on our side too;
   version-tolerant classification (parse the slate, not the preamble); keep manual slatepack
   claim as the always-available fallback rail; pin the verified format facts here + memory.
3. **Claim abuse surface changes.** Today a claim burns effort (paste slatepack in 30 min).
   With auto-delivery, one npub = one identity to rate-limit: extend the existing
   per-address/IP cooldown to per-npub, and consider requiring NIP-05-resolvable names (not
   bare npubs) for claims to raise the cost of identity-minting. Amounts are faucet-small;
   caps already exist (`global_daily_claims_cap` etc.).
4. **Relay availability/retention.** Public relays may drop events or throttle; gift wraps are
   ephemeral-ish (retention is the real TTL). Mitigations already in the design: publish to
   recipient set ∪ ours, shared floor pinned, read-back confirm, and the operator can deploy
   092 for a self-owned relay. Accept that delivery is best-effort — the claim row + re-send
   (same slate, new wrap) on "not picked up in N hours" covers the gap goblin covers with its
   sent-pending state.
5. **Testnet story is weak.** goblin.st usernames and Goblin builds target mainnet Grin;
   there's no public testnet Goblin userbase. Testnet validation = two of our own Nostr
   keypairs + a scripted "fake Goblin peer" (nostr-tools receive→S2 responder) rather than a
   real phone wallet. Real-device E2E test happens on mainnet with tiny amounts (Drop mainnet
   claim is 0.008 GRIN — perfect).
6. **Metadata privacy (accept + disclose).** The bridge's npub publicly accumulates
   `p`-tagged gift wraps (timing/count metadata) on public relays. Amounts/contents stay
   encrypted. Same trade-off Goblin itself makes; worth one line in the Drop UI/docs.
7. **`nostr-tools` gift-wrap timestamp fuzzing** — confirm its nip59 wrap fuzzes `created_at`
   (goblin tolerates ±, its lookback assumes up to 2 d); if it doesn't, set the tweak
   ourselves. Minor, verify at build time.

## 6. Recommended approach (build order, no code yet)

1. **Phase 0 — spike (½ day):** two Node scripts with `nostr-tools` against
   `relay.floonet.dev`: publish 10050s, exchange a v2 gift-wrapped kind-14 carrying a testnet
   slatepack string, confirm unwrap + armor extraction both ways. Proves the transport with
   zero Drop changes.
2. **Phase 1 — bridge module + claim flow (testnet):** `web/052_drop/server/goblin.js` +
   nostr meta table + config keys + claim-page username field; fake-Goblin responder script
   for E2E; fix the cleanup-sweep conflict (§5.1).
3. **Phase 2 — donations:** our NIP-05 well-known via `052_lib_nginx.sh`, donate-page "pay
   from Goblin" (shows `drop@domain` + nprofile QR via existing `qrcode` dep), S1-ingest path.
4. **Phase 3 — mainnet pilot** with a real Goblin phone wallet, tiny amounts; then optional
   extras: invoice-over-Nostr donations, void control messages, 092 composition.
5. **Where it lives:** all inside 052 (it's a Drop feature). If the bridge later proves useful
   to the pool (payouts to Goblin miners) — extract it into a shared lib under the Script 09
   umbrella then, not before. Update `project_comms_hub_09` A.9 #6 at that point: for
   **Goblin** recipients, relay receive-support is now CONFIRMED (this doc) — the open question
   remains only for stock grin-wallet/Grim/Ironbelly users.

---

*Sources: `2ro/goblin` src/nostr/{protocol,wrapv3,ingest,client,relays,pool,nip05}.rs +
src/wallet/wallet.rs (master, 2026-07-08); docs.floonet.dev; docs.goblin.st/features/payment-flow;
nbd-wtf/nostr-tools README; toolkit `web/052_drop/server/*` on branch add-ons.*
