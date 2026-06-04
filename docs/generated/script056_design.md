# Script 056 — Grin Transporter (store-and-forward slate relay)

**Status:** Design proposal (no code yet)
**Provisional slot:** `056_grin_transporter.sh` under the Wallet Services hub (Script 05)
**Origin idea:** vault713/grinbox — revived as a self-hosted, Tor-fronted slate transport,
not a public central relay.

> **Naming note.** Earlier drafts called this a "mailbox." That term was dropped because it
> wrongly implies email/SMTP. **This is not email.** There is no SMTP, no port 25, no
> Postfix/Dovecot, no MX records, no `user@host` addresses. It is a small **HTTP(S) service**
> (Node + Express + SQLite, same stack as Scripts 051/052) that holds encrypted Grin slates
> keyed by **slatepack address** and serves them over the normal web port via nginx. Think
> "a queue you PUT to and GET from," not "an inbox."
>
> **"grinbox" is kept as a historical reference only.** It is the proper name of the original
> abandoned project (`vault713/grinbox`) and of the legacy transport Grin core removed — so it
> stays wherever we *cite* that prior work. It must never be used to *describe our component*:
> our thing is the **Grin Transporter**. (grinbox and MWC's MQS also use a different, older
> cryptography — see §10.)

> ⚠ **Verify-before-code markers.** Items tagged `⚠VERIFY` are based on grin-wallet
> behaviour that should be confirmed against the running binary / API docs before
> implementation. Run `/research` on "grin-wallet slatepack encrypt/decode + Foreign
> receive_tx" to lock these down. Everything else follows existing toolkit patterns.

---

## 1. Why this exists (the one-paragraph version)

Every Grin transaction is **interactive** — it needs a round trip between sender and
receiver to build. The toolkit already supports the two standard transports:

- **Slatepack (manual copy-paste)** — offline-tolerant, but a human must act on both sides.
- **Tor (direct)** — fully automatic, but the **receiver must be online** with a listener
  running at the exact moment of send.

The Transporter fills the one gap neither covers: **automatic AND offline-tolerant.** A
sender drops an encrypted slate into a queue; the receiver collects it whenever it next
comes online and replies the same way. Neither party is online at the same instant. The
Transporter server never sees plaintext — it is a dumb, encrypted blob queue keyed by
recipient slatepack address.

### Where it earns its keep in *this* toolkit

| Use case | Today | With Transporter |
|---|---|---|
| **Pool payouts (Script 07 pool design)** | "Tor-only auto-pay; on Tor failure, queue + retry every 6h up to 7 days" — fails whenever the miner isn't running a listener at pay time | Pool drops payout slate into the miner's queue; miner's wallet finishes it on next poll. No 7-day retry gamble. |
| **Grin Drop (Script 052)** | Recipient must paste a slatepack back, or be online for Tor | Fire-and-forget: claim slate waits in the recipient's queue |
| **Person ↔ person, different timezones** | Trade slatepacks by hand over chat | Async, no copy-paste |

> **Note on current state:** Script 07 today is *solo mining* and only **calculates** payout
> splits for manual settling — it sends no Grin. The Tor-only auto-pay pool (PPLNS, 6h/7-day
> retry) is the **documented architecture**, not shipped code. The Transporter is the payment
> rail that design should ride on, which is the strongest reason to build it.

### When NOT to use it
- One-off person-to-person with a chat channel already open → plain slatepack is simpler.
- Both parties online and technical → Tor direct is cleaner.
- Maximum privacy → a self-hosted Transporter still knows *which address talked to which, and
  when* (it cannot read amounts). Slatepack over a channel you control leaks no server-side
  metadata.

---

## 2. Grin's transaction transports — full comparison

Grin transactions are **interactive**: building one needs at least one round trip of "slates"
between payer and payee. Everything below is just a different way to *move those slates*. None
of them change the on-chain transaction — they change the UX and the trust/availability
trade-offs. Listing them all so the Transporter can be judged against the real field, not a
strawman.

### The seven transports

| # | Transport | Both online at once? | Automated (no copy-paste)? | Receiver needs public reachability? | Infra required | Privacy / metadata | Status in Grin today |
|---|---|---|---|---|---|---|---|
| 1 | **Slatepack — manual** (armored text over email/chat/forum) | ❌ No | ❌ No (human pastes both sides) | ❌ No | None | **Best** — you pick the channel | ✅ Standard async method |
| 2 | **Slatepack via Tor** (`grin-wallet listen` onion) | ⚠ **Yes** — listener must be up at send | ✅ Yes | ❌ No (onion, no public IP) | Tor daemon + live listener | High (Tor hides IP) | ✅ Standard automated method |
| 3 | **Direct HTTP(S) listener** (clearnet `http://ip:port`) | ⚠ Yes | ✅ Yes | ✅ **Yes** — public IP/port + SSL | Open port, listener | Low (exposes IP) | ⚠ Legacy/discouraged |
| 4 | **File-based slate** (`.tx` files passed by hand) | ❌ No | ❌ No | ❌ No | None | Depends on channel | ⚠ Legacy (airgap niche) |
| 5 | **Keybase relay** | ❌ No | ◑ Semi | ❌ No | Keybase account + 3rd-party app | Relies on Keybase | ❌ Removed (Keybase abandoned) |
| 6 | **grinbox / MWC MQS relay** (message queue) | ❌ No | ✅ Yes | ❌ No | Central relay server | Relay sees metadata; central trust | ❌ Removed from Grin core* |
| 7 | **Grin Transporter** *(this proposal)* | ❌ **No** | ✅ **Yes** | ❌ **No** (receiver polls outbound) | Self-hosted Node+SQLite (+opt. Tor) | Ciphertext-only; relay sees addr+timing (Tor front mitigates) | 🔶 Proposed toolkit add-on (not core) |

\* The grinbox idea survives outside Grin — MWC adopted it as MQS, Epic Cash as Epicbox.
Grin core deliberately dropped it in favour of Slatepack + Tor (see §10).

### The advantage, stated precisely

Read the table by columns and one row stands out. **Transporter (row 7) is the only transport
that is simultaneously:**

1. **Offline-tolerant** — "Both online at once?" = No, and
2. **Automated** — "Automated?" = Yes, and
3. **No public reachability needed** — receiver only makes *outbound* polls.

- Slatepack-manual (1) and file (4) get #1 and #3 but fail #2 (a human must act).
- Tor (2) and direct-HTTP (3) get #2 but fail #1 (receiver must be online at send); direct-HTTP also fails #3.
- Keybase (5) and grinbox/MQS (6) got all three — which is exactly why the idea is worth
  reviving — but both are dead/removed and depended on a third-party or central-trust relay.

So the honest one-liner for a Grin-savvy audience: **"It's the only way to do an automated
send to a recipient who is offline and not publicly reachable — without a human in the loop
and without trusting a third party's relay (you host your own)."** That is precisely the
shape of **mining-pool payouts** and **giveaway claims**, and precisely what the documented
Script 07 "Tor-only + 7-day retry" loop is struggling to fake.

### What a Grin expert will push back on (and the honest answer)

Be ready for these — they are fair:

- **"Just run a Tor listener 24/7."** Correct *when the receiver is yours or always-on*. It
  breaks when the receiver is someone you don't control — a miner who shuts down their rig, a
  Grin Drop claimant who closed the tab, a mobile wallet. The payer cannot mandate that
  thousands of recipients keep a Tor daemon alive. Transporter shifts the "be available"
  burden from a live inbound listener to an occasional outbound poll.

- **"A relay reintroduces the centralization/metadata that Grin removed when it killed
  grinbox."** True, and we don't hide it. Mitigations that make it acceptable as an
  *application-layer convenience* (not a protocol change): it is **opt-in per service**,
  **self-hosted** (not one shared public relay), **ciphertext-only** (no funds/amounts
  exposed, only address+timing metadata), **Tor-frontable** (removes the clearnet metadata
  point), and **never touches consensus**. A user who dislikes it keeps using Slatepack/Tor.

- **"How is this different from MWC MQS / Epicbox, which already exist?"** Those are
  first-class, federated wallet transports built on the *old secp256k1 grinbox addressing*.
  Ours keeps Grin's **modern ed25519 Slatepack crypto** untouched and adds only the queue —
  a self-hosted relay per operator, not a network-wide federation. We borrow their
  *architecture*, not their cipher (see §10).

- **"Why not lean on payment-proofs / invoices instead?"** Those are orthogonal — they
  describe *who initiates* and *how you prove receipt*, not *how slates travel*. Any of them
  can ride on top of the Transporter.

### Decision guide (which transport for which job)

```
Need to pay/transact with…
├─ a person, you have a chat open, one-off          → Slatepack manual        (transport 1)
├─ a server/service that is always online           → Tor direct              (transport 2)
├─ an airgapped / cold wallet                        → File slate              (transport 4)
└─ many recipients who are offline & not reachable  → Grin Transporter        (transport 7)
   (pool payouts, giveaway claims, scheduled sends)
```

---

## 3. What grin-wallet already gives us (so we build less)

grinbox's whole value was "encrypt a transaction to an address only its owner can open."
Modern grin-wallet **inherited that** as Slatepack — we implement **zero cryptography**:

| grinbox concept | grin-wallet equivalent | API to call |
|---|---|---|
| `grinbox://` address (secp256k1) | **Slatepack address** (ed25519, `grin1…`/`tgrin1…`) — *same key as the Tor onion v3 address* | `get_slatepack_address` (Owner) `⚠VERIFY` name |
| Encrypt slate to recipient | **Encrypted Slatepack** addressed to recipient's slatepack address | `create_slatepack_message` (Owner) `⚠VERIFY` |
| Decrypt on receiver | Wallet opens with its ed25519 key | `slate_from_slatepack_message` / `decode_slatepack_message` (Owner) `⚠VERIFY` |
| Receiver adds their part | Foreign API receive | `receive_tx` (Foreign v2) |
| Sender finalizes + broadcasts | Owner API | `finalize_tx` + `post_tx` (Owner) |
| Relay transport | ❌ nothing — **this is the only piece we build** | — the Transporter server |

The Transporter is therefore a **thin transport layer**, not a protocol re-implementation.

---

## 4. Requirements

### Functional
- **R1** Accept an encrypted slatepack addressed to a recipient slatepack address; store it.
- **R2** Let the addressed recipient (and only them) retrieve and delete their slates.
- **R3** Support the full round trip: S1 (payer→payee), S2 (payee→payer), so the queue holds
  slates in *both* directions, each keyed by the destination address.
- **R4** Slate TTL + size cap (drop after N days; reject > slatepack cap).
- **R5** Run mainnet and testnet independently (separate dirs/ports/DBs — toolkit rule).
- **R6** Provide a **client/agent** the payer (pool) and payee wallets use to poll, decrypt,
  `receive_tx`/`finalize_tx`, and re-enqueue replies.

### Non-functional / security
- **R7** Server stores **ciphertext only** — never holds wallet keys or plaintext slates.
- **R8** Retrieval is **authenticated by proving key ownership** — recipient signs a
  server-issued challenge with the ed25519 key behind their slatepack address. No accounts,
  no passwords (mirrors the pool's "address-as-identity" decision).
- **R9** Bind Node service to `127.0.0.1` only; nginx is the public surface (rate limit + SSL),
  matching Scripts 051/052.
- **R10** Optional: front the Transporter itself as a **Tor hidden service** so even the relay
  endpoint isn't a clearnet metadata magnet.
- **R11** No plaintext secrets in `ps`/argv — reuse the toolkit's passphrase-via-file +
  launcher-script pattern (see `_drop_start_session`).

---

## 5. Architecture

Two deliverables, mirroring the toolkit's "infra script + app code" split (like 052 +
`web/052_*`):

```
A) Transporter server        — Node + Express + SQLite, the encrypted slate queue (HTTP, not SMTP)
B) Transporter client/agent  — polls + does encrypt/decrypt/receive/finalize via wallet API
```

### Component diagram

```
                    ┌──────────────────────────────────────────────┐
                    │            056 TRANSPORTER SERVER              │
   PAYER side       │   Node/Express  →  SQLite (slates by addr)     │     PAYEE side
   (e.g. pool)      │   127.0.0.1:7456  ── nginx ── HTTPS / .onion    │   (e.g. miner)
 ┌──────────────┐   └──────────────▲───────────────────▲────────────┘   ┌──────────────┐
 │ grin-wallet  │                  │ PUT/GET ciphertext │                 │ grin-wallet  │
 │ owner_api    │   ┌──────────────┴──────┐   ┌─────────┴────────────┐   │ owner_api    │
 │ (ECDH)       │◄──┤ 056 client/agent     │   │ 056 client/agent     ├──►│ + Foreign    │
 └──────────────┘   │ (payer): build S1,   │   │ (payee): pull S1,    │   │ receive_tx   │
                    │ encrypt, enqueue;    │   │ receive_tx, encrypt  │   └──────────────┘
                    │ poll for S2, finalize│   │ S2, enqueue reply    │
                    └──────────────────────┘   └──────────────────────┘
```

The server only ever moves opaque ciphertext over HTTP(S). All wallet crypto happens at the
edges, through the **Owner API ECDH session** the toolkit already uses (see 051 `server.js`,
052 listener).

### Data flow — one payout, both parties offline-tolerant

```
   PAYER (pool)                  TRANSPORTER (056)               PAYEE (miner)
        │                               │                              │
  1. init_send_tx  ────────────────────┼──────────────────────────────┤  (offline OK)
  2. create_slatepack_message          │                              │
     (encrypt S1 → payee addr)         │                              │
  3. PUT /queue/<payee_addr>  ───────► store ciphertext (S1)           │
        │                               │                              │
        │ (payee comes online later)    │ ◄──── GET /queue/<payee_addr> 4. (auth: sign challenge)
        │                               │ ────► returns S1 ciphertext   │
        │                               │       5. slate_from_slatepack │ (decrypt S1)
        │                               │       6. receive_tx (Foreign) │ (add output+sig)
        │                               │       7. create_slatepack_msg │ (encrypt S2 → payer)
        │                  store (S2) ◄─┼──────  8. PUT /queue/<payer>   │
        │                               │                              │
  9. GET /queue/<payer_addr> ────────► returns S2 ciphertext           │
 10. slate_from_slatepack (decrypt S2)  │                              │
 11. finalize_tx + post_tx  ──► broadcast to chain                     │
        │  delete consumed slates ─────► DELETE /queue/<addr>/<id>      │
        ▼                                                              ▼
     payout confirmed once mined + matured (1440 mainnet / 100 testnet)
```

Key property: steps 1–3 and 9–11 (payer) need not overlap in time with steps 4–8 (payee).

### Authentication (R8) — challenge/response, no accounts

```
   client                         server
     │ GET /auth/challenge?addr=grin1…  │
     │ ◄──────── {nonce, expires} ──────│   server stores nonce briefly
     │ sign(nonce) with ed25519 key     │   (the key behind the slatepack addr)
     │ ──── POST /auth {addr, nonce, sig} ─►  verify sig against pubkey decoded from addr
     │ ◄──────── {short-lived token} ───│
     │ use token on /queue/<addr> calls │
```

`⚠VERIFY`: confirm grin-wallet can expose a sign/verify primitive for the slatepack
ed25519 key, or whether we derive the verifying pubkey purely from the bech32 address and
have the wallet sign via an existing method (e.g. payment-proof signing). If no clean
signing hook exists, fallback options: (a) a per-recipient bearer token issued at
registration, or (b) decrypt-to-prove — server sends an encrypted nonce only the true
key-holder can decrypt. Decision deferred to research.

---

## 6. Backend setup (target VPS)

### Deploy layout — follows `/opt/grin/<service>/` convention

```
/opt/grin/transporter-main/             mainnet instance
  app/
    server.js                           Express relay (binds 127.0.0.1:7456)
    package.json                         express + better-sqlite3
    node_modules/
  transporter.db                        SQLite: slates, challenges (root:root 600)
  config.json                           TTL, size cap, public host, tor on/off
/opt/grin/transporter-test/             testnet instance (port 7466, --testnet semantics)

/opt/grin/conf/grin_transporter.json    shared settings (mirrors grin_pool.json style)

/etc/systemd/system/grin-transporter-main.service
/etc/systemd/system/grin-transporter-test.service
/etc/nginx/sites-available/grin-transporter-{main,test}
/etc/nginx/conf.d/script056-transporter-{main,test}.conf   rate-limit zone (script-prefixed)
```

### Port plan (slots into the existing table)

| | Mainnet | Testnet | Notes |
|---|---|---|---|
| Transporter Node (127.0.0.1) | 7456 | 7466 | nginx-fronted only, never firewalled open |
| Wallet Owner API (payer/payee) | 3420 | 13420 | unchanged — toolkit default |
| Wallet Foreign API | 3415 | 13415 | unchanged — `receive_tx` |

### SQLite schema (minimal)

```sql
CREATE TABLE slates (
  id          INTEGER PRIMARY KEY,
  recipient   TEXT NOT NULL,          -- slatepack address (grin1…/tgrin1…)
  body        TEXT NOT NULL,          -- encrypted slatepack (ciphertext only)
  created_at  INTEGER NOT NULL,       -- epoch; TTL sweep deletes old rows
  picked_up   INTEGER DEFAULT 0
);
CREATE INDEX idx_recipient ON slates(recipient, picked_up);

CREATE TABLE challenges (
  nonce      TEXT PRIMARY KEY,
  addr       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
```

### HTTP API (the Transporter)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/auth/challenge?addr=` | none | issue nonce |
| POST | `/auth` | sig | exchange signed nonce for short-lived token |
| PUT | `/queue/:addr` | none* | enqueue ciphertext for `:addr` (*size+rate capped) |
| GET | `/queue/:addr` | token | list/fetch ciphertext for `:addr` |
| DELETE | `/queue/:addr/:id` | token | delete a consumed slate |
| GET | `/health` | none | public liveness (redact counts per health-API tier) |

> `PUT` is intentionally unauthenticated — anyone may *deposit* an encrypted slate to an
> address. Confidentiality is the encryption; abuse is bounded by size cap + rate limit + TTL.
> Only **retrieval/deletion** require proving ownership.

### systemd unit (pattern from 052/051)

```ini
[Service]
User=grin
Environment=TRANSPORTER_NET=main TRANSPORTER_PORT=7456
WorkingDirectory=/opt/grin/transporter-main/app
ExecStart=/usr/bin/node server.js
Restart=on-failure
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
ReadWritePaths=/opt/grin/transporter-main
```

### nginx rate-limit zone (follow CLAUDE.md rule — never inline `limit_req_zone`)

Script-specific zone → call the primitive directly with a `script056-` conf basename:

```bash
nginx_ensure_rate_limit_zone "transporter_${net}" "60r/m" "10m" "script056-transporter-${net}"
```

---

## 7. How we build it from the toolkit (reuse map)

The point of doing this *inside* the toolkit is that ~80% already exists. New code is small.

| Need | Reuse from | New work |
|---|---|---|
| Install grin-wallet binary | `grin_wallet_install.sh` / `_drop_download_wallet` | none — call it |
| Wallet init/recover/seed save | `052_lib_wallet.sh` patterns | none — reuse flow |
| `listen` + `owner_api` tmux sessions | `_drop_start_session`, launcher-script-from-file pass handling | none |
| `grin` user + HOME contract + ownership | CLAUDE.md launch contract, `_drop_fix_ownership` | none |
| Owner API ECDH session in Node | 051 `web/051_wallet/server.js` (`ownerApiSession`) | adapt for create/decode slatepack calls |
| Node + Express + SQLite service | 052 Grin Drop app, pool stack (better-sqlite3) | **the relay server.js + schema** |
| systemd unit writer | 051/052 unit heredocs | new unit names |
| nginx reverse proxy + SSL + rate limit | `nginx_shared_helpers.sh`, 051/052 vhost heredocs | new vhost + `script056-` zone |
| @reboot autostart + watchdog cron | `_drop_toggle_reboot_cron`, `_drop_toggle_watchdog_cron` | new tags |
| Hub integration | `05_grin_wallet_service.sh` `run_sub` + status detectors | add menu item 6) Transporter + `_056_installed/_056_status` |
| Tor (optional .onion front) | `systemctl tor@default`, 051 Tor-status pattern | hidden-service config block |

### New files (proposed)

```
scripts/056_grin_transporter.sh         infra: deps, deploy, systemd, nginx, tor, status
scripts/lib/056_lib_server.sh           server deploy/config helpers (sourced, no shebang)
scripts/lib/056_lib_client.sh           payer/payee agent install + cron poll
web/056_transporter/server.js           Express relay (ciphertext queue)
web/056_transporter/package.json        express + better-sqlite3
web/056_transporter/client/agent.js     poll/encrypt/decrypt/receive/finalize agent
docs/generated/script056_implementation.md   (later: code, deploy, testing, troubleshooting)
```

### Hub wiring (Script 05)

```
6) Grin Transporter        store-and-forward slate relay — Node + systemd + Tor
   _056_installed → [ -d /opt/grin/transporter-main ] || [ -d /opt/grin/transporter-test ]
   _056_status    → systemctl is-active grin-transporter-{main,test}
```

---

## 8. Pool payout: before vs. after (the headline win)

```
BEFORE (documented Tor-only design)              AFTER (Transporter rail)
─────────────────────────────────────            ─────────────────────────────────────
pool builds payout slate                         pool builds payout slate
   │                                                 │
connect to miner .onion via Tor  ── fails ──►    encrypt → PUT /queue/<miner_addr>
   │  miner listener offline                        │  (miner offline is fine)
queue + retry every 6h, up to 7 days             miner agent polls when next online,
   │  (may never succeed)                            receives + replies S2
give up after 7 days → manual                    pool finalizes + broadcasts on next poll
                                                     │
                                                  matures (1440/100 blocks) → done
```

The Transporter turns "hope the miner is online at the same second" into "leave it in their
queue" — which is exactly the failure mode the 7-day retry loop is papering over.

---

## 9. Security summary

- **Ciphertext-only relay (R7)** — compromise of the Transporter server leaks *metadata*
  (addresses + timing), never funds or slate contents.
- **Address-as-identity auth (R8)** — consistent with the pool's design decision; no
  passwords to leak.
- **Deposit is open, retrieval is proven** — anyone can deposit an encrypted slate to an
  address, only the key-holder can read/remove it.
- **127.0.0.1 bind + nginx front (R9)** — rate limit, SSL, headers; no direct public Node.
- **Optional Tor front (R10)** — removes the clearnet metadata point entirely.
- **No secrets on argv (R11)** — reuse the launcher-script-reads-passfile pattern.
- **Maturity respected** — payout "confirmed" only after coinbase maturity (1440 mainnet /
  100 testnet), same as the pool's reorg-safety rule.

---

## 10. Prior art & references (check during coding/debug)

This is the **grinbox lineage** — the original idea, plus where MWC kept it alive. Use these
for the *transport/relay architecture* (queue, address-as-identity, challenge auth), **not**
for the cryptography: grinbox/MWC MQS use the old **secp256k1** grinbox addressing, whereas
modern Grin uses **ed25519 slatepack** addresses. So borrow the server/queue design, but our
encryption layer comes from grin-wallet's Slatepack, not theirs.

| What | Where | Confidence |
|---|---|---|
| **grinbox (original relay)** — the abandoned repo that sparked this | `github.com/vault713/grinbox` | ✅ confirmed (the repo you found) |
| **wallet713** — the CLI wallet that *used* grinbox; best reference for the client-side enqueue/poll flow | `github.com/vault713/wallet713` | ✅ confirmed exists |
| **mwcmqs — THE MQS relay server** ⭐ closest analog to our Transporter | `github.com/mwcproject/mwcmqs` | ✅ **confirmed** (the repo you found) |
| **mwc713** — MWC's wallet713 fork; the *client* that subscribes/publishes to mwcmqs | `github.com/mwcproject/mwc713` | ⚠VERIFY exact path |
| **Grin Slatepack spec** — our actual crypto/addressing source of truth | `docs.grin.mw` (slatepack) | ✅ |
| **grin-wallet API** — authoritative method signatures for the Owner/Foreign calls in §3 | `docs.rs/grin_wallet_api` | ✅ |

### What `mwcproject/mwcmqs` confirms about our design (and where we differ)

> "mwcmqs (Mimblewimble Coin Message Queue (s) / … Message Queue Secure) is the **backend
> server for mwc713**." Default public relay: `mqs.mwc.mw:443`, with **federation** (multiple
> servers coordinate, "all messages will be forwarded to appropriate mwcmqs server").

| Aspect | mwcmqs (MWC) | Grin Transporter (us) | Takeaway |
|---|---|---|---|
| Transport | **HTTP/HTTPS** — Jetty on `8090` behind **nginx SSL reverse proxy** at `443` | HTTP/HTTPS — Node on `7456` behind nginx at `443` | ✅ **Validates the core decision**: it's a web relay, **not SMTP/email**. Same shape we chose. |
| Stack | Java + Jetty + Maven | Node + Express + SQLite | We stay in the toolkit's existing stack — no JVM to operate. |
| Topology | **Central + federated**, default public `mqs.mwc.mw` | **Self-hosted, single per operator** (opt. Tor front) | Their default-public/federated model is exactly the centralization Grin core objected to; we deliberately scope down to per-service self-host. |
| Crypto / addressing | secp256k1 grinbox-style addresses | **ed25519 Slatepack** (grin-wallet native) | Borrow their *queue/relay architecture*, **not** their cipher. |
| Client | mwc713 wallet (built-in MQS subscribe/publish) | thin 056 agent calling grin-wallet Owner/Foreign API | We add a small agent instead of forking a wallet. |

> Action item before/early in coding: read `mwcmqs` source for the **message lifecycle and
> subscribe/poll handshake** (the part their README doesn't spell out) — it's the closest
> working reference for our queue schema and auth flow, even though we re-do crypto with
> Slatepack and drop federation. Still `⚠VERIFY`: the exact mwc713 repo path and whether MQS
> auth is a signed-challenge or a bearer/subscription token (informs our §5 R8 decision).

---

## 11. Open questions (resolve before / during implementation)

1. **`⚠VERIFY` signing primitive (R8).** Does grin-wallet expose a clean sign/verify for the
   slatepack ed25519 key? If not, pick the bearer-token or decrypt-to-prove fallback.
2. **`⚠VERIFY` exact Owner API method names** for slatepack create/decode and address fetch
   in the deployed grin-wallet version — confirm against `docs.rs/grin_wallet_api` and the
   running binary (CLAUDE.md flags `get_tip` vs `get_status` style surprises).
3. **Agent runtime for the payee.** Pool/Drop run a Node service already (easy to add an
   agent loop). An *individual* recipient may not want a daemon — do we ship a cron-poll
   one-shot, or lean on the 051 web wallet to "check Transporter" on demand? Likely: both.
4. **Multi-server / discovery.** Hardcode the pool's own Transporter URL in payouts
   (simplest), or let a recipient advertise a preferred Transporter? Start hardcoded per-service.
5. **Abuse bounds on open PUT.** Confirm size cap (slatepack ≤ ~16 KB per 051 validation) +
   per-IP rate (60r/m proposed) are enough; add per-recipient queue depth cap.
6. **Does this belong under 05, or as its own top-level script?** It's wallet-adjacent
   infrastructure consumed by 07/052. Proposed: live under 05 hub as 056, but expose a
   library the pool (07) imports directly for payouts.

---

## 12. Recommendation

Build it as **056 Grin Transporter under the wallet hub**, in two phases:

- **Phase 1 — server + testnet proof:** ship the ciphertext queue server, the auth
  challenge, and a CLI agent. Prove a full testnet round trip between two wallets that are
  *never online simultaneously*. No web UI (mirrors the pool's testnet = headless rule).
- **Phase 2 — wire into payouts:** have the Script 07 pool design enqueue payouts through
  056 instead of the Tor-direct + 7-day-retry path, and let 052 Grin Drop offer "send to my
  Transporter" claims.

Smallest real-world validation first (Phase 1 testnet round trip with offline parties),
then integrate. Do **not** fork grinbox/MWC MQS Rust — re-implement only the one good idea
(the addressed offline queue) on the toolkit's existing Node + SQLite + Tor + grin-wallet
stack, taking the Slatepack crypto from grin-wallet rather than the legacy secp256k1 scheme.
