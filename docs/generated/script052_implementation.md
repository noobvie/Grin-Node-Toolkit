# Script 052 — Accio: implementation & session log

The **handoff between build sessions is this file, never the chat.** Each packet ends by
writing its outcome here; the next session reads this file plus its own packet in
`script052_design.md` §"Build plan" — and nothing else. If a session ends with knowledge only
in a conversation, the packet is not finished.

**Standing header — paste at the top of each new session**, substituting the packet number:

```
Working on Accio (script 052), session S<n> of docs/generated/script052_design.md
§"Build plan". Read that packet's "Read first" list, do the "Do" list, verify with
"Verify", then do "Close-out". Do not read other packets. Do not run scripts locally —
this is a VPS product.
```

## Current state

| | |
|---|---|
| Packets done | **S0** (+ a review pass) · **S1** · **S3 (code, + a review pass)** — all 2026-08-09 · **S4a** · **S4b (code)** · **S5 (code)** · **S6 (code)** · **S7 (code)** — 2026-08-10 · **S8 (security audit)** · **S9 pass 1 — MQS (code)** — 2026-08-11 · **S10 — theme "Orbital Dawn" (code)** — 2026-08-16 |
| Audit | **[script052_security_audit.md](script052_security_audit.md)** — S8, 2026-08-11, amended by R1, R7 and R8. **16 findings fixed, 6 open.** The one that mattered: inbound payments were routed by SESSION, so a cookie could redirect a stranger's payment into another wallet (A-1, and A-18 when it turned out A-1's accepted residual gave the whole of A-1 back) |
| Review arc | **COMPLETE — R1…R8, all eight done, 2026-08-11 → 2026-08-12.** One session each; see §"Review plan" below for what each packet covered. The arc read the whole authored surface before S2 spends VPS time on it. **R2 has no session entry below** — 8 fixes, verified present in `052_lib_vendor.sh`, write-up in memory `project_web_wallet_051_vs_055`. Every other packet's entry is in the session log |
| Next packet | **S2** — no longer a build packet at all, it is **the acceptance session**. First VPS work, carrying S1's, S3's, S4b's, S5's, S6's, S7's, S8's *and* S9 pass 1's acceptance runs. Everything that can be authored has been. |
| Deployed anywhere? | **No.** Nothing has ever run on a VPS. Not one build, deploy, send or receive. |
| Script 052 menu | **every key is LIVE** as of S7 — there is no stub left in this product. That is not the same as tested |
| Overlay | `patches/public_html/` — **19 files / 656 kB** (17 replace a vendored file, 2 add one; 678,170 bytes measured 2026-08-24, after the Duo marks of 2026-08-17 — it was 671,637 on 2026-08-16, and only the four SVGs changed between), **49 `ACCIO PATCH` markers, 34 of them in the published file set** (`backend/` and `errors/template.php` are build-time only, never served). Search for that string, not for a diff — and see `patches/README.md` for the five files whose format cannot carry an inline marker, which the table there covers instead |
| Theme | **"Orbital Dawn"** — `styles/accio.css`, loaded **last** so it beats upstream's colours on source order. Upstream's 22 stylesheets are not overlaid; the three hooks are the `<link>` in `index.html`, the same `<link>` in `errors/template.php`, and the `$files` entry + `THEME_COLOR`/`BACKGROUND_COLOR` in `backend/resources.php`. Retuning is a `:root` token edit. **Never seen in a browser** — see S10 |
| Pin enforcement | `accio_build` refuses to stage anything unless `acv_verify_vendor` passes — manifest-vs-`PINNED_SHA`, then `sha256sum -c`, then the file set both ways. **No bypass.** Never "fix" a failure by regenerating `SHA256SUMS` on the VPS |
| Branding | Two files (`backend/language.php`, `scripts/language.js`) carry a phrase map that rebrands the whole app in all six languages. **The two maps must stay identical** — 12 entries each since R8. A new language must be checked against the map before it ships: three of the six translators did not keep the English word order, which left 27 strings unbranded until 2026-08-12 |
| Hub 05 key `2` | `run_sub "052_grin_accio.sh" \|\| true` since **S7** (2026-08-10). The `_slot_notice` arm is deleted, not aliased |
| Upstream pin (wallet) | `adef11daadf04e4ec259d6febcc720da3daaa6c7` (v2.8.2, MIT) |
| Upstream pin (build script) | `043c2ddc8105721a0b75ece3f614d44b66c79150` (MIT) — a spec, never run |
| Manifest | `vendor/SHA256SUMS` — **274 files / 7,517,960 bytes** across both trees |
| Gateway modules | **9**, still **zero npm dependencies**. Regression suite `gateway/test/` — 4 files, **78 tests, 78 pass, 0 fail** under `node --test` (measured by R8, 2026-08-12). Run it from `web/052_accio/gateway/`; **`node --test test/` fails on Windows** — use no argument, or `node --test "test/*.test.js"` |
| Libraries | **4** — `052_lib_build.sh` (site + standalone), `052_lib_gateway.sh`, `052_lib_nginx.sh` (S7), `052_lib_vendor.sh` |
| Gateway state | `/opt/grin/accio-<net>/gateway-state/` — the suffix ↔ session table. **Losing it changes every wallet's receiving address.** The only `ReadWritePaths` in the unit |

**S3 was taken out of order, deliberately.** It is specified as depending on S2, and that
dependency is real for its *verification* — but not for its authorship: the gateway is a
self-contained Node service whose only contract with S2 is one `include` line in a vhost.
Writing it against a fake SOCKS proxy and a fake onion proved more than a first VPS run
would have (it found three bugs that a live smoke test would have shown only as "the send
hangs"). What S2 now owes is both packets' acceptance runs, listed at the end of each session
entry. Nothing here should be reported as deployed.

**There are no no-VPS packets left, and now there are no build packets left either.** `S4a`,
`S6` and `S7` were all done on 2026-08-10; everything the S0–S8 arc can author against the
vendored tree has been. The next session needs a box, and its whole job is acceptance.

**S9's deletion passes are the one exception, and they are optional.** They are authorable
offline like everything else, and pass 1 was, but the design gates them on *"S7 is green"* — i.e.
on the acceptance session having happened. Pass 1 crossed that gate knowingly and paid for it in
argument and static verification; **pass 2 should wait for a box**, because it is the pass that
starts deleting files rather than reducing one.

**S4b's input contract was `script052_design.md` §"Listen protocol" and nothing else, and it
held** — `listener.js` was never opened in S4b. The same rule applies to anyone touching the
listen rail later: the spec is the contract, and re-reading the 1901-line client is the
compaction S4a exists to prevent.

**The SRI refresh works, and it now has a NULL mode.** S5 patches `scripts/node.js` and eight
other files that carry a hardcoded checksum (S1 note (c)); `_acb_apply_patches` recomputed all
nine and every one was verified against the patched bytes. Using the machinery for real also
found the hole in it — see S5's "Two bugs in S1's own lib, found by using it".

---

## Review plan — R1…R8 (one session each)

Everything S0–S9 authored is **written but unrun**. Before the acceptance session (S2) burns
VPS time on it, the whole surface gets read once, deliberately, in eight sessions. This
section is the handoff for that arc, exactly as the `## Session log` is for the build arc:
**a review session reads this plan plus its own packet and nothing else.**

**Standing header — paste at the top of each review session**, substituting the packet:

```
Reviewing Accio (script 052), packet R<n> of docs/generated/script052_implementation.md
§"Review plan". Read that packet's "Files" and "Hunt for" lists, review only those files,
then do "Close-out". Do not review other packets' files. Do not run scripts locally —
this is a VPS product; verification is bash -n / node --check plus reading.
```

### Rules that bind every review packet

1. **Read-only by default.** A review packet reports; it fixes only what it can prove from
   the code in front of it. Anything needing another packet's file is written up as a
   finding with the file path, not chased across the boundary.
2. **Confirm before editing** (CLAUDE.md *Debugging*). A plausible suspect is not a cause.
   With no VPS, "confirmed" means: the code path is traced end-to-end in the file, or a
   one-shot local check proves it (`bash -n`, `node --check`, `node -e` on a pure function,
   a `sed`/`awk` run on a fixture in the scratchpad). Never start a server.
3. **Verify after editing.** Shell → `bash -n`; gateway JS → `node --check`; both →
   re-run the relevant offline assertion count if the packet has one.
4. **Where findings go.** Security findings append to
   `script052_security_audit.md` §Findings, numbered on from **A-15** (keep the
   HIGH/MEDIUM/LOW + FIXED/OPEN/ACCEPTED format). Logic, dead-code and doc-truth findings
   append to this file's `## Session log` as `### R<n> review — <date>`. Nothing stays in
   chat.
5. **A finding that can only be settled on a box** is not a failure — write it into
   §"Owed to the acceptance session (S2)" in the audit doc and move on.
6. **Do not re-litigate the pin.** `vendor/` is upstream. If a review wants a byte changed
   there, that is a re-vendor in this repo, never an edit and never a manifest regen.

### Invariants no review may break

Written here so eight cold sessions can't each rediscover them the hard way:

- **`vendor/` is untouchable**; deviations live in `patches/` and are marked `ACCIO PATCH`.
- **`MWC_WALLET_TYPE` is a chain discriminator, not branding** — never renamed.
- **nginx `add_header` in a child block discards the parent's set** — every block that adds
  any header of its own must include the headers snippet.
- **`TOR_SERVER_ADDRESS` is baked in at BUILD time** — minting an onion without a rebuild
  ships a clearnet host to the user who picked "Onion Service".
- **`gateway-state/` is durable state, not a cache** — losing it changes the receiving
  address of every wallet that ever connected.
- **An S9 reduction must never change how a slate is READ.**
- Menu loops under `set -e`: every `case` dispatch `||`-guarded; no function ending in
  `[[ … ]] && cmd`.

### Recommended order

By review debt, cheapest-and-most-foundational first. **R1–R5 and R8 are independent**;
R6 should precede R7 (R7's rails lean on R6's guard/store contracts).

| # | Packet | Files | ~lines | State |
|---|---|---|---|---|
| ~~R1~~ | ~~Entry script & menu~~ | `scripts/052_grin_accio.sh` | 722 | **DONE 2026-08-11** — A-16, A-17 + 8 fixes |
| ~~R2~~ | ~~Pin enforcement~~ | `scripts/lib/052_lib_vendor.sh` | 651 | **DONE 2026-08-12** — 8 fixes (deny-list offline guard, `ext::` URL, report path, `${root:?}`, INT/TERM trap). ⚠ **No session entry in this doc** — write-up is in memory `project_web_wallet_051_vs_055`; the fixes are verifiable in the file |
| ~~R3~~ | ~~Build & standalone~~ | `scripts/lib/052_lib_build.sh` | 1219 | **DONE 2026-08-12** — 3 critical + 6 medium + 7 low, all fixed |
| ~~R4~~ | ~~Nginx, TLS, onion~~ | `scripts/lib/052_lib_nginx.sh` | 1118 | **DONE 2026-08-12** — 1 critical + 4 medium + 6 low, all fixed |
| ~~R5~~ | ~~Gateway install~~ | `scripts/lib/052_lib_gateway.sh` | 1227 | **DONE 2026-08-12** — 2 critical + 4 medium + 4 low + 4 cosmetic, all fixed |
| ~~R6~~ | ~~Gateway core~~ | `gateway/{server,config,guard,store}.js` | ~1310 | **DONE 2026-08-12** — 2 critical + 5 medium + 10 low, all fixed; added `gateway/test/guard.test.js` |
| ~~R7~~ | ~~Gateway money rails~~ | `gateway/{listen_route,wallet_route,tor_route,socks5,ws}.js` | ~1910 | **DONE 2026-08-12** — 1 critical + 2 medium + 2 low, all fixed; added `gateway/test/money_rails.test.js`. **A-1's fallback is gone** → A-18 |
| ~~R8~~ | ~~Overlay, MQS, doc truth~~ | `patches/**` + the open audit items | ~13k (diff-driven) | **DONE 2026-08-12** — A-23 + 4 fixes; A-11 and A-12 mechanisms specified (not written); MQS reduction verified sound. **The arc is complete** |

---

#### R1 — Entry script, menu, network selection, uninstall

**Files:** `scripts/052_grin_accio.sh` (674). Reference only, don't review:
`scripts/05_grin_wallet_service.sh` (hub key `2`).

**Hunt for:**
- Header comment's menu vs the real `case` — every option reachable, no dead arm, no
  key that changed hands (a second `case` arm for a key is dead code, bash takes the first).
- Every dispatch `||`-guarded; no function whose last statement is `[[ … ]] && cmd`.
- `acc_set_network` (:174) populates **every** `ACC_*` var — network, net short, label,
  dir, service, site dir — before any consumer reads one. Trace one path per network.
- `tGRIN` in all testnet-facing output; no mainnet/testnet port, dir, unit or nginx name
  shared. Check `ACC_NET_SHORT` derivation once and follow it everywhere.
- `acc_uninstall` (:538): every `rm -rf` `${VAR:?}`-guarded; confirm it cannot reach
  `gateway-state/` without an explicit, separate confirmation, and that its prompt says
  what losing that state costs.
- `_acc_conf_get`/`_acc_conf_set` (:202/:210) — quoting, key collision, and the
  `source`-leaves-deleted-keys-resolving trap (`unset` first) from Script 01's source build.
- `_acc_load_lib` (:222): a missing lib must fail loudly, not silently skip a menu action.
- `acc_status` (:426) must not report "installed" from a path that exists but is empty.

#### R2 — Pin enforcement and upstream drift

**Files:** `scripts/lib/052_lib_vendor.sh` (603). Read for context: `web/052_accio/PROVENANCE.md`,
`vendor/SHA256SUMS` (head only — do not read the vendored tree).

**Hunt for:** this lib is the gate the whole product's integrity rests on, so the question is
not "does it verify" but **"what gets through"**.
- `acv_verify_vendor` (:195) — the three checks (manifest's own hash vs `PINNED_SHA`,
  `sha256sum -c`, file set **both ways**). Prove an **added** file is caught, prove a
  **removed** one is, prove a **renamed** one is. `sha256sum -c` alone sees none of them.
- Can any caller reach a build with verification skipped, failed-but-ignored, or run
  against a different dir? Grep every call site.
- `_acv_assert_offline_path` (:142) and `_acv_manifest_paths`/`_acv_tree_paths` (:174/:188):
  path traversal, spaces/newlines in names, `..` entries, symlinks.
- `_acv_patched_upstream_paths` (:319) — the patches↔vendor overlap list. If it is stale,
  A-11 gets worse; confirm it is derived, not hand-kept.
- `acv_check_upstream` (:489) must be read-only and network-failure-tolerant; a GitHub
  outage must not read as "upstream changed".
- Confirm nothing in this file can write `SHA256SUMS` on a target box.

#### R3 — Build: templating, SRI, patch application, standalone inliner

**Files:** `scripts/lib/052_lib_build.sh` (1125).

**Hunt for:** S5 already proved this lib can fail **silently**. That is the theme.
- **Every `sed`/`awk` that must fire.** `sed` exits 0 when its address never matches — the
  `.*`→`[^>]*` "tightening" made a whole inlining phase a no-op. For each substitution ask:
  what asserts it happened? Where nothing does, that is the finding.
- `_acb_apply_patches` (:433) + `_acb_set_resource_entry` (:355) + `_acb_sri` (:335): all
  **221 hardcoded SRI sums** recomputed against **patched** bytes, `scripts/node.js`
  included; the NULL mode (S1 note (c)) still correct.
- `_acb_assert_output` (:525) — is it strong enough to catch a half-rendered site? An empty
  or short output file, a leftover template token, a missing patched file.
- `_acb_is_templated`/`_acb_excluded` (:234/:245): a file that is both, a file that is
  neither, extension-vs-path matching.
- **`TOR_SERVER_ADDRESS` and every other build-time constant** — enumerate what is baked in
  and confirm each has a rebuild trigger somewhere (R4 owns the onion side; note the pair).
- Standalone chain `_acb_sa_*` (:747–1075): base64/MIME correctness, `_acb_sa_re` escaping,
  worker and CSS inlining, and whether the standalone can silently ship a file that still
  points at the network.
- Build atomicity: a failure must leave `$ACC_SITE_DIR` untouched (the script claims this at
  :369 — verify the lib actually stages elsewhere and swaps).
- Unquoted `$VAR` in any `cp`/`rm`/`find`; `mktemp` vs fixed `/tmp` names.

#### R4 — Nginx, TLS bootstrap, onion service

**Files:** `scripts/lib/052_lib_nginx.sh` (1016). Reference: `scripts/lib/nginx_shared_helpers.sh`.

**Hunt for:**
- **Header inheritance.** Every `location`/`server` block that adds any header of its own
  must `include` `_acn_headers()`. Enumerate all blocks in all three vhosts (http, ssl,
  onion) and check each. A missing include on `/tor/` or `/listen` is the exact failure
  mode that drops the CSP from the routes that matter.
- Cert bootstrap ordering: no vhost referencing `/etc/letsencrypt/live/…` is written or
  reloaded before the cert exists; `options-ssl-nginx.conf` included only if present; no
  shell syntax inside an nginx file.
- `_acn_write_onion_vhost` (:395) + `acn_onion_enable` (:783): the onion snippet must carry
  **no `limit_req`**, and enabling an onion must force or clearly demand a **rebuild**
  (`TOR_SERVER_ADDRESS`). Check what happens if the operator declines.
- `_acn_torrc_strip` (:769) — an idempotent, marker-scoped edit that cannot eat a neighbour's
  HiddenService block. Read it as if two Grin products share the torrc.
- **Heredocs:** any unquoted heredoc generating nginx config — a backtick silently eats
  words. Grep for `<<[A-Z]` without quotes across the file.
- `nginx -t` before every reload (`_acn_reload` :489); zones via the shared primitive, never
  inline, never appended to an existing conf file.
- `_acn_fix_site_perms` (:507): no world-writable path; site readable by the web user only.
- Mainnet/testnet: vhost, link, snippet, hs dir and torrc marker all carry `ACC_NET_SHORT`.
- `acn_remove_web` (:1056) — `${VAR:?}` guards; must not remove a shared snippet another
  network's vhost still includes.

#### R5 — Gateway install: unit, snippets, vhost surgery, state durability

**Files:** `scripts/lib/052_lib_gateway.sh` (1132).

**Hunt for:**
- `_acg_write_unit` (:370): the S8/A-7 hardening still present and coherent —
  `ReadWritePaths` limited to `gateway-state/`, memory ceiling, egress restriction that
  still permits Tor's SOCKS port and the local wallet. A unit that can't reach Tor fails
  closed but silently.
- **`gateway-state/` durability.** Nothing in install, upgrade, restart or uninstall may
  delete or recreate it without an explicit prompt naming the consequence. Check
  `acg_uninstall_gateway` (:1127) hardest.
- `_acg_awk_insert`/`_acg_vhost_insert_include` (:800/:822): idempotence (run twice, one
  include), correct block targeted, and behaviour when the vhost was hand-edited. This is
  the riskiest text surgery in the product.
- `_acg_ensure_zones` (:550): **adding a zone to an existing conf file no-ops and can stop
  nginx starting at all** — confirm the guard, and that both the clearnet and onion
  snippets get what they need.
- `_acg_write_snippet` (:603) vs `_acg_write_snippet_onion` path (:73): two snippets, only
  one with `limit_req`; both including the headers snippet.
- `_acg_ensure_node`/`_acg_ensure_tor`/`_acg_ensure_user` (:84/:118/:146): version floor
  checked, service user unprivileged and non-login, no `chmod 777`, secrets not created
  world-readable.
- `acg_selftest` (:887) — does a pass actually prove the rails work, or only that the
  process is up? List what a green selftest does **not** cover, for S2.
- `acg_status` (:1023) must not report healthy from a stale PID or an empty state dir.

#### R6 — Gateway core: server, config, guard, store

**Files:** `gateway/server.js` (373), `config.js` (260), `guard.js` (223), `store.js` (452).
Read: `gateway/README.md`. Audit context: A-1, A-2, A-3, A-5, A-10 in
`script052_security_audit.md`.

**Hunt for:**
- `guard.js` — the SSRF rule set after the A-5 IPv6 fix: IPv4-mapped IPv6, `0x`/octal/
  decimal-integer IPv4, `[::]`, link-local, CGNAT, DNS names that resolve private, and the
  `allow_null_origin` bypass (A-9, accepted — confirm it is still *only* what was accepted).
- `store.js` — the suffix↔session table: the bound from A-2, eviction policy (a cap must
  **refuse, not evict** — evicting disconnects a live tab mid-payment), the snapshot
  writer's cost and atomicity (write-temp-then-rename; a truncated snapshot on power loss
  changes every receiving address), and **A-10**: nothing bounds repeated inbound requests
  to a known address.
- The open gap the S9 re-review surfaced: **a live tab's unverified address can be reclaimed
  from under it.** Confirm whether it is still live and write it up properly.
- `config.js` — defaults are the safe ones; a malformed/absent config fails closed; no
  secret logged; numeric fields validated (a string port, a negative cap).
- `server.js` — one `error` listener per socket path (`emit('error')` with no listener is a
  **remote kill switch**), no unhandled rejection path, shutdown drains rather than drops,
  and request limits applied **before** parsing/buffering (A-3's class of bug).
- Session lifetime vs socket lifetime — a session can expire under a LIVE socket.

#### R7 — Gateway money rails: listen, wallet, tor, socks5, ws

**Files:** `gateway/listen_route.js` (774), `wallet_route.js` (173), `tor_route.js` (276),
`socks5.js` (236), `ws.js` (453). Spec contract: `script052_design.md` §"Listen protocol"
**only** — do not open the 1901-line vendored `listener.js` (that is the compaction S4a exists
to prevent).

**Hunt for:**
- **Address binding (A-1's blast radius).** Inbound is routed by *address*, never by session
  cookie. Re-trace it end-to-end: suffix → owner → socket. Any place the cookie still
  selects a destination is a repeat of the highest-severity finding in the product.
- **The ack is a money-relevant commit point** — what happens on ack loss, double ack,
  ack-after-close, and out-of-order ack. Reconcile against the design's protocol section.
- `Status` is **a number one way and the string `"Succeeded"` the other** — every comparison
  must handle both, in both directions.
- **Suffix minting:** lowercase-only (an uppercase char silently 404s every inbound
  payment), collision handling, and no timing/format oracle beyond the accepted A-14.
- `ws.js` — the `'end'` handler (without it a closed tab holds its slot 45s), the rate
  limiter's position (**rate-limit after the parse or there is no `Index` left to answer
  with**), over-rate behaviour audible not silent (A-6), and never parsing an upgrade's
  `head` in the constructor (no listener exists yet).
- `socks5.js` — handshake state machine on partial reads, error replies mapped, no
  unbounded buffer, timeouts on every stage.
- `tor_route.js` — guard applied before connect **and** on redirect, method/size limits,
  no header or body echoed back that could leak the gateway's own network position.
- Backpressure everywhere: a slow onion must not grow an unbounded buffer.

#### R8 — Overlay, the MQS reduction, and doc truth

**Files:** `web/052_accio/patches/**` (17 files) — **diff-driven, not file-driven**: work from
`grep -rn 'ACCIO PATCH' patches/`, not from reading 13k lines. Plus
`script052_security_audit.md` §"Open / accepted" and this file's Current state table.

**Hunt for:**
- Every `ACCIO PATCH` marker: does the patch do what its marker claims, and does it leave
  the surrounding upstream logic intact? Pay closest attention to `scripts/node.js` (3176)
  and `index.html` (2981).
- **The two phrase maps** (`backend/language.php`, `scripts/language.js`) must stay
  **identical** across all six languages — check programmatically, not by eye.
- `MWC_WALLET_TYPE` untouched anywhere in the overlay.
- **`mqs.js` (87 lines) — the S9 pass-1 reduction.** Confirm the 5 kept symbols are exactly
  what's still referenced, that `Slate.compactProofAddress`'s un-gated read of
  `Mqs.ADDRESS_LENGTH` on the slatepack **encode** path still resolves, and that **nothing
  changed about how a slate is READ**. Then re-run the offline assertions and report the
  **real** pass/fail count — the "96 passed" figure was once quoted stale, and the one
  failure was a wrong test asserting a branch it did not construct.
- `index.html` — CSP, SRI attributes matching R3's regenerated sums, no external host left.
- **A-11 and A-12 are this packet's to design**: `patches/` sits outside the pin, and the
  deployed site is never re-verified against the build manifest. Propose the mechanism for
  each (a patches manifest; a post-deploy verify), even if implementing it is a later packet.
- **Doc truth:** every claim in `## Current state` and in the audit's Status/Verdict checked
  against the code as it now stands. File counts, byte counts, module counts, assertion
  counts, "every key is live". A stale number in the handoff doc is a real defect here.

---

## Session log

### S0 — Vendor & pin — 2026-08-09 ✅

**Outcome: `052` exists, and Accio is permanently independent.** MIT is irrevocable for the
copy we received, so that is now a licensing fact rather than something later engineering
earns. Everything after this removes *operational* dependencies only.

**Files created**

| Path | What it is |
|---|---|
| `web/052_accio/vendor/upstream-wallet/` | the pinned upstream tree, 270 files, unrenamed and unmodified |
| `web/052_accio/vendor/SHA256SUMS` | per-file pin, `sha256sum -c` clean at vendor time |
| `web/052_accio/PINNED_SHA` | shell-sourceable pin record + the exact reproduction command |
| `web/052_accio/PROVENANCE.md` | what `vendor/` is, disposition table, measurements, naming policy |
| `web/052_accio/.gitattributes` | `vendor/** -text` — stops this repo renormalising the pinned bytes |
| `web/052_accio/docs/upstream-nginx.conf.reference` | upstream's `nginx.conf`, kept as the spec S3/S4b replace |
| `web/052_accio/gateway/README.md` | the four jobs our Node service must carry (empty until S3) |
| `web/052_accio/patches/README.md` | overlay rules (empty until S5) |
| `scripts/052_grin_accio.sh` | menu skeleton, every action a stub — **this is what assigned the number** |
| `docs/generated/script052_design.md` | PART A moved out of `script05_design.md` |
| `docs/generated/script052_implementation.md` | this file |

**The pin**

```
UPSTREAM      github.com/NicolasFlamel1/mwcwallet.com
SHA           adef11daadf04e4ec259d6febcc720da3daaa6c7   ("Removed AscendEX compatibility
              from README", 2026-07-30)
VERSION       2.8.2, released 16 Jun 2026 16:02:00 UTC
LICENSE       MIT, sha256 bbc8b96cd3c66cd7d69ec75aaeae3b0d5d81d955771fadf7bc0cdc953728e32f
VENDORED      270 files / 7,443,197 bytes  (upstream ships 273)
MANIFEST      vendor/SHA256SUMS, sha256 fb43f4ef82669c8c1db42985e1285067d47f5836d8196764ca03afa8e94644f0
```

**Removed from the tree:** `fullchain.pem` + `privkey.pem` deleted (upstream's own dev cert
and **private key** — never redistribute someone else's key material), `nginx.conf` moved to
`web/052_accio/docs/upstream-nginx.conf.reference` so it can never be mistaken for config we
deploy. Nothing else was touched, including upstream's own `.gitignore`.

**Design measurements re-verified against the real tree** — all confirmed: 105 JS files, 11
PHP files, and `scripts/node.js` lines **512** / **535** do carry `https://api.grin.money` and
`https://testapi.grin.money`, i.e. this toolkit's own Script 04 endpoints ship in upstream's
stock default node list.

#### Three things the plan did not anticipate

1. **⚠ `git archive` honours `core.autocrlf`.** The first vendoring was done from a normal
   `git clone` on Windows, where `core.autocrlf=true` rewrote every text file to CRLF on
   checkout; switching to `git archive` did **not** fix it, because archive applies the same
   setting. `LICENSE` hashed `eb2c5d88…` instead of upstream's `bbc8b96c…` — a "vendored,
   pinned, byte-exact" tree that was none of those things, and the kind of error that only
   shows up years later as an unreadable upstream diff. The pin is only correct because the
   raw blob (`git cat-file blob HEAD:LICENSE`) was compared against the file on disk.
   **Always re-vendor with `git -c core.autocrlf=false -c core.eol=lf archive`**, and verify
   with `diff -r` against a fresh extraction, not by spot-checking one file.
2. **This repo would have re-broken it on the next clone.** The root `.gitattributes` sets
   `* text=auto eol=lf`, which is right for our own scripts and wrong for a checksummed
   vendor tree. `web/052_accio/.gitattributes` now sets `vendor/** -text` (verified with
   `git check-attr text`), so the pinned bytes survive commit → clone → checkout unchanged.
3. **The tree is 7.10 MiB, not the 4.7 MB in the design.** That figure was GitHub's *packed*
   repository size. Nothing is missing — `diff -r` against a fresh archive of `adef11da` is
   empty. Also, upstream ships a **fifth** WASM blob the design did not list: `SMAZ-0.0.31`
   (short-string compression, not cryptography).

#### Two files added beyond the S0 plan

- `vendor/SHA256SUMS` — S6 is specified as verifying the tree "against a committed checksum",
  and vendor time is the only honest moment to certify what we actually received. S6 now
  consumes this file rather than minting one from a tree nobody re-checked.
- `web/052_accio/.gitattributes` — forced by finding #2 above.

#### Notes for later packets

- **S1** — the 11 PHP files are `backend/{additional_text,common,language,resources}.php`,
  `errors/template.php`, and six `languages/*.php`. `public_html/.user.ini` is a php-fpm
  *runtime* config (it even hardcodes upstream's `session.save_path=/srv/mwcwallet.com/sessions`)
  — it must **not** be deployed, since PHP is build-time only.
- **S3/S4b** — `web/052_accio/docs/upstream-nginx.conf.reference` (58,454 bytes) is the
  behavioural spec for the `/tor/` regex, the request/response header allowlists and
  upstream's gateway on `:9000`. Read it; never deploy it.
- **Ports chosen** (checked free against the whole repo — 7420 Fidelius, 7456/7466/7556/7566
  Transporter, 7516/7517/7572 in use): gateway **7480** mainnet / **7490** testnet, onion
  front **7580** / **7590**. The onion deliberately gets its own local port — nginx and Tor
  both arrive on `127.0.0.1`, and a Tor client that can forge `X-Forwarded-For` would mint a
  fresh identity per request and void every per-client limit. This is 093's lesson, applied
  before the service exists rather than after.
- **Hub 05 is untouched.** Key `2` still dispatches `_slot_notice`; wiring it to
  `run_sub "052_grin_accio.sh"` is S7, and doing it earlier would advertise a menu of stubs.

**Verify — all green**

- `bash -n scripts/052_grin_accio.sh` → OK
- `vendor/upstream-wallet/LICENSE` byte-identical to upstream (`bbc8b96c…`)
- `diff -r` vendored tree vs fresh `git archive` of `adef11da` → empty, 270 files
- `sha256sum -c vendor/SHA256SUMS --quiet` → clean
- no `.git`, no `*.pem`, no `*.key` anywhere under `web/052_accio/`
- `git check-attr text` → `unset` for `vendor/**` and the nginx reference

---

### S0 review — 2026-08-09 ✅

A read-back of everything S0 produced, checking logic, flow, syntax and every factual claim
against the tree rather than against the design doc. Six defects, all fixed.

**Clean:** `bash -n` passes; every `case` arm is `||`-guarded per CLAUDE.md;
`acc_set_network X && network_menu || true` parses as `(a && b) || true`, so a bad network
skips the menu and the loop survives; `set -u` is safe because all `ACC_*` initialise to `""`;
the `PINNED_SHA` greps were run in isolation and `^UPSTREAM_SHA=` does **not** also match
`UPSTREAM_SHA8=`. Integrity re-verified live. Hub 05 dispatch confirmed untouched.

**1 — A doc move that leaves dangling referrers is an unfinished move.** S0 moved PART A and
left a pointer in `script05_design.md`, but five other files still pointed at it, two of them
load-bearing: `.claude/CLAUDE.md` (read by *every* future session, still saying 052 was
RESERVED) and hub 05's live `_slot_notice`, which told an operator Accio was "NOT BUILT YET"
and "being refactored from MWC-Wallet-Standalone" — a claim the 2026-08-08 research had
already overturned. Also fixed: `README.md`, `script05_implementation.md` (open-question row
2, now resolved), `script051_security_audit.md`. Hub 05's readiness marker for Accio went
`⏳ planned` → `🔧 building`; the **dispatch** was deliberately left alone, since wiring a menu
of stubs is exactly what S7 exists to avoid.

**2 — There are FOUR nginx modules, not three.** Found by reading upstream's conf instead of
its README, which omits `headers-more` — 29 calls carrying CSP, HSTS, COOP/COEP,
Permissions-Policy, Onion-Location, Set-Cookie and the `Link` preload. Stock `add_header …
always` replaces it, so "no modules" survives, but S2 inherits a trap that fails **silently**:
`add_header` in a child block discards every header inherited from its parent. Checked whether
cross-origin isolation is load-bearing — it is not (`common.js:16` guards `SharedArrayBuffer`
behind `crossOriginIsolated`, `:1994` defines a `false` fallback), but CSP/HSTS are.
Recorded in §"Liability 1" with the two lesser differences (`always`, and that
`more_clear_headers Server` has no stock equivalent).

**3 — The build script two packets reimplement was not vendored.** `build.sh` lives in
`MWC-Wallet-Standalone`, a *different* repo, unpinned — yet S1 inherits its env contract and
S7 reimplements its inlining phase. S0's own durability argument, unapplied. Now vendored at
`043c2ddc` in `vendor/upstream-standalone-build/` (4 files, 75 KB, MIT); `vendor/SHA256SUMS`
covers both trees. **We never run it** — it `wget`s an unpinned `master.zip`, `chmod 777 -R`s
the tree and `rm -rf`s its own working files.

**4 — The CRLF trap reoccurred, on the same day.** A default clone of the standalone repo
produced `LICENSE` = `eb2c5d88…` for text byte-identical to the wallet's `bbc8b96c…`. Treat it
as certain, not likely. The `-c core.autocrlf=false -c core.eol=lf archive` form was used and
verified (`grep -rlU $'\r'` → nothing).

**5 — Numbers corrected by measurement.** `build.sh` is 316 lines; the inlining phase (39–311)
is 273 lines of which **253** are `sed -i`. The design's "270" was wrong, and both figures
collided confusingly with the 270/273 file counts. Verified `wc -l` and `grep -c`.

**6 — Minor.** `gateway/README.md` pointed at `docs/…` from inside `gateway/` (now `../docs/…`),
and neither it nor the design named the rate-limit zones — upstream declares bare `tor`,
`listen`, `wallet`, `donate`, which are global to nginx across every product on the box. Ours
must be `accio_*` via `nginx_ensure_rate_limit_zone`, never an inline `limit_req_zone`.

**Worth knowing about commit `8cac9de`:** `script05_design.md` was dirty before S0 — its
committed version was 124 lines, so the entire 684-line research rewrite was *uncommitted*.
S0 moved lines 22–684 into `script052_design.md` and committed it. Nothing was lost, but that
in-progress work now lives in git under a different filename.

**Verify — all green**

- `bash -n` on `scripts/052_grin_accio.sh` and `scripts/05_grin_wallet_service.sh`
- `sha256sum -c vendor/SHA256SUMS` → clean, 274/274
- both `LICENSE` files hash `bbc8b96c…`; no CR bytes anywhere in either vendored tree
- `git check-attr text` → `unset` across `vendor/**`, including the new tree

---

### S1 — Own the build — 2026-08-09 ✅

**Outcome: `scripts/lib/052_lib_build.sh`, and 052's key `2` "Rebuild site" is LIVE.** The
build is the first thing Accio actually *does*. Its defining property is that it makes **no
network request**: it reads `vendor/` and `patches/` and nothing else, which is what makes the
S0 pin mean anything. `_acb_assert_offline` re-checks that at runtime, so a future edit that
adds a downloader fails the build instead of quietly weakening the pin.

**Public entries** — `accio_build [net] [domain] [outdir]`, `acb_check_deps`, `acb_env_report`.

#### The env contract (S2 must not re-derive this)

| Var | Hosted build | Standalone (S7) | Why |
|---|---|---|---|
| `SERVER_NAME` | the domain | the domain | canonical URL, hreflang, manifest, sitemap, robots |
| `HTTPS` | `on` once a cert exists, else **absent** | `on` | tested with `array_key_exists` **and** `=== "on"` |
| `HTTPS_SERVER_ADDRESS` | set with `HTTPS` | set | **absent → the JS falls back to `location.hostname`, which is what a hosted site wants**. Presence also flips the HTTP/HTTPS label in the address-type selector |
| `TOR_SERVER_ADDRESS` | **absent until S7 mints the onion** | the onion | absent → the "Onion Service" address type hands out a *clearnet* host. Set it as soon as the onion exists |
| `NO_FILE_VERSIONS` | **must be ABSENT** | `""` | see #1 |
| `NO_FILE_CHECKSUMS` | **must be ABSENT** | `""` | see #1 |
| `NO_MINIFIED_FILES` | **must be ABSENT** | `""` | see #1 |
| `REQUEST_URI` | `"/"` | `"/"` | keeps `errors/503.html` on its maintenance branch instead of `require`-ing 404.html |
| `SERVER_PROTOCOL` | `HTTP/1.1` | same | only avoids an undefined-index notice in the error pages |
| `HTTP_ACCEPT_LANGUAGE` | `en-US,en;q=0.9` | same | one render is the whole site — see #2 |
| `HTTP_USER_AGENT` | **absent** | absent | only drives a Googlebot test and the manifest's mobile-icon split; the default is right |

#### Five things the plan did not anticipate

1. **The three `NO_*` vars are tested for PRESENCE, not value.**
   `backend/resources.php:1760/1771/1782` all use `array_key_exists()`. So
   `NO_FILE_VERSIONS=""` — which is exactly what upstream's `build.sh` writes — **disables**
   file versions. That is correct for the standalone artefact and wrong for a hosted site.
   The trap is that an operator with one of these exported in a shell profile would silently
   strip cache-busting **and Subresource Integrity** from the entire site, with no error and
   no visible symptom. Every render therefore runs under `env -u` for all three.

2. **We must render 27 files. `build.sh` renders 14.**
   `build.sh` only needs what folds into a single self-contained `index.html`. A *hosted*
   site also needs `site.webmanifest`, `sitemap.xml`, `robots.txt`, `browserconfig.xml`,
   `scripts/service_worker.js` and the eight `errors/*.html` — every one of them PHP-templated
   too. Transcribing build.sh's list would have published those as **raw PHP source**: the
   manifest breaks PWA install and `service_worker.js` breaks offline caching, neither with
   an error anyone would trace back to the build.
   So the build **discovers** templated files instead of listing them. Detection is the
   leading five bytes `<?php` — verified exact across all 266 files, with **zero** false
   positives among the binaries. Content-grep is *not* safe here: `<?=` is three bytes, and
   over 7 MB of WASM a random occurrence is likely, not rare.
   Also corrected: the design's "11 PHP files" are the `.php` *libraries*
   (`backend/` x4, `languages/` x6, `errors/template.php`) and they are **never served**.
   The build excludes them, along with `public_html/.user.ini` (php-fpm runtime config that
   even hardcodes upstream's own `session.save_path`). 266 files in → 12 excluded, 27
   rendered, 227 copied verbatim, 254 published.

3. **221 of 252 resource entries carry a HARDCODED SRI checksum — and `scripts/node.js`
   is one of them.** They are plain `base64(sha512(bytes))` of the pristine file. All 221
   were recomputed and verified against the vendored tree (a second, cryptographic proof
   that the S0 pin is byte-exact, independent of the `diff -r`).
   `scripts/node.js` (Version 41, SRI present) is **precisely the file S5 must patch** to
   make our Grin nodes the default. Patch it without refreshing the checksum and the browser
   refuses to execute it on integrity grounds — the wallet never boots, and the console error
   points at SRI, not at us. So `_acb_apply_patches` now recomputes the checksum **and bumps
   the cache version** for every patched file. **S5 only has to drop a file in `patches/`.**
   - Order matters: patches are overlaid on a **staging copy**, and PHP renders *from* it.
     That is also why patching `backend/resources.php` works, and why `service_worker.js`
     (which embeds the whole `$files` table as JSON) automatically picks up the new sums.
   - Upstream's own invariant, worth keeping: **every PHP-rendered file has
     `Checksum => NULL`.** You cannot SRI bytes that vary per deployment. If a patch ever
     makes a currently-static file templated, its checksum must go NULL too.
   - The rewriter hard-fails if a path *is* listed in `$files` but its `"Version"` /
     `"Checksum"` lines no longer match — i.e. an upstream bump reformatted the table. A
     silently stale SRI is a page that will not load; failing the build is strictly better.
     **The guard is on the FIELDS, not on the block's braces** (see the review note below):
     finding the entry proves nothing, because a rewriter that finds a block and matches
     none of its lines copies them through untouched and still reports success.
   - `$files` is not the only table in `resources.php` — `ATTRIBUTIONS` follows it with 22
     name-keyed entries carrying `URL`/`License Path`/`License Type` and **no** Version or
     Checksum. Exit code map: `0` rewritten, `3` no such entry, `4` found but drifted.

4. **PHP CLI prints warnings to STDOUT.** Rendering redirects stdout into the built file, so
   a single undefined-index notice would be injected straight into `index.html` or the
   manifest. Every render forces `display_errors=stderr`, treats a non-zero rc or an empty
   output as fatal, and surfaces any stderr instead of swallowing it.

5. **Build deps are `php-cli php-mbstring php-intl`** — `intl` is not optional
   (`locale_accept_from_http`, `NumberFormatter`) and is easy to miss. Separately,
   `backend/language.php:604` calls `setlocale(LC_ALL, "en_US.UTF-8")`, which **fails
   silently** on a minimal Debian where that locale was never generated, changing the
   `strcoll()` order of the language menu. Harmless to the wallet, but it stops two boxes
   producing identical bytes, so `acb_check_deps` warns and prints
   `apt-get install -y locales && locale-gen en_US.UTF-8`.

#### Known, accepted degradations of prerendering

- `site.webmanifest` picks desktop-vs-mobile app icons from the User-Agent. Prerendered,
  everyone gets the desktop set — same sizes, same files, cosmetic only. If it ever matters,
  S5 drops the `Mobile Only` split.
- `errors/503.html` / `errors/error.html` branch on `Referer` + `REQUEST_URI` to hide the URL
  and to 404 a direct hit. With `REQUEST_URI="/"` they render as the plain maintenance/error
  page, which is the right fallback. **Whether nginx points `error_page` at them at all is
  S2's decision** — nginx's own pages are a valid alternative.
- Language is negotiated per request upstream; here one `en-US` render is the whole site,
  because `scripts/languages.js` embeds every translation as JSON and switching is
  client-side. That is a *correction* to the design, not a degradation.

#### Bugs found and fixed while building

- `_acb_set_resource_entry` wrapped its `awk` in `set +e` … `set -e`, which **unconditionally
  enables errexit for the caller** regardless of its prior state. Replaced everywhere with
  `cmd || rc=$?`, which captures the status without touching shell options.
- `_acb_is_templated` read the magic bytes through a command substitution, so bash printed
  *"ignored null byte in input"* for every binary-headed file — **24 warnings per build**, all
  noise, and exactly the kind of output that makes an operator distrust a good build. Now
  pipes through `tr -d '\0'` first, which cannot create a false positive: a NUL inside the
  first five bytes leaves fewer than five, which never equals the magic.

#### Review pass, same session — three more, and one wrong assumption

Re-reading the finished lib against the real `resources.php` rather than against the tests:

- **The `$files` table is not the only table, and the awk's block-close was wrong.** The last
  entry of a PHP array closes `\t\t]` with **no comma**; only the other 271 close `\t\t],`.
  `$files` ends at `"./images/usb license.txt"` (line 1634) and is followed by `\t];` and then
  `const ATTRIBUTIONS = [`. Matching only `\t\t],` walked straight past that boundary into
  `ATTRIBUTIONS`, where an unrelated brace set `found`. It happened to produce the right bytes
  **only** because `ATTRIBUTIONS` carries no `Version`/`Checksum` lines to clobber — so the
  original test passed for the wrong reason. Now matches `^\t\t\]`.
- **The drift guard guarded the wrong thing.** It keyed on the block's braces, but finding a
  block proves nothing: if the `"Version"`/`"Checksum"` **lines** stopped matching, the awk
  copied them through untouched, exited 0, and the build logged *"SRI refreshed"* while
  shipping a stale checksum — the precise silent failure the guard exists to prevent. The
  assertion is now on the fields (`sawver`/`sawsum` per block → exit 4).
- **`acb_env_report` printed the onion twice.** `${onion:+http://$onion}${onion:-…}` expands
  **both** halves when the var is set, giving `http://abc.onionabc.onion`. Cosmetic, but it is
  the one line an operator reads to confirm the onion is right. Spelled out with `if`.
- Also fixed: `_acb_render_one`'s diagnostics stripped `*/public_html/` from the path, but
  `src` lives under `<outdir>.stage`, which has no such component — every PHP error would have
  named a full absolute path. The relative path is now passed in as `$6`.
- Added, preventively: a patch on a **templated** file no longer gets an SRI. Upstream's
  invariant is `Checksum => NULL` for those, and hashing at overlay time would hash the
  *template*, not the bytes the browser fetches.

Assumption checked and **cleared**: upstream's `build.sh` invokes
`php "./mwcwallet.com-master/public_html/index.html"` from the repo root, i.e. **not** from
inside `public_html`. So the templates cannot be cwd-dependent, and our running `php` from an
arbitrary cwd is equivalent to upstream's own build. Also verified: the vendored tree has no
symlinks and no empty directories, so `find -type f` covers it.

#### Build shape

```
vendor/upstream-wallet/public_html   immutable, never written
     | cp -a
<outdir>.stage    <- patches/public_html/ overlaid whole-file, SRI refreshed
     | php, once per templated file
<outdir>.new  ->  assert  ->  manifest  ->  atomic swap  ->  <outdir>
```

The swap is **last**, so a failed build leaves the live tree untouched — this runs on a box
with other vhosts, live certs and a running gateway. Rollback: `<outdir>.prev`. Artefacts sit
*outside* the served root: `<outdir>.SHA256SUMS` (+ `.prev`) and `<outdir>.BUILD_INFO`.
The build reports "byte-identical to the previous build" itself, so S2 step 1 is one action.

Post-conditions before publishing: `index.html` non-empty; **no** file in the output still
starts with `<?php`; **no** `*.php`, `backend/`, `languages/` or `.user.ini` reached it.

#### Bootstrap note (why key `2` can run before S2 exists)

`SERVER_NAME` is baked into the output, so a build needs the domain. "Rebuild site" asks for
it **once** when `$ACC_CONF` has none, writes `ACCIO_DOMAIN` / `NETWORK` / `NODE_URL` /
`GATEWAY_PORT` / `TOR_PORT` / `HTTPS` / `ONION`, and never asks again. S2's installer writes
the same keys. `_acc_conf_set` and `_acc_load_lib` were added to `052_grin_accio.sh`.

**Verify — all green (nothing was run on a VPS)**

- `bash -n` on `scripts/lib/052_lib_build.sh` and `scripts/052_grin_accio.sh`
- a plain `grep -n` for the two common downloaders over the lib → **nothing**. The runtime
  assert splits its own pattern across string concatenations so it does not match itself
- **27 unit assertions on the SRI/version rewriter** against the real `backend/resources.php`:
  checksum replaced + version bumped on `scripts/node.js` (exactly 4 lines changed, no other
  entry touched); `Checksum => NULL` left NULL; `Version => 0` left 0; an unlisted path
  (`index.html`) returns 3 and leaves the file **byte-identical**; a path containing a space
  (`scripts/X25519 license.txt`) resolves; the **last** `$files` entry resolves without
  touching `ATTRIBUTIONS`; a renamed `Checksum` field and a quoted `Version` each return 4
  with the input untouched and no sum leaked in; an `ATTRIBUTIONS` key returns 4; a
  reformatted closing brace is correctly **not** treated as drift; all 252 entries intact
- **8 further assertions** on the last-entry path specifically (`t_lastentry.sh`)
- **20 assertions on the classifier + post-conditions** against the real vendored tree:
  266 total / 12 excluded / 27 rendered / 227 copied; all of the files `build.sh` skips are in
  the render set; raw PHP, a leaked `backend/`, and a missing `index.html` are each rejected;
  a clean tree is accepted; the offline assert passes the shipped lib and **fires** on a
  deliberately tampered copy

**Still owed to S1, by S2:** the real acceptance run — `apt-get install -y php-cli
php-mbstring php-intl`, then "Rebuild site" **twice**, then
`diff /opt/grin/accio-test/site.SHA256SUMS.prev /opt/grin/accio-test/site.SHA256SUMS`.

---

### S3 — Gateway I: the `/tor/` forwarder — 2026-08-09 ✅ *(code; VPS run still owed)*

**Outcome: `web/052_accio/gateway/` and `scripts/lib/052_lib_gateway.sh`, and 052's key `3`
"Gateway service" is LIVE.** This is the first thing Accio does that a static site cannot: a
browser tab cannot open a TCP connection to a hidden service, so sending a slate to a payee's
`.onion` needs a forwarder. Three of upstream's four nginx C modules collapse into it, which
is what lets the whole product run behind **stock nginx from apt** — a module `.so` built
against the exact installed nginx makes `load_module` fail after an `apt upgrade nginx`, and
nginx then refuses to start *at all*, taking every other vhost on the box with it.

**Public entries** — `acg_gateway_menu`, `acg_install_gateway`, `acg_nginx_glue`,
`acg_selftest`, `acg_service_ctl`, `acg_status`, `acg_logs`, `acg_uninstall_gateway`.

**Taken out of order** — S3 is specified after S2. Its *verification* does depend on S2; its
authorship does not, and writing it against a fake SOCKS proxy found three bugs that a live
smoke test would only have shown as "the send hangs". See §"Current state".

#### The five modules, and why the guard is its own file

```
server.js      two listeners, routing, counters, /health, shutdown
config.js      gateway.json loader — every default is the SAFE value
guard.js       the whole of "no": parsing + destination/path/method/Origin/Content-Type
socks5.js      RFC 1928 + 1929 CONNECT client, zero dependencies
tor_route.js   the forward + both header allowlists
```

`guard.js` is pure — no sockets, no I/O, inputs in and a verdict out. That is deliberate: it
replaces `Block-Access`, which was a battle-tested C filter, and ours is not. Being pure is
what makes it exhaustively testable, and S8 audits that one file.

#### Six corrections to the plan

1. **The port is 7480/7490, not `:9000`.** The design's S3 text says "listening 127.0.0.1:9000
   (upstream uses ip6-localhost:9000)". Two things wrong with inheriting that: S0 had already
   chosen 7480/7490 after checking the whole repo for collisions, and `:9000` is upstream's
   **WebSocket-Listener** port — its SOCKS proxy is `:9050`. Copying `9000` would have put our
   Tor forwarder on the port S4b's rail is described against.

2. **SOCKS5 is hand-written, not `socks-proxy-agent`.** ~90 lines against one command
   (CONNECT), one address type (domain name) and one optional auth method. The package is
   fine; the objection is specific — this process is the only part of Accio that handles bytes
   chosen by an arbitrary hidden service, so its transitive tree (agent-base, socks,
   smart-buffer, ip-address, debug) becomes supply chain on a *wallet* front end, and
   reintroducing an unpinned npm fetch at install time hands back exactly what S0 spent a
   packet buying. **The gateway has no npm dependencies and its install makes no network
   request.** If S4b genuinely needs `ws`, that is a decision to take then, on its own merits.
   - Side benefit that turned out to matter: passing the hostname to Tor (ATYP `0x03`) means
     this process **never resolves a name**, so there is no window between "the guard checked
     the host" and "the socket connected" — DNS rebinding has nothing to rebind.
   - The SOCKS username is used as Tor's circuit-isolation selector (`IsolateSOCKSAuth` is on
     by default), set to the destination host: two payees never share a circuit, while a retry
     to the same payee reuses one instead of paying a fresh build.

3. **The `/tor/` regex must accept ONE *or two* slashes after the scheme.** nginx runs
   `merge_slashes on` by default, so `/tor/http://abc.onion/v2/foreign` has already become
   `/tor/http:/abc.onion/v2/foreign` by the time a proxied backend sees it. Upstream's own
   regex is `^/tor/(https?)://?(.+/.*)$` for exactly this reason. A `//`-only gateway passes
   every direct-to-loopback test and fails for every real browser — it would have looked like
   a working service that nobody could send from.

4. **`Cache-Control` is emitted by the gateway, and the nginx snippet has NO `add_header` at
   all.** Upstream sets it with `add_header` in the `/tor/` location. Stock nginx cannot do
   that safely here: an `add_header` anywhere in a location block discards **every**
   `add_header` inherited from the server block, so one line in this location would silently
   strip CSP and HSTS from precisely the route that talks to untrusted hidden services. The
   snippet carries that as a rule in its own header comment, in capitals, because the failure
   is invisible.

5. **Two `require_header` semantics had to come from the Block-Access source, not its README.**
   A leading `!` on the header name means the header is **OPTIONAL** (absent passes, present
   must match), and repeated directives for the *same* header are **OR-ed**. Both are recorded
   at the top of `guard.js`. Getting either backwards inverts the rule: AND-ing upstream's
   three `Origin` alternatives would refuse every request ever made, and reading `!` as "must
   be absent" would refuse every browser request. Note what this makes `Origin`: not an
   authorisation control (it is optional, and same-origin requests may omit it) but a cheap
   filter against a third-party page using us as an open proxy. The real controls are the
   destination and path checks.

6. **The onion port is fed by a second nginx server block, not by tor directly.** S0's note
   says "classify by `socket.localPort`", which is right, but left the static site unexplained:
   the wallet is ~7 MB of WASM that nginx should serve over the onion exactly as it does over
   TLS. So tor → nginx (onion server block) → gateway `tor_port`, while nginx (clearnet) →
   gateway `port`. The trust boundary is intact and the site is still served by nginx.
   `tor_port: 0` keeps the second listener closed until S7 mints the onion.

#### Where we are stricter than upstream, on purpose

- **Onion shape.** Upstream checks only the TLD (`.onion`). We require a well-formed v3
  address — 56 base32 chars (`a-z2-7`), optional subdomains. `evil.onion` is not a reachable
  service but it *is* a name Tor would try to resolve, and the name is what the whole SSRF
  story rests on.
- **Read timeout 3 min, not 208 weeks.** Upstream's `socks_proxy_read_timeout 208w` is an
  unbounded resource hold any client can take out for free. A Foreign API call answers in
  milliseconds.
- **A hard `max_concurrent` (64) on in-flight forwards.** Without it, a few hundred requests
  to unreachable onions each hold a socket for the full connect timeout and the box runs out
  of descriptors — which takes down the products sharing it, not just Accio.
- **`X-Content-Type-Options: nosniff` on every response** — a hidden service picks its own
  Content-Type, and upstream's response allowlist has no way to add a header.
- **`Transfer-Encoding` is not copied back**, though upstream allows it: it is hop-by-hop and
  this process re-frames the body. `Content-Length` is dropped alongside it when the upstream
  answered chunked.
- **The onion front rate-limits itself** (one shared token bucket, 10 r/s burst 40). It has no
  nginx `limit_req` in front of it and no client identity to key on; inventing a key from a
  header would let the caller mint identities at will, which is the very thing the separate
  port exists to prevent. Deliberately one bucket — a weaker control, and an honest one.

#### Privacy properties worth not regressing

- The forwarded request header set is upstream's six exactly (`Accept-Encoding`,
  `Content-Type`, `Content-Length`, `Authorization`, `Access-Control-Request-Headers`,
  `Access-Control-Request-Method`) plus a `Host` built from the *destination* and
  `Connection: close`. `Cookie`, `Referer`, `User-Agent`, `Accept-Language`, `Origin` and every
  `X-Forwarded-*` are absent by construction, so the payee's wallet learns nothing about the
  payer beyond the slate. Do not "just add one" to debug something.
- **`log_destinations` defaults to OFF and must stay off.** A `/tor/` destination is the
  payee's wallet address; a journal of those is the payment graph Grin exists in order not to
  have. The nginx snippet likewise passes no `X-Forwarded-For`, so the gateway never holds a
  visitor IP it could log.

#### Three bugs found by building, all in the handoff between Node's own APIs

1. **`agent: false` is not "no agent".** In Node it means *"construct a fresh default Agent"*,
   and `http.request` consults `createConnection` **only when there is no agent**. With
   `false`, the SOCKS tunnel was built, handed back, and then silently ignored while Node
   opened its own direct socket to the `.onion` — failing DNS and surfacing as a bare
   `ECONNREFUSED` with an **empty message**. `agent: null` is the correct value. Symptom-wise
   this is the whole Tor rail bypassed by one wrong falsy value.
2. **Never leave a socket in flowing mode before handing it on.** Reading the handshake with a
   `'data'` listener starts the flow; removing the listener does not stop it, and `pause()` to
   stop it sets `flowing = false` *permanently* as far as the next consumer is concerned —
   `Readable.on('data')` only auto-resumes when `flowing !== false`, so Node's HTTP client
   attached its parser to a socket that never delivered a byte and **every forward returned
   504**. The reader now uses `'readable'` + `socket.read(n)`, which keeps the socket paused
   throughout; leftover handshake bytes simply stay in its own buffer, so there is nothing to
   `unshift` and nothing to lose.
3. **Refusing a request mid-body is not "answer, then destroy".** Destroying the client socket
   right after writing the 413 raced the response out of the client's receive buffer and the
   client saw `ECONNRESET` instead of the status. The overflow path now drains the rest of the
   body (with a hard stop at another `max_body_bytes`) and lets the connection close normally;
   every error response carries `Connection: close`.

Also fixed while writing: `fail()` is idempotent (destroying the proxy request to enforce a
cap or timeout *also* raises `'error'` on it, so it reliably ran twice, and the second call
would have written to an ended response and killed the process); a timeout now answers **504**
rather than 502; `send_timeout_ms` was decorative until it was wired to `server.requestTimeout`.

#### The deploy side

- **Dedicated `grinaccio` system user, not `grin`.** This is the only Accio component exposed
  to bytes from an arbitrary hidden service, and `grin` owns node directories, wallet seeds and
  API secrets belonging to every other product on the box. The unit is hardened
  (`ProtectSystem=strict` with **no** `ReadWritePaths` — the gateway writes nothing at all;
  `CapabilityBoundingSet=`, `RestrictAddressFamilies`, `NoNewPrivileges`).
  `MemoryDenyWriteExecute` is deliberately **absent**: V8 JITs, and setting it makes node fail
  to start with an error that points nowhere useful.
- **One unit per network, `grin-accio-<short>`** — not the design's `grin-accio-gateway-<net>`.
  `052_grin_accio.sh` already defined `ACC_SERVICE` and its network badge that way before this
  packet, and S4b extends this same service rather than adding a second.
- **nginx glue is two artefacts plus an offer.** `nginx_ensure_rate_limit_zone accio_tor 10r/s`
  → `conf.d/script052-rate-limits.conf` (never an inline `limit_req_zone`), and the location
  block → `snippets/accio-<net>-gateway.conf`. The vhost `include` is inserted by awk that
  tracks brace depth (so it cannot land inside a nested `location{}`), targeting the `443`
  block and falling back to the first `server{}` for the pre-certbot HTTP-only file. It backs
  the vhost up first, runs `nginx -t`, and **restores on failure** — a broken nginx config does
  not just break Accio, it stops nginx starting and takes every vhost down. Uninstall removes
  the include too: a dangling `include` is the same failure.
- Deps are Node ≥18 (no `node:sqlite` needed here, unlike 059/093) and `tor` as a **client**;
  the install verifies `127.0.0.1:9050` is actually listening rather than trusting the unit
  state, because a tor with `SocksPort 0` looks healthy and forwards nothing.

**Verify — all green (nothing was run on a VPS)**

- `bash -n scripts/lib/052_lib_gateway.sh` and `scripts/052_grin_accio.sh`; `node --check` on
  all five modules
- **78 unit assertions** over the pure halves, against `guard.js` + `config.js` + both header
  allowlists: URL parsing in both slash forms, port/query handling, userinfo and IPv6-literal
  and non-printable rejection; onion label length and alphabet at 55/56/57 chars; loopback,
  `localhost`, metadata IP, CGNAT and private ranges (also with clearnet *enabled*); the path,
  method, Origin and Content-Type ladders including the optional-Origin and OR semantics; the
  request allowlist keeping six headers and dropping every identifying one; the response
  allowlist dropping a hostile onion's `Set-Cookie`, `Location`, CSP, HSTS and `Server`;
  chunked framing; and config validation refusing `port == tor_port`, a zero limit, a stringly
  typed timeout, a bad regex and a missing file
- **19 end-to-end assertions** driving the **real `server.js`** as a child process through a
  fake SOCKS5 proxy (which selects username/password auth, so the isolation-credential path is
  the one under test) into a fake onion: body integrity, destination path, `Host`, header
  stripping in both directions, the isolation credential, the merged-slash form, the OPTIONS
  preflight, the 413 body cap, SOCKS reply `0x04` → 502 with a readable reason, the loopback
  refusal end to end, a 404 for non-`/tor/`, and no in-flight leak across all of it
- the awk vhost-include insertion, checked against both an SSL vhost with nested `location{}`
  blocks and an HTTP-only one
- every local test process exited on its own; a `Win32_Process` sweep found no orphans

**Still owed to S3, by the first VPS session (S2):**

1. `3) Gateway service → 1) Install`, then `→ 3) Self-test` — the eight offline probes must
   all pass on the box.
2. `→ 2) nginx glue`, then confirm `nginx -t` and that `/tor/` reaches the gateway.
3. The real thing: from the browser wallet, **send tGRIN to a Fidelius onion address and have
   it arrive.** Then re-confirm that `curl` of `/tor/http://127.0.0.1:3413/v2/foreign` is
   refused.
4. Confirm the box is running stock nginx: no `load_module`, no `.so` referenced in any conf,
   no `php-fpm` process.

---

### S3 review — 2026-08-09 ✅

A read-back of everything S3 produced, against the real upstream conf and against Node's
actual semantics rather than against the tests that were written alongside the code. **Nine
defects, all fixed**; assertions went 78 → 88 (unit) and 19 → 22 (end-to-end).

**Clean on re-read:** `guard.js` is genuinely pure and its ladder is order-independent; the
overflow/idempotent-`fail()` interaction holds; `createConnection` returns `undefined` so
Node's `oncreate` is not double-fired; `https` over an already-TLS socket is the correct
shape for `agent: null` + `createConnection`; every `case` arm is `||`-guarded; the generated
snippet was rendered and read (the `\$` escapes come out right, `$uri` stays literal).

**1 — A refused request drained an UNCAPPED body.** `drain()` was a bare `req.resume()`.
nginx caps the clearnet front at `client_max_body_size`, but the onion front has no nginx at
all, so anyone could stream gigabytes into a route that had already said 403. Now capped at
`max_body_bytes` with a destroy beyond it — the same rule the forward path uses.

**2 — A client that disconnected mid-flight held its concurrency slot for the full timeout.**
`res.once('close')` was registered *inside* the `'response'` handler, so it did not exist
during the window that actually matters: waiting on the circuit. `req`'s `'aborted'` does not
cover it either — a request whose body already completed emits `'close'`, not `'aborted'`.
So the slot was released only when the read timeout fired, minutes after the client was gone,
and `max_concurrent` of those is a free denial of service. The handler is now registered at
the top of `forward()`. Proved by test: `in_flight` returns to 0 within 400 ms of the client
vanishing, against a 5 s timeout in the harness — without the fix it stays at 1.

**3 — `proxyReq.setTimeout()` is an IDLE timeout, and the comment claimed it bounded the
exchange.** A hidden service trickling one byte every two minutes resets it forever and holds
a slot indefinitely. Added a separate total deadline (cleared in `finish()`), and corrected
the comment. Upstream is worse here (208 weeks), but "we are better than 208w" is not the same
as bounded.

**4 — A missing `ACCIO_GATEWAY_CONF` silently started the gateway on DEFAULTS.** `config.js`
claimed in a comment that a missing config is fatal; it was only fatal when the path was set
and unreadable. A systemd unit that lost its `Environment=` line would therefore start the
**mainnet** gateway on the **testnet** port — running, `is-active`, and wrong. Now fatal, and
asserted end to end (`exit 1`).

**5 — An unbracketed IPv6 literal walked past all three destination checks.** `http://::1/…`
parses as host `":"` + port `1`; `":"` is not `.onion`, is not an IPv4 literal and is not
`localhost`, so with clearnet enabled it was *allowed*. Fixed at the parse layer instead of by
adding a fourth special case: every destination host must now match a DNS-name shape (which an
IPv4 literal and any `.onion` also satisfy), so the policy checks only ever see a shape they
can reason about. This also rejects spaces, empty labels, leading hyphens and underscores.

**6 — The reserved-range regex over-blocked.** `^19[89]\.1[89]\.` blocks `199.18.x`, which is
ordinary public space; the reserved range is `198.18/15`. Corrected to `^198\.1[89]\.`, with
an assertion that `199.18.0.1` is *allowed* — an over-block in a guard is a bug in the same
way an under-block is, it just fails at a different time.

**7 — `gzip off; gzip_vary off;` was missing from the nginx snippet.** Upstream sets both in
its `/tor/` location and I did not transcribe them. With a vhost that enables gzip and
`gzip_proxied any`, nginx would recompress the wallet's JSON-RPC responses — pointless on a
body this size, it stops the bytes being what the onion sent, and compressing a response that
mixes attacker-influenced and secret content is where compression side channels come from.

**8 — `_acg_find_vhost` could kill the script.** Its trailing `grep … | head -n1` exits 1 when
nothing matches, `pipefail` propagates that, and under the parent's `set -e` a *failing
pipeline inside an `if` body aborts the shell* (verified locally: the statement after it never
runs). It happened to be masked because every caller writes `vhost="$(_acg_find_vhost)"`, and
a library function must not depend on its caller's syntax to be safe. `|| true` added.
- Checked at the same time and **not** a problem: sourcing `nginx_shared_helpers.sh`, whose
  first line is `[[ -n "${_LOADED:-}" ]] && return 0`. That short-circuit does *not* trip
  errexit when the file is sourced — verified rather than assumed, since it looks like exactly
  the same trap.

**9 — Two smaller ones.** A non-`Denied` throw out of `guard.inspect` propagated out of the
request listener, which kills the process — one malformed request that found a bug would take
the gateway down for everyone and systemd would restart it into the next one; it now answers
500 and logs the stack. And `stats.tor_ok` counted client-aborted requests as successes,
because `res.statusCode` is 200 by default until something sets it; it now requires
`res.headersSent`.

**Left as-is, deliberately:** `client_max_body_size 10m` in the snippet is hardcoded rather
than read from `gateway.json` — nginx being stricter than the gateway fails safe, and the
gateway enforces its own copy regardless. The `/tor/` location is inserted at the *end* of the
server block, so an earlier regex location matching `/tor/…` would win; nothing in a static
wallet vhost does, and end-of-block is the only position that is generically safe.

**Note carried to S2, who writes the vhost:** keep `try_files` inside `location / { }`, not in
the `server` block. Server-level `try_files` is inherited by locations that do not define their
own and runs before the content phase, which would 404 every `/tor/` request. Upstream does put
it at server level and its site evidently works, so nginx may treat a proxied location
differently — this was not verifiable without nginx, so the snippet carries the warning and S2
should simply avoid the question.

**Verify — all green**

- `node --check` on all five modules; `bash -n` on the lib and the product script
- **88 unit assertions** (was 78) and **22 end-to-end assertions** (was 19), the new ones
  covering defects 1, 2, 4, 5 and 6 specifically
- the generated nginx snippet rendered and read end to end, confirming the heredoc escapes
- no local test process left running

**Second pass, same day — one more.** A re-read of all five modules and the whole lib against
the parent script's actual definitions, looking for anything the first review's nine had made
easier to see.

**10 — the total-exchange deadline was armed BEFORE the request object it destroys.** `const
proxyReq` sits below it, so the timer callback closed over a binding in its temporal dead zone.
Harmless while `transport.request()` returns normally; if it ever throws synchronously (an
unencodable header value is enough) the promise rejects, `server.js` answers 500 — and the
timer survives the throw, fires into an unassigned `proxyReq`, and raises a ReferenceError from
a timer callback, which is uncaught and kills the process. Arming it immediately *after* the
request is created removes both halves: no TDZ, and on the throw path no timer exists at all.

**Checked and clean this pass:** every `ACC_*` the lib reads (12 of them) is set by
`acc_set_network`; `_acc_conf_get`, `_acc_load_lib`, `pause`, `log` and the colours all exist in
the parent; the self-test's placeholder onion is **exactly 56 base32 chars** — worth confirming,
because a 55-char one would make `checkDestination` fire before `checkContentType` and turn the
415 probe into a 403 that still looked like a refusal; `StartLimitIntervalSec=0` under
`[Service]` matches what 059 and 093 already write (systemd parses it there for compatibility);
`_acg_probe`'s reliance on dynamic scope for `pass`/`fail` is correct bash. Response bodies are
uncapped by design — the total deadline is what bounds them, and at Tor speeds that is the
honest limit.

Suites re-run after the fix: **88 unit / 22 end-to-end, still green.**

---

### S4a — Listen protocol spec — 2026-08-10 ✅ *(no VPS, no code)*

**Outcome: `script052_design.md` §"Listen protocol", ~230 lines, every claim cited.** Nothing
was written or run — this packet exists so that S4b never has to open `listener.js`. The whole
file (1901 lines) was read, plus `interaction.js`, the listener-facing parts of `wallets.js` /
`wallet.js`, `Api.getResponse`, the status constants in `common.js`, and the `/listen` +
`/wallet/` locations of `docs/upstream-nginx.conf.reference`.

Citation form is `L:<line>` for `listener.js` and full filenames otherwise, so a future
upstream bump can be re-verified line by line rather than re-derived.

#### What the protocol turned out to be

Five message kinds on one text-only WebSocket, discriminated **in order** — `Index` first, so
a message carrying both `Index` and `Interaction` is read as a response. Four request names
(`Create URL`, `Change URL`, `Own URL`, `Delete URL`), correlated by an echoed `Index`;
inbound HTTP arrives as an *interaction* (`Interaction`/`URL`/`API`/`Type`/`Data`), and the
tab answers with a body plus an HTTP status. Timeouts are 120 s both ways; the reconnect
ladder is 250 ms doubling to a 10 s cap, forever, with no give-up state.

#### Seven things the packet brief did not anticipate

1. **`Status` is a number one way and the string `"Succeeded"` the other** (L:691 vs L:1845).
   Same key, two types, two directions — the single easiest thing to get wrong in S4b, and
   wrong silently.
2. **One status message, two roles, decided by timing — and the ack is a commit point.**
   Before the tab replies, a non-`"Succeeded"` status **cancels** the interaction and aborts
   the wallet operation (L:1304-1321); after it replies, the same shape is the **ack** the
   reply is blocking on (L:1640-1662). The handoff is exact: the cancel handler is torn down
   on the first line of `respondWithData` (L:667-670). What makes it money-relevant is that
   the tab records the received transaction only inside the success branch
   (`wallets.js:586`→`:1092`); a lost ack times out at 120 s and takes the rollback path
   (`wallets.js:1093-1127`), which saves **only** the key-derivation counter — so the receiver
   has no record of a payment the sender may already be able to finalise and broadcast. Ack
   after the response is really delivered, and ack reliably.
   *(Correction to this session's first draft, caught in the review pass: silence does not
   cancel — it stalls 120 s and then rolls back. The distinction changes what S4b must
   implement, so it is stated explicitly rather than smoothed over.)*
3. **The client proves ownership with nothing at all.** `Own URL` carries only the suffix,
   which is public — it *is* the payee's address. Read literally, any tab could claim any
   address. The mechanism is only visible in upstream's nginx: `/listen` is the one location
   that forwards `Cookie`, allow-lists `Set-Cookie` and adds `Vary: Cookie` (ref conf
   194-237). So ownership is a **server-issued session cookie on the handshake**, and that
   makes cookie expiry an address-lifetime policy — the client's `Own URL → false` path
   *discards the suffix and mints a new one* (`wallets.js:4035-4048`), i.e. losing a cookie
   silently changes the user's receiving address. Recorded as §10 with the consequences
   spelled out, because it is a product decision wearing a protocol costume.
4. **An uppercase character in a minted suffix breaks receiving, permanently and silently.**
   The inbound lookup lowercases (`wallets.js:5007`) while the wallet stores the suffix
   verbatim (`wallets.js:3923`, `:9250`), so a mixed-case suffix indexes under a key the
   lookup can never produce: address displays, sender delivers, wallet answers 404, UI says
   nothing. nginx's `[a-zA-Z0-9]+` is the ceiling, not the target — **mint lowercase**.
5. **The default listener URL drops the port** — `server["hostname"]`, not `host` (L:1893).
   A site on a non-standard port produces a listener URL nobody is listening on. Constrains
   S2/S7: standard port, or the operator sets Custom Listener Address by hand.
6. **The client never pings, and upstream's `/listen` has `proxy_read_timeout 60s`** (ref conf
   209). Idle sockets therefore die at 60 s and every reconnect costs one `Own URL` per
   wallet. The server must ping well inside 60 s or the whole population re-handshakes every
   minute. Nothing in the client hints at this; it comes from the two facts together.
7. **`Create URL` is not idempotent, and the client re-sends after a reconnect.** A pending
   request is re-sent verbatim on every `CONNECTION_OPEN` and only fails on the **third**
   close (L:1511-1520). So the same `Index` legitimately arrives on a second connection —
   under a new session, with the first suffix orphaned. S4b needs GC; without it the table
   only grows, since a client never re-claims a suffix it has forgotten.

Smaller ones worth having written down: there is **no HTTP method and no header field** in the
protocol at all (so preflight is answered by the gateway and no inbound header can reach the
tab); the only `API` value this client accepts is `/v2/foreign`; `401` and `403` are defined
in the status set but **never sent by this client**; a rejected payment still travels as
**HTTP 200** carrying a JSON-RPC error, so the gateway must not translate it to a 4xx; and
`Delete URL` treats an error response as `false` while a *connection-level* failure sends
`deleteAddressSuffix` into an immediate recursive retry (`wallets.js:4223-4227`) — so refuse a
delete with a well-formed message, never by dropping it.

#### Eleven gaps recorded as ours, not upstream's

§11 lists them: session mechanism, suffix alphabet/length/entropy, quotas, lifetime + GC of
orphans, delivery when the owner is offline (upstream holds the inbound request for
`proxy_read_timeout 208w` — the same unbounded hold S3 refused on the `/tor/` rail, and
pointless past the client's own 120 s ceiling), interaction-id reuse, the inbound body cap
(upstream sets **none** on `/wallet/`, so it silently inherits nginx's 1 MB default),
liveness, unknown-request behaviour, second-socket policy, and logging. The logging rule is
S3's, restated harder: a suffix is a payee address and an interaction is a payment, so suffix
↔ IP ↔ timestamp must never meet in a log line.

**Verify**

- every claim in §"Listen protocol" carries a `listener.js:<line>` citation or a named-file
  one; the six inferences drawn from nginx rather than the client are labelled as inferences
- **no code written, nothing run, no VPS touched** — the packet's own acceptance test
- design doc: S4a marked done in the packet map and on its own heading

**Owed to S4b:** read §"Listen protocol" and *not* `listener.js`.

---

### S4b — Gateway II: `/listen` + the per-wallet inbound URL — 2026-08-10 ✅ *(code; VPS run still owed)*

**Outcome: Accio can now receive.** Four modules were added to the same service and the same
unit S3 built — `ws.js`, `store.js`, `listen_route.js`, `wallet_route.js` — replacing
upstream's `WebSocket-Listener`, the one component we may not ship at all (no `LICENSE`, no
`COPYING`, no licence mention in its README). The gateway still has **zero npm dependencies**.
Written entirely against §"Listen protocol" in the design doc; `listener.js` was never opened,
which is what S4a existed to make possible.

| File | Lines | What it is |
|---|---|---|
| `ws.js` | ~340 | RFC 6455 server: handshake, framing, masking, fragmentation, control frames, ping/pong |
| `store.js` | ~300 | the suffix ↔ session table: mint, own, release, quotas, GC, durable snapshot |
| `listen_route.js` | ~480 | the protocol itself: four requests, interactions, the cancel/ack duality |
| `wallet_route.js` | ~150 | `/wallet/<suffix>/v2/foreign`: parse, normalise, CORS, body cap |

#### Six things the packet brief did not anticipate

1. **"Reuse 093 Transporter's Node+SQLite patterns" cannot be taken literally.** SQLite needs
   either an npm package — against the zero-dependency rule S3 established and justified — or
   `node:sqlite`, which requires Node 22.5+ and is still experimental while our floor is 18.
   What actually transfers is 093's two *lessons*, and both are honoured: capacity is
   partitioned per writer rather than per victim, and the wallet id is normalised at the route.
   The store is a debounced, atomically-renamed JSON snapshot — one small row per wallet, no
   queries, no joins, no ordering. If it ever grows a second index, revisit; not before.
2. **The snapshot is not a cache, and losing it is not a degraded mode.** The client discards
   any suffix the gateway stops recognising and immediately mints a new one, so an in-memory
   table changes **the receiving address of every wallet that has ever connected, on every
   restart** — i.e. on every routine deploy — while payments already travelling to an old
   address are answered 404 with nothing in the UI to explain it. This is the first thing this
   service writes to disk: `/opt/grin/accio-<net>/gateway-state/`, the **only**
   `ReadWritePaths` in an otherwise `ProtectSystem=strict` unit (exactly as S3's comment asked
   — the path was added, not `ProtectSystem` relaxed). The self-test now fails loudly when the
   table is not durable, because nothing else on that screen would reveal it.
3. **A per-session socket cap must REFUSE, never evict** — see the bugs below.
4. **`ws.js` must handle `'end'`, not only `'error'` and `'close'`** — see the bugs below.
5. **The `Type` field relayed to the tab must be the BARE string `application/json`.** The
   client compares it for equality and answers 415 for anything else (§5), so passing through
   a perfectly ordinary `application/json; charset=utf-8` from the sender would fail every such
   payment with a media-type error nobody could explain. `wallet_route.js` verifies the real
   header; `listen_route.js` sends the constant.
6. **Three rate zones now, where S3 wrote one — and the helper will not add them.**
   `nginx_ensure_rate_limit_zones` is a no-op when its conf file already exists, which is
   precisely an S3 box's state (`script052-rate-limits.conf`, containing `accio_tor` alone).
   Left alone, the S4b snippet references `accio_listen`/`accio_wallet`, nginx fails "unknown
   limit_req_zone", **and nginx then refuses to start at all**, taking Fidelius, GrinScan, the
   pool, Drop and the node API with it. `_acg_ensure_zones` detects the missing zones, backs
   the file up, regenerates it, and refuses to touch a file that is not ours.

#### Two bugs found by the end-to-end run, both invisible to a unit test

Both were found by watching `/health`'s `listen_open` refuse to move, not by re-reading code —
the same shape as S3's three, where Node's own semantics rather than our logic were the trap.

1. **The socket cap evicted a LIVE connection.** A socket the peer has closed stays on our
   books until Node delivers its `'close'` event, so a tab that reloads briefly has *both* its
   old and its new socket counted. The eviction then fired on whichever connection looked
   stalest — a different, perfectly healthy tab, possibly mid-payment. Pruning by `ws.closed`
   first does **not** fix it: that is the same information, checked earlier. The fix is to
   change the policy, not the detection — **refuse the new handshake instead**. The same race
   then becomes harmless: the refused tab retries 250 ms later (the client's ladder starts
   there), by which time the corpse is reaped, and nothing can ever disconnect a wallet that is
   in the middle of receiving. Cost: a browser genuinely over the cap gets one handshake
   refused per 10 s — bounded, self-healing, and far cheaper than dropping a live socket.
   Default cap raised 4 → **8** to keep it rare.
2. **A clean FIN never reaped the connection.** `ws.js` listened for `'error'` and `'close'`
   but not `'end'`. A peer that half-closes — a TCP FIN, which is exactly what a browser sends
   when its tab is closed — emits `'end'` and nothing else, because the socket stays writable
   from our side. The connection therefore sat on the books until the pong timeout noticed, up
   to ping+pong (**45 s** on the defaults), holding the session's socket slot for a tab that no
   longer existed and over-reporting `listen_open`. Verified before and after: a clean
   `sock.end()` left the count unchanged for at least a second, and now clears it inside 50 ms.

#### The eleven §11 decisions, as taken

The design listed these as ours; recording the answers here so S8 audits decisions rather than
re-deriving them.

| # | Decision |
|---|---|
| 1 | Session = 256-bit CSPRNG id, opaque, looked up server-side (no MAC — a forged cookie must *guess* an entry, and a MAC would put a secret in a service whose claim is that it holds none). Cookie `HttpOnly`, `SameSite=Lax`, `Path=/listen`, `Secure` **auto** |
| 2 | Suffix = 16 chars of lowercase RFC 4648 base32 = **80 bits**, unbiased (32 symbols, 5-bit mask). Lowercase is enforced, not assumed — §9's trap is silent and permanent |
| 3 | 16 suffixes/session, 100 000 global, 8 sockets/session, 512 global, 20 msg/s (burst 60) per socket |
| 4 | Suffixes die **with their session** (90-day rolling ttl). No separate suffix ttl: one outliving its session could never be claimed again, and one expiring inside a live session would change a working address under a user who did nothing wrong. Orphaned `Create URL`s are reclaimed by evicting the oldest **unverified** suffix when the per-session cap bites — `Own URL` is the only signal the protocol gives that a client actually kept what we minted |
| 5 | Offline payee → **503 immediately** with `Retry-After`, not parked. Upstream holds the request for `proxy_read_timeout 208w`; a wallet that is not open genuinely cannot receive, and saying so lets the sender retry. Connected-but-silent tab → cancel + **504** at 180 s |
| 6 | Interaction ids: per-connection integers from 1. `Number.isSafeInteger` guarded, because `toFixed()` is called on them to build event namespaces |
| 7 | Inbound body cap **1 MB**, set explicitly in *both* nginx and the gateway (upstream sets none and silently inherits nginx's default) |
| 8 | Server pings every **25 s**, pong deadline 20 s; config refuses a ping interval ≥ 55 s outright |
| 9 | Unknown request name → `Error` response, never silence (silence costs the client a 120 s stall). A request with no numeric `Index` is dropped — there is nothing to correlate a reply to |
| 10 | Several sockets per session allowed; delivery goes to the **most recently opened** one. Broadcasting would ask several tabs to receive the same payment |
| 11 | Counts only, never a suffix, a session id, an origin or a peer. `log_destinations` (off by default) governs both rails |

**Also decided, and user-visible:** the onion front and the clearnet front are different
origins and therefore **different cookie jars**, so the same wallet reached both ways holds two
sessions and two receiving addresses. Accepted — arguably a privacy gain — but it means an
address minted over the onion is not the one shown over TLS.

#### Ordering that is money-relevant, and must not be "tidied"

The ack is a commit point (§7): the tab records the received transaction only inside the
success branch of its reply. So `listen_route.js` writes the response to the **sender first**
and sends `{"Status":"Succeeded"}` only once the bytes have actually flushed (`finish`, with
`close`-before-`writableFinished` treated as failure). If the write fails, the tab is sent an
`Error` instead so it rolls back deliberately rather than by 120 s timeout. Anyone refactoring
this into "ack then respond" reintroduces the case where the tab records a payment the sender
never received. A JSON-RPC-level rejection still travels as **HTTP 200** and must not be
translated to a 4xx.

**Verify — all green (nothing was run on a VPS)**

- `bash -n` on `052_lib_gateway.sh` and `052_grin_accio.sh`; `node --check` on all nine modules
- **96 assertions** (S3's 88 unit + 22 e2e were re-run unchanged alongside the new ones):
  RFC 6455 `Sec-WebSocket-Accept` against the spec's own example and all three length
  encodings; the store's alphabet, case, uniqueness over 2 000 mints, per-session and global
  quotas, unverified-eviction, lazy and swept expiry, the durable round-trip, mode-600 atomic
  write, and a corrupt snapshot being moved aside rather than deleted; cookie parsing, `Secure`
  in all six front/config combinations including a **forged** `X-Forwarded-Proto` on the onion
  front; path normalisation and ten rejected path shapes; and config validation refusing a
  header-injecting cookie name, an enumerable suffix length and a too-slow ping
- **end-to-end against the real `server.js`** through a real masked WebSocket and real POSTs:
  the four requests with their exact response *types*, cross-session refusal,
  rotate-and-release, a refused `Delete URL` answering well-formed `false` (never an `Error` —
  that is a client-side recursive retry loop), interaction delivery with all five fields, the
  bare `Type`, an uppercase suffix still delivering, a JSON-RPC error staying 200, the tab's
  404 becoming a 404, a NACK on a malformed reply, the 180 s timeout producing cancel + 504, a
  sender hang-up cancelling the tab's work, unknown suffix 404, offline 503, preflight 204,
  415, 405, 413, the ping loop, unmasked-frame 1002, binary 1003, `/listen` 426 on a plain GET,
  the socket cap refusing without touching anything live, FIN and RST both freeing a slot,
  and — the packet's central claim — **a restart not changing anybody's address, with a payment
  delivered after it**
- an S3-era `gateway.json` with none of the new keys still loads and starts
- the rendered nginx snippet checked for full variable expansion and for **zero `add_header`**
- every local test process exited or was killed in-session; a `Win32_Process` sweep found no
  orphans

**Still owed, by the first VPS session (S2), on top of S3's list:**

1. `→ 3) Self-test` now runs **16** probes; all must pass, including the durability check.
2. `→ 2) nginx glue` on a box that already has S3's zone file — confirm the regeneration path
   runs and `nginx -t` is clean **before** any reload.
3. The real thing: **have Fidelius pay a browser wallet's `/wallet/<suffix>` address and watch
   it arrive**, then confirm the receiving address is unchanged after `systemctl restart`.
4. Confirm stock nginx (no `load_module`, no `.so` in any conf) and no `php-fpm`.

---

### S5 — Overlay, branding, About credit — 2026-08-10 ✅ *(code; build + VPS run still owed)*

**Outcome: `web/052_accio/patches/public_html/` — 16 files, 562,163 bytes.** Every deviation
from upstream carries the marker `ACCIO PATCH` followed by its reasoning; `grep -rn "ACCIO
PATCH" web/052_accio/patches/` is the index of this packet, and the right way to review it (a
`diff` against `vendor/` is dominated by two 170 KB files in which four lines changed).

Taken out of order for the third time, and for the same reason as S3 and S4b: the overlay is
authored against the vendored tree. Nothing here has been rendered by PHP or served by nginx.

#### The packet collapsed from ~25 files to 2 — and that is the main finding

The obvious reading of "Accio branding" is a whole-file overlay of everything that says MWC:
`index.html`, `site.webmanifest`, `errors/template.php`, the eight `errors/*.html`, the five
`languages/*.php`, plus the JS. That is **~1.2 MB** of duplicated upstream, and five large
translation tables that every future upstream translation update would then have to be merged
into by hand.

It collapses to two files, because of a property of this codebase worth stating plainly:
**every user-visible string in the app is a translation, and every translation passes through
`getDefaultTranslation()` or `getTranslation()`** — once server-side in `backend/language.php`,
once client-side in `scripts/language.js`. A phrase map applied at those two points rebrands
the entire product, in all six languages, including files we never touch.

The map is applied in three places, and all three are required:

| Where | What | Why it is not optional |
|---|---|---|
| `getDefaultTranslation($text)` | brand the input | this string becomes the `data-text` attribute — the key the client-side translator looks up later |
| `getTranslation($text)` | brand the lookup key | the table is branded, so an unbranded key stops matching and the string silently falls back to English |
| `getAvailableLanguages()` | brand every **key and value** of each `Text` table | `scripts/languages.js` re-exports this table to the browser verbatim; brand only the values and every client that switches language gets "MWC Wallet" back |

`scripts/language.js` carries the identical map for the client side. **If the two ever diverge
the failure is silent** — not an error, just a string quietly rendering in English.

Consequences worth knowing before someone "simplifies" this:

- **An upstream bump cannot reintroduce MWC text.** New strings are branded on arrival.
- **Nothing in the built output says where "Accio" came from.** The map is the single place to
  look, which is why `patches/README.md` names it first.
- It is **phrases only** — `"MWC Wallet"` and `"MimbleWimble Coin"`. Never the bare token
  `MWC`: that is the ticker and a protocol discriminator (design §"Naming policy" layer 3).

#### Arguments are matched WHOLE-VALUE, never by substring

`Language.getTranslation(text, textArguments)` also brands its arguments, which is how
upstream's URLs get replaced without patching the 266 KB `application.js` that contains them:
`https://mwcwallet.com` becomes this deployment's own `HTTPS_SERVER_ADDRESS`, upstream's onion
becomes `TOR_SERVER_ADDRESS`, and the three `MWC-Wallet-*/releases` links become our releases
page.

That argument list also carries **user data** — wallet names, addresses, file names. A
substring rule there would silently rewrite a user's own text, so `brandArgument()` matches the
whole value or leaves it alone; no user value equals one of upstream's URLs by accident. (It
also uses `Object.prototype.hasOwnProperty.call`, because `"toString" in {}` is `true`.)

**This is not decoration.** The string it fixes is the wallet's anti-phishing line — *"Make
sure that you're accessing … for free from its official site at %1$m"* — shown on the screen
where a user is about to type a passphrase. Shipped unpatched it would have told Accio users
that the official site is `mwcwallet.com`.

#### The credit, and the trap it set

`ATTRIBUTIONS["MWC Wallet"]` in `backend/resources.php`, linking upstream's repo and
`./MWC Wallet license.txt` (a byte-identical copy of `vendor/upstream-wallet/LICENSE`,
sha256 `bbc8b96c…`, matching PROVENANCE). Rendered by `about_section.js` in the app's own
idiom, next to jQuery and BLAKE2b. Upstream's copyright line in the About section
("© 2022–… Nicolas Flamel.") stays verbatim — that is the licence condition, not a courtesy.

**The trap:** the first draft put `https://github.com/NicolasFlamel1/mwcwallet.com` in
`brandLinks` as "the source-code URL", which would have rewritten *the credit's own link to
point at us*. The same literal means two different things — "where this build's source lives"
and "the work we forked" — and no map can tell them apart. Fixed by patching
`about_section.js` explicitly for the source link (which also collapses upstream's four-way
extension/standalone/mobile/site branch, since Accio is one repository) and removing that URL
from the map. Covered by a test asserting the credit's name, URL and licence path all survive
branding untouched.

#### Four decisions the brief did not anticipate

**1. Icons are SVG-only.** Upstream ships `favicon.ico`, 20 app-icon PNGs, 8 touch-icon PNGs
and 4 tile PNGs — 33 rasters of the MWC mark. The build is offline and deterministic by
design, so it *cannot* rasterise at build time, and hand-committing 33 PNGs was not something
this session could do well. So `FAVICONS`, `TOUCH_ICONS` and `TILE_IMAGES` are emptied and
`APP_ICONS` holds one SVG. The alternative — leaving them populated — means shipping the MWC
bowtie as our favicon, the exact leak this packet exists to close. SVG-only is also this
repo's house convention: 051, 06b, 06d and the 07 pool all ship an SVG favicon and no raster
set.

- `site.webmanifest` needed its own patch for this: upstream's loop emits only the five-part
  `APP_ICONS` entries and hardcodes `"type": "image/png"`, so a one-part SVG entry produced
  `"icons": []` — **a manifest with no icons is a PWA that will not offer to install.**
- The PNG *files* stay in the tree, unreferenced (~100 KB); deleting them is S9.
- **The one real loss is the iOS home-screen touch icon**, which has no SVG form. Recipe to
  add it later, no code change required: rasterise `images/app_icons/app_icon.svg` at
  57/76/114/120/144/152/167/180 px (`rsvg-convert -w N -h N`), drop the PNGs into
  `patches/public_html/images/touch_icons/`, and restore the `TOUCH_ICONS` array.

**2. The 3D logo is suppressed here, not in S9.** `scripts/logo.js` renders a WebGL model from
`./models/mwc.json` — upstream's MWC mark, spinning, on the wallet screen. There is no Grin
model to swap in, so the design schedules it for deletion in S9's second pass — but **S9 lands
after the S7 launch**, which would mean launching Accio with a rotating MWC logo. Suppressed
now, reversibly, in two lines.

> The interesting part is *which* two lines. Killing WebGL alone is not enough and is actively
> worse: `allowShowing()` gates on `this.compatible`, which stays `true`, so `main` still gets
> class `logo` — and the rule `main.logo > div > div > div.logo` **hides the SVG wordmark** to
> make room for a canvas that can never paint. The page would then show *no* logo at all.
> Setting `compatible = false` takes the path a browser without WebGL takes, and the CSS keeps
> the SVG mark. (Upstream has the same latent bug for genuinely WebGL-less browsers.)

**3. The Donate section is removed.** Its four rows were Bitcoin / MimbleWimble Coin / Grin /
Epic Cash, every one a `https://mwcwallet.com/donate/*` link in plain markup — the brand layer
cannot touch a raw `<a>`, and keeping them would route an Accio user's donation to upstream
without saying so. We have no address of our own, and inventing one is not this packet's call.
`about_section.js:addDonateInformation()` prepends to `div.donate`; with the div gone that
`find()` is empty and `prepend()` is a no-op, so nothing else needed touching. **Restoring it
is one `<h3>` and one `<li>` with the operator's Grin address — an S7 decision.**

**4. The translation contact became our issue tracker.** Upstream invites translators to email
`nicolasflamel@mwcwallet.com`. We have no mailbox, so the argument maps to
`…/Grin-Node-Toolkit/issues` and a third map entry rewrites the sentence around it
(`"You can email %1$m"` → `"You can open an issue at %1$m"`). Only the **English** phrasing
matches; the other five languages keep their own wording around a link that now goes to
GitHub. **If the operator wants a real address before S7, this is the one line to change** —
and doing so removes the sentence-rewrite entry too.

#### Two bugs in S1's own lib, found by using it

S5 is the first packet to actually run `_acb_apply_patches`, and it exposed two
order-of-operations holes. Both fixed in `scripts/lib/052_lib_build.sh`, both now tested.

1. **A patch that makes a static file templated shipped a stale SRI.** The templated branch
   `continue`d — leaving upstream's hash of the *original static bytes* in `$files`. The
   browser then refuses to execute the rendered output on integrity grounds, and the console
   error names the file, not the overlay. `_acb_set_resource_entry` now accepts
   `newsum="NULL"` to *clear* the checksum (a real SRI is 88 base64 chars, so the sentinel
   cannot collide), and the templated branch passes it. No current patch triggers this — it is
   a trap disarmed before someone falls in.
2. **The SRI pass read `$files` from the stage as it went**, so a patched
   `backend/resources.php` only affected paths sorting *after* it in `LC_ALL=C` order. Every
   uppercase-initial path sorts before `backend/` — `MWC Wallet license.txt` is exactly one,
   and it was silently reported "not in the resources table" even though our patched table
   lists it. Split into **two passes**: overlay everything, then refresh against the final
   table. (Pass-2 log lines now name their file, since they no longer sit under the copy line.)

Also, while in there: that `awk` program lives inside a **single-quoted bash string**, so an
apostrophe in a comment inside it terminates the string. The word "upstream's" cost one
`bash -n` failure; there is now a note in the awk saying so.

#### Residual `mwc` in the published tree — the honest table

The packet brief's verify line ("a case-insensitive `mwc` grep over the built output returns
only the About-section credit and the vendored `LICENSE`") **is not achievable, and it
contradicts the policy this packet was told to read.** §"Naming policy" layer 3 says MWC
*identifiers* must be deleted in S9+, never renamed — so they are still there, by design.

Measured over the files that ship byte-for-byte (excluding `*.php`, `backend/`, `languages/`,
`.user.ini`, and the templated files whose bytes PHP replaces):

| Count | Category | Disposition |
|---|---|---|
| 195 | Layer-3 identifiers — `Consensus.MWC_WALLET_TYPE`, MWC node URLs, `explorer.mwc.mw`, `web+mwc`, `"mwcmain"`, the `.mwc` CSS class | **S9+ deletion passes.** Unreachable: `getWalletType()` can no longer return MWC |
| 25 | Our own `ACCIO PATCH` comments and the brand map itself | intended |
| 16 | Source literals inside `getDefaultTranslation('… MWC Wallet …')` | rewritten at runtime; a user sees "Accio" |
| 8 | Firefox / Chrome / Edge / Opera add-on store URLs in `application.js` | dormant — reachable only from inside a browser extension, which we do not ship. Revisit if one is ever built |
| 1 | The byte sequence `mwc` inside `font_awesome-5.15.4.woff2` | coincidence |
| 1 | `privacy_policy.txt`'s credit sentence | **intended** |

Plus, in the *rendered* `index.html`: the `ATTRIBUTIONS` JSON carrying the credit — name, URL
and licence path, three occurrences on one line. **Zero user-visible MWC strings.**

Use this table as the S9 progress meter, not a bare grep count. The number that should fall is
the 195.

#### Smaller things worth not rediscovering

- **This pin has no minified files.** All 252 `$files` entries are `"Minified" => FALSE`, so
  `getResource()` never rewrites a patched path to a `.min` variant our overlay did not
  produce. Worth re-checking after any upstream bump — it would silently bypass every patch.
- **The MWC glyph font is no longer fetched.** `fonts/mwc/` holds the MimbleWimble Coin
  currency symbol, and only `language.js`'s `case Consensus.MWC_WALLET_TYPE` renders it, so the
  `<link rel="preload">` and its stylesheet were two round trips on every visit for a glyph
  nothing can produce. Deleting the font *files* and the `.mwc` rule in `styles/common.css` is
  still S9's third pass; this only stops fetching them.
- **`Consensus.WALLET_MWC_TEXT_VALUE` and `WALLET_GRIN_TEXT_VALUE` now both evaluate to
  "Grin"** (both are `getDefaultTranslation` calls, and the map rewrites the first). Harmless:
  the only place they are distinguished is the `switch` in the unreachable
  `getWalletTypeUpstream()`. Do not "fix" it by special-casing the map.
- **`getWalletTypeUpstream()` is upstream's resolution logic, kept verbatim and unreachable.**
  Deleting it would turn a one-block diff into a 100-line rewrite and make the next upstream
  change to that logic unreviewable.
- **The wallet-type `<option>` value must stay `"1"`.** It is `Consensus.GRIN_WALLET_TYPE`, a
  consensus discriminator, not a menu index.
- **`privacy_policy.txt` is now ours and makes factual claims about the gateway** — that the
  `/tor/` relay does not store requests, and that nginx's access log records the destination
  onion in the request line. Both match `gateway/tor_route.js` today (it logs only errors).
  **S8 must re-verify this against the deployed nginx config**, because a privacy policy that
  is wrong about logging is worse than no policy.
- Brand colour is **violet `#9400D3`**, from this repo's house palette
  (`web/0z0_media/logo_favi/grin_violet.svg`), chosen because it sits beside upstream's
  existing `#7A00D9` theme — so the marks drop in with **zero CSS changes**. `BACKGROUND_COLOR`
  and `THEME_COLOR` are deliberately left as upstream set them.

**Verify — all green (nothing was run on a VPS, and no PHP was executed)**

- `bash -n` on `052_lib_build.sh`, `052_grin_accio.sh`, `052_lib_gateway.sh`
- `node --check` on all six patched JS files; XML well-formedness on all four SVGs
- **12 assertions on the SRI rewriter's new NULL mode** against the real `resources.php`:
  clears a real checksum without emitting `"NULL"` as a *string*, leaves an already-NULL entry
  NULL, touches exactly 4 lines, never writes NULL into a `Version` line, normal SRI mode
  unchanged, unknown path still returns 3 with the file byte-identical
- **25 assertions on the brand layer** in a stubbed VM: title, error title, the product blurb,
  a German translation value, idempotence, non-string passthrough, the bare token `MWC` left
  alone, whole-value URL/onion/releases remapping, **the credit's name, URL and licence path
  all preserved**, user data containing "MWC Wallet" left alone, `"toString"` not matching via
  the prototype, in-place mutation of the argument array preserved
- **an end-to-end dry run of `_acb_apply_patches`** against the real vendored tree: 16 files
  applied, rc 0, and **all 10 refreshed checksums recomputed and compared against
  `openssl dgst -sha512` of the patched bytes** — every one matched
- a full residual audit of the simulated published tree, classified into the table above with
  **zero unresolved**
- every local test process was one-shot (`node`, `python`, `bash`); nothing was left listening

**Still owed to S5, by the first VPS session (S2):**

1. **`php -l` on the two patched PHP files** — `backend/language.php` and
   `backend/resources.php`. There is no PHP on the dev machine, so the brand layer and the
   icon/attribution tables have never been parsed. Do this *before* the first build; a parse
   error there fails every render at once.
2. **Rebuild site**, then read the log: 16 `patched` lines and 14 `sri` lines, no `ERROR`.
   The 14 break down exactly, and any other split means the overlay drifted from the table:
   **10** `checksum refreshed` (4 SVGs + 6 JS), **2** `upstream sets no checksum here, none
   written` (`privacy_policy.txt`, `MWC Wallet license.txt` — both `Checksum => NULL` by
   upstream's own convention for files fetched as links, not as subresources), **1**
   `templated, checksum cleared` (`site.webmanifest`), **1** `not in the resources table`
   (`index.html`, which upstream never lists). The two `backend/` files are excluded by
   design and produce no `sri` line at all.
3. Load the site and confirm, in this order — the page shows the **Accio wordmark** (not a
   blank space, which would mean the logo CSS assumption in decision 2 is wrong); the tab icon
   is the violet Grin roundel; Settings → Wallet type offers **only Grin**; About shows the
   **MWC Wallet credit** with a working licence link and a source link to our repo; the Donate
   section is **gone**; then switch the language to German and confirm the strings stay
   branded — that is the one check that proves the table-key branding, and the one thing no
   unit test here could reach.
4. `curl -s https://<domain>/site.webmanifest | python3 -m json.tool` — must parse, must carry
   one SVG icon, and must list exactly four `web+grin*` protocol handlers.
5. Re-run S2's send and S4b's receive against the **rebranded** build, not just the pristine
   one — the patched `consensus.js` and `node.js` are both on the money path.

#### S5 post-write review — 2026-08-10

Re-read every patched file against its vendor original rather than against the notes above.
The overlay held; five things are worth recording.

**One defect found and fixed — the build log lied about two files.** `_acb_set_resource_entry`
returned 0 both when it wrote a checksum and when it hit an entry upstream marks
`Checksum => NULL` and left it alone, so `privacy_policy.txt` and `MWC Wallet license.txt`
logged *"checksum refreshed"* over an untouched `NULL`. Nothing shipped wrong — the file
content is right either way — but the build log is the acceptance evidence for a build nobody
watches run, and step 2 above asks an operator to read it. Now a distinct **exit 5** ("success,
no checksum written"), with the table still installed. The same edit dropped *"version bumped"*
from every message: an entry at `Version 0` means "emit no `?query`" and deliberately stays at
0, so most of those lines were asserting a cache-bust that had not happened.

**A consequence of that, worth knowing before the first content edit after launch:** a
`Version 0` entry is not cache-busted, so a later change to `privacy_policy.txt` will not reach
a browser that already has it. Harmless now (nothing has ever been served), but bump that entry
to 1 the first time the policy changes in anger.

**`check_for_updates.js` is dead code in a hosted build.** Its three repointed URL pairs sit in
the extension / mobile-app / `file://` branches; the hosted `else` sets no URL and *hides* the
update-check setting entirely. Kept anyway — it costs one overlay file and it is correct if a
standalone artefact is ever built — but do not expect to see it do anything on the VPS, and
note `noobvie/Grin-Node-Toolkit` has no releases, so `/releases/latest` would 404 if it ran.

**`logo_big.svg` is placeholder-quality.** It is a geometric stroked *ACCIO*, built by hand
because there is no drawing tool in this loop: the letterforms are correct, nothing clips the
`278×47` viewBox at `stroke-width:6`, and it is white-on-transparent like upstream's — but the
letter spacing is loose and uneven (gaps of 31/36/41/36 units). It renders as a CSS
`background-image` at the top of the unlocked view, so it is the single most visible thing on
the page. Look at it in step 3 and treat replacing it as an S7 task, not a bug.

**Two residuals the earlier audit did not name.** `favicon.ico` is still upstream's MWC mark in
the tree and still listed in `$files` (`FAVICONS` is empty, so nothing links to it, and a page
with an explicit `<link rel="icon">` never falls back to `/favicon.ico` — but a direct fetch of
that path still serves the bowtie). And `fonts/mwc/` is no longer linked from `index.html` yet
remains in `$files`, so the service worker still precaches it. Both are file-deletion work,
which is S9's job; neither is user-visible.

**Everything else re-verified from scratch:** `bash -n` ×3, `node --check` ×6, four SVGs
well-formed, PHP brace/paren/bracket deltas balanced in both patched PHP files, the brand suite
`pass=25 fail=0`, the rewriter suite `pass=12 fail=0` plus a direct exit-5 assertion, a fresh
end-to-end `_acb_apply_patches` run (rc 0, 16 patched, 14 sri), and all 10 written checksums
recomputed against `openssl dgst -sha512` with zero mismatches. Three claims made in the S5
notes above were checked against upstream source rather than assumed and all hold: `errors/*.html`
are PHP that call `getDefaultTranslation`, so the brand layer does reach them; `scripts/languages.js`
is templated from `getAvailableLanguages()`, so the branded table is what ships to the browser;
and `HardwareWallet.APPLICATION_NAME` switches on `Consensus.getWalletType()`, so a Ledger is
now told to open **Grin**, not *MimbleWimble Coin*.

---

### S6 — Integrity + update check — 2026-08-10 ✅ *(code; the VPS run rides along with S2)*

**Outcome: the pin is now checked instead of asserted.** S0 vendored two upstreams and wrote
`vendor/SHA256SUMS`; for a day that manifest was a comment nothing read. `scripts/lib/052_lib_vendor.sh`
(≈560 lines, no new dependency) is the reader, and `accio_build` will not stage a single file
until it passes. Menu key `5` **Check upstream** went from stub to live — the third live key,
after `2` Rebuild site and `3` Gateway service.

**Files**

| Path | What changed |
|---|---|
| `scripts/lib/052_lib_vendor.sh` | **new.** `acv_verify_vendor` (offline), `acv_check_upstream` (the only network action in 052), `acv_pin_report`, `acv_vendor_menu` |
| `scripts/lib/052_lib_build.sh` | `accio_build` sources the lib and gates on `acv_verify_vendor --quiet` before staging; header records that the no-network property now spans two files |
| `scripts/052_grin_accio.sh` | key `5` → `acv_vendor_menu`; header packet list, "we write exactly **four** things", live-key banner |

#### The check is three checks, and the order is the design

`sha256sum -c` was the whole plan. It is not sufficient, for a reason worth stating plainly:

1. **The manifest's own sha256, against `PINNED_SHA` — first.** Anyone who edits `vendor/` and
   then regenerates `SHA256SUMS` defeats step 2 completely. This step is the only one that
   notices, so it cannot run second. Verified by test: tamper a byte, regenerate the manifest,
   and the check still fails — on this step.
2. **`sha256sum -c` over all 274 listed paths.**
3. **The file set, both directions.** Step 2 verifies only what the manifest *lists*, so it
   **structurally cannot see a file that was added**. That is the more interesting attack
   anyway: the build copies the whole vendored tree, so a dropped-in `backdoor.js` ships to a
   self-custodial wallet without one listed hash changing.

Each is worthless alone — step 1 trusts the tree, step 2 trusts the manifest, step 3 proves
nothing about content. Only the three together mean anything.

⚠ **The remedy for a failure is a re-vendor in this repo, never a regenerated manifest on the
VPS.** Regenerating on the target certifies whatever is on the target, which is exactly the
thing being questioned. The failure message says so, because the obvious "fix" is the wrong one.

#### Three deviations from the packet spec, all deliberate

**`FETCH_HEAD` became `origin/HEAD`.** The spec said `git log --stat <PINNED_SHA>..FETCH_HEAD`.
A shallow or single-ref fetch cannot *contain* the pinned commit, and the most important answer
this action produces is **"is our pin still reachable?"** — a "no" means upstream force-pushed
or rewrote history, which is a security event, not an update, and a diff against a rewritten
branch is meaningless. So it fetches every branch at full depth, resolves the default branch via
`remote set-head origin -a`, and reports the unreachable case separately and loudly (rc 1). Our
copy is unaffected either way, and the message says that too — `vendor/` is ours and byte-pinned.

**The scratch clone is `init --bare`.** `log`, `diff` and `rev-list` all work fine against a bare
repo, so there is no reason to ever materialise upstream code as a file on a box that serves a
wallet. Asserted by test: after a check run, no upstream filename exists anywhere under the
scratch directory.

**The overlay cross-reference splits *replaced* from *added*.** `patches/public_html/` has 16
files but only **15** shadow a vendored file. `MWC Wallet license.txt` is upstream's root
`LICENSE` copied under `public_html` so the About credit has a link target inside the served
root — it has no upstream counterpart, so upstream can never "change" it and it must not be
counted as conflict risk. It surfaced as a failing assertion, not by reading: the first version
of the test demanded every overlay path exist upstream, and one did not.

That one file also produced the check's most useful small feature. Because our copy is a *copy*,
an upstream licence change silently makes the About credit misstate the licence — so upstream's
root `LICENSE` is on a **watched** list alongside `nginx.conf` (the spec S3/S4b replaced, kept
outside `vendor/` at `docs/upstream-nginx.conf.reference`). Neither is cross-referenced by the
overlay check; both are reported when they change.

#### The overlay list is derived, never written down

`_acv_patched_upstream_paths` walks `patches/public_html/` at run time. A hand-kept copy would be
wrong on the first session that forgot to update it — and that is precisely the session where a
missed conflict silently reverts a patch. S9's deletion passes will grow this overlay; nothing
needs updating here when they do.

#### The offline property now spans two files, so it is proved in both

`052_lib_build.sh`'s whole argument is that a build makes no network request. That claim now
depends on a second file, so `_acv_assert_offline_path` mirrors `_acb_assert_offline`: it greps
the **parsed function bodies** (`declare -f`) of the verify chain for a fetcher in command
position. Parsed bodies, not the file — this lib is *supposed* to contain a fetcher, in
`acv_check_upstream`, which no build ever calls. Bash discards comments when it parses a
function, so comments cannot trip it.

⚠ **A message string can trip it**, since ` name ` inside quotes looks the same as a command.
That is on purpose and cheap to live with — the verify chain must not name these tools in its
output either, which is why its failure text points at `PINNED_SHA`'s recipe instead of spelling
a command out. The detector is tested both ways: it passes on the shipped chain, and it catches a
fetcher planted into `acv_verify_vendor`.

One gap in it was found and closed while reviewing: this lib never spells the tool out — it
invokes it through `"$ACV_GIT_BIN"` — so a literal-name-only pattern would have missed the exact
form a future edit is most likely to copy. `ACV_GIT_BIN` is now part of the pattern, and there is
an assertion for each spelling.

#### Two smaller things worth keeping

**Manifest paths are cut by COLUMN, not by field.** Two vendored files have spaces in their names
(`third-party libraries instructions.txt`, `MWC Wallet license.txt`); `awk '{print $2}'` truncates
both to a path that exists nowhere, which would have reported two phantom deletions on every run.
Lines are `<64 hex><space>[*| ]<path>`, so the path starts at column 67.

**`grep -c` prints `0` *and* exits 1.** `count=$(… | grep -c . || echo 0)` therefore emits two
lines on an empty input, not one; `|| true` is the correct guard. Caught while reading, not by a
test — an empty manifest fails earlier, so nothing would have exercised it.

**Verify was not made bypassable.** A `--force`/`ACCIO_SKIP_VERIFY` escape hatch was considered
and rejected: a build that can skip its integrity check is worse than one with no check, because
the manifest then reads as evidence it never provided. A missing `052_lib_vendor.sh` is likewise a
hard error, not a warning.

#### Review pass — three defects found after the packet was written, all fixed

Re-read of the finished lib, with each hypothesis proved before editing (CLAUDE.md
*"Confirm Root Cause Before Editing"*). All three were in code the harnesses had already
passed, which is the point: the tests proved what they were written to prove.

1. **`find -type f` made an added SYMLINK invisible.** Check 3 claimed to compare "the file
   SET, both ways", but `-type f` lists only regular files. So a symlink dropped under
   `vendor/` was listed by nothing, checked by nothing (`sha256sum -c` only reads paths the
   manifest names), and preserved by the build's `cp -a` — it shipped. That is the *cheapest*
   bypass of the whole manifest, so the check had a hole exactly where it advertised
   completeness. Now `! -type d`. Proved with a FIFO (Windows cannot create a symlink without
   privileges; both take the identical branch) and confirmed safe first: the live tree has 274
   regular files and **zero** non-regular entries, so `-type f` and `! -type d` agree on a
   clean tree. A symlink *replacing* a listed file was never the gap — step 2 follows it and
   hashes the target.
2. **`git log … | head -n 25` can abort the caller.** `head` closes the pipe, git dies of
   SIGPIPE (141), and under `set -o pipefail` that is the pipeline's status — `set -e` then
   kills the script. Verified locally: a truncated pipeline returns **141** and the statement
   after it never runs. It needs ~900 commits to fill the 64 KB pipe buffer, so it would
   surface years from now on the one screen an operator reads before taking a security fix.
   Guarded with `|| true`. Both call sites are `||`-guarded today, which suppresses `set -e`
   inside the function — but that is the *caller's* property, not this function's, and the
   idiom appears ~106 times across the toolkit unguarded. The other `| head` here (`head -40`
   of the checker output) is bounded by the 274-file manifest, ≈22 KB, so it cannot fire; left
   alone rather than churned.
3. **A missing `vendor/` printed a clean bill of health.** The overlay list is *derived* by
   testing each patch file against `vendor/`, so an absent or empty vendored tree classifies
   every patch as an *addition* — the replaced set comes back empty and the cross-reference
   said "None of the changed files are replaced by `patches/`". A false "no conflict" on the
   screen an operator reads before taking an upstream security fix is worse than no screen.
   Now: zero replaced files is reported as **UNKNOWN**, pointing at Verify. The watched-extras
   report and the log file still run — the cross-reference is not an exit path.

Also checked and found correct, so left alone: `accio_build` has exactly **one** caller and it
goes through the gate; a missing `PINNED_SHA` fails closed (`want_man` empty → `fails=1`); the
`cut -c67-` offset is right for `sha256sum`'s `*`-prefixed binary-mode lines; `_acv_pin`'s
`^KEY=` anchor cannot confuse `UPSTREAM_SHA` with `UPSTREAM_SHA8`; the offline detector's
function list matches `acv_verify_vendor`'s actual call graph. **`patches/` is deliberately not
integrity-checked** — it is our own code, versioned in this repo; the manifest exists to prove
that what came from upstream is unchanged.

#### Verification done in this session (all local, all one-shot, nothing left running)

- `bash -n` on `052_lib_vendor.sh`, `052_lib_build.sh`, `052_grin_accio.sh`, `052_lib_gateway.sh`
- **39 assertions on integrity**, against a throwaway copy of the real 274-file tree — pristine
  passes; one changed byte, one added file, one added **non-regular** file, one removed file and a
  missing manifest each fail and name the file; a **tamper + regenerated manifest still fails**;
  quiet mode is exactly one line; the offline detector passes on the shipped chain and catches a
  planted fetcher in both spellings; overlay mapping splits 15 replaced / 1 added and every
  replaced path exists upstream; the licence copy is still byte-identical to upstream's `LICENSE`;
  a space-containing path parses whole
- **the build gate, end to end**: `accio_build` against a tampered tree returns 1, says why, and
  leaves `<outdir>`, `.stage` and `.new` non-existent — nothing staged
- **31 assertions on the upstream check**, against a **local `file://` fake upstream** so the
  network half is proved without contacting github: no-changes, 3-commits-ahead with the overlay
  conflict flagged and unpatched files *not* flagged, watched `LICENSE` reported and unchanged
  `nginx.conf` not, the report file carrying the full `--stat`, an unreachable pin (rc 1, loud),
  a dead remote (rc 1, clean), the scratch repo bare with no upstream file materialised, and a
  missing `vendor/` reported as **UNKNOWN** rather than as "no conflict"
- the live `web/052_accio/vendor/` re-verified clean afterwards; `git status` on `vendor/` and
  `PINNED_SHA` empty — the tests never wrote to the pinned tree
- `acv_pin_report` and `acv_verify_vendor` rendered against the real tree: 274 files / 7,517,960
  bytes / manifest `0c7c1b8d…`, matching `PINNED_SHA` exactly on all three

**Still owed to S6, by the first VPS session (S2):**

1. **Run key `5` → `1` Verify** on the box before the first build. It should report 274 files and
   the same manifest hash. If it does not, the transfer to the VPS corrupted the tree — find that
   out before nginx serves it, not after.
2. **Run key `5` → `2` Check upstream** once with real network. It has only ever seen a `file://`
   remote; this proves the real fetch, and the pin was already ~10 days old at S0, so expect a
   short list rather than "no changes". **Do not take an update before launch** — record it.
3. Confirm the report file lands in `/opt/grin/logs/` and that the scratch dir under `/tmp` is
   gone afterwards.

---

### S7 — Mainnet, SSL, onion, hub wiring — 2026-08-10 ✅ *(code; every acceptance run still owed)*

**Written:** `scripts/lib/052_lib_nginx.sh` (the web front — vhosts, certbot, Tor hidden
service, the standalone download route), `accio_build_standalone` + seven inlining phases in
`052_lib_build.sh`, a second front for `_acg_write_snippet` in `052_lib_gateway.sh`, real
`acc_install` / `acc_nginx` / `acc_standalone` / `acc_status` / `acc_uninstall` in
`052_grin_accio.sh` (**`_acc_stub` is deleted — there is no stub left in this product**), and
hub 05 key `2` switched to `run_sub "052_grin_accio.sh" || true`.

**Taken out of order for the fifth time, and for a reason worth stating once more:** the
packet map says S7 depends on S5 and is a VPS packet, and S2 — the *first* VPS packet — has
never run. But S7's work is authored against the vendored tree and the toolkit's own nginx
conventions, not against a running box, exactly like S3, S4b, S5 and S6 before it. The
alternative was to leave the product's last two menu stubs in place indefinitely while waiting
for a session with a VPS in it.

#### S2's authorable half is paid here, because S7 could not exist without it

S7's brief is "certbot vhost for mainnet". That presupposes a vhost writer, and the vhost
writer is **S2 step 2** (`scripts/lib/052_lib_nginx.sh`, in S2's own "Do" list). There is no
version of "add SSL and an onion" that does not first write the file they go in. So the lib is
written here in full, for both networks, and S2 is no longer a packet with deliverables at all
— **it is the acceptance session**, and its list is at the end of this entry.

#### Five decisions, each with the failure it avoids

1. **One header snippet, included by every block that adds a header of its own.**
   `/etc/nginx/snippets/accio-<net>-headers.conf` carries X-Frame-Options,
   X-Content-Type-Options, Referrer-Policy, COOP/COEP, CSP and Permissions-Policy. It carries
   **neither** `Cache-Control`, HSTS **nor** `Onion-Location`, and that omission is the design:
   those three differ per block or per front, so each block sets its own after including the
   shared set. This is the only structure that survives Liability 1's trap #1 —
   `add_header` in a child block *discards* the parent's set rather than merging with it, so
   the static-asset location (which must set `immutable`) and the standalone download location
   (which must set `Content-Disposition`) would otherwise each serve a wallet page with **no
   CSP at all**, silently and with nothing in the response but their absence.
   - **CSP is upstream's, verbatim**, `'unsafe-eval'` and `connect-src *` included. Each loose
     directive is load-bearing: `'unsafe-eval'` is how the WASM crypto instantiates,
     `'unsafe-inline'` is what the build's inlining produces, and `connect-src *` is the
     visitor pointing the wallet at their own node — the one thing a self-custodial wallet is
     for. Tightening it is an S8 question to answer with the wallet in front of you.
   - **HSTS drops `includeSubDomains` and `preload`**, unlike upstream. Upstream owns its whole
     apex; this toolkit does not — the same box routinely serves `api.`, `testapi.`, `scan.`
     and a pool vhost, and an operator deploying Accio at an apex would be forcing HTTPS onto
     every sibling host that exists now or ever will, from one wallet's vhost.
   - `more_clear_headers Server` still has no stock equivalent. `server_tokens off` is as far
     as nginx goes, and that is accepted rather than worked around.

2. **The onion front needs its own gateway snippet, not a second include of the first.**
   `_acg_write_snippet` now takes a front — `nginx` (127.0.0.1:$ACC_PORT) or `onion`
   (127.0.0.1:$ACC_TOR_PORT). Including the clearnet snippet from the onion vhost would send
   Tor traffic to the port whose forwarding headers the gateway *trusts*, which voids the
   entire reason the two ports exist (the gateway classifies by `socket.localPort`; a Tor
   client controls its own headers and could otherwise forge `X-Forwarded-For` and mint a
   fresh identity per request).
   - **The onion copy carries no `limit_req`, deliberately.** Every Tor visitor arrives from
     127.0.0.1, so `$binary_remote_addr` is a single key for all of them: a zone that *looks*
     per-client is one global bucket, and the first busy visitor 503s everyone else. The
     gateway already meters that front on purpose (`onion_rate_per_second`,
     `onion_inbound_rate_per_second`) — the same global limit, applied knowingly, with an
     error that explains itself instead of one that blames nginx.
   - `acg_nginx_glue` writes both snippets unconditionally, even with no hidden service
     configured. It costs one file, nothing includes it until the onion vhost exists, and the
     alternative — writing it only once Tor is up — means an operator who enables the onion
     first gets a `.onion` that serves the static page and 404s every gateway route.
   - `acg_uninstall_gateway` now sweeps **both** vhosts for a dangling include. Leaving the
     onion vhost pointing at a deleted snippet is the same box-wide outage as leaving the
     clearnet one, by a different file name.

3. **Minting the onion is not the end of the job — the site must be rebuilt.**
   `TOR_SERVER_ADDRESS` is baked in at *build* time; it is what the wallet's "Onion Service"
   address type hands out. An onion that exists but was never built in therefore advertises a
   **clearnet** host to the visitor who specifically chose the onion. So: `acn_onion_enable`
   and the certificate step both call `_acn_offer_rebuild`, which states plainly what is stale
   and warns loudly if the rebuild is declined; `acn_status` and `acc_status` compare
   `site.BUILD_INFO`'s recorded onion against the configured one and flag a mismatch. Disabling
   the onion runs the same path in reverse, and drops `Onion-Location` from the clearnet vhost
   — advertising an onion that no longer answers sends every Tor Browser visitor to a dead
   address.

4. **Location order is load-bearing, and the naive install gets it wrong.**
   nginx tries regex locations in source order. The static-asset location
   (`~* \.(?:js|css|json|wasm|…)$`) is unanchored, so it can match a `/tor/` destination path
   and answer it as a missing file. The vhost writer therefore emits the gateway include
   *first* — but on a first deploy the snippet does not exist yet (the gateway is installed
   after the web front), so `acg_nginx_glue` appends its own include at the **end** of the
   server block, i.e. after the asset location. Fixed with `acn_refresh_vhost`: a
   prompt-free regeneration from config that both `acc_install` (after the glue) and
   `acg_nginx_glue` itself (when the lib is loadable) call, which rewrites the file wholesale
   so the appended copy disappears and the correctly placed one takes over.
   Impact if it were left: no *legitimate* request is affected (the gateway's own path pattern
   is `^(?:/.+)?/v2/foreign$`, which never ends in an asset extension, and `location = /listen`
   is an exact match that beats every regex), so this is a wrong error code rather than a hole
   — but the invariant is documented in three files and code that violates it is how the next
   person learns the wrong lesson.

5. **The standalone artefact is served as a download, not as a page.** It is made of `data:`
   URIs, which this site's own CSP forbids; rendered in place it would half-load and look
   broken. `location = /standalone.html` aliases `$ACC_DIR/standalone/current.html` and sets
   `Content-Disposition: attachment`. `current.html` is a **copy, not a symlink** — nginx can
   be configured with `disable_symlinks on`, and a download that 403s on some boxes and not
   others is worse than 10 MB of disk.

#### The standalone builder: a loop, where upstream has 253 `sed` commands

The spec is `vendor/upstream-standalone-build/build.sh` lines 39–311 — 273 lines, **253 of them
machine-generated `sed -i`**, each naming one file path and one HTML attribute verbatim.
Transcribing it would have produced a build that silently stops inlining an asset the moment a
path changes — and **our own overlay already changes several**: S5 replaced the whole raster
icon set with one SVG, so a large part of build.sh's image list does not exist in our tree at
all. Every phase therefore *discovers* its asset list from the rendered files; upstream's list
was used only as proof that the phases are the right ones.

Seven phases, and the order is not free:

| | Phase | Discovered from |
|---|---|---|
| A | strip the head links that only make sense on a served site | 7 line patterns (markup, not assets) |
| B | images → `data:` URIs in `index.html` | `(src\|href)="\./…"` |
| C | shaders / model / WASM → `data:` URIs in the `.js` that loads them | `"." + getResource(…)` |
| D | fonts → `data:` URIs in the rendered `.css` | `url("…")`, resolved per stylesheet |
| E | the workers' `importScripts()` → the imported file's text | `importScripts("…");` |
| F | workers → `<script type="javascript/worker">` + a Blob URL rewrite | `scripts/*_worker.js` |
| G+H | stylesheets and scripts → `<style>` / `<script>` in the page | `<link href>` / `<script src>` |

- **C/D/E must precede F/G/H**: once a `.js` or `.css` has been folded into the page it is no
  longer a file anything can substitute into. **F must precede H**, because F rewrites the very
  scripts (`slate.js`, `output.js`, `camera.js`) that H then inlines.
- **Phase F is the one piece of upstream cleverness worth carrying verbatim.** A `Worker` needs
  a URL and a standalone page has none, so the worker's source is parked in the page as
  `<script id="slate_worker" type="javascript/worker">` — a type no browser executes — and
  `Slate.WORKER_FILE_LOCATION` is rewritten to
  `URL.createObjectURL(new Blob([…textContent], {"type": "application/javascript"}))`. Ours
  derives the triple (`<name>_worker.js` → `<name>.js` → class `<Name>`) and **verifies the
  constant exists before rewriting anything**, skipping with a warning rather than half-
  processing a worker it cannot place.
- **Phase C resolves both reference forms.** `getResource("./scripts/X.wasm")` is a literal;
  `getResource(Logo.MODEL_FILE_LOCATION)` is a class constant whose `static get` returns the
  path, and the getter is looked up across *every* script because nothing guarantees it lives
  in the file that calls it.
- **Every substitution is applied from a sed SCRIPT FILE, never an argv expression.** The
  secp256k1 WASM is ~2 MB, its base64 ~2.7 MB, and a single sed argument that size is at or
  over `ARG_MAX`. Upstream hit exactly this and had to convert two of its own substitutions to
  a here-doc; a script file sidesteps it for all of them. Base64 contains no `#`, `&` or `\`,
  so `s#…#…#` is safe by construction.
- **The env contract is the only difference from a hosted build.** `_acb_render_one` now
  branches on `_ACB_STANDALONE`: hosted runs `env -u NO_FILE_VERSIONS -u NO_FILE_CHECKSUMS -u
  NO_MINIFIED_FILES` (absent = features ON, S1 fact 1), standalone sets all three (present =
  OFF). Versions and SRI are meaningless once nothing is fetched, and leaving SRI on would have
  the browser check a hash against bytes it no longer loads.
- **Same gates as the hosted build, and they matter more here**: `acv_verify_vendor` must pass
  before a single file is staged. This artefact is handed to someone to run *offline*, where
  nothing will ever re-check it and no security update can reach it.
- Post-conditions: no `<?php` anywhere in the output, and a **warning** (never a failure) with
  the count of relative references left behind — upstream's own artefact leaves a handful, for
  features that do not work offline anyway, so a hard failure would be wrong. The count is
  printed so a jump in it gets noticed.
- Output: `$ACC_DIR/standalone/accio-wallet-<net>-v<upstream version>.html` plus a `.sha256`,
  and a `current.html` copy for the download route. The name is ours (naming policy layer 1) —
  nothing about a file an operator hands out should say MWC.

#### Three defects found by rendering the vhosts offline, before shipping them

The vhost writers were run against a scratch directory with stubbed path functions, and the
output read. All three would have failed `nginx -t` — which on this box does not mean "Accio is
misconfigured", it means **nginx does not start and every other vhost goes with it**.

1. **A backtick inside an unquoted heredoc comment.** The generated config is built with
   `cat > "$vhost" << SSLCONF` (unquoted, because it interpolates `$domain`), so the shell
   reads the body — *comments included*. A comment reading ``No `includeSubDomains`, unlike
   upstream`` ran `includeSubDomains` as a command and the word **vanished from the generated
   file**. Harmless only by luck: a backticked word that happened to name a real command would
   have injected its output into an nginx config. Both writers are now backtick-free and the
   rule is stated at the top of the lib alongside the `\$host` escaping rule.
2. **`http2 on;` is an unknown directive below nginx 1.25.1.** Debian 12 ships 1.22. The
   directive was split out of `listen` in 1.25.1 and the old `listen 443 ssl http2` form warns
   (but works) above it — so neither spelling is universal. `_acn_http2_listen` asks the binary
   and emits the form it understands.
3. **`filename=\"…\"` in `Content-Disposition` reached nginx as three arguments.** In an
   unquoted heredoc `\"` collapses to `"`, so nginx saw `"attachment; filename="`,
   `accio-wallet-test.html`, `""`. nginx does support `\"` inside a quoted string, but getting
   it through takes three backslashes and one wrong one is a config that will not load. RFC
   6266 allows a bare token and this filename has no spaces, so the quotes were dropped.

Also settled while writing the vhosts: no `/.well-known/acme-challenge/` webroot location.
`certbot --nginx` inserts its own for the duration of a challenge, and a webroot rooted at the
site directory would be a trap — **every build replaces that directory by an atomic rename**,
so a challenge file could be swapped out from under certbot between the write and the fetch.

#### Hub 05 wiring, and why it was safe to do now

The `_slot_notice` arm for key `2` is **deleted, not aliased** — a key that changed hands never
keeps an alias (CLAUDE.md: a second `case` arm is dead code, and if reached would open the
wrong product with no error). Key `2` is now `run_sub "052_grin_accio.sh" || true`.

The stated reason for deferring the wiring was that *wiring a menu of stubs advertises a product
that cannot do anything*. That condition is now gone: every key does what it names. What has
**not** changed is that nothing has run on a VPS, so three places say so plainly — the 052
banner, the network submenu, and hub 05's own header. A menu with no stubs is not a tested one.

Hub 05 also gained `_052_installed` / `_052_status` and a status row, keyed on
`grin_accio.conf` rather than on the gateway unit: the site can be deployed and serving with
the gateway not yet installed, and a row calling that "not installed" would hide the exact
thing an operator is looking for.

#### Verified locally (nothing was run against a VPS, and nothing was left running)

- `bash -n` on all six touched shell files.
- The three vhost writers plus the header snippet **rendered to a scratch directory** and read
  line by line — this is what found the three defects above. Re-rendered after each fix; the
  final output has no stray command substitution and no unintended `$` expansion (only the
  intended `\$host`, `\$uri`, `\$request_uri` survive).
- `_acn_http2_listen` exercised on a box with no nginx: it falls through to the pre-1.25 form
  rather than emitting nothing.
- No server, watcher or background process was started at any point.

#### Still owed to S7, by the acceptance session (S2)

1. `nginx -t` clean after the deploy, and **every other vhost on the box still answering** —
   that is the check that matters, not Accio's own.
2. A real **mainnet** GRIN send and receive, *after* the same round trip has passed on testnet.
3. The certificate issues, the site loads over HTTPS, and the security headers are actually
   present **on an asset response and on `/standalone.html`**, not just on `/`. Those are the
   two locations that set their own `add_header`, so they are where trap #1 would show.
4. The onion: `cat /var/lib/tor/grin-accio-<net>/hostname` publishes, the page loads over it,
   a send and a receive work through the onion front, and the wallet's "Onion Service" address
   type hands out **the onion**, not the clearnet host (that is the rebuild in decision 3).
5. The standalone artefact: it builds, `/standalone.html` downloads it, and the saved file
   **opens from `file://` with the network off** and can build and sign a payment. Check the
   leftover-reference warning count while you are there.
6. Hub 05 key `2` opens Accio, and the other keys still open what they always did.

---

### S7 review pass — 2026-08-10 ✅ *(four defects found and fixed, same day)*

A read-back review of everything S7 wrote, checking the generated artefacts against the real
vendored markup rather than against the intent. One defect was silent-and-serious; three were
smaller. All four are fixed, and both harnesses are one-shot (no server was started).

#### 1. The worker phase never fired — `[^>]*` cannot cross the tag's own `>` *(fixed)*

`_acb_sa_inline_workers` step 1 inserts the `<script id="X_worker" type="javascript/worker">`
block immediately before the owner's `<script>` tag. Upstream's address is

```
/--><script .*"\.\/scripts\/slate\.js".*><!--/
```

and S7 "tightened" both `.*` to `[^>]*`. The rendered tag line is

```
	--><script src="./scripts/slate.js" integrity="…" … defer="true"></script><!--
```

so the text between the `src` attribute and the trailing `><!--` **contains the `>` that closes
the opening tag**. `[^>]*` cannot cross it, so the address matched nothing — and **sed exits 0
on an address that never fires.** Step 3 then still rewrote `Slate.WORKER_FILE_LOCATION` into
`document.getElementById("slate_worker")`, so the artefact would have shipped, reported
`inlined 3 web worker(s)`, and thrown on `null["textContent"]` the first time a user built a
slate — i.e. the standalone artefact's *only* remaining capability, sending, was dead.

Reverted to upstream's `.*` for that one address (step 2's `[^>]*` is correct and kept — that
line is one we write ourselves and has no `>` inside an attribute). More importantly, a
**guard** now sits between step 1 and steps 2–3: if the id is not in the page afterwards, the
worker is reported and skipped, and the constant is left alone. Step 3 is the irreversible
half; it must never run for a block that was not inserted.

**The lesson is the reusable part:** tightening a vendored regex is a change to the contract
with upstream's markup, and the failure mode is silence, not an error. Verify against the
rendered file, and make the phase prove it fired.

#### 2. The TLS vhost contradicted its own ACME reasoning *(fixed)*

The HTTP bootstrap deliberately carries no `/.well-known/acme-challenge/` location, with a
comment explaining why: every build replaces the site directory by an atomic rename, so a
challenge file can be swapped out from under certbot between the write and the fetch. The TLS
vhost's port-80 block then had exactly that location. Removed. Renewal does not need it —
certbot renews with the authenticator recorded at issue time (`--nginx`), which inserts its own
exact-match location for the life of the challenge.

#### 3. Static assets carried `Cache-Control` twice *(fixed)*

`expires 2y;` emits a `Cache-Control: max-age=…` of its own, and the block also set
`add_header Cache-Control "public, no-transform, immutable"`. nginx does not merge them, so the
response carried the header twice. Legal, and browsers combine them — but read differently by
intermediaries, and not what a reviewer of this file would expect. `expires` is gone; the
max-age is written into the single `add_header`.

#### 4. Re-deploying took HTTPS down for the duration *(fixed)*

`acn_deploy_web` wrote the HTTP-only bootstrap **unconditionally**, then certbot, then the TLS
vhost. The bootstrap has no `listen 443` at all, so on every re-run — and this action is re-run
to pick up a new onion, a moved gateway or a header change — HTTPS was down between the two
reloads. The stated justification was reaching the ACME webroot, which defect 2 has just
established should not exist. The bootstrap is now written **only when there is no certificate
yet**; with one present the live vhost stays up until the new one has passed `nginx -t`.

#### What the review checked and found correct

- **Phases A–H end to end**, against a synthetic tree shaped like the rendered page (tab +
  `--> … <!--` wrappers, real getter shape, `importScripts("../scripts/…")`): 23 assertions,
  all passing after fix 1, including that phase F's block lands *before* the owner script H
  inlines. `importScripts` uses `../scripts/`, not `./scripts/` — the `basename` lookup is why
  that works. Dependency order survives because the `r`/`d` pairs are address-matched, so the
  original order of the import lines is preserved regardless of the sorted script order.
- **The env contract**, at the source: `NO_FILE_VERSIONS`/`NO_FILE_CHECKSUMS`/`NO_MINIFIED_FILES`
  are tested against **`$_SERVER`** (`backend/resources.php:1758-1787`), which PHP-CLI populates
  from the environment — so `env -u` really does mean "on". Confirmed `getResource()` drops the
  `?version` suffix only when the var is present, which is what lets phases G/H match a bare
  `src="./scripts/x.js"`. Also confirmed the tree ships **zero** `.min.js` files and has
  `"Minified" => TRUE` nowhere, so minification is inert in both builds.
- **No root-relative asset references.** Upstream's `build.sh` inlines `href="/favicon.ico"`,
  which the discovery pattern (`(src|href)="\./…"`) would miss. This version of the page has no
  such reference — the only non-`./` href in `index.html` is a `purl.org` metadata URL.
- **The uninstall sweep's `sed -E "\|…|d"`** — using `|` as the address delimiter under ERE,
  where `|` is also alternation. Tested: GNU sed treats the delimiter as a delimiter and
  `(-onion)?` still works. Both vhosts are swept.
- **The vhosts, re-rendered offline after every fix.** Comment-stripped, the TLS vhost has
  exactly one HSTS (no `includeSubDomains`), one `Onion-Location`, one `try_files`, no ACME
  location and no `expires`; the onion vhost has no HSTS, no `Onion-Location` and listens on
  `127.0.0.1:$ACC_TOR_PORT` only. The header snippet is included in all three `add_header`
  blocks of each vhost. Backticks appear **only** in the header snippet's comments, which is
  the one heredoc that is quoted (`<< 'HDRS'`) — the ban applies to the unquoted vhost
  heredocs, and it holds there.
- **Hub 05**: key `2` dispatches `|| true`, no `_slot_notice` arm survives for it, and
  `_052_installed`/`_052_status` key on the conf and the two gateway units respectively.

None of this changes what is still owed: the six acceptance runs above are untouched by this
review, because every one of them needs a VPS.

---

### S4b review pass — 2026-08-11 ✅ *(six defects found and fixed; still no VPS run)*

A read-back review of everything S4b wrote, asked for as "is the logic/flow/syntax correct".
Every finding below was **reproduced before it was fixed** and re-run after — a plausible
reading of the code is not evidence, and four of these six looked fine on the page. Nothing
was run on a VPS; all harnesses are one-shot and every process was killed in-session.

Syntax was never the problem: `node --check` passes on all nine modules and `bash -n` on all
three 052 shell files, before and after. The defects are all in behaviour under conditions the
original assertions did not construct.

#### 1. A frame pipelined into the upgrade's `head` was parsed before anyone could listen *(fixed)*

`WsConnection`'s constructor ended with `if (head && head.length) this._onData(head);`. `head`
is whatever arrived in the same TCP packet as the upgrade request, and a client is entitled to
put complete frames there — an attacker certainly will. The parse therefore ran **inside the
constructor**, i.e. before `handshake()` had returned and before `_register()` could attach a
single listener. Two different failures, both silent:

- A **valid** first message was emitted into the void. The client's opening message on a
  reconnect is `Own URL` for every suffix it holds, so the wallet would sit through its 120 s
  timeout and then discard a perfectly good address and mint a new one — the exact
  address-rotation this packet exists to prevent, reachable without any restart.
- A **bad** first frame called `_fail()`, whose `emit('error')` on an emitter with no `'error'`
  listener **throws**. It came out of `handshake()` *after* the 101 was already on the wire, so
  `handleUpgrade`'s catch would then write an HTTP error response into a stream that had
  stopped being HTTP one line earlier.

`head` is now buffered by the constructor and parsed on `process.nextTick`, which still runs
ahead of every socket I/O callback, so no reordering against real inbound data is possible.

#### 2. `emit('error')` with no listener was a remote kill switch *(fixed)*

Following #1 to its root: three places emitted `'error'` directly, and an EventEmitter `'error'`
with no listener is a `throw`, not a log line. The gateway is a **single process serving every
wallet**, and server.js already argues this case for the request path ("an uncaught throw out of
a request listener kills the process… and systemd would restart it straight into the next
one"). The socket path had no such protection. One malformed frame from any peer would drop
every other tab's socket, and the restart storm is self-sustaining because the attacker's next
frame arrives on the next boot.

All three now go through `_emitError()`, which checks `listenerCount('error')` first. Nothing is
lost: `'close'` always follows and always carries the reason.

#### 3. `mint()` accepted a session that no longer existed *(fixed)*

The sweep is time-based, not connection-based, so a session can expire **underneath a socket
that is still open**. The client then gets `Own URL → false`, discards its suffix and calls
`Create URL` — and `mint()` happily wrote a row keyed to a session id with no session behind
it. That address then *works*: it is in the live map, it is displayed, it receives. Until the
next restart, because `_load()` drops any suffix whose session did not survive. A wallet would
show an address that had been receiving payments all week and start answering 404 after a
routine deploy, with nothing on either side to explain it.

`mint()` now refuses an unknown session outright. `_onRequest` closes the socket instead, so the
client's ladder reconnects within 250 ms onto a fresh session and cookie — the only state from
which anything it asks for can be honoured.

#### 4. A live tab's session could lapse while it watched *(fixed)*

The same root cause from the other side. Only the *handshake* refreshed the rolling ttl, so a
tab that stayed connected — which is the normal state; the ping loop exists precisely to keep it
that way — never touched its own session. A socket alive across the ttl would have its address
swept out from under it. `_onRequest` now touches the session on every request: a tab that is
talking to us is active by definition.

#### 5. An over-rate request was dropped in silence, contradicting its own comment *(fixed)*

`_onMessage` began `if (!this._takeToken(state)) return;` — before the parse, so there was no
`Index` left to answer with. The comment three lines above the constant said the opposite
("over-rate requests are answered with an Error rather than dropped, because silence costs the
client a 120 s stall"), and §11.9 says the same. The code was written first and the rule was
written after.

The parse now runs first and the bucket second, so a refused request still gets
`{"Index":n,"Error":"rate limit exceeded"}`. This is affordable because ws.js has already
size-capped the frame, and the reply is 1:1 with the frame refused — never an amplifier. It also
gives `RATE_VIOLATIONS_BEFORE_CLOSE` something real to count.

#### 6. `destroy()` threw away the close frame written one line earlier *(fixed)*

`_teardown` wrote a close frame and then called `socket.destroy()`, which discards whatever is
still queued. Every deliberate close code — `1002` protocol violation, "no pong", "gateway
restarting" — reached the client as an unexplained reset. Harmless to correctness and awful for
diagnosis, which is the half of this that matters on a box we cannot attach a debugger to.
`end()` first, destroy on a 250 ms unref'd timer so the fd is released regardless.

Two smaller ones fixed in passing: the interaction-id wrap checked the id **after** handing it
out (so the unsafe value would be used exactly once), and a snapshot with an unknown `version`
started empty and let the next flush **overwrite** it — the corrupt path already moved the file
aside, and a version bump destroys exactly the file a migration would need.

#### 7. A green test suite was hiding a wrong assertion *(test fixed)*

Re-running the suite on the finished code turned up **95/1**, not the 96/0 the first pass
recorded — so that number was reported from a stale run and should not have been trusted. The
failure was in the test, not the product: `the global cap refuses once the table is full` minted
three addresses, verified **none** of them, and then asserted `mint()` throws. Three unverified
addresses are three reclaimable orphans, so `mint()` correctly evicted the oldest and succeeded.

The global cap has the same two branches as the per-session cap, which is tested properly
twelve lines above it (`evicts the oldest UNVERIFIED` / `a verified suffix is never evicted;
refuses instead`). The global one was written as a single test asserting one branch while
constructing the other. Split into two, and both pass — 97 total.

The lesson is about the number, not the test: *"96 passed"* was quoted as evidence in the same
session that a test in it was asserting a behaviour the code deliberately does not have. A suite
is evidence only for the run you actually watched.

#### 8. ⚠ OPEN — a live tab's address can be reclaimed from under it *(not fixed; needs a design call)*

Fixing the test above made the real gap visible, and the new test demonstrates it directly:
session `b`'s mint reclaims session `a`'s address. `verified` is set **only** by `Own URL`, and
`_createUrl` does not set it — so an address stays unverified from the moment it is minted until
the tab *reconnects*, which for a socket held open by the ping loop may be days. For that whole
window `_evictGlobalOldestUnverified` may reclaim it: the tab keeps displaying an address the
store no longer knows, inbound payments to it answer 404, and the tab is never told, because
`Own URL` is only re-sent on reconnect.

It only fires when the global table is full, which `mint()` already documents as a degraded mode
whose real lever is the nginx rate zones — but "degraded" here means *silently wrong receiving
address*, which is the exact failure this packet exists to prevent. The fix is not a one-liner:
it needs a third state between unverified and verified — *held by a live socket* — which the hub
already knows (`state.owned`) and the store does not. **Do not patch this during acceptance.**
It belongs to S8's open list alongside the other six.

**Verify — all green**

- `node --check` on all nine modules; `bash -n` on `052_lib_gateway.sh`, `052_lib_build.sh`,
  `052_grin_accio.sh`
- a repro harness that reproduced findings 1, 3 and 4 before the fix and passes after
- the S4b assertions re-run — **97 pass, 0 fail**, no regression from any of the six fixes,
  including the FIN/RST slot-freeing timings that the `end()` change touches. One of the
  original 96 was **itself wrong** and is corrected here; see finding 7 below.
- four new end-to-end checks against the **real `server.js`**: a `Create URL` pipelined into the
  upgrade packet is answered; six requests over a 1/s bucket all come back with their `Index`
  echoed exactly once and at least one `rate limit exceeded` Error; an unmasked frame closes
  with **1002 and the code reaches the client**; and the gateway is still alive afterwards with
  `listen_open` back to 0 and state durable
- every test process exited in-session; nothing bound anywhere but `127.0.0.1`

**What this does not change:** the packet still owes its four VPS runs to S2 unchanged — the
16-probe self-test, the nginx-glue regeneration on a box that already has S3's zone file, a real
tGRIN payment from Fidelius into a browser wallet with the address unchanged across a restart,
and the stock-nginx confirmation. Six fixed defects in code that has never run on a box is a
reason to trust the acceptance session less, not more.

---

### S8 — Security audit — 2026-08-11 ✅ *(audit written; 8 findings fixed, 6 open)*

**Deliverable: [script052_security_audit.md](script052_security_audit.md).** Scope was the
gateway, the four libs, the nginx artefacts they generate, the unit, and the pin chain — not the
vendored wallet, which stays explicitly unaudited for the reasons the design already records.

Method was a read of the code plus **47 offline assertions** driving the real `guard.js`,
`store.js`, `listen_route.js`, `wallet_route.js` and `config.js`, plus an offline render of all
three nginx artefacts read block by block. No server was started, nothing ran against a VPS, and
nothing was left running.

#### The finding that mattered

**Inbound payments were routed by SESSION, not by ADDRESS.** `deliver()` picked the most
recently opened socket in the owning session, which is not the same question the cookie answers:
a cookie proves which session a tab is in, never which address it holds. Anyone who obtained the
cookie could open a `/listen` socket, send no protocol message at all, and be handed the next
inbound slate for an address they had never seen — their wallet answers it with their own
output, the payer's send succeeds, and neither UI shows anything wrong. Not knowing the suffix
was no obstacle, which is why 80 bits of entropy did not help.

Delivery is now routed to a socket that has **claimed that specific suffix** (minted it here, or
confirmed it here with `Own URL`). A fallback to the old rule survives for the window before a
reconnecting client has claimed anything — **delete it once S2 has watched a real client claim
its addresses**, and not before. Tightening a protocol contract on the strength of reading the
spec is exactly how S7's worker phase became a silent no-op.

#### The other seven fixes

`store.js` had **no bound on the session table at all** — a handshake mints a session before the
client asks for anything, nothing capped it, nothing evicted it, and `flush()` re-serialised the
whole table every 2 s, so a handshake flood was a memory leak and a disk amplifier at one
WebSocket each. Empty sessions are now never persisted, `createSession()` is capped and evicts
empties first (never a session that owns an address), `sweep()` drops unclaimed sessions after an
hour, and a full address table evicts the oldest *unverified* suffix and says so loudly instead
of silently refusing every new wallet an address. Two new config keys: `max_sessions`,
`empty_session_ttl_ms`.

`max_inbound_in_flight` was checked **after** `readBody` had buffered a whole megabyte, so it
capped relays and not memory — reads and parked interactions now share one budget, reserved
before the read. The SSRF guard's private-address rule only recognised **dotted-quad** IPv4, so
`2130706433`, `127.1` and `0x7f000001` walked past it whenever clearnet was enabled; it is now a
shape rule (at least one dot, final label starts with a letter) that covers every notation at
once. Two clearnet locations included the header snippet and still answered with **no HSTS**,
because HSTS is deliberately not in the snippet — the same trap this file warns about, one level
in. Over-rate WebSocket messages were dropped in silence while the comment beside them promised
an `Error`. The unit gained `IPAddressDeny=any` + `IPAddressAllow=localhost`, which turns the
whole SSRF story from "our regex is right" into "the kernel will not carry the packet", plus
`MemoryMax`. The CSP gained the four directives that do not fall back to `default-src`.

#### The CSP question the design deferred to S8, answered against the source

`'unsafe-inline'` in script-src is **required** — `index.html` carries 144 inline event handlers.
`connect-src *` is **required** — the visitor picks their own node. `'unsafe-eval'` is the one
genuine narrowing available: there is **no `eval()` and no `Function("…")` anywhere in the
tree**, and the only caller is `WebAssembly.instantiate`, which is what `'wasm-unsafe-eval'`
exists for. That token is now listed **alongside** `'unsafe-eval'`, not instead of it, so
dropping the wider one is a one-word edit — do that once S2 has watched the wallet boot and sign
without it. And the honest summary: with `'unsafe-inline'` and `connect-src *` both structurally
required, this CSP is **not** XSS containment for this app and must not be described as one.

#### Left open, deliberately

Two accepted trade-offs (`allow_null_origin` makes `/tor/` an open proxy to onion Foreign APIs —
the standalone build needs it; and repeated inbound requests to a known address cannot be bounded
cheaply). Two inherent ones (the 404-vs-503 presence oracle; no runtime integrity on the WASM,
which SRI could not fix anyway for same-origin files). **Two that are new work and should be
built:** `patches/` is applied over the pinned tree and is itself outside the pin, and the
deployed site is never re-verified against the build manifest — the second is the attack that
matters most for a self-custodial wallet, since whatever `$ACC_SITE_DIR` serves is what signs a
visitor's transactions.

#### Still owed to S2, added by this packet

Six items, listed at the end of the audit: watch a real client claim its addresses (then delete
A-1's fallback); `curl -I` the headers on `/`, on an asset and on `/standalone.html`; confirm the
tightened CSP boots the wallet, then drop `'unsafe-eval'` and confirm again; confirm
`IPAddressDeny` did not break `/tor/`; confirm the address table survives a restart on the box;
and probe `/tor/` against a hostile onion of your own that answers with `Set-Cookie`, a
`Location` and its own CSP.

**Eight fixed defects in code that has still never run on a box is a reason to trust the
acceptance session more, not to shorten it.**

---

### S9 pass 1 — MQS — 2026-08-11 ✅ *(code; the rebuild and the two acceptance runs are still owed)*

**Deliverable: one new overlay file, `patches/public_html/scripts/mqs.js`.** Upstream's is 1,361
lines / 38,479 bytes; ours is 105 / 4,161. Nothing else in the repo changed — the overlay
machinery S5 built handles a new patch file on its own, including the SRI refresh.

#### The gate this pass does not satisfy, stated first

The design says **"Do not start S9 until S7 is green."** S7 is not green: nothing in Accio has
run on a VPS, and the two runs this pass is supposed to end with (the S2 send, the S4b receive)
cannot be performed. This was done anyway, on the same terms as S3/S4b/S5/S7 — authored against
the vendored tree, verified offline, revertable with one `git rm` — and the acceptance runs are
added to S2's list, not waived. A reader deciding whether to trust this pass should weigh it as
*argued and statically verified*, not as *tested*.

#### What MQS is, and why it was first on the list

MQS is MimbleWimble Coin's "message queue service" — a slate transport. `Mqs.sendRequest` opens a
**WebSocket to a host named inside the recipient string**, subscribes to a queue keyed by a
secp256k1 address, signs a challenge the server issues, and exchanges PBKDF2 + AES-GCM payloads.
Accio receives over Tor and the gateway. None of that is ours to run, and an unreachable network
client that dials an attacker-chosen host is exactly the sort of thing a self-custodial wallet
should not be carrying around.

#### Why this is a reduction and not an `rm`, and why that is not a cop-out

The design's order — "MQS then 3D logo/Tetris then non-Grin fonts (**all free**)" — is right
about two of the three. MQS is not free, and the reason is worth recording because it will recur.

**Five symbols of the class are referenced from outside it, 36 times, across five files we do not
patch:** `api.js` (17,419 lines), `slate.js` (6,763), `hardware_wallet.js` (8,501),
`wallet.js` (4,226), `send_payment_section.js` (3,537) — 40,446 lines, 1.65 MB. Overlaying those
to remove the references would turn every future `git log <PIN>..upstream` review into a manual
merge — the precise cost S5 spent its packet avoiding.

The references are **not** evenly spread, and the shape matters: `ADDRESS_LENGTH` alone accounts
for 16 of the 36, and 8 of those 16 are in `slate.js`.

Worse, one of the references is on the money path. `Slate.compactProofAddress` switches on
`Mqs.ADDRESS_LENGTH` and is **not** wallet-type-gated: it runs on every payment-proof slate we
*encode*. Delete the file and that becomes `ReferenceError: Mqs is not defined` on every send
with a payment proof. A "free" cleanup that breaks sending is not a cleanup.

So the external surface stays and everything behind it goes:

| Kept (the 5 external symbols) | Deleted |
|---|---|
| `ADDRESS_LENGTH` → 52 | `sendRequest` — the WebSocket client, subscription protocol, challenge signing, reconnect loop |
| `publicKeyToMqsAddress` → throws | `encrypt` / `decrypt` — PBKDF2-derived AES-GCM |
| `mqsAddressToPublicKey` → throws | `getAddressVersion` — the MWC/EPIC version bytes |
| `isValidAddressWithHost` → `false` | 21 of the 22 static getters — every constant only the above used |
| `sendRequest` → rejects | |

#### Why it changes no behaviour — provably, not by inspection

`Consensus.getWalletType()` returns Grin unconditionally (S5's `consensus.js`), and upstream's
MQS is **already dead in Grin mode**:

- `getAddressVersion()` has `case` arms for MWC and EPIC **only**, so it returns `undefined` for
  Grin. Both codecs then fault on `version["length"]` before they can produce or accept an
  address. They could only ever throw. They now throw upstream's own error strings
  (`"Invalid MQS address."`, `"Invalid public key."`) instead of a `TypeError`.

  That last difference is real and worth stating precisely rather than waving away. Most call
  sites `try`/`catch` and convert to a fixed message (`"Unsupported slate."`, `"Unsupported
  response from the recipient."`) or sit in a promise chain that rejects. **Two do not:**
  `Slate.compactProofAddress` and `Slate.uncompactProofAddress` have no local handler, so the
  thrown value propagates. It still cannot change control flow — the string
  `"Invalid MQS address."` appears **nowhere** in the tree outside `mqs.js`, so nothing branches
  on it, and both upstream and the stub fail the same call. The only reachable difference is the
  text of an error on a slate that is rejected either way. **No new user-visible string was
  introduced.**
- `isValidAddressWithHost()` catches that fault and returns `false`. It could only ever return
  `false`.
- `sendRequest` has exactly **one** caller, in `api.js`, inside `case Consensus.EPIC_WALLET_TYPE`.
  All five of those switches set `sendAsMqs = false` by hand in their MWC/GRIN arms. It is
  unreachable, not merely unused.

#### What is deliberately kept, and why removing it would have been the real bug

`ADDRESS_LENGTH` is **wire format, not branding.** `slate.js` switches on a proof address's
*length* to decide how to parse it, and `Slate.uncompactProofAddress` reads a leading bit meaning
"this proof address is MQS". Drop the constant and a 52-character proof address stops being
rejected and starts falling into the **Tor** branch instead — a parsing change on the money path,
wearing a deletion's clothes. The rule this pass sets for every later one: *removing a subsystem
must not change how a slate is read, only what we do about one.*

#### Verify — all green (offline; nothing ran on a VPS, no PHP was executed)

- `node --check` on the stub.
- **Symbol-surface check:** every `Mqs.<symbol>` referenced anywhere outside `mqs.js` — computed
  from the tree, not from a list — is defined in the stub. Exactly five, no dangling reference.
- **15 behavioural-equivalence assertions** in two separate VM contexts, Grin-mode `Consensus`,
  faithful `mergeArrays`/`arraysAreEqual` copied from `common.js` and a Base58 stub that
  *succeeds*, so upstream is forced past its cheap rejections into its **real** failure (the
  undefined version) rather than an easier one. Upstream and the stub agree at every entry point:
  `ADDRESS_LENGTH === 52`; three `publicKeyToMqsAddress` cases both throw; four
  `mqsAddressToPublicKey` cases both throw; six `isValidAddressWithHost` cases (MQS-with-host,
  with-port, no-separator, Tor, empty, slatepack) both return `false`; `sendRequest` both reject.
- **End-to-end dry run of `_acb_apply_patches`** against the real vendored tree: **17** files
  applied, rc 0, and every refreshed checksum recomputed with `openssl dgst -sha512` and compared
  against the staged table — 14 entries, 0 mismatches, including the two the build deliberately
  leaves `NULL`. `./scripts/mqs.js` refreshed and bumped Version 21 → 22.
- **Dangling-reference sweep over the staged tree** (post-overlay, the bytes that would ship):
  none.
- Every local test process was one-shot (`node`, `bash`); nothing was left listening.

#### The residual table, moved honestly

The file's case-insensitive `mwc` hit count is **unchanged at 2** — but the composition is the
point, and it is the composition the S5 table measures:

| | before | after |
|---|---|---|
| Layer-3 (`Consensus.MWC_WALLET_TYPE` + upstream's `// MWC wallet` comment) | 2 | **0** |
| Our own `ACCIO PATCH` comment prose | 0 | 2 |

Tree-wide that is **195 → 193** layer-3 hits and **25 → 27** of our own comments — the two
buckets' total is unchanged at 220, which is what "the raw count does not move" actually means.
Measured over the simulated published tree (the S5 file set: no `*.php`, `backend/`, `languages/`
or `.user.ini`), comparing the 16-patch S5 baseline against this pass's 17:

| Metric | S5 baseline | S9 pass 1 |
|---|---|---|
| case-insensitive `mwc` hits | 303 | **303** |
| `MWC_WALLET_TYPE` occurrences | 87 | **86** |
| `ACCIO PATCH` markers | 24 | **25** |

Anyone using a bare grep count as the S9 progress meter would score this pass at zero, which is
why the design says not to. The number that moved is 34,328 bytes and 1,256 lines of unreachable
transport and crypto.

*(An earlier draft of this section said 195 → 194. That was wrong in a way worth recording: it
retired the identifier but forgot upstream's `// MWC wallet` comment on the line above it, while
still moving 2 hits into the comment bucket — which would have made the two buckets total 221
against a file whose own count provably did not change. Both hits went; both replacements are
ours.)*

#### Owed to S2 by this pass

Two runs, the ones the design names: **a send and a receive after a rebuild.** Specifically —
build the site, confirm `scripts/mqs.js` in the published tree is the stub and that the browser
does not report an SRI failure on it (the one failure mode a wrong checksum here produces is a
wallet that never boots), then send once and receive once. A payment **with a payment proof** is
the run that matters, because that is the path `Slate.compactProofAddress` is on.

#### Next passes, unchanged in order

**Pass 2 — the 3D logo / Tetris.** `models/mwc.json`, `shaders/logo.frag`, `shaders/logo.vert`,
`glMatrix`, `tetris.js`, `styles/tetris.css`, and the WebGL half of `logo.js` (already inert
since S5). These are leaf assets with no money-path reference, so this pass genuinely can delete
files — and it is where the **file-deletion machinery** has to be built: removing a file from the
stage, dropping its `$files` entry from `backend/resources.php`, and asserting that no staged
file still calls `getResource()` on a path that no longer exists. That machinery was deliberately
*not* built here, because this pass deletes no file and unused build machinery is worse than
none.

**Pass 3 — non-Grin fonts.** `fonts/btc`, `fonts/eth`, `fonts/epic`, `fonts/mwc` and the `.mwc`
rule in `styles/common.css`. S5 already stopped *fetching* the MWC glyph font; this removes the
files.

---

### R1 review — Entry script & menu — 2026-08-11 ✅ *(2 security findings, both fixed; 8 logic/doc fixes)*

**Packet:** R1 of §"Review plan". **File:** `scripts/052_grin_accio.sh` (722 lines — the plan's
table says 674, written before S7 finished it; corrected in that table). Read for call-site
contracts only, not reviewed: the four libs' function and path helpers.

**The one that matters: the entry script hand-rolls work the libraries already do.**
`acc_uninstall` does not call `acn_remove_web` or `acg_uninstall_gateway` — it re-implements both
from a hardcoded path list. Every path in that list is correct (checked one by one against
`_acn_vhost`/`_acn_link`/`_acn_headers`/`_acg_unit_path`/`_acg_app_dir`/`_acg_snippet_path*` —
all seven match). What the copy did **not** inherit is the reasoning: `acg_uninstall_gateway`
sweeps dangling `include` lines out of both vhosts, with a comment explaining that nginx refuses
to *start* on a missing include and that leaving one takes every other vhost on the box down. The
entry script's copy deletes the snippets and only the vhosts it can name — and `_acg_find_vhost`
will happily have planted the include in `sites-available/<domain>`, or in any vhost whose `root`
is the site dir. That is **A-16**, now fixed here too.

The same shape produced **A-17**: `_acc_conf_set` wrote values through `sed -i "s|…|…|"`, so a
`|` in an operator-typed value became a `sed` flag (`w /path`, as root) and a `&` silently
corrupted the line. Rewritten without `sed`. Both findings are written up in
`script052_security_audit.md`; the running total there is now 10 fixed / 6 open.

**A fixture caught a bug in the A-16 fix itself.** The first sweep copied the gateway lib's
`sed -i -E "\|…|d"` idiom. That form works in the lib because its pattern carries no alternation;
mine does — `(gateway(-onion)?|headers)` — and the `|` closed the address early:
`sed: -e expression #1, char 31: Unmatched ( or \(`. On a live uninstall that is an abort partway
through, not a warning. Re-run against a fixture vhost with `%` as the delimiter: the three
`accio-test-*` includes go, the `accio-main-` one and an unrelated product's both stay. **Copying
a working `sed` idiom is not the same as reusing it** — the delimiter is part of the pattern.

#### Everything else changed

| # | Finding | Fix |
|---|---|---|
| 1 | `_acc_net_badge` reported **"installed (stopped)" for a directory with nothing in it**. `/opt/grin/accio-<net>` is created by the first `_acc_conf_set` — i.e. by typing a domain at the rebuild prompt and going no further — and is *deliberately kept* by an uninstall that removed the unit, both vhosts and every snippet. The network picker therefore advertised a fully uninstalled product as installed | keyed to the unit file, with a third state (`site built, no gateway`) for a surviving site |
| 2 | The rebuild bootstrap **accepted any non-blank string as a domain**. `acn_deploy_web` validates with `nginx_validate_domain`; this second writer of `ACCIO_DOMAIN` did not, so an unusable name was baked into canonical URLs, hreflang and the manifest and discovered only at deploy — after the build | same regex, inlined, with a comment naming the shared helper as the source of truth |
| 3 | Two `rm -rf` without `${VAR:?}` (`:622`, `:681`). Not reachable today — `acc_set_network` always runs first — but it is the house rule, and this is the one action that can delete the address table | `${ACC_GATEWAY_DIR:?}` / `${ACC_DIR:?}` |
| 4 | `_acc_load_lib` **returned non-zero silently** when a lib existed but failed to source. Every caller writes `\|\| { pause; return 0; }`, so that path showed a cleared screen and a bare "Press Enter" — a menu action that did nothing and said nothing | reports the source failure |
| 5 | The uninstall sourced the nginx lib with `2>/dev/null`, so a missing lib meant **the torrc hidden-service block was silently left publishing** to a dead port | warns, and prints the marker to strip by hand |
| 6 | The deploy summary always printed `https://<domain>`, even when certbot was declined or failed, and `https://<no domain>` when the web front was cancelled | scheme read from `ACCIO_HTTPS`; a missing domain now says the web front did not complete |
| 7 | `acc_status` warned on **onion** drift between `BUILD_INFO` and the config but not on **domain** drift, though both are baked in at build time by the same code path | added; the onion warning is unchanged |
| 8 | Header comment: overlay "16 files" (17 since S9 pass 1), and S8/S9 were the only packets in the list with no status | corrected |

#### Checked and found correct — no change needed

- **Menu integrity.** The header comment's submenu, the rendered menu and the `case` all list the
  same 8 keys + `0`. No duplicate arm, no key that changed hands, no unreachable action. Every
  dispatch is `|| true`-guarded in both menus, and no function in the file ends in `[[ … ]] && cmd`.
- **`acc_set_network` populates every declared `ACC_*`** before any consumer can read one, on both
  paths. Cross-checked mechanically: the 16 distinct `ACC_*` names the four libs read are all set
  here. Two are set and read by nobody — `ACC_ADDR_HRP` and `ACC_STANDALONE_SRC`. Left in place
  (`ACC_STANDALONE_SRC` is the only pointer to the second pinned upstream), but noted: **nothing
  in the shell layer ever checks an address HRP**, so `tgrin`/`grin` separation rests entirely on
  the browser wallet's chain type.
- **Network separation is total.** Port, Tor port, dir, service, vhost ×2, link ×2, snippet ×3,
  hidden-service dir and torrc marker all carry `ACC_NET_SHORT`, derived once. The only shared
  objects are documented as shared on the uninstall screen (the `accio_*` rate zones and the
  `grinaccio` user).
- **`_acc_conf_get`.** `^key=` anchoring cannot collide (`ACCIO_PORT` vs `ACCIO_TOR_PORT`),
  `cut -d= -f2-` keeps `=` inside values, `tail -1` is consistent with a writer that now cannot
  leave duplicates, and an empty value correctly falls through to the default.
- **The `source`-leaves-deleted-keys trap does not apply here.** `$ACC_CONF` is never sourced —
  not by this file and not by any of the four libs (grepped) — it is read key-by-key. That is
  also what makes the A-17 rewrite safe to reorder keys.
- **`acc_status` does not report "installed" from an empty path**: `-s …/index.html`, not `-d`.
  `${ACC_SITE_DIR}.BUILD_INFO`, its `built_utc=`/`onion=`/`domain=` keys and
  `$ACC_DIR/standalone/current.html` all match what `052_lib_build.sh` actually writes (`:677`,
  `:1119`, `:1202`).
- **Every function the menu dispatches to exists**: `accio_build`, `accio_build_standalone`,
  `acg_install_gateway`, `acg_nginx_glue`, `acg_selftest`, `acg_gateway_menu`, `acn_deploy_web`,
  `acn_refresh_vhost`, `acn_nginx_menu`, `_acn_torrc_strip`, `acv_vendor_menu`. Signatures match
  the call sites; `_acn_torrc_strip` takes no argument and derives its marker from
  `ACC_NET_SHORT`, so the argument-less call in the uninstall is correct.
- **"16 offline probes" is accurate** — `acg_selftest` runs 15 `_acg_probe` calls plus the
  durability check, which also counts into `pass`/`fail`.
- **The hardcoded `127.0.0.1:9050`** in the status screen matches the gateway's own default and
  the generated `gateway.json`; it is not a lie about a configurable value.
- Sourcing a lib inside `|| { … }` disables `set -e` for that file's top level, so a lib with
  failing top-level code would load silently. Checked: the only column-0 statements in all four
  libs are `ACB_*`/`ACG_*`/`ACV_*` assignments, and there is no `readonly` anywhere, so
  re-sourcing on every menu action is safe.

#### Verification

`bash -n` clean. `_acc_conf_get`/`_acc_conf_set` extracted and round-tripped in the scratchpad
against `|`, `&`, `\`, a query-string URL and a repeated key: every value verbatim, no duplicate
keys, no temp file left, no injection. The include sweep run against a fixture vhost carrying
five includes. Nothing was started; no process left behind.

#### Owed to S2 (added to the audit's list)

An uninstall on a box where the include landed in a vhost we did not name, followed by a real
`systemctl restart nginx` — `nginx -t` is not the test, because the failure mode is nginx
refusing to start. And the network picker's badge after an uninstall.

---

### R3 review — Build & standalone — 2026-08-12 ✅ *(3 critical + 6 medium + 7 low, all fixed; still no VPS run)*

Target: `scripts/lib/052_lib_build.sh` (1219 lines → 1483). Sixteen findings, and fifteen of them
descend from one sentence in the file's own header.

#### The root cause — the lib does NOT run under `set -e`

The header claimed *"no `set -e` of its own — it runs under the caller's `set -euo pipefail`."*
It does not, and never did. Every call site is an errexit-suppressing context:

| call site | form |
|---|---|
| `052_grin_accio.sh:415` | `accio_build … \|\| error "…"` |
| `052_grin_accio.sh:463` | `accio_build_standalone … \|\| error "…"` |
| `052_lib_nginx.sh:575`  | `if accio_build …; then` |

Bash disables `-e` for the whole dynamic extent of a command in an `&&`/`||` list or an `if`
condition, and re-issuing `set -e` inside the function does not undo it — POSIX ignores it there.
`error()` (`052_grin_accio.sh:142`) only prints. Proven, not assumed:

```
build() { cp /nonexistent/x /tmp/y; echo "REACHED"; }
build || echo err     -> step1 / REACHED      (suppressed)
if build; then :; fi  -> step1 / REACHED      (suppressed)
build                 -> step1 / rc=1         (only a bare call aborts)
```

R1 already found the *sourcing-time* half of this ("sourcing a lib inside `|| { … }` disables
`set -e` for that file's top level"). This is the other half and the dangerous one: it applies to
every **function body** at call time. Generalised to the whole toolkit in memory
`project_lib_errexit_suppression` — the `||`-guarded dispatch CLAUDE.md mandates for menu `case`
arms is exactly the construct that turns errexit off inside the thing being dispatched to.

The comment was the most load-bearing line in the file, because it is *why* the bare `cp`/`mv`
below it were written. It has been replaced with the rule and both worked examples.

#### The two failures that shipped silently

**C2 — a failed patch overlay got a valid SRI for the pristine upstream bytes.**
`_acb_apply_patches` pass 1 had an unguarded `cp -f`, yet still pushed `$rel` into `patched[]` and
printed `patched  $rel`. Pass 2 hashes whatever sits at `$stage/$rel` — the **un-overlaid upstream
file** — and writes a perfectly valid checksum for it. Build succeeds, browser loads it cleanly,
nothing anywhere says the patch did not land. With S5's `scripts/node.js` patch that is a
self-custodial wallet talking to **upstream's nodes** instead of ours. Highest-impact defect found
in Accio to date.

**C3 — the "atomic swap" nested on failure and still reported success.**
`mv -- "$new" "$outdir"` does **not** fail when `$outdir` survived the rotate; it moves `$new`
*inside* it. Confirmed live: `mv site.new site` produced `site/OLD` + `site/site.new/NEW`. So a
failed rotate left the OLD tree serving, planted a junk subdir under the nginx root, and still
printed `success "Built N files"` — with `SHA256SUMS` and `BUILD_INFO` describing a tree nobody
serves. After a security rebuild that is *written evidence the fix shipped when it did not.* Now:
prove the rotate before publishing, and roll the old tree back if the publish fails.

#### The rest

- **M6 `[net]` was a switch, not a guard.** It called `acc_set_network`, re-pointing every `ACC_*`
  global — dirs, ports, conf path, service name, vhost — for the remaining hub session, no
  restore. Mainnet/testnet isolation rested on nobody using the documented argument. Now a
  mismatch refuses: *select first, build second.*
- **L6 `_ACB_STANDALONE` became a parameter** (`_acb_render_one` arg 7). As a global with a manual
  reset it was correct only by luck — any `return` added inside the standalone render loop would
  leak standalone mode into the next **hosted** build, stripping SRI and file-versions off the
  *served* site with no error anywhere.
- **M1 count post-condition.** Counters sit next to the copies, so they describe what the loop
  *intended*; the manifest is generated from the tree afterwards, so it records damage rather than
  catching it. `_acb_assert_output` now takes an expected file count. Both build paths pass it.
- **M2** `_acb_set_resource_entry`'s unguarded `mv` returned 0 on failure, so the caller logged
  "checksum refreshed" over a stale SRI — the exact silent failure its exit-4 drift guard exists
  to prevent.
- **M3/M4/L7 standalone publish.** A failed `mv` could republish the *previous* build's artefact
  of the same version, hash it and announce it — after `rm -rf "$work"` destroyed the fresh one.
  `current.html` was rewritten in place under a live nginx (a ~10 MB in-place `cp` hands a
  concurrent download a truncated wallet) — now written aside and renamed. `sha256sum` recorded an
  absolute path, so `-c` only verified from `/`.
- **M5** `rm -rf` on paths derived from a possibly-empty `$outdir`/`$ACC_DIR`. Guarded with an
  explicit check *first* — a bare `${var:?}` in a sourced lib exits the whole toolkit instead of
  returning to the menu — then `:?` underneath as the net.
- **L1** a dead `|| continue`: `abs="$(cd … && pwd)/$(basename …)"` takes its status from the
  *last* substitution (`basename`, always 0), so a failed `cd` silently produced `/name.svg`.
- **L3/L4/L5 silent skips.** `_acb_sa_mime` returning 1 dropped an asset with no output; there is
  now an explicit `ACB_SA_NOINLINE` list so a genuinely unknown type warns once per extension.
  A missing `importScripts()` target and a non-converged 5-pass loop both warn. Import paths are
  resolved against the worker's own directory instead of flattened to a basename.
- Empty-output guards on `_acb_sri` and base64 — an empty checksum writes `Checksum => ""` and an
  empty blob writes a `data:…;base64,` URI resolving to **zero bytes**, both invisible in the log.
- `$version` is sanitised before it becomes a filename.
- **L2** the header listed `acb_check_deps`/`acb_env_report` as PUBLIC ENTRY; nothing outside the
  file calls either. Relabelled INTERNAL, with the note that a hub pre-flight screen is the
  obvious next caller.

#### ⚠ Three things that look like omissions and are load-bearing — do not "fix" them

1. **`.js` is absent from `_acb_sa_mime` on purpose.** `"." + getResource("./scripts/slate_worker.js")`
   is the *body* of `Slate.WORKER_FILE_LOCATION`, and phase F rewrites that constant at its call
   sites into a Blob URL. Inline the getter's path in phase C and phase F has nothing left to
   point at. Verified: the only 3 `.js` literals phase C sees are exactly the three worker getters.
2. **Dropping `defer` when inlining is upstream's behaviour**, not our regression — `build.sh`'s
   `i --><script>` also emits a bare tag.
3. **Phase F's `.*` still must never become `[^>]*`** (already in CLAUDE.md).

#### Verified against the tree rather than assumed

All 28 `url()` in the vendored CSS are double-quoted (phase D's assumption holds). Script and
stylesheet tags are one-per-line, so phases G/H may replace a whole line. The header's "27 files"
is right: 28 templated files outside `backend`/`languages`, minus `errors/template.php`. The only
`.php` outside those dirs is `errors/template.php`, which is excluded — so the new count assert
cannot false-fire. The offline guard still passes its own S1 acceptance grep. Domain input is
already validated by `nginx_validate_domain` before it reaches the build. No `eval`, no hardcoded
secrets, no `--floonet`, no `chmod 777`, no fixed-name temp files.

#### Verification

`bash -n` clean across all four libs and the entry script. Two scratchpad harnesses, both
one-shot, nothing started, nothing left behind:

- **38 tests** over `_acb_sa_mime`, `_acb_sa_note_skip` (dedup), `_acb_sa_b64_checked`,
  `_acb_set_resource_entry` (rc 0/3/4/5, the comma-less last entry, the `ATTRIBUTIONS` boundary,
  Version-0 preservation, NULL clearing), `_acb_assert_output`, phase D's `../../` resolution and
  phase E's nested-import resolution. 38/38.
- **13 tests** on the swap, which **extracts the real block from the source file** and drives it
  with injected `mv` failures — so a future edit to that block is what gets exercised, not a
  hand-written replica. Covers the happy path, the rotate failure (asserting **no `site/site.new/`
  nesting**) and the publish failure (asserting rollback). 13/13.

#### Owed to S2

Nothing new in kind — but the count post-condition and the swap rollback are both first-run
behaviours that only a real build exercises, and the standalone `current.html` rename wants a
concurrent download during a rebuild to prove it. As ever: **nothing here has run on a VPS.**

### R4 review — Nginx, TLS, onion — 2026-08-12 ✅ *(1 critical + 4 medium + 6 low, all fixed; still no VPS run)*

Target: `scripts/lib/052_lib_nginx.sh` (1118 lines → 1358), plus the two files the critical
finding reaches into (`052_grin_accio.sh`, `052_lib_gateway.sh`). Eleven findings.

The plan's hunt list came back clean on almost everything it named: the header-inheritance rule
was genuinely kept in all three vhosts, the cert-bootstrap ordering is right, no unquoted
heredoc carries a backtick, the onion snippet carries no `limit_req`, `_acn_torrc_strip` is
marker-scoped and cannot eat a neighbour's HiddenService block, and every path carries
`ACC_NET_SHORT`. The critical finding is in something the plan did not think to ask about.

#### C1 — the onion path had three listeners and two ports

`acc_set_network` allocated `ACC_PORT` (gateway ← nginx :443) and `ACC_TOR_PORT` (gateway ←
onion). But the design's own note (f) puts a **second nginx server block** between tor and the
gateway — the wallet is ~7 MB of WASM that nginx should serve over the onion too — and that
block is a third listener. It was given `ACC_TOR_PORT`, the gateway's own socket:

| claimant | was | now |
|---|---|---|
| nginx onion block `listen` | `127.0.0.1:$ACC_TOR_PORT` | `127.0.0.1:$ACC_TOR_FRONT_PORT` **(new: 7581/7591)** |
| torrc `HiddenServicePort` → | `127.0.0.1:$ACC_TOR_PORT` | `127.0.0.1:$ACC_TOR_FRONT_PORT` |
| gateway `listen()` (`server.js:295`) | `127.0.0.1:$ACC_TOR_PORT` | unchanged |
| onion snippet `proxy_pass` | `127.0.0.1:$ACC_TOR_PORT` | unchanged — the only one already right |

**What it would have done, in the order `acn_onion_enable` runs it.** Gateway up with
`tor_port: 0`, holding only 7490. The onion vhost is written and nginx reloaded — nginx takes
7590. `gateway.json` then gets `tor_port: 7590` and the service is restarted; `server.listen`
gets `EADDRINUSE`; `server.js:343-345` calls `process.exit(1)`. **The whole gateway dies,
taking the clearnet `/tor/`, `/listen` and `/wallet/` rails with it** — enabling the onion
breaks the site that was working. Past the race, the snippet's `proxy_pass` also pointed at
the very block that includes it.

Nothing would have said so. `nginx -t` parses and never binds; `systemctl reload` returns 0
before the master tries to bind; and **both status screens ran the same `ss -ltn | grep
127.0.0.1:$ACC_TOR_PORT`**, so one line went green whichever process won — the screen hid the
collision it existed to show. Both now check their own port and say which is which.

The file's header had stated the collision as if it were the design ("*proxies to the
gateway's own onion listener on that same port number*"). Fixed there, in `052_grin_accio.sh`'s
new port map, and in `_acg_write_snippet`'s `front_label`, which told the operator tor arrives
at a port it does not arrive at.

#### The other ten

| # | Finding | Fix |
|---|---|---|
| M1 | `options-ssl-nginx.conf` included only when present — with **no `else`**. A box without it inherits *nginx's* TLS floor, which before 1.23 is `TLSv1 TLSv1.1 TLSv1.2`: TLS 1.0 on a wallet page, arrived at by omission | explicit `ssl_protocols TLSv1.2 TLSv1.3` + session settings in the `else` |
| M2 | `acn_onion_disable` deleted the gateway's onion snippet. Nothing includes it once the onion vhost is gone, so it bought nothing — and `_acn_write_onion_vhost` only emits the include when the file exists, so the **next enable silently produced an onion that 404s every send, handshake and inbound payment** | keep the snippet; warn in `acn_onion_enable` when it is missing |
| M3 | hard `systemctl restart tor` ×3, where Scripts 01/04/08del reload-first. This box is not tor's only tenant — a restart drops the node API's onion, Fidelius's, the Transporter's and every in-flight SOCKS circuit the pool's payouts ride | new `_acn_tor_reload`: reload `tor@default`, then `tor`, restart only as fallback |
| M4 | `_acn_reload` **cannot see a bind failure** — the mechanism that made C1 silent, and would make the next one silent too | `_acn_reload [addr…]` now verifies the listener appeared, and warns with the port and where to look |
| L1 | `Onion-Location` set in the server block was dropped by the two child blocks — the file's own trap, one level in, *after* S8 fixed the same shape for HSTS | folded into the new TLS snippet |
| L2 | HSTS was a **literal repeated in three blocks**; a `max-age` changed in one is a difference nothing reports | new `accio-<net>-tls-headers.conf` (HSTS + Onion-Location), included by the three TLS blocks. The onion front includes only the shared snippet — which is why these two were never in it |
| L3 | `apt-get install tor` with no `update`; `yum install tor` with no EPEL (tor is not in the RHEL base repos) | both added, non-fatal |
| L4 | `v=$(nginx -v 2>&1 \| sed …)` exits 127 under `pipefail` when nginx is absent | `{ nginx -v 2>&1 \|\| true; } \| sed …` |
| L5 | after a failed TLS reload the vhost falls back to HTTP but `ACCIO_HTTPS` stayed `on` — the build reads that key, not the vhost | `_acc_conf_set ACCIO_HTTPS off` in that branch |
| L6 | header listed six public entries; `acn_refresh_vhost` and `acn_write_headers_snippet` are called from the other two files | both documented as public |

One knock-on: `acc_uninstall`'s dangling-include sweep matched
`accio-<net>-(gateway(-onion)?|headers)\.conf`, which does **not** match
`accio-<net>-tls-headers.conf` — the alternation has to match from `accio-<net>-` onwards, so
the two snippets look alike and are not. Now `(gateway(-onion)?|(tls-)?headers)`, verified
against a fixture carrying all four plus another network's and another product's. A dangling
include is nginx refusing to **start**, so adding a snippet without adding it to that sweep is
how an Accio uninstall takes every other vhost on the box down.

#### Verification

`bash -n` clean on all five 052 files. Three scratchpad harnesses, all one-shot, nothing
started, nothing left behind:

- **The three vhosts rendered offline** into a temp tree with the path helpers overridden, and
  read as nginx: both snippets present in all three TLS blocks, the onion block carrying
  neither HSTS nor Onion-Location and listening on `:7591`, `$request_uri`/`$host`/`$uri`
  surviving unexpanded, and the `else` TLS floor rendering as valid directives.
- **`_acn_reload` ×6** with stubbed `nginx`/`systemctl`/`ss`: no expected ports, port present,
  port absent, empty-array expansion under `set -u`, two-port message join, and `nginx -t`
  failing. 6/6.
- **`_acn_http2_listen` ×6** under `set -euo pipefail`: nginx absent (the old pipefail abort —
  now survives), 1.22.1, 1.25.0, 1.25.1, 1.26.2, 1.24.0. Correct spelling each time.

#### Owed to S2

The whole of it, unchanged — but C1 adds one acceptance step that did not exist: after
enabling the onion, **confirm nginx holds `:7591` and the gateway holds `:7590` at the same
time**, and that the gateway is still running. That is the check the old status screen could
not have made. As ever: **nothing here has run on a VPS.**

---

### R5 review — Gateway install — 2026-08-12 ✅ *(2 critical + 4 medium + 4 low, all fixed; still no VPS run)*

Target: `scripts/lib/052_lib_gateway.sh` (1227 lines → 1452). Fourteen findings, all fixed in
place. Read against everything the file writes into: `gateway/{config,server,guard,store,
wallet_route,listen_route,tor_route}.js`, `nginx_shared_helpers.sh`, `052_lib_nginx.sh`, and
`acc_uninstall` in the entry script.

The plan's hunt list came back clean on the things it named. All 44 keys the installer writes
to `gateway.json` exist in `config.js`'s `DEFAULTS` (no key would trip the unknown-key warning,
none that `config.js` requires is missing); every heredoc escape is right, including the two
regex `\$` anchors and the escaped backticks in the `try_files` warning; neither snippet
carries an `add_header`; mainnet/testnet isolation is total (ports, dir, unit, both snippet
names, state dir); no `eval`, no hardcoded secret, no `--floonet`, no fixed-name temp file.
R4's port split holds — the onion snippet proxies to `ACC_TOR_PORT` and nothing else.

Both criticals share one root cause worth naming: **each trusted a proxy for the thing instead
of the thing.** One trusted a helper's exit code instead of checking the zones landed; the
other trusted a remembered status code instead of the handler that answers it.

#### C1 — the zone upgrade wrote no zones, announced success, and would stop nginx booting

`_acg_ensure_zones` exists for one job, stated in its own header: an S3 box has a conf file
defining `accio_tor` and nothing else, and the S4b snippet references `accio_listen` and
`accio_wallet` too — "*nginx would fail, AND WOULD THEN REFUSE TO START AT ALL, taking every
other vhost on the box with it*". It backed the file up with `cp -a "$conf_file"
"${conf_file}.accio-backup-<date>"` — **inside `/etc/nginx/conf.d/`** — then `rm -f`'d the
original and called `nginx_ensure_rate_limit_zones`, whose duplicate-zone guard greps
**recursively under `/etc/nginx`** and returns 0 without writing when it finds the zone.

It finds `accio_tor` **in the backup just created**. nginx does not load that backup — the
name does not end in `.conf` — so the zones genuinely do not exist, while the caller prints a
green `Rate zones → …` for a file that is not there. Both snippets are then written
referencing all three zones. `nginx -t` fails; at the next reboot, or any other product's
`systemctl reload nginx`, **nginx does not start** and Fidelius, GrinScan, the pool, Drop and
the node API go with it.

It was also self-concealing: the function's own detection loop **and** `acg_status` used the
same recursive grep, so both read the backup and reported "Rate zones present" in green
permanently. The toolkit could never self-heal and the status screen agreed with the lie.

Three fixes, and the third is the general lesson:

1. **Backups leave `/etc/nginx`.** New `_acg_backup_dir` → `$ACC_DIR/nginx-backups`. A stale
   backup already sitting in `conf.d` from the old code is now *evacuated* on sight, so a box
   that has been through this once upgrades cleanly instead of needing a hand-edit.
2. **New `_acg_zone_defined`** asks only the files nginx actually loads (`nginx.conf`,
   `conf.d/*.conf`, `sites-enabled/*`). Used by the detection loop and by `acg_status`.
3. **Verify the outcome, never the exit code.** `nginx_ensure_rate_limit_zones` returns 0 for
   *wrote it* and for **both** of its skip paths; only one of the three leaves usable zones.
   The function now re-checks all three zones afterwards and prints the exact
   `limit_req_zone` lines to add by hand if any is still missing.

#### C2 — the self-test failed on a healthy gateway

`_acg_probe 400 "/listen refuses a plain HTTP GET"`. `server.js:205` answers **426 Upgrade
Required** with an `Upgrade: websocket` header, deliberately and with a comment explaining why
426 is both correct and self-explaining. So the self-test printed `FAIL … (wanted 400, got
426)` and then `do not proceed to a real send` — on the one screen that gates the first real
send. An assertion that cries wolf is worse than no assertion: it teaches the operator to read
past a red self-test. Now 426. The other fourteen probes were each re-derived from their
handler (`guard.js`, `wallet_route.js`, `listen_route.js`) and are correct, as is the
`"durable": true` grep against `store.counts()`.

#### The other twelve

| # | Finding | Fix |
|---|---|---|
| M1 | `_acg_ensure_zones`' return value **discarded** at the call site — and this lib always runs with errexit off (`acg_nginx_glue \|\| true`), so every refusal it can make was thrown away and the snippets were written anyway. The amplifier that turned C1 into an outage instead of a message | gated; nothing is written until the zones are confirmed |
| M2 | `_acg_find_vhost`'s fallback greps for `root $ACC_SITE_DIR` — which the **onion** vhost also carries. It could return the onion vhost, and the caller then inserts the *clearnet* snippet (proxying to `ACC_PORT`) into it: exactly the forgery the port split exists to prevent, plus a `limit_req` keyed on `$binary_remote_addr` becoming one global bucket because every Tor visitor is 127.0.0.1. `nginx -t` passes; no screen shows it | excludes `-onion` and `.accio-backup-` |
| M3 | vhost backups written as `${vhost}.accio-backup-…` **in `sites-available`**, which `acg_status` greps to decide whether the include is present — one backup makes it green for good, including after the rollback restored a vhost that never had it | backups to `_acg_backup_dir`; the status check now reads `sites-enabled` (what nginx loads) and distinguishes "in the vhost, but that vhost is not enabled" |
| M4 | the uninstall swept only two vhosts it could name, while `acc_uninstall` greps all of `sites-available` — because an include "can be living in a vhost we did NOT name". A missed one is nginx refusing to **start** | same grep-driven sweep as the entry script, backups excluded. `sites-available` **only**: a `sites-enabled` entry is a symlink, and `sed -i` does not edit through one — it *replaces* it with a regular file, severing the pair |
| M4b | the sweep's `\|…\|d` sed address works only while the pattern carries no alternation — `\|` is delimiter *and* ERE alternation | `%` delimiter, matching the entry script, with the reason written down |
| L1 | unguarded `mkdir`/`cp`/`chmod`/`cat >` throughout a lib that runs without errexit. The `mkdir -p "$state_dir"` one matters most: a failure ships a unit whose `ReadWritePaths` names a missing directory, and systemd then refuses to start with *"Failed to set up mount namespacing"* | every writer guarded; `_acg_write_snippet` returns non-zero and both callers check |
| L2 | `_acg_json_set` warned and returned **success**. A failure to set `state_dir` — the key that decides whether every wallet keeps its receiving address across a restart — was one yellow line in a scrolling install, and is invisible from a running service until the next restart | returns non-zero; the five install call sites are chained and the install stops |
| L3 | `$domain`/`$onion` interpolated raw into the `gateway.json` heredoc. Both *menu* writers validate, but `052_lib_build.sh` tells the operator to `Set ACCIO_DOMAIN= in $ACC_CONF` by hand, which goes through neither — and `x", "allow_clearnet_destinations": true, "domain": "x` is **valid JSON** that turns off the .onion-only policy the whole SSRF story rests on | both re-validated at the point of use (domain regex; v3 onion), install refuses otherwise |
| L4 | `rm -rf "$(_acg_app_dir)"` without `:?`, where `acc_uninstall` already writes `${ACC_GATEWAY_DIR:?}` | matched |
| C1–C4 | `onion listener` label one char wider than its column; `rate zones` off by one between the ok/not-ok branches; "16 probes" vs the comment calling one of them "not a probe"; a second `command -v curl` after the function already returned on its absence; `Documentation=` pointing back at the toolkit checkout the operator is free to delete | all fixed — the status column is uniform at 16, the count reads "fifteen probes plus one property check", the README is copied into the install and `Documentation=` points there |

#### Verification

`bash -n` clean on all five 052 files. Two one-shot scratchpad harnesses, nothing started,
nothing left behind, temp tree deleted in-session:

- **Zone detection ×5** against a fake nginx tree: a backup-only zone is correctly *not*
  present (and the old recursive grep was confirmed to report it as present — the bug
  reproduced before the fix was trusted), a real zone in `conf.d` is found, a genuinely
  missing zone is reported missing, and a `limit_req zone=…` **usage** line is not mistaken
  for a definition.
- **The uninstall sed ×2 fixtures** (clearnet + onion include): both gateway includes deleted,
  the `headers` include preserved in each; and the old `\|…\|d` form confirmed to error out
  once an alternation is added, which is why the delimiter changed. Plus the `_acg_find_vhost`
  pipeline against a directory holding the real vhost, the onion vhost and a backup — it picks
  the real one.

#### Owed to S2

Everything R5 touched is still un-run. Two acceptance steps this review adds:

- **The self-test must read 16/16** on a fresh install, and the `/listen` probe specifically
  must report 426 — that probe has never passed.
- **On an S3-era box, run "nginx glue" and then confirm all three `accio_*` zones exist in a
  file nginx actually loads** before any reload. This is the only finding that can take the
  whole box down, and it is invisible from the screen that used to report it.

As ever: **nothing here has run on a VPS.**

### R6 review — Gateway core — 2026-08-12 ✅ *(2 critical + 5 medium + 10 low, all fixed; still no VPS run)*

Target: `gateway/{server,config,guard,store}.js`. Seventeen findings, all fixed. Read against
the callers (`listen_route.js`, `wallet_route.js`, `tor_route.js`), the installer
(`052_lib_gateway.sh`, `052_lib_nginx.sh`) and the generated `gateway.json`.

Three claims were **probed rather than asserted**, because each would otherwise have gone into
this log as a fact:

- **`server.requestTimeout` does not cover the response phase.** `send_timeout_ms` (120 s) is
  assigned to it while `inbound_timeout_ms` is 180 s, which reads as a 2-minute cap on a
  3-minute wait for a human to approve a receive. A one-shot server with the body fully
  received and the response withheld for 4 s under a 1.5 s `requestTimeout` answered
  **HTTP 200 after ~4043 ms**. The timer covers *receiving* only. No bug, and the comment at
  the bottom of `listen()` is accurate — recorded so the next pass does not re-open it.
- **Quoted booleans load and are truthy** (C2 below), demonstrated against the real loader.
- **`key in DEFAULTS` accepts inherited keys** (L1), demonstrated the same way.

#### C1 — a read error on the snapshot destroyed every receiving address

`_load()` had three failure paths and only two were safe. Invalid JSON and a wrong `version`
both **move the file aside** before starting empty. Any other `readFileSync` error logged a
warning and carried on — and carrying on means starting empty, which means the next `flush()`
renames **over** a snapshot full of live addresses. Rename takes its permission from the
*directory*, which the service owns, not from the file it just failed to read.

The trigger is ordinary: an 089 restore or a hand-copy that leaves `listen-state.json`
`root:root` inside the service-owned 700 dir. EACCES on read, "starting empty", and two seconds
later the only copy of every wallet's receiving address is gone. This is the exact outcome the
module header calls "a correctness property, not a nicety."

Now fatal, with the reason and the fix in the message, and `server.js` wraps the `new Store` so
it exits 1 cleanly rather than throwing a stack. ENOENT is still the silent first run.

#### C2 — a quoted boolean silently inverted the SSRF default

`listen_enabled` was the **only** boolean anyone type-checked. Every other one was assigned raw
and later read for truthiness, so `"allow_clearnet_destinations": "false"` — the commonest JSON
hand-edit slip there is — loaded happily and turned the destination guard **off**, because the
non-empty string `"false"` is truthy. Same for `log_destinations` (the payment graph into the
journal) and `allow_extension_origins: "no"`.

That inverts rule 1 at the top of `config.js`: the operator who edits the file ended up with
the *more* permissive gateway. And hand-editing is an expected workflow — the Status screen
tells them to do it. Fixed with `BOOLEANS` and `STRINGS` lists beside `POSITIVE_INTS`; a wrong
type is now a refusal to start. The installer's generated JSON was checked and already writes
real booleans, so no existing deploy breaks.

#### M1 — store evictions orphaned `state.owned`, which then grew without bound

`_evictOldestUnverified` and `_evictGlobalOldestUnverified` removed a row and told nobody.
`_forgetEverywhere` existed for exactly that cleanup but was only called from `Change URL` and
`Delete URL`. So `Create URL` in a loop: the **table** stayed correctly capped at 16 per
session while `state.owned` beside it — the socket's mirror of that table — grew at the
client's full message rate and was never pruned. 20/s × 512 sockets, retained until the socket
closes, reachable by anyone who can complete a handshake (absent `Origin` is allowed, so
`curl` qualifies). OOM, restart, every live socket dropped and every parked payment failed.

Fixed with a single `store.onForget` hook the hub sets in its constructor, so all five removal
paths — both evictors, `dropSession`, `release`, and the new load-time trim — are covered by
construction rather than by remembering. The hook is wrapped: the table's consistency must not
depend on the mirror's correctness, and the error line carries no suffix (§11.11).

#### M2 — the flush debounce bounded frequency, not volume

`flush()` re-serialises the whole table. At `max_suffixes_total` (100k rows, ~10 MB) a trickle
of mints meant ~10 MB **every 2 seconds** — several MB/s of sustained writes on a box shared
with the node, the pool and Fidelius. `_flushDelay()` now scales the debounce with the table
(+1× per 10k rows), so the write *rate* stays roughly flat instead of growing with how
successful the gateway has been.

#### M3 — `/wallet/` refusals in `server.js` were unreadable to the sender

Every refusal *inside* the inbound rail goes through `listen.sendJson`, which attaches CORS.
The two raised in `server.js` — listen rail disabled (404) and onion inbound bucket empty
(429) — used `torRoute.sendError`, which emits none. This route is reached **cross-origin** by
another wallet's tab, so its JS could not read either status: "the payee's rail is off" and
"you are rate-limited" both surfaced as the same opaque network error, in the two conditions
where the sender most needs to be told which. Both now go through a new `walletRoute.refuse`.

#### M4 — two of three request entry points were undefended against a throw

`guard.inspect` is wrapped with an explicit rationale: an uncaught throw out of a request
listener kills the process. That reasoning applies verbatim to `walletRoute.handle` and
`hub.handleUpgrade`, neither of which was wrapped, and there was no `uncaughtException` handler
anywhere in the service. Both are now wrapped; the last-resort handlers log and **deliberately
do not exit** — dropping every live socket because one request found one bug is the failure,
not the fix.

#### M5 — the token buckets used a non-monotonic clock with no lower clamp

`Math.min` clamped the top; nothing clamped the bottom. A backward `Date.now()` step — routine
on a box running a time daemon — made the elapsed term negative and drove the balance
arbitrarily far below zero. An hour's correction at 10/s leaves −36,000 tokens: the onion front
refuses everything for the next hour with nothing in the journal to explain it. On the
`/listen` bucket it is worse, because 50 violations closes the socket, so a clock correction
could disconnect every live wallet. Both sites now clamp the delta and the floor.

#### The ten low findings

`Object.hasOwn` for the unknown-key guard (L1); `port`/`tor_port` may no longer collide with
`socks_port`, which is R4's lesson one port over (L2); `network` validated as an enum (L3); the
two unreachable `Array.isArray` branches kept but their comments corrected to say what Node's
parser actually does — `origin` is joined with `", "`, `content-type` is first-wins (L4); a
destination **port allowlist**, defaulting to 80/443, because a wallet address never carries a
port and an arbitrary one made this route a port scanner for hidden services run from our box
(L5); `fsync` before the rename and on the directory after it (L6); set-aside snapshots counted
and surfaced on `/health` (L7); the caps applied at load, not only at mint (L8); the store
passed to `health()` instead of a module-level `healthExtra` assigned after both listeners were
already accepting (L9); and one `drain()` with the cap passed in, replacing two copies that
disagreed by 10× (L10).

#### D1 — the offline assertions were never in the repo

`guard.js` exported seven symbols "for the offline assertions", `store.js` three, `config.js`
one — and a grep found **zero consumers**. The 47 guard assertions and 97 S4b assertions this
log records were all run from scratchpad harnesses that were never committed. So the SSRF
boundary, the file whose own header calls itself the one worth testing exhaustively, had
nothing runnable behind it and every edit since was unprotected.

`gateway/test/` now exists: `node:test`, zero dependencies, no sockets, no listeners, exits on
its own, and **not deployed** — the installer copies `*.js` at the top level only, so the
"N modules" count it prints stays right. `npm test`, or `node --test` from the gateway dir.

Two of the new store assertions were **mutation-checked**: the C1 fix reverted on a copy turned
"a snapshot we cannot READ is fatal" red, and the M1 hook stubbed out turned both `onForget`
tests red. Given this packet has already shipped a green suite hiding a test that asserted a
branch it never constructed, a passing assertion is worth nothing until it has been seen to
fail for the right reason.

#### Verification

- **78/78** across `guard.test.js` (25), `config.test.js` (20), `store.test.js` (21) and the
  concurrent `money_rails.test.js` (12).
- **18/18 smoke checks against the real `server.js`**, booted on loopback and killed in the
  same run — nothing in the unit suite covers the process wiring, and R6 changed exactly that.
  It confirms `/health` carries the store counts, the port policy refuses `:22` live, the
  disabled rail answers a **CORS-readable JSON 404**, and a quoted boolean stops the service
  with the key named. Two of its own assertions were wrong first and were corrected: `/health`
  legitimately carries a *counter* called `suffixes_minted`.
- `bash -n` clean on all four 052 libs and the entry script.

#### Owed to S2

- The **port allowlist is a behaviour change**: a payee whose onion Foreign API is not on 80 or
  443 is now refused. Nothing we ship composes such an address, but the first send to a third
  party is what would find out. Set `allowed_destination_ports: []` to restore any-port.
- **Restart the gateway twice during acceptance** and confirm the receiving address is
  unchanged both times. C1 means a state dir the service cannot read now stops the service,
  which is the intended behaviour and will look like a failed deploy if it ever fires.

As ever: **nothing here has run on a VPS.**

---

### R7 review — Gateway money rails — 2026-08-12 ✅ *(1 critical + 2 medium + 2 low, all fixed; still no VPS run)*

Target: `gateway/{listen_route,wallet_route,tor_route,socks5,ws}.js` (~1910 lines). Read against
the contracts R6 had just settled (`store.js`, `config.js`, `guard.js`, `server.js`), the
generated `gateway.json`, and the nginx zones the rails claim to rely on. Spec contract was
`script052_design.md` §"Listen protocol" only — the vendored `listener.js` was not opened.

Five findings, all fixed, and **all five are now pinned by a committed test suite** rather than
by a scratchpad harness: `gateway/test/money_rails.test.js` (11 tests) beside R6's
`guard.test.js`. 36/36 pass, `node --test` exits on its own.

**Every fix was checked by reverting it.** Each test carries a `⚠ THE NEGATIVE CONTROL` comment
naming the revert that makes it fail, and those reverts were actually performed against a scratch
copy of the tree — four in one batch, C1 separately. A test that has never been seen to fail is
not evidence, and this file has been burned by that before (S9's "96 passed" that was really
95/1, and S7's silently no-op worker phase).

#### C1 — the A-1 fallback re-opened A-1 in full, and its comment understated it

`deliver()` routed to a socket that had claimed the suffix, then fell back:

```js
const pool = claimants.length ? claimants : live;
```

A-1 records this fallback as a "deliberate residual" covering the window between a reconnect and
that connection's first `Own URL`. **It is not that narrow.** `claimants` is empty in *every*
case where the legitimate tab is not connected — which, for a browser wallet, is the ordinary
state of the world. So the cookie-holder from A-1 never had to win a race: they connect while
the victim's tab is closed, claim nothing, and are handed the next inbound slate for an address
they cannot name. Their wallet answers it with their own output. That is the whole of A-1,
reachable without any timing at all, sitting underneath a comment that described a sub-second
window.

The correct answer was already three lines above it: the 503 + `Retry-After` that every payer
whose payee is offline already receives. A payee whose tab has not claimed the address genuinely
cannot receive, and saying so costs a real client one retry.

Fallback deleted. Delivery is now a strict rule: claimants only, newest among them. A new counter
`inbound_unclaimed` separates "a live socket that has not claimed" from "no socket at all", so
the acceptance session can see whether the reconnect window is ever actually hit.

> A-1's note said "when the fallback goes, the second assertion is the one to invert." It has
> been inverted: the suite now asserts a non-claiming socket receives **nothing**, both with a
> live claimant present and without one.

**This moves a risk rather than removing it, and the new one belongs to S2.** If a real client
does *not* send `Own URL` for a held suffix on reconnect, receives now fail closed instead of
silently going to the wrong socket. That is the right direction — a payment that does not arrive
is recoverable, one that arrives in a stranger's wallet is not — but it makes "watch a real
client claim its addresses" a **blocking** acceptance item rather than a curiosity.

#### M1 — the inbound read budget was 256 MB, and the address was not checked until after it

S8's A-3 fix made `max_inbound_in_flight` cover the read as well as the relay. It never sized the
product: 256 concurrent reads × `inbound_body_bytes` (1 MB) = **256 MB of buffer** this process
can be asked to hold, on a box also running a Grin node, the pool and Fidelius.

Worse, `store.lookup()` did not run until `deliver()` — *after* the whole body was buffered.
`parsePath` admits any `[A-Za-z0-9]{4,64}`, so a POST to a suffix that has never existed cost a
full megabyte of heap before its 404. The budget was therefore reachable by anyone at all: no
address, no session, either front. On the onion front it is reachable by **one** client, because
`onion_inbound_bucket` is a rate limit (5/s, burst 20) and not a concurrency one — slow 1 MB
uploads held ~60 s each reach 300 slots on their own.

Two fixes. `hub.knows(suffix)` is checked in `wallet_route.handle` **before** `beginRead()`, so
an unknown address costs the 404 and nothing else; `deliver()` still does its own authoritative
lookup, because the table can change while a body streams. And the cap was resized — see M2.

The `knows()` gate sits *after* the method and Content-Type checks deliberately, so every status
the existing `acg_selftest` asserts is unchanged.

#### M2 — `inbound_body_bytes` and `ws_max_message_bytes` only met at runtime

`deliver()` base64-encodes an inbound body into one WebSocket frame and checks that frame against
`ws_max_message_bytes` (256 KB). Base64 is 4 out per 3 in, so the real ceiling was **~192 KB of
body** — and `inbound_body_bytes` was 1 MB. Everything between the two was read in full,
buffered, and then answered 413 by a check it could never have passed. Nothing in the config, the
nginx `client_max_body_size 1m`, or any operator-facing text said the effective limit was a fifth
of the stated one.

`loadConfig` now derives `inbound_max_forwardable` from `ws_max_message_bytes` and clamps
`inbound_body_bytes` to it with a warning naming both keys. The default drops 1 MB → **128 KiB**
(a slate is a few KB), which puts the whole inbound budget at 32 MB. `052_lib_gateway.sh`'s
generated config was updated to match.

**Clamp, not throw.** A `gateway.json` written by an earlier packet carries 1048576, and refusing
to start on it would take the rail down in order to enforce a limit that was already being
enforced — just late, and after the memory had been spent.

#### L1 — `refuse()` could throw, killing the process

`refuse()` called `message.replace(/[\r\n]/g, ' ')` on a value one caller forwards straight from
`err.message`:

```js
return refuse(socket, err.status || 400, err.message, err.extraHeaders);
```

An error carrying no message raises a TypeError there, and an `'upgrade'` listener throws to
`uncaughtException` — the whole gateway, every other wallet's live socket, for one odd handshake.
The sibling catch one block up already guarded this (`err.message || 'origin not allowed'`); this
one did not.

Coerced with `String()`, CR/LF stripping preserved. **Correction to the review as first
reported:** the other half of this — wrapping `hub.handleUpgrade` in `server.js` — was already
fixed by R6, and was called out as missing on the strength of a stale read of that file. Only
`refuse()` was outstanding.

#### L2 — `store.touchSuffix` was dead code, and receiving money did not count as activity

`touchSuffix` had no caller anywhere in the gateway. The session `seen` mark — which **is** the
address lifetime — was refreshed only by a handshake and by a client `Request`. `deliver()`
touched neither.

So the activity clock counted everything except the one activity that matters most. A tab held
open across the ttl without asking us for anything has its session swept from under a **live**
socket, its suffixes deleted with it, and its payments start answering 404 while the UI goes on
displaying the old address. Rare at 90 days, but the unused `touchSuffix` reads like this refresh
was intended and never wired.

`_onInteractionResponse` now calls `touchSession` + `touchSuffix` on the success path.
Deliberately on the tab's **accepted response**, not on the arriving request — otherwise any
stranger who knows an address could hold its session open indefinitely.

#### Checked and found correct

Read in full and not changed: `socks5.js` (the paused-mode `'readable'` reader and why a `'data'`
handler would break the handover, `agent: null`, ATYP `0x03`, the bound-address consumption on
every reply path, per-stage timeouts) and `ws.js`'s frame parser (masking enforced, all three
length encodings, the reassembly cap as well as the per-frame one, `'end'` beside `'close'`, the
`process.nextTick` `head` parse, `_emitError`'s `listenerCount` guard). `tor_route.js`'s
idempotent `fail()`, its separate total-vs-idle deadlines, the deadline armed *after*
`transport.request()` exists, and drain-don't-destroy on 413 all hold.

The ack ordering was re-traced against the design and is right: response flushed to the sender
first, ack only on `'finish'`, `Error` on a failed write so the tab rolls back deliberately. Its
one gap is bounded and recorded, not fixed: a hostile hidden service's **response** body has no
size cap, only the 180 s deadline — tolerable because the pipe applies backpressure and the bytes
are going to the browser that asked for them.

#### Test-writing notes worth keeping

Two of this pass's own assertions were wrong before they were right, which is the argument for
negative controls:

- The first `bodyReq` double only produced its body on `resume()`. The success path never calls
  `resume()` — attaching a `'data'` listener is what flows a real stream, on a *later* tick — so
  three tests failed until the double matched Node's semantics. A double that delivers
  synchronously on subscribe is equally wrong: `readBody` registers `'data'` before `'end'`.
- The CR/LF injection assertion failed against **correct** code. `refuse()` folds the newline
  into the status line as inert text, which is right; the assertion had checked that the text was
  absent rather than that no second header line appeared.

`attachSocket` drives the real `hub._register` rather than constructing a connection-state object,
so the suite cannot keep passing against a shape that has drifted — the failure mode
`helpers.js`' own header warns about.

#### Owed to S2

- **Blocking, and upgraded from a curiosity by C1:** watch a real client send `Own URL` for every
  held suffix on reconnect. With the fallback gone, a client that does not claim cannot receive at
  all. `inbound_unclaimed` in `/health` is the instrument — it should be near zero in steady state
  and non-zero only around reconnects.
- Confirm a receive still works with the body cap at 128 KiB. Nothing we ship composes a slate
  anywhere near it, but the first real receive is what would find out.

As ever: **nothing here has run on a VPS.**

---

### R8 review — Overlay, the MQS reduction, and doc truth — 2026-08-12 ✅ *(1 security finding + 4 fixes; A-11/A-12 specified, not written; still no VPS run)*

**The last packet of the review arc.** Its subject was `patches/**` — the 17 files that decide
what a visitor's browser actually executes on top of the pinned upstream — plus the six open
audit items and the truth of this document's own numbers.

**Outcome: the overlay's logic is sound and its argument holds everywhere I could check it. The
failures were in the layer around it** — one patched file that no review method could see, one
brand map that was right about the two languages nobody needed it for, and a handful of stale
counts in the handoff. Of those, the marker one is the finding; the rest are its consequences.

#### The one that matters — a patch nothing could review

`scripts/check_for_updates.js` carried **six rewritten URLs and not one `ACCIO PATCH` marker.**

The overlay is whole-file replacement, so a patch is invisible by construction: the only way to
see a change is to diff thousands of lines against `vendor/`. That is why the convention exists,
why every marker carries its reasoning, and why this packet's own brief says in bold to *work
from the marker grep, not from reading 13k lines*. A file with no marker is therefore not "less
documented" — it is **outside the review method entirely**, and it stayed outside it through S5
that wrote it, S6, S8's audit and four other review packets.

What was inside it: the standalone artefact, the one this product describes as *offline*, fetched
`api.github.com/repos/…/releases/latest` on every load with the setting defaulting on. That is
**A-23**, MEDIUM, now fixed — full write-up in the audit. Three things were wrong at once and
the third is the one that dates it: the check compared the *toolkit's* release tags against
`VERSION_NUMBER`, which is the *upstream wallet's* version (`"2.8.2"`). Two unrelated version
lines, compared with an operator that fires on equal. It had never been able to work.

**The fix is the marker, not the URL.** `patches/README.md` now states the convention — it never
did; the rule lived in CLAUDE.md, the design doc and this file, none of which is where somebody
writing a patch is looking — and carries a table of all 17 files. The table is load-bearing
rather than decorative: `privacy_policy.txt`, the four SVGs and the licence text have no comment
syntax that stays out of the rendered output, so for those the table *is* the marker. That gap
is exactly where an unmarked patch can hide next time.

#### The brand map was correct and insufficient, which a same-file check cannot tell you

The packet says to check the two phrase maps *programmatically, not by eye*. They were identical.
That check passes and always would have — and it is the wrong question, because both maps were
missing the same thing.

The map is English **phrases** (`MWC Wallet` → `Accio`), which is the right rule: rewriting the
bare token `MWC` is the layer-3 hazard the design forbids. But three of the six translators did
not keep English word order. Dutch writes *MWC Portemonnee*, Greek *Πορτοφόλι MWC* and *Νόμισμα
MimbleWimble*, Simplified Chinese *MWC钱包* and *MimbleWimble币*. Those values never matched
anything.

Measured, not guessed — every entry in all six `languages/*.php` tables, branded through the real
map, then grepped:

| Language | Unbranded strings shipping |
|---|---|
| american_english, czech, german | 0 — they kept the English word order |
| dutch | 7 |
| greek | 8 |
| simplified_chinese | 12 |
| **total** | **27** |

Not obscure strings. `MWC Wallet` is the page title; `MWC Wallet — Error` and `— Maintenance` are
the error and maintenance pages; the About blurb is there. And in Greek and Chinese,
`MimbleWimble Coin` and `MimbleWimble Coin:` — **the currency label beside a balance.** A Grin
wallet telling a Chinese-speaking user it held MimbleWimble Coin, on the screen where they read
their money.

Both maps gained the nine translated spellings; they are still identical, 12 entries each, and the
leak count is 0. The checker extracts each map from its own file with a regex, compares them as
ordered lists, then re-runs the leak scan. Worth re-creating rather than trusting, and **worth
pointing at any new language before it ships**, which the Current state table now says.

One trap it found in me: my first version of the PHP comment contained a `"key" => "value"`
example as prose, and the extractor could not tell that from a live entry — it reported a
13-entry PHP map against a 12-entry JS one. The comment now says so and stays clear of the shape.
A checker that parses a file with a regex is defeated by a comment that looks like data.

#### The MQS reduction — verified, and it is right

S9 pass 1's central claim checks out end to end:

- The external surface is **exactly five symbols**, and they are exactly the five kept:
  `publicKeyToMqsAddress`, `mqsAddressToPublicKey`, `isValidAddressWithHost`, `sendRequest`,
  `ADDRESS_LENGTH`. Counted across the five referring files — api.js 14, slate.js 17,
  hardware_wallet.js 3, wallet.js 1, send_payment_section.js 1 = **36**, the number the patch
  claims. No bare `Mqs` reference exists outside those.
- **`Slate.compactProofAddress` really does read `Mqs.ADDRESS_LENGTH` un-gated, on the encode
  path** (`slate.js:6410`), reached unconditionally from serialization at `:438`/`:516` whenever
  a slate carries a payment proof. Deleting the file is a `ReferenceError` on every send with a
  proof. The reduction's whole justification rests on this and it is accurate.
- **Nothing changed about how a slate is READ.** `uncompactProofAddress` calls
  `publicKeyToMqsAddress` when the MQS bit is set; upstream faulted there (a `TypeError` from
  `getAddressVersion` returning `undefined` for Grin — verified, its `switch` has MWC and EPIC
  cases only), the stub throws a string. Both throw. No caller in the tree inspects an error's
  type or `.message`; the only `error.message` read anywhere is jQuery's `Deferred` logger, which
  handles both.
- 52 stays 52, and it must: `compactProofAddress` switches on the address *length* to choose the
  MQS branch over the Tor one. Changing it would reroute a 52-character proof address into the
  Tor branch instead of rejecting it — a parsing change wearing a deletion's clothes.

#### The rest of the overlay, marker by marker

Everything else claimed by a marker comment was traced to the code it claims to affect, and every
claim held:

- `consensus.js` — Grin forced before local storage, the URL override and any saved value.
  `MWC_WALLET_TYPE` intact (25 occurrences across the overlay, none renamed).
- `index.html` walletType select — `value="1"` is right: `GRIN_WALLET_TYPE` is
  `MWC_WALLET_TYPE + 1` and `MWC_WALLET_TYPE` is `0`.
- Donate removal — `about_section.js:275` does `find("div.donate")` then `prepend()`, and the
  click handler at `:40` selects inside the same div. Both no-ops with the div gone, as claimed.
  The one surviving `mwcwallet.com` string in the patched `index.html` is inside a PHP comment
  and never renders.
- The `ATTRIBUTIONS` credit survives the brand layer for the reason its comment gives, and I
  confirmed the mechanism rather than the assertion: `addAttributions()` passes the name as
  `textArguments[0]`, and `brandArgument()` matches arguments **whole-value** against
  `brandLinks`, which does not contain `MWC Wallet`. Same for the bare repository URL, which is
  deliberately absent from `brandLinks` while the three `/releases` forms are present.
- `MWC Wallet license.txt` is byte-identical to `vendor/upstream-wallet/LICENSE` (modulo CRLF).
  The MIT obligation is met with upstream's own text, not a paraphrase.
- The four SVGs parse as XML, contain no script, no `foreignObject` and no external host.
- The rendered `index.html` has no external host at all.

**One symmetry the overlay missed, now fixed.** The patch that stopped preloading `fonts/mwc/`
argued it precisely: `class="mwc"` is emitted at exactly one place, inside
`case Consensus.MWC_WALLET_TYPE`, and `getWalletType()` can no longer return it — two round trips
per visit for a glyph nothing can produce. `class="epic"` is emitted three lines below it under
`case Consensus.EPIC_WALLET_TYPE`, is unreachable for the identical reason, and its font was still
preloaded *and* its stylesheet still loaded. Same argument, one of two cases. The Epic preload and
stylesheet are gone; BTC's stay, because `Prices` renders a real bitcoin figure.

#### Doc truth — what was right, and what was not

Checked rather than assumed, because a stale number in the handoff is a real defect in this packet.

**Right, verified by measurement:** overlay `17 files / 567 kB` (566,967 bytes exactly on arrival;
16 replace a vendored file, 1 adds one) · `25` markers in the published tree — the S5 file set
excludes `backend/`, which is where the other 11 live, and the two counts differ for that reason
and no other · manifest `274 files / 7,517,960 bytes` · `9` gateway modules, zero npm dependencies
· `MWC_WALLET_TYPE` never renamed · the S9 pass-1 residual table, including the correction
footnote about `195 → 193`.

**And then this pass invalidated two of them, which is the point being made here.** Adding
markers and comments moved the overlay to **572,280 bytes** and the marker counts to **39 total /
28 in the published set**. The Current state table above carries the new figures. A packet whose
job is doc truth cannot certify a number and then change it in the same session without saying
so — the previous entry's stale `96` got there the same way, by being true when it was written.

**Stale, now corrected:**

| Claim | Was | Is |
|---|---|---|
| Audit running total | 10 fixed, 6 open | **16 fixed, 6 open** (A-18…A-22 from R7, A-23 from R8) |
| Review arc | "R6, R7 and R8 are what remain" | **all eight done** — R6 and R7 have session entries above, dated the same day the row was left unedited |
| Offline assertions | "96" | **78 tests, 78 pass, 0 fail** — measured, `node --test`, 4 files |
| Audit's suite note | "`{guard,money_rails}.test.js`, 36 assertions" | four files; `config` and `store` were omitted |

The "96" is the number this packet was warned about, and the warning was right in a way it did not
anticipate: the figure is not merely stale, it counts a unit that no longer exists. The scratchpad
harness it described has been replaced by a committed suite that prints its own total every run.
**Quote the runner, not a remembered number** — the fix is to make that impossible to get wrong,
so the table now says where to run it from.

It also says how, because that cost a minute: **`node --test test/` fails on Windows** with
`MODULE_NOT_FOUND`. Use `node --test` bare (auto-discovery, 78) from `web/052_accio/gateway/`, or
`node --test "test/*.test.js"` (77 — the bare form additionally picks up `helpers.js`).

#### A-11 and A-12 — mechanisms specified, deliberately not written

Both are in the audit in full. In short:

- **A-11** (`patches/` is outside the pin): a `patches/SHA256SUMS` verified by the same three
  checks `acv_verify_vendor` already runs, in the same order — manifest hash from `PINNED_SHA`
  first, then `sha256sum -c`, then the file set **both ways**. Two deliberate differences from
  `vendor/`: it is **fatal on a clean tree, advisory on a dirty one** (editing a patch is normal
  work; editing `vendor/` never is), and regeneration is a repo commit, never a VPS action —
  which needs saying twice here precisely because this manifest legitimately changes often.
- **A-12** (the deployed site is never re-verified): `accio_verify_deployed`, the same three
  checks over `$ACC_SITE_DIR`, **plus an off-box hash** of the manifest. The on-box half catches
  accident and a partial deploy; only the off-box line resists someone with root, and 082 already
  has that pattern and its wording.

Not implemented because the code belongs in `052_lib_vendor.sh` and `052_lib_build.sh` — R2's and
R3's files, both closed sessions — and rule 1 of this arc is that a packet does not chase a fix
across a boundary. **A-12 is the most valuable unwritten thing in this product:** every other
control in the pin chain exists to decide which bytes get written into `$ACC_SITE_DIR`, and
nothing has ever looked at them afterwards.

#### Verification

- `node --check` on all three patched JS files. `node --test`: **78 pass, 0 fail** (unchanged by
  this packet's edits — none of them touch the gateway).
- Both brand maps re-extracted from their own files and compared as ordered lists: **12 entries,
  identical**. Leak scan over all six language tables: **0**.
- Every marker claim traced to the vendored code it refers to; every count in this entry measured
  with a command, not recalled.
- **No PHP locally**, so `backend/language.php` is not lint-verified. The edit is an extension of
  an existing array literal and the array parses cleanly under two independent regex readers, but
  a real `php -l` is owed — the build runs `php`, so a syntax error would stop S2's first build
  loudly rather than shipping.
- Every local process was one-shot (`node`, `python3`, `bash`); nothing was left listening.

#### Owed to S2 by this pass

- **Switch the language to Dutch, Greek and Simplified Chinese and read the title bar, the error
  page and the balance screen.** That is the fix this pass made and the only place it can be
  confirmed. English proves nothing here — English was never broken.
- **Open the standalone artefact with the network tab recording.** It must make no request to
  `api.github.com`, or to anything else it was not asked to.
- Confirm the About page still renders the upstream credit with its licence link, and that
  `MWC Wallet license.txt` resolves from the served root — it has a space in its filename and is
  reached through an `<a href>`, which is upstream's own pattern but has never been loaded.

As ever: **nothing here has run on a VPS.**

---

### S10 — Theme: "Orbital Dawn" — 2026-08-16 ✅ *(code; never seen in a browser)*

Accio inherited the vendored wallet's look along with its crypto. This packet gives it its own,
without touching a byte of `vendor/styles/`.

Three directions were rendered on the real Accio screen and **Orbital Dawn** was chosen: the
wallet on the night side of a planet, sunrise on the limb below the frame, one warm accent and
nothing else lit.

#### The mechanism — one file, loaded last

`patches/public_html/styles/accio.css` is **added**, not a replacement. It repeats upstream
selectors verbatim and wins on **source order**; where upstream's selector is more specific it
repeats that one too. Upstream's 22 stylesheets stay untouched, so
`git log <PINNED_SHA>..upstream/master` — the only way we review upstream security fixes on a
self-custodial wallet — stays readable.

The alternative was overlaying the 14 colour-bearing stylesheets (4,800 lines) with tokenised
copies. Rejected: it puts our bytes in the way of that diff forever and turns every upstream
colour touch into a manual merge. **The cost of the choice we made is that an upstream selector
rename silently stops matching — but that failure is visible on screen as a violet control**,
which is the loudest failure mode available here and the opposite of the "sed that exits 0"
class this product keeps getting bitten by.

Three hooks, each marked:

| Hook | Why |
|---|---|
| `index.html` — one `<link>`, **last** | order is the whole mechanism; above any link it overrides and the theme half-applies |
| `errors/template.php` — the same `<link>` | the eight error pages carry their **own** copy of the ground, the spinner and the entire message dialog in an inline `<style>`. nginx serves 404 from here, and 503 during maintenance |
| `backend/resources.php` — `$files` entry + `THEME_COLOR` / `BACKGROUND_COLOR` | see below |

#### It is a light-to-dark flip, not a hue swap

Worth stating because it sizes the work. Upstream is a violet gradient ground and violet chrome
with **near-white content panels and near-black text**. Orbital Dawn is dark throughout, so every
`color: rgb(12, 12, 13)` upstream sets on a panel had to be restated — miss one and it is black
text on a navy panel. Coverage was checked mechanically, not by eye: every colour-bearing rule in
the 14 vendored stylesheets was extracted with its selector and its at-rule context and matched
against this sheet. **6 upstream rules are deliberately not restated** — all of them
`color: white` / `stroke: white` on a surface that is still dark or still coloured.

Two things that only that sweep would have found:

- **The row separator** (`section.css`, inside `@media (max-width: 400px)`) is `black` at 0.2
  alpha. A grey hairline on white; invisible on navy. Restated as a real line.
- **The dangerous-confirm fill** carries upstream's `color: white` label. `--acc-danger` (#E4574F)
  is only 3.6:1 under white, so fills that carry white text use a separate `--acc-danger-fill`
  (#C0392F, 5.0:1). Semantic colours are kept off the accent entirely, so "warm" never has to mean
  both *primary action* and *something is wrong* on one screen.

#### `THEME_COLOR` and `BACKGROUND_COLOR` are not decoration

`BACKGROUND_COLOR` is read by more than the manifest: the PWA splash, the Windows tile, the
Safari pinned-tab mask tint, and `scripts/startup_images_creator.js`, which **fills the generated
iOS launch images with it** before drawing the white mark. Left violet, the installed app opens
with a violet flash into a navy wallet every single time. `THEME_COLOR` was upstream's `#FFFFFF`,
i.e. a white browser bar above a near-black page on every mobile browser.

#### The `$files` entry earns its place

Without one, `getChecksum()` returns the empty string and the theme ships un-SRI'd — but that is
the smaller half. `$files` is also what `scripts/service_worker.js` precaches (`Cache => TRUE`)
and what it hashes to derive its **cache version**, so an unlisted stylesheet is a theme that
never reaches a returning PWA user. `_acb_apply_patches` rewrites the Checksum from the staged
bytes and bumps the Version on every build, so the value in the repo is a starting point, not
something maintained by hand.

#### No operator switch, deliberately

A `theme=` config key was considered and rejected. It would double the acceptance surface of a
build nobody watches run, and it would have to be agreed by the standalone build, the nginx layer
and both status screens. **A-11 and A-12 are still open** — `patches/` sits outside the pin, and
the deployed site is never re-verified — and a per-deploy visual variant makes both worse. The
tuning surface is the `:root` token block; a theme change is a token edit plus a rebuild.

#### Hardware wallets are NOT obsolete — checked, because it was asked

The `Hardware` button beside Create and Recover is a real, wired Grin feature, not MWC residue:

- `hardware_wallet.js:8339` returns the Ledger application name **"Grin" / "Grin Testnet"** for
  `GRIN_WALLET_TYPE`, next to MWC's and Epic's.
- `hardware_wallet.js:5973` uses `SLATEPACK_ADDRESS_TYPE` for Grin when finishing a transaction —
  Grin-specific, not a fallthrough.
- The wallets rail renders **`.ledger` / `.trezor` watermarks** on hardware rows
  (`unlocked.css`), and the message dialog has a PIN-matrix widget for them.
- `HardwareWallet.isSupported()` gates on WebUSB/WebBluetooth, so a browser without either gets a
  clear error rather than a dead button.

This confirms `script052_design.md` line 373 by a second route. **What the repo cannot tell us** is
whether that Ledger app is installable from Ledger Live's catalogue today — that is a live check,
listed below. Do not delete this surface on a guess; deleting it removes a working feature.

#### Verification

- The build's own table rewriter run for real: `_acb_set_resource_entry` sourced from
  `052_lib_build.sh` and pointed at the patched `resources.php` with the new key → **exit 0**,
  `Version` 1 to 2, `Checksum` replaced. That is the "checksum refreshed" path, and it proves the
  entry's tab formatting matches what the awk expects.
- Stylesheet: braces balanced (173/173), **every `var(--acc-*)` used is defined and every token
  defined is used**, zero upstream violet literals left, **zero `url()`** (the standalone inliner
  only rewrites the double-quoted form, so a bare or single-quoted one would ship as a dead
  reference in the offline artefact).
- Coverage sweep as described above: 6 rules deliberately unrestated, each read and named.
- The standalone fold was traced, not assumed: phase G discovers stylesheets by scanning
  `<link … href="./….css">` in `index.html`, and the standalone env sets `NO_FILE_VERSIONS`, so
  the `?N` that a hosted build appends is absent and the new link folds like the others.
- `vendor/` verified untouched (`git status --short -- web/052_accio/vendor/` is empty).
- **No PHP locally**, so the two edited `.php` files are not lint-verified. Both edits are an
  added array entry and an added `<?php /* … */ ?>` comment between two existing tags; a real
  `php -l` is owed, and the build runs `php`, so a syntax error stops S2's first build loudly.
- Every count in this entry was measured with a command, not recalled.
- Every local process was one-shot (`python3`, `openssl`, `bash`); nothing was left listening.

#### Owed to S2 by this pass

**Nothing in this packet has been seen in a browser.** It is CSS against a DOM read from source.

- **Look at the unlocked screen.** The whole flip depends on `main > div.unlocked > div > div > div`
  being the one rule that paints both content panels. Read from source; never rendered.
- **Tab through it.** `:focus { outline: none !important }` is upstream's, in the inline `<style>`,
  so every focus ring here is a `box-shadow`. If one group was missed, that control has no visible
  focus state at all.
- **Open a message dialog** (send confirmation, or a seed phrase). Its container, its `h2` and its
  `p` are styled in `index.html`'s inline `<style>`, not in `message.css` — a different override
  path from everything else, and the screen where a seed is read.
- **Force a 404 and a 503.** That is the only way to confirm the `errors/template.php` link
  resolves; the leading-dot idiom is upstream's, but ours is the first line to use it for a file
  upstream never had.
- **Install the PWA** and watch the splash. That is `BACKGROUND_COLOR` and
  `startup_images_creator.js`, and nothing else exercises it.
- **Narrow the window below 400px** for the separator rule, and check the "Remind me later"
  variants in the notification bars — both live only in `max-width` media queries.
- **Plug in a Ledger** and see whether a `Grin` app is installable and connects. If it is not
  available to ordinary users, the honest move is a note beside the button — not deleting a
  working code path.

As ever: **nothing here has run on a VPS.**

#### S10 review pass — 2026-08-16 ✅ *(five defects found in this repo's own theme, all fixed)*

Re-read of everything S10 wrote, against `vendor/`, not against memory. The sweeps that
produced the S10 entry were re-run and **agreed** — 199 colour-bearing vendor selectors, 6
unrestated, all `color/stroke: white` on grounds that are still dark. The defects were in
what those sweeps could not see.

- **The dawn never rendered. `body` was flat `--acc-space`.** All three gradients — both
  `body` layers and the `::before` terminator — were entirely transparent inside the
  viewport. "Centred below the viewport" was the whole check, and it is not sufficient:
  colour reaches only `last-stop × ry` back from the centre, so with `cy 152% / ry 62% /
  last 68%` the colour stopped at `y = 110%`, i.e. below the frame. Every pixel of the
  viewport sat past the last stop. Recomputed to `y = 61%` (glow fills the bottom 39%);
  the six numbers now carry the arithmetic in a comment, because the failure mode is
  **silent** — a flat dark background reads as a deliberate design, not as a bug.
  ⚠ **The published mockup has the identical values, so it had the identical bug**: what
  was approved as "Orbital Dawn" was flat navy plus the warm accent. Making the gradient
  render is a *visible change from what was signed off*, and is flagged to the operator as
  such rather than presented as a repair.
- **The top menu was near-invisible: `#2A1405` ink on `#0F1226`, 1.2:1.** Upstream's base is
  `background: #6000D5; color: white`, and every QUIET button (the menu rail, the language
  picker) overrides *only* the background at a higher specificity — white was legible on
  violet and on the rail alike. Our base ink is deliberately dark because it sits on a light
  accent fill, so every quiet button that did not restate `color` inherited near-black onto
  a near-black rail. The primary navigation was unreadable until hovered. `box-shadow`
  leaked the same way and haloed transparent buttons.
  **This class of defect is invisible to a colour-coverage sweep**, which only looks at
  selectors upstream *sets* a colour on; here the bug is upstream setting *none* and relying
  on a global default we changed. It was found by resolving `color` / `background` /
  `box-shadow` per-property, per-button, across all 31 button contexts. That per-property
  resolution is now the check to repeat after any upstream bump.
- **The message dialog overflowed its parent by 2px.** `aside.message > div > div` is sized
  `width: calc(100% - …)` under `box-sizing: content-box` (upstream sets `content-box`
  explicitly), so the 1px hairline added to it added 2px to the computed width — on the one
  screen that shows seed phrases and send confirmations. Replaced with an `inset` box-shadow
  ring, which costs no layout; the same swap was made on the four notification bars (safe
  there, since `left:0; right:0` gives them an auto width, but uniform is cheaper to review).
- **The "verify you are on the right site" banner was below AA, and worse than upstream.**
  `--acc-ok-deep` `#3E9C84` under `--acc-ink` is 3.4:1 (upstream's `#179D2E` is 3.6:1 under
  white). Added `--acc-ok-fill` `#2A7159` — 5.0:1 under our ink, 5.8:1 under the pure white
  that upstream's un-restated `> a` rule still sets. Same defect class as the `--acc-danger-fill`
  split S10 already made: **a semantic colour that is a dot on a dark ground cannot also be a
  fill under light text.** Every fill that carries text is now a separate token.
- **A stray accent glow on transparent controls** — the section back/forward arrows, the
  transaction nav arrows, the language picker, and the wallets-rail new/order buttons all
  inherited `--acc-glow` from the base rule. Set to `none` explicitly.

Checked and found correct, so they are not defects: the `<link>` is genuinely last in both
`index.html` and `errors/template.php`; the `$files` entry matches all 21 sibling stylesheets
(`Cache TRUE`, `Minified FALSE`); `_acb_apply_patches` pass 1 uses `find … -type f`, so an
**added** file is overlaid and pass 2 refreshes its SRI (an added file was the one case worth
confirming); the committed checksum matches the file byte-for-byte; the CSP is
`style-src 'self' 'unsafe-inline'`, so a same-origin sheet needs no policy change; the theme
contains no `url()`, `@import` or absolute URL; the hover idiom is `any-hover: hover`, matching
upstream's 22 uses exactly — a `hover: hover` mismatch would have left upstream's violet hover
colours live on hybrid touch devices; upstream's base `button` already carries
`border: 0.15em solid`, so restating it as `transparent` changes no geometry; and
`:focus { outline: none !important }` is real (`index.html:782`), which is why every focus
state here is a `box-shadow` and not an outline.

Two knowingly accepted: `--acc-faint` on a panel is 3.6:1, used only for placeholders and
disabled controls (WCAG exempts disabled, placeholders are advisory); and the toggle switch
inherits the dark ink, which is inert because it carries no text — verified, it has no
`content` and its knob is a `> span`.

**Contrast is now computed, not eyeballed** — 13 ground/ink pairs, all ≥ 4.7:1 except the two
noted above. The suite (braces, every token defined *and* used, zero upstream colour literals,
zero `url()`, per-property button resolution, coverage sweep, contrast table) is re-runnable
and was re-run after the edits.

**None of this changes the standing position: the theme has still never been seen in a
browser.** Four of the five defects would have been obvious in one screenshot; that is the
argument for S2, not against the review.

---

### Post-S10 maintenance — 2026-08-17 → 2026-08-22 ✅ *(logged retrospectively 2026-08-24)*

Three commits touched Accio after the S10 review and **none of them wrote an entry here**, which
is the handoff rule this file opens with. Recorded now so S2 opens on a doc that matches the
tree. Nothing below changes behaviour; the entry exists so the next session does not have to
re-derive that from `git log`.

| Commit | Date | What |
|---|---|---|
| `0ad5564` | 08-17 | the four **"Duo"** mark SVGs + `patches/README.md` |
| `7a37cd1` | 08-21 | comment audit batch A7/A8 — build, vendor, gateway, nginx |
| `b69d3c2`, `6451408` | 08-21/22 | comment audit tail; four gateway files rewrapped |

**The Duo mark (`0ad5564`) is fully documented — in `patches/README.md`, not here**, and that is
the right place by R8's own rule: a patch author looks at the patch tree, not at a 3,700-line
session log. The README gained a section explaining why the mark is a **pair of discs** and why
that is a security property rather than decoration (Accio and Fidelius have opposite custody
models, their old marks were the same path in two hues, and hue is the first signal to fail at
16 px or for a colour-blind viewer). The load-bearing geometry — `r_black 56.16`, `r_violet
49.14`, centres `105.62` apart, front ring `0.32` clear of the back edge — is recorded there
too, along with the trap: **two faces in one disc restores the exact Fidelius circle and throws
the distinction away.** Judge a redraw at 16 px, not at 128.

The stale `Checksum` those four SVGs left in `backend/resources.php` is **not a defect and needs
no action** — `_acb_apply_patches` pass 2 recomputes SRI for every overlaid file from the staged
bytes, SVGs included, so the committed value is a starting point exactly as it is for the theme.
Confirmed by reading the loop, which is driven by `patched[]`, not by a fixed list.

**The comment-audit commits were diffed file by file: comment-only, zero behaviour change.**
`listen_route.js`, `server.js`, `socks5.js` and `tor_route.js` were rewrapped and two of them had
a stale parenthetical corrected ("R7 clamped it to 128 KB" → "R7 dropped the *default* to 128
KB", which is what R7 actually did). No executable line moved.

**Verified 2026-08-24, on the tree as it now stands:** `bash -n` 5/5 · `node --check` 9/9 ·
`node --test` **78 pass / 0 fail** · `sha256sum -c vendor/SHA256SUMS` 274/274, zero mismatches ·
`git status --short -- web/052_accio/vendor/` empty · the two brand phrase maps parsed out of
`backend/language.php` and `scripts/language.js` and compared as ordered pairs — **12 entries
each, identical, same order** · no `TODO`/`FIXME`/stub anywhere in the product · working tree
clean.

**The standing position is unchanged: nothing has ever run on a VPS.**
