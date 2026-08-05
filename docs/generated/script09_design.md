# Script 09 — Grin Connectivity Hub (design)

**Status:** 091 Floonet relay deployer **IMPLEMENTED 2026-07-10**; 093 Transporter
**Phase 1 IMPLEMENTED 2026-07-11 — standalone only** (server + agent; NO Drop/pool wiring,
still gated on B.9 #6; see `script09_implementation.md` for both built shapes).
Supersedes the earlier "Script 056 Transporter under the Script 05 wallet hub"
plan — renumbered **2026-07-03** to its own top-level hub.
**Name:** Grin Connectivity Hub (working title; "Connectivity Layer" considered — "Hub" chosen
to match the 05/07 hub family). Menu label shows **09**; underlying files keep 09x numbering.

> **2026-08-04 — Transporter renumbered 092 → 093; 092 RESERVED for the mwixnet CoinSwap
> mixer.** Operator decision. The mixer (PART D) is the more actionable build — upstream
> `mimblewimble/mwixnet` has been community-tested on testnet and a live route operator can add
> our hop on request — whereas the Transporter's Phase 2 is still gated on wallet relay-receive
> support (B.9 #6). ⚠ Two toolkit rules were knowingly bent here and are recorded so the cost is
> not re-discovered later: (1) **092 is a reservation for an UNBUILT product**, which the
> numbering convention ("assign a number when a build STARTS, not to an idea") exists to
> prevent; (2) this is the Transporter's **third** number — `056` → `091` → `092` → `093`.
> The migration was cheap only because 093 has never been deployed to a VPS and its runtime
> identifiers are **name-keyed, not number-keyed** (`grin-transporter-{main,test}`,
> `/opt/grin/transporter-{main,test}`, `grin_transporter.conf`, `/etc/cron.d/grin-transporter-agent-<net>`,
> ports 7456/7466 — none contain the script number), so unlike the Drop 052 → 059 migration
> there was no matched-key nginx/cron dance. A *deployed* product must not be renumbered on
> these terms.

> **2026-07-10 — member numbers swapped + upstream verified.** The Floonet relay deployer is
> now **091** (menu option 1, build priority #1) and the Grin Transporter is **092** (menu
> option 2, **deferred**) — *092 at that time; it moved to 093 on 2026-08-04, see above*.
> Rationale: the Floonet relay serves an *existing* user base (Goblin
> wallet users, the Floonet network) the moment it deploys, while the Transporter is an
> internal toolkit rail gated on the receive-support question (B.9 #6) — "revisit in future."
> Same day, PART A's upstream assumptions were **verified against the live floonet-rs repo +
> docs.floonet.dev** (see A.2b).

> **Why a hub, and why its own number** (settled in the 2026-07 direction discussion):
> Transport/messaging is a *shared infrastructure layer* consumed by both the wallet/payment
> products (05) and the mining pool (07) — so it cannot live *inside* either one (a mining
> script reaching into a wallet-hub subscript for payouts is a cross-dependency smell). And a
> Nostr relay deployer (Floonet) is not a wallet at all, so filing it under "Wallet Services"
> is a category error. The toolkit already grows by **appending the next free number** (051–053
> and 06b were all appended; the sole renumber came later — Grin Drop 052 → 059 on 2026-08-04, to
> group the 05 band by category), so 09 is the convention-consistent slot. It mirrors
> the existing hub pattern: one menu entry that launches several sub-services.

---

## 0. The hub — concept, members, positioning

### What lives here

```
09_  Grin Connectivity Hub          one menu entry; launches the members below
  091_ Floonet relay                deploy a Grin-native Nostr relay (floonet-rs + systemd + nginx);
                                    NIP-05 name-authority is a config.toml TOGGLE; the Nym
                                    mixnet-exit is an optional separate floonet-mixexit binary
                                    installed alongside (same installer) — both inside this ONE
                                    deployer, not separate scripts
  092_ mwixnet CoinSwap mixer       RESERVED 2026-08-04, NOT BUILT — run a mixer hop in a
                                    Grin CoinSwap route (ledger-level unlinkability). PART D
  093_ Grin Transporter             self-hosted store-and-forward slate queue (HTTP + SQLite, opt. Tor)
                                    — Phase 1 BUILT; Phase 2 deferred (internal rail)
  094+ (reserved)                    future: payout/payment notifications, etc.
```

> **NIP-05 identity + mixnet-exit are folded into 091, not new numbers** (decided 2026-07-04).
> `floonet-rs` is modular — its name-authority is a `config.toml` flag on the same binary, and
> the Nym mixnet-exit is an optional co-installed `floonet-mixexit` binary its own installer
> handles when present (verified 2026-07-10 — see A.2b). A *standalone* `goblin-nip05d`
> (identity without a relay) is niche enough that it does not earn its own script; if that demand
> ever appears it is a 091 sub-mode. The earlier "NIP-05 identity gets its own number" reservation
> is retired (it was pencilled in as 093, which is now the Transporter — see the renumber note below).

> **Shared relay infrastructure — see PART C.** The hard part of both 091 *and* the GoblinPay
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

So the hub does two complementary things (priority order as of 2026-07-10):
1. **091 Floonet relay deployer** — the toolkit's core competence (nginx, systemd, certbot,
   firewall around someone's binaries) applied to `floonet-rs`, so operators who want to
   join the P2P privacy network can stand up a relay the toolkit way. We deploy his software; we
   don't fork it. Gaps we hit in his installer/docs are upstream PR candidates. **Immediately
   useful to the existing Goblin/Floonet user base.**
2. **093 Transporter** *(deferred)* — our own operator-scoped transport for *our* products'
   flows. Explicitly single-operator; must never drift into a public utility (that would just be
   a worse Floonet and would fragment the ecosystem). It generalises what **Grin Drop (059)
   already does** — a web-based slate exchange — into one reusable transport the payment
   products and pool share. Deferred until the receive-support question (B.9 #6) is answered
   and a concrete internal consumer (pool payouts) is ready to wire in.

Result: the toolkit becomes **the deployment layer for Grin connectivity**, Floonet's network
included and (later) our own transport included — they compose rather than compete.

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
`1) Floonet relay  2) Transporter` with `_09x_installed` / `_09x_status` detectors, same shape
as the 05 and 07 hubs.

---

# PART A — 091 Floonet relay deployer

**Status:** **IMPLEMENTED 2026-07-10** — built shape + locked decisions (ONE relay per
operator, stable-user fallback unit, rustup policy) recorded in `script09_implementation.md`.
Deploys **external software** (github.com/2ro, Apache/MIT) the toolkit way — we write the
deployer + admin wrapper, not the relay.

## A.1 What Floonet is (and why deploy it here)

Floonet is a **network of Grin-native Nostr relays** (docs.floonet.dev) carrying encrypted
slatepacks as Nostr DMs, usernames (NIP-05), and marketplace events, with an optional co-located
Nym mixnet exit. It's the transport behind the **Goblin** P2P wallet. Operators can charge GRIN
(via GoblinPay) for name registration / write access. Default-deny event-kind whitelist keeps
relays lean (8 kinds for wallet, ~23 for marketplace).

Deploying it fits the toolkit's core competence exactly: wrap someone's binary in our
`grin` user + systemd + nginx/certbot + firewall + backup conventions. It gives operators who
want to join the **P2P privacy network** (reach Goblin users) a one-command path, and positions
the toolkit as the deployment layer for the *whole* ecosystem, not just our own products.

## A.2 Package choice — floonet-rs over floonet-strfry

Both produce the same relay; both offer Docker / bare-metal / source. **Pick `floonet-rs`** for
the toolkit's first pass:

| | floonet-rs | floonet-strfry |
|---|---|---|
| Core | Rust (nostr-rs-relay fork), **single binary** | C++ strfry (unmodified upstream) |
| Bare-metal | `deploy/install.sh` + hardened systemd unit | `apply-spec.sh` + systemd |
| Extra services | modular (name authority in `config.toml`; mixnet exit = optional co-installed binary) | separate Rust name-authority process |
| Storage | SQLite, auto-migration (Postgres also supported) | (strfry's LMDB) |
| TLS | Caddy (docker) — **we replace with nginx+certbot** | Caddy |

floonet-rs is a single Rust binary + one `config.toml` + SQLite — matches our deployment style
with the fewest moving parts. floonet-strfry drags in a C++ build plus a separate name-authority
service. (We do **not** use his Docker path; bare-metal binary + systemd is the toolkit way.)

## A.2b Upstream verification results (2026-07-10, live repo @ master + docs.floonet.dev)

All former open questions **resolved**:

1. **Binary distribution — SOURCE BUILD REQUIRED (for now).** The GitHub releases page is
   **empty** — no prebuilt binaries. `deploy/install.sh` *does* support a "release archive
   layout" (looks for `./floonet-rs` first, then `target/release/floonet-rs`), so prebuilt
   archives are anticipated upstream but not published yet. Today the deployer must run
   `cargo build --release`, which needs the **Rust toolchain + `protoc`** (protobuf compiler,
   for the gRPC nauthz extension point) on the VPS. Design the deployer prebuilt-first (probe
   the releases page at run time) with source-build as the working path.
2. **nginx WebSocket config — SOLVED BY UPSTREAM.** `docs/reverse-proxy.md` in the repo ships a
   tested nginx block: `proxy_pass http://localhost:8080`, `proxy_http_version 1.1`,
   `Upgrade`/`Connection "Upgrade"` headers, `proxy_read_timeout 1d` (long-lived WebSocket),
   Let's Encrypt cert paths. We wrap it in our HTTP-first-then-certbot bootstrap
   (CLAUDE.md Let's Encrypt rules) — no unknowns left here.
3. **Upstream installer & unit confirmed.** `deploy/install.sh` is idempotent (upgrades binary
   + unit, **never overwrites an existing `/etc/floonet-rs/config.toml`**), installs to
   `/usr/local/bin/floonet-rs`, config at `/etc/floonet-rs/config.toml` (0600), and enables
   `floonet-rs.service`. The unit is hardened beyond our usual (DynamicUser, ProtectSystem=strict,
   MemoryDenyWriteExecute, syscall filtering, only `StateDirectory=/var/lib/floonet-rs` writable).
   **Adopt his unit as-is** — swap `DynamicUser=yes` for a stable `User=floonet` only if our
   backup flow needs a stable owner on the data dir.
4. **Config schema confirmed** (defaults: `[network] address=127.0.0.1, port=8080` — already
   loopback-bound, perfect for nginx-fronting):
   - `info.relay_url` — the one **mandatory** edit
   - `limits.event_kind_allowlist` (24-kind default-deny), `limits.max_event_bytes` (sized for
     gift-wrapped slatepacks)
   - `authorization.nip42_auth` / `nip42_dms` / `pubkey_whitelist` / `public_note_authors`
   - `name_authority.enabled` / `domain` / `base_url` (NIP-05; base_url must match public relay
     URL for NIP-98 verification)
   - `goblinpay.pay_mode` (`off`/`name`/`write`) / `url` / `api_token` / `name_price_grin` /
     `admission_price_grin` — token also settable via env (`FLOONET_GOBLINPAY_TOKEN` etc. in an
     optional `EnvironmentFile=/etc/floonet-rs/env`, keep 0600)
5. **Mixnet exit ≠ config-only toggle** (correction to the earlier design). It requires the
   **separate optional `floonet-mixexit` binary**; `install.sh` installs it when present next to
   the relay binary and skips gracefully otherwise. Treat it as an optional add-on step in the
   091 menu, not a plain config flag.

## A.3 What we build vs reuse

We do **not** fork or modify floonet-rs. We build a deployer + day-2 admin wrapper:

| Need | Approach |
|---|---|
| Fetch binary / build | probe releases for a prebuilt archive; today: install Rust + `protoc`, `cargo build --release` (source fallback is the working path — A.2b #1) |
| Service user + systemd | **reuse his `deploy/floonet-rs.service`** (harder than our own template); decide DynamicUser vs stable `User=floonet` for backup friendliness |
| Install layout | **reuse his `deploy/install.sh` conventions** (`/usr/local/bin`, `/etc/floonet-rs/config.toml`, `/var/lib/floonet-rs`) — call it or replicate it, don't invent a parallel layout |
| **TLS + reverse proxy** | **replace his Caddy with our nginx + certbot** using his own `docs/reverse-proxy.md` nginx block inside our HTTP-first-then-SSL vhost pattern (A.2b #2) |
| Config | wrap `config.toml` (verified schema, A.2b #4): set `info.relay_url`, event-kind whitelist, NIP-42 auth + pubkey allowlist, name-authority on/off, GoblinPay pay-mode — surface as admin menu edits, not hand-editing |
| Firewall | ufw/iptables: open nginx 443 only; relay stays on 127.0.0.1:8080 behind the proxy |
| Day-2 admin | status/restart, `config.toml` edits, SQLite backup (shared backup engine), log view (`journalctl -u floonet-rs`) — same shape as other scripts' admin sections |
| Optional | `floonet-mixexit` co-install (A.2b #5); GoblinPay paid-registration integration |

Proposed files:
```
scripts/091_grin_floonet_relay.sh       infra: fetch/build, service user, systemd, nginx+certbot, ufw, admin
scripts/lib/091_lib_floonet.sh          config.toml helpers, backup, status (sourced)
scripts/lib/nostr_relay_deploy.sh       shared wss relay primitive (PART C.1) — 091 is its first consumer
```

No `web/091_*` — Floonet ships its own relay + optional name-authority; we don't add app code.

## A.4 Remaining open questions (091)

1. ~~Binary distribution~~ **resolved 2026-07-10** — no prebuilt releases; cargo + protoc
   source build is the working path (A.2b #1).
2. ~~nginx WebSocket config~~ **resolved 2026-07-10** — upstream `docs/reverse-proxy.md`
   provides the tested block (A.2b #2).
3. **Mainnet/testnet stance.** Floonet is network-agnostic transport (carries whatever slatepack
   is inside). Decide whether we run one relay or expose net-tagged instances like other scripts.
   *Leaning: ONE relay per operator* — the relay never touches chain state, and upstream runs a
   single `floonet-rs.service` (no per-net units).
4. **DynamicUser vs stable service user** — his unit uses `DynamicUser=yes`; our backup engine
   may want a stable owner on `/var/lib/floonet-rs`. Decide at implementation.
5. **Rust toolchain policy** — rustup as the `floonet` build user vs distro rust; VPS disk/RAM
   cost of a cargo build on small boxes (check against our 4 GB baseline).
6. **Upstream coordination.** Gaps found in his installer/config docs → PR to the floonet repos
   rather than patching around them locally. First candidate: publish prebuilt release archives
   (his install.sh already supports the layout).
7. **Scope creep guard.** Keep 091 a *relay deployer*. NIP-05 identity as a standalone service,
   notifications, marketplace bridges = future 094+ members, not bolt-ons here.

---

# PART B — 093 Grin Transporter (store-and-forward slate relay)

> **Status: Phase 1 IMPLEMENTED 2026-07-11 — STANDALONE ONLY** (user decision same day:
> build server + auth + CLI agent; keep Grin Drop 059 completely untouched). Built shape →
> `script09_implementation.md` §093. **Phase 2 (product wiring — pool payout rail #3, Drop
> claims) stays DEFERRED**, gated on B.9 #6: no mainstream wallet (grin-wallet / Grim /
> GrinPlusPlus / Ironbelly) can receive from a relay, so a Drop claimant or pool miner would
> have to run our agent — near-zero audience. Standalone still delivers operator-to-operator
> sends and the testnet round-trip proof.

> API method names + R8 auth gates **resolved 2026-06-09** (see B.3, B.5). Items tagged
> `⚠VERIFY` still need a 30-second curl against the *deployed* grin-wallet binary before coding
> the agent (CLAUDE.md `get_tip` rule) — not a blocker.

> **Naming.** This is **not email.** No SMTP, no port 25, no Postfix/Dovecot, no MX, no
> `user@host`. It is a small **HTTP(S) service** (Node + Express + SQLite, same stack as 051/059)
> holding encrypted Grin slates keyed by **slatepack address**, served over the web port via
> nginx — "a queue you PUT to and GET from," not "an inbox." Do not reintroduce "mailbox"/"inbox"
> terms. **"grinbox" is a historical citation only** (`vault713/grinbox`, the legacy transport
> Grin core removed) — it names prior art, never our component. Ours is the **Grin Transporter**.

## B.1 Why it exists

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
| **Grin Drop (059)** | Recipient pastes a slatepack back, or must be online for Tor | Fire-and-forget: claim slate waits in the recipient's queue |
| **Person ↔ person, different timezones** | Trade slatepacks by hand | Async, no copy-paste |

> Script 07 today is *solo mining* and only **calculates** payout splits for manual settling —
> it sends no Grin. The Tor-only auto-pay pool (PPLNS, 6h/7-day retry) is the **documented
> architecture**, not shipped code. The Transporter is the payment rail that design should ride.

**When NOT to use it:** one-off person-to-person with a chat channel already open → plain
slatepack. Both parties online and technical → Tor direct. Maximum privacy → a self-hosted
Transporter still knows *which address talked to which, and when* (it cannot read amounts);
Slatepack over a channel you control leaks no server-side metadata.

## B.2 Where it sits among Grin's transports

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

## B.3 What grin-wallet already gives us (so we build less)

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

## B.4 Requirements

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

## B.5 Architecture

Two deliverables, mirroring the toolkit's "infra script + app code" split:

```
A) Transporter server        — Node + Express + SQLite, the encrypted slate queue (HTTP, not SMTP)
B) Transporter client/agent  — polls + does encrypt/decrypt/receive/finalize via wallet API
```

```
                    ┌──────────────────────────────────────────────┐
                    │            093 TRANSPORTER SERVER              │
   PAYER side       │   Node/Express  →  SQLite (slates by addr)     │     PAYEE side
   (e.g. pool)      │   127.0.0.1:7456  ── nginx ── HTTPS / .onion    │   (e.g. miner)
 ┌──────────────┐   └──────────────▲───────────────────▲────────────┘   ┌──────────────┐
 │ grin-wallet  │                  │ PUT/GET ciphertext │                 │ grin-wallet  │
 │ owner_api    │   ┌──────────────┴──────┐   ┌─────────┴────────────┐   │ owner_api    │
 │ (ECDH)       │◄──┤ 093 client/agent     │   │ 093 client/agent     ├──►│ + Foreign    │
 └──────────────┘   │ (payer): build S1,   │   │ (payee): pull S1,    │   │ receive_tx   │
                    │ encrypt, enqueue;    │   │ receive_tx, encrypt  │   └──────────────┘
                    │ poll for S2, finalize│   │ S2, enqueue reply    │
                    └──────────────────────┘   └──────────────────────┘
```

The server only ever moves opaque ciphertext over HTTP(S). All wallet crypto happens at the
edges through the **Owner API ECDH session** the toolkit already uses (051 `server.js`, 059).

### Data flow — one payout, both parties offline-tolerant

```
   PAYER (pool)                  TRANSPORTER (093)               PAYEE (miner)
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

## B.6 Backend setup (target VPS)

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

## B.7 Reuse map (≈80% already exists)

| Need | Reuse from | New work |
|---|---|---|
| Install grin-wallet binary | `grin_wallet_install.sh` / `_drop_download_wallet` | none |
| Wallet init/recover/seed | `059_lib_wallet.sh` | none |
| `listen` + `owner_api` tmux | `_drop_start_session`, launcher-from-file pass handling | none |
| `grin` user + HOME contract + ownership | CLAUDE.md launch contract, `_drop_fix_ownership` | none |
| Owner API ECDH in Node | 051 `server.js` (`ownerApiSession`) | adapt for slatepack calls |
| Node+Express+SQLite service | 059 Drop app (better-sqlite3) | **relay server.js + schema** |
| systemd / nginx SSL / rate limit | 051/059 heredocs, `nginx_shared_helpers.sh` | new unit + `script09-` zone |
| @reboot autostart + watchdog cron | `_drop_toggle_reboot_cron`, `_drop_toggle_watchdog_cron` | new tags |
| Hub integration | 05/07 hub `run_sub` + status detectors | 09 hub menu + `_093_installed/_093_status` |
| Tor (.onion front) | `systemctl tor@default`, 051 Tor-status pattern | hidden-service block |

Proposed files:
```
scripts/093_grin_transporter.sh         infra: deps, deploy, systemd, nginx, tor, status
scripts/lib/093_lib_server.sh           server deploy/config helpers (sourced, no shebang)
scripts/lib/093_lib_client.sh           payer/payee agent install + cron poll
web/093_transporter/server.js           Express relay (ciphertext queue)
web/093_transporter/package.json        express + better-sqlite3
web/093_transporter/client/agent.js     poll/encrypt/decrypt/receive/finalize agent
```

## B.8 Prior art & references

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

## B.9 Open questions (093)

1. ~~R8 signing primitive~~ **resolved** — (a) signature challenge via `get_slatepack_secret_key`.
2. ~~Owner API method names~~ **resolved** against `docs.rs`; one curl vs deployed binary remains.
3. **Payee agent runtime.** Pool/Drop already run a Node service (easy to add an agent loop). An
   individual recipient may not want a daemon → ship a cron-poll one-shot *and* a 051 web-wallet
   "check Transporter" action. Likely both.
4. **Discovery.** Start with the pool hardcoding its own Transporter URL in payouts; revisit
   recipient-advertised Transporter later.
5. **Abuse bounds on open PUT.** Size cap (slatepack ≤ ~16 KB per 051), per-IP 60r/m, plus a
   per-recipient queue-depth cap.
6. **⚠ Make-or-break for pool integration (payout rail #3) — the reason 093 is deferred.**
   Does the wallet a miner *already runs* support receiving on a relay? Standard grin-wallet
   speaks Tor + HTTP listener + manual slatepack — to our knowledge **no built-in relay/MQS
   client** (that was an MWC addition Grin upstream never took). If receiving via Transporter
   needs non-standard tooling, adoption is ~zero. **Confirm receive-support across grin-wallet /
   Grim / GrinPlusPlus / Ironbelly first.** Until then the pool keeps Tor (rail #1) + manual
   slatepack claim (rail #2), and the pool's `incentives.transporter_enabled` stays `false`
   (stub: `web/07_mining_pool_public/back-end-pool/lib/wallet-transporter.js`, interface mirrors
   `WalletTor`).

---

# PART C — Shared relay infrastructure & GoblinPay (05) composition

**Status:** Design decision (2026-07-04). Ties 091 (a 09 member) to GoblinPay (a **Script-05**
payment product). GoblinPay's own product detail lives in the Script-05 docs/memory; **only the
relay relationship is a 09 concern** and is recorded here.

## C.1 The shared primitive — one `nostr-rs-relay` deployer

`floonet-rs` **is** a `nostr-rs-relay` (Rust single binary) + Grin extras. GoblinPay's default
"bundled mode" **co-locates its own `nostr-rs-relay`**. Both therefore need the identical, and
only genuinely fiddly, piece of infrastructure:

> deploy a `nostr-rs-relay` publicly reachable over `wss://`, TLS-terminated, with the
> `Upgrade`/`Connection` headers a WebSocket vhost needs (**solved** — upstream's
> `docs/reverse-proxy.md` nginx block, see A.2b #2).

Factor this **once** into a shared sourced lib so the gotchas are solved in one place, not twice:

```
scripts/lib/nostr_relay_deploy.sh   deploy a nostr-rs-relay behind nginx+certbot (wss), hardened
                                    systemd, ufw; parametrised by binary path + config + net
```
- **091** calls it to stand up `floonet-rs` (then layers name-authority / mixnet-exit toggles).
- **GoblinPay's 05 sub-option** calls it for the bundled relay (or skips it in external mode).
- We replace upstream's **Caddy** with our **nginx+certbot** in both cases (same as the rest of
  the toolkit; CLAUDE.md Let's Encrypt HTTP-first-then-SSL bootstrap applies).

## C.2 GoblinPay ↔ 091 — compose-when-present, never a hard dependency

GoblinPay (github.com/2ro/GoblinPay — receive-only Grin merchant server, Rust/Actix+SQLite,
Nostr gift-wrapped slatepacks *plus* a direct-slatepack QR rail, fiat rate-lock invoices, hosted
zero-JS checkout, HMAC webhooks, WooCommerce/Medusa/REST connectors, `/admin` dashboard) ships a
bare-metal **systemd** path, so it deploys the toolkit way (deploy, don't fork — like floonet-rs).

It does **not require** 091. Three relay modes the 05 sub-option should offer:

| Mode | When | What deploys | Needs 091? |
|---|---|---|---|
| **Direct-only** | operator wants no Nostr at all | GoblinPay + our nginx/certbot; no relay | no |
| **Bundled relay** (GoblinPay default) | wants Nostr, no existing relay | GoblinPay's own `nostr-rs-relay` via `nostr_relay_deploy.sh` | no |
| **External → 091** | already runs a Floonet relay | GoblinPay `external mode` config points at the 091 relay | reuses it |

Rule: if 091 is already installed, the GoblinPay setup **auto-offers "use your existing Floonet
relay"**; otherwise it bundles its own. Same compose-when-present philosophy as the rest of the
hub — 091 is an *optional shared relay*, not a gate.

## C.3 Why GoblinPay lives under 05, not 09

Function-not-vendor (the toolkit numbers by function, never by author): GoblinPay is a **payment
processor** → Script-05 (Wallet & Payments), alongside 053 (WooCommerce) and the unbuilt Payment
Pro / GrinPay Server (no number until its build starts). Only
the *relay it may lean on* is connectivity (09). So GoblinPay is a 05 member that optionally
consumes a 09 relay — the two hubs compose, they don't merge. (GoblinPay's WooCommerce connector
is more complete than a from-scratch 053; treat GoblinPay as the adopt-don't-rebuild option and
keep our own 053 + Payment Pro only as the deliberate **no-Nostr, no-external-deps** alternative.)

---

# PART D — 092 mwixnet CoinSwap mixer

> **Status: RESERVED 2026-08-04, NOT BUILT.** Number assigned ahead of the build by operator
> decision (see the renumber note at the top of this doc — the Transporter moved 092 → 093 to
> free it). This part is a **research record + build spec**, not an implementation report.
>
> **Letter/number mismatch is intentional:** parts are lettered in the order they were written
> (A=091, B=093, C=shared, D=092). The number, not the letter, is the label.
>
> **Provenance of everything below:** read on **2026-08-04** from `mimblewimble/mwixnet` @ `main`
> (`README.md`, `src/config.rs`, `src/tor.rs`, `src/servers/mix.rs`, `src/bin/mwixnet.yml`,
> `Cargo.toml`) **via web fetch, not a local clone**. Field names and defaults are reported as
> read, but **re-verify against a clone before writing a line of deployer code** — a summarised
> fetch is good enough to design against, not to hard-code against.
>
> **Third pass, same day — `staging` re-read.** `src/config.rs`, `src/tx.rs`, `src/servers/mix.rs`,
> `src/servers/swap.rs` and `README.md` were re-read from **`staging`** to settle the fee question
> (D.3b). `staging`'s `ServerConfig` still carries the same **nine** fields as `main`, so the schema
> in D.3 survived the branch change — but PR #34 is not merged into `staging` yet, so ⚠ still
> stands.

## D.1 What it is, and the one thing Tor cannot do

`mwixnet` is a Rust implementation of tromp's **Mimblewimble CoinSwap** proposal. A chain of
independently-operated servers takes in owned outputs, peels one layer of encryption each,
re-blinds, and emits a batch of outputs with **no on-chain link** between what went in and what
came out.

This is the toolkit's first **ledger-layer** privacy product. Everything else in Script 09 (and
Script 04's onion service, and the pool's Tor payouts) is **network-layer**:

| | Tor / onion (what we already ship) | CoinSwap / 092 |
|---|---|---|
| Conceals | the **IP** behind a transaction, in flight | the **link between coins**, on the permanent chain |
| Adversary | ISP, the peer you connect to, traffic observers | chain analysts, exchanges, anyone with a chain copy |
| Duration | the lifetime of the connection | forever — the chain is immutable |
| Failure mode | de-anonymised *now* | de-anonymised *retroactively, years later* |
| Cost | free | a GRIN fee per hop — mostly the **network** fee to miners, not a price the hop sets (D.3b) |

They are complementary, not alternatives — **mwixnet itself runs over Tor** (D.3). Grin already
hides amounts and addresses; what it does not fully hide is the *transaction graph*. That is the
gap 092 closes, and it is the only gap in that list our existing Tor work cannot touch.

## D.2 Roles — swap server vs mixer, and how a chain is formed

All roles are the **same binary**; position is defined purely by two config keys:

| Role | `prev_server` | `next_server` | Public surface |
|---|---|---|---|
| **Swap server (N₁)** | unset | set | public `swap` JSON-RPC — wallets submit here |
| **Mixer (N₂…N₍ₙ₋₁₎)** | set | set | accepts only from the previous hop |
| **Last mixer (Nₙ)** | set | unset | builds the final outputs |

Both keys are **hex Dalek public keys** of the adjacent servers. A mixer that sets `prev_server`
will only accept onions from that specific upstream — so joining a route is a *mutual*
configuration act: the route operator adds our pubkey as their `next_server`, we add theirs as our
`prev_server`. **This is the integration point with the outside world, and it is a handshake with
a human, not an API.**

**Privacy holds if ≥1 hop is honest and independent.** Corollary that must be stated in the
deployer UI: *running two hops of the same route on one box, or under one operator, provides no
privacy at all.* The valuable position is being an **independent** hop in someone else's route.

## D.2b Self-hosted full route — the dev/test rig (and why it must never be the product)

**We can run every hop ourselves.** `init-config` twice into two data dirs, set each server's
`next_server`/`prev_server` to the other's pubkey, point a testnet wallet at our own swap server's
onion. That is what the upstream test route is, and it needs **no permission and no counterparty**.

This splits cleanly into two things that must not be confused:

| | Self-hosted route | Independent hop in someone else's route |
|---|---|---|
| Purpose | develop + E2E test 092 | actually provide privacy |
| Needs an external operator | **no** | yes |
| Privacy delivered to a user | **zero** | real (1 honest hop suffices) |
| Blocked today | **no — start whenever** | yes (D.8 #3) |

⚠ **A solo full route is not merely useless — it is a liability.** The operator of *every* hop is
the one party who can link every input to every output; running the whole route means holding
precisely the data the product exists to destroy. Acceptable as a **testnet test rig**. Never as a
service, and the deployer must say so if it ever detects both roles configured on one host.

**Consequence for the build plan:** D.8 #2 (schema validation) and full E2E verification can both
be done solo, on testnet, today. Only the "go live usefully" step waits on a conversation.

## D.3 Upstream verification (2026-08-04)

**⚠ Repository state — CORRECTED 2026-08-04 (second pass, same day).** The first pass read only
`main` and concluded the project was stalled. **That conclusion was wrong, and the reason is worth
recording: `main` is not where the work is.**
- `main` genuinely is stale — last commits **August 2024** ("re-import onion primitives from
  grin-wallet contracts branch"). **Do not build from `main`.**
- The live development targets **`mimblewimble:staging`** through two open PRs by **wiesche89**:
  - **[mwixnet PR #34](https://github.com/mimblewimble/mwixnet/pull/34)** `wiesche89:wallet_staging_integration → staging` —
    opened **2026-07-27**, updated 07-29, **21 commits**, open, review requested from `ardocrat`.
    "Updates mwixnet to work with grin/grin-wallet staging, adds wallet-generated swap request
    coverage, fixes #33, tested with e2e tests." Covers reorg handling, mixer indexing, **Tor
    circuit reliability**, **HTTPS endpoint support**, and **server configuration changes**.
  - **[grin-wallet PR #783](https://github.com/mimblewimble/grin-wallet/pull/783)** `wiesche89:mwixnet_wallet_support → staging` —
    opened **2026-07-28**, review requested **2026-08-03**. Adds the `mwixnet` wallet CLI command +
    Owner API support for creating signed swap requests, output locking, tx-log tracking, and Arti
    HTTP POST fixes.
- **No GitHub releases** → source build only, same as floonet-rs (A.2b).
- **⚠ Therefore the CLI/config detail in D.3 below was read from `main` and is provisional.**
  PR #34 explicitly changes server configuration and adds HTTPS endpoints, so field names, defaults
  and flags **must be re-read from the `staging`-integrated branch** at build time. Treat the
  schema below as *shape*, not *contract*.

**Live testnet route (forum post #20, 2026-08-03 — the day before this was written).**
The `UnsupportedProtocolVersion` wall that ended the Dec-2024 test round (posts #18–19) is
resolved; wiesche89 now runs a working public **testnet** route over Tor and asks for community
testing:
```
onion    mza3u6vkqodqc6kjjapfbcjrg7hgpkuw6nyq5xvfjqp5jm2lfeaocwqd.onion
keys     ba2ee29d1e44227e3d78d1abbc7d86a9321ae24fb3656b545b001907a008bc4e   (hop 1)
         a6920c1ef8bd8bb14fe4940521eca294f797856baaa307eb51894dda157b1477   (hop 2)
fee      --fee_per_hop 12500000   → 2 hops = 0.025 GRIN total
```
Wallet-side test flow (from PR #783 / post #20):
```
grin-wallet --testnet outputs                       # pick an output commitment
grin-wallet --testnet mwixnet <COMMITMENT> \
    --server <onion> --fee_per_hop 12500000 \
    --key <key1> --key <key2>                       # → "mwixnet request accepted (transaction N)"
grin-wallet --testnet cancel -i N                   # release the locked output if needed
```
**Two hops, both run by the same person** — which is exactly the configuration that provides no
real privacy (D.2). That is not a criticism of the test route; it is the reason an *independent*
second operator has value, and it is the opening for 092.
**Note:** the post asks for testing and feedback; it does **not** explicitly invite others to
operate a hop. Joining still requires asking (D.8 #3).

**CLI (`src/bin/mwixnet.yml`, clap 2.33).**
```
mwixnet init-config          write a new config (generates + encrypts the server key)
mwixnet pubkey [-o FILE]     print/write this server's public key   ← what we hand a route operator
mwixnet                      run the server (prompts for key password + wallet password)

flags: -c/--config_file  --testnet  -n/--grin_node_url  --grin_node_secret_path
       -l/--wallet_owner_url  --wallet_owner_secret_path  --wallet_pass
       --bind_addr  --prev_server  --next_server
```

**Config file `mwixnet-config.toml`** — keys as serialised: `encrypted_key`, `salt`, `nonce`,
`interval_s`, `addr`, `grin_node_url`, `grin_node_secret_path`, `wallet_owner_url`,
`wallet_owner_secret_path`, `prev_server`, `next_server`. Defaults read from `src/config.rs`:

| Key | Default | Note |
|---|---|---|
| `grin_node_url` | `127.0.0.1:3413` mainnet / `127.0.0.1:13413` testnet | matches our node ports |
| `wallet_owner_url` | `127.0.0.1:3420` **on both chains** | ⚠ see D.5 — our testnet wallet is 13420 |
| node secret file | `.api_secret` | ⚠ see D.5 — wrong endpoint for our nodes |
| wallet secret file | `.owner_api_secret` | matches our wallet layout |
| `interval_s` | mixing-round interval (seconds) | value not captured; read from a clone |

**Tor is EMBEDDED (Arti), not the system daemon** (`src/tor.rs`) — the single most
deployment-shaping fact in this research:
- mwixnet links `arti-client` 0.18 and **creates its own onion service in-process** (nickname
  `listener`). It does **not** launch or read a system `tor`, and there is no `torrc` or
  `HiddenServiceDir` for us to manage.
- The onion maps **port 80 → the config's `addr`**, so `addr` should stay loopback.
- It writes `{data_dir}/tor/state` (containing `keystore`) and `{data_dir}/tor/cache`.
- **Consequences:** (1) no nginx vhost, no certbot, no rate-limit zone — the public surface is the
  onion, so PART C's relay primitive and `nginx_shared_helpers.sh` are **not reused here**;
  (2) our existing Tor tooling does not apply — Script 04's system-tor onion identity backup globs
  `grin-*` hidden-service dirs and **will not cover mwixnet's Arti keystore** (see D.6).

**Dependencies (`Cargo.toml`, v0.1.0, edition 2021).** Arti/tor-* 0.18, curve25519/ed25519/
x25519-dalek, chacha20, ring 0.16, tokio 1.37 + async-std, hyper 0.14, jsonrpc-* 18, rusqlite
0.31, clap 2.33. ⚠ **The Grin dependencies are unpinned git branches** — `grin_*` from
`mimblewimble/grin` **`master`**, and `grin_wallet_*` from `mimblewimble/grin-wallet`
**`contracts`**. No manifest-level system build tools are declared, but the grin crates pull the
usual native chain (expect `clang`/`llvm` for secp; check `protobuf-compiler` as with 091).

## D.3b Fees — there is no operator fee knob (answers D.8 #5)

Read from **`staging`** on 2026-08-04: `src/config.rs`, `src/tx.rs`, `src/servers/swap.rs`,
`src/servers/mix.rs`. This was an open question and the answer is unusually clean, so it is
recorded in full — it removes an operator decision the deployer would otherwise have to expose,
and it feeds D.7b.

**1. The server has no fee setting.** `ServerConfig` has exactly nine fields — `key`, `interval_s`,
`addr`, `grin_node_url`, `grin_node_secret_path`, `wallet_owner_url`, `wallet_owner_secret_path`,
`prev_server`, `next_server`. **None of them is a fee, a price, a minimum or a rate.** An operator
cannot charge more, cannot discount, cannot waive. There is nothing to configure and therefore
nothing for the deployer to ask.

**2. The *sender* sets the fee; each hop enforces a hard-coded floor.** The wallet passes
`--fee_per_hop`, carried per-layer inside the onion. Each hop verifies its own layer and rejects
with **`FeeTooLow`**. The floor is Grin's own fee schedule, not a policy:

| Role | Floor | = |
|---|---|---|
| Swap server | `weight_by_iok(1, 1, 1) × fee_base` | (1 in + 1 out + 1 kernel) |
| Mixer | `weight_by_iok(0, 0, 1) × fee_base` | (1 kernel) |

With Grin's default `accept_fee_base` of 500 000 nanogrin and weights (input 1, output 21,
kernel 3), the swap-server floor is `(1 + 21 + 3) × 500 000` = **12 500 000 nanogrin** — *exactly*
the `--fee_per_hop 12500000` in forum post #20. **The dev's published number is the protocol
minimum, not a price he chose.**

**3. Where the money goes — miners first, operator only on the leftover.** From `src/tx.rs`:

```rust
if fees_paid > min_kernel_fee + fee_to_collect + fee_to_spend {
    let amount = fees_paid - (min_kernel_fee + fee_to_collect);
    kernel_fee -= amount;
    let wallet_output = wallet.async_build_output(amount).await?;
    txn_outputs.push(wallet_output.1);
```

Fees paid first cover `min_kernel_fee` — the Grin **network** fee, which goes to **miners**. Only
the surplus above that *plus the cost of creating and later spending the collection output*
(`fee_to_collect` = 21 × fee_base, `fee_to_spend` = 1 × fee_base) is swept into an output owned by
the hop's own wallet. Each hop calls `async_assemble_components(&self.wallet, …)` with **its own**
wallet, so `fee_per_hop` really is per hop.

**Consequences:**
- **Zero fee is impossible** — not an operator choice, a protocol fact. A Grin transaction with no
  kernel fee is rejected by the mempool, and the `FeeTooLow` check rejects it a layer earlier.
- **Zero *revenue* is the default at the floor.** If the surplus does not clear
  `fee_to_collect + fee_to_spend` the branch is skipped, the amount stays in `kernel_fee`, and
  **everything goes to miners**. The operator earns nothing without doing anything.
- **Revenue, when it exists, is residual and batch-driven** — it comes from amortising one kernel
  across N swaps, not from a markup. Order of magnitude at the floor: a batch of 10 leaves roughly
  0.013 GRIN for the hop. *(Arithmetic derived here from the weights above, not read from upstream
  — treat as a scale estimate, not a figure.)*
- **⚠ The hop's wallet therefore accumulates real coins on mainnet.** The README is explicit: *"A
  grin-wallet account must be created for receiving extra mwixnet fees."* This has two
  consequences the earlier draft missed — see **D.5 #4** (the wallet seed is a *third* thing that
  must be backed up) and **D.5 #8** (a 24/7 unlocked owner API holding accumulated funds).
- **`fee_base` itself is not in `ServerConfig`** (`self.get_fee_base()` resolves elsewhere —
  ⚠ source not yet read). If it turns out to be operator-settable by some other route, that *would*
  be a pricing knob and D.7b would need revisiting. Check at build time.

## D.4 ⚠ Corrections to earlier assumptions

Recorded because both were stated before the source was read, and both change the build:

1. **"A mixer needs no wallet — it's the cheap half." FALSE.** `src/servers/mix.rs` takes **three**
   clients: a **Wallet** (`async_assemble_components` — builds outputs/rangeproofs), a **GrinNode**
   (`async_is_unspent` — UTXO checks), and an optional **MixClient** (forward to the next hop). So a
   mixer needs a **synced node *and* a running grin-wallet owner API**, exactly like the swap
   server. The mixer is cheaper only in *exposure* (no public wallet-facing API), not in
   dependencies.
2. **"Reuse our Tor plumbing." FALSE.** Arti is embedded (D.3); there is no system hidden service
   to configure or back up the usual way.

## D.5 Toolkit-specific gotchas (each one is a live-deploy failure)

1. **⚠ Node secret path points at the WRONG endpoint by default.** mwixnet defaults the node secret
   to `.api_secret`, but it uses the node for `is_unspent`/`push_transaction` — both **Foreign API**
   methods per CLAUDE.md's method split. On our nodes `.api_secret` is the **Owner** secret and
   `.foreign_api_secret` is the Foreign one. The deployer **must** set
   `grin_node_secret_path` to the Foreign secret, resolved through
   `grin_node_secret_path <net> foreign` in `scripts/lib/grin_node_secrets.sh` — never a frozen
   literal path, or a node prune↔full rebuild silently 401s the mixer. **Add a `grin_sync_mwixnet`
   applier to `grin_secrets_sync_all` and call `grin_install_secret_sync` from 092 setup.**
2. **⚠ `wallet_owner_url` has no testnet default.** It is `127.0.0.1:3420` on *both* chains, but
   the toolkit runs testnet wallets on **13420**. A testnet mixer left on the default will talk to
   the mainnet wallet if one is running, or fail. Always write it explicitly per network.
3. **⚠ Never pass `--wallet_pass`.** It puts the wallet passphrase in `ps aux` / `/proc/<pid>/cmdline`
   for the entire life of a 24/7 service — the exact leak CLAUDE.md already documents for
   grin-wallet's `-p`. mwixnet **prompts** for both the key password and the wallet password, so
   feed them on **stdin** from a mode-600 file, as done for the 05C CMD wallet. This also means the
   service is **not unattended-startable** without that stdin file — decide deliberately, and
   never bake the password into a systemd unit or `EnvironmentFile` in cleartext.
4. **THREE independent secrets, all catastrophic to lose** *(was two — the wallet was added
   2026-08-04 after D.3b showed the hop's wallet receives fee outputs):*
   - `mwixnet-config.toml` — upstream's README is explicit that it holds **the only copy of the
     server's private key** (encrypted with the key password). Lose it and the route identity is
     gone; leak it *and* the password and an attacker becomes the hop.
   - `{data_dir}/tor/state/keystore` — the **onion identity**. Lose it and our published `.onion`
     changes, breaking the route until the upstream operator reconfigures.
   - **the hop's grin-wallet seed** — on mainnet this wallet accumulates residual fee outputs
     (D.3b), so it holds **real value**, not just an API endpoint. It is the only one of the three
     whose loss costs money rather than identity.
   All three must go into Script 089 and the shared backup engine as a new `mwixnet` product. None
   is covered by any existing backup step (D.3) — Script 04's onion backup globs `grin-*`
   system-tor dirs and never sees an Arti keystore.
5. **Bind loopback.** `addr` / `--bind_addr` is what Arti forwards onion traffic to; there is no
   reason for it to be world-reachable. Default it to `127.0.0.1:<port>` and pick a port that
   avoids the toolkit's known collision points (8080 is the worst — see the 091 first-deploy
   incident; 3413/3420/13413/13420/7456/7466/3333/3334/8471 are taken).
6. **Build cost on a small VPS.** A full `grin_*` + Arti cargo build is heavier than floonet-rs.
   Reuse 091's pattern: prebuilt probe first (none exist today), rustup minimal profile only when
   cargo is absent, and the temporary 2 GB swap offer for boxes under ~3.5 GB RAM.
7. **Unpinned upstream branches (D.3) make the build non-reproducible.** `grin` `master` and
   `grin-wallet` `contracts` can move under us at any time and break a build that worked last week
   — with no upstream release to fall back on. **Mitigation: pin to a known-good commit** of
   mwixnet in `grin_mwixnet.conf` (the 091 `FLR_INSTALLED_REV` precedent) and treat "builds today"
   as a fact with a date attached, not a property.
8. **⚠ A 24/7 unlocked wallet holding funds** *(added 2026-08-04 with D.3b).* The mixer cannot
   build outputs without a *running, unlocked* owner API (D.4 #1), and on mainnet that same wallet
   accrues residual fee outputs (D.3b). That is the **pool-wallet risk class**, not the "wallet as
   a dumb output builder" class assumed earlier: an attacker with host access gets a hot wallet,
   not merely a stalled hop. Carry over the pool's mitigations — a dedicated wallet per network,
   sweep accumulated fees to cold storage on a schedule instead of letting them pile up, and never
   leave the passphrase reachable from argv or a cleartext `EnvironmentFile` (#3).

## D.6 What we build vs reuse

| Concern | Reuse | Build new |
|---|---|---|
| Rust toolchain, swap offer, source build, rev pinning | 091 patterns (`flr_*` shape) | `mwx_*` equivalents |
| Node/wallet secret resolution | `grin_node_secrets.sh` (+ new `grin_sync_mwixnet`) | applier fn |
| Backup | shared engine `gbe_*`/`gbp_*` + Script 089 step | new `mwixnet` product: config.toml + Arti keystore |
| Hardened systemd unit | 091's unit shape | stdin-fed password start (D.5 #3) |
| Public HTTPS surface | **nothing — none needed** | — |
| nginx / certbot / rate-limit zones | **not applicable** (onion-only, D.3) | — |
| Route join | — | `mwixnet pubkey` display + operator hand-off screen |
| Menu | 09 hub `run_sub` + `_092_installed`/`_092_status` detectors | hub row (positional key) |

Expected files when the build starts: `scripts/092_grin_mwixnet_mixer.sh`,
`scripts/lib/092_lib_build.sh`, `scripts/lib/092_lib_mixer.sh`, deployer conf
`/opt/grin/conf/grin_mwixnet.conf`. **No `web/` directory** — there is no UI surface.
*(Kept in sync with D.10.1, which is the authoritative file list.)*

## D.7 Security requirements to enforce at build time

Mirrors the checklist discipline in `script09_security_audit.md`; fold these in when 092 lands.

1. Config file **0600**, owned by the service user; it is an encrypted-private-key file.
2. Passwords via **stdin only** — never argv, never a cleartext `EnvironmentFile` (D.5 #3).
3. `addr` forced to loopback (defense-in-depth: Arti is the only intended ingress).
4. Node/wallet secrets resolved live, never frozen (D.5 #1); reuse the 5-min secret-sync timer.
5. Backup covers **both** secrets (D.5 #4) and is offered at end of guided setup, as 091 does.
6. `prev_server` must be **required** for a mixer install — an empty `prev_server` on a
   mixer-intended deploy means it accepts onions from anyone. Validate it as a hex Dalek pubkey
   before writing, and refuse the "mixer" role without it. *(This mirrors the 091 GoblinPay
   `pay_mode`-without-`url` trap: a menu that lets an operator set a half-configured mode is the
   bug, not the operator's mistake.)*
7. **Operator-facing honesty screen** before install, and **network-aware** (see D.7b). This is a
   coin-mixing service; in some jurisdictions operating one carries regulatory exposure that a
   Nostr relay does not. Several participants in the upstream community test cited exactly this as
   their reason not to run a node. State it plainly, once, at the moment of choice — do not bury it.

## D.7b Regulatory posture — three distinct roles, one real lever

**Not legal advice; no lawyer was involved in writing this, and it is jurisdiction-dependent.**
Recorded because it shapes a product decision (defaults), not to settle the law.

**Do not merge these three roles — their exposure is very different:**

| Role | Posture |
|---|---|
| **Writing/publishing `092_*.sh`** in a public toolkit | Publishing open-source software. US FinCEN's 2019 guidance distinguishes an *anonymizing **software** provider* (not an MSB) from an *anonymizing **service** provider* (may be). This sits on the software side. |
| **Operating a testnet hop** | Testnet coins have **no monetary value** — money-laundering and money-transmission theories both require *money*. The strongest available position. |
| **Operating a mainnet hop** | Where the real question lives. Jurisdiction-specific; get local advice before doing it. |

**The argument in favour:** mwixnet is **non-custodial** — a hop never holds or controls user
funds, and custody/control is the usual hinge for money-transmitter classification.

**The honest counter-evidence** (non-custodial has *not* been a reliable shield in practice, as of
a May 2026 knowledge horizon — re-check before relying on any of it): **Tornado Cash**
(non-custodial contract; OFAC-sanctioned 2022; developer convicted in NL 2024; Fifth Circuit found
OFAC overstepped on the immutable contracts and it was delisted March 2025) and **Samourai Wallet**
(non-custodial coinjoin; founders arrested April 2024, unlicensed money transmitting + laundering
conspiracy).

**Risk factors, roughly in order:** (1) operator's jurisdiction; (2) mainnet vs testnet;
(3) **VPS provider AUP** — the most concrete and checkable; (4) **fees — a weak factor, and mostly
out of the operator's hands anyway** (see below). *(Ordering corrected 2026-08-04: fees were ranked
(3), above AUP. D.3b and the Tornado Cash precedent both say that was too high.)*

**On fees specifically, since it is the obvious lever to reach for.** An earlier draft of this
section said "a fee-free hop is a materially different posture," implying the operator chooses.
**They do not — D.3b: there is no fee setting in the server config at all.** What that does and
does not buy:
- ✅ *Helpful:* there is no price to point at. The operator cannot charge, discount or waive, the
  published `--fee_per_hop 12500000` is exactly Grin's protocol minimum, and the bulk of it is the
  **network fee to miners**. "Setting a price for a service" is simply not a thing this software
  lets an operator do — a cleaner fact than a policy of not charging, because it is structural.
- ⚠ *But not zero:* the residual above the kernel fee is swept into the hop's own wallet, and the
  README requires creating a wallet **"for receiving extra mwixnet fees."** A receiving wallet
  exists by design. Revenue is often zero at the floor (D.3b) but that is an accident of
  arithmetic, not a stance you can assert.
- ❌ *And it is not a shield.* **Tornado Cash's contracts charged no fee at all** and were
  immutable — the developer was still convicted in the Netherlands in 2024 and the contracts were
  sanctioned. Taking no fee did not prevent any of it. Anyone treating "we don't charge" as
  protection is reasoning from the wrong precedent.
- **If genuine zero revenue matters to you**, the only reliable route is a local patch dropping the
  `wallet.async_build_output(amount)` sweep so the surplus stays in `kernel_fee` and goes to
  miners. It is a ~2-line change that alters **no wire behaviour** — but it means maintaining a
  fork against the house rule of deploying upstream unmodified (091's "we deploy, we don't fork"),
  and it must be re-applied on every rev bump. **Do not default to it.** If it is ever offered, it
  belongs behind an explicit menu item that states the fork cost, never as a silent build flag.

**On the AUP factor:** mwixnet runs an onion **service**, not a Tor **exit node** — no third-party
traffic egresses in the operator's name, and it generates none of the abuse complaints that get
exits terminated. Many AUPs that forbid exits permit services. This is the one factor an operator
can actually check in ten minutes, which is why it ranks above fees.

**⚠ Separation is NOT the safeguard.** Running mainnet and testnet as separate instances is
toolkit convention already (separate ports/dirs/services) and is correct for operational reasons —
but it buys **nothing** legally. The protection comes from testnet coins being valueless, i.e.
from *not running mainnet*, not from the two being separated. Do not let the existence of clean
separation read as a compliance measure.

**Product decision:** ship **both** networks — the toolkit deploys *user-owned* infrastructure, and
refusing mainnet would impose our jurisdiction's risk calculus on every operator. But **default to
testnet**, and surface the difference at the moment of choice (D.10.2), not in a doc nobody opens.

## D.8 Open questions (092) — status after the 2026-08-04 second pass

| # | Question | Status |
|---|---|---|
| 1 | **Is upstream alive?** | ✅ **ANSWERED — yes.** Two PRs inside 8 days; route live 2026-08-03. Earlier "stalled" read came from looking at `main`. |
| 2 | **Does it build?** | ⚠ **Not from `main`.** Build target is PR #34's branch against `staging`; "tested with e2e tests" per author, unverified by us. |
| 3 | **Which route do we join?** | ⚠ **Gate on USEFULNESS only — not on building or testing.** *(Corrected 2026-08-04: an earlier draft implied we were blocked until an operator adds us. We are not — see D.2b.)* Building and full E2E testing need **no external party**: run both hops ourselves. What needs a counterparty is *providing real privacy*, since that requires hops under independent control. Post #20 asks for *testers*, not *operators*; joining = ask wiesche89 to set our pubkey as his `next_server`. No route discovery exists. |
| 4 | **Mainnet or testnet first?** | ✅ **Testnet, decisively.** That is where the only route is; the wallet CLI examples are all `--testnet`. A mainnet mixer today would be inert. |
| 5 | **Fee split** | ✅ **ANSWERED 2026-08-04 — see D.3b.** No fee field exists in `ServerConfig`; the sender sets `--fee_per_hop`, each hop enforces a protocol-derived floor (`FeeTooLow`), the kernel fee goes to **miners**, and only the surplus is swept to the hop's own wallet — often nothing at the floor. **Operators have no pricing knob.** Consequences landed in D.5 #4, D.5 #8, D.7b. |
| 5b | `interval_s` semantics | ❓ Open. Mixing-round interval in seconds; default value still not captured. Read from a clone. |
| 6 | Pruned vs archive node | ❓ Open. `is_unspent` is a UTXO query, not `get_block`, so a pruned node *should* serve it — but confirm before sizing a box. |
| 7 | **NEW — do we build against unmerged PRs?** | ⚠ The whole stack is two **unreviewed WIP PRs** from a contributor fork, awaiting `ardocrat`. They will be rebased/squashed/changed in review. **This is the reason not to write deployer code yet** (see D.9). |

## D.9 Verdict — build the SHAPE now, not the code

**Revised 2026-08-04 after the second pass.** The earlier verdict ("design-ready, build-gated on
whether upstream is alive") is superseded: upstream *is* alive, and more active than any other
Script-09 dependency. The gate moved, it did not close.

The reason to hold off is now **D.8 #7, not staleness**: the server and the wallet support both
live in unmerged, unreviewed PRs targeting `staging`. Deployer code written against those branches
would be written against a moving target — exactly the trap CLAUDE.md's "confirm root cause before
editing" discipline warns about, one level up. PR #34 alone changes server configuration and adds
HTTPS endpoints, so the config schema in D.3 is provisional *by the author's own description*.

**What is stable right now is the operator-facing interface, not the implementation.** What an
operator must *do* — build, generate a key, publish a pubkey, name a previous hop, point at a node
and a wallet, run behind an onion, back up two secrets — follows from the CoinSwap design and will
not change when the PRs are rebased. That is exactly the layer worth committing to now, so the
build becomes mechanical the day the PRs merge.

→ **D.10 sketches that interface.** Sequence: sketch now (done) → ask about joining a route
(D.8 #3, the true gate) → throwaway-VM build from PR #34 to validate the schema → write `092_*.sh`
when the PRs merge or the schema is confirmed stable.

## D.10 Structure & menu sketch (interface-first, 2026-08-04)

**Not code, and deliberately so.** Every element below is derived from the CoinSwap *design*
(D.2) or from toolkit convention, never from a field name that PR #34 might rename. Where an item
depends on schema that could move, it is marked ⚠.

### D.10.1 Files

```
scripts/092_grin_mwixnet_mixer.sh    entry: honesty screen → network select → menu
scripts/lib/092_lib_build.sh         mwx_build_*  rust/cargo, rev pin, swap offer, update
scripts/lib/092_lib_mixer.sh         mwx_*        config, role, service, status, backup, uninstall
/opt/grin/conf/grin_mwixnet.conf     deployer conf (net, pinned rev, role, install paths)
/opt/grin/mwixnet-<net>/             data dir: mwixnet-config.toml + tor/{state,cache}
```
Function prefix **`mwx_`** (091 = `flr_`, 093 = `trp_`). **No `web/` directory** — there is no UI
surface. Two libs rather than 091's one because the Rust build half is reusable and independently
testable; merge them if `092_lib_build.sh` stays under ~150 lines.

### D.10.2 Entry — the honesty screen (D.7 #7)

Shown **once**, before anything is installed, on first entry only (flag in `grin_mwixnet.conf`):

```
092) GRIN COINSWAP MIXER — before you install

  This runs a coin-mixing service. Two things to understand first:

  • It is NON-CUSTODIAL. A mixer never holds anyone's funds and cannot
    steal them. The worst a broken mixer does is stall a swap.
  • In some jurisdictions, OPERATING a mixing service carries regulatory
    exposure that running a relay or a node does not. Several people in
    the upstream community test cited exactly this as their reason not to
    take part.

  Privacy comes from INDEPENDENT operators. Running two hops of the same
  route yourself provides no privacy at all — and makes YOU the one party
  able to link every input to every output. Fine as a test rig. Never as
  a service.

  Nothing has been installed or changed.        [ Continue / Back ]
```

**Network choice is the risk decision, so it carries the second half** (D.7b). Testnet is the
default and needs no extra confirmation; mainnet takes one explicit acknowledgement:

```
  Network:  [1] Testnet  (default)      [2] Mainnet

  ── if 2 ─────────────────────────────────────────────────────────────
  Mainnet moves coins with real monetary value. Testnet coins do not,
  which is why testnet carries far less regulatory exposure — the
  protection is the lack of value, NOT the fact that the two run
  separately.

  Rules differ by country and this toolkit cannot advise you. If you
  have not checked your own jurisdiction and your VPS provider's
  acceptable-use policy, choose testnet.

  Type MAINNET to continue, anything else to go back:
```
Rationale for a typed confirmation rather than `[y/N]`: this is the one irreversible-in-reputation
choice in the product, and it should not be reachable by a reflexive Enter. Everything else in
092 stays default-Yes per house style.

### D.10.3 Main menu

Network select first (093's pattern — testnet and mainnet are separate installs). Banner prints
the script number; the hub row shows only the name (CLAUDE.md naming rule).

```
 092) GRIN COINSWAP MIXER — [TESTNET]

   Route
   1) Guided setup                       (build → key → role → links → onion → start)
   2) My public key                      → hand this to the route operator
   3) Route position                     prev_server / next_server / role
   4) Node & wallet links                node url+secret, wallet owner url+secret

   Run
   5) Start / Stop / Restart
   6) Status                             service · onion · node · wallet · route
   7) Live logs

   Maintenance
   O) Onion identity                     show .onion, export, rotate (warns: breaks the route)
   B) Backup & restore                   config.toml + Arti keystore
   U) Update / rebuild                   pinned rev → new rev
   D) Uninstall
   0) Back                               Select [1-7 / O / B / U / D / 0]
```

**Why these seven.** 1–4 are the four things that must be true before a mixer can work at all
(binary exists, key exists, position in the route known, node+wallet reachable); 5–7 are day-2.
Option **2 is the product's whole external interface** — `mwixnet pubkey -o FILE` output plus the
onion address, formatted for pasting to the route operator — so it earns a top-level slot rather
than living inside a submenu.

### D.10.4 Guided setup — step order and the two refusals

```
 1. Preflight    OS/RAM/disk; warn <3.5 GB RAM → offer temporary 2 GB swap (091 pattern)
 2. Toolchain    rustup minimal profile only if cargo absent; clang/llvm; probe protoc
 3. Fetch+build  ⚠ from the PINNED REV (D.5 #7), NOT main (D.3). Record rev in conf.
 4. Role         ┌ Mixer          (needs prev_server)  ← the intended role
                 ├ Last mixer     (prev_server, no next_server)
                 └ Swap server    (public wallet-facing API — warns: bigger exposure)
 5. Key          mwixnet init-config → passwords via STDIN, never argv (D.5 #3)
                 → immediately: "back this up, it is the only copy" + offer step 10 now
 6. Node link    grin_live_node_dir + grin_node_secret_path <net> foreign   ⚠ FOREIGN, not owner
                 install grin-secret-sync (D.5 #1); verify with a live probe
 7. Wallet link  owner API url per network — 3420 main / 13420 test, never the 3420 default
                 (D.5 #2); verify reachable before writing
 8. Route        enter prev_server (+ next_server unless last hop); validate hex Dalek pubkey
 9. Onion        start once, capture the Arti .onion, show it; no nginx/certbot anywhere
10. Backup       offer daily encrypted backup now — config.toml + Arti keystore + WALLET SEED
                 (D.5 #4: three secrets, not two)
11. Done         print pubkey + onion + "send these two lines to the route operator"
                 ⚠ do NOT print a fee — the operator sets none (D.3b); senders choose it
```

**⚠ Steps 8 and 9 were swapped on 2026-08-04 (review finding).** The draft harvested the onion at
step 8 and only asked for the route at step 9 — but capturing the onion means *starting the
server*, and starting it before `prev_server` is known starts a mixer that accepts onions from
anyone. That is precisely the state the first hard refusal below exists to prevent, reached by the
guided path itself. **Route position must be fully validated before the process is ever started.**

Two hard refusals, both from D.7 — a menu that lets an operator reach a half-configured state is
the bug, not the operator's mistake (the 091 GoblinPay `pay_mode`-without-`url` lesson):

- **Refuse role=Mixer with an empty `prev_server`** — a mixer with no declared upstream accepts
  onions from anyone.
- **Refuse to start when node or wallet is unreachable** — a mixer that cannot reach either one
  stalls swaps silently, and a stalled hop is indistinguishable from a malicious one to everyone
  upstream.

### D.10.5 Status screen — what "healthy" must actually prove

Modelled on the 091 second-deploy lesson: *a handshake probe that only proves a socket answered
proves nothing.* `✓ handshake OK` on a crash-looping relay cost a full debug cycle.

```
Service      active (running)   since 2026-08-04 09:14      [systemd]
Binary       mwixnet <rev>      built 2026-08-04
Onion        mza3u6…cwqd.onion  (Arti, in-process)
Node         127.0.0.1:13413    ✓ get_status via FOREIGN secret       ← real call, not a ping
Wallet       127.0.0.1:13420    ✓ owner API responds
Role         Mixer              prev ba2ee2…bc4e   next —
Route        ⚠ prev_server set, never contacted        ← never-contacted ≠ healthy
Backup       last run 2026-08-04 03:00                 config + keystore
```

The `Route` row is the one that must not lie: an idle mixer and a broken mixer look identical from
the outside, so distinguish **"configured"** from **"has actually relayed an onion"** and never
render the former as green. (Same rule that made never-handshaked pool gateways red, not blue.)

### D.10.6 Hub wiring

`09_grin_comms_hub.sh` gains a third row using the existing badge helpers — positional key, name
only, no number on the row:

```bash
_092_installed() { [[ -x /usr/local/bin/mwixnet ]] || [[ -d /opt/grin/mwixnet-main ]] || [[ -d /opt/grin/mwixnet-test ]]; }
_092_status()    { systemctl is-active --quiet grin-mwixnet-main || systemctl is-active --quiet grin-mwixnet-test; }
...
echo -e "  ${GREEN}2${RESET}) CoinSwap Mixer          $(_badge _092_installed _092_status)"
2) run_sub "092_grin_mwixnet_mixer.sh" || true ;;   # ||-guard: menu loops under set -e
```
Adding it shifts the Transporter's positional key 2 → 3. Safe: 093 has never been VPS-deployed, so
no operator has muscle memory for that key, and the per-product banner is the mis-key safety net.

**✅ The row is LIVE as of 2026-08-04 — but as a reservation, not the wiring above.** The key shift
already happened; only the dispatch differs until the build lands.

*Why it was added before the product exists:* the operator pulled the reserved-number commit to a
VPS and reported the mixer "missing from the menu." **A reserved number that is invisible in the UI
reads as a missing feature** — a documentation-only reservation is invisible to the person actually
using the tool. That is the same failure mode CLAUDE.md records for dead keys, arriving from the
other direction.

```bash
# interim (now): key 2 is live, dispatches to a one-screen notice, installs nothing
echo -e "  ${GREEN}2${RESET}) CoinSwap Mixer          ${YELLOW}⏳ reserved — not built yet${RESET}"
2) _slot_notice "092) GRIN COINSWAP MIXER — NOT BUILT YET" "…" \
       "docs/generated/script09_design.md (PART D)" || true ;;
```
`_slot_notice()` was **ported from hub 05** into 09 (identical body). Hub 09 keeps **positional**
keys — this is not a move to fixed slots; only the notice helper crossed over.

**At build time, swap the interim arm for the badge wiring above** — replace it, never add a second
`2)` arm. Two arms for one key is dead code (bash takes the first match) and would silently keep
opening the notice after the product shipped. The menu legend line
(`⏳ = the slot is reserved…`) comes out with it, if 092 is the last reserved row.

### D.10.7 Explicitly out of scope for 092

- **No nginx, no certbot, no vhost, no rate-limit zone** — the public surface is the Arti onion
  (D.3). If a future PR adds the HTTPS endpoint hinted at in #34, revisit; do not pre-build it.
- **No swap-server-by-default.** The role exists in the menu but the *product* is the mixer; the
  swap server is the public front door and a different risk posture.
- **No wallet-side integration.** Making *our* products swap their coins is a separate question
  that belongs to 05/07, gated on grin-wallet PR #783 merging.
- **No route discovery.** Upstream names it as future work; we do not invent a competing one.

---

## Recommendation (hub build order — revised 2026-08-04)

1. **091 Floonet relay deployer — BUILD NOW.** Upstream verified (A.2b): floonet-rs bare-metal
   (source build: Rust + protoc), reuse his `install.sh` conventions + hardened systemd unit,
   replace Caddy with our nginx/certbot using his own tested nginx-WebSocket block, day-2 admin.
   Build `scripts/lib/nostr_relay_deploy.sh` (PART C.1) here — 091 is its first consumer.
   Immediately useful to the existing Goblin/Floonet user base.
2. **GoblinPay under 05** — reuse `nostr_relay_deploy.sh` for bundled mode; auto-detect and offer
   an installed 091 relay for external mode (PART C.2). Lands in the 05 hub, not 09.
3. **093 Transporter Phase 1 — ✅ BUILT 2026-07-11 (standalone).** Server + auth challenge +
   CLI agent on the Node+SQLite+Tor+grin-wallet stack, Slatepack crypto from grin-wallet, no
   grinbox/MQS fork. Local verification done (crypto interop + HTTP E2E); the **testnet round
   trip between two wallets never online simultaneously** is the remaining live-VPS proof.
4. **092 mwixnet CoinSwap mixer — NEXT; structure sketched, code held (2026-08-04).** PART D.
   Upstream is **active** (PRs #34 + #783 within 8 days, live testnet route 2026-08-03), so the
   old "is it alive" gate is closed. Code is held for a different reason: both PRs are **unmerged
   and unreviewed** against `staging`, and #34 changes server configuration — deployer code today
   would target a moving schema. **D.10 commits the operator-facing interface** (menu, step order,
   refusals, status semantics), which the CoinSwap design fixes regardless of how the PRs land.
   Next actions, in order: **(a)** ask wiesche89 about running an independent hop — D.8 #3 is now
   the only real gate; **(b)** throwaway-VM build from PR #34 to confirm the config schema;
   **(c)** write `092_*.sh` on merge. Deployer is *smaller* than 091 (onion-only: no nginx, no
   certbot, no web UI); genuinely new work is the Arti-keystore backup and the stdin password start.
5. **093 Transporter Phase 2 — DEFERRED, gated.** Wire into payouts (Script 07 enqueues via 093
   instead of Tor-direct + 7-day retry) and 059 Drop "send to my Transporter" claims — *gated on
   B.9 #6 receive-support*. Ranked below the mixer because its gate (wallet vendors shipping
   relay-receive) is one we cannot move; the mixer's gate is a conversation we can have.
