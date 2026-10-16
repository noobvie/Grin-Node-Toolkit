# Script 07 — Public Mining Pool (Security Audit)

> **Covers code as of:** 2026-09-06 · **Last verified:** never verified as a whole — individual findings carry their own dates in the Status roll-up. One scoped exception: **2026-09-07, PARTIAL — §B's two satellite claims only**, read against the code (`requireSatellite` exists nowhere in `back-end-pool/`; `validateConfig()` in `lib/config.js` throws on a missing `jwt_secret` unconditionally, with no role gate). Nothing else in §B, and no §J finding, was re-checked. A second: **2026-09-23, PARTIAL — the three "still true" claims in the §17 pointer notes only** (Status roll-up + head of the §J3 resolution pass), read against `lib/owner-proof.js` (`first_seen_at` is only ever INSERTed — true that day, amended by Part 4 the same evening: a returning evicted anchor now UPDATEs it to `now`, see design §17.7 #3; `_makeRoom` flags an anchor, never deletes it; the lockout counters are keyed per (address, origin)) and `index.js` `requireBothProofs` (refuses `slot === 'anchor'` and any leg younger than the floor). The findings themselves were not re-checked. A third: **2026-09-23, PARTIAL — the five *Superseded* notes of the payout-rails fix only** (§H3, §J3-9, §J4-7, §J12-12, §J13 row 3), each read against `lib/wallet-tor.js` (defaults, `REASONS`, `classifyProbeError`) and the `index.js` tor-check route and withdraw gate as of that day's uncommitted diff. The findings underneath were not re-checked. A fourth: **2026-09-23, PARTIAL — the new Status roll-up note "hub move + connect-page latency" only, and only the claims read in code that session**: the suggest route in full (`index.js` — no logging, `private, no-store`, public limiter, `basis: 'unavailable'`), the probe `maxconn 2000` and file paths in `07_lib_gateway.sh`, the page and admin `connect-src` lines in the pool script, and `PBK_INCLUDE_CERTS` being raised only in the migrate path. The migration guards' order, the cert-archive checks and the re-resolve unit hardening are **the build sessions' own claims**, and the note says so; nothing in it is a review finding. A fifth: **2026-09-23, PARTIAL — the "Part 9 review" block under that note only**: its C1–C6 each reproduced by a failing local harness scenario before the fix and passing after (Git-bash, fakes for systemd/tar/curl/probes, real `node:sqlite`; nothing on a VPS), its P-items and "checked and holds" lines read in the code that session; its P1 row re-verified 2026-09-24 the same way (failing Migrate OUT scenarios first, passing after). The note's other bullets were not re-verified. A seventh: **2026-09-24, PARTIAL — the "§18 Part 6 review" block only**, written by that review session against the code (R6-1 seen failing in a test before the fix and passing after; R6-2's cache header read in the pool script's `/uploads/` block and the Express fallback; the fuzz and stub-DB runs are that session's own, one-shot, outside the repo). A sixth: **2026-09-24, PARTIAL — the Status roll-up note "Donations v2 replaced that surface" only**, written by the §18 Part 3 build session against the code it describes (the nine admin route guards and the image route's headers read in `index.js`, the admin snippet's `img-src` in the pool script — unchanged, `'self' data:` — and `npm test` 1310/1310). Nothing in it is an audit finding. An eighth: **2026-09-25, PARTIAL — the Status roll-up note "Payout path changed after §J closed — Tor payout hardening F1–F5" and the dated update under §J9-8 only, by the Tor-payout-hardening docs-fold session**: each claim read in the working tree that session (the kernel backfill's `confirmed` test, the watchdog constants and repost argv, the shortfall/tor-down constants, `STEP_UP_SETTINGS_SECTIONS` holding `payout`, the admin-row strip, the live `PoolSettings.defaults.payout` key list against `applyToConfig` + `lib/dormancy.js`, and `withdrawal_retry_delays` grepped absent from every admin page); `npm test` exit 0. The grin-wallet source facts (kernel written at lock, `get_stored_tx`'s empty `sigs`) are the build sessions' reads, not re-checked. The note is a change record, **not** an audit. A ninth: **2026-09-25, PARTIAL — the Status roll-up note "Slatepack rail: a lost tab, and the expiry sweep's wallet cancel" only**, written by the session that built it, against that code: `test-payout-guard.js` 256/256 and `test-public-leakage.js` 116/116, every `scripts/test-*.js` passing, and 6 of the new cases seen failing against the reverted scheduler. It is a change record, not an audit; nothing else in this file was re-checked. An eleventh: **2026-09-26, PARTIAL — the "Session 4's open items, as of the operator-approved follow-up fixes" list only, by the session that made those fixes**: each FIXED item seen failing in its own test before the fix and passing after, `npm test` exit 0 (21 suites, 1932 checks). A change record, not an audit. A twelfth: **2026-09-26, PARTIAL — the "Pre-test review, same day" bullet of that list only, by the pre-test review session**: the argv read in `lib/wallet-tor.js` after the edit, and the v5.5.0 `src/bin/grin-wallet.yml` + `Cargo.lock` (clap 2.34.0) fetched raw from GitHub that session; the new argv checks seen failing on the old code with both controls passing; `npm test` exit 0 (21 suites, 1942 checks). A change record, not an audit. A tenth: **2026-09-26, PARTIAL — the Status roll-up note "Payout path changed again — Tor payouts: one attempt" and the one-line dated addition to the F1–F5 note only, by the one-attempt docs-fold session**: each claim about the code was read in the working tree that session (`walletBin`; the earlier-attempt hold in `sendWithdrawal`; outcomes B/C/D; `resolveHeldTor` and the 600 s gap; `migrateLegacyTorRetries`; `forceRefundHeld`'s refusals and the route's `freshAdmin` + `confirm_id`; the admin cancel refusals; the retry 410; the pause 429's place before the probe; `_assertNoRecentReversal`'s Tor exemption; `_torAttemptWindows`, `_otherTorAttemptAt` and `FEE_MOD`; the unit's missing `KillMode`), and `npm test` was re-run (exit 0, 21 suites, 1900 checks). The R1 reproduction, the R2–R9 verdicts and every grin-wallet source fact are **the review session's own claims, not re-checked**. It is a change record, not an audit. A thirteenth: **2026-09-27, PARTIAL — the Status roll-up note "Independent /review of the payout path" only, by the session that ran the review and made the fixes**: the findings read in the working tree and five reproduced by a one-shot harness against the real scheduler; the grin-wallet v5.5.0 facts read in the upstream source fetched that session; each fix's non-control checks seen failing on the old code, `npm test` exit 0 afterwards. A fourteenth: **2026-09-27, PARTIAL — the Status roll-up note "Slatepack finalize binding" and its two in-place annotations (§E.3 item 5, §J4 *Verified correct*) only, by the session that found and fixed it**: both finalize paths read in the working tree after the edit and in the committed `HEAD` before it; the attack reproduced in `test-payout-guard.js` against the real scheduler with only the wallet faked (8 checks failing on the old code); grin-wallet v5.5.0 `cancel_tx_and_outputs`, the foreign `finalize_tx` and `update_stored_tx` read in the upstream source that session; `npm test` exit 0 afterwards. A fifteenth: **2026-09-28, PARTIAL — the Status roll-up note "Surface added after §J closed — the /play/ games platform" only, by the design §19 Part 11 review session** (which built none of the games code): each finding and "holds" claim read in the working tree; P11-1 and P11-2 each covered by new tests of the fixed path (not run against the pre-fix code); games `npm test` 921/921, pool 2330/2330; nothing run on a VPS. Nothing else in this file was re-checked. A sixteenth: **2026-10-04, PARTIAL — the P11-4 status and the "v2 Part C1" block (D22-1…4) only, by the session that built Part C1**: each claim read in the working tree that session; D22-1…3's new tests seen failing against the product files at HEAD and passing after; D22-4 read in `page.html`, `post.html`, `lib/pages.js`, `lib/posts.js` and the `index.js` CMS routes; pool `npm test` exit 0. A change record, not an audit. A seventeenth: **2026-10-04, PARTIAL — the "v2 R1 review" block and D22-4's status cell only, by the R1 review session (which built none of C1–C4)**: each claim read in the working tree that session; the nav matrix rendered in headless Edge against a loopback server; the name rule run through both copies side by side; R1-1 and R1-2 each seen failing on a scratch copy of the old rule and passing after; pool `npm test` 2795/2795, games 1114/1114. Nothing else in this file was re-checked.
> **Product code last changed:** 2026-10-04 (games v2 R2 review — **R2-1 fixed**: the guest per-name failure budget is reserved before the scrypt await and the current-password check is single-flight, games `lib/guests.js` + `lib/ratelimit.js`; see roll-up rows R2-1, R2-2; uncommitted, not VPS-tested). Same day: 2026-10-04 (games v2 Part C7 — the chat bubble, and **D22-4 fixed**: the CMS page/post bodies render in a frame sandboxed without `allow-scripts`, `public_html/js/cms-frame.js`; see roll-up row D22-4; uncommitted, not VPS-tested). Same day (games v2 R1 review — the shared name rule's pool-name fold and two EXCEPTIONS, both copies + the fixture; see the roll-up block "v2 R1 review"; uncommitted, not VPS-tested). Same day, games v2 Parts C2–C4 (launch state, names v2, donor names; **not audited here** — R1 above is their review). Same day (games v2 Part C1, design §19.17 D22 — the `code` ad type and the custom-HTML sinks deleted, provider values and ad URLs pattern-checked; see the roll-up block "v2 Part C1"; uncommitted, not VPS-tested). 2026-09-28 (games platform, design §19 Parts 7–10 and the Part 11 review's fixes — `play/**`, `back-end-pool/lib/games-link.js`'s global caps, the pool menu; reviewed in the Status roll-up note "Surface added after §J closed — the /play/ games platform"; uncommitted, not VPS-tested). 2026-09-27 (admin cancel refuses `tor_failed` — closes the /review's Low item "admin cancel on `tor_failed`"; payout rows name their rail on the account ledger and admin payments page; impl §10.10; **not audited here**, uncommitted, not VPS-tested). Same day (Slatepack finalize binding — both finalize paths fail closed when the row or the reply has no slate id; see the roll-up note "Slatepack finalize binding"; uncommitted, not VPS-tested). Same day (the /review fixes #1–#6 — Held refunds, the Tor send lock, CLI stdout, `tx_slate_state` in the forced refund, the audit's NET compare, the 360 s timeout; see the roll-up note "Independent /review of the payout path"; uncommitted, not VPS-tested). 2026-09-26 (pre-test review: the Tor send / repost argv in `lib/wallet-tor.js` fixed for grin-wallet v5.5.0's CLI spec; see the last bullet of the roll-up list "Session 4's open items…"; **not audited here**, uncommitted, not VPS-tested). Same day (follow-up fixes: payout alerts on the health card, `auditWalletSends` without `tor_failed`, capture on attempt windows, two pending-cap validators, 90 s nginx timeout for the withdraw POST, `socks` removed; see the roll-up list "Session 4's open items…"; **not audited here**, uncommitted, not VPS-tested). Same day (Tor payouts: one attempt, Held, Tor pause, Slatepack offer; stepwise F5 and the retry ladder deleted; `walletBin` fix for mainnet payout #10; the Session 4 review's attempt-window matcher fix; see the roll-up note "Payout path changed again"; **not audited here**, uncommitted, not VPS-tested). 2026-09-25 (slatepack rail: stored encrypted S1 + ownership-gated re-fetch route, expiry refunds before it cancels, `slate_cancel_pending` retry sweep, guarded `slate_id` attach on both Owner-API create paths; see the roll-up note "Slatepack rail: a lost tab…"; **not audited here**, uncommitted, not VPS-tested). Same day (Tor payout hardening F1–F5 — kernel only once confirmed, the `payout_unmined` watchdog + CLI repost, uncounted shortfall retry, `auto_payout`/`payout_frequency` deleted, step-by-step Tor send behind `tor_send_mode`; see the roll-up note "Payout path changed after §J closed"; **not audited here**, uncommitted, not VPS-tested). Same day (Tor rail: an exit-0 slatepack fallback is no longer marked paid — see the roll-up note. Also: §J11-2 pool-wide half reversed — `/api/pool/payments` publishes a shape-checked `kernel_excess` for the P-05 Tx ID column; see the note under J11-2). 2026-09-24 (hub move, Part 9 P1 — Migrate OUT removes the weekly VACUUM cron and refuses while a vacuum runs; `07_lib_pool_migrate.sh`; see the "Part 9 review" block). Same day (donations v2, §18 Part 6 review fix R6-1 — `requireBothProofs` refusal code `match` → `wrong_kind`; see the "§18 Part 6 review" block). Same day (donations v2, design §18 Parts 1–3 — per-share donation, donor-profile backend + uploads, admin review queue + image route, v1 censor/rescan removed, admin CSP unchanged; see the Status roll-up note "Donations v2 replaced that surface"; **not audited here**, uncommitted, not VPS-tested). 2026-09-23 (Part 9 review fixes C1–C6 — `07_lib_pool_migrate.sh`, `07_lib_pool_backup.sh`; see the "Part 9 review" block). Same day (hub move + connect-page latency — `07_lib_pool_migrate.sh` NEW, `07_lib_pool_backup.sh`, `07_lib_gateway.sh`, the pool script, `lib/db.js`, `index.js`, three new pure libs, `reactor-dashboard.js`; design §13.13, impl §8.7; see the Status roll-up note; **not audited here**, uncommitted, not VPS-tested). Same day (payout-rails fix, impl §10.5: `create_slatepack_message` named params; Tor probe ported from 06d — 8 s, fresh circuit per attempt, real `check_version`, proxy-silent timeout → `null`; tor-check `?fresh=1`; no probe on account-page load — see the Status roll-up note; the changed surface is **not audited here**, and not VPS-tested). Same day (ownership-proof SET, `script07_design.md` §17 Parts 1–3, built 2026-09-22/23, and the Part 4 review's three fixes the same day (design §17.7): the 2-slot proof window this file's §E/§F/§J3 reason about is replaced by a set of up to 10 per kind with a per-address salt — see the Status roll-up note; **not audited here**, and not VPS-tested). 2026-09-21 (donor names + donor league, design §16 Parts 1–5: Part 1 login grammar — worker part case-folded, label cap 25 → 32, raw 40 → 48, `donor_label` field; the five limit statements in §J6-1, §J6-9, §J6-13 and the §J6 Handoffs updated in place. **Parts 2–4 added surface this file has NOT audited** — a public free-text name on `/api/pool/donors` + `/api/account/:addr`, two `freshAdmin` write routes, six settings incl. an operator word list, a rescan hook — see the Status roll-up note "Surface added after §J closed"; Part 5's review of it lives in design §16.12). 2026-09-20 (share credit unit; one shared `MinerManager` — §J6 addendum) — `scripts/07_grin_mining_*.sh`, `scripts/lib/07_lib_*.sh`, `web/07_mining_pool_public/`

Security model, verified upload/XSS fixes, and the hardening requirements for
`web/07_mining_pool_public/`. Design: [`script07_design.md`](script07_design.md);
deploy/runbook: [`script07_implementation.md`](script07_implementation.md).

> Two kinds of items below: **(A) Verified fixes** — found and fixed in the toolkit's actual
> code (white-label upload work, 2026-06). **(B) Hardening requirements** — the standing
> security model the pool must satisfy (distilled from the Grinium design review + production-pool
> validation against `grin-pool` / `open-grin-pool`). Treat (B) as the audit checklist; verify each
> against current code before mainnet.


> **Closed findings live in [`script07_security_audit_archive.md`](script07_security_audit_archive.md).** Every finding whose status is FIXED / CLOSED / BUILT / NOT REACHABLE moved there verbatim (142 of them, grouped by audit section); each leaves its heading and a one-line pointer here so §-references still resolve. This file keeps the Status roll-up, the trust model and hardening requirements, every open / partial / ruling / accepted finding, and each section's scope, threat actors, handoffs, verification and resolution passes.

---

## Status roll-up — read this first

The §J pass below is 17 sessions and ~13 000 lines. This table is the whole of it: what each
session found, and what it left open. **Folded in here on 2026-09-06** from the pre-mainnet run
plan (`script07_reference_audit_session_plan.md`), which was a session-scaffolding file and has
been deleted now that all 17 sessions are run — the §J sections below *are* the evidence record,
and this is its index. Session scope descriptions live in each §J section's own opening paragraph.

**Where it stands:** all 17 sessions run (2026-08-25 → 2026-09-04). §J17's desk-audit verdict was
**NO-GO for mainnet**; a follow-up resolution pass then closed 10 findings across
§J1/§J4/§J7/§J8/§J9/§J13/§J17, including all three single-box **High** blockers. **No code blocker
remains. What is left is the runbook on a real box** — and the standing repo-wide caveat still
applies: none of this has ever been VPS-tested.

| # | Session | Owner/date | Findings | Status |
|---|---|---|---|---|
| J1 | Route & guard matrix | 2026-08-25 | 10 (1 High, 2 Med, 5 Low, 2 Info) · **6 fixed, 4 open** (J1-2 partial, J1-4, J1-5, J1-7) | ☑ done |
| J2 | Auth, session & 2FA | 2026-08-25/26 | 8 (1 High, 4 Med, 2 Low, 1 Info) · **all closed**; §C3 still carried | ☑ done |
| J3 | Ownership gate & account API | 2026-08-26 | 9 (4 High, 1 Med, 3 Low, 1 Info) · **all fixed** | ☑ done |
| J4 | Payout execution | 2026-08-26/27 | 11 (1 Crit, 3 High, 2 Med, 4 Low, 1 Info) · **6 fixed, 5 open** — J4-3 + J4-10 are **High** | ☑ done |
| J5 | Reward & orphan ledger | 2026-08-27 | 11 (1 Crit, 2 High, 5 Med, 2 Low, 1 Info) · **all fixed**; J5-11 post-distribution reorg is an accepted risk | ☑ done |
| J6 | Stratum & share intake | 2026-08-27 → 09-01 | 13 (2 Crit, 1 High, 4 Med, 5 Low, 1 Info) · **all fixed** | ☑ done |
| J7 | DB, SQL & amounts | 2026-09-01 | 10 (1 High, 5 Med, 2 Low, 2 Info) · **6 fixed, 4 open** — J7-1 is **High**; J7-8 closed by J9-5 | ☑ done |
| J8 | Secrets & key management | 2026-09-01 | 7 (1 High, 3 Med, 1 Low, 2 Info) · **3 fixed, 3 open**; J8-1 shell half done in J16 | ☑ done |
| J9 | Settings & config integrity | 2026-09-02 | 9 (1 High, 3 Med, 4 Low, 1 Info) · **6 fixed** (J9-1 by deletion), 3 open | ☑ done |
| J10 | Uploads, assets, CMS & ads | 2026-09-02 | 6 (4 Med, 1 Low, 1 Info) · **3 fixed, 2 open** (J10-2, J10-3; J10-3 partly taken by J14-9) | ☑ done |
| J11 | Public API leakage & privacy | 2026-09-02 | 9 (1 High, 4 Med, 1 Low, 3 Info) · **all fixed**; J11-6 nginx half taken by J16; **J11-2 pool-wide half reversed 2026-09-25 by operator decision** (public Tx ID column) | ☑ done |
| J12 | Rate limiting & exhaustion | 2026-09-02 | 12 + 2 Info · **all 14 closed** | ☑ done |
| J13 | Outbound, SSRF & deps | 2026-09-03 | 10 (1 High ruling, 4 Med, 3 Low, 2 Info) · **4 fixed, 6 open/partial**; J13-2 is a standing ruling, not a bug | ☑ done |
| J14 | Admin panel front-end | 2026-09-03 | 11 (2 Med observability, 1 Med CSP, 6 Low, 2 Info) · **9 fixed, 0 open** (7 in-session + J14-4/-9 in a same-day follow-up) | ☑ done |
| J15 | Public front-end | 2026-09-03 | 12 (3 Med, 7 Low, 2 Info) · **10 fixed**; J15-3's static-HTML half + J15-10's third-party link left as product decisions | ☑ done |
| J16 | Deployment & infra | 2026-09-03 | 14 (1 High, 3 Med, 7 Low, 3 Info) · **9 fixed, 2 open**; J16-2 (hostile gateway holds both ownership-proof legs) and J16-4 (three disconnected admin allowlists) are dispositions for the operator. §J8-1 items 1+3 applied, **item 2 refused with reason (J16-12)** | ☑ done |
| J17 | Pre-mainnet operational gate | 2026-09-04 | 8 (2 High, 3 Med, 1 Low, 2 Info) · **7 fixed, 1 open** (J17-5, procedure). **VERDICT: NO-GO on desk audit**, then a resolution pass closed 10 findings across §J1/§J4/§J7/§J8/§J9/§J13/§J17 — including all three single-box High blockers. No code blocker remains; what is left is the runbook on a real box | ☑ done |

**Surface added after §J closed — donor names + donor league (design §16, built 2026-09-21).**
Four build parts added, in one day: a public **free-text field** on the wall and the account API
(a donor's opt-in name — the label of a `<label>-donateN` login, charset `[a-z0-9_-]{1,32}`),
six `donor_*` columns, two admin **write** routes (`POST /api/admin/donors/:addr/censor|uncensor`,
`freshAdmin`, audited), an admin read route + summary, six `incentives` settings incl. an
operator-editable word list, and a rescan hook on the settings save. **None of it has had a
§J-style session.** Its only review so far is the design's own Part 5 pass, recorded in
**`script07_design.md` §16.12** (2026-09-21): stranger-write trace, public leakage field list,
censor state table, ranking recompute, type traps, `EXPLAIN QUERY PLAN` on every new query,
panel + public-page rules — two findings (a per-name list re-parse that cost ~1 s of the shared
synchronous connection per list save at the validator's ceiling; a separators-only name shown as
`-`), both fixed. That pass is a review against the design's own security notes, not an
adversarial audit: the next §J-style session should take §16 as its scope. Not VPS-tested.

**Donations v2 replaced that surface (design §18, Parts 1–3 built 2026-09-24).** Donor names
are **pre-moderated** now. The §16 note above is history for the donor-name half: the censor
routes, the rescan hook, the censored marker and the `donor_censored_display` setting are
deleted, and the six v1 columns are unread. The new surface:
- donor-profile uploads: PNG/JPEG/GIF sniffed from bytes, header-parsed dims, 300 KB multer cap;
- three ownership-gated miner routes;
- nine admin routes: four `secureAdmin` reads, including an image route that serves pending
  bytes with the stored mime + `nosniff` + `default-src 'none'; sandbox` + `no-store`, and five
  `freshAdmin` writes audited in-transaction.

**No header change.** The admin CSP stays `img-src 'self' data:`, and `test-admin-panel.js` pins
the absence of `blob:`. The review queue shows banners from a plain same-origin `<img src>` on the
admin image route. The `SameSite=strict` session cookie carries auth there, so the route's
headers (stored mime, `nosniff`, `default-src 'none'; sandbox`) govern every way the image is
viewed, including opening it in a new tab. A first cut used `adminFetch` → blob → object URL
with `blob:` added to the CSP. It was reverted the same day, because an object URL copy loses
those headers (design §18.11 Part 3 #1).

**None of §18 has had a §J-style session.** Its security notes are design §18.9, and the Part 6
review answers them in §18.11. `test-public-leakage.js` §9 pins an inventory of every route that
touches `donor_requests`. Not VPS-tested.

**§18 Part 6 review (2026-09-24, a cold session separate from the builders).** Design §18.11
*Part 6* holds the evidence.
- **Fixed — R6-1.** `requireBothProofs` refused a proof that verified as the *other* kind with the
  verifier's success code, so responses and `auditOwnerProof` rows read
  `ok:false, reason:'match'`. It is `wrong_kind` now, on the Goblin route too, with the refusal
  text unchanged. Tested first.
- **CLOSED 2026-09-24, accepted (operator: won't fix) — R6-2.** Not a vulnerability: banners are
  pre-moderated, the wall drops a removed one at once, and the file name is unguessable. It is a
  takedown-latency cost, kept knowingly. The original finding: `/uploads/` is served `public, max-age=604800,
  immutable`, so a removed or replaced donor banner stays retrievable from browser caches for up
  to 7 days. On a `cloudflare_proxy` pool it also stays retrievable from the CDN edge. The fix
  is a nginx change (a short-cache `/uploads/donors/` block, or a purge on remove) and needs a
  **Setup nginx** re-run.
- **Accepted — R6-3.** GIF per-frame size and frame count are not parsed. The canvas is
  bounded, and every banner is pre-moderated.
- **Notes — R6-4, R6-5.** The admin miner view still ships the dead v1 columns. A donor's public
  account read now runs a full donor-ledger scan, like the wall does.
- **Answered with evidence, found holding:** the money invariants (a stub-DB distribution with
  reconciliation drift 0), the parser (60,043 fuzz inputs, 0 throws, nothing out of bounds), and
  the public field inventory.

**Ownership-proof storage replaced after §J3 closed — the 2-slot window is gone (2026-09-22).**
§E, §F and §J3 reason about a proof store of two slots per kind (`last_*`/`prev_*`) plus a
write-once anchor. On 2026-09-22 that store was replaced by a **set of up to 10 per kind with a
per-address salt** (table `miner_proofs`) — see **`script07_design.md` §17** and impl §10.4. Those
findings are left as written: they record what was true when they ran. Still true: the write-once
**anchor** (J3-4, now an `is_anchor` row flagged `evicted_at`, never deleted), the **AND + AGE**
destination gate (J3-1 — `requireBothProofs` is unchanged, and a refresh never moves
`first_seen_at`, so reconnect churn can no longer reset a leg's age), and the **(address,
origin)-keyed lockout** (J3-3). Superseded: J3-4's two-slot eviction arithmetic ("two accepted
shares evict both slots"), and §F2's per-verify KDF count — now 1 scrypt on a v2-only set (2 for a
non-canonical, password-shaped IP), rising to a transitional ceiling of 8 on a migrated account
while its v1 rows survive (design §17.7 #5; the window's was 6). **Design §17 Part 4 — the
independent review — ran 2026-09-23** and fixed three defects, one of which reaches back into
§J3: the resolution pass's "`backfillProofAnchors` MUST run ahead of the stratum listener" was
never true in the code — it ran after `stratumServer.start()`, behind `await nostrBridge.start()`,
and `migrateProofSet` inherited the spot. It now runs first (design §17.7 #1). The other two: a
racing duplicate capture evicted a second proof (#2), and a returning evicted anchor kept its old
age and so passed as an aged destination leg (#3). Not VPS-tested.

**Payout rails changed after §J closed: the Tor probe and the Slatepack call (2026-09-23).**
An operator test found both miner rails broken, and neither break was in any §J finding.
(1) **Every Slatepack and Goblin payout failed.** `create_slatepack_message` was called with its
positional params in the wrong order, so the wallet refused it. It is now called with named
params. The failure path reversed the lock, so no funds were stranded.
(2) **The Tor probe read a timeout as a confident "offline"**, and the withdraw pre-flight gate
refuses on `false`. So a live wallet's Tor payout could be refused by a pool whose own tor was
merely slow. §J4-7 only covers the `null` case, so no finding here caught it. The probe is now
ported from 06d. It POSTs a real `check_version` over a fresh circuit per attempt, with an 8 s
timeout (was 3 s), and a timeout with no reply from the local proxy is `null`, not `false`. The
tor-check route gained `?fresh=1`, and the account page no longer probes on load.
Findings **§H3, §J3-9, §J4-7, §J12-12 and the §J13 outbound table** state the old timings, reason
codes or probe trigger. They carry a *Superseded* note in place and are otherwise left as written.
Full as-built → impl §10.5. **Not audited here:** whether `?fresh=1` (a 10 s floor, under the
unchanged `torcheck` 10/min bucket) sharpens the wallet-uptime signal §J3-9 accepted, and whether
the ~32 s worst-case probe, against the `/api/` vhost's 30 s `proxy_read_timeout`, can leave a
payout the miner saw fail at nginx. Both are open for the fix's own review. `socks` stays in
`package.json` with nothing requiring it (§J13-8's version list). Not VPS-tested.

**Tor rail marked a failed send "paid" (found and fixed 2026-09-25, not in any §J finding).**
The pool pays out over Tor by running `grin-wallet send -d <addr> -a <amt>`, and it treated
exit 0 as sent. Upstream's `send` (`controller/src/command.rs`, the same in v5.4.1 and v5.5.0)
also exits 0 when Tor delivery fails. In that case it locks the outputs, writes
`slatepack/<slate-uuid>.S1.slatepack` and prints the slatepack. Nothing is finalized, so nothing
posts, yet the row went to `confirmed` with the miner debited. The "paid but not mined" watchdog
could not recover it, because `repost` refuses a tx that was never finalized. The pre-flight probe
made this rare but not impossible: it fails open on `null`, and a wallet can drop between the
probe and the send.
**Fix:** `lib/wallet-tor.js` `classifySendOutput` now counts only the anchored
`Tx sent successfully` line as sent. It tests that line first, so a posted tx is never cancelled.
A fallback returns `success:false` and the slate id parsed from the `.S1.slatepack` path. The
scheduler's `_releaseTorFallback` cancels exactly that slate before `scheduleRetry`. Cancelling is
safe because only the sender finalizes. Without the cancel, the retry's double-send guard reads
the locked `TxSent` as `unconfirmed` and defers the payout indefinitely. That is pinned as a
CONTROL case. With no parsable id, or a failed cancel, nothing is guessed: the row parks and the
guard defers. Unrecognised exit-0 output is a failure and is never cancelled.
Tests: `test-payout-rails.js` (+12) and `test-payout-guard.js` (+11). Both were run against a
copy with the fix reverted, and 5 of the new cases failed there. `npm test` exit 0. Not VPS-tested.

**Payout path changed after §J closed — Tor payout hardening F1–F5 (built 2026-09-25, NOT
AUDITED here, NOT VPS-tested).** A read-only review of the Tor rail on 2026-09-24 found five gaps.
The operator approved all five, and they were built the next day. The full as-built account is
impl §10.8, and the F5 design is design §8.1. This note records only what changed on the money
path, so that the §J findings below are read with it:
- **F1 — the kernel means mined.** `backfillKernelProofs` now stores a kernel only from a
  `confirmed` tx-log entry. It used to take any entry, and the tx log writes `kernel_excess` at
  `tx_lock_outputs`, as the sender's partial excess, and again at finalize. So a public "paid ·
  mined" badge and kernel link could name a tx that never mined. The §J4 and §J11 findings that
  speak of the kernel as proof assumed it was already confirmed-only. Rows written before the fix
  were not re-checked, and on this pool that is testnet only.
- **F2 — the opposite direction of `auditWalletSends`.** A paid row not seen mined after 1 h
  raises one rolling `payout_unmined` alert. It is critical when the wallet cancelled the tx or
  has no record of it. The row gets an hourly `grin-wallet repost -i <id> -f` of the identical
  stored tx: at most 3 rows a tick and 24 per row, never while frozen, and never a new tx, a
  cancel, a refund or a status change. The admin withdrawal list gains `chain_state`, which is on
  no public route. The alert is **not pushed off-box** (§J8-3 still open). Finding: Owner v3
  `get_stored_tx → post_tx` would post a **zero kernel**, because the V4 slate comes back with
  `sigs: []`. That is why the repost goes through the CLI.
- **F3 — a shortfall uses no rung.** `pool_wallet_short` retries in 1 h, uncounted, and after 24
  it takes the ladder. It is checked before the ladder-exhausted test. The double-send guard still
  runs on every re-attempt, and a test pins that. The admin retry route resets `retry_count` but
  not the shortfall count, by design.
- **F4 — §J9-8's `auto_payout` + `payout_frequency` are DELETED** (see the update under §J9-8).
- **F5 — step-by-step Tor send**, behind `payout.tor_send_mode` (default `cli`, step-up gated
  like the rest of `payout`). New money-path surface:
  - Owner v3 init/lock/finalize/post/cancel with **named** params, shared with the Slatepack and
    Goblin rails.
  - An in-process `withSendLock` around init → lock on all three Owner-API rails.
  - Two `withdrawals` columns. `tor_final_slate` is a complete signed tx, stripped from both admin
    row routes and asserted absent from every public route.
  - A `receive_tx` POST to the miner's onion through the system tor, 1 MiB reply cap, absolute
    deadlines.
  - A second uncounted reason, `pool_tor_unavailable` (15 min, cap 24).
  - A stale-sweep branch that re-posts a committed tx at most every 5 min and parks a
    contradiction behind a critical `payout_tor_stepwise` alert.
  - The rule the design proves: nothing is cancelled from `posting` on, and nothing moves to
    `tor_checking` / `retry_scheduled` with a live slate. So the admin cancel route can never
    refund one.
  - Invariant the design adds: the pool wallet's Foreign `finalize_tx` posts on its own, so that
    listener must **stay localhost-only**. Never publish it over an onion or nginx.

**Still owed:** the plan's independent review (it re-reads `_stepwiseCancelThen`,
`_reclaimStaleStepwise`, `_stepwiseReattemptGuard` and the changed stale-age subquery) and VPS
acceptance, testnet first. The next §J-style session on the payout path should take impl §10.8 as
its scope. Two gaps found and left open, both in impl §10.8 *Still open*: the watchdog has no
class for a pre-fix exit-0 row (it reads `unmined` and its repost fails hourly), and
`max_pending_withdrawals` / `max_user_pending` still have no validator.
*(2026-09-26: F3 and F5 are gone, and so are the review items for them above — see the next
note.)*

**Payout path changed again — Tor payouts: one attempt, then an answer (built and reviewed
2026-09-26, NOT a §J session, NOT VPS-tested).** It came from mainnet payout #10. As-built → impl
§10.10; design → §8 "One Tor attempt, then an answer". This note records what changed on the
money path, so that the §J findings are read with it:
- **Payout #10's cause.** `lib/wallet-tor.js` spawned a bare `grin-wallet`. The binary lives only
  in the wallet dir and the unit sets no `PATH`, so every Tor send and every F2 repost was
  `spawn ENOENT`. Nothing was locked or sent. It is spawned from `<wallet_dir>/grin-wallet` now.
- **No automatic re-send exists anywhere.** A Tor payout is sent once. A row with any earlier
  attempt on record (an event, `retry_count` or `slate_id`) is Held and never sent again. The
  ladder, the shortfall and tor-down retries, `scheduleRetry`, `markFailed`, `processRetryQueue`,
  `_deferSend` and the admin retry route (now a 410) are deleted. So is the whole stepwise sender
  (§10.8 F5). This retires the retry half of §J4's re-attempt findings: the matcher no longer
  gates a re-send, it gates a refund or a confirm.
- **Every refund needs proof.** A refund happens on one of these:
  - outcome B: the send's own fallback slate was cancelled;
  - outcome C: `NotEnoughFunds`, and one tx-log read shows no match;
  - Held: absent on two reads ≥ 600 s apart;
  - the startup migration of legacy `retry_scheduled` rows: one read, before any send starts;
  - the operator's forced refund: `freshAdmin`, the id typed back as `confirm_id`, an audit row,
    and a refusal on a confirmed or ambiguous match.

  Unknown → `tor_held`, with the amount locked. The admin cancel route now **refuses** `tor_held`
  and `retry_scheduled`. Before, it refunded a parked Tor row with no wallet check.
- **A double pay found and fixed in review (Session 4, R1).** The amount matcher had only a lower
  time bound. A miner's mined tx could confirm another miner's same-amount Held row. The first
  miner's row then read absent twice and was **refunded on top of a landed send**. This was
  reproduced against the real scheduler before the fix. Fix: a tx counts only inside one of the
  row's own attempt windows (claim → exit, ± 5 s). A tx two Tor rows could own is ambiguous and
  decides nothing. Also fixed, and latent at v5.5.0: the tx-log `fee` is `FeeFields` as a raw
  u64, so it is masked to 40 bits.
- **New surface.**
  - Public, on the account summary: `fail_code` (an enum) and `tor_pause` (counts and one
    timestamp).
  - Public, on the withdraw route: a 429 `tor_paused`, checked before the probe, so a paused
    address builds no circuits.
  - Admin-only: `fail_detail` (the CLI output tail, ≤ 500 chars). `test-public-leakage.js`
    asserts it is on no public route and never named by the account page.
  - Three admin routes: Re-check (`secureAdmin`), force-refund (`freshAdmin`) and pause clear
    (`freshAdmin`). All three are audited.
  - Two alert types, `payout_held` (critical) and `tor_send_path` (warning). Since the follow-up
    fixes they show on the health page's Grin Wallet card. They are still not pushed off-box
    (§J8-3).
- **The cooldown changed.** The 30 min reversal cooldown (§E.2) no longer follows a Tor
  `tor_failed` refund. That refund now needs proof, which is what the cooldown stood in for. Rapid
  Tor retries are bounded by the pause instead: 5 counted `wallet_offline` failures in 24 h
  pause Tor for that address for 24 h.
- **Checked by the review and holding** (Session 4, R2–R9):
  - the only send path is `tor_checking → sendWithdrawal`, and only create writes `tor_checking`;
  - every live pending list has `tor_held`;
  - the gate order is proof → precheck → pause → probe → create, so a stranger without the
    owner's proof cannot trigger a pause;
  - public routes use explicit columns;
  - the unit's default `KillMode=control-group` kills an orphan CLI with the backend;
  - two concurrent Slatepack POSTs create one row.

**Session 4's open items, as of the operator-approved follow-up fixes (same day; impl §10.10
*Follow-up fixes*):**
- **(a) An ambiguous pair (crash mid-send + same net) has no operator exit.** The forced refund
  refuses, and there is no forced confirm. The fix binds a match by the tx's
  `payment_proof.receiver_address`, matched positively only. **Approved, but the build was
  BLOCKED** by the session's permission classifier. It is reverted, still open.
- **(b) FIXED.** `auditWalletSends` no longer counts `tor_failed` as recorded. A confirmed send
  whose only match is a refunded Tor row now trips `unrecorded_wallet_send` and the freeze.
- **(c) FIXED.** `_captureTorSlateId` uses the attempt windows and skips a tx another Tor row's
  attempt also fits.
- **(d) ACCEPTED.** The Re-check and forced-refund audit rows are written after the money move,
  outside its transaction.
- **(e) ACCEPTED.** An IP-proof co-tenant (§J3) can spend the owner's 5 counted failures, but only
  while the owner's wallet really is offline.
- **New, not fixed:** `auditWalletSends`'s `feeNano` subtracts the RAW `FeeFields` u64, R1d's
  latent bug. It cannot bite at v5.5.0, which always writes shift 0.
- Also fixed in the same pass: the two pending-cap validators, and a 90 s nginx read timeout for
  the withdraw POST (its pre-flight probe could outlast `/api/`'s 30 s). `socks` was removed as
  well (§J13-8's list).
- **Pre-test review, same day — FIXED: the Tor send's argv could never have run.** The command
  was `grin-wallet --top-level-dir <dir> send -d <addr> -a <amt>`. grin-wallet v5.5.0 uses
  clap 2.34, which matches long flags exactly: the real flag is `top_level_dir`, and `-a` is the
  top-level `account` flag, invalid after `send`, where the amount is positional. Both are exit-1
  errors before anything is built. It was fail-safe (Held, then a refund on proof), but no Tor
  payout could go out. `repost` shared the bad flag. The code is fixed, and a spec-driven argv
  test was seen failing first. Impl §10.10 *Pre-test review fix*. That session also left four
  PLAUSIBLE items open, listed under impl §10.10 *Still open*: a 120 s send timeout under
  grin-wallet's 180 s worst case (fixed 2026-09-27, below), admin cancel on `tor_failed` (fixed
  2026-09-27, below), ENOENT
  treated as unknown, and no stdin `error` handler.

**Independent /review of the payout path (2026-09-26), and its six fixes (2026-09-27; impl §10.10
*Review fixes*; uncommitted, NOT VPS-tested).** A read-only review of every payout file, with each
grin-wallet behaviour it relies on read in the v5.5.0 source and five findings reproduced by a
scratch harness against the real scheduler. It is not a §J-style session. **Verdict:** no path sends
a Tor payout twice or refunds or debits one twice. Every settle or refund is a status-guarded claim
in one transaction, and the output markers the classifier keys on match the upstream `println!`s.
It found six issues, and the operator had all six fixed. Each non-control check was seen failing
first:
- **High — a Held payout was refunded while payouts were FROZEN**, judged against whatever wallet
  answers the Owner API. A seed recovery, an older wallet backup or a switched wallet reads
  "absent" for a send that landed, so this was a double pay after exactly the events that freeze.
  **Fixed:** no refund while frozen, streaks count only after the last resume, and a history mark
  must still be in the log.
- **High — the Tor CLI ran outside `withSendLock`**, so a Slatepack or Goblin create selected the
  same coins (smallest first, and `lock_output` checks nothing). Two txs spent the same inputs, and
  the losing payout stuck. **Fixed:** the CLI holds the lock for its whole run, and a create during
  it is refused with nothing deducted.
- **Medium — grin-wallet's stdout was dropped on failure.** The CLI prints its errors there, so
  NotEnoughFunds could never reach outcome C and `fail_detail` was always empty. **Fixed.**
- **Medium — the forced refund accepted any unconfirmed match**, including a `Standard2` send that
  may have been posted. **Fixed:** only a `Standard1` bare lock is refunded, and its own fallback
  slate is cancelled first. A failed fallback cancel is now retried, and a Held round-tripped send
  is re-broadcast hourly (one attempt only).
- **Medium — the unrecorded-send audit compared GROSS to NET at ±0.05 GRIN**: a false critical
  alert plus auto-freeze once `withdrawal_fee` > 0.05. **Fixed:** it compares the NET within 1 µGRIN;
  manual rows keep ±0.05.
- **Medium — a 120 s send timeout under grin-wallet's six 60 s waits.** **Fixed:** 360 s.

Still open from that review (Low, impl §10.10 *Still open*):
- admin cancel of a legacy `tor_checking` row with an earlier attempt, reachable only while frozen;
- ~~admin cancel on `tor_failed` hiding a double pay from the audit~~ — **FIXED 2026-09-27**
  (operator request; uncommitted, not VPS-tested): the route answers 409 and the page no longer
  offers it. Test RT6 in `test-payout-guard.js`. Impl §10.10 *Admin cancel on `tor_failed`*;
  **not audited here**;
- `recordTorFee` with no attempt window;
- `isNaN` amount parsing;
- the stdin `error` handler;
- a restore to a point before a send, which no pool record can see.

The next §J-style session on the payout path should take impl §10.10 as its scope.

**Slatepack expiry refunded without asking the wallet (found and fixed 2026-09-27, operator
question; NOT VPS-tested).** A miner's `grin-wallet receive` replies over Tor to the address
inside our S1, calling the pool wallet's Foreign `finalize_tx`, which finalizes **and posts**
(grin-wallet v5.5.0 `foreign_rpc.rs`, `post_automatically = true`) without the backend knowing. The
row stayed `slatepack_pending`, and `processSlatepackExpiry` refunded it at TTL: paid on chain
AND refunded. The expiry `cancel_tx` succeeds on an unconfirmed `TxSent` even after it was posted,
so `slate_refunded_but_mined` never fired. **Not reachable as shipped:** the pool runs `owner_api`,
which publishes no onion (only `listen` does). It would open with one `grin-wallet listen` on the
pool wallet dir, a torrc onion aimed at its owner port, or a hand `grin-wallet finalize`.
- **Fix:** expiry reads the tx log first.
  - `Standard1` → refund.
  - Confirmed → settle as paid.
  - Any later state → hold, with a critical `slate_finalized_elsewhere` alert.
  - Unreadable log → wait.
  - Frozen and absent → wait.
  - State not recorded → refund with a `slate_expiry_unverified` warning (operator's option (a)).
- **Also built:** a grin-wallet version check on the Health card, a *Pool wallet safety* note on
  Payout settings, and a toolkit warning for a Tor path into the pool wallet.
- **Tests:** `test-payout-guard.js` +33 (G1–G12, W1–W6); 16 of the G checks fail against the
  pre-gate scheduler.

Same day, also built: the `slate_refunded_but_mined` "paid twice?" alarm now shows on the Health
card, where before no admin page showed it. It stays there until an admin closes it with **Mark
reconciled** (step-up, a required note, `alert_resolve` audit row). Only that one type can be
closed by hand. The account page tells CLI miners to run `grin-wallet receive -m`, which removes
the Tor reply path entirely. Tests +14 (D1–D9).

Full record: implementation §10.11. **Still open:** a held row that never mines stays locked until
an operator acts, because there is no forced refund for slatepack rows.

**Slatepack finalize binding: a refunded payout could be paid again (found and fixed 2026-09-27,
impl §10.10 *Slatepack finalize binding*; uncommitted, NOT VPS-tested).** Found by a short look
from a cheating miner's side after the /review above, which had asked only about failures. Both
finalize paths compared the reply's slate id with the row's only `if (w.slate_id && …)`, so the
check was skipped in two cases:
- **A new row, mid-create.** A row sits in `slatepack_pending` with no `slate_id` while its create
  is inside three wallet calls. The finalize route takes the withdrawal id from the URL, and the
  Goblin bridge routes a DM to the sender npub's oldest pending row, so a reply can reach the row
  in that window.
- **A reply with no id.** A reply the wallet decodes to no id skipped the compare as well.

Either way the reply went to `finalize_tx`, whichever slate it belonged to. In grin-wallet v5.5.0,
read in source, `cancel_tx` keeps a slate's private context, and finalize refuses only a cancelled
entry (`update_stored_tx` matches `TxSent`). Any slate still locked in the pool wallet can therefore
be finalized.

**The attack.** Expiry refunds first and cancels second (see the 2026-09-25 note below), and
grin-wallet cannot cancel without a node. A miner keeps the reply to their 1000 GRIN Slatepack and
lets it expire while the node is down: the refund lands, and the cancel stays owed. After the
30-minute reversal cooldown, once the node is back and before the retry sweep cancels, the miner
requests 25 GRIN and puts the old reply into the new row's window. The pool posts the old slate:
1000 GRIN leaves the wallet, and the ledger records 25. Only `slate_refunded_but_mined` notices, and
only afterwards. **Likelihood low** (a node outage past the cooldown, then a won race); **impact
high** (theft from the hot wallet, i.e. other miners' balances). The committed code has it too.

**Fixed:** both paths fail closed. A row with no `slate_id` refuses any reply before the claim, so
the create still attaches as normal, and a reply with no id is refused like a mismatch. An honest
miner cannot hit either: both creates attach the id before they return or publish the S1.
`test-payout-guard.js` `[binding]` drives the attack through the real create window on both rails.
All 8 B checks failed on the old code, where the new row confirmed as paid while the old slate was
posted; the controls passed on both versions. **The Tor rail is not exposed:** it refunds only once
the wallet shows the send cancelled or never locked. This note corrects two earlier "verified"
statements that the bind held, §E.3 item 5 and §J4's *Verified correct*; both are annotated in
place.

**Slatepack rail: a lost tab, and the expiry sweep's wallet cancel (found and fixed 2026-09-25,
not in any §J finding; NOT VPS-tested).** Three issues, one surface:
- **A closed tab stranded the payout.** The S1 existed only in the create response. After a
  reload, the page had lost the withdrawal id, so Finalize refused even a valid response the wallet
  already held. The miner could only wait out the TTL (30 min) and then the reversal cooldown
  (30 min). **Fix:** the manual rail stores its S1 in `withdrawals.slatepack_s1`. That S1 is
  **encrypted to the payout address**; the Goblin rail's plain-armor S1 is never stored, and a
  test pins it. One new route, `POST /api/account/:addr/withdraw/:id/slatepack`, returns the
  **same** stored S1, never a new slate. It runs on the `withdraw` bucket, checks the ownership
  proof before the read, and its SQL is narrowed to (this address, `method='slatepack'`,
  `slatepack_pending`). The response is `no-store`. Any other case is one 404, so the page cannot
  tell "not yours" from "gone". Audited as `owner_proof:slatepack_reshow`; the admin payments audit
  view's prefix widened to `slatepack\_%` to include it. Both admin row routes strip the column,
  and `test-public-leakage.js` asserts that only the re-fetch route reads it. `_creditConfirm`
  and `_reverseLock` null the column in their claim. The page rebuilds the pane from the
  summary's pending payout, manual rail only.
- **Expiry cancelled before it claimed.** `processSlatepackExpiry` selected a batch, then per row
  awaited `cancel_tx` **before** the guarded refund. A finalize that claimed row N while rows
  before it were being cancelled broadcast its tx, and the sweep then cancelled that posted tx.
  The ledger stayed right (the refund's CAS lost), but the pool wallet unlocked inputs already
  spent in the mempool. **Fix:** refund first (the claim), and cancel only a row this sweep won.
- **A failed expiry cancel was forgotten.** `cancel_tx` needs a reachable node. A failure was
  logged, the refund went ahead, and the slate's inputs and change stayed locked until a human
  cancelled them. **Fix:** the refund transaction sets `slate_cancel_pending`, and the new
  `retryExpiredSlateCancels` decides each flagged row from the wallet's local tx log:
  - absent or cancelled → clear the flag; there is no second `cancel_tx`;
  - confirmed → never cancel, and raise a critical `slate_refunded_but_mined` alert (a double-pay
    detector for an invariant that should not break);
  - otherwise → `cancel_tx`.
  Each tick stops at the first failure. After 5 failing ticks it raises a rolling
  `slate_cancel_owed` warning, resolved once the flagged set is empty. The sweep runs while frozen.
- **Found on the way:** both Owner-API create paths attached `slate_id` without a status guard. A
  wallet slower than the TTL let expiry refund the row first, and then the slate was attached to a
  refunded row, and on the Goblin rail it was also published. Both writes are now guarded on
  `slatepack_pending`, and a lost guard cancels the slate.
Tests: `test-payout-guard.js` +23 (SP1–SP10); 6 of them fail against the reverted scheduler.
`test-public-leakage.js` +8. Every `scripts/test-*.js` passes. **Still open:** a crash between the
create transaction and the `slate_id` write still leaves a locked slate that no sweep can name;
that was already true before this change.

**Surface added after §J closed — hub move + connect-page latency (2026-09-23). REVIEWED
2026-09-23 (Part 9): 6 CONFIRMED and fixed, 12 PLAUSIBLE reported, of which P1 was fixed too on
2026-09-24 at the operator's request — see "Part 9 review" right after this note.** Seven build parts in one day (design §13.13, impl §8.7). The bullets below are
the build's own description of its guards, kept as written; where the review changed a guard, the
review block says so. Not VPS-tested.
- **Migration money path (F4 — two live pools on one wallet seed must never happen).** Guards as
  built: payouts frozen *before* the old hub stops; the wallet listener's watchdog and `@reboot`
  paths removed before the listener stops; pool service and hub WireGuard stopped **and
  disabled**; the final snapshot taken after the stop; Migrate IN restores still frozen, refuses
  while the old hub answers (TCP dial of its stratum + a parsed `status: ok` from its pinned
  `/api/health`; a timeout is *unknown* and needs a typed `OLD HUB IS DARK`), probes again just
  before start, refuses to overwrite a newer ledger without `OVERWRITE LEDGER`, rejects an archive
  whose manifest names a different archive, and compares 18 ledger figures + per-row sha256 digests
  + the wallet identity before starting. Unfreezing is never automatic. **For the review:** a
  Migrate OUT failure between stop and disable; the old box rebooting mid-move; a firewall that
  drops rather than refuses (the dark probe proves "unreachable from here" only); a gateway still
  attached to the old hub; the daily cron overwriting the same-day archive between OUT and IN (OUT
  removes it; confirm nothing re-adds it); a digest that errors on the old box being `null` → `skip`.
- **Certificates in the migration archive (D4).** Only Migrate OUT raises `PBK_INCLUDE_CERTS`;
  the daily cron has its own list and never reads it. `live/` symlinks are stored as symlinks
  (verify rejects a dereferenced `tar -h` archive); `privkey` stays 0600; `accounts/` travels.
  The whole archive is AES-256-CBC under the personal key. The old box's certbot keeps (failing)
  renewal attempts until it is wiped.
- **Gateway re-resolve timer.** Root oneshot every 60 s with `CAP_NET_ADMIN` only,
  `ProtectSystem=strict`, no `PrivateNetwork` (would make it a silent no-op). A hostile DNS answer
  cannot impersonate the hub — WireGuard's key authentication still holds — so the risk is
  availability (the tunnel does not come up), not interception. It never adds a peer whose key is
  not already on the interface.
- **New gateway surface.** `:443` — a separate HAProxy (`grin-gateway-probe`), one `GET /ping` →
  204 route, 404 otherwise, no backend, no logs, 30 req / 10 s per IP, `maxconn 2000`, TLS ≥ 1.2;
  its pem is `0600 root`. A missing/bad pem stops only the probe, never the stratum forwarder (the
  reason it is a separate instance). `:80` is opened in the firewall for certbot standalone but
  bound only during an issue/renewal. The certbot deploy hook acts on its own lineage only.
- **New hub surface.** `/ping` in the main vhost (204, rate-limited by the `_static` zone via a
  named location — a bare `return` would bypass `limit_req`), and an optional `latency_hub_url`
  server block that serves `/ping` and 404s everything else.
- **Widened public CSP.** The public page's `connect-src` gains `https://*.<probe_domain>`, where
  `probe_domain` is the pool's own subdomain and never derived wider (an override may only name the
  subdomain or a parent of it). The admin CSP is unchanged (`connect-src 'self'`). **For the
  review:** whether operator- or miner-influenced content can use a `*.domain` host to exfiltrate
  — compare §J15-6's reasoning for dropping jsdelivr.
- **Suggest endpoint privacy** (`GET /api/pool/connect/suggest`). The IP is resolved to a country
  for one computation and dropped — not stored, logged or echoed, nor is the country; the response
  carries per-region milliseconds only; `Cache-Control: private, no-store`; public rate limiter.
  Known and accepted by the build: the pool's public CORS `*` applies to this per-viewer route, so a
  third-party page could read a visitor's estimates (it already has their IP). **For the review:**
  any logger that captures the route, and timing side channels.
Not VPS-tested.

**Part 9 review of the note above (2026-09-23) — adversarial, money path first.** Method: code read
of `07_lib_pool_migrate.sh`, `07_lib_pool_backup.sh`, `grin_backup_engine.sh`, the re-resolve and
probe halves of `07_lib_gateway.sh`, the suggest route + request middlewares in `index.js`,
`ensureLocalRegion`, the withdrawal-scheduler freeze paths (read only), and every other path that
could start a pool or unfreeze payouts. Each CONFIRMED item got a failing scenario FIRST in a local
Git-bash harness (the Part 4 harness extended: real OUT → wipe → real IN, real `node:sqlite`,
fakes for systemd/tar/curl/probes), then the fix; results in impl §8.7 "Part 9 review fixes".

| # | Verdict | Finding | Fix |
|---|---|---|---|
| C1 | CONFIRMED, fixed | A Migrate OUT straddling local **midnight** named the manifest's `archive_name` by the step-5 date and the archive by the step-6 date; Migrate IN rightly refuses a manifest naming another archive, so the move's OWN archive was unusable — discovered inside the downtime window. (Part 3 had asked Part 4 to tolerate ±1 day; it became a hard refusal.) | OUT checks the built name against the manifest; on a mismatch it rewrites the manifest under the new date and rebuilds once (same file name — nothing orphaned). The ledger cannot move: everything is stopped. |
| C2 | CONFIRMED, fixed | Migrate IN restored the old hub's seed + ledger onto a box whose pool unit **1) Install had enabled**. Any failure before step 7 (continuity ✗, node restart needed, …) followed by a reboot started that pool unattended — frozen, no wallet listener, but a pool process on the seed the design says must never run twice. The "every failure leaves this box's pool stopped" claim held only until a reboot. | IN step 3 disables the unit before extracting (refuses if it cannot); only step 7 enables it again. |
| C3 | CONFIRMED, fixed | Archives carried the backend **code** at the top of the app dir (`index.js`, `package.json`, `package-lock.json`) while `lib/`, `admin-panel/`, `scripts/`, `node_modules/` were excluded. Any restore — an older daily after a deploy, or Migrate IN onto a box installed from a different checkout — put one version's `index.js` beside another's `lib/`, silently. | The three names are excluded when an archive is made (Backup now, Migrate OUT, the daily cron wrapper) **and** when one is extracted, so archives made before the fix cannot bring code back either. |
| C4 | CONFIRMED, fixed | Plain `2) Restore` froze nothing when the extraction **failed** — a partial restore (wallet dir already the archive's, pool.db the old or half-written one) with the service stopped, one "Start" away from live payouts on a mixed state. Migrate IN froze in that case, but inline — the shared core that exists so the two "can never disagree on the freeze" disagreed. | `_pbk_restore_extract` freezes whatever pool.db is in place on rc 1 too and reports it in `PBK_EXTRACT_FROZEN`; `2) Restore` says frozen / NOT frozen and sweeps ownership; IN's inline copy removed. |
| C5 | CONFIRMED, fixed | When the pool.db snapshot could not be staged (`mktemp`/snapshot failure), **Backup now** returned success with no pool.db in the archive, and the **daily cron** did the same (`\|\| true`). An archive that restores no balances looked like a backup. (Found by Part 3 for Backup now; the cron path is the same defect.) | `_pbk_make_tar` rc 2 = pool.db could not go in → fatal in lenient mode too, nothing encrypted; the cron wrapper logs `ERROR … no archive written` and exits 1. |
| C6 | CONFIRMED, fixed | The dark gate counted a **firewall's** answer as the old box's: `No route to host` (firewalld's default reject) and "could not connect" on 443 were both "a definite no", so a live old hub whose ports are filtered FROM the new box read as **dark** and the restore went ahead. (§ above: "proves 'unreachable from here' only".) | Only a TCP RST counts as a stratum "no", and only an HTTP answer that is not the pool (Migrate OUT leaves nginx up, so a dark hub answers 502) counts as an API "no"; dark needs both. Anything else is *unknown* → the typed `OLD HUB IS DARK`. Side effect: an egress IP that is not the web ingress (P4) now lands on *unknown* too, unless nginx also answers there. |
| P1 | PLAUSIBLE → **fixed 2026-09-24** (operator's call, test-first) | **Weekly VACUUM race.** The vacuum script restarts the pool from an EXIT trap when it was active at its start. If Migrate OUT runs while a Sunday 03:00 UTC vacuum is mid-way, the trap starts the pool again after OUT verified it stopped (disabled at boot, but running). Frozen and without a wallet listener (no coinbase → no jobs); IN's two dark probes catch it if it lands before IN step 7. | OUT step 4 now removes `/etc/cron.d/<service>-vacuum` FIRST (no new vacuum can begin), then refuses while the vacuum script runs (`pgrep -f`), before its own stop; the state screen shows the cron and the rollback names `c) Cron schedules → 2)`. A vacuum started by hand after the stop finds the pool inactive and never restarts it. |
| P2 | PLAUSIBLE | **Stale-but-consistent archive.** After a rollback (old hub served again), an operator who copies the EARLIER migration archive to the new box passes every IN check — the archive matches its own manifest, the gate sees a dark hub. The wallet-total check catches payouts made since; shares/blocks credited since are lost silently until reconciliation. | Recommended: the rollback screen tells the operator to delete any archive already copied to the new box. |
| P3 | PLAUSIBLE | OUT's in-flight list (the PROCEED screen) is read BEFORE the freeze; a send the scheduler starts in that gap is not shown. The manifest is written after the stop, so IN compares the right figures. | None needed beyond awareness. |
| P4 | PLAUSIBLE | The dark gate probes the old hub's **egress** IP (ipify). A box whose miners' ingress IP differs, or two boxes behind one NAT egress (read as "rebuild in place" → gate skipped), is not probed where it serves. C6 narrows the first case. | Recommended: also probe the stratum host's current A record when it is not this box. |
| P5 | PLAUSIBLE | Plain `2) Restore` on a live hub (and an IN re-run after a successful IN) leaves the wallet's */5 watchdog in place, which may relaunch the listener while tar rewrites the wallet's lmdb. | Recommended: remove watchdog + @reboot before extraction, as Migrate OUT does. |
| P6 | PLAUSIBLE | A digest that errors is `null` → `skip` (symmetric — same file on both sides — so the table falls back to count/sum); the manifest stays on the old box after a rollback (later archives carry it; `archive_name` + sidecar + continuity reject them); the old box's certbot and nginx keep running until the wipe. | None. |
| P7 | PLAUSIBLE | After the move the old `nyc` row stays active with the pool's own stratum host (now the NEW hub): the connect page can present it as a nearby gateway with `hub_rtt_ms` ≈ 0 and recommend it. Mining is unaffected (it reaches the hub). | Runbook step 9 (deactivate/re-point `nyc`) — already there. |
| P8 | PLAUSIBLE | Re-resolve: a hostile DNS answer costs availability only (WireGuard key authentication holds), and because it re-resolves only a STALE handshake it can never pull a healthy tunnel away. The unit sandbox was read against what `wg show`/`wg set`, the resolver and `logger` need and holds — but has never run under a real systemd. | None; the VPS re-resolve drill (plan Part 10) proves it. |
| P9 | PLAUSIBLE | Probe surface: `return`-only (no backend → no smuggling surface), no access log, 30/10 s per IP, pem `0600 root`, a separate instance so a bad pem cannot stop stratum. `:80` stays open in the firewall and answers RST between renewals. | Accepted. |
| P10 | PLAUSIBLE | Suggest route: the app neither logs nor caches the IP or the country (no request logger exists; `geoip.lookupCountry` keeps no cache). The one IP line the app writes is the global rate limiter's `Rate limit exceeded: <ip>`, on every public route — pre-existing, not this route's. The lookup is constant-time, so no useful timing channel. | None. |
| P11 | PLAUSIBLE | CSP `connect-src https://*.<probe_domain>`: an injected script could POST to any host under the pool's own domain (e.g. a taken-over dangling subdomain). It adds no capability such a script lacks — the same `connect-src` already allows Google Analytics / Plausible / Umami collectors, which accept arbitrary data under any site id, and nothing restricts top-level navigation. Unlike §J15-6 (a `script-src` source anyone could publish to), `connect-src` executes nothing. | No change. |
| P12 | PLAUSIBLE | The connect page can rank a measured hub against an estimated gateway (or the reverse) — two instruments; the estimate's ±25 % can flip a near tie (Part 7's note). | None. |

**Checked and holds:** nothing auto-unfreezes (the only `resume()` caller is the admin route);
nothing re-adds the daily backup cron, the wallet watchdog or its `@reboot` line except an
operator's menu choice; `grin-secret-sync` restarts only GrinScan and the tiny explorer, never the
pool or its wallet; the VACUUM script restarts the pool only if it was running when it began (hence
P1 was a race, not a standing restart path); the cert archive keeps `live/` symlinks and `privkey` 0600 (Part 3's WSL run);
Migrate OUT's recorded effect order is byte-identical before and after the fixes.

**Surface added after §J closed — the /play/ games platform (design §19, Parts 1–10 built
2026-09-27/28). REVIEWED 2026-09-28 by design §19 Part 11, NOT VPS-tested.** A separate service
(`grin-games`, user `grinplay`, own DB), reached by the pool through three secret-guarded internal routes
on the pool's own listener (`back-end-pool/lib/games-link.js`), an admin proxy under `/api/admin/games/*`,
a health probe and one branding flag; public `/play/` pages, a public chat and player moderators (D21).
**None of it has had a §J-style session**; its review is the Part 11 pass, a session that built none of it,
which answered all 20 of design §19.13's threat notes against the code — the full record, with evidence,
is **design §19.15 *Part 11 review***. Findings:

| # | Finding | Severity | Status |
|---|---|---|---|
| P11-1 | No pool-side cap on `/internal/games/verify-proof` or `/activity`: a compromised games process holds the secret and chooses `client_ip`, so it could drive unbounded scrypts and activity queries on the stratum process | Med | **fixed** — global caps in `games-link.js` (≤ 4 in flight + 120/min; 60 per 5 min), `test-games-link.js` [14] |
| P11-2 | A free bot game (`bot_play_cost` 0) still wrote `results_daily`, feeding wins boards and `game_results` events whose rewards skip the daily points cap — worthless points, but the D10 "no mining, no reward" rule broken | Low | **fixed** — `matches.js` settle + the void guard, tests in `test-matches.js` / `test-pvp.js` |
| P11-3 | /play/ never told players that a stranger mining to their address, or a CGNAT neighbour, can sign in as them (§19.13 #7) | Low | **fixed** — sign-in card copy |
| P11-4 | The pool's `account-settings.html` takes the rig password (now also a games / moderator credential) but runs operator analytics, custom HTML and `code` ads (`CREDENTIAL_PAGES` is `['login']`) | Low | **closed 2026-10-04 (code)** — decided 2026-10-03 as design §19.17 D22 (option B): the custom-HTML sinks and `code` ads are deleted for every page instead of opting one page out, because the v2 chat bubble puts a sign-in form on every page. **Built in Part C1** (design §19.15 *Part C1*, rows D22-1…4 below); not VPS-tested. The provider analytics script still runs on the account page — the residual D22 accepts (§19.13 #30) |
| P11-5 | A stranger mining to a MODERATOR's address with their own password inherits moderator powers once the proof ages; the mod log cannot tell them apart | Low | **open — accept with D21 at acceptance**, or log `ip_coarse` per mod action |

Everything else checked and holds, including: the secret is compared before any body, DB read or scrypt,
and never reaches argv, env, a log or a response; `/internal/` is unreachable through nginx three ways;
the games service never opens `pool.db` and writes no pool table beyond `admin_audit_log`; the frame
sandbox is exactly `allow-scripts`; no chat body reaches an HTML sink. Suites after the fixes: games
921/921, pool 2330/2330.

**v2 Part C1 — operator code removed from the origin (design §19.17 D22; built 2026-10-04, NOT
VPS-tested).** A change record by the session that built it, **not an audit** — R1 (design §19.14) is the
independent check. Beyond the deletions D22 asked for, the build found three adjacent holes and fixed them,
and one it could not:

| # | Finding | Severity | Status |
|---|---|---|---|
| D22-1 | The GA4 loader spliced the measurement id into a `<script>`'s text with only `'` stripped, so a trailing `\` broke out of the string literal. The write validator blocked it for `analytics.ga_tracking_id`, but the payload's legacy fallback `seo.ga_tracking_id` had no validator | Low (needs a settings write) | **fixed** — the id is pattern-checked on write, on publish and in the browser; `test-branding-sinks.js` [7] |
| D22-2 | `plausible_src` / `umami_src` / `matomo_url` accepted anything `new URL()` parses, `javascript:` and `data:` included — either would have become the `<script src>` on every public page | Low (step-up gated write) | **fixed** — https only, host required, no credentials, on all three layers; `test-operator-code-sinks.js` [4], `test-branding-sinks.js` [7] |
| D22-3 | Ad `link_url` / `image_url` had no check: a `javascript:` link became a live `<a href>` on every public page, written at plain `secureAdmin` | Low–Med | **fixed** — site path (never `//` or `/\`) or http(s), on write and in the renderer; `test-operator-code-sinks.js` [3] [5] |
| D22-4 | **CMS page and post bodies are raw operator HTML on the origin** (`page.html` ← `lib/pages.js` `html`, `post.html` ← `lib/posts.js` `body_html`, both `innerHTML`, unsanitised; writes at `secureAdmin`). Same class as the sinks D22 deleted, outside its text; worse once C7 puts the sign-in bubble on those pages | Med after C7 | **fixed in C7, 2026-10-04 (not VPS-tested; R2 to confirm)** — the operator chose **sandbox** over sanitise / restrict (asked at the start of C7). Both bodies now render through `public_html/js/cms-frame.js`: a `srcdoc` frame with `sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"` — **no `allow-scripts`**, so nothing in a body runs, and a body's CSS can no longer restyle the page around it. A missing `cms-frame.js` shows a sentence, never an innerHTML fallback. `test-operator-code-sinks.js` pins the sandbox token by token, the one allowed `srcdoc`, and both pages' call sites; the C7 Edge probe fired an `onerror` + a `<script>` + a page-wide `<style>` in a post body and none escaped. Accepted costs (design §19.15 *Part C7* #1): a body's `<form>` cannot submit, and search engines see the body inside a frame. Was: OPEN — design §19.15 *Part C1* item 10; confirmed by R1 2026-10-04 (block below) |

Suites after Part C1: pool 2662 passed, 0 failed (each file's "N passed" line summed; NEW
`test-operator-code-sinks.js` 92).

**v2 R1 review — independent review of Parts C1–C4 (design §19.17; 2026-10-04, a session that built none of
them; code review + one-shot local probes on Windows, nothing on a VPS).** Threat notes #22–#25 answered
against the working tree; the full record, with evidence and the judged departures, is **design §19.15 *R1
review***. #23 (launch gate), #24 (name-rule parity) and #25 (Scunthorpe) **confirmed**; #22 confirmed for the
sinks D22 deleted (the provider loaders, `code` ads, custom HTML — no stored legacy value reaches a browser,
admin panel included) but **not complete while D22-4 stands** — R1 re-read both CMS pages and their libs and
confirms it. Findings:

| # | Finding | Severity | Status |
|---|---|---|---|
| R1-1 | The pool's own name stopped being a reserved name word whenever `pool_info.pool_name` (free text, no validator) held a character outside `a–z 0–9` and the separators — `Night Owl Mining!`, `Night-Owl (EU)`, `NightOwl ⛏`, `Owl#1`: `poolNameEntry()` returned null, so a player or a donor could take the pool's name and read as the pool in chat, on the boards and on the donor wall | Low–Med | **fixed** — accents stripped, other non-alphanumerics dropped, in both `name-rule.js` copies; 7 fixture cases (6 fail on the old code) |
| R1-2 | Two real words refused by the Scunthorpe rule: `Penistone`, `Supportive` | Low | **fixed** — `peniston`, `supportiv` added to EXCEPTIONS (both copies) + fixture cases |
| R1-3 | Residues of the word rule: `F4ck` / `fvck` pass (vowel swap — the fold is six digits), `Guesthouse` is refused (the `guest` prefix rule), `PoolOwner` / `ModTeam` pass (`pool` / `mod` are whole-only) | Info | **accepted** — post-moderation + name bans are the designed answer; `F4ck` and `Guesthouse` are labelled fixture cases |

D22-4 is unchanged: **OPEN, an operator decision owed before C7.** Checked and holds besides: all 32 public
games routes pass `publicRoute()`; Go live, the name ban / block / remove routes and the donor-name ban /
unban are step-up and write exactly one audit row per real change inside their transaction; a moderator
cannot remove an operator's, another moderator's or their own name; every donor-banner function is
byte-identical to `HEAD`; the donor wall and the account donor panel escape a name that may now carry `&`
or `'` without a human having read it. Suites after R1: pool 2795/2795, games 1114/1114 (the fixture grew
112 → 124 cases, innocent 40 → 82, adversarial 40 → 79, checked as aggregates).

**v2 R2 review — independent review of Parts C5–C7 + whole-feature regression (design §19.17; 2026-10-04, a session
that built none of them; code review + one-shot local probes on Windows, nothing on a VPS).** Threat notes #26–#30 and
#22 answered against the working tree; the full record, with the probes, the measurements and the judged departures,
is **design §19.15 *R2 review***. #27 (PoW), #28 (Sybil, residues in R2-2), #29 (identity fences) and #30 (the bubble)
**confirmed**; #26 (guest auth) **confirmed after R2-1**; **#22 is now complete** — D22-4's sandbox was attacked in
headless Edge with `javascript:` links on every target, an `<area>`, an SVG link, a form and a meta refresh, and nothing
ran, against two controls (a plain link navigates the tab; the same link in a frame that allows scripts does run).
**Money is untouched:** no money-path file differs from `HEAD`. Findings:

| # | Finding | Severity | Status |
|---|---|---|---|
| R2-1 | Guest login PEEKED the per-name failure budget before the scrypt await and took a token only after a failure (the miner login's shape, safe there because the pool's throttle sits behind it — a guest login has nothing behind it). A parallel burst passed on one token: 60 of 60 concurrent wrong guesses from 60 /24s evaluated against a budget of 20, and again 60 each time one token refilled — up to ~1,360 guesses an hour per name instead of 20. The per-account current-password lockout (change, delete) had the same shape: 8 parallel guesses → 8 evaluated | Medium | **fixed** — the token is reserved before the await and refunded unless the attempt ends as a wrong password (`ratelimit.js` `refund`; still failures-only, known-/24 owner path unchanged); the current-password check is single-flight per account. After: 20 then 1; 8 parallel → 1. `test-guests.js` +4, mutation-checked (the old code fails 3) |
| R2-2 | Residues: an owner on a never-seen /24 waits while a stranger keeps its name's budget drained, and a stranger inside the owner's /24 skips it (Part 4 #3); ~2,500 IPs inside 5 min could fill the PoW used set and make sign-up `busy` (fails closed; existing guests unaffected; `guest_signup_enabled`); aged guests can flood the moderation queue with reports (never a hold) and farm PvP within the pair cap and 5 tickets a day; the bubble shows the viewer's own sign-in name on every public page; the 18-bit PoW is a speed bump to native code — the per-/24 limit is the Sybil control | Info | **accepted** — C9 to weigh `signup_pow_bits` 20 after timing a phone |

Suites after R2: games 1362/1362 (`test-guests.js` 153 → 157), pool 2829/2829 (no pool code changed).

**Reading the §J record — the retired "satellite" role.** §J and the pre-§J sections mention a
**satellite** role. It does not exist: it was deleted from the code on 2026-06-22 (`f2ebade`),
along with `scripts/lib/07_lib_satellite.sh`, `back-end-pool/satellite.js` and
`lib/share-relay.js`. A region is now a **thin stratum gateway** — HAProxy + WireGuard forwarding
raw stratum with the miner IP in PROXY-protocol v2; it is not a pool-app role and it exposes **no
HTTP ingestion API**, so there is no `requireSatellite` allowlist and nothing a gateway does
reaches the HTTP rate limiter (§J1 route matrix, §J12-, §J16). Those mentions are left as written
because §J is a dated evidence log — a finding records what was true when its session ran, and
rewriting one falsifies the record. The only place the term was live guidance rather than history
was §B, and it is corrected there.

---

## Trust model

- **Miners never authenticate.** Address-as-identity; all miner-facing endpoints are public, keyed
  by Grin address. Safety comes from funds always going to the miner's own address (Tor, address-bound
  listener) or being payment-proof-bound (Slatepack) — **not** from access control on the endpoints.
- **Admins authenticate.** Admin-only JWT sessions; admin registration is a CLI action, never an
  exposed endpoint.

---

## A. Asset-upload hardening (verified fixed)

The upload endpoint (`POST /api/admin/assets/upload`) is admin-only (`secureAdmin` = IP allowlist +
admin JWT + rate limit), capped at 2 MB / 1 file. Upload-specific weaknesses found and fixed:

| # | Finding | Risk | Fix |
|---|---------|------|-----|
| 1 | Served `Content-Type` came from the **uploader's filename extension**; the MIME check trusted the spoofable declared type. `evil.html` declared `image/png` → served as `text/html` → **stored XSS in the pool origin**. | High (admin-gated) | Filenames are now **server-controlled**: `${type}_${ts}_${rand}.${ext}` where `ext` comes from the *detected* content type. Original name never used on disk. |
| 2 | `req.query.type` concatenated into the filename **unsanitised**, and `multer` wrote to disk *before* `saveAsset` validated → **arbitrary file write** via `../`. | Medium | `multer.memoryStorage()` — nothing written until validation passes. `type` sanitised (`[^a-z0-9_]` stripped); resolved path asserted inside the upload dir. |
| 3 | No content validation — only the spoofable declared MIME was checked. | Medium | `detectImage()` sniffs **magic bytes** (PNG/JPEG/GIF; SVG must parse as `<svg>` in the head). Non-images rejected 400; the detected MIME is stored. |
| 4 | `/custom/` static location had no isolating headers → a served SVG/HTML could execute on direct navigation. | Medium | vhost `location /custom/` now sets `X-Content-Type-Options: nosniff` + `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`. Image MIME types preserved so logos/icons render. |

**Delete path** (`deleteAsset`) only unlinks the stored basename within the upload dir and requires a
matching DB row first — no traversal.

**SVG decision:** `image/svg+xml` remains allowed (logos are commonly SVG), defended by (a)
magic/structure validation at upload and (b) `nosniff` + sandbox CSP at serve time. `<img src>` never
executes SVG scripts; the headers cover direct navigation.

**Public endpoints (reviewed, no change needed):** `/api/public/branding`, `/public/page/:key`,
`/robots.txt`, `/sitemap.xml`, `/manifest.json` are unauthenticated, rate-limited (`public` tier), and
expose only curated operator-set fields from `buildPublicConfig()` — no balances, secrets, IPs, or
alert thresholds. `:key` is validated against the fixed `pages` allowlist; `page.html` strips `?p=` to
`[a-z0-9_-]`.

---

## B. Hardening requirements (audit checklist)

> **Implemented 2026-06-08 (verified in code):**
> - **`trust proxy` + `req.ip`** — `index.js` sets `app.set('trust proxy', 'loopback')`; the
>   spoofable raw-`x-forwarded-for` reads in `rate-limiter.js`/`ip-filter.js` `getClientIp()` now
>   use `req.ip`, so a client IP behind the loopback nginx proxy is read from the trusted hop
>   rather than from an attacker-settable header. *(This entry originally also credited a
>   `requireSatellite` ingestion allowlist. There is no such middleware — the satellite role and its
>   HTTP ingestion API were removed on 2026-06-22; regional gateways forward **stratum**, never HTTP,
>   so nothing a gateway does reaches this limiter. See §J12 and §J16.)*
> - **bcrypt ≥ 12** — `auth.js` `bcryptRounds` default 12 (was 10).
> - **Account lockout** — `users.failed_login_attempts` + `locked_until`; `login()` locks for 15 min
>   after 5 failures and clears on success (additive `migrateUsers()` for existing DBs).
> - **Refresh-token revocation** — `users.token_version`; refresh **rotates** (bumps the version so the
>   presented refresh token can't be replayed), and logout/password-change call `revokeUserTokens()`.
> - **`jwt_secret` fail-loud** — `config.js` no longer auto-generates at boot; `validateConfig()` throws
>   if it is missing/&lt;32 chars. **Not role-gated:** the only remaining roles are `singlebox` and
>   `hub` and both serve the admin auth surface, so the check is unconditional
>   ([`lib/config.js`](../../web/07_mining_pool_public/back-end-pool/lib/config.js) `validateConfig`).
>   *(It was originally skipped for `role: satellite`; that role was removed on 2026-06-22 and the
>   skip went with it.)* Installer still writes the secret once
>   (`07_grin_mining_public_pool.sh`).
> - **escHtml on public sinks** — `miners-stats.html` (grin_address) and `payment-history.html`
>   (tx_hash/status) now escape; `fortune-board.html` already escaped. Defense-in-depth atop the
>   stratum-layer bech32 address regex (`stratum-protocol.js`).
>
> **Still open (needs a product decision before mainnet):** the public **system-health** page renders
> **hardcoded/fake** CPU/Mem/Disk/Network/uptime metrics (and `miners-stats` "98%" uptime). Per
> "no fake metrics," either compute them server-side or omit the cards — recommend **omit** (real
> server resource usage is itself a mild info-leak on a public page).

### Authentication
- **bcrypt rounds ≥ 12.**
- **JWT in an httpOnly cookie** (`pool_token`), not localStorage (avoids XSS token theft); a separate
  non-secret cookie may carry `{username, is_admin}` for display only.
- **Access token short-lived (≤ 1h); refresh tokens revocable** — track `jti`, revoke the old one on
  refresh, or a stolen refresh token is valid for its full lifetime.
- **Account lockout** per-username (`failed_login_attempts` + `locked_until`) — per-IP limiting alone
  is bypassed by IP rotation.
- **Frontend auth gate must `await`** the async check and gate against an **authenticated** endpoint
  (`/api/admin/dashboard` → 401), never the public `/api/health`.
- **`jwt_secret` written at install**, never auto-regenerated at boot (invalidates all sessions).
- **Admin re-auth on sensitive ops:** withdrawal retry/cancel require `requireFreshAuth(300)` —
  JWT age < 5 min allow; else `403 { challenge_required }` → `POST /api/auth/reauth` → fresh token.

### Network layer
- **`app.set('trust proxy', 1)` + use `req.ip` everywhere.** Reading raw `X-Forwarded-For` lets a
  client spoof an allowlisted IP and bypass the rate-limiter/allowlist.
- **Rate limiting:** nginx zones via the shared helper (`pool_api` ~30 r/m public; a per-IP/per-addr
  tor-check probe limit), never inline `limit_req_zone`. Helmet for headers (defense-in-depth; CSP
  owned by nginx).

### XSS / frontend
- **Escape every interpolated value** — centralize `escHtml()` and use it on all `innerHTML`
  interpolation sinks (worker names, status reasons, settings), or build DOM via
  `createElement` + `textContent`.
- **Worker-name validation at the stratum layer** (`^grin1[a-z0-9]+(\.[a-z0-9]+)?$`) stops malicious
  names (e.g. `grin1<script>`) reaching the DB at all.
- **CSP `'unsafe-inline'` for scripts** is currently required by inline page bootstraps + analytics
  init; this weakens the XSS barrier. A nonce-based CSP is stronger but impractical with nginx-served
  static pages + client-side injection. Move inline handlers to `addEventListener` to enable dropping
  it later.

### Public data-leak prevention
- `GET /api/pool/payments` and `/api/pool/miners` must return **aggregates / anonymized** rows
  (truncated addresses, totals), not raw full-address + balance/amount rows.
- **No fake/hardcoded metrics** in any public or dashboard response — compute or omit.
- Per-address pages are public by design but show only that address's own data, by exact address.

### Audit logging
- **One column shape** for `admin_audit_log`: `(admin_id, action, target_type, target_id,
  before_state JSON, after_state JSON, ip, created_at)` — mismatched writers silently fail every
  INSERT → empty log.
- **No admin mutation succeeds without an audit row** (enforced at the handler); CSV export available.

### Consensus / money (validated against production pools)
- **`confirm_depth = 1440` mainnet** (= `COINBASE_MATURITY`, not 10) — prevents reorg payouts (loss of pool capital).
- **No Tor port-probing before send** — probing leaks Tor circuit identity; best-effort send instead.
- **Orphan detection by nonce** validated against the chain after payout, with **exact-amount,
  PPLNS-weighted reversal** (incl. pool fee, never below 0) — prevents orphan steals.
- **Wallet send idempotent** — cache `withdrawals.txid`; never two txids for one withdrawal.
- **Withdrawal balance lock is compare-and-swap**; max 1 pending per address (429); full reversal on
  fail/cancel (miner pays no fee on a failed payout).

---

## Residual / accepted risks

### Hot wallet with password on disk — forced by Grin's receive path, not a shortcut

The pool wallet password is stored in plaintext at `/opt/grin/pubpool/<net>/.wallet_pass`
(root-owned, `chmod 600`; written by `07_lib_pool_wallet.sh`) so the boot script and watchdog
can auto-unlock the wallet (Owner API v3: `init_secure_api` ECDH → `open_wallet`). Operators
regularly ask why the password must live on the server at all. The answer:

1. **In Grin, *receiving* is a signing operation.** There are no addresses: the node's stratum
   calls the wallet's `build_coinbase` for **every block template it builds** (re-versioned
   ~every 15 s, not just when a block is found), and that call derives a key, builds the output
   commitment + rangeproof, and signs the kernel — all requiring the decrypted seed in memory.
   A BTC pool can receive to a cold address with zero hot keys; a Grin pool cannot. There is no
   watch-only option for the coinbase side.
2. **A locked wallet halts the pool, it doesn't just miss rewards.** If `build_coinbase` fails,
   the node cannot construct block templates → stratum has no jobs → every miner idles
   (observed symptom: miners "Alive" but GetWorks = 0). So the wallet must re-unlock unattended
   after any reboot/crash — which requires the secret to be on the box. Postponing *payouts* is
   policy, but it doesn't remove the hot keychain: grin-wallet has no scoped tokens, so the same
   `open_wallet` token that builds coinbases can also `send`.
3. **This matches the wider ecosystem.** grin-pool (MWGrinPool) and open-grin-pool both keep the
   wallet password in service config; `grin-wallet listen -p <pass>` (solo mode) exposes it in
   the process list, which is *weaker* than a 600 file read once at unlock. Encrypting
   `.wallet_pass` would only relocate the problem (key-to-decrypt-the-key on the same box); an
   attacker with root gets the encrypted seed file alongside it anyway.

**Actual mitigations** (the security boundary is the box, not the file): wallet exists only on
the hub — never on gateways/edges; ECDH keeps the password/token off the wire and port 3420
unusable to a non-root local process; keep the hot balance ≈ the pending-payout float and sweep
accumulated coinbase to cold storage on a schedule.

### Other accepted risks

- **Admin-authored HTML is stored, site-wide XSS by design.** `custom_css`, `custom_head_html`,
  `custom_body_html`, content-page HTML, banner/maintenance messages are injected verbatim into every
  visitor's browser — inherent to "inject custom HTML" white-label features. Mitigation is the admin
  auth stack (bcrypt + JWT + IP allowlist + rate limit + httpOnly cookies): an attacker must already
  control the admin account. An operator who wants the vector gone could expose a switch to disable the
  raw-HTML fields (not implemented).
- **Public-page CSP includes `'unsafe-inline'` for scripts** (see above), which compounds the point
  above.
- **Host-header reflection** in `robots.txt`/`sitemap.xml` (`siteOrigin()` falls back to
  `req.get('host')` when `site_url` is unset). Low severity; set `site_url` to pin it.
- **Slatepack is not inherently address-bound** — mitigated by the one-time claim token + mandatory
  payment proof (design §8). Without payment proof, a leaked slate could be completed by an attacker.
- **A reorg deeper than `confirm_depth` (1440 blocks, ~24 h) is not handled** (audit §J5-11a).
  Orphan detection only examines blocks still in `'immature'`; once a block has been confirmed,
  distributed and flipped to `'paid'`, nothing re-examines it, so a reorg that unwinds a matured
  block leaves its credits standing. **This is accepted, not covered.** Grin reorgs are shallow
  and 1440 blocks is Grin's own coinbase-maturity rule, so the pool is exposed only to a
  chain-halting event. Building the handler would also require closing the second half of
  §J5-11 — a post-distribution reversal has to reach balances that are locked in, or already
  out of, an in-flight payout, which is the scheduler's state machine, not the block monitor's.
  The `distribution_stalled` and `coverage_shortfall` alerts would both fire in that scenario;
  recovery would be manual.

---

## Security pre-launch gate

`[x]` = implemented in code 2026-06-08 (syntax-checked + logic-reviewed; runtime-verify on testnet).
`[~]` = partially done — see note. `[ ]` = still owed.

- [x] bcrypt ≥ 12; refresh revocation; account lockout
- [~] httpOnly cookie auth **done**; frontend gate awaits an authenticated endpoint — *verify*
- [x] `trust proxy` + `req.ip`; no `X-Forwarded-For` trust; `jwt_secret` written at install (+ fail-loud at boot)
- [x] `escHtml` on the public miner/payment sinks (+ `fortune-board`); worker-name/address bech32 regex enforced at stratum layer
- [x] SVG validated; uploaded-asset static route + MIME sniff + isolating headers (§A)
- [~] public payments/miners aggregated or gated — *verify*; **fake metrics still present on public system-health page (open item D1)**
- [~] `admin_audit_log` single shape **done** (`migrateAdminAuditLog`); "every admin action audited" — *not line-audited per handler*
- [x] confirm_depth 1440 set; [ ] no Tor probe / nonce orphan check + exact reversal / idempotent sends — *verify money logic against live DB*
- [ ] HTTPS enforced; secrets only in `pool.json`, never in code

---

## C. Re-audit 2026-07-10 (fresh pass — auth + money path verified against current code)

Verified the auth stack and the fund-moving path line-by-line. **Auth is solid** — TOTP login
returns *no* session cookie until the second factor passes ([index.js:939-941](../../web/07_mining_pool_public/back-end-pool/index.js#L939-L941));
money/destructive routes use `freshAdmin` (password step-up via `pwa`); refresh tokens rotate on
`token_version`; account lockout + timing-equalized login (`_dummyHash`). **Withdrawal money
logic is solid** — CAS balance lock (`WHERE balance >= ?`), one-pending-per-address, exact
reversal on fail/expiry, slate-id binding on slatepack finalize. **Incentives** never overdraw
(`debitPrizePool` floor-checks) and the join bonus is Sybil-gated on first real payout.

New / still-open findings:

### C1 — [Medium] `/api/pool/miners` and `/api/pool/payments` leak full raw data, unauthenticated *and* un-rate-limited — **FIXED 2026-07-28**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (C1).**

### C2 — [Low-Medium] Tor-rail withdrawal has no ownership gate → balance-lock griefing / forced payout — **FIXED 2026-07-17, see §E**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (C2).**

### C3 — [Low] Access token survives logout & password-change until it expires (≤1h)
- **Evidence:** `revokeUserTokens()` only bumps `token_version` (invalidates *refresh* tokens);
  `verifyAccessToken()` never re-checks `tv` against the DB ([auth.js:206-218](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L206-L218),
  [280-290](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L280-L290)). So a stolen/live
  access token keeps working for up to 1h after the victim logs out or changes their password.
- **Impact:** Standard stateless-JWT tradeoff; low, given the 1h TTL and httpOnly+sameSite cookies.
  Worth closing for the admin surface: either check `tv` (one indexed lookup) on `secureAdmin`/
  `freshAdmin`, or shorten the admin access TTL.

### C4 — [Info] Confirmations of accepted/known items
- **IP-proof gate** ([owner-proof.js](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js)):
  the "proof" is a *client-submitted* low-entropy IP string, throttled 8/10 min. Fine as an
  anti-griefing gate — the slatepack payout's real protection is age-encryption to the owner
  address (a non-owner who passes the gate gets an undecryptable blob). No change needed; documented.
- **Fake metrics** on the public system-health surface + per-handler audit-log coverage remain the
  open items from §B (D1). `/api/admin/health/system` fake metrics are admin-only (lower severity
  than a public page). `/api/admin/miners/:addr/inject` credits balance under `secureAdmin` (not
  `freshAdmin`) — if it can move funds, consider promoting it to `freshAdmin`.

**Not re-examined this pass (flagged for a future deep dive):** stratum share-validation/PPLNS
accounting internals, the lottery draw RNG/verifiable-seed, and orphan-reversal against a live DB
— the existing §B checklist covers their requirements but they were not line-verified here.

## D. Re-audit 2026-07-17 (P3 pass — HTTP API + admin auth, ownership gate, SQL, rate limits, XSS)

Scope: `index.js` routes, `lib/miners.js`, `lib/pool-settings.js`, admin-panel pages, and the
front-end pages that echo miner-supplied data. Verified + corrected in the same pass.

### Verified clean (no change needed)
- **Ownership gate is single-sourced:** every mutating account API goes through
  `verifyIpProof()` in [owner-proof.js](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js)
  (min-payout, slatepack withdraw, slatepack finalize). The ungated paths are the documented
  no-theft-vector ones (Tor withdraw = pay-to-self; cancel = own-funds unlock). No bypass found.
- **Admin coverage:** `/api/admin/reconciliation`, payout `control` (GET) and `wallet-audit`
  are `secureAdmin` (rate limit + IP filter + JWT); `freeze`/`resume`, `adopt-identity`,
  withdrawal retry/cancel, ban/unban, award, campaigns are `freshAdmin` (step-up). 2FA is
  enforced at session issuance (`/api/auth/login` returns `totp_required` and only
  `/api/auth/login/totp` mints cookies), so every admin route inherits it.
  `/api/admin/_authcheck` deliberately bypasses the limiter/IP filter (documented nginx
  `auth_request` shim; JWT-only, 204, no data).
- **SQL:** all statements parameterized. The only dynamic fragments are whitelisted:
  `LEDGER_DIRECTION_SQL` (fixed map), CMS `_clean()`-built SET clauses (fixed key set),
  retention table names (internal constants).
- **XSS:** miner identity charset is locked at the stratum boundary
  (`validateUsername`: bech32 address regex + `[a-z0-9_-]` worker names, donate tag → int),
  and the public/admin pages that render addresses/worker names/reasons all escape
  (`escHtml`/`esc`). Uploaded SVGs are served with a sandboxing CSP.

### Corrected this pass
1. **Rate limiting gaps closed** — 12 public GETs had no limiter (`/api/pool/stats|blocks|
   miners|payments|top-block-finders`, `/api/account/:addr/shares|balance`, `/api/stratum/
   hashrate|top-miners|top-avg-hashrate`, `/api/miners/top`, `/api/config/pool-info`) → all now
   `rateLimiter.middleware('public')`; `/api/auth/refresh|logout|change-password` → `'auth'`
   (change-password verifies old_password, so unthrottled = session-holder brute force).
2. **Ownership-gate evidence hardened** — source IP was recorded at stratum **login**
   (unauthenticated: the address is the username), so a bare TCP connect under a victim's
   address could poison/evict its last-2-IP window. Now recorded once per session on the
   **first node-accepted share** (stratum-server `handleSubmit`) — IP evidence requires PoW.
3. **Gateway pairing step-up** — POST `/api/admin/locations` with `wg_pubkey` (pairs a
   WireGuard gateway peer that may forward PROXY-v2 source IPs into the ownership gate) now
   requires fresh auth like peer *removal* already did (inline `isTokenFresh` +
   `challenge_required`; regions.html save switched to `adminFetch` for the reauth flow).
   Metadata-only region saves stay plain `secureAdmin`.
4. **pool-settings `updateSection` stored the raw input, not the validator's output** —
   normalisations (trimmed `donation_address`, deduped `enabled_themes`, cleaned
   `lottery_special_events`) were silently dropped, and an array input whose validator
   returned a JSON string fell through to the binder as a raw array. Now persists `validated`.

### Still open (carried from §C)
C1/C2 (Tor-withdraw trigger/cancel griefing), C3 (access-token survives logout ≤1h),
C4 inject-under-`secureAdmin` promotion — unchanged this pass.
*(Update: C2 and the cancel-griefing half of this item were closed later the same day — §E.)*

## E. Ownership gate v2 — 2026-07-17 (add-ons, NOT VPS-tested)

Operator-decided redesign of the account-page gate ([owner-proof.js](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js) rewritten):

1. **C2 closed — every money action is now gated.** `POST /api/account/:addr/withdraw`
   (BOTH rails), `…/withdraw/:id/finalize`, and `…/withdraw/:id/cancel` all require an
   ownership proof. The balance-lock griefing / forced-payout / fee-burn vectors on the Tor
   rail and the nuisance-cancel vector are gone. Failures are audited per action
   (`owner_proof:withdraw_tor|withdraw_slatepack|slatepack_finalize|withdraw_cancel:deny`).
2. **Proof = recent mining IP (IPv4 or IPv6) OR the rig's stratum password.** Both captured
   at the stratum layer on a session's **first accepted share** (PoW-backed, same
   anti-poisoning rationale as D.2), each in a last-2 distinct window (ISP re-lease /
   rig-side password change never locks the owner out). Trivial passwords (`x`, `123`,
   factory defaults, `d=…` directives, one repeated character, straight digit runs, <8 chars)
   are never captured and never verify — a shared default must not become a skeleton key.
   Since 2026-09-20 anything outside printable ASCII is refused too (`password_charset`):
   ASIC firmware does not send non-Latin characters faithfully, so the pool would hash
   garbage as `ok` and the miner would only find out on withdrawal day. The connect page
   now asks for a numeric PIN (8+ digits) — digits survive every firmware and encoding.
3. **Proofs hashed at rest (data minimisation).** Salted scrypt (`N=16384, r=8, p=1`,
   memory-hard vs GPU brute-force of the 2^32 IPv4 space / low-entropy passwords), format
   `v1$salt$hash` in `miner_accounts.last_ip/prev_ip/last_pass_hash/prev_pass_hash`.
   The DB never holds a raw mining IP or password; legacy plaintext IPs are upgraded in a
   background startup migration (`migrateOwnerProofHashes`), with dual-form verify meanwhile.
   Trade-off accepted: no raw-IP forensics from the accounts table (the audit log still
   records HTTP request IPs).
4. **IPv6 canonicalisation** (`canonicalizeIp`): brackets/zone-id stripped, `::ffff:` mapped
   prefix removed, `::` expanded, embedded IPv4 tails folded — one stable form so socket-
   captured and user-typed representations always compare equal.
5. **Per-account `min_payout` endpoint removed** (auto-payout relic; manual withdrawals carry
   an explicit amount). Only the pool-wide `config.min_withdrawal` floor is enforced, in the
   scheduler. Attack surface: one fewer gated mutation endpoint.

Residual risk (unchanged in kind): the gate remains anti-griefing, not authentication — a
NAT/CGNAT co-tenant sharing the miner's public IP can still pass it; both rails stay
independently theft-proof (pay-to-self over Tor; slatepack age-encrypted to the address).

### E.1 Follow-up hardening — 2026-07-17 later same day (add-ons, NOT VPS-tested)

- **Public cancel removed entirely** (supersedes the gated cancel in point 1 above): both parked
  states self-recover (Tor auto-reversal after max retries; slatepack TTL refund), and in
  Grin a send that appears failed may still have posted — a late cancel reversing the lock
  is a **double-pay** vector even when ownership-gated (the legitimate owner could abuse it
  deliberately). Admin cancel stays (step-up gated). ~~OPEN follow-up: the automatic
  retry/reversal paths carry the same theoretical double-pay exposure; fix = record slate_id
  on Tor sends and check wallet tx state (`retrieve_txs`) before any retry or reversal.~~
  → **CLOSED 2026-08-01, see §H1.** The prescribed fix was half-built: `_captureTorSlateId()`
  recorded the slate_id but nothing consulted it, so the retry ladder still re-sent blindly.
- **Operator-extendable password blocklist, additions-only**: `access.extra_banned_passwords`
  (pool_config) merges on top of the hardcoded seed in owner-proof.js with a 60 s cache;
  the seed + structural rules are not admin-removable, so a bad edit can weaken nothing.
  Fail-open to seed-only on missing/corrupt row. Verify re-checks the submitted value, so a
  new entry disables that password as proof immediately, even for accounts that captured it.
- **Freeze visibility**: account summary exposes `payouts_frozen` as a **boolean only** —
  the freeze reason (wallet_drain / integrity_drift …) stays admin-side, since it would tell
  an attacker exactly which incident the pool is fighting.

### E.2 Cross-rail pending gate + failed-payout cooldown — 2026-07-17 round 3 (add-ons, NOT VPS-tested)

- **FIXED: one-directional pending hole.** `createWithdrawal` (Tor) counted only the three
  Tor statuses, so a miner with a pending **slatepack** could open a **Tor** payout in
  parallel — two concurrent locks, violating design §8's one-pending-per-address rule (the
  slatepack path already counted all four statuses; the hole was Tor-side only). Both create
  paths now share one module-level `PENDING_SQL`
  (`tor_checking, tor_sending, retry_scheduled, slatepack_pending`); any future rail that
  parks in these states (e.g. the designed Nostr rail) is inside the gate by construction.
  Admin miner-detail view (`GET /api/admin/miners/:addr`) had the same 3-status list in its
  pending display — also fixed.
- **NEW: cross-rail cooldown after a reversed payout** (operator decision, default 30 min,
  `payout.withdrawal_cooldown_minutes`, 0 disables, cap 1440). `_assertNoRecentReversal()`
  checks the address's latest `balance_log` row with `event_type='reversal'` +
  `reference_type='withdrawal'` (written by Tor `markFailed`, slatepack expiry/creation
  failure `_reverseLock`, and admin cancel) and 429s both create paths while inside the
  window, before any lock is taken. Purpose: (1) safety margin over the (then-open, now closed
  in §H1) slate_id/`retrieve_txs` double-pay window in E.1 — a "failed" Tor send that actually
  posted gets 30 min to surface before the miner can pull the same funds through another rail.
  **Note this never covered the retry ladder itself** (same row re-entering `sendWithdrawal`,
  which does not pass this check) — only a *new* withdrawal on another rail. §H1 is what closed
  the ladder;
  (2) kills rapid-fire rail-hopping after failures. Orphan/jackpot clawback reversals use
  `reference_type≠'withdrawal'` and do NOT trigger the cooldown.

### E.3 Goblin/Nostr payout rail — threat model (BUILT 2026-07-18, add-ons, NOT VPS-tested)

This rail is categorically different from Tor/slatepack: those can only pay the mining
address's **own** wallet (Tor dials its onion; the slatepack is age-encrypted to it), so the
ownership gate is merely anti-griefing — a passed gate cannot redirect funds. The Nostr rail
pays a **username → npub → whoever controls that key**. So the gate alone must NOT be able to
authorize an arbitrary-destination payout. Layered defenses (all implemented):

1. **Registered destination, not a request parameter.** A payout never takes a username from
   the withdraw body. The destination is stored once via `POST /api/account/:addr/nostr-destination`
   (ownership-gated + rate-limited) and the send route reads only the stored, pinned npub.
2. **≥48 h destination cooldown** (`nostr_destination_cooldown_hours`). A freshly registered
   destination can't receive a payout until it ages out. Registration is visible on the miner's
   own account page, so the real owner — who watches their stats — has the whole window to spot
   a hijack, re-register (which resets the clock and evicts the attacker's entry) and rotate
   the rig password. Re-registration always resets the clock.
3. **TOFU npub re-pin at send time.** The route re-resolves the stored username via NIP-05 and
   refuses the payout (409) if the npub differs from the one pinned at registration — a
   goblin.st account takeover cannot silently redirect a standing destination.
4. **NIP-05 domain allowlist** (`nostr_nip05_domains`, default `["goblin.st"]`) — the resolver
   only fetches `/.well-known/nostr.json` from allowlisted hostnames, and rejects IP-literals /
   paths / ports. This is the SSRF + look-alike-domain guard: the pool's resolver can't be
   pointed at an internal host or a typo-squat domain.
5. **Response (S2) binding, defense in depth.** The bridge routes an incoming gift-wrapped S2
   to a pending row only when the seal-verified sender pubkey equals the registered `nostr_npub`;
   the scheduler then re-checks that equality AND binds `slate.id` to the issued slate before
   finalizing. A forged/mismatched S2 is dropped without any on-chain action. *(2026-09-27: the
   bind was skipped while the row had no `slate_id` yet or the reply had no id; fixed to fail
   closed. See the roll-up note "Slatepack finalize binding".)* Incoming events
   are size-capped (wrap/rumor/slatepack) and deduped (`nostr_seen_events`) before any parsing.
6. **Inherits every existing money guard.** `method='nostr'` rows park in `slatepack_pending`,
   so they are inside `PENDING_SQL` (one-pending-per-address across all rails), the freeze
   kill-switch (`_assertNotFrozen` on create + finalize), the failed-payout cooldown
   (`_assertNoRecentReversal`), the min-withdrawal floor, and the TTL expiry refund — no
   parallel accounting path. Any wallet/relay send failure reverses the balance lock.
7. **Transport key ≠ money key.** The pool's Nostr identity (`.nostr_payout_key`) can only
   sign Nostr events, never a Grin slate; a leak exposes payout *metadata* (timing/counts on
   public relays — an accepted trade-off, same as goblin itself), not funds.

Residual / to validate on the VPS: the live nostr-tools crypto (nip59 wrap/unwrap) and relay
delivery are exercised only by an E2E run — do a testnet / tiny-amount pilot before enabling on
mainnet. The E.1 slate_id/`retrieve_txs` double-pay hardening applies here too (the failed-send
reversal shares the exposure) — **closed 2026-08-01 by §H1/§H2**; this rail is in fact the most
exposed to the finalize race, since its 10-minute TTL is far tighter than slatepack's 24 h and
relay redelivery makes duplicate response events routine rather than exceptional.

## F. Payout-path throttle hardening — 2026-07-22 (add-ons, NOT VPS-tested)

**Question raised:** should the payout button get a CAPTCHA / Cloudflare Turnstile to blunt
proof brute-force + payout spam?

**Decision: NO CAPTCHA (by default).** Rationale — do not re-litigate in a future pass:
- Both payout rails are **theft-proof** (Tor dials the address's own onion; slatepack/Nostr are
  encrypted to the address / pinned npub). A brute-forced ownership gate cannot *steal*; the
  worst outcome is **griefing** (force a victim's own coins to their own wallet, burning one
  pool-paid fee). Low damage ceiling → CAPTCHA is a heavy answer to a light threat.
- Turnstile conflicts with the pool's **Tor-first, no-account** identity (Tor miners get
  CF challenges on the one screen where they withdraw their own money) and forces a **strict-CSP
  exception** (`challenges.cloudflare.com` script+frame), widening a surface §A/§B narrowed.

Instead, the two *actual* holes on the money path were closed (implementation, not just design):

### F1 — Money-write routes rode the loose `public` bucket (1200/min) — **FIXED**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (F1).**

### F2 — Ownership-proof throttle was per-ADDRESS only → distributed sweep + scrypt CPU lever — **FIXED**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (F2).**

## Abandoned-balance + sub-threshold payout review (add-ons, 2026-07-22)

Post-build logic/security review of the dormancy disposition + manual/backend payout feature
(lib/dormancy.js, withdrawal-scheduler.js override, index.js endpoints, admin/account frontends).
5 findings; all resolved (node --check + temp-DB smoke tests pass; NOT yet VPS-tested).

**Sound by construction (not findings):** single-threaded synchronous node:sqlite transactions make
the disposition sweep and any live withdrawal non-interleaving (no double-spend); both dormancy paths
read *spendable* `balance` (lock model `balance-=amt; balance_locked+=amt`) so locked funds are never
touched; `dormant_sweep`(debit)+`dormant_payout`(credit) net to zero in reconciliation INV_CASES and
stay out of external FLOW_CASES; disposition self-clears (balance>0 filter) so it can't double-sweep.

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| 1 | MED | manualPayout had no double-submit guard → a resubmit wrote a 2nd confirmed withdrawal + debit (over-debit + wallet-audit drift) | dedup in manualPayout(): reject duplicate `kernel_excess`/`slate_id` (unique on-chain id) or identical (address, amount, method='manual') within 60s; frontend disables the button in-flight |
| 2 | LOW | recorder accepted a ≥min amount with no guard → auto-payout scheduler could double-pay in the send↔record gap | manualPayout() rejects `amt >= min_withdrawal` with `above_min_needs_ack` unless `allowAboveMin`; frontend prompts once and retries; steers to the Tor path / freeze |
| 3 | LOW | manualPayout() didn't self-check the freeze (only the endpoint did) | added `if (this.isFrozen()) return payouts_frozen` inside the lib method (defense-in-depth) |
| 4 | LOW | no enforced link between verify-owner and record/send | both money endpoints now require a successful `owner_proof:admin_verify:ok` in admin_audit_log within 15 min, else 428 `verify_required`; explicit `verified_ack` bypass (frontend confirm) for no-proof-on-record accounts |
| 5 | INFO | re-enabling dormancy after a long disable gave no fresh grandfather runway (clock ran through the off period) | pool-settings.updateSection re-arms on a false→true `dormancy_enabled` transition: resets `dormancy_policy_effective_at` to 0 so the next pass re-stamps to now (a full fresh window); true→true saves and disable do NOT reset |

**New capability added in the same pass:** backend-initiated below-min Tor payout
(`POST /api/admin/dormancy/send-payout`) reuses `createWithdrawal(...,{adminOverride:true})` —
bypasses only the min floor + reversal cooldown; freeze, CAS lock, and one-pending-per-address cap
(the double-pay guard) still apply. This is the convenient primary sub-threshold path; the recorder
is the labeled fallback for genuine out-of-band (slatepack/CLI) sends.

## Prize-pool reroute review (add-ons, 2026-07-23)

Follow-up review after the destination change (redistribute-to-active-miners → single prize-pool
credit, REVISION 2026-07-22b). Focus: double-claim / abuse in the reroute + anything the topic misses.
All confirmed-safe items re-verified against live code (single-thread sqlite tx non-interleaving;
spendable-only debit; `dormant_sweep`+`dormant` net zero in INV_CASES and absent from FLOW_CASES;
custodial liability excludes `prize_pool`; reserved addresses excluded as sources; disposed-then-
refunded falls through to a fresh countdown; admin money routes `freshAdmin`-gated). 4 findings, all
fixed (node --check + 18-assertion temp-DB smoke test PASS; NOT VPS-tested).

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| 1 | MED | The ToS reclaim promise ("request a payout to reclaim") was **not durable**: the countdown clock reset only on a *confirmed* payout / fresh share, so a reclaim payout that later **failed & auto-refunded** (or a **partial** withdrawal) left the balance sweepable with the original elapsed clock → next 6h sweep could take it | `dormancy.js` `_candidates()` + `statusFor()` now fold in `MAX(created_at)` of withdrawals of **any status** (`last_request`) into `last_activity`. A reclaim *attempt* durably resets the countdown regardless of the payout's outcome. (No `last_seen_at` write in the withdrawal path → zero side-effect on online tracking.) |
| 2 | MED | Sweeps could run while the incentive **draws were OFF** → abandoned balances pile into a prize pool that never pays out (breaks the ToS "given away through published draws" promise; owner loses reclaim while nobody benefits) | new `_incentivesEnabled()` gate: `runOnce()` skips with `incentives_disabled`, `preview()` reports it as a `blocked` reason, `status()` exposes `incentives_enabled`, admin panel `BLOCK_LABEL` shows "enable prize draws first". No draws → no sweep |
| 3 | LOW | batch `total_swept` was written from the **pre-tx snapshot**, not the in-tx exact sum (identical today, fragile if async ever creeps between candidate collection and the tx) | record `sweptExact` on the batch row inside the transaction (`updBatchTotal`) so the batch is authoritative for the real ledger movement |
| 4 | LOW | `prizePoolStatement` reversal→inflow classification is display-only and could mislabel a hypothetical `reversal/dormant` row | comment clarifying it is a **display grouping only** (reconciliation.js is the accounting authority) and that a `dormant` sweep is terminal by policy — only ever a credit inflow |

**Policy/ToS + wallet copy adapted to match (user directive "the ToS and policy should be adapt,
user wallet or payout should update accordingly"):** ToS §4 (pool-settings.js default `terms`) now
states requesting a payout resets the countdown even if it later fails, that sweeps only run while
draws are active, and that a withdrawal *request* counts as activity; the payout-settings comment +
admin helper text updated (incl. relabel "Active-Miner Window" → "Idle Threshold", dropping the stale
"shared PPLNS-style among miners" text); account-page countdown copy ("counting"/"eligible"/"disposed")
now says "request a payout … resets this countdown" and links the disposed note to the public Prize
Pool ledger. Existing pools must re-seed the ToS page (pages are one-time CMS seeds).

---

## G. IP handling review — 2026-07-25 (add-ons, NOT VPS-tested)

Full sweep of every path where a miner or node IP can land on disk, prompted by the question
"do we hash miner IPs, and should we hash Grin node peer IPs too?". There are exactly **three**
IP-bearing columns in `pool.db`.

| Store | What it holds | Treatment | Verdict |
|---|---|---|---|
| `miner_accounts.last_ip` / `prev_ip` | miner mining source IP (proof window) | salted **scrypt** `v1$<salt>$<hash>`, 16 MB, per-record random salt | ✅ v4 **and** v6 (`canonicalizeIp` expands `::`, folds `::ffff:` v4-mapped, strips zone-id → one stable text form before hashing) |
| `miner_geo.country_code` | miner country | country only, IP discarded at resolve time | ✅ |
| `network_peers.peer_key` | Grin P2P peer | truncated **unsalted** `sha256(net\|ip)` (128-bit) | ⚠️ dedup handle, **not** a privacy control — see G2 |
| `admin_audit_log.ip` | requester origin | **was full plaintext, retained forever** | ❌ → **FIXED, see G1** |

Outside the DB: nginx `${POOL_SERVICE}-access.log` holds real IPs (unavoidable — fail2ban parses
it; bounded by logrotate). `rate-limiter.js` / `ip-filter.js` keep IPs in in-memory `Map`s only,
never persisted.

### G1 — [Medium] Audit trail re-created the (address, IP, time) linkage that proof-hashing removed — **FIXED**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (G1).**

### G2 — [Info/accepted] `network_peers.peer_key` is an unsalted digest — deliberately

`sha256(net + '|' + ip).slice(0,32)`. For IPv4 the entire 2³² space is enumerable in minutes on a
GPU, so this is **reversible by anyone who wants to** — it is a stable dedup handle, not anonymisation.

**Accepted, no change.** Grin P2P node addresses are public by construction: any node on the network
learns its peers' addresses, and the pool only ever stores peers **its own node already connected
to**. Hashing them protects nothing an attacker can't get by running a node for an hour. Salting
would break the cross-snapshot dedup the column exists for (a per-row salt makes the same peer count
N times); a single persistent pepper would restore dedup but only raises the bar to "attacker needs
the pepper" while adding a key to manage and back up — real cost, no meaningful gain.

**The one thing that would matter** is the `country_code` join going public at low peer counts: on a
small testnet pool a country with a single peer is effectively a pointer to one node operator.
`/api/network/peers` should keep aggregating to country with a **minimum bucket size** before that is
exposed — tracked, not yet enforced.

> The code comment on the table ("the raw IP is NEVER stored") is true but reads stronger than the
> property actually is; amended in `db.js` to say dedup handle rather than implying anonymisation.

### G3 — [Low] Network-map feeds published a country breakdown by default — **FIXED 2026-07-25**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (G3).**

### G4 — Payout request audit surfaced in the admin panel — **BUILT 2026-07-25**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (G4).**

## H. Payout double-pay hardening + probe oracle — 2026-08-01 (add-ons, NOT VPS-tested)

Pre-mainnet review of the three payout rails, run before topping up a real wallet. The spine —
one balance-lock accounting path with three delivery adapters — was found sound and was NOT
restructured. Two ways it could pay the same money twice were found and closed. Both were the
same bug class: **a decision to spend money made from state read before an `await`, and
re-checked nowhere.**

### H1 — [Critical] Tor retry re-sent without checking whether the first send landed — **FIXED**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (H1).**

### H2 — [Critical] Finalize and the TTL sweep could both settle one row — **FIXED**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (H2).**

### H3 — [Medium] `tor-check` was a public wallet-uptime oracle for any Grin address — **FIXED**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (H3).**

### H4 — [Low/UX] Status-list and status-label drift found while reviewing H1–H3 — **FIXED**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (H4).**

### Verification (unit-level; NOT VPS-tested)

54 assertions against the **real** methods — the scheduler ones driven over a real SQLite, the
cache lifted out of the real `index.js` — so they cannot drift from shipped code. The pool's
`better-sqlite3` is a native module that exists only on the VPS, so the harness runs on Node's
built-in `node:sqlite` with a shim for the one better-sqlite3-ism used (`db.transaction(fn)`).

Covered: the H2 interleaving replayed end to end (claim → sweep runs → confirm: paid once, **not**
refunded); second claim / second confirm / reversal-on-settled all refused and verified to move no
money; admin cancel on a claimed row 409s; stale reclaim in all three directions; H1 exact-slate
and amount+time matches plus every rejection path (cancelled tx, wrong amount, tx predating the
row, no wallet, junk response); the false positive that would matter most (another payout's
slate_id never borrowed at an identical amount); cache hit/miss, concurrent dedup, throwing-probe
cleanup, 500-entry bound, TTL expiry; and that the withdraw pre-flight never reaches the cache.

**Still to validate on the VPS:** `_priorSendLanded` matches against grin-wallet's `TxLogEntry`
shape — confirm a real `retrieve_txs` response carries `creation_ts` and the
`amount_debited`/`amount_credited`/`fee` fields where expected before leaning on it.

### Still open after this pass (none can move money incorrectly)

- **Dead `canInitiateWithdrawal()`** (zero callers) encodes a status list missing
  `slatepack_pending` and `MAX_USER_PENDING = 10`, contradicting the one-pending-per-address rule
  the live path enforces. Harmless until someone wires it up believing it is the cap check, which
  would re-open the cross-rail hole §E.2 closed. Delete it or reduce it to a wrapper.
- **Audit action string takes unvalidated input.** The withdraw route builds its audit action by
  interpolating the request's `method` field before that value is validated (the check sits after
  every early return), so a failed proof with an arbitrary `method` writes
  `owner_proof:withdraw_<anything>:deny` into `admin_audit_log.action`. Not SQL injection
  (parameterised), but the audit reader matches on `action LIKE` patterns, so rows can be planted
  that mimic other event types and muddy an incident trail.
- **Placeholder zeros in `_releaseLockAndDebit`** — its two debit rows still write `0` for balance
  before/after (the locked columns are correct). Reversals were fixed in §H2.

### H5 — [High] The LAST rung of the Tor retry ladder refunded without asking the wallet — **FIXED 2026-09-13** (add-ons, NOT VPS-tested)

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (H5).**

### H6 — Signed payment proofs as dispute evidence — **BUILT 2026-09-13** (add-ons, NOT VPS-tested), with its threat model

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (H6).**

## I. Re-audit 2026-08-21 (pre-retest pass — backend, frontend, payment path)

Full fresh pass ahead of a GRINIUM re-test. Scope: every Express route + its authz chain,
`lib/auth*`, the whole payout path (all three rails), PPLNS/block-reward accounting,
share retention, the lottery draw, the generated nginx vhost, and the public + admin
front-ends. Still **NOT VPS-tested** — every finding below is code-level.

**Re-verified clean this pass** (no change needed): JWT handling (jsonwebtoken 9.0.3,
type-discriminated access/refresh, `sst` absolute cap, `pwa` step-up freshness); cookie
flags (`httpOnly` + `sameSite:strict` + `secure` under the unit's `NODE_ENV=production`,
so CSRF on the cookie-auth surface is closed); `trust proxy: 'loopback'` making XFF
unspoofable; SQL — every dynamic `SET` clause is built from a hardcoded `_clean()` key
whitelist, so `ads`/`pages`/`posts`/`pool_locations` are not injectable; stratum
`validateUsername` (bech32 + `[a-z0-9_-]` worker names) means no miner-controlled string
ever reaches a renderer; asset upload/delete (magic-byte sniff, server-controlled
filename, DB-lookup-then-`basename` unlink, sandbox CSP on `/uploads/` + `/custom/`);
NIP-05 resolution (domain allowlist + hostname-shape guard, no IP literals) — no SSRF;
withdrawal balance locking (CAS `WHERE balance >= ?`, one-pending-per-address inside the
transaction, `_claimForFinalize` before the first `await` on all three rails); the
`sqlite-compat` transaction shim (real BEGIN/COMMIT/ROLLBACK + savepoint nesting, and no
`transaction(async …)` anywhere); first-admin-only registration.

### I1 — [High] The generated nginx vhost drops **every** security header on the two locations that serve HTML — **FIXED 2026-08-21 (see §I resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (I1).**

### I2 — [Medium] No HSTS anywhere in the nginx vhost — **FIXED 2026-08-21 (see §I resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (I2).**

### I3 — [Medium] The block-reward "verify against the chain before crediting" control is dead code — **FIXED 2026-08-21 (see §I resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (I3).**

### I4 — [Medium-High] Reward distribution is not atomic with the `confirmed → paid` flip → double-credit on a crash — **FIXED 2026-08-21 (see §I resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (I4).**

### I5 — [Low-Medium] `creditBalances` writes placeholder zeros into every credit ledger row — **FIXED 2026-08-21 (see §I resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (I5).**

### I6 — [Info] Miner credit has no account-existence guard, unlike the pool-fee credit — **NOT REACHABLE (schema-blocked); guard added anyway 2026-08-21**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (I6).**

### I7 — [Medium] `POST /api/admin/settings/:section` re-implements step-up and loses the mandatory-2FA gate — **FIXED 2026-08-21 (see §I resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (I7).**

### I8 — [Medium] The lottery seed is chosen *after* the entry set is known, so a "provably fair" draw is grindable — **FIXED 2026-08-21 (see §I resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (I8).**

### I9 — [Low] Share retention's safety floor ignores blocks stuck in `confirmed` — **FIXED 2026-08-21 (see §I resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (I9).**

### I10 — [Low] Operator-supplied region labels reach `innerHTML` unescaped on the network map — **FIXED 2026-08-21 (see §I resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (I10).**

### Carried forward from §H (re-confirmed still open)

- **Unvalidated `method` in the withdraw audit action** ([index.js:3477-3485](../../web/07_mining_pool_public/back-end-pool/index.js#L3477-L3485)).
  Re-checked the render side this pass: `payments.html:772` escapes with `escHtml()`, so
  this is **not** stored XSS — it remains an audit-trail-pollution issue only, as §H states.
- **Dead `canInitiateWithdrawal()`** — still zero callers, still encodes the wrong cap.
- **Placeholder zeros in `_releaseLockAndDebit`** — see I5, now known to be the same bug on
  both the credit and debit sides.
- **C3 access token unrevocable until expiry** — unchanged; the 24 h idle ceiling still
  bounds it.

### Stale comment worth correcting

[ip-filter.js:279-283](../../web/07_mining_pool_public/back-end-pool/lib/ip-filter.js#L279-L283)
documents `app.set('trust proxy', 1)`. The live setting is `'loopback'`
([index.js:219](../../web/07_mining_pool_public/back-end-pool/index.js#L219)), which is
stricter and correct — the comment just predates the change.

### Re-test sequencing note (not a code finding)

`/api/auth/register` is first-admin-only, but the check is a `SELECT COUNT(*)` immediately
before `registerAdmin()`. Whoever reaches it first owns the pool. During the re-test,
register the admin account **before** the vhost is publicly resolvable, or keep
`admin_allowlist` set until it is done — the nginx network gate ships open by default.

### I — resolution pass, 2026-08-21 (same day, add-ons, NOT VPS-tested)

All ten findings fixed. Unit-verified by `scripts/test-money-path.js` (new, wired into
`npm test` — 30 assertions, all passing); the nginx and front-end changes are code-level only
and still need the VPS re-test to confirm.

| # | Fix | Where |
|---|---|---|
| I1 | Security headers moved into two generated snippets under `/etc/nginx/snippets/`; **every** block that declares an `add_header` of its own now re-`include`s one (`/admin/`, `/`, `/uploads/`, `/custom/`) | `07_grin_mining_public_pool.sh` |
| I2 | `Strict-Transport-Security` added to the common snippet — included only from the `:443` server, never the `:80` redirect | same |
| I3 | `new RewardDistributor(config, blockMonitor.grinNode)`; check rewritten to `getHeader` and made fail-closed | `index.js`, `lib/rewards.js` |
| I4 | Credits + pool fee + incentives + the `confirmed→paid` CAS flip collapsed into ONE transaction, flip first | `lib/rewards.js` |
| I5 | Real `balance_before/after` + `locked_before/after` on every credit row, and in the shared `_move` | `lib/rewards.js`, `lib/incentives.js` |
| I6 | `INSERT OR IGNORE` + a `changes !== 1` assertion on the miner credit | `lib/rewards.js` |
| I7 | New `stepUpRefused()` carries **both** halves of the step-up contract; both inline call sites use it | `index.js` |
| I8 | Draws are now commit-reveal against a future block, with a frozen published entry set | `lib/lottery.js`, `lib/db.js` |
| I9 | Retention floor covers `status IN ('immature','confirmed')` | `lib/retention.js` |
| I10 | `esc()` added and applied to both `innerHTML` interpolations | `public_html/js/network-map.js` |

**Two corrections to the findings above, both learned while fixing them:**

- **I3 was worse than reported, and the naive fix would have broken every payout.** The dead
  branch called `getBlock(height)` and compared `nodeBlock.hash`, but `GrinNodeAPI.getBlock`
  returns `{ header: { hash, … }, inputs, outputs }` — there is no top-level `.hash`. So
  simply passing `grinNode` in would have made `undefined !== block.hash` true on every block
  and hard-failed all distribution. The check now uses `getHeader`, which additionally is the
  only correct call here: a pruned node (`mainnet-prune`, the standard deployment) keeps the
  full header chain at every height but serves block *bodies* only inside the pruning horizon.
  Comparison is on **nonce** (authoritative — it is what `OrphanDetector.verifyBlockOnChain`
  already uses in production) plus **hash** when both sides are 64-hex; a non-hex stored hash
  logs loudly and falls back to nonce rather than freezing payouts on a format assumption that
  has not been checked against a live node. **Confirm on the VPS** that `blocks.hash` — parsed
  out of the node stratum's `blockfound - <hash>` reply — matches `get_header(h).hash`, and if
  the warning appears, tighten this to hash-mandatory.

- **I6 is not reachable, and its severity should read Info, not Low.** `shares.grin_address`
  is itself `REFERENCES miner_accounts(grin_address)`, so a share cannot exist for an address
  with no account row — the "block stalls in `confirmed` forever" failure needs a state the
  schema forbids. Verified by trying to construct it in the test harness: the insert fails
  with `FOREIGN KEY constraint failed`. The `INSERT OR IGNORE` is kept as consistency with the
  pool-fee path, not as a bug fix. §I9's fix stands on its own regardless (a node outage, not
  I6, is the realistic way a block lingers in `confirmed`).

**Behaviour changes an operator will notice:**

1. **Distribution now refuses rather than proceeding when the node is unreachable.** The old
   `else` branch logged `[WARNING] Grin node not available - skipping blockchain verification`
   and credited anyway. A block now stays `confirmed` and retries next tick. Expect delayed —
   never unverified — payouts during a node outage.
2. **The lottery no longer pays out when the button is pressed.** `draw-now` COMMITS: it
   freezes the entry set and pot and locks the draw to block `tip + 10`. Winners are picked
   and paid on a later hourly tick, once that block is mined (~10 min). The admin confirm
   dialog and toast were rewritten to say so, and a new `.toast.warn` style was added for the
   "no eligible entries" case. Campaigns gain a `drawing` status for the same interval.
3. **Draws committed before a shutdown survive it** — `resolveCommittedDraws()` runs first on
   every scheduler tick, so an unrevealed draw resolves whenever the process comes back.

**Residual on I8:** a reorg deeper than `SEED_DELAY_BLOCKS` (10) at exactly the committed
height would change the seed. Grin reorgs are shallow and the entry set + pot are already
frozen, so the exposure is a re-rolled winner, not a manipulable one — but the reveal reads
whatever header is canonical at read time, so a draw is only as final as the block it names.

**Still open (unchanged, carried from §H):** the unvalidated `method` in the withdraw audit
action, dead `canInitiateWithdrawal()`, placeholder zeros in `_releaseLockAndDebit` (the
credit-side instances were fixed under I5; the debit side was left alone this pass because it
sits inside the payout state machine and deserves its own review), and C3.

### §I — self-review pass (2026-08-21)

A second read of the §I fixes themselves, looking for defects introduced by the fixes. Three
were found and corrected; a fourth is a repository-history problem, not a code one.

1. **I1 introduced an over-broad HSTS.** The new shared header snippet shipped
   `Strict-Transport-Security "max-age=31536000; includeSubDomains"`. There was no HSTS before
   this pass, so the directive is entirely new — and `includeSubDomains` is the wrong default
   here. `subdomain` in `pool.json` is routinely the operator's **apex** domain (the vhost
   derives `www.<subdomain>` from it and treats the bare domain as canonical), so the header
   would pin every sibling host on that domain — `api.`, `testapi.`, anything else the
   operator runs — to HTTPS for a year. Browsers cache the directive for the full `max-age`,
   so removing the header afterwards does not undo it: an http-only or bad-cert sibling stays
   unreachable until it expires. The protection gained covers only hosts this script never
   deploys. **Fixed:** `max-age=31536000`, no `includeSubDomains`, no `preload`, with the
   reasoning written into the snippet so it is not "helpfully" re-added.
2. **I8's reveal could not be diagnosed.** `resolveDraw()` caught every `getHeader` failure and
   returned `null`, so "the seed block is not mined yet" (normal, every tick until reveal) and
   "the node has been unreachable for a week" produced the same silent no-op. A draw stuck in
   `committed` forever would emit no log line at all. **Fixed:** the tip is read first; below
   `seed_height` is silent and normal, at-or-above it a `getHeader` failure is an anomaly and
   is logged with both heights.
3. **I8 added a redundant index.** `idx_lottery_entries_draw ON lottery_entries(draw_id,
   grin_address)` duplicates the implicit index SQLite already creates for
   `PRIMARY KEY (draw_id, grin_address)` — same columns, same order — costing a second write
   per entry row for nothing. **Fixed:** removed.

**Confirmed correct on re-read** (checked, not assumed): `blockMonitor.grinNode` and
`getHeader()` both exist with the shapes I3 relies on; `dueDraws()` keys off `created_at`,
which is stamped at COMMIT, so a draw awaiting reveal does not re-trigger; `runDueCampaigns`
filters `status='scheduled'`, which excludes the new `drawing`; `_scheduleNextOccurrence`
INSERTs a fresh row rather than mutating the one the reveal later stamps; `lottery_draws`
has no CHECK on `status` and both `seed_hash`/`drawn_at` are nullable, so the commit INSERT is
valid on an existing DB with no migration; the public `recent_winners` payload and the fortune
board both read through `lottery_winners`, so a `committed` draw cannot render as a null seed;
the settings route's duplicated freshness check is reached only when fresh and cannot
double-send; `stepUpRefused` emits a byte-identical refusal to `requireTotpEnrolled`; and
`network-map.js` has no third unescaped `innerHTML` sink.

**Repository note (not a defect in the code):** the I1/I2 nginx work was swept into commit
`1cafea0 "docs(comments): audit batch A5 — public pool (shell)"` by a concurrent
comment-audit session. The fix is present and correct, but its commit message describes it as
comment-only, so a later reader auditing when HSTS/CSP inheritance was fixed will not find it
there. Worth a note in the changelog.

---

## §J1 — Route & guard matrix (2026-08-25, add-ons, NOT VPS-TESTED)

First session of the pre-mainnet §J pass (see the Status roll-up at the top of this file).
Scope: every Express route registered in
[`index.js`](../../web/07_mining_pool_public/back-end-pool/index.js) and the chain definitions
in [`lib/auth-middleware.js`](../../web/07_mining_pool_public/back-end-pool/lib/auth-middleware.js).
Question asked: not *"is there a guard"* (there is, on all 102 `/api/admin` routes) but
*"is it the right tier"*.

**Measured route table.** 163 route registrations + 7 `app.use` layers = the 170 `app.*` calls
in the file. (The plan's "~180 routes" was an estimate; 163 is the count.) Extracted
mechanically, not by reading — reproducible with:

```bash
grep -nE "app\.(get|post|put|patch|delete|use|all)\(" index.js
```

| Guard chain | Routes | Composition |
|---|---|---|
| `secureAdmin` | 68 | `rateLimiter('admin')` → `ipFilter('admin')` → `requireAdmin` |
| `freshAdmin` | 31 | + `requireFreshAuth(300s)` → `requireTotpEnrolled` |
| `freshAdminEnroll` | 2 | as `freshAdmin` minus `requireTotpEnrolled` (2FA enrollment only) |
| `requireAdmin` bare | 1 | `/api/admin/_authcheck` (nginx `auth_request` shim) |
| `rateLimiter` first | 59 | `public` 50 · `auth` 4 · `withdraw` 4 · `torcheck` 1 |
| no middleware | 2 | `/api/auth/register`, `/api/auth/login` — both gate inline (`rateLimiter.peek` → captcha → `consume`) |

`/api/admin` totals: **102 routes — 47 GET (46 `secureAdmin` + `_authcheck`), 55 mutating.**
No admin route carries a non-admin guard; no admin route is unguarded.

### Verified correct (checked against the plan's intuition list, not assumed)

All thirteen of the routes the plan named are on the tier it expected: withdrawals
retry/cancel, payouts freeze/resume, dormancy run/manual-payout/send-payout, wallet
adopt-identity, miner ban/inject, incentives award, prize-pool topup, lottery draw-now,
campaign run, database cleanup, revoke-sessions, ip-allowlist mutations, settings restore —
**all `freshAdmin`**. §C4's "consider promoting `inject` to `freshAdmin`" is done.

Other things confirmed by reading rather than by memory:

- **Only two inline `isTokenFresh(` call sites survive** ([index.js:834](../../web/07_mining_pool_public/back-end-pool/index.js#L834)
  inside `stepUpRefused` itself, and [:5996](../../web/07_mining_pool_public/back-end-pool/index.js#L5996)).
  The second is the section-specific freshness wording and is immediately followed by
  `stepUpRefused()` at [:6004](../../web/07_mining_pool_public/back-end-pool/index.js#L6004),
  so both halves of the §I7 contract are carried. `stepUpRefused` is called from exactly two
  places ([:5507](../../web/07_mining_pool_public/back-end-pool/index.js#L5507),
  [:6004](../../web/07_mining_pool_public/back-end-pool/index.js#L6004)) and there is no third
  hand-rolled copy. **§I7 is closed and stays closed.**
- **`/api/admin/_authcheck` is genuinely side-effect-free.** It returns 204 with no body, and
  `verifyAccessToken` ([auth.js](../../web/07_mining_pool_public/back-end-pool/lib/auth.js))
  is pure `jwt.verify` + a `type === 'access'` check — no DB read, no audit write, no counter.
  Its `rateLimiter`/`ipFilter` bypass is covered at the network layer: the vhost's
  `location = /admin/_authcheck` is `internal`
  ([07_grin_mining_public_pool.sh:1337](../../scripts/07_grin_mining_public_pool.sh#L1337)) and
  `location /api/admin/` carries `$admin_rules` ([:1348](../../scripts/07_grin_mining_public_pool.sh#L1348)).
- **The 404 fallthrough leaks nothing structural** — flat `{"error":"Not found"}`,
  [index.js:6237](../../web/07_mining_pool_public/back-end-pool/index.js#L6237). (See J1-8 for
  the 401-vs-404 side channel, which is a different thing.)
- **Every rate-limit bucket name used actually exists.** `middleware()` does
  `if (!limit) return next()` ([rate-limiter.js](../../web/07_mining_pool_public/back-end-pool/lib/rate-limiter.js)),
  so a typo'd bucket name means *no limit at all*. All six names used (`public`, `auth`,
  `admin`, `export`, `withdraw`, `torcheck`) are defined. Clean.
- **There is no satellite HTTP ingestion surface to mis-tier.** Model C gateways forward raw
  stratum over WireGuard; the comment at [index.js:911](../../web/07_mining_pool_public/back-end-pool/index.js#L911)
  is accurate and there is no `requireSatellite` chain anywhere. "Satellite gateway" drops out
  of the threat-actor list for the HTTP surface.
- **All four miner money actions are ownership-gated**, and `POST …/nostr-destination` — the
  one that changes *where money goes* — demands `requireBothProofs` (mining IP **and** rig
  password), strictly stronger than `withdraw`. The plan's J3 question is answered yes at the
  route level; J3 still owns the canonicalisation and constant-time questions inside
  `owner-proof.js`.
- **`GET /api/admin/gateways/:region/pairing` looks like it should be `freshAdmin` but isn't a
  credential.** The `GRINGW1|…` string is region · hub **public** key · endpoint · tunnel IPs ·
  port ([07_lib_gwctl.sh:317](../../scripts/lib/07_lib_gwctl.sh#L317)) — no private key, no
  PSK. WireGuard only accepts a peer whose public key the hub already registered, so this is
  reconnaissance (the WG endpoint), not access. `secureAdmin` is correct.

### Why the tier matters more than it looks

Two facts from earlier passes combine, and every finding below sits on them:

1. **§C3 — an access token cannot be revoked.** `verifyAccessToken` never checks `tv`
   against the DB, so neither logout, nor a password change, nor the *Revoke sessions*
   kill-switch kills a live one (memory `project_pool_admin_session_idle`: "idle ==
   time-to-revoke", capped ≤24 h for exactly this reason).
2. **`freshAdmin` is the only control that a stolen token does not carry**, because `pwa`
   expires 300 s after the last password re-verification and a silent refresh mints `pwa=0`.

So `secureAdmin` vs `freshAdmin` *is* the boundary between "an attacker holding a stolen
session cookie can do this for up to 24 h" and "they cannot do it without the password".
Anything on the wrong side of that line is not a paperwork problem.

---

### Findings

### J1-1 — [High] The routes that inject executable script into every public page sit at `secureAdmin`, one tier below `withdrawals/:id/retry` — and one of those pages is the admin login form — **FIXED 2026-08-25 (see resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J1-1).**

### J1-2 — [Medium] 25 of 55 mutating admin routes write no `admin_audit_log` row — including every write to the security settings and both IP-filter surfaces — **SETTINGS WRITE FIXED 2026-08-25; 24 routes still OPEN** (see resolution pass)

**Threat actor:** a logged-in admin, or an attacker on a stolen session, covering their
tracks. Also the operator, post-incident, trying to reconstruct what happened.

§B's checklist requires "**No admin mutation succeeds without an audit row** (enforced at the
handler)", and the pre-launch gate still marks it `[~] not line-audited per handler`. This
session did that line audit mechanically across all 55 mutating admin routes. **26 have no
`admin_audit_log` INSERT in the handler body, and exactly one of those 26 is covered in the
lib layer** (`/settings/:section/restore` → `resetSection`). The other 25 write no audit row
anywhere: `ads.js`, `pages.js`, `posts.js`, `asset-manager.js`, `retention.js`,
`alert-monitor.js`, `ip-filter.js` and `poolstats-reporter.js` contain no `admin_audit_log`
INSERT at all — the only lib writers in the whole backend are `auth.js`, `dormancy.js`,
`owner-proof.js` and `pool-settings.js`.

The ones that matter:

| Route | Tier | What is lost |
|---|---|---|
| `POST /api/admin/settings/:section` | secureAdmin (+cond. step-up) | **every settings change** — `pool_fee_percent`, `min_withdrawal`, `withdrawal_fee`, `require_admin_totp`, `session_timeout_hours`, `tor_preflight_gate`, `nostr_nip05_domains`, retention windows |
| `POST /api/admin/security/ip-allowlist/add` · `/remove` | freshAdmin | who opened or closed the admin perimeter |
| `POST /api/admin/security/ip-blacklist/add` · `/remove` | freshAdmin | who un-blocked an attacking IP |
| `POST /api/admin/security/rate-limit-reset` | secureAdmin | who cleared a brute-force lockout, and for which IP |
| `POST /api/admin/poolstats/update-key` · `/test` | freshAdmin / secureAdmin | outbound credential rotation |
| `POST /api/admin/ads` · `/pages` · `/posts` (+ `:id`, `DELETE`) | secureAdmin | who authored the HTML in J1-1 |
| `POST /api/admin/assets/upload` · `DELETE /api/admin/assets/:filename` | secureAdmin | upload/delete provenance |
| `POST /api/admin/2fa/enroll/begin` | freshAdminEnroll | pending-secret issuance (`confirm` *is* audited — [index.js:1897](../../web/07_mining_pool_public/back-end-pool/index.js#L1897)) |
| `POST /api/admin/database/cleanup` | freshAdmin | who triggered a manual prune of the money trail |
| `POST /api/admin/alerts/:alertId/acknowledge` · `/snooze` | secureAdmin | who silenced a money alert |

The settings row is the sharp one, and it is sharp because of an asymmetry:
`PoolSettings.resetSection()` **does** audit
([pool-settings.js:1373-1378](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1373-L1378))
while `PoolSettings.updateSection()` does not — it records only `updated_by` on the
`pool_config` row, which is last-writer-wins with no history and no timestamped action. So
restoring a section to defaults leaves a trail and *changing* it does not. Turning
`require_admin_totp` off, or widening `nostr_nip05_domains`, is invisible.

Mitigating: `access` and `database` are step-up-gated, and `audit_log_keep_days` has a
30-day floor ([pool-settings.js:1053-1057](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1053-L1057)),
so the existing trail cannot be shredded on demand. This is a hole in the trail, not a
shredder for it — hence Medium.

**Fix:** one `admin_audit_log` INSERT in `updateSection` recording `(section, changed keys,
before → after)`, mirroring `resetSection` — that single change covers the highest-value gap.
Then one line each in the four IP-filter routes, `rate-limit-reset`, `database/cleanup` and the
two alert routes. Individually trivial, but 25 call sites, so it is written up rather than
applied blind in this session.

---

### J1-3 — [Medium] `POST /api/admin/locations` can retarget every miner's rig at `secureAdmin`, while removing the same region is `freshAdmin` — **FIXED 2026-08-25 (see resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J1-3).**

### J1-4 — [Low] `POST /api/admin/security/rate-limit-reset` lifts a throttle at a lower tier than its two siblings — **OPEN**

**Threat actor:** attacker on a stolen admin session, or a logged-in admin.

[index.js:4516](../../web/07_mining_pool_public/back-end-pool/index.js#L4516) is
`secureAdmin`. `rateLimiter.resetIp(ip)` deletes **every** bucket and violation entry whose
key ends in `|<ip>` ([rate-limiter.js:303-313](../../web/07_mining_pool_public/back-end-pool/lib/rate-limiter.js#L303-L313)) —
including the `auth` bucket, i.e. the brute-force lockout for an arbitrary IP. Its two
functional siblings, `POST /api/admin/security/temp-ban/clear`
([:4763](../../web/07_mining_pool_public/back-end-pool/index.js#L4763)) and
`POST /api/admin/security/ip-blacklist/remove` ([:4587](../../web/07_mining_pool_public/back-end-pool/index.js#L4587)),
are both `freshAdmin`. Three routes that all mean "stop throttling this IP", two behind
step-up and one not.

Low because the attacker already holds an admin session, so clearing a login throttle buys
little on its own — it matters as a step in a chain (clear the lockout, then grind the
password to reach `freshAdmin`), which is the same objective J1-1 reaches more directly.
Combine the fix with J1-2's audit line for this route.

---

### J1-5 — [Low] `access.admin_ip_allowlist` / `admin_ip_blacklist` are dead settings keys — writable, readable back, and connected to nothing — **OPEN**

**Threat actor:** none directly; this is an operator-deception failure of the same class as
the `session_timeout_hours` dead setting (memory `project_pool_admin_session_idle`).

The live `IpFilter` is constructed once from **`pool.json`**
([index.js:701-704](../../web/07_mining_pool_public/back-end-pool/index.js#L701-L704):
`allowlist: config.admin_ip_allowlist || []`). `PoolSettings.applyToConfig()` maps only
`pool_info` and `payout` keys into `config` — it never touches `access`. Grepping the whole
repo, the only references to `admin_ip_allowlist` are that construction site, the
`PoolSettings.defaults` entry ([pool-settings.js:212-213](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L212-L213)),
and one line of help text on `settings-access.html`. **Nothing reads them.**

They are still writable: `POST /api/admin/settings/access` accepts them (the section passes
the `key in defaults` check), persists them to `pool_config`, and
`GET /api/admin/settings/access` echoes them back — so the round-trip looks like it worked.
The Access Control page does not expose an input for them (its list widgets post to the live
`/api/admin/security/ip-*` routes and carry `settings-skip`), so the panel is honest; a
curl-driven operator or a future form field would not be.

The *runtime* list is correct and correctly documented: `settings-access.html:186-189` states
plainly that live rules "are **not** saved… They reset on a service restart (a built-in
break-glass escape from a bad allowlist)". That is deliberate design, not a bug, and is not
being reported. The bug is only the two orphan keys that shadow it.

**Fix:** delete both keys from `PoolSettings.defaults.access`, or wire them through
`applyToConfig` + a restart note. Deleting is cleaner — the nginx `admin_allowlist` in
`pool.json` and the runtime list already cover both durability modes. Handoff to **J9** if it
prefers to take the whole `applyToConfig` coverage question at once.

---

### J1-6 — [Low] `:section` resolves through `Object.prototype`, so `POST /api/admin/settings/constructor` is accepted — **OPEN**

**Threat actor:** logged-in admin (so: robustness, not privilege).

Both `updateSection` and `getSection` gate on `if (!PoolSettings.defaults[section]) throw`,
and the per-key gate is `if (!(key in PoolSettings.defaults[section]))`
([pool-settings.js](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js)).
`PoolSettings.defaults` is a plain object literal, so both lookups walk the prototype chain.
Demonstrated locally with `node -e`:

```
constructor    section-check passes: true  | typeof function
    key in section: name true · length true · call true
toString       section-check passes: true  | typeof function
__proto__      section-check passes: true  | typeof object
valueOf        section-check passes: true  | typeof function
```

So `POST /api/admin/settings/constructor {"name":"x"}` passes both gates and INSERTs a
`pool_config` row with `section='constructor'`. Impact is confined to junk rows — real
sections `SELECT … WHERE section = ?` on their own name, so nothing is shadowed, and
`criticalSettingChanged` still demands step-up for any `STEP_UP_SETTINGS_KEYS` key because the
bogus section reads back empty. Low.

This is the exact shape memory `project_config_loader_type_traps` records as fixed in Script
052 and **"same shape unaudited in 059"** — it is present here too. **Fix:**
`Object.prototype.hasOwnProperty.call(PoolSettings.defaults, section)` in both functions, and
the same for the key check. Handoff to **J9**, which owns `pool-settings.js`.

---

### J1-7 — [Low] The §I self-review's HSTS fix landed in the nginx snippet only; Express still emits `includeSubDomains` — **RE-OPENED with demonstration**

**Threat actor:** none active; this is a self-inflicted availability risk on the operator's
sibling hosts.

The §I self-review (2026-08-21, item 1) removed `includeSubDomains` from the generated nginx
snippet, reasoning that `subdomain` in `pool.json` is routinely the operator's **apex** domain
and the directive would pin `api.`, `testapi.` and every other sibling to HTTPS for a year,
uncacheable-away. That fix is present and correct:

```
scripts/07_grin_mining_public_pool.sh:1257
    add_header Strict-Transport-Security "max-age=31536000" always;
```

But the Express middleware was not changed:

```
web/07_mining_pool_public/back-end-pool/index.js:253
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
```

nginx does not strip upstream headers, so every proxied `/api/…` and `/blog/<slug>` response
carries **both** — the upstream one first. RFC 6797 §8.1 says a UA that receives more than one
`Strict-Transport-Security` header field MUST process only the first, which is Express's. The
directive the self-review deliberately removed is therefore still what a browser applies, on
every API response, with the identical consequence the self-review wrote up. Re-opened under
plan rule 2 (concrete demonstration that the fix is incomplete), not re-litigated.

**Fix:** drop `; includeSubDomains` at [index.js:253](../../web/07_mining_pool_public/back-end-pool/index.js#L253),
and carry the snippet's "do not helpfully re-add this" comment across so the two sites stay
agreed. Cross-ref **J16** for the vhost half.

---

### J1-8 — [Info] 401 vs 404 enumerates the admin route table

**Threat actor:** anonymous internet, only while `admin_allowlist` is empty (the shipped
default — [07_grin_mining_public_pool.sh:1108-1111](../../scripts/07_grin_mining_public_pool.sh#L1108-L1111)
warns about this at install time).

An unauthenticated `GET /api/admin/dashboard` runs the `secureAdmin` chain and stops at
`requireAdmin` with **401**; `GET /api/admin/nosuchthing` falls through to the catch-all with
**404** ([index.js:6237](../../web/07_mining_pool_public/back-end-pool/index.js#L6237)). The
difference is a clean existence oracle for all 102 admin paths. `GET /api/public/endpoints`
correctly filters to `PUBLIC_API_PREFIXES` and does not publish them
([index.js:1123](../../web/07_mining_pool_public/back-end-pool/index.js#L1123)), so the oracle
is the only in-band source.

Info, not Low: the toolkit is open source, so the admin route table is already public
knowledge to anyone who reads this repository. Recording it so a later session does not spend
time "discovering" it. If the operator sets `admin_allowlist` — which the install warning
tells them to — the oracle closes at nginx.

---

### J1-9 — [Medium] Every operator-authored URL reaches an `href` unchecked, and announcement banners carry one onto `login.html` — FIXED 2026-08-26

**Threat actor:** an attacker holding a live admin access token (§C3), or a logged-in admin —
the same actor as J1-1, at the same `secureAdmin` tier. One victim click required.

Found while fixing J1-1b, by reading the whole of `branding.js` rather than only the sinks the
finding named. J1-1b removed the *zero-click* sinks from the credential page; this is the
one it would have left behind.

Announcement banners come from the `notices.banners` settings key
([pool-settings.js:1215](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1215)),
written by `POST /api/admin/settings/notices` at plain `secureAdmin`. `renderBanners()`
appends straight to `<body>` and needs no page hook, so a banner renders on **every** page —
`login.html` included, and correctly so: a maintenance notice is exactly the thing an operator
wants on the login page. That page cannot be exempted the way J1-1b exempted the HTML sinks.

The link was built by string concatenation into an `href`, guarded by `encodeURI(b.link)`.
That is the wrong guard, and the reason is worth stating because it looks right: `encodeURI`
escapes the quote (so the attribute cannot be broken out of) but it **does not touch the
scheme**. Verified: `encodeURI('javascript:fetch(1)//"x')` → `javascript:fetch(1)//%22x`. A
`javascript:` banner link therefore survives verbatim and executes on the pool's own origin
when the admin clicks it — on the page carrying `#password` and `#totp-code`.

Four more instances of the same shape, on other pages: `brand.cta_link`
([:446](../../web/07_mining_pool_public/public_html/js/branding.js#L446)), the social links
([:456](../../web/07_mining_pool_public/public_html/js/branding.js#L456)),
`pool.support_forum_url` ([:551](../../web/07_mining_pool_public/public_html/js/branding.js#L551))
and `pool.pgp_key_url` ([:565](../../web/07_mining_pool_public/public_html/js/branding.js#L565)).
`cta_link` was already gated by J1-1a, which is why the write-up named it — but a step-up gate
is not a scheme check, and the other three were gated by nothing at all.

**Fix (all five, one helper).** `safeHref()`
([branding.js:97](../../web/07_mining_pool_public/public_html/js/branding.js#L97)) parses the
value with the WHATWG `URL` parser and returns it only if `.protocol` is `http:` or `https:`;
everything else becomes `''`. Relative links keep working — they resolve against the document
and come back `https:`.

**What an operator would notice:** nothing, unless they had put a non-`http(s)` URL in one of
these fields. Then the CTA and the PGP/forum links keep their static `href` instead of being
repointed, and a social link *hides* rather than rendering — that branch already hid the link
when the field was empty, and a rejected URL now takes the same path. All five degrade to the
page's own default rather than to a broken link.

Parsed, not pattern-matched, deliberately. A blacklist regex has to anticipate `JaVaScRiPt:`,
a tab-split `java\tscript:` and the entity-encoded spellings a browser still honours; the URL
parser has already normalised all of them before we look. The banner link is additionally now
built as a **DOM node** rather than concatenated HTML, which removes the attribute-quoting
question entirely and lets `link_text` land as `textContent` — note that `escapeText()`
([:998](../../web/07_mining_pool_public/public_html/js/branding.js#L998)) handles `< > &` but
**not** the quote, so it was never sufficient for an attribute context.

**Not fixed here:** a banner can still display misleading *text* on the login page. That is
content integrity, not script execution, and it is the same question as the deferred
`ads`/`pages`/`posts` tier decision below — not a bug to patch in isolation.

---

### J1-10 — [Info] A NUL byte in `pool-settings.js` made the file invisible to `grep`

**Threat actor:** none — this is a review-tooling hazard, recorded because it defeats the
method this entire audit runs on.

Self-inflicted, in this session's own J1-2 fix: the "key absent" sentinel was written as a
raw `\x00` byte in the source rather than an escape. Node parsed the file fine and `git diff`
rendered it as text, so nothing failed. But `grep` applies a binary heuristic, and a single
NUL is enough — it stops printing matches and says `Binary file ... matches` instead.

That silently removes a 1,500-line file from every `grep -rn` over the backend. It very nearly
cost a real check in this pass: a `grep` for caching in `PoolSettings` returned nothing, which
read as "no cache" when in fact the file was never searched. Had `getSection()` been cached,
`afterState` would always have equalled `beforeState` and the J1-2 audit row would **never**
have been written — a fix that passes review and does nothing.

**Fix:** sentinel replaced with the bare word `'<undef>'`, which `JSON.stringify` can never
emit (its string output is always quoted), so it needs no unprintable character at all
([pool-settings.js:1393](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1393)).
All eight files touched in this session were then scanned for NUL bytes; this was the only one.

**Worth a standing check — and the obvious command is a trap.** Grepping for a NUL *pattern*
looks like the test and is useless: bash cannot put a NUL in an argument, so the pattern
arrives empty, matches every line, and reports a large number for a perfectly clean file. It
did exactly that here before a byte count settled it — and the same escape, typed into this
very paragraph, put two fresh NULs into this document before the check caught them. What
works is a byte scan: read the file in Python `'rb'` mode and `bytes.count` the NUL — or
simply noticing that a source-tree `grep` said `Binary file … matches` for a `.js` file.
The second is free, and it is the one to build the habit around: in a review that runs on
`grep`, that line means *a file just dropped out of your search*, not *this file is odd*.

---

### Handoffs

- **J2** — `/api/auth/refresh` re-mints on the `auth` bucket; confirm it cannot reset `pwa`.
  `/api/auth/register`'s `SELECT COUNT(*)` TOCTOU is unchanged and still held by launch
  procedure, per §I's re-test sequencing note. ~~`requireAuth` in `auth-middleware.js` is
  exported with zero callers — dead code, worth deleting.~~ **Wrong, and §J2 caught it: it has
  exactly one caller** — [index.js:1940](../../web/07_mining_pool_public/back-end-pool/index.js#L1940),
  where it is the *only* authentication on `POST /api/auth/change-password`. Acting on the
  handoff as written would have deleted the guard off a credential-mutating route. §J2's
  reading is the correct one: promote that route to `secureAdmin`/`freshAdmin` first, after
  which `requireAuth` genuinely does become dead. Re-verified here independently —
  `grep -rn requireAuth` over the backend returns the import, the definition, the export and
  that single call site.

  **Why the miss, since it bears on the matrix below.** The guard-chain column is machine-read,
  and it recognised the *named* chains (`secureAdmin`, `freshAdmin`, …) but not a guard applied
  as an inline factory call — `requireAuth(authManager)`. Two routes in the file are written
  that way; the other, `/api/admin/_authcheck`
  ([index.js:4944](../../web/07_mining_pool_public/back-end-pool/index.js#L4944)), was caught
  because it was read by hand. So the blind spot cost exactly one row, and it is now enumerated
  rather than assumed — grepping the route registrations for an inline `require*(` guard returns
  those two and nothing else. A later session extending the matrix must re-run that grep rather
  than trust the extractor.
- **J3** — the route-level ownership gate is present on all four money POSTs and
  `nostr-destination` register demands both proofs; the canonicalisation of `:addr` across the
  gate / balance read / withdrawal write / audit row is J3's, not verified here.
- **J9** — `applyToConfig` covers only `pool_info` + `payout`; J1-5 is one symptom and the
  full coverage question belongs there. Also J1-6, and: `rate_limits` is merged from config
  and `middleware()` treats a falsy limit as *no limit*, so an operator writing
  `"rate_limits": {"public": 0}` silently disables that bucket.
- **J12** — the `admin` bucket is 2400/min per IP (40 req/s) and it is the first middleware on
  99 routes, so it is the only thing in front of every admin handler for an unauthenticated
  caller while `admin_allowlist` is empty.
- **J13** — `POST /api/admin/poolstats/test` and `POST /api/admin/alerts/test` trigger outbound
  requests on demand at `secureAdmin`; the destinations are operator-set
  (`discord_webhook_url`, `slack_webhook_url`, poolstats endpoint).
- **J15** — ~~`login.html` loading `branding.js` (J1-1)~~ **closed in this session’s
  resolution pass**, not deferred: `branding.js` now skips the operator HTML/CSS/analytics
  sinks on a credential page. J15 should still review the *other* twelve pages that load
  `branding.js` — `account-settings.html` in particular, where the sinks still apply by
  design (§B accepted risk) on the page that renders the withdrawal form.
- **J16** — J1-7's nginx half; and the two-allowlist split (nginx `$admin_rules` from
  `pool.json:admin_allowlist` vs the app's runtime `IpFilter`) is a deployment-shaped question.

### Verification

Findings above were written **before** any code was touched. Three were then fixed in the same
session under plan rule 3 — see the resolution pass below for what was applied, what was
deliberately left, and why. The matrix at the end was generated mechanically from `index.js`
and hand-annotated: the guard column is machine-read, the `$`/Destr/Verdict columns are the
judgement of this pass. Its Verdict column reflects the state **as found**, so a row still
naming J1-1/J1-2/J1-3 is the finding, not the post-fix state.

---

---

### §J1 — resolution pass, 2026-08-25 (same day, add-ons, NOT VPS-TESTED)

Four of the ten findings fixed — J1-1, J1-3, J1-9 and J1-10 fully, J1-2 at its highest-value call
site. The rest are written up and left for a decision (see *Deliberately not fixed* below).
Unit-verified by two new harnesses wired into `npm test` — `scripts/test-admin-guards.js`
(26 assertions, the backend gate) and `scripts/test-branding-sinks.js` (18, the front-end
sink). The full suite is 104 assertions across five harnesses, all passing.

Reading `branding.js` in full to write the J1-1b fix — rather than only the sinks J1-1 had
named — turned up **J1-9**: five more operator-URL sinks of the same class, one of which
(the announcement banner) J1-1b alone would have left standing on the credential page. Fixed
here too. **J1-10** is a defect in this
session's own J1-2 fix, caught on self-review, recorded because of what it does to `grep`.

| # | Fix | Where |
|---|---|---|
| J1-1a | Nine analytics/branding script + CSS sinks added to `STEP_UP_SETTINGS_KEYS`, so changing one demands the password step-up + mandatory-2FA gate | [index.js:5950](../../web/07_mining_pool_public/back-end-pool/index.js#L5950) |
| J1-1b | `branding.js` no longer applies the operator HTML/CSS/analytics sinks on a credential page, so the escalation route is removed rather than only gated | [branding.js:32](../../web/07_mining_pool_public/public_html/js/branding.js#L32), [login.html:2](../../web/07_mining_pool_public/public_html/login.html#L2) |
| J1-2 | `updateSection` writes an `update_settings` audit row naming the changed keys, inside the transaction | [lib/pool-settings.js:1313-1404](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1313) |
| J1-3 | `POST /api/admin/locations` gates the endpoint branch with `stepUpRefused()` when `stratum_url`/`api_url` actually changes | [index.js:5509](../../web/07_mining_pool_public/back-end-pool/index.js#L5509) |
| J1-9 | One `safeHref()` scheme check in front of all five operator-URL → `href` sinks; the banner link is built as a DOM node instead of concatenated HTML | [branding.js:97](../../web/07_mining_pool_public/public_html/js/branding.js#L97) |
| J1-10 | The J1-2 sentinel's raw NUL byte replaced with `'<undef>'`, so `grep` reads the file as text again | [lib/pool-settings.js:1393](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1393) |

**Two things the fixes themselves turned up:**

- **J1-1 was under-counted in the finding: there are nine sinks, not seven.** Reading the
  render side before editing the gate list added two the write-up missed.
  [branding.js:378](../../web/07_mining_pool_public/public_html/js/branding.js#L378) builds a
  CSS rule by **string concatenation** — `'body{font-family:' + brand.font_family + ',…}'` —
  so `font_family` breaks out of the declaration and is a `<style>` injection, not a font
  name. And [branding.js:447](../../web/07_mining_pool_public/public_html/js/branding.js#L447)
  did `el.setAttribute('href', brand.cta_link)` on an `<a>`, so a `javascript:` URI executed
  on click — the line now reads `safeHref(…)` because **J1-9** closed that half separately, so
  follow the link expecting the fixed form. Both keys are now gated. This is why the finding says *read the sink, don't classify by
  the field's name* — "font family" and "call-to-action link" both read as copy.
- **J1-2's audit row must record key NAMES and never values**, which is not the obvious design.
  The `alerts` section holds `telegram_bot_token`, `discord_webhook_url` and
  `slack_webhook_url` ([pool-settings.js:269-271](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L269-L271)),
  and `admin_audit_log` is readable through `GET /api/admin/audit-log` **and its CSV export**.
  A `before → after` row — the natural thing to write, and what §B's column shape hints at —
  would have copied live credentials out of `pool_config` into a wider-read table and then out
  of the box in a CSV. Two assertions in the new harness pin this: the token and webhook values
  must not appear in any audit row.

- **J1-1's second half was deferred on a mis-framing, and the deferral was wrong.** The
  write-up said the fix was "remove `branding.js` from `login.html`", called that structural
  because the page would lose its theming, and handed it to J15. Reading `branding.js` before
  editing it shows that is not the shape of the fix at all: `apply()`
  ([branding.js:869](../../web/07_mining_pool_public/public_html/js/branding.js#L869)) is a flat
  orchestrator, and the theme, logo, accent colour and pool name come from `applyTheme()` /
  `applyContent()` — entirely separate calls from the three sink sites. The page keeps all of
  its branding. What is withheld is only the raw escape hatch.
  The codebase also already had the idiom: `data-maintenance="exempt"`, commented *"Pages that
  must stay reachable (login, admin, account) opt out"*, and `login.html` already declared
  `data-page="login"`. So the fix is two guards using machinery that was already there. It is
  now `isCredentialPage()`, checked in `applyTheme()` (the CSS sinks) and around the
  `applyAnalytics()` call (the script sinks).
  Keeping the escalation alive behind a lock, when removing it cost two `if`s, was the wrong
  call — a step-up gate is a lock on the door, not a reason to keep the explosives in the hall.
- **Analytics on the admin login page had negative value anyway.** Miners never authenticate
  (address-as-identity), so the only visitor whose page-view was being shipped to
  Google/Plausible/Matomo from `login.html` was the operator themselves.

**Behaviour changes an operator will notice:**

1. **Editing Analytics or the branding CSS/font fields now prompts for the password once.**
   `stepUpRefused` emits the same `403 {challenge_required:true}` contract as
   `requireFreshAuth`, and `adminFetch` ([stepup.js:29-42](../../web/07_mining_pool_public/public_html/js/stepup.js#L29-L42))
   already handles it transparently — prompt → `POST /api/admin/reauth` → retry once. No
   front-end change was needed. Verified the gate is *change*-triggered, not presence-triggered:
   the settings harvester re-posts every field in the section on every save, so a tagline or
   hero-heading edit still saves with no prompt. The GA-mirror write at
   [settings-common.js:217](../../web/07_mining_pool_public/back-end-pool/admin-panel/settings-common.js#L217)
   re-posts the section's *current* values with only `ga_tracking_id` changed, so it does not
   trip the gate either — which matters, because it is wrapped in a silent `catch`.
2. **Changing a region's stratum/API URL now prompts; renaming or re-flagging a region does
   not.** A brand-new region that carries a URL is treated as a change (there is no stored row
   to compare against), so adding an attacker-controlled "region" is gated too.
3. **The settings audit row is skipped when nothing moved.** Because the harvester posts the
   whole section every time, logging presence rather than change would have written a row every
   time an operator opened a settings page and pressed Save — and that noise would age real
   events out under `audit_log_keep_days`.

4. **The admin login page no longer runs operator HTML, custom CSS or analytics.** It keeps
   its theme, accent colour, logo and pool name — those come from `applyTheme()`/
   `applyContent()`, which are untouched. An operator who had put a chat widget or a
   verification pixel in `custom_head_html` will no longer see it on `/login.html`; that is
   the point. `account-settings.html` and the other eleven public pages are unchanged.

**One deliberate property, stated so it is not "fixed" later:** the J1-2 INSERT sits *inside*
the transaction, so a failed audit write rolls the settings write back. That is fail-closed,
and it is what §B asks for ("no admin mutation succeeds without an audit row"). The only way
the INSERT can fail is the `admin_id` → `users(id)` foreign key, and nothing in the backend
deletes a user row (accounts deactivate via `is_active`), so a live admin cannot reach it.
`userId = null` — `dormancy.js`'s policy-anchor re-arm — is fine because NULL never violates a
FK, and it produces an honestly unattributed row rather than none. `resetSection` has carried
the identical INSERT and the same FK all along, so this is not a new failure mode.

**Verification (unit-level; NOT VPS-tested).** `scripts/test-admin-guards.js` covers: an
audit row is written with the right admin/section/changed-key list; a no-op save writes none;
a whole-section save names only the edited key; credential values never appear in any row; a
rejected cross-field update rolls the audit row back with it; a `userId=null` system write is
recorded; all nine sinks plus the four original keys are in `STEP_UP_SETTINGS_KEYS`; every
gated key exists in a real section (a typo’d key makes the gate decorative); and ordinary
cosmetic keys stay ungated.

`scripts/test-branding-sinks.js` covers J1-1b by running `branding.js` itself — driven through
its real `load()` → fetch → `apply()` path, not a hook added for the test — against a minimal
DOM shim, asserting that a hostile `custom_head_html` / `custom_body_html` / `custom_css` /
`font_url` / `font_family` reaches the page on `home` and reaches **none** of head or body on
`login`. There is no jsdom in this project and adding one was not worth it, so **every
negative assertion is paired with a positive control on a non-credential page**: if the shim
were too thin the sinks would fail to inject there too, and the negatives would pass for the
wrong reason — so a failing control is a test FAILURE, not a skip. That control earned its
keep immediately: it caught the harness reading `href` only from `setAttribute` while the
font `<link>` assigns the `.href` property, which had made the `font_url` case a false pass.

The same harness covers J1-9 on **both** `home` and `login` — banners are deliberately not
exempted on the credential page, so the scheme check is the only guard and has to hold
everywhere. Hostile spellings asserted: plain `javascript:`, mixed-case `JaVaScRiPt:`, and a
tab-split `java<TAB>script:`. Each is paired with a legitimate `https:` banner on the same
page that MUST still render as an anchor — without that control a `safeHref()` that rejected
*everything* would score a clean pass, and one very nearly did: `URL` is a Node global, not an
ECMAScript intrinsic, so in a bare `vm` context every link was rejected by the catch until the
sandbox was given the constructor explicitly. The traversal is recursive, because the banner
anchor sits at `body > stack > bar > a` and a top-level scan would have made every J1-9
assertion vacuous.

J1-3’s comparison logic was verified the same way in a one-shot harness (label-only and
whitespace-only edits pass; either URL changing, or a new region carrying a URL, gates) —
**but that harness re-implements the comparison rather than driving the route, so what is
proven is the logic, not the wiring.** The route-level assertion needs J17’s live run.

**Deliberately not fixed — left for a decision:**

- **The other 24 unaudited mutating routes (J1-2).** The `updateSection` row closes the
  highest-value gap; ads/pages/posts/assets/alerts/`rate-limit-reset`/`database-cleanup` and the
  four IP-filter routes still write nothing. Each is one line, but it is 24 call sites across
  eight libs and belongs in one deliberate sweep, not tacked onto this pass.
- **Promoting `ads`/`pages`/`posts` writes to `freshAdmin` (J1-1).** A real change to the
  operator's content workflow — every CMS save would demand a password — not a bug fix.
- **J1-4 through J1-8.** J1-4 folds naturally into the audit sweep above; J1-5 and J1-6 are
  handed to **J9**; J1-7's Express half is a one-token edit but pairs with the vhost review in
  **J16**; J1-8 is Info.

**Status after this pass:** J1-1 **FIXED 2026-08-25** (gated *and* the sink removed from
the credential page) · J1-2 **partially fixed** (the settings write is audited; 24 routes
remain) · J1-3 **FIXED 2026-08-25** · J1-4 – J1-8 **OPEN** · J1-9 **FIXED 2026-08-26**
· J1-10 **FIXED 2026-08-26**.

Four of the ten closed; J1-2 partial; five open and assigned. Every fix is unit-verified and
**none of it has run on a VPS** — J17 remains the gate.

### The matrix

Guard chain column is machine-read from the route registration. `$` = moves GRIN, changes a payout destination, or sets an amount that will be credited. Destr = irreversible without a backup.

**Admin — mutating** — 55 routes

| Method | Path | Line | Guard chain | $ | Destr | Verdict |
|---|---|---|---|---|---|---|
| POST | `/api/admin/reauth` | [1839](../../web/07_mining_pool_public/back-end-pool/index.js#L1839) | secureAdmin | — | — | OK — it *is* the step-up |
| POST | `/api/admin/2fa/enroll/begin` | [1880](../../web/07_mining_pool_public/back-end-pool/index.js#L1880) | freshAdminEnroll | — | — | OK — deliberate `requireTotpEnrolled` bypass |
| POST | `/api/admin/2fa/enroll/confirm` | [1893](../../web/07_mining_pool_public/back-end-pool/index.js#L1893) | freshAdminEnroll | — | — | OK — same |
| POST | `/api/admin/2fa/disable` | [1903](../../web/07_mining_pool_public/back-end-pool/index.js#L1903) | freshAdmin | — | Y | OK |
| POST | `/api/admin/2fa/recovery/regenerate` | [1913](../../web/07_mining_pool_public/back-end-pool/index.js#L1913) | freshAdmin | — | Y | OK |
| POST | `/api/admin/withdrawals/:id/retry` | [2170](../../web/07_mining_pool_public/back-end-pool/index.js#L2170) | freshAdmin | Y | Y | OK |
| POST | `/api/admin/withdrawals/:id/cancel` | [2219](../../web/07_mining_pool_public/back-end-pool/index.js#L2219) | freshAdmin | Y | Y | OK |
| POST | `/api/admin/payouts/freeze` | [2297](../../web/07_mining_pool_public/back-end-pool/index.js#L2297) | freshAdmin | Y | — | OK |
| POST | `/api/admin/payouts/resume` | [2308](../../web/07_mining_pool_public/back-end-pool/index.js#L2308) | freshAdmin | Y | — | OK |
| POST | `/api/admin/dormancy/run` | [2335](../../web/07_mining_pool_public/back-end-pool/index.js#L2335) | freshAdmin | Y | Y | OK |
| POST | `/api/admin/dormancy/verify-owner` | [2366](../../web/07_mining_pool_public/back-end-pool/index.js#L2366) | secureAdmin | — | — | OK — read-only match/no-match; the money action it unlocks is freshAdmin |
| POST | `/api/admin/dormancy/manual-payout` | [2380](../../web/07_mining_pool_public/back-end-pool/index.js#L2380) | freshAdmin | Y | Y | OK |
| POST | `/api/admin/dormancy/send-payout` | [2415](../../web/07_mining_pool_public/back-end-pool/index.js#L2415) | freshAdmin | Y | Y | OK |
| POST | `/api/admin/wallet/adopt-identity` | [2468](../../web/07_mining_pool_public/back-end-pool/index.js#L2468) | freshAdmin | Y | Y | OK |
| POST | `/api/admin/ads` | [2497](../../web/07_mining_pool_public/back-end-pool/index.js#L2497) | secureAdmin | — | Y | **J1-1** `html_code` executable sink |
| POST | `/api/admin/ads/:id` | [2503](../../web/07_mining_pool_public/back-end-pool/index.js#L2503) | secureAdmin | — | Y | **J1-1** |
| DELETE | `/api/admin/ads/:id` | [2511](../../web/07_mining_pool_public/back-end-pool/index.js#L2511) | secureAdmin | — | Y | **J1-1** |
| POST | `/api/admin/ads-config` | [2521](../../web/07_mining_pool_public/back-end-pool/index.js#L2521) | secureAdmin | — | — | OK |
| POST | `/api/admin/media` | [2554](../../web/07_mining_pool_public/back-end-pool/index.js#L2554) | secureAdmin | — | — | OK |
| POST | `/api/admin/pages` | [2570](../../web/07_mining_pool_public/back-end-pool/index.js#L2570) | secureAdmin | — | Y | **J1-1** CMS body HTML |
| POST | `/api/admin/pages/:id` | [2576](../../web/07_mining_pool_public/back-end-pool/index.js#L2576) | secureAdmin | — | Y | **J1-1** |
| DELETE | `/api/admin/pages/:id` | [2584](../../web/07_mining_pool_public/back-end-pool/index.js#L2584) | secureAdmin | — | Y | **J1-1** |
| POST | `/api/admin/posts` | [2600](../../web/07_mining_pool_public/back-end-pool/index.js#L2600) | secureAdmin | — | Y | **J1-1** |
| POST | `/api/admin/posts/:id` | [2606](../../web/07_mining_pool_public/back-end-pool/index.js#L2606) | secureAdmin | — | Y | **J1-1** |
| DELETE | `/api/admin/posts/:id` | [2614](../../web/07_mining_pool_public/back-end-pool/index.js#L2614) | secureAdmin | — | Y | **J1-1** |
| POST | `/api/admin/poolstats/update-key` | [4473](../../web/07_mining_pool_public/back-end-pool/index.js#L4473) | freshAdmin | — | — | OK |
| POST | `/api/admin/poolstats/test` | [4490](../../web/07_mining_pool_public/back-end-pool/index.js#L4490) | secureAdmin | — | — | Outbound push on demand → J13 |
| POST | `/api/admin/security/rate-limit-reset` | [4516](../../web/07_mining_pool_public/back-end-pool/index.js#L4516) | secureAdmin | — | Y | **J1-4** lower tier than its two siblings; unaudited |
| POST | `/api/admin/security/ip-allowlist/add` | [4540](../../web/07_mining_pool_public/back-end-pool/index.js#L4540) | freshAdmin | — | Y | **J1-2** unaudited |
| POST | `/api/admin/security/ip-allowlist/remove` | [4557](../../web/07_mining_pool_public/back-end-pool/index.js#L4557) | freshAdmin | — | Y | **J1-2** unaudited |
| POST | `/api/admin/security/ip-blacklist/add` | [4570](../../web/07_mining_pool_public/back-end-pool/index.js#L4570) | freshAdmin | — | — | **J1-2** unaudited |
| POST | `/api/admin/security/ip-blacklist/remove` | [4587](../../web/07_mining_pool_public/back-end-pool/index.js#L4587) | freshAdmin | — | Y | **J1-2** unaudited |
| POST | `/api/admin/security/temp-ban/clear` | [4763](../../web/07_mining_pool_public/back-end-pool/index.js#L4763) | freshAdmin | — | Y | OK |
| POST | `/api/admin/security/revoke-sessions` | [4777](../../web/07_mining_pool_public/back-end-pool/index.js#L4777) | freshAdmin | — | Y | OK |
| POST | `/api/admin/alerts/test` | [4797](../../web/07_mining_pool_public/back-end-pool/index.js#L4797) | secureAdmin | — | — | Outbound send on demand → J13 |
| POST | `/api/admin/alerts/:alertId/acknowledge` | [4844](../../web/07_mining_pool_public/back-end-pool/index.js#L4844) | secureAdmin | — | — | OK |
| POST | `/api/admin/alerts/:alertId/snooze` | [4858](../../web/07_mining_pool_public/back-end-pool/index.js#L4858) | secureAdmin | — | — | OK |
| POST | `/api/admin/locations` | [5487](../../web/07_mining_pool_public/back-end-pool/index.js#L5487) | secureAdmin | — | — | **J1-3** `stratum_url` retargets miners at secureAdmin; wg branch correctly `stepUpRefused()` |
| POST | `/api/admin/gateways/server` | [5633](../../web/07_mining_pool_public/back-end-pool/index.js#L5633) | freshAdmin | — | Y | OK |
| DELETE | `/api/admin/locations/:id` | [5695](../../web/07_mining_pool_public/back-end-pool/index.js#L5695) | freshAdmin | — | Y | OK |
| POST | `/api/admin/miners/:addr/inject` | [5801](../../web/07_mining_pool_public/back-end-pool/index.js#L5801) | freshAdmin | Y | — | OK — §C4 promotion done |
| POST | `/api/admin/miners/:addr/ban` | [5839](../../web/07_mining_pool_public/back-end-pool/index.js#L5839) | freshAdmin | Y | Y | OK |
| POST | `/api/admin/miners/:addr/unban` | [5855](../../web/07_mining_pool_public/back-end-pool/index.js#L5855) | freshAdmin | — | — | OK |
| POST | `/api/admin/incentives/award` | [5874](../../web/07_mining_pool_public/back-end-pool/index.js#L5874) | freshAdmin | Y | — | OK |
| POST | `/api/admin/settings/:section` | [5989](../../web/07_mining_pool_public/back-end-pool/index.js#L5989) | secureAdmin | Y | Y | **J1-1 / J1-2** — `analytics`+`branding` ungated; write unaudited |
| POST | `/api/admin/settings/:section/restore` | [6027](../../web/07_mining_pool_public/back-end-pool/index.js#L6027) | freshAdmin | Y | Y | OK |
| POST | `/api/admin/database/cleanup` | [6047](../../web/07_mining_pool_public/back-end-pool/index.js#L6047) | freshAdmin | — | Y | OK |
| POST | `/api/admin/incentives/prize-pool/topup` | [6079](../../web/07_mining_pool_public/back-end-pool/index.js#L6079) | freshAdmin | Y | — | OK |
| POST | `/api/admin/incentives/lottery/draw-now` | [6105](../../web/07_mining_pool_public/back-end-pool/index.js#L6105) | freshAdmin | Y | — | OK |
| POST | `/api/admin/incentives/campaigns` | [6134](../../web/07_mining_pool_public/back-end-pool/index.js#L6134) | freshAdmin | Y | — | OK |
| PUT | `/api/admin/incentives/campaigns/:id` | [6147](../../web/07_mining_pool_public/back-end-pool/index.js#L6147) | freshAdmin | Y | — | OK |
| POST | `/api/admin/incentives/campaigns/:id/cancel` | [6160](../../web/07_mining_pool_public/back-end-pool/index.js#L6160) | freshAdmin | Y | Y | OK |
| POST | `/api/admin/incentives/campaigns/:id/run` | [6174](../../web/07_mining_pool_public/back-end-pool/index.js#L6174) | freshAdmin | Y | — | OK |
| POST | `/api/admin/assets/upload` | [6193](../../web/07_mining_pool_public/back-end-pool/index.js#L6193) | secureAdmin | — | — | OK — §A hardening holds |
| DELETE | `/api/admin/assets/:filename` | [6228](../../web/07_mining_pool_public/back-end-pool/index.js#L6228) | secureAdmin | — | Y | Destructive at lower tier; DB-row-then-basename unlink (§A). Low |

**Miner money actions (ownership-gated, no admin session)** — 4 routes

| Method | Path | Line | Guard chain | $ | Destr | Verdict |
|---|---|---|---|---|---|---|
| POST | `/api/account/:addr/withdraw` | [3520](../../web/07_mining_pool_public/back-end-pool/index.js#L3520) | rateLimiter:withdraw | Y | — | OK — `verifyOwnerProof` + `withdraw` bucket |
| POST | `/api/account/:addr/withdraw/:id/finalize` | [3605](../../web/07_mining_pool_public/back-end-pool/index.js#L3605) | rateLimiter:withdraw | Y | — | OK |
| POST | `/api/account/:addr/nostr-destination` | [3683](../../web/07_mining_pool_public/back-end-pool/index.js#L3683) | rateLimiter:withdraw | Y | Y | OK — `requireBothProofs`, stricter than withdraw |
| DELETE | `/api/account/:addr/nostr-destination` | [3763](../../web/07_mining_pool_public/back-end-pool/index.js#L3763) | rateLimiter:withdraw | Y | Y | OK — `requireBothProofs`, stricter than withdraw |

**Auth** — 7 routes

| Method | Path | Line | Guard chain | $ | Destr | Verdict |
|---|---|---|---|---|---|---|
| GET | `/api/auth/captcha` | [1616](../../web/07_mining_pool_public/back-end-pool/index.js#L1616) | rateLimiter:public | — | — | OK |
| POST | `/api/auth/register` | [1621](../../web/07_mining_pool_public/back-end-pool/index.js#L1621) | PUBLIC/none | — | — | First-admin-only; TOCTOU held by launch procedure (§I) → J2 |
| POST | `/api/auth/login` | [1680](../../web/07_mining_pool_public/back-end-pool/index.js#L1680) | PUBLIC/none | — | — | OK — captcha before credential work, peek-then-consume |
| POST | `/api/auth/login/totp` | [1760](../../web/07_mining_pool_public/back-end-pool/index.js#L1760) | rateLimiter:auth | — | — | OK |
| POST | `/api/auth/refresh` | [1798](../../web/07_mining_pool_public/back-end-pool/index.js#L1798) | rateLimiter:auth | — | — | `pwa` re-mint → J2 |
| POST | `/api/auth/logout` | [1928](../../web/07_mining_pool_public/back-end-pool/index.js#L1928) | rateLimiter:auth | — | — | OK |
| POST | `/api/auth/change-password` | [1940](../../web/07_mining_pool_public/back-end-pool/index.js#L1940) | rateLimiter:auth → `requireAuth` | — | — | **Corrected 2026-08-26** — the chain read `rateLimiter:auth` alone and was graded OK; the extractor missed the inline `requireAuth(authManager)`. Authenticated, but on the non-admin guard with no `ipFilter` and no step-up on a password-changing route — owned by **J2** |

**Admin — read-only** — 47 routes

| Method | Path | Line | Guard chain | $ | Destr | Verdict |
|---|---|---|---|---|---|---|
| GET | `/api/admin/2fa/status` | [1863](../../web/07_mining_pool_public/back-end-pool/index.js#L1863) | secureAdmin | — | — | OK |
| GET | `/api/admin/node-status` | [2111](../../web/07_mining_pool_public/back-end-pool/index.js#L2111) | secureAdmin | — | — | OK |
| GET | `/api/admin/block-monitor` | [2117](../../web/07_mining_pool_public/back-end-pool/index.js#L2117) | secureAdmin | — | — | OK |
| GET | `/api/admin/reward-stats` | [2123](../../web/07_mining_pool_public/back-end-pool/index.js#L2123) | secureAdmin | — | — | OK |
| GET | `/api/admin/withdrawals` | [2137](../../web/07_mining_pool_public/back-end-pool/index.js#L2137) | secureAdmin | — | — | OK |
| GET | `/api/admin/withdrawal-scheduler` | [2156](../../web/07_mining_pool_public/back-end-pool/index.js#L2156) | secureAdmin | — | — | OK |
| GET | `/api/admin/reconciliation` | [2279](../../web/07_mining_pool_public/back-end-pool/index.js#L2279) | secureAdmin | — | — | OK |
| GET | `/api/admin/payouts/control` | [2292](../../web/07_mining_pool_public/back-end-pool/index.js#L2292) | secureAdmin | — | — | OK |
| GET | `/api/admin/dormancy` | [2321](../../web/07_mining_pool_public/back-end-pool/index.js#L2321) | secureAdmin | — | — | OK |
| GET | `/api/admin/payouts/wallet-audit` | [2442](../../web/07_mining_pool_public/back-end-pool/index.js#L2442) | secureAdmin | — | — | OK |
| GET | `/api/admin/wallet/identity` | [2456](../../web/07_mining_pool_public/back-end-pool/index.js#L2456) | secureAdmin | — | — | OK |
| GET | `/api/admin/ads` | [2487](../../web/07_mining_pool_public/back-end-pool/index.js#L2487) | secureAdmin | — | Y | **J1-1** `html_code` executable sink |
| GET | `/api/admin/pages` | [2564](../../web/07_mining_pool_public/back-end-pool/index.js#L2564) | secureAdmin | — | Y | **J1-1** CMS body HTML |
| GET | `/api/admin/posts` | [2594](../../web/07_mining_pool_public/back-end-pool/index.js#L2594) | secureAdmin | — | Y | **J1-1** |
| GET | `/api/admin/blocks` | [2626](../../web/07_mining_pool_public/back-end-pool/index.js#L2626) | secureAdmin | — | — | OK |
| GET | `/api/admin/export/payouts.csv` | [2700](../../web/07_mining_pool_public/back-end-pool/index.js#L2700) | secureAdmin | — | — | OK |
| GET | `/api/admin/export/fee-revenue.csv` | [2717](../../web/07_mining_pool_public/back-end-pool/index.js#L2717) | secureAdmin | — | — | OK |
| GET | `/api/admin/metrics` | [4324](../../web/07_mining_pool_public/back-end-pool/index.js#L4324) | secureAdmin | — | — | OK |
| GET | `/api/admin/audit-log` | [4343](../../web/07_mining_pool_public/back-end-pool/index.js#L4343) | secureAdmin | — | — | OK |
| GET | `/api/admin/payments/audit` | [4376](../../web/07_mining_pool_public/back-end-pool/index.js#L4376) | secureAdmin | — | — | OK |
| GET | `/api/admin/poolstats` | [4464](../../web/07_mining_pool_public/back-end-pool/index.js#L4464) | secureAdmin | — | — | OK |
| GET | `/api/admin/security/rate-limit-status` | [4505](../../web/07_mining_pool_public/back-end-pool/index.js#L4505) | secureAdmin | — | — | OK |
| GET | `/api/admin/security/ip-filter-status` | [4529](../../web/07_mining_pool_public/back-end-pool/index.js#L4529) | secureAdmin | — | — | OK |
| GET | `/api/admin/security/login-history` | [4613](../../web/07_mining_pool_public/back-end-pool/index.js#L4613) | secureAdmin | — | — | OK |
| GET | `/api/admin/security/auth-activity` | [4658](../../web/07_mining_pool_public/back-end-pool/index.js#L4658) | secureAdmin | — | — | OK |
| GET | `/api/admin/alerts` | [4823](../../web/07_mining_pool_public/back-end-pool/index.js#L4823) | secureAdmin | — | — | OK |
| GET | `/api/admin/alerts/config` | [4878](../../web/07_mining_pool_public/back-end-pool/index.js#L4878) | secureAdmin | — | — | OK |
| GET | `/api/admin/me` | [4901](../../web/07_mining_pool_public/back-end-pool/index.js#L4901) | secureAdmin | — | — | OK |
| GET | `/api/admin/_authcheck` | [4932](../../web/07_mining_pool_public/back-end-pool/index.js#L4932) | requireAdmin(bare) | — | — | OK — verified side-effect-free (204, no DB, no audit write) |
| GET | `/api/admin/dashboard` | [4937](../../web/07_mining_pool_public/back-end-pool/index.js#L4937) | secureAdmin | — | — | OK |
| GET | `/api/admin/health` | [5048](../../web/07_mining_pool_public/back-end-pool/index.js#L5048) | secureAdmin | — | — | OK |
| GET | `/api/admin/health/node` | [5167](../../web/07_mining_pool_public/back-end-pool/index.js#L5167) | secureAdmin | — | — | OK |
| GET | `/api/admin/health/wallet` | [5239](../../web/07_mining_pool_public/back-end-pool/index.js#L5239) | secureAdmin | — | — | OK |
| GET | `/api/admin/health/system` | [5307](../../web/07_mining_pool_public/back-end-pool/index.js#L5307) | secureAdmin | — | — | OK |
| GET | `/api/admin/health/gateways` | [5388](../../web/07_mining_pool_public/back-end-pool/index.js#L5388) | secureAdmin | — | — | OK |
| GET | `/api/admin/locations` | [5473](../../web/07_mining_pool_public/back-end-pool/index.js#L5473) | secureAdmin | — | — | **J1-3** `stratum_url` retargets miners at secureAdmin; wg branch correctly `stepUpRefused()` |
| GET | `/api/admin/gateways/server` | [5607](../../web/07_mining_pool_public/back-end-pool/index.js#L5607) | secureAdmin | — | Y | OK |
| GET | `/api/admin/gateways/:region/pairing` | [5679](../../web/07_mining_pool_public/back-end-pool/index.js#L5679) | secureAdmin | — | — | OK — pairing string is hub **public** key + endpoint; no credential |
| GET | `/api/admin/miners` | [5732](../../web/07_mining_pool_public/back-end-pool/index.js#L5732) | secureAdmin | — | — | OK |
| GET | `/api/admin/miners/:addr` | [5757](../../web/07_mining_pool_public/back-end-pool/index.js#L5757) | secureAdmin | — | — | OK |
| GET | `/api/admin/settings` | [5913](../../web/07_mining_pool_public/back-end-pool/index.js#L5913) | secureAdmin | — | — | OK |
| GET | `/api/admin/settings/:section` | [5923](../../web/07_mining_pool_public/back-end-pool/index.js#L5923) | secureAdmin | Y | Y | **J1-1 / J1-2** — `analytics`+`branding` ungated; write unaudited |
| GET | `/api/admin/database/status` | [6039](../../web/07_mining_pool_public/back-end-pool/index.js#L6039) | secureAdmin | — | — | OK |
| GET | `/api/admin/incentives/prize-pool` | [6060](../../web/07_mining_pool_public/back-end-pool/index.js#L6060) | secureAdmin | — | — | OK |
| GET | `/api/admin/incentives/lottery/draws` | [6092](../../web/07_mining_pool_public/back-end-pool/index.js#L6092) | secureAdmin | — | — | OK |
| GET | `/api/admin/incentives/campaigns` | [6126](../../web/07_mining_pool_public/back-end-pool/index.js#L6126) | secureAdmin | Y | — | OK |
| GET | `/api/admin/assets` | [6218](../../web/07_mining_pool_public/back-end-pool/index.js#L6218) | secureAdmin | — | — | OK |

**Public / miner read surface** — 50 routes

| Method | Path | Line | Guard chain | $ | Destr | Verdict |
|---|---|---|---|---|---|---|
| GET | `/api/public/branding` | [922](../../web/07_mining_pool_public/back-end-pool/index.js#L922) | rateLimiter:public | — | — | OK |
| GET | `/api/public/price` | [979](../../web/07_mining_pool_public/back-end-pool/index.js#L979) | rateLimiter:public | — | — | OK |
| GET | `/api/public/endpoints` | [1106](../../web/07_mining_pool_public/back-end-pool/index.js#L1106) | rateLimiter:public | — | — | OK |
| GET | `/api/public/lottery/winners` | [1171](../../web/07_mining_pool_public/back-end-pool/index.js#L1171) | rateLimiter:public | — | — | OK |
| GET | `/api/public/lottery/stats` | [1190](../../web/07_mining_pool_public/back-end-pool/index.js#L1190) | rateLimiter:public | — | — | OK |
| GET | `/api/public/page/:key` | [1210](../../web/07_mining_pool_public/back-end-pool/index.js#L1210) | rateLimiter:public | — | — | OK |
| GET | `/api/public/pages` | [1225](../../web/07_mining_pool_public/back-end-pool/index.js#L1225) | rateLimiter:public | — | — | OK |
| GET | `/api/public/posts` | [1238](../../web/07_mining_pool_public/back-end-pool/index.js#L1238) | rateLimiter:public | — | — | OK |
| GET | `/api/public/post/:slug` | [1252](../../web/07_mining_pool_public/back-end-pool/index.js#L1252) | rateLimiter:public | — | — | OK |
| GET | `/blog/rss.xml` | [1267](../../web/07_mining_pool_public/back-end-pool/index.js#L1267) | rateLimiter:public | — | — | OK |
| GET | `/robots.txt` | [1309](../../web/07_mining_pool_public/back-end-pool/index.js#L1309) | rateLimiter:public | — | — | OK |
| GET | `/sitemap.xml` | [1334](../../web/07_mining_pool_public/back-end-pool/index.js#L1334) | rateLimiter:public | — | — | OK |
| GET | `/manifest.json` | [1366](../../web/07_mining_pool_public/back-end-pool/index.js#L1366) | rateLimiter:public | — | — | OK |
| GET | `/blog/:slug` | [1548](../../web/07_mining_pool_public/back-end-pool/index.js#L1548) | rateLimiter:public | — | — | OK |
| GET | `/page.html` | [1577](../../web/07_mining_pool_public/back-end-pool/index.js#L1577) | rateLimiter:public | — | — | OK |
| GET | `/api/config/pool-info` | [1956](../../web/07_mining_pool_public/back-end-pool/index.js#L1956) | rateLimiter:public | — | — | OK |
| GET | `/api/stratum/stats` | [1973](../../web/07_mining_pool_public/back-end-pool/index.js#L1973) | rateLimiter:public | — | — | OK |
| GET | `/api/pool/stats` | [1995](../../web/07_mining_pool_public/back-end-pool/index.js#L1995) | rateLimiter:public | — | — | OK |
| GET | `/api/pool/status` | [2024](../../web/07_mining_pool_public/back-end-pool/index.js#L2024) | rateLimiter:public | — | — | OK |
| GET | `/api/pool/blocks` | [2058](../../web/07_mining_pool_public/back-end-pool/index.js#L2058) | rateLimiter:public | — | — | OK |
| GET | `/api/pool/blocks/history` | [2085](../../web/07_mining_pool_public/back-end-pool/index.js#L2085) | rateLimiter:public | — | — | OK |
| GET | `/api/account/:addr/shares` | [2096](../../web/07_mining_pool_public/back-end-pool/index.js#L2096) | rateLimiter:public | — | — | OK |
| GET | `/api/public/ads` | [2532](../../web/07_mining_pool_public/back-end-pool/index.js#L2532) | rateLimiter:public | — | — | OK |
| POST | `/api/public/ads/event` | [2545](../../web/07_mining_pool_public/back-end-pool/index.js#L2545) | rateLimiter:public | — | — | OK |
| GET | `/api/pool/miners` | [2744](../../web/07_mining_pool_public/back-end-pool/index.js#L2744) | rateLimiter:public | — | — | OK |
| GET | `/api/pool/top-block-finders` | [2765](../../web/07_mining_pool_public/back-end-pool/index.js#L2765) | rateLimiter:public | — | — | OK |
| GET | `/api/pool/payments` | [2794](../../web/07_mining_pool_public/back-end-pool/index.js#L2794) | rateLimiter:public | — | — | OK |
| GET | `/api/pool/unclaimed` | [2816](../../web/07_mining_pool_public/back-end-pool/index.js#L2816) | rateLimiter:public | — | — | OK — addresses masked |
| GET | `/api/account/:addr` | [2832](../../web/07_mining_pool_public/back-end-pool/index.js#L2832) | rateLimiter:public | — | — | OK |
| GET | `/api/account/:addr/workers` | [2942](../../web/07_mining_pool_public/back-end-pool/index.js#L2942) | rateLimiter:public | — | — | OK |
| GET | `/api/account/:addr/hashrate/history` | [2954](../../web/07_mining_pool_public/back-end-pool/index.js#L2954) | rateLimiter:public | — | — | OK |
| GET | `/api/pool/hashrate/history` | [2971](../../web/07_mining_pool_public/back-end-pool/index.js#L2971) | rateLimiter:public | — | — | OK |
| GET | `/api/pool/metrics/history` | [2983](../../web/07_mining_pool_public/back-end-pool/index.js#L2983) | rateLimiter:public | — | — | OK |
| GET | `/api/pool/metrics/history/regions` | [2995](../../web/07_mining_pool_public/back-end-pool/index.js#L2995) | rateLimiter:public | — | — | OK |
| GET | `/api/pool/payments/history` | [3008](../../web/07_mining_pool_public/back-end-pool/index.js#L3008) | rateLimiter:public | — | — | OK |
| GET | `/api/pool/donors` | [3024](../../web/07_mining_pool_public/back-end-pool/index.js#L3024) | rateLimiter:public | — | — | OK |
| GET | `/api/pool/prize-pool` | [3082](../../web/07_mining_pool_public/back-end-pool/index.js#L3082) | rateLimiter:public | — | — | OK |
| GET | `/api/pool/effort` | [3107](../../web/07_mining_pool_public/back-end-pool/index.js#L3107) | rateLimiter:public | — | — | OK |
| GET | `/api/pool/poolstats` | [3185](../../web/07_mining_pool_public/back-end-pool/index.js#L3185) | rateLimiter:public | — | — | OK |
| GET | `/api/account/:addr/balance/log` | [3298](../../web/07_mining_pool_public/back-end-pool/index.js#L3298) | rateLimiter:public | — | — | OK |
| GET | `/api/account/:addr/withdrawals` | [3355](../../web/07_mining_pool_public/back-end-pool/index.js#L3355) | rateLimiter:public | — | — | OK |
| GET | `/api/account/:addr/earnings` | [3409](../../web/07_mining_pool_public/back-end-pool/index.js#L3409) | rateLimiter:public | — | — | OK |
| GET | `/api/account/:addr/tor-check` | [3487](../../web/07_mining_pool_public/back-end-pool/index.js#L3487) | rateLimiter:torcheck | — | — | OK — §H3 fix in place; timing → J3 |
| GET | `/api/pool/locations` | [3798](../../web/07_mining_pool_public/back-end-pool/index.js#L3798) | rateLimiter:public | — | — | OK |
| GET | `/api/pool/topology` | [3863](../../web/07_mining_pool_public/back-end-pool/index.js#L3863) | rateLimiter:public | — | — | OK |
| GET | `/api/network/peers` | [4078](../../web/07_mining_pool_public/back-end-pool/index.js#L4078) | rateLimiter:public | — | — | OK |
| GET | `/api/pool/stats/regions` | [4156](../../web/07_mining_pool_public/back-end-pool/index.js#L4156) | rateLimiter:public | — | — | OK |
| GET | `/api/stratum/hashrate` | [4283](../../web/07_mining_pool_public/back-end-pool/index.js#L4283) | rateLimiter:public | — | — | OK |
| GET | `/api/stratum/top-miners` | [4295](../../web/07_mining_pool_public/back-end-pool/index.js#L4295) | rateLimiter:public | — | — | OK |
| GET | `/api/stratum/top-avg-hashrate` | [4313](../../web/07_mining_pool_public/back-end-pool/index.js#L4313) | rateLimiter:public | — | — | OK |

---

## §J2 — Auth, session & 2FA (2026-08-25, add-ons, NOT VPS-TESTED)

Second session of the pre-mainnet §J pass (see the Status roll-up at the top of this file).
Scope: [`lib/auth.js`](../../web/07_mining_pool_public/back-end-pool/lib/auth.js) (702),
[`lib/totp.js`](../../web/07_mining_pool_public/back-end-pool/lib/totp.js) (87),
[`lib/captcha.js`](../../web/07_mining_pool_public/back-end-pool/lib/captcha.js) (59),
[`scripts/admin-reset.js`](../../web/07_mining_pool_public/back-end-pool/scripts/admin-reset.js) (382),
the seven `/api/auth/*` routes, the five `/api/admin/2fa/*` routes and `/api/admin/reauth`.
Question asked: **can anyone get an admin session they shouldn't have, or keep one after they
should have lost it?**

Findings were reached by reading, then **confirmed by execution** — a one-shot harness bound the
real `AuthManager` to an in-memory `node:sqlite` DB carrying the production `users` /
`admin_recovery_codes` schema and exercised eight behaviours. Its output is quoted per finding.
No server was started and no VPS was touched (plan rule 5); the harness lived in the scratchpad
and its probe list is in *Verification* below.

### Threat actors used in this section

| Label | Means |
|---|---|
| **Anonymous** | Internet, no credentials, reaches nginx → `/api/auth/*` |
| **Session thief** | Holds a live `access_token` cookie (XSS on a same-origin page, an unlocked workstation, a lifted cookie jar) but does **not** know the password |
| **Password holder** | Knows the admin password (phished, reused, leaked) but has no TOTP device |
| **On-box root** | Shell on the pool server — Info only, per plan rule 7 |

---

### J2-1 — [High] `/api/admin/reauth` counts no failed attempts, so the step-up password can be ground at 2400/min — and step-up never asks for a second factor even on a mandatory-2FA pool — **FIXED 2026-08-26 (see §J2 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J2-1).**

### J2-2 — [Medium] First-admin registration TOCTOU is real and remotely winnable — two concurrent registrations both become admins — **FIXED 2026-08-26 (see §J2 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J2-2).**

### J2-3 — [Medium] The 2FA login budget is per-IP only and the `twofa_token` is unlimited-use, so a distributed attacker holding the password is not bounded — **FIXED 2026-08-26 (see §J2 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J2-3).**

### J2-4 — [Medium] Any anonymous client can evict every pending CAPTCHA challenge and lock the operator out of the admin panel — **FIXED 2026-08-26 (see §J2 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J2-4).**

### J2-5 — [Medium] TOTP codes are replayable — no used-counter, so one observed code works repeatedly across its 90-second window — **FIXED 2026-08-26 (see §J2 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J2-5).**

### J2-6 — [Low] The break-glass CLI and the *Revoke sessions* kill-switch both told the operator that sessions were revoked, when neither can evict a live access token — **FIXED 2026-08-25 (text only; the mechanism is §C3 and stays open)**

**Threat actor: none — this is an incident-response correctness bug.** Filed as a new §J finding
rather than an edit to §C3 (plan rule 2) because the *mechanism* is the known open item while the
*consequence* is new: two controls whose entire job is compromise recovery were reporting a
guarantee they do not provide.

The mechanism, re-confirmed by execution rather than assumed:

```
[2] access token valid before revoke: true | fresh(step-up): true
[2] access token valid AFTER  revoke: true | fresh(step-up): true
[2] refresh token after revoke: "Refresh token revoked"
[3] access token still valid after password change: true
```

`revokeUserTokens` bumps `users.token_version`
([lib/auth.js:464](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L464)); only
`refreshAccessToken` compares it
([:408](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L408)). `requireAdmin` /
`requireFreshAuth`
([lib/auth-middleware.js:191](../../web/07_mining_pool_public/back-end-pool/lib/auth-middleware.js#L191),
[:223](../../web/07_mining_pool_public/back-end-pool/lib/auth-middleware.js#L223)) verify the
signature and read `is_admin` straight off the payload — no `tv` check, and no `is_active` re-read
either. The bound is the idle window, `access.session_timeout_hours`, validated 1–24 h
([lib/pool-settings.js:906](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L906))
and re-clamped identically in `_sessionPolicy`
([lib/auth.js:75](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L75)). All correct, and
all already documented in memory `project_pool_admin_session_idle`.

What was wrong is what the operator is *told* at the moment they act on it:

| Where | Said | Actually |
|---|---|---|
| `POST /api/admin/security/revoke-sessions` response | *"Other devices lose access within the **1-hour** session window"* | 1 h is the fallback constant; the live value is operator-set up to **24 h** — understated by up to 24× |
| `admin-reset --help` | *"also REVOKES that account's existing sessions, **so a stolen cookie can't outlive the recovery**"* | a stolen cookie outlives it by up to 24 h |
| `--clear-2fa` output | *"Sessions revoked."* | refresh tokens revoked |
| `--set-password` output | *"Existing sessions revoked."* | refresh tokens revoked |

An operator who has just had a laptop stolen reads the first line, believes the intruder is out,
and does not take the one action that would work.

**Fixed this session** (plan rule 3 — pure text, no behaviour change):

- [index.js:4777](../../web/07_mining_pool_public/back-end-pool/index.js#L4777) — the response now
  reports the **live** `sessionPolicy().idle` in hours, adds `idle_window_hours` to the JSON, states
  plainly that access tokens cannot be revoked, and names the only faster control: rotate
  `jwt_secret` in `pool.json` and restart, which invalidates every token at once.
- [scripts/admin-reset.js:213](../../web/07_mining_pool_public/back-end-pool/scripts/admin-reset.js#L213)
  — `revokeSessions()`'s comment now says it stops renewal and does not evict a live session; the
  `--help` paragraph and both action outputs say "Refresh tokens revoked" and print the `jwt_secret`
  rotation advice for an active compromise.

Verified: `node --check` on both files; `node scripts/admin-reset.js --help` renders the new
paragraph; `node scripts/check-syntax.js` → 51 files OK; `node scripts/test-admin-guards.js` →
26/26 pass.

The underlying revocability gap stays **OPEN** and is unchanged from §C3 and §H's carry-forward
list. Note for whoever closes it: `jwt_secret` rotation is currently the *only* immediate
kill-switch, and nothing in the panel or the CLI performs it.

---

### J2-7 — [Low] A disabled admin account is distinguishable from a non-existent one, skips the bcrypt timing equaliser, and is exempt from the lockout counter — **FIXED 2026-08-26 (see §J2 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J2-7).**

### J2-8 — [Info] Verified clean

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J2-8).**

### Correction to a §J1 handoff — **closed 2026-08-26**

*§J1 has since struck this line from its own handoff, and the resolution pass below acted on the
recommendation, so both halves are now settled. Kept for the record because the near-miss is the
useful part: a machine-read guard column and a hand-written handoff disagreed, and the handoff was
the one that would have removed a guard.*

§J1's handoff to this session says `requireAuth` in `lib/auth-middleware.js` is *"exported with zero
callers — dead code, worth deleting"*. **It has one caller:**

```
index.js:1940:  app.post('/api/auth/change-password', rateLimiter.middleware('auth'), requireAuth(authManager), …)
```

Deleting it would remove the only authentication check on the password-change endpoint. The
observation behind the handoff is still worth acting on, but the correct action is the opposite one:
`/api/auth/change-password` is a password-verifying, credential-mutating route that today runs on
the *non-admin* guard with no `ipFilter` and no step-up. Promote it to `freshAdmin` (or at minimum
`secureAdmin`) — and then `requireAuth` really does become dead and can go.

**Done 2026-08-26.** The route now runs `rateLimiter('stepup')` → `ipFilter('admin')` →
`requireAdmin`, and `requireAuth` is no longer imported by `index.js`. It is deliberately left
*exported* from `auth-middleware.js` rather than deleted: `requireAdmin` and `requireFreshAuth` are
built on it, so removing it is a refactor of the module, not a cleanup of a dead export.
`secureAdmin` and not `freshAdmin` — see the rationale at the route.

### Handoffs

- **J12** — three CPU-exhaustion levers found here are bucket-shaped, not auth-shaped, and the fix
  is a new bucket rather than a change to `auth.js`: `/api/admin/reauth` (2400/min × ~304 ms
  bcrypt), `/api/auth/change-password` (200/min × bcrypt), and `/api/auth/login/totp`'s recovery
  branch (up to 10 bcrypt compares per submission). All three run on the event loop that validates
  stratum shares.
- **J9** — `access.require_admin_totp` is read live and **fails open** on a settings read error
  ([index.js:783](../../web/07_mining_pool_public/back-end-pool/index.js#L783)). That is the right
  call for availability, but it means a DB read failure silently downgrades mandatory 2FA to
  optional with no log line. Whether a settings-read failure should be *loud* is J9's question.
- **J16** — the `isLocalRequest` register-captcha bypass is safe only because every pool `/api`
  location sets `X-Forwarded-For $proxy_add_x_forwarded_for`. Treat that line as security-relevant
  in the vhost review, not boilerplate.
- **J17** — J2-2 is the launch-sequence item. If the decision is "hold it by procedure", the
  procedure must state that the vhost is not enabled until the first admin exists; a note that the
  installer "registers over loopback" is not sufficient, because the race is winnable by anyone who
  can reach the port at all.

### Verification

All eight findings were written from reading first; the harness was then run to confirm or refute
each one, and nothing here rests on inference alone. The harness bound the real `AuthManager`,
`lib/totp.js` and `lib/sqlite-compat.js` to an in-memory database carrying the production `users` /
`admin_recovery_codes` / `admin_audit_log` schema, with `lib/db`'s `getDb` stubbed through
`require.cache`. It ran as a single `node` process that exits on its own — no server, no listener,
nothing left running (CLAUDE.md *Local Test Processes*). Probes, in order:

1. two concurrent `/api/auth/register` bodies replaying :1629 + :1648 → **both became admins** (J2-2)
2. access-token validity across `revokeUserTokens()` → **still valid, still step-up-fresh** (J2-6)
3. access-token validity across `changePassword()` → **still valid** (J2-6)
4. one TOTP code submitted three times → **accepted three times** (J2-5)
5. previous- and next-step codes → **both accepted** (`window = 1`) (J2-5)
6. ten failed `stepUp()` vs one failed `login()` → **0 lockout entries vs 1** (J2-1)
7. disabled vs unknown username → **different error strings, one lockout entry not two** (J2-7)
8. one `twofa_token` verified three times → **valid three times** (J2-3)

Plus two independent one-shots: `jwt.verify` against a forged `alg:none` token on the installed
jsonwebtoken 9.0.3, and `proxy-addr` with the compiled `loopback` trust list against three
`X-Forwarded-For` shapes. `bcryptjs` cost-12 compare timing was measured over five runs (304 ms
average) on this workstation, not on the VPS — the ratio to the 2400/min bucket is the point, not
the absolute number.

Findings above were written **before** any code was touched, and only J2-6's text was changed on
the day (plan rule 3). The operator authorised the rest on **2026-08-26** — see the resolution pass
below for what was applied, what was deliberately left, and what an operator will notice.

---

### §J2 — resolution pass, 2026-08-26 (add-ons, NOT VPS-TESTED)

Six of the eight findings are now fixed in code (J2-6's text half landed on the 25th). The
findings above are left worded **as found** — a heading that says FIXED points here; the body
still describes the bug, which is what makes the fix legible a year from now.

Everything below is covered by a new regression suite,
[`scripts/test-auth-hardening.js`](../../web/07_mining_pool_public/back-end-pool/scripts/test-auth-hardening.js)
— **42 assertions, all passing**, against a throwaway SQLite file in the OS temp dir. It exists
for the same reason `test-money-path.js` does: each case is a demonstrated bug on the path to the
money routes, and a comment does not fail a build. `check-syntax` 53 files OK;
`test-admin-guards` 26/26, `test-money-path` 30/30, `test-branding-sinks` 18/18 all still pass.

#### What was applied

**J2-1 — the step-up gate.** Three separate things were missing, and each is now in place.

- **A bucket of its own.** `POST /api/admin/reauth` and `POST /api/auth/change-password` moved
  off `admin` (2400/min) and `auth` (200/min) onto a new `stepup` bucket at **10/min per IP**
  ([lib/rate-limiter.js](../../web/07_mining_pool_public/back-end-pool/lib/rate-limiter.js)).
  This is the half that matters most, and not only for guessing: the bcrypt runs *before* any
  counter can see its result, so a lockout alone would never have stopped a session thief from
  burning 730 CPU-seconds per 60 s on the event loop that validates stratum shares. 2400/min →
  10/min takes the daily guess budget from 3.46 M to 14 400, a factor of 240.
- **The three-layer login policy.** `AuthManager.stepUp()` now takes `opts.ip`, checks
  `lockoutRemaining()` **before** the bcrypt (a locked source costs no CPU), records
  `_recordPairFailure()` on a wrong password, and clears the pair on success. The route adds
  `recordAdminLoginFailure()` for the per-IP auto-ban and answers **429** with
  `retry_after_seconds` when locked. An already-locked source deliberately does *not* spend
  auto-ban budget — it is being refused before the password is read, so counting it would let a
  lock ratchet itself into a longer ban on no new information. `changePassword()` takes `ip` and
  arms the same lock, and both its outcomes now write an audit row (`password_changed` /
  `password_change_failed`), where before it wrote none at all.
- **A second factor when the pool mandates one.** When `access.require_admin_totp` is on *and*
  the admin is enrolled, `stepUp` requires a TOTP or recovery code, verified through
  `verifyTotpOrRecovery` so the code is consumed and cannot be replayed. The code is asked for
  only where it is genuinely needed: demanding one from an *un-enrolled* admin would make
  step-up unsatisfiable and hard-lock the panel, which is the trap `freshAdminEnroll` exists to
  avoid. A password-only attempt is answered 401 `{ totp_code_required: true }` and — this
  matters — is **not** counted as a failed attempt, because a correct-password client that
  simply doesn't know the pool's policy yet must not be able to lock itself out.
  `public_html/js/stepup.js` handles the flow: password → if challenged, prompt for the code →
  re-post both. It also now *surfaces* failures, including the lockout and its countdown; it
  previously returned a silent `false`, which would have left an operator retyping a correct
  password into a window that had stopped accepting it.

**J2-2 — first-admin registration.** `registerAdmin(username, password, { firstAdminOnly: true })`
computes the bcrypt hash **first**, then does the admin-count check, the username check and the
`INSERT` inside one `db.transaction()`. The fix is the *ordering*, not the transaction: the race
existed only because a ~300 ms `await` sat between the check and the insert and yielded the event
loop, so with no await between them the decision completes in one tick of a single-threaded
process. The transaction is the belt to that braces, and keeps it true if a future caller adds an
await. index.js keeps its cheap pre-check so a closed pool answers without doing captcha or bcrypt
work — that line is now an optimisation, and is commented as *not* being the gate.

Option (b) from the finding — refusing `/api/auth/register` unless `isLocalRequest(req)` — was
**not** applied. (a) closes the hole outright and costs the operator nothing; (b) is an additional
deployment policy that also forbids registering from another machine, and that is the operator's
call to make, not a side effect of a security fix. It remains available and is noted at the
function.

**J2-3 — the 2FA budget follows the account.** `generate2faToken` now mints a `jti` and holds
`{ userId, fails, expires }` server-side. `verify2faToken` returns `{ userId, jti }` and refuses
any token whose `jti` is unknown, expired or burned — **including a validly-signed JWT that never
had server state**, which is what stops the old token shape being replayed. `record2faFailure`
destroys the token after 5 wrong codes (`twofa_max_attempts`); success calls `consume2faToken`, so
a token cannot be re-presented to mint a second session or buy a fresh budget. A password holder
who fans one token out to a thousand hosts now gets five guesses in total instead of twenty per
host, while an operator fumbling codes on one device is untouched — which was the false-positive
worry that set the per-IP threshold at 20 in the first place. Separately, `/api/admin/2fa/disable`
and `/api/admin/2fa/recovery/regenerate` now call `recordAdminLoginFailure(ip, '2fa')`, so all
three routes that verify a code feed one counter.

**J2-4 — captcha eviction.** `lib/captcha.js` keeps a `byIp` index and caps outstanding challenges
at **20 per source** (`maxPerIp`), evicting that source's own oldest first, so a flood is
self-inflicted. `GET /api/auth/captcha` passes `req.ip`. The global `max` survives as what it
should always have been — a memory backstop, not the brute-force control it was being asked to be.
`verify()` deliberately does **not** check the IP: a solved challenge must stay redeemable if the
client's address changes between the two requests (mobile handover, a Tor circuit rotating), which
would otherwise read to the operator as a captcha that is simply wrong. The stateless-HMAC
alternative was not taken — it removes the store entirely but loses single-use, and single-use is
the property worth keeping.

**J2-5 — TOTP replay.** New column `users.totp_last_counter` (added to the schema *and* to
`migrateUsers`, so existing installs pick it up on next start; `0` backfills safely because every
real counter is ~5.8 × 10⁷ and rising). `totp.verifyCounter()` returns the matched step instead of
a boolean, and `verifyTotpOrRecovery` refuses any counter `<= totp_last_counter`, stamping it on
success. `confirm2faEnrollment` stamps it too — the code typed to confirm enrollment is live for
another ~90 s and was just echoed through a form, so enrollment is where the guard has to start.
`window` stays ±1: clock drift is the false positive an operator actually meets, and single-use is
orthogonal to it, since the rule is "strictly newer", not "exactly now".

**J2-7 — disabled accounts.** `login()` now runs the password compare first and treats
`!passwordValid || !user.is_active` identically: same generic string, same bcrypt cost, same
`_recordPairFailure`. The cost is that an admin who disabled their own account gets no hint why —
deliberate, since the recovery path is the break-glass CLI (`admin-reset.js --unlock`, which also
sets `is_active = 1`) and not an error string that doubles as an account oracle for everyone else.

**§J1 handoff.** `/api/auth/change-password` is promoted to `requireAdmin` and `requireAuth` is no
longer imported by `index.js` — see the correction above for why it stays exported.

#### Deliberately not applied

- **J2-1 item 4 — raising the minimum admin password length above 8.** This is a policy knob the
  operator owns, and on a live pool it would be close to decorative: the only account that exists
  is the one already registered, and a length floor never re-checks a stored password. The number
  that actually moved is the budget — 14 400 guesses/day against an 8-character password is a
  different proposition from 3.46 M. If an operator wants a floor, it belongs in
  `registerAdmin`/`changePassword` as an explicit choice, with the knowledge that it cannot help
  an install that is already running.
- **§C3 — access tokens are unrevocable until they expire.** Unchanged and still open; it is a
  §C item, and J2-6 fixed only the two places that *described* it wrongly. Nothing in this pass
  narrows it: a stolen access token still survives logout, a password change and *Revoke
  sessions*. `jwt_secret` rotation plus a service restart remains the only immediate kill-switch,
  and both the panel and the break-glass CLI now say so.

#### Behaviour changes an operator will notice

1. **Step-up is 10/min per IP.** An operator clicking through a long payout run will not hit it
   (a step-up lasts 5 minutes), but an automated client that re-authenticates per request will.
2. **On a mandatory-2FA pool, step-up now asks for a code.** The bundled panel handles it. Any
   custom client or script that POSTs `/api/admin/reauth` must send `code` alongside `password`
   when the server answers `totp_code_required`.
3. **A TOTP code works once.** Typing the same code at two prompts inside one 30-second step now
   fails the second time — correct per RFC 6238 §5.2, and worth knowing before it is reported as
   a bug. Wait for the next code.
4. **`/api/auth/change-password` now requires an admin token and passes the admin IP filter.**
   No caller in the repo is affected (nothing in `public_html/` calls it, and every account in
   `users` is an admin), but a pool with an `admin_allowlist` set will now enforce it here too.
5. **Failed step-ups and password changes appear in the audit log** (`reauth_failed` gains a
   `details` payload; `password_changed` / `password_change_failed` are new actions) and count
   toward the per-IP auto-ban, so an operator fumbling their password several times can now
   temp-ban their own address for an hour. That is the same exposure the login route has always
   had, and the pair key means it never locks out anyone else.

#### Self-review of this pass, same day — three things the fixes did to each other

Written after the code was in, because a pass that audits its own fixes with tests it also wrote
is self-confirming by construction. Re-reading the diff against the *clients* rather than the
tests turned up three interactions, two of which are the fixes colliding with one another.

1. **J2-1 × J2-5 — the double-code sequence.** On a mandatory-2FA pool, `disable2fa()` /
   `regen2faRecovery()` in `admin-panel/settings-common.js` put a code in the request body; the
   route is `freshAdmin`, so `adminFetch` gets a 403, and step-up now asks for a code too. The
   operator reads the *same* code off their authenticator — it is still on screen. Step-up
   consumes it (J2-5), and the retry replays it, so a code that worked one second earlier comes
   back as *"Incorrect 2FA / recovery code"* on, of all screens, **disable 2FA**. It
   self-corrects on the next attempt, but "incorrect code" for a correct code is how an operator
   concludes 2FA is broken and reaches for the break-glass CLI. Fixed by making the rejection
   honest rather than the guard weaker: `verifyTotpOrRecovery` takes an optional `detail`
   out-param that reports `replay: true` for a genuine-but-spent code, and the three routes that
   are already past the gate say *"That code has already been used. Wait for your authenticator
   to show the next one."* The client clears the code box on that flag so the natural next action
   is a fresh code. **Deliberately not surfaced at `/api/auth/login/totp`** — distinguishing
   "spent" from "wrong" there would confirm to a phisher that a harvested code was genuine, which
   is the exact attacker J2-5 exists for. The out-param shape matters: returning an object
   instead of a boolean would have made every existing `if (!ok)` truthy and silently opened the
   gate.
2. **J2-2 × the installer.** The atomic gate throws `Admin registration closed.` from inside
   `registerAdmin`, and the route was answering **400**. Script 07's installer branches on the
   status code — 403 prints *"an admin already exists"*, 400 prints *"username ≥ 3, password ≥
   8"* — so a race-loser would have been told to fix a password that was never the problem. The
   route now maps that error back to 403, matching the pre-check it sits behind.
3. **J2-3 × clock drift, accepted not fixed.** A wrong *server* clock rejects every code, and the
   token budget now ends that run after 5 instead of 20 — so the operator re-enters password and
   captcha three more times before reaching the same per-IP ban. More friction, but the
   "please log in again" message is a clearer signal that something is wrong than twenty silent
   rejections, and the per-IP threshold of 20 is untouched. Noted because memory
   `project_pool_admin_login_security` names clock drift as the main false-positive source.

Also checked and clear: `public_html/js/stepup.js` is the single copy the admin panel loads
(`/js/stepup.js`, no second file to drift); `/api/auth/change-password` has no client anywhere,
so promoting its guard breaks nothing; `sqlite-compat`'s `transaction()` rolls back **and**
rethrows, which is what `registerAdmin`'s error path depends on.

#### Handoffs unchanged by this pass

J12 still owns the remaining bcrypt CPU lever on `/api/auth/login/totp`'s recovery branch (up to
10 cost-12 compares per submission, on the `auth` bucket at 200/min — the `stepup` bucket does not
cover it). J9, J16 and J17 are as written above; J17's launch-sequence item is now closed in code
rather than by procedure, so the procedure no longer has to carry it.

---

## §J3 — Ownership gate & account API (2026-08-26, add-ons, NOT VPS-TESTED)

Third session of the pre-mainnet §J pass (see the Status roll-up at the top of this file).
Scope: [`lib/owner-proof.js`](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js) (486)
and the `/api/account/:addr/*` block in
[`index.js`](../../web/07_mining_pool_public/back-end-pool/index.js) (2832–3798 — thirteen routes,
four of which move money). Question asked: **can miner A act on miner B's balance, and can an
address be spelled two ways?**

Read first, then confirmed by execution: a one-shot harness bound the real `owner-proof.js` to an
in-memory `node:sqlite` DB carrying the production `miner_accounts` / `pool_config` columns and
replayed the capture-and-verify cycle. Its output is quoted per finding. No server started, no
VPS touched (plan rule 5); the harness lived in the scratchpad and its probe list is in
*Verification* below.

**Headline.** The second question has a clean answer — there is exactly one spelling, and it holds
at every call site (see *Verified correct*). The first does not. The gate's own threat model says
it exists so that *"a stranger reading the public leaderboard cannot trigger payouts for other
people's addresses"* ([owner-proof.js:20–22](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L20)).
Five separate findings below let a stranger do exactly that, or worse. Nothing found here takes
funds from a **default-configured** pool — the one theft path (J3-1) needs the Goblin rail
switched on, which is off by default (`nostr_payouts_enabled: 'false'`,
[lib/pool-settings.js:186](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L186)) —
so no Critical is recorded. But J3-3 and J3-5 both work out of the box.

### Threat actors used in this section

| Label | Means |
|---|---|
| **Anonymous** | Internet, no credentials, no hardware. Reaches nginx → `/api/account/*`, and the public stratum port at `:3333` |
| **Rig holder** | Anonymous, *plus* any Grin miner able to produce one share at the node's `minimum_share_difficulty` — i.e. every current customer of every Grin pool, and anyone who rents a rig for a minute |
| **Registered miner** | A rig holder who already mines here, attacking another miner |
| **On-box root** | Shell on the pool server — Info only, per plan rule 7 |

The distinction that matters is **Anonymous vs Rig holder**, and it is much narrower than it
looks. The pool's entire user population is rig holders; the gate is meant to protect them *from
each other*, so "requires a miner" is not a meaningful barrier here the way "requires an admin
session" is in §J1/§J2.

---

### J3-1 — [High] One accepted share writes BOTH ownership-proof legs, so the AND-gate protecting the payout *destination* is one factor, not two — **FIXED 2026-08-26 (see §J3 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J3-1).**

### J3-2 — [High] `password_proof.live.distinct` on the public account summary is an unthrottled online oracle for the rig-password leg — **FIXED 2026-08-26 (see §J3 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J3-2).**

### J3-3 — [High] The per-address failed-proof lockout is a weapon: ~9 requests per 10 minutes from one IP permanently denies a miner access to their own balance — **FIXED 2026-08-26 (see §J3 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J3-3).**

### J3-4 — [Medium] Two accepted shares evict both slots of a victim's last-2 proof window, and a miner who has stopped mining can never restore it — **FIXED 2026-08-26 (see §J3 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J3-4).**

### J3-5 — [High] `donate100` on an unauthenticated stratum login diverts up to 100% of another miner's future earnings, and the account API never shows it — **FIXED 2026-08-26 (see §J3 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J3-5).**

### J3-6 — [Low] The failed-proof throttle Map has no expiry sweeper and no size cap — **FIXED 2026-08-26 (see §J3 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J3-6).**

### J3-7 — [Low] `?direction=` resolves through `Object.prototype`, splicing a native function's source into the ledger `WHERE` clause — **FIXED 2026-08-26 (see §J3 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J3-7).**

### J3-8 — [Low] The two CSV routes put an unvalidated `:addr` into a response header and skip the account-existence check their siblings have — **FIXED 2026-08-26 (see §J3 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J3-8).**

### J3-9 — [Info] §H3's `tor-check` fix re-verified: no exploitable timing oracle remains

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J3-9).**

### Verified correct (checked with evidence, not assumed)

- **One spelling, and it holds everywhere — the session's second question is clean.** Stratum
  login is the only path that creates a mining account, and its regex is lowercase-only with no
  `i` flag and an exact 58-symbol bech32 body
  ([stratum-protocol.js:63–65](../../web/07_mining_pool_public/back-end-pool/lib/stratum-protocol.js#L63)).
  `miner_accounts.grin_address` is `TEXT NOT NULL UNIQUE` with SQLite's default **BINARY**
  collation ([db.js:286–288](../../web/07_mining_pool_public/back-end-pool/lib/db.js#L286)), and
  `grep -n "grin_address LIKE"` over `index.js` + `lib/` returns exactly one hit — the admin miner
  search at [index.js:5896](../../web/07_mining_pool_public/back-end-pool/index.js#L5896) — so no
  money path uses case-insensitive matching. Consequence: an alternative spelling (uppercase
  bech32, `%67rin1…`, a trailing space) cannot match any row, and therefore 404s rather than
  forking an identity. The gate ([owner-proof.js:334](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L334)),
  the balance read ([index.js:2966](../../web/07_mining_pool_public/back-end-pool/index.js#L2966)),
  the withdrawal write
  ([withdrawal-scheduler.js:637](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L637))
  and the audit row ([owner-proof.js:424](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L424))
  all bind the *same* `req.params.addr` string. The other account-creating call sites are
  unreachable with attacker-chosen casing: `awardPrize` validates lowercase-only
  ([index.js:6039](../../web/07_mining_pool_public/back-end-pool/index.js#L6039)), and
  `prize_pool` / `pool_fee` ([incentives.js:13–15](../../web/07_mining_pool_public/back-end-pool/lib/incentives.js#L13))
  are not bech32-shaped, so no one can mine to them, capture a proof on them, or withdraw them
  (`verifyOwnerProof` → `no_recorded_proof`).
- **The one-pending rule and the reversal cooldown cannot be raced.** All three create paths run
  `_assertNoRecentReversal` and then the pending count + CAS balance lock with **no `await`
  between them**, inside one synchronous `db.transaction` — Tor
  ([:635 → :659–705](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L635)),
  slatepack ([:728 → :749–779](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L728)),
  nostr ([:883 → :899–931](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L883)).
  Node's run-to-completion plus better-sqlite3's synchronous API means two concurrent HTTP requests
  cannot interleave inside that region. Both `await`s that do exist on the nostr route
  (`resolveDestination`, [index.js:3714](../../web/07_mining_pool_public/back-end-pool/index.js#L3714))
  sit *before* the transaction, so a doubled request is caught by the `userPending >= 1` check.
  The shared `PENDING_SQL` constant ([:16](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L16))
  is used by every one of them — the §E.2 drift cannot recur by copy-paste.
- **The gate is on every money route, and the tiers are ordered correctly.** The four money-writes
  under `/api/account/` are `withdraw` ([:3651](../../web/07_mining_pool_public/back-end-pool/index.js#L3651)),
  `withdraw/:id/finalize` ([:3736](../../web/07_mining_pool_public/back-end-pool/index.js#L3736)),
  and `nostr-destination` POST ([:3814](../../web/07_mining_pool_public/back-end-pool/index.js#L3814))
  / DELETE ([:3894](../../web/07_mining_pool_public/back-end-pool/index.js#L3894)); all four call
  `verifyOwnerProof` (or `requireBothProofs`) as the **first** thing after reading `req.ip`, all
  four ride the dedicated `withdraw` bucket, and every failure is audited. Register is
  AND-gated and remove is OR-gated, which is the right way round (removal cannot redirect money).
  The J1 handoff's claim is confirmed independently.
- **Ordering on the Tor rail is right.** The pre-flight probe — the expensive, amplifiable part —
  runs *after* the proof, not before
  ([index.js:3656 vs :3670](../../web/07_mining_pool_public/back-end-pool/index.js#L3656)).
- **Finalize cannot be aimed at another address.** `finalizeSlatepackWithdrawal` re-reads the row
  and rejects a mismatch with 403 before any wallet call
  ([withdrawal-scheduler.js:823](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L823)),
  so a valid proof for address A cannot finalize B's payout even with B's withdrawal id.
- **The password compare is constant-time**, on the scrypt output rather than the input —
  `crypto.timingSafeEqual(dk, expected)` with a length pre-check
  ([owner-proof.js:202–205](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L202)).
  The IP compare goes through the same function for hashed values
  ([:212–216](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L212)).
- **Enumeration is a non-issue on this block.** `POST …/withdraw` on an unknown address returns
  `403 {reason:"account_not_found"}` and a known one returns `no_match` — a real distinction, but
  it reveals nothing `GET /api/account/:addr` does not already answer to anyone, by design
  (address-as-identity, the account page has no login). No finding.
- **The free-reject path is correctly free.** A submitted value that is neither an IP nor a usable
  password returns its reason **without** counting toward the lockout
  ([:360–366](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L360)); the harness
  confirmed 50 such probes leave the address unlocked. Given J3-3, this is the *right* call and
  should not be "hardened" — counting them would hand an attacker a cheaper lockout lever than the
  one they already have.
- **`getPasswordConsistency` returns no password material** — counts only, `usable.size` never the
  set ([miners.js:217](../../web/07_mining_pool_public/back-end-pool/lib/miners.js#L217)). The leak
  in J3-2 is differential, not direct; the fix must not be mistaken for redaction.

---

### Handoffs

- **§J4** — `_assertNoRecentReversal` computes `cooldown = mins * 60` and then `if (!cooldown) return;`
  ([withdrawal-scheduler.js:184–187](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L184)).
  `0` disabling it is documented and intended; **`NaN` disabling it silently is not** — any
  non-numeric `payout.withdrawal_cooldown_minutes` reaching `config` turns the cross-rail cooldown
  off with no log line. Same family as memory `project_config_loader_type_traps`. Whether the
  validator can ever emit a non-number is §J9's; the consumer is §J4's file.
- **§J6** — owns the stratum-side halves of **J3-1** (evidence capture trusts an unauthenticated
  address), **J3-4** (two writes evict the last-2 window) and **J3-5** (`setDonation` at login,
  above the comment that forbids exactly that). J3-5 part 1 is the smallest and highest-value of
  the three.
- **§J9** — `access.extra_banned_passwords` is cached for 60 s in-process
  ([owner-proof.js:130–148](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L130))
  and fails open to the hardcoded seed on a corrupt/missing row. Both are documented and both look
  right; the settings-side question — can a write leave that key in a shape that parses as an
  empty array — is J9's.
- **§J11** — `GET /api/account/:addr` publishes `password_proof.state`, `has_recorded_ip`,
  `has_recorded_pass` and `password_proof.live` unauthenticated. J3-2 covers the `live.distinct`
  oracle; the broader privacy question — that the account page is address-addressable with no
  login, so anyone with a leaderboard entry can read another person's balance, pending payout and
  rig count — is J11's to rate against memory `project_pool_ip_privacy`.
- **§J12** — two levers found here are bucket-shaped, not gate-shaped. (1) The Tor pre-flight probe
  runs before the pending/cooldown checks, so a miner holding one valid proof can force 20 fresh
  Tor circuit builds per minute
  ([index.js:3670](../../web/07_mining_pool_public/back-end-pool/index.js#L3670)) even while every
  withdrawal they request would 429. (2) Every failed proof writes an `admin_audit_log` row
  ([owner-proof.js:422](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L422))
  *including* the ones rejected by the lockout at :326 — so a locked-out attacker still grows the
  table at the bucket rate for the full 180-day retention.
- **§J15** — the account page is the only surface a miner has for J3-5's `donation_percent` and for
  a "your proof was evicted" (J3-4) explanation. Once part 2 of the J3-5 fix lands, the field needs
  somewhere to render.

---

### Verification

All nine findings were written from reading first; the harness was then run to confirm or refute
each one, and nothing above rests on inference alone. The harness bound the **real**
`lib/owner-proof.js` to an in-memory `node:sqlite` database carrying the production
`miner_accounts` columns (`last_ip`, `prev_ip`, `last_pass_hash`, `prev_pass_hash`,
`pass_proof_state`) plus `pool_config`, and drove `recordOwnerEvidence` / `verifyOwnerProof` with
the same arguments `stratum-server.js:601` and the four money routes pass. It ran as a single
`node` process that exits on its own — no server, no listener, nothing left running (CLAUDE.md
*Local Test Processes*). Probes, in order:

1. victim capture → both legs verify (`method:'ip'`, `method:'password'`) — baseline
2. one attacker `recordOwnerEvidence` under the victim's address → **both legs verify for the
   attacker**, so `requireBothProofs` would pass (J3-1)
3. victim still verifies after one attacker session — confirms the last-2 window (J3-4 bound)
4. second attacker session → **victim's IP and password both return `no_match`** (J3-4)
5. eight wrong guesses from eight distinct source IPs → **the owner's correct password returns
   `too_many_attempts`**, `isLockedOut(addr) === true` (J3-3)
6. fifty unusable-shaped guesses → address **not** locked, confirming the free-reject path
7. the two-key direction map indexed by `constructor` / `toString` / `hasOwnProperty` → each
   returns a native function whose source is spliced into the `WHERE` clause (J3-7)

Plus one independent one-shot against Node 24's `ServerResponse.setHeader`: CRLF in a
`Content-Disposition` value throws `ERR_INVALID_CHAR`, a `"` is accepted and breaks the quoting
(J3-8). Rate figures quoted in J3-2 and J3-3 are derived from the configured limits
(`max_connections_per_ip = 320`, `public = 1200/min`, `withdraw = 20/min`, `FAIL_MAX = 8`,
`FAIL_MAX_IP = 20`), not measured against a running pool.

**No code was changed in this session.** Every fix above is written up and left for a decision:
J3-1, J3-4 and J3-5 are structural and cross into §J6's files, J3-2 and J3-3 change behaviour an
operator would notice, and J3-6/7/8 are small but belong with the pass that applies the rest.

---

### §J3 — resolution pass, 2026-08-26 (same day, add-ons, NOT VPS-TESTED)

> **Superseded storage, 2026-09-22.** The `last`/`prev` slots, the rotation and the "last-2 window
> doing the job it was built for" below describe the store as it was on 2026-08-26. It is now a set
> of up to 10 per kind with a per-address salt — **`script07_design.md` §17**. What this pass
> established still holds: the anchor (J3-4), AND + AGE on a destination change (J3-1; `slot` is
> now `set` | `anchor`, and `anchor` means an EVICTED anchor), and the pair-keyed lockout (J3-3).
> The two-slot eviction arithmetic in J3-4 no longer applies. Text below left as written.

The operator authorised fixing **all eight** open findings (J3-9 was Info / no action). Everything
below is applied on `add-ons` and covered by a new suite,
[`scripts/test-owner-gate.js`](../../web/07_mining_pool_public/back-end-pool/scripts/test-owner-gate.js)
(19 checks), wired into `npm run test:unit`. The full suite runs **123 checks across six files
(12 + 18 + 30 + 26 + 18 + 19), all passing**. Still NOT VPS-tested.

Findings J3-1, J3-3 and J3-4 shared one root cause, so they got one mechanism rather than three
patches. Stating it once, because the individual diffs do not show it:

> **Proof of work is a cost, not an identity.** Anyone may mine to anyone's address. The design
> already knew capture must cost PoW — that is why §D.2 moved it off `handleLogin` — but it then
> treated "arrived with a share" as "is the owner". Every §J3 money finding is that one
> substitution. What actually separates the owner from a stranger who mined here for ten seconds
> is **age**: the owner's evidence has been on record since they started. So the gate now reports
> *which slot matched and how old it is*, and each caller decides what it needs.

#### What was applied

**J3-1 — the destination AND-gate is now an AND + AGE gate.**
`verifyOwnerProof` returns `slot` (`last` | `prev` | `anchor`) and `age_seconds` alongside
`method`; four new columns (`last_ip_at`, `prev_ip_at`, `last_pass_at`, `prev_pass_at`) carry a
capture time that **travels with the value on rotation**, so `prev`'s timestamp always describes
what is actually in `prev`. `requireBothProofs`
([index.js:3769+](../../web/07_mining_pool_public/back-end-pool/index.js#L3769)) now refuses any
leg younger than `nostr_destination_cooldown_hours` (409 `proof_too_recent`) and any leg that
matched the anchor (409 `anchor_not_accepted_here`), with error copy that explains the refusal
rather than reading as a failed password.

The reason this does not lock out honest miners is the last-2 window doing the job it was built
for: a miner whose IP changed yesterday still has their **previous** IP on record with its own
older timestamp, and submitting that one passes. Verified in the suite — after an attacker's
injection rotates the owner to `prev`, the owner's aged proof still clears the gate.

An unknown age (`age_seconds === null`, a row written before these columns existed) is treated as
**old, not fresh**. Failing those closed would have locked every pre-upgrade miner out of the
Goblin rail to defend against an attack that had to be mounted *after* the upgrade.

**J3-4 — a write-once anchor, plus a work cost on displacement.**
Three more columns (`anchor_ip`, `anchor_pass_hash`, `anchor_set_at`) hold the address's
first-ever proof of each kind. It is never rotated, so the reported failure scenario — a miner who
stopped mining, whose two window slots were then evicted, permanently unable to reach their own
balance — is closed outright. The anchor is accepted by `verifyOwnerProof` (withdraw to your own
wallet) and refused by `requireBothProofs` (change where money goes). That asymmetry is the whole
point: an unrevocable credential is the right thing to hold a recovery path open and the wrong
thing to authorise a redirection.

Pre-existing accounts are seeded by `backfillProofAnchors(db)`, called at
[index.js:589](../../web/07_mining_pool_public/back-end-pool/index.js#L589). It is **synchronous
and ahead of the stratum listener on purpose**: an account that reached its first post-upgrade
capture anchorless would have anchored to whoever mined that share, which is the attacker in the
scenario being fixed. `anchor_set_at` is backdated to the slot's own capture time (or
`created_at`), so a backfilled anchor is never mistaken for freshly written.

Separately, displacement now costs sustained work. `recordOwnerEvidence` takes
`{ mayDisplace }`; `stratum-server.js` passes `false` on the session's first accepted share and
`true` only at `PROOF_MIN_SHARES` (4). **It gates rotation only, never first capture** — gating
first capture would strand a rig that reconnects too often to ever reach the threshold, which
would be a new lockout bug in the fix for a lockout bug.

**J3-3 — denial is keyed to the (address, origin) pair.**
The lockout key is now `` `${addr}|${ip}` ``; the bare-address counter is kept but **can no longer
refuse anything** (`_registerFail(addr, 0)` — a max of 0 means "count, never lock"). Over
`ADDR_ALERT_MAX` it puts the address into "under attack" mode, which costs every attempt a 2 s
delay and is exposed as `underAttack()` for an AlertMonitor rule.

**The trade is real and is recorded in the code**, not just here: an attacker with N source IPs
now gets 8 guesses per IP against one address instead of 8 in total. The per-IP cap of 20 per 10
min still bounds each origin, so a dictionary run needs roughly one fresh IP per 20 guesses — a
genuine botnet — and with J3-1 applied what it buys is griefing, not theft. Certain harm to every
miner (54 requests/hour freezing anyone's balance indefinitely) was the worse side of that trade.
The delay is capped at 64 concurrent waits and **fails open to "no delay"** rather than to a
refusal, because a refusal is exactly the behaviour being removed.

**J3-2 — the password oracle needs PoW.**
Rather than dropping `distinct` (which the account page genuinely uses to tell a miner their rigs
disagree), `getPasswordConsistency` now counts **only sessions with `shareCount > 0`**
([lib/miners.js:201+](../../web/07_mining_pool_public/back-end-pool/lib/miners.js#L201)). A bare
login no longer perturbs the count, so the free path — connect with a candidate, read the number
back — is gone, and the diagnostic is unchanged for real rigs. Residual: an attacker willing to
mine an accepted share *per guess* still has an oracle. That is no longer worth doing, because at
that cost they would inject their own password instead (J3-1), and J3-1 now stops an injected
proof from redirecting anything.

**J3-5 — the donation tag now costs PoW, and the miner can see it.**
`setDonation` moved out of `handleLogin` and onto the first accepted share; the parsed percentage
is parked on the session (`session.donationPercent`) in between. `GET /api/account/:addr` returns
`donation_percent`, and `account-settings.html` shows a **"Donating to prize pool"** row (hidden at
0%) whose tooltip says how to stop it. A number the pool acts on to reduce someone's earnings has
to be readable by that someone.

**J3-6 — `_fails` is swept and bounded.** `_sweepFails()` runs opportunistically on write (at most
once a minute, or immediately over the ceiling) and drops entries that are both out-of-window and
unlocked; over `FAILS_MAX_KEYS` (20 000) it evicts oldest-first but **never an entry that is
currently locked out**, since that would make eviction the throttle bypass. Deliberately not a
`setInterval`: this module is required by one-shot scripts and test harnesses, and a module-level
timer would keep those processes alive.

**J3-7 — `Object.hasOwn`.** One line at
[index.js:3432](../../web/07_mining_pool_public/back-end-pool/index.js#L3432).

**J3-8 — one shape check for the whole family.** A single mounted middleware at the top of
`setupRoutes` validates the first path segment under `/api/account` against
`/^t?grin1[ac-hj-np-z02-9]{58}$/` and 404s anything else — the same 404 an unknown-but-well-formed
address already returns, so it adds no new signal. Two deliberate choices: it is mounted on the
**path**, not declared with `app.param('addr', …)`, because the admin panel uses `:addr` too and
legitimately addresses the non-bech32 `prize_pool` / `pool_fee` pseudo-accounts; and it reads the
segment from `req.path` and decodes it itself rather than trusting `req.params`, because Express
rebuilds params per layer and a check written against `req.params` in a mounted middleware can
inspect something other than what the handler later receives (memory `project_comms_hub_09`).

#### Also updated

- `API_DOC_META` rows for `GET /api/account/:addr` and `POST …/nostr-destination` — per memory
  `project_pool_api_docs`, the per-row notes are hand-kept and must ship with the route change.
  The new 409 reasons are named there.
- `account-settings.html`: the donation row, an **"Evidence changed"** warning in the
  password-proof diagnostics when the recorded IP/password changed within 7 days (with different
  advice depending on whether the anchor survived), and the demo dataset extended so the preview
  still renders.

#### Deliberately not applied

- **No change to what a passed gate can do on the Tor and slatepack rails.** Those remain
  theft-proof by construction, so the gate stays anti-griefing there and an injected proof can
  still force a payout **to the address's own wallet**. That was the accepted residual in §E and
  it is still the right call.
- **The anchor is never rotated, even by a successful verify.** Advancing it on a verify would let
  an attacker holding an injected proof re-anchor to their own value — destroying the very
  recovery path the anchor exists to provide. The cost is that a leaked first-ever rig password
  stays a valid *withdrawal* proof forever; that is bounded by pay-to-self, and it is why the
  anchor is refused by the destination gate.
- **No CAPTCHA.** §F's decision stands and was not revisited.

#### Behaviour changes an operator will notice

1. A miner who has mined here for less than `nostr_destination_cooldown_hours` (default 48) cannot
   register a Goblin payout destination yet. The 409 explains why.
2. A miner whose rig IP or password changed within that window must use their **previous** one to
   change a destination — withdrawals are unaffected.
3. Malformed addresses under `/api/account/` now 404 instead of returning empty data or a CSV.
4. `password_proof.live` counts only rigs that have submitted an accepted share, so a rig that has
   just connected no longer appears in the consistency hint until it mines.
5. A donation set by a `donateN` tag is now visible on the account page.
6. `POST /api/admin/dormancy/verify-owner` passes no client IP, so it is no longer covered by
   any lockout (it previously inherited the address one) and its failures no longer feed the
   under-attack signal. Deliberate: it is `secureAdmin`-gated, and an operator checking a proof
   from a support e-mail must not be able to slow down the miner they are helping.
7. Repeated failed proofs against one address no longer lock its owner out; they slow every
   attempt on that address by 2 s while the burst lasts.

#### Verification

`npm test` — `check-syntax` plus six unit files, **123 checks, 0 failures**. The new
`test-owner-gate.js` asserts each finding's fix *and* its non-regression counterpart, so a future
change that re-opens one fails a named test:

```
ok  J3-1 owner with month-old evidence passes the destination gate
ok  J3-1 freshly injected proof is REFUSED by the destination gate
ok  J3-1 rotation carries the timestamp, so the owner is not collaterally blocked
ok  J3-4 first capture writes the write-once anchor
ok  J3-4 both window slots evicted, anchor still proves ownership
ok  J3-4 anchor is refused by the destination gate (unrevocable != authoritative)
ok  J3-4 mayDisplace=false leaves an established window untouched
ok  J3-4 first capture on an empty window is not gated
ok  J3-3 strangers failing on an address no longer deny the owner
ok  J3-3 brute force is still bounded, per (address, origin) pair
ok  J3-6 sweep runs, keeps in-window entries and never evicts a live lock
ok  J3-7 prototype keys are rejected by the direction guard
ok  J3-8 only one address spelling reaches the account routes
ok  J3-5 donation tag is applied only after node-accepted PoW
```

The suite replicates the age gate from `requireBothProofs` locally rather than standing up
Express — **that replica must be kept in step with the real function**, and the test says so at
the definition. The J3-5 check is a source assertion (`setDonation` must not appear in
`handleLogin`, must appear in `handleSubmit`) because instantiating a stratum server is not a
one-shot; it is a genuine regression guard for the specific mistake, not a proof of the runtime
path. `account-settings.html`'s inline script was extracted and `node --check`ed.

**Not tested on a VPS, and two things need it.** The `PROOF_MIN_SHARES = 4` threshold is a guess
about how quickly a real rig produces accepted shares at the node's `minimum_share_difficulty` —
if a small miner takes minutes to reach it, a legitimate IP change takes minutes to register (the
old proof keeps working throughout, so nothing breaks, but it should be measured). And
`backfillProofAnchors` has only been exercised against an empty and a small in-memory table;
on a populated pool DB it should be confirmed to run once, log its count, and be a no-op on the
next boot.

#### Self-review of this resolution pass (same day)

The fixes were re-read after they were written and the suite was green. That found **three
defects in the fixes themselves**, two of which made a control look effective while doing
nothing. All three are corrected above and now have their own tests; recorded here because the
first two are the kind of thing a passing test suite actively conceals.

**1 - [High] Both work-cost guards read an address-wide counter, so an attacker was credited
with the victim's mining.** `MinerManager.recordShare()` increments `shareCount` on **every live
session sharing the address**, not the one that submitted:

```js
recordShare(grinAddress, difficulty) {
  for (const [, session] of this.activeSessions) {
    if (session.grinAddress === grinAddress) { session.shareCount++; ... }
```
- [lib/miners.js:164](../../web/07_mining_pool_public/back-end-pool/lib/miners.js#L164)

J3-2's "only count sessions that have mined" and J3-4's `PROOF_MIN_SHARES` both keyed on that
field. So an attacker who merely opened a session under the victim's address and *waited* had
`shareCount` climb on the victim's own shares - reaching the J3-2 threshold instantly and the
J3-4 threshold within seconds. **Both fixes were inert against the exact attacker they were
written for**, and every test still passed, because the tests drove `recordOwnerEvidence` and
`getPasswordConsistency` directly and never exercised the counter that feeds them.

Fixed with `session.acceptedShares`, incremented only by the submit handler that owns the socket
([lib/stratum-server.js:605](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L605)).
`shareCount` keeps its fan-out semantics for the per-address stats that rely on it. Both fields
now carry comments saying which question each answers, since the difference is invisible at the
call site - which is how this happened.

**2 - [Medium] Setting `nostr_destination_cooldown_hours` to 0 switched the J3-1 age gate off.**
The age requirement borrowed the cooldown's number, and `0` is a legitimate value for that dial
("don't make me wait after registering") - so an operator turning the cooldown down would have
silently restored the hole, with no indication the two were connected. The age gate now has its
own floor (`MIN_PROOF_AGE_SEC = 3600`) that the operator dial can raise but not remove. One hour
breaks "mine for ten seconds, then redirect" while staying invisible to anyone who has actually
been mining here.

**3 - [Low] The new `donation_percent` field could 500 the account page, and could cry wolf.**
It reads `pool_config`, and the account summary is the miner's money UI - a settings hiccup must
degrade one advisory row, not the page; it is now individually try/caught. It also reported a
stored percentage on pools where donations are switched off, where nothing is actually being
taken; it is now gated on `donationsActive()`, which mirrors the two flags `applyToDistribution`
checks.

**Also added under review:** an Express test that actually starts the app, hits the mounted
`/api/account` shape check and confirms both that it rejects malformed input **and** that valid
addresses still reach their handlers - the mount could have silently 404'd every account route
or silently not run, and neither is visible by reading. The listener is closed in a `finally`.
Plus a test that `backfillProofAnchors` seeds a pre-upgrade row from the proof it already holds,
backdates `anchor_set_at` to `created_at`, and no-ops on a second run.

#### Handoffs unchanged by this pass

§J4 (`NaN` cooldown), §J9, §J11 and §J12 as written above. **§J6 changes**: the stratum-side halves
of J3-1, J3-4 and J3-5 are applied here, so J6 no longer inherits them — but it should re-read
`handleLogin` for any *other* write that happens before proof of work, since the donation tag was
found sitting ten lines above a comment forbidding exactly that. §J15 should confirm the two new
account-page surfaces read well alongside the rest of the gate block.

---

---

## §J4 — Payout execution (2026-08-26, add-ons, NOT VPS-TESTED)

Fourth session of the pre-mainnet §J pass (see the Status roll-up at the top of this file).
Scope: [`lib/withdrawal-scheduler.js`](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js)
(1512), [`lib/wallet.js`](../../web/07_mining_pool_public/back-end-pool/lib/wallet.js) (290),
[`lib/wallet-tor.js`](../../web/07_mining_pool_public/back-end-pool/lib/wallet-tor.js) (287),
[`lib/nostr-payout.js`](../../web/07_mining_pool_public/back-end-pool/lib/nostr-payout.js) (509),
[`lib/dormancy.js`](../../web/07_mining_pool_public/back-end-pool/lib/dormancy.js) (551), plus the
payout routes in [`index.js`](../../web/07_mining_pool_public/back-end-pool/index.js) the plan
names explicitly (admin retry/cancel, freeze/resume, dormancy manual/send-payout, the miner
withdraw + finalize routes). Question asked: **can one balance be paid twice, or a lock leak, or a
send land without being recorded?**

Read first, then confirmed by execution: a one-shot harness bound the **real**
`WithdrawalScheduler` to an in-memory `node:sqlite` DB carrying the production `withdrawals` /
`miner_accounts` / `balance_log` / `withdrawal_events` / `payout_control` columns, with only
`db`, `incentives` and `wallet-tor` stubbed in the require cache. Nineteen assertions, quoted per
finding. No server started, no VPS touched (plan rule 5); the harness lived in the scratchpad.

**Headline — the answer to the third clause is yes, and it is worse than the first.** §H closed two
ways to pay a miner twice. This session found the mirror image: **three ways to record a payout the
chain never carried**, all of them reachable without an attacker. The sharpest, J4-1, is not a rare
crash path — it is the *designed* handling of a `post_tx` failure, and it silently confiscates the
miner's whole payout. Two of the three land specifically on the recovery machinery §H2 added, which
was verified against a stub wallet and so validated its branch logic without ever testing its
premise about what grin-wallet's tx log means.

**The premise, stated once because two findings turn on it.** `TxLogEntry.tx_type === 'TxSent'`
does **not** mean a transaction was broadcast. grin-wallet writes that entry at `tx_lock_outputs`,
i.e. when the outputs are reserved — long before `finalize_tx`, and whether or not `post_tx` ever
runs. Three independent confirmations, all inside this repo:

1. The pool itself calls `initSendTx` then `txLockOutputs` at payout **creation**, before the miner
   has seen the slate ([withdrawal-scheduler.js:802–788](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L802),
   [:952–954](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L952)).
2. `processSlatepackExpiry` calls `wallet.cancelTx(w.slate_id)` on rows that were **never**
   finalized ([:1110](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L1110)).
   You can only cancel a tx the wallet already holds — so the log entry demonstrably exists
   pre-broadcast, by the code's own admission.
3. The pool's other reader of the same log already knows it:
   [`reconciliation.js:278`](../../web/07_mining_pool_public/back-end-pool/lib/reconciliation.js#L278)
   filters `if (!e || e.tx_type !== 'TxSent' || !e.confirmed) continue;` — **`.confirmed` is the
   discriminator**, and the two payout-critical readers drop it.
4. Two *other* products in this repo already encode the same meaning, independently. Fidelius's
   stuck-transaction endpoint selects exactly `TxSent && !confirmed && !confirmation_ts &&
   !kernel_excess && !kernel_lookup_min_height` and calls the result **unfinalized**
   ([051_fidelius/server.js:1524–1526](../../web/051_fidelius/server.js#L1524)); Grin Drop's
   sweeper cancels `TxSent && !confirmed` rows as **"abandoned unfinalized wallet txs"** to free
   their locked inputs ([059_drop/server/app.js:901–905](../../web/059_drop/server/app.js#L901)).
   Both would be nonsense if `TxSent` meant broadcast. The pool's payout path is the only reader
   in the repo that reads it that way.

### Threat actors used in this section

| Label | Means |
|---|---|
| **The system** | No attacker. A process restart, an OOM kill, a node outage, a 120 s CLI timeout. This is the dominant actor in this session — five of nine findings need nobody at all |
| **Registered miner** | A miner attacking their own payout, or another's |
| **Anonymous** | Internet, no credentials — reaches the Nostr relays the bridge subscribes to |
| **Logged-in admin** | A `freshAdmin` session. Includes the *honest* operator pressing a button that does the wrong thing |
| **On-box root** | Shell on the pool server — Info only, per plan rule 7 |

---

### J4-1 — [Critical] `reclaimStaleFinalizing` treats an output lock as proof of broadcast, so every stale claim confirms — a node outage during `post_tx` silently confiscates the miner's payout — **FIXED 2026-08-27 (see §J4 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J4-1).**

### J4-2 — [High] The admin *Retry* button zeroes `retry_count`, which is the only trigger for the §H1 double-send guard — so it re-sends, unguarded, exactly the payouts most likely to have already landed — **FIXED 2026-08-27 (see §J4 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J4-2).**

### J4-3 — [High] A crash while a Tor payout is `tor_sending` strands the row forever: the lock is never released, and that address can never withdraw again — **OPEN**

**Threat actor: the system.** A `systemctl restart`, a deploy, an OOM kill.

The Tor send window is wide — up to `wallet_send_timeout_ms` (120 s default) inside
`sendToTorAddress`, plus two further wallet round-trips (`recordTorFee`, `_captureTorSlateId`)
before `markConfirmed` writes anything. Die anywhere in there and the row stays `tor_sending`.

Nothing gets it out. Enumerated exhaustively over the backend — `tor_sending` appears in exactly
these places, and none of them is a transition **out**:

| Path | Selects | Verdict |
|---|---|---|
| `processRetryQueue` ([:246](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L246)) | `status='retry_scheduled'` | never sees it |
| `processTorChecks` ([:267](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L267)) | `status='tor_checking'` | never sees it |
| `processSlatepackExpiry` ([:1101](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L1101)) | `status='slatepack_pending'` | never sees it |
| `reclaimStaleFinalizing` ([:1395](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L1395)) | `status='finalizing'` | never sees it |
| `POST /admin/withdrawals/:id/cancel` ([index.js:2403](../../web/07_mining_pool_public/back-end-pool/index.js#L2403)) | — | **explicitly 409s** `tor_sending` |
| `POST /admin/withdrawals/:id/retry` ([index.js:2356](../../web/07_mining_pool_public/back-end-pool/index.js#L2356)) | `retry_scheduled`/`tor_failed` only | 409s |

Consequences compound. `tor_sending` is inside `PENDING_SQL`
([:16](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L16)), so the row
holds the address's **one-pending-per-address slot permanently** — every future withdrawal that
miner requests, on any rail, returns 429 *"you already have a pending withdrawal"*. The
`balance_locked` is never released, so the money is neither spendable nor payable. AlertMonitor and
reconciliation both count it as in-flight forever. There is no admin UI action of any kind.

This is the same crash window §H2 solved for the slatepack rail with `reclaimStaleFinalizing`. The
Tor rail's equivalent window is wider and got nothing.

**Harness — T3:**

```
  PASS  every scheduler recovery pass leaves it in tor_sending      status=tor_sending
  PASS  the balance stays locked forever                            locked=100
  PASS  it permanently occupies the one-pending-per-address slot    pending=1
  PASS  so the miner can never withdraw again
```

**Recommended fix.** A `reclaimStaleTorSending()` beside the existing sweep, resolving a
`tor_sending` row older than a bound (send timeout + slack) from the wallet tx log via
`_priorSendLanded` — which is already exactly the right tool, since it matches on net amount and
creation time and refuses another withdrawal's slate. **Blocked on J4-1 and J4-4:** built on today's
matcher it would inherit the same "an output lock counts as a send" mistake, in a place where a
false positive again means a confiscated balance. Fix the discriminator first, then reuse it here.
A short-term operator escape hatch — letting the admin cancel route accept `tor_sending` past an
age threshold, with a loud warning — restores the money but re-opens §H1's double-pay, so it is not
a substitute.

---

### J4-4 — [Medium] `_priorSendLanded` skips its time filter when the tx log carries no parseable `creation_ts`, so any historical same-amount send is accepted as this payout — **FIXED 2026-08-27 (see §J4 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J4-4).**

### J4-5 — [Medium] The payout freeze is only read once per scheduler tick, so up to 15 more payouts go out after an emergency stop — **OPEN**

**Threat actor: the system / the operator in an incident.**

The plan asks whether `payouts/freeze` stops the scheduler loop or only the API. Answer: it stops
the loop **at the top of the next iteration**, and that boundary can be half an hour away.

`schedulerLoop` reads `isFrozen()` once
([:87](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L87)) and then
runs `processRetryQueue` (`LIMIT 10`) and `processTorChecks` (`LIMIT 5`) to completion. Each row is
awaited serially through `sendToTorAddress`, which can take the full 120 s timeout. `sendWithdrawal`
and `initiateWithdrawal` contain **no** freeze check — `_assertNotFrozen` guards only the four
create/finalize entry points ([:649](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L649),
[:742](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L742),
[:832](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L832),
[:897](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L897)). So 15
outbound sends, worst case ~30 minutes of them, continue after the switch is thrown.

This matters because of *who* throws it: AlertMonitor freezes automatically on a critical money trip
— coverage shortfall, integrity drift, **wallet drain**, wallet-identity mismatch. Those are exactly
the conditions under which the next fifteen sends should not happen. The kill-switch comment already
argues this case for the synchronous rails (*"the scheduler loop skipping sends is NOT enough"*,
[:118–122](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L118)) and then
does not apply it to the loop itself.

**Harness — T5:**

```
  PASS  isFrozen() reports frozen
  PASS  sendWithdrawal sends anyway — no freeze check on the send path    sends=1
```

**Recommended fix.** `this._assertNotFrozen()` (or a quiet `if (this.isFrozen()) return;`) at the
top of `sendWithdrawal`, after the row read and **before** the `tor_checking → tor_sending` claim,
so a frozen pool leaves the row where the next resume will pick it up. Cheap: one indexed read of a
single-row table per payout. Consider also re-checking between iterations of both batch loops.

---

### J4-6 — [Low] A non-numeric `withdrawal_cooldown_minutes` silently switched the cross-rail reversal cooldown off — **FIXED 2026-08-26**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J4-6).**

### J4-7 — [Low] The Tor pre-flight gate fails **silent**, not merely open — an operator who switched it on cannot tell it has been inert — **FIXED 2026-08-26**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J4-7).**

### J4-8 — [Low] `nostr_seen_events` grows without bound, and a row is written before the wrap is decrypted — **OPEN**

**Threat actor: anonymous internet.** Only when the Goblin rail is switched on (off by default).

The bridge's replay dedup table is created by the bridge itself
([nostr-payout.js:454–460](../../web/07_mining_pool_public/back-end-pool/lib/nostr-payout.js#L454))
and appears nowhere in `lib/retention.js` or any prune path — grepping the backend for
`nostr_seen_events` returns the `CREATE TABLE` and the one `INSERT`, nothing else. It is never
pruned.

The write also happens *before* any authentication of the event:

```js
if (ev.content && ev.content.length > WRAP_CONTENT_MAX) return;   // size cap: good
if (!this._markSeen(ev.id)) return;                               // :391 — row written here
let rumor; try { rumor = this._unwrap(ev); } catch (_) { return; } // decrypt happens after
```

Anyone can publish kind-1059 events `#p`-tagged to the pool's public key on the configured relays;
each undecryptable one costs a permanent row. The size cap bounds one event, not the count. This is
disk growth on the same SQLite file that serves share intake, which memory
`project_pool_db_capacity` records as the thing that stalls **shares**, not just a page.

The ordering is defensible on its own terms — dedup before an expensive `nip44` decrypt — so the
fix is retention, not reordering: prune `nostr_seen_events` on the existing retention pass at a
window comfortably past `nostr_pending_ttl_minutes` and the relay `LOOKBACK_SECS` (24 h is ample),
and add an index on `seen_at`.

---

### J4-9 — [Info] `manualPayout` accepts a payout record with no on-chain referent

**Threat actor: logged-in admin** — Info per plan rule 7, and inside the trust model.

`POST /api/admin/dormancy/manual-payout` is the recorder for an out-of-band send. `kernelExcess`
and `slateId` are both optional
([dormancy.js:415](../../web/07_mining_pool_public/back-end-pool/lib/dormancy.js#L415)), so it can
write a `confirmed` withdrawal and a `withdrawal` debit with nothing tying it to a transaction. The
guards that exist are good — freeze self-check, `≥ min` requires an explicit ack, balance ceiling,
and a dedup on kernel/slate/(address, amount, 60 s) — but the dedup can only fire when one of those
identifiers is supplied, so the safest input is the optional one. Reconciliation will not notice:
an unbacked debit reduces liability, which shows as coverage *surplus*, and `auditWalletSends` only
looks for the opposite mismatch.

Worth requiring one of `kernel_excess` / `slate_id` (a real out-of-band send always has one, and it
is what makes `auditWalletSends` match the operator's own send rather than flag it). Not a
vulnerability — an operator who wants to zero a balance has better tools — but it removes the one
money route whose record cannot be checked against the chain.

---

### Verified correct (read with evidence, not assumed)

- **No double-pay from concurrency in any create path.** `createWithdrawal`, `createSlatepackWithdrawal`
  and `createNostrWithdrawal` each run the pool-wide cap, the `userPending >= 1` check and the CAS
  balance lock inside one `db.transaction`, with **no `await` anywhere before `txn()`** — checked
  statement by statement. On single-threaded Node with synchronous better-sqlite3, two concurrent
  requests cannot interleave into a double lock. The plan's "can the one-pending rule be raced"
  question is a clean no.
- **The finalize claim holds.** `_claimForFinalize` is a CAS inside a transaction that writes the
  status flip and its timestamp event together, taken before the first `await` in both finalize
  paths ([:843](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L843),
  [:1000](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L1000)). A second
  finalize, a relay redelivering an S2, and an admin cancel all lose. §H2's *"age the CLAIM, not the
  row"* trap is still correctly implemented — the sweep ages from the `to_status='finalizing'`
  event, not `withdrawals.created_at`. **The claim mechanism is sound; J4-1 is about what the
  recovery path concludes, not about the claim.**
- **Every settlement write is a guarded CAS in the same transaction as the balance move.**
  `_creditConfirm` ([:1240](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L1240))
  and `_reverseLock` ([:1281](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L1281))
  both refuse to move money when they lose the status claim, and `markConfirmed`/`markFailed`
  delegate rather than hand-rolling. Confirm and reverse cannot both land. No transition writes the
  ledger and the status in two separate statements.
- **The fee model matches memory `project_pool_fee_model` exactly.** `_feeFor` is un-clamped
  ([:156](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L156)) and
  `_netSend` rejects a payout that cannot cover its fee (400) rather than sending dust; the fee is
  frozen into `fee_charged` at request time but only *charged* inside `_releaseLockAndDebit` at
  confirm, so **no reversal path un-charges anything** — verified by reading all four reversal
  callers. The debit splits into `withdrawal` + `withdrawal_fee` summing to the release, with a
  matching `pool_fee` credit, so the integrity invariant nets zero.
- **Dormancy's destination cannot be aimed anywhere.** `PRIZE_POOL` is a module constant
  ([dormancy.js:5](../../web/07_mining_pool_public/back-end-pool/lib/dormancy.js#L5)) with no
  settings key, no request parameter and no config read — `runOnce` writes exactly one credit, to
  it ([:376](../../web/07_mining_pool_public/back-end-pool/lib/dormancy.js#L376)). `send-payout`
  goes through `createWithdrawal(..., 'tor', {adminOverride})`, and the Tor rail can only pay the
  address's own wallet; `adminOverride` bypasses the min floor and the reversal cooldown and
  nothing else — freeze, CAS lock and the one-pending cap all still run
  ([:649–650](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L649)).
  Marked FINAL in memory `project_pool_dormant_balances`, and the code matches.
- **The Goblin rail's response routing cannot be pointed at another miner.** The bridge selects the
  pending row by the *sender's* npub and hands back that row's own address
  ([nostr-payout.js:409–414](../../web/07_mining_pool_public/back-end-pool/lib/nostr-payout.js#L409));
  `finalizeNostrWithdrawal` then re-checks method, status, address and the registered npub before
  claiming ([:987–994](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L987)),
  and binds `slate.id` to the issued slate. A late or replayed S2 is a no-op. *(2026-09-27: not
  while the row had no `slate_id` yet. A late S2 routed to a NEW row mid-create was finalized, and
  so was one with no id. Fixed to fail closed; see the roll-up note "Slatepack finalize binding".)*
- **`_priorSendLanded`'s cross-miner false positive is genuinely closed.** The `claimed` set excludes
  any slate already recorded against a *different* withdrawal
  ([:444](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L444)), so two
  miners withdrawing the same amount cannot collide. J4-4 is about the time bound, not this.
- **`tor_sending` is the only orphan state.** `tor_checking` is re-selected every tick,
  `retry_scheduled` by the retry queue, `slatepack_pending` by the TTL sweep, `finalizing` by the
  stale-claim sweep. Enumerated against `PENDING_SQL`, not assumed.
- **`finalizing` reached every in-flight list §H2 required.** Confirmed present in
  `alert-monitor.js:226`, `reconciliation.js:87` and `:289`, `index.js:3036`/`3041`/`6054`,
  `admin-panel/payments.html` (label, `ACTIVE`, `inflightStatuses`) and
  `public_html/js/payout-methods.js`. No list has drifted since.
- **The wallet Owner-API client is sound where it matters here.** ECDH key is the raw shared
  X-coordinate (the documented trap), AES-256-GCM with a random 12-byte nonce per call, the auth tag
  is verified on decrypt, and `_call` re-opens the session only on the three specific auth/session
  error strings — it does not retry arbitrary failures, so a `postTx` error cannot become a second
  broadcast attempt inside the client.
- **§H3's `tor-check` account-existence check is still in place**
  ([index.js:3706](../../web/07_mining_pool_public/back-end-pool/index.js#L3706)), and the withdraw
  pre-flight still probes **fresh** rather than through the 60 s cache — a money decision must not
  read a stale "offline".

### Re-confirmed still open (not re-reported)

- **§H's placeholder zeros** in `_releaseLockAndDebit`'s two debit rows (`balance_before`/`after`
  written as `0`) are unchanged — the locked columns are correct, and reversals were fixed in §H2.
- **Dead `canInitiateWithdrawal()`** ([:1446](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L1446))
  still carries a status list missing `slatepack_pending`/`finalizing` and a `MAX_USER_PENDING`
  budget of 10 that contradicts the live one-pending rule. Still zero callers; still a trap for
  whoever wires it up believing it is the cap check. Delete it.
- **§C3** (access tokens unrevocable until expiry) bounds how long a stolen admin session can press
  the buttons in J4-2 and J4-5.

---

### Handoffs

- **§J5** — J4-1's premise is the same class as memory `project_pool_node_error_classification`
  (*classify by origin, never by a message string*): here a *log entry's existence* is being read as
  a chain event. §J5 owns `grin-node.js`, which is where the node's own view of a broadcast lives —
  if a `get_kernel`-style lookup is available there, it is a better discriminator for J4-1's UNKNOWN
  case than waiting for the wallet's `confirmed` flag.
- **§J9** — `withdrawal_cooldown_minutes` is now defensive at the consumer (J4-6), but the same
  raw-`pool.json` path feeds `max_pending_withdrawals`, `max_user_pending`, `slatepack_ttl_hours`,
  `nostr_pending_ttl_minutes` and `wallet_send_timeout_ms` with no coercion at
  [config.js:73](../../web/07_mining_pool_public/back-end-pool/lib/config.js#L73). The two pending
  caps are already `Math.max(1, parseInt(...) || N)`-guarded; the three timeouts are not — a
  non-numeric `slatepack_ttl_hours` makes the expiry cutoff `NaN`, and `created_at <= NaN` matches
  nothing, so the TTL refund silently stops. Whether the validators can emit a non-number is J9's.
- **§J12** — the scheduler loop is strictly serial and one unreachable Tor recipient costs the full
  `wallet_send_timeout_ms`. With `MAX_PENDING_WITHDRAWALS` at 100 and `processTorChecks` at `LIMIT
  5`, a queue of slow payouts delays the TTL refund sweep and the stale-claim sweep by tens of
  minutes per tick. Not exploitable by one actor (one pending per address), but it is a queueing
  bound worth stating alongside the bucket limits.
- **§J13** — `nostr_relays` and `nostr_nip05_domains` are operator-set outbound destinations reached
  from the payout path; the NIP-05 fetch is domain-allowlisted
  ([nostr-payout.js:360–372](../../web/07_mining_pool_public/back-end-pool/lib/nostr-payout.js#L360))
  but the relay list is not. Also `wallet-tor.js` shells out to `grin-wallet` via `spawn` with an
  argv array (no shell) and feeds the passphrase on **stdin**, not `-p` — which is the pattern
  CLAUDE.md asks for and which `lib/07_solo_wallet.sh` / `lib/059_lib_wallet.sh` still owe.
- **§J15** — if J4-1's fix introduces a long-lived `finalizing` state, the account page's
  *"broadcasting to the Grin network — almost done"* label
  (`public_html/js/payout-methods.js:57`) becomes a lie for a stuck row and needs a second string.
- **§J16** — `wallet-tor.js`'s `isPayoutAddress` accepts `grin1…` **and** `tgrin1…` regardless of
  `config.network`, and does so case-insensitively; `wallet.js:validateGrinAddress` (unused on this
  path) does check the network prefix. Whether a mainnet pool can end up holding a testnet address
  as a mining identity is J3's canonicalisation question, but the *deployment* half — that the two
  validators disagree and the payout path uses the looser one — belongs with the install scripts.
- **§J17** — three things must be checked on a real box before mainnet, and J4-1/J4-3/J4-4 all hang
  off the first: (1) dump `retrieve_txs` for a slatepack payout **between creation and finalize**
  and record whether it is `TxSent`, what `confirmed` says, and whether `creation_ts` is present —
  this single observation confirms or refutes J4-1's premise directly; (2) do the same for a Tor
  send that times out, to learn whether the CLI locks outputs before or after the round trip;
  (3) kill the backend mid-`tor_sending` and confirm the stranded row (J4-3).

---

### Verification

All nine findings were written from reading first, then confirmed by execution — nothing above
rests on inference alone. The harness (`scratchpad/j4harness.js`, one-shot, deleted with the
scratchpad) bound the **real** `WithdrawalScheduler` — `require`d from
`lib/withdrawal-scheduler.js`, not copied — to a `node:sqlite` in-memory DB with the production
column set, stubbing only `./db` (a `transaction()` shim using savepoints, since better-sqlite3 is a
native module that exists only on the VPS), `./incentives` and `./wallet-tor`. The wallet's tx log
is the one thing supplied per-test, because it is the input every finding turns on.

**19 assertions, all passing**, across five groups: T1 the stale-finalize sweep against an
unconfirmed `TxSent` (plus the `TxSentCancelled` control proving the branch is live); T2 the H1
guard with `retry_count` 0 vs 1 on otherwise identical rows; T2b the same historical transaction
with and without `creation_ts`; T3 all four recovery passes plus the one-pending consequence for a
`tor_sending` row; T4 the cooldown fallback before and after the fix, including that `0` still
disables and an absent key still defaults; T5 a send issued while `payout_control.frozen = 1`.

Every control assertion is there on purpose: a test that only shows the bug cannot distinguish a
real defect from a broken fixture.

**Two fixes applied in the finding pass** (plan rule 3 — small and local, neither touches the state
machine): J4-6 in `lib/withdrawal-scheduler.js` and J4-7 in `index.js`. `node --check` passes on
both files.

**The other seven were written up OPEN**, on the reasoning that J4-1, J4-2, J4-3 and J4-4 are one
connected decision — they rest on what the wallet tx log means, three share a matcher, and J4-3's
fix is blocked on J4-1's. That framing was half right: the *connectedness* held, but treating J4-1
as undecidable did not, since its discriminator can only fail safe. **J4-1, J4-2 and J4-4 were
fixed the next day — see the §J4 resolution pass below**, which also records why the original
stopping point was too conservative and adds J4-10 and J4-11, both found while implementing. J4-3,
J4-5, J4-8 and J4-9 remain open as written.

**Mainnet gate.** J4-1 alone should hold the launch: it needs no attacker, it triggers on an
ordinary node outage, it takes the miner's whole payout, and nothing in the alerting notices.
*(Fixed 2026-08-27; the gate now rests on J4-3 and J4-10, and on the §J17 wallet observation that
confirms the premise all three turn on.)*

---

### §J4 — resolution pass, 2026-08-27 (add-ons, NOT VPS-TESTED)

Scope chosen by the operator after the findings landed: **fix the matchers and the guard arming;
add no new machinery.** So J4-1, J4-2 and J4-4 are closed here, and J4-3 (the `tor_sending`
sweeper) plus the operator surfaces are deliberately not built — see *Deliberately not applied*.

**Why these were fixed now rather than held.** The session first filed J4-1 as "structural, left
for a decision" while simultaneously recommending it hold the mainnet launch, and those two do not
sit together. The policy tail *is* structural — what happens to a payout that stays UNKNOWN
forever, on a status §H2 deliberately made un-cancellable — but the discriminator is not, and the
discriminator is the part that loses money. The argument for waiting was that the premise about
grin-wallet's tx log is inferred from reading rather than from a live wallet; that argument does
not survive being followed through, because **requiring `confirmed` can only make the sweep more
conservative.** If the premise is right, this stops silent confiscation. If it is wrong, the worst
case is a payout that stalls instead of settling — recoverable, visible, and the trade the module's
own comment already picks. The asymmetry runs one way, so an unverified premise is a reason to
verify on the VPS (§J17 still owes that), not a reason to keep the wrong test.

#### What was applied

**J4-1 — `reclaimStaleFinalizing` is now three-state**
([withdrawal-scheduler.js:1422–1510](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L1422)).
The single `TxSent` set is replaced by two structures built in one pass: `onChain` (`tx_type ===
'TxSent' && t.confirmed`) and `known` (slate_id → tx_type, for everything the wallet still holds).
Per stale row:

| Wallet says | Verdict | Action |
|---|---|---|
| `TxSent` **and** `confirmed` | on chain | confirm — release lock, debit, fee (unchanged) |
| `TxSentCancelled`, or slate absent entirely | never posted | release the claim → `slatepack_pending` |
| `TxSent`, **not** confirmed | **UNKNOWN** | leave it claimed, warn, re-ask next tick |
| no `slate_id` at all | nothing could have been sent | release the claim (unchanged) |
| wallet unreachable | UNKNOWN | leave it (unchanged) |

The UNKNOWN warn line names the address and the amount still locked, so the row is greppable while
no operator surface exists for it.

**`kernel_excess` is deliberately NOT used as a second on-chain signal**, and the code says so. It
may be populated at `finalize_tx` — i.e. *before* `post_tx` — which is exactly the window this
sweep exists to judge, so adding it would rebuild the same bug one field over. `confirmed` is the
only field whose meaning is unambiguous and already relied on elsewhere
([reconciliation.js:278](../../web/07_mining_pool_public/back-end-pool/lib/reconciliation.js#L278)).
Cost of the narrower test: a payout broadcast seconds before the sweep runs is not confirmed on
this tick. It confirms on the next one, 60 s later.

The method's header comment was rewritten too — it documented the two-state model as correct, which
is how the mistake would have been re-introduced by the next reader.

**J4-2 — the double-send guard is armed off the event log**
([withdrawal-scheduler.js:339–348](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L339),
[:370–374](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L370)).
`sendWithdrawal` now counts prior `to_status='tor_sending'` events **before** writing its own, and
arms on `priorAttempts > 0 || retry_count > 0 || slate_id`. `withdrawal_events` is append-only and
no admin action rewrites it, so the admin *Retry* button can keep resetting the ladder without
disarming the guard. `retry_count` and `slate_id` stay in the condition as belt and braces rather
than as the mechanism. A genuine first attempt still matches none of the three and still pays no
extra wallet round-trip — verified, not assumed (R2 below).

**J4-4 — an unparseable timestamp is a missing observation**
([withdrawal-scheduler.js:465–486](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L465)).
Two changes in `_priorSendLanded`'s amount branch: a per-entry `if (when === null) return false;`
so one undated entry cannot slip past the age bound, and a systemic check — if **no** candidate
carries a parseable `creation_ts`, the method returns `{ checked: false }` with a warn rather than
matching on amount alone. That routes the case into the fail-open path §H1 already defined (retry
proceeds, loudly logged) instead of silently marking a miner paid.

#### Deliberately not applied

- **J4-3 (`tor_sending` orphan) stays OPEN.** It needs a sweeper that does not exist, and that
  sweeper would settle payouts autonomously — new money-moving machinery, pre-mainnet, out of the
  chosen scope. It is now *unblocked*, though: it can be built on the corrected matcher rather than
  inheriting the bug. Verified still reproducing after this pass (R4).
- **No operator surface for an UNKNOWN row.** A parked `finalizing` row still has no age alert and
  no admin action — `POST /api/admin/withdrawals/:id/cancel` refuses `finalizing` by §H2's design.
  So the fix converts a silent wrong settlement into a **visible stall that only a human can end**,
  and today the human has only the log line. That is the correct direction and an incomplete
  destination; it is the other half of the J4-3 decision, not a separate one.
- **J4-5, J4-8, J4-9** unchanged, as scoped.

#### A regression this pass introduced, caught in self-review — **FIXED same pass**

Parking an UNKNOWN row means it is re-selected on **every** subsequent tick, and
`reclaimStaleFinalizing` selected `ORDER BY w.created_at ASC LIMIT 10`. That bound was safe only
while every selected row resolved on the tick it was selected — which was true before this change
and is not true after it. Ten parked rows would permanently fill the batch and **starve every newer
stale claim behind them, including ones that are resolvable**, turning one node outage into a
spreading stall. The fix for a silent wrong settlement would have created a queue that quietly
stopped settling anything.

The limit costs almost nothing to raise, which is what makes this cheap: the expensive part is the
single `getTransactions()` call, which serves the whole batch however large, and the per-row work
is a synchronous DB transaction. It is now `Math.max(50, MAX_PENDING_WITHDRAWALS)` bound as a
statement parameter ([withdrawal-scheduler.js:1433–1449](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L1433)),
so it cannot be smaller than the number of rows that can be in flight.

Demonstrated both ways: twelve stale claims, eleven UNKNOWN and the twelfth genuinely on chain and
**newest**, so it sat behind the wall. `SELECT id … ORDER BY created_at ASC LIMIT 10` returns
`1..10` and excludes it; with the new bound the sweep confirms row 12 while leaving the other
eleven claimed, on **one** wallet scan.

**Related cost, recorded not fixed:** while any row is parked, the sweep now calls
`getTransactions(true)` — a node-refreshing scan — every 60 s indefinitely, where previously it ran
only until the stuck rows resolved. That is roughly 3× the cadence of the two existing periodic
scans (`backfillKernelProofs` and reconciliation, both ~3 min) and only during an incident. Left
alone deliberately: throttling it would delay a legitimate confirm, and the right answer is the
J4-3 operator surface that stops rows parking indefinitely in the first place.

#### Two findings surfaced while implementing

### J4-10 — [High] `_priorSendLanded` shares J4-1's premise, but its fix flips the risk direction — **OPEN**

**Threat actor: the system.**

The retry guard still tests `String(t.tx_type) === 'TxSent'`
([withdrawal-scheduler.js:451](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L451))
with no `confirmed` check, on both its branches — the authoritative `slate_id` lookup and the
amount match. By the same premise as J4-1, an entry that only ever reached `tx_lock_outputs` is
accepted as "this payout landed", and the row is confirmed without a send.

It was **not** folded into this pass because the correction is not the same one. In
`reclaimStaleFinalizing`, requiring `confirmed` is strictly safer. Here it is not: a payout that
was genuinely broadcast but not yet mined would stop matching, the retry would proceed, and that is
§H1's double-pay. The honest fix is the same three-state shape — confirmed → confirm;
cancelled/absent → re-send; unconfirmed `TxSent` → **defer** (leave the row on the retry ladder and
re-ask later) — which means a new outcome in `sendWithdrawal`'s flow, i.e. the machinery this pass
was scoped to avoid.

Mitigating, and the reason it is High rather than Critical: retries are ≥6 h apart
(`withdrawal_retry_delays` starts at `6 * 3600`), and a Grin transaction that was actually
broadcast mines long before that — so an unconfirmed `TxSent` at retry time is *usually* one that
was never posted, and the current code's guess is *usually* right. "Usually" is doing real work in
that sentence, which is why it stays open rather than accepted.

### J4-11 — [Low] `_captureTorSlateId` can attach another transaction's slate as a payout's on-chain proof — **OPEN**

**Threat actor: the system.**

Observed directly while testing J4-4 (R3 below): after a re-send, the row's `slate_id` was set to
`OLD` — a year-old unrelated transaction — because `_captureTorSlateId`
([:616–632](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L616)) matches
far more loosely than the guard beside it: `/Sent/` (which also matches `TxSentCancelled`, as its
own comment admits), `>= wantNano` rather than equality, no time bound, and "newest by `id`" as the
tie-break. It is documented as best-effort proof metadata that never affects the payout, and that
holds for the payout itself. But the value it writes is not inert:

- it becomes the account page's kernel deep-link, so a miner can be shown a stranger's transaction
  as proof of their own payment;
- `_priorSendLanded` builds its `claimed` set from `withdrawals.slate_id`
  ([:458](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L458)), so a
  wrong value there can shield a genuine match belonging to a *different* withdrawal;
- `backfillKernelProofs` will happily attach the wrong kernel to the row.

In practice sends are serialised through the scheduler, so "newest sent tx" is normally ours — this
needs an unusual wallet log to bite. Fix is to reuse the guard's matching rules (exact net amount,
`TxSent` only, created no earlier than the row) instead of a second looser copy.

#### Verification

Sixteen assertions against the **real** methods, same harness construction as the finding pass
(`require`d scheduler, `node:sqlite`, only `db`/`incentives`/`wallet-tor` stubbed; wallet tx log
supplied per test). One-shot; scratchpad; `node --check` clean.

- **R1 — all five `reclaimStaleFinalizing` branches**, each asserting on *money*, not just status:
  UNKNOWN leaves the row `finalizing` with 100 GRIN still locked and **no debit row written**;
  confirmed still settles and still credits `pool_fee` 0.04; cancelled and absent both return the
  row to `slatepack_pending` with the lock retained for the TTL sweep; a row with no slate is
  re-opened. Plus the **§H2 regression that had to survive**: a fresh claim on a 24 h-old
  withdrawal is not reclaimed, and the wallet is not even consulted for it.
- **R2 — the guard arming.** A row shaped exactly as the admin retry route leaves it (`tor_failed`
  → re-locked, `retry_count = 0`, prior `tor_sending` event in the log) now runs the guard and
  blocks the re-send. A genuine first attempt still skips it: one send, zero pre-send wallet calls.
- **R3 — the timestamp fallback.** An undated same-amount transaction no longer confirms the
  payout; the send proceeds with the loud log. Control: a properly dated match still confirms
  instead of re-sending. This test is also where J4-11 was observed.
- **R4 — untouched behaviour.** J4-6's cooldown still blocks, the slatepack TTL still refunds, and
  J4-3 still reproduces exactly as reported.

Every branch has a control assertion. A test that only shows the new behaviour cannot tell a real
fix from a broken fixture — R1's confirmed-path assertions exist to prove the sweep did not simply
stop working.

**R5 — self-review of this pass**, run after the fixes were written and the write-up was drafted,
which is where the batch-starvation regression above was caught. Three further assertions: eleven
parked rows stay claimed, a resolvable row behind them is still reached and confirmed, and one
wallet scan serves the whole batch. Two claims made in the new code comments were also checked
rather than assumed: `withdrawal_events` is **not** touched by `lib/retention.js` (it prunes
`shares`, `hashrate_history`, `alerts`, `admin_audit_log` and raw `balance_log` only), so J4-2's
arming signal is genuinely durable; and no path other than `sendWithdrawal` writes a
`to_status='tor_sending'` event, so the count cannot be inflated.

#### Behaviour an operator will notice

- A stale `finalizing` row whose transaction is not yet mined **no longer settles by itself**. It
  stays as *Settling* on the Payments page and emits a `⚠️ [finalize] stale claim … outcome
  UNKNOWN` line each minute, naming the address and the locked amount. Previously it settled
  silently and wrongly. **There is no button to resolve it** — that is J4-3's other half.
- The admin *Retry* button now costs one wallet round-trip before re-sending, and will sometimes
  refuse to re-send and confirm the payout instead. That is the guard doing its job.
- A wallet whose tx log lacks `creation_ts` now logs `[double-send guard] … treating the log as
  unread` on every retry and re-sends rather than confirming. If that line appears on a real box it
  is the §J17 observation arriving the hard way — capture a `retrieve_txs` dump before doing
  anything else.

#### Handoffs changed by this pass

- **§J17** — the VPS observation is now more valuable, not less: it validates a fix that is already
  shipped. Dump `retrieve_txs` for a slatepack payout **between creation and finalize** and record
  `tx_type`, `confirmed`, `kernel_excess` and `creation_ts`. `kernel_excess` is the one to watch —
  if it turns out to be populated at finalize, the comment forbidding its use as an on-chain signal
  is right and should stay; if it is only set once mined, it becomes a legitimate second signal.
- **§J5** — unchanged, and now load-bearing: if `grin-node.js` can ask the node directly whether a
  kernel is in the mempool or on chain, that is a better answer for the UNKNOWN state than waiting
  for the wallet's `confirmed` flag, and it would let J4-10 be fixed without a "defer" outcome.
- Everything else in §J4's handoff list stands as written.

---

## §J5 — Reward & orphan ledger (2026-08-27, add-ons, NOT VPS-TESTED)

Fifth session of the pre-mainnet §J pass (see the Status roll-up at the top of this file).
Scope: [`lib/rewards.js`](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js) (335),
[`lib/blocks.js`](../../web/07_mining_pool_public/back-end-pool/lib/blocks.js) (330),
[`lib/block-monitor.js`](../../web/07_mining_pool_public/back-end-pool/lib/block-monitor.js) (192),
[`lib/orphan-detector.js`](../../web/07_mining_pool_public/back-end-pool/lib/orphan-detector.js) (232),
[`lib/reconciliation.js`](../../web/07_mining_pool_public/back-end-pool/lib/reconciliation.js) (490),
[`lib/ledger-rollup.js`](../../web/07_mining_pool_public/back-end-pool/lib/ledger-rollup.js) (118),
plus the uncommitted [`lib/grin-node.js`](../../web/07_mining_pool_public/back-end-pool/lib/grin-node.js)
and the block routes in [`index.js`](../../web/07_mining_pool_public/back-end-pool/index.js).
Question asked: **can GRIN be credited that the chain never paid, or an orphan reversal
double-charge?**

**Revision read:** the **working tree** at commit `fd6879f` + uncommitted changes, as the plan
requires. Since the plan was written (2026-08-25) the tree has moved: 18 files are now modified,
not four, because §J2/§J3/§J4 landed their resolution passes in between. The three §J5-relevant
uncommitted diffs — `block-monitor.js` (+15/−4), `grin-node.js` (+144/−…), `orphan-detector.js`
(+26/−10) — are the node-error-classification work from memory
`project_pool_node_error_classification`, and they are the version reviewed below.

Read first, then confirmed by execution. Three one-shot harnesses, all in the scratchpad, no
server and no VPS (plan rule 5): a `node:sqlite` schema replica for the storage behaviour, a
require-cache stub of `node-fetch` bound to the **real** `GrinNodeAPI` + `OrphanDetector` for the
classification cases, and the repo's own `RewardDistributor` against a throwaway DB file. The
durable half of that work is now committed as
[`scripts/test-block-ledger.js`](../../web/07_mining_pool_public/back-end-pool/scripts/test-block-ledger.js)
(20 assertions), wired into `npm test`.

**Headline — the answer to the first clause is "no, and it cannot credit anything at all".** The
money-in path is not leaky; it is *inert*. `blocks.nonce` is declared `INTEGER`, a Grin nonce is a
full-width `u64`, and the pool's SQLite binding **throws** rather than rounding when it reads one
back. One found block with a nonce in `[2^53, 2^63)` — an even-money coin flip per block —
permanently stops the maturity sweep, distribution, orphan detection and the admin blocks page,
for that block and every block after it. Nothing alerts, because the failure produces a wallet
*surplus* and every money detector the pool has is aimed at a shortfall.

The second clause is a "yes, but not the way §I3/§I4 expected": the reversal path cannot
double-charge a *distributed* block because it can never see one (J5-11) — but the classification
that decides whether to reverse **still had a way to condemn a live block on a misconfiguration**
(J5-2), which is the exact bug class the uncommitted diff was written to close.

### Threat actors used in this section

| Label | Means |
|---|---|
| **The system** | No attacker. A found block, a node restart, a transient DB fault. The dominant actor here — six of eleven findings need nobody at all |
| **Block-finding miner** | A miner who solves a block, and therefore chooses the `nonce` the pool stores. Not a privileged position: every miner is one, eventually |
| **Operator (honest)** | The pool's own admin, setting a value or pointing a URL. Includes the operator who reads a number the pool reports and believes it |
| **On-box root** | Shell on the pool server — Info only, per plan rule 7 |

---

### J5-1 — [Critical] `blocks.nonce` is an `INTEGER` column and a Grin nonce is a full-width `u64`, so reading back a found block throws — one block in two permanently stops all maturity, distribution and orphan detection — **FIXED 2026-08-27 (see §J5 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J5-1).**

### J5-2 — [High] A JSON-RPC *envelope* error is classified as a statement about the chain, so `Method not found` orphans a live block and reverses its payouts — **FIXED 2026-08-27**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J5-2).**

### J5-3 — [High] The nonce cannot be an exact chain comparator at all — `JSON.parse` has already rounded it — so fixing J5-1 turns both existing checks into a mass-orphan bug — **FIXED 2026-08-27 (see §J5 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J5-3).**

### J5-4 — [Medium] `'paid'` is missing from every block-status count, so the pool publicly reports 0 confirmed blocks and 0 confirmed reward in steady state — **FIXED 2026-08-27**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J5-4).**

### J5-5 — [Medium] A failed share query is indistinguishable from "no shares", and that branch permanently confiscates the block reward — **FIXED 2026-08-27**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J5-5).**

### J5-6 — [Medium] The block status flip is not a claim: a swallowed `UPDATE` leaves the row replayable, and the reversal has no idempotency guard its own sibling has — **FIXED 2026-08-27**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J5-6).**

### J5-7 — [Low] A falsy `Ok` fell through both unwrap branches and returned the `{"Ok":…}` wrapper as a result — **FIXED 2026-08-27**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J5-7).**

### J5-8 — [Medium] Every money detector is aimed at a shortfall, so a totally stalled distribution pipeline — the outcome of J5-1, J5-2 and a long node outage alike — raises nothing — **FIXED 2026-08-27 (see §J5 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J5-8).**

### J5-9 — [Low] `confirm_depth_mainnet` / `confirm_depth_testnet` are dead settings keys — the operator can edit the maturity depth, see it persist, and change nothing — **FIXED 2026-08-27 (see §J5 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J5-9).**

### J5-10 — [Low] The block reward is the hardcoded constant `60`, so the pool silently keeps every transaction fee in the blocks it finds, and that surplus biases the coverage check — **FIXED 2026-08-27 (see §J5 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J5-10).**

### J5-11 — [Info] Nothing can reverse a block orphaned *after* distribution, and the reversal that exists silently under-claws a miner with a pending withdrawal — **CLAMP FIXED 2026-08-27; the post-distribution reorg gap is an ACCEPTED RISK (see §J5 resolution pass)**

**Threat actor: the system** (a reorg deeper than maturity).

Two halves of the same structural point, filed as Info because neither is reachable in normal
operation and the safe direction is unchanged.

**(a) The reversal path cannot see a distributed block.** `detectOrphans` selects
`WHERE status = 'immature'`
([orphan-detector.js:61](../../web/07_mining_pool_public/back-end-pool/lib/orphan-detector.js#L61)),
and `checkImmatureBlocks` likewise. A block that has been confirmed, distributed and flipped to
`'paid'` is never re-examined by anything, ever. So the plan's question — *can a reversal debit a
balance that was already withdrawn?* — has the answer "it cannot get the chance", and
`reverseBlockPayouts`' own comment says as much: *"in normal operation there are zero credit rows
here"*. The corollary is the real content: **there is no mechanism at all for a reorg deeper than
`confirm_depth`.** At 1440 blocks (~24 h) on Grin that is a defensible risk to accept — but it is
an accepted risk, not a covered one, and it is not written down anywhere yet. It belongs in the
*Residual / accepted risks* section.

**(b) The clamp ignores locked balance.**
[orphan-detector.js:205](../../web/07_mining_pool_public/back-end-pool/lib/orphan-detector.js#L205):
`const clawback = Math.min(c.amount, before.balance);` reads `balance` only, not `balance_locked`.
If the reversal path ever *did* run against a distributed block whose miner had a pending
withdrawal, the credited GRIN would be sitting in `balance_locked`, `balance` would be near zero,
and the clawback would be near zero — the orphaned reward is then paid out. The comment says the
shortfall is "implicit in the ledger trail", and it is: the reversal row records the *clamped*
amount, so `integrity_drift` stays at 0 by construction (J5-8's table). Only `coverage_full_gap`
notices, aggregated across the whole pool, with nothing naming the block.

If (a) is ever closed — a post-distribution reorg handler — (b) must be closed with it, and the
right answer is to reverse against `balance + balance_locked` and cancel the pending withdrawal,
not to clamp.

---

### Verified correct (read with evidence, not assumed)

Checked because the plan named them or because a neighbouring finding made them suspect. None
needed a change.

- **§I3 (chain re-verification is live) holds in the working tree.**
  `new RewardDistributor(config, blockMonitor.grinNode)` is the live construction, `this.grinNode`
  is assigned at [rewards.js:12](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L12),
  and the no-node branch **throws** rather than crediting
  ([:89](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L89)) — asserted by
  `test-money-path.js` and re-asserted here. The `getHeader`-not-`getBlock` choice is right for a
  pruned node.
- **§I4 (atomic settlement) holds.** The `confirmed → paid` CAS is the **first** statement inside
  the single `db.transaction()` and throws `alreadySettled` on `changes !== 1`
  ([rewards.js:139–158](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L139)); miner
  credits, the pool fee and `incentives.applyToDistribution` all run inside it, and
  `sqlite-compat.transaction()` opens a SAVEPOINT rather than a second BEGIN when nested, so
  incentives participates instead of committing separately.
- **§I5 (real ledger snapshots) holds** on both credit paths
  ([rewards.js:232–249](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L232),
  [:265–279](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L265)). §I6's
  `INSERT OR IGNORE` + `changes !== 1` assertion is present.
- **§I9 (retention floor) holds:** `WHERE status IN ('immature','confirmed')`
  ([retention.js:52](../../web/07_mining_pool_public/back-end-pool/lib/retention.js#L52)), and
  `PPLNS_WINDOW_BLOCKS = 60` matches `RewardDistributor.pplnsWindow = 60`. Duplicated constants,
  but they agree and the comment says why.
- **PPLNS weight is not miner-forgeable.** `shares.difficulty` is written from
  `session.difficulty`, which is server-set to a constant `1.0` at
  [miners.js:26](../../web/07_mining_pool_public/back-end-pool/lib/miners.js#L26) and never
  assigned again anywhere — a miner cannot influence their own weight. `block_height` is the
  miner's value but must equal `currentJob.height`
  ([stratum-server.js:539](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L539)),
  so shares cannot be stuffed into another block's window; and nothing is persisted until the
  **node** has accepted the PoW ([:568–583](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L568)).
  Because every difficulty is 1.0, `totalDifficulty` equals the share count and can never be 0
  while `shares.length > 0`, so the `sharePercent` division cannot produce `NaN`.
- **Maturity cannot be short-circuited.** `confirm_depth_mainnet` is 1440 and unreachable from the
  admin panel (J5-9 — dead in the safe direction). `checkImmatureBlocks` requires
  `tip.height - block.height >= confirmDepth` before it will even ask the node, and a resyncing
  node has a *lower* tip, so the gate is conservative during a rebuild rather than permissive. Grin
  syncs the full header chain before the tip advances, so `get_header` at a matured height is
  always available by the time the gate opens.
- **Orphan detection fails safe on an unreachable node.** `checkNewBlocks` returns early on
  `!status.ok` and so never reaches the sweep; `verifyBlockOnChain` rethrows anything that is not
  an explicit node `NotFound`; `detectOrphans` reports `aborted:true` with partial counts instead
  of a reassuring "0 checked". The uncommitted diff is a genuine improvement and its two callers
  now log the abort loudly.
- **`ledger-rollup.js` is sound.** `rollupCompletedDays` is a whole-day recompute with
  `ON CONFLICT … DO UPDATE`, the horizon marker advances inside the same transaction as the insert
  (so it can never lead the data), and `verifyAndPruneRaw` verifies count **and** sum per day
  against the rollup before deleting and halts on any mismatch. `balance_log.created_at` is never
  written explicitly anywhere in the codebase — every insert takes the `DEFAULT unixepoch()` — so
  the "a completed UTC day is immutable" premise the composite readers depend on actually holds.
- **`reconciliation.js` composite reads are correctly split.** Lifetime = `rollup(day < H) +
  raw(created_at >= H)` with no overlap and no gap; short windows read raw only and sit inside the
  45-day raw floor. The `SUM()`-not-bare-column treatment of the lazily-created `pool_fee` /
  `prize_pool` rows is correct and the comment explaining it is accurate.
- **Fee model matches memory `project_pool_fee_model`.** The percentage fee is taken at maturity,
  before the PPLNS split ([rewards.js:114–115](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L114)),
  and no fee of any kind is applied on the distribution path — so an orphan reversal replaying the
  credit rows cannot replay a withdrawal fee.
- **The `no_shares_found` branch CAS-flips** rather than blind-updating
  ([rewards.js:99–104](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L99)), so even
  that terminal path cannot double-settle.

---

### Handoffs

- **§J17 (launch gate) — two items, both now blocking rather than nice-to-have.**
  1. Confirm the stratum block-found reply format on a live node: capture the raw
     `blockfound - <hash>` string and check the parsed `blocks.hash` equals `get_header(h).hash`.
     J5-3's recommended fix (hash as the mandatory comparator) depends on this, and §I3's
     resolution already flagged it as unverified.
  2. Also capture `get_header(h).nonce` **as raw bytes off the wire** — number or string, and its
     magnitude. It settles which half of J5-3's demonstration applies in practice, though the fix
     is the same either way.
  3. The launch checklist needs a step the operator can run to distinguish *no blocks found yet*
     from *blocks found, none credited* without reading the log (J5-8).
- **§J7 (DB layer) — three things this session found in its files but does not own.**
  1. `initDb` sets `journal_mode=WAL` and `foreign_keys=ON` and **no `busy_timeout`**
     ([db.js:16–17](../../web/07_mining_pool_public/back-end-pool/lib/db.js#L16)), so SQLite's
     default of 0 makes any contention an immediate `SQLITE_BUSY`. J5-5's fix stops that
     confiscating a block reward, but the underlying timeout question is J7's.
  2. `blocks.nonce INTEGER` (J5-1) is one instance of a general question: **which other columns
     hold a value outside ±2^53 under `node:sqlite`, which throws on read where better-sqlite3
     rounded?** `total_difficulty` from the node is the obvious next candidate. A mechanical sweep
     of INTEGER columns fed from chain data belongs in J7.
  3. Money amounts are JS floats end to end on the credit path (`block.reward * pct`,
     `minerReward * share/total`), so `Σ` credits is not exactly `minerReward`. Ledger and log take
     the *same* float so the integrity invariant is unaffected; it is the nanogrin-arithmetic
     question J7 already owns.
- **§J6 (stratum) — `session.difficulty` is a hardcoded `1.0` with no vardiff**
  ([miners.js:26](../../web/07_mining_pool_public/back-end-pool/lib/miners.js#L26)). Good for J5
  (unforgeable PPLNS weight) but it means share volume scales linearly with pool hashrate, which is
  the `shares`-table growth bound memory `project_pool_db_capacity` lists as open.
  **2026-09-20 addendum:** that `1.0` was ALSO what every share was *recorded* at, and the
  hashrate/effort/luck arithmetic divides by the C32 graph weight (16384) expecting the chain's
  unit — so every hashrate on the site read 16384× low (0.00 G/s with 8 rigs mining) until the
  first live-miner test. Shares are now credited `job target × 16384`
  (`stratum-protocol.js shareCreditDifficulty`, from the JOB the submit names, never the session
  field); still a constant per share, so the J5 property holds. `db.js migrateShareCreditUnit`
  rescales pre-fix rows once. The vardiff/growth point above is unchanged.
- **§J9 (settings) — `confirm_depth_mainnet` / `confirm_depth_testnet` (J5-9)** are a *third*
  variant beyond J1-5's dead keys and J4-6's uncoerced values: keys that are validated by nobody
  **and** applied by nobody, yet round-trip through the UI convincingly. Worth a mechanical check
  in J9: every key in `PoolSettings.defaults` that is neither in `applyToConfig` nor read directly
  from `pool_config` by a consumer.
- **§J4's handoff to §J5 is answered: no.** `grin-node.js` exposes `getStatus`, `getTip`,
  `getHeader`, `getBlock`, `getOutputs`, `validateChain`, `getConnectedPeers` — there is **no
  kernel lookup and no mempool query**, so the node cannot currently be asked "did this payout's
  kernel land?". Adding one is possible (`get_kernel(excess, min_height, max_height)` is a Foreign
  API method) but it is new outbound surface with an SSRF-adjacent parameter, and it needs
  `withdrawals.kernel_excess` to be populated first — which §J4-10 established is exactly what is
  not known. **J4-10 and J4-11 stay open on their own terms; §J5 cannot close them.**

---

### Verification

- `npm test` — full suite green: `12 + 18 + 30 + 20 + 26 + 18` assertions plus 19 ownership-gate
  checks, 0 failed. The 20 are the new `scripts/test-block-ledger.js`, added this session and wired
  into `test:unit`.
- Three scratchpad harnesses, all one-shot, all exited on their own; no server was started and
  nothing was left running (CLAUDE.md local-process rule). The reproductions quoted above are
  reproducible from the snippets as written.
- Nothing was run against a VPS. All eleven findings are **add-ons, NOT VPS-TESTED**.

### Changed this session

| File | Change |
|---|---|
| `lib/grin-node.js` | J5-2 `chainStatement` flag — only `result.Err` may set `notFound`; J5-7 `hasOwnProperty` unwrap |
| `lib/rewards.js` | J5-5 `getSharesForDistribution` rethrows instead of returning `[]` |
| `lib/orphan-detector.js` | J5-6 CAS + boolean return on `confirmBlock`/`orphanBlock`; reversal idempotency guard |
| `lib/block-monitor.js` | J5-6 both money moves gated on the CAS result |
| `lib/blocks.js` | J5-4 `'paid'` counted as confirmed in `getPoolStats` + `getBlocksHistory`; `immature_blocks` counted directly |
| `scripts/test-block-ledger.js` | new — 20 assertions covering J5-1 (pinned as KNOWN OPEN), J5-2, J5-4, J5-5, J5-6, J5-7 |
| `package.json` | new test wired into `test:unit` |

**Left open at the end of the review session:** J5-1 and J5-3 as one coupled
schema-plus-comparator decision; J5-8 as new detector surface; J5-9 as a keep-or-delete call;
J5-10 as an operator policy decision; J5-11 as an accepted risk to write down. **All five were
closed the same day — see the §J5 resolution pass below**, which records the decision taken in
each case. Nothing from §J5 remains open.

---

## §J6 — Stratum & share intake (2026-08-27, add-ons, NOT VPS-TESTED)

Sixth session of the pre-mainnet §J pass (see the Status roll-up at the top of this file).
Scope: [`lib/stratum-server.js`](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js)
(759), [`lib/stratum-protocol.js`](../../web/07_mining_pool_public/back-end-pool/lib/stratum-protocol.js)
(174), [`lib/node-stratum-client.js`](../../web/07_mining_pool_public/back-end-pool/lib/node-stratum-client.js)
(217), [`lib/shares.js`](../../web/07_mining_pool_public/back-end-pool/lib/shares.js) (103),
[`lib/hashrate-tracker.js`](../../web/07_mining_pool_public/back-end-pool/lib/hashrate-tracker.js)
(835), plus [`lib/miners.js`](../../web/07_mining_pool_public/back-end-pool/lib/miners.js) (285) —
which is not on the plan's list but holds the session object every guard in this subsystem reads,
so it could not be understood from outside. Questions asked: **can a miner forge share weight, and
can one connection exhaust the box?**

Read first, then confirmed by execution. Three one-shot harnesses bound the **real**
`StratumServer` / `MinerManager` / `ShareValidator` / `HashrateTracker` / `IncentivesManager` to an
in-memory `node:sqlite` DB carrying the production `miner_accounts`, `shares`, `miner_incentives`,
`miner_geo`, `pool_config` and `admin_audit_log` columns, with only `lib/db.js` and the upstream
`NodeStratumClient` replaced. Connections were driven through `handleNewConnection` with a socket
stand-in exposing exactly the surface that function uses, so the PROXY-v2 phase, the line splitter,
the token bucket, `handleLogin` and `handleSubmit` all ran unmodified. **34 assertions, all
confirmed.** No listener was opened, no VPS touched (plan rule 5); the harnesses lived in the
scratchpad and exited on their own.

**Headline — both answers are yes, and the second one needs no attacker at all.**

*Share weight is forgeable.* The pool's only anti-replay control is the `shares.share_hash` UNIQUE
constraint, and the value hashed into it includes **the worker name the miner types at login**
(J6-1). The 2026-07-17 hardening moved that key off the pool's `job_id` and onto the job's `pre_pow`
precisely because one solved `(nonce, pow)` must be credited once — but it left a second
miner-chosen field in the key, so the same solution re-submitted under a different rig label is a
new share. This is the *same* bug the earlier fix closed, re-entered through a different field.

*And the pool stops mining ten minutes after each rig connects.* `session.lastSeenAt` is written
once, at `createSession`, and **nothing anywhere in the codebase ever updates it** — `updateSession`
has zero call sites. The 60-second sweeper deletes every session older than ten minutes, including
one whose socket is open and actively submitting. After that the socket is still up, the rig is
still hashing, and every `submit` on it is answered *Session not found* and **never forwarded to the
node** — so a block solved on that connection is silently discarded (J6-2). Under the plan's tiering
this is the P0 item that must not reach mainnet, and it is not an attack; it is what the pool does
to itself on a quiet afternoon.

Both findings are one-line changes and were left for a decision at the time (plan rule 3). That
decision was taken the same week: **every finding in this section is now fixed** — see the
resolution pass appended after §J6-13.

### Threat actors used in this section

| Label | Means |
|---|---|
| **Anonymous** | Anyone who can open a TCP socket to `:3333`. Stratum login is unauthenticated by design — the address *is* the username — so "anonymous" and "registered miner" are separated here only by whether the attacker has done any proof of work |
| **Mining miner** | Anonymous, plus at least one share the node accepted. The bar every §J3 fix raised the evidence path to |
| **The system** | No attacker. A clock reaching ten minutes |
| **Logged-in admin** | A `freshAdmin` session hot-adding a region listener |

---

### J6-1 — [Critical] The share dedup key contains the miner's own worker name, so one solved share is credited once per label — PPLNS weight is forgeable at ≥11× with no assumptions about the node — **FIXED 2026-09-01**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J6-1).**

### J6-2 — [Critical] `lastSeenAt` is never refreshed, so every stratum session is deleted ten minutes after login while its socket keeps mining — after which the pool forwards nothing to the node and a found block is lost — **FIXED 2026-09-01**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J6-2).**

### J6-3 — [High] PROXY-protocol v2 is honoured on the public `:3333` listener, so any anonymous client picks the IP the pool records — and the per-IP connection counter leaks, permanently locking a shared NAT out of the pool — **FIXED 2026-09-01**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J6-3).**

### J6-4 — [Medium] A repeated `login` on one socket creates a new session and abandons the old one, so one connection can allocate sessions at the message rate — and every abandoned one inflates the public counters — **FIXED 2026-09-01**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J6-4).**

### J6-5 — [Medium] Nothing penalises a session that produces only rejects, so `:3333` is an unauthenticated 8,000/s amplifier onto the node's PoW verifier and onto the journal — **FIXED 2026-09-01**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J6-5).**

### J6-6 — [Medium] Any charset-valid string is accepted as a Grin address and gets a `miner_accounts` row at login — the bech32 checksum is never verified — **FIXED 2026-09-01**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J6-6).**

### J6-7 — [Medium] One accepted share still permanently rewrites a stranger's `donation_percent`, and it is cheaper than rotating that address's ownership proof — **FIXED 2026-09-01**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J6-7).**

### J6-8 — [Low] Blank frames are free — `continue` sits above the token-bucket spend, and the socket deadline resets on any byte — **FIXED 2026-09-01**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J6-8).**

### J6-9 — [Low] A login with no work behind it is published as an online worker on someone else's account page — **FIXED 2026-09-01**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J6-9).**

### J6-10 — [Low] `isValidJob` has no upper bound and accepts non-integers, so an out-of-range `job_id` silently falls back instead of being rejected — **FIXED 2026-09-01**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J6-10).**

### J6-11 — [Low] The nonce is un-quoted on the node wire by a first-match regex over the whole payload, and `forwardSubmit` passes the miner's `params` through verbatim — so a miner-chosen key decides what the node parses — **FIXED 2026-09-01**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J6-11).**

### J6-12 — [Low] `bindRegionListener`'s idempotency check reads `server.address()`, which is `null` until the listen completes, and a failed bind is reported as success — **FIXED 2026-09-01**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J6-12).**

### J6-13 — [Info] Verified correct, with evidence

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J6-13).**

### Handoffs

- **§J7 (DB layer)** — every write on the stratum path is parameterised, so there is nothing SQL-shaped
  here. What J7 owns is the *volume*: J6-4 and J6-6 both put unbounded synchronous writes on the
  shared `DatabaseSync` from an unauthenticated port, and `db.js` still has no `busy_timeout` (J5's
  handoff). The `shares` INSERT is also the only write in the hot path with no transaction around it
  ([shares.js:31–36](../../web/07_mining_pool_public/back-end-pool/lib/shares.js#L31)) — fine as a
  single statement, worth confirming against WAL contention.
- **§J11 (public API leakage)** — `/api/stratum/stats` truncates the address
  ([index.js:2158–2168](../../web/07_mining_pool_public/back-end-pool/index.js#L2158)) but publishes
  every live session's **worker name, difficulty, per-session accepted/rejected/stale and online
  seconds**, unauthenticated. Two questions for J11: does a worker label leak rig identity a
  truncated address was meant to hide, and is a live session list a mining-farm's operational
  intelligence? J6-9 is the injection half of the same endpoint.
- **§J12 (rate limiting)** — the levers found here are bucket-shaped and belong in J12's ledger.
  (1) The 25 msg/s × 320 conns budget is not a *pool* limit, it is a limit on how fast one address can
  drive the **node's PoW verifier and the journal** (J6-5). (2) There is no pre-login deadline, so the
  25,000-socket global ceiling is exhaustible with one byte per socket per nine minutes (J6-8).
  (3) Leaked sessions (J6-4) make two anonymous public GETs O(n) in the leak.
- **§J14 / §J15 (front ends)** — the render half of the worker-name trace. The label is safe at the
  source (charset-limited, 32 chars — 25 until 2026-09-21) and reaches the browser via `/api/account/:addr` workers and
  `/api/stratum/stats`; both surfaces can carry an attacker-chosen label for an address the attacker
  does not own (J6-9), so the question for J14/J15 is whether either page presents a worker row as
  something the account holder configured.
- **§J16 (deployment)** — three things from this session's files that the shell side owns. (1) The
  public listener binds `0.0.0.0` unconditionally
  ([stratum-server.js:167](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L167))
  while region listeners bind `region_listen_host` — confirm the firewall is what separates them.
  (2) J6-3's fix does not remove the need for the edge to be the only thing that can reach the region
  ports. (3) Re-pairing a gateway updates `config.region_listen_host`
  ([index.js:5865](../../web/07_mining_pool_public/back-end-pool/index.js#L5865)) but already-bound
  listeners keep the old host, so a tunnel-IP change silently leaves listeners on the old address —
  same family as J6-12.
- **§J17 (operational gate)** — four things only a testnet run can settle. (1) **J6-2 is the first
  thing to look for**: connect a rig, wait fifteen minutes, confirm shares still count. It will be
  obvious and it will look like a network fault. (2) J6-1's multiplier beyond ~11× depends on whether
  grin's stratum keeps a per-`(block version, nonce)` cache; the ≥11× floor does not, but the true
  ceiling should be measured. (3) J6-11's tail risk — send grin's stratum a submit with a
  type-invalid field and observe whether it answers with an error or drops the connection. (4) The
  1000-miner load test memory `project_pool_stratum_hardening` already flags as outstanding: the
  single upstream socket, not the connection caps, is the bottleneck.

---

### Verification

Every finding was written from reading first and then confirmed or refuted by execution; nothing
above rests on inference alone, and the four hypotheses that came back **refuted** on the first run
were corrected rather than reported (two were flaws in the harness — an incomplete `pool_config`
schema and an off-by-one in a distinct-address count; one was a burst budget the token bucket
correctly cut off, which is the guard working; one was a `job_id` value that genuinely does fail the
window test).

Three harnesses, all one-shot `node` processes that exited on their own — no server, no listener,
nothing left running (CLAUDE.md *Local Test Processes*), all under the session scratchpad and outside
the repo. They bound the **real** `lib/stratum-server.js`, `lib/miners.js`, `lib/shares.js`,
`lib/stratum-protocol.js`, `lib/hashrate-tracker.js` and `lib/incentives.js` to an in-memory
`node:sqlite` DB by replacing only `lib/db.js` in the require cache, and drove them through
`handleNewConnection` with a socket stand-in exposing `remoteAddress`, `setKeepAlive`, `setTimeout`,
`write`, `destroy`, `destroyed` and the `data`/`close` events — so the PROXY-v2 phase, the line
splitter, the token bucket, `handleLogin` and `handleSubmit` all ran unmodified.

- **Probe 1 — 18/18** confirmed: the session-prune chain end to end (J6-2, six assertions), repeated
  login (J6-4), PROXY-v2 spoofing and the counter leak (J6-3), checksum-free account creation (J6-6),
  blank-frame bucket bypass (J6-8), the `donate100` write (J6-7), `isValidJob` bounds (J6-10).
- **Probe 2 — 9/9** confirmed: 120 garbage submits relayed with a log line each and no penalty (J6-5),
  zero-work worker injection (J6-9), the first-match nonce regex (J6-11).
- **Probe 3 — 7/7** confirmed: the worker-name dedup multiplier with its same-label control (J6-1).

Static evidence used where execution cannot reach: `updateSession` has zero call sites
(repo-wide `grep`, `node_modules` excluded) — that is what makes J6-2 unconditional rather than
timing-dependent. The gateway's PROXY destination is read from
[`07_lib_gateway.sh:74`](../../scripts/lib/07_lib_gateway.sh#L74) and
[`:351–353`](../../scripts/lib/07_lib_gateway.sh#L351), which is what establishes that no legitimate
PROXY header ever arrives on `:3333`. Rate figures (8,000 submits/s, ~4.8M leaked sessions, ~1 MB/s
of journal) are derived from the configured limits — `MSG_RATE_PER_SEC = 25`,
`max_connections_per_ip = 320`, `max_stratum_connections = 25000`, the 600 s prune — and are **not**
measured against a running pool.

**No code was changed in the REVIEW session.** J6-1 and J6-2 are each a one-line edit but both change
live mining behaviour on the money path, and J6-2 is coupled to J6-4 (refreshing `lastSeenAt` without
closing the abandoned session converts a bounded leak into a permanent one), so the two had to land
together. J6-3, J6-5, J6-8 and J6-9 are small and independent; J6-6 needed a bech32 implementation and
a decision about where the account row is created; J6-7 needed an operator call on what a donate tag
should cost; J6-11 and J6-12 are refactors of a mechanism, not patches to it. **All twelve were
applied in the resolution pass below**, which follows this section.

---

### §J6 — resolution pass, 2026-09-01 (add-ons, NOT VPS-TESTED)

All twelve findings closed, and the two Critical ones landed together as the finding required.
`npm test` is green at **206 assertions** — `scripts/test-stratum-guards.js` grew from 12 to 47 —
plus **34 more** from two one-shot behavioural harnesses that drove the real handlers (28 through
`handleNewConnection`, 6 through `bindRegionListener`) and then exited. No VPS, nothing left
listening.

#### What was applied

| # | Fix | Where |
|---|---|---|
| J6-1 | `workerName` **removed from the dedup key**; it stays a parameter and stays in `shares.worker_name` as attribution | `lib/shares.js` |
| J6-2 | New `touchSession()`, called from the stratum message loop on every accepted frame | `lib/miners.js`, `lib/stratum-server.js` |
| J6-3 | PROXY-v2 phase **skipped on the public listener**; the per-IP counter keyed on a frozen `cappedIp` | `lib/stratum-server.js` |
| J6-4 | `handleLogin` closes the session the socket already holds before creating the next one | `lib/stratum-server.js` |
| J6-5 | `MAX_CONSECUTIVE_REJECTS = 50` disconnect + a per-session, per-key warn throttle | `lib/stratum-server.js` |
| J6-6 | **bech32 checksum verified** (BIP-173 polymod, ~30 lines, no dependency) | `lib/stratum-protocol.js` |
| J6-7 | Donate tag costs `PROOF_MIN_SHARES` and can only be **lowered** on a non-empty slot; `setDonation` checks `incentives_enabled` too | `lib/stratum-server.js`, `lib/incentives.js` |
| J6-8 | Blank frames spend a token; a 60 s **pre-login deadline** | `lib/stratum-server.js` |
| J6-9 | `acceptedShares > 0` filter on the live-session merge, matching §J3-2 | `lib/hashrate-tracker.js` |
| J6-10 | `isValidJob` asks `jobIdMap` — bounded both ways, integers only; both dedup fallbacks deleted | `lib/stratum-server.js` |
| J6-11 | Node payload built from **five whitelisted, type-checked fields**; nonce placed via an injected placeholder | `lib/stratum-server.js`, `lib/node-stratum-client.js` |
| J6-12 | Synchronous `boundPorts` claim + a real `_listen` callback; the panel stops claiming "listener live" | `lib/stratum-server.js`, `index.js`, `admin-panel/regions.html` |

#### J6-1 — the one-line fix, and the test that was missing

`generateShareHash` now hashes `address-pre_pow-nonce`. The parameter stays so call sites and the
existing test signature do not move, with a comment saying it is deliberately unhashed.

The more important half is what went into `test-stratum-guards.js`. Its original six dedup
assertions all **held the worker name constant**, so they passed throughout the vulnerable period —
a suite can only catch what it varies. Every new assertion in this pass **asserts a denial**: two
labels produce one hash, seven labels produce one hash, and the address still separates two miners
sharing a label (which is what the worker name was wrongly credited with doing). End to end through
the real handlers, one solution submitted under eight rig labels is now credited **once**, with a
control proving a genuinely different nonce is still credited.

#### J6-2 + J6-4 — landed together, as the finding said they had to

`touchSession()` sits in `processLines`, **after** the token bucket and **after** the blank-line
skip. Three properties that the placement, not the function, provides:

1. **A keepalive counts.** `status` and `getjobtemplate` refresh the session, so a rig between
   shares is not reaped. Putting it in `handleSubmit` would have left a slow rig dying quietly.
2. **A flood cannot buy immortality.** Below the bucket, so refused messages do not extend a
   session; below the blank-line skip, so a lone newline does not either (which is J6-8's fix
   doing double duty).
3. **The sweeper still works.** Verified with a control: a genuinely idle session is still pruned.
   The fix must not turn a leak-bounding mechanism off, and J6-4 is exactly why — without the
   re-login close, refreshing `lastSeenAt` would have converted the abandoned-session leak from
   ten-minute-lifetime into permanent. `handleLogin` now takes the `getSession` accessor
   `handleMessage` already had and closes the prior session first: 50 logins on one socket leave
   **one** live session, and closing the socket reclaims it.

#### J6-6 — the risky change, and how it was de-risked

Adding a checksum check to the login path is the one edit here that could refuse **every** miner if
the algorithm were wrong. A Grin Slatepack address is `bech32::encode(hrp, pubkey.to_base32())`
using the **classic** bech32 constant (grin-wallet pins the `bech32` 0.7 crate, which predates the
bech32m split), which is also what the 58-character data part implies: 52 symbols + 6 checksum.

Three independent checks, all in the committed suite:

- the six **BIP-173 official valid vectors** verify, including the `?` and 83-character hrp cases;
- the three **BIP-173 invalid-checksum vectors** are refused;
- a bech32 encoder written from the spec **inside the test** generates real-shape `grin1`/`tgrin1`
  addresses, which are accepted with their worker and `donateN` suffixes intact, while a
  single-character corruption of the same address is refused.

One caveat is deliberately left open for §J17: no *real* grin-wallet address was available on this
machine to check against. The vectors and the independent encoder make that a formality rather than
a risk, but the testnet run should log in with an address a real wallet printed before mainnet.

`ensureMinerExists` was **not** moved out of `handleLogin`, which the finding offered as a second
option. With the checksum verified, an attacker can no longer mint distinct addresses at will — they
would have to compute valid checksums, which is trivial, so the row-creation cost is reduced but not
removed. Moving it to the share path is the fuller fix and is a schema-ordering question
(`shares` has an FK to `miner_accounts`); it is handed to §J7 rather than done here.

#### J6-7 — the rule chosen, and why it is not "require ownership proof"

Two conditions now guard the donate tag: `PROOF_MIN_SHARES` (the same bar as rotating an ownership
proof, which the finding pointed out was the *more* expensive of the two), and **a stored non-zero
value may only be LOWERED**. So:

- an address setting its first donation still works with no ceremony;
- a stranger can only ever *reduce* someone's donation, which costs the victim nothing;
- the victim can always clear a tag with `.donate0`, which is the only remedy that exists (there is
  no HTTP route that writes this field — stratum is the sole writer).

Calling `verifyOwnerProof` from the share path was considered and rejected: it registers failures
against the (address, IP) lockout counters that the HTTP gate shares, so a rig re-presenting its own
tag could have thrown the real owner into a lockout. A guard that can lock out the person it
protects is worse than the thing it guards.

`setDonation` also now checks `incentives_enabled`, matching `donationsActive()`. An operator who
has switched incentives off no longer silently banks percentages that all activate at once when
they switch them back on.

#### J6-11 — the whitelist is the fix; the placeholder is the belt

`handleSubmit` builds `{ edge_bits, height, job_id, nonce, pow }` and type-checks every one of them
(numbers, finite, `pow` an array of finite numbers) before anything crosses to the node. The pool
still does **not** judge the solution — the node stays the authority on the PoW — but every value
here is re-serialised onto the single upstream socket **all** miners share, so shape is the pool's
business even when validity is not.

`_serialize` then substitutes a placeholder this module injected rather than pattern-matching miner
data, so the old first-match regex cannot be steered by a decoy `nonce` key. Both halves are tested,
including the decoy, and a `pow` element containing the placeholder literal is refused before it
reaches the node.

#### J6-12 — a claim the operator can act on

`boundPorts` is claimed **synchronously** at `_listen` entry and released on error, so the
idempotency check can no longer race a bind in flight — verified by issuing a second
`bindRegionListener` for the same port *before* the first settles. `_listen` takes a `done` callback
that fires exactly once, `bindRegionListener` returns a Promise carrying the real outcome, the route
awaits it, and `admin-panel/regions.html` now says the listener did not bind instead of
**"Region saved and gateway paired — listener live, no restart needed."** That sentence was the
finding: it was printed unconditionally, for an asynchronous bind nobody waited on.

#### Self-review of this pass — what the fixes did to each other

1. **J6-8 nearly broke J6-2.** Moving the blank-line skip below the token bucket also moved it
   relative to where `touchSession` wanted to sit. Placed above the skip, a single newline every
   nine minutes would have kept a session alive forever — reintroducing the J6-8 slot-squat *inside*
   the J6-2 fix, on a session object rather than a socket. The touch is below both.
2. **J6-10 changed what "stale" means for a string `job_id`.** `isValidJob` now requires an integer,
   and the old arithmetic form accepted `'5'` by coercion. That path was already broken — the map
   lookup missed, so the submit was forwarded with the *miner's* untranslated id and the node staled
   it — but it failed silently rather than loudly. `handleSubmit` now coerces a string `job_id` to a
   number once, before validation, so an unusual client is translated correctly instead of getting a
   different flavour of stale.
3. **J6-5's ceiling had to exclude `stale`.** Counting stale submits toward a disconnect would fire
   on every rig each time a new job landed mid-flight — an availability bug wearing a security fix's
   clothes. Only `rejected` counts, an accepted share resets the run, and there is an assertion for
   each.
4. **`stop()` had to release `boundPorts`.** Without it a restart in the same process is refused by
   its own idempotency check — caught by the bind harness, not by reasoning.

#### Behaviour an operator will notice

1. **Shares keep counting past ten minutes.** This is the whole of J6-2 and it needs no attacker to
   observe: before the fix the pool went quiet ten minutes after each rig connected and discarded any
   block found after that.
2. **A mistyped address is now refused at login** with the existing "Invalid login" message rather
   than silently mining to an unspendable key. A miner who has been mining to a typo'd address will
   suddenly be unable to connect — which is the correct outcome, and worth saying in release notes.
3. **A rig submitting only rejects is disconnected** after 50 in a row, and the log stops repeating
   itself: one line per minute per session with a `[+N suppressed]` count.
4. **A connection that never logs in is dropped after 60 s.**
5. **`donateN` takes four accepted shares to apply**, not one, and cannot raise a donation already on
   record. Lowering — including `donate0` — still applies immediately at that same threshold.
6. **Region pairing reports a failed listener bind** instead of claiming success.

#### Handoffs changed by this pass

- **§J7** — `ensureMinerExists` is still on the login path (see J6-6 above); moving it to the share
  path is J7's call, together with the missing `busy_timeout` and the write-volume question J6-4 and
  J6-6 raised. The volume itself is much lower now: re-login no longer allocates, and junk addresses
  no longer INSERT.
- **§J11** — unchanged and still owed: `/api/stratum/stats` publishes every live session's worker
  name and counters unauthenticated. J6-9 removed the *injection* half (a zero-work session no longer
  appears), but the leakage question about real sessions stands.
- **§J12** — two of the three levers are closed here (the reject amplifier, the pre-login squat).
  What remains for J12 is whether 25 msg/s × 320 connections is the right budget at all.
- **§J17** — three additions, all cheap and all on the first testnet run: **(1)** log in with an
  address a real grin-wallet printed, to confirm the checksum check accepts production addresses;
  **(2)** connect a rig and wait fifteen minutes, confirming shares still count — the J6-2 regression
  test that only a real run can do; **(3)** confirm no legitimate rig ever hits 50 consecutive
  rejects during a job change storm. J6-1's multiplier ceiling and J6-11's node-side behaviour
  remain as previously listed.

---

### §J5 — resolution pass, 2026-08-27 (same day, add-ons, NOT VPS-TESTED)

All eleven findings closed. Six were fixed during the review session itself (J5-2, J5-4, J5-5,
J5-6, J5-7, and the reporting half of J5-1); this pass closes the five that were deliberately
left open as decisions rather than patches. `npm test` is green at **178 assertions** —
`scripts/test-block-ledger.js` grew from 20 to 52.

#### What was applied

| # | Fix | Where |
|---|---|---|
| J5-1 | `blocks.nonce` is now **TEXT**, bound as `String(nonce)`; a pure-SQL migration rebuilds a legacy INTEGER column | `lib/db.js`, `lib/blocks.js` |
| J5-3 | **One shared comparator**, hash-first, in a new `lib/block-identity.js`; both readers call it and neither compares inline any more | `lib/block-identity.js` (new), `lib/rewards.js`, `lib/orphan-detector.js`, `lib/block-monitor.js` |
| J5-8 | New `distribution_stalled` detector on the fast loop — the first alert that watches for money *not* moving | `lib/alert-monitor.js` |
| J5-9 | `confirm_depth_*` wired into `applyToConfig` **with** validators; mainnet floored at 1440 | `lib/pool-settings.js`, `admin-panel/settings-payout.html` |
| J5-10 | The real coinbase (60 emission **+ block fees**) is captured at found-time into `blocks.reward`, with the split kept in a new `blocks.fees` column | `lib/blocks.js`, `lib/db.js`, `lib/stratum-server.js`, `index.js`, `lib/pool-settings.js` |
| J5-11 | The orphan reversal reaches **locked** balance, records real locked snapshots, and raises `orphan_clawback_locked` | `lib/orphan-detector.js` |

#### J5-1 — the migration is the risky half, so it is pure SQL

The schema change is trivial (`INTEGER` → `TEXT`, plus `String(nonce)` at the one bind site).
The migration is not, and it has one non-obvious constraint: **the rows that need migrating are
exactly the rows that cannot be read.** A read-modify-write loop would throw
`ERR_OUT_OF_RANGE` on the first poisoned row and migrate nothing. `migrateBlocksNonceToText`
([db.js](../../web/07_mining_pool_public/back-end-pool/lib/db.js)) therefore does the whole copy
inside SQLite — `INSERT INTO … SELECT CAST(nonce AS TEXT) …` — and never materialises a JS
number. `PRAGMA foreign_keys` is toggled outside the transaction (it is a no-op inside one), and
the toggle was verified to actually work through `sqlite-compat`'s `pragma()` wrapper rather than
being assumed.

The three storage classes get three different treatments, and the middle one is the good news:

| stored as | why | migrated to |
|---|---|---|
| `integer` (`< 2^63`) | the digits were always there, only unreadable | **exact** digits — nothing was ever lost |
| `real` (`>= 2^63`) | destroyed at INSERT: a u64 that large does not fit a signed 64-bit int, so SQLite stored a double | `''` |
| `text` | already migrated | unchanged |

Writing the rounded rendering back for the REAL rows would have been worse than blanking them:
`'9.22337203685478e+18'` parses to a *different* double than the node's own rounding of the same
nonce, so it would compare unequal and orphan a live block. `''` reads as `unknown` to the
comparator — never a mismatch — and those rows still verify by hash, which survived intact.
Tested end-to-end against a table rebuilt in its pre-§J5 shape, including a CONTROL asserting
that table really does throw before the migration runs.

#### J5-3 — the decision taken: hash is authoritative, the nonce is a fallback

The finding left this as a call to make. It is made: `lib/block-identity.js` compares by **hash
whenever both sides can supply a 64-hex value**, and consults the nonce only when they cannot.
Three properties, each of which was a bug before:

1. **One function, two callers.** `rewards.js` and `orphan-detector.js` had drifted into
   different comparisons and only one of them was destructive. They now share this and neither
   compares inline. `verifyBlockOnChain` takes the whole block row rather than a bare nonce,
   which is what let the hash into the orphan path at all.
2. **The nonce fallback normalises BOTH sides through the same rounding** (`Number(a) ===
   Number(b)`). This looks exactly like the precision bug it prevents, so it carries a comment
   saying so. It also accepts a `'12345.0'` tail, because `node:sqlite` binds every JS number as
   a double and any caller passing a number rather than `String(nonce)` lands that in a TEXT
   column — rejecting it would fail closed on a perfectly good block.
3. **A third verdict: `unknown`.** Previously every comparison was binary, so "we cannot tell"
   collapsed into "mismatch" — the same root error as §J5-2 and the original message-matching
   bug. `unknown` now has its own branch: `rewards.js` refuses to credit (fail closed) and
   `orphan-detector.js` throws rather than orphaning.

**Behaviour change worth knowing:** a matching hash is now authoritative and a differing nonce
does **not** veto it. That is correct — the nonce is an input to the hash, so "same hash,
different nonce" cannot occur on a real chain — but it retires a `test-money-path.js` assertion
that had been asserting the impossible. It was replaced with three cases that test what the
fallback is actually for: the nonce leg still rejects a mismatch when the hash is not comparable,
and a block comparable by neither is refused rather than credited.

#### J5-10 — fees are read from the block's kernels, at found-time

`_fetchBlockFees` sums the `fee` field across the block's kernels (coinbase kernels carry 0, so a
bare sum is right) and `creditBlock` stores `60 + fees` as the reward, keeping the fee portion in
the new `blocks.fees` column so the split stays visible. Two deliberate choices:

- **Found-time, not maturity-time.** `get_block` returns the block *body*, which a pruned node —
  the standard deployment — serves only inside its pruning horizon. At maturity, 1440 blocks
  later, it may be gone; a block submitted seconds ago is certainly there.
- **Hash-gated and best-effort.** A race at the tip can hand back a competitor's block at the
  same height, so the fees are trusted only when the node's header hash is *our* hash. Anything
  else logs and falls back to the flat 60 — the pre-existing behaviour — so this can never block
  a block from being credited.

The public terms copy now states that a block's reward is emission **plus** that block's
transaction fees and that both are split by the same PPLNS shares. Previously neither the code
nor the copy admitted fees existed.

#### J5-8 — the first detector that watches for money *not* moving

`checkDistributionStalled` fires on two distinct shapes: a block still `'immature'` more than
**twice** `confirm_depth` below the pool's own view of the tip (the maturity sweep is not
completing), and a block `'confirmed'` but undistributed for over 30 minutes — ~60 missed
distribution ticks (distribution is failing). It reports the uncredited GRIN total and points at
the log line to look for.

Three design notes:

- **Warning-level escalation, never a freeze.** Freezing payouts would punish miners for a fault
  that is already withholding their money, and the condition is legitimately transient during a
  node outage — hence the full extra `confirm_depth` of slack on the immature side.
- **The tip comes from `MAX(shares.block_height)`, not from the node.** This check must keep
  working while the node is unreachable, which is one of the states it exists to report.
- **It rides the fast loop, not the money cadence.** Two indexed counts, no wallet call.

#### J5-9 — wired up rather than deleted, with consensus as a hard floor

Both keys now reach `config` through `applyToConfig`, and both have validators — mainnet refuses
anything below **1440**, because that is Grin's `COINBASE_MATURITY` and not a pool preference;
testnet is deliberately allowed lower so a test run can exercise the payout pipeline without
waiting a day per block. `applyToConfig` also coerces defensively and keeps the existing value
with a warning if a below-floor number is somehow already stored, since it runs against values
written before the validator existed. The two form rows now say which of the two they are and
that the value applies on backend restart.

#### J5-11 — the reversal reaches locked funds, and says so loudly

`reverseBlockPayouts` now takes from spendable first and from `balance_locked` for the remainder,
writes the real `locked_before`/`locked_after` snapshots, and raises a **critical**
`orphan_clawback_locked` alert naming the address and amount whenever it has to touch locked
funds — because that means a payout is in flight for money that has just been reversed, and
`locked_owed` has diverged from the pending-withdrawal total. A residual shortfall (the GRIN has
already left the pool) gets its own critical log line rather than being absorbed silently. The
clamp against driving a balance negative stays.

The scheduler still owns the withdrawal state machine, so this deliberately does **not** cancel
the in-flight row — it alerts and leaves that to the operator. Part (a) of the finding, that
nothing can reverse a block orphaned *after* distribution, remains an accepted risk and is now
written into *Residual / accepted risks* rather than left implicit.

#### Self-review of this pass, same day — three things the fixes did to each other

1. **J5-3's `unknown` re-created §J5-1's stall in a new costume.** Throwing on an unverifiable
   block aborted the *entire* sweep, so one legacy row whose nonce the old column had destroyed
   would have held up maturity for every other block indefinitely — the same "one poisoned row
   kills the query" shape the whole finding was about, one layer up. **Fixed:** the error carries
   `err.unverifiable = true`, and both callers skip that block and keep sweeping, while
   node-level failures still abort as they must. `detectOrphans` reports an `unverifiable` count
   so the skip is visible rather than silent. Tested both ways, with a CONTROL asserting a
   node-level failure still aborts.
2. **J5-10 put a third serial RPC on the block-found path**, which is awaited *before* the
   miner's submit ack is written — up to 20 s of dead air on an unreachable node instead of 10.
   **Fixed:** the difficulty and fee fetches now run in one `Promise.all`, which leaves the worst
   case at 10 s — better than the pre-§J5-10 code managed with the difficulty fetch alone.
3. **The first attempt at J5-9's validators added a second `payout:` key to the same object
   literal.** The existing one would have silently won and the new validators would never have
   run — a duplicate key is not a syntax error. Caught before it shipped; merged into the real
   block instead. Worth stating because the same object has three `payout:` sections across
   defaults/validators/help and the next author will meet the same trap.

**Also corrected while testing:** `test-money-path.js` bound its fixture nonce as a JS *number*,
which `node:sqlite` renders into a TEXT column as `'12345.0'` — not the shape production writes.
Fixtures now bind `String(nonce)`, and the comparator tolerates the `.0` tail regardless.

#### Behaviour an operator will notice

1. **A found block now logs its real reward**: `reward=60.023 GRIN (60 emission + 0.023 fees)`,
   or `(60 emission, fees unread)` when the node could not be reached. Miner credits are
   correspondingly slightly larger than the flat 60 they used to be.
2. **A new critical alert, `distribution_stalled`**, appears if blocks stop being credited — with
   the uncredited GRIN total and the log line to grep for. It resolves itself once the blocks
   settle. This is the alert whose absence let §J5-1 look like a healthy pool.
3. **Saving the payout settings with a mainnet confirm depth below 1440 is now refused** with a
   message naming `COINBASE_MATURITY`. The value also takes effect for the first time, on
   restart — previously it was accepted, stored, read back and ignored.
4. **On first start against an existing testnet DB**, the log carries a one-time
   `[db] blocks.nonce is INTEGER; rebuilding as TEXT` line, and — if any block was stored with a
   nonce at or above 2^63 — an error line saying those nonces are unrecoverable and will verify
   by hash. Both are expected once and never again.
5. `GET /api/admin/blocks` now returns `fees` alongside `reward`.

#### Handoffs changed by this pass

- **§J17** — the hash/nonce observation is now *more* load-bearing, because the hash is the
  primary comparator rather than an optional extra. Confirm on the testnet run that
  `blocks.hash` (parsed from the stratum `blockfound - <hash>` reply) equals
  `get_header(h).hash`. If it does not, every block will log the "verified by NONCE only"
  warning — which is the designed fallback, but it means the pool is running on the weaker
  check. Also capture one `get_block(h).kernels` payload to confirm the `fee` field shape J5-10
  sums.
- **§J7** — the "which other INTEGER columns hold chain data" sweep still stands and is now the
  only unaddressed part of J5-1's class. `blocks.nonce` is fixed; `total_difficulty` from the
  node is the obvious next candidate. The missing `busy_timeout` also still stands.
- **§J6, §J9** — unchanged from the §J5 handoff list.

---

## §J7 — DB layer, SQL & amount arithmetic (2026-09-01, add-ons, NOT VPS-TESTED)

Seventh session of the pre-mainnet §J pass (see the Status roll-up at the top of this file).
Scope: [`lib/db.js`](../../web/07_mining_pool_public/back-end-pool/lib/db.js) (1273),
[`lib/sqlite-compat.js`](../../web/07_mining_pool_public/back-end-pool/lib/sqlite-compat.js) (80),
**and every call site** — which for this session meant a mechanical sweep of all 39
`db.transaction(` sites, every `prepare(` carrying a template literal, every `LIMIT ?` / `OFFSET ?`
binding, every `parseInt` / `parseFloat` applied to request input, and every statement that moves a
balance. Questions asked: **any unparameterised SQL, dynamic `ORDER BY`, or float arithmetic on
nanogrin?**

Read first, then confirmed by execution. Five one-shot `node:sqlite` harnesses ran in the
scratchpad and exited on their own — a two-connection lock test against a real file DB, a
`LIMIT`/`OFFSET` binding matrix, a replay of `getSection()`'s row loop, an `Infinity`-through-a-REAL-column
test, and `EXPLAIN QUERY PLAN` against the verbatim `shares` DDL with **no `ANALYZE`** (memory
`project_pool_db_capacity`: production has no `sqlite_stat1`, so a locally-analysed plan is a plan
the pool never sees). No server was started, no VPS touched (plan rule 5).

**Headline — the SQL is clean; the arithmetic and the locking are not.**

*The SQL surface is genuinely clean.* Eleven interpolated SQL fragments exist and **every one is a
code-controlled literal** — column names from a `_clean()` allowlist, a `PENDING_SQL` constant,
generated `?` placeholder lists, a fixed table name. Nothing a request can reach is concatenated
into a statement, and there is **no dynamic `ORDER BY` anywhere in the backend** (`AdminTable`
sorts and pages client-side — memory `project_pool_admin_table`). The single dynamic fragment ever
chosen by a request value, `?direction=`, was already found and hardened as §J3-7.

*But there is no `busy_timeout`, and there is a cron that takes an exclusive lock on the live
database.* `initDb` sets `journal_mode=WAL` and `foreign_keys=ON` and stops there, so SQLite's
default of **0 ms** applies: contention is an instant `SQLITE_BUSY`, never a wait. Script 07's own
hub screen steers the operator into a weekly `sqlite3 pool.db "VACUUM;"` cron, which holds the
write lock for its whole run. Every money write in that window fails immediately — and the
block-found write **throws its own failure away** and is never retried, so the pool can mine a
block, receive the reward in the wallet, credit nobody, and report itself healthy to every
dashboard and alert it has. That is J7-1, and it is the P0 item from this session.

*And money is an un-quantised IEEE double from credit to withdrawal.* Balances are `REAL` GRIN,
credited as `minerReward × (share/total)` with no rounding onto the nanogrin grid, so a stored
balance routinely carries ~14 decimal places. The account page's **"max" chip** sends
`balance.toFixed(9)`, which rounds to *nearest* — and across 399 simulated realistic balances it
lands **above** the stored value 188 times (47%). The payout CAS is `WHERE balance >= ?`, so those
188 attempts are refused with *"insufficient balance"* while the page is displaying exactly that
balance. The overshoot is under one nanogrin: the pool refuses a payout over an amount Grin cannot
express (J7-3).

Eight findings. **Four were fixed in this session** (J7-2, J7-4, J7-5, J7-6 — all small and local,
plan rule 3). Four are left open as decisions: J7-1 because the complete fix spans the shell
installer (§J16), J7-3 because the sound repair is a money-guard change rather than a patch, J7-7
because it is a query redesign that needs its own money-path test pass, and J7-8 because
`pool-settings.js` belongs to §J9, which already holds the matching handoff from §J1-6.

### Threat actors used in this section

| Label | Means |
|---|---|
| **Anonymous** | Any client that can reach a public `/api/pool/*`, `/api/public/*` or `/api/account/*` GET. No proof of work, no session |
| **Logged-in admin** | A `secureAdmin` or `freshAdmin` session. Already able to move money, so findings here are integrity/robustness, never escalation |
| **The system** | No attacker. A cron job, a full disk, a restart, a rounding mode |

---

### J7-1 — [High] `initDb` sets no `busy_timeout`, the toolkit steers the operator into a weekly `VACUUM` cron that locks the live DB, and the block-found write discards its own failure — a block found in that window is lost, with no alert anywhere — **OPEN**

**Threat actor: the system.** No attacker is involved; this is a self-inflicted fund-loss path.

Three facts, each individually defensible, that together lose a block.

**(1) The pool opens its connection with `busy_timeout = 0`.**
[db.js:15–17](../../web/07_mining_pool_public/back-end-pool/lib/db.js#L15) is the entire pragma
block:

```js
db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
```

Verified through the real shim on a real file DB: `journal_mode=wal`, `foreign_keys=1`
(and FK constraints do fire), `synchronous=2`, **`busy_timeout=0`**. Then, with a second
connection holding the write lock:

```
as lib/db.js opens it today (no busy_timeout):
  share INSERT while a second writer holds the lock: THREW ERR_SQLITE_ERROR database is locked   (waited 0 ms)
with PRAGMA busy_timeout = 5000:
  share INSERT while a second writer holds the lock: THREW ERR_SQLITE_ERROR database is locked   (waited 5507 ms)
```

The first line is today's behaviour: **no wait at all.** WAL removes reader/writer contention, not
writer/writer contention.

**(2) A second writer is a documented, operator-facing feature.**
[`07_grin_mining_public_pool.sh:2038–2040`](../../scripts/07_grin_mining_public_pool.sh#L2038)
writes this cron:

```
0 3 * * 0 root /usr/bin/sqlite3 $POOL_APP_DIR/pool.db "VACUUM;" >> $POOL_LOG 2>&1
```

`VACUUM` holds an exclusive lock on the whole database for its entire run — minutes on a
multi-gigabyte file. It is opt-in, but the pool's own hub screen
([`07_lib_hub.sh:25`](../../scripts/lib/07_lib_hub.sh#L25)) tells the operator *"File space is
reclaimed by the weekly VACUUM cron — see option C"*, and memory `project_pool_db_capacity` records
"VACUUM weekly still applies" as the reclamation plan. The break-glass CLI is a second such writer,
and its own comment — *"WAL means this is safe alongside the running service"* — is true only for
reads, for exactly this reason.

**(3) The block-found write swallows the failure, and nothing retries or notices.**
`BlockManager.creditBlock` wraps its INSERT in a try/catch that
[logs and returns `{success:false}`](../../web/07_mining_pool_public/back-end-pool/lib/blocks.js#L125):

```js
} catch (err) {
  console.error(`Error crediting block: ${err.message}`);
  return { success: false, error: err.message };
}
```

Its only caller **discards the return value entirely.**
[stratum-server.js:840–846](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L840)
puts a `try/catch` around the `await`, but `creditBlock` never throws — so the catch never runs,
`{success:false}` is dropped on the floor, and the very next statement writes
`createSubmitResponse(id, true, nodeResult.blockHash)` to the miner. There is no retry, no queue,
no re-derivation from the chain.

**Why nothing catches it afterwards.** §J5-8's `distribution_stalled` detector was built for
exactly this class of failure — but it reads `FROM blocks`
([alert-monitor.js:613–624](../../web/07_mining_pool_public/back-end-pool/lib/alert-monitor.js#L613)),
counting rows stuck in `'immature'` or `'confirmed'`. **A block that was never INSERTed has no
row.** The `coverage_surplus` companion that §J5-8 recommended was explicitly *not* implemented, so
the wallet excess is invisible too. The end state is indistinguishable from bad luck: as far as
every dashboard, alert and reconciliation report is concerned, the pool simply found no block.

**Scope beyond VACUUM.** The lock is the most concrete trigger, but the swallowed-error path is
open to every DB fault — `SQLITE_FULL` on a full disk, an I/O error, a corrupt page. The same shape
sits on the share path: `ShareValidator.submitShare` catches and returns `{success:false}`
([shares.js:44–48](../../web/07_mining_pool_public/back-end-pool/lib/shares.js#L44)) and the caller
reports the share **rejected** to the miner
([stratum-server.js:753–759](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L753)) —
honest to the rig, but it means a lock window silently erases PPLNS weight for every miner in it.
That one is at least visible as a reject count. The block is not visible at all.

This is the §J5-5 shape ("a swallowed DB error confiscates a block reward") re-entered on the
*earlier* half of the same pipeline. §J5-5 fixed the read; the write was never looked at.

**Recommended (not applied — the complete fix spans a file this session does not own).**

1. `db.pragma('busy_timeout = 5000')` in `initDb`, beside the other two. One line, but not free:
   `DatabaseSync` is synchronous and the stratum server shares this event loop (CLAUDE.md), so a
   5 s wait **blocks share submission for every connected miner** instead of failing one write.
   That trade is right for a money write and wrong for a dashboard query, and picking one number
   for both is an operator decision, not a patch.
2. Make `creditBlock`'s failure loud: have `handleSubmit` read the return value, log at
   `[CRITICAL]`, and raise an alert. A found block that could not be recorded is the most
   expensive event this pool can have and it currently produces one `console.error` line.
3. **§J16 owns the cron.** `VACUUM` against a live pool is the wrong shape whatever the pragma says
   — it should stop the service, vacuum, restart; or the schema should be created with
   `auto_vacuum=INCREMENTAL` and reclaimed with `PRAGMA incremental_vacuum`. A 5 s `busy_timeout`
   does not survive a two-minute exclusive lock.
4. **§J17 launch gate:** on the testnet run, find a block while `sqlite3 pool.db "VACUUM;"` is
   running and confirm it is either recorded or loudly reported. Cheap to stage, and the only way
   to prove the path.

---

### J7-2 — [Medium] `Math.min(parseInt(…), CAP)` has no lower bound, so `?limit=-1` is `LIMIT -1` — "no limit" — and defeats the row cap that is §C1's fix on two public money endpoints — **FIXED 2026-09-01**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J7-2).**

### J7-3 — [Medium] Balances are un-quantised doubles, so the account page's "max" chip asks for more than the stored balance about half the time and the payout CAS refuses it — over less than one nanogrin — **OPEN**

**Threat actor: the system.** A miner trying to withdraw their own money.

Money is stored as SQLite `REAL` in **GRIN**, not as integer nanogrin
([db.js:389–390](../../web/07_mining_pool_public/back-end-pool/lib/db.js#L389)), and the credit
path never rounds. [rewards.js:110–121](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L110):

```js
const poolFee     = block.reward * (this.config.pool_fee_percent / 100);
const minerReward = block.reward - poolFee;
const minerPayout = minerReward * (share.difficulty / totalDifficulty);
```

`minerPayout` is an arbitrary double — 59.4/7 is `8.485714285714286`, fourteen decimal places — and
`creditBalances` writes it verbatim. Balances therefore live *off* the nanogrin grid permanently.

Now the withdrawal round trip. The account page's max chip is
[account-settings.html:935](../../web/07_mining_pool_public/public_html/account-settings.html#L935):

```js
$id('acct-amt-max').dataset.v = Number(a.balance || 0).toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
```

`toFixed(9)` rounds to **nearest**, so it rounds *up* whenever the 10th decimal is ≥ 5. The server
then re-normalises to the same 9 places
([withdrawal-scheduler.js:694](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L694))
and hands it to a CAS that has no tolerance at all
([withdrawal-scheduler.js:725–730](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L725)):

```js
WHERE grin_address = ? AND balance >= ?
...
if (locked.changes !== 1) fail('insufficient balance', 409);
```

Simulating the credit arithmetic for 40 blocks across 2–400 equal-difficulty miners (there is no
vardiff, so `session.difficulty` really is a hardcoded `1.0` — §J5 handoff):

```
over 399 simulated balances (40 blocks credited, n=2..400 miners):
  max-chip amount > stored balance -> CAS refuses ("insufficient balance"): 188
  max-chip amount < stored balance (dust stranded)                        : 211
  exactly equal                                                           : 0
  worst overshoot: 4.922240393057109e-10 GRIN

examples that would 409:
  miners=3  balance=791.9999999999995      max-chip sends=792           (balance >= amt is false)
  miners=5  balance=475.1999999999999      max-chip sends=475.2         (balance >= amt is false)
  miners=7  balance=339.42857142857133     max-chip sends=339.428571429 (balance >= amt is false)
```

**47% failure, and the overshoot is smaller than one nanogrin** — the smallest unit Grin can
express. The miner sees a balance of 792, taps *max*, and is told they have insufficient balance
for 792.

Two aggravating details. The `createWithdrawal` path that *does* work — passing no amount, which
uses `acct0.balance` at full precision
([withdrawal-scheduler.js:690](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L690)) —
is unreachable from the UI: *"blank no longer means full balance — tap the max chip instead"*
([account-settings.html:1544](../../web/07_mining_pool_public/public_html/account-settings.html#L1544)).
And the codebase already knows about float tolerance where it chose to: `dormancy.manualPayout`
compares with `amt > r9(before) + 1e-9`
([dormancy.js:442](../../web/07_mining_pool_public/back-end-pool/lib/dormancy.js#L442)). The
withdrawal CAS, which is the one a miner actually meets, has no equivalent.

**Not fixed — this is a money guard, and every repair changes what it guarantees.** The three
candidates, with what each costs:

1. **Front-end only (cheapest, §J15's file):** make the max chip round *down* — `Math.floor(bal *
   1e9) / 1e9`. Fixes the 47% and strands at most 1 nanogrin. It does not fix an API caller that
   sends `toFixed(9)`, and it leaves the underlying representation alone.
2. **Quantise at credit time:** round every `balance_log`/`miner_accounts` write to 9 decimals.
   Correct at the source, but it changes the invariant `Σ credits == minerReward` that
   reconciliation and §J5-11's clamp both lean on, and it needs a migration story for existing
   balances. Structural.
3. **Tolerance in the CAS:** `balance >= ? - 1e-9`. One line, but it deliberately permits a
   sub-nanogrin overdraw, which is exactly the kind of edge §J4 spent a session closing. Would
   need `_netSend`'s floor re-checked against it.

Recommendation: **(1) now, (2) as the real fix before mainnet**, and never (3) on its own.
Handoff to **§J15** for the chip, and to **§J17** to confirm on testnet that a real miner can
withdraw their full balance in one action.

---

### J7-4 — [Low] A non-numeric `limit` or `offset` binds `NaN`, which `node:sqlite` rejects outright, turning a typo into a 500 that echoes the driver's message — **FIXED 2026-09-01**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J7-4).**

### J7-5 — [Medium] `isNaN()` is not a finiteness check, so `"Infinity"` passes every amount guard — and a `REAL` balance stores `+Inf` permanently, invisibly, and with the prize-pool overdraw guard switched off for good — **FIXED 2026-09-01**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J7-5).**

### J7-6 — [Medium] The break-glass admin-reset CLI still `require`s `better-sqlite3`, which the pool dropped and the installer no longer builds — so the documented 2FA-lockout recovery path cannot run on any installed pool — **FIXED 2026-09-01**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J7-6).**

### J7-7 — [Medium] `getSharesForDistribution` does `SELECT *` over the whole PPLNS window with an `ORDER BY` nothing uses, materialising it three times over in JS on the event loop the stratum server shares — **OPEN**

**Threat actor: the system.** Pool growth is the trigger.

[rewards.js:180–186](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L180):

```js
const stmt = this.db.prepare(`
  SELECT * FROM shares
  WHERE block_height >= ? AND block_height <= ?
  ORDER BY created_at ASC
`);
return stmt.all(windowStart, blockHeight);
```

`EXPLAIN QUERY PLAN` against the verbatim `shares` DDL, with no `ANALYZE` (production has no
stats — memory `project_pool_db_capacity`):

```
as written:                   SEARCH shares USING INDEX idx_share_block_height (block_height>? AND block_height<?)
                              USE TEMP B-TREE FOR ORDER BY
ORDER BY dropped:             SEARCH shares USING INDEX idx_share_block_height (block_height>? AND block_height<?)
aggregated in SQL:            SEARCH shares USING INDEX idx_share_block_height (block_height>? AND block_height<?)
                              USE TEMP B-TREE FOR GROUP BY
```

The index seek is fine. The `ORDER BY created_at` is **not used by anything** — `creditBalances`
folds the rows into a `Map` keyed by address, where order cannot affect the result — so the temp
b-tree sorts the entire window for nothing.

The materialisation is the real cost. There is no vardiff (`session.difficulty` is a hardcoded
`1.0`), so share volume scales linearly with pool hashrate. Using the pool's own C32 arithmetic —
one G1 ≈ 36 GPS, solutions/s ≈ GPS/42, PPLNS window 60 blocks ≈ 60 min:

```
  50 G1 miners ->   ~154,286 rows in the window  (~23 MB of JS objects)
 250 G1 miners ->   ~771,429 rows                (~116 MB)
1000 G1 miners -> ~3,085,714 rows                (~463 MB)
```

And it is built **three times**: the row array from `.all()`, then
[`distribution`](../../web/07_mining_pool_public/back-end-pool/lib/rewards.js#L113), which pushes
one object *per share*, then `new Set(shares.map(…))`. All synchronous, all on the event loop the
stratum server shares — so at every matured block, share submission stops for the duration. That is
the same mechanism as the `hashrate_history` incident in memory `project_pool_db_capacity`, and
that memory lists this exact query as an open fix from the 2026-07-16 capacity analysis; it has
never been written into this audit doc.

**Not fixed — the correct repair changes what `creditBalances` receives.** Replace the row dump
with the aggregate it actually needs:

```sql
SELECT grin_address, SUM(difficulty) AS total_difficulty
FROM shares WHERE block_height >= ? AND block_height <= ?
GROUP BY grin_address
```

That returns one row per miner (hundreds, not millions), drops the pointless sort, and moves the
`totalDifficulty` reduction into SQLite. It touches the distribution path, so it needs its own
test pass against `scripts/test-money-path.js` — hence a decision, not a patch. **Note the
interaction with J7-1:** the longer this read runs, the wider the window in which a concurrent
writer meets `busy_timeout=0`.

---

### J7-8 — [Low] `key in PoolSettings.defaults[section]` accepts `__proto__`, and the resulting row makes `getSection()` return operator-chosen values that `Object.keys`, `JSON.stringify` **and the §J1-2 audit diff** are all blind to — **OPEN**

**Threat actor: logged-in admin.** Robustness and auditability, not privilege.

§J1-6 found that both `PoolSettings.defaults[section]` and `key in
PoolSettings.defaults[section]` walk `Object.prototype`, and assessed the impact as *"confined to
junk rows"*. That assessment holds for the **section** half. It does not hold for the **key** half,
which this session tested, so this is a severity correction on an open item rather than a
re-report — J1-6 stays open and its recommended fix is unchanged.

[pool-settings.js:1339](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1339)
is the unknown-key gate:

```js
if (!(key in PoolSettings.defaults[section])) {
  throw new Error(`Unknown key '${key}' in section '${section}'`);
}
```

`'__proto__' in {…}` is `true`, so a `POST /api/admin/settings/payout` carrying a `__proto__` key
is accepted and INSERTed into `pool_config` against a **real** section. On read,
[getSection()'s row loop](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1093)
does `defaults[row.key] = JSON.parse(row.value)` — and assigning to `__proto__` on a plain object
**replaces that object's prototype**. Replaying the loop verbatim:

```
own keys after the write   : ["pool_fee_percent","min_withdrawal"]
JSON.stringify(section)    : {"pool_fee_percent":1,"min_withdrawal":25}
section.anything           : attacker
Object.prototype polluted globally?  undefined
changedKeys the audit row would record: []
```

So: the injected values are readable via `section.<key>`, but **invisible to `Object.keys`, to
`JSON.stringify`, and therefore to `GET /api/admin/settings/:section`**. Two things follow.

- **It is the one settings write that leaves no audit trail.** §J1-2 closed "settings writes are
  unaudited" by diffing the merged section and skipping the INSERT when `changedKeys.length === 0`
  ([pool-settings.js:1418–1428](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1418)).
  The diff runs over `Object.keys(afterState)` — which does not include a prototype write — so
  `changedKeys` is `[]` and **no `admin_audit_log` row is written at all.**
- **The value injection itself is currently inert, and I checked rather than assumed.** It can only
  supply keys a section has no own default for. Every key `applyToConfig` reads was compared
  against `PoolSettings.defaults` programmatically: **none is missing a default**, so nothing in
  the config merge can be shadowed today. `require_admin_totp`, `pool_fee_percent` and
  `min_withdrawal` are all own properties and unaffected. A string-typed `__proto__` row is a
  silent no-op (assigning a primitive to `__proto__` does nothing); only a `json`-typed one lands.

Low, therefore — but the audit blindness is a hole in a §J1-2 fix, not a junk row.

**Fix** (same one-liner J1-6 already recommends, applied to the key check as well):

```js
if (!Object.prototype.hasOwnProperty.call(PoolSettings.defaults[section], key)) {
```

`pool-settings.js` is **§J9's** file and J1-6 already handed it there; this finding is the evidence
for why that handoff should be treated as a required fix rather than tidy-up.

---

### J7-9 — [Info] Verified correct, with evidence

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J7-9).**

### J7-10 — [Info] Two smaller notes from the same sweep

**`express.json()` is mounted at the 100 KB default**
([index.js:228](../../web/07_mining_pool_public/back-end-pool/index.js#L228)), as the plan
suspected. Nothing validates a maximum length on `branding.custom_css`,
`analytics.custom_head_html`, `analytics.custom_body_html`, `pages.html` or `posts.body_html`, so
those are unbounded on the way *in* but capped at 100 KB by the parser. Two consequences, neither
a security issue: a long blog post or a pasted stylesheet fails to save, and it fails with
express's **HTML** `entity.too.large` page against a `fetch()` that expects JSON, so the admin
panel shows an opaque error rather than "too large". Worth an explicit
`express.json({ limit: '256kb' })` plus a JSON 413 handler; the settings-form harvester posting
*every* field in a section on every save (memory `project_pool_admin_settings_form`) makes the
branding section the likeliest to hit it.

**`migrateAdminAuditLog` is the only destructive migration in the schema.** It compares
`admin_audit_log`'s columns against a hardcoded set and `DROP TABLE`s on any mismatch
([db.js:33–50](../../web/07_mining_pool_public/back-end-pool/lib/db.js#L33), called first from
`createSchema` at [db.js:383](../../web/07_mining_pool_public/back-end-pool/lib/db.js#L383)). The
expected set matches today's DDL exactly, so nothing is wrong right now — but it means **adding one
column to the audit table, or rolling the pool back one version, silently destroys the entire
admin audit trail on the next restart**, which is exactly when a forensic question would be asked.
The comment justifies it with "the pool isn't in production"; that stops being true at mainnet.
Renaming to `admin_audit_log_legacy_<unixepoch>` instead of dropping costs nothing and keeps the
rows.

---

### Handoffs

- **§J9 (settings & config integrity)** owns the fix for J7-8, and this session raises its
  priority: the `in`-walks-the-prototype key check is not a junk-row nuisance, it is the one
  settings write that produces no `admin_audit_log` row. While in that file, the same pass should
  answer J7-10's length-cap question for `custom_css` / `custom_head_html` / `body_html`.
- **§J15 (public front-end)** owns the cheap half of J7-3: the max chip at
  `account-settings.html:935` must round **down** (`Math.floor(bal * 1e9) / 1e9`), not to nearest.
  Also worth checking there whether the *displayed* balance and the net-amount preview agree with
  what the CAS will accept.
- **§J16 (deployment)** owns two things this session found in the shell. (1) The weekly
  `VACUUM` cron at `07_grin_mining_public_pool.sh:2039` takes an exclusive lock on the live
  database — J7-1. It should stop the service around it, or the schema should move to
  `auto_vacuum=INCREMENTAL`. (2) The same cron is the reason `busy_timeout` alone is not a fix.
- **§J12 (rate limiting & resource exhaustion)** — J7-2's negative-limit dumps were also
  event-loop levers, and they are closed. What remains for J12 from this file: the two public CSV
  exports build a **50,000-row string in memory** on the synchronous path
  ([index.js:3527](../../web/07_mining_pool_public/back-end-pool/index.js#L3527),
  [3580](../../web/07_mining_pool_public/back-end-pool/index.js#L3580)) behind the `export`
  bucket — confirm that bucket's rate is sized for that allocation, not just for download spam.
- **§J17 (operational gate)** — three items only a run can settle. (1) **J7-1 is the one to
  stage**: find a testnet block while `sqlite3 pool.db "VACUUM;"` runs and confirm it is recorded
  or loudly reported. (2) **J7-3**: have a miner withdraw their exact full balance via the max
  chip; the 47% figure predicts this fails roughly every other time and it will read as a UI bug.
  (3) **J7-6**: run `grin-pool-admin-reset-<net> --list` on the box **before** enabling mandatory
  2FA — the fix is verified locally but has never run on a VPS, and it is the recovery path.
- **§J5's handoff list is now answered.** (1) `busy_timeout` — J7-1. (2) The "which other INTEGER
  columns hold chain data" sweep — **closed, none** (J7-9). (3) The nanogrin float question —
  answered in two parts: accumulation is exact to the nanogrin (J7-9), and the real defect is
  boundary rounding (J7-3).
- **§J6's handoff is answered too.** Every stratum-path write is parameterised, as J6 said. On
  volume: the `shares` INSERT is a single statement and needs no transaction — but with
  `busy_timeout=0` it is a single statement that can *fail*, and `submitShare` reports that failure
  to the rig as a reject (J7-1). Moving `ensureMinerExists` off the login path is not needed on DB
  grounds now that J6-6 stops junk addresses from INSERTing at all.

---

### Verification

- **`npm test` — full suite green**: `12 + 47 + 32 + 52 + 26 + 18` assertions plus 19
  ownership-gate checks = **206 passed, 0 failed**, before and after this session's four fixes.
- Every quoted output above came from a one-shot harness in the scratchpad, run against
  `node:sqlite` (`node v24.14.1`) and, where relevant, against the pool's **real**
  `lib/sqlite-compat.js`. All five exited on their own; no server was started and nothing was left
  running (CLAUDE.md local-process rule). The temp fixture DBs were deleted by the harnesses that
  made them.
- Nothing was run against a VPS. All eight findings are **add-ons, NOT VPS-TESTED**.
- **Gap worth stating:** no regression test was added for the J7-2/J7-4 clamps or the J7-5
  finiteness guards. Both are route-level and the existing suites are DB-level, so covering them
  needs an Express harness this session did not build. `grep -n "Math.min(parseInt(req.query.limit"
  index.js` returning nothing is the only standing check on J7-2.

### Changed this session

| File | Change |
|---|---|
| `index.js` | J7-2/J7-4 — all 14 `limit`/`offset` bounds moved onto `Math.min(Math.max(parseInt(x,10) \|\| D, 1), CAP)`; J7-5 — `Number.isFinite` on the inject, award and `pot_grin` amounts |
| `lib/incentives.js` | J7-5 — `manualTopup` rejects non-finite amounts, with the reason in the comment |
| `scripts/admin-reset.js` | J7-6 — driver switched from `better-sqlite3` to `lib/sqlite-compat`; `busy_timeout = 5000` added; the "WAL means this is safe" comment corrected per J7-1 |

**Left open at the end of this session:** J7-1 (needs a `busy_timeout` decision *and* §J16's cron
change — a partial fix would look like it closed the block-loss path and would not), J7-3 (a money
guard: front-end round-down now, credit-time quantisation as the real fix), J7-7 (a distribution
query redesign needing its own money-path test pass), and J7-8 (§J9's file, per §J1-6's handoff).

---

## §J8 — Secrets & key management (2026-09-01, add-ons, NOT VPS-TESTED)

Eighth session of the pre-mainnet §J pass (see the Status roll-up at the top of this file).
Scope: the config load path, the JWT signing key, `.api_secret` / `.foreign_api_secret` handling,
the wallet password on disk, `lib/alert-delivery.js` credentials, the poolstats API key, the Nostr
identity key, admin password hashes and TOTP secrets, and **file modes** — plus the two redaction
questions: does any secret reach a **response body**, and does any reach a **log line**?

Method: build the inventory first (every secret, its file, its mode, its owner, its readers), then
walk the two redaction questions across all ~180 routes and every `console.log`/`console.error` in
`index.js` + the 40 `lib/` modules. The shell side (`07_grin_mining_public_pool.sh`,
`lib/07_lib_pool_wallet.sh`, `lib/grin_node_secrets.sh`, `04_grin_node_foreign_api.sh`) was read to
establish what the modes actually are — findings that live in the shell are handed to §J16, per the
plan's own instruction for this session.

**Headline — the secrets are stored correctly one file at a time, and the composition leaks.**

*Every individual secret file is right.* `pool.json` is `0600` and never auto-generates its JWT
secret; `.wallet_pass` is `0600` and is fed to grin-wallet on **stdin**, never argv, on both the
ECDH unlock path and the `send` path — so the wallet passphrase is not in `ps aux`, which is the
exact trap CLAUDE.md warns about; the Nostr identity key is written `{ mode: 0o600 }`; the node's
two API secrets are `640 root:grinsecret` with a group grant for the de-rooted `grinpool` user; the
poolstats key travels in an `Authorization` header over a scheme-checked HTTPS endpoint and is
never logged. No route serialises `config`. No handler returns a stack trace.

*But the database is not a file anybody thought of as a secret store, and it is the biggest one.*
`pool.db` holds the admin bcrypt hash, the **plaintext** `users.totp_secret`, the bcrypt recovery
codes, every miner's address and balance, the ownership-proof scrypt hashes and the whole admin
audit log. SQLite creates it `0644` under systemd's default `UMask=0022`, and Script 07 makes the
directory holding it traversable *and listable* by `others` so nginx can serve `custom_assets/` and
`uploads/`. Two individually reasonable decisions compose into a world-readable ledger (J8-1).

*And the same "one file at a time" blind spot appears three more times.* An admin route publishes
the six ownership-proof hash columns the DB exists to keep unreadable (J8-2). An entire settings
section — three live credentials among its nine keys — is stored in `pool_config`, read back to the
browser in cleartext, and applied by **nothing** (J8-3). Two toolkit products both claim `.foreign_api_secret`'s group, one of them from
a five-minute timer, and a file has one group (J8-4).

Five findings plus two Info notes. **Two were fixed in this session** (J8-1's code half and J8-2 —
both small and local, plan rule 3). J8-3 and J8-4 are left open as decisions; J8-5 is left open
because it reverses a trade §G1 made deliberately and the operator should make the call.

### Threat actors used in this section

| Label | Means |
|---|---|
| **Local unprivileged** | Any account on the pool box that is not `root` and not `grinpool` — `www-data`, `grin`, `debian-tor`, an operator's own shell user, or anything that lands via a bug in one of the *other* products on the box. This is the actor de-rooting exists to contain |
| **Stolen admin session** | A `secureAdmin` access token taken from an operator's browser. Per §C3 it survives logout, password change and *Revoke sessions* until it expires (≤24 h, capped for exactly this reason) |
| **Logged-in admin** | A legitimate `secureAdmin`/`freshAdmin` session. Already able to move money, so anything reachable here is disclosure or robustness, never escalation |
| **On-box root** | Reads everything by definition. Reported only as Info |
| **The system** | No attacker. A timer, an install order, a umask |

### The inventory

Every secret the pool touches. Modes are what the code and the installer actually set — the
"who can read it" column assumes a mainnet install after `4) Nginx` has run (see J8-1).

| # | Secret | Lives in | Mode / owner | Readable by | In a response? | In a log? |
|---|---|---|---|---|---|---|
| 1 | JWT signing key | `pool.json` `jwt_secret` (64 hex) | `0600 grinpool:grinpool` | grinpool, root | no | no |
| 2 | Admin password hash (bcrypt cost 12) | `pool.db users.password_hash` | `0644` → **`0600` (J8-1)** | ~~everyone~~ grinpool, root | no | no |
| 3 | Admin TOTP secret — **plaintext base32** | `pool.db users.totp_secret`, `totp_pending_secret` | as #2 | as #2 | no | no |
| 4 | 2FA recovery codes (bcrypt) | `pool.db admin_recovery_codes.code_hash` | as #2 | as #2 | once at enrollment, by design | no |
| 5 | Miner rig password (scrypt `v1$salt$hash`, 16 MB) | `pool.db miner_accounts.{last,prev,anchor}_pass_hash` | as #2 | as #2 | **yes → J8-2, fixed** | reason only, never the value |
| 6 | Miner mining IP (scrypt, same shape) | `pool.db miner_accounts.{last,prev,anchor}_ip` | as #2 | as #2 | **yes → J8-2, fixed** | **raw, → J8-5** |
| 7 | Node **Owner** API secret | `<node dir>/.api_secret` | `640 root:grinsecret` | root, `grinsecret` (= grinpool) | no | path only |
| 8 | Node **Foreign** API secret | `<node dir>/.foreign_api_secret` | `640 root:grinsecret` — **contested → J8-4** | root + whichever group won | no | path only |
| 9 | Wallet passphrase | `<app dir>/.wallet_pass` | `0600 grinpool:grinpool` | grinpool, root | no | no — **stdin, never argv** |
| 10 | Wallet Owner API secret | `<wallet dir>/.owner_api_secret` | grin-wallet's own mode, `chown -R grinpool` | grinpool, root | no | no |
| 11 | Pool Nostr identity key (hex sk) | `<db dir>/.nostr_payout_key` | `0600` | grinpool, root | no | path only |
| 12 | Poolstats API key | `pool.json` `poolstats_api_key` | `0600 grinpool:grinpool` | grinpool, root | **7+4-char preview → J8-7** | never |
| 13 | Alert delivery creds (Discord / Slack / Telegram bot token / email) | `pool.db pool_config` section `alerts` | `0644` → **`0600` (J8-1)** | as #2 | **yes, cleartext, `secureAdmin` → J8-3** | no |
| 14 | Admin session token | `httpOnly` `sameSite=strict` cookie | n/a | the operator's browser only | n/a (it *is* the auth) | no |

---

### J8-1 — [High] `pool.db` is created `0644` inside a directory Script 07 deliberately makes world-listable, so every local account on the box can read the admin bcrypt hash, the plaintext TOTP secret and the whole miner ledger — **CODE HALF FIXED 2026-09-01; the shell half is §J16's**

**Threat actor: local unprivileged.** Not root — any account on the box. This is precisely the
actor the pool's de-rooting exists to contain: the install comment at
[07_grin_mining_public_pool.sh:614](../../scripts/07_grin_mining_public_pool.sh#L614) says the
backend runs as `grinpool` because *"the backend parses untrusted input from the public internet on
TWO surfaces (HTTP API + raw stratum TCP) atop a large npm tree"*, and that de-rooting is worth
little if the thing it is protecting is readable by `www-data` anyway.

Three facts compose.

**(1) SQLite creates the database `0644`.** `initDb` opens the file and sets exactly two pragmas —
no mode is passed anywhere:

```js
db = new Database(dbPath);          // lib/db.js:15
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
```

`lib/sqlite-compat.js:28` is `new DatabaseSync(filename)` with no options, so the mode is SQLite's
`SQLITE_DEFAULT_FILE_PERMISSIONS` (`0644`) masked by the process umask. The systemd unit at
[07_grin_mining_public_pool.sh:631–657](../../scripts/07_grin_mining_public_pool.sh#L631) sets
`User=`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `RestrictSUIDSGID` and
`ReadWritePaths` — but **no `UMask=`**, and systemd's default for a service is `0022`. So
`0644 & ~0022` = `0644`. The `-wal` and `-shm` siblings inherit the database file's mode from
SQLite's `findCreateFileMode()`, so they are `0644` too — and `-wal` is where the *most recent*
writes live, which is the worst half to leave open.

The code knows umask matters elsewhere:
[lib/asset-manager.js:110](../../web/07_mining_pool_public/back-end-pool/lib/asset-manager.js#L110)
writes uploaded assets with an explicit `{ mode: 0o644 }` *because nginx has to read them*. The
inverse reasoning was never applied to the database.

**(2) The directory is `705`, on purpose.** `pool_install` creates it tight:

```bash
mkdir -p "$POOL_APP_DIR"
chmod 700 "$POOL_APP_DIR"          # :565–566
```

and then `pool_setup_nginx` — menu step `4) Nginx`, which every install runs — opens it again so
nginx can traverse into the two subdirectories it serves:

```bash
chmod o+rx /opt/grin "$POOL_APP_DIR" "$POOL_APP_DIR/custom_assets"   # :1016
chmod o+rx "$POOL_APP_DIR/uploads"                                   # :1022
```

`700 | o+rx` = **`705`**. `o+x` alone would have been enough for nginx (traverse); `o+r` also grants
**listing**, so `others` can enumerate the directory rather than needing to guess a filename. The
full path is open end to end: `/opt` `755` → `/opt/grin` `o+rx` → `/opt/grin/pubpool` `755` (plain
`mkdir -p` under umask 022) → `/opt/grin/pubpool/mainnet` `705` → `pool.db` `644`.

**(3) The database is the pool's secret store.** From
[lib/db.js:637–666](../../web/07_mining_pool_public/back-end-pool/lib/db.js#L637) and
[:386–416](../../web/07_mining_pool_public/back-end-pool/lib/db.js#L386):

- `users.password_hash` — bcrypt, cost 12. Offline-crackable at leisure against a human-chosen
  operator password.
- `users.totp_secret` — **plaintext base32**. §J2-8 accepted plaintext-at-rest as unavoidable for
  TOTP *and equivalent to the wallet password already accepted in §Residual risks* — that
  equivalence held only while the file was as protected as `.wallet_pass` (`0600`). It is not.
- `admin_recovery_codes.code_hash` — bcrypt; ~50 bits of entropy, so not the weak link, but present.
- `miner_accounts` — every miner's address, `balance`, `balance_locked`, and the six ownership-proof
  scrypt columns.
- `admin_audit_log` — the full money trail including admin rows, which §G1 deliberately keeps at
  **full IP precision** because they are operator data.

The consequence is not "an attacker reads some hashes". It is that the plaintext TOTP secret plus
an offline attack on one bcrypt hash reconstitutes **both** admin factors, including the mandatory-2FA
gate that §J2-1/§J2-3 built specifically because it is the one control a password grind cannot
out-scale. A local read is a complete bypass of the second factor with no online rate limit, no
lockout, and no `login_failed` audit row anywhere.

Disclosure only — `others` get `r--`, not `w`. The ledger cannot be tampered with this way.

**Fixed (code half), 2026-09-01.** `initDb` now chmods the database and its two WAL siblings to
`0600` after the schema runs, in a new `restrictDbFileModes()`
([lib/db.js:20, 43](../../web/07_mining_pool_public/back-end-pool/lib/db.js#L43)). This closes the
disclosure **on its own**, regardless of the directory mode — it is not a partial fix that only
looks like one. Deliberately *not* a process-wide `umask(0o077)`: `fs.writeFileSync`'s `mode` is
also masked, so a global umask would silently turn asset-manager's explicit `0o644` into `0600` and
403 every white-label logo. Each file is guarded individually because `-wal`/`-shm` may not exist
yet and because `chmod` is a no-op on the Windows dev machine.

**Handed to §J16 (the shell half, both parts defence-in-depth):**
1. `chmod o+rx "$POOL_APP_DIR"` should be `chmod o+x` — nginx needs traverse, not listing. Keep
   `o+rx` on `custom_assets/` and `uploads/` themselves.
2. Add `UMask=0077` to the systemd unit so *every* file the backend creates from now on is tight by
   default, rather than each new one needing to remember.
3. The root-run installer helper at
   [:2415–2432](../../scripts/07_grin_mining_public_pool.sh#L2415) opens the same DB as root while
   the service may be stopped; it already `chown`s `pool.db`/`-wal`/`-shm` back to `grinpool` but
   does not `chmod` them. Add the chmod beside the chown.

**§J17 must confirm this on a box**, because `chmod` is a no-op locally and the mode is the whole
finding: `stat -c '%a %U:%G' /opt/grin/pubpool/<net>/pool.db*` and
`stat -c '%a' /opt/grin/pubpool/<net>` after a full install → expect `600 grinpool:grinpool` and
`701`/`705`.

---

### J8-2 — [Medium] `GET /api/admin/miners/:addr` was `SELECT *`, so it shipped the six ownership-proof scrypt hashes — the values the DB exists to keep unreadable — into an admin browser — **FIXED 2026-09-01**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J8-2).**

### J8-3 — [Medium] The whole `alerts` settings section is inert: all nine keys — three of them live credentials — are stored in the DB, served back to the browser in cleartext, and read by nothing — so a Telegram bot token is pure liability, and every money alert §J5-8 built is delivered nowhere — **OPEN**

**Threat actor: the system**, for the inert half — no attacker; the panel and the runtime read two
different places. **Stolen admin session**, for the disclosure half.

**The credentials are never applied.** `PoolSettings.defaults.alerts`
([lib/pool-settings.js:266–276](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L266))
declares nine keys: `alert_check_interval_secs`, `alert_email_address`, `discord_webhook_url`,
`slack_webhook_url`, `telegram_bot_token`, `telegram_chat_id`, `alert_large_withdrawal`,
`alert_tor_fails_per_week` and `alert_thresholds`. Every consumer reads them off the **config
object**, not off `PoolSettings`:

```js
this.discordWebhook   = config.discord_webhook_url;   // lib/alert-delivery.js:15
this.telegramBotToken = config.telegram_bot_token;    // :20
const t = config.alert_thresholds || {};              // lib/alert-monitor.js:52
```

and `PoolSettings.applyToConfig()`
([lib/pool-settings.js:1467–1552](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1467))
destructures exactly `{ pool_info, payout }`. **No `alerts` key is copied into `config` anywhere.**
A repo-wide sweep confirms it — `telegram_bot_token` appears in only four places: the defaults, the
HTML form, `alert-delivery.js` reading `config`, and a test fixture. Nothing bridges them.

Nor does `pool.json` supply them: `pool_ensure_defaults`
([07_grin_mining_public_pool.sh:305–320](../../scripts/07_grin_mining_public_pool.sh#L305)) never
writes any alert key, and `lib/config.js` declares no default for them either. So on a **stock
install, off-box alert delivery is impossible** — `configuredChannels()` returns all-false,
`GET /api/admin/alerts/config` reports `delivery: {email:false, discord:false, slack:false}`, and
`POST /api/admin/alerts/test` refuses with *"Set a webhook / email / Telegram in pool.json first."*
The only route to a working alert is hand-editing a `0600` file the panel never mentions.

`alert_thresholds` is dead twice over: it is stored as a **JSON string**, and `alert-monitor.js:52`
does `config.alert_thresholds || {}` then reads `t.wallet_balance_warning_grin` — so even if it were
merged, property access on a string yields `undefined` and every threshold falls back to its default.

This matters more than a normal dead-key finding (cf. §J1-5, §J5-9) because of **what** goes
undelivered. §J5-8 was raised and fixed on the grounds that *"every money detector is aimed at a
shortfall, so a totally stalled distribution pipeline raises nothing"* — and the seven detectors it
added (`coverage_shortfall`, `ledger_integrity_drift`, `wallet_drain`, `unrecorded_wallet_send`,
`wallet_identity_changed`, …) are the ones that **freeze payouts**. On a stock mainnet install they
reach the `alerts` table and the admin panel, and nowhere else. An operator who is not looking at
the panel learns about a frozen payout queue from a miner.

**The disclosure half.** Whatever the operator does type into that form is stored in `pool_config`
and read straight back:

- `GET /api/admin/settings/alerts` → `res.json({ data: poolSettings.getSection('alerts') })`
  ([index.js:6254](../../web/07_mining_pool_public/back-end-pool/index.js#L6254)) — cleartext.
- `GET /api/admin/settings` → `getAll()`, every section including `alerts`
  ([index.js:6244](../../web/07_mining_pool_public/back-end-pool/index.js#L6244)).
- `POST /api/admin/settings/alerts` echoes the saved section back too.

All three are `secureAdmin` — the **lower** tier. `alerts` is not in `STEP_UP_SETTINGS_SECTIONS`
and none of its keys is in `STEP_UP_SETTINGS_KEYS`, so a stolen access token both reads a Telegram
bot token and rewrites it, with no step-up and no second factor. The section's audit diff is
scrupulously **names-only** for exactly this reason
([lib/pool-settings.js:1410–1414](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L1410)):
*"the `alerts` section holds discord_webhook_url, slack_webhook_url and telegram_bot_token; …
recording before/after values here would move live credentials into a wider-read table."* The
audit log was protected; the read endpoint was not.

The form does carry an honest note — *"Delivery channels are read from the running config
(pool.json); saving here records them for reference"*
([settings-alerts.html:64–66](../../web/07_mining_pool_public/back-end-pool/admin-panel/settings-alerts.html#L64)) —
but it sits under the *Send test alert* button, three fields below the token input, and the fields
above it are indistinguishable from every other working settings form in the panel.

**Left OPEN — this is a decision, not a patch**, and the two halves are coupled:

- **Wire them up** (`applyToConfig` copies the `alerts` section; `alert_thresholds` gets
  `JSON.parse`d; `AlertDelivery`/`AlertMonitor` re-read on a settings save the way
  `sessionPolicyProvider` does) — **and then** the read endpoints must mask: return
  `"••••••••"` for a set credential and treat that sentinel as "unchanged" on write. Wiring
  without masking makes a live credential newly worth stealing.
- **Or delete the three credential fields** from the section and the form, and say plainly that
  delivery is configured in `pool.json`.

Doing neither is the worst of the three: the pool stores a credential, hands it to any admin
session, backs it up, and gets nothing for it.

> **Later outcome (added 2026-09-07, not part of the original finding).** The resolution pass took
> the delete option: `settings-alerts.html` no longer exists, so the link above is to a deleted
> file — see **§J8-3** below for what was removed and why. The riders were never exercised.

**Two riders if the wiring option is chosen.** (a) There is **no validator** for
`discord_webhook_url` / `slack_webhook_url` / `telegram_bot_token` — the `alerts` validator block
covers `alert_check_interval_secs` only
([lib/pool-settings.js:983–989](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L983)) —
and `postWebhook()` builds its request from `url.hostname`/`url.port`/`url.pathname` with no
allowlist, so wiring these up turns a `secureAdmin` settings write into an outbound-request
primitive. That is **§J13's** call, and it must be made *before* the wiring lands, not after.
(b) The section should move into `STEP_UP_SETTINGS_SECTIONS`, or at least its three credential keys
into `STEP_UP_SETTINGS_KEYS`, once they mean something.

---

### J8-4 — [Medium] Script 04 and the pool both claim `.foreign_api_secret`'s group, a file has one group, and the pool re-claims it every five minutes — so installing the pool permanently 401s Script 04's collector, and it reads as "node down" — **OPEN**

**Threat actor: the system.** No attacker; two products on the same box disagree, and a timer
settles it the same way every time.

Both products need the node's Foreign API secret, and each grants access by putting the file in
*its own* service group:

```bash
# scripts/04_grin_node_foreign_api.sh:1900       — REST collector runs as the nginx web user
chown "root:$web_user" "$_foreign_secret_file"
chmod 640 "$_foreign_secret_file"
```
```bash
# scripts/07_grin_mining_public_pool.sh:513–514  — de-rooted backend runs as grinpool
chgrp grinsecret "$sf"
chmod 640 "$sf"
```

A file has exactly one group. `usermod -aG grinsecret grinpool` is the only membership granted
anywhere (`grep -rn grinsecret scripts/` returns ten lines, all in these two files) — **`www-data`
is never added to `grinsecret`, and `grinpool` is never added to `www-data`.** So whichever product
ran last owns the file and the other one is locked out.

Except it is not even a race, because one side re-asserts on a timer.
`grin_sync_pool_stratum()` — reached from `grin_secrets_sync_all()`
([grin_node_secrets.sh:654–662](../../scripts/lib/grin_node_secrets.sh#L654)), which is what the
`grin-secret-sync.timer` runs **every 5 minutes** — does this unconditionally whenever
`/opt/grin/conf/grin_pubpool*.json` exists:

```bash
if getent group grinsecret >/dev/null 2>&1; then          # :611–616
    for sf in "$dir/.api_secret" "$dir/.foreign_api_secret"; do
        chgrp grinsecret "$sf" 2>/dev/null || true
        chmod 640 "$sf" 2>/dev/null || true
    done
fi
```

Nothing anywhere re-applies Script 04's grant. `grin_sync_collector()`
([:445–457](../../scripts/lib/grin_node_secrets.sh#L445)) only rewrites secret **paths** in
`config.env`; it never touches ownership. So: re-run Script 04, and within five minutes the pool
takes the group back, for good.

The same file already contains the argument against this, 350 lines earlier. `_gns_node_put()`'s
header comment ([:249–254](../../scripts/lib/grin_node_secrets.sh#L249)) reads:

> An existing file is rewritten in place so its ownership and mode **SURVIVE** — Script 04 sets the
> foreign secret to `root:<web_user>` 640 for the REST collector, and the de-rooted pool sets
> `root:grinsecret` 640. **A blind chown/chmod here would silently 403 both.**

`grin_sync_pool_stratum` is that blind chgrp, in the same lib, on the same files, on a timer.

**Why it reads as an outage rather than a permissions bug.** Script 04's collector loses read
access, so its authenticated call goes out unauthenticated and the node answers **401** — which
CLAUDE.md records as the classic misdiagnosis: *"It fails as 'node down', not as 'bad endpoint'."*
The pool's own `_warnNoSecret()` prints a genuinely diagnosable line for this exact case
(`permission denied — the grinsecret group grant is missing`,
[lib/grin-node.js:120–122](../../web/07_mining_pool_public/back-end-pool/lib/grin-node.js#L120)) —
but that is the *pool's* diagnostic, and the pool is the side that wins. The side that loses is a
`rest-collector` cron that writes static JSON and has no equivalent line.

**Left OPEN — §J16 owns the fix, and it is a policy choice, not a patch:**

1. **Preferred — one group, two members.** Have both products use `grinsecret` and add the nginx web
   user to it (`usermod -aG grinsecret www-data`), keeping `640 root:grinsecret`. One writer of the
   grant, one group, both readers. Note the trade honestly: `www-data` is a *large* attack surface
   (it serves the public site), so this hands the node Owner secret to it as well — which argues for
   splitting the grant so `www-data` gets only `.foreign_api_secret`.
2. **Or ACLs** — `setfacl -m u:www-data:r,u:grinpool:r` on each file, and make both installers and
   `grin_sync_pool_stratum` re-apply the ACL rather than a `chgrp`. Cleanest semantically; adds an
   `acl` package dependency and a mount-option assumption.
3. **Either way**, `grin_sync_pool_stratum` must stop issuing a blind `chgrp` and instead heal *only*
   the case it was written for — a node rebuild that reset the file to `600 root:root` — leaving an
   existing non-`root` group alone, exactly as `_gns_node_put` already does.

**§J17:** on a box that has both products, `stat -c '%a %U:%G' <node dir>/.foreign_api_secret`,
then `systemctl start grin-secret-sync.service` and stat it again. If the group flipped, this is
confirmed live.

---

### J8-5 — [Low] The service journal writes the miner's full Grin address next to their raw mining IP on every stratum login — re-creating outside the DB the linkage §G1 removed inside it — **OPEN**

**Threat actor: on-box readers of the journal** — root, and members of `systemd-journal`/`adm` —
plus anyone who receives a host backup, a log export, or a journal forwarded off-box. Narrower than
§G1's audience (`admin_audit_log` is readable by any admin session *and* its CSV export), which is
why this is Low and not Medium.

§G's opening claim is *"There are exactly three IP-bearing columns in `pool.db`"*, and its
out-of-DB paragraph enumerates the other sinks: *"nginx `${POOL_SERVICE}-access.log` holds real IPs
(unavoidable — fail2ban parses it; bounded by logrotate). `rate-limiter.js` / `ip-filter.js` keep
IPs in in-memory Maps only, never persisted."* The pool's **own service journal** is not in that
list, and it holds the one pairing nginx cannot produce — nginx never sees stratum, so the *mining*
IP appears only here:

```js
console.log(`[${new Date().toISOString()}] Miner login: ${parsed.grin_address}.${parsed.worker_name} (${ip})`);
```
[lib/stratum-server.js:627](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L627) —
once per login, and per §J6-2 a rig re-logs in on every reconnect.

That is the *exact* value `owner-proof.js` spends a 16 MB scrypt per capture to avoid storing
(`miner_accounts.last_ip`), written in the clear beside the address it belongs to and a timestamp.
Two more lines in the same class:

- [:917](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L917) —
  `consecutive rejected submits from ${session.grinAddress} (${session.ip})`.
- [lib/owner-proof.js:434](../../web/07_mining_pool_public/back-end-pool/lib/owner-proof.js#L434) —
  full address, no IP. The comment there is careful to log *"the REASON (never the value)"* for the
  password, which shows the redaction instinct was applied to the password and not to the address.

Retention is journald's, not the pool's: `admin_audit_log` is pruned by
`database.audit_log_keep_days` (default 180, floor 30) and the nginx log by logrotate, but the
journal keeps whatever `SystemMaxUse`/`MaxRetentionSec` say — commonly months, and unbounded in
time on a box that was never tuned.

**Left OPEN deliberately, because closing it reverses a trade §G1 made on purpose.** §G1 chose
*coarsen, don't hash* so incident response keeps *"group these events by origin"*, and it kept the
throttle keyed on the full in-memory IP for the same reason. The journal's full IP has real
operational value — it is how an operator identifies and `ufw deny`s an abusive rig, and there is
no second copy of it. The options, for the operator to pick:

1. **Coarsen the IP in these two lines** with the existing `coarsenIp()` (IPv4 `/24`, IPv6 `/48`),
   matching §G1 exactly. Cheapest and consistent; costs the ability to ban a single address from the
   log alone.
2. **Keep the IP, truncate the address** to the head/tail form `/api/stratum/stats` already uses.
   Keeps the ban workflow; weakens the linkage without removing it (a truncated address is still
   matchable against a known address set).
3. **Accept and bound it** — leave the lines alone and set `MaxRetentionSec=` on the journal, so the
   exposure has an end date the way `audit_log_keep_days` gives one to the audit table.

Whichever is chosen, §G / memory `project_pool_ip_privacy` should gain the journal as a **fourth**
named sink, so the next reader of "exactly three IP-bearing columns" does not conclude the sweep
was complete.

---

### J8-6 — [Info] Verified correct, with evidence

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J8-6).**

### J8-7 — [Info] Two smaller notes from the same sweep

**(a) `api_key_preview` publishes 11 of the poolstats key's characters.**
`getStatus()` returns `` `${key.slice(0,7)}...${key.slice(-4)}` ``
([lib/poolstats-reporter.js:190](../../web/07_mining_pool_public/back-end-pool/lib/poolstats-reporter.js#L190)),
served by `GET /api/admin/poolstats` at `secureAdmin`. The intent is right — let the operator tell
*which* key is loaded without showing it — but 11 characters is generous next to the usual 4, and
several vendors' keys carry a fixed prefix, which makes the leading 7 nearly free. Suggest
last-4 only. Low value either way: the reporter is off unless `poolstats_enabled: true`, which the
installer never writes.

**(b) The app directory's mode depends on which menu step ran last.** `1) Install` sets
`chmod 700 "$POOL_APP_DIR"` and `4) Nginx` sets `chmod o+rx` on it. Re-running Install (the
documented fix for a changed systemd unit) silently takes the directory back to `700`, at which
point nginx can no longer traverse into `custom_assets/` and `uploads/` and every white-label logo
and CMS image 404s until `4) Nginx` is re-run. Nothing warns. Worth folding into §J16 alongside
J8-1's shell half — if `o+x` is set where the subdirectories are created rather than in the nginx
step, the ordering stops mattering.

---

### Handoffs

- **§J9 (settings & config integrity)** inherits J8-3's dead-section half. It is the same shape as
  §J1-5 and §J5-9 but with credentials in it, and it is a **section**, not a key — so J9's sweep
  should ask, per section, *"which keys in this section does `applyToConfig` actually copy?"* rather
  than checking key-by-key. `alerts` is 0-for-9.
- **§J13 (outbound calls & SSRF)** owns the rider on J8-3: `discord_webhook_url` /
  `slack_webhook_url` / `telegram_bot_token` have **no validator**, and `postWebhook()` builds its
  request from an operator-supplied `URL` with no host allowlist. Today that is inert because the
  values never load; the moment J8-3 is "fixed" by wiring them up, a `secureAdmin` settings write
  becomes an outbound-request primitive aimed at whatever the pool box can reach — including the
  node's Owner API on loopback. **J13 must answer this before the wiring lands.**
- **§J16 (deployment & infra)** owns three items from this session, all in the shell:
  (1) J8-1's directory mode + `UMask=0077` on the unit + the chmod beside the installer helper's
  chown; (2) J8-4's group tug-of-war — the fix is a policy choice between one shared group, ACLs,
  or teaching `grin_sync_pool_stratum` to heal only `root:root`; (3) J8-7(b)'s Install-vs-Nginx
  ordering. Also worth noting while in that file: `$POOL_LOG` gets a logrotate stanza and a
  `postrotate systemctl kill -s USR2`, but **nothing writes to it** — the unit has no
  `StandardOutput=append:`, so the service logs to the journal and the only writer of `$POOL_LOG`
  is the weekly `VACUUM` cron's stdout. The rotation and the USR2 are both no-ops on a Node process.
- **§J11 (public API leakage)** — the public `GET /api/account/:addr` was checked here for
  proof-hash leakage and is clean (explicit response object, booleans only). J11 does not need to
  re-derive that; what it still owns from this file is the address+balance question (§C1).
- **§J17 (operational gate)** — three things only a box can settle. (1) **J8-1 is the one to stage**:
  after a full install, `stat -c '%a %U:%G'` on `pool.db`, `pool.db-wal`, `pool.db-shm` and the app
  directory. The fix is verified locally only in the sense that it *runs* — `chmod` is a no-op on
  Windows (memory `reference_openssl_fd_pass_local`), so the mode itself has never been observed.
  (2) **J8-4**: on a box with both Script 04 and the pool, stat `.foreign_api_secret`, run
  `grin-secret-sync`, stat again. (3) **J8-3**: decide it before mainnet — if the answer is "wire
  them up", a real test alert must arrive off-box *before* the money detectors are relied on.
- **§G / memory `project_pool_ip_privacy`** should be amended with the journal as a fourth
  out-of-DB IP sink (J8-5), whichever disposition is chosen.

---

### Verification

- **`npm test` — full suite green**: `12 + 47 + 32 + 52 + 26 + 18` assertions plus 19
  ownership-gate checks = **206 passed, 0 failed**, before and after this session's two fixes.
  Same baseline as §J7.
- **`node --check`** clean on both edited files.
- **One-shot `initDb` probe** in the scratchpad (`node v24.14.1`, real `node:sqlite`): confirmed
  `restrictDbFileModes()` runs without throwing and that **`-wal` and `-shm` both already exist** by
  the time it is called, so all three files are covered. It reported `666` for all three — which is
  MSYS/NTFS reporting, not a failure: `chmod` is a no-op on this machine. The probe deleted its own
  fixture and exited on its own; no server was started and nothing was left running (CLAUDE.md
  local-process rule).
- Nothing was run against a VPS. All findings are **add-ons, NOT VPS-TESTED**.
- **Gaps worth stating.** (1) **J8-1's mode change is unobservable locally** — the only proof
  available here is that the call site executes and the files exist; §J17 must stat them on Linux.
  (2) **No regression test was added for J8-2.** The existing suites are DB- and unit-level and this
  is a route-level response shape, which needs the Express harness §J7 also did not build. The
  standing check is `grep -n "SELECT \* FROM miner_accounts" index.js` returning nothing.
  (3) J8-4 was established entirely by reading two installers and a timer; it has never been
  observed happening.

### Changed this session

| File | Change |
|---|---|
| `lib/db.js` | J8-1 — new `restrictDbFileModes()`, called from `initDb` after `createSchema()`; chmods `pool.db`, `-wal` and `-shm` to `0600`, per-file guarded. Comment records why a process-wide `umask(0o077)` is the wrong instrument (it would mask asset-manager's deliberate `0o644`) |
| `index.js` | J8-2 — `GET /api/admin/miners/:addr` moved off `SELECT * FROM miner_accounts` onto an explicit 23-column list; the six ownership-proof hash columns are dropped, their `*_at` timestamps and `pass_proof_state` kept |

**Left open at the end of this session:** J8-3 (a decision — wire the alert credentials up *with*
masking, or delete the fields; blocked on §J13's SSRF answer either way), J8-4 (§J16's file; a
policy choice about which group owns a shared secret), and J8-5 (reverses a trade §G1 made
deliberately, so the operator picks the disposition). J8-1's shell half is defence-in-depth on a
disclosure the code fix already closes.

---

## §J9 — Settings & config integrity (2026-09-02, add-ons, NOT VPS-TESTED)

Ninth session of the pre-mainnet §J pass (see the Status roll-up at the top of this file).
Scope: `lib/config.js` (275 lines), `lib/pool-settings.js` (1,556 lines),
`GET|POST /api/admin/settings/:section` + `/restore`, and the `.config.sha256` integrity check.
The brief is memory `project_config_loader_type_traps` — the two traps found and fixed in Script
052 and recorded there as *"same shape unaudited"* here.

Method: enumerate the schema mechanically rather than by eye — every key in
`PoolSettings.defaults`, its validator (or absence), the shape of every read site, and whether
`applyToConfig` or any consumer ever sees it. Then walk the write path (`updateSection`, the
step-up decision, `resetSection`) and the boot path (`loadConfig` → `validateConfig` ×2 →
`hashConfig` → `mergeDbSettings`).

**Headline — trap 1 is closed everywhere; trap 2 is open exactly where §J1-6 and §J7-8 said; and
the real problem in this file is neither of them.**

*Trap 1 ("a quoted `false` is truthy") does not exist here.* Every one of the 22 boolean-shaped
settings keys is read through `v === true || v === 'true'` — `flag()` in `incentives.js`,
`lottery.js` and `dormancy.js`, the inline pair in `retention.js` and `networkMapPublic()`,
`String(...) === 'true'` in `totpIsMandatory()`, and the coercion boundary in `buildPublicConfig()`
that means the front-end never sees a string at all. The admin panel's checkbox binding uses the
identical test, so the panel and the server cannot disagree about a switch. That is a genuinely
clean result and it was checked key by key, not assumed (§J9-9).

*Trap 2 is present, and §J7-8 was right that it is worse than a junk row.* Fixed here — it was
already assigned to this session by §J1-6's handoff.

*But the finding that matters is that the settings surface offers an access control it does not
have.* `pool_visibility: private` + `address_whitelist` + `max_miners` are validated, audited,
persisted, rendered in a purpose-built UI ("Private (whitelisted only)"), and placed in
`STEP_UP_SETTINGS_KEYS` — the highest gate this surface has, the one whose whole point is to
survive a stolen session. **Nothing reads any of them.** The stratum login gate checks
`is_banned` and nothing else (J9-1).

*And the step-up gate protecting the keys that ARE live can be walked past* with a hex literal,
because the "did this value actually change?" comparison uses `Number()` while every validator
uses `parseFloat`/`parseInt` (J9-2).

Seven findings plus an Info sweep. **Six were fixed in this session** (J9-2, J9-3's gating half,
J9-4, J9-5, J9-7 — all small and local, plan rule 3 — and then **J9-1 by deletion**, decided after
the write-up below), with 38 new assertions in `scripts/test-admin-guards.js`. **J9-6** is left for
a decision because it is a choice about what the product should do, not a defect with one right
answer.

### Threat actors used in this section

| Label | Means |
|---|---|
| **Anonymous internet** | Anyone who can reach `:3333` or the public API. No credential of any kind |
| **Stolen admin session** | A `secureAdmin` access token taken from an operator's browser. Per §C3 it survives logout, password change and *Revoke sessions* until it expires (≤24 h) |
| **Logged-in admin** | A legitimate `secureAdmin`/`freshAdmin` session. Already able to move money, so a finding here is robustness or a durable self-inflicted outage, never escalation |
| **On-box root** | Reads and writes `pool.json` by definition. Reported only where a control *claims* to detect it |
| **The system** | No attacker. A typo, a restart, an install order |

### Findings

### J9-1 — [High] `pool_visibility`, `address_whitelist`, `max_miners` and `mining_mode` are enforced by nothing — a "Private (whitelisted only)" pool is fully open, and the step-up gate on those keys is what makes it look real — **FIXED BY DELETION 2026-09-02**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J9-1).**

### J9-2 — [Medium] The step-up gate on `pool_fee_percent` compares with `Number()` while the validator parses with `parseFloat`, so `0x1` reads as "unchanged" against a stored `1` and then stores `0` — the pool fee goes to zero on a plain `secureAdmin` session — **FIXED 2026-09-02**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J9-2).**

### J9-3 — [Medium] `custom_theme` is the fourth operator-authored CSS sink in `branding`, and it was the only one that was neither step-up gated nor skipped on the admin login page — **GATE + VALIDATOR FIXED 2026-09-02; the credential-page half is §J15's**

**Threat actor: stolen admin session.** Same actor and same shape as §J1-1, which this is a hole in.

§J1-1 established that operator-authored script/CSS sinks in the *cosmetic* sections are not
cosmetic, because `public_html/login.html` — the admin credential page — loads `branding.js`. Its
fix did two things: put the sinks in `STEP_UP_SETTINGS_KEYS`, and make `branding.js` skip them on
credential pages. `branding` contributes three keys to that fix: `custom_css`, `font_family`,
`font_url`.

There is a fourth. `custom_theme` is a JSON map of CSS variable → value, and `applyTheme()` writes
every entry onto **both** `<html>` and `<body>`:

```js
function setVar(name, value) {
  root.style.setProperty(name, value);
  if (document.body) document.body.style.setProperty(name, value);
}
var custom = brand.custom_theme || {};
Object.keys(custom).forEach(function (k) {
  if (!custom[k]) return;
  var name = k.charAt(0) === '-' ? k : '--' + k;
  setVar(name, custom[k]);
});
```
([branding.js:320–330](../../web/07_mining_pool_public/public_html/js/branding.js#L320))

Two problems, both verified by reading the file:

1. **It sits ABOVE the `isCredentialPage()` guard.** That guard begins 30 lines later, at the
   comment *"Operator-authored CSS sinks — skipped on credential pages (§J1-1)"*
   ([branding.js:357](../../web/07_mining_pool_public/public_html/js/branding.js#L357)), and wraps
   `font_url`, `font_family` and `custom_css`. `custom_theme` is applied unconditionally, on
   `login.html` included.
2. **It was at `secureAdmin`.** `branding` is not a step-up section and `custom_theme` was not in
   `STEP_UP_SETTINGS_KEYS`, so writing it needed only a live access token — no password re-auth, no
   TOTP, on a pool with mandatory 2FA on.

And the validator, as found, checked one thing:

```js
custom_theme: (val) => {
  if (typeof val === 'object' && val !== null) return JSON.stringify(val);
  if (typeof val === 'string') { … try { JSON.parse(val); } … return val; }
  return '{}';
},
```

No key allowlist, no value type check, no length cap, no count cap. That matters because a CSS
custom property is a raw token stream — whatever consumes it via `var()` decides what it means, and
`dashboard.css` consumes these variables in `background:` **shorthands** (`background: var(--bg-elev,
transparent)` at [dashboard.css:104](../../web/07_mining_pool_public/public_html/css/dashboard.css#L104),
and ~40 more). A `url(…)` value therefore becomes an outbound request from every page that renders
it — the admin login page among them, which reports each visit, with an attacker-chosen path, to an
attacker-chosen origin. CSS cannot capture a keystroke; §J1-1 already recorded why that is not the
bar (*"it can hide the 2FA prompt or overlay a misleading form"*).

**Fixed, both halves that live in this session's scope:**

- `custom_theme` added to `STEP_UP_SETTINGS_KEYS`
  ([index.js:6311+](../../web/07_mining_pool_public/back-end-pool/index.js#L6311)), with the reason
  written at the entry so it is not tidied out as a branding field.
- The validator now requires a flat object; ≤200 entries; keys matching
  `/^[A-Za-z0-9_-]{1,64}$/` **and not starting with `-`** (a leading `-` is the one shape
  `applyTheme` passes through raw, and `setProperty('-webkit-…')` sets a *real* property, not a
  custom one); string/number values ≤200 chars; and no `url(`, `expression(` or angle brackets.
  An imported `--accent` is normalised to `accent` rather than rejected.

**Deliberately NOT normalised to the `--` form.** The admin theme builder stores keys un-prefixed
(`THEME_VARS` / `data-var` at
[settings-common.js:621–644](../../web/07_mining_pool_public/back-end-pool/admin-panel/settings-common.js#L621))
and reads them back by that exact name. A first draft of this fix rewrote keys to `--accent`, which
would have made `populateThemeBuilder()` miss every saved colour and the next Save silently wipe the
operator's theme. The stored shape is unchanged, so there is no migration and no spurious step-up
prompt on the first save after this change.

**Handoff to §J15:** the `branding.js` half is not fixed here — `custom_theme` still applies on
credential pages. The validator now bounds what can be in it, but the structural fix is to move the
`custom_theme` loop *inside* the existing `isCredentialPage()` block, next to `custom_css`. That is
§J15's file, and `test-branding-sinks.js` already has the jsdom harness and the section-[2] pattern
to assert it.

---

### J9-4 — [Medium] Three settings validators guard on `isNaN()`, so `min_withdrawal = Infinity` persists — every payout rail refuses forever, it survives restart, and the admin panel renders it as an empty field — **FIXED 2026-09-02**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J9-4).**

### J9-5 — [Low] §J1-6 and §J7-8's prototype-walking schema lookups — **FIXED 2026-09-02**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J9-5).**

### J9-6 — [Low] The `.config.sha256` integrity check overwrites its own baseline on the same startup that detects tampering, so the evidence survives exactly one restart — **OPEN**

**Threat actor: on-box root** — which by rule 7 is an Info note, except that this control's entire
reason to exist is to detect that actor, and §B's residual-risk section accepts on-box compromise
as catastrophic precisely because tamper-*evidence* is one of the few things left.

```js
const configHash = hashConfig(config);
const hashFile = '.config.sha256';
if (fs.existsSync(hashFile)) {
  const savedHash = fs.readFileSync(hashFile, 'utf-8').trim();
  if (savedHash !== configHash) {
    console.warn('[SECURITY] Config file modified since last startup! Verify changes are intentional.');
  }
}
fs.writeFileSync(hashFile, configHash, 'utf-8');
```
([index.js:405–413](../../web/07_mining_pool_public/back-end-pool/index.js#L405))

Five things are wrong with it, in descending order:

1. **It re-anchors to the tampered value unconditionally.** The `writeFileSync` is outside the
   `if`, so the mismatch is reported once and the new hash becomes the baseline. Restart again and
   the pool reports clean. An attacker who edits `pool.json` and restarts twice — or who edits it
   while the service is already restarting for another reason — leaves no trace at all.
2. **The only output is `console.warn`.** No `alerts` row, no `admin_audit_log` row, nothing on the
   admin dashboard. Per §J8-3 the alert delivery channels are inert anyway, so nothing reaches the
   operator off-box. It lands in the journal beside the startup banner and scrolls away.
3. **It hashes the wrong object.** `hashConfig` runs on the **merged** config — `mergeEnvVars`
   output, so the systemd `PORT`/`HOST` environment and every per-network default are inside the
   hash. A unit-file edit or a toolkit upgrade that adds a default key trips it. A detector that
   cries wolf on routine maintenance is one the operator learns to ignore, which makes #1 and #2
   worse rather than being a separate problem.
4. **It covers the wrong values.** It runs *before* `mergeDbSettings`
   ([index.js:405 vs 423](../../web/07_mining_pool_public/back-end-pool/index.js#L423)), so
   `pool_fee_percent`, `min_withdrawal`, `withdrawal_fee`, the confirm depths and the Nostr NIP-05
   allowlist — every value that governs money at runtime — are outside its coverage. Those live in
   `pool_config`, where the real integrity control is §J1-2's audit row.
5. **The baseline is stored in a different directory from the file it describes.** `hashFile` is
   relative, so it resolves against the unit's `WorkingDirectory=$POOL_APP_DIR`
   (`/opt/grin/pubpool/<net>/`), while the config is `GRIN_POOL_CONF=/opt/grin/conf/grin_pubpool*.json`
   ([07_grin_mining_public_pool.sh:640–644](../../scripts/07_grin_mining_public_pool.sh#L640)).
   Redeploying the app directory drops the baseline, and `existsSync` then makes the check a silent
   no-op — the same "absent reads as clean" shape as #1.

**Not fixed — the useful version is a different control, not a patch.** The minimal honest change
is: hash the raw file bytes rather than the merged object, keep the baseline beside the config,
refuse to overwrite it on a mismatch (write `.config.sha256.new` instead), and raise an `alerts`
row so it reaches the dashboard §J5-8 built. That is four decisions about operator workflow — in
particular whether a mismatch should keep warning on every restart until the operator acknowledges
it, which is the only version that actually detects anything. The alternative, equally defensible,
is to delete the check: it is 9 lines that currently provide reassurance rather than detection, and
§J1-2's audit trail already covers the settings that matter.

---

### J9-7 — [Low] The pool's only fail-open security switch failed open in complete silence — **FIXED 2026-09-02**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J9-7).**

### J9-8 — [Low] The `applyToConfig` coverage sweep the plan asked for: 13 more keys that round-trip through the UI and reach no consumer, and no length cap on any settings value — **OPEN**

**Threat actor: the system.** Operator deception and unbounded growth, not privilege.

§J5's handoff asked for a mechanical check: *"every key in `PoolSettings.defaults` that is neither
in `applyToConfig` nor read directly from `pool_config` by a consumer."* §J8's asked for it
per-section rather than per-key. Both, run over `index.js` + all 40 `lib/` modules + the consumer
half of `pool-settings.js`:

| Section | Keys | Reached by a consumer | Dead / shadowed |
|---|---|---|---|
| `pool_info` | 14 | 10 | **4** — `pool_visibility`, `address_whitelist`, `max_miners`, `mining_mode` → **J9-1, DELETED this session** |
| `branding` | 24 | 20 | 4 — `logo_file`, `logo_dark_file`, `favicon_file`, `pool_theme` (superseded by AssetManager / `default_theme`) |
| `seo` | 16 | 15 | 1 — `og_image_file` (as above) |
| `analytics` | 12 | 12 | 0 |
| `payout` | 20 | 17 | **3** — `auto_payout`, `payout_frequency`, `withdrawal_retry_delays` |
| `access` | 11 | 7 | **4** — `invite_codes_enabled`, `invite_codes` (**DELETED this session**, with J9-1), plus `admin_ip_allowlist` / `admin_ip_blacklist` (§J1-5, still open) |
| `alerts` | 9 | 0 | **9** — the whole section, §J8-3, still open |
| `incentives` | 20 | 19 | 1 — `lottery_min_shares` (documented legacy) |
| `notices` | 4 | 4 | 0 |
| `database` | 7 | 7 | 0 |
| `pages` | 6 | 0 | legacy — the `pages` CMS table superseded it; `db.js migratePagesFromConfig` reads it once, behind a marker |

New in this pass, beyond J9-1 and the two already-open items:

- **`payout.auto_payout` + `payout.payout_frequency`** — an automatic-payout switch and a
  `manual|hourly|daily|weekly` schedule, both with a UI, both read by nothing. There is no
  auto-payout loop in `withdrawal-scheduler.js`; every payout starts from a miner request or an
  admin action. The default is `false`/`manual`, so the *safe* direction is the one that works: an
  operator who turns it on gets nothing, never the reverse. Low — but it is a money-settings field
  promising automation the pool does not have.
- **`payout.withdrawal_retry_delays`** — editable in the panel, validated by nobody, and shadowed:
  `applyToConfig` never copies it, so the scheduler keeps reading `pool.json`'s array. A third
  variant of the §J5-9 shape (validated by nobody *and* applied by nobody).
- **`access.invite_codes_enabled` + `invite_codes`** — same shape as §J1-5's two orphans, in the
  same section. **Deleted with J9-1** rather than waiting on §J1-5: they are the same unbuilt
  gated-membership idea as the whitelist keys, so they belonged to that decision, not to §J1-5's
  IP-allowlist one.

> **Update 2026-09-25 (Tor payout hardening F4, impl §10.8 / D10). The table and bullets above
> are left as this session found them.** `payout.auto_payout` and `payout.payout_frequency` are
> **DELETED**. Their inputs, defaults and the `payout_frequency` validator went in one change.
> Stored rows stay inert, and `test-admin-guards.js` `[7]` proves such a pool still loads and
> saves. Recounted 2026-09-25 against the live `PoolSettings.defaults.payout`: the `payout` row
> now reads **20 keys, 19 reached, 1 shadowed**. Sixteen are reached through `applyToConfig`,
> including the new `tor_send_mode`. The four `dormancy_*` keys are read directly by
> `lib/dormancy.js`. The key count is 20 again only by coincidence: keys added since this session
> ran (`slatepack_ttl_minutes`, `tor_send_mode` and others) replaced the ones deleted.
> **`withdrawal_retry_delays` stays OPEN**, with one correction to its bullet: it is **not**
> editable in the panel. No admin page carries that id (grepped 2026-09-25), so it is reachable
> only by a raw `PUT` of the payout section. The bullet's substance stands: it is validated by
> nobody and applied by nobody.

**No length cap anywhere.** This answers §J7-10's question. `updateSection` bounds *count* in three
places (`extra_banned_passwords` 500, `nostr_relays` 6, `nostr_nip05_domains` 20) and *length* in
two (`title_template`, `home_title`, 120 chars). Every other value — `custom_css`,
`custom_head_html`, `custom_body_html`, `pool_description`, `footer_text`, the `pages` HTML — is
capped only by `express.json()`'s default 100 KB body limit
([index.js:228](../../web/07_mining_pool_public/back-end-pool/index.js#L228)). That limit is
**per request**, not per value or per section, so successive writes accumulate: roughly 40 of those
keys are republished by `buildPublicConfig()` at `/api/public/branding`, which every public page
fetches on every load. **Handoff to §J12:** the bound on that response is an admin-set,
multi-megabyte number, and §J12 owns whether that endpoint is cached or rate-limited.

`custom_theme` gained a cap in this pass (J9-3). The rest is one line each and belongs in a single
deliberate sweep alongside whatever is decided about the dead keys, not tacked on here.

---

### J9-9 — [Info] Verified correct, with evidence — including four inbound handoffs answered

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J9-9).**

### Handoffs

- **§J15 (public front-end)** owns J9-3's second half: `custom_theme` still applies on credential
  pages because `applyTheme()`'s loop sits above `isCredentialPage()`. The fix is to move the loop
  inside that block beside `custom_css`; `test-branding-sinks.js` section [2] is where the assertion
  goes. While in `branding.js`: `accent_color` is applied through the same `setVar` and is likewise
  unguarded, but it is regex-validated to `#xxxxxx`, so it is a colour and nothing else.
- **§J6 (stratum & share intake)** owns option (b) of J9-1 if that is the direction chosen — the
  visibility/whitelist/cap check belongs beside the `is_banned` gate at
  [stratum-server.js:563](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L563),
  and that session should rule on the per-login read cost and on whether a refusal message leaks
  whitelist membership.
- **§J12 (rate limiting & resource exhaustion)** owns the consequence of J9-8's missing length caps:
  `/api/public/branding` republishes ~40 operator-authored strings, each bounded only by a 100 KB
  per-request body limit, on an endpoint every public page hits on every load.
- **§J13 (outbound calls & SSRF)** — one confirmation for its `nostr_nip05_domains` question: the
  validator normalises to lowercase bare hostnames, rejects IPv4 literals, leading/trailing dots and
  `..`, and caps at 20
  ([pool-settings.js:862–874](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L862)).
  An empty list falls back to `['goblin.st']`, never to "allow all". The relay list (`nostr_relays`)
  is `wss://`-only but has no host allowlist, which is J13's to rate.
- **§J16 (deployment & infra)** owns two from J9-6: `.config.sha256` is written to
  `WorkingDirectory` while the config it describes lives in `/opt/grin/conf/`, so an app-directory
  redeploy silently disarms the check; and if the control is kept, the baseline belongs beside the
  config with the same `0600` treatment.
- **§J17 (operational gate)** — J9-1 is a launch-blocking *documentation* item whichever way it is
  resolved: if the keys are deleted, the admin UI changes; if they are enforced, a private-pool
  login refusal has never been exercised against a real miner.

### Verification

Every finding was written from reading first, then demonstrated. The demonstrations ran as one-shot
`node -e` calls or a single scratchpad script against the real modules — no server was started and
nothing was left running (CLAUDE.md's local-process rule).

- **J9-1** — a full-tree grep for all four key names across `web/07_mining_pool_public/`
  (`*.js`, `*.html`, `*.json`, `node_modules` excluded); every hit hand-classified. The absence is
  the finding, so it was established by exhaustion rather than by a positive test.
- **J9-2** — `settingValueUnchanged` was `eval`'d out of `index.js` itself (not retyped) and run
  against the real `pool_info.pool_fee_percent` validator, before and after the fix.
- **J9-3** — `branding.js` read line by line to locate the `isCredentialPage()` boundary;
  `dashboard.css` grepped for `background…var(--…)` to establish the `url()` sink; the theme
  builder's `data-var` shape read out of `settings-common.js` *before* choosing the stored form.
- **J9-4** — every numeric validator in the schema run against `'Infinity'` and `'1e400'`; the
  three that accepted them traced through `applyToConfig` to their consumers.
- **J9-5** — all five prototype names run through `getSection`, `updateSection` (section and key)
  and `resetSection` against the real class with a stub `db`.
- **J9-8** — the dead-key table was generated mechanically (concatenate `index.js` + all 40 `lib/`
  modules + the consumer half of `pool-settings.js`, then test each key name for a mention), and
  every row was then hand-checked — because a mention inside `STEP_UP_SETTINGS_KEYS` counts as a hit
  to a grep and is not a consumer, which is exactly how J9-1 hid.

**Suites, all green after the changes:** `test-admin-guards` 53 (was 26; **27 new §J9 assertions**),
`test-money-path` 32, `test-auth-hardening` 48, `test-block-ledger` 52, `test-branding-sinks` 18,
`test-stratum-guards` 47, `test-owner-gate` 19, `test-proxy-v2` 12, `check-syntax` 56 files.

**Gaps worth stating.** (1) **Nothing here ran against a live settings write over HTTP.** J9-2's
bypass was proved at the function level; the route wrapping it (`criticalSettingChanged` →
`stepUpRefused`) was read, not exercised, because no session harness exists — the same gap §J7 and
§J8 recorded. (2) **J9-1 was proved by absence, and the deletion is now the proof.** The original
worry was that enforcement might live somewhere no grep for those four key names would reach — a
value read through a variable, or in the shell. Deleting the keys converts that from an unproven
negative into a positive: nothing in the tree references them, `check-syntax` covers all 56 files,
and the eight suites pass. §J17 no longer needs a private-pool mining attempt. (3) **J9-6's point 5 (the baseline
directory) is read from the installer, not observed** — no box has been checked.

### Changed this session

| File | Change |
|---|---|
| `index.js` | J9-2 — `settingValueUnchanged`'s numeric branch now requires `plainDecimal` on both sides · J9-3 — `custom_theme` added to `STEP_UP_SETTINGS_KEYS` · J9-7 — `totpIsMandatory`'s fail-open catch logs, throttled to 1/min via `_totpMandatoryReadFailAt` |
| `lib/pool-settings.js` | J9-5 — `hasSection` / `hasKey` own-property helpers, used at all four schema gates · J9-4 — `min_withdrawal` and the `nonNeg` factory use `Number.isFinite` · J9-3 — `custom_theme` validator: flat object, ≤200 entries, key charset with no leading `-`, string/number values ≤200 chars, no `url(` / `expression(` / `<>`; stored un-prefixed to preserve the theme builder's round-trip |
| `scripts/test-admin-guards.js` | New section `[5] §J9` — 27 assertions across J9-2 (5), J9-4 (5), J9-5 (11) and J9-3 (5, including the theme-builder round-trip control); `custom_theme` added to the section-[4] gated-key list · J9-1 — the 4-key gated assertion replaced by 12 that hold the six deleted keys out of both `defaults` and the step-up set |
| **J9-1 deletion** | `lib/pool-settings.js` (defaults ×2, validators, `buildPublicConfig`), `index.js` (`STEP_UP_SETTINGS_KEYS`), `admin-panel/settings-pool-info.html`, `admin-panel/settings-access.html`, `admin-panel/settings-common.js` — itemised in the table in J9-1 |

**Left open at the end of this session:** **J9-6** (keep the integrity check and make it a real
one, or delete it; the current 9 lines provide reassurance rather than detection). **J9-8's** dead keys are one line each and belong in a single
sweep with §J1-5 and §J8-3, not tacked onto this pass.

---

## §J10 — Uploads, assets, CMS & ads (2026-09-02, add-ons, NOT VPS-TESTED)

Tenth session of the pre-mainnet §J pass (see the Status roll-up at the top of this file).
Scope: `lib/asset-manager.js` (190), `lib/ads.js` (426), `lib/pages.js` (140),
`lib/posts.js` (333), the two upload endpoints (`POST /api/admin/assets/upload`,
`POST /api/admin/media`), `DELETE /api/admin/assets/:filename`, both multer configs, the
`/uploads` static handler, and the CMS/SEO public surface — `/blog/:slug`, `/page.html`,
`/blog/rss.xml`, `/sitemap.xml`, `/robots.txt`, `/manifest.json`,
`/api/public/{page/:key,pages,posts,post/:slug,ads}` and `POST /api/public/ads/event`.

Method: follow a byte from the wire to the disk to the browser. For each upload endpoint —
what multer accepts, what decides the name on disk, what decides the `Content-Type` it is
served back with, and what header is on that response. For the CMS — every place operator
text or a URL segment leaves the DB and reaches XML, an HTML attribute, or a filesystem path.

**Headline — §A's two upload defences were never applied to the second upload endpoint, and
the pool ships pointing every canonical link at a domain the operator does not own.**

*The delete traversal the plan asked about first is genuinely closed*, and the sandbox CSP on
served uploads is genuinely on both serving paths (nginx *and* the Express fallback). Those
were checked, not assumed (J10-6).

*But `POST /api/admin/media` — the CMS editor's image upload, added after §A — repeats §A
finding #1 and #3 exactly.* It never looked at a single byte of the file, and it took the
stored extension from the client-declared MIME. The extension is what nginx converts into the
served `Content-Type`, so `Content-Type: image/svg+xml` on a file of arbitrary bytes produced a
`.svg` served as `image/svg+xml`. §A built two layers against that (validate the bytes, then
isolate at serve time); this endpoint had one, and nothing said so.

*And the setting that decides where the operator's own content says it lives shipped with
someone else's domain in it.* `seo.site_url` defaulted to `https://grinium.com`, and nothing —
not the installer, not first boot — ever replaced it. Every fresh pool's `sitemap.xml`, RSS
feed, server-rendered `<link rel="canonical">`, `og:url` and JSON-LD `url` named that host
(J10-4).

*The one anonymous write in this scope is a billing record.* `POST /api/public/ads/event`
bumps the impression and click counters the admin panel renders a CTR from, with no existence
check, no dedup and no cap — the dedup that makes those numbers mean anything lives in the
browser (J10-3).

Five findings plus an Info sweep. **Three fixed in this session** (J10-1, J10-4, J10-5 — all
small and local, plan rule 3) with a new 21-assertion suite, `scripts/test-cms-uploads.js`.
**J10-2 and J10-3 are left open**: one needs a table and a UI, the other is a product decision
about whether ad statistics may cost the pool's no-visitor-data stance.

### Threat actors used in this section

| Label | Means |
|---|---|
| **Anonymous internet** | Anyone who can reach the public API. No credential of any kind |
| **Stolen admin session** | A `secureAdmin` access token taken from an operator's browser. Per §C3 it survives logout, password change and *Revoke sessions* until it expires (≤24 h) |
| **Logged-in admin** | A legitimate `secureAdmin` session — including a second, less-trusted one. Cannot move money at this tier, so a finding here is a foothold or a durable mess, not theft |
| **Third-party domain holder** | Whoever controls a hostname the shipped defaults point at. Today the toolkit author; after an expiry, whoever buys it |

### Findings

### J10-1 — [Medium] The CMS media endpoint took the stored file extension from the client-declared MIME and never read a byte of the file, so §A's stored-XSS fix was absent from the second upload endpoint — **FIXED 2026-09-02**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J10-1).**

### J10-2 — [Medium] A file uploaded to `/uploads` has no DB row, no listing, no delete path and no audit row, so it cannot be attributed or removed through the product at all — **OPEN**

**Threat actor: stolen admin session**, with **logged-in admin** (a second, less-trusted one) as
the disk-fill case.

The two upload endpoints are asymmetric in a way that only shows up after an incident:

| | `POST /api/admin/assets/upload` | `POST /api/admin/media` |
|---|---|---|
| DB row | `pool_assets`, with `uploaded_by` = the admin's user id | **none** |
| Listed anywhere | `GET /api/admin/assets` → the branding settings previews | **nowhere** |
| Deletable | `DELETE /api/admin/assets/:filename` (unlinks + removes the row) | **no endpoint exists** |
| `admin_audit_log` row | no (§J1-2, one of the 24 still open) | no |
| Size / count cap | 2 MB, 1 file per request, no total | 5 MB, 1 file per request, no total |

Nothing in the backend so much as `readdir`s that directory — the only `readdirSync` in the tree
is in `scripts/check-syntax.js`. So an attacker on a stolen `secureAdmin` session can write 5 MB
of arbitrary (now image-shaped, post-J10-1) content per request under the operator's own TLS
hostname, served with `Cache-Control: public, max-age=604800, immutable`, and:

- the operator cannot list what is there from any screen the product ships;
- the operator cannot delete it without an SSH session and `rm`;
- nothing records that an upload happened, when, or by which admin.

It is also the only unbounded write to the filesystem the app has. `uploadsDir` defaults to
`path.dirname(config.db_path)/uploads` ([index.js:515](../../web/07_mining_pool_public/back-end-pool/index.js#L515))
and the installer places it inside `$POOL_APP_DIR` beside `pool.db`, so filling it fills the
partition holding the SQLite database and its WAL — and §J7-1 established that the block-found
write discards its own failure, with no alert anywhere. That is a long path from an image upload
to a lost block, but it is the same disk.

**Not exploitable by an anonymous client**, hence Medium rather than High.

**Fix (not applied — structural).** Give media uploads the same treatment assets already have:
a `media_uploads` row (`filename`, `original_name`, `mime_type`, `size_bytes`, `uploaded_by`,
`created_at`), a `GET`/`DELETE` pair, and a small library screen in the CMS editor. The audit row
belongs in the §J1-2 sweep, not bolted on here. A total-bytes cap on the directory is one query
against that new table, so it falls out of the same change.

---

### J10-3 — [Medium] `POST /api/public/ads/event` lets any anonymous client set the impression and click counters the operator bills sponsors from — no existence check, no dedup, no cap — **OPEN**

**Threat actor: anonymous internet.** Specifically: a sponsor inflating the delivery numbers
they are invoiced on, or a rival tanking a competitor's click-through rate.

`recordEvents` ([ads.js:157-171](../../web/07_mining_pool_public/back-end-pool/lib/ads.js#L157-L171)):

```js
const ids = (v) => [...new Set((Array.isArray(v) ? v : []).map(x => parseInt(x, 10))
  .filter(n => Number.isInteger(n) && n > 0))].slice(0, 20);
…
this.db.prepare(`UPDATE ads SET ${col} = ${col} + 1 WHERE id IN (…)`).run(...list);
```

The sanitising is real — ids are integers, deduped and capped at 20 per request, and `col` is a
code literal, so there is no injection and no unbounded row growth. What is missing is any notion
of whether the event *happened*: no check that the ad is `is_active`, in its date window, or in
the placement the caller claims; no per-client dedup; no cap on how many times one source may
bump one id; no audit; and the response is always `204`
([index.js:2751-2755](../../web/07_mining_pool_public/back-end-pool/index.js#L2751-L2755)).

**The dedup that makes these numbers mean anything is client-side.** `queueImpression` keeps a
`_counted[id]` map for the life of the page load and only beacons ids it has not sent
([public_html/js/ads.js:104-114](../../web/07_mining_pool_public/public_html/js/ads.js#L104-L114)),
and the rotor deliberately does not count an ad in a background tab (`:202`, `:227`). All of that
is enforcement in the attacker's own browser.

**Failure scenario.** An operator sells a header slot for a month at an agreed CPM. The buyer —
or anyone who reads `GET /api/public/ads` and sees the ids — posts
`{"impressions":[1,2,…,20]}` in a loop. nginx allows 600 requests/min per IP on `/api/`
([07_grin_mining_public_pool.sh:1050](../../scripts/07_grin_mining_public_pool.sh#L1050)) and the
app's `public` bucket allows 1200/min, so one IP moves the counters ~200,000 times an hour, and a
handful of hosts moves them arbitrarily. The admin panel renders exactly those two columns and
computes the percentage from them, with no indication they are unverified:

```js
const v = a.impressions || 0, c = a.clicks || 0;
const ctr = v > 0 ? ` (${(c / v * 100).toFixed(1)}%)` : '';   // admin-panel/ads.html:601-603
```

Inflating impressions alone drives the displayed CTR toward zero, which is the *deflation* half
of the same lever.

**No funds move**, and nothing here is a foothold — hence Medium, on the pool's commercial
integrity rather than its security. But the counter is the invoice.

**Fix (not applied — this is a product decision).** The honest options, in order of cost:

1. **Say what they are.** One line under the table: *"Coarse client-reported counters — not
   verified, not billable."* Zero code, and it stops the number being trusted for money.
2. **Filter to plausible events.** `AND is_active = 1 AND (start_at IS NULL OR …)` in the
   `UPDATE`, so an ad that is not being served cannot accrue. Cheap, and it does not stop a
   determined client.
3. **Bound one source.** A per-(IP-hash, ad, hour) seen-set, which is the only thing that
   actually fixes it — and which costs the pool a per-visitor record. Memory
   `project_pool_ip_privacy` and this endpoint's own comment ("no per-visitor rows, no IPs")
   both say the pool has decided against that. **The pool cannot have both trustworthy ad
   statistics and no visitor records, and option 1 is the consistent choice.**

**Disposition taken 2026-09-03 (§J14-9's follow-up pass): options 1 + 2, and this finding stays
OPEN.** The admin column now reads `Views / Clicks (unverified)` with a `(~x.x%)` ratio and a
note saying the numbers are client-reported and never billable (option 1), and `recordEvents`
now carries `publicByPlacement`'s serving predicate so an ad that is not being shown cannot
accrue events (option 2). **Option 3 is declined** — a per-(IP-hash, ad, hour) seen-set is the
per-visitor record this pool does not keep — so the endpoint remains anonymous-writable and a
*live* ad can still be inflated. What changed is that nothing presents its output as
measurement any more; the risk is now cosmetic rather than money-adjacent. Reversing the
decision means changing `ads.html`'s wording back too: the label and the endpoint are one
decision in two files.

---

### J10-4 — [Medium] `seo.site_url` shipped as `https://grinium.com`, so every fresh pool declared a domain the operator does not own as the canonical home of the operator's own content — **FIXED 2026-09-02**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J10-4).**

### J10-5 — [Low] `POST /api/admin/assets/upload` with no `?type=` defaulted to `'custom'`, which is not an asset type, so the request always failed with an error naming an internal constant — **FIXED 2026-09-02**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J10-5).**

### J10-6 — [Info] Verified correct, with evidence

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J10-6).**

### Handoffs

- **§J11 (public API leakage & privacy) — the one that should not wait.** The same defaults block
  that produced J10-4 also ships `analytics.provider: 'ga4'` with
  `analytics.ga_tracking_id: 'G-GMYJ4PVG4L'`
  ([pool-settings.js:167-169](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L167)).
  Read literally, every pool deployed from this toolkit beacons every visitor of every public page
  to one fixed third-party GA4 property until the operator notices and changes it — on a product
  whose stated position is scrypt-hashed miner IPs, country-only geo and "no per-visitor rows".
  That is J11's to rate and fix, because the sink is `branding.js`'s analytics loader and the
  question is a privacy one, not a CMS one; J10 records only that the default exists and comes
  from the same place as J10-4. The plausible/umami/matomo defaults are empty, so this is GA4 only.
- **§J12 (rate limiting & resource exhaustion)** owns two: multer's unset `fields`/`parts`/
  `fieldSize` limits on both upload endpoints (row above), and J10-2's unbounded filesystem
  growth if that session is inventorying what can fill the disk the SQLite DB sits on.
- **§J14 (admin panel front-end)** owns the rendering half of J10-3: `admin-panel/ads.html:601-603`
  presents anonymous-writable counters as a measured CTR with no qualifier. If option 1 is taken,
  the wording change lands there.
- **§J15 (public front-end)** owns the client-side consumers of everything in this scope:
  `js/ads.js` inserting `html_code` via `innerHTML` and re-creating `<script>` nodes so ad-network
  snippets execute (`:116-118` — operator-trusted by design, tier already settled in §J1-1), and
  `branding.js`'s canonical/JSON-LD block now that J10-4 changed what feeds it.
- **§J16 (deployment & infra)** — one confirmation and one question. Confirmed: nginx serves
  `/uploads/` and `/custom/` directly and both blocks carry the sandbox CSP, so the plan's
  "does nginx bypass Express?" concern is answered *yes, and it is covered*. Question: those two
  blocks use `alias` together with `try_files $uri =404`, a combination with a long-standing
  nginx interaction; whether it resolves against the alias or the server `root` was **not**
  established here and needs a real box, not a reading.
- **§J1-2's audit sweep** gains one route it did not name: `POST /api/admin/media` writes no
  `admin_audit_log` row either, and per J10-2 it is the only admin write with no record of any
  kind anywhere.

### Verification

Every finding was read first and then demonstrated. Demonstrations ran as one-shot `node` calls
against the real modules from a scratchpad directory outside the repo; no server was started and
nothing was left running (CLAUDE.md's local-process rule).

- **J10-1** — the *verbatim* pre-fix multer config was driven with a synthetic multipart body
  through a `PassThrough` acting as the request, which is how the `notes.txt` → `notes.svg` output
  quoted above was produced. After the fix the same harness was re-run over nine cases: the five
  accepted image types all still round-trip with unchanged extensions (`image/jpeg` → `.jpg`, as
  before), the three polyglots are rejected at the sniff, and a PNG declared `text/html` is
  rejected earlier at the filter.
- **J10-4** — established by exhaustion, which is the only way to prove *nothing* sets a value:
  a full-tree grep for `site_url` across `web/07_mining_pool_public/` and `scripts/`, every hit
  hand-classified (default, validator, `buildPublicConfig`, `siteOrigin`, `branding.js`). The
  Host-header consequence of the naive fix was checked against the generated vhost before choosing
  the `config.subdomain` ordering.
- **J10-3** — the client-side dedup was read out of `public_html/js/ads.js` to establish that the
  server has no counterpart, and the CTR computation read out of `admin-panel/ads.html` to
  establish that the numbers are presented as measured. The rate ceiling is the nginx `_api` zone
  and the app's `public` bucket, both read from source rather than estimated.
- **J10-6's prototype-walk row** — the truthy-lookup half was confirmed with a one-shot over all
  five `Object.prototype` names; the unreachability half by reading busboy's part-header parser,
  not by assuming.
- **`parseInt` → `NaN`** — tested against `node:sqlite` directly rather than reasoned from §J7-4,
  which is why it is in the verified-correct table instead of being written up as a finding.

**Suites, all green after the changes:** `test-cms-uploads` **21 (new)**, `test-admin-guards` 65,
`test-money-path` 32, `test-block-ledger` 52, `test-stratum-guards` 47, `test-branding-sinks` 18,
`test-owner-gate` 19, `test-proxy-v2` 12, `check-syntax` **57 files** (was 56).

**Gaps worth stating.** (1) **No HTTP request was made to any of these routes.** J10-1's before
and after were proved by driving multer itself; the `secureAdmin` chain in front of it was read,
not exercised — the same session-harness gap §J7, §J8 and §J9 each recorded. (2) **The serve-time
half of J10-1 is unobserved.** That `.svg` is served as `image/svg+xml` follows from nginx's
stock `mime.types`, and that the sandbox CSP arrives with it follows from the generated vhost;
neither has been seen on a box, and §J16's `alias`/`try_files` question above is part of the same
unknown. (3) **J10-4's fix depends on `config.subdomain` being populated**, which the installer
does at nginx-setup time — a pool configured by hand, or one where nginx setup was skipped, still
falls through to the Host header.

### Changed this session

| File | Change |
|---|---|
| `lib/asset-manager.js` | J10-1 — `WEBP_SNIFFER` added as a standalone signature (deliberately **not** in `SNIFFERS`); `detectImage(buffer, extra = [])` takes a per-caller widening list; both exported as statics on `AssetManager` |
| `index.js` | J10-1 — `mediaUpload` switched to `memoryStorage`, `ALLOWED_IMG` demoted to a `hasOwnProperty`-checked pre-filter, and `POST /api/admin/media` now sniffs the buffer, derives the extension from the detected type, asserts path containment and writes the file itself · `uploadsDir` is `path.resolve`d so that assert compares like with like · J10-4 — `siteOrigin()` gains the `config.subdomain` branch ahead of the Host header, and `/api/public/config` applies the same derivation to `cfg.seo.site_url` · J10-5 — `?type=` validated against `allowedTypes` up front, error names the valid set |
| `lib/pool-settings.js` | J10-4 — `seo.site_url` default changed from `'https://grinium.com'` to `''`, with the reasoning in place |
| `scripts/test-cms-uploads.js` | **New** — 21 assertions: [1] the extension comes from the bytes (12, incl. the HTML/text/PDF/runt rejections and binary-beats-SVG ordering), [2] WEBP widens the CMS endpoint only (4), [3] no `seo` default hardcodes an origin (3), [4] the asset-type allowlist (2) |
| `package.json` | `test:unit` runs the new suite |

**Left open at the end of this session:** **J10-2** (needs a `media_uploads` table, a list/delete
pair and a library screen — and its audit row belongs in the §J1-2 sweep) and **J10-3** (a product
decision: trustworthy ad statistics cost the pool a per-visitor record, so the consistent answer is
to label the counters rather than to fix them).

---

## §J11 — Public API leakage & privacy (2026-09-02, add-ons, NOT VPS-TESTED)

Eleventh session of the pre-mainnet §J pass (see the Status roll-up at the top of this file).
Scope: every unauthenticated route — `/api/public/*`, `/api/pool/*`, `/api/stratum/*`,
`/api/network/*`, `/api/config/*`, the public `/api/account/:addr` GETs, `/health`,
`/robots.txt`, `/sitemap.xml` — plus `lib/geoip.js` (172), `lib/retention.js` (209) and
`lib/ip-filter.js` (299).

Method: for every public route, list what leaves the box field by field, then ask the only
question that matters at mainnet — **what does one anonymous client hold after an hour of
polite polling?** Where a privacy control exists (the address mask, the k-anonymity floor, the
network-map gate, scrypt-hashed IPs, coarsened audit IPs), check it at the **write** side and
then try to defeat it from outside using nothing but other public routes.

**Headline — the pool's address mask is a display truncation that six sibling feeds invert,
and every confirmed payout is published with the miner's full Grin address next to its
on-chain kernel excess.**

*The privacy controls the pool built are real and correctly implemented.* Miner IPs are
scrypt-hashed at the moment of capture, audit IPs are coarsened at write, geo resolves to a
country and discards the address, the peer digest never leaves the DB, the network-map feeds
404 when unpublished with a k-anonymity floor applied before the points are built, and (at the
time) the sample globe was labelled — since 2026-09-13 there is no sample globe and the feeds
default to published, see the note under §J11-8's fix. All of that was checked with evidence
(J11-8), not assumed.

*What defeats them is the surface next door.* `/api/pool/miners` was masked in response to §C1
— but `/api/pool/blocks`, `/api/pool/top-block-finders`, `/api/pool/payments`,
`/api/pool/donors`, `/api/stratum/top-miners` and `/api/stratum/top-avg-hashrate` all publish
the same population's **full** addresses, in bulk, at 1200 requests a minute. The mask keeps
9 leading and 4 trailing bech32 characters, which is a unique key — so every masked row
re-attaches to its full address with a table join (J11-1). The sharpest consequence is
`/api/pool/unclaimed`, whose masked rows are a list of *provably unwatched* balances with a
disposal countdown.

*And one field is worse than all the address exposure combined.* `withdrawals.kernel_excess`
was added so a miner could verify **their own** payout against the chain. It is also published
on the pool-wide `/api/pool/payments` feed, beside the full recipient address, where **no
consumer renders it** — a permanent, public, unauthenticated Grin-address ↔ on-chain-kernel
linkage table, on a coin whose entire product is that such a table cannot be built (J11-2).

*Separately, the shipped analytics default sends every visitor of every deployed pool to one
fixed third-party GA4 property*, with the nginx CSP already widened to permit it and no consent
banner (J11-4) — the §J10 handoff, confirmed live and fixed here.

Seven findings plus an Info sweep.

**First pass (2026-09-02):** four fixed — J11-4, J11-6, J11-7 and the pool-wide half of J11-2 —
with a new 24-assertion suite. J11-1, J11-3, J11-5 and the per-address half of J11-2 were written
up and left open, because each is a product decision about what "address as identity" is allowed
to cost rather than a bug with one right answer.

**Resolution pass (2026-09-02, same day):** the operator took those decisions and **all four are
now closed** — J11-1 on option (b), J11-2 on the ownership-gate option, J11-3 as recommended, and
J11-5 on option (a). See the [§J11 resolution pass](#j11--resolution-pass-2026-09-02-add-ons-not-vps-tested)
at the end of this section for what was built, the two things the fix itself uncovered, and what
each choice costs. The suite is now **51 assertions**, every one of them mutation-tested.

### Threat actors used in this section

| Label | Means |
|---|---|
| **Anonymous internet** | Anyone who can reach the public API. No credential of any kind. The `public` rate-limit bucket is **1200/min** ([rate-limiter.js:41](../../web/07_mining_pool_public/back-end-pool/lib/rate-limiter.js#L41)), so "an hour of polling" is 72,000 requests from one IP |
| **Chain analyst** | Anonymous internet plus a copy of the Grin chain. Does not attack the pool at all — reads it |
| **Competitor / rival farm** | Anonymous internet, interested in *who* mines here and with what |
| **Search engine / bulk crawler** | Follows links from any indexed page. Google honours `rel=canonical`; Common Crawl, Bing, and AI training crawlers largely do not |
| **Third-party property holder** | Whoever owns the analytics property the shipped defaults point at. Today the toolkit author |

### Findings

### J11-1 — [Medium] The address mask is a 9+4 truncation and six sibling public feeds publish the full addresses that invert it, so §C1's fix, the dormant-balance mask and the live-session mask are all reversible by join — **FIXED 2026-09-02 (option b; see the §J11 resolution pass — it was SEVEN feeds, not six)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J11-1).**

### J11-2 — [High] Every confirmed payout is published with the miner's full address beside its on-chain kernel excess — a permanent, public address↔chain linkage table for a privacy coin, on a feed where nothing renders the field — **FIXED 2026-09-02; pool-wide half REVERSED 2026-09-25 by operator decision (see the note below) — the per-address feed stays ownership-gated**

> **2026-09-25 — pool-wide half reversed (operator decision, add-ons, NOT VPS-tested).** The operator
> asked for a public **Tx ID** column on `payment-history.html` P-05, linking each payout's kernel to the
> chain explorer as public pool payment pages do (2miners' Tx ID column was the reference), and chose it
> knowingly over an off-by-default setting after the cost below was put to them.
> `GET /api/pool/payments` now emits `kernel_excess` again (last ≤500 confirmed payouts). What still
> holds, and is asserted by `test-public-leakage.js` §J11-2 (both mutation-checked): the address beside
> it is **masked**, and the value is emitted only when it matches `^[0-9a-f]{66}$` (else `null`; the
> `has_kernel_proof` boolean keeps its old meaning). **Cost accepted:** a chain analyst can tag every
> listed kernel as this pool's payout, with its amount and time; and because the 9+4 mask is a unique
> key (§J11-1), any other feed that ever leaks a full address re-attaches the row — the mask on this
> route is now the only thing between it and the full table this finding described. Once a mainnet
> kernel is published it cannot be unpublished. **Unchanged:** `/api/account/:addr/withdrawals` (all-time,
> full address) still sends only `has_kernel_proof`; the kernel comes from the ownership-gated POST.
> The account page's P-08 Proof column now labels its link with the truncated Tx ID (was `proof ↗`).

**Threat actor: chain analyst.** No attack on the pool is involved. This is the pool
publishing the join key.

Grin has no txid; the payment-proof primitive is the **kernel excess**, and
`withdrawals.kernel_excess` exists so a miner can verify their own payout against a chain
explorer (memory `project_pool_explorer_deeplinks`, the account page's *Proof* column). That
is a good feature on the account page. It is also on the pool-wide feed:

```
index.js:3028  SELECT id, grin_address, amount, fee_charged, method, status,
index.js:3029         created_at, confirmed_at, kernel_excess
index.js:3030  FROM withdrawals WHERE status = 'confirmed'
```

One unauthenticated GET therefore returns, for the last 500 payouts:

```
{"grin_address":"grin1qqqq…zzzz9x","amount":500,"method":"tor","confirmed_at":1788383185,
 "kernel_excess":"08c1f2d4aa9b6e5537f0e1c2b3a49586d7c8e9f0a1b2c3d4e5f60718293a4b5c6d7"}
```

**Both consumers of that endpoint drop the field.** The homepage teletype prints amount and a
truncated address ([reactor-dashboard.js:570-600](../../web/07_mining_pool_public/public_html/js/reactor-dashboard.js#L570));
`payment-history.html`'s payouts table renders time, address, amount, status
([payment-history.html:433-451](../../web/07_mining_pool_public/public_html/payment-history.html#L433)).
Nothing on any public page reads `kernel_excess` off this route. It is published and unused.

**Why this outranks every address finding in J11-1.** A Grin slatepack address is a durable
wallet identity. A kernel is a specific transaction in the public chain. Publishing the pair
gives a chain analyst a bidirectional index:

- *chain → person:* take any kernel from the Grin chain, look it up here, learn which pool
  miner received it and how much.
- *person → chain:* take any address off a leaderboard (J11-1), fetch
  `GET /api/account/<addr>/withdrawals?format=csv` — public, all-time, 50,000 rows, also
  carrying `kernel_excess` ([index.js:3643](../../web/07_mining_pool_public/back-end-pool/index.js#L3643),
  [:3669](../../web/07_mining_pool_public/back-end-pool/index.js#L3669)) — and get every
  on-chain transaction that ever paid that identity.

This is not recoverable. Mainnet balances are real, and a table scraped once is public
forever regardless of what the pool changes later. It is also a documented decision, not an
oversight: the API reference advertises "the on-chain kernel when known"
([index.js:1139](../../web/07_mining_pool_public/back-end-pool/index.js#L1139)) — one line
above the row that says the address→balance mapping "is not" public. The two lines do not hold
the same position.

**Fixed for the pool-wide feed** (small and local, and no consumer regresses): `kernel_excess`
dropped from `/api/pool/payments` and its doc row corrected.

**Left open for `/api/account/:addr/withdrawals`.** There the field *is* the product — it
backs the Proof column a miner uses to verify their own payout. Removing it removes a real
feature; keeping it public means anyone may pull anyone's kernel list. The three coherent
answers, none free:

- gate the *field* behind the ownership proof the withdraw routes already use, leaving the
  rest of the history public (the account page would need to post a proof to show Proof);
- publish it only for the requester's own address, i.e. accept that the account page needs a
  session after all — a departure from address-as-identity;
- keep it, and say plainly on the privacy page that payouts are chain-linkable by address.

This one should be decided before mainnet, not after.

**Resolution: the first option, 2026-09-02.** `kernel_excess` left the per-address JSON row and
the CSV column too (both replaced by a `has_kernel_proof` boolean), and
`POST /api/account/:addr/withdrawals/proofs` returns the kernels behind the same ownership proof
a withdrawal needs — same verifier, audited on both paths, and on the `withdraw` bucket rather
than `public`, because `verifyOwnerProof` runs scrypt and §F2 is the reason that matters. The
account page's Proof column keeps working behind a *Reveal proofs* button on the page's existing
proof box. Detail in the resolution pass below.

### J11-3 — [Medium] The account dossier is address-addressable with no login, the leaderboard hands out the addresses, and the page invites search engines to index the result — **FIXED 2026-09-02 (both halves: `noindex, follow` on the page, and J11-1 removed every link into it)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J11-3).**

### J11-4 — [Medium] Every pool deployed from this toolkit beacons every visitor of every public page to one fixed third-party GA4 property, with the CSP already widened to allow it and no consent banner — **FIXED 2026-09-02**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J11-4).**

### J11-5 — [Low] The k-anonymity floor guards the country breakdown but not the region breakdown, and the region breakdown is not behind the network-map gate — **FIXED 2026-09-02 (option a, on both the live feed and its durable history — see the §J11 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J11-5).**

### J11-6 — [Info] Express announces itself on every response, and the pool's vhost is the only toolkit vhost without `server_tokens off` — **EXPRESS HALF FIXED 2026-09-02; the nginx half is §J16's**

**Threat actor: anonymous internet.**

`app.disable('x-powered-by')` was never called — the app-setup block ran straight from
`app.set('trust proxy', …)` into `app.use(express.json())` ([index.js:226-233](../../web/07_mining_pool_public/back-end-pool/index.js#L226),
where the fix now sits), so every API response carried `X-Powered-By: Express`.
The generated vhost neither sets `server_tokens off`
nor `proxy_hide_header X-Powered-By` — verified by grep across
`scripts/07_grin_mining_public_pool.sh`, which has no occurrence of either, while sibling
products do set it
([051_grin_fidelius.sh:903](../../scripts/051_grin_fidelius.sh#L903),
[051x_grin_xp_wallet.sh:489](../../scripts/051x_grin_xp_wallet.sh#L489)).

Low value on its own — the pool's stack is not a secret, and `/api/public/endpoints` publishes
the route table by design. Worth closing because it is one line, and because it is the cheap
half of a pair whose expensive half (nginx's own `Server:` banner) belongs to §J16.

**Fixed:** `app.disable('x-powered-by')` added.

### J11-7 — [Info] Two account routes parse their window parameter without a default, so `?hours=abc` silently answers "this miner has no data" — **FIXED 2026-09-02**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J11-7).**

### J11-8 — [Info] Verified correct, with evidence

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J11-8).**

### J11-9 — [Info] Two smaller notes from the same sweep

**(a) `/api/pool/status` and `/api/pool/poolstats` publish node internals that a public Grin
node deliberately cannot answer.** `/api/pool/status` returns `node.peers` (exact count),
`node.synced` and `node.height`
([index.js:2237-2252](../../web/07_mining_pool_public/back-end-pool/index.js#L2237)), and
`/api/pool/poolstats` repeats the peer count as `network.connections`
([index.js:3539](../../web/07_mining_pool_public/back-end-pool/index.js#L3539)). All three come
from `get_status` on the node's **Owner** API. Per CLAUDE.md, a node published through Script 04
answers `get_tip` and nothing else, precisely because *"peer count and sync state are unknowable
from outside"* — so the pool re-publishes, unauthenticated, exactly what the node's own public
surface withholds. Memory `project_health_api_security` lists "exact peer count" and "block
height" under *don't expose*. Practical value to an attacker is small (height is on every
explorer; a peer count helps only someone planning to eclipse or censor this specific node) and
the poolstats feed's shape is fixed by what miningpoolstats.stream already imports — so this is
recorded, not changed. If it is ever tightened, `peers` is the field to band or drop; `height`
is genuinely public chain data.

**(b) `/api/pool/blocks` has an unbounded `offset`.** `limit` is capped at 500 but
`offset` is only floored at 0
([index.js:2271](../../web/07_mining_pool_public/back-end-pool/index.js#L2271)), and blocks are
never pruned — that is what makes the full `found_by` set walkable in J11-1. A large offset is
also a deepening `LIMIT ? OFFSET ?` scan on the synchronous DB the stratum server shares
(memory `project_pool_db_capacity`). The row cap holds, so this is not §J7-2; the cost question
is **§J12's**, listed in the handoffs.

### Handoffs

- **§J12 (rate limiting & resource exhaustion)** owns three from this sweep. (1)
  `/api/pool/blocks`'s unbounded `offset` (J11-9b) — deep-offset paging on the shared
  synchronous DB, and the mechanism that makes the J11-1 harvest cheap. (2) The `public`
  bucket at **1200/min** is what turns "the account page is public" into "the whole pool's
  dossier in under a minute" (J11-3); if J11-1 is answered with option (a) or (c), the bucket
  is the only remaining brake and should be sized for it. (3) `/api/account/:addr/withdrawals?format=csv`
  and `/api/account/:addr/balance/log?format=csv` are 50,000-row exports **for any address**,
  throttled by the `export` bucket (10/min) but not by ownership — J12 should confirm 10/min is
  the intended budget for bulk export of someone else's ledger.
- **§J14 (admin panel front-end)** — nothing new. The three admin surfaces that render a full
  address (`miners.html`, `payments.html`, the payout audit) are behind `secureAdmin` and are
  the operator's own data.
- **§J15 (public front-end)** owns the render half of two things here. (1) J11-3's
  `addrCell` — the leaderboard link is the mechanism, and if J11-1 lands on option (b) the
  change is in `miners-stats.html`, not in `index.js`. (2) **Every public HTML page hardcodes
  `pool.grin.money`** in its static `<link rel="canonical">`, `og:url`, `og:image`,
  `twitter:image` and `twitter:domain` — 7 occurrences in `account-settings.html` alone, 10 in
  `index.html`, 56 across the ten public pages. `branding.js` rewrites canonical and og:url at
  runtime from `seo.site_url` ([branding.js:237-245](../../web/07_mining_pool_public/public_html/js/branding.js#L237)),
  so a JS-capable client sees the right one — but a non-rendering crawler, an unfurling chat
  client, and any page load where `/api/public/branding` fails all see the toolkit author's
  domain. That is J10-4's bug surviving in the static half of the same surface; J10 fixed the
  setting, and the HTML was not in its scope or mine.
- **§J16 (deployment & infra)** owns the nginx half of J11-6 (`server_tokens off` /
  `proxy_hide_header X-Powered-By` — the pool's vhost is the only toolkit vhost without it) and
  should note that the generated page CSP allowlists `googletagmanager.com`,
  `*.google-analytics.com`, `plausible.io` and `cloud.umami.is`
  ([07_grin_mining_public_pool.sh:1269](../../scripts/07_grin_mining_public_pool.sh#L1269)).
  That allowlist is correct — it is what makes an operator's own analytics choice work — but
  after J11-4 it is now wider than the default configuration uses, which is the right way round
  and worth stating so a later reader does not "tidy" it away.
- **§J17 (operational gate)** — three, all cheap. (1) **Decide J11-2's per-address half before
  mainnet.** Once a real payout confirms on mainnet, its kernel is published and cannot be
  unpublished. (2) **Decide J11-1** before the first leaderboard has real addresses on it, for
  the same reason. (3) After a real install, `curl -I` any public URL and confirm
  `X-Powered-By` is gone and what the `Server:` banner says — the Express half is fixed in
  code, the nginx half is not.
- **§J6's handoff, answered.** *"Does a worker label leak rig identity a truncated address was
  meant to hide?"* — the question is moot: the truncation itself does not hide the address
  (J11-1), so `/api/stratum/stats`'s masked sessions are attributable regardless of the label.
  *"Is a live session list a mining-farm's operational intelligence?"* — yes, and the label is
  the smaller half of it. `getStats()` publishes per live session `worker_name`, `difficulty`,
  `shares`, `accepted`, `rejected`, `stale` and `online_seconds`
  ([stratum-server.js:962-971](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L962)),
  and `/api/account/:addr/workers` publishes the same inventory keyed by the **full** address
  with no mask at all. A competitor reads rig count, per-rig difficulty, hardware quality
  (reject/stale ratio) and uptime for every miner in the pool. That is folded into J11-3
  rather than reported separately, because the fix is the same decision.
- **§G / memory `project_pool_ip_privacy`** needs one amendment: its "still open —
  `/api/pool/miners` returns every miner's FULL grin address + balance (§C1)" line is now
  **wrong in the letter and right in the substance**. The endpoint masks; the mask is
  invertible (J11-1). The memory should say so, and should record that the pool's most
  consequential public linkage is not an IP at all — it is `kernel_excess` (J11-2).

### Verification

Every finding was read first and then demonstrated. Demonstrations ran as one-shot `node`
calls against the real modules from a scratchpad directory outside the repo — `initDb()` on a
temporary SQLite file, the routes' **exact** SQL, and the real `hashrate-tracker.js` — with the
temp DB deleted at the end. No server was started, nothing was left running, and no HTTP
request was made to any route (CLAUDE.md's local-process rule).

| Check | Result |
|---|---|
| `node --check` on `index.js`, `lib/pool-settings.js`, `public_html/js/branding.js` | pass |
| `scripts/test-public-leakage.js` (new, 24 assertions) | pass |
| Existing unit suites (`npm run test:unit`) | unchanged, pass |

**Gaps worth stating.** (1) **No HTTP request was made**, so the CORS middleware's behaviour,
the `X-Powered-By` removal and the 404 on the gated map routes are all read, not observed —
the same harness gap §J7 through §J10 each recorded. (2) **J11-3's crawler claim is a
reasoning result, not a measurement.** That `miners-stats.html` is in the sitemap and emits
`?addr=` links is verified in code; what any given crawler *does* with the canonical is not
something this repo can settle. (3) **J11-4's beacon was traced through five files and not
seen firing** — no page was loaded. The CSP allowlist is the strongest evidence that it was
expected to work.

### Changed this session

| File | Change |
|---|---|
| `index.js` | J11-2 — `kernel_excess` dropped from the `/api/pool/payments` SELECT and its `API_DOC_META` description corrected · J11-6 — `app.disable('x-powered-by')` added beside the `trust proxy` line · J11-7 — the three `parseInt(req.query.x \|\| N)` sites at `:3213`, `:3225`, `:3241` switched to `parseInt(x, 10) \|\| N` |
| `lib/pool-settings.js` | J11-4 — `analytics.provider` default `'ga4'` → `'none'`, `analytics.ga_tracking_id` `'G-GMYJ4PVG4L'` → `''`, with the reasoning in place |
| `public_html/js/branding.js` | J11-4 — `scrubbedLocation()` generalised to `scrubAddr(url)`; `loadGa4` now pins `page_referrer` to a scrubbed `document.referrer` alongside `page_location` |
| `scripts/test-public-leakage.js` | **New** — 24 assertions: [1] no `analytics` default names a third-party property, provider or GA measurement id (4), [2] `branding.js` scrubs `addr` from **both** `page_location` and `page_referrer` (4), [3] `maskAddr` resolves a masked row to exactly one full address, does not collide on a shared 9-char prefix, and agrees with `dormancy.js`'s copy (4), [4] `/api/pool/payments` selects no `kernel_excess` while `/api/account/:addr/withdrawals` still does (3), [5] `x-powered-by` is disabled and every `parseInt(req.query.x \|\| N)` site carries a NaN default (5), [6] `coarsenIp` masks /24 and /48 and returns null for a non-IP, and `geoip` hands back no IP (4) |
| `package.json` | `test:unit` runs the new suite |

**Left open at the end of the reporting pass:** **J11-1** (which of three positions on address
masking the pool takes — all three change a shipped page), **J11-2's per-address half** (the
kernel Proof column is a real feature; publishing it for arbitrary addresses is the cost),
**J11-3** (it pairs with the J11-1 decision) and **J11-5** (suppress thin-region miner counts, or
state that the map toggle does not cover them). All four are product decisions, and the first two
should be settled before mainnet because what is published on mainnet cannot be withdrawn.

**→ All four were decided and closed the same day. See the resolution pass immediately below.**


### §J11 — resolution pass, 2026-09-02 (same day, add-ons, NOT VPS-TESTED)

The four items §J11 left open were all product decisions rather than bugs, and the reporting pass
said so. The operator took them, choosing the recommended option in each case. This pass records
what was built, the **two things the fix itself uncovered that the reporting pass had missed**,
and what each choice costs.

| Finding | Decision | Cost accepted |
|---|---|---|
| **J11-1** | Option **(b)** — mask every public list, break the deep-link | A miner pastes their address instead of clicking their leaderboard row |
| **J11-2** | Ownership-gate the kernel *(pool-wide half reversed 2026-09-25 — see the note under J11-2)* | The Proof column needs one click and the page's existing proof box |
| **J11-3** | `noindex, follow` | The account page leaves search results (it was never a useful landing page) |
| **J11-5** | Option **(a)** — floor the region counts | A thin gateway shows `<3 miners` instead of an exact number |

#### Two things the fix found that the report had not

**(1) There was a SEVENTH full-address feed.** §J11-1's table named six.
`GET /api/stratum/hashrate` also carried one — `getHashrateStats()` builds a `top_miners` array
with full addresses ([hashrate-tracker.js:1009-1013](../../web/07_mining_pool_public/back-end-pool/lib/hashrate-tracker.js#L1009)),
and the route returned the object whole. It was missed because the endpoint's name and its
documented job ("pool hashrate aggregates") say nothing about a per-miner list, and because
**no consumer reads it** — `reactor-dashboard.js:356` and `miners-stats.html:464` both take only
`pool_hashrate_1h_gps`. It was published and unused, exactly like `kernel_excess` on
`/api/pool/payments`. That is the second time in one session a leak was found in a field nothing
renders, which is the pattern worth naming: **an unread field is not an unnoticed field, it is an
unreviewed one.**

*Checked while there, because it would have been much worse:* `PoolstatsReporter.collectStats()`
also calls `getHashrateStats()` and pushes to miningpoolstats.stream. It reads
`pool_hashrate_1h_gps` and nothing else
([poolstats-reporter.js:117-147](../../web/07_mining_pool_public/back-end-pool/lib/poolstats-reporter.js#L117)),
so no miner address has ever left the box to a third party. The comment there now says to keep it
that way.

**(2) J11-5's suppression would have re-created §J5-4 on two front ends.** Nulling a count is only
half a fix; the render side has to know that null ≠ 0.

- `reactor-dashboard.js`'s gateway lamp read
  `r.miners > 0 ? … : 'idle'`. With `miners: null` that prints **"idle"** next to an **online**
  lamp — a suppressed value rendered as a measured state, and self-contradictory on the same row.
- `charts-init.js`'s `renderMultiTrendLine` mapped every point through `Number(p.v) || 0`, so a
  suppressed point would have been plotted as **a gateway with 0 miners**. Chart.js already draws
  `null` as a gap (the same function emits one for any bucket a series has no point in), so the
  correct value was there all along — the `|| 0` was overwriting it.

Both are fixed, and the chart fix is the more valuable of the two because it is a **shared
helper**: any future series that legitimately has no value for a bucket now draws a gap instead
of a false zero.

#### What was built

**J11-1 — the invariant, not the endpoint list.** The point of the finding is that masking any
*subset* of the feeds is worthless, so the fix is stated as a rule and asserted as one:

> **No public route may emit an unmasked `grin_address` in a LIST.**

`/api/account/:addr/*` is the sole exception and is not a list — the caller supplied the address.
The rule and its reasoning sit on `maskAddr` itself
([index.js:295-317](../../web/07_mining_pool_public/back-end-pool/index.js#L295)) rather than on
any one route, because the next person to add a leaderboard will read the helper, not this
document. Nine routes are asserted individually by
`scripts/test-public-leakage.js` — add a new list route and add it there.

The four deep-links are gone: `miners-stats.html`'s `addrCell` (three leaderboards),
`payment-history.html`'s `addrCell`, `donate.html`'s donor card and `blocks.html`'s `title`
tooltip. Two of those carried the full address **twice** (once in the `href`, once in a `title`),
which is why the pages "already truncated" and leaked anyway. Nothing on screen changes except
that the addresses stop being clickable: every one of those cells already displayed a 9+4
truncation.

**What this costs.** A miner who spots their row on the leaderboard can no longer click through
to their account. They paste their address into the lookup console the account page already has
(`#acct-addr`, P-00). That is the whole cost, and it is the right side of the trade: the
convenience was one click for the owner and a complete pool roster for everyone else.

**J11-2 — the kernel is now the one account field that costs a proof.** `kernel_excess` left the
per-address JSON row and the CSV column, both replaced by `has_kernel_proof` (boolean) so the UI
still knows which payouts *have* a proof to fetch. `POST /api/account/:addr/withdrawals/proofs`
returns `{ proofs: { <withdrawal id>: <kernel> } }` behind `verifyOwnerProof` — the same function,
the same proof (a recent mining IP or the rig's stratum password), audited on both the allow and
deny path as `owner_proof:kernel_proofs:<ok|deny>`.

Three details that are not incidental:

- **It is a POST**, so the proof travels in a body and never lands in an nginx access log.
- **It is on the `withdraw` bucket (20/min), never `public`.** `verifyOwnerProof` runs scrypt at
  16 MB; a proof-taking endpoint on the 1200/min public bucket is a CPU-exhaustion lever, which
  is precisely §F2. The test asserts the bucket.
- **The account-existence check runs first**, matching its GET sibling, so a nonexistent address
  is "not found" whether or not a proof was supplied — no new enumeration signal.

Client side: a *Reveal proofs* button next to the withdrawal table feeds the page's existing
single proof box through `getProof()`, exactly like every payout action. Until it is used, the
Proof column reads `hidden` (with a title saying why) rather than `pending`, so a miner is never
told a proof is missing when it exists. `revealedProofs` is cleared on every `lookup()`, so
switching addresses can never show the previous address's kernels.

**What this costs.** One click and the proof the miner already needs for a payout. The residual:
the CSV export no longer carries kernels at all, so a miner reconciling in a spreadsheet has to
take them from the proofs endpoint. That is a real, small loss of convenience, and it is the
right trade against a 50,000-row all-time export of anyone's chain linkage.

**J11-3 — both halves, and they are independent.** `account-settings.html` is now
`noindex, follow`, with the reasoning inline and a note that `robots.txt` deliberately stays
permissive (a `Disallow` stops the crawl *before* the tag is read, which is how a URL gets
indexed URL-only). Separately, J11-1's de-linking means the site no longer emits an
`?addr=` link at all, so there is no crawl path into the page. Either alone would have been
partial; the pair closes it. The `?addr=` *reader* stays — a miner may legitimately bookmark or
share their own link, and the comment there now says the pool no longer publishes one.

**J11-5 — the floor, on both the live feed and its durable history.** `/api/pool/stats/regions`
and `/api/pool/metrics/history/regions` now apply `network_map_min_bucket`, with four rules that
are each a decision:

1. **Suppress only `0 < n < kMin`.** A real zero stays `0`. "No miners on this gateway" identifies
   nobody and is exactly what a miner picking a gateway needs to see; nulling it would be §J5-4
   inverted — a real value read as suppressed.
2. **Suppress `hashrate_gps` and `shares_window` with `miners`.** With one miner in a region the
   hashrate is that miner's rig size, so it is *more* identifying than the count.
3. **Keep `status`/`online`.** One bit, and that bit is the entire purpose of the public connect
   grid; a miner pointed at a dead gateway is a real harm. **Stated residual:** on a thin region
   `online` still implies at least one miner. The floor hides the *number*, not the existence.
4. **Skip it entirely on a single-region pool.** The region is then the pool, `totals` publishes
   the same number anyway, and suppressing would blank every single-box install's dashboard for
   zero privacy gain.

Totals are summed **before** suppression, so they stay exact: the floor hides *where*, never *how
many*. The response also carries `min_bucket` and `suppressed_regions` (and `suppressed_points` on
the history route) so a client can render "—" or "<3" instead of inventing a zero — publishing the
threshold costs nothing, since it is in the admin UI already, and an unexplained blank reads as a
bug.

**What this costs.** On a multi-region pool, a gateway with one or two miners shows `<3 miners`
instead of an exact count. Nothing else changes.

#### Also changed: the syntax gate could not see any of this

`scripts/check-syntax.js` extracted inline `<script>` blocks from `admin-panel/` only. Every page
edited in this pass — the leaderboards, the blocks explorer, the payouts table, the donor wall and
the whole account page — keeps its logic in an inline block in `public_html/`, so the pool's only
pre-commit gate was blind to the money UI miners actually use, in exactly the way §J14's note
describes it having been blind to half the admin panel. `public_html` is now in
`INLINE_HTML_DIRS`, with a `type` filter so `<script type="application/ld+json">` (JSON, not
JavaScript) is skipped rather than failing every public page on its schema.org markup. The gate
went from 21 to **31 inline blocks**, and it was mutation-tested: a deliberate syntax error in
`blocks.html` is caught and the check goes red.

#### Verification

| Check | Result |
|---|---|
| `npm test` (syntax gate + 9 unit suites) | pass, `rc=0` |
| `scripts/test-public-leakage.js` | **51 assertions**, pass (was 24) |
| **Mutation test — 9 deliberate regressions** | **all 9 caught**; suite green again after restore |
| `npm run check-syntax` | 60 files + 31 inline blocks |

The mutation test is the part worth keeping. It broke each fix in turn — un-masking the donor
wall, un-masking the stratum top-10, restoring the leaderboard deep-link, putting `kernel_excess`
back into the per-address row (twice: as a shorthand and as a named property), moving the proofs
route to the `public` bucket, making the account page indexable, suppressing a real zero, and
coercing a suppressed chart datum back to `0` — and confirmed the suite goes red for each.

**It caught a bad assertion of mine.** The first version of the §J11-2 check tested that
`has_kernel_proof` was *present* in the route, which is not the same as testing that the kernel is
*absent*: re-adding `kernel_excess` to the response object passed it, because the string still
appeared elsewhere in the handler. The assertion now counts every mention of `kernel_excess` in
the handler (excluding SQL and comments) and requires each one to match a provably non-leaking
form — the destructure that drops it, the `!!` coercion, or the CSV yes/no. A presence check is
not an absence check, and only the mutation run exposed it.

**Gaps worth stating.** (1) **Still no HTTP request to any route** — the masking, the new POST's
403 path and the `noindex` header are read and unit-asserted, not observed on the wire; the same
harness gap §J7–§J10 each recorded. (2) **The account page's *Reveal proofs* flow has not been
driven in a browser** — the handler, the wiring and the state reset are read, and the page passes
the syntax gate, but no click has happened. (3) **J11-5's floor has never seen a multi-region
pool**, because nothing here has run on a VPS; a single-box install takes the skip branch, so the
suppression path itself is exercised only by the unit assertions.

#### Changed in this pass

| File | Change |
|---|---|
| `index.js` | **J11-1** — `maskAddr` gains the stated invariant; `found_by` masked on `/api/pool/blocks`; addresses masked on `/api/pool/top-block-finders`, `/api/pool/payments`, `/api/pool/donors`, `/api/stratum/hashrate` (the seventh feed), `/api/stratum/top-miners`, `/api/stratum/top-avg-hashrate` · **J11-2** — `kernel_excess` dropped from the per-address JSON row and CSV column in favour of `has_kernel_proof`, and a new ownership-gated `POST /api/account/:addr/withdrawals/proofs` on the `withdraw` bucket · **J11-5** — k-anonymity floor + `min_bucket`/`suppressed_*` fields on `/api/pool/stats/regions` and `/api/pool/metrics/history/regions` · `API_DOC_META` updated for all nine changed routes and the new one added |
| `public_html/miners-stats.html` | J11-1 — `addrCell` renders plain text, no `?addr=` link |
| `public_html/payment-history.html` | J11-1 — same, and the full-address `title` tooltip removed |
| `public_html/donate.html` | J11-1 — donor card de-linked, `title` removed |
| `public_html/blocks.html` | J11-1 — full-address `title` tooltip removed from the `found_by` cell |
| `public_html/account-settings.html` | J11-3 — `robots` → `noindex, follow` · J11-2 — `revealedProofs` state (cleared per lookup), the Proof cell's `hidden` state, the *Reveal proofs* button + `revealProofs()` handler, and a note that the `?addr=` reader stays while nothing emits one |
| `public_html/js/reactor-dashboard.js` | J11-5 — gateway lamp renders a floored count as `<N miners`, never `idle`; region sort treats a floored count as 1, not 0 |
| `public_html/js/charts-init.js` | J11-5 — `renderMultiTrendLine` preserves a `null` datum as a gap instead of `Number(null) \|\| 0` → a false zero |
| `scripts/check-syntax.js` | `public_html` added to `INLINE_HTML_DIRS` with a `type` filter for JSON-LD — 21 → 31 inline blocks |
| `scripts/test-public-leakage.js` | 24 → **51 assertions**: the nine-route masking invariant, the no-`?addr=`-link sweep across every public page, the kernel-absence count, the proofs route's guard + bucket + audit, the `noindex` pair, and the region floor on both feeds plus both render sites |

**Nothing from §J11 is left open.** J11-9(a) (the node peer count on `/api/pool/status`) and
J11-9(b) (the unbounded `offset`) were recorded as Info and handed to §J12, not left open here.

---

## §J12 — Rate limiting & resource exhaustion (2026-09-02, add-ons, NOT VPS-TESTED)

Twelfth session of the pre-mainnet §J pass (see the Status roll-up at the top of this file).
Scope: [`lib/rate-limiter.js`](../../web/07_mining_pool_public/back-end-pool/lib/rate-limiter.js)
(410), bucket assignment across all 171 route registrations in
[`index.js`](../../web/07_mining_pool_public/back-end-pool/index.js), the `trust proxy` chain,
the generated nginx `limit_req` map in
[`scripts/07_grin_mining_public_pool.sh`](../../scripts/07_grin_mining_public_pool.sh), and the
cost of every endpoint the plan named as expensive.

Method: build the bucket matrix first (§J12's half of the J1 deliverable), then stop asking
"is this route throttled?" — every route but four is — and ask the question that actually
decides whether the box survives: **what does one request cost, multiplied by the rate the two
throttle layers actually allow?** Where a query was suspect, its plan was read out of
`node:sqlite` with `EXPLAIN QUERY PLAN` against the real schema rather than guessed.

**Headline — the throttles are in good shape and the unit costs were never measured. Two
anonymous GETs are priced wrong by orders of magnitude: one full-table-scans a table that
grows by a row per miner per minute, on every request, whatever window you ask for; the other
makes two upstream RPCs — including one to the hot wallet that pays miners — with no
server-side cache, while the endpoint beside it in the same file got exactly that cache with
the reasoning written out.**

*The limiting itself is sound.* Every route carries a bucket except four, and those four are
deliberate (J12-13). Buckets are keyed per `(type, IP)` so a login budget is not spent by
dashboard polls; `getClientIp` reads `req.ip` under `trust proxy: 'loopback'`, which makes
`X-Forwarded-For` unspoofable from off-box; nginx puts a second, independent per-IP
`limit_req` zone in front of nearly everything. §F1 and §F2's dedicated `withdraw`, `export`
and `torcheck` buckets are all still correctly attached, and §J2-1's `stepup` bucket is on both
password-verifying routes. Five response caches exist in this code base and four of them are
exemplary — bounded, in-flight-deduped, negative-result-aware.

*What is wrong is on the cost side.* `hashrate_history` grows at one row per active miner per
minute for 100 days;
[`/api/stratum/top-avg-hashrate`](../../web/07_mining_pool_public/back-end-pool/index.js#L4665)
scans **all** of it per request, and `?days` does not enter the query plan at all (J12-1,
confirmed with `EXPLAIN QUERY PLAN`). `/api/pool/status` called the node Owner API and the
wallet Owner API on every hit and answered with a `Cache-Control` header instead of a cache
(J12-2). `/api/pool/effort`'s round window fell back to `> 0` — the whole `shares` table — on a
pool that has not yet found a block, i.e. on launch day (J12-7).

*And one throttle was not the throttle it is documented to be.* The limiter's exponential
backoff could not escalate: the violation record was deleted at expiry, so `count` was always
1 and every lockout was 30 s. The 30→60→120 ladder and the one-hour cap in the comment were
unreachable code (J12-4).

Twelve findings plus two Info sweeps. **Six fixed in this session** (J12-2, J12-4, J12-6,
J12-7, J12-8 and half of J12-10 — each small and local, plan rule 3) with a new 22-assertion
suite, `scripts/test-rate-limits.js`. **J12-1, J12-3, J12-5, J12-9, J12-11 and J12-12 are left
open**: the first needs a schema decision, the rest are sized against traffic nobody has yet.

### Threat actors used in this section

| Label | Means | What the two throttle layers actually allow it |
|---|---|---|
| **Anonymous internet** | Anyone who can reach the public API. No credential | nginx `_api` **600 r/m** + app `public` **1200/min**, both per-IP → the binding limit is **~10 req/s from one host**, and nothing caps the number of hosts |
| **Registered miner** | Holds one valid ownership proof for one address (a recent mining IP, or the rig password) | `withdraw` **20/min**, `export` **10/min**, `torcheck` **10/min**, all per-IP |
| **Search engine / bulk crawler** | Follows links; fetches `/robots.txt` and `/sitemap.xml` unprompted | **No nginx zone at all** on those paths, and it shares one app bucket with every other visitor (J12-3) |
| **Logged-in admin / stolen `secureAdmin` session** | A live session cookie; no step-up. §C3 keeps this a live actor | nginx `_admin` **2400 r/m** + app `admin` **2400/min** |
| **On-box root** | Edits `pool.json` | Everything. Findings needing this are Info, per plan rule 7 |

### The bucket matrix — every route, its bucket, and the zone in front of it

The §J1 matrix says which *guard* a route carries. This is the other axis, and it is the half
§J12 owes. `n` counts route registrations parsed from `index.js`; the nginx zone is whichever
`location` block the path falls into in the generated vhost.

| App bucket | Rate | n | nginx zone in front | Routes | Is the number right? |
|---|---|---|---|---|---|
| `admin` | 2400/min | 99 | `_admin` 2400 r/m burst 40 | Every `secureAdmin` (64), `freshAdmin` (31), `freshAdminEnroll` (2) — the bucket is the first element of all three chains ([index.js:830](../../web/07_mining_pool_public/back-end-pool/index.js#L830), [:879](../../web/07_mining_pool_public/back-end-pool/index.js#L879), [:893](../../web/07_mining_pool_public/back-end-pool/index.js#L893)) | **Yes, as DoS padding**, and it answers §J1's handoff: this is *not* the only thing in front of an unauthenticated caller. nginx's `_admin` zone is an independent per-IP layer at the same rate on both `/admin/` and `/api/admin/`, and it applies whether or not `admin_allowlist` is empty. The two routes behind it that should not be are J12-5 |
| `public` | 1200/min | 51 | `_api` 600 r/m burst 10 (`_static` 6000 r/m for `/blog/<slug>`; **nothing** for four paths) | All public GETs, `/health`, `/api/public/*`, `/api/pool/*`, `/api/stratum/*`, the account GETs, `/robots.txt`, `/sitemap.xml`, `/manifest.json`, `/blog/rss.xml`, `/page.html`, `/blog/:slug` | **The rate is fine; four members are not.** nginx binds first at ~10 req/s, which is a correct budget for a page read and a catastrophic one for J12-1, J12-2, J12-7 and J12-9. Four members have no nginx zone at all (J12-3) |
| `auth` | 200/min | 3 as middleware + 2 via peek/consume | `_auth` 200 r/m burst 5 | `POST /api/auth/login/totp`, `/logout`, `/refresh`; `register` and `login` gate on `peek` and only `consume` after the CAPTCHA passes | **Yes.** The peek/consume split is right and its free branch does no credential work. The recovery-code bcrypt behind `login/totp` is bounded by §J2-3's per-token budget, not by this number — see *Handoffs answered* |
| `stepup` | 10/min | 2 | `_api` 600 r/m | `POST /api/admin/reauth`, `POST /api/auth/change-password` | **Yes.** §J2-1's fix, correctly attached to both password-verifying routes |
| `withdraw` | 20/min | 4 | `_api` 600 r/m | `POST /withdraw`, `/withdraw/:id/finalize`, `POST` + `DELETE /nostr-destination` | **Yes for the money side.** It also silently prices the Tor pre-flight probe, which is J12-12 |
| `export` | 10/min | 2 routes (peek + consume each) | `_api` 600 r/m | `?format=csv` on `/api/account/:addr/withdrawals` and `/balance/log` | **Yes**, and this answers §J11's handoff: both are row-capped at `CSV_MAX_ROWS = 50000` ([index.js:3654](../../web/07_mining_pool_public/back-end-pool/index.js#L3654)) and scoped to one address, so 10/min bounds the allocation at roughly 7 MB per request. §J11's *ownership* question is real and stands; it is not a cost question |
| `torcheck` | 10/min | 1 | `_api` 600 r/m | `GET /api/account/:addr/tor-check` | **Yes, and it is the model the rest should copy.** 60 s cache + in-flight dedup + a 500-entry bound with expired-first eviction + a must-have-mined check ([index.js:3745-3790](../../web/07_mining_pool_public/back-end-pool/index.js#L3745)) |
| `api` | 600/min | **0** | — | **Nothing.** Defined, documented, and `middleware()`'s default argument — attached to no route | **Dead** — J12-10, fixed |
| *(none)* | — | 4 | varies | `POST /api/auth/register`, `POST /api/auth/login` (both gate internally on `peek`), `GET /api/admin/_authcheck`, the `/api/account` shape middleware | **All four correct** — J12-13 |

nginx zone rates, all `$binary_remote_addr`-keyed through the shared
`nginx_ensure_rate_limit_zones` primitive as CLAUDE.md requires
([07_grin_mining_public_pool.sh:1048-1053](../../scripts/07_grin_mining_public_pool.sh#L1048)):
`_auth` 200 r/m · `_captcha` 600 r/m · `_api` 600 r/m · `_admin` 2400 r/m · `_static` 6000 r/m.

### Findings

### J12-1 — [High] `/api/stratum/top-avg-hashrate` full-scans `hashrate_history` on every request and `?days` never enters the plan — the cheapest unauthenticated way to stall share intake — **FIXED 2026-09-02 (see §J12 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J12-1).**

### J12-2 — [High] `/api/pool/status` made two upstream RPCs per request — one to the hot wallet — and answered with a cache *header* instead of a cache — **FIXED 2026-09-02**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J12-2).**

### J12-3 — [Medium] The four SEO paths are proxied with no `X-Forwarded-For` and no `limit_req` zone, so every visitor shares one app bucket and ~1200 requests from one host 429s `/robots.txt` and `/sitemap.xml` for everyone — **FIXED 2026-09-02 (see §J12 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J12-3).**

### J12-4 — [Medium] The limiter's exponential backoff was unreachable code: the violation record was deleted at expiry, so the lockout was always 30 s and the one-hour cap could never apply — **FIXED 2026-09-02**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J12-4).**

### J12-5 — [Medium] The two admin CSV exports have no row cap and ride the 2400/min `admin` bucket, while the public per-address exports are capped at 50,000 rows on a dedicated 10/min bucket — **FIXED 2026-09-02 (see §J12 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J12-5).**

### J12-6 — [Medium] `/api/public/price` never cached a failure and had no in-flight dedup, so any upstream refusal turned it into a per-request outbound fetch — **FIXED 2026-09-02**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J12-6).**

### J12-7 — [Medium] `/api/pool/effort`'s round window had no lower bound, so a pool that has not yet found a block summed the entire `shares` table on every request — **FIXED 2026-09-02**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J12-7).**

### J12-8 — [Low] `/api/public/branding` rebuilt the entire white-label payload from five uncached settings reads on every request, on the endpoint every public page hits on every load — **FIXED 2026-09-02**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J12-8).**

### J12-9 — [Low] `/api/pool/topology` full-scans `shares` and compiles an `IN (…)` clause with one placeholder per live session — **MEMO FIXED 2026-09-02; the `IN (…)` width is unchanged (see §J12 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J12-9).**

### J12-10 — [Low] The `api` bucket was dead, and a `rate_limits` value of `0` disables a bucket rather than blocking — **BUCKET FIXED 2026-09-02; the falsy-limit behaviour is documented, deliberately not changed**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J12-10).**

### J12-11 — [Low] Nothing bounds the limiter's own maps or the three auto-ban maps, and two admin reads walk them end to end — **FIXED 2026-09-02 (see §J12 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J12-11).**

### J12-12 — [Low] The Tor pre-flight probe is priced by the `withdraw` bucket, so one proof-holding miner can force 20 circuit builds a minute — **FIXED 2026-09-02 (answers §J3's handoff; see §J12 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J12-12).**

### J12-13 — [Info] The four routes with no bucket, and why each one is correct

The plan asked for the "none" set to be identified and each member justified. Parsed from all 171
`app.<method>` registrations in `index.js`:

| Route | Why it carries no `rateLimiter.middleware` | Verdict |
|---|---|---|
| `POST /api/auth/register` ([index.js:1695](../../web/07_mining_pool_public/back-end-pool/index.js#L1695)) | Gates internally on `peek('auth')` at :1699 and only `consume`s after the CAPTCHA passes at :1725, so a wrong CAPTCHA is free by design. The free branch does one `COUNT(*)` on `users` and a Map lookup — no bcrypt, no write | **Correct.** nginx `_auth` 200 r/m still applies |
| `POST /api/auth/login` ([index.js:1766](../../web/07_mining_pool_public/back-end-pool/index.js#L1766)) | Same peek/consume split (:1772, :1789), plus an `ipFilter.isBlocked` check ahead of the CAPTCHA. The free branch does no DB write and no bcrypt | **Correct** |
| `GET /api/admin/_authcheck` | nginx's `auth_request` fires it once per admin static asset; the handler is deliberately cheap and documented at [index.js:4925](../../web/07_mining_pool_public/back-end-pool/index.js#L4925). A JWT verify is one HMAC | **Correct.** Bounded by `_admin` 2400 r/m on the parent `/admin/` location |
| `app.use('/api/account', …)` ([index.js:785](../../web/07_mining_pool_public/back-end-pool/index.js#L785)) | §J3-8's shape gate — a middleware, not a route. One regex, then `next()` into a route that does carry a bucket | **Correct**, and it is the cheapest possible rejection for a malformed address |

### J12-14 — [Info] Verified correct, with evidence

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J12-14).**

### Handoffs answered from earlier sessions

- **§J1** — *"the `admin` bucket is the only thing in front of every admin handler for an
  unauthenticated caller while `admin_allowlist` is empty."* **Not quite.** nginx's `_admin` zone
  is an independent per-IP layer at the same 2400 r/m on both `/admin/` and `/api/admin/`, and it
  applies whether or not `$admin_rules` is empty. 2400/min is right for a polling dashboard; the
  two routes behind it that should not be there are J12-5.
- **§J2, all three CPU levers.** (1) `/api/admin/reauth` — **closed**, it is on `stepup` (10/min).
  (2) `/api/auth/change-password` — **closed**, same bucket. (3) The `/api/auth/login/totp`
  recovery branch — **closed by §J2-3, not by a bucket.** It is still up to 10 sequential cost-12
  `bcrypt.compare`s per submission
  ([auth.js:668-676](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L668)), but
  `verify2faToken` refuses a spent token *before* any of that work and the per-`jti` budget caps a
  token at `twofaMaxAttempts` submissions
  ([auth.js:756-766](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L756)). Since a
  token costs a correct password plus a solved CAPTCHA, the ceiling is a few dozen compares per
  *successful* password authentication. No new bucket is needed.
- **§J3, both levers** — J12-12.
- **§J4** — *"the scheduler loop is strictly serial and one unreachable Tor recipient costs the
  full `wallet_send_timeout_ms`."* Confirmed as stated, and it is a queueing bound rather than an
  attack: one pending withdrawal per address means no single actor can lengthen the queue.
  Recorded, not re-reported. The related shared-`WalletAPI`-session concern *is* attacker-driven
  and is written up as part of J12-2.
- **§J6** — *"is 25 msg/s × 320 connections the right budget at all?"* Outside this session's file
  list (`stratum-server.js` is §J6's), and the two levers that made it urgent — the reject
  amplifier and the pre-login squat — are closed there. The HTTP-side answer is that the stratum
  budget is not comparable to an HTTP bucket: it prices work forwarded to the node's PoW verifier,
  not work done in this process. Left with §J17 to settle against a real rig.
- **§J7** — the two public CSV exports: sized correctly, see J12-14. The *admin* ones are not:
  J12-5.
- **§J9-8** — `/api/public/branding`: J12-8. The caching half is fixed here; the missing length
  caps stay §J9-8's open item, and the two compose correctly (a memo does not make an unbounded
  payload smaller, it only stops it being rebuilt).
- **§J10** — multer field limits: J12-14, not a finding. J10-2's unbounded `/uploads` growth is a
  filesystem question with no rate-limit answer — it needs a listing and a delete path, which is
  what J10-2 already says. Not re-reported.
- **§J11** — all three. Blocks offset and the account CSVs are J12-14; the `public`-bucket sizing
  question is J12-1 and J12-2. The bucket rate is right; two of its members are not.

### Handoffs

- **§J16 (deployment & infra) owns the vhost half of J12-3** — the four SEO `location` blocks need
  `X-Forwarded-For` and a `limit_req` zone. It is a four-line change to `pool_setup_nginx`, but it
  is that file's, and it should land together with the `isLocalRequest` tightening so the
  invariant and the config agree. §J16 should also note that `listen 443 ssl http2` has **no
  `[::]:443` companion**: that is what keeps J12-11's map growth IPv4-bounded, so **adding IPv6 to
  the vhost raises J12-11's severity** and must not be done as a cosmetic modernisation.
- **§J16** — the `/uploads/` and `/custom/` `alias` blocks carry no `limit_req`. nginx serves those
  from disk without reaching the app so it is not an app-side lever, but they are the only other
  public locations with no zone at all, and they serve operator-uploaded files.
- **§J4 (payout execution) owns the ordering change in J12-12** — hoisting the pending and cooldown
  checks above the Tor pre-flight means splitting `createWithdrawal`'s admission checks out of the
  scheduler.
- **§J5 / §J7** — J12-1's option (b), serving the sustained-contribution leaderboard from
  `pool_metrics_hourly`, would need a per-address rollup that does not exist today. If the covering
  index is chosen instead, creating it on a populated 100-day table is a migration with a lock —
  the same hazard as §J7-1's `VACUUM` cron, and it belongs in the same maintenance-window
  conversation.
- **§J15 (public front-end)** — J12-7's fix adds `round_window_from` and `round_window_capped` to
  `/api/pool/effort`. On a pool that has not yet found a block the effort figure is now measured
  from a floor rather than from a block, and the dashboard should say so rather than presenting it
  as a real round. One string.
- **§J17 (operational gate)** — five things only a run can settle. **(1) J12-1 is the one to
  stage**: point a loop at `/api/stratum/top-avg-hashrate` on a testnet pool with a few days of
  `hashrate_history` and watch share acceptance. It is the finding most likely to be
  under-estimated on paper and most likely to be catastrophic on a box. **(2) J12-6**: hit
  `/api/public/price` once on a fresh install and read the journal — if CoinGecko still refuses the
  new User-Agent, the negative cache is now the only thing between that and a per-request outbound
  fetch, and the footer ticker will be blank. **(3) J12-2's fix changes the homepage status strip
  from "fresh every poll" to "fresh every 15 s"** — confirm it still reads as live. **(4) J12-4's
  backoff now escalates for real**: confirm an operator who fumbles the admin login several times
  is not locked out for an hour by a control that never used to bite. **(5) J12-3**: with the map
  published, watch `/api/pool/topology` under a normal dashboard load before deciding whether
  J12-9 needs its memo.

### Verification

- `node --check` on every changed JS file; `bash -n scripts/07_grin_mining_public_pool.sh` (no
  shell change was made, but the file was read).
- `npm test` — `check-syntax` plus all ten unit suites, **exit 0**.
- **New: `scripts/test-rate-limits.js`, 22 assertions, all passing.** [1] §J12-4 — the backoff
  ladder actually escalates 30 → 60 → 120 s across three consecutive expiries, the count survives
  a lapsed lockout, and an expired-but-remembered record is *not* reported as an active lockout by
  `getViolations()` or `getStatus()` (5); [2] §J12-10 — every bucket named by a
  `middleware`/`peek`/`consume` call exists, no bucket exists without a consumer, and
  `middleware()`'s default names a real one (3); [3] §J12-2 / §J12-7 — both endpoints hold a real
  server-side TTL and in-flight guard, and the effort window is floored rather than
  `lastBlockAt || 0` (4); [4] §J12-6 — a descriptive User-Agent is sent, a failure arms the
  negative cache, a 200 carrying no price counts as a failure, and concurrent misses collapse (4);
  [5] §J12-8 — the branding memo exists, its key space is bounded, and all four write sites
  invalidate it (3); [6] §J12-1 — an `EXPLAIN QUERY PLAN` against the real schema pins
  `getTopAvgHashrate` as a `SCAN` **and** pins the sibling `getPoolHistory` as a covering-index
  seek, so the open finding cannot be lost and the day it is fixed the suite says so (3).
- **`EXPLAIN QUERY PLAN` was run against the real schema** in `node:sqlite` (Node v24.14.1) for
  the five hot queries; the plans quoted in J12-1, J12-7 and J12-9 are outputs, not readings.
- The one-shot probe behind J12-6's `User-Agent` claim bound a throwaway listener on 127.0.0.1,
  made one request, printed the headers Node's `fetch` sent (`user-agent: node`) and exited.
  Nothing was left running.

**Gaps worth stating.** (1) **No sustained load was generated**, so every rate figure here is
`limit × unit cost`, not a measurement — the row *counts* in J12-1 are projections from the
documented sampling interval and retention, not from a populated table. (2) **The nginx layer was
read, never run**: that `_api` binds at 600 r/m before the app's 1200 is a reading of the generated
vhost, and `limit_req`'s `burst … nodelay` behaviour under a real burst is not something this repo
can settle. (3) **J12-2's shared-session race is reasoned from the code, not reproduced** — the fix
removes the load that would cause it either way. (4) **J12-6's CoinGecko 403 is an expectation, not
an observation**: what is *confirmed* is the mechanism (any failure re-opens a per-request fetch)
and the header Node sends; whether CoinGecko refuses that particular string is memory plus the four
sibling callers that had to add one, and only a run settles it. (5) The IPv4-only conclusion in
J12-11 holds for the vhost this toolkit generates; an operator who has hand-added an IPv6 listener
is outside it.

### Changed this session

| File | Change |
|---|---|
| `lib/rate-limiter.js` | J12-4 — `checkLimit` preserves a violation's `count` across a lockout expiry instead of deleting the record, and the cleanup sweep only drops one that has been expired for a full `RateLimiter.VIOLATION_MEMORY_MS` (10 min), so the documented 30→60→120 ladder and the 1 h cap are finally reachable · J12-10 — the unused `api` bucket removed, `middleware()`'s default argument moved to `public`, and `middleware()` plus both "Overridable via config.rate_limits.*" comments now state that a value of `0` means **disabled**, not *blocked* |
| `index.js` | J12-2 — `/api/pool/status`'s body extracted into `buildPoolStatus()` behind a 15 s server-side cache with in-flight dedup and last-good-on-error · J12-6 — `/api/public/price` sends a descriptive `User-Agent`, arms a 60 s negative cache on any failure (including a 200 with no price), and collapses concurrent misses to one fetch · J12-7 — `/api/pool/effort`'s round window floored at `now − 7d` instead of 0, response memoised 30 s, and `round_window_from` / `round_window_capped` added so a capped figure is visible · J12-8 — `/api/public/branding` memoised 60 s, keyed on hostname, bounded to 32 entries, with `invalidateBranding()` called from `updateSection`, `resetSection`, `saveAsset` and `deleteAsset` |
| `scripts/test-rate-limits.js` | **New** — 22 assertions (listed under *Verification*) |
| `package.json` | `test:unit` runs the new suite |

**Left open at the end of the review session:** **J12-1** (a covering index on a 100-day table
is a migration, and it is the most dangerous item in this section), **J12-3** (a §J16 vhost
change), **J12-5** (changing what an operator's export contains), **J12-9** (only reachable once
the map is published), **J12-11** (should be sized against real traffic) and **J12-12** (needs
§J4's module split).

**All six were closed the same day — see the §J12 resolution pass below.** J12-1's fix is NOT
the covering index this section recommended: that turned out to be the wrong tool (the ORDER BY
is on a derived aggregate, so no index avoids visiting the window) and it was replaced by a
per-address daily rollup. The correction is written up there.

---

### §J12 — resolution pass, 2026-09-02 (same day, add-ons, NOT VPS-TESTED)

**All fourteen findings are now closed.** Six were fixed during the review session itself
(J12-2, J12-4, J12-6, J12-7, J12-8, half of J12-10); the six left open as structural or
cross-file work are fixed here. Two (J12-13, J12-14) were Info sweeps with nothing to fix.
The suite is now `scripts/test-rate-limits.js`, **51 assertions**, and `npm test` passes all
ten suites.

Two of the six changed shape once the work started, and both corrections matter more than the
fixes themselves.

---

#### J12-1 — the covering index was the wrong fix, and the session recommended it

The finding proposed **(a)** a covering index `hashrate_history(recorded_at, grin_address,
hashrate_gps, window_seconds)`, **(b)** a rollup, or **(c)** a TTL cache, and called (a)+(c)
"the right answer". **(a) is wrong**, and the reason is in the query itself: the `ORDER BY` is
on a *derived aggregate*, so no index can avoid visiting every row inside the window. An index
only helps small `?days` values — and it would cost roughly **9 GB** of extra index on the
largest table in the schema, because `grin_address` is 63 bytes and would have to be carried a
second time. A rollup makes the read 100× smaller instead of making the scan faster, which is
the thing that was actually needed.

**Built: `miner_hashrate_daily`** — one row per miner per completed UTC day, holding
`gps_seconds = SUM(hashrate_gps × window_seconds)`, which is exactly the numerator the
leaderboard needs, so the composite read is a plain `SUM` with no re-derivation. ~100 k rows at
1000 miners × 100 days, ~10 MB against the raw table's 20–30 GB.

- **Writer:** `rollupMinerDays()` in `hashrate-tracker.js`, called from the same tracking loop
  as `rollupCompletedHours()`. Idempotent upsert, bounded catch-up, a no-op on every call that
  finds no new completed day — which is all but one call a day.
- **Horizon marker, not `MAX(day)`.** A day on which no miner produced a sample writes no row,
  so a `MAX(day)`-derived cursor sticks on the last busy day and re-walks every quiet day since,
  on every call, forever. The marker (`pool_config('_state','miner_hashrate_day_horizon')`,
  the pattern `ledger-rollup.js` already uses) advances regardless, is clamped into the window
  so a restored backup or a backwards clock cannot make the rollup skip real days, and is
  written **inside the same transaction** as the rows it describes.
- **Reader:** the window is still the same rolling `now − days`, served in up to three pieces —
  raw for the partial first day, rollup for the whole days, raw for the current partial day —
  each raw piece bounded by **one day whatever `?days` says**. That bound, not raw speed, is
  the property that was missing.
- **Plus the TTL cache** (60 s, bounded key space, does not cache a failure), which is what
  actually closes the amplification: N visitors now cost one query per TTL, not one each.

**A bug this fix introduced and the test caught.** The first version excluded the
partially-overlapping first day and counted only whole UTC days — reasoning that counting a
partial day whole would *overstate* the average. It understates instead, badly: at `?days=1`
the cutoff lands inside yesterday, so the answer came out **~5× low** while still dividing by a
full day. It was caught because the regression test's oracle is the *original raw query,
verbatim* — not a hand-computed expectation. That is the only reason it was caught, and it is
the pattern to copy for any future rollup: **a rollup's test must compare against the query it
replaces, at several window sizes, or it will silently answer a different question.**

**A second trap, found with `EXPLAIN QUERY PLAN` and worth recording.** A **one-sided**
`recorded_at >= ?` on the raw tail *still* plans as `SCAN hashrate_history USING INDEX
idx_hashrate_address` — SQLite prefers reading in `grin_address` order to skip the temp b-tree,
and an open-ended range gives the planner no reason to prefer the time index. Adding the upper
bound flips it to `SEARCH … USING idx_hashrate_time (recorded_at>? AND recorded_at<?)`. The
upper bound is therefore load-bearing, not tidiness, and the test pins **all three** plans —
including the negative control that dropping it restores the full scan.

**Retention — deliberately not keep-forever.** `pool_metrics_hourly` and `balance_log_daily`
are never pruned, and copying that here would have been the obvious move. It would also have
been a privacy regression: this is **per-address** mining activity, and a summary that outlived
the raw rows it came from would retain more about a miner than the pool did before the table
existed (§G1 / §J11's linkage concerns). `retention.js` prunes it on the *same*
`hashrate_keep_days` horizon as its source, by whole UTC day. **A rollup must never extend a
retention window.**

Residual, stated rather than hidden: at 1000 miners the one-day raw tail is still ~1.4 M rows,
so a cache miss is order-of-a-second. That is 100× better and bounded; the durable fix is the
per-miner *hourly* rollup already tracked as item 2 of memory `project_pool_db_capacity`.

#### J12-3 — both halves, plus one the finding did not ask for

All four SEO `location` blocks (`= /robots.txt`, `= /sitemap.xml`, `= /manifest.json`,
`= /blog/rss.xml`) now forward `X-Real-IP` + `X-Forwarded-For` and carry
`limit_req zone=${POOL_SERVICE}_static burst=20 nodelay` — the same treatment `= /page.html`
already had, with the reasoning quoted at the block so the next person to add an SEO proxy sees
why. `isLocalRequest()` now requires **both** a loopback `req.ip` **and** an absent
`x-forwarded-for` header, so its docstring's invariant is true by construction rather than by
the vhost happening to agree with it.

**Checked before changing it:** Script 07's guided installer registers the first admin with
`curl http://127.0.0.1:$port/api/auth/register`
([07_grin_mining_public_pool.sh:1763](../../scripts/07_grin_mining_public_pool.sh#L1763)) —
straight at the app port, not through nginx, so no `X-Forwarded-For` is present and the
tightened check still lets the setup-time CAPTCHA bypass through. Tightening that helper without
confirming this would have broken first-install on a fresh box.

#### J12-5 — capped, paged, throttled, streamed, and *visibly* truncated

Both pool-wide admin exports now take the `export` bucket (10/min) instead of `admin`
(2400/min), cap at `ADMIN_CSV_MAX_ROWS = 50000` — the same cap their public per-address
siblings have had since §C1 — and page with `?before=<cursor>` for an operator who genuinely
wants the whole ledger. `LIMIT` is `MAX_ROWS + 1` so the extra row *is* the truncation signal;
a plain `LIMIT` can never distinguish "exactly a full page" from "there is more". `sendCsv`
streams `res.write` per row instead of building one string by `map`+`join`, so Node's own
backpressure bounds the peak rather than the row count deciding it.

**One thing the finding missed.** Reporting truncation only in `X-Export-Truncated` /
`X-Export-Next-Before` would have been correct and useless: those headers are invisible to an
operator clicking a download link in the admin panel, so a capped export would arrive looking
complete — which for a *financial* export is the worst possible failure. The last row of the
file now says `TRUNCATED at 50000 rows - continue with ?before=<cursor>`. A capped export that
looks complete is worse than one that visibly is not.

#### J12-9 — memoised; the `IN (…)` width is left alone, deliberately

`/api/pool/topology` now holds a 30 s server-side memo (no key — the response has no per-caller
component), which removes the per-request full `SCAN shares USING INDEX idx_share_region`. The
finding also suggested chunking the `IN (…)` clause built from the live session count. **Not
done**, and the header is marked accordingly: at §J6's ceiling the clause approaches but stays
under SQLite's 32,766-parameter limit, the memo means it is compiled once per 30 s rather than
per request, and rewriting a working geo lookup for a bound that is not currently exceeded is
the kind of change that introduces a bug to fix a hypothetical. Recorded as the residual.

#### J12-11 — bounded, with one bound deliberately *not* added

- `RateLimiter.requests` gains a hard cap (`MAX_TRACKED_BUCKETS = 200000`,
  `EVICT_BATCH = 1000`), reclaimed stale-first and only oldest-insert-first if every tracked
  bucket is genuinely live.
- `adminLoginFailures` / `admin2faFailures` sweep expired rows before admitting a new IP, past
  a floor (`ADMIN_FAIL_MAP_MAX = 10000`) no real pool reaches.
- `IpFilter.tempBans` sweeps **expired** bans before inserting a new one.

**`violations` is deliberately left uncapped**, and the code says so at the eviction site. The
finding itself flagged why: *evicting a violation entry lifts a lockout*, so a size cap on that
map turns a memory bound into a security bypass under exactly the flood that would trigger it.
It is bounded by its own TTL sweep instead. `tempBans` gets the same treatment for the same
reason — the sweep is by expiry and never by size, because dropping a live ban silently unbans
an attacker. The regression test asserts both the cap *and* that a live lockout survives a
500-source flood.

#### J12-12 — ordering, not caching

`WithdrawalScheduler.precheckWithdrawable()` is a read-only admission precheck (freeze, reversal
cooldown, account exists, pool pending cap, one-pending-per-address) that the withdraw route now
runs **before** the Tor pre-flight probe. A miner holding a valid proof whose request would be
refused anyway no longer buys up to two fresh Tor circuits (≤6 s) per request at 20/min.

Two properties preserved on purpose, both asserted in the test: every check is still repeated
**authoritatively inside `createWithdrawal`'s transaction**, where the pending count and the
balance CAS have to live to be race-free — this is a cheap early refusal, the same pattern
`POST /api/auth/register` documents, not a replacement gate. And the probe is **still uncached
on the money path**, so §J4-7's freshness guarantee is intact: a request that will actually
create a withdrawal still takes a fresh probe.

The second half of §J3's handoff — every failed proof writing an `admin_audit_log` row including
those already refused by the lockout — is unchanged. It is disk rather than CPU, bounded at
20/min/IP, and is noted in J12-12 rather than treated as a separate finding.

---

#### Verification

`npm test` → **exit 0**, all ten suites. `scripts/test-rate-limits.js` grew from 22 to **51**
assertions; `node --check` on all six changed JS files and `bash -n` on the vhost script.

New in this pass:

- **§J12-1 (14 assertions).** A synthetic 41-day dataset — five miners, random gaps, a
  deliberately **quiet day** to exercise the horizon, and a partial current day — is aggregated
  by both the new composite read and the **original raw query verbatim**, and compared at
  `days = 1 / 7 / 30 / 40 / 90`. Plus: the rollup covers exactly the 39 busy completed days and
  never the current one; the horizon advances past the quiet day; a second call is a no-op;
  re-rolling five already-rolled days does not double count; the result is TTL-cached; and all
  three `EXPLAIN QUERY PLAN` shapes are pinned, including the negative control that a one-sided
  range restores the full `SCAN`.
- **§J12-3.** All four SEO blocks parsed out of the generated vhost and checked for both the
  forwarding header and a zone. (The first version of this assertion was itself wrong — it
  sliced each block at the first `}`, which is the one inside `${POOL_SERVICE}`.)
- **§J12-5 / -9.** Export bucket on both routes, no uncapped `SELECT` left, the in-file
  truncation marker, streaming `sendCsv`, and the topology memo.
- **§J12-11.** Behavioural, not textual: a real lockout is tripped, 500 distinct sources are
  then flooded through the limiter, and the test asserts the map stayed bounded **and** the
  live lockout survived.
- **§J12-12.** The precheck exists, the route calls it *before* the probe (by source offset),
  `createWithdrawal` still re-checks the pending cap inside its transaction, and the probe is
  still uncached.

**Gaps unchanged from the review session.** Nothing has run on a VPS; no sustained load was
generated, so every rate figure remains `limit × unit cost`; the nginx layer is read, not run,
so `limit_req burst … nodelay` behaviour under a real burst is still unsettled; and J12-6's
CoinGecko 403 is still an expectation rather than an observation.

**New for §J17, from this pass specifically.** (1) **The `miner_hashrate_daily` first run on an
established pool** walks up to 120 days of `hashrate_history` in one transaction — it is bounded
and it happens once, but it happens on the first tracking-loop tick after the upgrade, and that
is the moment to watch share acceptance. (2) **Confirm the leaderboard numbers do not move**
across the upgrade: the composite read is asserted to match the old query locally, but only a
box with real history proves the rollup and the raw tail meet without a seam. (3) **Click both
admin CSV export links** and confirm a normal-sized export carries no truncation row.

#### Changed in this pass

| File | Change |
|---|---|
| `lib/db.js` | J12-1 — `miner_hashrate_daily` table + covering `idx_mhd_day`, with the rejected-covering-index reasoning recorded at the schema |
| `lib/hashrate-tracker.js` | J12-1 — `rollupMinerDays()` + `_minerDayHorizon()` / `_setMinerDayHorizon()`; `getTopAvgHashrate` rewritten as a three-piece composite read behind a 60 s bounded TTL cache; rollup wired into the tracking loop |
| `lib/retention.js` | J12-1 — `miner_hashrate_daily` pruned on the same horizon as `hashrate_history`, reported in the run log and in `status().counts` |
| `lib/rate-limiter.js` | J12-11 — `MAX_TRACKED_BUCKETS` / `EVICT_BATCH` cap on `requests`, stale-first then oldest-insert; `violations` deliberately exempt, with the reason at the site |
| `lib/ip-filter.js` | J12-11 — `tempBan()` sweeps expired bans past `TEMP_BAN_SWEEP_AT`; never by size |
| `lib/withdrawal-scheduler.js` | J12-12 — `precheckWithdrawable()`, a read-only early refusal; the authoritative checks inside `createWithdrawal`'s transaction are untouched |
| `index.js` | J12-3 — `isLocalRequest()` now requires no `x-forwarded-for` as well as a loopback ip · J12-5 — both admin CSV exports capped, cursor-paged, on the `export` bucket, streamed, with an in-file truncation row · J12-9 — `/api/pool/topology` memoised 30 s · J12-11 — `ADMIN_FAIL_MAP_MAX` sweep in `recordAdminLoginFailure` · J12-12 — the route calls `precheckWithdrawable` before the Tor probe |
| `scripts/07_grin_mining_public_pool.sh` | J12-3 — all four SEO proxy blocks gain `X-Real-IP`, `X-Forwarded-For` and a `_static` `limit_req` zone |
| `scripts/test-rate-limits.js` | 22 → 51 assertions (sections 7 and 8 added) |

**Nothing from §J12 remains open.** The residuals are named rather than tracked as findings:
the ~1.4 M-row one-day raw tail at 1000 miners (durable fix = the per-miner hourly rollup in
`project_pool_db_capacity` item 2), and `/api/pool/topology`'s session-width `IN (…)` clause,
which the memo makes a once-per-30 s cost and which is still inside SQLite's parameter limit.

---

## §J13 — Outbound calls, SSRF & dependencies (2026-09-03, add-ons, NOT VPS-TESTED)

Thirteenth session of the pre-mainnet §J pass (see the Status roll-up at the top of this file).
Scope: every call that leaves the box —
[`lib/grin-node.js`](../../web/07_mining_pool_public/back-end-pool/lib/grin-node.js) (345),
[`lib/wallet.js`](../../web/07_mining_pool_public/back-end-pool/lib/wallet.js) (290),
[`lib/wallet-tor.js`](../../web/07_mining_pool_public/back-end-pool/lib/wallet-tor.js) (287),
[`lib/poolstats-reporter.js`](../../web/07_mining_pool_public/back-end-pool/lib/poolstats-reporter.js),
[`lib/alert-delivery.js`](../../web/07_mining_pool_public/back-end-pool/lib/alert-delivery.js),
[`lib/nostr-payout.js`](../../web/07_mining_pool_public/back-end-pool/lib/nostr-payout.js),
[`lib/node-stratum-client.js`](../../web/07_mining_pool_public/back-end-pool/lib/node-stratum-client.js),
the CoinGecko price fetch, [`lib/captcha.js`](../../web/07_mining_pool_public/back-end-pool/lib/captcha.js),
and the dependency tree in
[`package.json`](../../web/07_mining_pool_public/back-end-pool/package.json) /
`package-lock.json` plus the two `npm` call sites in
[`scripts/07_grin_mining_public_pool.sh`](../../scripts/07_grin_mining_public_pool.sh).

Method: enumerate every outbound sink first, then ask the plan's three questions of each one —
**who chooses the URL, does a redirect/scheme/host check stand between that choice and the
socket, and is the response bounded?** Advisory claims were resolved against the installed
tree rather than accepted from `npm audit`'s severity column: `qs`'s call graph was read,
`qs.parse` was driven with Express's real options, and `npm audit fix --dry-run` was run to
see what a fix would actually change.

**Headline — the SSRF question the plan asked has a reassuring answer and a surprising one.
Reassuring: every server-chosen destination is compiled in or comes from `pool.json`, and the
one settings-writable resolver (NIP-05) is closed at three independent layers including
`redirect: "manual"` inside `nostr-tools` itself. Surprising: the pool's outbound destination
set is not fully chosen by the operator at all — `_fetchDmRelays` takes any `wss://` string a
payout *recipient* publishes in their own Nostr event and hands it to `SimplePool.publish`,
so a registered miner picked up to four arbitrary WebSocket destinations per payout, loopback
and link-local included.**

*And the dependency half found its real problem one layer above the dependencies.* `npm audit`
reports three moderates; all three trace to `qs`, both are unreachable in this configuration
(evidence in J13-8), and no fix exists — express 4.22.2 pins `qs: ~6.15.1`, so
`npm audit fix` changes zero packages. The finding is not the CVEs, it is that when a real
lockfile-only fix does arrive, the toolkit's own deploy step will not install it: it re-runs
`npm` only when `package.json`'s hash changed, and `npm ci` installs from `package-lock.json`
(J13-6).

Ten findings. **Five fixed in this session** (J13-1, J13-3, J13-4's host filter, J13-6, and
J13-7's panel text — each small and local, plan rule 3). **J13-2 is a ruling, not a bug**:
§J8-3 explicitly deferred to this session the question of whether the three alert credentials
may be wired from settings into `config`, and the answer is *not without a host allowlist,
validators and a step-up gate* — the primitive is inert today only because the keys never load.

### The outbound inventory

Every socket this process opens to something it did not compile in. "Who picks it" is the
question that decides whether a finding exists.

| # | Sink | Transport | Who picks the destination | Redirects | Timeout | Response cap |
|---|---|---|---|---|---|---|
| 1 | Node JSON-RPC (`/v2/owner`, `/v2/foreign`) | `node-fetch@2` | `config.node_api_url` — **pool.json / `NODE_API_URL` only**, absent from `pool-settings.js` ([config.js:115](../../web/07_mining_pool_public/back-end-pool/lib/config.js#L115)) | follows, but `authorization` is stripped cross-host (J13-9) | 10 s, covers the body | none (loopback) |
| 2 | Wallet Owner API v3 | `node-fetch@2` | **hardcoded** `http://127.0.0.1:<owner_port>/v3/owner` ([wallet.js:24](../../web/07_mining_pool_public/back-end-pool/lib/wallet.js#L24)) | n/a | 10 s | none (loopback) |
| 3 | Tor pre-flight probe | SOCKS5 → `127.0.0.1:<tor_socks_port>` | onion **derived** from the miner's bech32 address; proxy is loopback | n/a | 3 s × 2 *(2026-09-23: 8 s per step, connect + `check_version` reply, × 2 attempts ≈ 32 s; now zero-dep `lib/socks5.js` + `http` over the tunnel, reply capped at 16 KB — impl §10.5)* | n/a |
| 4 | `grin-wallet send` | `spawn`, argv array | address regex-gated before it reaches `-d` | n/a | 120 s hard kill | unbounded stdout/stderr (Info) |
| 5 | Node stratum upstream | raw TCP | `node_stratum_host/port` — **pool.json only** | n/a | reconnect loop | n/a |
| 6 | Poolstats push | `https.request` | `poolstats_endpoint` — **pool.json only**, absent from `pool-settings.js` | none (raw `https`) | 10 s **inactivity** | **was none** → J13-3 |
| 7 | Discord / Slack / Telegram | `https.request` | `discord_webhook_url` / `slack_webhook_url` / `telegram_bot_token` — **pool.json only today** (§J8-3: the settings keys never reach `config`) | none | 10 s **inactivity** | **was none** → J13-3 |
| 8 | SMTP | `nodemailer` | `config.smtp` object passed through verbatim — pool.json only | n/a | nodemailer default | n/a |
| 9 | NIP-05 `/.well-known/nostr.json` | global `fetch` inside `nostr-tools` | miner supplies `name@domain`; **domain must be in `nostr_nip05_domains`** — settings-writable | **`redirect: "manual"`** | 10 s soft (J13-10) | none (J13-10) |
| 10 | Nostr relays | WebSocket (`ws`) via `SimplePool` | `nostr_relays` (settings-writable, `wss://`-validated) **∪ whatever the recipient advertises** | n/a | 30 s publish budget | wrap/rumor size caps |
| 11 | CoinGecko price | global `fetch` | **fixed literal** ([index.js:1131](../../web/07_mining_pool_public/back-end-pool/index.js#L1131)) | follows | 5 s `AbortSignal.timeout` | none (Info) |

Two things that look like outbound and are not, both verified:
[`lib/captcha.js`](../../web/07_mining_pool_public/back-end-pool/lib/captcha.js) is a
self-hosted arithmetic challenge with **no network code at all** (no reCAPTCHA/hCaptcha/
Turnstile anywhere in the backend), and `geoip-lite` is required and never asked to update —
its only network path is the manual `updatedb` npm script, which nothing calls.

### Threat actors used in this section

| Label | Means | Reach into this scope |
|---|---|---|
| **Anonymous internet** | No credential | Cannot choose any outbound destination. Can *trigger* #11 (rate-limited + negative-cached, §J12-6) |
| **Registered miner** | One valid ownership proof for one address | Chooses the NIP-05 name and, through their own npub's kind-10050, up to 4 relay URLs (J13-4). `withdraw` bucket, 20/min |
| **Owner of an allowlisted NIP-05 domain** | Controls `goblin.st` (or whatever the operator added) | Answers #9. Can hold the socket open past the soft timeout (J13-10) |
| **Logged-in admin / stolen `secureAdmin` session** | Session cookie, no step-up. §C3 keeps this live | Triggers #6 and #7 on demand (J13-1). Would gain a durable outbound primitive if §J8-3 is wired as proposed (J13-2) |
| **The webhook platform itself** | Discord / Slack / Telegram, and everyone in the operator's channel | Receives miner addresses and payout amounts (J13-5) |
| **On-box root** | Edits `pool.json` | Picks every destination in the table. Findings needing this are Info, per plan rule 7 |

### Findings

### J13-1 — [Medium] The admin *test* button bypasses every gate the poolstats pusher has, so a pool with the feature switched OFF and no API key still POSTs its live stats to a third party on demand — **FIXED 2026-09-03**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J13-1).**

### J13-2 — [High] The §J8-3 ruling: `postWebhook()` is an unrestricted outbound-request primitive, so wiring the three alert credentials from settings into `config` would turn a `secureAdmin` write into a durable, restart-surviving beacon — **RULING; do not wire without all three conditions below. Scheme check FIXED 2026-09-03, the rest is OPEN**

**Threat actor: stolen `secureAdmin` session** (the whole point of the ruling — this actor
cannot read the box's files today, and the wiring would hand them an egress channel that
does not need to).

§J8-3 found the `alerts` settings section inert: all nine keys are stored, served back to the
browser in cleartext, and read by nothing, because `applyToConfig` copies none of them
([pool-settings.js:305-309](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L305);
`grep -n discord_webhook_url lib/config.js` returns nothing). It offered three dispositions —
wire them up, wire them up *with masking*, or delete the fields — and handed §J13 the rider
that must be answered **before** the wiring lands. This is that answer.

**What the primitive is.** `postWebhook()`
([alert-delivery.js:196](../../web/07_mining_pool_public/back-end-pool/lib/alert-delivery.js#L196))
builds its request out of an operator-supplied `URL`:

```js
const options = { hostname: url.hostname, port: url.port || 443,
                  path: url.pathname + url.search, method: 'POST', … };
```

with no host allowlist, no scheme check (see the fix below), and an arbitrary port honoured
from the authority. `sendDiscord`/`sendSlack` reach it via `new URL(this.discordWebhook)` /
`new URL(this.slackWebhook)`, and there is **no validator for any of the three keys** — the
`alerts` validator block covers `alert_check_interval_secs` alone
([pool-settings.js:983-989](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L983)).

**Why it is worse than a one-shot SSRF.** Read-back is weak — the response body only reaches
`this.error(…)`, i.e. the journal, which this actor cannot read. The value is *egress*: the
destination is stored in `pool_config`, survives every restart, rides along in 089 backups,
is invisible from any public page, and is fired automatically by AlertMonitor on every
money event. Combined with J13-5 (the alert body carries miner addresses and payout amounts),
a `secureAdmin` write becomes a durable subscription to the pool's money flow, aimed at a host
of the attacker's choosing. That is a materially different asset from a session that expires.

**Ruling — all three are required before the keys are copied into `config`:**

1. **A host allowlist, and in this case a complete one.** This is not a case where an
   allowlist is impractical: the real destinations are a closed set —
   `discord.com` / `discordapp.com` for `https://discord.com/api/webhooks/…`,
   `hooks.slack.com` for `https://hooks.slack.com/services/…`, and Telegram is **already**
   hardcoded to `api.telegram.org`
   ([alert-delivery.js:82](../../web/07_mining_pool_public/back-end-pool/lib/alert-delivery.js#L82))
   with only the token operator-set. Enforce the host per key at *validate* time and again in
   `postWebhook`, exactly as `nostr_nip05_domains` does for the NIP-05 resolver.
2. **Per-key validators.** `discord_webhook_url` and `slack_webhook_url`: `https:` +
   allowlisted host + a path matching the vendor's shape. `telegram_bot_token`:
   `/^\d{5,15}:[A-Za-z0-9_-]{30,50}$/` — it is interpolated into a URL *string* before
   parsing, so a token is a template hole, not a value. (The `/bot` prefix does terminate the
   authority, so the host cannot be moved; the constraint is still owed.)
3. **Step-up.** The section moves into `STEP_UP_SETTINGS_SECTIONS`, or at minimum the three
   credential keys into `STEP_UP_SETTINGS_KEYS`. A `secureAdmin` write must not be able to
   choose where the pool's money alerts go.

§J8-3's masking rider stands on top of all three: read-back must return a `"••••••••"`
sentinel treated as "unchanged" on write. **If any of the three is not going to be built, take
§J8-3's third option and delete the fields** — a pool that stores a credential, hands it to any
admin session and gets nothing for it is the worst of the three, and that is the status quo.

**Fixed in this session (the one piece that was already live):** `postWebhook` never checked
the scheme. `new URL('http://internal/x')` parses, and `https.request` then dialled
`internal:443` *with TLS* regardless — so an operator pasting an `http://` webhook got a
confusing handshake failure instead of an error naming the problem. It now rejects anything
but `https:` up front
([alert-delivery.js:203](../../web/07_mining_pool_public/back-end-pool/lib/alert-delivery.js#L203)).

**One more, for the record, needing on-box root and therefore Info under plan rule 7:**
`sendEmail` passes `this.smtpConfig` straight into `nodemailer.createTransport`
([alert-delivery.js:115](../../web/07_mining_pool_public/back-end-pool/lib/alert-delivery.js#L115)).
nodemailer accepts transport shapes other than SMTP — `{ sendmail: true, path, args }` runs a
local binary — so `pool.json`'s `smtp` object is a command-execution surface, not just a host
and port. It stays Info because writing `pool.json` already implies the box, but it is a
reason `smtp` must **never** join the settings-writable set alongside the other three.

---

### J13-3 — [Low] Neither raw-`https` consumer capped its response body, and `timeout` on an `https.request` is an inactivity timer — so a drip-feeding endpoint holds the socket open and grows an unbounded string — **FIXED 2026-09-03**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J13-3).**

### J13-4 — [Medium] `_fetchDmRelays` turns any `wss://` string a payout recipient publishes into an outbound WebSocket connection, so a registered miner — not the operator — chose up to four of the pool's outbound destinations — **HOST FILTER FIXED 2026-09-03; the connection-lifetime half is OPEN**

**Threat actor: registered miner holding a valid ownership proof.** Gated behind
`nostr_payouts_enabled`, which is off by default at four verified layers (J13-9), so this is a
Medium rather than a High.

The plan asked whether an operator-set URL can be aimed at loopback or a metadata IP. For the
NIP-05 resolver the answer is a clean no (J13-9). But the relay set is not only operator-set.
`publishSlatepack` and `publishNotice` both *widen* the target list with whatever the
recipient advertises
([nostr-payout.js:218](../../web/07_mining_pool_public/back-end-pool/lib/nostr-payout.js#L218),
[:261](../../web/07_mining_pool_public/back-end-pool/lib/nostr-payout.js#L261)):

```js
let targets = this.relays.slice();
const hint = await this._fetchDmRelays(recipientPubHex);
if (hint && hint.length) targets = [...new Set([...hint, ...targets])];
…
const accepted = await this._publish(targets, wrap);   // SimplePool.publish → one WS per URL
```

and the only check `_fetchDmRelays` applied was a **prefix test**, `/^wss:\/\//`. That matched
`wss://127.0.0.1:3413/`, `wss://169.254.169.254/`, `wss://[::1]/` and
`wss://grin-node.internal/` as readily as a real relay. The chain is entirely inside the
miner's control: register a Goblin destination (ownership-gated, `withdraw` bucket) whose npub
you hold, publish a kind-10050 listing four hosts of your choosing, and every payout or
security notice to that destination makes the pool box open WebSocket connections to them.

Constraints that keep it Medium and not High, stated so the severity is auditable: `wss:` means
TLS, so a plain-HTTP internal service will not complete a handshake and this is a *blind*
probe, not a read-back; the payload is a NIP-59 gift wrap already encrypted to the recipient,
so nothing confidential is disclosed by delivering it to a relay of their choosing; and the
rail is off by default.

**Fixed** with a real host policy replacing the prefix test — new static
`_isPublicRelayUrl()`
([nostr-payout.js:354](../../web/07_mining_pool_public/back-end-pool/lib/nostr-payout.js#L354))
requires a parseable `wss:` URL with no credentials in the authority and a hostname that is
not an IPv4 literal, not a bracketed IPv6 literal, not single-label (`localhost`, a container
or service name), and not under `.localhost` / `.local` / `.internal`. Exercised over 16 cases
(see *Verification*). It is exported for tests and deliberately **not** applied to
`this.relays`, which the operator sets and `pool-settings.js` already validates.

**Left open — the connection lifetime.** `SimplePool` holds a persistent connection per relay
URL, and `stop()` closes only the configured set:
`this._pool.close(this.relays)`
([nostr-payout.js:138](../../web/07_mining_pool_public/back-end-pool/lib/nostr-payout.js#L138)).
Hint relays are never closed and never counted, so distinct hinted hosts accumulate across the
life of the process, bounded only by how many destinations register. The host filter bounds
*where*; nothing bounds *how many*. The fix is either to close hinted relays after the publish
or to keep a bounded LRU of them — sized against traffic that does not exist yet, so it is
left as a decision rather than guessed at.

---

### J13-5 — [Medium] Every alert rail exports the miner's full Grin address and exact payout amount to a third-party chat platform, and the email rail ships the whole alert payload verbatim — **OPEN (product decision; inert today)**

**Threat actor: the webhook platform, and every member of the operator's Discord/Slack channel
or Telegram group.** No attacker required — this is the feature working as written.

§G removed the (address, IP, time) linkage from the audit trail. §J11-2 removed the
address ↔ `kernel_excess` linkage from the pool-wide payments feed, on the grounds that a
permanent public address↔chain table is the worst thing a privacy coin's pool can publish. The
alert rail re-creates a smaller version of the same disclosure, off-box, with no mask:

```js
message: `Large withdrawal: ${big.amount.toFixed(4)} GRIN (#${big.id}) to ${big.grin_address}.`
```
([alert-monitor.js:322](../../web/07_mining_pool_public/back-end-pool/lib/alert-monitor.js#L322))

`alert.message` is what `sendDiscord` puts in the embed description, `sendSlack` in the
attachment text, and `sendTelegram` in the message body — so a full `grin1…` address plus an
exact amount goes to Discord's servers, Slack's servers, or Telegram's, and is then visible to
everyone in whatever channel the webhook posts into. A pool webhook in a semi-public operator
channel is a normal setup; nobody reading that channel has agreed to hold miner addresses.

**Email carries strictly more.** `formatEmailBody` appends `formatAlertData(alert.data)`
([alert-delivery.js:270-304](../../web/07_mining_pool_public/back-end-pool/lib/alert-delivery.js#L270)),
which pretty-prints the raw payload — for `large_withdrawal` that is
`{ withdrawal_id, amount, address, … }`, and for `unrecorded_wallet_send` the top five sends
with amounts and timestamps
([alert-monitor.js:285](../../web/07_mining_pool_public/back-end-pool/lib/alert-monitor.js#L285)).
The chat rails leak the address; the email rail leaks the record.

Also in this class: `wallet_identity_changed` publishes both the live and the expected pool
wallet identity ([alert-monitor.js:379](../../web/07_mining_pool_public/back-end-pool/lib/alert-monitor.js#L379)).
That one is arguably correct — it is the operator's own wallet, and an identity change is
exactly the event you want delivered somewhere you will actually read.

**Inert today** for the same reason as J13-2: the three webhook credentials never load, so
nothing is delivered. That is *why* this belongs in the same decision. The disposition is a
product call, not a patch:

- **Mask the address in `message`** to the same 9+4 form the public feeds use, keep the full
  value in `alert.data` (email only, a channel the operator controls), and say so in the
  panel; or
- **accept it and disclose it** — the privacy policy in
  [`pool-settings.js:509`](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L509)
  currently describes no third-party alert processor, and if alerts are wired it needs one.

Note §J11-1's caveat applied with full force here when this was written: the 9+4 mask was
invertible by joining the pool's own public feeds. **§J11's resolution pass (2026-09-02) closed
that** — all nine public list routes now mask and no page emits a full address — so masking the
chat rails is now a real reduction, not a fig leaf. Two caveats survive and should still be said
plainly rather than calling a masked address anonymous: the 9+4 form is still a unique key, so it
re-attaches to a full address obtained from **anywhere else** (a forum post, a support e-mail, an
earlier scrape taken before the fix); and the chat rails are off-box, where the pool's own
controls end.

---

### J13-6 — [Medium] The deploy step re-runs `npm` only when `package.json` changed, but `npm ci` installs from `package-lock.json` — so a lockfile-only security fix rsyncs onto the box and is never installed — **FIXED 2026-09-03**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J13-6).**

### J13-7 — [Low] The Goblin bridge snapshots its three security-relevant settings in the constructor, so turning the rail off — or **removing a domain from the NIP-05 allowlist** — persists, validates, and does nothing until restart — **PANEL TEXT FIXED 2026-09-03; the live-revocation half is OPEN**

**Threat actor: none attacking directly** — it is the operator's incident response that is
inert. It becomes attacker-relevant at exactly the wrong moment: when the operator is
responding to a compromised or typo-squatted allowlist entry and believes they have revoked it.

`NostrPayoutBridge`'s constructor reads all three once and nothing re-reads them:

| Field | Line | Read again anywhere? |
|---|---|---|
| `this.enabled` | [:60](../../web/07_mining_pool_public/back-end-pool/lib/nostr-payout.js#L60) | No — `isEnabled()` returns the snapshot, and it is the gate on the withdraw branch, both destination routes, and the account summary |
| `this.relays` | [:69](../../web/07_mining_pool_public/back-end-pool/lib/nostr-payout.js#L69) | No |
| `this.nip05Domains` | [:77](../../web/07_mining_pool_public/back-end-pool/lib/nostr-payout.js#L77) | No — `resolveDestination`'s allowlist check at [:182](../../web/07_mining_pool_public/back-end-pool/lib/nostr-payout.js#L182) reads the snapshot |

The underlying cause is one level up and is general, not Goblin-specific:
`PoolSettings.applyToConfig()` has exactly **one** caller —
[`config.js:262`](../../web/07_mining_pool_public/back-end-pool/lib/config.js#L262), reached
from `mergeDbSettings(config, db)` at
[`index.js:457`](../../web/07_mining_pool_public/back-end-pool/index.js#L457), which runs once
at boot. Nothing in the settings write path re-runs it. So every key that reaches a consumer
via `config` is a boot snapshot; the bridge is the case where one of those keys is described in
the UI as a security control.

**Why it is a finding and not just a property.** The same page already labels four fields
`Applied on backend restart`
([settings-payout.html:62, 75, 84, 89](../../web/07_mining_pool_public/back-end-pool/admin-panel/settings-payout.html#L62)).
Against that background, the absence of the note on the Goblin block read as "this one is
live" — and the block's existing text said a restart is needed *to enable* the rail
(`Requires npm install … and a backend restart`), which is the opposite of the dangerous
direction. Meanwhile the NIP-05 field's own helper text called itself
"the SSRF / look-alike-domain guard" with no restart note at all.

**Fixed (the honest half).** Making `isEnabled()` read `this.config` live would change nothing,
because `config` is itself a boot snapshot — so the fix is to stop the UI implying otherwise.
The Goblin section now states that **every** setting in it applies on backend restart
*including turning the rail off*, and the NIP-05 field says removing a domain does not revoke
it until the service restarts
([settings-payout.html:149-151, 171](../../web/07_mining_pool_public/back-end-pool/admin-panel/settings-payout.html#L149)).

**Left open:** whether a live kill-switch is wanted for this rail. It is buildable — the
payout-freeze switch (§reconciliation) is read per scheduler tick and is the existing pattern —
but it is a design decision, and §J4-5 already has an open finding about *that* switch's
granularity. Better decided together than twice.

---

### J13-8 — [Info] The dependency review, with evidence: three moderates, both advisories unreachable here, and no fix reachable either

`npm audit --omit=dev` against the committed lockfile, run once this session:
**3 moderate, 0 high, 0 critical**, over 114 prod + 10 optional packages. All three rows are
the same root — `qs`, reported once directly and twice through its dependents `body-parser`
and `express`.

| Advisory | Range | Installed | Reachable here? |
|---|---|---|---|
| GHSA-4mjr-xmp4-gh2g — DoS via attacker-controlled `isBuffer` (CVSS 5.3, `AV:N/AC:L/PR:N`) | `>=2.2.5 <6.16.0` | 6.15.3 | **No.** `utils.isBuffer` has exactly one caller in the installed tree — `qs/lib/stringify.js:127`. The pool never calls `qs.stringify`, and neither Express nor body-parser does: `qs` is reached only through Express's query **parser** |
| GHSA-x5fp-wj9c-mxmx — array-limit bypass via bracket-key comma parsing (CVSS 3.7) | `>=6.14.2 <=6.15.3` | 6.15.3 | **No.** It needs `comma: true`. Express's extended parser passes `{ allowPrototypes: true, arrayLimit: 1000 }` (`express/lib/utils.js:289-291`) and nothing else; `express.json()` is the only body parser mounted ([index.js:232](../../web/07_mining_pool_public/back-end-pool/index.js#L232)), so body-parser's urlencoded path is not even registered |

Driven directly rather than reasoned about: `qs.parse` was run under Express's exact options
with an index past `arrayLimit`, comma-bearing bracket keys, a 5,000-element comma value and
`a[2147483647]=x`; every case returned in under 3 ms with no array amplification.

**And no fix exists.** `npm audit` says `fixAvailable: true`, but
`npm audit fix --omit=dev --dry-run` reports `"added": 0, "removed": 0, "changed": 0` and
leaves both files byte-identical. The reason is in the tree: express 4.22.2 declares
`qs: "~6.15.1"`, which cannot reach the patched 6.16.0. The only path is express 5 behind
`--force`. **So `npm audit` will be red on every install of this pool for reasons the operator
cannot act on** — which is the actual risk here, because an audit that is permanently red is an
audit nobody reads. It should be stated in the pre-mainnet gate rather than discovered.

**The rest of the plan's dependency checklist, each checked:**

- **`multer@2`** — lockfile pins **2.2.0**, past the 2.0.0–2.0.1 DoS line; clean in the audit.
- **`jsonwebtoken@9`** → 9.0.3, **`ws@8`** → 8.21.1, **`socks`** → 2.8.9, **`nostr-tools`** →
  2.24.1, **`dotenv`** → 16.6.1, **`ipaddr.js`** → 2.4.0, **`cookie-parser`** → 1.4.7,
  **`nodemailer`** → 9.0.3, **`geoip-lite`** → 2.0.3. All clean; all satisfy the ranges in
  `package.json`, so `npm ci` and `npm install` agree.
- **`node-fetch@2` (EOL)** — no open advisory, and the one that mattered is verifiably fixed in
  the installed copy: CVE-2022-0235's cross-host credential leak is closed at
  `node_modules/node-fetch/lib/index.js:1610-1612`, which deletes `authorization`,
  `www-authenticate`, `cookie` and `cookie2` when a redirect leaves the domain or changes
  protocol. Both consumers are loopback anyway. EOL is a maintenance risk, not a live one.
- **`bcryptjs@2` (unmaintained)** — cost factor 12
  ([auth.js:50](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L50)), hashing is
  `await`ed rather than sync ([auth.js:689](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L689),
  [:802](../../web/07_mining_pool_public/back-end-pool/lib/auth.js#L802)) so it does not block
  the event loop the stratum server shares.
- **Install scripts: zero.** No package in the 124-entry lockfile carries `hasInstallScript`,
  so `npm ci` executes no third-party code at install time — worth stating because the
  installer runs it as root. `geoip-lite`'s network fetch is the manual `updatedb` script,
  which nothing calls.
- **`engines: node >=24`** matches the installer, which removes the distro packages and pulls
  NodeSource `setup_24.x` on both apt and dnf
  ([07_grin_mining_public_pool.sh:455-466](../../scripts/07_grin_mining_public_pool.sh#L455)).
  Consistent. (That step is `curl … | bash -` as root — a real supply-chain surface, but it is
  §J16's file and §J16's call.)

**One sub-point worth carrying forward: the off-by-default guarantee does not extend to the
supply chain.** `nostr-tools`, `ws` and `nodemailer` are hard `dependencies`, not
`optionalDependencies`, even though all three are lazy-`require`d precisely so the pool boots
without them ([nostr-payout.js:280-291](../../web/07_mining_pool_public/back-end-pool/lib/nostr-payout.js#L280),
[alert-delivery.js:100-108](../../web/07_mining_pool_public/back-end-pool/lib/alert-delivery.js#L100),
whose comment calls nodemailer "an optional dependency" — it is not). So every pool installs
the full tree for two features that are off by default and, per §J8-3, one of which is wired to
nothing. Moving them to `optionalDependencies` would make the code's own claim true and shrink
the default install; it would also mean the Goblin rail's "run `npm install`" instruction
becomes load-bearing rather than already-satisfied. A decision, not a defect.

---

### J13-9 — [Info] Verified correct, with evidence

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J13-9).**

### J13-10 — [Low] `withTimeout` gives up waiting but never aborts, so a slow allowlisted NIP-05 domain leaves a live socket and an uncapped `res.json()` behind for every attempt — **OPEN**

**Threat actor: whoever controls an allowlisted NIP-05 domain** (by default `goblin.st`, a
third party the operator has chosen to trust for *resolution*, not for *availability*).

```js
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    …
```
([nostr-payout.js:494-502](../../web/07_mining_pool_public/back-end-pool/lib/nostr-payout.js#L494))

It races a timer against the promise. It carries no `AbortController`, and `nostr-tools`'
`queryProfile` accepts no signal — so when the 10 s budget expires the caller sees `timeout`
and the underlying `fetch` keeps running: socket held, response still accumulating into an
uncapped `res.json()`. Priced by the `withdraw` bucket at 20/min per IP, so a proof-holding
miner pointing at a deliberately slow allowlisted domain accumulates abandoned sockets faster
than they retire.

Bounded in practice by the ownership gate, the rail being off by default, and the fact that
the operator chose the domain — hence Low. The fix is to pass an `AbortSignal` through
`nostr-tools`' `useFetchImplementation` hook (the module exports it precisely so the fetch can
be replaced) and to cap the body there; it is a small change in a section the module marks as
the only nostr-tools-coupled code, so it is a good candidate for whenever that section is next
touched. Not done this session because it changes the wire section, which is not "small and
local" in the sense plan rule 3 means.

The same shape, benignly: `_fetchDmRelays` wraps `this._pool.get(...)` in the same helper, and
the CoinGecko fetch at [index.js:1129](../../web/07_mining_pool_public/back-end-pool/index.js#L1129)
uses a real `AbortSignal.timeout` — which is what the NIP-05 path should look like.

### Handoffs

- **§J8 (secrets & key management)** — J8-3's rider is answered as J13-2: **do not wire**
  `discord_webhook_url` / `slack_webhook_url` / `telegram_bot_token` into `config` without a
  host allowlist, per-key validators and step-up, or take J8-3's third option and delete the
  fields. Its masking requirement stands on top. Also for J8's inventory: `config.smtp` is a
  nodemailer transport object, not just a host and port, and must never become settings-writable.
- **§J14 (admin panel front-end)** — two from this session. (a) `analytics.plausible_src` and
  `analytics.umami_src` default to third-party script URLs
  ([pool-settings.js:189-191](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L189))
  and their validators are a bare `new URL(val)`, so an operator-set value becomes a
  `<script src>` on every public page bounded only by the nginx CSP allowlist; that is the same
  family as §J9-3 and §J1-9 and belongs with the other script sinks. (b) The three
  `/api/admin/poolstats/*` routes have **no page at all** (J13-1) — either build one or
  remove them, because an unreferenced admin route is one nobody reviews.
- **§J15 (public front-end)** — nothing new; the Goblin markup's fail-closed layer (layer 3 of
  four) is confirmed as J15's to verify, unchanged from §J4's handoff.
- **§J16 (deployment & infra)** — three. (a) The Node install is
  `curl -fsSL https://deb.nodesource.com/setup_24.x | bash -` as root
  ([07_grin_mining_public_pool.sh:458, 464](../../scripts/07_grin_mining_public_pool.sh#L458));
  the version choice is correct against `engines`, the delivery is §J16's call. (b) J13-6 is
  fixed in `pool_deploy_code`, but §J16 should decide whether the deploy ought to *verify*
  rather than *infer* — `npm ci --dry-run` or an `npm ls --omit=dev` check would catch a
  `node_modules` that has drifted from the lockfile for any other reason. (c) If J13-2's
  allowlist is built, the nginx egress story should be stated: nothing on this box restricts
  outbound connections, so the app-layer allowlist is the only control.
- **§J17 (operational gate)** — three things only a box settles. (1) **State in the launch
  notes that `npm audit` is permanently red** for the reason in J13-8, with the three rows
  named, so an operator does not read it as a new finding — and re-run it at launch to confirm
  nothing *else* has appeared. (2) If the Goblin rail is ever exercised on testnet, J13-4's
  open half (unbounded hinted-relay connections) is observable with `ss -tp` on the pool
  process and nothing else will show it. (3) J13-6's fix should be staged once: change only
  `package-lock.json`, run the deploy step, and confirm `npm ci` runs.
- **memory `project_pool_ip_privacy`** should gain the alert rail as a **fifth** out-of-DB
  address sink alongside §J8-5's journal, whichever disposition J13-5 gets.
- **memory `project_pool_nostr_payouts`** — the four-layer guarantee is verified but is a
  *boot-time* guarantee (J13-7), and the relay set is not purely operator-chosen (J13-4). Both
  are worth recording there, because the memory currently reads as though the operator controls
  the whole outbound set.

### Verification

- **`npm test` — full suite green**: `12 + 47 + 32 + 52 + 65 + 18 + 21 + 24 + 51` =
  **322 passed, 0 failed**, after this session's four code fixes. Same baseline as §J12.
- **`node --check`** clean on all three edited JS files
  (`lib/poolstats-reporter.js`, `lib/alert-delivery.js`, `lib/nostr-payout.js`).
- **`bash -n scripts/07_grin_mining_public_pool.sh`** clean after the J13-6 fix.
- **J13-4's host filter driven directly**, 16 cases via the newly exported
  `require('./lib/nostr-payout')._isPublicRelayUrl`: `wss://relay.floonet.dev`,
  `wss://relay.0xchat.com/` and `wss://sub.relay.example.co.uk:7777/path` accept;
  `wss://127.0.0.1:3413/`, `wss://169.254.169.254/latest/meta-data/`, `wss://[::1]/`,
  `wss://[fd00::1]:8080/`, `wss://localhost:3413/`, `wss://pool.localhost/`,
  `wss://grin-node.internal/`, `wss://redis.local/`, `ws://relay.example.com/`,
  `https://relay.example.com/`, `wss://user:pw@relay.example.com/`, `not a url` and `''`
  all reject. **16/16.**
- **`npm audit --omit=dev --json`** and **`npm audit fix --omit=dev --dry-run --json`** each run
  once; `package.json` and `package-lock.json` verified byte-identical afterwards
  (`diff -q`), so the audit left no residue.
- **`qs` advisory reachability** established by reading the installed call graph
  (`grep -n isBuffer node_modules/qs/lib/*.js` → one caller, in `stringify.js`) and by driving
  `qs.parse` under Express's real options — not from the advisory text.
- **node-fetch redirect behaviour** established the same way
  (`node_modules/node-fetch/lib/index.js:1610-1612`), not from release notes.
- Per plan rule 5: nothing ran on a VPS, and nothing long-running ran locally — every command
  was a one-shot that exited.

### Changed this session

| File | Change |
|---|---|
| [`lib/poolstats-reporter.js`](../../web/07_mining_pool_public/back-end-pool/lib/poolstats-reporter.js) | J13-1 `_assertSubmittable()` + call from `submit()`; J13-3 64 KB response cap |
| [`lib/alert-delivery.js`](../../web/07_mining_pool_public/back-end-pool/lib/alert-delivery.js) | J13-2 `https:`-only scheme check in `postWebhook`; J13-3 64 KB response cap |
| [`lib/nostr-payout.js`](../../web/07_mining_pool_public/back-end-pool/lib/nostr-payout.js) | J13-4 `_isPublicRelayUrl()` host policy replacing the `^wss://` prefix test in `_fetchDmRelays`; exported for tests |
| [`admin-panel/settings-payout.html`](../../web/07_mining_pool_public/back-end-pool/admin-panel/settings-payout.html) | J13-7 restart notes on the Goblin block and the NIP-05 allowlist field |
| [`scripts/07_grin_mining_public_pool.sh`](../../scripts/07_grin_mining_public_pool.sh) | J13-6 `pool_deploy_code` hashes `package.json` **and** `package-lock.json`; both log lines updated |

**Still open from this session:** J13-2 (the ruling — blocks §J8-3's wiring option), J13-4's
connection-lifetime half, J13-5 (product decision, inert today), J13-7's live-revocation half,
J13-10. None of them can move money incorrectly; J13-2 is the one that must be decided before
any code changes in the `alerts` section.

---

## §J14 — Admin panel front-end (2026-09-03, add-ons, NOT VPS-TESTED)

Fourteenth session of the pre-mainnet §J pass (see the Status roll-up at the top of this file).
Scope: the 21 pages and 3 shared scripts under
[`back-end-pool/admin-panel/`](../../web/07_mining_pool_public/back-end-pool/admin-panel/) —
`admin-shell.js` (1,008), `settings-common.js` (1,273), `cms-editor.js` (127), plus the
**2,754 lines of inline `<script>`** the HTML pages carry — together with the three helper
scripts the panel loads from the public tree (`js/api.js`, `js/auth.js`, `js/stepup.js`),
which are §J15's files but the panel's only auth surface.

Method: a mechanical DOM-XSS sweep first (every `innerHTML` / `insertAdjacentHTML` / template
write, with each interpolation classified by who chooses its value), then the plan's four
specific questions — token handling, the `AdminTable` cell renderer, the step-up retry path,
and clickjacking. Two sweeps were automated rather than eyeballed: one that flags any `${…}`
interpolation with no escape/format call, and one that re-runs the settings-harvester id diff
from memory `project_pool_admin_settings_form` against the live `PoolSettings.defaults`.

**Headline — the sweep the plan predicted would find an §I10 came back clean, and the real
findings are a different kind of bug.** Every operator-, miner- and server-supplied string
that reaches `innerHTML` in this panel is escaped; there is no reachable stored XSS here.
What the sweep found instead is that **two of the screens an operator reads to decide whether
money is moving correctly are misreporting it.** The dashboard renders every payout with a
January-1970 date, the literal string `undefined` in the miner column, and a grey "finished"
badge whether that payout succeeded or failed; the blocks page shows every block the pool has
actually been paid for as a grey unknown status with its maturity countdown still running,
under a KPI that contradicts it. Both are the *same* bug §H4 and §J5-4 already fixed
elsewhere, surviving on the pages those fixes did not touch.

*And the escaping that came back clean is clean by accident in five places.* Five row buttons
splice an HTML-escaped value into a **JS string literal inside an `on*` attribute** — a
context where `&#39;` is decoded back to a real apostrophe before the JS is parsed. Nothing in
the panel prevents that; what prevents it is a charset validator in a different file, on a
different route, and for `regions.html` on a different *branch* of that route.

Eleven findings, **all now closed**. Seven were fixed in the review session itself (J14-1,
J14-2, J14-3, J14-5, J14-6, J14-7, J14-8 — each small and local, plan rule 3); two were
written up and deliberately left open under plan rules 3 and 6 (J14-4 belongs to §J16's file,
J14-9 waited on a §J10 product decision) and were **fixed in a same-day follow-up pass on the
operator's instruction to close everything this session found**; the remaining two are Info.
All of it is pinned by a new `scripts/test-admin-panel.js` (39 assertions across 8 sections)
and by extending `check-syntax.js` to the inline blocks.

**The follow-up pass is marked separately throughout.** J14-4 and J14-9 were fixed *after* the
findings were written, not folded back into them: the finding text still says what was wrong
and the fix note says what changed, so the record of what the review actually found stays
readable.

### Threat actors used in this section

| Actor | Meaning here |
|---|---|
| **Anonymous internet** | No session. Can write `admin_audit_log` rows (a failed login carries an attacker-chosen username) and the public ad counters — both rendered in this panel. |
| **Registered miner** | Holds a stratum-valid Grin address. Chooses their own address and worker labels, both of which reach admin surfaces. |
| **Logged-in admin** | A `secureAdmin` session, possibly a *stolen* one (§C3: an access token survives logout, password change and "revoke sessions"). Authors CMS, branding, ads, regions and settings. |
| **On-box root** | Info-tier by plan rule 7. |

### Findings

### J14-1 — [Medium] `paid` is the terminal state of every block the pool actually earned, and the blocks page does not know it exists — so a healthy pool's own history renders as grey unknown rows with a maturity countdown still running, under a KPI that contradicts the table — **FIXED 2026-09-03**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J14-1).**

### J14-2 — [Medium] The dashboard's *Recent Withdrawals* table is wired to a schema that has never existed: every row shows a January-1970 date, the literal string `undefined` for the miner, an empty tx column, and a grey "finished" badge whether the payout succeeded or failed — **FIXED 2026-09-03**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J14-2).**

### J14-3 — [Low] Five row buttons splice an HTML-escaped value into a JS string literal inside an `on*` attribute, where the parser decodes it back before the JS runs — and the only thing stopping it is a validator in another file, on another route — **FIXED 2026-09-03**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J14-3).**

### J14-4 — [Medium] The admin panel is served the **public** page CSP, so it allowlists four third-party script origins and five `connect-src` origins it never uses — handing any admin-panel XSS a ready exfiltration channel — **FIXED 2026-09-03 (follow-up pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J14-4).**

### J14-5 — [Low] `npm run check-syntax` — the pool's only pre-commit gate — could not see 2,754 lines of the admin panel's JavaScript, because it lives in inline `<script>` blocks — **FIXED 2026-09-03**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J14-5).**

### J14-6 — [Low] A settings save the server refuses reported the fixed string "Save failed", discarding the reason — including the unknown-key error that names the offending element, every validator message, and the step-up refusal — **FIXED 2026-09-03**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J14-6).**

### J14-7 — [Low] The announcement and lottery-event attribute escapers escape `"` but not `&`, so an operator's own text is silently rewritten on the next render — **FIXED 2026-09-03**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J14-7).**

### J14-8 — [Low] Three escapers used `String(s || '')`, so a legitimate `0` rendered as blank — a pool with no connected rigs displayed "Miners:" with nothing after it — **FIXED 2026-09-03**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J14-8).**

### J14-9 — [Low] The ads table presents anonymous-writable counters as a measured click-through rate, with no qualifier — **FIXED 2026-09-03 (follow-up pass); takes J10-3 dispositions 1 + 2**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J14-9).**

### J14-10 — [Info] Verified correct, with evidence

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J14-10).**

### J14-11 — [Info] Three `/api/admin/poolstats/*` routes have no page anywhere in the panel

Inbound handoff (b) from §J13, confirmed by grep across all 24 panel files: nothing references
`poolstats`. The routes are `GET /api/admin/poolstats` (secureAdmin),
`POST /api/admin/poolstats/update-key` (freshAdmin) and `POST /api/admin/poolstats/test`
(secureAdmin), at index.js:5053–5079. §J13-1 found and fixed a real gate bypass in the third —
which restates J13's point: an admin route with no UI is a route nobody exercises and nobody
reviews. Not fixed here, because the choice (build the page, or delete the routes) is a product
decision rather than a front-end one.

### Handoffs

- **§J16 (deployment & infra)** — J14-4 was **handed over and then fixed in the follow-up
  pass**, so §J16 inherits a change to its file rather than a task: `location /admin/` now
  includes a new `$hdr_admin` snippet instead of `$hdr_page`, and the vhost has three header
  snippets where it had two. **§J16 should re-read the whole header section as one unit** —
  the §I1 rule that any block declaring an `add_header` must re-include a snippet now has a
  third snippet to get right, and the only real proof any of it works is an `nginx -t` plus a
  live response-header read, neither of which can happen here. The new snippet also sets
  `frame-ancestors`, `base-uri`, `form-action` and `object-src`, which the other two still do
  not — the public pages remain without them, and that is §J16's call, not this session's.
  `X-Frame-Options: DENY` is unchanged and still correctly re-included everywhere.
- **§J10 (uploads, assets, CMS & ads)** — J14-9 is fixed and took **J10-3 dispositions 1 + 2**
  (qualify the counters; refuse events for ads that are not being served). **J10-3 itself
  stays OPEN**: the endpoint is still anonymous-writable, because disposition 3 is the only
  cure and it costs a per-visitor record the pool has decided against. §J10 should record that
  the choice has now been made in code, and that reversing it means changing `ads.html`'s
  wording back too — the label and the endpoint are one decision in two files.
- **§J13 (outbound calls)** — handoff (b) answered as J14-11. Handoff (a) resolves differently
  than the handoff assumed: `plausible_src`, `umami_src` and `matomo_url` **are** already in
  `STEP_UP_SETTINGS_KEYS` (index.js:6622), gated on a real value change, alongside
  `custom_head_html` and `custom_body_html` — §J1-1's fix covered them. The residual was that
  the *nginx* CSP allowlisted those provider hosts for the whole site including `/admin/`; the
  follow-up pass's J14-4 fix removes `/admin/` from that set, so the allowlist now covers only
  the public pages that actually load those providers.
- **§J6 (stratum & share intake)** — the worker-name render question is answered: the admin
  panel does **not** render worker labels anywhere. `miners.html` shows only the account
  address, and there is no admin worker list. §J6-9's "a login with no work behind it is
  published as an online worker on someone else's account page" is therefore a public-page
  problem only, and belongs entirely to §J15.
- **§J15 (public front-end)** — three carried over. (1) `js/auth.js`, `js/api.js` and
  `js/stepup.js` live in `public_html/js/` and are §J15's files, but they are the admin
  panel's entire auth surface; the escaping in `guardAdminPage()` (username escaped before
  `innerHTML`) and the httpOnly-cookie posture were checked here and are correct. (2)
  `Auth.fetch()` returns `null` on a non-JSON response *and* on a network error, so a caller
  cannot distinguish "the server refused" from "the request never happened" — every admin
  caller happens to treat `null` as failure, but a public-page caller that treats it as an
  empty result would render "no data" during an outage. (3) `login.html`'s own 2FA/step-up
  flow was not read here — it is §J15's by the plan's split.
- **§J17 (operational gate)** — two. (1) J14-1 and J14-2 both mean *the panel currently
  misreports money state*, so both must be re-checked on a box with real rows before the soak
  in §J17 step 5 is treated as evidence: a dashboard showing 1970 dates and uniformly grey
  badges would have made a failed payout invisible during exactly that drill. (2)
  `npm run check-syntax` now covers the inline blocks — re-run it after any admin-panel edit
  made during the launch sequence, because a syntax error there takes the whole page down at
  parse time.
- **memory `project_pool_admin_settings_form`** — the toast it describes ("a toast that names
  an element") was accurate when written and had stopped being true: `saveSection` discarded
  the body. J14-6 restores it, so the memory is correct again; worth a line saying the
  behaviour is now pinned by `test-admin-panel.js`.
- **memory `project_pool_admin_table`** — add that `AdminTable` escapes its own composed
  strings but `row()` is not escaped for you, so the obligation sits with the page; and that
  panel row-action buttons pass values via `data-*` + `this.dataset`, never spliced into an
  `on*` handler (J14-3).

### Verification

- **`npm test` — full suite green**: `12 + 47 + 32 + 52 + 65 + 18 + 21 + 24 + 51 + 39` =
  **361 passed, 0 failed**, after this session's seven fixes *and* the follow-up pass's two.
  Baseline was 322 (§J13); the 39 new assertions are `scripts/test-admin-panel.js`.
- **`scripts/test-admin-panel.js` proven to fail, not just to pass** — three separate times.
  Reverting the `miners.html` half of J14-3 produced `FAIL no on* handler splices an
  HTML-escaped value into a JS string literal`; pointing `location /admin/` back at `$hdr_page`
  produced `FAIL location /admin/ includes $hdr_admin, not $hdr_page`; and removing the `~`
  from the CTR plus the `is_active = 1` predicate from `recordEvents` produced two more FAILs.
  Every file was restored and the suite returned to 39/39 each time.
  Five of its eight sections carry an internal control — the on*-sweep must detect its own
  pattern, the escaper sweep must find ≥10 escapers, no status the scheduler never writes may
  reappear in the dashboard map, `location /` must still get the public CSP, and
  `publicByPlacement` must still use the predicate `recordEvents` was made to match — so a
  clean result cannot come from a broken sweep. The `location /` control is the one that
  earned its keep: written the obvious way it matched the pre-certbot one-line bootstrap
  vhost and passed vacuously.
- **`check-syntax.js`'s new inline coverage proven to fail**: `{{{ deliberate syntax error`
  injected into `blocks.html` produced `FAIL admin-panel/blocks.html (inline <script> #1)`
  with the correct source line (`admin-panel/blocks.html:80`) and exit 1. Restored; the gate
  now reports `Syntax OK — 60 files + 21 inline <script> blocks checked.`
- **`node --check`** clean on `index.js`, `lib/ads.js`, `scripts/check-syntax.js` and
  `scripts/test-admin-panel.js`; the seven edited HTML pages are covered by the new inline
  check. **`bash -n` clean** on `scripts/07_grin_mining_public_pool.sh` after the vhost change.
- **J14-2 demonstrated against the real schema**, not asserted: the `withdrawals` CREATE TABLE
  was parsed out of `lib/db.js` and shown to contain neither `username`, `user_id` nor
  `tx_slate_id`, and `fmtDate`/`fmtTs` were run side by side on one live `created_at`.
- **The `escHtml`-in-`onclick` decode order** was reasoned from the HTML parse order and then
  *bounded* by reading each value's actual producer (the bech32 validator, `proxy-addr`'s
  `isip` test, the `if (wgPubkey)` branch) — reported as a latent structural bug, not as a
  live exploit.
- **The settings-harvester sweep** was re-implemented against the live
  `require('./lib/pool-settings.js').defaults`, not against a copy of the key list.
- Per plan rule 5: nothing ran on a VPS and nothing long-running ran locally — every command
  was a one-shot that exited. No test server was started.

### Changed this session

| File | Change |
|---|---|
| [`admin-panel/blocks.html`](../../web/07_mining_pool_public/back-end-pool/admin-panel/blocks.html) | J14-1 `paid` added to `STATUS`; maturity cell treats `paid` as matured; `Paid out` filter chip |
| [`admin-panel/index.html`](../../web/07_mining_pool_public/back-end-pool/admin-panel/index.html) | J14-2 `fmtTs` (×1000), `grin_address` + `slate_id` columns, real 11-status badge map; J14-8 escaper |
| [`admin-panel/miners.html`](../../web/07_mining_pool_public/back-end-pool/admin-panel/miners.html) | J14-3 ban/unban buttons pass the address via `data-addr` + `this.dataset` |
| [`admin-panel/users.html`](../../web/07_mining_pool_public/back-end-pool/admin-panel/users.html) | J14-3 both *Lift ban* buttons pass the IP via `data-ip`; J14-8 escaper |
| [`admin-panel/regions.html`](../../web/07_mining_pool_public/back-end-pool/admin-panel/regions.html) | J14-3 pairing button passes the region via `data-region` |
| [`admin-panel/health.html`](../../web/07_mining_pool_public/back-end-pool/admin-panel/health.html) | J14-8 escaper no longer blanks a real `0` |
| [`admin-panel/settings-common.js`](../../web/07_mining_pool_public/back-end-pool/admin-panel/settings-common.js) | J14-6 `saveSection`/`restoreSection` surface `body.error`; J14-7 `bannerAttr`/`eventAttr` escape `&` first |
| [`index.js`](../../web/07_mining_pool_public/back-end-pool/index.js) | J14-1 `blocks_to_maturity` treats `paid` as matured |
| [`scripts/check-syntax.js`](../../web/07_mining_pool_public/back-end-pool/scripts/check-syntax.js) | J14-5 inline `<script>` extraction + line-aligned `node --check` |
| [`scripts/test-admin-panel.js`](../../web/07_mining_pool_public/back-end-pool/scripts/test-admin-panel.js) | **new** — 39 static assertions pinning J14-1/-2/-3/-4/-6/-7/-8/-9 and the token invariant |
| [`package.json`](../../web/07_mining_pool_public/back-end-pool/package.json) | `test:unit` runs `test-admin-panel.js` |

**Follow-up pass (same day), closing the two that were left open:**

| File | Change |
|---|---|
| [`scripts/07_grin_mining_public_pool.sh`](../../scripts/07_grin_mining_public_pool.sh) | J14-4 new `hdr_admin` snippet (`connect-src 'self'`, no third-party origins, plus `frame-ancestors`/`base-uri`/`form-action`/`object-src`); `location /admin/` includes it instead of `$hdr_page`; cleanup removes it |
| [`admin-panel/ads.html`](../../web/07_mining_pool_public/back-end-pool/admin-panel/ads.html) | J14-9 `(unverified)` column qualifier + `.th-qual` style, `(~x.x%)` ratio, rewritten note, cell `title` |
| [`lib/ads.js`](../../web/07_mining_pool_public/back-end-pool/lib/ads.js) | J14-9 / J10-3 disposition 2 — `recordEvents` counts only ads the public site is actually serving |
| [`index.js`](../../web/07_mining_pool_public/back-end-pool/index.js) | beacon route comment records that the endpoint is unauthenticated *by design* and its output is not measurement |

**Still open from this session:** nothing. J14-4 and J14-9 were closed in the follow-up pass;
J14-10 and J14-11 are Info. One inherited item is deliberately **not** closed: **§J10-3 remains
OPEN** — the ad beacon is still anonymous-writable, which is a §J10 product decision this
session's fix labels honestly rather than overrides.

---

## §J15 — Public front-end (2026-09-03, add-ons, NOT VPS-TESTED)

**Scope, as set for §J15 by the run plan (since deleted; see the Status roll-up):** `public_html/` — the
thirteen pages (6,275 lines of HTML, 2,754 of it inline `<script>`) and `js/` (4,968 lines,
twelve modules, vendor excluded). Every `innerHTML` / `insertAdjacentHTML` / template write
was enumerated and traced to its producer; `account-settings.html` (1,923 lines, the
withdrawal form) and `login.html` (612, the admin credential form) were read end to end.

**Everything below is on `add-ons` and has never run on a VPS.** Nothing was executed here
beyond one-shot `node --check`, `bash -n`, the repo's own `npm test`, and one `vm`-sandboxed
harness that exits on its own. No server was started (plan rule 5).

### The sink inventory

94 HTML-writing sites exist under `public_html/`. One is vendor (`quill.js`). Of the
remaining 93:

| Class | Count | Verdict |
|---|---|---|
| Literal markup, no interpolation (`'<tr><td colspan="7">Loading…</td></tr>'`) | 41 | safe by construction |
| Interpolates only `Number()`/`toFixed()`/`toLocaleString()` output | 17 | safe |
| Interpolates a server string through a five-character escaper | 27 | safe — every escaper checked, see J15-11 |
| `window.Explorer.link()` (escapes URL *and* label) | 6 | safe |
| **Deliberate operator-HTML sinks** (`custom_head_html`, `custom_body_html`, ad `html_code`, CMS `body_html`/`html`) | 5 | by design, §B accepted, tier settled §J1-1 |
| **Operator string reaching `innerHTML` raw, NOT by design** | 1 | **J15-1** |

The last row is the finding. The 27-escaper column is what §I10 was about and it now holds:
`escHtml` in `account-settings.html:851`, `miners-stats.html:263`, `payment-history.html:313`,
`blocks.html`; `esc` in `network-map.js:31`, `fortune-board.html:195`, `post.html:80`,
`blog.html:113`; `escapeText` in `branding.js`; `attr` in `ads.js:16`; `H.escHtml` in
`payout-goblin.js`. Nine of the eleven escape all five of `& < > " '`; the two that escape
only `& < >` (`branding.js escapeText`, `network-map.js esc`) are used **only** in element
content, never in an attribute — checked at every one of their 14 call sites.

### Threat actors used in this section

- **Anonymous internet** — a visitor, or anyone who can make a public page's API call fail.
- **Logged-in admin / stolen admin token** — the §C3 actor: `secureAdmin` for up to the idle
  window, surviving logout, password change and *Revoke sessions*. This is the actor for
  every operator-authored-content finding, exactly as in §J1-1.
- **The deploying operator's own users** — for the identity/attribution findings, where the
  harm is what a *fresh install* asserts on the operator's behalf.

---

### Findings

### J15-1 — [Medium] `maintenance_message` reaches `innerHTML` raw on eleven public pages — the sixth operator-HTML sink, the one §J1-1's key table missed, and the only one still at plain `secureAdmin` with no validator at all — **FIXED 2026-09-03**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J15-1).**

### J15-2 — [Medium] `Auth.fetch` never rejects and hands a 429's JSON body back as data, so every "unavailable" branch on the public pages was dead code and one rate-limited request rendered the pool as zero miners, zero blocks, zero payouts and a 0.0 % fee — **FIXED 2026-09-03**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J15-2).**

### J15-3 — [Medium] Every fresh pool publishes the toolkit author's domain, X account and GitHub org as the operator's own identity — 56 static SEO tags plus two JSON-LD blocks, and since §J10-4 blanked `site_url` nothing rewrote any of them — **IDENTITY CLAIMS + RUNTIME HALF FIXED 2026-09-03; the 56 static URLs are OPEN**

**Threat actor: none — this is integrity and attribution, not attack.** It is the §J10-4
family (`seo.site_url` shipped as `https://grinium.com`, Medium, fixed by blanking the
setting) surviving in the half §J10 could not reach: the static HTML.

Measured, exactly: **56 occurrences of `pool.grin.money` across the ten static public pages** —
7 in `account-settings.html`, 10 in `index.html`, 7 each in `donate`/`miners-stats`/
`payment-history`, 6 in `fortune-board`, 4 in `network-map`, 3 each in `blocks`/`blog`, 2 in
`api-docs`. They sit in `<link rel="canonical">`, `<link rel="alternate" hreflang>`,
`og:url`, `og:image`, `twitter:image`, `twitter:domain` and inline JSON-LD.
`page.html`, `post.html` and `login.html` carry none.

**Why it was live.** `applySeo()` rewrites `canonical` and `og:url` — and *only* those two —
from `seo.site_url`, and does nothing at all when that value is empty
(`var siteUrl = seo.site_url || ''` … `if (canonical && !serverSeo)`). §J10-4 blanked the
shipped default for good reasons. The two changes compose into: **on a default install nothing
is rewritten and all 56 stand.**

`index.html` carried worse than URLs — three identity claims the deploying operator cannot make:

```html
<meta name="twitter:site" content="@GriniumPool">
…
"sameAs": [ "https://x.com/griniumpool", "https://github.com/griniumpool" ]
…
"potentialAction": { "@type":"SearchAction", "urlTemplate":"https://pool.grin.money/search?q={search_term_string}" }
```

`sameAs` is the schema.org predicate for *"these accounts are this organisation"*. Every pool
built from this repo asserted ownership of two third-party accounts. The `SearchAction`
declared a sitelinks search box against `/search?q=`, an endpoint no pool has ever served —
structured data claiming a 404.

**Fixed here (small, local, unambiguous):**
- `index.html` — `twitter:site` and both static JSON-LD blocks removed, each replaced by a
  comment saying what stood there and why it went. `branding.js injectStructuredData()` already
  emits an Organization block from the **live** config (real name, real canonical, real logo,
  `sameAs` built from the operator's own social links), gated on `seo.structured_data_enabled` —
  that is the only structured data a deployed pool should publish.
- `branding.js` — `site_url` now falls back to `location.origin`
  ([:238](../../web/07_mining_pool_public/public_html/js/branding.js#L238)), so a pool that
  never fills the setting in still gets a correct self-canonical. The vhost 301s www → apex,
  so a rendering client is on the canonical host by the time this runs.
- `branding.js` — new `reclaimSeoHost()`
  ([:293](../../web/07_mining_pool_public/public_html/js/branding.js#L293)), called last in
  `applySeo` ([:277](../../web/07_mining_pool_public/public_html/js/branding.js#L277)). It
  rewrites **by origin, not by a list of tags to set**: any `canonical` / `og:url` /
  `og:image` / `twitter:image` / `hreflang` naming a host this deployment does not claim is
  repointed onto the effective site URL, and `twitter:domain` (a bare host, invisible to a
  URL loop) is set separately. Rewriting by origin means a page that adds another absolute tag
  is covered without a second edit here. `canonical`/`og:url` are skipped when
  `<meta name="server-seo">` is present, because the server owns them on `page.html`/`post.html`.

**OPEN — the 56 static tags themselves.** `reclaimSeoHost` fixes every client that runs
JavaScript. It fixes nothing for **a crawler that does not**, or for a link unfurler reading
raw HTML — and those are precisely the consumers a canonical tag exists for. The remaining
options, with what each costs:

1. **Make them relative** (`href="/"`, `content="/images/og-image.svg"`). Correct and
   guaranteed for `canonical` and `hreflang`, which resolve against the document. For
   `og:image`/`twitter:image` it relies on the unfurler resolving a relative URL — most do,
   the OG spec says absolute.
2. **Delete the absolute ones and let `branding.js` emit them.** Unambiguously correct for
   every JS client and for every non-JS consumer alike (no tag beats a wrong tag), at the cost
   of an unfurl with no card image on a pool that never sets `og_image_url`.
3. **Leave them and rely on the runtime rewrite.** What is shipping now. Wrong for crawlers.

Recommendation: **(1) for `canonical`/`hreflang`, (2) for `og:image`/`twitter:image`/
`twitter:domain`/`og:url`** — the first two resolve relatively by spec, the rest do not.
Ten files, mechanical, but it changes what an operator's SEO looks like and it is a product
call, not a security patch — plan rule 3. Recorded here rather than applied.

---

### J15-4 — [Low] The one box that gates every money action on the account page is `type="text"`, while the same secret is `type="password"` fifty lines below it — **FIXED 2026-09-03**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J15-4).**

### J15-5 — [Low] `custom_theme` still applied on the credential page — the last operator-authored CSS sink above `branding.js`'s guard — **FIXED 2026-09-03 (closes §J9-3's handoff)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J15-5).**

### J15-6 — [Low] The public page CSP allowlists `cdn.jsdelivr.net`, which no public page loads — an unused third-party script origin in front of the withdrawal form — **FIXED 2026-09-03**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J15-6).**

### J15-7 — [Low] The pending-payout strip has no way to say "stuck": every in-flight label is written for the seconds-long case and §J4-3's stranded row rendered as "almost done" forever — **FIXED 2026-09-03 (answers §J4's handoff)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J15-7).**

### J15-8 — [Low] `/api/pool/effort` publishes `round_window_capped` and the dashboard never read it, so a pool that has not found a block presented a window as a round and printed a luck verdict for it — **FIXED 2026-09-03 (answers §J12's handoff)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J15-8).**

### J15-9 — [Low] The "max" chip rounded to nearest, so it asked for more than the stored balance about half the time — **FIXED 2026-09-03 (closes §J7-3's front-end half)**

**Threat actor: none — a money-UI defect the miner meets.** §J7-3 measured this and handed the
cheap half here with the exact fix.

```js
$id('acct-amt-max').dataset.v = Number(a.balance || 0).toFixed(9)…   // pre-fix
```

Balances are un-quantised `REAL` doubles, so `toFixed(9)` rounds **up** roughly half the time,
and the withdrawal CAS is `balance >= ?` with no tolerance. The chip labelled "your full
balance" produced a refusal over less than one nanogrin — and the alternative §J7-3 named
(leave the field blank) is unreachable from this UI: the help text says *"blank no longer means
full balance — tap the max chip instead"*.

**Fix applied:** `Math.floor(balance * 1e9) / 1e9`
([account-settings.html:986–992](../../web/07_mining_pool_public/public_html/account-settings.html#L986-L992)).
Strands at most one nanogrin and can never overshoot.

**§J7-3 stays OPEN.** This is option (1) of three. It does not help an API caller that sends
its own `toFixed(9)`, and it does not touch the representation. §J7-3's recommendation —
option (2), quantise at credit time — is still the real fix, and §J17 still owes the testnet
confirmation that a real miner can withdraw a full balance in one action.

---

### J15-10 — [Low] The account page sends miners to the toolkit author's server to look up the IP they are about to use as a credential — **REFERRER FIXED 2026-09-03; the link itself is a product decision**

**Threat actor: a third party observing the click.** The help text under the ownership-proof
field reads *"one of the last two IPs your miner submitted shares from (check yours at
tools.grin.money/tools/my-ip)"*
([account-settings.html:433–436](../../web/07_mining_pool_public/public_html/account-settings.html#L433-L436)).

That host belongs to the toolkit author, not to the deploying operator, and it is on every
pool built from this repo. A miner who clicks it hands `tools.grin.money` their IP, the
timestamp, and — via the `Referer` — the pool they are on. The pool's own vhost sets
`Referrer-Policy: strict-origin-when-cross-origin`
([07_grin_mining_public_pool.sh:1264](../../scripts/07_grin_mining_public_pool.sh#L1264)), so
the origin (not the path) crosses. That reconstitutes off-box exactly the *(mining IP, this
pool, this time)* linkage §G1 spent a pass removing from `admin_audit_log`, on the one page
where the visitor is demonstrably a miner of that pool.

It is Low because the address never crosses and the click is voluntary. It is the same family
as §J11-4 (the fixed GA4 property) and §J10-4 (`grinium.com` as `site_url`): a toolkit default
pointing every deployed pool at the author's infrastructure.

**Fix applied:** `rel="noopener noreferrer"` — the pool origin no longer crosses. **The link
itself is left**, deliberately: the miner genuinely needs to know their egress IP, the pool
cannot tell them (the browser's IP is not necessarily the rig's, which is the whole reason the
link exists), and silently removing it would leave the instruction with no way to follow it.
The clean answer is a same-origin echo endpoint or letting the operator set the host — a
product decision, recorded not applied.

---

### J15-11 — [Info] Verified correct, with evidence

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J15-11).**

### J15-12 — [Info] Two smaller notes from the same sweep

1. **The account lookup accepts a spelling the server can never match.** `lookup()` validates
   with `/^t?grin1[a-z0-9]{20,}$/i` — case-**insensitive**
   ([account-settings.html:870](../../web/07_mining_pool_public/public_html/account-settings.html#L870)) —
   and then submits the string verbatim. Grin slatepack addresses are lowercase bech32 and
   SQLite's `=` on `TEXT` is case-sensitive by default, so `GRIN1…` is accepted by the form and
   answered with *"No mining account for this address yet — point a miner at the pool first."*
   That is a confusing message, not a gate bypass: nothing creates a second account, because
   rows are created stratum-side. Left alone here because address canonicalisation is §J3's
   question and the right fix (lowercase before submit) belongs beside whatever §J3 decides.
2. **`login.html` fires an admin dashboard query on every page load.** `checkIfLoggedIn()` hits
   `/api/admin/dashboard` to test for a session. The comment explains why it must be an
   auth-gated route rather than `/api/health`, and that reasoning is right. Worth noting only
   that an anonymous visitor to the login page therefore costs one `secureAdmin` middleware pass
   plus a 401 — priced by the `admin` bucket, which §J12 already read as DoS-padding. Not a
   finding.

---

### Handoffs

- **§J16 (deployment & infra)** — three. (a) J15-6 changed your file: `cdn.jsdelivr.net` is out
  of `$hdr_page`'s `script-src`, with the reasoning in the snippet's own comment. Nothing else
  in the header section moved. (b) Your open question from §J14 is unchanged and this session
  strengthens it: `$hdr_page` still omits `frame-ancestors`, `base-uri`, `form-action` and
  `object-src`, and the public origin is the one that serves the withdrawal form. (c) J15-10's
  residual: `tools.grin.money` is hardcoded into `account-settings.html`. If the deployment side
  ever grows a "your egress IP" echo, that link should point at the pool's own host.
- **§J9 (settings & config integrity)** — J15-1's defence-in-depth half is yours. After the
  escape, `notices.maintenance_message` still has **no validator and no length cap** (it is one
  of the unbounded settings values §J9-8 left OPEN) and `notices` is still not in
  `STEP_UP_SETTINGS_SECTIONS`. The sink is gone; the unbounded operator string is not.
- **§J1 (route & guard matrix)** — one correction to the §J1-1 write-up, not to its fix. Its
  table of operator-HTML sinks was built from the `analytics` and `branding` sections and is
  therefore incomplete: `notices.maintenance_message` was a sixth sink of the same class, in a
  third section, at the same tier. If that table is ever used as the canonical list, add the
  row — the sink is closed, but "which keys reach markup" is a question the matrix should
  answer completely.
- **§J4 (payout execution)** — J15-7 answers your handoff and confirms the worry: the strip now
  shows elapsed time and warns past 30 minutes in an in-flight state. **That is presentation
  only. §J4-3 is still OPEN** and is still the fix — a stranded `tor_sending` row locks the
  balance, disables the withdraw button and cannot be cleared from any UI.
- **§J7 (DB layer & arithmetic)** — J15-9 takes option (1) of §J7-3. **§J7-3 stays OPEN**: the
  chip is fixed, the representation is not, and an API caller sending its own `toFixed(9)` is
  still refused. Option (2) is still the recommendation.
- **§J12 (rate limiting)** — J15-8 answers your handoff (`round_window_capped` is now read and
  said out loud). Separately, J15-2 is a **consequence** of your bucket work that is worth
  recording in §J12's ledger: a 429 from any public bucket used to render as live zeros on the
  three busiest public pages, so a visitor who tripped a limit saw a dead pool. That is fixed
  here, but it means the buckets' user-visible failure mode was, until today, worse than the
  429 itself.
- **§J10 (uploads, CMS & ads)** — one confirmation, no new work. `js/ads.js` inserting
  `html_code` via `innerHTML` and re-creating `<script>` nodes is unchanged and remains the
  §B/§J1-1 accepted position; what this session adds is that `public-shell.js` loads `ads.js` on
  **twelve** pages, not the six that name it in their own markup — and that `login.html` is
  correctly not one of them.
- **§J17 (operational gate)** — three things only a run can settle. (1) **J15-2 is the one to
  stage deliberately**: on a testnet pool, drive `/api/pool/stats` past its bucket from one host
  and confirm the homepage, `miners-stats.html` and `payment-history.html` now say *unavailable*
  rather than *zero*. The pre-fix behaviour was invisible on paper for three audit passes.
  (2) **J15-4's masked proof field needs a real miner to use it once** — the Show/Hide toggle is
  the only new interactive control on the money page. (3) **J15-3's runtime rewrite needs one
  page fetched with JS off and one with JS on**, and the two canonicals compared; the whole
  point of the finding is that they currently disagree.
- **memory `project_pool_frontend_uiux_audit`** — worth adding that `Auth.fetch` is the admin
  panel's helper and `Auth.read` is the public pages', that the difference is what a non-2xx
  returns, and that mixing them renders a rate limit as live data.
- **memory `project_frontend_seo_standards`** — needs J15-3: a deployed pool's static SEO tags
  must not name the toolkit author's domain, X account or GitHub org, and `branding.js` now
  falls back to `location.origin` so a blank `site_url` is no longer a silent no-op.

---

### Verification

- **`npm test` — full suite green.** All eleven test files: `12 + 47 + 32 + 52 + 65 + 25 + 19 +
  21 + 51 + 51 + 39` = **414 passed, 0 failed**, after this session's eleven changed files.
  `check-syntax` reports `Syntax OK — 60 files + 31 inline <script> blocks checked`.
- **The new assertions were proven to FAIL, not just to pass.** Both J15-1 and J15-5 were
  reverted in `branding.js` — the escape removed and the `custom_theme` loop moved back above
  the guard — and `test-branding-sinks.js` produced four failures naming exactly those two
  changes, including `FAIL login: NO custom_theme CSS custom properties` with the leaked
  variable map printed. The file was restored and the suite returned to 25/25.
- **Section [5] carries two controls**, not one: the overlay must actually have rendered
  (`/Back at 14:00/`), and the escaped entity must be **present** (`/&lt;img/`) — so the test
  cannot pass by the message being dropped instead of escaped. Its second assertion was
  deliberately rewritten from `!/onerror=/` to `!/<[a-z][^>]*onerror/` after the first version
  failed on the *escaped* text: the literal string survives as text and must, so matching the
  substring would have made the test passable only by deletion.
- Sections [1] and [2] gained the matching control/negative pair for `custom_theme`, plus a
  positive assertion that `accent_color` still applies, so a future widening of its validator
  has to read the line.
- **J15-2 was demonstrated by running the real `auth.js`**, not by reading it: the file was
  loaded into a `vm` context against a stubbed `fetch` in four modes (429 JSON, 502 HTML,
  network error, 200 OK) and the guard expressions from all three consuming pages replayed on
  the return value. The 200 OK mode is the control and printed real numbers. The first attempt
  at that harness was itself wrong — `const Auth = {…}` in a `vm` script is a lexical binding and
  never becomes a context property, so `ctx.Auth` was `undefined` and every mode "rejected".
  That was caught by printing the rejection reason, and the corrected harness is what the
  finding rests on.
- **The admin-panel dependency on `Auth.fetch`'s current contract was checked before changing
  anything**, which is why `Auth.read` is a new method rather than a change to `Auth.fetch`:
  34 sites in the panel read `body.error` off a non-2xx returned by `API.post`/`API.get`, which
  wrap `Auth.fetch`. Narrowing `Auth.fetch` would have silently regressed §J14-6.
- **The 56 static SEO URLs were counted mechanically** (`grep -o … | wc -l`), per file, not
  estimated; the three identity claims in `index.html` were read in place before removal, and a
  post-edit grep confirms the only surviving mentions are inside the explanatory comments.
- **The escaper audit read all eleven escapers' definitions**, classified each as five-character
  or three-character, and then checked every call site of the two three-character ones for
  attribute context. It is not a grep for the word "escape".
- **`node --check`** clean on `branding.js`, `auth.js`, `reactor-dashboard.js` and
  `test-branding-sinks.js`; the six edited HTML pages are covered by §J14-5's inline-script gate.
  **`bash -n`** clean on `scripts/07_grin_mining_public_pool.sh` after the CSP change.
- Per plan rule 5: nothing ran on a VPS and nothing long-running ran locally. Every command was a
  one-shot that exited; no server was started; the scratchpad harness files were deleted.

### Changed this session

| File | Change |
|---|---|
| [`js/branding.js`](../../web/07_mining_pool_public/public_html/js/branding.js) | J15-1 `maint.message` escaped; J15-5 `custom_theme` loop moved inside `isCredentialPage()`; J15-3 `site_url` falls back to `location.origin` + new `reclaimSeoHost()` |
| [`js/auth.js`](../../web/07_mining_pool_public/public_html/js/auth.js) | J15-2 new `Auth.read()` — 2xx-only parsed body, `null` on every failure; `Auth.fetch` untouched |
| [`js/reactor-dashboard.js`](../../web/07_mining_pool_public/public_html/js/reactor-dashboard.js) | J15-2 all 11 reads → `Auth.read`, `BLOCK/PAYOUT FEED UNAVAILABLE` states + warn lamps; J15-8 `round_window_capped` qualifier |
| [`account-settings.html`](../../web/07_mining_pool_public/public_html/account-settings.html) | J15-4 proof field `type="password"` + Show/Hide toggle + CSS; J15-7 pending-payout age + stuck warning; J15-9 max chip floors to 9 dp; J15-10 `rel="noreferrer"` |
| [`miners-stats.html`](../../web/07_mining_pool_public/public_html/miners-stats.html) | J15-2 all 7 reads → `Auth.read`; the three leaderboard "unavailable" catches made reachable |
| [`payment-history.html`](../../web/07_mining_pool_public/public_html/payment-history.html) | J15-2 all 3 reads → `Auth.read`; transparency tiles no longer render 0 on an outage |
| [`fortune-board.html`](../../web/07_mining_pool_public/public_html/fortune-board.html) | J15-2 a non-2xx now rejects instead of reading as "no draws yet" |
| [`api-docs.html`](../../web/07_mining_pool_public/public_html/api-docs.html) | J15-2 a non-2xx now reaches the existing "temporarily unavailable" catch |
| [`index.html`](../../web/07_mining_pool_public/public_html/index.html) | J15-3 `twitter:site @GriniumPool` and both static JSON-LD blocks removed (third-party `sameAs`, foreign `url`/`logo`, a `SearchAction` against a 404) |
| [`scripts/07_grin_mining_public_pool.sh`](../../scripts/07_grin_mining_public_pool.sh) | J15-6 `cdn.jsdelivr.net` removed from `$hdr_page`'s `script-src` |
| [`back-end-pool/scripts/test-branding-sinks.js`](../../web/07_mining_pool_public/back-end-pool/scripts/test-branding-sinks.js) | +7 assertions: `custom_theme` control + negative + `accent_color` control, and new section [5] pinning J15-1 with two controls; shim now records `style.setProperty` and exposes `bodyHtml` |

**Still open from this session:** the static half of **J15-3** (56 SEO URLs across ten pages —
a product decision, with a recommendation). **J15-10**'s third-party link is left in place by
the same reasoning. Inherited and deliberately not closed: **§J4-3** (J15-7 labels it, does not
fix it), **§J7-3** (J15-9 takes option 1 of three), and **§J9-8**'s missing length cap on
`maintenance_message`.

---

## §J16 — Deployment & infra (2026-09-03, add-ons, NOT VPS-TESTED)

**Scope, as set for §J16 by the run plan (since deleted; see the Status roll-up):** the shell and the nginx
it writes, not the Node app — `scripts/07_grin_mining_public_pool.sh` (3,329 lines),
`scripts/lib/07_lib_hub.sh` (91), `scripts/lib/07_lib_gateway.sh` (537) and
`scripts/lib/07_lib_gwctl.sh` (475, including the 400-line `grin-gateway-ctl` payload it
generates), plus the artefacts they emit: the vhost, the three header snippets, the rate-limit
zone conf, the two systemd units, the fail2ban jail, the logrotate stanza, the cron entries and
every file mode. `07_lib_pool_backup.sh` and `07_lib_pool_wallet.sh` were read for context only
— their content belongs to §J8 and §J4, which already covered it.

> **Plan correction.** The §J16 brief asks about "Central API reachability from satellites: IP
> allowlist + shared secret over the nginx HTTPS vhost." **There is no such surface.** The
> satellite role was removed in the Model C refactor; the only trace left is
> `pool_satellite_installed()` ([:3163](../../scripts/07_grin_mining_public_pool.sh#L3163)), a
> detector kept so `Z) Cleanup` can still find a legacy install. Regional **gateways** forward
> raw stratum over WireGuard and speak no HTTP to the hub at all — §J1 reached the same
> conclusion from the route table. So there is no satellite shared secret whose entropy or
> comparison could be wrong. What replaces that question is J16-2 below, and it is worse.

**Nothing here has run on a VPS, and the two things that would prove most of this section —
`nginx -t` on the generated vhost, and a live response-header read — cannot happen on a Windows
workstation.** What *was* executed: `bash -n` on all six shell files, `bash -n` on the extracted
`grin-gateway-ctl` payload, a one-shot `node` check that `node:sqlite`'s `readOnly` option works
on the pinned v24, a heredoc render of the whole vhost into a scratch file to confirm the shell
expansion produces the config intended (no bare `include ;`, every block's include resolved), and
the repo's `npm test`. No server was started; scratch files were deleted (plan rule 5, CLAUDE.md's
local-process rule).

### Threat actors used in this section

- **Anonymous internet** — reaches `:443`, `:3333` and, on a gateway box, `:3333` there too.
- **Unprivileged local account on the pool box** — including **`grinpool` itself**, which is
  where an RCE in the internet-facing backend lands. The whole point of `pool_deroot()` is that
  this actor is *expected*; anything readable to it is compromised the moment the backend is.
- **A regional gateway operator** — a third party the pool operator paired. New in this
  section, and the actor §J1 explicitly wrote out of the *HTTP* threat model because gateways
  speak no HTTP. They speak stratum, which turns out to be the more valuable channel.
- **On-box root** — Info only, per plan rule 7.

---

### Findings

### J16-1 — [Medium] The first-admin password is passed in **argv**, twice, so the plaintext sits in `/proc/*/cmdline` for the whole registration — readable by exactly the account a backend RCE lands on — **FIXED 2026-09-03**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J16-1).**

### J16-2 — [High] A regional gateway is a plaintext-stratum man-in-the-middle **and** the sole source of the miner IP the pool records — so it holds **both** legs of the ownership proof for every miner in its region, and can retarget their payouts — **OPEN (structural; multi-region only)**

**Threat actor: a regional gateway operator.** Not the pool operator, and not an outsider: the
third party the pool operator deliberately paired and handed a `GRINGW1|…` line to. Under Model C
that is the intended deployment for anyone with more than one region.

Three facts, each individually documented and correct, combine into something no pass has stated:

1. **The gateway forwards stratum in cleartext.** `gw_render_forwarder` writes `mode tcp` with
   `server central ${hub_ep} send-proxy-v2` ([07_lib_gateway.sh:392–420](../../scripts/lib/07_lib_gateway.sh#L392)).
   There is no TLS anywhere on this path — not miner→gateway, not gateway→hub (WireGuard
   encrypts the *tunnel*, and the gateway is one of its two endpoints). The gateway therefore
   reads every `login` frame, which carries the miner's Grin address **and their rig password**.
2. **The gateway chooses the IP the pool records.** Region listeners parse PROXY-protocol v2 and
   take the client address from it. `stratum-server.js`'s own comment says what that value
   becomes: *"session.ip … the ownership gate's IP leg and the network map's country"*
   ([:351–360](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L351)). §J6-3
   removed PROXY parsing from the **public** `:3333` listener precisely because an anonymous
   client asserting its own IP was unacceptable; on a region listener it is asserted by design,
   because that is the feature.
3. **Those two values *are* the ownership proof.** On an accepted share the pool stores exactly
   them: `recordOwnerEvidence(session.grinAddress, session.ip, session.pass, { mayDisplace })`
   ([stratum-server.js:830–832](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L830)).

§J3-1 hardened the destination gate to **AND + AGE** — a payout-destination change needs the
mining-IP leg *and* the rig-password leg, and the proof needs a write-once anchor with age behind
it. That defeats an attacker who has one leg. It does not defeat a party who supplies both, and a
gateway supplies both **for every miner routed through it, continuously, with no attack step at
all** — it need only read what it is already forwarding and write what it is already asserting.
The age requirement is satisfied by the victim's own honest mining.

**What that buys.** `POST /api/account/:addr/nostr-destination` and the withdrawal path are
gated on those two proofs (§J1's route review: *"the one that changes where money goes demands
`requireBothProofs`"*). A hostile gateway can therefore point another miner's payouts at its own
address, from a laptop, with no admin session and nothing the pool logs as anomalous. The pool's
own audit row will show the legitimate mining IP, because the gateway asserted it.

**This is not a bug in a line of code.** It is the trust boundary the Model C edge actually has,
versus the one the design assumes. The design doc's gateway sections describe an edge that is
"thin — no node, no wallet, no keys, no DB" ([07_lib_gateway.sh:4–9](../../scripts/lib/07_lib_gateway.sh#L4)),
which is true about *stored* value and misleading about *authority*: the thin box is the origin
of both authentication facts the money path uses. Grep for "gateway operator", "hostile gateway"
or "compromised gateway" across this entire audit document before this section — it returns
nothing.

**Dispositions, for the operator to choose — none applied here (plan rule 3: structural).**

1. **Trust it, and say so.** Treat a regional gateway as fully trusted, equal to the hub for the
   miners behind it, and pair only boxes you run yourself. This is the honest reading of what is
   built today and costs nothing but documentation — but it must be written into
   `script07_design.md` §13 and into the gateway install screen, because the current copy invites
   the opposite conclusion. It also means the multi-region feature is *not* a partner/franchise
   feature, which is how a pool operator will naturally read "regional gateway".
2. **Stop the gateway being the IP oracle for the proof.** Keep PROXY v2 for the network map and
   the rate limiter, but make the ownership proof's IP leg record the *gateway peer's* tunnel IP
   rather than the asserted client IP, on region listeners only. The proof then says "this miner
   was behind gateway nyc", which is weaker per-miner but is a fact the gateway cannot forge about
   *another* gateway's miners. Cheap; localised to `recordOwnerEvidence`'s call site; and it
   reduces, not eliminates — the gateway still reads the password.
3. **Take the password leg away from the wire.** The rig password is a shared secret sent in
   cleartext on every login; nothing can fix that while stratum is plaintext. A per-account
   *proof token* the miner sets on the account page (never sent over stratum) would replace it as
   the second leg. That is a product change, and it is the only disposition that actually closes
   this.
4. **Interim, and cheap:** the account page already knows when a destination changed. Notify on
   change (the alert rails exist, §J8-3/§J13-5) and make the destination change visible in the
   miner's own payout history, so a retarget is detected rather than prevented.

**Single-box and hub-with-no-gateways pools are unaffected** — the public `:3333` listener does
not parse PROXY at all (§J6-3a), so `session.ip` there is the real socket peer.

---

### J16-3 — [Medium] The gateway's HAProxy — the process terminating anonymous internet TCP on a box that holds a WireGuard key into the pool — ran as **root** for its entire life — **FIXED 2026-09-03**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J16-3).**

### J16-4 — [Medium] The app's admin IP allowlist is bound to a config key **nothing has ever written**, and the panel's allowlist is memory-only — so the gate an operator sets evaporates on the next restart, and setting one entry locks every other admin out until it does — **OPEN**

**Threat actor: the system, plus whoever benefits from a gate silently being off.** This is
§J1's handoff — *"the two-allowlist split (nginx `$admin_rules` from `pool.json:admin_allowlist`
vs the app's runtime `IpFilter`) is a deployment-shaped question"* — answered.

There are **three** admin allowlists, and they do not connect:

| # | Surface | Written by | Read by | State |
|---|---|---|---|---|
| 1 | `pool.json` → `admin_allowlist` | the shell, hand-edit ([:337](../../scripts/07_grin_mining_public_pool.sh#L337), [:1157](../../scripts/07_grin_mining_public_pool.sh#L1157)) | nginx `$admin_rules` on `location /admin/` + `/api/admin/` | **works**, applied only when `4) Setup nginx` is re-run |
| 2 | `config.admin_ip_allowlist` | **nobody** | `new IpFilter({ allowlist: config.admin_ip_allowlist \|\| [] })` ([index.js:747](../../web/07_mining_pool_public/back-end-pool/index.js#L747)) | permanently `[]` on every installed pool |
| 3 | `POST /api/admin/security/ip-allowlist/add` | the panel, `freshAdmin` ([index.js:5301](../../web/07_mining_pool_public/back-end-pool/index.js#L5301)) | the same `IpFilter` | **in-memory only** |

Row 2 is a **name mismatch**: the shell writes `admin_allowlist`, the app reads
`admin_ip_allowlist`. A `grep -rn 'admin_ip_allowlist' scripts/ lib/config.js` returns the reader
and no writer. (Note this is *not* §J1-5, which is about the DB **settings** keys
`access.admin_ip_allowlist` / `admin_ip_blacklist` being dead. Those are a fourth thing. Three
different surfaces now use two spellings of the same idea and none of them reach the one that
works.)

Row 3 is worse than dead, because it half-works:

- `addAllowed()` pushes to `this.allowlist` and re-parses. There is no write to `pool.json`, no
  write to `pool_settings`, no persistence of any kind
  ([ip-filter.js:230–240](../../web/07_mining_pool_public/back-end-pool/lib/ip-filter.js#L230)).
- The middleware's rule is *"if the allowlist is non-empty, deny anything not on it"*
  ([ip-filter.js:51–60](../../web/07_mining_pool_public/back-end-pool/lib/ip-filter.js#L51)) —
  and unlike the nginx rules, which always keep `allow 127.0.0.1; allow ::1;`, there is **no
  implicit localhost entry**. So the first `add` an operator makes flips the app-side gate from
  *off* to *only this one IP*, immediately, for every other admin and for the break-glass
  loopback path.
- On the next `systemctl restart` the list is empty again and the gate is gone. `9) Deploy new
  code` restarts the service as its last step, so an ordinary code update silently disarms it.

The net effect is a control that **reads as configured and is not**. `GET
/api/admin/security/ip-filter-status` returns the live list, so the panel truthfully shows what
is in memory — which is precisely why an operator would believe it survives.

**Not fixed here** — the change lands in `index.js` / `lib/ip-filter.js`, another session's
files, and the choice between the three shapes is a product decision:

1. **Delete rows 2 and 3.** Make nginx's `admin_allowlist` the single admin network gate,
   remove the panel's allowlist UI, and keep `IpFilter` for the blacklist + `tempBan` auto-ban
   it actually does well. Smallest surface, honest, and one place to look. **Recommended.**
2. **Make rows 1 and 3 the same list.** Have the panel write `pool.json:admin_allowlist`, and
   have the app load it into `IpFilter` under that name — one list, defence in depth at both
   layers, but the panel then needs an `nginx -s reload` path it does not have, and an operator
   can lock themselves out at *two* layers with one click.
3. **Persist row 3 only, and always allow loopback.** Keep the panel list app-side, store it in
   `pool_settings`, and hard-code a `127.0.0.1`/`::1` allow the way the nginx rules do so the
   break-glass path and the `_authcheck` subrequest cannot be cut off.

Whichever is chosen, the panel must stop presenting an unpersisted list as a saved setting.

**Cross-check for §J17:** the same three-way split exists for the blacklist
(`config.admin_ip_blacklist`, also never written), so a **permanent** ban an admin adds in the
panel is also lost on restart. Only the automatic `tempBan` — which is in-memory by design and
documented as such — behaves as advertised.

---

### J16-5 — [Low] The vhost is symlinked into `sites-enabled` **before** it is tested, and left enabled when the test fails — so one bad `admin_allowlist` entry takes **every site on the box** down at the next reboot — **FIXED 2026-09-03**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J16-5).**

### J16-6 — [Low] The gateway accepts a `GRINGW1|` pairing string with only its **port** validated, so one field of an out-of-band text line sets the box's `AllowedIPs` — **FIXED 2026-09-03**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J16-6).**

### J16-7 — [Low] A failed `wg genkey` leaves a zero-byte private key that the idempotency check reports as present **forever**, and the operator is told the keypair was generated — **FIXED 2026-09-03**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J16-7).**

### J16-8 — [Low] `_pool_db_scalar` opens the miner database **read-write, as root, on every menu render**, and unlike its sibling never hands the WAL sidecars back — **FIXED 2026-09-03**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J16-8).**

### J16-9 — [Low] The `www` → apex HTTPS redirect is a **server block**, so it inherited nothing — it was the one response on the box with no HSTS, no `nosniff` and no `X-Frame-Options` — **FIXED 2026-09-03**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J16-9).**

### J16-10 — [Low] The pool vhost is the only toolkit vhost with no `server_tokens off`, and every rate-limit rejection answers **503** — the same status as a dead backend — **FIXED 2026-09-03**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J16-10).**

### J16-11 — [Low] The public page CSP carried none of `frame-ancestors` / `base-uri` / `form-action` / `object-src`, on the origin that serves the withdrawal form — **FIXED 2026-09-03 (§J16's call, answering §J14 and §J15)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J16-11).**

### J16-12 — [Info] §J8's handoff item 2 — "add `UMask=0077` to the systemd unit" — must **NOT** be applied: it would 403 every uploaded logo and CMS image

**Threat actor: n/a.** Recorded because a handoff followed without reading is worse than one
refused with a reason, and this one contradicts the reasoning of the finding that issued it.

§J8-1 handed §J16 three shell items. Items 1 and 3 are applied (see J16-8 and *Changed this
session*). **Item 2 is refused.** §J8-1's own analysis explains why, about the Node-side
equivalent:

> *"Deliberately not a process-wide `umask(0o077)`: `fs.writeFileSync`'s `mode` is also masked, so
> a global umask would silently turn asset-manager's explicit `0o644` into `0600` and 403 every
> white-label logo."* — and the same sentence is written into `lib/db.js`'s own comment
> ([:35–37](../../web/07_mining_pool_public/back-end-pool/lib/db.js#L35)).

`UMask=` in a systemd unit sets the umask of the service process. Every `fs.writeFileSync` in
that process inherits it. So `UMask=0077` does *exactly* what §J8-1 correctly refused to do in
JavaScript, only from one directory further out: `asset-manager.js:120` and the CMS media writer
at `index.js:2935` both pass an explicit `{ mode: 0o644 }` **because nginx has to read those
files off disk** through the `/custom/` and `/uploads/` `alias` blocks. Under `UMask=0077` they
land `0600 grinpool:grinpool`, nginx (`www-data`/`nginx`) cannot read them, and every white-label
logo, favicon, OG image and CMS cover image 404s — after an upload that reported success.

**The disclosure the umask was meant to close is already closed** without it: `restrictDbFileModes`
chmods `pool.db`/`-wal`/`-shm` to `0600` on every start (§J8-1's code half), J16-8 stops the menu
creating root-owned sidecars, and the shell half applied here narrows the app directory from
`o+rx` to `o+x` so it is no longer listable. That is the correct set of controls: tighten the
files that must be secret, keep readable the ones that must be public, and never do it with a
blanket that cannot tell the difference.

If a per-directory default is ever wanted, the right tool is a POSIX default ACL on
`custom_assets/` and `uploads/` (`setfacl -d -m o::rx`) alongside a tight `UMask=`, not the umask
alone. Not built; not needed today.

---

### J16-13 — [Info] Verified correct, with evidence

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J16-13).**

### J16-14 — [Info] Confirmed still open in this file, and not re-reported

Three inherited items were re-read this session and remain exactly as the sessions that found
them described. Listed so §J17 does not have to go looking.

1. **§J7-1's weekly `VACUUM` cron** is unchanged at
   [:2128–2131](../../scripts/07_grin_mining_public_pool.sh#L2128):
   `0 3 * * 0 root /usr/bin/sqlite3 $POOL_APP_DIR/pool.db "VACUUM;"`. §J7 handed §J16 "the cron"
   and asked for stop-service-around-it or `auto_vacuum=INCREMENTAL`. **Not changed here**,
   because §J7-1 is explicit that the repair is paired with a `busy_timeout` decision that is an
   operator trade-off, not a patch — a 5 s wait blocks share submission for every connected
   miner, and picking one number for both a money write and a dashboard query is a choice §J7
   deliberately left open. Changing the cron alone would move the problem, not fix it. One rider
   this pass adds: the cron runs as **root** against a `grinpool`-owned WAL database with no
   `chown`/`chmod` afterwards, so it is a third instance of the J16-8 / §J8-1 pattern — whichever
   shape is chosen must include the ownership repair.
2. **`$POOL_LOG`'s logrotate stanza is still a no-op.** The unit has no `StandardOutput=append:`,
   so the service logs to the journal; the only writer of `$POOL_LOG` is the `VACUUM` cron's
   stdout, and `postrotate systemctl kill -s USR2` means nothing to a Node process. §J8-7 spotted
   it. It is harmless (an unrotated file nothing writes) and it is misleading (an operator
   running `L) View logs` sees an almost-empty file and concludes the pool logs nothing). Fixing
   it properly means deciding between journal and file logging, which is a §J17 operations
   question, not a security one.
3. **Node.js is installed by `curl -fsSL https://deb.nodesource.com/setup_24.x | bash -` as
   root** ([:465, :471](../../scripts/07_grin_mining_public_pool.sh#L465)) — §J13's handoff (a).
   §J16's call: **keep it.** It is NodeSource's only documented install path, it is TLS-pinned to
   a vendor the operator is already trusting for the runtime itself, and the alternatives
   (vendoring a keyring + apt source by hand) trade one trust root for the same trust root plus a
   maintenance burden and a staleness failure mode. The version choice (24) is correct against
   `engines` and required by `node:sqlite`. Worth stating so it is a decision on the record
   rather than an unexamined line.

---

### Handoffs

- **§J17 (operational gate)** — six, and four of them are the only way anything in this section
  gets proven. (1) **`nginx -t` on a real box is the first thing to run**, before anything else
  in this section is believed: every header claim, the three snippets, the new `include` in the
  www block, `limit_req_status` and the four new CSP directives are all *rendered* configuration
  that has never been parsed by nginx. Follow it with `curl -sI https://<pool>/`,
  `https://www.<pool>/`, `https://<pool>/admin/` and `https://<pool>/uploads/<a real file>` and
  compare the four header sets — that single sequence settles §I1, §J14-4, J16-9, J16-10 and
  J16-11 at once, and answers §J10's `alias` + `try_files` question in the same breath (request
  one file that exists and one that does not).
  (2) **Start a gateway** and confirm haproxy is running as `haproxy`, not root (`ps -o user= -C
  haproxy`), that the tunnel still comes up, and that `journalctl -u grin-gateway` still receives
  its log lines under the new sandbox — then tighten to `ProtectSystem=strict` +
  `PrivateDevices=yes` (J16-3). (3) **Stat the modes** after a full install:
  `stat -c '%a %U:%G' /opt/grin/pubpool/<net>/pool.db*` → `600 grinpool:grinpool`, and
  `stat -c '%a' /opt/grin /opt/grin/pubpool/<net>` → `701`/`701`, with `705` on `custom_assets/`
  and `uploads/`. `chmod` is a no-op on the dev machine, so no mode asserted here has ever been
  observed (§J8-1's request, now with J16-8's narrowing applied). (4) **Re-run `1) Install` on a
  box that already serves logos** and confirm they still load — that is §J8-7(b)'s regression,
  fixed here by calling `pool_ensure_served_dirs` from both steps. (5) **J16-4:** add an IP in the
  panel's allowlist, restart the service, confirm the list is empty — then decide which of the
  three dispositions to build, *before* an operator relies on it. (6) **J16-2 must be decided
  before any third-party gateway is paired**, not after; if disposition 1 is chosen it is a
  documentation task with a deadline, not a backlog item.
- **§J3 / §J6 (ownership proof, stratum)** — J16-2 is yours to rate as a *proof* question if the
  operator picks disposition 2 or 3. The specific ask: `recordOwnerEvidence` takes `session.ip`
  and `session.pass`
  ([stratum-server.js:830](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L830)),
  and on a region listener both of those are values a paired gateway chose. §J3-1's AND+AGE gate
  is correct and is not weakened by anything in the app — the weakness is that one party supplies
  both inputs. Whether the IP leg should record the *peer's* tunnel IP instead on region
  listeners is a change in your file, not mine.
- **§J1 (route & guard matrix)** — your handoff is answered as J16-4, and the answer changes one
  row's meaning: `POST /api/admin/security/ip-allowlist/add` is `freshAdmin`, which is the right
  tier for a control that locks out other admins — but the control does not persist, so the tier
  is protecting a setting that cannot survive a restart. Worth a note beside it if the matrix is
  ever regenerated. Also: J1-5's dead `access.admin_ip_allowlist` settings keys and J16-4's dead
  `config.admin_ip_allowlist` are **two different keys with nearly the same name**, and closing
  one does not close the other.
- **§J8 (secrets & key management)** — items 1 and 3 of your shell handoff are applied (see
  *Changed this session*); **item 2 is refused with reason as J16-12** — `UMask=0077` would do to
  every uploaded asset exactly what your own analysis refused to do in JavaScript. Also new for
  your inventory: the first-admin **password** was a tenth secret, in argv, missed because the
  inventory was built from files on disk (J16-1). And **J8-4's group tug-of-war
  (`.foreign_api_secret`) is NOT resolved here** — it is a policy choice between one shared group,
  ACLs, or teaching `grin_sync_pool_stratum` to heal only `root:root`, and it changes
  `scripts/lib/grin_node_secrets.sh`, a **shared** lib that Scripts 01/04/06/051/059 all depend
  on. Changing a toolkit-wide secret-permission policy inside a Script 07 audit session is the
  wrong place for it; it needs its own pass with all consumers in scope.
- **§J12 (rate limiting)** — your two vhost items: the SEO `location`s' `X-Forwarded-For` +
  `limit_req` were applied in your own resolution pass and are re-confirmed present here. The
  `/uploads/` and `/custom/` `alias` blocks still carry **no** `limit_req`, and that is left
  deliberate: nginx serves them from disk without reaching the app, so they are not an event-loop
  lever, and a zone there would throttle a page's own images. Your note about `listen 443 ssl
  http2` having no `[::]:443` companion is confirmed and **left exactly as it is** — if IPv6 is
  ever added to this vhost, J12-11's map growth stops being IPv4-bounded and that must be
  re-rated first. One more for you: `= /page.html` is a proxied location with `X-Forwarded-For`
  but **no zone**, so it is covered by the app's per-IP bucket alone. Defensible (it is a real
  page and the app rate-limits it per IP) but it is now the only such block, and it renders CMS
  content from the DB on every hit.
- **memory `project_pool_gateway_model_c`** should gain J16-2 as the headline fact about that
  architecture: the thin edge stores nothing and is trusted for everything, and the "no keys, no
  DB" framing is about stored value, not authority.

---

### Verification

- **`bash -n` clean** on all four scope files plus the two libs read for context, and on the
  `grin-gateway-ctl` payload extracted out of its quoted heredoc (`sed` the `<<'GWCTL'` block to
  a scratch file, `bash -n`, delete) — the generated script is never syntax-checked by anything
  else, because it does not exist until an install runs.
- **The vhost was rendered, not just read.** The `www_https_block` assignment and the main
  heredoc were spliced into a scratch harness with the variables set to representative values,
  expanded by `bash`, and the output inspected. That is what caught J16-9's second half: the
  naive fix expands `$hdr_common` to nothing and emits `include ;`. Reading the source would not
  have shown it, and reading the *generated* config on a box would have shown it as an `nginx -t`
  failure after the fact. All fourteen `include` lines resolve to real paths in the render;
  scratch files deleted.
- **`node:sqlite`'s `readOnly` option confirmed on the pinned runtime** (v24.14.1) with a
  one-shot `node -e` against a scratch database — created, read back read-only, deleted. J16-8's
  fix rests on that option existing, and `engines` pins ≥24 but the toolkit installs whatever
  `setup_24.x` currently ships.
- **`npm test` — full suite green, before and after**: `12 + 47 + 32 + 52 + 65 + 25 + 21 + 51 +
  51 + 41` = **397 passed, 0 failed**. The delta is `test-admin-panel.js` 39 → 41 (J16-11's two
  new assertions). No other suite's count moved, which is the point: this session changed shell
  and nginx, and the one JavaScript file it touched is a test.
- **Nothing ran on a VPS and nothing long-running ran locally.** No server started, no background
  task left, no orphan process (CLAUDE.md's local-process rule). `git status --short` shows only
  the files below plus this document.
- **What is NOT verified, and cannot be from here:** every nginx claim in this section. `nginx -t`
  has never parsed this file, no response header has ever been read off a deployed pool, no
  gateway unit has ever started, and `chmod` is a no-op on the Windows dev machine so no mode
  asserted here has been observed. §J17's first handoff item is that list.

---

### Changed this session

| File | Change |
|---|---|
| [`scripts/07_grin_mining_public_pool.sh`](../../scripts/07_grin_mining_public_pool.sh) | J16-1 admin password off argv on both hops (stdin + `--data-binary @-`); J16-5 vhost enabled only after `nginx -t`, `ln` no longer swallowed, both write paths; J16-8 `_pool_db_scalar` opens `readOnly`, and the region-card helper `chmod 600`s the WAL sidecars beside its existing `chown` (§J8-1 item 3); J16-9 `include $hdr_common` in the www→apex server + the four snippet-path `local`s hoisted above their first use; J16-10 `server_tokens off` + `limit_req_status 429`; J16-11 four directives added to `$hdr_page`; §J8-1 shell half — new `pool_ensure_served_dirs()` narrows `/opt/grin` and the app dir from `o+rx` to `o+x`, keeps `o+rx` on the two served subdirectories, and is called from **both** `pool_install` and `pool_setup_nginx` so a re-run of Install no longer 404s every logo (§J8-7b) |
| [`scripts/lib/07_lib_gateway.sh`](../../scripts/lib/07_lib_gateway.sh) | J16-3 `user`/`group` in the haproxy `global` section (resolved to an account that exists) + eight sandbox directives on the unit; J16-6 per-field validation of the `GRINGW1\|` pairing string; J16-7 `-s` not `-f` on the keypair check, non-empty assertion after `genkey`, the hub's public-half repair branch, and guards on the forwarder write, the wg config write and its `chmod` |
| [`back-end-pool/scripts/test-admin-panel.js`](../../web/07_mining_pool_public/back-end-pool/scripts/test-admin-panel.js) | +2 assertions in §7: `$hdr_page` carries the four directives (J16-11) and a control that it still allowlists the analytics + font origins; the neighbouring assertion's label corrected — it said "the four directives the page CSP omits", which stopped being true in this session |
| [`docs/reference/script07_security_audit.md`](script07_security_audit.md) | this section |

**Left open at the end of this session:** **J16-2** (structural — four dispositions written, the
choice is the operator's, and it must be made before a third-party gateway is paired) and
**J16-4** (three dispositions, and the fix lands in `index.js`/`lib/ip-filter.js`). Inherited and
deliberately not closed here: **§J7-1**'s VACUUM cron (paired with a `busy_timeout` decision that
is §J7's, plus an ownership repair this pass adds to the requirement), **§J8-4**'s
`.foreign_api_secret` group conflict (it changes a shared toolkit lib and needs its own pass),
and **§J8-7**'s inert `$POOL_LOG` rotation. **§J8-1 item 2 is refused, not deferred** — see
J16-12.

---

## §J17 — Pre-mainnet operational gate (2026-09-04, add-ons, NOT VPS-TESTED)

Last session of the pre-mainnet §J pass (see the Status roll-up at the top of this file).
Not a code review of one surface — the **go/no-go**. The plan sets six gate conditions; this
section answers each one with evidence and records what has to change before mainnet.

**The headline: NO-GO, and not because of the arithmetic.** Sixteen sessions closed 150-odd
findings, and that work holds. What this session found is that **four of the six gate conditions
cannot be executed as written** — two of them because a mitigation the plan names does not exist
in the code, and one because a *fix* from an earlier session removed the control the gate assumed.
A gate that cannot be run is worse than a failed gate: it passes by default.

**What was executed here** (plan rule 5 — no VPS, nothing long-running locally): the full
`npm test` suite twice, before and after this session's changes; `node scripts/test-auth-hardening.js`
standalone; a one-shot `node` harness that binds the pool's real `validateUsername` /
`bech32ChecksumValid` and re-encodes one ed25519 key under both HRPs (J17-4, output quoted);
`bash -n` on the touched shell lib. No server started, scratch files deleted.

### Threat actors used in this section

| Label | Means |
|---|---|
| **Anonymous internet** | No credentials. Reaches `:443` and `:3333`. Can watch Certificate Transparency logs, which is free, automated and real-time |
| **Registered miner** | Anonymous plus one accepted share |
| **The operator** | Not an attacker — but the gate exists because an operator following the documented procedure must not be able to lose miners' money. Half this section is operator-safety, and that is the point of a launch gate |
| **On-box root** | Info only, per plan rule 7 |

---

### The gate, condition by condition

| # | Gate condition (plan §J17) | Verdict |
|---|---|---|
| 1 | All P0 sessions closed; every P1 finding fixed or accepted in writing | ❌ **FAIL** — 4 High open in P0 sessions (J4-3, J4-10, J7-1, J16-2). See below |
| 2 | `npm test` green, `test-money-path` extended for J4/J5 | ⚠️ **PASS with a gap** — green (445 assertions), but nothing runs it, and one suite was unreachable → **J17-6** |
| 3 | A launch sequence that closes the first-admin TOCTOU | ❌ **FAIL** — both named mitigations are inert → **J17-1** |
| 4 | Five drills performed and recorded | ❌ **CANNOT RUN AS WRITTEN** — the restore drill is itself a double-pay event (**J17-2**), the orphan drill is unschedulable, and the backup drill names the wrong script → **J17-8** |
| 5 | Mainnet soak with the operator as the only miner | ❌ **NO MECHANISM** — the admission controls were deleted by §J9-1 → **J17-5** |
| 6 | Monitoring live before miners; alert delivery tested and received | ❌ **FAIL** — the pool's top theft alarm delivers once, ever → **J17-3**; and the panel's alert settings reach nothing (§J8-3, open) |

#### Condition 1 in detail — what is actually open in a P0 session

P0 sessions are J1–J8 and J16. Open findings in them, at the start of this session:

| Finding | Sev | Why it blocks | Owner's note |
|---|---|---|---|
| **J4-3** | High | A crash during `tor_sending` strands the row forever and that address can never withdraw again | Money, single-miner |
| **J4-10** | High | `_priorSendLanded` shares J4-1's premise and its fix flips the risk direction | Money, and it is the guard the *retry drill* is supposed to prove |
| **J7-1** | High | No `busy_timeout` + a toolkit-installed weekly `VACUUM` cron; a block found in that window is lost with no alert | Money, silent |
| **J16-2** | High | A hostile regional gateway holds both ownership-proof legs and can retarget payouts | Structural; multi-region only. A **single-box mainnet launch does not touch it** |
| J1-2 | Med | 24 mutating admin routes write no audit row | Forensics, not funds |
| J1-4, J1-5, J1-7 | Low | tier drift; dead settings keys; Express HSTS `includeSubDomains` | |
| J4-5 | Med | Freeze is read once per tick → up to 15 more payouts after an emergency stop | Degrades every drill in condition 4 |
| J4-8, J4-11 | Low | unbounded `nostr_seen_events`; wrong slate attached as proof | Goblin rail is off by default |
| J7-3, J7-7 | Med | un-quantised balances; `SELECT *` over the PPLNS window on the stratum event loop | |
| J8-3, J8-4, J8-5 | Med/Low | inert alerts section; `.foreign_api_secret` group conflict with Script 04; address+IP in the journal | J8-3 also fails condition 6 |
| J16-4 | Med | three disconnected admin allowlists | Compounds **J17-1** |
| §C3 | Low | access token survives logout until expiry (≤1h) | Carried since 2026-07-10 |

**J1-6 and J7-8 are closed** by §J9-5 and are not counted above.

**The shape of it:** three of the four Highs are in the payout path, and the fourth is
multi-region-only. A single-box mainnet launch has **three** High blockers, all of them in §J4
and §J7, and all of them about a payout that is sent, stranded or lost without the ledger
agreeing. None is closed by this session — they are the sessions' own to close.

---

### Findings

### J17-1 — [High] The first-admin registration window is open to the internet, and **both** mitigations the gate plan names for it are inert — one is not wired to the route, the other is contradicted by the installer's own step order — **FIXED 2026-09-04**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J17-1).**

### J17-2 — [High] The backup/restore drill the gate mandates is itself a double-pay event: a restore rewinds the ledger, and the scheduler starts 170 lines before the check that would freeze it — **FIXED 2026-09-04 (freeze-on-restore)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J17-2).**

### J17-3 — [Medium] `wallet_drain` is the only detector in the file with no `resolveAlert`, so the pool's top theft alarm delivers **once for the life of the install** and every later drain is silent — **FIXED 2026-09-04**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J17-3).**

### J17-4 — [Medium] One ed25519 key has **two** accepted spellings — `grin1…` and `tgrin1…` — so the same miner is two accounts with two balances, and a mainnet pool will credit and try to pay a testnet-labelled address — **FIXED 2026-09-04 (see the §J17 resolution pass)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J17-4).**

### J17-5 — [Medium] Gate condition 5 requires *"the operator as the only miner"*, and §J9-1 deleted the only controls that could have delivered it — the stratum login gate checks `is_banned` and nothing else — **OPEN (procedure)**

**Threat actor: anonymous internet — but the finding is that the gate cannot be run, not that
someone attacks it.**

Condition 5: *"start with a low payout threshold and the operator as the only miner … confirm one
real block → maturity → credit → withdrawal → chain-confirmed payout, and reconcile, **before**
any third-party miner is invited."*

There is no product mechanism for "the only miner". §J9-1 removed `pool_visibility`,
`address_whitelist`, `max_miners` and `mining_mode` on 2026-09-02, correctly — they were
validated, audited, step-up gated, rendered in a *"Private (whitelisted only)"* UI, and read by
nothing, which is worse than absent. The removal note is explicit about what remains:

> *"the stratum login gate checks `is_banned` and nothing else, so a pool set to private was
> fully open"* — [pool-settings.js:72–81](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L72)

That is still the state. Public stratum `:3333` accepts any checksum-valid address (and, per
J17-4, either HRP). `is_banned` is reactive — it needs the stranger to have connected first.
Script 07 never touches the firewall for the stratum port: `grep -n "ufw" scripts/07_grin_mining_public_pool.sh`
finds rules only for WireGuard's UDP port and an advisory Cloudflare example for 80/443.

So the soak has to be enforced **at the firewall**, and nothing in the plan, the script or the
docs says so. Required addition to the runbook, before the mainnet soak and removed after it:

```bash
# Soak: stratum reachable only from the operator's own rig(s). Repeat -d per rig IP.
ufw deny  3333/tcp
ufw insert 1 allow from <rig-ip> to any port 3333 proto tcp
# …soak…  then:  ufw delete allow from <rig-ip> to any port 3333 proto tcp
#                ufw delete deny 3333/tcp
```

A pool whose DNS is already published (it must be — certbot, J17-1) is discoverable during the
soak, and a stranger who connects mid-soak does not break anything, but they do invalidate the
drill: the block whose full lifecycle the gate is watching is now split across accounts the
operator does not control, and the reconciliation at the end is no longer a two-party sum.

> The right long-term answer is not to bring `address_whitelist` back — §J9-1 explains why
> ("private" is a product mode, not a login check, and would have to cover the miner list, the
> leaderboards and `/api/pool/miners` too). For a one-off launch soak the firewall is the correct
> instrument and it needs one paragraph of documentation, not a feature.

---

### J17-6 — [Low] Gate condition 2 is `npm test` green, and **nothing runs `npm test`** — no CI, no hook, and the deploy step does not; one suite of 48 assertions covering §J2's P0 fixes was wired to nothing at all — **FIXED 2026-09-04 (the orphan suite)**

> **Closed — full record moved verbatim to [`script07_security_audit_archive.md`](script07_security_audit_archive.md) (J17-6).**

### J17-7 — [Info] The launch runbook, as it must actually be executed

Conditions 1–6 rewritten as an ordered procedure, incorporating everything above. This replaces
the plan's §J17 items 3–6, which cannot be followed as written.

**Phase 0 — before touching a box**
1. Close **J4-3**, **J4-10** and **J7-1**. Three Highs, all in the payout path. J16-2 may be
   deferred *only* for a single-box launch with no paired gateway.
2. Close **J17-4** (§J6 owns it) — before the testnet run, not between testnet and mainnet.
3. Decide **J8-3** / **J13-2**: either wire the alert settings under §J13-2's three conditions,
   or remove the section and document `pool.json` as the only place alerts are configured.
   Shipping a credential field that reaches nothing is the worst of the three options.
4. `npm test` on the exact tree being deployed. 445 assertions, exit 0.

**Phase 1 — testnet install**
5. Guided setup steps 1–4. Note that step 4 publishes the hostname to CT logs — from here the
   host is public knowledge.
6. Steps 5–7. **Registration is now on-box only (J17-1)**, so the step-6→7 window is no longer
   remotely exploitable; run step 7 anyway before doing anything else.
7. Enable mandatory 2FA (`access.require_admin_totp`) and enrol. Verify the break-glass CLI runs
   *first* — §J7-6 fixed it, and a mandatory-2FA pool with no recovery path stops payouts.
8. Set `admin_allowlist` and re-run step 4. Understand what it does and does not cover: `/admin/`
   and `/api/admin/` only.

**Phase 2 — testnet drills** (record each; the first four are condition 4)
9. **Freeze / resume.** admin → Payouts. Confirm the public boolean shows on the miner side.
   Note **J4-5**: up to 15 payouts in the current batch still go out after the freeze.
10. **Forced retry on an already-sent withdrawal.** This is the §H1 drill. **Read J4-10 first** —
    its fix flipped the risk direction, so decide what a "pass" means before you run it.
11. **Orphan → reversal.** *Cannot be scheduled* — an orphan happens when it happens. The logic
    is covered by `test-block-ledger.js` (§J5's suite, 52 assertions incl. reversal and the
    clamp). Treat the live orphan as an observation to record if it occurs during the soak, not
    as a gate you can wait on.
12. **Backup and restore.** **Not 089** — 089 explicitly excludes `pool.db`
    ([089_backup_restore.sh:362–364](../../scripts/089_backup_restore.sh#L362)); the pool ships
    its own encrypted archive on the Script 07 hub. Restore now freezes payouts automatically
    (J17-2) — verify the freeze is set, reconcile, then resume by hand.
13. **Reconciliation clean.** admin → Health. This is also the acceptance check for step 12.
14. Configure an alert channel in `pool.json`, `POST /api/admin/alerts/test`, confirm a human
    receives it. Then confirm a *second* delivery of the same type arrives after the first is
    resolved — that is the J17-3 regression.

**Phase 3 — mainnet soak**
15. Firewall `:3333` to the operator's rigs (**J17-5**), before the mainnet vhost exists.
16. Low `min_withdrawal`. One block, all the way: found → immature → maturity → credit →
    withdrawal → chain-confirmed → reconcile clean.
17. Open the firewall. Watch the first third-party miner's first payout end to end before
    advertising the pool anywhere.

---

### J17-8 — [Info] Three corrections to the plan itself

1. **The backup drill names the wrong script.** Condition 4 says *"DB backup and restore (089)"*.
   Script 089 deliberately does **not** back up `pool.db` — *"NOT 'every product DB': the public
   pool (pool.db) and the Transporter each ship their own encrypted archive through the same
   engine, and are covered there rather than here"*
   ([089_backup_restore.sh:362–364](../../scripts/089_backup_restore.sh#L362)). The pool's backup
   is `scripts/lib/07_lib_pool_backup.sh`, on the Script 07 hub's own menu. An operator who ran
   089 and ticked the box would have backed up the node and not the ledger.
2. **The orphan drill is not schedulable.** Nothing in the product can induce an orphan, and
   there is no admin route to mark a block orphaned (`grep -n "orphan" index.js` returns only
   read paths and status filters). It is an observation, not a step.
3. **The progress tracker was stale.** It showed J1–J11 and J13 as *"not started"* while all
   sixteen sessions are written up in this file with dates. Corrected in this session's edit to
   the plan, along with J17's own row.

---

### Handoffs

| To | Item |
|---|---|
| **§J6** | **J17-4** — pass `config.network` into `validateUsername` and reject the foreign HRP. Decide what happens to existing rows carrying the wrong prefix on an already-deployed pool. Must land before the testnet→mainnet switch |
| **§J4** | **J4-3**, **J4-10**, **J4-5** — the three that make condition 4's drills either unrunnable or unreadable. J4-5 in particular means "freeze" does not mean "stopped" |
| **§J7** | **J7-1** — the `busy_timeout` + `VACUUM` cron pair. §J16 declined to take it because the fix spans a shared toolkit lib |
| **§J8 / §J13** | **J8-3** under **J13-2**'s ruling — condition 6 cannot be signed off while the settings page for alerts reaches nothing |
| **§J16** | **J16-4** compounds **J17-1**: three disconnected admin allowlists, one of which never covered the registration route anyway |
| **Repo / operator** | Nothing runs `npm test` (**J17-6**). A CI workflow is the clean answer; a gate inside `pool_deploy_code` is the pragmatic one |

---

### Verification

Executed this session, on this Windows workstation, no server started (plan rule 5,
CLAUDE.md's local-process rule):

- **`npm test` — twice.** Before this session's edits: 12 scripts, 60 files + 31 inline
  `<script>` blocks syntax-checked, **397 assertions, 0 failed**, exit 0. After: **445
  assertions, 0 failed**, exit 0 (the delta is `test-auth-hardening.js`, now wired in).
- **`node scripts/test-auth-hardening.js` standalone** — 48 passed, 0 failed, exit 0. This is
  how the orphan was confirmed to be a working suite rather than an abandoned draft.
- **The J17-4 harness** — a one-shot script binding the *real* `validateUsername` and
  `bech32ChecksumValid` from `lib/stratum-protocol.js`, generating a random 32-byte key,
  converting to 5-bit words and encoding it under both HRPs with an independently-implemented
  BIP-173 checksum, then feeding both strings back through the pool's validator. Output quoted
  verbatim in J17-4. Deleted after use.
- **`bash -n scripts/lib/07_lib_pool_backup.sh`** — OK, after the freeze-on-restore edit.
- **Static reads**, cited inline: the register route and `isLocalRequest`; the nginx generator's
  three `$admin_rules` / `/api/auth/` locations; `certbot --nginx`; `pool_reset_db`;
  `pool_setup_admin`'s loopback POST; `pool_deploy_code`'s npm branch; `.github/` and
  `.git/hooks`; every `triggerAlert`/`resolveAlert` pair in `alert-monitor.js`;
  `acknowledgeAlert`/`snoozeAlert`; the subsystem start order in `index.js`;
  `schedulerLoop`'s first pass; `validateGrinAddress`'s zero call sites; `isPayoutAddress`;
  `validateConfig`; §J9-1's removal note; `089_backup_restore.sh`'s exclusion comment.

**What is NOT verified, and cannot be from here:** every operational claim about behaviour on a
box. No pool has been installed, no `certbot` has run, no CT-log entry has been observed, no
restore has been performed, no alert has been delivered, no share has reached a stratum port.
**Every finding in this section is a reading of code and procedure, and the gate itself — the
thing §J17 exists to be — has not been run.** That is the honest status: this session says what
the gate must consist of and why four of its six conditions could not have been executed as
written. It does not say the gate passed. It cannot.

---

### Changed this session

| File | Change |
|---|---|
| [`back-end-pool/index.js`](../../web/07_mining_pool_public/back-end-pool/index.js) | **J17-1** — `POST /api/auth/register` gated on `isLocalRequest(req)`, with the reasoning (allowlist coverage, the certbot/CT ordering, the reset-db reopen) recorded at the call site |
| [`back-end-pool/lib/alert-monitor.js`](../../web/07_mining_pool_public/back-end-pool/lib/alert-monitor.js) | **J17-3** — `resolveAlert('wallet_drain')` on the healthy branch, matching the file's other thirteen detectors |
| [`back-end-pool/package.json`](../../web/07_mining_pool_public/back-end-pool/package.json) | **J17-6** — `test-auth-hardening.js` added to `test:unit` (397 → 445 reported assertions) |
| [`public_html/login.html`](../../web/07_mining_pool_public/public_html/login.html) | **J17-1** — the standing *"New admin? Register here"* link replaced with an on-box notice; the form kept (its ids are live in the JS) but unreachable, and marked as such |
| [`scripts/lib/07_lib_pool_backup.sh`](../../scripts/lib/07_lib_pool_backup.sh) | **J17-2** — `pbk_restore` sets `payout_control.frozen = 1` on the restored DB before `pool_deroot`, with a hard-failure branch telling the operator not to start the service, and a new "reconcile before resuming" step in the post-restore checklist |
| `docs/reference/script07_reference_audit_session_plan.md` *(deleted 2026-09-06; tracker folded into the Status roll-up above)* | progress tracker corrected (J1–J11, J13 were shown as not started) and J17's row filled in |
| [`docs/reference/script07_security_audit.md`](script07_security_audit.md) | this section |

**Left open at the end of this session:** **J17-4** (handed to §J6 — small fix, non-local
consequences) and **J17-5** (procedure, not code — the runbook in J17-7 is the deliverable).
**J17-1, -2, -3 and -6 are fixed.** The four P0 Highs inherited from §J4, §J7 and §J16 are not
this session's to close and are the substance of the NO-GO.

### Verdict

**NO-GO for mainnet.** Three High findings sit in the payout path (§J4-3, §J4-10, §J7-1) and one
in the multi-region edge (§J16-2, deferrable for a single-box launch only). Beyond the arithmetic,
four of the six gate conditions could not have been executed as the plan wrote them; three of
those are fixed here and the runbook in J17-7 is what replaces the rest. The gate can be run once
Phase 0 is done. It has not been run.

---

### §J17 — resolution pass, 2026-09-04 (same day, add-ons, NOT VPS-TESTED)

The four gate decisions §J17 put to the operator were answered, and the work below is what those
answers cost. **Ten findings closed across four sessions**, including three of the four High
blockers §J17's verdict named. The suite is now **490 assertions in 13 suites**, exit 0.

**Decisions taken** (operator, 2026-09-04):

| Question | Answer |
|---|---|
| §J4-10's three-state discriminator | **Build it** — and close §J4-3 with it in the same pass |
| §J7-1's `busy_timeout` | **5000 ms, and fix the VACUUM cron too** — the pragma alone does not survive an exclusive lock |
| Launch shape | **Single box, no gateways** — §J16-2 leaves the mainnet blocker set |
| §J8-3's inert alerts section | **Delete it**, per §J13-2's ruling |

---

#### §J4-10 + §J4-3 — the payout guard now has three answers, and the Tor rail has a sweep

Both closed together, because §J4-3's own writeup said its fix was *blocked on* the matcher.

**`_priorSendLanded` returns `{ checked, outcome, tx }`** rather than "did a match exist"
([withdrawal-scheduler.js:432–520](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L432)).
The three outcomes and what each one costs to get wrong:

| outcome | evidence | caller does | wrong guess costs |
|---|---|---|---|
| `confirmed` | `TxSent` **and** `confirmed` | confirm the payout | — |
| `absent` | no match, or `TxSentCancelled` | send | — |
| `unconfirmed` | `TxSent`, not yet confirmed | **defer** | send → §H1 double-pay · confirm → §J4-1 confiscation |
| `checked:false` | wallet unreadable | send, loudly | a pool-wide outage must not strand every payout |

The `unconfirmed` row is the whole point: it is either "locked but never posted" or "posted, not
yet mined", the tx log cannot tell them apart, and §J4-10's objection to simply copying
`reclaimStaleFinalizing`'s `confirmed` check was that it would flip the risk rather than remove
it. Parking costs a delay. Guessing costs money in one direction or the other.

One subtlety the amount branch needed: it can legitimately return several candidates (same miner,
same net, two attempts), so it prefers a **confirmed** match over an unconfirmed sibling —
otherwise a provably-settled payout could be parked because an unconfirmed twin sorted first.

**`_deferSend()`** ([:558–612](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L558))
returns the row to `retry_scheduled` with a fresh `next_retry_at` and **does not increment
`retry_count`**. That is not tidiness. `scheduleRetry` consumes a rung, and an exhausted ladder
calls `markFailed` → `_reverseLock` → the balance is **refunded**. For an ambiguous row that turns
out to have been broadcast, refunding is precisely the double-pay this guard exists to prevent,
arriving four deferrals later through a different door. A deferral is not a failed attempt.
`SEND_DEFER_S` is 900 s (a broadcast Grin tx mines in minutes; the retry ladder's first rung is
6 h), and after `MAX_SEND_DEFERRALS` = 8 the row keeps parking but stops being quiet about it.

**`reclaimStaleTorSending()`** ([:1665–1755](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L1665))
is the sweep §J4-3 found missing, wired into `schedulerLoop` beside `reclaimStaleFinalizing`
([:108–111](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L108)). It
resolves an abandoned `tor_sending` row through the same three-way answer: confirmed → confirm;
absent → back onto the retry ladder (via `scheduleRetry`, so the freeze check and the attempt
count still apply — the sweep never sends from inside itself); unconfirmed or unreadable → leave
it and re-ask. It ages the **claim**, not the row, for the reason `reclaimStaleFinalizing`
documents, and its threshold is derived per-instance from the configured send timeout
(`max(600, wallet_send_timeout_ms/1000 × 2 + 120)`) so raising that timeout cannot make the sweep
race a send that is still legitimately running. Freeze-safe, and it runs while frozen.

#### §J4-11 — the proof capture uses the guard's rules

[`_captureTorSlateId`](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js#L761)
matched `/Sent/` (which also matches `TxSentCancelled`), `>= wantNano` rather than the exact net,
no time bound, newest-by-id. It now applies exactly the guard's four rules — `TxSent` only, not a
slate already claimed by another withdrawal, created no earlier than the row (with §J4-4's clock
slack, and a missing timestamp failing the test rather than passing it), and the exact net within
1 µGRIN. Regression-tested with the log that produced the observed bug.

#### §J7-1 — all three parts

1. **`busy_timeout = 5000`** in `initDb`
   ([db.js:15–33](../../web/07_mining_pool_public/back-end-pool/lib/db.js#L15)), with the trade
   written down at the call site: `DatabaseSync` is synchronous and the stratum server shares the
   loop, so the wait blocks share submission for everyone rather than failing one write. Right for
   a money write, tolerable for a dashboard query.
2. **`creditBlock`'s failure is now loud**
   ([stratum-server.js:836–872](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L836)).
   It never threw — it caught internally and returned `{success:false}` — so the surrounding
   `try/catch` never fired and the return value was discarded. `handleSubmit` now reads it, logs
   `[CRITICAL]` with every field needed to re-enter the block by hand, and pushes a new
   `block_record_failed` alert. That alert type has **no** `resolveAlert` on purpose: unlike every
   detector in `alert-monitor.js` it is an EVENT, not a condition, and no later observation can
   say the lost block is fine now. The push needed a back-reference, wired in AlertMonitor's
   constructor ([alert-monitor.js:23–29](../../web/07_mining_pool_public/back-end-pool/lib/alert-monitor.js#L23))
   because `index.js` builds the stratum server ~270 lines before the monitor exists.
3. **The VACUUM cron is offline now.** It was
   `sqlite3 pool.db "VACUUM;"` against the **live** database, weekly, as root — an exclusive lock
   for minutes, which no `busy_timeout` survives, and pointed at a binary this toolkit never
   installs (the app uses `node:sqlite`), so the maintenance it promised had very likely never
   run at all. Replaced by a generated `/usr/local/bin/<service>-vacuum`
   ([07_grin_mining_public_pool.sh:2198–2262](../../scripts/07_grin_mining_public_pool.sh#L2198))
   that stops the service, vacuums via `node:sqlite`, and restarts **in a trap** so a failed
   vacuum can never leave the pool down until someone notices on Monday. It chowns `pool.db` and
   its WAL sidecars back to `grinpool` afterwards — §J16-8's trap, in the other direction. The
   menu now states plainly that the pool is stopped for the duration.

#### §J8-3 — the alerts settings section is gone

Nine keys deleted from `PoolSettings.defaults`, its one validator removed, `settings-alerts.html`
deleted, and the row taken out of the admin nav and the legacy deep-link table. The note left in
its place ([pool-settings.js:303–319](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js#L303))
records why deletion rather than wiring: §J13-2's ruling is that `postWebhook()` is an
unrestricted outbound-request primitive, so making those keys live would turn a `secureAdmin`
settings write into a durable, restart-surviving beacon.

Worth recording, because it makes the "inert" verdict sharper than §J8-3 stated: the section's
`alert_thresholds` was a JSON **string** carrying four keys, while `AlertMonitor` reads
`config.alert_thresholds` as an **object** with eleven — including all seven money thresholds. So
even had it been wired, it described a schema that no longer existed.

One test moved with it. `test-admin-guards.js`'s §J1-2 case used the `alerts` section because it
held credentials; it now uses `analytics`, and the assertion says what the audit writer actually
implements — *no settings VALUE ever reaches `admin_audit_log`* — rather than the narrower claim
about credentials. The rule's comment in `pool-settings.js` was updated for the same reason: it
justified itself by naming three keys that no longer exist, and a rule that reads as a reaction to
one section is one the next secret-shaped key has to remember to opt into.

#### §J17-4 — one key, one spelling

`validateUsername(username, network)`
([stratum-protocol.js:112–147](../../web/07_mining_pool_public/back-end-pool/lib/stratum-protocol.js#L112))
now rejects the foreign HRP, and stratum login — the only path that creates a `miner_accounts`
row — passes the pool's network
([stratum-server.js:557–566](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L557)),
with a refusal message that names the prefix the pool actually wants. The parameter is optional
so the BIP-173 vector tests can still exercise the encoding alone.

§J17 deferred this to §J6 on the grounds that it "changes who can log in to an already-deployed
pool". **That reasoning was wrong and is withdrawn**: no pool has ever been deployed, so there are
no rows carrying the wrong prefix and nothing to migrate. The fix is one parameter today and a
data-migration problem the day after launch.

#### §J9-6 — the config integrity check now detects instead of reassuring

Three of its five defects, together, because fixing the first alone makes the third worse
([index.js:459–512](../../web/07_mining_pool_public/back-end-pool/index.js#L459)):

- the baseline is **no longer overwritten on a mismatch** — the warning stands on every restart
  until a human replaces the file, and the observed hash goes to `.sha256.new` beside it;
- it hashes the **raw file bytes**, not the merged config object, so a systemd `PORT`/`HOST` edit
  or a toolkit upgrade that adds a default key no longer trips it. That mattered more than it
  looks: keeping the warning forever (above) while it still cried wolf on routine maintenance
  would have made it *less* useful, not more;
- the baseline now lives **beside the config it describes** rather than in the app directory, so
  a redeploy no longer drops it and turns the check into a silent no-op.

It also raises a `config_tampered` alerts row now, which is why the check moved to just after
`initDb` — `AlertMonitor` does not exist that early in startup. Still deliberately **not**
covered: `pool_config`, where the runtime money values live; §J1-2's audit row is the control for
those, as §J9-6 said.

#### §J1-4 and §J1-7 — two one-line tier/header alignments

- `POST /api/admin/security/rate-limit-reset` is `freshAdmin`
  ([index.js:5300–5322](../../web/07_mining_pool_public/back-end-pool/index.js#L5300)), matching
  its two functional siblings, and writes the audit row §J1-2 wanted. Three routes meaning "stop
  throttling this IP" now share one tier — the previous split was the way to clear a login
  lockout and then grind toward `freshAdmin` without passing through it.
- Express's HSTS drops `includeSubDomains`
  ([index.js:270–276](../../web/07_mining_pool_public/back-end-pool/index.js#L270)), matching the
  nginx snippet §I fixed. nginx does not strip upstream headers, so proxied responses carried
  both and RFC 6797 §8.1 makes the UA honour the first — Express's.

#### §J13-10 / §J13-4 — the NIP-05 fetch aborts and is capped

`withTimeout` only ever stopped **us waiting**; the request kept running. nostr-tools' `nip05` has
no signal parameter, but it does expose `useFetchImplementation`, which is the only seam there is
— so the bridge installs a wrapper carrying `AbortSignal.timeout(NIP05_TIMEOUT_MS)` and a 64 KB
body cap read through `_readCapped`
([nostr-payout.js:295–360](../../web/07_mining_pool_public/back-end-pool/lib/nostr-payout.js#L295)).
The cap is enforced by streaming and cancelling, not by reading and then checking, because
`timeout` on a socket is an **inactivity** timer and a slow trickle resets it indefinitely — the
same shape §J13-3 fixed on the two raw-`https` consumers. The domain is allowlist-checked before
this point, so this is a resource bound, not an SSRF control.

#### §J4-8 — the Nostr dedup table is pruned

`nostr_seen_events` is now swept on the ordinary retention pass at 24 h
([retention.js:133–150](../../web/07_mining_pool_public/back-end-pool/lib/retention.js#L133)),
comfortably past both windows that give an id meaning (`LOOKBACK_SECS`, `nostr_pending_ttl_minutes`),
with `idx_nostr_seen_at` added by the bridge so that DELETE does not scan the table it exists to
bound. Wrapped in a try/catch rather than a `CREATE TABLE`: retention must not conjure a table for
a feature that is switched off. The write-before-decrypt ordering is left alone — §J4-8 agreed it
is correct on its own terms (dedup ahead of an expensive `nip44` decrypt), and retention was
always the right fix.

#### §J8-5 — the journal no longer pairs an address with a mining IP

§J8-5 offered three options and left the choice to the operator. **Option 2** is taken — mask the
address, keep the IP whole — on both lines
([stratum-server.js:633–645](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L633),
[:955](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js#L955)), reusing
`maskAddress` from `dormancy.js` so the journal redacts the same way the public feeds do rather
than growing a second, divergent shape.

Option 1 (coarsen the IP, matching §G1) was the one §J17 first said it would take. On reading
§J8-5 in full it is the worse trade: the full IP is how an operator identifies and `ufw deny`s an
abusive rig, there is no second copy of it — nginx never sees stratum — and coarsening removes
that capability with no replacement. The defect is the *pairing*, and masking the address breaks
the pairing while leaving the ban workflow intact. Flip it if you disagree; it is two call sites.

> **§G / memory `project_pool_ip_privacy` still needs the journal added as a fourth named sink**,
> so the next reader of *"exactly three IP-bearing columns"* does not conclude the sweep was
> complete. Not done here — it is a memory edit, not a code change.

---

### Tests added this pass

`npm test` is **490 assertions across 13 suites**, exit 0, run after every change above.

**`scripts/test-payout-guard.js` is new — 38 assertions**, and it exists because §J17 found that
§J4 verified all of this with scratchpad harnesses that were never committed. It runs the **real**
`WithdrawalScheduler` against a throwaway SQLite file, stubbing only the process boundaries
(Owner-API wallet, the `grin-wallet` CLI, the Tor probe). Four sections: the matcher's three
outcomes on both branches; `sendWithdrawal`'s confirm / defer / send behaviour with the money
asserted, not just the status; `reclaimStaleTorSending`'s four branches plus the premise that no
other recovery pass touches a `tor_sending` row; and §J4-11's capture rules.

Two of its assertions are worth naming because they guard reasoning rather than a line of code:

- *"the deferral does NOT consume a retry rung"* — the refund-by-the-back-door path above.
- *"a first attempt sends without consulting the wallet log **first**"* — §J4-2's regression.
  This asserts on **order**, not on a call count. `sendWithdrawal` also reads the tx log *after* a
  successful send for `_captureTorSlateId`'s proof link, so a bare counter reports "consulted" on
  the clean path too and proves nothing. It was written as a counter first, and failed, which is
  how the distinction was found.

`test-stratum-guards.js` gains **7 assertions** for §J17-4, including the demonstration that the
two spellings are one key with two independently valid checksums — bech32 computes the checksum
over the HRP, so neither is a corruption of the other, which is why §J6-6's fix could not catch
this — and a control that both are still accepted when no network is supplied.

`test-admin-guards.js`'s §J1-2 case was re-pointed off the deleted `alerts` section.

---

### Status after this pass

| Finding | Was | Now |
|---|---|---|
| §J4-3 | High, OPEN | **FIXED** |
| §J4-8 | Low, OPEN | **FIXED** |
| §J4-10 | High, OPEN | **FIXED** |
| §J4-11 | Low, OPEN | **FIXED** |
| §J7-1 | High, OPEN | **FIXED** (all three parts) |
| §J8-3 | Medium, OPEN | **FIXED by deletion** |
| §J8-5 | Low, OPEN | **FIXED** (option 2) |
| §J9-6 | Low, OPEN | **FIXED** (defects 1, 3, 5) |
| §J1-4 | Low, OPEN | **FIXED** |
| §J1-7 | Low, RE-OPENED | **FIXED** |
| §J13-10 + §J13-4's lifetime half | Low/Medium, OPEN | **FIXED** |
| §J17-4 | Medium, OPEN | **FIXED** |

**The gate, re-scored.** Condition 1 has no High findings left for a single-box launch: §J4-3,
§J4-10 and §J7-1 are closed, and §J16-2 is out of scope for a pool with no paired gateway (it
stays OPEN and must be settled before the first one is). Condition 2 is met and now has the
payout path covered. Condition 3 is closed by §J17-1. Condition 6's code half is closed by §J17-3
and §J8-3; what remains is the operator configuring a channel in `pool.json` and confirming a
human receives a test alert.

**Still open, and unchanged by this pass:** §J1-2 (24 routes with no audit row — one more closed
here, 23 left), §J1-5, §J4-5, §J7-3, §J7-7, §J8-4, §J9-8, §J10-2, §J10-3, §J13-2's standing
ruling, §J13-5, §J13-7's live-revocation half, §J15-3's 56 static URLs, §J16-2, §J16-4, §J17-5
and §C3. None is a High, and none blocks a single-box mainnet start on its own — but **§J4-5**
deserves a second look before the freeze drill, because "freeze" still does not mean "stopped"
until the current batch drains.

**The verdict does not change on code alone.** §J17's NO-GO rested on two things: open Highs, and
four gate conditions that could not be executed. The Highs are closed and three of the four
conditions are now executable. What is left is the part no desk audit can do — Phase 1 through 3
of the runbook in §J17-7, on a real box, starting with testnet. **Nothing in this pass has run on
a VPS.**

---

### Changed this session (resolution pass)

| File | Change |
|---|---|
| [`back-end-pool/lib/withdrawal-scheduler.js`](../../web/07_mining_pool_public/back-end-pool/lib/withdrawal-scheduler.js) | §J4-10 three-state `_priorSendLanded` + the defer branch in `sendWithdrawal`; §J4-3 `_deferSend()` and `reclaimStaleTorSending()`, wired into `schedulerLoop`; `SEND_DEFER_S` / `MAX_SEND_DEFERRALS` / `torSendingStaleSeconds`; §J4-11 `_captureTorSlateId` re-uses the guard's four rules |
| [`back-end-pool/lib/db.js`](../../web/07_mining_pool_public/back-end-pool/lib/db.js) | §J7-1 `busy_timeout = 5000`, with the stratum-loop trade documented |
| [`back-end-pool/lib/stratum-server.js`](../../web/07_mining_pool_public/back-end-pool/lib/stratum-server.js) | §J7-1 `creditBlock`'s result is read → `[CRITICAL]` + `block_record_failed` alert; §J17-4 login passes the network; §J8-5 both journal lines mask the address |
| [`back-end-pool/lib/stratum-protocol.js`](../../web/07_mining_pool_public/back-end-pool/lib/stratum-protocol.js) | §J17-4 `validateUsername(username, network)` rejects the foreign HRP |
| [`back-end-pool/lib/alert-monitor.js`](../../web/07_mining_pool_public/back-end-pool/lib/alert-monitor.js) | §J17-3 `resolveAlert('wallet_drain')`; §J7-1 `block_record_failed` type + the stratum back-reference |
| [`back-end-pool/lib/pool-settings.js`](../../web/07_mining_pool_public/back-end-pool/lib/pool-settings.js) | §J8-3 the `alerts` section and its validator deleted, with the reasoning left in place; the audit-writer's NAMES-ONLY comment rewritten so it no longer justifies itself by naming deleted keys |
| [`back-end-pool/lib/retention.js`](../../web/07_mining_pool_public/back-end-pool/lib/retention.js) | §J4-8 `nostr_seen_events` pruned at 24 h |
| [`back-end-pool/lib/nostr-payout.js`](../../web/07_mining_pool_public/back-end-pool/lib/nostr-payout.js) | §J13-10 NIP-05 fetch gets an `AbortSignal` + a streamed 64 KB body cap (`_readCapped`); §J4-8 `idx_nostr_seen_at` |
| [`back-end-pool/index.js`](../../web/07_mining_pool_public/back-end-pool/index.js) | §J1-4 route to `freshAdmin` + audit row; §J1-7 HSTS aligned; §J9-6 integrity check rewritten and moved after `initDb`, `hashConfig` now takes bytes |
| [`back-end-pool/admin-panel/`](../../web/07_mining_pool_public/back-end-pool/admin-panel/) | §J8-3 `settings-alerts.html` deleted; nav row removed from `admin-shell.js`; `'alerts'` removed from `settings.html`'s deep-link table |
| [`back-end-pool/scripts/test-payout-guard.js`](../../web/07_mining_pool_public/back-end-pool/scripts/test-payout-guard.js) | **new** — 38 assertions over §H1 / §J4-1 / §J4-2 / §J4-3 / §J4-10 / §J4-11 |
| [`back-end-pool/scripts/test-stratum-guards.js`](../../web/07_mining_pool_public/back-end-pool/scripts/test-stratum-guards.js) | +7 assertions for §J17-4 |
| [`back-end-pool/scripts/test-admin-guards.js`](../../web/07_mining_pool_public/back-end-pool/scripts/test-admin-guards.js) | §J1-2 case re-pointed off the deleted `alerts` section |
| [`back-end-pool/package.json`](../../web/07_mining_pool_public/back-end-pool/package.json) | `test-payout-guard.js` added to `test:unit` (with `test-auth-hardening.js` from the main pass) |
| [`scripts/07_grin_mining_public_pool.sh`](../../scripts/07_grin_mining_public_pool.sh) | §J7-1 `pool_write_vacuum_script()` + the cron now calls it instead of vacuuming the live DB |

### Verification

- **`npm test` — 490 assertions, 0 failed, exit 0**, run after each change and once at the end.
- **`node scripts/test-payout-guard.js`** — 38/38 standalone.
- **`bash -n`** on both touched shell files; and the generated vacuum script **rendered** from its
  heredoc into a scratch file with real values and `bash -n`'d — the expansion is checked, not
  assumed.
- **The `node:sqlite` VACUUM the cron runs was executed one-shot** against a throwaway 4.3 MB
  database: 4,333,568 → 8,192 bytes. `sqlite3` is not installed by this toolkit, so this is the
  path that has to work.
- **`_readCapped` exercised one-shot** on both branches (under cap returns the body; over cap
  cancels the reader and throws).
- `node --check` on every edited module. Scratch files deleted; no process left running.

**What is still NOT verified:** everything about behaviour on a box. No pool installed, no
service stopped or restarted by the vacuum script, no `chown` observed (`chmod`/`chown` are no-ops
on the Windows dev machine), no alert delivered, no stratum login refused for a wrong-network
address, no payout deferred by a real wallet. The three-state guard and the sweep are tested
against a **stubbed** Owner API — the field they turn on, `confirmed`, is the same one
`reclaimStaleFinalizing` and `lib/reconciliation.js:278` already read, but no live grin-wallet has
ever answered any of them. That is Phase 1 of the runbook, and it has not happened.
