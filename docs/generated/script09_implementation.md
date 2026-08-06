# Script 09 — Implementation notes

**Scope:** what is actually built, per member. Design/rationale lives in
`script09_design.md`; this file records the implemented shape and the decisions
locked at implementation time.

---

## 091 — Floonet relay deployer (implemented 2026-07-10)

Deploys upstream `floonet-rs` (github.com/2ro, docs.floonet.dev) — we deploy,
we don't fork. Not yet exercised on a live VPS (upstream repo checked
2026-07-10; `bash -n` clean; TOML editor unit-tested locally).

### Files

| File | Role |
|---|---|
| `scripts/091_grin_floonet_relay.sh` | Entry point: guided setup wizard + monitor/admin menu |
| `scripts/lib/091_lib_floonet.sh` | `flr_*` helpers: setup steps, config.toml editor, dashboard, config menus, update/mixexit/uninstall, backup (product `floonet`) |
| `scripts/lib/nostr_relay_deploy.sh` | `nrd_*` shared primitive (design PART C.1): wss vhost via HTTP-first→certbot→SSL, firewall, WebSocket-handshake + NIP-11 probes. 091 is the first consumer; GoblinPay's bundled relay reuses it. |

No `web/091_*` — Floonet ships its own relay; we add no app code.

### Layout (upstream install.sh conventions, reused not reinvented)

```
/usr/local/bin/floonet-rs          binary
/etc/floonet-rs/config.toml        config (0600; 0640 root:floonet under fallback unit; 0644 if the installed unit is DynamicUser — token lives in env, not here)
/etc/floonet-rs/env                optional env overrides (FLOONET_GOBLINPAY_TOKEN), 0600
/var/lib/floonet-rs                state (SQLite)
/opt/grin/floonet/src              cloned source / build dir
/opt/grin/conf/grin_floonet.conf   deployer settings (FLR_DOMAIN/FLR_EMAIL/backup)
/etc/nginx/sites-available/floonet-relay          wss vhost
/etc/nginx/conf.d/script09-floonet[-conn].conf    zones floonet_ws (60r/m) + floonet_conn
```

### Guided setup (option 1) — newbie path

Intro screen (what you get / what you need / the 8 steps) → all questions
up-front (domain with DNS A-record pre-check against the server's public IP,
certbot email, relay name, description) → summary confirm → hands-off:

1. deps (git, compiler, `protoc`, ssl headers, sqlite3) — apt/yum
2. Rust via rustup minimal profile, only if cargo absent
3. clone/refresh `floonet-rs` source
4. build: **prebuilt-release probe first** (GitHub API; none exist as of
   2026-07-10), else `cargo build --release`; **temp 2 GB swap offer** on
   <3.5 GB RAM boxes (removed after build)
5. install: run upstream `deploy/install.sh` when present; verify/complete
   (binary → /usr/local/bin, unit, config seed from repo example) either way
6. `info.relay_url = wss://<domain>/` + name/description;
   `database.data_directory` always re-pointed at /var/lib/floonet-rs and
   `network.address` always forced to 127.0.0.1 (nginx is the only public
   entrance — an upstream example shipping 0.0.0.0 must not win)
7. nginx zones + `nrd_deploy_wss_vhost` + ufw/firewalld 80/443
8. enable + start + local WebSocket handshake verify

Every step idempotent; failures print a "fix and re-run option 1" hint. Final
screen shows the wss:// URL (end-to-end verified when possible) and next steps.
Option 2 re-runs only domain/SSL (post-DNS-fix path).

### Monitor / admin menu

- **3 Status dashboard**: service state/since, binary version, relay_url,
  loopback listener, cert days-remaining, state-dir size + `event` count
  (sqlite3 readonly), journal error count (1h), live local + public
  WebSocket-handshake probes.
- **4 Live logs** (`journalctl -f`, INT-trapped so Ctrl-C returns to menu),
  **5 service control**, **6 test relay** (local ws, public wss, NIP-11 doc).
- **7–11 config menus** — all edit `/etc/floonet-rs/config.toml` via the
  section-aware text-preserving python editor (`_flr_py_toml`; uncomments
  commented defaults, appends missing sections) then offer a restart:
  settings ([info]/[limits] incl. event-kind allowlist), access control
  ([authorization] NIP-42 toggles + pubkey whitelists), NIP-05 name authority
  (one-key enable with domain defaults), GoblinPay (pay_mode/url/prices; token
  goes to the env file + a systemd drop-in `EnvironmentFile=-`, never
  config.toml), raw editor.
- **B backup** — shared engine, product `floonet`: staged
  config+env+deployer-conf+SQLite-snapshot archive,
  `grin_floonet_backup_DDMMYYYY.tar.gz.enc`, restore (typed key), daily
  cron via self-contained wrapper `/usr/local/bin/grin-floonet-backup`
  (regenerated on schedule enable and retention change), offsite push hook.
- **U update** (git fetch → rebuild → reinstall → restart; no-op only when
  origin HEAD == the rev recorded at install time in `FLR_INSTALLED_REV`, so
  a fetch followed by a failed build can't fake "up to date"), **M mixnet
  exit** (optional add-on: builds
  `floonet-mixexit` from the relay tree or its own repo when reachable, then
  lets upstream install.sh co-install; honest "not available upstream" path),
  **D uninstall** (typed REMOVE; data/config/cert/source removals each opt-in;
  backups never touched).

### Decisions locked (design doc A.4 opens)

- **ONE relay per operator** — network-agnostic transport, no per-net
  instances (matches upstream's single service).
- **Unit**: upstream's hardened unit as-is when his install.sh runs. Toolkit
  **fallback unit uses a stable `User=floonet`**, not DynamicUser — a 0600
  root-owned config is unreadable under DynamicUser; stable user avoids the
  trap and suits backups.
- **Rust policy**: reuse existing cargo, else rustup (root, minimal profile).
- Prebuilt-first probe future-proofs the "publish release archives" upstream
  PR candidate without blocking on it.

### Review + hardening pass (2026-07-11, pre-VPS-test)

Deep logic/security review of all three files; every finding fixed same day:

- **TOML editor** (`_flr_py_toml`) rewritten set-mode: prefers the ACTIVE
  `key =` line and only uncomments a `# key =` docs line when no active line
  exists (the old first-match-wins produced duplicate keys → Rust toml parse
  failure → relay refused to start); drops pre-existing active duplicates;
  handles files without a trailing newline; get-mode strips inline `#`
  comments off bare values (was breaking `flr_port` silently). 9-case
  behavioral test suite passed against the shipped heredoc.
- **`network.address` forced to 127.0.0.1** in `flr_ensure_config` (was only
  pinning data_directory — an upstream 0.0.0.0 example would have exposed the
  bare relay port past the nginx limits).
- **DynamicUser config readability**: ensure_config + restore now chmod 644
  when the installed unit is `DynamicUser=yes` (0600/0640 root files are
  unreadable there; safe — secrets live in the env file only).
- **Update correctness**: `FLR_INSTALLED_REV` recorded in grin_floonet.conf
  at install; U compares against it, not the fetch delta.
- Leftover 2 GB build-swap file from an interrupted run is swapoff'd/removed
  at the next build-memory check; mixexit build no longer hides cargo stderr.
- Input validation: whitelist entries must be 64-hex pubkeys
  (`_flr_set_pubkey_array`), GRIN prices `^[0-9]+(\.[0-9]+)?$`; declining a
  bool toggle no longer offers a pointless restart; uninstall `rm -rf` paths
  carry `${VAR:?}` guards; `nrd_ws_handshake_test` max-time 10→4 s (curl
  always waits out the timeout after a 101, dashboards were stalling 20 s).

Still open until a live VPS run (unchanged watch list): upstream install.sh
behavior (may prompt/build), the `--config` flag name in the fallback unit,
the real `[network]` schema key names, protobuf-compiler availability on
Rocky/Alma, whether upstream's unit actually uses DynamicUser, and the
unverified prebuilt-release probe (no upstream releases exist yet — no
checksum on that path by design, HTTPS+GitHub trust only).

### Not built / future

- GoblinPay-side composition (05 member consuming this relay) — PART C.2.
- ~~093 Transporter remains deferred~~ → Phase 1 built 2026-07-11, see below.

---

## 093 — Grin Transporter Phase 1 (implemented 2026-07-11)

**Standalone only** (user decision 2026-07-11): server + auth + CLI agent. NO
product wiring — Grin Drop 059 stays untouched and the pool's
`incentives.transporter_enabled` stays `false`, both gated on design B.9 #6
(no mainstream wallet can receive from a relay; a Drop claimant / pool miner
would need to run our agent). Phase-1 value: operator-to-operator sends and
the testnet round-trip proof. Not yet exercised on a live VPS (`bash -n` +
`node --check` clean; crypto interop 20/20 and server HTTP E2E 18/18 pass
locally against the real code).

### Files

```
scripts/093_grin_transporter.sh        wizard: net select → server/agent menus (trp_set_network vars)
scripts/lib/093_lib_server.sh          trp_* — node24 install, app deploy, systemd, nginx+certbot, tor, status, uninstall
scripts/lib/093_lib_client.sh          trp_agent_* — agent install (Drop auto-detect), cron poll toggle, actions submenu
scripts/lib/093_lib_backup.sh          trp_backup_* — shared engine, product "transporter" (added 2026-08-05)
web/093_transporter/server.js          Express + node:sqlite queue (NO wallet, ciphertext only)
web/093_transporter/package.json       express only (SQLite via node:sqlite builtin — 059 model, not better-sqlite3)
web/093_transporter/client/agent.js    zero-dep CLI: address/status/send/poll/cancel (Owner v3 ECDH + Foreign v2)
```

### Layout / ports (per net, independent)

- `/opt/grin/transporter-{main,test}/` — `app/`, `config.json`, `transporter.db`
- `/opt/grin/transporter-agent-{mainnet,testnet}/` — `agent.js`, `agent.json` (0600)
- Ports 7456 main / 7466 test, `127.0.0.1` only; services `grin-transporter-{main,test}`
  (hardened unit: NoNewPrivileges, PrivateTmp, ProtectSystem=full, ReadWritePaths=dir)
- nginx vhost `grin-transporter-<net>`, zone `transporter_<net>` 60r/m in
  `conf.d/script09-transporter-<net>.conf`; HTTP-first → certbot → SSL vhost
- Optional tor front: `HiddenServicePort 80 → local port`, marker-guarded torrc block
- Deployer state `/opt/grin/conf/grin_transporter.conf` (key=value); agent cron
  `/etc/cron.d/grin-transporter-agent-<net>` as `grin` + logrotated fixed-name log

### Server protocol (as designed B.6, verified by local E2E)

`GET /health` (redacted counts) · `GET /auth/challenge?addr=` → single-use
nonce (2 min) · `POST /auth {addr,nonce,signature}` → 15-min HMAC bearer token
(per-boot secret, stateless) · `PUT|POST /queue/:addr {slatepack}` open deposit
(armor check, size cap 16 KB default, per-addr depth cap 100, TTL 336 h sweep)
· `GET /queue/:addr` + `DELETE /queue/:addr/:id` token-gated. Signature =
ed25519 over the UTF-8 nonce string; pubkey decoded from the bech32 address
(inline BIP-173 decoder, HRP `grin`/`tgrin` enforced per net — wrong-net
addresses are rejected at the door).

### Agent decisions (delta vs Drop's flows — deliberate)

- **Locks outputs at SEND time** (init → `tx_lock_outputs` → deliver S1), not
  at finalize like Drop: the reply may take days and the wallet must not
  re-select those inputs. `cancel <tx_slate_id>` releases an unanswered send.
  At finalize, a second lock attempt is tolerated (crash cover).
- **`sender_index: 0` + `recipients: [dest]`** (Drop uses null/[]): the payee
  agent needs the sender address from `decode_slatepack_message` to route S2
  back; S1 with no sender is skipped (left to expire).
- `payment_proof_recipient_address: null` kept — same KernelSumMismatch war
  story as 059.
- Poll ordering: `receive_tx` → build reply → PUT reply → only then DELETE
  original; a crash-dupe re-poll hits grin-wallet's "already received" and is
  then consumed. If the reply PUT fails the armored S2 is logged for manual
  delivery.
- `get_slatepack_secret_key` result: first 32 bytes used (64- or 128-hex
  tolerated); PKCS8-wrapped for node:crypto signing; key never leaves the agent.

### Wallet discovery in option 7 (2026-08-06)

Option 7 used to auto-detect only a Grin Drop wallet and otherwise default the
prompt to `/opt/grin/drop-<net>` **whether or not Drop was installed** — so a
Transporter-only box got an `agent.json` pointing at a path that did not exist,
two `warn` lines, and a failure at the first send. Replaced by
`_trp_scan_wallets` (`093_lib_client.sh`), which builds a numbered pick-list.

- **The test is the wallet's own toml, not a path list.** A dir qualifies iff
  `owner_api_include_foreign = true`, `owner_api_listen_port` equals the
  network's owner port, and `.owner_api_secret` exists. Product dirs move (Drop
  052→059, Fidelius rename); a hardcoded path list would silently report "no
  wallet" the day one does. Scans `/opt/grin/*/` and `/opt/grin/*/*/`.
- **A path naming the other network is skipped even when the port matches** —
  `grin-wallet init` writes the mainnet default 3420 into a testnet wallet's
  toml, so an unpinned testnet wallet reads as mainnet on port alone, and
  wiring a mainnet agent to it would push real GRIN through a testnet queue.
  Side effect: such a wallet is invisible to *its own* network's scan too;
  manual entry covers it. Invisible is the safe failure.
- **Pass-file name is discovered, not assumed** — Drop/pool use `.wallet_pass`,
  the CMD wallet uses `<net>_pass_wallet.txt`. Drop's conf may point outside the
  wallet dir, so `grin_drop_<net>.conf` is still consulted for that one case.
- **Zero matches prints what is missing**, names the exact requirement, states
  that a `grin-wallet listen` wallet can never qualify (no Owner API ⇒ no send),
  and points at hub 05 → CMD Wallet Quick Setup → Listener mode `owner_api`.
- Scan root is `TRP_WALLET_SCAN_ROOT` (default `/opt/grin`) purely so the
  matcher can be exercised against a fixture tree off-box.

### Hardening + toolkit-citizenship pass (2026-08-05, server v0.2.0)

Full security audit against the real code → [script09_security_audit.md](script09_security_audit.md)
(11 findings for 093, all fixed same day; 3 open for 091). The shape changes worth knowing here:

- **Deposit abuse is now bounded in five layers**, not one. The old single
  `max_queue_per_addr` cap was a **DoS weapon against the recipient** — a slatepack address is
  public and the body check only looks for the armor markers, so a stranger could fill a victim's
  queue with 100 junk blobs and bounce every real payout for 14 days. The fix that actually
  matters is **fair share** (`max_per_depositor_per_addr`, default 5): one depositor may hold only
  a few slots of any one queue, so burying an address now needs ~20 distinct sources. Around it:
  a global `max_queue_total`, `(recipient, body_hash)` dedupe (which also makes agent retries
  idempotent — a re-PUT returns the original id, 200 not 201), and a per-source hourly quota.
- **The onion front moved to its OWN local port** (7556 main / 7566 test). This is a security
  control, not tidiness: nginx and Tor both land on 127.0.0.1, and a Tor client controls its own
  headers, so with one shared port a forged `X-Forwarded-For` minted a fresh identity per request
  and voided every per-client limit. Classification is now by `req.socket.localPort`; forwarding
  headers are honoured on the nginx port only. **Residual and accepted:** onion callers share one
  identity, so the fair-share cap applies to the onion front *as a whole* — no onion flood can bury
  a queue, but all onion senders together hold at most `max_per_depositor_per_addr` slates for any
  one recipient. A front-wide onion deposit ceiling bounds request cost, since nginx's `limit_req`
  does not cover that path. Both the code header and the menu 4 screen say so.
- **Ownership proofs are throttled and audited.** Lockout is keyed on **`(address, client)`**,
  never the address alone — an address-keyed lockout is a remote DoS, the same trap the pool hit
  (`project_pool_admin_login_security`). On the onion front the lockout is skipped (its key would
  be `(addr,"tor")` for everyone) in favour of a front-wide attempt ceiling. New `auth_events`
  table stores a **salted hash** of the client, never a raw IP; `trp_status` shows a 24 h count.
- **Backup exists** (`B` on the network menu) — shared engine, product `transporter`, **ONE
  archive covering BOTH networks** since the deployer conf and the schedule are per-server.
  Contents: deployer conf + per-net `config.json` + SQLite snapshot + `agent.json` + **the .onion
  secret key**. The queue is ciphertext the server cannot read, so this archive is about
  **identity and continuity**, not confidentiality: lose the onion key and every agent pointed at
  this Transporter silently stops finding it.
- **Uninstall no longer lies.** It strips our marked torrc block (verified not to touch a second
  unrelated hidden service), keeps the HS *keys* with a note, and only removes the backup schedule
  when the other network's instance is gone too.
- Agent deployer fixes: `su -c` args are `printf %q`-quoted (was a command-injection sink taking
  raw prompt input), `agent.json` is written by `JSON.stringify` rather than a heredoc, the
  Transporter URL is validated, and pointing an agent at a **remote cleartext `http://`** now
  requires typed consent — that URL carries a bearer token granting read+delete on the queue.

**DB migration is automatic and tested**: a 0.1.0 database gains `body_hash` / `depositor` /
`meta` / `auth_events`, back-fills hashes, collapses pre-existing duplicates, then builds the
unique index. 10/10 assertions, no slate content lost.

### Re-review of that pass (2026-08-06, server v0.2.1)

The 2026-08-05 fixes were themselves audited, and two more defects surfaced — one a **complete
bypass of the headline fix**. Both were reproduced against the running server first.

- **Bounding deposits does not bound denial (T-12).** All five layers cap what an attacker can
  *put in* a queue. None of them govern what the owner gets *out*. `GET` returned
  `ORDER BY id LIMIT 20` and the agent deletes only what it can process, so junk arriving first
  pinned the delivery window and hid real slates until the 14-day TTL. Reproduced with 25 junk
  deposits from **5 sources — entirely within the new caps**: the real payment never appeared.
  Fix is **ordering, not another cap**: `ORDER BY picked_up ASC, id ASC` (covering index) demotes
  anything already delivered, so a fresh slate reaches the front within `ceil(depth/20)+1` polls.
  `picked_up` now ships in the `GET` response and the agent retires a blob after 5 deliveries —
  **but only when the wallet is demonstrably healthy** (decode succeeded and the slate is simply
  unusable, or decode failed *and* a follow-up Owner-API probe succeeded). Without that probe a
  wallet outage lasting six polls would have deleted payable slates.
- **An ALL-CAPS address created a queue nobody could read (T-13).** `app.use('/queue/:addr', …)`
  lowercased `req.params.addr`, but **Express rebuilds `req.params` for every layer**, so the
  normalisation never reached the handler. Bech32 is case-insensitive, so the uppercase form
  validated and was stored verbatim while `/auth` always issued a lowercase token: `PUT` → 201,
  owner `GET` → 0 slates, uppercase `GET` → 401. Pre-existing, but it silently undermined the
  dedupe and fair-share layers, which key on `recipient`. All handlers now go through a `qAddr()`
  helper.

Harness is at **33/33**; migration harness still 10/10.

> **Transferable lesson:** a hardening pass needs its own audit. The T-1 verification ("flooding is
> bounded") was *true* — it just was not the property that mattered, because a queue can be denied
> by being blocked as well as by being filled.

### ⚠ VPS-test watchlist (first live run)

1. The one remaining design `⚠VERIFY`: `get_slatepack_secret_key(token, 0)`
   response shape against the deployed grin-wallet binary (agent tolerates
   64/128-hex, but confirm).
2. `decode_slatepack_message` sender field serialization (string vs object) on
   the deployed binary — agent expects a bech32 string.
3. Foreign `receive_tx` over the combined owner_api port with empty foreign
   secret (memory says no auth needed on 13420 — verified for pool, reconfirm
   from the agent).
4. node:sqlite emits an ExperimentalWarning on Node 24 — cosmetic (059 lives
   with the same).
5. **Confirm the loopback bind** (`ss -tlnp`) for BOTH listeners — the nginx
   port and, when Tor is on, the onion port. The whole trust split of the
   2026-08-05 pass rests on neither being world-reachable.
6. **Re-run menu 4 on any box that enabled Tor before 2026-08-05** — the onion
   moved to its own port, and a torrc block written by the older code still
   points at the nginx port (which would re-open the header-forgery hole).
7. **Watch the agent's `removed=` count** in the poll log. It should be 0 on a
   healthy queue; a non-zero count means either genuine junk was retired or the
   wallet-health probe is mis-firing. If real slates ever disappear, suspect
   `reapable()` first — raise `REAP_AFTER_PICKUPS` and re-check the probe call.
