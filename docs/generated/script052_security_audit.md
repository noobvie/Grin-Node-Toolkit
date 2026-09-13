# Script 052 — Accio (self-custodial Grin web wallet) — Security Audit

> **Covers code as of:** 2026-08-16 · **Last verified:** never re-verified since
> **Product code last changed:** 2026-08-22 — `scripts/052_grin_accio.sh`, `scripts/lib/052_lib_*.sh`, `web/052_accio/`

**Scope:** the gateway (`web/052_accio/gateway/`, 9 modules), the four libraries
(`scripts/lib/052_lib_{build,gateway,nginx,vendor}.sh`), the nginx artefacts they generate, the
systemd unit, and the pin chain that decides which bytes a visitor's browser executes. The
**vendored wallet itself** (`vendor/`, 128k lines of someone else's JavaScript) is **out of
scope** — see "What this audit did NOT cover".

**Audit date:** 2026-08-11 · **Auditor:** Claude · **Packet:** S8 · **Method:** read of the
actual code, plus a 47-assertion offline harness driving the real `guard.js`, `store.js`,
`listen_route.js`, `wallet_route.js` and `config.js`, plus an offline render of all three nginx
artefacts read line by line. No server was started and nothing ran against a VPS.

**Amended 2026-08-12 by the R7 review** (gateway money rails). R7 added A-18 … A-22 and
**closed A-1's deliberate residual**, which turned out to be far wider than A-1 described — read
A-1 together with A-18. S8's harness has since been replaced by a committed suite under
`gateway/test/` (`node --test`), so the behaviours below are now pinned in the repo rather than
in a scratchpad. Every R7 fix was verified by reverting it and watching the matching test fail.

**Amended 2026-08-12 by the R8 review** (`patches/**`, the overlay — territory S8 explicitly did
not cover). R8 added **A-23**, specified the unwritten mechanism behind **A-11** and **A-12**,
and made **A-14**'s privacy-policy disclosure real. It also re-ran the suite as it now stands:
four files, **78 tests, 78 pass, 0 fail**. The "36 assertions" this paragraph used to quote
counted two of the four files and is corrected here; report what the runner prints.

> ⚠ **NOTHING IN THIS PRODUCT HAS EVER RUN ON A VPS.** Not one build, deploy, send or receive.
> Every finding below is code-reading plus local execution of the modules in isolation. Findings
> about *deployed* behaviour — that the headers are really on the wire, that the vhost really
> loads, that a real wallet really claims its addresses on reconnect — are **hypotheses this
> audit could not test**, and each is listed in "Owed to the acceptance session (S2)".

---

## Status

| Component | State | Audit |
|---|---|---|
| **Gateway** — `/tor/` outbound | code complete, never run on a VPS | 🔍 audited — 2 findings, both fixed; re-read by **R7**, no new findings |
| **Gateway** — `/listen` + `/wallet/` inbound | code complete, never run on a VPS | 🔍 audited — **1 HIGH, 1 HIGH, 2 MEDIUM**, all fixed; 2 accepted. Re-audited by **R7**, 2026-08-12 — **1 HIGH (A-18), 2 MEDIUM, 2 LOW**, all fixed |
| **nginx front** (clearnet + onion) | generated, never loaded by a real nginx | 🔍 audited — 2 findings, both fixed |
| **systemd unit** | written, never started | 🔍 audited — 1 hardening finding, fixed |
| **Pin chain** (`vendor/` → build → deploy) | complete up to the build | 🔍 audited — **2 gaps, both open** (A-11, A-12), both new work not bug fixes; **R8 specified the mechanism for each**, neither is written |
| **Entry script** `052_grin_accio.sh` | written, never run | 🔍 audited by **R1**, 2026-08-11 — 2 findings (A-16, A-17), both fixed |
| **Overlay** `patches/**` (19 files) | applied at build, never deployed | 🔍 audited by **R8**, 2026-08-12 — **1 MEDIUM (A-23), fixed**; the overlay was outside S8's scope entirely |
| **Regression suite** `gateway/test/` | 4 files, **78 tests**, `node --test`, runs offline | ✅ added by R6 + R7 — every finding in this file that lives in the gateway is now pinned by a test. Re-run by R8: **78 pass, 0 fail** |
| **Vendored wallet** (`vendor/`, ~6 MB) | pinned at `adef11da` | ⛔ **not audited** — see the closing section |

## Verdict

The two things S8 was told to test hardest — the `/tor/` SSRF guard and per-wallet
authorisation on `/listen` — came out of this differently. **The SSRF guard is sound**: it never
resolves a name, so there is no rebind window, and its one real gap (alternate IPv4 spellings)
only mattered in a mode that is off by default. **The `/listen` authorisation was not.** It
authorised the *session* and then routed money by "newest socket in that session", which is not
the same question — and the gap between those two questions was a path to redirecting a
stranger's payment into an attacker's wallet with nothing visibly wrong in either UI. That is
finding A-1, and it is the reason this audit exists.

The second theme is that **this product's inbound rail had no bound on the one table a stranger
can grow for free.** A `/listen` handshake mints a session before the client has asked for
anything; the session table had no cap, no eviction and no lifetime short of 90 days, and the
snapshot writer rewrote all of it every two seconds. That is A-2.

Eight findings are fixed in this pass and covered by the harness. Six are open: two are accepted
design trade-offs with their reasoning recorded, two are new work (verifying the overlay and the
deployed tree), and two are inherent to what a public payment inbox is.

**The R1 review (2026-08-11) added two more fixed findings, A-16 and A-17**, in
`scripts/052_grin_accio.sh` — a file S8 did not cover. The theme they share is worth more than
either finding: the entry script hand-rolls its own copies of work the libraries already do
(removal, config writing), and a hand-rolled copy does not inherit the hard-won detail of the
original. A-16 is precisely that — the gateway lib sweeps dangling includes because leaving one
takes the whole box's nginx down, and the copy in the entry script never learned it.

**The R7 review (2026-08-12) added five more, A-18 … A-22, and this is the one to read first:
A-18 found that S8's own accepted residual on A-1 had given the whole of A-1 back.** The
fallback A-1 kept — deliver to any live socket in the session when none has claimed the address —
was described in this file as covering the window between a reconnect and the client's first
`Own URL`. It covered far more than that: no socket claims the suffix whenever the legitimate tab
is simply *not connected*, which for a browser wallet is the ordinary state. The cookie-holder
never needed to win a race. A-1 is only now actually fixed.

The lesson is about this document as much as the code. A residual accepted with a *narrow*
rationale must be re-derived, not re-read — the sentence describing it was written by someone
reasoning about a race and it was quietly wrong about the common case for the entire time it
stood. **The R8 review (2026-08-12) added one more, A-23** — the standalone build, the artefact
this product describes as offline, contacted `api.github.com` on every load and the privacy
policy shipped beside it named only two things that leave the browser. It survived three earlier
passes for a structural reason worth more than the finding: its file carried no `ACCIO PATCH`
marker, and grepping that marker *is* the documented way to review the overlay. A control that
is a convention fails silently the first time someone forgets it.

R8 also **specified the mechanism for A-11 and A-12** (see each finding) and **carried out
A-14's acceptance**, which had been recorded as "state it in the privacy policy" and never
stated. **Running total: 16 fixed, 6 open.**

**Nothing here changes the custody story.** The gateway holds no key, no seed and no balance,
and no finding in this audit put one there. The money risk in A-1 is redirection of an *inbound*
payment, not theft of a stored one — there is nothing stored to steal.

---

## Findings

### A-1 · HIGH · Inbound payments were routed by session, not by address — a cookie could redirect a stranger's payment · **FIXED**

`deliver()` looked up the suffix, took its session, and handed the slate to **the most recently
opened socket in that session**:

```js
let conn = live[0];
for (const c of live) if (c.opened > conn.opened) conn = c;
```

The session cookie is the ownership proof for an address, and the design says so plainly. But a
cookie proves *which session a tab is in*, **not which address that tab holds** — and those are
different claims. Anyone holding the cookie could open a `/listen` socket, send not one protocol
message, and be handed the next inbound slate for an address they had never seen and could not
have named. Their wallet then answers it with **their own output**. The payer's send succeeds,
the payee never receives, and neither UI shows anything wrong: the payer paid the address they
were given, and the payee simply never sees a payment arrive.

**The precondition is obtaining the cookie, and it is weaker than it looks.** The cookie is
`HttpOnly`, `SameSite=Lax`, `Path=/listen`, and `Secure` on the clearnet front — so this is not
reachable by script from another origin. It is reachable by **cookie tossing**: cookies are not
isolated by host the way origins are, so a sibling host under the same registrable domain
(`blog.example.org` setting `Domain=example.org`) can write a cookie that `wallet.example.org`
will send, and it can do so over plain HTTP even when the real cookie is `Secure`. An attacker
who first collects a legitimate sid from the gateway and then tosses it into a victim's browser
puts the victim's tab into a session the attacker also holds. Note the store already refuses an
*invented* sid — `getSession()` must find the row — so the attacker has to source a real one;
that is one HTTP request, not a barrier.

The attacker never learns the victim's suffix (80 bits, and the protocol has no list operation).
They did not need to. Routing by session meant **not knowing the address was no obstacle to
receiving payments sent to it.**

**Fix.** Delivery is now routed to a socket that has *claimed that specific suffix* — minted it
on this connection (`Create URL`), or confirmed it on this connection with `Own URL`, which
§10 says every client does for every address it holds on every reconnect. A per-connection
`owned` set is maintained by all four URL calls, and `_forgetEverywhere()` clears a rotated or
deleted suffix from every socket of the session, so a stale claim cannot outlive the address.
An attacker cannot claim what they cannot name.

**One deliberate residual, and it is not zero.** When *no* live socket has claimed the suffix,
delivery falls back to the old newest-socket rule. That keeps a payment from being lost in the
window between a reconnect and the client's `Own URL` round — and it is the only remaining path
by which a non-claiming socket is chosen. **Stated plainly: the attack above still works in the
narrower case where the legitimate owner's tab is not connected.** A cookie-holder whose socket
is the only one live in that session still receives payments to addresses they cannot name. What
the fix removes is the case that matters far more — the victim is *using* the wallet, which is
also when payments are actually arriving. The fallback should be deleted, leaving a strict rule
and a 503 when nobody has claimed, **once the acceptance session has watched a real client claim
its addresses on reconnect.** It is not deleted now on the strength of reading the protocol spec:
that is exactly how S7's worker phase became a silent no-op.

> ### ⚠ SUPERSEDED — the paragraph above was wrong about its own severity. See [A-18](#a-18).
>
> The residual is **deleted as of 2026-08-12**, and the reasoning that kept it does not survive
> contact with the question "when is `claimants` empty?". The answer is not "for a moment after a
> reconnect" — it is "whenever the payee's tab is closed", which is most of the time. Calling that
> "the narrower case" was the error: it is the *broader* one, and it handed the attacker the
> entire finding without any timing requirement at all.
>
> The two assertions this note promised have been written and the second one inverted, in
> `gateway/test/money_rails.test.js`: a non-claiming socket now receives **nothing**, whether or
> not a claimant is live. Verified by reverting the fix and watching the test fail.
>
> The acceptance item this paragraph deferred to has not gone away — it has become **blocking**,
> for the opposite reason. See A-18 and the acceptance list.

> **Related hardening not taken:** a `__Host-` cookie prefix would make tossing impossible
> (it forbids `Domain` and requires `Secure` + `Path=/`), but `Path=/` conflicts with the
> deliberate `/listen` scoping and `Secure` cannot be set on the plain-HTTP onion front. The
> ownership fix defuses tossing without either compromise, so the prefix is recorded here as an
> option rather than applied.

---

### A-2 · HIGH · The session table had no bound of any kind, and the snapshot writer rewrote all of it every two seconds · **FIXED**

`createSession()` was called by **every completed `/listen` handshake**, before the client had
asked for a single address, and it did this:

```js
this.sessions.set(sid, { created: now, seen: now });
this._schedule();
```

No cap. No eviction. A 90-day rolling ttl, so `sweep()` reclaimed nothing inside a quarter of a
year. And `_schedule()` marked the store dirty, so `flush()` re-serialised **the entire table**
2 seconds later — meaning each new handshake did work proportional to the size of everything
that came before it. A handshake flood was therefore both a memory leak and a disk amplifier, at
a cost to the attacker of one WebSocket each. nginx's `limit_req` bounds the *rate* per IP; it
bounds nothing about the total, and on the onion front every caller is `127.0.0.1`.

Separately, `max_suffixes_total` (100 000) *was* enforced, but exhausting it had a bad failure
mode: `mint()` threw, so **every new wallet silently stopped being able to get a receiving
address**, and the only way to notice was to read a client-side error.

**Fix**, in four parts, all in `store.js`:
1. **Empty sessions are never persisted.** `flush()` writes only sessions that own at least one
   address. An empty session has nothing to restore — losing it costs its holder a new cookie
   and no address — so the snapshot no longer grows with handshake traffic at all.
2. **`createSession()` is capped** (`max_sessions`, default 20 000). At the cap it sweeps, then
   evicts the oldest session that owns **no** address. Only when every session in the table owns
   a real address does it refuse, and that refusal is a 503 on the handshake, which the client's
   retry ladder already survives. A session holding an address is never evicted to make room.
3. **`sweep()` drops sessions that never claimed an address** after `empty_session_ttl_ms`
   (default 1 h) — it only has to outlive the gap between the handshake and the first
   `Create URL`.
4. **A full address table now evicts the globally oldest *unverified* suffix** before refusing,
   and when it does refuse it logs loudly and reports `table_full` in `/health`. This is a
   partial relief and is documented as such in the code: an attacker can verify their own
   addresses, so if it ever fires in anger the real lever is the nginx rate zones and the
   operator has to be *told*, not left to infer it from a wallet that will not issue an address.

Harness: 18 assertions, including that a restart still returns the same address to the same
session — the property all of this must not break.

---

### A-3 · MEDIUM · The inbound budget was checked after the body was buffered, so it capped relays and not memory · **FIXED**

`max_inbound_in_flight` (256) was tested inside `deliver()`. By the time `deliver()` ran,
`wallet_route.readBody()` had already buffered the **whole** `inbound_body_bytes` (1 MB) into the
process. So the cap bounded *parked interactions* and nothing bounded *bodies being read*: N
concurrent senders could hold N MB between them with no counter aware of it. With
`proxy_request_buffering off` a slow sender holds that allocation for up to `requestTimeout`
(120 s), and on the clearnet front `limit_req` is per-IP — many IPs, no global ceiling.

The `/tor/` rail does not have this problem: it checks `max_concurrent` before forwarding *and*
streams rather than buffers. The inbound rail was the asymmetric one.

**Fix.** `ListenHub.beginRead()` / `endRead()` put reads and parked interactions on the same
budget, and `wallet_route` reserves **before** calling `readBody`, answering 503 + `Retry-After`
when the budget is gone. The release is idempotent and hooked to `res`'s `close` as well as to
the read callback — a reservation that leaks is a cap that tightens by itself until the rail
refuses everything.

> **Amended by R7 (A-19, A-20).** This fix made the cap cover the read but never sized the
> product: 256 slots × 1 MB is a **256 MB** ceiling, and the address was not looked up until
> after the buffer, so the budget was reachable by anyone with a socket and no address at all.
> A-19 checks the suffix first; A-20 resizes the cap to something the rail can actually forward.

---

### A-4 · MEDIUM · Two locations that include the header snippet still answered with no HSTS · **FIXED**

This file's own banner warns, at length, that `add_header` in a child block **discards** the
parent's set, and the rule it states is "every block that emits any add_header of its own
`include`s the shared snippet first". Both `location = /standalone.html` and the static-asset
regex location obeyed that rule — and still answered with **no `Strict-Transport-Security`**,
because HSTS is deliberately *not in the snippet*. It is excluded so the plain-HTTP onion front
cannot emit it, and it is added by the clearnet server block instead. The snippet include
restores CSP and the rest; nothing restores a header the snippet never had.

The consequence is small — the main document is served by `location /`, which adds no header of
its own and therefore inherits the full set, so a browser still receives HSTS on the first
response — but it is the same trap the file exists to warn about, one level further in, and the
implementation log's own acceptance item ("the security headers are actually present on an asset
response and on `/standalone.html`") would have found it as a mystery.

**Fix.** Both clearnet locations now re-emit HSTS, with a comment saying why it is repeated
rather than moved into the snippet. The onion vhost's equivalent blocks correctly still have
none. Verified by rendering all three artefacts offline and reading every block's header set.

> `Onion-Location` is missing from the same two blocks and was left alone deliberately: it is
> only meaningful on a document a Tor Browser is navigating to, and `/standalone.html` is served
> as an attachment.

---

### A-5 · MEDIUM · The SSRF guard's private-address rule only recognised dotted-quad IPv4 · **FIXED**

`PRIVATE_V4` is checked only when `IPV4_LITERAL` matches, and `IPV4_LITERAL` is
`/^\d{1,3}(?:\.\d{1,3}){3}$/` — the dotted quad and nothing else. But that is not the only
spelling a resolver accepts: `2130706433`, `127.1`, `0x7f000001` and `017700000001` all mean
127.0.0.1 to `inet_aton`, and every one of them satisfies `HOSTNAME` while matching neither
`IPV4_LITERAL` nor the `localhost` / `.local` name check. With `allow_clearnet_destinations`
enabled they passed the guard.

**How bad was it, honestly:** not very, and the reason is structural rather than lucky. The
connection is made by handing the string to **Tor** (`ATYP 0x03`), so "127.0.0.1" would mean the
*exit node's* loopback, not this box's — and Tor exit policies reject private space by default.
Clearnet destinations are also off by default. So this was a guard that did not deliver what it
claimed rather than a live SSRF. It is fixed because "our filter is narrower than it reads" is
the wrong thing to leave in the one file the whole SSRF story rests on.

**Fix.** The private-address rule is now enforced on a *shape* instead of a spelling: a
destination must have at least one dot and a final label that starts with a **letter** (RFC 3696
— a TLD is alphabetic, or punycode, and is never all-numeric). That covers every alternate IPv4
notation in one rule, plus single-label intranet names (`router`, `wiki`) that a resolver would
complete from a search domain, and it is the same answer for a notation nobody has thought of
yet. Punycode TLDs still pass. The `.onion` branch is untouched and still stricter. 15 harness
assertions.

---

### A-6 · LOW · Over-rate WebSocket messages were dropped in silence, contradicting the file's own comment · **FIXED**

`_onMessage` began `if (!this._takeToken(state)) return;` while the comment on
`RATE_VIOLATIONS_BEFORE_CLOSE` promised the opposite — "over-rate requests are answered with an
Error rather than dropped, because silence costs the client a 120 s stall (§11.9)". The comment
was the correct design and the code was not, and the symptom is the stall the comment describes.

**Fix.** The rate check now runs after the parse, so an over-rate request can still be answered
with an `Error` carrying its `Index`. Answering is 1:1 with the flood, so it is not an
amplifier, and the frame was already size-capped by `ws.js` before it got here.

---

### A-7 · LOW (hardening) · The unit could reach the whole internet, and had no memory ceiling · **FIXED**

Every claim this product makes about SSRF rested on one regex being right. The unit placed no
restriction on where the process could connect, so a bug in that regex — or in anything that
ever calls out from this service — was a request to an address someone else chose.

**Fix.** `IPAddressDeny=any` + `IPAddressAllow=localhost`. Everything this service legitimately
reaches is on 127.0.0.1: both listeners bind there and `socks_host` defaults to it. That moves
the guarantee from "our filter is correct" to "the kernel will not carry the packet". On a
kernel or systemd without cgroup BPF these two directives are logged and ignored, so they cannot
stop the service from starting — and an operator pointing `socks_host` at a Tor on another host
must add that address, which the unit says in a comment. Also added: `MemoryMax=512M` (being
OOM-killed and restarted is a better failure than taking the node, the pool and Fidelius down
with us), `TasksMax`, `ProtectClock`, `ProtectHostname`, `ProtectProc=invisible`.

`SystemCallFilter=@system-service` was **considered and not applied**: it is standard and node
normally runs fine under it, but this service has never started once, and a syscall filter that
misbehaves on an unknown kernel would present as "the gateway is broken" during the very session
that is trying to establish a baseline. Add it after S2 is green.

---

### A-8 · LOW · The CSP left `object-src`, `base-uri`, `form-action` and `frame-ancestors` unrestricted · **FIXED**

None of those four fall back to `default-src`, so `default-src 'self'` was not covering them.
All four are now set (`object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors
'self'`). `base-uri` is `'self'` rather than `'none'` because the rendered error pages
legitimately carry a `<base href>` pointing at this host (`errors/template.php`), which `'none'`
would break.

**This is also where S8 answers the question the design deferred to it** — "tightening the CSP
is an S8 question, to be answered with the wallet in front of you". Measured against the
vendored source rather than read:

| Directive | Verdict | Evidence |
|---|---|---|
| `script-src 'unsafe-inline'` | **Required. Cannot be removed.** | `index.html` carries **144 inline event handlers** (`onerror=`/`onload=` on every asset it loads) |
| `script-src 'unsafe-eval'` | **Required today, and wider than it needs to be** | There is **no `eval()` and no `Function("…")` anywhere in the tree**. The only caller is `WebAssembly.instantiate` in the five emscripten wrappers — which is precisely what `'wasm-unsafe-eval'` exists for |
| `connect-src *` | **Required** | The visitor chooses their own Grin node URL; restricting it breaks the point of a self-custodial wallet |
| `style-src 'unsafe-inline'` | Required | inline style attributes throughout |
| `img-src data:` | Required | QR rendering |

So the one genuine narrowing available is `'unsafe-eval'` → `'wasm-unsafe-eval'`.
**`'wasm-unsafe-eval'` has been added; `'unsafe-eval'` has NOT been removed**, because a browser
too old to know the newer token would then refuse to instantiate the crypto and the wallet would
fail to start with an error pointing nowhere useful. Listing both is a no-op today whose only
purpose is to make the removal a one-word edit. **Drop `'unsafe-eval'` once the acceptance
session has watched the wallet boot and sign a transaction without it.**

The honest summary a reader of this policy needs: with `'unsafe-inline'` structurally required
and `connect-src *` structurally required, **this CSP is not XSS containment for this
application** and must not be described as such. Its load-bearing job is `default-src 'self'` +
`script-src 'self'` — bounding *where code may come from* — plus the four directives added here.

---

### Added by the R1 review — 2026-08-11

S8's scope was the gateway, the four libraries and what they generate. It did **not** include
`scripts/052_grin_accio.sh`, the entry script — which turns out to hand-roll its own uninstall
and its own config writer rather than calling the libraries'. Both findings below are in that
file and both are fixed.

### A-16 · MEDIUM · Uninstall could leave a dangling `include` and stop nginx starting **at all** · **FIXED**

`acc_uninstall` removes the gateway snippets and then deletes the vhost files it can name:
`sites-{available,enabled}/accio-<net>` and the `-onion` pair. The include it is trying to
retire, though, was not necessarily planted in a file with that name. `acg_nginx_glue` inserts
into whatever `_acg_find_vhost` returns, and that function's candidate list is
`sites-available/accio-<net>`, then **`sites-available/<domain>`**, then **any vhost whose
`root` is the site dir**. Deploy Accio into a vhost the operator already had — the ordinary case
when the wallet shares a name with a site deployed by something else — and the uninstall deletes
`accio-<net>-gateway.conf` while leaving `include /etc/nginx/snippets/accio-<net>-gateway.conf;`
behind in that file.

**nginx refuses to start on a missing include.** Not "the wallet 404s": the whole daemon fails
its config load, so the node API vhost, Fidelius, the pool and every other site on the box go
down at the next reload or reboot. `acg_uninstall_gateway` sweeps for exactly this and says so in
a comment; the entry script's copy of the removal never inherited the sweep. The `nginx -t` at
the end of `acc_uninstall` would *report* the breakage, but only as a message at the end of an
action that has just told the operator everything was removed.

**Fix.** Before `nginx -t`, sweep every file under `sites-available` that still references any
of this network's three snippets and delete those `include` lines. Verified on a fixture: the
other network's include and an unrelated product's include both survive. The sweep uses `%` as
the `sed` address delimiter — the `\|…|d` form the gateway lib uses works there only because its
pattern has no alternation, and the `|` in `(gateway…|headers)` would otherwise close the
address early and abort the uninstall with "sed: unmatched (".

### A-17 · LOW · Config values were written through `sed`, so a `|` in one became a `sed` flag · **FIXED**

`_acc_conf_set` rewrote an existing key with `sed -i "s|^${key}=.*|${key}=${val}|"`. The value is
never escaped, and every value reaching that function is operator-typed or externally derived
(`ACCIO_DOMAIN`, `ACCIO_LE_EMAIL`, `ACCIO_NODE_URL`, `ACCIO_ONION`). A `&` expands to the whole
match, silently corrupting the line. A `|` closes the `s///` and turns the remainder into `sed`
**flags** — `w /path` writes a file, as root.

Severity is LOW because the operator is already root, so this is robustness rather than privilege
escalation. It is worth fixing anyway because the guard against it was cheap and because one of
those two writers accepted the value without validating it: `acn_deploy_web` checks the domain
with `nginx_validate_domain`, while the bootstrap prompt in `acc_rebuild` — the other place
`ACCIO_DOMAIN` is written — accepted any non-blank string, baked it into the built site's
canonical URLs, hreflang and web manifest, and only then handed it to the deploy step that
rejects it.

**Fix.** `_acc_conf_set` no longer runs `sed`: it filters the key out with `grep -v`, appends the
new line with `printf`, and copies the result back with `cat >` so the file keeps its inode,
owner and mode. Nothing `source`s this config — it is read key-by-key by `_acc_conf_get` — so
moving the rewritten key to the end is free, and duplicate keys are now collapsed on every write.
`acc_rebuild`'s bootstrap prompt applies the same regex `nginx_validate_domain` uses, inlined
with a comment naming the shared helper as the source of truth. Round-tripped locally against
`|`, `&`, `\` and a query-string URL: values survive verbatim, no duplicate keys, no temp file
left, no injection.

---

---

### Added by the R7 review — 2026-08-12

R7's target was the five money-rail modules (`listen_route`, `wallet_route`, `tor_route`,
`socks5`, `ws` — ~1910 lines). Five findings, all fixed, all pinned by
`gateway/test/money_rails.test.js` and all verified by reverting the fix and watching the
matching test fail. A-18 is the one that matters: it is A-1, returned.

<a id="a-18"></a>

### A-18 · HIGH · A-1's accepted fallback gave the whole of A-1 back, and did not need a race · **FIXED**

A-1's fix routes an inbound slate to a socket that has claimed the suffix. Its accepted residual
kept a fallback for the case where nobody has:

```js
const claimants = live.filter((c) => c.owned.has(suffix));
const pool = claimants.length ? claimants : live;
```

A-1 describes that fallback as covering "the window between a reconnect and the client's
`Own URL` round" and calls the surviving attack "the narrower case". **Both characterisations are
wrong, and in the same direction.** Ask when `claimants` is empty and the answer is not a
sub-second window — it is *whenever the payee's tab is not connected*, which for a browser wallet
is the ordinary state of the world. Tabs are closed; laptops sleep.

So the attacker of A-1 — someone who obtained the session cookie, by tossing or otherwise — never
had to win a race against the victim's reconnect. They connect at a moment when the victim's tab
happens to be shut, send no protocol message at all, and are handed the next inbound slate for an
address they have never seen and cannot name. Their wallet answers it with their own output. The
payer's send succeeds, the payee never receives, neither UI shows anything wrong. That is A-1 in
full, with the timing requirement removed.

The correct behaviour was already three lines above the fallback: a payee with no live socket is
answered `503` + `Retry-After`, and senders retry. A payee whose tab has not claimed the address
is in exactly the same position — it genuinely cannot receive — so it deserves exactly the same
answer.

**Fix.** The fallback is deleted. Delivery is now a strict rule: among sockets that have claimed
this suffix, the most recently opened; if none has, `503` + `Retry-After: 5`. A new counter
`inbound_unclaimed` distinguishes "a live socket that has not claimed" from "no socket at all",
so the reconnect window is measurable rather than assumed.

**This trades one risk for a smaller one, and the smaller one is now a blocking acceptance
item.** If a real client does not send `Own URL` for a held suffix on reconnect, receives fail
closed instead of going to the wrong socket. That is the right direction — a payment that does
not arrive is recoverable; one that arrives in a stranger's wallet is not — but it means
"watch a real client claim its addresses" is no longer a curiosity to confirm the fallback can
go. It is the thing that decides whether inbound payments work at all.

> **The process lesson, which is the more valuable half.** A-1's residual was accepted with a
> narrow rationale, and the rationale was quietly wrong about the common case for as long as it
> stood. Nobody re-derived it; it was re-read, and it reads plausibly. **A residual accepted on
> a stated precondition must be re-derived by asking when that precondition actually holds**, not
> re-read for whether the prose still sounds right.

---

### A-19 · MEDIUM · An inbound address was not checked until after its body was buffered · **FIXED**

`wallet_route.handle` reserved a read slot and buffered up to `inbound_body_bytes` before
anything asked whether the address existed — `store.lookup()` does not run until `deliver()`.
`parsePath` accepts any `[A-Za-z0-9]{4,64}`, so a POST to a suffix that has never existed cost a
full megabyte of heap before its 404.

That makes A-3's budget — 256 concurrent reads — reachable **by anyone at all**: no address, no
session, no cookie, on either front. The clearnet front has `limit_req zone=accio_wallet` (10 r/s
per IP, burst 40) which bounds rate per source but not concurrency and not the total. The onion
front is worse and is reachable by a single client: `onion_inbound_bucket` is 5/s burst 20, a
*rate* limit, so slow 1 MB uploads held ~60 s each accumulate to ~300 concurrent slots on their
own.

**Fix.** `hub.knows(suffix)` is checked before `beginRead()`. An unknown address now costs a 404
and a drained body, nothing else. `deliver()` still performs its own lookup and that one remains
authoritative — the table can change while a body streams in, and only `deliver()`'s answer is
money-relevant; the new check is a doorman, not a decision.

The gate is placed *after* the method and Content-Type checks deliberately, so every status the
`acg_selftest` probes assert is unchanged (a non-JSON POST to an unknown address is still 415,
not 404).

> No new information is disclosed. `deliver()` already answered 404 for an unknown address, so
> the presence oracle of A-14 is unchanged in kind — only in latency.

---

### A-20 · MEDIUM · The inbound body cap and the WebSocket frame cap only met at runtime · **FIXED**

`deliver()` base64-encodes an inbound body into a single WebSocket text frame and checks that
frame against `ws_max_message_bytes` (256 KB). Base64 emits 4 bytes per 3, so the largest body
that can ever be delivered is about **192 KB** — while `inbound_body_bytes` was **1 MB**.

Everything between the two was read in full, buffered, and then answered 413 by a check it could
never have passed. Nothing said so: not the config comments, not the nginx `client_max_body_size
1m`, not the operator-facing text. An operator raising `inbound_body_bytes` would have got no
change in behaviour at all, which is the failure mode of any two limits that only meet at
runtime.

It also set the process's inbound memory budget at `max_inbound_in_flight × inbound_body_bytes` =
**256 MB**, on a box that also runs a Grin node, the pool and Fidelius, and whose unit caps
`MemoryMax=512M` (A-7). Combined with A-19, a stranger could spend it.

**Fix.** `loadConfig()` derives `inbound_max_forwardable` from `ws_max_message_bytes` and clamps
`inbound_body_bytes` to it, warning with both key names when it does. The default drops 1 MB →
**128 KiB** — a slate is a few KB — which puts the inbound budget at 32 MB.
`052_lib_gateway.sh`'s generated config was updated to match.

**Clamped rather than rejected**, deliberately: a `gateway.json` written by an earlier packet
carries `1048576`, and refusing to start on it would take the inbound rail down in order to
enforce a limit that was already being enforced — just late, and after the memory had been spent.

---

### A-21 · LOW · `refuse()` could throw, and a throw on the upgrade path kills the process · **FIXED**

`refuse()` called `message.replace(/[\r\n]/g, ' ')` on a value that one of its callers forwards
verbatim from a caught error:

```js
return refuse(socket, err.status || 400, err.message, err.extraHeaders);
```

An error carrying no `message` raises a `TypeError` inside `refuse()`, which propagates out of
`handleUpgrade` and out of the `'upgrade'` listener — straight to `uncaughtException`. That is the
whole gateway and every other wallet's live socket, restarted by systemd into whatever caused it.
The sibling catch one block above already defended this (`err.message || 'origin not allowed'`);
this one did not.

**Fix.** The value is coerced with `String()` before use, with CR/LF stripping preserved (checked
by a test that the folded text cannot open a second header line). `refuse` is now exported so the
case can be asserted directly — driving it through the hub would only ever exercise the literal
messages `handleUpgrade` passes from its own code, and would prove nothing.

> **Correction to R7 as first reported.** The other half of this finding — that `server.js` did
> not wrap `hub.handleUpgrade` in a try/catch the way it wraps `guard.inspect` — was **already
> fixed by R6** and was raised on the strength of a stale read of that file. Only `refuse()` was
> outstanding. Recorded because an audit that quietly drops a claim it made is worse than one
> that never made it.

---

### A-22 · LOW · A session could expire under a wallet that was actively receiving payments · **FIXED**

The session ttl **is** the address lifetime — `store.js` says so at length, because a client that
gets `false` from `Own URL` discards the suffix and mints a new one. That ttl is rolling, and it
was refreshed by exactly two things: a `/listen` handshake, and a client `Request` on an open
socket. `deliver()` refreshed neither.

So the activity clock counted everything except the activity the address exists for. A tab held
open across the ttl without asking the gateway for anything has its session swept from under a
**live** socket, its suffixes deleted with it, and its inbound payments start answering 404 while
the UI goes on displaying an address that no longer resolves. `store.touchSuffix()` existed for
this and **had no caller anywhere in the gateway** — dead code that reads like the refresh was
intended and never wired.

Severity is LOW because it needs a socket to survive `session_ttl_days` (90) without a single
client request, which a browser tab rarely does. It is fixed because the failure is silent, it
loses money in flight, and the fix is two lines.

**Fix.** `_onInteractionResponse` calls `touchSession` + `touchSuffix` on the success path.
Deliberately on the tab's **accepted response**, not on the arriving request: a request-side
refresh would let any stranger who knows an address hold its session open indefinitely, which is
a different bug in the same place.

## Open / accepted

### A-9 · MEDIUM · `allow_null_origin` makes the Origin filter bypassable, so `/tor/` is an open proxy to any onion's Foreign API · **ACCEPTED**

`checkOrigin` allows `Origin: null` by default (upstream does too). Any page on the internet can
produce `Origin: null` from a sandboxed iframe, so the Origin check does **not** stop a third
party using this gateway as a Tor forwarder. The design already describes this header as "a
cheap filter, not an authorisation control", which is correct; what should be recorded is that
against a motivated third party it is not even that.

**Bounded by** what survives it: destinations are `.onion` only, the path must match
`^(?:/.+)?/v2/foreign$`, methods are POST/OPTIONS, bodies are JSON and capped, `max_concurrent`
is 64, and the rate zones apply. So the abuse available is "use this box's Tor client to reach
other people's wallet Foreign APIs" — amplification and an abuse-complaint risk, not a data
breach, and nothing of the operator's or a visitor's is disclosed.

**Kept because it is load-bearing:** the standalone artefact runs from `file://`, which sends
`Origin: null`, and it needs a gateway to send at all. An operator who does not hand out the
standalone build **should set `allow_null_origin: false`**, and that is the recommendation.
Consider surfacing it on the gateway status screen so the choice is visible.

### A-10 · MEDIUM · Nothing bounds *repeated* inbound requests to a known address · **OPEN**

`max_inbound_per_suffix` (8) bounds concurrency, and the reasoning for keeping it generous is
right (093's lesson: a tight per-victim cap is a DoS *on the victim*). But nothing bounds
repetition. Anyone who knows an address — and an address is public, that is what it is for —
can park 8 requests on it, let them expire at `inbound_timeout_ms` (180 s), and repeat, which
both occupies the payee's slots and spams the tab with receive prompts. Closing the tab does not
help: the address is unchanged and the attacker resumes when it reopens.

There is no cheap fix. A per-suffix rate cap answering 503 + `Retry-After` would trade a slow
payment for a live wallet and is the direction to explore, but it needs a real client in front
of it to tune. **Recorded, not fixed.**

### A-11 · MEDIUM · `patches/` is applied over the pinned tree and is itself outside the pin · **OPEN (new work)**

S6's gate is genuinely strong for what it covers: manifest-vs-`PINNED_SHA` first, then
`sha256sum -c`, then the file set both ways, no bypass. It covers `vendor/`. It does **not**
cover `patches/public_html/` — **19 files, 656 kB** (16 at audit time; `scripts/mqs.js` arrived
with S9 pass 1, and S10's theme added `styles/accio.css` + `errors/template.php`), applied by whole-file replacement immediately afterwards, including
`scripts/node.js` and `index.html`. A tamperer with write access to the
toolkit checkout on the VPS edits a patch file and the build proceeds, verified and clean.

The counter-argument is real: someone who can write to `patches/` can also write to
`gateway/*.js` and to the libs, so the whole checkout is already trusted. But the pin chain
currently reads stronger than it is — it covers the code we did *not* write and not the code we
*did*, and ours is the code that ships on top.

**Recommendation:** the checkout is a git working tree, so the cheapest honest check is
`git -C <repo> status --porcelain -- web/052_accio/patches web/052_accio/gateway` at build time,
reported (not fatal — a legitimate dev edit must not fail a build). A `patches/SHA256SUMS`
regenerated at commit time is the stronger version.

> **Mechanism, specified by R8 (2026-08-12).** Still open — this is the design, not the code.
>
> **`patches/SHA256SUMS`, verified by the same three checks `acv_verify_vendor` already runs,
> in the same order and for the same reasons.** Not a new pattern; the existing one pointed at
> a second tree.
>
> 1. **The manifest's own hash first.** `PINNED_SHA` gains `PATCHES_MANIFEST_SHA256`. Without
>    this the manifest certifies only itself, which is `acv_verify_vendor`'s step-1 lesson
>    verbatim — a regenerated manifest agrees with a tampered tree.
> 2. **`sha256sum -c`** over `patches/public_html/`.
> 3. **The file set, both directions.** `sha256sum -c` structurally cannot see an *added* file,
>    and the overlay copies whatever it finds — an added patch file lands in the served root
>    with no vendored counterpart to compare it against. This is the check that matters most
>    here, more than it does for `vendor/`.
>
> **Two things that differ from `vendor/` and must not be copied across:**
>
> - **`patches/` is ours, so a mismatch is not automatically an attack.** A developer editing a
>   patch is the normal case; a developer editing `vendor/` never is. So this gate is
>   **fatal on a deployment, advisory on a development checkout** — the discriminator being
>   whether `git -C <repo> status --porcelain -- web/052_accio/patches` is empty. Clean tree +
>   manifest mismatch = stop. Dirty tree = report loudly, build anyway, and say in the build
>   log which files are uncommitted, because that is the sentence that would tell an operator
>   their box is not running what the repo says.
> - **Regenerating it is a repo commit, never a VPS action.** Same rule as `vendor/SHA256SUMS`,
>   and it needs saying twice because this manifest legitimately changes on most patch work,
>   so the muscle memory "just regenerate it" is much easier to acquire here.
>
> **Do it with the file, not the git tree.** `git status` was the earlier suggestion above and
> it is cheaper, but it answers a different question — it certifies the checkout against its
> own `.git`, which a tamperer with write access to the checkout also owns. It is worth
> printing as context; it is not the control.
>
> **Cost:** one `acp_verify_patches` in `052_lib_vendor.sh` (which already owns the three-check
> pattern, the `_acv_manifest_paths` reader and the escaped-filename guard), one call at the top
> of `_acb_apply_patches`, one key in `PINNED_SHA`, one regeneration step in the patch workflow.
> **R8 did not implement it**, because writing to `052_lib_vendor.sh` is R2's file and the
> gate belongs to the build path R3 owns; both are review packets whose sessions are already
> closed. It belongs to whoever next opens either file.

### A-12 · MEDIUM · The deployed site is never re-verified against the build manifest · **OPEN (new work)**

`accio_build` writes `${outdir}.SHA256SUMS` outside the served root, and **nothing ever checks
it again.** For a self-custodial wallet this is the attack that matters most: whatever
`$ACC_SITE_DIR` serves is what signs a visitor's transactions, and a single edited byte in one
served `.js` file after deployment is a seed exfiltration with no other symptom.

**Recommendation:** a "Verify deployed site" action doing what `acv_verify_vendor` already does
one level up — `sha256sum -c` plus a file-set comparison **both ways** (an *added* file in the
served root is the more interesting attack, and `sha256sum -c` structurally cannot see it).
Note the manifest sits next to the tree it certifies, so a tamperer can regenerate it: the check
is only tamper-*evident* if the manifest's own sha256 is recorded off-box, which is exactly the
pattern Provider Access Watch (082) already uses.

> **Mechanism, specified by R8 (2026-08-12).** Still open — this is the design, not the code.
>
> **`accio_verify_deployed <net>`, on menu key 7 (Status) and again at the end of every deploy.**
> Three checks, the same shape as A-11's, over `$ACC_SITE_DIR` against `${outdir}.SHA256SUMS`:
> the manifest's own hash, `sha256sum -c`, then the file set both ways.
>
> **What is different here, and it is the whole finding:** the manifest and the tree it
> certifies are on the same box, under the same root, reachable by the same attacker. Verifying
> one against the other proves only that they are *consistent*, which a tamperer gets for free
> by rerunning `sha256sum`. So the mechanism is in two halves and the second is the one that
> carries the property:
>
> 1. **On-box:** the three checks above. This catches accident, a half-finished rsync, a
>    partially-applied deploy, and an unsophisticated tamperer. Cheap and worth having.
> 2. **Off-box:** print the manifest's own `sha256sum` as a single line the operator is told to
>    record somewhere that is not this server, and compare against it on every later run. That
>    is the only part an attacker with root cannot satisfy, and it is exactly what 082 already
>    does (memory `project_provider_access_watch`, "prints an off-box hash for tamper-evidence").
>    Reuse its wording so an operator who runs both recognises the same instruction.
>
> **The file set both ways is not optional here.** An *added* `.js` in the served root that
> `index.html` references is the seed-exfiltration attack in its most direct form, and it is
> precisely the case `sha256sum -c` cannot see. R2 already learned this on `vendor/`.
>
> **One trap specific to the served tree:** it is not static. `certbot`, a PWA service-worker
> cache and nginx can all leave files under or beside it, and a check that cries wolf on those
> gets ignored within a week. Scope the comparison to the tree the manifest actually lists and
> enumerate any known-variable paths explicitly rather than globbing them away.
>
> **R8 did not implement it** — it is an action in the entry script and the build lib, R1's and
> R3's files, both closed. **This is the single highest-value piece of unwritten work in the
> product**: every other control in the pin chain exists to decide which bytes get written to
> `$ACC_SITE_DIR`, and nothing has ever looked at them again afterwards.

### A-13 · LOW · The WASM crypto has no runtime integrity check · **ACCEPTED**

221 of 252 resource entries carry a real SRI checksum, including the five `.wasm` files — but
`getChecksum()` is only ever emitted into `<link>`, `<script>` and one `<img>` (where `integrity`
is inert). The emscripten wrappers fetch their `.wasm` with a plain
`fetch(Q, {credentials:"same-origin"})`, so **the actual cryptography loads unverified at
runtime**.

Accepted, because SRI would not add anything here: it protects against a *third-party* origin
serving something different, and these are same-origin files from our own server. An attacker
who can change the `.wasm` can change the `index.html` that carries the hash. The real control
is the pin chain — which is A-11 and A-12, and that is where the effort belongs.

### A-14 · LOW · `/wallet/<suffix>` is a presence oracle · **ACCEPTED (inherent)**

404 means "no such address", 503 + `Retry-After: 30` means "that wallet is not connected". So
anyone holding an address can tell whether that person's wallet is open right now, and poll it.
This is inherent: a payer *must* be told the difference, and the alternative (hold the request
open) is upstream's `proxy_read_timeout 208w`, which S3/S4b rejected for good reasons. Worth
stating in the privacy policy rather than engineering away.

> **Disclosed by R8 (2026-08-12).** The acceptance was recorded here and then never carried out
> — the S5 privacy-policy rewrite predates this finding and said nothing about it, so "we will
> tell users instead of fixing it" had held for exactly as long as it took to write the
> sentence. `patches/public_html/privacy_policy.txt` now carries a *What Your Receiving Address
> Reveals* section saying that an address discloses whether the wallet is open and that it can
> be polled. The finding stays ACCEPTED; what changed is that the acceptance is now true.

### A-15 · INFO · Two dead defensive checks

`guard.checkOrigin`'s `Array.isArray(origin)` and both `Array.isArray(contentType)` checks can
never fire. Node joins duplicate `Origin` headers with `", "` (yielding a string that then fails
the allowlist — fails closed, correctly) and *discards* duplicate `Content-Type`, keeping the
first. Harmless; left in place as documentation of the intent, noted here so nobody mistakes
them for live controls.

---

### Added by the R8 review — 2026-08-12

R8's packet was the overlay (`patches/**`), which S8 did not cover at all — S8's scope was the
gateway, the libs and the artefacts they generate, and it says so. One security finding came
out of it, and it is in the artefact the product describes as *offline*.

### A-23 · MEDIUM · The standalone build contacted `api.github.com` on every load, undisclosed · **FIXED**

`scripts/check_for_updates.js` branches four ways on how the wallet is running. The
`location["protocol"] === Common.FILE_PROTOCOL` branch — **the standalone artefact, and the only
one of the four that Accio actually builds besides the hosted site** — set
`newestVersionUrl` to `https://api.github.com/repos/…/releases/latest`, and
`SETTINGS_ENABLE_CHECKING_FOR_UPDATES_DEFAULT_VALUE` is `true`. So opening the standalone HTML
issued an unsolicited request to GitHub before the user did anything.

Three separate problems, in increasing order of how much they matter:

1. **It contradicts the artefact's purpose.** The standalone exists to be usable with no
   infrastructure — carried on a stick, opened from a filesystem, used where the hosted site is
   not reachable. An artefact sold as offline that beacons on load is not that.
2. **It is a disclosure the shipped privacy policy did not make.** `privacy_policy.txt` names
   exactly two things that leave the browser — the `/tor/` relay and the `/listen` inbound URL —
   and says "neither is required to hold Grin". A third contact, to a party the document never
   mentions, told GitHub the visitor's IP and that they run a Grin wallet. For a *self-custodial
   privacy coin wallet* the user population is exactly the one that minds.
3. **It could not have worked anyway.** It compares the newest `v*` tag of the **toolkit's**
   GitHub releases against `VERSION_NUMBER`, which is the **upstream wallet's** version
   (`"2.8.2"`, `backend/common.php`). Two unrelated version lines, compared with
   `isVersionGreaterThanOrEqual` — which fires on *equal* as well as greater. Whatever the
   toolkit happened to tag would drive a "new version available" prompt in the wallet.

The hosted site was never affected: its branch is the `else`, which leaves `newestVersionUrl`
undefined and hides the setting, and `checkForUpdates()` guards on `typeof … !== "undefined"`.

**Severity MEDIUM** rather than LOW because of what the request identifies — not because the
data is large. There is no exfiltration of wallet contents and the response is only read for a
tag name.

**Fix.** The `FILE_PROTOCOL` branch is deleted, so the standalone falls through to the same
`else` the hosted site takes: no URL, no request, setting hidden. One `else if` block restores
it, and the note in the file says a shared version line would have to come with it.

**How it survived S5, S6 and S8** is the part worth keeping: this file carried **no
`ACCIO PATCH` marker at all** despite six rewritten URLs, and the documented review method for
the overlay is to grep that marker rather than diff 13k lines. The marker was the control, and
it was absent on the one overlay file that added a network call. See the R8 session entry in
`script052_implementation.md`, and `patches/README.md`, which now carries the marker rule and a
table covering the formats that cannot hold an inline one.

---

## Passing items — controls checked by reading the code and found correct

- **DNS rebinding is structurally impossible on `/tor/`.** The guard's decision and the
  connection are about the same string: `socks5.js` sends `ATYP 0x03` (domain name) and lets Tor
  resolve, so this process never resolves a name and there is no window to rebind in. This is the
  single best decision in the gateway.
- **A hostile onion cannot get HTML rendered on the wallet's origin.** The obvious escalation —
  navigate a browser to `https://wallet/tor/http://evil.onion/v2/foreign` and have the onion
  answer `Content-Type: text/html` — is closed twice over: a top-level navigation is a GET
  (`checkMethod` → 405), and the only way to navigate with a POST is a form, whose three possible
  enctypes are all refused by `checkContentType` (415). A cross-site form also fails
  `checkOrigin`. Traced all three enctypes explicitly; the pair of rules holds.
- **The response allowlist is right to be an allowlist**, and `Transfer-Encoding` is correctly
  *not* copied (this process re-frames the body). `X-Content-Type-Options: nosniff` set via
  `setHeader` survives `writeHead(obj)` — Node merges, with `writeHead` winning ties.
- **The proxied routes keep the server block's headers.** The gateway snippets contain no
  `add_header` at all, so `/tor/`, `/listen` and `/wallet/` inherit the full set including CSP.
  This is the one place the "child block discards the parent" trap was avoided correctly, and it
  is avoided by having nothing to discard.
- **The port split is a real trust boundary**, not a convention: classification is by
  `socket.localPort`, `X-Forwarded-Proto` is honoured only on the nginx front, and the onion
  front ignores forwarding headers entirely. A Tor visitor cannot mint an identity.
- **No destination is ever logged** unless `log_destinations` is explicitly enabled, and no
  `Denied` message contains a host. Checked every `log.warn`/`log.error` on both rails: none of
  them can interpolate a destination or a suffix. `/health` reports counts only.
- **`agent: null`, not `agent: false`** — the comment explaining this is correct and the
  distinction is real; `false` would silently bypass the entire Tor rail.
- **Session ids are 256 bits from the CSPRNG and are looked up server-side**, so a forged cookie
  must guess a row rather than construct one. Suffixes are 80 bits over an unbiased power-of-two
  alphabet (mask, not modulo).
- **`ws.js` refuses unmasked client frames, reserved bits, binary frames and oversized frames at
  the header, before buffering**, caps reassembled fragments as well as individual ones, and does
  not echo `Sec-WebSocket-Extensions`. Also verified correct: `head` is parsed on
  `process.nextTick` rather than in the constructor (a client can pipeline frames into the
  upgrade packet, and parsing them before the caller attaches listeners loses the first message
  and can throw out of `handshake()` after the 101 is on the wire), and every error goes through
  `_emitError`, which checks `listenerCount` first — a bare `emit('error')` on an EventEmitter
  with no listener **throws**.
- **The ack ordering is money-correct**: the response is flushed to the sender before the tab is
  acked, and a failed write sends an `Error` so the tab rolls back deliberately rather than by
  its 120 s timeout.
- **The socket cap refuses rather than evicts**, which is what stops a reloading tab from
  disconnecting a *different* tab mid-payment.
- **`acv_verify_vendor` checks the manifest's own hash first**, which is the only check that
  notices a regenerated manifest, and the file-set comparison runs both ways with `! -type d` so
  an added symlink cannot smuggle content past it.
- **`acv_check_upstream` cannot mutate anything**: bare clone, no working tree, scratch dir
  asserted to be outside the product tree, and `_acv_assert_offline_path` greps the *parsed*
  function bodies so the verify chain cannot grow a fetcher.
- **Both nginx failure paths restore a known-good config** rather than leaving a broken file that
  the next reload — by any other product — would fail on, taking every vhost on the box down.

---

## Owed to the acceptance session (S2) — what this audit could not test

1. **⚠ BLOCKING — that a real client claims its addresses on reconnect** (`Own URL` per held
   suffix). This was written as "watch it, then delete the fallback". **A-18 deleted the fallback
   first**, because leaving it in was strictly worse than the risk of removing it — so this item
   has changed character: it is no longer confirmation that a safety net can go, it is the thing
   that decides whether inbound payments work **at all**. A client that does not claim now cannot
   receive.
   *How to watch it:* `inbound_unclaimed` in `/health` should sit at or near zero in steady state
   and tick only around reconnects. A count that climbs while a wallet is idle-but-open means the
   client is not claiming and the rail is failing closed — check that before concluding the
   address is wrong. **Do not run a mainnet receive until this reads clean on testnet.**
2. **That the security headers are on the wire** — on `/`, on an asset response, and on
   `/standalone.html`. A-4 was found by reading; confirm it is fixed by `curl -I` on all three.
3. **That the tightened CSP does not break the wallet.** Boot it, unlock a wallet, build a slate.
   Then remove `'unsafe-eval'` and do it again — that is A-8's remaining half.
4. **That `IPAddressDeny=any` does not break the gateway** (A-7). If `/tor/` starts answering 502
   with `EPERM` in the journal, that is this directive and `socks_host`.
5. **That the address table survives a restart** — `systemctl restart`, then confirm the wallet's
   receiving address is unchanged. The store's harness proves the code; only the box proves the
   permissions.
6. **A hostile-response probe.** Point `/tor/` at an onion you control that answers with
   `Set-Cookie`, a `Location`, its own CSP and `Content-Type: text/html`, and confirm none of it
   reaches the browser.
7. **That an uninstall leaves nginx able to START, not merely to reload** (A-16). Deploy so the
   gateway include lands in a vhost *not* named `accio-<net>` — set `ACCIO_DOMAIN` to a site that
   already has its own vhost — then run menu 8 and follow it with a real
   `systemctl restart nginx`, not just `nginx -t`. This is the one finding in this file whose
   failure mode is other products going down, and it has only ever been tested on a fixture.
8. **That the network picker's badge tells the truth after an uninstall** (R1). `/opt/grin/accio-<net>`
   is deliberately kept by an uninstall, so the badge is now keyed to the unit file. Confirm the
   picker reads "not installed" once the unit is gone, and "site built, no gateway" when only the
   site survives.
9. **That a receive still works with the inbound body cap at 128 KiB** (A-20). Nothing we ship
   composes a slate anywhere near it — they are a few KB — but the cap moved by a factor of eight
   and the first real receive is what would find out. A body over the cap answers 413; a slate
   that big would previously have failed at 413 anyway, one layer later.
10. **That an existing `gateway.json` gets clamped rather than rejected** (A-20). Any config
    written before 2026-08-12 carries `inbound_body_bytes: 1048576`. On first start after the
    upgrade the journal must show the `[config]` clamp warning naming both keys, and the service
    must come up. If it refuses to start instead, that is a regression in the clamp, not a bad
    config.

## What this audit did NOT cover

- **The vendored wallet itself.** ~128 000 lines of upstream JavaScript, the five WASM modules
  and their emscripten wrappers, and the key handling, slate construction and signing that make
  this a wallet. The design already states the position plainly — "we inherit ~6 MB of someone
  else's wallet JavaScript that we did not write and cannot fully audit" — and that is unchanged
  by this pass. What is audited is everything *we* wrote and everything we deploy it with.
- **The standalone artefact's inlining**, beyond confirming that SRI is correctly disabled for it
  and that it is served as an attachment (which is what keeps the site's own CSP from breaking a
  page built entirely out of `data:` URIs). Its leftover-reference count is an S2 check.
- **Anything requiring a running box:** TLS configuration as negotiated, certbot renewal, the
  onion's published descriptor, real rate-limit behaviour, and the interaction with the other
  products sharing the box.
- **Cryptographic review of the Grin protocol usage.** Out of scope for a gateway that never
  sees a key.

---

## Cross-references

- The same Node + Tor + queue shape was audited for Script 09 —
  [script09_security_audit.md](script09_security_audit.md). Its two hard-won lessons were
  already honoured here (capacity partitioned per writer, id normalised at the route), and A-2
  is the third one this product had to learn on its own: **a table a stranger can grow for free
  needs a bound, not just a rate limit.**
- Design and packet map: [script052_design.md](script052_design.md).
- Session log and the running list of what is owed:
  [script052_implementation.md](script052_implementation.md). The R7 pass that produced
  A-18 … A-22 is written up there in full, including the two test doubles that were wrong before
  they were right.
- **The regression suite is part of this audit's evidence**, not an extra:
  `web/052_accio/gateway/test/{helpers,guard,money_rails}.test.js`, run with
  `node --test test/guard.test.js test/money_rails.test.js` from the gateway directory. Every
  finding in this file that lives in the gateway has an assertion, and each R7 assertion carries a
  `⚠ THE NEGATIVE CONTROL` comment naming the revert that makes it fail. Those reverts were
  performed, not assumed — an assertion nobody has watched fail is not evidence, which this
  product learned twice (S9's "96 passed" that was really 95/1 against a wrong test, and S7's
  silently no-op worker phase).
