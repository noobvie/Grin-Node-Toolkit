# Script 09 — Connectivity Hub (091 Floonet relay / 093 Transporter) — Security Audit

**Scope:** 091 Floonet relay deployer, 093 Grin Transporter (server + agent + deployer), and the
shared `lib/nostr_relay_deploy.sh` primitive they both lean on.

**Audit date:** 2026-08-05, **re-reviewed 2026-08-06** · **Auditor:** Claude · **Method:** read of
the actual code, plus a local end-to-end harness that drives the real `server.js` (33 assertions)
and a schema-migration harness (10 assertions). **Neither product has run on a VPS**, so every
finding about *deployment* behaviour is code-reading only and is marked as such.

> **The 2026-08-06 pass re-reviewed the 2026-08-05 fixes themselves** and found two further
> defects — T-12 and T-13 — one of them a complete bypass of the T-1 fix. Both were reproduced
> against the running server before being fixed. Lesson worth keeping: **a hardening pass needs
> its own audit.** T-1 was verified as "flooding is bounded" and that verification was true; it
> simply was not the property that mattered, because a queue can be denied by being *blocked* as
> well as by being *filled*.

> **Supersedes the 2026-07-10 verdict** ("nothing to audit yet — both are unimplemented
> placeholders"), which was correct when written and badly stale by 2026-08-04. The old file
> carried a *checklist of requirements to verify later*; this file carries **findings against the
> code that exists**.

---

## Status

| Member | State | Audit |
|---|---|---|
| **091 Floonet relay** | ✅ implemented (~3 000 lines), VPS-deployed at least once | 🔍 audited 2026-08-05 — **3 open findings** |
| **092 CoinSwap mixer** | ⏳ reserved, no code | n/a — requirements in [script09_design.md](script09_design.md) PART D.7 |
| **093 Transporter** | 🔧 Phase 1, standalone, never VPS-deployed | 🔍 audited 2026-08-05, re-reviewed 2026-08-06 — **13 findings, all fixed** |

---

# 093 Grin Transporter

## Verdict

The original checklist had six items. Three were genuinely met by Phase 1 (ciphertext-at-rest,
no-SSRF, loopback+parameterised-SQL). **Item 2 (throttle proof attempts, audit-log each) was
not implemented at all**, and **item 3 (bound enqueue abuse) was implemented only partially** —
and the partial implementation turned out to contain the most serious defect found in this audit.

T-1…T-11 were fixed on 2026-08-05. The 2026-08-06 re-review of those fixes found **T-12 and T-13**,
including a complete bypass of the T-1 fix; both were reproduced against the running server and
fixed the same day. All thirteen are covered by the local harness.

## Findings

### T-1 · HIGH · The per-recipient queue cap was a weapon *against* the recipient
`web/093_transporter/server.js`

Deposits are open by design, and the only per-recipient bound was `max_queue_per_addr` (default
100). A slatepack address is public — it is the wallet's Tor address — and `validSlatepackBody()`
checks only for the literal `BEGINSLATEPACK` / `ENDSLATEPACK` markers. So **anyone could mint 100
syntactically-valid junk blobs addressed to a known victim, and every genuine payout to that
address would bounce with 429 for the full 14-day TTL.** The cap meant to protect storage was in
practice a targeted denial-of-service primitive, reachable by a stranger with no credentials.

**Fixed** — five layers, of which #4 is what actually defuses the attack:

| # | Bound | Effect |
|---|---|---|
| 1 | `max_queue_total` (10000) | the store as a whole is bounded |
| 2 | unique `(recipient, body_hash)` | re-posting one blob costs 1 slot, not N; agent retries become idempotent |
| 3 | `max_deposits_per_ip_hour` (60) | one source cannot fire at will |
| 4 | `max_per_depositor_per_addr` (5) | **one depositor may hold only a few slots of any one queue — filling a victim's queue now needs ~20 distinct sources, not one** |
| 5 | `max_queue_per_addr` (100) | the original cap, now a last resort |

Depositor identity is stored as a **salted, truncated SHA-256** (persistent salt in a new `meta`
table), never a raw IP — consistent with the pool's IP-privacy rule.

### T-2 · HIGH · `X-Forwarded-For` forgery over the onion front voided every per-client limit
`server.js`, `scripts/lib/093_lib_server.sh`

nginx and Tor both arrive on `127.0.0.1`, and `trust proxy: 'loopback'` was set. Behind nginx that
is safe — `proxy_add_x_forwarded_for` *appends* the true peer, so the tail of the header is
authoritative and a client-supplied prefix is ignored. **Reached directly through the onion it is
not**: Tor forwards client headers verbatim to the local port, so a caller could send any
`X-Forwarded-For` it liked and mint a fresh identity per request. Every per-client bound in T-1 —
and any lockout keyed on a client — would have been bypassable by anyone who could reach the
`.onion`.

**Fixed** — the two fronts now get **separate local ports** (`port` = nginx, `tor_port` = onion,
7556/7566). Requests are classified by `req.socket.localPort`; forwarding headers are honoured on
the nginx port only, and onion traffic collapses to one shared identity. `trp_setup_tor` points
`HiddenServicePort` at the new port and **rewrites** any pre-existing torrc block (a stale block
still aimed at `TRP_PORT` would have left the hole open).

**Residual risk, accepted and documented:** an onion front cannot have per-caller accountability —
that is what anonymity means. Because every onion caller *is* the one shared identity, layer 4
applies to the onion front as a whole: no onion flood can bury a queue, but all onion senders
together may hold only `max_per_depositor_per_addr` slates for any one recipient. That is a real
availability limit, kept recoverable by T-12's delivery ordering and the agent's reaper. A
front-wide onion deposit ceiling (60/min) also bounds request cost, since nginx's `limit_req` does
not sit in front of that path. The operator screen and the code header both state this.

*(An earlier version of this paragraph said the onion was floodable up to `max_queue_total` —
wrong, layer 4 does apply there. Corrected 2026-08-06.)*

### T-3 · MEDIUM · No throttle or lockout on failed ownership proofs
Checklist item 2 required "throttle proof attempts (lockout), audit-log each". Neither existed;
`/auth` only wrote a `WARN` journal line.

**Fixed** — a lockout keyed on **`(address, client)`**, never on the address alone. That key choice
is deliberate and carries over the Script 07 pool's hard-won lesson (`project_pool_admin_login_security`):
an address-keyed lockout is a *remote DoS*, because anyone can fail proofs against a stranger's
address and lock the real owner out of their own queue. The harness asserts this directly —
after a lockout on one client, the same address still authenticates from another.

On the onion front every caller shares one identity, so an `(addr, "tor")` key would reintroduce
exactly that DoS. There the lockout is skipped in favour of a front-wide attempt ceiling
(30/min): a flood degrades all onion auth equally but cannot single out one address.

### T-4 · MEDIUM · No audit trail for ownership proofs
**Fixed** — new `auth_events` table (`ts`, `addr`, salted `client`, `result`), swept on
`auth_log_days` (default 30). `trp_status` surfaces a 24-hour ok/failed count so an operator can
see an attack without reading the journal.

### T-5 · MEDIUM · `/auth/challenge` was an unauthenticated, unbounded `INSERT`
Any caller could mint nonce rows in a loop; the table was only swept every 10 minutes.
**Fixed** — 30 challenges per client per minute, plus a cap of 10 outstanding un-redeemed nonces
per address.

### T-6 · MEDIUM · No global queue cap
Checklist item 3 lists "total queue size" explicitly; it was never implemented.
**Fixed** — `max_queue_total`, returning 503 when full.

### T-7 · MEDIUM · Command-injection sink in `_trp_agent_run`
`scripts/lib/093_lib_client.sh`

`su -c` takes a **string** that the target shell re-parses, and the helper interpolated
`${cmd[*]}` — raw operator input from the send/cancel prompts. A pasted address with a stray space
silently became two arguments; an amount typed as `1; reboot` would have been executed as the
`grin` user. (The non-`su` branch was always correct — it passes a real argv.)
**Fixed** — every token is quoted with `printf %q`.

### T-8 · LOW · `agent.json` written by heredoc
A wallet path containing a quote or backslash produced an unparseable config, and the resulting
"Cannot read config" error points nowhere near the cause. **Fixed** — built with
`JSON.stringify` via node (already a hard dependency). Verified against a path containing both
`'` and `"`.

### T-9 · LOW · Agent would send its bearer token over cleartext HTTP to a remote host
The install prompt accepts any `http://` URL. The Transporter token is a 15-minute credential
granting **read and delete** on that wallet's queue; over plain HTTP to a remote host it crosses
the network in the clear. **Fixed** — loopback and `.onion` pass silently (Tor is already
end-to-end encrypted); anything else on `http://` now requires explicit typed consent.

### T-10 · LOW · `owner_port` not validated
Non-numeric input produced `http://127.0.0.1:abc/v3/owner`. **Fixed** — range-checked, falls back
to the network default.

### T-11 · LOW · Tor state left inconsistent by the deployer
Uninstall printed "remove manually" and left the torrc block behind, so a dead `.onion` kept
pointing at a deleted service. **Fixed** — `_trp_torrc_strip_block` removes exactly our marked
block (verified against a fixture containing a second, unrelated hidden service, which survives
untouched). Hidden-service **keys** are deliberately kept, with a note, so the address can be
recovered.

### T-12 · HIGH · Junk head-of-line-blocked a queue — the T-1 fix stopped *filling*, not *denying* · **found 2026-08-06**

The five deposit caps bound how much an attacker can put in a queue. They say nothing about what
the owner gets back out. `GET /queue/:addr` returned `ORDER BY id LIMIT 20`, and the poll agent
deletes **only what it successfully processes** — anything undecodable is logged "leaving in queue
for retry". So junk that arrives first occupies the 20-row delivery window permanently, and every
real slate behind it is invisible until the 14-day TTL expires.

**Reproduced against the running server:** 25 junk deposits — 5 each from 5 sources, i.e. *within
every cap added by T-1* — followed by one real payment. Polls 1 and 2 both returned the identical
20 junk rows; the payment never appeared. Cost to the attacker: four IP addresses.

This is the more dangerous half of the original T-1 threat and the T-1 fix did not touch it. The
per-depositor fair share made the attack *cheaper to defend against*, not impossible.

**Fixed** — the answer is ordering, not another cap. `ORDER BY picked_up ASC, id ASC` (with a
covering index) demotes anything already delivered below anything never seen, so a fresh slate
reaches the front within `ceil(depth / 20) + 1` polls — bounded by `max_queue_per_addr`, not by
the TTL. `picked_up` is now returned by `GET`, and the agent retires a blob after 5 deliveries.

> **The agent's reaper must never eat a real slate.** A raw error cannot distinguish "this blob is
> junk" from "my wallet is down" — and a wallet down for six poll cycles would have deleted
> payable slates. So a delete only happens when the wallet is *demonstrably healthy*: either the
> slatepack decoded fine and is simply unusable (no sender address / unsupported state), or the
> decode failed **and** a follow-up probe of the Owner API succeeded. Probe fails ⇒ keep the slate.

### T-13 · MEDIUM · An ALL-CAPS address created a queue nobody could read · **found 2026-08-06**

`app.use('/queue/:addr', …)` validated the address and then normalised it with
`req.params.addr = …toLowerCase()`. **Express rebuilds `req.params` for every layer that matches**,
so that assignment was discarded before the route handler ran. Bech32 is case-insensitive, so an
all-uppercase address passed validation and was stored verbatim — while `/auth` always lowercases,
so the token never matched. Deposits to the uppercase spelling were unreachable by anyone, and
they still consumed global capacity until the TTL.

**Reproduced:** `PUT /queue/TGRIN1…` → 201; owner `GET` (lowercase) → 200 with **0 slates**; owner
`GET` (uppercase) → **401**. Pre-existing (not introduced by the 2026-08-05 pass), but it silently
undermined the dedupe and fair-share layers, which key on `recipient`.

**Fixed** — a `qAddr(req)` helper is now the only way a handler obtains the address; the
ineffective mutation is gone and the reason is documented at the call site. Mixed case is still
rejected outright (bech32 forbids it). Both spellings now resolve to one queue, asserted in the
harness.

## Checklist status after this pass

| # | Requirement | Status |
|---|---|---|
| 1 | Ciphertext-only at rest | ✅ DB holds armored slatepacks the server cannot decrypt, plus salted client hashes. No key material. |
| 2 | Address-as-identity proof, throttled, audited | ✅ **now** — ed25519 over a single-use nonce; was ✅ proof / ❌ throttle / ❌ audit |
| 3 | Enqueue abuse bounds | ✅ **now** — size, per-addr, per-depositor, global, TTL, nginx + in-app rate limits, **plus delivery ordering (T-12): bounding the enqueue is not enough on its own** |
| 4 | No SSRF / no auto-finalize | ✅ the server makes **no outbound requests at all** — it is walletless |
| 5 | Transport & exposure | ✅ binds 127.0.0.1 only; prepared statements throughout; body-size limit; `clientKey()` supersedes `req.ip` |
| 6 | Pool/Drop rail caution | ✅ still unwired — `transporter_enabled` false, stub throws |

## Open / accepted for 093

- **The onion front is one shared identity** (T-2 residual), so the per-depositor fair share
  applies to *all* onion senders together: they may hold only `max_per_depositor_per_addr` slates
  for any one recipient. That bounds flooding but is itself an availability limit — an abuser
  occupying those slots blocks legitimate onion senders until the agent drains them. T-12's
  ordering plus the agent's reaper is what keeps this recoverable rather than TTL-bound. Raising
  `max_per_depositor_per_addr` buys onion headroom at a proportionally larger flood ceiling.
  *(The 2026-08-05 note here claimed the onion was floodable up to the global cap — that was
  wrong; layer 4 does apply to the onion front. Corrected 2026-08-06.)*
- **Never VPS-deployed.** Everything above is verified locally. The bind-to-loopback claim in
  particular must be re-checked on the live box (`ss -tlnp`).
- **`node:sqlite` is experimental** on Node 24 (emits `ExperimentalWarning`) — same posture the
  Drop (059) already lives with.
- **NodeSource install is `curl … | bash`** — accepted toolkit-wide, HTTPS trust only.

---

# 091 Floonet relay deployer

## Verdict

Items 1 (TLS bootstrap ordering), 2 (loopback binding + firewall scope), 4 (hardened unit) and 5
(secret handling) **pass**. Item 3 — "pin the version/commit, verify the artifact" — **fails on
both install paths**. One further finding concerns what happens when certbot fails.

## Findings

### F-1 · MEDIUM · No version or commit pin *(checklist item 3)*
`scripts/lib/091_lib_floonet.sh` — `git clone --depth 1 "$FLR_REPO_URL"` builds whatever is at
upstream `master` HEAD at that moment, and runs it as a system service. `FLR_INSTALLED_REV` records
what *was* installed, but that is a post-hoc note, not a pin: two operators running the deployer a
week apart get different code with no signal that anything changed. The checklist called for a
pinned commit precisely so a compromised or simply broken upstream push cannot land silently.

**Not fixed** — pinning is a policy decision (which commit, and who bumps it) that belongs with
the operator, and 091 is already deployed. Recommendation: record a known-good commit in
`grin_floonet.conf`, clone at it by default, and make "track master" an explicit opt-in.

### F-2 · MEDIUM · Prebuilt-release path has no integrity check *(checklist item 3)*
`_flr_try_prebuilt()` selects a download URL by grepping the GitHub releases API, `curl`s the
tarball, `tar -xzf`s it into the source tree, and runs the extracted binary as a service. There is
**no checksum, no signature, and no pin**, and the extraction has no `--no-same-owner` or path
guard, so a crafted archive could write outside the target directory.

This path is **dormant today** — upstream has published no releases (re-checked 2026-08-05) — which
is exactly why it deserves attention: it will **activate itself silently** the first time upstream
cuts a release, switching the deployer from an inspectable source build to an opaque binary with no
operator notice. The implementation notes describe "no checksum on that path by design"; that is a
defensible position for a source build whose commit you can read, and a weak one for a binary.

**Not fixed** — same reasoning as F-1, and any fix should land together with it. Minimum viable
hardening: require a `.sha256` (or a cosign/minisign signature) alongside the archive, refuse the
path when absent, and extract with `--no-same-owner` into a scratch dir.

### F-3 · MEDIUM · certbot failure leaves the relay serving cleartext `ws://` and reports success
`scripts/lib/nostr_relay_deploy.sh` — `nrd_deploy_wss_vhost()` writes an HTTP bootstrap vhost, and
if certbot cannot issue a certificate it **warns and returns 0**, leaving the relay publicly
reachable over unencrypted `ws://`. Checklist item 1 says "never proxy the relay in cleartext".

For a Grin-native Nostr relay this is not cosmetic: NIP-42 auth exchanges and all message metadata
(who talks to whom, when, how much traffic) become visible to anyone on the path — which is much of
what the relay exists to protect.

**Not fixed** — this is a deliberate availability trade-off (the site keeps working while DNS is
fixed) and changing it alters the behaviour of a deployed product. Recommendation: keep the
fallback but require explicit operator consent, and make `NRD_SSL_OK=0` a loud, persistent banner
on the status screen rather than a warning that scrolls past.

## Passing items *(verified by reading the code)*

- **Item 1 — TLS bootstrap ordering.** HTTP-only vhost → reload → certbot → SSL vhost. LE snippets
  are included only when the files exist. Matches the CLAUDE.md rule exactly.
- **Item 2 — exposure.** `network.address` is force-set to `127.0.0.1` on every config write, so an
  upstream example shipping `0.0.0.0` cannot win; the firewall helper opens only 80/443.
- **Item 4 — hardened unit.** Upstream's unit is kept when its installer runs; the fallback unit
  swaps `DynamicUser` for a stable `floonet` user (so a 0600 config stays readable) and keeps the
  other hardening directives.
- **Item 5 — secret handling.** The GoblinPay token goes to a `umask 077` `EnvironmentFile` plus a
  systemd drop-in, never to `config.toml` and never onto argv. Input is read with `read -rs`, which
  cannot produce an embedded newline, so the append is not injectable.

---

# Cross-cutting finding (both members)

### X-1 · MEDIUM · `08del` left every Script-09 artefact behind — **fixed 2026-08-05**
`scripts/08del_clean_all_grin_things.sh`

The "full cleanup" script had **no systemd step at all**, while the toolkit installs 15+ units.
After a cleanup deleted `/opt/grin`, units carrying `Restart=always` (including
`grin-transporter-*`) respawned every 15 s against binaries that no longer existed — a permanent
journal flood on a box the operator believes is clean. Three narrower gaps had the same root
cause: **the toolkit does not put "grin" in every filename it writes**, so `*grin*` globs missed—

- `floonet-rs.service`, `/etc/floonet-rs`, `/var/lib/floonet-rs`, `/usr/local/bin/floonet-rs`
- every rate-limit zone conf, which is named `script<NN>-…​.conf` by convention (an orphaned
  `limit_req_zone` is not inert: nginx loads all of `conf.d`, so it can collide with a reinstall)
- `/etc/nginx/sites-available/floonet-relay`
- `/var/lib/tor/grin-transporter-*` hidden services and their torrc blocks — a live `.onion`
  pointing at a deleted service

**Fixed** — a new `step_remove_systemd_services` (ordered *before* the install-dir removal so
services stop before their files vanish, and removing `.d` drop-in dirs too), plus name-based
patterns for the three globs above. Discovery patterns were verified against a fixture tree:
`nginx.service`, `ssh.service`, `default.conf` and unrelated Tor dirs are correctly left alone.

---

## Verification performed

| What | How | Result |
|---|---|---|
| 093 abuse bounds, auth lockout, onion header forgery | E2E harness spawning the real `server.js` | **33/33** |
| 093 head-of-line blocking (T-12) | 25 junk from 5 sources + 1 real payment, polled repeatedly | reproduced, then fixed — payment surfaces on poll 2 |
| 093 uppercase-address stranding (T-13) | uppercase `PUT`, lowercase owner `GET` | reproduced (201 / 0 slates / 401), then fixed |
| 093 upgrade from a 0.1.0 database | migration harness (dupes + backfill + new tables) | **10/10** |
| torrc block stripping | fixture with a second unrelated hidden service | exact-block removal |
| `08del` discovery patterns | fixture tree of units / conf.d / tor dirs | no false positives |
| Generated backup cron wrapper | rendered, then `bash -n` | clean |
| All touched shell + JS | `bash -n`, `node --check` | clean |

Harnesses live in the session scratchpad, not the repo (they spawn a server; per CLAUDE.md nothing
was left running).

## What this audit did NOT cover

- **Live VPS behaviour of either product.** No deployment was performed.
- **091's runtime relay code** — that is upstream `floonet-rs`, which we deploy and do not fork.
  F-1/F-2 are precisely about the fact that *which* upstream code runs is unpinned.
- **092** — no code exists.
- The Script 093 **agent's** interaction with a real `grin-wallet` binary; the four `⚠VERIFY`
  items in [script09_implementation.md](script09_implementation.md) remain open.
