# Script 09 — Grin Connectivity Hub (design)

**Status:** Design proposal (no code yet). Supersedes the earlier "Script 056 Transporter under
the Script 05 wallet hub" plan — renumbered **2026-07-03** to its own top-level hub.
**Name:** Grin Connectivity Hub (working title; "Connectivity Layer" considered — "Hub" chosen
to match the 05/07 hub family). Menu label shows **09**; underlying files keep 09x numbering.

> **Why a hub, and why its own number** (settled in the 2026-07 direction discussion):
> Transport/messaging is a *shared infrastructure layer* consumed by both the wallet/payment
> products (05) and the mining pool (07) — so it cannot live *inside* either one (a mining
> script reaching into a wallet-hub subscript for payouts is a cross-dependency smell). And a
> Nostr relay deployer (Floonet) is not a wallet at all, so filing it under "Wallet Services"
> is a category error. The toolkit already grows by **appending the next free number** (052–055,
> 06b were all appended, nothing renumbered), so 09 is the convention-consistent slot. It mirrors
> the existing hub pattern: one menu entry that launches several sub-services.

---

## 0. The hub — concept, members, positioning

### What lives here

```
09_  Grin Connectivity Hub          one menu entry; launches the members below
  091_ Grin Transporter             self-hosted store-and-forward slate queue (HTTP + SQLite, opt. Tor)
  092_ Floonet relay                deploy a Grin-native Nostr relay (floonet-rs + systemd + nginx);
                                    NIP-05 name-authority and Nym mixnet-exit are config TOGGLES
                                    inside this one deployer, not separate scripts
  093+ (reserved)                    future: payout/payment notifications, etc.
```

> **NIP-05 identity + mixnet-exit are folded into 092, not new numbers** (decided 2026-07-04).
> `floonet-rs` is modular — its name-authority and Nym mixnet-exit are `config.toml` flags on the
> same binary, so both are set during 092's setup/config step. A *standalone* `goblin-nip05d`
> (identity without a relay) is niche enough that it does not earn its own script; if that demand
> ever appears it is a 092 sub-mode. The earlier "093 = NIP-05 identity" reservation is retired.

> **Shared relay infrastructure — see PART C.** The hard part of both 092 *and* the GoblinPay
> payment server (a Script-05 product) is the same primitive: deploy a `nostr-rs-relay` behind
> nginx+certbot over `wss://`. That is factored into one shared lib and documented in PART C.

Grouping rule for the hub: **things about Grin participants reaching each other** — transport,
relays, messaging, identity, notifications. NOT the node's own p2p (that's 01/04) and NOT
value-holding (that's 05). Anything that isn't participant-to-participant connectivity gets its
own top number instead of being dumped here.

### Positioning vs the Goblin / Floonet ecosystem (github.com/2ro, "dog")

We are **not** competing with Floonet's public P2P privacy network. The differentiator is
**audience and trust model, not technology** (see memory `reference_goblin_ecosystem`):

| | Floonet / Goblin | This hub |
|---|---|---|
| Audience | consumers, mobile, P2P individuals | **VPS operators running a service** (the toolkit's existing users) |
| Trust model | neutral public relay nobody owns | operator **is a party** to the flow (payouts/invoices to *their* customers) |
| Goal | anonymity (mixnet, cover traffic) | **deliverability + audit** (know the slate was retrieved, retry, log) |
| Ownership | shared federated network | **self-sovereign, one per operator** |

So the hub does two complementary things:
1. **091 Transporter** — our own operator-scoped transport for *our* products' flows. Explicitly
   single-operator; must never drift into a public utility (that would just be a worse Floonet
   and would fragment the ecosystem). It generalises what **Grin Drop (052) already does** — a
   web-based slate exchange — into one reusable transport the payment products and pool share.
2. **092 Floonet relay deployer** — the toolkit's core competence (nginx, systemd, certbot,
   firewall around someone's binaries) applied to `floonet-rs`, so operators who *do* want to
   join the P2P privacy network can stand up a relay the toolkit way. We deploy his software; we
   don't fork it. Gaps we hit in his installer/docs are upstream PR candidates.

Result: the toolkit becomes **the deployment layer for Grin connectivity**, our own transport
included and Floonet's network included — they compose rather than compete.

### Menu integration (display-layer grouping, no renumbering)

The number stays the visible label everywhere (menu = filename = docs = how we refer to it).
Ordering/grouping is a *display* concern only. Proposed main-menu grouping so admin reads last
without touching any numbers:

```
Nodes & Data       01  02  03  04
Wallet & Payments  05
Observability      06
Mining             07
Connectivity       09
──────────────────────────────
Maintenance        08  Admin      08del  Full cleanup
```

Hub wiring (in `grin-node-toolkit.sh`): 09 dispatches to `09_grin_comms_hub.sh`, which offers
`1) Transporter  2) Floonet relay` with `_09x_installed` / `_09x_status` detectors, same shape
as the 05 and 07 hubs.

---

# PART A — 091 Grin Transporter (store-and-forward slate relay)

> API method names + R8 auth gates **resolved 2026-06-09** (see A.3, A.5). Items tagged
> `⚠VERIFY` still need a 30-second curl against the *deployed* grin-wallet binary before coding
> the agent (CLAUDE.md `get_tip` rule) — not a blocker.

> **Naming.** This is **not email.** No SMTP, no port 25, no Postfix/Dovecot, no MX, no
> `user@host`. It is a small **HTTP(S) service** (Node + Express + SQLite, same stack as 051/052)
> holding encrypted Grin slates keyed by **slatepack address**, served over the web port via
> nginx — "a queue you PUT to and GET from," not "an inbox." Do not reintroduce "mailbox"/"inbox"
> terms. **"grinbox" is a historical citation only** (`vault713/grinbox`, the legacy transport
> Grin core removed) — it names prior art, never our component. Ours is the **Grin Transporter**.

## A.1 Why it exists

Every Grin transaction is **interactive** — a round trip of "slates" between sender and receiver.
The toolkit already supports the two standard transports:

- **Slatepack (manual copy-paste)** — offline-tolerant, but a human must act on both sides.
- **Tor (direct)** — fully automatic, but the **receiver must be online** with a listener up at
  the exact moment of send.

The Transporter fills the one gap neither covers: **automatic AND offline-tolerant.** A sender
drops an encrypted slate into a queue; the receiver collects it on next poll. Neither is online
at the same instant. The server never sees plaintext — it is a dumb, encrypted blob queue keyed
by recipient slatepack address.

| Use case | Today | With Transporter |
|---|---|---|
| **Pool payouts (Script 07 design)** | Tor-only auto-pay; on failure, queue + retry every 6h up to 7 days — fails whenever the miner isn't running a listener at pay time | Pool drops payout slate into the miner's queue; miner's wallet finishes it on next poll. No 7-day retry gamble. |
| **Grin Drop (052)** | Recipient pastes a slatepack back, or must be online for Tor | Fire-and-forget: claim slate waits in the recipient's queue |
| **Person ↔ person, different timezones** | Trade slatepacks by hand | Async, no copy-paste |

> Script 07 today is *solo mining* and only **calculates** payout splits for manual settling —
> it sends no Grin. The Tor-only auto-pay pool (PPLNS, 6h/7-day retry) is the **documented
> architecture**, not shipped code. The Transporter is the payment rail that design should ride.

**When NOT to use it:** one-off person-to-person with a chat channel already open → plain
slatepack. Both parties online and technical → Tor direct. Maximum privacy → a self-hosted
Transporter still knows *which address talked to which, and when* (it cannot read amounts);
Slatepack over a channel you control leaks no server-side metadata.

## A.2 Where it sits among Grin's transports

Grin transactions are interactive; every transport below is just a different way to *move the
slates* — none change the on-chain tx. The Transporter (row 7) is the only one that is
simultaneously offline-tolerant **and** automated **and** needs no public reachability on the
receiver (it only makes outbound polls):

| # | Transport | Both online at once? | Automated? | Receiver needs public reachability? | Status in Grin |
|---|---|---|---|---|---|
| 1 | Slatepack — manual | ❌ | ❌ | ❌ | ✅ standard async |
| 2 | Slatepack via Tor | ⚠ yes (listener up) | ✅ | ❌ | ✅ standard automated |
| 3 | Direct HTTP(S) listener | ⚠ yes | ✅ | ✅ public IP+SSL | ⚠ legacy/discouraged |
| 4 | File-based slate | ❌ | ❌ | ❌ | ⚠ airgap niche |
| 5 | Keybase relay | ❌ | ◑ | ❌ | ❌ removed |
| 6 | grinbox / MWC MQS | ❌ | ✅ | ❌ | ❌ removed from Grin core |
| 7 | **Grin Transporter** | ❌ | ✅ | ❌ (receiver polls out) | 🔶 proposed toolkit add-on |

Honest one-liner: *"the only way to do an automated send to a recipient who is offline and not
publicly reachable — without a human in the loop and without trusting a third party's relay
(you host your own)."* That is exactly the shape of **pool payouts** and **giveaway claims**.

Fair pushback + answers:
- *"Just run a Tor listener 24/7."* Correct when the receiver is yours/always-on; breaks when
  it's someone you don't control (a miner who powers down, a Drop claimant who closed the tab).
  Transporter shifts the "be available" burden from a live inbound listener to an occasional
  outbound poll.
- *"A relay reintroduces the centralization Grin killed with grinbox."* True, not hidden.
  Acceptable as an *application-layer convenience* because it's **opt-in per service**,
  **self-hosted** (not one shared public relay), **ciphertext-only**, **Tor-frontable**, and
  **never touches consensus**.
- *"How is this different from MWC MQS / Epicbox?"* Those are federated wallet transports on the
  old **secp256k1** grinbox addressing. Ours keeps Grin's **ed25519 Slatepack** crypto untouched
  and adds only the queue, self-hosted per operator. We borrow their *architecture*, not cipher.

## A.3 What grin-wallet already gives us (so we build less)

We implement **zero cryptography** — grin-wallet's Slatepack inherited grinbox's whole value
("encrypt a tx to an address only its owner can open"):

| grinbox concept | grin-wallet equivalent | API |
|---|---|---|
| `grinbox://` address (secp256k1) | Slatepack address (ed25519, `grin1…`/`tgrin1…`, = Tor onion v3 key) | `get_slatepack_address` (Owner) ✅ |
| Encrypt slate to recipient | Encrypted Slatepack to recipient address | `create_slatepack_message` (Owner) ✅ |
| Decrypt on receiver | Wallet opens with its ed25519 key | `slate_from_slatepack_message` (Owner) ✅ |
| Receiver adds their part | Foreign API receive | `receive_tx` (Foreign v2) ✅ |
| Sender finalizes + broadcasts | Owner/Foreign | `finalize_tx` + `post_tx` ✅ |
| Relay transport | ❌ nothing — **the only piece we build** | the Transporter server |

### Confirmed method signatures (`docs.rs/grin_wallet_api`, 2026-06-09)

All calls pass the ECDH session `token`. Standardise on **`derivation_index 0`** — the wallet's
primary slatepack address, same key as its Tor onion v3 address.

| Method | API | Params | Returns |
|---|---|---|---|
| `get_slatepack_address` | Owner | `token`, `derivation_index: u32` | `SlatepackAddress` |
| `get_slatepack_secret_key` | Owner | `token`, `derivation_index: u32` | `Ed25519SecretKey` — *enables R8 signing* |
| `create_slatepack_message` | Owner | `token`, `slate`, `sender_index: Option<u32>`, `recipients: Vec<SlatepackAddress>` | `String` (armored) |
| `slate_from_slatepack_message` | Owner | `token`, `message`, `secret_indices: Vec<u32>` | `VersionedSlate` |
| `decode_slatepack_message` | Owner | `token`, `message`, `secret_indices: Vec<u32>` | `Slatepack` (metadata) |
| `receive_tx` | Foreign | `slate`, `dest_acct_name: Option<String>`, `dest: Option<String>` | `VersionedSlate` |
| `finalize_tx` | Owner/Foreign | `slate` | `VersionedSlate` |

> `decode_slatepack_message` is **Owner-only**. The agent decodes via the Owner ECDH session,
> then hands the plain slate to Foreign `receive_tx`.

## A.4 Requirements

**Functional** — R1 accept+store an encrypted slatepack addressed to a slatepack address; R2
only the addressed recipient can retrieve/delete; R3 support the full round trip S1 (payer→payee)
and S2 (payee→payer), each keyed by destination address; R4 slate TTL + size cap; R5 mainnet and
testnet independent (separate dirs/ports/DBs); R6 provide a **client/agent** wallets use to poll,
decrypt, `receive_tx`/`finalize_tx`, and re-enqueue replies.

**Security** — R7 server stores **ciphertext only** (never keys or plaintext); R8 retrieval
**authenticated by proving key ownership** (recipient signs a server nonce with the ed25519 key
behind their slatepack address — no accounts/passwords, mirrors the pool's address-as-identity);
R9 bind Node to `127.0.0.1`, nginx is the only public surface (rate limit + SSL); R10 optional
**Tor hidden service** front; R11 no plaintext secrets on argv (reuse launcher-reads-passfile).

## A.5 Architecture

Two deliverables, mirroring the toolkit's "infra script + app code" split:

```
A) Transporter server        — Node + Express + SQLite, the encrypted slate queue (HTTP, not SMTP)
B) Transporter client/agent  — polls + does encrypt/decrypt/receive/finalize via wallet API
```

```
                    ┌──────────────────────────────────────────────┐
                    │            091 TRANSPORTER SERVER              │
   PAYER side       │   Node/Express  →  SQLite (slates by addr)     │     PAYEE side
   (e.g. pool)      │   127.0.0.1:7456  ── nginx ── HTTPS / .onion    │   (e.g. miner)
 ┌──────────────┐   └──────────────▲───────────────────▲────────────┘   ┌──────────────┐
 │ grin-wallet  │                  │ PUT/GET ciphertext │                 │ grin-wallet  │
 │ owner_api    │   ┌──────────────┴──────┐   ┌─────────┴────────────┐   │ owner_api    │
 │ (ECDH)       │◄──┤ 091 client/agent     │   │ 091 client/agent     ├──►│ + Foreign    │
 └──────────────┘   │ (payer): build S1,   │   │ (payee): pull S1,    │   │ receive_tx   │
                    │ encrypt, enqueue;    │   │ receive_tx, encrypt  │   └──────────────┘
                    │ poll for S2, finalize│   │ S2, enqueue reply    │
                    └──────────────────────┘   └──────────────────────┘
```

The server only ever moves opaque ciphertext over HTTP(S). All wallet crypto happens at the
edges through the **Owner API ECDH session** the toolkit already uses (051 `server.js`, 052).

### Data flow — one payout, both parties offline-tolerant

```
   PAYER (pool)                  TRANSPORTER (091)               PAYEE (miner)
  1. init_send_tx                                                (offline OK)
  2. create_slatepack_message (encrypt S1 → payee addr)
  3. PUT /queue/<payee_addr>  ───────► store ciphertext (S1)
        (payee comes online later)     ◄── GET /queue/<payee_addr>  4. (auth: sign challenge)
                                        ──► returns S1              5. slate_from_slatepack (decrypt)
                                                                    6. receive_tx (Foreign)
                                        ◄── PUT /queue/<payer>      7. create_slatepack_msg (S2→payer)
                            store (S2)                              8.
  9. GET /queue/<payer_addr> ────────► returns S2
 10. slate_from_slatepack (decrypt S2)
 11. finalize_tx + post_tx  ──► broadcast; DELETE consumed slates
     payout confirmed once mined + matured (1440 mainnet / 100 testnet)
```

Key property: payer steps 1–3 and 9–11 need not overlap in time with payee steps 4–8.

### Authentication (R8) — challenge/response, no accounts

**Resolved 2026-06-09:** option (a) **signature challenge**. Agent calls Owner API
`get_slatepack_secret_key(token, 0)` → `Ed25519SecretKey`, signs the server nonce **locally**
with a standard ed25519 lib; server verifies against the pubkey it decodes from the bech32
slatepack address. No special wallet "sign" method needed. **No trust escalation** — the agent
already holds Owner API access (to run `receive_tx`/`finalize_tx`), so pulling the signing key
over the ECDH session adds nothing to the threat model; the key never leaves the agent, only a
signature crosses the wire. Chosen over (b) decrypt-to-prove (equivalent, less direct now) and
(c) per-recipient bearer token (weakest — shared secret + server-side storage to leak).

## A.6 Backend setup (target VPS)

```
/opt/grin/transporter-main/             mainnet instance
  app/ server.js  package.json (express + better-sqlite3)  node_modules/
  transporter.db                        SQLite: slates, challenges (600)
  config.json                           TTL, size cap, public host, tor on/off
/opt/grin/transporter-test/             testnet instance (port 7466)
/opt/grin/conf/grin_transporter.json    shared settings (mirrors grin_pubpool.json)
/etc/systemd/system/grin-transporter-{main,test}.service
/etc/nginx/sites-available/grin-transporter-{main,test}
/etc/nginx/conf.d/script09-transporter-{main,test}.conf   rate-limit zone (script-prefixed)
```

| Port | Mainnet | Testnet | Notes |
|---|---|---|---|
| Transporter Node (127.0.0.1) | 7456 | 7466 | nginx-fronted only, never firewalled open |
| Wallet Owner API | 3420 | 13420 | unchanged |
| Wallet Foreign API | 3415 | 13415 | unchanged — `receive_tx` |

```sql
CREATE TABLE slates (
  id INTEGER PRIMARY KEY, recipient TEXT NOT NULL, body TEXT NOT NULL,
  created_at INTEGER NOT NULL, picked_up INTEGER DEFAULT 0 );
CREATE INDEX idx_recipient ON slates(recipient, picked_up);
CREATE TABLE challenges ( nonce TEXT PRIMARY KEY, addr TEXT NOT NULL, expires_at INTEGER NOT NULL );
```

HTTP API: `GET /auth/challenge?addr=` (none) → nonce; `POST /auth` (sig) → short-lived token;
`PUT /queue/:addr` (none*, size+rate capped) → deposit ciphertext; `GET /queue/:addr` (token) →
fetch; `DELETE /queue/:addr/:id` (token); `GET /health` (none, redacted counts). PUT is
intentionally open — anyone may *deposit* an encrypted slate; confidentiality is the encryption,
abuse bounded by size cap + rate limit + TTL. Only **retrieval/deletion** prove ownership.

nginx zone (never inline `limit_req_zone` — CLAUDE.md): script-specific, `script09-` prefixed:
```bash
nginx_ensure_rate_limit_zone "transporter_${net}" "60r/m" "10m" "script09-transporter-${net}"
```

## A.7 Reuse map (≈80% already exists)

| Need | Reuse from | New work |
|---|---|---|
| Install grin-wallet binary | `grin_wallet_install.sh` / `_drop_download_wallet` | none |
| Wallet init/recover/seed | `052_lib_wallet.sh` | none |
| `listen` + `owner_api` tmux | `_drop_start_session`, launcher-from-file pass handling | none |
| `grin` user + HOME contract + ownership | CLAUDE.md launch contract, `_drop_fix_ownership` | none |
| Owner API ECDH in Node | 051 `server.js` (`ownerApiSession`) | adapt for slatepack calls |
| Node+Express+SQLite service | 052 Drop app (better-sqlite3) | **relay server.js + schema** |
| systemd / nginx SSL / rate limit | 051/052 heredocs, `nginx_shared_helpers.sh` | new unit + `script09-` zone |
| @reboot autostart + watchdog cron | `_drop_toggle_reboot_cron`, `_drop_toggle_watchdog_cron` | new tags |
| Hub integration | 05/07 hub `run_sub` + status detectors | 09 hub menu + `_091_installed/_091_status` |
| Tor (.onion front) | `systemctl tor@default`, 051 Tor-status pattern | hidden-service block |

Proposed files:
```
scripts/09_grin_comms_hub.sh            hub menu → launches 091 / 092
scripts/091_grin_transporter.sh         infra: deps, deploy, systemd, nginx, tor, status
scripts/lib/091_lib_server.sh           server deploy/config helpers (sourced, no shebang)
scripts/lib/091_lib_client.sh           payer/payee agent install + cron poll
web/091_transporter/server.js           Express relay (ciphertext queue)
web/091_transporter/package.json        express + better-sqlite3
web/091_transporter/client/agent.js     poll/encrypt/decrypt/receive/finalize agent
```

## A.8 Prior art & references

grinbox lineage — borrow the *transport/relay architecture* (queue, address-as-identity,
challenge auth), **not** the cryptography (grinbox/MQS use old secp256k1; we use ed25519
Slatepack from grin-wallet):

| What | Where | Confidence |
|---|---|---|
| grinbox (original relay) | `github.com/vault713/grinbox` | ✅ |
| wallet713 (client that used grinbox) | `github.com/vault713/wallet713` | ✅ |
| **mwcmqs — the MQS relay server** ⭐ closest analog | `github.com/mwcproject/mwcmqs` | ✅ |
| mwc713 (MQS client) | `github.com/mwcproject/mwc713` | ⚠VERIFY path |
| Grin Slatepack spec | `docs.grin.mw` (slatepack) | ✅ |
| grin-wallet API signatures | `docs.rs/grin_wallet_api` | ✅ |

`mwcmqs` confirms the shape: HTTP/HTTPS (Jetty on 8090 behind nginx SSL at 443), **not
SMTP/email** — same decision we made. It differs by being central+federated (default public
`mqs.mwc.mw`) and secp256k1; we scope to self-hosted-per-operator and reuse only the queue
architecture. Read its source for the **message lifecycle / subscribe-poll handshake** early in
coding. `⚠VERIFY`: exact mwc713 path; whether MQS auth is signed-challenge vs bearer.

## A.9 Open questions (091)

1. ~~R8 signing primitive~~ **resolved** — (a) signature challenge via `get_slatepack_secret_key`.
2. ~~Owner API method names~~ **resolved** against `docs.rs`; one curl vs deployed binary remains.
3. **Payee agent runtime.** Pool/Drop already run a Node service (easy to add an agent loop). An
   individual recipient may not want a daemon → ship a cron-poll one-shot *and* a 051 web-wallet
   "check Transporter" action. Likely both.
4. **Discovery.** Start with the pool hardcoding its own Transporter URL in payouts; revisit
   recipient-advertised Transporter later.
5. **Abuse bounds on open PUT.** Size cap (slatepack ≤ ~16 KB per 051), per-IP 60r/m, plus a
   per-recipient queue-depth cap.
6. **⚠ Make-or-break for pool integration (payout rail #3).** Does the wallet a miner *already
   runs* support receiving on a relay? Standard grin-wallet speaks Tor + HTTP listener + manual
   slatepack — to our knowledge **no built-in relay/MQS client** (that was an MWC addition Grin
   upstream never took). If receiving via Transporter needs non-standard tooling, adoption is
   ~zero. **Confirm receive-support across grin-wallet / Grim / GrinPlusPlus / Ironbelly first.**
   Until then the pool keeps Tor (rail #1) + manual slatepack claim (rail #2), and the pool's
   `incentives.transporter_enabled` stays `false` (stub: `web/07_mining_pool_public/back-end-pool/
   lib/wallet-transporter.js`, interface mirrors `WalletTor`).

---

# PART B — 092 Floonet relay deployer

**Status:** Design proposal (no code yet). Deploys **external software** (github.com/2ro,
Apache/MIT) the toolkit way — we write the deployer + admin wrapper, not the relay.

## B.1 What Floonet is (and why deploy it here)

Floonet is a **network of Grin-native Nostr relays** (docs.floonet.dev) carrying encrypted
slatepacks as Nostr DMs, usernames (NIP-05), and marketplace events, with an optional co-located
Nym mixnet exit. It's the transport behind the **Goblin** P2P wallet. Operators can charge GRIN
(via GoblinPay) for name registration / write access. Default-deny event-kind whitelist keeps
relays lean (8 kinds for wallet, ~23 for marketplace).

Deploying it fits the toolkit's core competence exactly: wrap someone's binary in our
`grin` user + systemd + nginx/certbot + firewall + backup conventions. It gives operators who
want to join the **P2P privacy network** (reach Goblin users) a one-command path, and positions
the toolkit as the deployment layer for the *whole* ecosystem, not just our own products.

## B.2 Package choice — floonet-rs over floonet-strfry

Both produce the same relay; both offer Docker / bare-metal / source. **Pick `floonet-rs`** for
the toolkit's first pass:

| | floonet-rs | floonet-strfry |
|---|---|---|
| Core | Rust (nostr-rs-relay), **single binary** | C++ strfry (unmodified upstream) |
| Bare-metal | installer script + hardened systemd unit | `apply-spec.sh` + systemd |
| Extra services | modular (name authority, mixnet exit toggled in `config.toml`) | separate Rust name-authority process |
| Storage | SQLite, auto-migration | (strfry's LMDB) |
| TLS | Caddy (docker) — **we replace with nginx+certbot** | Caddy |

floonet-rs is a single Rust binary + one `config.toml` + SQLite — matches our deployment style
with the fewest moving parts. floonet-strfry drags in a C++ build plus a separate name-authority
service. (We do **not** use his Docker path; bare-metal binary + systemd is the toolkit way.)

## B.3 What we build vs reuse

We do **not** fork or modify floonet-rs. We build a deployer + day-2 admin wrapper:

| Need | Approach |
|---|---|
| Fetch binary / build | download release, or `cargo build --release` (needs Rust + `protoc` for gRPC) — offer prebuilt-first, source fallback (like grin binary install) |
| Service user + systemd | our `grin`-style unprivileged user, hardened unit (his ships `ProtectSystem=strict`, only `/var/lib/floonet-rs` writable) — adopt/align with our conventions |
| **TLS + reverse proxy** | **replace his Caddy with our nginx + certbot** HTTP-first-then-SSL vhost pattern; WebSocket relay needs `Upgrade`/`Connection` headers for `wss://` (CLAUDE.md Let's Encrypt bootstrap rules apply) |
| Config | wrap `config.toml`: set `info.relay_url`, network address, event-kind whitelist, NIP-42 auth + pubkey allowlist, name-authority on/off, mixnet-exit on/off — surface as admin menu edits, not hand-editing |
| Firewall | ufw/iptables: open the nginx 443 only; relay Node bound behind proxy |
| Day-2 admin | status/restart, `config.toml` edits, SQLite backup, log view — same shape as other scripts' admin sections |
| Optional | GoblinPay paid-registration integration; Nym mixnet exit toggle |

Proposed files:
```
scripts/092_grin_floonet_relay.sh       infra: fetch/build, service user, systemd, nginx+certbot, ufw, admin
scripts/lib/092_lib_floonet.sh          config.toml helpers, backup, status (sourced)
```

No `web/092_*` — Floonet ships its own relay + optional name-authority; we don't add app code.

## B.4 Open questions (092)

1. **Binary distribution.** Does 2ro publish prebuilt `floonet-rs` releases, or is `cargo build`
   required on the VPS? (Affects deps: Rust toolchain + `protoc`.) `⚠VERIFY` on the releases page.
2. **nginx WebSocket config** for nostr-rs-relay — confirm exact `location`/upgrade-header block
   and that certbot's `--nginx` plays with it (HTTP-first bootstrap, then SSL vhost).
3. **Mainnet/testnet stance.** Floonet is network-agnostic transport (carries whatever slatepack
   is inside). Decide whether we run one relay or expose net-tagged instances like other scripts.
4. **Upstream coordination.** Gaps found in his installer/config docs → PR to the floonet repos
   rather than patching around them locally.
5. **Scope creep guard.** Keep 092 a *relay deployer*. NIP-05 identity as a standalone service,
   notifications, marketplace bridges = future 093+ members, not bolt-ons here.

---

# PART C — Shared relay infrastructure & GoblinPay (05) composition

**Status:** Design decision (2026-07-04). Ties 092 (a 09 member) to GoblinPay (a **Script-05**
payment product). GoblinPay's own product detail lives in the Script-05 docs/memory; **only the
relay relationship is a 09 concern** and is recorded here.

## C.1 The shared primitive — one `nostr-rs-relay` deployer

`floonet-rs` **is** a `nostr-rs-relay` (Rust single binary) + Grin extras. GoblinPay's default
"bundled mode" **co-locates its own `nostr-rs-relay`**. Both therefore need the identical, and
only genuinely fiddly, piece of infrastructure:

> deploy a `nostr-rs-relay` publicly reachable over `wss://`, TLS-terminated, with the
> `Upgrade`/`Connection` headers a WebSocket vhost needs (the 092 B.4 #2 open question).

Factor this **once** into a shared sourced lib so the gotchas are solved in one place, not twice:

```
scripts/lib/nostr_relay_deploy.sh   deploy a nostr-rs-relay behind nginx+certbot (wss), hardened
                                    systemd, ufw; parametrised by binary path + config + net
```
- **092** calls it to stand up `floonet-rs` (then layers name-authority / mixnet-exit toggles).
- **GoblinPay's 05 sub-option** calls it for the bundled relay (or skips it in external mode).
- We replace upstream's **Caddy** with our **nginx+certbot** in both cases (same as the rest of
  the toolkit; CLAUDE.md Let's Encrypt HTTP-first-then-SSL bootstrap applies).

## C.2 GoblinPay ↔ 092 — compose-when-present, never a hard dependency

GoblinPay (github.com/2ro/GoblinPay — receive-only Grin merchant server, Rust/Actix+SQLite,
Nostr gift-wrapped slatepacks *plus* a direct-slatepack QR rail, fiat rate-lock invoices, hosted
zero-JS checkout, HMAC webhooks, WooCommerce/Medusa/REST connectors, `/admin` dashboard) ships a
bare-metal **systemd** path, so it deploys the toolkit way (deploy, don't fork — like floonet-rs).

It does **not require** 092. Three relay modes the 05 sub-option should offer:

| Mode | When | What deploys | Needs 092? |
|---|---|---|---|
| **Direct-only** | operator wants no Nostr at all | GoblinPay + our nginx/certbot; no relay | no |
| **Bundled relay** (GoblinPay default) | wants Nostr, no existing relay | GoblinPay's own `nostr-rs-relay` via `nostr_relay_deploy.sh` | no |
| **External → 092** | already runs a Floonet relay | GoblinPay `external mode` config points at the 092 relay | reuses it |

Rule: if 092 is already installed, the GoblinPay setup **auto-offers "use your existing Floonet
relay"**; otherwise it bundles its own. Same compose-when-present philosophy as the rest of the
hub — 092 is an *optional shared relay*, not a gate.

## C.3 Why GoblinPay lives under 05, not 09

Function-not-vendor (the toolkit numbers by function, never by author): GoblinPay is a **payment
processor** → Script-05 (Wallet & Payments), alongside 053 (WooCommerce) / 054 (Payment Pro). Only
the *relay it may lean on* is connectivity (09). So GoblinPay is a 05 member that optionally
consumes a 09 relay — the two hubs compose, they don't merge. (GoblinPay's WooCommerce connector
is more complete than a from-scratch 053; treat GoblinPay as the adopt-don't-rebuild option and
keep our own 053/054 only as the deliberate **no-Nostr, no-external-deps** alternative.)

---

## Recommendation (hub build order)

1. **091 Phase 1** — Transporter server + auth challenge + CLI agent; prove a testnet round trip
   between two wallets **never online simultaneously** (headless, mirrors the pool's testnet
   rule). Do **not** fork grinbox/MQS — reimplement only the addressed offline queue on our
   Node+SQLite+Tor+grin-wallet stack, Slatepack crypto from grin-wallet.
2. **091 Phase 2** — wire into payouts (Script 07 enqueues via 091 instead of Tor-direct +
   7-day retry) and 052 Drop "send to my Transporter" claims — *gated on A.9 #6 receive-support*.
3. **092** — Floonet relay deployer (floonet-rs bare-metal + nginx/certbot + admin), independent
   of 091; ships whenever the deployer is ready. Verify release/build path (B.4 #1) first. Build
   `scripts/lib/nostr_relay_deploy.sh` (PART C.1) here — 092 is its first consumer.
4. **GoblinPay under 05** — reuse `nostr_relay_deploy.sh` for bundled mode; auto-detect and offer
   an installed 092 relay for external mode (PART C.2). Lands in the 05 hub, not 09.
